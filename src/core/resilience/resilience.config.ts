import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';
import { allowCidrProblem } from './ssrf-guard.js';

const MAX_PORT = 65535;
const SCHEMES = ['http', 'https'] as const;
const HTTPS_ONLY = 'https';

const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export const PolicyOverride = z
  .object({
    timeoutMs: z.number().int().positive(),
    retries: z.number().int().min(0),
    retryBaseMs: z.number().int().positive(),
    breakerThreshold: z.number().int().positive(),
    breakerHalfOpenMs: z.number().int().positive(),
    bulkheadLimit: z.number().int().positive(),
    bulkheadQueue: z.number().int().min(0),
  })
  .partial()
  .strict();

const overridesFromJson = z
  .string()
  .default('{}')
  .transform((raw, ctx) => {
    try {
      const v: unknown = JSON.parse(raw);
      return v;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'RESILIENCE_OVERRIDES must be a JSON object',
      });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string(), PolicyOverride));

export const resilienceConfig = defineConfig(
  'resilience',
  {
    timeoutMs: 'RESILIENCE_DEFAULT_TIMEOUT_MS',
    retries: 'RESILIENCE_DEFAULT_RETRIES',
    retryBaseMs: 'RESILIENCE_DEFAULT_RETRY_BASE_MS',
    breakerThreshold: 'RESILIENCE_DEFAULT_BREAKER_THRESHOLD',
    breakerHalfOpenMs: 'RESILIENCE_DEFAULT_BREAKER_HALF_OPEN_MS',
    bulkheadLimit: 'RESILIENCE_DEFAULT_BULKHEAD_LIMIT',
    bulkheadQueue: 'RESILIENCE_DEFAULT_BULKHEAD_QUEUE',
    overrides: 'RESILIENCE_OVERRIDES',
    allowedSchemes: 'RESILIENCE_ALLOWED_SCHEMES',
    allowedPorts: 'RESILIENCE_ALLOWED_PORTS',
    allowCidrs: 'RESILIENCE_SSRF_ALLOW_CIDRS',
    maxResponseBytes: 'RESILIENCE_MAX_RESPONSE_BYTES',
    retryAfterMaxSec: 'RESILIENCE_RETRY_AFTER_MAX_SEC',
  },
  z.object({
    timeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(10000)
      .describe(
        'Per-attempt timeout for outbound calls (aborts the request via its signal)',
      ),
    retries: z.coerce
      .number()
      .int()
      .min(0)
      .default(2)
      .describe('Retries for idempotent outbound calls'),
    retryBaseMs: z.coerce
      .number()
      .int()
      .positive()
      .default(200)
      .describe('Base delay for exponential backoff with full jitter'),
    breakerThreshold: z.coerce
      .number()
      .int()
      .positive()
      .default(5)
      .describe('Consecutive failures that open the circuit'),
    breakerHalfOpenMs: z.coerce
      .number()
      .int()
      .positive()
      .default(30000)
      .describe('Time before a half-open probe'),
    bulkheadLimit: z.coerce
      .number()
      .int()
      .positive()
      .default(20)
      .describe('Max concurrent calls per provider'),
    bulkheadQueue: z.coerce
      .number()
      .int()
      .min(0)
      .default(100)
      .describe('Max queued calls per provider'),
    overrides: overridesFromJson.describe(
      'Per-provider overrides as JSON {"<provider>":{"timeoutMs":..,"retries":..}}',
    ),
    allowedSchemes: z
      .string()
      .default(HTTPS_ONLY)
      .transform(csv)
      .pipe(z.array(z.enum(SCHEMES)).min(1))
      .describe(
        'URL schemes outbound HTTP may use (http,https); production allows https only',
      ),
    allowedPorts: z
      .string()
      .default('80,443')
      .transform((s) => csv(s).map(Number))
      .pipe(z.array(z.number().int().min(1).max(MAX_PORT)).min(1))
      .describe('Destination ports outbound HTTP may use'),
    allowCidrs: z
      .string()
      .default('')
      .transform(csv)
      .pipe(
        z.array(
          z.string().superRefine((cidr, ctx) => {
            const problem = allowCidrProblem(cidr);
            if (problem)
              ctx.addIssue({
                code: 'custom',
                message: `RESILIENCE_SSRF_ALLOW_CIDRS entry "${cidr}" ${problem}`,
              });
          }),
        ),
      )
      .describe(
        'CIDRs exempt from the private-address block; /0 and ranges covering cloud metadata are rejected (empty in production unless an internal provider is required)',
      ),
    maxResponseBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(10485760)
      .describe(
        'Max outbound response body size (bytes, enforced while streaming)',
      ),
    retryAfterMaxSec: z.coerce
      .number()
      .int()
      .positive()
      .default(300)
      .describe(
        'Cap on an upstream Retry-After (seconds) passed to callers and to clients on 503',
      ),
  }),
);

defineProductionRule('resilience-https-only', (c) => {
  const schemes = c.resilience?.allowedSchemes;
  return Array.isArray(schemes) && schemes.some((s) => s !== HTTPS_ONLY)
    ? 'RESILIENCE_ALLOWED_SCHEMES must be https only in production'
    : undefined;
});
