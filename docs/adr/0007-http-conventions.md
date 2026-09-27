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

### Merge Patch (R30, thay R16)

R16 (từ chối field object lồng nhau lúc dựng schema) đã bị đảo bởi R30: spec SP1 yêu cầu "áp dụng đệ quy cho object lồng". Hai helper trong `src/core/http/merge-patch.ts`:

- `mergePatchSchema(schema)` dựng schema body cho `application/merge-patch+json`, đệ quy:
  - Mọi member optional ở mọi cấp; key lạ bị từ chối ở mọi cấp (strict). Lỗi key lạ lồng nhau có `path` là object chứa nó (vd. `addr`, code `unrecognized_keys`).
  - `null` chỉ hợp lệ ở member nullable hoặc optional trong schema gốc. Member bắt buộc và không nullable (kể cả object lồng) từ chối `null` với 422.
  - `z.object` lồng → object merge patch lồng. `z.record(z.string(), …)` → patch từng entry, `null` xoá entry. Mảng và scalar → thay nguyên giá trị, validate đầy đủ.
  - Bỏ qua lớp `optional`, `nullable`, `readonly`.
- `applyMergePatch(schema, current, patch)` áp patch vào resource hiện tại và trả resource mới:
  - Chạy thuật toán RFC 7396 §2 bằng package `tiny-merge-patch` (không mutate `current`), nên member lồng mà patch không nhắc tới được giữ nguyên.
  - RFC 7396 §1: merge patch không biểu diễn được `null` tường minh, `null` luôn xoá member. Với member nullable nhưng bắt buộc, "vắng" và "null" là cùng một trạng thái, nên member bị xoá được ghi lại là `null`. Member optional bị xoá thì vắng trong kết quả; handler phải ghi nó là "xoá", không spread kết quả đè lên bản ghi cũ.
  - Kết quả được validate lại bằng `schema`. Sai (vd. patch tạo object lồng mới nhưng thiếu member bắt buộc) → 422 `validation_failed` với path dạng chấm. Member ngoài `schema` bị bỏ khỏi kết quả.
  - Member tên `__proto__` bị từ chối (422): gán nó sẽ đổi prototype của kết quả thay vì tạo member, dữ liệu mất trong im lặng.

Bị từ chối lúc dựng schema, fail loud thay vì đoán:

| Trường hợp | Lý do |
| --- | --- |
| `.default()`/`.prefault()`/`.catch()` ở mọi cấp | zod điền giá trị cho member client không gửi (hoặc gửi sai), ghi đè dữ liệu trong im lặng |
| Member nhận object qua union, discriminated union, intersection, pipe/transform hoặc lazy | Không xác định được hình dạng để merge vào |
| `z.record` có key không phải `z.string()` (enum, literal…) | Tập key hữu hạn làm mọi entry thành bắt buộc; mô hình hoá bằng `z.object` |

Record là JSON object nên RFC 7396 merge nó theo từng entry như mọi object. Không thay nguyên khối, vì thế sẽ phải tự viết thuật toán lệch RFC. Giá trị không có hình dạng cố định (`z.unknown()`/`z.any()`) là leaf: patch validate bằng schema gốc, rồi merge theo RFC. Schema truyền vào `applyMergePatch` phải có input ≡ output (không transform), vì kết quả được parse lại bằng chính schema đó.

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

## Phương án đã loại

Merge Patch (R30): `json-merge-patch@1.0.2` (publish cuối 2021-07, CommonJS, không kèm type, mutate target, gặp key `__proto__` thì `return` giữa chừng nên chỉ áp một phần patch), `merge-patch@0.0.2` và `ts-merge-patch@0.1.0` (bỏ hoang, 5 lượt tải/tuần). Tự viết cũng bị loại vì đã có package đạt. Nest và zod không có merge patch. Chọn `tiny-merge-patch@1.0.0`: ESM, có type, thuần (không mutate), fork của `json-merge-patch`, publish 2026-03-29, khoảng 52k lượt tải/tuần, 0 issue mở; qua đủ 15 test vector Appendix A.

Review đã chốt bỏ `@nest-lab/throttler-storage-redis` và wrapper fail-open tự viết; dùng extension point ThrottlerStorage. Spike loại `@nestjs-redisx/idempotency` (key không bắt buộc, request trùng chờ, không lưu lỗi), AWS Powertools (chạy lại sau lỗi) và tự viết toàn bộ idempotency.

## Hệ quả

Redis suy giảm không làm mất an toàn route idempotent nhưng giảm năng lực phục vụ. Body replay có thể chứa PII nên TTL theo nhóm route, route tiền ngắn hơn. Header, scope và trạng thái route phải tuân thủ hợp đồng trên. OpenAPI phải tái sinh sau thay đổi API (`pnpm build && pnpm openapi:export`, output xác định, `openapi.json` được commit và Prettier bỏ qua); health ready 200 hiện chưa có schema đầy đủ trong tài liệu sinh ra. Script init inline của Scalar là `JSON.stringify` tài liệu OpenAPI của chính app, nên description không được chứa input không tin cậy.

## Nguồn

Spec SP1 phần HTTP; review trước thực thi §0, §2 và quyết định đã chốt; báo cáo Task 12–13, 18, `task-19-offlinequeue-report.md`; R14, R16 (đã bị R30 đảo), R17, R21, R23, R30. Xem [ADR phân trang](0012-two-pagination-modes.md).
