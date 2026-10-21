# SP7 Plan 7D — Feature mẫu `example` (Project theo org) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `src/features/example`, tài nguyên `Project` theo org ở vùng template, đi hết đường của boilerplate (RLS FORCE, catalogue quyền, cờ + quota SP4, `@Idempotent()`, phân trang cursor, event có cờ `audit`/`webhook`, cron quét xuyên org qua `defineOrgSweep`, job theo org, participant xoá cứng order 200, migration có down đã test), và là khuôn chép chuẩn cho feature của dự án.

**Architecture:** Controller → `ProjectService` → `UnitOfWork`; SQL thô qua `Db.execute` ở `infra/` (như mọi module hiện có, không entity MikroORM). Thứ tự khoá ở mọi đường: dòng nghiệp vụ trước, bộ đếm quota sau (S7-D35). Cron tỏa ra chỉ là một lời gọi `defineOrgSweep` cộng handler mỏng; job theo org chạy trong `OrgScope` do `WorkerHost` bọc. Mẫu đăng ký vào composition bằng ba dòng `// upstream:template` của `src/app.modules.ts`.

**Tech Stack:** NestJS 11, Postgres 18 (RLS, `uuidv7()`), Zod 4, BullMQ 6.3.8 (qua `core/queue`), Vitest 4 + Testcontainers, OpenTelemetry (`getNodeAutoInstrumentations` có sẵn trong `@opentelemetry/auto-instrumentations-node` 0.80.0).

**Spec:** `docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md` (r2; mục 6.3, 7, 8.1, 9, 10.1–10.4, 11.1, 15, 16 R7-1…R7-9 + R7-18, 18, 19 "Feature mẫu (7D)", 20 hàng 7D). Rulings: `.superpowers/autonomous/rulings.md` R-X3, R-X4, R-X5, R-X12, R-X14, R-X16, R-X20, R-X21, R-X24, R-X30. Plan cùng kiểu: `2026-10-05-sp4b-usage-quota-seats.md`, `2026-10-07-sp6c-integrations.md`.

**Nhánh:** `sp7d-sample-feature` cắt từ `main` (≥ 2ccd408). Phụ thuộc đã merge: 7A, 4A, 4B, 4C, 3D, 6.0, 6C.

## Global Constraints

- Vùng: mọi file mới của mẫu nằm ở vùng **template** của `.upstream/zones.json` (`src/features/example/`, `src/migrations/example/`, `test/{unit,integration,e2e}/features/example/`, cộng `test/smoke/features/example/` thêm ở Task 14). Sửa ở vùng boilerplate chỉ là các dòng liệt kê từng task; sau `upstream:init` (xoá vùng template) mọi test boilerplate vẫn xanh (UP-13).
- Định danh mang tiền tố feature (S7-D27): bảng `example_projects`, env `EXAMPLE_*`, event `example.project.*`, queue `example`, job `example.projects.purge-org`, cron `example.projects.purge-archived`, `jobIdPrefix` `example-purge`, mã lỗi `example_*`, resource `example_projects`, key tính năng `example.projects` (FLAG) và `example.project_count` (QUOTA kỳ NONE), participant `example.projects` order **200**, metric `example_projects_purged_total`, aggregate `example_project`.
- Hằng có tên (không số trần): `EXAMPLE_PROJECT_NAME_MAX_LENGTH = 100`, `EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH = 1000`, `EXAMPLE_PURGE_ORDER = 200`. Migration viết cứng 100/1000/`DEFINER_LIMIT_MAX` (1000) vì không import code; EX-I7/EX-I8 khoá hai phía.
- Config (mục 11.1, nguyên văn): `EXAMPLE_ARCHIVED_RETENTION_SEC` 2592000 (3600–31536000); `EXAMPLE_PURGE_CRON` `30 3 * * *` (`isValidCron`); `EXAMPLE_PURGE_TZ` `UTC` (`normalizeTimezone`); `EXAMPLE_PURGE_ORG_BATCH_SIZE` 100 (1–`DEFINER_LIMIT_MAX`); `EXAMPLE_PURGE_MAX_BATCHES` 10 (1–1000); `EXAMPLE_PURGE_ROWS_PER_JOB` 1000 (1–10000). Không trường nào secret (không `.meta({ secret })`, R-X20/7B).
- Bất biến ở DB: `CHECK`, unique index tên `(org_id, lower(name))`, FK `org_id → organizations ON DELETE RESTRICT`, RLS ENABLE + FORCE, policy `TO app_user`, `UPDATE` chỉ theo cột, hàm definer `SECURITY DEFINER SET search_path = ''` của `sweep_definer`.
- Quota (S7-D4, S7-D35): `Quotas.consumeOrThrow(ExampleFeatures.key('example.project_count'), 1)` **sau** `INSERT`, `Quotas.releaseAllocation(…, n)` **sau** `DELETE … RETURNING`, cùng transaction của caller. Feature nào tiêu nhiều quota trong một transaction thì gọi theo **thứ tự key tăng dần** (hợp đồng `Quotas` của 4B, I2) — mẫu chỉ có một quota, ghi luật ở README và chú thích tại chỗ gọi.
- Event (R-X3): năm `defineEvent` khai tường minh `audit: true, webhook: false`; payload chỉ id công khai (không tên, không mô tả).
- Test race: ép thứ tự bằng holder (`holdInOrg`/`waitForBlocked` của `test/support/entitlements-races.ts`) hoặc participant/handler barrier; mọi ca khẳng định "không deadlock" chạy với `DB_TX_RETRY_ATTEMPTS=0`.
- PII: không tên/mô tả project ở log (pino thật qua `startAppProcess`), span (instrumentation pg + http thật) và nhãn metric.
- Lỗi problem: trường lỗi nằm dưới `errors` (`errors[0] = { path, code, message }`).
- Migration: tạo bằng `pnpm exec mikro-orm migration:create --blank --path src/migrations/example --name example_projects`; timestamp > migration mới nhất vùng boilerplate+template trên `main` lúc merge (hôm nay `20261010032022`; 6A/6B merge trước thì tạo lại).
- `.env.example` sinh lại bằng `pnpm env:example`; `openapi.json` bằng `pnpm build && pnpm openapi:export`; oasdiff chỉ được báo thêm route (không breaking).
- Git: commit mới; không amend, rebase, force; không push.

## Review Focus

1. **Cursor do client sửa tay** (`?cursor=` không phải base64url chuẩn tắc, JSON hỏng, mảng hai phần tử, UUID sai, chuỗi rất dài): luôn `400 invalid_cursor` trước khi chạm SQL, không bao giờ `500` hay trang đầu im lặng. Test: Task 7 Step 1 `cursor tampering`.
2. **Tên khác hoa thường/khoảng trắng** (`"Website"`, `" website "`, `"WEBSITE"`): trim ở zod, trùng theo `lower(name)` → `409 example_project_name_taken` không lộ tên constraint; PATCH đổi sang tên của project khác cũng `409`. Test: Task 7 Step 1 `name collisions`.
3. **Org hạ gói hoặc bị override tắt cờ giữa chừng**: `GET`/`DELETE` vẫn chạy, `POST`/`PATCH`/archive/unarchive `403 feature_not_in_plan`; xoá khi đã vượt trần (OVER_LIMIT) trả quota đúng và không `QuotaReleaseUnderflowError`. Test: Task 8 Step 1 `over-limit org still deletes`.
4. **Replay `Idempotency-Key` của archive sau khi project đã bị xoá**: trả lại đúng response đã lưu (200), không chạy lại handler, không 500. Test: Task 7 Step 1 `archive replay after delete`.
5. **Job xoá chạy cho org mà mọi dòng đến hạn vừa được unarchive** (0 dòng): không `releaseAllocation(…, 0)` (RangeError của 4B), không event, metric không tăng. Test: Task 9 Step 1 `purge with nothing due`.

---

## Phán quyết của plan cho chỗ spec mơ hồ hoặc lệch code (ghi vào spec ở Task 15)

| # | Phán quyết | Lý do | Giá nếu sai |
|---|---|---|---|
| D7-1 | `GET …/projects` phân trang **cursor** (`cursorPageQuery`, `Paginator.cursor`), không offset như §9.1/EX-E2. Keyset một khoá duy nhất `public_id DESC` (UUIDv7 của `uuidv7()`, tăng theo ms); cursor = base64url của JSON `[publicId]`, codec ở `http/project-cursor.ts`. Bỏ index `example_projects_list_idx`: `example_projects_org_public_uq (org_id, public_id)` phục vụ quét ngược | Đề bài của controller đòi mẫu dạy cursor; khoá đơn duy nhất là keyset đơn giản nhất, không có timestamp trong cursor nên không có lớp lỗi 22008 (năm 0000) như cursor delivery của 6C | Đổi sang `offsetPageQuery` + thêm lại `list_idx`: một task |
| D7-2 | Key mã lỗi là `EXAMPLE_PROJECT_NAME_TAKEN`, `EXAMPLE_PROJECT_NOT_ACTIVE`, `EXAMPLE_PROJECT_NOT_ARCHIVED` (spec §9.4 viết `PROJECT_*`) | `defineErrorCodes` lấy `code = key.toLowerCase()` (`src/core/errors/error-codes.ts:24`): key `PROJECT_*` cho ra `project_*`, sai tiền tố | Đổi tên ba key |
| D7-3 | `projectId` sai định dạng → `404 not_found` (spec §9.1 ghi 422) | Quy ước thật của codebase: `publicIdOrNotFound` ở tenancy và integrations; mẫu dạy đúng quy ước đang chạy | Đổi một helper |
| D7-4 | Chuyển trạng thái và PATCH: `SELECT … FOR NO KEY UPDATE` → `assertIfMatch` → `transition()` → `UPDATE … WHERE id = ?` (mẫu `EndpointService`), thay CAS `UPDATE … WHERE status = ? AND version = ?` của §8.1 | Cùng đúng; khoá rồi kiểm là mẫu đang có ở 6C, cho lỗi `404/412/409` không cần đọc lại; thứ tự khoá vẫn "dòng → bộ đếm" | Viết lại ba câu UPDATE |
| D7-5 | EX-I13: down bị chặn bởi FK cho `23001` (spec ghi `23503`) | `org_role_permissions_permission_fk`, `usage_counters_feature_fk`… là `ON DELETE RESTRICT` → `restrict_violation` 23001 (bài học của brief) | Đổi mã trong test |
| D7-6 | Gói fixture `no_projects` (spec `no-projects`) | `PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/` | — |
| D7-7 | EX-I9/EX-I10 tất định bằng holder thay cho "×50 lặp"; EX-I11 giữ lượt hỗn hợp 20∥20∥job nhưng với `DB_TX_RETRY_ATTEMPTS=0` cộng một ca R7-18 tất định | Brief: race ép thứ tự bằng seam, không dựa vào may rủi ×N | — |
| D7-8 | `definerFunctions`/`definerReadTables` của file inventory feature nghĩa là **`sweep_definer`** (R-X4); gộp ở `test/support/core-catalog.ts` nên `rls-catalog.spec.ts` (tập definer chính xác) và `migration-scan.spec.ts` (`OWNED_FUNCTIONS`) cùng thấy | Feature không có role definer nào khác (R-X4 bỏ `tenancy_definer` cho feature) | Thêm trường `tenancyDefinerFunctions` nếu sau này cần |
| D7-9 | Smoke của mẫu ở `test/smoke/features/example/` (vùng template mới; `test/smoke/features/` vùng dự án) | Project `smoke` của Vitest chỉ nhận `test/smoke/**/*.smoke.spec.ts`; đặt ở `test/e2e/` thì project `integration` cũng chạy nó | Dời file + một dòng `zones.json` |
| D7-10 | Một quota duy nhất; luật "thứ tự key tăng dần" ghi ở README + chú thích, không bịa quota thứ hai | Spec §1, §A3: "1 quota"; quota giả sẽ bị chép vào mọi dự án | Thêm key `QUOTA` thứ hai + ca test |
| D7-11 | Test boilerplate đang giả định đúng tập catalogue (`entitlements.smoke.spec.ts` ba chỗ, `integration/entitlements/catalogue-check.spec.ts:174`) được viết lại cho đúng với cả cây có và không có vùng template | Dòng `entitlement_features`/`permissions` của mẫu có ở DB test và image; UP-13 | — |
| D7-12 | `down` kết thúc bằng khối khẳng định FORCE (spec §7.5 nói không cần) | `migration-scan.spec.ts` đòi khối này sau mọi `NO FORCE` | — |
| D7-13 | Mẫu không tự tạo span; test PII span bật `@opentelemetry/instrumentation-pg` + `-http` thật qua `getNodeAutoInstrumentations` (không thêm dependency) | Bài học undici: span auto mới là chỗ rò; spike S2 xác nhận | Fallback ở S2 |
| D7-14 | `PURGE` từ `ACTIVE` → `REJECTED` với `EXAMPLE_PROJECT_NOT_ARCHIVED` | Bảng 8.1 ghi "từ chối" mà không có mã; câu 7.4 không bao giờ chọn dòng ACTIVE nên đây là lỗi lập trình được ném to ở service | — |
| D7-15 | Một PR (không tách expand/contract) | Kiểm khoan dung R-X21 (3A, quyền) và R-X30 (4B, tính năng) đã deploy: pod cũ gặp dòng mới chỉ WARN; migrate luôn chạy trước rollout | — |

## Bản đồ file

**Tạo (vùng template):**
- `src/features/example/index.ts` — public API: `ExampleModule`, `ExampleEvents`, `ExamplePermissions`, `ExampleFeatures`, `exampleConfig`, `ExampleErrors`.
- `src/features/example/constants.ts` — hằng có tên (độ dài, aggregate, actor hệ thống, order purge).
- `src/features/example/example.config.ts` — `exampleConfig = defineConfig('example', …)`.
- `src/features/example/errors.ts` — `ExampleErrors` + `defineConstraintErrors`.
- `src/features/example/events.ts` — năm event + `ExampleEvents`.
- `src/features/example/permissions.ts` — `ExamplePermissions`.
- `src/features/example/entitlements.ts` — `ExampleFeatures`.
- `src/features/example/jobs.ts` — `ExampleQueue`, `PurgeOrgJob`, `PurgeArchivedSweep`.
- `src/features/example/domain/project.ts` — `ProjectStatus`, `ProjectCommand`, `transition`.
- `src/features/example/application/actor.ts` — `actorOf(ctx)`.
- `src/features/example/application/project.service.ts` — `ProjectService`.
- `src/features/example/application/example-metrics.ts` — `ExampleMetrics`.
- `src/features/example/application/purge-org.handler.ts` — `PurgeOrgHandler`.
- `src/features/example/application/purge-archived-sweep.handler.ts` — `PurgeArchivedSweepHandler`.
- `src/features/example/application/project-purge.participant.ts` — `ExampleProjectsPurgeParticipant`.
- `src/features/example/infra/sql-project.repository.ts` — `ProjectRepository` (SQL thô).
- `src/features/example/http/schemas.ts`, `http/project-cursor.ts`, `http/projects.controller.ts`.
- `src/features/example/example.module.ts` — `ExampleModule.forApi()/forWorker()`.
- `src/migrations/example/Migration<ts>_example_projects.ts`.
- `test/unit/features/example/*.spec.ts` (domain, schemas, cursor, catalogues, identifiers).
- `test/integration/features/example/example.inventory.ts`, `example-support.ts`, `*.spec.ts`.
- `test/e2e/features/example/*.e2e.spec.ts`.
- `test/smoke/features/example/example.smoke.spec.ts`.

