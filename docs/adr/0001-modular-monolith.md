# 0001 — Modular monolith

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Đội dự án nhỏ, không có SRE riêng; chi phí vận hành và khả năng nhận bản vá nền là ràng buộc. Cần tách trách nhiệm nghiệp vụ nhưng chưa có nhu cầu deploy từng module độc lập.

## Quyết định

Một codebase, một image, hai process chạy thường trực: `api` và `worker`; `migrate` là vai trò chạy một lần. API stateless để scale ngang; worker chọn queue qua `WORKER_QUEUES`.

Hướng phụ thuộc là `features → modules → core`. Trong module: `http → application → domain`, `infra → ports`. Module chỉ công khai qua `index.ts`; module ngang hàng gọi public API đồng bộ hoặc trao đổi event bền vững qua outbox. Entrypoint và module gốc tách riêng; dự án đăng ký module trong `src/app.modules.ts`.

SP1 dựng hạ tầng và fixture kiểm chứng, chưa triển khai module nghiệp vụ. Bull Board đã bỏ khỏi SP1, chuyển SP2 sau RBAC admin, chỉ đọc trên cổng nội bộ.

## Phương án đã loại

Spec cha §1 ghi rõ "Không làm": microservices, SOA/ESB, Nest monorepo `apps/libs`. Ràng buộc §0.2 (đội nhỏ, không có SRE, chi phí vận hành là ràng buộc thật) là lý do chung.

## Hệ quả

API và worker scale riêng nhưng dùng chung một image; payload job có version để worker cũ và mới chạy song song khi rolling update (spec cha §13.1). Ranh giới module được giữ bằng luật dependency-cruiser ([ADR 0004](0004-ports-and-adapters.md)), không bằng ranh giới process.

Xem lại khi một module cần nhịp deploy riêng, cần scale khác hẳn phần còn lại, hoặc được giao cho đội khác sở hữu. Khi đó thay lời gọi public API bằng HTTP/gRPC và thay event trong process bằng broker (spec cha §1).

## Nguồn

Spec cha §0.2, §1, §1.1, §13.1; spec SP1 §2, §6; báo cáo Task 6. Xem [spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md) và [spec SP1](../superpowers/specs/2026-09-24-sp1-core-job-infrastructure-design.md).
