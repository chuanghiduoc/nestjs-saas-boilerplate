import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const positiveInt = z.coerce.number().int().positive();

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
      .default(7)
      .describe(
        'Delete published outbox rows older than this. Must exceed the lifetime of the dispatch/deliver jobs that read the row (retries plus QUEUE_KEEP_FAILED_AGE_SEC for manual retry of failed jobs); a job re-run after its row is gone fails with "row not found". Unpublished and parked rows are never deleted',
      ),
    inboxRetentionDays: positiveInt
      .default(30)
      .describe(
        'Delete inbox (processed_events) records older than this. Invariant: must exceed the longest window in which the same event can be redelivered to a consumer (job retries/backoff plus QUEUE_KEEP_FAILED_AGE_SEC for manual retry, and OUTBOX_RETENTION_DAYS); deleting a record earlier lets a redelivery run the side effect twice',
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
      .default('0 5 * * *')
      .describe('Cron for outbox/inbox cleanup'),
    cleanupTz: z
      .string()
      .min(1)
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
