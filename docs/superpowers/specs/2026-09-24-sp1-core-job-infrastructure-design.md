# Sub-project 1 — Core + hạ tầng job

- **Ngày:** 2026-09-24
- **Trạng thái:** Chờ Sếp review
- **Spec cha:** `2026-09-24-saas-core-architecture-design.md` (kiến trúc tổng thể đã duyệt). Spec này chỉ đi sâu phần `core/`, ba entrypoint, công cụ build, Docker và CI. Không nhắc lại những gì spec cha đã quyết định.

---

## 1. Mục tiêu và tiêu chí hoàn thành

Dựng phần nền để các sub-project sau (Identity, Tenancy, Billing…) chỉ việc cắm module vào. Sau sub-project này, repo phải chứng minh được bằng test chạy trên hạ tầng thật (Postgres + Redis qua Testcontainers):

1. Một command ghi dữ liệu và outbox event **trong cùng transaction**. Rollback thì không có event.
2. Relay đẩy event vào BullMQ. Worker xử lý, và **inbox chặn xử lý trùng** khi job bị giao lại.
3. **Redis sập thì event không mất**: event nằm lại trong outbox, Redis lên lại thì relay đẩy tiếp.
4. **Kill worker giữa job**: job được giao lại và kết quả cuối cùng vẫn đúng một lần.
5. Cron đăng ký bằng Job Scheduler chạy **đúng một lần** dù có 2 worker.
6. `withOrg()` set session RLS và **fail-closed**: bảng fixture bật RLS, query mà không có org thì báo lỗi.
7. HTTP: lỗi trả `problem+json`, response và phân trang đúng hình dạng ở spec cha mục 3.1, `ETag`/`If-Match`, JSON Merge Patch, `Idempotency-Key`, rate limit, OpenAPI sinh từ schema zod.
8. `/health/live`, `/health/ready`, và tắt êm theo đúng thứ tự trong spec cha, mục 9.
9. Log có `traceId`, `requestId`. Trace không bị đứt khi đi qua HTTP → outbox → job.
10. Pipeline xanh: lint, luật kiến trúc, type-check, unit, integration, build, Docker build, Trivy.
11. **Đo và ghi lại** thời gian build, type-check, build image, kích thước image, thời gian khởi động, rồi so với mục tiêu ở spec cha, mục 13.

## 2. Phạm vi

**Trong phạm vi:**
- `core/`: config, context, database (UnitOfWork, `withOrg`, migration), outbox, inbox, events, queue, scheduler, cache, http, resilience, observability, health, security (mã hoá field).
- Entrypoint `main.api.ts`, `main.worker.ts`, `main.migrate.ts`. Module gốc `app-api.module.ts`, `app-worker.module.ts`. File `app.modules.ts` của dự án.
- Công cụ: pnpm, SWC, type-check TS 7 cộng TS 6, Vitest, Testcontainers, oxlint, prettier, dependency-cruiser.
- Dockerfile, `.dockerignore`, Docker Compose (Postgres, PgBouncer, Redis), script tạo 3 DB role.
- GitHub Actions: pipeline cho PR. SBOM và ký image chỉ chạy khi tạo tag release.
- Module fixture chỉ dùng trong `test/` để chứng minh các tiêu chí ở mục 1.
- ADR 0001–0007, 0009, 0011–0013 (các ADR thuộc phần nền).

**Ngoài phạm vi** (thuộc sub-project sau):
- Mọi module nghiệp vụ (identity, tenancy…).
- OpenFeature và kill switch (sub-project 6).
- Helm chart (sub-project 7).
- MinIO và Mailpit trong Compose (thêm ở sub-project có dùng tới).
- Feature mẫu `features/example` (sub-project 7).

---

## 3. Quy trình làm việc bắt buộc

Áp dụng cho mọi bước của sub-project này và các sub-project sau.

