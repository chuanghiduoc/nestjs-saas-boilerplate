import { apiKey } from '@better-auth/api-key';
import { admin, bearer, jwt, twoFactor } from 'better-auth/plugins';
import {
  effectiveJwtAudience,
  effectiveJwtIssuer,
  effectiveTwoFactorIssuer,
  type IdentityConfig,
} from '../../identity.config.js';

export const AUTH_SCHEMA = 'auth';
export const LOGIN_ATTEMPTS_TABLE = 'login_attempts';
/** Tên bảng thật theo output `auth generate` (spike S3) + bảng lockout của mình. */
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
export function corePlugins(id: IdentityConfig, app: { serviceName: string }) {
  return tuple(
    twoFactor({
      issuer: effectiveTwoFactorIssuer(id, app),
      backupCodeOptions: { storeBackupCodes: 'encrypted' },
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
    }),
    admin({ adminRoles: [ADMIN_ROLE], defaultRole: DEFAULT_ROLE }),
  );
}

export function schemaOptions(
  id: IdentityConfig,
  app: { serviceName: string },
) {
  return {
    plugins: corePlugins(id, app),
    emailAndPassword: { enabled: true },
    rateLimit: { storage: 'database' as const },
    // Nhánh (A) của S3: Better Auth để DB sinh id (`DEFAULT uuidv7()` trong migration, ADR 0009).
    advanced: { database: { generateId: 'uuid' as const } },
  };
}
