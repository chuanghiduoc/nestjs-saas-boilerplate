# Lõi SaaS NestJS — Thiết kế kiến trúc tổng thể

- **Ngày:** 2026-09-24
- **Trạng thái:** Đã duyệt thiết kế (bản preview 8), cập nhật ngày 2026-09-25 theo review trước thực thi (`docs/superpowers/reviews/2026-09-25-sp1-pre-execution-review.md`). Spec này là nguồn sự thật. Mỗi sub-project sẽ có spec chi tiết riêng.
- **Preview trực quan:** https://claude.ai/code/artifact/e0e359e9-5a99-4ebc-b60f-4c17a86c9688
- **Version thư viện:** kiểm tra trên npm registry và GitHub releases ngày 2026-09-24. Khi code sẽ pin chính xác.

---

## 0. Bối cảnh và ràng buộc

### 0.1 Mục tiêu
Boilerplate backend NestJS **tự đứng được**, bao gồm auth, multi-tenant, gói/entitlement, thanh toán SePay, thông báo, file, audit, webhook ra ngoài, admin, và hạ tầng job/lịch. Mỗi dự án **clone thành repo riêng**, chỉ viết nghiệp vụ trong `src/features/`, và nhận bản vá của boilerplate bằng `git merge upstream`.

### 0.2 Ràng buộc
- Team mỗi dự án nhỏ, không có SRE riêng. Chi phí vận hành và gánh nặng trực sự cố là ràng buộc thật.
- Thứ tự ưu tiên khi các mục tiêu xung đột: đúng → bảo mật → tin cậy → dễ bảo trì → mở rộng → hiệu năng.
- Phải thay được ORM, đổi loại DB, hoặc thêm DB khác. Trong công ty thì dùng được CRM/admin sẵn có.
- Chuyển khoản lệch (thiếu, thừa, không khớp) xử lý thủ công.

### 0.3 Số liệu thiết kế (giá trị mặc định, dự án điều chỉnh khi có số thật)
| Chỉ số | Giá trị |
|---|---|
| Org / dự án | ≤ 10.000 |
| User / dự án | ≤ 200.000 |
| API đỉnh | 300 RPS, đọc/ghi ≈ 80/20 |
| Job | ≤ 2 triệu/ngày, đỉnh 200/giây |
| Dữ liệu | < 50 GB/năm (không tính file) |
| Vùng | Việt Nam, một region |

Thiết kế phải chịu được gấp 10 lần các giá trị trên mà không phải làm lại, và không tối ưu sớm vượt mức đó.

### 0.4 Các giá trị mặc định đã chấp nhận
Những điểm còn mở ở phụ lục C của preview được chốt theo đề xuất. Dự án được đổi qua config hoặc ADR:
- RPO ≤ 5 phút, RTO ≤ 1 giờ.
- Deploy: Kubernetes + Helm. Nếu không có K8s thì dùng Docker Compose (phương án dự phòng).
- ID: PK `BIGINT` identity nội bộ, `public_id` UUIDv7 khi ra ngoài. ID của org là UUIDv7; với bảng Better Auth, `generateId: 'uuid'` trên Kysely/Postgres để DB dùng `DEFAULT uuidv7()` (SP2 §11.2, S2-R41); organization thuộc SP3.
- Observability: xuất qua OTLP, backend (tự host hay dịch vụ ngoài) do dự án chọn.

---

## 1. Cấu trúc hệ thống

**Modular monolith**: một codebase, một image, hai process (`api`, `worker`). Bên trong mỗi module là **layered + ports & adapters**.

```
features/*  (vùng dự án)  →  modules/*  (vùng boilerplate)  →  core/*  (hạ tầng)
trong module:  http → application → domain ;  infra → ports
```

- Module chỉ lộ ra ngoài qua `index.ts`. Module ngang hàng gọi nhau qua public API đồng bộ, hoặc qua domain event đi qua outbox.
- `api`: HTTP, guard, nhận webhook. Stateless, scale ngang.
- `worker`: processor, Job Scheduler, outbox relay. Chọn queue qua `WORKER_QUEUES`.
- **Không làm:** microservices, SOA/ESB, Nest monorepo `apps/libs`.
- **Xem lại khi:** một module cần nhịp deploy riêng, cần scale khác hẳn phần còn lại, hoặc được giao cho team khác sở hữu. Khi đó thay lời gọi public API bằng HTTP/gRPC, và thay event trong process bằng broker.

### 1.1 Vùng sở hữu và nhận cập nhật từ upstream
- `core/`, `modules/`: thuộc boilerplate, dự án **không sửa**. CI của dự án báo lỗi nếu PR sửa hai thư mục này mà không phải commit merge từ upstream.
- `features/`, `app.modules.ts`, `src/migrations/app/`: thuộc dự án.
- Boilerplate gắn tag semver và có `CHANGELOG.md`. Dự án nhận bản vá bằng `git fetch upstream && git merge vX.Y.Z`.
- Dự án tuỳ biến phần nền qua 4 cách: config, adapter, domain event, hoặc bỏ module. Nếu cả 4 cách đều không đủ thì sửa ở boilerplate để mọi dự án cùng được lợi.

---

## 2. Thiết kế domain

DDD chiến thuật ở mức vừa đủ. **Bounded context trùng với module.**

| Context | Aggregate | Event tiêu biểu |
|---|---|---|
| Identity | User, Session, Account, ApiKey (schema do Better Auth quản lý) | `identity.user.registered` |
| Tenancy & Access | Organization, Member, Invitation, Role | `tenancy.member.added`, `tenancy.role.changed` |
| Entitlements | Plan, OrgEntitlement, UsageCounter | `entitlements.quota.exceeded` |
| Billing | Subscription, Invoice, PaymentTransaction | `billing.invoice.paid`, `billing.subscription.renewed`, `billing.payment.needs_review` |
| Notifications | Notification, Preference, Template | `notifications.delivery.failed` |
| Files | File | `files.file.uploaded` |
| Audit | AuditEntry (append-only, chỉ tiêu thụ event) | — |
| Integrations | WebhookEndpoint, Delivery | `integrations.delivery.exhausted` |

Quy ước:
- **Context map:** Billing là upstream của Entitlements, Identity là upstream của Tenancy, Audit là conformist. Không context nào đọc thẳng bảng của context khác.
- **Aggregate:** một transaction chỉ sửa một aggregate. Ngoại lệ: các aggregate cùng module được sửa chung transaction nếu có ADR giải thích. Ví dụ Invoice PAID và Subscription gia hạn nằm chung một transaction.
- **Entity:** trạng thái chỉ đổi qua method của aggregate, ví dụ `invoice.markPaid(txn)`.
- **Value object:** bất biến, kiểm tra hợp lệ ngay khi tạo. Ví dụ `Money` (VND, bigint), `Email`, `PaymentCode`, `BillingPeriod`, `Permission`, và ID dùng branded type.
- **Domain event:** tên dạng `context.aggregate.verb`, payload có version, ghi vào outbox cùng transaction với thay đổi.
- **State machine:** enum + một hàm chuyển trạng thái, dùng `switch` vét cạn có kiểm tra `never`. Không dùng cờ boolean rời rạc.
- **Repository:** mỗi aggregate root một port, method đặt theo use case (ví dụ `findOpenForUpdate(id)`).
- Domain là TypeScript thuần, không dùng decorator của ORM.
- **Không làm:** một aggregate Organization ôm mọi thứ, domain dùng entity của ORM, DDD cho feature CRUD đơn giản.

---

## 3. Thiết kế API

| Chủ đề | Quyết định |
|---|---|
| Kiểu | REST + JSON, OpenAPI 3.1 sinh từ schema zod (Standard Schema của Nest 12) |
| Versioning | `/v1` trên URI. Trong một version chỉ được thêm. Deprecate bằng header `Deprecation` và `Sunset`. `oasdiff` trong CI chặn breaking change |
| Response thành công | **Resource đơn trả thẳng object**, không bọc. **Danh sách** là object phẳng (xem 3.1). `201` kèm `Location`. `204` cho DELETE. `202` + resource operation cho việc chạy lâu |
| Pagination | **Hai chế độ.** Offset `?page=&pageSize=` cho UI dạng bảng, giới hạn `page × pageSize ≤ 10.000`. `totalCount` đếm chính xác tới trần 10.000; vượt trần thì `totalCount` = trần và `totalCountExact: false`. Cursor `?limit=&cursor=` cho feed, log, export, đồng bộ. Cursor là chuỗi opaque do MikroORM sinh; cursor hỏng → `400 invalid_cursor`. Cả hai dùng sẵn của MikroORM (`findAndCount`, `findByCursor`) |
| Lọc / sắp xếp | Chỉ trường có trong allowlist, trường nào cũng phải có index |
| Lỗi | RFC 9457 `problem+json` (xem 3.1). `code` dạng `snake_case` thường, duy nhất toàn hệ thống (registry kiểm tra trùng lúc khởi động). Validate sai → `422 validation_failed`. Body không parse được → `400 malformed_request`. Không bao giờ trả stack trace |
| Idempotency | Theo IETF `draft-ietf-httpapi-idempotency-key-header-07`, dùng `@node-idempotency/core`. Chi tiết ở 3.4 |
| Concurrency | GET resource trả `ETag` (weak, lấy từ version). PATCH/PUT gửi `If-Match`, sai version → `412 precondition_failed`. `If-None-Match` → `304` |
| PATCH | JSON Merge Patch (RFC 7396, `application/merge-patch+json`) |
| ID | Ra ngoài dùng UUIDv7 `public_id`, PK nội bộ là `BIGINT` |
| Định dạng | JSON camelCase. Thời gian ISO 8601 UTC. Tiền là `{ "amount": "150000", "currency": "VND" }` (amount là chuỗi số nguyên). Enum `UPPER_SNAKE`. Field nullable luôn có mặt với giá trị `null`. Không có trường `object` |
| Xác thực | Better Auth: session cookie (web), bearer (mobile), API key (máy). Xem mục 11 |
| Phân quyền | Guard theo thứ tự `Auth → Org → Ability (CASL) → Entitlement` |
| Rate limit | `@nestjs/throttler` + `rate-limiter-flexible` cho mọi endpoint, theo principal/org hoặc IP (đã qua proxy tin cậy), theo gói. Đăng nhập dùng Better Auth `storage: 'database'` + lockout `RateLimiterPostgres` atomic (SP2 §11.2, mục 11). Trả `429` + `Retry-After`. Chi tiết ở 3.5 |
| Webhook vào | `/webhooks/*`: verify chữ ký **trước**, rồi mới lưu raw payload, trả ngay. Không đi qua guard của user, rate limit (`@SkipThrottle()`) hay middleware Content-Type chung |

