import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';
import {
  TRUST_PROXY_PRESETS,
  parseTrustProxy,
  trustsEveryProxy,
} from './trust-proxy.js';

/** Cú pháp giới hạn body của `bytes` (thư viện body-parser dùng), vd. `1mb`, `512kb`. */
const BODY_LIMIT_PATTERN = /^\d+(b|kb|mb|gb)?$/i;
const trustProxyEntry = z.union([
  z.enum(TRUST_PROXY_PRESETS),
  z.ipv4(),
  z.ipv6(),
  z.cidrv4(),
  z.cidrv6(),
]);

export const httpConfig = defineConfig(
  'http',
  {
    port: 'HTTP_PORT',
    host: 'HTTP_HOST',
    bodyLimit: 'HTTP_BODY_LIMIT',
    corsOrigins: 'HTTP_CORS_ORIGINS',
    trustProxy: 'HTTP_TRUST_PROXY',
    allowedContentTypes: 'HTTP_ALLOWED_CONTENT_TYPES',
    docsEnabled: 'HTTP_DOCS_ENABLED',
    docsPath: 'HTTP_DOCS_PATH',
    docsCdnUrl: 'HTTP_DOCS_CDN_URL',
  },
  z
    .object({
      port: z.coerce
        .number()
        .int()
        .min(0)
        .default(3000)
        .describe(
          'HTTP listen port. compose.yaml maps and health-checks the api container on 3000; change both if this changes',
        ),
      host: z.string().default('0.0.0.0').describe('HTTP listen host'),
      bodyLimit: z
        .string()
        .regex(BODY_LIMIT_PATTERN)
        .default('1mb')
        .describe('Max request body size (larger → 413)'),
      corsOrigins: z
        .string()
        .default('')
        .transform((s) =>
          s
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        )
        .pipe(
          z.array(
            z.url().refine((u) => URL.canParse(u) && new URL(u).origin === u, {
              message: 'must be a bare origin (scheme://host[:port], no path)',
            }),
          ),
        )
        .describe('Allowed CORS origins; empty = CORS disabled'),
      trustProxy: z
        .string()
        .default('false')
        .transform(parseTrustProxy)
        .pipe(
          z.union([
            z.boolean(),
            z.number().int().nonnegative(),
            z.array(trustProxyEntry).min(1),
          ]),
        )
        .describe(
          'Express trust proxy: true|false|hop count|comma-separated addresses/CIDRs/presets',
        ),
      allowedContentTypes: z
        .string()
        .default('application/json,application/merge-patch+json')
        .transform((s) =>
          s
            .split(',')
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean),
        )
        .pipe(z.array(z.string()).min(1))
        .describe('Accepted request Content-Types (others → 415)'),
      docsEnabled: z
        .stringbool()
        .default(false)
        .describe('Serve API reference UI'),
      docsPath: z
        .string()
        .startsWith('/')
        .default('/docs')
        .describe('Path of API reference UI'),
      docsCdnUrl: z
        .url({ protocol: /^https$/ })
        .optional()
        .describe(
          'Version-pinned https URL of the API reference script (required when docs are enabled)',
        ),
    })
    .refine((c) => !c.docsEnabled || c.docsCdnUrl, {
      message: 'HTTP_DOCS_CDN_URL is required when HTTP_DOCS_ENABLED=true',
      path: ['docsCdnUrl'],
    }),
);

defineProductionRule('http-no-docs', (c) =>
  c.http?.docsEnabled
    ? 'HTTP_DOCS_ENABLED must be false in production'
    : undefined,
);
defineProductionRule('http-no-trust-all-proxies', (c) =>
  trustsEveryProxy(c.http?.trustProxy)
    ? 'HTTP_TRUST_PROXY must not trust every proxy in production (use a hop count or the proxy CIDRs)'
    : undefined,
);
