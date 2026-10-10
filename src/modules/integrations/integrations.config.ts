import { z } from 'zod';
import {
  type ConfigOf,
  defineConfig,
  defineConfigRule,
  numberAt,
} from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { DEFINER_LIMIT_MAX } from '../../core/sweep/index.js';
import {
  WEBHOOKS_OUT,
  WEBHOOK_EVENT_TYPES_MAX,
  WEBHOOK_LEASE_MARGIN_MS,
  WEBHOOK_RETENTION_MIN_MONTHS,
} from './constants.js';

const SECONDS_PER_DAY = 86_400;
/** Luật `PURGE_DELAY ≥ (RETENTION_MONTHS + 1) × 31 ngày` (spec §7.3, §11.4): 31 là số ngày tối đa của một tháng. */
const MAX_DAYS_PER_MONTH = 31;
const MAX_SCHEDULE_STEPS = 20;
const MAX_ENDPOINTS_PER_ORG = 100;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OVERLAP_SEC = 604_800;
const MAX_RETENTION_MONTHS = 24;
const MAX_PREMAKE_MONTHS = 12;
const MAX_LOCAL_FAULT_RETRY_SEC = 3600;
/** Trần vận hành của R-X35: quá trăm lần lỗi của ta liên tiếp là sự cố, không phải nhiễu. */
const MAX_LOCAL_FAILURES = 100;

const positiveInt = z.coerce.number().int().positive();
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
const csvSeconds = z
  .string()
  .default('5,300,1800,7200,18000,36000,36000')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number),
  )
  .pipe(
    z
      .array(z.number().int().min(1).max(SECONDS_PER_DAY))
      .min(1)
      .max(MAX_SCHEDULE_STEPS),
  );

