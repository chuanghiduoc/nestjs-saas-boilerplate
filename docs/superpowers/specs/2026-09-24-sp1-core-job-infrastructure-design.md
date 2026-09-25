# Sub-project 1 — Core + hạ tầng job

- **Ngày:** 2026-09-24, cập nhật 2026-09-25 theo review trước thực thi (`docs/superpowers/reviews/2026-09-25-sp1-pre-execution-review.md`)
- **Trạng thái:** Đã duyệt, cập nhật sau review
- **Spec cha:** `2026-09-24-saas-core-architecture-design.md` (kiến trúc tổng thể đã duyệt). Spec này chỉ đi sâu phần `core/`, ba entrypoint, công cụ build, Docker và CI. Không nhắc lại những gì spec cha đã quyết định.

---

## 1. Mục tiêu và tiêu chí hoàn thành

Dựng phần nền để các sub-project sau (Identity, Tenancy, Billing…) chỉ việc cắm module vào. Sau sub-project này, repo phải chứng minh được bằng test chạy trên hạ tầng thật (Postgres + PgBouncer + Redis qua Testcontainers):

1. Một command ghi dữ liệu và outbox event **trong cùng transaction**. Rollback thì không có event.
2. Relay đẩy event vào BullMQ. Worker xử lý, và **inbox chặn xử lý trùng** khi job bị giao lại.
3. **Redis sập thì event không mất**: event nằm lại trong outbox, Redis lên lại thì relay đẩy tiếp.
4. **Kill worker giữa job**: job được giao lại và kết quả cuối cùng vẫn đúng một lần.
5. Cron đăng ký bằng Job Scheduler chạy **đúng một lần** dù có 2 worker.
6. `OrgScope` set session RLS và **fail-closed**: bảng fixture bật RLS với policy dùng `app_current_org()`, query mà không có org thì báo lỗi, kể cả trên connection từng được set trước đó.
7. HTTP: lỗi trả `problem+json`, response và phân trang đúng hình dạng ở spec cha mục 3.1, `ETag`/`If-Match`, JSON Merge Patch, `Idempotency-Key` đúng IETF draft (spec cha mục 3.4), rate limit (spec cha mục 3.5), OpenAPI sinh từ schema zod.
8. HTTP client ra ngoài **chặn SSRF**: request tới IP nội bộ, IPv4-mapped IPv6, metadata cloud, hay tên miền resolve ra IP nội bộ đều bị từ chối.
9. `/health/live`, `/health/ready`, và tắt êm theo đúng thứ tự trong spec cha, mục 9.
10. Log (kể cả log của job) có `traceId`, `requestId`. Trace không bị đứt khi đi qua HTTP → outbox → job.
11. Pipeline xanh: lint, luật kiến trúc, type-check, unit, integration, build, Docker build, Trivy, gitleaks, osv-scanner, CodeQL.
12. **Đo và ghi lại** thời gian build, type-check, build image, kích thước image, thời gian khởi động, rồi so với mục tiêu ở spec cha, mục 13.

## 2. Phạm vi

**Trong phạm vi:**
- `core/`: config, context, database (UnitOfWork, `OrgScope`, migration, map lỗi DB, port SQL cho relay), outbox, inbox, events, queue, scheduler, http (lỗi, phân trang, ETag, Merge Patch, idempotency, rate limit), resilience (kèm HTTP client chặn SSRF), observability, health, security (mã hoá field).
- Entrypoint `main.api.ts`, `main.worker.ts`, `main.migrate.ts`. Module gốc `app-api.module.ts`, `app-worker.module.ts`. File `app.modules.ts` của dự án.
- Công cụ: pnpm, SWC, type-check TS 7 cộng TS 6, Vitest, Testcontainers, oxlint, prettier, dependency-cruiser.
- Dockerfile, `.dockerignore`, Docker Compose (Postgres, PgBouncer, Redis, chỉ bind `127.0.0.1`), script tạo DB role cho dev.
- GitHub Actions: pipeline cho PR. SBOM và ký image chỉ chạy khi tạo tag release.
- Module fixture chỉ dùng trong `test/` để chứng minh các tiêu chí ở mục 1.
- ADR 0001–0007, 0009, 0011–0016 (các ADR thuộc phần nền).

**Ngoài phạm vi** (thuộc sub-project sau):
- Mọi module nghiệp vụ (identity, tenancy…).
- **Cache** (stack đã chọn ở spec cha mục 8, làm khi có use case đầu tiên).
- **Bull Board** (sub-project 2, sau RBAC admin, read-only, port nội bộ).
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
- **Secret** (mật khẩu DB, khoá mã hoá, token) chỉ lấy từ env, **không có giá trị mặc định**. Thiếu thì app không khởi động. Lỗi parse secret không được in giá trị ra log.
- **Định danh** (tên queue, loại event, tên job, mã lỗi, khoá cache) là hằng số có tên, nằm trong **một registry cho mỗi module**. Không gõ chuỗi trực tiếp tại chỗ dùng.
- Kiểm tra: review checklist, cộng một test quét `src/` tìm biểu thức cron, URL `http(s)://` và các số thời gian điển hình nằm ngoài file config.

