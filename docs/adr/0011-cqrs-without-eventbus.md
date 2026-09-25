# 0011 — CQRS nhẹ, không dùng EventBus cho domain event

- Trạng thái: Đã chấp nhận về kiến trúc; bus nghiệp vụ chưa triển khai trong SP1
- Ngày: 2026-09-25

## Bối cảnh

Luồng ghi cần bảo vệ invariant của aggregate và atomicity với event. Luồng đọc cần DTO phù hợp truy vấn, không buộc đi qua aggregate hoặc identity map. Domain event phải sống qua restart và Redis gián đoạn.

## Quyết định

Theo spec cha §7, dùng CQRS nhẹ với `@nestjs/cqrs`: `@CommandHandler` gọi aggregate/repository và ghi outbox trong một `UnitOfWork`; `@QueryHandler` gọi query service (SQL/Kysely) trả thẳng DTO, không đi qua identity map, không N+1. Global constraint của SP1 chỉ cho SQL đi qua `Db.execute` hoặc `RelayDb`; query service dùng Kysely thế nào cho khớp luật đó: Chưa quyết, xem sub-project 2.

Không dùng `EventBus` hoặc Saga trong bộ nhớ của `@nestjs/cqrs` để giao domain event. `EventPublisher.publish` ghi outbox trong transaction; worker giao qua inbox theo [ADR 0006](0006-queue-outbox.md). Read model tổng hợp cập nhật bằng event; báo cáo chấp nhận trễ có thể dùng materialized view refresh `CONCURRENTLY` qua cron.

SP1 mới cung cấp `UnitOfWork`, event/outbox/inbox và queue; chưa cài `@nestjs/cqrs`, chưa có CommandBus/QueryBus hay handler nghiệp vụ.

## Phương án đã loại

`EventBus`/Saga của `@nestjs/cqrs` cho domain event: bị loại vì chạy trong bộ nhớ (event mất khi process chết). Event sourcing và tách DB đọc/ghi: spec cha §7 ghi "Không làm".

## Hệ quả

Cùng DB cho đọc và ghi; read model qua event có độ trễ. Command không gọi HTTP/Redis/SMTP trong transaction; ghi ý định qua outbox, thực hiện ở job ngoài transaction. Chi tiết module nghiệp vụ đầu tiên dùng bus: Chưa quyết, xem sub-project 2.

## Nguồn

[Spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md) §7; spec SP1 §2, §5.3–5.5; báo cáo Task 9–10 và Task 19 relay fix (R22).
