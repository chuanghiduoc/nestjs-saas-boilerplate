# Sub-project 1 — Core + hạ tầng job: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng `core/` của boilerplate NestJS: config, context, DB + UnitOfWork + RLS, outbox/inbox, event, queue, scheduler, HTTP (lỗi, phân trang, idempotency, rate limit), cache, resilience, observability, health. Có 3 entrypoint, Docker và CI. Mọi thứ phải được chứng minh bằng test chạy trên Postgres và Redis thật.

**Architecture:** Modular monolith, một image, ba vai trò (api, worker, migrate). Các thành phần trong `core/` là Nest module, chỉ lộ API qua `index.ts`. Code ngoài `core/database` và `infra/` không biết MikroORM. Code ngoài `core/queue` không biết BullMQ. Event đi theo đường outbox trong Postgres → relay → BullMQ → fan-out → subscriber có inbox chống trùng.

**Tech Stack:** NestJS 12 (ESM, Express), MikroORM 7.2 (PostgreSQL), BullMQ 6 + ioredis, zod 4, nestjs-cls, nestjs-pino, OpenTelemetry, bentocache, cockatiel, @nestjs/throttler, @nestjs/terminus, @nestjs/swagger, Vitest + unplugin-swc, Testcontainers, dependency-cruiser, oxlint, pnpm, SWC, TypeScript 7 (type-check) + 6 (tool API).

**Spec:** `docs/superpowers/specs/2026-09-24-sp1-core-job-infrastructure-design.md` (spec cha: `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`)

## Global Constraints

- **Cấm hard code:** giá trị tuỳ chỉnh (timeout, TTL, giới hạn, batch, cron, retention, URL, origin) chỉ khai báo trong config schema zod của module sở hữu, mỗi giá trị có env var. Secret không có giá trị mặc định. Định danh (tên queue, event, job, mã lỗi, khoá cache) là hằng số có tên, nằm trong registry của module.
- **Cấm tự chọn version:** cài bằng `pnpm add <tên>` không ghi version (lấy latest). Bật `save-exact` bằng lệnh. Trước khi cài chạy `pnpm view <tên> dist-tags peerDependencies`. Bản latest không tương thích thì dừng lại, ghi ADR kèm output của lệnh, và báo Sếp. Docker image pin theo digest lấy bằng lệnh.
- **Dùng CLI có sẵn:** `nest new`, `nest g …`, `pnpm init/add`, `mikro-orm migration:create`, `depcruise --init`, `oxlint --init`. Chỉ viết tay những file không có generator. Không đoán flag: đọc `--help` hoặc tài liệu trước khi dùng.
- **Node:** 24 LTS. **Module:** ESM (import nội bộ có đuôi `.js`), trừ khi spike S1 buộc chuyển sang CommonJS.
- **Import boundaries:** `@mikro-orm/*` chỉ trong `src/core/database/**` và `**/infra/**`. `bullmq` chỉ trong `src/core/queue/**`. `express` chỉ trong `src/core/http/**`.
- **DB:** PK `BIGINT GENERATED ALWAYS AS IDENTITY`, thời gian `TIMESTAMPTZ`, bảng nào cũng có `created_at`/`updated_at`, index nào cũng phải có query dùng nó.
- **Lỗi:** không nuốt lỗi, không trả giá trị sai trong im lặng. Lỗi không lường trước thì log đủ ở server, client nhận problem+json 500 với mã chung.
- **Commit:** mỗi task một commit trở lên, message dạng conventional (`feat(core): …`, `test(core): …`, `chore: …`). Không push khi chưa có lệnh.

## Review Focus

1. **Relay chạy song song và gặp lỗi giữa enqueue và commit:** hai relay không bao giờ gửi cùng một dòng outbox. Nếu enqueue xong mà commit lỗi, subscriber vẫn chỉ chạy một lần. Test ở Task 9 (Step 1, test `concurrent relays` và `enqueue-then-commit-failure`).
2. **`withOrg` với `orgId` rỗng hoặc sai định dạng UUID:** phải ném lỗi tại app trước khi query, không được âm thầm chạy không có tenant. Test ở Task 7 (Step 1, test `rejects empty/invalid orgId`).
3. **Idempotency: cùng key từ hai org khác nhau, và hai request cùng key gần như đồng thời:** không bao giờ trả response của org khác; request thứ hai chờ và nhận cùng kết quả, handler chạy đúng một lần. Test ở Task 13 (Step 2, `same key from two different orgs` và `concurrent same key`).
4. **Cursor bị client sửa:** trả `400 invalid_cursor`, không được 500 và không được lộ dữ liệu. Test ở Task 12 (Step 2, `cursor-pagination.spec.ts`, test `tampered cursor`).
5. **Worker nhận SIGTERM khi đang xử lý job dài:** job đang chạy hoàn tất, hoặc được trả lại để chạy lại. Không bị đánh dấu completed khi chưa xong. Test ở Task 18 (Step 1, test `sigterm mid-job`).

---

## File Structure

```
src/
  main.api.ts · main.worker.ts · main.migrate.ts · instrumentation.ts
  app-api.module.ts · app-worker.module.ts · app.modules.ts
  core/
    config/        define-config.ts · config.registry.ts · app.config.ts · env-example.ts · index.ts
    errors/        app-error.ts · error-codes.ts · problem-details.filter.ts · index.ts
    context/       context.keys.ts · request-context.ts · context.module.ts · index.ts
    logging/       logging.config.ts · logging.module.ts · index.ts
    database/      database.config.ts · entities.ts · database.module.ts · unit-of-work.ts
                   mikro-orm-unit-of-work.ts · tx-em.ts · org-scope.ts · migrator.ts · index.ts
    queue/         queue.config.ts · job-definition.ts · job-handler.decorator.ts · job-context.ts
                   job-queue.ts · bullmq-job-queue.ts · worker-host.ts · queue.module.ts · index.ts
    outbox/        outbox.config.ts · outbox.entity.ts · outbox-writer.ts · outbox-relay.ts
                   inbox.ts · outbox-cleanup.job.ts · outbox.module.ts · index.ts
    events/        event-definition.ts · envelope.ts · subscriber.decorator.ts · event-dispatch.jobs.ts
                   events.module.ts · index.ts
    scheduler/     scheduler.config.ts · cron-definition.ts · static-scheduler.ts
                   scheduled-task.entity.ts · scheduled-task.service.ts · scheduler.module.ts · index.ts
    http/          http.config.ts · http-bootstrap.ts · pagination.ts · cursor.ts
                   idempotency.interceptor.ts · idempotency.decorator.ts
                   redis-throttler.storage.ts · openapi.ts · http.module.ts · index.ts
    redis/         redis.config.ts · redis.module.ts · index.ts
    cache/         cache.config.ts · cache.service.ts · cache.module.ts · index.ts
    resilience/    resilience.config.ts · policies.ts · http-client.ts · resilience.module.ts · index.ts
    security/      security.config.ts · field-cipher.ts · security.module.ts · index.ts
    observability/ otel.config.ts · trace-propagation.ts · metrics.ts · index.ts
    health/        health.config.ts · draining.ts · health.controller.ts · shutdown.ts · health.module.ts · index.ts
db/migrations/core/                  migration của core (tạo bằng CLI)
docker/images.env                    image + digest dùng chung cho compose và test
docker/postgres/init/01-roles.sh     tạo 3 DB role
compose.yaml · Dockerfile · .dockerignore · .swcrc · vitest.config.ts · .dependency-cruiser.cjs
test/
  support/ infra.global-setup.ts · infra.ts · app-factory.ts
  fixtures/ fixture.module.ts · fixture.entity.ts · fixture.events.ts · fixture.controller.ts · migrations/
  unit/ …   integration/ …   e2e/ …   chaos/ …   architecture/ …
docs/adr/  0001…0014
.github/workflows/ ci.yml · release.yml · nightly.yml
renovate.json
scripts/  gen-env-example.ts · export-openapi.ts
```

---

### Task 1: Scaffold bằng CLI + spike build (S1, S2, S3, S6)

**Files:**
- Create (bằng CLI): toàn bộ khung do `nest new` sinh ra
- Create (viết tay, không có generator): `.swcrc`, `vitest.config.ts`, `test/unit/di-metadata.spec.ts`, `docs/adr/0013-build-toolchain.md`
- Modify: `nest-cli.json`, `package.json` (scripts), `tsconfig.json`

**Interfaces:**
- Consumes: không có
- Produces: các script `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:int`, `pnpm lint`, `pnpm start:dev`. ESM + SWC hoạt động. Vitest chạy được test có DI.

- [ ] **Step 1: Kiểm tra công cụ trên máy**

Run:
```bash
node --version
corepack --version
pnpm view @nestjs/cli dist-tags
pnpm view typescript dist-tags
pnpm view @typescript/typescript6 dist-tags
```
Expected: Node thuộc dòng 24 LTS (xem cột `lts` ở `https://nodejs.org/dist/index.json`). Nếu không phải thì dừng lại, báo Sếp cài Node 24 LTS. Ghi output của 3 lệnh `pnpm view` vào nháp ADR 0013.

- [ ] **Step 2: Đọc flag của `nest new`**

Run: `pnpm dlx @nestjs/cli@latest new --help`
Expected: có các flag cho package manager, strict, bỏ qua git, và lựa chọn ESM/CommonJS. Ghi tên flag thật vào ADR 0013. Không dùng flag nào không có trong output này.

- [ ] **Step 3: Tạo project**

Repo đã có `.git` và `docs/`. Nếu `nest new` không cho sinh vào thư mục không rỗng thì sinh vào thư mục tạm cùng cấp rồi chuyển vào:
```bash
cd D:/
pnpm dlx @nestjs/cli@latest new backend-demo-scaffold <flag pnpm> <flag strict> <flag bỏ git>
# Chọn ESM khi được hỏi
cp -rn backend-demo-scaffold/. backend-demo/
rm -rf backend-demo-scaffold
cd D:/backend-demo
pnpm config set save-exact true --location project
pnpm install
```
Expected: `pnpm start` khởi động, `curl http://localhost:3000` trả `Hello World!`.

- [ ] **Step 4: Chuyển builder sang SWC (S1)**

Run: `pnpm view @swc/core dist-tags && pnpm add -D @swc/cli @swc/core`

Sửa `nest-cli.json` (file do CLI sinh), trong `compilerOptions` thêm:
```json
"builder": "swc",
"typeCheck": false
```
Tạo `.swcrc` (SWC không có generator):
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
Verify: đối chiếu các key trên với `https://swc.rs/docs/configuration/compilation` và `https://docs.nestjs.com/recipes/swc`. Key nào không có trong tài liệu thì bỏ.

Run: `pnpm build && node dist/main.js`
Expected: app khởi động, `curl localhost:3000` trả `Hello World!`. Nếu lỗi resolve module ESM thì thử chuyển sang CommonJS (`module.type: commonjs`, tạo lại project với lựa chọn CommonJS), ghi lý do vào ADR 0013 và báo Sếp trước khi đi tiếp.

- [ ] **Step 5: TS 7 để type-check, TS 6 cho tool cần API (S2)**

Run: `pnpm list typescript`
- Nếu `typescript` đang là 7.x: chạy `pnpm add -D typescript@npm:@typescript/typescript6` (dùng package ở Step 1 nếu có), còn không thì `pnpm add -D typescript@6`. Ghi ngoại lệ version vào ADR 0013 kèm lý do: TS 7 chưa có compiler API cho các tool.
- Cài TS 7 dưới tên alias: `pnpm add -D ts7@npm:typescript@latest`

Trong `package.json` thêm script:
```json
"typecheck": "node node_modules/ts7/bin/tsc --noEmit -p tsconfig.json"
```
Sửa `tsconfig.json` theo breaking change của TS 7: bỏ `baseUrl`, dùng `"module": "nodenext"`, `"moduleResolution": "nodenext"`, và giữ `"experimentalDecorators": true`, `"emitDecoratorMetadata": true`, `"strict": true`, `"noUncheckedIndexedAccess": true`.

Run: `pnpm typecheck && pnpm build`
Expected: cả hai lệnh thành công.

- [ ] **Step 6: Thay Jest bằng Vitest**

Run:
```bash
pnpm view vitest dist-tags && pnpm view unplugin-swc dist-tags peerDependencies
pnpm remove jest ts-jest @types/jest @nestjs/testing
pnpm add -D vitest unplugin-swc @vitest/coverage-v8 @nestjs/testing supertest @types/supertest
```
Xoá khối `jest` trong `package.json`, `test/jest-e2e.json` và các spec mẫu do CLI sinh.

Tạo `vitest.config.ts`:
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
Verify: key `projects` đúng với tài liệu Vitest version latest (`https://vitest.dev/guide/projects`). `testTimeout`/`hookTimeout` là tham số của bộ test, không phải config của app.

Script trong `package.json`:
```json
"test": "vitest run --project unit",
"test:int": "vitest run --project integration",
"test:watch": "vitest --project unit"
```

- [ ] **Step 7: Viết test DI metadata (S3), chạy để thấy nó chạy**

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
Expected: PASS. Nếu `dep` là `undefined` tức là metadata không được emit: kiểm tra lại `decoratorMetadata` trong `.swcrc` và cấu hình `swc.vite`.

- [ ] **Step 8: Lint và format**

Run:
```bash
pnpm list eslint oxlint prettier
pnpm view oxlint dist-tags
```
Nếu CLI đã sinh ESLint thì gỡ ESLint cùng các plugin của nó (`pnpm remove eslint …`, theo đúng tên trong `package.json`) và xoá file config ESLint. Sau đó:
```bash
pnpm add -D oxlint
pnpm oxlint --init
```
Script:
```json
"lint": "oxlint && prettier --check .",
"format": "prettier --write ."
```
Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 9: Đo baseline (S6) và viết ADR 0013**

Run (bash):
```bash
time pnpm build
time pnpm typecheck
node -e "const t=Date.now();import('./dist/main.js').then(()=>console.log('import ms',Date.now()-t))"
```
Tạo `docs/adr/0013-build-toolchain.md` theo mẫu MADR:
```markdown
# 0013. Chuỗi công cụ build

- Trạng thái: Chấp nhận
- Ngày: <ngày chạy>

## Bối cảnh
TS 7 (native) chưa có compiler API. Nest CLI build bằng SWC, và chúng ta cần type-check nhanh.

## Quyết định
- Biên dịch: SWC qua `nest build` (builder swc), xuất ESM.
- Type-check: TypeScript 7 cài dưới alias `ts7`. Package `typescript` giữ dòng 6 cho các tool cần API.
- Test: Vitest + unplugin-swc. Lint: oxlint. Package manager: pnpm, save-exact.

## Bằng chứng
<dán output của Step 1, 2, 5 và số đo ở Step 9>

## Hệ quả
Không dùng được plugin Swagger của Nest CLI (cần TS API). OpenAPI sinh từ schema zod.
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold nest project with swc, ts7 typecheck, vitest, oxlint"
```

---

### Task 2: Hạ tầng dev và test (Compose, 3 DB role, Testcontainers)

**Files:**
- Create: `docker/images.env`, `docker/postgres/init/01-roles.sh`, `compose.yaml`, `test/support/infra.global-setup.ts`, `test/support/infra.ts`, `test/integration/infra/roles.spec.ts`, `.env.example` (tạm, Task 3 sẽ sinh tự động)

**Interfaces:**
- Consumes: script test của Task 1
- Produces:
  - `test/support/infra.ts`: `getInfra(): { pg: { host: string; port: number; database: string; owner: Creds; app: Creds; admin: Creds }; redis: { url: string } }` với `type Creds = { user: string; password: string }`
  - `docker/images.env`: `IMAGE_POSTGRES`, `IMAGE_REDIS`, `IMAGE_PGBOUNCER`

- [ ] **Step 1: Lấy tag và digest image bằng lệnh**

Run:
```bash
curl -s "https://hub.docker.com/v2/repositories/library/postgres/tags?page_size=50&ordering=last_updated" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).results.map(t=>t.name).filter(n=>/^\d+(\.\d+)?$/.test(n)).join(' ')))"
curl -s "https://hub.docker.com/v2/repositories/library/redis/tags?page_size=50&ordering=last_updated" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).results.map(t=>t.name).filter(n=>/^\d+\.\d+\.\d+$/.test(n)).join(' ')))"
```
Chọn tag có số version cao nhất trong output. Lấy digest:
```bash
docker buildx imagetools inspect postgres:<tag cao nhất> --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect redis:<tag cao nhất> --format '{{json .Manifest.Digest}}'
```
PgBouncer không có image chính thức. Đọc README của các image cộng đồng còn được cập nhật (ví dụ `edoburu/pgbouncer`), chọn một image, lấy digest cùng cách, và ghi lý do vào `docs/adr/0006-queue-outbox.md` ở Task 10 (mục phụ thuộc hạ tầng).

Tạo `docker/images.env` từ output của các lệnh trên:
```
IMAGE_POSTGRES=postgres:<tag>@sha256:<digest từ lệnh>
IMAGE_REDIS=redis:<tag>@sha256:<digest từ lệnh>
IMAGE_PGBOUNCER=<image>:<tag>@sha256:<digest từ lệnh>
```

- [ ] **Step 2: Script tạo 3 DB role**

`docker/postgres/init/01-roles.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${APP_OWNER_PASSWORD:?required}" "${APP_USER_PASSWORD:?required}" "${APP_ADMIN_PASSWORD:?required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$APP_OWNER_PASSWORD" -v user_pw="$APP_USER_PASSWORD" -v admin_pw="$APP_ADMIN_PASSWORD" \
  -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE;
CREATE ROLE app_user  LOGIN PASSWORD :'user_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE app_admin LOGIN PASSWORD :'admin_pw' NOSUPERUSER BYPASSRLS NOCREATEROLE;
GRANT CONNECT ON DATABASE :"db" TO app_owner, app_user, app_admin;
GRANT ALL ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user, app_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, app_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, app_admin;
SQL
```

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
      APP_ADMIN_PASSWORD: ${DB_ADMIN_PASSWORD}
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - pgdata:/var/lib/postgresql
    ports: ["${DB_PORT_HOST}:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      retries: 20
  redis:
    image: ${IMAGE_REDIS}
    ports: ["${REDIS_PORT_HOST}:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 20
  pgbouncer:
    image: ${IMAGE_PGBOUNCER}
    depends_on: { postgres: { condition: service_healthy } }
    ports: ["${PGBOUNCER_PORT_HOST}:5432"]
    environment: {}
volumes:
  pgdata: {}
```
Verify: đọc README của image PgBouncer đã chọn, điền các biến môi trường bắt buộc vào `environment`: kết nối tới `postgres`, `POOL_MODE=transaction`, kiểu auth tương thích SCRAM. Mọi giá trị lấy từ biến `${…}` trong `.env`, không viết literal. Verify đường dẫn volume data đúng với major version của Postgres đã chọn (README image chính thức).

Tạo `.env.example` tạm (Task 3 sẽ sinh tự động và ghi đè):
```
DB_NAME=app
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=
DB_OWNER_PASSWORD=
DB_APP_PASSWORD=
DB_ADMIN_PASSWORD=
DB_PORT_HOST=5432
REDIS_PORT_HOST=6379
PGBOUNCER_PORT_HOST=6432
```
Run: `cp .env.example .env`, điền mật khẩu, rồi `docker compose --env-file docker/images.env --env-file .env up -d && docker compose ps`
Expected: 3 service `healthy`/`running`.

- [ ] **Step 4: Test role đúng quyền (viết test trước)**

```bash
pnpm view @testcontainers/postgresql dist-tags && pnpm view @testcontainers/redis dist-tags
pnpm add -D @testcontainers/postgresql @testcontainers/redis testcontainers pg @types/pg
```
`test/integration/infra/roles.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../support/infra.js';

describe('database roles', () => {
  let client: pg.Client;
  beforeAll(async () => {
    const { pg: db } = getInfra();
    client = new pg.Client({ host: db.host, port: db.port, database: db.database, user: db.app.user, password: db.app.password });
    await client.connect();
  });
  afterAll(async () => client.end());

  it('app_user is not superuser and cannot bypass RLS', async () => {
    const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('app_user cannot create tables', async () => {
    await expect(client.query('CREATE TABLE t_forbidden (id int)')).rejects.toThrow(/permission denied/);
  });
});
```
Run: `pnpm test:int`
Expected: FAIL, vì chưa có `test/support/infra.ts`.

- [ ] **Step 5: Global setup của Testcontainers**

`test/support/infra.ts`:
```ts
import { inject } from 'vitest';

export type Creds = { user: string; password: string };
export type Infra = {
  pg: { host: string; port: number; database: string; owner: Creds; app: Creds; admin: Creds };
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
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

function readImages(): Record<string, string> {
  const text = readFileSync(resolve('docker/images.env'), 'utf8');
  return Object.fromEntries(
    text.split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

const secret = () => randomBytes(18).toString('base64url');
let pgC: StartedPostgreSqlContainer | undefined;
let redisC: StartedRedisContainer | undefined;

export async function setup(project: TestProject) {
  const images = readImages();
  const owner = { user: 'app_owner', password: secret() };
  const app = { user: 'app_user', password: secret() };
  const admin = { user: 'app_admin', password: secret() };
  pgC = await new PostgreSqlContainer(images.IMAGE_POSTGRES!)
    .withEnvironment({ APP_OWNER_PASSWORD: owner.password, APP_USER_PASSWORD: app.password, APP_ADMIN_PASSWORD: admin.password })
    .withCopyDirectoriesToContainer([{ source: resolve('docker/postgres/init'), target: '/docker-entrypoint-initdb.d' }])
    .start();
  redisC = await new RedisContainer(images.IMAGE_REDIS!).start();
  project.provide('infra', {
    pg: { host: pgC.getHost(), port: pgC.getPort(), database: pgC.getDatabase(), owner, app, admin },
    redis: { url: redisC.getConnectionUrl() },
  });
}

export async function teardown() {
  await redisC?.stop();
  await pgC?.stop();
}
```
Verify: tên method `withCopyDirectoriesToContainer`, `getConnectionUrl`, `getDatabase` và cách container Postgres chạy script trong `/docker-entrypoint-initdb.d` (quyền thực thi của file `.sh`) theo tài liệu Testcontainers Node version latest (`https://node.testcontainers.org/modules/postgresql/`). Nếu file `.sh` cần quyền thực thi thì chạy `git update-index --chmod=+x docker/postgres/init/01-roles.sh`.

Run: `pnpm test:int`
Expected: PASS cả 2 test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(infra): compose with pinned images, db roles, testcontainers setup"
```

---

### Task 3: `core/config` — config schema, fail-fast, sinh `.env.example`

**Files:**
- Create: `src/core/config/define-config.ts`, `src/core/config/config.registry.ts`, `src/core/config/app.config.ts`, `src/core/config/env-example.ts`, `src/core/config/index.ts`, `scripts/gen-env-example.ts`
- Test: `test/unit/core/config/define-config.spec.ts`, `test/unit/core/config/env-example.spec.ts`

**Interfaces:**
- Consumes: không có
- Produces:
  - `defineConfig<S extends z.ZodObject>(namespace: string, env: { [K in keyof z.infer<S>]: string }, schema: S)`: trả về kết quả của `registerAs` (có `.KEY`), đồng thời đăng ký vào registry.
  - `type ConfigOf<T> = ConfigType<T>` (re-export từ `@nestjs/config`)
  - `ConfigValidationError extends Error` có `issues: { env: string; message: string }[]`
  - `configRegistry(): readonly ConfigEntry[]`, `renderEnvExample(entries): string`
  - `appConfig` (namespace `app`): `{ role: 'api' | 'worker' | 'migrate'; nodeEnv: 'development' | 'test' | 'production'; serviceName: string }`

- [ ] **Step 1: Viết test trước**

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

  it('reports every invalid env var by name', () => {
    vi.stubEnv('T2_PORT', '-1');
    const cfg = defineConfig('t2', { port: 'T2_PORT', secret: 'T2_SECRET' }, schema);
    try {
      cfg();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).issues.map((i) => i.env).sort()).toEqual(['T2_PORT', 'T2_SECRET']);
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
  it('prints defaults, marks required secrets empty, includes descriptions', () => {
    const out = renderEnvExample([
      {
        namespace: 'x',
        env: { port: 'X_PORT', secret: 'X_SECRET' },
        schema: z.object({ port: z.coerce.number().default(8080).describe('Port'), secret: z.string().describe('Secret') }),
      },
    ]);
    expect(out).toContain('# [x] Port\nX_PORT=8080');
    expect(out).toContain('# [x] Secret (required)\nX_SECRET=');
  });
});
```
Run: `pnpm test`
Expected: FAIL, vì module chưa tồn tại.

- [ ] **Step 2: Cài đặt**

`src/core/config/config.registry.ts`:
```ts
import type { z } from 'zod';

import type { ConfigFactory } from '@nestjs/config';

export type ConfigEntry = { namespace: string; env: Record<string, string>; schema: z.ZodObject; factory?: ConfigFactory };
const entries = new Map<string, ConfigEntry>();

export function registerConfigEntry(entry: ConfigEntry): void {
  if (entries.has(entry.namespace)) throw new Error(`Config namespace "${entry.namespace}" already registered`);
  entries.set(entry.namespace, entry);
}

export function configRegistry(): readonly ConfigEntry[] {
  return [...entries.values()];
}

export function configFactories(): ConfigFactory[] {
  return [...entries.values()].flatMap((e) => (e.factory ? [e.factory] : []));
}
```
`src/core/config/define-config.ts`:
```ts
import { registerAs } from '@nestjs/config';
import type { z } from 'zod';
import { registerConfigEntry } from './config.registry.js';

export class ConfigValidationError extends Error {
  constructor(
    readonly namespace: string,
    readonly issues: { env: string; message: string }[],
  ) {
    super(`Invalid config "${namespace}": ${issues.map((i) => `${i.env}: ${i.message}`).join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function defineConfig<S extends z.ZodObject>(
  namespace: string,
  env: { [K in keyof z.infer<S>]: string },
  schema: S,
) {
  const factory = registerAs(namespace, (): z.infer<S> => {
    const raw = Object.fromEntries(Object.entries(env).map(([key, name]) => [key, process.env[name as string]]));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => {
        const key = String(issue.path[0]);
        return { env: (env as Record<string, string>)[key] ?? key, message: issue.message };
      });
      throw new ConfigValidationError(namespace, issues);
    }
    return parsed.data;
  });
  registerConfigEntry({ namespace, env: env as Record<string, string>, schema, factory });
  return factory;
}
```
`src/core/config/env-example.ts`:
```ts
import type { ConfigEntry } from './config.registry.js';

export function renderEnvExample(entries: readonly ConfigEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    for (const [key, envName] of Object.entries(entry.env)) {
      const field = entry.schema.shape[key] as { description?: string; safeParse(v: unknown): { success: boolean; data?: unknown } };
      const probe = field.safeParse(undefined);
      const hasDefault = probe.success && probe.data !== undefined;
      const description = field.description ?? key;
      lines.push(`# [${entry.namespace}] ${description}${hasDefault ? '' : ' (required)'}`);
      lines.push(`${envName}=${hasDefault ? String(probe.data) : ''}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
```
Verify: trong zod 4, `.describe()` có đặt thuộc tính `description` trên schema không. Nếu không thì dùng API metadata mà tài liệu zod 4 ghi (`https://zod.dev/metadata`) và sửa lại cả hai chỗ.

`src/core/config/app.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from './define-config.js';

export const appConfig = defineConfig(
  'app',
  { role: 'APP_ROLE', nodeEnv: 'NODE_ENV', serviceName: 'OTEL_SERVICE_NAME' },
  z.object({
    role: z.enum(['api', 'worker', 'migrate']).describe('Process role, set by the entrypoint'),
    nodeEnv: z.enum(['development', 'test', 'production']).default('development').describe('Runtime environment'),
    serviceName: z.string().min(1).default('backend-demo').describe('Service name used in logs and traces'),
  }),
);
```
`src/core/config/index.ts`:
```ts
export { defineConfig, ConfigValidationError } from './define-config.js';
export { configRegistry, configFactories, type ConfigEntry } from './config.registry.js';
export { renderEnvExample } from './env-example.js';
export { appConfig } from './app.config.js';
export type { ConfigType as ConfigOf } from '@nestjs/config';
```
`scripts/gen-env-example.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { configRegistry, renderEnvExample } from '../src/core/config/index.js';
import '../src/core/config/all-configs.js';

writeFileSync('.env.example', renderEnvExample(configRegistry()));
```
Tạo `src/core/config/all-configs.ts`, file import mọi file `*.config.ts` để registry có đủ. Mỗi task sau khi thêm config thì thêm một dòng import vào đây:
```ts
import './app.config.js';
```
Script trong `package.json`: `"env:example": "node --import @swc-node/register/esm-register scripts/gen-env-example.ts"`

Verify: chọn cách chạy TS trực tiếp đơn giản nhất mà Node 24 hỗ trợ. Ưu tiên `node scripts/gen-env-example.ts` nếu Node 24 hỗ trợ type stripping không cần flag (xem `https://nodejs.org/api/typescript.html`). Nhưng type stripping không chạy decorator, nên script này chỉ được import các file config (không có decorator). Nếu không được thì cài loader bằng `pnpm add -D @swc-node/register`. Ghi lựa chọn vào ADR 0013.

Run: `pnpm test && pnpm env:example && head -20 .env.example`
Expected: PASS. `.env.example` có `APP_ROLE=` được đánh dấu `(required)`.

Giữ phần biến của compose (DB_PORT_HOST…) trong một file config riêng `src/core/config/dev-infra.config.ts` với namespace `devInfra`, để `.env.example` sinh ra vẫn đủ biến cho compose:
```ts
import { z } from 'zod';
import { defineConfig } from './define-config.js';

export const devInfraConfig = defineConfig(
  'devInfra',
  {
    dbName: 'DB_NAME',
    superuser: 'POSTGRES_SUPERUSER',
    superuserPassword: 'POSTGRES_SUPERUSER_PASSWORD',
    dbPortHost: 'DB_PORT_HOST',
    redisPortHost: 'REDIS_PORT_HOST',
    pgbouncerPortHost: 'PGBOUNCER_PORT_HOST',
  },
  z.object({
    dbName: z.string().default('app').describe('Database name for local compose'),
    superuser: z.string().default('postgres').describe('Postgres superuser for local compose only'),
    superuserPassword: z.string().optional().describe('Postgres superuser password for local compose only'),
    dbPortHost: z.coerce.number().int().default(5432).describe('Host port for Postgres in compose'),
    redisPortHost: z.coerce.number().int().default(6379).describe('Host port for Redis in compose'),
    pgbouncerPortHost: z.coerce.number().int().default(6432).describe('Host port for PgBouncer in compose'),
  }),
);
```
Thêm `import './dev-infra.config.js';` vào `all-configs.ts`, rồi chạy lại `pnpm env:example`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): typed config with fail-fast validation and generated env example"
```

---

### Task 4: `core/errors` + `core/context` + `core/logging`

**Files:**
- Create: `src/core/errors/{error-codes.ts,app-error.ts,error-mappers.ts,zod-issues.ts,errors.config.ts,problem-details.filter.ts,index.ts}`, `src/core/context/{context.keys.ts,request-context.ts,context.module.ts,index.ts}`, `src/core/logging/{logging.config.ts,logging.module.ts,index.ts}`
- Test: `test/unit/core/errors/error-codes.spec.ts`, `test/unit/core/errors/zod-issues.spec.ts`, `test/unit/core/errors/problem-details.filter.spec.ts`, `test/e2e/core/errors-and-context.e2e.spec.ts`, `test/support/env.ts`, `test/support/app-factory.ts`

**Interfaces:**
- Consumes: `defineConfig`, `configFactories`, `appConfig`
- Produces:
  - `type ErrorCode = { readonly code: string; readonly status: number; readonly title: string }`
  - `defineErrorCodes<K extends string>(codes: Record<K, { status: HttpStatus; title: string }>): Record<K, ErrorCode>`: `code` = key viết thường (`EMAIL_TAKEN` → `email_taken`), trùng mã giữa các module thì ném lỗi. `allErrorCodes(): readonly ErrorCode[]`
  - `CoreErrors`: đủ các mã trong bảng ở spec cha, mục 3.2: `MALFORMED_REQUEST`, `VALIDATION_FAILED`, `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REQUIRED`, `ORG_CONTEXT_INVALID`, `UNAUTHENTICATED`, `FORBIDDEN`, `FEATURE_NOT_IN_PLAN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_PREVIOUS_FAILED`, `PRECONDITION_FAILED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `IDEMPOTENCY_KEY_REUSED`, `QUOTA_EXCEEDED`, `PRECONDITION_REQUIRED`, `RATE_LIMITED`, `INTERNAL_ERROR`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE`, `UPSTREAM_TIMEOUT`
  - `type FieldError = { path: string; code: string; message: string }`
  - `class AppError extends Error { constructor(error: ErrorCode, opts?: { detail?: string; fields?: FieldError[]; headers?: Record<string, string>; cause?: unknown }) }`
  - `registerErrorMapper(mapper: (err: unknown) => AppError | undefined): void`, `mapKnownError(err: unknown): AppError | undefined`
  - `zodIssuesToFields(issues: readonly ZodIssueLike[]): FieldError[]`
  - `ProblemDetailsFilter` (global): body `{ type, title, status, code, detail?, instance, requestId, timestamp, errors? }`, content type `application/problem+json`, header lấy từ `AppError.opts.headers`
  - `RequestContext`: `requestId()`, `traceId()`, `traceparent()`, `path()`, `orgId()`, `setOrgId(id)`, `run(values, fn)`
  - `ContextModule`, `LoggingModule`
  - `test/support/app-factory.ts`: `createTestApp(imports, opts?: { http?: boolean; beforeInit?: (app) => void })`

- [ ] **Step 1: Cài package và viết test trước**

```bash
for p in nestjs-cls nestjs-pino pino-http pino; do pnpm view $p dist-tags peerDependencies; done
pnpm view uuid dist-tags && pnpm add nestjs-cls nestjs-pino pino-http pino uuid
```
`test/unit/core/errors/error-codes.spec.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CoreErrors, allErrorCodes, defineErrorCodes } from '../../../../src/core/errors/index.js';

describe('error code registry', () => {
  it('derives lowercase snake_case codes from keys', () => {
    expect(CoreErrors.VALIDATION_FAILED).toEqual({ code: 'validation_failed', status: 422, title: 'Validation failed' });
    expect(CoreErrors.MALFORMED_REQUEST.status).toBe(400);
  });
  it('rejects a code that is already defined by another module', () => {
    expect(() => defineErrorCodes({ NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'dup' } })).toThrow(/already defined/);
  });
  it('rejects keys that are not UPPER_SNAKE', () => {
    expect(() => defineErrorCodes({ badKey: { status: HttpStatus.BAD_REQUEST, title: 'x' } } as never)).toThrow(/UPPER_SNAKE/);
  });
  it('rejects non-error statuses', () => {
    expect(() => defineErrorCodes({ WEIRD_OK: { status: HttpStatus.OK, title: 'x' } })).toThrow(/4xx or 5xx/);
  });
  it('every core code has a unique code string', () => {
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

const schema = z.object({
  email: z.email(),
  age: z.number().int().min(18),
  items: z.array(z.object({ quantity: z.number().positive() })),
});

describe('zodIssuesToFields', () => {
  it('uses dot paths with array indices and stable codes', () => {
    const r = schema.safeParse({ email: 'nope', age: 10, items: [{ quantity: 1 }, { quantity: -1 }] });
    expect(r.success).toBe(false);
    const fields = zodIssuesToFields(r.error!.issues);
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'email', code: 'invalid_email' }),
      expect.objectContaining({ path: 'age', code: 'too_small' }),
      expect.objectContaining({ path: 'items.1.quantity', code: 'too_small' }),
    ]));
    for (const f of fields) expect(f.message.length).toBeGreaterThan(0);
  });
  it('root-level issues get an empty path', () => {
    const r = z.string().safeParse(1);
    expect(zodIssuesToFields(r.error!.issues)[0]).toMatchObject({ path: '', code: 'invalid_type' });
  });
});
```
Verify: mã issue của zod 4 (`invalid_format` có thuộc tính `format`, `too_small`, `invalid_type`…) theo `https://zod.dev/packages/core#issue-types` hoặc trang tương ứng của version đã cài.

`test/unit/core/errors/problem-details.filter.spec.ts`:
```ts
import { ArgumentsHost, HttpException, HttpStatus, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, CoreErrors, ProblemDetailsFilter, registerErrorMapper } from '../../../../src/core/errors/index.js';

type Res = { status: ReturnType<typeof vi.fn>; type: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> };
function res(): Res {
  const r = { status: vi.fn(), type: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  r.status.mockReturnValue(r); r.type.mockReturnValue(r);
  return r;
}
const host = (r: Res) => ({ switchToHttp: () => ({ getResponse: () => r, getRequest: () => ({ originalUrl: '/api/v1/users?x=1' }) }) }) as unknown as ArgumentsHost;
const ctx = { requestId: () => '019dd1a5-9235-70db-8d57-54ef901d8185' };
const cfg = { problemTypeBase: '/errors' };
const logger = { error: vi.fn(), warn: vi.fn() };
const body = (r: Res) => r.json.mock.calls[0]![0] as Record<string, unknown>;

describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter(ctx as never, cfg as never, logger as never);
  afterEach(() => vi.clearAllMocks());

  it('renders the agreed RFC 9457 shape for AppError', () => {
    const r = res();
    filter.catch(new AppError(CoreErrors.VALIDATION_FAILED, {
      detail: 'One or more fields did not pass validation.',
      fields: [{ path: 'email', code: 'invalid_email', message: 'email must be an email' }],
    }), host(r));
    expect(r.status).toHaveBeenCalledWith(422);
    expect(r.type).toHaveBeenCalledWith('application/problem+json');
    const b = body(r);
    expect(b).toMatchObject({
      type: '/errors/validation-failed', title: 'Validation failed', status: 422, code: 'validation_failed',
      detail: 'One or more fields did not pass validation.', instance: '/api/v1/users',
      requestId: '019dd1a5-9235-70db-8d57-54ef901d8185',
      errors: [{ path: 'email', code: 'invalid_email', message: 'email must be an email' }],
    });
    expect(new Date(b.timestamp as string).toISOString()).toBe(b.timestamp);
  });

  it('omits errors when there are no field errors', () => {
    const r = res();
    filter.catch(new AppError(CoreErrors.NOT_FOUND), host(r));
    expect(body(r)).not.toHaveProperty('errors');
  });

  it('sets headers carried by AppError (e.g. Retry-After)', () => {
    const r = res();
    filter.catch(new AppError(CoreErrors.SERVICE_UNAVAILABLE, { headers: { 'Retry-After': '5' } }), host(r));
    expect(r.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('maps Nest HttpExceptions to core codes', () => {
    const cases: [HttpException, string][] = [
      [new NotFoundException(), 'not_found'],
      [new PayloadTooLargeException(), 'payload_too_large'],
      [new HttpException('x', HttpStatus.TOO_MANY_REQUESTS), 'rate_limited'],
      [new HttpException('x', HttpStatus.UNAUTHORIZED), 'unauthenticated'],
      [new HttpException('x', HttpStatus.FORBIDDEN), 'forbidden'],
      [new HttpException('x', HttpStatus.BAD_REQUEST), 'malformed_request'],
    ];
    for (const [ex, code] of cases) {
      const r = res();
      filter.catch(ex, host(r));
      expect(body(r).code).toBe(code);
    }
  });

  it('maps body-parser errors', () => {
    const r1 = res();
    filter.catch(Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 }), host(r1));
    expect(body(r1).code).toBe('malformed_request');
    const r2 = res();
    filter.catch(Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 }), host(r2));
    expect(body(r2).code).toBe('payload_too_large');
  });

  it('uses registered mappers before falling back to 500', () => {
    class DriverError extends Error {}
    registerErrorMapper((e) => (e instanceof DriverError ? new AppError(CoreErrors.CONFLICT) : undefined));
    const r = res();
    filter.catch(new DriverError('duplicate key value violates unique constraint "users_email_uq"'), host(r));
    expect(body(r)).toMatchObject({ status: 409, code: 'conflict' });
    expect(JSON.stringify(body(r))).not.toContain('users_email_uq');
  });

  it('hides unknown errors, logs them, returns internal_error', () => {
    const r = res();
    filter.catch(new Error('db password leaked in message'), host(r));
    expect(r.status).toHaveBeenCalledWith(500);
    expect(body(r)).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(body(r))).not.toContain('password');
    expect(logger.error).toHaveBeenCalled();
  });
});
```
Run: `pnpm test`
Expected: FAIL, vì module chưa tồn tại.

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
Thêm import vào `all-configs.ts`.

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
  for (const [key, def] of Object.entries(codes) as [K, { status: HttpStatus; title: string }][]) {
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

export const CoreErrors = defineErrorCodes({
  MALFORMED_REQUEST: { status: HttpStatus.BAD_REQUEST, title: 'Malformed request' },
  INVALID_CURSOR: { status: HttpStatus.BAD_REQUEST, title: 'Invalid cursor' },
  IDEMPOTENCY_KEY_REQUIRED: { status: HttpStatus.BAD_REQUEST, title: 'Idempotency-Key header is required' },
  ORG_CONTEXT_INVALID: { status: HttpStatus.BAD_REQUEST, title: 'Organization context is missing or invalid' },
  UNAUTHENTICATED: { status: HttpStatus.UNAUTHORIZED, title: 'Authentication required' },
  FORBIDDEN: { status: HttpStatus.FORBIDDEN, title: 'Forbidden' },
  FEATURE_NOT_IN_PLAN: { status: HttpStatus.FORBIDDEN, title: 'Feature is not included in your plan' },
  NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'Not found' },
  METHOD_NOT_ALLOWED: { status: HttpStatus.METHOD_NOT_ALLOWED, title: 'Method not allowed' },
  CONFLICT: { status: HttpStatus.CONFLICT, title: 'Conflict' },
  IDEMPOTENCY_CONFLICT: { status: HttpStatus.CONFLICT, title: 'A request with this Idempotency-Key is still in progress' },
  IDEMPOTENCY_PREVIOUS_FAILED: { status: HttpStatus.CONFLICT, title: 'The previous request with this Idempotency-Key failed' },
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
Verify: tên `HttpStatus.UNPROCESSABLE_ENTITY`/`PRECONDITION_REQUIRED` trong enum của `@nestjs/common` version latest (có thể đã đổi tên theo RFC 9110 thành `UNPROCESSABLE_CONTENT`). Dùng đúng tên có trong enum.

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
import type { AppError } from './app-error.js';

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
```
`src/core/errors/zod-issues.ts`:
```ts
import type { FieldError } from './app-error.js';

export type ZodIssueLike = { code: string; path: readonly PropertyKey[]; message: string; format?: string };

export function zodIssuesToFields(issues: readonly ZodIssueLike[]): FieldError[] {
  return issues.map((i) => ({
    path: i.path.map(String).join('.'),
    code: i.code === 'invalid_format' && i.format ? `invalid_${i.format}` : i.code,
    message: i.message,
  }));
}
```
`src/core/errors/problem-details.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject, Logger } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/request-context.js';
import { AppError } from './app-error.js';
import { CoreErrors, type ErrorCode } from './error-codes.js';
import { mapKnownError } from './error-mappers.js';
import { errorsConfig } from './errors.config.js';

const PROBLEM_JSON = 'application/problem+json';
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

type HttpRes = { status(n: number): HttpRes; type(t: string): HttpRes; json(b: unknown): void; setHeader(k: string, v: string): void };

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    private readonly ctx: RequestContext,
    @Inject(errorsConfig.KEY) private readonly cfg: ConfigOf<typeof errorsConfig>,
    private readonly logger: Pick<Logger, 'error' | 'warn'> = new Logger(ProblemDetailsFilter.name),
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<HttpRes>();
    const req = http.getRequest<{ originalUrl: string }>();
    const err = this.normalize(exception);
    const { error, opts } = err;
    if (error.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ err: exception, requestId: this.ctx.requestId(), code: error.code }, 'request failed');
    }
    for (const [k, v] of Object.entries(opts.headers ?? {})) res.setHeader(k, v);
    const exposeDetail = error.status < HttpStatus.INTERNAL_SERVER_ERROR || exception instanceof AppError;
    res.status(error.status).type(PROBLEM_JSON).json({
      type: `${this.cfg.problemTypeBase}/${error.code.replaceAll('_', '-')}`,
      title: error.title,
      status: error.status,
      code: error.code,
      ...(exposeDetail && opts.detail ? { detail: opts.detail } : {}),
      instance: req.originalUrl.split('?')[0],
      requestId: this.ctx.requestId(),
      timestamp: new Date().toISOString(),
      ...(opts.fields?.length ? { errors: opts.fields } : {}),
    });
  }

  private normalize(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;
    const mapped = mapKnownError(exception);
    if (mapped) return mapped;
    if (exception instanceof HttpException) {
      const code = HTTP_STATUS_TO_CODE[exception.getStatus()] ?? CoreErrors.INTERNAL_ERROR;
      return new AppError(code, { cause: exception });
    }
    const bodyParserType = (exception as { type?: unknown } | null)?.type;
    if (typeof bodyParserType === 'string' && BODY_PARSER_TYPES[bodyParserType]) {
      return new AppError(BODY_PARSER_TYPES[bodyParserType]!, { cause: exception });
    }
    return new AppError(CoreErrors.INTERNAL_ERROR, { cause: exception });
  }
}
```
Tiêu đề và `detail` của lỗi 5xx do chính code của mình tạo (có `AppError`) thì được hiển thị. Lỗi 5xx chưa được map (exception lạ) thì không bao giờ hiển thị message gốc. `HttpException` có status không nằm trong bảng thì chuyển thành `internal_error`, và được log vì nó là 500. Như vậy mọi lỗi đi ra đều có một `code` nằm trong registry.

`src/core/errors/index.ts`:
```ts
export { AppError, type FieldError } from './app-error.js';
export { CoreErrors, allErrorCodes, defineErrorCodes, type ErrorCode } from './error-codes.js';
export { registerErrorMapper, mapKnownError, type ErrorMapper } from './error-mappers.js';
export { zodIssuesToFields, type ZodIssueLike } from './zod-issues.js';
export { ProblemDetailsFilter } from './problem-details.filter.js';
export { errorsConfig } from './errors.config.js';
```
Run: `pnpm test`
Expected: các test lỗi PASS (test filter cần `RequestContext` chỉ ở dạng mock).

- [ ] **Step 3: Cài đặt context**

Verify: API của `nestjs-cls` version latest (`ClsModule.forRoot({ global, middleware: { mount, generateId, idGenerator, setup } })`, `ClsService.get/set/run`), theo `https://papooch.github.io/nestjs-cls/`.

`src/core/context/context.keys.ts`:
```ts
export const CTX = {
  requestId: 'core.requestId',
  traceId: 'core.traceId',
  traceparent: 'core.traceparent',
  path: 'core.path',
  orgId: 'core.orgId',
  principal: 'core.principal',
  em: 'core.em',
} as const;

export type ContextValues = { requestId: string; traceId?: string; orgId?: string; principal?: unknown };
```
`src/core/context/request-context.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { v7 } from 'uuid';
import { CTX, type ContextValues } from './context.keys.js';

@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService) {}

  requestId(): string {
    return this.cls.isActive() ? (this.cls.get<string>(CTX.requestId) ?? 'none') : 'none';
  }
  traceId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string>(CTX.traceId) : undefined;
  }
  traceparent(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string>(CTX.traceparent) : undefined;
  }
  /** Path của request hiện tại, không kèm query string. Dùng cho `url` của danh sách. */
  path(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string>(CTX.path) : undefined;
  }
  orgId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string>(CTX.orgId) : undefined;
  }
  setOrgId(id: string): void {
    this.cls.set(CTX.orgId, id);
  }
  run<T>(values: Partial<ContextValues>, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set(CTX.requestId, values.requestId ?? v7());
      if (values.traceId) this.cls.set(CTX.traceId, values.traceId);
      if (values.orgId) this.cls.set(CTX.orgId, values.orgId);
      if (values.principal) this.cls.set(CTX.principal, values.principal);
      return fn();
    });
  }
}
```
`src/core/context/context.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { v7 } from 'uuid';
import { CTX } from './context.keys.js';
import { RequestContext } from './request-context.js';

const REQUEST_ID_HEADER = 'x-request-id';
/** Chỉ nhận request id an toàn để đưa vào log/response (chặn log injection và giá trị quá dài). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        setup: (cls, req: { headers: Record<string, string | undefined>; originalUrl: string }, res: { setHeader(k: string, v: string): void }) => {
          const incoming = req.headers[REQUEST_ID_HEADER];
          const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : v7();
          cls.set(CTX.requestId, requestId);
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
`src/core/context/index.ts`:
```ts
export { ContextModule } from './context.module.js';
export { RequestContext } from './request-context.js';
export { CTX, type ContextValues } from './context.keys.js';
```
(`traceId` được gắn ở Task 16 khi có OpenTelemetry.)

- [ ] **Step 4: Cài đặt logging**

Verify: option của `nestjs-pino` version latest (`LoggerModule.forRootAsync`, `pinoHttp.redact`, `customProps`, `genReqId`) theo README trên npm.

`src/core/logging/logging.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const loggingConfig = defineConfig(
  'logging',
  { level: 'LOG_LEVEL', redact: 'LOG_REDACT_PATHS', pretty: 'LOG_PRETTY' },
  z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info').describe('Minimum log level'),
    redact: z
      .string()
      .default('req.headers.authorization,req.headers.cookie,*.password,*.token,*.secret,*.apiKey')
      .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
      .describe('Comma-separated pino redact paths'),
    pretty: z.stringbool().default(false).describe('Human readable logs (local dev only)'),
  }),
);
```
Verify: `z.stringbool()` có trong zod 4 (`https://zod.dev/api#stringbool`). Nếu không có thì dùng `z.enum(['true','false']).transform(v => v === 'true')`.

