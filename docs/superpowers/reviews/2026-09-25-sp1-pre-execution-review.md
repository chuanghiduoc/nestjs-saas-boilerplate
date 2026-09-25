# Review trước khi thực thi: sub-project 1 và kiến trúc tổng thể

- **Ngày:** 2026-09-25
- **Nguồn:** 3 review độc lập, chỉ đọc tài liệu, không sửa file:
  - **S** = bảo mật thiết kế (threat model)
  - **D** = dependency (OSV + `npm audit` trên 1.114 package, mức độ bảo trì, license, peer)
  - **P** = tính đúng của plan (đối chiếu API với tarball `latest` trên npm)
- **Trạng thái:** Sếp đã chốt ngày 2026-09-25 (xem mục 0). Spec cha và spec sub-project 1 đã cập nhật; plan được cập nhật riêng.
- **Kết luận chung:**
  - Không có CVE nào.
  - Không có package nào bị bịa ra.
  - Thiết kế có nhiều điểm tốt đã được xác nhận.
  - Có **6 lỗi chặn thực thi (blocker)** trong plan, 1 lỗ hổng nghiêm trọng (SSRF), và một loạt vấn đề High về cô lập tenant, idempotency và vận hành.

Mã trong ngoặc là ID gốc của từng review, dùng để truy ngược.

## 0. Quyết định đã chốt (2026-09-25)

| # | Vấn đề | Quyết định |
|---|---|---|
| Q1 | Cache (`bentocache` có bug với ioredis 6) | Chọn `@nestjs/cache-manager` + `cache-manager` 7 + `@keyv/redis` (thêm client `redis`, chấp nhận). **Không code trong SP1**, làm ở sub-project đầu tiên có use case. Bỏ `bentocache` |
| Q2 | Rate limit (`@nest-lab/throttler-storage-redis` không còn phát triển) | `@nestjs/throttler` + `rate-limiter-flexible` (10,5 triệu lượt/tháng, chạy trên ioredis, có `insuranceLimiter` khi Redis sập). Storage cài qua interface `ThrottlerStorage` của Nest. Bỏ `@nest-lab/*` và lớp fail-open tự viết |
| Q3 | Idempotency khi lỗi / không đúng chuẩn | Chọn **`@node-idempotency/core`**: bám IETF `draft-ietf-httpapi-idempotency-key-header-07` nhất (spike bên dưới). Interceptor mỏng trong `core/http` + storage trên ioredis qua interface `@node-idempotency/storage`. Response (kể cả lỗi) được lưu và trả lại; client sửa request thì dùng key mới. Bỏ `@nestjs-redisx/*` |
| Q4 | PII trong response lưu cho idempotency | Chỉ lưu header trong allowlist, không bao giờ lưu `Set-Cookie`; TTL theo nhóm route, route tiền TTL ngắn hơn |
| Q5 | `standardwebhooks` | Giữ (phổ biến, không có CVE), theo dõi qua Renovate |
| Q6 | Cài bản vừa publish | Bật pnpm `minimumReleaseAge` 1 ngày, Renovate 3 ngày |
| — | SSRF | `undici` `Agent` + `connect.lookup` + `ipaddr.js`. Bỏ `request-filtering-agent` |

**Spike idempotency** (NestJS 12.1 + Redis 8.8 thật, cùng một bộ kịch bản; code spike là đồ bỏ đi, không nằm trong repo):

| Kịch bản | Draft yêu cầu | `@nestjs-redisx/idempotency` | `@node-idempotency` | AWS Powertools |
|---|---|---|---|---|
| Cùng key, cùng body | trả lại response | ✅ 201/201, handler 1 lần | ✅ 201/201, handler 1 lần | ✅ (khi tắt kiểm tra payload) |
| Cùng key, khác body | 422 | ✅ 422 | ✅ 422 | ❌ bật kiểm tra payload thì replay hợp lệ cũng bị báo lệch |
| Request trùng đang chạy | 409 | ⚠️ chờ rồi trả 201 | ✅ 409 | ✅ ném `IdempotencyAlreadyInProgressError` (cần map ra 409) |
| Thiếu key | 400 | ❌ vẫn chạy handler (201) | ✅ 400, không chạy handler | phải tự làm ở lớp nối |
| Handler lỗi, gửi lại cùng key | client phải dùng key mới | 500 rồi 409 (khoá khoảng 30 giây) | ✅ trả lại đúng lỗi cũ, không chạy lại | ❌ chạy lại handler |
| Validate lỗi rồi sửa body, cùng key | 422 (payload đã khác) | 400 → 422 | ✅ 400 → 422 | ❌ 400 → 201 |


