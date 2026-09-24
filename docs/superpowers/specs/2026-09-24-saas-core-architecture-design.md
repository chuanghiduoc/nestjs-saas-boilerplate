# Lõi SaaS NestJS — Thiết kế kiến trúc tổng thể

- **Ngày:** 2026-09-24
- **Trạng thái:** Đã duyệt thiết kế (bản preview 8). Spec này là nguồn sự thật. Mỗi sub-project sẽ có spec chi tiết riêng.
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
- ID: PK `BIGINT` identity nội bộ, `public_id` UUIDv7 khi ra ngoài. ID của org là UUIDv7 (do Better Auth sinh qua `generateId`).
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
- `features/`, `app.modules.ts`, `db/migrations/app/`: thuộc dự án.
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
| Pagination | **Hai chế độ.** Offset `?page=&pageSize=` trả `total`, dùng cho UI dạng bảng; giới hạn `page × pageSize ≤ 10.000`, `total` đếm chính xác tới 10.000, vượt thì trả `"10000+"`. Cursor `?limit=&cursor=` trả `nextCursor`, `hasMore`, dùng cho feed, log, export, đồng bộ. Cả hai dùng sẵn của MikroORM (`findAndCount`, `findByCursor`) |
| Lọc / sắp xếp | Chỉ trường có trong allowlist, trường nào cũng phải có index |
| Lỗi | RFC 9457 `problem+json`: `type`, `title`, `status`, `detail`, `code` (`MODULE_UPPER_SNAKE`), `errors[]`, `traceId`. Không bao giờ trả stack trace |
| Idempotency | Header `Idempotency-Key` bắt buộc với POST tạo tiền hoặc side effect. Lưu 24 giờ kèm hash request. Cùng key khác body thì trả 422 |
| ID | Ra ngoài dùng UUIDv7 `public_id`, PK nội bộ là `BIGINT` |
| Định dạng | JSON camelCase. Thời gian ISO 8601 UTC. Tiền là số nguyên VND, gửi dạng chuỗi |
| Xác thực | Better Auth: session cookie (web), bearer (mobile), API key (máy). Xem mục 11 |
| Phân quyền | Guard theo thứ tự `Auth → Org → Ability (CASL) → Entitlement` |
| Rate limit | Better Auth tự lo cho endpoint đăng nhập. `@nestjs/throttler` + storage Redis tự viết cho các endpoint còn lại, theo org và theo gói. Trả `429` + `Retry-After` |
| Webhook vào | `/webhooks/*`: verify chữ ký, lưu raw payload, trả ngay. Không đi qua guard của user |

**Giữ khả năng đổi Express sang Fastify:**
- Chỉ `core/http` được import `express`/`fastify`.
- Không dùng middleware riêng của Express trong module.
- Raw body lấy bằng `rawBody: true`.
- CI hằng đêm chạy e2e trên cả hai nền tảng.

**Không làm:** GraphQL, gRPC ra ngoài, version theo header.

---

## 4. Data architecture

- **PostgreSQL** là nguồn sự thật duy nhất cho dữ liệu nghiệp vụ. Redis chỉ giữ dữ liệu mất đi vẫn dựng lại được (cache, rate limit, queue có outbox làm nguồn).
- **Schema:**
  - Tên snake_case, số nhiều.
  - PK `BIGINT GENERATED ALWAYS AS IDENTITY`. Thời gian `TIMESTAMPTZ` UTC. Tiền `BIGINT` VND. Enum là `TEXT` + `CHECK`.
  - Mọi bảng có `created_at`/`updated_at`. Soft delete chỉ khi có yêu cầu thật.
- **FK:** mặc định `RESTRICT`. `CASCADE` chỉ khi bảng con hoàn toàn thuộc về bảng cha. Không bao giờ cascade trên bảng tiền, audit hay lịch sử.
- **Transaction:** `READ COMMITTED` + lock tường minh (`FOR UPDATE`, `UPDATE … WHERE` có điều kiện, UNIQUE, version column). `SERIALIZABLE` chỉ dùng ở chỗ cần và có retry khi gặp `40001`.
- **Index:** mọi FK đều có index. Index của bảng tenant bắt đầu bằng `org_id`. Bật `pg_stat_statements`. Query nóng phải kèm `EXPLAIN (ANALYZE, BUFFERS)` chạy trên dữ liệu seed đủ lớn.
- **Migration:**
  - Viết bằng SQL (`addSql`) và luôn có down.
  - Đi theo expand → backfill → contract. Dùng `CREATE INDEX CONCURRENTLY` trong migration không chạy transaction. `lock_timeout = 5s`.
  - CI chạy up → down → up.
  - Migration chạy thành Job trước khi rollout. Mỗi module một thư mục, riêng dự án dùng `db/migrations/app/`.
