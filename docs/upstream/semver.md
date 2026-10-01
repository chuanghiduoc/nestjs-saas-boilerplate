# Semver và phát hành của boilerplate

Spec: `docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md` §13.6.

## Semver

- **Major:** xoá hoặc đổi nghĩa env; xoá hoặc đổi export ở `index.ts` của `core/*` hay `modules/*`; đổi bảng/hàm/role mà feature được phép tham chiếu (`organizations`, `tenancy_users`, `app_current_org`, `sweep_definer`, bảng catalogue nhận dòng seed); đổi chữ ký helper quét của core hoặc API công khai của entitlements mà mẫu dùng; breaking của `oasdiff`; đổi `values.schema.json` theo hướng từ chối values cũ; nâng major Node/Postgres/Kubernetes tối thiểu.
- **Minor:** thêm module, env, export, route, values.
- **Patch:** sửa lỗi không đổi hợp đồng.

## Upgrade notes

Mọi PR có migration ngoài `src/migrations/app/`, env mới hoặc đổi, hoặc đổi export ở `index.ts` của core/module phải có mục `## Upgrade notes` trong mô tả PR (mẫu PR `.github/pull_request_template.md` có sẵn mục này; file thuộc vùng boilerplate). Người duyệt PR phát hành chép vào `CHANGELOG.md` của release dưới tiêu đề `### Upgrade notes` (`pnpm upstream:sync` in đúng mục này). Mỗi migration ghi tác động khoá (bảng khoá, thời gian giữ).

## Phát hành

- release-please (`release-please-config.json`, strategy `simple`): version ở `.release-please-manifest.json` và `version.txt`; **không** chạm `package.json.version` (thuộc dự án). `CHANGELOG.md` do release-please ghi (bỏ khỏi prettier).
- Workflow `release-please.yml` chỉ chạy ở repo upstream: đặt biến repo `BOILERPLATE_UPSTREAM=true`. Clone không đặt biến này.
- Tag do `GITHUB_TOKEN` tạo không kích hoạt workflow khác, nên `release.yml` (build + ký image theo tag) chỉ chạy khi đặt secret `RELEASE_PLEASE_TOKEN` (fine-grained PAT hoặc token GitHub App có quyền contents + pull requests).
- Khởi đầu: sau khi plan 7A merge, người bảo trì gắn tag `v0.1.0` lên commit merge đó và tạo GitHub release `v0.1.0` (một lần, tay), để release-please tính các bản sau từ đó.
- PR phát hành gom commit theo conventional commits; merge PR đó tạo tag `vX.Y.Z` và GitHub release.