---

## 1. Blocker: plan chạy sẽ hỏng (sửa bắt buộc, không cần quyết) — đã đưa vào spec/plan

| # | Vấn đề | Hậu quả | Cách sửa |
|---|---|---|---|
| 1.1 | Mọi SQL thô dùng `getConnection().execute()`. Hàm này chạy trên connection của pool ở chế độ autocommit, **không nằm trong transaction và không có session RLS** (P-B1) | Outbox không atomic với dữ liệu, `SKIP LOCKED` nhả khoá ngay nên relay gửi trùng, inbox không atomic, RLS không được áp. Nhiều test sẽ fail | Dùng `em.execute(sql, params)` (`tx.execute` trong relay) ở mọi chỗ |
| 1.2 | `TxEm` inject `EntityManager` theo class, nhưng khi có `contextName` thì chỉ có token theo tên. `getContext()` ném lỗi khi không có RequestContext (worker, job, test) (P-B2) | App không khởi động được | `@InjectEntityManager(DB_CONTEXT.app)`. `UnitOfWork` tự `fork()` khi chưa có EM gắn trong context |
| 1.3 | `createTestApp({ http: false })` bỏ qua `init()` (P-B3) | Worker, relay, scheduler không chạy, test timeout | Luôn gọi `init()`. Tách một cờ riêng cho "không listen" |
| 1.4 | Tham số `logger` có giá trị mặc định trong constructor của `ProblemDetailsFilter` (P-B4) | Nest không resolve được DI, mọi app đều không khởi động | Chuyển logger thành field của class |
| 1.5 | Test gọi `runMigrations` trước khi có env. Phần "gộp thư mục migration" không có code, trong khi `migrations.path` của MikroORM chỉ nhận **một** chuỗi (P-B5) | Test phụ thuộc thứ tự chạy, bảng fixture lúc có lúc không | Migrate core và fixture một lần trong `globalSetup` (hoặc qua helper `migrateTestDb()`). Viết code chạy migrator lần hai cho thư mục fixture |
| 1.6 | `nest build` chỉ biên dịch `src/`, nên `dist/db/migrations` và `dist/scripts` không tồn tại (P-B6) | `migrate up` trong Docker "thành công" nhưng không áp dụng migration nào | Chọn layout ngay: đặt migration trong `src/`, hoặc cấu hình `outDir` rõ ràng. Cập nhật mọi đường dẫn. Bật `preferTs` khi chạy Vitest |

## 2. Critical / High: bảo mật và cô lập tenant (sửa bắt buộc) — đã đưa vào spec/plan

