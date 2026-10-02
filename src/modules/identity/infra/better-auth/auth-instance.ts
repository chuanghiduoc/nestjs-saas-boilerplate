import { kyselyAdapter } from '@better-auth/kysely-adapter';
import type { Logger } from '@nestjs/common';
import {
  betterAuth,
  type BetterAuthOptions,
  type GenericEndpointContext,
} from 'better-auth';
import {
  queueAfterTransactionHook,
  tryGetCurrentAuthEndpointContext,
} from '@better-auth/core/context';
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
import type { UserDeletionGuard } from '../../ports/user-deletion-guard.js';
import { errorClass, safeErrorFields } from '../../identity-telemetry.js';
import { withAccountCipher } from './account-cipher.adapter.js';
import {
  authDbQueryLog,
  recordAuthApiError,
  recordingCheckoutPool,
} from './auth-db-failures.js';
import { recordAuthError } from './auth-error-capture.js';
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
import type { StaffStepUp } from './staff-step-up.js';
import { UnverifiedLinkRevoker } from './unverified-links.js';
import type { IdentityMetrics } from '../../identity-metrics.js';

export const BETTER_AUTH = Symbol('identity.betterAuth');
/** `@` hoặc dạng percent-encoded `%40` (địa chỉ trong URL/query), không phân biệt hoa thường (Task 40 M9). */
const EMAIL_LIKE = /[^\s@<>"']+(?:@|%40)[^\s@<>"']+/gi;
const SOURCE = 'better-auth';
const VERIFY_EMAIL = '/verify-email';
/** `logger.error("Failed to create user", e)` của `api/routes/sign-up.mjs` (1.7.6). */
const BETTER_AUTH_CREATE_USER_FAILED = 'Failed to create user';
/** Message của Better Auth có thể chứa email: thay trước khi log (spec §5.14). */
export const maskEmails = (message: string): string =>
  message.replace(EMAIL_LIKE, '[email]');

/**
 * S2-R59/S2-R63: dòng log của Better Auth 1.7.6 sinh ra từ INPUT CỦA CLIENT (không phải sự cố của hệ thống), kẻ tấn
 * công gọi được tuỳ ý: chỉ là warn và không mang giá trị client gửi. Danh sách đóng, khớp đúng tiền tố; test drift giữ
 * nó khớp với dist đã cài.
 * - `VALUE_PREFIXES`: dạng `<tiền tố>: <giá trị>` (`api/middlewares/origin-check.mjs`: `Invalid ${label}: ${url}` với
 *   label `callbackURL`, `redirectURL`, `errorCallbackURL`, `newUserCallbackURL`, và `Invalid origin: …`); phần sau
 *   `:` bị bỏ.
 * - `CONSTANT_PREFIXES`: `Blocked cross-site navigation login attempt (CSRF protection)` (`formCsrfMiddleware`,
 *   luôn kèm 403); chỉ giữ tiền tố, các header đi kèm ở `args` vốn không bao giờ được log.
 */
const VALUE_PREFIXES = [
  'Invalid callbackURL',
  'Invalid redirectURL',
  'Invalid errorCallbackURL',
  'Invalid newUserCallbackURL',
  'Invalid origin',
] as const;
const CONSTANT_PREFIXES = ['Blocked cross-site navigation'] as const;
export const CLIENT_INPUT_LOG_PREFIXES = [
  ...VALUE_PREFIXES,
  ...CONSTANT_PREFIXES,
] as const;
/**
 * `@better-auth/api-key` 1.7.6 log dòng này (`logger.error("Failed to validate API key:", error)`) cho CẢ key rác
 * (`APIError` 4xx) lẫn lỗi storage thật: phân loại theo `args[0]`, không theo chữ. Chỉ `APIError` dưới 500 là input
 * của client (S2-R63/N5: `APIError` 5xx của đường secondary storage vẫn là ERROR).
 */
export const API_KEY_VALIDATION_LOG = 'Failed to validate API key:';
/**
 * `oauth2/state.mjs` 1.7.6: `logger.error("Failed to parse state", error)` cho cả state rác của client (`StateError`
 * với mã `state_not_found`/`state_mismatch`/`state_security_mismatch`/`state_invalid`) lẫn lỗi storage thật (lỗi DB
 * của `findVerificationValue`). `StateError` không được export, nên phân loại theo mã (S2-R63); mã khác (kể cả
 * `state_generation_error`) và lỗi không có mã vẫn là ERROR.
 */
export const OAUTH_STATE_LOG = 'Failed to parse state';
export const CLIENT_STATE_ERROR_CODES: ReadonlySet<string> = new Set([
  'state_not_found',
  'state_mismatch',
  'state_security_mismatch',
  'state_invalid',
]);
const HTTP_SERVER_ERROR = 500;
const isClientApiError = (v: unknown): boolean =>
  isAPIError(v) && v.statusCode < HTTP_SERVER_ERROR;
const isClientStateError = (v: unknown): boolean =>
  typeof v === 'object' &&
  v !== null &&
  'code' in v &&
  typeof v.code === 'string' &&
  CLIENT_STATE_ERROR_CODES.has(v.code);

export type BetterAuthLogEntry = {
  level: 'error' | 'warn';
  message: string;
  clientInput: boolean;
};
export function classifyBetterAuthLog(
  level: string,
  message: string,
  args: readonly unknown[],
): BetterAuthLogEntry {
  const prefix =
    VALUE_PREFIXES.find((p) => message.startsWith(`${p}:`)) ??
    CONSTANT_PREFIXES.find((p) => message.startsWith(p));
  if (prefix) return { level: 'warn', message: prefix, clientInput: true };
  const byArg =
    message === API_KEY_VALIDATION_LOG
      ? isClientApiError(args[0])
      : message === OAUTH_STATE_LOG
        ? isClientStateError(args[0])
        : undefined;
  if (byArg !== undefined)
    return byArg
      ? { level: 'warn', message, clientInput: true }
      : { level: 'error', message, clientInput: false };
  return {
    level: level === 'error' ? 'error' : 'warn',
    message: maskEmails(message),
    clientInput: false,
  };
}

const JWS_COMPACT_PARTS = 3;
/**
 * Notif-review M1: dạng chính tắc của một JWS compact đã được verify, làm nguồn khoá dedupe S2-R68. Đoạn chữ ký
 * HS256 là 43 ký tự base64url, ký tự cuối mang 2 bit thừa; jose giải mã lỏng nên chấp nhận cả 4 biến thể của ký tự đó
 * (header và payload thì không: chúng nằm trong dữ liệu được ký). Băm chuỗi thô → 4 khoá khác nhau → 4 thư cho một
 * link. Mã hoá lại byte ĐÃ GIẢI của chữ ký (`Buffer` bỏ bit thừa) cho cùng một chuỗi với mọi biến thể.
 */
export const canonicalJwt = (token: string): string => {
  const parts = token.split('.');
  if (parts.length !== JWS_COMPACT_PARTS)
    throw new Error('verified email token is not a compact JWS');
  const [header, payload, signature] = parts;
  return `${header}.${payload}.${Buffer.from(signature ?? '', 'base64url').toString('base64url')}`;
};

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
  /** S2-R75: đường gửi nhanh của thông báo bảo mật (`SecurityNoticeService.afterChange`, không ném). */
  notifySecurityChange(userId: string): Promise<void>;
  /**
   * `UnitOfWork.inTransaction()` của app (Task 32 carry-forward). `uow.run` tham gia transaction đang mở, nên nếu
   * `onUserCreated` chạy bên trong một transaction của app thì marker có thể commit trước khi event được ghi.
   */
  inAppTransaction(): boolean;
  /** Spec SP3 §9.6: port của tenancy, vắng khi app không bật tenancy (`@Optional`). */
  userDeletion?: UserDeletionGuard;
  requestId(): string;
  problemTypeBase: string;
  logger: Logger;
  /** Spec SP3 §5.2 (3D): câu factor/dấu của nhân viên cho hook. */
  stepUp: StaffStepUp;
  metrics: IdentityMetrics;
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
    // S2-R65 review I2: checkout hết chờ pool cũng được ghi (Kysely không log lỗi `acquireConnection`).
    dialect: new PostgresDialect({ pool: recordingCheckoutPool(d.pool) }),
    plugins: [new CamelCasePlugin()],
    // S2-R65: ghi lỗi hạ tầng của từng query vào scope của lời gọi, trước khi Better Auth nuốt nó.
    log: authDbQueryLog,
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
    notifySecurityChange: (userId) => d.notifySecurityChange(userId),
    session: (headers) => {
      if (!readSession)
        throw new Error('Better Auth instance is not built yet');
      return readSession(headers);
    },
    reclaim: (userId, trigger) => reclaimer.revoke(userId, trigger),
    lastReclaim: (email) => reclaimer.lastReclaim(email),
    userDeletion: d.userDeletion,
    requestId: () => d.requestId(),
    problemTypeBase: d.problemTypeBase,
    logger: d.logger,
    stepUp: d.stepUp,
    metrics: d.metrics,
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
      // S2-R65: lỗi từ query của chính hook (pool `auth_user` trực tiếp, ngoài Kysely) trước khi `onError` đổi nó thành
      // APIError 500 không `cause`; lỗi không phải của pool auth đánh dấu 500 là lỗi thật (review M1/M2).
      recordAuthApiError(err);
      // N7: lớp lỗi thật cho dòng `auth_endpoint_error` của mount (chỉ lỗi dẫn tới 5xx).
      if (!isAPIError(err) || err.statusCode >= HTTP_SERVER_ERROR)
        recordAuthError(err);
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
          // S2-R62: lớp + SQLSTATE/mã (không message/stack): thay cho bản in thô `# SERVER_ERROR` đã chặn.
          ...safeErrorFields(err),
        });
    },
    userDeletion: d.userDeletion,
    onUserDeletionBlocked: (reason) =>
      d.logger.warn(
        { source: SOURCE, event: 'user_deletion_blocked_race', reason },
        'account deletion blocked after Better Auth removed its sessions and password; see the runbook for a partially deleted account',
      ),
    log: (level, message, args) => {
      const c = classifyBetterAuthLog(level, message, args);
      // `betterAuthLevel`, không `level`: trường `level` trùng tên đè mức số của pino trong JSON (bộ gom log đọc
      // khoá sau cùng), làm dòng warn hiện thành "error" và ngược lại (Task 40 fix round 1).
      const entry = {
        source: SOURCE,
        betterAuthLevel: level,
        message: c.message,
      };
      // M4: dòng này của Better Auth có cả ở race đăng ký song song (dự kiến) lẫn lỗi DB thật; hook `after` của
      // `/sign-up/email` phân biệt hai trường hợp (`signup_duplicate_race` info / `signup_create_failed` ERROR).
      if (message === BETTER_AUTH_CREATE_USER_FAILED)
        d.logger.warn({ ...entry, event: 'better_auth_create_user_failed' });
      else if (c.clientInput)
        d.logger.warn({ ...entry, event: 'better_auth_client_input_rejected' });
      else if (c.level === 'error') d.logger.error(entry);
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
   * - DB final review M4 (CHECK `email = lower(btrim(email)) AND email IS NFC NORMALIZED` trên `auth."user"`): email được
   *   chuẩn hoá (`normalizeEmail`: trim, lower, NFC) ở cùng hai hook. Better Auth 1.7.6 chỉ hạ chữ thường email ở đường
   *   OAuth/IdP và admin, không trim, không NFC; không chuẩn hoá thì email IdP có khoảng trắng hoặc Unicode tách rời
   *   vấp 23514. Đường HTTP công khai đã chuẩn hoá trước khi Better Auth validate (`EMAIL_FIELDS_BY_PATH`).
   * - S2-R44 I1/R2: hàng rào cho session của mọi lần đăng nhập OAuth (`createSessionFence`).
   * - S2-R49: không liên kết ngầm provider vào user đã có mật khẩu (`createImplicitLinkGuard`).
   */
  const baseSendVerification = base.emailVerification.sendVerificationEmail;
  /**
   * S2-R68 I1: token của link xác nhận đổi email khi callback chạy trong lần bấm `GET /verify-email` (endpoint context
   * của Better Auth, `tryGetCurrentAuthEndpointContext`). Mỗi lần bấm, Better Auth mint một token xác thực MỚI
   * (`email-verification.mjs:198`), nên khoá theo token đó sẽ gửi một thư mỗi lần bấm (dội thư tới địa chỉ tuỳ ý).
   * Khoá theo token XÁC NHẬN: mỗi link sinh tối đa một thư ở mỗi nhánh, lần bấm lại chỉ gặp `ON CONFLICT DO NOTHING`.
   * Đăng ký, gửi lại thư xác thực: không phải `/verify-email` → `undefined`, khoá cũ theo token của thư.
   */
  const confirmationClickToken = (): string | undefined => {
    const ctx = tryGetCurrentAuthEndpointContext();
    if (ctx?.path !== VERIFY_EMAIL) return undefined;
    const token: unknown = ctx.query?.token;
    return typeof token === 'string' && token ? canonicalJwt(token) : undefined;
  };
  const auth = betterAuth({
    ...base,
    emailVerification: {
      ...base.emailVerification,
      /**
       * S2-R66, bước bấm link xác nhận ở địa chỉ cũ. `case "change-email-confirmation"` của `/verify-email`
       * (`api/routes/email-verification.mjs:197-211`) gọi `sendVerificationEmail({ user: { ...user, email: updateTo } })`
       * sau khi đã kiểm token và session; phản hồi (redirect `callbackURL` hoặc `{status:true}`) không phụ thuộc
       * callback này, nên hai nhánh trả về giống hệt nhau. Địa chỉ đích đã thuộc về user KHÁC → chỉ gửi thông báo
       * "đã có tài khoản" cho chủ của nó (spec §5.8), không gửi gì cho người yêu cầu và không gửi link xác thực. Mọi
       * đường khác (đăng ký, gửi lại thư xác thực, đổi email của user chưa xác thực) có `user.email` là email của
       * chính user hoặc địa chỉ trống, nên đi tiếp như cũ. Race: địa chỉ bị người khác lấy SAU bước này thì bước
       * xác thực cuối (`updateUserByEmail`) vấp `UNIQUE(email)` và thất bại, không đổi email.
       */
      //
      // Chạy SAU commit (`queueAfterTransactionHook`): đăng ký gọi callback này BÊN TRONG transaction của nó
      // (`api/routes/sign-up.mjs`), mà tra `IdentityDirectory` là một connection thứ hai của pool auth (N1: cạn pool
      // khi đăng ký song song). Ngoài transaction (bấm link ở `/verify-email`) nó chạy ngay. Lỗi: log lớp lỗi rồi
      // nuốt, như `afterCommit` của callback gốc (một lỗi chỉ có ở một nhánh sẽ lộ nhánh).
      sendVerificationEmail: (data) =>
        queueAfterTransactionHook(
          async () => {
            const onceFor = confirmationClickToken();
            const owner = await d.directory.findUserByEmail(
              normalizeEmail(data.user.email),
            );
            if (owner && owner.id !== data.user.id) {
              // `AuthEmails` đã log + đếm lỗi gửi thư.
              await d.emails
                .existingAccount({ user: owner, onceFor })
                .catch(() => undefined);
              return;
            }
            await baseSendVerification(onceFor ? { ...data, onceFor } : data);
          },
          {
            onError: (err) =>
              d.logger.error(
                {
                  event: 'auth_verification_email_routing_failed',
                  errorClass: errorClass(err),
                },
                'verification email could not be routed',
              ),
          },
        ),
    },
    databaseHooks: {
      ...baseDbHooks,
      user: {
        ...baseDbHooks.user,
        create: {
          ...baseDbHooks.user?.create,
          before: async (user) => ({
            data: {
              ...user,
              email: normalizeEmail(user.email),
              name: sanitizeDisplayName(user.name),
            },
          }),
        },
        update: {
          ...baseDbHooks.user?.update,
          before: async (user, ctx) => {
            if (ctx?.path === VERIFY_EMAIL && user.emailVerified === true)
              await reclaimOnVerification(ctx);
            if (typeof user.email !== 'string' && typeof user.name !== 'string')
              return undefined;
            return {
              data: {
                ...user,
                ...(typeof user.email === 'string'
                  ? { email: normalizeEmail(user.email) }
                  : {}),
                ...(typeof user.name === 'string'
                  ? { name: sanitizeDisplayName(user.name) }
                  : {}),
              },
            };
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
