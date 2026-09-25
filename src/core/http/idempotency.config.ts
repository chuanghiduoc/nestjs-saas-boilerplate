import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const MIN_KEY_LENGTH_FLOOR = 16;
const FORBIDDEN_REPLAY_HEADER = 'set-cookie';

export const idempotencyConfig = defineConfig(
  'idempotency',
  {
    ttlSec: 'IDEMPOTENCY_TTL_SEC',
    lockTtlSec: 'IDEMPOTENCY_LOCK_TTL_SEC',
    keyMinLength: 'IDEMPOTENCY_KEY_MIN_LENGTH',
    keyMaxLength: 'IDEMPOTENCY_KEY_MAX_LENGTH',
    replayHeaders: 'IDEMPOTENCY_REPLAY_HEADERS',
  },
  z
    .object({
      ttlSec: z.coerce
        .number()
        .int()
        .positive()
        .default(86400)
        .describe(
          'How long a completed response is stored and replayed; routes may set a shorter ttl',
        ),
      lockTtlSec: z.coerce
        .number()
        .int()
        .positive()
        .default(120)
        .describe(
          'How long an in-progress lock lives (a crashed request frees its key after this); must exceed the slowest idempotent handler, else a retry can run concurrently',
        ),
      keyMinLength: z.coerce
        .number()
        .int()
        .min(MIN_KEY_LENGTH_FLOOR)
        .default(MIN_KEY_LENGTH_FLOOR)
        .describe('Minimum Idempotency-Key length'),
      keyMaxLength: z.coerce
        .number()
        .int()
        .positive()
        .default(255)
        .describe('Maximum Idempotency-Key length'),
      replayHeaders: z
        .string()
        .default('location,etag,retry-after')
        .transform((s) =>
          s
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean),
        )
        .refine((hs) => !hs.includes(FORBIDDEN_REPLAY_HEADER), {
          message: 'IDEMPOTENCY_REPLAY_HEADERS must never include set-cookie',
        })
        .describe(
          'Headers stored and replayed with a response or error (allowlist; set-cookie is forbidden)',
        ),
    })
    .refine((c) => c.lockTtlSec < c.ttlSec, {
      message: 'IDEMPOTENCY_LOCK_TTL_SEC must be < IDEMPOTENCY_TTL_SEC',
      path: ['lockTtlSec'],
    })
    .refine((c) => c.keyMaxLength >= c.keyMinLength, {
      message:
        'IDEMPOTENCY_KEY_MAX_LENGTH must be >= IDEMPOTENCY_KEY_MIN_LENGTH',
      path: ['keyMaxLength'],
    }),
);
