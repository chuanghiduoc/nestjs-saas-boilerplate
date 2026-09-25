import { z } from 'zod';
import { defineConfig } from '../config/index.js';
import { FIELD_KEY_BYTES, fieldKeyLength } from './field-cipher.js';

const KID_PATTERN = /^[a-z0-9]{1,16}$/;

/**
 * Mọi message lỗi ở đây là chuỗi cố định: không chèn giá trị input (là secret).
 * `parseConfig` chỉ in path + message, không in input.
 */
const Keyring = z
  .record(
    z.string().regex(KID_PATTERN, {
      error: 'FIELD_ENCRYPTION_KEYS kids must match [a-z0-9]{1,16}',
    }),
    z
      .string({ error: 'FIELD_ENCRYPTION_KEYS values must be base64 strings' })
      .refine((b64) => fieldKeyLength(b64) === FIELD_KEY_BYTES, {
        error: `FIELD_ENCRYPTION_KEYS values must decode to ${FIELD_KEY_BYTES} bytes`,
      }),
    { error: 'FIELD_ENCRYPTION_KEYS must be a JSON object' },
  )
  .refine((ring) => Object.keys(ring).length > 0, {
    error: 'FIELD_ENCRYPTION_KEYS must contain at least one key',
  });

/** Parse JSON mà không bao giờ đưa giá trị (là secret) vào thông báo lỗi. */
const keyringFromJson = z
  .string()
  .transform((raw, ctx) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'FIELD_ENCRYPTION_KEYS must be a JSON object {"<kid>":"<base64 32-byte key>"}',
      });
      return z.NEVER;
    }
  })
  .pipe(Keyring);

export const securityConfig = defineConfig(
  'security',
  { keys: 'FIELD_ENCRYPTION_KEYS', activeKid: 'FIELD_ENCRYPTION_ACTIVE_KID' },
  z
    .object({
      keys: keyringFromJson.describe(
        'Field encryption keyring as JSON {"<kid>":"<base64 32-byte key>"}; keep retired kids for decryption (secret)',
      ),
      activeKid: z
        .string()
        .regex(KID_PATTERN)
        .describe('Key id used for new encryptions'),
    })
    .refine((c) => Object.hasOwn(c.keys, c.activeKid), {
      error:
        'FIELD_ENCRYPTION_ACTIVE_KID must be a kid in FIELD_ENCRYPTION_KEYS',
      path: ['activeKid'],
    }),
);