- **Bảng lớn** (`audit_logs`, `webhook_deliveries`, `notifications`): partition theo tháng, hết hạn thì drop partition.
- **Replication:** primary + standby để failover. Read replica chỉ dùng cho báo cáo. Đọc ngay sau khi ghi thì đọc từ primary.
- **Sharding:** không làm. Đường đã sẵn: mọi bảng tenant có `org_id` và FK kép.
- **Eventual consistency** chỉ ở các chỗ đã biết trước: audit, thông báo, webhook ra ngoài, read model, entitlements sau khi thanh toán.
- **Nhiều DB:** mỗi DB là một connection có tên (`contextName` của `@mikro-orm/nestjs`). Một aggregate chỉ nằm ở một DB. Đồng bộ sang DB khác đi qua outbox. Không có transaction xuyên hai DB.

### 4.1 Cô lập tenant (RLS, fail-closed)
| Lớp | Cơ chế | Chặn lỗi nào |
|---|---|---|
| Một nguồn định nghĩa | Filter MikroORM với `rls: true` sinh ra cả filter ở app lẫn policy ở DB | Filter và policy lệch nhau |
| 3 DB role | `app_owner` chạy migration. `app_user` dùng cho api/worker, không phải owner, không BYPASSRLS. `app_admin` có BYPASSRLS, chỉ cho admin và cron quét nhiều org. Bảng bật `rowLevelSecurity: 'force'` | App chạy bằng owner nên đi vòng qua RLS |
| Fail-closed | `current_setting('app.org_id')` không có `missing_ok`. Session context set sau `BEGIN`, chạy được với PgBouncer transaction mode | Quên set org thì query báo lỗi, không lộ dữ liệu |
| FK kép | Bảng cha có `UNIQUE(org_id, id)`, bảng con dùng `FOREIGN KEY (org_id, parent_id)` | Dữ liệu org A trỏ sang dữ liệu org B |
| `withOrg()` | Guard đọc `X-Org-Id` và kiểm tra membership. Job mang `orgId` và chạy qua cùng helper | Request và job mỗi nơi set context một kiểu |
| CI | Kiểm tra `pg_class`/`pg_policies`: bảng nào có `org_id` cũng phải bật RLS + FORCE và có policy, bảng global phải nằm trong allowlist. Test isolation chạy bằng `app_user` | Thêm bảng mới mà quên bật RLS, hoặc bug của RLS trong MikroORM |

Bảng của Better Auth (user, session, organization, member…) nằm trong allowlist, được bảo vệ bằng kiểm tra membership của chính Better Auth.

### 4.2 Ports & adapters để thay ORM hoặc DB
- dependency-cruiser cấm import `@mikro-orm/*` ngoài `infra/` và `core/database/`.
- Port viết theo use case và ghi rõ bảo đảm của nó (khoá dòng, atomic). Transaction và outbox đi qua port `UnitOfWork`. Job handler không import BullMQ.
- Mỗi port có một bộ **contract test** chạy được với mọi adapter.
- **Bắt buộc** với module nền. **Tuỳ chọn** với `features/` (CRUD đơn giản được dùng MikroORM thẳng trong service).
- Cái giá phải trả: mỗi aggregate thêm một mapper và một interface. Rời Postgres thì adapter phải tự làm lại các bảo đảm của RLS, partial index, `SKIP LOCKED`.

---

## 5. Distributed systems

- **Timeout, lớp ngoài dài hơn lớp trong:** load balancer 30s > request HTTP 20s > `statement_timeout` 5s (api) / 60s (worker) > HTTP ra ngoài (connect 2s, tổng 10s). Redis command 1s.
- **Retry:** exponential backoff + full jitter, chỉ retry thao tác idempotent. Trong request HTTP thì không retry thao tác ghi.
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
- **Chống trùng:** bảng inbox `processed_events(consumer, event_id)` UNIQUE, ghi cùng transaction với side effect.
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
- Cache-aside bằng `bentocache`: hai tầng (bộ nhớ + Redis), chống stampede, grace period, và đồng bộ xoá L1 giữa các pod qua bus.
- **Key:** `{env}:{module}:v{n}:{orgId}:…`. Invalidate bằng cách tăng version. TTL luôn có, cộng jitter ±10%.
- **Local cache:** TTL 30–60 giây, chỉ cho dữ liệu nóng và ít đổi. Cache quyền truy cập tối đa 60 giây, và đổi role thì phát event xoá cache.
- CDN chỉ dùng cho file và asset tĩnh. Response của API không đi qua CDN.
- **Không làm:** write-through.

