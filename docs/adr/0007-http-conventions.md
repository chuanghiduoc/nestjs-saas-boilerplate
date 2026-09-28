# 0007 — Quy ước HTTP, idempotency và giới hạn tốc độ

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Module cần một hợp đồng REST nhất quán, tránh tự dựng response/lỗi, và giữ an toàn khi request trùng hoặc Redis gián đoạn.

## Quyết định

REST + JSON dưới `/v1`, quy ước do `core/http` sở hữu. Health giữ đường dẫn riêng `/health/live`, `/health/ready`.

| Nội dung | Thành phần và hành vi |
| --- | --- |
| Input | StandardSchemaValidationPipe của Nest 12 + zod trên Body/Query/Param; sai → 422 validation_failed, path dạng chấm |
| Lỗi | RFC 9457 problem+json qua ProblemDetailsFilter và HttpAdapterHost; lỗi lạ → 500 internal_error, không lộ stack/SQL |
| Resource đơn | serialize(schema, value), bỏ field nội bộ; schema output sai là lỗi server |
| Danh sách | Paginator.offset/cursor, object phẳng theo ADR 0012 |
| Tạo resource | 201 và Location qua setLocation |
| Concurrency | etagOf(version), assertIfMatch; không khớp → 412, thiếu header bắt buộc → 428 |
| Body | ContentTypeMiddleware kiểm tra POST/PUT/PATCH; 415 nếu không hỗ trợ; HTTP_BODY_LIMIT → 413 |
| OpenAPI | 3.1 từ zod, ApiProblems, pnpm openapi:export; output xác định |
| Docs | Scalar khi bật HTTP_DOCS_ENABLED; **cấm trong production** (R14) |
| Header bảo mật | Helmet; CSP riêng có nonce cho docs |
| Proxy | HTTP_TRUST_PROXY được parse/validate; không tin X-Forwarded-For tuỳ tiện |

`405 method_not_allowed` được dành sẵn nhưng route Nest/Express sai method hiện trả 404; không đọc bảng router chỉ để phân biệt hai trường hợp. GET để Express xử lý If-None-Match thành 304. ETag lấy version nên so sánh If-Match bỏ prefix weak, chấp nhận `W/"7"` và `"7"`; `*` khớp resource tồn tại, tag không có ngoặc kép không khớp.

### Merge Patch (R30, R35; thay R16)

R16 (từ chối field object lồng nhau lúc dựng schema) đã bị đảo bởi R30: spec SP1 yêu cầu "áp dụng đệ quy cho object lồng". R35 chốt quy tắc `null` theo đúng chữ của spec và tách API. Ba helper trong `src/core/http/merge-patch.ts`:

- `mergePatchSchema(schema)` dựng schema body cho `application/merge-patch+json`, đệ quy:
  - Mọi member optional ở mọi cấp; key lạ bị từ chối ở mọi cấp (strict). Lỗi key lạ lồng nhau có `path` là object chứa nó (vd. `addr`, code `unrecognized_keys`).
  - `null` **chỉ** hợp lệ ở member nullable trong schema gốc (`.nullable()`, `.nullish()`, `z.union([X, z.null()])`). Member optional nhưng không nullable và member bắt buộc từ chối `null` với 422 tại path lồng (vd. `addr.note`). Field cần xoá được thì phải khai báo nullable.
  - `z.union([X, z.null()])` được xử lý y hệt `X.nullable()`, cả ở schema lẫn ở `mergePatchInto`.
  - `z.object` lồng → object merge patch lồng. `z.record(z.string(), …)` → patch từng entry; `null` xoá entry (entry là khoá của map, không phải field của schema). Mảng và scalar → thay nguyên giá trị, validate đầy đủ.
  - Bỏ qua lớp `optional`, `nullable`, `readonly`.
