import { z } from 'zod';
import {
  type ConfigOf,
  defineConfig,
  defineProductionRule,
} from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { DEFINER_LIMIT_MAX } from './constants.js';

const MS_PER_SEC = 1000;
const SECONDS_PER_DAY = 86_400;
const MIN_GRACE_SEC = SECONDS_PER_DAY;
const MAX_GRACE_SEC = 365 * SECONDS_PER_DAY;
/** Spec SP3 §13: production giữ org xoá mềm ít nhất 7 ngày trước khi xoá cứng. */
const PRODUCTION_MIN_GRACE_SEC = 7 * SECONDS_PER_DAY;
const MAX_ORGS_PER_USER = 1000;

export const TENANCY_MEMBERSHIP_MODES = ['multi', 'single'] as const;
export const TENANCY_ORG_CREATION_MODES = [
  'self_service',
  'platform_admin',
] as const;

const positiveInt = z.coerce.number().int().positive();
// rate-limiter-flexible đếm cửa sổ theo giây nguyên (quy ước `throttle.config.ts`, INT-M6).
const windowMs = positiveInt.multipleOf(MS_PER_SEC);
const cron = z
  .string()
  .min(1)
  .refine(isValidCron, 'must be a valid cron expression');
const timezone = z
  .string()
  .min(1)
  .refine(
    (tz) => normalizeTimezone(tz) !== undefined,
    'must be an IANA timezone name',
  );

export const tenancyConfig = defineConfig(
  'tenancy',
  {
    membershipMode: 'TENANCY_MEMBERSHIP_MODE',
    orgCreation: 'TENANCY_ORG_CREATION',
    maxOrgsCreatedPerUser: 'TENANCY_MAX_ORGS_CREATED_PER_USER',
    orgDeleteGraceSec: 'TENANCY_ORG_DELETE_GRACE_SEC',
    purgeCron: 'TENANCY_ORG_PURGE_CRON',
    purgeTz: 'TENANCY_ORG_PURGE_TZ',
    purgeBatchSize: 'TENANCY_ORG_PURGE_BATCH_SIZE',
    purgeMaxBatches: 'TENANCY_ORG_PURGE_MAX_BATCHES',
    orgMissLimit: 'TENANCY_ORG_MISS_RATE_LIMIT',
    orgMissTtlMs: 'TENANCY_ORG_MISS_RATE_TTL_MS',
  },
  z.object({
    membershipMode: z
      .enum(TENANCY_MEMBERSHIP_MODES)
      .default('multi')
      .describe(
        'multi: a user may belong to many organizations; single: at most one (applies to new joins only)',
      ),
    orgCreation: z
      .enum(TENANCY_ORG_CREATION_MODES)
      .default('self_service')
      .describe(
        'Who may create organizations: any verified user, or platform admins only',
      ),
    maxOrgsCreatedPerUser: positiveInt
      .max(MAX_ORGS_PER_USER)
      .default(5)
      .describe(
        'Organizations one user may have created (soft-deleted ones count until purged)',
      ),
    orgDeleteGraceSec: positiveInt
      .min(MIN_GRACE_SEC)
      .max(MAX_GRACE_SEC)
      .default(2_592_000)
      .describe(
        'Seconds a soft-deleted organization can be restored before it is purged (production: at least 604800)',
      ),
    purgeCron: cron.default('0 3 * * *').describe('Cron of tenancy.orgs.purge'),
    purgeTz: timezone.default('UTC').describe('Timezone of the purge cron'),
    purgeBatchSize: positiveInt
      .max(DEFINER_LIMIT_MAX)
      .default(50)
      .describe('Organizations enqueued per purge batch'),
    purgeMaxBatches: positiveInt
      .max(DEFINER_LIMIT_MAX)
      .default(10)
      .describe('Max purge batches per cron run'),
    orgMissLimit: positiveInt
      .default(30)
      .describe(
        'Real organization misses (404) per window per principal before it is blocked (429)',
      ),
    orgMissTtlMs: windowMs
      .default(60_000)
      .describe(
        'Organization miss window and block duration (ms, whole seconds)',
      ),
  }),
);
export type TenancyConfig = ConfigOf<typeof tenancyConfig>;

defineProductionRule('tenancy-org-delete-grace', (c) => {
  const grace = c.tenancy?.orgDeleteGraceSec;
  if (typeof grace !== 'number')
    return 'tenancy grace rule needs the tenancy namespace';
  return grace >= PRODUCTION_MIN_GRACE_SEC
    ? undefined
    : `TENANCY_ORG_DELETE_GRACE_SEC must be at least ${PRODUCTION_MIN_GRACE_SEC} in production`;
});
/** Cùng kiểu `throttle-pre-auth-not-looser` (S2-R53 N2): so cả số lượng lẫn cửa sổ. */
defineProductionRule('tenancy-org-miss-not-looser', (c) => {
  const t = c.throttle;
  const n = c.tenancy;
  if (
    typeof t?.limit !== 'number' ||
    typeof t.ttlMs !== 'number' ||
    typeof n?.orgMissLimit !== 'number' ||
    typeof n.orgMissTtlMs !== 'number'
  )
    return 'tenancy org-miss rule needs the throttle and tenancy namespaces';
  if (n.orgMissLimit > t.limit)
    return 'TENANCY_ORG_MISS_RATE_LIMIT must be at most THROTTLE_DEFAULT_LIMIT in production';
  if (n.orgMissTtlMs < t.ttlMs)
    return 'TENANCY_ORG_MISS_RATE_TTL_MS must be at least THROTTLE_DEFAULT_TTL_MS in production';
  return undefined;
});
