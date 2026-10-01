# 0013 — ESM, SWC, TS7, image distroless và công cụ kiểm tra

- Trạng thái: Đã chấp nhận; mốc kích thước image cũ ≤ 200 MB không đạt (đạt mốc mới ≤ 400 MB), khởi động khi bật OTel đạt < 3 s sau khi đổi loader ESM sang hook đồng bộ (2026-09-28, biên mỏng), xem bảng số đo
- Ngày: 2026-09-25

## Bối cảnh

SP1 cần xác minh ESM, DI qua decorator metadata, hai nhánh TypeScript và layout migration trước khi triển khai core. Spec cha §13 là nguồn mục tiêu; phép đo không được dùng để sửa ngưỡng.

## Quyết định

- ESM, `type: module`; import nội bộ có đuôi .js. SWC qua Nest CLI, sourceRoot src, không type-check trong build; legacyDecorator và decoratorMetadata bật. Spike S1 chạy được ESM nên không fallback CommonJS.
- TS7 alias `ts7` (typescript 7.0.2) chạy `--noEmit`; `typescript` thường là 6.0.3 cho compiler API của tool. @swc-node/register yêu cầu >=4.3 <7 nên không chuyển compiler API sang TS7.
- Vitest 5 + unplugin-swc; project unit, integration/e2e, chaos. Integration dùng Testcontainers; @swc-node/register phục vụ script dev và child process có decorator.
- oxlint type-aware + Prettier; no-explicit-any là error. `docs/` bị Prettier bỏ qua, **README.md vẫn được kiểm tra**.
- Runtime chỉ trong src, build ra ba entrypoint, migrations và scripts trong dist. Migration fixture không đưa vào image.
- Swagger plugin của Nest CLI không bật; Task 12 đã triển khai OpenAPI 3.1 từ zod qua Standard Schema, không còn là phần chưa làm.

### Phiên bản và bằng chứng spike Task 1

| Công cụ | Phiên bản ghi nhận |
| --- | --- |
| Node tại máy đo Task 1 | 24.19.0 LTS |
| Corepack / pnpm | 0.35.0 / 11.23.0 |
| Nest CLI latest lúc scaffold / bản resolve dự án | 12.0.6 / 12.0.5 |
| TypeScript API / type-check | 6.0.3 / 7.0.2 |
| SWC core / CLI | 1.16.2 / 0.8.1 |
| Vitest / coverage | 5.0.1 / 5.0.1 |
| unplugin-swc / swc-node register | 2.0.0 / 1.12.1 |
| oxlint / Prettier | 1.85.0 / 3.9.9 |

Các số này là lịch sử từ Task 1, không tự suy thành phiên bản mới nhất hiện nay. Node cho CI/image là **24.21.0**; `.nvmrc` khớp image theo R24, không lấy patch 24.19.0 của máy đo.

Task 1 đã chạy các lệnh registry, đầu ra liên quan:

```text
pnpm view @nestjs/cli dist-tags
{ "next": "12.0.0-alpha.9", "latest": "12.0.6" }
pnpm view typescript dist-tags
latest: 7.0.2
pnpm list typescript ts7
ts7@npm:typescript@7.0.2
typescript@6.0.3
```

TS6 là ngoại lệ tương thích đã xác minh, không cài plain typescript theo latest TS7 làm hỏng compiler API. Peer warning tsconfck muốn TypeScript ^5 còn tồn tại; báo cáo Task 1 không thấy ảnh hưởng tới build/test.

### Chính sách package và khác biệt so với brief

pnpm thực tế 11.23.0, không phải pnpm 12 dự kiến trong spec. `minimumReleaseAge: 1440`, `saveExact: true`; pnpm 11 dùng `allowBuilds`, các khoá onlyBuiltDependencies cũ đã bị bỏ. Chỉ cho build script @swc/core, msgpackr-extract, protobufjs; chặn @scarf/scarf, các dependency native không cần như cpu-features/ssh2 không được cấp quyền. Renovate chờ 3 ngày.

