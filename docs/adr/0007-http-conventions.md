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
- Middleware wildcard: `forRoutes('{*path}')` (path-to-regexp 8 named wildcard; `'*'` still works
  through `LegacyRouteConverter`).

## Consequences

- `openapi.json` is regenerated by `pnpm build && pnpm openapi:export`; the output is deterministic
  (same hash on repeated runs) and is excluded from Prettier.
- Webhook routes (later sub-project) must opt out of `ContentTypeMiddleware` (spec §3).
- Scalar's inline init script is `JSON.stringify` of our own OpenAPI document; descriptions must not
  contain untrusted input.
