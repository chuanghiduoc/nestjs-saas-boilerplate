# 0004 — Ports & adapters trong module

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Nghiệp vụ phải thay được ORM hoặc bổ sung DB mà không kéo thư viện hạ tầng vào domain. Tách lớp chỉ có giá trị nếu giữ được bảo đảm khoá, atomicity và cô lập tenant.

## Quyết định

Module nền dùng layered + ports & adapters. Domain là TypeScript thuần, không decorator ORM. Port repository đặt theo use case và ghi rõ bảo đảm transaction/khoá; mỗi aggregate root có port phù hợp. Adapter và mapper nằm trong `infra/`; mỗi port có contract test dùng lại cho mọi adapter.

Transaction đi qua `UnitOfWork`; SQL qua `Db.execute` hoặc `RelayDb`, không qua `getConnection().execute`. Job handler nhận `JobContext`, không import BullMQ. Domain event qua outbox theo [ADR 0006](0006-queue-outbox.md).

dependency-cruiser kiểm tra hướng phụ thuộc và public `index.ts`. ORM chỉ ở `core/database/**`, `**/infra/**` và migration `src/migrations/**` (ngoại lệ R7 cho generator). Fixture migration là mã test; lượt `pnpm arch` hiện chỉ quét `src`. BullMQ chỉ ở `core/queue`; Express ở `core/http`; undici/ipaddr.js/cockatiel ở `core/resilience`; ioredis ở `core/redis` hoặc `core/http`.

Spec cho phép CRUD đơn giản trong `features/` dùng MikroORM thẳng trong service (spec cha §4.2), nhưng luật `orm-only-in-infra` hiện hành (spec SP1 §7 luật 4) không có ngoại lệ cho `features/`: mã dùng ORM vẫn phải đặt trong `infra/`. Hai nguồn này lệch nhau; nới luật cho `features/` hay không: Chưa quyết, xem sub-project 7 (feature mẫu).

Trạng thái SP1: chưa có module nền (`src/modules/`) nên chưa có port nghiệp vụ, mapper hay bộ contract test nào. Ở core đã có port `UnitOfWork` (adapter `MikroOrmUnitOfWork`) và `JobQueue` (adapter `BullmqJobQueue`), cùng `Db`/`RelayDb` cho SQL và kiểu `JobContext` cho handler.

## Phương án đã loại

Đưa entity ORM hay thư viện hạ tầng vào `domain/`, và import sâu vào module khác: bị cấm bằng luật dependency-cruiser (spec SP1 §7 luật 2, 7). Repository chung chung kiểu CRUD cho mọi entity: spec cha §4.2 chọn port viết theo use case và ghi rõ bảo đảm (khoá dòng, atomic).

## Hệ quả

Thêm interface và mapper cho aggregate nền. Đổi khỏi Postgres vẫn phải tái tạo các bảo đảm RLS, partial index và `SKIP LOCKED`; thay adapter không tự làm các bảo đảm này tương đương. Không thực hiện đổi DB trong SP1.

## Nguồn

Spec cha §1, §4.2; spec SP1 §5.3–5.6; R7; báo cáo Task 5, 8, 17 và phần review Task 17 trong ledger. [Spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md).
