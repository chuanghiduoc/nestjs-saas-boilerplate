# Sub-project 6 — Plan 6.0: nền dùng chung (core) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship toàn bộ phần dùng chung mà spec SP6 giao cho plan 6.0 — cờ `audit`/`webhook` bắt buộc trên `defineEvent` và subscriber theo bộ chọn, body parser nhiều chủ, `routeTemplateOf` và hằng quét ở core, hợp đồng `core/contracts/admin-readers.ts`, `OrgMutationLock` của tenancy, kill switch trong DB qua OpenFeature, hai role NOLOGIN `partition_owner`/`sweep_definer`, helper quét xuyên org `defineOrgSweep` + `OrgSweepRunner`, hạ tầng partition theo tháng — chứng minh trên Postgres 18 + PgBouncer + Redis thật và trên image production qua `docker compose --profile app` với `NODE_ENV=production`; 6.0 ship một mình với CI xanh, trước 6A/6B/6C/6D.

**Architecture:** Mọi thứ nằm ở `src/core` (thư mục mới `flags/`, `partitions/`, `sweep/`, `contracts/`) cộng ba chỗ sửa nhỏ ở module đã có: `identity` (marker body parser), `tenancy` (`OrgMutationLock`, `routeTemplateOf` và hai hằng chuyển sang core, cờ của 8 event 3A), `notifications` (cờ event). Registry lúc import theo mẫu `defineJob`/`defineCron` (`defineKillSwitch`, `defineOrgSweep`, `definePartitionedTable`); quét Discovery theo mẫu `@JobHandler`/`@EventSubscriber` (`@BodyParserOwner`, subscriber bộ chọn). Hàm SQL quét xuyên org và hàm bảo trì partition do module sở hữu, viết thẳng trong migration dưới `SET LOCAL ROLE <role NOLOGIN>`; core chỉ gọi chúng qua `EXECUTE` của `app_user` (runner là nơi duy nhất gọi hàm quét, ký hiệu tham số theo tên, ép kiểu tường minh). Kill switch: bảng global `kill_switches`, provider OpenFeature giữ snapshot trong bộ nhớ, làm mới định kỳ, fail-static khi DB lỗi. 6.0 chưa khai kill switch, bảng partitioned hay sweep thật nào: hành vi được chứng minh trên fixture của test.

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), BullMQ (`JobQueue`, `WorkerHost`), `@openfeature/server-sdk` 1.23.0 + peer `@openfeature/core` 1.12.0 (package mới duy nhất), zod 4.6.5, `@opentelemetry/api` 1.9.1, Vitest + Testcontainers, `tcp-proxy.ts` (chaos), Docker Compose smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-sp6-files-audit-integrations-admin-design.md` (r2, đã chốt 2026-09-29; §17 Bảng 0–5 dòng "6.0" là nguồn phạm vi của plan này). Kèm theo, cùng ràng buộc: `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` (R-X3, R-X4, R-X7, R-X14, R-X16), SP3 r8 `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, addendum 3D `docs/superpowers/specs/2026-09-28-sp3-addendum-platform-staff.md` (§A3: 3D dùng `routeTemplateOf` của `core/http` do 6.0 chuyển), spec cha `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`. Mẫu định dạng: `docs/superpowers/plans/2026-09-28-sp3a-tenancy-foundation.md`.

**Phụ thuộc thật (R-X7, spec §17 Bảng 0):** chỉ **3A** (đã merge vào `main` trước khi plan này chạy). Tên của 3A mà plan dùng: `tenancy/constants.ts` (`DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START`), `tenancy/http/org-route.ts` (`routeTemplateOf`, `normalizeTemplate`, Task 21 của 3A), `tenancy/events.ts` (8 event, Task 19), `OrgRepository.lockCurrent()` + `TenancyCoreModule` (Task 19–20), `test/support/tenancy-seed.ts` (`seedOrg`, `withAppClient`, `inOrgTx`), `test/support/tenancy-core-app.ts` (`tenancyCoreImports`), `test/support/scratch-db.ts` (`createScratchDb`), `test/support/tenancy-catalog.ts`, bảng `organizations`, `fixture_org_items`. Chạy song song trong sóng W2: 3B, 4A, 7A (xem Task 16 Step 2 về event của plan merge trước).

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2, 3A (Global Constraints của `2026-09-28-sp3a-tenancy-foundation.md`), cộng luật của SP6 (spec §3, bắt buộc cho mọi task):

- **Package-first:** chỉ cài `@openfeature/server-sdk` và peer `@openfeature/core` (`pnpm add @openfeature/server-sdk @openfeature/core`, không ghi version; mong đợi `1.23.0` và `1.12.0`, phát hành 2026-07-28, qua `minimumReleaseAge`). Không cài `@openfeature/nestjs-sdk` (chưa hỗ trợ Nest 12), `pg_partman` (không có trong image Postgres chính thức, S6-A20), thư viện canonicalize hay scheduler nào khác. Version khác thì dừng, đọc changelog, cập nhật spec, báo Sếp (quy ước SP3 §3.1).
- **Generator:** `pnpm exec mikro-orm migration:create --blank --path <dir> --name <tên>` cho migration (`src/migrations/core`, `test/fixtures/migrations`); tên file do CLI sinh (`Migration<14 chữ số>_<tên>`), plan viết `Migration<ts>_<tên>`, code và test không viết cứng timestamp. Khung Nest viết tay theo mẫu core (core không dùng `nest g`).
- **Không đoán API:** OpenFeature theo `.d.ts`/`dist/esm` của tarball đã đọc khi viết plan: `OpenFeature.setProviderAndWait(domain, provider)` (reject khi `initialize` reject), `OpenFeature.getClient(domain)`, `client.getBooleanValue(key, default)`, `client.providerStatus`, `ProviderStatus.READY`, `NOOP_PROVIDER` (thay provider của một domain gọi `onClose` của provider cũ), `OpenFeature.close()` (gọi `onClose` mọi provider), `OpenFeature.setLogger`, `StandardResolutionReasons`, `TypeMismatchError`; `Provider` phải cài đủ bốn `resolve*Evaluation` trả `Promise`. Spike P3 giữ các điều này thành test hợp đồng. TDD, không `any`, không tắt lint, không `as never`.
- **Hai role NOLOGIN mới** (spec §3.2 luật 1) trong `docker/postgres/init/01-roles.sh`: `partition_owner` (sở hữu mọi bảng partitioned + hàm bảo trì) và `sweep_definer` (sở hữu **mọi** hàm `SECURITY DEFINER` "quét xuyên org, trả `org_id` đến hạn" của mọi SP, R-X4). Cả hai `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, `GRANT USAGE, CREATE ON SCHEMA public`, `GRANT <role> TO app_owner WITH INHERIT FALSE, SET TRUE`. `tenancy_definer` giữ nguyên, chỉ cho tenancy.
- **Hàm của hai role** (spec §3.2 luật 2): `SECURITY DEFINER SET search_path = ''`, tên bảng đủ `public.`, `REVOKE ALL … FROM PUBLIC` rồi `GRANT EXECUTE … TO app_user` (mặc định của `01-roles.sh` chỉ thu `EXECUTE` hàm do `app_owner` tạo); tham số `NULL`/ngoài biên → `RAISE`; hàm quét `STABLE`, `p_limit ∈ [1, DEFINER_LIMIT_MAX = 1000]`, chỉ trả `org_id`; hàm bảo trì partition `VOLATILE`, sàn retention cứng trong thân hàm, `pg_try_advisory_xact_lock(<lockKey>)`, `lock_timeout` 5 s, mốc tháng theo **UTC**. Mọi DDL tạo/xoá hàm, bảng partitioned của hai role nằm giữa `SET LOCAL ROLE <role>` và `RESET ROLE` (quét tĩnh ép qua `NOLOGIN_OWNER_ROLES`). Policy đọc cho `sweep_definer` tên `<bảng>_definer_read … FOR SELECT TO sweep_definer USING (true)`, grant chỉ theo cột. Migration dùng role → khối `DO` `RAISE` khi role chưa có.
- **Hợp đồng quét (R-X14, chữ ký SP6 là chuẩn):** `defineOrgSweep({ key, definerFunction, extraParams?, orgJob, jobIdPrefix, schedule, batch })`; hàm SQL chữ ký cố định `(p_after uuid, p_limit integer, <tham số thêm>)`, `RETURNS TABLE (org_id uuid)`, đúng **một** overload; runner gọi `public.<fn>(p_after => ?::uuid, p_limit => ?::integer, p_x => ?::<kiểu>)` với `number → integer` (32-bit), `boolean → boolean`, `string → text`; khoảng thời gian truyền bằng số nguyên giây. Không callback TS. `jobId = <jobIdPrefix>-<orgId>-<slot>`, `slot = floor(epochSec / minGapSec(cron, tz))`.
- **Partition:** `PARTITION BY RANGE` theo tháng, PK gồm cột partition, policy/grant/index/trigger khai trên **bảng cha**, partition không có grant nào, tên `<bảng>_pYYYYMM`; drop khi toàn bộ tháng cũ hơn N tháng tính từ đầu tháng UTC hiện tại (giữ N tới N+1 tháng). Cron `core.partitions.maintain` (`PARTITIONS_MAINTAIN_CRON` = `30 0 * * *`, `PARTITIONS_MAINTAIN_TZ` = `UTC`), queue `maintenance`.
- **Kill switch:** bảng global `kill_switches` đúng spec §6.2; `FLAGS_REFRESH_INTERVAL_MS` mặc định `5000`, ràng buộc `1000–60000`; không có dòng → `false`; DB lỗi khi làm mới → giữ snapshot (fail-static); lần nạp đầu lỗi → app không khởi động. Registry rỗng ở 6.0 (6A khai `files.uploads`, 6C khai `integrations.webhook_delivery`).
- **Event:** `defineEvent` đòi `audit: boolean` và `webhook: boolean`, không mặc định (R-X3); `webhook: true` chỉ cho event theo org. Giá trị cuối cho event đang có (spec §5.3, §8.3): `identity.user.registered` `(true, false)`; `notifications.delivery.failed` `(false, false)`; 8 event `tenancy.*` của 3A `audit: true`, `webhook: true` đúng sáu event `tenancy.member.added`, `.member.removed`, `.member.role_changed`, `tenancy.org.updated`, `.org.deleted`, `.org.restored`.
- **Bất biến nằm ở DB; mọi race có tên và cơ chế** (bảng race cuối plan). Check-then-insert không bao giờ là cơ chế. Không I/O ngoài (Redis, HTTP, S3) bên trong `UnitOfWork.run` (spec §3.2 luật 3): runner quét gọi hàm SQL ngoài transaction rồi mới enqueue.
- **Migration:** SQL bằng `addSql`, `down` đối xứng đã test (up → down → up và sweep S2-R57 trên database riêng qua `migrations.spec.ts` sẵn có), không `isTransactional()`, không `SET CONSTRAINTS ALL`, timestamp mới hơn migration mới nhất trên `main` (`migration-order.spec.ts`); chú thích đầu file chép bảng chuẩn hoá spec §6.9 (≥ 3NF, `kill_switches` BCNF) và lý do mỗi index.
- **Không hard code:** cron, khoảng làm mới, batch lấy từ config (`defineConfig` + zod + `.describe()`); hằng định dạng có tên (`DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START`, `KILL_SWITCH_KEY`, `NO_ROW_VERSION`). `test/unit/architecture/hardcode-scan.spec.ts` xanh.
- **Fail loud:** sweep/định nghĩa sai → `OrgSweepDefinitionError`; prefix body parser trùng/lồng, kill switch không đăng ký, event định nghĩa sau khi registry subscriber đã dựng, hàm quét trả org không tăng dần → ném lỗi có tên; không lỗi nào bị nuốt.
- **Luật kiến trúc** (`.dependency-cruiser.cjs`, số theo spec §5.4, mỗi luật có fixture phải fail): thêm 22 (`@openfeature/*` chỉ trong `src/core/flags/**`), 23 (`modules/{identity,tenancy,notifications}/**` không import `modules/{files,audit,integrations,admin}/**`), 27 (`src/core/contracts/**` chỉ có import kiểu). Luật 20, 21, 24, 25, 26 thuộc plan tạo module tương ứng (6A–6D).
- **Không PII** trong log/metric/span: label metric chỉ là `key` của sweep/switch, tên bảng, `action`; không `orgId` làm label.
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** cuối mỗi nhóm (Task 7 core/http/tenancy, Task 9 kill switch, Task 12 sweep + partition, Task 14 cuối) chạy `pnpm test:smoke`: build image production thật, `docker compose --profile app` với `NODE_ENV=production`, TLS, PgBouncer, migrate từ `dist`, smoke HTTP/psql trong `test/smoke/`, log container là JSON, không `error`, `/health/ready` 200, `down -v` sạch. Image ≤ 400 MB chưa nén, số đo ghi ADR 0013.
- **ADR:** số mới duy nhất của SP6 là **0020** (R-X6); 6.0 tạo file với mục "Kết quả spike (plan 6.0)"; cập nhật 0005, 0006, 0007, 0013.
- **Spike:** code spike là code bỏ đi (`test/integration/spike-sp6-0/`, không commit) trừ phần ghi "được giữ"; kết quả ghi ADR 0020. Spike không đạt → đi đúng fallback spec §4; P3 không có fallback package → dừng và báo Sếp.
- **Định dạng và commit:** trước mỗi commit `pnpm exec prettier --write <file đã đổi ngoài docs/>`; mỗi task một commit trở lên, conventional message tiếng Anh; push và PR chỉ ở Task 16.

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không test nào của spec phủ, dễ làm hỏng hệ thống nhất:

1. **Prefix body parser trùng theo hoa thường hoặc chỉ trùng chuỗi con** (`/Uploads` và `/uploads`; `/api/auth` và `/api/authx`). Router Express không phân biệt hoa thường, nên hai chủ `/Uploads`, `/uploads` thực chất tranh cùng byte; còn `/api/authx` không nằm dưới `/api/auth` theo segment. Mong đợi: cặp đầu → app không khởi động (lỗi nêu cả hai chủ); cặp sau khởi động được và mỗi path thuộc đúng chủ của nó (`/api/authx/y` không bị coi là của chủ `/api/auth`). Test: Task 6 (`prefixes that differ only by case overlap`, `a sibling prefix that only shares characters does not overlap`).
2. **Hàm quét của một module trả org không tăng dần, trùng lặp, hoặc nhiều hơn `p_limit`** (hàm SQL viết sai `ORDER BY`/`DISTINCT`). Con trỏ keyset của runner khi đó bỏ sót org hoặc lặp vô hạn. Mong đợi: `OrgSweepDefinitionError` nêu tên hàm, không enqueue phần còn lại. Test: Task 11 (`rejects rows that are not strictly ascending after the cursor`, `rejects more rows than p_limit`).
3. **`extraParams` trả số ngoài int4, số thực, `NaN`/`Infinity` hoặc giá trị không phải primitive** (vd. `p_retention_sec` tính từ config quá lớn). Nếu không chặn, Postgres trả `22003 integer out of range` ở mọi lượt cron. Mong đợi: `OrgSweepDefinitionError` trước câu SQL, không gọi DB. Test: Task 11 (`rejects extra parameters that are not 32-bit integers, booleans or strings`).
4. **Session Postgres có `TimeZone` khác UTC** khi hàm bảo trì chạy (DB đặt `timezone = 'Asia/Ho_Chi_Minh'`, hay một pool đặt `SET TimeZone`). `date_trunc('month', now())` theo giờ session sẽ tạo biên partition lệch 7–14 giờ và đặt tên tháng sai. Mong đợi: biên luôn là 00:00 UTC ngày 1, tên `_pYYYYMM` theo tháng UTC, bất kể `TimeZone`. Test: Task 12 (`partition bounds are UTC month bounds whatever the session TimeZone`).
5. **Kill switch khi DB không trả lời lúc khởi động, hoặc được hỏi trước khi provider sẵn sàng**. Không có snapshot nào để giữ; nếu SDK trả mặc định `false` thì mọi switch "tắt" âm thầm đúng lúc hệ thống đang lỗi. Mong đợi: lần nạp đầu lỗi → `setProviderAndWait` reject → app không khởi động; `isKilled` khi provider chưa `READY` (hoặc sau khi tắt) → ném, không trả `false`. Test: Task 9 (`initialize fails loud when the first load fails, and schedules nothing`, `isKilled throws once the app is closed instead of answering false`).

---

## File Structure

```
src/
  app-api.module.ts                 + FlagsModule
  app-worker.module.ts              + FlagsModule, SweepModule, PartitionsModule
  core/
    config/all-configs.ts           + flags.config, partitions.config
    contracts/  admin-readers.ts (FileUsageReader, WebhookStatsReader — abstract class làm token, R-X16)
    events/     event-definition.ts (+ audit, webhook bắt buộc) · subscriber.decorator.ts (+ EventSelector,
                AUDITED_EVENTS, WEBHOOK_EVENTS) · event-dispatch.handlers.ts (registry + deliver theo bộ chọn)
                event-publisher.ts (webhook ⇒ có org) · index.ts
    flags/      kill-switch.ts · db-kill-switch.provider.ts · kill-switches.service.ts · flags.config.ts
                flags.module.ts · index.ts
    http/       body-parser-policy.ts (@BodyParserOwner, nhiều chủ) · json-body-parser.ts (skipPathPrefixes, requestPath)
                content-type.middleware.ts (contentTypes theo prefix) · http-bootstrap.ts · http.module.ts
                route-template.ts (routeTemplateOf, normalizeTemplate — chuyển từ tenancy) · index.ts
    partitions/ partitioned-table.ts · partitions.config.ts · partitions.jobs.ts · maintain-partitions.handler.ts
                partitions.metrics.ts · partitions.module.ts · index.ts
    sweep/      constants.ts (DEFINER_LIMIT_MAX, PURGE_CURSOR_START — chuyển từ tenancy) · org-sweep.ts
                org-sweep.runner.ts · sweep.module.ts · index.ts
  migrations/core/Migration<ts>_kill_switches.ts
  modules/identity/infra/better-auth/  body-parser-owner.ts (mới) · better-auth-api.module.ts · events.ts (cờ)
  modules/notifications/events.ts   (cờ)
  modules/tenancy/  constants.ts (re-export) · events.ts (cờ) · http/org-route.ts (re-export) · index.ts
                    ports/org-mutation-lock.ts · application/org-mutation-lock.service.ts · tenancy.module.ts
docker/postgres/init/01-roles.sh    + partition_owner, sweep_definer
.dependency-cruiser.cjs             luật 22, 23, 27 (+ ngoại lệ no-orphans tạm cho admin-readers.ts)
renovate.json                       nhóm openfeature
test/
  support/  core-catalog.ts (mới: NOLOGIN_OWNER_ROLES, hằng fixture sweep/partition) · org-sweep-signatures.ts (mới)
  fixtures/migrations/Migration<ts>_fixture_core_shared.ts (fixture_sweep_items + fixture_orgs_due;
            fixture_part_events + fixture_part_events_maintain + trigger append-only)
  architecture/fixtures/src/        fixture phải fail của luật 22, 23, 27
  unit/     core/events/* · core/http/route-template.spec.ts · core/http/body-parser-policy.spec.ts · core/contracts/*
            core/flags/* · core/sweep/* · core/partitions/* · migrations/migration-scan.spec.ts
  integration/ core/events/selector-subscriber.spec.ts · core/flags/* · core/sweep/* · core/partitions/*
            core/database/rls-catalog.spec.ts · core/database/normalization-inventory.spec.ts
            tenancy/org-mutation-lock.spec.ts
  e2e/core/body-parser-ownership.e2e.spec.ts (sửa)
  chaos/core-shared-outages.spec.ts
  smoke/core-shared.smoke.spec.ts
docs/adr/ 0020 (mới) · 0005 · 0006 · 0007 · 0013
docs/superpowers/specs/ spec cha (§4, §4.1, §6, §13.1), SP2 (§5.5), SP3 (§7.4, §6.14, §14, §18.1) — dòng "Cập nhật"
README.md
```

**Vì sao `extraParams` và `batch` là thunk, prefix body parser cũng là thunk:** registry chạy lúc import, trước khi config được validate (`defineConfig` chỉ đăng ký namespace lúc import, `define-config.ts:47`); đọc config lúc đó sẽ ném hoặc lấy giá trị sai. Cùng lý do với `defineCron({ schedule: () => … })` sẵn có.

**Vì sao `KillSwitches` có `list()` và `set` nhận `expectedVersion = 0` cho "chưa có dòng":** spec §5.3 chỉ ghi `isKilled`/`set`, nhưng route admin của 6D cần đọc trạng thái + ETag. Đặt `list()` ở 6.0 để 6D không phải sửa `core/flags` (mục tiêu của 6.0: các plan sau không sửa chung đối tượng). `version` của DB có `CHECK (version >= 1)`, nên `0` là giá trị canh gác không va chạm.

**Vì sao `tenancy/constants.ts` re-export từ `core/sweep/constants.ts` (file lá), không từ `core/sweep/index.ts`:** `constants.ts` được `domain/` của tenancy import; index của `core/sweep` kéo theo runner (queue, DB). Giữ `domain/` không phụ thuộc bắc cầu vào hạ tầng.

---

## Phần A — Spike (bắt buộc làm trước mọi task khác, spec §4)

Plan 6.0 chạy P1–P3. Mỗi spike trả lời đúng một câu hỏi ở spec §4 bằng code chạy thật; kết quả (đạt/không đạt + bằng chứng) ghi vào ADR 0020 mục "Kết quả spike (plan 6.0)" và được commit. P1, P2 dùng database riêng (`createScratchDb` của 3A), code ở `test/integration/spike-sp6-0/`, **không commit**; P3 được giữ làm test hợp đồng.

### Task 1: Role `partition_owner`, `sweep_definer`; ma trận role của catalog (C-6 phần e); spike P1, P2 trên database riêng; khung ADR 0020

**Files:**
- Modify (được giữ): `docker/postgres/init/01-roles.sh`, `test/integration/core/database/rls-catalog.spec.ts`
- Create (được giữ): `docs/adr/0020-files-audit-webhooks.md`
- Throwaway: `test/integration/spike-sp6-0/partition-spikes.spec.ts`

**Interfaces:**
- Consumes: `createScratchDb(prefix)` (`test/support/scratch-db.ts`, 3A Task 2), `runMigrations`, `coreMigrationList()`, `applyTestEnv()`, `seedOrg({ database })`, `withAppClient(fn, database)`, `inOrgTx(c, orgId, fn)` (`test/support/tenancy-seed.ts`, 3A Task 14).
- Produces:
  - role `partition_owner`, `sweep_definer` (`NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, `USAGE, CREATE ON SCHEMA public`, `app_owner` là member `INHERIT FALSE, SET TRUE`) — mọi task sau.
  - `rls-catalog.spec.ts`: ca role cho cả ba role NOLOGIN, `EXPECTED_PRIVS` có hai role mới.
  - ADR 0020 với bảng "Kết quả spike (plan 6.0)": dòng P1, P2 điền ở task này, P3 ở Task 2.
  - Kết luận P1 dùng ở Task 10, 12 và plan 6B/6C: `CREATE TABLE … (LIKE parent INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` + `ATTACH PARTITION`; `partition_owner` cần `GRANT REFERENCES (id) ON organizations` để sở hữu bảng có FK tới `organizations` (6C mang grant đó).

- [ ] **Step 1: Catalog role (viết trước, fail vì role chưa có)**

(Nội dung ở Step 3 dưới đây; viết nó trước khi sửa script.) Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts`
Expected: FAIL ở `… all seven roles exist`, hai ca `it.each` của `partition_owner`/`sweep_definer` (không có dòng) và `matches the expected matrix…` (role không tồn tại → `has_schema_privilege` báo `role "partition_owner" does not exist`).

- [ ] **Step 2: Thêm hai role vào script init**

`docker/postgres/init/01-roles.sh`: thay dòng `unnest(ARRAY[...])`:
```bash
SELECT format('CREATE ROLE %I', r)
FROM unnest(ARRAY['app_owner', 'app_user', 'app_relay', 'auth_user', 'tenancy_definer', 'partition_owner', 'sweep_definer']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
```
ngay sau dòng `ALTER ROLE tenancy_definer WITH NOLOGIN …;` thêm:
```bash
-- SP6 (ADR 0005, spec SP6 §3.2): chủ sở hữu mọi bảng partitioned và hàm bảo trì partition (drop partition cần quyền owner,
-- mà runtime không có app_owner).
ALTER ROLE partition_owner WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
-- SP6 (R-X4): chủ sở hữu duy nhất của MỌI hàm SECURITY DEFINER "quét xuyên org, trả org_id đến hạn" của mọi module/feature.
-- Chỉ có SELECT theo cột + policy `<bảng>_definer_read … FOR SELECT TO sweep_definer USING (true)` do migration cấp.
ALTER ROLE sweep_definer WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
```
và ngay sau dòng `GRANT tenancy_definer TO app_owner WITH INHERIT FALSE, SET TRUE;` thêm:
```bash
-- Cùng lý do với tenancy_definer (S3-A31): migration tạo bảng/hàm DƯỚI `SET LOCAL ROLE <role>`; INHERIT FALSE nên app_owner
-- không hưởng quyền của hai role và mọi DDL trên đối tượng của chúng phải `SET LOCAL ROLE`. GRANT lặp lại cập nhật option.
GRANT USAGE, CREATE ON SCHEMA public TO partition_owner, sweep_definer;
GRANT partition_owner TO app_owner WITH INHERIT FALSE, SET TRUE;
GRANT sweep_definer TO app_owner WITH INHERIT FALSE, SET TRUE;
```

- [ ] **Step 3: Nội dung test catalog role (đã viết ở Step 1)**

`test/integration/core/database/rls-catalog.spec.ts`:
- Ca `no application role bypasses RLS (and all five roles exist)` → đổi tên `… (and all seven roles exist)`; `WHERE rolname IN (…)` và mảng mong đợi thêm `'partition_owner'`, `'sweep_definer'` (theo thứ tự tên: `app_owner, app_relay, app_user, auth_user, partition_owner, sweep_definer, tenancy_definer`).
- Thay ca `tenancy_definer cannot log in and app_owner holds it WITH INHERIT FALSE, SET TRUE (spec §6.13, T2)` bằng:
```ts
  it.each(['tenancy_definer', 'partition_owner', 'sweep_definer'])(
    '%s is NOLOGIN, NOBYPASSRLS and app_owner holds it WITH INHERIT FALSE, SET TRUE (SP3 §6.13, SP6 §3.2)',
    async (role) => {
      const { rows } = await client.query(
        `SELECT r.rolcanlogin, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, m.inherit_option, m.set_option
         FROM pg_roles r
         JOIN pg_auth_members m ON m.roleid = r.oid
         JOIN pg_roles u ON u.oid = m.member AND u.rolname = 'app_owner'
         WHERE r.rolname = $1`,
        [role],
      );
      expect(rows).toEqual([
        {
          rolcanlogin: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          inherit_option: false,
          set_option: true,
        },
      ]);
    },
  );
```
- `EXPECTED_PRIVS` thêm sau mục `tenancy_definer`:
```ts
  {
    role: 'partition_owner',
    public_usage: true,
    public_create: true,
    auth_usage: false,
    auth_create: false,
    db_connect: false,
    db_temp: false,
  },
  {
    role: 'sweep_definer',
    public_usage: true,
    public_create: true,
    auth_usage: false,
    auth_create: false,
    db_connect: false,
    db_temp: false,
  },
```

- [ ] **Step 4: Chạy catalog**

Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts`
Expected: PASS. Hạ tầng Testcontainers dựng container Postgres mới mỗi lần chạy với `docker/postgres/init` đã sửa, nên role có ngay; ca `re-running the init script succeeds and leaves every privilege unchanged (S2-R18)` xanh (script chạy lại được với hai role mới).

- [ ] **Step 5: Khung ADR 0020**

`docs/adr/0020-files-audit-webhooks.md`:
```markdown
# 0020 — Files, audit bền và webhook ra ngoài

- **Trạng thái:** đang triển khai theo các plan của SP6. Plan 6.0 (nền dùng chung) tạo file này và ghi kết quả spike P1–P3; phần Files (6A), Audit (6B), Webhooks (6C) do plan tương ứng viết (spec SP6 §18.5, R-X6).
- **Spec:** `docs/superpowers/specs/2026-09-28-sp6-files-audit-integrations-admin-design.md` (r2).

## Kết quả spike (plan 6.0)

Chạy trên nhánh của plan 6.0, hạ tầng Testcontainers của repo (Postgres 18, PgBouncer, Redis), database riêng không `OWNER` bootstrap bằng chính `01-roles.sh` (`test/support/scratch-db.ts`).

| # | Kết quả | Bằng chứng |
|---|---|---|
| P1 | (Task 1) | |
| P2 | (Task 1) | |
| P3 | (Task 2) | |
```

- [ ] **Step 6: Viết spike P1, P2 (throwaway)**

`test/integration/spike-sp6-0/partition-spikes.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP6 §4 P1: DETACH/DROP phải xong dưới `lock_timeout` 5 s của hàm bảo trì. */
const LOCK_TIMEOUT_MS = 5000;
let db: ScratchDb;
let owner: pg.Client;
let org: SeededOrg;

/** Tháng UTC lệch `offset` so với tháng hiện tại: hậu tố `YYYYMM`, cận dưới và cận trên ISO. */
const month = (offset: number) => {
  const now = new Date();
  const lo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const hi = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  const tag = `${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`;
  return { tag, lo: lo.toISOString(), hi: hi.toISOString() };
};
/** Chạy các câu trong một transaction dưới `SET LOCAL ROLE <role>` (như migration). */
async function asRole(c: pg.Client, role: string, statements: string[]): Promise<void> {
  await c.query('BEGIN');
  try {
    await c.query(`SET LOCAL ROLE ${role}`);
    for (const s of statements) await c.query(s);
    await c.query('RESET ROLE');
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
}
/** Đúng thân hàm mẫu của spec §6.7 (Task 10 chép nguyên văn cho fixture, 6B/6C cho bảng thật). */
const maintainSql = (table: string, lockKey: number) => `
CREATE FUNCTION public.${table}_maintain(p_retention_months integer, p_premake_months integer)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_base timestamp;
  v_lo timestamp;
  v_name text;
  v_cutoff timestamp;
  r record;
BEGIN
  IF p_retention_months IS NULL OR p_premake_months IS NULL THEN RAISE EXCEPTION '${table}_maintain: arguments must not be NULL'; END IF;
  IF p_retention_months < 1 OR p_retention_months > 120 THEN RAISE EXCEPTION '${table}_maintain: p_retention_months must be between 1 and 120'; END IF;
  IF p_premake_months < 1 OR p_premake_months > 12 THEN RAISE EXCEPTION '${table}_maintain: p_premake_months must be between 1 and 12'; END IF;
  IF NOT pg_try_advisory_xact_lock(${lockKey}) THEN RETURN; END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  v_base := date_trunc('month', now() AT TIME ZONE 'UTC');
  FOR i IN 0..p_premake_months LOOP
    v_lo := v_base + make_interval(months => i);
    v_name := '${table}_p' || to_char(v_lo, 'YYYYMM');
    IF to_regclass('public.' || v_name) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', v_name);
      EXECUTE format('ALTER TABLE public.${table} ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
        v_name, v_lo AT TIME ZONE 'UTC', (v_lo + interval '1 month') AT TIME ZONE 'UTC');
      action := 'created'; partition_name := v_name; RETURN NEXT;
    END IF;
  END LOOP;
  v_cutoff := v_base - make_interval(months => p_retention_months);
  FOR r IN SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'public.${table}'::regclass ORDER BY c.relname LOOP
    IF r.relname !~ '^${table}_p[0-9]{6}$' THEN RAISE EXCEPTION '${table}_maintain: unexpected partition %', r.relname; END IF;
    v_lo := to_date(substring(r.relname FROM '[0-9]{6}$'), 'YYYYMM')::timestamp;
    IF v_lo + interval '1 month' <= v_cutoff THEN
      EXECUTE format('ALTER TABLE public.${table} DETACH PARTITION public.%I', r.relname);
      EXECUTE format('DROP TABLE public.%I', r.relname);
      action := 'dropped'; partition_name := r.relname; RETURN NEXT;
    END IF;
  END LOOP;
END $$`;

beforeAll(async () => {
  applyTestEnv();
  db = await createScratchDb('spike60');
  vi.stubEnv('DB_NAME', db.name);
  await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
  owner = await db.client('owner');
  org = await seedOrg({ database: db.name });
});
afterAll(async () => {
  await owner?.end();
  vi.unstubAllEnvs();
  await db?.drop();
});

const PARENT = `CREATE TABLE public.spike_parts (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  org_id UUID NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  body TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (recorded_at, id)) PARTITION BY RANGE (recorded_at)`;

describe('P1 partition_owner: ownership, ATTACH lock level, cloned trigger/index, grants, DETACH + DROP', () => {
  it('owning a table with an FK to organizations needs REFERENCES (id) for partition_owner', async () => {
    await expect(asRole(owner, 'partition_owner', [PARENT])).rejects.toMatchObject({ code: '42501' });
    await owner.query('GRANT REFERENCES (id) ON organizations TO partition_owner');
    await asRole(owner, 'partition_owner', [
      PARENT,
      'CREATE INDEX spike_parts_org_idx ON public.spike_parts (org_id, recorded_at)',
      'ALTER TABLE public.spike_parts ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.spike_parts FORCE ROW LEVEL SECURITY',
      `CREATE POLICY spike_parts_tenant ON public.spike_parts TO app_user
         USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`,
      'GRANT SELECT, INSERT ON public.spike_parts TO app_user',
      `CREATE FUNCTION public.spike_parts_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
         BEGIN RAISE EXCEPTION 'spike_parts is append-only' USING ERRCODE = 'insufficient_privilege'; END $$`,
      'REVOKE ALL ON FUNCTION public.spike_parts_append_only() FROM PUBLIC',
      `CREATE TRIGGER spike_parts_append_only BEFORE UPDATE OR DELETE ON public.spike_parts
         FOR EACH ROW EXECUTE FUNCTION public.spike_parts_append_only()`,
      maintainSql('spike_parts', 6990),
      'REVOKE ALL ON FUNCTION public.spike_parts_maintain(integer, integer) FROM PUBLIC',
      'GRANT EXECUTE ON FUNCTION public.spike_parts_maintain(integer, integer) TO app_user',
    ]);
  });

  it('app_user makes the first partitions through the definer; trigger and indexes are cloned; identity works through the parent; the partition itself is closed', async () => {
    const made = await withAppClient(
      (c) => c.query<{ action: string; partition_name: string }>('SELECT action, partition_name FROM spike_parts_maintain(1, 2)'),
      db.name,
    );
    expect(made.rows).toEqual([0, 1, 2].map((i) => ({ action: 'created', partition_name: `spike_parts_p${month(i).tag}` })));
    const cur = `spike_parts_p${month(0).tag}`;
    const { rows } = await owner.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls,
         (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'spike_parts_append_only') AS triggers,
         (SELECT count(*)::int FROM pg_index x WHERE x.indrelid = c.oid) AS indexes,
         (SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f') AS fks
       FROM pg_class c WHERE c.relname = $1`,
      [cur],
    );
    console.log(JSON.stringify({ spike: 'P1-partition-meta', meta: rows[0] }));
    expect(rows[0]).toEqual({ owner: 'partition_owner', rls: false, triggers: 1, indexes: 2, fks: 1 });
    await withAppClient(
      (c) => inOrgTx(c, org.orgId, () => c.query('INSERT INTO spike_parts (org_id) VALUES ($1)', [org.orgId])),
      db.name,
    );
    const ids = await withAppClient(
      (c) => inOrgTx(c, org.orgId, () => c.query<{ id: string }>('SELECT id::text AS id FROM spike_parts')),
      db.name,
    );
    expect(ids.rows).toHaveLength(1);
    await withAppClient(async (c) => {
      await expect(c.query(`SELECT * FROM ${cur}`)).rejects.toMatchObject({ code: '42501' });
    }, db.name);
    await expect(asRole(owner, 'partition_owner', [`UPDATE public.${cur} SET body = 'x'`])).rejects.toMatchObject({
      code: '42501',
      message: 'spike_parts is append-only',
    });
  });

  it('ATTACH keeps the parent at SHARE UPDATE EXCLUSIVE: an INSERT runs while the maintenance transaction is open', async () => {
    const a = await db.client('app');
    const b = await db.client('app');
    try {
      await a.query('BEGIN');
      const pid = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const made = await a.query('SELECT action, partition_name FROM spike_parts_maintain(1, 3)');
      expect(made.rows).toEqual([{ action: 'created', partition_name: `spike_parts_p${month(3).tag}` }]);
      const { rows: locks } = await owner.query<{ rel: string; mode: string }>(
        `SELECT c.relname AS rel, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
         WHERE l.pid = $1 AND c.relname IN ('spike_parts', 'organizations') ORDER BY 1, 2`,
        [pid],
      );
      console.log(JSON.stringify({ spike: 'P1-attach-locks', locks }));
      expect(locks.filter((l) => l.rel === 'spike_parts').map((l) => l.mode)).not.toContain('AccessExclusiveLock');
      await b.query('BEGIN');
      await b.query(`SET LOCAL lock_timeout = '1s'`);
      await b.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      await b.query('INSERT INTO spike_parts (org_id) VALUES ($1)', [org.orgId]);
      await b.query('COMMIT');
      await a.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('DETACH + DROP of expired months finish under lock_timeout while writers insert', async () => {
    await asRole(
      owner,
      'partition_owner',
      [-3, -2].flatMap((i) => {
        const m = month(i);
        return [
          `CREATE TABLE public.spike_parts_p${m.tag} (LIKE public.spike_parts INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
          `ALTER TABLE public.spike_parts ATTACH PARTITION public.spike_parts_p${m.tag} FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
        ];
      }),
    );
    let stop = false;
    let inserted = 0;
    const errors: unknown[] = [];
    const writer = withAppClient(async (c) => {
      while (!stop) {
        try {
          await inOrgTx(c, org.orgId, () => c.query('INSERT INTO spike_parts (org_id) VALUES ($1)', [org.orgId]));
          inserted++;
        } catch (err) {
          errors.push(err);
        }
      }
    }, db.name);
    const t = performance.now();
    const res = await withAppClient((c) => c.query('SELECT action, partition_name FROM spike_parts_maintain(1, 3)'), db.name);
    const ms = performance.now() - t;
    stop = true;
    await writer;
    console.log(JSON.stringify({ spike: 'P1-detach-drop', ms, inserted }));
    expect(res.rows).toEqual([-3, -2].map((i) => ({ action: 'dropped', partition_name: `spike_parts_p${month(i).tag}` })));
    expect(errors).toEqual([]);
    expect(inserted).toBeGreaterThan(0);
    expect(ms).toBeLessThan(LOCK_TIMEOUT_MS);
  });
});

describe('P2 FK between two partitioned tables: which DETACH/DROP order works', () => {
  it('the referencing month first works; the referenced month first fails with a clear FK error', async () => {
    const m = month(-3);
    await asRole(owner, 'partition_owner', [
      `CREATE TABLE public.spike_msgs (id BIGINT GENERATED ALWAYS AS IDENTITY, org_id UUID NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (created_at, id), UNIQUE (org_id, id, created_at))
         PARTITION BY RANGE (created_at)`,
      `CREATE TABLE public.spike_dels (id BIGINT GENERATED ALWAYS AS IDENTITY, org_id UUID NOT NULL, message_id BIGINT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (created_at, id),
         FOREIGN KEY (org_id, message_id, created_at) REFERENCES public.spike_msgs (org_id, id, created_at) ON DELETE RESTRICT)
         PARTITION BY RANGE (created_at)`,
      ...['spike_msgs', 'spike_dels'].flatMap((t) => [
        `CREATE TABLE public.${t}_p${m.tag} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
        `ALTER TABLE public.${t} ATTACH PARTITION public.${t}_p${m.tag} FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
      ]),
      `INSERT INTO public.spike_msgs (org_id, created_at) VALUES ('${org.orgId}', '${m.lo}')`,
      'INSERT INTO public.spike_dels (org_id, message_id, created_at) SELECT org_id, id, created_at FROM public.spike_msgs',
    ]);
    const wrong = await asRole(owner, 'partition_owner', [
      `ALTER TABLE public.spike_msgs DETACH PARTITION public.spike_msgs_p${m.tag}`,
    ]).then(
      () => undefined,
      (err: unknown) => err,
    );
    console.log(JSON.stringify({ spike: 'P2-wrong-order', error: String(wrong) }));
    expect(wrong).toMatchObject({ code: '23503' });
    await asRole(owner, 'partition_owner', [
      `ALTER TABLE public.spike_dels DETACH PARTITION public.spike_dels_p${m.tag}`,
      `DROP TABLE public.spike_dels_p${m.tag}`,
      `ALTER TABLE public.spike_msgs DETACH PARTITION public.spike_msgs_p${m.tag}`,
      `DROP TABLE public.spike_msgs_p${m.tag}`,
    ]);
  });
});
```
(`org.orgId` do `v7()` sinh, `m.lo`/`m.hi` do `Date#toISOString`: nối vào SQL của owner trong database riêng là an toàn.)

- [ ] **Step 7: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp6-0/partition-spikes.spec.ts`
Expected: PASS mọi ca; các dòng `console.log` in `P1-partition-meta`, `P1-attach-locks` (mode trên `spike_parts` và `organizations`), `P1-detach-drop` (ms, số dòng chèn), `P2-wrong-order`. Ca nào đỏ:
- `ATTACH` giữ `AccessExclusiveLock` trên cha, hoặc INSERT của `b` hết `lock_timeout` → fallback spec §4 P1: tạo trước `premake` tháng ở cửa sổ ít tải (cron `03:00`), chấp nhận chặn ghi ngắn; ghi ADR 0020 và báo Sếp trước Task 12.
- Trigger/index không nhân bản sang partition → trigger/index khai trên từng partition bởi hàm bảo trì; ghi ADR, sửa Task 10 theo đó.
- `DETACH`/`DROP` quá 5 s → giữ `lock_timeout` 5 s (lượt bảo trì lỗi rồi retry, ghi không bị chặn quá 5 s), ghi số đo.
- P2 thứ tự ngược mà không lỗi FK, hoặc thứ tự đúng mà lỗi → fallback spec §4 P2 (bỏ FK, nhất quán bằng cùng tháng + test bất biến; ghi ADR để 6C theo).
- Mã lỗi thứ tự ngược khác `23503` nhưng vẫn là lỗi FK rõ ràng và không mất dòng → sửa kỳ vọng theo mã đo được, ghi mã vào ADR.

- [ ] **Step 8: Ghi kết quả vào ADR 0020 và dọn spike**

Thay hai dòng P1, P2 của bảng "Kết quả spike (plan 6.0)" bằng kết quả thật (mẫu khi đạt; số đo lấy từ dòng `console.log`):
```markdown
| P1 | Đạt. Hàm `SECURITY DEFINER SET search_path = ''` do `partition_owner` (NOLOGIN, `INHERIT FALSE`) sở hữu, `app_user` gọi, tạo partition bằng `CREATE TABLE … (LIKE cha INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` + `ATTACH PARTITION`: cha chỉ bị giữ `ShareUpdateExclusiveLock` (INSERT song song của `app_user` chạy trong lúc transaction bảo trì còn mở); `organizations` bị giữ `<mode đo được>` khi partition mới nhân bản FK. Trigger dòng `BEFORE UPDATE OR DELETE` và index khai trên cha tự nhân bản sang partition; FK, identity của cha dùng được qua bảng cha. Partition không có RLS (`relrowsecurity = false`) nên không được có grant: `app_user` đọc thẳng partition → `42501`. `DETACH` + `DROP` hai tháng hết hạn xong trong <ms> ms khi <n> INSERT song song, không lỗi. Muốn sở hữu bảng có FK tới `organizations`, `partition_owner` cần `GRANT REFERENCES (id) ON organizations` (không có → `42501`); migration của 6C cấp grant này. | `test/integration/spike-sp6-0/partition-spikes.spec.ts` (không commit), PG 18, database riêng |
| P2 | Đạt. Hai bảng partitioned có FK `(org_id, message_id, created_at) → (org_id, id, created_at)`: `DETACH` + `DROP` partition con (deliveries) tháng M rồi mới tới partition cha (messages) tháng M chạy được; thứ tự ngược → `<mã đo được>` (<thông điệp>), không mất dòng. Hàm bảo trì của 6C phải drop `webhook_deliveries` trước `webhook_messages` cùng tháng. | như trên |
```
Thay `<…>` bằng giá trị đo được của Step 7 (dữ liệu của lần chạy, không phải thiết kế còn thiếu). Run: `rm -r test/integration/spike-sp6-0`

- [ ] **Step 9: Commit**

```bash
git add docker/postgres/init/01-roles.sh test/integration/core/database/rls-catalog.spec.ts docs/adr/0020-files-audit-webhooks.md
git commit -m "feat(db): partition_owner and sweep_definer NOLOGIN roles in the init script; record spikes P1-P2 in ADR 0020"
```

---

### Task 2: Cài `@openfeature/server-sdk` + `@openfeature/core`; spike P3 giữ thành test hợp đồng; luật kiến trúc 22

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `renovate.json`, `.dependency-cruiser.cjs`, `test/unit/architecture/rules.spec.ts`, `docs/adr/0020-files-audit-webhooks.md`
- Create (được giữ): `test/unit/core/flags/openfeature-contract.spec.ts`, `test/architecture/fixtures/src/modules/billing/infra/uses-openfeature.ts`, `test/architecture/fixtures/src/core/flags/ok.ts`

**Interfaces:**
- Consumes: không.
- Produces: dependency `@openfeature/server-sdk` 1.23.0 và `@openfeature/core` 1.12.0; luật depcruise `openfeature-only-in-core-flags` (22); dòng P3 của ADR 0020. Hợp đồng SDK mà Task 9 dựa vào (mỗi điều một ca test): domain độc lập, `initialize` reject → `setProviderAndWait` reject + `providerStatus = ERROR`, thay bằng `NOOP_PROVIDER` gọi `onClose`, `OpenFeature.close()` gọi `onClose`, `setLogger` có mặt.

- [ ] **Step 1: Kiểm version và peer trước khi cài**

Run:
```bash
pnpm view @openfeature/server-sdk dist-tags peerDependencies
pnpm view @openfeature/core dist-tags dependencies
```
Expected: `@openfeature/server-sdk` `latest = 1.23.0`, `peerDependencies = { '@openfeature/core': '^1.12.0' }`; `@openfeature/core` `latest = 1.12.0`, không có `dependencies`. Khác thì **dừng**, ghi output vào ADR 0020 và báo Sếp.

- [ ] **Step 2: Viết test hợp đồng (fail vì package chưa cài)**

`test/unit/core/flags/openfeature-contract.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import * as sdk from '@openfeature/server-sdk';
import {
  NOOP_PROVIDER,
  OpenFeature,
  ProviderStatus,
  StandardResolutionReasons,
  TypeMismatchError,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';

/** Provider thăm dò: đếm initialize/onClose, chỉ trả boolean (như DbKillSwitchProvider của Task 9). */
class ProbeProvider implements Provider {
  readonly metadata = { name: 'probe' };
  readonly runsOn = 'server';
  initialized = 0;
  closed = 0;
  constructor(
    private readonly value: boolean,
    private readonly failInit = false,
  ) {}
  async initialize(): Promise<void> {
    this.initialized++;
    if (this.failInit) throw new Error('first load failed');
  }
  async onClose(): Promise<void> {
    this.closed++;
  }
  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean): Promise<ResolutionDetails<boolean>> {
    return Promise.resolve(
      flagKey === 'probe.on'
        ? { value: this.value, reason: StandardResolutionReasons.CACHED }
        : { value: defaultValue, reason: StandardResolutionReasons.DEFAULT },
    );
  }
  resolveStringEvaluation(): Promise<ResolutionDetails<string>> {
    return Promise.reject(new TypeMismatchError('boolean flags only'));
  }
  resolveNumberEvaluation(): Promise<ResolutionDetails<number>> {
    return Promise.reject(new TypeMismatchError('boolean flags only'));
  }
  resolveObjectEvaluation<T extends JsonValue>(): Promise<ResolutionDetails<T>> {
    return Promise.reject(new TypeMismatchError('boolean flags only'));
  }
}
const domain = () => `contract.${randomUUID()}`;

/**
 * Spike P3 của spec SP6 §4, giữ lại làm test hợp đồng: nâng `@openfeature/*` mà đổi bất kỳ điều nào dưới đây thì
 * test đỏ trước khi kill switch âm thầm đổi nghĩa (core/flags, Task 9).
 */
describe('@openfeature/server-sdk 1.23.0 contract (spike P3)', () => {
  it('loads as ESM under SWC with the API core/flags uses', () => {
    for (const name of ['OpenFeature', 'NOOP_PROVIDER', 'ProviderStatus', 'StandardResolutionReasons', 'TypeMismatchError'])
      expect(name in sdk, name).toBe(true);
    expect(typeof OpenFeature.setLogger).toBe('function');
    expect(typeof OpenFeature.close).toBe('function');
  });
  it('setProviderAndWait on a domain runs initialize once; the client of that domain is READY and resolves booleans', async () => {
    const d = domain();
    const p = new ProbeProvider(true);
    await OpenFeature.setProviderAndWait(d, p);
    const client = OpenFeature.getClient(d);
    expect([p.initialized, client.providerStatus]).toEqual([1, ProviderStatus.READY]);
    expect(await client.getBooleanValue('probe.on', false)).toBe(true);
    expect(await client.getBooleanValue('probe.missing', false)).toBe(false);
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
  });
  it('two domains in one process are isolated (one provider per Nest app in tests)', async () => {
    const [a, b] = [domain(), domain()];
    await OpenFeature.setProviderAndWait(a, new ProbeProvider(true));
    await OpenFeature.setProviderAndWait(b, new ProbeProvider(false));
    expect(await OpenFeature.getClient(a).getBooleanValue('probe.on', false)).toBe(true);
    expect(await OpenFeature.getClient(b).getBooleanValue('probe.on', true)).toBe(false);
    await OpenFeature.setProviderAndWait(a, NOOP_PROVIDER);
    await OpenFeature.setProviderAndWait(b, NOOP_PROVIDER);
  });
  it('an initialize failure rejects setProviderAndWait and leaves the client in ERROR (fail loud at boot)', async () => {
    const d = domain();
    await expect(OpenFeature.setProviderAndWait(d, new ProbeProvider(true, true))).rejects.toThrow('first load failed');
    expect(OpenFeature.getClient(d).providerStatus).toBe(ProviderStatus.ERROR);
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
  });
  it('replacing the provider of a domain with NOOP_PROVIDER calls onClose of the old one', async () => {
    const d = domain();
    const p = new ProbeProvider(true);
    await OpenFeature.setProviderAndWait(d, p);
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
    expect(p.closed).toBe(1);
  });
  it('OpenFeature.close() calls onClose of every domain provider', async () => {
    const d = domain();
    const p = new ProbeProvider(true);
    await OpenFeature.setProviderAndWait(d, p);
    await OpenFeature.close();
    expect(p.closed).toBe(1);
  });
  it('a non-boolean evaluation against a boolean-only provider returns the default (why KillSwitches only asks booleans)', async () => {
    const d = domain();
    await OpenFeature.setProviderAndWait(d, new ProbeProvider(true));
    expect(await OpenFeature.getClient(d).getStringValue('probe.on', 'fallback')).toBe('fallback');
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
  });
});
```

- [ ] **Step 3: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/core/flags/openfeature-contract.spec.ts`
Expected: FAIL `Cannot find package '@openfeature/server-sdk'`.

- [ ] **Step 4: Cài package**

Run:
```bash
pnpm add @openfeature/server-sdk @openfeature/core
pnpm list @openfeature/server-sdk @openfeature/core
```
Expected: `@openfeature/server-sdk 1.23.0`, `@openfeature/core 1.12.0` trong `dependencies` (save-exact). Peer được khai tường minh (không dựa vào auto-install-peers) vì bản ESM của server-sdk `import` thẳng `@openfeature/core` lúc chạy.

Sửa `renovate.json`, thêm vào `packageRules` (giữ rule đang có):
```json
{
  "groupName": "openfeature",
  "matchPackageNames": ["@openfeature/{/,}**"],
  "description": "Bump server-sdk and its core peer together; re-run test/unit/core/flags/openfeature-contract.spec.ts (spike P3, spec SP6 §4)"
}
```
Run: `pnpm dlx --package renovate renovate-config-validator renovate.json`
Expected: `Config validated successfully`.

- [ ] **Step 5: Chạy test hợp đồng**

Run: `pnpm vitest run --project unit test/unit/core/flags/openfeature-contract.spec.ts`
Expected: PASS 7/7. (Đã đọc `dist/esm/index.js` của core 1.12.0 lúc viết plan: `setAwaitableProvider` ném lại lỗi `initialize` và đặt `ERROR`; thay provider gọi `oldProvider.onClose`; `close()` gọi `onClose` của provider mặc định và mọi domain.) Đỏ ở bất kỳ ca nào → không có fallback package (spec §4 P3): `core/flags` đọc snapshot trực tiếp không qua OpenFeature, ghi ADR 0020, **dừng và báo Sếp** trước Task 9 (spec cha bắt buộc OpenFeature).

- [ ] **Step 6: Luật kiến trúc 22 (fixture phải fail)**

`test/architecture/fixtures/src/modules/billing/infra/uses-openfeature.ts`:
```ts
import { OpenFeature } from '@openfeature/server-sdk';

export const leak = OpenFeature;
```
`test/architecture/fixtures/src/core/flags/ok.ts`:
```ts
import { OpenFeature } from '@openfeature/server-sdk';

export const owner = OpenFeature;
```
`.dependency-cruiser.cjs`, thêm sau luật `rate-limiter-only-in-core-http-or-identity-better-auth`:
```js
    {
      name: 'openfeature-only-in-core-flags',
      severity: 'error',
      comment:
        'SP6 rule 22: OpenFeature stays behind core/flags (KillSwitches); modules ask KillSwitches.isKilled, never the SDK.',
      from: { pathNot: '(^|/)src/core/flags/' },
      to: { path: 'node_modules/@openfeature/' },
    },
```
`test/unit/architecture/rules.spec.ts`: thêm vào bảng `it.each` dòng
```ts
    ['openfeature-only-in-core-flags', 'modules/billing/infra/uses-openfeature.ts'],
```
Run: `pnpm vitest run --project unit test/unit/architecture/rules.spec.ts`
Expected: PASS (ca mới bắt fixture; `core/flags/ok.ts` không vi phạm; cây `src` thật chưa import OpenFeature).

- [ ] **Step 7: Ghi P3 vào ADR 0020**

Thay dòng P3:
```markdown
| P3 | Đạt. `@openfeature/server-sdk` 1.23.0 + peer `@openfeature/core` 1.12.0 nạp ESM dưới SWC/`nodenext`. Provider tự viết cài đủ bốn `resolve*Evaluation` (kiểu bắt buộc trả `Promise`; provider trả `Promise.resolve` từ snapshot trong bộ nhớ, không I/O). `OpenFeature.setProviderAndWait(domain, provider)` chạy `initialize` một lần; `initialize` reject → `setProviderAndWait` reject và client ở `ERROR`. Mỗi domain một provider độc lập (mỗi app Nest một domain). Thay provider của domain bằng `NOOP_PROVIDER` và `OpenFeature.close()` đều gọi `onClose`. Đánh giá kiểu khác boolean trên provider chỉ-boolean trả giá trị mặc định (SDK nuốt lỗi), nên `KillSwitches` chỉ hỏi boolean và tự kiểm `providerStatus`. | `test/unit/core/flags/openfeature-contract.spec.ts` (giữ làm test hợp đồng) |
```

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml renovate.json .dependency-cruiser.cjs test/unit/architecture/rules.spec.ts test/architecture/fixtures/src docs/adr/0020-files-audit-webhooks.md test/unit/core/flags/openfeature-contract.spec.ts
git commit -m "build(core): add @openfeature/server-sdk 1.23.0 with its core peer; keep spike P3 as a contract test; rule 22"
```

---

## Phần B — Core `events`/`http`, tenancy (spec §5.3 các hàng "6.0")

### Task 3: `defineEvent` đòi cờ `audit`/`webhook`; cờ cuối cho mọi event đang có; event `webhook: true` chỉ phát được trong org (C-1, một nửa C-3)

**Files:**
- Modify: `src/core/events/event-definition.ts`, `src/core/events/event-publisher.ts`, `src/modules/identity/events.ts`, `src/modules/notifications/events.ts`, `src/modules/tenancy/events.ts`, `test/fixtures/fixture.events.ts`, `test/e2e/core/events.e2e.spec.ts`, `test/integration/core/observability/pipeline.spec.ts`, `test/integration/core/outbox/outbox-if-absent.spec.ts`, `test/integration/core/queue/worker-org-gate.spec.ts`, `test/unit/core/events/envelope.spec.ts`, `test/unit/core/events/subscriber-registry.spec.ts` (và mọi file khác `grep` tìm thấy ở Step 4)
- Create: `test/unit/core/events/event-flags.spec.ts`, `test/unit/core/events/event-publisher.spec.ts`

**Interfaces:**
- Consumes: `defineEvent`, `eventRegistry`, `EventPublisher`, `OutboxWriter`, `RequestContext` (SP1); 8 event của `tenancy/events.ts` (3A Task 19).
- Produces:
  - `EventDef<S> = { type; version; schema: S; audit: boolean; webhook: boolean }`; `defineEvent({ type, version, schema, audit, webhook })` — thiếu cờ là lỗi compile; cờ không phải boolean (gọi từ JS) → ném `Event "<type>" must declare audit and webhook as booleans (R-X3)`.
  - `EventPublisher.publish` ném `Event "<type@version>" is a webhook event and must be published inside an organization context` khi `def.webhook` và `RequestContext.orgId()` rỗng, trước khi ghi outbox.
  - Cờ cuối (đọc bởi 6B, 6C, không ai sửa lại): bảng `EXPECTED` của `event-flags.spec.ts`.

- [ ] **Step 1: Test cờ và giá trị cuối (fail)**

`test/unit/core/events/event-flags.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// Nạp đủ module của app: mọi `defineEvent` chạy lúc import.
import '../../../../src/app-api.module.js';
import '../../../../src/app-worker.module.js';
import {
  defineEvent,
  eventRegistry,
} from '../../../../src/core/events/index.js';

/**
 * Giá trị cuối của cờ cho event có trên `main` khi 6.0 merge (spec SP6 §5.3 hàng "Mọi lời gọi defineEvent", §8.3).
 * Plan sau KHÔNG sửa bảng này: event mới tự khai cờ theo spec của mình (compile bắt), ca đầu tiên kiểm kiểu cho mọi event.
 */
const EXPECTED: Readonly<Record<string, { audit: boolean; webhook: boolean }>> = {
  'identity.user.registered@1': { audit: true, webhook: false },
  'notifications.delivery.failed@1': { audit: false, webhook: false },
  'tenancy.org.created@1': { audit: true, webhook: false },
  'tenancy.org.updated@1': { audit: true, webhook: true },
  'tenancy.org.deleted@1': { audit: true, webhook: true },
  'tenancy.org.restored@1': { audit: true, webhook: true },
  'tenancy.org.purged@1': { audit: true, webhook: false },
  'tenancy.member.added@1': { audit: true, webhook: true },
  'tenancy.member.role_changed@1': { audit: true, webhook: true },
  'tenancy.member.removed@1': { audit: true, webhook: true },
};
const flagsOf = () =>
  new Map(
    eventRegistry().map((d) => [
      `${d.type}@${d.version}`,
      { audit: d.audit, webhook: d.webhook },
    ]),
  );

describe('event flags audit/webhook (R-X3, spec SP6 §5.3, C-1)', () => {
  it('every event the app defines declares both flags as booleans', () => {
    const defs = eventRegistry();
    expect(defs.length).toBeGreaterThanOrEqual(Object.keys(EXPECTED).length);
    for (const d of defs)
      expect([typeof d.audit, typeof d.webhook], `${d.type}@${d.version}`).toEqual(['boolean', 'boolean']);
  });
  it.each(Object.entries(EXPECTED))('%s carries its final flags', (key, flags) => {
    expect(flagsOf().get(key)).toEqual(flags);
  });
  it('exactly six tenancy events of 3A are public webhook contracts (spec SP6 §8.3)', () => {
    expect(
      [...flagsOf()]
        .filter(([key, f]) => key.startsWith('tenancy.') && f.webhook)
        .map(([key]) => key)
        .sort(),
    ).toEqual(
      [
        'tenancy.member.added@1',
        'tenancy.member.removed@1',
        'tenancy.member.role_changed@1',
        'tenancy.org.deleted@1',
        'tenancy.org.restored@1',
        'tenancy.org.updated@1',
      ].sort(),
    );
  });
  it('missing flags are a compile error; a non-boolean flag coming from JS throws at definition', () => {
    const missing = () =>
      // @ts-expect-error audit and webhook are required, there is no default (R-X3)
      defineEvent({ type: 'unit.flags.missing', version: 1, schema: z.object({}) });
    expect(missing).toThrow(/must declare audit and webhook as booleans/);
    const fromJs: unknown = { type: 'unit.flags.stringy', version: 1, schema: z.object({}), audit: 'true', webhook: false };
    expect(() => Reflect.apply(defineEvent, undefined, [fromJs])).toThrow(/must declare audit and webhook as booleans/);
    const kept = defineEvent({ type: 'unit.flags.kept', version: 1, schema: z.object({}), audit: true, webhook: false });
    expect([kept.audit, kept.webhook]).toEqual([true, false]);
  });
});
```
`test/unit/core/events/event-publisher.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RequestContext } from '../../../../src/core/context/index.js';
import { EventPublisher, defineEvent } from '../../../../src/core/events/index.js';
import type { OutboxWriter } from '../../../../src/core/outbox/index.js';

const Hooked = defineEvent({ type: 'unit.hook.fired', version: 1, schema: z.object({}), audit: true, webhook: true });
const Plain = defineEvent({ type: 'unit.plain.fired', version: 1, schema: z.object({}), audit: false, webhook: false });
const ORG = '0199a000-0000-7000-8000-000000000001';
const input = {
  data: {},
  aggregate: { type: 'unit', id: 'u1', version: 1 },
  actor: { type: 'system' as const, id: 'unit' },
};
function make(orgId: string | undefined) {
  const append = vi.fn(() => Promise.resolve());
  const outbox = { append } as Pick<OutboxWriter, 'append'> as OutboxWriter;
  const ctx = {
    orgId: () => orgId,
    requestId: () => 'req-unit',
    traceparent: () => undefined,
  } as Pick<RequestContext, 'orgId' | 'requestId' | 'traceparent'> as RequestContext;
  return { publisher: new EventPublisher(outbox, ctx), append };
}

describe('EventPublisher and the webhook flag (spec SP6 §8.3 fan-out step 1, C-3)', () => {
  it('a webhook event outside an organization is refused before anything is written', async () => {
    const { publisher, append } = make(undefined);
    await expect(publisher.publish(Hooked, input)).rejects.toThrow(
      /unit\.hook\.fired@1" is a webhook event and must be published inside an organization context/,
    );
    expect(append).not.toHaveBeenCalled();
  });
  it('inside an organization a webhook event is written with that org', async () => {
    const { publisher, append } = make(ORG);
    await publisher.publish(Hooked, input);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, type: 'unit.hook.fired' }), { ifAbsent: undefined });
  });
  it('an event without the webhook flag may still be published outside any organization', async () => {
    const { publisher, append } = make(undefined);
    await publisher.publish(Plain, input);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ orgId: null }), { ifAbsent: undefined });
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/core/events/event-flags.spec.ts test/unit/core/events/event-publisher.spec.ts`
Expected: FAIL (`d.audit` là `undefined`; `defineEvent` chưa ném; publish webhook ngoài org chưa bị chặn). `pnpm typecheck` báo `Unused '@ts-expect-error' directive` — đúng: cờ chưa bắt buộc.

- [ ] **Step 3: Cài cờ bắt buộc và chặn ở publisher**

`src/core/events/event-definition.ts` — kiểu và hàm:
```ts
export type EventDef<S extends z.ZodType = z.ZodType> = {
  readonly type: string;
  readonly version: number;
  readonly schema: S;
  /** Event vào audit (6B nhận qua bộ chọn `AUDITED_EVENTS`). Bắt buộc, không mặc định (R-X3). */
  readonly audit: boolean;
  /**
   * Event là hợp đồng webhook công khai (6C nhận qua `WEBHOOK_EVENTS`; đổi schema phải lên version). Chỉ hợp lệ với event
   * theo org: `EventPublisher` từ chối phát ngoài org.
   */
  readonly webhook: boolean;
};
```
```ts
export function defineEvent<S extends z.ZodType>(def: {
  type: string;
  version: number;
  schema: S;
  audit: boolean;
  webhook: boolean;
}): EventDef<S> {
  if (!TYPE_PATTERN.test(def.type))
    throw new Error(
      `Event type "${def.type}" must follow context.aggregate.verb`,
    );
  if (!Number.isInteger(def.version) || def.version <= 0)
    throw new Error(
      `Event "${def.type}" version must be a positive integer, got ${def.version}`,
    );
  // Lớp thứ hai sau compiler: lời gọi từ JS hay qua kiểu lỏng không được lặng lẽ rơi khỏi audit/webhook.
  if (typeof def.audit !== 'boolean' || typeof def.webhook !== 'boolean')
    throw new Error(
      `Event "${def.type}" must declare audit and webhook as booleans (R-X3)`,
    );
  const key = eventKey(def.type, def.version);
  if (events.has(key)) throw new Error(`Event "${key}" already defined`);
  const full: EventDef<S> = {
    type: def.type,
    version: def.version,
    schema: def.schema,
    audit: def.audit,
    webhook: def.webhook,
  };
  events.set(key, full);
  return full;
}
```
`src/core/events/event-publisher.ts` — trong `publish`, ngay sau khi có `e` (kết quả `this.validated(...)`) và trước `await this.outbox.append(`:
```ts
    if (def.webhook && e.orgId === null)
      throw new Error(
        `Event "${eventKey(def.type, def.version)}" is a webhook event and must be published inside an organization context`,
      );
```

- [ ] **Step 4: Khai cờ cho mọi lời gọi `defineEvent` đang có**

Run: `grep -rln "defineEvent(" src test --include=*.ts`
Mỗi lời gọi (trừ định nghĩa trong `event-definition.ts`) thêm hai khoá ngay sau `version: …,`:
- `src/modules/identity/events.ts`: `UserRegisteredEvent` → `audit: true, webhook: false`.
- `src/modules/notifications/events.ts`: `DeliveryFailedEvent` → `audit: false, webhook: false` (sự kiện vận hành, đã có metric; không phải thao tác của người).
- `src/modules/tenancy/events.ts` (3A): `audit: true` cho cả 8; `webhook: true` cho `OrgUpdatedEvent`, `OrgDeletedEvent`, `OrgRestoredEvent`, `MemberAddedEvent`, `MemberRoleChangedEvent`, `MemberRemovedEvent`; `webhook: false` cho `OrgCreatedEvent`, `OrgPurgedEvent`. Thêm vào chú thích đầu file: `Cờ audit/webhook (R-X3, spec SP6 §8.3): mọi event tenancy vào audit; sáu event là hợp đồng webhook công khai (đổi schema phải lên version).` Ví dụ một mục sau khi sửa:
```ts
export const OrgDeletedEvent = defineEvent({
  type: 'tenancy.org.deleted',
  version: 1,
  audit: true,
  webhook: true,
  schema: z.object({ orgId: id, purgeAfter: z.iso.datetime() }),
});
```
- Mọi fixture trong `test/` (`fixture.events.ts`, `events.e2e.spec.ts` (`NoteEchoed`), `pipeline.spec.ts` (`ThingHappened`), `outbox-if-absent.spec.ts` (`FixtureHappened`), `worker-org-gate.spec.ts` (`OrgGoneProbe`), `envelope.spec.ts` (mọi lời gọi, kể cả lời gọi kỳ vọng ném vì tên/version sai — thêm cờ để lỗi vẫn là lỗi đang được test), `subscriber-registry.spec.ts` (`Pinged`), cùng mọi file khác `grep` tìm thấy): `audit: false, webhook: false`.

- [ ] **Step 5: Chạy lại**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/core/events
pnpm vitest run --project integration test/e2e/core/events.e2e.spec.ts test/integration/core/outbox test/integration/core/queue/worker-org-gate.spec.ts test/integration/core/observability/pipeline.spec.ts
pnpm vitest run --project integration test/integration/tenancy test/e2e/tenancy
```
Expected: typecheck sạch (directive `@ts-expect-error` nay có lỗi để nuốt); unit PASS; integration PASS (không hồi quy SP1/SP2/3A). Event tenancy luôn phát trong `OrgScope` (3A) nên chặn "webhook ⇒ org" không đổi hành vi tenancy.

- [ ] **Step 6: Commit**

```bash
git add src/core/events src/modules/identity/events.ts src/modules/notifications/events.ts src/modules/tenancy/events.ts test
git commit -m "feat(events): audit and webhook flags are required on defineEvent; final flags for every existing event; webhook events need an org"
```

---

### Task 4: Subscriber theo bộ chọn `AUDITED_EVENTS` / `WEBHOOK_EVENTS` (C-2, C-3, C-4)

**Files:**
- Modify: `src/core/events/subscriber.decorator.ts`, `src/core/events/event-dispatch.handlers.ts`, `src/core/events/index.ts`, `test/unit/core/events/subscriber-registry.spec.ts`
- Create: `test/unit/core/events/deliver-selector.spec.ts`, `test/integration/core/events/selector-subscriber.spec.ts`

**Interfaces:**
- Consumes: `EventDef.audit/.webhook` (Task 3), `eventRegistry`, `findEvent`, `eventKey`, `OutboxReader`, `Inbox`, `UnitOfWork`, `JobPayloadError` (SP1).
- Produces:
  - `type EventSelector = { readonly name: 'audit' | 'webhook'; matches(def: EventDef): boolean }`; hằng `AUDITED_EVENTS` (`def.audit`), `WEBHOOK_EVENTS` (`def.webhook`) — export từ `core/events/index.ts`. 6B dùng `@EventSubscriber({ consumer: 'audit.recorder', events: AUDITED_EVENTS })`, 6C dùng `WEBHOOK_EVENTS`.
  - `type SubscriberMeta = { consumer: string; event: EventDef } | { consumer: string; events: EventSelector }`; bộ chọn khác hai hằng → ném lúc boot.
  - `SubscriberRegistry`: đăng ký subscriber bộ chọn cho mọi def khớp trong `eventRegistry()` lúc `onModuleInit`; `forEvent(type, version)` ném `Event <key> was defined after the subscriber registry was built…` khi def có trong registry event nhưng xuất hiện sau khi registry subscriber đã dựng.
  - `DeliverEventHandler`: lấy def bằng `findEvent(row.type, row.version)`; def không thuộc tập của subscriber → `Error('Subscriber "<c>" does not handle <key> in this worker (outbox row <id>)')`; payload sai schema → `JobPayloadError` (như cũ). Handler của subscriber bộ chọn nhận `EventEnvelope<unknown>` đã parse theo schema của đúng def.

- [ ] **Step 1: Unit test registry và deliver theo bộ chọn (fail)**

`test/unit/core/events/deliver-selector.spec.ts`:
```ts
import { Injectable, Logger, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { v7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { UnitOfWork } from '../../../../src/core/database/index.js';
import {
  AUDITED_EVENTS,
  EventSubscriber,
  SubscriberRegistry,
  WEBHOOK_EVENTS,
  defineEvent,
  type EventEnvelope,
  type EventSelector,
} from '../../../../src/core/events/index.js';
import {
  DeliverEventHandler,
  type OutboxReader,
  type OutboxRow,
} from '../../../../src/core/events/event-dispatch.handlers.js';
import type { Inbox } from '../../../../src/core/outbox/index.js';
import { JobPayloadError, type JobContext } from '../../../../src/core/queue/index.js';

const Audited = defineEvent({ type: 'unit.sel.audited', version: 1, schema: z.object({ n: z.number() }), audit: true, webhook: false });
const Silent = defineEvent({ type: 'unit.sel.silent', version: 1, schema: z.object({}), audit: false, webhook: false });

const seen: { consumer: string; type: string; data: unknown }[] = [];
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.audit', events: AUDITED_EVENTS })
class AuditAll {
  async handle(e: EventEnvelope<unknown>) {
    seen.push({ consumer: 'unit.sel.audit', type: e.type, data: e.data });
  }
}
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.hooks', events: WEBHOOK_EVENTS })
class HookAll {
  async handle(e: EventEnvelope<unknown>) {
    seen.push({ consumer: 'unit.sel.hooks', type: e.type, data: e.data });
  }
}
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.single', event: Silent })
class OnlySilent {
  async handle(e: EventEnvelope<unknown>) {
    seen.push({ consumer: 'unit.sel.single', type: e.type, data: e.data });
  }
}
const Rogue: EventSelector = { name: 'audit', matches: () => true };
@Injectable()
@EventSubscriber({ consumer: 'unit.sel.rogue', events: Rogue })
class RogueSelector {
  async handle() {}
}
/**
 * Định nghĩa SAU các class subscriber trong file (C-2): mọi `defineEvent` chạy lúc import, trước `onModuleInit`, nên
 * subscriber bộ chọn vẫn nhận nó.
 */
const Hooked = defineEvent({ type: 'unit.sel.hooked', version: 1, schema: z.object({}), audit: true, webhook: true });

async function boot(providers: Type<unknown>[]): Promise<SubscriberRegistry> {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [SubscriberRegistry, ...providers],
  }).compile();
  try {
    await ref.init();
    return ref.get(SubscriberRegistry);
  } finally {
    await ref.close();
  }
}
const row = (type: string, version: number, payload: unknown): OutboxRow => ({
  id: '42',
  event_id: v7(),
  type,
  version,
  org_id: null,
  aggregate_type: 'unit',
  aggregate_id: 'u1',
  aggregate_version: '1',
  payload,
  headers: { actorType: 'system', actorId: 'unit', correlationId: 'c-unit' },
  occurred_at: new Date(),
});
function deliverer(reg: SubscriberRegistry, r: OutboxRow) {
  const reader = { load: () => Promise.resolve(r) } as Pick<OutboxReader, 'load'> as OutboxReader;
  const inbox = {
    once: async (_c: string, _id: string, fn: () => Promise<void>) => {
      await fn();
      return 'processed' as const;
    },
  } as Pick<Inbox, 'once'> as Inbox;
  const uow = { run: <T>(fn: () => Promise<T>) => fn() } as Pick<UnitOfWork, 'run'> as UnitOfWork;
  return new DeliverEventHandler(reader, reg, inbox, uow);
}
const ctx = (consumer: string): JobContext<{ consumer: string; outboxId: string }> => ({
  payload: { consumer, outboxId: '42' },
  meta: {},
  jobId: `deliver-${consumer}-42`,
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('unit'),
});

describe('selector subscribers (spec SP6 §5.3 core/events, C-2, C-3, C-4)', () => {
  it('index a selector subscriber under every matching def, including one defined later in the import tree (C-2)', async () => {
    const reg = await boot([AuditAll, HookAll, OnlySilent]);
    const consumers = (type: string) => reg.forEvent(type, 1).map((e) => e.meta.consumer).sort();
    expect(consumers(Audited.type)).toEqual(['unit.sel.audit']);
    expect(consumers(Hooked.type)).toEqual(['unit.sel.audit', 'unit.sel.hooks']);
    expect(consumers(Silent.type)).toEqual(['unit.sel.single']);
  });
  it('a selector other than AUDITED_EVENTS / WEBHOOK_EVENTS fails boot', async () => {
    await expect(boot([RogueSelector])).rejects.toThrow(/selector must be AUDITED_EVENTS or WEBHOOK_EVENTS/);
  });
  it('an event defined after the registry was built is refused at dispatch, not silently skipped', async () => {
    const reg = await boot([AuditAll]);
    defineEvent({ type: 'unit.sel.late', version: 1, schema: z.object({}), audit: true, webhook: false });
    expect(() => reg.forEvent('unit.sel.late', 1)).toThrow(/defined after the subscriber registry was built/);
  });
  it('deliver hands a selector subscriber the envelope parsed with the schema of the row def', async () => {
    const reg = await boot([AuditAll, HookAll, OnlySilent]);
    seen.length = 0;
    await deliverer(reg, row(Audited.type, 1, { n: 7 })).handle(ctx('unit.sel.audit'));
    expect(seen).toEqual([{ consumer: 'unit.sel.audit', type: Audited.type, data: { n: 7 } }]);
  });
  it('deliver of a row whose type is outside the subscriber set is an error (C-3)', async () => {
    const reg = await boot([AuditAll, HookAll, OnlySilent]);
    await expect(deliverer(reg, row(Silent.type, 1, {})).handle(ctx('unit.sel.audit'))).rejects.toThrow(
      /Subscriber "unit\.sel\.audit" does not handle unit\.sel\.silent@1/,
    );
    await expect(deliverer(reg, row(Audited.type, 1, { n: 1 })).handle(ctx('unit.sel.hooks'))).rejects.toThrow(
      /does not handle unit\.sel\.audited@1/,
    );
  });
  it('deliver of a payload that breaks the schema is a JobPayloadError (C-3)', async () => {
    const reg = await boot([AuditAll]);
    await expect(deliverer(reg, row(Audited.type, 1, { n: 'x' })).handle(ctx('unit.sel.audit'))).rejects.toBeInstanceOf(
      JobPayloadError,
    );
  });
  it('a single-event subscriber still gets exactly its event and nothing else (C-4)', async () => {
    const reg = await boot([OnlySilent]);
    seen.length = 0;
    await deliverer(reg, row(Silent.type, 1, {})).handle(ctx('unit.sel.single'));
    expect(seen).toEqual([{ consumer: 'unit.sel.single', type: Silent.type, data: {} }]);
    await expect(deliverer(reg, row(Audited.type, 1, { n: 1 })).handle(ctx('unit.sel.single'))).rejects.toThrow(
      /does not handle/,
    );
  });
});
```
`OutboxReader`, `OutboxRow` đã được `export` ở `event-dispatch.handlers.ts` (SP1); nếu `OutboxRow` chỉ là `type` nội bộ thì đổi thành `export type` (không đổi hành vi).
`test/unit/core/events/subscriber-registry.spec.ts`: ca `indexes subscribers by consumer and by type@version` đổi dòng khẳng định đầu thành
```ts
    expect(reg.byConsumer('unit.a')?.meta).toMatchObject({ event: Pinged });
```
(`meta` nay là union; truy cập `.event` trực tiếp không còn qua type-check.)

- [ ] **Step 2: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/core/events/deliver-selector.spec.ts`
Expected: FAIL (`AUDITED_EVENTS` chưa export; `DeliverEventHandler` so với `sub.meta.event`).

- [ ] **Step 3: Cài bộ chọn**

`src/core/events/subscriber.decorator.ts` — thay khai báo `SubscriberMeta` (giữ các khai báo khác):
```ts
/** Tập event một subscriber nhận thay vì một `type@version` (spec SP6 §5.3): audit (6B) và webhook (6C). */
export type EventSelector = {
  readonly name: 'audit' | 'webhook';
  matches(def: EventDef): boolean;
};
export const AUDITED_EVENTS: EventSelector = {
  name: 'audit',
  matches: (def) => def.audit,
};
export const WEBHOOK_EVENTS: EventSelector = {
  name: 'webhook',
  matches: (def) => def.webhook,
};
/** Chỉ hai bộ chọn này hợp lệ: bộ chọn tự chế sẽ lặng lẽ nhận event ngoài hợp đồng của cờ. */
export const EVENT_SELECTORS: readonly EventSelector[] = [
  AUDITED_EVENTS,
  WEBHOOK_EVENTS,
];

/**
 * `consumer` là định danh bền của subscriber: khoá Inbox (`processed_events.consumer`) và một phần
 * jobId deliver. Đổi tên nghĩa là mọi event cũ được coi là chưa xử lý với consumer mới.
 * `event`: đúng một `type@version`; `events`: mọi def khớp bộ chọn (handler nhận `EventEnvelope<unknown>`).
 */
export type SubscriberMeta =
  | { consumer: string; event: EventDef }
  | { consumer: string; events: EventSelector };
```
`src/core/events/event-dispatch.handlers.ts`:
- import thêm `eventRegistry` từ `./event-definition.js` và `EVENT_SELECTORS` từ `./subscriber.decorator.js`.
- Thay `type Entry` và class `SubscriberRegistry`:
```ts
type Entry = {
  meta: SubscriberMeta;
  instance: EventHandlerInstance;
  /** Def thuộc tập của subscriber: đúng def của subscriber một-event, hoặc def khớp bộ chọn. */
  accepts: (def: EventDef) => boolean;
};

/** Nạp trong `onModuleInit` (trước mọi `onApplicationBootstrap`), nên đã đầy đủ khi WorkerHost bắt đầu nhận job. */
@Injectable()
export class SubscriberRegistry implements OnModuleInit {
  private readonly consumers = new Map<string, Entry>();
  private readonly events = new Map<string, Entry[]>();
  /** Def có lúc dựng registry. Def định nghĩa sau đó không có subscriber bộ chọn: dispatch ném thay vì bỏ qua (C-2). */
  private known: ReadonlySet<EventDef> = new Set();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const defs = eventRegistry();
    this.known = new Set(defs);
    for (const wrapper of this.discovery.getProviders({
      metadataKey: EventSubscriberMarker.KEY,
    })) {
      const meta = this.discovery.getMetadataByDecorator(
        EventSubscriberMarker,
        wrapper,
      );
      if (!meta) continue;
      if (!CONSUMER_PATTERN.test(meta.consumer))
        throw new Error(
          `@EventSubscriber consumer "${meta.consumer}" must match ${CONSUMER_PATTERN}`,
        );
      if (
        !wrapper.isDependencyTreeStatic() ||
        !isEventHandlerInstance(wrapper.instance)
      )
        throw new Error(
          `@EventSubscriber(${meta.consumer}) class must be a singleton provider implementing handle(e)`,
        );
      if (this.consumers.has(meta.consumer))
        throw new Error(`Duplicate subscriber consumer "${meta.consumer}"`);
      const entry = this.entryOf(meta, wrapper.instance);
      this.consumers.set(meta.consumer, entry);
      for (const def of defs.filter((d) => entry.accepts(d))) {
        const key = eventKey(def.type, def.version);
        this.events.set(key, [...(this.events.get(key) ?? []), entry]);
      }
    }
  }

  private entryOf(
    meta: SubscriberMeta,
    instance: EventHandlerInstance,
  ): Entry {
    if ('events' in meta) {
      const selector = meta.events;
      if (!EVENT_SELECTORS.includes(selector))
        throw new Error(
          `@EventSubscriber(${meta.consumer}) selector must be AUDITED_EVENTS or WEBHOOK_EVENTS`,
        );
      return { meta, instance, accepts: (def) => selector.matches(def) };
    }
    const own = meta.event;
    if (findEvent(own.type, own.version) !== own)
      throw new Error(
        `@EventSubscriber(${meta.consumer}) event ${eventKey(own.type, own.version)} was not created by defineEvent`,
      );
    return { meta, instance, accepts: (def) => def === own };
  }

  byConsumer(consumer: string): Entry | undefined {
    return this.consumers.get(consumer);
  }

  forEvent(type: string, version: number): Entry[] {
    const def = findEvent(type, version);
    if (def && !this.known.has(def))
      throw new Error(
        `Event ${eventKey(type, version)} was defined after the subscriber registry was built; define events at module import time`,
      );
    return this.events.get(eventKey(type, version)) ?? [];
  }
}
```
- Trong `DeliverEventHandler.handle`, thay đoạn từ `const def = sub.meta.event;` tới `const envelope = this.parse(def, row);` bằng:
```ts
    const key = eventKey(row.type, row.version);
    const def = findEvent(row.type, row.version);
    if (!def)
      throw new Error(
        `Event ${key} in outbox row ${outboxId} is not defined in this worker`,
      );
    if (!sub.accepts(def))
      throw new Error(
        `Subscriber "${consumer}" does not handle ${key} in this worker (outbox row ${outboxId})`,
      );
    const envelope = this.parse(def, row);
```
`src/core/events/index.ts`: dòng export subscriber thành
```ts
export {
  AUDITED_EVENTS,
  EventSubscriber,
  WEBHOOK_EVENTS,
  type EventHandler,
  type EventSelector,
} from './subscriber.decorator.js';
```

- [ ] **Step 4: Chạy unit**

Run: `pnpm vitest run --project unit test/unit/core/events`
Expected: PASS (mới + cũ).

- [ ] **Step 5: Integration qua outbox → relay → dispatch → deliver thật**

`test/integration/core/events/selector-subscriber.spec.ts`:
```ts
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RequestContext } from '../../../../src/core/context/index.js';
import { DatabaseModule, OrgScope, UnitOfWork } from '../../../../src/core/database/index.js';
import {
  AUDITED_EVENTS,
  EventPublisher,
  EventSubscriber,
  EventsModule,
  WEBHOOK_EVENTS,
  defineEvent,
  type EventEnvelope,
} from '../../../../src/core/events/index.js';
import { OutboxModule } from '../../../../src/core/outbox/index.js';
import { QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const Data = z.object({ k: z.string() });
const SelAudited = defineEvent({ type: 'fixture.sel.audited', version: 1, schema: Data, audit: true, webhook: false });
const SelHooked = defineEvent({ type: 'fixture.sel.hooked', version: 1, schema: Data, audit: true, webhook: true });
const SelSilent = defineEvent({ type: 'fixture.sel.silent', version: 1, schema: Data, audit: false, webhook: false });

const got: { consumer: string; type: string; k: string }[] = [];
const record = (consumer: string, e: EventEnvelope<unknown>) =>
  got.push({ consumer, type: e.type, k: Data.parse(e.data).k });
@Injectable()
@EventSubscriber({ consumer: 'fixture.sel.audit', events: AUDITED_EVENTS })
class AuditSub {
  async handle(e: EventEnvelope<unknown>) {
    record('fixture.sel.audit', e);
  }
}
@Injectable()
@EventSubscriber({ consumer: 'fixture.sel.hooks', events: WEBHOOK_EVENTS })
class HookSub {
  async handle(e: EventEnvelope<unknown>) {
    record('fixture.sel.hooks', e);
  }
}
@Injectable()
@EventSubscriber({ consumer: 'fixture.sel.single', event: SelSilent })
class SingleSub {
  async handle(e: EventEnvelope<unknown>) {
    record('fixture.sel.single', e);
  }
}
@Module({ providers: [AuditSub, HookSub, SingleSub] })
class Subs {}

/** Thời gian chờ thêm sau khi đủ số lần giao, để bắt lần giao thừa (nếu có). */
const SETTLE_MS = 300;
const until = async (pred: () => boolean, ms = 15_000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('selector subscribers through the real outbox pipeline (spec SP6 §5.3, C-2, C-3, C-4)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'events');
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '50');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }),
      Subs,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  const publishIn = (orgId: string | null, fn: (p: EventPublisher) => Promise<unknown>) =>
    app.get(RequestContext).run({}, () => {
      const inTx = () => app.get(UnitOfWork).run(() => fn(app.get(EventPublisher)));
      return orgId ? app.get(OrgScope).run(orgId, inTx) : inTx();
    });
  const input = (k: string) => ({
    data: { k },
    aggregate: { type: 'fixture', id: k, version: 1 },
    actor: { type: 'system' as const, id: 'fixture' },
  });

  it('audit gets audit:true events, webhook gets webhook:true events, the single subscriber gets only its event', async () => {
    const k = v7();
    await publishIn(v7(), async (p) => {
      await p.publish(SelAudited, input(`${k}-a`));
      await p.publish(SelHooked, input(`${k}-h`));
      await p.publish(SelSilent, input(`${k}-s`));
    });
    const mine = () => got.filter((g) => g.k.startsWith(k));
    await until(() => mine().length === 4);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(mine().map((g) => `${g.consumer}:${g.type}`).sort()).toEqual(
      [
        'fixture.sel.audit:fixture.sel.audited',
        'fixture.sel.audit:fixture.sel.hooked',
        'fixture.sel.hooks:fixture.sel.hooked',
        'fixture.sel.single:fixture.sel.silent',
      ].sort(),
    );
  });
  it('a webhook event published outside an organization is refused inside the caller transaction', async () => {
    await expect(publishIn(null, (p) => p.publish(SelHooked, input(v7())))).rejects.toThrow(
      /must be published inside an organization context/,
    );
  });
});
```
Run: `pnpm vitest run --project integration test/integration/core/events/selector-subscriber.spec.ts`
Expected: PASS. (RED của đường này đã thấy ở Step 2 bằng unit; file integration viết sau khi có export nên chạy xanh ngay — ghi rõ trong báo cáo task.)

- [ ] **Step 6: Không hồi quy SP1/SP2**

Run: `pnpm vitest run --project integration test/e2e/core/events.e2e.spec.ts test/integration/core/queue test/integration/identity test/integration/notifications`
Expected: PASS (subscriber một-event của identity/notifications/fixture chạy như cũ — C-4).

- [ ] **Step 7: Commit**

```bash
git add src/core/events test/unit/core/events test/integration/core/events
git commit -m "feat(events): selector subscribers for AUDITED_EVENTS and WEBHOOK_EVENTS; deliver checks the row def against the subscriber set"
```

---

### Task 5: `routeTemplateOf` sang `core/http`, `DEFINER_LIMIT_MAX`/`PURGE_CURSOR_START` sang `core/sweep`, hợp đồng `core/contracts/admin-readers.ts`; luật kiến trúc 23, 27 (C-9)

**Files:**
- Create: `src/core/http/route-template.ts`, `src/core/sweep/constants.ts`, `src/core/sweep/index.ts`, `src/core/contracts/admin-readers.ts`, `test/unit/core/http/route-template.spec.ts`, `test/unit/core/contracts/admin-readers.spec.ts`, `test/architecture/fixtures/src/core/contracts/runtime-import.ts`, `test/architecture/fixtures/src/core/contracts/imports-module.ts`, `test/architecture/fixtures/src/core/contracts/types-ok.ts`, `test/architecture/fixtures/src/modules/tenancy/uses-audit.ts`, `test/architecture/fixtures/src/modules/audit/index.ts`
- Modify: `src/core/http/index.ts`, `src/modules/tenancy/http/org-route.ts`, `src/modules/tenancy/constants.ts`, `.dependency-cruiser.cjs`, `test/unit/architecture/rules.spec.ts`, `test/architecture/fixtures/src/modules/billing/index.ts` (nếu cần kiểu `Billing`)

**Interfaces:**
- Consumes: `routeTemplateOf`, `normalizeTemplate` (3A `tenancy/http/org-route.ts`), `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` (3A `tenancy/constants.ts`).
- Produces:
  - `core/http`: `routeTemplateOf(controller: Function, handler: Function): string[]`, `normalizeTemplate(path: string): string` (không đổi hành vi) — 3D (`PlatformStaffGuard`, addendum §A3) và 6B (`PlatformStaffRouteInventory`) dùng; tenancy re-export từ `org-route.ts`.
  - `core/sweep/constants.ts`: `DEFINER_LIMIT_MAX = 1000`, `PURGE_CURSOR_START = '00000000-0000-0000-0000-000000000000'`; `core/sweep/index.ts` export hai hằng (Task 11 bổ sung); `tenancy/constants.ts` re-export đúng giá trị.
  - `src/core/contracts/admin-readers.ts`: `abstract class FileUsageReader { abstract storageUsedBytes(): Promise<number> }`, `abstract class WebhookStatsReader { abstract endpointCount(): Promise<number> }`.
  - Luật depcruise `foundation-modules-independent-of-sp6` (23), `core-contracts-types-only` (27).

- [ ] **Step 1: Test core (fail)**

`test/unit/core/http/route-template.spec.ts`:
```ts
import { Controller, Get, Post } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  normalizeTemplate,
  routeTemplateOf,
} from '../../../../src/core/http/index.js';
import {
  DEFINER_LIMIT_MAX,
  PURGE_CURSOR_START,
} from '../../../../src/core/sweep/index.js';
import * as tenancyConstants from '../../../../src/modules/tenancy/constants.js';
import * as tenancyRoute from '../../../../src/modules/tenancy/http/org-route.js';

@Controller('v1/orgs')
class SplitCtl {
  @Get(':orgId/x') x() {}
  @Post() create() {}
}
@Controller('/v1/orgs/:orgId/')
class SlashCtl {
  @Get() get() {}
}
@Controller('V1/ORGS/:orgId')
class UpperCtl {
  @Post('Restore') restore() {}
}
@Controller(['v1/orgs/:id/x', 'v1/other'])
class MultiCtl {
  @Get() list() {}
}
@Controller('v1/admin/orgs')
class AdminCtl {
  @Get(':orgId/members') members() {}
}

describe('routeTemplateOf in core/http (spec SP6 §5.3, C-9)', () => {
  it('gives the same templates as the SP3 §7.4 sample set', () => {
    expect(routeTemplateOf(SplitCtl, SplitCtl.prototype.x)).toEqual(['v1/orgs/:orgId/x']);
    expect(routeTemplateOf(SplitCtl, SplitCtl.prototype.create)).toEqual(['v1/orgs']);
    expect(routeTemplateOf(SlashCtl, SlashCtl.prototype.get)).toEqual(['v1/orgs/:orgId']);
    expect(routeTemplateOf(UpperCtl, UpperCtl.prototype.restore)).toEqual(['v1/orgs/:orgId/restore']);
    expect(routeTemplateOf(MultiCtl, MultiCtl.prototype.list)).toEqual(['v1/orgs/:id/x', 'v1/other']);
    expect(routeTemplateOf(AdminCtl, AdminCtl.prototype.members)).toEqual(['v1/admin/orgs/:orgId/members']);
    expect(normalizeTemplate('//V1//Admin/:orgId/')).toBe('v1/admin/:orgId');
  });
  it('tenancy re-exports the very same functions and constant values', () => {
    expect(tenancyRoute.routeTemplateOf).toBe(routeTemplateOf);
    expect(tenancyRoute.normalizeTemplate).toBe(normalizeTemplate);
    expect(tenancyConstants.DEFINER_LIMIT_MAX).toBe(DEFINER_LIMIT_MAX);
    expect(tenancyConstants.PURGE_CURSOR_START).toBe(PURGE_CURSOR_START);
    expect([DEFINER_LIMIT_MAX, PURGE_CURSOR_START]).toEqual([1000, '00000000-0000-0000-0000-000000000000']);
  });
});
```
`test/unit/core/contracts/admin-readers.spec.ts`:
```ts
import { Injectable, Module, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  FileUsageReader,
  WebhookStatsReader,
} from '../../../../src/core/contracts/admin-readers.js';

/** Như dịch vụ org của admin (6D): hai số liệu tuỳ chọn, vắng module thì `null` (R-X16, S6-A52). */
@Injectable()
class Consumer {
  constructor(
    @Optional() readonly files?: FileUsageReader,
    @Optional() readonly hooks?: WebhookStatsReader,
  ) {}
  async stats() {
    return {
      storageUsedBytes: this.files ? await this.files.storageUsedBytes() : null,
      webhookEndpoints: this.hooks ? await this.hooks.endpointCount() : null,
    };
  }
}
/** Số byte giả của provider fixture. */
const FAKE_BYTES = 1024;
@Injectable()
class FakeFiles extends FileUsageReader {
  async storageUsedBytes() {
    return FAKE_BYTES;
  }
}
@Module({
  providers: [FakeFiles, { provide: FileUsageReader, useExisting: FakeFiles }],
  exports: [FileUsageReader],
})
class FilesPorts {}

describe('core/contracts admin readers (R-X16)', () => {
  it('are abstract DI tokens: no provider → the optional field is null; a provider → its value', async () => {
    const without = await Test.createTestingModule({ providers: [Consumer] }).compile();
    expect(await without.get(Consumer).stats()).toEqual({ storageUsedBytes: null, webhookEndpoints: null });
    const withFiles = await Test.createTestingModule({ imports: [FilesPorts], providers: [Consumer] }).compile();
    expect(await withFiles.get(Consumer).stats()).toEqual({ storageUsedBytes: FAKE_BYTES, webhookEndpoints: null });
  });
});
```
Run: `pnpm vitest run --project unit test/unit/core/http/route-template.spec.ts test/unit/core/contracts/admin-readers.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Chuyển code**

`src/core/http/route-template.ts` (thân chuyển nguyên văn từ `tenancy/http/org-route.ts` của 3A):
```ts
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';

/**
 * Template route của một handler (spec SP3 §7.4; chuyển vào core ở SP6 6.0 vì identity — `@PlatformStaffAction()` của 3D,
 * `PlatformStaffRouteInventory` của 6B — không được import tenancy). Hành vi không đổi so với bản của tenancy.
 */
const reflector = new Reflector();

const pathsOf = (target: Function): string[] => {
  const v = reflector.get<string | string[] | undefined>(PATH_METADATA, target);
  return v === undefined ? [''] : Array.isArray(v) ? v : [v];
};

/** Bỏ `/` đầu/cuối, gộp `//`, chữ thường segment tĩnh (router Express không phân biệt hoa thường); giữ tên tham số. */
export const normalizeTemplate = (path: string): string =>
  path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (s.startsWith(':') ? s : s.toLowerCase()))
    .join('/');

/** Mọi template (tích của path class × path method) của một handler. */
export const routeTemplateOf = (
  controller: Function,
  handler: Function,
): string[] =>
  pathsOf(controller).flatMap((c) =>
    pathsOf(handler).map((h) => normalizeTemplate(`${c}/${h}`)),
  );
```
`src/core/http/index.ts` thêm: `export { normalizeTemplate, routeTemplateOf } from './route-template.js';`

`src/modules/tenancy/http/org-route.ts`: xoá `import { PATH_METADATA } …`, `import { Reflector } …`, `const reflector`, `pathsOf`, `normalizeTemplate`, `routeTemplateOf`; thêm ở đầu file:
```ts
import { routeTemplateOf } from '../../../core/http/index.js';

/** Chuyển vào `core/http` ở SP6 6.0; giữ export ở đây để code viết theo SP3 không vỡ (spec SP6 §5.3, §18.3). */
export { normalizeTemplate, routeTemplateOf } from '../../../core/http/index.js';
```
(giữ dòng `import { routeTemplateOf }` chỉ khi file còn dùng nó nội bộ; nếu không, xoá dòng import và chỉ giữ dòng `export … from`.)

`src/core/sweep/constants.ts`:
```ts
/**
 * Trần `p_limit` của mọi hàm definer (spec SP3 §6.14 DB-M3, SP6 §6.8; `RAISE` khi vượt). Migration viết cứng cùng giá trị
 * (migration không import code); test khoá hai phía. Chuyển từ tenancy ở SP6 6.0 (tenancy và `OrgSweepRunner` cùng dùng).
 */
export const DEFINER_LIMIT_MAX = 1000;
/** Con trỏ keyset lượt đầu của mọi lượt quét xuyên org (UUID nil, nhỏ hơn mọi UUID v7; SP3 CDX-8). */
export const PURGE_CURSOR_START = '00000000-0000-0000-0000-000000000000';
```
`src/core/sweep/index.ts`:
```ts
export { DEFINER_LIMIT_MAX, PURGE_CURSOR_START } from './constants.js';
```
`src/modules/tenancy/constants.ts`: xoá hai khai báo `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` (cùng chú thích) và thêm:
```ts
/**
 * Chuyển vào `core/sweep` ở SP6 6.0. Import file lá `constants.ts` (không phải index của `core/sweep`): `domain/` của tenancy
 * import file này và không được kéo theo runner/queue.
 */
export {
  DEFINER_LIMIT_MAX,
  PURGE_CURSOR_START,
} from '../../core/sweep/constants.js';
```
`src/core/contracts/admin-readers.ts`:
```ts
/**
 * Hợp đồng đọc số liệu cho module admin (spec SP6 §5.2, R-X16, S6-A52). Chỉ `abstract class` làm token DI, không import gì,
 * không provider nào ở core. files (6A) và integrations (6C) cài bằng module `@Global()` của mình trong `forApi()`; admin (6D)
 * inject `@Optional()`: module bị tắt → không có provider → trường tương ứng của `AdminOrg` là `null`. Admin không import
 * `index.ts` của files/integrations. Cả hai phương thức chạy trong `OrgScope` của caller.
 */
export abstract class FileUsageReader {
  /** Tổng byte đang lưu của org hiện tại (gốc + `clean` + thumbnail + bản public, spec SP6 §6.3). */
  abstract storageUsedBytes(): Promise<number>;
}

export abstract class WebhookStatsReader {
  /** Số webhook endpoint chưa xoá của org hiện tại. */
  abstract endpointCount(): Promise<number>;
}
```

- [ ] **Step 3: Luật kiến trúc 23 và 27 (fixture phải fail)**

`test/architecture/fixtures/src/modules/audit/index.ts`:
```ts
export const auditPublic = 'audit';
```
`test/architecture/fixtures/src/modules/tenancy/uses-audit.ts`:
```ts
import { auditPublic } from '../audit/index.ts';

export const leak = auditPublic;
```
`test/architecture/fixtures/src/core/contracts/runtime-import.ts`:
```ts
import { owner } from '../flags/ok.ts';

export const leaked = owner;
export abstract class LeakyReader {
  abstract read(): Promise<string>;
}
```
`test/architecture/fixtures/src/core/contracts/imports-module.ts`:
```ts
import type { Billing } from '../../modules/billing/index.ts';

export abstract class ModuleReader {
  abstract read(): Promise<Billing>;
}
```
(nếu `modules/billing/index.ts` của fixture chưa export kiểu `Billing`, thêm `export type Billing = { id: string };` vào đó.)
`test/architecture/fixtures/src/core/contracts/types-ok.ts`:
```ts
import type { owner } from '../flags/ok.ts';

export abstract class TypedReader {
  abstract read(): Promise<typeof owner>;
}
```
`.dependency-cruiser.cjs`, thêm sau luật `notifications-independent-of-identity`:
```js
    {
      name: 'foundation-modules-independent-of-sp6',
      severity: 'error',
      comment:
        'SP6 rule 23: identity, tenancy and notifications never import files, audit, integrations or admin (they talk through events and ports).',
      from: { path: '(^|/)src/modules/(identity|tenancy|notifications)/' },
      to: { path: '(^|/)src/modules/(files|audit|integrations|admin)/' },
    },
    {
      name: 'core-contracts-types-only',
      severity: 'error',
      comment:
        'SP6 rule 27 (R-X16): src/core/contracts holds only types and abstract classes; a runtime import would drag code into every consumer.',
      from: { path: '(^|/)src/core/contracts/' },
      to: { dependencyTypesNot: ['type-only'] },
    },
```
và trong `no-orphans.from.pathNot` thêm (trước dòng dot files):
```js
          // SP6 plan 6.0: token hợp đồng cho admin (FileUsageReader, WebhookStatsReader), chưa module nào của src cài/inject
          // cho tới 6A/6C; plan đầu tiên import nó (6A hoặc 6C) xoá ngoại lệ này.
          '(^|/)src/core/contracts/admin-readers[.]ts$',
```
`test/unit/architecture/rules.spec.ts`: thêm vào bảng `it.each`:
```ts
    ['foundation-modules-independent-of-sp6', 'modules/tenancy/uses-audit.ts'],
    ['core-contracts-types-only', 'core/contracts/runtime-import.ts'],
    ['core-independent', 'core/contracts/imports-module.ts'],
```
Ca `allows public APIs…` giữ nguyên (`types-ok.ts` khớp `ok\.ts$` và không vi phạm vì chỉ `import type`).

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/core/http/route-template.spec.ts test/unit/core/contracts test/unit/architecture test/unit/modules/tenancy
pnpm arch
pnpm typecheck
```
Expected: PASS; `org-route.spec.ts` của tenancy chạy nguyên văn và xanh (C-9); `definer-functions.spec.ts` của 3A (khoá `DEFINER_LIMIT_MAX` hai phía, import từ `tenancy/constants.ts`) xanh; `pnpm arch` sạch; ca `real source tree has no violations` xanh.

- [ ] **Step 5: Commit**

```bash
git add src/core/http src/core/sweep src/core/contracts src/modules/tenancy/http/org-route.ts src/modules/tenancy/constants.ts .dependency-cruiser.cjs test/unit/core/http/route-template.spec.ts test/unit/core/contracts test/unit/architecture/rules.spec.ts test/architecture/fixtures/src
git commit -m "refactor(core): routeTemplateOf to core/http and sweep constants to core/sweep with tenancy re-exports; core/contracts admin readers; rules 23 and 27"
```

---

### Task 6: Body parser nhiều chủ `@BodyParserOwner`; identity chuyển sang marker (C-7)

**Files:**
- Modify: `src/core/http/body-parser-policy.ts`, `src/core/http/json-body-parser.ts`, `src/core/http/content-type.middleware.ts`, `src/core/http/http-bootstrap.ts`, `src/core/http/http.module.ts`, `src/core/http/index.ts`, `src/modules/identity/infra/better-auth/better-auth-api.module.ts`, `test/unit/core/http/body-parser-policy.spec.ts`, `test/unit/core/http/json-body-parser.spec.ts`, `test/e2e/core/body-parser-ownership.e2e.spec.ts`
- Create: `src/modules/identity/infra/better-auth/body-parser-owner.ts`

**Interfaces:**
- Consumes: `identityConfig().basePath`, `httpConfig().allowedContentTypes` (SP2), `DiscoveryService` (Nest).
- Produces:
  - `BodyParserOwner(meta: BodyParserOwnerMeta): ClassDecorator` với `BodyParserOwnerMeta = { owner: string; prefix: () => string; contentTypes: () => readonly string[] }` — 6A đặt trên provider của `/v1/file-uploads` (`contentTypes: () => ['application/octet-stream']`).
  - `BodyParserPolicy.rules(): readonly BodyParserRule[]` (quét Discovery một lần; trùng/lồng, prefix sai dạng, media type sai, provider không singleton → ném), `BodyParserPolicy.ruleFor(path: string): BodyParserRule | undefined`, `type BodyParserRule = { owner; prefix; contentTypes }`.
  - `jsonBodyParser(cfg, { skipPathPrefixes?: readonly string[] })`, `requestPath(req): string` (pathname gốc chữ thường).
  - `HTTP_BODY_PARSER_SKIP_PREFIX` bị xoá khỏi core và identity.

- [ ] **Step 1: Unit test policy (fail)**

`test/unit/core/http/body-parser-policy.spec.ts` (thay toàn bộ file):
```ts
import { Injectable, Scope, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  BodyParserOwner,
  BodyParserPolicy,
  type BodyParserOwnerMeta,
} from '../../../../src/core/http/body-parser-policy.js';

const JSON_TYPES = () => ['application/json'];
const owner = (meta: BodyParserOwnerMeta, scope = Scope.DEFAULT): Type<unknown> => {
  @Injectable({ scope })
  @BodyParserOwner(meta)
  class Owner {}
  return Owner;
};
const named = (name: string, prefix: string) => owner({ owner: name, prefix: () => prefix, contentTypes: JSON_TYPES });
async function rules(...owners: Type<unknown>[]) {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [BodyParserPolicy, ...owners],
  }).compile();
  try {
    const policy = ref.get(BodyParserPolicy);
    return { rules: policy.rules(), ruleFor: (p: string) => policy.ruleFor(p)?.owner };
  } finally {
    await ref.close();
  }
}

describe('BodyParserPolicy with many owners (spec SP6 §5.3 core/http, C-7)', () => {
  it('no owner → no rule; core parses every path', async () => {
    expect((await rules()).rules).toEqual([]);
  });
  it('two owners with disjoint prefixes; ruleFor matches by whole segment, lower-cased', async () => {
    const r = await rules(
      named('identity', '/api/auth'),
      owner({ owner: 'files', prefix: () => '/v1/File-Uploads', contentTypes: () => ['application/octet-stream'] }),
    );
    expect(r.rules.map((x) => [x.owner, x.prefix, x.contentTypes]).sort()).toEqual(
      [
        ['files', '/v1/file-uploads', ['application/octet-stream']],
        ['identity', '/api/auth', ['application/json']],
      ].sort(),
    );
    expect(r.ruleFor('/api/auth')).toBe('identity');
    expect(r.ruleFor('/api/auth/sign-in/email')).toBe('identity');
    expect(r.ruleFor('/v1/file-uploads/tok')).toBe('files');
    expect(r.ruleFor('/v1/orgs')).toBeUndefined();
  });
  it('a nested prefix fails boot naming both owners', async () => {
    const err = await rules(named('a', '/owned'), named('b', '/owned/deeper')).then(
      () => undefined,
      (e: unknown) => String(e),
    );
    expect(err).toMatch(/Body parser prefixes overlap/);
    expect(err).toMatch(/"\/owned" \(a\)/);
    expect(err).toMatch(/"\/owned\/deeper" \(b\)/);
  });
  it('prefixes that differ only by case overlap (Express routes case-insensitively; Review Focus 1)', async () => {
    await expect(rules(named('a', '/Uploads'), named('b', '/uploads'))).rejects.toThrow(/overlap/);
  });
  it('a sibling prefix that only shares characters does not overlap (Review Focus 1)', async () => {
    const r = await rules(named('a', '/api/auth'), named('b', '/api/authx'));
    expect([r.ruleFor('/api/authx/y'), r.ruleFor('/api/auth/y')]).toEqual(['b', 'a']);
  });
  it.each(['', 'api/auth', '/', '/api/auth/', '/api?x=1', '/api#frag'])('fails boot on malformed prefix %j', async (prefix) => {
    await expect(rules(named('a', prefix))).rejects.toThrow(/prefix must start with "\/"/);
  });
  it.each([[[]], [['Application/JSON']], [['application/json; charset=utf-8']]])(
    'fails boot on content types %j',
    async (types) => {
      await expect(rules(owner({ owner: 'a', prefix: () => '/x', contentTypes: () => types }))).rejects.toThrow(
        /contentTypes must be lower-case media types without parameters/,
      );
    },
  );
  it('fails boot on a malformed owner name or a request-scoped owner', async () => {
    await expect(rules(named('Bad Owner', '/x'))).rejects.toThrow(/owner must match/);
    await expect(rules(owner({ owner: 'a', prefix: () => '/x', contentTypes: JSON_TYPES }, Scope.REQUEST))).rejects.toThrow(
      /must be on a singleton provider/,
    );
  });
});
```
Run: `pnpm vitest run --project unit test/unit/core/http/body-parser-policy.spec.ts`
Expected: FAIL (`BodyParserOwner` chưa có).

- [ ] **Step 2: Cài policy, parser, middleware**

`src/core/http/body-parser-policy.ts` (thay toàn bộ file):
```ts
import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

export type BodyParserOwnerMeta = {
  /** Tên module chủ, chỉ để báo lỗi. */
  owner: string;
  /** Pathname module tự đọc body. Thunk: đọc lúc `rules()`, sau khi config đã validate (registry chạy lúc import). */
  prefix: () => string;
  /** Media type (chữ thường, không tham số) mà prefix nhận; `ContentTypeMiddleware` dùng thay allowlist chung. */
  contentTypes: () => readonly string[];
};
export type BodyParserRule = {
  readonly owner: string;
  readonly prefix: string;
  readonly contentTypes: readonly string[];
};

export const BodyParserOwnerMarker =
  DiscoveryService.createDecorator<BodyParserOwnerMeta>();

/**
 * Module tự đọc body dưới một prefix (identity: `AUTH_BASE_PATH`, kiểm đa credential + CSRF trước khi đọc, spec SP2 §5.5;
 * files 6A: upload qua API) đặt marker này lên MỘT provider singleton của mình. Core bỏ qua mọi prefix đã đăng ký.
 * Thay token đơn chủ `HTTP_BODY_PARSER_SKIP_PREFIX` (spec SP6 §5.3): DI của Nest không báo trùng token, marker thì có.
 */
export const BodyParserOwner = (meta: BodyParserOwnerMeta): ClassDecorator =>
  BodyParserOwnerMarker(meta);

/** Bắt đầu bằng `/`, không kết thúc bằng `/`, không có `?`/`#` (so khớp với pathname, xem `jsonBodyParser`). */
const WELL_FORMED_PREFIX = /^\/[^?#]*[^/?#]$/;
const OWNER_NAME = /^[a-z][a-z0-9-]*$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** `path` là `prefix` hoặc nằm dưới nó theo segment (`/api/authx` không nằm dưới `/api/auth`). */
const within = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

function checked(meta: BodyParserOwnerMeta): BodyParserRule {
  if (!OWNER_NAME.test(meta.owner))
    throw new Error(
      `@BodyParserOwner owner must match ${OWNER_NAME}, got ${JSON.stringify(meta.owner)}`,
    );
  const prefix = meta.prefix();
  if (!WELL_FORMED_PREFIX.test(prefix))
    throw new Error(
      `@BodyParserOwner(${meta.owner}) prefix must start with "/", must not end with "/" and must not contain "?" or "#", got ${JSON.stringify(prefix)}`,
    );
  const contentTypes = meta.contentTypes();
  if (contentTypes.length === 0 || contentTypes.some((t) => !MEDIA_TYPE.test(t)))
    throw new Error(
      `@BodyParserOwner(${meta.owner}) contentTypes must be lower-case media types without parameters, got ${JSON.stringify(contentTypes)}`,
    );
  // Chữ thường: routing mặc định của Express không phân biệt hoa thường, nên hai prefix khác hoa thường là MỘT prefix.
  return {
    owner: meta.owner,
    prefix: prefix.toLowerCase(),
    contentTypes: [...contentTypes],
  };
}

@Injectable()
export class BodyParserPolicy {
  private cached?: readonly BodyParserRule[];

  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Quét provider mang marker một lần (lần gọi đầu là `applyHttpDefaults`, trước `app.init()`: container đã dựng xong trong
   * `NestFactory.create`). Sai → ném, app không khởi động.
   */
  rules(): readonly BodyParserRule[] {
    this.cached ??= this.discover();
    return this.cached;
  }

  /** Rule của prefix chứa `path` (pathname chữ thường, `requestPath`), nếu có. */
  ruleFor(path: string): BodyParserRule | undefined {
    return this.rules().find((r) => within(path, r.prefix));
  }

  private discover(): readonly BodyParserRule[] {
    const rules: BodyParserRule[] = [];
    for (const wrapper of this.discovery.getProviders({
      metadataKey: BodyParserOwnerMarker.KEY,
    })) {
      const meta = this.discovery.getMetadataByDecorator(
        BodyParserOwnerMarker,
        wrapper,
      );
      if (!meta) continue;
      if (!wrapper.isDependencyTreeStatic())
        throw new Error(
          `@BodyParserOwner(${meta.owner}) must be on a singleton provider`,
        );
      rules.push(checked(meta));
    }
    rules.forEach((a, i) => {
      for (const b of rules.slice(i + 1))
        if (within(a.prefix, b.prefix) || within(b.prefix, a.prefix))
          throw new Error(
            `Body parser prefixes overlap: "${a.prefix}" (${a.owner}) and "${b.prefix}" (${b.owner})`,
          );
    });
    return rules;
  }
}
```
`src/core/http/json-body-parser.ts`:
- đổi tên hằng `originalPath` thành `requestPath` và `export` nó (giữ nguyên thân và chú thích).
- chữ ký và đoạn đầu của `jsonBodyParser`:
```ts
export function jsonBodyParser(
  cfg: ConfigOf<typeof httpConfig>,
  opts: { skipPathPrefixes?: readonly string[] } = {},
): NodeMiddleware {
  const prefixes = (opts.skipPathPrefixes ?? []).map((p) => p.toLowerCase());
  const unsupported = (detail: string) =>
    new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, { detail });
  return (req, res, next) => {
    const path = requestPath(req);
    if (prefixes.some((p) => path === p || path.startsWith(`${p}/`)))
      return next();
```
(phần còn lại giữ nguyên; chú thích "prefix đã uỷ quyền" đổi thành "các prefix đã uỷ quyền (`@BodyParserOwner`)").

`src/core/http/http-bootstrap.ts`:
```ts
  app.use(
    jsonBodyParser(cfg, {
      skipPathPrefixes: app
        .get(BodyParserPolicy)
        .rules()
        .map((r) => r.prefix),
    }),
  );
```
`src/core/http/content-type.middleware.ts` (thay toàn bộ file):
```ts
import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { BodyParserPolicy } from './body-parser-policy.js';
import { isAllowedContentType, requestHasBody } from './content-type.js';
import { httpConfig } from './http.config.js';
import { requestPath } from './json-body-parser.js';
import { lingerIfBodyUnread } from './unread-body.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Body chỉ được là một trong các Content-Type cho phép, khác → 415. Dưới prefix có chủ (`@BodyParserOwner`) dùng
 * `contentTypes` của chủ đó (vd. upload qua API chỉ nhận `application/octet-stream`); ngoài ra dùng allowlist chung.
 * Chặn cả `application/x-www-form-urlencoded` mà Express vẫn parse mặc định.
 * 415 trả từ header, body chưa đọc: đọc bỏ có giới hạn (`lingerIfBodyUnread`, S2-R50). Đây là đường 415 của
 * các prefix mà core không đọc body (`/api/auth/*`), vì middleware này chạy trước mount.
 */
@Injectable()
export class ContentTypeMiddleware implements NestMiddleware {
  constructor(
    @Inject(httpConfig.KEY)
    private readonly cfg: ConfigOf<typeof httpConfig>,
    private readonly policy: BodyParserPolicy,
  ) {}

  use(
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void {
    if (
      !METHODS_WITH_BODY.has(req.method ?? '') ||
      !requestHasBody(req.headers)
    )
      return next();
    const allowed =
      this.policy.ruleFor(requestPath(req))?.contentTypes ??
      this.cfg.allowedContentTypes;
    if (!isAllowedContentType(req.headers, allowed)) {
      lingerIfBodyUnread(req, res, this.cfg);
      return next(
        new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, {
          detail: `Content-Type must be one of: ${allowed.join(', ')}`,
        }),
      );
    }
    next();
  }
}
```
`src/core/http/http.module.ts`: thêm `DiscoveryModule` (import từ `@nestjs/core`, cạnh `APP_GUARD`) vào `imports` — `DiscoveryModule` không `@Global`, module có provider dùng `DiscoveryService` phải import nó.
`src/core/http/index.ts`: thay `export { HTTP_BODY_PARSER_SKIP_PREFIX } from './body-parser-policy.js';` bằng
```ts
export {
  BodyParserOwner,
  BodyParserPolicy,
  type BodyParserOwnerMeta,
  type BodyParserRule,
} from './body-parser-policy.js';
```
và dòng `jsonBodyParser` thành `export { jsonBodyParser, requestPath, type NodeMiddleware } from './json-body-parser.js';`

- [ ] **Step 3: Identity chuyển sang marker**

`src/modules/identity/infra/better-auth/body-parser-owner.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { BodyParserOwner, httpConfig } from '../../../../core/http/index.js';
import { identityConfig } from '../../identity.config.js';

/**
 * Core bỏ qua `AUTH_BASE_PATH` khi đọc body: `AuthMountMiddleware` kiểm đa credential + CSRF rồi mới đọc (spec SP2 §5.5).
 * Content-Type = allowlist chung, nên hành vi không đổi so với token cũ (spec SP6 §5.3, §18.2).
 */
@Injectable()
@BodyParserOwner({
  owner: 'identity',
  prefix: () => identityConfig().basePath,
  contentTypes: () => httpConfig().allowedContentTypes,
})
export class IdentityBodyParserOwner {}
```
`src/modules/identity/infra/better-auth/better-auth-api.module.ts`: xoá import `HTTP_BODY_PARSER_SKIP_PREFIX`, xoá provider `{ provide: HTTP_BODY_PARSER_SKIP_PREFIX, … }` và dòng `exports: [HTTP_BODY_PARSER_SKIP_PREFIX]`; thêm `IdentityBodyParserOwner` (import từ `./body-parser-owner.js`) vào `providers`. Chú thích class: "Core bỏ qua `AUTH_BASE_PATH` khi đọc body qua marker `@BodyParserOwner` (`IdentityBodyParserOwner`): `AuthMountMiddleware` kiểm đa credential + CSRF rồi mới đọc (spec §5.5)."

`test/unit/core/http/json-body-parser.spec.ts`: `jsonBodyParser(limitedCfg(), { skipPathPrefix: SKIP_PREFIX })` → `jsonBodyParser(limitedCfg(), { skipPathPrefixes: [SKIP_PREFIX] })`.

- [ ] **Step 4: E2E hai chủ trên route Nest (sửa + thêm ca)**

`test/e2e/core/body-parser-ownership.e2e.spec.ts`:
- import: bỏ `HTTP_BODY_PARSER_SKIP_PREFIX` và `Global`; thêm `BodyParserOwner` vào import từ `../../../src/core/http/index.js`, thêm `Injectable`, `type Type` vào import từ `@nestjs/common`, thêm `buildTestApp` vào import từ `../../support/app-factory.js`.
- thêm vào `EchoController`:
```ts
  /** Chủ thứ hai (như upload qua API của 6A): tự đọc byte octet-stream. */
  @Post('raw/echo') async raw(@Req() req: IncomingMessage) {
    return { selfRead: (await getRawBody(req)).toString('utf8') };
  }
```
- thay `OwnerModule` bằng:
```ts
@Injectable()
@BodyParserOwner({ owner: 'fixture-json', prefix: () => '/owned', contentTypes: () => ['application/json'] })
class JsonOwner {}
@Module({ providers: [JsonOwner] })
class OwnerModule {}
@Injectable()
@BodyParserOwner({ owner: 'fixture-raw', prefix: () => '/raw', contentTypes: () => ['application/octet-stream'] })
class RawOwner {}
@Module({ providers: [RawOwner] })
class RawOwnerModule {}
@Injectable()
@BodyParserOwner({ owner: 'fixture-nested', prefix: () => '/owned/deeper', contentTypes: () => ['application/json'] })
class NestedOwner {}
@Module({ providers: [NestedOwner] })
class NestedOwnerModule {}
```
- trong `make`, bộ lọc `extra.filter((m): m is typeof OwnerModule => typeof m === 'function')` đổi thành `extra.filter((m): m is Type<unknown> => typeof m === 'function')`.
- thêm hai ca:
```ts
  it('a second owner reads its own octet-stream bytes; JSON on its prefix is 415; octet-stream elsewhere is 415 (C-7)', async () => {
    const a = await make([OwnerModule, RawOwnerModule]);
    const server = a.getHttpServer();
    expect(
      (
        await request(server)
          .post('/raw/echo')
          .set('content-type', 'application/octet-stream')
          .send(Buffer.from('raw-bytes'))
          .expect(201)
      ).body,
    ).toEqual({ selfRead: 'raw-bytes' });
    await request(server).post('/raw/echo').set('content-type', 'application/json').send(OWNED_JSON).expect(415);
    await request(server).post('/echo').set('content-type', 'application/octet-stream').send(Buffer.from('x')).expect(415);
    expect((await request(server).post('/owned/echo').send({ a: 1 }).expect(201)).body).toEqual({
      body: null,
      selfRead: OWNED_JSON,
    });
  });
  it('overlapping owners refuse to boot, naming both', async () => {
    vi.stubEnv('HTTP_BODY_LIMIT', `${LIMIT_BYTES}b`);
    const built = await buildTestApp([RedisModule, HttpModule, EchoModule, OwnerModule, NestedOwnerModule]);
    try {
      let err: unknown;
      try {
        applyHttpDefaults(built);
      } catch (e) {
        err = e;
      }
      expect(String(err)).toMatch(/Body parser prefixes overlap/);
      expect(String(err)).toMatch(/fixture-json/);
      expect(String(err)).toMatch(/fixture-nested/);
    } finally {
      await built.close();
    }
  });
```

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/core/http
pnpm vitest run --project integration test/e2e/core/body-parser-ownership.e2e.spec.ts test/e2e/identity test/integration/identity
pnpm typecheck && pnpm arch
grep -rn HTTP_BODY_PARSER_SKIP_PREFIX src test
```
Expected: PASS; mọi e2e mount của SP2 (đọc body sau kiểm CSRF, 415 ở `/api/auth/*` trước mount, 413 theo stream) xanh — identity chuyển marker không đổi hành vi; `grep` không còn kết quả.

- [ ] **Step 6: Commit**

```bash
git add src/core/http src/modules/identity/infra/better-auth test/unit/core/http test/e2e/core/body-parser-ownership.e2e.spec.ts
git commit -m "feat(http): many body parser owners through the @BodyParserOwner marker with per-prefix content types; identity uses it"
```

---

### Task 7: `OrgMutationLock` của tenancy; kiểm chứng prod-like #1 (core `events`/`http`, tenancy)

**Files:**
- Create: `src/modules/tenancy/ports/org-mutation-lock.ts`, `src/modules/tenancy/application/org-mutation-lock.service.ts`, `test/integration/tenancy/org-mutation-lock.spec.ts`
- Modify: `src/modules/tenancy/tenancy.module.ts`, `src/modules/tenancy/index.ts`

**Interfaces:**
- Consumes: `OrgRepository.lockCurrent(): Promise<OrgRow | undefined>` (3A Task 20: `SELECT … FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE`), `TenancyCoreModule` (`@Global`, 3A Task 19–20), `UnitOfWork`, `RequestContext`, `tenancyCoreImports()`, `seedOrg`, `withAppClient`, `inOrgTx`, bảng fixture `fixture_org_items` (FK `RESTRICT` tới `organizations`).
- Produces: `abstract class OrgMutationLock { abstract lock(): Promise<boolean> }` export từ `modules/tenancy/index.ts`, cài bởi `TenancyOrgMutationLock` trong `TenancyCoreModule` (api + worker). `true` = đã khoá dòng org hiện tại tới hết transaction của caller; `false` = dòng org không còn; ngoài `UnitOfWork.run` hoặc ngoài `OrgScope` → ném. 6A (quota dung lượng, R6-1) và 6C (giới hạn endpoint, R6-26) dùng.

- [ ] **Step 1: Integration test (fail)**

`test/integration/tenancy/org-mutation-lock.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { OrgMutationLock } from '../../../src/modules/tenancy/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/** Đủ ngắn để ca "bị chặn" kết thúc nhanh, đủ dài để không flake vì tải: lock_timeout của phiên đối chứng. */
const PROBE_LOCK_TIMEOUT = '300ms';

describe('OrgMutationLock (spec SP6 §5.3, SP3 §8.6 step 1)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });
  const inScope = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(RequestContext).run({}, () => app.get(OrgScope).run(orgId, fn));
  const lockThen = <T>(orgId: string, fn: (locked: boolean) => Promise<T>) =>
    inScope(orgId, () => app.get(UnitOfWork).run(async () => fn(await app.get(OrgMutationLock).lock())));

  it('locks the row of the current org inside the caller transaction', async () => {
    expect(await lockThen(org.orgId, async (locked) => locked)).toBe(true);
  });
  it('is false when the org row does not exist (purged)', async () => {
    expect(await lockThen(v7(), async (locked) => locked)).toBe(false);
  });
  it('refuses to run outside a transaction or outside OrgScope', async () => {
    await expect(inScope(org.orgId, () => app.get(OrgMutationLock).lock())).rejects.toThrow(/inside UnitOfWork\.run/);
    await expect(
      app.get(RequestContext).run({}, () => app.get(UnitOfWork).run(() => app.get(OrgMutationLock).lock())),
    ).rejects.toThrow(/inside OrgScope/);
  });
  it('holds a second locker of the same org until commit, and does not block an INSERT into a table with an FK to the org', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = lockThen(org.orgId, async () => {
      locked();
      await held;
    });
    await isLocked;
    try {
      await withAppClient(async (c) => {
        await expect(
          inOrgTx(c, org.orgId, async () => {
            await c.query(`SET LOCAL lock_timeout = '${PROBE_LOCK_TIMEOUT}'`);
            await c.query('SELECT 1 FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE');
          }),
        ).rejects.toMatchObject({ code: '55P03' });
        const inserted = await inOrgTx(c, org.orgId, async () => {
          await c.query(`SET LOCAL lock_timeout = '${PROBE_LOCK_TIMEOUT}'`);
          return c.query<{ id: string }>(
            `INSERT INTO fixture_org_items (org_id, body) VALUES ($1, 'lock-probe') RETURNING id::text AS id`,
            [org.orgId],
          );
        });
        await inOrgTx(c, org.orgId, () =>
          c.query('DELETE FROM fixture_org_items WHERE id = $1::bigint', [inserted.rows[0]?.id]),
        );
      });
    } finally {
      release();
      await holder;
    }
    expect(await lockThen(org.orgId, async (l) => l)).toBe(true);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/org-mutation-lock.spec.ts`
Expected: FAIL (`OrgMutationLock` không export).

- [ ] **Step 2: Cài**

`src/modules/tenancy/ports/org-mutation-lock.ts`:
```ts
/**
 * Điểm tuần tự hoá của mọi thao tác "đếm dưới khoá rồi thêm" theo org ở module khác (SP6 6A quota dung lượng R6-1, 6C giới
 * hạn endpoint R6-26; spec SP6 §5.3): khoá dòng org hiện tại `FOR NO KEY UPDATE` trong transaction của caller — cùng câu
 * SP3 §8.6 bước 1, cùng thứ tự khoá "org trước mọi bảng tenant". Không chặn INSERT vào bảng có FK tới org (FK chỉ lấy
 * `FOR KEY SHARE`). `false`: dòng org không còn (đã purge). Ngoài `UnitOfWork.run` hoặc ngoài `OrgScope` → ném.
 */
export abstract class OrgMutationLock {
  abstract lock(): Promise<boolean>;
}
```
`src/modules/tenancy/application/org-mutation-lock.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { OrgMutationLock } from '../ports/org-mutation-lock.js';
import { OrgRepository } from '../ports/org-repository.js';

@Injectable()
export class TenancyOrgMutationLock extends OrgMutationLock {
  constructor(
    private readonly orgs: OrgRepository,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
  ) {
    super();
  }

  async lock(): Promise<boolean> {
    // Khoá dòng ngoài transaction được nhả ngay sau câu lệnh: "đếm rồi thêm" sau đó sẽ là check-then-insert trần.
    if (!this.uow.inTransaction())
      throw new Error('OrgMutationLock.lock() must run inside UnitOfWork.run');
    if (this.ctx.orgId() === undefined)
      throw new Error('OrgMutationLock.lock() must run inside OrgScope');
    return (await this.orgs.lockCurrent()) !== undefined;
  }
}
```
`src/modules/tenancy/tenancy.module.ts` — `TenancyCoreModule`: thêm vào `providers`
```ts
    TenancyOrgMutationLock,
    { provide: OrgMutationLock, useExisting: TenancyOrgMutationLock },
```
và `OrgMutationLock` vào `exports` (import từ `./ports/org-mutation-lock.js` và `./application/org-mutation-lock.service.js`).
`src/modules/tenancy/index.ts` thêm: `export { OrgMutationLock } from './ports/org-mutation-lock.js';`

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm vitest run --project integration test/integration/tenancy/org-mutation-lock.spec.ts test/integration/tenancy/repositories.spec.ts
pnpm arch
```
Expected: PASS; phiên đối chứng nhận `55P03` khi khoá bị giữ, INSERT có FK chạy được, khoá lại được sau commit.

- [ ] **Step 4: Toàn bộ unit + integration của nhóm B**

Run:
```bash
pnpm test
pnpm test:int
```
Expected: PASS toàn bộ (nhóm B đổi `core/events`, `core/http`, `identity`, `tenancy`: phải xanh trên cả bộ, không chỉ file mới).

- [ ] **Step 5: Kiểm chứng prod-like #1**

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer), migrate từ `dist`; mọi file smoke hiện có PASS (`core`, `auth-email`, `dashboard`, `tenancy`) — chứng minh marker body parser của identity (đăng ký, xác thực email qua `/api/auth/*`), cờ event (sign-up phát `identity.user.registered`) và 8 event tenancy trong `OrgScope` chạy trên image thật; log api/worker là JSON, không `error`; `/health/ready` 200; teardown `down -v` sạch (`docker compose -p nsb-smoke ps -a` rỗng).

- [ ] **Step 6: Commit**

```bash
git add src/modules/tenancy test/integration/tenancy/org-mutation-lock.spec.ts
git commit -m "feat(tenancy): export OrgMutationLock, the org-row lock shared by files and integrations"
```

---

## Phần C — Kill switch (spec §6.2, §5.3 hàng `core/flags`, §11.1)

### Task 8: Migration `core/…_kill_switches`: bảng global, CHECK, grant theo cột; catalog và chuẩn hoá

**Files:**
- Create: `src/migrations/core/Migration<ts>_kill_switches.ts` (CLI), `test/integration/core/flags/kill-switches-table.spec.ts`
- Modify: `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: `getInfra()`, `withAppClient` (test support).
- Produces: bảng `kill_switches (key TEXT PK, killed BOOLEAN, reason TEXT NULL, changed_by TEXT, version INT DEFAULT 1, created_at, updated_at)` với constraint `kill_switches_key_ck`, `kill_switches_reason_ck`, `kill_switches_reason_required_ck`, `kill_switches_changed_by_ck`, `kill_switches_version_ck`; grant `app_user`: `SELECT, INSERT`, `UPDATE (killed, reason, changed_by, version, updated_at)`. Task 9 đọc/ghi bảng này.

- [ ] **Step 1: Test bảng (fail vì bảng chưa có)**

`test/integration/core/flags/kill-switches-table.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';
import { withAppClient } from '../../../support/tenancy-seed.js';

const ACTOR = 'test-actor';
/** Giới hạn độ dài của spec §6.2 (key ≤ 100, reason 1..500, changed_by 1..255). */
const KEY_MAX = 100;
const REASON_MAX = 500;
const insert = (c: pg.Client, key: string, killed: boolean, reason: string | null, actor = ACTOR) =>
  c.query('INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES ($1, $2, $3, $4)', [key, killed, reason, actor]);
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('kill_switches table (spec SP6 §6.2, §6.9)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.query(`DELETE FROM kill_switches WHERE key LIKE 'fixture.table_%'`);
    await owner?.end();
  });

  it('app_user inserts and reads a row; version starts at 1', async () => {
    await withAppClient(async (c) => {
      await insert(c, 'fixture.table_ok', true, 'maintenance window');
      const { rows } = await c.query('SELECT killed, reason, changed_by, version FROM kill_switches WHERE key = $1', [
        'fixture.table_ok',
      ]);
      expect(rows).toEqual([{ killed: true, reason: 'maintenance window', changed_by: ACTOR, version: 1 }]);
    });
  });
  it.each(['nodot', 'Upper.case', 'a..b', '1a.b', 'a.b-c', `a.${'b'.repeat(KEY_MAX - 1)}`])(
    'the key CHECK refuses %j',
    async (key) => {
      await withAppClient(async (c) => {
        expect(await failure(insert(c, key, false, null))).toMatchObject({ code: '23514', constraint: 'kill_switches_key_ck' });
      });
    },
  );
  it('a killed switch needs a trimmed reason of 1..500 characters; changed_by is 1..255 characters', async () => {
    await withAppClient(async (c) => {
      expect(await failure(insert(c, 'fixture.table_noreason', true, null))).toMatchObject({
        code: '23514',
        constraint: 'kill_switches_reason_required_ck',
      });
      for (const reason of [' padded ', '', 'x'.repeat(REASON_MAX + 1)])
        expect(await failure(insert(c, 'fixture.table_reason', false, reason))).toMatchObject({
          code: '23514',
          constraint: 'kill_switches_reason_ck',
        });
      expect(await failure(insert(c, 'fixture.table_actor', false, null, ''))).toMatchObject({
        code: '23514',
        constraint: 'kill_switches_changed_by_ck',
      });
    });
  });
  it('app_user updates only killed, reason, changed_by, version, updated_at, never deletes, and version stays >= 1', async () => {
    await withAppClient(async (c) => {
      await insert(c, 'fixture.table_upd', false, null);
      await c.query(`UPDATE kill_switches SET killed = true, reason = 'r', version = version + 1, updated_at = now() WHERE key = $1`, [
        'fixture.table_upd',
      ]);
      for (const sql of [
        `UPDATE kill_switches SET key = 'fixture.table_renamed' WHERE key = 'fixture.table_upd'`,
        `UPDATE kill_switches SET created_at = now() WHERE key = 'fixture.table_upd'`,
        `DELETE FROM kill_switches WHERE key = 'fixture.table_upd'`,
      ])
        expect(await failure(c.query(sql)), sql).toMatchObject({ code: '42501' });
      expect(await failure(c.query(`UPDATE kill_switches SET version = 0 WHERE key = 'fixture.table_upd'`))).toMatchObject({
        code: '23514',
        constraint: 'kill_switches_version_ck',
      });
    });
  });
});
```
Run: `pnpm vitest run --project integration test/integration/core/flags/kill-switches-table.spec.ts`
Expected: FAIL `relation "kill_switches" does not exist`.

- [ ] **Step 2: Tạo migration bằng CLI và viết SQL**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/core --name kill_switches`
Sửa file sinh ra (`Migration<ts>_kill_switches.ts`, giữ tên lớp/`name` do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan SP6 6.0 (spec SP6 §6.2, §6.9, §6.10). Kill switch vận hành đọc qua OpenFeature (`core/flags`).
 *
 * Bảng chuẩn hoá (spec §6.9):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | kill_switches | {key} | — | BCNF (`changed_by` là snapshot người đổi gần nhất — một sự kiện, không phải bản sao bảng user) |
 *
 * Global (không `org_id`, không RLS; `GLOBAL_TABLES` của `rls-catalog.spec.ts`). Chỉ admin (process api) ghi qua
 * `KillSwitches.set`; `app_user` không có `DELETE` (switch bỏ khỏi code thì dòng bị provider bỏ qua, WARN một lần).
 * Index: chỉ PK — provider đọc cả bảng (vài chục dòng), `set` tra theo `key`.
 * Race R6-20 (hai lần đổi đồng thời): CAS `UPDATE … WHERE key = ? AND version = ?` và `INSERT … ON CONFLICT (key) DO NOTHING`.
 * Regex `key` = `KILL_SWITCH_KEY` của `src/core/flags/kill-switch.ts` (migration không import code; test khoá hai phía).
 * Khoá: bảng mới, không khoá bảng có sẵn.
 */
export class Migration20260930000000_kill_switches extends Migration {
  override name = 'Migration20260930000000_kill_switches';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE kill_switches (
    key TEXT PRIMARY KEY,
    killed BOOLEAN NOT NULL,
    reason TEXT NULL,
    changed_by TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kill_switches_key_ck CHECK (key ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' AND char_length(key) <= 100),
    CONSTRAINT kill_switches_reason_ck CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
    CONSTRAINT kill_switches_reason_required_ck CHECK (NOT killed OR reason IS NOT NULL),
    CONSTRAINT kill_switches_changed_by_ck CHECK (char_length(changed_by) BETWEEN 1 AND 255),
    CONSTRAINT kill_switches_version_ck CHECK (version >= 1));`);
    this.addSql(`GRANT SELECT, INSERT ON kill_switches TO app_user;`);
    this.addSql(
      `GRANT UPDATE (killed, reason, changed_by, version, updated_at) ON kill_switches TO app_user;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE kill_switches;`);
  }
}
```
(Tên lớp trong khối trên là minh hoạ: dùng đúng `Migration<ts>_kill_switches` do CLI sinh. `'\\.'` trong template literal TS ra `\.` trong SQL — dấu chấm literal của regex.)

- [ ] **Step 3: Catalog và chuẩn hoá**

`test/integration/core/database/rls-catalog.spec.ts` — `GLOBAL_TABLES` thêm sau `'permission_requires'`:
```ts
  // SP6 6.0 (spec §6.2): kill switch vận hành, không có dữ liệu tenant
  'kill_switches',
```
`test/integration/core/database/normalization-inventory.spec.ts` — `ANALYSED_COLUMNS` thêm:
```ts
  'public.kill_switches': [
    'key',
    'killed',
    'reason',
    'changed_by',
    'version',
    'created_at',
    'updated_at',
  ],
```
Sửa chú thích đầu hằng: "Cột của mọi bảng SP2, SP3 và SP6 đã được phân tích (spec SP2 §5.16, SP3 §6.12, SP6 §6.9)".

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/flags/kill-switches-table.spec.ts test/integration/core/database
```
Expected: PASS; `migrations.spec.ts` chạy up → down → up và sweep S2-R57 trên database riêng gồm migration mới; `migration-order.spec.ts` xác nhận timestamp mới hơn `origin/main`.

- [ ] **Step 5: Commit**

```bash
git add src/migrations/core test/integration/core/flags/kill-switches-table.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts
git commit -m "feat(db): kill_switches table with key/reason checks and column-scoped grants"
```

---

### Task 9: `core/flags` — `defineKillSwitch`, provider OpenFeature đọc DB, `KillSwitches`; nối vào api/worker; smoke prod-like #2 (C-20)

**Files:**
- Create: `src/core/flags/flags.config.ts`, `src/core/flags/kill-switch.ts`, `src/core/flags/db-kill-switch.provider.ts`, `src/core/flags/kill-switches.service.ts`, `src/core/flags/flags.module.ts`, `src/core/flags/index.ts`, `test/unit/core/flags/kill-switch.spec.ts`, `test/unit/core/flags/db-kill-switch.provider.spec.ts`, `test/integration/core/flags/kill-switches.spec.ts`, `test/smoke/core-shared.smoke.spec.ts`
- Modify: `src/core/config/all-configs.ts`, `src/app-api.module.ts`, `src/app-worker.module.ts`, `.env.example` (sinh lại)

**Interfaces:**
- Consumes: `Db`, `UnitOfWork` (SP1), `defineConfig`, `ConfigOf`, `METER` (`core/observability/queue-metrics.ts`), bảng `kill_switches` (Task 8), SDK OpenFeature (Task 2).
- Produces:
  - `flagsConfig` (namespace `flags`, `refreshIntervalMs` ← `FLAGS_REFRESH_INTERVAL_MS`, mặc định `5000`, `1000–60000`).
  - `defineKillSwitch({ key, description }): KillSwitchDef`, `killSwitchRegistry(): KillSwitchDef[]`, `findKillSwitch(key)`, hằng `KILL_SWITCH_KEY`, `KILL_SWITCH_KEY_MAX_LENGTH = 100` — 6A khai `files.uploads`, 6C khai `integrations.webhook_delivery`.
  - `KillSwitches` (global, api + worker): `isKilled(key): Promise<boolean>`; `list(): Promise<KillSwitchState[]>`; `set(change: KillSwitchChange): Promise<KillSwitchSetResult>` với `KillSwitchChange = { key; killed; reason: string | null; actor: string; expectedVersion: number }`, `KillSwitchSetResult = { kind: 'APPLIED'; version: number } | { kind: 'VERSION_MISMATCH' }`, `NO_ROW_VERSION = 0`; `KillSwitchState = { key; description; killed; reason: string | null; changedBy: string | null; version: number; updatedAt: Date | null }` — 6D dùng cho route admin (`If-Match` = `version`).
  - `DbKillSwitchProvider implements Provider` (`initialize`, `onClose`, `refreshOnce(): Promise<'ok' | 'failed'>`), metric `flags_refresh_failures_total`, `flags_snapshot_age_seconds`; log WARN `kill_switch_unknown_key { key }` (một lần mỗi key mỗi process), WARN `kill_switch_refresh_failed`.
  - `FlagsModule` (`@Global`) nạp trong `AppApiModule` và `AppWorkerModule`.

- [ ] **Step 1: Unit test registry và provider (fail)**

`test/unit/core/flags/kill-switch.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  KILL_SWITCH_KEY,
  KILL_SWITCH_KEY_MAX_LENGTH,
  defineKillSwitch,
  findKillSwitch,
  killSwitchRegistry,
} from '../../../../src/core/flags/index.js';

describe('defineKillSwitch registry (spec SP6 §5.3 core/flags)', () => {
  it('registers dotted lower-case keys with a description', () => {
    const def = defineKillSwitch({ key: 'unit.reg_ok', description: 'probe' });
    expect(findKillSwitch('unit.reg_ok')).toBe(def);
    expect(killSwitchRegistry()).toContain(def);
  });
  it.each(['nodot', 'Upper.case', 'a..b', '1a.b', 'a.b-c', `a.${'b'.repeat(KILL_SWITCH_KEY_MAX_LENGTH - 1)}`])(
    'refuses key %j',
    (key) => {
      expect(() => defineKillSwitch({ key, description: 'x' })).toThrow(/Kill switch key/);
    },
  );
  it('refuses a duplicate key and a blank description', () => {
    defineKillSwitch({ key: 'unit.reg_dup', description: 'first' });
    expect(() => defineKillSwitch({ key: 'unit.reg_dup', description: 'again' })).toThrow(/already defined/);
    expect(() => defineKillSwitch({ key: 'unit.reg_blank', description: '  ' })).toThrow(/description/);
  });
  it('the key rule is exactly the kill_switches CHECK of the migration (spec §6.2)', () => {
    expect(KILL_SWITCH_KEY.source).toBe('^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$');
    expect(KILL_SWITCH_KEY_MAX_LENGTH).toBe(100);
  });
});
```
`test/unit/core/flags/db-kill-switch.provider.spec.ts`:
```ts
import { Logger } from '@nestjs/common';
import { TypeMismatchError } from '@openfeature/server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../../src/core/database/index.js';
import {
  DbKillSwitchProvider,
  defineKillSwitch,
  flagsConfig,
} from '../../../../src/core/flags/index.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

/** Trước khi provider nào được tạo: counter gắn với MeterProvider đặt lúc tạo. */
const otel = installOtelCapture();
const A = defineKillSwitch({ key: 'unit.flag_a', description: 'probe A' });
const INTERVAL_MS = 1000;
/** Số lượt làm mới đợi thêm sau khi đóng để chắc không còn truy vấn nào. */
const AFTER_CLOSE_INTERVALS = 5;
type Row = { key: string; killed: boolean };

function fakeDb() {
  const state: { rows: Row[]; fail: boolean; gate?: Promise<void> } = { rows: [], fail: false };
  const execute = vi.fn(async () => {
    if (state.gate) await state.gate;
    if (state.fail) throw new Error('db down');
    return state.rows;
  });
  return { db: { execute } as Pick<Db, 'execute'> as Db, execute, state };
}
const make = (db: Db) =>
  new DbKillSwitchProvider(db, flagsConfig.schema.parse({ refreshIntervalMs: INTERVAL_MS }));
const valueOf = async (p: DbKillSwitchProvider, key: string) => (await p.resolveBooleanEvaluation(key)).value;
const unknownWarns = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'kill_switch_unknown_key');

describe('DbKillSwitchProvider (spec SP6 §5.3 core/flags, C-20)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('initialize fails loud when the first load fails, and schedules nothing (Review Focus 5)', async () => {
    vi.useFakeTimers();
    const f = fakeDb();
    f.state.fail = true;
    await expect(make(f.db).initialize()).rejects.toThrow('db down');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a registered switch reads its row; a registered switch without a row is false', async () => {
    const f = fakeDb();
    f.state.rows = [{ key: A.key, killed: true }];
    const p = make(f.db);
    await p.initialize();
    expect(await valueOf(p, A.key)).toBe(true);
    f.state.rows = [];
    expect(await p.refreshOnce()).toBe('ok');
    expect(await valueOf(p, A.key)).toBe(false);
    await p.onClose();
  });
  it('a failed refresh keeps the last snapshot (fail-static) and counts the failure', async () => {
    const f = fakeDb();
    f.state.rows = [{ key: A.key, killed: true }];
    const p = make(f.db);
    await p.initialize();
    const before = (await otel.metric('flags_refresh_failures_total')) ?? 0;
    f.state.fail = true;
    expect(await p.refreshOnce()).toBe('failed');
    expect(await valueOf(p, A.key)).toBe(true);
    expect(await otel.metric('flags_refresh_failures_total')).toBe(before + 1);
    await p.onClose();
  });
  it('rows of switches no longer in code are ignored with one WARN per key per process', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const f = fakeDb();
    f.state.rows = [{ key: 'unit.gone_switch', killed: true }];
    const p = make(f.db);
    await p.initialize();
    await p.refreshOnce();
    await p.refreshOnce();
    expect(await valueOf(p, 'unit.gone_switch')).toBe(false);
    expect(unknownWarns(warn)).toHaveLength(1);
    await p.onClose();
  });
  it('refreshes on its interval and stops for good on close: no timer, no query after close', async () => {
    vi.useFakeTimers();
    const f = fakeDb();
    const p = make(f.db);
    await p.initialize();
    expect(f.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(f.execute).toHaveBeenCalledTimes(2);
    await p.onClose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * AFTER_CLOSE_INTERVALS);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it('close waits for the refresh in flight (the pool closes after it)', async () => {
    const f = fakeDb();
    const p = make(f.db);
    await p.initialize();
    let open!: () => void;
    f.state.gate = new Promise<void>((r) => (open = r));
    const refreshing = p.refreshOnce();
    let closed = false;
    const closing = p.onClose().then(() => {
      closed = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(false);
    open();
    await refreshing;
    await closing;
    expect(closed).toBe(true);
  });
  it('non-boolean evaluations are a type mismatch', async () => {
    const p = make(fakeDb().db);
    await expect(p.resolveStringEvaluation()).rejects.toBeInstanceOf(TypeMismatchError);
    await expect(p.resolveNumberEvaluation()).rejects.toBeInstanceOf(TypeMismatchError);
    await expect(p.resolveObjectEvaluation()).rejects.toBeInstanceOf(TypeMismatchError);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/core/flags`
Expected: FAIL (module `core/flags` chưa có; test hợp đồng của Task 2 vẫn xanh).

- [ ] **Step 2: Cài `core/flags`**

`src/core/flags/flags.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const flagsConfig = defineConfig(
  'flags',
  { refreshIntervalMs: 'FLAGS_REFRESH_INTERVAL_MS' },
  z.object({
    refreshIntervalMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60000)
      .default(5000)
      .describe(
        'How often every api/worker process reloads kill switches from the database; a change takes effect within this interval + 1 s',
      ),
  }),
);
```
`src/core/flags/kill-switch.ts`:
```ts
/** Cùng luật với `kill_switches_key_ck` của migration (spec SP6 §6.2); test khoá hai phía. */
export const KILL_SWITCH_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const KILL_SWITCH_KEY_MAX_LENGTH = 100;

export type KillSwitchDef = { readonly key: string; readonly description: string };

const switches = new Map<string, KillSwitchDef>();

/**
 * Registry lúc import (mẫu `defineJob`): module khai switch của mình (6A `files.uploads`, 6C `integrations.webhook_delivery`).
 * `KillSwitches.isKilled` chỉ nhận key đã khai; dòng DB của key không còn trong code bị provider bỏ qua (WARN một lần).
 */
export function defineKillSwitch(def: { key: string; description: string }): KillSwitchDef {
  if (!KILL_SWITCH_KEY.test(def.key) || def.key.length > KILL_SWITCH_KEY_MAX_LENGTH)
    throw new Error(
      `Kill switch key "${def.key}" must match ${KILL_SWITCH_KEY} and be at most ${KILL_SWITCH_KEY_MAX_LENGTH} characters`,
    );
  if (def.description.trim() === '')
    throw new Error(`Kill switch "${def.key}" needs a description`);
  if (switches.has(def.key)) throw new Error(`Kill switch "${def.key}" already defined`);
  const full: KillSwitchDef = { key: def.key, description: def.description };
  switches.set(def.key, full);
  return full;
}

export const killSwitchRegistry = (): KillSwitchDef[] => [...switches.values()];
export const findKillSwitch = (key: string): KillSwitchDef | undefined => switches.get(key);
```
`src/core/flags/db-kill-switch.provider.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  StandardResolutionReasons,
  TypeMismatchError,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { Db } from '../database/index.js';
import { METER } from '../observability/queue-metrics.js';
import { flagsConfig } from './flags.config.js';
import { findKillSwitch } from './kill-switch.js';

const Rows = z.array(z.object({ key: z.string(), killed: z.boolean() }));
const MS_PER_SECOND = 1000;
const BOOLEAN_ONLY = 'kill switches are boolean flags';

/**
 * Provider OpenFeature đọc bảng `kill_switches` (spec SP6 §5.3, S6-A44): snapshot trong bộ nhớ, làm mới mỗi
 * `FLAGS_REFRESH_INTERVAL_MS` (timer `unref`, một lượt mỗi lúc). Đánh giá không I/O. Lần nạp đầu (`initialize`) phải thành
 * công: không có snapshot để giữ, nên app không khởi động thay vì coi mọi switch là "không tắt". Lỗi khi làm mới → giữ
 * snapshot cũ (fail-static) + `flags_refresh_failures_total`. Không có dòng cho key → `false`.
 */
@Injectable()
export class DbKillSwitchProvider implements Provider {
  readonly metadata = { name: 'core.db-kill-switches' };
  readonly runsOn = 'server';
  private readonly logger = new Logger(DbKillSwitchProvider.name);
  private readonly meter = metrics.getMeter(METER);
  private readonly refreshFailures = this.meter.createCounter('flags_refresh_failures_total', {
    description: 'Kill switch refreshes that failed; the last snapshot was kept (fail-static)',
  });
  private readonly snapshotAge = this.meter.createObservableGauge('flags_snapshot_age_seconds', {
    description: 'Age of the kill switch snapshot served by this process',
    unit: 's',
  });
  private snapshot: ReadonlyMap<string, boolean> = new Map();
  private refreshedAt?: number;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<unknown>;
  private closed = false;
  private readonly unknownWarned = new Set<string>();

  constructor(
    private readonly db: Db,
    @Inject(flagsConfig.KEY)
    private readonly cfg: ConfigOf<typeof flagsConfig>,
  ) {}

  async initialize(): Promise<void> {
    await this.load();
    this.snapshotAge.addCallback(this.observeAge);
    this.schedule();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.snapshotAge.removeCallback(this.observeAge);
    await this.inflight;
  }

  /** Một lượt làm mới; lỗi giữ snapshot cũ. Trả kết quả để test không phải dựa vào timer. */
  refreshOnce(): Promise<'ok' | 'failed'> {
    const run = this.load().then(
      () => 'ok' as const,
      (err: unknown) => {
        this.refreshFailures.add(1);
        this.logger.warn(
          { event: 'kill_switch_refresh_failed', err },
          'kill switch refresh failed; keeping the last snapshot',
        );
        return 'failed' as const;
      },
    );
    this.inflight = run;
    return run;
  }

  resolveBooleanEvaluation(flagKey: string): Promise<ResolutionDetails<boolean>> {
    const killed = this.snapshot.get(flagKey);
    return Promise.resolve(
      killed === undefined
        ? { value: false, reason: StandardResolutionReasons.DEFAULT }
        : { value: killed, reason: StandardResolutionReasons.CACHED },
    );
  }
  resolveStringEvaluation(): Promise<ResolutionDetails<string>> {
    return Promise.reject(new TypeMismatchError(BOOLEAN_ONLY));
  }
  resolveNumberEvaluation(): Promise<ResolutionDetails<number>> {
    return Promise.reject(new TypeMismatchError(BOOLEAN_ONLY));
  }
  resolveObjectEvaluation<T extends JsonValue>(): Promise<ResolutionDetails<T>> {
    return Promise.reject(new TypeMismatchError(BOOLEAN_ONLY));
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.refreshOnce().finally(() => this.schedule());
    }, this.cfg.refreshIntervalMs);
    this.timer.unref();
  }

  private async load(): Promise<void> {
    const rows = Rows.parse(await this.db.execute('SELECT key, killed FROM kill_switches'));
    const next = new Map<string, boolean>();
    for (const r of rows) {
      if (!findKillSwitch(r.key)) {
        this.warnUnknown(r.key);
        continue;
      }
      next.set(r.key, r.killed);
    }
    this.snapshot = next;
    this.refreshedAt = Date.now();
  }

  private warnUnknown(key: string): void {
    if (this.unknownWarned.has(key)) return;
    this.unknownWarned.add(key);
    this.logger.warn(
      { event: 'kill_switch_unknown_key', key },
      'kill_switches has a row for a switch this build does not define; ignored',
    );
  }

  private readonly observeAge = (result: ObservableResult): void => {
    if (this.refreshedAt !== undefined)
      result.observe((Date.now() - this.refreshedAt) / MS_PER_SECOND);
  };
}
```
`src/core/flags/kill-switches.service.ts`:
```ts
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  NOOP_PROVIDER,
  OpenFeature,
  ProviderStatus,
  type Client,
  type Logger as OpenFeatureLogger,
} from '@openfeature/server-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Db, UnitOfWork } from '../database/index.js';
import { DbKillSwitchProvider } from './db-kill-switch.provider.js';
import { findKillSwitch, killSwitchRegistry, type KillSwitchDef } from './kill-switch.js';

/** `expectedVersion` cho switch chưa có dòng: `kill_switches.version` luôn ≥ 1 (CHECK), nên 0 không va chạm. */
export const NO_ROW_VERSION = 0;

export type KillSwitchChange = {
  key: string;
  killed: boolean;
  /** Bắt buộc khi `killed` (CHECK của DB); đã trim, 1..500 ký tự. */
  reason: string | null;
  /** `principal.id` của người đổi (snapshot `changed_by`). */
  actor: string;
  /** Version đang thấy (`If-Match` của 6D); `NO_ROW_VERSION` khi chưa có dòng. */
  expectedVersion: number;
};
export type KillSwitchSetResult =
  | { kind: 'APPLIED'; version: number }
  | { kind: 'VERSION_MISMATCH' };
export type KillSwitchState = {
  key: string;
  description: string;
  killed: boolean;
  reason: string | null;
  changedBy: string | null;
  version: number;
  updatedAt: Date | null;
};

const StateRows = z.array(
  z.object({
    key: z.string(),
    killed: z.boolean(),
    reason: z.string().nullable(),
    changed_by: z.string(),
    version: z.number().int(),
    updated_at: z.coerce.date(),
  }),
);
const VersionRows = z.array(z.object({ version: z.number().int() }));

const sdkLog = new Logger('OpenFeature');
/** Log của SDK đi qua pino (không `console`): smoke đòi mọi dòng log là JSON. */
const openFeatureLogger: OpenFeatureLogger = {
  error: (...args: unknown[]) => sdkLog.error({ event: 'openfeature_error', detail: args.map(String).join(' ') }),
  warn: (...args: unknown[]) => sdkLog.warn({ event: 'openfeature_warn', detail: args.map(String).join(' ') }),
  info: (...args: unknown[]) => sdkLog.log({ event: 'openfeature_info', detail: args.map(String).join(' ') }),
  debug: (...args: unknown[]) => sdkLog.debug({ event: 'openfeature_debug', detail: args.map(String).join(' ') }),
};

/**
 * Cửa duy nhất tới kill switch (luật kiến trúc 22: module không import OpenFeature). Mỗi app Nest một domain OpenFeature
 * (test dựng nhiều app trong một process, còn API OpenFeature là singleton). Provider sẵn sàng trong `onModuleInit`, trước
 * mọi `onApplicationBootstrap` (WorkerHost bắt đầu nhận job ở đó).
 */
@Injectable()
export class KillSwitches implements OnModuleInit, BeforeApplicationShutdown {
  private readonly domain = `core.flags.${randomUUID()}`;
  private client?: Client;

  constructor(
    private readonly provider: DbKillSwitchProvider,
    private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async onModuleInit(): Promise<void> {
    OpenFeature.setLogger(openFeatureLogger);
    await OpenFeature.setProviderAndWait(this.domain, this.provider);
    this.client = OpenFeature.getClient(this.domain);
  }

  /** Trước `onApplicationShutdown` (pool DB đóng ở đó): dừng timer và chờ lượt làm mới đang chạy. */
  async beforeApplicationShutdown(): Promise<void> {
    this.client = undefined;
    await this.provider.onClose();
    await OpenFeature.setProviderAndWait(this.domain, NOOP_PROVIDER);
  }

  async isKilled(key: string): Promise<boolean> {
    this.registered(key);
    const client = this.client;
    // Không trả mặc định `false` khi provider chưa/không còn sẵn sàng: đó là "không tắt" âm thầm (Review Focus 5).
    if (!client || client.providerStatus !== ProviderStatus.READY)
      throw new Error(`Kill switch provider is not ready (asked for "${key}")`);
    return client.getBooleanValue(key, false);
  }

  /** Mọi switch đã khai, kèm trạng thái DB (không có dòng → `killed: false`, `version: NO_ROW_VERSION`). */
  async list(): Promise<KillSwitchState[]> {
    const rows = StateRows.parse(
      await this.db.execute('SELECT key, killed, reason, changed_by, version, updated_at FROM kill_switches'),
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return killSwitchRegistry().map((d) => {
      const r = byKey.get(d.key);
      return r
        ? { key: d.key, description: d.description, killed: r.killed, reason: r.reason, changedBy: r.changed_by, version: r.version, updatedAt: r.updated_at }
        : { key: d.key, description: d.description, killed: false, reason: null, changedBy: null, version: NO_ROW_VERSION, updatedAt: null };
    });
  }

  /**
   * Ghi trong transaction của caller (6D phát event `admin.kill_switch.changed` cùng transaction). CAS theo version (R6-20):
   * hai lần đổi đồng thời cùng `expectedVersion` → đúng một `APPLIED`. Có hiệu lực ở mọi process sau lượt làm mới kế tiếp.
   */
  async set(c: KillSwitchChange): Promise<KillSwitchSetResult> {
    this.registered(c.key);
    if (!this.uow.inTransaction())
      throw new Error('KillSwitches.set must run inside UnitOfWork.run');
    if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < NO_ROW_VERSION)
      throw new Error(`expectedVersion must be a non-negative integer, got ${c.expectedVersion}`);
    const rows =
      c.expectedVersion === NO_ROW_VERSION
        ? await this.db.execute(
            `INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES (?, ?, ?, ?)
             ON CONFLICT (key) DO NOTHING RETURNING version`,
            [c.key, c.killed, c.reason, c.actor],
          )
        : await this.db.execute(
            `UPDATE kill_switches SET killed = ?, reason = ?, changed_by = ?, version = version + 1, updated_at = now()
             WHERE key = ? AND version = ? RETURNING version`,
            [c.killed, c.reason, c.actor, c.key, c.expectedVersion],
          );
    const [row] = VersionRows.parse(rows);
    return row ? { kind: 'APPLIED', version: row.version } : { kind: 'VERSION_MISMATCH' };
  }

  private registered(key: string): KillSwitchDef {
    const def = findKillSwitch(key);
    if (!def)
      throw new Error(`"${key}" is not a registered kill switch (defineKillSwitch)`);
    return def;
  }
}
```
`src/core/flags/flags.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { DbKillSwitchProvider } from './db-kill-switch.provider.js';
import './flags.config.js';
import { KillSwitches } from './kill-switches.service.js';

/** api + worker (spec SP6 §5.3): mọi module đọc kill switch qua `KillSwitches`. */
@Global()
@Module({
  providers: [DbKillSwitchProvider, KillSwitches],
  exports: [KillSwitches],
})
export class FlagsModule {}
```
`src/core/flags/index.ts`:
```ts
export { FlagsModule } from './flags.module.js';
export { flagsConfig } from './flags.config.js';
export {
  KILL_SWITCH_KEY,
  KILL_SWITCH_KEY_MAX_LENGTH,
  defineKillSwitch,
  findKillSwitch,
  killSwitchRegistry,
  type KillSwitchDef,
} from './kill-switch.js';
export { DbKillSwitchProvider } from './db-kill-switch.provider.js';
export {
  KillSwitches,
  NO_ROW_VERSION,
  type KillSwitchChange,
  type KillSwitchSetResult,
  type KillSwitchState,
} from './kill-switches.service.js';
```
`src/core/config/all-configs.ts` thêm: `import '../flags/flags.config.js';`
`src/app-api.module.ts`, `src/app-worker.module.ts`: import `FlagsModule` từ `./core/flags/index.js` và thêm `FlagsModule,` vào `imports` ngay sau `DatabaseModule.forRoot(...)` (cần `Db` + config).
Run: `pnpm env:example` — `.env.example` có thêm `FLAGS_REFRESH_INTERVAL_MS=5000` với mô tả.

- [ ] **Step 3: Chạy unit**

Run: `pnpm vitest run --project unit test/unit/core/flags test/unit/architecture test/unit/core/config`
Expected: PASS; luật 22 vẫn xanh trên cây `src` (OpenFeature chỉ ở `src/core/flags`); `hardcode-scan.spec.ts` xanh (khoảng làm mới lấy từ config).

- [ ] **Step 4: Integration hai instance, CAS, danh sách (fail trước Step 2)**

`test/integration/core/flags/kill-switches.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule, UnitOfWork } from '../../../../src/core/database/index.js';
import {
  FlagsModule,
  KillSwitches,
  NO_ROW_VERSION,
  defineKillSwitch,
  type KillSwitchChange,
} from '../../../../src/core/flags/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';

const PROBE = defineKillSwitch({ key: 'fixture.flag_probe', description: 'integration probe' });
const RACE = defineKillSwitch({ key: 'fixture.flag_race', description: 'concurrent set probe' });
const LISTED = defineKillSwitch({ key: 'fixture.flag_listed', description: 'no row yet' });
/** Khoảng làm mới nhỏ nhất hợp lệ, để ca lan truyền chạy nhanh. */
const INTERVAL_MS = 1000;
/** Tiêu chí 11 của spec: có hiệu lực trong `FLAGS_REFRESH_INTERVAL_MS + 1 s`. */
const PROPAGATION_SLACK_MS = 1000;
const RACERS = 20;
const ACTOR = 'test-actor';

describe('KillSwitches on two app instances (spec SP6 §5.3, criterion 11, C-20, R6-20)', () => {
  let a: INestApplication;
  let b: INestApplication;
  let owner: pg.Client;
  const imports = () => [DatabaseModule.forRoot({ relay: false }), FlagsModule];
  beforeAll(async () => {
    vi.stubEnv('FLAGS_REFRESH_INTERVAL_MS', String(INTERVAL_MS));
    a = await createTestApp(imports());
    b = await createTestApp(imports());
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.query(`DELETE FROM kill_switches WHERE key LIKE 'fixture.flag_%'`);
    await owner?.end();
    await a?.close();
    await b?.close();
    vi.unstubAllEnvs();
  });
  const set = (app: INestApplication, change: KillSwitchChange) =>
    app.get(UnitOfWork).run(() => app.get(KillSwitches).set(change));
  const change = (key: string, killed: boolean, expectedVersion: number): KillSwitchChange => ({
    key,
    killed,
    reason: killed ? 'integration probe' : null,
    actor: ACTOR,
    expectedVersion,
  });

  it('a change on instance A is seen by instance B within FLAGS_REFRESH_INTERVAL_MS + 1 s', async () => {
    expect(await b.get(KillSwitches).isKilled(PROBE.key)).toBe(false);
    expect(await set(a, change(PROBE.key, true, NO_ROW_VERSION))).toEqual({ kind: 'APPLIED', version: 1 });
    const t = performance.now();
    await vi.waitFor(async () => expect(await b.get(KillSwitches).isKilled(PROBE.key)).toBe(true), {
      timeout: INTERVAL_MS + PROPAGATION_SLACK_MS,
      interval: 50,
    });
    expect(performance.now() - t).toBeLessThanOrEqual(INTERVAL_MS + PROPAGATION_SLACK_MS);
  });
  it('an unregistered key is refused by isKilled and set', async () => {
    await expect(a.get(KillSwitches).isKilled('fixture.not_registered')).rejects.toThrow(/not a registered kill switch/);
    await expect(set(a, change('fixture.not_registered', false, NO_ROW_VERSION))).rejects.toThrow(
      /not a registered kill switch/,
    );
  });
  it('set is a compare-and-set on version; it needs a transaction; the DB refuses a killed switch without reason', async () => {
    expect(await set(a, change(PROBE.key, false, 1))).toEqual({ kind: 'APPLIED', version: 2 });
    expect(await set(a, change(PROBE.key, true, 1))).toEqual({ kind: 'VERSION_MISMATCH' });
    expect(await set(a, change(PROBE.key, true, NO_ROW_VERSION))).toEqual({ kind: 'VERSION_MISMATCH' });
    await expect(a.get(KillSwitches).set(change(PROBE.key, false, 2))).rejects.toThrow(/inside UnitOfWork\.run/);
    // Lỗi đi qua driver của MikroORM: khẳng định bằng tên constraint trong thông điệp của Postgres.
    await expect(set(a, { ...change(PROBE.key, true, 2), reason: null })).rejects.toThrow(
      /kill_switches_reason_required_ck/,
    );
  });
  it('concurrent sets with the same expected version: exactly one applies (R6-20)', async () => {
    const race = (v: number) =>
      Promise.all(Array.from({ length: RACERS }, (_, i) => set(a, change(RACE.key, i % 2 === 0, v))));
    for (const v of [NO_ROW_VERSION, 1]) {
      const results = await race(v);
      expect(results.filter((r) => r.kind === 'APPLIED'), `expectedVersion ${v}`).toEqual([{ kind: 'APPLIED', version: v + 1 }]);
    }
  });
  it('list shows every registered switch; a switch without a row is not killed at version 0', async () => {
    const listed = await a.get(KillSwitches).list();
    expect(listed.find((s) => s.key === LISTED.key)).toEqual({
      key: LISTED.key,
      description: 'no row yet',
      killed: false,
      reason: null,
      changedBy: null,
      version: NO_ROW_VERSION,
      updatedAt: null,
    });
    expect(listed.find((s) => s.key === PROBE.key)).toMatchObject({ changedBy: ACTOR, version: 2 });
    expect(listed.find((s) => s.key === PROBE.key)?.updatedAt).toBeInstanceOf(Date);
  });
  it('isKilled throws once the app is closed instead of answering false (Review Focus 5)', async () => {
    const c = await createTestApp(imports());
    const switches = c.get(KillSwitches);
    await c.close();
    await expect(switches.isKilled(PROBE.key)).rejects.toThrow(/not ready/);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/core/flags`
Expected: PASS (chạy trước Step 2 thì FAIL: `core/flags` chưa có).

- [ ] **Step 5: Smoke prod-like của phần 6.0 (file mới)**

`test/smoke/core-shared.smoke.spec.ts`:
```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, inject, it, vi } from 'vitest';
import { assertCleanLogs, logsSince, psql } from './smoke-support.js';

/** Mặc định `FLAGS_REFRESH_INTERVAL_MS` của `.env.example` (smoke không ghi đè). */
const FLAGS_REFRESH_DEFAULT_MS = 5000;
const REFRESH_WAIT_MS = FLAGS_REFRESH_DEFAULT_MS * 3;
/** Một api + một worker trong compose smoke: mỗi process WARN đúng một lần. */
const PROCESSES = 2;
const UNKNOWN_KEY = 'smoke.unknown_switch';
const unknownWarns = (logs: string) =>
  logs
    .split(/\r?\n/)
    .filter((l) => l.includes('"event":"kill_switch_unknown_key"') && l.includes(UNKNOWN_KEY)).length;

describe('prod-like smoke: SP6 6.0 shared core', () => {
  const { startedAt } = inject('smoke');

  it('partition_owner and sweep_definer are NOLOGIN roles app_owner may SET but not inherit', () => {
    expect(
      psql(
        `SELECT string_agg(r.rolname || ':' || r.rolcanlogin::text || ':' || r.rolbypassrls::text || ':' || m.inherit_option::text || ':' || m.set_option::text, ',' ORDER BY r.rolname)
         FROM pg_roles r JOIN pg_auth_members m ON m.roleid = r.oid AND m.member = 'app_owner'::regrole
         WHERE r.rolname IN ('partition_owner', 'sweep_definer')`,
      ),
    ).toBe('partition_owner:false:false:false:true,sweep_definer:false:false:false:true');
  });
  it('kill_switches is migrated from dist with the grants of spec §6.2', () => {
    expect(
      psql(
        `SELECT has_table_privilege('app_user', 'kill_switches', 'SELECT')::text || ':' || has_table_privilege('app_user', 'kill_switches', 'INSERT')::text || ':' || has_table_privilege('app_user', 'kill_switches', 'DELETE')::text || ':' || has_column_privilege('app_user', 'kill_switches', 'key', 'UPDATE')::text || ':' || has_column_privilege('app_user', 'kill_switches', 'killed', 'UPDATE')::text`,
      ),
    ).toBe('true:true:false:false:true');
  });
  it('api and worker reload kill switches from the DB; a row for a switch not in code is ignored with one WARN per process', async () => {
    const since = new Date().toISOString();
    psql(`INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES ('${UNKNOWN_KEY}', true, 'smoke', 'smoke')`);
    try {
      await vi.waitFor(() => expect(unknownWarns(logsSince(since))).toBe(PROCESSES), {
        timeout: REFRESH_WAIT_MS,
        interval: 500,
      });
      await sleep(FLAGS_REFRESH_DEFAULT_MS * 2);
      expect(unknownWarns(logsSince(since))).toBe(PROCESSES);
    } finally {
      psql(`DELETE FROM kill_switches WHERE key = '${UNKNOWN_KEY}'`);
    }
  });
  it('container logs since boot have no error or non-JSON lines', () => {
    assertCleanLogs(logsSince(startedAt), []);
  });
});
```
(`UNKNOWN_KEY` là hằng của test, không phải input ngoài: nối vào SQL của superuser smoke là an toàn.)

- [ ] **Step 6: Toàn bộ và kiểm chứng prod-like #2**

Run:
```bash
pnpm typecheck && pnpm arch && pnpm test
pnpm test:int
pnpm test:smoke
```
Expected: typecheck/arch/unit/integration PASS (mọi test dựng `AppApiModule`/`AppWorkerModule` nay nạp `FlagsModule`, bảng `kill_switches` có sẵn); smoke: image production thật, `compose --profile app`, migrate từ `dist` gồm `…_kill_switches`, `core-shared.smoke.spec.ts` PASS (role do `01-roles.sh` của compose tạo; api + worker mỗi process WARN đúng một lần cho dòng lạ, sau thêm hai chu kỳ vẫn một lần), mọi file smoke khác PASS, log JSON không `error`, `/health/ready` 200, teardown sạch.

- [ ] **Step 7: Commit**

```bash
git add src/core/flags src/core/config/all-configs.ts src/app-api.module.ts src/app-worker.module.ts .env.example test/unit/core/flags test/integration/core/flags test/smoke/core-shared.smoke.spec.ts
git commit -m "feat(flags): database kill switches behind OpenFeature with fail-static refresh; KillSwitches in api and worker; prod-like smoke"
```

---

## Phần D — Quét xuyên org và partition theo tháng (spec §5.3 hàng `core/sweep`, `core/partitions`, §6.7, §6.8)

### Task 10: Fixture DB của sweep và partition; quét tĩnh migration theo `NOLOGIN_OWNER_ROLES`; catalog partition và hàm definer (C-6 phần a, b)

**Files:**
- Create: `test/fixtures/migrations/Migration<ts>_fixture_core_shared.ts` (CLI), `test/support/core-catalog.ts`
- Modify: `test/unit/migrations/migration-scan.spec.ts`, `test/integration/core/database/rls-catalog.spec.ts`

**Interfaces:**
- Consumes: `DEFINER_FUNCTIONS`, `DEFINER_INTERNAL_FUNCTIONS`, `DEFINER_TRIGGER_FUNCTIONS`, `DEFINER_READ_TABLES` (`test/support/tenancy-catalog.ts`, 3A); role của Task 1; kết luận spike P1 (Task 1).
- Produces:
  - Fixture DB (chạy ở `migrateTestDb` và `migrations.spec.ts`): bảng `fixture_sweep_items (id, org_id, tag, due_at, created_at, updated_at)` (RLS FORCE, `fixture_sweep_items_tenant TO app_user`, `fixture_sweep_items_definer_read … TO sweep_definer`, `SELECT (org_id, tag, due_at)` cho `sweep_definer`); hàm `public.fixture_orgs_due(p_after uuid, p_limit integer, p_min_age_sec integer, p_tag text) RETURNS TABLE (org_id uuid)` (owner `sweep_definer`, `STABLE SECURITY DEFINER`); bảng partitioned `fixture_part_events (org_id uuid, id bigint identity, recorded_at timestamptz, body text; PK (recorded_at, id))` (owner `partition_owner`, RLS FORCE trên cha, `GRANT SELECT, INSERT` cho `app_user`, trigger `fixture_part_events_append_only`), hàm `public.fixture_part_events_maintain(p_retention_months integer, p_premake_months integer) RETURNS TABLE (action text, partition_name text)` (owner `partition_owner`, sàn retention 1, `lockKey` 6900), partition tháng hiện tại + 3 tháng tới.
  - `test/support/core-catalog.ts`: `NOLOGIN_OWNER_ROLES`, `type NologinOwnerRole`, hằng `*_FIXTURE` và hợp `SWEEP_DEFINER_FUNCTIONS`, `SWEEP_DEFINER_READ_TABLES`, `PARTITION_OWNER_FUNCTIONS`, `PARTITION_OWNER_TRIGGER_FUNCTIONS`, `PARTITIONED_TABLES`, `OWNED_FUNCTIONS: Record<NologinOwnerRole, readonly string[]>` — 6A/6B/6C/SP5/SP7 THÊM hằng của mình.
  - Quét tĩnh: mọi hàm trong `OWNED_FUNCTIONS[role]` chỉ được tạo/xoá giữa `SET LOCAL ROLE <role>` và `RESET ROLE`; `CREATE TABLE … PARTITION BY` chỉ dưới `partition_owner`; áp cho `src/migrations/**` và `test/fixtures/migrations/**`.

- [ ] **Step 1: Hằng catalog**

`test/support/core-catalog.ts`:
```ts
import {
  DEFINER_FUNCTIONS,
  DEFINER_INTERNAL_FUNCTIONS,
} from './tenancy-catalog.js';

/** Role NOLOGIN sở hữu đối tượng tạo trong migration dưới `SET LOCAL ROLE <role>` (SP3 §6.13, SP6 §3.2). */
export const NOLOGIN_OWNER_ROLES = [
  'tenancy_definer',
  'sweep_definer',
  'partition_owner',
] as const;
export type NologinOwnerRole = (typeof NOLOGIN_OWNER_ROLES)[number];

/**
 * Tập tên theo plan (như `tenancy-catalog.ts`): test so với HỢP các hằng đang có. Plan 6.0 khai fixture; 6A/6C/SP5/SP7 THÊM
 * hằng `…_6A`, `…_6C`… và nối vào hợp, không sửa hằng có sẵn.
 */
export const SWEEP_DEFINER_FUNCTIONS_FIXTURE = ['fixture_orgs_due'] as const;
export const SWEEP_DEFINER_READ_TABLES_FIXTURE = ['fixture_sweep_items'] as const;
export const PARTITION_OWNER_FUNCTIONS_FIXTURE = ['fixture_part_events_maintain'] as const;
export const PARTITION_OWNER_TRIGGER_FUNCTIONS_FIXTURE = ['fixture_part_events_append_only'] as const;
export const PARTITIONED_TABLES_FIXTURE = ['fixture_part_events'] as const;

/** Hàm quét xuyên org (SECURITY DEFINER, STABLE, `app_user` gọi). */
export const SWEEP_DEFINER_FUNCTIONS: readonly string[] = [...SWEEP_DEFINER_FUNCTIONS_FIXTURE];
/** Bảng có policy `<bảng>_definer_read … TO sweep_definer`. */
export const SWEEP_DEFINER_READ_TABLES: readonly string[] = [...SWEEP_DEFINER_READ_TABLES_FIXTURE];
/** Hàm bảo trì partition (SECURITY DEFINER, VOLATILE, `app_user` gọi). */
export const PARTITION_OWNER_FUNCTIONS: readonly string[] = [...PARTITION_OWNER_FUNCTIONS_FIXTURE];
/** Hàm trigger thuộc `partition_owner` (không SECURITY DEFINER, không ai EXECUTE). */
export const PARTITION_OWNER_TRIGGER_FUNCTIONS: readonly string[] = [...PARTITION_OWNER_TRIGGER_FUNCTIONS_FIXTURE];
export const PARTITIONED_TABLES: readonly string[] = [...PARTITIONED_TABLES_FIXTURE];

/** Hàm → role chủ, cho quét tĩnh migration. */
export const OWNED_FUNCTIONS: Readonly<Record<NologinOwnerRole, readonly string[]>> = {
  tenancy_definer: [...DEFINER_FUNCTIONS, ...DEFINER_INTERNAL_FUNCTIONS],
  sweep_definer: SWEEP_DEFINER_FUNCTIONS,
  partition_owner: [...PARTITION_OWNER_FUNCTIONS, ...PARTITION_OWNER_TRIGGER_FUNCTIONS],
};
```

- [ ] **Step 2: Quét tĩnh theo role (viết lại; fail trên chuỗi xấu mới trước khi có code)**

`test/unit/migrations/migration-scan.spec.ts` (thay toàn bộ file; giữ nguyên mọi thông điệp của bản 3A cho `tenancy_definer`):
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOLOGIN_OWNER_ROLES,
  OWNED_FUNCTIONS,
  type NologinOwnerRole,
} from '../../support/core-catalog.js';

/** Migration production và fixture của test (fixture 6.0 tạo hàm của `sweep_definer`/`partition_owner`). */
const ROOTS = ['src/migrations', 'test/fixtures/migrations'];
const CREATE_FN = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_.]*)\s*\(/gi;
const DROP_FN = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_.]*)\s*\(/gi;
const SET_ROLE = new RegExp(`SET\\s+LOCAL\\s+ROLE\\s+(${NOLOGIN_OWNER_ROLES.join('|')})\\b`, 'gi');
const RESET_ROLE = /RESET\s+ROLE/gi;
const NO_FORCE = /NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
/** Bảng partitioned phải thuộc `partition_owner` (spec SP6 §3.2 luật 1, §6.1). */
const CREATE_PARTITIONED = /CREATE\s+TABLE\s+([a-z_][a-z0-9_.]*)\s*\([^;]*?\)\s*PARTITION\s+BY/gi;
/** Câu `RAISE` của khối khẳng định bước 7 (spec SP3 §8.8): mọi migration có `NO FORCE` phải kết thúc bằng khối này. */
const FORCE_ASSERTION = 'a tenant table lost FORCE ROW LEVEL SECURITY';

type Owned = Readonly<Record<NologinOwnerRole, readonly string[]>>;
type Block = { role: NologinOwnerRole; from: number; to: number };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const bare = (name: string) => name.replace(/^public\./, '');
const positions = (text: string, re: RegExp) =>
  [...text.matchAll(re)].map((m) => ({ at: m.index ?? -1, name: bare(m[1] ?? '') }));

function methodsOf(src: string): { up: string; down: string } {
  const up = src.indexOf('override up(');
  const down = src.indexOf('override down(');
  if (up < 0 || down < up) throw new Error('a migration declares override up() and then override down()');
  return { up: src.slice(up, down), down: src.slice(down) };
}

/** Các khối `SET LOCAL ROLE <role> … RESET ROLE`; vấn đề ghép cặp (nếu có) trả trong `problem`. */
function blocksOf(label: string, body: string): { blocks: Block[]; problem?: string } {
  const sets = [...body.matchAll(SET_ROLE)].map((m) => ({
    at: m.index ?? -1,
    role: NOLOGIN_OWNER_ROLES.find((r) => r === (m[1] ?? '').toLowerCase()),
  }));
  const resets = [...body.matchAll(RESET_ROLE)].map((m) => m.index ?? -1);
  const blocks: Block[] = [];
  for (const [i, s] of sets.entries()) {
    const end = resets[i];
    const next = sets[i + 1]?.at ?? Number.POSITIVE_INFINITY;
    if (!s.role || end === undefined || end < s.at || end > next)
      return { blocks, problem: `${label}: every SET LOCAL ROLE ${s.role ?? '?'} needs a RESET ROLE after it` };
    blocks.push({ role: s.role, from: s.at, to: end });
  }
  if (resets.length !== sets.length)
    return { blocks, problem: `${label}: RESET ROLE without a matching SET LOCAL ROLE` };
  return { blocks };
}

/** Mọi vi phạm của một file migration; rỗng = hợp lệ. Hàm thuần để test chính bộ quét bằng chuỗi xấu. */
function scanMigration(src: string, owned: Owned): string[] {
  const problems: string[] = [];
  if (/isTransactional/.test(src)) problems.push('overrides isTransactional()');
  if (/SET\s+CONSTRAINTS\s+ALL/i.test(src)) problems.push('uses SET CONSTRAINTS ALL');
  const { up, down } = methodsOf(src);
  const dropped = new Set(positions(down, DROP_FN).map((p) => p.name));
  for (const { name } of positions(up, CREATE_FN))
    if (!dropped.has(name)) problems.push(`up creates function ${name} that down never drops`);
  for (const [label, body] of [
    ['up', up],
    ['down', down],
  ] as const) {
    const { blocks, problem } = blocksOf(label, body);
    if (problem) problems.push(problem);
    const inside = (at: number, role: NologinOwnerRole) =>
      blocks.some((b) => b.role === role && b.from < at && at < b.to);
    const fns = [...positions(body, CREATE_FN), ...positions(body, DROP_FN)];
    for (const role of NOLOGIN_OWNER_ROLES)
      for (const fn of fns)
        if (owned[role].includes(fn.name) && !inside(fn.at, role))
          problems.push(
            `${label}: definer function ${fn.name} is created or dropped outside SET LOCAL ROLE ${role} … RESET ROLE`,
          );
    for (const t of positions(body, CREATE_PARTITIONED))
      if (!inside(t.at, 'partition_owner'))
        problems.push(`${label}: partitioned table ${t.name} is created outside SET LOCAL ROLE partition_owner … RESET ROLE`);
    const lastNoForce = positions(body, NO_FORCE).at(-1)?.at;
    if (lastNoForce !== undefined && !body.slice(lastNoForce).includes(FORCE_ASSERTION))
      problems.push(`${label}: NO FORCE ROW LEVEL SECURITY without the final FORCE assertion block`);
  }
  return problems;
}

const only = (role: NologinOwnerRole, fns: string[]): Owned => ({
  tenancy_definer: [],
  sweep_definer: [],
  partition_owner: [],
  [role]: fns,
});
const wrap = (up: string, down: string) => `class M { override up() { ${up} } override down() { ${down} } }`;

describe('migration scanner (spec SP3 §6.13, §18.5; SP6 §3.2)', () => {
  it('catches every forbidden shape of 3A', () => {
    expect(scanMigration(wrap('CREATE FUNCTION f() x', ''), only('tenancy_definer', []))).toEqual([
      'up creates function f that down never drops',
    ]);
    expect(
      scanMigration(
        wrap(
          'SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x',
          'SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE',
        ),
        only('tenancy_definer', ['g']),
      ),
    ).toContain('up: every SET LOCAL ROLE tenancy_definer needs a RESET ROLE after it');
    expect(
      scanMigration(wrap('CREATE FUNCTION public.g() x', 'DROP FUNCTION public.g()'), only('tenancy_definer', ['g'])),
    ).toEqual([
      'up: definer function g is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE',
      'down: definer function g is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE',
    ]);
    expect(
      scanMigration(
        wrap('ALTER TABLE t NO FORCE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY', ''),
        only('tenancy_definer', []),
      ),
    ).toEqual(['up: NO FORCE ROW LEVEL SECURITY without the final FORCE assertion block']);
    expect(scanMigration(`${wrap('', '')} isTransactional`, only('tenancy_definer', []))).toContain(
      'overrides isTransactional()',
    );
    expect(scanMigration(wrap('SET CONSTRAINTS ALL IMMEDIATE', ''), only('tenancy_definer', []))).toContain(
      'uses SET CONSTRAINTS ALL',
    );
  });
  it('catches a function of sweep_definer / partition_owner created under the wrong role or no role', () => {
    expect(
      scanMigration(
        wrap(
          'SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.s() x; RESET ROLE',
          'SET LOCAL ROLE sweep_definer; DROP FUNCTION public.s(); RESET ROLE',
        ),
        only('sweep_definer', ['s']),
      ),
    ).toEqual(['up: definer function s is created or dropped outside SET LOCAL ROLE sweep_definer … RESET ROLE']);
    expect(
      scanMigration(wrap('CREATE FUNCTION public.m() x', 'DROP FUNCTION public.m()'), only('partition_owner', ['m'])),
    ).toHaveLength(2);
  });
  it('catches a partitioned table created outside SET LOCAL ROLE partition_owner', () => {
    expect(
      scanMigration(
        wrap('CREATE TABLE p (a int, b timestamptz, PRIMARY KEY (b, a)) PARTITION BY RANGE (b)', 'DROP TABLE p'),
        only('partition_owner', []),
      ),
    ).toEqual(['up: partitioned table p is created outside SET LOCAL ROLE partition_owner … RESET ROLE']);
  });
  it('accepts the correct shapes of every role', () => {
    expect(
      scanMigration(
        wrap(
          `SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x; RESET ROLE; SET LOCAL ROLE sweep_definer; CREATE FUNCTION public.s() x; RESET ROLE; SET LOCAL ROLE partition_owner; CREATE TABLE p (a int, b timestamptz, PRIMARY KEY (b, a)) PARTITION BY RANGE (b); CREATE FUNCTION public.m() x; RESET ROLE; ALTER TABLE t NO FORCE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY; RAISE '${FORCE_ASSERTION}'`,
          'SET LOCAL ROLE partition_owner; DROP TABLE p; DROP FUNCTION public.m(); RESET ROLE; SET LOCAL ROLE sweep_definer; DROP FUNCTION public.s(); RESET ROLE; SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE',
        ),
        { tenancy_definer: ['g'], sweep_definer: ['s'], partition_owner: ['m'] },
      ),
    ).toEqual([]);
  });
  it.each(ROOTS.flatMap(files))('%s passes the scanner', (file) => {
    expect(scanMigration(readFileSync(file, 'utf8'), OWNED_FUNCTIONS)).toEqual([]);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/migrations/migration-scan.spec.ts`
Expected: PASS với migration hiện có (của SP1–3A và `kill_switches`) — bộ quét mới là phần mở rộng tương thích; ba ca mới bắt đúng chuỗi xấu. (Trước khi có code quét mới, chính ba ca mới FAIL — viết test, chạy thấy đỏ, rồi thay hàm quét.)

- [ ] **Step 3: Catalog partition và hàm definer (fail vì fixture chưa có)**

`test/integration/core/database/rls-catalog.spec.ts`:
- import thêm:
```ts
import {
  PARTITIONED_TABLES,
  PARTITION_OWNER_FUNCTIONS,
  PARTITION_OWNER_TRIGGER_FUNCTIONS,
  SWEEP_DEFINER_FUNCTIONS,
  SWEEP_DEFINER_READ_TABLES,
} from '../../../support/core-catalog.js';
```
- hàm `tables()`: thêm `AND NOT c.relispartition` vào `WHERE` (partition không mang RLS — chúng không có grant, ca riêng dưới đây khẳng định; bảng cha partitioned (`relkind = 'p'`) vẫn qua `assertTenantSecurity`: luật (a)).
- ca `allows USING (true) only for SELECT TO app_relay, or SELECT TO tenancy_definer on the declared tables` → đổi tên `… or SELECT TO tenancy_definer / sweep_definer on the declared tables`, thân vòng lặp thay bằng:
```ts
    for (const policy of unrestricted) {
      const role = policy.roles.length === 1 ? policy.roles[0] : undefined;
      expect(policy.cmd, policy.policyname).toBe('SELECT');
      if (role === 'tenancy_definer')
        expect(DEFINER_READ_TABLES, policy.policyname).toContain(policy.tablename);
      else if (role === 'sweep_definer') {
        expect(SWEEP_DEFINER_READ_TABLES, policy.policyname).toContain(policy.tablename);
        expect(policy.policyname).toBe(`${policy.tablename}_definer_read`);
      } else expect(policy.roles, policy.policyname).toEqual(['app_relay']);
    }
```
và sau khẳng định tập `tenancy_definer` có sẵn, thêm:
```ts
    expect(
      unrestricted
        .filter((p) => p.roles[0] === 'sweep_definer')
        .map((p) => p.tablename)
        .sort(),
    ).toEqual([...SWEEP_DEFINER_READ_TABLES].sort());
```
- thêm vào `describe('RLS catalog …')`:
```ts
  it('every partitioned table is owned by partition_owner; its partitions grant nothing to app_user, app_relay or auth_user (SP6 §5.3 (a)(b), C-6)', async () => {
    const parents = await client.query<{ name: string; owner: string }>(
      `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'p' ORDER BY 1`,
    );
    expect(parents.rows).toEqual([...PARTITIONED_TABLES].sort().map((name) => ({ name, owner: 'partition_owner' })));
    const { rows } = await client.query<{ name: string; parent: string; owner: string; granted: boolean }>(
      `SELECT c.relname AS name, p.relname AS parent, pg_get_userbyid(c.relowner) AS owner,
         EXISTS (SELECT 1 FROM unnest(ARRAY['app_user', 'app_relay', 'auth_user']) AS r(role)
                 WHERE has_table_privilege(r.role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                    OR has_any_column_privilege(r.role, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')) AS granted
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE c.relnamespace = 'public'::regnamespace AND c.relispartition ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r, r.name).toMatchObject({ owner: 'partition_owner', granted: false });
    expect([...new Set(rows.map((r) => r.parent))].sort()).toEqual([...PARTITIONED_TABLES].sort());
  });
  it('sweep_definer holds column SELECT only (no table-level privilege anywhere in public)', async () => {
    const { rows } = await client.query(
      `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
         AND has_table_privilege('sweep_definer', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`,
    );
    expect(rows).toEqual([]);
    const cols = await client.query<{ table_name: string; privilege_type: string }>(
      `SELECT DISTINCT table_name, privilege_type FROM information_schema.column_privileges
       WHERE grantee = 'sweep_definer' AND table_schema = 'public' ORDER BY 1`,
    );
    expect(cols.rows.every((r) => r.privilege_type === 'SELECT')).toBe(true);
    expect(cols.rows.map((r) => r.table_name).sort()).toEqual([...SWEEP_DEFINER_READ_TABLES].sort());
  });
```
- trong `describe('schema and database privileges (R20)')`, thay ca `the SECURITY DEFINER set in public equals …` bằng:
```ts
  it('the SECURITY DEFINER set in public equals the tenancy, sweep and partition functions of every plan; each has its owner, volatility, search_path="" and EXECUTE for app_user only', async () => {
    const { rows } = await client.query<{
      name: string;
      owner: string;
      config: string[] | null;
      volatility: string;
      app: boolean;
      pub: boolean;
    }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
              p.provolatile AS volatility,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.name)).toEqual(
      [...DEFINER_FUNCTIONS, ...DEFINER_TRIGGER_FUNCTIONS, ...SWEEP_DEFINER_FUNCTIONS, ...PARTITION_OWNER_FUNCTIONS].sort(),
    );
    const expected = (owner: string, volatility: string) => ({
      owner,
      config: ['search_path=""'],
      volatility,
      app: true,
      pub: false,
    });
    for (const r of rows) {
      if (DEFINER_FUNCTIONS.includes(r.name)) expect(r, r.name).toMatchObject(expected('tenancy_definer', 's'));
      if (SWEEP_DEFINER_FUNCTIONS.includes(r.name)) expect(r, r.name).toMatchObject(expected('sweep_definer', 's'));
      if (PARTITION_OWNER_FUNCTIONS.includes(r.name)) expect(r, r.name).toMatchObject(expected('partition_owner', 'v'));
    }
  });
  it('trigger functions of partition_owner are owned by it, not SECURITY DEFINER, and nobody but the owner may EXECUTE them', async () => {
    const { rows } = await client.query(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
         has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[]) ORDER BY 1`,
      [[...PARTITION_OWNER_TRIGGER_FUNCTIONS]],
    );
    expect(rows).toEqual(
      [...PARTITION_OWNER_TRIGGER_FUNCTIONS].sort().map((name) => ({ name, owner: 'partition_owner', secdef: false, app: false, pub: false })),
    );
  });
```
Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts`
Expected: FAIL (không có bảng partitioned `fixture_part_events`, hàm `fixture_orgs_due`/`fixture_part_events_maintain` chưa có).

- [ ] **Step 4: Fixture migration (CLI) — thân hàm bảo trì chép nguyên văn mẫu spec §6.7 đã chạy ở spike P1**

Run: `pnpm exec mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_core_shared`
Sửa file sinh ra (giữ tên lớp/`name` do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Fixture của plan SP6 6.0 (spec SP6 §6.7, §6.8, §16 C-5, C-8b): một bảng tenant có hàm quét xuyên org của `sweep_definer`, và
 * một bảng partitioned của `partition_owner` với hàm bảo trì theo đúng mẫu mà 6B/6C viết cho bảng thật. Không có FK tới
 * `organizations` (dòng append-only không xoá được, sẽ chặn `seedOrg().dispose()`; FK dưới `partition_owner` đã đo ở spike P1).
 * Index: `fixture_sweep_items_tag_org_idx (tag, org_id)` → câu của `fixture_orgs_due` (lọc tag, keyset theo org);
 * `fixture_part_events_org_idx (org_id, recorded_at)` → RLS + đọc theo org, khai trên cha nên nhân bản sang partition.
 * `lockKey` 6900 (6001 audit, 6002 webhook — spec §6.7).
 */
export class Migration20260930000100_fixture_core_shared extends Migration {
  override name = 'Migration20260930000100_fixture_core_shared';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sweep_definer')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partition_owner') THEN
    RAISE EXCEPTION 'roles sweep_definer/partition_owner are missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);

    this.addSql(`CREATE TABLE fixture_sweep_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    tag TEXT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    this.addSql(`CREATE INDEX fixture_sweep_items_tag_org_idx ON fixture_sweep_items (tag, org_id);`);
    this.addSql(`ALTER TABLE fixture_sweep_items ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE fixture_sweep_items FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY fixture_sweep_items_tenant ON fixture_sweep_items TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`CREATE POLICY fixture_sweep_items_definer_read ON fixture_sweep_items FOR SELECT TO sweep_definer USING (true);`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON fixture_sweep_items TO app_user;`);
    this.addSql(`GRANT SELECT (org_id, tag, due_at) ON fixture_sweep_items TO sweep_definer;`);

    // Hàm quét: owner sweep_definer (R-X4), chữ ký cố định (p_after, p_limit) + tham số thêm theo tên (R-X14).
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this
      .addSql(`CREATE FUNCTION public.fixture_orgs_due(p_after uuid, p_limit integer, p_min_age_sec integer, p_tag text)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_after IS NULL OR p_limit IS NULL OR p_min_age_sec IS NULL OR p_tag IS NULL THEN
    RAISE EXCEPTION 'fixture_orgs_due: arguments must not be NULL';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'fixture_orgs_due: p_limit must be between 1 and 1000'; END IF;
  IF p_min_age_sec < 0 OR p_min_age_sec > 86400 THEN
    RAISE EXCEPTION 'fixture_orgs_due: p_min_age_sec must be between 0 and 86400';
  END IF;
  RETURN QUERY
    SELECT DISTINCT i.org_id FROM public.fixture_sweep_items i
    WHERE i.tag = p_tag AND i.due_at <= now() - make_interval(secs => p_min_age_sec) AND i.org_id > p_after
    ORDER BY i.org_id LIMIT p_limit;
END $$;`);
    this.addSql(`REVOKE ALL ON FUNCTION public.fixture_orgs_due(uuid, integer, integer, text) FROM PUBLIC;`);
    this.addSql(`GRANT EXECUTE ON FUNCTION public.fixture_orgs_due(uuid, integer, integer, text) TO app_user;`);
    this.addSql(`RESET ROLE;`);

    // Bảng partitioned + hàm bảo trì: owner partition_owner; policy/grant/index/trigger khai trên cha (spec §6.1).
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`CREATE TABLE fixture_part_events (
    org_id UUID NOT NULL,
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    body TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (recorded_at, id)) PARTITION BY RANGE (recorded_at);`);
    this.addSql(`CREATE INDEX fixture_part_events_org_idx ON fixture_part_events (org_id, recorded_at);`);
    this.addSql(`ALTER TABLE fixture_part_events ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE fixture_part_events FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY fixture_part_events_tenant ON fixture_part_events TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT ON fixture_part_events TO app_user;`);
    this.addSql(`CREATE FUNCTION public.fixture_part_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'fixture_part_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;`);
    this.addSql(`REVOKE ALL ON FUNCTION public.fixture_part_events_append_only() FROM PUBLIC;`);
    this.addSql(`CREATE TRIGGER fixture_part_events_append_only BEFORE UPDATE OR DELETE ON fixture_part_events
    FOR EACH ROW EXECUTE FUNCTION public.fixture_part_events_append_only();`);
    this
      .addSql(`CREATE FUNCTION public.fixture_part_events_maintain(p_retention_months integer, p_premake_months integer)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_base timestamp;
  v_lo timestamp;
  v_name text;
  v_cutoff timestamp;
  r record;
BEGIN
  IF p_retention_months IS NULL OR p_premake_months IS NULL THEN
    RAISE EXCEPTION 'fixture_part_events_maintain: arguments must not be NULL';
  END IF;
  -- Sàn retention cứng ở đây: SQLi bằng app_user không hạ được retention dưới sàn.
  IF p_retention_months < 1 OR p_retention_months > 120 THEN
    RAISE EXCEPTION 'fixture_part_events_maintain: p_retention_months must be between 1 and 120';
  END IF;
  IF p_premake_months < 1 OR p_premake_months > 12 THEN
    RAISE EXCEPTION 'fixture_part_events_maintain: p_premake_months must be between 1 and 12';
  END IF;
  -- R6-17: một lượt mỗi lúc; lượt thứ hai là no-op.
  IF NOT pg_try_advisory_xact_lock(6900) THEN RETURN; END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  -- Mốc tháng theo UTC, không theo TimeZone của session (Review Focus 4).
  v_base := date_trunc('month', now() AT TIME ZONE 'UTC');
  FOR i IN 0..p_premake_months LOOP
    v_lo := v_base + make_interval(months => i);
    v_name := 'fixture_part_events_p' || to_char(v_lo, 'YYYYMM');
    IF to_regclass('public.' || v_name) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I (LIKE public.fixture_part_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', v_name);
      EXECUTE format('ALTER TABLE public.fixture_part_events ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
        v_name, v_lo AT TIME ZONE 'UTC', (v_lo + interval '1 month') AT TIME ZONE 'UTC');
      action := 'created'; partition_name := v_name; RETURN NEXT;
    END IF;
  END LOOP;
  v_cutoff := v_base - make_interval(months => p_retention_months);
  FOR r IN SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'public.fixture_part_events'::regclass ORDER BY c.relname LOOP
    IF r.relname !~ '^fixture_part_events_p[0-9]{6}$' THEN
      RAISE EXCEPTION 'fixture_part_events_maintain: unexpected partition %', r.relname;
    END IF;
    v_lo := to_date(substring(r.relname FROM '[0-9]{6}$'), 'YYYYMM')::timestamp;
    IF v_lo + interval '1 month' <= v_cutoff THEN
      EXECUTE format('ALTER TABLE public.fixture_part_events DETACH PARTITION public.%I', r.relname);
      EXECUTE format('DROP TABLE public.%I', r.relname);
      action := 'dropped'; partition_name := r.relname; RETURN NEXT;
    END IF;
  END LOOP;
END $$;`);
    this.addSql(`REVOKE ALL ON FUNCTION public.fixture_part_events_maintain(integer, integer) FROM PUBLIC;`);
    this.addSql(`GRANT EXECUTE ON FUNCTION public.fixture_part_events_maintain(integer, integer) TO app_user;`);
    // Partition đầu (tháng hiện tại + 3 tháng tới) do chính hàm bảo trì tạo (spec §6.7).
    this.addSql(`SELECT count(*) FROM public.fixture_part_events_maintain(1, 3);`);
    this.addSql(`RESET ROLE;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`SET LOCAL ROLE partition_owner;`);
    this.addSql(`DROP TABLE fixture_part_events;`);
    this.addSql(`DROP FUNCTION public.fixture_part_events_maintain(integer, integer);`);
    this.addSql(`DROP FUNCTION public.fixture_part_events_append_only();`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`SET LOCAL ROLE sweep_definer;`);
    this.addSql(`DROP FUNCTION public.fixture_orgs_due(uuid, integer, integer, text);`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE fixture_sweep_items;`);
  }
}
```
(Tên lớp trong khối trên là minh hoạ: dùng đúng tên do CLI sinh.)

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/database
```
Expected: PASS; `migrations.spec.ts` chạy up → down → up và sweep từng bước của fixture mới trên database riêng (drop bảng cha kéo theo partition; catalog trước/sau bằng nhau); catalog: bảng cha `fixture_part_events` qua luật tenant (RLS + FORCE + policy), 4 partition thuộc `partition_owner`, không grant; tập `SECURITY DEFINER` = tenancy ∪ sweep ∪ partition; policy `fixture_sweep_items_definer_read`.

- [ ] **Step 6: Commit**

```bash
git add test/support/core-catalog.ts test/unit/migrations/migration-scan.spec.ts test/fixtures/migrations test/integration/core/database/rls-catalog.spec.ts
git commit -m "test(db): sweep and partition fixtures owned by the new roles; migration scan per NOLOGIN owner role; catalog rules for partitions"
```

---

### Task 11: `core/sweep` — `defineOrgSweep`, `OrgSweepRunner`, `jobId` theo slot (C-8, C-8b, R-X4, R-X14)

**Files:**
- Create: `src/core/sweep/org-sweep.ts`, `src/core/sweep/org-sweep.runner.ts`, `src/core/sweep/sweep.module.ts`, `test/unit/core/sweep/org-sweep.spec.ts`, `test/unit/core/sweep/org-sweep.runner.spec.ts`, `test/integration/core/sweep/org-sweep.spec.ts`, `test/integration/core/sweep/org-sweep-signatures.spec.ts`, `test/support/org-sweep-signatures.ts`
- Modify: `src/core/sweep/index.ts`, `src/app-worker.module.ts`

**Interfaces:**
- Consumes: `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` (Task 5), `defineJob`, `MaintenanceQueue`, `JobQueue`, `type JobDef`, `type EnqueueItem` (`core/queue`), `defineCron` (`core/scheduler/cron-definition.ts`), `minGapSec` (`core/scheduler/schedule-validation.ts`), `Db`, `UnitOfWork`, `RequestContext`, `METER`; fixture `fixture_orgs_due`, `fixture_sweep_items` (Task 10); `withAppClient`, `inOrgTx`, `BullmqJobQueue.queue(name)`.
- Produces (6A, 6C, SP5, SP7 dùng đúng tên):
  - `defineOrgSweep({ key, definerFunction, extraParams?, orgJob, jobIdPrefix, schedule, batch }): OrgSweepDef`; `type OrgSweepParams = Readonly<Record<string, number | boolean | string>>`, `type OrgSweepBatch = { size: number; maxBatches: number }`; `OrgSweepDef.job` là job quét (tên = `key`, queue `maintenance`, payload `{}`), đã kèm `defineCron({ key })`; `orgSweepRegistry()`, `findOrgSweep(key)`, `sweepJobId(def, orgId, slot)`, `class OrgSweepDefinitionError`.
  - `OrgSweepRunner.run(def: OrgSweepDef, at?: Date): Promise<OrgSweepResult>`, `type OrgSweepResult = { batches: number; enqueued: number; backlog: boolean; slot: number }`. Module khai handler mỏng: `@Injectable() @JobHandler(MySweep.job) class MySweepHandler { constructor(private readonly runner: OrgSweepRunner) {} handle() { return this.runner.run(MySweep); } }` (chỉ trong `forWorker()`).
  - `SweepModule` (`@Global`, worker) — metric `org_sweep_orgs_enqueued_total{key}`, `org_sweep_backlog_total{key}`, `org_sweep_duration_seconds{key}`; log WARN `org_sweep_backlog { key }`.
  - `test/support/org-sweep-signatures.ts`: `sweepSignatureProblems(client, { definerFunction, extraParams }): Promise<string[]>` — plan nào thêm sweep chạy lại `org-sweep-signatures.spec.ts`.

- [ ] **Step 1: Unit test định nghĩa và runner (fail)**

`test/unit/core/sweep/org-sweep.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MaintenanceQueue,
  defineJob,
  defineQueue,
  findJob,
} from '../../../../src/core/queue/index.js';
import { cronRegistry } from '../../../../src/core/scheduler/cron-definition.js';
import {
  OrgSweepDefinitionError,
  defineOrgSweep,
  findOrgSweep,
  sweepJobId,
} from '../../../../src/core/sweep/index.js';

const Q = defineQueue('unit-sweep-def', { kind: 'io' });
const OrgJob = defineJob({ name: 'unit.sweep-def-org', queue: Q, version: 1, schema: z.object({}) });
const base = {
  orgJob: OrgJob,
  schedule: () => ({ cron: '*/5 * * * *', tz: 'UTC' }),
  batch: () => ({ size: 10, maxBatches: 2 }),
};

describe('defineOrgSweep (spec SP6 §5.3 core/sweep, R-X14)', () => {
  it('registers the sweep, its maintenance job named by key and its cron', () => {
    const def = defineOrgSweep({ ...base, key: 'unit.sweep-orgs-a', definerFunction: 'unit_orgs_due', jobIdPrefix: 'unit-a' });
    expect(findOrgSweep('unit.sweep-orgs-a')).toBe(def);
    expect(findJob('unit.sweep-orgs-a')).toBe(def.job);
    expect(def.job.queue).toBe(MaintenanceQueue);
    expect(cronRegistry().find((c) => c.key === 'unit.sweep-orgs-a')?.job).toBe(def.job);
    expect(def.extraParams()).toEqual({});
    expect(sweepJobId(def, '0199a000-0000-7000-8000-000000000001', 42)).toBe('unit-a-0199a000-0000-7000-8000-000000000001-42');
  });
  it.each([
    [{ definerFunction: 'Bad-Name', jobIdPrefix: 'ok' }, /definerFunction/],
    [{ definerFunction: 'public.x', jobIdPrefix: 'ok' }, /definerFunction/],
    [{ definerFunction: 'ok_fn', jobIdPrefix: 'Bad' }, /jobIdPrefix/],
    [{ definerFunction: 'ok_fn', jobIdPrefix: 'a:b' }, /jobIdPrefix/],
  ] as const)('refuses a malformed name %j at definition', (names, re) => {
    expect(() => defineOrgSweep({ ...base, key: 'unit.sweep-orgs-bad', ...names })).toThrow(OrgSweepDefinitionError);
    expect(() => defineOrgSweep({ ...base, key: 'unit.sweep-orgs-bad', ...names })).toThrow(re);
  });
  it('refuses an org job that does not accept the payload {} (the org travels in meta.orgId)', () => {
    const Strict = defineJob({ name: 'unit.sweep-def-strict', queue: Q, version: 1, schema: z.object({ fileId: z.string() }) });
    expect(() =>
      defineOrgSweep({ ...base, orgJob: Strict, key: 'unit.sweep-orgs-strict', definerFunction: 'x_due', jobIdPrefix: 'x' }),
    ).toThrow(/must accept the payload \{\}/);
  });
});
```
`test/unit/core/sweep/org-sweep.runner.spec.ts`:
```ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { RequestContext } from '../../../../src/core/context/index.js';
import type { Db, UnitOfWork } from '../../../../src/core/database/index.js';
import {
  defineJob,
  defineQueue,
  type EnqueueItem,
  type JobQueue,
} from '../../../../src/core/queue/index.js';
import {
  DEFINER_LIMIT_MAX,
  OrgSweepDefinitionError,
  OrgSweepRunner,
  PURGE_CURSOR_START,
  defineOrgSweep,
  type OrgSweepBatch,
  type OrgSweepParams,
} from '../../../../src/core/sweep/index.js';

const Q = defineQueue('unit-sweep-run', { kind: 'io' });
const OrgJob = defineJob({ name: 'unit.sweep-run-org', queue: Q, version: 1, schema: z.object({}) });
let batch: OrgSweepBatch = { size: 2, maxBatches: 10 };
let params: () => OrgSweepParams = () => ({ p_tag: 't', p_min_age_sec: 60, p_strict: true });
const Sweep = defineOrgSweep({
  key: 'unit.sweep-run',
  definerFunction: 'unit_orgs_due',
  extraParams: () => params(),
  orgJob: OrgJob,
  jobIdPrefix: 'unit-run',
  schedule: () => ({ cron: '*/5 * * * *', tz: 'UTC' }),
  batch: () => batch,
});
/** `*/5 * * * *` UTC → slot 300 s. */
const SLOT_SEC = 300;
const AT = new Date('2026-09-29T10:07:00Z');
const org = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function harness(pages: string[][], opts: { inTx?: boolean; orgId?: string } = {}) {
  const sql: string[] = [];
  const args: unknown[][] = [];
  const execute = vi.fn(async (s: string, a: unknown[] = []) => {
    sql.push(s);
    args.push(a);
    return (pages.shift() ?? []).map((org_id) => ({ org_id }));
  });
  const enqueueMany = vi.fn(async (items: EnqueueItem[]) => items.map((i) => i.opts?.jobId ?? ''));
  const runner = new OrgSweepRunner(
    { execute } as Pick<Db, 'execute'> as Db,
    { inTransaction: () => opts.inTx ?? false } as Pick<UnitOfWork, 'inTransaction'> as UnitOfWork,
    { orgId: () => opts.orgId } as Pick<RequestContext, 'orgId'> as RequestContext,
    { enqueueMany } as Pick<JobQueue, 'enqueueMany'> as JobQueue,
  );
  runner.onModuleInit();
  return { runner, execute, enqueueMany, sql, args };
}

describe('OrgSweepRunner (spec SP6 §5.3 core/sweep, C-8)', () => {
  afterEach(() => {
    batch = { size: 2, maxBatches: 10 };
    params = () => ({ p_tag: 't', p_min_age_sec: 60, p_strict: true });
    vi.restoreAllMocks();
  });
  it('calls the definer with named, explicitly cast parameters and walks the keyset until a short batch', async () => {
    const h = harness([[org(1), org(2)], [org(3), org(4)], [org(5)]]);
    const res = await h.runner.run(Sweep, AT);
    expect(h.sql[0]).toBe(
      'SELECT org_id::text AS org_id FROM public.unit_orgs_due(p_after => ?::uuid, p_limit => ?::integer, p_tag => ?::text, p_min_age_sec => ?::integer, p_strict => ?::boolean)',
    );
    expect(h.args.map((a) => a[0])).toEqual([PURGE_CURSOR_START, org(2), org(4)]);
    expect(h.args[0]).toEqual([PURGE_CURSOR_START, 2, 't', 60, true]);
    const slot = Math.floor(AT.getTime() / 1000 / SLOT_SEC);
    expect(res).toEqual({ batches: 3, enqueued: 5, backlog: false, slot });
    const items = h.enqueueMany.mock.calls.flatMap(([i]) => i);
    expect(items.map((i) => [i.job, i.payload, i.opts?.jobId, i.opts?.meta?.orgId])).toEqual(
      [1, 2, 3, 4, 5].map((n) => [OrgJob, {}, `unit-run-${org(n)}-${slot}`, org(n)]),
    );
  });
  it('an empty first batch enqueues nothing', async () => {
    const h = harness([[]]);
    expect(await h.runner.run(Sweep, AT)).toMatchObject({ batches: 1, enqueued: 0, backlog: false });
    expect(h.enqueueMany).not.toHaveBeenCalled();
  });
  it('the same instant keeps its slot; the next slot changes every jobId', async () => {
    const a = await harness([[org(1)]]).runner.run(Sweep, AT);
    const b = await harness([[org(1)]]).runner.run(Sweep, new Date(AT.getTime() + SLOT_SEC * 1000));
    expect(b.slot).toBe(a.slot + 1);
  });
  it('a full last batch at maxBatches warns org_sweep_backlog and reports backlog', async () => {
    batch = { size: 2, maxBatches: 2 };
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const h = harness([[org(1), org(2)], [org(3), org(4)], [org(5)]]);
    expect(await h.runner.run(Sweep, AT)).toMatchObject({ batches: 2, enqueued: 4, backlog: true });
    expect(warn.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'org_sweep_backlog')).toBe(true);
  });
  it('rejects rows that are not strictly ascending after the cursor (Review Focus 2)', async () => {
    await expect(harness([[org(2), org(1)]]).runner.run(Sweep, AT)).rejects.toThrow(/strictly ascending/);
    await expect(harness([[org(1), org(1)]]).runner.run(Sweep, AT)).rejects.toThrow(/strictly ascending/);
    await expect(harness([[org(1), org(2)], [org(2), org(3)]]).runner.run(Sweep, AT)).rejects.toThrow(/strictly ascending/);
  });
  it('rejects more rows than p_limit (Review Focus 2)', async () => {
    await expect(harness([[org(1), org(2), org(3)]]).runner.run(Sweep, AT)).rejects.toThrow(OrgSweepDefinitionError);
  });
  it.each([
    [{ p_after: 'x' }],
    [{ p_limit: 1 }],
    [{ tag: 'x' }],
    [{ p_x: 1.5 }],
    [{ p_x: 2 ** 31 }],
    [{ p_x: Number.NaN }],
    [{ p_x: Number.POSITIVE_INFINITY }],
  ])('rejects extra parameters %j before any SQL (Review Focus 3)', async (bad) => {
    params = () => bad;
    const h = harness([[org(1)]]);
    await expect(h.runner.run(Sweep, AT)).rejects.toThrow(OrgSweepDefinitionError);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('rejects extra parameters that are not 32-bit integers, booleans or strings (Review Focus 3)', async () => {
    // Giả lập config/JS trả một giá trị ngoài kiểu khai báo (Date): `Reflect.apply` trả `any` ngầm, không cần ép kiểu.
    const fromJs: unknown = { p_when: new Date() };
    params = () => Reflect.apply((x: unknown) => x, undefined, [fromJs]);
    const h = harness([[org(1)]]);
    await expect(h.runner.run(Sweep, AT)).rejects.toThrow(/must be a 32-bit integer, a boolean or a string/);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it.each([0, DEFINER_LIMIT_MAX + 1, 1.5])('rejects batch size %s before any SQL', async (size) => {
    batch = { size, maxBatches: 1 };
    const h = harness([[org(1)]]);
    await expect(h.runner.run(Sweep, AT)).rejects.toThrow(OrgSweepDefinitionError);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('refuses to run inside a transaction or an OrgScope, and refuses a def that defineOrgSweep did not create', async () => {
    await expect(harness([], { inTx: true }).runner.run(Sweep, AT)).rejects.toThrow(/outside any transaction and OrgScope/);
    await expect(harness([], { orgId: org(9) }).runner.run(Sweep, AT)).rejects.toThrow(/outside any transaction and OrgScope/);
    await expect(harness([]).runner.run({ ...Sweep }, AT)).rejects.toThrow(/was not created by defineOrgSweep/);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/core/sweep`
Expected: FAIL (`defineOrgSweep` chưa có).

- [ ] **Step 2: Cài `core/sweep`**

`src/core/sweep/org-sweep.ts`:
```ts
import { z } from 'zod';
import { MaintenanceQueue, defineJob, type JobDef } from '../queue/index.js';
import { defineCron } from '../scheduler/cron-definition.js';
import { DEFINER_LIMIT_MAX } from './constants.js';

export class OrgSweepDefinitionError extends Error {
  constructor(key: string, detail: string) {
    super(`Org sweep "${key}": ${detail}`);
    this.name = 'OrgSweepDefinitionError';
  }
}

export type OrgSweepParamValue = number | boolean | string;
/** Tham số thêm của hàm SQL, THEO TÊN (`p_…`), đọc mỗi lượt (R-X14). Khoảng thời gian truyền bằng số nguyên giây. */
export type OrgSweepParams = Readonly<Record<string, OrgSweepParamValue>>;
export type OrgSweepBatch = { size: number; maxBatches: number };
export type OrgSweepDef = {
  readonly key: string;
  /** Tên hàm SQL trong schema `public`, chữ ký cố định `(p_after uuid, p_limit integer, <tham số thêm>)`, `RETURNS TABLE (org_id uuid)`. */
  readonly definerFunction: string;
  readonly extraParams: () => OrgSweepParams;
  /** Job theo org (queue của module, payload `{}`, org ở `meta.orgId`); phải idempotent. */
  readonly orgJob: JobDef;
  readonly jobIdPrefix: string;
  readonly schedule: () => { cron: string; tz: string };
  readonly batch: () => OrgSweepBatch;
  /** Job quét: tên = `key`, queue `maintenance`, payload `{}`; module khai handler mỏng gọi `OrgSweepRunner.run`. */
  readonly job: JobDef;
};

const FUNCTION_NAME = /^[a-z][a-z0-9_]*$/;
const JOB_ID_PREFIX = /^[a-z][a-z0-9-]*$/;
const PARAM_NAME = /^p_[a-z][a-z0-9_]*$/;
const RESERVED = new Set(['p_after', 'p_limit']);
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
const sweeps = new Map<string, OrgSweepDef>();

/**
 * Một cơ chế quét xuyên org cho mọi SP (R-X4, R-X14; spec SP6 §5.3): cron → hàm SQL `SECURITY DEFINER` của `sweep_definer`
 * trả org đến hạn theo keyset → một job theo org. Registry lúc import; tự `defineJob` job quét và `defineCron`.
 * Không nhận callback TS: runner là nơi duy nhất gọi hàm definer, luôn qua `EXECUTE` của `app_user`.
 */
export function defineOrgSweep(input: {
  key: string;
  definerFunction: string;
  extraParams?: () => OrgSweepParams;
  orgJob: JobDef;
  jobIdPrefix: string;
  schedule: () => { cron: string; tz: string };
  batch: () => OrgSweepBatch;
}): OrgSweepDef {
  const fail = (detail: string): never => {
    throw new OrgSweepDefinitionError(input.key, detail);
  };
  if (!FUNCTION_NAME.test(input.definerFunction))
    fail(`definerFunction "${input.definerFunction}" must match ${FUNCTION_NAME} (a function of schema public)`);
  if (!JOB_ID_PREFIX.test(input.jobIdPrefix))
    fail(`jobIdPrefix "${input.jobIdPrefix}" must match ${JOB_ID_PREFIX}`);
  if (!input.orgJob.schema.safeParse({}).success)
    fail(`orgJob "${input.orgJob.name}" must accept the payload {} (the org travels in meta.orgId)`);
  if (sweeps.has(input.key)) fail('already defined');
  const job = defineJob({ name: input.key, queue: MaintenanceQueue, version: 1, schema: z.object({}) });
  defineCron({ key: input.key, job, payload: {}, schedule: input.schedule });
  const def: OrgSweepDef = {
    key: input.key,
    definerFunction: input.definerFunction,
    extraParams: input.extraParams ?? (() => ({})),
    orgJob: input.orgJob,
    jobIdPrefix: input.jobIdPrefix,
    schedule: input.schedule,
    batch: input.batch,
    job,
  };
  sweeps.set(input.key, def);
  return def;
}

export const orgSweepRegistry = (): OrgSweepDef[] => [...sweeps.values()];
export const findOrgSweep = (key: string): OrgSweepDef | undefined => sweeps.get(key);
/** Chống trùng duy nhất (spec §5.3): theo slot, không `:` (BullMQ). */
export const sweepJobId = (def: OrgSweepDef, orgId: string, slot: number): string =>
  `${def.jobIdPrefix}-${orgId}-${slot}`;

/** Kích thước lô mỗi lượt (thunk đọc config): `size` trong `[1, DEFINER_LIMIT_MAX]`, `maxBatches` ≥ 1. */
export function checkedBatch(def: OrgSweepDef): OrgSweepBatch {
  const b = def.batch();
  if (!Number.isSafeInteger(b.size) || b.size < 1 || b.size > DEFINER_LIMIT_MAX)
    throw new OrgSweepDefinitionError(def.key, `batch size must be an integer in [1, ${DEFINER_LIMIT_MAX}], got ${b.size}`);
  if (!Number.isSafeInteger(b.maxBatches) || b.maxBatches < 1)
    throw new OrgSweepDefinitionError(def.key, `maxBatches must be a positive integer, got ${b.maxBatches}`);
  return b;
}

/** Tham số thêm đã kiểm (Review Focus 3): tên `p_…` khác `p_after`/`p_limit`; số là int4; chỉ number/boolean/string. */
export function checkedParams(def: OrgSweepDef): [string, OrgSweepParamValue][] {
  const entries = Object.entries(def.extraParams());
  for (const [name, value] of entries) {
    if (!PARAM_NAME.test(name) || RESERVED.has(name))
      throw new OrgSweepDefinitionError(def.key, `extra parameter name "${name}" must match ${PARAM_NAME} and not be p_after or p_limit`);
    const ok =
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= INT4_MIN && value <= INT4_MAX);
    if (!ok)
      throw new OrgSweepDefinitionError(def.key, `extra parameter ${name} must be a 32-bit integer, a boolean or a string, got ${String(value)}`);
  }
  return entries;
}

const castOf = (v: OrgSweepParamValue): string =>
  typeof v === 'number' ? 'integer' : typeof v === 'boolean' ? 'boolean' : 'text';

/**
 * Câu của runner: ký hiệu tham số theo tên của Postgres, ép kiểu tường minh theo kiểu JS (không dựa vào ép kiểu ngầm của
 * literal không kiểu). Tên hàm và tên tham số đã qua regex nên nối vào SQL an toàn; giá trị đi qua placeholder.
 */
export function sweepSql(def: OrgSweepDef, params: [string, OrgSweepParamValue][]): string {
  const extras = params.map(([name, value]) => `, ${name} => ?::${castOf(value)}`).join('');
  return `SELECT org_id::text AS org_id FROM public.${def.definerFunction}(p_after => ?::uuid, p_limit => ?::integer${extras})`;
}
```
`src/core/sweep/org-sweep.runner.ts`:
```ts
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { Db, UnitOfWork } from '../database/index.js';
import { METER } from '../observability/queue-metrics.js';
import { JobQueue } from '../queue/index.js';
import { minGapSec } from '../scheduler/schedule-validation.js';
import { PURGE_CURSOR_START } from './constants.js';
import {
  OrgSweepDefinitionError,
  checkedBatch,
  checkedParams,
  findOrgSweep,
  orgSweepRegistry,
  sweepJobId,
  sweepSql,
  type OrgSweepDef,
} from './org-sweep.js';

const Rows = z.array(z.object({ org_id: z.uuid() }));
const MS_PER_SECOND = 1000;

export type OrgSweepResult = { batches: number; enqueued: number; backlog: boolean; slot: number };

/**
 * Chạy một lượt quét (spec SP6 §5.3): tối đa `maxBatches` lô trên pool `app_user`, ngoài transaction và `OrgScope` (`app_user`
 * chỉ có `EXECUTE` trên hàm definer), con trỏ từ `PURGE_CURSOR_START`, dừng khi lô ngắn hơn `size`. Enqueue sau khi đọc, không
 * trong transaction (spec §3.2 luật 3). `jobId = <prefix>-<orgId>-<slot>`, `slot = floor(epochSec / minGapSec(cron, tz))`:
 * hai lượt cron hay một lần retry trong cùng slot không tạo job trùng; job theo org `failed` chỉ chặn org đó tới slot sau.
 */
@Injectable()
export class OrgSweepRunner implements OnModuleInit {
  private readonly logger = new Logger(OrgSweepRunner.name);
  private readonly slotSec = new Map<string, number>();
  private readonly meter = metrics.getMeter(METER);
  private readonly enqueuedTotal = this.meter.createCounter('org_sweep_orgs_enqueued_total', {
    description: 'Per-org jobs enqueued by org sweeps (duplicates in the same slot are ignored by BullMQ)',
  });
  private readonly backlogTotal = this.meter.createCounter('org_sweep_backlog_total', {
    description: 'Org sweep runs that stopped at maxBatches with a full last batch',
  });
  private readonly duration = this.meter.createHistogram('org_sweep_duration_seconds', {
    description: 'Duration of one org sweep run',
    unit: 's',
  });

  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly queue: JobQueue,
  ) {}

  /** Slot của mọi sweep đã đăng ký tính một lần lúc boot: cron không tính được → worker không khởi động. */
  onModuleInit(): void {
    for (const def of orgSweepRegistry()) this.slotSecOf(def);
  }

  async run(def: OrgSweepDef, at: Date = new Date()): Promise<OrgSweepResult> {
    if (findOrgSweep(def.key) !== def)
      throw new Error(`Org sweep "${def.key}" was not created by defineOrgSweep`);
    if (this.uow.inTransaction() || this.ctx.orgId() !== undefined)
      throw new Error(`Org sweep "${def.key}" must run outside any transaction and OrgScope`);
    const { size, maxBatches } = checkedBatch(def);
    const params = checkedParams(def);
    const sql = sweepSql(def, params);
    const values = params.map(([, v]) => v);
    const slot = Math.floor(at.getTime() / MS_PER_SECOND / this.slotSecOf(def));
    const attrs = { key: def.key };
    const started = performance.now();
    let after = PURGE_CURSOR_START;
    let batches = 0;
    let enqueued = 0;
    let full = false;
    try {
      while (batches < maxBatches) {
        const ids = this.orgIdsOf(def, await this.db.execute(sql, [after, size, ...values]), after, size);
        batches++;
        if (ids.length > 0) {
          await this.queue.enqueueMany(
            ids.map((orgId) => ({
              job: def.orgJob,
              payload: {},
              opts: { jobId: sweepJobId(def, orgId, slot), meta: { orgId } },
            })),
          );
          enqueued += ids.length;
          this.enqueuedTotal.add(ids.length, attrs);
          after = ids[ids.length - 1] ?? after;
        }
        full = ids.length === size;
        if (!full) break;
      }
    } finally {
      this.duration.record((performance.now() - started) / MS_PER_SECOND, attrs);
    }
    if (full) {
      this.backlogTotal.add(1, attrs);
      this.logger.warn(
        { event: 'org_sweep_backlog', key: def.key, batches, enqueued },
        'org sweep stopped at maxBatches with a full last batch; the rest waits for the next run',
      );
    }
    return { batches, enqueued, backlog: full, slot };
  }

  private slotSecOf(def: OrgSweepDef): number {
    let sec = this.slotSec.get(def.key);
    if (sec === undefined) {
      const { cron, tz } = def.schedule();
      sec = minGapSec(cron, tz);
      this.slotSec.set(def.key, sec);
    }
    return sec;
  }

  /** Review Focus 2: hàm quét sai `ORDER BY`/`DISTINCT`/`LIMIT` làm keyset bỏ sót hoặc lặp org — dừng to thay vì tiếp tục. */
  private orgIdsOf(def: OrgSweepDef, rows: object[], after: string, size: number): string[] {
    const ids = Rows.parse(rows).map((r) => r.org_id);
    if (ids.length > size)
      throw new OrgSweepDefinitionError(def.key, `${def.definerFunction} returned ${ids.length} rows for p_limit ${size}`);
    let prev = after;
    for (const id of ids) {
      if (id <= prev)
        throw new OrgSweepDefinitionError(
          def.key,
          `${def.definerFunction} must return org ids strictly ascending after p_after (got ${id} after ${prev})`,
        );
      prev = id;
    }
    return ids;
  }
}
```
`src/core/sweep/sweep.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { OrgSweepRunner } from './org-sweep.runner.js';

/** Chỉ worker: handler quét của module (khai trong `forWorker()`) inject `OrgSweepRunner`. */
@Global()
@Module({ providers: [OrgSweepRunner], exports: [OrgSweepRunner] })
export class SweepModule {}
```
`src/core/sweep/index.ts` (thay toàn bộ):
```ts
export { DEFINER_LIMIT_MAX, PURGE_CURSOR_START } from './constants.js';
export {
  OrgSweepDefinitionError,
  defineOrgSweep,
  findOrgSweep,
  orgSweepRegistry,
  sweepJobId,
  type OrgSweepBatch,
  type OrgSweepDef,
  type OrgSweepParamValue,
  type OrgSweepParams,
} from './org-sweep.js';
export { OrgSweepRunner, type OrgSweepResult } from './org-sweep.runner.js';
export { SweepModule } from './sweep.module.js';
```
`src/app-worker.module.ts`: import `SweepModule` từ `./core/sweep/index.js`, thêm `SweepModule,` vào `imports` sau `QueueModule.forRoot({ runWorkers: true })`.

- [ ] **Step 3: Chạy unit**

Run: `pnpm vitest run --project unit test/unit/core/sweep test/unit/architecture`
Expected: PASS (so khớp chuỗi SQL chính xác; mọi ca Review Focus 2, 3 ném trước SQL khi cần; `hardcode-scan` xanh).

- [ ] **Step 4: Integration qua `JobQueue` và worker thật trên hàm definer thật (C-8, C-8b)**

`test/integration/core/sweep/org-sweep.spec.ts`:
```ts
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseModule, Db } from '../../../../src/core/database/index.js';
import { BullmqJobQueue } from '../../../../src/core/queue/bullmq-job-queue.js';
import {
  JobHandler,
  JobQueue,
  QueueModule,
  defineJob,
  defineQueue,
  type JobContext,
} from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  DEFINER_LIMIT_MAX,
  OrgSweepDefinitionError,
  OrgSweepRunner,
  SweepModule,
  defineOrgSweep,
  sweepJobId,
  type OrgSweepBatch,
} from '../../../../src/core/sweep/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { inOrgTx, withAppClient } from '../../../support/tenancy-seed.js';

const SweepQueue = defineQueue('sweep-fixture', { kind: 'io' });
const FixtureSweepOrgJob = defineJob({ name: 'fixture.sweep-org', queue: SweepQueue, version: 1, schema: z.object({}) });
/** Tuổi tối thiểu của dòng đến hạn (C-8b: tham số thêm theo tên, kiểu integer). */
const MIN_AGE_SEC = 3600;
const DUE_AGE_SEC = 7200;
const FRESH_AGE_SEC = 600;
/** `*/5 * * * *` UTC → slot 300 s. */
const SLOT_MS = 300_000;
let tag = '';
let batch: OrgSweepBatch = { size: 2, maxBatches: 10 };
/** Khai báo theo thứ tự NGƯỢC với chữ ký hàm SQL (p_min_age_sec, p_tag): ký hiệu theo tên nên không quan trọng (C-8b). */
const FixtureSweep = defineOrgSweep({
  key: 'fixture.sweep-orgs',
  definerFunction: 'fixture_orgs_due',
  extraParams: () => ({ p_tag: tag, p_min_age_sec: MIN_AGE_SEC }),
  orgJob: FixtureSweepOrgJob,
  jobIdPrefix: 'fixture-sweep',
  schedule: () => ({ cron: '*/5 * * * *', tz: 'UTC' }),
  batch: () => batch,
});

const handled: { orgId: string | undefined; jobId: string }[] = [];
const failing = new Set<string>();
@Injectable()
@JobHandler(FixtureSweepOrgJob)
class OrgJobHandler {
  async handle(ctx: JobContext<unknown>) {
    handled.push({ orgId: ctx.meta.orgId, jobId: ctx.jobId });
    if (ctx.meta.orgId && failing.has(ctx.meta.orgId)) throw new Error('org job failed');
  }
}
@Module({ providers: [OrgJobHandler] })
class Handlers {}

const until = async (pred: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t = Date.now();
  while (!(await pred())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};
/** Seed dòng đến hạn cho từng org (app_user trong OrgScope của org đó), trả org theo thứ tự tăng dần. */
async function seed(count: number, ageSec: number): Promise<string[]> {
  const orgs = Array.from({ length: count }, () => v7()).sort();
  for (const org of orgs)
    await withAppClient((c) =>
      inOrgTx(c, org, () =>
        c.query(`INSERT INTO fixture_sweep_items (org_id, tag, due_at) VALUES ($1, $2, now() - make_interval(secs => $3))`, [
          org,
          tag,
          ageSec,
        ]),
      ),
    );
  return orgs;
}

describe('defineOrgSweep + OrgSweepRunner on the real definer, JobQueue and worker (spec SP6 §5.3, C-8, C-8b)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('WORKER_QUEUES', 'sweep-fixture');
    vi.stubEnv('QUEUE_DEFAULT_ATTEMPTS', '1');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      SweepModule,
      Handlers,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    batch = { size: 2, maxBatches: 10 };
    failing.clear();
    vi.restoreAllMocks();
  });
  const runner = () => app.get(OrgSweepRunner);
  const jobsOf = async (orgs: string[]) => {
    const all = await app.get(BullmqJobQueue).queue('sweep-fixture').getJobs(['completed', 'failed', 'waiting', 'active', 'delayed']);
    return all.filter((j) => orgs.some((o) => j.id?.includes(o))).map((j) => j.id ?? '').sort();
  };
  const handledFor = (orgs: string[]) => handled.filter((h) => h.orgId && orgs.includes(h.orgId));

  it('walks 3 × size + 1 orgs in four keyset batches and enqueues exactly one job per org', async () => {
    tag = `c8-${v7()}`;
    const orgs = await seed(3 * batch.size + 1, DUE_AGE_SEC);
    const at = new Date();
    const res = await runner().run(FixtureSweep, at);
    expect(res).toMatchObject({ batches: 4, enqueued: orgs.length, backlog: false });
    await until(() => handledFor(orgs).length === orgs.length);
    expect(handledFor(orgs).map((h) => h.jobId).sort()).toEqual(orgs.map((o) => sweepJobId(FixtureSweep, o, res.slot)).sort());
  });
  it('the same slot adds no job; the next slot adds one per org', async () => {
    tag = `c8-${v7()}`;
    const orgs = await seed(3, DUE_AGE_SEC);
    const at = new Date();
    await runner().run(FixtureSweep, at);
    await runner().run(FixtureSweep, at);
    expect(await jobsOf(orgs)).toHaveLength(orgs.length);
    await runner().run(FixtureSweep, new Date(at.getTime() + SLOT_MS));
    expect(await jobsOf(orgs)).toHaveLength(orgs.length * 2);
    await until(() => handledFor(orgs).length === orgs.length * 2);
  });
  it('a failed org job blocks that org only until the next slot', async () => {
    tag = `c8-${v7()}`;
    const [bad] = await seed(1, DUE_AGE_SEC);
    if (!bad) throw new Error('seed failed');
    failing.add(bad);
    const at = new Date();
    await runner().run(FixtureSweep, at);
    await until(() => handledFor([bad]).length === 1);
    await until(async () => (await app.get(BullmqJobQueue).queue('sweep-fixture').getJob(sweepJobId(FixtureSweep, bad, Math.floor(at.getTime() / SLOT_MS)))?.isFailed()) === true);
    await runner().run(FixtureSweep, at);
    expect(await jobsOf([bad])).toHaveLength(1);
    await runner().run(FixtureSweep, new Date(at.getTime() + SLOT_MS));
    await until(() => handledFor([bad]).length === 2);
  });
  it('a full last batch at maxBatches reports backlog', async () => {
    tag = `c8-${v7()}`;
    await seed(3 * batch.size + 1, DUE_AGE_SEC);
    batch = { size: 2, maxBatches: 2 };
    expect(await runner().run(FixtureSweep, new Date())).toMatchObject({ batches: 2, enqueued: 4, backlog: true });
  });
  it('Redis failing mid-run makes the sweep throw; the retry in the same slot creates no duplicate', async () => {
    tag = `c8-${v7()}`;
    const orgs = await seed(3 * batch.size + 1, DUE_AGE_SEC);
    const queue = app.get(JobQueue);
    const real = queue.enqueueMany.bind(queue);
    let calls = 0;
    const spy = vi.spyOn(queue, 'enqueueMany').mockImplementation(async (items) => {
      calls++;
      if (calls === 2) throw new Error('redis down');
      return real(items);
    });
    const at = new Date();
    await expect(runner().run(FixtureSweep, at)).rejects.toThrow('redis down');
    spy.mockRestore();
    await runner().run(FixtureSweep, at);
    expect(await jobsOf(orgs)).toHaveLength(orgs.length);
    await until(() => handledFor(orgs).length === orgs.length);
    expect(new Set(handledFor(orgs).map((h) => h.orgId)).size).toBe(orgs.length);
  });
  it('named extra parameters reach the real definer: rows younger than p_min_age_sec are not due (C-8b)', async () => {
    tag = `c8b-${v7()}`;
    const due = await seed(2, DUE_AGE_SEC);
    const fresh = await seed(2, FRESH_AGE_SEC);
    const res = await runner().run(FixtureSweep, new Date());
    expect(res.enqueued).toBe(due.length);
    expect(await jobsOf(fresh)).toEqual([]);
  });
  it('the SQL function refuses p_limit above DEFINER_LIMIT_MAX; the runner refuses it before calling', async () => {
    await expect(
      app.get(Db).execute(
        `SELECT org_id FROM public.fixture_orgs_due(p_after => ?::uuid, p_limit => ?::integer, p_min_age_sec => 0, p_tag => 'x')`,
        [v7(), DEFINER_LIMIT_MAX + 1],
      ),
    ).rejects.toThrow(/p_limit must be between 1 and 1000/);
    batch = { size: DEFINER_LIMIT_MAX + 1, maxBatches: 1 };
    await expect(runner().run(FixtureSweep, new Date())).rejects.toBeInstanceOf(OrgSweepDefinitionError);
  });
});
```
(Ca "failed" dùng `Math.floor(at.getTime() / SLOT_MS)` = đúng công thức slot với `slotSec = 300`. Job quét `fixture.sweep-orgs` nằm ở `maintenance`, không được consume ở đây: runner được gọi trực tiếp — handler thật của module chỉ là một dòng gọi `run`; job theo org đi qua `JobQueue` và worker thật.)

`test/support/org-sweep-signatures.ts`:
```ts
import type pg from 'pg';
import type { OrgSweepDef } from '../../src/core/sweep/index.js';

const SQL_TYPE = (v: number | boolean | string) =>
  typeof v === 'number' ? 'integer' : typeof v === 'boolean' ? 'boolean' : 'text';

/**
 * Hợp đồng chữ ký của một sweep (R-X14, spec SP6 C-8b) đọc từ `pg_proc`: đúng MỘT overload trong `public`; `p_after uuid`,
 * `p_limit integer`; mỗi tên của `extraParams()` là một tham số với kiểu khớp kiểu JS; không tham số nào của hàm bị bỏ trống;
 * `RETURNS TABLE(org_id uuid)`; `SECURITY DEFINER` của `sweep_definer`, `EXECUTE` chỉ cho `app_user`.
 */
export async function sweepSignatureProblems(
  client: pg.Client,
  sweep: Pick<OrgSweepDef, 'definerFunction' | 'extraParams'>,
): Promise<string[]> {
  const fn = sweep.definerFunction;
  const { rows } = await client.query<{ args: string; result: string; owner: string; secdef: boolean; app: boolean; pub: boolean }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
            pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
            has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
            has_function_privilege('public', p.oid, 'EXECUTE') AS pub
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
    [fn],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) return [`${fn} has ${rows.length} overloads in public (exactly one is required)`];
  const params = new Map(
    row.args
      .split(', ')
      .filter(Boolean)
      .map((a) => {
        const i = a.indexOf(' ');
        return [a.slice(0, i), a.slice(i + 1)] as const;
      }),
  );
  const problems: string[] = [];
  if (params.get('p_after') !== 'uuid') problems.push(`${fn}: p_after must be uuid`);
  if (params.get('p_limit') !== 'integer') problems.push(`${fn}: p_limit must be integer`);
  const extra = sweep.extraParams();
  for (const [name, value] of Object.entries(extra)) {
    const actual = params.get(name);
    if (actual === undefined) problems.push(`${name} is not a parameter of ${fn}`);
    else if (actual !== SQL_TYPE(value)) problems.push(`${fn}: ${name} is ${actual} but the sweep passes ${SQL_TYPE(value)}`);
  }
  const passed = new Set(['p_after', 'p_limit', ...Object.keys(extra)]);
  for (const name of params.keys()) if (!passed.has(name)) problems.push(`${fn}: parameter ${name} is never passed by the sweep`);
  if (row.result !== 'TABLE(org_id uuid)') problems.push(`${fn} must return TABLE(org_id uuid), returns ${row.result}`);
  if (row.owner !== 'sweep_definer' || !row.secdef || !row.app || row.pub)
    problems.push(`${fn} must be SECURITY DEFINER owned by sweep_definer with EXECUTE for app_user only`);
  return problems;
}
```
`test/integration/core/sweep/org-sweep-signatures.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Nạp đủ module của app: mọi `defineOrgSweep` chạy lúc import (6A/6C/SP5/SP7 thêm sweep của mình ở đây).
import '../../../../src/app-api.module.js';
import '../../../../src/app-worker.module.js';
import { orgSweepRegistry } from '../../../../src/core/sweep/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';
import { sweepSignatureProblems } from '../../../support/org-sweep-signatures.js';

const FIXTURE = { definerFunction: 'fixture_orgs_due', extraParams: () => ({ p_tag: 't', p_min_age_sec: 1 }) };

describe('org sweep signatures in pg_proc (R-X14, spec SP6 C-8b)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => owner?.end());

  it('every sweep the app registers matches its SQL function', async () => {
    for (const def of orgSweepRegistry()) expect(await sweepSignatureProblems(owner, def), def.key).toEqual([]);
  });
  it('the fixture sweep matches, whatever the order of its extra parameters', async () => {
    expect(await sweepSignatureProblems(owner, FIXTURE)).toEqual([]);
    expect(
      await sweepSignatureProblems(owner, { ...FIXTURE, extraParams: () => ({ p_min_age_sec: 1, p_tag: 't' }) }),
    ).toEqual([]);
  });
  it('a renamed parameter, a wrong type or a missing parameter makes the check fail', async () => {
    expect(await sweepSignatureProblems(owner, { ...FIXTURE, extraParams: () => ({ p_tag: 't', p_min_age: 1 }) })).toEqual([
      'p_min_age is not a parameter of fixture_orgs_due',
      'fixture_orgs_due: parameter p_min_age_sec is never passed by the sweep',
    ]);
    expect(await sweepSignatureProblems(owner, { ...FIXTURE, extraParams: () => ({ p_tag: 5, p_min_age_sec: 1 }) })).toEqual([
      'fixture_orgs_due: p_tag is text but the sweep passes integer',
    ]);
  });
  it('a second overload makes the check fail (rolled back)', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE sweep_definer');
      await owner.query(
        `CREATE FUNCTION public.fixture_orgs_due(p_after uuid, p_limit integer) RETURNS TABLE (org_id uuid)
         LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS 'SELECT NULL::uuid WHERE false'`,
      );
      await owner.query('RESET ROLE');
      expect(await sweepSignatureProblems(owner, FIXTURE)).toEqual([
        'fixture_orgs_due has 2 overloads in public (exactly one is required)',
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
```
Run: `pnpm vitest run --project integration test/integration/core/sweep`
Expected: PASS (chạy trước Step 2 thì FAIL: `core/sweep` chưa có runner).

- [ ] **Step 5: Chạy rộng**

Run:
```bash
pnpm typecheck && pnpm arch
pnpm vitest run --project integration test/integration/core test/e2e/core
```
Expected: PASS; mọi test dựng `AppWorkerModule` khởi động với `SweepModule` (registry sweep của app rỗng ở 6.0).

- [ ] **Step 6: Commit**

```bash
git add src/core/sweep src/app-worker.module.ts test/unit/core/sweep test/integration/core/sweep test/support/org-sweep-signatures.ts
git commit -m "feat(sweep): defineOrgSweep and OrgSweepRunner with named SQL parameters and slot jobIds; pg_proc signature contract"
```

---

### Task 12: `core/partitions` — registry, cron `core.partitions.maintain`, handler, metric; C-5 trên fixture (R6-17); kiểm chứng prod-like #3

**Files:**
- Create: `src/core/partitions/partitioned-table.ts`, `src/core/partitions/partitions.config.ts`, `src/core/partitions/partitions.jobs.ts`, `src/core/partitions/maintain-partitions.handler.ts`, `src/core/partitions/partitions.metrics.ts`, `src/core/partitions/partitions.module.ts`, `src/core/partitions/index.ts`, `test/unit/core/partitions/partitioned-table.spec.ts`, `test/integration/core/partitions/partition-maintain.spec.ts`
- Modify: `src/core/config/all-configs.ts`, `src/app-worker.module.ts`, `.env.example` (sinh lại), `test/smoke/core-shared.smoke.spec.ts`

**Interfaces:**
- Consumes: `Db`, `UnitOfWork`, `defineJob`, `MaintenanceQueue`, `JobHandler`, `type JobContext` (`core/queue`), `defineCron` (`core/scheduler/cron-definition.ts`), `isValidCron`, `normalizeTimezone` (`core/scheduler/schedule-validation.ts`), `METER`; fixture `fixture_part_events` + `fixture_part_events_maintain` (Task 10).
- Produces (6B, 6C dùng đúng tên):
  - `definePartitionedTable({ tables, maintainFunction, lockKey: bigint, retentionMonths: () => number, premakeMonths: () => number }): PartitionedTableDef`, `partitionedTableRegistry()`, `tableOfPartition(def, partition)`, `monthsAhead(newest: string | null, now: Date): number` (`NO_PARTITIONS = -1`).
  - `partitionsConfig` (namespace `partitions`: `maintainCron` ← `PARTITIONS_MAINTAIN_CRON` = `30 0 * * *`, `maintainTz` ← `PARTITIONS_MAINTAIN_TZ` = `UTC`).
  - `MaintainPartitionsJob` (`core.partitions.maintain`, `maintenance`) + cron cùng key; `MaintainPartitionsHandler` (mỗi mục một `UnitOfWork`; một mục lỗi không chặn mục khác; ném ở cuối); span `core.partitions.maintain`; log INFO `partition_created`/`partition_dropped { table, partition }`, ERROR `partition_maintain_failed { fn }`.
  - `PartitionMetrics`: `db_partition_maintain_total{table, action}`, gauge `db_partition_months_ahead{table}` (worker).
  - `PartitionsModule` (worker) trong `AppWorkerModule`.

- [ ] **Step 1: Unit test registry và hàm thuần (fail)**

`test/unit/core/partitions/partitioned-table.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  NO_PARTITIONS,
  definePartitionedTable,
  monthsAhead,
  partitionedTableRegistry,
  tableOfPartition,
} from '../../../../src/core/partitions/index.js';

const one = () => 1;
describe('definePartitionedTable (spec SP6 §5.3 core/partitions)', () => {
  it('registers an entry that may maintain several tables with one function', () => {
    const def = definePartitionedTable({ tables: ['unit_a', 'unit_b'], maintainFunction: 'unit_ab_maintain', lockKey: 7001n, retentionMonths: one, premakeMonths: one });
    expect(partitionedTableRegistry()).toContain(def);
    expect(tableOfPartition(def, 'unit_b_p202609')).toBe('unit_b');
    expect(() => tableOfPartition(def, 'unit_c_p202609')).toThrow(/does not belong/);
    expect(() => tableOfPartition(def, 'unit_a_p2026')).toThrow(/does not belong/);
  });
  it.each([
    [{ tables: [], maintainFunction: 'x_maintain', lockKey: 7002n }, /at least one table/],
    [{ tables: ['Bad'], maintainFunction: 'x_maintain', lockKey: 7003n }, /table name/],
    [{ tables: ['x_t'], maintainFunction: 'public.x', lockKey: 7004n }, /maintainFunction/],
    [{ tables: ['unit_a'], maintainFunction: 'y_maintain', lockKey: 7005n }, /already maintained/],
    [{ tables: ['z_t'], maintainFunction: 'unit_ab_maintain', lockKey: 7006n }, /already registered/],
    [{ tables: ['w_t'], maintainFunction: 'w_maintain', lockKey: 7001n }, /lockKey 7001 is already used/],
  ] as const)('refuses %j', (partial, re) => {
    expect(() => definePartitionedTable({ ...partial, retentionMonths: one, premakeMonths: one })).toThrow(re);
  });
});
describe('monthsAhead (gauge db_partition_months_ahead)', () => {
  const now = new Date('2026-09-29T23:59:00Z');
  it.each([
    ['202609', 0],
    ['202612', 3],
    ['202701', 4],
    ['202608', -1],
  ] as const)('newest %s → %i months ahead of the UTC month', (newest, n) => {
    expect(monthsAhead(newest, now)).toBe(n);
  });
  it('no partition at all is NO_PARTITIONS', () => {
    expect(monthsAhead(null, now)).toBe(NO_PARTITIONS);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/core/partitions`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Cài `core/partitions`**

`src/core/partitions/partitioned-table.ts`:
```ts
export type PartitionedTableDef = {
  /** Bảng partitioned mà hàm bảo trì lo (một hàm có thể lo nhiều bảng, spec §6.7). */
  readonly tables: readonly string[];
  /** Hàm `public.<tên>(p_retention_months integer, p_premake_months integer) RETURNS TABLE (action text, partition_name text)`. */
  readonly maintainFunction: string;
  /** Khoá `pg_try_advisory_xact_lock` viết cứng trong hàm (R6-17); duy nhất trong registry. */
  readonly lockKey: bigint;
  readonly retentionMonths: () => number;
  readonly premakeMonths: () => number;
};

const NAME = /^[a-z][a-z0-9_]*$/;
const MONTH_SUFFIX = /^(\d{4})(\d{2})$/;
/** Gauge khi bảng chưa có partition nào: dưới mọi ngưỡng cảnh báo (`< 2`). */
export const NO_PARTITIONS = -1;
const defs: PartitionedTableDef[] = [];

/** Registry lúc import (spec SP6 §5.3): 6B khai `audit_logs` + `platform_audit_logs`, 6C khai hai bảng webhook. */
export function definePartitionedTable(def: PartitionedTableDef): PartitionedTableDef {
  if (def.tables.length === 0) throw new Error(`${def.maintainFunction}: at least one table is required`);
  for (const t of def.tables) if (!NAME.test(t)) throw new Error(`Partitioned table name "${t}" must match ${NAME}`);
  if (!NAME.test(def.maintainFunction))
    throw new Error(`maintainFunction "${def.maintainFunction}" must match ${NAME} (a function of schema public)`);
  for (const d of defs) {
    if (d.maintainFunction === def.maintainFunction)
      throw new Error(`maintainFunction "${def.maintainFunction}" is already registered`);
    if (d.lockKey === def.lockKey)
      throw new Error(`lockKey ${def.lockKey} is already used by ${d.maintainFunction}`);
    const shared = d.tables.find((t) => def.tables.includes(t));
    if (shared) throw new Error(`Table "${shared}" is already maintained by ${d.maintainFunction}`);
  }
  defs.push(def);
  return def;
}

export const partitionedTableRegistry = (): PartitionedTableDef[] => [...defs];

/** Bảng của partition `<bảng>_pYYYYMM` trong mục `def`; tên lạ → ném (hàm SQL đã `RAISE` với tên lạ, đây là lớp thứ hai). */
export function tableOfPartition(def: PartitionedTableDef, partition: string): string {
  const table = def.tables.find((t) => partition.startsWith(`${t}_p`) && MONTH_SUFFIX.test(partition.slice(t.length + 2)));
  if (!table) throw new Error(`Partition "${partition}" does not belong to ${def.tables.join(', ')}`);
  return table;
}

/** Số tháng partition mới nhất (`YYYYMM`) đi trước tháng UTC hiện tại. */
export function monthsAhead(newest: string | null, now: Date): number {
  if (newest === null) return NO_PARTITIONS;
  const m = MONTH_SUFFIX.exec(newest);
  if (!m?.[1] || !m[2]) throw new Error(`Partition suffix "${newest}" is not YYYYMM`);
  return Number(m[1]) * 12 + (Number(m[2]) - 1) - (now.getUTCFullYear() * 12 + now.getUTCMonth());
}
```
`src/core/partitions/partitions.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';
import { isValidCron, normalizeTimezone } from '../scheduler/schedule-validation.js';

export const partitionsConfig = defineConfig(
  'partitions',
  { maintainCron: 'PARTITIONS_MAINTAIN_CRON', maintainTz: 'PARTITIONS_MAINTAIN_TZ' },
  z.object({
    maintainCron: z
      .string()
      .min(1)
      .refine(isValidCron, 'must be a valid cron expression')
      .default('30 0 * * *')
      .describe('Cron of core.partitions.maintain: premake next months and drop expired monthly partitions'),
    maintainTz: z
      .string()
      .min(1)
      .refine((tz) => normalizeTimezone(tz) !== undefined, 'must be an IANA timezone name')
      .default('UTC')
      .describe('Timezone for the partition maintenance cron (partition bounds are always UTC months)'),
  }),
);
```
`src/core/partitions/partitions.jobs.ts`:
```ts
import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../queue/index.js';
import { defineCron } from '../scheduler/cron-definition.js';
import { partitionsConfig } from './partitions.config.js';

/** Một cron chung cho mọi bảng partitioned (spec SP6 §5.3, §10). */
export const MaintainPartitionsJob = defineJob({
  name: 'core.partitions.maintain',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
defineCron({
  key: 'core.partitions.maintain',
  job: MaintainPartitionsJob,
  payload: {},
  schedule: () => {
    const c = partitionsConfig();
    return { cron: c.maintainCron, tz: c.maintainTz };
  },
});
```
`src/core/partitions/partitions.metrics.ts`:
```ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { z } from 'zod';
import { Db } from '../database/index.js';
import { METER } from '../observability/queue-metrics.js';
import { monthsAhead, partitionedTableRegistry } from './partitioned-table.js';

const Newest = z.array(z.object({ newest: z.string().nullable() }));

/** Worker: đếm tạo/drop và gauge "partition đi trước bao nhiêu tháng" (cảnh báo `< 2`, spec §15). */
@Injectable()
export class PartitionMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PartitionMetrics.name);
  private readonly meter = metrics.getMeter(METER);
  private readonly maintainedTotal = this.meter.createCounter('db_partition_maintain_total', {
    description: 'Monthly partitions created or dropped by core.partitions.maintain',
  });
  private readonly ahead = this.meter.createObservableGauge('db_partition_months_ahead', {
    description: 'Months between the current UTC month and the newest partition of the table',
  });

  constructor(private readonly db: Db) {}

  maintained(table: string, action: 'created' | 'dropped'): void {
    this.maintainedTotal.add(1, { table, action });
  }

  private readonly observe = async (result: ObservableResult): Promise<void> => {
    try {
      for (const def of partitionedTableRegistry())
        for (const table of def.tables) {
          const [row] = Newest.parse(
            await this.db.execute(
              `SELECT max(substring(c.relname FROM '_p([0-9]{6})$')) AS newest
               FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
               WHERE i.inhparent = to_regclass(?)`,
              [`public.${table}`],
            ),
          );
          result.observe(monthsAhead(row?.newest ?? null, new Date()), { table });
        }
    } catch (err) {
      this.logger.warn({ err }, 'partition metrics skipped');
    }
  };

  onModuleInit(): void {
    this.ahead.addCallback(this.observe);
  }

  /** Gỡ trước khi pool DB đóng: lần export cuối lúc tắt không chạm connection đã đóng. */
  onModuleDestroy(): void {
    this.ahead.removeCallback(this.observe);
  }
}
```
`src/core/partitions/maintain-partitions.handler.ts`:
```ts
import { Injectable, type Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';
import { Db, UnitOfWork } from '../database/index.js';
import { JobHandler, type JobContext } from '../queue/index.js';
import { partitionedTableRegistry, tableOfPartition, type PartitionedTableDef } from './partitioned-table.js';
import { MaintainPartitionsJob } from './partitions.jobs.js';
import { PartitionMetrics } from './partitions.metrics.js';

const Result = z.array(z.object({ action: z.enum(['created', 'dropped']), partition_name: z.string() }));
const TRACER = 'core';

/**
 * Cron `core.partitions.maintain` (spec SP6 §5.3): gọi hàm bảo trì của từng mục trong registry qua `EXECUTE` của `app_user`,
 * mỗi mục trong một `UnitOfWork` riêng. Một mục lỗi không chặn mục khác: log ERROR, ném ở cuối để BullMQ retry (hàm bảo trì
 * idempotent; lượt đồng thời là no-op nhờ `pg_try_advisory_xact_lock`, R6-17).
 */
@Injectable()
@JobHandler(MaintainPartitionsJob)
export class MaintainPartitionsHandler {
  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly metrics: PartitionMetrics,
  ) {}

  handle(ctx: JobContext<unknown>): Promise<void> {
    return trace.getTracer(TRACER).startActiveSpan('core.partitions.maintain', async (span) => {
      try {
        const failed: string[] = [];
        for (const def of partitionedTableRegistry()) {
          ctx.signal.throwIfAborted();
          try {
            await this.maintain(def, ctx.log);
          } catch (err) {
            failed.push(def.maintainFunction);
            ctx.log.error({ event: 'partition_maintain_failed', fn: def.maintainFunction, err }, 'partition maintenance failed');
          }
        }
        if (failed.length > 0)
          throw new Error(`Partition maintenance failed for ${failed.join(', ')}; the other entries ran`);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async maintain(def: PartitionedTableDef, log: Logger): Promise<void> {
    const retention = def.retentionMonths();
    const premake = def.premakeMonths();
    for (const [name, v] of [
      ['retentionMonths', retention],
      ['premakeMonths', premake],
    ] as const)
      if (!Number.isSafeInteger(v) || v < 1)
        throw new Error(`${def.maintainFunction}: ${name} must be a positive integer, got ${v}`);
    const rows = Result.parse(
      await this.uow.run(() =>
        this.db.execute(`SELECT action, partition_name FROM public.${def.maintainFunction}(?::integer, ?::integer)`, [
          retention,
          premake,
        ]),
      ),
    );
    for (const r of rows) {
      const table = tableOfPartition(def, r.partition_name);
      log.log(
        { event: r.action === 'created' ? 'partition_created' : 'partition_dropped', table, partition: r.partition_name },
        `partition ${r.action}`,
      );
      this.metrics.maintained(table, r.action);
    }
  }
}
```
`src/core/partitions/partitions.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { MaintainPartitionsHandler } from './maintain-partitions.handler.js';
import './partitions.config.js';
import { PartitionMetrics } from './partitions.metrics.js';

/** Chỉ worker: handler của cron `core.partitions.maintain` (queue `maintenance`) và metric partition. */
@Module({ providers: [PartitionMetrics, MaintainPartitionsHandler] })
export class PartitionsModule {}
```
`src/core/partitions/index.ts`:
```ts
export { PartitionsModule } from './partitions.module.js';
export { partitionsConfig } from './partitions.config.js';
export { MaintainPartitionsJob } from './partitions.jobs.js';
export { MaintainPartitionsHandler } from './maintain-partitions.handler.js';
export { PartitionMetrics } from './partitions.metrics.js';
export {
  NO_PARTITIONS,
  definePartitionedTable,
  monthsAhead,
  partitionedTableRegistry,
  tableOfPartition,
  type PartitionedTableDef,
} from './partitioned-table.js';
```
`src/core/config/all-configs.ts` thêm: `import '../partitions/partitions.config.js';`
`src/app-worker.module.ts`: import `PartitionsModule` từ `./core/partitions/index.js`, thêm `PartitionsModule,` vào `imports` sau `SweepModule`.
Run: `pnpm env:example` — `.env.example` có thêm `PARTITIONS_MAINTAIN_CRON=30 0 * * *`, `PARTITIONS_MAINTAIN_TZ=UTC`.

- [ ] **Step 3: Chạy unit**

Run: `pnpm vitest run --project unit test/unit/core/partitions test/unit/architecture test/unit/core/config`
Expected: PASS.

- [ ] **Step 4: C-5 trên fixture thật + handler (fail trước Step 2 ở phần handler)**

`test/integration/core/partitions/partition-maintain.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import {
  MaintainPartitionsHandler,
  PartitionsModule,
  definePartitionedTable,
} from '../../../../src/core/partitions/index.js';
import type { JobContext } from '../../../../src/core/queue/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';
import { installOtelCapture } from '../../../support/otel-capture.js';
import { inOrgTx, withAppClient } from '../../../support/tenancy-seed.js';

const otel = installOtelCapture();
const TABLE = 'fixture_part_events';
/** Như fixture migration: sàn retention 1, premake 3 (tháng hiện tại + 3). */
const PREMAKE = 3;
/** Retention dùng ở ca drop: tháng −3 hết hạn, tháng −2 (biên) và −1 ở lại. */
const RETENTION = 2;
const PROBE_LOCK_TIMEOUT = '1s';
definePartitionedTable({ tables: [TABLE], maintainFunction: 'fixture_part_events_maintain', lockKey: 6900n, retentionMonths: () => RETENTION, premakeMonths: () => PREMAKE });
/** Mục hỏng: hàm không tồn tại (42883) — handler phải chạy tiếp mục khác rồi mới ném. */
definePartitionedTable({ tables: ['fixture_missing'], maintainFunction: 'fixture_missing_maintain', lockKey: 6901n, retentionMonths: () => 1, premakeMonths: () => 1 });

/** Tháng UTC lệch `offset`: tên partition, cận dưới và cận trên ISO. */
const month = (offset: number) => {
  const now = new Date();
  const lo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const hi = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  const name = `${TABLE}_p${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`;
  return { name, lo: lo.toISOString(), hi: hi.toISOString() };
};

describe('partition maintenance on the fixture table (spec SP6 §6.7, C-5, R6-17)', () => {
  let owner: pg.Client;
  let app: INestApplication;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), PartitionsModule]);
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
  });
  const asPartitionOwner = async (statements: string[]) => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE partition_owner');
      for (const s of statements) await owner.query(s);
      await owner.query('RESET ROLE');
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK');
      throw err;
    }
  };
  const detach = async (name: string) => {
    const { rows } = await owner.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${name}`]);
    if (rows[0]?.present) await asPartitionOwner([`ALTER TABLE public.${TABLE} DETACH PARTITION public.${name}`, `DROP TABLE public.${name}`]);
  };
  /** Gắn tháng `offset` (gỡ bản còn sót của lần chạy trước để test lặp lại được). */
  const attach = async (offset: number) => {
    const m = month(offset);
    await detach(m.name);
    await asPartitionOwner([
      `CREATE TABLE public.${m.name} (LIKE public.${TABLE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      `ALTER TABLE public.${TABLE} ATTACH PARTITION public.${m.name} FOR VALUES FROM ('${m.lo}') TO ('${m.hi}')`,
    ]);
  };
  const partitions = async () =>
    (
      await owner.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'public.${TABLE}'::regclass ORDER BY 1`,
      )
    ).rows.map((r) => r.name);
  const maintain = (c: pg.Client, retention: number | null, premake: number | null) =>
    c.query<{ action: string; partition_name: string }>(`SELECT action, partition_name FROM fixture_part_events_maintain($1, $2)`, [
      retention,
      premake,
    ]);
  const expectedNow = () => [0, 1, 2, 3].map((i) => month(i).name);

  it('creates the current month and premake months ahead, idempotently', async () => {
    await detach(month(PREMAKE).name);
    const first = await withAppClient((c) => maintain(c, RETENTION, PREMAKE));
    expect(first.rows).toEqual([{ action: 'created', partition_name: month(PREMAKE).name }]);
    expect((await withAppClient((c) => maintain(c, RETENTION, PREMAKE))).rows).toEqual([]);
    expect(await partitions()).toEqual(expectedNow());
  });
  it('drops only partitions whose whole month is older than the retention; the boundary month stays', async () => {
    for (const i of [-3, -2, -1]) await attach(i);
    const res = await withAppClient((c) => maintain(c, RETENTION, PREMAKE));
    expect(res.rows).toEqual([{ action: 'dropped', partition_name: month(-3).name }]);
    expect(await partitions()).toEqual([month(-2).name, month(-1).name, ...expectedNow()].sort());
    for (const i of [-2, -1]) await detach(month(i).name);
  });
  it.each([
    [0, PREMAKE, /p_retention_months must be between 1 and 120/],
    [121, PREMAKE, /p_retention_months must be between 1 and 120/],
    [RETENTION, 0, /p_premake_months must be between 1 and 12/],
    [RETENTION, 13, /p_premake_months must be between 1 and 12/],
    [null, PREMAKE, /must not be NULL/],
  ] as const)('refuses retention %s, premake %s (floor enforced inside the function)', async (r, p, re) => {
    await withAppClient(async (c) => {
      await expect(maintain(c, r, p)).rejects.toThrow(re);
    });
  });
  it('two concurrent runs: the second is a no-op while the first holds the advisory lock (R6-17)', async () => {
    await attach(-3);
    const a = await withAppClient(async (first) => {
      await first.query('BEGIN');
      try {
        expect((await maintain(first, RETENTION, PREMAKE)).rows).toEqual([{ action: 'dropped', partition_name: month(-3).name }]);
        const second = await withAppClient((c) => maintain(c, RETENTION, PREMAKE));
        return second.rows;
      } finally {
        await first.query('ROLLBACK');
      }
    });
    expect(a).toEqual([]);
    expect(await partitions()).toContain(month(-3).name);
    expect((await withAppClient((c) => maintain(c, RETENTION, PREMAKE))).rows).toEqual([
      { action: 'dropped', partition_name: month(-3).name },
    ]);
  });
  it('a partition is closed to app_user; the append-only trigger of the parent fires on the partition', async () => {
    const org = v7();
    await withAppClient((c) => inOrgTx(c, org, () => c.query(`INSERT INTO ${TABLE} (org_id, body) VALUES ($1, 'x')`, [org])));
    await withAppClient(async (c) => {
      await expect(c.query(`SELECT * FROM ${month(0).name}`)).rejects.toMatchObject({ code: '42501' });
    });
    await expect(asPartitionOwner([`UPDATE public.${month(0).name} SET body = 'y' WHERE org_id = '${org}'`])).rejects.toMatchObject({
      code: '42501',
      message: 'fixture_part_events is append-only',
    });
  });
  it('an unexpected partition name makes the function RAISE', async () => {
    await asPartitionOwner([
      `CREATE TABLE public.${TABLE}_odd (LIKE public.${TABLE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      `ALTER TABLE public.${TABLE} ATTACH PARTITION public.${TABLE}_odd FOR VALUES FROM ('2099-01-01T00:00:00Z') TO ('2099-02-01T00:00:00Z')`,
    ]);
    try {
      await withAppClient(async (c) => {
        await expect(maintain(c, RETENTION, PREMAKE)).rejects.toThrow(/unexpected partition fixture_part_events_odd/);
      });
    } finally {
      await detach(`${TABLE}_odd`);
    }
  });
  it('ATTACH keeps the parent at SHARE UPDATE EXCLUSIVE: an INSERT runs while maintenance is open (lock level of spike P1)', async () => {
    await detach(month(PREMAKE).name);
    await withAppClient(async (a) => {
      await a.query('BEGIN');
      try {
        const pid = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        expect((await maintain(a, RETENTION, PREMAKE)).rows).toEqual([{ action: 'created', partition_name: month(PREMAKE).name }]);
        const { rows } = await owner.query<{ mode: string }>(
          `SELECT l.mode FROM pg_locks l WHERE l.pid = $1 AND l.relation = 'public.${TABLE}'::regclass`,
          [pid],
        );
        expect(rows.map((r) => r.mode)).toContain('ShareUpdateExclusiveLock');
        expect(rows.map((r) => r.mode)).not.toContain('AccessExclusiveLock');
        const org = v7();
        await withAppClient((b) =>
          inOrgTx(b, org, async () => {
            await b.query(`SET LOCAL lock_timeout = '${PROBE_LOCK_TIMEOUT}'`);
            await b.query(`INSERT INTO ${TABLE} (org_id) VALUES ($1)`, [org]);
          }),
        );
        await a.query('COMMIT');
      } catch (err) {
        await a.query('ROLLBACK');
        throw err;
      }
    });
  });
  it('partition bounds are UTC month bounds whatever the session TimeZone (Review Focus 4)', async () => {
    await detach(month(PREMAKE).name);
    await withAppClient(async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
      await maintain(c, RETENTION, PREMAKE);
      await c.query('COMMIT');
    });
    await owner.query(`SET TimeZone = 'UTC'`);
    const { rows } = await owner.query<{ bound: string }>(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c WHERE c.relname = $1`,
      [month(PREMAKE).name],
    );
    const iso = (s: string) => s.replace('T', ' ').replace('.000Z', '+00');
    expect(rows[0]?.bound).toBe(`FOR VALUES FROM ('${iso(month(PREMAKE).lo)}') TO ('${iso(month(PREMAKE).hi)}')`);
  });
  it('the cron handler maintains every entry in its own transaction; a failing entry does not stop the others; logs, counter and gauge', async () => {
    await detach(month(PREMAKE).name);
    const log = new Logger('partition-maintain-test');
    const info = vi.spyOn(log, 'log');
    const ctx: JobContext<unknown> = { payload: {}, meta: {}, jobId: 'test', attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log };
    await expect(app.get(MaintainPartitionsHandler).handle(ctx)).rejects.toThrow(/fixture_missing_maintain; the other entries ran/);
    expect(await partitions()).toContain(month(PREMAKE).name);
    expect(info).toHaveBeenCalledWith({ event: 'partition_created', table: TABLE, partition: month(PREMAKE).name }, 'partition created');
    expect(await otel.metric('db_partition_maintain_total', { table: TABLE, action: 'created' })).toBeGreaterThanOrEqual(1);
    expect(await otel.metric('db_partition_months_ahead', { table: TABLE })).toBe(PREMAKE);
    expect(otel.spanNames()).toContain('core.partitions.maintain');
  });
});
```
(`month(i).lo` ISO có dạng `2026-12-01T00:00:00.000Z`; hàm `iso` đổi sang dạng Postgres in ra với `TimeZone = 'UTC'`: `2026-12-01 00:00:00+00`. Test ghi dòng append-only vào `fixture_part_events` của DB test dùng chung — không xoá được, không ảnh hưởng test khác vì chỉ file này và chaos Task 13 đọc bảng đó.)
Run: `pnpm vitest run --project integration test/integration/core/partitions`
Expected: PASS (chạy trước Step 2 thì FAIL: `core/partitions` chưa có). Ca nào đỏ ở mức khoá → so với kết quả spike P1 đã ghi ADR; lệch thì dừng, ghi lại và báo (không nới test).

- [ ] **Step 5: Smoke — cron bảo trì được đồng bộ trên worker production**

`test/smoke/core-shared.smoke.spec.ts`: thêm ca (trước ca log sạch):
```ts
  it('the worker synced the core.partitions.maintain cron and boots with the sweep and partition modules', () => {
    expect(logsSince(startedAt)).toContain('static-core.partitions.maintain');
    expect(workerHealth()).toBe('healthy');
  });
```
và import thêm `workerHealth` từ `./smoke-support.js`.

- [ ] **Step 6: Toàn bộ và kiểm chứng prod-like #3**

Run:
```bash
pnpm typecheck && pnpm arch && pnpm test
pnpm test:int
pnpm test:smoke
```
Expected: unit/integration PASS (mọi test dựng `AppWorkerModule` có handler cho job `core.partitions.maintain` của queue `maintenance`); smoke: image production thật, worker log `static crons synced` có `static-core.partitions.maintain`, worker healthy với `SweepModule` + `PartitionsModule`, mọi file smoke PASS, log JSON không `error`, teardown sạch.

- [ ] **Step 7: Commit**

```bash
git add src/core/partitions src/core/config/all-configs.ts src/app-worker.module.ts .env.example test/unit/core/partitions test/integration/core/partitions test/smoke/core-shared.smoke.spec.ts
git commit -m "feat(partitions): definePartitionedTable registry and the core.partitions.maintain cron with per-entry transactions, metrics and span"
```

---

## Phần E — Chaos, prod-like, tài liệu, bàn giao

### Task 13: Chaos C-30 — DB mất khi làm mới kill switch; bảo trì partition dưới tải chèn

**Files:**
- Create: `test/chaos/core-shared-outages.spec.ts`

**Interfaces:**
- Consumes: `FlagsModule`, `KillSwitches`, `defineKillSwitch` (Task 9), `databaseConfig` (SP1), `startTcpProxy` (`test/support/tcp-proxy.ts`), `installOtelCapture`, fixture `fixture_part_events` + `fixture_part_events_maintain` (Task 10), `withAppClient`, `inOrgTx`.
- Produces: bằng chứng tiêu chí 11 phần "DB lỗi → giữ snapshot cuối (fail-static)" trên mạng mất gói thật; bằng chứng R6-17/R60-7 dưới tải (không deadlock, ghi không lỗi, mỗi lượt bảo trì < `lock_timeout`).

- [ ] **Step 1: Viết chaos (fail nếu provider treo theo DB hoặc bảo trì chặn ghi)**

`test/chaos/core-shared-outages.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ConfigOf } from '../../src/core/config/index.js';
import { DatabaseModule, databaseConfig } from '../../src/core/database/index.js';
import { FlagsModule, KillSwitches, defineKillSwitch } from '../../src/core/flags/index.js';
import { createTestApp } from '../support/app-factory.js';
import { getInfra } from '../support/infra.js';
import { installOtelCapture } from '../support/otel-capture.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { inOrgTx, withAppClient } from '../support/tenancy-seed.js';

const otel = installOtelCapture();
const SWITCH = defineKillSwitch({ key: 'fixture.chaos_switch', description: 'chaos probe' });
const INTERVAL_MS = 1000;
/** isKilled đọc snapshot trong bộ nhớ: phải trả lời gần như tức thì kể cả khi DB treo. */
const READ_BOUND_MS = 100;
/** Hàm bảo trì đặt `lock_timeout` 5 s (spec §6.7): mỗi lượt dưới tải phải xong dưới mốc này. */
const LOCK_TIMEOUT_MS = 5000;
const WRITERS = 4;
const MAINTAIN_ROUNDS = 5;
const TABLE = 'fixture_part_events';
const month = (offset: number) => {
  const now = new Date();
  const lo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const hi = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return { name: `${TABLE}_p${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`, lo: lo.toISOString(), hi: hi.toISOString() };
};

describe('kill switch refresh while the DB is blackholed (spec SP6 criterion 11, C-30)', () => {
  let app: INestApplication;
  let proxy: TcpProxy;
  let owner: pg.Client;
  let queryTimeoutMs = 0;
  const crashes: unknown[] = [];
  const onCrash = (err: unknown) => crashes.push(err);
  const setRow = (killed: boolean) =>
    owner.query(
      `INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES ($1, $2, $3, 'chaos')
       ON CONFLICT (key) DO UPDATE SET killed = EXCLUDED.killed, reason = EXCLUDED.reason, version = kill_switches.version + 1, updated_at = now()`,
      [SWITCH.key, killed, killed ? 'chaos' : null],
    );
  beforeAll(async () => {
    process.on('unhandledRejection', onCrash);
    process.on('uncaughtException', onCrash);
    const infra = getInfra();
    owner = new pg.Client({ host: infra.pg.host, port: infra.pg.port, database: infra.pg.database, ...infra.pg.owner });
    await owner.connect();
    await setRow(true);
    proxy = await startTcpProxy(infra.pgbouncer.host, infra.pgbouncer.port);
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_PORT', String(proxy.port));
    vi.stubEnv('FLAGS_REFRESH_INTERVAL_MS', String(INTERVAL_MS));
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), FlagsModule]);
    queryTimeoutMs = app.get<ConfigOf<typeof databaseConfig>>(databaseConfig.KEY).queryTimeoutMs;
  });
  afterAll(async () => {
    await proxy?.close();
    await app?.close();
    await owner?.query('DELETE FROM kill_switches WHERE key = $1', [SWITCH.key]);
    await owner?.end();
    vi.unstubAllEnvs();
    process.off('unhandledRejection', onCrash);
    process.off('uncaughtException', onCrash);
  });

  it('keeps answering from the last snapshot, counts failed refreshes, and picks up the new value once the DB is back', async () => {
    const switches = app.get(KillSwitches);
    expect(await switches.isKilled(SWITCH.key)).toBe(true);
    const before = (await otel.metric('flags_refresh_failures_total')) ?? 0;
    proxy.state.blackhole = true;
    await vi.waitFor(async () => expect(await otel.metric('flags_refresh_failures_total')).toBeGreaterThan(before), {
      timeout: queryTimeoutMs * 2 + INTERVAL_MS * 2,
      interval: 100,
    });
    const t = performance.now();
    expect(await switches.isKilled(SWITCH.key)).toBe(true);
    expect(performance.now() - t).toBeLessThan(READ_BOUND_MS);
    await setRow(false);
    proxy.state.blackhole = false;
    proxy.sever();
    await vi.waitFor(async () => expect(await switches.isKilled(SWITCH.key)).toBe(false), {
      timeout: queryTimeoutMs + INTERVAL_MS * 3,
      interval: 100,
    });
    expect(crashes).toEqual([]);
  });
});

describe('partition maintenance under concurrent inserts (C-30, R6-17, R60-7)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => owner?.end());
  const asPartitionOwner = async (statements: string[]) => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE partition_owner');
      for (const s of statements) await owner.query(s);
      await owner.query('RESET ROLE');
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK');
      throw err;
    }
  };

  it('each round attaches and drops months without deadlock, under lock_timeout, while every insert succeeds', async () => {
    let stop = false;
    let inserted = 0;
    const errors: unknown[] = [];
    const writers = Array.from({ length: WRITERS }, () =>
      withAppClient(async (c) => {
        const org = v7();
        while (!stop) {
          try {
            await inOrgTx(c, org, () => c.query(`INSERT INTO ${TABLE} (org_id, body) VALUES ($1, 'load')`, [org]));
            inserted++;
          } catch (err) {
            errors.push(err);
          }
        }
      }),
    );
    const rounds: number[] = [];
    try {
      for (let i = 0; i < MAINTAIN_ROUNDS; i++) {
        const old = month(-3);
        const ahead = month(3);
        await asPartitionOwner([
          `CREATE TABLE public.${old.name} (LIKE public.${TABLE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
          `ALTER TABLE public.${TABLE} ATTACH PARTITION public.${old.name} FOR VALUES FROM ('${old.lo}') TO ('${old.hi}')`,
          `ALTER TABLE public.${TABLE} DETACH PARTITION public.${ahead.name}`,
          `DROP TABLE public.${ahead.name}`,
        ]);
        const t = performance.now();
        const { rows } = await withAppClient((c) => c.query('SELECT action, partition_name FROM fixture_part_events_maintain(1, 3)'));
        rounds.push(performance.now() - t);
        expect(rows).toEqual(
          expect.arrayContaining([
            { action: 'created', partition_name: ahead.name },
            { action: 'dropped', partition_name: old.name },
          ]),
        );
      }
    } finally {
      stop = true;
      await Promise.all(writers);
    }
    console.log(JSON.stringify({ chaos: 'partition-maintain-under-load', rounds, inserted }));
    expect(errors).toEqual([]);
    expect(inserted).toBeGreaterThan(0);
    for (const ms of rounds) expect(ms).toBeLessThan(LOCK_TIMEOUT_MS);
  });
});
```
(Với `retention = 1`, tháng −2 cũng hết hạn: nếu còn sót từ lần chạy trước, lượt đầu drop nó thêm — `arrayContaining` cho phép dòng thừa đó.)

- [ ] **Step 2: Chạy**

Run: `pnpm test:chaos`
Expected: PASS toàn bộ (file mới và file chaos SP1/SP2/3A). Ca flags: có ít nhất một lượt làm mới lỗi, `isKilled` vẫn `true` dưới 100 ms trong lúc DB treo, rồi thành `false` sau khi mạng lành; không unhandled rejection. Ca partition: in `rounds` (ms mỗi lượt) và số INSERT; không lỗi ghi, không `40P01`. Số đo `rounds` chép vào mô tả PR (Task 16).

- [ ] **Step 3: Commit**

```bash
git add test/chaos/core-shared-outages.spec.ts
git commit -m "test(chaos): kill switches stay fail-static on a blackholed DB; partition maintenance under concurrent inserts"
```

---

### Task 14: Prod-like cuối của 6.0; đo image, ghi ADR 0013

**Files:**
- Modify: `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: mọi task 1–13; image `nestjs-saas-boilerplate:nsb-smoke` do `pnpm test:smoke` để lại.
- Produces: dòng "SP6 (6.0)" trong ADR 0013 (chưa nén, nén, chênh so với SP3, phần `@openfeature/*`).

- [ ] **Step 1: Smoke đầy đủ**

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer), migrate mọi migration tới `…_kill_switches` từ `dist`; mọi file smoke PASS (`core`, `auth-email`, `dashboard`, `tenancy`, `core-shared`); log api/worker là JSON, không `error`; `/health/ready` 200; teardown `down -v` sạch. Image `nestjs-saas-boilerplate:nsb-smoke` còn lại để đo.

- [ ] **Step 2: Đo image đúng cách ADR 0013 đang dùng**

Run (Git Bash; cùng máy Docker Desktop/WSL2/amd64 với các số trước):
```bash
IMG=nestjs-saas-boilerplate:nsb-smoke
docker history --format '{{.Size}}' "$IMG" | node -e "
  const units = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 };
  let total = 0;
  for (const line of require('fs').readFileSync(0, 'utf8').trim().split('\n')) {
    const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(line.trim());
    if (m) total += Number(m[1]) * units[m[2]];
  }
  console.log('uncompressed total layers MB', (total / 1e6).toFixed(1));
"
docker image inspect --format '{{.Size}}' "$IMG"
docker run --rm "$IMG" -e "
  const fs = require('fs'), path = require('path');
  const size = (p) => { const s = fs.lstatSync(p); if (s.isSymbolicLink()) return 0; if (!s.isDirectory()) return s.size; return fs.readdirSync(p).reduce((n, e) => n + size(path.join(p, e)), 0); };
  const pnpm = 'node_modules/.pnpm';
  const dirs = fs.readdirSync(pnpm).filter((d) => d.startsWith('@openfeature+'));
  console.log(JSON.stringify({ dirs, mb: (dirs.reduce((n, d) => n + size(path.join(pnpm, d)), 0) / 1e6).toFixed(2) }));
"
```
Expected: tổng layer chưa nén ≤ 400 MB (vượt → dừng, pipeline coi là đỏ theo spec SP6 tiêu chí 15, báo Sếp); `@openfeature+server-sdk` và `@openfeature+core` cỡ dưới 1 MB (spec §3.1 ước ~0,6 MB).

- [ ] **Step 3: Ghi ADR 0013**

`docs/adr/0013-build-toolchain.md` — thêm mục mới ngay sau mục số đo mới nhất đang có (SP3):
```markdown
### Số đo SP6 (6.0) (<ngày đo>)

Đo sau `pnpm test:smoke` xanh của Task 14 plan 6.0, cùng máy và phương pháp với các dòng trước (tổng layer `docker history`; nén = `docker image inspect --format '{{.Size}}'` với containerd snapshotter). 6.0 thêm `@openfeature/server-sdk` 1.23.0 và peer `@openfeature/core` 1.12.0; 6A, 6C ghi dòng riêng khi thêm package (spec SP6 §3.1).

| Chỉ số | SP3 (dòng mới nhất) | SP6 (6.0) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | <số của dòng SP3> MB | <số đo> MB | <+x> MB |
| Image nén | <số của dòng SP3> MB | <số đo> MB | <+x> MB |
| `@openfeature/*` trong `node_modules/.pnpm` | — | <số đo> MB | — |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT | <ĐẠT/KHÔNG ĐẠT>, dư <n> MB | |
```
Thay mọi `<…>` bằng số đo thật của Step 2 và số của dòng SP3 đang có trong ADR (định dạng số theo văn bản ADR: dấu phẩy thập phân). Đây là dữ liệu đo của lần chạy, không phải chỗ trống thiết kế: dòng này chỉ được commit sau khi có số.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0013-build-toolchain.md
git commit -m "docs(adr): record the SP6 6.0 image size in ADR 0013"
```

---

### Task 15: Tài liệu — ADR 0005, 0006, 0007, 0020; dòng cập nhật ở spec cha, SP2, SP3; README

**Files:**
- Modify: `docs/adr/0005-multi-tenant-rls.md`, `docs/adr/0006-queue-outbox.md`, `docs/adr/0007-http-conventions.md`, `docs/adr/0020-files-audit-webhooks.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md`, `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, `README.md`

**Interfaces:**
- Consumes: tên thật của code ở Task 1–14; spec SP6 §18 (danh sách sửa), §18.5 (ADR).
- Produces: tài liệu khớp với cái 6.0 ship; phần 6A–6D của spec cha mang nhãn plan.

- [ ] **Step 1: ADR — mỗi ADR một mục "Cập nhật SP6 (6.0)"**

Thêm ngay trước mục "## Phương án đã loại" của từng ADR:

`docs/adr/0005-multi-tenant-rls.md`:
```markdown
## Cập nhật SP6 (6.0) (<ngày>)

- **Hai role NOLOGIN mới** trong `docker/postgres/init/01-roles.sh` (`NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, `USAGE, CREATE ON SCHEMA public`, `app_owner` là member `INHERIT FALSE, SET TRUE`): `partition_owner` sở hữu mọi bảng partitioned và hàm bảo trì partition (drop partition cần quyền owner, runtime không có `app_owner`); `sweep_definer` sở hữu **mọi** hàm `SECURITY DEFINER` quét xuyên org của mọi module/feature (R-X4) — `tenancy_definer` giữ nguyên, chỉ cho tenancy. Mọi DDL trên đối tượng của ba role NOLOGIN nằm giữa `SET LOCAL ROLE <role>` và `RESET ROLE`; `migration-scan.spec.ts` ép theo `NOLOGIN_OWNER_ROLES` và `OWNED_FUNCTIONS` (`test/support/core-catalog.ts`), gồm cả `CREATE TABLE … PARTITION BY` phải dưới `partition_owner`.
- **Hàm của hai role:** `SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC` rồi `GRANT EXECUTE … TO app_user` (default privilege của `01-roles.sh` chỉ phủ hàm do `app_owner` tạo); tham số `NULL`/ngoài biên → `RAISE`. Policy đọc của `sweep_definer` tên `<bảng>_definer_read`, grant chỉ theo cột.
- **Bảng partitioned:** RLS, FORCE, policy, grant, index, trigger khai trên bảng cha; partition không có RLS riêng nên không được có grant nào (`app_user` đọc thẳng partition → `42501`). `rls-catalog.spec.ts` khẳng định owner `partition_owner` và không grant cho `app_user`/`app_relay`/`auth_user` trên mọi partition; tập `SECURITY DEFINER` của `public` = hợp các hằng theo plan (tenancy ∪ sweep ∪ partition).
- **Rủi ro còn lại:** SQL injection dưới `app_user` gọi được mọi hàm quét (chỉ trả `org_id`) và hàm bảo trì (sàn retention cứng trong thân hàm, không hạ được).
```
`docs/adr/0006-queue-outbox.md`:
```markdown
## Cập nhật SP6 (6.0) (<ngày>)

- **Cờ event bắt buộc (R-X3):** `defineEvent({ …, audit: boolean, webhook: boolean })`, không mặc định; thiếu là lỗi compile, không phải boolean → ném lúc định nghĩa. `webhook: true` chỉ cho event theo org: `EventPublisher` từ chối phát ngoài org. Giá trị cuối của event có sẵn nằm ở `test/unit/core/events/event-flags.spec.ts`.
- **Subscriber theo bộ chọn:** `@EventSubscriber({ consumer, events: AUDITED_EVENTS | WEBHOOK_EVENTS })` nhận mọi def khớp cờ; registry dựng lúc `onModuleInit` từ `eventRegistry()`, nên mọi event phải định nghĩa lúc import (event định nghĩa sau đó làm dispatch ném). Deliver lấy def theo `type@version` của dòng outbox và kiểm def thuộc tập của subscriber.
- **`core/sweep` (R-X4, R-X14):** `defineOrgSweep({ key, definerFunction, extraParams?, orgJob, jobIdPrefix, schedule, batch })` tự `defineJob` job quét (queue `maintenance`) và `defineCron`; `OrgSweepRunner` là nơi duy nhất gọi hàm quét, trên pool `app_user` ngoài transaction/`OrgScope`, bằng ký hiệu tham số theo tên và ép kiểu tường minh (`number → integer` 32-bit, `boolean`, `string → text`). Keyset từ `PURGE_CURSOR_START`, dừng khi lô ngắn; lô cuối đầy ở `maxBatches` → WARN `org_sweep_backlog`. Chống trùng duy nhất: `jobId = <prefix>-<orgId>-<slot>`, `slot = floor(epochSec / minGapSec(cron, tz))` — job theo org `failed` chỉ chặn org đó tới slot sau. Hàm quét phải trả org tăng dần, không quá `p_limit`; sai → `OrgSweepDefinitionError`. `org-sweep-signatures.spec.ts` kiểm chữ ký trên `pg_proc` cho mọi sweep đã đăng ký.
- **`core/partitions`:** `definePartitionedTable({ tables, maintainFunction, lockKey, retentionMonths, premakeMonths })`; cron `core.partitions.maintain` (`PARTITIONS_MAINTAIN_CRON` = `30 0 * * *` UTC) gọi từng hàm bảo trì trong `UnitOfWork` riêng, mục lỗi không chặn mục khác. Metric `db_partition_maintain_total{table, action}`, gauge `db_partition_months_ahead{table}` (cảnh báo `< 2`).
- **Kill switch (`core/flags`):** xem ADR 0020 mục "Kết quả spike (plan 6.0)" và README; cron không liên quan.
```
`docs/adr/0007-http-conventions.md`:
```markdown
## Cập nhật SP6 (6.0) (<ngày>)

- **Body parser nhiều chủ:** token đơn chủ `HTTP_BODY_PARSER_SKIP_PREFIX` được thay bằng marker Discovery `@BodyParserOwner({ owner, prefix: () => string, contentTypes: () => readonly string[] })` đặt trên một provider singleton. `BodyParserPolicy.rules()` quét một lần ở `applyHttpDefaults`; prefix trùng hoặc lồng (so theo segment, không phân biệt hoa thường như router Express) → app không khởi động. `jsonBodyParser` bỏ qua mọi prefix đã đăng ký; `ContentTypeMiddleware` dùng `contentTypes` của prefix khớp, ngoài ra allowlist chung. Identity chuyển sang marker (`IdentityBodyParserOwner`, `owner: 'identity'`), hành vi không đổi.
- **`routeTemplateOf` và `normalizeTemplate`** chuyển vào `core/http` (identity ở 3D/6B dùng mà không import tenancy); `tenancy/http/org-route.ts` re-export.
```
`docs/adr/0020-files-audit-webhooks.md` — thêm sau mục "Kết quả spike (plan 6.0)":
```markdown
## Nền dùng chung (plan 6.0, <ngày merge>)

- Kill switch lưu trong bảng global `kill_switches` (BCNF, CHECK khoá/lý do, grant theo cột; không `DELETE`), đọc qua OpenFeature bằng `DbKillSwitchProvider`: snapshot trong bộ nhớ, làm mới mỗi `FLAGS_REFRESH_INTERVAL_MS` (mặc định 5 s), fail-static khi DB lỗi (`flags_refresh_failures_total`), lần nạp đầu lỗi → app không khởi động; `KillSwitches.isKilled` ném khi provider chưa sẵn sàng thay vì trả `false`. Mỗi app Nest một domain OpenFeature. `KillSwitches.set` là CAS theo `version` (`NO_ROW_VERSION = 0` khi chưa có dòng). Registry `defineKillSwitch` rỗng ở 6.0.
- `OrgMutationLock` (tenancy): khoá dòng org `FOR NO KEY UPDATE` trong transaction của caller cho 6A và 6C.
- `core/contracts/admin-readers.ts`: `FileUsageReader`, `WebhookStatsReader` (R-X16) — 6A/6C cài, 6D inject `@Optional()`.
- Hai role, `core/sweep`, `core/partitions`, body parser nhiều chủ, cờ event: ADR 0005, 0006, 0007 (mục "Cập nhật SP6 (6.0)").
```

- [ ] **Step 2: Dòng cập nhật ở spec cha, SP2, SP3 (spec SP6 §18)**

Mỗi chỗ thêm **một dòng** ngay sau đoạn liên quan (tìm theo nội dung; không sửa câu gốc — các plan 6A–6D thêm phần của mình):
- Spec cha §4, sau câu "**Bảng lớn** (`audit_logs`, `webhook_deliveries`, `notifications`): partition theo tháng, hết hạn thì drop partition.": `  - Cơ chế (SP6 6.0): role NOLOGIN \`partition_owner\` sở hữu bảng partitioned và hàm bảo trì \`SECURITY DEFINER\` riêng mỗi bảng (sàn retention cứng trong hàm, mốc tháng UTC), cron \`core.partitions.maintain\`, registry \`definePartitionedTable\`.`
- Spec cha §4.1 (danh sách DB role): `- (SP6 6.0) \`partition_owner\`, \`sweep_definer\` (NOLOGIN, NOBYPASSRLS). \`sweep_definer\` là role duy nhất cho mọi hàm quét xuyên org của module và feature (R-X4).`
- Spec cha §6 (cron): `- (SP6 6.0) Mọi cron quét xuyên org dùng \`defineOrgSweep\` của \`core/sweep\`: cron ở \`maintenance\`, việc theo org ở queue của module, \`jobId\` theo slot; thêm cron \`core.partitions.maintain\`.`
- Spec cha §13.1, sau câu "Kill switch vận hành lưu trong DB, đi qua `@openfeature/server-sdk` …": `  - (SP6 6.0) Vị trí \`src/core/flags\` (\`defineKillSwitch\`, \`KillSwitches\`, bảng \`kill_switches\`); hai switch đầu tiên do 6A (\`files.uploads\`) và 6C (\`integrations.webhook_delivery\`) khai.`
- SP2 §5.5: `- (SP6 6.0) \`HTTP_BODY_PARSER_SKIP_PREFIX\` được thay bằng marker \`@BodyParserOwner\` (hành vi không đổi).`
- SP3 §14: `- (SP6 6.0, R-X3) Mọi event khai hai cờ bắt buộc: \`audit: true\` cho mọi \`tenancy.*\`; \`webhook: true\` cho \`tenancy.member.added|removed|role_changed\`, \`tenancy.org.updated|deleted|restored\` (hợp đồng công khai), \`false\` cho phần còn lại. 3B/3C/3D tự khai khi định nghĩa.`
- SP3 §7.4: `- (SP6 6.0) \`routeTemplateOf\` chuyển vào \`core/http\`; tenancy import lại và re-export.`
- SP3 §6.14 (hoặc §13 "Hằng số có tên"): `- (SP6 6.0) \`DEFINER_LIMIT_MAX\`, \`PURGE_CURSOR_START\` chuyển vào \`core/sweep\`; \`tenancy/constants.ts\` re-export. §9.5 chuyển sang \`defineOrgSweep\` ở lần dọn sau (R-X4), không trong SP6.`
- SP3 §18.1 (catalog): `- (SP6 6.0) Luật catalog cho bảng partitioned (cha có RLS + FORCE + policy) và partition (owner \`partition_owner\`, không grant); ma trận role thêm \`partition_owner\`, \`sweep_definer\`; policy của \`sweep_definer\` tên \`<bảng>_definer_read\`.`

Run:
```bash
git diff --stat docs/superpowers/specs
grep -n "SP6 6.0" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md
```
Expected: chỉ thêm dòng, không xoá; `grep` thấy 4 dòng ở spec cha, 1 ở SP2, 4 ở SP3. Không tìm thấy đoạn gốc → dừng, đối chiếu `origin/main`, báo (không đoán chỗ chèn).

- [ ] **Step 3: README**

`README.md`:
1. Trong "## Cách thêm", sau mục "### Bảng tenant và xoá cứng org", thêm:
````markdown
### Kill switch

Khai lúc import trong module (key `<module>.<tên>` chữ thường, ≤ 100 ký tự) rồi hỏi qua `KillSwitches` (không import OpenFeature):

```ts
import { KillSwitches, defineKillSwitch } from '../../core/flags/index.js';

export const UploadsSwitch = defineKillSwitch({ key: 'files.uploads', description: 'Stop accepting new uploads' });
// trong service: if (await this.switches.isKilled(UploadsSwitch.key)) throw new AppError(CoreErrors.SERVICE_UNAVAILABLE);
```
- Không có dòng DB → `false`. Đổi ở một pod có hiệu lực ở mọi pod sau `FLAGS_REFRESH_INTERVAL_MS` + 1 s. DB lỗi → giữ trạng thái cuối. Dòng của switch đã bỏ khỏi code bị bỏ qua (WARN `kill_switch_unknown_key` một lần mỗi process).

### Quét xuyên org theo lịch

Một hàm SQL `SECURITY DEFINER` của `sweep_definer` trả org đến hạn, chữ ký cố định `(p_after uuid, p_limit integer, <tham số thêm theo tên>)`, `RETURNS TABLE (org_id uuid)`, `ORDER BY org_id LIMIT p_limit`, tạo trong migration giữa `SET LOCAL ROLE sweep_definer` và `RESET ROLE`, policy `<bảng>_definer_read … FOR SELECT TO sweep_definer USING (true)` + `GRANT SELECT (<cột>)`. Rồi:

```ts
import { defineOrgSweep, OrgSweepRunner } from '../../core/sweep/index.js';

export const InvoicesSweep = defineOrgSweep({
  key: 'invoices.sweep-orgs',
  definerFunction: 'invoices_orgs_due',
  extraParams: () => ({ p_grace_sec: invoicesConfig().graceSec }),
  orgJob: InvoicesSweepOrgJob, // queue của module, payload {}, org trong meta.orgId, handler idempotent
  jobIdPrefix: 'invoices-sweep',
  schedule: () => ({ cron: invoicesConfig().sweepCron, tz: 'UTC' }),
  batch: () => ({ size: 100, maxBatches: 10 }),
});
@Injectable() @JobHandler(InvoicesSweep.job)
export class InvoicesSweepHandler {
  constructor(private readonly runner: OrgSweepRunner) {}
  handle() { return this.runner.run(InvoicesSweep); }
}
```
- Thêm tên hàm vào `SWEEP_DEFINER_FUNCTIONS_<plan>` của `test/support/core-catalog.ts`; `org-sweep-signatures.spec.ts` kiểm chữ ký trên `pg_proc`.

### Bảng partitioned theo tháng

Bảng, policy, grant, index, trigger và hàm bảo trì riêng của bảng tạo trong migration dưới `SET LOCAL ROLE partition_owner` (mẫu thân hàm: `test/fixtures/migrations/…_fixture_core_shared.ts`), rồi `definePartitionedTable({ tables, maintainFunction, lockKey, retentionMonths, premakeMonths })`. Dữ liệu được giữ từ N tới N+1 tháng (partition chỉ bị drop khi cả tháng của nó cũ hơn N tháng tính từ đầu tháng UTC hiện tại).

### Module tự đọc body

Đặt `@BodyParserOwner({ owner, prefix: () => '/v1/…', contentTypes: () => ['application/octet-stream'] })` lên một provider singleton; core không đọc body dưới prefix đó, `ContentTypeMiddleware` chỉ nhận `contentTypes` đã khai. Prefix trùng/lồng với chủ khác → app không khởi động.
````
2. Trong "### CLI và runbook", thêm:
```markdown
- **Deploy 6.0:** DBA chạy lại `docker/postgres/init/01-roles.sh` (tạo `partition_owner`, `sweep_definer`) TRƯỚC migration; migration dùng role mà role chưa có sẽ dừng với thông báo rõ. Cùng lệ với 3A và 5A.
- **Cảnh báo:** `db_partition_months_ahead < 2` (page: cron bảo trì hỏng, ghi audit/webhook sẽ lỗi khi hết partition); `org_sweep_backlog_total` tăng (tăng `batch.maxBatches` của sweep hoặc tần suất cron); `flags_snapshot_age_seconds > 10 × FLAGS_REFRESH_INTERVAL_MS` (pod không làm mới được kill switch).
```
3. Bảng "## ADR": thêm dòng `| [0020](docs/adr/0020-files-audit-webhooks.md)    | Files, audit bền và webhook ra ngoài (SP6)       |` sau dòng 0017, rồi `pnpm exec prettier --write README.md`.

- [ ] **Step 4: Kiểm và commit**

Run:
```bash
pnpm lint
git diff --stat
```
Expected: chỉ file tài liệu đổi; lint xanh.
```bash
git add docs/adr docs/superpowers/specs README.md
git commit -m "docs: SP6 6.0 in ADR 0005/0006/0007/0020, update lines in the parent, SP2 and SP3 specs, README recipes and runbook"
```

---

### Task 16: Kiểm chứng toàn nhánh, push, một PR cho 6.0, CI xanh hoàn toàn

**Files:**
- Không file mới. Sửa bất kỳ file nào cần để pipeline xanh (mỗi sửa là commit riêng có lý do).

**Interfaces:**
- Consumes: mọi task 1–15.
- Produces: nhánh của plan 6.0 (`sp6-0-core-shared`) trên `origin`, một PR `sp6-0-core-shared → main` với mọi check CI xanh.

- [ ] **Step 1: Pipeline đầy đủ trên máy (cùng thứ tự như CI)**

Run:
```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm arch
pnpm typecheck
pnpm test
pnpm build
pnpm test:int
pnpm test:chaos
pnpm test:smoke
pnpm env:example && git diff --exit-code .env.example .env.infra.example
pnpm openapi:export && git diff --exit-code openapi.json
```
Expected: mọi lệnh exit 0. Đọc output thật, không suy từ lần chạy trước:
- `pnpm test:int` gồm `migrations.spec.ts` (up → down → up và sweep S2-R57 trên database riêng, gồm `…_kill_switches` và fixture `…_fixture_core_shared`), `rls-catalog.spec.ts`, `normalization-inventory.spec.ts`, `org-sweep-signatures.spec.ts`, `partition-maintain.spec.ts`.
- `pnpm test:smoke`: image production thật, `compose --profile app`, `NODE_ENV=production`, log JSON sạch, `/health/ready` 200, teardown sạch.
- OpenAPI không đổi (6.0 không thêm route); `git diff --exit-code openapi.json` sạch.
- `pnpm arch`: luật 22, 23, 27 bắt fixture; cây `src` thật sạch.
Lệnh nào đỏ: tìm nguyên nhân gốc (skill `superpowers:systematic-debugging`), sửa, commit, chạy lại **toàn bộ** Step 1.

- [ ] **Step 2: Rebase lên `main` của sóng W2 (3B, 4A, 7A chạy song song — R-X7)**

Run:
```bash
git fetch origin main
git rebase origin/main
```
Nếu `main` đã có plan W2 khác:
- **Event mới của plan merge trước** (3B `tenancy.*`, 4A `entitlements.*`) chưa có cờ → `pnpm typecheck` báo thiếu `audit`/`webhook` ở đúng lời gọi đó. Khai theo spec: event `tenancy.*` của 3B `audit: true`, `webhook: false` (sáu event webhook của SP6 §8.3 đều là event 3A); event `entitlements.*` `audit: true` (SP6 §18.4), `webhook` theo spec SP4 (mặc định `false` nếu SP4 không khai hợp đồng webhook). Commit riêng `fix(events): declare audit/webhook flags on events merged in W2`.
- **7A đổi `src/app.modules.ts`/composition:** giữ `FlagsModule` (api + worker), `SweepModule`, `PartitionsModule` (worker) ở phần core của `AppApiModule`/`AppWorkerModule` (không phải module tắt được); chạy lại `event-flags.spec.ts`, `org-sweep-signatures.spec.ts` (hai file import composition của app).
- **Migration:** timestamp của `…_kill_switches` (và fixture) phải lớn hơn migration mới nhất trên `main`; nếu không, tạo lại file bằng CLI (tên mới), chép thân, xoá file cũ.
- Chạy lại **toàn bộ** Step 1.

- [ ] **Step 3: Kiểm tay trước khi push**

Run:
```bash
git log --oneline origin/main..HEAD
git status --short
git diff --stat origin/main...HEAD
```
Expected: `git status` sạch; commit theo task, message conventional tiếng Anh; không có `test/integration/spike-sp6-0/`, không file tạm, không secret; `grep -rn HTTP_BODY_PARSER_SKIP_PREFIX src test` rỗng.

- [ ] **Step 4: Push và mở PR**

Run:
```bash
git push -u origin sp6-0-core-shared
gh pr create --base main --head sp6-0-core-shared --title "SP6 plan 6.0: shared core (event flags, selector subscribers, body parser owners, kill switches, org sweeps, partitions)" --body-file "$TMPDIR/sp6-0-pr.md"
```
Nội dung `$TMPDIR/sp6-0-pr.md` (viết file trong scratchpad, không commit):
```markdown
## SP6 plan 6.0 — shared core

Spec: docs/superpowers/specs/2026-09-28-sp6-files-audit-integrations-admin-design.md (r2, §17 Bảng 1 dòng 6.0)
Plan: docs/superpowers/plans/2026-09-29-sp6-0-core-shared.md
Rulings: R-X3, R-X4, R-X7, R-X14, R-X16
ADR: 0020 (mới, spike P1–P3), 0005, 0006, 0007, 0013 (dòng "SP6 (6.0)")

### Nội dung
- core/events: cờ `audit`/`webhook` bắt buộc; subscriber bộ chọn `AUDITED_EVENTS`/`WEBHOOK_EVENTS`; event webhook chỉ phát trong org
- core/http: `@BodyParserOwner` nhiều chủ (identity chuyển sang); `routeTemplateOf` chuyển từ tenancy
- core/flags: bảng `kill_switches`, provider OpenFeature fail-static, `KillSwitches`
- core/sweep: `defineOrgSweep` + `OrgSweepRunner` (tham số SQL theo tên, `jobId` theo slot); `DEFINER_LIMIT_MAX`/`PURGE_CURSOR_START` chuyển từ tenancy
- core/partitions: `definePartitionedTable`, cron `core.partitions.maintain`
- core/contracts: `FileUsageReader`, `WebhookStatsReader`
- tenancy: `OrgMutationLock`; db: role `partition_owner`, `sweep_definer`

### Kiểm chứng (lệnh và kết quả thật)
<dán output tóm tắt của từng lệnh Step 1: số test pass theo project, thời gian>

### Chaos (Task 13)
<dán dòng `partition-maintain-under-load` (ms mỗi lượt, số INSERT)>

### Image (ADR 0013)
<chưa nén / nén / chênh so với SP3 / phần @openfeature — đúng số đã ghi ở Task 14>

### Triển khai
- DBA chạy lại `docker/postgres/init/01-roles.sh` trước migration.

### Rủi ro còn lại
- Khoá advisory của hàm bảo trì (6001, 6002, 6900) dùng chung không gian khoá `bigint` với `tenancy_org_lock_key` (băm org): va chạm có xác suất ~ số org / 2^64, chấp nhận có tên.
- DETACH/DROP partition giữ `ACCESS EXCLUSIVE` trên bảng cha trong thời gian đo ở spike P1 (chặn bởi `lock_timeout` 5 s).
```
Thay các khối `<…>` bằng output thật của Step 1, Task 13, Task 14 trước khi chạy `gh pr create` (dữ liệu của lần chạy, không phải chỗ trống của plan).

- [ ] **Step 5: Chờ CI, sửa tới khi xanh**

Run: `gh pr checks --watch`
Expected: mọi check xanh (`checks` matrix lint/arch/typecheck/test/test:int với `fetch-depth: 0`, `openapi` + oasdiff, `secrets-and-deps`, `codeql`, `image`). Check đỏ: `gh run view <id> --log-failed`, tìm nguyên nhân gốc, sửa, commit, push, chờ lại. Không `--no-verify`, không tắt check, không đánh dấu flaky để qua.

- [ ] **Step 6: Báo cáo**

Báo Sếp: link PR, danh sách check xanh (`gh pr checks`), số test theo project, số đo image và chaos, rủi ro còn lại, việc chuyển sang 6A/6C (W3) và 6B (W4, cần 3D). Không merge (merge là quyết định của Sếp).

---

## Race của plan 6.0 → cơ chế → test

| Race | Tình huống | Cơ chế | Test (task) |
|---|---|---|---|
| R6-17 | Hai lượt bảo trì partition cùng lúc | `pg_try_advisory_xact_lock(<lockKey>)` trong hàm; lượt thứ hai trả rỗng ngay | `two concurrent runs…` (12), chaos (13) |
| R6-20 | Hai lần đổi kill switch cùng version | CAS `UPDATE … WHERE key = ? AND version = ?`; `INSERT … ON CONFLICT (key) DO NOTHING` cho `expectedVersion = 0` | `concurrent sets…` ×20 cho cả hai nhánh (9) |
| R60-1 | Hai lượt cron quét (hay một retry) trong cùng slot | `jobId = <prefix>-<orgId>-<slot>` — BullMQ bỏ `add` trùng id | `the same slot adds no job…` (11) |
| R60-2 | Redis lỗi giữa lượt quét | Runner ném → BullMQ retry job quét; job theo org đã enqueue bị bỏ nhờ `jobId` | `Redis failing mid-run…` (11) |
| R60-3 | Job theo org `failed` chặn org mãi | `jobId` theo slot: chỉ chặn tới slot sau (không phụ thuộc `QUEUE_KEEP_FAILED_AGE_SEC`) | `a failed org job blocks that org only until the next slot` (11) |
| R60-4 | Hai thao tác "đếm rồi thêm" cùng org (6A, 6C) | `OrgMutationLock` = `FOR NO KEY UPDATE` dòng org trong transaction của caller; không chặn INSERT có FK (`FOR KEY SHARE`) | `holds a second locker…` (7) |
| R60-5 | Lượt làm mới kill switch đang chạy khi app tắt | `beforeApplicationShutdown` → `provider.onClose()` dừng timer và chờ lượt đang chạy, trước khi pool đóng ở `onApplicationShutdown` | `close waits for the refresh in flight` (9) |
| R60-6 | `isKilled` trước khi provider sẵn sàng / sau khi tắt | Ném thay vì trả mặc định `false`; provider sẵn sàng trong `onModuleInit` (trước WorkerHost) | `isKilled throws once the app is closed…` (9) |
| R60-7 | Bảo trì partition đua INSERT | `ATTACH` giữ `SHARE UPDATE EXCLUSIVE` (không chặn ghi); `DETACH`/`DROP` giữ `ACCESS EXCLUSIVE` ngắn, chặn bởi `lock_timeout` 5 s | spike P1 (1), `ATTACH keeps the parent…` (12), chaos (13) |
| R60-8 | Event định nghĩa sau khi registry subscriber đã dựng | `SubscriberRegistry.forEvent` ném cho def không có lúc dựng | `an event defined after the registry…` (4) |
| R60-9 | Khoá advisory hằng (6001/6002/6900) va chạm khoá băm org của tenancy | Chấp nhận có tên: xác suất ~ số org / 2^64 | — (ghi ở PR và ADR 0005) |
| R60-10 | Nhiều app Nest trong một process dùng chung singleton OpenFeature | Mỗi `KillSwitches` một domain `core.flags.<uuid>`; tắt thì thay domain bằng `NOOP_PROVIDER` | P3 `two domains…` (2), hai instance (9) |

---

## Self-review

### 1. Độ phủ spec (spec SP6 §17 Bảng 1 dòng 6.0, §2.1 "src/core", §5.3 các hàng "6.0", rulings)

| Hạng mục 6.0 | Task |
|---|---|
| Spike P1 (partition_owner, ATTACH, trigger/index nhân bản, `42501` trên partition, DETACH/DROP dưới tải) | 1 (kết quả ADR 0020), giữ thành test ở 12 |
| Spike P2 (thứ tự drop với FK giữa hai bảng partitioned) | 1 |
| Spike P3 (OpenFeature ESM, `setProviderAndWait`, provider tự viết, `close` gọi `onClose`) | 2 (giữ làm test hợp đồng) |
| `defineEvent` cờ `audit`/`webhook` bắt buộc (R-X3), giá trị cuối cho mọi event đang có (identity, notifications, 8 tenancy 3A, fixture) | 3 |
| Subscriber theo bộ chọn, `AUDITED_EVENTS`, `WEBHOOK_EVENTS`, deliver theo def của dòng | 4 |
| `BodyParserPolicy` nhiều chủ `@BodyParserOwner`, `ContentTypeMiddleware` theo prefix, identity chuyển marker | 6 |
| `routeTemplateOf` → `core/http`; `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` → `core/sweep`; tenancy re-export | 5 |
| `src/core/contracts/admin-readers.ts` (R-X16) + luật 27 | 5 |
| Tenancy export `OrgMutationLock` | 7 |
| Role `partition_owner`, `sweep_definer` trong `01-roles.sh` (§3.2) | 1 |
| `core/flags` (bảng `kill_switches` §6.2, `defineKillSwitch`, `KillSwitches`, provider OpenFeature, fail-static) + config §11.1 `FLAGS_REFRESH_INTERVAL_MS` | 8, 9 |
| `core/sweep`: `defineOrgSweep` + `OrgSweepRunner`, tên hàm SQL + `extraParams` theo tên (R-X4, R-X14), `jobId` theo slot | 11 |
| `core/partitions`: registry, cron `core.partitions.maintain`, handler, metric; config §11.1 `PARTITIONS_MAINTAIN_CRON`/`_TZ` | 12 |
| `rls-catalog.spec.ts` (a) cha partitioned, (b) partition, (e) ma trận role | 10 (a, b), 1 (e) |
| Quét tĩnh migration mở rộng `NOLOGIN_OWNER_ROLES` | 10 |
| `normalization-inventory.spec.ts` thêm `kill_switches` | 8 |
| Luật kiến trúc 22 (OpenFeature), 23 (module nền không import module SP6), 27 (`core/contracts`) | 2, 5 |
| Test C-1 | 3 |
| Test C-2, C-3, C-4 | 4 (C-3 phần "webhook ⇒ org" ở 3) |
| Test C-5 (+ R6-17) | 12 |
| Test C-6 | 1, 10 |
| Test C-7 | 6 |
| Test C-8, C-8b, `org-sweep-signatures.spec.ts` | 11 |
| Test C-9 | 5 |
| Test C-20 | 9 |
| Test C-30 (chaos) | 13 |
| Metric/log core §15 (`flags_refresh_failures_total`, `flags_snapshot_age_seconds`, `org_sweep_*`, `db_partition_*`), span `core.partitions.maintain`, cảnh báo trong runbook | 9, 11, 12, 15 |
| ADR 0005, 0006, 0007, 0020 (tạo file), 0013 (đo image) | 1, 2, 14, 15 |
| Sửa spec cha/SP2/SP3 phần 6.0 (§18.1–18.3), runbook "chạy lại `01-roles.sh`" | 15 |
| Tiêu chí 15 (pipeline xanh từng plan, image ≤ 400 MB), tiêu chí 11 (phần core của kill switch) | 7, 9, 12, 14, 16 |

### 2. Quét chỗ trống

`<ts>` trong tên migration và tên lớp minh hoạ (`Migration20260930000000_kill_switches`, `Migration20260930000100_fixture_core_shared`) là quy ước của plan: tên do CLI sinh (Global Constraints). Các `<…>` còn lại là **dữ liệu của lần chạy**, không phải thiết kế còn thiếu: số đo spike (Task 1 Step 8), số đo image (Task 14 Step 3, chỉ commit sau khi đo), ngày (Task 15), output kiểm chứng/chaos/image trong mô tả PR (Task 16). Không còn "TBD", "tương tự Task N", hay bước mô tả mà không có code.

### 3. Nhất quán tên và kiểu

- `EventDef.audit/.webhook` (3) dùng ở `AUDITED_EVENTS`/`WEBHOOK_EVENTS` (4); `EVENT_SELECTORS` chỉ nội bộ `core/events`.
- `BodyParserOwner`, `BodyParserPolicy.rules()/ruleFor()`, `requestPath` (6) dùng ở `http-bootstrap.ts`, `content-type.middleware.ts`, identity.
- `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` (5) dùng ở `org-sweep.ts`/`org-sweep.runner.ts` (11).
- `KillSwitches.isKilled/list/set`, `NO_ROW_VERSION`, `KillSwitchChange`, `KillSwitchSetResult`, `KillSwitchState` (9) — 6A/6C/6D.
- `defineOrgSweep`, `OrgSweepDef.job`, `OrgSweepRunner.run(def, at?)`, `sweepJobId`, `OrgSweepDefinitionError`, `OrgSweepResult` (11); `sweepSignatureProblems` (test support).
- `definePartitionedTable`, `tableOfPartition`, `monthsAhead`, `NO_PARTITIONS`, `MaintainPartitionsHandler`, `PartitionMetrics.maintained` (12).
- `OrgMutationLock.lock(): Promise<boolean>` (7).
- Hằng test: `NOLOGIN_OWNER_ROLES`, `OWNED_FUNCTIONS`, `SWEEP_DEFINER_*`, `PARTITION_OWNER_*`, `PARTITIONED_TABLES` (`test/support/core-catalog.ts`, 10) dùng ở `migration-scan.spec.ts`, `rls-catalog.spec.ts`.
- Fixture DB: `fixture_orgs_due(p_after, p_limit, p_min_age_sec, p_tag)`, `fixture_part_events_maintain(p_retention_months, p_premake_months)`, `lockKey` 6900 — cùng tên ở migration (10), sweep (11), partition (12), chaos (13).

### 4. Review Focus

Năm dòng ở đầu plan, mỗi dòng có test ở task sở hữu code: 1 → Task 6; 2, 3 → Task 11; 4 → Task 12; 5 → Task 9.

### 5. Lệch có chủ đích so với chữ của spec

- **`@BodyParserOwner` nhận `prefix`/`contentTypes` dạng thunk** (spec §5.3 ghi `{ owner, prefix, contentTypes }`): registry chạy lúc import, trước khi config được validate; identity đọc `AUTH_BASE_PATH` từ config.
- **`KillSwitches.list()` và `expectedVersion = NO_ROW_VERSION (0)`** thêm vào hợp đồng §5.3 (chỉ ghi `isKilled`, `set`): 6D cần đọc trạng thái + ETag mà không phải sửa `core/flags`.
- **`EventPublisher` từ chối phát event `webhook: true` ngoài org:** spec C-3 đòi "mọi def `webhook: true` phải là event theo org (unit, quét registry)"; registry không biết event có org hay không, nên điều đó được ép ở chỗ duy nhất biết (lúc phát), cộng bảng cờ cuối trong `event-flags.spec.ts`.
- **Luật kiến trúc 23** ship ở 6.0 (spec §5.4 không gán plan): nó chỉ nói về đường dẫn, không cần module SP6 tồn tại, và chặn sớm import ngược khi 6A–6D bắt đầu.
- **Fixture bảng partitioned không có FK tới `organizations`:** dòng append-only không xoá được sẽ chặn `seedOrg().dispose()`; trường hợp FK dưới `partition_owner` được đo ở spike P1 (kết luận: 6C cần `GRANT REFERENCES (id) ON organizations TO partition_owner`).

### 6. Hạng mục của 6.0 chưa đặt được

Không có. Luật kiến trúc 20, 21, 24, 25, 26 thuộc plan tạo module tương ứng (6A, 6C, 6B, feature, 6D) vì fixture của chúng cần package/module chưa có ở 6.0; kill switch thật (`files.uploads`, `integrations.webhook_delivery`) và các `GLOBAL_TABLES`/`DEFINER_FUNCTIONS_6A|6C|6D` thuộc 6A/6C/6D theo spec §17 Bảng 5.

### 7. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **Mức khoá của `ATTACH PARTITION` trên PG 18 và khoá nhân bản FK** (spike P1): nếu cha bị giữ mạnh hơn `SHARE UPDATE EXCLUSIVE`, fallback §4 P1 (tạo trước ở cửa sổ ít tải) đổi thiết kế cron — dừng và báo trước Task 12.
2. **Identity của bảng cha partitioned với partition tạo bằng `LIKE … INCLUDING DEFAULTS INCLUDING CONSTRAINTS` rồi `ATTACH`** (PG 17+ hỗ trợ identity trên bảng partitioned): spike P1 chèn qua bảng cha để kiểm; đỏ → fallback đổi `id` fixture sang `uuid DEFAULT uuidv7()` và ghi cho 6B/6C.
3. **Thứ tự `DETACH` với FK giữa hai bảng partitioned báo đúng `23503`** (spike P2): mã khác nhưng vẫn là lỗi FK rõ ràng → sửa kỳ vọng theo mã đo được.
4. **`OpenFeature.setProviderAndWait(domain, NOOP_PROVIDER)` gọi `onClose` của provider cũ đồng bộ đủ sớm** (đã đọc `dist/esm` của core 1.12.0: gọi ngay, không chờ): `KillSwitches` tự gọi `provider.onClose()` trước, nên không phụ thuộc thời điểm đó.
5. **Discovery thấy provider mang `@BodyParserOwner` trước `app.init()`** (spec §5.3 dựa vào điều này; `applyHttpDefaults` chạy sau `NestFactory.create`): e2e Task 6 dùng `buildTestApp` + `applyHttpDefaults` đúng thứ tự production.
6. **`minGapSec('*/5 * * * *', 'UTC')` = 300** (grid của `schedule-validation.ts`): unit runner khẳng định slot bằng công thức này; lệch thì sửa hằng `SLOT_SEC` theo giá trị hàm trả (không đổi code).
7. **Tên và hình dạng code của 3A đúng như plan 3A Produces** (`OrgRepository.lockCurrent`, `TenancyCoreModule`, `tenancyCoreImports`, `org-route.ts`, `events.ts`): 3A đang được thực thi; khi 6.0 bắt đầu, đối chiếu với code đã merge và sửa đường dẫn/import của plan nếu 3A đã đổi tên trong review.
8. API đã đối chiếu với code/tarball lúc viết plan (không còn là giả định): `@openfeature/server-sdk` 1.23.0 `types.d.ts` (`Provider` đủ bốn `resolve*` trả `Promise`, `Client.providerStatus`, `OpenFeature.setLogger/close/clearProviders`, `NOOP_PROVIDER`, re-export toàn bộ `@openfeature/core` gồm `TypeMismatchError`, `StandardResolutionReasons`, `ProviderStatus`), core 1.12.0 `dist/esm` (`setAwaitableProvider` ném lại lỗi `initialize`, gọi `onClose` provider cũ), `Db.execute` placeholder `?`, `JobQueue.enqueueMany`, `defineCron` ở `core/scheduler/cron-definition.ts`, `minGapSec`/`isValidCron`/`normalizeTimezone` ở `schedule-validation.ts`, `METER` ở `core/observability/queue-metrics.ts`, `Inbox.once` trả `'processed' | 'duplicate'`, `OutboxReader`/`OutboxRow`/`DeliverEventHandler` export từ `event-dispatch.handlers.ts`, `RequestContext.run/orgId/requestId/traceparent`, `BullmqJobQueue.queue(name)`, `withAppClient(fn, database?)`/`inOrgTx`/`seedOrg({ database })` của `tenancy-seed.ts`, `createScratchDb`, `buildTestApp`, `installOtelCapture().metric/spanNames`, `startTcpProxy().state.blackhole/sever`, luật `no-orphans` (warn) nằm trong ca `real source tree has no violations`.