### 3.1 Hình dạng response (đã chốt 2026-09-25)

```jsonc
// Resource đơn
{ "id": "019dd1a5-9235-70db-8d57-54ef901d8185", "email": "me@example.com", "name": "Me", "role": "USER",
  "createdAt": "2026-04-30T22:28:27.356Z", "updatedAt": "2026-04-30T22:28:27.356Z" }

// Danh sách, offset
{ "url": "/api/v1/admin/users", "data": [ … ],
  "page": 1, "pageSize": 20, "totalCount": 1284, "totalCountExact": true, "hasMore": true }

// Danh sách, cursor
{ "url": "/api/v1/audit-logs", "data": [ … ], "hasMore": true, "nextCursor": "eyJ…" }

// Lỗi (application/problem+json)
{ "type": "/errors/validation-failed", "title": "Validation failed", "status": 422,
  "code": "validation_failed", "detail": "One or more fields did not pass validation.",
  "instance": "/api/v1/users", "requestId": "019dd1a5-…", "timestamp": "2026-04-30T22:28:27.356Z",
  "errors": [{ "path": "email", "code": "invalid_email", "message": "email must be an email" }] }
```
- `url` là path của request, không kèm query string.
- `errors[].path` dạng chấm với chỉ số mảng (`items.0.quantity`), khớp định dạng tên field của thư viện form phía frontend. `errors[].code` ổn định để frontend map. `message` dịch theo `Accept-Language`.
- `type` là đường dẫn tới trang tài liệu của lỗi (`<base>/<code-dạng-kebab>`). Base lấy từ config.
- **Ngoại lệ SP2 §11.2:** đăng ký/đổi email trả `202` chung không body, không resource operation, để chống dò email.
- **Việc chạy lâu** (import, export, báo cáo): `202 Accepted` kèm `Location: /v1/operations/{id}`, body là resource operation `{ id, status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED", result?, error?, createdAt, updatedAt }`. Module `operations` được làm ở sub-project đầu tiên cần tới nó.

### 3.2 Bảng status code (bắt buộc cho mọi module)

| Status | Khi nào | `code` |
|---|---|---|
| `200` | GET thành công, PUT/PATCH thành công (trả resource sau khi sửa), POST dạng hành động không tạo resource | — |
| `201` | POST tạo resource. Body là resource vừa tạo, header `Location` trỏ tới nó | — |
| `202` | Nhận việc chạy nền. Body là resource operation, header `Location: /v1/operations/{id}`; ngoại lệ đăng ký/đổi email SP2 trả 202 rỗng | — |
| `204` | DELETE thành công, hoặc hành động không có gì để trả | — |
| `304` | `If-None-Match` khớp ETag hiện tại | — |
| `400` | Request sai cú pháp: body không parse được, header bắt buộc thiếu, cursor hỏng, org context sai định dạng | `malformed_request`, `idempotency_key_required`, `invalid_cursor`, `org_context_invalid` |
| `401` | Chưa xác thực, hoặc session/token hết hạn | `unauthenticated` |
| `403` | Đã xác thực nhưng không có quyền. Gói không có tính năng thì dùng mã riêng | `forbidden`, `feature_not_in_plan` |
| `404` | Không tồn tại, **hoặc tồn tại nhưng thuộc org khác** (không để lộ sự tồn tại) | `not_found` |
| `405` | Method không hỗ trợ trên route. Mã được dành sẵn. Hiện trả `404`, vì Nest/Express không phân biệt được hai trường hợp này nếu không đọc bảng route (ADR 0007) | `method_not_allowed` |
| `409` | Xung đột trạng thái: trùng unique, sai trạng thái trong state machine, request cùng `Idempotency-Key` đang được xử lý | `conflict` hoặc mã nghiệp vụ cụ thể (`invoice_not_open`), `idempotency_conflict` |
| `412` | `If-Match` không khớp version hiện tại | `precondition_failed` |
| `413` | Body vượt giới hạn | `payload_too_large` |
| `415` | Content-Type không hỗ trợ | `unsupported_media_type` |
| `422` | Dữ liệu đúng cú pháp nhưng sai quy tắc: validate schema, dùng lại Idempotency-Key với body khác, vượt quota | `validation_failed`, `idempotency_key_reused`, `quota_exceeded` |
| `428` | Route bắt buộc `If-Match` mà client không gửi | `precondition_required` |
| `429` | Vượt rate limit, có kèm `Retry-After` | `rate_limited` |
| `500` | Lỗi không lường trước. Log đầy đủ ở server, client chỉ nhận mã chung | `internal_error` |
| `502` | Dịch vụ ngoài trả lỗi | `upstream_error` |
| `503` | Đang tắt, DB/Redis quá tải hoặc timeout, circuit breaker đang mở. Có `Retry-After` khi biết | `service_unavailable` |
| `504` | Dịch vụ ngoài không trả lời kịp | `upstream_timeout` |

**Map lỗi DB** (làm một lần trong `core/database`, module không tự bắt lỗi của driver):

| Lỗi Postgres | Kết quả |
|---|---|
| unique violation (`23505`) | `409`. Nếu tên constraint có trong registry (`defineConstraintErrors`) thì dùng mã cụ thể (ví dụ `users_email_uq` → `email_taken`), không thì dùng `conflict`. Không bao giờ lộ tên constraint ra client |
| foreign key violation (`23503`) | `409 conflict` (đang bị tham chiếu) hoặc `422 validation_failed` (tham chiếu tới thứ không tồn tại), theo registry |
| check violation (`23514`) | `422 validation_failed` |
| row-level security (`42501`) | `404 not_found`. Đồng thời ghi log mức warn và event bảo mật, vì lỗi này nghĩa là app đã bỏ sót một bước kiểm tra |
| serialization failure / deadlock (`40001`, `40P01`) | Tự retry trong `UnitOfWork` (số lần lấy từ config). Hết lượt → `503 service_unavailable` |
| statement timeout (`57014`) | `503 service_unavailable` |
| Mọi lỗi khác | `500 internal_error` |

### 3.3 Thành phần dùng chung (không module nào tự viết lại)

| Việc | Dùng | Cấm |
|---|---|---|
| Ném lỗi nghiệp vụ | `throw new AppError(Errors.X, { detail, fields })`, với `Errors` khai báo bằng `defineErrorCodes` trong `errors.ts` của module | `throw new HttpException(...)`, `res.status(...)`, trả `{ success: false }` |
| Status thành công | Mặc định của Nest (GET/PUT/PATCH `200`, POST `201`), `@HttpCode(204)` cho DELETE, `@HttpCode(202)` cho việc chạy nền. Header `Location` qua helper `setLocation(res, url)` | Tự set status trong service |
| Validate input | Schema zod ở `http/schemas.ts`, gắn vào `@Body/@Query/@Param` | Validate tay trong controller |
| Output | Schema zod response. Controller trả qua `serialize(schema, value)` để loại field nội bộ | Trả thẳng entity ORM |
| Danh sách | `Paginator.offset` / `Paginator.cursor` cùng `offsetPageSchema` / `cursorPageSchema` | Tự dựng `{ data, total }` |
| PATCH | `mergePatchSchema(schema)` + `assertIfMatch` | PUT từng phần tự chế |
| Idempotency | `@Idempotent()` export từ `core/http` (interceptor mỏng trên `@node-idempotency/core`, scope lấy từ principal) | Import thẳng package, tự kiểm tra key |
| Rate limit | `@Throttle()` / `@SkipThrottle()` của `@nestjs/throttler`, storage do `core/http` cung cấp | Tự đếm request |
| Tài liệu lỗi trong OpenAPI | `@ApiProblems(Errors.X, Errors.Y)` liệt kê lỗi route có thể trả | Không khai báo |
| Controller | Mỏng: parse → `CommandBus`/`QueryBus` → serialize. Không có logic nghiệp vụ | Gọi repository từ controller |

