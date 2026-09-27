import type { Logger } from '@nestjs/common';
import {
  APIError,
  createAuthMiddleware,
  getOAuthState,
  isAPIError,
  type AuthMiddleware,
} from 'better-auth/api';
import {
  AppError,
  CoreErrors,
  PROBLEM_JSON,
  problemBody,
  zodIssuesToFields,
} from '../../../../core/errors/index.js';
import { DISPLAY_NAME_MAX, displayName } from '../../../notifications/index.js';
import type { AuthEmails } from '../../application/auth-emails.js';
import { IdentityErrors } from '../../errors.js';
import type { IdentityDirectory } from '../../ports/identity-directory.js';
import { authUnavailable, mapAuthError } from './auth-error.mapper.js';
import type { AuthRequestState } from './auth-request-state.js';
import { normalizeEmail } from './email-normalize.js';
import {
  LockoutBlockedError,
  LockoutUnavailableError,
  type LockoutScope,
  type LoginLockout,
} from './login-lockout.js';
import type {
  ReclaimTrigger,
  UnverifiedLinkRevoker,
} from './unverified-links.js';

const MS_PER_SECOND = 1000;
const ACCEPTED = 202;
const TOO_MANY_REQUESTS = 429;
const FIRST_ERROR_STATUS = 400;
const SIGN_IN = '/sign-in/email';
const SIGN_UP = '/sign-up/email';
const UPDATE_USER = '/update-user';
const CHANGE_EMAIL = '/change-email';
const CHANGE_PASSWORD = '/change-password';
const RESET_PASSWORD = '/reset-password';
const VERIFY_TOTP = '/two-factor/verify-totp';
const DISABLE_2FA = '/two-factor/disable';
/** Đường xác minh 2FA khi đăng nhập; khoá theo tài khoản là `accountLockout` có sẵn của plugin (S2-R6). */
const TWO_FACTOR_VERIFY = new Set([
  VERIFY_TOTP,
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
]);
/** Thao tác nhạy cảm cần session mới (spec §5.6.4, S2-R38); `sensitiveSessionMiddleware` không kiểm độ mới (A.5). */
const SENSITIVE = new Set([
  CHANGE_PASSWORD,
  CHANGE_EMAIL,
  '/two-factor/enable',
  DISABLE_2FA,
  '/api-key/create',
]);
/** Route mà user tự đặt tên hiển thị (S2-R39). Tên từ IdP đi qua `databaseHooks` (`sanitizeDisplayName`). */
const NAME_PATHS = new Set([SIGN_UP, UPDATE_USER]);
const NAME_FIELD = 'name';
/** Identifier của token đặt lại mật khẩu (`better-auth/dist/api/routes/password.mjs`, `resetPassword`). */
const RESET_IDENTIFIER_PREFIX = 'reset-password:';
const FAILED_TO_CREATE_USER = 'FAILED_TO_CREATE_USER';
/** Mã của `accountLockout` có sẵn (`plugins/two-factor/verify-two-factor.mjs`, `assertTwoFactorNotLocked`). */
const ACCOUNT_TEMPORARILY_LOCKED = 'ACCOUNT_TEMPORARILY_LOCKED';
/** Endpoint OAuth tạo session sau khi IdP trả về (`api/routes/callback.mjs`, `api/routes/sign-in.mjs` nhánh idToken). */
const OAUTH_CALLBACK = '/callback/:id';
const SOCIAL_SIGN_IN = '/sign-in/social';
/** Liên kết TƯỜNG MINH bằng idToken, trong chính request của user đã đăng nhập (`api/routes/account.mjs`). */
const LINK_SOCIAL = '/link-social';
const CREDENTIAL_PROVIDER_ID = 'credential';
/** Mã lỗi khi hàng rào xoá session của lần đăng nhập (S2-R44 R2). */
const OAUTH_SESSION_REVOKED = 'OAUTH_SESSION_REVOKED';
const LINE_BREAKS = /[\r\n]+/g;
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/** Trường email được chuẩn hoá trước khi Better Auth validate (review I6, Review Focus 1). */
export const EMAIL_FIELDS_BY_PATH: Readonly<Record<string, string>> = {
  [SIGN_UP]: 'email',
  [SIGN_IN]: 'email',
  '/request-password-reset': 'email',
  '/send-verification-email': 'email',
  [CHANGE_EMAIL]: 'newEmail',
};

