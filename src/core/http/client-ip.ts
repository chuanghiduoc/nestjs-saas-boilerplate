import { DEFAULT_IPV6_SUBNET_PREFIX, normalizeIp } from '@nestjs/throttler';

/**
 * Khoá rate limit theo IP client, dùng chung cho `AppThrottlerGuard` và `PreAuthRateLimiter`: `req.ip` (đã áp
 * HTTP_TRUST_PROXY) gom IPv6 theo subnet /64 như `ThrottlerGuard#getTracker` của @nestjs/throttler.
 */
export function clientIpTracker(ip: unknown): string {
  if (typeof ip !== 'string' || !ip)
    throw new Error('Cannot determine client IP for rate limiting');
  return `ip:${normalizeIp(ip, DEFAULT_IPV6_SUBNET_PREFIX)}`;
}