Trước cài package phải đọc dist-tags/peerDependencies bằng lệnh; dùng pnpm add không tự chọn version, lưu exact. Docker image pin digest, Action pin SHA từ registry/API. Chỉ một ioredis trong cây: version khai báo một chỗ trong pnpm catalog, `overrides: { ioredis: 'catalog:' }` trong `pnpm-workspace.yaml` ép mọi bản bắc cầu về đó (cú pháp `$ioredis` đã deprecated ở pnpm 11).

Nest schematic thực tế sinh Vitest và oxlint, không phải Jest/ESLint. Không có flag ESM riêng; scaffold không tương tác đã sinh type module. TypeScript scaffold đã ở nhánh 6; thêm alias ts7 thay vì đảo alias như brief giả định. File e2e mẫu import supertest/types sai dưới nodenext đã được loại cùng test layout không còn dùng.

Scaffold chạy ở thư mục tạm ngoài worktree (R1). Skip-git khiến CLI không sinh .gitignore; Task 1 lấy mẫu từ probe generator và giữ ignore vùng điều phối/worktree theo R5. Đây là lịch sử scaffold, không yêu cầu đổi ignore để chứa artifact công cụ.

### Kiểm chứng DI và sửa sau review Task 1

Tắt decoratorMetadata trong Vitest transform làm test DI đỏ (dependency undefined); bật lại test xanh. Chỉ bỏ .swcrc không làm test đỏ vì unplugin-swc có default riêng; build và test đã kiểm từng đường.

Review đã sửa no-explicit-any từ off thành error và pin typescript 6.0.3 bằng pnpm thay vì giữ caret. Cài unqualified typescript sẽ lên TS7 không phù hợp; phiên bản TS6 đã được xác minh qua registry. Raw output và toàn bộ thử nghiệm nằm trong báo cáo Task 1.

## Image production (Task 19, 2026-09-25)

Một image cho api, worker và migrate. Các stage: deps (pnpm fetch, BuildKit cache mount) → build (install frozen lockfile, nest build, prune --prod) → runtime distroless USER 65532. Runtime chỉ chứa package.json, production node_modules và dist. CMD API nạp instrumentation trước main.api; Compose đổi tham số cho worker/migrate.

Các quyết định Task 19 được giữ lại:

- Build base node:24.21.0-trixie-slim khớp Debian 13 của distroless nodejs24-debian13; tránh lệch glibc cho native dependency. Cả hai dùng Node 24.21.0, pin digest.
- packageManager pin pnpm 11.23.0 kèm sha512. .npmrc không COPY vào image.
- Install dùng **--prefer-offline**, không --offline: layer deps có thể lấy từ GHA cache trong khi cache mount pnpm còn rỗng; cần cho tải phần thiếu.
- Sau prune xoá declaration/source map của dependency không cần runtime (khoảng 90 MB); giữ map của dist. Không bundle.
- File ứng dụng thuộc root, process UID 65532 chỉ đọc; đã thử ghi /app/dist và nhận EACCES.
- Không init/tini: node PID 1 như K8s, app không sinh child process. installShutdown xử lý signal sau boot; signal tới trước khi handler đăng ký hoặc tới migrate có thể bị bỏ qua tới SIGKILL.
- Compose bật read_only, tmpfs /tmp, cap_drop ALL, no-new-privileges. Cổng container API 3000/worker 3001 cố định để healthcheck khớp; cổng host lấy từ .env.infra, bind 127.0.0.1.
- stop_grace_period API/worker 30 s vượt deadline app 28 s; migrate 10 phút bằng statement timeout mặc định, khi đổi phải kiểm tra lại.

Task 19 xác nhận UID, không có shell/curl, không có src/test/env trong image; migrate --help không cần DB/env, migrate up lặp không áp lại migration; API/worker healthy; OTel xuất trace/metric tới collector. Chỉ kiểm image amd64 trên Docker Desktop 29.7.2/WSL2; không coi cấu hình release đa kiến trúc là bằng chứng arm64 đã chạy.