`src/core/logging/logging.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import { CTX } from '../context/index.js';
import { type ConfigOf } from '../config/index.js';
import { loggingConfig } from './logging.config.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [loggingConfig.KEY, ClsService],
      useFactory: (cfg: ConfigOf<typeof loggingConfig>, cls: ClsService) => ({
        pinoHttp: {
          level: cfg.level,
          redact: { paths: cfg.redact, censor: '[REDACTED]' },
          transport: cfg.pretty ? { target: 'pino-pretty' } : undefined,
          customProps: () =>
            cls.isActive()
              ? { requestId: cls.get(CTX.requestId), traceId: cls.get(CTX.traceId), orgId: cls.get(CTX.orgId) }
              : {},
        },
      }),
    }),
  ],
})
export class LoggingModule {}
```
Nếu `pretty` = true thì cài `pnpm add -D pino-pretty`.

Thêm `import '../logging/logging.config.js';` vào `src/core/config/all-configs.ts`.

`src/core/logging/index.ts`:
```ts
export { LoggingModule } from './logging.module.js';
export { loggingConfig } from './logging.config.js';
```

- [ ] **Step 5: App factory cho test và test e2e**

`test/support/env.ts`: env nền cho mọi test tích hợp. Secret được **sinh ngẫu nhiên lúc chạy**, không phải hằng số. Test nào đã tự stub key nào thì key đó được giữ nguyên.
```ts
import { randomBytes } from 'node:crypto';

/** Mỗi task thêm config bắt buộc (không có default) thì thêm key vào đây. */
export function baseTestEnv(): Record<string, string> {
  return {
    APP_ROLE: 'api',
    NODE_ENV: 'test',
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
import { configFactories } from '../../src/core/config/index.js';
import { ContextModule } from '../../src/core/context/index.js';
import { ProblemDetailsFilter } from '../../src/core/errors/index.js';
import { baseTestEnv } from './env.js';

export type ModuleImport = Type<unknown> | DynamicModule;

export async function createTestApp(
  imports: ModuleImport[],
  opts: { http?: boolean; beforeInit?: (app: INestApplication) => void } = {},
): Promise<INestApplication> {
  for (const [k, v] of Object.entries(baseTestEnv())) if (process.env[k] === undefined) vi.stubEnv(k, v);
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: configFactories() }), ContextModule, ...imports],
    providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.enableShutdownHooks();
  opts.beforeInit?.(app);
  if (opts.http !== false) await app.init();
  return app;
}
```
Vì `load: configFactories()` nạp **mọi** config đã đăng ký, một config bắt buộc mà thiếu env sẽ làm app test không khởi động được. Đây là chủ đích: test phản ánh đúng hành vi fail-fast của production. Các task sau thêm key bắt buộc vào `baseTestEnv()` (chỉ ra cụ thể ở từng task).
`test/e2e/core/errors-and-context.e2e.spec.ts`:
```ts
import { Controller, Get, Module } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { RequestContext } from '../../../src/core/context/index.js';
import { createTestApp } from '../../support/app-factory.js';

@Controller('probe')
class ProbeController {
  constructor(private readonly ctx: RequestContext) {}
  @Get('id') id() { return { requestId: this.ctx.requestId() }; }
  @Get('app-error') appError() { throw new AppError(CoreErrors.INVALID_CURSOR, { detail: 'nope' }); }
  @Get('boom') boom() { throw new Error('secret internals'); }
  @Post('echo') echo(@Body() body: unknown) { return body; }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('errors + context (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'api');
    app = await createTestApp([ProbeModule]);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('echoes incoming x-request-id', async () => {
    const res = await request(app.getHttpServer()).get('/probe/id').set('x-request-id', 'abc-123');
    expect(res.body.requestId).toBe('abc-123');
  });
  it('generates request id when missing', async () => {
    const res = await request(app.getHttpServer()).get('/probe/id');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('returns request id in the X-Request-Id response header', async () => {
    const res = await request(app.getHttpServer()).get('/probe/id');
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });
  it('ignores unsafe incoming request ids', async () => {
    const res = await request(app.getHttpServer()).get('/probe/id').set('x-request-id', 'a\nb'.padEnd(200, 'x'));
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('returns problem+json for AppError with requestId and timestamp', async () => {
    const res = await request(app.getHttpServer()).get('/probe/app-error?secret=1').set('x-request-id', 'req-42');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: '/errors/invalid-cursor', code: 'invalid_cursor', detail: 'nope', instance: '/probe/app-error', requestId: 'req-42',
    });
    expect(Date.parse(res.body.timestamp)).not.toBeNaN();
  });
  it('unknown route → 404 not_found problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
  it('malformed JSON body → 400 malformed_request', async () => {
    const res = await request(app.getHttpServer()).post('/probe/echo').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('malformed_request');
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
git commit -m "feat(core): problem+json errors, request context, structured logging"
```

---

### Task 5: `core/database` — MikroORM, 2 pool, UnitOfWork, migration runner (S4, S5)

**Files:**
- Create: `src/core/database/{database.config.ts,entities.ts,database.module.ts,unit-of-work.ts,mikro-orm-unit-of-work.ts,tx-em.ts,migrator.ts,index.ts}`, `src/main.migrate.ts`, `db/migrations/core/` (CLI), `mikro-orm.config.ts` (config cho CLI)
- Test: `test/integration/core/database/unit-of-work.spec.ts`, `test/integration/core/database/migrations.spec.ts`, `test/support/db.ts`

**Interfaces:**
- Consumes: `defineConfig`, `RequestContext`, `CTX.em`, `getInfra()`
- Produces:
  - `abstract class UnitOfWork { abstract run<T>(fn: () => Promise<T>, opts?: { isolation?: Isolation }): Promise<T>; abstract inTransaction(): boolean }`, `type Isolation = 'read committed' | 'repeatable read' | 'serializable'`
  - `TxEm` (chỉ dùng trong infra): `get(): EntityManager` trả EM của transaction hiện tại, nếu không có thì EM của context
  - `CORE_ENTITIES: EntitySchema[]`, `registerEntities(...schemas)`
  - `DB_CONTEXT = { app: 'app', admin: 'admin' } as const`
  - `DatabaseModule.forRoot()`
  - `runMigrations(cmd: 'up' | 'down' | 'status', opts?: { to?: string }): Promise<string[]>`
  - `test/support/db.ts`: `dbEnv(role: 'app' | 'admin' | 'owner'): Record<string, string>` (tạo env cho config database)

- [ ] **Step 1: Cài package**

```bash
for p in @mikro-orm/core @mikro-orm/postgresql @mikro-orm/nestjs @mikro-orm/migrations @mikro-orm/cli; do pnpm view $p dist-tags peerDependencies; done
pnpm add @mikro-orm/core @mikro-orm/postgresql @mikro-orm/nestjs @mikro-orm/migrations
pnpm add -D @mikro-orm/cli
```
Expected: cùng một version cho mọi package `@mikro-orm/*`, và `@mikro-orm/nestjs` có peer Nest 12. Nếu không khớp thì dừng lại theo Global Constraints.

- [ ] **Step 2: Config database**

`src/core/database/database.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

const role = z.object({ user: z.string().min(1), password: z.string().min(1) });

export const databaseConfig = defineConfig(
  'database',
  {
    host: 'DB_HOST', port: 'DB_PORT', name: 'DB_NAME',
    appUser: 'DB_APP_USER', appPassword: 'DB_APP_PASSWORD',
    adminUser: 'DB_ADMIN_USER', adminPassword: 'DB_ADMIN_PASSWORD',
    ownerUser: 'DB_OWNER_USER', ownerPassword: 'DB_OWNER_PASSWORD',
    poolMax: 'DB_POOL_MAX', adminPoolMax: 'DB_ADMIN_POOL_MAX',
    statementTimeoutMs: 'DB_STATEMENT_TIMEOUT_MS',
    migrationLockTimeoutMs: 'DB_MIGRATION_LOCK_TIMEOUT_MS',
    migrationStatementTimeoutMs: 'DB_MIGRATION_STATEMENT_TIMEOUT_MS',
    debug: 'DB_DEBUG',
  },
  z.object({
    host: z.string().min(1).describe('Postgres or PgBouncer host'),
    port: z.coerce.number().int().positive().default(5432).describe('Postgres or PgBouncer port'),
    name: z.string().min(1).describe('Database name'),
    appUser: z.string().default('app_user').describe('Role used by api/worker (RLS enforced)'),
    appPassword: z.string().min(1).describe('Password of app role'),
    adminUser: z.string().default('app_admin').describe('Role with BYPASSRLS for relay/cross-org jobs'),
    adminPassword: z.string().min(1).describe('Password of admin role'),
    ownerUser: z.string().default('app_owner').describe('Role that owns tables and runs migrations'),
    ownerPassword: z.string().optional().describe('Password of owner role (required only for migrate)'),
    poolMax: z.coerce.number().int().positive().default(10).describe('Max connections per process (app pool)'),
    adminPoolMax: z.coerce.number().int().positive().default(2).describe('Max connections per process (admin pool)'),
    statementTimeoutMs: z.coerce.number().int().positive().default(5000).describe('statement_timeout for app pool'),
    migrationLockTimeoutMs: z.coerce.number().int().positive().default(5000).describe('lock_timeout during migrations'),
    migrationStatementTimeoutMs: z.coerce.number().int().positive().default(600000).describe('statement_timeout during migrations'),
    debug: z.stringbool().default(false).describe('Log SQL (development only)'),
  }),
);
export type DatabaseConfig = z.infer<ReturnType<typeof databaseConfig>> extends infer T ? T : never;
```
Worker cần `statement_timeout` dài hơn api (spec cha, mục 5). Thêm key `workerStatementTimeoutMs: 'DB_WORKER_STATEMENT_TIMEOUT_MS'` với `.default(60000)`. Factory ở Step 4 chọn giá trị theo `appConfig.role`.

Thêm `import '../database/database.config.js';` vào `all-configs.ts`.

- [ ] **Step 3: Viết test UnitOfWork trước**

`test/support/db.ts`:
```ts
import { getInfra } from './infra.js';

export function dbEnv(): Record<string, string> {
  const { pg } = getInfra();
  return {
    DB_HOST: pg.host, DB_PORT: String(pg.port), DB_NAME: pg.database,
    DB_APP_USER: pg.app.user, DB_APP_PASSWORD: pg.app.password,
    DB_ADMIN_USER: pg.admin.user, DB_ADMIN_PASSWORD: pg.admin.password,
    DB_OWNER_USER: pg.owner.user, DB_OWNER_PASSWORD: pg.owner.password,
  };
}
export function stubEnv(env: Record<string, string>, stub: (k: string, v: string) => void): void {
  for (const [k, v] of Object.entries(env)) stub(k, v);
}
```
`test/integration/core/database/unit-of-work.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { DatabaseModule, UnitOfWork, runMigrations } from '../../../../src/core/database/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';
import { dbEnv, stubEnv } from '../../../support/db.js';

describe('UnitOfWork', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let repo: FixtureRepo;

  beforeAll(async () => {
    stubEnv({ ...dbEnv(), APP_ROLE: 'api' }, vi.stubEnv);
    await runMigrations('up');
    app = await createTestApp([DatabaseModule.forRoot(), FixtureModule], { http: false });
    await app.init();
    uow = app.get(UnitOfWork);
    repo = app.get(FixtureRepo);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('commits all writes when fn resolves', async () => {
    const name = `commit-${Date.now()}`;
    await uow.run(async () => { await repo.insertSystemNote(name); });
    expect(await repo.countSystemNotes(name)).toBe(1);
  });

  it('rolls back all writes when fn throws', async () => {
    const name = `rollback-${Date.now()}`;
    await expect(uow.run(async () => { await repo.insertSystemNote(name); throw new Error('fail'); })).rejects.toThrow('fail');
    expect(await repo.countSystemNotes(name)).toBe(0);
  });

  it('nested run joins the outer transaction', async () => {
    const name = `nested-${Date.now()}`;
    await expect(
      uow.run(async () => {
        await uow.run(async () => { await repo.insertSystemNote(name); });
        throw new Error('outer fail');
      }),
    ).rejects.toThrow('outer fail');
    expect(await repo.countSystemNotes(name)).toBe(0);
  });

  it('uses the app role (not owner) at runtime', async () => {
    expect(await repo.currentUser()).toBe('app_user');
  });
});

describe('migrations', () => {
  it('up → down → up is repeatable', async () => {
    stubEnv({ ...dbEnv(), APP_ROLE: 'migrate' }, vi.stubEnv);
    await runMigrations('up');
    await runMigrations('down', { to: '0' });
    const pending = await runMigrations('status');
    expect(pending.length).toBeGreaterThan(0);
    await runMigrations('up');
    expect(await runMigrations('status')).toEqual([]);
    vi.unstubAllEnvs();
  });
});
```
Test này cần fixture (Step 6). Run: `pnpm test:int`
Expected: FAIL, vì module chưa có.

- [ ] **Step 4: Module database, 2 context, TxEm, UnitOfWork**

Verify trước khi code, trong tài liệu MikroORM 7:
- (a) `MikroOrmModule.forRootAsync({ contextName, useFactory, inject, driver })` và `registerRequestContext` (`https://mikro-orm.io/docs/usage-with-nestjs`, phần multiple databases);
- (b) option `pool` và cách set `statement_timeout` cho connection (`driverOptions` hoặc `onConnect`/`pool.afterCreate`, xem `https://mikro-orm.io/docs/configuration`);
- (c) `em.transactional(cb, { isolationLevel })` và enum `IsolationLevel` (`https://mikro-orm.io/docs/transactions`);
- (d) `em.isInTransaction()`.

Code dưới đây viết theo API đã đọc được. Tên nào khác trong tài liệu thì sửa theo tài liệu.

`src/core/database/entities.ts`:
```ts
import type { EntitySchema } from '@mikro-orm/core';

const schemas: EntitySchema[] = [];
export function registerEntities(...list: EntitySchema[]): void {
  for (const s of list) if (!schemas.includes(s)) schemas.push(s);
}
export function allEntities(): EntitySchema[] {
  return [...schemas];
}
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
import { EntityManager } from '@mikro-orm/postgresql';
import { ClsService } from 'nestjs-cls';
import { CTX } from '../context/index.js';

@Injectable()
export class TxEm {
  constructor(private readonly root: EntityManager, private readonly cls: ClsService) {}
  get(): EntityManager {
    const scoped = this.cls.isActive() ? this.cls.get<EntityManager>(CTX.em) : undefined;
    return scoped ?? this.root.getContext();
  }
  bind<T>(em: EntityManager, fn: () => Promise<T>): Promise<T> {
    const run = async () => { this.cls.set(CTX.em, em); return fn(); };
    return this.cls.isActive() ? this.cls.run({ ifNested: 'inherit' }, run) : this.cls.run(run);
  }
}
```
Verify: option `ifNested: 'inherit'` của `ClsService.run` có trong nestjs-cls latest. Nếu không có thì dùng cách tương đương mà tài liệu ghi, để giá trị CLS của lớp ngoài được giữ.

`src/core/database/mikro-orm-unit-of-work.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { IsolationLevel } from '@mikro-orm/core';
import { TxEm } from './tx-em.js';
import { UnitOfWork, type Isolation } from './unit-of-work.js';

const ISOLATION: Record<Isolation, IsolationLevel> = {
  'read committed': IsolationLevel.READ_COMMITTED,
  'repeatable read': IsolationLevel.REPEATABLE_READ,
  serializable: IsolationLevel.SERIALIZABLE,
};

@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly txEm: TxEm) { super(); }

  inTransaction(): boolean {
    return this.txEm.get().isInTransaction();
  }

  run<T>(fn: () => Promise<T>, opts: { isolation?: Isolation } = {}): Promise<T> {
    const em = this.txEm.get();
    if (em.isInTransaction()) return fn();
    return em.transactional(
      (tx) => this.txEm.bind(tx, fn),
      opts.isolation ? { isolationLevel: ISOLATION[opts.isolation] } : undefined,
    );
  }
}
```
`src/core/database/database.module.ts`:
```ts
import { DynamicModule, Global, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { type ConfigOf, appConfig } from '../config/index.js';
import { allEntities } from './entities.js';
import { databaseConfig } from './database.config.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';
import { TxEm } from './tx-em.js';
import { UnitOfWork } from './unit-of-work.js';

export const DB_CONTEXT = { app: 'app', admin: 'admin' } as const;

function ormOptions(db: ConfigOf<typeof databaseConfig>, app: ConfigOf<typeof appConfig>, who: 'app' | 'admin') {
  const statementTimeout = app.role === 'worker' ? db.workerStatementTimeoutMs : db.statementTimeoutMs;
  return {
    driver: PostgreSqlDriver,
    entities: allEntities(),
    host: db.host,
    port: db.port,
    dbName: db.name,
    user: who === 'app' ? db.appUser : db.adminUser,
    password: who === 'app' ? db.appPassword : db.adminPassword,
    pool: { min: 0, max: who === 'app' ? db.poolMax : db.adminPoolMax },
    driverOptions: { connection: { statement_timeout: statementTimeout } },
    debug: db.debug,
    allowGlobalContext: false,
    registerRequestContext: false,
  };
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        MikroOrmModule.forRootAsync({
          contextName: DB_CONTEXT.app,
          inject: [databaseConfig.KEY, appConfig.KEY],
          useFactory: (db: ConfigOf<typeof databaseConfig>, app: ConfigOf<typeof appConfig>) => ormOptions(db, app, 'app'),
          driver: PostgreSqlDriver,
        }),
        MikroOrmModule.forRootAsync({
          contextName: DB_CONTEXT.admin,
          inject: [databaseConfig.KEY, appConfig.KEY],
          useFactory: (db: ConfigOf<typeof databaseConfig>, app: ConfigOf<typeof appConfig>) => ormOptions(db, app, 'admin'),
          driver: PostgreSqlDriver,
        }),
        MikroOrmModule.forMiddleware(),
      ],
      providers: [TxEm, { provide: UnitOfWork, useClass: MikroOrmUnitOfWork }],
      exports: [TxEm, UnitOfWork, MikroOrmModule],
    };
  }
}
```
Verify: với nhiều `contextName`, `EntityManager` không có tên (inject mặc định trong `TxEm`) có còn resolve được không. Nếu không thì `TxEm` phải dùng `@InjectEntityManager(DB_CONTEXT.app)`. Thêm một provider `AdminTxEm` dùng `@InjectEntityManager(DB_CONTEXT.admin)` cho relay ở Task 9. Verify: cách truyền `statement_timeout` qua `driverOptions` với driver PostgreSQL của MikroORM 7 (có thể phải dùng `pool.afterCreate`). Test ở Step 7 kiểm tra `SHOW statement_timeout`.

