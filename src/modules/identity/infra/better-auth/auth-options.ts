import { queueAfterTransactionHook } from '@better-auth/core/context';
import type { BetterAuthOptions, DBAdapterInstance } from 'better-auth';
import { APIError, isAPIError, type AuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import type { AppRole } from '../../../../core/config/index.js';
import { PG } from '../../../../core/database/index.js';
import type { AuthEmailCallbacks } from '../../application/auth-emails.js';
import { trustedOriginList } from '../../http/origin-check.js';
import {
  effectiveCookiePrefix,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../../identity.config.js';
import { safeErrorFields } from '../../identity-telemetry.js';
import type { UserDeletionGuard } from '../../ports/user-deletion-guard.js';
import { recordedAuthDbError, recordedAuthPath } from './auth-db-failures.js';
import { USER_DELETION_BLOCKED_CODE } from './auth-error.mapper.js';
import { USER_DELETION_PATHS } from './auth-hooks.js';
import { IMPERSONATION_PATHS, corePlugins } from './auth-schema.js';
import {
  GOOGLE_PROVIDER_ID,
  googleProfileMapper,
  oidcProfileMapper,
} from './profile-mapper.js';

/** Header IP do `authMountMiddleware` ghi từ `req.ip` sau khi xoá bản client gửi (spec §5.4, A.5). */
export const CLIENT_IP_HEADER = 'x-app-client-ip';

export type AuthOptionsInput = {
  identity: IdentityConfig;
  guard: IdentityGuardConfig;
  /** Chỉ api dựng provider OAuth/OIDC; worker dùng Better Auth cho 2FA/JWKS/housekeeping, không có route đó. */
  app: { serviceName: string; role: AppRole };
  corsOrigins: readonly string[];
  database: DBAdapterInstance;
  hooks: { before: AuthMiddleware; after: AuthMiddleware };
  emails: AuthEmailCallbacks;
  onUserCreated(userId: string): Promise<void>;
  onApiError(err: unknown): void;
  /** Spec SP3 §9.6 bước 3: port của tenancy (`@Optional`); vắng → không có hook `delete.before`. */
  userDeletion?: UserDeletionGuard;
  /** WARN có cấu trúc khi một lần xoá user thua đua (không PII). */
  onUserDeletionBlocked(
    reason: 'LAST_OWNER' | 'MEMBERSHIP_CREATED' | 'USER_ROW_REFERENCED',
  ): void;
  /** `args` chỉ để PHÂN LOẠI (S2-R59), không bao giờ được log: có thể chứa email/token. */
  log(level: string, message: string, args: readonly unknown[]): void;
};

/**
 * Callback email chạy SAU khi transaction của Better Auth commit (review M7). Sign-up gọi `sendVerificationEmail`
 * bên trong `runWithTransaction` (`better-auth/dist/api/routes/sign-up.mjs`), còn thư được ghi ở DB của app
 * (pool khác, commit độc lập): nếu gửi ngay, auth rollback vẫn để lại một thư có token của user không tồn tại.
 * `queueAfterTransactionHook` là cơ chế after-commit của Better Auth (cùng cơ chế chạy `databaseHooks.*.after`);
 * ngoài transaction nó chạy ngay.
 *
 * `onError` không ném lại: lỗi đã được `AuthEmails` log có cấu trúc. Ném lại sau commit sẽ biến một sign-up đã
 * commit thành 500 — khác phản hồi của nhánh email đã tồn tại (lộ email, spec §5.8). Giống hành vi gốc của
 * Better Auth (`runInBackgroundOrAwait` cũng nuốt lỗi callback).
 */
const afterCommit =
  <A extends unknown[]>(send: (...args: A) => Promise<void>) =>
  (...args: A): Promise<void> =>
    queueAfterTransactionHook(() => send(...args), {
      onError: () => undefined,
    });

const blockedDeletion = (): APIError =>
  APIError.from('CONFLICT', {
    code: USER_DELETION_BLOCKED_CODE,
    message: 'account deletion raced with an organization change',
  });
/**
 * Spec SP3 T8, DB2-M7: trên đường xoá user, `23001` từ pool `auth_user` chỉ có thể đến từ FK trỏ vào `auth."user"` từ
 * ngoài schema `auth` (identity không cần biết tên constraint của tenancy). Spike T8: lỗi pg tới `onError` NGUYÊN VẸN
 * và `log` của Kysely đã ghi cùng lỗi vào scope. Đòi CẢ HAI (fix round 1): lỗi mang 23001 mà pool auth không ghi (không
 * chứng minh được nguồn), hay lỗi khác (TypeError, bug trong `release`) sau một 23001 đã ghi, vẫn là 500 có log ERROR
 * (fail loud, spec SP3 §15) — không bao giờ bị che thành 409.
 */
const isUserRowReferenced = (err: unknown): boolean => {
  const path = recordedAuthPath();
  if (path === undefined || !USER_DELETION_PATHS.has(path)) return false;
  return (
    safeErrorFields(err).code === PG.RESTRICT_VIOLATION &&
    recordedAuthDbError()?.code === PG.RESTRICT_VIOLATION
  );
};

/** Đích lỗi của Better Auth (`onAPIError.errorURL`): cấu hình, hoặc gốc của AUTH_BASE_URL. */
export function authErrorUrl(id: IdentityConfig): string {
  if (id.errorUrl) return id.errorUrl;
  if (!id.baseUrl)
    throw new Error('AUTH_BASE_URL is required to build Better Auth options');
  return `${new URL(id.baseUrl).origin}/`;
}

/**
 * Hàm thuần (spec §5.4): mọi giá trị từ config; test đơn vị theo mode. `satisfies BetterAuthOptions` bắt sai
 * tên/kiểu option của better-auth 1.7.6 ngay ở đây mà vẫn giữ kiểu suy ra (plugin tuple) cho `betterAuth(...)`.
 */
export function buildAuthOptions(input: AuthOptionsInput) {
  const { identity: id, guard, app } = input;
  const signinRule = {
    window: guard.signinRateWindowSec,
    max: guard.signinRateMax,
  };
  const emailRule = {
    window: guard.emailRateWindowSec,
    max: guard.emailRateMax,
  };
  return {
    appName: app.serviceName,
    secret: id.secret,
    baseURL: id.baseUrl,
    basePath: id.basePath,
    trustedOrigins: trustedOriginList(input.corsOrigins, id.baseUrl),
    database: input.database,
    advanced: {
      // S2-R41: với adapter Kysely `type: 'postgres'` (`supportsUUIDs: true`), `'uuid'` TẮT việc sinh id ở app
      // (`@better-auth/core/dist/db/adapter/get-id-field.mjs`: `shouldGenerateId = !supportsUUIDs`) và bỏ id client
      // gửi, nên `DEFAULT uuidv7()` của migration luôn sinh id (v7). `crypto.randomUUID()` (v4) chỉ chạy với adapter
      // không hỗ trợ UUID (memory). Không dùng hàm sinh v7 ở app: đổi kiểu id của schema CLI (`auth-schema.ts`).
      database: { generateId: 'uuid' as const },
      useSecureCookies: id.secureCookies,
      cookiePrefix: effectiveCookiePrefix(id, app),
      // HttpOnly và Path đặt cứng (không có config tắt); SameSite từ config (bảng cookie spec §5.4).
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: id.cookieSameSite,
        path: '/',
      },
      ...(id.cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: id.cookieDomain } }
        : {}),
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Tường minh, không để mặc định (Task 40): khi thiếu, Better Auth 1.7.6 tự TẮT kiểm origin/`callbackURL`/
      // `redirectTo` và lớp CSRF thứ hai nếu `NODE_ENV=test` hoặc biến `TEST` truthy (`context/create-context.mjs`:
      // `skipOriginCheck: isTest() ? true : false`). Bảo vệ open redirect không được phụ thuộc biến môi trường.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    session: {
      expiresIn: id.sessionExpiresInSec,
      updateAge: id.sessionUpdateAgeSec,
      freshAge: id.sessionFreshAgeSec,
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: id.requireEmailVerification,
      autoSignIn: false,
      minPasswordLength: id.passwordMinLength,
      maxPasswordLength: id.passwordMaxLength,
      resetPasswordTokenExpiresIn: id.resetTokenTtlSec,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: afterCommit(input.emails.reset),
      onExistingUserSignUp: afterCommit(input.emails.existingAccount),
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: id.emailTokenTtlSec,
      sendVerificationEmail: afterCommit(input.emails.verification),
    },
    user: {
      // S2-R42: đổi email hai bước có sẵn của Better Auth (`api/routes/update-user.mjs`, `canSendConfirmation`):
      // user đã xác thực → thư xác nhận tới địa chỉ CŨ; bấm link → `verify-email` nhánh `change-email-confirmation`
      // gửi thư xác thực tới địa chỉ MỚI; bấm link đó → đổi email. User chưa xác thực thì Better Auth gửi thẳng thư
      // xác thực tới địa chỉ mới. Không bao giờ `updateEmailWithoutVerification` (review M4).
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: afterCommit(
          input.emails.changeEmailConfirmation,
        ),
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        disableImplicitLinking: id.trustedProviders.length === 0,
        allowDifferentEmails: false,
        requireLocalEmailVerified: true,
      },
    },
    socialProviders:
      app.role === 'api' && id.googleClientId && id.googleClientSecret
        ? {
            [GOOGLE_PROVIDER_ID]: {
              clientId: id.googleClientId,
              clientSecret: id.googleClientSecret,
              mapProfileToUser: googleProfileMapper(id.trustedProviders),
            },
          }
        : {},
    rateLimit: {
      enabled: guard.rateLimitEnabled,
      window: guard.rateLimitWindowSec,
      max: guard.rateLimitMax,
      storage: 'database' as const,
      customRules: {
        '/sign-in/*': signinRule,
        '/sign-up/*': signinRule,
        '/two-factor/*': {
          window: guard.twoFactorRateWindowSec,
          max: guard.twoFactorRateMax,
        },
        '/request-password-reset': emailRule,
        '/send-verification-email': emailRule,
        // Gửi thư xác thực tới địa chỉ tuỳ ý (review M5); mặc định của Better Auth (3/10 s) quá rộng.
        '/change-email': emailRule,
        // S2-R68 I1: mỗi lần bấm link xác nhận đổi email gửi một thư tới địa chỉ tuỳ ý (thư xác thực hoặc thông báo
        // cho chủ); cùng lý do với `/change-email` (review M5). Mỗi token chỉ sinh một thư (`auth-instance.ts`), nên
        // luật riêng rộng hơn luật email: người dùng bấm lại link không bị 429 sớm.
        '/verify-email': {
          window: guard.verifyEmailRateWindowSec,
          max: guard.verifyEmailRateMax,
        },
      },
    },
    plugins: [
      ...corePlugins(id, app, guard),
      ...(app.role === 'api' &&
      id.mode === 'hybrid' &&
      id.oidcProviderId &&
      id.oidcDiscoveryUrl &&
      id.oidcClientId &&
      id.oidcClientSecret
        ? [
            genericOAuth({
              config: [
                {
                  providerId: id.oidcProviderId,
                  discoveryUrl: id.oidcDiscoveryUrl,
                  clientId: id.oidcClientId,
                  clientSecret: id.oidcClientSecret,
                  scopes: id.oidcScopes,
                  // S2-R37: id_token phải verify bằng issuer + JWKS của discovery; thiếu thì provider bị bỏ (Better
                  // Auth chỉ log). Task 34/35 kiểm lúc boot rằng provider đã đăng ký, không thì dừng boot.
                  requireIdTokenVerification: true,
                  mapProfileToUser: oidcProfileMapper(
                    id.oidcProviderId,
                    id.trustedProviders,
                  ),
                },
              ],
            }),
          ]
        : []),
    ],
    disabledPaths: [...IMPERSONATION_PATHS],
    hooks: input.hooks,
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string }) => input.onUserCreated(user.id),
        },
        ...(input.userDeletion
          ? {
              delete: {
                /**
                 * Spec SP3 §9.6 bước 3: chạy SAU khi Better Auth đã xoá session và account; chỉ dọn tenancy. Đua
                 * (membership mới, owner cuối) → 409 có tên, body nói credential đã bị gỡ (runbook), không 500.
                 */
                before: async (user: { id: string }) => {
                  const guard = input.userDeletion;
                  if (!guard) return;
                  const r = await guard.release(user.id);
                  switch (r.kind) {
                    case 'RELEASED':
                      return;
                    case 'BLOCKED_RACE':
                      input.onUserDeletionBlocked(r.reason);
                      throw blockedDeletion();
                    default: {
                      const unknown: never = r;
                      throw new Error(
                        `unknown user deletion release ${JSON.stringify(unknown)}`,
                      );
                    }
                  }
                },
              },
            }
          : {}),
      },
    },
    onAPIError: {
      // Task 40 M6: tường minh, không phụ thuộc môi trường. Thiếu option này thì `/error` của Better Auth 1.7.6
      // (`api/routes/error.mjs`) trả 302 `/?error=` ở production nhưng một trang HTML ở dev/test, và callback OAuth
      // lỗi đi qua `${baseURL}/error`. `AUTH_ERROR_URL` (đã kiểm nằm trên origin tin cậy) hoặc gốc của AUTH_BASE_URL.
      errorURL: authErrorUrl(id),
      throw: false,
      /**
       * Lỗi KHÔNG phải `APIError` (lỗi DB, bug): Better Auth chỉ gọi hook này rồi để better-call 1.x rơi xuống
       * `console.error('# SERVER_ERROR: ', error)` (`better-call/dist/router.mjs`) — in nguyên lỗi (message, stack,
       * `detail` của pg có thể chứa email) ra stderr, ngoài pino và redaction (Task 40 fix round 1, spec §5.14).
       * Ném một `APIError` 500 trống thay thế: better-call trả nó thành response 500 (mount vẫn probe → 503/500 như
       * cũ), không in gì. Lớp lỗi gốc đã được `onApiError` log có cấu trúc.
       */
      onError: (err: unknown) => {
        // Spec SP3 T8: đổi TRƯỚC khi log/đếm 5xx, để đua với xoá tài khoản không thành "lỗi không giải thích được".
        if (isUserRowReferenced(err)) {
          input.onUserDeletionBlocked('USER_ROW_REFERENCED');
          throw blockedDeletion();
        }
        input.onApiError(err);
        if (!isAPIError(err)) throw new APIError('INTERNAL_SERVER_ERROR');
      },
    },
    // `...args` của Better Auth có thể chứa email/token (spec §5.14): chỉ chuyển để phân loại mức log (S2-R59).
    logger: {
      log: (level: string, message: string, ...args: unknown[]) =>
        input.log(level, message, args),
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}
