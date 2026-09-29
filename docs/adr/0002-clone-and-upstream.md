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

## Kết quả spike (plan 7A)

Chạy trên nhánh làm việc của plan 7A (đã merge 3A tại `f98d1cd`), Node 24.19, Nest 12.1, SWC 1.16.2, Vitest 5.0.1.

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| S7A-1 (O-14) | Top-level await trong `src/app.modules.ts` có chạy qua `nest build` + Node, hook `import-in-the-middle` (`--import ./dist/instrumentation.js`, OTel bật), `@swc-node/register` (`pnpm env:example`), `openapi:export`, Vitest (`unplugin-swc`) không? | Đạt | `node --input-type=module -e "…import('./dist/app.modules.js')…"` in `dist TLA ok 3 3`; cùng lệnh qua `--import ./dist/instrumentation.js` in `iitm TLA ok 3`; `--import @swc-node/register/esm-register` nạp `src/app.modules.ts` in `swc-node TLA ok 3`; `pnpm env:example` với `gen-env-example.ts` tạm import `app.modules.js` tự thoát (exit 0), `.env.example` chỉ đổi thứ tự khối (cùng tập dòng), `.env.infra.example` không đổi; `pnpm openapi:export` không lỗi, không diff; `test/e2e/core/entrypoints.e2e.spec.ts` xanh 2/2 |
| S7A-2 (O-16) | Tệp version mặc định của release-please strategy `simple` trong action v5.0.0 | `version.txt`, cập nhật với `createIfMissing: false` (repo phải có sẵn file) | `git ls-remote` tag v5.0.0 → `45996ed1f6d02564a971a2fa1b5860e934307cf7`; `dist/index.js` ở SHA đó, lớp `Simple`: `versionFile … ?? 'version.txt'`, `createIfMissing: false`; bundle phụ thuộc `release-please ^17.6.0` |
| S7A-3 | Scheduler BullMQ trên queue không có worker có sinh job vô hạn không? | Không: lần chạy kế chỉ được thêm khi worker xử lý job của scheduler, nên tối đa một job chờ | `node_modules/bullmq/dist/esm/classes/worker.js:525-537` (BullMQ 6.3.8), `upsertJobScheduler` ở dòng 534 |

## Nguồn

[Spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md) §0.1, §1.1 và lộ trình SP7; spec SP1 §2.