- `applyMergePatch(target, patch)`: thuật toán RFC 7396 §2 thuần qua package `tiny-merge-patch`. Không biết schema, không mutate `target`/`patch`, `null` luôn xoá member. Member tên `__proto__` bị từ chối (422): gán nó sẽ đổi prototype của kết quả thay vì tạo member, dữ liệu mất trong im lặng. `constructor.prototype` chỉ là dữ liệu thường (có test hồi quy: prototype toàn cục, target và patch không đổi).
- `mergePatchInto(schema, current, patch)`: bước theo schema cho route PATCH. Tách riêng vì theo RFC 7396 `null` **xoá** member (§1: merge patch không biểu diễn được null tường minh), còn ở domain `{"nickname": null}` nghĩa là **đặt về null**.
  1. `applyMergePatch(current, patch)`; member lồng mà patch không nhắc tới được giữ nguyên.
  2. Member nullable và bắt buộc mà patch gửi `null` → ghi lại `null`. Duyệt theo patch, nên key patch không nhắc tới không bao giờ được thêm (vắng = không đổi); optional được tính cả qua nhánh union (`z.union([z.string().optional(), z.number(), z.null()])`). Member nullish bị xoá → vắng trong kết quả; handler phải ghi nó là "xoá", không spread kết quả đè lên bản ghi cũ.
  3. Validate lại bằng `schema`. Sai (vd. patch tạo object lồng mới nhưng thiếu member bắt buộc) → 422 `validation_failed` với path dạng chấm. Member ngoài `schema` bị bỏ khỏi kết quả.

Bị từ chối lúc dựng schema, fail loud thay vì đoán:

| Trường hợp | Lý do |
| --- | --- |
| `.default()`/`.prefault()`/`.catch()` ở bất kỳ đâu trong field. Bộ quét duyệt mọi schema con trong `def` của zod (wrapper, union, intersection, pipe/codec, lazy, object shape và `catchall`, record key/value, mảng, tuple items/rest, map, set, promise, function input/output, template literal), không liệt kê từng container | zod điền giá trị cho member client không gửi, hoặc thay giá trị sai bằng giá trị khác trong im lặng (vd. `z.union([z.number().catch(0), z.string()])` biến `{"bad":true}` thành `0`) |
| Member nhận object qua union, discriminated union, intersection, pipe/transform hoặc lazy | Không xác định được hình dạng để merge vào |
| `z.record` có key không phải `z.string()` (enum, literal…) | Tập key hữu hạn làm mọi entry thành bắt buộc; mô hình hoá bằng `z.object` |

Record là JSON object nên RFC 7396 merge nó theo từng entry như mọi object. Không thay nguyên khối, vì thế sẽ phải tự viết thuật toán lệch RFC. Giá trị không có hình dạng cố định (`z.unknown()`/`z.any()`) là leaf: patch validate bằng schema gốc, rồi merge theo RFC. Schema truyền vào `mergePatchInto` phải có input ≡ output (không transform), vì kết quả được parse lại bằng chính schema đó.

### Proxy, docs và cách ly platform

HTTP_TRUST_PROXY nhận boolean, hop count hoặc danh sách IP/CIDR/tên nhóm hợp lệ. Production từ chối trust-all và các mạng quá rộng: IPv4 prefix < /8, IPv6 < /32, mạng bao phủ toàn bộ IPv4-mapped hoặc mapped IPv4 rộng hơn /8. Nhiều dải nhỏ ghép phủ Internet chưa được phát hiện. CORS chỉ nhận bare origin.

Docs route dùng nonce ngẫu nhiên 128 bit cho từng request, cùng nonce trên CSP và mọi script Scalar; CDN URL pin version, không unsafe-inline. API giữ CSP nghiêm ngặt. Kiểm chứng trong `test/e2e/core/api-docs.e2e.spec.ts` (mọi `<script>` mang nonce của header, nonce khác nhau mỗi request). Chưa kiểm UI bằng trình duyệt thật; script CDN chưa có SRI, chỉ dựa vào URL đã pin version.