| # | Vấn đề | Cách sửa (ưu tiên thứ có sẵn) |
|---|---|---|
| 2.1 | **SSRF:** `request-filtering-agent` chỉ gắn vào `http.Agent`. `fetch` của Node (undici) **bỏ qua** agent đó, nên phần chặn SSRF không có tác dụng. Package này cũng vừa có lỗ hổng HIGH làm crash process (S-C01, D-9) | Dùng `Agent` của **undici** với `connect.lookup` kiểm tra IP **sau khi resolve DNS** (chặn cả DNS rebinding), phân loại IP bằng `ipaddr.js`. Chặn loopback, RFC1918, link-local, IPv6 ULA, IPv4-mapped. `redirect: 'manual'`, giới hạn port và kích thước response. Test cho từng kiểu bypass. Bỏ `request-filtering-agent` |
| 2.2 | Scope của idempotency giả mạo được qua `X-Org-Id`, mọi request ẩn danh dùng chung scope `anonymous`, user trong cùng org dùng chung key. `keyExtractor` đọc `req.principal` chứ không đọc CLS (S-H01) | Scope chỉ lấy từ principal đã xác thực: `type:id:org`, cộng method và route. **Bỏ fallback header.** Route `@Idempotent()` mà không có principal thì từ chối |
| 2.3 | Role `app_admin` (BYPASSRLS) có mặt ở mọi process, kể cả api, và được dùng cho những bảng vốn không có RLS (S-H02). Code dùng admin EM lại import MikroORM ngoài `core/database` (P-H3) | Tạo role hẹp `app_relay` (không BYPASSRLS) cho outbox/inbox/schedule. Không tạo admin context trong api. Admin SQL đi qua **port trong `core/database`** |
| 2.4 | `app_user` được SELECT/UPDATE/DELETE trên `outbox_events` và `processed_events`, bảng không có RLS nhưng chứa payload của mọi org. `scheduled_tasks` có `org_id` mà không bật RLS (S-H03) | `app_user` chỉ được INSERT vào outbox. Bật RLS cho `scheduled_tasks`. Grant theo từng bảng trong migration, bỏ `ALTER DEFAULT PRIVILEGES` cấp tràn lan (S-M18, cũng để giữ audit chỉ-thêm) |
| 2.5 | Lịch của tenant chọn được **bất kỳ job nào** (kể cả cleanup, billing), không mang `orgId`, cho phép cron theo giây (S-H04) | Chỉ job có cờ `tenantSchedulable` mới được đặt lịch. Scheduler gắn `meta.orgId`. Giới hạn chu kỳ tối thiểu. Validate `key` |
| 2.6 | `statement_timeout` truyền qua startup parameter nên **mất khi đi qua PgBouncer**. Test kết nối thẳng Postgres nên không phát hiện. Option `driverOptions.connection` là cấu trúc của knex cũ (S-H05, P-M15) | `ALTER ROLE … SET statement_timeout` và `idle_in_transaction_session_timeout`, hoặc `SET LOCAL` đầu mỗi transaction. Test chạy qua PgBouncer |
| 2.7 | Fail-closed của RLS: session trong pool đã từng `set_config` thì `current_setting` trả chuỗi rỗng thay vì báo lỗi (P-H1) | Viết hàm SQL `app_current_org()` ném lỗi khi giá trị rỗng, dùng trong mọi policy |
| 2.8 | `OrgScope.run` gọi bên trong một `UnitOfWork` đang mở không áp được org (session chỉ set lúc `BEGIN`), hoặc mở transaction thứ hai (P-H2, S-M10) | Ném lỗi khi gọi trong transaction đang mở mà lệch org. Có test lồng nhau |
| 2.9 | Chưa có TLS và xác thực cho Postgres/Redis. Redis trong compose không có mật khẩu và mở port ra mọi interface (S-H06) | Config `DB_SSL_MODE` + CA. Production bắt buộc `rediss://` + ACL user. Compose bind `127.0.0.1` |
| 2.10 | `SafeEnqueue` gọi Redis trực tiếp **bên trong transaction**: job có thể chạy trước khi commit hoặc sau khi rollback, hoặc chạy 2 lần khi bị timeout (S-H09, P-H12) | Trong transaction thì **luôn** ghi outbox. jobId sinh một lần rồi dùng lại |
| 2.11 | Proxy/IP: `trust proxy` mặc định `loopback`, nên sau ingress mọi client dùng chung một bucket. Throttler áp cả lên `/health` và `/webhooks/sepay` (bị 429 là mất thanh toán) (S-H12, P-H10) | Parse `HTTP_TRUST_PROXY` thành số hop hoặc danh sách CIDR. Override `getTracker` theo principal/org. `@SkipThrottle()` cho health và webhook |
| 2.12 | `main.migrate down <to>` với tên sai sẽ **revert toàn bộ DB** (P-H13) | Kiểm tra `to` có trong danh sách migration đã chạy. Muốn revert hết phải ghi `0` rõ ràng. Có test |
| 2.13 | Bull Board chỉ được bảo vệ bằng một API key tĩnh và chưa có task nào trong plan (S-H11, P-M17) | Bỏ khỏi SP1. Làm ở SP2 sau RBAC admin, chế độ read-only, chỉ mở trên port nội bộ |

## 3. High: vận hành và đúng đắn (sửa bắt buộc) — 3.1–3.5 đã đưa vào spec/plan; 3.6–3.8 chuyển sang SP2 (đã ghi vào spec cha mục 4.1 và 11)

