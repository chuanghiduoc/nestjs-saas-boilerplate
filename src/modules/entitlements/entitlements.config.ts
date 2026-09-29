import { z } from 'zod';
import { type ConfigOf, defineConfig } from '../../core/config/index.js';
import { normalizeTimezone } from '../../core/scheduler/index.js';

const MIN_RETRY_AFTER_SEC = 1;
const MAX_RETRY_AFTER_SEC = 60;

/** Spec SP4 §14 (R-X10): mặc định khởi động được ở cả ba AUTH_MODE với env hiện có; không trường secret (R-X16). */
export const entitlementsConfig = defineConfig(
  'entitlements',
  {
    quotaTimezone: 'ENTITLEMENTS_QUOTA_TIMEZONE',
    rowMissingRetryAfterSec: 'ENTITLEMENTS_ROW_MISSING_RETRY_AFTER_SEC',
  },
  z.object({
    quotaTimezone: z
      .string()
      .min(1)
      .refine(
        (tz) => normalizeTimezone(tz) !== undefined,
        'must be an IANA timezone name',
      )
      .default('Asia/Ho_Chi_Minh')
      .describe(
        'IANA timezone of the calendar month of MONTH quotas; changing it restarts the running period at zero (change it at a month start)',
      ),
    rowMissingRetryAfterSec: z.coerce
      .number()
      .int()
      .min(MIN_RETRY_AFTER_SEC)
      .max(MAX_RETRY_AFTER_SEC)
      .default(5)
      .describe(
        'Retry-After (seconds) of the 503 answered while an organization has no entitlement row yet',
      ),
  }),
);
export type EntitlementsConfig = ConfigOf<typeof entitlementsConfig>;