### 3.2 Cấm tự chọn version
- Cài package bằng `pnpm add <tên>` và **không ghi version**, để lấy bản latest. Bật save-exact bằng lệnh `pnpm config set save-exact true --location project` để lockfile và `package.json` pin chính xác.
- **"Latest" là bản mới nhất đã publish ít nhất 1 ngày**: bật `minimumReleaseAge` của pnpm (1 ngày) để tránh cửa sổ package bị chiếm quyền. Renovate đặt `minimumReleaseAge` 3 ngày.
- Trước khi cài: xem `pnpm view <tên> dist-tags peerDependencies`. Nếu bản latest không tương thích với phần còn lại, **dừng lại**, ghi ngoại lệ vào ADR kèm output của lệnh làm bằng chứng, và báo Sếp.
- **Allowlist build script** chỉ gồm `@swc/core`, `msgpackr-extract`, `protobufjs` (thêm khi thật sự cần, có ghi lý do). `@scarf/scarf` bị chặn.
- pnpm `overrides` để cả cây dependency chỉ có **một** major của ioredis.
- Các major vừa ra (`unplugin-swc` 2.0, `nestjs-cls` 7.0) pin chính xác. `@mikro-orm/nestjs` có version riêng (7.1.x), không đòi cùng version với `@mikro-orm/core`.
- Docker image: lấy tag stable mới nhất từ registry bằng lệnh, rồi pin theo digest lấy từ `docker buildx imagetools inspect`. Không gõ digest hay tag từ trí nhớ.
- Renovate cập nhật các thứ trên về sau.

### 3.3 Dùng CLI và generator có sẵn
- Tạo project bằng `@nestjs/cli` bản latest, `nest new` (xem `nest new --help` để chọn flag cho pnpm, strict, ESM). Không dựng tay `package.json`, `tsconfig`, `nest-cli.json`.
- Tạo module, service, controller, guard, interceptor, filter bằng `nest g …`.
- Migration tạo bằng CLI của MikroORM (`migration:create`), sau đó mới viết SQL vào phần thân.
- Cấu hình ban đầu của công cụ: `depcruise --init`, `oxlint --init`, `docker init` (nếu template phù hợp thì dùng làm điểm xuất phát rồi sửa theo mục 9). File nào không có generator (ví dụ workflow CI, `.swcrc`) mới được viết tay.
- **Không đoán flag hay API**: đọc `--help`, `.d.ts` trong `node_modules` hoặc tài liệu chính thức trước khi dùng. Chỗ nào spec này ghi "cần kiểm chứng" thì phải kiểm chứng trước khi code phần đó.

### 3.4 Ưu tiên thứ có sẵn
Thứ tự: tính năng có sẵn của framework/thư viện đang dùng → package npm được bảo trì tốt → chỉ tự viết khi không có lựa chọn đạt, kèm ADR liệt kê ứng viên đã loại và báo Sếp.

---

## 4. Spike build (bước đầu tiên, bắt buộc)

Mục đích là xác nhận chuỗi công cụ ở spec cha, mục 13.2, trước khi xây code thật.

| # | Câu hỏi | Tiêu chí đạt | Nếu không đạt |
|---|---|---|---|
| S1 | `nest new` có tạo project ESM không, và `nest build -b swc` có ra ESM chạy được trên Node 24 LTS không? | App rỗng khởi động, gọi được một endpoint | Dùng CommonJS (Node 24 có `require(esm)`), ghi vào ADR 0013 |
| S2 | Cài TS 6 (alias) và TS 7 cạnh nhau: Nest CLI builder SWC, dependency-cruiser và `@swc-node/register` dùng TS 6, còn `tsc --noEmit` của TS 7 type-check được toàn bộ project? | Cả hai chạy, không xung đột bin | Chỉ dùng TS 6 để type-check, ghi lại thời gian đo được |
| S3 | SWC giữ `decoratorMetadata` để DI của Nest hoạt động (cả khi chạy app và chạy Vitest qua `unplugin-swc`)? | Test DI có inject theo type chạy xanh | Chỉnh `.swcrc` theo tài liệu. Nếu vẫn lỗi thì báo Sếp |
| S4 | Layout build: migration (của core và của test fixture) và script có vào `dist/` và chạy được từ image không? `migrations.path` của MikroORM chỉ nhận một thư mục, nên nhiều thư mục migration chạy thế nào? | `main.migrate up` trong image áp dụng đúng migration; migration của 2 thư mục chạy đúng thứ tự, up/down được | Đặt migration trong `src/`, hoặc một thư mục có tiền tố module; ghi vào ADR |
| S5 | Postgres bản stable mới nhất có hàm `uuidv7()` dùng được làm `DEFAULT` không? | `SELECT uuidv7()` chạy được | Sinh UUIDv7 ở app bằng thư viện `uuid` |
| S6 | Đo baseline: build, type-check, khởi động | Có số liệu | Chỉ ghi nhận, không có nhánh xử lý riêng |