/**
 * Tên từ IdP (S2-R39, lớp 2): không từ chối được (user không sửa được claim của IdP) nên làm sạch theo đúng ràng
 * buộc `displayName` của notifications: CR/LF thành một dấu cách, cắt ở `DISPLAY_NAME_MAX` đơn vị UTF-16 (cùng
 * cách đếm với `z.string().max`), không để lại nửa cặp surrogate.
 */
export const sanitizeDisplayName = (name: string): string =>
  name
    .replace(LINE_BREAKS, ' ')
    .slice(0, DISPLAY_NAME_MAX)
    .replace(TRAILING_HIGH_SURROGATE, '');

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {};
const stringField = (v: unknown, key: string): string | undefined => {
  const r = asRecord(v)[key];
  return typeof r === 'string' ? r : undefined;
};

/**
 * Provider của lần đăng nhập OAuth đang ghi session (S2-R44 I1), từ endpoint context mà
 * `databaseHooks.session.create.after` nhận. `undefined` = session không đến từ callback OAuth.
 */
export const oauthLoginProvider = (
  ctx: { path?: string; params?: unknown; body?: unknown } | null,
): string | undefined => {
  if (ctx?.path === OAUTH_CALLBACK) return stringField(ctx.params, 'id');
  if (ctx?.path === SOCIAL_SIGN_IN) return stringField(ctx.body, 'provider');
  return undefined;
};

type ProviderCtx = { path?: string; params?: unknown; body?: unknown } | null;

/**
 * `databaseHooks.session.create.after` (S2-R44 I1, R2, S2-R48). Hook chạy NGAY sau khi INSERT session autocommit,
 * bên trong `createSession`, TRƯỚC `setSessionCookie` (luồng OAuth không bọc `createSession` trong transaction:
 * `oauth2/link-account.mjs:322`, `core/context/transaction.mjs` `queueAfterTransactionHook` chạy ngay). Áp cho MỌI
 * provider (S2-R48: reclaim gỡ cả liên kết của provider tin cậy). Hàng rào xoá session thì ném `APIError` 401:
 * lỗi đi ngược qua `createSession` → `handleOAuthUserInfo` (không có catch bao quanh), nên không có `Set-Cookie`
 * session và không có thân user; `/callback/:id` chuyển nó thành redirect lỗi (`api/routes/callback.mjs:191-192`),
 * nhánh idToken của `/sign-in/social` trả 401.
 */
export const createSessionFence =
  (revoker: Pick<UnverifiedLinkRevoker, 'fenceLateSession'>) =>
  async (
    session: { id: string; userId: string },
    ctx: ProviderCtx,
  ): Promise<void> => {
    const provider = oauthLoginProvider(ctx);
    if (provider === undefined) return;
    if (await revoker.fenceLateSession(session, provider))
      throw APIError.from('UNAUTHORIZED', {
        code: OAUTH_SESSION_REVOKED,
        message: 'The provider link was removed; sign in again',
      });
  };

/**
 * S2-R49 (`databaseHooks.account.create.before`): không LIÊN KẾT NGẦM một provider vào user đã có mật khẩu. Liên
 * kết ngầm = `internalAdapter.linkAccount` trong `handleOAuthUserInfo` (`oauth2/link-account.mjs`, trên
 * `/callback/:id` và `/sign-in/social`). Tường minh thì được phép:
 * - `/link-social` nhánh idToken tạo account ngay trong request đó (`api/routes/account.mjs:216`);
 * - `/link-social` nhánh redirect tạo account ở callback, khi OAuth state có `link` (`oauth2/state.mjs`: `link`
 *   được ghi SAU `additionalData`, nên client không giả được; đọc qua `getOAuthState`, export public).
 * Account `credential` và user chưa có mật khẩu (đăng ký qua OAuth) không bị ảnh hưởng. Trả `false` thì Better Auth
 * trả lỗi "unable to link account". Race đã biết: một `credential` được tạo song song (reset mật khẩu của user
 * chưa có mật khẩu) với một lần liên kết ngầm có thể cùng lọt; khi đó cả hai bên đều đã chứng minh cùng email
 * (hộp thư và IdP tin cậy có `email_verified`), nên không mở đường chiếm tài khoản.
 */