Swagger chuyển zod sang draft-2020-12 cho OpenAPI 3.1, không dùng nullable kiểu 3.0. Export chạy Nest preview nên không cần DB/Redis. Platform Express chỉ lộ trong core/http; worker không tải HTTP runtime. Webhook tương lai phải bỏ middleware Content-Type chung và rate limit theo hợp đồng webhook.

### Rate limit

`@nestjs/throttler` dùng storage `rate-limiter-flexible` trên ioredis chung; insuranceLimiter trong RAM khi Redis lỗi. Tracker là principal type/id/org nếu đã có, không thì IP đã qua trust proxy; IPv6 được chuẩn hoá /64. Principal phải có **trước guard**; SP2 phải giữ thứ tự này.

Giới hạn theo route và tracker. Window config bắt buộc bội số 1.000 ms vì rate-limiter-flexible đếm giây nguyên. Guard đặt Retry-After và X-RateLimit-*; vượt giới hạn trả 429 rate_limited. Redis sập thì giới hạn theo từng pod, không còn tổng toàn cụm. Lỗi cả hai limiter phải nổi lên, không nuốt. Log một lần khi suy giảm và một lần phục hồi. Module dùng `SkipRateLimit` từ core/http cho health/webhook.

### Idempotency-Key và lock (R17)

Dùng `@node-idempotency/core` qua interceptor và StorageAdapter ioredis chung. Route opt-in `@Idempotent()`; principal lấy từ RequestContext, không fallback từ header.

| Trường hợp | Kết quả |
| --- | --- |
| Chưa có principal | 401, không chạy handler |
| Key thiếu/sai độ dài hoặc khác tập [A-Za-z0-9_-:.] | 400 idempotency_key_required |
| Cùng key và request đã hoàn tất | Trả lại response, không chạy handler |
| Khác body, params hoặc query | 422 idempotency_key_reused |
| Request đầu đang chạy | 409 idempotency_conflict ngay |
| Handler/pipe ném lỗi | Lưu và trả lại lỗi; sửa request phải dùng key mới |
| Handler gặp `503 commit_outcome_unknown` hoặc lỗi hạ tầng DB (`isDbInfraError` → 503) | **Không lưu**: khoá được trả, thử lại cùng key chạy lại handler (final review M3, xem "Deadline pool") |
| Redis lỗi khi giữ key | 503 service_unavailable, không chạy handler |

Scope là hash principal type/id/org/key; thư viện thêm method và route template vào Redis key. Fingerprint gồm body, params, query. JSON.stringify nhạy thứ tự key; đảo thứ tự có thể thành 422 dù dữ liệu tương đương.

Lock tạo atomic bằng SET NX PX; sống `min(IDEMPOTENCY_LOCK_TTL_SEC, ttl)`, mặc định **120 s**. Record hoàn tất dùng TTL response riêng; config bắt lock TTL < response TTL. Crash hoặc lưu response thất bại để lock tự hết hạn; log lỗi lưu nhưng response handler vẫn được trả. Handler dài hơn lock TTL có nguy cơ chạy trùng, nên việc dài chuyển sang job.

Response thành công lưu body và header trong allowlist (mặc định location, etag, retry-after), cấm set-cookie. **Không lưu status động**: Nest áp status của route/HttpCode; route idempotent không đổi status theo từng lần chạy. Lỗi lưu code/detail được phép/fields/header an toàn rồi filter dựng problem+json mới với requestId và timestamp mới. Replay lỗi 5xx hiện vẫn bị log lại.

### Redis không phát lại lệnh đã thất bại (R23)

Client không blocking (REDIS dùng chung và BullMQ Queue producer) cố định `enableOfflineQueue: false`, `autoResendUnfulfilledCommands: false`. ioredis có thể reject promise vì commandTimeout nhưng vẫn phát lệnh SET NX sau reconnect nếu giữ offline queue: request đã nhận 503 lại tạo lock mồ côi, retry sau phục hồi thành 409. Tắt hàng đợi tránh trường hợp đó.

