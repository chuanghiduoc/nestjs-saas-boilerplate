# 0015 - Cache: hoãn khỏi SP1

- Status: accepted
- Date: 2026-09-25

## Decision

### SP1 không có `core/cache`

SP1 không có use case cache nào, và spec quy định "mặc định không cache". Cache sẽ được triển khai khi sub-project đầu tiên có nhu cầu.

### Lựa chọn khi triển khai cache

Khi một sub-project có use case cache, sẽ dùng:
- `@nestjs/cache-manager` (wrapper NestJS)
- `cache-manager` (core caching library)
- `@keyv/redis` (Redis adapter cho cache-manager)
- Client Redis (`redis`) được thêm vào (đã chấp nhận)

### Yêu cầu bắt buộc cho triển khai cache

Khi cache được triển khai, các yêu cầu sau bắt buộc tuân theo:

- **Key format**: Mỗi cache key bắt buộc chứa `org` (ID tổ chức) và `environment` (môi trường); các phần của key được escape để tránh xung đột.
- **TTL và jitter**: TTL (Time To Live) và jitter (random delay) được lấy từ cấu hình (config), không hardcode trong code.
- **Redis isolation**: Cache sử dụng instance Redis riêng biệt, khác database với queue (BullMQ) và idempotency. Cache không cần `noeviction` policy (có thể evict khi hết không gian), nhưng queue và idempotency cần `noeviction`.

### Đã loại: `bentocache`

`bentocache` bị loại vì:
- Khi nhận một instance `ioredis` v6 làm instance chia sẻ, nó âm thầm kết nối lại tới `127.0.0.1` thay vì dùng instance đã cấp, dẫn tới kết nối sai hoặc mất kết nối.
- Không có bản cập nhật mới từ tháng 02/2026, không bảo đảm hỗ trợ lâu dài.