**Sửa (vùng boilerplate/dự án, đúng các dòng nêu ở task):** `src/app.modules.ts` (3 dòng template), `.upstream/zones.json`, `docs/upstream/CODEOWNERS.template`, `.dependency-cruiser.cjs`, `test/unit/architecture/rules.spec.ts` + fixture, `test/support/feature-inventory.ts`, `test/support/core-catalog.ts`, `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/entitlements/catalogue-check.spec.ts`, `test/smoke/entitlements.smoke.spec.ts`, `test/smoke/smoke-app-env.ts`, `.env.example`, `openapi.json`, `docs/boilerplate/README.md`, `docs/adr/0012-two-pagination-modes.md`, `docs/adr/0013-build-toolchain.md`, spec SP7 (mục 26b).

---

## Phần A — Spike

### Task 1: Spike S1–S3 (T7-5 + EXPLAIN bốn câu; instrumentation pg/http trong Vitest; keyset `public_id DESC` dưới RLS)

Mọi giả định chưa chạy được kiểm trước khi viết code. File spike **không commit**; kết quả (output EXPLAIN rút gọn, thời gian, quyết định) ghi vào mục "Kết quả spike" cuối plan này và commit cùng plan.

**Files:**
- Create (tạm, không commit): `test/integration/features/example/spike-7d.spec.ts`, `src/migrations/example/Migration<ts>_example_projects.ts` (bản nháp đúng DDL mục 7.1 + D7-1, chỉ phần bảng/index/RLS/policy/grant/hàm definer; Task 4 viết bản thật)
- Modify: `docs/superpowers/plans/2026-10-21-sp7d-sample-feature.md` (mục "Kết quả spike")

**Interfaces:**
- Consumes: `createScratchDb` (`test/support/scratch-db.ts`), `runMigrations` + `coreMigrationList()` (`test/support/migrate-test-db.ts`), `installOtelCapture` (`test/support/otel-capture.ts`), `getNodeAutoInstrumentations` (`@opentelemetry/auto-instrumentations-node`).
- Produces: quyết định S1 (giữ câu definer hay đổi sang recursive CTE), S2 (cách test PII span ở Task 12), S3 (index cho list).

- [ ] **Step 1: S1 — seed 10.000 org × 50 project (20% `ARCHIVED`, nửa số đó quá retention) trên scratch DB**

Trong `spike-7d.spec.ts`: `createScratchDb('spike7d')`, chạy migration tới bản nháp. Seed bằng client `owner` sau `SET session_replication_role = replica` (bỏ qua FK/trigger bootstrap của `organizations`; chỉ đo kế hoạch truy vấn):
```sql
INSERT INTO organizations (id, name, created_by_user_id)
SELECT uuidv7(), 'o' || g, (SELECT id FROM tenancy_users LIMIT 1) FROM generate_series(1, 10000) g;
INSERT INTO example_projects (org_id, name, status, status_changed_at)
SELECT o.id, 'p' || g, CASE WHEN g % 5 = 0 THEN 'ARCHIVED' ELSE 'ACTIVE' END,
       now() - CASE WHEN g % 10 = 0 THEN interval '40 days' ELSE interval '1 day' END
FROM organizations o CROSS JOIN generate_series(1, 50) g;
ANALYZE example_projects;
```
(Nếu `tenancy_users` rỗng ở scratch DB: chèn một dòng trước bằng cùng phiên.)

- [ ] **Step 2: S1 — EXPLAIN (ANALYZE, BUFFERS) bốn câu, mỗi câu dưới role thật**

1. Definer (role `sweep_definer`, `SET ROLE sweep_definer`): thân hàm mục 7.3 với `p_after = '00000000-0000-0000-0000-000000000000'`, `p_limit = 100`, `p_retention_sec = 2592000`. Đạt: < 20 ms và dùng `example_projects_purge_idx` (Index Only Scan hoặc Skip Scan). Không đạt: viết lại `RETURN QUERY WITH RECURSIVE` "loose index scan" (`SELECT min(org_id) … WHERE org_id > cursor AND status='ARCHIVED' AND status_changed_at <= …` từng bước) rồi đo lại; ghi bản thắng vào Task 4.
2. Job xoá (role `app_user`, `set_config('app.org_id', <org có dòng đến hạn>, true)`, trong `BEGIN … ROLLBACK`): câu CTE mục 7.4 với `LIMIT 1000`. Đạt: Index Scan trên `example_projects_purge_idx`.
3. List (role `app_user` trong OrgScope): `SELECT … FROM example_projects WHERE org_id = $1 AND public_id < $2::uuid ORDER BY public_id DESC LIMIT 51`, và cùng câu thêm `AND status = 'ARCHIVED'`. Đạt: Index Scan Backward trên `example_projects_org_public_uq` (S3).
4. Tra một dòng: `SELECT … WHERE org_id = $1 AND public_id = $2 FOR NO KEY UPDATE`. Đạt: Index Scan `example_projects_org_public_uq`.

Câu 3 có `?status=` mà không đạt (Seq Scan hoặc > 5 ms trên org 50 dòng): ghi lại, thêm index `example_projects_status_list_idx (org_id, status, public_id DESC)` vào Task 4 kèm query của nó.

- [ ] **Step 3: S2 — instrumentation pg + http sinh span trong Vitest**

Trong cùng file, ca thứ hai: `installOtelCapture()`, rồi `getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false }, … mọi instrumentation khác enabled: false trừ '-pg' và '-http' })` **trước** khi dựng app; dựng `startTenancyApp()`, gọi `GET /v1/orgs` bằng bearer. Đạt: `otel.spanNames()` có ít nhất một span tên bắt đầu `pg.` và một span HTTP server. Không đạt (ESM của Vitest không cho hook `pg`): Task 12 kiểm span ở process thật — `startAppProcess('test/support/api-entry.ts', { …, OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: <receiver OTLP/HTTP giả của test> })` và đọc body protobuf/JSON nhận được; ghi lựa chọn vào "Kết quả spike".

- [ ] **Step 4: Ghi kết quả, xoá file spike**

Run: `pnpm vitest run --project integration test/integration/features/example/spike-7d.spec.ts`
Ghi vào mục "Kết quả spike": kế hoạch rút gọn (node chính, index, `Execution Time`, `Buffers: shared hit/read`) cho bốn câu; S2 đạt/không; S3 có thêm index hay không. Rồi:
```bash
rm test/integration/features/example/spike-7d.spec.ts src/migrations/example/Migration*_example_projects.ts
git add docs/superpowers/plans/2026-10-21-sp7d-sample-feature.md
git commit -m "docs(plan): 7D spike results (T7-5 EXPLAIN, OTel pg/http in Vitest, keyset plan)"
```

---

## Phần B — Lõi thuần và catalogue

### Task 2: Domain `Project`, hằng, schema HTTP và codec cursor (EX-U1, EX-U2, EX-U10)

**Files:**
- Create: `src/features/example/constants.ts`, `src/features/example/domain/project.ts`, `src/features/example/errors.ts`, `src/features/example/http/schemas.ts`, `src/features/example/http/project-cursor.ts`
- Test: `test/unit/features/example/project-domain.spec.ts`, `test/unit/features/example/schemas.spec.ts`

**Interfaces:**
- Consumes: `defineErrorCodes`, `AppError`, `CoreErrors`, `type ErrorCode` (`src/core/errors/index.ts`); `defineConstraintErrors` (`src/core/database/index.ts`); `cursorPageQuery`, `cursorPageSchema`, `mergePatchSchema` (`src/core/http/index.ts`); `type EventActor` (`src/core/events/index.ts`).
- Produces:
  - `constants.ts`: `EXAMPLE_PROJECT_NAME_MAX_LENGTH = 100`, `EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH = 1000`, `EXAMPLE_PROJECT_AGGREGATE = 'example_project'`, `EXAMPLE_PURGE_ORDER = 200`, `EXAMPLE_PURGE_ACTOR: EventActor = { type: 'system', id: 'example.projects.purge' }`.
  - `domain/project.ts`: `PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const`; `type ProjectStatus`; `type ProjectCommand = 'ARCHIVE' | 'UNARCHIVE' | 'UPDATE' | 'REMOVE' | 'PURGE'`; `type Transition = { kind: 'OK'; next: ProjectStatus | 'DELETED' } | { kind: 'REJECTED'; code: ErrorCode }`; `transition(status: ProjectStatus, command: ProjectCommand): Transition`.
  - `errors.ts`: `ExampleErrors = defineErrorCodes({ EXAMPLE_PROJECT_NAME_TAKEN: 409, EXAMPLE_PROJECT_NOT_ACTIVE: 409, EXAMPLE_PROJECT_NOT_ARCHIVED: 409 })` (title tiếng Anh: `'A project with this name already exists'`, `'The project is not active'`, `'The project is not archived'`) và `defineConstraintErrors({ example_projects_name_uq: ExampleErrors.EXAMPLE_PROJECT_NAME_TAKEN })`.
  - `http/schemas.ts`: `ProjectName`, `ProjectDescription`, `CreateProjectBody`, `PatchProjectBody`, `ProjectListQuery`, `ProjectResponse`, `ProjectPage`, `projectIdOrNotFound(raw: string): string`, `projectOf(row: ProjectRow): z.input<typeof ProjectResponse>` (thêm ở Task 5 khi có `ProjectRow`).
  - `http/project-cursor.ts`: `encodeProjectCursor(publicId: string): string`, `decodeProjectCursor(raw: string): string`.

- [ ] **Step 1: Viết test thất bại**

`test/unit/features/example/project-domain.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  PROJECT_STATUSES,
  transition,
  type ProjectCommand,
} from '../../../../src/features/example/domain/project.js';
import { ExampleErrors } from '../../../../src/features/example/errors.js';
import { defineConstraintErrors } from '../../../../src/core/database/index.js';

const COMMANDS: readonly ProjectCommand[] = ['ARCHIVE', 'UNARCHIVE', 'UPDATE', 'REMOVE', 'PURGE'];
const ok = (next: string) => ({ kind: 'OK', next });
const no = (code: unknown) => ({ kind: 'REJECTED', code });

describe('Project state machine (spec SP7 §8.1, EX-U1)', () => {
  const table = {
    ACTIVE: {
      ARCHIVE: ok('ARCHIVED'),
      UNARCHIVE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ARCHIVED),
      UPDATE: ok('ACTIVE'),
      REMOVE: ok('DELETED'),
      PURGE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ARCHIVED),
    },
    ARCHIVED: {
      ARCHIVE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ACTIVE),
      UNARCHIVE: ok('ACTIVE'),
      UPDATE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ACTIVE),
      REMOVE: ok('DELETED'),
      PURGE: ok('DELETED'),
    },
  } as const;
  it.each(PROJECT_STATUSES.flatMap((s) => COMMANDS.map((c) => [s, c] as const)))(
    '%s × %s follows table 8.1',
    (status, command) => {
      expect(transition(status, command)).toEqual(table[status][command]);
    },
  );
  it('an unknown status from a cast fails loud (never-check at runtime)', () => {
    expect(() => transition('DELETED' as never, 'ARCHIVE')).toThrow(/unknown project status/);
  });
  it('the 23505 mapping of example_projects_name_uq is registered (a second registration throws)', () => {
    expect(() =>
      defineConstraintErrors({ example_projects_name_uq: ExampleErrors.EXAMPLE_PROJECT_NAME_TAKEN }),
    ).toThrow('Constraint "example_projects_name_uq" already mapped');
  });
  it('error codes carry the feature prefix (D7-2)', () => {
    expect(Object.values(ExampleErrors).map((e) => [e.code, e.status])).toEqual([
      ['example_project_name_taken', 409],
      ['example_project_not_active', 409],
      ['example_project_not_archived', 409],
    ]);
  });
});
```

`test/unit/features/example/schemas.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH as DMAX,
  EXAMPLE_PROJECT_NAME_MAX_LENGTH as NMAX,
} from '../../../../src/features/example/constants.js';
import {
  decodeProjectCursor,
  encodeProjectCursor,
} from '../../../../src/features/example/http/project-cursor.js';
import {
  CreateProjectBody,
  PatchProjectBody,
  ProjectListQuery,
  projectIdOrNotFound,
} from '../../../../src/features/example/http/schemas.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';

describe('project schemas (spec §9.3, EX-U2)', () => {
  it('name: trimmed, 1..100', () => {
    expect(CreateProjectBody.parse({ name: '  Web  ' })).toEqual({ name: 'Web', description: null });
    expect(CreateProjectBody.safeParse({ name: '   ' }).success).toBe(false);
    expect(CreateProjectBody.safeParse({ name: 'x'.repeat(NMAX) }).success).toBe(true);
    expect(CreateProjectBody.safeParse({ name: 'x'.repeat(NMAX + 1) }).success).toBe(false);
  });
  it('description: "" and whitespace become null; 1000 passes, 1001 fails', () => {
    expect(CreateProjectBody.parse({ name: 'a', description: '' }).description).toBeNull();
    expect(CreateProjectBody.parse({ name: 'a', description: '  ' }).description).toBeNull();
    expect(CreateProjectBody.parse({ name: 'a', description: null }).description).toBeNull();
    expect(CreateProjectBody.safeParse({ name: 'a', description: 'd'.repeat(DMAX) }).success).toBe(true);
    expect(CreateProjectBody.safeParse({ name: 'a', description: 'd'.repeat(DMAX + 1) }).success).toBe(false);
  });
  it('unknown fields are refused, status is never patchable', () => {
    expect(CreateProjectBody.safeParse({ name: 'a', status: 'ARCHIVED' }).success).toBe(false);
    expect(PatchProjectBody.safeParse({ status: 'ARCHIVED' }).success).toBe(false);
    expect(PatchProjectBody.parse({ description: '' })).toEqual({ description: null });
  });
  it('list query: limit capped by PAGINATION_MAX_PAGE_SIZE, status enum', () => {
    applyTestEnv();
    expect(ProjectListQuery.safeParse({ status: 'DELETED' }).success).toBe(false);
    expect(ProjectListQuery.parse({ status: 'ARCHIVED' }).status).toBe('ARCHIVED');
  });
  it('projectIdOrNotFound: malformed → 404 (D7-3), upper case normalised', () => {
    expect(() => projectIdOrNotFound('nope')).toThrow(AppError);
    expect(projectIdOrNotFound('019DD1A5-0000-7000-8000-000000000001')).toBe('019dd1a5-0000-7000-8000-000000000001');
  });
});

describe('project cursor (D7-1, EX-U10, Review Focus 1)', () => {
  const id = '019dd1a5-0000-7000-8000-000000000001';
  it('round-trips', () => {
    expect(decodeProjectCursor(encodeProjectCursor(id))).toBe(id);
  });
  it.each([
    ['not base64url', '***'],
    ['non-canonical base64url', `${encodeProjectCursor(id)}=`],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['two elements', Buffer.from(JSON.stringify([id, id])).toString('base64url')],
    ['an object leaf', Buffer.from(JSON.stringify([{ $ne: null }])).toString('base64url')],
    ['not a uuid', Buffer.from(JSON.stringify(['x'])).toString('base64url')],
    ['very long', 'A'.repeat(10_000)],
  ])('%s → 400 invalid_cursor', (_label, raw) => {
    try {
      decodeProjectCursor(raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).error.code).toBe('invalid_cursor');
    }
  });
});
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/features/example`
Expected: FAIL (module `src/features/example/...` chưa có).

- [ ] **Step 3: Viết code**

