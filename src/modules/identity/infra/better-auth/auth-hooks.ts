import type { Logger } from '@nestjs/common';
import {
  createAuthMiddleware,
  isAPIError,
  type AuthMiddleware,
} from 'better-auth/api';
import { createHash } from 'node:crypto';
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
import type { ReclaimTrigger } from './unverified-links.js';

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
const TWO_FACTOR_COOKIE = 'two_factor';
/** Identifier của token đặt lại mật khẩu (`better-auth/dist/api/routes/password.mjs`, `resetPassword`). */
const RESET_IDENTIFIER_PREFIX = 'reset-password:';
const FAILED_TO_CREATE_USER = 'FAILED_TO_CREATE_USER';
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

/** Session mà hook cần; đọc qua `auth.api.getSession` để header `Authorization: Bearer` cũng được tính. */
export type HookSession = {
  user: { id: string; twoFactorEnabled?: boolean | null | undefined };
  session: { id: string; createdAt: Date };
};

export type AuthHookDeps = {
  freshAgeSec: number;
  unavailableRetryAfterSec: number;
  lockout: LoginLockout;
  state: AuthRequestState;
  emails: AuthEmails;
  directory: IdentityDirectory;
  /**
   * Session của request. KHÔNG dùng `getSessionFromCtx`: hook của mình chạy TRƯỚC hook `before` của plugin
   * `bearer`, và header cookie mà `bearer` dựng chỉ được áp sau khi mọi hook `before` chạy xong
   * (`better-auth/dist/api/dispatch.mjs`, `runBeforeHooks`), nên `getSessionFromCtx` không thấy session bearer (bỏ
   * qua kiểm độ mới cho mobile) và còn cache `null` vào `ctx.context.session`.
   */
  session(headers: Headers): Promise<HookSession | null>;
  /** S2-R40 cho nhánh đặt lại mật khẩu (nhánh link xác thực dùng `beforeEmailVerification`, `auth-instance.ts`). */
  reclaim(userId: string, trigger: ReclaimTrigger): Promise<void>;
  requestId(): string;
  problemTypeBase: string;
  logger: Pick<Logger, 'error'>;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {};
const stringField = (v: unknown, key: string): string | undefined => {
  const r = asRecord(v)[key];
  return typeof r === 'string' ? r : undefined;
};
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/**
 * `AuthEmails` đã log có cấu trúc (không PII) và tăng `identity_auth_email_request_failed_total` trước khi ném lại.
 * Ở đây không ném tiếp: thông báo hỏng không được biến một thao tác đã thành công thành lỗi, và ở nhánh chống dò
 * email (sign-up, change-email) một lỗi chỉ có ở nhánh "email đã có" sẽ lộ email tồn tại (spec §5.8). Cùng cách
 * `afterCommit` của `auth-options.ts` xử lý callback email của Better Auth.
 */
const notify = (sent: Promise<void>): Promise<void> =>
  sent.catch(() => undefined);

export function createAuthHooks(d: AuthHookDeps): {
  before: AuthMiddleware;
  after: AuthMiddleware;
} {
  const problem = (path: string, err: AppError) =>
    new Response(
      JSON.stringify(
        problemBody(
          err,
          {
            instance: path,
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

  /** consume TRƯỚC khi xác minh (spec §5.7); bị khoá → 429, storage lỗi → 503, không bao giờ cho qua. */
  const guard = async (
    path: string,
    scope: LockoutScope,
  ): Promise<Response | undefined> => {
    try {
      await d.state.addTicket(await d.lockout.guard(scope));
      return undefined;
    } catch (err) {
      if (err instanceof LockoutBlockedError)
        return problem(
          path,
          mapAuthError(
            {
              status: TOO_MANY_REQUESTS,
              retryAfter: String(err.retryAfterSec),
              path,
            },
            { unavailableRetryAfterSec: d.unavailableRetryAfterSec },
          ),
        );
      if (err instanceof LockoutUnavailableError)
        return problem(path, authUnavailable(d.unavailableRetryAfterSec));
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
  const nameProblem = (path: string, name: string): Response | undefined => {
    const parsed = displayName.safeParse(name);
    if (parsed.success) return undefined;
    const fields = zodIssuesToFields(
      parsed.error.issues.map((i) => ({ ...i, path: [NAME_FIELD, ...i.path] })),
    );
    return problem(
      path,
      new AppError(CoreErrors.VALIDATION_FAILED, { fields }),
    );
  };
  const before = createAuthMiddleware(async (ctx) => {
    /**
     * Khoá 2FA theo user (S4b): cookie `two_factor` đã ký trỏ tới bản ghi verification mà `value` là user id. Luồng
     * bật 2FA (đã đăng nhập) không có cookie đó thì dùng user của session. Không đọc được cả hai thì khoá theo băm
     * của cookie: vẫn chặn brute force trên lần đăng nhập đó.
     */
    const twoFactorSubject = async (
      session: HookSession | null,
    ): Promise<string> => {
      const name = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name;
      const identifier = await ctx.getSignedCookie(name, ctx.context.secret);
      const pending = identifier
        ? await ctx.context.internalAdapter.findVerificationValue(identifier)
        : null;
      if (pending?.value) return `user:${pending.value}`;
      if (session) return `user:${session.user.id}`;
      return `cookie:${sha256(ctx.getCookie(name) ?? '')}`;
    };
    /** Token đặt lại mật khẩu hợp lệ = chủ email đã được chứng minh (S2-R40); chạy TRƯỚC khi Better Auth tiêu thụ token. */
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
      const invalid = nameProblem(ctx.path, name);
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
        ctx.path,
        new AppError(IdentityErrors.REAUTHENTICATION_REQUIRED),
      );
    if (ctx.path === SIGN_IN) {
      const blocked = await guard(ctx.path, {
        kind: 'signin',
        email: stringField(body, 'email') ?? '',
      });
      if (blocked) return blocked;
    }
    if (TWO_FACTOR_VERIFY.has(ctx.path)) {
      const blocked = await guard(ctx.path, {
        kind: '2fa',
        subject: await twoFactorSubject(session),
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
    if (!failed && (ctx.path === SIGN_IN || TWO_FACTOR_VERIFY.has(ctx.path)))
      // S2-R35: `refund` không bao giờ ném (tự log + metric).
      for (const t of await d.state.takeTickets()) await d.lockout.refund(t);
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
      // I5: hai đăng ký song song → UNIQUE(email) → Better Auth trả FAILED_TO_CREATE_USER (không cause). Tra lại:
      // có user thì đây là "email đã có" → thông báo + cùng 202 (spec §5.8). Không có thì giữ lỗi (lỗi DB thật).
      const code = isAPIError(returned)
        ? stringField(returned.body, 'code')
        : undefined;
      if (
        code === FAILED_TO_CREATE_USER &&
        (await noticeIfExists(stringField(ctx.body, 'email')))
      )
        return new Response(null, { status: ACCEPTED });
      return undefined;
    }
    if (!failed && ctx.path === CHANGE_EMAIL)
      return new Response(null, { status: ACCEPTED });
    return undefined;
  });

  return { before, after };
}