export const createImplicitLinkGuard =
  (
    revoker: Pick<UnverifiedLinkRevoker, 'hasCredential'>,
    logger: Pick<Logger, 'warn'>,
    oauthState: () => Promise<{ link?: unknown } | null> = getOAuthState,
  ) =>
  async (
    account: { userId: string; providerId: string },
    ctx: { path?: string } | null,
  ): Promise<false | undefined> => {
    if (account.providerId === CREDENTIAL_PROVIDER_ID) return undefined;
    if (ctx?.path === LINK_SOCIAL) return undefined;
    if (ctx && (await oauthState())?.link) return undefined;
    if (!(await revoker.hasCredential(account.userId))) return undefined;
    logger.warn(
      {
        event: 'identity_implicit_link_refused',
        providerId: account.providerId,
        userId: account.userId,
      },
      'implicit provider link onto a password account refused; link it explicitly via /link-social',
    );
    return false;
  };

/** Session mà hook cần (độ mới, trạng thái 2FA, B4). */
export type HookSession = {
  user: { id: string; twoFactorEnabled?: boolean | null | undefined };
  session: { id: string; createdAt: Date };
};

export type AuthHookDeps = {
  freshAgeSec: number;
  unavailableRetryAfterSec: number;
  /** `AUTH_LOCKOUT_BLOCK_SEC`: `accountLockout` của 2FA khoá đúng chừng này, dùng làm `Retry-After` (cận trên). */
  twoFactorLockoutSec: number;
  lockout: LoginLockout;
  state: AuthRequestState;
  emails: AuthEmails;
  directory: IdentityDirectory;
  /**
   * Session của request, qua `auth.api.getSession` (API public, S2-R47). KHÔNG dùng `getSessionFromCtx`: hook này
   * chạy TRƯỚC hook `before` của plugin `bearer`, và header cookie mà `bearer` dựng chỉ được áp sau khi mọi hook
   * `before` chạy xong (`api/dispatch.mjs`, `runBeforeHooks`), nên nó không thấy session bearer (bỏ qua kiểm độ mới
   * cho mobile) và còn cache `null` vào `ctx.context.session`. Lời gọi lồng chỉ thêm một lần `findSession`; plugin
   * `jwt` không còn ký JWT ở `/get-session` (`disableSettingJwtHeader`, S2-R46).
   */
  session(headers: Headers): Promise<HookSession | null>;
  /** S2-R40 cho nhánh đặt lại mật khẩu (nhánh link xác thực: `databaseHooks.user.update.before`, `auth-instance.ts`). */
  reclaim(userId: string, trigger: ReclaimTrigger): Promise<void>;
  requestId(): string;
  problemTypeBase: string;
  logger: Pick<Logger, 'error' | 'log'>;
};

/**
 * `AuthEmails` đã log có cấu trúc (không PII) và tăng `identity_auth_email_request_failed_total` trước khi ném lại.
 * Ở đây không ném tiếp: thông báo hỏng không được biến một thao tác đã thành công thành lỗi, và ở nhánh chống dò
 * email (sign-up, change-email) một lỗi chỉ có ở nhánh "email đã có" sẽ lộ email tồn tại (spec §5.8). Cùng cách
 * `afterCommit` của `auth-options.ts` xử lý callback email của Better Auth.
 */
const notify = (sent: Promise<void>): Promise<void> =>
  sent.catch(() => undefined);

type HookCtx = { path: string; request?: Request | undefined };
/**
 * `instance` của problem = path của request, không query: đúng quy tắc của `ProblemDetailsFilter`
 * (`getRequestUrl(req).split('?')[0]`) và của mount (URL dựng từ `req.originalUrl`, S1), nên cùng một endpoint
 * có cùng `instance` dù lớp nào trả lỗi (M2). Lời gọi `auth.api.*` không có request thì dùng path endpoint.
 */
const problemInstance = (ctx: HookCtx): string =>
  ctx.request ? new URL(ctx.request.url).pathname : ctx.path;

