import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const positiveInt = z.coerce.number().int().positive();

export const queueConfig = defineConfig(
  'queue',
  {
    workerQueues: 'WORKER_QUEUES',
    attempts: 'QUEUE_DEFAULT_ATTEMPTS',
    backoffMs: 'QUEUE_DEFAULT_BACKOFF_MS',
    keepCompletedAgeSec: 'QUEUE_KEEP_COMPLETED_AGE_SEC',
    keepCompletedCount: 'QUEUE_KEEP_COMPLETED_COUNT',
    keepFailedAgeSec: 'QUEUE_KEEP_FAILED_AGE_SEC',
    keepFailedCount: 'QUEUE_KEEP_FAILED_COUNT',
    ioConcurrency: 'QUEUE_IO_CONCURRENCY',
    cpuConcurrency: 'QUEUE_CPU_CONCURRENCY',
    shutdownTimeoutMs: 'QUEUE_SHUTDOWN_TIMEOUT_MS',
    shutdownAbortGraceMs: 'QUEUE_SHUTDOWN_ABORT_GRACE_MS',
    concurrencyOverrides: 'QUEUE_CONCURRENCY_OVERRIDES',
    stalledIntervalMs: 'QUEUE_STALLED_INTERVAL_MS',
    lockDurationMs: 'QUEUE_LOCK_DURATION_MS',
  },
  z.object({
    workerQueues: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .describe(
        'Comma-separated queues this worker consumes; empty = all registered queues',
      ),
    attempts: positiveInt.default(5).describe('Default max attempts per job'),
    backoffMs: positiveInt
      .default(2000)
      .describe('Base delay for exponential backoff'),
    keepCompletedAgeSec: positiveInt
      .default(3600)
      .describe('Remove completed jobs older than this'),
    keepCompletedCount: positiveInt
      .default(1000)
      .describe('Keep at most this many completed jobs per queue'),
    keepFailedAgeSec: positiveInt
      .default(604800)
      .describe('Remove failed jobs older than this'),
    keepFailedCount: positiveInt
      .default(10000)
      .describe(
        'Keep at most this many failed jobs per queue (bounds Redis memory)',
      ),
    ioConcurrency: positiveInt
      .default(20)
      .describe('Default concurrency for io queues'),
    cpuConcurrency: positiveInt
      .default(1)
      .describe('Default concurrency for cpu queues'),
    shutdownTimeoutMs: positiveInt
      .default(25000)
      .describe('Max wait for in-flight jobs on shutdown'),
    shutdownAbortGraceMs: positiveInt
      .default(5000)
      .describe(
        'After the shutdown timeout, jobs get an abort signal; max extra wait for them to stop',
      ),
    concurrencyOverrides: z
      .string()
      .default('')
      .transform((s, ctx) => {
        const out: Record<string, number> = {};
        for (const kv of s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)) {
          const [k, v] = kv.split('=');
          const n = Number(v);
          if (!k || !Number.isInteger(n) || n <= 0) {
            ctx.addIssue({
              code: 'custom',
              message: `invalid entry "${kv}", expected queue=positiveInt`,
            });
            return {};
          }
          out[k.trim()] = n;
        }
        return out;
      })
      .describe('Per-queue concurrency, e.g. "billing=1,notifications=50"'),
    stalledIntervalMs: positiveInt
      .default(30000)
      .describe('How often workers check for stalled jobs'),
    lockDurationMs: positiveInt
      .default(30000)
      .describe('Job lock duration; must exceed the longest event-loop stall'),
  }),
);
