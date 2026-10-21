import { z } from 'zod';
import {
  defineConfig,
  defineConfigRule,
  defineProductionRule,
  numberAt,
  secretMeta,
} from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { LOCALE_PATTERN } from './templates.js';

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
/** Không export ở core (health, resilience cùng khai báo riêng); cùng giá trị. */
const MAX_PORT = 65535;
/**
 * `addr` hoặc `Name <addr>`; tên hiển thị không chứa `<`, `>` hay CR/LF (chặn chèn header).
 * Phần địa chỉ kiểm bằng `z.email()` của zod.
 */
const MAIL_FROM_FORM = /^(?:[^<>\r\n]*<([^<>\s]+)>|([^<>\s]+))$/;
const emailAddress = z.email();
const isMailFrom = (v: string): boolean => {
  const m = MAIL_FROM_FORM.exec(v);
  const addr = m?.[1] ?? m?.[2];
  return addr !== undefined && emailAddress.safeParse(addr).success;
};

export const notificationsConfig = defineConfig(
  'notifications',
  {
    defaultLocale: 'NOTIFICATIONS_DEFAULT_LOCALE',
    claimLeaseMs: 'NOTIFICATIONS_CLAIM_LEASE_MS',
    reenqueueCooldownSec: 'NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC',
    maxTotalAttempts: 'NOTIFICATIONS_MAX_TOTAL_ATTEMPTS',
    retentionDays: 'NOTIFICATIONS_RETENTION_DAYS',
    reconcileCron: 'NOTIFICATIONS_RECONCILE_CRON',
    reconcileTz: 'NOTIFICATIONS_RECONCILE_TZ',
    reconcileBatchSize: 'NOTIFICATIONS_RECONCILE_BATCH_SIZE',
    purgeCron: 'NOTIFICATIONS_PURGE_CRON',
    purgeTz: 'NOTIFICATIONS_PURGE_TZ',
    purgeBatchSize: 'NOTIFICATIONS_PURGE_BATCH_SIZE',
    purgeMaxBatches: 'NOTIFICATIONS_PURGE_MAX_BATCHES',
  },
  z.object({
    defaultLocale: z
      .string()
      .regex(LOCALE_PATTERN)
      .default('en')
      .describe(
        'Locale of transactional emails; the worker refuses to start unless every template has files for it',
      ),
    claimLeaseMs: positiveInt
      .default(20000)
      .describe(
        'How long a worker owns a delivery it claimed (fencing lease); must exceed SMTP_SEND_DEADLINE_MS and be below the total job retry backoff',
      ),
    reenqueueCooldownSec: positiveInt
      .default(300)
      .describe(
        'Minimum time between two re-enqueues of the same stuck delivery by the reconcile cron',
      ),
    maxTotalAttempts: positiveInt
      .default(10)
      .describe(
        'Claims after which the reconcile cron gives a stuck delivery up (FAILED + event)',
      ),
    retentionDays: positiveInt
      .default(30)
      .describe('Delete SENT/FAILED deliveries older than this'),
    reconcileCron: cron
      .default('*/5 * * * *')
      .describe('Cron of notifications.reconcile-deliveries'),
    reconcileTz: timezone
      .default('UTC')
      .describe('Timezone of the reconcile cron'),
    reconcileBatchSize: positiveInt
      .default(200)
      .describe('Stuck deliveries examined per reconcile run'),
    purgeCron: cron
      .default('30 4 * * *')
      .describe('Cron of notifications.purge-deliveries'),
    purgeTz: timezone.default('UTC').describe('Timezone of the purge cron'),
    purgeBatchSize: positiveInt
      .default(5000)
      .describe('Rows deleted per purge statement'),
    purgeMaxBatches: positiveInt
      .default(100)
      .describe('Max purge statements per run'),
  }),
);

export const smtpConfig = defineConfig(
  'smtp',
  {
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    secure: 'SMTP_SECURE',
    requireTls: 'SMTP_REQUIRE_TLS',
    user: 'SMTP_USER',
    password: 'SMTP_PASSWORD',
    tlsRejectUnauthorized: 'SMTP_TLS_REJECT_UNAUTHORIZED',
    connectionTimeoutMs: 'SMTP_CONNECTION_TIMEOUT_MS',
    greetingTimeoutMs: 'SMTP_GREETING_TIMEOUT_MS',
    socketTimeoutMs: 'SMTP_SOCKET_TIMEOUT_MS',
    sendDeadlineMs: 'SMTP_SEND_DEADLINE_MS',
    mailFrom: 'MAIL_FROM',
  },
  z.object({
    host: z.string().optional().describe('SMTP host (required on the worker)'),
    port: positiveInt.max(MAX_PORT).default(587).describe('SMTP port'),
    secure: z.stringbool().default(false).describe('Implicit TLS (port 465)'),
    requireTls: z
      .stringbool()
      .default(true)
      .describe('Require STARTTLS on a plain connection'),
    user: z.string().optional().describe('SMTP username (empty = no AUTH)'),
    password: z
      .string()
      .optional()
      .describe('SMTP password')
      .meta(secretMeta(['worker'])),
    tlsRejectUnauthorized: z
      .stringbool()
      .default(true)
      .describe('Verify the SMTP server certificate'),
    connectionTimeoutMs: positiveInt.default(5000).describe('Connect timeout'),
    greetingTimeoutMs: positiveInt
      .default(5000)
      .describe('Timeout waiting for the SMTP greeting'),
    socketTimeoutMs: positiveInt
      .default(10000)
      .describe('Socket inactivity timeout'),
    sendDeadlineMs: positiveInt
      .default(8000)
      .describe(
        'Hard deadline for one send; on expiry the pooled connection is closed and the attempt counts as SMTP_TIMEOUT. Must be below NOTIFICATIONS_CLAIM_LEASE_MS and below the resilience timeout of the "smtp" provider',
      ),
    mailFrom: z
      .string()
      // Rỗng = chưa đặt (như `.env.example` sinh ra); worker bắt buộc qua luật `smtp-required-on-worker`.
      .refine(
        (v) => v === '' || isMailFrom(v),
        'must be "addr" or "Name <addr>" with a valid email address, on one line',
      )
      .optional()
      .describe(
        'From header, e.g. "App <noreply@example.com>" (required on the worker)',
      ),
  }),
);