Kết quả spike ghi thành ADR 0013 kèm số liệu đo được, rồi mới làm tiếp mục 5.

---

## 5. Thiết kế các thành phần `core/`

Mỗi thành phần là một Nest module, chỉ lộ API qua `index.ts`. Mỗi module có config schema riêng (mục 3.1). Thành phần nào có "cần kiểm chứng" thì phải kiểm chứng API trong tài liệu trước khi code.

### 5.1 `core/config`
- Dùng `@nestjs/config`. Mỗi module khai báo schema zod bằng `registerAs`. Lúc khởi động, **toàn bộ registry được validate một lần**, lỗi liệt kê đủ các biến sai của mọi namespace rồi thoát với mã khác 0.
- Có một config chung `APP_ROLE` (`api` | `worker` | `migrate`) do entrypoint set. Config nạp trước app (instrumentation) không được phụ thuộc `APP_ROLE`.
- File `.env.example` sinh ra từ schema bằng một script, in **giá trị mặc định gốc** (trước transform), không viết tay, để luôn khớp với schema.
- Config chỉ dành cho dev (superuser của compose, thư mục migration phụ cho test) không nằm trong registry của production; production có refine cấm bật `DB_DEBUG`, `HTTP_DOCS_ENABLED` hay thư mục migration phụ khi chưa ghi đè tường minh.

### 5.2 `core/context`
- `nestjs-cls` giữ `requestId`, `clientRequestId`, `traceId`, `principal`, `orgId`, và EntityManager của transaction hiện tại.
- HTTP: `requestId` luôn do server sinh (UUIDv7). `X-Request-Id` của client (nếu hợp lệ `^[A-Za-z0-9._-]{1,128}$`) giữ ở `clientRequestId`. Job: context được khôi phục từ metadata của job; relay dùng `correlationId` của outbox.

### 5.3 `core/database`
- MikroORM, driver PostgreSQL, `defineEntity`, connection có tên (`contextName`), để sau này thêm DB khác mà không phải sửa code. EntityManager luôn được inject theo token có tên (`@InjectEntityManager(name)`).
- **Mọi SQL thô chạy qua `em.execute(sql, params)`** của EntityManager đang gắn với transaction, không dùng `getConnection().execute()` (hàm đó chạy ngoài transaction và ngoài session RLS).
- **Role và pool:**
  - **app**: role `app_user`, dùng trong request và job.
  - **relay**: role `app_relay` (không BYPASSRLS), chỉ có quyền trên `outbox_events`, `processed_events`, `scheduled_tasks`. Dùng cho relay, cleanup, reconcile, metrics. Chỉ khởi tạo trong worker.
  - **admin**: role `app_admin` (BYPASSRLS), chỉ cho thao tác quét nhiều org được khai báo tường minh. **Không khởi tạo trong process api.** Sub-project 1 chưa có use case nên chưa tạo pool này.
  - SQL của relay/admin đi qua **port trong `core/database`** (ví dụ `RelaySql.transactional(fn)`), code ngoài `core/database` không import MikroORM.
- **Grant theo từng bảng** trong migration tạo bảng, không dùng `ALTER DEFAULT PRIVILEGES` cấp tràn lan. `app_user`: INSERT-only trên `outbox_events`, INSERT + quyền đọc tối thiểu trên `processed_events`.
- **Timeout:** `statement_timeout` và `idle_in_transaction_session_timeout` đặt bằng `ALTER ROLE … SET` (PgBouncer transaction mode bỏ startup parameter). Worker nâng timeout bằng `SET LOCAL` đầu transaction. Test kiểm tra đi qua PgBouncer.
- **TLS:** `DB_SSL_MODE` + CA từ config, production bắt buộc `rejectUnauthorized: true`.
- **Port `UnitOfWork`:** `run(fn, opts?)` mở transaction, cho phép truyền isolation level, và gắn transaction vào context. Chưa có EM trong context thì tự `fork()` từ EM gốc. Adapter MikroORM dùng `em.transactional`. Code ngoài `infra/` và `core/database` không thấy `EntityManager`.
- **`OrgScope.run(orgId, fn)`:** fork EntityManager với session context `app.org_id` theo chiến lược `transaction` của MikroORM 7.2. `orgId` rỗng hoặc sai định dạng UUID thì ném lỗi ngay tại app, trước khi xuống DB. Gọi bên trong một transaction đang mở với org khác thì **ném lỗi** (session chỉ được set lúc `BEGIN`).
- **Policy RLS** dùng hàm `app_current_org()`: ném lỗi khi `current_setting('app.org_id', true)` NULL hoặc rỗng.
- **Migration:**
  - Chạy bằng code trong `main.migrate.ts`, dùng role `app_owner`.
  - `lock_timeout` và `statement_timeout` lấy từ config.
  - Hỗ trợ `up`, `down <to>`, và `status`. `<to>` phải nằm trong danh sách đã chạy; revert toàn bộ phải ghi `0` tường minh.
  - Layout theo kết quả spike S4.
