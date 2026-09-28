import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';

const MS_PER_SEC = 1000;
// rate-limiter-flexible đếm cửa sổ theo giây nguyên (ADR 0007), nên không nhận phần lẻ của giây.
const windowMs = z.coerce.number().int().positive().multipleOf(MS_PER_SEC);

export const throttleConfig = defineConfig(
  'throttle',
  {
    limit: 'THROTTLE_DEFAULT_LIMIT',
    ttlMs: 'THROTTLE_DEFAULT_TTL_MS',
    preAuthLimit: 'THROTTLE_PRE_AUTH_LIMIT',
    preAuthTtlMs: 'THROTTLE_PRE_AUTH_TTL_MS',
  },
  z.object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .default(300)
      .describe(
        'Default requests per window per route per tracker (principal+org, else client IP)',
      ),
    ttlMs: windowMs
      .default(60000)
      .describe('Default rate limit window (ms, whole seconds)'),
    preAuthLimit: z.coerce
      .number()
      .int()
      .positive()
      .default(300)
      .describe(
        'Requests per window per client IP that may reach credential storage before authentication (API keys, S2-R51)',
      ),
    preAuthTtlMs: windowMs
      .default(60000)
      .describe('Pre-authentication rate limit window (ms, whole seconds)'),
  }),
);

/**
 * Giới hạn trước xác thực chặn loạt credential rác trước khi chúng chạm storage xác thực (S2-R51). Lỏng hơn giới hạn
 * mặc định của một route thì request chưa xác thực tới được storage nhiều hơn mọi traffic hợp lệ của một route. So
 * cả số lượng lẫn cửa sổ (S2-R53 N2): cùng số lượng trên cửa sổ ngắn hơn là tốc độ cao hơn (300/10s lỏng gấp 6 lần
 * 300/60s).
 */
defineProductionRule('throttle-pre-auth-not-looser', (c) => {
  const t = c.throttle;
  if (
    typeof t?.preAuthLimit !== 'number' ||
    typeof t.limit !== 'number' ||
    typeof t.preAuthTtlMs !== 'number' ||
    typeof t.ttlMs !== 'number'
  )
    return 'throttle pre-auth rule needs the throttle config namespace';
  if (t.preAuthLimit > t.limit)
    return 'THROTTLE_PRE_AUTH_LIMIT must be at most THROTTLE_DEFAULT_LIMIT in production';
  if (t.preAuthTtlMs < t.ttlMs)
    return 'THROTTLE_PRE_AUTH_TTL_MS must be at least THROTTLE_DEFAULT_TTL_MS in production';
  return undefined;
});
