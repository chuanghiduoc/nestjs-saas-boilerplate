# 0009 — BIGINT nội bộ, UUIDv7 công khai

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

PK và FK cần gọn, thuận lợi cho index; định danh ra ngoài không nên là số thứ tự có thể liệt kê.

## Quyết định

PK dùng `BIGINT GENERATED ALWAYS AS IDENTITY`; định danh công khai dùng `public_id UUID` sinh bằng `uuidv7()` của Postgres. Org ID dùng UUID (spec cha §0.4: UUIDv7 do Better Auth sinh, thuộc sub-project 2); `app_current_org()` trả uuid. UUIDv7 có thứ tự theo thời gian, không phải bí mật hay cơ chế phân quyền.

Ngoại lệ R11: inbox `processed_events` dùng PK `(consumer, event_id)` vì đây là truy vấn dedup thực sự; thêm identity chỉ tạo index không dùng. Mọi bảng vẫn có timestamp tạo/cập nhật.

## Phương án đã loại

Đưa BIGINT ra API: bị loại, vì ID tuần tự liệt kê được (spec cha §0.4 chọn `public_id` UUIDv7 khi ra ngoài). Fallback sinh public ID ở app chưa cần: spike S5 xác nhận Postgres 18.6 có `uuidv7()`; bootstrap migration gọi thử để DB không hỗ trợ thất bại rõ ràng.

## Hệ quả

Mapping DTO phải dùng định danh công khai. Không suy quyền truy cập từ độ khó đoán ID; tenant vẫn được bảo vệ bởi [RLS](0005-multi-tenant-rls.md).

Trạng thái SP1: chưa bảng nào có cột `public_id` (chưa có resource công khai); `core_bootstrap` chỉ gọi `SELECT uuidv7()` để kiểm tra. Các UUIDv7 do core tạo ra (`requestId`, `event_id` của outbox, `jobId` của `SafeEnqueue`) sinh ở app bằng package `uuid` (`v7`, spec cha §17).

## Nguồn

Spec cha §0.4 và danh sách ADR; spec SP1 §4 S5, §5.4; báo cáo Task 5, 9; R11.