- **Map lỗi DB** theo bảng ở spec cha, mục 3.2. `core/database` đăng ký một error mapper vào `core/errors` lúc khởi động. Filter hỏi các mapper trước khi rơi về `500`, nên module không phải tự bắt lỗi của driver. Registry `defineConstraintErrors({ tên_constraint: ErrorCode })` cho phép module gán mã lỗi cụ thể cho từng constraint. Vi phạm RLS nhận diện bằng SQLSTATE `42501` cộng bảng có RLS, không dựa vào nội dung message.
- **Retry trong `UnitOfWork`:** gặp `40001`/`40P01` thì chạy lại cả transaction. Số lần và backoff lấy từ config. Chỉ retry ở transaction ngoài cùng.
- **DB role cho dev:** script trong `docker/postgres/init/` tạo `app_owner`, `app_user`, `app_relay` (và `app_admin` khi cần). Với production, tài liệu hướng dẫn DBA chạy cùng script đó. Mật khẩu lấy từ env.

### 5.4 `core/outbox` và inbox

**Bảng `outbox_events`** (bảng hạ tầng, nằm trong allowlist của RLS vì có lý do ghi rõ; `app_user` chỉ INSERT, relay dùng `app_relay`):

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
- **`OutboxWriter.append(event)`** chỉ gọi được bên trong `UnitOfWork`. Gọi ngoài transaction thì ném lỗi. `orgId` của event phải bằng org của context, trừ actor `system`.
- **Relay** chạy trong worker. Kích thước batch và chu kỳ poll lấy từ config; batch đầy thì chạy vòng tiếp ngay, không chờ. Mỗi lần: khoá một batch, enqueue bằng `addBulk` với jobId suy ra từ id outbox (BullMQ không cho `:` trong jobId), đánh dấu `published_at`, rồi commit. Enqueue lỗi thì rollback batch, rồi dùng **một transaction riêng** để tăng `publish_attempts` của các dòng lỗi, và ghi log/metric. `publish_attempts` vượt ngưỡng trong config thì cảnh báo.
  - Chạy nhiều relay cùng lúc vẫn an toàn nhờ `SKIP LOCKED` (chỉ đúng khi SQL chạy trong transaction, xem 5.3).
  - Có một khoảng trống: enqueue thành công nhưng commit lỗi. Khi đó event bị enqueue lại; **inbox là bảo đảm chính**, jobId chỉ chống trùng trong cửa sổ ngắn.
- **Inbox helper `once(consumer, eventId, fn)`:** `INSERT … ON CONFLICT DO NOTHING` cùng transaction với side effect **trong DB**. Side effect ra ngoài (gửi mail, webhook) không chạy trong transaction này.
- **Enqueue an toàn (`SafeEnqueue`):** đang trong transaction thì **luôn** ghi outbox dưới dạng `core.job.deferred` (không gọi Redis trực tiếp, tránh job chạy trước commit hoặc sau rollback). Ngoài transaction thì enqueue trực tiếp; lỗi thì ghi outbox với **cùng jobId** đã sinh.
- **Cleanup:** cron trong worker xoá outbox đã gửi và inbox quá thời gian giữ lại (lấy từ config), **theo batch** có kích thước lấy từ config.

### 5.5 `core/events`
- **Envelope** theo spec cha, mục 6. Có schema zod cho envelope, và mỗi loại event có schema payload riêng theo `type@version`.
- **Registry:** mỗi module đăng ký loại event mình phát ra và subscriber của mình (decorator, Nest discovery). Subscriber khai báo `consumer` (tên duy nhất) và phiên bản payload hỗ trợ.
- **Fan-out:** worker nhận job event, sau đó tạo một job cho mỗi subscriber (jobId không chứa `:`). Subscriber chạy qua inbox helper, trong `OrgScope` của `orgId` của event. Subscriber bỏ qua event có `aggregate_version` cũ hơn thứ đã xử lý nếu nó theo dõi version.

### 5.6 `core/queue`
- `bullmq` + `ioredis` dùng trực tiếp (không dùng `@nestjs/bullmq`, vì dispatcher tạo Worker theo config lúc chạy). Kết nối Redis, prefix key và mặc định cho job (attempts, backoff, `removeOnComplete`, `removeOnFail` theo **cả tuổi và số lượng**) lấy từ config.
- **Redis:** production bắt buộc `rediss://` + user ACL. Queue dùng instance/DB `noeviction`.
- **Registry queue:** mỗi queue là một hằng số có tên, kèm concurrency, rate limit và loại tải (`io` | `cpu`) đọc từ config. Queue loại `cpu` chưa có trong sub-project 1 (ném lỗi rõ ràng nếu khai báo).
- **Port `JobQueue`** để enqueue, và decorator `@JobHandler(name)` để khai báo handler. Handler nhận `JobContext` của mình (payload đã validate, attempt, logger, signal hủy). Handler không import BullMQ. Handler **luôn chạy trong `OrgScope`** khi `meta.orgId` có giá trị.
- **Payload có version:** schema zod theo `name@version`. Payload sai thì ném `UnrecoverableError` (bọc trong lỗi của core).
- Worker chỉ chạy các queue có trong `WORKER_QUEUES` (config).
- Khi tắt: `worker.close()` chờ job đang chạy, timeout lấy từ config.

