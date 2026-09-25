import { z } from 'zod';
import { defineConfig, defineConfigRule } from '../config/index.js';
import {
  normalizeTimezone,
  isValidCron,
} from '../scheduler/schedule-validation.js';

const positiveInt = z.coerce.number().int().positive();
const SECONDS_PER_DAY = 86_400;

export const outboxConfig = defineConfig(
  'outbox',
  {
    pollIntervalMs: 'OUTBOX_POLL_INTERVAL_MS',
    batchSize: 'OUTBOX_BATCH_SIZE',
    autostart: 'OUTBOX_AUTOSTART',
    retentionDays: 'OUTBOX_RETENTION_DAYS',
    inboxRetentionDays: 'INBOX_RETENTION_DAYS',
    attemptsAlertThreshold: 'OUTBOX_ATTEMPTS_ALERT_THRESHOLD',
    maxPublishAttempts: 'OUTBOX_MAX_PUBLISH_ATTEMPTS',
    errorBackoffMaxMs: 'OUTBOX_ERROR_BACKOFF_MAX_MS',
    cleanupCron: 'OUTBOX_CLEANUP_CRON',
    cleanupTz: 'OUTBOX_CLEANUP_TZ',
    cleanupBatchSize: 'OUTBOX_CLEANUP_BATCH_SIZE',
    cleanupMaxBatches: 'OUTBOX_CLEANUP_MAX_BATCHES',
  },
  z.object({
    pollIntervalMs: positiveInt
      .default(1000)
      .describe('Relay poll interval when the outbox is empty'),
    batchSize: positiveInt
      .max(1000)
      .default(100)
      .describe('Rows claimed per relay iteration'),
    autostart: z
      .stringbool()
      .default(true)
      .describe('Start relay loop on worker bootstrap'),
    retentionDays: positiveInt
      .default(14)
      .describe(
        'Delete published outbox rows older than this. Invariant (checked at boot): OUTBOX_RETENTION_DAYS in seconds > QUEUE_KEEP_FAILED_AGE_SEC, so a failed dispatch/deliver job can still be retried manually and find its row. Unpublished and parked rows are never deleted',
      ),
    inboxRetentionDays: positiveInt
      .default(30)
      .describe(
        'Delete inbox (processed_events) records older than this. Invariant (checked at boot): INBOX_RETENTION_DAYS > OUTBOX_RETENTION_DAYS + QUEUE_KEEP_FAILED_AGE_SEC, i.e. longer than any event can still be redelivered (re-dispatch while its outbox row exists, then a manual retry of the deliver job); deleting a record earlier lets a redelivery run the side effect twice',
      ),
    attemptsAlertThreshold: positiveInt
      .default(10)
      .describe('Log error when publish attempts exceed this'),
    maxPublishAttempts: positiveInt
      .default(20)
      .describe(
        'Rows rejected this many times are parked (never claimed again) for dead-letter handling',
      ),
    errorBackoffMaxMs: positiveInt
      .default(30000)
      .describe(
        'Cap of the exponential backoff between relay iterations after a batch-level (Redis/DB) failure',
      ),
    cleanupCron: z
      .string()
      .min(1)
      .refine(isValidCron, 'must be a valid cron expression')
      .default('0 5 * * *')
      .describe('Cron for outbox/inbox cleanup'),
    cleanupTz: z
      .string()
      .min(1)
      .refine(
        (tz) => normalizeTimezone(tz) !== undefined,
        'must be an IANA timezone name',
      )
      .default('Asia/Ho_Chi_Minh')
      .describe('Timezone for cleanup cron'),
    cleanupBatchSize: positiveInt
      .default(5000)
      .describe(
        'Rows deleted per cleanup statement (each statement is its own short transaction)',
      ),
    cleanupMaxBatches: positiveInt
      .default(100)
      .describe(
        'Max cleanup statements per table per run; leftovers are deleted by the next run',
      ),
  }),
);

/**
 * Bất biến retention (mọi môi trường, không chỉ production): vi phạm làm retry tay một job hỏng
 * không tìm thấy dòng outbox, hoặc tệ hơn, chạy side effect hai lần vì bản ghi inbox đã bị xoá.
 */
defineConfigRule('outbox-retention', (c) => {
  const outboxDays = c.outbox?.retentionDays;
  const inboxDays = c.outbox?.inboxRetentionDays;
  const keepFailedSec = c.queue?.keepFailedAgeSec;
  if (
    typeof outboxDays !== 'number' ||
    typeof inboxDays !== 'number' ||
    typeof keepFailedSec !== 'number'
  )
    return 'outbox retention rule needs the outbox and queue config namespaces';
  const outboxSec = outboxDays * SECONDS_PER_DAY;
  if (outboxSec <= keepFailedSec)
    return `OUTBOX_RETENTION_DAYS (${outboxDays}d = ${outboxSec}s) must be greater than QUEUE_KEEP_FAILED_AGE_SEC (${keepFailedSec}s)`;
  if (inboxDays * SECONDS_PER_DAY <= outboxSec + keepFailedSec)
    return `INBOX_RETENTION_DAYS (${inboxDays}d) must be greater than OUTBOX_RETENTION_DAYS + QUEUE_KEEP_FAILED_AGE_SEC (${(outboxSec + keepFailedSec) / SECONDS_PER_DAY}d)`;
  return undefined;
});
