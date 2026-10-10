# 0016 — HTTP ra ngoài, chặn SSRF và mã hoá field

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

URL từ hệ thống ngoài hoặc tenant có thể dẫn tới metadata, mạng nội bộ hay DNS rebinding. Retry sai có thể nhân side effect; field nhạy cảm cần mã hoá có xác thực và gắn đúng vị trí dữ liệu.

## Quyết định

### HttpClient và SSRF

Chỉ `HttpClient` trong core/resilience dùng undici Agent, với `connect.lookup` kiểm tra IP **ngay lúc kết nối**. Pre-check kiểm scheme, userinfo, port và IP literal; không chỉ resolve/validate DNS trước rồi kết nối lần khác.

Lookup resolve tất cả địa chỉ; nếu bất kỳ địa chỉ nào không được phép thì từ chối cả kết quả, kể cả caller yêu cầu một địa chỉ. IPv4 được phân loại bằng ipaddr.js; IPv6 công khai phải đồng thời **thuộc 2000::/3 và unicast**. Chỉ kiểm unicast là không đủ: IPv4-compatible ::/96 từng vượt kiểm tra.

Allowlist CIDR là ngoại lệ có chủ đích: từ chối /0, CIDR chứa metadata `169.254.169.254` hoặc `fd00:ec2::254`, và entry IPv4-mapped. IPv4-mapped được chuẩn hoá về IPv4 trước kiểm tra, nên địa chỉ private mặc định bị chặn; allowlist IPv4 đúng family vẫn có thể cho phép địa chỉ nội bộ tương ứng. Không diễn đạt thành mọi mapped address luôn bị chặn bất kể allowlist.

| Vector | Lớp bảo vệ đã kiểm chứng ở Task 15 |
| --- | --- |
| Loopback, RFC1918, link-local, CGNAT, multicast, unspecified, metadata | Kiểm literal và lookup |
| Hex/decimal/octal/rút gọn của 127.0.0.1 | WHATWG URL chuẩn hoá rồi kiểm literal |
| IPv6 ULA, ::1, ::, IPv4-compatible dạng hex | Phân loại cùng điều kiện 2000::/3 |
| NAT64, 6to4, Teredo | Bị chặn mặc định; ngoại lệ chỉ qua allowlist hợp lệ |
| DNS trộn public/private hoặc mapped private | Từ chối nếu một địa chỉ không hợp lệ |
| Redirect 302 tới metadata | Trả nguyên 302, không theo redirect |
| Userinfo, scheme hoặc port ngoài allowlist | Từ chối trước request |
| Response quá lớn | maxResponseSize của undici huỷ transport, không retry |

Undici request không theo redirect khi không gắn redirect interceptor. Không dùng option `maxRedirections` đã không được hỗ trợ trong bản xác minh. `maxResponseSize` đặt trên Agent, không tự viết vòng đọc giới hạn. Agent đóng khi shutdown; body được đọc hết trong lần gọi, signal abort khi timeout.

Production chỉ HTTPS. Các timeout, giới hạn, CIDR và override provider ở config. Provider là hằng số có tên, không phải URL/host/tenant do người dùng nhập vì cache policy theo provider không có eviction.

### Retry và ánh xạ lỗi

Cockatiel wrap theo thứ tự bulkhead → retry → breaker → timeout Aggressive, exponential backoff + full jitter. Chỉ GET/HEAD/OPTIONS/PUT/DELETE retry; POST/PATCH không tự retry dù caller thêm idempotency key (hẹp hơn spec SP1 §5.9, vốn cho retry cả request có idempotency key; code hiện tại chỉ xét method). Bulkhead giữ slot cả lúc backoff.

- Network, 5xx và timeout là lỗi transient.
- SSRF, response quá lớn, breaker mở, bulkhead đầy và **429 không retry**.
- Upstream 429 tạo `UpstreamError.reason = rate_limited`, mang status 429 và `retryAfter` (giây); ánh xạ HTTP **503**, kèm header `Retry-After` khi upstream có gửi. Trong code hiện tại, mã problem+json là `service_unavailable`, không phải `rate_limited`: `rate_limited` ở đây là lý do nội bộ. (Mã lỗi `rate_limited` 429 của core dành cho rate limit của chính API, xem [ADR 0007](0007-http-conventions.md).)
- Network/5xx/quá lớn/SSRF → 502 upstream_error; timeout → 504 upstream_timeout; breaker/bulkhead → 503 service_unavailable.

Retry-After của upstream (delta-seconds hoặc một trong ba dạng HTTP-date của RFC 9110) được parse thành số giây nguyên, mốc đã qua thành 0, chặn trần `RESILIENCE_RETRY_AFTER_MAX_SEC`; cú pháp sai coi như không biết. Parser tự viết (~20 dòng) vì undici chỉ parse Retry-After bên trong `RetryHandler`, không export. Log không chứa raw URL/query/body; URL parse sai bỏ cause vì TypeError có thể mang input chứa secret. Không gọi HttpClient trong transaction DB theo [ADR 0006](0006-queue-outbox.md).

### FieldCipher