---

## 9. Reliability

- Mỗi loại process tối thiểu 2 replica, đặt anti-affinity. Postgres managed có standby tự failover. Redis managed có replica.
- **Mỗi luồng quan trọng có trạng thái lưu trong DB, cộng cron đối soát** để tự hồi phục.
- **Redis sập:**
  - Bỏ qua cache.
  - Rate limit cho qua (riêng đăng nhập thì chặn).
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

- **Xác thực: Better Auth 1.7** qua `@thallesp/nestjs-better-auth`, bọc sau port `AuthProvider`.
  - Tính năng dùng: email/password, Google, xác thực email, quên mật khẩu, session trong DB kèm cache Redis, bearer (mobile), 2FA, API key, organization, JWT/JWKS (cho service khác), rate limit đăng nhập.
  - Better Auth chạy bằng adapter Kysely chính thức trên pool `pg` riêng. **Không** dùng adapter MikroORM (chỉ có bản cộng đồng, chưa ổn định).
  - Schema lấy bằng `@better-auth/cli generate`, rồi đưa vào migration chung dưới dạng SQL.
  - Event `identity.user.registered` được ghi outbox trong database hook, cộng một cron đối soát, vì Better Auth ghi bằng pool riêng nên không chung transaction.
- **`AUTH_MODE`** (dự án tự chọn):
  - `local` (mặc định): chỉ Better Auth.
  - `hybrid`: IdP ngoài (Keycloak, Zitadel, Azure AD…) là một cách đăng nhập, cắm qua `@better-auth/sso` hoặc `genericOAuth`. Vẫn chỉ có một bảng user, liên kết tài khoản theo `(provider, subject)` UNIQUE.
  - `external`: tắt Better Auth, API verify token của IdP hoặc CRM qua JWKS (`jose`).
  - Ngoài ra, chuỗi `AuthProvider` có thể đồng thời nhận token máy (ví dụ CRM gọi vào). `Principal` luôn ghi rõ nguồn: user, api_key hay service.
- **Phân quyền:** role theo org lấy từ plugin organization của Better Auth. Điều kiện trên resource viết bằng **CASL** (`@casl/ability` 7), có unit test.
- **Session:** cookie `HttpOnly; Secure; SameSite=Lax` + `trustedOrigins`.
- **Secret:** inject lúc chạy từ secret manager, config validate bằng zod, gitleaks trong CI.
- **Mã hoá:** TLS ở mọi nơi. AES-256-GCM kiểu envelope cho TOTP secret, OAuth token, secret ký webhook. Log redact dữ liệu nhạy cảm.
- **Validate** bằng zod ở mọi biên: request, response, payload job, webhook vào, config.
- **OWASP ASVS L2:**
  - helmet, CORS theo allowlist, giới hạn body.
  - **Chặn SSRF** cho webhook ra ngoài (`request-filtering-agent`).
  - Kiểm tra file theo magic bytes.
  - Phản hồi không lộ email có tồn tại hay không.
- **Audit log:** đăng nhập, đổi role, API key, thao tác billing của admin, xuất dữ liệu. Chỉ thêm, không sửa, không xoá.
- **Quyền tối thiểu:** 3 DB role, IAM S3 theo prefix, Redis ACL, container non-root với filesystem chỉ đọc.
- **Supply chain:** Renovate, osv-scanner, Trivy, CodeQL/Semgrep, lockfile bắt buộc, allowlist cho install script.
- **Dữ liệu cá nhân:** có luồng xuất và xoá dữ liệu. Phạm vi cụ thể cần pháp chế xác nhận.

---

## 12. Observability