- [ ] **Step 5: Migration runner (S4, S5)**

Tạo `mikro-orm.config.ts` ở root (file config mà CLI của MikroORM đọc; tài liệu yêu cầu tên này):
```ts
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  extensions: [Migrator],
  entities: [],
  discovery: { warnWhenNoEntities: false },
  dbName: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_OWNER_USER,
  password: process.env.DB_OWNER_PASSWORD,
  migrations: { path: 'dist/db/migrations', pathTs: 'db/migrations', glob: '**/*.{js,ts}', transactional: true, allOrNothing: true, emit: 'ts', snapshot: false },
});
```
Spike S4: tạo 2 migration ở 2 thư mục khác nhau bằng CLI:
```bash
pnpm mikro-orm --help
pnpm mikro-orm migration:create --help
pnpm mikro-orm migration:create --blank --path db/migrations/core --name core_bootstrap
```
Nếu CLI không có option `--path` thì dùng biến môi trường hoặc config theo đúng `--help`. Chạy `pnpm mikro-orm migration:list`, kiểm tra migration ở thư mục con có được nhận không. Nếu glob không quét được thư mục con thì chuyển về một thư mục `db/migrations`, đặt tên file có tiền tố module, và ghi vào ADR 0003.

Spike S5: sửa migration `core_bootstrap` vừa tạo, phần thân:
```ts
async up(): Promise<void> {
  this.addSql(`SELECT uuidv7();`);
  this.addSql(`CREATE TABLE core_bootstrap_probe (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, public_id UUID NOT NULL DEFAULT uuidv7() UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE core_bootstrap_probe;`);
}
```
Nếu `uuidv7()` không có thì bỏ `DEFAULT uuidv7()`, sinh UUID ở app bằng `uuid` v7, và ghi vào ADR 0009. Bảng probe này bị xoá ở Task 9, khi đã có bảng thật (tạo migration mới để `DROP`).

`src/core/database/migrator.ts`:
```ts
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { databaseConfig } from './database.config.js';

export async function runMigrations(cmd: 'up' | 'down' | 'status', opts: { to?: string } = {}): Promise<string[]> {
  const db = databaseConfig();
  if (!db.ownerPassword) throw new Error('DB_OWNER_PASSWORD is required to run migrations');
  const orm = await MikroORM.init({
    extensions: [Migrator],
    entities: [],
    discovery: { warnWhenNoEntities: false },
    host: db.host, port: db.port, dbName: db.name, user: db.ownerUser, password: db.ownerPassword,
    driverOptions: { connection: { statement_timeout: db.migrationStatementTimeoutMs, lock_timeout: db.migrationLockTimeoutMs } },
    migrations: { path: 'dist/db/migrations', pathTs: 'db/migrations', glob: '**/*.{js,ts}', transactional: true, allOrNothing: true },
  });
  try {
    if (cmd === 'up') return (await orm.migrator.up()).map((m) => m.name);
    if (cmd === 'down') return (await orm.migrator.down(opts.to ? { to: opts.to } : undefined)).map((m) => m.name);
    return (await orm.migrator.getPending()).map((m) => m.name);
  } finally {
    await orm.close(true);
  }
}
```
Verify: tên method `orm.migrator.getPending()` (có thể là `getPendingMigrations()`) và kiểu trả về theo `https://mikro-orm.io/docs/migrations`. Verify cách MikroORM chọn `path` hay `pathTs` khi chạy test qua SWC. Nếu cần thì truyền `preferTs` theo tài liệu.

`src/main.migrate.ts`:
```ts
import { runMigrations } from './core/database/migrator.js';

const COMMANDS = ['up', 'down', 'status'] as const;
type Cmd = (typeof COMMANDS)[number];

async function main(): Promise<void> {
  process.env.APP_ROLE = 'migrate';
  const [cmd = 'up', to] = process.argv.slice(2);
  if (!COMMANDS.includes(cmd as Cmd)) throw new Error(`Unknown command "${cmd}". Use: ${COMMANDS.join(' | ')}`);
  const names = await runMigrations(cmd as Cmd, { to });
  process.stdout.write(`${JSON.stringify({ cmd, migrations: names })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Fixture cho test**

Tạo migration fixture bằng CLI:
```bash
pnpm mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_notes
```
Thêm `test/fixtures/migrations` vào glob migration **chỉ khi** `APP_ROLE`/`NODE_ENV` là `test`, bằng biến config `DB_EXTRA_MIGRATION_PATHS` (thêm vào `databaseConfig`, dạng danh sách phân cách bằng dấu phẩy, mặc định rỗng). `runMigrations` gộp các path đó vào. Test setup set `DB_EXTRA_MIGRATION_PATHS=test/fixtures/migrations`.

Thân migration fixture:
```ts
async up(): Promise<void> {
  this.addSql(`CREATE TABLE fixture_notes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  this.addSql(`CREATE INDEX fixture_notes_body_idx ON fixture_notes (body);`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE fixture_notes;`);
}
```
`test/fixtures/fixture.entity.ts`:
```ts
import { defineEntity, p } from '@mikro-orm/core';
import { registerEntities } from '../../src/core/database/entities.js';

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
registerEntities(FixtureNote.schema ?? FixtureNote);
```
Verify: tên builder `p.bigint()`, `p.uuid()`, `p.text()`, `.fieldName()` và cách lấy `EntitySchema` từ kết quả `defineEntity` trong MikroORM 7 (`https://mikro-orm.io/docs/define-entity`). Sửa theo tài liệu.

`test/fixtures/fixture.module.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { TxEm } from '../../src/core/database/index.js';
import './fixture.entity.js';

@Injectable()
export class FixtureRepo {
  constructor(private readonly txEm: TxEm) {}
  async insertSystemNote(body: string): Promise<void> {
    await this.txEm.get().getConnection().execute('INSERT INTO fixture_notes (body) VALUES (?)', [body]);
  }
  async countSystemNotes(body: string): Promise<number> {
    const rows = await this.txEm.get().getConnection().execute<{ n: string }[]>('SELECT count(*)::text AS n FROM fixture_notes WHERE body = ?', [body]);
    return Number(rows[0]!.n);
  }
  async currentUser(): Promise<string> {
    const rows = await this.txEm.get().getConnection().execute<{ u: string }[]>('SELECT current_user AS u');
    return rows[0]!.u;
  }
}

@Module({ providers: [FixtureRepo], exports: [FixtureRepo] })
export class FixtureModule {}
```
Verify: `getConnection().execute` trong MikroORM 7 có chạy trên transaction hiện tại của EM không. Nếu không thì dùng `em.execute(sql, params)` theo tài liệu.

`src/core/database/index.ts`:
```ts
export { DatabaseModule, DB_CONTEXT } from './database.module.js';
export { UnitOfWork, type Isolation } from './unit-of-work.js';
export { TxEm } from './tx-em.js';
export { registerEntities, allEntities } from './entities.js';
export { runMigrations } from './migrator.js';
export { databaseConfig } from './database.config.js';
```
Sửa `test/support/env.ts`: thêm key DB vào `baseTestEnv()` (lấy từ container, nên chỉ gọi trong project integration):
```ts
import { dbEnv } from './db.js';
// trong baseTestEnv():
return {
  APP_ROLE: 'api',
  NODE_ENV: 'test',
  DB_EXTRA_MIGRATION_PATHS: 'test/fixtures/migrations',
  ...dbEnv(),
};
```

Run: `pnpm build && pnpm test:int`
Expected: PASS toàn bộ test ở Step 3.

- [ ] **Step 7: Test statement_timeout theo role**

Thêm vào `unit-of-work.spec.ts`:
```ts
it('applies api statement_timeout on app connections', async () => {
  const rows = await app.get(TxEm).get().getConnection().execute<{ statement_timeout: string }[]>('SHOW statement_timeout');
  expect(rows[0]!.statement_timeout).toBe('5s');
});
```
(`5s` tương ứng với giá trị mặc định 5000 ms trong schema. Nếu test set env khác thì so với env đó.)
Run: `pnpm test:int`
Expected: PASS.

- [ ] **Step 8: ADR 0003, 0009 và commit**

Tạo `docs/adr/0003-orm-mikro-orm.md` (MADR): ghi quyết định MikroORM 7.2 pin chính xác, kết quả S4 (cách tổ chức thư mục migration), 2 context app/admin, và API đã verify khác với plan (nếu có). Tạo `docs/adr/0009-id-strategy.md`: PK bigint, `public_id` UUIDv7, kèm kết quả S5.
```bash
git add -A
git commit -m "feat(core): mikro-orm database module, unit of work, migration runner"
```

---

### Task 6: 3 entrypoint và 2 module gốc (khung chạy được)

**Files:**
- Create: `src/app-api.module.ts`, `src/app-worker.module.ts`, `src/app.modules.ts`, `src/main.api.ts`, `src/main.worker.ts`
- Delete: `src/main.ts`, `src/app.module.ts`, `src/app.controller.ts`, `src/app.service.ts` (file mẫu do CLI sinh)
- Modify: `nest-cli.json` (`entryFile` nếu cần), `package.json` scripts
- Test: `test/e2e/core/entrypoints.e2e.spec.ts`

**Interfaces:**
- Consumes: `ContextModule`, `LoggingModule`, `DatabaseModule`, `ProblemDetailsFilter`, `configFactories()`
- Produces:
  - `APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] }` trong `app.modules.ts` (vùng dự án)
  - `CoreApiModule`, `CoreWorkerModule` (import phần core theo vai trò)
  - `bootstrapApi(): Promise<INestApplication>`, `bootstrapWorker(): Promise<INestApplicationContext>` được export để test gọi

- [ ] **Step 1: Viết test trước**

`test/e2e/core/entrypoints.e2e.spec.ts`:
```ts
import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { dbEnv, stubEnv } from '../../support/db.js';
import { bootstrapApi } from '../../../src/main.api.js';
import { bootstrapWorker } from '../../../src/main.worker.js';

describe('entrypoints', () => {
  afterAll(() => vi.unstubAllEnvs());

  it('api boots with core modules and serves 404 as problem+json', async () => {
    stubEnv({ ...dbEnv(), HTTP_PORT: '0' }, vi.stubEnv);
    const app = await bootstrapApi({ listen: false });
    const res = await request(app.getHttpServer()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    await app.close();
  });

  it('worker boots without an HTTP router', async () => {
    stubEnv(dbEnv(), vi.stubEnv);
    const ctx = await bootstrapWorker({ start: false });
    expect(ctx).toBeDefined();
    await ctx.close();
  });
});
```
Run: `pnpm build && pnpm test:int`
Expected: FAIL, vì chưa có entrypoint.

- [ ] **Step 2: Cài đặt**

`src/app.modules.ts` (dự án sở hữu):
```ts
import type { DynamicModule, Type } from '@nestjs/common';

type ModuleImport = Type<unknown> | DynamicModule;

/** Module nền và feature mà dự án bật. Boilerplate để trống. */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [],
  worker: [],
};
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
    ConfigModule.forRoot({ isGlobal: true, load: configFactories(), cache: true }),
    ContextModule,
    LoggingModule,
    DatabaseModule.forRoot(),
    ...APP_MODULES.api,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppApiModule {}
```
`src/app-worker.module.ts` giống như trên nhưng không có `APP_FILTER`, và dùng `APP_MODULES.worker`.

Config HTTP tối thiểu, `src/core/http/http.config.ts` (Task 12 sẽ mở rộng):
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const httpConfig = defineConfig(
  'http',
  { port: 'HTTP_PORT', host: 'HTTP_HOST' },
  z.object({
    port: z.coerce.number().int().min(0).default(3000).describe('HTTP listen port (0 = random, tests only)'),
    host: z.string().default('0.0.0.0').describe('HTTP listen host'),
  }),
);
```
Thêm import vào `all-configs.ts`.

`src/main.api.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { pathToFileURL } from 'node:url';
import { AppApiModule } from './app-api.module.js';
import { httpConfig } from './core/http/http.config.js';

export async function bootstrapApi(opts: { listen?: boolean } = {}): Promise<INestApplication> {
  process.env.APP_ROLE = 'api';
  const app = await NestFactory.create(AppApiModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  if (opts.listen === false) {
    await app.init();
    return app;
  }
  const http = httpConfig();
  await app.listen(http.port, http.host);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  bootstrapApi().catch((err: unknown) => {
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

export async function bootstrapWorker(opts: { start?: boolean } = {}): Promise<INestApplicationContext> {
  process.env.APP_ROLE = 'worker';
  const ctx = await NestFactory.createApplicationContext(AppWorkerModule, { bufferLogs: true });
  ctx.useLogger(ctx.get(Logger));
  ctx.enableShutdownHooks();
  if (opts.start !== false) await ctx.init();
  return ctx;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  bootstrapWorker().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
```
Xoá các file mẫu của CLI. Sửa `package.json`:
```json
"start:api": "node dist/main.api.js",
"start:worker": "node dist/main.worker.js",
"migrate": "node dist/main.migrate.js",
"start:dev": "nest start -b swc --watch --entryFile main.api"
```
Verify: `nest start` có option `--entryFile` không (`nest start --help`). Nếu không có thì đặt `entryFile` trong `nest-cli.json` theo tài liệu.

Run: `pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: api, worker and migrate entrypoints with project module list"
```

---

### Task 7: `withOrg` + RLS fail-closed

**Files:**
- Create: `src/core/database/org-scope.ts`, migration `fixture_org_notes` trong `test/fixtures/migrations/` (tên file do CLI đặt)
- Modify: `src/core/database/database.module.ts`, `src/core/database/index.ts`, `src/core/database/database.config.ts`
- Test: `test/integration/core/database/org-scope.spec.ts`

**Interfaces:**
- Consumes: `TxEm`, `UnitOfWork`, `RequestContext`, `CoreErrors`, `AppError`
- Produces:
  - `OrgScope.run<T>(orgId: string, fn: () => Promise<T>): Promise<T>`: fork EM với session `app.org_id`, gắn vào CLS, set `RequestContext.orgId`
  - `CoreErrors.ORG_CONTEXT_INVALID` (400)
  - Config `DB_RLS_SESSION_VAR` (mặc định `app.org_id`)

- [ ] **Step 1: Viết test trước**

Tạo bảng fixture có RLS bằng CLI. Đây là bảng riêng, để test UnitOfWork ở Task 5 (bảng `fixture_notes` không có tenant) không bị ảnh hưởng:
```bash
pnpm mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_org_notes
```
Thân (đây cũng là **mẫu policy chuẩn** cho bảng tenant thật ở các sub-project sau):
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
    USING (org_id = current_setting('app.org_id')::uuid)
    WITH CHECK (org_id = current_setting('app.org_id')::uuid);`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE fixture_org_notes;`);
}
```
Thêm vào `FixtureRepo` (`test/fixtures/fixture.module.ts`):
```ts
async insertOrgNote(orgId: string, body: string): Promise<void> {
  await this.txEm.get().getConnection().execute('INSERT INTO fixture_org_notes (org_id, body) VALUES (?, ?)', [orgId, body]);
}
async listOrgBodies(): Promise<string[]> {
  const rows = await this.txEm.get().getConnection().execute<{ body: string }[]>('SELECT body FROM fixture_org_notes ORDER BY id');
  return rows.map((r) => r.body);
}
```

`test/integration/core/database/org-scope.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule, OrgScope, UnitOfWork, runMigrations } from '../../../../src/core/database/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';
import { dbEnv, stubEnv } from '../../../support/db.js';

describe('OrgScope + RLS', () => {
  let app: INestApplication;
  let scope: OrgScope;
  let uow: UnitOfWork;
  let repo: FixtureRepo;
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    stubEnv({ ...dbEnv(), APP_ROLE: 'api', DB_EXTRA_MIGRATION_PATHS: 'test/fixtures/migrations' }, vi.stubEnv);
    await runMigrations('up');
    app = await createTestApp([DatabaseModule.forRoot(), FixtureModule], { http: false });
    await app.init();
    scope = app.get(OrgScope); uow = app.get(UnitOfWork); repo = app.get(FixtureRepo);
    await scope.run(orgA, () => uow.run(() => repo.insertOrgNote(orgA, 'a1')));
    await scope.run(orgB, () => uow.run(() => repo.insertOrgNote(orgB, 'b1')));
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('only sees rows of the current org', async () => {
    const bodies = await scope.run(orgA, () => uow.run(() => repo.listOrgBodies()));
    expect(bodies).toContain('a1');
    expect(bodies).not.toContain('b1');
  });

  it('fails closed when querying tenant table without org context', async () => {
    await expect(uow.run(() => repo.insertOrgNote(orgA, 'x'))).rejects.toThrow(/app\.org_id|unrecognized configuration parameter/);
  });

  it('cannot write a row for another org', async () => {
    await expect(scope.run(orgA, () => uow.run(() => repo.insertOrgNote(orgB, 'evil')))).rejects.toThrow(/row-level security/);
  });

  it('rejects empty/invalid orgId before touching the database', async () => {
    await expect(scope.run('', async () => 1)).rejects.toBeInstanceOf(AppError);
    await expect(scope.run('not-a-uuid', async () => 1)).rejects.toBeInstanceOf(AppError);
  });

  it('does not leak org context to the next unit of work', async () => {
    await scope.run(orgA, () => uow.run(() => repo.listOrgBodies()));
    await expect(uow.run(() => repo.insertOrgNote(orgA, 'y'))).rejects.toThrow();
  });
});
```
Run: `pnpm build && pnpm test:int`
Expected: FAIL, vì chưa có `OrgScope`.

- [ ] **Step 2: Cài đặt**

Verify: trong `https://mikro-orm.io/docs/row-level-security` xác nhận (a) option `sessionContext: 'transaction'` ở cấp ORM, (b) `em.fork({ session: { variables } })`, (c) session được áp sau `BEGIN` của `em.transactional`. Nếu tên khác thì sửa theo tài liệu và ghi vào ADR 0005.

Thêm vào `databaseConfig`: `rlsSessionVar: 'DB_RLS_SESSION_VAR'` → `z.string().regex(/^[a-z_]+\.[a-z_]+$/).default('app.org_id').describe('Postgres setting name carrying the current org id')`. Thêm vào `ormOptions`: `sessionContext: 'transaction'`.

Mã lỗi `CoreErrors.ORG_CONTEXT_INVALID` (`400 org_context_invalid`) đã có từ Task 4.
`src/core/database/org-scope.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { databaseConfig } from './database.config.js';
import { TxEm } from './tx-em.js';

const OrgId = z.uuid();

@Injectable()
export class OrgScope {
  constructor(
    private readonly txEm: TxEm,
    private readonly ctx: RequestContext,
    @Inject(databaseConfig.KEY) private readonly db: ConfigOf<typeof databaseConfig>,
  ) {}

  run<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    if (!OrgId.safeParse(orgId).success) {
      return Promise.reject(new AppError(CoreErrors.ORG_CONTEXT_INVALID, { detail: 'orgId must be a UUID' }));
    }
    const forked = this.txEm.get().fork({ session: { variables: { [this.db.rlsSessionVar]: orgId } } });
    return this.txEm.bind(forked, async () => {
      this.ctx.setOrgId(orgId);
      return fn();
    });
  }
}
```
Verify: `z.uuid()` có trong zod 4 và nhận được UUIDv7. Đăng ký `OrgScope` trong `DatabaseModule` (providers + exports) và export trong `index.ts`.

Run: `pnpm build && pnpm test:int`
Expected: PASS toàn bộ.

- [ ] **Step 3: Map lỗi DB và retry transaction (viết test trước)**

Interfaces bổ sung cho task này:
- `defineConstraintErrors(map: Record<string, ErrorCode>): void` (tên constraint → mã lỗi cụ thể, trùng tên thì ném lỗi)
- `dbErrorMapper: ErrorMapper` (đăng ký vào `core/errors` trong `DatabaseModule.onModuleInit`)
- Config `DB_TX_RETRY_ATTEMPTS`, `DB_TX_RETRY_BASE_MS`

Tạo migration fixture bằng CLI:
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
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE fixture_children;`);
  this.addSql(`DROP TABLE fixture_parents;`);
}
```
Thêm vào `FixtureRepo`:
```ts
async insertParent(): Promise<string> {
  const rows = await this.txEm.get().getConnection().execute<{ id: string }[]>('INSERT INTO fixture_parents DEFAULT VALUES RETURNING id::text AS id');
  return rows[0]!.id;
}
async insertChild(parentId: string, email: string, qty: number): Promise<void> {
  await this.txEm.get().getConnection().execute('INSERT INTO fixture_children (parent_id, email, qty) VALUES (?::bigint, ?, ?)', [parentId, email, qty]);
}
async deleteParent(id: string): Promise<void> {
  await this.txEm.get().getConnection().execute('DELETE FROM fixture_parents WHERE id = ?::bigint', [id]);
}
async readCounter(id: string): Promise<number> {
  const rows = await this.txEm.get().getConnection().execute<{ counter: number }[]>('SELECT counter FROM fixture_parents WHERE id = ?::bigint', [id]);
  return rows[0]!.counter;
}
async writeCounter(id: string, value: number): Promise<void> {
  await this.txEm.get().getConnection().execute('UPDATE fixture_parents SET counter = ?, updated_at = now() WHERE id = ?::bigint', [value, id]);
}
```
`test/integration/core/database/db-errors.spec.ts`:
```ts
import { HttpStatus, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, OrgScope, UnitOfWork, defineConstraintErrors, runMigrations } from '../../../../src/core/database/index.js';
import { AppError, defineErrorCodes, mapKnownError } from '../../../../src/core/errors/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const FixtureErrors = defineErrorCodes({ FIXTURE_EMAIL_TAKEN: { status: HttpStatus.CONFLICT, title: 'Email already used' } });
defineConstraintErrors({ fixture_children_email_uq: FixtureErrors.FIXTURE_EMAIL_TAKEN });

async function codeOf(p: Promise<unknown>): Promise<{ code: string; status: number; message: string }> {
  try { await p; throw new Error('expected failure'); } catch (e) {
    const mapped = e instanceof AppError ? e : mapKnownError(e);
    if (!mapped) throw e;
    return { code: mapped.error.code, status: mapped.error.status, message: JSON.stringify({ detail: mapped.opts.detail, fields: mapped.opts.fields }) };
  }
}

describe('database error mapping', () => {
  let app: INestApplication; let uow: UnitOfWork; let repo: FixtureRepo;
  beforeAll(async () => {
    await runMigrations('up');
    app = await createTestApp([DatabaseModule.forRoot(), FixtureModule], { http: false });
    await app.init();
    uow = app.get(UnitOfWork); repo = app.get(FixtureRepo);
  });
  afterAll(async () => { await app.close(); });

  it('unique violation on a registered constraint → specific code, constraint name not leaked', async () => {
    const parent = await uow.run(() => repo.insertParent());
    const email = `${randomUUID()}@x.io`;
    await uow.run(() => repo.insertChild(parent, email, 1));
    const r = await codeOf(uow.run(() => repo.insertChild(parent, email, 1)));
    expect(r).toMatchObject({ code: 'fixture_email_taken', status: 409 });
    expect(r.message).not.toContain('fixture_children_email_uq');
  });

  it('foreign key violation → 409 conflict', async () => {
    const r = await codeOf(uow.run(() => repo.insertChild('999999999', `${randomUUID()}@x.io`, 1)));
    expect(r).toMatchObject({ code: 'conflict', status: 409 });
  });

  it('deleting a referenced row → 409 conflict', async () => {
    const parent = await uow.run(() => repo.insertParent());
    await uow.run(() => repo.insertChild(parent, `${randomUUID()}@x.io`, 1));
    expect(await codeOf(uow.run(() => repo.deleteParent(parent)))).toMatchObject({ code: 'conflict', status: 409 });
  });

  it('check violation → 422 validation_failed', async () => {
    const parent = await uow.run(() => repo.insertParent());
    expect(await codeOf(uow.run(() => repo.insertChild(parent, `${randomUUID()}@x.io`, 0)))).toMatchObject({ code: 'validation_failed', status: 422 });
  });

  it('row level security violation → 404 not_found', async () => {
    const orgA = randomUUID(); const orgB = randomUUID();
    const r = await codeOf(app.get(OrgScope).run(orgA, () => uow.run(() => repo.insertOrgNote(orgB, 'x'))));
    expect(r).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('statement timeout → 503 service_unavailable', async () => {
    const r = await codeOf(uow.run(async () => {
      const conn = app.get(FixtureRepo)['txEm'].get().getConnection();
      await conn.execute(`SET LOCAL statement_timeout = '50ms'`);
      await conn.execute('SELECT pg_sleep(1)');
    }));
    expect(r).toMatchObject({ code: 'service_unavailable', status: 503 });
  });

  it('serialization failures are retried transparently', async () => {
    const parent = await uow.run(() => repo.insertParent());
    const increment = () => uow.run(async () => {
      const v = await repo.readCounter(parent);
      await new Promise((r) => setTimeout(r, 50));
      await repo.writeCounter(parent, v + 1);
    }, { isolation: 'serializable' });
    await Promise.all([increment(), increment()]);
    expect(await uow.run(() => repo.readCounter(parent))).toBe(2);
  });
});
```
`UnitOfWork` vẫn ném lỗi gốc của driver. Việc map sang `AppError` chỉ diễn ra ở filter HTTP (qua `mapKnownError`), nên test `cannot write a row for another org` ở Step 1 (kiểm tra message chứa `row-level security`) vẫn đúng và giữ nguyên.

Run: `pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 4: Cài đặt mapper và retry**

Verify trong mã nguồn `@mikro-orm/core` version đã cài (`node_modules/@mikro-orm/core/dist/exceptions.d.ts`): class `DriverException` có thuộc tính mã SQLSTATE (tên thường là `code` hoặc `sqlState`) và tên constraint không. Nếu không có tên constraint thì đọc từ lỗi gốc của `pg` (`cause.constraint`). Code dưới đây dùng hàm `pgFields` để gom hai nguồn.

Thêm vào `databaseConfig`:
```ts
txRetryAttempts: 'DB_TX_RETRY_ATTEMPTS',   // z.coerce.number().int().min(0).max(10).default(3).describe('Retries for serialization failures/deadlocks (outermost transaction only)')
txRetryBaseMs: 'DB_TX_RETRY_BASE_MS',       // z.coerce.number().int().positive().default(20).describe('Base delay for transaction retry backoff (full jitter)')
```
`src/core/database/db-error.mapper.ts`:
```ts
import { Logger } from '@nestjs/common';
import { AppError, CoreErrors, type ErrorCode, type ErrorMapper } from '../errors/index.js';

/** SQLSTATE của Postgres (chuẩn, không phải giá trị tuỳ chỉnh). */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  QUERY_CANCELED: '57014',
} as const;

const constraintErrors = new Map<string, ErrorCode>();
export function defineConstraintErrors(map: Record<string, ErrorCode>): void {
  for (const [name, code] of Object.entries(map)) {
    if (constraintErrors.has(name)) throw new Error(`Constraint "${name}" already mapped`);
    constraintErrors.set(name, code);
  }
}

type PgFields = { sqlState?: string; constraint?: string; message: string };
export function pgFields(err: unknown): PgFields | undefined {
  if (!(err instanceof Error)) return undefined;
  const e = err as Error & { code?: unknown; sqlState?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  const sqlState = [e.sqlState, e.code, e.cause?.code].find((c): c is string => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c));
  const constraint = [e.constraint, e.cause?.constraint].find((c): c is string => typeof c === 'string');
  return sqlState ? { sqlState, constraint, message: e.message } : undefined;
}

export const isRetryableTxError = (err: unknown): boolean => {
  const s = pgFields(err)?.sqlState;
  return s === PG.SERIALIZATION_FAILURE || s === PG.DEADLOCK_DETECTED;
};

const logger = new Logger('DbErrorMapper');
/** Thông báo chuẩn của Postgres khi RLS chặn (server cố định lc_messages = C). */
const RLS_MESSAGE = 'row-level security';

export const dbErrorMapper: ErrorMapper = (err) => {
  const pg = pgFields(err);
  if (!pg) return undefined;
  switch (pg.sqlState) {
    case PG.UNIQUE_VIOLATION:
      return new AppError((pg.constraint && constraintErrors.get(pg.constraint)) || CoreErrors.CONFLICT, { cause: err });
    case PG.FOREIGN_KEY_VIOLATION:
      return new AppError((pg.constraint && constraintErrors.get(pg.constraint)) || CoreErrors.CONFLICT, { cause: err });
    case PG.CHECK_VIOLATION:
    case PG.NOT_NULL_VIOLATION:
      return new AppError((pg.constraint && constraintErrors.get(pg.constraint)) || CoreErrors.VALIDATION_FAILED, { cause: err });
    case PG.INSUFFICIENT_PRIVILEGE:
      if (!pg.message.includes(RLS_MESSAGE)) return undefined;
      logger.warn({ err, securityEvent: 'rls_violation' }, 'row level security blocked a query; an application-level check is missing');
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
`42501` còn xuất hiện ở lỗi thiếu GRANT (không phải RLS). Hai trường hợp này phải phân biệt: lỗi GRANT là bug cấu hình và phải thành `500`. Kiểm tra message có chứa `row-level security` (thông báo chuẩn của Postgres, locale server được cố định là tiếng Anh trong `01-roles.sh` bằng `ALTER DATABASE … SET lc_messages = 'C'`). Nếu message không khớp thì trả `undefined` để rơi về `500`. Thêm câu lệnh `ALTER DATABASE :"db" SET lc_messages TO 'C';` vào `docker/postgres/init/01-roles.sh`, và thêm vào tài liệu cho DBA ở production. Thêm test `missing grant → 500 internal_error`: tạo bảng bằng owner mà không có default privilege cho `app_user`, rồi query.

Retry trong `src/core/database/mikro-orm-unit-of-work.ts`:
```ts
run<T>(fn: () => Promise<T>, opts: { isolation?: Isolation } = {}): Promise<T> {
  const em = this.txEm.get();
  if (em.isInTransaction()) return fn();
  return this.withRetry(() => em.transactional((tx) => this.txEm.bind(tx, fn), opts.isolation ? { isolationLevel: ISOLATION[opts.isolation] } : undefined));
}

private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= this.cfg.txRetryAttempts || !isRetryableTxError(err)) throw err;
      const cap = this.cfg.txRetryBaseMs * 2 ** i;
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
  }
}
```
(Inject `databaseConfig.KEY` vào constructor dưới tên `cfg`. `em.transactional` fork EM mới cho mỗi lần thử, nên lần sau không bị ảnh hưởng bởi trạng thái của lần trước. Verify điều này trong tài liệu `transactions`.)

Đăng ký mapper: `DatabaseModule` implement `OnModuleInit` và gọi `registerErrorMapper(dbErrorMapper)` trong `onModuleInit`. Export `defineConstraintErrors`, `dbErrorMapper`, `PG` từ `src/core/database/index.ts`.

Run: `pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 5: ADR 0005 và commit**

`docs/adr/0005-multi-tenant-rls.md`: RLS fail-closed, 3 role, FORCE, FK kép (áp dụng từ sub-project 3), `OrgScope`, và kết quả verify API.
```bash
git add -A
git commit -m "feat(core): org scope with fail-closed RLS, database error mapping and transaction retry"
```

---

### Task 8: `core/queue` — registry, JobQueue, `@JobHandler`, worker host

**Files:**
- Create: `src/core/redis/{redis.config.ts,redis.module.ts,index.ts}`, `src/core/queue/{queue.config.ts,job-definition.ts,job-context.ts,job-handler.decorator.ts,job-queue.ts,bullmq-job-queue.ts,worker-host.ts,queue.module.ts,index.ts}`
- Test: `test/unit/core/queue/job-definition.spec.ts`, `test/integration/core/queue/queue.spec.ts`, `test/fixtures/fixture.jobs.ts`

**Interfaces:**
- Consumes: `defineConfig`, `RequestContext`, `AppError`
- Produces:
  - `RedisModule` export token `REDIS` (ioredis `Redis` dùng chung cho producer) và `redisConnectionOptions(): RedisOptions`
  - `defineQueue(name: string, opts: { kind: 'io' | 'cpu' })` trả về `QueueDef = { name; kind }`. Registry: `queueRegistry()`
  - `defineJob<S extends z.ZodType>(def: { name: string; queue: QueueDef; version: number; schema: S })` trả về `JobDef<S>`
  - `@JobHandler(job: JobDef)` trên class có method `handle(ctx: JobContext<z.infer<S>>): Promise<void>`
  - `JobContext<P> = { payload: P; jobId: string; attempt: number; maxAttempts: number; signal: AbortSignal; log: Logger }`
  - `abstract class JobQueue { enqueue<S>(job: JobDef<S>, payload: z.infer<S>, opts?: EnqueueOpts): Promise<string>; enqueueMany(items: EnqueueItem[]): Promise<string[]> }`, `EnqueueOpts = { jobId?: string; delayMs?: number }`
  - `JobPayloadError` (payload sai, không retry)
  - `WorkerHost`: tạo BullMQ Worker cho các queue có trong `WORKER_QUEUES`, `closeAll(): Promise<void>`
  - Job data trên dây: `{ v: number; p: unknown; meta: { requestId?: string; traceparent?: string; orgId?: string } }`

- [ ] **Step 1: Cài package**

```bash
for p in bullmq ioredis; do pnpm view $p dist-tags peerDependencies; done
pnpm add bullmq ioredis
```
Ghi vào ADR 0006: không dùng `@nestjs/bullmq`, vì dispatcher cần tạo Worker theo config lúc chạy (`WORKER_QUEUES`) và handler không được import BullMQ. `@nestjs/bullmq` gắn processor với class ngay lúc biên dịch.

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
  it('rejects payload of unknown version', () => {
    expect(() => decodeJobData(job, { v: 3, p: { n: 1 }, meta: {} })).toThrow(JobPayloadError);
  });
  it('rejects invalid payload shape', () => {
    expect(() => decodeJobData(job, { v: 2, p: { n: 'x' }, meta: {} })).toThrow(JobPayloadError);
  });
  it('rejects duplicate queue and job names', () => {
    expect(() => defineQueue('unit-q', { kind: 'io' })).toThrow(/already defined/);
    expect(() => defineJob({ name: 'unit.echo', queue: q, version: 1, schema: z.object({}) })).toThrow(/already defined/);
  });
});
```
`test/fixtures/fixture.jobs.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { defineJob, defineQueue, JobHandler, type JobContext } from '../../src/core/queue/index.js';

export const FixtureQueue = defineQueue('fixture', { kind: 'io' });
export const RecordJob = defineJob({ name: 'fixture.record', queue: FixtureQueue, version: 1, schema: z.object({ key: z.string() }) });
export const SlowJob = defineJob({ name: 'fixture.slow', queue: FixtureQueue, version: 1, schema: z.object({ key: z.string(), ms: z.number() }) });
export const FlakyJob = defineJob({ name: 'fixture.flaky', queue: FixtureQueue, version: 1, schema: z.object({ key: z.string(), failTimes: z.number() }) });

export const seen: { key: string; attempt: number; requestId?: string }[] = [];

@Injectable()
@JobHandler(RecordJob)
export class RecordHandler {
  async handle(ctx: JobContext<{ key: string }>) { seen.push({ key: ctx.payload.key, attempt: ctx.attempt, requestId: ctx.meta.requestId }); }
}

@Injectable()
@JobHandler(SlowJob)
export class SlowHandler {
  async handle(ctx: JobContext<{ key: string; ms: number }>) {
    await new Promise((r) => setTimeout(r, ctx.payload.ms));
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt });
  }
}

@Injectable()
@JobHandler(FlakyJob)
export class FlakyHandler {
  async handle(ctx: JobContext<{ key: string; failTimes: number }>) {
    if (ctx.attempt <= ctx.payload.failTimes) throw new Error(`flaky attempt ${ctx.attempt}`);
    seen.push({ key: ctx.payload.key, attempt: ctx.attempt });
  }
}
```
`test/integration/core/queue/queue.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { JobQueue, QueueModule, WorkerHost } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { FlakyHandler, FlakyJob, RecordHandler, RecordJob, SlowHandler, seen } from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';

@Module({ providers: [RecordHandler, SlowHandler, FlakyHandler] })
class Handlers {}

async function waitFor(pred: () => boolean, timeoutMs = 15_000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('queue', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('REDIS_URL', getInfra().redis.url);
    vi.stubEnv('WORKER_QUEUES', 'fixture');
    vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '50');
    app = await createTestApp([RedisModule, QueueModule.forRoot({ runWorkers: true }), Handlers], { http: false });
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('delivers payload and meta to the handler', async () => {
    await app.get(JobQueue).enqueue(RecordJob, { key: 'k1' }, { meta: { requestId: 'req-9' } });
    await waitFor(() => seen.some((s) => s.key === 'k1'));
    expect(seen.find((s) => s.key === 'k1')).toMatchObject({ attempt: 1, requestId: 'req-9' });
  });

  it('dedupes by explicit jobId', async () => {
    const q = app.get(JobQueue);
    await q.enqueue(RecordJob, { key: 'dup' }, { jobId: 'dup-1' });
    await q.enqueue(RecordJob, { key: 'dup' }, { jobId: 'dup-1' });
    await waitFor(() => seen.some((s) => s.key === 'dup'));
    await new Promise((r) => setTimeout(r, 500));
    expect(seen.filter((s) => s.key === 'dup')).toHaveLength(1);
  });

  it('retries with backoff until success', async () => {
    await app.get(JobQueue).enqueue(FlakyJob, { key: 'flaky', failTimes: 2 });
    await waitFor(() => seen.some((s) => s.key === 'flaky'));
    expect(seen.find((s) => s.key === 'flaky')!.attempt).toBe(3);
  });

  it('rejects invalid payload at enqueue time', async () => {
    await expect(app.get(JobQueue).enqueue(RecordJob, { key: 1 } as never)).rejects.toThrow(/payload/i);
  });

  it('closeAll waits for in-flight jobs', async () => {
    await app.get(JobQueue).enqueue((await import('../../../fixtures/fixture.jobs.js')).SlowJob, { key: 'slow', ms: 800 });
    await new Promise((r) => setTimeout(r, 200));
    await app.get(WorkerHost).closeAll();
    expect(seen.some((s) => s.key === 'slow')).toBe(true);
  });
});
```
Run: `pnpm test && pnpm build && pnpm test:int`
Expected: FAIL, vì module chưa có.

- [ ] **Step 3: Redis module**

Verify: cách BullMQ 6 nhận kết nối (sau khi bỏ `Connection`, dùng `BackendFactory`/`connection` option). Xem release note `https://github.com/taskforcesh/bullmq/releases/tag/v6.0.0` và tài liệu `https://docs.bullmq.io`. BullMQ yêu cầu `maxRetriesPerRequest: null` cho kết nối của Worker. Code dưới đây dùng option `connection` (ioredis options). Nếu v6 đòi cách khác thì sửa `bullmq-job-queue.ts` và `worker-host.ts` theo tài liệu.

`src/core/redis/redis.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const redisConfig = defineConfig(
  'redis',
  { url: 'REDIS_URL', keyPrefix: 'REDIS_KEY_PREFIX', commandTimeoutMs: 'REDIS_COMMAND_TIMEOUT_MS' },
  z.object({
    url: z.url().describe('Redis connection URL (redis:// or rediss://)'),
    keyPrefix: z.string().regex(/^[a-z0-9-]+$/).default('app').describe('Prefix for every Redis key of this service'),
    commandTimeoutMs: z.coerce.number().int().positive().default(1000).describe('ioredis commandTimeout for non-blocking clients'),
  }),
);
```
`src/core/redis/redis.module.ts`:
```ts
import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { type ConfigOf } from '../config/index.js';
import { redisConfig } from './redis.config.js';

export const REDIS = Symbol('core.redis');

export function redisConnectionOptions(cfg: ConfigOf<typeof redisConfig>, blocking: boolean): RedisOptions & { url: string } {
  return { url: cfg.url, maxRetriesPerRequest: blocking ? null : 3, commandTimeout: blocking ? undefined : cfg.commandTimeoutMs, lazyConnect: false };
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [redisConfig.KEY],
      useFactory: (cfg: ConfigOf<typeof redisConfig>) => {
        const { url, ...opts } = redisConnectionOptions(cfg, false);
        return new Redis(url, opts);
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
```
`src/core/redis/index.ts`: export `RedisModule`, `REDIS`, `redisConfig`, `redisConnectionOptions`. Thêm import config vào `all-configs.ts`. Thêm `REDIS_URL: getInfra().redis.url` vào `baseTestEnv()` (`test/support/env.ts`).

- [ ] **Step 4: Định nghĩa queue/job, codec**

`src/core/queue/queue.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const queueConfig = defineConfig(
  'queue',
  {
    workerQueues: 'WORKER_QUEUES', attempts: 'QUEUE_DEFAULT_ATTEMPTS', backoffMs: 'QUEUE_DEFAULT_BACKOFF_MS',
    keepCompletedAgeSec: 'QUEUE_KEEP_COMPLETED_AGE_SEC', keepCompletedCount: 'QUEUE_KEEP_COMPLETED_COUNT',
    keepFailedAgeSec: 'QUEUE_KEEP_FAILED_AGE_SEC', ioConcurrency: 'QUEUE_IO_CONCURRENCY', cpuConcurrency: 'QUEUE_CPU_CONCURRENCY',
    shutdownTimeoutMs: 'QUEUE_SHUTDOWN_TIMEOUT_MS', concurrencyOverrides: 'QUEUE_CONCURRENCY_OVERRIDES',
  },
  z.object({
    workerQueues: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).describe('Comma-separated queues this worker consumes; empty = all registered queues'),
    attempts: z.coerce.number().int().min(1).default(5).describe('Default max attempts per job'),
    backoffMs: z.coerce.number().int().positive().default(2000).describe('Base delay for exponential backoff'),
    keepCompletedAgeSec: z.coerce.number().int().positive().default(3600).describe('Remove completed jobs older than this'),
    keepCompletedCount: z.coerce.number().int().positive().default(1000).describe('Keep at most this many completed jobs per queue'),
    keepFailedAgeSec: z.coerce.number().int().positive().default(604800).describe('Remove failed jobs older than this'),
    ioConcurrency: z.coerce.number().int().positive().default(20).describe('Default concurrency for io queues'),
    cpuConcurrency: z.coerce.number().int().positive().default(1).describe('Default concurrency for cpu queues'),
    shutdownTimeoutMs: z.coerce.number().int().positive().default(25000).describe('Max wait for in-flight jobs on shutdown'),
    concurrencyOverrides: z.string().default('').transform((s) => Object.fromEntries(s.split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k!.trim(), Number(v)]; }))).describe('Per-queue concurrency, e.g. "billing=1,notifications=50"'),
  }),
);
```
`src/core/queue/job-definition.ts`:
```ts
import type { z } from 'zod';

export type QueueDef = { readonly name: string; readonly kind: 'io' | 'cpu' };
export type JobMeta = { requestId?: string; traceparent?: string; orgId?: string };
export type JobData = { v: number; p: unknown; meta: JobMeta };
export type JobDef<S extends z.ZodType = z.ZodType> = { readonly name: string; readonly queue: QueueDef; readonly version: number; readonly schema: S };

export class JobPayloadError extends Error {
  constructor(job: string, detail: string) {
    super(`Invalid payload for job "${job}": ${detail}`);
    this.name = 'JobPayloadError';
  }
}

const queues = new Map<string, QueueDef>();
const jobs = new Map<string, JobDef>();

export function defineQueue(name: string, opts: { kind: 'io' | 'cpu' }): QueueDef {
  if (queues.has(name)) throw new Error(`Queue "${name}" already defined`);
  const def = { name, kind: opts.kind } as const;
  queues.set(name, def);
  return def;
}
export function defineJob<S extends z.ZodType>(def: { name: string; queue: QueueDef; version: number; schema: S }): JobDef<S> {
  if (jobs.has(def.name)) throw new Error(`Job "${def.name}" already defined`);
  jobs.set(def.name, def);
  return def;
}
export const queueRegistry = (): QueueDef[] => [...queues.values()];
export const jobRegistry = (): JobDef[] => [...jobs.values()];

export function encodeJobData<S extends z.ZodType>(job: JobDef<S>, payload: z.infer<S>, meta: JobMeta): JobData {
  const parsed = job.schema.safeParse(payload);
  if (!parsed.success) throw new JobPayloadError(job.name, parsed.error.message);
  return { v: job.version, p: parsed.data, meta };
}
export function decodeJobData<S extends z.ZodType>(job: JobDef<S>, data: unknown): { payload: z.infer<S>; meta: JobMeta } {
  const d = data as Partial<JobData>;
  if (d?.v !== job.version) throw new JobPayloadError(job.name, `unsupported version ${String(d?.v)} (expected ${job.version})`);
  const parsed = job.schema.safeParse(d.p);
  if (!parsed.success) throw new JobPayloadError(job.name, parsed.error.message);
  return { payload: parsed.data, meta: d.meta ?? {} };
}
```
`src/core/queue/job-context.ts`:
```ts
import type { Logger } from '@nestjs/common';
import type { JobMeta } from './job-definition.js';

export type JobContext<P> = {
  payload: P;
  meta: JobMeta;
  jobId: string;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  log: Logger;
};
```
`src/core/queue/job-handler.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import type { JobDef } from './job-definition.js';

export const JOB_HANDLER = Symbol('core.jobHandler');
export const JobHandler = (job: JobDef): ClassDecorator => SetMetadata(JOB_HANDLER, job);
export interface JobHandlerInstance<P = unknown> { handle(ctx: import('./job-context.js').JobContext<P>): Promise<void> }
```
Run: `pnpm test`
Expected: PASS test codec.

- [ ] **Step 5: JobQueue (producer) + WorkerHost (consumer)**

Verify với tài liệu BullMQ 6: constructor `Queue(name, { connection, prefix, defaultJobOptions })`, `queue.add(name, data, { jobId, delay })`, `queue.addBulk([{ name, data, opts }])`, `new Worker(name, processor, { connection, prefix, concurrency, useWorkerThreads?/sandboxed })`, `job.attemptsMade`, `job.opts.attempts`, `UnrecoverableError`, `worker.close()`, và cách chuyền abort signal khi đóng (`https://docs.bullmq.io/guide/workers/cancelling-jobs` nếu có).

`src/core/queue/job-queue.ts`:
```ts
import type { z } from 'zod';
import type { JobDef, JobMeta } from './job-definition.js';

export type EnqueueOpts = { jobId?: string; delayMs?: number; meta?: JobMeta };
export type EnqueueItem = { job: JobDef; payload: unknown; opts?: EnqueueOpts };

export abstract class JobQueue {
  abstract enqueue<S extends z.ZodType>(job: JobDef<S>, payload: z.infer<S>, opts?: EnqueueOpts): Promise<string>;
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
import { redisConfig, redisConnectionOptions } from '../redis/index.js';
import { encodeJobData, type JobDef } from './job-definition.js';
import { JobQueue, type EnqueueItem, type EnqueueOpts } from './job-queue.js';
import { queueConfig } from './queue.config.js';

@Injectable()
export class BullmqJobQueue extends JobQueue implements OnApplicationShutdown {
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(redisConfig.KEY) private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(queueConfig.KEY) private readonly cfg: ConfigOf<typeof queueConfig>,
    private readonly ctx: RequestContext,
  ) { super(); }

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      const { url, ...conn } = redisConnectionOptions(this.redis, false);
      q = new Queue(name, {
        connection: { ...conn, url } as never,
        prefix: this.redis.keyPrefix,
        defaultJobOptions: {
          attempts: this.cfg.attempts,
          backoff: { type: 'exponential', delay: this.cfg.backoffMs },
          removeOnComplete: { age: this.cfg.keepCompletedAgeSec, count: this.cfg.keepCompletedCount },
          removeOnFail: { age: this.cfg.keepFailedAgeSec },
        },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<S extends z.ZodType>(job: JobDef<S>, payload: z.infer<S>, opts: EnqueueOpts = {}): Promise<string> {
    const data = encodeJobData(job, payload, { requestId: this.ctx.requestId(), orgId: this.ctx.orgId(), ...opts.meta });
    const added = await this.queue(job.queue.name).add(job.name, data, { jobId: opts.jobId, delay: opts.delayMs });
    return added.id!;
  }

  async enqueueMany(items: EnqueueItem[]): Promise<string[]> {
    const byQueue = new Map<string, { name: string; data: unknown; opts: { jobId?: string; delay?: number } }[]>();
    for (const it of items) {
      const data = encodeJobData(it.job, it.payload, { requestId: this.ctx.requestId(), orgId: this.ctx.orgId(), ...it.opts?.meta });
      const list = byQueue.get(it.job.queue.name) ?? [];
      list.push({ name: it.job.name, data, opts: { jobId: it.opts?.jobId, delay: it.opts?.delayMs } });
      byQueue.set(it.job.queue.name, list);
    }
    const ids: string[] = [];
    for (const [name, list] of byQueue) ids.push(...(await this.queue(name).addBulk(list)).map((j) => j.id!));
    return ids;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
```
Verify: BullMQ 6 có nhận ioredis options kèm `url` trong `connection` không. Nếu không thì tạo `new Redis(url, opts)` rồi truyền instance vào theo tài liệu. Cast `as never` phải được bỏ sau khi verify xong: dùng đúng type BullMQ export (quy tắc không dùng `any`, không cast mù).

`src/core/queue/worker-host.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { redisConfig, redisConnectionOptions } from '../redis/index.js';
import { JOB_HANDLER, type JobHandlerInstance } from './job-handler.decorator.js';
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
    @Inject(redisConfig.KEY) private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(queueConfig.KEY) private readonly cfg: ConfigOf<typeof queueConfig>,
    @Inject(WORKER_HOST_OPTIONS) private readonly opts: WorkerHostOptions,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const def = wrapper.metatype ? Reflect.getMetadata(JOB_HANDLER, wrapper.metatype) as JobDef | undefined : undefined;
      if (!def || !wrapper.instance) continue;
      if (this.handlers.has(def.name)) throw new Error(`Duplicate @JobHandler for "${def.name}"`);
      this.handlers.set(def.name, { def, instance: wrapper.instance as JobHandlerInstance });
    }
    if (!this.opts.runWorkers) return;
    const wanted = this.cfg.workerQueues.length ? this.cfg.workerQueues : queueRegistry().map((q) => q.name);
    for (const name of wanted) {
      const q = queueRegistry().find((x) => x.name === name);
      if (!q) throw new Error(`WORKER_QUEUES contains unknown queue "${name}"`);
      const concurrency = this.cfg.concurrencyOverrides[name] ?? (q.kind === 'cpu' ? this.cfg.cpuConcurrency : this.cfg.ioConcurrency);
      const { url, ...conn } = redisConnectionOptions(this.redis, true);
      this.workers.push(
        new Worker(name, (job, _token, signal) => this.process(job, signal), {
          connection: { ...conn, url } as never,
          prefix: this.redis.keyPrefix,
          concurrency,
        }),
      );
      this.logger.log({ queue: name, concurrency }, 'worker started');
    }
  }

  private async process(job: Job, signal?: AbortSignal): Promise<void> {
    const entry = this.handlers.get(job.name);
    if (!entry) throw new UnrecoverableError(`No handler for job "${job.name}"`);
    let decoded;
    try {
      decoded = decodeJobData(entry.def, job.data);
    } catch (e) {
      if (e instanceof JobPayloadError) throw new UnrecoverableError(e.message);
      throw e;
    }
    await this.ctx.run({ requestId: decoded.meta.requestId, orgId: decoded.meta.orgId }, () =>
      entry.instance.handle({
        payload: decoded.payload,
        meta: decoded.meta,
        jobId: job.id!,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? this.cfg.attempts,
        signal: signal ?? new AbortController().signal,
        log: new Logger(`job:${job.name}`),
      }),
    );
  }

  async closeAll(): Promise<void> {
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), this.cfg.shutdownTimeoutMs));
    const result = await Promise.race([Promise.all(this.workers.map((w) => w.close())).then(() => 'ok' as const), timeout]);
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
Verify: chữ ký processor của BullMQ 6 có tham số `signal` thứ ba không. Nếu không có thì bỏ tham số đó và tạo `AbortController` trong `WorkerHost`, gọi `abort()` khi bắt đầu tắt. Verify `job.attemptsMade` có đếm lần đang chạy hay không, để `attempt` bắt đầu từ 1 (test `retries with backoff` sẽ phát hiện nếu sai).

Queue loại `cpu` chạy sandboxed processor: theo tài liệu BullMQ, sandboxed processor nhận **đường dẫn file**, không nhận hàm, nên không dùng lại được handler đã DI. Trong sub-project 1 chưa có handler loại `cpu`. Ghi vào ADR 0006: queue `cpu` sẽ dùng `useWorkerThreads` cùng một file processor riêng khi có use case đầu tiên. `WorkerHost` ném lỗi rõ ràng nếu gặp queue `kind: 'cpu'` mà chưa có cách cài đặt:
```ts
if (q.kind === 'cpu') throw new Error(`Queue "${name}" is cpu-bound; sandboxed processors are not implemented yet (ADR 0006)`);
```
(đặt ngay sau dòng tìm `q`).

`src/core/queue/queue.module.ts`:
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
      providers: [
        BullmqJobQueue,
        { provide: JobQueue, useExisting: BullmqJobQueue },
        { provide: WORKER_HOST_OPTIONS, useValue: opts },
        WorkerHost,
      ],
      exports: [JobQueue, WorkerHost],
    };
  }
}
```
`src/core/queue/index.ts`: export `QueueModule`, `JobQueue`, `WorkerHost`, `JobHandler`, `defineQueue`, `defineJob`, `encodeJobData`, `decodeJobData`, `JobPayloadError`, `queueRegistry`, `jobRegistry`, các type `JobContext`, `JobDef`, `QueueDef`, `EnqueueOpts`, `JobMeta`. Thêm `queue.config` vào `all-configs.ts`.

Gắn vào module gốc: `AppApiModule` import `RedisModule`, `QueueModule.forRoot({ runWorkers: false })`. `AppWorkerModule` import `RedisModule`, `QueueModule.forRoot({ runWorkers: true })`.

Run: `pnpm test && pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): queue registry, versioned job payloads, worker host on bullmq"
```

---

### Task 9: `core/outbox` — writer, relay, inbox, fallback khi Redis sập

**Files:**
- Create: `src/core/outbox/{outbox.config.ts,outbox.writer.ts,outbox.relay.ts,inbox.ts,outbox.jobs.ts,outbox.module.ts,index.ts}`, migration `db/migrations/core/<CLI>_outbox_inbox.ts`, migration `db/migrations/core/<CLI>_drop_bootstrap_probe.ts`
- Test: `test/integration/core/outbox/outbox.spec.ts`

**Interfaces:**
- Consumes: `UnitOfWork`, `TxEm`, `DB_CONTEXT.admin`, `JobQueue`, `defineQueue`, `defineJob`, `JobHandler`, `RequestContext`
- Produces:
  - `NewOutboxEvent = { eventId: string; type: string; version: number; orgId: string | null; aggregate: { type: string; id: string; version: number }; payload: unknown; headers: Record<string, string> }`
  - `OutboxWriter.append(e: NewOutboxEvent): Promise<void>` (ném lỗi nếu không nằm trong UnitOfWork)
  - `OutboxRelay.runOnce(): Promise<number>`, `start()`, `stop()`
  - `EventsQueue = defineQueue('events', { kind: 'io' })`, `DispatchEventJob` (`name: 'core.event.dispatch'`, payload `{ outboxId: string }`), `DeferredJob` (`core.job.deferred`)
  - `Inbox.once(consumer: string, eventId: string, fn: () => Promise<void>): Promise<'processed' | 'duplicate'>`
  - `SafeEnqueue.enqueue(job, payload, opts)`: thử enqueue trực tiếp, lỗi thì ghi outbox `core.job.deferred`
  - `OUTBOX_RELAY_HOOKS` (chỉ cho test): `{ afterEnqueue?: () => Promise<void> }`

- [ ] **Step 1: Migration bằng CLI, rồi viết test**

```bash
pnpm mikro-orm migration:create --blank --path db/migrations/core --name outbox_inbox
pnpm mikro-orm migration:create --blank --path db/migrations/core --name drop_bootstrap_probe
```
Thân `outbox_inbox`:
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
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE processed_events;`);
  this.addSql(`DROP TABLE outbox_events;`);
}
```
(Không đặt `updated_at` trong UPDATE bằng trigger. Relay tự set `updated_at = now()` trong mọi câu UPDATE.)

Thân `drop_bootstrap_probe`: `up` thì `DROP TABLE core_bootstrap_probe;`, `down` thì tạo lại đúng câu `CREATE TABLE` đã viết ở Task 5.

`test/integration/core/outbox/outbox.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseModule, TxEm, UnitOfWork, runMigrations } from '../../../../src/core/database/index.js';
import { DispatchEventJob, EventsQueue, Inbox, OutboxModule, OutboxRelay, OutboxWriter, OUTBOX_RELAY_HOOKS, SafeEnqueue, type NewOutboxEvent } from '../../../../src/core/outbox/index.js';
import { JobHandler, JobQueue, QueueModule, defineJob, type JobContext } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { dbEnv, stubEnv } from '../../../support/db.js';
import { getInfra } from '../../../support/infra.js';

const dispatched: string[] = [];
const Probe = defineJob({ name: 'test.outbox.probe', queue: EventsQueue, version: 1, schema: z.object({ n: z.number() }) });

@Injectable()
@JobHandler(DispatchEventJob)
class DispatchSpy {
  async handle(ctx: JobContext<{ outboxId: string }>) { dispatched.push(ctx.payload.outboxId); }
}
@Module({ providers: [DispatchSpy] })
class Spies {}

const evt = (): NewOutboxEvent => ({
  eventId: randomUUID(), type: 'test.thing.happened', version: 1, orgId: null,
  aggregate: { type: 'thing', id: '1', version: 1 }, payload: { a: 1 }, headers: {},
});
const until = async (pred: () => boolean | Promise<boolean>, ms = 15000) => {
  const t = Date.now();
  while (!(await pred())) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); }
};

describe('outbox', () => {
  let app: INestApplication;
  beforeAll(async () => {
    stubEnv({ ...dbEnv(), APP_ROLE: 'worker', REDIS_URL: getInfra().redis.url, WORKER_QUEUES: 'events', OUTBOX_POLL_INTERVAL_MS: '100', OUTBOX_AUTOSTART: 'false' }, vi.stubEnv);
    await runMigrations('up');
    app = await createTestApp([DatabaseModule.forRoot(), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule, Spies], { http: false });
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });
  beforeEach(() => { dispatched.length = 0; });

  it('append outside a unit of work throws', async () => {
    await expect(app.get(OutboxWriter).append(evt())).rejects.toThrow(/UnitOfWork/);
  });

  it('rolled back transaction leaves no event', async () => {
    const e = evt();
    await expect(app.get(UnitOfWork).run(async () => { await app.get(OutboxWriter).append(e); throw new Error('boom'); })).rejects.toThrow('boom');
    const rows = await app.get(TxEm).get().getConnection().execute('SELECT 1 FROM outbox_events WHERE event_id = ?', [e.eventId]);
    expect(rows).toHaveLength(0);
  });

  it('relay publishes committed events exactly once', async () => {
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    expect(await app.get(OutboxRelay).runOnce()).toBeGreaterThanOrEqual(1);
    await until(() => dispatched.length >= 1);
    expect(await app.get(OutboxRelay).runOnce()).toBe(0);
  });

  it('concurrent relays never publish the same row twice', async () => {
    const ids = Array.from({ length: 50 }, evt);
    await app.get(UnitOfWork).run(async () => { for (const e of ids) await app.get(OutboxWriter).append(e); });
    const relay = app.get(OutboxRelay);
    const counts = await Promise.all([relay.runOnce(), relay.runOnce(), relay.runOnce()]);
    await until(() => dispatched.length >= 50);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(50);
    expect(new Set(dispatched).size).toBe(dispatched.length);
  });

  it('enqueue-then-commit-failure: event is re-published but dispatched once (jobId dedupe)', async () => {
    const e = evt();
    await app.get(UnitOfWork).run(() => app.get(OutboxWriter).append(e));
    const hooks = app.get(OUTBOX_RELAY_HOOKS);
    hooks.afterEnqueue = async () => { hooks.afterEnqueue = undefined; throw new Error('commit lost'); };
    await expect(app.get(OutboxRelay).runOnce()).rejects.toThrow('commit lost');
    await app.get(OutboxRelay).runOnce();
    await until(() => dispatched.length >= 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(dispatched).toHaveLength(1);
  });

  it('inbox runs side effect once per consumer+event', async () => {
    const inbox = app.get(Inbox);
    const id = randomUUID();
    let n = 0;
    const r1 = await app.get(UnitOfWork).run(() => inbox.once('c1', id, async () => { n++; }));
    const r2 = await app.get(UnitOfWork).run(() => inbox.once('c1', id, async () => { n++; }));
    const r3 = await app.get(UnitOfWork).run(() => inbox.once('c2', id, async () => { n++; }));
    expect([r1, r2, r3]).toEqual(['processed', 'duplicate', 'processed']);
    expect(n).toBe(2);
  });

  it('inbox side effect failure rolls back the inbox record', async () => {
    const inbox = app.get(Inbox);
    const id = randomUUID();
    await expect(app.get(UnitOfWork).run(() => inbox.once('c3', id, async () => { throw new Error('side effect failed'); }))).rejects.toThrow();
    expect(await app.get(UnitOfWork).run(() => inbox.once('c3', id, async () => {}))).toBe('processed');
  });

  it('SafeEnqueue writes a deferred-job event when direct enqueue fails', async () => {
    vi.spyOn(app.get(JobQueue), 'enqueue').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await app.get(SafeEnqueue).enqueue(Probe, { n: 42 });
    const rows = await app.get(TxEm).get().getConnection().execute<{ payload: { job: string; payload: { n: number } } }[]>(
      `SELECT payload FROM outbox_events WHERE type = 'core.job.deferred' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.payload).toMatchObject({ job: 'test.outbox.probe', payload: { n: 42 } });
  });

  it('SafeEnqueue does not defer invalid payloads', async () => {
    await expect(app.get(SafeEnqueue).enqueue(Probe, { n: 'x' } as never)).rejects.toThrow(/payload/i);
  });
});
```
(Test `SafeEnqueue` dùng spy để giả Redis lỗi. Phần đưa job bị hoãn vào queue lại nằm ở Task 10, và có test riêng ở đó. Chaos test ở Task 19 cắt mạng Redis thật.)

Run: `pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 2: Cài đặt**

`src/core/outbox/outbox.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const outboxConfig = defineConfig(
  'outbox',
  {
    pollIntervalMs: 'OUTBOX_POLL_INTERVAL_MS', batchSize: 'OUTBOX_BATCH_SIZE', autostart: 'OUTBOX_AUTOSTART',
    retentionDays: 'OUTBOX_RETENTION_DAYS', inboxRetentionDays: 'INBOX_RETENTION_DAYS',
    attemptsAlertThreshold: 'OUTBOX_ATTEMPTS_ALERT_THRESHOLD', cleanupCron: 'OUTBOX_CLEANUP_CRON', cleanupTz: 'OUTBOX_CLEANUP_TZ',
  },
  z.object({
    pollIntervalMs: z.coerce.number().int().positive().default(1000).describe('Relay poll interval'),
    batchSize: z.coerce.number().int().positive().max(1000).default(100).describe('Rows claimed per relay iteration'),
    autostart: z.stringbool().default(true).describe('Start relay loop on worker bootstrap'),
    retentionDays: z.coerce.number().int().positive().default(7).describe('Delete published outbox rows older than this'),
    inboxRetentionDays: z.coerce.number().int().positive().default(30).describe('Delete inbox records older than this'),
    attemptsAlertThreshold: z.coerce.number().int().positive().default(10).describe('Log error when publish attempts exceed this'),
    cleanupCron: z.string().min(1).default('0 5 * * *').describe('Cron for outbox/inbox cleanup'),
    cleanupTz: z.string().min(1).default('Asia/Ho_Chi_Minh').describe('Timezone for cleanup cron'),
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
export const DeferredJobPayload = z.object({ job: z.string(), payload: z.unknown(), jobId: z.string().optional(), delayMs: z.number().optional() });
```
`src/core/outbox/outbox.writer.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { TxEm, UnitOfWork } from '../database/index.js';

export type NewOutboxEvent = {
  eventId: string; type: string; version: number; orgId: string | null;
  aggregate: { type: string; id: string; version: number };
  payload: unknown; headers: Record<string, string>;
};

@Injectable()
export class OutboxWriter {
  constructor(private readonly uow: UnitOfWork, private readonly txEm: TxEm) {}

  async append(e: NewOutboxEvent): Promise<void> {
    if (!this.uow.inTransaction()) throw new Error('OutboxWriter.append must be called inside UnitOfWork.run');
    await this.txEm.get().getConnection().execute(
      `INSERT INTO outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
      [e.eventId, e.type, e.version, e.orgId, e.aggregate.type, e.aggregate.id, e.aggregate.version, JSON.stringify(e.payload), JSON.stringify(e.headers)],
    );
  }
}
```
Verify: `getConnection().execute` có dùng connection của transaction đang mở không (xem Task 5, Step 6). Nếu không thì dùng `em.execute`.

`src/core/outbox/outbox.relay.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { type ConfigOf, appConfig } from '../config/index.js';
import { DB_CONTEXT } from '../database/index.js';
import { JobQueue } from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { DispatchEventJob } from './outbox.jobs.js';

export const OUTBOX_RELAY_HOOKS = Symbol('core.outboxRelayHooks');
export type OutboxRelayHooks = { afterEnqueue?: () => Promise<void> };

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(
    @InjectEntityManager(DB_CONTEXT.admin) private readonly adminEm: EntityManager,
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
      this.running = this.runOnce().catch((err: unknown) => this.logger.error({ err }, 'outbox relay iteration failed'));
      await this.running;
      if (!this.stopped) this.timer = setTimeout(tick, this.cfg.pollIntervalMs);
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

  async runOnce(): Promise<number> {
    const em = this.adminEm.fork();
    let claimedIds: string[] = [];
    try {
      return await em.transactional(async (tx) => {
        const conn = tx.getConnection();
        const rows = await conn.execute<{ id: string; publish_attempts: number; headers: Record<string, string> }[]>(
          `SELECT id::text AS id, publish_attempts, headers FROM outbox_events
           WHERE published_at IS NULL ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
          [this.cfg.batchSize],
        );
        if (rows.length === 0) return 0;
        claimedIds = rows.map((r) => r.id);
        await this.queue.enqueueMany(
          rows.map((r) => ({
            job: DispatchEventJob,
            payload: { outboxId: r.id },
            opts: { jobId: `outbox-${r.id}`, meta: { traceparent: r.headers.traceparent } },
          })),
        );
        await this.hooks.afterEnqueue?.();
        await conn.execute(`UPDATE outbox_events SET published_at = now(), updated_at = now() WHERE id = ANY(?::bigint[])`, [claimedIds]);
        return rows.length;
      });
    } catch (err) {
      if (claimedIds.length) await this.recordFailedAttempt(claimedIds);
      throw err;
    }
  }

  private async recordFailedAttempt(ids: string[]): Promise<void> {
    const rows = await this.adminEm.fork().getConnection().execute<{ id: string; publish_attempts: number }[]>(
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
Chú ý: `jobId` là `outbox-<id>`. Không dùng `event_id` làm jobId ở đây, vì một số version của BullMQ không cho jobId toàn số. Đổi lại, dispatch dùng id nội bộ để đọc lại dòng outbox (Task 10).

`src/core/outbox/inbox.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { TxEm, UnitOfWork } from '../database/index.js';

@Injectable()
export class Inbox {
  constructor(private readonly uow: UnitOfWork, private readonly txEm: TxEm) {}

  async once(consumer: string, eventId: string, fn: () => Promise<void>): Promise<'processed' | 'duplicate'> {
    if (!this.uow.inTransaction()) throw new Error('Inbox.once must be called inside UnitOfWork.run');
    const rows = await this.txEm.get().getConnection().execute<{ consumer: string }[]>(
      `INSERT INTO processed_events (consumer, event_id) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING consumer`,
      [consumer, eventId],
    );
    if (rows.length === 0) return 'duplicate';
    await fn();
    return 'processed';
  }
}
```
`SafeEnqueue` (`src/core/outbox/safe-enqueue.ts`):
```ts
import { Injectable, Logger } from '@nestjs/common';
import { v7 } from 'uuid';
import type { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { UnitOfWork } from '../database/index.js';
import { JobQueue, type EnqueueOpts, type JobDef } from '../queue/index.js';
import { DEFERRED_JOB_EVENT_TYPE } from './outbox.jobs.js';
import { OutboxWriter } from './outbox.writer.js';

@Injectable()
export class SafeEnqueue {
  private readonly logger = new Logger(SafeEnqueue.name);
  constructor(private readonly queue: JobQueue, private readonly outbox: OutboxWriter, private readonly uow: UnitOfWork, private readonly ctx: RequestContext) {}

  async enqueue<S extends z.ZodType>(job: JobDef<S>, payload: z.infer<S>, opts: EnqueueOpts = {}): Promise<void> {
    try {
      await this.queue.enqueue(job, payload, opts);
    } catch (err) {
      this.logger.warn({ err, job: job.name }, 'direct enqueue failed; deferring via outbox');
      const write = () => this.outbox.append({
        eventId: v7(), type: DEFERRED_JOB_EVENT_TYPE, version: 1, orgId: this.ctx.orgId() ?? null,
        aggregate: { type: 'job', id: opts.jobId ?? job.name, version: 1 },
        payload: { job: job.name, payload, jobId: opts.jobId, delayMs: opts.delayMs }, headers: {},
      });
      await (this.uow.inTransaction() ? write() : this.uow.run(write));
    }
  }
}
```
`JobPayloadError` (payload sai) không được đi vào nhánh fallback. Thêm vào đầu khối `catch`: `if (err instanceof JobPayloadError) throw err;` (import từ `../queue/index.js`).

Handler cho event `core.job.deferred` được cài ở Task 10: dispatch đọc dòng outbox, gặp type này thì enqueue lại job gốc bằng `jobRegistry()`.

`src/core/outbox/outbox.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { Inbox } from './inbox.js';
import { OUTBOX_RELAY_HOOKS, OutboxRelay } from './outbox.relay.js';
import { OutboxWriter } from './outbox.writer.js';
import { SafeEnqueue } from './safe-enqueue.js';

@Global()
@Module({
  providers: [OutboxWriter, OutboxRelay, Inbox, SafeEnqueue, { provide: OUTBOX_RELAY_HOOKS, useValue: {} }],
  exports: [OutboxWriter, OutboxRelay, Inbox, SafeEnqueue, OUTBOX_RELAY_HOOKS],
})
export class OutboxModule {}
```
`src/core/outbox/index.ts`: export mọi thứ đã liệt kê ở Interfaces. Thêm config vào `all-configs.ts`. Thêm `OutboxModule` vào cả hai module gốc.

Run: `pnpm build && pnpm test:int`
Expected: PASS toàn bộ test outbox.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): transactional outbox, skip-locked relay, inbox dedupe, redis-down fallback"
```

---

### Task 10: `core/events` — envelope, định nghĩa event, subscriber, fan-out

**Files:**
- Create: `src/core/events/{event-definition.ts,envelope.ts,subscriber.decorator.ts,event-publisher.ts,event-dispatch.handlers.ts,events.module.ts,index.ts}`
- Create: `test/fixtures/fixture.events.ts`, `test/fixtures/fixture.controller.ts`
- Test: `test/unit/core/events/envelope.spec.ts`, `test/e2e/core/events.e2e.spec.ts`

**Interfaces:**
- Consumes: `OutboxWriter`, `Inbox`, `UnitOfWork`, `JobQueue`, `defineJob`, `JobHandler`, `EventsQueue`, `DispatchEventJob`, `DEFERRED_JOB_EVENT_TYPE`, `jobRegistry`, `DB_CONTEXT.admin`
- Produces:
  - `defineEvent<S>({ type, version, schema })` trả về `EventDef<S>`. Registry: `eventRegistry()`
  - `EventEnvelope<P> = { id; type; version; occurredAt: string; orgId: string | null; actor: { type: 'user' | 'system' | 'service'; id: string }; aggregate: { type; id; version }; correlationId: string; causationId: string | null; traceparent?: string; data: P }`
  - `EventPublisher.publish<S>(def: EventDef<S>, input: { data: z.infer<S>; aggregate; actor; orgId?: string | null; causationId?: string }): Promise<string>` (phải chạy trong UnitOfWork)
  - `@EventSubscriber({ consumer: string; event: EventDef })` trên class có `handle(e: EventEnvelope<P>): Promise<void>`
  - `DeliverEventJob` (`core.event.deliver`, payload `{ consumer: string; outboxId: string }`)

- [ ] **Step 1: Viết test trước**

`test/unit/core/events/envelope.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent, parseEnvelope } from '../../../../src/core/events/index.js';

const Created = defineEvent({ type: 'unit.thing.created', version: 1, schema: z.object({ name: z.string() }) });

describe('event envelope', () => {
  it('rejects duplicate type@version', () => {
    expect(() => defineEvent({ type: 'unit.thing.created', version: 1, schema: z.object({}) })).toThrow(/already defined/);
  });
  it('rejects type not in context.aggregate.verb form', () => {
    expect(() => defineEvent({ type: 'BadName', version: 1, schema: z.object({}) })).toThrow(/context\.aggregate\.verb/);
  });
  it('validates data against the event schema', () => {
    const base = { id: crypto.randomUUID(), type: Created.type, version: 1, occurredAt: new Date().toISOString(), orgId: null,
      actor: { type: 'system', id: 'test' }, aggregate: { type: 'thing', id: '1', version: 1 }, correlationId: crypto.randomUUID(), causationId: null };
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

@Injectable()
@EventSubscriber({ consumer: 'fixture.audit', event: NoteCreated })
export class AuditSubscriber {
  async handle(e: EventEnvelope<{ body: string }>) { received.push({ consumer: 'fixture.audit', body: e.data.body, eventId: e.id }); }
}

@Injectable()
@EventSubscriber({ consumer: 'fixture.mailer', event: NoteCreated })
export class MailerSubscriber {
  async handle(e: EventEnvelope<{ body: string }>) {
    if (failOnce.delete(e.data.body)) throw new Error('mailer down');
    received.push({ consumer: 'fixture.mailer', body: e.data.body, eventId: e.id });
  }
}
```
`test/fixtures/fixture.controller.ts`:
```ts
import { Body, Controller, Post } from '@nestjs/common';
import { UnitOfWork } from '../../src/core/database/index.js';
import { EventPublisher } from '../../src/core/events/index.js';
import { FixtureRepo } from './fixture.module.js';
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
```
Thêm `FixtureNotesController` vào `FixtureModule` (controllers).

`test/e2e/core/events.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule, runMigrations } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OutboxModule, OutboxRelay, SafeEnqueue } from '../../../src/core/outbox/index.js';
import { JobHandler, JobQueue, QueueModule, defineJob, type JobContext } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { FixtureModule } from '../../fixtures/fixture.module.js';
import { FixtureQueue } from '../../fixtures/fixture.jobs.js';
import { AuditSubscriber, MailerSubscriber, failOnce, received } from '../../fixtures/fixture.events.js';
import { createTestApp } from '../../support/app-factory.js';
import { dbEnv, stubEnv } from '../../support/db.js';
import { getInfra } from '../../support/infra.js';

const DeferredProbe = defineJob({ name: 'fixture.deferred.probe', queue: FixtureQueue, version: 1, schema: z.object({ n: z.number() }) });
const deferredRuns: number[] = [];
@Injectable()
@JobHandler(DeferredProbe)
class DeferredProbeHandler { async handle(ctx: JobContext<{ n: number }>) { deferredRuns.push(ctx.payload.n); } }

@Module({ providers: [AuditSubscriber, MailerSubscriber, DeferredProbeHandler] })
class Subs {}
const until = async (pred: () => boolean, ms = 15000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };

describe('events end-to-end', () => {
  let app: INestApplication;
  beforeAll(async () => {
    stubEnv({ ...dbEnv(), APP_ROLE: 'worker', REDIS_URL: getInfra().redis.url, WORKER_QUEUES: 'events,fixture', OUTBOX_POLL_INTERVAL_MS: '50', QUEUE_DEFAULT_BACKOFF_MS: '50' }, vi.stubEnv);
    await runMigrations('up');
    app = await createTestApp([DatabaseModule.forRoot(), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule, EventsModule, FixtureModule, Subs]);
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });
  beforeEach(() => { received.length = 0; });

  it('committed command fans out to every subscriber exactly once', async () => {
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n1' }).expect(201);
    await until(() => received.filter((r) => r.body === 'n1').length >= 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(received.filter((r) => r.body === 'n1').map((r) => r.consumer).sort()).toEqual(['fixture.audit', 'fixture.mailer']);
  });

  it('rolled back command emits nothing', async () => {
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n2', fail: true }).expect(500);
    await app.get(OutboxRelay).runOnce();
    await new Promise((r) => setTimeout(r, 500));
    expect(received.some((r) => r.body === 'n2')).toBe(false);
  });

  it('deferred job (written while Redis was down) is re-enqueued by dispatch and runs', async () => {
    vi.spyOn(app.get(JobQueue), 'enqueue').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await app.get(SafeEnqueue).enqueue(DeferredProbe, { n: 7 });
    await until(() => deferredRuns.includes(7));
  });

  it('one failing subscriber is retried without re-running the other', async () => {
    failOnce.add('n3');
    await request(app.getHttpServer()).post('/fixture/notes').send({ body: 'n3' }).expect(201);
    await until(() => received.filter((r) => r.body === 'n3').length >= 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(received.filter((r) => r.body === 'n3' && r.consumer === 'fixture.audit')).toHaveLength(1);
    expect(received.filter((r) => r.body === 'n3' && r.consumer === 'fixture.mailer')).toHaveLength(1);
  });
});
```
Run: `pnpm test && pnpm build && pnpm test:int`
Expected: FAIL.

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
  id: z.uuid(),
  type: z.string(),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  orgId: z.uuid().nullable(),
  actor: z.object({ type: z.enum(['user', 'system', 'service']), id: z.string().min(1) }),
  aggregate: z.object({ type: z.string().min(1), id: z.string().min(1), version: z.number().int().nonnegative() }),
  correlationId: z.string().min(1),
  causationId: z.string().nullable(),
  traceparent: z.string().optional(),
});
export type EventEnvelope<P> = z.infer<typeof EnvelopeBase> & { data: P };

export function parseEnvelope<S extends z.ZodType>(def: EventDef<S>, raw: unknown): EventEnvelope<z.infer<S>> {
  return EnvelopeBase.extend({ data: def.schema }).parse(raw) as EventEnvelope<z.infer<S>>;
}
```
Verify: `z.iso.datetime` và `z.uuid()` trong zod 4 (`https://zod.dev/api`).

`src/core/events/subscriber.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import type { EventDef } from './event-definition.js';

export const EVENT_SUBSCRIBER = Symbol('core.eventSubscriber');
export type SubscriberMeta = { consumer: string; event: EventDef };
export const EventSubscriber = (meta: SubscriberMeta): ClassDecorator => SetMetadata(EVENT_SUBSCRIBER, meta);
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
    input: { data: z.infer<S>; aggregate: { type: string; id: string; version: number }; actor: { type: 'user' | 'system' | 'service'; id: string }; orgId?: string | null; causationId?: string },
  ): Promise<string> {
    const data = def.schema.parse(input.data);
    const id = v7();
    await this.outbox.append({
      eventId: id, type: def.type, version: def.version, orgId: input.orgId ?? this.ctx.orgId() ?? null,
      aggregate: input.aggregate, payload: data,
      headers: {
        actorType: input.actor.type, actorId: input.actor.id, correlationId: this.ctx.requestId(),
        ...(input.causationId ? { causationId: input.causationId } : {}),
        ...(this.ctx.traceparent() ? { traceparent: this.ctx.traceparent()! } : {}),
      },
    });
    return id;
  }
}
```
ID của event dùng UUIDv7 (`v7()` của package `uuid`, đã cài ở Task 4), theo spec cha mục 6.

`RequestContext.traceparent()` đã có từ Task 4. Task 16 sẽ set giá trị cho nó.

`src/core/events/event-dispatch.handlers.ts`:
```ts
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { DB_CONTEXT, OrgScope, UnitOfWork } from '../database/index.js';
import { DEFERRED_JOB_EVENT_TYPE, DeferredJobPayload, DispatchEventJob, EventsQueue, Inbox } from '../outbox/index.js';
import { JobHandler, JobQueue, defineJob, jobRegistry, type JobContext } from '../queue/index.js';
import { findEvent } from './event-definition.js';
import { parseEnvelope, type EventEnvelope } from './envelope.js';
import { EVENT_SUBSCRIBER, type SubscriberMeta } from './subscriber.decorator.js';

export const DeliverEventJob = defineJob({ name: 'core.event.deliver', queue: EventsQueue, version: 1, schema: z.object({ consumer: z.string(), outboxId: z.string() }) });

type Row = { id: string; event_id: string; type: string; version: number; org_id: string | null; aggregate_type: string; aggregate_id: string; aggregate_version: string; payload: unknown; headers: Record<string, string>; occurred_at: Date };

@Injectable()
export class SubscriberRegistry implements OnApplicationBootstrap {
  readonly byEvent = new Map<string, { meta: SubscriberMeta; instance: { handle(e: EventEnvelope<unknown>): Promise<void> } }[]>();
  readonly byConsumer = new Map<string, { meta: SubscriberMeta; instance: { handle(e: EventEnvelope<unknown>): Promise<void> } }>();
  constructor(private readonly discovery: DiscoveryService) {}
  onApplicationBootstrap(): void {
    for (const w of this.discovery.getProviders()) {
      const meta = w.metatype ? (Reflect.getMetadata(EVENT_SUBSCRIBER, w.metatype) as SubscriberMeta | undefined) : undefined;
      if (!meta || !w.instance) continue;
      if (this.byConsumer.has(meta.consumer)) throw new Error(`Duplicate subscriber consumer "${meta.consumer}"`);
      const entry = { meta, instance: w.instance as never };
      this.byConsumer.set(meta.consumer, entry);
      const key = `${meta.event.type}@${meta.event.version}`;
      this.byEvent.set(key, [...(this.byEvent.get(key) ?? []), entry]);
    }
  }
}

@Injectable()
export class OutboxReader {
  constructor(@InjectEntityManager(DB_CONTEXT.admin) private readonly adminEm: EntityManager) {}
  async load(outboxId: string): Promise<Row> {
    const rows = await this.adminEm.fork().getConnection().execute<Row[]>(
      `SELECT id::text AS id, event_id, type, version, org_id, aggregate_type, aggregate_id,
              aggregate_version::text AS aggregate_version, payload, headers, occurred_at
       FROM outbox_events WHERE id = ?::bigint`,
      [outboxId],
    );
    if (!rows[0]) throw new Error(`Outbox row ${outboxId} not found`);
    return rows[0];
  }
}

export function toEnvelope(row: Row): EventEnvelope<unknown> {
  return {
    id: row.event_id, type: row.type, version: row.version, occurredAt: new Date(row.occurred_at).toISOString(), orgId: row.org_id,
    actor: { type: row.headers.actorType as 'user' | 'system' | 'service', id: row.headers.actorId ?? 'unknown' },
    aggregate: { type: row.aggregate_type, id: row.aggregate_id, version: Number(row.aggregate_version) },
    correlationId: row.headers.correlationId ?? row.event_id, causationId: row.headers.causationId ?? null,
    traceparent: row.headers.traceparent, data: row.payload,
  };
}

@Injectable()
@JobHandler(DispatchEventJob)
export class DispatchEventHandler {
  constructor(private readonly reader: OutboxReader, private readonly subs: SubscriberRegistry, private readonly queue: JobQueue) {}
  async handle(ctx: JobContext<{ outboxId: string }>): Promise<void> {
    const row = await this.reader.load(ctx.payload.outboxId);
    if (row.type === DEFERRED_JOB_EVENT_TYPE) {
      const d = DeferredJobPayload.parse(row.payload);
      const job = jobRegistry().find((j) => j.name === d.job);
      if (!job) throw new Error(`Deferred job "${d.job}" is not registered`);
      await this.queue.enqueue(job, d.payload as never, { jobId: d.jobId ?? `deferred-${row.id}`, delayMs: d.delayMs, meta: { orgId: row.org_id ?? undefined } });
      return;
    }
    const targets = this.subs.byEvent.get(`${row.type}@${row.version}`) ?? [];
    await this.queue.enqueueMany(targets.map((t) => ({ job: DeliverEventJob, payload: { consumer: t.meta.consumer, outboxId: row.id }, opts: { jobId: `deliver-${t.meta.consumer}-${row.id}`, meta: { orgId: row.org_id ?? undefined, traceparent: row.headers.traceparent } } })));
  }
}

@Injectable()
@JobHandler(DeliverEventJob)
export class DeliverEventHandler {
  constructor(private readonly reader: OutboxReader, private readonly subs: SubscriberRegistry, private readonly inbox: Inbox, private readonly uow: UnitOfWork, private readonly orgScope: OrgScope) {}
  async handle(ctx: JobContext<{ consumer: string; outboxId: string }>): Promise<void> {
    const sub = this.subs.byConsumer.get(ctx.payload.consumer);
    if (!sub) throw new Error(`Subscriber "${ctx.payload.consumer}" is not registered in this worker`);
    const row = await this.reader.load(ctx.payload.outboxId);
    const def = findEvent(row.type, row.version);
    if (!def) throw new Error(`Event ${row.type}@${row.version} is not defined`);
    const envelope = parseEnvelope(def, toEnvelope(row));
    const work = () => this.uow.run(() => this.inbox.once(sub.meta.consumer, envelope.id, () => sub.instance.handle(envelope))).then(() => undefined);
    await (envelope.orgId ? this.orgScope.run(envelope.orgId, work) : work());
  }
}
```
Lỗi `Subscriber … not registered` và `Event … not defined` là lỗi cấu hình. Lỗi này để retry bình thường, rồi rơi vào tập failed và phát cảnh báo, vì worker khác có thể đăng ký subscriber đó khi deploy lệch version.

`src/core/events/events.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DeliverEventHandler, DispatchEventHandler, OutboxReader, SubscriberRegistry } from './event-dispatch.handlers.js';
import { EventPublisher } from './event-publisher.js';

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [EventPublisher, SubscriberRegistry, OutboxReader, DispatchEventHandler, DeliverEventHandler],
  exports: [EventPublisher],
})
export class EventsModule {}
```
`src/core/events/index.ts`: export `EventsModule`, `EventPublisher`, `EventSubscriber`, `defineEvent`, `eventRegistry`, `parseEnvelope`, type `EventEnvelope`, `EventDef`, `DeliverEventJob`. Thêm `EventsModule` vào cả hai module gốc.

Run: `pnpm test && pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 3: ADR 0006 và commit**

`docs/adr/0006-queue-outbox.md`: BullMQ trực tiếp (không dùng `@nestjs/bullmq`) kèm lý do. Outbox → dispatch → deliver (mỗi subscriber một job). Inbox. Cách xử lý queue `cpu` về sau. Image PgBouncer đã chọn ở Task 2.
```bash
git add -A
git commit -m "feat(core): versioned domain events with per-subscriber fan-out and inbox"
```

---

### Task 11: `core/scheduler` — cron tĩnh + `scheduled_tasks`

**Files:**
- Create: `src/core/scheduler/{scheduler.config.ts,cron-definition.ts,static-scheduler.ts,scheduled-task.service.ts,scheduler.jobs.ts,scheduler.module.ts,index.ts}`, migration `db/migrations/core/<CLI>_scheduled_tasks.ts`
- Modify: `src/core/queue/bullmq-job-queue.ts` (thêm phương thức cho scheduler), `src/core/outbox/` (đăng ký cron cleanup)
- Test: `test/integration/core/scheduler/scheduler.spec.ts`

**Interfaces:**
- Consumes: `BullmqJobQueue.queue(name)`, `JobDef`, `encodeJobData`, `UnitOfWork`, `TxEm`, `EventPublisher`, `defineEvent`, `EventSubscriber`
- Produces:
  - `defineCron({ key: string; job: JobDef; payload: unknown; schedule: () => { cron: string; tz: string } })` trả về `CronDef` (schedule đọc từ config của module lúc chạy)
  - `StaticScheduler.sync(): Promise<{ upserted: string[]; removed: string[] }>` (gọi lúc worker bootstrap)
  - `ScheduledTaskService.upsert(input: { orgId: string | null; key: string; job: JobDef; cron: string; timezone: string; payload: unknown; enabled: boolean }): Promise<void>`, `remove(orgId, key)`, `reconcile(): Promise<number>`
  - Abstract `JobScheduler`: `upsert(id: string, job: JobDef, payload: unknown, pattern: { cron: string; tz: string }): Promise<void>`, `remove(id: string): Promise<void>`, `listIds(prefix: string): Promise<string[]>`
  - `OutboxCleanupJob` + cron `core.outbox.cleanup`

- [ ] **Step 1: Migration bằng CLI và test**

```bash
pnpm mikro-orm migration:create --blank --path db/migrations/core --name scheduled_tasks
```
```ts
async up(): Promise<void> {
  this.addSql(`CREATE TABLE scheduled_tasks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NULL,
    key TEXT NOT NULL,
    job_name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    payload JSONB NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT scheduled_tasks_org_key_uq UNIQUE NULLS NOT DISTINCT (org_id, key));`);
}
async down(): Promise<void> {
  this.addSql(`DROP TABLE scheduled_tasks;`);
}
```
(Truy vấn `reconcile` đọc toàn bộ bảng, và upsert dùng unique constraint, nên không cần thêm index khác.)

`test/integration/core/scheduler/scheduler.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseModule, runMigrations } from '../../../../src/core/database/index.js';
import { EventsModule } from '../../../../src/core/events/index.js';
import { OutboxModule } from '../../../../src/core/outbox/index.js';
import { JobHandler, JobScheduler, QueueModule, defineJob, type JobContext } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { ScheduledTaskService, SchedulerModule, StaticScheduler, defineCron } from '../../../../src/core/scheduler/index.js';
import { FixtureQueue } from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';
import { dbEnv, stubEnv } from '../../../support/db.js';
import { getInfra } from '../../../support/infra.js';

const ticks: string[] = [];
const Tick = defineJob({ name: 'fixture.tick', queue: FixtureQueue, version: 1, schema: z.object({ src: z.string() }) });
defineCron({ key: 'fixture.every-second', job: Tick, payload: { src: 'static' }, schedule: () => ({ cron: '* * * * * *', tz: 'UTC' }) });

@Injectable() @JobHandler(Tick)
class TickHandler { async handle(ctx: JobContext<{ src: string }>) { ticks.push(`${ctx.payload.src}:${ctx.jobId}`); } }
@Module({ providers: [TickHandler] }) class H {}

const imports = () => [DatabaseModule.forRoot(), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule, EventsModule, SchedulerModule, H];

describe('scheduler', () => {
  let w1: INestApplication; let w2: INestApplication;
  beforeAll(async () => {
    stubEnv({ ...dbEnv(), APP_ROLE: 'worker', REDIS_URL: getInfra().redis.url, WORKER_QUEUES: 'fixture,events', OUTBOX_POLL_INTERVAL_MS: '50' }, vi.stubEnv);
    await runMigrations('up');
    w1 = await createTestApp(imports(), { http: false });
    w2 = await createTestApp(imports(), { http: false });
  });
  afterAll(async () => { await w1.close(); await w2.close(); vi.unstubAllEnvs(); });

  it('static cron fires once per tick across two workers', async () => {
    ticks.length = 0;
    await new Promise((r) => setTimeout(r, 4500));
    const staticTicks = ticks.filter((t) => t.startsWith('static:'));
    expect(staticTicks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(staticTicks).size).toBe(staticTicks.length);
  });

  it('removes schedulers no longer declared', async () => {
    const sched = w1.get(JobScheduler);
    await sched.upsert('static:stale.cron', Tick, { src: 'stale' }, { cron: '0 0 1 1 *', tz: 'UTC' });
    const res = await w1.get(StaticScheduler).sync();
    expect(res.removed).toContain('static:stale.cron');
  });

  it('tenant schedules sync from the table and reconcile repairs drift', async () => {
    const svc = w1.get(ScheduledTaskService);
    await svc.upsert({ orgId: null, key: 'sys.report', job: Tick, cron: '* * * * * *', timezone: 'UTC', payload: { src: 'dyn' }, enabled: true });
    await new Promise((r) => setTimeout(r, 2500));
    expect(ticks.some((t) => t.startsWith('dyn:'))).toBe(true);
    await w1.get(JobScheduler).remove('task:null:sys.report');
    expect(await svc.reconcile()).toBe(1);
  });

  it('rejects invalid cron and timezone', async () => {
    const svc = w1.get(ScheduledTaskService);
    await expect(svc.upsert({ orgId: null, key: 'bad', job: Tick, cron: 'not a cron', timezone: 'UTC', payload: { src: 'x' }, enabled: true })).rejects.toThrow(/cron/i);
    await expect(svc.upsert({ orgId: null, key: 'bad2', job: Tick, cron: '* * * * *', timezone: 'Mars/Base', payload: { src: 'x' }, enabled: true })).rejects.toThrow(/timezone/i);
  });
});
```
Run: `pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 2: Cài đặt**

Verify trong tài liệu BullMQ 6 Job Schedulers (`https://docs.bullmq.io/guide/job-schedulers`): chữ ký `queue.upsertJobScheduler(id, { pattern, tz }, { name, data, opts })`, `queue.removeJobScheduler(id)`, `queue.getJobSchedulers(start, end)` và kiểu trả về (có trường `key`/`id`). Verify cron có trường giây (6 trường) có được hỗ trợ không. Nếu không thì test đổi thành mỗi phút và thời gian chờ tăng tương ứng (dùng `vi.useFakeTimers` là không được, vì lịch nằm trong Redis).

`src/core/scheduler/cron-definition.ts`:
```ts
import type { JobDef } from '../queue/index.js';

export type CronDef = { key: string; job: JobDef; payload: unknown; schedule: () => { cron: string; tz: string } };
const crons = new Map<string, CronDef>();
export function defineCron(def: CronDef): CronDef {
  if (crons.has(def.key)) throw new Error(`Cron "${def.key}" already defined`);
  crons.set(def.key, def);
  return def;
}
export const cronRegistry = (): CronDef[] => [...crons.values()];
```
Vì `schedule()` gọi factory config (ví dụ `() => { const c = outboxConfig(); return { cron: c.cleanupCron, tz: c.cleanupTz }; }`), lịch chạy luôn lấy từ env, không bị hard code tại chỗ khai báo.

Scheduler cho BullMQ đặt trong `core/queue` (chỉ ở đó mới được import `bullmq`). `core/scheduler` chỉ dùng abstract `JobScheduler`.

Thêm vào `src/core/queue/bullmq-job-queue.ts`:
```ts
allQueues(): Queue[] {
  return queueRegistry().map((q) => this.queue(q.name));
}
```
(import `queueRegistry` từ `./job-definition.js`.)

`src/core/queue/core-queues.ts` (queue dùng chung của core, để `core/outbox` và `core/scheduler` cùng dùng mà không phụ thuộc lẫn nhau):
```ts
import { defineQueue } from './job-definition.js';

export const MaintenanceQueue = defineQueue('maintenance', { kind: 'io' });
```
`src/core/queue/bullmq-job-scheduler.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { BullmqJobQueue } from './bullmq-job-queue.js';
import { encodeJobData, type JobDef } from './job-definition.js';

export abstract class JobScheduler {
  abstract upsert(id: string, job: JobDef, payload: unknown, pattern: { cron: string; tz: string }): Promise<void>;
  abstract remove(id: string): Promise<void>;
  abstract listIds(prefix: string): Promise<string[]>;
}

@Injectable()
export class BullmqJobScheduler extends JobScheduler {
  constructor(private readonly queues: BullmqJobQueue) { super(); }
  async upsert(id: string, job: JobDef, payload: unknown, pattern: { cron: string; tz: string }): Promise<void> {
    await this.queues.queue(job.queue.name).upsertJobScheduler(id, { pattern: pattern.cron, tz: pattern.tz }, { name: job.name, data: encodeJobData(job, payload as never, {}) });
  }
  async remove(id: string): Promise<void> {
    for (const q of this.queues.allQueues()) await q.removeJobScheduler(id);
  }
  async listIds(prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (const q of this.queues.allQueues()) for (const s of await q.getJobSchedulers()) if (s.key.startsWith(prefix)) ids.push(s.key);
    return ids;
  }
}
```
Đăng ký trong `QueueModule`: thêm `BullmqJobScheduler` và `{ provide: JobScheduler, useExisting: BullmqJobScheduler }` vào `providers`, thêm `JobScheduler` vào `exports`. Export `JobScheduler`, `MaintenanceQueue` từ `src/core/queue/index.ts`.

`src/core/scheduler/static-scheduler.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { JobScheduler } from '../queue/index.js';
import { cronRegistry } from './cron-definition.js';

export const STATIC_PREFIX = 'static:';

@Injectable()
export class StaticScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(StaticScheduler.name);
  constructor(private readonly scheduler: JobScheduler, @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.app.role !== 'worker') return;
    const res = await this.sync();
    this.logger.log(res, 'static cron synced');
  }

  async sync(): Promise<{ upserted: string[]; removed: string[] }> {
    const declared = cronRegistry();
    const upserted: string[] = [];
    for (const c of declared) {
      const id = `${STATIC_PREFIX}${c.key}`;
      await this.scheduler.upsert(id, c.job, c.payload, c.schedule());
      upserted.push(id);
    }
    const removed: string[] = [];
    for (const id of await this.scheduler.listIds(STATIC_PREFIX)) {
      if (!upserted.includes(id)) { await this.scheduler.remove(id); removed.push(id); }
    }
    return { upserted, removed };
  }
}
```
`src/core/scheduler/scheduled-task.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { CronExpressionParser } from 'cron-parser';
import { DB_CONTEXT, TxEm, UnitOfWork } from '../database/index.js';
import { JobScheduler, jobRegistry, type JobDef } from '../queue/index.js';

const taskId = (orgId: string | null, key: string) => `task:${orgId ?? 'null'}:${key}`;

function assertValid(cron: string, tz: string): void {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); } catch { throw new Error(`Invalid timezone "${tz}"`); }
  try { CronExpressionParser.parse(cron, { tz }); } catch (e) { throw new Error(`Invalid cron "${cron}": ${(e as Error).message}`); }
}

@Injectable()
export class ScheduledTaskService {
  private readonly logger = new Logger(ScheduledTaskService.name);
  constructor(
    private readonly uow: UnitOfWork, private readonly txEm: TxEm, private readonly scheduler: JobScheduler,
    @InjectEntityManager(DB_CONTEXT.admin) private readonly adminEm: EntityManager,
  ) {}

  async upsert(i: { orgId: string | null; key: string; job: JobDef; cron: string; timezone: string; payload: unknown; enabled: boolean }): Promise<void> {
    assertValid(i.cron, i.timezone);
    i.job.schema.parse(i.payload);
    await this.uow.run(() => this.txEm.get().getConnection().execute(
      `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
       ON CONFLICT ON CONSTRAINT scheduled_tasks_org_key_uq DO UPDATE SET job_name = EXCLUDED.job_name, cron = EXCLUDED.cron,
       timezone = EXCLUDED.timezone, payload = EXCLUDED.payload, enabled = EXCLUDED.enabled, updated_at = now()`,
      [i.orgId, i.key, i.job.name, i.cron, i.timezone, JSON.stringify(i.payload), i.enabled],
    ));
    await this.apply(i.orgId, i.key, i.job, i.cron, i.timezone, i.payload, i.enabled);
  }

  async remove(orgId: string | null, key: string): Promise<void> {
    await this.uow.run(() => this.txEm.get().getConnection().execute('DELETE FROM scheduled_tasks WHERE org_id IS NOT DISTINCT FROM ? AND key = ?', [orgId, key]));
    await this.scheduler.remove(taskId(orgId, key));
  }

  /** Đồng bộ lại toàn bộ bảng sang BullMQ. Trả về số scheduler đã sửa. */
  async reconcile(): Promise<number> {
    const rows = await this.adminEm.fork().getConnection().execute<{ org_id: string | null; key: string; job_name: string; cron: string; timezone: string; payload: unknown; enabled: boolean }[]>('SELECT org_id, key, job_name, cron, timezone, payload, enabled FROM scheduled_tasks');
    const existing = new Set(await this.scheduler.listIds('task:'));
    let repaired = 0;
    const wanted = new Set<string>();
    for (const r of rows) {
      const id = taskId(r.org_id, r.key);
      const job = jobRegistry().find((j) => j.name === r.job_name);
      if (!job) { this.logger.error({ id, job: r.job_name }, 'scheduled task references unknown job'); continue; }
      if (r.enabled) wanted.add(id);
      if (r.enabled && !existing.has(id)) { await this.apply(r.org_id, r.key, job, r.cron, r.timezone, r.payload, true); repaired++; }
    }
    for (const id of existing) if (!wanted.has(id)) { await this.scheduler.remove(id); repaired++; }
    return repaired;
  }

  private async apply(orgId: string | null, key: string, job: JobDef, cron: string, tz: string, payload: unknown, enabled: boolean): Promise<void> {
    const id = taskId(orgId, key);
    if (enabled) await this.scheduler.upsert(id, job, payload, { cron, tz });
    else await this.scheduler.remove(id);
  }
}
```
Verify: `cron-parser` là dependency sẵn có của BullMQ, nhưng mình dùng trực tiếp nên phải khai báo rõ: `pnpm view cron-parser dist-tags && pnpm add cron-parser`. Verify API `CronExpressionParser.parse` của version latest.

Hai lời gọi `apply` sau commit có thể thất bại (Redis lỗi). Cron `reconcile` sẽ sửa lại. Khai báo cron đó, `src/core/scheduler/scheduler.jobs.ts`:
```ts
import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../queue/index.js';
import { defineCron } from './cron-definition.js';
import { schedulerConfig } from './scheduler.config.js';

export const ReconcileSchedulesJob = defineJob({ name: 'core.scheduler.reconcile', queue: MaintenanceQueue, version: 1, schema: z.object({}) });
defineCron({ key: 'core.scheduler.reconcile', job: ReconcileSchedulesJob, payload: {}, schedule: () => { const c = schedulerConfig(); return { cron: c.reconcileCron, tz: c.reconcileTz }; } });
```
`src/core/scheduler/scheduler.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const schedulerConfig = defineConfig(
  'scheduler',
  { reconcileCron: 'SCHEDULER_RECONCILE_CRON', reconcileTz: 'SCHEDULER_RECONCILE_TZ' },
  z.object({
    reconcileCron: z.string().min(1).default('*/10 * * * *').describe('Cron for reconciling scheduled_tasks with the queue'),
    reconcileTz: z.string().min(1).default('UTC').describe('Timezone for the reconcile cron'),
  }),
);
```
Handler reconcile, thêm vào `src/core/scheduler/scheduler.jobs.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { JobHandler } from '../queue/index.js';
import { ScheduledTaskService } from './scheduled-task.service.js';

@Injectable()
@JobHandler(ReconcileSchedulesJob)
export class ReconcileSchedulesHandler {
  constructor(private readonly tasks: ScheduledTaskService) {}
  async handle(): Promise<void> {
    await this.tasks.reconcile();
  }
}
```
Cleanup outbox/inbox, thêm vào `src/core/outbox/outbox.jobs.ts`:
```ts
import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../queue/index.js';
import { defineCron } from '../scheduler/cron-definition.js';
import { outboxConfig } from './outbox.config.js';

export const OutboxCleanupJob = defineJob({ name: 'core.outbox.cleanup', queue: MaintenanceQueue, version: 1, schema: z.object({}) });
defineCron({
  key: 'core.outbox.cleanup', job: OutboxCleanupJob, payload: {},
  schedule: () => { const c = outboxConfig(); return { cron: c.cleanupCron, tz: c.cleanupTz }; },
});
```
`core/outbox` import `core/scheduler/cron-definition` (một file thuần, không import ngược). Luật kiến trúc không cấm các thành phần trong `core` gọi nhau, chỉ cấm vòng lặp. Để tránh vòng `scheduler → database/queue → outbox`, `cron-definition.ts` không được import gì ngoài type từ `core/queue`.

`src/core/outbox/outbox-cleanup.handler.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { type ConfigOf } from '../config/index.js';
import { DB_CONTEXT } from '../database/index.js';
import { JobHandler } from '../queue/index.js';
import { outboxConfig } from './outbox.config.js';
import { OutboxCleanupJob } from './outbox.jobs.js';

@Injectable()
@JobHandler(OutboxCleanupJob)
export class OutboxCleanupHandler {
  private readonly logger = new Logger(OutboxCleanupHandler.name);
  constructor(
    @InjectEntityManager(DB_CONTEXT.admin) private readonly adminEm: EntityManager,
    @Inject(outboxConfig.KEY) private readonly cfg: ConfigOf<typeof outboxConfig>,
  ) {}

  async handle(): Promise<void> {
    const conn = this.adminEm.fork().getConnection();
    const outbox = await conn.execute<{ n: string }[]>(
      `WITH d AS (DELETE FROM outbox_events WHERE published_at < now() - make_interval(days => ?) RETURNING 1) SELECT count(*)::text AS n FROM d`,
      [this.cfg.retentionDays],
    );
    const inbox = await conn.execute<{ n: string }[]>(
      `WITH d AS (DELETE FROM processed_events WHERE processed_at < now() - make_interval(days => ?) RETURNING 1) SELECT count(*)::text AS n FROM d`,
      [this.cfg.inboxRetentionDays],
    );
    this.logger.log({ outboxDeleted: Number(outbox[0]!.n), inboxDeleted: Number(inbox[0]!.n) }, 'outbox cleanup done');
  }
}
```
Đăng ký `OutboxCleanupHandler` trong `OutboxModule`.

Test cleanup, thêm vào `test/integration/core/outbox/outbox.spec.ts` (import `OutboxCleanupHandler` từ `src/core/outbox/index.js`, `getEntityManagerToken` từ `@mikro-orm/nestjs`, `DB_CONTEXT` từ `src/core/database/index.js`):
```ts
it('cleanup deletes only published rows older than retention', async () => {
  const admin = app.get<EntityManager>(getEntityManagerToken(DB_CONTEXT.admin)).fork().getConnection();
  const old = evt(); const fresh = evt();
  await app.get(UnitOfWork).run(async () => { await app.get(OutboxWriter).append(old); await app.get(OutboxWriter).append(fresh); });
  await admin.execute(`UPDATE outbox_events SET published_at = now() - interval '30 days' WHERE event_id = ?`, [old.eventId]);
  await app.get(OutboxCleanupHandler).handle();
  const left = await admin.execute<{ event_id: string }[]>('SELECT event_id FROM outbox_events WHERE event_id IN (?, ?)', [old.eventId, fresh.eventId]);
  expect(left.map((r) => r.event_id)).toEqual([fresh.eventId]);
});
```
Verify tên `getEntityManagerToken` trong `@mikro-orm/nestjs` latest. Test dựa vào `OUTBOX_RETENTION_DAYS` mặc định (7 ngày) nhỏ hơn 30 ngày của dòng cũ.

`SchedulerModule` gồm `StaticScheduler`, `ScheduledTaskService`, handler reconcile. Export `ScheduledTaskService`, `StaticScheduler`. Thêm vào `AppWorkerModule`. `AppApiModule` chỉ cần `ScheduledTaskService` (API cho tenant đặt lịch ở sub-project sau), nên import `SchedulerModule` ở cả hai module gốc. `StaticScheduler` tự bỏ qua khi role khác `worker`.

Run: `pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): static cron via job schedulers, tenant scheduled tasks with reconcile, outbox cleanup"
```

---

### Task 12: `core/http` — validate, response chuẩn, phân trang, ETag, Merge Patch, OpenAPI

**Files:**
- Create: `src/core/http/{http.config.ts,pagination.config.ts,pagination.ts,response.ts,conditional.ts,content-type.middleware.ts,api-problems.decorator.ts,http-bootstrap.ts,openapi.ts,http.module.ts,index.ts}`, `scripts/export-openapi.ts`
- Modify: `src/main.api.ts`, `test/fixtures/fixture.module.ts` (thêm `listPage`)
- Test: `test/unit/core/http/pagination.spec.ts`, `test/unit/core/http/conditional.spec.ts`, `test/e2e/core/http-conventions.e2e.spec.ts`, `test/integration/core/http/cursor-pagination.spec.ts`

**Interfaces:**
- Consumes: `AppError`, `CoreErrors`, `zodIssuesToFields`, `RequestContext.path()`, `defineConfig`, `TxEm` (chỉ trong fixture)
- Produces:
  - Query schema: `offsetPageQuery({ sortable })` trả về `{ page: number; pageSize: number; sort?: string }`, `cursorPageQuery()` trả về `{ limit: number; cursor?: string }`
  - Response schema: `offsetPageSchema(item)`, `cursorPageSchema(item)`, `problemSchema`
  - `type OffsetPage<T> = { url: string; data: T[]; page: number; pageSize: number; totalCount: number; totalCountExact: boolean; hasMore: boolean }`
  - `type CursorPage<T> = { url: string; data: T[]; hasMore: boolean; nextCursor: string | null }`
  - `Paginator.offset<T>(data: T[], q: { page: number; pageSize: number }, countUpToCap: number): OffsetPage<T>`. Repo đếm bằng `count` giới hạn ở `totalCountCap + 1`
  - `Paginator.cursor<T>(data: T[], next: { hasMore: boolean; nextCursor: string | null }): CursorPage<T>`. Repo dùng `em.findByCursor` của MikroORM và truyền `endCursor` vào đây
  - `serialize<S extends z.ZodType>(schema: S, value: unknown): z.infer<S>`
  - `setLocation(res: HeaderWriter, location: string): void`, `type HeaderWriter = { setHeader(k: string, v: string): void }`
  - `etagOf(version: number | string): string` (weak ETag), `assertIfMatch(ifMatch: string | undefined, version: number | string, opts: { required: boolean }): void`
  - `mergePatchSchema<S extends z.ZodObject>(schema: S)`
  - `@ApiProblems(...errors: ErrorCode[])`
  - `applyHttpDefaults(app)`, `buildOpenApi(app)`, `setupApiDocs(app)`, `HttpModule`

- [ ] **Step 1: Cài package và verify API (framework trước, package sau)**

```bash
for p in helmet @nestjs/swagger @scalar/nestjs-api-reference; do pnpm view $p dist-tags peerDependencies; done
pnpm add helmet @nestjs/swagger @scalar/nestjs-api-reference
```
Verify, ghi kết quả vào ADR 0007:
- (a) Nest 12: tên và cách import `StandardSchemaValidationPipe`, option `exceptionFactory`, và các issue truyền vào có phải object issue gốc của zod (có `code`, `format`) không. `https://docs.nestjs.com/techniques/validation`
- (b) `@Body({ schema })`, `@Query({ schema })` và cách `@nestjs/swagger` 12 sinh schema từ Standard Schema. `https://docs.nestjs.com/openapi/introduction`
- (c) `app.useBodyParser('json', { type, limit })` trên Express. `https://docs.nestjs.com/faq/raw-body`
- (d) Express tự sinh `ETag` và trả `304` khi `If-None-Match` khớp (`res.send` kiểm tra `req.fresh`), và **không ghi đè** `ETag` đã set sẵn. `https://expressjs.com/en/api.html#app.settings.table`
- (e) MikroORM 7 `em.findByCursor(entity, where, { first, after, orderBy, includeCount })`, các thuộc tính `items`, `hasNextPage`, `endCursor` của kết quả, và exception ném ra khi cursor hỏng. Tìm trong `https://mikro-orm.io/docs` (mục cursor pagination)
- (f) `mount` của Scalar (`apiReference`) cho Express.

Nếu (a) cho thấy pipe chỉ trả issue theo Standard Schema (không có `code`) thì `zodIssuesToFields` dùng `code: 'invalid'` cho issue thiếu mã, và ghi giới hạn này vào ADR 0007. Không tự viết pipe validate riêng.

- [ ] **Step 2: Viết test trước**

`test/unit/core/http/pagination.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Paginator } from '../../../../src/core/http/index.js';

const ctx = { path: () => '/api/v1/admin/users' };
const cfg = { totalCountCap: 100 };
const p = new Paginator(ctx as never, cfg as never);

describe('Paginator', () => {
  it('offset: exact totalCount below cap', () => {
    expect(p.offset([{ id: '1' }], { page: 1, pageSize: 20 }, 42)).toEqual({
      url: '/api/v1/admin/users', data: [{ id: '1' }], page: 1, pageSize: 20, totalCount: 42, totalCountExact: true, hasMore: true,
    });
  });
  it('offset: last page has hasMore=false', () => {
    expect(p.offset([], { page: 3, pageSize: 20 }, 42).hasMore).toBe(false);
  });
  it('offset: count above cap is reported as cap with totalCountExact=false', () => {
    const r = p.offset([], { page: 1, pageSize: 20 }, 101);
    expect(r).toMatchObject({ totalCount: 100, totalCountExact: false, hasMore: true });
    expect(typeof r.totalCount).toBe('number');
  });
  it('cursor: flat shape with url', () => {
    expect(p.cursor([{ id: 'a' }], { hasMore: true, nextCursor: 'c1' })).toEqual({ url: '/api/v1/admin/users', data: [{ id: 'a' }], hasMore: true, nextCursor: 'c1' });
    expect(p.cursor([], { hasMore: false, nextCursor: null }).nextCursor).toBeNull();
  });
});
```
`test/unit/core/http/conditional.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../../src/core/errors/index.js';
import { assertIfMatch, etagOf, mergePatchSchema } from '../../../../src/core/http/index.js';

const code = (fn: () => void) => { try { fn(); return 'ok'; } catch (e) { return (e as AppError).error.code; } };

describe('conditional requests', () => {
  it('etagOf is a weak validator of the version', () => { expect(etagOf(7)).toBe('W/"7"'); });
  it('If-Match matching (weak or strong form) passes', () => {
    expect(code(() => assertIfMatch('W/"7"', 7, { required: true }))).toBe('ok');
    expect(code(() => assertIfMatch('"7"', 7, { required: true }))).toBe('ok');
    expect(code(() => assertIfMatch('W/"6", W/"7"', 7, { required: true }))).toBe('ok');
  });
  it('stale If-Match → precondition_failed', () => { expect(code(() => assertIfMatch('W/"6"', 7, { required: true }))).toBe('precondition_failed'); });
  it('missing If-Match on a required route → precondition_required', () => { expect(code(() => assertIfMatch(undefined, 7, { required: true }))).toBe('precondition_required'); });
  it('missing If-Match on an optional route passes', () => { expect(code(() => assertIfMatch(undefined, 7, { required: false }))).toBe('ok'); });
});

describe('mergePatchSchema', () => {
  const User = z.object({ name: z.string().min(1), nickname: z.string().nullable() });
  const Patch = mergePatchSchema(User);
  it('every field is optional; null clears a value', () => {
    expect(Patch.parse({})).toEqual({});
    expect(Patch.parse({ nickname: null })).toEqual({ nickname: null });
  });
  it('still validates provided values and rejects unknown fields', () => {
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
import {
  HttpModule, Paginator, applyHttpDefaults, assertIfMatch, etagOf, mergePatchSchema, offsetPageQuery, serialize, setLocation, type HeaderWriter,
} from '../../../src/core/http/index.js';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const User = z.object({ id: z.string(), email: z.email(), name: z.string().min(1), role: z.enum(['USER', 'ADMIN']) });
const CreateUser = User.pick({ email: true, name: true });
const store = new Map<string, { id: string; email: string; name: string; role: 'USER' | 'ADMIN'; passwordHash: string; version: number }>();
const ListQ = offsetPageQuery({ sortable: ['name'] as const });

@Controller('api/v1/users')
class UsersController {
  constructor(private readonly pages: Paginator) {}

  @Get()
  list(@Query({ schema: ListQ }) q: z.infer<typeof ListQ>) {
    const all = [...store.values()];
    const slice = all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return this.pages.offset(slice.map((u) => serialize(User, u)), q, all.length);
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
  patch(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body({ schema: mergePatchSchema(User.pick({ name: true })) }) b: { name?: string }, @Res({ passthrough: true }) res: HeaderWriter) {
    const u = store.get(id);
    if (!u) throw new AppError(CoreErrors.NOT_FOUND);
    assertIfMatch(ifMatch, u.version, { required: true });
    Object.assign(u, b, { version: u.version + 1 });
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

  it('POST → 201, Location header, resource body without internal fields', async () => {
    const res = await http().post('/api/v1/users').send({ email: 'me@example.com', name: 'Me' }).expect(201);
    expect(res.headers.location).toBe('/api/v1/users/1');
    expect(res.body).toEqual({ id: '1', email: 'me@example.com', name: 'Me', role: 'USER' });
    expect(res.body).not.toHaveProperty('passwordHash');
  });

  it('invalid body → 422 validation_failed with dot paths and codes', async () => {
    const res = await http().post('/api/v1/users').send({ email: 'nope', name: '' }).expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'email', code: 'invalid_email' }),
      expect.objectContaining({ path: 'name', code: 'too_small' }),
    ]));
  });

  it('unsupported Content-Type → 415', async () => {
    const res = await http().post('/api/v1/users').set('content-type', 'text/plain').send('email=x').expect(415);
    expect(res.body.code).toBe('unsupported_media_type');
  });

  it('body over the limit → 413', async () => {
    const res = await http().post('/api/v1/users').send({ email: 'a@b.co', name: 'x'.repeat(2 * 1024 * 1024) }).expect(413);
    expect(res.body.code).toBe('payload_too_large');
  });

  it('GET list → flat offset page', async () => {
    const res = await http().get('/api/v1/users?page=1&pageSize=20').expect(200);
    expect(res.body).toMatchObject({ url: '/api/v1/users', page: 1, pageSize: 20, totalCount: 1, totalCountExact: true, hasMore: false });
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('pageSize above max / page depth above cap → 422', async () => {
    expect((await http().get('/api/v1/users?pageSize=100000').expect(422)).body.code).toBe('validation_failed');
    expect((await http().get('/api/v1/users?page=100000&pageSize=100').expect(422)).body.code).toBe('validation_failed');
  });

  it('GET resource → bare object with ETag; If-None-Match → 304', async () => {
    const res = await http().get('/api/v1/users/1').expect(200);
    expect(res.headers.etag).toBe('W/"1"');
    await http().get('/api/v1/users/1').set('If-None-Match', res.headers.etag).expect(304);
  });

  it('PATCH merge-patch: requires If-Match, rejects stale version, succeeds with current', async () => {
    const patch = () => http().patch('/api/v1/users/1').set('content-type', 'application/merge-patch+json');
    expect((await patch().send({ name: 'New' }).expect(428)).body.code).toBe('precondition_required');
    expect((await patch().set('If-Match', 'W/"0"').send({ name: 'New' }).expect(412)).body.code).toBe('precondition_failed');
    const ok = await patch().set('If-Match', 'W/"1"').send({ name: 'New' }).expect(200);
    expect(ok.body.name).toBe('New');
    expect(ok.headers.etag).toBe('W/"2"');
  });

  it('unknown resource → 404 not_found; DELETE → 204 empty body', async () => {
    expect((await http().get('/api/v1/users/999').expect(404)).body.code).toBe('not_found');
    const del = await http().delete('/api/v1/users/1').expect(204);
    expect(del.text).toBe('');
  });
});
```
`test/integration/core/http/cursor-pagination.spec.ts` (cursor thật của MikroORM trên bảng `fixture_notes`):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Module, Query, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule, UnitOfWork, runMigrations } from '../../../../src/core/database/index.js';
import { HttpModule, Paginator, applyHttpDefaults, cursorPageQuery } from '../../../../src/core/http/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { FixtureModule, FixtureRepo } from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const Q = cursorPageQuery();
const PREFIX = `cursor-${Date.now()}`;
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
    await runMigrations('up');
    app = await createTestApp([DatabaseModule.forRoot(), RedisModule, HttpModule, M], { beforeInit: applyHttpDefaults });
    await app.get(UnitOfWork).run(async () => { for (let i = 0; i < 25; i++) await app.get(FixtureRepo).insertSystemNote(`${PREFIX}-${String(i).padStart(2, '0')}`); });
  });
  afterAll(async () => { await app.close(); });

  it('walks every row once, in order, with the flat cursor shape', async () => {
    const seen: string[] = []; let cursor: string | null = null;
    do {
      const res: request.Response = await request(app.getHttpServer()).get(`/notes?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
      expect(res.body).toHaveProperty('url', '/notes');
      seen.push(...res.body.data.map((d: { body: string }) => d.body));
      cursor = res.body.nextCursor;
      expect(res.body.hasMore).toBe(cursor !== null);
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(seen).toEqual([...seen].sort());
  });

  it('tampered cursor → 400 invalid_cursor, not 500', async () => {
    const res = await request(app.getHttpServer()).get('/notes?limit=10&cursor=not-a-real-cursor');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_cursor');
  });
});
```
Thêm vào `FixtureRepo` (dùng API đã verify ở Step 1 (e)). Đây là **mẫu chuẩn** cho mọi repository có danh sách cursor ở các sub-project sau: repository trả dữ liệu thô, còn controller bọc bằng `Paginator` (repository không phụ thuộc vào HTTP):
```ts
async listPage(prefix: string, q: { limit: number; cursor?: string }): Promise<{ items: { body: string }[]; hasMore: boolean; nextCursor: string | null }> {
  const res = await this.txEm.get().findByCursor(FixtureNote, { body: { $like: `${prefix}%` } }, {
    first: q.limit, after: q.cursor, orderBy: { body: 'asc', id: 'asc' }, includeCount: false,
  });
  return { items: res.items.map((n) => ({ body: n.body })), hasMore: res.hasNextPage, nextCursor: res.hasNextPage ? res.endCursor : null };
}
```
Cursor hỏng do MikroORM ném lỗi. Error mapper ở Task 7 map lỗi này thành `400 invalid_cursor`: thêm vào `src/core/database/db-error.mapper.ts` một nhánh cho đúng class exception đã verify ở Step 1 (e), và thêm một unit test cho nhánh đó.

Run: `pnpm test && pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/core/http/http.config.ts` (mở rộng từ Task 6):
```ts
export const httpConfig = defineConfig(
  'http',
  {
    port: 'HTTP_PORT', host: 'HTTP_HOST', bodyLimit: 'HTTP_BODY_LIMIT', corsOrigins: 'HTTP_CORS_ORIGINS', trustProxy: 'HTTP_TRUST_PROXY',
    allowedContentTypes: 'HTTP_ALLOWED_CONTENT_TYPES', docsEnabled: 'HTTP_DOCS_ENABLED', docsPath: 'HTTP_DOCS_PATH',
  },
  z.object({
    port: z.coerce.number().int().min(0).default(3000).describe('HTTP listen port (0 = random, tests only)'),
    host: z.string().default('0.0.0.0').describe('HTTP listen host'),
    bodyLimit: z.string().default('1mb').describe('Max request body size (larger → 413)'),
    corsOrigins: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).describe('Allowed CORS origins, comma separated; empty = CORS disabled'),
    trustProxy: z.string().default('loopback').describe('Express trust proxy setting'),
    allowedContentTypes: z.string().default('application/json,application/merge-patch+json').transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)).describe('Accepted request Content-Types for bodies (others → 415)'),
    docsEnabled: z.stringbool().default(false).describe('Serve API reference UI'),
    docsPath: z.string().startsWith('/').default('/docs').describe('Path of API reference UI'),
  }),
);
```
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
Config phân trang **không có trường bắt buộc**, vì schema query được dựng ngay lúc import controller.

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
  return z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(cfg.maxPageSize).default(cfg.defaultPageSize),
      sort: z.string().refine((s) => sortField.safeParse(s.replace(/^-/, '')).success, { message: `sort must be one of ${opts.sortable.join(', ')} (prefix - for desc)` }).optional(),
    })
    .refine((q) => q.page * q.pageSize <= cfg.maxOffsetRows, { message: `page*pageSize must be <= ${cfg.maxOffsetRows}`, path: ['page'] });
}

export function cursorPageQuery() {
  const cfg = paginationConfig();
  return z.object({
    limit: z.coerce.number().int().min(1).max(cfg.maxPageSize).default(cfg.defaultPageSize),
    cursor: z.string().min(1).optional(),
  });
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
    return { url: this.url(), data, page: q.page, pageSize: q.pageSize, totalCount, totalCountExact: exact, hasMore: !exact || q.page * q.pageSize < totalCount };
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

/** Chỉ trả những field khai báo trong schema response (z.object mặc định bỏ key lạ). Sai schema là bug của server → 500. */
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

function opaqueTags(header: string): string[] {
  return header.split(',').map((t) => t.trim().replace(/^W\//, '')).filter(Boolean);
}

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

/** JSON Merge Patch (RFC 7396): mọi field là optional, null nghĩa là xoá giá trị, field lạ bị từ chối. */
export function mergePatchSchema<S extends z.ZodObject>(schema: S) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, (v as z.ZodType).nullable().optional()]));
  return z.strictObject(shape);
}
```
So sánh `If-Match` dùng weak comparison (bỏ `W/`). RFC 9110 yêu cầu strong comparison cho `If-Match`, nhưng ETag của mình là version của resource chứ không phải hash byte của body, nên so sánh theo version là đúng ngữ nghĩa. Ghi điểm này vào ADR 0007.

Field bắt buộc mà nhận `null` trong merge patch (ví dụ `name: null` khi `name` không được rỗng): `mergePatchSchema` cho phép `null` ở tầng schema, còn use case phải từ chối bằng `AppError(VALIDATION_FAILED, { fields: [{ path: 'name', code: 'required', message: … }] })`. Thêm test case `name: null → 422` vào e2e khi có use case thật ở sub-project sau. Ở đây chỉ ghi quy ước vào ADR 0007.

`src/core/http/content-type.middleware.ts`:
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
Route `/webhooks/*` ở các sub-project sau có thể cần content type khác. Khi đó chúng khai báo qua config riêng, và middleware này được `exclude` theo route. Không nới allowlist chung.

`src/core/http/api-problems.decorator.ts`:
```ts
import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { ErrorCode } from '../errors/index.js';

export const ApiProblems = (...errors: ErrorCode[]) =>
  applyDecorators(...errors.map((e) => ApiResponse({ status: e.status, description: `${e.code}: ${e.title}`, content: { 'application/problem+json': {} } })));
```
Verify: cách `ApiResponse` của `@nestjs/swagger` 12 nhận `content`, và nhiều mã lỗi cùng status thì gộp description. Sửa theo tài liệu.

`src/core/http/http-bootstrap.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppError, CoreErrors, zodIssuesToFields, type ZodIssueLike } from '../errors/index.js';
import { httpConfig } from './http.config.js';
// import { StandardSchemaValidationPipe } from '<đường dẫn đã verify ở Step 1 (a)>';

export function applyHttpDefaults(app: INestApplication): void {
  const cfg = httpConfig();
  const express = app as NestExpressApplication;
  express.set('trust proxy', cfg.trustProxy);
  express.set('etag', 'weak');
  express.useBodyParser('json', { type: cfg.allowedContentTypes, limit: cfg.bodyLimit });
  app.use(helmet());
  if (cfg.corsOrigins.length) app.enableCors({ origin: cfg.corsOrigins, credentials: true });
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues: readonly ZodIssueLike[]) =>
        new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'One or more fields did not pass validation.', fields: zodIssuesToFields(issues) }),
    }),
  );
}
```
Dòng import `StandardSchemaValidationPipe` và tên option `exceptionFactory` lấy đúng theo Step 1 (a). File này là chỗ **duy nhất** trong `src` được import `@nestjs/platform-express`, theo luật kiến trúc số 6.

Sửa `zodIssuesToFields` (Task 4) để nhận cả path dạng Standard Schema (`{ key }`):
```ts
export type ZodIssueLike = { code?: string; path?: readonly (PropertyKey | { key: PropertyKey })[]; message: string; format?: string };

export function zodIssuesToFields(issues: readonly ZodIssueLike[]): FieldError[] {
  return issues.map((i) => ({
    path: (i.path ?? []).map((s) => String(typeof s === 'object' ? s.key : s)).join('.'),
    code: i.code === 'invalid_format' && i.format ? `invalid_${i.format}` : (i.code ?? 'invalid'),
    message: i.message,
  }));
}
```
`src/core/http/openapi.ts` giữ như cũ: `buildOpenApi(app)` tạo document 3.1, `setupApiDocs(app)` gắn Scalar khi `docsEnabled`. Trong `buildOpenApi`, đăng ký schema `Problem` (từ `problemSchema` bằng zod: `type, title, status, code, detail?, instance, requestId, timestamp, errors?`) để mọi `@ApiProblems` tham chiếu tới.

`src/core/http/http.module.ts`:
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
Verify cú pháp wildcard của `forRoutes` trong Nest 12 (có thể là `'*path'` hoặc `{ path: '*', method: RequestMethod.ALL }`).

`src/core/http/index.ts` export: `HttpModule`, `Paginator`, `offsetPageQuery`, `cursorPageQuery`, `offsetPageSchema`, `cursorPageSchema`, `serialize`, `setLocation`, `etagOf`, `assertIfMatch`, `mergePatchSchema`, `ApiProblems`, `applyHttpDefaults`, `buildOpenApi`, `setupApiDocs`, `httpConfig`, `paginationConfig`, các type `OffsetPage`, `CursorPage`, `HeaderWriter`. Thêm hai config vào `all-configs.ts`.

`scripts/export-openapi.ts`: bootstrap bằng `bootstrapApi({ listen: false })`, ghi `buildOpenApi(app)` ra `openapi.json`, rồi đóng app. Script: `"openapi:export": "node dist/scripts/export-openapi.js"`. Sửa `tsconfig`/`nest-cli.json` để SWC biên dịch cả `scripts/`.

`main.api.ts` gọi `applyHttpDefaults(app)` và `setupApiDocs(app)` trước `listen`/`init`.

Run: `pnpm test && pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): http conventions — validation, flat pages, etag/if-match, merge patch, openapi"
```

---

### Task 13: Idempotency-Key + rate limit trên Redis (dùng package có sẵn)

**Files:**
- Create: `src/core/http/{throttle.config.ts,fail-open-throttler.storage.ts,idempotency.config.ts,idempotency.ts}`
- Modify: `src/core/http/http.module.ts`, `src/core/http/index.ts`, `src/core/errors/error-codes.ts` (đã có `IDEMPOTENCY_PREVIOUS_FAILED` từ Task 4)
- Test: `test/e2e/core/idempotency.e2e.spec.ts`, `test/e2e/core/rate-limit.e2e.spec.ts`
- Docs: `docs/adr/0007-http-conventions.md` (mục phụ thuộc)

**Interfaces:**
- Consumes: `REDIS`, `redisConfig`, `RequestContext`, `AppError`, `CoreErrors`, `registerErrorMapper`, `HttpModule`
- Produces:
  - `@Idempotent(opts?)`: re-export decorator của `@nestjs-redisx/idempotency`, để module không import thẳng package
  - `idempotencyKeyExtractor(ctx: ExecutionContext): string`: bắt buộc có header, đúng định dạng, gắn scope `org` hoặc `user` vào key
  - `idempotencyErrorMapper: ErrorMapper`
  - `FailOpenThrottlerStorage` bọc `ThrottlerStorageRedisService`

- [ ] **Step 1: Cài package và ghi ngoại lệ peer**

```bash
for p in @nestjs/throttler @nest-lab/throttler-storage-redis @nestjs-redisx/core @nestjs-redisx/idempotency; do pnpm view $p dist-tags peerDependencies; done
pnpm add @nestjs/throttler @nest-lab/throttler-storage-redis @nestjs-redisx/core @nestjs-redisx/idempotency
pnpm peers check
```
Expected: `pnpm peers check` chỉ báo `@nest-lab/throttler-storage-redis` khai báo peer `@nestjs/*` tới 11. Đây là ngoại lệ **đã được Sếp duyệt** ngày 2026-09-25, dựa trên spike: rate limit dùng chung qua Redis giữa 2 instance trả `429` kèm `Retry-After` trên Nest 12.1. Ghi vào ADR 0007: tên package, peer khai báo, kết quả spike, rủi ro (package import đường dẫn nội bộ `@nestjs/throttler/dist/...`), và điều kiện gỡ bỏ ngoại lệ (khi package khai báo hỗ trợ Nest 12, Renovate sẽ mở PR).

Verify bằng file `.d.ts` trong `node_modules` (không đoán):
- `node_modules/@nest-lab/throttler-storage-redis/src/throttler-storage-redis.service.d.ts`: constructor nhận instance `Redis`, và chữ ký `increment(key, ttl, limit, blockDuration, throttlerName)`.
- `node_modules/@nestjs-redisx/idempotency/dist/index.d.ts`: `IdempotencyPlugin` với option `headerName`, `defaultTtl`, `keyPrefix`, `lockTimeout`, `waitTimeout`, `validateFingerprint`, `fingerprintFields`, `errorPolicy`. Decorator `Idempotent` với `keyExtractor`, `ttl`, `cacheHeaders`. Các class lỗi `IdempotencyFingerprintMismatchError`, `IdempotencyTimeoutError`, `IdempotencyFailedError`, `IdempotencyKeyRequiredError`, `IdempotencyError`.
- `node_modules/@nestjs-redisx/core/dist/index.d.ts`: `RedisModule.forRootAsync({ inject, useFactory, plugins })`, và cách đặt `keyPrefix`/`url` cho client. Xem thêm `https://nestjs-redisx.dev/llms-full.txt`.
- Plugin có tự đăng ký exception filter riêng không. Nếu có thì phải tắt đi, để `ProblemDetailsFilter` là filter duy nhất.

- [ ] **Step 2: Viết test trước**

`test/e2e/core/idempotency.e2e.spec.ts`:
```ts
import { Body, Controller, HttpCode, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpModule, Idempotent, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

let calls = 0;
let failCalls = 0;
const Pay = z.object({ amount: z.number().int().positive(), delayMs: z.number().int().min(0).optional() });

@Controller('api/v1/payments')
class PaymentsController {
  @Post() @HttpCode(201) @Idempotent()
  async create(@Body({ schema: Pay }) b: z.infer<typeof Pay>) {
    calls++;
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    return { id: `p-${calls}`, amount: b.amount };
  }
  @Post('fail') @Idempotent()
  fail() { failCalls++; throw new Error('handler failed after side effect'); }
}
@Module({ controllers: [PaymentsController] }) class M {}

describe('Idempotency-Key (@nestjs-redisx/idempotency)', () => {
  let app: INestApplication;
  const post = (path: string, key: string | undefined, body: unknown, org?: string) => {
    const r = request(app.getHttpServer()).post(path).set('content-type', 'application/json');
    if (key) r.set('Idempotency-Key', key);
    if (org) r.set('X-Org-Id', org);
    return r.send(body as object);
  };
  beforeAll(async () => { app = await createTestApp([RedisModule, HttpModule, M], { beforeInit: applyHttpDefaults }); });
  afterAll(async () => { await app.close(); });

  it('replays the stored response for the same key and body; handler runs once', async () => {
    const before = calls;
    const a = await post('/api/v1/payments', 'k-1', { amount: 10 }).expect(201);
    const b = await post('/api/v1/payments', 'k-1', { amount: 10 }).expect(201);
    expect(b.body).toEqual(a.body);
    expect(calls - before).toBe(1);
  });

  it('same key, different body → 422 idempotency_key_reused (problem+json)', async () => {
    await post('/api/v1/payments', 'k-2', { amount: 1 }).expect(201);
    const res = await post('/api/v1/payments', 'k-2', { amount: 2 }).expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'idempotency_key_reused', status: 422 });
    expect(res.body).toHaveProperty('requestId');
  });

  it('concurrent same key: second waits and gets the same result; handler runs once', async () => {
    const before = calls;
    const [r1, r2] = await Promise.all([
      post('/api/v1/payments', 'k-3', { amount: 5, delayMs: 400 }),
      new Promise((r) => setTimeout(r, 50)).then(() => post('/api/v1/payments', 'k-3', { amount: 5, delayMs: 400 })),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.body).toEqual(r1.body);
    expect(calls - before).toBe(1);
  });

  it('missing or malformed key → 400 idempotency_key_required, handler not run', async () => {
    const before = calls;
    expect((await post('/api/v1/payments', undefined, { amount: 1 }).expect(400)).body.code).toBe('idempotency_key_required');
    expect((await post('/api/v1/payments', 'bad key!', { amount: 1 }).expect(400)).body.code).toBe('idempotency_key_required');
    expect(calls).toBe(before);
  });

  it('failed handler: retry with the same key → 409 idempotency_previous_failed, handler not re-run', async () => {
    await post('/api/v1/payments/fail', 'k-4', {}).expect(500);
    const res = await post('/api/v1/payments/fail', 'k-4', {}).expect(409);
    expect(res.body.code).toBe('idempotency_previous_failed');
    expect(failCalls).toBe(1);
  });

  it('same key from two different orgs never shares a stored response', async () => {
    const orgA = '0199aaaa-0000-7000-8000-000000000001';
    const orgB = '0199bbbb-0000-7000-8000-000000000002';
    const a = await post('/api/v1/payments', 'shared-key', { amount: 7 }, orgA).expect(201);
    const b = await post('/api/v1/payments', 'shared-key', { amount: 7 }, orgB).expect(201);
    expect(b.body.id).not.toBe(a.body.id);
  });
});
```
(Test cuối dùng header `X-Org-Id` làm scope tạm thời, vì sub-project 1 chưa có auth. Sub-project 2–3 sẽ đổi sang `principal.orgId`/`userId` trong `RequestContext`. `keyExtractor` đã đọc từ `RequestContext` nên không phải sửa lại test.)

`test/e2e/core/rate-limit.e2e.spec.ts`:
```ts
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

@Controller('ping') class P { @Get() ping() { return { ok: true }; } }
@Module({ controllers: [P] }) class M {}

describe('rate limit (@nestjs/throttler + @nest-lab/throttler-storage-redis)', () => {
  let a1: INestApplication; let a2: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('THROTTLE_DEFAULT_LIMIT', '5');
    vi.stubEnv('THROTTLE_DEFAULT_TTL_MS', '60000');
    vi.stubEnv('REDIS_KEY_PREFIX', `rl${Date.now()}`);
    a1 = await createTestApp([RedisModule, HttpModule, M], { beforeInit: applyHttpDefaults });
    a2 = await createTestApp([RedisModule, HttpModule, M], { beforeInit: applyHttpDefaults });
  });
  afterAll(async () => { await a1.close(); await a2.close(); vi.unstubAllEnvs(); });

  it('limit is shared across instances through Redis; 429 rate_limited with Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await request((i % 2 ? a2 : a1).getHttpServer()).get('/ping')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    const blocked = await request(a1.getHttpServer()).get('/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toContain('application/problem+json');
    expect(blocked.body.code).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
```
Test fail-open khi Redis sập nằm ở chaos test (Task 19, thêm một test case: cắt proxy Redis, `GET /ping` vẫn `200`).

Run: `pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/core/http/throttle.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const throttleConfig = defineConfig(
  'throttle',
  { limit: 'THROTTLE_DEFAULT_LIMIT', ttlMs: 'THROTTLE_DEFAULT_TTL_MS', failOpen: 'THROTTLE_FAIL_OPEN' },
  z.object({
    limit: z.coerce.number().int().positive().default(300).describe('Default requests per window per tracker'),
    ttlMs: z.coerce.number().int().positive().default(60000).describe('Default rate limit window (ms)'),
    failOpen: z.stringbool().default(true).describe('Allow requests when Redis is unavailable (spec §9); auth routes override to fail-closed'),
  }),
);
```
`src/core/http/fail-open-throttler.storage.ts`. Package không có chế độ fail-open, trong khi spec cha mục 9 yêu cầu có. Đây chỉ là một lớp bọc mỏng quanh package, không tự làm lại phần đếm:
```ts
import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

export class FailOpenThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(FailOpenThrottlerStorage.name);
  constructor(private readonly inner: ThrottlerStorageRedisService, private readonly failOpen: boolean) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    try {
      return await this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (err) {
      if (!this.failOpen) throw err;
      this.logger.warn({ err, throttlerName }, 'rate limit storage unavailable; failing open');
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
```
Verify: kiểu trả về của `increment` (tên field) khớp với `ThrottlerStorageRecord` trong `@nestjs/throttler` đã cài.

`src/core/http/idempotency.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const idempotencyConfig = defineConfig(
  'idempotency',
  { ttlSec: 'IDEMPOTENCY_TTL_SEC', lockTimeoutMs: 'IDEMPOTENCY_LOCK_TIMEOUT_MS', waitTimeoutMs: 'IDEMPOTENCY_WAIT_TIMEOUT_MS' },
  z.object({
    ttlSec: z.coerce.number().int().positive().default(86400).describe('How long a stored response can be replayed'),
    lockTimeoutMs: z.coerce.number().int().positive().default(30000).describe('Max time a request holds the processing lock; must exceed request timeout'),
    waitTimeoutMs: z.coerce.number().int().positive().default(20000).describe('How long a concurrent duplicate waits before 409 idempotency_conflict'),
  }),
);
```
`src/core/http/idempotency.ts`:
```ts
import type { ExecutionContext } from '@nestjs/common';
import {
  IdempotencyError, IdempotencyFailedError, IdempotencyFingerprintMismatchError, IdempotencyTimeoutError, Idempotent as RedisxIdempotent,
} from '@nestjs-redisx/idempotency';
import { AppError, CoreErrors, type ErrorMapper } from '../errors/index.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TENANT_HEADER = 'x-org-id';

/** Bắt buộc có key; gắn scope org/user để hai tenant không bao giờ dùng chung response đã lưu. */
export function idempotencyKeyExtractor(ctx: ExecutionContext): string {
  const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; principal?: { orgId?: string; userId?: string } }>();
  const key = req.headers[IDEMPOTENCY_HEADER];
  if (!key || !KEY_PATTERN.test(key)) {
    throw new AppError(CoreErrors.IDEMPOTENCY_KEY_REQUIRED, { detail: 'Send an Idempotency-Key header of 1-128 characters from [A-Za-z0-9_-].' });
  }
  const scope = req.principal?.orgId ?? req.principal?.userId ?? req.headers[TENANT_HEADER] ?? 'anonymous';
  return `${scope}:${key}`;
}

/** Decorator dùng trong module. Luôn bắt buộc key và luôn tách theo scope. */
export const Idempotent = (opts: { ttlSec?: number } = {}) =>
  RedisxIdempotent({ keyExtractor: idempotencyKeyExtractor, validateFingerprint: true, ...(opts.ttlSec ? { ttl: opts.ttlSec } : {}) });

export const idempotencyErrorMapper: ErrorMapper = (err) => {
  if (err instanceof IdempotencyFingerprintMismatchError) return new AppError(CoreErrors.IDEMPOTENCY_KEY_REUSED, { cause: err });
  if (err instanceof IdempotencyTimeoutError) return new AppError(CoreErrors.IDEMPOTENCY_CONFLICT, { cause: err });
  if (err instanceof IdempotencyFailedError) return new AppError(CoreErrors.IDEMPOTENCY_PREVIOUS_FAILED, { detail: 'The previous request with this Idempotency-Key failed. Retry with a new key.', cause: err });
  if (err instanceof IdempotencyError) return new AppError(CoreErrors.SERVICE_UNAVAILABLE, { cause: err });
  return undefined;
};
```
Header `x-org-id` chỉ là scope tạm, tới khi có `principal` (sub-project 2–3). Verify: `keyExtractor` ném `AppError` thì thư viện có để lỗi đi thẳng tới filter không (test `missing or malformed key` sẽ cho biết). Verify tên class lỗi theo `.d.ts` ở Step 1. Nếu thư viện dùng tên khác cho lỗi "previous failed" thì map theo tên đó, sao cho vẫn ra đúng mã `409 idempotency_previous_failed`.

`src/core/http/http.module.ts` (bổ sung vào bản của Task 12):
```ts
import { Global, Inject, MiddlewareConsumer, Module, NestModule, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisModule as RedisxModule } from '@nestjs-redisx/core';
import { IdempotencyPlugin } from '@nestjs-redisx/idempotency';
import type { Redis } from 'ioredis';
import { type ConfigOf } from '../config/index.js';
import { registerErrorMapper } from '../errors/index.js';
import { REDIS, redisConfig } from '../redis/index.js';
import { ContentTypeMiddleware } from './content-type.middleware.js';
import { FailOpenThrottlerStorage } from './fail-open-throttler.storage.js';
import { idempotencyConfig } from './idempotency.config.js';
import { IDEMPOTENCY_HEADER, idempotencyErrorMapper } from './idempotency.js';
import { Paginator } from './pagination.js';
import { throttleConfig } from './throttle.config.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [throttleConfig.KEY, REDIS],
      useFactory: (cfg: ConfigOf<typeof throttleConfig>, redis: Redis) => ({
        throttlers: [{ limit: cfg.limit, ttl: cfg.ttlMs }],
        storage: new FailOpenThrottlerStorage(new ThrottlerStorageRedisService(redis), cfg.failOpen),
      }),
    }),
    RedisxModule.forRootAsync({
      inject: [redisConfig.KEY, idempotencyConfig.KEY],
      plugins: [new IdempotencyPlugin({ headerName: IDEMPOTENCY_HEADER, errorPolicy: 'fail-closed', validateFingerprint: true })],
      useFactory: (r: ConfigOf<typeof redisConfig>, i: ConfigOf<typeof idempotencyConfig>) => ({
        clients: { url: r.url },
        pluginOptions: { idempotency: { keyPrefix: `${r.keyPrefix}:idem:`, defaultTtl: i.ttlSec, lockTimeout: i.lockTimeoutMs, waitTimeout: i.waitTimeoutMs } },
      }),
    }),
  ],
  providers: [Paginator, ContentTypeMiddleware, { provide: APP_GUARD, useClass: ThrottlerGuard }],
  exports: [Paginator],
})
export class HttpModule implements NestModule, OnModuleInit {
  onModuleInit(): void {
    registerErrorMapper(idempotencyErrorMapper);
  }
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContentTypeMiddleware).forRoutes('*');
  }
}
```
Verify: với `forRootAsync`, plugin nhận option lúc chạy qua cơ chế nào (`plugins` cố định lúc khai báo, còn option lấy từ config thì có thể phải dùng `IdempotencyPlugin.registerAsync` hoặc truyền qua `useFactory`). Khoá `pluginOptions` ở trên là **giả định**, phải thay bằng đúng API trong tài liệu RedisX, sao cho TTL, lock, wait và prefix đều lấy từ config chứ không hard code. `errorPolicy: 'fail-closed'` là chủ đích: Redis sập thì route tiền trả `503` chứ không chạy mà không có idempotency. Nếu `forRootAsync` không inject được provider `REDIS` của `core/redis` thì import `RedisModule` của mình vào `imports`.

`ThrottlerGuard` ném `ThrottlerException` (429). Filter map sang `rate_limited`, đúng bảng mã lỗi. Header `Retry-After` do guard set (spike đã xác nhận).

Export thêm từ `src/core/http/index.ts`: `Idempotent`, `idempotencyKeyExtractor`, `throttleConfig`, `idempotencyConfig`. Thêm hai config vào `all-configs.ts`. Module chỉ được import `Idempotent` từ `core/http`. Thêm luật dependency-cruiser (Task 17): `@nestjs-redisx/*` và `@nest-lab/*` chỉ được import trong `src/core/http/**`.

Run: `pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 4: ADR 0007 và commit**

Bổ sung vào `docs/adr/0007-http-conventions.md`:
- Dùng `@nestjs/throttler` + `@nest-lab/throttler-storage-redis` (ngoại lệ peer đã duyệt), bọc thêm fail-open.
- Dùng `@nestjs-redisx/idempotency`: bắt buộc có key qua `keyExtractor`; key tách theo scope tenant; request trùng đang chạy thì **chờ**, quá `waitTimeout` → `409`; handler lỗi → giữ trạng thái failed → `409 idempotency_previous_failed`; Redis sập → `503` (fail-closed).
- Ứng viên đã loại: `@node-idempotency/nestjs` (peer ≤ 11, bỏ từ 10/2025, dùng client `redis`), `@node-idempotency/express` (kéo Express 4), `express-idempotency*` (gắn chặt Express, adapter Redis cũ), tự viết (vi phạm quy tắc ưu tiên package).
- Phương án dự phòng cho rate limit: `@nestjs-redisx/rate-limit`.
```bash
git add -A
git commit -m "feat(core): idempotency via @nestjs-redisx and redis-backed rate limiting via @nestjs/throttler"
```

---

### Task 14: `core/cache` — bentocache, khoá có version, chống stampede

**Files:**
- Create: `src/core/cache/{cache.config.ts,cache.service.ts,cache.module.ts,index.ts}`
- Test: `test/integration/core/cache/cache.spec.ts`

**Interfaces:**
- Consumes: `redisConfig`, `REDIS`
- Produces: `CacheService.getOrSet<T>(key: string, loader: () => Promise<T>, opts?: { ttlMs?: number }): Promise<T>`, `key(module: string, group: string, ...parts: string[]): Promise<string>` (có version của group), `bumpVersion(module: string, group: string): Promise<void>`, `delete(key)`

- [ ] **Step 1: Cài và verify**

```bash
pnpm view bentocache dist-tags peerDependencies
pnpm add bentocache
```
Verify trong `https://bentocache.dev/docs`: tạo `BentoCache` với store hai tầng (`bentostore().useL1Layer(memoryDriver(...)).useL2Layer(redisDriver(...)).useBus(redisBusDriver(...))`), `getOrSet({ key, factory, ttl })`, grace period, và cách dùng lại một instance ioredis (hay phải truyền connection options).

- [ ] **Step 2: Viết test trước**

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { CacheModule, CacheService } from '../../../../src/core/cache/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';

describe('cache', () => {
  let a: INestApplication; let b: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'api'); vi.stubEnv('REDIS_URL', getInfra().redis.url); vi.stubEnv('REDIS_KEY_PREFIX', `c${Date.now()}`);
    a = await createTestApp([RedisModule, CacheModule], { http: false });
    b = await createTestApp([RedisModule, CacheModule], { http: false });
  });
  afterAll(async () => { await a.close(); await b.close(); vi.unstubAllEnvs(); });

  it('stampede: N concurrent misses call the loader once', async () => {
    const cache = a.get(CacheService); let calls = 0;
    const key = await cache.key('test', 'stampede', '1');
    const loader = async () => { calls++; await new Promise((r) => setTimeout(r, 200)); return 42; };
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.getOrSet(key, loader)));
    expect(results.every((r) => r === 42)).toBe(true);
    expect(calls).toBe(1);
  });

  it('bumpVersion invalidates the group on every instance', async () => {
    const ca = a.get(CacheService); const cb = b.get(CacheService);
    const k1 = await ca.key('test', 'plans', 'org-1');
    await ca.getOrSet(k1, async () => 'v1');
    expect(await cb.getOrSet(await cb.key('test', 'plans', 'org-1'), async () => 'other')).toBe('v1');
    await ca.bumpVersion('test', 'plans');
    expect(await cb.getOrSet(await cb.key('test', 'plans', 'org-1'), async () => 'v2')).toBe('v2');
  });
});
```
Run: `pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`cache.config.ts`: `CACHE_DEFAULT_TTL_MS` (`.default(60000)`), `CACHE_JITTER_PERCENT` (`.default(10)`, `max(50)`), `CACHE_GRACE_MS` (`.default(300000)`), `CACHE_L1_MAX_ITEMS` (`.default(10000)`), `CACHE_VERSION_TTL_SEC` (`.default(2592000)`). Mỗi cái có `.describe()`.

`cache.service.ts`:
```ts
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { BentoCache } from 'bentocache';
import { type ConfigOf } from '../config/index.js';
import { REDIS, redisConfig } from '../redis/index.js';
import { cacheConfig } from './cache.config.js';

export const BENTO = Symbol('core.bento');

@Injectable()
export class CacheService implements OnApplicationShutdown {
  constructor(
    @Inject(BENTO) private readonly bento: BentoCache<Record<string, never>>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly rcfg: ConfigOf<typeof redisConfig>,
    @Inject(cacheConfig.KEY) private readonly cfg: ConfigOf<typeof cacheConfig>,
  ) {}

  async key(module: string, group: string, ...parts: string[]): Promise<string> {
    const version = (await this.redis.get(this.versionKey(module, group))) ?? '0';
    return [module, group, `v${version}`, ...parts].join(':');
  }

  async bumpVersion(module: string, group: string): Promise<void> {
    const k = this.versionKey(module, group);
    await this.redis.multi().incr(k).expire(k, this.cfg.versionTtlSec).exec();
  }

  getOrSet<T>(key: string, loader: () => Promise<T>, opts: { ttlMs?: number } = {}): Promise<T> {
    const base = opts.ttlMs ?? this.cfg.defaultTtlMs;
    const jitter = base * (this.cfg.jitterPercent / 100) * (Math.random() * 2 - 1);
    return this.bento.getOrSet({ key, factory: loader, ttl: Math.round(base + jitter) });
  }

  delete(key: string): Promise<boolean> {
    return this.bento.delete({ key });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.bento.disconnectAll();
  }

  private versionKey(module: string, group: string): string {
    return `${this.rcfg.keyPrefix}:cachever:${module}:${group}`;
  }
}
```
Provider `BENTO` dựng `BentoCache` theo API đã verify ở Step 1: prefix `${keyPrefix}:cache`, L1 memory với `l1MaxItems`, L2 Redis, bus Redis, grace `graceMs`. Verify tên method `disconnectAll`/`delete` và kiểu generic của `BentoCache`. Nếu tài liệu khác thì sửa theo tài liệu.

Run: `pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): two-tier cache with versioned keys and stampede protection"
```

---

### Task 15: `core/resilience` + `core/security`

**Files:**
- Create: `src/core/resilience/{resilience.config.ts,policies.ts,http-client.ts,resilience.module.ts,index.ts}`, `src/core/security/{security.config.ts,field-cipher.ts,security.module.ts,index.ts}`
- Test: `test/unit/core/resilience/policies.spec.ts`, `test/unit/core/security/field-cipher.spec.ts`

**Interfaces:**
- Produces:
  - `ResiliencePolicies.for(provider: string): IPolicy` (cockatiel), đọc config dạng `RESILIENCE_<PROVIDER>_*`, mặc định lấy từ `RESILIENCE_DEFAULT_*`
  - `HttpClient.request(provider: string, url: string, init?: RequestInit): Promise<Response>`
  - `FieldCipher.encrypt(plain: string): string`, `decrypt(token: string): string`, định dạng `v1.<kid>.<iv b64url>.<ciphertext b64url>.<tag b64url>`

- [ ] **Step 1: Cài package và viết test trước**

```bash
pnpm view cockatiel dist-tags && pnpm add cockatiel
```
`test/unit/core/security/field-cipher.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCipher } from '../../../../src/core/security/index.js';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

describe('FieldCipher', () => {
  it('round-trips and produces different ciphertext each time', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const a = c.encrypt('totp-secret'); const b = c.encrypt('totp-secret');
    expect(a).not.toBe(b);
    expect(c.decrypt(a)).toBe('totp-secret');
  });
  it('decrypts old ciphertext after key rotation', () => {
    const old = new FieldCipher({ k1 }, 'k1').encrypt('x');
    const rotated = new FieldCipher({ k1, k2 }, 'k2');
    expect(rotated.decrypt(old)).toBe('x');
    expect(rotated.encrypt('y').split('.')[1]).toBe('k2');
  });
  it('detects tampering', () => {
    const c = new FieldCipher({ k1 }, 'k1');
    const t = c.encrypt('x').split('.'); t[3] = Buffer.from('evil').toString('base64url');
    expect(() => c.decrypt(t.join('.'))).toThrow();
  });
  it('rejects unknown key id and wrong key length', () => {
    expect(() => new FieldCipher({ k1: Buffer.alloc(16).toString('base64') }, 'k1')).toThrow(/32 bytes/);
    expect(() => new FieldCipher({ k1 }, 'k9')).toThrow(/active key/);
    const c = new FieldCipher({ k1 }, 'k1');
    expect(() => c.decrypt('v1.k9.a.b.c')).toThrow(/unknown key/);
  });
});
```
`test/unit/core/resilience/policies.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { buildPolicy } from '../../../../src/core/resilience/index.js';

const cfg = { timeoutMs: 100, retries: 2, retryBaseMs: 1, breakerThreshold: 3, breakerHalfOpenMs: 50, bulkheadLimit: 2, bulkheadQueue: 0 };

describe('resilience policy', () => {
  it('retries transient failures then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('ok');
    expect(await buildPolicy(cfg).execute(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('times out slow calls', async () => {
    const p = buildPolicy({ ...cfg, retries: 0 });
    await expect(p.execute(({ signal }) => new Promise((r, j) => { const t = setTimeout(r, 1000); signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); }))).rejects.toThrow();
  });
  it('opens the breaker after consecutive failures', async () => {
    const p = buildPolicy({ ...cfg, retries: 0 });
    const fail = () => Promise.reject(new Error('down'));
    for (let i = 0; i < 3; i++) await expect(p.execute(fail)).rejects.toThrow('down');
    await expect(p.execute(() => Promise.resolve('x'))).rejects.toThrow(/open|broken/i);
  });
});
```
Run: `pnpm test`
Expected: FAIL.

- [ ] **Step 2: Cài đặt**

`src/core/security/field-cipher.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

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

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.keys.get(this.activeKid)!, iv);
    cipher.setAAD(Buffer.from(`${VERSION}.${this.activeKid}`));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, this.activeKid, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  decrypt(token: string): string {
    const [version, kid, iv, ct, tag] = token.split('.');
    if (version !== VERSION || !kid || !iv || !ct || !tag) throw new Error('Malformed encrypted value');
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Encrypted value uses unknown key "${kid}"`);
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${version}.${kid}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
```
`security.config.ts`: `FIELD_ENCRYPTION_KEYS` (JSON object `{kid: base64}`, dùng `z.string().transform(JSON.parse).pipe(z.record(z.string(), z.string()))`, **không có giá trị mặc định**), `FIELD_ENCRYPTION_ACTIVE_KID` (bắt buộc). `SecurityModule` (global) cung cấp `FieldCipher` từ config. Vì bắt buộc, `.env.example` sẽ đánh dấu `(required)`. Thêm vào `baseTestEnv()`: `FIELD_ENCRYPTION_KEYS: JSON.stringify({ t1: randomBytes(32).toString('base64') })`, `FIELD_ENCRYPTION_ACTIVE_KID: 't1'` (khoá sinh ngẫu nhiên mỗi lần chạy test). `ALGO`, `IV_BYTES`, `KEY_BYTES`, `VERSION` là hằng số của thuật toán, không phải giá trị tuỳ chỉnh, nên để trong code.

`src/core/resilience/policies.ts`:
```ts
import { ConsecutiveBreaker, ExponentialBackoff, TimeoutStrategy, bulkhead, circuitBreaker, handleAll, retry, timeout, wrap, type IPolicy } from 'cockatiel';

export type PolicyConfig = { timeoutMs: number; retries: number; retryBaseMs: number; breakerThreshold: number; breakerHalfOpenMs: number; bulkheadLimit: number; bulkheadQueue: number };

export function buildPolicy(c: PolicyConfig): IPolicy {
  const retryP = retry(handleAll, { maxAttempts: c.retries, backoff: new ExponentialBackoff({ initialDelay: c.retryBaseMs }) });
  const breakerP = circuitBreaker(handleAll, { halfOpenAfter: c.breakerHalfOpenMs, breaker: new ConsecutiveBreaker(c.breakerThreshold) });
  const timeoutP = timeout(c.timeoutMs, TimeoutStrategy.Aggressive);
  const bulkheadP = bulkhead(c.bulkheadLimit, c.bulkheadQueue);
  return wrap(bulkheadP, retryP, breakerP, timeoutP);
}
```
Verify: export và option của cockatiel version latest (`https://github.com/connor4312/cockatiel#readme`): `ExponentialBackoff` có dùng jitter mặc định không (spec yêu cầu full jitter, thêm option nếu có), thứ tự `wrap`, và `execute(({ signal }) => …)`.

`resilience.config.ts`: các key `RESILIENCE_DEFAULT_TIMEOUT_MS` (10000), `RESILIENCE_DEFAULT_RETRIES` (2), `RESILIENCE_DEFAULT_RETRY_BASE_MS` (200), `RESILIENCE_DEFAULT_BREAKER_THRESHOLD` (5), `RESILIENCE_DEFAULT_BREAKER_HALF_OPEN_MS` (30000), `RESILIENCE_DEFAULT_BULKHEAD_LIMIT` (20), `RESILIENCE_DEFAULT_BULKHEAD_QUEUE` (100), cộng `RESILIENCE_OVERRIDES` (JSON `{ provider: Partial<PolicyConfig> }`, mặc định `{}`). `ResiliencePolicies.for(name)` gộp default với override, cache policy theo tên để breaker giữ trạng thái.

`HttpClient.request(provider, url, init)`: `policies.for(provider).execute(({ signal }) => fetch(url, { ...init, signal }))`. Status 5xx và 429 được coi là lỗi để retry (ném `UpstreamError` có `status`). 4xx còn lại trả về cho caller.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): resilience policies, resilient http client, rotating field encryption"
```

---

### Task 16: Observability — OpenTelemetry, trace xuyên outbox và job, metrics

**Files:**
- Create: `src/instrumentation.ts`, `src/core/observability/{otel.config.ts,trace-propagation.ts,metrics.ts,index.ts}`
- Modify: `src/core/context/context.module.ts` (set `traceId`/`traceparent`), `src/core/queue/worker-host.ts` (khôi phục context), `src/core/outbox/outbox.relay.ts` (metric), `package.json` (scripts `--import`)
- Test: `test/integration/core/observability/trace.spec.ts`

**Interfaces:**
- Produces:
  - `currentTraceparent(): string | undefined`, `withRemoteParent<T>(traceparent: string | undefined, name: string, fn: () => Promise<T>): Promise<T>`
  - Metrics: `outbox_lag_seconds` (gauge), `queue_depth{queue}`, `queue_oldest_job_age_seconds{queue}`, `queue_failed_total{queue}`, `http` (tự instrument)

- [ ] **Step 1: Cài và verify**

```bash
for p in @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/sdk-trace-base bullmq-otel; do pnpm view $p dist-tags peerDependencies; done
pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http bullmq-otel
pnpm add -D @opentelemetry/sdk-trace-base
```
Verify:
- (a) cách khởi tạo `NodeSDK` với ESM qua `node --import` (`https://opentelemetry.io/docs/languages/js/getting-started/nodejs/`, phần ESM cần `--experimental-loader`/`register` hook);
- (b) cách gắn `bullmq-otel` (option `telemetry` của Queue/Worker);
- (c) `propagation.inject/extract` với `W3CTraceContextPropagator`.

- [ ] **Step 2: Viết test trước**

`test/integration/core/observability/trace.spec.ts` dùng `InMemorySpanExporter` từ `@opentelemetry/sdk-trace-base`, đăng ký bằng `NodeTracerProvider` trong test:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { propagation } from '@opentelemetry/api';
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
    const job = exporter.getFinishedSpans().find((s) => s.name === 'job process')!;
    expect(job.spanContext().traceId).toBe(parentTraceId);
  });

  it('starts a new root when no traceparent is carried', async () => {
    await withRemoteParent(undefined, 'orphan job', async () => {});
    expect(exporter.getFinishedSpans().some((s) => s.name === 'orphan job')).toBe(true);
  });
});
```
Cài thêm package mà test dùng, theo đúng tên export đã verify: `pnpm add -D @opentelemetry/sdk-trace-node @opentelemetry/context-async-hooks @opentelemetry/core`.

Run: `pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/core/observability/trace-propagation.ts`:
```ts
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';

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
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
```
Nối vào các chỗ:
- `ContextModule` middleware `setup`: `cls.set(CTX.traceId, trace.getActiveSpan()?.spanContext().traceId)` và `cls.set(CTX.traceparent, currentTraceparent())`.
- `BullmqJobQueue.enqueue/enqueueMany`: `meta.traceparent ??= currentTraceparent()`.
- `EventPublisher`: `headers.traceparent = currentTraceparent()` (thay cho `ctx.traceparent()`).
- `WorkerHost.process`: bọc lời gọi handler bằng `withRemoteParent(decoded.meta.traceparent, \`job ${job.name}\`, …)`, và set `traceId` vào context.

`src/instrumentation.ts`:
```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { TraceIdRatioBasedSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base';
import { otelConfig } from './core/observability/otel.config.js';

const cfg = otelConfig();
if (cfg.enabled) {
  const sdk = new NodeSDK({
    serviceName: cfg.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${cfg.endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${cfg.endpoint}/v1/metrics` }), exportIntervalMillis: cfg.metricsIntervalMs }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(cfg.sampleRatio) }),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  const shutdown = () => { sdk.shutdown().catch((err: unknown) => process.stderr.write(`otel shutdown failed: ${String(err)}\n`)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
```
`otel.config.ts`: `OTEL_ENABLED` (mặc định false), `OTEL_EXPORTER_OTLP_ENDPOINT` (URL, chỉ bắt buộc khi enabled, dùng `.refine` ở cấp object), `OTEL_TRACES_SAMPLE_RATIO` (0.1, trong khoảng 0..1), `OTEL_METRICS_INTERVAL_MS` (15000), `OTEL_SERVICE_NAME` (dùng lại `appConfig.serviceName`, tránh khai báo trùng env: đọc `appConfig().serviceName`). Chỉ lấy mẫu 10% và luôn giữ trace có lỗi: sampler đầu (head sampler) không biết trước request nào sẽ lỗi, nên ghi vào ADR 0014 rằng yêu cầu "giữ 100% trace lỗi" được thực hiện bằng tail sampling ở OTel collector.

`package.json`:
```json
"start:api": "node --import ./dist/instrumentation.js dist/main.api.js",
"start:worker": "node --import ./dist/instrumentation.js dist/main.worker.js"
```
Nếu Step 1 (a) cho thấy ESM cần thêm loader hook thì thêm đúng flag mà tài liệu yêu cầu.

`metrics.ts`: dùng `metrics.getMeter('core')`. Tạo observable gauge `outbox_lag_seconds`, callback query `SELECT extract(epoch FROM now() - min(occurred_at)) FROM outbox_events WHERE published_at IS NULL` qua admin EM (chỉ đăng ký ở worker). `queue_depth`/`queue_oldest_job_age_seconds` gọi `queue.getJobCounts()` và job waiting cũ nhất (verify API BullMQ 6). Counter `queue_failed_total` tăng trong `worker.on('failed')`. Không dùng `orgId` làm attribute.

Run: `pnpm build && pnpm test:int`
Expected: PASS. Chạy tay: `OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm start:api` (có collector cục bộ ở Task 19), gọi một request, thấy span `GET` và `pg` trong collector.

- [ ] **Step 4: ADR 0014 và commit**

`docs/adr/0014-observability.md`: OTLP, head sampling 10%, tail sampling ở collector, không gắn label có quá nhiều giá trị.
```bash
git add -A
git commit -m "feat(core): opentelemetry tracing across http, outbox and jobs; queue and outbox metrics"
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
Trả lời prompt để phân tích TypeScript. `tsconfig` dùng TS 6 (package `typescript`). Script: `"arch": "depcruise src --config .dependency-cruiser.cjs"`.

- [ ] **Step 2: Viết test trước (fixture vi phạm)**

Tạo cây fixture mô phỏng cấu trúc thật trong `test/architecture/fixtures/src/`:
```
core/queue/ok.ts                      import 'bullmq' (hợp lệ)
core/http/uses-orm.ts                 import '@mikro-orm/core'  → vi phạm luật 4
modules/billing/domain/bad.ts         import '../infra/repo.js' → vi phạm luật 7
modules/billing/infra/repo.ts         import '@mikro-orm/core' (hợp lệ)
modules/billing/index.ts
modules/tenancy/deep.ts               import '../billing/domain/bad.js' → vi phạm luật 2 (không qua index)
core/bad-core.ts                      import '../modules/billing/index.js' → vi phạm luật 3
features/x/leak.ts                    import '../../modules/billing/infra/repo.js' → vi phạm luật 1
features/x/uses-bullmq.ts             import 'bullmq' → vi phạm luật 5
modules/billing/http/uses-redisx.ts   import '@nestjs-redisx/idempotency' → vi phạm luật http-libs-only-in-core-http
modules/a/cycle-a.ts ↔ modules/a/cycle-b.ts → vi phạm luật 8
core/http/express-ok.ts               import 'express' (hợp lệ)
modules/billing/http/uses-express.ts  import 'express' → vi phạm luật 6
```
Mỗi file chỉ chứa đúng lệnh import tương ứng, ví dụ `import '@mikro-orm/core';`.

`test/unit/architecture/rules.spec.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function violations(): string[] {
  try {
    execFileSync('pnpm', ['depcruise', 'test/architecture/fixtures/src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'], { encoding: 'utf8', stdio: 'pipe' });
    return [];
  } catch (e) {
    const out = (e as { stdout: string }).stdout;
    return (JSON.parse(out).summary.violations as { rule: { name: string } }[]).map((v) => v.rule.name);
  }
}

describe('architecture rules', () => {
  const v = violations();
  it.each([
    'features-only-public-api', 'modules-only-index-of-other-modules', 'core-independent',
    'orm-only-in-infra', 'bullmq-only-in-core-queue', 'http-platform-only-in-core-http',
    'domain-pure', 'no-circular', 'http-libs-only-in-core-http',
  ])('rule %s catches its fixture violation', (rule) => {
    expect(v).toContain(rule);
  });
  it('real source tree has no violations', () => {
    expect(() => execFileSync('pnpm', ['arch'], { stdio: 'pipe' })).not.toThrow();
  });
});
```
Run: `pnpm test`
Expected: FAIL, vì các luật chưa được định nghĩa.

- [ ] **Step 3: Định nghĩa luật trong `.dependency-cruiser.cjs`**

Thêm vào mảng `forbidden` (file này do `--init` sinh, chỉ thêm luật, giữ phần còn lại):
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
  to: { path: 'node_modules/(bullmq|@nestjs/bullmq)/' } },
{ name: 'http-platform-only-in-core-http', severity: 'error',
  from: { pathNot: '(^|/)src/core/http/' },
  to: { path: 'node_modules/(express|fastify|@nestjs/platform-express|@nestjs/platform-fastify)/' } },
{ name: 'domain-pure', severity: 'error',
  from: { path: '(^|/)src/.+/domain/' },
  to: { path: '((^|/)src/.+/(infra|http)/|node_modules/(@mikro-orm|bullmq|express|ioredis)/)' } },
{ name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
{ name: 'http-libs-only-in-core-http', severity: 'error',
  from: { pathNot: '(^|/)src/core/http/' },
  to: { path: 'node_modules/(@nestjs-redisx|@nest-lab|@nestjs/throttler)/' } },
```
Verify: cú pháp group reference `$2` trong `pathNot` và regex lookahead có được dependency-cruiser hỗ trợ không (`https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md`). Nếu không thì viết lại bằng `pathNot` liệt kê cụ thể. Luật `no-circular` có thể đã có sẵn từ `--init` dưới tên khác: đổi tên cho khớp với test, hoặc sửa test cho khớp tên sẵn có. `src/core/database/**` và `**/infra/**` được import MikroORM. `src/core/redis/**` import `ioredis` là hợp lệ. `src/main.api.ts`/`http-bootstrap.ts` import `express` phải nằm trong `core/http`: chuyển mọi import `express` vào `http-bootstrap.ts` (đã làm ở Task 12).

Chỉnh fixture theo cú pháp regex cuối cùng, sao cho mỗi luật chỉ bắt đúng fixture của nó.

Run: `pnpm test && pnpm arch`
Expected: PASS (fixture bị bắt đủ, `src` sạch).

- [ ] **Step 4: Quét hard code (viết test trước)**

`test/unit/architecture/hardcode-scan.spec.ts`:
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'src';
const ALLOW_FILE = /\.config\.ts$|\/config\/|instrumentation\.ts$/;
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'cron expression', re: /['"`](\*|\d+|\*\/\d+)(\s+(\*|\d+|\*\/\d+|[\d,-]+)){4,5}['"`]/ },
  { name: 'http(s) URL', re: /['"`]https?:\/\/(?!schemas?\.|swc\.rs)[^'"`]+['"`]/ },
  { name: 'duration literal (ms)', re: /\b(setTimeout|setInterval)\([^,]+,\s*\d{3,}\s*\)/ },
  { name: 'ttl/timeout literal', re: /\b(ttl|timeout|timeoutMs|ttlMs|delayMs|limit|batchSize)\s*:\s*\d{2,}\b/i },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
}

describe('no hard-coded tunables in src', () => {
  const offenders = files(ROOT)
    .filter((f) => !ALLOW_FILE.test(f.replaceAll('\\', '/')))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      PATTERNS.filter((p) => p.re.test(line)).map((p) => `${f}:${i + 1} ${p.name}: ${line.trim()}`)));
  it('finds none', () => {
    expect(offenders).toEqual([]);
  });
});
```
Run: `pnpm test`
Expected: PASS. Nếu FAIL thì mỗi dòng bị báo phải được chuyển vào config. Không được thêm ngoại lệ vào `ALLOW_FILE` để cho qua. Nếu một dòng thật sự không phải giá trị tuỳ chỉnh (ví dụ `IV_BYTES = 12` là hằng số của thuật toán) và pattern bắt nhầm, thì sửa pattern, kèm một test chứng minh pattern mới vẫn bắt được trường hợp thật.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(arch): enforce module boundaries and forbid hard-coded tunables"
```

---

### Task 18: Health + tắt êm + endpoint health của worker

**Files:**
- Create: `src/core/health/{health.config.ts,draining.ts,health.controller.ts,shutdown.ts,worker-health.server.ts,health.module.ts,index.ts}`
- Modify: `src/main.api.ts`, `src/main.worker.ts`, `src/app-api.module.ts`, `src/app-worker.module.ts`
- Test: `test/e2e/core/health.e2e.spec.ts`

**Interfaces:**
- Consumes: `TxEm`/EM, `REDIS`, `WorkerHost`, `OutboxRelay`, `CoreErrors.SERVICE_UNAVAILABLE`
- Produces: `Draining` (`isDraining(): boolean`, `start(): void`), `GET /health/live`, `GET /health/ready`, `ShutdownCoordinator` (thứ tự: draining → chờ `HEALTH_DRAIN_DELAY_MS` → đóng HTTP → Nest shutdown hook đóng worker, relay, pool)

- [ ] **Step 1: Cài package và viết test trước**

```bash
pnpm view @nestjs/terminus dist-tags peerDependencies && pnpm add @nestjs/terminus
```
`test/e2e/core/health.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { Draining, HealthModule } from '../../../src/core/health/index.js';
import { JobHandler, JobQueue, QueueModule, WorkerHost, defineJob, type JobContext } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { FixtureQueue } from '../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../support/app-factory.js';
import { dbEnv, stubEnv } from '../../support/db.js';
import { getInfra } from '../../support/infra.js';

const done: string[] = [];
const Long = defineJob({ name: 'fixture.long', queue: FixtureQueue, version: 1, schema: z.object({ id: z.string() }) });
@Injectable() @JobHandler(Long)
class LongHandler { async handle(ctx: JobContext<{ id: string }>) { await new Promise((r) => setTimeout(r, 1500)); done.push(ctx.payload.id); } }
@Module({ providers: [LongHandler] }) class H {}

describe('health + shutdown', () => {
  let app: INestApplication;
  beforeAll(async () => {
    stubEnv({ ...dbEnv(), APP_ROLE: 'api', REDIS_URL: getInfra().redis.url, HEALTH_DRAIN_DELAY_MS: '0', WORKER_QUEUES: 'fixture' }, vi.stubEnv);
    app = await createTestApp([DatabaseModule.forRoot(), RedisModule, QueueModule.forRoot({ runWorkers: true }), HealthModule, H]);
  });
  afterAll(async () => { vi.unstubAllEnvs(); });

  it('live is always 200; ready is 200 when DB and Redis are up', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('ready turns 503 while draining, live stays 200', async () => {
    app.get(Draining).start();
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(503);
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });

  it('sigterm mid-job: in-flight job completes before the worker closes', async () => {
    await app.get(JobQueue).enqueue(Long, { id: 'j1' });
    await new Promise((r) => setTimeout(r, 300));
    await app.close();
    expect(done).toContain('j1');
  });
});
```
Run: `pnpm build && pnpm test:int`
Expected: FAIL.

- [ ] **Step 2: Cài đặt**

`health.config.ts`: `HEALTH_CHECK_TIMEOUT_MS` (1000), `HEALTH_DRAIN_DELAY_MS` (5000, thời gian chờ load balancer ngừng gửi request), `WORKER_HEALTH_PORT` (3001), `WORKER_HEALTH_HOST` (0.0.0.0).

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
`health.controller.ts`:
```ts
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { type ConfigOf } from '../config/index.js';
import { TxEm } from '../database/index.js';
import { REDIS } from '../redis/index.js';
import { Draining } from './draining.js';
import { healthConfig } from './health.config.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService, private readonly draining: Draining, private readonly txEm: TxEm,
    @Inject(REDIS) private readonly redis: Redis, @Inject(healthConfig.KEY) private readonly cfg: ConfigOf<typeof healthConfig>,
  ) {}

  @Get('live')
  live() { return { status: 'ok' }; }

  @Get('ready')
  @HealthCheck()
  ready() {
    if (this.draining.isDraining()) throw new ServiceUnavailableException('draining');
    return this.health.check([
      () => this.withTimeout('database', this.txEm.get().fork().getConnection().execute('SELECT 1')),
      () => this.withTimeout('redis', this.redis.ping()),
    ]);
  }

  private async withTimeout(key: string, p: Promise<unknown>): Promise<HealthIndicatorResult> {
    const t = new Promise<never>((_, j) => setTimeout(() => j(new Error(`${key} health check timed out`)), this.cfg.checkTimeoutMs));
    await Promise.race([p, t]);
    return { [key]: { status: 'up' } };
  }
}
```
Verify: API `HealthIndicatorService`/`HealthCheckService.check` của `@nestjs/terminus` latest. Nếu indicator tự viết phải dùng `HealthIndicatorService` mới thì chuyển sang cách đó theo tài liệu. Lỗi của `withTimeout` phải được terminus chuyển thành 503.

`shutdown.ts`: `ShutdownCoordinator implements BeforeApplicationShutdown`: `beforeApplicationShutdown()` gọi `draining.start()` rồi `await sleep(cfg.drainDelayMs)`. Nest gọi các hook `onApplicationShutdown` của `WorkerHost` (đóng worker, chờ job), `OutboxRelay` (dừng loop), `BullmqJobQueue`, `RedisModule`, và MikroORM (đóng pool) sau hook này. Mỗi hook có timeout riêng (queue đã có `QUEUE_SHUTDOWN_TIMEOUT_MS`).

Verify thứ tự hook của Nest (`https://docs.nestjs.com/fundamentals/lifecycle-events`): `beforeApplicationShutdown` chạy trước khi HTTP server đóng. Thứ tự giữa các module theo đồ thị import: module import sau đóng trước. Nếu `RedisModule` đóng trước `WorkerHost` thì worker không `close()` sạch được. Test "sigterm mid-job" sẽ lộ ra lỗi này. Khi đó chuyển đóng Redis và pool vào một coordinator duy nhất, chạy tuần tự đúng thứ tự trong spec.

`worker-health.server.ts`: trong worker, dùng `node:http` tạo server tối thiểu, chỉ phục vụ `/health/live` và `/health/ready` (dùng chung logic kiểm tra với controller, tách hàm `checkReady()`), lắng nghe `WORKER_HEALTH_PORT`. Server đóng trong `onApplicationShutdown`. `HealthModule` đăng ký controller cho api và server cho worker, theo `appConfig.role`.

Run: `pnpm build && pnpm test:int`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): liveness/readiness, draining and ordered graceful shutdown"
```

---

### Task 19: Docker image, Compose cho app, collector, chaos test

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker/otel-collector/config.yaml`, `test/chaos/redis-outage.spec.ts`, `test/chaos/worker-kill.spec.ts`
- Modify: `compose.yaml` (thêm service api, worker, migrate, otel-collector)
- Modify: `vitest.config.ts` (thêm project `chaos`)

**Interfaces:**
- Produces: image chạy được cả 3 vai trò. `pnpm test:chaos`. Số đo kích thước image và thời gian khởi động.

- [ ] **Step 1: Khởi tạo Dockerfile bằng CLI rồi sửa**

Run: `docker init --help`. Nếu có template Node thì chạy `docker init` (chọn Node, pnpm, lệnh build `pnpm build`). Đọc file sinh ra, rồi sửa theo spec cha, mục 13.3, thành nội dung cuối như sau (tag và digest lấy bằng lệnh như Task 2, Step 1):
```bash
curl -s "https://hub.docker.com/v2/repositories/library/node/tags?page_size=100&name=bookworm-slim" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).results.map(t=>t.name).filter(n=>/^24\.\d+\.\d+-bookworm-slim$/.test(n)).slice(0,3).join(' ')))"
docker buildx imagetools inspect node:<tag từ lệnh trên> --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect gcr.io/distroless/nodejs24-debian13:nonroot --format '{{json .Manifest.Digest}}'
```
Thêm `IMAGE_NODE_BUILD` và `IMAGE_NODE_RUNTIME` vào `docker/images.env`.

`Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
ARG BUILD_IMAGE
ARG RUNTIME_IMAGE

FROM ${BUILD_IMAGE} AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile \
 && pnpm build \
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
Image distroless có `ENTRYPOINT ["/nodejs/bin/node"]`, nên `CMD` chỉ chứa tham số truyền cho node. Verify ENTRYPOINT bằng `docker buildx imagetools inspect … --format '{{json .Image.Config}}'`. Verify `pnpm prune --prod` với pnpm latest (`pnpm prune --help`). Nếu build `dist` có dùng file ngoài `src` (migration nằm trong `db/`) thì kiểm tra `dist/db/migrations` có tồn tại sau build không. Nếu chưa có thì sửa `tsconfig`/`nest-cli.json` để SWC biên dịch cả `db/`.

Thêm allowlist cho install script: chạy `pnpm config set --location project` với key cho phép build script theo tài liệu pnpm latest (`onlyBuiltDependencies` hoặc tên mới). Danh sách là các package thật sự cần build script, xem cảnh báo của `pnpm install`.

`.dockerignore`:
```
.git
node_modules
dist
coverage
.env
.env.*
!.env.example
test
docs
**/*.md
.github
```
Run:
```bash
docker buildx build --build-arg BUILD_IMAGE=$(grep IMAGE_NODE_BUILD docker/images.env | cut -d= -f2-) --build-arg RUNTIME_IMAGE=$(grep IMAGE_NODE_RUNTIME docker/images.env | cut -d= -f2-) -t backend-demo:local --load .
docker image ls backend-demo:local --format '{{.Size}}'
docker run --rm --entrypoint /nodejs/bin/node backend-demo:local -e "process.getuid && console.log(process.getuid())"
```
Expected: build thành công, kích thước được ghi lại (mục tiêu ≤ 200 MB), UID in ra là `65532`.

- [ ] **Step 2: Compose cho app + collector**

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
    environment: { DB_HOST: pgbouncer, REDIS_URL: "redis://redis:6379" }
    ports: ["${HTTP_PORT_HOST}:3000"]
    depends_on: { migrate: { condition: service_completed_successfully }, redis: { condition: service_healthy } }
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
  worker:
    image: backend-demo:local
    command: ["--import", "./dist/instrumentation.js", "dist/main.worker.js"]
    env_file: [.env]
    environment: { DB_HOST: pgbouncer, REDIS_URL: "redis://redis:6379" }
    depends_on: { migrate: { condition: service_completed_successfully }, redis: { condition: service_healthy } }
  otel-collector:
    image: ${IMAGE_OTEL_COLLECTOR}
    profiles: [observability]
    volumes: ["./docker/otel-collector/config.yaml:/etc/otelcol/config.yaml:ro"]
    ports: ["4318:4318"]
```
Port cứng `3000`/`5432`/`6379` ở đây là port **bên trong container**, cố định theo image, không phải giá trị tuỳ chỉnh. Port phía host lấy từ `.env`. Thêm `HTTP_PORT_HOST` vào `devInfraConfig`. `REDIS_URL` với host `redis` là tên service trong compose. Nếu muốn tách hẳn thì đặt `COMPOSE_REDIS_URL` trong `.env` và tham chiếu `${COMPOSE_REDIS_URL}`. Làm cách này để quét hard code không có ngoại lệ.

