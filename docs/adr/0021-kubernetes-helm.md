# 0021 — Deploy Kubernetes bằng Helm (chart saas-app)

- **Trạng thái:** đang triển khai; các mục Quyết định, Phương án đã loại, Hệ quả được viết khi chart hoàn tất.
- **Ngày:** 2026-10-21
- **Spec:** [SP7 §12](../superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md)

## Kết quả spike

Chạy trên nhánh `sp7b-helm` (từ `main` `2ccd408`), máy dev Windows 11 + Docker Desktop 29.7.2, image `nestjs-saas-boilerplate:kind` build từ HEAD, cụm `kindest/node:v1.34.11@sha256:44e222ee…` (kind v0.33.0).

| Chủ đề | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| Công cụ | Version, checksum và cờ của công cụ | Helm v4.3.1 và v3.22.1, kind v0.33.0, kubectl v1.34.12, kubeconform v0.8.0, checksum khớp file của release (Windows: `helm-v4.3.1-windows-amd64.zip` `fcfd7b79…`, `helm-v3.22.1-windows-amd64.zip` `32ce9f45…`, `kind-windows-amd64` `4b22adaa…`, `kubectl.exe` `df1eabf2…`, `kubeconform-windows-amd64.zip` `e3f56102…`); `--wait` không giá trị = `watcher`, bỏ cờ = `hookOnly`; `--rollback-on-failure` đặt `--wait=watcher`; `--atomic`/`--force` không còn trong help (thay bằng `--rollback-on-failure`/`--force-replace`); `--timeout` áp cho từng thao tác gồm Job hook; `--server-side` mặc định `auto` | output `helm upgrade --help`, `helm rollback --help` |
| OTel resource | `NodeSDK` 0.222 có đọc `OTEL_RESOURCE_ATTRIBUTES` không? | Đạt, không cần detector tường minh: env detector mặc định của `NodeSDK` đưa mọi cặp lên resource của span; test đặc tả hành vi có sẵn của thư viện nên không có bước đỏ | `test/integration/core/observability/otel-resource-attributes.spec.ts` (giữ thành test hợp đồng) |
| Pod Security | PSA `restricted` nhận pod với securityContext của chart; rootfs chỉ đọc + `emptyDir` `/tmp` đủ cho Node 24 distroless? | Đạt, không sửa securityContext | pod `tmp-probe` in `{"tmp":"/tmp","rootReadOnly":true,"uid":65532}`; `dist/main.migrate.js --help` in `Usage: main.migrate.js [up \| down \| status] [target]` dưới rootfs chỉ đọc; không `FailedCreate`; pod đối chứng bị `Forbidden: … violates PodSecurity "restricted:latest"` |
| NetworkPolicy | kindnet của kind v0.33.0 thực thi NetworkPolicy? | Có (không cần Calico) | probe TCP `open` → `blocked` (deny egress) → `open` (allow đúng pod:port) |
| NOTES | `helm install --dry-run=client` in NOTES không cần cụm? | Helm 4.3.1: có; Helm 3.22.1: không (đòi cụm: `Kubernetes cluster unreachable`) | chart thử in `T_min = 1560` với `KUBECONFIG` trỏ file không tồn tại |