export const integrationsConfig = defineConfig(
  'integrations',
  {
    maxEndpointsPerOrg: 'INTEGRATIONS_MAX_ENDPOINTS_PER_ORG',
    maxEventTypesPerEndpoint: 'INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT',
    webhookTimeoutMs: 'INTEGRATIONS_WEBHOOK_TIMEOUT_MS',
    deliveryLeaseMs: 'INTEGRATIONS_DELIVERY_LEASE_MS',
    retryScheduleSec: 'INTEGRATIONS_RETRY_SCHEDULE_SEC',
    endpointDisableAfterSec: 'INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC',
    secretRotationOverlapSec: 'INTEGRATIONS_SECRET_ROTATION_OVERLAP_SEC',
    deliveryRetentionMonths: 'INTEGRATIONS_DELIVERY_RETENTION_MONTHS',
    partitionPremakeMonths: 'INTEGRATIONS_PARTITION_PREMAKE_MONTHS',
    endpointPurgeDelaySec: 'INTEGRATIONS_ENDPOINT_PURGE_DELAY_SEC',
    recoverBatchMax: 'INTEGRATIONS_RECOVER_BATCH_MAX',
    killedRecheckSec: 'INTEGRATIONS_KILLED_RECHECK_SEC',
    localFaultRetrySec: 'INTEGRATIONS_LOCAL_FAULT_RETRY_SEC',
    maxLocalFailures: 'INTEGRATIONS_MAX_LOCAL_FAILURES',
    maxInflightPerEndpoint: 'INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT',
    bulkheadLimit: 'INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT',
    bulkheadQueue: 'INTEGRATIONS_WEBHOOK_BULKHEAD_QUEUE',
    sweepCron: 'INTEGRATIONS_SWEEP_CRON',
    sweepTz: 'INTEGRATIONS_SWEEP_TZ',
    sweepBatchSize: 'INTEGRATIONS_SWEEP_BATCH_SIZE',
    sweepMaxBatches: 'INTEGRATIONS_SWEEP_MAX_BATCHES',
    sweepGraceSec: 'INTEGRATIONS_SWEEP_GRACE_SEC',
    sweepRequeueMaxPerOrg: 'INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG',
  },
  z
    .object({
      maxEndpointsPerOrg: positiveInt
        .max(MAX_ENDPOINTS_PER_ORG)
        .default(10)
        .describe(
          'Webhook endpoints per organization (deleted ones do not count)',
        ),
      maxEventTypesPerEndpoint: positiveInt
        .max(WEBHOOK_EVENT_TYPES_MAX)
        .default(WEBHOOK_EVENT_TYPES_MAX)
        .describe(
          `Event types one endpoint may subscribe to (at most ${WEBHOOK_EVENT_TYPES_MAX}, the published API limit)`,
        ),
      webhookTimeoutMs: positiveInt
        .min(MIN_TIMEOUT_MS)
        .max(MAX_TIMEOUT_MS)
        .default(5000)
        .describe(
          'Timeout of one webhook request (must be below INTEGRATIONS_DELIVERY_LEASE_MS)',
        ),
      deliveryLeaseMs: positiveInt
        .default(60_000)
        .describe(
          'Lease of a delivery being sent; an expired lease is retried as our fault',
        ),
      retryScheduleSec: csvSeconds.describe(
        'Comma-separated retry delays in seconds after each failed attempt (1-20 steps of 1-86400)',
      ),
      endpointDisableAfterSec: positiveInt
        .default(432_000)
        .describe(
          'An endpoint failing this long without a success is disabled (must cover the retry schedule)',
        ),
      secretRotationOverlapSec: z.coerce
        .number()
        .int()
        .min(0)
        .max(MAX_OVERLAP_SEC)
        .default(86_400)
        .describe(
          'Seconds the previous signing secret keeps signing after a rotation',
        ),
      deliveryRetentionMonths: positiveInt
        .min(WEBHOOK_RETENTION_MIN_MONTHS)
        .max(MAX_RETENTION_MONTHS)
        .default(1)
        .describe(
          'Months of webhook messages and deliveries kept (whole months, partition drop)',
        ),
      partitionPremakeMonths: positiveInt
        .max(MAX_PREMAKE_MONTHS)
        .default(3)
        .describe(
          'Future monthly partitions kept ready for the webhook tables',
        ),
      endpointPurgeDelaySec: positiveInt
        .default(5_356_800)
        .describe(
          'Seconds after a soft delete before an endpoint row is removed',
        ),
      recoverBatchMax: positiveInt
        .default(1000)
        .describe('Deliveries re-queued by one recover call'),
      killedRecheckSec: positiveInt
        .default(60)
        .describe(
          'Recheck delay of a delivery while the integrations.webhook_delivery kill switch is on',
        ),
      localFaultRetrySec: positiveInt
        .max(MAX_LOCAL_FAULT_RETRY_SEC)
        .default(30)
        .describe(
          'Retry delay after a fault on our side (bulkhead, breaker, lost lease, unreadable secret, endpoint busy)',
        ),
      maxLocalFailures: positiveInt
        .max(MAX_LOCAL_FAILURES)
        .default(5)
        .describe(
          'Faults on our side one delivery may hit before it is exhausted (recoverable with retry/recover)',
        ),
      maxInflightPerEndpoint: positiveInt
        .default(4)
        .describe(
          'Deliveries one endpoint may have in flight at once (must be below INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT)',
        ),
      bulkheadLimit: positiveInt
        .default(20)
        .describe(
          'Concurrent webhook requests per process (at least the webhooks-out queue concurrency)',
        ),
      bulkheadQueue: z.coerce
        .number()
        .int()
        .min(0)
        .default(100)
        .describe('Queued webhook requests per process'),
      sweepCron: cron
        .default('*/5 * * * *')
        .describe('Cron of integrations.sweep-orgs'),
      sweepTz: timezone
        .default('UTC')
        .describe('Timezone of the integrations sweep cron'),
      sweepBatchSize: positiveInt
        .max(DEFINER_LIMIT_MAX)
        .default(100)
        .describe('Organizations per sweep batch'),
      sweepMaxBatches: positiveInt
        .default(20)
        .describe('Max sweep batches per cron run'),
      sweepGraceSec: positiveInt
        .max(SECONDS_PER_DAY)
        .default(120)
        .describe(
          'A delivery overdue or a lease expired by more than this is taken over by the sweep',
        ),
      sweepRequeueMaxPerOrg: positiveInt
        .max(DEFINER_LIMIT_MAX)
        .default(100)
        .describe(
          'Overdue deliveries, expired leases and due endpoint deletes handled per organization per sweep pass',
        ),
    })
    .superRefine((c, ctx) => {
      if (c.webhookTimeoutMs >= c.deliveryLeaseMs)
        ctx.addIssue({
          code: 'custom',
          path: ['webhookTimeoutMs'],
          message: 'must be below INTEGRATIONS_DELIVERY_LEASE_MS',
        });
      // R-X35: bằng hoặc hơn bulkhead của process thì một endpoint chết vẫn chiếm hết slot — trần in-flight mất nghĩa.
      if (c.maxInflightPerEndpoint >= c.bulkheadLimit)
        ctx.addIssue({
          code: 'custom',
          path: ['maxInflightPerEndpoint'],
          message: 'must be below INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT',
        });
      const total = c.retryScheduleSec.reduce((a, b) => a + b, 0);
      if (c.endpointDisableAfterSec < total)
        ctx.addIssue({
          code: 'custom',
          path: ['endpointDisableAfterSec'],
          message: `must be at least the sum of the retry schedule (${total})`,
        });
      const minPurge =
        (c.deliveryRetentionMonths + 1) * MAX_DAYS_PER_MONTH * SECONDS_PER_DAY;
      if (c.endpointPurgeDelaySec < minPurge)
        ctx.addIssue({
          code: 'custom',
          path: ['endpointPurgeDelaySec'],
          message: `must be at least ${minPurge} ((retention months + 1) x 31 days)`,
        });
    }),
);
export type IntegrationsConfig = ConfigOf<typeof integrationsConfig>;