| # | Vấn đề | Cách sửa |
|---|---|---|
| 3.1 | `instrumentation.ts` đọc `appConfig`, mà config này bắt buộc `APP_ROLE`. `APP_ROLE` chỉ được set sau đó, nên image crash khi khởi động (P-H4) | `otelConfig` có env riêng, không phụ thuộc `appConfig` |
| 3.2 | `@opentelemetry/sdk-metrics` chưa cài, còn `sdk-trace-base` cài dạng dev nên bị prune khỏi image (P-H5) | Cài thành dependency production, hoặc dùng re-export từ `sdk-node` |
| 3.3 | `openapi.ts` chưa được định nghĩa. Export OpenAPI cần DB và Redis. `oasdiff` không có file gốc ở PR đầu tiên (P-H6) | Viết `openapi.ts`. Export bằng `preview: true` + env giả. Commit `openapi.json` |
| 3.4 | Test entrypoint thiếu env bắt buộc của các task sau. `start:false` vẫn khởi động toàn bộ (P-H9) | Dùng `baseTestEnv()`, bỏ cờ `start` |
| 3.5 | Test e2e ở Task 4 thiếu import `Post` và `Body` (P-H11) | Thêm import |
| 3.6 | Rate limit đăng nhập của Better Auth mặc định lưu trong bộ nhớ từng pod và tin header IP (S-H08) | Ghi vào spec SP2: `rateLimit.storage` dùng Redis/DB, cấu hình header IP tin cậy, khoá theo tài khoản, fail-closed |
| 3.7 | Bảng của Better Auth (session token, OAuth token) đọc được bằng `app_user` (S-H07) | Ghi vào spec SP2: role `auth_user` riêng, revoke khỏi `app_user`, mã hoá token |
| 3.8 | Định danh ngoài: liên kết tài khoản theo `(provider, subject)` dễ đụng nhau giữa các issuer. `jose` chưa pin `issuer`/`audience`/`algorithms`. API key/service token chưa gắn với org (S-H10) | Ghi vào spec SP2: `UNIQUE(issuer, subject)`, không liên kết qua email chưa xác minh, pin các tham số khi verify, API key có allowlist org |

## 4. Cần Sếp quyết — đã chốt, xem mục 0

| # | Vấn đề | Lựa chọn | Đề xuất |
|---|---|---|---|
| Q1 | **`bentocache`** có bug đang mở: khi nhận instance ioredis 6 dùng chung, nó âm thầm kết nối tới `127.0.0.1`. Không có bản mới từ 02/2026 (D-1) | (a) giữ, nhưng chỉ truyền connection options (nó tự mở kết nối ioredis 5 riêng); (b) `@nestjs/cache-manager` (chính thức, nhưng thêm client `redis`, không có bus xoá L1 giữa các pod); (c) `@nestjs-redisx/cache` (cùng hệ với idempotency, hỗ trợ Nest 12, ioredis, L1+L2, chống stampede); (d) **bỏ cache khỏi SP1** | **(d)**. SP1 không dùng cache ở đâu và spec nói "mặc định không cache". Chọn thư viện khi có use case đầu tiên. Nếu phải chọn ngay thì (c) |
| Q2 | **`@nest-lab/throttler-storage-redis`**: không hoạt động từ 02/2026, 1 người maintain, import đường dẫn nội bộ, có kiểm tra `instanceof ioredis` (D-2). Wrapper fail-open đang nuốt mọi lỗi (S-M09) | (a) giữ (spike đã chạy), pin version, chỉ fail-open với lỗi kết nối; (b) implement interface `ThrottlerStorage` có sẵn của `@nestjs/throttler` trên ioredis dùng chung (đây là extension point chính thức của framework); (c) `@nestjs-redisx/rate-limit` (855 lượt tải/tháng) | **(a)** theo quy tắc ưu tiên package. Sửa fail-open chỉ bắt lỗi kết nối. Dùng pnpm `overrides` để cả cây chỉ có **một** bản ioredis |
| Q3 | **Idempotency khi lỗi:** interceptor chạy trước pipe, nên lỗi validate 422 cũng khoá key. Record failed chỉ sống bằng `lockTimeout` (30 giây), sau đó gọi lại thì handler **chạy lại**. Thư viện tự đăng ký exception filter riêng, không tắt được (P-H7, P-H8, S-M01) | (a) chấp nhận hành vi thư viện và ghi vào spec: 4xx cũng khoá key, sau 30 giây được chạy lại; (b) validate body trong **guard** cho route `@Idempotent()` (guard chạy trước interceptor, là cơ chế có sẵn của Nest), để 422 xảy ra trước khi giữ key; (c) đổi thư viện | **(b)**, cộng test cho "lỗi 5xx rồi gọi lại sau lockTimeout". Map đủ mọi class lỗi của thư viện. Test thứ tự filter để đảm bảo response ra problem+json |
| Q4 | Response lưu cho idempotency chứa PII, nằm plaintext trong Redis 24 giờ (S-M02) | (a) chỉ lưu những header trong allowlist, không bao giờ lưu `Set-Cookie`, rút ngắn TTL cho route tiền; (b) mã hoá body đã lưu | **(a)** |
| Q5 | **`standardwebhooks`** phụ thuộc `fast-sha256` (không cập nhật từ 2020) thay vì `node:crypto` (D-8) | (a) giữ; (b) tự ký HMAC bằng `node:crypto` theo đúng chuẩn Standard Webhooks (khoảng 20 dòng, cần ADR) | **(a)**. Package rất phổ biến (94 triệu lượt/tháng) và không có CVE. Theo dõi qua Renovate |
| Q6 | Chính sách cài bản mới: cài "latest" ngay khi vừa publish là cửa sổ của các vụ package bị chiếm quyền (S-M20) | Bật `minimumReleaseAge` của pnpm (ví dụ 1 ngày) và Renovate 3 ngày | **Bật.** Latest vẫn là mặc định, chỉ chờ thêm 1 ngày. Việc này điều chỉnh quy tắc "latest" của Sếp, nên cần Sếp đồng ý |