### 5.7 `core/scheduler`
- **Cron tĩnh:** module khai báo `{ key, cron, timezone, job, payload }`. Mọi giá trị `cron` và `timezone` lấy từ config của module. Khi worker khởi động, gọi `upsertJobScheduler` cho từng mục. Scheduler không còn khai báo chỉ bị xoá khi đã quá thời gian ân hạn lấy từ config (tránh pod cũ và pod mới xoá cron của nhau khi rolling deploy).
- **Lịch động theo tenant**, bảng `scheduled_tasks` (bật RLS + FORCE):
  - Cột: `id BIGINT` identity PK, `org_id UUID NULL`, `key TEXT NOT NULL`, `job_name TEXT NOT NULL`, `cron TEXT NOT NULL`, `timezone TEXT NOT NULL`, `payload JSONB NOT NULL`, `enabled BOOLEAN NOT NULL`, `created_at`/`updated_at`.
  - Ràng buộc: `UNIQUE NULLS NOT DISTINCT (org_id, key)`. `key` khớp `^[a-z0-9._-]{1,64}$`.
  - Chỉ job có cờ `tenantSchedulable` mới được đặt lịch. Chu kỳ tối thiểu lấy từ config (không cho cron theo giây với tenant). `orgId` lấy từ context, không nhận từ input. Scheduler gắn `meta.orgId` vào job.
  - Mỗi lần thay đổi thì đồng bộ sang BullMQ. Cron đối soát (chu kỳ lấy từ config) **upsert lại mọi dòng đang bật** và xoá scheduler thừa.
- Test: 2 worker, cron chạy mỗi giây trong vài giây, đếm **số lần chạy theo từng mốc thời gian** (mỗi mốc đúng một lần).

### 5.8 `core/http`
- **Nền tảng:** Express, `rawBody: true`, giới hạn kích thước body theo config (vượt → `413 payload_too_large`), helmet, CORS lấy allowlist từ config. `trust proxy` lấy từ `HTTP_TRUST_PROXY`, parse thành số hop, boolean hoặc danh sách CIDR. Content-Type ngoài `application/json` và `application/merge-patch+json` → `415 unsupported_media_type` (route `/webhooks/*` được loại khỏi middleware này). Route không tồn tại → `404 not_found` dạng problem+json. Với sai method trên một path có thật, Nest chạy trên Express mặc định trả 404. Muốn trả `405 method_not_allowed` kèm header `Allow` thì phải đọc bảng route của router, việc này dính chặt vào Express. Vì vậy sub-project 1 giữ 404, và ghi vào ADR 0007 là giới hạn đã biết.
- **Validate:** Nest 12 dùng `StandardSchemaValidationPipe` với zod (đã kiểm chứng có `exceptionFactory`). Response cũng đi qua schema.
- **Lỗi:** một exception filter duy nhất trả `application/problem+json` đúng hình dạng ở spec cha, mục 3.1: `type`, `title`, `status`, `code`, `detail`, `instance`, `requestId`, `timestamp`, `errors[]`.
  - Lớp `AppError` mang mã lỗi (lấy từ registry), `detail`, danh sách lỗi field và header cần set.
  - `code` dạng `snake_case` thường, registry ném lỗi khi trùng.
  - `type` = `<HTTP_PROBLEM_TYPE_BASE>/<code dạng kebab>`.
  - Lỗi validate của zod chuyển thành `422 validation_failed`: `path` nối bằng dấu chấm, `code` lấy từ mã issue của zod (`invalid_format` + format email → `invalid_email`).
  - Body không parse được → `400 malformed_request`.
  - Lỗi không lường trước thì trả `500 internal_error`, **ghi log đầy đủ ở server** (đã qua serializer bỏ query/params/detail), và không lộ chi tiết ra ngoài.
  - Filter chỉ dùng API chung (`status`, `setHeader`, gửi JSON) để không dính vào Express.
- **Bộ công cụ dùng chung** theo spec cha, mục 3.3: `AppError` + `defineErrorCodes` (mỗi module một file `errors.ts`), `serialize(schema, value)`, `setLocation(res, location)`, `@ApiProblems(...)`, `Paginator`, `mergePatchSchema`, `etagOf`/`assertIfMatch`, `@Idempotent()`. Đều export từ `core/http` hoặc `core/errors`. Toàn bộ mã lỗi của core liệt kê trong bảng ở spec cha, mục 3.2.
- **Response thành công:**
  - Resource đơn trả thẳng object.
  - Helper `Paginator.offset(...)` và `Paginator.cursor(...)` dựng danh sách phẳng đúng spec cha, mục 3.1. `url` lấy từ request context (path không kèm query).
  - Schema zod cho OpenAPI: `offsetPageSchema(item)`, `cursorPageSchema(item)`.