### 3.1 Cấm hard code
- **Giá trị tuỳ chỉnh** (timeout, TTL, giới hạn, kích thước batch, lịch cron, retention, URL, origin CORS…) chỉ nằm trong **config schema zod** của module sở hữu nó. Mỗi giá trị có env var tương ứng. Code chỉ đọc qua config service có type.
- **Giá trị mặc định** chỉ được khai báo trong schema, kèm chú thích lý do. Không có literal số hay chuỗi cấu hình nằm rải rác trong code.
- **Secret** (mật khẩu DB, khoá mã hoá, token) chỉ lấy từ env, **không có giá trị mặc định**. Thiếu thì app không khởi động.
- **Định danh** (tên queue, loại event, tên job, mã lỗi, khoá cache) là hằng số có tên, nằm trong **một registry cho mỗi module**. Không gõ chuỗi trực tiếp tại chỗ dùng.
- Kiểm tra: review checklist, cộng một test quét `src/` tìm biểu thức cron, URL `http(s)://` và các số thời gian điển hình nằm ngoài file config.

### 3.2 Cấm tự chọn version
- Cài package bằng `pnpm add <tên>` và **không ghi version**, để lấy bản latest. Bật save-exact bằng lệnh `pnpm config set save-exact true --location project` để lockfile và `package.json` pin chính xác.
- Trước khi cài: xem `pnpm view <tên> dist-tags peerDependencies`. Nếu bản latest không tương thích với phần còn lại, **dừng lại**, ghi ngoại lệ vào ADR kèm output của lệnh làm bằng chứng, và báo Sếp.
- Docker image: lấy tag stable mới nhất từ registry bằng lệnh, rồi pin theo digest lấy từ `docker buildx imagetools inspect`. Không gõ digest hay tag từ trí nhớ.
- Renovate cập nhật các thứ trên về sau.

### 3.3 Dùng CLI và generator có sẵn
- Tạo project bằng `@nestjs/cli` bản latest, `nest new` (xem `nest new --help` để chọn flag cho pnpm, strict, ESM). Không dựng tay `package.json`, `tsconfig`, `nest-cli.json`.
- Tạo module, service, controller, guard, interceptor, filter bằng `nest g …`.
- Migration tạo bằng CLI của MikroORM (`migration:create`), sau đó mới viết SQL vào phần thân.
- Cấu hình ban đầu của công cụ: `depcruise --init`, `oxlint --init`, `docker init` (nếu template phù hợp thì dùng làm điểm xuất phát rồi sửa theo mục 9). File nào không có generator (ví dụ workflow CI, `.swcrc`) mới được viết tay.
- **Không đoán flag hay API**: đọc `--help` hoặc tài liệu chính thức trước khi dùng. Chỗ nào spec này ghi "cần kiểm chứng" thì phải kiểm chứng trước khi code phần đó.

---

## 4. Spike build (bước đầu tiên, bắt buộc)

Mục đích là xác nhận chuỗi công cụ ở spec cha, mục 13.2, trước khi xây code thật.

| # | Câu hỏi | Tiêu chí đạt | Nếu không đạt |
|---|---|---|---|
| S1 | `nest new` có tạo project ESM không, và `nest build -b swc` có ra ESM chạy được trên Node 24 LTS không? | App rỗng khởi động, gọi được một endpoint | Dùng CommonJS (Node 24 có `require(esm)`), ghi vào ADR 0013 |
| S2 | Cài TS 6 (alias) và TS 7 cạnh nhau: Nest CLI builder SWC và dependency-cruiser dùng TS 6, còn `tsc --noEmit` của TS 7 type-check được toàn bộ project? | Cả hai chạy, không xung đột bin | Chỉ dùng TS 6 để type-check, ghi lại thời gian đo được |
| S3 | SWC giữ `decoratorMetadata` để DI của Nest hoạt động (cả khi chạy app và chạy Vitest qua `unplugin-swc`)? | Test DI có inject theo type chạy xanh | Chỉnh `.swcrc` theo tài liệu. Nếu vẫn lỗi thì báo Sếp |
| S4 | MikroORM hỗ trợ nhiều thư mục migration (mỗi module một thư mục) như thế nào? | Migration của 2 thư mục chạy đúng thứ tự timestamp, up/down được | Dùng một thư mục, tên file có tiền tố module, ghi vào ADR |
| S5 | Postgres bản stable mới nhất có hàm `uuidv7()` dùng được làm `DEFAULT` không? | `SELECT uuidv7()` chạy được | Sinh UUIDv7 ở app bằng thư viện `uuid` |
| S6 | Đo baseline: build, type-check, khởi động | Có số liệu | Chỉ ghi nhận, không có nhánh xử lý riêng |

