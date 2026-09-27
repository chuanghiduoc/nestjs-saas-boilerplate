# SP2 pre-execution review

## Round 1

# Review plan SP2 (trước khi thực thi) — 2026-09-27

**Verdict: Needs fixes** — 4 Blocker, 9 Important, 9 Minor. API SP1 được gọi (Db.execute, UnitOfWork, SafeEnqueue, defineJob/defineCron, JobContext, FieldCipher, RequestContext, defineConfigRule, redisClientOptions, ProblemDetailsFilter…) đều khớp `src/core`; API package đã đối chiếu research + tarball (`better-auth`, `better-call`, `@thallesp`, `@better-auth/api-key`, `jose`, `@bull-board/api`), entrypoint edoburu/pgbouncer và image postgres:18.6 (có `openssl`, user `postgres`).

## Blocker
- **B1 — Task 9, 36 (spec §1.15, §5.5):** `authRouteBodyParser` dùng `express.json`; body-parser 2.3.0 khi vượt `limit` gọi `dump(req)` và **chờ request kết thúc** mới `next(413)` (`body-parser/lib/read.js:128-137`). Body chunked vô hạn → không bao giờ có 413, socket bị giữ; test "413 chunked + Connection: close" của Task 9/36 treo. Route Nest dùng cùng parser (chunked 413 trên route Nest không có test). **Sửa:** tự đếm byte (listener `data` hoặc `raw-body` trực tiếp), vượt ngưỡng thì `writeProblem(413, Connection: close)` rồi `req.destroy()`/unpipe, không drain; áp cùng cơ chế cho parser route Nest và thêm test chunked cho route Nest.
- **B2 — Task 34, 36 (+ spike S4 Task 4; spec §1.8, §5.5 quy tắc 3–4):** Map lỗi chỉ nằm ở `hooks.after`, nhưng (a) rate limit IP của Better Auth trả `Response` 429 `{message}` + `X-Retry-After` ngay ở `onRequest` (không qua dispatch, `api/rate-limiter/index.mjs:64-69`); (b) lỗi storage rate limit và lỗi `checkSchema` bị ném ở `onRequest`, **ngoài** try/catch của router (`better-call/dist/router.mjs:100-102`) nên `auth.handler` reject; (c) lỗi không phải APIError trong endpoint bỏ qua after-hook; `onAPIError.onError` không được gọi trên đường dispatch nên `state.lastError()` luôn rỗng. Với thallesp, `next = () => handler(...)` (`index.mjs:892-896`) và `AuthMountMiddleware` gọi `next()` bỏ promise → **unhandled rejection làm sập process api** khi DB auth chập chờn; `.catch(next)` của sign-out bị thallesp bỏ qua lỗi và chạy tiếp sign-out gốc (báo thành công). Test Task 40 (429 Retry-After, 503 khi thu hồi quyền `rate_limit`) và Task 42 (cắt DB → 503) không thể xanh; fallback `customStorage` của S4 cũng ném ở `onRequest` nên cũng hỏng. **Sửa:** biến fallback S1c thành cơ chế chính: tự mount `try { res = await auth.handler(request) } catch (e) { isAuthInfraError(e) ? 503 : 500 problem+json }`, hậu xử lý mọi `Response` ≥400 không phải problem+json (đọc `code` từ body JSON, `X-Retry-After`→`Retry-After`, giữ `Set-Cookie`); sign-out lỗi → `writeProblem(503)` trực tiếp, không bao giờ `next(err)`; sửa S4 để đo đúng hành vi reject.
- **B3 — Task 17 (→ 43, 46, 50):** `buildSmokeEnv().infra` thiếu `DB_APP_STATEMENT_TIMEOUT_MS`, `DB_RELAY_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TX_TIMEOUT_MS`, `DB_AUTH_STATEMENT_TIMEOUT_MS`, `PGBOUNCER_MAX_PREPARED_STATEMENTS` mà `compose.yaml` nội suy; compose điền rỗng → `01-roles.sh` dừng ở `: "${…:?required}"` → Postgres không init, `up --wait` fail, mọi smoke prod-like không chạy. **Sửa:** thêm các khoá này (giá trị test) vào `infra` của `smoke-env.ts`; thêm assert `docker compose … config` không cảnh báo biến thiếu ở global-setup.
- **B4 — Task 34 (bảo mật, spec §1.9 / §5.8):** `hooks.before` của `/change-email` tra email đích và trả `202` **trước** khi endpoint chạy `sensitiveSessionMiddleware`; request ẩn danh nhận `202` nếu email tồn tại, `401` nếu không → oracle lộ email + spam thư "existing-account" tới nạn nhân. **Sửa:** chỉ xử lý nhánh email đã có khi `getSessionFromCtx(ctx)` trả session hợp lệ (và đủ mới); không có session thì để endpoint trả 401; thêm test ẩn danh với email có/không có phải giống hệt nhau.

