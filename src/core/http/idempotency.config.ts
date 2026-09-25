import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const MIN_KEY_LENGTH_FLOOR = 16;
const FORBIDDEN_REPLAY_HEADER = 'set-cookie';

export const idempotencyConfig = defineConfig(
  'idempotency',
  {
    ttlSec: 'IDEMPOTENCY_TTL_SEC',
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
          'How long a stored response (and an in-progress lock) lives; routes may set a shorter ttl',
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
        .default('location,etag')
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
          'Response headers stored and replayed with the body (allowlist; set-cookie is forbidden)',
        ),
    })
    .refine((c) => c.keyMaxLength >= c.keyMinLength, {
      message:
        'IDEMPOTENCY_KEY_MAX_LENGTH must be >= IDEMPOTENCY_KEY_MIN_LENGTH',
      path: ['keyMaxLength'],
    }),
);