### Số đo image đã có từ Task 19

| Chỉ số | Giá trị ghi nhận |
| --- | --- |
| Image chưa nén, tổng layer | 284 MB |
| Image nén, content size | 71,4 MB |
| Image trước khi bỏ map/declaration | 383 MB |
| Base distroless / riêng node | 159 MB / 127 MB |
| node_modules sau cắt / dist | 123 MB / 1,6 MB |
| Build lạnh, gồm pull theo báo cáo | 41 s |
| Rebuild chỉ code | 14 s |
| Rebuild đổi package.json, store ấm | 28 s |
| API tới listening, chạy riêng / cùng worker | 1,39 s / 1,57 s |
| Worker tới health listening | 1,50 s |
| API bật OTel tới listening | 3,13 s |

Đây là số đo lịch sử Task 19, không phải đo lại sau toàn bộ sửa relay/offline queue. Mốc startup lấy State.StartedAt tới log listening, **không phải lần đầu readiness trả 200**.

Image 284 MB vượt mục tiêu. Base đã 159 MB; Task 19 chỉ ra OTel khoảng 106 MB qua 80 package là hướng cần đánh giá nếu muốn giảm kích thước. Chưa có quyết định thay auto-instrumentations bằng tập package nhỏ hơn; không suy rằng đã tối ưu hay đã đạt 200 MB. API bật OTel đã tới listening sau 3 s, nên mốc này cũng vượt ngân sách startup.

### Compose và tách secret (Task 19, vòng sửa 1)

pnpm env:example sinh hai file: .env.example → .env (app, vào container qua env_file), .env.infra.example → .env.infra (superuser, Redis password, role timeout, cổng host, COMPOSE_REDIS_URL, chỉ dùng nội suy Compose).

Role password không cần thiết bị ghi đè rỗng: chỉ migrate giữ DB_OWNER_PASSWORD, chỉ worker giữ DB_RELAY_PASSWORD; config coi chuỗi rỗng là thiếu. COMPOSE_REDIS_URL dùng hostname redis và mật khẩu khớp REDIS_PASSWORD.

Service app có profiles [app], build và pull_policy build. Hạ tầng riêng:

```bash
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env up -d
```

Chạy ba vai trò từ image:

```bash
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env --profile app up -d --build
```

Dockerignore chặn secret theo mẫu đệ quy, không chỉ ở root. Không đưa secret infra vào container app.

### Ngoại lệ lịch GitHub Actions (Task 20)

Workflow nightly khai báo `17 2 * * *` trực tiếp trong .github/workflows/nightly.yml (02:17 UTC mỗi ngày). GitHub chỉ đọc lịch trong YAML, không đọc Zod/env của app, nên đây là ngoại lệ có phạm vi của quy tắc cấm cron hardcode. Cron ứng dụng vẫn thuộc schema config module.

Workflow hỗ trợ chạy tay, chạy Ubuntu có Docker và build trước chaos suite, gồm nhánh SIGTERM thật trên Linux. CI PR/main chạy các gate; release có SBOM/provenance, ký keyless, build đa kiến trúc và không đọc cache PR ghi được. Đây là mô tả workflow đã tạo, không khẳng định run từ xa đã xanh.

## Bảng mục tiêu và số đo tổng hợp (Task 21)

Mục tiêu lấy nguyên từ spec cha §13.2 và §13.3, không chỉnh theo số đo. Số đo lấy từ báo cáo Task 1, báo cáo Task 19, và phép đo lại trong Task 21 trên code hoàn chỉnh của SP1.

Máy đo Task 21: Windows 11 Pro, Node 24.19.0 trên host, Docker Desktop 29.7.2 (WSL2, x86_64, VM 12 CPU, 13,5 GiB RAM). Task 19 đo trên cùng Docker Desktop 29.7.2/WSL2/amd64.

