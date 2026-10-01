/** Đúng lúc `expires_at` là đã hết hạn: khớp predicate SQL `expires_at > clock_timestamp()` của CAS (spec §3.15). */
export const isLapsed = (expiresAt: Date, now: Date): boolean =>
  expiresAt.getTime() <= now.getTime();