- **Phân trang:**
  - Schema zod chung cho offset (`page`, `pageSize`, `sort`) và cursor (`limit`, `cursor`).
  - Giới hạn tối đa lấy từ config.
  - Offset: đếm có trần bằng subquery `LIMIT cap+1` (không dùng `COUNT(*)` không giới hạn). Vượt trần thì `totalCount` = trần và `totalCountExact: false`, luôn là số. `hasMore` tính cả giới hạn `maxOffsetRows`.
  - Cursor dùng `findByCursor` có sẵn của MikroORM (chuỗi opaque). Cursor hỏng hoặc bị sửa → repository bắt lỗi và ném `400 invalid_cursor`.
  - Đầu vào dùng trong `LIKE` phải được escape `%` và `_`.
- **Concurrency:** helper `etagOf(version)` tạo weak ETag. `assertIfMatch(ifMatch, version, { required })` ném `412 precondition_failed` khi lệch version, và `428 precondition_required` khi route bắt buộc `If-Match` mà client không gửi. `If-None-Match` khớp thì Express tự trả `304`.
- **PATCH:** nhận `application/merge-patch+json` (RFC 7396). Helper `mergePatchSchema(schema)` biến mọi field thành optional, chỉ cho `null` ở field vốn nullable, áp dụng đệ quy cho object lồng.
- **Idempotency** (spec cha mục 3.4): `@node-idempotency/core` + `@node-idempotency/storage`.
  - `core/http` có interceptor mỏng gọi core và ném đúng mã của mình; **không dùng wrapper `@node-idempotency/nestjs`** (không cập nhật từ 10/2025, mất mã lỗi).
  - Storage cài bằng interface `Storage` của thư viện, trên **ioredis dùng chung** (không dùng adapter `redis` v4).
  - Key bắt buộc, 16–128 ký tự `[A-Za-z0-9_-]`. Thiếu hoặc sai → `400 idempotency_key_required`.
  - Scope chỉ lấy từ principal đã xác thực (`type:id:org`) + method + route template, không có fallback header. Sub-project 1 chưa có auth, test dùng principal giả gắn vào CLS bởi middleware của test.
  - Cùng key khác payload → `422 idempotency_key_reused`. Request trùng đang xử lý → `409 idempotency_conflict` (không chờ). Response được lưu và trả lại, kể cả response lỗi.
  - Chỉ lưu header trong allowlist, không lưu `Set-Cookie`. TTL theo nhóm route, lấy từ config.
  - Redis sập → `503 service_unavailable` (fail-closed).
- **Rate limit** (spec cha mục 3.5): `@nestjs/throttler` + storage cài bằng interface `ThrottlerStorage` của Nest trên `rate-limiter-flexible` (`RateLimiterRedis` trên ioredis dùng chung, `insuranceLimiter` là `RateLimiterMemory` khi Redis sập). Tracker theo principal/org, không có thì IP đã qua proxy tin cậy. `@SkipThrottle()` cho `/health/*` và `/webhooks/*`. Mặc định lấy từ config.
- **OpenAPI:** `@nestjs/swagger` sinh spec từ schema zod. Scalar phục vụ ở `/docs`, bật hay tắt theo config (production mặc định tắt), script của Scalar pin version hoặc tự host. Script xuất `openapi.json` chạy với app ở chế độ preview và env giả (không cần DB/Redis); `openapi.json` được commit để CI chạy `oasdiff`.

### 5.9 `core/resilience`
- `cockatiel`: factory tạo policy (timeout, retry có jitter, circuit breaker, bulkhead) theo tên provider. Mọi tham số lấy từ config của provider.
- **HTTP client dùng chung:** `fetch` với `dispatcher` là `Agent` của **`undici`**, bọc trong policy, gắn trace, có timeout connect và timeout tổng.
  - **Chặn SSRF:** `connect.lookup` kiểm tra IP sau khi resolve DNS (chặn DNS rebinding), phân loại bằng **`ipaddr.js`**. Chặn loopback, RFC1918, CGNAT `100.64/10`, link-local, `0.0.0.0/8`, multicast, IPv6 ULA/link-local, IPv4-mapped IPv6, địa chỉ metadata cloud. `redirect: 'manual'`, allowlist port lấy từ config, giới hạn kích thước response lấy từ config.
  - Chỉ retry method idempotent (GET/HEAD/PUT/DELETE) hoặc request có idempotency key.

### 5.10 `core/observability`
- **Log:** `nestjs-pino`.
  - Context từ CLS gắn vào **mọi** dòng log qua pino `mixin()` (kể cả log của job và relay).
  - Serializer lỗi bỏ `query`, `params`, `detail`, `where`; giữ SQLSTATE, constraint, table.
  - Redact: danh sách gốc cố định (authorization, cookie, set-cookie, x-api-key, proxy-authorization, x-sepay-signature, password, token, accessToken, refreshToken, idToken, otp, backupCodes, secret, clientSecret, privateKey, ở nhiều cấp lồng). Env `LOG_REDACT_PATHS` chỉ **thêm** vào. `req.url` bỏ query string.