| Chỉ số | Mục tiêu (spec cha) | Đo được | Đánh giá |
| --- | --- | --- | --- |
| Build SWC (`rm -rf dist && pnpm build`) | < 10 s (§13.2) | Task 1 (scaffold 4 file): 1,464 s, riêng SWC 115,4 ms. Task 21 (138 file): 1,444–1,469 s qua 3 lần, riêng SWC 120–147 ms | Đạt |
| Type-check TS7 (`pnpm typecheck`) | < 15 s (§13.2) | Task 1: 0,857 s. Task 21: 1,02–2,14 s qua 3 lần | Đạt |
| Build image có cache, chỉ sửa code | < 2 phút (§13.2) | Task 19: 14 s. Task 21: 15,0 s (sửa một dòng trong `src/`, `docker build` với cache) | Đạt |
| Build image không cache (`docker build --no-cache`) | Spec không đặt mục tiêu | Task 21: 27,6 s. Base image đã có sẵn trên máy; cache mount của pnpm store rỗng nên `pnpm fetch` tải lại đủ 786 package | Không có mục tiêu để so |
| Build lạnh, gồm pull base image | Spec không đặt mục tiêu | Task 19: 41 s | Không có mục tiêu để so |
| Kích thước image chưa nén | ≤ 200 MB (§13.3) | Task 19: 284 MB. Task 21: 284 MB (tổng layer `docker history`; base distroless 159 MB, `node_modules` 123 MB, `dist` 1,6 MB); nén 71,5 MB | **KHÔNG ĐẠT: 284 MB so với ≤ 200 MB (vượt 84 MB)** |
| API khởi động tới `/health/ready` 200, OTel tắt | < 3 s (§13.3) | Task 21: 1,86–1,90 s qua 3 lần. Task 19 chỉ đo tới log listening: 1,39 s (1,57 s khi worker khởi động song song) | Đạt |
| Worker khởi động tới `/health/ready` 200 | < 3 s (§13.3) | Task 21: 1,66–1,69 s qua 3 lần (cận trên, xem cách đo). Task 19 tới health server listening: 1,50 s | Đạt |
| API khởi động tới `/health/ready` 200, OTel bật (cấu hình production) | < 3 s (§13.3) | Task 21: 2,52–3,33 s qua 6 lần (trung vị 2,88 s; 1/6 lần vượt 3 s). Task 19 tới log listening: 3,13 s | **KHÔNG ĐẠT ổn định: sát ngưỡng 3 s, vượt ở 1/6 lần đo Task 21 (3,33 s) và ở phép đo Task 19 (3,13 s)** |

Cách đo trong Task 21:

- Build và type-check: `time pnpm build` sau `rm -rf dist`, `time pnpm typecheck`, mỗi lệnh 3 lần.
- Image: `docker build --no-cache` rồi `docker build` sau khi thêm một dòng comment vào `src/app.modules.ts` (đã hoàn nguyên), cùng `--build-arg` từ `docker/images.env`. Kích thước: `docker history` (tổng layer) và `docker image ls` (content size).
- Khởi động: stack `docker compose … --profile app up -d --build`, rồi `docker stop` và đo từ lúc gọi `docker start` tới response 200 đầu tiên của `/health/ready`. API: poll từ host qua cổng đã map, 50 ms một lần. Worker không map cổng ra host nên poll bằng `docker exec … node -e fetch(…)`; mỗi lần probe tốn 170–215 ms, nên số của worker là cận trên. API bật OTel: container cùng image và env với service `api`, chỉ thêm `OTEL_ENABLED=true` và endpoint tới collector của profile `observability`.
- Mọi số khởi động gồm cả chi phí của `docker start`, nên hơi cao hơn thời gian thực của process.

ADR cũ ghi baseline Task 1 là 1,434 s/0,820 s, từ một lượt đo khác trong cùng spike; bảng dùng 1,464 s/0,857 s của mục "Commands run and real output" trong báo cáo Task 1.

## Số đo image sau khi thêm package SP2 (spike S6, 2026-09-27)

