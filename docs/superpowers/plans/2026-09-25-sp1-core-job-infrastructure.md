# Sub-project 1 — Core + hạ tầng job: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng `core/` của boilerplate NestJS: config, context, DB + UnitOfWork + RLS, outbox/inbox, event, queue, scheduler, HTTP (lỗi, phân trang, ETag, Merge Patch, idempotency, rate limit), HTTP client chống SSRF, mã hoá field, observability, health. Có 3 entrypoint, Docker và CI. Mọi thứ phải được chứng minh bằng test chạy trên Postgres, PgBouncer và Redis thật.

**Architecture:** Modular monolith, một image, ba vai trò (api, worker, migrate). Các thành phần trong `core/` là Nest module, chỉ lộ API qua `index.ts`. Code ngoài `core/database` và `infra/` không biết MikroORM. Code ngoài `core/queue` không biết BullMQ. Event đi theo đường outbox trong Postgres → relay → BullMQ → fan-out → subscriber có inbox chống trùng. Hai connection DB: `app` (role `app_user`, bị RLS) và `relay` (role `app_relay`, không BYPASSRLS, chỉ có quyền trên bảng hạ tầng; chỉ tạo trong worker và migrate).

**Tech Stack:** NestJS 12 (ESM, Express), MikroORM 7.2 (PostgreSQL), BullMQ 6 + ioredis, zod 4, nestjs-cls, nestjs-pino, OpenTelemetry, @nestjs/throttler + rate-limiter-flexible, @node-idempotency/core, undici + ipaddr.js, cockatiel, @nestjs/terminus, @nestjs/swagger, Vitest + unplugin-swc, Testcontainers, dependency-cruiser, oxlint, pnpm, SWC, TypeScript 7 (type-check) + 6 (tool API).

**Spec:** `docs/superpowers/specs/2026-09-24-sp1-core-job-infrastructure-design.md` (spec cha: `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`). Review trước thực thi: `docs/superpowers/reviews/2026-09-25-sp1-pre-execution-review.md`.

## Global Constraints

- **Cấm hard code:** giá trị tuỳ chỉnh (timeout, TTL, giới hạn, batch, cron, retention, URL, origin, port) chỉ khai báo trong config schema zod của module sở hữu, mỗi giá trị có env var. Secret không có giá trị mặc định. Định danh (tên queue, event, job, mã lỗi, tên biến session DB) là hằng số có tên, nằm trong registry hoặc file hằng số của module.
- **Cấm tự chọn version:** cài bằng `pnpm add <tên>` không ghi version (lấy bản latest đã publish ít nhất 1 ngày, nhờ `minimumReleaseAge`). Bật save-exact bằng lệnh. Trước khi cài chạy `pnpm view <tên> dist-tags peerDependencies`. Bản latest không tương thích thì dừng lại, ghi ADR kèm output của lệnh, và báo Sếp. Docker image và GitHub Action pin theo digest/SHA lấy bằng lệnh.
- **Chống package bị chiếm quyền:** pnpm `minimumReleaseAge` = 1440 phút, Renovate `minimumReleaseAge: "3 days"`. Chỉ cho phép build script của `@swc/core`, `msgpackr-extract`, `protobufjs`. Chặn `@scarf/scarf`. Cả cây chỉ có **một** major của `ioredis` (pnpm `overrides`).
- **Ưu tiên có sẵn:** tính năng của framework/thư viện đang dùng → package npm được bảo trì tốt → chỉ tự viết khi không có lựa chọn đạt, kèm ADR liệt kê ứng viên đã loại.
- **Dùng CLI có sẵn:** `nest new`, `nest g module|service|controller|interceptor|filter|guard`, `pnpm init/add`, `mikro-orm migration:create`, `depcruise --init`, `oxlint --init`. Chỉ viết tay những file không có generator. Không đoán flag: đọc `--help` hoặc tài liệu trước khi dùng.
- **Node:** 24 LTS. **Module:** ESM, import nội bộ có đuôi `.js`.
- **Layout build (chốt):** mọi thứ chạy ở runtime nằm trong `src/` — gồm `src/migrations/<module>/` và `src/scripts/`. `nest build` (SWC, `sourceRoot: src`) ra `dist/main.api.js`, `dist/main.worker.js`, `dist/main.migrate.js`, `dist/migrations/**`, `dist/scripts/**`. Migration fixture chỉ dùng cho test nằm ở `test/fixtures/migrations/`, được nạp qua `import.meta.glob` và chạy bằng bảng theo dõi riêng `mikro_orm_migrations_fixtures`.
- **Import boundaries:** `@mikro-orm/*` chỉ trong `src/core/database/**` và `**/infra/**`. `bullmq` chỉ trong `src/core/queue/**`. `express`, `@nestjs/platform-express` chỉ trong `src/core/http/**`. `@nestjs/throttler`, `rate-limiter-flexible`, `@node-idempotency/*`, `undici`, `ipaddr.js` chỉ trong `src/core/http/**` hoặc `src/core/resilience/**` (undici, ipaddr.js).
- **DB:** PK `BIGINT GENERATED ALWAYS AS IDENTITY`, thời gian `TIMESTAMPTZ`, bảng nào cũng có `created_at`/`updated_at`, index nào cũng có query dùng nó. Quyền cấp **theo từng bảng trong migration**, không dùng `ALTER DEFAULT PRIVILEGES`. Bảng có `org_id` phải bật RLS + FORCE với policy dùng `app_current_org()`.
- **Truy cập SQL:** luôn qua `Db.execute` (connection `app`, tự gắn transaction và session RLS hiện tại) hoặc `RelayDb` (connection `relay`). Không bao giờ dùng `getConnection().execute`.
- **Lỗi:** không nuốt lỗi, không trả giá trị sai trong im lặng. Lỗi không lường trước thì log đủ ở server (đã lọc SQL/params), client nhận problem+json `500 internal_error`.
- **Không cast mù:** không `as never`, không `any`. Chỗ cần thu hẹp kiểu dùng type guard hoặc validate bằng zod.
- **Commit:** mỗi task một commit trở lên, message dạng conventional. Không push khi chưa có lệnh.

## Review Focus

1. **Truy vấn bảng tenant ngoài `OrgScope`, hoặc `OrgScope` lồng trong transaction của org khác:** phải báo lỗi (fail-closed), không bao giờ trả dữ liệu của org khác hay chạy không có tenant. Test ở Task 7 (`fails closed without org context`, `rejects nested scope with a different org`, `reused pooled connection still fails closed`).
2. **Hai relay chạy song song và lỗi giữa enqueue và commit, với batch nhỏ hơn số dòng:** không dòng nào bị gửi hai lần, subscriber chỉ chạy một lần. Test ở Task 9 (`concurrent relays with small batch`, `enqueue-then-commit-failure`).
3. **Idempotency: hai principal khác nhau dùng cùng key, request trùng đồng thời, và request lỗi được gửi lại:** không bao giờ trả response của principal khác; request trùng đang chạy nhận `409`; request lỗi được trả lại đúng lỗi cũ. Test ở Task 13.
4. **HTTP client gọi ra ngoài tới địa chỉ nội bộ bằng mọi biến thể (IP literal, IPv4-mapped IPv6, tên miền resolve ra IP private, redirect):** bị chặn trước khi mở kết nối. Test ở Task 15.
5. **Worker nhận SIGTERM hoặc bị kill giữa job:** SIGTERM thì job đang chạy hoàn tất rồi process mới thoát; bị kill thì job được giao lại và hiệu ứng chỉ commit một lần. Test ở Task 18 và Task 19, đều dùng process con thật.

---

## File Structure

```
src/
  main.api.ts · main.worker.ts · main.migrate.ts · instrumentation.ts · shutdown.ts
  app-api.module.ts · app-worker.module.ts · app.modules.ts
  core/
    config/        define-config.ts · config.registry.ts · env-example.ts · validate-all.ts · app.config.ts · dev-infra.config.ts · all-configs.ts · index.ts
    errors/        error-codes.ts · app-error.ts · error-mappers.ts · zod-issues.ts · errors.config.ts · problem-details.filter.ts · index.ts
    context/       context.keys.ts · principal.ts · request-context.ts · context.module.ts · index.ts
    logging/       logging.config.ts · redaction.ts · logging.module.ts · index.ts
    database/      database.config.ts · constants.ts · entities.ts · tx-em.ts · unit-of-work.ts · mikro-orm-unit-of-work.ts
                   db.ts · relay-db.ts · org-scope.ts · db-error.mapper.ts · migrator.ts · database.module.ts · index.ts
    redis/         redis.config.ts · redis.module.ts · index.ts
    queue/         queue.config.ts · job-definition.ts · job-context.ts · job-handler.decorator.ts · job-queue.ts
                   bullmq-job-queue.ts · bullmq-job-scheduler.ts · core-queues.ts · worker-host.ts · queue.module.ts · index.ts
    outbox/        outbox.config.ts · outbox.jobs.ts · outbox.writer.ts · outbox.relay.ts · inbox.ts · safe-enqueue.ts
                   outbox-cleanup.handler.ts · outbox.module.ts · index.ts
    events/        event-definition.ts · envelope.ts · subscriber.decorator.ts · event-publisher.ts · event-dispatch.handlers.ts · events.module.ts · index.ts
    scheduler/     scheduler.config.ts · cron-definition.ts · static-scheduler.ts · scheduled-task.service.ts
                   schedule-reconciler.ts · scheduler.jobs.ts · scheduler.module.ts · index.ts
    http/          http.config.ts · trust-proxy.ts · pagination.config.ts · pagination.ts · response.ts · conditional.ts
                   content-type.middleware.ts · api-problems.decorator.ts · http-bootstrap.ts · openapi.ts
                   throttle.config.ts · rate-limiter.storage.ts · app-throttler.guard.ts
                   idempotency.config.ts · idempotency.storage.ts · idempotency.interceptor.ts · idempotency.decorator.ts
                   http.module.ts · index.ts
    resilience/    resilience.config.ts · policies.ts · policies.service.ts · ssrf-guard.ts · http-client.ts · resilience.module.ts · index.ts
    security/      security.config.ts · field-cipher.ts · security.module.ts · index.ts
    observability/ otel.config.ts · telemetry-lifecycle.ts · trace-propagation.ts · metrics.ts · observability.module.ts · index.ts
    health/        health.config.ts · draining.ts · readiness.ts · health.controller.ts · shutdown-coordinator.ts · worker-health.server.ts · health.module.ts · index.ts
  migrations/core/                       migration của core (tạo bằng CLI)
  scripts/        gen-env-example.ts · export-openapi.ts
docker/images.env                        image + digest dùng chung cho compose và test
docker/postgres/init/01-roles.sh         tạo role, timeout theo role, lc_messages
compose.yaml · Dockerfile · .dockerignore · .swcrc · vitest.config.ts · .dependency-cruiser.cjs · pnpm-workspace.yaml · openapi.json
test/
  support/ images.ts · infra.global-setup.ts · infra.ts · migrate-test-db.ts · env.ts · db.ts · app-factory.ts · test-principal.middleware.ts · worker-entry.ts · spawn-worker.ts
  fixtures/ fixture.entity.ts · fixture.module.ts · fixture.jobs.ts · fixture.events.ts · fixture.controller.ts · process.jobs.ts · migrations/
  unit/ …   integration/ …   e2e/ …   chaos/ …   architecture/ …
docs/adr/  0001…0014
.github/workflows/ ci.yml · release.yml · nightly.yml
renovate.json
```

Cache (`core/cache`) **không có trong SP1** (xem Task 14).

### Task 1: Scaffold bằng CLI + spike build (S1, S2, S3, S6) + chính sách package

**Files:**
- Create (bằng CLI): toàn bộ khung do `nest new` sinh ra, `pnpm-workspace.yaml` (do lệnh `pnpm config set --location project` tạo/ghi)
- Create (viết tay, không có generator): `.swcrc`, `vitest.config.ts`, `test/unit/di-metadata.spec.ts`, `docs/adr/0013-build-toolchain.md`
- Modify: `nest-cli.json`, `package.json` (scripts), `tsconfig.json`

**Interfaces:**
- Consumes: không có
- Produces: các script `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:int`, `pnpm lint`, `pnpm start:dev`. ESM + SWC hoạt động. Vitest chạy được test có DI. Cài package tuân thủ `minimumReleaseAge` và allowlist build script.

- [ ] **Step 1: Kiểm tra công cụ trên máy**

Run:
```bash
node --version
corepack --version
pnpm --version
pnpm view @nestjs/cli dist-tags
pnpm view typescript dist-tags
pnpm view @typescript/typescript6 dist-tags
```
Expected: Node thuộc dòng 24 LTS (xem cột `lts` ở `https://nodejs.org/dist/index.json`). Nếu không phải thì dừng lại, báo Sếp. Ghi output vào nháp ADR 0013.

- [ ] **Step 2: Đọc flag của `nest new` và cấu hình của pnpm**

Run:
```bash
pnpm dlx @nestjs/cli@latest new --help
pnpm help config
```
Ghi tên flag thật vào ADR 0013. Từ tài liệu pnpm của version đang cài (`https://pnpm.io/settings`), xác định tên chính xác của các setting: `minimumReleaseAge`, `onlyBuiltDependencies` (hoặc tên mới), `overrides`, và file mà `pnpm config set --location project` ghi vào (`pnpm-workspace.yaml` hay `.npmrc`).

- [ ] **Step 3: Tạo project**

Repo đã có `.git` và `docs/`. Nếu `nest new` không cho sinh vào thư mục không rỗng thì sinh vào thư mục tạm cùng cấp rồi chuyển vào:
```bash
cd D:/
pnpm dlx @nestjs/cli@latest new backend-demo-scaffold <flag pnpm> <flag strict> <flag bỏ git>
# Chọn ESM khi được hỏi
cp -rn backend-demo-scaffold/. backend-demo/
rm -rf backend-demo-scaffold
cd D:/backend-demo
```
`dlx …@latest` chỉ dùng cho lần scaffold này. Sau đó `@nestjs/cli` là devDependency pin chính xác trong lockfile.

- [ ] **Step 4: Chính sách cài package (trước mọi `pnpm add` khác)**

Dùng đúng tên setting đã xác định ở Step 2:
```bash
pnpm config set save-exact true --location project
pnpm config set minimum-release-age 1440 --location project
```
Mở file project mà pnpm vừa ghi (`pnpm-workspace.yaml` với pnpm ≥ 10), thêm allowlist build script theo đúng khoá của tài liệu pnpm:
```yaml
onlyBuiltDependencies:
  - "@swc/core"
  - msgpackr-extract
  - protobufjs
```
(`@scarf/scarf` và mọi package khác bị chặn chạy script.) Chạy `pnpm install`.
Expected: `pnpm start` khởi động, `curl http://localhost:3000` trả `Hello World!`. `pnpm install` không chạy script nào ngoài allowlist.

- [ ] **Step 5: Chuyển builder sang SWC (S1)**

Run: `pnpm view @swc/core dist-tags && pnpm add -D @swc/cli @swc/core`

Sửa `nest-cli.json` (file do CLI sinh), trong `compilerOptions` thêm:
```json
"builder": "swc",
"typeCheck": false
```
Đảm bảo `"sourceRoot": "src"` (để `dist/main.api.js`, `dist/migrations/**`, `dist/scripts/**` nằm đúng layout ở Global Constraints).

Tạo `.swcrc`:
```json
{
  "$schema": "https://swc.rs/schema.json",
  "sourceMaps": true,
  "jsc": {
    "parser": { "syntax": "typescript", "decorators": true, "dynamicImport": true },
    "transform": { "legacyDecorator": true, "decoratorMetadata": true },
    "keepClassNames": true,
    "target": "es2022"
  },
  "module": { "type": "es6", "resolveFully": true }
}
```
Verify: đối chiếu các key với `https://swc.rs/docs/configuration/compilation` và `https://docs.nestjs.com/recipes/swc`. Key nào không có trong tài liệu thì bỏ.

Run: `pnpm build && node dist/main.js`
Expected: app khởi động. Nếu lỗi resolve ESM thì tạo lại với CommonJS, ghi lý do vào ADR 0013 và báo Sếp trước khi đi tiếp.

- [ ] **Step 6: TS 7 để type-check, TS 6 cho tool cần API (S2)**

Run: `pnpm list typescript`
- Nếu `typescript` đang là 7.x: `pnpm add -D typescript@npm:@typescript/typescript6`. Ghi ngoại lệ version vào ADR 0013 (TS 7 chưa có compiler API; `@swc-node/register` và dependency-cruiser cần TS 6).
- Cài TS 7 dưới alias: `pnpm add -D ts7@npm:typescript@latest`

`package.json`:
```json
"typecheck": "node node_modules/ts7/bin/tsc --noEmit -p tsconfig.json"
```
Sửa `tsconfig.json` theo TS 7: bỏ `baseUrl`, `"module": "nodenext"`, `"moduleResolution": "nodenext"`, giữ `"experimentalDecorators": true`, `"emitDecoratorMetadata": true`, `"strict": true`, `"noUncheckedIndexedAccess": true`. `include` gồm `src`, `test`.

Run: `pnpm typecheck && pnpm build`
Expected: cả hai thành công.

- [ ] **Step 7: Vitest, loader TS cho script và process con**

Run:
```bash
pnpm view vitest dist-tags && pnpm view unplugin-swc dist-tags peerDependencies && pnpm view @swc-node/register dist-tags peerDependencies
pnpm remove jest ts-jest @types/jest @nestjs/testing
pnpm add -D vitest unplugin-swc @vitest/coverage-v8 @nestjs/testing supertest @types/supertest @swc-node/register
```
`@swc-node/register` luôn được cài: dùng cho `pnpm env:example` khi dev và cho process con trong test (Task 18, 19), vì type stripping của Node không chạy decorator và không map `.js` sang `.ts`.

Xoá khối `jest` trong `package.json`, `test/jest-e2e.json` và spec mẫu do CLI sinh.

`vitest.config.ts`:
```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.spec.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
          globalSetup: ['test/support/infra.global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
```
Verify: key `projects` đúng với tài liệu Vitest (`https://vitest.dev/guide/projects`). `testTimeout`/`hookTimeout` là tham số của bộ test, không phải config của app.

Scripts:
```json
"test": "vitest run --project unit",
"test:int": "vitest run --project integration",
"test:watch": "vitest --project unit"
```

- [ ] **Step 8: Test DI metadata (S3)**

`test/unit/di-metadata.spec.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class Dependency {}

@Injectable()
class Consumer {
  constructor(readonly dep: Dependency) {}
}

describe('SWC decorator metadata', () => {
  it('injects constructor dependencies by type', async () => {
    const mod = await Test.createTestingModule({ providers: [Dependency, Consumer] }).compile();
    expect(mod.get(Consumer).dep).toBeInstanceOf(Dependency);
  });
});
```
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 9: Lint và format**

Run: `pnpm list eslint oxlint prettier && pnpm view oxlint dist-tags`
Nếu CLI đã sinh ESLint thì gỡ ESLint và plugin (theo đúng tên trong `package.json`), xoá file config ESLint. Sau đó:
```bash
pnpm add -D oxlint
pnpm oxlint --init
```
Scripts: `"lint": "oxlint && prettier --check ."`, `"format": "prettier --write ."`
Run: `pnpm lint` → PASS.

- [ ] **Step 10: Đo baseline (S6) và viết ADR 0013**

Run (bash):
```bash
time pnpm build
time pnpm typecheck
node -e "const t=Date.now();import('./dist/main.js').then(()=>console.log('import ms',Date.now()-t))"
```
`docs/adr/0013-build-toolchain.md` (MADR): quyết định SWC + ESM + layout `src/` (migrations, scripts), TS 7 type-check + TS 6 alias, Vitest + unplugin-swc, oxlint, pnpm save-exact + `minimumReleaseAge` + allowlist build script. Bằng chứng: output Step 1, 2, 6 và số đo Step 10. Hệ quả: không dùng plugin Swagger của Nest CLI.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold nest project with swc, ts7 typecheck, vitest, oxlint and pnpm supply-chain policy"
```

---

### Task 2: Hạ tầng dev và test (Compose, DB role, PgBouncer, Testcontainers)

**Files:**
- Create: `docker/images.env`, `docker/postgres/init/01-roles.sh`, `compose.yaml`, `test/support/images.ts`, `test/support/infra.global-setup.ts`, `test/support/infra.ts`, `test/integration/infra/roles.spec.ts`, `.env.example` (tạm, Task 3 sinh tự động)

**Interfaces:**
- Consumes: script test của Task 1
- Produces:
  - `test/support/images.ts`: `readImages(): Record<string, string>`
  - `test/support/infra.ts`: `getInfra(): Infra` với `Infra = { pg: { host; port; database; owner: Creds; app: Creds; relay: Creds }; pgbouncer: { host; port }; redis: { url: string } }`, `Creds = { user: string; password: string }`
  - `docker/images.env`: `IMAGE_POSTGRES`, `IMAGE_REDIS`, `IMAGE_PGBOUNCER`
  - DB role: `app_owner` (chạy migration, sở hữu bảng), `app_user` (api/worker, bị RLS), `app_relay` (worker: relay/cleanup/reconcile/metrics, **không** BYPASSRLS, chỉ có quyền trên bảng hạ tầng được cấp trong migration)

- [ ] **Step 1: Lấy tag và digest image bằng lệnh**

Run:
```bash
curl -s "https://hub.docker.com/v2/repositories/library/postgres/tags?page_size=50&ordering=last_updated" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).results.map(t=>t.name).filter(n=>/^\d+(\.\d+)?$/.test(n)).join(' ')))"
curl -s "https://hub.docker.com/v2/repositories/library/redis/tags?page_size=50&ordering=last_updated" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).results.map(t=>t.name).filter(n=>/^\d+\.\d+\.\d+$/.test(n)).join(' ')))"
```
Chọn tag có version cao nhất. Lấy digest:
```bash
docker buildx imagetools inspect postgres:<tag> --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect redis:<tag> --format '{{json .Manifest.Digest}}'
```
PgBouncer không có image chính thức: đọc README các image cộng đồng còn cập nhật (ví dụ `edoburu/pgbouncer`), chọn một, lấy digest cùng cách, ghi lý do vào ADR 0006 ở Task 10.

`docker/images.env` (giá trị từ output lệnh):
```
IMAGE_POSTGRES=postgres:<tag>@sha256:<digest>
IMAGE_REDIS=redis:<tag>@sha256:<digest>
IMAGE_PGBOUNCER=<image>:<tag>@sha256:<digest>
```

- [ ] **Step 2: Script tạo role, timeout theo role, locale thông báo**

`docker/postgres/init/01-roles.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${APP_OWNER_PASSWORD:?required}" "${APP_USER_PASSWORD:?required}" "${APP_RELAY_PASSWORD:?required}"
: "${APP_USER_STATEMENT_TIMEOUT_MS:?required}" "${APP_RELAY_STATEMENT_TIMEOUT_MS:?required}" "${IDLE_IN_TX_TIMEOUT_MS:?required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$APP_OWNER_PASSWORD" -v user_pw="$APP_USER_PASSWORD" -v relay_pw="$APP_RELAY_PASSWORD" \
  -v user_stmt="${APP_USER_STATEMENT_TIMEOUT_MS}ms" -v relay_stmt="${APP_RELAY_STATEMENT_TIMEOUT_MS}ms" \
  -v idle_tx="${IDLE_IN_TX_TIMEOUT_MS}ms" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE;
CREATE ROLE app_user  LOGIN PASSWORD :'user_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE app_relay LOGIN PASSWORD :'relay_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
GRANT CONNECT ON DATABASE :"db" TO app_owner, app_user, app_relay;
GRANT CREATE, USAGE ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user, app_relay;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER ROLE app_user  SET statement_timeout = :'user_stmt';
ALTER ROLE app_relay SET statement_timeout = :'relay_stmt';
ALTER ROLE app_user  SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE app_relay SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER DATABASE :"db" SET lc_messages TO 'C';
SQL
```
Timeout đặt **trên role** để luôn có hiệu lực kể cả khi đi qua PgBouncer ở transaction mode (startup parameter bị PgBouncer bỏ). Worker cần timeout dài hơn thì `UnitOfWork` gọi `set_config('statement_timeout', …, true)` trong transaction (Task 5). Không có `ALTER DEFAULT PRIVILEGES`: mỗi migration tự `GRANT` theo bảng. Với production, DBA chạy đúng script này (ghi vào README ở Task 21).

- [ ] **Step 3: `compose.yaml` cho hạ tầng dev**

```yaml
name: backend-demo
services:
  postgres:
    image: ${IMAGE_POSTGRES}
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${POSTGRES_SUPERUSER}
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD}
      APP_OWNER_PASSWORD: ${DB_OWNER_PASSWORD}
      APP_USER_PASSWORD: ${DB_APP_PASSWORD}
      APP_RELAY_PASSWORD: ${DB_RELAY_PASSWORD}
      APP_USER_STATEMENT_TIMEOUT_MS: ${DB_APP_STATEMENT_TIMEOUT_MS}
      APP_RELAY_STATEMENT_TIMEOUT_MS: ${DB_RELAY_STATEMENT_TIMEOUT_MS}
      IDLE_IN_TX_TIMEOUT_MS: ${DB_IDLE_IN_TX_TIMEOUT_MS}
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - pgdata:/var/lib/postgresql
    ports: ["127.0.0.1:${DB_PORT_HOST}:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      retries: 20
  redis:
    image: ${IMAGE_REDIS}
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD}", "--maxmemory-policy", "noeviction"]
    ports: ["127.0.0.1:${REDIS_PORT_HOST}:6379"]
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$${REDIS_PASSWORD}\" ping"]
      interval: 5s
      retries: 20
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD}
  pgbouncer:
    image: ${IMAGE_PGBOUNCER}
    depends_on: { postgres: { condition: service_healthy } }
    ports: ["127.0.0.1:${PGBOUNCER_PORT_HOST}:5432"]
    environment:
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: ${DB_NAME}
      DB_USER: app_user
      DB_PASSWORD: ${DB_APP_PASSWORD}
      POOL_MODE: transaction
      AUTH_TYPE: scram-sha-256
volumes:
  pgdata: {}
```
Port chỉ bind `127.0.0.1`. Redis có mật khẩu và `noeviction` (bắt buộc cho BullMQ và idempotency). Connection `app` (role `app_user`) đi qua PgBouncer. Connection `relay` (ít kết nối, chỉ trong worker) nối thẳng Postgres. Tên biến môi trường PgBouncer ở trên là của `edoburu/pgbouncer`; nếu Step 1 chọn image khác thì đổi theo README của nó. Verify đường dẫn volume data đúng major Postgres đã chọn (README image chính thức).

`.env.example` tạm (Task 3 sẽ sinh tự động):
```
DB_NAME=app
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=
DB_OWNER_PASSWORD=
DB_APP_PASSWORD=
DB_RELAY_PASSWORD=
DB_APP_STATEMENT_TIMEOUT_MS=5000
DB_RELAY_STATEMENT_TIMEOUT_MS=60000
DB_IDLE_IN_TX_TIMEOUT_MS=10000
REDIS_PASSWORD=
DB_PORT_HOST=5432
REDIS_PORT_HOST=6379
PGBOUNCER_PORT_HOST=6432
```
Run: `cp .env.example .env`, điền mật khẩu, rồi `docker compose --env-file docker/images.env --env-file .env up -d && docker compose ps`
Expected: 3 service `healthy`/`running`.

- [ ] **Step 4: Test role đúng quyền (viết test trước)**

```bash
pnpm view @testcontainers/postgresql dist-tags && pnpm view @testcontainers/redis dist-tags && pnpm view testcontainers dist-tags
pnpm add -D @testcontainers/postgresql @testcontainers/redis testcontainers pg @types/pg
```
`test/integration/infra/roles.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra, type Creds } from '../../support/infra.js';

async function connect(creds: Creds, via: 'postgres' | 'pgbouncer' = 'postgres'): Promise<pg.Client> {
  const infra = getInfra();
  const target = via === 'postgres' ? infra.pg : infra.pgbouncer;
  const c = new pg.Client({ host: target.host, port: target.port, database: infra.pg.database, user: creds.user, password: creds.password });
  await c.connect();
  return c;
}

describe('database roles', () => {
  let app: pg.Client; let relay: pg.Client;
  beforeAll(async () => { app = await connect(getInfra().pg.app); relay = await connect(getInfra().pg.relay); });
  afterAll(async () => { await app.end(); await relay.end(); });

  it('app_user and app_relay are neither superuser nor BYPASSRLS', async () => {
    for (const c of [app, relay]) {
      const { rows } = await c.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    }
  });

  it('app_user cannot create tables', async () => {
    await expect(app.query('CREATE TABLE t_forbidden (id int)')).rejects.toThrow(/permission denied/);
  });

  it('role-level statement_timeout applies when connecting through PgBouncer', async () => {
    const viaBouncer = await connect(getInfra().pg.app, 'pgbouncer');
    try {
      const { rows } = await viaBouncer.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(rows[0]!.statement_timeout).not.toBe('0');
      await expect(viaBouncer.query('SELECT pg_sleep(30)')).rejects.toThrow(/statement timeout/);
    } finally {
      await viaBouncer.end();
    }
  });
});
```
Run: `pnpm test:int`
Expected: FAIL (chưa có `test/support/infra.ts`).

- [ ] **Step 5: Global setup của Testcontainers (Postgres + PgBouncer + Redis)**

`test/support/images.ts`:
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readImages(): Record<string, string> {
  const text = readFileSync(resolve('docker/images.env'), 'utf8');
  return Object.fromEntries(
    text.split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}
```
`test/support/infra.ts`:
```ts
import { inject } from 'vitest';

export type Creds = { user: string; password: string };
export type Infra = {
  pg: { host: string; port: number; database: string; owner: Creds; app: Creds; relay: Creds };
  pgbouncer: { host: string; port: number };
  redis: { url: string };
};

declare module 'vitest' {
  export interface ProvidedContext {
    infra: Infra;
  }
}

export function getInfra(): Infra {
  return inject('infra');
}
```
`test/support/infra.global-setup.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { readImages } from './images.js';

/** Tham số của bộ test (không phải config của app). */
const TEST_DB_TIMEOUTS = { userStatementMs: '5000', relayStatementMs: '60000', idleInTxMs: '10000' };
const PG_ALIAS = 'pg';
const secret = () => randomBytes(18).toString('base64url');

let network: StartedNetwork | undefined;
let pgC: StartedPostgreSqlContainer | undefined;
let bouncer: StartedTestContainer | undefined;
let redisC: StartedRedisContainer | undefined;

export async function setup(project: TestProject) {
  const images = readImages();
  const owner = { user: 'app_owner', password: secret() };
  const app = { user: 'app_user', password: secret() };
  const relay = { user: 'app_relay', password: secret() };
  network = await new Network().start();
  pgC = await new PostgreSqlContainer(images.IMAGE_POSTGRES!)
    .withNetwork(network)
    .withNetworkAliases(PG_ALIAS)
    .withEnvironment({
      APP_OWNER_PASSWORD: owner.password, APP_USER_PASSWORD: app.password, APP_RELAY_PASSWORD: relay.password,
      APP_USER_STATEMENT_TIMEOUT_MS: TEST_DB_TIMEOUTS.userStatementMs,
      APP_RELAY_STATEMENT_TIMEOUT_MS: TEST_DB_TIMEOUTS.relayStatementMs,
      IDLE_IN_TX_TIMEOUT_MS: TEST_DB_TIMEOUTS.idleInTxMs,
    })
    .withCopyDirectoriesToContainer([{ source: resolve('docker/postgres/init'), target: '/docker-entrypoint-initdb.d' }])
    .start();
  bouncer = await new GenericContainer(images.IMAGE_PGBOUNCER!)
    .withNetwork(network)
    .withEnvironment({
      DB_HOST: PG_ALIAS, DB_PORT: '5432', DB_NAME: pgC.getDatabase(),
      DB_USER: app.user, DB_PASSWORD: app.password,
      POOL_MODE: 'transaction', AUTH_TYPE: 'scram-sha-256',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  redisC = await new RedisContainer(images.IMAGE_REDIS!).start();
  project.provide('infra', {
    pg: { host: pgC.getHost(), port: pgC.getPort(), database: pgC.getDatabase(), owner, app, relay },
    pgbouncer: { host: bouncer.getHost(), port: bouncer.getMappedPort(5432) },
    redis: { url: redisC.getConnectionUrl() },
  });
}

export async function teardown() {
  await redisC?.stop();
  await bouncer?.stop();
  await pgC?.stop();
  await network?.stop();
}
```
Tên biến môi trường của PgBouncer ở trên là của `edoburu/pgbouncer`. Nếu Step 1 chọn image khác thì đổi theo README của image đó, và dùng cùng tên biến trong `compose.yaml`.

Verify: tên method `withCopyDirectoriesToContainer`, `getConnectionUrl`, `getDatabase`, `Network`, `withNetworkAliases` trong tài liệu Testcontainers Node (`https://node.testcontainers.org/`). File `.sh` cần quyền thực thi: `git update-index --chmod=+x docker/postgres/init/01-roles.sh`.

Run: `pnpm test:int`
Expected: PASS cả 3 test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(infra): compose with pinned images, least-privilege db roles, pgbouncer, testcontainers setup"
```

---

### Task 3: `core/config` — schema, validate toàn bộ một lần, sinh `.env.example`

**Files:**
- Create: `src/core/config/{define-config.ts,config.registry.ts,env-example.ts,validate-all.ts,app.config.ts,dev-infra.config.ts,all-configs.ts,index.ts}`, `src/scripts/gen-env-example.ts`
- Test: `test/unit/core/config/define-config.spec.ts`, `test/unit/core/config/env-example.spec.ts`, `test/unit/core/config/validate-all.spec.ts`

**Interfaces:**
- Consumes: không có
- Produces:
  - `defineConfig<S extends z.ZodObject>(namespace, env: { [K in keyof z.infer<S>]: string }, schema: S)` → kết quả của `registerAs` (có `.KEY`), đồng thời đăng ký vào registry
  - `type ConfigOf<T> = ConfigType<T>` (re-export)
  - `ConfigValidationError` có `issues: { env: string; message: string }[]`
  - `configRegistry(): readonly ConfigEntry[]`, `configFactories(): ConfigFactory[]`, `renderEnvExample(entries): string`
  - `defineProductionRule(name: string, rule: (cfg: Readonly<Record<string, Readonly<Record<string, unknown>>>>) => string | undefined): void`
  - `validateAllConfigs(): void`: chạy mọi factory, gom **mọi** lỗi của mọi namespace (cộng lỗi của production rule khi `NODE_ENV=production`) rồi ném một `ConfigValidationError` duy nhất
  - `appConfig` (`app`): `{ role: 'api' | 'worker' | 'migrate'; nodeEnv: 'development' | 'test' | 'production'; serviceName: string }`
  - `devInfraConfig` (`devInfra`): chỉ đăng ký khi chạy script sinh `.env.example`, **không** nằm trong `all-configs.ts` (runtime không nạp)

- [ ] **Step 1: Cài và viết test trước**

```bash
pnpm view zod dist-tags && pnpm view @nestjs/config dist-tags peerDependencies
pnpm add zod @nestjs/config
```
`test/unit/core/config/define-config.spec.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConfigValidationError, defineConfig } from '../../../../src/core/config/index.js';

const schema = z.object({
  port: z.coerce.number().int().positive().default(3000).describe('HTTP port'),
  secret: z.string().min(16).describe('Signing secret'),
});

describe('defineConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('parses env into typed config with defaults', () => {
    vi.stubEnv('T_SECRET', 'x'.repeat(16));
    const cfg = defineConfig('t1', { port: 'T_PORT', secret: 'T_SECRET' }, schema);
    expect(cfg()).toEqual({ port: 3000, secret: 'x'.repeat(16) });
  });

  it('reports every invalid env var by name, never echoing values', () => {
    vi.stubEnv('T2_PORT', '-1');
    vi.stubEnv('T2_SECRET', 'short-secret-value');
    const cfg = defineConfig('t2', { port: 'T2_PORT', secret: 'T2_SECRET' }, schema);
    try {
      cfg();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.issues.map((i) => i.env).sort()).toEqual(['T2_PORT', 'T2_SECRET']);
      expect(err.message).not.toContain('short-secret-value');
    }
  });

  it('rejects duplicate namespaces', () => {
    defineConfig('dup', { port: 'D_PORT', secret: 'D_SECRET' }, schema);
    expect(() => defineConfig('dup', { port: 'D_PORT', secret: 'D_SECRET' }, schema)).toThrow(/already registered/);
  });
});
```
`test/unit/core/config/env-example.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderEnvExample } from '../../../../src/core/config/index.js';

describe('renderEnvExample', () => {
  it('prints raw defaults (before transform), marks required and optional correctly', () => {
    const out = renderEnvExample([{
      namespace: 'x',
      env: { port: 'X_PORT', list: 'X_LIST', secret: 'X_SECRET', note: 'X_NOTE' },
      schema: z.object({
        port: z.coerce.number().default(8080).describe('Port'),
        list: z.string().default('a,b').transform((s) => s.split(',')).describe('List'),
        secret: z.string().describe('Secret'),
        note: z.string().optional().describe('Note'),
      }),
    }]);
    expect(out).toContain('# [x] Port\nX_PORT=8080');
    expect(out).toContain('# [x] List\nX_LIST=a,b');
    expect(out).toContain('# [x] Secret (required)\nX_SECRET=');
    expect(out).toContain('# [x] Note (optional)\nX_NOTE=');
    expect(out).not.toContain('[object Object]');
  });
});
```
`test/unit/core/config/validate-all.spec.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConfigValidationError, defineConfig, defineProductionRule, validateAllConfigs } from '../../../../src/core/config/index.js';

describe('validateAllConfigs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reports issues from every namespace at once', () => {
    defineConfig('va1', { a: 'VA1_A' }, z.object({ a: z.string().min(1) }));
    defineConfig('va2', { b: 'VA2_B' }, z.object({ b: z.string().min(1) }));
    try {
      validateAllConfigs();
      expect.unreachable();
    } catch (e) {
      const envs = (e as ConfigValidationError).issues.map((i) => i.env);
      expect(envs).toEqual(expect.arrayContaining(['VA1_A', 'VA2_B']));
    }
  });

  it('applies production rules only in production', () => {
    vi.stubEnv('VA1_A', 'x'); vi.stubEnv('VA2_B', 'y'); vi.stubEnv('APP_ROLE', 'api');
    defineProductionRule('va1-not-x', (cfg) => (cfg.va1?.a === 'x' ? 'VA1_A must not be x in production' : undefined));
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => validateAllConfigs()).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => validateAllConfigs()).toThrow(/VA1_A must not be x/);
  });
});
```
Run: `pnpm test` → FAIL.

- [ ] **Step 2: Cài đặt**

`src/core/config/config.registry.ts`:
```ts
import type { ConfigFactory } from '@nestjs/config';
import type { z } from 'zod';

export type ConfigEntry = { namespace: string; env: Record<string, string>; schema: z.ZodObject; factory?: ConfigFactory };
export type ProductionRule = { name: string; rule: (cfg: Readonly<Record<string, Readonly<Record<string, unknown>>>>) => string | undefined };

const entries = new Map<string, ConfigEntry>();
const productionRules: ProductionRule[] = [];

export function registerConfigEntry(entry: ConfigEntry): void {
  if (entries.has(entry.namespace)) throw new Error(`Config namespace "${entry.namespace}" already registered`);
  entries.set(entry.namespace, entry);
}
export const configRegistry = (): readonly ConfigEntry[] => [...entries.values()];
export const configFactories = (): ConfigFactory[] => [...entries.values()].flatMap((e) => (e.factory ? [e.factory] : []));

export function defineProductionRule(name: string, rule: ProductionRule['rule']): void {
  if (productionRules.some((r) => r.name === name)) throw new Error(`Production rule "${name}" already defined`);
  productionRules.push({ name, rule });
}
export const productionRuleRegistry = (): readonly ProductionRule[] => [...productionRules];
```
`src/core/config/define-config.ts`:
```ts
import { registerAs } from '@nestjs/config';
import type { z } from 'zod';
import { registerConfigEntry } from './config.registry.js';

export class ConfigValidationError extends Error {
  constructor(readonly namespace: string, readonly issues: { env: string; message: string }[]) {
    super(`Invalid config "${namespace}": ${issues.map((i) => `${i.env}: ${i.message}`).join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function parseConfig<S extends z.ZodObject>(namespace: string, env: Record<string, string>, schema: S): z.infer<S> {
  const raw = Object.fromEntries(Object.entries(env).map(([key, name]) => [key, process.env[name]]));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(namespace, parsed.error.issues.map((issue) => {
      const key = String(issue.path[0]);
      return { env: env[key] ?? key, message: issue.message };
    }));
  }
  return parsed.data;
}

export function defineConfig<S extends z.ZodObject>(namespace: string, env: { [K in keyof z.infer<S>]: string }, schema: S) {
  const envMap = env as Record<string, string>;
  const factory = registerAs(namespace, (): z.infer<S> => parseConfig(namespace, envMap, schema));
  registerConfigEntry({ namespace, env: envMap, schema, factory });
  return factory;
}
```
Zod mặc định không đưa giá trị input vào `issue.message`. Schema nào dùng `transform` có thể ném lỗi (ví dụ `JSON.parse`) thì phải bắt lỗi trong transform và gọi `ctx.addIssue`, không được để exception gốc (có chứa input) lọt ra (xem Task 15).

`src/core/config/env-example.ts` (đọc giá trị mặc định **gốc**, trước transform):
```ts
import type { z } from 'zod';
import type { ConfigEntry } from './config.registry.js';

type Def = { type: string; innerType?: z.ZodType; in?: z.ZodType; defaultValue?: unknown };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

function describeField(field: z.ZodType): { kind: 'default'; value: unknown } | { kind: 'optional' } | { kind: 'required' } {
  let cur: z.ZodType | undefined = field;
  while (cur) {
    const d = defOf(cur);
    if (d.type === 'default') return { kind: 'default', value: typeof d.defaultValue === 'function' ? (d.defaultValue as () => unknown)() : d.defaultValue };
    if (d.type === 'optional') return { kind: 'optional' };
    if (d.type === 'pipe') cur = d.in;
    else if (d.type === 'nullable') cur = d.innerType;
    else break;
  }
  return { kind: 'required' };
}

export function renderEnvExample(entries: readonly ConfigEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    for (const [key, envName] of Object.entries(entry.env)) {
      const field = entry.schema.shape[key] as z.ZodType;
      const info = describeField(field);
      const suffix = info.kind === 'required' ? ' (required)' : info.kind === 'optional' ? ' (optional)' : '';
      lines.push(`# [${entry.namespace}] ${field.description ?? key}${suffix}`);
      lines.push(`${envName}=${info.kind === 'default' ? String(info.value) : ''}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
```
Verify: cấu trúc `_zod.def` (tên trường `type`, `in`, `innerType`, `defaultValue`) và thuộc tính `description` sau `.describe()` trong zod 4 đã cài (`node_modules/zod/v4/core/schemas.d.ts`, `https://zod.dev/metadata`). Sửa đúng tên nếu khác. Test ở Step 1 sẽ bắt sai.

`src/core/config/validate-all.ts`:
```ts
import { ConfigValidationError } from './define-config.js';
import { configRegistry, productionRuleRegistry } from './config.registry.js';

export function validateAllConfigs(): void {
  const issues: { env: string; message: string }[] = [];
  const values: Record<string, Record<string, unknown>> = {};
  for (const entry of configRegistry()) {
    if (!entry.factory) continue;
    try {
      values[entry.namespace] = entry.factory() as Record<string, unknown>;
    } catch (e) {
      if (e instanceof ConfigValidationError) issues.push(...e.issues);
      else throw e;
    }
  }
  if (issues.length === 0 && values.app?.nodeEnv === 'production') {
    for (const r of productionRuleRegistry()) {
      const msg = r.rule(values);
      if (msg) issues.push({ env: r.name, message: msg });
    }
  }
  if (issues.length) throw new ConfigValidationError('all', issues);
}
```
`src/core/config/app.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from './define-config.js';

export const appConfig = defineConfig(
  'app',
  { role: 'APP_ROLE', nodeEnv: 'NODE_ENV', serviceName: 'APP_SERVICE_NAME' },
  z.object({
    role: z.enum(['api', 'worker', 'migrate']).describe('Process role, set by the entrypoint'),
    nodeEnv: z.enum(['development', 'test', 'production']).default('development').describe('Runtime environment'),
    serviceName: z.string().regex(/^[a-z0-9-]+$/).default('backend-demo').describe('Service name used in logs and key namespaces'),
  }),
);
```
`src/core/config/dev-infra.config.ts` (chỉ cho `.env.example`, dùng bởi `compose.yaml`):
```ts
import { z } from 'zod';
import { defineConfig } from './define-config.js';

export const devInfraConfig = defineConfig(
  'devInfra',
  {
    dbName: 'DB_NAME', superuser: 'POSTGRES_SUPERUSER', superuserPassword: 'POSTGRES_SUPERUSER_PASSWORD',
    appStatementTimeoutMs: 'DB_APP_STATEMENT_TIMEOUT_MS', relayStatementTimeoutMs: 'DB_RELAY_STATEMENT_TIMEOUT_MS',
    idleInTxTimeoutMs: 'DB_IDLE_IN_TX_TIMEOUT_MS', redisPassword: 'REDIS_PASSWORD',
    dbPortHost: 'DB_PORT_HOST', redisPortHost: 'REDIS_PORT_HOST', pgbouncerPortHost: 'PGBOUNCER_PORT_HOST', httpPortHost: 'HTTP_PORT_HOST',
  },
  z.object({
    dbName: z.string().default('app').describe('Database name (compose)'),
    superuser: z.string().default('postgres').describe('Postgres superuser (local compose only)'),
    superuserPassword: z.string().describe('Postgres superuser password (local compose only)'),
    appStatementTimeoutMs: z.coerce.number().int().positive().default(5000).describe('statement_timeout set on role app_user'),
    relayStatementTimeoutMs: z.coerce.number().int().positive().default(60000).describe('statement_timeout set on role app_relay'),
    idleInTxTimeoutMs: z.coerce.number().int().positive().default(10000).describe('idle_in_transaction_session_timeout for app roles'),
    redisPassword: z.string().describe('Redis password (compose)'),
    dbPortHost: z.coerce.number().int().default(5432).describe('Host port for Postgres (bound to 127.0.0.1)'),
    redisPortHost: z.coerce.number().int().default(6379).describe('Host port for Redis (bound to 127.0.0.1)'),
    pgbouncerPortHost: z.coerce.number().int().default(6432).describe('Host port for PgBouncer (bound to 127.0.0.1)'),
    httpPortHost: z.coerce.number().int().default(3000).describe('Host port for the api container (bound to 127.0.0.1)'),
  }),
);
```
`src/core/config/all-configs.ts` (mỗi task thêm config thì thêm một dòng import; **không** import `dev-infra.config`):
```ts
import './app.config.js';
```
`src/core/config/index.ts`:
```ts
export { defineConfig, parseConfig, ConfigValidationError } from './define-config.js';
export { configRegistry, configFactories, defineProductionRule, type ConfigEntry } from './config.registry.js';
export { renderEnvExample } from './env-example.js';
export { validateAllConfigs } from './validate-all.js';
export { appConfig } from './app.config.js';
export type { ConfigType as ConfigOf } from '@nestjs/config';
```
`src/scripts/gen-env-example.ts`:
```ts
import { writeFileSync } from 'node:fs';
import '../core/config/all-configs.js';
import '../core/config/dev-infra.config.js';
import { configRegistry, renderEnvExample } from '../core/config/index.js';

writeFileSync('.env.example', renderEnvExample(configRegistry()));
```
Script: `"env:example": "node --import @swc-node/register/esm-register src/scripts/gen-env-example.ts"`. Verify tên entry `esm-register` theo README của `@swc-node/register` đã cài.

Run: `pnpm test && pnpm env:example && head -30 .env.example`
Expected: PASS. `.env.example` có `APP_ROLE=` đánh dấu `(required)`, có các biến compose.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): typed config with all-at-once validation, production rules and generated env example"
```

---

### Task 4: `core/errors` + `core/context` + `core/logging`

**Files:**
- Create: `src/core/errors/{error-codes.ts,app-error.ts,error-mappers.ts,zod-issues.ts,errors.config.ts,problem-details.filter.ts,index.ts}`, `src/core/context/{context.keys.ts,principal.ts,request-context.ts,context.module.ts,index.ts}`, `src/core/logging/{logging.config.ts,redaction.ts,logging.module.ts,index.ts}`
- Test: `test/unit/core/errors/error-codes.spec.ts`, `test/unit/core/errors/zod-issues.spec.ts`, `test/unit/core/errors/problem-details.filter.spec.ts`, `test/unit/core/logging/redaction.spec.ts`, `test/e2e/core/errors-and-context.e2e.spec.ts`, `test/support/env.ts`, `test/support/app-factory.ts`

**Interfaces:**
- Consumes: `defineConfig`, `configFactories`, `validateAllConfigs`, `appConfig`
- Produces:
  - `type ErrorCode = { readonly code: string; readonly status: number; readonly title: string }`
  - `defineErrorCodes<K extends string>(codes: Record<K, { status: HttpStatus; title: string }>): Record<K, ErrorCode>` (`code` = key viết thường, trùng thì ném), `allErrorCodes()`, `findErrorCode(code: string): ErrorCode | undefined`
  - `CoreErrors`: `MALFORMED_REQUEST`, `VALIDATION_FAILED`, `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REQUIRED`, `ORG_CONTEXT_INVALID`, `UNAUTHENTICATED`, `FORBIDDEN`, `FEATURE_NOT_IN_PLAN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PRECONDITION_FAILED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `IDEMPOTENCY_KEY_REUSED`, `QUOTA_EXCEEDED`, `PRECONDITION_REQUIRED`, `RATE_LIMITED`, `INTERNAL_ERROR`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE`, `UPSTREAM_TIMEOUT`
  - `type FieldError = { path: string; code: string; message: string }`, `AppError(error, opts?: { detail?; fields?; headers?; cause? })`
  - `registerErrorMapper(mapper)`, `mapKnownError(err)`, `toAppError(err: unknown): AppError` (AppError → giữ; mapper → kết quả; HttpException/body-parser → mã core; còn lại → `INTERNAL_ERROR`)
  - `zodIssuesToFields(issues: readonly ZodIssueLike[]): FieldError[]` (nhận cả path kiểu Standard Schema `{ key }`)
  - `ProblemDetailsFilter` (global, dùng `HttpAdapterHost` nên không phụ thuộc Express)
  - `type Principal = { type: 'user' | 'api_key' | 'service'; id: string }`
  - `RequestContext`: `requestId()`, `clientRequestId()`, `traceId()`, `traceparent()`, `path()`, `orgId()`, `setOrgId(id)`, `principal(): Principal | undefined`, `setPrincipal(p)`, `run(values, fn)`
  - `ContextModule`, `LoggingModule`, `BASE_REDACT_PATHS`
  - `test/support/env.ts`: `baseTestEnv(): Record<string, string>` (có `REDIS_KEY_PREFIX` riêng cho từng file test), `randomSecret()`
  - `test/support/app-factory.ts`: `createTestApp(imports, opts?: { beforeInit?: (app) => void; middleware?: … })` — **luôn** `init()`, gọi `validateAllConfigs()` trước

- [ ] **Step 1: Cài package và viết test trước**

```bash
for p in nestjs-cls nestjs-pino pino-http pino uuid; do pnpm view $p dist-tags peerDependencies; done
pnpm add nestjs-cls nestjs-pino pino-http pino uuid
```
`test/unit/core/errors/error-codes.spec.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CoreErrors, allErrorCodes, defineErrorCodes, findErrorCode } from '../../../../src/core/errors/index.js';

describe('error code registry', () => {
  it('derives lowercase snake_case codes from keys', () => {
    expect(CoreErrors.VALIDATION_FAILED).toEqual({ code: 'validation_failed', status: 422, title: 'Validation failed' });
    expect(findErrorCode('invalid_cursor')).toBe(CoreErrors.INVALID_CURSOR);
  });
  it('rejects a code that is already defined', () => {
    expect(() => defineErrorCodes({ NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'dup' } })).toThrow(/already defined/);
  });
  it('rejects keys that are not UPPER_SNAKE and non-error statuses', () => {
    expect(() => defineErrorCodes({ badKey: { status: HttpStatus.BAD_REQUEST, title: 'x' } })).toThrow(/UPPER_SNAKE/);
    expect(() => defineErrorCodes({ WEIRD_OK: { status: HttpStatus.OK, title: 'x' } })).toThrow(/4xx or 5xx/);
  });
  it('every core code is unique', () => {
    const codes = allErrorCodes().map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
```
`test/unit/core/errors/zod-issues.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodIssuesToFields } from '../../../../src/core/errors/index.js';

const schema = z.object({ email: z.email(), age: z.number().int().min(18), items: z.array(z.object({ quantity: z.number().positive() })) });

describe('zodIssuesToFields', () => {
  it('uses dot paths with array indices and stable codes', () => {
    const r = schema.safeParse({ email: 'nope', age: 10, items: [{ quantity: 1 }, { quantity: -1 }] });
    const fields = zodIssuesToFields(r.error!.issues);
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'email', code: 'invalid_email' }),
      expect.objectContaining({ path: 'age', code: 'too_small' }),
      expect.objectContaining({ path: 'items.1.quantity', code: 'too_small' }),
    ]));
  });
  it('accepts Standard Schema path segments and missing codes', () => {
    expect(zodIssuesToFields([{ message: 'bad', path: [{ key: 'a' }, 0] }])).toEqual([{ path: 'a.0', code: 'invalid', message: 'bad' }]);
  });
});
```
Verify: mã issue của zod 4 (`invalid_format` + `format`, `too_small`, `invalid_type`).

`test/unit/core/errors/problem-details.filter.spec.ts`:
```ts
import { HttpException, HttpStatus, Logger, NotFoundException, PayloadTooLargeException, type ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, CoreErrors, ProblemDetailsFilter, registerErrorMapper } from '../../../../src/core/errors/index.js';
import type { RequestContext } from '../../../../src/core/context/index.js';

type Reply = { body: Record<string, unknown>; status: number; headers: Record<string, string> };
function setup() {
  const reply: Reply = { body: {}, status: 0, headers: {} };
  const adapter = {
    reply: (_res: unknown, body: Record<string, unknown>, status: number) => { reply.body = body; reply.status = status; },
    setHeader: (_res: unknown, k: string, v: string) => { reply.headers[k.toLowerCase()] = v; },
    getRequestUrl: () => '/api/v1/users?x=1',
  };
  const adapterHost = { httpAdapter: adapter } as unknown as HttpAdapterHost;
  const ctx = { requestId: () => '019dd1a5-9235-70db-8d57-54ef901d8185' } as unknown as RequestContext;
  const filter = new ProblemDetailsFilter(adapterHost, ctx, { problemTypeBase: '/errors' });
  const host = { switchToHttp: () => ({ getResponse: () => ({}), getRequest: () => ({}) }) } as unknown as ArgumentsHost;
  return { reply, filter, host };
}

describe('ProblemDetailsFilter', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());

  it('renders the agreed RFC 9457 shape for AppError', () => {
    const { reply, filter, host } = setup();
    filter.catch(new AppError(CoreErrors.VALIDATION_FAILED, {
      detail: 'One or more fields did not pass validation.',
      fields: [{ path: 'email', code: 'invalid_email', message: 'email must be an email' }],
    }), host);
    expect(reply.status).toBe(422);
    expect(reply.headers['content-type']).toBe('application/problem+json');
    expect(reply.body).toMatchObject({
      type: '/errors/validation-failed', title: 'Validation failed', status: 422, code: 'validation_failed',
      instance: '/api/v1/users', requestId: '019dd1a5-9235-70db-8d57-54ef901d8185',
      errors: [{ path: 'email', code: 'invalid_email', message: 'email must be an email' }],
    });
    expect(new Date(reply.body.timestamp as string).toISOString()).toBe(reply.body.timestamp);
  });

  it('omits errors when empty and sets headers carried by AppError', () => {
    const { reply, filter, host } = setup();
    filter.catch(new AppError(CoreErrors.SERVICE_UNAVAILABLE, { headers: { 'Retry-After': '5' } }), host);
    expect(reply.body).not.toHaveProperty('errors');
    expect(reply.headers['retry-after']).toBe('5');
  });

  it('maps Nest HttpExceptions and body-parser errors to core codes', () => {
    const cases: [unknown, string][] = [
      [new NotFoundException(), 'not_found'],
      [new PayloadTooLargeException(), 'payload_too_large'],
      [new HttpException('x', HttpStatus.TOO_MANY_REQUESTS), 'rate_limited'],
      [new HttpException('x', HttpStatus.UNAUTHORIZED), 'unauthenticated'],
      [new HttpException('x', HttpStatus.BAD_REQUEST), 'malformed_request'],
      [Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 }), 'malformed_request'],
      [Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 }), 'payload_too_large'],
    ];
    for (const [ex, code] of cases) {
      const { reply, filter, host } = setup();
      filter.catch(ex, host);
      expect(reply.body.code).toBe(code);
    }
  });

  it('uses registered mappers and never leaks driver details', () => {
    class DriverError extends Error {}
    registerErrorMapper((e) => (e instanceof DriverError ? new AppError(CoreErrors.CONFLICT) : undefined));
    const { reply, filter, host } = setup();
    filter.catch(new DriverError('duplicate key value violates unique constraint "users_email_uq"'), host);
    expect(reply.body).toMatchObject({ status: 409, code: 'conflict' });
    expect(JSON.stringify(reply.body)).not.toContain('users_email_uq');
  });

  it('hides unknown errors, logs them, returns internal_error', () => {
    const { reply, filter, host } = setup();
    filter.catch(new Error('db password leaked in message'), host);
    expect(reply.status).toBe(500);
    expect(reply.body).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(reply.body)).not.toContain('password');
    expect(errorSpy).toHaveBeenCalled();
  });
});
```
`test/unit/core/logging/redaction.spec.ts`:
```ts
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { BASE_REDACT_PATHS, errSerializer, reqSerializer } from '../../../../src/core/logging/index.js';

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  return { lines, stream: new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } }) };
}

describe('log redaction', () => {
  it('censors secrets at any depth covered by the base list', () => {
    const { lines, stream } = capture();
    const log = pino({ redact: { paths: [...BASE_REDACT_PATHS], censor: '[REDACTED]' } }, stream);
    log.info({ req: { headers: { authorization: 'Bearer t', cookie: 'c', 'x-api-key': 'k', 'x-sepay-signature': 's' } }, user: { password: 'p', profile: { password: 'p2' } }, accessToken: 'a' });
    const out = lines.join('');
    for (const secret of ['Bearer t', '"c"', '"k"', '"s"', '"p"', '"p2"', '"a"']) expect(out).not.toContain(secret);
  });
  it('drops SQL, params and row details from errors', () => {
    const e = Object.assign(new Error('boom'), { query: 'select * from users where email = $1', params: ['a@b.c'], detail: 'Key (email)=(a@b.c)', code: '23505', constraint: 'users_email_uq' });
    const s = errSerializer(e);
    expect(JSON.stringify(s)).not.toContain('a@b.c');
    expect(s).toMatchObject({ code: '23505', constraint: 'users_email_uq' });
  });
  it('strips query strings from logged URLs', () => {
    expect(reqSerializer({ method: 'GET', url: '/reset?token=secret', headers: {} })).toMatchObject({ url: '/reset' });
  });
});
```
Run: `pnpm test` → FAIL.

- [ ] **Step 2: Cài đặt `core/errors`**

`src/core/errors/errors.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const errorsConfig = defineConfig(
  'errors',
  { problemTypeBase: 'HTTP_PROBLEM_TYPE_BASE' },
  z.object({
    problemTypeBase: z.string().regex(/^(\/|https?:\/\/)[^\s]*[^/]$/).default('/errors').describe('Base URI for problem "type" (docs page per error code), no trailing slash'),
  }),
);
```
`src/core/errors/error-codes.ts`:
```ts
import { HttpStatus } from '@nestjs/common';

export type ErrorCode = { readonly code: string; readonly status: number; readonly title: string };

const KEY_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const MIN_ERROR_STATUS = 400;
const MAX_ERROR_STATUS = 599;
const registry = new Map<string, ErrorCode>();

export function defineErrorCodes<K extends string>(codes: Record<K, { status: HttpStatus; title: string }>): Record<K, ErrorCode> {
  const out = {} as Record<K, ErrorCode>;
  for (const key of Object.keys(codes) as K[]) {
    const def = codes[key];
    if (!KEY_PATTERN.test(key)) throw new Error(`Error key "${key}" must be UPPER_SNAKE`);
    if (def.status < MIN_ERROR_STATUS || def.status > MAX_ERROR_STATUS) throw new Error(`Error "${key}" must use a 4xx or 5xx status`);
    const code = key.toLowerCase();
    if (registry.has(code)) throw new Error(`Error code "${code}" is already defined`);
    const entry: ErrorCode = Object.freeze({ code, status: def.status, title: def.title });
    registry.set(code, entry);
    out[key] = entry;
  }
  return out;
}

export const allErrorCodes = (): readonly ErrorCode[] => [...registry.values()];
export const findErrorCode = (code: string): ErrorCode | undefined => registry.get(code);

export const CoreErrors = defineErrorCodes({
  MALFORMED_REQUEST: { status: HttpStatus.BAD_REQUEST, title: 'Malformed request' },
  INVALID_CURSOR: { status: HttpStatus.BAD_REQUEST, title: 'Invalid cursor' },
  IDEMPOTENCY_KEY_REQUIRED: { status: HttpStatus.BAD_REQUEST, title: 'A valid Idempotency-Key header is required' },
  ORG_CONTEXT_INVALID: { status: HttpStatus.BAD_REQUEST, title: 'Organization context is missing or invalid' },
  UNAUTHENTICATED: { status: HttpStatus.UNAUTHORIZED, title: 'Authentication required' },
  FORBIDDEN: { status: HttpStatus.FORBIDDEN, title: 'Forbidden' },
  FEATURE_NOT_IN_PLAN: { status: HttpStatus.FORBIDDEN, title: 'Feature is not included in your plan' },
  NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'Not found' },
  METHOD_NOT_ALLOWED: { status: HttpStatus.METHOD_NOT_ALLOWED, title: 'Method not allowed' },
  CONFLICT: { status: HttpStatus.CONFLICT, title: 'Conflict' },
  IDEMPOTENCY_CONFLICT: { status: HttpStatus.CONFLICT, title: 'A request with this Idempotency-Key is still in progress' },
  PRECONDITION_FAILED: { status: HttpStatus.PRECONDITION_FAILED, title: 'Resource has been modified' },
  PAYLOAD_TOO_LARGE: { status: HttpStatus.PAYLOAD_TOO_LARGE, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: HttpStatus.UNSUPPORTED_MEDIA_TYPE, title: 'Unsupported media type' },
  VALIDATION_FAILED: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Validation failed' },
  IDEMPOTENCY_KEY_REUSED: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Idempotency-Key was reused with a different request' },
  QUOTA_EXCEEDED: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Quota exceeded' },
  PRECONDITION_REQUIRED: { status: HttpStatus.PRECONDITION_REQUIRED, title: 'If-Match header is required' },
  RATE_LIMITED: { status: HttpStatus.TOO_MANY_REQUESTS, title: 'Too many requests' },
  INTERNAL_ERROR: { status: HttpStatus.INTERNAL_SERVER_ERROR, title: 'Internal error' },
  UPSTREAM_ERROR: { status: HttpStatus.BAD_GATEWAY, title: 'Upstream service error' },
  SERVICE_UNAVAILABLE: { status: HttpStatus.SERVICE_UNAVAILABLE, title: 'Service unavailable' },
  UPSTREAM_TIMEOUT: { status: HttpStatus.GATEWAY_TIMEOUT, title: 'Upstream service timed out' },
});
```
Verify: tên `HttpStatus.UNPROCESSABLE_ENTITY` / `PRECONDITION_REQUIRED` trong enum của `@nestjs/common` đã cài (có thể là `UNPROCESSABLE_CONTENT`).

`src/core/errors/app-error.ts`:
```ts
import type { ErrorCode } from './error-codes.js';

export type FieldError = { path: string; code: string; message: string };

export class AppError extends Error {
  constructor(
    readonly error: ErrorCode,
    readonly opts: { detail?: string; fields?: FieldError[]; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(opts.detail ?? error.title, { cause: opts.cause });
    this.name = 'AppError';
  }
}
```
`src/core/errors/error-mappers.ts`:
```ts
import { HttpException, HttpStatus } from '@nestjs/common';
import { AppError } from './app-error.js';
import { CoreErrors, type ErrorCode } from './error-codes.js';

export type ErrorMapper = (err: unknown) => AppError | undefined;
const mappers: ErrorMapper[] = [];

export function registerErrorMapper(mapper: ErrorMapper): void {
  if (!mappers.includes(mapper)) mappers.push(mapper);
}
export function mapKnownError(err: unknown): AppError | undefined {
  for (const m of mappers) {
    const mapped = m(err);
    if (mapped) return mapped;
  }
  return undefined;
}

const HTTP_STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: CoreErrors.MALFORMED_REQUEST,
  [HttpStatus.UNAUTHORIZED]: CoreErrors.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: CoreErrors.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: CoreErrors.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: CoreErrors.METHOD_NOT_ALLOWED,
  [HttpStatus.CONFLICT]: CoreErrors.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: CoreErrors.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: CoreErrors.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.TOO_MANY_REQUESTS]: CoreErrors.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: CoreErrors.SERVICE_UNAVAILABLE,
};
const BODY_PARSER_TYPES: Record<string, ErrorCode> = {
  'entity.parse.failed': CoreErrors.MALFORMED_REQUEST,
  'entity.too.large': CoreErrors.PAYLOAD_TOO_LARGE,
  'encoding.unsupported': CoreErrors.UNSUPPORTED_MEDIA_TYPE,
  'charset.unsupported': CoreErrors.UNSUPPORTED_MEDIA_TYPE,
};

/** Chuẩn hoá mọi lỗi thành AppError với mã có trong registry. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const mapped = mapKnownError(err);
  if (mapped) return mapped;
  if (err instanceof HttpException) return new AppError(HTTP_STATUS_TO_CODE[err.getStatus()] ?? CoreErrors.INTERNAL_ERROR, { cause: err });
  const type = typeof err === 'object' && err !== null && 'type' in err ? (err as { type: unknown }).type : undefined;
  if (typeof type === 'string' && BODY_PARSER_TYPES[type]) return new AppError(BODY_PARSER_TYPES[type], { cause: err });
  return new AppError(CoreErrors.INTERNAL_ERROR, { cause: err });
}
```
`src/core/errors/zod-issues.ts`:
```ts
import type { FieldError } from './app-error.js';

export type ZodIssueLike = { code?: string; path?: readonly (PropertyKey | { key: PropertyKey })[]; message: string; format?: string };

export function zodIssuesToFields(issues: readonly ZodIssueLike[]): FieldError[] {
  return issues.map((i) => ({
    path: (i.path ?? []).map((s) => String(typeof s === 'object' ? s.key : s)).join('.'),
    code: i.code === 'invalid_format' && i.format ? `invalid_${i.format}` : (i.code ?? 'invalid'),
    message: i.message,
  }));
}
```
`src/core/errors/problem-details.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Inject, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/request-context.js';
import { AppError } from './app-error.js';
import { toAppError } from './error-mappers.js';
import { errorsConfig } from './errors.config.js';

const PROBLEM_JSON = 'application/problem+json';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly ctx: RequestContext,
    @Inject(errorsConfig.KEY) private readonly cfg: ConfigOf<typeof errorsConfig>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const http = host.switchToHttp();
    const res = http.getResponse<unknown>();
    const req = http.getRequest<unknown>();
    const { error, opts } = toAppError(exception);
    if (error.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ err: exception, requestId: this.ctx.requestId(), code: error.code }, 'request failed');
    }
    for (const [k, v] of Object.entries(opts.headers ?? {})) httpAdapter.setHeader(res, k, v);
    httpAdapter.setHeader(res, 'Content-Type', PROBLEM_JSON);
    const exposeDetail = error.status < HttpStatus.INTERNAL_SERVER_ERROR || exception instanceof AppError;
    httpAdapter.reply(res, {
      type: `${this.cfg.problemTypeBase}/${error.code.replaceAll('_', '-')}`,
      title: error.title,
      status: error.status,
      code: error.code,
      ...(exposeDetail && opts.detail ? { detail: opts.detail } : {}),
      instance: String(httpAdapter.getRequestUrl(req)).split('?')[0],
      requestId: this.ctx.requestId(),
      timestamp: new Date().toISOString(),
      ...(opts.fields?.length ? { errors: opts.fields } : {}),
    }, error.status);
  }
}
```
Verify: `httpAdapter.reply` của Express adapter không ghi đè `Content-Type` đã set (test e2e Step 5 kiểm tra `application/problem+json`). Nếu bị ghi đè thì gọi `httpAdapter.reply` sau khi set header bằng `httpAdapter.setHeader` như trên vẫn không đủ, khi đó dùng `httpAdapter.getType`/tài liệu `AbstractHttpAdapter` để chọn đúng cách, không import Express vào `core/errors`.

`src/core/errors/index.ts`:
```ts
export { AppError, type FieldError } from './app-error.js';
export { CoreErrors, allErrorCodes, defineErrorCodes, findErrorCode, type ErrorCode } from './error-codes.js';
export { registerErrorMapper, mapKnownError, toAppError, type ErrorMapper } from './error-mappers.js';
export { zodIssuesToFields, type ZodIssueLike } from './zod-issues.js';
export { ProblemDetailsFilter } from './problem-details.filter.js';
export { errorsConfig } from './errors.config.js';
```
Thêm `import '../errors/errors.config.js';` vào `all-configs.ts`.

- [ ] **Step 3: Cài đặt `core/context`**

Verify: API của `nestjs-cls` version đã cài (`ClsModule.forRoot({ global, middleware: { mount, setup } })`, `ClsService.get/set/run`, `run({ ifNested: 'inherit' }, fn)`).

`src/core/context/principal.ts`:
```ts
export type Principal = { type: 'user' | 'api_key' | 'service'; id: string };
```
`src/core/context/context.keys.ts`:
```ts
export const CTX = {
  requestId: 'core.requestId',
  clientRequestId: 'core.clientRequestId',
  traceId: 'core.traceId',
  traceparent: 'core.traceparent',
  path: 'core.path',
  orgId: 'core.orgId',
  principal: 'core.principal',
  jobId: 'core.jobId',
  em: 'core.em',
} as const;

export type ContextValues = { requestId: string; traceId?: string; traceparent?: string; orgId?: string; jobId?: string };
```
`src/core/context/request-context.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { v7 } from 'uuid';
import { CTX, type ContextValues } from './context.keys.js';
import type { Principal } from './principal.js';

const NO_REQUEST = 'none';

@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService) {}

  private read<T>(key: string): T | undefined {
    return this.cls.isActive() ? this.cls.get<T>(key) : undefined;
  }
  requestId(): string { return this.read<string>(CTX.requestId) ?? NO_REQUEST; }
  clientRequestId(): string | undefined { return this.read<string>(CTX.clientRequestId); }
  traceId(): string | undefined { return this.read<string>(CTX.traceId); }
  traceparent(): string | undefined { return this.read<string>(CTX.traceparent); }
  path(): string | undefined { return this.read<string>(CTX.path); }
  orgId(): string | undefined { return this.read<string>(CTX.orgId); }
  principal(): Principal | undefined { return this.read<Principal>(CTX.principal); }
  setOrgId(id: string): void { this.cls.set(CTX.orgId, id); }
  setPrincipal(p: Principal): void { this.cls.set(CTX.principal, p); }

  run<T>(values: Partial<ContextValues>, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set(CTX.requestId, values.requestId ?? v7());
      if (values.traceId) this.cls.set(CTX.traceId, values.traceId);
      if (values.traceparent) this.cls.set(CTX.traceparent, values.traceparent);
      if (values.orgId) this.cls.set(CTX.orgId, values.orgId);
      if (values.jobId) this.cls.set(CTX.jobId, values.jobId);
      return fn();
    });
  }
}
```
`src/core/context/context.module.ts` (tạo khung bằng `pnpm nest g module core/context --no-spec`, rồi thay nội dung):
```ts
import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { v7 } from 'uuid';
import { CTX } from './context.keys.js';
import { RequestContext } from './request-context.js';

const REQUEST_ID_HEADER = 'x-request-id';
/** Chỉ nhận request id an toàn để lưu làm clientRequestId (chặn log injection, giới hạn độ dài). */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        setup: (cls, req: { headers: Record<string, string | undefined>; originalUrl: string }, res: { setHeader(k: string, v: string): void }) => {
          const requestId = v7();
          const incoming = req.headers[REQUEST_ID_HEADER];
          cls.set(CTX.requestId, requestId);
          if (incoming && CLIENT_REQUEST_ID_PATTERN.test(incoming)) cls.set(CTX.clientRequestId, incoming);
          cls.set(CTX.path, req.originalUrl.split('?')[0]);
          res.setHeader('X-Request-Id', requestId);
        },
      },
    }),
  ],
  providers: [RequestContext],
  exports: [RequestContext],
})
export class ContextModule {}
```
Request id do **server** sinh (UUIDv7). Giá trị client gửi chỉ lưu ở `clientRequestId` (đã kiểm tra định dạng) để đối chiếu, không bao giờ thay request id của server.

`src/core/context/index.ts`:
```ts
export { ContextModule } from './context.module.js';
export { RequestContext } from './request-context.js';
export { CTX, type ContextValues } from './context.keys.js';
export type { Principal } from './principal.js';
```

- [ ] **Step 4: Cài đặt `core/logging`**

Verify: `nestjs-pino` cho phép truyền tuỳ chọn pino (`mixin`, `serializers`, `redact`) qua `pinoHttp` (README của version đã cài). `mixin` áp cho **mọi** log (kể cả log của job), không chỉ log request.

`src/core/logging/redaction.ts`:
```ts
/** Danh sách gốc, cố định trong code. Env chỉ được thêm vào, không thay thế. */
export const BASE_REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'req.headers["proxy-authorization"]',
  'req.headers["x-sepay-signature"]', 'res.headers["set-cookie"]',
  '*.password', '*.*.password', '*.token', '*.*.token', '*.secret', '*.*.secret', '*.apiKey', '*.*.apiKey',
  '*.accessToken', '*.refreshToken', '*.idToken', '*.otp', '*.backupCodes', '*.clientSecret', '*.privateKey',
  'accessToken', 'refreshToken', 'password', 'token', 'secret',
] as const;

const DRIVER_ERROR_DROP = new Set(['query', 'sql', 'params', 'parameters', 'detail', 'where', 'bindings']);

export function errSerializer(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const out: Record<string, unknown> = { type: err.name, message: err.message, stack: err.stack };
  for (const [k, v] of Object.entries(err)) if (!DRIVER_ERROR_DROP.has(k)) out[k] = v;
  if (err.cause) out.cause = errSerializer(err.cause);
  return out;
}

export function reqSerializer(req: { method?: string; url?: string; headers?: Record<string, unknown> }): Record<string, unknown> {
  return { method: req.method, url: req.url?.split('?')[0], headers: req.headers };
}
```
Message của lỗi driver Postgres không chứa giá trị hàng (giá trị nằm ở `detail`), nên giữ `message` là an toàn; `detail`, `query`, `params` bị bỏ.

`src/core/logging/logging.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const loggingConfig = defineConfig(
  'logging',
  { level: 'LOG_LEVEL', extraRedact: 'LOG_EXTRA_REDACT_PATHS', pretty: 'LOG_PRETTY' },
  z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info').describe('Minimum log level'),
    extraRedact: z.string().default('').transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean)).describe('Extra pino redact paths, added to the built-in list'),
    pretty: z.stringbool().default(false).describe('Human readable logs (local dev only)'),
  }),
);
```
Verify `z.stringbool()` trong zod 4; nếu không có thì dùng `z.enum(['true','false']).transform(v => v === 'true')` ở mọi nơi dùng.

`src/core/logging/logging.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import { CTX } from '../context/index.js';
import { type ConfigOf } from '../config/index.js';
import { loggingConfig } from './logging.config.js';
import { BASE_REDACT_PATHS, errSerializer, reqSerializer } from './redaction.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [loggingConfig.KEY, ClsService],
      useFactory: (cfg: ConfigOf<typeof loggingConfig>, cls: ClsService) => ({
        pinoHttp: {
          level: cfg.level,
          redact: { paths: [...BASE_REDACT_PATHS, ...cfg.extraRedact], censor: '[REDACTED]' },
          serializers: { err: errSerializer, req: reqSerializer },
          transport: cfg.pretty ? { target: 'pino-pretty' } : undefined,
          mixin: () => (cls.isActive()
            ? { requestId: cls.get(CTX.requestId), traceId: cls.get(CTX.traceId), orgId: cls.get(CTX.orgId), jobId: cls.get(CTX.jobId) }
            : {}),
        },
      }),
    }),
  ],
})
export class LoggingModule {}
```
`CTX.jobId` do `WorkerHost` set khi chạy job (Task 8). Nếu `pretty` = true thì `pnpm add -D pino-pretty`. Thêm config vào `all-configs.ts`. Thêm production rule: `defineProductionRule('logging-no-pretty', (c) => (c.logging?.pretty ? 'LOG_PRETTY must be false in production' : undefined))`.

`src/core/logging/index.ts`: export `LoggingModule`, `loggingConfig`, `BASE_REDACT_PATHS`, `errSerializer`, `reqSerializer`.

- [ ] **Step 5: Env cho test, app factory, test e2e**

`test/support/env.ts`:
```ts
import { randomBytes } from 'node:crypto';

/** Vitest cô lập module theo từng file test, nên prefix này khác nhau giữa các file và giống nhau trong một file. */
const FILE_REDIS_PREFIX = `t${randomBytes(4).toString('hex')}`;

/** Mỗi task thêm config bắt buộc (không có default) thì thêm key vào đây. */
export function baseTestEnv(): Record<string, string> {
  return {
    APP_ROLE: 'api',
    NODE_ENV: 'test',
    REDIS_KEY_PREFIX: FILE_REDIS_PREFIX,
  };
}

export const randomSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');
```
`test/support/app-factory.ts`:
```ts
import { type DynamicModule, type INestApplication, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import '../../src/core/config/all-configs.js';
import { configFactories, validateAllConfigs } from '../../src/core/config/index.js';
import { ContextModule } from '../../src/core/context/index.js';
import { ProblemDetailsFilter } from '../../src/core/errors/index.js';
import { baseTestEnv } from './env.js';

export type ModuleImport = Type<unknown> | DynamicModule;

export function applyTestEnv(): void {
  for (const [k, v] of Object.entries(baseTestEnv())) if (process.env[k] === undefined) vi.stubEnv(k, v);
}

/** Luôn init() để onApplicationBootstrap chạy (worker, relay, scheduler). Không listen cổng. */
export async function createTestApp(imports: ModuleImport[], opts: { beforeInit?: (app: INestApplication) => void } = {}): Promise<INestApplication> {
  applyTestEnv();
  validateAllConfigs();
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: configFactories() }), ContextModule, ...imports],
    providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  opts.beforeInit?.(app);
  await app.init();
  return app;
}
```
`test/e2e/core/errors-and-context.e2e.spec.ts`:
```ts
import { Body, Controller, Get, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { RequestContext } from '../../../src/core/context/index.js';
import { createTestApp } from '../../support/app-factory.js';

@Controller('probe')
class ProbeController {
  constructor(private readonly ctx: RequestContext) {}
  @Get('id') id() { return { requestId: this.ctx.requestId(), clientRequestId: this.ctx.clientRequestId() ?? null }; }
  @Get('app-error') appError() { throw new AppError(CoreErrors.INVALID_CURSOR, { detail: 'nope' }); }
  @Get('boom') boom() { throw new Error('secret internals'); }
  @Post('echo') echo(@Body() body: unknown) { return body; }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('errors + context (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp([ProbeModule]); });
  afterAll(async () => { await app.close(); });

  it('server generates the request id; client value is kept separately', async () => {
    const res = await request(app.getHttpServer()).get('/probe/id').set('x-request-id', 'abc-123');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.requestId).not.toBe('abc-123');
    expect(res.body.clientRequestId).toBe('abc-123');
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });
  it('ignores unsafe client request ids', async () => {
    const res = await request(app.getHttpServer()).get('/probe/id').set('x-request-id', 'a'.repeat(200));
    expect(res.body.clientRequestId).toBeNull();
  });
  it('returns problem+json for AppError with requestId and timestamp', async () => {
    const res = await request(app.getHttpServer()).get('/probe/app-error?secret=1');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ type: '/errors/invalid-cursor', code: 'invalid_cursor', detail: 'nope', instance: '/probe/app-error' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(Date.parse(res.body.timestamp)).not.toBeNaN();
  });
  it('unknown route → 404 not_found; malformed JSON → 400 malformed_request', async () => {
    expect((await request(app.getHttpServer()).get('/nope')).body.code).toBe('not_found');
    const bad = await request(app.getHttpServer()).post('/probe/echo').set('content-type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('malformed_request');
  });
  it('hides internal error details', async () => {
    const res = await request(app.getHttpServer()).get('/probe/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
  });
});
```
Run: `pnpm test && pnpm test:int`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): problem+json errors via http adapter, request context with principal, redacted structured logging"
```

---

### Task 5: `core/database` — MikroORM, connection `app`/`relay`, UnitOfWork, `Db`, migration runner (S4, S5)

**Files:**
- Create: `src/core/database/{database.config.ts,constants.ts,entities.ts,tx-em.ts,unit-of-work.ts,mikro-orm-unit-of-work.ts,db.ts,relay-db.ts,migrator.ts,database.module.ts,index.ts}`, `src/main.migrate.ts`, `src/migrations/core/<CLI>_core_bootstrap.ts`, `mikro-orm.config.ts` (cho CLI)
- Create (test): `test/support/migrate-test-db.ts`, `test/support/db.ts`, `test/fixtures/fixture.entity.ts`, `test/fixtures/fixture.module.ts`, `test/fixtures/migrations/<CLI>_fixture_notes.ts`
- Modify: `test/support/infra.global-setup.ts` (migrate một lần), `test/support/env.ts`
- Test: `test/integration/core/database/unit-of-work.spec.ts`, `test/integration/core/database/migrations.spec.ts`

**Interfaces:**
- Consumes: `defineConfig`, `defineProductionRule`, `appConfig`, `RequestContext`, `CTX.em`, `getInfra()`
- Produces:
  - `DB_CONTEXT = { app: 'app', relay: 'relay' } as const`; `ORG_SESSION_VAR = 'app.org_id'`; `CORE_MIGRATIONS_TABLE`, `FIXTURE_MIGRATIONS_TABLE`
  - `DatabaseModule.forRoot(opts: { relay: boolean })` — api dùng `relay: false`, worker `relay: true`
  - `TxEm`: `current(): EntityManager | undefined`, `get(): EntityManager` (ném nếu không có), `fork(opts?)`, `bind<T>(em, fn): Promise<T>` — chỉ dùng trong `core/database` và `infra/`
  - `abstract class UnitOfWork { run<T>(fn, opts?: { isolation?: Isolation }): Promise<T>; inTransaction(): boolean }`
  - `Db.execute<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>` (connection `app`, gắn transaction + session RLS hiện tại)
  - `RelayDb.execute<T>(sql, params?)`, `RelayDb.transaction<R>(fn: (tx: SqlTx) => Promise<R>): Promise<R>`, `type SqlTx = { execute<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> }`
  - `registerEntities(...)`, `allEntities()`
  - `runMigrations(cmd: 'up' | 'down' | 'status', opts?: { to?: string; source?: MigrationSource; tableName?: string }): Promise<string[]>`, `type MigrationSource = { kind: 'dist' } | { kind: 'list'; list: MigrationObject[] }`
  - `test/support/migrate-test-db.ts`: `coreMigrationList()`, `fixtureMigrationList()`, `migrateTestDb(): Promise<void>`
  - `test/support/db.ts`: `dbEnv(): Record<string, string>` (creds `app`, `relay`, `owner`)

- [ ] **Step 1: Cài package**

```bash
for p in @mikro-orm/core @mikro-orm/postgresql @mikro-orm/nestjs @mikro-orm/migrations @mikro-orm/cli; do pnpm view $p dist-tags peerDependencies; done
pnpm add @mikro-orm/core @mikro-orm/postgresql @mikro-orm/nestjs @mikro-orm/migrations
pnpm add -D @mikro-orm/cli
```
Expected: `@mikro-orm/core`, `postgresql`, `migrations`, `cli` cùng version; `@mikro-orm/nestjs` phát hành riêng (version có thể khác) và peer của nó phải chấp nhận `@mikro-orm/core` vừa cài và Nest 12. Nếu peer không khớp thì dừng theo Global Constraints.

- [ ] **Step 2: Config và hằng số**

`src/core/database/constants.ts`:
```ts
export const DB_CONTEXT = { app: 'app', relay: 'relay' } as const;
/** Tên biến session Postgres mang org hiện tại. Trùng với hàm SQL app_current_org() trong migration core_bootstrap. */
export const ORG_SESSION_VAR = 'app.org_id';
export const CORE_MIGRATIONS_TABLE = 'mikro_orm_migrations';
export const FIXTURE_MIGRATIONS_TABLE = 'mikro_orm_migrations_fixtures';
export const DIST_MIGRATIONS = { path: 'dist/migrations', glob: '**/*.js' } as const;
```
`src/core/database/database.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';

export const databaseConfig = defineConfig(
  'database',
  {
    host: 'DB_HOST', port: 'DB_PORT', name: 'DB_NAME',
    appUser: 'DB_APP_USER', appPassword: 'DB_APP_PASSWORD',
    relayHost: 'DB_RELAY_HOST', relayPort: 'DB_RELAY_PORT', relayUser: 'DB_RELAY_USER', relayPassword: 'DB_RELAY_PASSWORD',
    ownerUser: 'DB_OWNER_USER', ownerPassword: 'DB_OWNER_PASSWORD',
    poolMax: 'DB_POOL_MAX', relayPoolMax: 'DB_RELAY_POOL_MAX',
    workerStatementTimeoutMs: 'DB_WORKER_STATEMENT_TIMEOUT_MS',
    migrationLockTimeoutMs: 'DB_MIGRATION_LOCK_TIMEOUT_MS', migrationStatementTimeoutMs: 'DB_MIGRATION_STATEMENT_TIMEOUT_MS',
    txRetryAttempts: 'DB_TX_RETRY_ATTEMPTS', txRetryBaseMs: 'DB_TX_RETRY_BASE_MS',
    sslMode: 'DB_SSL_MODE', sslCaPath: 'DB_SSL_CA_PATH',
    debug: 'DB_DEBUG',
  },
  z.object({
    host: z.string().min(1).describe('Host for the app connection (PgBouncer in production)'),
    port: z.coerce.number().int().positive().default(5432).describe('Port for the app connection'),
    name: z.string().min(1).describe('Database name'),
    appUser: z.string().default('app_user').describe('Role for api/worker business queries (RLS enforced)'),
    appPassword: z.string().min(1).describe('Password of app role'),
    relayHost: z.string().optional().describe('Host for the relay connection (defaults to DB_HOST); worker only'),
    relayPort: z.coerce.number().int().positive().optional().describe('Port for the relay connection (defaults to DB_PORT)'),
    relayUser: z.string().default('app_relay').describe('Role for outbox relay, cleanup, reconcile, metrics (no BYPASSRLS)'),
    relayPassword: z.string().optional().describe('Password of relay role (required for worker)'),
    ownerUser: z.string().default('app_owner').describe('Role that owns tables and runs migrations'),
    ownerPassword: z.string().optional().describe('Password of owner role (required only for migrate)'),
    poolMax: z.coerce.number().int().positive().default(10).describe('Max app connections per process'),
    relayPoolMax: z.coerce.number().int().positive().default(2).describe('Max relay connections per worker'),
    workerStatementTimeoutMs: z.coerce.number().int().positive().default(60000).describe('statement_timeout applied with SET LOCAL in worker transactions (role default applies elsewhere)'),
    migrationLockTimeoutMs: z.coerce.number().int().positive().default(5000).describe('lock_timeout during migrations'),
    migrationStatementTimeoutMs: z.coerce.number().int().positive().default(600000).describe('statement_timeout during migrations'),
    txRetryAttempts: z.coerce.number().int().min(0).max(10).default(3).describe('Retries for serialization failures/deadlocks (outermost transaction only)'),
    txRetryBaseMs: z.coerce.number().int().positive().default(20).describe('Base delay for transaction retry backoff (full jitter)'),
    sslMode: z.enum(['disable', 'require', 'verify-full']).default('disable').describe('TLS to Postgres/PgBouncer'),
    sslCaPath: z.string().optional().describe('CA bundle path for verify-full'),
    debug: z.stringbool().default(false).describe('Log SQL (development only)'),
  }),
);

defineProductionRule('database-tls', (c) => (c.database?.sslMode === 'disable' ? 'DB_SSL_MODE must not be disable in production' : undefined));
defineProductionRule('database-no-debug', (c) => (c.database?.debug ? 'DB_DEBUG must be false in production' : undefined));
```
Thêm vào `all-configs.ts`. `DB_SSL_MODE` mặc định `disable` chỉ hợp lệ ngoài production (rule trên chặn production).

- [ ] **Step 3: Migration đầu tiên bằng CLI (S4, S5) và hàm `app_current_org()`**

`mikro-orm.config.ts` ở root (file CLI đọc; chỉ dùng khi **tạo** migration, không dùng lúc chạy):
```ts
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  extensions: [Migrator],
  entities: [],
  discovery: { warnWhenNoEntities: false },
  migrations: { path: 'dist/migrations', pathTs: 'src/migrations', glob: '**/*.{js,ts}', emit: 'ts', snapshot: false },
});
```
```bash
pnpm mikro-orm --help
pnpm mikro-orm migration:create --help
pnpm mikro-orm migration:create --blank --path src/migrations/core --name core_bootstrap
```
Nếu CLI không có `--path` thì làm theo `--help`. S4: sau khi build (`pnpm build`), `dist/migrations/core/*.js` phải tồn tại và runner (Step 6) phải thấy migration trong thư mục con với `glob: '**/*.js'`. Nếu glob không quét thư mục con thì dùng một thư mục `src/migrations/` với tiền tố module trong tên file, ghi ADR 0003.

Thân `core_bootstrap` (S5 kiểm tra `uuidv7()`; tạo hàm fail-closed dùng cho mọi policy RLS):
```ts
async up(): Promise<void> {
  this.addSql(`SELECT uuidv7();`);
  this.addSql(`CREATE FUNCTION app_current_org() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
    DECLARE v text := current_setting('app.org_id', true);
    BEGIN
      IF v IS NULL OR v = '' THEN
        RAISE EXCEPTION 'org context is not set' USING HINT = 'run the query inside OrgScope.run';
      END IF;
      RETURN v::uuid;
    END $$;`);
  this.addSql(`REVOKE ALL ON FUNCTION app_current_org() FROM PUBLIC;`);
  this.addSql(`GRANT EXECUTE ON FUNCTION app_current_org() TO app_user, app_relay;`);
}
async down(): Promise<void> {
  this.addSql(`DROP FUNCTION app_current_org();`);
}
```
`current_setting(…, true)` trả `NULL` khi chưa từng set, và trả chuỗi rỗng khi connection trong pool đã từng set rồi reset; cả hai đều ném lỗi. Nếu `uuidv7()` không có thì bỏ dòng đó, sinh UUID ở app bằng `uuid` v7, ghi ADR 0009.

- [ ] **Step 4: Viết test trước**

`test/support/db.ts`:
```ts
import { getInfra } from './infra.js';

export function dbEnv(): Record<string, string> {
  const { pg, pgbouncer } = getInfra();
  return {
    DB_HOST: pgbouncer.host, DB_PORT: String(pgbouncer.port), DB_NAME: pg.database,
    DB_APP_USER: pg.app.user, DB_APP_PASSWORD: pg.app.password,
    DB_RELAY_HOST: pg.host, DB_RELAY_PORT: String(pg.port), DB_RELAY_USER: pg.relay.user, DB_RELAY_PASSWORD: pg.relay.password,
    DB_OWNER_USER: pg.owner.user, DB_OWNER_PASSWORD: pg.owner.password,
  };
}
```
Connection `app` trong test **đi qua PgBouncer**, giống production. Sửa `baseTestEnv()` (`test/support/env.ts`): thêm `...dbEnv()` (import từ `./db.js`).

`test/integration/core/database/unit-of-work.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule, Db, UnitOfWork } from '../../../../src/core/database/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

describe('UnitOfWork + Db', () => {
  let app: INestApplication; let uow: UnitOfWork; let repo: FixtureRepo; let db: Db;
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), FixtureModule]);
    uow = app.get(UnitOfWork); repo = app.get(FixtureRepo); db = app.get(Db);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('commits all writes when fn resolves', async () => {
    const body = `commit-${Date.now()}`;
    await uow.run(() => repo.insertSystemNote(body));
    expect(await repo.countSystemNotes(body)).toBe(1);
  });

  it('rolls back every write in the unit when fn throws', async () => {
    const body = `rollback-${Date.now()}`;
    await expect(uow.run(async () => { await repo.insertSystemNote(body); await repo.insertSystemNote(body); throw new Error('fail'); })).rejects.toThrow('fail');
    expect(await repo.countSystemNotes(body)).toBe(0);
  });

  it('nested run joins the outer transaction', async () => {
    const body = `nested-${Date.now()}`;
    await expect(uow.run(async () => { await uow.run(() => repo.insertSystemNote(body)); throw new Error('outer'); })).rejects.toThrow('outer');
    expect(await repo.countSystemNotes(body)).toBe(0);
  });

  it('statements inside the unit share one connection (same backend pid)', async () => {
    const pids = await uow.run(async () => {
      const a = await db.execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const b = await db.execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return [a[0]!.pid, b[0]!.pid];
    });
    expect(pids[0]).toBe(pids[1]);
  });

  it('runs as app_user through PgBouncer with the role statement_timeout', async () => {
    const [row] = await db.execute<{ u: string; t: string }>('SELECT current_user AS u, current_setting(\'statement_timeout\') AS t');
    expect(row!.u).toBe('app_user');
    expect(row!.t).not.toBe('0');
  });

  it('worker role applies its longer statement_timeout inside transactions', async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    const worker = await createTestApp([DatabaseModule.forRoot({ relay: false }), FixtureModule]);
    try {
      const t = await worker.get(UnitOfWork).run(async () => (await worker.get(Db).execute<{ t: string }>('SELECT current_setting(\'statement_timeout\') AS t'))[0]!.t);
      expect(t).not.toBe((await db.execute<{ t: string }>('SELECT current_setting(\'statement_timeout\') AS t'))[0]!.t);
    } finally {
      await worker.close();
      vi.stubEnv('APP_ROLE', 'api');
    }
  });
});
```
`test/integration/core/database/migrations.spec.ts`:
```ts
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import { coreMigrationList } from '../../../support/migrate-test-db.js';

describe('migrations', () => {
  applyTestEnv();
  const source = { kind: 'list' as const, list: coreMigrationList() };
  afterAll(async () => { await runMigrations('up', { source }); });

  it('refuses down without an explicit target', async () => {
    await expect(runMigrations('down', { source })).rejects.toThrow(/explicit target/);
  });
  it('refuses down to an unknown migration name', async () => {
    await expect(runMigrations('down', { source, to: 'Migration_typo' })).rejects.toThrow(/not an executed migration/);
  });
  it('up → down to 0 → up is repeatable', async () => {
    await runMigrations('down', { source, to: '0' });
    expect((await runMigrations('status', { source })).length).toBeGreaterThan(0);
    await runMigrations('up', { source });
    expect(await runMigrations('status', { source })).toEqual([]);
  });
});
```
Run: `pnpm test:int` → FAIL.

- [ ] **Step 5: `TxEm`, `UnitOfWork`, `Db`, `RelayDb`, module**

Verify trước khi code, trong tài liệu và `.d.ts` của MikroORM 7 đã cài:
- (a) `@InjectEntityManager(name)` và `getEntityManagerToken(name)` của `@mikro-orm/nestjs` khi có `contextName`;
- (b) `em.execute(sql, params)` của `SqlEntityManager` chạy trên transaction hiện tại và áp session context (`node_modules/@mikro-orm/sql/…`);
- (c) `em.transactional(cb, { isolationLevel })` giữ `session` của EM được fork (option `keepTransactionContext`/session trên fork);
- (d) cách truyền TLS (`ssl`) và `max` pool cho driver PostgreSQL (Kysely + `pg`) trong v7 — `driverOptions` hoặc `pool`.
Code dưới đây viết theo API đã đọc được; tên nào khác thì sửa theo tài liệu.

`src/core/database/entities.ts`:
```ts
import type { EntitySchema } from '@mikro-orm/core';

const schemas: EntitySchema[] = [];
export function registerEntities(...list: EntitySchema[]): void {
  for (const s of list) if (!schemas.includes(s)) schemas.push(s);
}
export const allEntities = (): EntitySchema[] => [...schemas];
```
`src/core/database/unit-of-work.ts`:
```ts
export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

export abstract class UnitOfWork {
  abstract run<T>(fn: () => Promise<T>, opts?: { isolation?: Isolation }): Promise<T>;
  abstract inTransaction(): boolean;
}
```
`src/core/database/tx-em.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager, type ForkOptions } from '@mikro-orm/postgresql';
import { ClsService } from 'nestjs-cls';
import { CTX } from '../context/index.js';
import { DB_CONTEXT } from './constants.js';

@Injectable()
export class TxEm {
  constructor(@InjectEntityManager(DB_CONTEXT.app) private readonly root: EntityManager, private readonly cls: ClsService) {}

  current(): EntityManager | undefined {
    return this.cls.isActive() ? this.cls.get<EntityManager>(CTX.em) : undefined;
  }
  get(): EntityManager {
    const em = this.current();
    if (!em) throw new Error('No EntityManager in context: call inside UnitOfWork.run or OrgScope.run');
    return em;
  }
  fork(opts?: ForkOptions): EntityManager {
    return this.root.fork(opts);
  }
  bind<T>(em: EntityManager, fn: () => Promise<T>): Promise<T> {
    const run = async () => { this.cls.set(CTX.em, em); return fn(); };
    return this.cls.isActive() ? this.cls.run({ ifNested: 'inherit' }, run) : this.cls.run(run);
  }
}
```
Không dùng `getContext()`: EM toàn cục bị tắt (`allowGlobalContext: false`), mọi truy cập DB đi qua EM được fork và gắn vào CLS.

`src/core/database/db.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { TxEm } from './tx-em.js';

/** SQL trên connection `app`. Trong UnitOfWork/OrgScope thì dùng đúng transaction và session RLS hiện tại; ngoài đó thì fork mới (không có org → bảng tenant fail-closed). */
@Injectable()
export class Db {
  constructor(private readonly txEm: TxEm) {}
  execute<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (this.txEm.current() ?? this.txEm.fork()).execute<T[]>(sql, params);
  }
}
```
`src/core/database/relay-db.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { DB_CONTEXT } from './constants.js';

export type SqlTx = { execute<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> };

/** Connection `relay` (role app_relay): chỉ có quyền trên bảng hạ tầng được GRANT trong migration. Chỉ có trong worker. */
@Injectable()
export class RelayDb {
  constructor(@InjectEntityManager(DB_CONTEXT.relay) private readonly root: EntityManager) {}
  execute<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.root.fork().execute<T[]>(sql, params);
  }
  transaction<R>(fn: (tx: SqlTx) => Promise<R>): Promise<R> {
    return this.root.fork().transactional((em) => fn({ execute: <T extends object>(sql: string, params: unknown[] = []) => em.execute<T[]>(sql, params) }));
  }
}
```
`src/core/database/mikro-orm-unit-of-work.ts` (retry lỗi `40001`/`40P01` được thêm ở Task 7 Step 4):
```ts
import { Inject, Injectable } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import { type ConfigOf, appConfig } from '../config/index.js';
import { databaseConfig } from './database.config.js';
import { TxEm } from './tx-em.js';
import { UnitOfWork, type Isolation } from './unit-of-work.js';

const ISOLATION: Record<Isolation, IsolationLevel> = {
  'read committed': IsolationLevel.READ_COMMITTED,
  'repeatable read': IsolationLevel.REPEATABLE_READ,
  serializable: IsolationLevel.SERIALIZABLE,
};

@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    private readonly txEm: TxEm,
    @Inject(databaseConfig.KEY) private readonly cfg: ConfigOf<typeof databaseConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
  ) { super(); }

  inTransaction(): boolean {
    return this.txEm.current()?.isInTransaction() ?? false;
  }

  run<T>(fn: () => Promise<T>, opts: { isolation?: Isolation } = {}): Promise<T> {
    const bound = this.txEm.current();
    if (bound?.isInTransaction()) return fn();
    const base = bound ?? this.txEm.fork();
    return base.transactional(async (tx) => {
      if (this.app.role === 'worker') {
        await tx.execute(`SELECT set_config('statement_timeout', ?, true)`, [`${this.cfg.workerStatementTimeoutMs}ms`]);
      }
      return this.txEm.bind(tx, fn);
    }, opts.isolation ? { isolationLevel: ISOLATION[opts.isolation] } : undefined);
  }
}
```
`src/core/database/database.module.ts` (khung bằng `pnpm nest g module core/database --no-spec`):
```ts
import { DynamicModule, Global, Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { type ConfigOf } from '../config/index.js';
import { DB_CONTEXT } from './constants.js';
import { allEntities } from './entities.js';
import { databaseConfig } from './database.config.js';
import { Db } from './db.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';
import { RelayDb } from './relay-db.js';
import { TxEm } from './tx-em.js';
import { UnitOfWork } from './unit-of-work.js';

type DbCfg = ConfigOf<typeof databaseConfig>;

function tls(db: DbCfg) {
  if (db.sslMode === 'disable') return false;
  return { rejectUnauthorized: db.sslMode === 'verify-full', ...(db.sslCaPath ? { ca: readFileSync(db.sslCaPath, 'utf8') } : {}) };
}

function ormOptions(db: DbCfg, who: 'app' | 'relay') {
  if (who === 'relay' && !db.relayPassword) throw new Error('DB_RELAY_PASSWORD is required when the relay connection is enabled (worker)');
  return {
    driver: PostgreSqlDriver,
    entities: allEntities(),
    discovery: { warnWhenNoEntities: false },
    host: who === 'app' ? db.host : (db.relayHost ?? db.host),
    port: who === 'app' ? db.port : (db.relayPort ?? db.port),
    dbName: db.name,
    user: who === 'app' ? db.appUser : db.relayUser,
    password: who === 'app' ? db.appPassword : db.relayPassword,
    pool: { min: 0, max: who === 'app' ? db.poolMax : db.relayPoolMax },
    driverOptions: { ssl: tls(db) },
    sessionContext: 'transaction' as const,
    debug: db.debug,
    allowGlobalContext: false,
    registerRequestContext: false,
  };
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(opts: { relay: boolean }): DynamicModule {
    const contexts = [
      MikroOrmModule.forRootAsync({ contextName: DB_CONTEXT.app, inject: [databaseConfig.KEY], useFactory: (db: DbCfg) => ormOptions(db, 'app'), driver: PostgreSqlDriver }),
      ...(opts.relay
        ? [MikroOrmModule.forRootAsync({ contextName: DB_CONTEXT.relay, inject: [databaseConfig.KEY], useFactory: (db: DbCfg) => ormOptions(db, 'relay'), driver: PostgreSqlDriver })]
        : []),
    ];
    return {
      module: DatabaseModule,
      imports: contexts,
      providers: [TxEm, Db, { provide: UnitOfWork, useClass: MikroOrmUnitOfWork }, ...(opts.relay ? [RelayDb] : [])],
      exports: [TxEm, Db, UnitOfWork, ...(opts.relay ? [RelayDb] : [])],
    };
  }
}
```
Không có `statement_timeout` qua startup parameter (PgBouncer bỏ đi); timeout nằm trên role (Task 2) và `SET LOCAL` cho worker.

- [ ] **Step 6: Migration runner, entrypoint `migrate`, migrate test DB một lần**

Verify: `migrationsList`, `tableName`, `orm.migrator.up/down/getPending/getExecuted` (tên chính xác) và kiểu `MigrationObject` trong `node_modules/@mikro-orm/migrations`/`https://mikro-orm.io/docs/migrations`.

`src/core/database/migrator.ts`:
```ts
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator, type MigrationObject } from '@mikro-orm/migrations';
import { databaseConfig } from './database.config.js';
import { CORE_MIGRATIONS_TABLE, DIST_MIGRATIONS } from './constants.js';

export type MigrationSource = { kind: 'dist' } | { kind: 'list'; list: MigrationObject[] };
const DOWN_ALL = '0';

export async function runMigrations(
  cmd: 'up' | 'down' | 'status',
  opts: { to?: string; source?: MigrationSource; tableName?: string } = {},
): Promise<string[]> {
  const db = databaseConfig();
  if (!db.ownerPassword) throw new Error('DB_OWNER_PASSWORD is required to run migrations');
  const source = opts.source ?? { kind: 'dist' };
  const orm = await MikroORM.init({
    extensions: [Migrator],
    entities: [],
    discovery: { warnWhenNoEntities: false },
    host: db.relayHost ?? db.host, port: db.relayPort ?? db.port, dbName: db.name,
    user: db.ownerUser, password: db.ownerPassword,
    migrations: {
      tableName: opts.tableName ?? CORE_MIGRATIONS_TABLE,
      transactional: true, allOrNothing: true, snapshot: false,
      ...(source.kind === 'list' ? { migrationsList: source.list } : { path: DIST_MIGRATIONS.path, glob: DIST_MIGRATIONS.glob }),
    },
  });
  try {
    const conn = orm.em.getConnection();
    await conn.execute(`SELECT set_config('lock_timeout', ?, false), set_config('statement_timeout', ?, false)`, [`${db.migrationLockTimeoutMs}ms`, `${db.migrationStatementTimeoutMs}ms`]);
    if (cmd === 'up') return (await orm.migrator.up()).map((m) => m.name);
    if (cmd === 'status') return (await orm.migrator.getPending()).map((m) => m.name);
    if (!opts.to) throw new Error('migrate down requires an explicit target: a migration name, or 0 to revert everything');
    if (opts.to !== DOWN_ALL) {
      const executed = (await orm.migrator.getExecuted()).map((m) => m.name);
      if (!executed.includes(opts.to)) throw new Error(`"${opts.to}" is not an executed migration; refusing to migrate down`);
    }
    return (await orm.migrator.down({ to: opts.to === DOWN_ALL ? 0 : opts.to })).map((m) => m.name);
  } finally {
    await orm.close(true);
  }
}
```
Migration luôn chạy **thẳng Postgres** (host relay/`DB_HOST` trực tiếp, không qua PgBouncer transaction mode), vì `set_config(..., false)` là session-level và migration cần một session.

`src/main.migrate.ts`:
```ts
import './core/config/all-configs.js';
import { validateAllConfigs } from './core/config/index.js';
import { runMigrations } from './core/database/migrator.js';

const COMMANDS = ['up', 'down', 'status'] as const;
type Cmd = (typeof COMMANDS)[number];
const isCmd = (v: string): v is Cmd => (COMMANDS as readonly string[]).includes(v);

async function main(): Promise<void> {
  process.env.APP_ROLE = 'migrate';
  validateAllConfigs();
  const [cmd = 'up', to] = process.argv.slice(2);
  if (!isCmd(cmd)) throw new Error(`Unknown command "${cmd}". Use: ${COMMANDS.join(' | ')}`);
  const names = await runMigrations(cmd, { to });
  process.stdout.write(`${JSON.stringify({ cmd, migrations: names })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
```
Script: `"migrate": "node dist/main.migrate.js"`.

`test/support/migrate-test-db.ts`:
```ts
import type { MigrationObject } from '@mikro-orm/migrations';
import { FIXTURE_MIGRATIONS_TABLE, runMigrations } from '../../src/core/database/index.js';

type Mod = Record<string, unknown>;
const isMigrationClass = (v: unknown): v is MigrationObject['class'] => typeof v === 'function' && /^Migration/.test((v as { name: string }).name);

function toList(mods: Record<string, Mod>): MigrationObject[] {
  return Object.values(mods)
    .flatMap((m) => Object.values(m).filter(isMigrationClass))
    .map((cls) => ({ name: cls.name, class: cls }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export const coreMigrationList = (): MigrationObject[] => toList(import.meta.glob<Mod>('../../src/migrations/**/*.ts', { eager: true }));
export const fixtureMigrationList = (): MigrationObject[] => toList(import.meta.glob<Mod>('../fixtures/migrations/*.ts', { eager: true }));

export async function migrateTestDb(): Promise<void> {
  await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
  await runMigrations('up', { source: { kind: 'list', list: fixtureMigrationList() }, tableName: FIXTURE_MIGRATIONS_TABLE });
}
```
Verify: `import.meta.glob` hoạt động trong file `globalSetup` và file test của Vitest (được transform bởi Vite). Nếu không, đổi sang `readdirSync` + `await import(path)` trong cùng context Vite.

Sửa `test/support/infra.global-setup.ts`: sau khi các container sẵn sàng và trước `project.provide`, set env DB (owner/relay/app) vào `process.env` và gọi `await migrateTestDb()`. Test không bao giờ tự gọi `runMigrations('up')` trong `beforeAll`.

`src/core/database/index.ts`:
```ts
export { DatabaseModule } from './database.module.js';
export { DB_CONTEXT, ORG_SESSION_VAR, CORE_MIGRATIONS_TABLE, FIXTURE_MIGRATIONS_TABLE } from './constants.js';
export { UnitOfWork, type Isolation } from './unit-of-work.js';
export { TxEm } from './tx-em.js';
export { Db } from './db.js';
export { RelayDb, type SqlTx } from './relay-db.js';
export { registerEntities, allEntities } from './entities.js';
export { runMigrations, type MigrationSource } from './migrator.js';
export { databaseConfig } from './database.config.js';
```

- [ ] **Step 7: Fixture**

```bash
pnpm mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_notes
```
```ts
async up(): Promise<void> {
  this.addSql(`CREATE TABLE fixture_notes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  this.addSql(`CREATE INDEX fixture_notes_body_idx ON fixture_notes (body);`);
  this.addSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_notes TO app_user;`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE fixture_notes;`);
}
```
`test/fixtures/fixture.entity.ts`:
```ts
import { defineEntity, p } from '@mikro-orm/core';
import { registerEntities } from '../../src/core/database/index.js';

export const FixtureNote = defineEntity({
  name: 'FixtureNote',
  tableName: 'fixture_notes',
  properties: {
    id: p.bigint().primary(),
    body: p.text(),
    createdAt: p.datetime().fieldName('created_at').onCreate(() => new Date()),
    updatedAt: p.datetime().fieldName('updated_at').onCreate(() => new Date()).onUpdate(() => new Date()),
  },
});
registerEntities(FixtureNote);
```
Verify: builder `p.bigint()`, `p.text()`, `.fieldName()` và kiểu trả về của `defineEntity` có đăng ký được như `EntitySchema` không (`https://mikro-orm.io/docs/define-entity`). Sửa theo tài liệu.

`test/fixtures/fixture.module.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { Db } from '../../src/core/database/index.js';
import './fixture.entity.js';

@Injectable()
export class FixtureRepo {
  constructor(private readonly db: Db) {}
  async insertSystemNote(body: string): Promise<void> {
    await this.db.execute('INSERT INTO fixture_notes (body) VALUES (?)', [body]);
  }
  async countSystemNotes(body: string): Promise<number> {
    const rows = await this.db.execute<{ n: string }>('SELECT count(*)::text AS n FROM fixture_notes WHERE body = ?', [body]);
    return Number(rows[0]!.n);
  }
}

@Module({ providers: [FixtureRepo], exports: [FixtureRepo] })
export class FixtureModule {}
```

Run: `pnpm build && pnpm test:int`
Expected: PASS các test ở Step 4. Chạy tay với compose: `pnpm build && pnpm migrate up && pnpm migrate status` → `[]`; `ls dist/migrations/core` có file `.js` (S4 đạt).

- [ ] **Step 8: ADR 0003, 0009 và commit**

`docs/adr/0003-orm-mikro-orm.md`: MikroORM 7.2 pin chính xác, `@mikro-orm/nestjs` phát hành riêng; 2 connection `app`/`relay`; không dùng EM toàn cục; SQL qua `Db`/`RelayDb` (`em.execute`); kết quả S4; timeout theo role. `docs/adr/0009-id-strategy.md`: PK bigint, `public_id` UUIDv7, kết quả S5.
```bash
git add -A
git commit -m "feat(core): mikro-orm app/relay connections, unit of work, db executors, guarded migration runner"
```

---

### Task 6: 3 entrypoint và 2 module gốc

**Files:**
- Create: `src/app-api.module.ts`, `src/app-worker.module.ts`, `src/app.modules.ts`, `src/main.api.ts`, `src/main.worker.ts`, `src/core/http/http.config.ts` (bản tối thiểu)
- Delete: `src/main.ts`, `src/app.module.ts`, `src/app.controller.ts`, `src/app.service.ts`
- Modify: `nest-cli.json`, `package.json` scripts
- Test: `test/e2e/core/entrypoints.e2e.spec.ts`

**Interfaces:**
- Consumes: `ContextModule`, `LoggingModule`, `DatabaseModule`, `ProblemDetailsFilter`, `configFactories()`, `validateAllConfigs()`
- Produces:
  - `APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] }` (vùng dự án)
  - `bootstrapApi(opts?: { listen?: boolean }): Promise<INestApplication>`, `bootstrapWorker(): Promise<INestApplicationContext>`
  - Tắt êm do entrypoint điều phối (`installShutdown(app)`, hoàn thiện ở Task 16/18): SIGTERM → `app.close()` → flush telemetry → `process.exit(0)`

- [ ] **Step 1: Viết test trước**

`test/e2e/core/entrypoints.e2e.spec.ts`:
```ts
import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv } from '../../support/app-factory.js';
import { bootstrapApi } from '../../../src/main.api.js';
import { bootstrapWorker } from '../../../src/main.worker.js';

describe('entrypoints', () => {
  applyTestEnv();
  afterAll(() => vi.unstubAllEnvs());

  it('api boots with core modules and serves 404 as problem+json', async () => {
    const app = await bootstrapApi({ listen: false });
    const res = await request(app.getHttpServer()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    await app.close();
  });

  it('worker boots and closes cleanly', async () => {
    const ctx = await bootstrapWorker();
    await ctx.close();
  });

  it('fails fast listing every missing required variable', async () => {
    vi.stubEnv('DB_APP_PASSWORD', '');
    vi.stubEnv('DB_NAME', '');
    await expect(bootstrapApi({ listen: false })).rejects.toThrow(/DB_APP_PASSWORD[\s\S]*DB_NAME|DB_NAME[\s\S]*DB_APP_PASSWORD/);
    applyTestEnv();
  });
});
```
Run: `pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 2: Cài đặt**

`src/app.modules.ts` (dự án sở hữu):
```ts
import type { DynamicModule, Type } from '@nestjs/common';

type ModuleImport = Type<unknown> | DynamicModule;

/** Module nền và feature mà dự án bật. Boilerplate để trống. */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = { api: [], worker: [] };
```
`src/app-api.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import './core/config/all-configs.js';
import { configFactories } from './core/config/index.js';
import { ContextModule } from './core/context/index.js';
import { DatabaseModule } from './core/database/index.js';
import { ProblemDetailsFilter } from './core/errors/index.js';
import { LoggingModule } from './core/logging/index.js';
import { APP_MODULES } from './app.modules.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: configFactories(), cache: true }),
    ContextModule,
    LoggingModule,
    DatabaseModule.forRoot({ relay: false }),
    ...APP_MODULES.api,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppApiModule {}
```
`src/app-worker.module.ts`: như trên nhưng `DatabaseModule.forRoot({ relay: true })`, không có `APP_FILTER`, dùng `APP_MODULES.worker`.

`src/core/http/http.config.ts` (bản tối thiểu, Task 12 mở rộng):
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const httpConfig = defineConfig(
  'http',
  { port: 'HTTP_PORT', host: 'HTTP_HOST' },
  z.object({
    port: z.coerce.number().int().min(0).default(3000).describe('HTTP listen port'),
    host: z.string().default('0.0.0.0').describe('HTTP listen host'),
  }),
);
```
Thêm vào `all-configs.ts`.

`src/main.api.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { pathToFileURL } from 'node:url';
import { AppApiModule } from './app-api.module.js';
import { validateAllConfigs } from './core/config/index.js';
import { httpConfig } from './core/http/http.config.js';

export async function bootstrapApi(opts: { listen?: boolean } = {}): Promise<INestApplication> {
  process.env.APP_ROLE = 'api';
  validateAllConfigs();
  const app = await NestFactory.create(AppApiModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  if (opts.listen === false) {
    await app.init();
    return app;
  }
  const http = httpConfig();
  await app.listen(http.port, http.host);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  bootstrapApi()
    .then((app) => process.once('SIGTERM', () => { void app.close().then(() => process.exit(0)); }))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}
```
`src/main.worker.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { pathToFileURL } from 'node:url';
import { AppWorkerModule } from './app-worker.module.js';
import { validateAllConfigs } from './core/config/index.js';

export async function bootstrapWorker(): Promise<INestApplicationContext> {
  process.env.APP_ROLE = 'worker';
  validateAllConfigs();
  const ctx = await NestFactory.createApplicationContext(AppWorkerModule, { bufferLogs: true });
  ctx.useLogger(ctx.get(Logger));
  await ctx.init();
  return ctx;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  bootstrapWorker()
    .then((ctx) => process.once('SIGTERM', () => { void ctx.close().then(() => process.exit(0)); }))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}
```
Không dùng `enableShutdownHooks()`: entrypoint tự bắt SIGTERM để điều phối thứ tự (Task 16 thêm flush telemetry, Task 18 thêm draining). Xoá file mẫu của CLI. Scripts:
```json
"start:api": "node dist/main.api.js",
"start:worker": "node dist/main.worker.js",
"start:dev": "nest start -b swc --watch --entryFile main.api"
```
Verify: `nest start --help` có `--entryFile` (nếu không thì đặt `entryFile` trong `nest-cli.json`).

Run: `pnpm build && pnpm test:int` → PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: api, worker and migrate entrypoints with fail-fast config validation"
```

---

### Task 7: `OrgScope` + RLS fail-closed + map lỗi DB + retry transaction

**Files:**
- Create: `src/core/database/org-scope.ts`, `src/core/database/db-error.mapper.ts`, migration fixture `fixture_org_notes`, migration fixture `fixture_constraints` (tên file do CLI đặt)
- Modify: `src/core/database/{mikro-orm-unit-of-work.ts,database.module.ts,index.ts}`, `test/fixtures/fixture.module.ts`
- Test: `test/integration/core/database/org-scope.spec.ts`, `test/integration/core/database/db-errors.spec.ts`

**Interfaces:**
- Consumes: `TxEm`, `Db`, `UnitOfWork`, `RequestContext`, `ORG_SESSION_VAR`, `CoreErrors`, `AppError`, `registerErrorMapper`
- Produces:
  - `OrgScope.run<T>(orgId: string, fn: () => Promise<T>): Promise<T>` — fork EM với session `app.org_id`, gắn vào CLS, set `RequestContext.orgId`. Gọi khi đang ở trong transaction: cùng org thì chạy luôn trong transaction đó; khác org thì ném lỗi
  - `defineConstraintErrors(map: Record<string, ErrorCode>): void`, `dbErrorMapper: ErrorMapper`, `PG` (SQLSTATE), `isRetryableTxError(err): boolean`
  - Mẫu policy RLS chuẩn cho mọi bảng tenant: `USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`

- [ ] **Step 1: Bảng fixture có RLS và test**

```bash
pnpm mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_org_notes
```
```ts
async up(): Promise<void> {
  this.addSql(`CREATE TABLE fixture_org_notes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  this.addSql(`CREATE INDEX fixture_org_notes_org_id_idx ON fixture_org_notes (org_id, id);`);
  this.addSql(`ALTER TABLE fixture_org_notes ENABLE ROW LEVEL SECURITY;`);
  this.addSql(`ALTER TABLE fixture_org_notes FORCE ROW LEVEL SECURITY;`);
  this.addSql(`CREATE POLICY fixture_org_notes_isolation ON fixture_org_notes
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
  this.addSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_org_notes TO app_user;`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE fixture_org_notes;`);
}
```
Thêm vào `FixtureRepo`:
```ts
async insertOrgNote(orgId: string, body: string): Promise<void> {
  await this.db.execute('INSERT INTO fixture_org_notes (org_id, body) VALUES (?, ?)', [orgId, body]);
}
async listOrgBodies(): Promise<string[]> {
  return (await this.db.execute<{ body: string }>('SELECT body FROM fixture_org_notes ORDER BY id')).map((r) => r.body);
}
```
`test/integration/core/database/org-scope.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule, OrgScope, UnitOfWork } from '../../../../src/core/database/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const ORG_CONTEXT_MISSING = /org context is not set/;

describe('OrgScope + RLS', () => {
  let app: INestApplication; let scope: OrgScope; let uow: UnitOfWork; let repo: FixtureRepo;
  const orgA = randomUUID(); const orgB = randomUUID();

  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), FixtureModule]);
    scope = app.get(OrgScope); uow = app.get(UnitOfWork); repo = app.get(FixtureRepo);
    await scope.run(orgA, () => uow.run(() => repo.insertOrgNote(orgA, 'a1')));
    await scope.run(orgB, () => uow.run(() => repo.insertOrgNote(orgB, 'b1')));
  });
  afterAll(async () => { await app.close(); });

  it('only sees rows of the current org', async () => {
    const bodies = await scope.run(orgA, () => uow.run(() => repo.listOrgBodies()));
    expect(bodies).toContain('a1');
    expect(bodies).not.toContain('b1');
  });

  it('fails closed without org context', async () => {
    await expect(uow.run(() => repo.listOrgBodies())).rejects.toThrow(ORG_CONTEXT_MISSING);
    await expect(repo.listOrgBodies()).rejects.toThrow(ORG_CONTEXT_MISSING);
  });

  it('reused pooled connection still fails closed after a scoped query', async () => {
    for (let i = 0; i < 5; i++) {
      await scope.run(orgA, () => uow.run(() => repo.listOrgBodies()));
      await expect(uow.run(() => repo.listOrgBodies())).rejects.toThrow(ORG_CONTEXT_MISSING);
    }
  });

  it('cannot write a row for another org', async () => {
    await expect(scope.run(orgA, () => uow.run(() => repo.insertOrgNote(orgB, 'evil')))).rejects.toThrow(/row-level security/);
  });

  it('rejects empty/invalid orgId before touching the database', async () => {
    await expect(scope.run('', async () => 1)).rejects.toBeInstanceOf(AppError);
    await expect(scope.run('not-a-uuid', async () => 1)).rejects.toBeInstanceOf(AppError);
  });

  it('nested scope with the same org joins the transaction; with a different org is rejected', async () => {
    const body = `nested-${Date.now()}`;
    await expect(scope.run(orgA, () => uow.run(async () => {
      await scope.run(orgA, () => repo.insertOrgNote(orgA, body));
      throw new Error('rollback');
    }))).rejects.toThrow('rollback');
    expect(await scope.run(orgA, () => uow.run(() => repo.listOrgBodies()))).not.toContain(body);
    await expect(scope.run(orgA, () => uow.run(() => scope.run(orgB, async () => 1)))).rejects.toThrow(/different organization/);
  });
});
```
Run: `pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 2: Cài đặt `OrgScope`**

Verify: `em.fork({ session: { variables } })` và việc session được áp sau `BEGIN` của `em.transactional` trên EM đã fork (`https://mikro-orm.io/docs/row-level-security`). Ghi kết quả vào ADR 0005.

`src/core/database/org-scope.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { ORG_SESSION_VAR } from './constants.js';
import { TxEm } from './tx-em.js';

const OrgId = z.uuid();

@Injectable()
export class OrgScope {
  constructor(private readonly txEm: TxEm, private readonly ctx: RequestContext) {}

  run<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    if (!OrgId.safeParse(orgId).success) {
      return Promise.reject(new AppError(CoreErrors.ORG_CONTEXT_INVALID, { detail: 'orgId must be a UUID' }));
    }
    const current = this.txEm.current();
    if (current?.isInTransaction()) {
      if (this.ctx.orgId() === orgId) return fn();
      return Promise.reject(new Error('OrgScope.run cannot switch to a different organization inside an open transaction'));
    }
    const forked = this.txEm.fork({ session: { variables: { [ORG_SESSION_VAR]: orgId } } });
    return this.txEm.bind(forked, async () => {
      this.ctx.setOrgId(orgId);
      return fn();
    });
  }
}
```
Đăng ký `OrgScope` trong `DatabaseModule` (providers + exports), export từ `index.ts`. `ContextModule` là global nên `RequestContext` inject được.

Run: `pnpm build && pnpm test:int` → PASS `org-scope.spec.ts`.

- [ ] **Step 3: Map lỗi DB — viết test trước**

```bash
pnpm mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_constraints
```
```ts
async up(): Promise<void> {
  this.addSql(`CREATE TABLE fixture_parents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    counter INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  this.addSql(`CREATE TABLE fixture_children (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id BIGINT NOT NULL REFERENCES fixture_parents (id) ON DELETE RESTRICT,
    email TEXT NOT NULL,
    qty INT NOT NULL CONSTRAINT fixture_children_qty_positive CHECK (qty > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fixture_children_email_uq UNIQUE (email));`);
  this.addSql(`CREATE INDEX fixture_children_parent_id_idx ON fixture_children (parent_id);`);
  this.addSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_parents, fixture_children TO app_user;`);
  this.addSql(`CREATE TABLE fixture_no_grant (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE fixture_no_grant;`);
  this.addSql(`DROP TABLE fixture_children;`);
  this.addSql(`DROP TABLE fixture_parents;`);
}
```
Thêm vào `FixtureRepo`:
```ts
async insertParent(): Promise<string> {
  return (await this.db.execute<{ id: string }>('INSERT INTO fixture_parents DEFAULT VALUES RETURNING id::text AS id'))[0]!.id;
}
async insertChild(parentId: string, email: string, qty: number): Promise<void> {
  await this.db.execute('INSERT INTO fixture_children (parent_id, email, qty) VALUES (?::bigint, ?, ?)', [parentId, email, qty]);
}
async deleteParent(id: string): Promise<void> {
  await this.db.execute('DELETE FROM fixture_parents WHERE id = ?::bigint', [id]);
}
async readCounter(id: string): Promise<number> {
  return (await this.db.execute<{ counter: number }>('SELECT counter FROM fixture_parents WHERE id = ?::bigint', [id]))[0]!.counter;
}
async writeCounter(id: string, value: number): Promise<void> {
  await this.db.execute('UPDATE fixture_parents SET counter = ?, updated_at = now() WHERE id = ?::bigint', [value, id]);
}
async readNoGrant(): Promise<void> {
  await this.db.execute('SELECT 1 FROM fixture_no_grant');
}
async sleepSeconds(s: number): Promise<void> {
  await this.db.execute('SELECT pg_sleep(?)', [s]);
}
```
`test/integration/core/database/db-errors.spec.ts`:
```ts
import { HttpStatus, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, Db, OrgScope, UnitOfWork, defineConstraintErrors } from '../../../../src/core/database/index.js';
import { defineErrorCodes, toAppError } from '../../../../src/core/errors/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const FixtureErrors = defineErrorCodes({ FIXTURE_EMAIL_TAKEN: { status: HttpStatus.CONFLICT, title: 'Email already used' } });
defineConstraintErrors({ fixture_children_email_uq: FixtureErrors.FIXTURE_EMAIL_TAKEN });

async function mapped(p: Promise<unknown>) {
  try { await p; throw new Error('expected failure'); } catch (e) {
    const a = toAppError(e);
    return { code: a.error.code, status: a.error.status, exposed: JSON.stringify({ d: a.opts.detail, f: a.opts.fields }) };
  }
}

describe('database error mapping', () => {
  let app: INestApplication; let uow: UnitOfWork; let repo: FixtureRepo;
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), FixtureModule]);
    uow = app.get(UnitOfWork); repo = app.get(FixtureRepo);
  });
  afterAll(async () => { await app.close(); });

  it('unique violation on a registered constraint → specific code, constraint name not exposed', async () => {
    const parent = await uow.run(() => repo.insertParent());
    const email = `${randomUUID()}@x.io`;
    await uow.run(() => repo.insertChild(parent, email, 1));
    const r = await mapped(uow.run(() => repo.insertChild(parent, email, 1)));
    expect(r).toMatchObject({ code: 'fixture_email_taken', status: 409 });
    expect(r.exposed).not.toContain('fixture_children_email_uq');
  });
  it('foreign key violations → 409 conflict', async () => {
    expect(await mapped(uow.run(() => repo.insertChild('999999999', `${randomUUID()}@x.io`, 1)))).toMatchObject({ code: 'conflict' });
    const parent = await uow.run(() => repo.insertParent());
    await uow.run(() => repo.insertChild(parent, `${randomUUID()}@x.io`, 1));
    expect(await mapped(uow.run(() => repo.deleteParent(parent)))).toMatchObject({ code: 'conflict' });
  });
  it('check violation → 422 validation_failed', async () => {
    const parent = await uow.run(() => repo.insertParent());
    expect(await mapped(uow.run(() => repo.insertChild(parent, `${randomUUID()}@x.io`, 0)))).toMatchObject({ code: 'validation_failed', status: 422 });
  });
  it('row level security violation → 404 not_found', async () => {
    const orgA = randomUUID(); const orgB = randomUUID();
    expect(await mapped(app.get(OrgScope).run(orgA, () => uow.run(() => repo.insertOrgNote(orgB, 'x'))))).toMatchObject({ code: 'not_found' });
  });
  it('missing GRANT (also SQLSTATE 42501) → 500 internal_error, not 404', async () => {
    expect(await mapped(uow.run(() => repo.readNoGrant()))).toMatchObject({ code: 'internal_error', status: 500 });
  });
  it('missing org context → 500 internal_error (a bug, not a client error)', async () => {
    expect(await mapped(uow.run(() => repo.listOrgBodies()))).toMatchObject({ code: 'internal_error' });
  });
  it('statement timeout → 503 service_unavailable', async () => {
    const r = await mapped(uow.run(async () => {
      await app.get(Db).execute(`SELECT set_config('statement_timeout', '50ms', true)`);
      await repo.sleepSeconds(1);
    }));
    expect(r).toMatchObject({ code: 'service_unavailable', status: 503 });
  });
  it('serialization failures are retried transparently', async () => {
    const parent = await uow.run(() => repo.insertParent());
    let started = 0;
    const bothRead = new Promise<void>((resolve) => { const t = setInterval(() => { if (started >= 2) { clearInterval(t); resolve(); } }, 5); });
    const increment = () => uow.run(async () => {
      const v = await repo.readCounter(parent);
      started++;
      await bothRead;
      await repo.writeCounter(parent, v + 1);
    }, { isolation: 'serializable' });
    await Promise.all([increment(), increment()]);
    expect(await uow.run(() => repo.readCounter(parent))).toBe(2);
  });
});
```
Test serialization dùng tín hiệu "cả hai đã đọc" thay cho `sleep`, nên luôn tạo ra xung đột thật. Lần retry chạy lại hàm, `started` vượt 2, `bothRead` đã resolve nên không chặn.

Run: `pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 4: Cài đặt mapper và retry**

Verify trong `node_modules/@mikro-orm/core/dist/exceptions.d.ts` và lỗi của `pg`: thuộc tính SQLSTATE (`code`/`sqlState`) và tên constraint (`constraint`, có thể nằm ở `cause`).

`src/core/database/db-error.mapper.ts`:
```ts
import { Logger } from '@nestjs/common';
import { AppError, CoreErrors, type ErrorCode, type ErrorMapper } from '../errors/index.js';

/** SQLSTATE chuẩn của Postgres. */
export const PG = {
  UNIQUE_VIOLATION: '23505', FOREIGN_KEY_VIOLATION: '23503', CHECK_VIOLATION: '23514', NOT_NULL_VIOLATION: '23502',
  INSUFFICIENT_PRIVILEGE: '42501', SERIALIZATION_FAILURE: '40001', DEADLOCK_DETECTED: '40P01', QUERY_CANCELED: '57014',
} as const;
/** Thông báo chuẩn khi RLS chặn (database đặt lc_messages = C trong 01-roles.sh). */
const RLS_MESSAGE = 'row-level security';
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

const constraintErrors = new Map<string, ErrorCode>();
export function defineConstraintErrors(map: Record<string, ErrorCode>): void {
  for (const [name, code] of Object.entries(map)) {
    if (constraintErrors.has(name)) throw new Error(`Constraint "${name}" already mapped`);
    constraintErrors.set(name, code);
  }
}

type PgFields = { sqlState: string; constraint?: string; message: string };
function field(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null && key in obj ? (obj as Record<string, unknown>)[key] : undefined;
}
export function pgFields(err: unknown): PgFields | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = field(err, 'cause');
  const sqlState = [field(err, 'sqlState'), field(err, 'code'), field(cause, 'code')].find((c): c is string => typeof c === 'string' && SQLSTATE_PATTERN.test(c));
  if (!sqlState) return undefined;
  const constraint = [field(err, 'constraint'), field(cause, 'constraint')].find((c): c is string => typeof c === 'string');
  return { sqlState, constraint, message: err.message };
}

export const isRetryableTxError = (err: unknown): boolean => {
  const s = pgFields(err)?.sqlState;
  return s === PG.SERIALIZATION_FAILURE || s === PG.DEADLOCK_DETECTED;
};

const logger = new Logger('DbErrorMapper');
const byConstraint = (pg: PgFields, fallback: ErrorCode) => (pg.constraint && constraintErrors.get(pg.constraint)) || fallback;

export const dbErrorMapper: ErrorMapper = (err) => {
  const pg = pgFields(err);
  if (!pg) return undefined;
  switch (pg.sqlState) {
    case PG.UNIQUE_VIOLATION:
    case PG.FOREIGN_KEY_VIOLATION:
      return new AppError(byConstraint(pg, CoreErrors.CONFLICT), { cause: err });
    case PG.CHECK_VIOLATION:
    case PG.NOT_NULL_VIOLATION:
      return new AppError(byConstraint(pg, CoreErrors.VALIDATION_FAILED), { cause: err });
    case PG.INSUFFICIENT_PRIVILEGE:
      if (!pg.message.includes(RLS_MESSAGE)) return undefined;
      logger.warn({ securityEvent: 'rls_violation', sqlState: pg.sqlState }, 'row level security blocked a write; an application-level check is missing');
      return new AppError(CoreErrors.NOT_FOUND, { cause: err });
    case PG.SERIALIZATION_FAILURE:
    case PG.DEADLOCK_DETECTED:
    case PG.QUERY_CANCELED:
      return new AppError(CoreErrors.SERVICE_UNAVAILABLE, { cause: err });
    default:
      return undefined;
  }
};
```
Retry trong `src/core/database/mikro-orm-unit-of-work.ts` (thay thân `run`):
```ts
run<T>(fn: () => Promise<T>, opts: { isolation?: Isolation } = {}): Promise<T> {
  const bound = this.txEm.current();
  if (bound?.isInTransaction()) return fn();
  const base = bound ?? this.txEm.fork();
  const attempt = () => base.transactional(async (tx) => {
    if (this.app.role === 'worker') {
      await tx.execute(`SELECT set_config('statement_timeout', ?, true)`, [`${this.cfg.workerStatementTimeoutMs}ms`]);
    }
    return this.txEm.bind(tx, fn);
  }, opts.isolation ? { isolationLevel: ISOLATION[opts.isolation] } : undefined);
  return this.withRetry(attempt);
}

private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= this.cfg.txRetryAttempts || !isRetryableTxError(err)) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * this.cfg.txRetryBaseMs * 2 ** i));
    }
  }
}
```
(import `isRetryableTxError` từ `./db-error.mapper.js`.)

`DatabaseModule` implement `OnModuleInit`, gọi `registerErrorMapper(dbErrorMapper)`. Export `OrgScope`, `defineConstraintErrors`, `dbErrorMapper`, `PG`, `isRetryableTxError` từ `index.ts`.

Run: `pnpm build && pnpm test:int` → PASS.

- [ ] **Step 5: ADR 0005 và commit**

`docs/adr/0005-multi-tenant-rls.md`: RLS fail-closed qua `app_current_org()` (ném khi NULL hoặc rỗng), FORCE, role `app_user`/`app_relay` không BYPASSRLS, grant theo bảng, FK kép (từ sub-project 3), `OrgScope` không đổi org trong transaction, map lỗi RLS → 404. Ghi rõ: policy **chỉ** viết trong migration SQL theo một mẫu chuẩn dùng `app_current_org()`. Không dùng filter `rls: true` của MikroORM để sinh policy, để không có hai nguồn định nghĩa. CI kiểm tra mọi bảng có `org_id` đều có RLS + FORCE + policy dùng `app_current_org()`.
```bash
git add -A
git commit -m "feat(core): org scope with fail-closed rls function, db error mapping and transaction retry"
```

---

### Task 8: `core/redis` + `core/queue` — registry, JobQueue, `@JobHandler`, worker host

**Files:**
- Create: `src/core/redis/{redis.config.ts,redis.module.ts,index.ts}`, `src/core/queue/{queue.config.ts,job-definition.ts,job-context.ts,job-handler.decorator.ts,job-queue.ts,bullmq-job-queue.ts,core-queues.ts,worker-host.ts,queue.module.ts,index.ts}`
- Modify: `pnpm-workspace.yaml` (overrides ioredis), `test/support/env.ts`
- Test: `test/unit/core/queue/job-definition.spec.ts`, `test/integration/core/queue/queue.spec.ts`, `test/fixtures/fixture.jobs.ts`

**Interfaces:**
- Consumes: `defineConfig`, `defineProductionRule`, `appConfig`, `RequestContext`, `OrgScope`, `CTX`
- Produces:
  - `RedisModule` (global), token `REDIS` (ioredis dùng chung, không dùng cho Worker của BullMQ), `redisNamespace(cfg, app): string` = `${keyPrefix}:${nodeEnv}`
  - `defineQueue(name, { kind: 'io' | 'cpu' })` → `QueueDef`; `queueRegistry()`; `MaintenanceQueue`
  - `defineJob<S>({ name, queue, version, schema, tenantSchedulable? })` → `JobDef<S>`; `jobRegistry()`; `findJob(name)`
  - `@JobHandler(job)` trên class có `handle(ctx: JobContext<P>): Promise<void>`
  - `JobContext<P> = { payload: P; meta: JobMeta; jobId: string; attempt: number; maxAttempts: number; signal: AbortSignal; log: Logger }`, `JobMeta = { requestId?: string; traceparent?: string; orgId?: string }`
  - `abstract class JobQueue { enqueue<S>(job: JobDef<S>, payload: z.infer<S>, opts?: EnqueueOpts): Promise<string>; enqueueDynamic(job: JobDef, payload: unknown, opts?: EnqueueOpts): Promise<string>; enqueueMany(items: EnqueueItem[]): Promise<string[]> }`, `EnqueueOpts = { jobId?: string; delayMs?: number; meta?: JobMeta }`
  - `JobPayloadError`; `WorkerHost.closeAll()`
  - Job có `meta.orgId` luôn chạy trong `OrgScope.run(orgId, …)`

- [ ] **Step 1: Cài package, một bản ioredis**

```bash
for p in bullmq ioredis; do pnpm view $p dist-tags peerDependencies; done
pnpm add bullmq ioredis
pnpm list ioredis --depth Infinity
```
Nếu cây có hơn một major của ioredis thì thêm `overrides` vào `pnpm-workspace.yaml` với đúng version `pnpm list` vừa in cho `ioredis` ở cấp gốc:
```yaml
overrides:
  ioredis: "<version gốc từ pnpm list>"
```
Chạy lại `pnpm install && pnpm list ioredis --depth Infinity` → chỉ còn một version. ADR 0006: dùng BullMQ trực tiếp (không `@nestjs/bullmq`) vì Worker được tạo theo `WORKER_QUEUES` lúc chạy và handler không import BullMQ.

- [ ] **Step 2: Viết test trước**

`test/unit/core/queue/job-definition.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeJobData, defineJob, defineQueue, encodeJobData, JobPayloadError } from '../../../../src/core/queue/index.js';

const q = defineQueue('unit-q', { kind: 'io' });
const job = defineJob({ name: 'unit.echo', queue: q, version: 2, schema: z.object({ n: z.number().int() }) });

describe('job data codec', () => {
  it('round-trips payload with version and meta', () => {
    const data = encodeJobData(job, { n: 1 }, { requestId: 'r1' });
    expect(data).toEqual({ v: 2, p: { n: 1 }, meta: { requestId: 'r1' } });
    expect(decodeJobData(job, data).payload).toEqual({ n: 1 });
  });
  it('rejects unknown version and invalid shape', () => {
    expect(() => decodeJobData(job, { v: 3, p: { n: 1 }, meta: {} })).toThrow(JobPayloadError);
    expect(() => decodeJobData(job, { v: 2, p: { n: 'x' }, meta: {} })).toThrow(JobPayloadError);
  });
  it('rejects duplicate queue and job names, and ":" in names', () => {
    expect(() => defineQueue('unit-q', { kind: 'io' })).toThrow(/already defined/);
    expect(() => defineJob({ name: 'unit.echo', queue: q, version: 1, schema: z.object({}) })).toThrow(/already defined/);
    expect(() => defineQueue('bad:q', { kind: 'io' })).toThrow(/name/);
  });
});
```
`test/fixtures/fixture.jobs.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, UnitOfWork } from '../../src/core/database/index.js';
import { RequestContext } from '../../src/core/context/index.js';
import { defineJob, defineQueue, JobHandler, type JobContext } from '../../src/core/queue/index.js';

export const FixtureQueue = defineQueue('fixture', { kind: 'io' });
export const RecordJob = defineJob({ name: 'fixture.record', queue: FixtureQueue, version: 1, schema: z.object({ key: z.string() }) });
export const SlowJob = defineJob({ name: 'fixture.slow', queue: FixtureQueue, version: 1, schema: z.object({ key: z.string(), ms: z.number() }) });
export const FlakyJob = defineJob({ name: 'fixture.flaky', queue: FixtureQueue, version: 1, schema: z.object({ key: z.string(), failTimes: z.number() }) });
export const OrgJob = defineJob({ name: 'fixture.org', queue: FixtureQueue, version: 1, schema: z.object({ key: z.string() }), tenantSchedulable: true });

export const seen: { key: string; attempt: number; requestId?: string; orgId?: string; sessionOrg?: string }[] = [];
export const slowStarted = new Map<string, () => void>();
export function waitSlowStart(key: string): Promise<void> {
  return new Promise((resolve) => slowStarted.set(key, resolve));
}

@Injectable() @JobHandler(RecordJob)
export class RecordHandler {
  async handle(ctx: JobContext<{ key: string }>) { seen.push({ key: ctx.payload.key, attempt: ctx.attempt, requestId: ctx.meta.requestId }); }
}
@Injectable() @JobHandler(SlowJob)
export class SlowHandler {
  async handle(ctx: JobContext<{ key: string; ms: number }>) {
    slowStarted.get(ctx.payload.key)?.();
    await new Promise((r) => setTimeout(r, ctx.payload.ms));
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt });
  }
}
@Injectable() @JobHandler(FlakyJob)
export class FlakyHandler {
  async handle(ctx: JobContext<{ key: string; failTimes: number }>) {
    if (ctx.attempt <= ctx.payload.failTimes) throw new Error(`flaky attempt ${ctx.attempt}`);
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt });
  }
}
@Injectable() @JobHandler(OrgJob)
export class OrgHandler {
  constructor(private readonly uow: UnitOfWork, private readonly db: Db, private readonly ctx: RequestContext) {}
  async handle(job: JobContext<{ key: string }>) {
    const sessionOrg = await this.uow.run(async () => (await this.db.execute<{ o: string }>(`SELECT current_setting('app.org_id', true) AS o`))[0]!.o);
    seen.push({ key: job.payload.key, attempt: job.attempt, orgId: this.ctx.orgId(), sessionOrg });
  }
}
```
`test/integration/core/queue/queue.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import { JobQueue, QueueModule, WorkerHost } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { FlakyHandler, FlakyJob, OrgHandler, OrgJob, RecordHandler, RecordJob, SlowHandler, SlowJob, seen, waitSlowStart } from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

@Module({ providers: [RecordHandler, SlowHandler, FlakyHandler, OrgHandler] }) class Handlers {}
async function waitFor(pred: () => boolean, timeoutMs = 15_000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('queue', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker'); vi.stubEnv('WORKER_QUEUES', 'fixture'); vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '20');
    app = await createTestApp([DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: true }), Handlers]);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('delivers payload and meta to the handler', async () => {
    await app.get(JobQueue).enqueue(RecordJob, { key: 'k1' }, { meta: { requestId: 'req-9' } });
    await waitFor(() => seen.some((s) => s.key === 'k1'));
    expect(seen.find((s) => s.key === 'k1')).toMatchObject({ attempt: 1, requestId: 'req-9' });
  });
  it('dedupes by explicit jobId while the first job is retained', async () => {
    const q = app.get(JobQueue);
    await q.enqueue(RecordJob, { key: 'dup' }, { jobId: 'dup-1' });
    await q.enqueue(RecordJob, { key: 'dup' }, { jobId: 'dup-1' });
    await waitFor(() => seen.some((s) => s.key === 'dup'));
    await app.get(JobQueue).enqueue(RecordJob, { key: 'after-dup' });
    await waitFor(() => seen.some((s) => s.key === 'after-dup'));
    expect(seen.filter((s) => s.key === 'dup')).toHaveLength(1);
  });
  it('retries with backoff until success', async () => {
    await app.get(JobQueue).enqueue(FlakyJob, { key: 'flaky', failTimes: 2 });
    await waitFor(() => seen.some((s) => s.key === 'flaky'));
    expect(seen.find((s) => s.key === 'flaky')!.attempt).toBe(3);
  });
  it('rejects invalid payload at enqueue time', async () => {
    await expect(app.get(JobQueue).enqueueDynamic(RecordJob, { key: 1 })).rejects.toThrow(/payload/i);
  });
  it('job carrying orgId runs inside OrgScope (session variable set)', async () => {
    const org = randomUUID();
    await app.get(JobQueue).enqueue(OrgJob, { key: 'org-job' }, { meta: { orgId: org } });
    await waitFor(() => seen.some((s) => s.key === 'org-job'));
    expect(seen.find((s) => s.key === 'org-job')).toMatchObject({ orgId: org, sessionOrg: org });
  });
  it('closeAll waits for the in-flight job', async () => {
    const started = waitSlowStart('slow');
    await app.get(JobQueue).enqueue(SlowJob, { key: 'slow', ms: 500 });
    await started;
    await app.get(WorkerHost).closeAll();
    expect(seen.some((s) => s.key === 'slow')).toBe(true);
  });
});
```
Test "dedupe" dùng một job đánh dấu (`after-dup`) chạy sau để biết queue đã xử lý xong, thay cho `sleep`. Queue name trùng giữa các file không sao: mỗi file có `REDIS_KEY_PREFIX` riêng.

Run: `pnpm test && pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 3: `core/redis`**

Verify: kiểu `ConnectionOptions`/`RedisOptions` mà BullMQ 6 nhận (có `url`), và yêu cầu `maxRetriesPerRequest: null` cho Worker (`https://docs.bullmq.io`, release note v6).

`src/core/redis/redis.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';

export const redisConfig = defineConfig(
  'redis',
  { url: 'REDIS_URL', keyPrefix: 'REDIS_KEY_PREFIX', commandTimeoutMs: 'REDIS_COMMAND_TIMEOUT_MS', maxRetriesPerRequest: 'REDIS_MAX_RETRIES_PER_REQUEST' },
  z.object({
    url: z.url().describe('Redis URL (redis:// or rediss://, include ACL user and password)'),
    keyPrefix: z.string().regex(/^[a-z0-9-]+$/).default('app').describe('Service prefix for every Redis key; the environment name is appended'),
    commandTimeoutMs: z.coerce.number().int().positive().default(1000).describe('ioredis commandTimeout for non-blocking clients'),
    maxRetriesPerRequest: z.coerce.number().int().min(0).default(3).describe('ioredis maxRetriesPerRequest for non-blocking clients'),
  }),
);

defineProductionRule('redis-tls-acl', (c) => {
  const url = typeof c.redis?.url === 'string' ? new URL(c.redis.url) : undefined;
  if (!url) return undefined;
  if (url.protocol !== 'rediss:') return 'REDIS_URL must use rediss:// in production';
  if (!url.username || !url.password) return 'REDIS_URL must include an ACL username and password in production';
  return undefined;
});
```
`src/core/redis/redis.module.ts`:
```ts
import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { type ConfigOf, appConfig } from '../config/index.js';
import { redisConfig } from './redis.config.js';

export const REDIS = Symbol('core.redis');
export const REDIS_NAMESPACE = Symbol('core.redisNamespace');

export const redisNamespace = (cfg: ConfigOf<typeof redisConfig>, app: ConfigOf<typeof appConfig>): string => `${cfg.keyPrefix}-${app.nodeEnv}`;

export function redisClientOptions(cfg: ConfigOf<typeof redisConfig>, blocking: boolean): RedisOptions {
  return { maxRetriesPerRequest: blocking ? null : cfg.maxRetriesPerRequest, commandTimeout: blocking ? undefined : cfg.commandTimeoutMs };
}

@Global()
@Module({
  providers: [
    { provide: REDIS, inject: [redisConfig.KEY], useFactory: (cfg: ConfigOf<typeof redisConfig>) => new Redis(cfg.url, redisClientOptions(cfg, false)) },
    { provide: REDIS_NAMESPACE, inject: [redisConfig.KEY, appConfig.KEY], useFactory: redisNamespace },
  ],
  exports: [REDIS, REDIS_NAMESPACE],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
```
Namespace dùng `-` (không dùng `:`) vì BullMQ không cho `:` trong prefix/jobId. Mọi consumer (BullMQ, rate limit, idempotency) đều thêm namespace này làm prefix. `index.ts` export `RedisModule`, `REDIS`, `REDIS_NAMESPACE`, `redisConfig`, `redisClientOptions`, `redisNamespace`. Thêm config vào `all-configs.ts`. Thêm `REDIS_URL: getInfra().redis.url` vào `baseTestEnv()`.

- [ ] **Step 4: Định nghĩa queue/job, codec**

`src/core/queue/queue.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const positiveInt = z.coerce.number().int().positive();

export const queueConfig = defineConfig(
  'queue',
  {
    workerQueues: 'WORKER_QUEUES', attempts: 'QUEUE_DEFAULT_ATTEMPTS', backoffMs: 'QUEUE_DEFAULT_BACKOFF_MS',
    keepCompletedAgeSec: 'QUEUE_KEEP_COMPLETED_AGE_SEC', keepCompletedCount: 'QUEUE_KEEP_COMPLETED_COUNT',
    keepFailedAgeSec: 'QUEUE_KEEP_FAILED_AGE_SEC', keepFailedCount: 'QUEUE_KEEP_FAILED_COUNT',
    ioConcurrency: 'QUEUE_IO_CONCURRENCY', cpuConcurrency: 'QUEUE_CPU_CONCURRENCY',
    shutdownTimeoutMs: 'QUEUE_SHUTDOWN_TIMEOUT_MS', concurrencyOverrides: 'QUEUE_CONCURRENCY_OVERRIDES',
    stalledIntervalMs: 'QUEUE_STALLED_INTERVAL_MS', lockDurationMs: 'QUEUE_LOCK_DURATION_MS',
  },
  z.object({
    workerQueues: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).describe('Comma-separated queues this worker consumes; empty = all registered queues'),
    attempts: positiveInt.default(5).describe('Default max attempts per job'),
    backoffMs: positiveInt.default(2000).describe('Base delay for exponential backoff'),
    keepCompletedAgeSec: positiveInt.default(3600).describe('Remove completed jobs older than this'),
    keepCompletedCount: positiveInt.default(1000).describe('Keep at most this many completed jobs per queue'),
    keepFailedAgeSec: positiveInt.default(604800).describe('Remove failed jobs older than this'),
    keepFailedCount: positiveInt.default(10000).describe('Keep at most this many failed jobs per queue (bounds Redis memory)'),
    ioConcurrency: positiveInt.default(20).describe('Default concurrency for io queues'),
    cpuConcurrency: positiveInt.default(1).describe('Default concurrency for cpu queues'),
    shutdownTimeoutMs: positiveInt.default(25000).describe('Max wait for in-flight jobs on shutdown'),
    concurrencyOverrides: z.string().default('')
      .transform((s, ctx) => {
        const out: Record<string, number> = {};
        for (const kv of s.split(',').map((x) => x.trim()).filter(Boolean)) {
          const [k, v] = kv.split('=');
          const n = Number(v);
          if (!k || !Number.isInteger(n) || n <= 0) { ctx.addIssue({ code: 'custom', message: `invalid entry "${kv}", expected queue=positiveInt` }); return {}; }
          out[k.trim()] = n;
        }
        return out;
      })
      .describe('Per-queue concurrency, e.g. "billing=1,notifications=50"'),
    stalledIntervalMs: positiveInt.default(30000).describe('How often workers check for stalled jobs'),
    lockDurationMs: positiveInt.default(30000).describe('Job lock duration; must exceed the longest event-loop stall'),
  }),
);
```
`src/core/queue/job-definition.ts`:
```ts
import type { z } from 'zod';

export type QueueDef = { readonly name: string; readonly kind: 'io' | 'cpu' };
export type JobMeta = { requestId?: string; traceparent?: string; orgId?: string };
export type JobData = { v: number; p: unknown; meta: JobMeta };
export type JobDef<S extends z.ZodType = z.ZodType> = {
  readonly name: string; readonly queue: QueueDef; readonly version: number; readonly schema: S; readonly tenantSchedulable: boolean;
};

export class JobPayloadError extends Error {
  constructor(job: string, detail: string) {
    super(`Invalid payload for job "${job}": ${detail}`);
    this.name = 'JobPayloadError';
  }
}

/** BullMQ không cho ":" trong tên/id. */
const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/;
const queues = new Map<string, QueueDef>();
const jobs = new Map<string, JobDef>();

export function defineQueue(name: string, opts: { kind: 'io' | 'cpu' }): QueueDef {
  if (!NAME_PATTERN.test(name)) throw new Error(`Queue name "${name}" must match ${NAME_PATTERN}`);
  if (queues.has(name)) throw new Error(`Queue "${name}" already defined`);
  const def = { name, kind: opts.kind } as const;
  queues.set(name, def);
  return def;
}
export function defineJob<S extends z.ZodType>(def: { name: string; queue: QueueDef; version: number; schema: S; tenantSchedulable?: boolean }): JobDef<S> {
  if (!NAME_PATTERN.test(def.name)) throw new Error(`Job name "${def.name}" must match ${NAME_PATTERN}`);
  if (jobs.has(def.name)) throw new Error(`Job "${def.name}" already defined`);
  const full: JobDef<S> = { ...def, tenantSchedulable: def.tenantSchedulable ?? false };
  jobs.set(def.name, full);
  return full;
}
export const queueRegistry = (): QueueDef[] => [...queues.values()];
export const jobRegistry = (): JobDef[] => [...jobs.values()];
export const findJob = (name: string): JobDef | undefined => jobs.get(name);

export function encodeJobData(job: JobDef, payload: unknown, meta: JobMeta): JobData {
  const parsed = job.schema.safeParse(payload);
  if (!parsed.success) throw new JobPayloadError(job.name, parsed.error.message);
  return { v: job.version, p: parsed.data, meta };
}
export function decodeJobData<S extends z.ZodType>(job: JobDef<S>, data: unknown): { payload: z.infer<S>; meta: JobMeta } {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Partial<JobData>;
  if (d.v !== job.version) throw new JobPayloadError(job.name, `unsupported version ${String(d.v)} (expected ${job.version})`);
  const parsed = job.schema.safeParse(d.p);
  if (!parsed.success) throw new JobPayloadError(job.name, parsed.error.message);
  return { payload: parsed.data, meta: d.meta ?? {} };
}
```
`src/core/queue/core-queues.ts`:
```ts
import { defineQueue } from './job-definition.js';

export const MaintenanceQueue = defineQueue('maintenance', { kind: 'io' });
```
`src/core/queue/job-context.ts`:
```ts
import type { Logger } from '@nestjs/common';
import type { JobMeta } from './job-definition.js';

export type JobContext<P> = { payload: P; meta: JobMeta; jobId: string; attempt: number; maxAttempts: number; signal: AbortSignal; log: Logger };
```
`src/core/queue/job-handler.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import type { JobContext } from './job-context.js';
import type { JobDef } from './job-definition.js';

export const JOB_HANDLER = Symbol('core.jobHandler');
export const JobHandler = (job: JobDef): ClassDecorator => SetMetadata(JOB_HANDLER, job);
export interface JobHandlerInstance { handle(ctx: JobContext<unknown>): Promise<void> }
export const isJobHandlerInstance = (v: unknown): v is JobHandlerInstance =>
  typeof v === 'object' && v !== null && typeof (v as { handle?: unknown }).handle === 'function';
```

- [ ] **Step 5: JobQueue (producer) + WorkerHost (consumer)**

Verify với BullMQ 6: `Queue(name, { connection, prefix, defaultJobOptions })`, `add(name, data, { jobId, delay })`, `addBulk`, `Worker(name, processor, { connection, prefix, concurrency, stalledInterval, lockDuration })`, processor `(job, token, signal)`, `job.attemptsMade`, `UnrecoverableError`, `worker.close(force?)`.

`src/core/queue/job-queue.ts`:
```ts
import type { z } from 'zod';
import type { JobDef, JobMeta } from './job-definition.js';

export type EnqueueOpts = { jobId?: string; delayMs?: number; meta?: JobMeta };
export type EnqueueItem = { job: JobDef; payload: unknown; opts?: EnqueueOpts };

export abstract class JobQueue {
  abstract enqueue<S extends z.ZodType>(job: JobDef<S>, payload: z.infer<S>, opts?: EnqueueOpts): Promise<string>;
  /** Payload chưa có type (ví dụ đọc từ outbox) — vẫn được validate bằng schema của job. */
  abstract enqueueDynamic(job: JobDef, payload: unknown, opts?: EnqueueOpts): Promise<string>;
  abstract enqueueMany(items: EnqueueItem[]): Promise<string[]>;
}
```
`src/core/queue/bullmq-job-queue.ts`:
```ts
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { REDIS_NAMESPACE, redisClientOptions, redisConfig } from '../redis/index.js';
import { encodeJobData, queueRegistry, type JobDef, type JobMeta } from './job-definition.js';
import { JobQueue, type EnqueueItem, type EnqueueOpts } from './job-queue.js';
import { queueConfig } from './queue.config.js';

@Injectable()
export class BullmqJobQueue extends JobQueue implements OnApplicationShutdown {
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(redisConfig.KEY) private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
    @Inject(queueConfig.KEY) private readonly cfg: ConfigOf<typeof queueConfig>,
    private readonly ctx: RequestContext,
  ) { super(); }

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: { url: this.redis.url, ...redisClientOptions(this.redis, false) },
        prefix: this.namespace,
        defaultJobOptions: {
          attempts: this.cfg.attempts,
          backoff: { type: 'exponential', delay: this.cfg.backoffMs },
          removeOnComplete: { age: this.cfg.keepCompletedAgeSec, count: this.cfg.keepCompletedCount },
          removeOnFail: { age: this.cfg.keepFailedAgeSec, count: this.cfg.keepFailedCount },
        },
      });
      this.queues.set(name, q);
    }
    return q;
  }
  allQueues(): Queue[] {
    return queueRegistry().map((q) => this.queue(q.name));
  }

  private meta(extra?: JobMeta): JobMeta {
    return { requestId: this.ctx.requestId(), orgId: this.ctx.orgId(), traceparent: this.ctx.traceparent(), ...extra };
  }

  enqueue<S extends z.ZodType>(job: JobDef<S>, payload: z.infer<S>, opts: EnqueueOpts = {}): Promise<string> {
    return this.enqueueDynamic(job, payload, opts);
  }

  async enqueueDynamic(job: JobDef, payload: unknown, opts: EnqueueOpts = {}): Promise<string> {
    const data = encodeJobData(job, payload, this.meta(opts.meta));
    const added = await this.queue(job.queue.name).add(job.name, data, { jobId: opts.jobId, delay: opts.delayMs });
    if (!added.id) throw new Error(`BullMQ did not return an id for job "${job.name}"`);
    return added.id;
  }

  async enqueueMany(items: EnqueueItem[]): Promise<string[]> {
    const byQueue = new Map<string, { name: string; data: unknown; opts: { jobId?: string; delay?: number } }[]>();
    for (const it of items) {
      const list = byQueue.get(it.job.queue.name) ?? [];
      list.push({ name: it.job.name, data: encodeJobData(it.job, it.payload, this.meta(it.opts?.meta)), opts: { jobId: it.opts?.jobId, delay: it.opts?.delayMs } });
      byQueue.set(it.job.queue.name, list);
    }
    const ids: string[] = [];
    for (const [name, list] of byQueue) {
      for (const j of await this.queue(name).addBulk(list)) {
        if (!j.id) throw new Error(`BullMQ did not return an id for a bulk job on "${name}"`);
        ids.push(j.id);
      }
    }
    return ids;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
```
`src/core/queue/worker-host.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { OrgScope } from '../database/index.js';
import { REDIS_NAMESPACE, redisClientOptions, redisConfig } from '../redis/index.js';
import { JOB_HANDLER, isJobHandlerInstance, type JobHandlerInstance } from './job-handler.decorator.js';
import { decodeJobData, JobPayloadError, queueRegistry, type JobDef } from './job-definition.js';
import { queueConfig } from './queue.config.js';

export const WORKER_HOST_OPTIONS = Symbol('core.workerHostOptions');
export type WorkerHostOptions = { runWorkers: boolean };

@Injectable()
export class WorkerHost implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerHost.name);
  private readonly workers: Worker[] = [];
  private readonly handlers = new Map<string, { def: JobDef; instance: JobHandlerInstance }>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly ctx: RequestContext,
    private readonly orgScope: OrgScope,
    @Inject(redisConfig.KEY) private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
    @Inject(queueConfig.KEY) private readonly cfg: ConfigOf<typeof queueConfig>,
    @Inject(WORKER_HOST_OPTIONS) private readonly opts: WorkerHostOptions,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const def: JobDef | undefined = wrapper.metatype ? Reflect.getMetadata(JOB_HANDLER, wrapper.metatype) : undefined;
      if (!def) continue;
      if (!isJobHandlerInstance(wrapper.instance)) throw new Error(`@JobHandler(${def.name}) class must implement handle(ctx)`);
      if (this.handlers.has(def.name)) throw new Error(`Duplicate @JobHandler for "${def.name}"`);
      this.handlers.set(def.name, { def, instance: wrapper.instance });
    }
    if (!this.opts.runWorkers) return;
    const wanted = this.cfg.workerQueues.length ? this.cfg.workerQueues : queueRegistry().map((q) => q.name);
    for (const name of wanted) {
      const q = queueRegistry().find((x) => x.name === name);
      if (!q) throw new Error(`WORKER_QUEUES contains unknown queue "${name}"`);
      if (q.kind === 'cpu') throw new Error(`Queue "${name}" is cpu-bound; sandboxed processors are not implemented yet (ADR 0006)`);
      const concurrency = this.cfg.concurrencyOverrides[name] ?? this.cfg.ioConcurrency;
      this.workers.push(new Worker(name, (job, _token, signal) => this.process(job, signal), {
        connection: { url: this.redis.url, ...redisClientOptions(this.redis, true) },
        prefix: this.namespace,
        concurrency,
        stalledInterval: this.cfg.stalledIntervalMs,
        lockDuration: this.cfg.lockDurationMs,
      }));
      this.logger.log({ queue: name, concurrency }, 'worker started');
    }
  }

  private async process(job: Job, signal?: AbortSignal): Promise<void> {
    const entry = this.handlers.get(job.name);
    if (!entry) throw new UnrecoverableError(`No handler for job "${job.name}"`);
    let decoded: { payload: unknown; meta: { requestId?: string; traceparent?: string; orgId?: string } };
    try {
      decoded = decodeJobData(entry.def, job.data);
    } catch (e) {
      if (e instanceof JobPayloadError) throw new UnrecoverableError(e.message);
      throw e;
    }
    if (!job.id) throw new UnrecoverableError(`Job "${job.name}" has no id`);
    const jobId = job.id;
    const run = () => entry.instance.handle({
      payload: decoded.payload, meta: decoded.meta, jobId,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? this.cfg.attempts,
      signal: signal ?? new AbortController().signal,
      log: new Logger(`job:${job.name}`),
    });
    await this.ctx.run({ requestId: decoded.meta.requestId, traceparent: decoded.meta.traceparent, orgId: decoded.meta.orgId, jobId }, () =>
      decoded.meta.orgId ? this.orgScope.run(decoded.meta.orgId, run) : run());
  }

  async closeAll(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), this.cfg.shutdownTimeoutMs); });
    const result = await Promise.race([Promise.all(this.workers.map((w) => w.close())).then(() => 'ok' as const), timeout]);
    clearTimeout(timer);
    if (result === 'timeout') {
      this.logger.error({ timeoutMs: this.cfg.shutdownTimeoutMs }, 'workers did not close in time; forcing');
      await Promise.all(this.workers.map((w) => w.close(true)));
    }
    this.workers.length = 0;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.closeAll();
  }
}
```
Verify: `job.attemptsMade` có đếm lần đang chạy hay không (test `retries with backoff` bắt sai), và processor BullMQ 6 có nhận `signal` thứ ba không (nếu không thì bỏ và tạo `AbortController` riêng, `abort()` khi bắt đầu tắt).

`src/core/queue/queue.module.ts` (khung bằng `pnpm nest g module core/queue --no-spec`):
```ts
import { DynamicModule, Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullmqJobQueue } from './bullmq-job-queue.js';
import { JobQueue } from './job-queue.js';
import { WORKER_HOST_OPTIONS, WorkerHost, type WorkerHostOptions } from './worker-host.js';

@Global()
@Module({})
export class QueueModule {
  static forRoot(opts: WorkerHostOptions): DynamicModule {
    return {
      module: QueueModule,
      imports: [DiscoveryModule],
      providers: [BullmqJobQueue, { provide: JobQueue, useExisting: BullmqJobQueue }, { provide: WORKER_HOST_OPTIONS, useValue: opts }, WorkerHost],
      exports: [JobQueue, BullmqJobQueue, WorkerHost],
    };
  }
}
```
`src/core/queue/index.ts`: export `QueueModule`, `JobQueue`, `WorkerHost`, `JobHandler`, `defineQueue`, `defineJob`, `encodeJobData`, `decodeJobData`, `JobPayloadError`, `queueRegistry`, `jobRegistry`, `findJob`, `MaintenanceQueue`, các type `JobContext`, `JobDef`, `QueueDef`, `EnqueueOpts`, `EnqueueItem`, `JobMeta`. Thêm config vào `all-configs.ts`.

Gắn vào module gốc: `AppApiModule` import `RedisModule`, `QueueModule.forRoot({ runWorkers: false })`. `AppWorkerModule` import `RedisModule`, `QueueModule.forRoot({ runWorkers: true })`.

Run: `pnpm test && pnpm build && pnpm test:int` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): queue registry, versioned job payloads, org-scoped worker host on bullmq"
```

---

### Task 9: `core/outbox` — writer, relay trên role `app_relay`, inbox, SafeEnqueue

**Files:**
- Create: `src/core/outbox/{outbox.config.ts,outbox.jobs.ts,outbox.writer.ts,outbox.relay.ts,inbox.ts,safe-enqueue.ts,outbox.module.ts,index.ts}`, migration `src/migrations/core/<CLI>_outbox_inbox.ts`
- Test: `test/integration/core/outbox/outbox.spec.ts`

**Interfaces:**
- Consumes: `UnitOfWork`, `Db`, `RelayDb`, `JobQueue`, `defineQueue`, `defineJob`, `JobPayloadError`, `RequestContext`
- Produces:
  - `NewOutboxEvent = { eventId: string; type: string; version: number; orgId: string | null; aggregate: { type: string; id: string; version: number }; payload: unknown; headers: Record<string, string> }`
  - `OutboxWriter.append(e): Promise<void>` (bắt buộc trong `UnitOfWork`; `app_user` chỉ có quyền INSERT)
  - `OutboxRelay.runOnce(): Promise<number>`, `drain(): Promise<number>` (lặp tới khi hết dòng), `start()`, `stop()`; chạy trên `RelayDb`, chỉ có trong worker
  - `EventsQueue`, `DispatchEventJob` (`core.event.dispatch`, payload `{ outboxId: string }`), `DEFERRED_JOB_EVENT_TYPE`, `DeferredJobPayload`
  - `Inbox.once(consumer, eventId, fn): Promise<'processed' | 'duplicate'>`
  - `SafeEnqueue.enqueue(job, payload, opts?)`: trong transaction → luôn ghi outbox; ngoài transaction → gửi thẳng, lỗi thì ghi outbox. Một `jobId` duy nhất cho cả hai đường
  - `OutboxModule.forRoot(opts: { relay: boolean })`; `OUTBOX_RELAY_HOOKS` (chỉ cho test)

- [ ] **Step 1: Migration bằng CLI (có GRANT theo bảng)**

```bash
pnpm mikro-orm migration:create --blank --path src/migrations/core --name outbox_inbox
```
```ts
async up(): Promise<void> {
  this.addSql(`CREATE TABLE outbox_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    type TEXT NOT NULL,
    version INT NOT NULL CHECK (version > 0),
    org_id UUID NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version BIGINT NOT NULL,
    payload JSONB NOT NULL,
    headers JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ NULL,
    publish_attempts INT NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  this.addSql(`CREATE INDEX outbox_events_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;`);
  this.addSql(`CREATE INDEX outbox_events_published_at_idx ON outbox_events (published_at) WHERE published_at IS NOT NULL;`);
  this.addSql(`CREATE TABLE processed_events (
    consumer TEXT NOT NULL,
    event_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id));`);
  this.addSql(`CREATE INDEX processed_events_processed_at_idx ON processed_events (processed_at);`);
  this.addSql(`GRANT INSERT ON outbox_events TO app_user;`);
  this.addSql(`GRANT SELECT, UPDATE, DELETE ON outbox_events TO app_relay;`);
  this.addSql(`GRANT INSERT ON processed_events TO app_user;`);
  this.addSql(`GRANT SELECT (consumer) ON processed_events TO app_user;`);
  this.addSql(`GRANT SELECT, DELETE ON processed_events TO app_relay;`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE processed_events;`);
  this.addSql(`DROP TABLE outbox_events;`);
}
```
Bảng hạ tầng không có RLS vì `app_user` **không đọc được** outbox (chỉ INSERT) và chỉ đọc được cột `consumer` của inbox; payload của mọi org chỉ `app_relay` (worker) đọc được.

- [ ] **Step 2: Viết test trước**

`test/integration/core/outbox/outbox.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { z } from 'zod';
import { DatabaseModule, Db, RelayDb, UnitOfWork } from '../../../../src/core/database/index.js';
import { DispatchEventJob, EventsQueue, Inbox, OUTBOX_RELAY_HOOKS, OutboxModule, OutboxRelay, OutboxWriter, SafeEnqueue, type NewOutboxEvent, type OutboxRelayHooks } from '../../../../src/core/outbox/index.js';
import { JobHandler, JobQueue, QueueModule, defineJob, type JobContext } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const dispatched: string[] = [];
const Probe = defineJob({ name: 'test.outbox.probe', queue: EventsQueue, version: 1, schema: z.object({ n: z.number() }) });

@Injectable() @JobHandler(DispatchEventJob)
class DispatchSpy { async handle(ctx: JobContext<{ outboxId: string }>) { dispatched.push(ctx.payload.outboxId); } }
@Module({ providers: [DispatchSpy] }) class Spies {}

const evt = (): NewOutboxEvent => ({ eventId: v7(), type: 'test.thing.happened', version: 1, orgId: null, aggregate: { type: 'thing', id: '1', version: 1 }, payload: { a: 1 }, headers: {} });
const until = async (pred: () => boolean | Promise<boolean>, ms = 15000) => {
  const t = Date.now();
  while (!(await pred())) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('outbox', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker'); vi.stubEnv('WORKER_QUEUES', 'events'); vi.stubEnv('OUTBOX_AUTOSTART', 'false'); vi.stubEnv('OUTBOX_BATCH_SIZE', '5');
    app = await createTestApp([DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule.forRoot({ relay: true }), Spies]);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });
  beforeEach(async () => { dispatched.length = 0; await app.get(OutboxRelay).drain(); dispatched.length = 0; });

  const unpublished = async (id: string) => (await app.get(RelayDb).execute<{ n: string }>('SELECT count(*)::text AS n FROM outbox_events WHERE event_id = ? AND published_at IS NULL', [id]))[0]!.n;

  it('append outside a unit of work throws', async () => {
    await expect(app.get(OutboxWriter).append(evt())).rejects.toThrow(/UnitOfWork/);
  });
  it('app_user cannot read outbox payloads', async () => {
    await expect(app.get(Db).execute('SELECT payload FROM outbox_events LIMIT 1')).rejects.toThrow(/permission denied/);
  });
  it('rolled back transaction leaves no event', async () => {
    const e = evt();
    await expect(app.get(UnitOfWork).run(async () => { await app.get(OutboxWriter).append(e); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await app.get(RelayDb).execute('SELECT 1 FROM outbox_events WHERE event_id = ?', [e.eventId])).toHaveLength(0);
  });
  it('relay publishes committed events exactly once', async () => {
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    expect(await app.get(OutboxRelay).drain()).toBe(1);
    await until(() => dispatched.length === 1);
    expect(await app.get(OutboxRelay).drain()).toBe(0);
  });
  it('concurrent relays with small batch never publish the same row twice', async () => {
    const events = Array.from({ length: 50 }, evt);
    await app.get(UnitOfWork).run(async () => { for (const e of events) await app.get(OutboxWriter).append(e); });
    const relay = app.get(OutboxRelay);
    const counts = await Promise.all([relay.drain(), relay.drain(), relay.drain()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(50);
    expect(counts.filter((c) => c > 0).length).toBeGreaterThan(1);
    await until(() => dispatched.length >= 50);
    expect(new Set(dispatched).size).toBe(dispatched.length);
  });
  it('enqueue-then-commit-failure: row stays unpublished, retry dispatches once', async () => {
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    const hooks = app.get<OutboxRelayHooks>(OUTBOX_RELAY_HOOKS);
    hooks.afterEnqueue = async () => { hooks.afterEnqueue = undefined; throw new Error('commit lost'); };
    await expect(app.get(OutboxRelay).runOnce()).rejects.toThrow('commit lost');
    expect(await unpublished(e.eventId)).toBe('1');
    await app.get(OutboxRelay).drain();
    await until(() => dispatched.length >= 1);
    const marker = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(marker));
    await app.get(OutboxRelay).drain();
    await until(() => dispatched.length >= 2);
    expect(dispatched).toHaveLength(2);
  });
  it('inbox runs side effect once per consumer+event, and failure rolls back the record', async () => {
    const inbox = app.get(Inbox); const uow = app.get(UnitOfWork); const id = v7();
    let n = 0;
    const results = [
      await uow.run(() => inbox.once('c1', id, async () => { n++; })),
      await uow.run(() => inbox.once('c1', id, async () => { n++; })),
      await uow.run(() => inbox.once('c2', id, async () => { n++; })),
    ];
    expect(results).toEqual(['processed', 'duplicate', 'processed']);
    expect(n).toBe(2);
    const id2 = v7();
    await expect(uow.run(() => inbox.once('c3', id2, async () => { throw new Error('side effect failed'); }))).rejects.toThrow();
    expect(await uow.run(() => inbox.once('c3', id2, async () => {}))).toBe('processed');
  });
  it('SafeEnqueue inside a transaction always writes the outbox and never calls Redis directly', async () => {
    const spy = vi.spyOn(app.get(JobQueue), 'enqueueDynamic');
    await app.get(UnitOfWork).run(() => app.get(SafeEnqueue).enqueue(Probe, { n: 1 }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const rows = await app.get(RelayDb).execute<{ payload: { job: string; jobId: string } }>(`SELECT payload FROM outbox_events WHERE type = 'core.job.deferred' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]!.payload.job).toBe('test.outbox.probe');
    expect(rows[0]!.payload.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('SafeEnqueue outside a transaction falls back to the outbox with the same jobId', async () => {
    const spy = vi.spyOn(app.get(JobQueue), 'enqueueDynamic').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await app.get(SafeEnqueue).enqueue(Probe, { n: 42 });
    const attemptedJobId = spy.mock.calls[0]![2]!.jobId;
    spy.mockRestore();
    const rows = await app.get(RelayDb).execute<{ payload: { jobId: string; payload: { n: number } } }>(`SELECT payload FROM outbox_events WHERE type = 'core.job.deferred' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]!.payload).toMatchObject({ jobId: attemptedJobId, payload: { n: 42 } });
  });
  it('SafeEnqueue does not defer invalid payloads', async () => {
    await expect(app.get(SafeEnqueue).enqueue(Probe, { n: 'x' } as unknown as { n: number })).rejects.toThrow(/payload/i);
  });
});
```
Cast duy nhất ở test cuối là chủ đích (đưa payload sai kiểu vào để kiểm tra validate lúc chạy).

Run: `pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 3: Cài đặt**

`src/core/outbox/outbox.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const positiveInt = z.coerce.number().int().positive();

export const outboxConfig = defineConfig(
  'outbox',
  {
    pollIntervalMs: 'OUTBOX_POLL_INTERVAL_MS', batchSize: 'OUTBOX_BATCH_SIZE', autostart: 'OUTBOX_AUTOSTART',
    retentionDays: 'OUTBOX_RETENTION_DAYS', inboxRetentionDays: 'INBOX_RETENTION_DAYS',
    attemptsAlertThreshold: 'OUTBOX_ATTEMPTS_ALERT_THRESHOLD', cleanupCron: 'OUTBOX_CLEANUP_CRON', cleanupTz: 'OUTBOX_CLEANUP_TZ',
    cleanupBatchSize: 'OUTBOX_CLEANUP_BATCH_SIZE',
  },
  z.object({
    pollIntervalMs: positiveInt.default(1000).describe('Relay poll interval when the outbox is empty'),
    batchSize: positiveInt.max(1000).default(100).describe('Rows claimed per relay iteration'),
    autostart: z.stringbool().default(true).describe('Start relay loop on worker bootstrap'),
    retentionDays: positiveInt.default(7).describe('Delete published outbox rows older than this'),
    inboxRetentionDays: positiveInt.default(30).describe('Delete inbox records older than this'),
    attemptsAlertThreshold: positiveInt.default(10).describe('Log error when publish attempts exceed this'),
    cleanupCron: z.string().min(1).default('0 5 * * *').describe('Cron for outbox/inbox cleanup'),
    cleanupTz: z.string().min(1).default('Asia/Ho_Chi_Minh').describe('Timezone for cleanup cron'),
    cleanupBatchSize: positiveInt.default(5000).describe('Rows deleted per cleanup statement'),
  }),
);
```
`src/core/outbox/outbox.jobs.ts`:
```ts
import { z } from 'zod';
import { defineJob, defineQueue } from '../queue/index.js';

export const EventsQueue = defineQueue('events', { kind: 'io' });
export const DispatchEventJob = defineJob({ name: 'core.event.dispatch', queue: EventsQueue, version: 1, schema: z.object({ outboxId: z.string() }) });
export const DEFERRED_JOB_EVENT_TYPE = 'core.job.deferred';
export const DeferredJobPayload = z.object({ job: z.string(), payload: z.unknown(), jobId: z.string(), delayMs: z.number().optional() });
```
`src/core/outbox/outbox.writer.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Db, UnitOfWork } from '../database/index.js';

export type NewOutboxEvent = {
  eventId: string; type: string; version: number; orgId: string | null;
  aggregate: { type: string; id: string; version: number }; payload: unknown; headers: Record<string, string>;
};

@Injectable()
export class OutboxWriter {
  constructor(private readonly uow: UnitOfWork, private readonly db: Db) {}

  async append(e: NewOutboxEvent): Promise<void> {
    if (!this.uow.inTransaction()) throw new Error('OutboxWriter.append must be called inside UnitOfWork.run');
    await this.db.execute(
      `INSERT INTO outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
      [e.eventId, e.type, e.version, e.orgId, e.aggregate.type, e.aggregate.id, e.aggregate.version, JSON.stringify(e.payload), JSON.stringify(e.headers)],
    );
  }
}
```
`src/core/outbox/outbox.relay.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { RelayDb } from '../database/index.js';
import { JobQueue } from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { DispatchEventJob } from './outbox.jobs.js';

export const OUTBOX_RELAY_HOOKS = Symbol('core.outboxRelayHooks');
export type OutboxRelayHooks = { afterEnqueue?: () => Promise<void> };
type Claimed = { id: string; org_id: string | null; headers: Record<string, string> };

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(
    private readonly relayDb: RelayDb,
    private readonly queue: JobQueue,
    @Inject(outboxConfig.KEY) private readonly cfg: ConfigOf<typeof outboxConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
    @Inject(OUTBOX_RELAY_HOOKS) private readonly hooks: OutboxRelayHooks,
  ) {}

  onApplicationBootstrap(): void {
    if (this.app.role === 'worker' && this.cfg.autostart) this.start();
  }

  start(): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      let full = false;
      this.running = this.runOnce()
        .then((n) => { full = n === this.cfg.batchSize; })
        .catch((err: unknown) => this.logger.error({ err }, 'outbox relay iteration failed'));
      await this.running;
      if (!this.stopped) this.timer = setTimeout(tick, full ? 0 : this.cfg.pollIntervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Chạy liên tục tới khi không còn dòng chưa gửi. Trả về tổng số dòng đã gửi. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.runOnce();
      total += n;
      if (n < this.cfg.batchSize) return total;
    }
  }

  async runOnce(): Promise<number> {
    let claimed: string[] = [];
    try {
      return await this.relayDb.transaction(async (tx) => {
        const rows = await tx.execute<Claimed>(
          `SELECT id::text AS id, org_id, headers FROM outbox_events
           WHERE published_at IS NULL ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
          [this.cfg.batchSize],
        );
        if (rows.length === 0) return 0;
        claimed = rows.map((r) => r.id);
        await this.queue.enqueueMany(rows.map((r) => ({
          job: DispatchEventJob,
          payload: { outboxId: r.id },
          opts: { jobId: `outbox-${r.id}`, meta: { requestId: r.headers.correlationId, traceparent: r.headers.traceparent, orgId: r.org_id ?? undefined } },
        })));
        await this.hooks.afterEnqueue?.();
        await tx.execute(`UPDATE outbox_events SET published_at = now(), updated_at = now() WHERE id = ANY(?::bigint[])`, [claimed]);
        return rows.length;
      });
    } catch (err) {
      if (claimed.length) await this.recordFailedAttempt(claimed);
      throw err;
    }
  }

  private async recordFailedAttempt(ids: string[]): Promise<void> {
    const rows = await this.relayDb.execute<{ id: string; publish_attempts: number }>(
      `UPDATE outbox_events SET publish_attempts = publish_attempts + 1, updated_at = now()
       WHERE id = ANY(?::bigint[]) AND published_at IS NULL RETURNING id::text AS id, publish_attempts`,
      [ids],
    );
    for (const r of rows) {
      if (r.publish_attempts >= this.cfg.attemptsAlertThreshold) this.logger.error({ outboxId: r.id, attempts: r.publish_attempts }, 'outbox event keeps failing to publish');
    }
  }
}
```
Dispatch job đi qua `WorkerHost`, mà job có `meta.orgId` sẽ chạy trong `OrgScope`. `jobId` dạng `outbox-<id>` (không có `:`). Việc chống trùng cuối cùng dựa vào **inbox** ở bước deliver, không dựa vào `jobId` (job đã xong có thể đã bị xoá khỏi Redis).

`src/core/outbox/inbox.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Db, UnitOfWork } from '../database/index.js';

@Injectable()
export class Inbox {
  constructor(private readonly uow: UnitOfWork, private readonly db: Db) {}

  /** Chỉ dùng cho side effect trong DB (cùng transaction). Gọi dịch vụ ngoài thì ghi ý định trong transaction rồi gọi sau khi commit, dùng eventId làm idempotency key phía provider. */
  async once(consumer: string, eventId: string, fn: () => Promise<void>): Promise<'processed' | 'duplicate'> {
    if (!this.uow.inTransaction()) throw new Error('Inbox.once must be called inside UnitOfWork.run');
    const rows = await this.db.execute<{ consumer: string }>(
      `INSERT INTO processed_events (consumer, event_id) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING consumer`,
      [consumer, eventId],
    );
    if (rows.length === 0) return 'duplicate';
    await fn();
    return 'processed';
  }
}
```
`src/core/outbox/safe-enqueue.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { v7 } from 'uuid';
import type { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { UnitOfWork } from '../database/index.js';
import { JobPayloadError, JobQueue, encodeJobData, type EnqueueOpts, type JobDef } from '../queue/index.js';
import { DEFERRED_JOB_EVENT_TYPE } from './outbox.jobs.js';
import { OutboxWriter } from './outbox.writer.js';

@Injectable()
export class SafeEnqueue {
  private readonly logger = new Logger(SafeEnqueue.name);
  constructor(private readonly queue: JobQueue, private readonly outbox: OutboxWriter, private readonly uow: UnitOfWork, private readonly ctx: RequestContext) {}

  async enqueue<S extends z.ZodType>(job: JobDef<S>, payload: z.infer<S>, opts: EnqueueOpts = {}): Promise<void> {
    encodeJobData(job, payload, {});
    const jobId = opts.jobId ?? v7();
    if (this.uow.inTransaction()) return this.defer(job, payload, jobId, opts);
    try {
      await this.queue.enqueueDynamic(job, payload, { ...opts, jobId });
    } catch (err) {
      if (err instanceof JobPayloadError) throw err;
      this.logger.warn({ err, job: job.name, jobId }, 'direct enqueue failed; deferring via outbox');
      await this.uow.run(() => this.defer(job, payload, jobId, opts));
    }
  }

  private defer(job: JobDef, payload: unknown, jobId: string, opts: EnqueueOpts): Promise<void> {
    return this.outbox.append({
      eventId: v7(), type: DEFERRED_JOB_EVENT_TYPE, version: 1, orgId: this.ctx.orgId() ?? null,
      aggregate: { type: 'job', id: jobId, version: 1 },
      payload: { job: job.name, payload, jobId, delayMs: opts.delayMs },
      headers: { correlationId: this.ctx.requestId() },
    });
  }
}
```
Trong transaction, job chỉ được gửi sau khi commit (qua outbox), nên không bao giờ chạy trước commit hay sau rollback. Hàm `encodeJobData` ở đầu chỉ để validate payload sớm.

`src/core/outbox/outbox.module.ts`:
```ts
import { DynamicModule, Global, Module } from '@nestjs/common';
import { Inbox } from './inbox.js';
import { OUTBOX_RELAY_HOOKS, OutboxRelay } from './outbox.relay.js';
import { OutboxWriter } from './outbox.writer.js';
import { SafeEnqueue } from './safe-enqueue.js';

@Global()
@Module({})
export class OutboxModule {
  static forRoot(opts: { relay: boolean }): DynamicModule {
    const relay = opts.relay ? [OutboxRelay, { provide: OUTBOX_RELAY_HOOKS, useValue: {} }] : [];
    return {
      module: OutboxModule,
      providers: [OutboxWriter, Inbox, SafeEnqueue, ...relay],
      exports: [OutboxWriter, Inbox, SafeEnqueue, ...(opts.relay ? [OutboxRelay, OUTBOX_RELAY_HOOKS] : [])],
    };
  }
}
```
`src/core/outbox/index.ts`: export mọi thứ ở Interfaces (kể cả `outboxConfig`, `OutboxRelayHooks`). Thêm config vào `all-configs.ts`. `AppApiModule`: `OutboxModule.forRoot({ relay: false })`; `AppWorkerModule`: `OutboxModule.forRoot({ relay: true })`.

Run: `pnpm build && pnpm test:int` → PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): transactional outbox with least-privilege relay, inbox dedupe, transaction-safe enqueue"
```

---

### Task 10: `core/events` — envelope, định nghĩa event, subscriber, fan-out

**Files:**
- Create: `src/core/events/{event-definition.ts,envelope.ts,subscriber.decorator.ts,event-publisher.ts,event-dispatch.handlers.ts,events.module.ts,index.ts}`, `test/fixtures/fixture.events.ts`, `test/fixtures/fixture.controller.ts`
- Test: `test/unit/core/events/envelope.spec.ts`, `test/e2e/core/events.e2e.spec.ts`

**Interfaces:**
- Consumes: `OutboxWriter`, `Inbox`, `UnitOfWork`, `RelayDb`, `JobQueue`, `defineJob`, `findJob`, `JobHandler`, `EventsQueue`, `DispatchEventJob`, `DEFERRED_JOB_EVENT_TYPE`, `DeferredJobPayload`, `RequestContext`
- Produces:
  - `defineEvent<S>({ type, version, schema })` → `EventDef<S>`; `eventRegistry()`, `findEvent(type, version)`
  - `EventEnvelope<P>` = `{ id; type; version; occurredAt; orgId: string | null; actor: { type: 'user' | 'system' | 'service'; id: string }; aggregate: { type; id; version }; correlationId; causationId: string | null; traceparent?: string; data: P }`
  - `EventPublisher.publish(def, { data, aggregate, actor, causationId? }): Promise<string>` — org **luôn** lấy từ `RequestContext` (không nhận org từ caller; actor `system` chạy ngoài org thì `orgId = null`)
  - `@EventSubscriber({ consumer, event })`; `DeliverEventJob` (`core.event.deliver`, `{ consumer, outboxId }`)
  - `EventsModule.forRoot(opts: { worker: boolean })` — handler dispatch/deliver chỉ có trong worker

- [ ] **Step 1: Viết test trước**

`test/unit/core/events/envelope.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { z } from 'zod';
import { defineEvent, parseEnvelope } from '../../../../src/core/events/index.js';

const Created = defineEvent({ type: 'unit.thing.created', version: 1, schema: z.object({ name: z.string() }) });

describe('event envelope', () => {
  it('rejects duplicate type@version and bad type names', () => {
    expect(() => defineEvent({ type: 'unit.thing.created', version: 1, schema: z.object({}) })).toThrow(/already defined/);
    expect(() => defineEvent({ type: 'BadName', version: 1, schema: z.object({}) })).toThrow(/context\.aggregate\.verb/);
  });
  it('validates data against the event schema', () => {
    const base = { id: v7(), type: Created.type, version: 1, occurredAt: new Date().toISOString(), orgId: null,
      actor: { type: 'system', id: 'test' }, aggregate: { type: 'thing', id: '1', version: 1 }, correlationId: v7(), causationId: null };
    expect(parseEnvelope(Created, { ...base, data: { name: 'x' } }).data.name).toBe('x');
    expect(() => parseEnvelope(Created, { ...base, data: { name: 1 } })).toThrow();
  });
});
```
`test/fixtures/fixture.events.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { defineEvent, EventSubscriber, type EventEnvelope } from '../../src/core/events/index.js';

export const NoteCreated = defineEvent({ type: 'fixture.note.created', version: 1, schema: z.object({ body: z.string() }) });
export const received: { consumer: string; body: string; eventId: string }[] = [];
export const failOnce = new Set<string>();

@Injectable() @EventSubscriber({ consumer: 'fixture.audit', event: NoteCreated })
export class AuditSubscriber {
  async handle(e: EventEnvelope<{ body: string }>) { received.push({ consumer: 'fixture.audit', body: e.data.body, eventId: e.id }); }
}
@Injectable() @EventSubscriber({ consumer: 'fixture.mailer', event: NoteCreated })
export class MailerSubscriber {
  async handle(e: EventEnvelope<{ body: string }>) {
    if (failOnce.delete(e.data.body)) throw new Error('mailer down');
    received.push({ consumer: 'fixture.mailer', body: e.data.body, eventId: e.id });
  }
}
```
`test/fixtures/fixture.controller.ts`:
```ts
import { Body, Controller, Module, Post } from '@nestjs/common';
import { UnitOfWork } from '../../src/core/database/index.js';
import { EventPublisher } from '../../src/core/events/index.js';
import { FixtureModule, FixtureRepo } from './fixture.module.js';
import { NoteCreated } from './fixture.events.js';

@Controller('fixture/notes')
export class FixtureNotesController {
  constructor(private readonly uow: UnitOfWork, private readonly repo: FixtureRepo, private readonly events: EventPublisher) {}

  @Post()
  async create(@Body() body: { body: string; fail?: boolean }) {
    await this.uow.run(async () => {
      await this.repo.insertSystemNote(body.body);
      await this.events.publish(NoteCreated, { data: { body: body.body }, aggregate: { type: 'note', id: body.body, version: 1 }, actor: { type: 'system', id: 'fixture' } });
      if (body.fail) throw new Error('fail after publish');
    });
    return { ok: true };
  }
}

/** Tách riêng khỏi FixtureModule vì cần EventsModule; test DB thuần không phải nạp events. */
@Module({ imports: [FixtureModule], controllers: [FixtureNotesController] })
export class FixtureNotesModule {}
```

`test/e2e/core/events.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule, OutboxRelay, SafeEnqueue } from '../../../src/core/outbox/index.js';
import { JobHandler, JobQueue, QueueModule, defineJob, type JobContext } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { FixtureNotesModule } from '../../fixtures/fixture.controller.js';
import { FixtureQueue } from '../../fixtures/fixture.jobs.js';
import { AuditSubscriber, MailerSubscriber, failOnce, received } from '../../fixtures/fixture.events.js';
import { createTestApp } from '../../support/app-factory.js';

const DeferredProbe = defineJob({ name: 'fixture.deferred.probe', queue: FixtureQueue, version: 1, schema: z.object({ n: z.number() }) });
const deferredRuns: number[] = [];
@Injectable() @JobHandler(DeferredProbe)
class DeferredProbeHandler { async handle(ctx: JobContext<{ n: number }>) { deferredRuns.push(ctx.payload.n); } }
@Module({ providers: [AuditSubscriber, MailerSubscriber, DeferredProbeHandler] }) class Subs {}
const until = async (pred: () => boolean, ms = 15000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

describe('events end-to-end', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker'); vi.stubEnv('WORKER_QUEUES', 'events,fixture'); vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '50'); vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '20');
    app = await createTestApp([DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule.forRoot({ relay: true }), EventsModule.forRoot({ worker: true }), FixtureNotesModule, Subs]);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });
  beforeEach(() => { received.length = 0; });

  it('committed command fans out to every subscriber exactly once', async () => {
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n1' }).expect(201);
    await until(() => received.filter((r) => r.body === 'n1').length >= 2);
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n1-marker' }).expect(201);
    await until(() => received.filter((r) => r.body === 'n1-marker').length >= 2);
    expect(received.filter((r) => r.body === 'n1').map((r) => r.consumer).sort()).toEqual(['fixture.audit', 'fixture.mailer']);
  });

  it('rolled back command emits nothing', async () => {
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n2', fail: true }).expect(500);
    await app.get(OutboxRelay).drain();
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n2-marker' }).expect(201);
    await until(() => received.filter((r) => r.body === 'n2-marker').length >= 2);
    expect(received.some((r) => r.body === 'n2')).toBe(false);
  });

  it('deferred job (written while Redis was down) is re-enqueued by dispatch and runs', async () => {
    vi.spyOn(app.get(JobQueue), 'enqueueDynamic').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await app.get(SafeEnqueue).enqueue(DeferredProbe, { n: 7 });
    await until(() => deferredRuns.includes(7));
  });

  it('one failing subscriber is retried without re-running the other', async () => {
    failOnce.add('n3');
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n3' }).expect(201);
    await until(() => received.filter((r) => r.body === 'n3').length >= 2);
    expect(received.filter((r) => r.body === 'n3' && r.consumer === 'fixture.audit')).toHaveLength(1);
    expect(received.filter((r) => r.body === 'n3' && r.consumer === 'fixture.mailer')).toHaveLength(1);
  });
});
```
Các test dùng một request "marker" gửi sau để biết mọi việc trước đó đã xử lý xong, thay cho `sleep`.

Run: `pnpm test && pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 2: Cài đặt**

`src/core/events/event-definition.ts`:
```ts
import type { z } from 'zod';

export type EventDef<S extends z.ZodType = z.ZodType> = { readonly type: string; readonly version: number; readonly schema: S };
const TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const events = new Map<string, EventDef>();

export function defineEvent<S extends z.ZodType>(def: { type: string; version: number; schema: S }): EventDef<S> {
  if (!TYPE_PATTERN.test(def.type)) throw new Error(`Event type "${def.type}" must follow context.aggregate.verb`);
  const key = `${def.type}@${def.version}`;
  if (events.has(key)) throw new Error(`Event "${key}" already defined`);
  events.set(key, def);
  return def;
}
export const findEvent = (type: string, version: number): EventDef | undefined => events.get(`${type}@${version}`);
export const eventRegistry = (): EventDef[] => [...events.values()];
```
`src/core/events/envelope.ts`:
```ts
import { z } from 'zod';
import type { EventDef } from './event-definition.js';

export const EnvelopeBase = z.object({
  id: z.uuid(), type: z.string(), version: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }), orgId: z.uuid().nullable(),
  actor: z.object({ type: z.enum(['user', 'system', 'service']), id: z.string().min(1) }),
  aggregate: z.object({ type: z.string().min(1), id: z.string().min(1), version: z.number().int().nonnegative() }),
  correlationId: z.string().min(1), causationId: z.string().nullable(), traceparent: z.string().optional(),
});
export type EventEnvelope<P> = z.infer<typeof EnvelopeBase> & { data: P };

export function parseEnvelope<S extends z.ZodType>(def: EventDef<S>, raw: unknown): EventEnvelope<z.infer<S>> {
  const base = EnvelopeBase.parse(raw);
  const data = def.schema.parse((raw as { data?: unknown }).data);
  return { ...base, data };
}
```
Verify `z.iso.datetime`, `z.uuid()` trong zod 4.

`src/core/events/subscriber.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import type { EventDef } from './event-definition.js';
import type { EventEnvelope } from './envelope.js';

export const EVENT_SUBSCRIBER = Symbol('core.eventSubscriber');
export type SubscriberMeta = { consumer: string; event: EventDef };
export const EventSubscriber = (meta: SubscriberMeta): ClassDecorator => SetMetadata(EVENT_SUBSCRIBER, meta);
export interface EventHandlerInstance { handle(e: EventEnvelope<unknown>): Promise<void> }
export const isEventHandlerInstance = (v: unknown): v is EventHandlerInstance =>
  typeof v === 'object' && v !== null && typeof (v as { handle?: unknown }).handle === 'function';
```
`src/core/events/event-publisher.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import type { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { OutboxWriter } from '../outbox/index.js';
import type { EventDef } from './event-definition.js';

@Injectable()
export class EventPublisher {
  constructor(private readonly outbox: OutboxWriter, private readonly ctx: RequestContext) {}

  async publish<S extends z.ZodType>(
    def: EventDef<S>,
    input: { data: z.infer<S>; aggregate: { type: string; id: string; version: number }; actor: { type: 'user' | 'system' | 'service'; id: string }; causationId?: string },
  ): Promise<string> {
    const data = def.schema.parse(input.data);
    const id = v7();
    const traceparent = this.ctx.traceparent();
    await this.outbox.append({
      eventId: id, type: def.type, version: def.version, orgId: this.ctx.orgId() ?? null,
      aggregate: input.aggregate, payload: data,
      headers: {
        actorType: input.actor.type, actorId: input.actor.id, correlationId: this.ctx.requestId(),
        ...(input.causationId ? { causationId: input.causationId } : {}),
        ...(traceparent ? { traceparent } : {}),
      },
    });
    return id;
  }
}
```
Org của event luôn là org của context hiện tại, nên code không thể phát event gắn nhầm sang org khác.

`src/core/events/event-dispatch.handlers.ts`:
```ts
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';
import { RelayDb, UnitOfWork } from '../database/index.js';
import { DEFERRED_JOB_EVENT_TYPE, DeferredJobPayload, DispatchEventJob, EventsQueue, Inbox } from '../outbox/index.js';
import { JobHandler, JobQueue, defineJob, findJob, type JobContext } from '../queue/index.js';
import { findEvent } from './event-definition.js';
import { parseEnvelope, type EventEnvelope } from './envelope.js';
import { EVENT_SUBSCRIBER, isEventHandlerInstance, type EventHandlerInstance, type SubscriberMeta } from './subscriber.decorator.js';

export const DeliverEventJob = defineJob({ name: 'core.event.deliver', queue: EventsQueue, version: 1, schema: z.object({ consumer: z.string(), outboxId: z.string() }) });

type Row = { id: string; event_id: string; type: string; version: number; org_id: string | null; aggregate_type: string; aggregate_id: string; aggregate_version: string; payload: unknown; headers: Record<string, string>; occurred_at: Date };
type Entry = { meta: SubscriberMeta; instance: EventHandlerInstance };

@Injectable()
export class SubscriberRegistry implements OnApplicationBootstrap {
  readonly byEvent = new Map<string, Entry[]>();
  readonly byConsumer = new Map<string, Entry>();
  constructor(private readonly discovery: DiscoveryService) {}
  onApplicationBootstrap(): void {
    for (const w of this.discovery.getProviders()) {
      const meta: SubscriberMeta | undefined = w.metatype ? Reflect.getMetadata(EVENT_SUBSCRIBER, w.metatype) : undefined;
      if (!meta) continue;
      if (!isEventHandlerInstance(w.instance)) throw new Error(`@EventSubscriber(${meta.consumer}) class must implement handle(e)`);
      if (this.byConsumer.has(meta.consumer)) throw new Error(`Duplicate subscriber consumer "${meta.consumer}"`);
      const entry = { meta, instance: w.instance };
      this.byConsumer.set(meta.consumer, entry);
      const key = `${meta.event.type}@${meta.event.version}`;
      this.byEvent.set(key, [...(this.byEvent.get(key) ?? []), entry]);
    }
  }
}

@Injectable()
export class OutboxReader {
  constructor(private readonly relayDb: RelayDb) {}
  async load(outboxId: string): Promise<Row> {
    const rows = await this.relayDb.execute<Row>(
      `SELECT id::text AS id, event_id, type, version, org_id, aggregate_type, aggregate_id,
              aggregate_version::text AS aggregate_version, payload, headers, occurred_at
       FROM outbox_events WHERE id = ?::bigint`,
      [outboxId],
    );
    if (!rows[0]) throw new Error(`Outbox row ${outboxId} not found`);
    return rows[0];
  }
}

const ACTOR_TYPES = ['user', 'system', 'service'] as const;
export function toEnvelope(row: Row): EventEnvelope<unknown> {
  const actorType = ACTOR_TYPES.find((t) => t === row.headers.actorType) ?? 'system';
  return {
    id: row.event_id, type: row.type, version: row.version, occurredAt: new Date(row.occurred_at).toISOString(), orgId: row.org_id,
    actor: { type: actorType, id: row.headers.actorId ?? 'unknown' },
    aggregate: { type: row.aggregate_type, id: row.aggregate_id, version: Number(row.aggregate_version) },
    correlationId: row.headers.correlationId ?? row.event_id, causationId: row.headers.causationId ?? null,
    traceparent: row.headers.traceparent, data: row.payload,
  };
}

@Injectable() @JobHandler(DispatchEventJob)
export class DispatchEventHandler {
  constructor(private readonly reader: OutboxReader, private readonly subs: SubscriberRegistry, private readonly queue: JobQueue) {}
  async handle(ctx: JobContext<{ outboxId: string }>): Promise<void> {
    const row = await this.reader.load(ctx.payload.outboxId);
    const meta = { orgId: row.org_id ?? undefined, traceparent: row.headers.traceparent, requestId: row.headers.correlationId };
    if (row.type === DEFERRED_JOB_EVENT_TYPE) {
      const d = DeferredJobPayload.parse(row.payload);
      const job = findJob(d.job);
      if (!job) throw new Error(`Deferred job "${d.job}" is not registered`);
      await this.queue.enqueueDynamic(job, d.payload, { jobId: d.jobId, delayMs: d.delayMs, meta });
      return;
    }
    const targets = this.subs.byEvent.get(`${row.type}@${row.version}`) ?? [];
    await this.queue.enqueueMany(targets.map((t) => ({ job: DeliverEventJob, payload: { consumer: t.meta.consumer, outboxId: row.id }, opts: { jobId: `deliver-${t.meta.consumer}-${row.id}`, meta } })));
  }
}

@Injectable() @JobHandler(DeliverEventJob)
export class DeliverEventHandler {
  constructor(private readonly reader: OutboxReader, private readonly subs: SubscriberRegistry, private readonly inbox: Inbox, private readonly uow: UnitOfWork) {}
  async handle(ctx: JobContext<{ consumer: string; outboxId: string }>): Promise<void> {
    const sub = this.subs.byConsumer.get(ctx.payload.consumer);
    if (!sub) throw new Error(`Subscriber "${ctx.payload.consumer}" is not registered in this worker`);
    const row = await this.reader.load(ctx.payload.outboxId);
    const def = findEvent(row.type, row.version);
    if (!def) throw new Error(`Event ${row.type}@${row.version} is not defined`);
    const envelope = parseEnvelope(def, toEnvelope(row));
    await this.uow.run(() => this.inbox.once(sub.meta.consumer, envelope.id, () => sub.instance.handle(envelope)));
  }
}
```
Job deliver mang `meta.orgId = row.org_id`, nên `WorkerHost` đã chạy nó trong `OrgScope` của đúng org (Task 8). Lỗi "subscriber/event chưa đăng ký" là lỗi cấu hình: để retry bình thường rồi rơi vào tập failed và cảnh báo (worker khác có thể có subscriber khi deploy lệch version).

`src/core/events/events.module.ts`:
```ts
import { DynamicModule, Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DeliverEventHandler, DispatchEventHandler, OutboxReader, SubscriberRegistry } from './event-dispatch.handlers.js';
import { EventPublisher } from './event-publisher.js';

@Global()
@Module({})
export class EventsModule {
  static forRoot(opts: { worker: boolean }): DynamicModule {
    return {
      module: EventsModule,
      imports: [DiscoveryModule],
      providers: [EventPublisher, ...(opts.worker ? [SubscriberRegistry, OutboxReader, DispatchEventHandler, DeliverEventHandler] : [])],
      exports: [EventPublisher],
    };
  }
}
```
`src/core/events/index.ts`: export `EventsModule`, `EventPublisher`, `EventSubscriber`, `defineEvent`, `eventRegistry`, `findEvent`, `parseEnvelope`, type `EventEnvelope`, `EventDef`, `DeliverEventJob`. `AppApiModule`: `EventsModule.forRoot({ worker: false })`; `AppWorkerModule`: `forRoot({ worker: true })`.

Run: `pnpm test && pnpm build && pnpm test:int` → PASS.

- [ ] **Step 3: ADR 0006 và commit**

`docs/adr/0006-queue-outbox.md`: BullMQ trực tiếp (không `@nestjs/bullmq`), lý do; outbox → dispatch → deliver (mỗi subscriber một job), inbox là chốt chống trùng; `app_relay` cho relay; SafeEnqueue; queue `cpu` chưa hỗ trợ; image PgBouncer đã chọn ở Task 2; chỉ một major ioredis.
```bash
git add -A
git commit -m "feat(core): versioned domain events with per-subscriber fan-out and inbox"
```

---

### Task 11: `core/scheduler` — cron tĩnh + lịch của tenant + cleanup outbox

**Files:**
- Create: `src/core/queue/bullmq-job-scheduler.ts`, `src/core/scheduler/{scheduler.config.ts,cron-definition.ts,static-scheduler.ts,scheduled-task.service.ts,schedule-reconciler.ts,scheduler.jobs.ts,scheduler.module.ts,index.ts}`, `src/core/outbox/outbox-cleanup.handler.ts`, migration `src/migrations/core/<CLI>_scheduled_tasks.ts`
- Modify: `src/core/queue/{queue.module.ts,index.ts}`, `src/core/outbox/{outbox.jobs.ts,outbox.module.ts,index.ts}`
- Test: `test/integration/core/scheduler/scheduler.spec.ts`, `test/integration/core/outbox/outbox-cleanup.spec.ts`

**Interfaces:**
- Consumes: `BullmqJobQueue.queue/allQueues`, `JobDef`, `encodeJobData`, `findJob`, `MaintenanceQueue`, `UnitOfWork`, `Db`, `RelayDb`, `OrgScope`, `RequestContext`, `AppError`, `CoreErrors`
- Produces:
  - `abstract class JobScheduler { upsert(id, job, payload, pattern: { cron; tz }, meta?: JobMeta): Promise<void>; remove(id): Promise<void>; listIds(prefix): Promise<string[]>; get(id): Promise<{ pattern?: string; tz?: string } | undefined> }` (export từ `core/queue`)
  - `defineCron({ key, job, payload, schedule: () => { cron; tz } })`; `retireCron(key)` — cách **duy nhất** để xoá một cron tĩnh (không tự xoá cron lạ, an toàn khi rolling deploy)
  - `StaticScheduler.sync(): Promise<{ upserted: string[]; removed: string[] }>`
  - `ScheduledTaskService.upsert({ key, job, cron, timezone, payload, enabled })`, `remove(key)` — org lấy từ `RequestContext` (bắt buộc chạy trong `OrgScope`), chỉ job `tenantSchedulable`, không có trường giây, chu kỳ ≥ `SCHEDULER_TENANT_MIN_INTERVAL_SEC`
  - `ScheduleReconciler.reconcile(): Promise<{ upserted: number; removed: number }>` (worker, `RelayDb`)
  - `OutboxCleanupJob` + cron `core.outbox.cleanup`, `OutboxCleanupHandler.handle()` xoá theo batch

- [ ] **Step 1: Migration bằng CLI**

```bash
pnpm mikro-orm migration:create --blank --path src/migrations/core --name scheduled_tasks
```
```ts
async up(): Promise<void> {
  this.addSql(`CREATE TABLE scheduled_tasks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    key TEXT NOT NULL CHECK (key ~ '^[a-z0-9._]{1,64}$'),
    job_name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    payload JSONB NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT scheduled_tasks_org_key_uq UNIQUE (org_id, key));`);
  this.addSql(`ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;`);
  this.addSql(`ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;`);
  this.addSql(`CREATE POLICY scheduled_tasks_tenant ON scheduled_tasks TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
  this.addSql(`CREATE POLICY scheduled_tasks_relay_read ON scheduled_tasks FOR SELECT TO app_relay USING (true);`);
  this.addSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_tasks TO app_user;`);
  this.addSql(`GRANT SELECT ON scheduled_tasks TO app_relay;`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE scheduled_tasks;`);
}
```
Lịch **hệ thống** là cron tĩnh (`defineCron`), không nằm trong bảng. Bảng chỉ chứa lịch của tenant. `app_relay` chỉ đọc (cho reconcile).

- [ ] **Step 2: Viết test trước**

`test/integration/core/scheduler/scheduler.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseModule, Db, OrgScope, UnitOfWork } from '../../../../src/core/database/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { OutboxModule } from '../../../../src/core/outbox/index.js';
import { JobHandler, JobScheduler, QueueModule, defineJob, type JobContext } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { ScheduleReconciler, ScheduledTaskService, SchedulerModule, StaticScheduler, defineCron, retireCron } from '../../../../src/core/scheduler/index.js';
import { FixtureQueue } from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

const ticks = new Map<string, number>();
const Tick = defineJob({ name: 'fixture.tick', queue: FixtureQueue, version: 1, schema: z.object({ src: z.string() }) });
const TenantReport = defineJob({ name: 'fixture.tenant.report', queue: FixtureQueue, version: 1, schema: z.object({ src: z.string() }), tenantSchedulable: true });
defineCron({ key: 'fixture.every-second', job: Tick, payload: { src: 'static' }, schedule: () => ({ cron: '* * * * * *', tz: 'UTC' }) });

@Injectable() @JobHandler(Tick)
class TickHandler {
  async handle(ctx: JobContext<{ src: string }>) {
    const tickMillis = ctx.jobId.split('-').at(-1) ?? ctx.jobId;
    ticks.set(tickMillis, (ticks.get(tickMillis) ?? 0) + 1);
  }
}
@Injectable() @JobHandler(TenantReport)
class ReportHandler { async handle() {} }
@Module({ providers: [TickHandler, ReportHandler] }) class H {}

const imports = () => [DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule.forRoot({ relay: false }), SchedulerModule.forRoot({ worker: true }), H];
const until = async (pred: () => boolean, ms = 15000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };

describe('scheduler', () => {
  let w1: INestApplication; let w2: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker'); vi.stubEnv('WORKER_QUEUES', 'fixture');
    w1 = await createTestApp(imports()); w2 = await createTestApp(imports());
  });
  afterAll(async () => {
    await w1.get(JobScheduler).remove('static-fixture.every-second');
    await w1.close(); await w2.close(); vi.unstubAllEnvs();
  });

  it('static cron fires exactly once per tick across two workers', async () => {
    await until(() => ticks.size >= 3);
    for (const count of ticks.values()) expect(count).toBe(1);
  });

  it('never removes undeclared static crons implicitly; only retired ones', async () => {
    const sched = w1.get(JobScheduler);
    await sched.upsert('static-from.newer.release', Tick, { src: 'x' }, { cron: '0 0 1 1 *', tz: 'UTC' });
    expect((await w1.get(StaticScheduler).sync()).removed).not.toContain('static-from.newer.release');
    retireCron('from.newer.release');
    expect((await w1.get(StaticScheduler).sync()).removed).toContain('static-from.newer.release');
  });

  describe('tenant tasks', () => {
    const org = randomUUID();
    const inOrg = <T>(fn: () => Promise<T>) => w1.get(OrgScope).run(org, fn);
    const svc = () => w1.get(ScheduledTaskService);

    it('requires org context', async () => {
      await expect(svc().upsert({ key: 'report', job: TenantReport, cron: '0 8 * * 1', timezone: 'UTC', payload: { src: 't' }, enabled: true }))
        .rejects.toMatchObject({ error: { code: 'org_context_invalid' } });
    });
    it('rejects non-schedulable jobs, second-level crons, too-frequent crons, bad tz and bad keys', async () => {
      const base = { key: 'report', job: TenantReport, cron: '0 8 * * 1', timezone: 'UTC', payload: { src: 't' }, enabled: true };
      for (const bad of [
        { ...base, job: Tick },
        { ...base, cron: '* * * * * *' },
        { ...base, cron: '* * * * *' },
        { ...base, timezone: 'Mars/Base' },
        { ...base, key: 'bad:key' },
      ]) await expect(inOrg(() => svc().upsert(bad))).rejects.toBeInstanceOf(AppError);
    });
    it('stores the task under RLS and registers a scheduler carrying the org', async () => {
      await inOrg(() => svc().upsert({ key: 'report', job: TenantReport, cron: '0 8 * * 1', timezone: 'UTC', payload: { src: 't' }, enabled: true }));
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([`task-${org}-report`]);
      const otherOrgSees = await w1.get(OrgScope).run(randomUUID(), () => w1.get(UnitOfWork).run(() => w1.get(Db).execute('SELECT 1 FROM scheduled_tasks')));
      expect(otherOrgSees).toHaveLength(0);
    });
    it('reconcile restores missing schedulers and repairs drifted ones', async () => {
      await w1.get(JobScheduler).remove(`task-${org}-report`);
      await inOrg(() => w1.get(UnitOfWork).run(() => w1.get(Db).execute(`UPDATE scheduled_tasks SET cron = '0 9 * * 1' WHERE key = 'report'`)));
      const r = await w1.get(ScheduleReconciler).reconcile();
      expect(r.upserted).toBeGreaterThanOrEqual(1);
      expect((await w1.get(JobScheduler).get(`task-${org}-report`))?.pattern).toBe('0 9 * * 1');
    });
    it('remove deletes row and scheduler', async () => {
      await inOrg(() => svc().remove('report'));
      expect(await w1.get(JobScheduler).listIds(`task-${org}-`)).toEqual([]);
    });
  });
});
```
Test đếm số lần chạy **theo từng mốc** (millis nằm cuối jobId do Job Scheduler sinh), nên phát hiện được việc một mốc chạy hai lần. Verify định dạng jobId của Job Scheduler BullMQ 6 (`repeat:<id>:<millis>` hay tương tự) và sửa cách tách millis cho đúng.

`test/integration/core/outbox/outbox-cleanup.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { DatabaseModule, RelayDb, UnitOfWork } from '../../../../src/core/database/index.js';
import { OutboxCleanupHandler, OutboxModule, OutboxWriter } from '../../../../src/core/outbox/index.js';
import { QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

describe('outbox cleanup', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker'); vi.stubEnv('OUTBOX_AUTOSTART', 'false'); vi.stubEnv('WORKER_QUEUES', 'maintenance'); vi.stubEnv('OUTBOX_CLEANUP_BATCH_SIZE', '3');
    app = await createTestApp([DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: false }), OutboxModule.forRoot({ relay: true })]);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('deletes only published rows older than retention, in batches', async () => {
    const olds = Array.from({ length: 7 }, () => v7()); const fresh = v7();
    await app.get(UnitOfWork).run(async () => {
      for (const id of [...olds, fresh]) await app.get(OutboxWriter).append({ eventId: id, type: 'test.thing.happened', version: 1, orgId: null, aggregate: { type: 't', id: '1', version: 1 }, payload: {}, headers: {} });
    });
    await app.get(RelayDb).execute(`UPDATE outbox_events SET published_at = now() - interval '30 days' WHERE event_id = ANY(?::uuid[])`, [olds]);
    await app.get(OutboxCleanupHandler).handle();
    const left = await app.get(RelayDb).execute<{ event_id: string }>('SELECT event_id FROM outbox_events WHERE event_id = ANY(?::uuid[])', [[...olds, fresh]]);
    expect(left.map((r) => r.event_id)).toEqual([fresh]);
  });
});
```
Run: `pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 3: Cài đặt**

Verify trong tài liệu BullMQ 6 Job Schedulers (`https://docs.bullmq.io/guide/job-schedulers`): `upsertJobScheduler(id, { pattern, tz }, { name, data })`, `removeJobScheduler(id)`, `getJobSchedulers()` (trường `key`), `getJobScheduler(id)` (trường `pattern`, `tz`), cron có trường giây, và ký tự hợp lệ trong id.

`src/core/queue/bullmq-job-scheduler.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { BullmqJobQueue } from './bullmq-job-queue.js';
import { encodeJobData, type JobDef, type JobMeta } from './job-definition.js';

export abstract class JobScheduler {
  abstract upsert(id: string, job: JobDef, payload: unknown, pattern: { cron: string; tz: string }, meta?: JobMeta): Promise<void>;
  abstract remove(id: string): Promise<void>;
  abstract listIds(prefix: string): Promise<string[]>;
  abstract get(id: string): Promise<{ pattern?: string; tz?: string } | undefined>;
}

@Injectable()
export class BullmqJobScheduler extends JobScheduler {
  constructor(private readonly queues: BullmqJobQueue) { super(); }
  async upsert(id: string, job: JobDef, payload: unknown, pattern: { cron: string; tz: string }, meta: JobMeta = {}): Promise<void> {
    await this.queues.queue(job.queue.name).upsertJobScheduler(id, { pattern: pattern.cron, tz: pattern.tz }, { name: job.name, data: encodeJobData(job, payload, meta) });
  }
  async remove(id: string): Promise<void> {
    for (const q of this.queues.allQueues()) await q.removeJobScheduler(id);
  }
  async listIds(prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (const q of this.queues.allQueues()) for (const s of await q.getJobSchedulers()) if (s.key.startsWith(prefix)) ids.push(s.key);
    return ids;
  }
  async get(id: string): Promise<{ pattern?: string; tz?: string } | undefined> {
    for (const q of this.queues.allQueues()) {
      const s = await q.getJobScheduler(id);
      if (s) return { pattern: s.pattern ?? undefined, tz: s.tz ?? undefined };
    }
    return undefined;
  }
}
```
Thêm vào `QueueModule` providers: `BullmqJobScheduler`, `{ provide: JobScheduler, useExisting: BullmqJobScheduler }`; exports: `JobScheduler`. Export `JobScheduler` từ `core/queue/index.ts`.

`src/core/scheduler/scheduler.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const schedulerConfig = defineConfig(
  'scheduler',
  { reconcileCron: 'SCHEDULER_RECONCILE_CRON', reconcileTz: 'SCHEDULER_RECONCILE_TZ', tenantMinIntervalSec: 'SCHEDULER_TENANT_MIN_INTERVAL_SEC' },
  z.object({
    reconcileCron: z.string().min(1).default('*/10 * * * *').describe('Cron for reconciling scheduled_tasks with the queue'),
    reconcileTz: z.string().min(1).default('UTC').describe('Timezone for the reconcile cron'),
    tenantMinIntervalSec: z.coerce.number().int().positive().default(300).describe('Minimum interval between runs of a tenant-defined schedule'),
  }),
);
```
`src/core/scheduler/cron-definition.ts` (chỉ import type từ `core/queue`, không tạo vòng phụ thuộc):
```ts
import type { JobDef } from '../queue/index.js';

export type CronDef = { key: string; job: JobDef; payload: unknown; schedule: () => { cron: string; tz: string } };
const crons = new Map<string, CronDef>();
const retired = new Set<string>();

export function defineCron(def: CronDef): CronDef {
  if (crons.has(def.key)) throw new Error(`Cron "${def.key}" already defined`);
  crons.set(def.key, def);
  return def;
}
/** Đánh dấu một cron tĩnh đã bỏ, để StaticScheduler xoá nó. Không bao giờ xoá cron chỉ vì process hiện tại không khai báo (rolling deploy). */
export function retireCron(key: string): void {
  retired.add(key);
}
export const cronRegistry = (): CronDef[] => [...crons.values()];
export const retiredCrons = (): string[] => [...retired];
```
`src/core/scheduler/static-scheduler.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { JobScheduler } from '../queue/index.js';
import { cronRegistry, retiredCrons } from './cron-definition.js';

export const STATIC_PREFIX = 'static-';

@Injectable()
export class StaticScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(StaticScheduler.name);
  constructor(private readonly scheduler: JobScheduler, @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.app.role !== 'worker') return;
    this.logger.log(await this.sync(), 'static cron synced');
  }

  async sync(): Promise<{ upserted: string[]; removed: string[] }> {
    const upserted: string[] = [];
    for (const c of cronRegistry()) {
      const id = `${STATIC_PREFIX}${c.key}`;
      await this.scheduler.upsert(id, c.job, c.payload, c.schedule());
      upserted.push(id);
    }
    const existing = new Set(await this.scheduler.listIds(STATIC_PREFIX));
    const removed: string[] = [];
    for (const key of retiredCrons()) {
      const id = `${STATIC_PREFIX}${key}`;
      if (existing.has(id)) { await this.scheduler.remove(id); removed.push(id); }
    }
    return { upserted, removed };
  }
}
```
`src/core/scheduler/scheduled-task.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { Db, UnitOfWork } from '../database/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { JobScheduler, type JobDef } from '../queue/index.js';
import { schedulerConfig } from './scheduler.config.js';

const KEY_PATTERN = /^[a-z0-9._]{1,64}$/;
const FIVE_FIELD_CRON = 5;
const INTERVAL_SAMPLES = 3;
export const tenantTaskId = (orgId: string, key: string) => `task-${orgId}-${key}`;

@Injectable()
export class ScheduledTaskService {
  constructor(
    private readonly uow: UnitOfWork, private readonly db: Db, private readonly scheduler: JobScheduler, private readonly ctx: RequestContext,
    @Inject(schedulerConfig.KEY) private readonly cfg: ConfigOf<typeof schedulerConfig>,
  ) {}

  private invalid(path: string, message: string): AppError {
    return new AppError(CoreErrors.VALIDATION_FAILED, { fields: [{ path, code: 'invalid', message }] });
  }

  private orgOrThrow(): string {
    const org = this.ctx.orgId();
    if (!org) throw new AppError(CoreErrors.ORG_CONTEXT_INVALID, { detail: 'Scheduled tasks must be managed inside an organization scope' });
    return org;
  }

  private assertSchedule(cron: string, tz: string): void {
    try { Intl.DateTimeFormat(undefined, { timeZone: tz }); } catch { throw this.invalid('timezone', `Unknown timezone "${tz}"`); }
    if (cron.trim().split(/\s+/).length !== FIVE_FIELD_CRON) throw this.invalid('cron', 'Use a 5-field cron expression (no seconds)');
    let it;
    try { it = CronExpressionParser.parse(cron, { tz }); } catch { throw this.invalid('cron', 'Invalid cron expression'); }
    const times = Array.from({ length: INTERVAL_SAMPLES }, () => it.next().getTime());
    for (let i = 1; i < times.length; i++) {
      if ((times[i]! - times[i - 1]!) / 1000 < this.cfg.tenantMinIntervalSec) throw this.invalid('cron', `Runs must be at least ${this.cfg.tenantMinIntervalSec}s apart`);
    }
  }

  async upsert(i: { key: string; job: JobDef; cron: string; timezone: string; payload: unknown; enabled: boolean }): Promise<void> {
    const org = this.orgOrThrow();
    if (!KEY_PATTERN.test(i.key)) throw this.invalid('key', 'key must match [a-z0-9._]{1,64}');
    if (!i.job.tenantSchedulable) throw this.invalid('job', `Job "${i.job.name}" cannot be scheduled by tenants`);
    this.assertSchedule(i.cron, i.timezone);
    const payload = i.job.schema.parse(i.payload);
    await this.uow.run(() => this.db.execute(
      `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
       ON CONFLICT ON CONSTRAINT scheduled_tasks_org_key_uq DO UPDATE SET job_name = EXCLUDED.job_name, cron = EXCLUDED.cron,
       timezone = EXCLUDED.timezone, payload = EXCLUDED.payload, enabled = EXCLUDED.enabled, updated_at = now()`,
      [org, i.key, i.job.name, i.cron, i.timezone, JSON.stringify(payload), i.enabled],
    ));
    const id = tenantTaskId(org, i.key);
    if (i.enabled) await this.scheduler.upsert(id, i.job, payload, { cron: i.cron, tz: i.timezone }, { orgId: org });
    else await this.scheduler.remove(id);
  }

  async remove(key: string): Promise<void> {
    const org = this.orgOrThrow();
    await this.uow.run(() => this.db.execute('DELETE FROM scheduled_tasks WHERE key = ?', [key]));
    await this.scheduler.remove(tenantTaskId(org, key));
  }
}
```
Verify `CronExpressionParser.parse(expr, { tz })` và `.next()` của `cron-parser` latest; cài bằng `pnpm view cron-parser dist-tags && pnpm add cron-parser`. Hai lời gọi scheduler sau commit có thể lỗi (Redis); reconcile sửa lại.

`src/core/scheduler/schedule-reconciler.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { RelayDb } from '../database/index.js';
import { JobScheduler, findJob } from '../queue/index.js';
import { tenantTaskId } from './scheduled-task.service.js';

type Row = { org_id: string; key: string; job_name: string; cron: string; timezone: string; payload: unknown; enabled: boolean };

@Injectable()
export class ScheduleReconciler {
  private readonly logger = new Logger(ScheduleReconciler.name);
  constructor(private readonly relayDb: RelayDb, private readonly scheduler: JobScheduler) {}

  /** Upsert lại mọi task đang bật (idempotent, sửa cả cron/tz/payload bị lệch) và xoá scheduler tenant không còn trong bảng. */
  async reconcile(): Promise<{ upserted: number; removed: number }> {
    const rows = await this.relayDb.execute<Row>('SELECT org_id, key, job_name, cron, timezone, payload, enabled FROM scheduled_tasks');
    const wanted = new Set<string>();
    let upserted = 0;
    for (const r of rows) {
      if (!r.enabled) continue;
      const job = findJob(r.job_name);
      if (!job?.tenantSchedulable) { this.logger.error({ key: r.key, job: r.job_name }, 'scheduled task references an unknown or non-schedulable job'); continue; }
      const id = tenantTaskId(r.org_id, r.key);
      wanted.add(id);
      await this.scheduler.upsert(id, job, r.payload, { cron: r.cron, tz: r.timezone }, { orgId: r.org_id });
      upserted++;
    }
    let removed = 0;
    for (const id of await this.scheduler.listIds('task-')) if (!wanted.has(id)) { await this.scheduler.remove(id); removed++; }
    return { upserted, removed };
  }
}
```
`src/core/scheduler/scheduler.jobs.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { JobHandler, MaintenanceQueue, defineJob } from '../queue/index.js';
import { defineCron } from './cron-definition.js';
import { ScheduleReconciler } from './schedule-reconciler.js';
import { schedulerConfig } from './scheduler.config.js';

export const ReconcileSchedulesJob = defineJob({ name: 'core.scheduler.reconcile', queue: MaintenanceQueue, version: 1, schema: z.object({}) });
defineCron({ key: 'core.scheduler.reconcile', job: ReconcileSchedulesJob, payload: {}, schedule: () => { const c = schedulerConfig(); return { cron: c.reconcileCron, tz: c.reconcileTz }; } });

@Injectable() @JobHandler(ReconcileSchedulesJob)
export class ReconcileSchedulesHandler {
  constructor(private readonly reconciler: ScheduleReconciler) {}
  async handle(): Promise<void> { await this.reconciler.reconcile(); }
}
```
`src/core/scheduler/scheduler.module.ts`:
```ts
import { DynamicModule, Module } from '@nestjs/common';
import { ScheduleReconciler } from './schedule-reconciler.js';
import { ScheduledTaskService } from './scheduled-task.service.js';
import { ReconcileSchedulesHandler } from './scheduler.jobs.js';
import { StaticScheduler } from './static-scheduler.js';

@Module({})
export class SchedulerModule {
  static forRoot(opts: { worker: boolean }): DynamicModule {
    const worker = opts.worker ? [StaticScheduler, ScheduleReconciler, ReconcileSchedulesHandler] : [];
    return { module: SchedulerModule, global: true, providers: [ScheduledTaskService, ...worker], exports: [ScheduledTaskService, ...worker] };
  }
}
```
`src/core/scheduler/index.ts`: export `SchedulerModule`, `ScheduledTaskService`, `StaticScheduler`, `ScheduleReconciler`, `defineCron`, `retireCron`, `schedulerConfig`, `tenantTaskId`. Thêm config vào `all-configs.ts`. Module gốc: api `forRoot({ worker: false })`, worker `forRoot({ worker: true })`.

Cleanup outbox — thêm vào `src/core/outbox/outbox.jobs.ts`:
```ts
import { MaintenanceQueue } from '../queue/index.js';
import { defineCron } from '../scheduler/cron-definition.js';
import { outboxConfig } from './outbox.config.js';

export const OutboxCleanupJob = defineJob({ name: 'core.outbox.cleanup', queue: MaintenanceQueue, version: 1, schema: z.object({}) });
defineCron({ key: 'core.outbox.cleanup', job: OutboxCleanupJob, payload: {}, schedule: () => { const c = outboxConfig(); return { cron: c.cleanupCron, tz: c.cleanupTz }; } });
```
`src/core/outbox/outbox-cleanup.handler.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { RelayDb } from '../database/index.js';
import { JobHandler } from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { OutboxCleanupJob } from './outbox.jobs.js';

@Injectable() @JobHandler(OutboxCleanupJob)
export class OutboxCleanupHandler {
  private readonly logger = new Logger(OutboxCleanupHandler.name);
  constructor(private readonly relayDb: RelayDb, @Inject(outboxConfig.KEY) private readonly cfg: ConfigOf<typeof outboxConfig>) {}

  private async deleteInBatches(sql: string, days: number): Promise<number> {
    let total = 0;
    for (;;) {
      const [row] = await this.relayDb.execute<{ n: string }>(sql, [days, this.cfg.cleanupBatchSize]);
      const n = Number(row?.n ?? 0);
      total += n;
      if (n < this.cfg.cleanupBatchSize) return total;
    }
  }

  async handle(): Promise<void> {
    const outbox = await this.deleteInBatches(
      `WITH victim AS (SELECT id FROM outbox_events WHERE published_at < now() - make_interval(days => ?) ORDER BY published_at LIMIT ?)
       , d AS (DELETE FROM outbox_events o USING victim v WHERE o.id = v.id RETURNING 1) SELECT count(*)::text AS n FROM d`,
      this.cfg.retentionDays,
    );
    const inbox = await this.deleteInBatches(
      `WITH victim AS (SELECT consumer, event_id FROM processed_events WHERE processed_at < now() - make_interval(days => ?) ORDER BY processed_at LIMIT ?)
       , d AS (DELETE FROM processed_events p USING victim v WHERE p.consumer = v.consumer AND p.event_id = v.event_id RETURNING 1) SELECT count(*)::text AS n FROM d`,
      this.cfg.inboxRetentionDays,
    );
    this.logger.log({ outboxDeleted: outbox, inboxDeleted: inbox }, 'outbox cleanup done');
  }
}
```
`OutboxCleanupHandler` chỉ đăng ký khi `OutboxModule.forRoot({ relay: true })` (thêm vào mảng `relay`). Export từ `core/outbox/index.ts`.

Run: `pnpm build && pnpm test:int` → PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): job schedulers, rls-protected tenant schedules with reconcile, batched outbox cleanup"
```

---

### Task 12: `core/http` — validate, response chuẩn, phân trang, ETag, Merge Patch, OpenAPI, proxy

**Files:**
- Create: `src/core/http/{trust-proxy.ts,pagination.config.ts,pagination.ts,response.ts,conditional.ts,content-type.middleware.ts,api-problems.decorator.ts,http-bootstrap.ts,openapi.ts,http.module.ts,index.ts}`, `src/core/database/sql-helpers.ts`, `src/scripts/export-openapi.ts`, `openapi.json`
- Modify: `src/core/http/http.config.ts`, `src/main.api.ts`, `test/fixtures/fixture.module.ts` (thêm `listPage`)
- Test: `test/unit/core/http/pagination.spec.ts`, `test/unit/core/http/conditional.spec.ts`, `test/unit/core/http/trust-proxy.spec.ts`, `test/unit/core/database/sql-helpers.spec.ts`, `test/e2e/core/http-conventions.e2e.spec.ts`, `test/integration/core/http/cursor-pagination.spec.ts`

**Interfaces:**
- Consumes: `AppError`, `CoreErrors`, `zodIssuesToFields`, `RequestContext.path()`, `defineConfig`, `defineProductionRule`, `Db`
- Produces:
  - `offsetPageQuery({ sortable })`, `cursorPageQuery()`; `offsetPageSchema(item)`, `cursorPageSchema(item)`, `problemSchema`
  - `OffsetPage<T>`, `CursorPage<T>`; `Paginator.offset(data, q, countUpToCap)`, `Paginator.cursor(data, { hasMore, nextCursor })`
  - `countUpTo(db: Db, innerSql: string, params: unknown[], cap: number): Promise<number>` và `escapeLike(s: string): string` (trong `core/database/sql-helpers.ts`)
  - `serialize(schema, value)`, `setLocation(res, location)`, `HeaderWriter`
  - `etagOf(version)`, `assertIfMatch(ifMatch, version, { required })`, `mergePatchSchema(schema)`
  - `@ApiProblems(...errors)`; `applyHttpDefaults(app)`; `buildOpenApi(app)`; `setupApiDocs(app)`; `parseTrustProxy(raw): boolean | number | string[]`; `HttpModule`

- [ ] **Step 1: Cài package và verify API (framework trước)**

```bash
for p in helmet @nestjs/swagger @scalar/nestjs-api-reference; do pnpm view $p dist-tags peerDependencies; done
pnpm add helmet @nestjs/swagger @scalar/nestjs-api-reference
```
Verify, ghi vào ADR 0007:
- (a) Nest 12: import và option `exceptionFactory` của `StandardSchemaValidationPipe`; issue truyền vào có `code`/`format` của zod không (`https://docs.nestjs.com/techniques/validation`)
- (b) `@Body({ schema })`, `@Query({ schema })` và cách `@nestjs/swagger` 12 sinh schema từ Standard Schema
- (c) `app.useBodyParser('json', { type, limit })` trên Express (`https://docs.nestjs.com/faq/raw-body`)
- (d) Express tự sinh ETag và trả `304` theo `If-None-Match`, không ghi đè ETag đã set
- (e) MikroORM 7 `em.findByCursor(entity, { where, first, after, orderBy, includeCount })` (**hai tham số**), thuộc tính `items`, `hasNextPage`, `endCursor`, và exception khi cursor hỏng
- (f) Scalar `apiReference({ content, cdn })`: option pin URL script; `NestFactory.create(…, { preview: true })` có chạy factory config/provider không
- (g) `z.toJSONSchema` của zod 4

- [ ] **Step 2: Viết test trước**

`test/unit/core/http/pagination.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Paginator } from '../../../../src/core/http/index.js';
import type { RequestContext } from '../../../../src/core/context/index.js';

const ctx = { path: () => '/api/v1/admin/users' } as unknown as RequestContext;
const p = new Paginator(ctx, { maxPageSize: 100, defaultPageSize: 20, maxOffsetRows: 100, totalCountCap: 100 });

describe('Paginator', () => {
  it('offset: exact totalCount below cap', () => {
    expect(p.offset([{ id: '1' }], { page: 1, pageSize: 20 }, 42)).toEqual({ url: '/api/v1/admin/users', data: [{ id: '1' }], page: 1, pageSize: 20, totalCount: 42, totalCountExact: true, hasMore: true });
  });
  it('offset: last page has hasMore=false', () => { expect(p.offset([], { page: 3, pageSize: 20 }, 42).hasMore).toBe(false); });
  it('offset: above cap reports cap with totalCountExact=false', () => {
    expect(p.offset([], { page: 1, pageSize: 20 }, 101)).toMatchObject({ totalCount: 100, totalCountExact: false, hasMore: true });
  });
  it('offset: never promises a page beyond maxOffsetRows', () => {
    expect(p.offset([], { page: 5, pageSize: 20 }, 101).hasMore).toBe(false);
  });
  it('cursor: flat shape, nextCursor null when no more', () => {
    expect(p.cursor([{ id: 'a' }], { hasMore: true, nextCursor: 'c1' })).toEqual({ url: '/api/v1/admin/users', data: [{ id: 'a' }], hasMore: true, nextCursor: 'c1' });
    expect(p.cursor([], { hasMore: false, nextCursor: 'stale' }).nextCursor).toBeNull();
  });
});
```
`test/unit/core/database/sql-helpers.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { escapeLike } from '../../../../src/core/database/index.js';

describe('escapeLike', () => {
  it('escapes wildcard and escape characters', () => { expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x'); });
});
```
`test/unit/core/http/trust-proxy.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../../../../src/core/http/index.js';

describe('parseTrustProxy', () => {
  it('parses booleans, hop counts and address lists', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
  });
});
```
`test/unit/core/http/conditional.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../../src/core/errors/index.js';
import { assertIfMatch, etagOf, mergePatchSchema } from '../../../../src/core/http/index.js';

const code = (fn: () => void) => { try { fn(); return 'ok'; } catch (e) { return e instanceof AppError ? e.error.code : 'other'; } };

describe('conditional requests', () => {
  it('etagOf is a weak validator of the version', () => { expect(etagOf(7)).toBe('W/"7"'); });
  it('If-Match matching passes; stale fails; missing required fails', () => {
    expect(code(() => assertIfMatch('W/"7"', 7, { required: true }))).toBe('ok');
    expect(code(() => assertIfMatch('W/"6", "7"', 7, { required: true }))).toBe('ok');
    expect(code(() => assertIfMatch('W/"6"', 7, { required: true }))).toBe('precondition_failed');
    expect(code(() => assertIfMatch(undefined, 7, { required: true }))).toBe('precondition_required');
    expect(code(() => assertIfMatch(undefined, 7, { required: false }))).toBe('ok');
  });
});

describe('mergePatchSchema', () => {
  const User = z.object({ name: z.string().min(1), nickname: z.string().nullable() });
  const Patch = mergePatchSchema(User);
  it('fields optional; null only where the source field is nullable', () => {
    expect(Patch.parse({})).toEqual({});
    expect(Patch.parse({ nickname: null })).toEqual({ nickname: null });
    expect(Patch.safeParse({ name: null }).success).toBe(false);
  });
  it('validates values and rejects unknown fields', () => {
    expect(Patch.safeParse({ name: '' }).success).toBe(false);
    expect(Patch.safeParse({ role: 'ADMIN' }).success).toBe(false);
  });
});
```
`test/e2e/core/http-conventions.e2e.spec.ts`:
```ts
import { Body, Controller, Delete, Get, Headers, HttpCode, Module, Param, Patch, Post, Query, Res, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpModule, Paginator, applyHttpDefaults, assertIfMatch, etagOf, mergePatchSchema, offsetPageQuery, serialize, setLocation, type HeaderWriter } from '../../../src/core/http/index.js';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const User = z.object({ id: z.string(), email: z.email(), name: z.string().min(1), role: z.enum(['USER', 'ADMIN']) });
const CreateUser = User.pick({ email: true, name: true });
const PatchUser = mergePatchSchema(User.pick({ name: true }));
type Stored = { id: string; email: string; name: string; role: 'USER' | 'ADMIN'; passwordHash: string; version: number };
const store = new Map<string, Stored>();
const ListQ = offsetPageQuery({ sortable: ['name'] as const });

@Controller('api/v1/users')
class UsersController {
  constructor(private readonly pages: Paginator) {}
  @Get()
  list(@Query({ schema: ListQ }) q: z.infer<typeof ListQ>) {
    const all = [...store.values()];
    return this.pages.offset(all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((u) => serialize(User, u)), q, all.length);
  }
  @Post()
  create(@Body({ schema: CreateUser }) b: z.infer<typeof CreateUser>, @Res({ passthrough: true }) res: HeaderWriter) {
    const id = String(store.size + 1);
    store.set(id, { id, ...b, role: 'USER', passwordHash: 'secret-hash', version: 1 });
    setLocation(res, `/api/v1/users/${id}`);
    return serialize(User, store.get(id));
  }
  @Get(':id')
  get(@Param('id') id: string, @Res({ passthrough: true }) res: HeaderWriter) {
    const u = store.get(id);
    if (!u) throw new AppError(CoreErrors.NOT_FOUND);
    res.setHeader('ETag', etagOf(u.version));
    return serialize(User, u);
  }
  @Patch(':id')
  patch(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body({ schema: PatchUser }) b: z.infer<typeof PatchUser>, @Res({ passthrough: true }) res: HeaderWriter) {
    const u = store.get(id);
    if (!u) throw new AppError(CoreErrors.NOT_FOUND);
    assertIfMatch(ifMatch, u.version, { required: true });
    if (b.name !== undefined) u.name = b.name;
    u.version += 1;
    res.setHeader('ETag', etagOf(u.version));
    return serialize(User, u);
  }
  @Delete(':id') @HttpCode(204)
  remove(@Param('id') id: string) { store.delete(id); }
}
@Module({ controllers: [UsersController] }) class M {}

describe('HTTP conventions (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  beforeAll(async () => { app = await createTestApp([RedisModule, HttpModule, M], { beforeInit: applyHttpDefaults }); });
  afterAll(async () => { await app.close(); });

  it('POST → 201, Location, body without internal fields', async () => {
    const res = await http().post('/api/v1/users').send({ email: 'me@example.com', name: 'Me' }).expect(201);
    expect(res.headers.location).toBe('/api/v1/users/1');
    expect(res.body).toEqual({ id: '1', email: 'me@example.com', name: 'Me', role: 'USER' });
  });
  it('invalid body → 422 validation_failed with dot paths and codes', async () => {
    const res = await http().post('/api/v1/users').send({ email: 'nope', name: '' }).expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'email', code: 'invalid_email' }), expect.objectContaining({ path: 'name', code: 'too_small' })]));
  });
  it('unsupported Content-Type → 415; body over limit → 413', async () => {
    expect((await http().post('/api/v1/users').set('content-type', 'text/plain').send('email=x').expect(415)).body.code).toBe('unsupported_media_type');
    expect((await http().post('/api/v1/users').send({ email: 'a@b.co', name: 'x'.repeat(2 * 1024 * 1024) }).expect(413)).body.code).toBe('payload_too_large');
  });
  it('GET list → flat offset page; oversize/too deep → 422', async () => {
    expect((await http().get('/api/v1/users?page=1&pageSize=20').expect(200)).body).toMatchObject({ url: '/api/v1/users', page: 1, pageSize: 20, totalCount: 1, totalCountExact: true, hasMore: false });
    expect((await http().get('/api/v1/users?pageSize=100000').expect(422)).body.code).toBe('validation_failed');
    expect((await http().get('/api/v1/users?page=100000&pageSize=100').expect(422)).body.code).toBe('validation_failed');
  });
  it('GET resource → ETag; If-None-Match → 304', async () => {
    const res = await http().get('/api/v1/users/1').expect(200);
    expect(res.headers.etag).toBe('W/"1"');
    await http().get('/api/v1/users/1').set('If-None-Match', res.headers.etag).expect(304);
  });
  it('PATCH merge-patch: 428 without If-Match, 412 stale, 200 current', async () => {
    const patch = () => http().patch('/api/v1/users/1').set('content-type', 'application/merge-patch+json');
    expect((await patch().send({ name: 'New' }).expect(428)).body.code).toBe('precondition_required');
    expect((await patch().set('If-Match', 'W/"0"').send({ name: 'New' }).expect(412)).body.code).toBe('precondition_failed');
    const ok = await patch().set('If-Match', 'W/"1"').send({ name: 'New' }).expect(200);
    expect(ok.body.name).toBe('New');
    expect(ok.headers.etag).toBe('W/"2"');
  });
  it('404 not_found; DELETE → 204 empty', async () => {
    expect((await http().get('/api/v1/users/999').expect(404)).body.code).toBe('not_found');
    expect((await http().delete('/api/v1/users/1').expect(204)).text).toBe('');
  });
});
```
`test/integration/core/http/cursor-pagination.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Module, Query, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule, UnitOfWork } from '../../../../src/core/database/index.js';
import { HttpModule, Paginator, applyHttpDefaults, cursorPageQuery } from '../../../../src/core/http/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const Q = cursorPageQuery();
const PREFIX = `cursor_${Date.now()}%`;
@Controller('notes')
class NotesController {
  constructor(private readonly repo: FixtureRepo, private readonly pages: Paginator) {}
  @Get() async list(@Query({ schema: Q }) q: { limit: number; cursor?: string }) {
    const page = await this.repo.listPage(PREFIX, q);
    return this.pages.cursor(page.items, page);
  }
}
@Module({ imports: [FixtureModule], controllers: [NotesController] }) class M {}

describe('cursor pagination (MikroORM)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, HttpModule, M], { beforeInit: applyHttpDefaults });
    await app.get(UnitOfWork).run(async () => { for (let i = 0; i < 25; i++) await app.get(FixtureRepo).insertSystemNote(`${PREFIX}-${String(i).padStart(2, '0')}`); });
    await app.get(UnitOfWork).run(() => app.get(FixtureRepo).insertSystemNote('cursor_decoy-not-matching'));
  });
  afterAll(async () => { await app.close(); });

  it('walks every row once, in order; LIKE wildcards in the prefix are treated literally', async () => {
    const seen: string[] = []; let cursor: string | null = null;
    do {
      const res: request.Response = await request(app.getHttpServer()).get(`/notes?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
      seen.push(...res.body.data.map((d: { body: string }) => d.body));
      cursor = res.body.nextCursor;
      expect(res.body.hasMore).toBe(cursor !== null);
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(seen).toEqual([...seen].sort());
  });
  it('malformed and forged cursors → 400 invalid_cursor, never 500', async () => {
    const forged = Buffer.from(JSON.stringify(['not-a-number'])).toString('base64url');
    for (const c of ['not-a-real-cursor', forged]) {
      const res = await request(app.getHttpServer()).get(`/notes?limit=10&cursor=${c}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
    }
  });
});
```
Test "forged" dùng một cursor giải mã được nhưng sai kiểu dữ liệu; kiểm tra định dạng cursor thật của MikroORM (Step 1 (e)) và chỉnh cách tạo chuỗi forged cho đúng dạng (base64 của JSON mảng giá trị sort).

Thêm vào `FixtureRepo` — **mẫu chuẩn** cho repo có danh sách cursor (repo trả dữ liệu thô, controller bọc `Paginator`):
```ts
import { AppError, CoreErrors } from '../../src/core/errors/index.js';
import { TxEm, escapeLike } from '../../src/core/database/index.js';
import { FixtureNote } from './fixture.entity.js';

async listPage(prefix: string, q: { limit: number; cursor?: string }): Promise<{ items: { body: string }[]; hasMore: boolean; nextCursor: string | null }> {
  try {
    const res = await this.txEm.fork().findByCursor(FixtureNote, {
      where: { body: { $like: `${escapeLike(prefix)}%` } },
      first: q.limit, after: q.cursor, orderBy: { body: 'asc', id: 'asc' }, includeCount: false,
    });
    return { items: res.items.map((n) => ({ body: n.body })), hasMore: res.hasNextPage, nextCursor: res.hasNextPage ? res.endCursor : null };
  } catch (err) {
    if (q.cursor) throw new AppError(CoreErrors.INVALID_CURSOR, { detail: 'The cursor is malformed or no longer valid', cause: err });
    throw err;
  }
}
```
(`FixtureRepo` inject thêm `TxEm`; repo nằm trong vùng infra nên được dùng ORM.) Lỗi khi có cursor — kể cả lỗi decode của MikroORM hay lỗi kiểu dữ liệu `22P02` từ Postgres với cursor giả mạo — đều thành `400 invalid_cursor`.

Run: `pnpm test && pnpm test:int` → FAIL.

- [ ] **Step 3: Cài đặt**

`src/core/database/sql-helpers.ts` (export từ `core/database/index.ts`):
```ts
import type { Db } from './db.js';

/** Escape cho LIKE với ký tự escape mặc định "\". */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Đếm có trần: không bao giờ quét quá cap+1 dòng. `innerSql` là một SELECT không có ORDER BY. */
export async function countUpTo(db: Db, innerSql: string, params: unknown[], cap: number): Promise<number> {
  const [row] = await db.execute<{ n: string }>(`SELECT count(*)::text AS n FROM (${innerSql} LIMIT ?) AS capped`, [...params, cap + 1]);
  return Number(row?.n ?? 0);
}
```
`src/core/http/trust-proxy.ts`:
```ts
/** Giá trị hợp lệ cho Express "trust proxy": boolean, số hop, hoặc danh sách địa chỉ/CIDR/tên preset. */
export function parseTrustProxy(raw: string): boolean | number | string[] {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
```
`src/core/http/http.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../config/index.js';
import { parseTrustProxy } from './trust-proxy.js';

export const httpConfig = defineConfig(
  'http',
  {
    port: 'HTTP_PORT', host: 'HTTP_HOST', bodyLimit: 'HTTP_BODY_LIMIT', corsOrigins: 'HTTP_CORS_ORIGINS', trustProxy: 'HTTP_TRUST_PROXY',
    allowedContentTypes: 'HTTP_ALLOWED_CONTENT_TYPES', docsEnabled: 'HTTP_DOCS_ENABLED', docsPath: 'HTTP_DOCS_PATH', docsCdnUrl: 'HTTP_DOCS_CDN_URL',
  },
  z.object({
    port: z.coerce.number().int().min(0).default(3000).describe('HTTP listen port'),
    host: z.string().default('0.0.0.0').describe('HTTP listen host'),
    bodyLimit: z.string().default('1mb').describe('Max request body size (larger → 413)'),
    corsOrigins: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).describe('Allowed CORS origins; empty = CORS disabled'),
    trustProxy: z.string().default('false').transform(parseTrustProxy).describe('Express trust proxy: true|false|hop count|comma-separated addresses/CIDRs'),
    allowedContentTypes: z.string().default('application/json,application/merge-patch+json').transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)).describe('Accepted request Content-Types (others → 415)'),
    docsEnabled: z.stringbool().default(false).describe('Serve API reference UI'),
    docsPath: z.string().startsWith('/').default('/docs').describe('Path of API reference UI'),
    docsCdnUrl: z.url().optional().describe('Version-pinned URL of the API reference script (required when docs are enabled)'),
  }).refine((c) => !c.docsEnabled || c.docsCdnUrl, { message: 'HTTP_DOCS_CDN_URL is required when HTTP_DOCS_ENABLED=true', path: ['docsCdnUrl'] }),
);
defineProductionRule('http-no-docs', (c) => (c.http?.docsEnabled ? 'HTTP_DOCS_ENABLED must be false in production' : undefined));
```
`defineConfig` nhận `z.ZodObject`; nếu `.refine` làm schema không còn là `ZodObject` trong zod 4 thì dùng `.check()`/`superRefine` theo tài liệu zod 4 sao cho kiểu vẫn là object, hoặc nới kiểu tham số của `defineConfig` thành `z.ZodType<object>` và lấy `shape` qua `schema._zod.def` (cập nhật `renderEnvExample` tương ứng).

`src/core/http/pagination.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const paginationConfig = defineConfig(
  'pagination',
  { maxPageSize: 'PAGINATION_MAX_PAGE_SIZE', defaultPageSize: 'PAGINATION_DEFAULT_PAGE_SIZE', maxOffsetRows: 'PAGINATION_MAX_OFFSET_ROWS', totalCountCap: 'PAGINATION_TOTAL_COUNT_CAP' },
  z.object({
    maxPageSize: z.coerce.number().int().positive().default(100).describe('Upper bound for pageSize/limit'),
    defaultPageSize: z.coerce.number().int().positive().default(20).describe('Default pageSize/limit'),
    maxOffsetRows: z.coerce.number().int().positive().default(10000).describe('Max page*pageSize for offset pagination'),
    totalCountCap: z.coerce.number().int().positive().default(10000).describe('totalCount is exact up to this cap; above it totalCountExact=false'),
  }),
);
```
Config này **không có trường bắt buộc** (schema query được dựng lúc import controller).

`src/core/http/pagination.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { paginationConfig } from './pagination.config.js';

export type OffsetPage<T> = { url: string; data: T[]; page: number; pageSize: number; totalCount: number; totalCountExact: boolean; hasMore: boolean };
export type CursorPage<T> = { url: string; data: T[]; hasMore: boolean; nextCursor: string | null };

export function offsetPageQuery<const S extends readonly [string, ...string[]]>(opts: { sortable: S }) {
  const cfg = paginationConfig();
  const sortField = z.enum(opts.sortable);
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(cfg.maxPageSize).default(cfg.defaultPageSize),
    sort: z.string().refine((s) => sortField.safeParse(s.replace(/^-/, '')).success, { message: `sort must be one of ${opts.sortable.join(', ')} (prefix - for desc)` }).optional(),
  }).refine((q) => q.page * q.pageSize <= cfg.maxOffsetRows, { message: `page*pageSize must be <= ${cfg.maxOffsetRows}`, path: ['page'] });
}

export function cursorPageQuery() {
  const cfg = paginationConfig();
  return z.object({ limit: z.coerce.number().int().min(1).max(cfg.maxPageSize).default(cfg.defaultPageSize), cursor: z.string().min(1).optional() });
}

export const offsetPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ url: z.string(), data: z.array(item), page: z.number().int(), pageSize: z.number().int(), totalCount: z.number().int(), totalCountExact: z.boolean(), hasMore: z.boolean() });
export const cursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ url: z.string(), data: z.array(item), hasMore: z.boolean(), nextCursor: z.string().nullable() });

@Injectable()
export class Paginator {
  constructor(private readonly ctx: RequestContext, @Inject(paginationConfig.KEY) private readonly cfg: ConfigOf<typeof paginationConfig>) {}

  offset<T>(data: T[], q: { page: number; pageSize: number }, countUpToCap: number): OffsetPage<T> {
    const exact = countUpToCap <= this.cfg.totalCountCap;
    const totalCount = exact ? countUpToCap : this.cfg.totalCountCap;
    const nextPageAllowed = (q.page + 1) * q.pageSize <= this.cfg.maxOffsetRows;
    const moreRows = !exact || q.page * q.pageSize < totalCount;
    return { url: this.url(), data, page: q.page, pageSize: q.pageSize, totalCount, totalCountExact: exact, hasMore: moreRows && nextPageAllowed };
  }

  cursor<T>(data: T[], next: { hasMore: boolean; nextCursor: string | null }): CursorPage<T> {
    return { url: this.url(), data, hasMore: next.hasMore, nextCursor: next.hasMore ? next.nextCursor : null };
  }

  private url(): string {
    const path = this.ctx.path();
    if (!path) throw new Error('Paginator used outside of an HTTP request context');
    return path;
  }
}
```
`src/core/http/response.ts`:
```ts
import type { z } from 'zod';

export type HeaderWriter = { setHeader(k: string, v: string): void };

/** Chỉ trả field khai báo trong schema (z.object bỏ key lạ). Sai schema là bug phía server → 500. */
export function serialize<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(value);
}
export function setLocation(res: HeaderWriter, location: string): void {
  res.setHeader('Location', location);
}
```
`src/core/http/conditional.ts`:
```ts
import { z } from 'zod';
import { AppError, CoreErrors } from '../errors/index.js';

export const etagOf = (version: number | string): string => `W/"${version}"`;
const opaqueTags = (header: string) => header.split(',').map((t) => t.trim().replace(/^W\//, '')).filter(Boolean);

export function assertIfMatch(ifMatch: string | undefined, version: number | string, opts: { required: boolean }): void {
  if (!ifMatch) {
    if (opts.required) throw new AppError(CoreErrors.PRECONDITION_REQUIRED, { detail: 'Send If-Match with the ETag from your last GET.' });
    return;
  }
  if (ifMatch.trim() === '*') return;
  if (!opaqueTags(ifMatch).includes(`"${version}"`)) {
    throw new AppError(CoreErrors.PRECONDITION_FAILED, { detail: 'The resource was modified since you last read it. Fetch it again and retry.' });
  }
}

/** JSON Merge Patch (RFC 7396): mọi field optional; null chỉ hợp lệ khi field gốc nullable; field lạ bị từ chối. */
export function mergePatchSchema<S extends z.ZodObject>(schema: S) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, (v as z.ZodType).optional()]));
  return z.strictObject(shape);
}
```
So sánh `If-Match` theo version (bỏ `W/`) vì ETag là version của resource, ghi ADR 0007. Field lồng nhau (object con) chưa hỗ trợ merge đệ quy trong SP1: schema lồng nhau bị thay nguyên khối, ghi giới hạn này vào ADR 0007.

`src/core/http/content-type.middleware.ts` (khung bằng `pnpm nest g middleware core/http/content-type --no-spec --flat`):
```ts
import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { httpConfig } from './http.config.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

@Injectable()
export class ContentTypeMiddleware implements NestMiddleware {
  constructor(@Inject(httpConfig.KEY) private readonly cfg: ConfigOf<typeof httpConfig>) {}
  use(req: { method: string; headers: Record<string, string | undefined> }, _res: unknown, next: (err?: unknown) => void): void {
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (!METHODS_WITH_BODY.has(req.method) || !hasBody) return next();
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!this.cfg.allowedContentTypes.includes(type)) return next(new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, { detail: `Content-Type must be one of: ${this.cfg.allowedContentTypes.join(', ')}` }));
    next();
  }
}
```
`src/core/http/api-problems.decorator.ts`:
```ts
import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { ErrorCode } from '../errors/index.js';

export const ApiProblems = (...errors: ErrorCode[]) =>
  applyDecorators(...errors.map((e) => ApiResponse({ status: e.status, description: `${e.code}: ${e.title}`, content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } })));
```
`src/core/http/http-bootstrap.ts` (chỗ **duy nhất** import `@nestjs/platform-express`):
```ts
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppError, CoreErrors, zodIssuesToFields, type ZodIssueLike } from '../errors/index.js';
import { httpConfig } from './http.config.js';

export function applyHttpDefaults(app: INestApplication): void {
  const cfg = httpConfig();
  const express = app as NestExpressApplication;
  express.set('trust proxy', cfg.trustProxy);
  express.set('etag', 'weak');
  express.useBodyParser('json', { type: cfg.allowedContentTypes, limit: cfg.bodyLimit });
  app.use(helmet());
  if (cfg.corsOrigins.length) app.enableCors({ origin: cfg.corsOrigins, credentials: true });
  app.useGlobalPipes(new StandardSchemaValidationPipe({
    exceptionFactory: (issues: readonly ZodIssueLike[]) =>
      new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'One or more fields did not pass validation.', fields: zodIssuesToFields(issues) }),
  }));
}
```
Import `StandardSchemaValidationPipe` và tên option `exceptionFactory` phải khớp Step 1 (a); sửa dòng import nếu pipe nằm ở package khác.

`src/core/http/openapi.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface.js';
import { apiReference } from '@scalar/nestjs-api-reference';
import { z } from 'zod';
import { appConfig } from '../config/index.js';
import { httpConfig } from './http.config.js';

/** Major version của API công khai (khớp tiền tố /v1). */
export const API_MAJOR_VERSION = '1';

export const problemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number().int(), code: z.string(), detail: z.string().optional(),
  instance: z.string(), requestId: z.string(), timestamp: z.iso.datetime(),
  errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional(),
});

/** JSON Schema 2020-12 (zod) và SchemaObject của OpenAPI 3.1 cùng cấu trúc nhưng khác kiểu TS; đây là chỗ chuyển kiểu duy nhất. */
function toOpenApiSchema(schema: z.ZodType): SchemaObject {
  const json: SchemaObject = JSON.parse(JSON.stringify(z.toJSONSchema(schema)));
  return json;
}

export function buildOpenApi(app: INestApplication, title: string): OpenAPIObject {
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle(title).setVersion(API_MAJOR_VERSION).setOpenAPIVersion('3.1.0').build());
  doc.components = { ...doc.components, schemas: { ...doc.components?.schemas, Problem: toOpenApiSchema(problemSchema) } };
  return doc;
}

export function setupApiDocs(app: INestApplication): void {
  const cfg = httpConfig();
  if (!cfg.docsEnabled || !cfg.docsCdnUrl) return;
  app.use(cfg.docsPath, apiReference({ content: buildOpenApi(app, appConfig().serviceName), cdn: cfg.docsCdnUrl }));
}
```
Verify `setOpenAPIVersion`, option `cdn` của Scalar và đường import kiểu `SchemaObject` (nếu `@nestjs/swagger` 12 export thẳng từ gốc package thì import từ đó).

`src/scripts/export-openapi.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppApiModule } from '../app-api.module.js';
import { buildOpenApi } from '../core/http/openapi.js';

const OUTPUT = 'openapi.json';
const TITLE = 'backend-demo';

async function main(): Promise<void> {
  process.env.APP_ROLE = 'api';
  const app = await NestFactory.create(AppApiModule, { preview: true, logger: false, abortOnError: false });
  writeFileSync(OUTPUT, `${JSON.stringify(buildOpenApi(app, TITLE), null, 2)}\n`);
  await app.close();
}
main().catch((err: unknown) => { process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`); process.exit(1); });
```
`preview: true` dựng đồ thị module mà không khởi tạo provider, nên không cần DB/Redis. Nếu Step 1 (f) cho thấy factory config vẫn chạy trong preview, script đọc `.env.example`, điền giá trị giả cho biến `(required)` (URL `http://preview.invalid`, secret sinh bằng `randomBytes`) trước khi tạo app. Script: `"openapi:export": "node dist/scripts/export-openapi.js"`. Chạy và **commit `openapi.json`**.

`src/core/http/http.module.ts` (khung bằng `pnpm nest g module core/http --no-spec`; Task 13 bổ sung):
```ts
import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ContentTypeMiddleware } from './content-type.middleware.js';
import { Paginator } from './pagination.js';

@Global()
@Module({ providers: [Paginator, ContentTypeMiddleware], exports: [Paginator] })
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContentTypeMiddleware).forRoutes('*');
  }
}
```
Verify cú pháp wildcard của `forRoutes` trong Nest 12.

`src/core/http/index.ts` export: `HttpModule`, `Paginator`, `offsetPageQuery`, `cursorPageQuery`, `offsetPageSchema`, `cursorPageSchema`, `problemSchema`, `serialize`, `setLocation`, `etagOf`, `assertIfMatch`, `mergePatchSchema`, `ApiProblems`, `applyHttpDefaults`, `buildOpenApi`, `setupApiDocs`, `parseTrustProxy`, `httpConfig`, `paginationConfig`, type `OffsetPage`, `CursorPage`, `HeaderWriter`. Thêm hai config vào `all-configs.ts`. `main.api.ts` gọi `applyHttpDefaults(app)` và `setupApiDocs(app)` trước `listen`/`init`; `AppApiModule` import `HttpModule`.

Run: `pnpm test && pnpm build && pnpm test:int && pnpm openapi:export` → PASS, `openapi.json` được tạo.

- [ ] **Step 4: ADR 0007, 0012 và commit**

`docs/adr/0007-http-conventions.md`: REST, problem+json qua `HttpAdapterHost`, bảng status, `If-Match` theo version, Merge Patch (null chỉ ở field nullable, chưa merge đệ quy), trust proxy, giới hạn 405, API Nest 12 đã verify. `docs/adr/0012-two-pagination-modes.md`: offset có `totalCount` chặn trần bằng `countUpTo`, `hasMore` tôn trọng `maxOffsetRows`, cursor của MikroORM, lỗi cursor → `invalid_cursor`, `escapeLike`.
```bash
git add -A
git commit -m "feat(core): http conventions — validation, flat pages, bounded counts, etag/if-match, merge patch, openapi"
```

---

### Task 13: Rate limit + Idempotency-Key trên Redis (package có sẵn, lớp nối mỏng)

**Files:**
- Create: `src/core/http/{throttle.config.ts,rate-limiter.storage.ts,app-throttler.guard.ts,idempotency.config.ts,idempotency.storage.ts,idempotency.interceptor.ts,idempotency.decorator.ts}`, `test/support/test-principal.middleware.ts`
- Modify: `src/core/http/{http.module.ts,index.ts}`, `package.json` (`pnpm.overrides`)
- Test: `test/e2e/core/idempotency.e2e.spec.ts`, `test/e2e/core/rate-limit.e2e.spec.ts`, `test/unit/core/http/idempotency.config.spec.ts`
- Docs: `docs/adr/0007-http-conventions.md` (mục rate limit + idempotency)

**Interfaces:**
- Consumes: `REDIS`, `REDIS_NAMESPACE`, `RequestContext` (`principal()`, `orgId()`), `AppError`, `CoreErrors`, `findErrorCode`, `toAppError`, `HttpModule`
- Produces:
  - `RateLimiterThrottlerStorage implements ThrottlerStorage` (dựa trên `RateLimiterRedis` + `insuranceLimiter: RateLimiterMemory`)
  - `AppThrottlerGuard extends ThrottlerGuard` — tracker = `principal:<type>:<id>:<orgId|none>` nếu có principal, ngược lại `ip:<req.ip>`
  - `SkipRateLimit` (re-export `SkipThrottle`, để module khác không import thẳng `@nestjs/throttler`)
  - `@Idempotent(opts?: { ttlSec?: number })` — bắt buộc key, scope theo principal + method + route template
  - `RedisIdempotencyStorage` (interface `Storage` của `@node-idempotency/storage`)
  - `test/support/test-principal.middleware.ts`: `TestPrincipalModule` — **chỉ trong test**, đọc `x-test-principal: <type>:<id>` và `x-test-org: <uuid>` rồi gọi `ctx.setPrincipal`/`ctx.setOrgId`

- [ ] **Step 1: Cài package và verify API (không đoán)**

```bash
for p in @nestjs/throttler rate-limiter-flexible @node-idempotency/core @node-idempotency/storage; do pnpm view $p dist-tags peerDependencies dependencies; done
pnpm add @nestjs/throttler rate-limiter-flexible @node-idempotency/core @node-idempotency/storage
pnpm why ioredis
```
Verify bằng file `.d.ts` trong `node_modules` và README:
- (a) `@nestjs/throttler`: interface `ThrottlerStorage.increment(key, ttl, limit, blockDuration, throttlerName)` và `ThrottlerStorageRecord` (`totalHits`, `timeToExpire`, `isBlocked`, `timeToBlockExpire` — đơn vị **giây** hay ms); `ThrottlerGuard.getTracker(req)`; decorator `InjectThrottlerOptions`, `InjectThrottlerStorage`; `SkipThrottle`; guard có tự set `Retry-After` không.
- (b) `rate-limiter-flexible`: `new RateLimiterRedis({ storeClient, keyPrefix, points, duration, blockDuration, insuranceLimiter, useRedisPackage })`; `consume(key)` resolve `RateLimiterRes` (`consumedPoints`, `msBeforeNext`) và **reject bằng `RateLimiterRes`** khi vượt; lỗi store khi có `insuranceLimiter` thì chuyển sang insurance thay vì reject bằng `Error` (`https://github.com/animir/node-rate-limiter-flexible/wiki/Insurance-Strategy`, `https://github.com/animir/node-rate-limiter-flexible/wiki/Redis`). Ghi rõ vào ADR 0007 nếu `duration`/`blockDuration` chỉ nhận giây nguyên.
- (c) `@node-idempotency/core`: class `Idempotency(storage, options)`, tên option (header, `keyMaxLength`, `cacheTTLMS`, `enforceIdempotency`), `onRequest(req)` (shape `{ headers, body, method, path }`, giá trị trả về khi replay), `onResponse(req, res)` (shape `{ body, additionalHeaders, error }`), class `IdempotencyError` và enum mã lỗi (thiếu key, key quá dài, request đang chạy, fingerprint lệch). Tên enum trong code bên dưới phải sửa đúng theo `.d.ts`.
- (d) `@node-idempotency/storage`: interface `Storage` (`setIfNotExists(key, val, { ttl })`, `set`, `get`, `delete`), đơn vị của `ttl`.
- (e) `pnpm why ioredis` chỉ ra đúng một major. Nếu có hơn một thì thêm vào `package.json`:
```json
"pnpm": { "overrides": { "ioredis": "$ioredis" } }
```
rồi `pnpm install` và chạy lại `pnpm why ioredis`.

- [ ] **Step 2: Viết test trước**

`test/support/test-principal.middleware.ts` (khung bằng `pnpm nest g middleware test-principal --no-spec --flat --path test/support` nếu CLI cho phép đường dẫn ngoài `src`; nếu không thì viết tay file này):
```ts
import { Injectable, MiddlewareConsumer, Module, NestMiddleware, NestModule } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../../src/core/context/index.js';

const PrincipalHeader = z.string().regex(/^(user|api_key|service):[A-Za-z0-9_-]+$/);
const OrgHeader = z.uuid();

/** Chỉ dùng trong test: giả lập principal đã xác thực (SP1 chưa có auth). Không có bản tương đương trong src. */
@Injectable()
export class TestPrincipalMiddleware implements NestMiddleware {
  constructor(private readonly ctx: RequestContext) {}
  use(req: { headers: Record<string, string | undefined> }, _res: unknown, next: () => void): void {
    const p = PrincipalHeader.safeParse(req.headers['x-test-principal']);
    if (p.success) {
      const [type, id] = p.data.split(':');
      if ((type === 'user' || type === 'api_key' || type === 'service') && id) this.ctx.setPrincipal({ type, id });
    }
    const org = OrgHeader.safeParse(req.headers['x-test-org']);
    if (org.success) this.ctx.setOrgId(org.data);
    next();
  }
}

@Module({ providers: [TestPrincipalMiddleware] })
export class TestPrincipalModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TestPrincipalMiddleware).forRoutes('*');
  }
}
```
Middleware này phải chạy **sau** middleware CLS của `ContextModule` (nếu CLS chưa active, `setPrincipal` ném lỗi và test fail rõ ràng). Verify thứ tự bằng chính test idempotency bên dưới.

`test/unit/core/http/idempotency.config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { idempotencyConfig } from '../../../../src/core/http/index.js';

describe('idempotencyConfig', () => {
  it('never allows Set-Cookie in the replay header allowlist', () => {
    expect(() => idempotencyConfig.schema.parse({ replayHeaders: 'location,set-cookie' })).toThrow(/set-cookie/i);
  });
  it('enforces a minimum key length of at least 16', () => {
    expect(() => idempotencyConfig.schema.parse({ keyMinLength: '8' })).toThrow();
  });
});
```
(`defineConfig` trả về đối tượng có `.schema` theo Task 3; nếu tên thuộc tính khác thì dùng đúng tên đó.)

`test/e2e/core/idempotency.e2e.spec.ts`:
```ts
import { Body, Controller, HttpCode, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { HttpModule, Idempotent, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { TestPrincipalModule } from '../../support/test-principal.middleware.js';

let calls = 0;
let failCalls = 0;
const Pay = z.object({ amount: z.number().int().positive(), delayMs: z.number().int().min(0).optional() });
const ORG_A = '0199aaaa-0000-7000-8000-000000000001';
const ORG_B = '0199bbbb-0000-7000-8000-000000000002';
const key = (s: string) => `test-key-${s}-${'x'.repeat(16)}`;

@Controller('api/v1/payments')
class PaymentsController {
  @Post() @HttpCode(201) @Idempotent()
  async create(@Body({ schema: Pay }) b: z.infer<typeof Pay>) {
    calls++;
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    return { id: `p-${calls}`, amount: b.amount };
  }
  @Post('fail') @HttpCode(201) @Idempotent()
  fail() { failCalls++; throw new AppError(CoreErrors.CONFLICT, { detail: 'side effect already applied' }); }
  @Post('crash') @HttpCode(201) @Idempotent()
  crash() { failCalls++; throw new Error('unexpected'); }
}
@Module({ controllers: [PaymentsController] }) class M {}

describe('Idempotency-Key (@node-idempotency/core)', () => {
  let app: INestApplication;
  const post = (path: string, k: string | undefined, body: unknown, who: { principal?: string; org?: string } = { principal: 'user:u1', org: ORG_A }) => {
    const r = request(app.getHttpServer()).post(path).set('content-type', 'application/json');
    if (k) r.set('Idempotency-Key', k);
    if (who.principal) r.set('x-test-principal', who.principal);
    if (who.org) r.set('x-test-org', who.org);
    return r.send(body as object);
  };
  beforeAll(async () => { app = await createTestApp([RedisModule, HttpModule, TestPrincipalModule, M], { beforeInit: applyHttpDefaults }); });
  afterAll(async () => { await app.close(); });

  it('replays the stored response for the same key and body; handler runs once', async () => {
    const before = calls;
    const a = await post('/api/v1/payments', key('1'), { amount: 10 }).expect(201);
    const b = await post('/api/v1/payments', key('1'), { amount: 10 }).expect(201);
    expect(b.body).toEqual(a.body);
    expect(calls - before).toBe(1);
  });

  it('same key, different body → 422 idempotency_key_reused (problem+json)', async () => {
    await post('/api/v1/payments', key('2'), { amount: 1 }).expect(201);
    const res = await post('/api/v1/payments', key('2'), { amount: 2 }).expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'idempotency_key_reused', status: 422 });
  });

  it('concurrent duplicate while the first is in progress → 409 idempotency_conflict, no waiting', async () => {
    const before = calls;
    const first = post('/api/v1/payments', key('3'), { amount: 5, delayMs: 800 });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const dup = await post('/api/v1/payments', key('3'), { amount: 5, delayMs: 800 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('idempotency_conflict');
    expect(Date.now() - started).toBeLessThan(500);
    expect((await first).status).toBe(201);
    expect(calls - before).toBe(1);
  });

  it('missing, too short or malformed key → 400 idempotency_key_required, handler not run', async () => {
    const before = calls;
    for (const k of [undefined, 'short-key', `bad key!${'x'.repeat(16)}`]) {
      expect((await post('/api/v1/payments', k, { amount: 1 }).expect(400)).body.code).toBe('idempotency_key_required');
    }
    expect(calls).toBe(before);
  });

  it('no authenticated principal → 401, handler not run', async () => {
    const before = calls;
    expect((await post('/api/v1/payments', key('4'), { amount: 1 }, {}).expect(401)).body.code).toBe('unauthenticated');
    expect(calls).toBe(before);
  });

  it('a 4xx error is stored and replayed; handler not re-run', async () => {
    const before = failCalls;
    const a = await post('/api/v1/payments/fail', key('5'), {}).expect(409);
    const b = await post('/api/v1/payments/fail', key('5'), {}).expect(409);
    expect(b.body).toMatchObject({ code: a.body.code, detail: a.body.detail });
    expect(failCalls - before).toBe(1);
  });

  it('an unexpected 5xx is stored and replayed as internal_error; handler not re-run', async () => {
    const before = failCalls;
    await post('/api/v1/payments/crash', key('6'), {}).expect(500);
    expect((await post('/api/v1/payments/crash', key('6'), {}).expect(500)).body.code).toBe('internal_error');
    expect(failCalls - before).toBe(1);
  });

  it('validation 422 is stored; fixing the body with the same key → 422 idempotency_key_reused', async () => {
    expect((await post('/api/v1/payments', key('7'), { amount: -1 }).expect(422)).body.code).toBe('validation_failed');
    expect((await post('/api/v1/payments', key('7'), { amount: 1 }).expect(422)).body.code).toBe('idempotency_key_reused');
  });

  it('same key never shares a stored response across orgs, principals or routes', async () => {
    const k = key('shared');
    const a = await post('/api/v1/payments', k, { amount: 7 }, { principal: 'user:u1', org: ORG_A }).expect(201);
    const b = await post('/api/v1/payments', k, { amount: 7 }, { principal: 'user:u1', org: ORG_B }).expect(201);
    const c = await post('/api/v1/payments', k, { amount: 7 }, { principal: 'user:u2', org: ORG_A }).expect(201);
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(3);
  });

  it('X-Org-Id header has no effect on scope', async () => {
    const k = key('hdr');
    const a = await post('/api/v1/payments', k, { amount: 3 }).expect(201);
    const b = await request(app.getHttpServer()).post('/api/v1/payments').set('content-type', 'application/json')
      .set('Idempotency-Key', k).set('x-test-principal', 'user:u1').set('x-test-org', ORG_A).set('X-Org-Id', ORG_B).send({ amount: 3 }).expect(201);
    expect(b.body).toEqual(a.body);
  });
});
```

`test/e2e/core/rate-limit.e2e.spec.ts`:
```ts
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpModule, SkipRateLimit, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { TestPrincipalModule } from '../../support/test-principal.middleware.js';

const LIMIT = 5;
@Controller('ping') class P {
  @Get() ping() { return { ok: true }; }
  @Get('free') @SkipRateLimit() free() { return { ok: true }; }
}
@Module({ controllers: [P] }) class M {}

describe('rate limit (@nestjs/throttler + rate-limiter-flexible)', () => {
  let a1: INestApplication; let a2: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', String(LIMIT));
    vi.stubEnv('THROTTLE_DEFAULT_TTL_MS', '60000');
    const imports = () => [RedisModule, HttpModule, TestPrincipalModule, M];
    a1 = await createTestApp(imports(), { beforeInit: applyHttpDefaults });
    a2 = await createTestApp(imports(), { beforeInit: applyHttpDefaults });
  });
  afterAll(async () => { await a1.close(); await a2.close(); vi.unstubAllEnvs(); });

  const get = (app: INestApplication, path: string, principal?: string) => {
    const r = request(app.getHttpServer()).get(path);
    return principal ? r.set('x-test-principal', principal) : r;
  };

  it('limit is shared across instances through Redis; 429 rate_limited with Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i++) statuses.push((await get(i % 2 ? a2 : a1, '/ping', 'user:heavy')).status);
    expect(statuses).toEqual(Array(LIMIT).fill(200));
    const blocked = await get(a1, '/ping', 'user:heavy');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toContain('application/problem+json');
    expect(blocked.body.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('tracks by principal: another principal behind the same IP is not blocked', async () => {
    expect((await get(a1, '/ping', 'user:light')).status).toBe(200);
  });

  it('SkipRateLimit routes are never limited', async () => {
    for (let i = 0; i < LIMIT * 2; i++) expect((await get(a1, '/ping/free', 'user:heavy')).status).toBe(200);
  });
});
```
Prefix Redis riêng cho từng file đã có sẵn nhờ `baseTestEnv()` (Task 4), nên hai app trong file dùng chung bucket còn file khác thì không. Test Redis sập (insurance limiter trong bộ nhớ vẫn cho qua) nằm ở chaos test Task 19.

Run: `pnpm test && pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 3: Cài đặt rate limit**

`src/core/http/throttle.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const throttleConfig = defineConfig(
  'throttle',
  { limit: 'THROTTLE_DEFAULT_LIMIT', ttlMs: 'THROTTLE_DEFAULT_TTL_MS' },
  z.object({
    limit: z.coerce.number().int().positive().default(300).describe('Default requests per window per tracker (principal, else client IP)'),
    ttlMs: z.coerce.number().int().positive().default(60000).describe('Default rate limit window (ms)'),
  }),
);
```
`src/core/http/rate-limiter.storage.ts`:
```ts
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

const MS_PER_SEC = 1000;
const toSec = (ms: number) => Math.max(1, Math.ceil(ms / MS_PER_SEC));

/**
 * ThrottlerStorage (extension point chính thức của @nestjs/throttler) trên rate-limiter-flexible.
 * Redis sập → insuranceLimiter trong bộ nhớ từng pod tiếp quản (giới hạn vẫn áp, chỉ không chia sẻ giữa pod).
 */
export class RateLimiterThrottlerStorage implements ThrottlerStorage {
  private readonly limiters = new Map<string, RateLimiterRedis>();
  constructor(private readonly redis: Redis, private readonly namespace: string) {}

  private limiter(name: string, ttlMs: number, limit: number, blockMs: number): RateLimiterRedis {
    const id = `${name}-${limit}-${ttlMs}-${blockMs}`;
    let l = this.limiters.get(id);
    if (!l) {
      const duration = toSec(ttlMs);
      const blockDuration = blockMs > 0 ? toSec(blockMs) : 0;
      l = new RateLimiterRedis({
        storeClient: this.redis, useRedisPackage: false, keyPrefix: `${this.namespace}-rl-${id}`,
        points: limit, duration, blockDuration,
        insuranceLimiter: new RateLimiterMemory({ keyPrefix: `rl-${id}`, points: limit, duration, blockDuration }),
      });
      this.limiters.set(id, l);
    }
    return l;
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const l = this.limiter(throttlerName, ttl, limit, blockDuration);
    try {
      const res = await l.consume(key);
      return { totalHits: res.consumedPoints, timeToExpire: toSec(res.msBeforeNext), isBlocked: false, timeToBlockExpire: 0 };
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) throw rejection;
      const wait = toSec(rejection.msBeforeNext);
      return { totalHits: rejection.consumedPoints, timeToExpire: wait, isBlocked: true, timeToBlockExpire: wait };
    }
  }
}
```
Đơn vị (giây/ms) của các field trả về phải khớp Step 1 (a); nếu `ThrottlerStorageRecord` dùng ms thì bỏ `toSec` ở chiều trả về. Lỗi không phải `RateLimiterRes` (chỉ xảy ra khi cả Redis lẫn insurance lỗi) được ném tiếp → `500`, không nuốt.

`src/core/http/app-throttler.guard.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, type ThrottlerModuleOptions, type ThrottlerStorage } from '@nestjs/throttler';
import { RequestContext } from '../context/index.js';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly ctx: RequestContext,
  ) {
    super(options, storage, reflector);
  }

  /** Principal đã xác thực (kèm org) thì đếm theo principal; ẩn danh thì theo IP (đúng nhờ HTTP_TRUST_PROXY). */
  protected override async getTracker(req: { ip?: string }): Promise<string> {
    const p = this.ctx.principal();
    if (p) return `principal:${p.type}:${p.id}:${this.ctx.orgId() ?? 'none'}`;
    if (!req.ip) throw new Error('Cannot determine client IP for rate limiting');
    return `ip:${req.ip}`;
  }
}
```
`SkipRateLimit`: trong `src/core/http/index.ts` viết `export { SkipThrottle as SkipRateLimit } from '@nestjs/throttler';`. Health controller (Task 18) dùng decorator này. Webhook (SP2) cũng phải dùng — đã ghi ở spec cha.

- [ ] **Step 4: Cài đặt idempotency**

`src/core/http/idempotency.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const MIN_KEY_LENGTH_FLOOR = 16;
const FORBIDDEN_REPLAY_HEADER = 'set-cookie';

export const idempotencyConfig = defineConfig(
  'idempotency',
  { ttlSec: 'IDEMPOTENCY_TTL_SEC', keyMinLength: 'IDEMPOTENCY_KEY_MIN_LENGTH', keyMaxLength: 'IDEMPOTENCY_KEY_MAX_LENGTH', replayHeaders: 'IDEMPOTENCY_REPLAY_HEADERS' },
  z.object({
    ttlSec: z.coerce.number().int().positive().default(86400).describe('How long a stored response can be replayed (routes may set a shorter ttl)'),
    keyMinLength: z.coerce.number().int().min(MIN_KEY_LENGTH_FLOOR).default(MIN_KEY_LENGTH_FLOOR).describe('Minimum Idempotency-Key length'),
    keyMaxLength: z.coerce.number().int().positive().default(255).describe('Maximum Idempotency-Key length'),
    replayHeaders: z.string().default('location,etag')
      .transform((s) => s.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
      .refine((hs) => !hs.includes(FORBIDDEN_REPLAY_HEADER), { message: 'IDEMPOTENCY_REPLAY_HEADERS must never include set-cookie' })
      .describe('Response headers stored and replayed with the body (allowlist; set-cookie is forbidden)'),
  }),
);
```
`src/core/http/idempotency.storage.ts`:
```ts
import type { Storage } from '@node-idempotency/storage';
import type { Redis } from 'ioredis';

/** Storage của @node-idempotency trên ioredis dùng chung, key đã có namespace. ttl theo đơn vị đã verify ở Step 1 (d). */
export class RedisIdempotencyStorage implements Storage {
  constructor(private readonly redis: Redis, private readonly prefix: string) {}
  private k(key: string): string { return `${this.prefix}${key}`; }

  async setIfNotExists(key: string, val: string, options?: { ttl?: number }): Promise<boolean> {
    const r = options?.ttl ? await this.redis.set(this.k(key), val, 'PX', options.ttl, 'NX') : await this.redis.set(this.k(key), val, 'NX');
    return r === 'OK';
  }
  async set(key: string, val: string, options?: { ttl?: number }): Promise<void> {
    if (options?.ttl) await this.redis.set(this.k(key), val, 'PX', options.ttl);
    else await this.redis.set(this.k(key), val);
  }
  async get(key: string): Promise<string | undefined> {
    return (await this.redis.get(this.k(key))) ?? undefined;
  }
  async delete(key: string): Promise<boolean> {
    return (await this.redis.del(this.k(key))) > 0;
  }
}
```
Chữ ký phải khớp đúng interface ở Step 1 (d); nếu `ttl` tính bằng giây thì đổi `PX` thành `EX`.

`src/core/http/idempotency.decorator.ts`:
```ts
import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

export const IDEMPOTENT_META = 'core:idempotent';
export type IdempotentOptions = { ttlSec?: number };

/**
 * Bắt buộc Idempotency-Key (IETF draft-ietf-httpapi-idempotency-key-header-07). Route phải có principal đã xác thực.
 * Status của response lấy từ @HttpCode của route, không đổi status động trong handler.
 */
export const Idempotent = (opts: IdempotentOptions = {}) => applyDecorators(SetMetadata(IDEMPOTENT_META, opts), UseInterceptors(IdempotencyInterceptor));
```
`src/core/http/idempotency.interceptor.ts` (khung bằng `pnpm nest g interceptor core/http/idempotency --no-spec --flat`):
```ts
import { createHash } from 'node:crypto';
import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { Idempotency, IdempotencyError, IdempotencyErrorCodes } from '@node-idempotency/core';
import type { Redis } from 'ioredis';
import { Observable, catchError, from, mergeMap, of, throwError } from 'rxjs';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { AppError, CoreErrors, findErrorCode, toAppError } from '../errors/index.js';
import { REDIS, REDIS_NAMESPACE } from '../redis/index.js';
import { IDEMPOTENT_META, type IdempotentOptions } from './idempotency.decorator.js';
import { idempotencyConfig } from './idempotency.config.js';
import { RedisIdempotencyStorage } from './idempotency.storage.js';

const HEADER = 'idempotency-key';
const KEY_CHARSET = /^[A-Za-z0-9_\-:.]+$/;
const SCOPED_KEY_LENGTH = 64;
const MS_PER_SEC = 1000;

const Stored = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), status: z.number().int(), headers: z.record(z.string(), z.string()), body: z.unknown() }),
  z.object({ kind: z.literal('error'), code: z.string(), detail: z.string().optional(), fields: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional() }),
]);
type Stored = z.infer<typeof Stored>;
type HttpReq = { method: string; body: unknown; headers: Record<string, string | undefined> };
type HttpRes = { statusCode: number; getHeader(name: string): unknown };

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private readonly engines = new Map<number, Idempotency>();
  private readonly storage: RedisIdempotencyStorage;

  constructor(
    private readonly reflector: Reflector,
    private readonly adapterHost: HttpAdapterHost,
    private readonly ctx: RequestContext,
    @Inject(REDIS) redis: Redis,
    @Inject(REDIS_NAMESPACE) namespace: string,
    @Inject(idempotencyConfig.KEY) private readonly cfg: ConfigOf<typeof idempotencyConfig>,
  ) {
    this.storage = new RedisIdempotencyStorage(redis, `${namespace}-idem-`);
  }

  private engine(ttlSec: number): Idempotency {
    let e = this.engines.get(ttlSec);
    if (!e) {
      e = new Idempotency(this.storage, { idempotencyKey: HEADER, keyMaxLength: SCOPED_KEY_LENGTH, cacheTTLMS: ttlSec * MS_PER_SEC, enforceIdempotency: true });
      this.engines.set(ttlSec, e);
    }
    return e;
  }

  private routeTemplate(context: ExecutionContext): string {
    const base = this.reflector.get<string | string[]>(PATH_METADATA, context.getClass()) ?? '';
    const path = this.reflector.get<string | string[]>(PATH_METADATA, context.getHandler()) ?? '';
    return `/${[base, path].flat().join('/')}`.replace(/\/+/g, '/');
  }

  /** Scope chỉ lấy từ principal đã xác thực trong RequestContext. Không có fallback theo header. */
  private scopedKey(rawKey: string, method: string, route: string): string {
    const p = this.ctx.principal();
    if (!p) throw new AppError(CoreErrors.UNAUTHENTICATED, { detail: 'Idempotent endpoints require an authenticated caller.' });
    const scope = `${p.type}:${p.id}:${this.ctx.orgId() ?? 'none'}`;
    return createHash('sha256').update(`${scope}|${method}|${route}|${rawKey}`).digest('hex');
  }

  private rawKeyOrThrow(req: HttpReq): string {
    const k = req.headers[HEADER];
    if (!k || k.length < this.cfg.keyMinLength || k.length > this.cfg.keyMaxLength || !KEY_CHARSET.test(k)) {
      throw new AppError(CoreErrors.IDEMPOTENCY_KEY_REQUIRED, {
        detail: `Send an Idempotency-Key header of ${this.cfg.keyMinLength}-${this.cfg.keyMaxLength} characters from [A-Za-z0-9_-:.] (a UUID is recommended).`,
      });
    }
    return k;
  }

  private mapLibraryError(err: unknown): unknown {
    if (!(err instanceof IdempotencyError)) return new AppError(CoreErrors.SERVICE_UNAVAILABLE, { detail: 'Idempotency store is unavailable. Retry later with the same key.', cause: err });
    switch (err.code) {
      case IdempotencyErrorCodes.REQUEST_IN_PROGRESS: return new AppError(CoreErrors.IDEMPOTENCY_CONFLICT, { cause: err });
      case IdempotencyErrorCodes.IDEMPOTENCY_FINGERPRINT_MISSMATCH: return new AppError(CoreErrors.IDEMPOTENCY_KEY_REUSED, { detail: 'This Idempotency-Key was used with a different request. Use a new key.', cause: err });
      case IdempotencyErrorCodes.IDEMPOTENT_KEY_MISSING:
      case IdempotencyErrorCodes.IDEMPOTENCY_KEY_LEN_EXEEDED: return new AppError(CoreErrors.IDEMPOTENCY_KEY_REQUIRED, { cause: err });
      default: {
        this.logger.error({ err }, 'unhandled idempotency error code');
        return new AppError(CoreErrors.INTERNAL_ERROR, { cause: err });
      }
    }
  }

  private replay(stored: Stored, res: unknown): Observable<unknown> {
    if (stored.kind === 'error') {
      const code = findErrorCode(stored.code);
      if (!code) return throwError(() => new Error(`Stored idempotent error has unknown code "${stored.code}"`));
      return throwError(() => new AppError(code, { detail: stored.detail, fields: stored.fields }));
    }
    for (const [k, v] of Object.entries(stored.headers)) this.adapterHost.httpAdapter.setHeader(res, k, v);
    return of(stored.body);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_META, context.getHandler());
    if (!opts) return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<HttpReq>();
    const res = http.getResponse<HttpRes>();
    const rawKey = this.rawKeyOrThrow(req);
    const route = this.routeTemplate(context);
    const libReq = { headers: { [HEADER]: this.scopedKey(rawKey, req.method, route) }, body: req.body, method: req.method, path: route };
    const engine = this.engine(opts.ttlSec ?? this.cfg.ttlSec);

    const save = async (stored: Stored) => {
      try {
        await engine.onResponse(libReq, { body: stored });
      } catch (err) {
        // Handler đã chạy xong; ném lỗi ở đây sẽ khiến client retry và chạy lại side effect.
        this.logger.error({ err, route }, 'failed to store idempotent response; a retry with this key may re-execute');
      }
    };

    return from(engine.onRequest(libReq)).pipe(
      catchError((err: unknown) => throwError(() => this.mapLibraryError(err))),
      mergeMap((hit) => {
        if (hit) {
          const parsed = Stored.safeParse(hit.body);
          if (!parsed.success) return throwError(() => new Error('Stored idempotent response has an unexpected shape'));
          return this.replay(parsed.data, res);
        }
        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            const headers: Record<string, string> = {};
            for (const h of this.cfg.replayHeaders) { const v = res.getHeader(h); if (typeof v === 'string') headers[h] = v; }
            await save({ kind: 'ok', status: res.statusCode, headers, body });
            return body;
          }),
          catchError((err: unknown) => {
            const { error, opts: o } = toAppError(err);
            return from(save({ kind: 'error', code: error.code, detail: error.status < 500 ? o.detail : undefined, fields: o.fields })).pipe(mergeMap(() => throwError(() => err)));
          }),
        );
      }),
    );
  }
}
```
Ghi chú thiết kế (đưa vào ADR 0007):
- Interceptor chạy trước pipe, nên lỗi validate 422 cũng được lưu; client sửa body mà giữ key → `422 idempotency_key_reused` (đúng draft-07, khớp spike).
- Lỗi được lưu dưới dạng **mã lỗi**, không lưu nguyên body problem+json: lúc replay filter dựng lại response với `requestId`/`timestamp` mới. Detail của lỗi 5xx không được lưu (filter vốn không lộ detail 5xx).
- Chỉ lưu header trong allowlist; `Set-Cookie` bị config cấm.
- Redis sập ở bước `onRequest` → `503` (fail-closed), handler không chạy. Lưu kết quả thất bại sau khi handler chạy → log `error`, vẫn trả response.
- Request bị crash giữa chừng để lại trạng thái "đang chạy" tới hết TTL; client phải dùng key mới. Ghi rõ trong ADR.
- Tên hằng `IdempotencyErrorCodes.*` và đường import `PATH_METADATA` phải sửa theo `.d.ts` đã verify ở Step 1 (c). `status` được lưu để phục vụ debug; status khi replay lấy từ `@HttpCode` của route.

`src/core/http/http.module.ts` (bản đầy đủ, thay bản của Task 12):
```ts
import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { type ConfigOf } from '../config/index.js';
import { REDIS, REDIS_NAMESPACE } from '../redis/index.js';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { ContentTypeMiddleware } from './content-type.middleware.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { Paginator } from './pagination.js';
import { RateLimiterThrottlerStorage } from './rate-limiter.storage.js';
import { throttleConfig } from './throttle.config.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [throttleConfig.KEY, REDIS, REDIS_NAMESPACE],
      useFactory: (cfg: ConfigOf<typeof throttleConfig>, redis: Redis, namespace: string) => ({
        throttlers: [{ limit: cfg.limit, ttl: cfg.ttlMs }],
        storage: new RateLimiterThrottlerStorage(redis, namespace),
      }),
    }),
  ],
  providers: [Paginator, ContentTypeMiddleware, IdempotencyInterceptor, { provide: APP_GUARD, useClass: AppThrottlerGuard }],
  exports: [Paginator, IdempotencyInterceptor],
})
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContentTypeMiddleware).forRoutes('*');
  }
}
```
Verify: `ThrottlerModule.forRootAsync` có inject được provider global `REDIS` không; nếu không thì thêm `imports: [RedisModule]` trong option async.

Export thêm từ `src/core/http/index.ts`: `Idempotent`, `SkipRateLimit`, `throttleConfig`, `idempotencyConfig`. Thêm hai config vào `all-configs.ts`. Module chỉ được import `Idempotent`/`SkipRateLimit` từ `core/http`. Luật dependency-cruiser (Task 17): `@nestjs/throttler`, `rate-limiter-flexible`, `@node-idempotency/*` chỉ được import trong `src/core/http/**`.

Run: `pnpm test && pnpm build && pnpm test:int` → PASS.

- [ ] **Step 5: ADR 0007 và commit**

Bổ sung vào `docs/adr/0007-http-conventions.md`:
- Rate limit: `@nestjs/throttler` + `ThrottlerStorage` trên `rate-limiter-flexible` (`RateLimiterRedis` dùng ioredis chung, `insuranceLimiter: RateLimiterMemory` khi Redis sập). Tracker theo principal/org, ẩn danh theo IP (cần `HTTP_TRUST_PROXY` đúng). Health và webhook dùng `SkipRateLimit`. Đã loại: `@nest-lab/throttler-storage-redis` (không còn phát triển, import đường dẫn nội bộ), lớp fail-open tự viết.
- Idempotency: `@node-idempotency/core` (bám draft-07 nhất theo spike ở review mục 0) + interceptor mỏng. Bảng hành vi: thiếu/sai key 400, body khác 422, đang chạy 409 không chờ, lỗi được lưu và trả lại, Redis sập 503. Scope `principal.type:id:orgId` + method + route template; không có principal → 401. Đã loại: `@nestjs-redisx/idempotency` (không bắt buộc key, request trùng phải chờ, không lưu lỗi), AWS Powertools (chạy lại handler khi lỗi), tự viết.
- Chỉ một major `ioredis` trong cây (kết quả `pnpm why ioredis`).
```bash
git add -A
git commit -m "feat(core): redis rate limiting via throttler + rate-limiter-flexible, principal-scoped idempotency via @node-idempotency"
```

---

### Task 14: Cache — hoãn khỏi SP1 (chỉ ghi quyết định)

SP1 không có use case cache nào, và spec quy định "mặc định không cache". Theo quyết định Q1 (review mục 0), task này **không cài package, không viết code**.

- [ ] **Step 1: Ghi ADR**

`docs/adr/0015-cache-deferred.md`:
- Quyết định: SP1 không có `core/cache`. Sub-project đầu tiên có use case cache sẽ dùng `@nestjs/cache-manager` + `cache-manager` + `@keyv/redis` (thêm client `redis`, đã chấp nhận).
- Yêu cầu cho lúc đó: key bắt buộc có org và môi trường, các phần của key được escape; TTL và jitter lấy từ config; Redis cho cache tách instance/DB khỏi queue và idempotency (hai thứ này cần `noeviction`).
- Đã loại: `bentocache` (khi nhận instance ioredis 6 dùng chung thì âm thầm kết nối `127.0.0.1`, không có bản mới từ 02/2026).

```bash
git add docs/adr/0015-cache-deferred.md
git commit -m "docs(adr): defer cache out of sp1"
```

---

### Task 15: `core/resilience` (HTTP client chống SSRF) + `core/security` (FieldCipher)

**Files:**
- Create: `src/core/resilience/{resilience.config.ts,policies.ts,ssrf-guard.ts,http-client.ts,resilience.module.ts,index.ts}`, `src/core/security/{security.config.ts,field-cipher.ts,security.module.ts,index.ts}`
- Modify: `test/support/env.ts` (`baseTestEnv` thêm khoá mã hoá)
- Test: `test/unit/core/resilience/policies.spec.ts`, `test/unit/core/resilience/ssrf-guard.spec.ts`, `test/integration/core/resilience/http-client.spec.ts`, `test/unit/core/security/field-cipher.spec.ts`, `test/unit/core/security/security.config.spec.ts`

**Interfaces:**
- Produces:
  - `buildPolicies(c: PolicyConfig): { retrying: IPolicy; single: IPolicy }` (chung breaker và bulkhead); `ResiliencePolicies.for(provider)`
  - `isPublicAddress(ip: string, allowCidrs: readonly [ipaddr.IPv4 | ipaddr.IPv6, number][]): boolean`; `ssrfLookup(allow)`: hàm `lookup` cho `net.connect`; `assertUrlAllowed(url, cfg)`
  - `HttpClient.request(provider, url, init?: { method?; headers?; body? }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>` — không follow redirect, giới hạn kích thước, chỉ retry method idempotent, ném `UpstreamError`
  - `FieldCipher.encrypt(plain, aad)`, `decrypt(token, aad)`; token `v1.<kid>.<iv>.<ciphertext>.<tag>` (base64url); `aad` = `table:column:orgId:pk`

- [ ] **Step 1: Cài package và verify**

```bash
for p in cockatiel undici ipaddr.js; do pnpm view $p dist-tags peerDependencies; done
pnpm add cockatiel undici ipaddr.js
```
Verify:
- (a) undici: `new Agent({ connect: { lookup } })` có truyền `lookup` xuống `net.connect`/`tls.connect` không (`https://undici.nodejs.org/#/docs/api/Agent`, `Connector`); `request(url, { dispatcher, method, headers, body, signal })` trả `{ statusCode, headers, body }` và **không** follow redirect khi không có interceptor redirect (tương đương `redirect: 'manual'`).
- (b) `net.connect` bỏ qua `lookup` khi host là IP literal → phải kiểm tra IP literal trước khi gọi (đã làm trong `assertUrlAllowed`). Khi Node gọi `lookup` với `{ all: true }` (autoSelectFamily) thì callback nhận mảng địa chỉ.
- (c) ipaddr.js: `ipaddr.process(ip)` chuyển IPv4-mapped IPv6 về IPv4; `range()` trả `'unicast'` cho địa chỉ public; `ipaddr.parseCIDR`; `addr.match(range)`.
- (d) cockatiel: `ExponentialBackoff` có jitter (spec yêu cầu full jitter, dùng option `generator`/`decorrelatedJitterGenerator` nếu có), thứ tự `wrap`, `execute(({ signal }) => …)`.

- [ ] **Step 2: Viết test trước**

`test/unit/core/security/field-cipher.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCipher } from '../../../../src/core/security/index.js';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const AAD = 'users:totp_secret:0199aaaa-0000-7000-8000-000000000001:42';

describe('FieldCipher', () => {
  it('round-trips and produces different ciphertext each time', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const a = c.encrypt('totp-secret', AAD); const b = c.encrypt('totp-secret', AAD);
    expect(a).not.toBe(b);
    expect(c.decrypt(a, AAD)).toBe('totp-secret');
  });
  it('decrypts old ciphertext after key rotation', () => {
    const old = new FieldCipher({ k1 }, 'k1').encrypt('x', AAD);
    const rotated = new FieldCipher({ k1, k2 }, 'k2');
    expect(rotated.decrypt(old, AAD)).toBe('x');
    expect(rotated.encrypt('y', AAD).split('.')[1]).toBe('k2');
  });
  it('rejects ciphertext moved to another row/column/org (AAD mismatch)', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const t = c.encrypt('x', AAD);
    expect(() => c.decrypt(t, 'users:totp_secret:0199aaaa-0000-7000-8000-000000000001:43')).toThrow();
  });
  it('detects tampering and truncated tags', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const t = c.encrypt('x', AAD).split('.');
    expect(() => c.decrypt([...t.slice(0, 3), Buffer.from('evil').toString('base64url'), t[4]].join('.'), AAD)).toThrow();
    expect(() => c.decrypt([...t.slice(0, 4), t[4]!.slice(0, 8)].join('.'), AAD)).toThrow();
  });
  it('rejects unknown key id and wrong key length', () => {
    expect(() => new FieldCipher({ k1: Buffer.alloc(16).toString('base64') }, 'k1')).toThrow(/32 bytes/);
    expect(() => new FieldCipher({ k1 }, 'k9')).toThrow(/active key/);
    expect(() => new FieldCipher({ k1 }, 'k1').decrypt('v1.k9.a.b.c', AAD)).toThrow(/unknown key/);
  });
});
```
`test/unit/core/security/security.config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { securityConfig } from '../../../../src/core/security/index.js';

describe('securityConfig', () => {
  it('invalid JSON fails without echoing the secret value', () => {
    const secret = 'super-secret-material';
    const r = securityConfig.schema.safeParse({ keys: `{"k1":"${secret}"`, activeKid: 'k1' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).not.toContain(secret);
  });
});
```
`test/unit/core/resilience/ssrf-guard.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isPublicAddress } from '../../../../src/core/resilience/index.js';

const cfg = { allowedPorts: [80, 443], allowCidrs: [] };

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254'])(
    'denies %s', (ip) => { expect(isPublicAddress(ip, [])).toBe(false); });
  it('allows public unicast addresses', () => {
    expect(isPublicAddress('93.184.216.34', [])).toBe(true);
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946', [])).toBe(true);
  });
  it.each(['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data', 'http://0x7f000001/', 'http://2130706433/'])(
    'rejects literal/encoded internal host %s before connecting', (url) => {
      expect(() => assertUrlAllowed(new URL(url), cfg)).toThrow(/not allowed/);
    });
  it('rejects non-http schemes and ports outside the allowlist', () => {
    expect(() => assertUrlAllowed(new URL('file:///etc/passwd'), cfg)).toThrow(/scheme/);
    expect(() => assertUrlAllowed(new URL('http://example.com:6379/'), cfg)).toThrow(/port/);
  });
});
```
(WHATWG `URL` chuẩn hoá `0x7f000001` và `2130706433` thành `127.0.0.1`, nên hai dạng này bị bắt ở nhánh IP literal.)

`test/integration/core/resilience/http-client.spec.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { HttpClient, ResilienceModule, UpstreamError } from '../../../../src/core/resilience/index.js';
import { createTestApp } from '../../../support/app-factory.js';

let hits = 0;
let server: Server;
let port = 0;
const PROVIDER = 'fixture';

async function client(env: Record<string, string>): Promise<INestApplication> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return createTestApp([ResilienceModule]);
}

describe('HttpClient (SSRF-safe)', () => {
  let open: INestApplication; let strict: INestApplication;
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
      if (req.url === '/big') { res.writeHead(200); res.end(Buffer.alloc(4096)); return; }
      if (req.url === '/flaky') { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    strict = await client({ RESILIENCE_ALLOWED_PORTS: String(port), RESILIENCE_SSRF_ALLOW_CIDRS: '' });
    vi.unstubAllEnvs();
    open = await client({ RESILIENCE_ALLOWED_PORTS: String(port), RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32', RESILIENCE_MAX_RESPONSE_BYTES: '1024', RESILIENCE_DEFAULT_RETRIES: '2', RESILIENCE_DEFAULT_RETRY_BASE_MS: '1' });
  });
  afterAll(async () => { await open.close(); await strict.close(); await new Promise((r) => server.close(r)); vi.unstubAllEnvs(); });

  it('DNS name resolving to a private IP is blocked at connect time; server never hit', async () => {
    const before = hits;
    await expect(strict.get(HttpClient).request(PROVIDER, `http://localhost:${port}/`)).rejects.toThrow(/not allowed/);
    expect(hits).toBe(before);
  });
  it('allowlisted CIDR works and returns the body', async () => {
    const res = await open.get(HttpClient).request(PROVIDER, `http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true });
  });
  it('redirects are never followed', async () => {
    const res = await open.get(HttpClient).request(PROVIDER, `http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(302);
  });
  it('response larger than the cap fails with UpstreamError', async () => {
    await expect(open.get(HttpClient).request(PROVIDER, `http://127.0.0.1:${port}/big`)).rejects.toBeInstanceOf(UpstreamError);
  });
  it('retries idempotent methods only', async () => {
    let before = hits;
    await expect(open.get(HttpClient).request(PROVIDER, `http://127.0.0.1:${port}/flaky`, { method: 'GET' })).rejects.toBeInstanceOf(UpstreamError);
    expect(hits - before).toBe(3);
    before = hits;
    await expect(open.get(HttpClient).request(PROVIDER, `http://127.0.0.1:${port}/flaky`, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(UpstreamError);
    expect(hits - before).toBe(1);
  });
});
```
Hai test "flaky" dùng chung breaker của provider; `RESILIENCE_DEFAULT_BREAKER_THRESHOLD` mặc định (5) lớn hơn tổng số lỗi (4) nên breaker chưa mở. Nếu đổi mặc định thì stub env cho test này.

`test/unit/core/resilience/policies.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { buildPolicies } from '../../../../src/core/resilience/index.js';

const cfg = { timeoutMs: 100, retries: 2, retryBaseMs: 1, breakerThreshold: 3, breakerHalfOpenMs: 50, bulkheadLimit: 2, bulkheadQueue: 0 };

describe('resilience policies', () => {
  it('retrying policy retries transient failures then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('ok');
    expect(await buildPolicies(cfg).retrying.execute(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('single policy never retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(buildPolicies(cfg).single.execute(fn)).rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('times out slow calls', async () => {
    const p = buildPolicies({ ...cfg, retries: 0 }).single;
    await expect(p.execute(({ signal }) => new Promise((r, j) => { const t = setTimeout(r, 1000); signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); }))).rejects.toThrow();
  });
  it('both variants share one breaker', async () => {
    const { retrying, single } = buildPolicies({ ...cfg, retries: 0 });
    const fail = () => Promise.reject(new Error('down'));
    for (let i = 0; i < 3; i++) await expect(single.execute(fail)).rejects.toThrow('down');
    await expect(retrying.execute(() => Promise.resolve('x'))).rejects.toThrow(/open|broken/i);
  });
});
```
Run: `pnpm test && pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 3: Cài đặt `core/security`**

`src/core/security/field-cipher.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/** AES-256-GCM theo field, có key id để xoay khoá. `aad` gắn ciphertext vào đúng table:column:orgId:pk. */
export class FieldCipher {
  private readonly keys: Map<string, Buffer>;
  constructor(keys: Record<string, string>, private readonly activeKid: string) {
    this.keys = new Map(Object.entries(keys).map(([kid, b64]) => {
      const key = Buffer.from(b64, 'base64');
      if (key.length !== KEY_BYTES) throw new Error(`Encryption key "${kid}" must be 32 bytes`);
      return [kid, key];
    }));
    if (!this.keys.has(activeKid)) throw new Error(`Encryption active key "${activeKid}" is not in the keyring`);
  }

  private aadOf(kid: string, aad: string): Buffer {
    return Buffer.from(`${VERSION}.${kid}.${aad}`);
  }

  encrypt(plain: string, aad: string): string {
    const key = this.keys.get(this.activeKid);
    if (!key) throw new Error(`Encryption active key "${this.activeKid}" is not in the keyring`);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(this.aadOf(this.activeKid, aad));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, this.activeKid, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  decrypt(token: string, aad: string): string {
    const [version, kid, iv, ct, tag] = token.split('.');
    if (version !== VERSION || !kid || !iv || ct === undefined || !tag) throw new Error('Malformed encrypted value');
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Encrypted value uses unknown key "${kid}"`);
    const tagBuf = Buffer.from(tag, 'base64url');
    if (tagBuf.length !== TAG_BYTES) throw new Error('Malformed encrypted value');
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES });
    decipher.setAAD(this.aadOf(kid, aad));
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
```
`src/core/security/security.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const Keyring = z.record(z.string().regex(/^[a-z0-9]{1,16}$/), z.string().min(1));

/** Parse JSON mà không bao giờ đưa giá trị (là secret) vào thông báo lỗi. */
const keyringFromJson = z.string().transform((raw, ctx) => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'FIELD_ENCRYPTION_KEYS must be a JSON object {"<kid>":"<base64 32-byte key>"}' });
    return z.NEVER;
  }
}).pipe(Keyring);

export const securityConfig = defineConfig(
  'security',
  { keys: 'FIELD_ENCRYPTION_KEYS', activeKid: 'FIELD_ENCRYPTION_ACTIVE_KID' },
  z.object({
    keys: keyringFromJson.describe('Field encryption keyring as JSON {"<kid>":"<base64 32-byte key>"} (secret, required)'),
    activeKid: z.string().min(1).describe('Key id used for new encryptions (required)'),
  }),
);
```
Verify: lỗi của `Keyring` (bước `pipe`) trong zod 4 có chèn giá trị input vào message không; nếu có thì dùng `error` tuỳ chỉnh cho `Keyring` để message không chứa giá trị. Bộ ghi lỗi của `parseConfig` (Task 3) chỉ in `path` + `message`, không in input.

`SecurityModule` (global, khung bằng `pnpm nest g module core/security --no-spec`) cung cấp `FieldCipher` bằng factory `new FieldCipher(cfg.keys, cfg.activeKid)`. `.env.example` sẽ đánh dấu hai biến `(required)`. Thêm vào `baseTestEnv()`: `FIELD_ENCRYPTION_KEYS: JSON.stringify({ t1: randomBytes(32).toString('base64') })`, `FIELD_ENCRYPTION_ACTIVE_KID: 't1'`. `ALGO`, `IV_BYTES`, `KEY_BYTES`, `TAG_BYTES`, `VERSION` là hằng số thuật toán, không phải giá trị tuỳ chỉnh. Đây là mã hoá theo field với keyring trong env, **không phải** envelope encryption qua KMS (spec đã sửa chữ); chuyển sang KMS là việc của sub-project sau.

- [ ] **Step 4: Cài đặt `core/resilience`**

`src/core/resilience/resilience.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const PolicyOverride = z.object({
  timeoutMs: z.number().int().positive(), retries: z.number().int().min(0), retryBaseMs: z.number().int().positive(),
  breakerThreshold: z.number().int().positive(), breakerHalfOpenMs: z.number().int().positive(), bulkheadLimit: z.number().int().positive(), bulkheadQueue: z.number().int().min(0),
}).partial().strict();
const overridesFromJson = z.string().transform((raw, ctx) => {
  try { const v: unknown = JSON.parse(raw); return v; } catch { ctx.addIssue({ code: 'custom', message: 'RESILIENCE_OVERRIDES must be a JSON object' }); return z.NEVER; }
}).pipe(z.record(z.string(), PolicyOverride));

export const resilienceConfig = defineConfig(
  'resilience',
  {
    timeoutMs: 'RESILIENCE_DEFAULT_TIMEOUT_MS', retries: 'RESILIENCE_DEFAULT_RETRIES', retryBaseMs: 'RESILIENCE_DEFAULT_RETRY_BASE_MS',
    breakerThreshold: 'RESILIENCE_DEFAULT_BREAKER_THRESHOLD', breakerHalfOpenMs: 'RESILIENCE_DEFAULT_BREAKER_HALF_OPEN_MS',
    bulkheadLimit: 'RESILIENCE_DEFAULT_BULKHEAD_LIMIT', bulkheadQueue: 'RESILIENCE_DEFAULT_BULKHEAD_QUEUE', overrides: 'RESILIENCE_OVERRIDES',
    allowedPorts: 'RESILIENCE_ALLOWED_PORTS', allowCidrs: 'RESILIENCE_SSRF_ALLOW_CIDRS', maxResponseBytes: 'RESILIENCE_MAX_RESPONSE_BYTES',
  },
  z.object({
    timeoutMs: z.coerce.number().int().positive().default(10000).describe('Per-attempt timeout for outbound calls'),
    retries: z.coerce.number().int().min(0).default(2).describe('Retries for idempotent outbound calls'),
    retryBaseMs: z.coerce.number().int().positive().default(200).describe('Base delay for exponential backoff with jitter'),
    breakerThreshold: z.coerce.number().int().positive().default(5).describe('Consecutive failures that open the circuit'),
    breakerHalfOpenMs: z.coerce.number().int().positive().default(30000).describe('Time before a half-open probe'),
    bulkheadLimit: z.coerce.number().int().positive().default(20).describe('Max concurrent calls per provider'),
    bulkheadQueue: z.coerce.number().int().min(0).default(100).describe('Max queued calls per provider'),
    overrides: overridesFromJson.default({}).describe('Per-provider overrides as JSON {"<provider>":{...}}'),
    allowedPorts: z.string().default('80,443').transform((s) => csv(s).map(Number)).pipe(z.array(z.number().int().min(1).max(65535)).min(1)).describe('Destination ports outbound HTTP may use'),
    allowCidrs: z.string().default('').transform(csv).describe('CIDRs exempt from the private-address block (empty in production unless an internal provider is required)'),
    maxResponseBytes: z.coerce.number().int().positive().default(10485760).describe('Max outbound response body size'),
  }),
);
```
Với `overrides.default({})`: schema nhận chuỗi, nên default phải là chuỗi `'{}'` nếu zod 4 áp default **trước** transform; kiểm tra bằng test `validateAllConfigs` hiện có và sửa cho đúng.

`src/core/resilience/ssrf-guard.ts`:
```ts
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import ipaddr from 'ipaddr.js';

export type SsrfConfig = { allowedPorts: readonly number[]; allowCidrs: readonly string[] };
type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];
const PUBLIC_RANGE = 'unicast';
const SCHEMES = new Set(['http:', 'https:']);
const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 };

export class SsrfBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'SsrfBlockedError'; }
}

export const parseCidrs = (cidrs: readonly string[]): Cidr[] => cidrs.map((c) => ipaddr.parseCIDR(c));

/** Chỉ địa chỉ unicast công khai (sau khi bỏ lớp IPv4-mapped) hoặc nằm trong allowlist. */
export function isPublicAddress(ip: string, allow: readonly Cidr[]): boolean {
  if (!ipaddr.isValid(ip)) return false;
  const addr = ipaddr.process(ip);
  if (allow.some(([range, bits]) => addr.kind() === range.kind() && addr.match(range, bits))) return true;
  return addr.range() === PUBLIC_RANGE;
}

export function assertUrlAllowed(url: URL, cfg: SsrfConfig): void {
  if (!SCHEMES.has(url.protocol)) throw new SsrfBlockedError(`URL scheme ${url.protocol} is not allowed`);
  const port = url.port ? Number(url.port) : DEFAULT_PORT[url.protocol];
  if (port === undefined || !cfg.allowedPorts.includes(port)) throw new SsrfBlockedError(`Destination port ${url.port} is not allowed`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // net.connect không gọi lookup cho IP literal, nên kiểm tra ở đây.
  if (ipaddr.isValid(host) && !isPublicAddress(host, parseCidrs(cfg.allowCidrs))) throw new SsrfBlockedError(`Destination ${host} is not allowed`);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** lookup cho net.connect: resolve DNS rồi chặn nếu **bất kỳ** địa chỉ nào không công khai (chống DNS rebinding). */
export function ssrfLookup(allowCidrs: readonly string[]) {
  const allow = parseCidrs(allowCidrs);
  return (hostname: string, options: LookupOptions, callback: LookupCb): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const blocked = addresses.find((a) => !isPublicAddress(a.address, allow));
      if (blocked) return callback(new SsrfBlockedError(`Destination ${hostname} (${blocked.address}) is not allowed`), []);
      if (options.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(new SsrfBlockedError(`Destination ${hostname} did not resolve`), []);
      callback(null, first.address, first.family);
    });
  };
}
```
`src/core/resilience/policies.ts`:
```ts
import { ConsecutiveBreaker, ExponentialBackoff, TimeoutStrategy, bulkhead, circuitBreaker, handleWhen, retry, timeout, wrap, type IPolicy } from 'cockatiel';
import { SsrfBlockedError } from './ssrf-guard.js';

/** Bị chặn SSRF là quyết định chính sách, không phải lỗi tạm thời: không retry, không tính vào breaker. */
const isTransient = (e: unknown): boolean => !(e instanceof SsrfBlockedError) && !(e instanceof Error && e.cause instanceof SsrfBlockedError);

export type PolicyConfig = { timeoutMs: number; retries: number; retryBaseMs: number; breakerThreshold: number; breakerHalfOpenMs: number; bulkheadLimit: number; bulkheadQueue: number };

/** Hai biến thể dùng chung breaker và bulkhead: `retrying` cho method idempotent, `single` cho phần còn lại. */
export function buildPolicies(c: PolicyConfig): { retrying: IPolicy; single: IPolicy } {
  const breakerP = circuitBreaker(handleWhen(isTransient), { halfOpenAfter: c.breakerHalfOpenMs, breaker: new ConsecutiveBreaker(c.breakerThreshold) });
  const bulkheadP = bulkhead(c.bulkheadLimit, c.bulkheadQueue);
  const timeoutP = timeout(c.timeoutMs, TimeoutStrategy.Aggressive);
  const retryP = retry(handleWhen(isTransient), { maxAttempts: c.retries, backoff: new ExponentialBackoff({ initialDelay: c.retryBaseMs }) });
  return { retrying: wrap(bulkheadP, retryP, breakerP, timeoutP), single: wrap(bulkheadP, breakerP, timeoutP) };
}
```
`ResiliencePolicies` (`@Injectable`): `for(provider)` gộp default với `overrides[provider]`, cache kết quả `buildPolicies` theo tên để breaker giữ trạng thái.

`src/core/resilience/http-client.ts`:
```ts
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Agent, request } from 'undici';
import { type ConfigOf } from '../config/index.js';
import { resilienceConfig } from './resilience.config.js';
import { ResiliencePolicies } from './policies.service.js';
import { SsrfBlockedError, assertUrlAllowed, ssrfLookup } from './ssrf-guard.js';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const RETRYABLE_STATUS = (s: number) => s >= 500 || s === 429;

export class UpstreamError extends Error {
  constructor(readonly provider: string, readonly status: number | undefined, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamError';
  }
}

export type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

@Injectable()
export class HttpClient implements OnApplicationShutdown {
  private readonly agent: Agent;
  constructor(private readonly policies: ResiliencePolicies, @Inject(resilienceConfig.KEY) private readonly cfg: ConfigOf<typeof resilienceConfig>) {
    this.agent = new Agent({ connect: { lookup: ssrfLookup(cfg.allowCidrs) } });
  }

  async request(provider: string, rawUrl: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<HttpResult> {
    const url = new URL(rawUrl);
    assertUrlAllowed(url, this.cfg);
    const method = (init.method ?? 'GET').toUpperCase();
    const p = this.policies.for(provider);
    const policy = IDEMPOTENT_METHODS.has(method) ? p.retrying : p.single;
    try {
      return await policy.execute(async ({ signal }) => {
        const res = await request(url, { dispatcher: this.agent, method, headers: init.headers, body: init.body, signal });
        const body = await this.readCapped(provider, res.body);
        if (RETRYABLE_STATUS(res.statusCode)) throw new UpstreamError(provider, res.statusCode, `Upstream ${provider} responded ${res.statusCode}`);
        return { status: res.statusCode, headers: res.headers, body };
      });
    } catch (err) {
      if (err instanceof UpstreamError || err instanceof SsrfBlockedError) throw err;
      const blocked = err instanceof Error && err.cause instanceof SsrfBlockedError ? err.cause : undefined;
      if (blocked) throw blocked;
      throw new UpstreamError(provider, undefined, `Upstream ${provider} call failed`, { cause: err });
    }
  }

  private async readCapped(provider: string, body: AsyncIterable<Buffer> & { destroy(): void }): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > this.cfg.maxResponseBytes) {
        body.destroy();
        throw new UpstreamError(provider, undefined, `Upstream ${provider} response exceeded ${this.cfg.maxResponseBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.agent.close();
  }
}
```
Lỗi `SsrfBlockedError` ném từ `lookup` đi qua undici có thể bị bọc (`err.cause`) hoặc giữ nguyên — code ở trên xử lý cả hai; verify bằng test "DNS name resolving to a private IP". `assertUrlAllowed` chạy trước policy; `SsrfBlockedError` từ `lookup` nằm trong policy nhưng `isTransient` loại nó khỏi retry và breaker. `ResiliencePolicies` nằm ở `policies.service.ts` (khung bằng `pnpm nest g service core/resilience/policies --no-spec --flat`). Không gọi `HttpClient` bên trong transaction DB (spec §I/O).

`ResilienceModule` (global) cung cấp `ResiliencePolicies`, `HttpClient`. `index.ts` export `ResilienceModule`, `HttpClient`, `UpstreamError`, `SsrfBlockedError`, `buildPolicies`, `isPublicAddress`, `assertUrlAllowed`, `resilienceConfig`. Luật dependency-cruiser (Task 17): `undici`, `ipaddr.js`, `cockatiel` chỉ trong `src/core/resilience/**`. Thêm hai config vào `all-configs.ts`.

Run: `pnpm test && pnpm build && pnpm test:int` → PASS.

- [ ] **Step 5: ADR 0016 và commit**

`docs/adr/0016-outbound-http-ssrf.md`: undici `Agent` + `connect.lookup` + ipaddr.js (chặn sau khi resolve DNS; IP literal kiểm tra trước), không follow redirect, allowlist port, giới hạn kích thước, chỉ retry method idempotent. Đã loại: `request-filtering-agent` (chỉ gắn vào `http.Agent`, `fetch` của Node bỏ qua; có lỗ hổng HIGH làm crash process), dùng global `fetch` với `dispatcher` (lệch version undici tích hợp trong Node).
```bash
git add -A
git commit -m "feat(core): ssrf-safe resilient http client, aad-bound field encryption"
```

---

### Task 16: Observability — OpenTelemetry, trace xuyên outbox và job, metrics, flush khi tắt

**Files:**
- Create: `src/instrumentation.ts`, `src/shutdown.ts`, `src/core/observability/{otel.config.ts,telemetry-lifecycle.ts,trace-propagation.ts,metrics.ts,observability.module.ts,index.ts}`
- Modify: `src/core/context/context.module.ts` (set `traceId`/`traceparent`), `src/core/queue/{bullmq-job-queue.ts,worker-host.ts}`, `src/core/events/event-publisher.ts`, `src/core/outbox/outbox.relay.ts`, `src/main.api.ts`, `src/main.worker.ts`, `src/app-worker.module.ts`, `package.json` (scripts)
- Test: `test/integration/core/observability/trace.spec.ts`, `test/unit/core/observability/otel.config.spec.ts`

**Interfaces:**
- Produces:
  - `currentTraceparent(): string | undefined`, `withRemoteParent<T>(traceparent, name, fn): Promise<T>`
  - `startTelemetry(cfg): void`, `shutdownTelemetry(): Promise<void>` (no-op khi chưa start)
  - `installShutdown(app: { close(): Promise<void> }): void` — SIGTERM/SIGINT → `app.close()` → `shutdownTelemetry()` → `process.exit(0)` (lỗi → log + exit 1)
  - Metrics: `outbox_lag_seconds` (gauge), `queue_depth{queue}`, `queue_oldest_job_age_seconds{queue}`, `queue_failed_total{queue}`; HTTP/pg/ioredis tự instrument

- [ ] **Step 1: Cài package (dependency production) và verify**

```bash
for p in @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/sdk-metrics @opentelemetry/sdk-trace-base @opentelemetry/instrumentation bullmq-otel; do pnpm view $p dist-tags peerDependencies; done
pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/sdk-metrics @opentelemetry/sdk-trace-base @opentelemetry/instrumentation bullmq-otel
pnpm add -D @opentelemetry/sdk-trace-node @opentelemetry/context-async-hooks @opentelemetry/core
```
Mọi package mà `src/` import đều là dependency production (không bị `pnpm prune --prod` xoá khỏi image). Ba package `-D` chỉ dùng trong test. Nếu `sdk-node` đã re-export `sdk-metrics`/`sdk-trace-base` (`import { metrics, tracing } from '@opentelemetry/sdk-node'`) thì dùng re-export và bỏ hai package đó khỏi lệnh cài.

Verify:
- (a) ESM: hook loader cho auto-instrumentation (`@opentelemetry/instrumentation/hook.mjs` qua `module.register`, hoặc flag `--experimental-loader`) theo `https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md`;
- (b) cách gắn `bullmq-otel` (option `telemetry` của `Queue`/`Worker`);
- (c) `propagation.inject/extract` với `W3CTraceContextPropagator`;
- (d) `ParentBasedSampler` option `remoteParentSampled`/`remoteParentNotSampled`.

- [ ] **Step 2: Viết test trước**

`test/unit/core/observability/otel.config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { otelConfig } from '../../../../src/core/observability/index.js';

describe('otelConfig', () => {
  it('does not depend on APP_ROLE or appConfig', () => {
    expect(otelConfig.schema.parse({ enabled: 'false' })).toMatchObject({ enabled: false });
  });
  it('requires an endpoint when enabled', () => {
    expect(() => otelConfig.schema.parse({ enabled: 'true' })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });
});
```
`test/integration/core/observability/trace.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { currentTraceparent, withRemoteParent } from '../../../../src/core/observability/index.js';

const exporter = new InMemorySpanExporter();
describe('trace propagation', () => {
  beforeAll(() => {
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register({ contextManager: new AsyncLocalStorageContextManager().enable(), propagator: new W3CTraceContextPropagator() });
  });
  afterAll(() => { propagation.disable(); context.disable(); trace.disable(); });

  it('continues the same trace across an async boundary', async () => {
    const tracer = trace.getTracer('test');
    let parentTraceId = ''; let carried: string | undefined;
    await tracer.startActiveSpan('http request', async (span) => { parentTraceId = span.spanContext().traceId; carried = currentTraceparent(); span.end(); });
    expect(carried).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    await withRemoteParent(carried, 'job process', async () => {});
    const job = exporter.getFinishedSpans().find((s) => s.name === 'job process');
    expect(job?.spanContext().traceId).toBe(parentTraceId);
  });

  it('starts a new root when no traceparent is carried', async () => {
    await withRemoteParent(undefined, 'orphan job', async () => {});
    expect(exporter.getFinishedSpans().some((s) => s.name === 'orphan job')).toBe(true);
  });

  it('records the error and rethrows', async () => {
    await expect(withRemoteParent(undefined, 'failing job', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(exporter.getFinishedSpans().find((s) => s.name === 'failing job')?.status.code).toBe(2);
  });
});
```
Run: `pnpm test && pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 3: Cài đặt**

`src/core/observability/otel.config.ts` — **không** đọc `appConfig`, vì `instrumentation.ts` chạy trước khi entrypoint set `APP_ROLE`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const otelConfig = defineConfig(
  'otel',
  { enabled: 'OTEL_ENABLED', endpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT', serviceName: 'OTEL_SERVICE_NAME', sampleRatio: 'OTEL_TRACES_SAMPLE_RATIO', metricsIntervalMs: 'OTEL_METRICS_INTERVAL_MS' },
  z.object({
    enabled: z.stringbool().default(false).describe('Enable OpenTelemetry export'),
    endpoint: z.url().optional().describe('OTLP HTTP endpoint base URL (required when enabled)'),
    serviceName: z.string().min(1).default('backend-demo').describe('service.name resource attribute'),
    sampleRatio: z.coerce.number().min(0).max(1).default(0.1).describe('Head sampling ratio for new traces and for remote parents sent by clients'),
    metricsIntervalMs: z.coerce.number().int().positive().default(15000).describe('Metric export interval'),
  }).refine((c) => !c.enabled || c.endpoint, { message: 'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true', path: ['endpoint'] }),
);
```
(Nếu `.refine` làm mất kiểu `ZodObject` thì xử lý giống `httpConfig` ở Task 12.)

`src/core/observability/telemetry-lifecycle.ts`:
```ts
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import type { ConfigOf } from '../config/index.js';
import type { otelConfig } from './otel.config.js';

let sdk: NodeSDK | undefined;

export function startTelemetry(cfg: ConfigOf<typeof otelConfig>): void {
  if (!cfg.enabled || sdk) return;
  if (!cfg.endpoint) throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true');
  const ratio = new TraceIdRatioBasedSampler(cfg.sampleRatio);
  sdk = new NodeSDK({
    serviceName: cfg.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${cfg.endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${cfg.endpoint}/v1/metrics` }), exportIntervalMillis: cfg.metricsIntervalMs }),
    // traceparent từ client không được ép lấy mẫu 100%: parent từ xa được lấy mẫu lại theo ratio.
    sampler: new ParentBasedSampler({ root: ratio, remoteParentSampled: ratio, remoteParentNotSampled: ratio }),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
}

/** Gọi **sau** `app.close()` để span/metric của giai đoạn tắt cũng được gửi đi. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  const s = sdk;
  sdk = undefined;
  await s.shutdown();
}
```
`src/instrumentation.ts` (nạp bằng `--import`, không đăng ký signal handler — việc tắt do `installShutdown` điều phối):
```ts
import { otelConfig } from './core/observability/otel.config.js';
import { startTelemetry } from './core/observability/telemetry-lifecycle.js';

startTelemetry(otelConfig());
```
Nếu Step 1 (a) yêu cầu đăng ký hook ESM bằng code thì thêm vào đầu file đúng lệnh `register(...)` theo tài liệu.

`src/shutdown.ts`:
```ts
import { shutdownTelemetry } from './core/observability/telemetry-lifecycle.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Tắt êm: đóng app (Nest chạy hook theo thứ tự: draining → đóng HTTP → worker/relay/pool), rồi flush telemetry, rồi thoát. */
export function installShutdown(app: { close(): Promise<void> }): void {
  let closing = false;
  const onSignal = (signal: string) => {
    if (closing) return;
    closing = true;
    app.close()
      .then(shutdownTelemetry)
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`shutdown after ${signal} failed: ${err instanceof Error ? err.stack : String(err)}\n`);
        process.exit(1);
      });
  };
  for (const s of SIGNALS) process.once(s, () => onSignal(s));
}
```
Trong `main.api.ts` và `main.worker.ts`, thay `process.once('SIGTERM', …)` bằng `.then(installShutdown)`.

`src/core/observability/trace-propagation.ts`:
```ts
import { SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';

const TRACER = 'core';

export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

export async function withRemoteParent<T>(traceparent: string | undefined, name: string, fn: () => Promise<T>): Promise<T> {
  const parent = traceparent ? propagation.extract(context.active(), { traceparent }) : context.active();
  return trace.getTracer(TRACER).startActiveSpan(name, {}, parent, async (span) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
```
Nối vào các chỗ:
- `ContextModule` middleware `setup`: `cls.set(CTX.traceId, trace.getActiveSpan()?.spanContext().traceId)` và `cls.set(CTX.traceparent, currentTraceparent())`. `traceparent` do client gửi chỉ đi vào context qua propagator của OTel (đã lấy mẫu lại ở trên), không được copy thẳng.
- `BullmqJobQueue.enqueue/enqueueDynamic/enqueueMany`: `meta.traceparent ??= currentTraceparent()`.
- `EventPublisher`: `headers.traceparent = currentTraceparent()`.
- `OutboxRelay`: khi enqueue job dispatch, `meta.traceparent` lấy từ `headers.traceparent` của dòng outbox (trace đi xuyên outbox).
- `WorkerHost.process`: bọc lời gọi handler bằng `withRemoteParent(decoded.meta.traceparent, \`job ${job.name}\`, …)` **bên trong** `RequestContext.run` (và `OrgScope.run` khi có `meta.orgId`), rồi set `traceId` vào context.

`src/core/observability/metrics.ts` (`@Injectable`, chỉ đăng ký trong worker qua `ObservabilityModule.forRoot({ worker: true })`):
- `metrics.getMeter('core')`.
- Observable gauge `outbox_lag_seconds`: callback chạy `RelayDb.execute('SELECT COALESCE(extract(epoch FROM now() - min(occurred_at)), 0)::float8 AS lag FROM outbox_events WHERE published_at IS NULL')` (connection `relay`, không dùng admin EM, không import MikroORM).
- `queue_depth{queue}`, `queue_oldest_job_age_seconds{queue}`: qua một method mới `JobQueue.stats(): Promise<{ queue: string; waiting: number; oldestWaitingAgeMs: number | null }[]>` cài trong `BullmqJobQueue` (`getJobCounts()` + `getJobs(['waiting'], 0, 0, true)`; verify API BullMQ 6). `core/observability` không import `bullmq`.
- Counter `queue_failed_total{queue}`: `WorkerHost` gọi `QueueMetrics.failed(queue)` trong `worker.on('failed')`.
- Callback lỗi → log `warn` và bỏ qua lần đo đó (không làm crash process). Không dùng `orgId` hay id nào làm attribute.

Thêm `otelConfig` vào `all-configs.ts`. `package.json`:
```json
"start:api": "node --import ./dist/instrumentation.js dist/main.api.js",
"start:worker": "node --import ./dist/instrumentation.js dist/main.worker.js"
```
Nếu Step 1 (a) cần thêm flag loader thì thêm đúng flag đó vào cả hai script và vào `CMD` của Dockerfile (Task 19).

Run: `pnpm test && pnpm build && pnpm test:int` → PASS. Chạy tay: `OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm start:api` (collector cục bộ ở Task 19), gọi một request, thấy span `GET` và `pg` trong log `debug` của collector; `kill -TERM` process và thấy span cuối vẫn được export.

- [ ] **Step 4: ADR 0014 và commit**

`docs/adr/0014-observability.md`: OTLP; config OTel độc lập với `APP_ROLE`; head sampling 10%, parent từ client bị lấy mẫu lại; "giữ 100% trace lỗi" làm bằng tail sampling ở collector; flush sau `app.close()`; không gắn attribute có quá nhiều giá trị.
```bash
git add -A
git commit -m "feat(core): opentelemetry across http, outbox and jobs; queue and outbox metrics; ordered shutdown with telemetry flush"
```

---

### Task 17: Luật kiến trúc + quét hard code

**Files:**
- Create (bằng CLI): `.dependency-cruiser.cjs` (`depcruise --init`), sau đó sửa
- Create: `test/architecture/fixtures/*` (file vi phạm có chủ đích, không nằm trong `src`), `test/unit/architecture/rules.spec.ts`, `test/unit/architecture/hardcode-scan.spec.ts`

**Interfaces:**
- Produces: script `pnpm arch` (fail khi có vi phạm), test chứng minh mỗi luật bắt được vi phạm

- [ ] **Step 1: Cài và khởi tạo bằng CLI**

```bash
pnpm view dependency-cruiser dist-tags && pnpm add -D dependency-cruiser
pnpm depcruise --init
```
Trả lời prompt để phân tích TypeScript (`tsconfig` dùng TS 6 qua alias `typescript`). Script: `"arch": "depcruise src --config .dependency-cruiser.cjs"`.

- [ ] **Step 2: Viết test trước (fixture vi phạm)**

Tạo cây fixture mô phỏng cấu trúc thật trong `test/architecture/fixtures/src/`:
```
core/queue/ok.ts                        import 'bullmq' (hợp lệ)
core/http/uses-orm.ts                   import '@mikro-orm/core'            → orm-only-in-infra
modules/billing/domain/bad.ts           import '../infra/repo.js'           → domain-pure
modules/billing/infra/repo.ts           import '@mikro-orm/core' (hợp lệ)
modules/billing/index.ts
modules/tenancy/deep.ts                 import '../billing/domain/bad.js'   → modules-only-index-of-other-modules
core/bad-core.ts                        import '../modules/billing/index.js' → core-independent
features/x/leak.ts                      import '../../modules/billing/infra/repo.js' → features-only-public-api
features/x/uses-bullmq.ts               import 'bullmq'                     → bullmq-only-in-core-queue
modules/billing/http/uses-throttler.ts  import '@nestjs/throttler'          → http-libs-only-in-core-http
modules/billing/http/uses-idem.ts       import '@node-idempotency/core'     → http-libs-only-in-core-http
modules/billing/infra/uses-undici.ts    import 'undici'                     → outbound-libs-only-in-core-resilience
core/http/uses-ipaddr.ts                import 'ipaddr.js'                  → outbound-libs-only-in-core-resilience
modules/a/cycle-a.ts ↔ modules/a/cycle-b.ts                                 → no-circular
core/http/express-ok.ts                 import 'express' (hợp lệ)
modules/billing/http/uses-express.ts    import 'express'                    → http-platform-only-in-core-http
```
Mỗi file chỉ chứa đúng lệnh import tương ứng, ví dụ `import '@mikro-orm/core';`. Các package được import phải có trong `node_modules` (đều đã cài ở task trước).

`test/unit/architecture/rules.spec.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const Report = z.object({ summary: z.object({ violations: z.array(z.object({ rule: z.object({ name: z.string() }) })) }) });
const ExecError = z.object({ stdout: z.string() });

function violations(): string[] {
  try {
    execFileSync('pnpm', ['depcruise', 'test/architecture/fixtures/src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'], { encoding: 'utf8', stdio: 'pipe' });
    return [];
  } catch (e) {
    const out = ExecError.parse(e).stdout;
    return Report.parse(JSON.parse(out)).summary.violations.map((v) => v.rule.name);
  }
}

describe('architecture rules', () => {
  const v = violations();
  it.each([
    'features-only-public-api', 'modules-only-index-of-other-modules', 'core-independent',
    'orm-only-in-infra', 'bullmq-only-in-core-queue', 'http-platform-only-in-core-http',
    'domain-pure', 'no-circular', 'http-libs-only-in-core-http', 'outbound-libs-only-in-core-resilience',
  ])('rule %s catches its fixture violation', (rule) => {
    expect(v).toContain(rule);
  });
  it('real source tree has no violations', () => {
    expect(() => execFileSync('pnpm', ['arch'], { stdio: 'pipe' })).not.toThrow();
  });
});
```
Run: `pnpm test` → FAIL (chưa có luật).

- [ ] **Step 3: Định nghĩa luật trong `.dependency-cruiser.cjs`**

Thêm vào mảng `forbidden` (file do `--init` sinh, chỉ thêm luật, giữ phần còn lại):
```js
{ name: 'features-only-public-api', severity: 'error',
  from: { path: '(^|/)src/features/' },
  to: { path: '(^|/)src/(modules|core)/[^/]+/(?!index\\.ts$)' } },
{ name: 'modules-only-index-of-other-modules', severity: 'error',
  from: { path: '(^|/)src/modules/([^/]+)/' },
  to: { path: '(^|/)src/modules/([^/]+)/(?!index\\.ts$)', pathNot: '(^|/)src/modules/$2/' } },
{ name: 'core-independent', severity: 'error',
  from: { path: '(^|/)src/core/' },
  to: { path: '(^|/)src/(modules|features)/' } },
{ name: 'orm-only-in-infra', severity: 'error',
  from: { pathNot: '(^|/)src/(core/database/|.+/infra/)' },
  to: { path: 'node_modules/@mikro-orm/' } },
{ name: 'bullmq-only-in-core-queue', severity: 'error',
  from: { pathNot: '(^|/)src/core/queue/' },
  to: { path: 'node_modules/(bullmq|bullmq-otel|@nestjs/bullmq)/' } },
{ name: 'http-platform-only-in-core-http', severity: 'error',
  from: { pathNot: '(^|/)src/core/http/' },
  to: { path: 'node_modules/(express|fastify|@nestjs/platform-express|@nestjs/platform-fastify)/' } },
{ name: 'domain-pure', severity: 'error',
  from: { path: '(^|/)src/.+/domain/' },
  to: { path: '((^|/)src/.+/(infra|http)/|node_modules/(@mikro-orm|bullmq|express|ioredis)/)' } },
{ name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
{ name: 'http-libs-only-in-core-http', severity: 'error',
  from: { pathNot: '(^|/)src/core/http/' },
  to: { path: 'node_modules/(@nestjs/throttler|rate-limiter-flexible|@node-idempotency)/' } },
{ name: 'outbound-libs-only-in-core-resilience', severity: 'error',
  from: { pathNot: '(^|/)src/core/resilience/' },
  to: { path: 'node_modules/(undici|ipaddr\\.js|cockatiel)/' } },
```
Verify: cú pháp group reference `$2` trong `pathNot` và regex lookahead trong dependency-cruiser (`https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md`); nếu không hỗ trợ thì viết lại bằng `pathNot` liệt kê cụ thể. Luật `no-circular` có thể đã có từ `--init` dưới tên khác: đổi tên cho khớp test. `src/core/redis/**` import `ioredis` là hợp lệ; `bullmq-otel` chỉ trong `core/queue`.

Chỉnh fixture theo cú pháp regex cuối cùng, sao cho mỗi luật chỉ bắt đúng fixture của nó.

Run: `pnpm test && pnpm arch` → PASS (fixture bị bắt đủ, `src` sạch).

- [ ] **Step 4: Quét hard code và cast mù (viết test trước)**

`test/unit/architecture/hardcode-scan.spec.ts`:
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'src';
const ALLOW_FILE = /\.config\.ts$|\/config\/|\/migrations\//;
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'cron expression', re: /['"`](\*|\d+|\*\/\d+)(\s+(\*|\d+|\*\/\d+|[\d,-]+)){4,5}['"`]/ },
  { name: 'http(s) URL', re: /['"`]https?:\/\/(?!schemas?\.|swc\.rs)[^'"`]+['"`]/ },
  { name: 'duration literal (ms)', re: /\b(setTimeout|setInterval)\([^,]+,\s*\d{3,}\s*\)/ },
  { name: 'ttl/timeout literal', re: /\b(ttl|timeout|timeoutMs|ttlMs|delayMs|limit|batchSize)\s*:\s*\d{2,}\b/i },
  { name: 'blind cast', re: /\bas\s+(never|any)\b|:\s*any\b/ },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
}

describe('no hard-coded tunables or blind casts in src', () => {
  const offenders = files(ROOT)
    .filter((f) => !ALLOW_FILE.test(f.replaceAll('\\', '/')))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      PATTERNS.filter((p) => p.re.test(line)).map((p) => `${f}:${i + 1} ${p.name}: ${line.trim()}`)));
  it('finds none', () => {
    expect(offenders).toEqual([]);
  });
});
```
Run: `pnpm test` → PASS. Nếu FAIL: mỗi dòng bị báo phải chuyển vào config (hoặc sửa kiểu cho đúng). Không thêm ngoại lệ vào `ALLOW_FILE` để cho qua. Nếu pattern bắt nhầm một hằng số thuật toán thì sửa pattern, kèm một test chứng minh pattern mới vẫn bắt được trường hợp thật.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(arch): enforce module and library boundaries, forbid hard-coded tunables and blind casts"
```

---

### Task 18: Health + draining + tắt êm (kiểm bằng SIGTERM thật)

**Files:**
- Create: `src/core/health/{health.config.ts,draining.ts,readiness.ts,health.controller.ts,shutdown-coordinator.ts,worker-health.server.ts,health.module.ts,index.ts}`, `test/support/worker-entry.ts`, `test/support/spawn-worker.ts`, `test/fixtures/process.jobs.ts`
- Modify: `src/main.worker.ts` (`bootstrapWorker(root?)`), `src/app-api.module.ts`, `src/app-worker.module.ts`
- Test: `test/e2e/core/health.e2e.spec.ts`, `test/integration/core/health/worker-sigterm.spec.ts`

**Interfaces:**
- Consumes: `Db`, `REDIS`, `HealthCheckService`/`HealthIndicatorService` (terminus), `SkipRateLimit`, `installShutdown`
- Produces:
  - `Draining` (`isDraining()`, `start()`); `Readiness.indicators(): (() => Promise<HealthIndicatorResult>)[]`
  - `GET /health/live`, `GET /health/ready` (api, không bị rate limit); server `node:http` tối thiểu cho worker
  - `ShutdownCoordinator` (api): `beforeApplicationShutdown` → `draining.start()` → chờ `HEALTH_DRAIN_DELAY_MS`
  - `HealthModule.forRoot({ http: boolean })`
  - `bootstrapWorker(root?: Type<unknown>)`; `test/support/worker-entry.ts` (process con thật, gửi `ready`/`started`/`done` qua IPC)

- [ ] **Step 1: Cài package và viết test trước**

```bash
pnpm view @nestjs/terminus dist-tags peerDependencies && pnpm add @nestjs/terminus
```
Verify API `HealthIndicatorService` (`check(key).up()/down()`) và `HealthCheckService.check` của `@nestjs/terminus` latest (`https://docs.nestjs.com/recipes/terminus`).

`test/fixtures/process.jobs.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import { UnitOfWork } from '../../src/core/database/index.js';
import { Inbox } from '../../src/core/outbox/index.js';
import { JobHandler, defineJob, type JobContext } from '../../src/core/queue/index.js';
import { FixtureQueue } from './fixture.jobs.js';
import { FixtureModule, FixtureRepo } from './fixture.module.js';

export const HoldJob = defineJob({
  name: 'fixture.process.hold', queue: FixtureQueue, version: 1,
  schema: z.object({ eventId: z.uuid(), body: z.string(), holdMs: z.number().int().positive() }),
});

/** Ghi một dòng trong transaction rồi giữ transaction `holdMs`; báo tiến độ cho process cha qua IPC. */
@Injectable() @JobHandler(HoldJob)
export class HoldHandler {
  constructor(private readonly uow: UnitOfWork, private readonly inbox: Inbox, private readonly repo: FixtureRepo) {}
  async handle(ctx: JobContext<z.infer<typeof HoldJob.schema>>): Promise<void> {
    await this.uow.run(() => this.inbox.once('fixture.process.hold', ctx.payload.eventId, async () => {
      await this.repo.insertSystemNote(ctx.payload.body);
      process.send?.({ started: ctx.payload.body });
      await new Promise((r) => setTimeout(r, ctx.payload.holdMs));
    }));
    process.send?.({ done: ctx.payload.body });
  }
}

@Module({ imports: [FixtureModule], providers: [HoldHandler] })
export class ProcessJobsModule {}
```
`test/support/worker-entry.ts` (process con thật; dùng đúng đường khởi động và tắt của production):
```ts
import { Module } from '@nestjs/common';
import { AppWorkerModule } from '../../src/app-worker.module.js';
import { bootstrapWorker } from '../../src/main.worker.js';
import { installShutdown } from '../../src/shutdown.js';
import { ProcessJobsModule } from '../fixtures/process.jobs.js';

@Module({ imports: [AppWorkerModule, ProcessJobsModule] })
class TestWorkerModule {}

const ctx = await bootstrapWorker(TestWorkerModule);
installShutdown(ctx);
process.send?.({ ready: true });
```
`test/support/spawn-worker.ts` (dùng chung cho Task 18 và 19). Loader TS cho process con: `--import @swc-node/register/esm-register` (đã cài cố định ở Task 1; verify tên entry trong README của `@swc-node/register`):
```ts
import { fork, type ChildProcess } from 'node:child_process';

const TS_LOADER_ARGS = ['--import', '@swc-node/register/esm-register'];
const POLL_MS = 50;
export type WorkerMsg = { ready?: boolean; started?: string; done?: string };

/** Chạy test/support/worker-entry.ts trong process thật; resolve khi worker báo `ready`. */
export function startWorker(env: Record<string, string>): Promise<{ child: ChildProcess; messages: WorkerMsg[] }> {
  const child = fork('test/support/worker-entry.ts', [], { execArgv: TS_LOADER_ARGS, env: { ...process.env, ...env }, stdio: 'inherit' });
  const messages: WorkerMsg[] = [];
  child.on('message', (m: WorkerMsg) => messages.push(m));
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => reject(new Error(`worker exited early with ${code}`));
    child.once('exit', onExit);
    child.on('message', (m: WorkerMsg) => { if (m.ready) { child.off('exit', onExit); resolve({ child, messages }); } });
  });
}

export const waitForMessage = (messages: WorkerMsg[], pred: (m: WorkerMsg) => boolean, ms: number) => new Promise<void>((resolve, reject) => {
  const started = Date.now();
  const tick = () => { if (messages.some(pred)) return resolve(); if (Date.now() - started > ms) return reject(new Error('timeout waiting for worker message')); setTimeout(tick, POLL_MS); };
  tick();
});

export const exitCode = (child: ChildProcess) => new Promise<number | null>((r) => child.once('exit', r));
```
`test/integration/core/health/worker-sigterm.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import { JobQueue, QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { HoldJob } from '../../../fixtures/process.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';
import { baseTestEnv } from '../../../support/env.js';
import { exitCode, startWorker, waitForMessage } from '../../../support/spawn-worker.js';

const HOLD_MS = 2_000;

describe('worker receives a real SIGTERM mid-job', () => {
  let producer: INestApplication;
  beforeAll(async () => {
    producer = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), FixtureModule]);
  });
  afterAll(async () => { await producer.close(); });

  it('finishes the in-flight job, commits once, then exits 0', async () => {
    const body = `sigterm-${randomUUID()}`;
    const { child, messages } = await startWorker({ ...baseTestEnv(), WORKER_QUEUES: 'fixture', WORKER_HEALTH_PORT: '0', HEALTH_DRAIN_DELAY_MS: '0' });
    await producer.get(JobQueue).enqueue(HoldJob, { eventId: randomUUID(), body, holdMs: HOLD_MS });
    await waitForMessage(messages, (m) => m.started === body, 30_000);
    const exited = exitCode(child);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(messages.some((m) => m.done === body)).toBe(true);
    expect(await producer.get(FixtureRepo).countSystemNotes(body)).toBe(1);
  });
});
```
`test/e2e/core/health.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { Draining, HealthModule } from '../../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

describe('health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', '2');
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, HttpModule, HealthModule.forRoot({ http: true })], { beforeInit: applyHttpDefaults });
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('live is 200; ready is 200 when DB and Redis are up; neither is rate limited', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).get('/health/live').expect(200);
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    }
  });

  it('ready turns 503 service_unavailable while draining, live stays 200', async () => {
    app.get(Draining).start();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body.code).toBe('service_unavailable');
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
```
Run: `pnpm build && pnpm test:int` → FAIL.

- [ ] **Step 2: Cài đặt**

`health.config.ts`: `HEALTH_CHECK_TIMEOUT_MS` (1000), `HEALTH_DRAIN_DELAY_MS` (5000, thời gian chờ load balancer ngừng gửi request), `WORKER_HEALTH_PORT` (3001, cho phép `0` trong test), `WORKER_HEALTH_HOST` (`0.0.0.0`). Mỗi key có `.describe()`; thêm vào `all-configs.ts`.

`draining.ts`:
```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class Draining {
  private draining = false;
  isDraining(): boolean { return this.draining; }
  start(): void { this.draining = true; }
}
```
`readiness.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { type ConfigOf } from '../config/index.js';
import { Db } from '../database/index.js';
import { REDIS } from '../redis/index.js';
import { healthConfig } from './health.config.js';

@Injectable()
export class Readiness {
  constructor(
    private readonly indicator: HealthIndicatorService, private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis, @Inject(healthConfig.KEY) private readonly cfg: ConfigOf<typeof healthConfig>,
  ) {}

  indicators(): (() => Promise<HealthIndicatorResult>)[] {
    return [() => this.probe('database', () => this.db.execute('SELECT 1')), () => this.probe('redis', () => this.redis.ping())];
  }

  private async probe(key: string, fn: () => Promise<unknown>): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${key} check timed out`)), this.cfg.checkTimeoutMs); })]);
      return check.up();
    } catch (err) {
      return check.down({ message: err instanceof Error ? err.message : 'check failed' });
    } finally {
      clearTimeout(timer);
    }
  }
}
```
`health.controller.ts` (khung bằng `pnpm nest g controller core/health --no-spec --flat`):
```ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { AppError, CoreErrors } from '../errors/index.js';
import { SkipRateLimit } from '../http/index.js';
import { Draining } from './draining.js';
import { Readiness } from './readiness.js';

@SkipRateLimit()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService, private readonly draining: Draining, private readonly readiness: Readiness) {}

  @Get('live')
  live() { return { status: 'ok' }; }

  @Get('ready')
  @HealthCheck()
  ready() {
    if (this.draining.isDraining()) throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, { detail: 'Instance is draining' });
    return this.health.check(this.readiness.indicators());
  }
}
```
Terminus ném `ServiceUnavailableException` khi có indicator `down` → filter map sang `503 service_unavailable` (bảng `HTTP_STATUS_TO_CODE` ở Task 4). Verify chi tiết indicator không lộ ra response (filter không đưa `detail` của `HttpException` ra ngoài).

`shutdown-coordinator.ts`:
```ts
import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ConfigOf } from '../config/index.js';
import { Draining } from './draining.js';
import { healthConfig } from './health.config.js';

/** api: báo not-ready rồi chờ load balancer ngừng gửi request, trước khi Nest đóng HTTP server. */
@Injectable()
export class ShutdownCoordinator implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownCoordinator.name);
  constructor(private readonly draining: Draining, @Inject(healthConfig.KEY) private readonly cfg: ConfigOf<typeof healthConfig>) {}
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining.start();
    this.logger.log({ signal, drainDelayMs: this.cfg.drainDelayMs }, 'draining before shutdown');
    await sleep(this.cfg.drainDelayMs);
  }
}
```
Verify thứ tự hook của Nest 12 (`https://docs.nestjs.com/fundamentals/lifecycle-events`): `onModuleDestroy` → `beforeApplicationShutdown` → đóng HTTP server → `onApplicationShutdown`; và giữa các module thì module phụ thuộc đóng trước module nó import. `WorkerHost`, `OutboxRelay`, `BullmqJobQueue` đóng ở `onApplicationShutdown`; `RedisModule` và MikroORM phải đóng **sau** chúng. Test SIGTERM thật ở trên sẽ lộ ra sai thứ tự (job không `done` hoặc exit code khác 0). Nếu sai thì gom việc đóng Redis và pool vào một coordinator duy nhất chạy tuần tự đúng thứ tự trong spec.

`worker-health.server.ts`: `node:http` phục vụ `/health/live` và `/health/ready` (gọi `HealthCheckService.check(readiness.indicators())`, lỗi → `503` JSON `{ status: 'error' }`), lắng nghe `WORKER_HEALTH_HOST:WORKER_HEALTH_PORT` trong `onApplicationBootstrap`, đóng trong `onApplicationShutdown` (`server.close()` + `closeAllConnections()`, chờ callback). Ready trả `503` khi `Draining` bật; worker bật `Draining` ở `beforeApplicationShutdown`.

`health.module.ts`:
```ts
import { DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Draining } from './draining.js';
import { HealthController } from './health.controller.js';
import { Readiness } from './readiness.js';
import { ShutdownCoordinator } from './shutdown-coordinator.js';
import { WorkerHealthServer } from './worker-health.server.js';

@Module({})
export class HealthModule {
  static forRoot(opts: { http: boolean }): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule],
      controllers: opts.http ? [HealthController] : [],
      providers: [Draining, Readiness, ShutdownCoordinator, ...(opts.http ? [] : [WorkerHealthServer])],
      exports: [Draining],
    };
  }
}
```
`AppApiModule` import `HealthModule.forRoot({ http: true })`, `AppWorkerModule` import `HealthModule.forRoot({ http: false })`. Worker dùng `HEALTH_DRAIN_DELAY_MS` = 0 là hợp lý (không có load balancer); ghi vào `.env.example` qua `describe`.

`src/main.worker.ts`: đổi chữ ký thành `bootstrapWorker(root: Type<unknown> = AppWorkerModule)` và truyền `root` vào `NestFactory.createApplicationContext`. Khối `if (import.meta.url === …)` gọi `bootstrapWorker().then(installShutdown)`.

Run: `pnpm build && pnpm test:int` → PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): liveness/readiness, draining and ordered graceful shutdown verified with a real sigterm"
```

---

### Task 19: Docker image, Compose cho app, collector, chaos test

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker/otel-collector/config.yaml`, `test/chaos/redis-outage.spec.ts`, `test/chaos/worker-kill.spec.ts`
- Modify: `compose.yaml` (thêm api, worker, migrate, otel-collector), `docker/images.env`, `src/core/config/dev-infra.config.ts` (`COMPOSE_REDIS_URL`, `OTEL_PORT_HOST`), `vitest.config.ts` (project `chaos`)

**Interfaces:**
- Produces: image chạy được cả 3 vai trò; `pnpm test:chaos`; số đo kích thước image và thời gian khởi động

- [ ] **Step 1: Khởi tạo Dockerfile bằng CLI rồi sửa**

Run: `docker init --help`. Nếu có template Node thì chạy `docker init` (Node, pnpm, lệnh build `pnpm build`), đọc file sinh ra, rồi sửa theo spec cha mục 13.3 thành nội dung cuối bên dưới. Tag và digest lấy bằng lệnh như Task 2 Step 1:
```bash
curl -s "https://hub.docker.com/v2/repositories/library/node/tags?page_size=100&name=bookworm-slim" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).results.map(t=>t.name).filter(n=>/^24\.\d+\.\d+-bookworm-slim$/.test(n)).slice(0,3).join(' ')))"
docker buildx imagetools inspect node:<tag từ lệnh trên> --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect gcr.io/distroless/nodejs24-debian13:nonroot --format '{{json .Manifest.Digest}}'
```
Thêm `IMAGE_NODE_BUILD` và `IMAGE_NODE_RUNTIME` vào `docker/images.env`.

Xác định file cấu hình pnpm thật sự có trong repo trước khi viết `COPY`:
```bash
ls -a | grep -E '^(\.npmrc|pnpm-workspace\.yaml|\.pnpmfile\.cjs)$'
```
Expected: `pnpm-workspace.yaml` (chứa `minimumReleaseAge`, allowlist build script, `overrides` nếu pnpm ghi vào đó). Nếu có `.npmrc` thì chuyển các setting không bí mật vào `pnpm-workspace.yaml` bằng `pnpm config set --location project`, xoá `.npmrc`; image **không bao giờ** `COPY .npmrc` (có thể chứa token).

`Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
ARG BUILD_IMAGE
ARG RUNTIME_IMAGE

FROM ${BUILD_IMAGE} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile \
 && pnpm build \
 && test -d dist/migrations && test -f dist/main.migrate.js \
 && pnpm prune --prod

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
USER 65532
CMD ["--import", "./dist/instrumentation.js", "dist/main.api.js"]
```
Distroless có `ENTRYPOINT ["/nodejs/bin/node"]`, nên `CMD` chỉ chứa tham số của node; verify bằng `docker buildx imagetools inspect … --format '{{json .Image.Config}}'`. `test -d dist/migrations` làm build fail ngay nếu layout ở Task 1 bị lệch (migration không được biên dịch). Verify `pnpm prune --prod` với pnpm latest (`pnpm prune --help`). Nếu Task 16 cần flag loader ESM cho OTel thì thêm vào `CMD` và `command` trong compose.

`.dockerignore`:
```
.git
node_modules
dist
coverage
.env
.env.*
!.env.example
.npmrc
test
docs
**/*.md
.github
```
Run:
```bash
docker buildx build --build-arg BUILD_IMAGE=$(grep '^IMAGE_NODE_BUILD=' docker/images.env | cut -d= -f2-) --build-arg RUNTIME_IMAGE=$(grep '^IMAGE_NODE_RUNTIME=' docker/images.env | cut -d= -f2-) -t backend-demo:local --load .
docker image ls backend-demo:local --format '{{.Size}}'
docker run --rm --entrypoint /nodejs/bin/node backend-demo:local -e "console.log(process.getuid())"
docker run --rm backend-demo:local dist/main.migrate.js --help
```
Expected: build thành công; kích thước được ghi lại (mục tiêu ≤ 200 MB); UID `65532`; lệnh migrate in usage (không cần DB).

- [ ] **Step 2: Compose cho app + collector**

Thêm vào `devInfraConfig` (Task 3): `composeRedisUrl: 'COMPOSE_REDIS_URL'` (`z.string().describe('REDIS_URL used by app containers inside compose, e.g. redis://:<password>@redis:6379')`, không default vì chứa mật khẩu) và `otelPortHost: 'OTEL_PORT_HOST'` (`.default(4318)`). Chạy `pnpm env:example`.

Thêm vào `compose.yaml`:
```yaml
  migrate:
    image: backend-demo:local
    command: ["dist/main.migrate.js", "up"]
    env_file: [.env]
    environment: { DB_HOST: postgres, DB_PORT: "5432" }
    depends_on: { postgres: { condition: service_healthy } }
  api:
    image: backend-demo:local
    env_file: [.env]
    environment: { DB_HOST: pgbouncer, DB_PORT: "5432", REDIS_URL: "${COMPOSE_REDIS_URL}" }
    ports: ["127.0.0.1:${HTTP_PORT_HOST}:3000"]
    depends_on: { migrate: { condition: service_completed_successfully }, redis: { condition: service_healthy }, pgbouncer: { condition: service_started } }
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
  worker:
    image: backend-demo:local
    command: ["--import", "./dist/instrumentation.js", "dist/main.worker.js"]
    env_file: [.env]
    environment: { DB_HOST: pgbouncer, DB_PORT: "5432", DB_RELAY_HOST: postgres, DB_RELAY_PORT: "5432", REDIS_URL: "${COMPOSE_REDIS_URL}" }
    depends_on: { migrate: { condition: service_completed_successfully }, redis: { condition: service_healthy }, pgbouncer: { condition: service_started } }
  otel-collector:
    image: ${IMAGE_OTEL_COLLECTOR}
    profiles: [observability]
    volumes: ["./docker/otel-collector/config.yaml:/etc/otelcol/config.yaml:ro"]
    ports: ["127.0.0.1:${OTEL_PORT_HOST}:4318"]
```
Port `3000`/`5432`/`4318` ở đây là port **bên trong container** (cố định theo image/app), port phía host lấy từ `.env` và chỉ bind `127.0.0.1`. Connection `relay` của worker nối thẳng Postgres (không qua PgBouncer). Healthcheck dùng `127.0.0.1:3000` khớp `HTTP_PORT` mặc định; nếu `.env` đổi `HTTP_PORT` thì healthcheck phải đổi theo — ghi chú này vào `describe` của `HTTP_PORT`.

Lấy image collector như Task 2 (`otel/opentelemetry-collector-contrib`, tag stable mới nhất, pin digest), thêm `IMAGE_OTEL_COLLECTOR=` vào `docker/images.env`. `docker/otel-collector/config.yaml`: receiver OTLP HTTP, processor `tail_sampling` (policy giữ trace lỗi + probabilistic), exporter `debug`. Verify tên processor và option trong README collector-contrib.

Run: `docker compose --env-file docker/images.env --env-file .env up -d && curl -fsS 127.0.0.1:<HTTP_PORT_HOST>/health/ready`
Expected: `{"status":"ok",...}`. Đo thời gian từ lúc process bắt đầu tới ready bằng `docker compose logs api --timestamps` (mục tiêu < 3 giây), ghi vào ADR 0013. `docker compose stop api` và xem log: draining → đóng → exit 0.

- [ ] **Step 3: Chaos test (viết trước, chạy trên Toxiproxy)**

```bash
pnpm view @testcontainers/toxiproxy dist-tags && pnpm add -D @testcontainers/toxiproxy
```
Thêm project `chaos` vào `vitest.config.ts` (dùng chung `globalSetup` với `integration`, nên hạ tầng và migration đã sẵn sàng; env cơ bản do `createTestApp` gọi `applyTestEnv()`):
```ts
{
  extends: true,
  test: {
    name: 'chaos',
    include: ['test/chaos/**/*.spec.ts'],
    globalSetup: ['test/support/infra.global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
},
```
Script: `"test:chaos": "vitest run --project chaos"`. Loại `test/chaos/**` khỏi project `integration`.

Lấy image Toxiproxy như Task 2 Step 1 (`ghcr.io/shopify/toxiproxy`, tag stable mới nhất, pin digest), thêm `IMAGE_TOXIPROXY=` vào `docker/images.env`. Verify API ở `https://node.testcontainers.org/modules/toxiproxy/`: `ToxiProxyContainer`, `createProxy({ name, upstream })` → `{ host, port, setEnabled(bool) }`, `Network`, `withNetwork`, `withNetworkAliases`.

`test/chaos/redis-outage.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Body, Controller, Get, HttpCode, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { ToxiProxyContainer, type StartedToxiProxyContainer } from '@testcontainers/toxiproxy';
import { DatabaseModule, RelayDb } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { HttpModule, Idempotent, applyHttpDefaults } from '../../src/core/http/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { FixtureNotesModule } from '../fixtures/fixture.controller.js';
import { AuditSubscriber, MailerSubscriber, received } from '../fixtures/fixture.events.js';
import { createTestApp } from '../support/app-factory.js';
import { readImages } from '../support/images.js';
import { TestPrincipalModule } from '../support/test-principal.middleware.js';

@Module({ providers: [AuditSubscriber, MailerSubscriber] }) class Subs {}
@Controller('chaos') class ChaosRoutes {
  @Get('ping') ping() { return { ok: true }; }
  @Post('pay') @HttpCode(201) @Idempotent() pay(@Body() b: { amount: number }) { return { amount: b.amount }; }
}
@Module({ controllers: [ChaosRoutes] }) class Routes {}
const OUTAGE_MS = 10_000;
const EVENTS = 20;
const REDIS_PORT = 6379;
const until = async (pred: () => boolean | Promise<boolean>, ms: number) => {
  const t = Date.now();
  while (!(await pred())) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 200)); }
};

describe('redis outage', () => {
  let network: StartedNetwork; let redis: StartedTestContainer; let toxi: StartedToxiProxyContainer;
  let proxy: Awaited<ReturnType<StartedToxiProxyContainer['createProxy']>>;
  let app: INestApplication;

  beforeAll(async () => {
    const images = readImages();
    network = await new Network().start();
    redis = await new GenericContainer(images.IMAGE_REDIS).withNetwork(network).withNetworkAliases('redis').withExposedPorts(REDIS_PORT).start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY).withNetwork(network).start();
    proxy = await toxi.createProxy({ name: 'redis', upstream: `redis:${REDIS_PORT}` });
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('REDIS_URL', `redis://${proxy.host}:${proxy.port}`);
    vi.stubEnv('WORKER_QUEUES', 'events');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '200');
    vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '100');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }), FixtureNotesModule, Subs, HttpModule, TestPrincipalModule, Routes,
    ], { beforeInit: applyHttpDefaults });
  });
  afterAll(async () => {
    await app.close(); await toxi.stop(); await redis.stop(); await network.stop(); vi.unstubAllEnvs();
  });

  it('commands keep succeeding while Redis is down and events are delivered exactly once after recovery', async () => {
    received.length = 0;
    const bodies = Array.from({ length: EVENTS }, (_, i) => `outage-${Date.now()}-${i}`);
    await proxy.setEnabled(false);

    for (const body of bodies) await request(app.getHttpServer()).post('/fixture/notes').send({ body }).expect(201);

    const pending = async () => Number((await app.get(RelayDb).execute<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox_events WHERE published_at IS NULL AND payload->>'body' = ANY(?)`, [bodies]))[0]?.n ?? 0);
    await new Promise((r) => setTimeout(r, OUTAGE_MS));
    expect(await pending()).toBe(EVENTS);

    await proxy.setEnabled(true);
    await until(() => bodies.every((b) => received.filter((r) => r.body === b).length === 2), 120_000);
    await until(async () => (await pending()) === 0, 30_000);

    const pairs = received.filter((r) => bodies.includes(r.body)).map((r) => `${r.consumer}:${r.eventId}`);
    expect(pairs).toHaveLength(EVENTS * 2);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('rate limiting falls back to the in-memory insurance limiter while Redis is down', async () => {
    await proxy.setEnabled(false);
    try {
      await request(app.getHttpServer()).get('/chaos/ping').expect(200);
    } finally {
      await proxy.setEnabled(true);
    }
  });

  it('idempotent routes fail closed with 503 while Redis is down', async () => {
    await proxy.setEnabled(false);
    try {
      const res = await request(app.getHttpServer()).post('/chaos/pay').set('content-type', 'application/json')
        .set('Idempotency-Key', `chaos-key-${Date.now()}-xxxxxxxx`).set('x-test-principal', 'user:chaos').send({ amount: 1 });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('service_unavailable');
    } finally {
      await proxy.setEnabled(true);
    }
  });
});
```
Cột `payload` của outbox chứa đúng `data` của event (Task 10), nên lọc bằng `payload->>'body'`. `OUTAGE_MS`, `EVENTS` là tham số của bộ test. Không có `sleep` cố định để "chờ cho chắc": điều kiện kết thúc là `pending() === 0`. Lệnh ioredis khi Redis sập phải lỗi nhanh (theo `REDIS_COMMAND_TIMEOUT_MS`/`REDIS_MAX_RETRIES_PER_REQUEST` ở Task 8), nếu không hai test sau sẽ treo tới timeout — nếu treo thì stub hai env này nhỏ lại trong test.

`test/chaos/worker-kill.spec.ts` (dùng `worker-entry.ts`, `HoldJob` và `spawn-worker.ts` của Task 18):
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../src/core/database/index.js';
import { JobQueue, QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { FixtureModule, FixtureRepo } from '../fixtures/fixture.module.js';
import { HoldJob } from '../fixtures/process.jobs.js';
import { createTestApp } from '../support/app-factory.js';
import { baseTestEnv } from '../support/env.js';
import { exitCode, startWorker, waitForMessage } from '../support/spawn-worker.js';

const HOLD_MS = 5_000;
const STALLED_MS = 1_000;
const REDELIVERY_TIMEOUT_MS = 60_000;

describe('worker killed mid-job', () => {
  let producer: INestApplication;
  const env = () => ({
    ...baseTestEnv(), WORKER_QUEUES: 'fixture', WORKER_HEALTH_PORT: '0', HEALTH_DRAIN_DELAY_MS: '0',
    QUEUE_STALLED_INTERVAL_MS: String(STALLED_MS), QUEUE_LOCK_DURATION_MS: String(STALLED_MS),
  });

  beforeAll(async () => {
    producer = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), FixtureModule]);
  });
  afterAll(async () => { await producer.close(); });

  it('job is redelivered to a new worker and its effect is committed exactly once', async () => {
    const body = `kill-${randomUUID()}`;
    const first = await startWorker(env());
    await producer.get(JobQueue).enqueue(HoldJob, { eventId: randomUUID(), body, holdMs: HOLD_MS });
    await waitForMessage(first.messages, (m) => m.started === body, 30_000);
    const firstExit = exitCode(first.child);
    first.child.kill('SIGKILL');
    await firstExit;

    const second = await startWorker(env());
    await waitForMessage(second.messages, (m) => m.done === body, REDELIVERY_TIMEOUT_MS);
    const secondExit = exitCode(second.child);
    second.child.kill('SIGTERM');
    expect(await secondExit).toBe(0);

    expect(await producer.get(FixtureRepo).countSystemNotes(body)).toBe(1);
  });
});
```
Worker đầu bị kill **sau khi** báo `started` (đang giữ transaction), nên Postgres rollback dòng vừa insert. Worker thứ hai nhận lại job sau khi phát hiện stalled và commit đúng một lần; `Inbox.once` chặn trường hợp commit hai lần. Process con dùng cùng prefix Redis với process cha nhờ `baseTestEnv()`. `HOLD_MS`, `STALLED_MS` là tham số của bộ test.

Run: `pnpm build && pnpm test:chaos` → PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "build: distroless multi-stage image, compose for app, chaos tests for redis outage and worker kill"
```

---

### Task 20: CI, release, nightly, Renovate

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/nightly.yml`, `renovate.json`, `.nvmrc`
- Modify: `docker/images.env` (`IMAGE_GITLEAKS`, `IMAGE_OSV_SCANNER`)

**Interfaces:**
- Produces: pipeline PR (lint, arch, typecheck, unit, integration, build, docker + Trivy, gitleaks, osv-scanner, CodeQL, kiểm tra `openapi.json` + oasdiff), pipeline release (multi-arch, không dùng cache của PR, SBOM, provenance, cosign), pipeline nightly (chaos)

- [ ] **Step 1: Lấy version action và image công cụ bằng lệnh**

```bash
for a in actions/checkout actions/setup-node pnpm/action-setup docker/setup-buildx-action docker/build-push-action docker/login-action aquasecurity/trivy-action sigstore/cosign-installer oasdiff/oasdiff-action github/codeql-action; do
  echo "$a $(curl -s https://api.github.com/repos/$a/releases/latest | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).tag_name))")"
done
```
Với mỗi tag, lấy SHA commit (`curl -s https://api.github.com/repos/<a>/git/ref/tags/<tag>`); pin action theo SHA, ghi tag trong comment. gitleaks và osv-scanner chạy bằng **image** pin digest (không dùng `gitleaks-action` vì bản cho organization cần license): lấy tag stable mới nhất của `ghcr.io/gitleaks/gitleaks` và `ghcr.io/google/osv-scanner` như Task 2 Step 1, thêm `IMAGE_GITLEAKS=` và `IMAGE_OSV_SCANNER=` vào `docker/images.env`. Verify cú pháp lệnh của đúng version đã pin (`gitleaks git --help` hay `gitleaks detect --help`; `osv-scanner scan source --help`).

Tạo `.nvmrc` bằng `node --version > .nvmrc` (dòng 24 LTS).

- [ ] **Step 2: `ci.yml`**

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  checks:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { task: [lint, arch, typecheck, test, test:int] }
    steps:
      - uses: actions/checkout@<sha> # <tag>
      - uses: pnpm/action-setup@<sha> # <tag>
      - uses: actions/setup-node@<sha> # <tag>
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
        if: matrix.task == 'test:int'
      - run: pnpm ${{ matrix.task }}
  openapi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # <tag>
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@<sha> # <tag>
      - uses: actions/setup-node@<sha> # <tag>
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile && pnpm build && pnpm openapi:export
      - name: committed openapi.json is up to date
        run: git diff --exit-code openapi.json
      - id: base
        run: |
          if git cat-file -e origin/main:openapi.json 2>/dev/null; then echo "exists=true" >> "$GITHUB_OUTPUT"; else echo "exists=false" >> "$GITHUB_OUTPUT"; fi
      - uses: oasdiff/oasdiff-action/breaking@<sha> # <tag>
        if: steps.base.outputs.exists == 'true'
        with: { base: 'origin/main:openapi.json', revision: openapi.json, fail-on: ERR }
  secrets-and-deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # <tag>
        with: { fetch-depth: 0 }
      - name: gitleaks
        run: |
          IMAGE=$(grep '^IMAGE_GITLEAKS=' docker/images.env | cut -d= -f2-)
          docker run --rm -v "$PWD:/repo" "$IMAGE" git /repo --redact --exit-code 1
      - name: osv-scanner
        run: |
          IMAGE=$(grep '^IMAGE_OSV_SCANNER=' docker/images.env | cut -d= -f2-)
          docker run --rm -v "$PWD:/src" "$IMAGE" scan source --lockfile /src/pnpm-lock.yaml
  codeql:
    runs-on: ubuntu-latest
    permissions: { contents: read, security-events: write }
    steps:
      - uses: actions/checkout@<sha> # <tag>
      - uses: github/codeql-action/init@<sha> # <tag>
        with: { languages: javascript-typescript }
      - uses: github/codeql-action/analyze@<sha> # <tag>
  image:
    runs-on: ubuntu-latest
    needs: checks
    steps:
      - uses: actions/checkout@<sha> # <tag>
      - uses: docker/setup-buildx-action@<sha> # <tag>
      - id: images
        run: grep -E '^IMAGE_NODE_(BUILD|RUNTIME)=' docker/images.env >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@<sha> # <tag>
        with:
          context: .
          load: true
          tags: backend-demo:ci
          build-args: |
            BUILD_IMAGE=${{ steps.images.outputs.IMAGE_NODE_BUILD }}
            RUNTIME_IMAGE=${{ steps.images.outputs.IMAGE_NODE_RUNTIME }}
          cache-from: type=gha,scope=pr-${{ github.ref }}
          cache-to: type=gha,mode=max,scope=pr-${{ github.ref }}
      - uses: aquasecurity/trivy-action@<sha> # <tag>
        with: { image-ref: backend-demo:ci, severity: 'HIGH,CRITICAL', ignore-unfixed: true, exit-code: '1' }
```
Bước `images`: mỗi dòng `IMAGE_NODE_BUILD=node:…@sha256:…` trong `images.env` đã đúng định dạng `key=value` của `$GITHUB_OUTPUT`, nên chỉ cần `grep` (bỏ chuỗi `sed` cũ). Cache của PR có `scope` riêng theo ref để release không bao giờ đọc được. Verify input của từng action theo README của đúng tag đã pin, và cú pháp `docker run` của gitleaks/osv-scanner theo Step 1.

- [ ] **Step 3: `release.yml` và `nightly.yml`**

`release.yml` (trigger `push: tags: ['v*']`, `permissions: { contents: read, packages: write, id-token: write }`):
- login GHCR bằng `docker/login-action`
- lấy `IMAGE_NODE_BUILD`/`IMAGE_NODE_RUNTIME` bằng bước `grep` như `ci.yml`
- `docker/build-push-action` với `platforms: linux/amd64,linux/arm64`, `push: true`, `no-cache: true` (**không** `cache-from` — build release không dùng cache của PR), `sbom: true`, `provenance: mode=max`, tag `ghcr.io/${{ github.repository }}:${{ github.ref_name }}`
- `sigstore/cosign-installer`, rồi `cosign sign --yes ghcr.io/...@${{ steps.build.outputs.digest }}` (keyless qua OIDC)

`nightly.yml` (`schedule: cron` ghi trực tiếp trong workflow, vì đây là lịch CI mà GitHub chỉ đọc từ file này, không phải config của app; ghi ngoại lệ vào ADR 0013): `pnpm install --frozen-lockfile && pnpm build && pnpm test:chaos`.

- [ ] **Step 4: `renovate.json`**

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "helpers:pinGitHubActionDigests", "docker:pinDigests"],
  "rangeStrategy": "pin",
  "minimumReleaseAge": "3 days",
  "internalChecksFilter": "strict",
  "customManagers": [
    {
      "customType": "regex",
      "managerFilePatterns": ["/^docker/images\\.env$/"],
      "matchStrings": ["IMAGE_[A-Z_]+=(?<depName>[^:@\\s]+):(?<currentValue>[^@\\s]+)@(?<currentDigest>sha256:[a-f0-9]+)"],
      "datasourceTemplate": "docker"
    }
  ],
  "packageRules": [
    { "matchPackageNames": ["/^@mikro-orm\\//", "!@mikro-orm/nestjs"], "groupName": "mikro-orm" },
    { "matchPackageNames": ["@mikro-orm/nestjs"], "groupName": "mikro-orm-nestjs" },
    { "matchPackageNames": ["/^@opentelemetry\\//"], "groupName": "opentelemetry" }
  ]
}
```
`@mikro-orm/nestjs` có version riêng nên tách nhóm. Verify tên key `managerFilePatterns`, `minimumReleaseAge`, `internalChecksFilter` và cú pháp phủ định `!` trong `matchPackageNames` theo tài liệu Renovate hiện hành. Chạy `pnpm dlx renovate-config-validator` (xem `--help`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: pr checks, secret/dependency/code scanning, image scan, openapi diff, signed multi-arch release, nightly chaos, renovate"
```

---

### Task 21: ADR còn lại, README, bảng số đo

**Files:**
- Create: `docs/adr/0001-modular-monolith.md`, `0002-clone-and-upstream.md`, `0004-ports-and-adapters.md`, `0011-cqrs-without-eventbus.md`, và hoàn tất các ADR đã mở ở task trước (0003, 0005, 0006, 0007, 0008, 0009, 0010, 0012, 0013, 0014)
- Create/Modify: `README.md` (thay README do CLI sinh)

- [ ] **Step 1: ADR**

Theo mẫu MADR (Bối cảnh, Quyết định, Phương án đã loại, Hệ quả). Nội dung lấy từ spec cha (mục 1, 1.1, 4.2, 7), review trước thực thi (mục 0 và 2) và các quyết định phát sinh khi làm. Không bịa quyết định mới: chỗ nào spec chưa quyết thì ghi "Chưa quyết, xem sub-project N". Bull Board: ghi rõ đã bỏ khỏi SP1, làm ở SP2 sau RBAC admin.

- [ ] **Step 2: README**

Mục bắt buộc:
- Yêu cầu: Node 24 LTS, pnpm (qua corepack), Docker.
- Chạy dev:
  ```bash
  pnpm install
  pnpm env:example && cp .env.example .env    # điền secret
  docker compose --env-file docker/images.env --env-file .env up -d postgres redis pgbouncer
  pnpm build && pnpm migrate up
  pnpm start:dev
  ```
- Bảng env: sinh bằng `pnpm env:example`; README chỉ trỏ tới `.env.example`, không chép lại.
- Cách thêm: config (`defineConfig`), queue/job (`defineQueue`/`defineJob` + `@JobHandler`, `tenantSchedulable` cho job tenant được đặt lịch), cron (`defineCron` với lịch lấy từ config; bỏ cron bằng `retireCron`), event (`defineEvent` + `EventPublisher.publish` trong `UnitOfWork.run` + `@EventSubscriber`), bảng có RLS (migration tạo bằng CLI, policy `app_current_org()`, grant theo bảng, `OrgScope.run`), route idempotent (`@Idempotent()`), gọi HTTP ra ngoài (`HttpClient`). Mỗi mục một ví dụ ngắn lấy từ `test/fixtures`.
- Quy tắc: các mục trong Global Constraints (cấm hard code, cài latest có `minimumReleaseAge`, ưu tiên có sẵn, dùng CLI, SQL chỉ qua `Db`/`RelayDb`).
- Lệnh kiểm tra: `pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm test:int`.

- [ ] **Step 3: Bảng số đo**

Thêm vào ADR 0013 một bảng: build SWC, type-check TS 7, build image (có cache và không có cache), kích thước image, thời gian khởi động tới ready. Mỗi dòng có cột "mục tiêu" (spec cha mục 13) và "đo được". Chỉ số nào không đạt thì ghi rõ và báo Sếp, không sửa mục tiêu cho khớp.

- [ ] **Step 4: Chạy toàn bộ kiểm tra lần cuối**

```bash
pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm build && pnpm test:int && pnpm test:chaos && pnpm openapi:export && git diff --exit-code openapi.json
```
Expected: tất cả PASS. Dán output tóm tắt vào mô tả PR hoặc báo cáo cho Sếp.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: adrs, readme and measured build/runtime numbers for sub-project 1"
```
