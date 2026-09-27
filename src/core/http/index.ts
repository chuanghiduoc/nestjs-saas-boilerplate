export { HttpModule } from './http.module.js';
export {
  Paginator,
  offsetPageQuery,
  cursorPageQuery,
  offsetPageSchema,
  cursorPageSchema,
  type OffsetPage,
  type CursorPage,
} from './pagination.js';
export { serialize, setLocation, type HeaderWriter } from './response.js';
export { etagOf, assertIfMatch } from './conditional.js';
export {
  mergePatchSchema,
  applyMergePatch,
  mergePatchInto,
  type MergePatch,
} from './merge-patch.js';
export { ApiProblems } from './api-problems.decorator.js';
export { applyHttpDefaults } from './http-bootstrap.js';
export {
  buildOpenApi,
  setupApiDocs,
  problemSchema,
  API_MAJOR_VERSION,
} from './openapi.js';
export { parseTrustProxy } from './trust-proxy.js';
export { httpConfig } from './http.config.js';
export { writeProblem } from './problem-writer.js';
export { jsonBodyParser, type NodeMiddleware } from './json-body-parser.js';
export { paginationConfig } from './pagination.config.js';
export { throttleConfig } from './throttle.config.js';
export { idempotencyConfig } from './idempotency.config.js';
export { Idempotent } from './idempotency.decorator.js';
export type { IdempotentOptions } from './idempotency.interceptor.js';
/** Module khác dùng tên này, không import thẳng `@nestjs/throttler`. Health và webhook phải dùng. */
export { SkipThrottle as SkipRateLimit } from '@nestjs/throttler';