BullMQ Worker blocking giữ cấu hình riêng mặc định. Shared client chờ ready tối đa REDIS_COMMAND_TIMEOUT_MS lúc boot, rồi cảnh báo và khởi động suy giảm nếu Redis chưa lên. Shutdown quit khi ready; nếu không ready hoặc quit lỗi thì disconnect để dọn reconnect timer/socket.

SET đã gửi đúng lúc mất kết nối vẫn có thể được Redis áp dụng mà app không nhận phản hồi; trường hợp này chờ lock TTL. Không tuyên bố exactly-once qua mọi sự cố mạng.

### Readiness (R21)

API chỉ kiểm DB; Redis sập vẫn phục vụ route không cần idempotency và dùng rate limit dự phòng. Nếu gắn Redis vào readiness toàn fleet, sự cố một dependency sẽ rút mọi API pod khỏi load balancer. Worker kiểm cả DB + Redis. Draining trả ready 503, live vẫn 200; trình tự tắt và draining ở [ADR 0014](0014-observability.md).

### API đã kiểm chứng (đọc `.d.ts`/source trong node_modules, 2026-09-25)

Package: `tiny-merge-patch@1.0.0` (`apply(origin, patch)`: patch không phải object thì thay nguyên; target không phải object thì coi là `{}`; `null` xoá key; còn lại đệ quy; trả object mới), `helmet@8.3.0`, `@nestjs/swagger@12.0.2`, `@scalar/nestjs-api-reference@1.2.21` (`1.2.22` còn trẻ hơn `minimumReleaseAge`), `@nestjs/throttler@6.7.0` (`6.7.1` còn trẻ hơn `minimumReleaseAge`), `rate-limiter-flexible@11.2.1`, `@node-idempotency/core@1.1.0`, `@node-idempotency/storage@1.0.5`, cùng `@nestjs/common@12.1`, `zod@4.6.5`.

- `StandardSchemaValidationPipe` export từ `@nestjs/common`, option `exceptionFactory(issues)`; issue là issue đã finalize của zod nên có `code`, `format`, `path`.
- `@Body/@Query/@Param({ schema })` lưu schema ở `metadata.schema`; `@nestjs/swagger@12` đọc nó và mặc định chuyển với `target: 'openapi-3.0'`. App truyền `standardSchemaConverter` dùng `z.toJSONSchema(schema, { target: 'draft-2020-12', io })` vì tài liệu là OpenAPI 3.1 (`nullable: true` không hợp lệ ở 3.1).
- `useBodyParser('json', { type, limit })` đăng ký `express.json(...)`; Nest bỏ parser mặc định khi đã có middleware tên `jsonParser`.
- Express 5.2 `res.send` chỉ sinh ETag khi chưa có và trả `304` khi `req.fresh`.
- `NestFactory.create(…, { preview: true })` không khởi tạo provider, nên config factory không chạy; `pnpm openapi:export` chạy được với env rỗng.
- `ThrottlerStorage.increment(key, ttl, limit, blockDuration, throttlerName)` nhận **ms**; thời gian trong record tính bằng **giây**. `blockDuration` mặc định bằng `ttl`; guard tự đặt `Retry-After` và `X-RateLimit-*`.
- `RateLimiterRedis` có `insuranceLimiter`: lỗi store chuyển sang `insuranceLimiter.consume` thay vì reject bằng `Error`.
- `@node-idempotency/core`: `onRequest` trả response đã lưu hoặc `undefined`; key thiếu cũng bị báo bằng mã `IDEMPOTENCY_KEY_LEN_EXEEDED`, nên interceptor tự validate key. `StorageAdapter` của `@node-idempotency/storage` có `setIfNotExists/set/get` (không có `delete`), `ttl` tính bằng **ms**.
- Middleware wildcard: `forRoutes('{*path}')` (wildcard có tên của path-to-regexp 8).

## Cập nhật SP2 (2026-09-27)

