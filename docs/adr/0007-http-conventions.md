# 0007 - HTTP conventions: validation, flat responses, problem+json, ETag/If-Match, Merge Patch, OpenAPI, proxy

- Status: accepted
- Date: 2026-09-25

## Decision

REST + JSON under `/v1`, conventions owned by `src/core/http` (spec §3.1–3.5). Modules use the
shared pieces and never re-implement them.

| Concern                  | Shared piece                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input validation         | Nest 12 `StandardSchemaValidationPipe` (global, `applyHttpDefaults`) + zod schema on `@Body/@Query/@Param({ schema })`. Failure → `422 validation_failed`, `errors[]` with dot paths and zod codes (`invalid_email` …) |
| Errors                   | RFC 9457 problem+json rendered by `ProblemDetailsFilter` through `HttpAdapterHost` (`core/errors`)                                                                                                                       |
| Single resource          | plain object via `serialize(schema, value)` (unknown/internal fields stripped; schema mismatch is a server bug → 500)                                                                                                     |
| Lists                    | flat pages from `Paginator.offset` / `Paginator.cursor` (ADR 0012)                                                                                                                                                       |
| 201                      | `setLocation(res, url)`                                                                                                                                                                                                  |
| Concurrency              | `etagOf(version)` → weak ETag `W/"<version>"`; `assertIfMatch(ifMatch, version, { required })`                                                                                                                           |
| PATCH                    | `mergePatchSchema(schema)` with `application/merge-patch+json`                                                                                                                                                           |
| Content types            | `ContentTypeMiddleware` (all routes): body on POST/PUT/PATCH must be one of `HTTP_ALLOWED_CONTENT_TYPES`, else `415`                                                                                                     |
| Body size                | JSON parser limit `HTTP_BODY_LIMIT` → `413 payload_too_large`                                                                                                                                                            |
| OpenAPI                  | `buildOpenApi` (OpenAPI 3.1, `@nestjs/swagger`), `@ApiProblems(...)`, `pnpm openapi:export` → committed `openapi.json`                                                                                                   |
| Docs UI                  | Scalar at `HTTP_DOCS_PATH` only when `HTTP_DOCS_ENABLED=true`; forbidden in production                                                                                                                                   |
| Security headers         | `helmet()` defaults on every route                                                                                                                                                                                       |
| Client IP                | Express `trust proxy` from `HTTP_TRUST_PROXY`                                                                                                                                                                            |

### Status table

As spec §3.2. Notes on the ones this task implements:

- `412 precondition_failed`: `If-Match` present and none of its tags equals the current version.
- `428 precondition_required`: the route calls `assertIfMatch(..., { required: true })` and the header
  is missing or blank.
- `415 unsupported_media_type`: from `ContentTypeMiddleware`, including form-encoded bodies (Express
  still parses them with its default urlencoded parser, the middleware then refuses them).
- `405 method_not_allowed` is reserved but **not produced**: Express/Nest route matching does not tell
  "path exists with another method" from "path does not exist", so a wrong method returns
  `404 not_found`. Producing 405 would require reading the router table; not worth it in SP1.

### If-Match compares the version, weakly

The ETag is the resource version, not a hash of the representation, so the weak prefix `W/` is
stripped before comparing (`W/"7"` and `"7"` both match version 7). `*` matches any existing
resource. Unquoted tags (`7`) never match. Express keeps an ETag the handler already set and turns
`If-None-Match` into `304` itself (`res.send`: `generateETag = !this.get('ETag')`, then `req.fresh`
→ 304), so GET only has to set `ETag: etagOf(version)`. `app.set('etag', 'weak')` for routes that do
not set one.

### JSON Merge Patch (RFC 7396)

`mergePatchSchema(schema)` = zod `schema.partial().strict()`:

- every field optional (absent = unchanged); unknown fields → 422;
- `null` is accepted only where the source field is `.nullable()` (null = clear the value);
- a source field with `.default()`/`.prefault()` is refused when the patch schema is built: zod 4
  applies defaults even inside `.optional()`, which would silently overwrite fields the client did
  not send;