Cùng máy Docker Desktop/WSL2/amd64, cùng `--build-arg` từ `docker/images.env`. Hai image đo trong cùng một lượt: baseline dựng lại từ commit `8ff2a21` (trước Task 1 của SP2; `git archive --format=tar -o <tar> 8ff2a21` rồi `docker build … - < <tar>`), và cây SP2 sau Task 1 (package SP2) cộng template spike của S6.

| Chỉ số | SP1 (`8ff2a21`) | SP2 sau Task 1 | Chênh |
| --- | --- | --- | --- |
| Layer `node_modules` (`docker history`) | 123 MB | 229 MB | +106 MB |
| Layer `dist` | 1,7 MB | 1,72 MB | ~0 |
| Tổng layer chưa nén (base distroless 159 MB + app) | ~284 MB | ~390 MB (trước S2-R5, xem dưới) | +106 MB |
| Content size nén (`docker images`) | 71,5 MB | 94,7 MB | +23,2 MB |

Chia phần tăng theo thư mục `node_modules/.pnpm` (tổng byte file, bỏ symlink, đo bằng script Node chạy trong container): 357 → 610 thư mục, 75,6 → 152,7 MB (+77,0 MB). Phân nhóm theo tên package:

- **Chuỗi `vitest` ~37,9 MB**, lớn nhất là `@rolldown/binding-linux-x64-gnu` 19,1 MB, `lightningcss-linux-x64-gnu` 10,0 MB, `vitest` 2,3 MB, `vite` 2,2 MB. Nguồn: `better-auth@1.7.6` khai `vitest` là **peer tuỳ chọn** (`peerDependenciesMeta.vitest.optional = true`); vì `vitest` có trong devDependencies ở gốc, pnpm nối peer đó và `prune --prod` giữ nó lại (`pnpm why vitest --prod` → `better-auth@1.7.6`).
- Chuỗi `mjml` ~22 MB, gồm các dependency của `mjml-core`: `htmlnano`, `cssnano`, `svgo`, `uglify-js`, `js-beautify`, `cheerio`, `juice`, `css-tree`, `caniuse-lite`. Riêng các package `mjml*` chỉ 0,5 MB.
- `handlebars` 3,7 MB, nhóm Better Auth (`better-auth`, `@better-auth/*`, `kysely`, `jose`, …) 3,9 MB, `@bull-board/*` + `express` 3,5 MB, `nodemailer` 1,2 MB, còn lại 4,9 MB.

Đánh giá: mục tiêu ≤ 200 MB (§13.3) đã không đạt từ SP1 (284 MB), nay vượt thêm (~390 MB, số đo spike S6 ở trên, TRƯỚC khi loại `vitest`). Phương án `mjml-core` + `mjml-preset-core` thay cho `mjml` chỉ bỏ được `mjml-cli` và vài package nhỏ, vì phần nặng là dependency của chính `mjml-core`; phương án này không giảm đáng kể. Phần lớn nhất (~38 MB) là peer `vitest` bị kéo vào image production. Việc loại nó ra đã chốt và thực hiện xong ở Task 17 (ruling S2-R5): hook `readPackage` của `.pnpmfile.mjs` bỏ peer tuỳ chọn `vitest` khỏi manifest của `better-auth` trước khi pnpm resolve, nên `pnpm prune --prod`/`pnpm why vitest --prod` không còn kéo chuỗi vitest/vite/rolldown vào image production. Số đo image cuối cùng (kích thước nén/chưa nén sau S2-R5, thời gian khởi động) được ghi ở Task 50. Chi tiết S6 ở ADR 0010.

### Số đo SP2 (2026-09-27)

Đo ở Task 50 (2026-09-28) trên HEAD của nhánh SP2, cùng máy Docker Desktop 29.7.2/WSL2/amd64 (storage driver `overlayfs`, containerd snapshotter), cùng `--build-arg` từ `docker/images.env`. Cột SP1 lấy từ bảng Task 21 ở trên và từ cây `8ff2a21` (số test).