### 3.4 Idempotency (đã chốt 2026-09-25, đã spike trên Nest 12.1)

Theo IETF `draft-ietf-httpapi-idempotency-key-header-07` (vẫn là draft). Dùng `@node-idempotency/core` vì là thư viện duy nhất đạt cả 6 kịch bản spike (xem báo cáo review). `core/http` có một interceptor mỏng gọi core và ném đúng mã lỗi của mình; storage cài bằng interface `@node-idempotency/storage` trên **ioredis dùng chung** (không dùng adapter `redis` v4).

- **Bắt buộc key** trên route `@Idempotent()` (POST/PATCH tạo tiền hoặc side effect). Thiếu hoặc sai định dạng → `400 idempotency_key_required`. Key là chuỗi 16–128 ký tự `[A-Za-z0-9_-]` (khuyến nghị UUID).
- **Scope** chỉ lấy từ principal đã xác thực: `<principal.type>:<principal.id>:<orgId>`, cộng method và route template. **Không** có fallback theo header. Route `@Idempotent()` mà không có principal thì từ chối lúc khởi động hoặc trả `401`.
- **Cùng key, payload khác** (fingerprint gồm method, route, body đã chuẩn hoá) → `422 idempotency_key_reused`.
- **Request trùng đang xử lý** → `409 idempotency_conflict` ngay, không chờ.
- **Response được lưu và trả lại, kể cả response lỗi.** Client đã sửa request thì phải dùng key mới (đúng yêu cầu của draft).
- **Dữ liệu lưu:** status, body, và chỉ những header trong allowlist (`Location`, `ETag`, `Content-Type`); **không bao giờ** lưu `Set-Cookie`. TTL theo nhóm route, lấy từ config (route tiền dùng TTL ngắn hơn mặc định 24 giờ).
- **Redis sập** → `503 service_unavailable` (fail-closed), vì chạy mà không có idempotency thì có thể trừ tiền hai lần.

### 3.5 Rate limit và proxy

- `@nestjs/throttler` (decorator, guard) + storage cài bằng `rate-limiter-flexible`: `RateLimiterRedis` trên ioredis dùng chung, `insuranceLimiter` là `RateLimiterMemory` khi Redis sập (giảm chức năng nhưng vẫn có giới hạn theo pod).
- **Tracker:** principal/org nếu đã xác thực, ngược lại là IP của client. IP lấy qua `trust proxy` với `HTTP_TRUST_PROXY` được parse thành số hop, boolean hoặc danh sách CIDR, không tin header `X-Forwarded-For` tuỳ tiện.
- `@SkipThrottle()` cho `/health/*` và `/webhooks/*`.

**Giữ khả năng đổi Express sang Fastify:**
- Chỉ `core/http` được import `express`/`fastify`.
- Không dùng middleware riêng của Express trong module.
- **SP2 §11.2:** Nest `bodyParser: false`; `core/http` đọc bằng `jsonBodyParser` (raw-body 4.0.0, giới hạn stream, đặt `req.rawBody`) trừ prefix module khai báo qua `HTTP_BODY_PARSER_SKIP_PREFIX`. `/api/auth/*` do `AuthMountMiddleware` đọc sau kiểm credential/CSRF; external không bỏ qua prefix. 413 dùng bounded linger, xem ADR 0007 (S2-R1/S2-R12/S2-R13/S2-R16/S2-R50).
- CI hằng đêm chạy e2e trên cả hai nền tảng.

**Không làm:** GraphQL, gRPC ra ngoài, version theo header.

---

## 4. Data architecture

- **PostgreSQL** là nguồn sự thật duy nhất cho dữ liệu nghiệp vụ. Redis chỉ giữ dữ liệu mất đi vẫn dựng lại được (cache, rate limit, queue có outbox làm nguồn, response idempotency).
- **Redis tách theo loại tải:** queue và idempotency chạy trên instance/DB `noeviction` có cảnh báo bộ nhớ; cache (khi có) chạy riêng với `maxmemory` + `allkeys-lru`. BullMQ đặt `removeOnFail` theo cả tuổi và số lượng.
- **Schema:**
  - Tên snake_case, số nhiều.
  - PK `BIGINT GENERATED ALWAYS AS IDENTITY`. Thời gian `TIMESTAMPTZ` UTC. Tiền `BIGINT` VND. Enum là `TEXT` + `CHECK`.
  - Mọi bảng có `created_at`/`updated_at`. Soft delete chỉ khi có yêu cầu thật.
- **Chuẩn hoá (luật bắt buộc, thêm 2026-09-27):**
  - Mọi thiết kế bảng **phải** đạt tối thiểu 3NF, ưu tiên BCNF trở lên. Mục tiêu: không có dị thường cập nhật, và khi yêu cầu đổi hay hệ thống mở rộng thì số chỗ phải sửa là ít nhất.
  - **Phi chuẩn hoá chỉ được phép khi có lý do tường minh dựa trên bằng chứng**, ví dụ:
    - đường đọc nóng **đã đo được** (kèm số đo `EXPLAIN (ANALYZE, BUFFERS)` hoặc `pg_stat_statements`);
    - snapshot audit hay lịch sử **không được thay đổi** theo nguồn;
    - schema do thư viện sở hữu (ví dụ bảng của Better Auth), đổi hình dạng thì hỏng thư viện.
  - Mọi chỗ phi chuẩn hoá được phép **phải ghi cơ chế giữ các bản sao nhất quán**: trigger, outbox, hoặc constraint (với snapshot bất biến: quyền `UPDATE` theo cột hoặc trigger chặn sửa).
  - **Enum:** bảng lookup có FK, hoặc enum native / `TEXT` + `CHECK`. Không bao giờ là chuỗi tự do.
  - **Thuộc tính đa trị** nằm ở bảng con. Không dùng danh sách nối dấu phẩy hay JSON không giới hạn, trừ khi giá trị thật sự là một tài liệu mờ (opaque document: không query, không ràng buộc theo từng phần tử).
  - Cột của mình thêm vào bảng do thư viện sở hữu vẫn phải tuân luật này.
  - **Mọi spec hoặc plan có tạo hay sửa bảng phải kèm bảng chuẩn hoá:** với mỗi bảng ghi khoá ứng viên, các phụ thuộc hàm không tầm thường, dạng chuẩn đạt được, và mọi ngoại lệ kèm lý do cùng cơ chế giữ nhất quán. Review spec từ chối bản thiếu bảng này.
- **FK:** mặc định `RESTRICT`. `CASCADE` chỉ khi bảng con hoàn toàn thuộc về bảng cha. Không bao giờ cascade trên bảng tiền, audit hay lịch sử.
- **Transaction:** `READ COMMITTED` + lock tường minh (`FOR UPDATE`, `UPDATE … WHERE` có điều kiện, UNIQUE, version column). `SERIALIZABLE` chỉ dùng ở chỗ cần và có retry khi gặp `40001`.
- **Index:** mọi FK đều có index. Index của bảng tenant bắt đầu bằng `org_id`. Bật `pg_stat_statements`. Query nóng phải kèm `EXPLAIN (ANALYZE, BUFFERS)` chạy trên dữ liệu seed đủ lớn.
- **Migration:**
  - Viết bằng SQL (`addSql`) và luôn có down.
  - **Grant theo từng bảng** ngay trong migration tạo bảng. Không dùng `ALTER DEFAULT PRIVILEGES` cấp tràn lan. Bảng audit chỉ được INSERT/SELECT, kèm trigger chặn UPDATE/DELETE.
  - `migrate down` phải chỉ rõ migration đích có trong danh sách đã chạy; muốn revert toàn bộ phải ghi `0` tường minh.
  - Đi theo expand → backfill → contract. Dùng `CREATE INDEX CONCURRENTLY` trong migration không chạy transaction. `lock_timeout = 5s`.
  - CI chạy up → down → up.
  - Migration chạy thành Job trước khi rollout. Mỗi module một thư mục, riêng dự án dùng `src/migrations/app/`.
- **Bảng lớn** (`audit_logs`, `webhook_deliveries`, `notifications`): partition theo tháng, hết hạn thì drop partition.
- **Replication:** primary + standby để failover. Read replica chỉ dùng cho báo cáo. Đọc ngay sau khi ghi thì đọc từ primary.
- **Sharding:** không làm. Đường đã sẵn: mọi bảng tenant có `org_id` và FK kép.
- **Eventual consistency** chỉ ở các chỗ đã biết trước: audit, thông báo, webhook ra ngoài, read model, entitlements sau khi thanh toán.
- **Nhiều DB:** mỗi DB là một connection có tên (`contextName` của `@mikro-orm/nestjs`). Một aggregate chỉ nằm ở một DB. Đồng bộ sang DB khác đi qua outbox. Không có transaction xuyên hai DB.

