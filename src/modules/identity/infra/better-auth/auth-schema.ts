import { apiKey } from '@better-auth/api-key';
import { admin, bearer, jwt, twoFactor } from 'better-auth/plugins';
import {
  effectiveJwtAudience,
  effectiveJwtIssuer,
  effectiveTwoFactorIssuer,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../../identity.config.js';

export const AUTH_SCHEMA = 'auth';
export const LOGIN_ATTEMPTS_TABLE = 'login_attempts';
/** S2-R76: marker bền của lần reclaim gần nhất (`Migration20260928072715_user_reclaim`, `unverified-links.ts`). */
export const USER_RECLAIM_TABLE = 'user_reclaim';
/** S2-R75: marker bền của thông báo bảo mật (`Migration20260928082958_security_notice`, `pg-security-notice-ledger.ts`). */
export const SECURITY_NOTICE_TABLE = 'security_notice';
/** Spec SP3 §5.2 (3D): dấu step-up 2FA trong session (`Migration…_session_second_factor`, `staff-step-up.ts`). */
export const SESSION_SECOND_FACTOR_TABLE = 'session_second_factor';
/** Tên bảng thật theo output `auth generate` (spike S3) + bảng lockout, marker reclaim và marker thông báo của mình. */
export const AUTH_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'two_factor',
  'apikey',
  'jwks',
  'rate_limit',
  LOGIN_ATTEMPTS_TABLE,
  USER_RECLAIM_TABLE,
  SECURITY_NOTICE_TABLE,
  SESSION_SECOND_FACTOR_TABLE,
] as const;
export const ADMIN_ROLE = 'admin';
export const DEFAULT_ROLE = 'user';
/** D7: impersonation tắt. */
export const IMPERSONATION_PATHS = [
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
] as const;

/**
 * Tuple có thể ghi, giữ kiểu chính xác của từng plugin (để `auth.api.*` có kiểu endpoint). `as const` cho tuple
 * `readonly`, mà `BetterAuthOptions.plugins` đòi mảng ghi được; hàm này suy tuple mà không cần ép kiểu.
 */
const tuple = <T extends unknown[]>(...items: T): T => items;

/**
 * Plugin có ảnh hưởng tới schema. Dùng chung cho CLI (`auth generate`, `auth check schema` ở CI) và runtime,
 * để hai nơi không lệch. `genericOAuth` không có bảng riêng nên chỉ thêm ở runtime (Task 33).
 */
export function corePlugins(
  id: IdentityConfig,
  app: { serviceName: string },
  guard: IdentityGuardConfig,
) {
  return tuple(
    twoFactor({
      issuer: effectiveTwoFactorIssuer(id, app),
      backupCodeOptions: { storeBackupCodes: 'encrypted' },
      // S2-R6 (Task 34 fix round 1, S2-R44 I3): khoá 2FA theo tài khoản DUY NHẤT là khoá có sẵn của plugin, lấy
      // ngưỡng từ config (mặc định thư viện 10 lần / 900 s nằm ngoài `defineConfig`). Đã kiểm 1.7.6:
      // - lưu ở DB: cột `two_factor.failed_verification_count`/`locked_until`, tăng nguyên tử bằng `incrementOne`
      //   (`plugins/two-factor/verify-two-factor.mjs`, `recordTwoFactorFailure`);
      // - fail closed: lỗi DB ở `assertTwoFactorNotLocked`/`recordTwoFactorFailure` ném lên (không bao giờ cho qua),
      //   khoá được kiểm TRƯỚC khi thử mã (`totp/index.mjs:184`, `backup-codes/index.mjs:198`, `otp/index.mjs:213`);
      // - cấu hình được: `accountLockout.{enabled,maxFailedAttempts,durationSeconds}` (`types.d.mts:71-88`).
      // Chỉ áp cho bước 2FA khi đăng nhập (`isSignIn`); lúc bật 2FA user đã có session mới (kiểm độ mới).
      accountLockout: {
        enabled: true,
        maxFailedAttempts: guard.lockoutMaxFailures,
        durationSeconds: guard.lockoutBlockSec,
      },
    }),
    bearer(),
    apiKey({
      apiKeyHeaders: [id.apiKeyHeader],
      references: 'user',
      enableSessionForAPIKeys: false,
      // Đơn vị GIÂY: plugin tính `getDate(defaultExpiresIn, "sec")` (dist/index.mjs, review I3).
      keyExpiration: { defaultExpiresIn: id.apiKeyDefaultExpiresInSec },
      // Mặc định plugin bật 10 request/ngày/key (lưu đếm trong bảng apikey, mỗi request một UPDATE): API key
      // máy gần như không dùng được. Tắt; giới hạn tốc độ theo principal do throttler Nest của SP1 đảm nhận
      // (`AppThrottlerGuard` đếm theo principal khi có). Test: Task 39 (> 10 request liên tiếp đều 200).
      rateLimit: { enabled: false },
    }),
    jwt({
      // `expirationTime` là số thì bị hiểu là mốc thời gian tuyệt đối (plugins/jwt/types.d.mts): truyền "<n>s".
      jwt: {
        issuer: effectiveJwtIssuer(id),
        audience: effectiveJwtAudience(id),
        expirationTime: `${id.jwtExpiresInSec}s`,
      },
      jwks: {
        rotationInterval: id.jwksRotationIntervalSec,
        gracePeriod: id.jwksGracePeriodSec,
      },
      // JWT chỉ lấy qua `/token` (spec §5.6.4). Mặc định plugin ký một JWT ở MỌI `/get-session`, kể cả
      // `auth.api.getSession` của `BetterAuthProvider` trên từng request Nest (header bị bỏ): thêm một lookup
      // JWKS + giải mã private key + ký mỗi request, và JWKS hỏng thì mọi xác thực session thành 500.
      disableSettingJwtHeader: true,
    }),
    // Spec SP3 §5.2: KHÔNG thêm `adminUserIds` hay `roles`: pre-check xoá user ở `hooks.before` dùng `hasAdminRole`, chỉ
    // khớp `hasPermission` của plugin với access control mặc định (ghim ở `admin-plugin-config.spec.ts`).
    admin({ adminRoles: [ADMIN_ROLE], defaultRole: DEFAULT_ROLE }),
  );
}

export function schemaOptions(
  id: IdentityConfig,
  app: { serviceName: string },
  guard: IdentityGuardConfig,
) {
  return {
    plugins: corePlugins(id, app, guard),
    emailAndPassword: { enabled: true },
    rateLimit: { storage: 'database' as const },
    // Nhánh (A) của S3: Better Auth để DB sinh id (`DEFAULT uuidv7()` trong migration, ADR 0009).
    advanced: { database: { generateId: 'uuid' as const } },
  };
}