- `transition`: `switch (status)` lồng `switch (command)`, mỗi `default` gán `const unknown: never = …` rồi `throw new Error(\`unknown project status ${String(unknown)}\`)` / `unknown project command`.
- `ProjectName = z.string().trim().min(1).max(EXAMPLE_PROJECT_NAME_MAX_LENGTH)`; `ProjectDescription = z.string().trim().max(EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH).transform((s) => (s === '' ? null : s)).nullable()`; `CreateProjectBody = z.object({ name: ProjectName, description: ProjectDescription.optional().default(null) }).strict()`; `PatchProjectBody = mergePatchSchema(z.object({ name: ProjectName, description: ProjectDescription }))` (cùng cách `PatchEndpointBody` của 6C: strict, trường vắng = không đổi); `ProjectListQuery = cursorPageQuery().extend({ status: z.enum(PROJECT_STATUSES).optional() }).strict()`; `ProjectResponse = z.object({ id: z.uuid(), name: z.string(), description: z.string().nullable(), status: z.enum(PROJECT_STATUSES), statusChangedAt: z.iso.datetime(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })`; `ProjectPage = cursorPageSchema(ProjectResponse)`.
- `projectIdOrNotFound`: `z.uuid().safeParse(raw)`; hỏng → `new AppError(CoreErrors.NOT_FOUND, { expected: true })`; trả `toLowerCase()`.
- Codec: mẫu `src/modules/integrations/http/delivery-cursor.ts` (kiểm `Buffer.from(raw,'base64url').toString('base64url') === raw`, `JSON.parse` trong try, `z.tuple([z.uuid()])`), lỗi → `AppError(CoreErrors.INVALID_CURSOR, { detail: 'The cursor is malformed or no longer valid', expected: true })`. Không có trường thời gian nên không cần guard năm ≥ 1 (ghi một dòng chú thích).

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `pnpm vitest run --project unit test/unit/features/example`
Expected: PASS (EX-U1 10 ca + never-check, EX-U2, EX-U10).

- [ ] **Step 5: Commit**
```bash
git add src/features/example test/unit/features/example
git commit -m "feat(example): Project state machine, HTTP schemas and opaque public_id cursor"
```

### Task 3: Config, event, catalogue quyền, catalogue tính năng, queue/job/sweep (EX-U3, EX-U4)

**Files:**
- Create: `src/features/example/example.config.ts`, `events.ts`, `permissions.ts`, `entitlements.ts`, `jobs.ts`
- Test: `test/unit/features/example/catalogues.spec.ts`

**Interfaces:**
- Consumes: `defineConfig`, `type ConfigOf` (`src/core/config/index.ts`); `isValidCron`, `normalizeTimezone` (`src/core/scheduler/index.ts`); `DEFINER_LIMIT_MAX`, `defineOrgSweep` (`src/core/sweep/index.ts`); `defineQueue`, `defineJob` (`src/core/queue/index.ts`); `defineEvent` (`src/core/events/index.ts`); `definePermissionCatalogue` (`src/modules/tenancy/index.ts`); `defineFeatureCatalogue`, `UNLIMITED` (`src/modules/entitlements/index.ts`).
- Produces:
  - `exampleConfig` (namespace `example`): thuộc tính `archivedRetentionSec`, `purgeCron`, `purgeTz`, `purgeOrgBatchSize`, `purgeMaxBatches`, `purgeRowsPerJob` ↔ env của Global Constraints; `type ExampleConfig = ConfigOf<typeof exampleConfig>`.
  - `ProjectCreatedEvent`, `ProjectUpdatedEvent`, `ProjectArchivedEvent`, `ProjectUnarchivedEvent`, `ProjectDeletedEvent` (type `example.project.<verb>`, version 1); `ExampleEvents = { ProjectCreatedEvent, … } as const`. Schema: `{ projectId: z.uuid() }`; updated thêm `changed: z.array(z.enum(['name', 'description'])).min(1)`; deleted thêm `reason: z.enum(['REMOVED', 'RETENTION'])`; mọi schema `.strict()`.
  - `ExamplePermissions = definePermissionCatalogue('example', { 'example_projects.read', 'example_projects.write', 'example_projects.delete' })` đúng bảng 7.2 (read: apiKey ✓ support ✓ admin ✓ member ✓; write: requires read, apiKey ✓, admin ✓ member ✓; delete: requires read, admin ✓).
  - `ExampleFeatures = defineFeatureCatalogue({ 'example.projects': { kind: 'FLAG', fallback: true, description: 'Projects (sample feature)' }, 'example.project_count': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: UNLIMITED, description: 'Number of projects' } })`.
  - `ExampleQueue = defineQueue('example', { kind: 'io' })`; `PurgeOrgJob = defineJob({ name: 'example.projects.purge-org', queue: ExampleQueue, version: 1, schema: z.object({}).strict() })` (`onInactiveOrg` mặc định `'skip'`); `PurgeArchivedSweep = defineOrgSweep({ key: 'example.projects.purge-archived', definerFunction: 'example_orgs_with_purgeable_projects', extraParams: () => ({ p_retention_sec: exampleConfig().archivedRetentionSec }), orgJob: PurgeOrgJob, jobIdPrefix: 'example-purge', schedule: () => ({ cron: exampleConfig().purgeCron, tz: exampleConfig().purgeTz }), batch: () => ({ size: exampleConfig().purgeOrgBatchSize, maxBatches: exampleConfig().purgeMaxBatches }) })`.

- [ ] **Step 1: Viết test thất bại**

`test/unit/features/example/catalogues.spec.ts`:
```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { eventRegistry } from '../../../../src/core/events/index.js';
import { findJob, queueRegistry } from '../../../../src/core/queue/index.js';
import { cronRegistry } from '../../../../src/core/scheduler/index.js';
import { DEFINER_LIMIT_MAX, findOrgSweep } from '../../../../src/core/sweep/index.js';
import { UNLIMITED } from '../../../../src/modules/entitlements/index.js';
import { ExampleFeatures } from '../../../../src/features/example/entitlements.js';
import { ExampleEvents } from '../../../../src/features/example/events.js';
import { exampleConfig } from '../../../../src/features/example/example.config.js';
import { PurgeArchivedSweep, PurgeOrgJob } from '../../../../src/features/example/jobs.js';
import { ExamplePermissions } from '../../../../src/features/example/permissions.js';
import { applyTestEnv } from '../../../support/app-factory.js';

describe('example catalogues (EX-U3, EX-U4)', () => {
  it('EX-U3: permissions match table 7.2 flag by flag', () => {
    expect(
      Object.entries(ExamplePermissions.entries).map(([key, e]) => [key, e.requires, e.ownerOnly, e.apiKeyEligible, e.supportEligible, e.grantTo]),
    ).toEqual([
      ['example_projects.read', [], false, true, true, { admin: true, member: true }],
      ['example_projects.write', ['example_projects.read'], false, true, false, { admin: true, member: true }],
      ['example_projects.delete', ['example_projects.read'], false, false, false, { admin: true, member: false }],
    ]);
  });
  it('EX-U4: two features, one kind each, wide fallbacks', () => {
    expect(ExampleFeatures.features['example.projects']).toMatchObject({ kind: 'FLAG', fallback: true });
    expect(ExampleFeatures.features['example.project_count']).toMatchObject({
      kind: 'QUOTA', resetPeriod: 'NONE', fallback: UNLIMITED,
    });
    expect(() => ExampleFeatures.requireEnabled('example.project_count' as never)).toThrow(/FLAG/);
    // @ts-expect-error requireEnabled accepts FLAG keys only (EX-U4 compile-time half)
    expectTypeOf(ExampleFeatures.requireEnabled).toBeCallableWith('example.project_count');
  });
  it('EX-U4: the five events declare audit: true, webhook: false (R-X3) and carry ids only', () => {
    const defs = eventRegistry().filter((d) => d.type.startsWith('example.'));
    expect(defs.map((d) => [d.type, d.version, d.audit, d.webhook]).sort()).toEqual(
      [
        ['example.project.archived', 1, true, false],
        ['example.project.created', 1, true, false],
        ['example.project.deleted', 1, true, false],
        ['example.project.unarchived', 1, true, false],
        ['example.project.updated', 1, true, false],
      ],
    );
    expect(ExampleEvents.ProjectCreatedEvent.schema.safeParse({ projectId: crypto.randomUUID(), name: 'x' }).success).toBe(false);
  });
  it('queue, per-org job and sweep follow the cron convention S7-D34', () => {
    expect(queueRegistry().map((q) => q.name)).toContain('example');
    expect(PurgeOrgJob.queue.name).toBe('example');
    expect(findOrgSweep('example.projects.purge-archived')).toBe(PurgeArchivedSweep);
    expect(findJob('example.projects.purge-archived')?.queue.name).toBe('maintenance');
    expect(cronRegistry().map((c) => c.key)).toContain('example.projects.purge-archived');
  });
  it('config defaults and bounds (spec §11.1)', () => {
    applyTestEnv();
    expect(exampleConfig()).toEqual({
      archivedRetentionSec: 2_592_000, purgeCron: '30 3 * * *', purgeTz: 'UTC',
      purgeOrgBatchSize: 100, purgeMaxBatches: 10, purgeRowsPerJob: 1000,
    });
    const s = exampleConfig.schema;
    const bad = [
      { archivedRetentionSec: 3599 }, { archivedRetentionSec: 31_536_001 }, { purgeCron: 'nope' },
      { purgeTz: 'Mars/Base' }, { purgeOrgBatchSize: DEFINER_LIMIT_MAX + 1 }, { purgeMaxBatches: 0 },
      { purgeRowsPerJob: 10_001 },
    ];
    for (const b of bad) expect(s.safeParse({ ...exampleConfig(), ...b }).success, JSON.stringify(b)).toBe(false);
    expect(PurgeArchivedSweep.extraParams()).toEqual({ p_retention_sec: 2_592_000 });
  });
});
```
(`PermissionCatalogue.entries` là `Readonly<Record<K, CatalogueEntryDef>>` theo key, `src/modules/tenancy/domain/catalogue.ts:39`; thứ tự `Object.entries` = thứ tự khai báo.)

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/features/example/catalogues.spec.ts`
Expected: FAIL (chưa có module).

- [ ] **Step 3: Viết code**

`example.config.ts` theo mẫu `src/modules/integrations/integrations.config.ts` (`z.coerce.number().int().min(..).max(..).default(..)`, `cron`/`timezone` refine), hằng có tên `RETENTION_MIN_SEC = 3600`, `RETENTION_MAX_SEC = 31_536_000`, `MAX_BATCHES_MAX = 1000`, `ROWS_PER_JOB_MAX = 10_000`; mỗi trường `.describe()` tiếng Anh. `jobs.ts` đặt chú thích tại `PurgeArchivedSweep`: "tham số thêm truyền THEO TÊN (R-X14); đổi tên `p_retention_sec` phải đổi cả hàm SQL — EX-I15 bắt lệch".

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `pnpm vitest run --project unit test/unit/features/example`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/features/example test/unit/features/example
git commit -m "feat(example): config, five audited events, permission and feature catalogues, queue and org sweep"
```

---

## Phần C — Schema

### Task 4: Migration `example_projects` + RLS + catalogue + hàm definer, có down canh (EX-I1, EX-I2, EX-I3, EX-I7, EX-I8, EX-I13)

**Files:**
- Create: `src/migrations/example/Migration<ts>_example_projects.ts` (bằng `pnpm exec mikro-orm migration:create --blank --path src/migrations/example --name example_projects`)
- Modify: `test/integration/entitlements/catalogue-check.spec.ts:162-176` (D7-11)
- Test: `test/integration/features/example/schema.spec.ts`, `test/integration/features/example/migration-down.spec.ts`

**Interfaces:**
- Consumes: `withAppClient`, `inOrgTx`, `seedOrg`, `seedCustomRole` (`test/support/tenancy-seed.ts`); `withOwner`, `seedCounter` (`test/support/entitlements-seed.ts`); `createScratchDb`; `coreMigrationList`; `runMigrations`; `DEFINER_LIMIT_MAX`.
- Produces: bảng `example_projects` (DDL mục 7.1 trừ `example_projects_list_idx`, D7-1; cộng index của S3 nếu spike đòi); policy `example_projects_tenant`, `example_projects_definer_read`; grant cột; ba dòng `permissions` + hai `permission_requires`; hai dòng `entitlement_features`; hàm `public.example_orgs_with_purgeable_projects(p_after uuid, p_limit integer, p_retention_sec integer) RETURNS TABLE (org_id uuid)` của `sweep_definer`.

- [ ] **Step 1: Viết test thất bại**