### 4.1 Cô lập tenant (RLS, fail-closed)
| Lớp | Cơ chế | Chặn lỗi nào |
|---|---|---|
| Một mẫu policy duy nhất | Policy viết trong migration SQL theo một mẫu chuẩn dùng `app_current_org()`. Filter `rls: true` của MikroORM **không** dùng để sinh policy (tránh hai nguồn sự thật), quyết định ghi ở ADR 0005 | Policy mỗi bảng viết một kiểu, lệch nhau |
| 4 DB role | `app_owner` chạy migration. `app_user` dùng cho api/worker, không phải owner, không BYPASSRLS. `app_relay` (không BYPASSRLS) chỉ có quyền trên bảng hạ tầng `outbox_events`, `processed_events`, `scheduled_tasks` cho relay, cleanup, reconcile, metrics. `app_admin` có BYPASSRLS, chỉ dùng cho thao tác quét nhiều org được khai báo tường minh (admin, cron nghiệp vụ), **không bao giờ khởi tạo trong process api**. Bảng bật `rowLevelSecurity: 'force'` | App chạy bằng owner nên đi vòng qua RLS; một lỗi ở đường admin làm lộ mọi org |
| Fail-closed | Mọi policy dùng hàm `app_current_org()`: đọc `current_setting('app.org_id', true)` và **ném lỗi** khi NULL hoặc rỗng (connection trong pool từng được set sẽ trả chuỗi rỗng chứ không báo lỗi). Session context set sau `BEGIN`, chạy được với PgBouncer transaction mode | Quên set org thì query báo lỗi, không lộ dữ liệu |
| FK kép | Bảng cha có `UNIQUE(org_id, id)`, bảng con dùng `FOREIGN KEY (org_id, parent_id)` | Dữ liệu org A trỏ sang dữ liệu org B |
| `withOrg()` / `OrgScope` | Org của request chỉ được tin sau khi guard xác thực principal và kiểm tra membership (`X-Org-Id` chỉ là lựa chọn của user, không phải bằng chứng). Job mang `meta.orgId` và **luôn** chạy trong `OrgScope`. `OrgScope` không được đổi org bên trong một transaction đang mở (ném lỗi) | Request và job mỗi nơi set context một kiểu; transaction chạy nhầm org |
| Bảng hạ tầng | `app_user` chỉ được INSERT vào `outbox_events`, INSERT + đọc cột tối thiểu trên `processed_events`. `scheduled_tasks` bật RLS + FORCE | Một bug ở tenant đọc payload event của mọi org hoặc sửa outbox trước khi relay |
| CI | Kiểm tra `pg_class`/`pg_policies`: bảng nào có `org_id` cũng phải bật RLS + FORCE và có policy, bảng global phải nằm trong allowlist. Test isolation chạy bằng `app_user` | Thêm bảng mới mà quên bật RLS, hoặc bug của RLS trong MikroORM |

**SP2 §11.2:** bảng Better Auth nằm trong schema `auth` riêng, không có org_id và ngoài RLS; runtime chỉ pool `auth_user` truy cập, không quyền trên `public`. `PUBLIC` không USAGE schema `public`, không CONNECT/TEMPORARY database. Membership/organization thuộc SP3. Token OAuth mã hoá bằng `FieldCipher`, AAD `auth.account:<cột>:-:<providerId>/<accountId>`; `email_deliveries` dùng public_id sinh ở app trước INSERT để dựng AAD.

### 4.2 Ports & adapters để thay ORM hoặc DB
- dependency-cruiser cấm import `@mikro-orm/*` ngoài `infra/` và `core/database/`.
- Port viết theo use case và ghi rõ bảo đảm của nó (khoá dòng, atomic). Transaction và outbox đi qua port `UnitOfWork`. Job handler không import BullMQ.
- Mỗi port có một bộ **contract test** chạy được với mọi adapter.
- **Bắt buộc** với module nền. **Tuỳ chọn** với `features/` (CRUD đơn giản được dùng MikroORM thẳng trong service).
- Cái giá phải trả: mỗi aggregate thêm một mapper và một interface. Rời Postgres thì adapter phải tự làm lại các bảo đảm của RLS, partial index, `SKIP LOCKED`.

---

## 5. Distributed systems

- **Timeout, lớp ngoài dài hơn lớp trong:** load balancer 30s > request HTTP 20s > `statement_timeout` 5s (api) / 60s (worker) > HTTP ra ngoài (connect 2s, tổng 10s). Redis command 1s.
  - `statement_timeout` và `idle_in_transaction_session_timeout` đặt bằng `ALTER ROLE … SET` (PgBouncer transaction mode bỏ startup parameter), worker nâng lên bằng `SET LOCAL` đầu transaction. Test kiểm tra đi qua PgBouncer.
  - Không gọi I/O ra ngoài bên trong transaction DB: ghi ý định trong transaction, gọi provider sau commit với idempotency key của provider.
- **Retry:** exponential backoff + full jitter, chỉ retry thao tác idempotent (HTTP client chỉ retry GET/HEAD/PUT/DELETE hoặc request có idempotency key). Trong request HTTP thì không retry thao tác ghi.
- **Circuit breaker:** chỉ áp cho provider ngoài. Ở worker, provider lỗi liên tục thì pause queue của provider đó. Dùng `cockatiel`.
- **Idempotency ở mọi điểm vào:** `Idempotency-Key`, `UNIQUE(provider, txn_id)`, `jobId` tính từ dữ liệu cộng inbox, `Webhook-Id` khi gửi ra ngoài.
- **Lock:** ưu tiên constraint và row lock. Việc chỉ được một instance làm thì dùng `pg_try_advisory_xact_lock`. Không dùng Redlock.
- **CAP:** ghi nghiệp vụ theo CP (một primary). Redis sập thì hệ thống giảm chức năng chứ không sai dữ liệu.
- **Đồng hồ:** mốc thời gian nghiệp vụ lấy `now()` của DB.
- **Race condition đã gọi tên:**

| Tình huống | Cơ chế chặn |
|---|---|
| Webhook trùng | `UNIQUE(provider, provider_txn_id)` |
| Hai job khớp cùng một invoice | `SELECT … FOR UPDATE` + `WHERE status='OPEN'`, jobId `match:{txnId}` |
| Trùng mã thanh toán | `UNIQUE(payment_code)` |
| Hai subscription đang sống | Partial unique `(org_id) WHERE status IN ('TRIALING','ACTIVE','PAST_DUE')` |
| Vượt quota khi request song song | `UPDATE … SET used=used+n WHERE used+n<=limit RETURNING` |
| Cron chạy trùng | Job Scheduler + `UNIQUE(subscription_id, period_start)` |
| Session bị lộ | Session lưu trong DB nên thu hồi có hiệu lực ngay, xác thực lại trước thao tác nhạy cảm |
| Nhận lời mời hai lần | `UNIQUE(org_id, user_id)` |

---

## 6. Async / messaging

- **BullMQ 6 trên Redis** làm work queue. **Outbox trong Postgres** là nguồn sự thật cho mọi domain event (relay đọc bằng `SKIP LOCKED`, batch 100 dòng).
- **Fan-out:** mỗi event thành một job cho mỗi subscriber.
- **Event envelope:** `id` (UUIDv7), `type`, `version`, `occurredAt`, `orgId`, `actor`, `aggregate{type,id,version}`, `correlationId`, `causationId`, `traceparent`, `data` (validate bằng zod theo `type@version`).
- **Thứ tự:** không hứa thứ tự toàn cục. Consumer bỏ qua event có `aggregate.version` cũ hơn thứ đã xử lý. Luồng bắt buộc tuần tự chạy qua queue có concurrency 1.
- **Chống trùng:** bảng inbox `processed_events(consumer, event_id)` UNIQUE, ghi cùng transaction với side effect **trong DB**. jobId của BullMQ chỉ chống trùng trong cửa sổ ngắn, không phải bảo đảm chính.
- **Enqueue trong transaction:** luôn ghi outbox, không gọi Redis trực tiếp (job có thể chạy trước commit hoặc sau rollback). Ngoài transaction mới enqueue trực tiếp, jobId sinh một lần và dùng lại khi phải chuyển sang outbox.
- **Job theo tenant:** handler luôn chạy trong `OrgScope` với `meta.orgId`. Lịch do tenant tự đặt chỉ được chọn job có cờ `tenantSchedulable`, có chu kỳ tối thiểu (không cho cron theo giây), `orgId` lấy từ context chứ không từ input, `key` khớp `^[a-z0-9._-]{1,64}$`.
- **Dead-letter:** tập failed của BullMQ. Payload sai thì ném `UnrecoverableError`. Cảnh báo khi số job failed tăng.
- **Giới hạn Redis:** đặt `removeOnComplete`/`removeOnFail` theo tuổi và số lượng. Payload chỉ chứa ID.
- **Saga:** chưa cần ở v1. Khi cần thì làm orchestrator lưu trạng thái trong DB, mỗi bước là một job idempotent, có bước compensate.
- **Queue mặc định:** `billing` (concurrency thấp), `notifications`, `webhooks-out`, `maintenance`, `default`, và queue riêng của dự án.
- **Cron có sẵn** (múi giờ `Asia/Ho_Chi_Minh`):