Lấy image collector theo cách của Task 2 (`otel/opentelemetry-collector-contrib`, tag stable mới nhất, pin digest). `docker/otel-collector/config.yaml`: receiver OTLP HTTP, processor `tail_sampling` (policy giữ trace lỗi + probabilistic), exporter `debug`. Verify tên processor và option trong README của collector-contrib.

Run: `docker compose --env-file docker/images.env --env-file .env up -d && curl -fsS localhost:<HTTP_PORT_HOST>/health/ready`
Expected: `{"status":"ok",...}`. Đo thời gian từ `up` tới lúc ready bằng `docker compose logs api --timestamps` (mục tiêu < 3 giây kể từ khi process bắt đầu), ghi vào ADR 0013.

- [ ] **Step 3: Chaos test (viết trước, chạy trên Toxiproxy)**

```bash
pnpm view @testcontainers/toxiproxy dist-tags && pnpm add -D @testcontainers/toxiproxy
```
Thêm project `chaos` vào `vitest.config.ts`:
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

Tách hàm `readImages()` ở Task 2 ra `test/support/images.ts` (export), để global setup và chaos test dùng chung. Lấy image Toxiproxy theo cách của Task 2 Step 1 (`ghcr.io/shopify/toxiproxy`, tag stable mới nhất, pin digest), rồi thêm `IMAGE_TOXIPROXY=` vào `docker/images.env`.