Nest khởi tạo `bodyParser: false`; core sở hữu `jsonBodyParser` dùng raw-body 4.0.0 (S2-R1), giới hạn theo byte stream và đặt `req.rawBody`. Module khai báo `HTTP_BODY_PARSER_SKIP_PREFIX`; identity bỏ qua `AUTH_BASE_PATH` ở core rồi tự đọc bằng cùng parser sau kiểm đa credential/CSRF. External không bỏ qua prefix auth. Đây thay thế cơ chế `useBodyParser` mô tả trong bằng chứng SP1.

S2-R12/S2-R13/S2-R16/S2-R50: 413 trả sớm, không chờ hết body; dùng chung `lingerIfBodyUnread` cho mọi response khi body chưa đọc (cả 400/403/415, GET/HEAD). Drain có hạn thời gian `HTTP_BODY_LIMIT_LINGER_MS` và byte `HTTP_BODY_LIMIT_LINGER_BYTES`; khi chạm cap dừng đọc, flush response rồi FIN, destroy tại hạn. Drain hoàn tất thì giữ keep-alive nếu được phép; client-close/server-draining thì đóng. Content-Length biết trước chắc vượt cap thì quyết định đóng trước khi gửi header; chunked vượt cap sau header còn rủi ro FIN/reuse dẫn đến RST. Không hứa đóng socket ngay lập tức cho mọi 413.

`@PublicRoute()` là opt-out của `AuthGuard` mặc định chặn, không bỏ qua credential sai (401). Principal phải có trước guard. Mọi request thay đổi trạng thái dùng cookie phải kiểm CSRF, gồm auth mount/dashboard/external. Map lỗi Better Auth sang problem+json qua `writeProblem`; giữ 3xx và Set-Cookie. S2-R36: mapping theo route đã bỏ base path/query; sai currentPassword → 422 validation_failed, admin không tìm thấy user → 404. S2-R50: sign-out thu hồi từng cookie/bearer, API key → 400 api_key_not_accepted; không credential → 200 idempotent.

Opaque-path masking: request logger bỏ query, đổi segment `[A-Za-z0-9_-]` dài từ 20 ký tự (trừ UUID) thành `[redacted]`, để token reset trong path không lọt log. Pino redaction chỉ khớp lowercase và Title-Case đã khai báo (S2-R17); casing lạ do code tự dựng vẫn là residual, không log nguyên object thư viện. Error serializer bỏ payload SQL/SMTP và secret headers.

S2-R51/S2-R53 N4: pre-auth API-key limiter theo IP chạy trước auth, refund khi AUTHENTICATED; throttler SP1 trả **503 service_unavailable + Retry-After khi storage không phục vụ được**, không 500. Redis down vẫn có insuranceLimiter RAM: có thể trả 429 bình thường khi chạm giới hạn từng pod; 503 chỉ khi đường storage/fallback thật sự thất bại. Junk flood có thể làm key hợp lệ cùng NAT bị 429 tới hết window.

### Deadline pool (S2-R67/S2-R70/S2-R72)

Core truyền `connectionTimeoutMillis` và `query_timeout` qua `driverOptions`; hook MikroORM `onPoolCreated` gắn `watchPoolCheckouts` trước `destroyUnusableClients`, trước checkout đầu. Hook có trong runtime MikroORM 7.2.1 dù không khai riêng trong kiểu thư viện; kiểm lại khi nâng version. Guard pg-cursor hiện tại đã có test hồi quy cho tương tác query_timeout.

| Env | Mặc định (ms) | Quy tắc |
| --- | --- | --- |
| `DB_CONNECTION_TIMEOUT_MS` / `DB_QUERY_TIMEOUT_MS` | 3000 / 6000 | API production: connect + 2 × query < `HTTP_REQUEST_BUDGET_MS` |
| `HTTP_REQUEST_BUDGET_MS` | 30000 | Khớp proxy/LB; không huỷ mọi handler. Core API thu hồi checkout giữ quá ngân sách |
| `DB_WORKER_CONNECTION_TIMEOUT_MS` / `DB_WORKER_QUERY_TIMEOUT_MS` | 65000 / 65000 | Worker app/relay: connect ≥ query; query > `DB_WORKER_STATEMENT_TIMEOUT_MS` (60000), mọi môi trường |
| `DB_WORKER_CHECKOUT_MAX_MS` | 300000 | Worker app/relay: > 2 × worker query timeout, mọi môi trường; transaction job phải xong sớm hơn |