| Job | Lịch | Việc |
|---|---|---|
| `billing.create-renewal-invoices` | 01:00 hằng ngày | Tạo invoice gia hạn trước khi hết kỳ 7 ngày |
| `billing.send-reminders` | 09:00 hằng ngày | Nhắc vào T-7, T-3, T-1, T+1 |
| `billing.mark-past-due` | mỗi 15 phút | Hết kỳ mà chưa trả thì chuyển PAST_DUE |
| `billing.expire-after-grace` | mỗi 15 phút | Quá 3 ngày ân hạn thì chuyển EXPIRED, hạ về gói free |
| `billing.expire-open-invoices` | mỗi giờ | Invoice mua lần đầu hết hạn sau 24 giờ |
| `identity.purge-expired` | 03:00 hằng ngày | Xoá session, verification và OTP đã hết hạn |
| `files.cleanup-orphans` | 04:00 hằng ngày | Xoá file PENDING quá 24 giờ |
| `outbox.relay` | poll 1 giây | Đẩy event vào queue |
| `outbox.cleanup` | 05:00 hằng ngày | Xoá event đã gửi quá 7 ngày |

- **Không làm:** Kafka, RabbitMQ, event không qua outbox.
- **Xem lại khi:** cần replay lịch sử event, vượt khoảng 5.000 event/giây kéo dài, hoặc đã tách service. Khi đó relay chuyển sang đẩy vào Kafka.

---

## 7. Read / write

- CQRS nhẹ với `@nestjs/cqrs` 12:
  - `@CommandHandler` → aggregate → repository → outbox, tất cả trong một `UnitOfWork`.
  - `@QueryHandler` → query service (SQL/Kysely) trả thẳng DTO, không đi qua identity map, không có N+1.
- **Không dùng `EventBus`/Saga của `@nestjs/cqrs` cho domain event**, vì chúng chạy trong bộ nhớ. Domain event đi qua outbox.
- Read model: bảng tổng hợp cập nhật bằng event (ví dụ `usage_daily`). Materialized view refresh `CONCURRENTLY` theo cron, dùng cho báo cáo chấp nhận trễ.
- **Không làm:** event sourcing, tách DB đọc và DB ghi.

---

## 8. Caching

- Mặc định không cache. Chỉ bật ở chỗ đã đo là cần. Ứng viên đầu tiên: kết quả kiểm tra entitlement theo org.
- **Stack đã chọn:** `@nestjs/cache-manager` (module chính thức của Nest) + `cache-manager` 7 + `@keyv/redis` (client `redis`, chấp nhận thêm một client). **Chưa code trong sub-project 1**, làm ở sub-project đầu tiên có use case. Khả năng chống stampede của `wrap` phải kiểm chứng khi đó; không có bus xoá L1 giữa các pod nên L1 (nếu dùng) chỉ TTL ngắn.
- **Key:** helper bắt buộc có `env` và `orgId` (lấy từ `RequestContext`), dạng `{env}:{module}:v{n}:{orgId}:…`, các phần được escape. Invalidate bằng cách tăng version. TTL luôn có, cộng jitter ±10%.
- **Local cache:** TTL 30–60 giây, chỉ cho dữ liệu nóng và ít đổi. Cache quyền truy cập tối đa 60 giây. Đổi role hoặc thu hồi quyền thì **tăng version đồng bộ trong cùng transaction**, không đợi event. Ability nhạy cảm (thao tác billing của admin, đổi role, quản lý API key) không đọc qua cache.
- CDN chỉ dùng cho file và asset tĩnh. Response của API không đi qua CDN.
- **Không làm:** write-through.

---

## 9. Reliability

- Mỗi loại process tối thiểu 2 replica, đặt anti-affinity. Postgres managed có standby tự failover. Redis managed có replica.
- **Mỗi luồng quan trọng có trạng thái lưu trong DB, cộng cron đối soát** để tự hồi phục.
- **Redis sập:**
  - Bỏ qua cache.
  - Rate limit SP1 chuyển sang `insuranceLimiter` trong bộ nhớ từng pod; đăng nhập/2FA không phụ thuộc Redis, fail-closed khi storage Postgres lỗi (SP2 §11.2, D1/D2).
  - Route có `@Idempotent()` trả `503` (fail-closed), vì chạy mà không có idempotency thì có thể trừ tiền hai lần.
  - Enqueue chuyển sang ghi outbox.
- **Provider sập:** pause queue. SePay tự retry webhook 7 lần trong 5 giờ, quá mức đó thì admin gửi lại từ dashboard SePay.
- **Bulkhead:** queue và deployment worker riêng cho billing, pool DB riêng cho api và worker, concurrency riêng cho từng provider.
- **Health:** `/health/live` chỉ kiểm tra process. `/health/ready` kiểm tra DB và Redis, trả 503 khi đang tắt.
- **Tắt êm:** SIGTERM → ready trả 503 → chờ request đang chạy → `worker.close()` → đóng pool. Toàn bộ có timeout.
- **Backup:** PITR + snapshot hằng ngày, giữ 30 ngày. Mỗi quý chạy thử khôi phục vào staging theo runbook.
- **Mục tiêu:** RPO ≤ 5 phút, RTO ≤ 1 giờ.

---

## 10. Scalability & performance

- **Scale:**
  - HPA theo CPU cho api, theo độ sâu queue cho worker. Mỗi pod khoảng 1 CPU, không dùng `cluster`.
  - Job nặng CPU chạy bằng sandboxed processor. Lúc đó thêm `tini` static làm init.
- **Pool DB:** PgBouncer transaction mode, pool mỗi process khoảng 10. Tổng connection tính theo số replica tối đa của HPA.
- **Batching:** relay đọc 100 dòng một lần, `addBulk`, insert nhiều dòng bằng một câu lệnh.
- **N+1:** query service dùng join. Môi trường dev cảnh báo khi một request chạy quá 20 query. Test e2e kiểm tra số query ở các endpoint danh sách.
- **Backpressure:** giới hạn body và timeout, rate limit, rate limiter của BullMQ, endpoint nặng trả 503 khi queue trễ.
- **Profiling:** `pg_stat_statements`, trace OTel, `--cpu-prof`, k6.
- **Mục tiêu:** API đọc p95 < 200 ms, API ghi p95 < 500 ms, outbox tới job < 30 giây.

---

## 11. Security

- **Xác thực: Better Auth 1.7.6**, tự mount `AuthMountMiddleware` sau port `AuthProvider` (SP2 §11.2, spike S1; không thallesp vì handler không await rejection).
  - Tính năng dùng: email/password, Google, xác thực email, quên mật khẩu, session chỉ Postgres, bearer (mobile), 2FA, API key, organization ở SP3, JWT/JWKS (cho service khác), rate limit đăng nhập.
  - Better Auth chạy bằng adapter Kysely chính thức trên pool `pg` riêng. **Không** dùng adapter MikroORM (chỉ có bản cộng đồng, chưa ổn định).
  - Schema lấy bằng `auth generate` (package `auth` 1.7.6; drift dùng `auth check schema`, spike S3), rồi đưa vào migration chung dưới dạng SQL.
  - Event `identity.user.registered` được ghi outbox trong database hook, cộng một cron đối soát, vì Better Auth ghi bằng pool riêng nên không chung transaction.
- **`AUTH_MODE`** (dự án tự chọn):
  - `local` (mặc định): chỉ Better Auth.
  - `hybrid`: IdP ngoài (Keycloak, Zitadel, Azure AD…) là một cách đăng nhập, cắm qua `@better-auth/sso` hoặc `genericOAuth`. Vẫn chỉ có một bảng user; SP2 lưu liên kết theo `UNIQUE(provider_id, account_id)` trong auth.account. **Không** liên kết qua email, trừ provider trong `trustedProviders` gửi `email_verified=true` và user local đã xác thực. S2-R49: user có credential phải link-social tường minh, không liên kết ngầm. `@better-auth/sso` (kéo `samlify`/`xmldom`, lịch sử lỗ hổng dày) chỉ cài khi thật sự cần SAML.
  - `external`: tắt Better Auth, API verify token của IdP hoặc CRM qua JWKS (`jose`): `jwtVerify` với URL JWKS cố định, **pin** `issuer`, `audience`, `algorithms`, có `clockTolerance`, không theo `jku`/`x5u`.
  - **SP2 §11.2:** external chỉ nhận token user theo claim/value cấu hình; API key ở local/hybrid cho principal là user sở hữu, id key ở credential context. Service principal và API key theo org thuộc SP3.
