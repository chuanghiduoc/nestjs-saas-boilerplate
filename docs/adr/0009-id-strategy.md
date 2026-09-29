# 0009 — BIGINT nội bộ, UUIDv7 công khai

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

PK và FK cần gọn, thuận lợi cho index; định danh ra ngoài không nên là số thứ tự có thể liệt kê.

## Quyết định

PK dùng `BIGINT GENERATED ALWAYS AS IDENTITY`; định danh công khai dùng `public_id UUID` sinh bằng `uuidv7()` của Postgres. Org ID dùng UUID (spec cha §0.4; organization thuộc SP3, cơ chế ID Better Auth cập nhật ở mục SP2 bên dưới); `app_current_org()` trả uuid. UUIDv7 có thứ tự theo thời gian, không phải bí mật hay cơ chế phân quyền.

Ngoại lệ R11: inbox `processed_events` dùng PK `(consumer, event_id)` vì đây là truy vấn dedup thực sự; thêm identity chỉ tạo index không dùng. Mọi bảng vẫn có timestamp tạo/cập nhật.

## Cập nhật SP2 (2026-09-27)

S3/S2-R41 chọn nhánh A: `advanced.database.generateId: 'uuid'` với Kysely/Postgres để Better Auth bỏ id phía app và dùng `DEFAULT uuidv7()` trong migration; integration kiểm version 7. Không hiểu option này thành UUIDv4 ở runtime Postgres. PK của `auth.*` là UUID theo schema thư viện, không ép BIGINT; `apikey.reference_id` được đổi text → uuid để FK tới user.

Ngoại lệ có tên: `identity.user.registered` dùng UUIDv5 xác định từ user id và namespace cố định, để after-hook/cron cùng event id và chống trùng bằng outbox/inbox. Các event khác vẫn v7. `email_deliveries.public_id` là UUIDv7 sinh ở app trước INSERT để dựng AAD; org và API key theo org là SP3, không phải plugin organization đã triển khai ở SP2.

## Cập nhật SP3 (3A) (2026-09-29)

- `organizations.id` là **PK UUID v7 sinh ở app** (ngoại lệ có tên với PK `BIGINT`; `CHECK (uuid_extract_version(id) = 7)`): org id là khoá tenant của RLS (`app_current_org()` trả `uuid` từ SP1) và của mọi FK kép. Client không chọn được id (khoá `id` trong body bị bỏ).
- Mọi bảng khác của tenancy: `id BIGINT` nội bộ + `public_id UUID DEFAULT uuidv7()` công khai.
- Một người có hai id: `principal.id` (id `auth."user"` ở local/hybrid, `sub` ở external) chỉ ở API identity, `actor.id` của envelope và log của identity; `tenancy_users.public_id` là `userId` ở MỌI API và `data` của event tenancy (spec SP3 §14).

## Phương án đã loại

Đưa BIGINT ra API: bị loại, vì ID tuần tự liệt kê được (spec cha §0.4 chọn `public_id` UUIDv7 khi ra ngoài). Fallback sinh public ID ở app chưa cần: spike S5 xác nhận Postgres 18.6 có `uuidv7()`; bootstrap migration gọi thử để DB không hỗ trợ thất bại rõ ràng.

## Hệ quả

Mapping DTO phải dùng định danh công khai. Không suy quyền truy cập từ độ khó đoán ID; tenant vẫn được bảo vệ bởi [RLS](0005-multi-tenant-rls.md).

Trạng thái SP1: chưa bảng nào có cột `public_id` (chưa có resource công khai); `core_bootstrap` chỉ gọi `SELECT uuidv7()` để kiểm tra. Các UUIDv7 do core tạo ra (`requestId`, `event_id` của outbox, `jobId` của `SafeEnqueue`) sinh ở app bằng package `uuid` (`v7`, spec cha §17).

## Nguồn

Spec cha §0.4 và danh sách ADR; spec SP1 §4 S5, §5.4; báo cáo Task 5, 9; R11.