- **Log:** pino JSON (`nestjs-pino`) gắn `traceId`, `requestId`, `orgId`, `userId`, `jobId`, có redact.
- **Trace:** OpenTelemetry SDK + auto-instrumentation (http, pg, ioredis) + `bullmq-otel`. `traceparent` đi qua outbox và job. Lấy mẫu 10%, trace có lỗi giữ 100%.
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
- **CI (GitHub Actions):** lint, type-check, unit, integration, migration up/down, oasdiff, build, Trivy, SBOM, ký image, push.
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
  - Secret truyền qua `--mount=type=secret`. `.dockerignore` chặt.
  - `--frozen-lockfile`, `onlyBuiltDependencies`.
  - SBOM + provenance, ký bằng cosign keyless, Trivy chặn CVE HIGH/CRITICAL đã có bản vá.
- **Bảo mật lúc chạy:** `runAsNonRoot`, `readOnlyRootFilesystem`, `emptyDir` cho `/tmp`, `drop: [ALL]`, `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault`. Debug bằng `kubectl debug`.
- **Mục tiêu:** image ≤ 200 MB chưa nén, khởi động tới ready < 3 giây.

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
- **Đặt tên:** file kebab-case, event `context.aggregate.verb`, bảng snake_case số nhiều, mã lỗi `MODULE_UPPER_SNAKE`.
- **CODEOWNERS:** `core/` và `modules/` thuộc team nền, `features/` thuộc team dự án.
- **ADR** trong `docs/adr/` theo mẫu MADR:
  - 0001 Modular monolith, 0002 Clone + upstream, 0003 MikroORM 7.2, 0004 Ports & adapters.
  - 0005 RLS fail-closed, 0006 BullMQ + outbox + inbox, 0007 REST/problem+json.
  - 0008 SePay xử lý tay, 0009 Chiến lược ID, 0010 Better Auth + CASL.
  - 0011 `@nestjs/cqrs` không dùng EventBus, 0012 Hai chế độ phân trang, 0013 Build SWC + TS7 + distroless.