- **Trace:** file `instrumentation` nạp trước app bằng `--import`, dùng OpenTelemetry Node SDK, auto-instrumentation (http, pg, ioredis) và `bullmq-otel`. Config của instrumentation có env riêng (không phụ thuộc `APP_ROLE`). Tỉ lệ lấy mẫu và endpoint OTLP lấy từ config. `traceparent` do client public gửi được lấy mẫu độc lập (`remoteParentSampled`/`remoteParentNotSampled` theo tỉ lệ). `traceparent` được ghi vào `headers` của outbox và metadata của job, rồi khôi phục khi xử lý. SDK flush sau khi app đóng.
- **Metrics** (xuất qua OTLP):
  - HTTP: số request, số lỗi, độ trễ.
  - Queue: độ sâu, tuổi job cũ nhất, số job failed.
  - Outbox: độ trễ (`now - occurred_at` của event chưa gửi cũ nhất).
  - Pool DB.

### 5.11 `core/health`
- `@nestjs/terminus`. `/health/live` không phụ thuộc gì bên ngoài. `/health/ready` kiểm tra DB (pool app) và Redis, có timeout theo config, kết quả cache ngắn theo config. Không bị rate limit.
- **Tắt êm:** khi nhận SIGTERM, đặt cờ draining → ready trả 503 → chờ khoảng thời gian cấu hình để load balancer ngừng gửi → đóng HTTP server → đóng worker → đóng pool. Tổng thời gian nhỏ hơn `terminationGracePeriodSeconds`.

### 5.12 `core/security`
- **Mã hoá field:** AES-256-GCM bằng `node:crypto`, khoá chủ lấy từ env/secret manager, mỗi bản mã mang `kid` để xoay khoá (hỗ trợ nhiều khoá cùng lúc trong thời gian xoay). Đây **không** phải envelope có KMS; dự án cần KMS thì thay adapter.
  - IV 12 byte, `authTagLength: 16` ở cả mã hoá và giải mã.
  - `encrypt(plain, aad)` với AAD dạng `table:column:orgId:pk`, để bản mã không chuyển được sang dòng khác.
  - `kid` khớp `^[a-z0-9_-]+$`. Parse keyring an toàn (lỗi không in giá trị).
  - Có test cho mã hoá, giải mã, xoay khoá, sửa bản mã, AAD sai.

---

## 6. Entrypoint và thành phần module

| File | Vai trò |
|---|---|
| `main.api.ts` | Bootstrap HTTP, `APP_ROLE=api` |
| `main.worker.ts` | Bootstrap application context (không mở HTTP, trừ cổng health riêng lấy từ config), chạy relay, scheduler, processor |
| `main.migrate.ts` | Chạy migration theo lệnh `up` / `down <to>` / `status`, rồi thoát |
| `app-api.module.ts`, `app-worker.module.ts` | Boilerplate sở hữu. Ghép `core` với danh sách module lấy từ `app.modules.ts` |
| `app.modules.ts` | Dự án sở hữu. Trong sub-project 1 danh sách này rỗng |

Worker cũng cần endpoint health cho K8s probe. Worker mở một HTTP server tối thiểu chỉ phục vụ `/health/*`, cổng lấy từ config.

---

## 7. Luật kiến trúc (dependency-cruiser, chạy trong CI)

1. `features/**` chỉ được import `modules/*/index.ts` và `core/*/index.ts`.
2. `modules/**` không được import `features/**`. Module chỉ được import `index.ts` của module khác.
3. `core/**` không được import `modules/**` hay `features/**`.
4. `@mikro-orm/*` chỉ được import trong `**/infra/**` và `core/database/**`.
5. `bullmq` chỉ được import trong `core/queue/**`.
6. `express`, `fastify` chỉ được import trong `core/http/**`.
7. Trong module: `domain/**` không import `infra/**`, `http/**` hay thư viện hạ tầng.
8. Không có vòng phụ thuộc.
9. `@node-idempotency/*`, `rate-limiter-flexible`, `@nestjs/throttler` chỉ được import trong `core/http/**`; `undici`, `ipaddr.js` chỉ trong `core/resilience/**`.

Mỗi luật có một test "phải fail" (fixture vi phạm) để chứng minh luật hoạt động.

---

## 8. Testing

