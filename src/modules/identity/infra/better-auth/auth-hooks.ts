import type { Logger } from '@nestjs/common';
import type { User } from 'better-auth';
import {
  APIError,
  createAuthMiddleware,
  createEmailVerificationToken,
  getOAuthState,
  isAPIError,
  type AuthMiddleware,
} from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';
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
import {
  OAUTH_SESSION_REVOKED,
  authUnavailable,
  mapAuthError,
} from './auth-error.mapper.js';
import type { AuthRequestState } from './auth-request-state.js';
import { recordedAuthDbFailure } from './auth-db-failures.js';
import { normalizeEmail } from './email-normalize.js';
import {
  LockoutBlockedError,
  LockoutUnavailableError,
  type LockoutScope,
  type LoginLockout,
} from './login-lockout.js';
import type {
  ReclaimMarker,
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
const VERIFY_EMAIL = '/verify-email';
const VERIFY_TOTP = '/two-factor/verify-totp';
const DISABLE_2FA = '/two-factor/disable';
/** Endpoint OAuth tạo session sau khi IdP trả về (`api/routes/callback.mjs`, `api/routes/sign-in.mjs` nhánh idToken). */
const OAUTH_CALLBACK = '/callback/:id';
const SOCIAL_SIGN_IN = '/sign-in/social';
/** Liên kết TƯỜNG MINH bằng idToken, trong chính request của user đã đăng nhập (`api/routes/account.mjs`). */
const LINK_SOCIAL = '/link-social';
/** Đường xác minh 2FA khi đăng nhập; khoá theo tài khoản là `accountLockout` có sẵn của plugin (S2-R6). */
const TWO_FACTOR_VERIFY = new Set([
  VERIFY_TOTP,
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
]);
const ENABLE_2FA = '/two-factor/enable';
/**
 * S2-R75: endpoint có session có thể đổi `twoFactorEnabled` (better-auth 1.7.6): enable với method `otp` hoặc
 * `skipVerificationOnEnable` (`plugins/two-factor/index.mjs:117,140`), disable (`:217`), verify-totp/verify-otp lần đầu khi
 * có session (`plugins/two-factor/totp/index.mjs:208`, `plugins/two-factor/otp/index.mjs:226`). Marker bền do trigger của
 * DB ghi; hook `after` chỉ là đường gửi nhanh. Đường nào bị sót ở đây vẫn được cron `identity.reconcile-security-notices`
 * gửi bù.
 */
const TWO_FACTOR_CHANGE = new Set([
  ENABLE_2FA,
  DISABLE_2FA,
  VERIFY_TOTP,
  '/two-factor/verify-otp',
]);
/** Thao tác nhạy cảm cần session mới (spec §5.6.4, S2-R38); `sensitiveSessionMiddleware` không kiểm độ mới (A.5). */
const SENSITIVE = new Set([
  CHANGE_PASSWORD,
  CHANGE_EMAIL,
  ENABLE_2FA,
  DISABLE_2FA,
  '/api-key/create',
]);
/**
 * S2-R76: endpoint MINT CREDENTIAL hoặc ĐỔI DANH TÍNH, cấm với session của user chưa xác thực email (403
 * `email_not_verified`), bất kể `AUTH_REQUIRE_EMAIL_VERIFICATION`. Session như vậy chỉ đến từ lần đăng ký qua IdP
 * không tin cậy (hoặc đăng nhập mật khẩu khi cờ tắt): chưa ai chứng minh chủ email (spec §5.4), và mọi thứ nó tạo
 * sống sót qua reclaim S2-R40 (C1: API key, C2: token đổi email). Liệt kê theo better-auth 1.7.6 +
 * `@better-auth/api-key` 1.7.6 (path theo `createAuthEndpoint`, xem `VERIFIED_OWNER_ALLOWED`):
 * - core `api/routes/update-user.mjs`: `/update-user` (:13, tên/ảnh), `/change-password` (:76), `/delete-user` (:219),
 *   `/change-email` (:391, C2);
 * - core `api/routes/account.mjs`: `/link-social` (:75), `/unlink-account` (:260), `/get-access-token` (:408) và
 *   `/refresh-token` (:440) (mint/làm mới token của IdP);
 * - `plugins/jwt/index.mjs:141` `/token` (mint JWT);
 * - `@better-auth/api-key` `dist/index.mjs`: `/api-key/create` (:597, C1), `/api-key/update` (:1354, bật lại/gia hạn);
 * - tiền tố `/two-factor/` (`plugins/two-factor/{index,totp,otp,backup-codes}.mjs`: enable, disable, get-totp-uri,
 *   verify-totp/otp khi có session sẽ BẬT 2FA, generate-backup-codes, send-otp). Bước 2FA lúc đăng nhập chỉ mang
 *   cookie `two_factor`, không có session, nên không bị chặn;
 * - tiền tố `/admin/` (`plugins/admin/routes.mjs`: create-user, set-user-password, set-role… mint credential/đổi
 *   danh tính của user khác).
 */
export const VERIFIED_OWNER_PATHS: ReadonlySet<string> = new Set([
  UPDATE_USER,
  CHANGE_PASSWORD,
  '/delete-user',
  CHANGE_EMAIL,
  LINK_SOCIAL,
  '/unlink-account',
  '/get-access-token',
  '/refresh-token',
  '/token',
  '/api-key/create',
  '/api-key/update',
]);
export const VERIFIED_OWNER_PREFIXES = ['/two-factor/', '/admin/'] as const;
/**
 * Endpoint của 1.7.6 VẪN mở cho session chưa xác thực, kèm lý do (test drift duyệt `auth.api` và fail khi một endpoint
 * mới không thuộc danh sách nào):
 * - luồng xác thực và đăng xuất: `/send-verification-email`, `/verify-email`, `/sign-out`, `/get-session`;
 * - công khai, không dùng session: `/sign-up/email`, `/sign-in/*`, `/callback/:id`, `/request-password-reset`,
 *   `/reset-password`, `/reset-password/:token`, `/delete-user/callback` (token của thư), `/error`, `/ok`, `/jwks`;
 * - chỉ đọc hoặc chỉ THU HẸP quyền: `/list-sessions`, `/revoke-session(s)`, `/revoke-other-sessions`, `/list-accounts`,
 *   `/account-info`, `/verify-password`, `/update-session` (không có trường session bổ sung nào), `/api-key/get`,
 *   `/api-key/list`, `/api-key/delete`.
 * `/api-key/verify` và `/two-factor/view-backup-codes` không có trên HTTP (server-only, không path).
 */
export const VERIFIED_OWNER_ALLOWED: ReadonlySet<string> = new Set([
  '/send-verification-email',
  VERIFY_EMAIL,
  '/sign-out',
  '/get-session',
  SIGN_UP,
  SIGN_IN,
  SOCIAL_SIGN_IN,
  OAUTH_CALLBACK,
  '/request-password-reset',
  RESET_PASSWORD,
  '/reset-password/:token',
  '/delete-user/callback',
  '/error',
  '/ok',
  '/jwks',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/list-accounts',
  '/account-info',
  '/verify-password',
  '/update-session',
  '/api-key/get',
  '/api-key/list',
  '/api-key/delete',
]);
export const requiresVerifiedOwner = (path: string): boolean =>
  VERIFIED_OWNER_PATHS.has(path) ||
  VERIFIED_OWNER_PREFIXES.some((p) => path.startsWith(p));
/** Route mà user tự đặt tên hiển thị (S2-R39). Tên từ IdP đi qua `databaseHooks` (`sanitizeDisplayName`). */
const NAME_PATHS = new Set([SIGN_UP, UPDATE_USER]);
const NAME_FIELD = 'name';
/** Identifier của token đặt lại mật khẩu (`better-auth/dist/api/routes/password.mjs`, `resetPassword`). */
const RESET_IDENTIFIER_PREFIX = 'reset-password:';
const FAILED_TO_CREATE_USER = 'FAILED_TO_CREATE_USER';
/** Mã của `accountLockout` có sẵn (`plugins/two-factor/verify-two-factor.mjs`, `assertTwoFactorNotLocked`). */
const ACCOUNT_TEMPORARILY_LOCKED = 'ACCOUNT_TEMPORARILY_LOCKED';
/** `requestType` của JWT xác nhận ở địa chỉ cũ (`api/routes/update-user.mjs`, nhánh `canSendConfirmation`). */
const CHANGE_EMAIL_CONFIRMATION = 'change-email-confirmation';
const CREDENTIAL_PROVIDER_ID = 'credential';

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
 * provider (S2-R48: reclaim gỡ cả liên kết của provider tin cậy). Session không còn sống (hàng rào xoá, hoặc reclaim
 * đã xoá, Task 39) thì ném `APIError` 401: lỗi đi ngược qua `createSession` → `handleOAuthUserInfo` (không có catch bao quanh), nên không có `Set-Cookie`
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
 *
 * N1: hook này chạy BÊN TRONG transaction của Better Auth (đăng ký OAuth lần đầu: `createUser` + `createAccount`
 * trong `runWithTransaction`, `oauth2/link-account.mjs:274-289`), khi transaction đó đang giữ một connection của
 * pool auth. Vì vậy `credentials.hasCredential` phải đọc qua adapter của transaction hiện tại
 * (`internalAdapter.findCredentialAccount` → `getCurrentAdapter`, `db/internal-adapter.mjs`), không bao giờ
 * `pool.query`: lấy connection thứ hai trong lúc giữ connection thứ nhất làm cạn pool khi có ≥ `DB_AUTH_POOL_MAX`
 * lần đăng ký song song (deadlock tới hết `connectionTimeoutMillis`).
 */
export const createImplicitLinkGuard =
  (
    credentials: { hasCredential(userId: string): Promise<boolean> },
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
    if (!(await credentials.hasCredential(account.userId))) return undefined;
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
  user: User & { twoFactorEnabled?: boolean | null | undefined };
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
   * S2-R75: đường gửi nhanh của thông báo bảo mật sau một thao tác 2FA thành công (`SecurityNoticeService.afterChange`).
   * Không ném; marker chưa gửi được cron gửi bù.
   */
  notifySecurityChange(userId: string): Promise<void>;
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
  /** S2-R76: lần reclaim gần nhất của user có email này (marker bền), `undefined` nếu chưa từng. */
  lastReclaim(email: string): Promise<ReclaimMarker | undefined>;
  requestId(): string;
  problemTypeBase: string;
  logger: Pick<Logger, 'error' | 'log' | 'warn'>;
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

    /**
     * S2-R66: với user ĐÃ xác thực, đổi email là hai bước (S2-R42: địa chỉ CŨ xác nhận trước). Better Auth bỏ qua thư
     * xác nhận khi địa chỉ mới đã có tài khoản (`api/routes/update-user.mjs:447-451` trả `{status:true}` trước nhánh
     * `canSendConfirmation`), nên hộp thư CŨ của chính người yêu cầu thành kênh dò email. Vì vậy nhánh "đã có" gửi
     * đúng thư xác nhận mà Better Auth gửi ở nhánh "trống": cùng JWT `{ email: cũ, updateTo: mới, requestType:
     * 'change-email-confirmation' }` (`createEmailVerificationToken`, export public), cùng URL, qua CHÍNH callback đã
     * cấu hình (`sendChangeEmailConfirmation`, đã bọc `afterCommit`: lỗi được log + nuốt như nhánh trống,
     * `update-user.mjs:477-487`). Việc "địa chỉ đã có tài khoản" được xử lý ở bước bấm link (`auth-instance.ts`,
     * `sendVerificationEmail`). `callbackURL` đã qua `originCheckMiddleware` của router trước mọi hook.
     */
    const sendChangeConfirmation = async (
      session: HookSession,
      newEmail: string,
    ): Promise<void> => {
      const send =
        ctx.context.options.user?.changeEmail?.sendChangeEmailConfirmation;
      if (!send)
        throw new Error(
          'user.changeEmail.sendChangeEmailConfirmation is not configured (S2-R42)',
        );
      const token = await createEmailVerificationToken(
        ctx.context.secret,
        session.user.email,
        newEmail,
        ctx.context.options.emailVerification?.expiresIn,
        { requestType: CHANGE_EMAIL_CONFIRMATION },
      );
      const callbackURL = stringField(body, 'callbackURL') || '/';
      const url = `${ctx.context.baseURL}/verify-email?token=${token}&callbackURL=${encodeURIComponent(callbackURL)}`;
      await send({ user: session.user, newEmail, url, token }, ctx.request);
    };

    /**
     * S2-R76 (C2, phòng thủ chiều sâu): token đổi email (có `updateTo`: `change-email-confirmation`,
     * `change-email-verification` và nhánh cũ không `requestType`) là JWT không trạng thái, reclaim S2-R40 không thu hồi
     * được. Token phát TRƯỚC lần reclaim gần nhất của user (marker bền `auth.user_reclaim`) là do một session chưa
     * chứng minh email xin (trước S2-R76 đường một bước còn mở) → từ chối TRƯỚC khi Better Auth làm gì (nhánh
     * `change-email-verification` tạo session cho user rồi mới ghi, `email-verification.mjs:215-237`). Trả problem 400
     * thay vì redirect `callbackURL?error=`: `callbackURL` chỉ được kiểm origin trong middleware của endpoint, SAU hook.
     *
     * `iat` tính bằng giây: chỉ từ chối `iat` NHỎ HƠN giây của reclaim. Token phát cùng giây với reclaim được nhận: sau
     * S2-R76 user chưa xác thực không mint được token đổi email, nên token cùng giây chỉ có thể là của chính chủ vừa
     * xác thực. Token không có `iat` (chỉ giả được khi có secret) thì từ chối. Token sai/hết hạn: để Better Auth trả lỗi
     * của nó. Lỗi DB ném lên (fail closed, link dùng lại được).
     */
    const issuedBeforeReclaim = async (
      token: string | undefined,
    ): Promise<boolean> => {
      const payload: unknown = token
        ? await verifyJWT(token, ctx.context.secret)
        : null;
      const email = stringField(payload, 'email');
      if (!email || stringField(payload, 'updateTo') === undefined)
        return false;
      const marker = await d.lastReclaim(normalizeEmail(email));
      if (!marker) return false;
      const iat = asRecord(payload).iat;
      if (
        typeof iat === 'number' &&
        iat >= Math.floor(marker.reclaimedAt.getTime() / MS_PER_SECOND)
      )
        return false;
      d.logger.warn(
        { event: 'identity_email_change_token_refused', userId: marker.userId },
        'an email-change link issued before the account was reclaimed was refused',
      );
      return true;
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
    const verifiedOwner = requiresVerifiedOwner(ctx.path);
    const session =
      SENSITIVE.has(ctx.path) || verifiedOwner
        ? await d.session(ctx.headers ?? new Headers())
        : null;
    // S2-R76: chặn trước kiểm độ mới. Không session (ẩn danh, bước 2FA lúc đăng nhập, lời gọi server) thì đi tiếp.
    if (verifiedOwner && session && session.user.emailVerified !== true)
      return problem(ctx, new AppError(IdentityErrors.EMAIL_NOT_VERIFIED));
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
    // S2-R75: user của thao tác có thể đổi 2FA, cho đường gửi nhanh ở `after` (endpoint có thể thay session).
    if (TWO_FACTOR_CHANGE.has(ctx.path) && session)
      await d.state.setTwoFactorUser(session.user.id);
    // B4: tra email đích CHỈ khi đã có session hợp lệ và mới; ẩn danh đi tiếp để endpoint trả 401 (không oracle).
    if (ctx.path === CHANGE_EMAIL && session) {
      const newEmail = stringField(body, 'newEmail');
      const owner = newEmail
        ? await d.directory.findUserByEmail(normalizeEmail(newEmail))
        : undefined;
      // Đích là chính email của mình: để Better Auth trả 400 "Email is the same" như cũ. Session ở đây luôn của user
      // ĐÃ xác thực (S2-R76 chặn ở trên), nên đường một bước của Better Auth cho user chưa xác thực không còn.
      if (newEmail && owner && owner.id !== session.user.id) {
        await sendChangeConfirmation(session, newEmail);
        return new Response(null, { status: ACCEPTED });
      }
    }
    if (ctx.path === RESET_PASSWORD) await reclaimOnReset(body);
    if (
      ctx.path === VERIFY_EMAIL &&
      (await issuedBeforeReclaim(stringField(ctx.query, 'token')))
    )
      return problem(
        ctx,
        new AppError(IdentityErrors.INVALID_OR_EXPIRED_TOKEN),
      );
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
    // S2-R75: chỉ gửi marker mà DB đã ghi cùng câu lệnh đổi cờ; không đổi thật (vd. enable TOTP chưa verify, verify
    // khi đã bật) thì không có marker và không có thư (review M8).
    const twoFactorUser =
      !failed && TWO_FACTOR_CHANGE.has(ctx.path)
        ? await d.state.twoFactorUser()
        : null;
    if (twoFactorUser) await d.notifySecurityChange(twoFactorUser);
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
      // I2 (final review): Better Auth đổi MỌI lỗi của `createUser` thành 422 FAILED_TO_CREATE_USER; mount map theo status
      // thành `validation_failed` và client coi là input sai, không thử lại. Không có user = lỗi DB thật: lỗi hạ tầng
      // của pool auth đã ghi trong request này → 503 + Retry-After (spec §5.5 quy tắc 4), còn lại (42501, CHECK…) → 500.
      const dbFailure = recordedAuthDbFailure();
      d.logger.error(
        { event: 'signup_create_failed', dbFailure },
        'sign-up failed to create the user and no user with that email exists',
      );
      return problem(
        ctx,
        dbFailure
          ? authUnavailable(d.unavailableRetryAfterSec)
          : new AppError(CoreErrors.INTERNAL_ERROR),
      );
    }
    if (!failed && ctx.path === CHANGE_EMAIL)
      return new Response(null, { status: ACCEPTED });
    return undefined;
  });

  return { before, after };
}
