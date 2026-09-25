# 0002 — Clone dự án và nhận cập nhật upstream

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Boilerplate phải tự đứng được trong mỗi repo dự án, đồng thời cho phép nhận bản vá nền mà không trộn nghiệp vụ riêng vào hạ tầng.

## Quyết định

Mỗi dự án clone thành repo riêng. `src/core/` và `src/modules/` thuộc boilerplate; `src/features/`, `src/app.modules.ts` và `src/migrations/app/` thuộc dự án. Tuỳ biến qua config, adapter, domain event hoặc bỏ module; nếu không đủ thì sửa ở upstream để các dự án cùng nhận được.

Upstream phát hành tag semver và `CHANGELOG.md`; dự án nhận bản vá bằng `git fetch upstream && git merge vX.Y.Z`. Spec yêu cầu CI dự án chặn sửa `core/` và `modules/` ngoài merge upstream.

Trạng thái SP1: repo chưa có `CHANGELOG.md`, chưa có tag, chưa có `src/modules/`, `src/features/` hay `src/migrations/app/`, và workflow CI của SP1 chưa có bước chặn sửa `core/`/`modules/`. `src/app.modules.ts` đã có, danh sách module rỗng. Quy trình upstream thuộc sub-project 7 (spec cha, phụ lục C).

## Phương án đã loại

Dự án sửa trực tiếp `core/` hoặc `modules/`: bị loại, CI của dự án báo lỗi với PR như vậy (trừ commit merge từ upstream). Thay vào đó dự án tuỳ biến qua config, adapter, domain event hoặc bỏ module; nếu cả bốn cách không đủ thì sửa ở boilerplate (spec cha §1.1).

Spec không ghi nhận phương án phân phối nào khác (ví dụ tách phần nền thành package) để so sánh; ADR này không đánh giá chúng.

## Hệ quả

Dự án sở hữu lịch cập nhật và phải kiểm tra migration, thay đổi API, adapter của mình trước khi nhận bản vá. Semver không loại bỏ xung đột merge. Chi tiết tự động hoá và xử lý xung đột upstream: Chưa quyết, xem sub-project 7.

## Nguồn

[Spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md) §0.1, §1.1 và lộ trình SP7; spec SP1 §2.