Kết quả spike ghi thành ADR 0013 kèm số liệu đo được, rồi mới làm tiếp mục 5.

---

## 5. Thiết kế các thành phần `core/`

Mỗi thành phần là một Nest module, chỉ lộ API qua `index.ts`. Mỗi module có config schema riêng (mục 3.1). Thành phần nào có "cần kiểm chứng" thì phải kiểm chứng API trong tài liệu trước khi code.

### 5.1 `core/config`
- Dùng `@nestjs/config`. Mỗi module khai báo schema zod bằng `registerAs`. Toàn bộ env được validate lúc khởi động. Lỗi validate liệt kê đủ các biến sai rồi thoát với mã khác 0.
- Có một config chung `APP_ROLE` (`api` | `worker` | `migrate`) do entrypoint set.
- File `.env.example` sinh ra từ schema bằng một script, không viết tay, để luôn khớp với schema.

### 5.2 `core/context`
- `nestjs-cls` giữ `requestId`, `traceId`, `principal`, `orgId`, và transaction hiện tại.
- HTTP: nhận `traceparent`/`X-Request-Id` nếu client gửi, không có thì tự tạo. Job: context được khôi phục từ metadata của job.

### 5.3 `core/database`
- MikroORM, driver PostgreSQL, `defineEntity`, connection có tên `primary` (dùng `contextName`, để sau này thêm DB khác mà không phải sửa code).
- Hai pool tách biệt:
  - **app**: role `app_user`, dùng trong request và job.
  - **admin**: role `app_admin`, chỉ dùng cho relay, cron quét nhiều org, và admin.
- **Port `UnitOfWork`:** `run(fn, opts?)` mở transaction, cho phép truyền isolation level, và gắn transaction vào context. Adapter MikroORM dùng `em.transactional`. Code ngoài `infra/` và `core/database` không thấy `EntityManager`.
- **`withOrg(orgId, fn)`:** fork EntityManager với session context `app.org_id` theo chiến lược `transaction` của MikroORM 7.2 (cần kiểm chứng tên option trong tài liệu RLS của MikroORM). `orgId` rỗng thì ném lỗi ngay tại app, trước khi xuống DB.
- **Migration:**
  - Chạy bằng code trong `main.migrate.ts`, dùng role `app_owner`.
  - `lock_timeout` và `statement_timeout` lấy từ config.
  - Hỗ trợ `up`, `down --to`, và `status`.
  - Cấu trúc thư mục theo kết quả spike S4.
- **Map lỗi DB** theo bảng ở spec cha, mục 3.2. `core/database` đăng ký một error mapper vào `core/errors` lúc khởi động. Filter hỏi các mapper trước khi rơi về `500`, nên module không phải tự bắt lỗi của driver. Registry `defineConstraintErrors({ tên_constraint: ErrorCode })` cho phép module gán mã lỗi cụ thể cho từng constraint.
- **Retry trong `UnitOfWork`:** gặp `40001`/`40P01` thì chạy lại cả transaction. Số lần và backoff lấy từ config. Chỉ retry ở transaction ngoài cùng.
- **3 DB role:** script SQL trong `docker/postgres/init/` tạo `app_owner`, `app_user`, `app_admin` cho môi trường dev. Với môi trường production, tài liệu hướng dẫn DBA chạy cùng script đó. Mật khẩu lấy từ env.

### 5.4 `core/outbox` và inbox