| Chỉ số | SP1 | SP2 | Ghi chú |
|---|---|---|---|
| Kích thước image | 284 MB chưa nén; 71,5 MB nén | 352 MB chưa nén; 81,2 MB nén | better-auth, mjml, nodemailer, bull-board. Chưa nén = tổng layer `docker history` (base distroless 159,3 MB, `node_modules` 189 MB so với 123 MB của SP1, `dist` 3,78 MB). Nén = `docker image inspect --format '{{.Size}}'` (81 189 406 byte): với containerd snapshotter lệnh này trả kích thước nội dung nén, không phải chưa nén. Mốc cũ ≤ 200 MB không đạt. **ĐẠT mốc mới ≤ 400 MB chưa nén, còn dư 48 MB** (§13.3, Sếp đổi mốc ngày 2026-09-28) |
| api + worker tới healthy (compose, TLS, production) | Không có (SP1 chưa có smoke) | 11 552 / 11 544 / 11 660 ms (3 lần `pnpm test:smoke`, dòng `smoke_startup_ms`) | Đo `up -d --wait` của api + worker. Là cận trên bị lượng tử hoá: healthcheck của compose có `interval: 10s`, Docker chạy lần kiểm đầu tiên sau một `interval`, nên số này gần bằng 10 s cộng lần probe, không phải thời gian boot |
| Boot của process (`State.StartedAt` tới dòng log hoàn tất boot, OTel tắt, api và worker khởi động song song) | api 1,57 s, worker 1,50 s (Task 19, tới listening) | api 2,63 / 2,47 s, worker 2,79 / 2,71 s (lần smoke 2 và 3) | Mốc api là log `Nest application successfully started`, worker là `worker health server listening`; cả hai mốc cùng đồng hồ VM Docker. Đây là mốc listening, không phải `/health/ready` 200 đầu tiên (chỉ số của §13.3), nên chưa kết luận đạt < 3 s: còn dưới 3 s nhưng sát ngưỡng |
| `/health/ready` 200 đầu tiên (đúng chỉ số §13.3), OTel tắt (2026-09-28) | Không có | Task 50: api 2 232 / 2 553 / 2 499 ms, worker 2 385 / 2 740 / 2 451 ms. Sau khi sửa loader (commit `0f9afdf`): api 2 466 / 2 519 / 2 405 ms, worker 2 648 / 2 736 / 2 459 ms (3 lần) | Hạ tầng (postgres/redis/mailpit/pgbouncer, đã migrate) dựng một lần bằng đúng các bước của `smoke.global-setup.ts` (image production, `--profile app`, `NODE_ENV=production`, TLS) và giữ healthy; mỗi lần đo chỉ `up -d --force-recreate --no-deps --no-build api worker` (StartedAt mới), không dùng `--wait` (tránh lượng tử hoá `interval: 10s` của dòng trên). Poll `/health/ready` mỗi 50 ms bằng `fetch` chạy ngay trong container đó (`docker exec ... node -e`, image distroless không có curl/wget) nên cùng đồng hồ VM Docker với `docker inspect .State.StartedAt` — không lệch đồng hồ host/VM. Sửa loader không đổi đường OTel tắt (hook chỉ đăng ký khi bật OTel), số mới nằm trong dải cũ. Cả 12 số đều **ĐẠT mục tiêu < 3 s (§13.3)**, biên còn 250–600 ms |
| `/health/ready` 200 đầu tiên, OTel bật (`OTEL_ENABLED=true`, xuất OTLP tới service `otel-collector` cùng mạng compose, profile `observability`) (2026-09-28) | Không có | Trước khi sửa: api 4 506 / 4 375 / 4 442 ms, worker 4 198 / 4 655 / 4 433 ms (Task 50); đo lại ngay trước khi sửa: api 4 417 / 4 302 / 4 090 ms, worker 4 377 / 4 311 / 4 172 ms. **Sau khi sửa (commit `0f9afdf`): api 2 628 / 2 938 / 2 740 ms, worker 2 786 / 2 908 / 2 893 ms** (3 lần, cùng phương pháp và cùng hạ tầng ở trên) | Nguyên nhân: hook `import-in-the-middle` đăng ký bằng `module.register` chạy trên loader thread riêng, mỗi lần resolve/load module (kể cả module không bị bọc) tốn một vòng IPC. SP2 kéo số module app nạp lên ~3 950 (better-auth, kysely, mjml, bull-board, …), nên phí này thành ~1 s. Bằng chứng (Windows, `dist/`, import `app-api.module.js`, 3 lần mỗi biến thể): không hook 2,01–2,16 s; chỉ loader 3,08–3,14 s; chỉ SDK + require-in-the-middle 2,06–2,32 s; cả hai 3,06–3,20 s. Sửa: `register()` đồng bộ của `import-in-the-middle/register-hooks.mjs` (`module.registerHooks`, chạy trên thread của app, cần Node ≥ 24.11.1; image chạy 24.21.0) với `include` = tên module của các instrumentation đang bật, đúng tập mà kênh message cũ gửi. Phạm vi trace không đổi: cùng một luồng sign-up, sample 100 %, collector `debug` detailed cho cùng số span theo scope trước và sau sửa (http 7, express 39, router 51, pg 81, ioredis 4, better-auth 13, core 4, identity 1, notifications 3); log pino vẫn có `trace_id`. Cả 6 số **ĐẠT mục tiêu < 3 s**, nhưng biên mỏng (60–370 ms). Phần chênh còn lại so với OTel tắt (~0,2–0,4 s) là `sdk.start()` và hook require-in-the-middle của 37 instrumentation; giảm tiếp cần thay `auto-instrumentations-node` bằng các package instrumentation riêng (http, express, pg, ioredis, pino), là thay đổi dependency, chưa làm |
| Số test (unit / integration / chaos / smoke) | 296 / 211 / 7 / 0 (40 / 31 / 3 / 0 file) | 1005 / 812 / 16 / 36 (95 / 89 / 6 / 3 file) | SP1: `pnpm test` và `vitest list` trên cây `8ff2a21`. SP2: số của các lần chạy xanh ở Task 50 |