## 5. Medium / Low: sửa trong plan (không cần quyết) — đã đưa vào spec/plan, trừ nhóm "Ghi vào spec cho các sub-project sau" (chuyển sang SP2+, đã ghi vào spec cha)

**Cô lập tenant và dữ liệu**
- Redis dùng chung cho queue, idempotency và cache mà không có chính sách bộ nhớ. Tách instance hoặc DB. Queue và idempotency dùng `noeviction`. Thêm `removeOnFail.count` (S-M03)
- Key cache bắt buộc có org và env, và phải escape các phần (S-M11)
- Job chưa chạy trong `OrgScope`. Relay dùng `correlationId` thay vì `requestId: 'none'` (P-M6)

**Crypto và secret**
- `FieldCipher`: bắt buộc `authTagLength: 16`. AAD gắn `table:column:orgId:pk`. Sửa chữ "envelope" trong spec cho đúng, hoặc làm envelope thật bằng KMS (S-M04)
- Parse JSON của khoá mã hoá an toàn, để lỗi parse không làm lộ khoá vào log (S-M05, P-M4)

**Lỗi và log**
- Serializer lỗi trong log bỏ `query`/`params`/`detail`. Production không cho bật `DB_DEBUG` hay `HTTP_DOCS_ENABLED` (S-M06)
- Danh sách redact: thêm `set-cookie`, `x-api-key`, `x-sepay-signature`, các loại token… Danh sách gốc cố định, env chỉ được thêm vào. Bỏ query string khỏi `req.url` (S-M07)
- Log của job cũng phải có context: dùng pino `mixin()` (P-M5)
- `traceparent` và `requestId` do client gửi: lấy mẫu độc lập ở biên, giữ id của client trong một field riêng (S-M08)

**Transaction và I/O**
- Không gọi I/O ra ngoài bên trong transaction. `Inbox.once` chỉ dùng cho side effect trong DB (S-M12)
- `HttpClient` chỉ retry method idempotent (P-M7)

**Phân trang**
- Đếm có trần bằng subquery `LIMIT cap+1`. Escape đầu vào của `LIKE` (S-M13)
- `hasMore` khi vượt trần phải tính tới `maxOffsetRows` (P-M20)
- Chữ ký `findByCursor` của v7 là 2 tham số. Cursor sai thì bắt lỗi ở repo rồi ném `invalid_cursor` (P-M1). Có thể ký HMAC bọc cursor để tránh `22P02` (S-L01)

**Config**
- `renderEnvExample` in ra giá trị gốc chưa qua transform (P-M2)
- Validate toàn bộ config một lần lúc khởi động (P-M3)

**Scheduler và cron**
- `reconcile()` upsert lại mọi dòng đang bật (P-M8)
- Không xoá cron tĩnh khi đang rolling deploy (P-M9)
- Test đếm số lần chạy theo từng mốc thời gian (P-M10)
- Cleanup outbox xoá theo batch (P-M14)
- Relay chạy vòng tiếp ngay khi batch đầy (P-M21)

**Test**
- Test relay dùng batch nhỏ để thật sự kiểm tra `SKIP LOCKED` (P-M11)
- Test kill worker phải chờ worker báo "đã bắt đầu" (P-M12)
- Mỗi file test dùng prefix Redis riêng, bỏ các `sleep` (P-M13)
- Test SIGTERM phải gửi SIGTERM thật (P-L4)