Dùng node:crypto AES-256-GCM, IV ngẫu nhiên 12 byte, authTagLength 16 byte ở cả hai chiều. Token `v1.<kid>.<iv>.<ct>.<tag>`; AAD là `v1.<kid>.<table:column:orgId:pk>`, chống đổi kid hoặc chuyển ciphertext sang vị trí khác.

Keyring và active kid bắt buộc, không có mặc định; key decode đúng 32 byte, kid khớp `[a-z0-9]{1,16}`, active kid phải tồn tại. Base64url phải canonical (decode rồi encode lại khớp), kiểm số phần/độ dài trước giải mã. Lỗi FieldCipherError không lộ keyring hay input secret.

Đây là mã hoá field với keyring/kid/AAD, không phải envelope encryption qua KMS.

## Cập nhật SP2 (2026-09-27)

`toWebFetch(client, provider)` chuyển `HttpClient` thành fetch cho thư viện nhận custom fetch: `jose` external JWKS dùng provider `idp-jwks`, URL cố định, không theo `jku`/`x5u`, signal huỷ tới transport. S2-R14 truyền caller signal làm parent signal của policy; abort có thể tính vào breaker và request chờ bulkhead chỉ thấy abort khi được dequeue. Adapter hiện dùng cho GET JWKS, không phải transport OAuth POST.

Ngoại lệ có tên: Better Auth gọi Google OAuth và discovery/token/userinfo của `genericOAuth` bằng fetch của thư viện, không qua HttpClient. URL chỉ từ config/provider, production HTTPS; không nhận URL tenant. Chi phí là không có lớp SSRF/DNS-rebinding và policy resilience của core trên đường này; khi cần IdP động phải thiết kế lại biên tin cậy.

S2-R55/S2-R56: external JWKS phân loại lỗi token 401, hạ tầng đã nhận diện 503 (SSRF log ERROR), bug khác ném 500. Timeout attempt mặc định = hạn jose / (retries + 2), làm tròn xuống, tối thiểu 1 ms; override phải nhỏ hơn hạn jose. Chi tiết ở ADR 0010.

FieldCipher của SP2 dùng AAD `auth.account:<cột>:-:<providerId>/<accountId>` và public_id sinh ở app cho email delivery. Phải re-encrypt mọi dữ liệu còn cần đọc trước khi retire kid; SP2 chỉ có keyring nhiều kid, job/runbook thuộc SP7.

## Phương án đã loại

`request-filtering-agent` chỉ gắn http.Agent nên không bảo vệ fetch của Node; review còn ghi nhận vấn đề bảo mật của package. Global fetch với dispatcher có thể lệch version undici tích hợp; chọn undici cài riêng đã xác minh. Không tự viết bộ đọc capped body hoặc retry 429 với DelegateBackoff/parse lịch khi thư viện hiện tại không cung cấp đường xử lý đơn giản.

## Hệ quả

Chặn cả các dải chuyển đổi IPv6 mặc định; mạng đặc thù cần allowlist được rà soát. Dải private rộng như 10/8 còn được chấp nhận mà không có boot warning. Keyring được validate cho mọi role, kể cả migrate. ResilienceModule/SecurityModule cần được module sử dụng đăng ký qua app.modules; không coi config registry đồng nghĩa provider đã được wire.

SP2 chốt keyring nhiều kid và yêu cầu re-encrypt trước khi retire kid; job/runbook tự động thuộc SP7, xem ADR 0010.

## Nguồn

R4; review trước thực thi §0, §2.1 và quyết định đã chốt; spec SP1 §5.9, §5.12; báo cáo Task 15 (mục API đã kiểm chứng, ma trận SSRF và vòng sửa 1); đối chiếu `src/core/resilience/upstream-error.ts` cho ánh xạ 429.

## Cập nhật SP6 (6C) (2026-10-10)

- URL của tenant (webhook) đi qua hai lớp: `UrlGuard` lúc tạo/sửa (cùng `assertUrlAllowed`, mọi địa chỉ phân giải phải công khai
  hoặc trong `RESILIENCE_SSRF_ALLOW_CIDRS`; chỉ để phản hồi sớm `422`) và `ssrfLookup` lúc connect của `HttpClient` (lớp chặn thật,
  chống DNS rebinding, W-22).
- Provider `webhooks-out`: `setProviderDefaults` lúc DI của worker với `retries: 0`, breaker tắt (`breakerThreshold =
  Number.MAX_SAFE_INTEGER`), timeout `INTEGRATIONS_WEBHOOK_TIMEOUT_MS`, bulkhead `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT`/`_QUEUE`.
  Breaker theo provider sẽ gộp endpoint của mọi khách; sức khoẻ theo endpoint nằm ở DB.
- 3xx không được theo (`REDIRECT`); 429 dùng `Retry-After` đã chặn trần làm sàn của bước lịch.
- Timeout thật của `webhooks-out` (gồm `RESILIENCE_OVERRIDES`) phải nhỏ hơn lease delivery trừ biên 5 s (luật `webhooks-timeout-below-lease`); signal của job được truyền vào request.