defineConfigRule('smtp-required-on-worker', (c) =>
  c.app?.role === 'worker' && (!c.smtp?.host || !c.smtp?.mailFrom)
    ? 'SMTP_HOST and MAIL_FROM are required on the worker (it sends the emails)'
    : undefined,
);
/**
 * AUTH cần cả hai; chỉ một trong hai là cấu hình sai, không phải "không AUTH" (rỗng = chưa đặt). Chỉ worker gửi
 * thư (`forApi` chỉ ghi DB + enqueue), nên chỉ worker nhận `SMTP_PASSWORD` và chỉ worker bị đòi cặp này, cùng mẫu
 * `smtp-required-on-worker`.
 */
defineConfigRule('smtp-auth-pair', (c) =>
  c.app?.role !== 'worker' ||
  Boolean(c.smtp?.user) === Boolean(c.smtp?.password)
    ? undefined
    : 'SMTP_USER and SMTP_PASSWORD must be set together on the worker (both empty = no AUTH)',
);
/** Tên provider của breaker/bulkhead cho SMTP (hằng số, không phải host); transport (Task 22) dùng lại. */
export const SMTP_RESILIENCE_PROVIDER = 'smtp';
/**
 * Review I2: transport chạy trong `ResiliencePolicies.single` có timeout Aggressive. Nếu timeout đó tới trước
 * hạn chót của transport, lỗi là `TaskCancelledError` → `SMTP_TRANSIENT` thay vì `SMTP_TIMEOUT` và socket
 * không được đóng bởi nhánh deadline. Hạn chót phải tới trước (tính cả `RESILIENCE_OVERRIDES.smtp.timeoutMs`).
 */
defineConfigRule('smtp-deadline-below-resilience-timeout', (c) => {
  const deadline = c.smtp?.sendDeadlineMs;
  const timeoutMs =
    numberAt(c.resilience?.overrides, SMTP_RESILIENCE_PROVIDER, 'timeoutMs') ??
    c.resilience?.timeoutMs;
  if (typeof deadline !== 'number' || typeof timeoutMs !== 'number')
    return 'smtp deadline rule needs the smtp and resilience namespaces';
  return deadline < timeoutMs
    ? undefined
    : `SMTP_SEND_DEADLINE_MS (${deadline}) must be less than the resilience timeout of provider "${SMTP_RESILIENCE_PROVIDER}" (${timeoutMs}; RESILIENCE_OVERRIDES.smtp.timeoutMs or RESILIENCE_DEFAULT_TIMEOUT_MS)`;
});
defineConfigRule('notifications-deadline-below-lease', (c) => {
  const deadline = c.smtp?.sendDeadlineMs;
  const lease = c.notifications?.claimLeaseMs;
  if (typeof deadline !== 'number' || typeof lease !== 'number')
    return 'notifications rules need the smtp and notifications namespaces';
  return deadline < lease
    ? undefined
    : `SMTP_SEND_DEADLINE_MS (${deadline}) must be less than NOTIFICATIONS_CLAIM_LEASE_MS (${lease})`;
});
/**
 * Backoff mũ của BullMQ: lần thử thứ n chờ backoff × 2^(n−1), nên tổng trước lần thử cuối là
 * backoff × (2^(attempts−1) − 1). Tổng đó phải vượt lease, để một job thấy `SENDING` còn lease (vd. do
 * worker chết) còn lượt thử sau khi lease hết hạn; phần sót lại do cron đối soát bắt (spec §5.11).
 */
defineConfigRule('notifications-backoff-exceeds-lease', (c) => {
  const attempts = c.queue?.attempts;
  const backoff = c.queue?.backoffMs;
  const lease = c.notifications?.claimLeaseMs;
  if (
    typeof attempts !== 'number' ||
    typeof backoff !== 'number' ||
    typeof lease !== 'number'
  )
    return 'notifications rules need the queue and notifications namespaces';
  const total = backoff * (2 ** (attempts - 1) - 1);
  return total > lease
    ? undefined
    : `total retry backoff of QUEUE_DEFAULT_ATTEMPTS/QUEUE_DEFAULT_BACKOFF_MS (${total} ms) must exceed NOTIFICATIONS_CLAIM_LEASE_MS (${lease} ms)`;
});
// N7 (final-fixes rereview + cleanup-batch correction): "notifications-retention-outlives-token-ttl" moved OUT of
// this file to `src/composition.config.ts` (app-level composition). It used to live here reading `c.identity`,
// which is backwards for SP2 rule 15 ("identity calls notifications, never the reverse") and failed validation in
// any process without the identity namespace. See composition.config.ts for the full history and why
// identity.config.ts (the first fix) turned out to be the wrong home too.
defineProductionRule('smtp-tls', (c) => {
  if (!c.smtp?.secure && !c.smtp?.requireTls)
    return 'SMTP_SECURE or SMTP_REQUIRE_TLS must be true in production';
  if (c.smtp?.tlsRejectUnauthorized !== true)
    return 'SMTP_TLS_REJECT_UNAUTHORIZED must be true in production';
  return undefined;
});