### Số đo SP3 (3A) (2026-09-29)

Đo sau `pnpm test:smoke` xanh của Task 29 trên HEAD nhánh `sp3-tenancy`, cùng máy và phương pháp với dòng SP2 (tổng layer `docker history`; nén = `docker image inspect --format '{{.Size}}'` với containerd snapshotter). 3A là plan duy nhất của SP3 thêm dependency (`@casl/ability` 7.0.1, kéo `@ucast/mongo2js` và `@ucast/*`); 3B/3C/3D chỉ ghi lại khi chênh > 1 MB, plan merge sau cùng ghi dòng "SP3 (cuối)" (spec SP3 §18.4).

| Chỉ số | SP2 | SP3 (3A) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 352 MB | 353,2 MB | +1,2 MB |
| Image nén | 81,2 MB | 81,4 MB | +0,2 MB |
| `@casl/ability` + `@ucast/*` trong `node_modules/.pnpm` | — | 0,14 MB | — |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT, dư 48 MB | ĐẠT, dư 46,8 MB | |

### Số đo SP7 (7A) (2026-09-29)

Đo sau `pnpm test:smoke` xanh của Task 12 trên HEAD nhánh làm việc của plan 7A (image `nestjs-saas-boilerplate:nsb-smoke-7a`), cùng máy và phương pháp với dòng SP3 (3A). 7A không thêm dependency; thay đổi là composition (`src/boilerplate.modules.ts`), công cụ upstream (`tools/upstream/`, không nằm trong image theo `.dockerignore`: `existsSync('tools')` trong container in `false`) và tài liệu.

| Chỉ số | SP3 (3A) | SP7 (7A) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 353,2 MB | 353,2 MB | 0 MB |
| Image nén | 81,4 MB | 81,4 MB (81 400 035 byte) | 0 MB |
| Mốc ≤ 400 MB chưa nén (§13.3) | | ĐẠT, dư 46,8 MB | |

