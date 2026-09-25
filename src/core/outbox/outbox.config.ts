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
    cleanupCron: 'OUTBOX_CLEANUP_CRON',
    cleanupTz: 'OUTBOX_CLEANUP_TZ',
    cleanupBatchSize: 'OUTBOX_CLEANUP_BATCH_SIZE',
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
      .describe('Delete published outbox rows older than this'),
    inboxRetentionDays: positiveInt
      .default(30)
      .describe('Delete inbox records older than this'),
    attemptsAlertThreshold: positiveInt
      .default(10)
      .describe('Log error when publish attempts exceed this'),
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
      .describe('Rows deleted per cleanup statement'),
  }),
);