- **no recursive merge, enforced**: a field whose schema accepts a JSON object (`z.object`, `z.record`,
  also through `optional/nullable/default/readonly/pipe/union/intersection`) is refused when the patch
  schema is built. Replacing it whole would erase sub-keys the client did not send (and `.strict()`
  only applies at the top level). Model such data as a sub-resource with its own endpoint, or as a
  whole-value replacement with a different schema type (e.g. an array). Arrays are replaced whole,
  which is what RFC 7396 specifies.

### Trust proxy

`HTTP_TRUST_PROXY` is parsed by `parseTrustProxy` into `true | false | hop count | list`; list
entries must be `loopback`/`linklocal`/`uniquelocal`, an IPv4/IPv6 address or a CIDR (zod
`ipv4/ipv6/cidrv4/cidrv6`), validated at boot. Production rule `http-no-trust-all-proxies` rejects
`true` and any range too broad to be a proxy network (anyone could spoof `X-Forwarded-For`): IPv4
prefix shorter than `/8`, IPv6 prefix shorter than `/32`, an IPv6 range containing the whole
IPv4-mapped block `::ffff:0:0/96` (e.g. `::/64`), or an IPv4-mapped range broader than `/8`
(`::ffff:0:0/96`). Checked with `node:net` `BlockList`. Residual risk: many narrow ranges that together
cover the internet are not detected.

`HTTP_CORS_ORIGINS` entries must be bare origins (`new URL(u).origin === u`), otherwise the browser
`Origin` header would never match and CORS would fail silently.

### API docs and CSP

Helmet's default CSP (`script-src 'self'`) blocks both the CDN script and the inline init script
that Scalar renders. The docs route therefore replaces the CSP with helmet's defaults plus a fresh
128-bit nonce per request (`script-src 'self' 'nonce-…'`, no `'unsafe-inline'`), and passes the same
nonce to Scalar, which then emits it on every `<script>` and loads the single-file UMD bundle from the
pinned `HTTP_DOCS_CDN_URL`. API routes keep the strict default CSP. Verified in
`test/e2e/core/api-docs.e2e.spec.ts` (every `<script>` carries the header's nonce; nonce differs per
request). Not verified in a real browser.

### Platform isolation

`http-bootstrap.ts` is the only file that knows the platform is Express (`@nestjs/platform-express`
type, `useBodyParser`, `set`), guarded by `getHttpAdapter().getType() === 'express'`. The worker
never loads `core/http` beyond its config files.

### Rate limiting

`@nestjs/throttler` (global `AppThrottlerGuard` via `APP_GUARD`) with a `ThrottlerStorage` implemented
on `rate-limiter-flexible` (`RateLimiterThrottlerStorage`): `RateLimiterRedis` on the shared ioredis
client (`REDIS`), keys `<REDIS_NAMESPACE>-rl-<throttler>-<limit>-<ttl>-<block>:<tracker hash>`, and an
`insuranceLimiter: RateLimiterMemory`.

