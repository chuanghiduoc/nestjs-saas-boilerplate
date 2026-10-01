import { z } from 'zod';
import { Server } from 'node:http';
import {
  defineConfig,
  defineConfigRule,
  defineProductionRule,
} from '../config/index.js';
import {
  TRUST_PROXY_PRESETS,
  parseTrustProxy,
  trustsEveryProxy,
} from './trust-proxy.js';
import { MEDIA_TYPE_PATTERN } from './content-type.js';

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
    bodyLimitLingerMs: 'HTTP_BODY_LIMIT_LINGER_MS',
    bodyLimitLingerBytes: 'HTTP_BODY_LIMIT_LINGER_BYTES',
    corsOrigins: 'HTTP_CORS_ORIGINS',
    trustProxy: 'HTTP_TRUST_PROXY',
    allowedContentTypes: 'HTTP_ALLOWED_CONTENT_TYPES',
    docsEnabled: 'HTTP_DOCS_ENABLED',
    docsPath: 'HTTP_DOCS_PATH',
    docsCdnUrl: 'HTTP_DOCS_CDN_URL',
    requestBudgetMs: 'HTTP_REQUEST_BUDGET_MS',
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
      bodyLimitLingerMs: z.coerce
        .number()
        .int()
        .positive()
        .default(5000)
        .describe(
          'Lingering close for any response sent while the request body is unread (413, 415, header-level rejections, GET/HEAD with a body): how long the server may keep the connection to read and discard the rest of the body so the client can read the response. Counted from the rejection decision, or from when the response finished for GET/HEAD (the handler still runs first). When it elapses the socket is destroyed (after the response is flushed). Must stay below the Node HTTP server requestTimeout (rule http-body-limit-linger)',
        ),
      bodyLimitLingerBytes: z.coerce
        .number()
        .int()
        .positive()
        .default(4 * 1024 * 1024)
        .describe(
          'Lingering close for any response sent while the request body is unread (413, 415, header-level rejections, GET/HEAD with a body): max bytes of the remaining body (Content-Length or chunked) read and discarded. Past it the server stops reading (TCP backpressure holds the client), sends FIN once the response is flushed, and destroys the socket when HTTP_BODY_LIMIT_LINGER_MS elapses if the client has not closed',
        ),
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
        .pipe(
          z
            .array(
              z
                .string()
                .regex(
                  MEDIA_TYPE_PATTERN,
                  'must be a media type without parameters, e.g. application/json',
                ),
            )
            .min(1),
        )
        .describe(
          'Accepted request Content-Types, comma-separated media types without parameters (others → 415)',
        ),
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
      requestBudgetMs: z.coerce
        .number()
        .int()
        .positive()
        .default(30_000)
        .describe(
          'Time budget of one HTTP request, set to the response timeout of the proxy/load balancer in front of the api (default 30000 = the smallest common default, Google Cloud Load Balancing backend service). The app does not enforce it (Node requestTimeout only bounds receiving the request); production rules check the worst client-side DB deadline path of a request against it (database-query-deadline, identity-auth-query-deadline), and in the api a core DB pool connection held longer than this is destroyed and its pool slot returned',
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

/**
 * `requestTimeout` thật của HTTP server: app không đặt option này (Nest tạo server bằng `http.createServer` mặc định),
 * nên đọc mặc định của chính bản Node đang chạy thay vì chép số. Nếu bootstrap đặt `requestTimeout` thì luật dưới
 * phải đọc giá trị đó.
 */
const NODE_REQUEST_TIMEOUT_MS = new Server().requestTimeout;

/**
 * Lingering close sau 413 phải kết thúc trước `requestTimeout` của Node (0 = tắt): nếu không, chính Node cắt request
 * chưa nhận hết body (408 hoặc huỷ socket) trước `HTTP_BODY_LIMIT_LINGER_MS`, và giới hạn này không còn là giới hạn thật.
 */
defineConfigRule('http-body-limit-linger', (c) => {
  const lingerMs = c.http?.bodyLimitLingerMs;
  if (typeof lingerMs !== 'number')
    return 'http body limit linger rule needs the http config namespace';
  if (NODE_REQUEST_TIMEOUT_MS > 0 && lingerMs >= NODE_REQUEST_TIMEOUT_MS)
    return `HTTP_BODY_LIMIT_LINGER_MS (${lingerMs}) must be below the Node HTTP server requestTimeout (${NODE_REQUEST_TIMEOUT_MS} ms)`;
  return undefined;
});