export function createAuthHooks(d: AuthHookDeps): {
  before: AuthMiddleware;
  after: AuthMiddleware;
} {
  const problem = (ctx: HookCtx, err: AppError) =>
    new Response(
      JSON.stringify(
        problemBody(
          err,
          {
            instance: problemInstance(ctx),
            requestId: d.requestId(),
            typeBase: d.problemTypeBase,
          },
          true,
        ),
      ),
      {
        status: err.error.status,
        headers: { 'content-type': PROBLEM_JSON, ...err.opts.headers },
      },
    );
  const rateLimited = (ctx: HookCtx, retryAfterSec: number) =>
    problem(
      ctx,
      mapAuthError(
        {
          status: TOO_MANY_REQUESTS,
          retryAfter: String(retryAfterSec),
          path: ctx.path,
        },
        { unavailableRetryAfterSec: d.unavailableRetryAfterSec },
      ),
    );

  /** consume TRƯỚC khi xác minh (spec §5.7); bị khoá → 429, storage lỗi → 503, không bao giờ cho qua. */
  const guard = async (
    ctx: HookCtx,
    scope: LockoutScope,
  ): Promise<Response | undefined> => {
    try {
      await d.state.addTicket(await d.lockout.guard(scope));
      return undefined;
    } catch (err) {
      if (err instanceof LockoutBlockedError)
        return rateLimited(ctx, err.retryAfterSec);
      if (err instanceof LockoutUnavailableError)
        return problem(ctx, authUnavailable(d.unavailableRetryAfterSec));
      throw err;
    }
  };
  const noticeIfExists = async (
    email: string | undefined,
  ): Promise<boolean> => {
    const existing = email
      ? await d.directory.findUserByEmail(normalizeEmail(email))
      : undefined;
    if (existing) await notify(d.emails.existingAccount({ user: existing }));
    return existing !== undefined;
  };
  /** S2-R39, lớp 1: tên user tự nhập phải thoả `displayName` của notifications, không thì 422 trên trường `name`. */
  const nameProblem = (ctx: HookCtx, name: string): Response | undefined => {
    const parsed = displayName.safeParse(name);
    if (parsed.success) return undefined;
    const fields = zodIssuesToFields(
      parsed.error.issues.map((i) => ({ ...i, path: [NAME_FIELD, ...i.path] })),
    );
    return problem(ctx, new AppError(CoreErrors.VALIDATION_FAILED, { fields }));
  };

  const before = createAuthMiddleware(async (ctx) => {
    /**
     * Token đặt lại mật khẩu hợp lệ = chủ email đã được chứng minh (S2-R40); chạy TRƯỚC khi Better Auth tiêu thụ
     * token, nên lỗi DB làm reset dừng (fail closed) và token vẫn dùng lại được. Hệ quả đã chấp nhận (review (c)):
     * token hợp lệ nhưng `newPassword` sai quy tắc (400) thì reclaim vẫn đã chạy — token đã đủ chứng minh chủ email.
     */
    const reclaimOnReset = async (
      body: Record<string, unknown>,
    ): Promise<void> => {
      const token =
        stringField(body, 'token') ?? stringField(ctx.query, 'token');
      if (!token) return;
      const verification =
        await ctx.context.internalAdapter.findVerificationValue(
          `${RESET_IDENTIFIER_PREFIX}${token}`,
        );
      if (verification && verification.expiresAt.getTime() > Date.now())
        await d.reclaim(verification.value, 'password-reset');
    };

    const body = asRecord(ctx.body);
    let changed = false;
    const emailField = EMAIL_FIELDS_BY_PATH[ctx.path];
    const rawEmail = emailField ? stringField(body, emailField) : undefined;
    if (emailField && rawEmail !== undefined) {
      body[emailField] = normalizeEmail(rawEmail);
      changed = true;
    }
    const name = NAME_PATHS.has(ctx.path)
      ? stringField(body, NAME_FIELD)
      : undefined;
    if (name !== undefined) {
      const invalid = nameProblem(ctx, name);
      if (invalid) return invalid;
    }
    const session =
      SENSITIVE.has(ctx.path) || ctx.path === VERIFY_TOTP
        ? await d.session(ctx.headers ?? new Headers())
        : null;
    if (
      SENSITIVE.has(ctx.path) &&
      session &&
      Date.now() - new Date(session.session.createdAt).getTime() >
        d.freshAgeSec * MS_PER_SECOND
    )
      return problem(
        ctx,
        new AppError(IdentityErrors.REAUTHENTICATION_REQUIRED),
      );
    if (ctx.path === SIGN_IN) {
      const blocked = await guard(ctx, {
        kind: 'signin',
        email: stringField(body, 'email') ?? '',
      });
      if (blocked) return blocked;
    }
    // Trạng thái 2FA trước thao tác, để `after` chỉ báo khi trạng thái THẬT SỰ đổi (review M8).
    if ((ctx.path === VERIFY_TOTP || ctx.path === DISABLE_2FA) && session)
      await d.state.setTwoFactorBefore({
        userId: session.user.id,
        sessionId: session.session.id,
        enabled: session.user.twoFactorEnabled === true,
      });
    // B4: tra email đích CHỈ khi đã có session hợp lệ và mới; ẩn danh đi tiếp để endpoint trả 401 (không oracle).
    if (
      ctx.path === CHANGE_EMAIL &&
      session &&
      (await noticeIfExists(stringField(body, 'newEmail')))
    )
      return new Response(null, { status: ACCEPTED });
    if (ctx.path === RESET_PASSWORD) await reclaimOnReset(body);
    if (ctx.path === CHANGE_PASSWORD) {
      body.revokeOtherSessions = true;
      changed = true;
    }
    return changed ? { context: { body } } : undefined;
  });

  const after = createAuthMiddleware(async (ctx) => {
    const returned = ctx.context.returned;
    // Review NI1: lỗi validate body là `APIError` của better-call (lớp CHA), không phải lớp con của
    // `better-auth/api`, nên `instanceof` bỏ sót. `isAPIError` (better-auth/api, 1.7.6: kiểm cả hai lớp + name)
    // bắt cả hai; nếu bỏ sót, sign-up sai định dạng bị trả 202 rỗng.
    const failed =
      isAPIError(returned) && returned.statusCode >= FIRST_ERROR_STATUS;
    const code = isAPIError(returned)
      ? stringField(returned.body, 'code')
      : undefined;
    if (!failed && ctx.path === SIGN_IN)
      // S2-R35: `refund` không bao giờ ném (tự log + metric).
      for (const t of await d.state.takeTickets()) await d.lockout.refund(t);
    // S2-R6: 429 của `accountLockout` có sẵn là JSON của Better Auth, không có `Retry-After`; trả cùng dạng
    // problem+json + `Retry-After` như khoá đăng nhập (spec §5.7). Thư viện khoá đúng `AUTH_LOCKOUT_BLOCK_SEC`.
    if (TWO_FACTOR_VERIFY.has(ctx.path) && code === ACCOUNT_TEMPORARILY_LOCKED)
      return rateLimited(ctx, d.twoFactorLockoutSec);
    const prior =
      !failed && (ctx.path === VERIFY_TOTP || ctx.path === DISABLE_2FA)
        ? await d.state.twoFactorBefore()
        : null;
    if (prior) {
      const user = await d.directory.findUser(prior.userId);
      if (!user)
        d.logger.error(
          {
            event: 'two_factor_notice_user_missing',
            path: ctx.path,
            userId: prior.userId,
          },
          'user vanished after a successful 2FA change; notice not sent',
        );
      else if (user.twoFactorEnabled !== prior.enabled)
        await notify(
          d.emails.twoFactorChanged(
            user,
            prior.sessionId,
            user.twoFactorEnabled,
          ),
        );
    }
    if (ctx.path === SIGN_UP) {
      if (!failed) return new Response(null, { status: ACCEPTED });
      if (code !== FAILED_TO_CREATE_USER) return undefined;
      // I5: hai đăng ký song song → UNIQUE(email) → Better Auth trả FAILED_TO_CREATE_USER (không cause). Tra lại:
      // có user thì đây là "email đã có" → thông báo + cùng 202 (spec §5.8). Không có thì giữ lỗi (lỗi DB thật).
      // M4: race dự kiến log mức info với event riêng; lỗi DB thật giữ mức ERROR.
      if (await noticeIfExists(stringField(ctx.body, 'email'))) {
        d.logger.log(
          { event: 'signup_duplicate_race' },
          'parallel sign-up lost the UNIQUE(email) race; answered as an existing account',
        );
        return new Response(null, { status: ACCEPTED });
      }
      d.logger.error(
        { event: 'signup_create_failed' },
        'sign-up failed to create the user and no user with that email exists',
      );
      return undefined;
    }
    if (!failed && ctx.path === CHANGE_EMAIL)
      return new Response(null, { status: ACCEPTED });
    return undefined;
  });

  return { before, after };
}