`watchPoolCheckouts` trả slot khi connection đang mượn chết (end/error), mọi vai trò; release muộn thành no-op. Kysely 0.29.6 không luôn trả slot khi BEGIN/COMMIT/ROLLBACK lỗi; review xác nhận còn ở 0.30 beta. Phòng vệ nằm trong app, **không patch dependency và chưa gửi issue upstream**. API reaper dự phòng blackhole không phát end/error; worker/relay có reaper riêng vì job registry không khai timeout để suy ra job dài nhất. Không thêm keepAlive vì không giải quyết dữ liệu đang bay chưa ACK.

Release huỷ client còn query treo hoặc transaction chưa idle; pg-pool tự huỷ khi release kèm lỗi. Giữ client lành vừa nhận lỗi SQL, không còn query active/queued và transaction idle dù ReadyForQuery chưa tới, tránh churn qua PgBouncer. Đọc trường private pg 8.23.0 có test pin hành vi; cần kiểm lại khi nâng pg. Shutdown thu hồi checkout bỏ rơi trước phần dự trữ đóng pool.

`isDbInfraError` map lỗi DB connection/reset/overload, SQLSTATE 08*, 53*, 57P01–57P03, 57014 và timeout client thành `503 service_unavailable`; không gom lỗi socket thư viện khác vào DB. `UnitOfWork` và `RelayDb.transaction` trả `503 commit_outcome_unknown`, log ERROR khi COMMIT lỗi mà lỗi đó không chứng minh được rollback: transaction có thể đã ghi. UnitOfWork không retry lỗi này.

Final review I1: lúc COMMIT chỉ giữ nguyên lỗi (retry/mapper như cũ) khi server trả SQLSTATE lớp **40** (40001/40P01 vẫn retry được), **23** (deferred constraint) hoặc **25** (25P03/25P04: backend còn idle trong transaction, COMMIT chưa được xử lý), hoặc khi pg chưa gửi COMMIT (`… is not queryable`, client.js:747-758: kết quả biết chắc, `503 service_unavailable`). Cơ sở: Postgres chạy mọi code người dùng lúc commit (deferred trigger, kiểm serializable) trước `RecordTransactionCommit` (xact.c `CommitTransaction`), lỗi ở đó abort transaction. Mọi lỗi khác là `commit_outcome_unknown`, gồm `08P01 server conn crashed?` mà PgBouncer tự dựng khi connection server chết lúc COMMIT đang bay (proto.c `send_pooler_error`, mặc định 08P01) và 57P01 (có thể tới sau khi commit đã ghi cục bộ, syncrep.c: "The transaction has already committed locally"). Test: `test/unit/core/database/commit-failure.spec.ts`, và proxy TCP giả đúng gói lỗi của PgBouncer trong `core-pool-deadline.spec.ts` (commit thật sự bền, `txid_status` = committed).

**Client thử lại sau `503 commit_outcome_unknown` (final review M3).** Interceptor idempotency không lưu lỗi này (và lỗi hạ tầng DB tạm thời) làm response cuối của key; nó xoá khoá "đang chạy" (Lua, chỉ xoá bản ghi `IN_PROGRESS`). Hợp đồng:

- Client: thử lại với **cùng** `Idempotency-Key` và cùng body, có backoff. Không đổi key: key mới là một request mới và có thể ghi lần hai. `409 idempotency_conflict` nghĩa lần trước còn chạy, thử lại sau.
- Route `@Idempotent()` có ghi DB: ghi phải idempotent **trong DB** theo key đó, trong cùng transaction (UNIQUE mang key; `INSERT … ON CONFLICT DO NOTHING` rồi đọc dòng đã có và trả nó). Chỉ vậy mới không bao giờ ghi hai lần: interceptor dùng Redis, không biết COMMIT trước đã bền hay chưa. Commit trước đã bền → lần chạy lại trả đúng kết quả đó (rồi được lưu và replay như thường); chưa bền → ghi như lần đầu. Transaction cũ còn treo phía server thì UNIQUE của Postgres bắt lần chạy lại chờ nó kết thúc (hoặc hết deadline → 503 tạm thời, cũng không được lưu).
- Route không có ghi idempotent trong DB: thử lại cùng key có thể ghi lần hai; không có cách an toàn ở tầng HTTP. Không có Idempotency-Key thì client phải tự đối soát trạng thái trước khi thử lại.
- Ngoài phạm vi: 503 do handler tự ném (`AppError`, vd. kèm Retry-After) vẫn được lưu và replay như mọi lỗi (hợp đồng SP1); 40001/40P01 hết lượt retry (503) cũng vậy.

Guard `statement_timeout` đọc setting ở mỗi readiness probe (final review M1: mỗi câu probe chạy trên client `pg` riêng cùng cấu hình kết nối với pool, `connectionTimeoutMillis` và `query_timeout` đều bằng `HEALTH_CHECK_TIMEOUT_MS`, không bao giờ mượn slot của pool app/relay — `withTimeout` của terminus không huỷ được query, và pg-pool tính cả connection đang mở vào `max`; đổi lại mỗi probe mở một connection mới): API app_user < `DB_QUERY_TIMEOUT_MS`; worker app_user/app_relay < `DB_WORKER_QUERY_TIMEOUT_MS`; tất cả phải > 0. Auth có guard theo `DB_AUTH_QUERY_TIMEOUT_MS` (ADR 0010). Production vi phạm làm readiness down; ngoài production log lỗi một lần. Đây là kiểm liên tục, không chỉ lúc boot: drift role/PgBouncer có thể rút toàn fleet khỏi load balancer (N5). Kiểm connection runtime, sửa setting và recycle connection cũ có kiểm soát; huỷ socket không chắc dừng backend.

### Log của listener cấp pool ngoài request context (S2-R73)

Một pool `pg` được TẠO trong context của một request (`RequestContext#run` → `cls.run`), nên mọi callback sau đó của cùng một connection vật lý (`connect`, `error`, `release`…) kế thừa continuation của request đó — Node `AsyncLocalStorage` bám theo chuỗi async nơi tạo resource, không theo request nào đang thực sự gây ra sự kiện. Log trực tiếp bằng `logger.warn(...)` trong các listener cấp pool vì vậy gắn nhầm requestId/url của request đã tạo/mượn connection trước đó, không phải request đang dùng nó lúc sự kiện xảy ra (task 43 F1: lỗi 42501 của request B bị log kèm requestId/url của request A, cũ hơn 3.27 s).

`logPoolEvent` (`core/logging/pool-log.ts`) chạy `logger.warn(...)` bên trong `ClsServiceManager.getClsService().exit()`: dòng log không còn mixin trường request nào (`contextLogFields` đọc `cls.isActive()` → false trong `exit`), chỉ mang trường pool-scoped (tên pool, lý do, class lỗi, SQLSTATE). `ClsServiceManager.getClsService()` là cùng instance mà `nestjs-cls` đưa vào mixin của pino và vào mọi `ClsService` inject qua DI, nên gọi trực tiếp ở factory tạo pool (chạy ngoài request scope) vẫn chắc chắn là cùng `AsyncLocalStorage`. Mọi listener cấp pool ở `core/database/pool-checkouts.ts` đi qua helper này, kể cả `db_pool_idle_error` (final review M2: lỗi của client rảnh trên pool core, kèm tên pool, SQLSTATE/mã socket và lớp lỗi; listener của MikroORM chỉ log khi `DB_DEBUG` bật, mà production cấm `DB_DEBUG`); auth pool (ADR 0010, `auth-pool.ts`) dùng lại cùng helper thay vì tự viết.