**Build và CI**
- Dockerfile: kiểm tra `.npmrc` / `pnpm-workspace.yaml` thực tế (P-M16). Không `COPY .npmrc`. Build release không dùng cache của PR (S-M19)
- Thêm gitleaks, osv-scanner, CodeQL vào CI (S-M19)
- Luôn cài `@swc-node/register` (P-M18). Sửa bước `sed` trong CI (P-M19)
- `@mikro-orm/nestjs` có version riêng (7.1.0), bỏ điều kiện "mọi package cùng version" (D-②)
- Allowlist build script: chỉ `@swc/core`, `msgpackr-extract`, `protobufjs`; chặn `@scarf/scarf` (D-①)
- Pin chính xác các major vừa ra (`unplugin-swc` 2.0, `nestjs-cls` 7.0) (D-10)

**Ghi vào spec cho các sub-project sau**
- Upload file dùng presigned POST có `content-length-range`, `Content-Disposition: attachment`, domain riêng, `limitInputPixels` cho sharp (S-M14)
- Thu hồi quyền có hiệu lực ngay: tắt `cookieCache`, bỏ qua cache cho các ability nhạy cảm (S-M15)
- SePay: kiểm tra `accountNumber`, regex neo đầu cuối, lưu payload sau khi đã verify, bỏ webhook khỏi throttler (S-M16)
- Billing: state machine cho giao dịch, khoá và kiểm tra số tiền khi gán tay, chỉ một invoice mua lần đầu đang mở cho mỗi org (S-M17)
- `email_taken` trên flow công khai làm lộ email có tồn tại hay không (S-M21)
- Mã thanh toán sinh từ CSPRNG, có check digit (S-L06)
- Merge Patch với field lồng nhau và `null` (S-L07)
- Xác minh chữ ký image khi deploy (S-L09)
- Kế hoạch xoay khoá JWKS / API key / secret ký webhook (S-L04)

**Dependency phải để ý**
- `@nestjs-redisx/*` không khai báo ioredis: dùng pnpm `packageExtensions` hoặc `overrides` (D-3)
- Scalar tải script từ CDN không pin version: pin theo version hoặc tự host (D-5)
- `@better-auth/sso` kéo `samlify`/`xmldom`: chỉ cài khi thật sự cần SAML (D-6)
- Handlebars: cấm biên dịch template do tenant cung cấp (D-7)
- sharp mang theo binary libvips giấy phép LGPL-3.0: báo pháp chế (D-10)

**Lặt vặt**
- Bỏ các cast `as never`
- Key prefix cho client Redis dùng chung
- Flush OpenTelemetry sau khi app đóng
- Lệch tên interface giữa spec và plan
- Filter đang dùng `res.type` riêng của Express
- Compose `REDIS_URL`
- (P-L1…L8)

## 6. Những điểm đã được xác nhận là tốt

- RLS fail-closed với FORCE, context theo transaction, có test không rò context sang unit of work sau.
- Role lúc chạy không phải owner và không có BYPASSRLS. Migration chạy bằng role owner riêng. Mật khẩu truyền vào psql bằng biến, không nối chuỗi.
- Response lỗi không lộ message của lỗi 5xx lạ, không lộ tên constraint. Vi phạm RLS trả 404 kèm log bảo mật.
- Request id vào được kiểm tra định dạng, chặn log injection.
- HMAC trên raw body, `timingSafeEqual` trên Buffer cùng độ dài, UNIQUE trên id của webhook.
- Outbox/inbox atomic (sau khi sửa 1.1), relay dùng `SKIP LOCKED`, có chaos test cho Redis sập và kill worker.
- Route tiền fail-closed khi Redis sập. Tiền lưu bigint, thời gian nghiệp vụ lấy `now()` của DB.
- Image distroless non-root, pin theo digest, Action pin theo SHA, `--frozen-lockfile`, SBOM và provenance.
- Các API đã được đối chiếu và **đúng**: `StandardSchemaValidationPipe`, `sessionContext`, `em.fork({ session })`, `ClsService.run({ ifNested })`, processor `(job, token, signal)` của BullMQ, `upsertJobScheduler`/`getJobSchedulers`, `ThrottlerStorageRecord`, các export của cockatiel.