## Important
- **I1 — Task 6, 21:** Handlebars escape cả `=` thành `&#x3D;`; assert `href="https://…/v?token=a&amp;x=1"` sẽ fail. **Sửa:** assert href đã decode HTML (hoặc `&#x3D;`), giữ escape mặc định.
- **I2 — Task 22:** SMTP chạy trong `ResiliencePolicies.single` có timeout aggressive `RESILIENCE_DEFAULT_TIMEOUT_MS` 10 s < `SMTP_SEND_DEADLINE_MS` 15 s (TaskCancelledError → `SMTP_TRANSIENT`, không phải `SMTP_TIMEOUT`); breaker dùng `isTransient` của SP1 nên đếm cả 550 → vài địa chỉ sai làm mở breaker cho mọi email. **Sửa:** ném `MailSendError` bên trong policy, bọc lỗi vĩnh viễn thành `UpstreamError` non-transient (hoặc policy riêng), thêm `RESILIENCE_OVERRIDES.smtp` + luật config deadline < timeout policy; test 550 liên tiếp không mở breaker.
- **I3 — Task 26 (`corePlugins`):** `keyExpiration.defaultExpiresIn` của `@better-auth/api-key` tính bằng **giây** (`getDate(…, "sec")`, `dist/index.mjs:820`); plan nhân 1000 → key hết hạn sau ~246 năm. Plugin mặc định `rateLimit` bật 10 request/ngày/key (`index.mjs:2334-2338`) → API key máy gần như không dùng được. **Sửa:** truyền giây; cấu hình `rateLimit` từ config (hoặc tắt, dựa throttler Nest); test hạn mặc định và >10 request.
- **I4 — Task 28:** `DBAdapter` có method generic (`create<T,R>`, `findOne<T>`, `findMany<T>`…); wrapper viết bằng lambda không generic và fake adapter trả object cụ thể sẽ không qua `pnpm typecheck`, trong khi Global Constraints cấm cast. **Sửa:** viết pass-through generic (`findOne: async <T>(d) => …inner.findOne<T>(d)`), dùng `memoryAdapter` của better-auth làm inner trong unit test.
- **I5 — Task 34, 40:** Đăng ký song song cùng email: Better Auth đổi 23505 thành `APIError 422 FAILED_TO_CREATE_USER` không cause (`api/routes/sign-up.mjs:223-232`), `lastError()` không bao giờ có 23505 → trả 422, lộ email và test "5 request đều 202" fail. **Sửa:** ở after-hook `/sign-up/email`, lỗi `FAILED_TO_CREATE_USER` thì tra `directory.findUserByEmail`; có user thì gửi notice + `202`.
- **I6 — Task 34, 38 (Review Focus 1):** Không có code chuẩn hoá email trước Better Auth; `z.email()` của sign-up từ chối `"  X@Y "` (422) nên test "differently cased email" (có khoảng trắng) fail. **Sửa:** before-hook cho `/sign-up/email`, `/sign-in/email`, `/request-password-reset`, `/send-verification-email`, `/change-email` trả `{ context: { body: { …, email: normalizeEmail(email) } } }`.
- **I7 — Task 37 (Review Focus 2):** `AuthGuard` trả `true` cho `@PublicRoute()` trước khi xét `REJECTED` → credential rỗng/sai vẫn vào route public như ẩn danh, trái cam kết của plan. **Sửa:** `REJECTED` → 401 cả ở route public (hoặc chặn ngay ở `PrincipalMiddleware`), thêm e2e với `x-api-key: ` trên route public.
- **I8 — Task 31, 32, 35, 36, 41 (spec §5.14):** Thiếu `identity_sign_in_total{result}`, `identity_lockout_blocked_total`, gauge pool auth, span `identity.authenticate` / `identity.jwt.verify` / `identity.lockout.consume` / `identity.registered.reconcile`; counter `identity_auth_unavailable_total` khai báo nhưng không bao giờ tăng. **Sửa:** thêm vào đúng task sở hữu kèm test đọc metric.
- **I9 — Task 1, 37:** `PrincipalMiddleware` áp `{*path}` gồm cả `/api/auth/*`; thứ tự so với handler thallesp chưa được đo (spike S1a không có Nest middleware nào) → sign-out cookie+bearer có thể bị 400, mỗi request auth tra session hai lần. **Sửa:** `.exclude(`${basePath}/{*path}`)` và thêm một Nest middleware ghi `seen` vào S1.