### Số đo SP6 (6.0) (2026-09-29)

Đo sau `pnpm test:smoke` xanh của Task 14 plan 6.0 (image `nestjs-saas-boilerplate:nsb-smoke-sp60`, project smoke riêng vì các plan chạy song song), cùng máy và phương pháp với các dòng trước (tổng layer `docker history`; nén = `docker image inspect --format '{{.Size}}'` với containerd snapshotter, 81 482 046 byte). 6.0 thêm `@openfeature/server-sdk` 1.23.0 và peer `@openfeature/core` 1.12.0; 6A, 6C ghi dòng riêng khi thêm package (spec SP6 §3.1).

| Chỉ số | SP7 (7A) (dòng mới nhất) | SP6 (6.0) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 353,2 MB | 354,5 MB | +1,3 MB |
| Image nén | 81,4 MB | 81,5 MB | +0,1 MB |
| `@openfeature/*` trong `node_modules/.pnpm` | — | 0,22 MB | — |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT | ĐẠT, dư 45,5 MB | |

### Số đo SP4 (4A) (2026-10-01)

Đo sau `pnpm test:smoke` xanh của Task 13 (plan 4A), cùng máy và phương pháp với dòng SP3 (3A). 4A không thêm package (spec SP4 tiêu chí 12): `package.json` và `pnpm-lock.yaml` không đổi so với `main`.

| Chỉ số | SP3 (3A) | SP4 (4A) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 353,2 MB | 353,7 MB | +0,5 MB |
| Image nén | 81,4 MB | 81,5 MB | +0,1 MB |
| Inventory route entitlements lúc boot (`entitlements_route_inventory.durationMs`, smoke) | — | 0 ms | mốc < 50 ms (spec §20.4) |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT | ĐẠT, dư 46,3 MB | |

### Số đo SP3 (3C) (2026-10-01)

Đo sau `pnpm test:smoke` xanh của Task 16 plan 3C (image `nestjs-saas-boilerplate:nsb-smoke`), cùng máy và phương pháp với dòng SP4 (4A) (tổng layer `docker history`; nén = `docker image inspect --format '{{.Size}}'`, 81 666 618 byte). 3C không thêm package: `package.json` và `pnpm-lock.yaml` không đổi so với `main`. Chênh chưa nén vượt 1 MB nên ghi dòng này: layer `dist` tăng 5,44 → 6,52 MB (code, hai migration và hai template của 3C); layer `node_modules` hiển thị 189 → 190 MB với cùng lockfile (làm tròn của `docker history`, không có package mới).

| Chỉ số | SP4 (4A) (dòng mới nhất) | SP3 (3C) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 353,7 MB | 355,8 MB | +2,1 MB |
| Image nén | 81,5 MB | 81,7 MB | +0,2 MB |
| Layer `dist` | 5,44 MB | 6,52 MB | +1,08 MB |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT | ĐẠT, dư 44,2 MB | |

## Phương án đã loại

CommonJS không cần thiết vì spike ESM đạt. Một bản TS7 duy nhất không đáp ứng compiler API của tool. Bundle image bị loại bởi spec; build bằng Debian khác runtime tăng rủi ro native binary. Không dùng cache do PR kiểm soát cho release.

## Hệ quả

Phải giữ build, type-check và test là gate riêng. Lint không format docs/adr tự động. Các mục tiêu chưa đạt được ghi rõ trong bảng số đo; tối ưu dependency hoặc đổi ngân sách là quyết định riêng, không thực hiện trong task tài liệu. Helm và admission xác minh chữ ký thuộc SP7.

## Nguồn

Spec cha §13; spec SP1 §3–4 và phần Docker/CI; báo cáo Task 1, 2, 5, 12, 19 (gồm vòng sửa 1), 20; R1, R5, R7–R8, R24 trong ledger. [Spec cha](../superpowers/specs/2026-09-24-saas-core-architecture-design.md).