- Tracker: `principal:<type>:<id>:<orgId|none>` when `RequestContext` has a principal, else
  `ip:<req.ip>` (throttler's `normalizeIp`, IPv6 grouped by /64). `req.ip` is correct only with the
  right `HTTP_TRUST_PROXY`. The principal must be set **before** the guard runs (middleware); SP2 auth
  must respect this or authenticated calls are counted by IP.
- Limits: `THROTTLE_DEFAULT_LIMIT` per `THROTTLE_DEFAULT_TTL_MS`; the block duration equals the window
  (throttler default). `rate-limiter-flexible` counts `duration`/`blockDuration` in **whole seconds**
  (`Math.floor` of the fraction), so the window must be a multiple of 1000 ms: the config refuses
  anything else and the storage throws instead of rounding.
- 429: `ThrottlerException` → `429 rate_limited` problem+json. The guard sets `Retry-After` (seconds)
  before throwing and `X-RateLimit-Limit/Remaining/Reset` on allowed responses; the filter keeps them.
- Redis down: `rate-limiter-flexible` sends the call to the in-memory insurance limiter (limits still
  apply, per pod, not shared). Commands wait at most `REDIS_COMMAND_TIMEOUT_MS` (ioredis arms the
  timeout before the offline queue). `rejectIfRedisNotReady` is off on purpose: it would send every
  request made while a fresh pod is still connecting to the insurance limiter. The storage logs `warn`
  once when an episode starts and `log` once when a Redis-backed call succeeds again. Both limiters
  failing is rethrown (500), never swallowed.
- `SkipRateLimit` (re-export of `SkipThrottle`) for health and webhooks. Modules import it from
  `core/http`, never from `@nestjs/throttler`.
- Rejected: `@nest-lab/throttler-storage-redis` (unmaintained since 02/2026, imports internal paths),
  a hand-written fail-open wrapper.

### Idempotency-Key

`@Idempotent(opts?: { ttlSec })` = `IdempotencyInterceptor` on `@node-idempotency/core` (closest to
IETF `draft-ietf-httpapi-idempotency-key-header-07` in the spike, review §0) with
`RedisIdempotencyStorage` (the package's `StorageAdapter` on the shared ioredis client).

| Case                                          | Response                                                  |
| --------------------------------------------- | --------------------------------------------------------- |
| no authenticated principal                    | `401 unauthenticated`, handler not run                    |
| key missing, shorter/longer than config, or not `[A-Za-z0-9_-:.]` | `400 idempotency_key_required`, handler not run |
| same key, same body, completed                | stored response replayed, handler not run                 |
| same key, different body                      | `422 idempotency_key_reused`                              |
| same key while the first is still running     | `409 idempotency_conflict` immediately (no waiting)       |
| handler threw (4xx or 5xx, incl. validation 422) | error stored and replayed; a fixed body with the same key → `422 idempotency_key_reused` |
| Redis error in `onRequest`                    | `503 service_unavailable` (fail-closed), handler not run  |

- Scope: `sha256([principal.type, principal.id, orgId|null, key])`, from `RequestContext` only (no
  header fallback; `X-Org-Id` has no effect). The package puts method and route template in the Redis
  key: `<REDIS_NAMESPACE>-idem:<METHOD>:<route template>:<scoped key>`. The fingerprint is the
  package's hash of the body (wrapped as `{ payload: body }` so arrays and empty bodies work).
- Atomicity: the package's `setIfNotExists` is one `SET key val PX ttl NX` — of N simultaneous
  duplicates exactly one runs (e2e burst test; a check-then-set mutation makes it fail).
- TTL: the in-progress lock and the stored response both expire after `IDEMPOTENCY_TTL_SEC` (or the
  route's shorter `ttlSec`); the storage refuses to write without a ttl. A process that dies mid-request
  leaves the key "in progress" until the TTL ends: retries with that key get 409, the client must use
  a new key. If storing the result fails after the handler ran, the response is still returned and an
  `error` is logged; the key then stays in progress until the TTL.
- Stored success: body + allowlisted headers (`IDEMPOTENCY_REPLAY_HEADERS`, default `location,etag`;
  `set-cookie` is refused by the config). Status is **not** stored: Nest applies the route's `@HttpCode`
  on replay, so handlers must not set the status dynamically.
- Stored errors: only the error **code**, `detail` (when the filter would expose it) and `fields`. On
  replay the filter renders a fresh problem+json (new `requestId`/`timestamp`).
- The interceptor runs before pipes, so validation failures are stored too (matches the draft).
- Rejected: `@nestjs-redisx/idempotency` (key optional, duplicates wait, errors not stored), AWS
  Powertools (re-runs the handler after an error), hand-written.

`ioredis`: `pnpm why ioredis` shows a single version (6.0.0, direct + bullmq), so no override.

## Verified APIs (node_modules `.d.ts`/source, 2026-09-25)

Packages: `helmet@8.3.0`, `@nestjs/swagger@12.0.2`, `@scalar/nestjs-api-reference@1.2.21`
(`1.2.22` was younger than `minimumReleaseAge`), with `@nestjs/common@12.1`, `zod@4.6.5`,
`@mikro-orm/core@7.2.1`.

- (a) `StandardSchemaValidationPipe` is exported by `@nestjs/common`
  (`pipes/standard-schema-validation.pipe.d.ts`), option `exceptionFactory(issues: readonly
StandardSchemaV1.Issue[])`. The issues are zod's own finalized issues (zod
  `toStandardResult` → `util.finalizeIssue`), so `code`, `format` and `path` are present.
- (b) `@Body/@Query/@Param({ schema })` store the schema as `metadata.schema` (route-params
  decorator `.d.ts`). `@nestjs/swagger@12` reads it (`standardSchema`), and converts it via
  `schema['~standard'].jsonSchema[input|output]({ target: 'openapi-3.0' })` unless a
  `standardSchemaConverter` is passed to `createDocument`. We pass one that uses
  `z.toJSONSchema(schema, { target: 'draft-2020-12', io })`, because the document is OpenAPI 3.1
  (`setOpenAPIVersion('3.1.0')`) and `nullable: true` is not valid there. Object `@Query` schemas are
  expanded into individual query parameters (`expandStandardSchemaParam`). `SchemaObject` and
  `StandardSchemaConverter` are exported from the package root.
- (c) `NestExpressApplication.useBodyParser('json', { type, limit })` registers `express.json(...)`
  (with `rawBody` from app options); Nest's `registerParserMiddleware` skips its default parser when a
  middleware named `jsonParser` already exists.
- (d) Express 5.2 `res.send` generates an ETag only when none is set and returns `304` when
  `req.fresh`.
- (e) MikroORM 7 `em.findByCursor(entity, options)` (two arguments) returns a `Cursor` with `items`,
  `hasNextPage`, `endCursor`; overfetch `limit + 1` is on by default. Details and failure modes in
  ADR 0012.
- (f) `apiReference({ content, cdn, nonce, pageTitle })`: `cdn` pins the script URL (UMD bundle),
  `nonce` is written on every script tag. `NestFactory.create(…, { preview: true })` does not
  instantiate providers (`injector.js`: `preview && !initOnPreview`), so config factories do not run;
  `pnpm openapi:export` works with an empty environment (verified).
- (g) `z.toJSONSchema(schema, { target: 'draft-2020-12', io })` exists in zod 4.6.
- (h) `@nestjs/throttler@6.7.0` (6.7.1 younger than `minimumReleaseAge`): `ThrottlerStorage.increment(key,
  ttl, limit, blockDuration, throttlerName)` receives **ms**; `ThrottlerStorageRecord` times are
  **seconds** (built-in storage `Math.ceil(ms / 1000)`); the record interface is not re-exported from
  the entry point. `ThrottlerGuard.getTracker(req)` is protected; the guard sets `Retry-After` from
  `timeToBlockExpire` and `X-RateLimit-*` itself, throws `ThrottlerException` (HttpException 429).
  `blockDuration` defaults to `ttl`. `SkipThrottle()` = `{ default: true }`.
- (i) `rate-limiter-flexible@11.2.1`: `RateLimiterRedis({ storeClient, useRedisPackage, keyPrefix,
  points, duration, blockDuration, insuranceLimiter })`; `consume` resolves `RateLimiterRes`
  (`consumedPoints`, `msBeforeNext`) and rejects with `RateLimiterRes` when over the limit; a store
  error with an insurance limiter calls `insuranceLimiter.consume` instead of rejecting with an `Error`
  (`RateLimiterInsuredAbstract._handleError`).
- (j) `@node-idempotency/core@1.1.0`: `new Idempotency(storage, { idempotencyKey, keyMaxLength,
  cacheKeyPrefix, cacheTTLMS, enforceIdempotency, inProgressStrategy })`; `onRequest({ headers, body,
  method, path, options })` returns the stored `IdempotencyResponse` (`{ body, additional, error }`) or
  `undefined`; `onResponse(req, res)`. `IdempotencyError.code` ∈ `IdempotencyErrorCodes`
  (`IDEMPOTENCY_KEY_LEN_EXEEDED`, `IDEMPOTENCY_KEY_MISSING`, `IDEMPOTENCY_FINGERPRINT_MISSMATCH`,
  `REQUEST_IN_PROGRESS`; a missing key is reported with `..._LEN_EXEEDED`, which is why the interceptor
  validates the key itself). `@node-idempotency/storage@1.0.5`: `StorageAdapter` has
  `setIfNotExists/set/get` (no `delete`), `ttl` in **ms**.
- Middleware wildcard: `forRoutes('{*path}')` (path-to-regexp 8 named wildcard; `'*'` still works
  through `LegacyRouteConverter`).

## Consequences

- `openapi.json` is regenerated by `pnpm build && pnpm openapi:export`; the output is deterministic
  (same hash on repeated runs) and is excluded from Prettier.
- Webhook routes (later sub-project) must opt out of `ContentTypeMiddleware` (spec §3).
- Scalar's inline init script is `JSON.stringify` of our own OpenAPI document; descriptions must not
  contain untrusted input.