`test/integration/features/example/schema.spec.ts`:
```ts
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFINER_LIMIT_MAX } from '../../../../src/core/sweep/index.js';
import {
  EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH as DMAX,
  EXAMPLE_PROJECT_NAME_MAX_LENGTH as NMAX,
} from '../../../../src/features/example/constants.js';
import { withOwner } from '../../../support/entitlements-seed.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../../support/tenancy-seed.js';

const insertIn = (orgId: string, name: string, extra = '') =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(`INSERT INTO example_projects (org_id, name${extra ? ', status, status_changed_at' : ''})
               VALUES (app_current_org(), $1${extra}) RETURNING public_id::text`, [name]),
    ),
  );
describe('example_projects schema, RLS and definer (spec §7, EX-I1..I3, I7, I8)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
  });
  afterAll(async () => {
    for (const o of [a, b])
      if (o) await withAppClient((c) => inOrgTx(c, o.orgId, () => c.query('DELETE FROM example_projects')));
    await a?.dispose();
    await b?.dispose();
  });

  it('EX-I1: app_user in OrgScope(A) sees, updates and deletes no row of org B', async () => {
    await insertIn(b.orgId, 'b-only');
    const r = await withAppClient((c) =>
      inOrgTx(c, a.orgId, async () => [
        (await c.query('SELECT 1 FROM example_projects')).rowCount,
        (await c.query(`UPDATE example_projects SET name = 'x'`)).rowCount,
        (await c.query('DELETE FROM example_projects')).rowCount,
      ]),
    );
    expect(r).toEqual([0, 0, 0]);
    // FORCE RLS: owner sees 0 rows, so the row of B is read back through app_user in OrgScope(B).
    const own = await withAppClient((c) => inOrgTx(c, b.orgId, () => c.query('SELECT 1 FROM example_projects')));
    expect(own.rowCount).toBe(1);
  });
  it('EX-I2: INSERT with org_id = B from OrgScope(A) → 42501', async () => {
    await expect(
      withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(`INSERT INTO example_projects (org_id, name) VALUES ($1, 'x')`, [b.orgId]),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('EX-I3: no org context → P0001', async () => {
    await expect(withAppClient((c) => c.query('SELECT 1 FROM example_projects'))).rejects.toMatchObject({ code: 'P0001' });
  });
  it('CHECKs, unique lower(name), immutable identity columns', async () => {
    await insertIn(a.orgId, 'Website');
    await expect(insertIn(a.orgId, 'WEBSITE')).rejects.toMatchObject({ code: '23505', constraint: 'example_projects_name_uq' });
    for (const [name, constraint] of [[' x', 'example_projects_name_ck'], ['', 'example_projects_name_ck']] as const)
      await expect(insertIn(a.orgId, name)).rejects.toMatchObject({ code: '23514', constraint });
    await expect(
      withAppClient((c) => inOrgTx(c, a.orgId, () => c.query(`UPDATE example_projects SET org_id = $1`, [b.orgId]))),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withAppClient((c) => inOrgTx(c, a.orgId, () => c.query(`UPDATE example_projects SET created_at = now()`))),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('EX-I7: CHECK definitions carry the code constants', async () => {
    const defs = await withOwner(async (c) =>
      Object.fromEntries(
        (await c.query<{ conname: string; def: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conname IN ('example_projects_name_ck', 'example_projects_description_ck')`,
        )).rows.map((r) => [r.conname, r.def]),
      ),
    );
    expect(defs.example_projects_name_ck).toContain(`BETWEEN 1 AND ${NMAX}`);
    expect(defs.example_projects_description_ck).toContain(`BETWEEN 1 AND ${DMAX}`);
  });
  describe('EX-I8: example_orgs_with_purgeable_projects', () => {
    const call = (c: pg.Client, after: string | null, limit: number | null, retention: number | null) =>
      c.query<{ org_id: string }>(
        'SELECT org_id::text FROM public.example_orgs_with_purgeable_projects(p_after => $1::uuid, p_limit => $2::integer, p_retention_sec => $3::integer)',
        [after, limit, retention],
      );
    it('returns only orgs with due ARCHIVED rows, ascending; called like the SP6 runner it never raises (X2-2)', async () => {
      await insertIn(a.orgId, `due-${v7()}`, `, 'ARCHIVED', now() - interval '31 days'`);
      await insertIn(b.orgId, `fresh-${v7()}`, `, 'ARCHIVED', now() - interval '1 day'`);
      const rows = await withAppClient((c) => call(c, '00000000-0000-0000-0000-000000000000', DEFINER_LIMIT_MAX, 2_592_000));
      expect(rows.rows.map((r) => r.org_id)).toContain(a.orgId);
      expect(rows.rows.map((r) => r.org_id)).not.toContain(b.orgId);
      const ids = rows.rows.map((r) => r.org_id);
      expect([...ids].sort()).toEqual(ids);
    });
    it.each([
      [null, 10, 3600], ['00000000-0000-0000-0000-000000000000', null, 3600],
      ['00000000-0000-0000-0000-000000000000', 10, null], ['00000000-0000-0000-0000-000000000000', 0, 3600],
      ['00000000-0000-0000-0000-000000000000', DEFINER_LIMIT_MAX + 1, 3600], ['00000000-0000-0000-0000-000000000000', 10, 0],
    ])('out-of-range (%s, %s, %s) → 22023', async (after, limit, retention) => {
      await expect(withAppClient((c) => call(c, after, limit, retention))).rejects.toMatchObject({ code: '22023' });
    });
    it('owned by sweep_definer, SECURITY DEFINER, search_path="", EXECUTE for app_user only; app_owner cannot DROP it', async () => {
      const row = await withOwner(async (c) =>
        (await c.query(
          `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig,
                  has_function_privilege('public', oid, 'EXECUTE') AS pub, has_function_privilege('app_user', oid, 'EXECUTE') AS app
           FROM pg_proc WHERE proname = 'example_orgs_with_purgeable_projects'`,
        )).rows,
      );
      expect(row).toEqual([{ owner: 'sweep_definer', prosecdef: true, proconfig: ['search_path=""'], pub: false, app: true }]);
      await expect(
        withOwner((c) => c.query('DROP FUNCTION public.example_orgs_with_purgeable_projects(uuid, integer, integer)')),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
  it('catalogue rows: three permissions with flags of table 7.2, two requires, two entitlement features', async () => {
    const rows = await withOwner(async (c) => ({
      perms: (await c.query(
        `SELECT key, owner_only, api_key_eligible, support_eligible FROM permissions WHERE resource = 'example_projects' ORDER BY key`,
      )).rows,
      requires: (await c.query(
        `SELECT p.key || '>' || r.key AS k FROM permission_requires x JOIN permissions p ON p.id = x.permission_id
         JOIN permissions r ON r.id = x.required_permission_id WHERE p.resource = 'example_projects' ORDER BY 1`,
      )).rows.map((r) => r.k),
      features: (await c.query(
        `SELECT key, kind, reset_period FROM entitlement_features WHERE key LIKE 'example.%' ORDER BY key`,
      )).rows,
    }));
    expect(rows).toEqual({
      perms: [
        { key: 'example_projects.delete', owner_only: false, api_key_eligible: false, support_eligible: false },
        { key: 'example_projects.read', owner_only: false, api_key_eligible: true, support_eligible: true },
        { key: 'example_projects.write', owner_only: false, api_key_eligible: true, support_eligible: false },
      ],
      requires: ['example_projects.delete>example_projects.read', 'example_projects.write>example_projects.read'],
      features: [
        { key: 'example.project_count', kind: 'QUOTA', reset_period: 'NONE' },
        { key: 'example.projects', kind: 'FLAG', reset_period: null },
      ],
    });
  });
});
```
(`proconfig` so đúng dạng mà `rls-catalog.spec.ts:614` đang đọc cho hàm definer của 6C.)

`test/integration/features/example/migration-down.spec.ts` (EX-I13, mẫu `test/integration/entitlements/usage-counters-down.spec.ts`: scratch DB, danh sách migration **cắt tới** `…_example_projects` để down chỉ lùi đúng migration này):
```ts
describe('example_projects migration down (spec §7.5, EX-I13)', () => {
  // beforeAll: db = createScratchDb('exdown'); list = coreMigrationList() cắt tới tên chứa '_example_projects';
  //            runMigrations('up', { source: { kind: 'list', list }, … database của db })
  it('up → down → up on an empty table; the sweep of S2-R57 leaves nothing behind', async () => {
    // down 1 bước rồi up: to_regclass('public.example_projects') null sau down, khác null sau up; không còn hàm,
    // không còn dòng permissions/entitlement_features 'example%'
  });
  it('down with a project row → RAISE "example_projects is not empty", DB unchanged (FORCE still on)', async () => {});
  it('down while a custom role holds example_projects.read → 23001 (FK RESTRICT, D7-5), DB unchanged', async () => {});
  it('down after a usage_counters row exists for example.project_count → 23001, DB unchanged', async () => {});
});
```
Mỗi ca khẳng định "DB unchanged" bằng một ảnh chụp `catalogState()` (như 4B: `to_regclass`, `relforcerowsecurity`, đếm dòng catalogue `example%`, owner của hàm) chụp trước và sau. Dòng project/bộ đếm seed bằng `app_user` trong OrgScope của org scratch (FORCE RLS); dọn trong `afterAll` trước `db.drop()`.

Trong `test/integration/entitlements/catalogue-check.spec.ts`, thay khẳng định đếm cứng (D7-11):
```ts
    const unknownWarned = warn.mock.calls
      .map(([m]) => m)
      .filter((m): m is { event: string; key: string } =>
        typeof m === 'object' && m !== null && 'event' in m && m.event === 'entitlement_feature_unknown_to_code');
    expect(unknownWarned).toContainEqual({ event: 'entitlement_feature_unknown_to_code', key: 'cc.ghost' });
    // Mọi dòng chỉ-có-ở-DB được đếm (gồm dòng của feature mẫu khi vùng template còn đó): metric tăng đúng bằng số WARN.
    expect(await otel.metric('entitlements_catalogue_unknown_features_total')).toBe(unknownBefore + unknownWarned.length);
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/features/example/schema.spec.ts test/integration/features/example/migration-down.spec.ts`
Expected: FAIL (`relation "example_projects" does not exist`).

- [ ] **Step 3: Viết migration**

Thứ tự `up` (mỗi câu một `this.addSql`, chú thích đầu file theo mẫu 6C: bảng chuẩn hoá §7.6, mỗi index một query, khoá, hằng viết cứng ↔ hằng code):
1. `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sweep_definer') THEN RAISE EXCEPTION 'role sweep_definer is missing: run docker/postgres/init/01-roles.sh (DBA) before this migration'; …`.
2. `CREATE TABLE example_projects (…)` đúng mục 7.1; `CREATE UNIQUE INDEX example_projects_name_uq …`; `CREATE INDEX example_projects_purge_idx …` (không `list_idx`, D7-1; thêm index của S3 nếu spike đòi).
3. RLS + policy + grant đúng mục 7.1.
4. `SET LOCAL ROLE sweep_definer;` → `CREATE FUNCTION` mục 7.3 (bản S1 đã chọn) với `#variable_conflict use_column` sau `$$` (mẫu 6C, vì `RETURNS TABLE (org_id uuid)`), `RAISE … USING ERRCODE = 'invalid_parameter_value'` (22023) → `REVOKE ALL … FROM PUBLIC` → `GRANT EXECUTE … TO app_user` → `RESET ROLE;`.
5. `INSERT INTO permissions …`, `INSERT INTO permission_requires …` (mục 7.2).
6. `INSERT INTO entitlement_features (key, kind, reset_period) VALUES ('example.projects','FLAG',NULL), ('example.project_count','QUOTA','NONE');`.

`down` theo thứ tự §7.5 (1 `NO FORCE`; 2 `DO … RAISE EXCEPTION 'example_projects is not empty: delete projects or keep the migration'`; 3 `SET LOCAL ROLE sweep_definer; DROP FUNCTION …(uuid, integer, integer); RESET ROLE;`; 4 `DROP TABLE example_projects;`; 5 `DELETE FROM permission_requires WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'example_projects')`, `DELETE FROM permissions WHERE resource = 'example_projects'`; 6 `DELETE FROM entitlement_features WHERE key IN ('example.projects','example.project_count')`), rồi khối khẳng định FORCE nguyên văn của `Migration20261010032022_webhooks.ts` (D7-12; `migration-scan.spec.ts` đòi). Không `isTransactional`.

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `pnpm vitest run --project integration test/integration/features/example test/integration/entitlements/catalogue-check.spec.ts`
Run: `pnpm vitest run --project unit test/unit/migrations/migration-scan.spec.ts`
Expected: PASS (scanner thấy hàm tạo dưới `SET LOCAL ROLE sweep_definer`, `down` có `DROP FUNCTION` đối xứng và khối FORCE).

- [ ] **Step 5: Commit**
```bash
git add src/migrations/example test/integration/features/example test/integration/entitlements/catalogue-check.spec.ts
git commit -m "feat(example): example_projects migration with FORCE RLS, sweep definer, catalogue rows and a guarded down"
```

### Task 5: Inventory của feature vào test catalog của boilerplate (EX-I4, EX-I5, B2)

**Files:**
- Create: `test/integration/features/example/example.inventory.ts`
- Modify: `test/support/feature-inventory.ts` (thêm `mergeFeatureList`), `test/support/core-catalog.ts:44-53` (`SWEEP_DEFINER_FUNCTIONS`, `SWEEP_DEFINER_READ_TABLES` gộp inventory), `test/integration/core/database/rls-catalog.spec.ts:28-54` (`GLOBAL_TABLES` gộp `globalTables`)
- Test: `test/unit/support/feature-inventory.spec.ts` (tạo nếu chưa có; nếu đã có file test của `parseFeatureInventory` thì thêm ca vào đó)

**Interfaces:**
- Consumes: `parseFeatureInventory`, `mergeAnalysedColumns`, `type FeatureInventory` (`test/support/feature-inventory.ts`).
- Produces:
  - `FEATURE_INVENTORIES: Readonly<Record<string, unknown>> = import.meta.glob('../**/features/**/*.inventory.ts', { eager: true })` export từ `test/support/feature-inventory.ts` (một chỗ glob cho mọi test).
  - `mergeFeatureList(base: readonly string[], field: 'globalTables' | 'definerFunctions' | 'definerReadTables', inventories: Readonly<Record<string, unknown>>): string[]` — trùng với `base` hoặc giữa hai file → ném `<file>: <field> entry <x> is already declared`.
  - `example.inventory.ts`: `export const tables = [{ table: 'public.example_projects', columns: ['id','public_id','org_id','name','description','status','status_changed_at','version','created_at','updated_at'] }]; export const definerFunctions = ['example_orgs_with_purgeable_projects']; export const definerReadTables = ['example_projects'];`

- [ ] **Step 1: Viết test thất bại**

```ts
import { describe, expect, it } from 'vitest';
import { FEATURE_INVENTORIES, mergeFeatureList } from '../../support/feature-inventory.js';

describe('feature inventories (spec SP7 S7-D28, D7-8)', () => {
  it('the glob finds the sample inventory while the template zone exists', () => {
    expect(Object.keys(FEATURE_INVENTORIES).some((f) => f.endsWith('features/example/example.inventory.ts'))).toBe(true);
  });
  it('merges definer functions and refuses duplicates against the base and across files', () => {
    expect(mergeFeatureList(['a'], 'definerFunctions', { f1: { definerFunctions: ['b'] } })).toEqual(['a', 'b']);
    expect(() => mergeFeatureList(['a'], 'definerFunctions', { f1: { definerFunctions: ['a'] } })).toThrow(
      'f1: definerFunctions entry a is already declared',
    );
    expect(() =>
      mergeFeatureList([], 'globalTables', { f1: { globalTables: ['t'] }, f2: { globalTables: ['t'] } }),
    ).toThrow('f2: globalTables entry t is already declared');
  });
});
```
Ca "bỏ một cột khỏi inventory → đỏ" của EX-I5 là chính `normalization-inventory.spec.ts` (đã so tập cột mọi bảng `public`); kiểm thủ công một lần ở Step 4 (xoá `'version'` khỏi inventory → đỏ, trả lại).

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/support/feature-inventory.spec.ts`
Expected: FAIL (`FEATURE_INVENTORIES`/`mergeFeatureList` chưa có).

- [ ] **Step 3: Viết code**

- `feature-inventory.ts`: thêm `FEATURE_INVENTORIES` và `mergeFeatureList` (dùng `parseFeatureInventory` cho từng file). Đổi `normalization-inventory.spec.ts:432-436` dùng `FEATURE_INVENTORIES` thay glob riêng (một nguồn).
- `core-catalog.ts`: `SWEEP_DEFINER_FUNCTIONS = mergeFeatureList([...FIXTURE, ..._6C], 'definerFunctions', FEATURE_INVENTORIES)`, `SWEEP_DEFINER_READ_TABLES` tương tự với `definerReadTables`; chú thích "feature chỉ có `sweep_definer` (R-X4, D7-8)". `OWNED_FUNCTIONS.sweep_definer` tự theo.
- `rls-catalog.spec.ts`: `GLOBAL_TABLES = mergeFeatureList([...], 'globalTables', FEATURE_INVENTORIES)`.

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `pnpm vitest run --project unit test/unit/support test/unit/migrations`
Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts`
Expected: PASS — EX-I4 (bảng mới có RLS+FORCE, policy `TO app_user`, `_definer_read TO sweep_definer`, `sweep_definer` chỉ có SELECT cột trên đúng tập, tập SECURITY DEFINER bằng đúng tập đã khai), EX-I5. Kiểm đỏ thủ công: bỏ `'version'` khỏi inventory → `normalization-inventory` FAIL; bỏ `definerFunctions` → `rls-catalog` FAIL ở ca tập definer; trả lại.

- [ ] **Step 5: Commit**
```bash
git add test/support/feature-inventory.ts test/support/core-catalog.ts test/integration/core/database test/integration/features/example/example.inventory.ts test/unit/support
git commit -m "test(core): feature inventories feed the sweep_definer sets and global tables of the RLS catalog"
```

---

## Phần D — Ứng dụng

### Task 6: Repository SQL, service, module, đăng ký composition (EX-I14)

**Files:**
- Create: `src/features/example/infra/sql-project.repository.ts`, `application/actor.ts`, `application/project.service.ts`, `application/example-metrics.ts`, `example.module.ts`, `index.ts`
- Modify: `src/app.modules.ts` (ba dòng template), `.env.example` (sinh lại)
- Test: `test/integration/features/example/example-support.ts`, `test/integration/features/example/project-repository.spec.ts`, `test/integration/features/example/boot.spec.ts`

**Interfaces:**
- Consumes: `Db`, `UnitOfWork`, `OrgScope` (`core/database`); `RequestContext` (`core/context`); `EventPublisher`, `type EventActor`; `assertIfMatch` (`core/http`); `Quotas` (`modules/entitlements`); `PermissionCatalogueContributor` (`modules/tenancy`); `FeatureCatalogueContributor` (`modules/entitlements`); `metrics` (`@opentelemetry/api`).
- Produces:
  - `type ProjectRow = { id: string; publicId: string; orgId: string; name: string; description: string | null; status: ProjectStatus; statusChangedAt: Date; version: number; createdAt: Date; updatedAt: Date }`; `type DeletedProject = { publicId: string; version: number }`.
  - `ProjectRepository` (`@Injectable`, `Db`): `insert(i: { name: string; description: string | null }): Promise<ProjectRow>` (org = `app_current_org()`); `find(publicId: string, lock: 'NONE' | 'NO_KEY_UPDATE'): Promise<ProjectRow | undefined>`; `list(q: { limit: number; after?: string; status?: ProjectStatus }): Promise<ProjectRow[]>` (trả tối đa `limit + 1`, `ORDER BY public_id DESC`); `updateFields(id: string, f: { name: string; description: string | null }): Promise<ProjectRow>`; `setStatus(id: string, status: ProjectStatus): Promise<ProjectRow>` (đặt `status_changed_at = now()`, `version + 1`, `updated_at = now()`); `deleteOne(publicId: string): Promise<DeletedProject | undefined>`; `deleteDue(orgId: string, retentionSec: number, limit: number): Promise<DeletedProject[]>` (câu 7.4 nguyên văn); `deleteAllOfOrg(orgId: string): Promise<void>`. Mọi dòng qua một zod `Row` (sai hình → ném, không cast).
  - `actorOf(ctx: RequestContext): EventActor` (user → `user`; `api_key` → `{ type: 'service', id: \`api_key:${id}\` }`; `service` → `service`; không principal → ném; `switch` vét cạn như `Quotas.actor`).
  - `ProjectService`: `create(i: { name: string; description: string | null }): Promise<ProjectRow>`; `get(publicId: string): Promise<ProjectRow>`; `list(q: { limit: number; cursor?: string; status?: ProjectStatus }): Promise<{ rows: ProjectRow[]; hasMore: boolean; nextCursor: string | null }>`; `update(publicId: string, ifMatch: string | undefined, patch: { name?: string; description?: string | null }): Promise<ProjectRow>`; `archive(publicId: string): Promise<ProjectRow>`; `unarchive(publicId: string): Promise<ProjectRow>`; `remove(publicId: string): Promise<void>`.
  - `ExampleMetrics`: `purged = meter('example').createCounter('example_projects_purged_total', { description: 'Archived projects deleted after the retention period' })` — không nhãn.
  - `ExampleModule.forApi(): DynamicModule` (`ExampleCoreModule` + `ExampleHttpModule`), `ExampleModule.forWorker(): DynamicModule` (`ExampleCoreModule` + `ExampleWorkerModule`); `ExampleCoreModule` có hai contributor + `ProjectRepository` + `ExampleMetrics` (export hai cái sau). `ExampleHttpModule`/`ExampleWorkerModule` khai rỗng ở task này, Task 7/9 thêm.
  - `index.ts` export `ExampleModule`, `ExampleEvents`, `ExamplePermissions`, `ExampleFeatures`, `exampleConfig`, `type ExampleConfig`, `ExampleErrors`.
  - Test support `example-support.ts`: `LIMITED_MAX = 3`; `exampleTestPlans = definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: {} }, pro: { values: { 'tenancy.seats': UNLIMITED } }, limited: { values: { 'example.project_count': { max: LIMITED_MAX } } }, no_projects: { values: { 'example.projects': false } } } })`; `seedExamplePlans(): Promise<() => Promise<void>>` (`seedPlans` cho `limited`, `no_projects`); `startExampleApp(opts?: { env?: Record<string, string>; configure?: ConfigureTestingModule }): Promise<INestApplication>` = `startEntitlementsApp(exampleTestPlans, { env, configure, extraImports: [SweepModule, ExampleModule.forApi(), ExampleModule.forWorker()] })`; `projectsUrl(orgId: string): string`; `disposeExampleOrg(org: SeededOrg): Promise<void>` (xoá `example_projects` bằng `app_user` trong OrgScope rồi `org.dispose()` — `PURGE_ORDER` của boilerplate không biết bảng template); `projectRowsOf(orgId: string): Promise<{ publicId: string; name: string; status: string; version: number }[]>` (app_user trong OrgScope, `rowCount` khẳng định ở chỗ gọi).

Luồng service (thứ tự khoá S7-D35, D7-4):
- `create`: `uow.run` → `repo.insert` → `quotas.consumeOrThrow(ExampleFeatures.key('example.project_count'), 1)` (chú thích: "nhiều quota trong một transaction: gọi theo thứ tự key tăng dần (hợp đồng Quotas, 4B I2)") → `events.publish(ProjectCreatedEvent, { data: { projectId }, aggregate: { type: EXAMPLE_PROJECT_AGGREGATE, id: publicId, version: 1 }, actor: actorOf(ctx) })`.
- `update`: `uow.run` → `find(…, 'NO_KEY_UPDATE')` (vắng → 404) → `assertIfMatch(ifMatch, cur.version, { required: true })` → `transition(cur.status, 'UPDATE')` (REJECTED → `AppError(code, { expected: true })`) → tính `changed` (`name` khác **chính xác** chuỗi cũ, `description` khác); rỗng → trả `cur` (không version, không event) → `updateFields` → event `updated { projectId, changed }` version mới.
- `archive`/`unarchive`: `find` khoá → `transition` → `setStatus` → event.
- `remove`: `uow.run` → `deleteOne` (vắng → 404) → `quotas.releaseAllocation(key, 1)` → event `deleted { reason: 'REMOVED' }` với `version: deleted.version + 1`.
- `list`: `cursor` → `decodeProjectCursor`; `rows = repo.list({ limit, after, status })` trong `uow.run` (đọc trong transaction của OrgScope); `hasMore = rows.length > limit`; cắt; `nextCursor = encodeProjectCursor(last.publicId)`.

- [ ] **Step 1: Viết test thất bại**

`project-repository.spec.ts` (Nest app thật qua `startExampleApp()`, gọi `ProjectRepository` trong `OrgScope.run` + `UnitOfWork.run`):
```ts
describe('ProjectRepository SQL (spec §7.4, §8.1)', () => {
  // beforeAll: app = await startExampleApp(); org = await seedOrg(); inOrg = (fn) => app.get(OrgScope).run(org.orgId, () => app.get(UnitOfWork).run(fn))
  it('insert defaults: ACTIVE, version 1, uuidv7 public id, org from app_current_org()', async () => {});
  it('list: public_id DESC, limit + 1 rows, after excludes the cursor row, status filter', async () => {});
  it('setStatus bumps version and status_changed_at; updateFields bumps version only', async () => {});
  it('deleteDue takes only ARCHIVED rows older than the retention, oldest first, at most limit, and skips a row locked by another transaction', async () => {
    // holder = holdInOrg(org.orgId, 'SELECT 1 FROM example_projects WHERE public_id = $1 FOR NO KEY UPDATE', [lockedId], 1)
    // deleteDue(org.orgId, 3600, 10) → không có lockedId; holder.release()
  });
  it('a 23505 on example_projects_name_uq surfaces as 409 example_project_name_taken without the constraint name', async () => {});
});
```
`boot.spec.ts` (EX-I14):
```ts
describe('the sample boots through the SP4 and SP3 catalogue checks (EX-I14)', () => {
  it('api + worker composition with ExampleModule boots; EntitlementRouteInventory accepts the gated routes', async () => {
    const app = await startExampleApp();
    await app.close();
  });
  it('without one example entitlement_features row the boot fails naming the key (code key missing in the DB)', async () => {
    // withOwner: DELETE FROM entitlement_features WHERE key = 'example.projects' (dòng FLAG chưa có override nào tham chiếu);
    // buildTestApp(...) + init() rejects /example\.projects/ (key của code vắng ở DB = lỗi boot, R-X30); finally: chèn lại dòng.
  });
});
```
Ca "bỏ dòng" phải chèn lại dòng trong `finally` (dùng `withOwner`), kể cả khi boot không fail; `id` mới của dòng không ảnh hưởng test khác (mọi app đọc `featureId` lúc boot).

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/features/example/project-repository.spec.ts test/integration/features/example/boot.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 3: Viết code, đăng ký composition**

`src/app.modules.ts` (thêm đúng ba dòng, mỗi dòng kết thúc `// upstream:template`, cùng hình dạng `test/support/upstream-fixture.ts:71-76`):
```ts
import { ExampleModule } from './features/example/index.js'; // upstream:template
…
const features: AppFeatures = { api: [], worker: [] };
features.api.push(ExampleModule.forApi()); // upstream:template
features.worker.push(ExampleModule.forWorker()); // upstream:template
```
`example.module.ts`: import side effect `./errors.js`, `./events.js`, `./example.config.js`, `./jobs.js` (mẫu `integrations.module.ts`). Rồi `pnpm env:example`.

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `pnpm vitest run --project integration test/integration/features/example test/integration/core/sweep/org-sweep-signatures.spec.ts`
Run: `pnpm env:example && git diff --stat .env.example`
Expected: PASS; `org-sweep-signatures.spec.ts` ca "every sweep the app registers" giờ gồm `example.projects.purge-archived` và xanh (EX-I15 nửa đầu); `.env.example` thêm sáu dòng `EXAMPLE_*`.

- [ ] **Step 5: Commit**
```bash
git add src/features/example src/app.modules.ts .env.example test/integration/features/example
git commit -m "feat(example): SQL repository, ProjectService with row-then-counter lock order, module wired into the composition"
```

### Task 7: HTTP — controller, ETag/If-Match, merge-patch, cursor, `@Idempotent()` (EX-E1…EX-E6, R7-2, R7-3; Review Focus 1, 2, 4)

**Files:**
- Create: `src/features/example/http/projects.controller.ts`
- Modify: `src/features/example/example.module.ts` (`ExampleHttpModule`: controller + `ProjectService`), `src/features/example/http/schemas.ts` (`projectOf`), `openapi.json`
- Test: `test/e2e/features/example/projects.e2e.spec.ts`

**Interfaces:**
- Consumes: `ProjectService` (Task 6); `Paginator`, `serialize`, `setLocation`, `etagOf`, `ApiOk`, `ApiProblems`, `Idempotent`, `type HeaderWriter` (`core/http`); `ExamplePermissions.require`, `ExampleFeatures.requireEnabled`.
- Produces: `@Controller('v1/orgs/:orgId/projects') ProjectsController` với bảy route bảng 9.1 (D7-1: list cursor). `projectOf(row: ProjectRow)` → `{ id: publicId, name, description, status, statusChangedAt: iso, createdAt: iso, updatedAt: iso }`.

Decorator mỗi route (thứ tự viết không đổi ngữ nghĩa: guard luôn trước interceptor, S4-D7):
- `GET ''`: `@ExamplePermissions.require('example_projects.read') @ApiOk(ProjectPage) @ApiProblems(CoreErrors.INVALID_CURSOR, CoreErrors.VALIDATION_FAILED)`; `@Query({ schema: ProjectListQuery })`.
- `POST ''`: `@ExamplePermissions.require('example_projects.write') @ExampleFeatures.requireEnabled('example.projects') @Idempotent() @ApiOk(ProjectResponse) @ApiProblems(ExampleErrors.EXAMPLE_PROJECT_NAME_TAKEN, CoreErrors.QUOTA_EXCEEDED, CoreErrors.FEATURE_NOT_IN_PLAN, CoreErrors.VALIDATION_FAILED)` (hai mã của SP4 là `CoreErrors`, `src/modules/entitlements/errors.ts:111-117`); `setLocation(res, \`/v1/orgs/${orgId}/projects/${id}\`)`, `ETag`.
- `GET ':projectId'`: read; `ETag`.
- `PATCH ':projectId'`: write + cờ; `@Headers('if-match')`; body `PatchProjectBody` (core trả 415 khi không phải `application/merge-patch+json`).
- `POST ':projectId/archive'`, `POST ':projectId/unarchive'`: write + cờ + `@Idempotent()` + `@HttpCode(HttpStatus.OK)`.
- `DELETE ':projectId'`: `example_projects.delete`, `@HttpCode(HttpStatus.NO_CONTENT)`; không cờ (S7-D5).

- [ ] **Step 1: Viết test thất bại**

`test/e2e/features/example/projects.e2e.spec.ts` (app `startExampleApp()`, principal `seedUserPrincipal()` + `authed`):
```ts
describe('projects over HTTP (spec §9, EX-E1..E6)', () => {
  it('EX-E1: create 201 + Location + ETag W/"1"; get 200; If-None-Match → 304; delete 204; get → 404', async () => {
    const r = await authed(app, owner).post(projectsUrl(org.orgId)).set('idempotency-key', `k-${v7()}`).send({ name: 'Website' });
    expect([r.status, r.headers.etag, r.headers.location]).toEqual([201, 'W/"1"', `${projectsUrl(org.orgId)}/${r.body.id}`]);
    expect(r.body).toEqual({ id: expect.any(String), name: 'Website', description: null, status: 'ACTIVE',
      statusChangedAt: expect.any(String), createdAt: expect.any(String), updatedAt: expect.any(String) });
    const g = await authed(app, owner).get(`${projectsUrl(org.orgId)}/${r.body.id}`);
    expect(g.status).toBe(200);
    expect((await authed(app, owner).get(`${projectsUrl(org.orgId)}/${r.body.id}`).set('if-none-match', 'W/"1"')).status).toBe(304);
    expect((await authed(app, owner).delete(`${projectsUrl(org.orgId)}/${r.body.id}`)).status).toBe(204);
    expect((await authed(app, owner).get(`${projectsUrl(org.orgId)}/${r.body.id}`)).status).toBe(404);
  });
  it('EX-E2 (D7-1): cursor pages newest first, status filter, limit cap, nextCursor null on the last page', async () => {
    // tạo 5 project (2 archive); limit=2 → 3 trang [5,4],[3,2],[1], hasMore true,true,false; ?status=ARCHIVED → đúng 2;
    // ?limit=<PAGINATION_MAX_PAGE_SIZE + 1> → 422 validation_failed
  });
  it('cursor tampering → 400 invalid_cursor (Review Focus 1)', async () => {
    for (const c of ['***', Buffer.from('[1,2]').toString('base64url'), Buffer.from('["x"]').toString('base64url')])
      expect((await authed(app, owner).get(`${projectsUrl(org.orgId)}?cursor=${encodeURIComponent(c)}`)).body.code).toBe('invalid_cursor');
  });
  it('EX-E3 / R7-3: same key replays the stored 201 and consumes once; another body → 422 idempotency_key_reused; concurrent → one 201, one 409 idempotency_conflict', async () => {});
  it('archive replay after delete returns the stored 200 (Review Focus 4)', async () => {});
  it('EX-E4 / R7-2: name collisions (case and whitespace) → 409 example_project_name_taken, no constraint name in the body; PATCH onto another name → 409 (Review Focus 2)', async () => {
    // tạo 'Website'; POST ' website ', 'WEBSITE' → 409; JSON.stringify(body) không chứa 'example_projects_name_uq';
    // hai POST song song cùng tên khác key → một 201, một 409
  });
  it('EX-E5: PATCH without If-Match → 428; stale → 412; status in body → 422; application/json → 415; no change → 200 same ETag, no event', async () => {});
  it('EX-E6: archive/unarchive follow table 8.1 with coded 409s; malformed projectId → 404 (D7-3)', async () => {});
});
```
Mỗi ca có thân đầy đủ khi viết (khẳng định status, `body.code`, `errors[0]` nếu có, ETag); "no event" đọc `outboxOf(org.orgId, 'example.project.updated')` của `entitlements-seed.ts`.

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project integration test/e2e/features/example/projects.e2e.spec.ts`
Expected: FAIL (404 cho mọi route).

- [ ] **Step 3: Viết controller (mẫu `webhook-endpoints.controller.ts`), sinh OpenAPI**

Run: `pnpm build && pnpm openapi:export`

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `pnpm vitest run --project integration test/e2e/features/example/projects.e2e.spec.ts test/e2e/core/api-docs.e2e.spec.ts`
Run: `git diff --stat openapi.json && git diff openapi.json | grep '^-' | grep -v '^---'`
Expected: PASS; diff `openapi.json` chỉ thêm (không dòng `-` nào ngoài header): path `/v1/orgs/{orgId}/projects…` và schema mới. Kiểm breaking chính thức là job CI `oasdiff/oasdiff-action/breaking` (`.github/workflows/ci.yml:47`) trên PR.

- [ ] **Step 5: Commit**
```bash
git add src/features/example openapi.json test/e2e/features/example
git commit -m "feat(example): projects HTTP API with ETag, merge-patch, cursor pagination and idempotent create/archive"
```

### Task 8: Cổng gói và quota qua HTTP (EX-E7, EX-E8, R7-1; Review Focus 3)

**Files:**
- Test: `test/e2e/features/example/entitlements.e2e.spec.ts`

**Interfaces:**
- Consumes: `startExampleApp`, `seedExamplePlans`, `LIMITED_MAX`, `exampleTestPlans` (Task 6); `seedOrgEntitlement`, `setOrgPlan`, `readCounters`, `seedOverride` (`test/support/entitlements-seed.ts`); `seedMember` (`tenancy-seed.ts`).
- Produces: không có code sản phẩm mới (task chứng minh hợp đồng SP4 mà mẫu dựa vào; lỗi ở đây sửa ở Task 6/7).

- [ ] **Step 1: Viết test thất bại**

```ts
describe('plan gate and quota of the sample (spec §10.4, EX-E7, EX-E8)', () => {
  it(`EX-E7 / R7-1: plan limited (max ${LIMITED_MAX}) — ${LIMITED_MAX} + 5 parallel creates → exactly ${LIMITED_MAX} × 201, 5 × 422 quota_exceeded with errors[0].code example.project_count; counter = rows`, async () => {
    await seedOrgEntitlement(org.orgId, 'limited');
    const rs = await Promise.all(
      Array.from({ length: LIMITED_MAX + 5 }, (_, i) =>
        authed(app, owner).post(projectsUrl(org.orgId)).set('idempotency-key', `k-${v7()}`).send({ name: `p${i}` })),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(LIMITED_MAX);
    const refused = rs.filter((r) => r.status === 422);
    expect(refused).toHaveLength(5);
    for (const r of refused)
      expect([r.body.code, r.body.errors?.[0]?.path, r.body.errors?.[0]?.code]).toEqual(['quota_exceeded', 'feature', 'example.project_count']);
    expect((await readCounters(org.orgId)).find((c) => c.feature === 'example.project_count')?.used).toBe(LIMITED_MAX);
    expect(await projectRowsOf(org.orgId)).toHaveLength(LIMITED_MAX);
  });
  it('EX-E7: delete one → one more create passes; counter still = rows', async () => {});
  it('EX-E7: fallback (plan free, UNLIMITED) still writes the counter: 5 creates → used 5 = rows', async () => {});
  it('over-limit org still deletes and releases (Review Focus 3): limited org with 3 rows moved to a plan of max 1 → DELETE 204 ×2, counter 1, no underflow', async () => {
    // setOrgPlan(org, plan max 1 — thêm gói 'tight' {max:1} vào exampleTestPlans + seedExamplePlans) → POST 422; DELETE 204; DELETE 204; POST 422; readCounters used = rows
  });
  it('EX-E8: plan no_projects → POST/PATCH/archive/unarchive 403 feature_not_in_plan (errors[0].code example.projects); GET 200, DELETE 204', async () => {});
  it('EX-E8: a member without example_projects.delete on a gated-off plan gets 403 forbidden on DELETE (CASL before the plan gate, S4-D7); an override enabled: false on plan free gates the same routes', async () => {
    // seedOverride(org, 'example.projects', { value: { enabled: false } }) → POST 403 feature_not_in_plan
  });
});
```
(Gói `tight` thêm vào `exampleTestPlans` ở Task 6 cùng lúc: `tight: { values: { 'example.project_count': { max: 1 } } }`; `seedExamplePlans` chèn cả `tight`.)

- [ ] **Step 2: Chạy**

Run: `pnpm vitest run --project integration test/e2e/features/example/entitlements.e2e.spec.ts`
Expected: PASS nếu Task 6/7 đúng hợp đồng; ca nào FAIL thì sửa ở service/controller (không nới test) rồi chạy lại tới PASS.

- [ ] **Step 3: Commit**
```bash
git add test/e2e/features/example/entitlements.e2e.spec.ts test/integration/features/example/example-support.ts
git commit -m "test(example): plan gate and atomic quota of the sample over HTTP (N + 5 parallel creates, over-limit delete)"
```

---

## Phần E — Worker

### Task 9: Job xoá theo org, handler quét, participant xoá cứng, metric (EX-I6, EX-I12, EX-I15, EX-E10; Review Focus 5)

**Files:**
- Create: `src/features/example/application/purge-org.handler.ts`, `purge-archived-sweep.handler.ts`, `project-purge.participant.ts`
- Modify: `src/features/example/example.module.ts` (`ExampleWorkerModule`)
- Test: `test/integration/features/example/purge.spec.ts`, `test/integration/features/example/sweep.spec.ts`, `test/e2e/features/example/soft-deleted-org.e2e.spec.ts`

**Interfaces:**
- Consumes: `OrgSweepRunner`, `type OrgSweepResult` (`core/sweep`); `JobHandler`, `type JobContext` (`core/queue`); `OrgPurgeParticipant`, `OrgPurgeParticipantContributor` (`modules/tenancy`); `PurgeOrgHandler` của tenancy (test, `src/modules/tenancy/application/purge-orgs.handler.ts`); `ProjectRepository.deleteDue/deleteAllOfOrg`, `ExampleMetrics.purged`, `EXAMPLE_PURGE_ACTOR`, `EXAMPLE_PURGE_ORDER`.
- Produces:
  - `@JobHandler(PurgeOrgJob) class PurgeOrgHandler { handle(ctx: JobContext<unknown>): Promise<{ deleted: number }> }` — `uow.run`: `rows = repo.deleteDue(orgId, cfg.archivedRetentionSec, cfg.purgeRowsPerJob)`; `rows.length > 0` thì `quotas.releaseAllocation(key, rows.length)` rồi mỗi dòng một `ProjectDeletedEvent { projectId, reason: 'RETENTION' }` với `aggregate.version = version + 1`, actor `EXAMPLE_PURGE_ACTOR`; **sau** `uow.run` (không đếm hai lần khi UnitOfWork chạy lại) `metrics.purged.add(n)` khi `n > 0`. `orgId` lấy từ `RequestContext` (WorkerHost đã mở OrgScope); vắng → ném.
  - `@JobHandler(PurgeArchivedSweep.job) class PurgeArchivedSweepHandler { handle(): Promise<OrgSweepResult> }` → `runner.run(PurgeArchivedSweep)`.
  - `@OrgPurgeParticipantContributor({ key: 'example.projects', order: EXAMPLE_PURGE_ORDER }) class ExampleProjectsPurgeParticipant extends OrgPurgeParticipant { purge(orgId: string): Promise<void> }` → `repo.deleteAllOfOrg(orgId)`; không release, không event (§10.3).

- [ ] **Step 1: Viết test thất bại**

`purge.spec.ts` (app worker: `createTestApp(entitlementsCoreImports(exampleTestPlans, [SweepModule, ExampleModule.forWorker()]))`; gọi handler trong `OrgScope.run` với `jobCtx` như `overrides-races.spec.ts:64`):
```ts
describe('per-org purge job and org hard-delete participant (spec §7.4, §10.2, §10.3)', () => {
  it('deletes only due ARCHIVED rows, releases exactly that many, one RETENTION event each with version + 1, metric += n', async () => {
    // seed qua HTTP-less: repo.insert + setStatus ARCHIVED + UPDATE status_changed_at lùi 31 ngày (app_user, OrgScope);
    // 3 due + 1 fresh ARCHIVED + 1 ACTIVE; consume quota 5 lần qua Quotas trong cùng transaction seed (bộ đếm = 5)
    // handle → { deleted: 3 }; readCounters used 2; outboxOf(org, 'example.project.deleted') 3 dòng reason RETENTION, aggregate_version = version + 1
  });
  it('purge with nothing due: no release, no event, metric unchanged (Review Focus 5)', async () => {});
  it('EXAMPLE_PURGE_ROWS_PER_JOB caps one run; the next run takes the rest (idempotent rerun)', async () => {});
  it('EX-I6: tenancy purge with the participant (order 200) deletes projects and the SP4 counters (order 100); tenancy.org.purged is published', async () => {
    // soft delete due (như overrides-races softDeleteDue) → app.get(OrgScope).run(org, () => app.get(TenancyPurgeOrgHandler).handle(jobCtx(org)))
  });
  it('EX-I6: without the participant (app built without ExampleModule.forWorker) the purge fails with 23001 and the org stays', async () => {});
});
```
`sweep.spec.ts` (EX-I12, mẫu `test/integration/core/sweep/org-sweep.spec.ts`: app có `QueueModule.forRoot({ runWorkers: false })`, `JobQueue` thật; `EXAMPLE_PURGE_ORG_BATCH_SIZE: '2'`; ba org có dòng đến hạn, một org không):
```ts
describe('example sweep through the real OrgSweepRunner and the real definer (EX-I12, EX-I15)', () => {
  it('more than one batch: every due org is enqueued once per slot with jobId example-purge-<orgId>-<slot>', async () => {});
  it('two overlapping runs in the same slot add no job; a run in the next slot enqueues an org whose previous job failed', async () => {});
  it('running the enqueued jobs deletes each due row exactly once; RETENTION events = rows', async () => {});
  it('EX-I15: the registered sweep matches pg_proc (sweepSignatureProblems = [])', async () => {
    expect(await withOwner((c) => sweepSignatureProblems(c, PurgeArchivedSweep))).toEqual([]);
    expect(await withOwner((c) => sweepSignatureProblems(c, { ...PurgeArchivedSweep, extraParams: () => ({ p_retention: 1 }) }))).toEqual([
      'p_retention is not a parameter of example_orgs_with_purgeable_projects',
      'example_orgs_with_purgeable_projects: parameter p_retention_sec is never passed by the sweep',
    ]);
  });
});
```
`soft-deleted-org.e2e.spec.ts` (EX-E10): org xoá mềm → bảy route `404`; job `PurgeOrgJob` của org đó qua `WorkerHost` bị `OrgActivityGate` bỏ qua (dòng đến hạn còn nguyên, không event) — enqueue bằng `JobQueue` với `meta.orgId`, chạy worker consume `example` (`WORKER_QUEUES: 'events,notifications,example'`), chờ job `completed` có hạn chót.

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/features/example/purge.spec.ts test/integration/features/example/sweep.spec.ts test/e2e/features/example/soft-deleted-org.e2e.spec.ts`
Expected: FAIL (handler/participant chưa có; worker boot ném `Jobs on consumed queues have no @JobHandler`).

- [ ] **Step 3: Viết code**, đăng ký ba provider trong `ExampleWorkerModule`.

- [ ] **Step 4: Chạy, xác nhận pass**

Run: lệnh Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/features/example test/integration/features/example test/e2e/features/example
git commit -m "feat(example): per-org retention purge job, thin sweep handler and org hard-delete participant (order 200)"
```

---

## Phần F — Race, quyền, PII, kiến trúc

### Task 10: Race có tên với seam, retry tắt (R7-4, R7-5, R7-6, R7-7, R7-8, R7-18; EX-I9, EX-I10, EX-I11, EX-I6b)

**Files:**
- Test: `test/integration/features/example/races.spec.ts`, `test/integration/features/example/purge-races.spec.ts`

**Interfaces:**
- Consumes: `holdInOrg`, `waitForBlocked`, `type EntitlementRowHolder` (`test/support/entitlements-races.ts`); `startExampleApp({ env: { DB_TX_RETRY_ATTEMPTS: '0' } })`; `PurgeOrgHandler` của mẫu và của tenancy; participant fixture có order 150 và 999 (khai trong file test, `@OrgPurgeParticipantContributor({ key: 'test.barrier', order })` + một `Promise` cổng).
- Produces: không code sản phẩm.

Mọi app trong hai file dựng với `DB_TX_RETRY_ATTEMPTS: '0'` (UnitOfWork không chạy lại nạn nhân deadlock, nên "không 40P01" là khẳng định thật). Trước/sau mỗi ca "không deadlock": `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()` không đổi.

- [ ] **Step 1: Viết test**

```ts
describe('named races of the sample (spec §16, retries off)', () => {
  it('R7-4: a PATCH waits on the row lock of a concurrent edit, then sees the new version → 412', async () => {
    // holder: holdInOrg(org, `UPDATE example_projects SET version = version + 1, updated_at = now() WHERE public_id = $1`, [id], 1)
    // p = PATCH If-Match W/"1"; waitForBlocked(holder.pid, 1); holder.commitWith('SELECT 1'); expect((await p).status).toBe(412)
  });
  it('R7-5 (a): unarchive first holds the row → the purge job skips it (SKIP LOCKED), the row survives ACTIVE', async () => {
    // holder giữ FOR NO KEY UPDATE như unarchive đang chạy; chạy PurgeOrgHandler → { deleted: 0 }; holder.release()
  });
  it('R7-5 (b): purge deleted the row first (uncommitted) → unarchive blocks, then 404; counter = rows', async () => {
    // holder: DELETE … WHERE public_id = $1 (chưa commit) + UPDATE usage_counters SET used = used - 1 …;
    // p = POST …/unarchive; waitForBlocked(holder.pid, 1); holder.commitWith('SELECT 1'); (await p).status 404
  });
  it('R7-6: manual DELETE and the purge job never release twice — both orders, counter = rows', async () => {});
  it('R7-18: create "a" while a manual delete of "A" holds the row and the counter → create waits on the unique index, then 201; no deadlock', async () => {
    // holder: DELETE 'A' + UPDATE usage_counters (giữ khoá bộ đếm, đúng thứ tự dòng → bộ đếm của đường xoá)
    // p = POST name 'a'; waitForBlocked(holder.pid, 1); holder.commitWith('SELECT 1'); (await p).status 201; deadlocks không đổi
  });
  it('R7-8 / EX-I11: 20 creates ∥ 20 manual deletes (some same name, other case) ∥ the purge job: no 40P01, no 5xx, counter = rows', async () => {});
});
```
`purge-races.spec.ts` (EX-I6b, R7-7, app worker của Task 9 + participant barrier):
```ts
describe('R7-7: create ∥ org hard delete (EX-I6b)', () => {
  it('(a) an INSERT committed between the sample participant and DELETE organizations → the purge rolls back with 23001; the retry is green; no orphan row', async () => {
    // barrier participant order 999 chờ cổng; trong lúc chờ: withAppClient INSERT example_projects (OrgScope) commit; mở cổng;
    // lần purge 1 → Error code 23001; lần purge 2 (barrier mở sẵn) → xanh; projectRowsOf = 0; to_regclass… không dòng nào của org
  });
  it('(b) the SP4 participant already deleted the counter row when a create consumes → one side gets 40P01 (retries off), the other wins; no orphan, no counter drift', async () => {
    // barrier order 150 (sau SP4 100, trước mẫu 200); holder: INSERT project + INSERT … ON CONFLICT usage_counters (câu consume của 4B, chép từ
    // `src/modules/entitlements/infra/sql/sql-usage-counter.repository.ts`) bị chặn; mở cổng; đúng một bên là 40P01
  });
});
```

- [ ] **Step 2: Chạy**

Run: `pnpm vitest run --project integration test/integration/features/example/races.spec.ts test/integration/features/example/purge-races.spec.ts`
Expected: PASS. Ca nào FAIL do thứ tự khoá (40P01 ở R7-18/R7-8) là lỗi thứ tự trong service: sửa service (giữ S7-D35), không nới test.

- [ ] **Step 3: Commit**
```bash
git add test/integration/features/example
git commit -m "test(example): named races forced with holders and purge barriers, transaction retries off"
```

### Task 11: Ma trận vai trò × route (EX-E9, gồm org API key và support grant của 3D) và event tới subscriber (EX-E11)

**Files:**
- Test: `test/e2e/features/example/route-matrix.e2e.spec.ts`, `test/e2e/features/example/events.e2e.spec.ts`

**Interfaces:**
- Consumes: `OrgRouteInventory` (`src/modules/tenancy/application/org-route-inventory.js`), `PermissionCatalogueRegistry`, `systemRolePermissions` (như `test/e2e/integrations/route-matrix.e2e.spec.ts`); `seedOrgApiKey`, `seedSupportGrant`, `apiKeyEligibleKeys`, `supportPresetKeys`, `seedCustomRole`, `seedMemberInRole`, `seedStaffPrincipal`; `startAppProcess`/`stopAppProcess` (`test/support/app-process.ts`); `EventSubscriber`.
- Produces: không code sản phẩm.

- [ ] **Step 1: Viết test**

`route-matrix.e2e.spec.ts` theo đúng khung của `test/e2e/integrations/route-matrix.e2e.spec.ts` (ma trận sinh từ metadata, R-X24 không hard-code tập quyền), cột `OWNER | ADMIN | MEMBER | CUSTOM | KEY | SUPPORT | OUTSIDER | OTHER_ORG`:
- `CUSTOM` = role tuỳ biến chỉ `['org.read', 'example_projects.read']` (`seedCustomRole` + `seedMemberInRole`);
- `KEY` = org key với `apiKeyEligibleKeys(merged)` qua header `x-api-key`;
- `SUPPORT` = support grant `supportPresetKeys(merged)` của `seedStaffPrincipal()`;
- `OUTSIDER` = user không member → mọi route `404`;
- `OTHER_ORG` = owner của org khác gọi project id của org này → `404` (RLS).
Ca đầu liệt kê đúng bảy route `…/projects…`. Ca chính: mỗi ô qua guard ⇔ catalogue cấp mọi key; khẳng định hình dạng: `passed.MEMBER` = mọi route trừ `DELETE`; `passed.KEY` = read + write (không `DELETE`); `passed.SUPPORT` = hai `GET`; `passed.CUSTOM` = hai `GET`. Ca phụ: một `POST` thật bằng org key → `201` và outbox `example.project.created` có `headers.actorType = 'service'`.

`events.e2e.spec.ts` (EX-E11):
- subscriber fixture `@EventSubscriber({ consumer: 'test.example-created', event: ProjectCreatedEvent })` ghi envelope; tạo → archive → unarchive → PATCH → delete; subscriber nhận đúng `aggregate.version` 1,2,3,4 và delete 5; payload chỉ `projectId` (+ `changed`/`reason`).
- kill giữa handler và commit: `startAppProcess('test/support/api-entry.ts', env)`; holder giữ uncommitted một dòng cùng `lower(name)` để `INSERT` của request bị chặn (`waitForBlocked(holder.pid, 1)`); `SIGKILL` process api; `holder.release()`; khẳng định: không dòng project, không dòng outbox `example.project.created` của org, bộ đếm không có hoặc `used = 0`.

- [ ] **Step 2: Chạy**

Run: `pnpm vitest run --project integration test/e2e/features/example/route-matrix.e2e.spec.ts test/e2e/features/example/events.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add test/e2e/features/example
git commit -m "test(example): role x route matrix with org API key, support grant and custom role; event versions and crash safety"
```

### Task 12: Không PII ở log, span và nhãn metric

**Files:**
- Test: `test/e2e/features/example/pii.e2e.spec.ts`

**Interfaces:**
- Consumes: `startAppProcess` + `api-entry.ts`/`worker-entry.ts` (log pino thật, như `test/e2e/integrations/pii-logs.e2e.spec.ts`); `installOtelCapture`, `getNodeAutoInstrumentations` (theo kết quả S2).
- Produces: không code sản phẩm.

- [ ] **Step 1: Viết test**

```ts
const NAME_MARK = `PII Project ${v7().slice(-12)}`;
const DESC_MARK = `PII Description ${v7().slice(-12)}`;
describe('no project name or description in logs, spans or metric labels (spec §15 "Không PII")', () => {
  it('logs: api + worker processes at LOG_LEVEL=debug — create, duplicate (409), patch, archive, retention purge — never print the marks', async () => {
    // EXAMPLE_PURGE_CRON '* * * * *', status_changed_at lùi bằng app_user; chờ dòng biến mất (có hạn chót);
    // mọi dòng stdout/stderr của hai process không chứa NAME_MARK, DESC_MARK, tên đổi ở PATCH
  });
  it('spans: http server and pg spans (real auto-instrumentation, D7-13) carry no mark in any attribute or event', async () => {
    // theo S2: in-process (otel.spanNames()/spans()) hoặc process thật + receiver OTLP
  });
  it('metrics: no data point of example_*, entitlements_*, http_* or db_* has a mark or an org id in its labels', async () => {
    // otel.dataPoints('') → mọi attributes; String(v) không chứa mark/orgId; example_projects_purged_total không có nhãn
  });
});
```

- [ ] **Step 2: Chạy**

Run: `pnpm vitest run --project integration test/e2e/features/example/pii.e2e.spec.ts`
Expected: PASS. Nếu instrumentation pg ghi `db.statement` kèm giá trị (không phải tham số) → lỗi thật ở repository (nối chuỗi vào SQL): sửa repository, không nới test.

- [ ] **Step 3: Commit**
```bash
git add test/e2e/features/example/pii.e2e.spec.ts
git commit -m "test(example): no project names in logs, auto-instrumented spans or metric labels"
```

### Task 13: Luật kiến trúc `features-only-public-api-of-other-features` và EX-U9 (tập định danh chép mẫu)

**Files:**
- Modify: `.dependency-cruiser.cjs` (sau `features-only-public-api`), `test/unit/architecture/rules.spec.ts` (một dòng `it.each`)
- Create: `test/architecture/fixtures/src/features/y/index.ts`, `test/architecture/fixtures/src/features/y/internal.ts`, `test/architecture/fixtures/src/features/x/uses-other-feature-internals.ts`, `test/architecture/fixtures/src/features/x/uses-other-feature-index.ts`
- Test: `test/unit/features/example/identifiers.spec.ts`

**Interfaces:**
- Produces: luật depcruise
```js
{
  name: 'features-only-public-api-of-other-features',
  severity: 'error',
  comment: 'SP7 §6.3.1: a feature imports another feature only through its index.ts.',
  from: { path: '(^|/)src/features/([^/]+)/' },
  to: { path: '(^|/)src/features/([^/]+)/(?!index\\.ts$)', pathNot: '(^|/)src/features/$2/' },
},
```
  và `EXAMPLE_IDENTIFIERS: readonly string[]` (trong file test) = mọi token chứa `example`/`Example`/`EXAMPLE` hợp lệ.

- [ ] **Step 1: Viết test thất bại**

`rules.spec.ts`: thêm `['features-only-public-api-of-other-features', 'features/x/uses-other-feature-internals.ts']` vào `it.each`, và một ca: `found.filter((v) => v.from.endsWith('features/x/uses-other-feature-index.ts'))` rỗng.

`test/unit/features/example/identifiers.spec.ts` (EX-U9):
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/features/example', 'src/migrations/example'];
const TOKEN = /[A-Za-z0-9_$.\-/]*[Ee][Xx][Aa][Mm][Pp][Ll][Ee][A-Za-z0-9_$.\-]*/g;
/** Tập định danh phải đổi khi chép mẫu (spec SP7 §6.3.3; docs/boilerplate/README.md "Tạo feature từ mẫu"). */
const EXAMPLE_IDENTIFIERS = [
  'example_projects', 'example_projects_org_fk', 'example_projects_org_public_uq', 'example_projects_name_ck',
  'example_projects_description_ck', 'example_projects_status_ck', 'example_projects_version_ck', 'example_projects_name_uq',
  'example_projects_purge_idx', 'example_projects_tenant', 'example_projects_definer_read',
  'example_orgs_with_purgeable_projects', 'example_projects.read', 'example_projects.write', 'example_projects.delete',
  'example.project.created', 'example.project.updated', 'example.project.archived', 'example.project.unarchived',
  'example.project.deleted', 'example', 'example.projects.purge-org', 'example.projects.purge-archived', 'example-purge',
  'example_project_name_taken', 'example_project_not_active', 'example_project_not_archived', 'EXAMPLE_PROJECT_NAME_TAKEN',
  'EXAMPLE_PROJECT_NOT_ACTIVE', 'EXAMPLE_PROJECT_NOT_ARCHIVED', 'EXAMPLE_ARCHIVED_RETENTION_SEC', 'EXAMPLE_PURGE_CRON',
  'EXAMPLE_PURGE_TZ', 'EXAMPLE_PURGE_ORG_BATCH_SIZE', 'EXAMPLE_PURGE_MAX_BATCHES', 'EXAMPLE_PURGE_ROWS_PER_JOB',
  'example.projects', 'example.project_count', 'example.projects.purge', 'example_projects_purged_total', 'example_project',
  'ExampleModule', 'ExampleCoreModule', 'ExampleHttpModule', 'ExampleWorkerModule', 'ExampleEvents', 'ExamplePermissions',
  'ExampleFeatures', 'ExampleErrors', 'ExampleMetrics', 'ExampleQueue', 'ExampleProjectsPurgeParticipant', 'exampleConfig',
  'ExampleConfig', 'EXAMPLE_PROJECT_NAME_MAX_LENGTH', 'EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH', 'EXAMPLE_PROJECT_AGGREGATE',
  'EXAMPLE_PURGE_ORDER', 'EXAMPLE_PURGE_ACTOR', './example.config.js', './example.module.js', '../example.config.js',
  'Migration<ts>_example_projects', 'src/plans.example.ts', 'src/migrations/example',
] as const;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe('EX-U9: every "example" token of the sample is a listed identifier (spec SP7 §1 criterion 2)', () => {
  it('scans src/features/example and src/migrations/example', () => {
    const allowed = new Set<string>(EXAMPLE_IDENTIFIERS);
    const unknown = ROOTS.flatMap(files).flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
        [...line.matchAll(TOKEN)].map((m) => m[0].replace(/[.,;:]+$/, '')).filter((t) => !allowed.has(t) && !/^Migration\d{14}_example_projects$/.test(t))
          .map((t) => `${f}:${i + 1} ${t}`),
      ),
    );
    expect(unknown).toEqual([]);
  });
  it('the README checklist names every identifier that a copy must rename', () => {
    const readme = readFileSync('docs/boilerplate/README.md', 'utf8');
    const section = readme.slice(readme.indexOf('## Tạo feature từ mẫu'), readme.indexOf('## Cách thêm'));
    for (const id of ['example_projects', 'example_orgs_with_purgeable_projects', 'example.project.*', 'example.projects.purge-org',
      'example.projects.purge-archived', 'example-purge', 'EXAMPLE_*', 'example.projects', 'example.project_count',
      'example_projects_purged_total', 'example_project', 'Example*'])
      expect(section, id).toContain(`\`${id}\``);
  });
});
```
Danh sách trên là điểm khởi đầu; khi Step 4 báo token chưa liệt kê, quyết định từng token: định danh thật phải đổi khi chép → thêm vào danh sách **và** vào README (Task 15); token viết cứng không cần (ví dụ tên trong chú thích) → sửa code/chú thích để không còn chứa chuỗi đó.

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/architecture/rules.spec.ts test/unit/features/example/identifiers.spec.ts`
Expected: FAIL (luật chưa có; token chưa liệt kê nếu có).