- **Rate limit đăng nhập (sub-project 2):** Better Auth `storage: 'database'` + lockout mật khẩu `RateLimiterPostgres` atomic; 2FA dùng accountLockout DB-backed của plugin (S2-R6/S2-R44). Mount ghi IP đã xử lý `HTTP_TRUST_PROXY`; storage lỗi → 503 cho `/sign-in/*` và `/two-factor/*` (SP2 §11.2).
- **Thu hồi (sub-project 2):** session chỉ ở Postgres, `cookieCache` tắt, không secondary storage Redis. R21/D1: Redis outage không rút auth khỏi phục vụ; chỉ thêm cache khi có số đo (SP2 §11.2).
- **Luồng công khai không lộ email tồn tại:** đăng ký/đổi email trùng trả `202` chung và gửi thông báo tới hộp thư đang có; mã `email_taken` chỉ dùng trên màn hình đã xác thực của admin org.
- **Phân quyền:** role theo org lấy từ plugin organization của Better Auth. Điều kiện trên resource viết bằng **CASL** (`@casl/ability` 7), có unit test.
- **Session (SP2 §11.2):** cookie cố định `HttpOnly; Path=/`; Secure bắt buộc ngoài dev/test localhost; SameSite từ config (mặc định Lax); Domain chỉ khi xác nhận mọi subdomain tin cậy. Cookie external do gateway/IdP phát và xoá. CSRF cùng danh sách origin tin cậy cho mọi request thay đổi trạng thái xác thực bằng cookie, gồm route Nest, auth mount, Bull Board và external.
- **Secret:** inject lúc chạy từ secret manager, config validate bằng zod, gitleaks trong CI.
- **Mã hoá:**
  - TLS ở mọi nơi: Postgres (`DB_SSL_MODE` + CA, `rejectUnauthorized: true`), Redis production bắt buộc `rediss://` + user ACL theo vai trò. Compose dev chỉ bind `127.0.0.1`.
  - `FieldCipher`: AES-256-GCM với **khoá chủ lấy từ env/secret manager, có `kid` để xoay khoá** (không phải envelope có KMS; nếu dự án cần KMS thì thay adapter). IV 12 byte, `authTagLength: 16` bắt buộc ở cả mã hoá lẫn giải mã, AAD gắn với `table:column:orgId:pk` để bản mã không chuyển được sang dòng khác. SP2 chỉ keyring nhiều kid; job/runbook mã hoá lại hoãn SP7. Re-encrypt mọi dữ liệu trước khi retire kid. Riêng auth.account dùng AAD `auth.account:<cột>:-:<providerId>/<accountId>`, email_deliveries dùng public_id sinh ở app (SP2 §11.2).
  - **SP2 §11.2:** JWKS xoay qua `jwks.rotationInterval`/`gracePeriod`; API key có hạn mặc định, user tạo mới → cập nhật client → xoá cũ. Secret ký webhook thuộc SP6.
  - **Ngoại lệ SSRF có tên (ADR 0016, SP2 §11.2):** Better Auth Google/OIDC discovery/token/userinfo dùng fetch thư viện, URL chỉ config/provider và production HTTPS; external JWKS đi qua `HttpClient` bằng `toWebFetch`.
  - Log redact dữ liệu nhạy cảm (mục 12).
- **Validate** bằng zod ở mọi biên: request, response, payload job, webhook vào, config.
- **OWASP ASVS L2:**
  - helmet, CORS theo allowlist, giới hạn body.
  - **Chặn SSRF** cho mọi HTTP ra ngoài: `Agent` của `undici` với `connect.lookup` kiểm tra IP **sau khi resolve DNS** (chặn cả DNS rebinding), phân loại bằng `ipaddr.js`. Chặn loopback, RFC1918, CGNAT `100.64/10`, link-local, `0.0.0.0/8`, multicast, IPv6 ULA/link-local, IPv4-mapped IPv6, địa chỉ metadata cloud. `redirect: 'manual'`, allowlist port (443, và 80 nếu cho phép), giới hạn kích thước response. Kiểm tra lúc đăng ký endpoint **và** lúc gửi.
  - Kiểm tra file theo magic bytes.
  - Phản hồi không lộ email có tồn tại hay không.
- **Audit log:** đăng nhập, đổi role, API key, thao tác billing của admin, xuất dữ liệu. Chỉ thêm, không sửa, không xoá (grant INSERT/SELECT + trigger chặn).
- **Quyền tối thiểu:** 5 DB role (`app_owner`, `app_user`, `app_relay`, `app_admin`, `auth_user`), IAM S3 theo prefix, Redis ACL, container non-root với filesystem chỉ đọc.
- **Supply chain:**
  - Renovate, osv-scanner, Trivy, CodeQL, gitleaks trong CI; lockfile bắt buộc.
  - pnpm `minimumReleaseAge` 1 ngày, Renovate `minimumReleaseAge` 3 ngày: "latest" là bản mới nhất đã publish ít nhất 1 ngày.
  - Allowlist build script chỉ gồm `@swc/core`, `msgpackr-extract`, `protobufjs` (thêm khi thật sự cần); `@scarf/scarf` bị chặn.
  - pnpm `overrides` để cả cây chỉ có **một** major của ioredis.
  - Template email (`handlebars`) chỉ biên dịch từ file của repo, **không bao giờ** từ nội dung do tenant nhập.
  - Scalar: pin version script hoặc tự host bundle, không tải CDN không pin.
- **Dữ liệu cá nhân:** có luồng xuất và xoá dữ liệu. Phạm vi cụ thể cần pháp chế xác nhận.

---

## 12. Observability

- **Log:** pino JSON (`nestjs-pino`).
  - Context (`traceId`, `requestId`, `orgId`, `userId`, `jobId`) gắn vào **mọi** dòng log qua pino `mixin()` đọc CLS, không chỉ log của request HTTP.
  - Serializer lỗi bỏ `query`, `params`, `detail`, `where`, giữ SQLSTATE, constraint, table. Production cấm bật `DB_DEBUG`.
  - Redact: danh sách gốc cố định (authorization, cookie, set-cookie, x-api-key, proxy-authorization, x-sepay-signature, password, token, accessToken, refreshToken, idToken, otp, backupCodes, secret, clientSecret, privateKey, ở nhiều cấp lồng), env chỉ được **thêm** vào. `req.url` trong log bỏ query string.
  - `requestId` luôn do server sinh; id client gửi lên giữ ở field riêng `clientRequestId` (đã kiểm tra định dạng).
- **Trace:** OpenTelemetry SDK + auto-instrumentation (http, pg, ioredis) + `bullmq-otel`. `traceparent` đi qua outbox và job. Lấy mẫu 10%, trace có lỗi giữ 100% (tail sampling ở collector). `traceparent` do client public gửi lên được lấy mẫu độc lập ở biên (không để client ép `sampled=1`), hoặc bị ingress bỏ đi.
- **Metrics:**
  - HTTP: RED (số request, tỉ lệ lỗi, độ trễ).
  - Queue: độ sâu, tuổi job cũ nhất, số failed.
  - Độ trễ outbox, pool DB.
  - Nghiệp vụ: số giao dịch khớp, số NEEDS_REVIEW.
  - Không gắn `orgId` làm label.
- **Cảnh báo** theo tốc độ đốt SLO. Mỗi cảnh báo có runbook.
- **SLO:**
  - API không lỗi 5xx: 99,9%/tháng.
  - 99% job thông báo bắt đầu chạy trong 60 giây.
  - 99% thanh toán được khớp trong 2 phút sau webhook.
  - Cron billing không được bỏ lỡ lần nào.

---

## 13. Deployment, build & Docker

### 13.1 Deployment
- **Môi trường dev:** Docker Compose gồm Postgres, PgBouncer, Redis, MinIO, Mailpit, OTel collector (tuỳ chọn).
- **K8s:** Helm chart tối giản.
  - Deployment api + HPA. Worker chia deployment theo nhóm queue.
  - Migration là Job chạy như hook trước khi upgrade. Có PodDisruptionBudget.
- **CI (GitHub Actions):** lint, type-check, unit, integration, migration up/down, oasdiff, build, Trivy, gitleaks, osv-scanner, CodeQL, SBOM, ký image, push. Build release **không** dùng cache mà PR ghi được.
- **Deploy:** xác minh chữ ký image (cosign, identity của workflow repo) bằng policy admission khi cluster hỗ trợ (sub-project 7).
- **CD:** rolling update + readiness gate. Canary bằng Argo Rollouts là tuỳ chọn. Blue-green không làm mặc định.
- **Feature flag:**
  - Flag nghiệp vụ nằm ở Entitlements.
  - Kill switch vận hành lưu trong DB, đi qua `@openfeature/server-sdk` (bọc module riêng vì `@openfeature/nestjs-sdk` chưa hỗ trợ Nest 12).
- **Payload job có version**, để worker cũ và mới chạy song song trong lúc rollout không làm sai.

### 13.2 Build
- **Biên dịch:** `nest build -b swc` (`@swc/core` 1.16). `.swcrc` bật `legacyDecorator` + `decoratorMetadata`. Output ESM.
- **Type-check:** TypeScript 7.0 (native) `tsc --noEmit`. TypeScript 6.x cài qua alias npm cho các tool cần compiler API.
- **Dev:** `nest start -b swc --watch`. **Test:** Vitest 5 + `unplugin-swc` 2. **Lint:** oxlint. **Package manager:** pnpm 12.
- **CI:** job chạy song song, cache pnpm store, `.tsbuildinfo`, và layer Docker (`type=gha,mode=max`).
- **Mục tiêu:** build < 10 giây, type-check < 15 giây, build image khi chỉ sửa code < 2 phút.
- **Spike bắt buộc ở đầu sub-project 1:**
  - TS 6 và TS 7 chạy cạnh nhau.
  - SWC xuất ESM với `module: nodenext`.
  - Nest CLI 12 có đòi TypeScript API khi dùng builder SWC hay không.