Verify API ở `https://node.testcontainers.org/modules/toxiproxy/` và `https://node.testcontainers.org/features/networking/`: `ToxiProxyContainer`, `createProxy({ name, upstream })` trả về `{ host, port, setEnabled(bool) }`, `Network`, `withNetwork`, `withNetworkAliases`.

Thêm config stalled job vào `queueConfig` (Task 8) và truyền vào `new Worker(...)` trong `WorkerHost` (verify tên option `stalledInterval`, `maxStalledCount` trong tài liệu BullMQ 6):
```ts
stalledIntervalMs: 'QUEUE_STALLED_INTERVAL_MS'   // z.coerce.number().int().positive().default(30000).describe('How often workers check for stalled jobs')
lockDurationMs: 'QUEUE_LOCK_DURATION_MS'         // z.coerce.number().int().positive().default(30000).describe('Job lock duration; must exceed event-loop stalls')
```

`test/chaos/redis-outage.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { HttpModule, applyHttpDefaults } from '../../src/core/http/index.js';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { ToxiProxyContainer, type StartedToxiProxyContainer } from '@testcontainers/toxiproxy';
import { DatabaseModule, TxEm, runMigrations } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { FixtureModule } from '../fixtures/fixture.module.js';
import { AuditSubscriber, MailerSubscriber, received } from '../fixtures/fixture.events.js';
import { createTestApp } from '../support/app-factory.js';
import { readImages } from '../support/images.js';

@Module({ providers: [AuditSubscriber, MailerSubscriber] }) class Subs {}
@Controller('chaos') class ChaosPing { @Get('ping') ping() { return { ok: true }; } }
@Module({ controllers: [ChaosPing] }) class Ping {}
const OUTAGE_MS = 10_000;
const EVENTS = 20;
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
    redis = await new GenericContainer(images.IMAGE_REDIS!).withNetwork(network).withNetworkAliases('redis').withExposedPorts(6379).start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY!).withNetwork(network).start();
    proxy = await toxi.createProxy({ name: 'redis', upstream: 'redis:6379' });
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('REDIS_URL', `redis://${proxy.host}:${proxy.port}`);
    vi.stubEnv('WORKER_QUEUES', 'events');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '200');
    vi.stubEnv('QUEUE_DEFAULT_BACKOFF_MS', '100');
    await runMigrations('up');
    app = await createTestApp([DatabaseModule.forRoot(), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule, EventsModule, FixtureModule, Subs, HttpModule, Ping], { beforeInit: applyHttpDefaults });
  });
  afterAll(async () => {
    await app.close(); await toxi.stop(); await redis.stop(); await network.stop(); vi.unstubAllEnvs();
  });

  it('commands keep succeeding while Redis is down and events are delivered exactly once after recovery', async () => {
    received.length = 0;
    const bodies = Array.from({ length: EVENTS }, (_, i) => `outage-${Date.now()}-${i}`);
    await proxy.setEnabled(false);

    for (const body of bodies) await request(app.getHttpServer()).post('/fixture/notes').send({ body }).expect(201);

    const conn = app.get(TxEm).get().getConnection();
    const pending = async () => Number((await conn.execute<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM outbox_events WHERE published_at IS NULL AND payload->>'body' = ANY(?)`, [bodies]))[0]!.n);
    await new Promise((r) => setTimeout(r, OUTAGE_MS));
    expect(await pending()).toBe(EVENTS);

    await proxy.setEnabled(true);
    await until(() => bodies.every((b) => received.filter((r) => r.body === b).length === 2), 120_000);
    await new Promise((r) => setTimeout(r, 2000));

    const pairs = received.filter((r) => bodies.includes(r.body)).map((r) => `${r.consumer}:${r.eventId}`);
    expect(pairs).toHaveLength(EVENTS * 2);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(await pending()).toBe(0);
  });

  it('rate limiting fails open while Redis is down (spec §9)', async () => {
    await proxy.setEnabled(false);
    try {
      await request(app.getHttpServer()).get('/chaos/ping').expect(200);
    } finally {
      await proxy.setEnabled(true);
    }
  });
});
```
`OUTAGE_MS` và `EVENTS` là tham số của bộ test, không phải config của app.

Worker bị kill phải là một **process thật**. Tạo entrypoint riêng cho test, `test/chaos/kill-worker.entry.ts` (chạy bằng loader TS đã chọn ở Task 3, ví dụ `@swc-node/register`):
```ts
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';
import '../../src/core/config/all-configs.js';
import { configFactories } from '../../src/core/config/index.js';
import { ContextModule } from '../../src/core/context/index.js';
import { DatabaseModule, UnitOfWork } from '../../src/core/database/index.js';
import { Inbox, OutboxModule } from '../../src/core/outbox/index.js';
import { JobHandler, QueueModule, type JobContext } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { FixtureModule, FixtureRepo } from '../fixtures/fixture.module.js';
import { KillJob } from './kill.jobs.js';

@Injectable()
@JobHandler(KillJob)
class KillHandler {
  constructor(private readonly uow: UnitOfWork, private readonly inbox: Inbox, private readonly repo: FixtureRepo) {}
  async handle(ctx: JobContext<z.infer<typeof KillJob.schema>>): Promise<void> {
    await this.uow.run(() => this.inbox.once('chaos.kill', ctx.payload.eventId, async () => {
      await this.repo.insertSystemNote(ctx.payload.body);
      await new Promise((r) => setTimeout(r, ctx.payload.holdMs));
    }));
    process.send?.({ done: ctx.payload.body });
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: configFactories() }), ContextModule,
    DatabaseModule.forRoot(), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule, FixtureModule],
  providers: [KillHandler],
})
class KillWorkerModule {}

const ctx = await NestFactory.createApplicationContext(KillWorkerModule);
ctx.enableShutdownHooks();
await ctx.init();
process.send?.({ ready: true });
```
`test/chaos/kill.jobs.ts`:
```ts
import { z } from 'zod';
import { defineJob } from '../../src/core/queue/index.js';
import { FixtureQueue } from '../fixtures/fixture.jobs.js';

export const KillJob = defineJob({
  name: 'chaos.kill', queue: FixtureQueue, version: 1,
  schema: z.object({ eventId: z.uuid(), body: z.string(), holdMs: z.number().int().positive() }),
});
```
`test/chaos/worker-kill.spec.ts`:
```ts
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule, TxEm, runMigrations } from '../../src/core/database/index.js';
import { JobQueue, QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { createTestApp } from '../support/app-factory.js';
import { baseTestEnv } from '../support/env.js';
import { KillJob } from './kill.jobs.js';

const HOLD_MS = 5_000;
const STALLED_MS = 1_000;
const TS_LOADER_ARGS = ['--import', '@swc-node/register/esm-register'];

function startWorker(env: Record<string, string>): Promise<ChildProcess> {
  const child = fork('test/chaos/kill-worker.entry.ts', [], { execArgv: TS_LOADER_ARGS, env: { ...process.env, ...env }, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('message', (m: { ready?: boolean }) => (m.ready ? resolve(child) : reject(new Error('unexpected message'))));
    child.once('exit', (code) => reject(new Error(`worker exited early with ${code}`)));
  });
}

describe('worker killed mid-job', () => {
  let producer: INestApplication;
  const env = () => ({
    ...baseTestEnv(), APP_ROLE: 'worker', WORKER_QUEUES: 'fixture',
    QUEUE_STALLED_INTERVAL_MS: String(STALLED_MS), QUEUE_LOCK_DURATION_MS: String(STALLED_MS),
  });

  beforeAll(async () => {
    await runMigrations('up');
    producer = await createTestApp([DatabaseModule.forRoot(), RedisModule, QueueModule.forRoot({ runWorkers: false })], { http: false });
    await producer.init();
  });
  afterAll(async () => { await producer.close(); vi.unstubAllEnvs(); });

  it('job is redelivered to a new worker and its effect is committed exactly once', async () => {
    const body = `kill-${randomUUID()}`;
    const first = await startWorker(env());
    await producer.get(JobQueue).enqueue(KillJob, { eventId: randomUUID(), body, holdMs: HOLD_MS });
    await new Promise((r) => setTimeout(r, HOLD_MS / 5));
    first.kill('SIGKILL');

    const second = await startWorker(env());
    const done = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('job was not redelivered')), 60_000);
      second.on('message', (m: { done?: string }) => { if (m.done === body) { clearTimeout(timer); resolve(m.done); } });
    });
    second.kill('SIGTERM');

    expect(done).toBe(body);
    const rows = await producer.get(TxEm).get().getConnection().execute<{ n: string }[]>('SELECT count(*)::text AS n FROM fixture_notes WHERE body = ?', [body]);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
```
`HOLD_MS`, `STALLED_MS` là tham số của bộ test. Worker đầu bị kill khi đang giữ transaction, nên Postgres rollback dòng vừa insert. Worker thứ hai nhận lại job sau khi phát hiện stalled, và commit đúng một lần. Nếu loader TS ở Task 3 khác `@swc-node/register` thì sửa `TS_LOADER_ARGS` theo lựa chọn đã ghi trong ADR 0013.

Run: `pnpm build && pnpm test:chaos`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "build: distroless multi-stage image, compose for app, chaos tests for redis outage and worker kill"
```

---

### Task 20: CI, release, nightly, Renovate

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/nightly.yml`, `renovate.json`

**Interfaces:**
- Produces: pipeline cho PR (lint, arch, typecheck, unit, integration, build, docker + Trivy, oasdiff), pipeline release (multi-arch, SBOM, provenance, cosign), pipeline nightly (chaos)

- [ ] **Step 1: Lấy version của các action bằng lệnh**

Run:
```bash
for a in actions/checkout actions/setup-node pnpm/action-setup docker/setup-buildx-action docker/build-push-action docker/login-action aquasecurity/trivy-action sigstore/cosign-installer oasdiff/oasdiff-action; do
  echo "$a $(curl -s https://api.github.com/repos/$a/releases/latest | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).tag_name))")"
done
```
Với mỗi tag, lấy SHA commit (`curl -s https://api.github.com/repos/<a>/git/ref/tags/<tag>`). Pin action theo SHA, ghi tag trong comment. Renovate sẽ cập nhật về sau.

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
      - uses: oasdiff/oasdiff-action/breaking@<sha> # <tag>
        with: { base: 'origin/main:openapi.json', revision: openapi.json, fail-on: ERR }
  image:
    runs-on: ubuntu-latest
    needs: checks
    steps:
      - uses: actions/checkout@<sha> # <tag>
      - uses: docker/setup-buildx-action@<sha> # <tag>
      - id: images
        run: grep -E '^IMAGE_NODE_(BUILD|RUNTIME)=' docker/images.env | sed 's/^/"/;s/$/"/' | sed 's/^"\(IMAGE_NODE_[A-Z]*\)=/\1=/' >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@<sha> # <tag>
        with:
          context: .
          load: true
          tags: backend-demo:ci
          build-args: |
            BUILD_IMAGE=${{ steps.images.outputs.IMAGE_NODE_BUILD }}
            RUNTIME_IMAGE=${{ steps.images.outputs.IMAGE_NODE_RUNTIME }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: aquasecurity/trivy-action@<sha> # <tag>
        with: { image-ref: backend-demo:ci, severity: 'HIGH,CRITICAL', ignore-unfixed: true, exit-code: '1' }
```
Tạo `.nvmrc` bằng lệnh `node --version > .nvmrc` (lấy version Node đang dùng, dòng 24 LTS). Verify input của từng action theo README của đúng tag đã pin (`oasdiff-action`, `trivy-action`). Bước `images` dùng `sed` để chuyển `KEY=value` thành output. Kiểm tra lại cú pháp bằng `act` hoặc chạy thử trên nhánh, và sửa nếu output rỗng.

- [ ] **Step 3: `release.yml` và `nightly.yml`**

`release.yml` (trigger `push: tags: ['v*']`, `permissions: { contents: read, packages: write, id-token: write }`):
- login registry (GHCR) bằng `docker/login-action`
- `docker/build-push-action` với `platforms: linux/amd64,linux/arm64`, `push: true`, `sbom: true`, `provenance: mode=max`, tag `ghcr.io/${{ github.repository }}:${{ github.ref_name }}`
- `sigstore/cosign-installer`, rồi `cosign sign --yes ghcr.io/...@${{ steps.build.outputs.digest }}` (keyless qua OIDC)

`nightly.yml` (`schedule: cron` lấy từ comment chỉ dẫn, vì đây là lịch CI chứ không phải config của app, và giá trị ghi trực tiếp trong workflow là chỗ duy nhất GitHub đọc; ghi ngoại lệ này vào ADR 0013): chạy `pnpm build && pnpm test:chaos`, và e2e trên Fastify khi đã có adapter (sub-project sau; hiện tại chỉ chạy chaos).

- [ ] **Step 4: `renovate.json`**

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "helpers:pinGitHubActionDigests", "docker:pinDigests"],
  "rangeStrategy": "pin",
  "customManagers": [
    {
      "customType": "regex",
      "managerFilePatterns": ["/^docker/images\\.env$/"],
      "matchStrings": ["IMAGE_[A-Z_]+=(?<depName>[^:@\\s]+):(?<currentValue>[^@\\s]+)@(?<currentDigest>sha256:[a-f0-9]+)"],
      "datasourceTemplate": "docker"
    }
  ],
  "packageRules": [{ "matchPackageNames": ["/^@mikro-orm\\//"], "groupName": "mikro-orm" }]
}
```
Verify tên key `managerFilePatterns` (hoặc `fileMatch` ở bản cũ) theo tài liệu Renovate hiện hành. Chạy `pnpm dlx renovate-config-validator` (xem `--help`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: pr checks, image scan, openapi diff, signed multi-arch release, nightly chaos, renovate"
```

---

### Task 21: ADR còn lại, README, bảng số đo

**Files:**
- Create: `docs/adr/0001-modular-monolith.md`, `0002-clone-and-upstream.md`, `0004-ports-and-adapters.md`, `0011-cqrs-without-eventbus.md`, và hoàn tất các ADR đã mở ở task trước
- Create/Modify: `README.md` (thay README do CLI sinh)

- [ ] **Step 1: ADR**

Viết theo mẫu MADR (Bối cảnh, Quyết định, Phương án đã loại, Hệ quả). Nội dung lấy từ spec cha (mục 1, 1.1, 4.2, 7) và các quyết định phát sinh khi làm (Task 1, 5, 8, 10). Không bịa quyết định mới: chỗ nào spec chưa quyết thì ghi "Chưa quyết, xem sub-project N".

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
- Bảng env: sinh bằng `pnpm env:example`, README chỉ trỏ tới `.env.example`, không chép lại, để không bị lệch.
- Cách thêm: config (`defineConfig`), queue/job (`defineQueue`/`defineJob` + `@JobHandler`), cron (`defineCron` với lịch lấy từ config), event (`defineEvent` + `EventPublisher.publish` trong `UnitOfWork.run` + `@EventSubscriber`), bảng có RLS (migration tạo bằng CLI, policy fail-closed, `OrgScope.run`). Mỗi mục có một ví dụ ngắn lấy từ `test/fixtures`.
- Quy tắc: 3 quy tắc trong Global Constraints.
- Lệnh kiểm tra: `pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm test:int`.

- [ ] **Step 3: Bảng số đo**

Thêm vào ADR 0013 một bảng: build SWC, type-check TS 7, build image (khi có cache, và khi không có cache), kích thước image, thời gian khởi động tới ready. Mỗi dòng có cột "mục tiêu" (spec cha, mục 13) và cột "đo được". Chỉ số nào không đạt thì ghi rõ và báo Sếp, không sửa mục tiêu cho khớp.

- [ ] **Step 4: Chạy toàn bộ kiểm tra lần cuối**

Run:
```bash
pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm build && pnpm test:int && pnpm test:chaos
```
Expected: tất cả PASS. Dán output tóm tắt vào mô tả PR, hoặc báo cáo cho Sếp.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: adrs, readme and measured build/runtime numbers for sub-project 1"
```
