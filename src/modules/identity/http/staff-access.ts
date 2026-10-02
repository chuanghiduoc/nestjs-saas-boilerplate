import type { AuthMode, IdentityConfig } from '../identity.config.js';
import type { AuthResult } from '../ports/auth-provider.js';

const MS_PER_SECOND = 1000;

/**
 * Cùng luật `@RequireFreshSession()` ở external (SP3 §11, SEC-I6): thiếu `auth_time` → không tươi; không fallback `iat`.
 * Dùng chung cho `PlatformStaffGuard` và Bull Board (review M-1: cùng một định nghĩa, addendum A1.2).
 */
export function isAuthTimeFresh(
  auth: AuthResult,
  identity: Pick<
    IdentityConfig,
    'sessionFreshAgeSec' | 'externalClockToleranceSec'
  >,
  now: number = Date.now(),
): boolean {
  if (auth.kind !== 'AUTHENTICATED' || auth.authenticatedAt === undefined)
    return false;
  const ageMs = now - auth.authenticatedAt.getTime();
  return (
    ageMs <= identity.sessionFreshAgeSec * MS_PER_SECOND &&
    ageMs >= -identity.externalClockToleranceSec * MS_PER_SECOND
  );
}

export type StaffAccessDecision =
  | 'ALLOW'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SECOND_FACTOR_REQUIRED'
  | 'REAUTHENTICATION_REQUIRED'
  | 'CHECK_TOTP_MARK';

/**
 * Addendum A1.2: "session nhân viên được dùng quyền nền tảng" — cùng định nghĩa với gate (3) của hook và Bull Board. Hàm
 * thuần; guard gọi lại với `totpMarkFresh` khi lần đầu trả `CHECK_TOTP_MARK` (chỉ nhánh local/hybrid của nhân viên chạm
 * pool auth, PSA-7).
 */
export function decideStaffAccess(i: {
  auth: AuthResult;
  mode: AuthMode;
  totpMarkFresh?: boolean;
  authTimeFresh?: boolean;
}): StaffAccessDecision {
  const a = i.auth;
  switch (a.kind) {
    case 'ANONYMOUS':
    case 'REJECTED':
    case 'EMAIL_NOT_VERIFIED':
    case 'UNAVAILABLE':
      return 'UNAUTHENTICATED';
    case 'AUTHENTICATED':
      break;
    default: {
      const unknown: never = a;
      throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
    }
  }
  if (!a.isPlatformAdmin) return 'FORBIDDEN';
  switch (a.credential.kind) {
    case 'API_KEY':
    case 'ORG_API_KEY':
      return 'FORBIDDEN';
    case 'SESSION_COOKIE':
    case 'BEARER_SESSION':
      if (i.mode === 'external') return 'FORBIDDEN';
      if (i.totpMarkFresh === undefined) return 'CHECK_TOTP_MARK';
      return i.totpMarkFresh ? 'ALLOW' : 'SECOND_FACTOR_REQUIRED';
    case 'EXTERNAL_COOKIE':
    case 'EXTERNAL_BEARER':
      if (i.mode !== 'external') return 'FORBIDDEN';
      return i.authTimeFresh === true ? 'ALLOW' : 'REAUTHENTICATION_REQUIRED';
    default: {
      const unknown: never = a.credential.kind;
      throw new Error(`unknown credential kind ${String(unknown)}`);
    }
  }
}
