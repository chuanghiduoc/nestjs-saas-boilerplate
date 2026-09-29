# 0002 — Clone dự án và nhận cập nhật upstream

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Boilerplate phải tự đứng được trong mỗi repo dự án, đồng thời cho phép nhận bản vá nền mà không trộn nghiệp vụ riêng vào hạ tầng.

## Quyết định

Mỗi dự án clone thành repo riêng. `src/core/` và `src/modules/` thuộc boilerplate; `src/features/`, `src/app.modules.ts` và `src/migrations/app/` thuộc dự án. Tuỳ biến qua config, adapter, domain event hoặc bỏ module; nếu không đủ thì sửa ở upstream để các dự án cùng nhận được.

Upstream phát hành tag semver và `CHANGELOG.md`; dự án nhận bản vá bằng `git fetch upstream && git merge vX.Y.Z`. Spec yêu cầu CI dự án chặn sửa `core/` và `modules/` ngoài merge upstream.

Trạng thái SP1: repo chưa có `CHANGELOG.md`, chưa có tag, chưa có `src/modules/`, `src/features/` hay `src/migrations/app/`, và workflow CI của SP1 chưa có bước chặn sửa `core/`/`modules/`. `src/app.modules.ts` đã có, danh sách module rỗng. Quy trình upstream thuộc sub-project 7 (spec cha, phụ lục C). Từ SP7 (7A): có `CHANGELOG.md` (`v0.1.0`), guard CI `upstream-guard` và công cụ `tools/upstream/`.

## Cập nhật SP7 (7A) (2026-09-29)

- **Vùng sở hữu máy đọc được:** `.upstream/zones.json` (boilerplate, dự án, template, sinh ra, chung; tiền tố dài nhất thắng; `projectSeed` = `src/app.modules.ts`, `README.md`: tập duy nhất của vùng dự án mà upstream được track). `tools/upstream/check.mjs --self` ở CI upstream bắt file chưa phân vùng.
- **Guard so cây (S7-D8):** với mọi path vùng boilerplate, cây ở `HEAD` phải trùng cây ở commit upstream ghi trong `.upstream/version.json`, và commit đó phải là tổ tiên của `HEAD` (squash bị bắt). Workflow `upstream-guard` chạy bản `check.mjs` **của commit upstream** (`git show <commit>:tools/upstream/check.mjs | node --input-type=module -`), đọc `zones.json` từ commit upstream: sửa guard hay vùng ở `HEAD` không nới được luật. Vùng template: path còn tồn tại phải trùng upstream, path đã xoá bỏ qua. `package.json`/`pnpm-workspace.yaml` kiểm theo khoá.
- **Không có đường thoát (S7-D9):** sửa gấp phần nền đi qua bản vá upstream.
- **Công cụ:** `pnpm upstream:init` (khởi tạo clone: version, chép hạt giống template → dự án, xoá vùng template, CODEOWNERS), `pnpm upstream:sync vX.Y.Z` (state machine suy ra từ git: tự giải vùng boilerplate/template/sinh ra, dừng ở vùng dự án/chung, sinh lại, kiểm trên kết quả merge), `pnpm upstream:check`. Node ESM thuần, không dependency.
- **Squash:** phòng bằng ruleset chỉ merge commit; phát hiện bằng kiểm tổ tiên; khôi phục bằng `git merge -s ours --no-ff <tag>` (cây không đổi).
- **Phát hành (S7-D10):** release-please `simple` (`version.txt`, không chạm `package.json.version`), tag `vX.Y.Z` + `CHANGELOG.md` với mục "Upgrade notes".
- **Composition lười (S7-D7):** "bỏ module" = không import (`composeAppModules({ disable })`), vì import một module là đăng ký config/queue/job/cron của nó.
- **Thứ tự migration theo vùng (S7-D31):** migration upstream đến muộn với timestamp cũ hơn migration dự án vẫn chạy (MikroORM chạy mọi migration chưa chạy; test UP-10); dự án không `ALTER`/`DROP` đối tượng boilerplate.
- Quy trình: `docs/upstream/merge.md`, `docs/upstream/semver.md`.

## Phương án đã loại

Dự án sửa trực tiếp `core/` hoặc `modules/`: bị loại, CI của dự án báo lỗi với PR như vậy (trừ commit merge từ upstream). Thay vào đó dự án tuỳ biến qua config, adapter, domain event hoặc bỏ module; nếu cả bốn cách không đủ thì sửa ở boilerplate (spec cha §1.1).

Spec không ghi nhận phương án phân phối nào khác (ví dụ tách phần nền thành package) để so sánh; ADR này không đánh giá chúng.

## Hệ quả

Dự án sở hữu lịch cập nhật và phải kiểm tra migration, thay đổi API, adapter của mình trước khi nhận bản vá. Semver không loại bỏ xung đột merge. Chi tiết tự động hoá và xử lý xung đột upstream: mục "Cập nhật SP7 (7A)" ở trên.

## Kết quả spike (plan 7A)

Chạy trên nhánh làm việc của plan 7A (đã merge 3A tại `f98d1cd`), Node 24.19, Nest 12.1, SWC 1.16.2, Vitest 5.0.1.

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| S7A-1 (O-14) | Top-level await trong `src/app.modules.ts` có chạy qua `nest build` + Node, hook `import-in-the-middle` (`--import ./dist/instrumentation.js`, OTel bật), `@swc-node/register` (`pnpm env:example`), `openapi:export`, Vitest (`unplugin-swc`) không? | Đạt | `node --input-type=module -e "…import('./dist/app.modules.js')…"` in `dist TLA ok 3 3`; cùng lệnh qua `--import ./dist/instrumentation.js` in `iitm TLA ok 3`; `--import @swc-node/register/esm-register` nạp `src/app.modules.ts` in `swc-node TLA ok 3`; `pnpm env:example` với `gen-env-example.ts` tạm import `app.modules.js` tự thoát (exit 0), `.env.example` chỉ đổi thứ tự khối (cùng tập dòng), `.env.infra.example` không đổi; `pnpm openapi:export` không lỗi, không diff; `test/e2e/core/entrypoints.e2e.spec.ts` xanh 2/2 |
| S7A-2 (O-16) | Tệp version mặc định của release-please strategy `simple` trong action v5.0.0 | `version.txt`, cập nhật với `createIfMissing: false` (repo phải có sẵn file) | `git ls-remote` tag v5.0.0 → `45996ed1f6d02564a971a2fa1b5860e934307cf7`; `dist/index.js` ở SHA đó, lớp `Simple`: `versionFile … ?? 'version.txt'`, `createIfMissing: false`; bundle phụ thuộc `release-please ^17.6.0` |
| S7A-3 | Scheduler BullMQ trên queue không có worker có sinh job vô hạn không? | Không: lần chạy kế chỉ được thêm khi worker xử lý job của scheduler, nên tối đa một job chờ | `node_modules/bullmq/dist/esm/classes/worker.js:525-537` (BullMQ 6.3.8), `upsertJobScheduler` ở dòng 534 |

## Nguồn

[Spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md) §0.1, §1.1 và lộ trình SP7; spec SP1 §2.