## Minor
- **M1 — Task 1:** `pnpm dlx renovate-config-validator` tải package placeholder `0.0.1-placeholder` → dùng `pnpm dlx --package renovate renovate-config-validator`; `excludePackageNames` đã bị bỏ → dùng `"!@better-auth/utils"` trong `matchPackageNames`.
- **M2 — Task 6, 26, 42:** Lệnh không chạy đúng: `docker run --entrypoint /nodejs/bin/node` trong Git Bash bị đổi path → thêm `MSYS_NO_PATHCONV=1`; Task 26 dùng `$DB_PORT_HOST`/`$PGBOUNCER_PORT_HOST` (nằm ở `.env.infra`) khi chỉ source `.env`; `pnpm test:chaos -- <file>` (và `pnpm test:int -- …` ở Task 1) không lọc file → dùng `pnpm vitest run --project chaos <file>`.
- **M3 — Task 2, 4, 5 (spike):** S2a assert `SELECT 1 FROM public.pg_class` resolves (sẽ lỗi) và kiểm rollback vô nghĩa vì `user.create.before` ném trước khi insert → ném ở `account.create.before`; S4a `await auth.handler` sẽ reject thay vì trả ≥500; S5 để trống bước OAuth callback/refresh.
- **M4 — Task 26:** SQL mẫu và `ANALYSED_COLUMNS` của `two_factor` thiếu `verified`, `failed_verification_count`, `locked_until` của Better Auth 1.7.6; ghi rõ SQL mẫu không có hiệu lực, cột lấy từ `pending.sql` rồi cập nhật §5.16b.
- **M5 — Task 32:** Test purge dùng `$1` cho cột uuid và text → `42P08`; ép kiểu `$1::uuid`, `$1::text`.
- **M6 — Task 36:** Interfaces ghi `SignOutHandler.handle(res, credentials, origin: Headers)`, code nhận `(res, credentials, origin?: string, meta, retryAfterSec)`; thống nhất một chữ ký.
- **M7 — Task 47:** Migration thiếu bảng chuẩn hoá ở chú thích đầu file (Global Constraints); `NOT VALID` + `VALIDATE` chạy trong một transaction của MikroORM nên không giảm khoá như chú thích → sửa chú thích hoặc tách migration.
- **M8 — Task 21, 34:** `Handlebars.compile` là lazy nên lỗi cú pháp `.hbs` không làm worker dừng lúc boot → render thử một lần hoặc `precompile`; thông báo "2FA turned on" gửi ở `/two-factor/enable` trước khi TOTP được xác nhận → gửi khi verify đầu tiên bật `twoFactorEnabled`.
- **M9 — Task 17, 46, logging:** `APP_ENV_FILE` ghi đường dẫn Windows có `\` vào file dotenv → ghi bằng `/`; subnet cố định `172.31.250.0/24` và `172.30.99.0/24` có thể trùng mạng WSL2/Docker Desktop → cho override và fail rõ ràng; token trong path `/api/auth/reset-password/<token>` vào log pino (serializer chỉ bỏ query) → che segment token.


## Round 2

# Re-review plan SP2 (sau khi sửa theo review trước thực thi) — 2026-09-27

**Verdict: Needs fixes** — 22 mục cũ: 21 addressed, 1 partially (M5). Mới: 1 Blocker, 2 Important, 3 Minor.

Nguồn đối chiếu: code trong từng task của plan (không chỉ bảng mapping); tarball đã giải nén ở scratchpad
(`better-auth@1.7.6`, `better-call@1.4.0`, `@better-auth/core@1.7.6`); `raw-body@3.0.2`, `src/core/http/http-bootstrap.ts` trong repo.

## 1. Trạng thái 22 mục cũ

| Mục | Trạng thái | Task | Ghi chú kiểm chứng |
|---|---|---|---|
| B1 | addressed | 9, 10, 36 | `jsonBodyParser` dùng `raw-body` (đã đọc `index.js`: `onData` vượt limit → `done(413)` + `halt`, không chờ `end`); 413 + `Connection: close` + destroy khi `finish`; test chunked cho unit (9), route Nest (10), `/api/auth/*` (36). Lỗi `next(err)` từ `app.use` đi vào exception handler global của Nest như body-parser cũ của SP1. |
| B2 | addressed | 1, 4, 34, 36 | Tự mount; `use()` bắt promise; `forward` try/await; reject → 503; `Response` ≥400 → problem+json, `X-Retry-After` → `Retry-After`, giữ `Set-Cookie`; ≥500 probe pool; sign-out tự xử lý, không `next()`. Xem NB1 (process vẫn có thể chết) và NI2 (spike S1 tự fail). |
| B3 | addressed | 17 | `buildSmokeEnv` lấy từ `.env.example`/`.env.infra.example` + preflight tên biến thiếu; `.env.infra.example` đã có 3 khoá timeout, Task 15 thêm `DB_AUTH_STATEMENT_TIMEOUT_MS`/`PGBOUNCER_MAX_PREPARED_STATEMENTS`. |
| B4 | addressed | 34 | Nhánh email đã có ở `/change-email` chỉ chạy khi `getSessionFromCtx` có session (và đã qua kiểm độ mới); test ẩn danh 401 giống hệt + không thư. |
| I1 | addressed | 6, 21 | So `href` sau decode HTML. |
| I2 | addressed | 18, 22 | Lỗi vĩnh viễn là kết quả trong policy; luật deadline < timeout provider `smtp`; test 550 không mở breaker, 451 có mở. |
| I3 | addressed | 26 | `defaultExpiresIn` giây; `rateLimit: { enabled: false }`. |
| I4 | addressed | 28 | Pass-through generic; `memoryAdapter` thật làm inner. |
| I5 | addressed | 34 | After-hook `/sign-up/email`: `FAILED_TO_CREATE_USER` (core `APIError.from`, `instanceof` đúng) → tra directory → 202. Xem NI1 cho các lỗi khác. |
| I6 | addressed | 34 | `hooks.before` trả `{ context: { body } }`; đã kiểm `dispatch.mjs`: context gộp (defu) vào `internalContext` TRƯỚC `endpoint()` — nơi better-call validate body. |
| I7 | addressed | 37 | `AuthGuard`: `REJECTED` → 401 cả route public; `UNAVAILABLE` → 503; switch exhaustive. |
| I8 | addressed | 27, 31, 32, 36, 37, 40, 41 | Đủ metric/span; `telemetry.e2e.spec.ts` đọc lại. |
| I9 | addressed | 1, 37 | `.exclude(basePath/{*path})`; S1 có middleware `{*path}` ghi `seen`. |
| M1 | addressed | 1 | `pnpm dlx --package renovate …`; `"!@better-auth/utils"`. |
| M2 | addressed | 6, 26, 42 | `MSYS_NO_PATHCONV=1`; Step 4 Task 26 source cả `.env.infra`; `pnpm vitest run --project chaos <file>`. |
| M3 | addressed | 2, 4, 5 | Ném ở `account.create.before`; S4a đo reject; S5 có bước callback. |
| M4 | addressed | 26 | Cột `verified`, `failed_verification_count`, `locked_until`; SQL mẫu ghi rõ không có hiệu lực. |
| M5 | **partially** | 32 | Plan áp đúng đề xuất cũ `$1::uuid, $1::text` — nhưng đề xuất đó sai (lỗi của review trước): cùng một tham số bị ép hai kiểu → Postgres báo `42P08 inconsistent types deduced for parameter $1`. Xem NM1. |
| M6 | addressed | 36 | Một chữ ký `handle(res, credentials, { origin?, meta, retryAfterSec })`. |
| M7 | addressed | 47 | Bảng chuẩn hoá + chú thích khoá đúng (`allOrNothing` giữ ACCESS EXCLUSIVE tới commit). |
| M8 | addressed | 21, 34 | `precompile` lúc boot; thông báo 2FA sau verify đầu tiên. |
| M9 | addressed | 14, 17, 46 | `APP_ENV_FILE` dùng `/`; `SMOKE_SUBNET` override + kiểm CIDR; che token trong path. |

## 2. Thiết kế tự mount (R36)

**a. Node → Web `Request` (Task 36 `forward`)** — Đạt.
- URL = origin của `AUTH_BASE_URL` + `req.originalUrl`; method giữ nguyên; header qua `toWebHeaders` (mọi `req.headers`, mảng thì `append`).
- Body = `req.rawBody` (Buffer do `jsonBodyParser` đặt sau credential + CSRF); GET/HEAD/không body → `undefined` (không vướng lỗi "GET có body" của `Request`). Giới hạn theo stream như B1. Header `transfer-encoding`/`content-length` gốc đi kèm nhưng better-call đọc body từ Buffer nên vô hại.
- IP tin cậy: xoá `x-app-client-ip` client gửi, đặt `req.ip` (Express theo `HTTP_TRUST_PROXY`); `advanced.ipAddress.ipAddressHeaders = ['x-app-client-ip']` nên XFF của client bị bỏ qua. Đã đọc `@better-auth/core/utils/ip.mjs`: một giá trị hợp lệ được nhận và chuẩn hoá (`::ffff:a.b.c.d` → IPv4); giá trị rỗng → `null` → production dùng bucket chung `no-trusted-ip` (chỉ khi `req.ip` rỗng — biên, chấp nhận được).

**b. Web `Response` → Node** — Đạt.
- `copy()` (2xx/3xx/problem+json do hook): giữ status, mọi header trừ `set-cookie` bằng `setHeader`, rồi `getSetCookie()` → `appendHeader` từng cookie → nhiều `Set-Cookie` giữ nguyên; `Location` của 3xx giữ nguyên (redirect của better-call là `APIError("FOUND")` → `Response` 302).
- Nhánh lỗi: đọc `code`, giữ `Set-Cookie`, `X-Retry-After` → `Retry-After`.
- Streaming: body được buffer (`arrayBuffer`/`text`). Better Auth 1.7.6 với các plugin đang dùng không trả stream/SSE, nên chấp nhận; ghi vào ADR như giới hạn đã biết là đủ.

**c. Bọc lỗi** — Đủ cho promise: `use()` `.catch` → 500 problem; `writeProblem` khi header đã gửi thì `destroy`; reject của `auth.handler` → 503; probe pool dùng `then(ok, fail)`; `SignOutHandler` try/catch toàn bộ. Không còn đường unhandled rejection. **Nhưng** pool `auth_user` không có listener `'error'` → xem NB1 (uncaught exception, cũng làm sập process).

**d. CORS / trustedOrigins** — Đạt. `enableCors` của SP1 là middleware Express cấp app, đăng ký trước middleware Nest → preflight `/api/auth/*` trả ở đó; test có cả origin tin cậy và lạ. `trustedOrigins` của Better Auth = `trustedOriginList(corsOrigins, baseUrl)`, cùng danh sách với CSRF của mount và `PrincipalMiddleware`.

**e. Dấu vết thallesp** — Sạch. Không cài (Task 1 Step 2 liệt kê là không được có), không import, không có trong luật kiến trúc (Task 16, spec §7). Chỉ còn trong đoạn giải thích quyết định (plan Task 1/ADR 0010, spec §2/§5.5) và bản ghi nghiên cứu spec A.8/A.8b — hợp lý.

**Đối chiếu API Better Auth (tarball 1.7.6 / better-call 1.4.0):**
- 429 IP: `rateLimitResponse` trả `Response` 429 `{message}` + `X-Retry-After` (`api/rate-limiter/index.mjs`) — đúng.
- `onRequest` (disabledPaths → `checkSchema` → rate limit → plugin) chạy trong `handler` của router, ngoài try/catch của `processRequest` (`better-call/dist/router.mjs`) → reject — đúng.
- `customStorage` thay toàn bộ quyết định (`getRateLimitStorage` trả thẳng nó; `onRequestRateLimit` chỉ đọc `{allowed, retryAfter}`) — liên quan NI2.
- Before-hook trả `Response` → short-circuit qua `toResponse`; after-hook trả giá trị → thay `returned` (`api/dispatch.mjs`) — đúng như Task 34 dùng.

## 3. Phát hiện mới

### Blocker
- **NB1 — Task 27 (`createAuthPool`), hệ quả Task 36/42:** `new pg.Pool(...)` không gắn `pool.on('error', …)` (grep plan: không có chỗ nào). Khi một connection rảnh bị đứt (PgBouncer restart, `pg_terminate_backend`, mạng chập — đúng kịch bản toxiproxy `setEnabled(false)` của Task 42), `pg-pool` phát `'error'` trên pool; không có listener → uncaught exception → **api sập**, đúng loại lỗi mà B2/R36 muốn loại bỏ. Kysely/Better Auth/`RateLimiterPostgres` không gắn listener thay. SP1 luôn gắn `'error'` cho emitter khác (`redis.module.ts:62`, `bullmq-job-queue.ts:83`). **Sửa:** trong `createAuthPool` (hoặc `AuthPoolLifecycle`) gắn listener log `warn` có cấu trúc (`event: 'auth_pool_idle_error'`, không PII); thêm test integration: mở connection, `pg_terminate_backend` các backend của `auth_user` bằng owner, kiểm process sống và request kế tiếp trả 200/503 chứ không crash.

### Important
- **NI1 — Task 34 (`after` hook):** `failed = returned instanceof APIError && …` với `APIError` từ `better-auth/api` (= lớp con trong `@better-auth/core/error`). Lỗi validate body do better-call ném là `APIError` của better-call (lớp cha: `better-call/dist/endpoint.mjs:24`, `code: "VALIDATION_ERROR"`), cũng như `ctx.error(...)` (`better-call/dist/context.mjs:65`, dùng ở `routes/session.mjs`, `routes/account.mjs`). `instanceof` lớp con trả `false` → sign-up thiếu `name` hoặc `email` sai định dạng (`signUpEmailBodySchema`: `name: z.string()`, `email: z.email()`) được after-hook trả **202 rỗng** thay vì 400 — người dùng tưởng đã gửi thư; tương tự `/change-email` sai định dạng. **Sửa:** dùng `isAPIError` (export của `better-auth/api`, kiểm cả hai lớp) + `statusCode`; thêm test: sign-up thiếu `name` → 400 `validation_failed` problem+json qua mount.
- **NI2 — Task 1 spike S1 (c)/(i):** `customStorage.consume` luôn trả `{ allowed: true }`, mà với `customStorage` Better Auth giao toàn bộ quyết định cho `consume` (bỏ qua `customRules` max 2). `r3` sẽ là 401, không phải 429 → assert (i) fail → tiêu chí đạt của S1 hỏng → plan rẽ sang "fallback thallesp, dừng hỏi Sếp" dù tự mount đúng. **Sửa:** `consume` tự đếm theo `key` với `rule.max`/`rule.window` (trả `retryAfter`), chỉ ném khi `storageFails`; hoặc dùng `storage: 'memory'` cho phần 429 và một instance riêng có `customStorage` ném cho phần reject.

### Minor
- **NM1 — Task 32 (M5):** `VALUES ($1::uuid, $1::text, …)` → `42P08`. Dùng `$1::uuid, $1::uuid::text` (tham số suy ra kiểu uuid rồi cast) hoặc truyền token thành tham số riêng.
- **NM2 — Task 36:** 503 do hook tự tạo (lockout storage lỗi, Task 34) đi qua `copy()` nên không tăng `identity_auth_unavailable_total`; `recordSignIn` vẫn đúng. Tăng counter trong `copy()` khi status 503, hoặc ghi rõ phạm vi counter.
- **NM3 — Task 9 (rủi ro test chập chờn):** `req.socket.destroy()` ngay khi `finish` trong lúc client vẫn đang gửi → kernel có thể gửi RST và client mất 413 đã nhận (ECONNRESET, `status = 0`) trên Linux CI. S1g đo đúng điểm này; nếu chập chờn thì dùng `socket.end()`/`destroySoon` sau `finish` và giữ assert "socket đóng trong `MAX_413_MS`".

## 4. Blocker mới do bản sửa gây ra?

Không có Blocker nào do chính bản sửa gây ra. NB1 là lỗ hổng có từ trước (review đầu bỏ sót), nhưng nó làm hỏng mục tiêu "process sống" của R36/B2 và làm Task 42 fail, nên xếp Blocker.