/**
 * Spec §11.4 `webhooks-bulkhead-covers-concurrency`: mỗi job gửi đúng một request, nên với bulkhead ≥ concurrency của queue
 * `webhooks-out` một process không bao giờ nhận `bulkhead_full`. Tính cả override của người vận hành
 * (`RESILIENCE_OVERRIDES.webhooks-out.bulkheadLimit` thắng default của provider; `QUEUE_CONCURRENCY_OVERRIDES` webhooks-out=n).
 * `queue` và `resilience` là namespace core (luôn có); luật đăng ký lúc import file này, tức chỉ khi module integrations bật.
 */
defineConfigRule('webhooks-bulkhead-covers-concurrency', (c) => {
  const own = numberAt(c, 'integrations', 'bulkheadLimit');
  const io = numberAt(c, 'queue', 'ioConcurrency');
  if (own === undefined || io === undefined)
    return 'webhooks bulkhead rule needs the integrations and queue namespaces';
  const limit =
    numberAt(c, 'resilience', 'overrides', WEBHOOKS_OUT, 'bulkheadLimit') ??
    own;
  const concurrency =
    numberAt(c, 'queue', 'concurrencyOverrides', WEBHOOKS_OUT) ?? io;
  return limit >= concurrency
    ? undefined
    : `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT (${limit}) must be at least the concurrency of queue ${WEBHOOKS_OUT} (${concurrency}); set RESILIENCE_OVERRIDES/QUEUE_CONCURRENCY_OVERRIDES consistently`;
});

/**
 * I1 (review bảo mật 6C): `ResiliencePolicies` áp `RESILIENCE_OVERRIDES.webhooks-out` SAU default của provider, nên timeout
 * thật của request có thể lớn hơn `INTEGRATIONS_WEBHOOK_TIMEOUT_MS` mà luật của schema không thấy. Timeout thật phải nhỏ hơn
 * lease trừ `WEBHOOK_LEASE_MARGIN_MS`, nếu không lease hết hạn giữa lúc request còn bay (gửi hai lần, vượt trần in-flight).
 */
defineConfigRule('webhooks-timeout-below-lease', (c) => {
  const own = numberAt(c, 'integrations', 'webhookTimeoutMs');
  const lease = numberAt(c, 'integrations', 'deliveryLeaseMs');
  if (own === undefined || lease === undefined)
    return 'webhooks timeout rule needs the integrations namespace';
  const timeout =
    numberAt(c, 'resilience', 'overrides', WEBHOOKS_OUT, 'timeoutMs') ?? own;
  return timeout < lease - WEBHOOK_LEASE_MARGIN_MS
    ? undefined
    : `the webhooks-out timeout (${timeout} ms, INTEGRATIONS_WEBHOOK_TIMEOUT_MS or RESILIENCE_OVERRIDES.${WEBHOOKS_OUT}.timeoutMs) must be below INTEGRATIONS_DELIVERY_LEASE_MS (${lease}) minus ${WEBHOOK_LEASE_MARGIN_MS} ms`;
});