### 13.3 Docker
- **Node 24 LTS.** Image chạy: `gcr.io/distroless/nodejs24-debian13:nonroot`. Có thể đổi sang `dhi.io/node:24` (Docker Hardened Images, miễn phí) qua `--build-arg RUNTIME_IMAGE`.
- **Stage:** deps (`pnpm fetch` + cache mount) → build (`install --offline`, build, `prune --prod`) → runtime (chỉ `dist/` + `node_modules` production, `USER 65532`).
- **Một image cho 3 vai trò:** `dist/main.api.js`, `dist/main.worker.js`, `dist/main.migrate.js`.
- **Không bundle.** Build cho `linux/amd64` và `linux/arm64`.
- **Bảo mật lúc build:**
  - Pin base image theo digest, Renovate tự cập nhật.
  - Secret truyền qua `--mount=type=secret` (kể cả `.npmrc` chứa token, không bao giờ `COPY`). `.dockerignore` chặt (`.env*`, `*.pem`, `*.key`, `.npmrc`).
  - `--frozen-lockfile`, allowlist build script, `minimumReleaseAge`.
  - `sharp` mang binary libvips giấy phép LGPL-3.0: đã báo để pháp chế xác nhận.
  - SBOM + provenance, ký bằng cosign keyless, Trivy chặn CVE HIGH/CRITICAL đã có bản vá.
- **Bảo mật lúc chạy:** `runAsNonRoot`, `readOnlyRootFilesystem`, `emptyDir` cho `/tmp`, `drop: [ALL]`, `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault`. Debug bằng `kubectl debug`.
- **Mục tiêu:** image ≤ 400 MB chưa nén, và càng nhẹ càng tốt. Mọi dependency mới phải cân nhắc kích thước, và mỗi SP ghi lại kích thước chưa nén và nén trong ADR 0013. Khởi động tới ready < 3 giây.
  - Mốc cũ ≤ 200 MB được Sếp đổi ngày 2026-09-28. Lý do: riêng base distroless Node đã khoảng 159 MB, và kiến trúc không bundle giữ `node_modules` trong image, nên mốc cũ không đạt được. Đo ở SP2: 352 MB chưa nén, 81 MB nén.

---

## 14. Testing

| Loại | Phạm vi | Công cụ |
|---|---|---|
| Unit | Domain, state machine (mọi cặp trạng thái cộng sự kiện), policy, value object | Vitest |
| Integration | Adapter, outbox/inbox, RLS isolation, migration up/down | Testcontainers (Postgres, Redis) |
| Contract | Port (mọi adapter), OpenAPI (oasdiff), schema webhook ra ngoài | Vitest dùng chung suite |
| E2E | Đăng ký → tạo org → mua gói → webhook SePay → entitlement được bật | supertest |
| Architecture | Hướng phụ thuộc, ranh giới module, chỗ nào được import ORM | dependency-cruiser |
| Load | API ở 600 RPS, thông lượng queue, độ trễ outbox | k6 |
| Chaos (nhẹ) | Kill worker giữa job, restart Redis, cắt mạng tới DB | Toxiproxy, chạy hằng đêm |

---

## 15. Maintainability

- **Hướng phụ thuộc** được dependency-cruiser kiểm tra.
- **Đặt tên:** file kebab-case, event `context.aggregate.verb`, bảng snake_case số nhiều, mã lỗi `snake_case` thường, duy nhất toàn hệ thống (khai báo bằng key `UPPER_SNAKE` trong `defineErrorCodes`).
- **CODEOWNERS:** `core/` và `modules/` thuộc team nền, `features/` thuộc team dự án.
- **ADR** trong `docs/adr/` theo mẫu MADR:
  - 0001 Modular monolith, 0002 Clone + upstream, 0003 MikroORM 7.2, 0004 Ports & adapters.
  - 0005 RLS fail-closed, 0006 BullMQ + outbox + inbox, 0007 REST/problem+json.
  - 0008 SePay xử lý tay, 0009 Chiến lược ID, 0010 Better Auth + chế độ xác thực; CASL bổ sung SP3.
  - 0011 `@nestjs/cqrs` không dùng EventBus, 0012 Hai chế độ phân trang, 0013 Build SWC + TS7 + distroless, 0014 Observability, 0015 Cache hoãn khỏi SP1, 0016 HTTP ra ngoài và chặn SSRF.

### 15.1 Cấu trúc thư mục
```
src/
├─ main.api.ts · main.worker.ts · main.migrate.ts
├─ app-api.module.ts · app-worker.module.ts        (boilerplate)
├─ app.modules.ts                                   (dự án: bật module + đăng ký features)
├─ migrations/  core/ · identity/ · tenancy/ · billing/ · … · app/   (nằm trong src để build ra dist)
├─ core/      config · database (UnitOfWork, withOrg, RLS session) · queue · scheduler
│             outbox · events · http · observability · security · health  (cache: sub-project sau)
├─ modules/   identity · tenancy · entitlements · billing · notifications
│             files · audit · integrations · admin
│   └─ <module>/  index.ts · <module>.module.ts · http/ · application/ · domain/
│                 ports/ · infra/mikro-orm/ · providers/ · jobs/
└─ features/  example/   (feature mẫu: CRUD theo org, 1 job, 1 cron, 1 quota)
test/  contracts/ · tenancy/ · …
docs/adr/ · CHANGELOG.md · docker-compose.yml · Dockerfile · deploy/helm/
```

---

## 16. Chi phí và gánh nặng vận hành

- Chỉ có 3 thành phần có trạng thái: Postgres, Redis, S3-compatible. Không có Kafka hay Elasticsearch.
- **Vendor:** đi qua giao thức chuẩn (S3 API, SMTP, OTLP, Postgres chuẩn).
- **Chi phí DB:** scale dọc trước, partition và retention để kiểm soát dung lượng.
- **Chi phí queue:** giới hạn số job được giữ lại, payload nhỏ.
- **Egress:** upload và download đi thẳng S3/CDN, không qua pod api.
- **Chi phí observability:** trace lấy mẫu 10%, log giữ 14 ngày, chặn label có quá nhiều giá trị.
- **Trực sự cố:** cron đối soát tự sửa phần lớn lỗi tạm thời. Chỉ gọi người khi SLO bị đốt nhanh hoặc tiền cần người xử lý.

---

## 17. Công nghệ & package (npm, 2026-09-24)

| Nhóm | Package |
|---|---|
| Nền | `@nestjs/core` 12.1 (Express, giữ khả năng đổi sang Fastify), `@nestjs/config` 12, `zod` 4.6, `nestjs-cls` 7, `@nestjs/cqrs` 12, `@nestjs/swagger` 12, `@scalar/nestjs-api-reference`, `nestjs-i18n` 10 |
| Dữ liệu | `@mikro-orm/core`, `postgresql`, `nestjs`, `migrations` 7.2 · `kysely` · `pg` 8.23 · PgBouncer · `uuid` 14 · `date-fns` 4 + `@date-fns/tz` |
| Auth | SP2 §11.2: `better-auth`, `auth`, `@better-auth/api-key`, `@better-auth/kysely-adapter`, `@better-auth/core` 1.7.6 cùng nhịp; `@better-auth/utils` 0.4.2, `better-call` 1.4.0. Tự mount; `express` 5.2.1 và `raw-body` 4.0.0 trực tiếp. `@better-auth/sso` chỉ khi SAML; CASL thuộc SP3; `jose` 6.2.12 · `helmet` 8 |
| HTTP | `@nestjs/throttler` 6.7 + `rate-limiter-flexible` 11 · `@node-idempotency/core` 1.1 + `@node-idempotency/storage` (storage trên ioredis) · `undici` 8 + `ipaddr.js` 2 (HTTP ra ngoài, chặn SSRF) |
| Cache (chưa code ở SP1) | `@nestjs/cache-manager` 12 · `cache-manager` 7 · `@keyv/redis` 5 |
| Job | `bullmq` 6.3 · `ioredis` 6 · `cockatiel` 4 · `@bull-board/api` + `@bull-board/express` 9.10.1 (SP2 §11.2: trong worker, sau RBAC admin, read-only, port nội bộ) |
| Tích hợp | `@aws-sdk/client-s3`, `s3-request-presigner`, `lib-storage` · `file-type` 22 · `sharp` 0.35 · `@tus/server` 2.4 (tuỳ chọn, kéo thêm client Redis nên chỉ cài khi bật) · `nodemailer` 10 · `mjml` 5 · `handlebars` · `standardwebhooks` · `@openfeature/server-sdk` |
| Vận hành | `nestjs-pino` 5.2 · `pino` 10 · `@opentelemetry/sdk-node` · `auto-instrumentations-node` · `bullmq-otel` · `@nestjs/terminus` 12.1 |
| Build | `@swc/core` 1.16 · `@nestjs/cli` 12 · `typescript` 7.0 (type-check) + 6.x (alias) · `pnpm` 12 · distroless `nodejs24-debian13` |
| Chất lượng | `vitest` 5 · `unplugin-swc` 2 · `supertest` · `@testcontainers/*` 12 · `dependency-cruiser` 18 · `oxlint` · `prettier` · k6 · Trivy · osv-scanner · gitleaks · Renovate · cosign |

**Quy tắc chọn:** tính năng có sẵn của framework/thư viện đang dùng → package npm được bảo trì tốt → chỉ tự viết khi không có lựa chọn đạt, kèm ADR liệt kê ứng viên đã loại. Có sẵn đang dùng: cursor của MikroORM, ETag/304 của Express, pipe Standard Schema của Nest 12, exception của MikroORM, `node:crypto`.

**Tự viết**, vì không có thư viện đạt: outbox/inbox/UnitOfWork, module bọc OpenFeature, adapter SePay. Ngoài ra là các lớp nối mỏng vào **extension point chính thức** của thư viện: filter lỗi, middleware Content-Type, so sánh `If-Match`, `ThrottlerStorage` trên `rate-limiter-flexible`, interceptor + `Storage` ioredis cho `@node-idempotency/core`, `Agent` undici chặn SSRF.

