export const AUTH_PURGE_TARGETS = [
  'session',
  'verification',
  'rate_limit',
  'login_attempts',
] as const;
export type AuthPurgeTarget = (typeof AUTH_PURGE_TARGETS)[number];

/** Dọn dữ liệu hết hạn của schema auth theo lô (spec cha §6). */
export abstract class AuthHousekeeping {
  abstract purgeExpired(
    target: AuthPurgeTarget,
    limit: number,
  ): Promise<number>;
}
