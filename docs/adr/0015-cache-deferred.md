# 0015 — Cache: hoãn khỏi SP1

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Spec cha §8 quy định "mặc định không cache, chỉ bật ở chỗ đã đo là cần". SP1 không có use case cache nào. Review trước thực thi (Q1) phát hiện `bentocache`, thư viện dự kiến ban đầu, có bug với ioredis 6.

## Quyết định

### SP1 không có `core/cache`

Cache được triển khai ở sub-project đầu tiên có use case (ứng viên đầu tiên theo spec cha §8: kết quả kiểm tra entitlement theo org).

### Stack khi triển khai cache

- `@nestjs/cache-manager` (module chính thức của Nest)
- `cache-manager` 7
- `@keyv/redis` (adapter Redis cho cache-manager)
- Chấp nhận thêm client Redis `redis` bên cạnh ioredis.

### Yêu cầu bắt buộc khi triển khai

- **Key:** mỗi key bắt buộc chứa môi trường (`env`) và `orgId` (lấy từ `RequestContext`), các phần của key được escape. Dạng theo spec cha §8: `{env}:{module}:v{n}:{orgId}:…`; invalidate bằng cách tăng version.
- **TTL và TTL jitter:** TTL và biên độ jitter của TTL lấy từ config, không hardcode trong code.
- **Tách Redis:** cache dùng instance hoặc DB Redis riêng, không chung với queue (BullMQ) và idempotency. Cache được phép evict; queue và idempotency cần `noeviction`.

## Phương án đã loại

`bentocache`:

- Khi nhận một instance `ioredis` v6 dùng chung, nó âm thầm kết nối tới `127.0.0.1` thay vì dùng instance được cấp.
- Không có bản phát hành mới từ tháng 02/2026.

Các ứng viên khác trong review (`@nestjs-redisx/cache`, hoặc giữ `bentocache` chỉ với connection options) không được chọn; review đã chốt bỏ cache khỏi SP1 và dùng stack chính thức ở trên (review, mục 0 Q1).

## Hệ quả

SP1 không có code cache. Khả năng chống stampede của `wrap` và việc có dùng L1 trong bộ nhớ hay không (không có bus xoá L1 giữa các pod, nên L1 nếu dùng chỉ TTL ngắn) phải kiểm chứng khi triển khai: Chưa quyết, xem sub-project 4 (entitlements, ứng viên cache đầu tiên).

SP4 (plan 4A) không cache entitlement ở v1: mỗi lần đọc là một câu theo PK; điều kiện bật và thiết kế có version ở ADR 0018. Stack cache-manager ở trên không dùng cho entitlement vì không so version khi ghi lại.

## Nguồn

[Spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md) §8, §17; review trước thực thi mục 0 (Q1) và mục 4 (Q1); spec SP1 §2 (ngoài phạm vi); báo cáo Task 14; ghi chú review Task 14 về hai chỗ sửa từ ngữ.