## Cập nhật SP3 (3A)

Rate limit ngoài `@Throttle` đi qua `RateLimitBuckets` (`core/http`, spec SP3 §5.2): module đăng ký bucket `<owner>.<name>` một lần lúc khởi tạo provider và giữ handle (`peek`/`consume`, `refund` chỉ khi `refundable: true`); tên trùng, tên sai định dạng, `limit` không nguyên dương hoặc cửa sổ không tròn giây ném lúc boot. Cùng `RateLimiterThrottlerStorage` của SP1 (khoá băm, insurance theo pod, 503 khi cả hai lỗi). `peek` chỉ đọc (`get` của rate-limiter-flexible) và chỉ chặn khi số điểm đã tiêu **vượt** `limit`; `peek` do insurance phục vụ không log cảnh báo đợt sự cố, `consume` kế tiếp mới log.

`PreAuthRateLimiter` (S2-R51/R53) chạy trên bucket `core.pre-auth`, cùng giới hạn và ngữ nghĩa hoàn điểm. Tên throttler trong storage đổi `pre-auth` → `core.pre-auth` nên khoá Redis đổi: bộ đếm pre-auth về 0 **một lần** lúc deploy. Trong rolling deploy, pod cũ và pod mới đếm trên hai khoá khác nhau, nên một IP có thể được tới khoảng **2 × `THROTTLE_PRE_AUTH_LIMIT`** lần thử trong mỗi cửa sổ khi rollout còn chạy; hết rollout thì về đúng giới hạn. Chấp nhận: có trần, chỉ trong cửa sổ rollout, và throttler theo route sau xác thực vẫn áp.

## Phương án đã loại

Merge Patch (R30): `json-merge-patch@1.0.2` (publish cuối 2021-07, CommonJS, không kèm type, mutate target, gặp key `__proto__` thì `return` giữa chừng nên chỉ áp một phần patch), `merge-patch@0.0.2` và `ts-merge-patch@0.1.0` (bỏ hoang, 5 lượt tải/tuần). Tự viết cũng bị loại vì đã có package đạt. Nest và zod không có merge patch. Chọn `tiny-merge-patch@1.0.0`: ESM, có type, thuần (không mutate), fork của `json-merge-patch`, publish 2026-03-29, khoảng 52k lượt tải/tuần, 0 issue mở; qua đủ 15 test vector Appendix A.

Review đã chốt bỏ `@nest-lab/throttler-storage-redis` và wrapper fail-open tự viết; dùng extension point ThrottlerStorage. Spike loại `@nestjs-redisx/idempotency` (key không bắt buộc, request trùng chờ, không lưu lỗi), AWS Powertools (chạy lại sau lỗi) và tự viết toàn bộ idempotency.

## Hệ quả

Redis suy giảm không làm mất an toàn route idempotent nhưng giảm năng lực phục vụ. Body replay có thể chứa PII nên TTL theo nhóm route, route tiền ngắn hơn. Header, scope và trạng thái route phải tuân thủ hợp đồng trên. OpenAPI phải tái sinh sau thay đổi API (`pnpm build && pnpm openapi:export`, output xác định, `openapi.json` được commit và Prettier bỏ qua); health ready 200 hiện chưa có schema đầy đủ trong tài liệu sinh ra. Script init inline của Scalar là `JSON.stringify` tài liệu OpenAPI của chính app, nên description không được chứa input không tin cậy.

## Nguồn

Spec SP1 phần HTTP; review trước thực thi §0, §2 và quyết định đã chốt; báo cáo Task 12–13, 18, `task-19-offlinequeue-report.md`; R14, R16 (đã bị R30 đảo), R17, R21, R23, R30, R35. Xem [ADR phân trang](0012-two-pagination-modes.md).
