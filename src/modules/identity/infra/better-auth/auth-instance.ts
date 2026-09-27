import { kyselyAdapter } from '@better-auth/kysely-adapter';
import type { Logger } from '@nestjs/common';
import {
  betterAuth,
  type BetterAuthOptions,
  type GenericEndpointContext,
} from 'better-auth';
import { isAPIError } from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import type { FieldCipher } from '../../../../core/security/index.js';
import type { AuthEmails } from '../../application/auth-emails.js';
import type {
  IdentityConfig,
  IdentityGuardConfig,
} from '../../identity.config.js';
import type { IdentityDirectory } from '../../ports/identity-directory.js';
import { withAccountCipher } from './account-cipher.adapter.js';
import {
  createAuthHooks,
  createImplicitLinkGuard,
  createSessionFence,
  sanitizeDisplayName,
  type HookSession,
} from './auth-hooks.js';
import { buildAuthOptions } from './auth-options.js';
import type { AuthRequestState } from './auth-request-state.js';
import { normalizeEmail } from './email-normalize.js';
import type { LoginLockout } from './login-lockout.js';
import { UnverifiedLinkRevoker } from './unverified-links.js';

export const BETTER_AUTH = Symbol('identity.betterAuth');
const EMAIL_LIKE = /[^\s@<>"']+@[^\s@<>"']+/g;
const SOURCE = 'better-auth';
const VERIFY_EMAIL = '/verify-email';
/** `logger.error("Failed to create user", e)` của `api/routes/sign-up.mjs` (1.7.6). */
const BETTER_AUTH_CREATE_USER_FAILED = 'Failed to create user';
/** Message của Better Auth có thể chứa email: thay trước khi log (spec §5.14). */
export const maskEmails = (message: string): string =>
  message.replace(EMAIL_LIKE, '[email]');

export type AuthInstanceDeps = {
  identity: IdentityConfig;
  guard: IdentityGuardConfig;
  app: { serviceName: string };
  corsOrigins: readonly string[];
  pool: pg.Pool;
  cipher: FieldCipher;
  lockout: LoginLockout;
  emails: AuthEmails;
  directory: IdentityDirectory;
  state: AuthRequestState;
  onUserCreated(userId: string): Promise<void>;
  /**
   * `UnitOfWork.inTransaction()` của app (Task 32 carry-forward). `uow.run` tham gia transaction đang mở, nên nếu
   * `onUserCreated` chạy bên trong một transaction của app thì marker có thể commit trước khi event được ghi.
   */
  inAppTransaction(): boolean;
  requestId(): string;
  problemTypeBase: string;
  logger: Logger;
};

const bodyCode = (body: unknown): string | undefined =>
  typeof body === 'object' &&
  body !== null &&
  'code' in body &&
  typeof body.code === 'string'
    ? body.code
    : undefined;

export function createAuthInstance(d: AuthInstanceDeps) {
  const db = new Kysely({
    dialect: new PostgresDialect({ pool: d.pool }),
    plugins: [new CamelCasePlugin()],
  });
  const reclaimer = new UnverifiedLinkRevoker(d.pool);
  // Gán sau khi instance được dựng (hook cần `auth.api.getSession`, còn instance cần hook). Hook chỉ chạy khi có
  // request, tức là sau khi hàm này đã trả về.
  // Cũng gán sau: đọc account credential qua `internalAdapter` của instance (theo transaction hiện tại, N1).
  let findCredentialAccount: ((userId: string) => Promise<unknown>) | undefined;
  let readSession:
    ((headers: Headers) => Promise<HookSession | null>) | undefined;
  const hooks = createAuthHooks({
    freshAgeSec: d.identity.sessionFreshAgeSec,
    unavailableRetryAfterSec: d.guard.unavailableRetryAfterSec,
    twoFactorLockoutSec: d.guard.lockoutBlockSec,
    lockout: d.lockout,
    state: d.state,
    emails: d.emails,
    directory: d.directory,
    session: (headers) => {
      if (!readSession)
        throw new Error('Better Auth instance is not built yet');
      return readSession(headers);
    },
    reclaim: (userId, trigger) => reclaimer.revoke(userId, trigger),
    requestId: () => d.requestId(),
    problemTypeBase: d.problemTypeBase,
    logger: d.logger,
  });
  /**
   * S2-R40 trên link xác thực (cả nhánh thường lẫn nhánh `change-email-verification`, review I2): chạy trong
   * `user.update.before` của `/verify-email`, tức là SAU khi Better Auth đã kiểm token và NGAY TRƯỚC khi ghi
   * `emailVerified = true` (`api/routes/email-verification.mjs`: nhánh thường gọi `updateUserByEmail(email,
   * { emailVerified: true })`, nhánh đổi email gọi `updateUserByEmail(email, { email: updateTo, emailVerified: true })`
   * mà KHÔNG gọi `beforeEmailVerification`). Lỗi ném lên làm xác thực thất bại (fail closed); link dùng lại được vì
   * token là JWT không trạng thái. User chưa xác thực là điều kiện NẰM TRONG câu lệnh reclaim.
   */
  const reclaimOnVerification = async (ctx: GenericEndpointContext) => {
    const token = typeof ctx.query?.token === 'string' ? ctx.query.token : '';
    const payload = await verifyJWT(token, ctx.context.secret);
    const email =
      typeof payload?.email === 'string' ? payload.email : undefined;
    if (!email)
      throw new Error(
        'verify-email reached the user update without a verifiable token',
      );
    const user = await d.directory.findUserByEmail(normalizeEmail(email));
    if (!user)
      throw new Error('verify-email reached the user update without a user');
    await reclaimer.revoke(
      user.id,
      typeof payload?.updateTo === 'string'
        ? 'change-email-verification'
        : 'email-verification',
    );
  };
  const base = buildAuthOptions({
    identity: d.identity,
    guard: d.guard,
    app: d.app,
    corsOrigins: d.corsOrigins,
    database: (opts) =>
      withAccountCipher(
        kyselyAdapter(db, { type: 'postgres', transaction: true })(opts),
        d.cipher,
      ),
    hooks,
    emails: d.emails,
    // Chạy sau commit của auth (`queueAfterTransactionHook`, Task 33). Trong transaction của app thì hoãn cho cron
    // `identity.reconcile-registered` (spec §5.10: lỗi ở hook → log, cron bù), không ghi event lồng vào đó.
    onUserCreated: async (userId) => {
      if (d.inAppTransaction()) {
        d.logger.error(
          { event: 'registered_event_deferred_open_transaction', userId },
          'user created inside an open app transaction; identity.user.registered deferred to the reconcile cron',
        );
        return;
      }
      await d.onUserCreated(userId);
    },
    // Chỉ quan sát (A.5): log mã lỗi/lớp lỗi, không bao giờ message/body (spec §5.14). Map lỗi ở Task 36.
    onApiError: (err) => {
      if (isAPIError(err))
        d.logger.warn({
          source: SOURCE,
          event: 'better_auth_api_error',
          status: err.statusCode,
          code: bodyCode(err.body),
        });
      else
        d.logger.error({
          source: SOURCE,
          event: 'better_auth_unhandled_error',
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        });
    },
    log: (level, message) => {
      const entry = { source: SOURCE, level, message: maskEmails(message) };
      // M4: dòng này của Better Auth có cả ở race đăng ký song song (dự kiến) lẫn lỗi DB thật; hook `after` của
      // `/sign-up/email` phân biệt hai trường hợp (`signup_duplicate_race` info / `signup_create_failed` ERROR).
      if (message === BETTER_AUTH_CREATE_USER_FAILED)
        d.logger.warn({ ...entry, event: 'better_auth_create_user_failed' });
      else if (level === 'error') d.logger.error(entry);
      else d.logger.warn(entry);
    },
  });
  // M3: GHÉP vào hook mà `buildAuthOptions` đã đặt, không dựng lại. Chỗ mình thêm mà Task 33 cũng đặt thì dừng to
  // (cần ghép tường minh), không ghi đè im lặng.
  const baseDbHooks: NonNullable<BetterAuthOptions['databaseHooks']> =
    base.databaseHooks;
  if (
    baseDbHooks.user?.create?.before ||
    baseDbHooks.user?.update?.before ||
    baseDbHooks.session?.create?.after ||
    baseDbHooks.account?.create?.before
  )
    throw new Error(
      'buildAuthOptions now sets a database hook that createAuthInstance also sets; compose them explicitly',
    );
  /**
   * Bổ sung vào options của Task 33 (không sửa `buildAuthOptions`):
   * - S2-R40: reclaim trên link xác thực (`user.update.before`, xem `reclaimOnVerification`).
   * - S2-R39 lớp 2: tên từ IdP được làm sạch ở `databaseHooks` (mọi đường tạo/sửa user, cả ngoài HTTP).
   * - S2-R44 I1/R2: hàng rào cho session của mọi lần đăng nhập OAuth (`createSessionFence`).
   * - S2-R49: không liên kết ngầm provider vào user đã có mật khẩu (`createImplicitLinkGuard`).
   */
  const auth = betterAuth({
    ...base,
    databaseHooks: {
      ...baseDbHooks,
      user: {
        ...baseDbHooks.user,
        create: {
          ...baseDbHooks.user?.create,
          before: async (user) => ({
            data: { ...user, name: sanitizeDisplayName(user.name) },
          }),
        },
        update: {
          ...baseDbHooks.user?.update,
          before: async (user, ctx) => {
            if (ctx?.path === VERIFY_EMAIL && user.emailVerified === true)
              await reclaimOnVerification(ctx);
            return typeof user.name === 'string'
              ? { data: { ...user, name: sanitizeDisplayName(user.name) } }
              : undefined;
          },
        },
      },
      session: {
        ...baseDbHooks.session,
        create: {
          ...baseDbHooks.session?.create,
          after: createSessionFence(reclaimer),
        },
      },
      account: {
        ...baseDbHooks.account,
        create: {
          ...baseDbHooks.account?.create,
          before: createImplicitLinkGuard(
            {
              hasCredential: async (userId) => {
                if (!findCredentialAccount)
                  throw new Error('Better Auth instance is not built yet');
                return (await findCredentialAccount(userId)) !== null;
              },
            },
            d.logger,
          ),
        },
      },
    },
  });
  findCredentialAccount = async (userId) =>
    (await auth.$context).internalAdapter.findCredentialAccount(userId);
  readSession = (headers) =>
    auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
  return auth;
}
export type AuthInstance = ReturnType<typeof createAuthInstance>;

export class AuthProviderRegistrationError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      missing
        .map(
          (id) =>
            `OIDC provider "${id}" did not register (discovery without a usable issuer and jwks_uri, or unreachable); refusing to start`,
        )
        .join('; '),
    );
    this.name = 'AuthProviderRegistrationError';
  }
}

/**
 * S2-R37: Better Auth chỉ log rồi BỎ QUA provider `genericOAuth` khi `requireIdTokenVerification` mà discovery
 * không có issuer + jwks_uri (`plugins/generic-oauth/index.mjs`, `init`). Danh sách provider chỉ có sau khi
 * `init` bất đồng bộ chạy xong (`auth.$context`), nên không kiểm được trong `createAuthInstance` (đồng bộ):
 * Task 35 gọi hàm này lúc boot và để lỗi làm dừng khởi động.
 */
export async function assertAuthProvidersRegistered(
  auth: AuthInstance,
  identity: IdentityConfig,
): Promise<void> {
  const ctx = await auth.$context;
  const registered = new Set(ctx.socialProviders.map((p) => p.id));
  const expected = [
    ...Object.keys(auth.options.socialProviders),
    ...(identity.mode === 'hybrid' && identity.oidcProviderId
      ? [identity.oidcProviderId]
      : []),
  ];
  const missing = expected.filter((id) => !registered.has(id));
  if (missing.length) throw new AuthProviderRegistrationError(missing);
}
