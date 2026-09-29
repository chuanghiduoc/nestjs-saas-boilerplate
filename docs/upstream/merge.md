# Nhận cập nhật upstream

Spec: `docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md` §13. Vùng sở hữu: `.upstream/zones.json` và `docs/boilerplate/README.md` mục "Vùng sở hữu và cập nhật upstream".

## Tiền điều kiện

- Remote `upstream` trỏ repo boilerplate (`git remote -v`); cây sạch.
- Nhánh mới từ `main`: `git switch -c chore/upstream-vX.Y.Z main`.
- Tag của upstream nằm ở `refs/upstream-tags/vX.Y.Z` (init chuyển tag đã clone vào đó, sync fetch vào đó); `refs/tags/v*` là tag phát hành của dự án. Hai bên trùng tên không chặn nhau.
- Merge upstream thường xuyên (mỗi bản minor); không bỏ qua nhiều bản major cùng lúc.

## Chạy

```bash
pnpm upstream:sync vX.Y.Z
```

1. Kiểm tag (dạng `vX.Y.Z`, nằm trên `upstream/main`, mới hơn bản trong `.upstream/version.json`), in mục "Upgrade notes" của mọi bản ở giữa; gõ lại tag để xác nhận đã đọc.
2. `git merge --no-ff --no-commit <tag>`.
3. Tự giải xung đột: vùng boilerplate và file sinh ra lấy bản upstream (upstream xoá thì xoá); vùng template giữ trạng thái đã xoá **theo từng mục của `zones.json`**: mục template nào dự án đã xoá hết (không còn path nào ở `HEAD`) thì file mới của upstream dưới mục đó cũng bị xoá; mục dự án còn giữ (ví dụ giữ `src/features/example/`) thì nhận file mới như upstream.
4. Xung đột ở vùng dự án hoặc vùng chung: script dừng (exit 3), in danh sách. Sửa tay theo mục dưới, `git add`, rồi `pnpm upstream:sync --continue`.
5. Sinh lại (`pnpm upstream:regenerate`: install, `env:example`, build, `openapi:export`), ghi `.upstream/version.json`.
6. Kiểm: guard vùng trên kết quả merge **đã stage**, rồi `pnpm upstream:verify` (install `--frozen-lockfile`, lint, test) trên cây làm việc. Vì hai bên phải trùng nhau, bước này từ chối khi còn thay đổi chưa stage hoặc file chưa track (in danh sách): `git add` hoặc bỏ chúng rồi `--continue`. Sửa code dự án sau khi verify đỏ mà đổi route hay env: chạy lại `pnpm upstream:regenerate` và `git add` file sinh ra trước khi `--continue`.
7. Script in lệnh commit; mở PR và **merge bằng "Create a merge commit"**. Job CI "upgrade path" của PR chạy migrate bằng bản trước merge rồi bản sau merge và khởi động api.

Mất điện giữa chừng: trạng thái suy ra từ git; chạy `pnpm upstream:sync --continue` hoặc `git merge --abort` rồi làm lại.

## Xung đột tay ở vùng chung

- `package.json`: giữ spec của upstream cho mọi khoá của upstream (dependency, script, `type`, `packageManager`, `engines`, `pnpm`); giữ khoá thêm của dự án; script của dự án có tiền tố `app:`.
- `pnpm-workspace.yaml`: giữ mọi dòng của upstream; chỉ thêm dòng của dự án.
- `renovate.json`: gộp `packageRules` hai bên.
- `.gitignore`, `.dockerignore`, `.gitleaksignore`: hợp hai tập dòng.
- Vùng dự án (`README.md`, `src/app.modules.ts`, …): giữ bản của dự án, áp thay đổi của upstream bằng tay nếu Upgrade notes yêu cầu.

## Squash: phòng, phát hiện, khôi phục

- **Phòng:** ruleset của repo cho `main` chỉ cho phép merge commit (tắt squash và rebase). Nếu dự án cần squash cho PR thường, tạo ruleset riêng chỉ cho merge commit với nhánh `chore/upstream-*`.
- **Phát hiện:** squash làm commit upstream không còn là tổ tiên của `main`; guard báo `upstream commit … is not in history (squash-merged sync PR?)` ở lần chạy trên `main` (lúc đó `main` đã đỏ).
- **Khôi phục sau squash:** trên nhánh mới từ `main`, thêm lại commit của tag làm cha mà không đổi cây:

```bash
git switch -c chore/upstream-ancestry main
git fetch --no-tags upstream "+refs/tags/v*:refs/upstream-tags/v*"
git merge -s ours --no-ff refs/upstream-tags/vX.Y.Z -m "chore: restore the upstream ancestry of vX.Y.Z"
git diff HEAD~1 HEAD   # phải rỗng
pnpm upstream:check
```
Mở PR, merge bằng merge commit.

## CODEOWNERS

`.github/CODEOWNERS` (sinh từ `docs/upstream/CODEOWNERS.template`) và `.upstream/version.json` thuộc vùng dự án nhưng do team nền sở hữu: sửa CODEOWNERS là gỡ lớp chặn cố ý, còn `version.json` chọn bản `check.mjs` mà CI chạy (spec SP7 §15). PR đồng bộ upstream vốn cần team nền duyệt vì đổi path vùng boilerplate.

## Hai người đồng bộ cùng lúc

Hai nhánh `chore/upstream-*` cùng sửa `.upstream/version.json`: PR merge sau gặp xung đột ở file đó. Không giải tay: `git merge --abort`, tạo lại nhánh từ `main` mới và chạy lại `pnpm upstream:sync vX.Y.Z`.

## Đã deploy với migration mẫu

Nếu production đã chạy migration của vùng template (mẫu `example`) trước khi khởi tạo: hoặc giữ mẫu (không xoá vùng template; `upstream:sync` giữ nó đồng bộ với upstream), hoặc chạy `down` của migration mẫu trên mọi môi trường trước khi xoá file (down từ chối khi còn dữ liệu).

## Bản vá khẩn

Không có đường thoát trong guard. Sửa gấp phần nền đi qua bản vá upstream (`vX.Y.Z+1`, release-please patch) rồi `pnpm upstream:sync`.