**Rủi ro dependency:**
- RLS của MikroORM mới ra 3 tuần: pin chính xác version, CI chạy test isolation.
- SP2 tự mount Better Auth sau port; không dùng package tích hợp Nest (spike S1, ADR 0010).
- `@node-idempotency/*` ít người dùng (khoảng 23 nghìn lượt/tháng, 1 người maintain): chỉ `core/http` được import, chỉ dùng core + interface storage (không dùng wrapper Nest đã cũ), test e2e bám từng yêu cầu của IETF draft chạy trong CI.
- Adapter Kysely của Better Auth nhận `kysely ^0.28.17 || ^0.29.0`, khớp với bản MikroORM dùng.
- `@mikro-orm/nestjs` có version riêng (7.1.x), không đòi cùng version với core.
- Các major vừa ra (`unplugin-swc` 2.0, `nestjs-cls` 7.0) pin chính xác.

---

## Phụ lục A — Billing SePay

### A.1 Quy tắc nghiệp vụ
- **Subscription:** `TRIALING → ACTIVE → PAST_DUE → EXPIRED`, `ACTIVE → CANCELED → EXPIRED` (hết kỳ).
  - Trả tiền khi đang PAST_DUE thì chuyển về ACTIVE, kỳ mới tính từ ngày hết kỳ cũ.
  - Đã EXPIRED thì phải tạo invoice mới, kỳ mới tính từ lúc trả.
  - Trial hết hạn mà chưa trả thì chuyển EXPIRED.
- **Invoice:** `OPEN → PAID | EXPIRED | VOID`.
  - Invoice gia hạn tạo trước 7 ngày. Ân hạn 3 ngày (trong thời gian này org vẫn dùng được gói). Invoice mua lần đầu sống 24 giờ.
  - Mã thanh toán đã hết hạn không bao giờ được dùng lại. Mọi mốc thời gian đều nằm trong config.
- **Giao dịch lệch** (không khớp mã, thiếu tiền, thừa tiền) → `NEEDS_REVIEW` và báo admin. Invoice giữ OPEN tới khi hết hạn. Admin có 3 thao tác, thao tác nào cũng ghi audit: gán vào invoice, đã hoàn tiền tay, bỏ qua kèm lý do.
- **PaymentTransaction là state machine:** `RECEIVED → MATCHED | NEEDS_REVIEW → ASSIGNED | REFUNDED | IGNORED`. Gán tay: `UNIQUE(payment_transaction_id)` trên bản ghi gán, `FOR UPDATE` cả giao dịch lẫn invoice, kiểm tra `amount ≥ invoice.amount` (thiếu tiền thì không gán), yêu cầu xác thực lại (step-up), audit ghi trong **cùng transaction**.
- **Mỗi org chỉ một invoice mua lần đầu đang OPEN:** partial unique `(org_id) WHERE kind = 'INITIAL' AND status = 'OPEN'`. Thanh toán thứ hai tới muộn đi vào NEEDS_REVIEW, không làm job lỗi lặp.
- **Mã thanh toán** sinh từ CSPRNG, có check digit (Damm hoặc Luhn mod N), duy nhất vĩnh viễn (không xoá cứng).

### A.2 Hợp đồng webhook (đối chiếu tài liệu chính thức ngày 2026-09-24)
- **Xác thực HMAC-SHA256:**
  - Header `X-SePay-Signature: sha256={hex}` và `X-SePay-Timestamp` (giây). Chuỗi được ký là `{timestamp}.{raw_body}`.
  - Verify trên raw body, dùng `timingSafeEqual` trên Buffer và kiểm tra độ dài trước. Code mẫu của SePay truyền string vào hàm này, cách đó sẽ ném lỗi.
  - Timestamp lệch quá 5 phút thì từ chối.
- **Phản hồi thành công** phải đủ cả 3 điều kiện: HTTP 200/201, body `{"success": true}`, trả về trong 30 giây. Trả 200 kể cả khi giao dịch trùng. Chữ ký sai thì trả 401.
- **Retry:** tối đa 7 lần, khoảng cách theo dãy Fibonacci, trong vòng 5 giờ. Connect timeout 5 giây.
- **IP nguồn:** 7 IPv4 công bố, đưa vào config allowlist làm lớp phòng thủ thứ hai.
- **Payload:** `id` (int, UNIQUE), `gateway`, `transactionDate` (`YYYY-MM-DD HH:mm:ss` giờ Việt Nam, không offset, đổi sang UTC), `accountNumber`, `subAccount?`, `code?`, `content`, `transferType` (`in`/`out`, bỏ qua `out`), `transferAmount`, `accumulated`, `referenceCode`.
- **Khi `code` null:** dò mã trong `content` bằng regex **neo đầu cuối, tuyến tính**, trên `content` đã cắt độ dài. Đúng **một** mã khớp thì dùng, không khớp hoặc nhiều hơn một thì NEEDS_REVIEW.
- **Thứ tự xử lý:** verify chữ ký (kiểm tra `sha256=` + `^[0-9a-f]{64}$` trước khi đổi sang Buffer, `Math.abs(now - ts)`) → **rồi mới** lưu payload → kiểm tra `accountNumber` thuộc tài khoản nhận tiền trong config → parse `transferAmount` với kiểm tra safe integer trước khi đổi sang bigint. Webhook không qua throttler và middleware Content-Type chung.
- **Cần xác nhận với SePay:** các lần retry có ký lại với timestamp mới không. Nếu không, cửa sổ 5 phút phải nới ra (dựa vào `UNIQUE(provider, id)` để chống replay).

### A.3 Phạm vi
- **Làm đầy đủ:** nhận webhook, khớp invoice (`FOR UPDATE`), NEEDS_REVIEW, thao tác xử lý tay, tạo QR, test bằng payload mẫu và chức năng "Gửi thử" trên dashboard SePay.
- **TODO trong code** (theo yêu cầu, chưa đủ tài liệu để làm chắc):
  - Đối soát qua API v2: chưa rõ `id` số trong webhook map với `since_id` UUID của API v2 thế nào. Có interface `PaymentReconciler`, bản SePay ném `NotImplementedError`, cron tắt mặc định.
  - Tài khoản ảo (VA, `subAccount`).
  - Cổng checkout/IPN của SePay.

---

## Phụ lục B — Lưu trữ file

- **5 cách đưa file vào:**
  - presigned POST (có `content-length-range`): mặc định, ≤ 100 MB, URL hạn 10 phút.
  - presigned multipart: ≤ 5 GB.
  - stream qua API: ≤ 20 MB, dùng `lib-storage`, dùng được với driver local.
  - tus resumable: tuỳ chọn, tắt mặc định.
  - file do worker tạo ra.
- **Pipeline** `PENDING → PROCESSING → READY | REJECTED`:
  - kiểm tra magic bytes (`file-type`)
  - ClamAV (tuỳ chọn, gọi `clamd` qua socket)
  - `sharp` để bỏ EXIF và tạo thumbnail
  - cộng quota dung lượng một cách atomic
  - file PENDING quá 24 giờ thì cron dọn.
- **Truy cập:** private (mặc định) qua presigned GET 5 phút sau khi CASL kiểm tra quyền, đặt `ResponseContentType` theo MIME đã dò và `ResponseContentDisposition: attachment`, phục vụ từ domain riêng không có cookie. Public qua CDN dưới prefix public.
- **Giới hạn kích thước:** upload trực tiếp dùng **presigned POST** với điều kiện `content-length-range` (presigned PUT không chặn được kích thước); multipart kiểm tra `HeadObject` rồi xoá ngay nếu vượt.
- **Ảnh:** `sharp` đặt `limitInputPixels`, từ chối SVG.
- **Key:** `{orgId}/{module}/{uuidv7}`. Tên gốc lưu trong DB.
- **Driver:** S3-compatible (S3, R2, MinIO) và local disk (local chỉ hỗ trợ upload qua API).
- **Xoá:** soft delete, cron xoá object thật sau thời gian giữ lại.

---

## Phụ lục C — Lộ trình sub-project

Mỗi bước có spec → plan → code riêng. Bước sau phụ thuộc bước trước.

1. **Core + hạ tầng job** (kèm spike build ở mục 13.2): config, database + UnitOfWork + map lỗi DB, outbox/inbox, queue, scheduler, events, http (lỗi, 2 chế độ phân trang, idempotency, rate limit, HTTP client chặn SSRF), observability, health, 3 entrypoint, compose, Dockerfile, CI kèm test kiến trúc. **Không** gồm cache và Bull Board.
2. **Identity + Notifications (email)**: Better Auth, `AUTH_MODE`, email transport, role `auth_user`, rate limit Better Auth `storage: 'database'` + lockout `RateLimiterPostgres` atomic, Bull Board sau RBAC admin (SP2 §11.2).
3. **Tenancy & Access + RLS**: organization, member, invitation, CASL, policy, test isolation.
4. **Entitlements**: gói, flag theo gói, quota atomic, guard.
5. **Billing SePay**: phạm vi như phụ lục A.3.
6. **Files, Audit, Integrations, Admin**: làm song song được.
7. **Feature mẫu, Helm chart, runbook, quy trình upstream.**