**Bảng `outbox_events`** (bảng hạ tầng, nằm trong allowlist của RLS, chỉ truy cập qua `core/`):

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | `BIGINT GENERATED ALWAYS AS IDENTITY` | PK |
| `event_id` | `UUID` | `NOT NULL UNIQUE` (UUIDv7) |
| `type` | `TEXT` | `NOT NULL` |
| `version` | `INT` | `NOT NULL CHECK (version > 0)` |
| `org_id` | `UUID` | NULL = event hệ thống |
| `aggregate_type`, `aggregate_id` | `TEXT` | `NOT NULL` |
| `aggregate_version` | `BIGINT` | `NOT NULL` |
| `payload` | `JSONB` | `NOT NULL` |
| `headers` | `JSONB` | `NOT NULL` (traceparent, correlationId, causationId, actor) |
| `occurred_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `published_at` | `TIMESTAMPTZ` | NULL = chưa gửi |
| `publish_attempts` | `INT` | `NOT NULL DEFAULT 0` |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

Index, mỗi index gắn với một query:
- `(id) WHERE published_at IS NULL`: cho relay chạy `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT :batch FOR UPDATE SKIP LOCKED`.
- `(published_at) WHERE published_at IS NOT NULL`: cho cleanup chạy `DELETE … WHERE published_at < :cutoff`.

**Bảng `processed_events`** (inbox): `consumer TEXT`, `event_id UUID`, `processed_at TIMESTAMPTZ NOT NULL DEFAULT now()`, PK `(consumer, event_id)`. Có index `(processed_at)` để cleanup theo thời gian giữ lại.

**Hành vi:**
- **`OutboxWriter.append(event)`** chỉ gọi được bên trong `UnitOfWork`. Gọi ngoài transaction thì ném lỗi.
- **Relay** chạy trong worker. Kích thước batch và chu kỳ poll lấy từ config. Mỗi lần: khoá một batch, enqueue từng event bằng `addBulk` với `jobId = event_id` (để BullMQ tự chống trùng), đánh dấu `published_at`, rồi commit. Enqueue lỗi thì rollback batch, rồi dùng **một transaction riêng** để tăng `publish_attempts` của các dòng lỗi (transaction chính đã rollback nên không lưu được), và ghi log/metric. `publish_attempts` vượt ngưỡng trong config thì cảnh báo.
  - Chạy nhiều relay cùng lúc vẫn an toàn nhờ `SKIP LOCKED`.
  - Có một khoảng trống: enqueue thành công nhưng commit lỗi. Khi đó event bị enqueue lại, nhưng `jobId` trùng và inbox sẽ chặn.
- **Inbox helper `once(consumer, eventId, fn)`:** `INSERT … ON CONFLICT DO NOTHING` cùng transaction với side effect. Insert không được dòng nào thì bỏ qua.
- **Fallback khi Redis sập:** `JobQueue.enqueue` trực tiếp thất bại thì ghi vào outbox dưới dạng event kỹ thuật `core.job.deferred`, không làm lỗi request.
- **Cleanup:** cron trong worker xoá outbox đã gửi và inbox quá thời gian giữ lại (lấy từ config).

### 5.5 `core/events`
- **Envelope** theo spec cha, mục 6. Có schema zod cho envelope, và mỗi loại event có schema payload riêng theo `type@version`.
- **Registry:** mỗi module đăng ký loại event mình phát ra và subscriber của mình (decorator, Nest discovery). Subscriber khai báo `consumer` (tên duy nhất) và phiên bản payload hỗ trợ.
- **Fan-out:** worker nhận job event, sau đó tạo một job cho mỗi subscriber (`jobId = consumer:event_id`). Subscriber chạy qua inbox helper. Subscriber bỏ qua event có `aggregate_version` cũ hơn thứ đã xử lý nếu nó theo dõi version.

### 5.6 `core/queue`
- `bullmq` + `@nestjs/bullmq` + `ioredis`. Kết nối Redis, prefix key và mặc định cho job (attempts, backoff, `removeOnComplete`, `removeOnFail`) lấy từ config.
- **Registry queue:** mỗi queue là một hằng số có tên, kèm concurrency, rate limit và loại tải (`io` | `cpu`) đọc từ config. Queue loại `cpu` chạy bằng sandboxed processor.
- **Port `JobQueue`** để enqueue, và decorator `@JobHandler(name)` để khai báo handler. Handler nhận `JobContext` của mình (payload đã validate, attempt, logger, signal hủy). Handler không import BullMQ.
- **Payload có version:** schema zod theo `name@version`. Payload sai thì ném `UnrecoverableError` (bọc trong lỗi của core).
- Worker chỉ chạy các queue có trong `WORKER_QUEUES` (config).
- Khi tắt: `worker.close()` chờ job đang chạy, timeout lấy từ config.
- **Bull Board** đặt dưới `/admin/queues`, sau một guard tạm dạng API key đọc từ config. Sub-project 2 sẽ thay guard này bằng quyền admin thật.

### 5.7 `core/scheduler`
- **Cron tĩnh:** module khai báo `{ key, cron, timezone, job, payload }`. Mọi giá trị `cron` và `timezone` lấy từ config của module. Khi worker khởi động, gọi `upsertJobScheduler` cho từng mục. Scheduler có key không còn khai báo thì bị xoá.
- **Lịch động theo tenant**, bảng `scheduled_tasks`:
  - Cột: `id BIGINT` identity PK, `org_id UUID NULL`, `key TEXT NOT NULL`, `job_name TEXT NOT NULL`, `cron TEXT NOT NULL`, `timezone TEXT NOT NULL`, `payload JSONB NOT NULL`, `enabled BOOLEAN NOT NULL`, `created_at`/`updated_at`.
  - Ràng buộc: `UNIQUE NULLS NOT DISTINCT (org_id, key)`. Cron và timezone được validate ở app trước khi lưu.
  - Mỗi lần thay đổi thì phát event, subscriber đồng bộ sang BullMQ. Thêm một cron đối soát toàn bộ, chu kỳ lấy từ config.
- Test: 2 worker, cron chạy mỗi giây trong vài giây, đếm đúng một lần cho mỗi mốc.

### 5.8 `core/cache`
- `bentocache`: L1 bộ nhớ, L2 Redis, bus Redis để xoá L1 giữa các pod (cần kiểm chứng cách cấu hình bus với ioredis).
- **Helper khoá** `cacheKey(module, version, …parts)`, có namespace theo env. **Helper version** để tăng version của một nhóm khoá.
- TTL, jitter và grace lấy từ config. Sub-project này chưa dùng cache ở đâu. Test chứng minh chống stampede (N request song song chỉ gọi loader 1 lần).

### 5.9 `core/http`
- **Nền tảng:** Express, `rawBody: true`, giới hạn kích thước body theo config (vượt → `413 payload_too_large`), helmet, CORS lấy allowlist từ config, `trust proxy` theo config. Content-Type ngoài `application/json` và `application/merge-patch+json` → `415 unsupported_media_type`. Route không tồn tại → `404 not_found` dạng problem+json. Với sai method trên một path có thật, Nest chạy trên Express mặc định trả 404. Muốn trả `405 method_not_allowed` kèm header `Allow` thì phải đọc bảng route của router, việc này dính chặt vào Express. Vì vậy sub-project 1 giữ 404, và ghi vào ADR 0007 là giới hạn đã biết.
- **Validate:** Nest 12 dùng `StandardSchemaValidationPipe` với zod (cần kiểm chứng tên API trong tài liệu Nest 12). Response cũng đi qua schema.
- **Lỗi:** một exception filter duy nhất trả `application/problem+json` đúng hình dạng ở spec cha, mục 3.1: `type`, `title`, `status`, `code`, `detail`, `instance`, `requestId`, `timestamp`, `errors[]`.
  - Lớp `AppError` mang mã lỗi (lấy từ registry), `detail` và danh sách lỗi field.
  - `code` dạng `snake_case` thường, registry ném lỗi khi trùng.
  - `type` = `<HTTP_PROBLEM_TYPE_BASE>/<code dạng kebab>`.
  - Lỗi validate của zod chuyển thành `422 validation_failed`: `path` nối bằng dấu chấm, `code` lấy từ mã issue của zod (`invalid_format` + format email → `invalid_email`).
  - Body không parse được → `400 malformed_request`.
  - Lỗi không lường trước thì trả `500 internal_error`, **ghi log đầy đủ ở server**, và không lộ chi tiết ra ngoài.
- **Bộ công cụ dùng chung** theo spec cha, mục 3.3: `AppError` + `defineErrorCodes` (mỗi module một file `errors.ts`), `serialize(schema, value)`, `created(res, location)`, `@ApiProblems(...)`, `Paginator`, `mergePatchSchema`, `etagOf`/`assertIfMatch`, `@Idempotent()`. Đều export từ `core/http` hoặc `core/errors`. Toàn bộ mã lỗi của core liệt kê trong bảng ở spec cha, mục 3.2.
- **Response thành công:**
  - Resource đơn trả thẳng object.
  - Helper `Paginator.offset(...)` và `Paginator.cursor(...)` dựng danh sách phẳng đúng spec cha, mục 3.1. `url` lấy từ request context (path không kèm query).
  - Schema zod cho OpenAPI: `offsetPageSchema(item)`, `cursorPageSchema(item)`.
- **Phân trang:**
  - Schema zod chung cho offset (`page`, `pageSize`, `sort`) và cursor (`limit`, `cursor`).
  - Giới hạn tối đa lấy từ config.
  - Helper chuyển sang `findAndCount`/`findByCursor` của MikroORM.
  - `totalCount` bị chặn trần theo config. Vượt trần thì `totalCount` = trần và `totalCountExact: false`, luôn là số.
  - Cursor dùng `findByCursor` có sẵn của MikroORM (chuỗi opaque). Cursor hỏng → MikroORM ném lỗi → mapper trả `400 invalid_cursor`.
- **Concurrency:** helper `etagOf(version)` tạo weak ETag. `assertIfMatch(req, version)` ném `412 precondition_failed` khi lệch version, và `428 precondition_required` khi route bắt buộc `If-Match` mà client không gửi. `If-None-Match` khớp thì trả `304`.
- **PATCH:** nhận `application/merge-patch+json` (RFC 7396). Helper `mergePatchSchema(schema)` biến mọi field thành optional và cho phép `null` để xoá giá trị.
- **Idempotency:** dùng `@nestjs-redisx/idempotency` (hỗ trợ Nest 12, ioredis, Express và Fastify). `core/http` export `@Idempotent()` đã gắn sẵn `keyExtractor`. TTL, lock timeout, wait timeout và prefix lấy từ config.
  - Thiếu hoặc sai định dạng header → `400 idempotency_key_required` (do `keyExtractor` ném).
  - Key luôn được tách theo org/user, để hai tenant không bao giờ dùng chung response đã lưu.
  - Cùng key nhưng khác body → `422 idempotency_key_reused`.
  - Request trùng đang chạy → chờ và nhận cùng kết quả. Chờ quá `waitTimeout` → `409 idempotency_conflict`.
  - Handler lỗi → `409 idempotency_previous_failed` khi gọi lại cùng key.
  - Redis sập → `503 service_unavailable` (fail-closed).
  - Lỗi của thư viện được map về mã của mình qua `registerErrorMapper`.
- **Rate limit:** `@nestjs/throttler` + `@nest-lab/throttler-storage-redis` (ngoại lệ peer ≤ Nest 11 đã được Sếp duyệt sau spike trên Nest 12.1), bọc thêm một lớp mỏng để fail-open khi Redis lỗi, có ghi log/metric. Mặc định lấy từ config.
- **OpenAPI:** `@nestjs/swagger` sinh spec từ schema zod. Scalar phục vụ ở `/docs`, bật hay tắt theo config (production mặc định tắt). Có script xuất `openapi.json` để CI chạy `oasdiff`.

### 5.10 `core/resilience`
- `cockatiel`: factory tạo policy (timeout, retry có jitter, circuit breaker, bulkhead) theo tên provider. Mọi tham số lấy từ config của provider.
- Có HTTP client dùng chung: `fetch` của Node bọc trong policy, gắn trace, có timeout connect và timeout tổng.

### 5.11 `core/observability`
- **Log:** `nestjs-pino`. Danh sách field cần redact lấy từ config (mặc định có authorization, cookie, password, token, secret). Mỗi dòng log có context từ CLS.
- **Trace:** file `instrumentation` nạp trước app bằng `--import`, dùng OpenTelemetry Node SDK, auto-instrumentation (http, pg, ioredis) và `bullmq-otel`. Tỉ lệ lấy mẫu và endpoint OTLP lấy từ config. `traceparent` được ghi vào `headers` của outbox và metadata của job, rồi khôi phục khi xử lý.
- **Metrics** (xuất qua OTLP):
  - HTTP: số request, số lỗi, độ trễ.
  - Queue: độ sâu, tuổi job cũ nhất, số job failed.
  - Outbox: độ trễ (`now - occurred_at` của event chưa gửi cũ nhất).
  - Pool DB.

### 5.12 `core/health`
- `@nestjs/terminus`. `/health/live` không phụ thuộc gì bên ngoài. `/health/ready` kiểm tra DB (pool app) và Redis, có timeout theo config.
- **Tắt êm:** khi nhận SIGTERM, đặt cờ draining → ready trả 503 → chờ khoảng thời gian cấu hình để load balancer ngừng gửi → đóng HTTP server → đóng worker → đóng pool. Tổng thời gian nhỏ hơn `terminationGracePeriodSeconds`.

### 5.13 `core/security`
- **Mã hoá field:** AES-256-GCM kiểu envelope bằng `node:crypto`. Mỗi bản mã mang `keyId` để xoay khoá. Khoá chủ lấy từ env, hỗ trợ nhiều khoá cùng lúc trong thời gian xoay. Có test cho mã hoá, giải mã, và xoay khoá.

---

## 6. Entrypoint và thành phần module

| File | Vai trò |
|---|---|
| `main.api.ts` | Bootstrap HTTP, `APP_ROLE=api` |
| `main.worker.ts` | Bootstrap application context (không mở HTTP, trừ cổng health riêng lấy từ config), chạy relay, scheduler, processor |
| `main.migrate.ts` | Chạy migration theo lệnh `up` / `down` / `status`, rồi thoát |
| `app-api.module.ts`, `app-worker.module.ts` | Boilerplate sở hữu. Ghép `core` với danh sách module lấy từ `app.modules.ts` |
| `app.modules.ts` | Dự án sở hữu. Trong sub-project 1 danh sách này rỗng |

Worker cũng cần endpoint health cho K8s probe. Worker mở một HTTP server tối thiểu chỉ phục vụ `/health/*`, cổng lấy từ config.

---

## 7. Luật kiến trúc (dependency-cruiser, chạy trong CI)

1. `features/**` chỉ được import `modules/*/index.ts` và `core/*/index.ts`.
2. `modules/**` không được import `features/**`. Module chỉ được import `index.ts` của module khác.
3. `core/**` không được import `modules/**` hay `features/**`.
4. `@mikro-orm/*` chỉ được import trong `**/infra/**` và `core/database/**`.
5. `bullmq`, `@nestjs/bullmq` chỉ được import trong `core/queue/**`.
6. `express`, `fastify` chỉ được import trong `core/http/**`.
7. Trong module: `domain/**` không import `infra/**`, `http/**` hay thư viện hạ tầng.
8. Không có vòng phụ thuộc.

Mỗi luật có một test "phải fail" (fixture vi phạm) để chứng minh luật hoạt động.

---

## 8. Testing

| Loại | Nội dung trong sub-project 1 |
|---|---|
| Unit | Config schema, envelope, `Paginator`, ETag/`If-Match`, `mergePatchSchema`, registry mã lỗi, `cacheKey`, mã hoá field, ánh xạ lỗi sang problem+json |
| Integration (Testcontainers) | UnitOfWork + outbox cùng transaction, relay với `SKIP LOCKED` khi 2 relay chạy song song, inbox chống trùng, fallback khi Redis sập, `withOrg` fail-closed trên bảng fixture có RLS, migration up → down → up, idempotency, rate limit, cache chống stampede |
| E2E | Endpoint fixture: command ghi dữ liệu + event → subscriber chạy đúng một lần. Endpoint phân trang offset/cursor. Lỗi 4xx/5xx đúng định dạng |
| Chaos (Toxiproxy) | Cắt mạng tới Redis 30 giây trong lúc có tải, cắt mạng tới Postgres, kill worker giữa job |
| Kiến trúc | Các luật ở mục 7 kèm fixture phải fail |
| Scan hard code | Theo mục 3.1 |

Container Postgres và Redis được dùng lại trong một lần chạy test. Mỗi test cô lập bằng schema hoặc DB riêng, hoặc truncate. Vitest chạy qua `unplugin-swc`.

---

## 9. Docker, Compose, CI

- **Dockerfile:** theo spec cha, mục 13.3. Tag và digest của base image lấy theo mục 3.2. `CMD` mặc định là api. Compose và K8s override để chạy worker hoặc migrate.
- **Compose (dev):**
  - Postgres (bản stable mới nhất, image chính thức), PgBouncer (chọn image lúc làm và ghi ADR, vì không có image chính thức), Redis (bản stable mới nhất, image chính thức).
  - Service api, worker, migrate dùng chính image build từ repo.
  - Healthcheck dùng `node -e`. Script init tạo 3 DB role.
- **CI (GitHub Actions)**, một workflow cho PR:
  - Cài đặt có cache pnpm store.
  - Chạy song song: lint (oxlint + prettier check), dependency-cruiser, type-check TS 7, unit, integration.
  - Build app.
  - Docker build có cache `gha`, rồi quét Trivy, fail khi có CVE HIGH/CRITICAL đã có bản vá.
  - Workflow release (khi có tag): build đa kiến trúc, SBOM, provenance, ký cosign keyless, push image.
- Renovate cấu hình cho npm, Docker digest và GitHub Actions.

---

## 10. Rủi ro và điểm cần kiểm chứng

| Rủi ro | Cách xử lý |
|---|---|
| Chuỗi công cụ TS 6 + TS 7 + SWC ESM chưa được Nest hỗ trợ chính thức | Spike S1–S3 làm trước tiên, có nhánh dự phòng |
| RLS của MikroORM 7.2 còn mới | Pin chính xác version. Test fail-closed chạy bằng `app_user` trên Postgres thật |
| Nhiều thư mục migration | Spike S4 |
| API cụ thể của `StandardSchemaValidationPipe`, cách truyền option lúc chạy cho plugin RedisX, bus của bentocache, `bullmq-otel` | Đánh dấu "cần kiểm chứng". Đọc tài liệu và `.d.ts` của version latest trước khi code phần đó |
| `@nest-lab/throttler-storage-redis` chưa khai báo Nest 12, `@nestjs-redisx/*` còn mới | Pin chính xác version. Test e2e cho rate limit và idempotency chạy trong CI. Chỉ `core/http` được import (luật dependency-cruiser) |
| PgBouncer không có image chính thức | Chọn image lúc làm, ghi ADR, pin digest |
| Khoảng trống giữa enqueue và commit ở relay | Chấp nhận có thể trùng, `jobId = event_id` cộng inbox chặn lại. Có test riêng |

---

## 11. Sản phẩm bàn giao

- Code `core/` và entrypoint như trên, tất cả test xanh.
- ADR 0001–0007, 0009, 0011–0013 trong `docs/adr/`. ADR 0013 kèm số liệu đo được.
- `README.md`: cách chạy dev, danh sách env (sinh từ schema), cách thêm queue, job, cron, event.
- Bảng số liệu đo được (mục 1, tiêu chí 11), so với mục tiêu.