### 15.1 Cấu trúc thư mục
```
src/
├─ main.api.ts · main.worker.ts · main.migrate.ts
├─ app-api.module.ts · app-worker.module.ts        (boilerplate)
├─ app.modules.ts                                   (dự án: bật module + đăng ký features)
├─ core/      config · database (UnitOfWork, withOrg, RLS session) · queue · scheduler
│             outbox · events · cache · http · observability · security · health
├─ modules/   identity · tenancy · entitlements · billing · notifications
│             files · audit · integrations · admin
│   └─ <module>/  index.ts · <module>.module.ts · http/ · application/ · domain/
│                 ports/ · infra/mikro-orm/ · providers/ · jobs/
└─ features/  example/   (feature mẫu: CRUD theo org, 1 job, 1 cron, 1 quota)
db/migrations/  core/ · identity/ · tenancy/ · billing/ · … · app/
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
| Auth | `better-auth` 1.7 · `@thallesp/nestjs-better-auth` 2.8 · `@better-auth/sso` 1.7 · `@casl/ability` 7 · `jose` 6 · `@nestjs/throttler` 6.7 · `helmet` 8 |
| Job | `bullmq` 6.3 · `@nestjs/bullmq` 12 · `ioredis` · `@bull-board/nestjs` 9.10 · `cockatiel` 4 |
| Tích hợp | `@aws-sdk/client-s3`, `s3-request-presigner`, `lib-storage` · `file-type` 22 · `sharp` 0.35 · `@tus/server` 2.4 (tuỳ chọn) · `nodemailer` 10 · `mjml` 5 · `handlebars` · `standardwebhooks` · `request-filtering-agent` · `@openfeature/server-sdk` · `bentocache` 1.6 |
| Vận hành | `nestjs-pino` 5.2 · `pino` 10 · `@opentelemetry/sdk-node` · `auto-instrumentations-node` · `bullmq-otel` · `@nestjs/terminus` 12.1 |
| Build | `@swc/core` 1.16 · `@nestjs/cli` 12 · `typescript` 7.0 (type-check) + 6.x (alias) · `pnpm` 12 · distroless `nodejs24-debian13` |
| Chất lượng | `vitest` 5 · `unplugin-swc` 2 · `supertest` · `@testcontainers/*` 12 · `dependency-cruiser` 18 · `oxlint` · `prettier` · k6 · Trivy · osv-scanner · gitleaks · Renovate · cosign |

**Tự viết**, vì không có thư viện đủ tin cậy: outbox/inbox/UnitOfWork, interceptor idempotency, storage Redis cho throttler, module bọc OpenFeature, adapter SePay.

**Rủi ro dependency:**
- RLS của MikroORM mới ra 3 tuần: pin chính xác version, CI chạy test isolation.
- Package tích hợp Nest của Better Auth là của cộng đồng: bọc sau port.
- Adapter Kysely của Better Auth yêu cầu `kysely ^0.28`: kiểm tra xung đột với MikroORM.
- `request-filtering-agent` cần thử với HTTP client sẽ dùng.

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

### A.2 Hợp đồng webhook (đối chiếu tài liệu chính thức ngày 2026-09-24)
- **Xác thực HMAC-SHA256:**
  - Header `X-SePay-Signature: sha256={hex}` và `X-SePay-Timestamp` (giây). Chuỗi được ký là `{timestamp}.{raw_body}`.
  - Verify trên raw body, dùng `timingSafeEqual` trên Buffer và kiểm tra độ dài trước. Code mẫu của SePay truyền string vào hàm này, cách đó sẽ ném lỗi.
  - Timestamp lệch quá 5 phút thì từ chối.
- **Phản hồi thành công** phải đủ cả 3 điều kiện: HTTP 200/201, body `{"success": true}`, trả về trong 30 giây. Trả 200 kể cả khi giao dịch trùng. Chữ ký sai thì trả 401.
- **Retry:** tối đa 7 lần, khoảng cách theo dãy Fibonacci, trong vòng 5 giờ. Connect timeout 5 giây.
- **IP nguồn:** 7 IPv4 công bố, đưa vào config allowlist làm lớp phòng thủ thứ hai.
- **Payload:** `id` (int, UNIQUE), `gateway`, `transactionDate` (`YYYY-MM-DD HH:mm:ss` giờ Việt Nam, không offset, đổi sang UTC), `accountNumber`, `subAccount?`, `code?`, `content`, `transferType` (`in`/`out`, bỏ qua `out`), `transferAmount`, `accumulated`, `referenceCode`.
- **Khi `code` null:** tự dò mã trong `content`, không thấy thì chuyển NEEDS_REVIEW.

### A.3 Phạm vi
- **Làm đầy đủ:** nhận webhook, khớp invoice (`FOR UPDATE`), NEEDS_REVIEW, thao tác xử lý tay, tạo QR, test bằng payload mẫu và chức năng "Gửi thử" trên dashboard SePay.
- **TODO trong code** (theo yêu cầu, chưa đủ tài liệu để làm chắc):
  - Đối soát qua API v2: chưa rõ `id` số trong webhook map với `since_id` UUID của API v2 thế nào. Có interface `PaymentReconciler`, bản SePay ném `NotImplementedError`, cron tắt mặc định.
  - Tài khoản ảo (VA, `subAccount`).
  - Cổng checkout/IPN của SePay.

---

## Phụ lục B — Lưu trữ file

- **5 cách đưa file vào:**
  - presigned PUT: mặc định, ≤ 100 MB, URL hạn 10 phút.
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
- **Truy cập:** private (mặc định) qua presigned GET 5 phút sau khi CASL kiểm tra quyền. Public qua CDN dưới prefix public.
- **Key:** `{orgId}/{module}/{uuidv7}`. Tên gốc lưu trong DB.
- **Driver:** S3-compatible (S3, R2, MinIO) và local disk (local chỉ hỗ trợ upload qua API).
- **Xoá:** soft delete, cron xoá object thật sau thời gian giữ lại.

---

## Phụ lục C — Lộ trình sub-project

Mỗi bước có spec → plan → code riêng. Bước sau phụ thuộc bước trước.

1. **Core + hạ tầng job** (kèm spike build ở mục 13.2): config, database + UnitOfWork, outbox/inbox, queue, scheduler, events, cache, http (lỗi, 2 chế độ phân trang, idempotency, rate limit), observability, health, 3 entrypoint, compose, Dockerfile, CI kèm test kiến trúc.
2. **Identity + Notifications (email)**: Better Auth, `AUTH_MODE`, email transport.
3. **Tenancy & Access + RLS**: organization, member, invitation, CASL, policy, test isolation.
4. **Entitlements**: gói, flag theo gói, quota atomic, guard.
5. **Billing SePay**: phạm vi như phụ lục A.3.
6. **Files, Audit, Integrations, Admin**: làm song song được.
7. **Feature mẫu, Helm chart, runbook, quy trình upstream.**