- [ ] **Step 3: Thêm luật depcruise + fixture; chỉnh danh sách/code tới khi EX-U9 xanh**

- [ ] **Step 4: Chạy**

Run: `pnpm vitest run --project unit test/unit/architecture test/unit/features/example && pnpm arch`
Expected: PASS; `pnpm arch` không vi phạm (mẫu chỉ import `index.ts` của `core/*`, `modules/tenancy`, `modules/entitlements`).

- [ ] **Step 5: Commit**
```bash
git add .dependency-cruiser.cjs test/architecture test/unit/architecture test/unit/features/example
git commit -m "build(arch): features import other features only through index.ts; EX-U9 identifier inventory of the sample"
```

---

## Phần G — Prod-like, tài liệu, bàn giao

### Task 14: Smoke trên image production — EX-S1, SM-1 "consume tới trần → 422" (từ 4B), override trên route `requireEnabled` (từ 4C); đo image (ADR 0013)

**Files:**
- Create: `test/smoke/features/example/example.smoke.spec.ts`
- Modify: `.upstream/zones.json` (`template` += `"test/smoke/features/example/"`; `project` += `"test/smoke/features/"`), `docs/upstream/CODEOWNERS.template` (hai dòng tương ứng, đúng thứ tự `codeowners-template.spec.ts` đòi), `test/smoke/smoke-app-env.ts` (`EXAMPLE_PURGE_CRON: '* * * * *'`), `test/smoke/entitlements.smoke.spec.ts` (D7-11), `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: `verifiedDevice`, `staffDevice`, `PASSWORD`, `Device.call` (`test/smoke/smoke-devices.ts`); `psql`, `logsSince`, `assertCleanLogs`, `workerHealth` (`test/smoke/smoke-support.ts`); route admin 4C `PUT|DELETE /v1/admin/orgs/:orgId/entitlements/overrides/:featureKey` (body `PutOverrideBody`: `{ enabled, reason, expiresAt }` hoặc `{ limit, reason, expiresAt }`; `DeleteOverrideBody { reason }`; `If-Match`).
- Produces: smoke của mẫu; mục "Số đo SP7 (7D)" ở ADR 0013.

- [ ] **Step 1: Sửa smoke boilerplate cho đúng ở cả hai cây (D7-11)**

`test/smoke/entitlements.smoke.spec.ts`:
- `:34` → `… FROM entitlement_features WHERE key IN ('files.storage_bytes', 'tenancy.seats')` (giữ kỳ vọng `'files.storage_bytes:LIMIT,tenancy.seats:LIMIT'`);
- `:66-89` → đọc `features`, lọc `BOILERPLATE_FEATURE_KEYS = ['files.storage_bytes', 'tenancy.seats']` rồi `toEqual` hai mục như cũ;
- `:173` → `expect(features.map((f) => f.key)).toEqual(expect.arrayContaining(BOILERPLATE_FEATURE_KEYS))`.
Chú thích một dòng: "Feature của dự án/vùng template có thể thêm key; smoke này chỉ khẳng định phần của boilerplate (UP-13)."

`smoke-app-env.ts`: thêm `EXAMPLE_PURGE_CRON: '* * * * *'` với chú thích "vùng template (7D EX-S1): env lạ bị bỏ qua khi `src/features/example` đã xoá".

- [ ] **Step 2: Viết smoke của mẫu**

```ts
describe('prod-like smoke: sample feature (plan 7D; SM-1 consume from 4B, override on a requireEnabled route from 4C)', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const mail = new Mailpit(mailpitApiUrl);
  const forbidden: string[] = [PASSWORD];
  const NAME = `Smoke Project ${randomUUID().slice(0, 8)}`;
  forbidden.push(NAME);

  it('the 7D migration ran from dist: FORCE RLS, the definer of sweep_definer, catalogue rows', () => {
    expect(psql(`SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_class WHERE relname = 'example_projects'`)).toBe('true:true');
    expect(psql(`SELECT pg_get_userbyid(proowner) || ':' || prosecdef::text FROM pg_proc WHERE proname = 'example_orgs_with_purgeable_projects'`)).toBe('sweep_definer:true');
    expect(psql(`SELECT string_agg(key || ':' || kind, ',' ORDER BY key) FROM entitlement_features WHERE key LIKE 'example.%'`)).toBe('example.project_count:QUOTA,example.projects:FLAG');
  });
  it('EX-S1: create → archive → retention cron → the project is gone, one RETENTION event, counter back to 0', async () => {
    // owner verifiedDevice; POST /v1/orgs; POST …/projects {name: NAME} 201; POST …/archive 200;
    // psql: UPDATE example_projects SET status_changed_at = now() - interval '31 days' WHERE public_id = '<id>';
    // poll GET …/projects/<id> tới 404 (hạn 150 s, bước 2 s; cron '* * * * *'); psql đếm outbox example.project.deleted reason RETENTION = 1;
    // usage_counters của org cho example.project_count: used = 0
  });
  it('SM-1 (from 4B): staff caps example.project_count at 2 with an override → two creates 201, the third 422 quota_exceeded (errors[0].code example.project_count); removing the override lets it pass', async () => {
    // staffDevice; GET /v1/admin/orgs/<id>/entitlements → ETag; PUT …/overrides/example.project_count {limit: 2, reason, expiresAt: null} If-Match;
    // 2 × POST 201; POST 422; DELETE override {reason} If-Match → 204; POST 201
  });
  it('override on a requireEnabled route (from 4C): enabled: false → POST/archive 403 feature_not_in_plan, GET 200; delete → POST 201', async () => {});
  it('api and worker healthy, logs clean of the project name and of error lines', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(logsSince(new Date(0).toISOString()), forbidden);
  });
});
```
(`reason` của override đẩy vào `forbidden` như smoke 4C; `workerHealth()` trả trạng thái healthcheck Docker, như `auth-email.smoke.spec.ts:342`.)

- [ ] **Step 3: Chạy prod-like**

Run: `pnpm test:smoke`
Expected: build image production thật; `docker compose --profile app` (`NODE_ENV=production`) migrate từ `dist` (gồm `…_example_projects`); mọi file smoke PASS (core, core-shared, auth-email, dashboard, composition, tenancy, entitlements đã sửa, integrations, `features/example`); `/health/ready` 200; `down -v` sạch.

- [ ] **Step 4: Đo image, ghi ADR 0013**

Run:
```bash
docker history --no-trunc --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
docker image inspect --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
```
Thêm "### Số đo SP7 (7D) (<ngày>)" sau "Số đo SP6 (6C)" của `docs/adr/0013-build-toolchain.md`: kích thước chưa nén, chênh so với 6C (mẫu không thêm dependency nên kỳ vọng chênh < 1 MB), mốc trần 400 MB.

- [ ] **Step 5: Kiểm vùng, commit**

Run: `pnpm vitest run --project unit test/unit/upstream && pnpm upstream:check --self`
Expected: PASS (UP-9: file mới đều có vùng; CODEOWNERS.template khớp `zones.json`).
```bash
git add test/smoke .upstream/zones.json docs/upstream/CODEOWNERS.template docs/adr/0013-build-toolchain.md
git commit -m "test(smoke): sample feature on the production image, quota consume to 422 and a plan-gate override; image size in ADR 0013"
```

### Task 15: Tài liệu — README "Tạo feature từ mẫu", ADR 0012, sửa spec

**Files:**
- Modify: `docs/boilerplate/README.md` (mục "Tạo feature từ mẫu" dòng 257-269, "Tính năng theo gói" dòng 757+, "Route idempotent" dòng 864+), `docs/adr/0012-two-pagination-modes.md` (mục "Cursor"), `docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md` (thêm "## 26b. Sửa theo plan 7D")

- [ ] **Step 1: README**

- "Tạo feature từ mẫu": bước 2 đồng bộ đúng tập EX-U9 (thêm mã lỗi đủ ba, key `EXAMPLE_*` của lỗi theo D7-2, tên provider/module); thêm ba dòng: (a) "id sai định dạng → `404` (`projectIdOrNotFound`)"; (b) "list dùng cursor một khoá duy nhất `public_id DESC`; khoá sort không duy nhất → cursor hai khoá như delivery của integrations"; (c) "nhiều quota trong một transaction: tiêu theo thứ tự key tăng dần, sau mọi khoá dòng nghiệp vụ (S7-D35)"; thêm "bảng có bảng con phải thêm `UNIQUE (org_id, id)` + FK kép (ADR 0005)"; thêm "smoke của feature ở `test/smoke/features/<f>/`".
- "Tính năng theo gói": một đoạn trỏ tới mẫu (`ExampleFeatures`, `requireEnabled`, `consumeOrThrow` sau `INSERT`, `releaseAllocation` sau `DELETE … RETURNING`).

- [ ] **Step 2: ADR 0012**

Mục "Cursor" thêm đoạn: "Repository SQL thô (mọi module hiện có) dùng keyset tự viết: một khoá duy nhất khi có (mẫu `example`, `public_id` UUIDv7), hai khoá khi không (delivery 6C, `(created_at, public_id)`); cursor mờ base64url, kiểm hình dạng bằng zod trước SQL → `400 invalid_cursor`. `findByCursor` của MikroORM chỉ dùng với entity (fixture)." Sửa câu "Không tự viết keyset khi MikroORM đã có" thành "…khi repository dùng entity MikroORM".

- [ ] **Step 3: Spec SP7 mục 26b**

Bảng D7-1…D7-15 (phán quyết, lý do, mục đổi: §7.1 index, §8.1, §9.1, §9.4, §10.4 `no_projects`, §19 EX-E2/EX-I9/EX-I10/EX-I11/EX-I13, §6.1 vùng `test/smoke/features/example/`).

- [ ] **Step 4: Kiểm**

Run: `pnpm vitest run --project unit test/unit/features/example/identifiers.spec.ts && pnpm lint`
Expected: PASS (README có đủ định danh; prettier sạch).

- [ ] **Step 5: Commit**
```bash
git add docs/boilerplate/README.md docs/adr/0012-two-pagination-modes.md docs/superpowers/specs/2026-09-28-sp7-sample-helm-runbook-design.md
git commit -m "docs(example): copy-the-sample checklist, raw-SQL keyset cursors in ADR 0012, spec amendments from plan 7D"
```

### Task 16: Kiểm toàn bộ — dừng ở "sẵn sàng mở PR"

- [ ] **Step 1: Pipeline đầy đủ**

Run lần lượt, đọc output từng lệnh:
```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm arch
pnpm test
pnpm test:int
pnpm test:chaos
pnpm test:upgrade
pnpm env:example && git diff --exit-code .env.example
pnpm build && pnpm openapi:export && git diff --exit-code openapi.json
pnpm upstream:check --self
pnpm test:smoke
```
Expected: mọi lệnh exit 0; `git diff --exit-code` sạch; migration up → down → up + sweep S2-R57 xanh trong `test:int` (`test/integration/core/database/migrations.spec.ts` chạy mọi migration gồm `…_example_projects`).

- [ ] **Step 2: UP-13 cục bộ — cây đã xoá vùng template**

Trên một bản sao tạm của nhánh (`git worktree add <scratchpad>/up13 HEAD`), chạy `pnpm upstream:init --team-core @core --team-app @app` (không commit), rồi `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm test:int`. Expected: xanh (không file boilerplate nào nhắc tới `features/example`; `rls-catalog`, `migration-scan`, smoke entitlements đúng khi không có inventory/dòng của mẫu). Xoá worktree tạm.

- [ ] **Step 3: Thứ tự migration**

Run: `git fetch origin && git log origin/main --name-only --format= -- src/migrations | sort -u | tail -3`
Expected: timestamp của `…_example_projects` lớn hơn mọi migration vùng boilerplate/template trên `origin/main`; nếu 6A/6B đã merge với timestamp lớn hơn: tạo lại file bằng `migration:create` (đổi tên lớp + `name`), commit mới.

- [ ] **Step 4: Ghi trạng thái**

Nhánh `sp7d-sample-feature` sẵn sàng mở PR. Mô tả PR (controller dùng): nội dung theo task, lệnh kiểm và kết quả thật, số đo image (ADR 0013), D7-1…D7-15, các test boilerplate đã sửa (D7-11), vùng mới `test/smoke/features/example/`. Không push, không mở PR trong plan này.

---

## Kết quả spike

(Task 1 Step 4 điền: S1 bốn câu EXPLAIN; S2; S3.)

---

## Tự review

### 1. Độ phủ spec

| Mục spec | Task |
|---|---|
| §1 tiêu chí 1 (đi hết đường; `limit + k` → đúng `limit`; bộ đếm = số dòng) | 4, 6, 7, 8, 9, 10, 14 |
| §1 tiêu chí 2 (chép được, EX-U9) | 13, 15 |
| §6.3.1 bố cục, hướng phụ thuộc, vị trí provider | 6, 7, 9, 13 |
| §6.3.2 luồng tạo (insert → consume → publish) | 6, 7 |
| §6.3.3 checklist chép | 15 (README), 13 (EX-U9) |
| §6.5 hàng `rls-catalog` (7D), `.dependency-cruiser.cjs` (7D) | 5, 13 |
| §7.1 bảng, index, RLS, grant | 4 (D7-1 bỏ `list_idx`) |
| §7.1 "EXPLAIN bốn câu", §5 T7-5 | 1 |
| §7.2 dòng quyền + `entitlement_features` | 3, 4 |
| §7.3 hàm definer `(p_after, p_limit, p_retention_sec)` | 4, 9 (EX-I15) |
| §7.4 câu xoá job, xoá tay | 6, 9 |
| §7.5 migration, khoá, down 6 bước | 4 |
| §7.6 chuẩn hoá (BCNF) | 4 (chú thích), 5 (inventory) |
| §8.1 state machine | 2, 6 |
| §9.1 route (D7-1 cursor, D7-3 404) | 7 |
| §9.2 resource, ETag, Location | 7 |
| §9.3 schema | 2 |
| §9.4 mã lỗi (D7-2) | 2 |
| §10.1 năm event, cờ R-X3, version xoá = +1 | 3, 6, 9, 11 |
| §10.2 queue, job, `defineOrgSweep`, handler mỏng, jobId slot | 3, 9 |
| §10.3 participant order 200 | 9, 10 |
| §10.4 API SP4, bảo đảm 1–4, catalogue gói fixture | 6, 8, 14 |
| §11.1 config | 3 |
| §15 kẻ tấn công trong phạm vi (mẫu), không PII | 7, 10, 11, 12 |
| §16 R7-1…R7-9, R7-18 | 8 (R7-1), 7 (R7-2, R7-3), 10 (R7-4…R7-8, R7-18), 9 (R7-9) |
| §18 metric `example_projects_purged_total`, log backlog của helper | 9, 12 |
| §19 EX-U1…U4, U9 | 2, 3, 13 |
| §19 EX-I1…I15 | 4 (I1–3, I7, I8, I13), 5 (I4, I5), 6 (I14), 9 (I6, I12, I15), 10 (I6b, I9–I11) |
| §19 EX-E1…E11 | 7 (E1–E6), 8 (E7, E8), 11 (E9, E11), 9 (E10) |
| §19 EX-S1 | 14 |
| §20 hàng 7D: `src/plans.example.ts` vào vùng template | đã có trên `main` (4A, R-X20 `examplePlans`); 7D không đổi nội dung (catalogue gói không được nhắc key của mẫu, vì `validatePlanCatalogue` sẽ từ chối sau `upstream:init`) |
| Carry 4B: SM-1 consume → 422 trên image | 14 |
| Carry 4C: override trên route `requireEnabled` | 14 |
| Carry: EX-E9 với org API key và support grant | 11 |
| Brief: ADR 0013 kích thước image | 14 |

### 2. Quét placeholder

Không "TBD/TODO/tương tự Task N" ở bước code. Chỗ cố ý để thực thi điền: mục "Kết quả spike" (Task 1 ghi số đo thật); timestamp migration (CLI sinh); vài thân test viết dạng chú thích từng bước (Task 6, 7, 9, 10, 11, 12, 14) — mỗi chú thích nêu đúng dữ liệu seed, hành động, khẳng định; implementer viết thân theo đó.

### 3. Nhất quán kiểu

`ProjectRow`, `DeletedProject` (Task 6) dùng ở 7, 9; `ProjectRepository.deleteDue(orgId, retentionSec, limit)` khớp câu 7.4 và Task 9; `EXAMPLE_PURGE_ORDER`, `EXAMPLE_PURGE_ACTOR`, `EXAMPLE_PROJECT_AGGREGATE` (Task 2) dùng ở 6, 9; `ExampleFeatures.key('example.project_count')` ở 6, 9; `startExampleApp`, `exampleTestPlans` (+ `tight`, Task 8), `projectsUrl`, `projectRowsOf`, `disposeExampleOrg` (Task 6) dùng ở 7–12; tên lớp tenancy `PurgeOrgHandler` trùng tên lớp của mẫu → test import bản tenancy với alias `TenancyPurgeOrgHandler`.

### 4. Review Focus → test

| Review Focus | Test |
|---|---|
| 1 cursor sửa tay | Task 2 `project cursor` (unit), Task 7 `cursor tampering` (HTTP) |
| 2 tên trùng hoa thường/khoảng trắng | Task 7 `EX-E4 / R7-2` |
| 3 hạ gói / override giữa chừng | Task 8 `over-limit org still deletes`, `EX-E8` override |
| 4 replay archive sau delete | Task 7 `archive replay after delete` |
| 5 job xoá không còn dòng đến hạn | Task 9 `purge with nothing due` |

### 5. Điểm yếu nhất và cách kiểm

Giả định yếu nhất: câu definer `DISTINCT … ORDER BY org_id LIMIT` trên index partial đạt < 20 ms ở 10.000 org (T7-5). Kiểm bằng Task 1 trước mọi code; fallback recursive CTE đã định nghĩa. Giả định yếu thứ hai: instrumentation `pg` hook được `pg` mà knex nạp trong Vitest ESM (S2) — fallback process thật + OTLP.

## Phụ thuộc thật và xung đột dự kiến

- **Cần đã merge:** 7A (composition, vùng template, `upstream:init`), 4A/4B/4C (`defineFeatureCatalogue`, `requireEnabled`, `Quotas`, override admin cho smoke), 3D (org API key, support grant, `order < 1000`), 6.0 (`sweep_definer`, `defineOrgSweep`, `DEFINER_LIMIT_MAX`, cờ event), 6C (mẫu migration/controller để chép). Không cần 6A, 6B, 7B.
- **6A (files):** cùng sửa `test/support/core-catalog.ts` (mảng `SWEEP_DEFINER_*` nếu files có hàm quét), `test/integration/core/database/rls-catalog.spec.ts` (`GLOBAL_TABLES`), `test/smoke/entitlements.smoke.spec.ts` (ST-1…ST-4 đụng đúng ba khẳng định 7D viết lại), `.env.example`, `openapi.json`, `docs/boilerplate/README.md`, `docs/adr/0013-build-toolchain.md`, `.upstream/zones.json`/`CODEOWNERS.template` (nếu 6A thêm vùng); thứ tự migration (bên merge sau tạo lại timestamp). Giải: giữ cả hai phía; khẳng định smoke theo kiểu "lọc theo key của boilerplate" của 7D.
- **6B (audit/admin):** audit nhận năm event `audit: true` của mẫu qua `AUDITED_EVENTS`; nếu 6B đòi metadata audit riêng cho mọi event audited (bảng ánh xạ, test liệt kê), plan merge sau thêm năm dòng của mẫu. Cùng sửa `README`, `ADR 0013`, `.env.example`, `openapi.json`, có thể `test/support/tenancy-app.ts` (module catalogue test). Inventory route admin của 6B không chạm route tenant của mẫu.
- **7B (Helm + core deploy):** `deploy/values/example.yaml` là của 7B (vùng template, 7D không tạo); cùng sửa `test/support/core-catalog.ts` (draft 7B có), `test/smoke/smoke.global-setup.ts`/`smoke-app-env.ts` (7D thêm một env), `.env.example` (7B thêm `WORKER_QUEUES_EXCLUDE`, nhãn secret), `package.json` (7B thêm script), `docs/boilerplate/README.md`, `ADR 0013`. Queue `example` của mẫu được nhóm worker `default` consume nhờ `WORKER_QUEUES_EXCLUDE` (7B), HC-25 thấy nó qua `queueRegistry()`; config mẫu không có secret nên `chart:secrets` không đổi.