| Loại | Nội dung trong sub-project 1 |
|---|---|
| Unit | Config schema, envelope, `Paginator`, ETag/`If-Match`, `mergePatchSchema`, registry mã lỗi, mã hoá field, phân loại IP của SSRF, ánh xạ lỗi sang problem+json |
| Integration (Testcontainers) | UnitOfWork + outbox cùng transaction, relay với `SKIP LOCKED` khi nhiều relay chạy song song (batch nhỏ), inbox chống trùng, enqueue trong transaction đi qua outbox, `OrgScope` fail-closed trên bảng fixture có RLS (kể cả connection tái dùng, và gọi lồng trong transaction), `statement_timeout` qua PgBouncer, grant của từng role, migration up → down → up và `down` với tên sai, idempotency đúng từng yêu cầu của IETF draft (kể cả scope giữa 2 principal), rate limit dùng chung giữa 2 instance, chặn SSRF (IP nội bộ, IPv4-mapped, DNS rebinding, redirect) |
| E2E | Endpoint fixture: command ghi dữ liệu + event → subscriber chạy đúng một lần. Endpoint phân trang offset/cursor. Lỗi 4xx/5xx đúng định dạng |
| Chaos (Toxiproxy) | Cắt mạng tới Redis trong lúc có tải (rate limit dùng `insuranceLimiter`, idempotency trả 503), cắt mạng tới Postgres, kill worker giữa job (chờ worker báo đã bắt đầu rồi mới kill) |
| Kiến trúc | Các luật ở mục 7 kèm fixture phải fail |
| Scan hard code | Theo mục 3.1 |

Container Postgres, PgBouncer và Redis được dùng lại trong một lần chạy test. Migration của core và fixture chạy một lần ở `globalSetup`. Mỗi file test dùng prefix Redis riêng; không dùng `sleep` để đồng bộ khi có tín hiệu thay thế. Vitest chạy qua `unplugin-swc`.

---

## 9. Docker, Compose, CI

- **Dockerfile:** theo spec cha, mục 13.3. Tag và digest của base image lấy theo mục 3.2. `CMD` mặc định là api. Compose và K8s override để chạy worker hoặc migrate. `.npmrc` (nếu có token) chỉ qua `--mount=type=secret`, không `COPY`. Kiểm tra file cấu hình thực tế của pnpm (`pnpm-workspace.yaml`/`.npmrc`) trước khi copy.
- **Compose (dev):**
  - Postgres (bản stable mới nhất, image chính thức), PgBouncer (chọn image lúc làm và ghi ADR, vì không có image chính thức), Redis (bản stable mới nhất, image chính thức, có mật khẩu).
  - Mọi port chỉ bind `127.0.0.1`.
  - Service api, worker, migrate dùng chính image build từ repo, mỗi service nhận env file riêng (migrate không đưa mật khẩu owner cho api/worker).
  - Healthcheck dùng `node -e`. Script init tạo DB role.
- **CI (GitHub Actions)**, một workflow cho PR:
  - Cài đặt có cache pnpm store.
  - Chạy song song: lint (oxlint + prettier check), dependency-cruiser, type-check TS 7, unit, integration, gitleaks, osv-scanner, CodeQL.
  - Build app.
  - Docker build có cache `gha`, rồi quét Trivy, fail khi có CVE HIGH/CRITICAL đã có bản vá.
  - Workflow release (khi có tag): **không dùng cache PR ghi được**, build đa kiến trúc, SBOM, provenance, ký cosign keyless, push image.
- Renovate cấu hình cho npm, Docker digest và GitHub Actions, `minimumReleaseAge` 3 ngày.

---

## 10. Rủi ro và điểm cần kiểm chứng

| Rủi ro | Cách xử lý |
|---|---|
| Chuỗi công cụ TS 6 + TS 7 + SWC ESM chưa được Nest hỗ trợ chính thức | Spike S1–S3 làm trước tiên, có nhánh dự phòng |
| Layout build: migration và script không vào `dist/` | Spike S4 chạy `main.migrate up` từ image thật |
| RLS của MikroORM 7.2 còn mới | Pin chính xác version. Test fail-closed chạy bằng `app_user` trên Postgres thật, qua PgBouncer |
| API cụ thể của `findByCursor` (v7: 2 tham số), `bullmq-otel`, interface `Storage` của `@node-idempotency/storage`, `ThrottlerStorage` | Đọc `.d.ts` của version latest trước khi code phần đó |
| `@node-idempotency/*` ít người dùng (1 người maintain) | Chỉ dùng core + interface storage. Chỉ `core/http` được import. Test e2e bám từng yêu cầu của IETF draft chạy trong CI |
| PgBouncer không có image chính thức | Chọn image lúc làm, ghi ADR, pin digest |
| Khoảng trống giữa enqueue và commit ở relay | Chấp nhận có thể trùng; inbox chặn lại. Có test riêng |

---

## 11. Sản phẩm bàn giao

- Code `core/` và entrypoint như trên, tất cả test xanh.
- ADR 0001–0007, 0009, 0011–0016 trong `docs/adr/`. ADR 0013 kèm số liệu đo được. ADR 0007 ghi các lựa chọn thư viện HTTP (idempotency, rate limit) cùng ứng viên đã loại.
- `README.md`: cách chạy dev, danh sách env (sinh từ schema), cách thêm queue, job, cron, event.
- Bảng số liệu đo được (mục 1, tiêu chí 12), so với mục tiêu.
