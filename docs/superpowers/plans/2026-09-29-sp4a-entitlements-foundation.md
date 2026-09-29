# Sub-project 4A — Entitlements nền (entitlements foundation): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm `src/modules/entitlements` phần nền của SP4 (catalogue tính năng trong code, catalogue gói trong code của dự án, bảng `entitlement_features`/`plans`/`org_entitlements`, đánh giá hiệu lực `FLAG`/`LIMIT`, `requireEnabled` chạy sau CASL, `GET /v1/orgs/{orgId}/entitlements`, `PlanAssignments.assign` có thứ tự cho SP5, mọi org có đúng một dòng `org_entitlements` từ lúc tạo), cùng hai sửa nhỏ ở `modules/tenancy` (participant tạo org, `classifyTenantHandler`), chứng minh bằng test trên Postgres 18 + PgBouncer + Redis thật và bằng smoke chạy image production qua `docker compose --profile app` với `NODE_ENV=production`; 4A ship một mình với CI xanh.

**Architecture:** Entitlements là module riêng phụ thuộc tenancy (qua `index.ts`), không ngược lại. Tính năng khai báo bằng `defineFeatureCatalogue` và đăng ký bằng marker Discovery `@FeatureCatalogueContributor` (cùng mẫu catalogue quyền của SP3); gói khai báo bằng `definePlanCatalogue` ở `src/plans.example.ts` (vùng template) và tới module qua `EntitlementsModule.forApi(plans)`/`forWorker(plans)`. DB chỉ giữ bảng tra cứu (`entitlement_features`, `plans`) cho FK và một dòng `org_entitlements` mỗi org (RLS FORCE), kiểm bằng nhau với code lúc boot. Kiểm tính năng ở route là interceptor route-scoped (`EntitlementInterceptor`, gắn bởi `requireEnabled`), nên luôn chạy sau `PoliciesGuard` và bên trong `OrgScope` của `OrgScopeInterceptor`. Gán gói là một API đồng bộ chạy trong transaction của caller (`PlanAssignments.assign`), khoá dòng `FOR NO KEY UPDATE`, trả kết quả có tên, ném lỗi có tên luôn trước câu ghi đầu tiên. Org mới nhận dòng `org_entitlements` trong chính transaction tạo org qua participant mới của tenancy; subscriber `tenancy.org.created` là lưới dự phòng idempotent; purge participant `order = 100` xoá dòng khi xoá cứng org.

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), zod 4.6.5, `@nestjs/core` `DiscoveryService`, OpenTelemetry API 1.9.1, Vitest + Testcontainers, `tcp-proxy.ts` (chaos), Docker Compose smoke. **Không package mới.**

**Spec:** `docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md` (r2, đã chốt 2026-09-29; mục 21 hàng "4A" là nguồn phạm vi của plan này, mục 22.1 P1–P10, 22.2 T1–T4/T6/A1/L1 dòng 4A). Kèm theo, cùng ràng buộc: phán quyết chéo `.superpowers/autonomous/rulings.md` (R-X1…R-X24, bản đang hiệu lực; bản commit sớm hơn `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` chỉ tới R-X19; R-X7: **4A chỉ cần 3A**; R-X21: key quyền chỉ có ở DB là WARN, ship trong 3A Task 20b; R-X24: tập quyền trong test tính từ catalogue), spec SP3 r8 `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, addendum 3D `docs/superpowers/specs/2026-09-28-sp3-addendum-platform-staff.md` (§A4 registry `order`), spec cha `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`. Mẫu định dạng và độ sâu: `docs/superpowers/plans/2026-09-28-sp3a-tenancy-foundation.md` (tên 3A tạo ra lấy theo các khối "Produces" của plan đó). Bài học 3A: `.superpowers/sdd/2026-09-28-sp3a-tenancy-foundation/progress.md`.

**Tiền điều kiện thực thi:** plan 3A đã merge vào `main` (Task 1–31 của 3A). Plan này không đợi 3B/3C/3D, 6.0 hay 7A (R-X7, spec §21); hai chỗ phụ thuộc thứ tự merge trong cùng sóng W2 (cờ event của 6.0, composition của 7A) có nhánh tường minh ở Task 6 và Task 7.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2 và 3A (Global Constraints của `2026-09-28-sp3a-tenancy-foundation.md`), cộng các luật của SP4 (spec §3, bắt buộc cho mọi task):

- **Package-first:** không cài package nào (spec §3.1). Nhu cầu có sẵn: `zod`, `@nestjs/core` `DiscoveryService`, `core/database`, `core/events`, `core/http`, `core/errors`. Không `@nestjs/cache-manager`, `cache-manager`, `@keyv/redis` (S4-D8). `package.json`/`pnpm-lock.yaml` không đổi ở bất kỳ task nào (Task 15 kiểm bằng `git diff origin/main -- package.json pnpm-lock.yaml`).
- **Generator:** `nest g controller|module <path> --no-spec` cho khung Nest nếu cần; `pnpm exec mikro-orm migration:create --blank --path src/migrations/entitlements --name entitlements_core` và `pnpm exec mikro-orm migration:create --blank --path src/migrations/example --name starter_plans`. Tên file do CLI sinh (`Migration<14 chữ số>_<tên>`); plan viết `Migration<ts>_<tên>`, code và test không bao giờ viết cứng timestamp (tìm migration theo hậu tố tên).
- **Không đoán API:** mọi tên của 3A lấy từ khối "Produces" của plan 3A; trước khi dùng, `grep` tên đó trong `src/` của `main` (3A đã merge). Tên lệch → dùng tên thật, ghi vào báo cáo task; không tạo lại hàm đã có. TDD, không `any`, không tắt lint, không `as never`/`as any` (quét `hardcode-scan.spec.ts`).
- **Bất biến ở DB:** mọi điều biểu diễn được bằng `CHECK`/`UNIQUE`/`FK`/trigger nằm ở DB (spec §7). Trigger ném `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = '<tên>'`, map bằng `defineConstraintErrors` sẵn có.
- **Kiểu dữ liệu:** PK `BIGINT GENERATED ALWAYS AS IDENTITY` cho bảng global; bảng tenant khoá tự nhiên `org_id` đứng đầu, `org_id UUID` (SP3 S3-A1). Thời gian `TIMESTAMPTZ`. Enum `TEXT` + `CHECK`. Số đếm/trần trong `[0, 2^53 − 1]`, hằng `ENTITLEMENT_VALUE_MAX = 9007199254740991` dùng chung zod và `CHECK`. Mọi bảng có `created_at`/`updated_at`.
- **FK có chủ đích:** `RESTRICT` mặc định; **không `CASCADE` ở đâu cả** (xoá cứng xoá tường minh qua participant, SP3 §9.5).
- **Khoá dòng `FOR NO KEY UPDATE`**, không bao giờ `FOR UPDATE`. Thứ tự khoá toàn hệ thống (spec §3.6): `organizations` → khoá của module gọi (vd. `billing_accounts` của SP5) → `org_entitlements` → `usage_counters` (4B). Entitlements luôn khoá **sau** mọi khoá của caller và không khoá bảng module khác sau khi đã giữ khoá của mình.
- **Không hard-code:** thời gian, múi giờ kỳ quota lấy từ config (`ENTITLEMENTS_QUOTA_TIMEZONE`, `ENTITLEMENTS_ROW_MISSING_RETRY_AFTER_SEC`); giá trị gói nằm trong catalogue gói (`src/plans.example.ts`); hằng định dạng có tên dùng chung zod và `CHECK`: `FEATURE_KEY_PATTERN`, `PLAN_KEY_PATTERN`, `REASON_MAX_LENGTH = 500`, `SOURCE_REF_MAX_LENGTH = 128`, `ENTITLEMENT_VALUE_MAX`, `ENTITLEMENTS_PURGE_ORDER = 100` (registry addendum 3D §A4). `test/unit/architecture/hardcode-scan.spec.ts` phải xanh.
- **Fail loud:** catalogue lệch DB, gói tham chiếu tính năng lạ/deprecated, giá trị sai kiểu hoặc dưới `minimum`, gói mặc định thiếu/retired, `requireEnabled` trên route không phải tenant hoặc key không phải `FLAG`, thiếu dòng `org_entitlements`, gói hiện tại lạ với pod → ném lỗi có tên kèm log ERROR; không bao giờ trả giá trị mặc định âm thầm.
- **Tám lớp lỗi có tên** (spec §6.4, R-X19) export ở `index.ts`: `EntitlementsContextError`, `UnknownPlanError`, `EntitlementsRowMissingError` (503 + `Retry-After`), `EntitlementsVersionSkewError` (503), `UnknownFeatureError`, `FeatureKindMismatchError`, `QuotaReleaseUnderflowError` (định nghĩa ở 4A, dùng từ 4B), cùng `EntitlementsErrors` (`plan_retired`, `unknown_plan`).
- **Hợp đồng ném lỗi của `assign` (spec §10.2, C-2):** kết quả nghiệp vụ (`APPLIED`, `UNCHANGED`, `STALE`, `REJECTED_RETIRED`) không bao giờ là exception; lỗi có tên (`EntitlementsContextError`, `AppError(VALIDATION_FAILED)` cho lệnh sai hình dạng, `UnknownPlanError`, `EntitlementsRowMissingError`, `AppError(PRECONDITION_FAILED)` chỉ với `PLATFORM_ADMIN`) luôn ném **trước câu ghi đầu tiên**; `assign` không ném `EntitlementsVersionSkewError`.
- **Mọi race có tên và cơ chế chặn** (spec §17; bảng race của 4A ở cuối plan). Check-then-insert không bao giờ là cơ chế.
- **Migration:** SQL bằng `addSql`, `down` đối xứng đã test (up → down → up và sweep từng bước S2-R57 trên database riêng, `migrations.spec.ts` của 3A tự phủ mọi file dưới `src/migrations/**`), xoá cả hàm trigger; grant theo bảng và theo cột cho `UPDATE`; không `ALTER DEFAULT PRIVILEGES`; đọc/ghi dữ liệu trên bảng `FORCE ROW LEVEL SECURITY` trong migration theo **mẫu 7 bước** SP3 §8.8 (NO FORCE từng bảng theo thứ tự cố định → DML + event → `SET CONSTRAINTS … IMMEDIATE` theo tên (kèm kiểm tên deferrable duy nhất) → trả chế độ khai báo theo tên → FORCE → khối khẳng định có chuỗi `a tenant table lost FORCE ROW LEVEL SECURITY`); không `isTransactional()`; không `SET CONSTRAINTS ALL`. Timestamp mới hơn migration mới nhất trên `main` (`migration-order.spec.ts`) và mới hơn `…_tenancy_core`.
- **Trigger của 4A là INVOKER** với `SET search_path = pg_catalog, public`: chúng không hoãn và chỉ đọc `NEW`/`OLD` hoặc bảng global `plans` (không RLS, `app_user` có `SELECT`). Bài học 3A "trigger hoãn/bất biến đọc bảng tenant dưới FORCE phải `SECURITY DEFINER` thuộc role definer, `search_path=''`" không áp; 4A **không tạo hàm `SECURITY DEFINER` nào**, nên tập SECURITY DEFINER mà `rls-catalog.spec.ts` khẳng định (`DEFINER_FUNCTIONS ∪ DEFINER_TRIGGER_FUNCTIONS`) giữ nguyên; plan không sửa các hằng đó.
- **Chuẩn hoá (≥ 3NF, ưu tiên BCNF):** chú thích đầu migration chép bảng chuẩn hoá spec §7.6; `normalization-inventory.spec.ts` liệt kê mọi cột của 3 bảng 4A.
- **Truy cập SQL:** chỉ qua `Db.execute` (placeholder `?`) trên EM đang gắn; không import `@mikro-orm` ngoài `infra/`. Không I/O ngoài DB trong `UnitOfWork.run` (event đi outbox cùng transaction).
- **Luật kiến trúc** (`.dependency-cruiser.cjs`, mỗi luật có fixture phải fail): 20.8-a `modules/(tenancy|identity|notifications|files)/**` không import `modules/entitlements/**`; 20.8-b `features/**` chỉ import entitlements qua `index.ts` (luật `features-only-public-api` sẵn có phủ, thêm fixture chứng minh); 20.8-c `src/app.plans.ts`, `src/plans.example.ts` chỉ import `modules/entitlements/index.ts` và `features/<f>/index.ts`.
- **Không PII:** không `reason`, `plan_source_ref`, email trong log/metric/span/event; label metric là enum hữu hạn hoặc key tính năng (catalogue hữu hạn), không `orgId`.
- **Bài học 3A (ledger):** trường lỗi của problem nằm ở `errors` (không `fields`); `Db.execute` trả `TIMESTAMPTZ` dạng chuỗi → parse bằng `z.coerce.date()`; test integration phải thấy **RED** trước; mỗi file e2e dùng principal/IP riêng (không đụng limiter của file khác); `tenancy_definer` không khoá dòng được (4A không dùng nó).
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** cuối mỗi nhóm task — Task 2 (sửa tenancy), Task 8 (schema + catalogue check chạy từ `dist`), Task 13 (luồng HTTP 4A), Task 15 (cuối) — chạy `pnpm test:smoke`: build **image production thật**, `docker compose --profile app` với hạ tầng đầy đủ và `NODE_ENV=production`, migrate từ `dist`, smoke HTTP/psql trong `test/smoke/`, log container JSON sạch (không `error`, không giá trị cấm), `/health/ready` 200, rồi `down -v`. Kích thước image ghi ở ADR 0013 (không đổi vì không package mới).
- **Spike:** code spike nằm ở `test/integration/spike-sp4a/` (project `integration`), **không commit**, xoá ở bước cuối Task 1. Kết quả (đạt/không + bằng chứng) ghi vào ADR 0018 mục "Kết quả spike (plan 4A)". S4-T1 không đạt → đi fallback của spec §5 (interceptor tự `OrgScope.run(ctx.orgId())`); S4-T3 không đạt → **dừng, báo Sếp** (spec §5: không có fallback).
- **Định dạng:** trước mỗi commit `pnpm exec prettier --write <file đã đổi ngoài docs/>`.
- **Commit:** mỗi task một commit trở lên, conventional message tiếng Anh. Push và mở PR chỉ ở Task 15.
- **Phạm vi 4A (không làm):** `usage_counters`, `Quotas`, ghế (`MemberSeatLimit`), `files.storage_bytes`, `integrations/files.ts`, `OPTIONAL_BRIDGES` (4B); override, route admin, `@PlatformStaffAction()` (4C); cache (S4-D8).

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không test nào của spec phủ, dễ làm hỏng trải nghiệm người dùng nhất:

1. **Giá trị gói không phải số nguyên an toàn** (`{ max: 1.5 }`, `{ max: NaN }`, `{ max: Infinity }`, `{ max: 2 ** 53 }`, `{ max: -1 }`) trong `src/app.plans.ts` của dự án: spec chỉ nêu "sai kiểu" và "dưới `minimum`". Mong đợi: api/worker không khởi động, log liệt kê từng giá trị lỗi; không bao giờ tới runtime rồi trả `limit: 1.5` hay `null` âm thầm. Test: Task 3 (`validatePlanCatalogue rejects non-integer, non-finite and out-of-range numbers`).
2. **Org đang ở gói mà pod này không biết** (rolling deploy, F-6): đọc snapshot trả `503`, nhưng `assign` của billing trên chính org đó vẫn phải chạy (spec §6.4: `assign` không ném `EntitlementsVersionSkewError`), nếu không org kẹt ở `503` tới hết rollout dù billing đã chuyển gói. Mong đợi: `APPLIED` và snapshot sau đó đọc được. Test: Task 12 (`assign works on an org whose current plan is unknown to this pod`).
3. **`sequence` của billing vượt `Number.MAX_SAFE_INTEGER`** (`bigint` của SP5 tăng không reset): so sánh và lưu phải chính xác, không qua `number`. Mong đợi: `2^53 + 1` rồi `2^53 + 2` → `APPLIED` cả hai, sau đó `2^53 + 1` → `STALE`; `last_billing_seq` đọc lại đúng từng chữ số. Test: Task 12 (`billing sequences beyond 2^53 compare exactly`).
4. **Tính năng `UNLIMITED` trên API tenant**: `UNLIMITED` là `Symbol`, không serialize được. Mong đợi: `{ "unlimited": true, "limit": null }` (nullable luôn có mặt), không bao giờ thiếu trường, `Infinity` hay `500`. Test: Task 9 (`an UNLIMITED value is unlimited:true, limit:null`).
5. **`requireEnabled` ở cả class lẫn method** (feature đặt cổng chung cho controller và cổng riêng cho một route): cả hai tập key phải bật; key tắt nào được báo trong `errors[0].code`. Mong đợi: tắt key của class → `403 feature_not_in_plan` với key của class; tắt key của method → key của method; bật cả hai → `200`. Test: Task 10 (`class-level and method-level requireEnabled both apply`).

---

## File Structure

```
src/
  app.modules.ts                     + EntitlementsModule.forApi(examplePlans)/forWorker(examplePlans) sau TenancyModule
                                     (nhánh 7A đã merge: mục `entitlements` trong src/boilerplate.modules.ts + MODULE_REQUIRES)
  plans.example.ts                   (mới, vùng template) examplePlans: free (mặc định), pro
  scripts/gen-env-example.ts         + import entitlements.config
  migrations/
    entitlements/  Migration<ts>_entitlements_core.ts   (3 bảng, 4 trigger, tenancy.seats, entitlements.read)
    example/       Migration<ts>_starter_plans.ts        (vùng template: plans free/pro + backfill org cũ + event)
  modules/tenancy/                   (sửa của 4A, spec §22.2 T1, T2)
    ports/        org-creation-participant.ts (mới)
    application/  org-creation-participant.registry.ts (mới) · org.service.ts (gọi participant)
    http/         org-route.ts (+classifyTenantHandler)
    tenancy.module.ts · index.ts (+export)
  modules/entitlements/              (mới)
    index.ts · entitlements.module.ts · entitlements.config.ts · constants.ts · errors.ts · events.ts
    permissions.ts (EntitlementPermissions) · features.ts (BoilerplateFeatures: tenancy.seats)
    entitlements-telemetry.ts
    domain/       feature-catalogue.ts · plan-catalogue.ts · effective-value.ts · plan-assignment.ts
    application/  entitlements-metrics.ts · entitlement-catalogue.registry.ts · entitlements.service.ts
                  catalogue-check.ts · entitlement-route-inventory.ts · plan-assignments.service.ts
                  provision-org.participant.ts · provision-org.subscriber.ts · org-purge.participant.ts
    ports/        org-entitlement.repository.ts · catalogue.reader.ts
    http/         feature-metadata.ts · decorators.ts · entitlement.interceptor.ts
                  schemas.ts · org-entitlements.controller.ts · entitlements-http.module.ts
    infra/sql/    entitlements-purge.sql.ts · sql-org-entitlement.repository.ts · sql-entitlement-catalogue.reader.ts
.dependency-cruiser.cjs              luật 20.8-a, 20.8-c (+ ngoại lệ no-orphans tạm thời, gỡ ở task dùng file)
test/
  support/  entitlements-catalog.ts · entitlements-seed.ts · entitlements-fixtures.ts · entitlements-app.ts · entitlements-races.ts
            entitlement-permissions.module.ts · tenancy-seed.ts (thứ tự xoá có entitlements) · tenancy-core-app.ts
            tenancy-app.ts (catalogue quyền entitlements)
  fixtures/migrations/Migration<ts>_fixture_billing_accounts.ts
  architecture/fixtures/src/ modules/entitlements/{index,deep}.ts · modules/tenancy/uses-entitlements.ts
            features/x/uses-entitlements-deep.ts · plans.example.ts
  unit/     modules/entitlements/*.spec.ts · modules/tenancy/org-creation-participant-registry.spec.ts
            modules/tenancy/classify-tenant-handler.spec.ts · migrations/migration-order.spec.ts (sửa)
  integration/ entitlements/*.spec.ts · core/database/{rls-catalog,normalization-inventory}.spec.ts (sửa)
            tenancy/constraints.spec.ts (sửa: 19 key của tenancy)
  e2e/      entitlements/*.e2e.spec.ts · tenancy/org-creation-participants.e2e.spec.ts · tenancy/orgs.e2e.spec.ts (sửa)
  chaos/    entitlements-outages.spec.ts
  smoke/    entitlements.smoke.spec.ts · smoke-devices.ts (tách từ tenancy.smoke.spec.ts) · tenancy.smoke.spec.ts (sửa)
docs/adr/ 0018 (mới) · 0005 · 0013 (dòng "SP4 (4A)") · 0015 · 0017
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (P1–P10) · 2026-09-28-sp3-tenancy-access-design.md (T3, T4)
README.md (mục entitlements, nâng cấp lên SP4, runbook)
```

**Vì sao `defineFeatureCatalogue` ở `http/decorators.ts`, không ở `domain/feature-catalogue.ts` như sơ đồ spec §6.2:** hàm trả về decorator `requireEnabled(...)` (gắn `UseInterceptors(EntitlementInterceptor)`), mà luật `domain-pure` cấm `domain/` import `http/`. `domain/feature-catalogue.ts` giữ phần thuần (kiểu, gộp, kiểm EC); `http/decorators.ts` bọc thành catalogue có `requireEnabled`. Cùng lý do và cùng cách với `definePermissionCatalogue` của 3A. Hợp đồng công khai (`index.ts`) không đổi.

**Vì sao `EntitlementsCoreModule` là `@Global()`:** `EntitlementInterceptor` được Nest khởi tạo trong module của controller dùng `requireEnabled` (controller của `features/`), nên `Entitlements`, `EntitlementsMetrics` phải thấy được từ mọi module, cùng lý do `TenancyCoreModule` của 3A là `@Global()`.

**Vì sao subscriber dự phòng chỉ ở `forWorker()`:** api không có `SubscriberRegistry` (`EventsModule.forRoot({ worker: false })`), subscriber ở api là provider chết. Harness e2e (api + worker events trong một process) thêm subscriber qua module test (`EntitlementsProvisionTestModule`, Task 11).

**Vì sao migration `…_entitlements_core` được sửa ở Task 7 (thêm `entitlements.read`):** dòng `permissions` mới làm `CatalogueCheck` của tenancy từ chối boot mọi app không có catalogue quyền của entitlements; nên dòng đó phải vào DB **cùng commit** với code đăng ký catalogue (Task 7). File chưa merge nên sửa được (cùng cách 3A Task 15 thêm hàm definer vào migration của Task 13).

---
## Phần A — Spike (bắt buộc làm trước mọi task khác, spec §5)

Plan 4A chạy S4-T1 và S4-T3 (S4-T2 thuộc 4B và đã được review chạy đạt trên PG 18.6). Mỗi spike trả lời đúng một câu hỏi của spec §5 bằng code chạy thật trên hạ tầng Testcontainers của repo; kết quả vào ADR 0018 mục "Kết quả spike (plan 4A)" và được commit. Code spike ở `test/integration/spike-sp4a/`, **không commit**, xoá ở bước cuối.

### Task 1: Spike S4-T1 (interceptor route-scoped trong `OrgScope`, sau `PoliciesGuard`) và S4-T3 (điểm cắm trong transaction tạo org); khung ADR 0018

**Files:**
- Throwaway: `test/integration/spike-sp4a/interceptor-scope.e2e.spec.ts`, `test/integration/spike-sp4a/org-creation-hook.e2e.spec.ts`
- Create: `docs/adr/0018-entitlements-in-code.md`

**Interfaces:**
- Consumes (3A, đã merge): `startTenancyApp`, `authed` (`test/support/tenancy-app.ts`), `seedUserPrincipal`, `deleteSeededPrincipals` (`test/support/tenancy-principals.ts`), `seedOrg`, `seedMember`, `purgeOrgs`, `deleteTenancyUsersOf`, `withAppClient`, `inOrgTx` (`test/support/tenancy-seed.ts`), `TenancyPermissions` (`src/modules/tenancy/permissions.ts`), `SqlRoleRepository.insertSystemRoles` (`src/modules/tenancy/infra/sql/sql-role.repository.ts`), bảng fixture `fixture_org_items` (3A Task 14), `RequestContext`, `Db`, `UnitOfWork` (SP1).
- Produces: `docs/adr/0018-entitlements-in-code.md` với mục "Kết quả spike (plan 4A)" (dòng S4-T1, S4-T3 đã điền); các task sau dựa vào hai kết luận: (1) `EntitlementInterceptor` không tự mở `OrgScope`; (2) participant tạo org chạy được trong transaction tạo org, trước `MemberAdmission`, trong `OrgScope(newId)`.

- [ ] **Step 0: Nhánh làm việc từ `main` đã có 3A**

Run:
```bash
git fetch origin main
git log --oneline -1 origin/main
git grep -n "OrgPurgeParticipantContributor\|definePermissionCatalogue\|MemberAdmission" origin/main -- src/modules/tenancy/index.ts src/modules/tenancy/application | head
git grep -n "tenancy_catalogue_orphan_keys\|is contributed twice" origin/main -- src/modules/tenancy | head
git switch -c sp4a-entitlements origin/main
```
Expected: `origin/main` chứa merge của PR 3A (các tên ở khối "Produces" của 3A có mặt; tên nào lệch thì dùng tên thật và ghi vào báo cáo), gồm Task 20b (R-X21: metric `tenancy_catalogue_orphan_keys`, key chỉ có ở DB là WARN) và registry quyền từ chối catalogue góp hai lần (0bcabd9). Thiếu Task 20b → dừng, báo controller: rolling deploy của 4A dựa vào nó (pod cũ khởi động lại sau migration 4A thấy `entitlements.read` chỉ ở DB). Làm trong worktree riêng theo skill `superpowers:using-git-worktrees` nếu phiên hiện tại đang ở worktree khác.

- [ ] **Step 1: Spike S4-T1 — viết test**

`test/integration/spike-sp4a/interceptor-scope.e2e.spec.ts`:
```ts
import {
  type CallHandler,
  Controller,
  type ExecutionContext,
  Get,
  type INestApplication,
  Injectable,
  Module,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { from, map, mergeMap, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { Db } from '../../../src/core/database/index.js';
import { TenancyPermissions } from '../../../src/modules/tenancy/permissions.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** Org mà interceptor thấy mỗi lần chạy: rỗng sau một request nghĩa là interceptor không chạy (guard đã chặn). */
const seen: string[] = [];

/** Giả `EntitlementInterceptor`: đọc org từ context và từ `app_current_org()` của câu SQL chạy trong interceptor. */
@Injectable()
class ScopeProbeInterceptor implements NestInterceptor {
  constructor(
    private readonly ctx: RequestContext,
    private readonly db: Db,
  ) {}
  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    const orgId = this.ctx.orgId() ?? null;
    seen.push(orgId ?? 'none');
    return from(this.db.execute<{ org: string | null }>('SELECT app_current_org()::text AS org')).pipe(
      mergeMap((rows) =>
        next.handle().pipe(map(() => ({ interceptorOrg: orgId, sqlOrg: rows[0]?.org ?? null, via: this.ctx.orgAccess()?.via ?? null }))),
      ),
    );
  }
}

@Controller('v1/orgs/:orgId/spike')
class SpikeController {
  @Get('guard-first')
  @TenancyPermissions.require('org.delete')
  @UseInterceptors(ScopeProbeInterceptor)
  guardFirst() {
    return {};
  }
  @Get('interceptor-first')
  @UseInterceptors(ScopeProbeInterceptor)
  @TenancyPermissions.require('org.delete')
  interceptorFirst() {
    return {};
  }
}
@Module({ controllers: [SpikeController], providers: [ScopeProbeInterceptor] })
class SpikeModule {}

describe('spike S4-T1: a route-scoped interceptor runs after PoliciesGuard and inside OrgScope (spec SP4 §5)', () => {
  let app: INestApplication;
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [SpikeModule] });
    owner = await seedUserPrincipal();
    member = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals([owner, member]);
  });

  it.each(['guard-first', 'interceptor-first'])('%s: a member without org.delete gets 403 forbidden and the interceptor never runs', async (route) => {
    seen.length = 0;
    const r = await authed(app, member).get(`/v1/orgs/${org.orgId}/spike/${route}`);
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(seen).toEqual([]);
  });
  it.each(['guard-first', 'interceptor-first'])('%s: for the owner the interceptor sees the path org in the context and in SQL', async (route) => {
    const r = await authed(app, owner).get(`/v1/orgs/${org.orgId}/spike/${route}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ interceptorOrg: org.orgId, sqlOrg: org.orgId, via: 'MEMBERSHIP' });
  });
});
```

- [ ] **Step 2: Chạy S4-T1**

Run: `pnpm vitest run --project integration test/integration/spike-sp4a/interceptor-scope.e2e.spec.ts`
Expected: PASS 4/4 (guard chạy trước mọi interceptor bất kể thứ tự decorator; `OrgScopeInterceptor` global bọc interceptor route-scoped nên `app_current_org()` = org trên path). Nếu ca owner đỏ vì `sqlOrg` là `null`/lỗi `org context is not set`: **không đạt** → ghi vào ADR và các task sau dùng fallback của spec §5 (Task 6 Step 5: `EntitlementInterceptor` gọi `OrgScope.run(ctx.orgId(), …)` quanh việc đọc snapshot; `OrgScope` cho vào lại cùng org). Nếu ca member đỏ (interceptor chạy trước guard): dừng, báo Sếp (S4-D7 sai).

- [ ] **Step 3: Spike S4-T3 — viết test**

`test/integration/spike-sp4a/org-creation-hook.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { Db, UnitOfWork } from '../../../src/core/database/index.js';
import { SqlRoleRepository } from '../../../src/modules/tenancy/infra/sql/sql-role.repository.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, inOrgTx, purgeOrgs, withAppClient } from '../../support/tenancy-seed.js';

type Seen = { inTx: boolean; orgId: string | undefined; members: number };

/**
 * Chỗ participant của SP4 sẽ đứng (spec SP4 §22.2 T1): ngay SAU `insertSystemRoles` và TRƯỚC `MemberAdmission` trong
 * `OrgService.create`. Spike bọc `insertSystemRoles` để chạy "participant" ở đúng chỗ đó mà chưa sửa tenancy.
 */
describe('spike S4-T3: a participant can run inside the org-creation transaction, before the creator is admitted (spec SP4 §5)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  const seen: Seen[] = [];
  const created: string[] = [];
  let throwNext = false;
  beforeAll(async () => {
    const original = SqlRoleRepository.prototype.insertSystemRoles;
    vi.spyOn(SqlRoleRepository.prototype, 'insertSystemRoles').mockImplementation(async function (this: SqlRoleRepository) {
      const roles = await original.call(this);
      const db = app.get(Db);
      const [m] = await db.execute<{ n: number }>('SELECT count(*)::int AS n FROM org_members WHERE org_id = app_current_org()');
      seen.push({ inTx: app.get(UnitOfWork).inTransaction(), orgId: app.get(RequestContext).orgId(), members: m?.n ?? -1 });
      await db.execute(`INSERT INTO fixture_org_items (org_id, body) VALUES (app_current_org(), 'spike')`);
      if (throwNext) throw new Error('spike participant failure');
      return roles;
    });
    app = await startTenancyApp();
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const id of created)
      await withAppClient((c) => inOrgTx(c, id, () => c.query('DELETE FROM fixture_org_items WHERE org_id = app_current_org()')));
    await purgeOrgs(created);
    await deleteTenancyUsersOf([p.authUserId]);
    await app?.close();
    await deleteSeededPrincipals([p]);
  });

  it('runs in the transaction and OrgScope of the new org, with no member yet; its row commits with the org', async () => {
    const r = await authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${randomUUID()}`).send({ name: 'Spike T3' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    expect(seen.at(-1)).toEqual({ inTx: true, orgId: r.body.id, members: 0 });
    const rows = await withAppClient((c) => inOrgTx(c, r.body.id, async () => (await c.query('SELECT body FROM fixture_org_items')).rows));
    expect(rows).toEqual([{ body: 'spike' }]);
  });
  it('a throwing participant leaves no organization behind', async () => {
    throwNext = true;
    try {
      const r = await authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${randomUUID()}`).send({ name: 'Spike T3 fail' });
      expect(r.status).toBe(500);
    } finally {
      throwNext = false;
    }
    const id = seen.at(-1)?.orgId;
    if (!id) throw new Error('the hook did not run');
    const n = await withAppClient((c) => inOrgTx(c, id, async () => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations')).rows[0]?.n));
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 4: Chạy S4-T3**

Run: `pnpm vitest run --project integration test/integration/spike-sp4a/org-creation-hook.e2e.spec.ts`
Expected: PASS 2/2 (hook thấy `inTransaction() === true`, `ctx.orgId()` = id org mới, `org_members` = 0; dòng con có FK tới `organizations` chèn được trước COMMIT dưới FORCE RLS và trigger hoãn `organizations_bootstrap_ck` vẫn đạt; ném → không có org). Đỏ ở bất kỳ ca nào: **dừng, báo Sếp** (S4-D9 không còn đúng; spec §5 không có fallback).

- [ ] **Step 5: Khung ADR 0018 với kết quả spike**

`docs/adr/0018-entitlements-in-code.md`:
```markdown
# 0018 — Entitlements: catalogue và gói trong code, bộ đếm theo kỳ, không cache ở v1

- Trạng thái: Đề xuất (plan 4A đang thực thi; chuyển "Chấp nhận" ở Task 14)
- Ngày: <ngày chạy spike>
- Spec: [SP4](../superpowers/specs/2026-09-28-sp4-entitlements-design.md) r2 (chốt 2026-09-29, sửa §10.2 bước 2 sau review plan 4A); phán quyết R-X1…R-X24.

## Kết quả spike (plan 4A)

Chạy trên nhánh của plan 4A (sau khi 3A merge), hạ tầng Testcontainers của repo (Postgres 18, PgBouncer, Redis, Mailpit), Nest 12.1, Express 5.2.1. S4-T2 thuộc 4B (review money-security r1 đã chạy đạt trên PG 18.6; 4B giữ làm test hồi quy QU-2).

| # | Câu hỏi (spec §5) | Kết quả | Bằng chứng |
|---|---|---|---|
| S4-T1 | Interceptor route-scoped chạy sau `PoliciesGuard` bất kể thứ tự decorator, và bên trong `OrgScope.run` của `OrgScopeInterceptor` | <Đạt/Không đạt: output rút gọn> | spike `interceptor-scope.e2e.spec.ts` (không commit); giữ thành test HT-1 ở Task 10 |
| S4-T3 | Participant chạy trong transaction tạo org, sau 3 role hệ thống, trước `MemberAdmission`, trong `OrgScope(newId)`; ném → không có org | <Đạt/Không đạt: output rút gọn> | spike `org-creation-hook.e2e.spec.ts` (không commit); giữ thành test ở Task 2 |
```
Thay `<ngày chạy spike>` và hai ô `<…>` bằng kết quả thật của Step 2 và Step 4 (đây là dữ liệu của lần chạy, không phải chỗ trống của thiết kế).

- [ ] **Step 6: Xoá code spike, commit ADR**

Run:
```bash
rm -rf test/integration/spike-sp4a
git status --short
git add docs/adr/0018-entitlements-in-code.md
git commit -m "docs(entitlements): ADR 0018 skeleton with the S4-T1 and S4-T3 spike results"
```
Expected: `git status` trước `add` chỉ có ADR 0018 (thư mục spike đã xoá, không file tạm).

---

## Phần B — Sửa tenancy cho SP4 (spec §22.2 T1, T2)

### Task 2: Port `OrgCreationParticipant` + registry Discovery, `OrgService.create` gọi participant trong transaction tạo org; `classifyTenantHandler`; kiểm chứng prod-like #1

**Files:**
- Create: `src/modules/tenancy/ports/org-creation-participant.ts`, `src/modules/tenancy/application/org-creation-participant.registry.ts`
- Create (test): `test/unit/modules/tenancy/org-creation-participant-registry.spec.ts`, `test/unit/modules/tenancy/classify-tenant-handler.spec.ts`, `test/e2e/tenancy/org-creation-participants.e2e.spec.ts`
- Modify: `src/modules/tenancy/application/org.service.ts`, `src/modules/tenancy/http/org-route.ts`, `src/modules/tenancy/tenancy.module.ts`, `src/modules/tenancy/index.ts`

**Interfaces:**
- Consumes (3A): `OrgService.create` (Task 23: `upsertAndLock` → `countCreatedBy` → `insertCurrent` → `insertSystemRoles` → `admission.admit` → `OrgCreatedEvent`, trong `scope.run(id, () => uow.run(…))`), `userActor(ctx)`, `TenancyCoreModule` (`@Global`), `routeTemplateOf`, `classifyOrgRoute`, `type OrgRouteKind` (`http/org-route.ts`), `OrgPurgeParticipantRegistry` (mẫu để chép), `EventActor` (core/events).
- Produces (export ở `modules/tenancy/index.ts`, sổ export L1):
  - `abstract class OrgCreationParticipant { abstract onOrgCreated(orgId: string, actor: EventActor): Promise<void> }`, `type OrgCreationParticipantMeta = { key: string; order: number }`.
  - `OrgCreationParticipantContributor({ key, order })` (marker Discovery), `OrgCreationParticipantRegistry.participants(): readonly RegisteredCreationParticipant[]` (`{ key; order; participant }`, sắp theo `order` rồi `key`; key sai mẫu, `order` không nguyên, trùng `key`, trùng `order`, provider không phải singleton kế thừa `OrgCreationParticipant` → ném lúc boot). Registry ở `TenancyCoreModule` (api + worker).
  - `OrgService.create` gọi mọi participant theo thứ tự **sau** INSERT org + 3 role hệ thống, **trước** `MemberAdmission` của người tạo, cùng transaction và `OrgScope(newId)`, truyền `actor` của thao tác tạo org.
  - `classifyTenantHandler(controller: Function, handler: Function): OrgRouteKind` (`'TENANT'` khi mọi template của handler là tenant; có template `INVALID` → `'INVALID'`; còn lại `'OTHER'`).
- **Lệch có chủ đích so với spec T1:** chữ ký `onOrgCreated(orgId, actor)` thay vì `onOrgCreated(orgId)`: spec §10.4 đòi event `plan.changed` của participant mang "actor của thao tác tạo org", mà chỉ `OrgService` biết actor đó (job tạo org không có principal trong context). Thêm tham số là thay đổi cộng thêm, không ai khác dùng port này.

- [ ] **Step 1: Test registry và bộ phân loại (fail)**

`test/unit/modules/tenancy/org-creation-participant-registry.spec.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  OrgCreationParticipantContributor,
  OrgCreationParticipantRegistry,
} from '../../../../src/modules/tenancy/application/org-creation-participant.registry.js';
import { OrgCreationParticipant } from '../../../../src/modules/tenancy/ports/org-creation-participant.js';

class Noop extends OrgCreationParticipant {
  onOrgCreated(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable() @OrgCreationParticipantContributor({ key: 'second', order: 10 }) class Second extends Noop {}
@Injectable() @OrgCreationParticipantContributor({ key: 'first', order: 0 }) class First extends Noop {}
@Injectable() @OrgCreationParticipantContributor({ key: 'first', order: 5 }) class FirstAgain extends Noop {}
@Injectable() @OrgCreationParticipantContributor({ key: 'other', order: 0 }) class SameOrder extends Noop {}
@Injectable() @OrgCreationParticipantContributor({ key: 'Bad Key', order: 1 }) class BadKey extends Noop {}
@Injectable() @OrgCreationParticipantContributor({ key: 'half', order: 1.5 }) class HalfOrder extends Noop {}
@Injectable() @OrgCreationParticipantContributor({ key: 'broken', order: 1 }) class NotAParticipant {}
@Module({ providers: [Second] }) class ModA {}
@Module({ providers: [First] }) class ModB {}

const boot = async (imports: NonNullable<Parameters<typeof Test.createTestingModule>[0]['imports']>) => {
  const ref = await Test.createTestingModule({ imports: [DiscoveryModule, ...imports], providers: [OrgCreationParticipantRegistry] }).compile();
  await ref.init();
  return ref;
};

describe('OrgCreationParticipantRegistry (spec SP4 §22.2 T1)', () => {
  it('collects participants from two modules and orders them by order then key', async () => {
    const ref = await boot([ModA, ModB]);
    expect(ref.get(OrgCreationParticipantRegistry).participants().map((p) => [p.key, p.order])).toEqual([
      ['first', 0],
      ['second', 10],
    ]);
    await ref.close();
  });
  it('refuses a duplicate key, a duplicate order, a malformed key, a non-integer order and a non-participant', async () => {
    await expect(boot([ModB, { module: class Dup {}, providers: [FirstAgain] }])).rejects.toThrow(/Duplicate org creation participant key "first"/);
    await expect(boot([ModB, { module: class Same {}, providers: [SameOrder] }])).rejects.toThrow(/Duplicate org creation participant order 0/);
    await expect(boot([{ module: class K {}, providers: [BadKey] }])).rejects.toThrow(/needs \{ key: /);
    await expect(boot([{ module: class H {}, providers: [HalfOrder] }])).rejects.toThrow(/needs \{ key: /);
    await expect(boot([{ module: class N {}, providers: [NotAParticipant] }])).rejects.toThrow(/must be a singleton provider extending OrgCreationParticipant/);
  });
});
```

`test/unit/modules/tenancy/classify-tenant-handler.spec.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { classifyTenantHandler } from '../../../../src/modules/tenancy/index.js';

@Controller('v1/orgs/:orgId/things') class Tenant { @Get() list() {} }
@Controller(['v1/orgs/:orgId/a', 'v1/public/a']) class Mixed { @Get() list() {} }
@Controller('v1/orgs/:id/things') class WrongParam { @Get() list() {} }
@Controller('v1/elsewhere') class Other { @Get() list() {} }

describe('classifyTenantHandler (spec SP4 §22.2 T2): the same matcher as OrgRouteInventory', () => {
  it.each([
    [Tenant, 'TENANT'],
    [Mixed, 'OTHER'],
    [WrongParam, 'INVALID'],
    [Other, 'OTHER'],
  ] as const)('%o → %s', (ctl, kind) => {
    expect(classifyTenantHandler(ctl, ctl.prototype.list)).toBe(kind);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/org-creation-participant-registry.spec.ts test/unit/modules/tenancy/classify-tenant-handler.spec.ts`
Expected: FAIL (`Cannot find module …/org-creation-participant.registry.js`, `classifyTenantHandler` không phải export).

- [ ] **Step 2: Port, registry, bộ phân loại**

`src/modules/tenancy/ports/org-creation-participant.ts`:
```ts
import type { EventActor } from '../../../core/events/index.js';

/**
 * Bên tham gia tạo org (spec SP4 §22.2 T1, S4-D9): chạy TRONG transaction tạo org, trong `OrgScope(newId)`, SAU khi dòng
 * `organizations` + 3 role hệ thống đã chèn và TRƯỚC `MemberAdmission` của người tạo. Chỉ ghi DB của mình (không I/O
 * ngoài, event đi outbox cùng transaction); ném → không có org. `actor` là actor của thao tác tạo org.
 */
export abstract class OrgCreationParticipant {
  abstract onOrgCreated(orgId: string, actor: EventActor): Promise<void>;
}
export type OrgCreationParticipantMeta = { key: string; order: number };
```
`src/modules/tenancy/application/org-creation-participant.registry.ts`:
```ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { OrgCreationParticipant, type OrgCreationParticipantMeta } from '../ports/org-creation-participant.js';

export const OrgCreationParticipantContributor = DiscoveryService.createDecorator<OrgCreationParticipantMeta>();
export type RegisteredCreationParticipant = { key: string; order: number; participant: OrgCreationParticipant };
const PARTICIPANT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/** Cùng mẫu `OrgPurgeParticipantRegistry` (3A Task 19), thêm luật `order` duy nhất: thứ tự chạy không được phụ thuộc tên. */
@Injectable()
export class OrgCreationParticipantRegistry implements OnModuleInit {
  private registered: readonly RegisteredCreationParticipant[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const found: RegisteredCreationParticipant[] = [];
    for (const wrapper of this.discovery.getProviders({ metadataKey: OrgCreationParticipantContributor.KEY })) {
      const meta = this.discovery.getMetadataByDecorator(OrgCreationParticipantContributor, wrapper);
      if (!meta || !PARTICIPANT_KEY_PATTERN.test(meta.key) || !Number.isInteger(meta.order))
        throw new Error(`@OrgCreationParticipantContributor on ${wrapper.name} needs { key: ${PARTICIPANT_KEY_PATTERN}, order: integer }`);
      if (!wrapper.isDependencyTreeStatic() || !(wrapper.instance instanceof OrgCreationParticipant))
        throw new Error(`Org creation participant "${meta.key}" must be a singleton provider extending OrgCreationParticipant`);
      if (found.some((p) => p.key === meta.key)) throw new Error(`Duplicate org creation participant key "${meta.key}"`);
      if (found.some((p) => p.order === meta.order)) throw new Error(`Duplicate org creation participant order ${meta.order} ("${meta.key}")`);
      found.push({ key: meta.key, order: meta.order, participant: wrapper.instance });
    }
    this.registered = found.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }

  participants(): readonly RegisteredCreationParticipant[] {
    return this.registered;
  }
}
```
`src/modules/tenancy/http/org-route.ts` — thêm cuối file:
```ts
/**
 * Bộ phân loại route tenant cho inventory của module khác (spec SP4 §22.2 T2): CÙNG matcher với `OrgRouteInventory`
 * (INT-I5). Một handler có nhiều template (tích path class × method): `TENANT` chỉ khi MỌI template là tenant (mọi
 * biến thể của route đều có org context); có một template `INVALID` → `INVALID`; còn lại `OTHER`.
 */
export function classifyTenantHandler(controller: Function, handler: Function): OrgRouteKind {
  const kinds = routeTemplateOf(controller, handler).map(classifyOrgRoute);
  if (kinds.includes('INVALID')) return 'INVALID';
  return kinds.length > 0 && kinds.every((k) => k === 'TENANT') ? 'TENANT' : 'OTHER';
}
```
`src/modules/tenancy/tenancy.module.ts`: `TenancyCoreModule` thêm `OrgCreationParticipantRegistry` vào `providers` và `exports` (import từ `./application/org-creation-participant.registry.js`).
`src/modules/tenancy/index.ts` thêm:
```ts
export {
  OrgCreationParticipantContributor,
  OrgCreationParticipantRegistry,
} from './application/org-creation-participant.registry.js';
export { OrgCreationParticipant } from './ports/org-creation-participant.js';
export { classifyTenantHandler, type OrgRouteKind } from './http/org-route.js';
```
Run: lệnh của Step 1.
Expected: PASS.

- [ ] **Step 3: E2E — participant trong transaction tạo org (giữ spike S4-T3 thành test; fail)**

`test/e2e/tenancy/org-creation-participants.e2e.spec.ts`:
```ts
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { Db, UnitOfWork } from '../../../src/core/database/index.js';
import type { EventActor } from '../../../src/core/events/index.js';
import { OrgCreationParticipant, OrgCreationParticipantContributor } from '../../../src/modules/tenancy/index.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, inOrgTx, purgeOrgs, withAppClient } from '../../support/tenancy-seed.js';

type Call = { orgId: string; actor: EventActor; inTx: boolean; ctxOrg: string | undefined; members: number };
const calls: Call[] = [];
let throwNext = false;

/** Participant fixture (vai của entitlements): ghi một dòng có FK tới org, cùng transaction. */
@Injectable()
@OrgCreationParticipantContributor({ key: 'fixture.items', order: 0 })
class FixtureItemsParticipant extends OrgCreationParticipant {
  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
  ) {
    super();
  }
  async onOrgCreated(orgId: string, actor: EventActor): Promise<void> {
    const [m] = await this.db.execute<{ n: number }>('SELECT count(*)::int AS n FROM org_members WHERE org_id = app_current_org()');
    calls.push({ orgId, actor, inTx: this.uow.inTransaction(), ctxOrg: this.ctx.orgId(), members: m?.n ?? -1 });
    await this.db.execute(`INSERT INTO fixture_org_items (org_id, body) VALUES (app_current_org(), 'participant')`);
    if (throwNext) throw new Error('fixture participant failure');
  }
}
@Module({ providers: [FixtureItemsParticipant] })
class FixtureParticipantModule {}

describe('org creation participants (spec SP4 §22.2 T1, S4-T3 kept as a test)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  const created: string[] = [];
  const itemsOf = (orgId: string) =>
    withAppClient((c) => inOrgTx(c, orgId, async () => (await c.query<{ body: string }>('SELECT body FROM fixture_org_items')).rows));
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [FixtureParticipantModule] });
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    for (const id of created)
      await withAppClient((c) => inOrgTx(c, id, () => c.query('DELETE FROM fixture_org_items WHERE org_id = app_current_org()')));
    await purgeOrgs(created);
    await deleteTenancyUsersOf([p.authUserId]);
    await app?.close();
    await deleteSeededPrincipals([p]);
  });

  it('runs once, inside the transaction and OrgScope of the new org, before the creator is admitted, with the creator as actor', async () => {
    const r = await authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${randomUUID()}`).send({ name: 'Participant' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    expect(calls).toEqual([{ orgId: r.body.id, actor: { type: 'user', id: p.authUserId }, inTx: true, ctxOrg: r.body.id, members: 0 }]);
    expect(await itemsOf(r.body.id)).toEqual([{ body: 'participant' }]);
  });
  it('a throwing participant rolls the whole creation back: 500, no organization, no participant row', async () => {
    throwNext = true;
    try {
      const r = await authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${randomUUID()}`).send({ name: 'Participant fails' });
      expect(r.status).toBe(500);
    } finally {
      throwNext = false;
    }
    const id = calls.at(-1)?.orgId;
    if (!id) throw new Error('participant did not run');
    const n = await withAppClient((c) => inOrgTx(c, id, async () => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations')).rows[0]?.n));
    expect(n).toBe(0);
    expect(await itemsOf(id)).toEqual([]);
  });
});
```
Run: `pnpm vitest run --project integration test/e2e/tenancy/org-creation-participants.e2e.spec.ts`
Expected: FAIL (`calls` rỗng: `OrgService.create` chưa gọi participant).

- [ ] **Step 4: `OrgService.create` gọi participant**

`src/modules/tenancy/application/org.service.ts`:
1. Import `OrgCreationParticipantRegistry` từ `./org-creation-participant.registry.js`.
2. Constructor thêm tham số cuối `private readonly creationParticipants: OrgCreationParticipantRegistry`.
3. Trong `create`, giữa `const roles = await this.roles.insertSystemRoles();` và `await this.admission.admit(…)`:
```ts
        // SP4 T1 (S4-D9): participant (vd. entitlements) ghi dòng của mình trong CÙNG transaction và OrgScope, trước khi
        // người tạo vào org (ghế của 4B đọc được gói ngay lúc admit người tạo). Participant ném → cả lần tạo rollback.
        for (const p of this.creationParticipants.participants()) await p.participant.onOrgCreated(org.id, actor);
```
Run: `pnpm vitest run --project integration test/e2e/tenancy/org-creation-participants.e2e.spec.ts test/e2e/tenancy/orgs.e2e.spec.ts test/e2e/tenancy/org-lifecycle.e2e.spec.ts`
Expected: PASS (participant chạy đúng chỗ; e2e tạo org của 3A không đổi hành vi khi không có participant nào).

- [ ] **Step 5: Kiểm toàn cục và prod-like #1 (tenancy trên image thật)**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/tenancy test/integration/tenancy
pnpm test:smoke
```
Expected: xanh. `pnpm test:smoke`: image production thật, `compose --profile app`, `NODE_ENV=production`, smoke `tenancy.smoke.spec.ts` của 3A (đăng ký → tạo org → … → xoá tài khoản) PASS trên code có vòng lặp participant rỗng; log api/worker JSON sạch; `/health/ready` 200; teardown sạch.

- [ ] **Step 6: Commit**

```bash
git add src/modules/tenancy test/unit/modules/tenancy/org-creation-participant-registry.spec.ts test/unit/modules/tenancy/classify-tenant-handler.spec.ts test/e2e/tenancy/org-creation-participants.e2e.spec.ts
git commit -m "feat(tenancy): org creation participants run inside the creation transaction before the creator is admitted; export classifyTenantHandler"
```

---
## Phần C — Miền entitlements thuần (spec §8.1, §8.2, §8.4, §9.4, §10.2 bước 3, §11)

Hai task thuần (không Nest, không DB). Mọi file mới đều import `constants.ts` hoặc nhau, nên không file nào là "orphan" theo định nghĩa của dependency-cruiser (không phụ thuộc vào lẫn ra); `rules.spec.ts` ("real source tree has no violations") xanh mà không cần ngoại lệ.

### Task 3: Hằng định dạng, catalogue tính năng (gộp + kiểm EC-1…EC-6) và catalogue gói (kiểm EC-7, danh sách `fallback` EC-8)

**Files:**
- Create: `src/modules/entitlements/constants.ts`, `src/modules/entitlements/domain/feature-catalogue.ts`, `src/modules/entitlements/domain/plan-catalogue.ts`
- Create (test): `test/unit/modules/entitlements/feature-catalogue.spec.ts`, `test/unit/modules/entitlements/plan-catalogue.spec.ts`

**Interfaces:**
- Consumes: không.
- Produces:
  - `constants.ts`: `ENTITLEMENT_VALUE_MAX = Number.MAX_SAFE_INTEGER` (9007199254740991), `FEATURE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,47}$/`, `PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/`, `REASON_MAX_LENGTH = 500`, `SOURCE_REF_MAX_LENGTH = 128`, `ENTITLEMENTS_PURGE_ORDER = 100`, `PLAN_SOURCES = ['DEFAULT', 'BILLING', 'PLATFORM_ADMIN'] as const`, `type PlanSource`.
  - `domain/feature-catalogue.ts`: `FEATURE_KINDS`, `type FeatureKind`, `RESET_PERIODS`, `type ResetPeriod`, `UNLIMITED: unique symbol`, `type NumericValue = { readonly max: number } | typeof UNLIMITED`, `type FlagFeatureDef | LimitFeatureDef | QuotaFeatureDef = FeatureDef`, `type FeatureCatalogueDef = Readonly<Record<string, FeatureDef>>`, `type FeatureCatalogueData<D> = { features: D; keys: readonly Extract<keyof D, string>[] }`, `featureCatalogueData(features)`, `type FeatureEntry` (chuẩn hoá: `minimum` luôn có với LIMIT/QUOTA, `deprecated: boolean`), `type MergedFeatures = ReadonlyMap<string, FeatureEntry>`, `featureCatalogueProblems(defs): string[]`, `mergeFeatureCatalogues(defs): MergedFeatures` (ném `FeatureCatalogueError { problems }`), `isCount(n, min?)`, `isNumericValue(v)`.
  - `domain/plan-catalogue.ts`: `type PlanValue = boolean | NumericValue`, `type PlanCatalogueDef`, `type PlanEntry = { key; retired; values: ReadonlyMap<string, PlanValue> }`, `type PlanCatalogue = { defaultPlan: string; plans: ReadonlyMap<string, PlanEntry> }`, `definePlanCatalogue(def): PlanCatalogue` (chỉ chuẩn hoá, không ném), `validatePlanCatalogue(catalogue, features): string[]`, `fallbackUsage(catalogue, features): Record<string, string[]>`, `class PlanCatalogueError { problems }`.

- [ ] **Step 1: Test catalogue tính năng (fail)**

`test/unit/modules/entitlements/feature-catalogue.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_VALUE_MAX, FEATURE_KEY_PATTERN } from '../../../../src/modules/entitlements/constants.js';
import {
  FeatureCatalogueError,
  UNLIMITED,
  featureCatalogueData,
  featureCatalogueProblems,
  mergeFeatureCatalogues,
  type FeatureDef,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';

/** Dựng catalogue một mục từ giá trị bất kỳ: mô phỏng code JS hoặc cast của dự án vượt qua kiểu. */
const one = (key: string, f: unknown) => featureCatalogueData({ [key]: f as FeatureDef });

describe('feature catalogue (spec SP4 §8.1, EC-1…EC-6)', () => {
  it('a well-formed catalogue of the three kinds merges and is normalised', () => {
    const merged = mergeFeatureCatalogues([
      featureCatalogueData({
        'reports.export': { kind: 'FLAG', fallback: false },
        'reports.scheduled': { kind: 'LIMIT', fallback: { max: 0 } },
        'reports.api_calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: UNLIMITED, minimum: 1 },
        'reports.legacy_pdf': { kind: 'FLAG', fallback: false, deprecated: true },
      }),
    ]);
    expect(merged.get('reports.export')).toEqual({ key: 'reports.export', kind: 'FLAG', fallback: false, deprecated: false });
    expect(merged.get('reports.scheduled')).toEqual({ key: 'reports.scheduled', kind: 'LIMIT', fallback: { max: 0 }, minimum: 0, deprecated: false });
    expect(merged.get('reports.api_calls')).toEqual({ key: 'reports.api_calls', kind: 'QUOTA', resetPeriod: 'MONTH', fallback: UNLIMITED, minimum: 1, deprecated: false });
    expect(merged.get('reports.legacy_pdf')?.deprecated).toBe(true);
  });
  it.each(['Reports.export', 'reports', 'reports.', '1x.y', 'x.Y', 'x.y.z', `${'a'.repeat(33)}.b`, `a.${'b'.repeat(49)}`])(
    'EC-1: key %j does not match FEATURE_KEY_PATTERN',
    (key) => {
      expect(featureCatalogueProblems([one(key, { kind: 'FLAG', fallback: false })])).toContain(
        `"${key}": key must match ${FEATURE_KEY_PATTERN.source} (<module>.<name>)`,
      );
    },
  );
  it('EC-2: the same key in two catalogues refuses the merge', () => {
    const a = one('x.flag', { kind: 'FLAG', fallback: false });
    const b = one('x.flag', { kind: 'FLAG', fallback: true });
    expect(featureCatalogueProblems([a, b])).toContain('duplicate feature key "x.flag" in two catalogues');
    expect(() => mergeFeatureCatalogues([a, b])).toThrow(FeatureCatalogueError);
  });
  it.each([
    ['FLAG with a numeric fallback', { kind: 'FLAG', fallback: { max: 1 } }, '"x.y": a FLAG fallback must be a boolean'],
    ['LIMIT with a boolean fallback', { kind: 'LIMIT', fallback: true }, `"x.y": fallback must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`],
    ['LIMIT with a fractional max', { kind: 'LIMIT', fallback: { max: 1.5 } }, `"x.y": fallback must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`],
    ['LIMIT with an extra field', { kind: 'LIMIT', fallback: { max: 1, min: 0 } }, `"x.y": fallback must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`],
  ])('EC-3: %s', (_, f, problem) => {
    expect(featureCatalogueProblems([one('x.y', f)])).toContain(problem);
  });
  it('EC-4: QUOTA without (or with an unknown) resetPeriod', () => {
    expect(featureCatalogueProblems([one('x.y', { kind: 'QUOTA', fallback: { max: 1 } })])).toContain('"x.y": QUOTA needs resetPeriod NONE or MONTH');
    expect(featureCatalogueProblems([one('x.y', { kind: 'QUOTA', resetPeriod: 'DAY', fallback: { max: 1 } })])).toContain('"x.y": QUOTA needs resetPeriod NONE or MONTH');
  });
  it('EC-5: FLAG or LIMIT declaring resetPeriod; FLAG declaring minimum', () => {
    expect(featureCatalogueProblems([one('x.y', { kind: 'FLAG', fallback: true, resetPeriod: 'MONTH' })])).toContain('"x.y": only QUOTA declares resetPeriod');
    expect(featureCatalogueProblems([one('x.y', { kind: 'LIMIT', fallback: { max: 1 }, resetPeriod: 'NONE' })])).toContain('"x.y": only QUOTA declares resetPeriod');
    expect(featureCatalogueProblems([one('x.y', { kind: 'FLAG', fallback: true, minimum: 0 })])).toContain('"x.y": only LIMIT and QUOTA declare minimum');
  });
  it('EC-6: minimum above the fallback, or a minimum that is not a count', () => {
    expect(featureCatalogueProblems([one('x.y', { kind: 'LIMIT', fallback: { max: 0 }, minimum: 1 })])).toContain('"x.y": fallback 0 is below minimum 1');
    expect(featureCatalogueProblems([one('x.y', { kind: 'LIMIT', fallback: UNLIMITED, minimum: -1 })])).toContain(
      `"x.y": minimum must be an integer in [0, ${ENTITLEMENT_VALUE_MAX}]`,
    );
    expect(featureCatalogueProblems([one('x.y', { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 })])).toEqual([]);
  });
  it('an unknown kind is reported, never silently dropped', () => {
    expect(featureCatalogueProblems([one('x.y', { kind: 'COUNTER', fallback: 1 })]).join('\n')).toMatch(/"x\.y": unknown kind/);
  });
  it('ENTITLEMENT_VALUE_MAX is 2^53 − 1, the CHECK bound of the migrations', () => {
    expect(ENTITLEMENT_VALUE_MAX).toBe(9_007_199_254_740_991);
  });
});
```

- [ ] **Step 2: Test catalogue gói (fail)**

`test/unit/modules/entitlements/plan-catalogue.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_VALUE_MAX } from '../../../../src/modules/entitlements/constants.js';
import { UNLIMITED, featureCatalogueData, mergeFeatureCatalogues } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  definePlanCatalogue,
  fallbackUsage,
  validatePlanCatalogue,
  type PlanValue,
} from '../../../../src/modules/entitlements/domain/plan-catalogue.js';

const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 0 } },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
  }),
]);
const withValue = (key: string, value: unknown) =>
  definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: { [key]: value as PlanValue } } } });

describe('plan catalogue (spec SP4 §8.2, EC-7, EC-8)', () => {
  it('a valid catalogue has no problem', () => {
    const plans = definePlanCatalogue({
      defaultPlan: 'free',
      plans: {
        free: { values: {} },
        pro: { values: { 'x.flag': true, 'x.seats': { max: 10 }, 'x.calls': UNLIMITED } },
        legacy: { retired: true, values: { 'x.flag': true } },
      },
    });
    expect(validatePlanCatalogue(plans, features)).toEqual([]);
    expect(plans.plans.get('legacy')?.retired).toBe(true);
    expect(plans.plans.get('pro')?.values.get('x.seats')).toEqual({ max: 10 });
  });
  it.each([
    ['unknown feature', withValue('x.nope', true), 'plan "free": unknown feature "x.nope"'],
    ['deprecated feature', withValue('x.old', true), 'plan "free": feature "x.old" is deprecated'],
    ['FLAG given a number', withValue('x.flag', { max: 1 }), 'plan "free": "x.flag" is a FLAG and needs true or false'],
    ['LIMIT given a boolean', withValue('x.seats', true), `plan "free": "x.seats" needs UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`],
    ['below minimum', withValue('x.seats', { max: 0 }), 'plan "free": "x.seats" max 0 is below minimum 1'],
  ])('EC-7: %s', (_, plans, problem) => {
    expect(validatePlanCatalogue(plans, features)).toContain(problem);
  });
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -1])(
    'Review Focus 1: validatePlanCatalogue rejects non-integer, non-finite and out-of-range numbers (%s)',
    (max) => {
      expect(validatePlanCatalogue(withValue('x.calls', { max }), features)).toEqual([
        `plan "free": "x.calls" needs UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`,
      ]);
    },
  );
  it('EC-7: bad plan key, missing default plan, retired default plan', () => {
    expect(validatePlanCatalogue(definePlanCatalogue({ defaultPlan: 'Free', plans: { Free: { values: {} } } }), features)).toContain(
      'plan "Free": key must match ^[a-z][a-z0-9_]{0,31}$',
    );
    expect(validatePlanCatalogue(definePlanCatalogue({ defaultPlan: 'gold', plans: { free: { values: {} } } }), features)).toContain(
      'defaultPlan "gold" is not a declared plan',
    );
    expect(
      validatePlanCatalogue(definePlanCatalogue({ defaultPlan: 'free', plans: { free: { retired: true, values: {} } } }), features),
    ).toContain('defaultPlan "free" is retired');
  });
  it('EC-8: fallbackUsage lists, per plan, the active features the plan does not mention (sorted, deprecated excluded)', () => {
    const plans = definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: {} }, pro: { values: { 'x.flag': true } } } });
    expect(fallbackUsage(plans, features)).toEqual({ free: ['x.calls', 'x.flag', 'x.seats'], pro: ['x.calls', 'x.seats'] });
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/feature-catalogue.spec.ts test/unit/modules/entitlements/plan-catalogue.spec.ts`
Expected: FAIL (`Cannot find module …/constants.js`).

- [ ] **Step 3: Hằng và catalogue tính năng**

`src/modules/entitlements/constants.ts`:
```ts
/**
 * Hằng định dạng của SP4 (spec §3 mục 4, §14): dùng chung giữa zod và `CHECK` của migration (migration viết cứng cùng giá
 * trị; `schema.spec.ts` so hai phía). Không phải tunable, nên không nằm trong config.
 */
/** 2^53 − 1: số đếm/trần lớn nhất mà JSON số giữ chính xác (`CHECK … BETWEEN 0 AND 9007199254740991`). */
export const ENTITLEMENT_VALUE_MAX = Number.MAX_SAFE_INTEGER;
/** `<module>.<tên>`: `entitlement_features_key_ck`. */
export const FEATURE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,47}$/;
/** `plans_key_ck`. */
export const PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** `org_entitlements_reason_format_ck` (lý do của nhân viên, đếm code point như `char_length`). */
export const REASON_MAX_LENGTH = 500;
/** `org_entitlements_source_ref_length_ck` (id công khai của subscription SP5, opaque). */
export const SOURCE_REF_MAX_LENGTH = 128;
/** Registry `order` của participant xoá cứng (addendum 3D §A4, R-X5): entitlements = 100, trước tenancy core (1000). */
export const ENTITLEMENTS_PURGE_ORDER = 100;
/** Nguồn gán gói (`org_entitlements_source_ck`): enum, không phải cờ rời (spec §11). */
export const PLAN_SOURCES = ['DEFAULT', 'BILLING', 'PLATFORM_ADMIN'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];
```
`src/modules/entitlements/domain/feature-catalogue.ts`:
```ts
import { ENTITLEMENT_VALUE_MAX, FEATURE_KEY_PATTERN } from '../constants.js';

export const FEATURE_KINDS = ['FLAG', 'LIMIT', 'QUOTA'] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];
export const RESET_PERIODS = ['NONE', 'MONTH'] as const;
export type ResetPeriod = (typeof RESET_PERIODS)[number];

/** Giá trị "không giới hạn" của LIMIT/QUOTA trong catalogue (không phải số, nên không lẫn với một trần thật). */
export const UNLIMITED: unique symbol = Symbol('entitlements.unlimited');
export type NumericValue = { readonly max: number } | typeof UNLIMITED;

type Common = { readonly description?: string; readonly deprecated?: boolean };
export type FlagFeatureDef = Common & { readonly kind: 'FLAG'; readonly fallback: boolean };
export type LimitFeatureDef = Common & { readonly kind: 'LIMIT'; readonly fallback: NumericValue; readonly minimum?: number };
export type QuotaFeatureDef = Common & {
  readonly kind: 'QUOTA';
  readonly resetPeriod: ResetPeriod;
  readonly fallback: NumericValue;
  readonly minimum?: number;
};
export type FeatureDef = FlagFeatureDef | LimitFeatureDef | QuotaFeatureDef;
export type FeatureCatalogueDef = Readonly<Record<string, FeatureDef>>;
export type FeatureCatalogueData<D extends FeatureCatalogueDef = FeatureCatalogueDef> = {
  readonly features: D;
  readonly keys: readonly Extract<keyof D, string>[];
};
/** Mục đã chuẩn hoá của catalogue gộp: `minimum` luôn có với LIMIT/QUOTA (mặc định 0), `deprecated` luôn là boolean. */
export type FeatureEntry =
  | { readonly key: string; readonly kind: 'FLAG'; readonly fallback: boolean; readonly deprecated: boolean }
  | { readonly key: string; readonly kind: 'LIMIT'; readonly fallback: NumericValue; readonly minimum: number; readonly deprecated: boolean }
  | {
      readonly key: string;
      readonly kind: 'QUOTA';
      readonly resetPeriod: ResetPeriod;
      readonly fallback: NumericValue;
      readonly minimum: number;
      readonly deprecated: boolean;
    };
export type MergedFeatures = ReadonlyMap<string, FeatureEntry>;

export class FeatureCatalogueError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid feature catalogue: ${problems.join('; ')}`);
    this.name = 'FeatureCatalogueError';
  }
}

/** Khai báo `as const`: K là union key của CHÍNH catalogue (sai key ở `requireEnabled`/`key()` là lỗi compile). */
export function featureCatalogueData<const D extends FeatureCatalogueDef>(features: D): FeatureCatalogueData<D> {
  const keys = Object.keys(features).filter((k): k is Extract<keyof D, string> => k in features);
  return { features, keys };
}

/** Số nguyên an toàn trong `[min, ENTITLEMENT_VALUE_MAX]` (loại NaN, Infinity, số thập phân, số âm). */
export const isCount = (n: unknown, min = 0): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= ENTITLEMENT_VALUE_MAX;
/** `UNLIMITED` hoặc đúng một trường `max` (không nhận thêm trường: lỗi gõ `{ max: 1, min: 0 }` không lọt). */
export const isNumericValue = (v: unknown): v is NumericValue =>
  v === UNLIMITED || (typeof v === 'object' && v !== null && Object.keys(v).length === 1 && 'max' in v);

const numericMessage = `must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`;

function numericProblems(key: string, fallback: unknown, minimum: unknown): string[] {
  const out: string[] = [];
  const min = minimum ?? 0;
  if (!isCount(min)) out.push(`"${key}": minimum must be an integer in [0, ${ENTITLEMENT_VALUE_MAX}]`);
  if (fallback === UNLIMITED) return out;
  if (!isNumericValue(fallback) || fallback === UNLIMITED || !isCount(fallback.max)) out.push(`"${key}": fallback ${numericMessage}`);
  else if (isCount(min) && fallback.max < min) out.push(`"${key}": fallback ${fallback.max} is below minimum ${min}`);
  return out;
}

/** Kiểm từng mục ở runtime (dự án có thể viết JS hoặc cast): mọi vi phạm được liệt kê, không dừng ở cái đầu. */
function entryProblems(key: string, f: FeatureDef): string[] {
  switch (f.kind) {
    case 'FLAG':
      return [
        ...(typeof f.fallback === 'boolean' ? [] : [`"${key}": a FLAG fallback must be a boolean`]),
        ...('resetPeriod' in f ? [`"${key}": only QUOTA declares resetPeriod`] : []),
        ...('minimum' in f ? [`"${key}": only LIMIT and QUOTA declare minimum`] : []),
      ];
    case 'LIMIT':
      return [...numericProblems(key, f.fallback, f.minimum), ...('resetPeriod' in f ? [`"${key}": only QUOTA declares resetPeriod`] : [])];
    case 'QUOTA':
      return [
        ...numericProblems(key, f.fallback, f.minimum),
        ...((RESET_PERIODS as readonly unknown[]).includes(f.resetPeriod) ? [] : [`"${key}": QUOTA needs resetPeriod NONE or MONTH`]),
      ];
    default: {
      const unknownKind: never = f;
      return [`"${key}": unknown kind ${String(Reflect.get(unknownKind, 'kind'))}`];
    }
  }
}

/** Mọi vi phạm EC-1…EC-6 trên tập catalogue (spec §8.1 "Kiểm catalogue"). Rỗng = hợp lệ. */
export function featureCatalogueProblems(defs: readonly FeatureCatalogueData[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const def of defs)
    for (const key of Object.keys(def.features)) {
      const f = def.features[key];
      if (!f) continue;
      if (seen.has(key)) problems.push(`duplicate feature key "${key}" in two catalogues`);
      seen.add(key);
      if (!FEATURE_KEY_PATTERN.test(key)) problems.push(`"${key}": key must match ${FEATURE_KEY_PATTERN.source} (<module>.<name>)`);
      problems.push(...entryProblems(key, f));
    }
  return problems;
}

function normalise(key: string, f: FeatureDef): FeatureEntry {
  const deprecated = f.deprecated === true;
  switch (f.kind) {
    case 'FLAG':
      return { key, kind: 'FLAG', fallback: f.fallback, deprecated };
    case 'LIMIT':
      return { key, kind: 'LIMIT', fallback: f.fallback, minimum: f.minimum ?? 0, deprecated };
    case 'QUOTA':
      return { key, kind: 'QUOTA', resetPeriod: f.resetPeriod, fallback: f.fallback, minimum: f.minimum ?? 0, deprecated };
    default: {
      const unknownKind: never = f;
      throw new FeatureCatalogueError([`"${key}": unknown kind ${String(Reflect.get(unknownKind, 'kind'))}`]);
    }
  }
}

/** Gộp catalogue của mọi module/feature; vi phạm → `FeatureCatalogueError` liệt kê hết (app không khởi động). */
export function mergeFeatureCatalogues(defs: readonly FeatureCatalogueData[]): MergedFeatures {
  const problems = featureCatalogueProblems(defs);
  if (problems.length > 0) throw new FeatureCatalogueError(problems);
  const merged = new Map<string, FeatureEntry>();
  for (const def of defs)
    for (const [key, f] of Object.entries(def.features)) merged.set(key, normalise(key, f));
  return merged;
}
```

- [ ] **Step 4: Catalogue gói**

`src/modules/entitlements/domain/plan-catalogue.ts`:
```ts
import { ENTITLEMENT_VALUE_MAX, PLAN_KEY_PATTERN } from '../constants.js';
import { UNLIMITED, isCount, isNumericValue, type FeatureEntry, type MergedFeatures, type NumericValue } from './feature-catalogue.js';

export type PlanValue = boolean | NumericValue;
export type PlanDef = { readonly retired?: boolean; readonly values: Readonly<Record<string, PlanValue>> };
export type PlanCatalogueDef = { readonly defaultPlan: string; readonly plans: Readonly<Record<string, PlanDef>> };
export type PlanEntry = { readonly key: string; readonly retired: boolean; readonly values: ReadonlyMap<string, PlanValue> };
export type PlanCatalogue = { readonly defaultPlan: string; readonly plans: ReadonlyMap<string, PlanEntry> };

export class PlanCatalogueError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid plan catalogue: ${problems.join('; ')}`);
    this.name = 'PlanCatalogueError';
  }
}

/**
 * Catalogue gói của dự án (spec §8.2, S4-D2): giá trị gói chỉ ở code, DB chỉ có bảng tra cứu `plans`. Hàm chỉ chuẩn hoá;
 * mọi kiểm cần catalogue tính năng gộp chạy lúc boot (`validatePlanCatalogue`, registry) để lỗi được liệt kê một lần.
 */
export function definePlanCatalogue(def: PlanCatalogueDef): PlanCatalogue {
  return {
    defaultPlan: def.defaultPlan,
    plans: new Map(
      Object.entries(def.plans).map(([key, p]) => [key, { key, retired: p.retired === true, values: new Map(Object.entries(p.values)) }]),
    ),
  };
}

function planValueProblems(plan: string, f: FeatureEntry, value: unknown): string[] {
  switch (f.kind) {
    case 'FLAG':
      return typeof value === 'boolean' ? [] : [`plan "${plan}": "${f.key}" is a FLAG and needs true or false`];
    case 'LIMIT':
    case 'QUOTA':
      if (value === UNLIMITED) return [];
      if (!isNumericValue(value) || value === UNLIMITED || !isCount(value.max))
        return [`plan "${plan}": "${f.key}" needs UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`];
      return value.max < f.minimum ? [`plan "${plan}": "${f.key}" max ${value.max} is below minimum ${f.minimum}`] : [];
    default: {
      const unknownKind: never = f;
      return [`plan "${plan}": feature of unknown kind ${String(Reflect.get(unknownKind, 'kind'))}`];
    }
  }
}

/** EC-7 (spec §8.2 "Luật kiểm lúc boot"). Rỗng = hợp lệ. */
export function validatePlanCatalogue(catalogue: PlanCatalogue, features: MergedFeatures): string[] {
  const problems: string[] = [];
  const def = catalogue.plans.get(catalogue.defaultPlan);
  if (!def) problems.push(`defaultPlan "${catalogue.defaultPlan}" is not a declared plan`);
  else if (def.retired) problems.push(`defaultPlan "${catalogue.defaultPlan}" is retired`);
  for (const plan of catalogue.plans.values()) {
    if (!PLAN_KEY_PATTERN.test(plan.key)) problems.push(`plan "${plan.key}": key must match ${PLAN_KEY_PATTERN.source}`);
    for (const [key, value] of plan.values) {
      const f = features.get(key);
      if (!f) problems.push(`plan "${plan.key}": unknown feature "${key}"`);
      else if (f.deprecated) problems.push(`plan "${plan.key}": feature "${key}" is deprecated`);
      else problems.push(...planValueProblems(plan.key, f, value));
    }
  }
  return problems;
}

/** EC-8: với mỗi gói, key của tính năng (không deprecated) mà gói không nhắc tới, tức đang dùng `fallback` (log INFO lúc boot). */
export function fallbackUsage(catalogue: PlanCatalogue, features: MergedFeatures): Record<string, string[]> {
  const active = [...features.values()].filter((f) => !f.deprecated).map((f) => f.key).sort();
  return Object.fromEntries([...catalogue.plans.values()].map((p) => [p.key, active.filter((k) => !p.values.has(k))]));
}
```

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit test/unit/architecture
```
Expected: PASS (EC-1…EC-8 và Review Focus 1 xanh; `rules.spec.ts` "real source tree has no violations" xanh).

- [ ] **Step 6: Commit**

```bash
git add src/modules/entitlements test/unit/modules/entitlements
git commit -m "feat(entitlements): feature and plan catalogues with boot-time validation and the fallback report"
```

---

### Task 4: Giá trị hiệu lực (`resolveEffective`, `overrideStatus`, `quotaState`, `toLimit`) và hàm quyết định gán gói (`decideAssignment`)

**Files:**
- Create: `src/modules/entitlements/domain/effective-value.ts`, `src/modules/entitlements/domain/plan-assignment.ts`
- Create (test): `test/unit/modules/entitlements/effective-value.spec.ts`, `test/unit/modules/entitlements/plan-assignment.spec.ts`

**Interfaces:**
- Consumes: `FeatureEntry`, `NumericValue`, `ResetPeriod`, `UNLIMITED` (Task 3), `PlanValue` (Task 3), `PlanSource` (Task 3).
- Produces:
  - `domain/effective-value.ts`: `type Limit = { kind: 'UNLIMITED' } | { kind: 'MAX'; max: number }`, `VALUE_SOURCES`, `type ValueSource = 'OVERRIDE' | 'PLAN' | 'FALLBACK'`, `type EffectiveValue = { kind: 'FLAG'; enabled; source } | { kind: 'LIMIT'; limit; source } | { kind: 'QUOTA'; limit; resetPeriod; source }`, `type OverrideInput = { flagValue: boolean | null; limitValue: number | null; expiresAt: Date | null }` (hình dạng dòng override của 4C), `overrideStatus(expiresAt, now): 'ACTIVE' | 'EXPIRED'` (hết hạn **tại đúng** `expires_at`: `ACTIVE` ⇔ `expiresAt === null || expiresAt > now`), `toLimit(v: NumericValue): Limit`, `resolveEffective(feature, planValue | undefined, override | undefined, now: Date): EffectiveValue`, `type QuotaState`, `quotaState(limit, used)`, `class InvalidEntitlementValueError`.
  - `domain/plan-assignment.ts`: `type AssignmentCause = { kind: 'BILLING'; ref: string; sequence: bigint } | { kind: 'PLATFORM_ADMIN'; reason: string; expectedVersion: number }`, `type AssignPlanCommand = { planKey: string; cause: AssignmentCause }`, `type CurrentAssignment = { planKey; source: PlanSource; sourceRef: string | null; lastBillingSeq: bigint | null; version: number }`, `type TargetPlan = { key: string; retired: boolean }`, `type AssignmentDecision = { kind: 'APPLY' } | { kind: 'UNCHANGED' } | { kind: 'STALE'; lastBillingSeq: bigint } | { kind: 'REJECTED_RETIRED' } | { kind: 'VERSION_MISMATCH' }`, `decideAssignment(current, target, cause): AssignmentDecision`.

- [ ] **Step 1: Test giá trị hiệu lực (fail)**

`test/unit/modules/entitlements/effective-value.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { UNLIMITED, type FeatureEntry } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  InvalidEntitlementValueError,
  overrideStatus,
  quotaState,
  resolveEffective,
  type OverrideInput,
} from '../../../../src/modules/entitlements/domain/effective-value.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const LATER = new Date('2026-10-02T00:00:00.000Z');
const EARLIER = new Date('2026-09-30T00:00:00.000Z');
const flag: FeatureEntry = { key: 'x.flag', kind: 'FLAG', fallback: false, deprecated: false };
const limit: FeatureEntry = { key: 'x.seats', kind: 'LIMIT', fallback: UNLIMITED, minimum: 1, deprecated: false };
const quota: FeatureEntry = { key: 'x.calls', kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 5 }, minimum: 0, deprecated: false };
const ov = (o: Partial<OverrideInput>): OverrideInput => ({ flagValue: null, limitValue: null, expiresAt: null, ...o });

describe('resolveEffective (spec SP4 §8.4, EV-1…EV-9)', () => {
  it.each([
    ['live override', ov({ flagValue: true, expiresAt: LATER }), false, { kind: 'FLAG', enabled: true, source: 'OVERRIDE' }],
    ['permanent override', ov({ flagValue: true }), false, { kind: 'FLAG', enabled: true, source: 'OVERRIDE' }],
    ['expired override falls back to the plan', ov({ flagValue: true, expiresAt: EARLIER }), false, { kind: 'FLAG', enabled: false, source: 'PLAN' }],
    ['plan only', undefined, true, { kind: 'FLAG', enabled: true, source: 'PLAN' }],
  ] as const)('EV-1 FLAG: %s', (_, o, planValue, expected) => {
    expect(resolveEffective(flag, planValue, o, NOW)).toEqual(expected);
  });
  it('EV-2 FLAG: fallback when neither plan nor override mention it', () => {
    expect(resolveEffective(flag, undefined, undefined, NOW)).toEqual({ kind: 'FLAG', enabled: false, source: 'FALLBACK' });
  });
  it.each([
    ['live override MAX', ov({ limitValue: 3, expiresAt: LATER }), { max: 10 }, { kind: 'LIMIT', limit: { kind: 'MAX', max: 3 }, source: 'OVERRIDE' }],
    ['live override NULL = unlimited', ov({ limitValue: null }), { max: 10 }, { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'OVERRIDE' }],
    ['expired override', ov({ limitValue: 3, expiresAt: EARLIER }), { max: 10 }, { kind: 'LIMIT', limit: { kind: 'MAX', max: 10 }, source: 'PLAN' }],
    ['plan UNLIMITED', undefined, UNLIMITED, { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'PLAN' }],
    ['fallback UNLIMITED', undefined, undefined, { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'FALLBACK' }],
  ] as const)('EV-3/EV-4 LIMIT: %s', (_, o, planValue, expected) => {
    expect(resolveEffective(limit, planValue, o, NOW)).toEqual(expected);
  });
  it.each([
    ['override', ov({ limitValue: 7 }), undefined, { kind: 'MAX', max: 7 }, 'OVERRIDE'],
    ['plan', undefined, { max: 100 }, { kind: 'MAX', max: 100 }, 'PLAN'],
    ['fallback', undefined, undefined, { kind: 'MAX', max: 5 }, 'FALLBACK'],
  ] as const)('EV-5 QUOTA keeps its reset period: %s', (_, o, planValue, lim, source) => {
    expect(resolveEffective(quota, planValue, o, NOW)).toEqual({ kind: 'QUOTA', limit: lim, resetPeriod: 'MONTH', source });
  });
  it('EV-6: a value of the wrong type for the kind fails loud (the boot check should have caught it)', () => {
    expect(() => resolveEffective(flag, { max: 1 }, undefined, NOW)).toThrow(InvalidEntitlementValueError);
    expect(() => resolveEffective(limit, true, undefined, NOW)).toThrow(InvalidEntitlementValueError);
    expect(() => resolveEffective(flag, undefined, ov({ limitValue: 1 }), NOW)).toThrow(InvalidEntitlementValueError);
    expect(() => resolveEffective(limit, undefined, ov({ flagValue: true }), NOW)).toThrow(InvalidEntitlementValueError);
  });
  it('EV-7 overrideStatus: expired exactly at expires_at (boundary is >), permanent when NULL', () => {
    expect(overrideStatus(null, NOW)).toBe('ACTIVE');
    expect(overrideStatus(new Date(NOW.getTime() + 1), NOW)).toBe('ACTIVE');
    expect(overrideStatus(new Date(NOW.getTime()), NOW)).toBe('EXPIRED');
    expect(overrideStatus(EARLIER, NOW)).toBe('EXPIRED');
  });
  it.each([
    [{ kind: 'UNLIMITED' }, 1_000_000, 'WITHIN'],
    [{ kind: 'MAX', max: 10 }, 9, 'WITHIN'],
    [{ kind: 'MAX', max: 10 }, 10, 'REACHED'],
    [{ kind: 'MAX', max: 10 }, 11, 'OVER_LIMIT'],
    [{ kind: 'MAX', max: 0 }, 0, 'REACHED'],
  ] as const)('EV-8/EV-9 quotaState(%j, %i) = %s', (lim, used, state) => {
    expect(quotaState(lim, used)).toBe(state);
  });
});
```

- [ ] **Step 2: Test quyết định gán gói (fail)**

`test/unit/modules/entitlements/plan-assignment.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  decideAssignment,
  type AssignmentCause,
  type CurrentAssignment,
  type TargetPlan,
} from '../../../../src/modules/entitlements/domain/plan-assignment.js';

const cur = (o: Partial<CurrentAssignment> = {}): CurrentAssignment => ({
  planKey: 'free',
  source: 'BILLING',
  sourceRef: 'sub_1',
  lastBillingSeq: 5n,
  version: 3,
  ...o,
});
const pro: TargetPlan = { key: 'pro', retired: false };
const billing = (sequence: bigint, ref = 'sub_1'): AssignmentCause => ({ kind: 'BILLING', ref, sequence });
const admin = (expectedVersion: number): AssignmentCause => ({ kind: 'PLATFORM_ADMIN', reason: 'goodwill', expectedVersion });

describe('decideAssignment (spec SP4 §10.2 bước 3, PA-1…PA-8)', () => {
  it('PA-1: a billing sequence below the last one is STALE, naming the last one', () => {
    expect(decideAssignment(cur(), pro, billing(4n))).toEqual({ kind: 'STALE', lastBillingSeq: 5n });
  });
  it('PA-2: an equal sequence is STALE (a replayed command)', () => {
    expect(decideAssignment(cur(), pro, billing(5n))).toEqual({ kind: 'STALE', lastBillingSeq: 5n });
  });
  it('PA-3: a greater sequence applies', () => {
    expect(decideAssignment(cur(), pro, billing(6n))).toEqual({ kind: 'APPLY' });
  });
  it('PA-4: with no billing command yet, any sequence is new', () => {
    expect(decideAssignment(cur({ source: 'DEFAULT', sourceRef: null, lastBillingSeq: null }), pro, billing(1n))).toEqual({ kind: 'APPLY' });
  });
  it('PA-5: a staff command with the wrong version is a VERSION_MISMATCH (412 before any write)', () => {
    expect(decideAssignment(cur(), pro, admin(2))).toEqual({ kind: 'VERSION_MISMATCH' });
    expect(decideAssignment(cur(), pro, admin(3))).toEqual({ kind: 'APPLY' });
  });
  it('PA-6: a retired target different from the current plan is REJECTED_RETIRED; the same retired plan is kept', () => {
    const legacy: TargetPlan = { key: 'legacy', retired: true };
    expect(decideAssignment(cur(), legacy, billing(6n))).toEqual({ kind: 'REJECTED_RETIRED' });
    expect(decideAssignment(cur(), legacy, admin(3))).toEqual({ kind: 'REJECTED_RETIRED' });
    expect(decideAssignment(cur({ planKey: 'legacy' }), legacy, billing(6n))).toEqual({ kind: 'UNCHANGED' });
    expect(decideAssignment(cur({ planKey: 'legacy' }), legacy, billing(6n, 'sub_2'))).toEqual({ kind: 'APPLY' });
  });
  it('PA-7: the same plan from another source or subscription applies (billing takes the slot back)', () => {
    expect(decideAssignment(cur({ planKey: 'pro', source: 'PLATFORM_ADMIN', sourceRef: null }), pro, billing(6n))).toEqual({ kind: 'APPLY' });
    expect(decideAssignment(cur({ planKey: 'pro' }), pro, billing(6n, 'sub_2'))).toEqual({ kind: 'APPLY' });
    expect(decideAssignment(cur({ planKey: 'pro' }), pro, admin(3))).toEqual({ kind: 'APPLY' });
  });
  it('PA-8: same plan, same source, same ref is UNCHANGED (renewal); staff re-assigning its own plan too', () => {
    expect(decideAssignment(cur({ planKey: 'pro' }), pro, billing(6n))).toEqual({ kind: 'UNCHANGED' });
    expect(decideAssignment(cur({ planKey: 'pro', source: 'PLATFORM_ADMIN', sourceRef: null }), pro, admin(3))).toEqual({ kind: 'UNCHANGED' });
  });
  it('sequences beyond 2^53 compare as bigint', () => {
    const big = 2n ** 53n + 1n;
    expect(decideAssignment(cur({ lastBillingSeq: big }), pro, billing(big + 1n))).toEqual({ kind: 'APPLY' });
    expect(decideAssignment(cur({ lastBillingSeq: big + 1n }), pro, billing(big))).toEqual({ kind: 'STALE', lastBillingSeq: big + 1n });
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/effective-value.spec.ts test/unit/modules/entitlements/plan-assignment.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 3: Cài hai hàm thuần**

`src/modules/entitlements/domain/effective-value.ts`:
```ts
import { UNLIMITED, type FeatureEntry, type NumericValue } from './feature-catalogue.js';
import type { PlanValue } from './plan-catalogue.js';

export type Limit = { readonly kind: 'UNLIMITED' } | { readonly kind: 'MAX'; readonly max: number };
export const VALUE_SOURCES = ['OVERRIDE', 'PLAN', 'FALLBACK'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];
export type EffectiveValue =
  | { readonly kind: 'FLAG'; readonly enabled: boolean; readonly source: ValueSource }
  | { readonly kind: 'LIMIT'; readonly limit: Limit; readonly source: ValueSource }
  | { readonly kind: 'QUOTA'; readonly limit: Limit; readonly resetPeriod: 'NONE' | 'MONTH'; readonly source: ValueSource };
/** Dòng override của nhân viên (bảng của 4C): FLAG dùng `flagValue`; LIMIT/QUOTA dùng `limitValue` (NULL = không giới hạn). */
export type OverrideInput = { readonly flagValue: boolean | null; readonly limitValue: number | null; readonly expiresAt: Date | null };
export type OverrideStatus = 'ACTIVE' | 'EXPIRED';
export type QuotaState = 'WITHIN' | 'REACHED' | 'OVER_LIMIT';

/** Giá trị sai kiểu với `kind` tới được lúc chạy (kiểm lúc boot/trigger đã phải chặn): lỗi lập trình, không đoán. */
export class InvalidEntitlementValueError extends Error {
  constructor(
    readonly featureKey: string,
    detail: string,
  ) {
    super(`Invalid entitlement value for "${featureKey}": ${detail}`);
    this.name = 'InvalidEntitlementValueError';
  }
}

/** Hết hạn là suy ra (spec §7.4, S4-D12): hết hạn TẠI ĐÚNG `expires_at`, cùng biên `expires_at > now()` của câu snapshot. */
export const overrideStatus = (expiresAt: Date | null, now: Date): OverrideStatus =>
  expiresAt === null || expiresAt.getTime() > now.getTime() ? 'ACTIVE' : 'EXPIRED';

export const toLimit = (v: NumericValue): Limit => (v === UNLIMITED ? { kind: 'UNLIMITED' } : { kind: 'MAX', max: v.max });

function numeric(
  feature: { readonly key: string; readonly fallback: NumericValue },
  planValue: PlanValue | undefined,
  override: OverrideInput | undefined,
): { limit: Limit; source: ValueSource } {
  if (override) {
    if (override.flagValue !== null) throw new InvalidEntitlementValueError(feature.key, 'a numeric override carries a flag value');
    return { limit: override.limitValue === null ? { kind: 'UNLIMITED' } : { kind: 'MAX', max: override.limitValue }, source: 'OVERRIDE' };
  }
  if (planValue !== undefined) {
    if (typeof planValue === 'boolean') throw new InvalidEntitlementValueError(feature.key, 'the plan gives a boolean to a numeric feature');
    return { limit: toLimit(planValue), source: 'PLAN' };
  }
  return { limit: toLimit(feature.fallback), source: 'FALLBACK' };
}

/** Một luật ưu tiên (S4-D12): override còn hạn > giá trị gói > `fallback`. Hàm thuần, `switch` vét cạn theo `kind`. */
export function resolveEffective(
  feature: FeatureEntry,
  planValue: PlanValue | undefined,
  override: OverrideInput | undefined,
  now: Date,
): EffectiveValue {
  const active = override && overrideStatus(override.expiresAt, now) === 'ACTIVE' ? override : undefined;
  switch (feature.kind) {
    case 'FLAG': {
      if (active) {
        if (active.flagValue === null) throw new InvalidEntitlementValueError(feature.key, 'a FLAG override has no flag value');
        return { kind: 'FLAG', enabled: active.flagValue, source: 'OVERRIDE' };
      }
      if (planValue !== undefined) {
        if (typeof planValue !== 'boolean') throw new InvalidEntitlementValueError(feature.key, 'the plan gives a number to a FLAG');
        return { kind: 'FLAG', enabled: planValue, source: 'PLAN' };
      }
      return { kind: 'FLAG', enabled: feature.fallback, source: 'FALLBACK' };
    }
    case 'LIMIT':
      return { kind: 'LIMIT', ...numeric(feature, planValue, active) };
    case 'QUOTA':
      return { kind: 'QUOTA', resetPeriod: feature.resetPeriod, ...numeric(feature, planValue, active) };
    default: {
      const unknownKind: never = feature;
      throw new InvalidEntitlementValueError(String(Reflect.get(unknownKind, 'key')), 'unknown feature kind');
    }
  }
}

/** Trạng thái hiển thị của quota (spec §9.4), suy ra, không lưu. `used > max` sau khi hạ gói là hợp lệ (S4-D13). */
export function quotaState(limit: Limit, used: number): QuotaState {
  switch (limit.kind) {
    case 'UNLIMITED':
      return 'WITHIN';
    case 'MAX':
      return used < limit.max ? 'WITHIN' : used === limit.max ? 'REACHED' : 'OVER_LIMIT';
    default: {
      const unknownKind: never = limit;
      throw new Error(`unknown limit kind ${String(Reflect.get(unknownKind, 'kind'))}`);
    }
  }
}
```
`src/modules/entitlements/domain/plan-assignment.ts`:
```ts
import type { PlanSource } from '../constants.js';

/** Lệnh gán gói (spec §10.1, R-X1). `DEFAULT` không có trong lệnh công khai: chỉ participant/subscriber/backfill chèn nguồn đó. */
export type AssignmentCause =
  | { readonly kind: 'BILLING'; readonly ref: string; readonly sequence: bigint }
  | { readonly kind: 'PLATFORM_ADMIN'; readonly reason: string; readonly expectedVersion: number };
export type AssignPlanCommand = { readonly planKey: string; readonly cause: AssignmentCause };
/** Trạng thái hiện tại đọc dưới khoá `FOR NO KEY UPDATE` (spec §10.2 bước 2). */
export type CurrentAssignment = {
  readonly planKey: string;
  readonly source: PlanSource;
  readonly sourceRef: string | null;
  readonly lastBillingSeq: bigint | null;
  readonly version: number;
};
/** Gói đích; `retired` đọc từ DB (cùng nguồn với trigger `org_entitlements_plan_not_retired`), không từ catalogue. */
export type TargetPlan = { readonly key: string; readonly retired: boolean };
export type AssignmentDecision =
  | { readonly kind: 'APPLY' }
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'STALE'; readonly lastBillingSeq: bigint }
  | { readonly kind: 'REJECTED_RETIRED' }
  | { readonly kind: 'VERSION_MISMATCH' };

function settle(current: CurrentAssignment, target: TargetPlan, source: PlanSource, ref: string | null): AssignmentDecision {
  const samePlan = target.key === current.planKey;
  if (target.retired && !samePlan) return { kind: 'REJECTED_RETIRED' };
  if (samePlan && current.source === source && current.sourceRef === ref) return { kind: 'UNCHANGED' };
  return { kind: 'APPLY' };
}

/**
 * Hàm quyết định (spec §10.2 bước 3, S4-D11, R-X18): lệnh mới nhất thắng; billing khẳng định lại gói mỗi kỳ, nên gán tay
 * của nhân viên bị ghi đè ở kỳ trả tiền kế tiếp (APPLY), gia hạn cùng gói cùng subscription là UNCHANGED. `switch` vét cạn.
 */
export function decideAssignment(current: CurrentAssignment, target: TargetPlan, cause: AssignmentCause): AssignmentDecision {
  switch (cause.kind) {
    case 'BILLING':
      if (current.lastBillingSeq !== null && cause.sequence <= current.lastBillingSeq)
        return { kind: 'STALE', lastBillingSeq: current.lastBillingSeq };
      return settle(current, target, 'BILLING', cause.ref);
    case 'PLATFORM_ADMIN':
      if (cause.expectedVersion !== current.version) return { kind: 'VERSION_MISMATCH' };
      return settle(current, target, 'PLATFORM_ADMIN', null);
    default: {
      const unknownCause: never = cause;
      throw new Error(`unknown assignment cause ${String(Reflect.get(unknownCause, 'kind'))}`);
    }
  }
}
```

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run --project unit test/unit/architecture
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/entitlements/domain test/unit/modules/entitlements
git commit -m "feat(entitlements): effective value resolution, quota state and the plan assignment decision as pure functions"
```

---
## Phần D — Schema (spec §7.1–7.3, §7.6, §7.7, §17)

### Task 5: Migration `entitlements_core` — 3 bảng, RLS/FORCE/policy `TO app_user`, grant theo cột, 4 trigger, tính năng `tenancy.seats`; catalog, cô lập, ràng buộc (DB-1, DB-2, DB-3)

**Files:**
- Create: `src/migrations/entitlements/Migration<ts>_entitlements_core.ts` (CLI), `src/modules/entitlements/infra/sql/entitlements-purge.sql.ts`
- Create (test): `test/support/entitlements-catalog.ts`, `test/support/entitlements-seed.ts`, `test/integration/entitlements/schema.spec.ts`, `test/integration/entitlements/isolation.spec.ts`
- Modify: `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`, `test/unit/migrations/migration-order.spec.ts`, `test/support/tenancy-seed.ts`, `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes: `organizations` (3A), `app_current_org()` (SP1), `seedOrg`, `withAppClient`, `inOrgTx`, `ORG_PURGE_STATEMENTS` (3A Task 14), `purgeOrgs` (3A Task 23), `FEATURE_KEY_PATTERN`, `PLAN_KEY_PATTERN`, `PlanSource`, `FeatureKind`, `ResetPeriod`, `FeatureCatalogueData` (Task 3), `ownerQuery` (SP2 `test/support/identity-app.ts`), `createTestApp`, `DatabaseModule`, `OrgScope`, `UnitOfWork`, `Db` (SP1).
- Produces (tên là hợp đồng cho mọi task sau):
  - Bảng `entitlement_features`, `plans` (global, không RLS), `org_entitlements` (tenant, RLS FORCE) đúng spec §7.1–7.3.
  - Constraint: `entitlement_features_key_uq`, `entitlement_features_key_ck`, `entitlement_features_kind_ck`, `entitlement_features_reset_period_ck`, `entitlement_features_period_ck`, `plans_key_uq`, `plans_key_ck`, `org_entitlements_org_fk`, `org_entitlements_plan_fk`, `org_entitlements_source_ck`, `org_entitlements_source_ref_ck`, `org_entitlements_source_ref_length_ck`, `org_entitlements_reason_ck`, `org_entitlements_reason_format_ck`, `org_entitlements_billing_seq_ck`, `org_entitlements_version_ck`; index `org_entitlements_plan_idx`; policy `org_entitlements_tenant TO app_user`.
  - Trigger (tên = constraint trong `RAISE`): `entitlement_features_immutable`, `plans_key_immutable`, `org_entitlements_billing_seq_monotonic`, `org_entitlements_plan_not_retired`; hàm `entitlements_feature_immutable()`, `entitlements_plan_key_immutable()`, `entitlements_billing_seq_monotonic()`, `entitlements_plan_not_retired()`.
  - Dữ liệu: dòng `entitlement_features ('tenancy.seats', 'LIMIT')`. (Task 7 thêm `entitlements.read` vào cùng file.)
  - `ENTITLEMENTS_PURGE_STATEMENTS: readonly string[]` (`infra/sql/entitlements-purge.sql.ts`): participant purge (Task 11) và helper seed của test dùng chung.
  - `test/support/entitlements-catalog.ts`: `ENTITLEMENTS_TENANT_TABLES_4A = ['org_entitlements']`, `ENTITLEMENTS_GLOBAL_TABLES_4A = ['entitlement_features', 'plans']`, `ENTITLEMENTS_TENANT_TABLES`, `ENTITLEMENTS_GLOBAL_TABLES` (hợp các hằng; 4B/4C thêm hằng riêng).
  - `test/support/entitlements-seed.ts`: `type FeatureRow = { key; kind: FeatureKind; resetPeriod: ResetPeriod | null; deprecated: boolean }`, `featureRowsOf(c: FeatureCatalogueData): FeatureRow[]`, `seedFeatures(rows, database?) → Promise<() => Promise<void>>`, `seedPlans(plans: { key; retired? }[], database?) → Promise<() => Promise<void>>` (`ON CONFLICT (key) DO NOTHING`; hàm dọn chỉ xoá dòng chính nó chèn), `seedOrgEntitlement(orgId, planKey, opts?: { source?; sourceRef?; reason?; lastBillingSeq?: bigint | null }, database?)`, `setOrgPlan(orgId, planKey)`, `deleteOrgEntitlement(orgId)`, `readOrgEntitlement(orgId) → Promise<OrgEntitlementRow | undefined>` với `OrgEntitlementRow = { planKey; source; sourceRef; reason; lastBillingSeq: string | null; version: number }`, `withOwner(fn, database?)`.
  - `seedOrg().dispose()` và `purgeOrgs()` chạy `ENTITLEMENTS_PURGE_STATEMENTS` trước `ORG_PURGE_STATEMENTS` (thứ tự của job purge: participant `order = 100` trước tenancy core).

- [ ] **Step 1: Tạo migration**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/entitlements --name entitlements_core`
Expected: `src/migrations/entitlements/Migration<ts>_entitlements_core.ts`, timestamp lớn hơn migration mới nhất trên `main`.

- [ ] **Step 2: Hằng catalog, helper seed, thứ tự xoá dùng chung**

`test/support/entitlements-catalog.ts`:
```ts
/**
 * Bảng của SP4 theo plan (spec SP4 §7, §20.2 DB-1): test catalog so với HỢP các hằng đang có mặt, để 4B ∥ 4C chỉ xung đột
 * văn bản ở dòng khai báo hằng. Plan sau THÊM hằng của mình, không sửa hằng 4A.
 */
export const ENTITLEMENTS_TENANT_TABLES_4A = ['org_entitlements'] as const;
export const ENTITLEMENTS_GLOBAL_TABLES_4A = ['entitlement_features', 'plans'] as const;
export const ENTITLEMENTS_TENANT_TABLES: readonly string[] = [...ENTITLEMENTS_TENANT_TABLES_4A];
export const ENTITLEMENTS_GLOBAL_TABLES: readonly string[] = [...ENTITLEMENTS_GLOBAL_TABLES_4A];
```
`src/modules/entitlements/infra/sql/entitlements-purge.sql.ts`:
```ts
/**
 * Xoá cứng dòng entitlements của MỘT org, con trước cha (spec SP4 §13.2), chạy trong OrgScope của org đó (RLS). Dùng chung
 * cho participant purge (`order = 100`, Task 11) và helper seed của test (`seedOrg().dispose()`, `purgeOrgs`) để hai nơi
 * không lệch. 4B chèn `usage_counters`, 4C chèn `org_entitlement_overrides` TRƯỚC dòng `org_entitlements`. Không `CASCADE`:
 * thiếu một bảng thì câu cuối lỗi `23001` (FK RESTRICT), không để dòng mồ côi.
 */
export const ENTITLEMENTS_PURGE_STATEMENTS: readonly string[] = ['DELETE FROM org_entitlements WHERE org_id = app_current_org()'];
```
`.dependency-cruiser.cjs`, `no-orphans` `pathNot` thêm:
```js
          // SP4 plan 4A Task 5: shared purge order, imported by test/support/tenancy-seed.ts (not cruised) until the purge
          // participant (Task 11) imports it; Task 11 removes this line.
          '(^|/)src/modules/entitlements/infra/sql/entitlements-purge[.]sql[.]ts$',
```
`test/support/tenancy-seed.ts`:
1. Import `ENTITLEMENTS_PURGE_STATEMENTS` từ `../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js`.
2. Thêm hằng (sau các import):
```ts
/**
 * Thứ tự xoá cứng như job purge (3A Task 25 + SP4 §13.2): participant theo `order` (`core.scheduled-tasks` 0 = câu
 * `DELETE FROM scheduled_tasks` gọi riêng ở trên; `entitlements` 100) rồi bảng tenancy (1000). Plan sau chèn câu của
 * participant mình theo `order`.
 */
const PURGE_ORDER: readonly string[] = [...ENTITLEMENTS_PURGE_STATEMENTS, ...ORG_PURGE_STATEMENTS];
```
3. Trong `seedOrg().dispose()` và trong `purgeOrgs`, thay `for (const sql of ORG_PURGE_STATEMENTS)` bằng `for (const sql of PURGE_ORDER)`.

`test/support/entitlements-seed.ts`:
```ts
import pg from 'pg';
import type { PlanSource } from '../../src/modules/entitlements/constants.js';
import type { FeatureCatalogueData, FeatureKind, ResetPeriod } from '../../src/modules/entitlements/domain/feature-catalogue.js';
import { getInfra } from './infra.js';
import { inOrgTx, withAppClient } from './tenancy-seed.js';

export type FeatureRow = { key: string; kind: FeatureKind; resetPeriod: ResetPeriod | null; deprecated: boolean };
export type OrgEntitlementRow = {
  planKey: string;
  source: PlanSource;
  sourceRef: string | null;
  reason: string | null;
  lastBillingSeq: string | null;
  version: number;
};

/** `app_owner` thẳng Postgres: bảng global của SP4 chỉ ghi bằng migration ở production, test seed bằng đúng role đó. */
export async function withOwner<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const { pg: p } = getInfra();
  const c = new pg.Client({ host: p.host, port: p.port, database: database ?? p.database, ...p.owner });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Dòng `entitlement_features` mà một catalogue trong code đòi (cùng phép so của `EntitlementCatalogueCheck`). */
export const featureRowsOf = (c: FeatureCatalogueData): FeatureRow[] =>
  Object.entries(c.features).map(([key, f]) => ({
    key,
    kind: f.kind,
    resetPeriod: f.kind === 'QUOTA' ? f.resetPeriod : null,
    deprecated: f.deprecated === true,
  }));

/** Chèn tính năng fixture; trả hàm dọn (gọi SAU khi mọi org dùng chúng đã dispose). */
export async function seedFeatures(rows: readonly FeatureRow[], database?: string): Promise<() => Promise<void>> {
  const keys = rows.map((r) => r.key);
  await withOwner(
    (c) =>
      c.query(
        `INSERT INTO entitlement_features (key, kind, reset_period, deprecated_at)
         SELECT k, kd, rp, CASE WHEN d THEN now() END FROM unnest($1::text[], $2::text[], $3::text[], $4::bool[]) AS t(k, kd, rp, d)`,
        [keys, rows.map((r) => r.kind), rows.map((r) => r.resetPeriod), rows.map((r) => r.deprecated)],
      ),
    database,
  );
  return () => withOwner(async (c) => void (await c.query('DELETE FROM entitlement_features WHERE key = ANY($1::text[])', [keys])), database);
}

/** Chèn gói (bỏ qua key đã có, vd. `free`/`pro` của migration mẫu); hàm dọn chỉ xoá dòng chính lần gọi này chèn. */
export async function seedPlans(plans: readonly { key: string; retired?: boolean }[], database?: string): Promise<() => Promise<void>> {
  const inserted = await withOwner(async (c) => {
    const { rows } = await c.query<{ key: string }>(
      `INSERT INTO plans (key, retired_at) SELECT k, CASE WHEN r THEN now() END FROM unnest($1::text[], $2::bool[]) AS t(k, r)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [plans.map((p) => p.key), plans.map((p) => p.retired === true)],
    );
    return rows.map((r) => r.key);
  }, database);
  return () => withOwner(async (c) => void (await c.query('DELETE FROM plans WHERE key = ANY($1::text[])', [inserted])), database);
}

/** Một dòng `org_entitlements` bằng `app_user` trong OrgScope của org (đúng đường của participant); ném nếu gói không có. */
export async function seedOrgEntitlement(
  orgId: string,
  planKey: string,
  opts: { source?: PlanSource; sourceRef?: string | null; reason?: string | null; lastBillingSeq?: bigint | null } = {},
  database?: string,
): Promise<void> {
  const n = await withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const r = await c.query(
          `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_source_ref, plan_reason, last_billing_seq, plan_assigned_at)
           SELECT $1, id, $3, $4, $5, $6::bigint, now() FROM plans WHERE key = $2`,
          [orgId, planKey, opts.source ?? 'DEFAULT', opts.sourceRef ?? null, opts.reason ?? null, opts.lastBillingSeq?.toString() ?? null],
        );
        return r.rowCount ?? 0;
      }),
    database,
  );
  if (n !== 1) throw new Error(`seedOrgEntitlement: plan "${planKey}" does not exist`);
}

export const setOrgPlan = (orgId: string, planKey: string): Promise<unknown> =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(`UPDATE org_entitlements SET plan_id = (SELECT id FROM plans WHERE key = $1), updated_at = now() WHERE org_id = app_current_org()`, [
        planKey,
      ]),
    ),
  );

export const deleteOrgEntitlement = (orgId: string): Promise<unknown> =>
  withAppClient((c) => inOrgTx(c, orgId, () => c.query('DELETE FROM org_entitlements WHERE org_id = app_current_org()')));

export async function readOrgEntitlement(orgId: string, database?: string): Promise<OrgEntitlementRow | undefined> {
  return withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const { rows } = await c.query<OrgEntitlementRow>(
          `SELECT p.key AS "planKey", e.plan_source AS source, e.plan_source_ref AS "sourceRef", e.plan_reason AS reason,
                  e.last_billing_seq::text AS "lastBillingSeq", e.version
           FROM org_entitlements e JOIN plans p ON p.id = e.plan_id WHERE e.org_id = app_current_org()`,
        );
        return rows[0];
      }),
    database,
  );
}
```

- [ ] **Step 3: Test catalog, inventory, thứ tự migration (fail)**

`test/integration/core/database/rls-catalog.spec.ts`:
- import `ENTITLEMENTS_GLOBAL_TABLES, ENTITLEMENTS_TENANT_TABLES` từ `../../../support/entitlements-catalog.js`;
- cuối mảng `GLOBAL_TABLES` thêm:
```ts
  // SP4 (spec §7.1–7.2): bảng tra cứu catalogue tính năng và gói, không chứa dữ liệu tenant
  ...ENTITLEMENTS_GLOBAL_TABLES,
```
- thêm vào `describe('RLS catalog …')`:
```ts
  it('every tenant policy of entitlements tables is limited TO app_user with USING and WITH CHECK on org_id (spec SP4 §7.3)', async () => {
    const { rows } = await client.query<{ tablename: string; roles: string[]; qual: string; with_check: string }>(
      `SELECT tablename, roles::text[] AS roles, qual, with_check FROM pg_policies
       WHERE schemaname = 'public' AND policyname = tablename || '_tenant' AND tablename = ANY($1::text[])`,
      [[...ENTITLEMENTS_TENANT_TABLES]],
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual([...ENTITLEMENTS_TENANT_TABLES].sort());
    for (const r of rows) {
      expect(r.roles, r.tablename).toEqual(['app_user']);
      expect(r.qual, r.tablename).toMatch(/org_id = app_current_org\(\)/);
      expect(r.with_check, r.tablename).toMatch(/org_id = app_current_org\(\)/);
    }
  });
```
- thêm vào `describe('schema and database privileges (R20)')`:
```ts
  describe('entitlements grants (spec SP4 §7.1–7.3, DB-1)', () => {
    it('app_user reads the lookup tables, never writes them', async () => {
      const { rows } = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY 1, 2`,
        [[...ENTITLEMENTS_GLOBAL_TABLES]],
      );
      expect(rows).toEqual([...ENTITLEMENTS_GLOBAL_TABLES].sort().map((t) => ({ table_name: t, privilege_type: 'SELECT' })));
    });
    it('app_user UPDATE on org_entitlements is column-scoped: org_id and created_at are immutable', async () => {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
         WHERE grantee = 'app_user' AND privilege_type = 'UPDATE' AND table_schema = 'public' AND table_name = 'org_entitlements'
         ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        'last_billing_seq',
        'plan_assigned_at',
        'plan_id',
        'plan_reason',
        'plan_source',
        'plan_source_ref',
        'updated_at',
        'version',
      ]);
      const table = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'org_entitlements' ORDER BY 1`,
      );
      expect(table.rows.map((r) => r.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT']);
    });
  });
```
`test/integration/core/database/normalization-inventory.spec.ts`, `ANALYSED_COLUMNS` thêm:
```ts
  // SP4 (spec §7.6): BCNF cả ba, không phi chuẩn hoá.
  'public.entitlement_features': ['id', 'key', 'kind', 'reset_period', 'deprecated_at', 'created_at', 'updated_at'],
  'public.plans': ['id', 'key', 'retired_at', 'created_at', 'updated_at'],
  'public.org_entitlements': [
    'org_id',
    'plan_id',
    'plan_source',
    'plan_source_ref',
    'plan_reason',
    'last_billing_seq',
    'plan_assigned_at',
    'version',
    'created_at',
    'updated_at',
  ],
```
`test/unit/migrations/migration-order.spec.ts` — thêm hằng và ca:
```ts
/** Migration của SP4 chạy sau `…_tenancy_core` (FK tới `organizations`, dòng `permissions`, spec SP4 §7.7). */
const TENANCY_CORE_SUFFIX = '_tenancy_core.ts';
```
```ts
  it('entitlements and example (template) migrations run after the tenancy core migration; starter plans after entitlements core', () => {
    const tenancyCore = all.find((f) => f.endsWith(TENANCY_CORE_SUFFIX));
    if (!tenancyCore) throw new Error('tenancy_core migration not found');
    const zoned = all.filter((f) => /[\\/](entitlements|example)[\\/]/.test(f));
    for (const f of zoned) expect(tsOf(f) > tsOf(tenancyCore), f).toBe(true);
    const core = all.find((f) => f.endsWith('_entitlements_core.ts'));
    const starter = all.find((f) => f.endsWith('_starter_plans.ts'));
    if (core && starter) expect(tsOf(starter) > tsOf(core)).toBe(true);
  });
```
Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts
```
Expected: unit PASS (migration rỗng vừa tạo có timestamp đúng); integration FAIL (bảng chưa có: `GLOBAL_TABLES` liệt kê bảng không tồn tại, policy/grant rỗng, inventory thiếu cột).

- [ ] **Step 4: Test ràng buộc, trigger và cô lập (fail)**

`test/integration/entitlements/schema.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEATURE_KEY_PATTERN, PLAN_KEY_PATTERN } from '../../../src/modules/entitlements/constants.js';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js';
import { ORG_PURGE_STATEMENTS } from '../../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import { readOrgEntitlement, seedOrgEntitlement, seedPlans, withOwner } from '../../support/entitlements-seed.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/** Lỗi pg có `code` (SQLSTATE) và `constraint`; test đọc bằng `Reflect.get` để không cast. */
async function rejectsWith(p: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected a database error').toBeInstanceOf(Error);
  if (!(err instanceof Error)) return;
  expect(Reflect.get(err, 'code')).toBe(code);
  if (constraint) expect(Reflect.get(err, 'constraint')).toBe(constraint);
}
/** Một câu trong OrgScope của org (transaction riêng, rollback khi lỗi). */
const inOrg = (orgId: string, sql: string, params: unknown[] = []) => withAppClient((c) => inOrgTx(c, orgId, () => c.query(sql, params)));
const owner = (sql: string, params: unknown[] = []) => withOwner((c) => c.query(sql, params));
/** Câu của owner trong một transaction luôn rollback: kiểm "được phép" mà không đổi DB dùng chung. */
const ownerProbe = (sql: string) =>
  withOwner(async (c) => {
    await c.query('BEGIN');
    try {
      return await c.query(sql);
    } finally {
      await c.query('ROLLBACK');
    }
  });
const insertFor = (orgId: string, cols: string, values: string, params: unknown[] = []) =>
  inOrg(orgId, `INSERT INTO org_entitlements (org_id, plan_id, plan_assigned_at, ${cols}) SELECT app_current_org(), id, now(), ${values} FROM plans WHERE key = 'sch_basic'`, params);

describe('entitlements schema invariants (spec SP4 §7.1–7.3, DB-3)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  const disposers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    disposers.push(await seedPlans([{ key: 'sch_basic' }, { key: 'sch_other' }, { key: 'sch_old', retired: true }]));
    a = await seedOrg();
    b = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'sch_basic', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 5n });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    for (const d of disposers.reverse()) await d();
  });

  it('the four trigger functions are INVOKER, owned by app_owner, and not executable by PUBLIC or app_user (as SP2/3A)', async () => {
    const fns = ['entitlements_billing_seq_monotonic', 'entitlements_feature_immutable', 'entitlements_plan_key_immutable', 'entitlements_plan_not_retired'];
    const { rows } = await owner(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[]) ORDER BY p.proname`,
      [fns],
    );
    expect(rows).toEqual(fns.map((proname) => ({ proname, owner: 'app_owner', definer: false, app_user_exec: false, public_exec: false })));
  });

  describe('entitlement_features', () => {
    it('the key CHECK is the FEATURE_KEY_PATTERN of the code; plans_key_ck is PLAN_KEY_PATTERN', async () => {
      const defs = await owner(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('entitlement_features_key_ck', 'plans_key_ck') ORDER BY conname`,
      );
      expect(defs.rows[0]?.def).toContain(FEATURE_KEY_PATTERN.source);
      expect(defs.rows[1]?.def).toContain(PLAN_KEY_PATTERN.source);
    });
    it.each([
      [`('Bad.key', 'FLAG', NULL)`, 'entitlement_features_key_ck'],
      [`('x.y', 'COUNTER', NULL)`, 'entitlement_features_kind_ck'],
      [`('x.y', 'FLAG', 'MONTH')`, 'entitlement_features_period_ck'],
      [`('x.y', 'QUOTA', NULL)`, 'entitlement_features_period_ck'],
      [`('x.y', 'QUOTA', 'DAY')`, 'entitlement_features_reset_period_ck'],
    ])('INSERT %s → 23514 %s', async (values, constraint) => {
      await rejectsWith(owner(`INSERT INTO entitlement_features (key, kind, reset_period) VALUES ${values}`), '23514', constraint);
    });
    it.each([`key = 'tenancy.members'`, `kind = 'FLAG'`, `reset_period = 'NONE', kind = 'QUOTA'`])(
      'UPDATE %s of a feature → 23514 entitlement_features_immutable (a new key is the only way)',
      async (set) => {
        await rejectsWith(owner(`UPDATE entitlement_features SET ${set} WHERE key = 'tenancy.seats'`), '23514', 'entitlement_features_immutable');
      },
    );
    it('deprecating a feature is allowed', async () => {
      expect((await ownerProbe(`UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'tenancy.seats'`)).rowCount).toBe(1);
    });
    it('the boilerplate feature tenancy.seats is seeded as a LIMIT', async () => {
      expect((await owner(`SELECT kind, reset_period, deprecated_at FROM entitlement_features WHERE key = 'tenancy.seats'`)).rows).toEqual([
        { kind: 'LIMIT', reset_period: null, deprecated_at: null },
      ]);
    });
  });

  describe('plans', () => {
    it('bad key → plans_key_ck; renaming a plan → plans_key_immutable; retiring is allowed', async () => {
      await rejectsWith(owner(`INSERT INTO plans (key) VALUES ('Pro')`), '23514', 'plans_key_ck');
      await rejectsWith(owner(`UPDATE plans SET key = 'sch_renamed' WHERE key = 'sch_other'`), '23514', 'plans_key_immutable');
      expect((await ownerProbe(`UPDATE plans SET retired_at = now() WHERE key = 'sch_other'`)).rowCount).toBe(1);
    });
    it('a plan still referenced by an organization cannot be deleted (FK RESTRICT → 23001)', async () => {
      await rejectsWith(owner(`DELETE FROM plans WHERE key = 'sch_basic'`), '23001', 'org_entitlements_plan_fk');
    });
    it('app_user cannot write the lookup tables (42501)', async () => {
      await rejectsWith(inOrg(b.orgId, `INSERT INTO plans (key) VALUES ('sch_nope')`), '42501');
      await rejectsWith(inOrg(b.orgId, `INSERT INTO entitlement_features (key, kind) VALUES ('x.nope', 'FLAG')`), '42501');
    });
  });

  describe('org_entitlements', () => {
    it.each([
      ['BILLING without a ref', `plan_source`, `'BILLING'`, 'org_entitlements_source_ref_ck'],
      ['DEFAULT with a ref', `plan_source, plan_source_ref`, `'DEFAULT', 'sub_x'`, 'org_entitlements_source_ref_ck'],
      ['PLATFORM_ADMIN without a reason', `plan_source`, `'PLATFORM_ADMIN'`, 'org_entitlements_reason_ck'],
      ['a reason with outer spaces', `plan_source, plan_reason`, `'PLATFORM_ADMIN', ' padded '`, 'org_entitlements_reason_format_ck'],
      ['a 501-character reason', `plan_source, plan_reason`, `'PLATFORM_ADMIN', repeat('r', 501)`, 'org_entitlements_reason_format_ck'],
      ['a 129-character ref', `plan_source, plan_source_ref`, `'BILLING', repeat('s', 129)`, 'org_entitlements_source_ref_length_ck'],
      ['an unknown source', `plan_source`, `'MANUAL'`, 'org_entitlements_source_ck'],
      ['last_billing_seq 0', `plan_source, plan_source_ref, last_billing_seq`, `'BILLING', 'sub_x', 0`, 'org_entitlements_billing_seq_ck'],
      ['version 0', `plan_source, version`, `'DEFAULT', 0`, 'org_entitlements_version_ck'],
    ])('INSERT with %s → 23514 %s', async (_, cols, values, constraint) => {
      await rejectsWith(insertFor(b.orgId, cols, values), '23514', constraint);
    });
    it('a new row on a retired plan → org_entitlements_plan_not_retired', async () => {
      await rejectsWith(
        inOrg(b.orgId, `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT app_current_org(), id, 'DEFAULT', now() FROM plans WHERE key = 'sch_old'`),
        '23514',
        'org_entitlements_plan_not_retired',
      );
    });
    it('a row for an organization that does not exist → 23503 org_entitlements_org_fk', async () => {
      const ghost = v7();
      await rejectsWith(
        inOrg(ghost, `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT app_current_org(), id, 'DEFAULT', now() FROM plans WHERE key = 'sch_basic'`),
        '23503',
        'org_entitlements_org_fk',
      );
    });
    it('last_billing_seq never goes back or to NULL; the same value in SET (a staff APPLIED) and a raise are allowed (K-1)', async () => {
      await rejectsWith(inOrg(a.orgId, `UPDATE org_entitlements SET last_billing_seq = 4`), '23514', 'org_entitlements_billing_seq_monotonic');
      await rejectsWith(inOrg(a.orgId, `UPDATE org_entitlements SET last_billing_seq = NULL`), '23514', 'org_entitlements_billing_seq_monotonic');
      await inOrg(a.orgId, `UPDATE org_entitlements SET last_billing_seq = COALESCE(NULL, last_billing_seq), version = version + 1`);
      await inOrg(a.orgId, `UPDATE org_entitlements SET last_billing_seq = 6`);
      expect((await readOrgEntitlement(a.orgId))?.lastBillingSeq).toBe('6');
    });
    it('moving to a retired plan is refused; an org already on a plan that becomes retired keeps it', async () => {
      await rejectsWith(
        inOrg(a.orgId, `UPDATE org_entitlements SET plan_id = (SELECT id FROM plans WHERE key = 'sch_old')`),
        '23514',
        'org_entitlements_plan_not_retired',
      );
      await owner(`UPDATE plans SET retired_at = now() WHERE key = 'sch_basic'`);
      try {
        await inOrg(a.orgId, `UPDATE org_entitlements SET plan_id = plan_id, version = version + 1, updated_at = now()`);
        expect((await readOrgEntitlement(a.orgId))?.planKey).toBe('sch_basic');
      } finally {
        await owner(`UPDATE plans SET retired_at = NULL WHERE key = 'sch_basic'`);
      }
    });
    it('org_id is not updatable by app_user (column grant)', async () => {
      await rejectsWith(inOrg(a.orgId, `UPDATE org_entitlements SET org_id = org_id`), '42501');
    });
    it('a purge that forgets the entitlements participant fails loud (23001); with it the org is gone', async () => {
      const c = await seedOrg();
      await seedOrgEntitlement(c.orgId, 'sch_other');
      const purge = (statements: readonly string[]) =>
        withAppClient((cl) =>
          inOrgTx(cl, c.orgId, async () => {
            await cl.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org()`);
            for (const sql of statements) await cl.query(sql);
          }),
        );
      await rejectsWith(purge(ORG_PURGE_STATEMENTS), '23001', 'org_entitlements_org_fk');
      await purge([...ENTITLEMENTS_PURGE_STATEMENTS, ...ORG_PURGE_STATEMENTS]);
      expect(await readOrgEntitlement(c.orgId)).toBeUndefined();
      await c.dispose();
    });
  });
});
```
Ghi chú: `c.dispose()` sau khi org đã mất là no-op an toàn (mọi câu xoá có `WHERE … = app_current_org()`; dòng `tenancy_users` của helper vẫn được dọn).

`test/integration/entitlements/isolation.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { readOrgEntitlement, seedOrgEntitlement, seedPlans } from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

describe('tenant isolation of org_entitlements through the app (spec SP4 criterion 8, DB-2)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  let disposePlans: () => Promise<void>;
  const inA = <T>(fn: () => Promise<T>) => app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) => app.get(Db).execute<T>(q, p);
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    disposePlans = await seedPlans([{ key: 'iso_plan' }]);
    a = await seedOrg();
    b = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'iso_plan');
    await seedOrgEntitlement(b.orgId, 'iso_plan');
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await disposePlans?.();
    await app?.close();
  });

  it('read/update/delete of org B from OrgScope(A) touch 0 rows and leave B unchanged', async () => {
    const before = await readOrgEntitlement(b.orgId);
    expect(await inA(() => sql('SELECT 1 FROM org_entitlements WHERE org_id = ?', [b.orgId]))).toEqual([]);
    expect(await inA(() => sql('UPDATE org_entitlements SET version = version + 1 WHERE org_id = ? RETURNING 1', [b.orgId]))).toEqual([]);
    expect(await inA(() => sql('DELETE FROM org_entitlements WHERE org_id = ? RETURNING 1', [b.orgId]))).toEqual([]);
    expect(await readOrgEntitlement(b.orgId)).toEqual(before);
  });
  it('INSERT with org_id = B from OrgScope(A) is refused by RLS', async () => {
    await expect(
      inA(() =>
        sql(`INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT ?, id, 'DEFAULT', now() FROM plans WHERE key = 'iso_plan'`, [
          b.orgId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it('without an org context the table fails closed (P0001)', async () => {
    await expect(app.get(UnitOfWork).run(() => sql('SELECT 1 FROM org_entitlements'))).rejects.toThrow(/org context is not set/);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/entitlements`
Expected: FAIL (bảng `plans` không tồn tại).

- [ ] **Step 5: Viết migration**

`src/migrations/entitlements/Migration<ts>_entitlements_core.ts` (giữ tên lớp CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 4A (spec SP4 §7.1–7.3, §7.7 dòng `…_entitlements_core`). Task 7 thêm quyền `entitlements.read` vào CUỐI `up` và
 * ĐẦU `down` của CHÍNH file này (chưa merge nên sửa được).
 *
 * Bảng chuẩn hoá (spec §7.6):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | entitlement_features | {id}, {key} | — | BCNF (`reset_period` chỉ có với QUOTA: CHECK hai chiều, vẫn là thuộc tính của khoá) |
 * | plans | {id}, {key} | — | BCNF (giá trị gói ở code, S4-D2: không có dị thường cập nhật) |
 * | org_entitlements | {org_id} | — | BCNF (`plan_source_ref`, `plan_reason` thuộc lần gán hiện tại; `last_billing_seq` là sự thật độc lập) |
 * Không phi chuẩn hoá.
 *
 * Index (mỗi cái một query): `entitlement_features_key_uq` → catalogue check lúc boot, admin (4C), join snapshot (4C);
 * `plans_key_uq` → `assign` (`LEFT JOIN plans tgt ON tgt.key = ?`), participant/subscriber (`WHERE key = ?`), catalogue
 * check; PK `org_entitlements (org_id)` → câu snapshot, khoá `FOR NO KEY UPDATE` của `assign`, đích FK của hai bảng con
 * (4B, 4C); `org_entitlements_plan_idx (plan_id)` → kiểm FK RESTRICT khi migration xoá dòng `plans` (FK từ bảng global:
 * ngoại lệ có tên B6 của SP3, không bắt đầu bằng `org_id`).
 *
 * Trigger là INVOKER (`SET search_path = pg_catalog, public`), không SECURITY DEFINER: không hoãn và chỉ đọc NEW/OLD hoặc
 * bảng global `plans` (không RLS, app_user có SELECT). Bài học 3A (definer cho trigger hoãn đọc bảng tenant dưới FORCE)
 * không áp.
 *
 * Khoá (giữ tới hết lô, `allOrNothing`): bảng mới; `SHARE ROW EXCLUSIVE` trên `organizations` (REFERENCES): chặn GHI
 * `organizations` (tạo/xoá mềm org) trong lô; đọc không bị chặn.
 */
export class Migration<ts>_entitlements_core extends Migration {
  override name = 'Migration<ts>_entitlements_core';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE entitlement_features (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    reset_period TEXT NULL,
    deprecated_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT entitlement_features_key_uq UNIQUE (key),
    CONSTRAINT entitlement_features_key_ck CHECK (key ~ '^[a-z][a-z0-9_]{0,31}\\.[a-z][a-z0-9_]{0,47}$'),
    CONSTRAINT entitlement_features_kind_ck CHECK (kind IN ('FLAG', 'LIMIT', 'QUOTA')),
    CONSTRAINT entitlement_features_reset_period_ck CHECK (reset_period IN ('NONE', 'MONTH')),
    CONSTRAINT entitlement_features_period_ck CHECK ((kind = 'QUOTA') = (reset_period IS NOT NULL)));`);
    this.addSql(`GRANT SELECT ON entitlement_features TO app_user;`);
    // Đổi loại hay kỳ làm dòng override/bộ đếm cũ mất nghĩa: cách đúng là key mới (spec §8.4). `deprecated_at` sửa được.
    this.addSql(`CREATE FUNCTION entitlements_feature_immutable() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.reset_period IS DISTINCT FROM OLD.reset_period THEN
    RAISE EXCEPTION 'the key, kind and reset period of an entitlement feature are immutable; declare a new key'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'entitlement_features_immutable';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER entitlement_features_immutable BEFORE UPDATE ON entitlement_features
    FOR EACH ROW EXECUTE FUNCTION entitlements_feature_immutable();`);

    this.addSql(`CREATE TABLE plans (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key TEXT NOT NULL,
    retired_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT plans_key_uq UNIQUE (key),
    CONSTRAINT plans_key_ck CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'));`);
    this.addSql(`GRANT SELECT ON plans TO app_user;`);
    this.addSql(`CREATE FUNCTION entitlements_plan_key_immutable() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'a plan key is immutable (prices of SP5 and code reference it)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'plans_key_immutable';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER plans_key_immutable BEFORE UPDATE OF key ON plans
    FOR EACH ROW EXECUTE FUNCTION entitlements_plan_key_immutable();`);

    this.addSql(`CREATE TABLE org_entitlements (
    org_id UUID PRIMARY KEY,
    plan_id BIGINT NOT NULL,
    plan_source TEXT NOT NULL,
    plan_source_ref TEXT NULL,
    plan_reason TEXT NULL,
    last_billing_seq BIGINT NULL,
    plan_assigned_at TIMESTAMPTZ NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_entitlements_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlements_plan_fk FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlements_source_ck CHECK (plan_source IN ('DEFAULT', 'BILLING', 'PLATFORM_ADMIN')),
    CONSTRAINT org_entitlements_source_ref_ck CHECK ((plan_source = 'BILLING') = (plan_source_ref IS NOT NULL)),
    CONSTRAINT org_entitlements_source_ref_length_ck CHECK (char_length(plan_source_ref) BETWEEN 1 AND 128),
    CONSTRAINT org_entitlements_reason_ck CHECK ((plan_source = 'PLATFORM_ADMIN') = (plan_reason IS NOT NULL)),
    CONSTRAINT org_entitlements_reason_format_ck CHECK (plan_reason = btrim(plan_reason) AND char_length(plan_reason) BETWEEN 1 AND 500),
    CONSTRAINT org_entitlements_billing_seq_ck CHECK (last_billing_seq >= 1),
    CONSTRAINT org_entitlements_version_ck CHECK (version >= 1));`);
    this.addSql(`CREATE INDEX org_entitlements_plan_idx ON org_entitlements (plan_id);`);
    this.addSql(`ALTER TABLE org_entitlements ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_entitlements FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY org_entitlements_tenant ON org_entitlements TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_entitlements TO app_user;`);
    // `FOR NO KEY UPDATE` của `assign` cần UPDATE trên ít nhất một cột; org_id, created_at không sửa được.
    this.addSql(`GRANT UPDATE (plan_id, plan_source, plan_source_ref, plan_reason, last_billing_seq, plan_assigned_at, version, updated_at)
    ON org_entitlements TO app_user;`);
    // Lớp chặn cuối của E-5 (app đã so dưới khoá). Vế `IS DISTINCT FROM` (K-1): câu APPLIED của nhân viên ghi
    // `last_billing_seq = COALESCE(NULL, last_billing_seq)` (giá trị không đổi) không bị chặn nhầm.
    this.addSql(`CREATE FUNCTION entitlements_billing_seq_monotonic() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.last_billing_seq IS DISTINCT FROM OLD.last_billing_seq AND OLD.last_billing_seq IS NOT NULL
     AND (NEW.last_billing_seq IS NULL OR NEW.last_billing_seq < OLD.last_billing_seq) THEN
    RAISE EXCEPTION 'last_billing_seq never goes back'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_entitlements_billing_seq_monotonic';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_entitlements_billing_seq_monotonic BEFORE UPDATE OF last_billing_seq ON org_entitlements
    FOR EACH ROW EXECUTE FUNCTION entitlements_billing_seq_monotonic();`);
    // Không ai gán MỚI vào gói đã retire; org đang ở gói đó giữ được (gia hạn). Gói retire chỉ bằng migration (không race).
    this.addSql(`CREATE FUNCTION entitlements_plan_not_retired() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.plan_id <> OLD.plan_id)
     AND EXISTS (SELECT 1 FROM public.plans WHERE id = NEW.plan_id AND retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a retired plan cannot be newly assigned'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_entitlements_plan_not_retired';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_entitlements_plan_not_retired BEFORE INSERT OR UPDATE OF plan_id ON org_entitlements
    FOR EACH ROW EXECUTE FUNCTION entitlements_plan_not_retired();`);
    // Cùng mẫu SP2 (`security_notice`) và 3A (`tenancy_core`): hàm mới không để EXECUTE mặc định cho PUBLIC. Trigger vẫn
    // chạy khi app_user ghi: Postgres kiểm EXECUTE của hàm trigger lúc CREATE TRIGGER (chủ là app_owner), không lúc bắn.
    this.addSql(`REVOKE ALL ON FUNCTION public.entitlements_feature_immutable(), public.entitlements_plan_key_immutable(),
    public.entitlements_billing_seq_monotonic(), public.entitlements_plan_not_retired() FROM PUBLIC;`);

    // Tính năng boilerplate (spec §8.1): `tenancy.seats` là LIMIT; `fallback`/`minimum` chỉ ở code (S4-D2).
    this.addSql(`INSERT INTO entitlement_features (key, kind) VALUES ('tenancy.seats', 'LIMIT');`);
  }

  override down(): void | Promise<void> {
    // Ngược thứ tự: bảng con trước cha; DROP TABLE xoá trigger, policy, index, grant; hàm trigger xoá riêng.
    this.addSql(`DROP TABLE org_entitlements;`);
    this.addSql(`DROP TABLE plans;`);
    this.addSql(`DROP TABLE entitlement_features;`);
    this.addSql(`DROP FUNCTION entitlements_plan_not_retired();`);
    this.addSql(`DROP FUNCTION entitlements_billing_seq_monotonic();`);
    this.addSql(`DROP FUNCTION entitlements_plan_key_immutable();`);
    this.addSql(`DROP FUNCTION entitlements_feature_immutable();`);
  }
}
```
Ghi chú mã: trong template literal TypeScript, `\\.` cho ra `\.` trong SQL; `schema.spec.ts` khẳng định `pg_get_constraintdef` chứa đúng `FEATURE_KEY_PATTERN.source`.

- [ ] **Step 6: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/database test/integration/entitlements
```
Expected: PASS. Quét tĩnh: 4 `CREATE FUNCTION` có `DROP FUNCTION` tương ứng, không `SET LOCAL ROLE` (không hàm definer); `migrations.spec.ts` round-trip + sweep từng bước trên database riêng xanh (catalog trước = sau); catalog: `org_entitlements` RLS + FORCE + policy `TO app_user`, hai bảng global trong `GLOBAL_TABLES`, grant cột đúng, tập SECURITY DEFINER không đổi; inventory khớp; DB-2, DB-3 xanh.

- [ ] **Step 7: Commit**

```bash
git add src/migrations/entitlements src/modules/entitlements/infra test/support/entitlements-catalog.ts test/support/entitlements-seed.ts test/support/tenancy-seed.ts test/integration/entitlements test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/unit/migrations/migration-order.spec.ts .dependency-cruiser.cjs
git commit -m "feat(entitlements): entitlements_core migration with lookup tables, org_entitlements under FORCE RLS and four invariant triggers"
```

---
## Phần E — Module entitlements: khung, nối composition, kiểm catalogue (spec §6, §8.3, §8.4, §14, §15, §19)

### Task 6: Khung module (chưa nối composition) — config, lỗi, event, telemetry, registry Discovery, `Entitlements`, `requireEnabled` + `EntitlementInterceptor`, repository snapshot; luật kiến trúc 20.8-a/b/c

**Files:**
- Create: `src/modules/entitlements/entitlements.config.ts`, `src/modules/entitlements/errors.ts`, `src/modules/entitlements/events.ts`, `src/modules/entitlements/permissions.ts`, `src/modules/entitlements/features.ts`, `src/modules/entitlements/entitlements-telemetry.ts`, `src/modules/entitlements/application/entitlements-metrics.ts`, `src/modules/entitlements/application/entitlement-catalogue.registry.ts`, `src/modules/entitlements/application/entitlements.service.ts`, `src/modules/entitlements/ports/org-entitlement.repository.ts`, `src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts`, `src/modules/entitlements/http/feature-metadata.ts`, `src/modules/entitlements/http/decorators.ts`, `src/modules/entitlements/http/entitlement.interceptor.ts`, `src/modules/entitlements/entitlements.module.ts`, `src/modules/entitlements/index.ts`
- Create (test): `test/unit/modules/entitlements/entitlements-config.spec.ts`, `test/unit/modules/entitlements/errors.spec.ts`, `test/unit/modules/entitlements/registry.spec.ts`, `test/unit/modules/entitlements/decorators.spec.ts`, `test/unit/modules/entitlements/entitlements-service.spec.ts`, `test/unit/modules/entitlements/entitlement-interceptor.spec.ts`, `test/integration/entitlements/snapshot-repository.spec.ts`, fixture kiến trúc `test/architecture/fixtures/src/modules/entitlements/index.ts`, `test/architecture/fixtures/src/modules/entitlements/application/deep.ts`, `test/architecture/fixtures/src/modules/tenancy/uses-entitlements.ts`, `test/architecture/fixtures/src/features/x/uses-entitlements-deep.ts`, `test/architecture/fixtures/src/plans.example.ts`
- Modify: `.dependency-cruiser.cjs`, `test/unit/architecture/rules.spec.ts`

**Interfaces:**
- Consumes: `defineConfig`, `ConfigOf` (core/config), `normalizeTimezone` (core/scheduler), `defineErrorCodes`, `AppError`, `CoreErrors`, `registerErrorMapper`, `ErrorMapper` (core/errors), `defineConstraintErrors`, `Db` (core/database), `defineEvent` (core/events), `RequestContext` (core/context), `definePermissionCatalogue`, `PermissionCatalogueContributor` (tenancy `index.ts`, 3A Task 19/21), Task 3–4 (catalogue, `resolveEffective`, `isCount`), bảng Task 5.
- Produces:
  - `entitlementsConfig` (namespace `entitlements`: `quotaTimezone` ← `ENTITLEMENTS_QUOTA_TIMEZONE` mặc định `Asia/Ho_Chi_Minh`; `rowMissingRetryAfterSec` ← `ENTITLEMENTS_ROW_MISSING_RETRY_AFTER_SEC` 1–60 mặc định 5), `type EntitlementsConfig`.
  - `errors.ts`: `EntitlementsErrors.{PLAN_RETIRED, UNKNOWN_PLAN}` (422), bảy lớp lỗi có tên (Global Constraints), `entitlementsErrorMapper` (đăng ký lúc import: `EntitlementsRowMissingError` → `503` + `Retry-After`, `EntitlementsVersionSkewError` → `503`), `featureNotInPlan(key): AppError` (403, `errors[0] = { path: 'feature', code: key }`), `quotaExceeded(key): AppError` (422, cùng hình dạng); constraint map `org_entitlements_plan_not_retired` → `plan_retired`, `org_entitlements_billing_seq_monotonic` → `validation_failed`.
  - `events.ts`: `PlanChangedEvent` (`entitlements.plan.changed@1`, data `{ orgId, fromPlan: string | null, toPlan, cause: PlanSource, causeRef: string | null }`), `ORG_ENTITLEMENT_AGGREGATE = 'org_entitlement'`.
  - `permissions.ts`: `EntitlementPermissions` (`entitlements.read`, `requires: ['org.read']`, ADMIN + MEMBER, `apiKeyEligible`, `supportEligible`).
  - `features.ts`: `BoilerplateFeatures` (`tenancy.seats`: LIMIT, `fallback: UNLIMITED`, `minimum: 1`).
  - `ENTITLEMENTS_TRACER`, `ENTITLEMENTS_METER`, `entitlementsSpan(name, fn: (span) => Promise<T>, attrsOf?)`; `EntitlementsMetrics` (`featureDenied{feature}`, `snapshotReadDuration` giây, `planAssignments{cause,result}`, `rowMissing`, `catalogueMismatch`), `type AssignmentMetricResult`.
  - `FeatureCatalogueContributor` (Discovery, tham số `FeatureCatalogueData`), `ENTITLEMENT_PLANS` (token), `EntitlementCatalogueRegistry` (gộp catalogue tính năng + kiểm catalogue gói ở lần dùng đầu hoặc `onModuleInit`, cái nào trước — không phụ thuộc thứ tự init provider; catalogue góp hai lần → ném; log INFO `entitlements_plan_fallbacks` một lần; `features()`, `feature(key)` → `UnknownFeatureError` + log ERROR, `plans()`, `has(def)`).
  - `type SnapshotRow = { version: number; planKey: string; planSource: PlanSource; planAssignedAt: Date; now: Date }`, `abstract class OrgEntitlementRepository { readSnapshot(): Promise<SnapshotRow | undefined> }` (Task 11, 12 thêm phương thức), `SqlOrgEntitlementRepository`, `SNAPSHOT_SQL`.
  - `type EntitlementSnapshot = { version; plan: { key; source; assignedAt: Date }; features: ReadonlyMap<string, EffectiveValue> }`; `Entitlements` với `snapshot()`, `isEnabled(key)`, `assertEnabled(...keys: [string, ...string[]])` (một snapshot cho mọi key; key tắt đầu tiên → `featureNotInPlan`, metric), `limitOf(key)`, `assertWithinLimit(key, currentCount, adding = 1)`.
  - `FEATURE_REQUIREMENTS`, `type FeatureRequirement = { catalogue: FeatureCatalogueData; keys: readonly string[] }` (`http/feature-metadata.ts`); `defineFeatureCatalogue<const D>(features): FeatureCatalogue<D>` với `FeatureCatalogue<D> = FeatureCatalogueData<D> & { key(k); requireEnabled(...keys: [FlagKey<D>, ...FlagKey<D>[]]) }`; `EntitlementInterceptor`.
  - `EntitlementsCoreModule.register(plans)` (`@Global`), `EntitlementsModule.forApi(plans)`, `.forWorker(plans)`; `index.ts` (public API, chưa ai import cho tới Task 7).
  - Luật depcruise `platform-modules-independent-of-entitlements` (20.8-a), `plan-catalogues-only-public-api` (20.8-c); 20.8-b = luật `features-only-public-api` sẵn có (fixture mới chứng minh).

- [ ] **Step 1: Test config, lỗi (EC-10), registry, decorator (HT-0) (fail)**

`test/unit/modules/entitlements/entitlements-config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';

const parse = (env: Record<string, unknown>) => entitlementsConfig.schema.safeParse(env);

describe('entitlements config (spec SP4 §14, R-X10)', () => {
  it('boots with no env at all', () => {
    expect(parse({}).data).toEqual({ quotaTimezone: 'Asia/Ho_Chi_Minh', rowMissingRetryAfterSec: 5 });
  });
  it.each([[{ quotaTimezone: 'Mars/Olympus' }], [{ quotaTimezone: '+07:00' }], [{ rowMissingRetryAfterSec: '0' }], [{ rowMissingRetryAfterSec: '61' }], [{ rowMissingRetryAfterSec: '1.5' }]])(
    'rejects %j',
    (env) => {
      expect(parse(env).success).toBe(false);
    },
  );
  it('accepts UTC and another IANA zone', () => {
    expect(parse({ quotaTimezone: 'UTC', rowMissingRetryAfterSec: '60' }).data).toEqual({ quotaTimezone: 'UTC', rowMissingRetryAfterSec: 60 });
  });
});
```
`test/unit/modules/entitlements/errors.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dbErrorMapper } from '../../../../src/core/database/index.js';
import { toAppError } from '../../../../src/core/errors/index.js';
import * as api from '../../../../src/modules/entitlements/index.js';

const pgError = (code: string, constraint: string): Error => Object.assign(new Error('violation'), { code, constraint });
const NAMED = [
  'EntitlementsContextError',
  'UnknownPlanError',
  'EntitlementsRowMissingError',
  'EntitlementsVersionSkewError',
  'UnknownFeatureError',
  'FeatureKindMismatchError',
  'QuotaReleaseUnderflowError',
] as const;

describe('entitlements errors (spec SP4 §6.4, §15, R-X19, EC-10)', () => {
  it('index exports the seven named error classes and EntitlementsErrors', () => {
    for (const name of NAMED) expect(typeof api[name], name).toBe('function');
    expect([api.EntitlementsErrors.PLAN_RETIRED.code, api.EntitlementsErrors.PLAN_RETIRED.status]).toEqual(['plan_retired', 422]);
    expect([api.EntitlementsErrors.UNKNOWN_PLAN.code, api.EntitlementsErrors.UNKNOWN_PLAN.status]).toEqual(['unknown_plan', 422]);
  });
  it('a missing row is 503 with Retry-After from the error; version skew is 503; programmer errors stay 500', () => {
    const missing = toAppError(new api.EntitlementsRowMissingError(7));
    expect([missing.error.code, missing.opts.headers]).toEqual(['service_unavailable', { 'Retry-After': '7' }]);
    expect(toAppError(new api.EntitlementsVersionSkewError('gold')).error.code).toBe('service_unavailable');
    for (const err of [new api.UnknownFeatureError('x.y'), new api.UnknownPlanError('gold'), new api.EntitlementsContextError('no org')])
      expect(toAppError(err).error.code).toBe('internal_error');
  });
  it('trigger names map to codes (the name never reaches the client)', () => {
    expect(dbErrorMapper(pgError('23514', 'org_entitlements_plan_not_retired'))?.error).toBe(api.EntitlementsErrors.PLAN_RETIRED);
    expect(dbErrorMapper(pgError('23514', 'org_entitlements_billing_seq_monotonic'))?.error.code).toBe('validation_failed');
  });
});
```
`test/unit/modules/entitlements/registry.spec.ts`:
```ts
import { Injectable, Logger, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENTITLEMENT_PLANS,
  EntitlementCatalogueRegistry,
  FeatureCatalogueContributor,
} from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { FeatureCatalogueError, UNLIMITED } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { PlanCatalogueError, definePlanCatalogue, type PlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { UnknownFeatureError } from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';

const A = defineFeatureCatalogue({ 'a.flag': { kind: 'FLAG', fallback: false } });
const B = defineFeatureCatalogue({ 'b.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 } });
const B2 = defineFeatureCatalogue({ 'b.seats': { kind: 'FLAG', fallback: true } });
@Injectable() @FeatureCatalogueContributor(A) class ContribA {}
@Injectable() @FeatureCatalogueContributor(B) class ContribB {}
@Injectable() @FeatureCatalogueContributor(B2) class ContribB2 {}
@Injectable() @FeatureCatalogueContributor(A) class ContribAAgain {}
@Module({ providers: [ContribA] }) class ModA {}
@Module({ providers: [ContribB] }) class ModB {}
@Module({ providers: [ContribB2] }) class ModB2 {}
const plans = definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: {} }, pro: { values: { 'a.flag': true } } } });

const boot = async (imports: Parameters<typeof Test.createTestingModule>[0]['imports'], p: PlanCatalogue = plans) => {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule, ...(imports ?? [])],
    providers: [EntitlementCatalogueRegistry, { provide: ENTITLEMENT_PLANS, useValue: p }],
  }).compile();
  await ref.init();
  return ref;
};

describe('EntitlementCatalogueRegistry (spec SP4 §8.1–8.2, S4-D1)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('merges the catalogues of two modules, knows their identity, and logs the fallback report once', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const ref = await boot([ModA, ModB]);
    const reg = ref.get(EntitlementCatalogueRegistry);
    expect([...reg.features().keys()].sort()).toEqual(['a.flag', 'b.seats']);
    expect([reg.has(A), reg.has(B), reg.has(B2)]).toEqual([true, true, false]);
    expect(reg.plans()).toBe(plans);
    expect(log).toHaveBeenCalledWith(
      { event: 'entitlements_plan_fallbacks', fallbacks: { free: ['a.flag', 'b.seats'], pro: ['b.seats'] } },
      expect.any(String),
    );
    await ref.close();
  });
  it('the same key in two modules refuses to boot', async () => {
    await expect(boot([ModB, ModB2])).rejects.toBeInstanceOf(FeatureCatalogueError);
  });
  it('the same catalogue contributed by two providers refuses to boot (no silent dedupe, as 3A)', async () => {
    await expect(boot([ModA, { module: class AAgain {}, providers: [ContribAAgain] }])).rejects.toThrow(
      /Feature catalogue \[a\.flag\] is contributed twice \(ContribA, ContribAAgain\)/,
    );
  });
  it('the merged catalogue is built on first use, independent of provider init order', async () => {
    const ref = await Test.createTestingModule({
      imports: [DiscoveryModule, ModA],
      providers: [EntitlementCatalogueRegistry, { provide: ENTITLEMENT_PLANS, useValue: plans }],
    }).compile();
    const reg = ref.get(EntitlementCatalogueRegistry);
    expect([...reg.features().keys()]).toEqual(['a.flag']);
    expect(reg.has(A)).toBe(true);
    await ref.close();
  });
  it('an invalid plan catalogue refuses to boot, listing every problem', async () => {
    const bad = definePlanCatalogue({ defaultPlan: 'gold', plans: { free: { values: { 'a.flag': { max: 1 }, 'x.nope': true } } } });
    const err: unknown = await boot([ModA, ModB], bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanCatalogueError);
    expect(err instanceof PlanCatalogueError ? [...err.problems].sort() : []).toEqual([
      'defaultPlan "gold" is not a declared plan',
      'plan "free": "a.flag" is a FLAG and needs true or false',
      'plan "free": unknown feature "x.nope"',
    ]);
  });
  it('feature(key) of an unknown key throws UnknownFeatureError', async () => {
    const ref = await boot([ModA]);
    expect(() => ref.get(EntitlementCatalogueRegistry).feature('z.nope')).toThrow(UnknownFeatureError);
    await ref.close();
  });
});
```
`test/unit/modules/entitlements/decorators.spec.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { UNLIMITED } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { FeatureKindMismatchError, UnknownFeatureError } from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import { EntitlementInterceptor } from '../../../../src/modules/entitlements/http/entitlement.interceptor.js';
import { FEATURE_REQUIREMENTS } from '../../../../src/modules/entitlements/http/feature-metadata.js';

const Cat = defineFeatureCatalogue({
  'x.flag': { kind: 'FLAG', fallback: false },
  'x.other': { kind: 'FLAG', fallback: true },
  'x.limit': { kind: 'LIMIT', fallback: UNLIMITED },
  'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 1 } },
});
@Controller('v1/orgs/:orgId/x')
class Ctl {
  @Get() @Cat.requireEnabled('x.flag', 'x.other') read() {}
}
const r = new Reflector();

describe('defineFeatureCatalogue / requireEnabled (spec SP4 §6.4, §12.3, HT-0)', () => {
  it('records the catalogue object and keys and attaches EntitlementInterceptor', () => {
    expect(r.get(FEATURE_REQUIREMENTS, Ctl.prototype.read)).toEqual([{ catalogue: Cat, keys: ['x.flag', 'x.other'] }]);
    expect(r.get(INTERCEPTORS_METADATA, Ctl.prototype.read)).toContain(EntitlementInterceptor);
  });
  it('only FLAG keys are accepted: a compile error, and a runtime error when types are bypassed', () => {
    expectTypeOf<Parameters<typeof Cat.requireEnabled>[0]>().toEqualTypeOf<'x.flag' | 'x.other'>();
    // @ts-expect-error 'x.limit' is a LIMIT
    expect(() => Cat.requireEnabled('x.limit')).toThrow(FeatureKindMismatchError);
    expect(() => Reflect.apply(Cat.requireEnabled, Cat, ['x.calls'])).toThrow(FeatureKindMismatchError);
    expect(() => Reflect.apply(Cat.requireEnabled, Cat, ['x.ghost'])).toThrow(UnknownFeatureError);
  });
  it('key() is the identity with a typed parameter', () => {
    expect(Cat.key('x.limit')).toBe('x.limit');
    // @ts-expect-error not a key of the catalogue
    expect(Cat.key('x.ghost')).toBe('x.ghost');
    expect(Cat.keys).toEqual(['x.flag', 'x.other', 'x.limit', 'x.calls']);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/entitlements-config.spec.ts test/unit/modules/entitlements/errors.spec.ts test/unit/modules/entitlements/registry.spec.ts test/unit/modules/entitlements/decorators.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Config, lỗi, event, quyền, telemetry, metric**

`src/modules/entitlements/entitlements.config.ts`:
```ts
import { z } from 'zod';
import { type ConfigOf, defineConfig } from '../../core/config/index.js';
import { normalizeTimezone } from '../../core/scheduler/index.js';

const MIN_RETRY_AFTER_SEC = 1;
const MAX_RETRY_AFTER_SEC = 60;

/** Spec SP4 §14 (R-X10): mặc định khởi động được ở cả ba AUTH_MODE với env hiện có; không trường secret (R-X16). */
export const entitlementsConfig = defineConfig(
  'entitlements',
  { quotaTimezone: 'ENTITLEMENTS_QUOTA_TIMEZONE', rowMissingRetryAfterSec: 'ENTITLEMENTS_ROW_MISSING_RETRY_AFTER_SEC' },
  z.object({
    quotaTimezone: z
      .string()
      .min(1)
      .refine((tz) => normalizeTimezone(tz) !== undefined, 'must be an IANA timezone name')
      .default('Asia/Ho_Chi_Minh')
      .describe('IANA timezone of the calendar month of MONTH quotas; changing it restarts the running period at zero (change it at a month start)'),
    rowMissingRetryAfterSec: z.coerce
      .number()
      .int()
      .min(MIN_RETRY_AFTER_SEC)
      .max(MAX_RETRY_AFTER_SEC)
      .default(5)
      .describe('Retry-After (seconds) of the 503 answered while an organization has no entitlement row yet'),
  }),
);
export type EntitlementsConfig = ConfigOf<typeof entitlementsConfig>;
```
`src/modules/entitlements/errors.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import { AppError, CoreErrors, defineErrorCodes, registerErrorMapper, type ErrorMapper } from '../../core/errors/index.js';

/** Mã do entitlements sở hữu (spec §15, cột "Chủ" = entitlements). Mã core dùng lại, không định nghĩa lại. */
export const EntitlementsErrors = defineErrorCodes({
  PLAN_RETIRED: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'The plan is retired and cannot be newly assigned' },
  UNKNOWN_PLAN: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Unknown plan' },
});

/** Tên trigger (migration `entitlements_core`) → mã; tên không bao giờ ra client. Trigger seq chỉ bắn khi code sai (log ERROR ở service). */
defineConstraintErrors({
  org_entitlements_plan_not_retired: EntitlementsErrors.PLAN_RETIRED,
  org_entitlements_billing_seq_monotonic: CoreErrors.VALIDATION_FAILED,
});

/** Thiếu UnitOfWork đang mở hoặc org context: lỗi lắp ráp (500). */
export class EntitlementsContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitlementsContextError';
  }
}
/** `planKey` không có trong catalogue gói của pod hoặc trong bảng `plans` (500; route admin 4C đổi thành 422 `unknown_plan`). */
export class UnknownPlanError extends Error {
  constructor(readonly planKey: string) {
    super(`Plan "${planKey}" is not in this pod's plan catalogue or in the plans table`);
    this.name = 'UnknownPlanError';
  }
}
/** Org không có dòng `org_entitlements` (503 + Retry-After; subscriber dự phòng tự lành, F-2). */
export class EntitlementsRowMissingError extends Error {
  constructor(readonly retryAfterSec: number) {
    super('The organization has no org_entitlements row');
    this.name = 'EntitlementsRowMissingError';
  }
}
/** Gói hiện tại của org lạ với catalogue của pod khi đọc snapshot (rolling deploy, F-6): 503. */
export class EntitlementsVersionSkewError extends Error {
  constructor(readonly planKey: string) {
    super(`The organization is on plan "${planKey}", which this pod does not know`);
    this.name = 'EntitlementsVersionSkewError';
  }
}
export class UnknownFeatureError extends Error {
  constructor(readonly featureKey: string) {
    super(`Feature "${featureKey}" is not in any registered feature catalogue`);
    this.name = 'UnknownFeatureError';
  }
}
export class FeatureKindMismatchError extends Error {
  constructor(
    readonly featureKey: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Feature "${featureKey}" is a ${actual}, the call needs ${expected}`);
    this.name = 'FeatureKindMismatchError';
  }
}
/** Trả quota nhiều hơn đã dùng (4B `Quotas.release*`): lỗi lập trình, không kẹp về 0 âm thầm. */
export class QuotaReleaseUnderflowError extends Error {
  constructor(
    readonly featureKey: string,
    readonly amount: number,
  ) {
    super(`Releasing ${amount} of "${featureKey}" would make its usage negative`);
    this.name = 'QuotaReleaseUnderflowError';
  }
}

/** Hai lỗi "chưa sẵn sàng" → 503 (F-2, F-6); mọi lớp khác rơi về 500 của `toAppError` (lỗi lập trình). */
export const entitlementsErrorMapper: ErrorMapper = (err) => {
  if (err instanceof EntitlementsRowMissingError)
    return new AppError(CoreErrors.SERVICE_UNAVAILABLE, { headers: { 'Retry-After': String(err.retryAfterSec) }, expected: true });
  if (err instanceof EntitlementsVersionSkewError) return new AppError(CoreErrors.SERVICE_UNAVAILABLE, { expected: true });
  return undefined;
};
registerErrorMapper(entitlementsErrorMapper);

const featureField = (featureKey: string, message: string) => [{ path: 'feature', code: featureKey, message }];
/** S4-D14: key tính năng ở `errors[0]` để client biết tính năng nào mà không parse `detail`. */
export const featureNotInPlan = (featureKey: string): AppError =>
  new AppError(CoreErrors.FEATURE_NOT_IN_PLAN, { fields: featureField(featureKey, CoreErrors.FEATURE_NOT_IN_PLAN.title), expected: true });
export const quotaExceeded = (featureKey: string): AppError =>
  new AppError(CoreErrors.QUOTA_EXCEEDED, { fields: featureField(featureKey, CoreErrors.QUOTA_EXCEEDED.title), expected: true });
```
`src/modules/entitlements/events.ts` — kiểm trước: `grep -n "audit" src/core/events/event-definition.ts`.
- **Nhánh A (6.0 chưa merge, `defineEvent` chỉ nhận `{ type, version, schema }`):**
```ts
import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { PLAN_SOURCES } from './constants.js';

/** Aggregate của mọi event về gói/override (spec §13.1): id = orgId, version = `org_entitlements.version`. */
export const ORG_ENTITLEMENT_AGGREGATE = 'org_entitlement';

/**
 * Spec §13.1: chỉ id/key, không PII, không văn bản tự do (`reason` của nhân viên KHÔNG vào event). Cờ `audit: true`,
 * `webhook: false` (R-X3, S4-D20): 6.0 thêm vào đây khi merge sau 4A (6.0 liệt kê file này ở bảng "sửa code của plan trước").
 */
export const PlanChangedEvent = defineEvent({
  type: 'entitlements.plan.changed',
  version: 1,
  schema: z.object({
    orgId: z.uuid(),
    fromPlan: z.string().nullable(),
    toPlan: z.string(),
    cause: z.enum(PLAN_SOURCES),
    causeRef: z.string().nullable(),
  }),
});
```
- **Nhánh B (6.0 đã merge, `defineEvent` đòi cờ):** cùng file, thêm `audit: true, webhook: false` vào đối tượng của `defineEvent` và bỏ câu "6.0 thêm vào đây" trong chú thích; Task 12 thêm test EV-10.

`src/modules/entitlements/permissions.ts`:
```ts
import { definePermissionCatalogue } from '../tenancy/index.js';

/**
 * Quyền đọc entitlement (S4-D17): tách khỏi `billing.read` (tiền, SP5). `grantTo.admin = true` làm `A = perms(ADMIN)` lớn
 * lên (SP3 §8.2): role tuỳ biến từng ⊇ A cũ thôi "tương đương admin" sau khi deploy 4A (README "nâng cấp lên SP4", X-12).
 */
export const EntitlementPermissions = definePermissionCatalogue('entitlements', {
  'entitlements.read': {
    resource: 'entitlements',
    action: 'read',
    requires: ['org.read'],
    ownerOnly: false,
    apiKeyEligible: true,
    supportEligible: true,
    grantTo: { admin: true, member: true },
  },
});
```
`src/modules/entitlements/entitlements-telemetry.ts`:
```ts
import { trace, type Attributes, type Span } from '@opentelemetry/api';
import { AppError } from '../../core/errors/index.js';

export const ENTITLEMENTS_METER = 'entitlements';
export const ENTITLEMENTS_TRACER = 'entitlements';

/**
 * Span con của span đang active (spec §19). Attribute chỉ là enum hữu hạn hoặc key tính năng (catalogue hữu hạn): không
 * org, user, `reason`, `plan_source_ref`; lỗi chỉ ghi tên class và mã `AppError` (cùng luật của `tenancySpan`). `fn` nhận
 * span để đặt attribute trên nhánh ném lỗi có chủ đích (vd. `entitlements.result = denied` trước khi ném 403).
 */
export async function entitlementsSpan<T>(name: string, fn: (span: Span) => Promise<T>, attrsOf?: (result: T) => Attributes): Promise<T> {
  return trace.getTracer(ENTITLEMENTS_TRACER).startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      if (attrsOf) span.setAttributes(attrsOf(result));
      return result;
    } catch (err) {
      const type = err instanceof Error ? err.constructor.name : typeof err;
      const code = err instanceof AppError ? err.error.code : undefined;
      span.recordException(code ? { name: type, code } : { name: type });
      span.setAttributes(code ? { 'error.type': type, 'entitlements.error_code': code } : { 'error.type': type });
      throw err;
    } finally {
      span.end();
    }
  });
}
```
`src/modules/entitlements/application/entitlements-metrics.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { ENTITLEMENTS_METER } from '../entitlements-telemetry.js';

/**
 * Tập kết quả hữu hạn của `entitlements_plan_assignments_total{cause, result}` (spec §19). `precondition_failed` (412 của
 * nhân viên, E-7) thêm vào tập của spec §19 để mọi nhánh của `assign` đều được đếm (Task 14 sửa spec).
 */
export type AssignmentMetricResult = 'applied' | 'unchanged' | 'stale' | 'rejected_retired' | 'unknown_plan' | 'row_missing' | 'precondition_failed';

/** Spec §19: không label `orgId`; `feature` là key của catalogue hữu hạn. Metric quota/ghế thuộc 4B. */
@Injectable()
export class EntitlementsMetrics {
  private readonly meter = metrics.getMeter(ENTITLEMENTS_METER);
  readonly featureDenied = this.meter.createCounter('entitlements_feature_denied_total', { description: 'Requests refused because a feature is off for the organization' });
  readonly snapshotReadDuration = this.meter.createHistogram('entitlements_snapshot_read_duration_seconds', {
    description: 'Duration of one entitlement snapshot read (the cache trigger of ADR 0018)',
    unit: 's',
  });
  readonly planAssignments = this.meter.createCounter('entitlements_plan_assignments_total', { description: 'PlanAssignments.assign outcomes by cause and result' });
  readonly rowMissing = this.meter.createCounter('entitlements_row_missing_total', { description: 'Reads of an organization without an org_entitlements row (alert)' });
  readonly catalogueMismatch = this.meter.createCounter('entitlements_catalogue_mismatch_total', { description: 'Boots refused because the catalogues differ from the database' });
}
```

- [ ] **Step 3: Registry, catalogue decorator, interceptor, service, repository**

Thứ tự trong bước này (bài học 3A: integration phải thấy RED trước): viết `test/integration/entitlements/snapshot-repository.spec.ts` (nội dung ở Step 6) và chạy `pnpm vitest run --project integration test/integration/entitlements/snapshot-repository.spec.ts` → FAIL `Cannot find module …/sql-org-entitlement.repository.js`; rồi mới tạo các file dưới đây.

`src/modules/entitlements/http/feature-metadata.ts` (tách riêng để `decorators.ts` → `entitlement.interceptor.ts` không thành vòng import):
```ts
import type { FeatureCatalogueData } from '../domain/feature-catalogue.js';

export const FEATURE_REQUIREMENTS = 'entitlements:requirements';
/** Một lần `requireEnabled` trên class hoặc method; interceptor và inventory đọc bằng `getAllAndMerge` (class + method). */
export type FeatureRequirement = { readonly catalogue: FeatureCatalogueData; readonly keys: readonly string[] };
```
`src/modules/entitlements/application/entitlement-catalogue.registry.ts`:
```ts
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { mergeFeatureCatalogues, type FeatureCatalogueData, type FeatureEntry, type MergedFeatures } from '../domain/feature-catalogue.js';
import { PlanCatalogueError, fallbackUsage, validatePlanCatalogue, type PlanCatalogue } from '../domain/plan-catalogue.js';
import { UnknownFeatureError } from '../errors.js';

/** Module/feature góp catalogue tính năng bằng decorator trên một provider singleton (cùng mẫu catalogue quyền SP3 §8.2). */
export const FeatureCatalogueContributor = DiscoveryService.createDecorator<FeatureCatalogueData>();
/** Catalogue gói của dự án, tới module qua `EntitlementsModule.forApi(plans)`/`forWorker(plans)` (S4-D2, X-7). */
export const ENTITLEMENT_PLANS = Symbol('ENTITLEMENT_PLANS');

type Registered = { readonly defs: readonly FeatureCatalogueData[]; readonly merged: MergedFeatures };

@Injectable()
export class EntitlementCatalogueRegistry implements OnModuleInit {
  private readonly logger = new Logger(EntitlementCatalogueRegistry.name);
  private registered: Registered | undefined;

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(ENTITLEMENT_PLANS) private readonly planCatalogue: PlanCatalogue,
  ) {}

  /**
   * Quét và gộp lúc boot để catalogue lỗi làm app không khởi động. `features()`/`has()` cũng tự quét ở lần gọi đầu (cùng mẫu
   * `PermissionCatalogueRegistry.load()` của 3A), nên `EntitlementCatalogueCheck.onModuleInit` không phụ thuộc thứ tự
   * init provider. Catalogue tính năng lỗi → `FeatureCatalogueError`; catalogue gói lỗi → log ERROR + `PlanCatalogueError`.
   */
  onModuleInit(): void {
    this.load();
  }

  features(): MergedFeatures {
    return this.load().merged;
  }

  feature(key: string): FeatureEntry {
    const f = this.features().get(key);
    if (f) return f;
    this.logger.error({ event: 'entitlements_unknown_feature', feature: key }, 'a feature key is not in the merged catalogue');
    throw new UnknownFeatureError(key);
  }

  plans(): PlanCatalogue {
    return this.planCatalogue;
  }

  /** Catalogue trong metadata của `requireEnabled` phải là đúng đối tượng đã đăng ký (cùng luật INT3-5a của SP3). */
  has(def: FeatureCatalogueData): boolean {
    return this.load().defs.includes(def);
  }

  private load(): Registered {
    if (this.registered) return this.registered;
    const defs: FeatureCatalogueData[] = [];
    const owners = new Map<FeatureCatalogueData, string>();
    for (const wrapper of this.discovery.getProviders({ metadataKey: FeatureCatalogueContributor.KEY })) {
      const def = this.discovery.getMetadataByDecorator(FeatureCatalogueContributor, wrapper);
      if (!def) throw new Error(`@FeatureCatalogueContributor on ${wrapper.name} must be given a catalogue`);
      if (!wrapper.isDependencyTreeStatic()) throw new Error(`@FeatureCatalogueContributor on ${wrapper.name} must be a singleton provider`);
      const owner = owners.get(def);
      // Cùng một catalogue từ hai provider (hai module, hoặc một module dynamic dựng hai lần): fail loud như 3A (0bcabd9).
      if (owner !== undefined)
        throw new Error(`Feature catalogue [${def.keys.join(', ')}] is contributed twice (${owner}, ${wrapper.name})`);
      owners.set(def, wrapper.name);
      defs.push(def);
    }
    const merged = mergeFeatureCatalogues(defs);
    const problems = validatePlanCatalogue(this.planCatalogue, merged);
    if (problems.length > 0) {
      this.logger.error({ event: 'entitlements_plan_catalogue_invalid', problems }, 'the plan catalogue is invalid');
      throw new PlanCatalogueError(problems);
    }
    this.logger.log({ event: 'entitlements_plan_fallbacks', fallbacks: fallbackUsage(this.planCatalogue, merged) }, 'features on their fallback value, per plan');
    this.registered = { defs, merged };
    return this.registered;
  }
}
```
`src/modules/entitlements/ports/org-entitlement.repository.ts`:
```ts
import type { PlanSource } from '../constants.js';

/** Một dòng `org_entitlements` + key gói + `now()` của DB (mốc hết hạn override của 4C, spec §8.4). */
export type SnapshotRow = { version: number; planKey: string; planSource: PlanSource; planAssignedAt: Date; now: Date };

/** Mọi phương thức chạy trong org context của caller (RLS); SQL vẫn ghi `org_id = app_current_org()`. */
export abstract class OrgEntitlementRepository {
  /** Một câu theo PK; không có dòng → `undefined` (service ném `EntitlementsRowMissingError`). */
  abstract readSnapshot(): Promise<SnapshotRow | undefined>;
}
```
`src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { PLAN_SOURCES } from '../../constants.js';
import { OrgEntitlementRepository, type SnapshotRow } from '../../ports/org-entitlement.repository.js';

/** Câu snapshot (spec §8.4; 4C thêm LEFT JOIN override). Index: PK `org_entitlements`, PK `plans`. */
export const SNAPSHOT_SQL = `SELECT e.version, p.key AS plan_key, e.plan_source, e.plan_assigned_at, now() AS now
FROM org_entitlements e JOIN plans p ON p.id = e.plan_id
WHERE e.org_id = app_current_org()`;
/** `Db.execute` trả TIMESTAMPTZ dạng chuỗi (bài học 3A): `z.coerce.date()`. */
const SnapshotRaw = z.object({
  version: z.coerce.number().int().min(1),
  plan_key: z.string(),
  plan_source: z.enum(PLAN_SOURCES),
  plan_assigned_at: z.coerce.date(),
  now: z.coerce.date(),
});

@Injectable()
export class SqlOrgEntitlementRepository extends OrgEntitlementRepository {
  constructor(protected readonly db: Db) {
    super();
  }

  async readSnapshot(): Promise<SnapshotRow | undefined> {
    const rows = await this.db.execute(SNAPSHOT_SQL);
    if (rows.length > 1) throw new Error(`entitlement snapshot returned ${rows.length} rows (org_entitlements PK violated?)`);
    if (rows.length === 0) return undefined;
    const r = SnapshotRaw.parse(rows[0]);
    return { version: r.version, planKey: r.plan_key, planSource: r.plan_source, planAssignedAt: r.plan_assigned_at, now: r.now };
  }
}
```
`src/modules/entitlements/application/entitlements.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import type { PlanSource } from '../constants.js';
import { isCount, type FeatureKind } from '../domain/feature-catalogue.js';
import { resolveEffective, type EffectiveValue, type Limit } from '../domain/effective-value.js';
import { entitlementsConfig } from '../entitlements.config.js';
import { entitlementsSpan } from '../entitlements-telemetry.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  EntitlementsVersionSkewError,
  FeatureKindMismatchError,
  featureNotInPlan,
  quotaExceeded,
} from '../errors.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from './entitlements-metrics.js';

const MS_PER_SEC = 1000;

export type EntitlementSnapshot = {
  readonly version: number;
  readonly plan: { readonly key: string; readonly source: PlanSource; readonly assignedAt: Date };
  readonly features: ReadonlyMap<string, EffectiveValue>;
};

const flagOf = (snapshot: EntitlementSnapshot, key: string): boolean => {
  const v = snapshot.features.get(key);
  if (v?.kind !== 'FLAG') throw new FeatureKindMismatchError(key, 'FLAG', v?.kind ?? 'missing');
  return v.enabled;
};

/**
 * Đọc/kiểm entitlement (spec §6.4, S4-D8): không cache, mỗi lần một câu snapshot theo PK trong org context của caller.
 * Mọi hàm đòi org context (OrgScope của request hoặc job có `meta.orgId`); key sai → lỗi lập trình có tên, fail loud.
 */
@Injectable()
export class Entitlements {
  private readonly logger = new Logger(Entitlements.name);

  constructor(
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY) private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  async snapshot(): Promise<EntitlementSnapshot> {
    this.requireOrg('snapshot');
    const started = performance.now();
    try {
      return await entitlementsSpan('entitlements.snapshot.read', () => this.read());
    } finally {
      this.metrics.snapshotReadDuration.record((performance.now() - started) / MS_PER_SEC);
    }
  }

  /** Chỉ FLAG. */
  async isEnabled(key: string): Promise<boolean> {
    this.requireOrg('isEnabled');
    this.requireKind(key, ['FLAG']);
    return flagOf(await this.snapshot(), key);
  }

  /** Mọi key phải bật (một snapshot cho cả tập); key tắt đầu tiên → `403 feature_not_in_plan` với key ở `errors[0]`. */
  async assertEnabled(...keys: [string, ...string[]]): Promise<void> {
    this.requireOrg('assertEnabled');
    for (const key of keys) this.requireKind(key, ['FLAG']);
    await entitlementsSpan(
      'entitlements.feature.check',
      async (span) => {
        const snapshot = await this.snapshot();
        const denied = keys.find((k) => !flagOf(snapshot, k));
        if (denied === undefined) return 'allowed' as const;
        this.metrics.featureDenied.add(1, { feature: denied });
        // Spec §19: `entitlements.result` có trên cả nhánh từ chối, không chỉ khi cho qua.
        span.setAttribute('entitlements.result', 'denied');
        throw featureNotInPlan(denied);
      },
      (result) => ({ 'entitlements.result': result }),
    );
  }

  /** LIMIT hoặc QUOTA. */
  async limitOf(key: string): Promise<Limit> {
    this.requireOrg('limitOf');
    this.requireKind(key, ['LIMIT', 'QUOTA']);
    const v = (await this.snapshot()).features.get(key);
    if (!v || v.kind === 'FLAG') throw new FeatureKindMismatchError(key, 'LIMIT or QUOTA', v?.kind ?? 'missing');
    return v.limit;
  }

  /**
   * LIMIT do module chủ tự đếm (S4-D4, spec §9.5): caller PHẢI đếm dưới khoá tuần tự hoá mọi đường thêm (README);
   * `currentCount + adding > max` → `422 quota_exceeded` với key ở `errors[0]`.
   */
  async assertWithinLimit(key: string, currentCount: number, adding = 1): Promise<void> {
    this.requireOrg('assertWithinLimit');
    this.requireKind(key, ['LIMIT']);
    if (!isCount(currentCount) || !isCount(adding, 1))
      throw new RangeError(`assertWithinLimit("${key}") needs integer counts: currentCount >= 0, adding >= 1`);
    const limit = await this.limitOf(key);
    switch (limit.kind) {
      case 'UNLIMITED':
        return;
      case 'MAX':
        if (currentCount + adding > limit.max) throw quotaExceeded(key);
        return;
      default: {
        const unknownKind: never = limit;
        throw new Error(`unknown limit kind ${String(Reflect.get(unknownKind, 'kind'))}`);
      }
    }
  }

  private requireOrg(op: string): void {
    if (this.ctx.orgId() === undefined)
      throw new EntitlementsContextError(`Entitlements.${op} needs an organization context (OrgScope, or a job with meta.orgId)`);
  }

  private requireKind(key: string, kinds: readonly FeatureKind[]): void {
    const f = this.registry.feature(key);
    if (!kinds.includes(f.kind)) throw new FeatureKindMismatchError(key, kinds.join(' or '), f.kind);
  }

  private async read(): Promise<EntitlementSnapshot> {
    const row = await this.repo.readSnapshot();
    if (!row) {
      this.metrics.rowMissing.add(1);
      this.logger.error({ event: 'entitlements_row_missing' }, 'the organization has no org_entitlements row');
      throw new EntitlementsRowMissingError(this.cfg.rowMissingRetryAfterSec);
    }
    const plan = this.registry.plans().plans.get(row.planKey);
    if (!plan) {
      this.logger.error({ event: 'entitlements_unknown_plan', planKey: row.planKey }, 'the organization is on a plan this pod does not know');
      throw new EntitlementsVersionSkewError(row.planKey);
    }
    const features = new Map<string, EffectiveValue>();
    for (const f of this.registry.features().values()) features.set(f.key, resolveEffective(f, plan.values.get(f.key), undefined, row.now));
    return { version: row.version, plan: { key: plan.key, source: row.planSource, assignedAt: row.planAssignedAt }, features };
  }
}
```
`src/modules/entitlements/http/entitlement.interceptor.ts`:
```ts
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, type Observable } from 'rxjs';
import { RequestContext } from '../../../core/context/index.js';
import { Entitlements } from '../application/entitlements.service.js';
import { EntitlementsContextError } from '../errors.js';
import { FEATURE_REQUIREMENTS, type FeatureRequirement } from './feature-metadata.js';

/**
 * Route-scoped, gắn bởi `requireEnabled` (S4-D7): Nest chạy mọi guard trước mọi interceptor, nên kiểm entitlement luôn sau
 * `PoliciesGuard` (member thiếu quyền không học được gì về gói); chạy bên trong `OrgScopeInterceptor` (global) nên đọc
 * snapshot dưới RLS mà không tự mở scope (spike S4-T1). Thiếu org context → lỗi lắp ráp (inventory Task 10 đã chặn lúc boot).
 */
@Injectable()
export class EntitlementInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContext,
    private readonly entitlements: Entitlements,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requirements = this.reflector.getAllAndMerge<FeatureRequirement[]>(FEATURE_REQUIREMENTS, [context.getHandler(), context.getClass()]);
    const [first, ...rest] = [...new Set(requirements.flatMap((r) => r.keys))];
    if (first === undefined) throw new EntitlementsContextError('EntitlementInterceptor reached a handler without requireEnabled metadata');
    if (this.ctx.orgId() === undefined || this.ctx.orgAccess() === undefined)
      throw new EntitlementsContextError('requireEnabled on a route without organization context (tenant routes only)');
    return from(this.entitlements.assertEnabled(first, ...rest)).pipe(mergeMap(() => next.handle()));
  }
}
```
Nếu spike S4-T1 **không đạt** (Task 1): inject thêm `OrgScope` và thay dòng `return` bằng `return from(this.scope.run(orgId, () => this.entitlements.assertEnabled(first, ...rest))).pipe(mergeMap(() => next.handle()));` với `const orgId = this.ctx.orgId()` đã kiểm ở trên (`OrgScope` cho vào lại cùng org).

`src/modules/entitlements/http/decorators.ts`:
```ts
import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { featureCatalogueData, type FeatureCatalogueData, type FeatureCatalogueDef, type FeatureDef } from '../domain/feature-catalogue.js';
import { FeatureKindMismatchError, UnknownFeatureError } from '../errors.js';
import { EntitlementInterceptor } from './entitlement.interceptor.js';
import { FEATURE_REQUIREMENTS, type FeatureRequirement } from './feature-metadata.js';

export type FeatureKey<D extends FeatureCatalogueDef> = Extract<keyof D, string>;
export type FlagKey<D extends FeatureCatalogueDef> = {
  [K in FeatureKey<D>]: D[K] extends { readonly kind: 'FLAG' } ? K : never;
}[FeatureKey<D>];
export type FeatureCatalogue<D extends FeatureCatalogueDef = FeatureCatalogueDef> = FeatureCatalogueData<D> & {
  /** Helper có kiểu cho `Entitlements.isEnabled(Cat.key('x.y'))`: gõ sai key là lỗi compile. */
  key<K extends FeatureKey<D>>(key: K): K;
  /** Mọi key phải bật; chỉ key FLAG (lỗi compile, và lỗi runtime khi kiểu bị vượt qua). */
  requireEnabled(...keys: [FlagKey<D>, ...FlagKey<D>[]]): MethodDecorator & ClassDecorator;
};

/**
 * Catalogue tính năng của một module/feature (spec §8.1, S4-D1). Metadata mang chính đối tượng catalogue để route
 * inventory kiểm nó đã đăng ký. Đặt ở `http/` vì cần `EntitlementInterceptor` (luật `domain-pure`).
 */
export function defineFeatureCatalogue<const D extends FeatureCatalogueDef>(features: D): FeatureCatalogue<D> {
  const catalogue: FeatureCatalogue<D> = {
    ...featureCatalogueData(features),
    key: (key) => key,
    requireEnabled: (...keys) => {
      for (const key of keys) {
        const def: FeatureDef | undefined = features[key];
        if (def === undefined) throw new UnknownFeatureError(key);
        if (def.kind !== 'FLAG') throw new FeatureKindMismatchError(key, 'FLAG', def.kind);
      }
      const requirement: FeatureRequirement = { catalogue, keys };
      return applyDecorators(SetMetadata(FEATURE_REQUIREMENTS, [requirement]), UseInterceptors(EntitlementInterceptor));
    },
  };
  return catalogue;
}
```
`src/modules/entitlements/features.ts`:
```ts
import { UNLIMITED } from './domain/feature-catalogue.js';
import { defineFeatureCatalogue } from './http/decorators.js';

/**
 * Catalogue tính năng của boilerplate (spec §8.1). `tenancy.seats` giữ hành vi SP3 bằng `fallback: UNLIMITED` (S4-D3);
 * `minimum: 1` để org luôn chứa được người tạo. Nối vào tenancy (`MemberSeatLimit`) ở 4B; `files.storage_bytes` thêm ở 4B.
 */
export const BoilerplateFeatures = defineFeatureCatalogue({
  'tenancy.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1, description: 'Members an organization may have (one seat per member)' },
});
```

- [ ] **Step 4: Module và API công khai**

`src/modules/entitlements/entitlements.module.ts`:
```ts
import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PermissionCatalogueContributor } from '../tenancy/index.js';
import { ENTITLEMENT_PLANS, EntitlementCatalogueRegistry, FeatureCatalogueContributor } from './application/entitlement-catalogue.registry.js';
import { Entitlements } from './application/entitlements.service.js';
import { EntitlementsMetrics } from './application/entitlements-metrics.js';
import type { PlanCatalogue } from './domain/plan-catalogue.js';
import { BoilerplateFeatures } from './features.js';
import { SqlOrgEntitlementRepository } from './infra/sql/sql-org-entitlement.repository.js';
import { EntitlementPermissions } from './permissions.js';
import { OrgEntitlementRepository } from './ports/org-entitlement.repository.js';
import './entitlements.config.js';
import './errors.js';
import './events.js';

@Injectable()
@FeatureCatalogueContributor(BoilerplateFeatures)
class BoilerplateFeaturesContributor {}

@Injectable()
@PermissionCatalogueContributor(EntitlementPermissions)
class EntitlementPermissionsContributor {}

/**
 * Phần dùng chung api + worker. `@Global` vì `EntitlementInterceptor` được Nest khởi tạo trong module của controller dùng
 * `requireEnabled` (controller của `features/`) và feature inject `Entitlements` (cùng lý do `TenancyCoreModule`).
 * Catalogue quyền và catalogue tính năng nằm ở CẢ HAI vai trò (SP3 §8.2 INT3-5).
 */
@Global()
@Module({})
export class EntitlementsCoreModule {
  static register(plans: PlanCatalogue): DynamicModule {
    return {
      module: EntitlementsCoreModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: ENTITLEMENT_PLANS, useValue: plans },
        EntitlementsMetrics,
        EntitlementCatalogueRegistry,
        BoilerplateFeaturesContributor,
        EntitlementPermissionsContributor,
        SqlOrgEntitlementRepository,
        { provide: OrgEntitlementRepository, useExisting: SqlOrgEntitlementRepository },
        Entitlements,
      ],
      exports: [ENTITLEMENT_PLANS, EntitlementsMetrics, EntitlementCatalogueRegistry, OrgEntitlementRepository, Entitlements],
    };
  }
}

/** Task 8 thêm catalogue check, Task 9/10 thêm HTTP (api), Task 11 thêm participant/subscriber/purge, Task 12 PlanAssignments. */
@Module({})
export class EntitlementsModule {
  static forApi(plans: PlanCatalogue): DynamicModule {
    return { module: EntitlementsModule, imports: [EntitlementsCoreModule.register(plans)] };
  }
  static forWorker(plans: PlanCatalogue): DynamicModule {
    return { module: EntitlementsModule, imports: [EntitlementsCoreModule.register(plans)] };
  }
}
```
`src/modules/entitlements/index.ts` (nhánh 7A đã merge: dòng đầu là `markModuleLoaded('entitlements')` theo đúng cách `modules/tenancy/index.ts` đang gọi, xem Task 7 Step 3):
```ts
export { EntitlementsModule } from './entitlements.module.js';
export { entitlementsConfig, type EntitlementsConfig } from './entitlements.config.js';
export {
  EntitlementsErrors,
  EntitlementsContextError,
  UnknownPlanError,
  EntitlementsRowMissingError,
  EntitlementsVersionSkewError,
  UnknownFeatureError,
  FeatureKindMismatchError,
  QuotaReleaseUnderflowError,
} from './errors.js';
export { PlanChangedEvent } from './events.js';
export { EntitlementPermissions } from './permissions.js';
export { BoilerplateFeatures } from './features.js';
export { defineFeatureCatalogue, type FeatureCatalogue } from './http/decorators.js';
export { FeatureCatalogueContributor } from './application/entitlement-catalogue.registry.js';
export { UNLIMITED, type FeatureCatalogueDef } from './domain/feature-catalogue.js';
export { definePlanCatalogue, type PlanCatalogue, type PlanCatalogueDef } from './domain/plan-catalogue.js';
export { Entitlements, type EntitlementSnapshot } from './application/entitlements.service.js';
export type { EffectiveValue, Limit } from './domain/effective-value.js';
export { PLAN_SOURCES, type PlanSource } from './constants.js';
```
Run: lệnh của Step 1.
Expected: PASS.

- [ ] **Step 5: Test service và interceptor (unit, DI thật, repository giả)**

`test/unit/modules/entitlements/entitlements-service.spec.ts`:
```ts
import { Injectable, type INestApplicationContext } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { ENTITLEMENT_PLANS, EntitlementCatalogueRegistry, FeatureCatalogueContributor } from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import { UNLIMITED } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  EntitlementsVersionSkewError,
  FeatureKindMismatchError,
  UnknownFeatureError,
} from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import { OrgEntitlementRepository, type SnapshotRow } from '../../../../src/modules/entitlements/ports/org-entitlement.repository.js';

const Features = defineFeatureCatalogue({
  'x.flag': { kind: 'FLAG', fallback: false },
  'x.seats': { kind: 'LIMIT', fallback: { max: 2 }, minimum: 1 },
  'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 100 } },
});
@Injectable() @FeatureCatalogueContributor(Features) class Contributor {}
const plans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: { free: { values: {} }, pro: { values: { 'x.flag': true, 'x.seats': UNLIMITED } } },
});
const ORG = '0198c000-0000-7000-8000-00000000000a';
const state: { orgId: string | undefined; row: SnapshotRow | undefined } = { orgId: ORG, row: undefined };
const row = (planKey: string): SnapshotRow => ({ version: 1, planKey, planSource: 'DEFAULT', planAssignedAt: new Date(), now: new Date() });

describe('Entitlements (spec SP4 §6.4, §8.4, §9.5)', () => {
  let ref: INestApplicationContext;
  let svc: Entitlements;
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        Contributor,
        EntitlementCatalogueRegistry,
        EntitlementsMetrics,
        Entitlements,
        { provide: ENTITLEMENT_PLANS, useValue: plans },
        { provide: OrgEntitlementRepository, useValue: { readSnapshot: () => Promise.resolve(state.row) } },
        { provide: RequestContext, useValue: { orgId: () => state.orgId } },
        { provide: entitlementsConfig.KEY, useValue: { quotaTimezone: 'UTC', rowMissingRetryAfterSec: 7 } },
      ],
    }).compile();
    ref = await m.init();
    svc = ref.get(Entitlements);
  });
  const on = (plan: string) => {
    state.orgId = ORG;
    state.row = row(plan);
  };

  it('snapshot resolves every feature of the merged catalogue against the plan', async () => {
    on('pro');
    const s = await svc.snapshot();
    expect(s.plan).toMatchObject({ key: 'pro', source: 'DEFAULT' });
    expect(s.features.get('x.flag')).toEqual({ kind: 'FLAG', enabled: true, source: 'PLAN' });
    expect(s.features.get('x.seats')).toEqual({ kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'PLAN' });
    expect(s.features.get('x.calls')).toEqual({ kind: 'QUOTA', limit: { kind: 'MAX', max: 100 }, resetPeriod: 'MONTH', source: 'FALLBACK' });
  });
  it('isEnabled / assertEnabled: a disabled FLAG is 403 feature_not_in_plan with the key in errors[0]', async () => {
    on('free');
    expect(await svc.isEnabled('x.flag')).toBe(false);
    const err: unknown = await svc.assertEnabled('x.flag').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    if (!(err instanceof AppError)) return;
    expect([err.error.code, err.error.status, err.opts.fields]).toEqual([
      'feature_not_in_plan',
      403,
      [{ path: 'feature', code: 'x.flag', message: 'Feature is not included in your plan' }],
    ]);
    on('pro');
    await expect(svc.assertEnabled('x.flag')).resolves.toBeUndefined();
  });
  it('limitOf and assertWithinLimit: MAX(2) allows 1 + 1, refuses 2 + 1 with 422 quota_exceeded; UNLIMITED allows anything', async () => {
    on('free');
    expect(await svc.limitOf('x.seats')).toEqual({ kind: 'MAX', max: 2 });
    await expect(svc.assertWithinLimit('x.seats', 1)).resolves.toBeUndefined();
    const err: unknown = await svc.assertWithinLimit('x.seats', 2).catch((e: unknown) => e);
    expect(err instanceof AppError ? [err.error.code, err.opts.fields?.[0]?.code] : []).toEqual(['quota_exceeded', 'x.seats']);
    on('pro');
    await expect(svc.assertWithinLimit('x.seats', 1_000_000, 5)).resolves.toBeUndefined();
  });
  it('programmer errors are named: unknown key, wrong kind, non-integer counts', async () => {
    on('free');
    await expect(svc.isEnabled('x.ghost')).rejects.toBeInstanceOf(UnknownFeatureError);
    await expect(svc.isEnabled('x.seats')).rejects.toBeInstanceOf(FeatureKindMismatchError);
    await expect(svc.limitOf('x.flag')).rejects.toBeInstanceOf(FeatureKindMismatchError);
    await expect(svc.assertWithinLimit('x.calls', 1)).rejects.toBeInstanceOf(FeatureKindMismatchError);
    await expect(svc.assertWithinLimit('x.seats', 1.5)).rejects.toBeInstanceOf(RangeError);
    await expect(svc.assertWithinLimit('x.seats', 1, 0)).rejects.toBeInstanceOf(RangeError);
  });
  it('no row → EntitlementsRowMissingError carrying Retry-After from config; unknown plan → EntitlementsVersionSkewError', async () => {
    state.orgId = ORG;
    state.row = undefined;
    const missing: unknown = await svc.snapshot().catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(EntitlementsRowMissingError);
    expect(missing instanceof EntitlementsRowMissingError ? missing.retryAfterSec : 0).toBe(7);
    state.row = row('gold');
    await expect(svc.snapshot()).rejects.toBeInstanceOf(EntitlementsVersionSkewError);
  });
  it('without an org context every call is an EntitlementsContextError, before any read', async () => {
    state.orgId = undefined;
    state.row = row('pro');
    await expect(svc.snapshot()).rejects.toBeInstanceOf(EntitlementsContextError);
    await expect(svc.assertEnabled('x.flag')).rejects.toBeInstanceOf(EntitlementsContextError);
  });
});
```
`test/unit/modules/entitlements/entitlement-interceptor.spec.ts`:
```ts
import { Controller, Get, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../../../src/core/context/index.js';
import type { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementsContextError, featureNotInPlan } from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import { EntitlementInterceptor } from '../../../../src/modules/entitlements/http/entitlement.interceptor.js';

const Cat = defineFeatureCatalogue({ 'x.a': { kind: 'FLAG', fallback: true }, 'x.b': { kind: 'FLAG', fallback: true } });
@Controller('v1/orgs/:orgId/x')
@Cat.requireEnabled('x.a')
class Ctl {
  @Get() @Cat.requireEnabled('x.b') both() {}
  @Get('bare') bare() {}
}
const ctxOf = (handler: Function): ExecutionContext =>
  ({ getHandler: () => handler, getClass: () => Ctl, getType: () => 'http' }) as Pick<ExecutionContext, 'getHandler' | 'getClass' | 'getType'> as ExecutionContext;
const reqCtx = (orgId: string | undefined, access = true) =>
  ({ orgId: () => orgId, orgAccess: () => (access ? { via: 'MEMBERSHIP', ref: 'm', permissions: [], orgDeleted: false } : undefined) }) as Pick<
    RequestContext,
    'orgId' | 'orgAccess'
  > as RequestContext;
const next = (): CallHandler & { calls: number } => {
  const h = {
    calls: 0,
    handle: () => {
      h.calls += 1;
      return of('handled');
    },
  };
  return h;
};

describe('EntitlementInterceptor (spec SP4 §12.3)', () => {
  it('checks method and class keys with one assertEnabled call, then runs the handler', async () => {
    const assertEnabled = vi.fn(() => Promise.resolve());
    const n = next();
    const i = new EntitlementInterceptor(new Reflector(), reqCtx('org-1'), { assertEnabled } as Pick<Entitlements, 'assertEnabled'> as Entitlements);
    expect(await lastValueFrom(i.intercept(ctxOf(Ctl.prototype.both), n))).toBe('handled');
    expect(assertEnabled).toHaveBeenCalledWith('x.b', 'x.a');
    expect(n.calls).toBe(1);
  });
  it('a disabled key rejects with 403 feature_not_in_plan and never runs the handler', async () => {
    const n = next();
    const i = new EntitlementInterceptor(new Reflector(), reqCtx('org-1'), {
      assertEnabled: () => Promise.reject(featureNotInPlan('x.b')),
    } as Pick<Entitlements, 'assertEnabled'> as Entitlements);
    await expect(lastValueFrom(i.intercept(ctxOf(Ctl.prototype.both), n))).rejects.toMatchObject({ error: { code: 'feature_not_in_plan' } });
    expect(n.calls).toBe(0);
  });
  it('without org context or orgAccess it is an assembly error, not a silent pass', () => {
    const e = { assertEnabled: () => Promise.resolve() } as Pick<Entitlements, 'assertEnabled'> as Entitlements;
    expect(() => new EntitlementInterceptor(new Reflector(), reqCtx(undefined), e).intercept(ctxOf(Ctl.prototype.both), next())).toThrow(EntitlementsContextError);
    expect(() => new EntitlementInterceptor(new Reflector(), reqCtx('org-1', false), e).intercept(ctxOf(Ctl.prototype.both), next())).toThrow(EntitlementsContextError);
  });
});
```
(`Ctl.prototype.bare` chỉ mang metadata của class: `getAllAndMerge` trả key `x.a` của class, ca class-only được phủ ở e2e Task 10.)
Run: `pnpm vitest run --project unit test/unit/modules/entitlements`
Expected: PASS.

- [ ] **Step 6: Repository snapshot trên Postgres thật (file test đã tạo và thấy RED ở đầu Step 3)**

`test/integration/entitlements/snapshot-repository.spec.ts`:
```ts
import { Module, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { SqlOrgEntitlementRepository } from '../../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { seedOrgEntitlement, seedPlans } from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

@Module({ providers: [SqlOrgEntitlementRepository] })
class RepoModule {}

describe('SqlOrgEntitlementRepository.readSnapshot (spec SP4 §8.4)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  let disposePlans: () => Promise<void>;
  const read = (orgId: string) => app.get(OrgScope).run(orgId, () => app.get(SqlOrgEntitlementRepository).readSnapshot());
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RepoModule]);
    disposePlans = await seedPlans([{ key: 'snap_pro' }]);
    a = await seedOrg();
    b = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'snap_pro', { source: 'BILLING', sourceRef: 'sub_9', lastBillingSeq: 3n });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await disposePlans?.();
    await app?.close();
  });

  it('reads the row of the org in scope with parsed types and the database clock', async () => {
    const s = await read(a.orgId);
    expect(s).toMatchObject({ version: 1, planKey: 'snap_pro', planSource: 'BILLING' });
    expect(s?.planAssignedAt).toBeInstanceOf(Date);
    expect(s?.now).toBeInstanceOf(Date);
  });
  it('an org without a row reads undefined, never the row of another org (RLS)', async () => {
    expect(await read(b.orgId)).toBeUndefined();
  });
  it('without an org context the read fails closed (P0001)', async () => {
    await expect(app.get(UnitOfWork).run(() => app.get(SqlOrgEntitlementRepository).readSnapshot())).rejects.toThrow(/org context is not set/);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/entitlements/snapshot-repository.spec.ts`
Expected: PASS 3/3.

- [ ] **Step 7: Luật kiến trúc 20.8-a, 20.8-b, 20.8-c kèm fixture phải fail**

`.dependency-cruiser.cjs` — thêm sau luật `tenancy-test-hooks-only-in-tenancy` (3A):
```js
    {
      name: 'platform-modules-independent-of-entitlements',
      severity: 'error',
      comment:
        'SP4 rule 20.8-a: tenancy, identity, notifications and files expose ports that entitlements plugs into, never the reverse.',
      from: { path: '(^|/)src/modules/(tenancy|identity|notifications|files)/' },
      to: { path: '(^|/)src/modules/entitlements/' },
    },
    {
      name: 'plan-catalogues-only-public-api',
      severity: 'error',
      comment:
        'SP4 rule 20.8-c: the plan catalogue (app.plans.ts, template plans.example.ts) imports only the entitlements index and feature indexes.',
      from: { path: '(^|/)src/(app[.]plans|plans[.]example)[.]ts$' },
      to: { path: '(^|/)src/', pathNot: '(^|/)src/(modules/entitlements/index|features/[^/]+/index)[.]ts$' },
    },
```
Fixture (mỗi file một dòng):
- `test/architecture/fixtures/src/modules/entitlements/index.ts`: `export const entitlementsPublicApi = true;`
- `test/architecture/fixtures/src/modules/entitlements/application/deep.ts`: `export const entitlementsInternal = true;`
- `test/architecture/fixtures/src/modules/tenancy/uses-entitlements.ts`: `import '../entitlements/index.js';`
- `test/architecture/fixtures/src/features/x/uses-entitlements-deep.ts`: `import '../../modules/entitlements/application/deep.js';`
- `test/architecture/fixtures/src/plans.example.ts`: `import './modules/entitlements/application/deep.js';`

`test/unit/architecture/rules.spec.ts` — thêm vào bảng `it.each`:
```ts
    ['platform-modules-independent-of-entitlements', 'modules/tenancy/uses-entitlements.ts'],
    // SP4 rule 20.8-b: features reach entitlements through its index only (the existing features rule covers it).
    ['features-only-public-api', 'features/x/uses-entitlements-deep.ts'],
    ['plan-catalogues-only-public-api', 'plans.example.ts'],
```
Run: `pnpm vitest run --project unit test/unit/architecture && pnpm arch`
Expected: PASS (ba fixture bị bắt; `modules-only-index-of-other-modules` vẫn chỉ bắt `tenancy/deep.ts` vì `uses-entitlements.ts` đi qua `index.ts`; cây `src` thật sạch: `entitlements → tenancy (index)` là chiều cho phép).

- [ ] **Step 8: Kiểm toàn cục, commit**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit
pnpm vitest run --project integration test/integration/entitlements
```
Expected: xanh. Module chưa được nạp vào `APP_MODULES` (Task 7), nên hành vi app không đổi.
```bash
git add src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements/snapshot-repository.spec.ts .dependency-cruiser.cjs test/unit/architecture/rules.spec.ts test/architecture/fixtures/src
git commit -m "feat(entitlements): module skeleton with catalogue registry, Entitlements service, requireEnabled interceptor and the snapshot repository"
```

---
### Task 7: Nối module vào composition + quyền `entitlements.read` trong migration; harness test của tenancy; `Entitlements` trên Postgres thật

**Files:**
- Create: `src/plans.example.ts`, `test/support/entitlement-permissions.module.ts`, `test/support/entitlements-fixtures.ts`, `test/support/entitlements-app.ts`, `test/integration/entitlements/entitlements-service.spec.ts`
- Modify: `src/migrations/entitlements/Migration<ts>_entitlements_core.ts` (cuối `up`, đầu `down`), `src/app.modules.ts` (nhánh A) hoặc `src/boilerplate.modules.ts` + `src/app.modules.ts` + `src/modules/entitlements/index.ts` + `test/unit/composition/compose.spec.ts` (+ test có danh sách module đã nạp, vd. `test/smoke/composition.smoke.spec.ts`) (nhánh B), `src/scripts/gen-env-example.ts` (nhánh A), `.env.example` (sinh lại), `test/support/tenancy-core-app.ts`, `test/support/tenancy-app.ts`, `test/integration/entitlements/schema.spec.ts`, `test/integration/tenancy/constraints.spec.ts`, `test/e2e/tenancy/orgs.e2e.spec.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: `EntitlementsModule`, `EntitlementPermissions`, `defineFeatureCatalogue`, `FeatureCatalogueContributor`, `definePlanCatalogue`, `UNLIMITED`, `Entitlements` (Task 6), `featureRowsOf`, `seedFeatures`, `seedPlans`, `seedOrgEntitlement` (Task 5), `tenancyCoreImports` (3A Task 19), `startTenancyApp` (3A Task 22), `PermissionCatalogueContributor`, `TENANCY_CATALOGUE` (3A), `installOtelCapture` (SP1 `test/support/otel-capture.ts`).
- Produces:
  - Dòng `permissions (entitlements, read)` + cạnh `permission_requires → org.read` trong migration `…_entitlements_core`; `down` xoá chúng trước mọi `DROP`.
  - `src/plans.example.ts`: `examplePlans` (`defaultPlan: 'free'`; `free` rỗng; `pro`: `'tenancy.seats': UNLIMITED`).
  - Composition: api và worker nạp `EntitlementsModule.forApi(examplePlans)`/`.forWorker(examplePlans)` sau `TenancyModule`.
  - `test/support/entitlement-permissions.module.ts`: `EntitlementPermissionsCatalogueModule` (chỉ catalogue quyền của entitlements) — `tenancyCoreImports({ entitlementPermissions = true } = {})` và `startTenancyApp(opts)` nạp nó trừ khi được truyền `entitlementPermissions: false` (trường mới `TenancyAppOpts.entitlementPermissions?: boolean`); harness của entitlements luôn truyền `false` vì `EntitlementsCoreModule` đã góp cùng catalogue (registry của 3A từ chối catalogue góp hai lần).
  - `test/support/entitlements-fixtures.ts`: `FixtureFeatures` (`fixture.reports` FLAG tắt, `fixture.exports` FLAG bật, `fixture.projects` LIMIT max 2, `fixture.api_calls` QUOTA MONTH max 100, `fixture.legacy_pdf` FLAG deprecated), `FixtureFeaturesModule`, `fixturePlans` (`free` mặc định; `pro`: reports bật, exports tắt, projects `UNLIMITED`, `tenancy.seats` max 10; `enterprise`: reports bật; `legacy` retired), `seedFixtureCatalogue(): Promise<() => Promise<void>>` (gọi TRƯỚC khi dựng app).
  - `test/support/entitlements-app.ts`: `entitlementsCoreImports(plans, extra?)` (= `tenancyCoreImports({ entitlementPermissions: false })` + `EntitlementsModule.forWorker(plans)` + `extra`).

- [ ] **Step 1: Test dòng quyền (fail)**

`test/integration/entitlements/schema.spec.ts` — thêm vào `describe('entitlement_features')` một ca:
```ts
    it('entitlements.read is seeded: API-key and support eligible, not owner-only, requiring org.read (spec SP4 S4-D17)', async () => {
      const { rows } = await owner(
        `SELECT p.owner_only, p.api_key_eligible, p.support_eligible, array_agg(q.key ORDER BY q.key) AS requires
         FROM permissions p JOIN permission_requires r ON r.permission_id = p.id JOIN permissions q ON q.id = r.required_permission_id
         WHERE p.key = 'entitlements.read' GROUP BY p.id`,
      );
      expect(rows).toEqual([{ owner_only: false, api_key_eligible: true, support_eligible: true, requires: ['org.read'] }]);
    });
```
Run: `pnpm vitest run --project integration test/integration/entitlements/schema.spec.ts`
Expected: FAIL (`rows` rỗng).

- [ ] **Step 2: Thêm quyền vào migration**

`src/migrations/entitlements/Migration<ts>_entitlements_core.ts`:
- cuối `up()`:
```ts
    // Quyền đọc entitlement (S4-D17), vòng đời "Thêm" của SP3 §8.8: bảng global không FORCE nên không cần mẫu 7 bước.
    // `CatalogueCheck` của tenancy so dòng này với `EntitlementPermissions` trong code lúc boot.
    this.addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible)
    VALUES ('entitlements', 'read', false, true, true);`);
    this.addSql(`INSERT INTO permission_requires (permission_id, required_permission_id)
SELECT p.id, r.id FROM permissions p JOIN permissions r ON r.key = 'org.read' WHERE p.key = 'entitlements.read';`);
```
- đầu `down()` (trước `DROP TABLE org_entitlements`):
```ts
    // Fail to (23001, FK RESTRICT) nếu role tuỳ biến (3B) hoặc phạm vi key/grant (3D) còn giữ quyền: runbook thu hồi trước
    // (vòng đời "Xoá" của SP3 §8.8). Không xoá âm thầm quyền đang được dùng.
    this.addSql(`DELETE FROM permission_requires WHERE permission_id = (SELECT id FROM permissions WHERE key = 'entitlements.read');`);
    this.addSql(`DELETE FROM permissions WHERE key = 'entitlements.read';`);
```
- chú thích đầu file: bỏ câu "Task 7 thêm quyền … (chưa merge nên sửa được)", thêm vào đoạn "Khoá": `INSERT permissions/permission_requires lấy ROW EXCLUSIVE (tương thích với đọc catalogue lúc boot).`
Run: `pnpm vitest run --project integration test/integration/entitlements/schema.spec.ts`
Expected: PASS.

- [ ] **Step 3: Catalogue gói mẫu và composition**

`src/plans.example.ts`:
```ts
import { UNLIMITED, definePlanCatalogue } from './modules/entitlements/index.js';

/**
 * Vùng TEMPLATE (spec SP4 S4-D22, SP7 §6.1): catalogue gói mẫu của upstream. `upstream:init` chép nguyên văn thành
 * `src/app.plans.ts` (vùng dự án; tên export giữ `examplePlans`, R-X20); dự án đặt gói thật ở bản chép, upstream không sửa bản chép. Khớp migration mẫu
 * `src/migrations/example/…_starter_plans` (hai dòng `plans`, Task 8). `free` để `tenancy.seats` ở `fallback` (không giới
 * hạn) nên hành vi SP3 (test link `N + k`, O-12…) giữ nguyên cho tới khi dự án đặt số thật.
 */
export const examplePlans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: {
    free: { values: {} },
    pro: { values: { 'tenancy.seats': UNLIMITED } },
  },
});
```
Kiểm trước: `git grep -n "composeAppModules\|markModuleLoaded" -- src` trên `main`.
- **Nhánh A (7A chưa merge; `src/app.modules.ts` là `APP_MODULES` viết tay):** `src/app.modules.ts`:
```ts
import { EntitlementsModule } from './modules/entitlements/index.js';
import { examplePlans } from './plans.example.js';
// …
/** Module nền mà dự án bật: identity + notifications + tenancy + entitlements (spec SP2 §6, SP3 §5.1, SP4 §6.2). */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [NotificationsModule.forApi(), IdentityModule.forApi(), TenancyModule.forApi(), EntitlementsModule.forApi(examplePlans)],
  worker: [NotificationsModule.forWorker(), IdentityModule.forWorker(), TenancyModule.forWorker(), EntitlementsModule.forWorker(examplePlans)],
};
```
`src/scripts/gen-env-example.ts` thêm sau dòng import config của tenancy: `import '../modules/entitlements/entitlements.config.js';`
7A khi merge sau gộp các dòng này vào composition (spec §6.2: thứ tự merge nào cũng ra cùng kết quả) và thêm `markModuleLoaded('entitlements')` (SP7 amendment D1).
- **Nhánh B (7A đã merge; có `src/boilerplate.modules.ts`):** 7A merge trước thì KHÔNG có sẵn trường `plans`, guard hay kỳ vọng test cho entitlements (7A chỉ thêm chúng ở Task 3 Step 6 khi 4A đã merge). 4A áp nguyên "công thức chuẩn" của plan 7A Task 3 Step 6 (mục 1–4; cũng ghi ở `docs/boilerplate/README.md` mục "Thêm module nền mới"). Đọc `src/boilerplate.modules.ts` và `test/unit/composition/compose.spec.ts` trước; tên lệch với dưới đây → dùng tên thật, ghi vào báo cáo task.
  1. Dòng đầu `src/modules/entitlements/index.ts`: gọi `markModuleLoaded('entitlements')` đúng như `src/modules/tenancy/index.ts` đang gọi `markModuleLoaded('tenancy')` (cùng import, trước mọi dòng `export`; R-X16).
  2. `src/boilerplate.modules.ts`:
     - thêm `import type { PlanCatalogue } from './modules/entitlements/index.js';` (chỉ kiểu, bị xoá lúc biên dịch: không import module lúc chạy);
     - trường tuỳ chọn trong `ComposeOptions` và hàm guard dùng chung (một thông điệp, một chỗ kiểm):
```ts
export type ComposeOptions<K extends string> = {
  /** Module nền dự án không dùng: không bao giờ được import, nên config, luật, queue, job, cron của nó không đăng ký. */
  disable?: readonly K[];
  /** Catalogue gói của dự án (SP4, `src/app.plans.ts`). Bắt buộc khi `entitlements` bật. */
  plans?: PlanCatalogue;
  features: AppFeatures;
};

/**
 * Tham số bắt buộc của module nền (spec SP7 §6.2 bước 1). `composeAppModules` gọi TRƯỚC khi import module nào; loader
 * gọi lại chỉ để thu hẹp kiểu (không dùng `!`), lúc đó không bao giờ ném.
 */
function requirePlans(o: { plans?: PlanCatalogue }): PlanCatalogue {
  if (!o.plans)
    throw new Error(
      'composeAppModules: "plans" is required while entitlements is enabled (docs/boilerplate/README.md "Thêm module nền mới")',
    );
  return o.plans;
}
```
     - mục `entitlements` ngay sau `tenancy` trong `BOILERPLATE_MODULES`:
```ts
  entitlements: {
    load: async (o: ComposeOptions<string>) => {
      const plans = requirePlans(o);
      const m = await import('./modules/entitlements/index.js');
      return {
        api: m.EntitlementsModule.forApi(plans),
        worker: m.EntitlementsModule.forWorker(plans),
      };
    },
  },
```
     - dòng `entitlements: ['tenancy']` trong `MODULE_REQUIRES`;
     - trong `composeAppModules`, ngay trước `appComposed = true;` (kiểm không có tác dụng phụ, nên lần gọi bị từ chối không tiêu lượt chạy duy nhất):
```ts
  if (!(opts.disable ?? []).includes('entitlements')) requirePlans(opts);
```
       (Không kiểm trong `composeFrom`: hàm đó generic, không biết `plans`; kiểm của SP7 §6.2 bước 1 nằm ở `composeAppModules`, trước mọi `import()`.)
  3. `src/app.modules.ts`: thêm `import { examplePlans } from './plans.example.js';` và `plans: examplePlans` vào lời gọi `composeAppModules({ … })` (đường dẫn giữ `./plans.example.js`: `init.mjs` của 7A đổi nó thành `./app.plans.js`).
  4. `test/unit/composition/compose.spec.ts`:
     - ca hằng `lists the boilerplate modules in import order, …`: kỳ vọng thành
```ts
    expect(Object.keys(BOILERPLATE_MODULES)).toEqual(['notifications', 'identity', 'tenancy', 'entitlements']);
    expect(MODULE_REQUIRES).toEqual({
      notifications: [],
      identity: ['notifications'],
      tenancy: ['identity'],
      entitlements: ['tenancy'],
    });
```
     - thêm import `loadedModules` từ `../../../src/core/config/index.js` (nếu chưa có), và **trước** ca `runs once per process` trong `describe('composeAppModules', …)` (ca đó tiêu lượt chạy duy nhất của process) thêm ca thiếu `plans` (UP-12 của 7A):
```ts
  it('refuses to compose while entitlements is enabled without plans, before importing anything (UP-12)', async () => {
    await expect(composeAppModules({ features: noFeatures })).rejects.toThrow('"plans" is required while entitlements is enabled');
    // Các ca `composeFrom` ở trên chỉ đánh dấu khoá fixture; không module nền nào được import.
    for (const k of Object.keys(BOILERPLATE_MODULES)) expect(loadedModules().has(k), k).toBe(false);
  });
```
       (ca `runs once per process` giữ nguyên: nó tắt mọi module nền nên không cần `plans`.)
  5. `grep -rn "'notifications', 'identity', 'tenancy'\]" test`: kỳ vọng danh sách module đã nạp của composition thật (vd. `test/smoke/composition.smoke.spec.ts` của 7A) thêm `'entitlements'` ở cuối; ca luật chéo module (`registerCompositionRules(new Set([...]))`) giữ nguyên.
  6. `gen-env-example.ts` không sửa (7A nạp mọi mục `BOILERPLATE_MODULES`).
  Run: `pnpm vitest run --project unit test/unit/composition && pnpm typecheck` → PASS, gồm ca UP-12 (viết ca UP-12 trước mục 2 để thấy RED: `composeAppModules({ features })` chưa ném).
Cả hai nhánh: không có trường secret nên không có `.meta({ secret })` nào (R-X16).

- [ ] **Step 4: Harness test của tenancy biết catalogue quyền của entitlements**

`test/support/entitlement-permissions.module.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { EntitlementPermissions } from '../../src/modules/entitlements/permissions.js';
import { PermissionCatalogueContributor } from '../../src/modules/tenancy/index.js';

@Injectable()
@PermissionCatalogueContributor(EntitlementPermissions)
class EntitlementPermissionsOnly {}

/**
 * App test của tenancy dựng không có EntitlementsModule, nhưng DB đã migrate mang `entitlements.read` (migration 4A).
 * Từ 3A Task 20b (R-X21), key chỉ có ở DB chỉ là WARN + `tenancy_catalogue_orphan_keys`, không chặn boot; module này giữ
 * app test của tenancy cùng hình dạng production (entitlements luôn được nạp nên key không bao giờ mồ côi) và không có WARN
 * đó. App nào nạp EntitlementsModule thì KHÔNG được nạp module này: `EntitlementsCoreModule` đã góp cùng đối tượng
 * catalogue, và `PermissionCatalogueRegistry` của 3A ném `Permission catalogue "entitlements" is contributed twice` khi
 * một catalogue được góp hai lần. Vì vậy `tenancyCoreImports`/`startTenancyApp` có tuỳ chọn `entitlementPermissions: false`.
 */
@Module({ providers: [EntitlementPermissionsOnly] })
export class EntitlementPermissionsCatalogueModule {}
```
`test/support/tenancy-core-app.ts` (thay hàm `tenancyCoreImports`, giữ nguyên JSDoc cũ và thêm một câu về tuỳ chọn):
```ts
import { EntitlementPermissionsCatalogueModule } from './entitlement-permissions.module.js';

/** … `entitlementPermissions: false` khi app cũng nạp `EntitlementsModule` (nó đã góp catalogue quyền của entitlements). */
export const tenancyCoreImports = ({ entitlementPermissions = true }: { entitlementPermissions?: boolean } = {}): ModuleImport[] => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: false }),
  OutboxModule.forRoot({ relay: false }),
  EventsModule.forRoot({ worker: false }),
  SchedulerModule.forRoot({ worker: false }),
  TenancyModule.forWorker(),
  ...(entitlementPermissions ? [EntitlementPermissionsCatalogueModule] : []),
];
```
`test/support/tenancy-app.ts`: `TenancyAppOpts` thêm trường
```ts
  /** Mặc định `true`; `false` khi `extraImports` có `EntitlementsModule` (catalogue quyền của nó không được góp hai lần). */
  entitlementPermissions?: boolean;
```
và trong `startTenancyApp`, `extraImports` thành
```ts
    extraImports: [
      SchedulerModule.forRoot({ worker: false }),
      nestedIn(TenancyModule.forApi(), opts.tenancyDepth ?? 0),
      ...(opts.entitlementPermissions === false ? [] : [EntitlementPermissionsCatalogueModule]),
      ...(opts.extraImports ?? []),
    ],
```
Run: `grep -rln "TenancyModule.for\(Api\|Worker\)()" test` — harness nào khác nạp `TenancyModule` mà không qua hai hàm trên và không nạp `EntitlementsModule` thì thêm `EntitlementPermissionsCatalogueModule` (cùng một dòng); harness có `EntitlementsModule` thì không.

Sửa kỳ vọng của 3A phụ thuộc số dòng `permissions` (DB giờ có thêm `entitlements.read`). Theo R-X24, tập quyền trong test tính từ catalogue lúc chạy, không viết cứng số:
- `test/integration/tenancy/constraints.spec.ts`: câu đếm cuối ca `permissions` đổi thành
```ts
      const catalogue = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM permissions WHERE key = ANY($1::text[])`, [
        [...TENANCY_CATALOGUE.keys],
      ]);
      expect(catalogue.rows).toEqual([{ n: TENANCY_CATALOGUE.keys.length }]);
```
  (import `TENANCY_CATALOGUE` từ `../../../src/modules/tenancy/domain/tenancy-catalogue.js`): đủ mọi key của tenancy, không phụ thuộc module khác thêm quyền.
- `test/e2e/tenancy/orgs.e2e.spec.ts`, ca `GET /v1/permissions lists the merged, non-deprecated catalogue`: nếu ca còn `toHaveLength(19)` viết cứng (3A chưa áp R-X24), thay bằng so với catalogue gộp của chính app:
```ts
    const expected = [...app.get(PermissionCatalogueRegistry).merged().values()].filter((e) => !e.deprecated).map((e) => e.key).sort();
    expect(r.body.data.map((x: { key: string }) => x.key).sort()).toEqual(expected);
    expect(expected).toContain('entitlements.read');
```
  (import `PermissionCatalogueRegistry` từ `../../../src/modules/tenancy/application/permission-catalogue.registry.js`); nếu 3A đã tính từ catalogue thì chỉ thêm dòng `toContain('entitlements.read')`.
- `test/smoke/tenancy.smoke.spec.ts`: dòng `expect(psql(\`SELECT count(*) FROM permissions\`)).toBe('19');` đổi thành
```ts
    expect(psql(`SELECT count(*) FROM permissions WHERE key IN (${TENANCY_CATALOGUE.keys.map((k) => `'${k}'`).join(', ')})`)).toBe(String(TENANCY_CATALOGUE.keys.length));
```
  (import `TENANCY_CATALOGUE`; nếu tên ca có số "19" thì bỏ số khỏi tên ca).
- `grep -rn "mergeCatalogues(\[TenancyPermissions\])\|mergeCatalogues(\[TENANCY_CATALOGUE\])" test/e2e test/chaos test/smoke`: chỗ nào so danh sách quyền mà API trả về với catalogue CHỈ của tenancy thì lấy catalogue gộp của chính app (`app.get(PermissionCatalogueRegistry).merged()`) thay vì dựng lại; test đơn vị (`test/unit`) giữ nguyên.

- [ ] **Step 5: Fixture catalogue, harness entitlements, test `Entitlements` trên DB thật (fail trước Step 3)**

`test/support/entitlements-fixtures.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { FeatureCatalogueContributor } from '../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { UNLIMITED } from '../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../src/modules/entitlements/domain/plan-catalogue.js';
import { defineFeatureCatalogue } from '../../src/modules/entitlements/http/decorators.js';
import { featureRowsOf, seedFeatures, seedPlans } from './entitlements-seed.js';

/** Catalogue fixture đủ ba loại, hai kỳ, một key deprecated (spec SP4 §20 "catalogue fixture"). */
export const FixtureFeatures = defineFeatureCatalogue({
  'fixture.reports': { kind: 'FLAG', fallback: false },
  'fixture.exports': { kind: 'FLAG', fallback: true },
  'fixture.projects': { kind: 'LIMIT', fallback: { max: 2 } },
  'fixture.api_calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 100 } },
  'fixture.legacy_pdf': { kind: 'FLAG', fallback: false, deprecated: true },
});
@Injectable()
@FeatureCatalogueContributor(FixtureFeatures)
class FixtureFeaturesContributor {}
@Module({ providers: [FixtureFeaturesContributor] })
export class FixtureFeaturesModule {}

/** `free`/`pro` trùng key của migration mẫu (Task 8) nên catalogue check đạt cả khi DB đã có hai dòng đó. */
export const fixturePlans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: {
    free: { values: {} },
    pro: { values: { 'fixture.reports': true, 'fixture.exports': false, 'fixture.projects': UNLIMITED, 'tenancy.seats': { max: 10 } } },
    enterprise: { values: { 'fixture.reports': true } },
    legacy: { retired: true, values: { 'fixture.reports': true } },
  },
});

/**
 * Chèn đúng các dòng DB mà `FixtureFeatures` + `fixturePlans` đòi (phép so của catalogue check, Task 8). Gọi TRƯỚC khi
 * dựng app; hàm dọn gọi SAU khi mọi org dùng các gói đó đã dispose (FK RESTRICT).
 */
export async function seedFixtureCatalogue(): Promise<() => Promise<void>> {
  const disposeFeatures = await seedFeatures(featureRowsOf(FixtureFeatures));
  const disposePlans = await seedPlans([...fixturePlans.plans.values()].map((p) => ({ key: p.key, retired: p.retired })));
  return async () => {
    await disposePlans();
    await disposeFeatures();
  };
}
```
`test/support/entitlements-app.ts`:
```ts
import type { PlanCatalogue } from '../../src/modules/entitlements/domain/plan-catalogue.js';
import { EntitlementsModule } from '../../src/modules/entitlements/index.js';
import type { ModuleImport } from './app-factory.js';
import { tenancyCoreImports } from './tenancy-core-app.js';

/**
 * Hạ tầng core + tenancy (worker) + `EntitlementsModule.forWorker(plans)`: service, participant, subscriber, purge (không
 * HTTP). `entitlementPermissions: false`: `EntitlementsCoreModule` đã góp `EntitlementPermissions`, góp thêm lần nữa thì
 * `PermissionCatalogueRegistry` từ chối boot (ca đầu của `catalogue-check.spec.ts`, Task 8, là test hồi quy của điều này).
 */
export const entitlementsCoreImports = (plans: PlanCatalogue, extra: ModuleImport[] = []): ModuleImport[] => [
  ...tenancyCoreImports({ entitlementPermissions: false }),
  EntitlementsModule.forWorker(plans),
  ...extra,
];
```
`test/integration/entitlements/entitlements-service.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError, toAppError } from '../../../src/core/errors/index.js';
import { Entitlements, EntitlementsRowMissingError, EntitlementsVersionSkewError } from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import { FixtureFeaturesModule, fixturePlans, seedFixtureCatalogue } from '../../support/entitlements-fixtures.js';
import { seedOrgEntitlement, seedPlans } from '../../support/entitlements-seed.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();

describe('Entitlements on the real database (spec SP4 §8.4, criterion 1, F-2, F-6)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const svc = () => app.get(Entitlements);
  const inOrg = <T>(orgId: string, fn: () => Promise<T>) => app.get(OrgScope).run(orgId, fn);
  const orgOn = async (plan: string | undefined) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]));
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('a pro org resolves plan values, fallbacks and the boilerplate LIMIT under RLS, in and out of a transaction', async () => {
    const o = await orgOn('pro');
    const s = await inOrg(o.orgId, () => svc().snapshot());
    expect(s.plan).toMatchObject({ key: 'pro', source: 'DEFAULT' });
    expect(Object.fromEntries(s.features)).toEqual({
      'fixture.reports': { kind: 'FLAG', enabled: true, source: 'PLAN' },
      'fixture.exports': { kind: 'FLAG', enabled: false, source: 'PLAN' },
      'fixture.projects': { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'PLAN' },
      'fixture.api_calls': { kind: 'QUOTA', limit: { kind: 'MAX', max: 100 }, resetPeriod: 'MONTH', source: 'FALLBACK' },
      'fixture.legacy_pdf': { kind: 'FLAG', enabled: false, source: 'FALLBACK' },
      'tenancy.seats': { kind: 'LIMIT', limit: { kind: 'MAX', max: 10 }, source: 'PLAN' },
    });
    expect(await inOrg(o.orgId, () => app.get(UnitOfWork).run(() => svc().isEnabled('fixture.reports')))).toBe(true);
  });
  it('a free org: a disabled FLAG is 403 feature_not_in_plan (metric labelled by feature); a full LIMIT is 422 quota_exceeded', async () => {
    const o = await orgOn('free');
    const denied: unknown = await inOrg(o.orgId, () => svc().assertEnabled('fixture.reports')).catch((e: unknown) => e);
    expect(denied instanceof AppError ? [denied.error.code, denied.opts.fields?.[0]?.code] : []).toEqual(['feature_not_in_plan', 'fixture.reports']);
    expect(await otel.metric('entitlements_feature_denied_total', { feature: 'fixture.reports' })).toBeGreaterThanOrEqual(1);
    expect(otel.spans('entitlements.feature.check').map((s) => s.attributes['entitlements.result'])).toContain('denied');
    await expect(inOrg(o.orgId, () => svc().assertWithinLimit('fixture.projects', 1))).resolves.toBeUndefined();
    const full: unknown = await inOrg(o.orgId, () => svc().assertWithinLimit('fixture.projects', 2)).catch((e: unknown) => e);
    expect(full instanceof AppError ? full.error.code : undefined).toBe('quota_exceeded');
  });
  it('criterion 1 / F-2: an org without a row → 503 + Retry-After, ERROR log, entitlements_row_missing_total; never a default plan', async () => {
    const o = await orgOn(undefined);
    const error = vi.spyOn(Logger.prototype, 'error');
    const before = (await otel.metric('entitlements_row_missing_total')) ?? 0;
    const err: unknown = await inOrg(o.orgId, () => svc().snapshot()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntitlementsRowMissingError);
    const mapped = toAppError(err);
    expect([mapped.error.status, mapped.opts.headers?.['Retry-After']]).toEqual([503, '5']);
    expect(error).toHaveBeenCalledWith({ event: 'entitlements_row_missing' }, expect.any(String));
    expect(await otel.metric('entitlements_row_missing_total')).toBe(before + 1);
    error.mockRestore();
  });
  it('F-6: an org on a plan this pod does not know → EntitlementsVersionSkewError (503), not a guess', async () => {
    const disposeGhost = await seedPlans([{ key: 'ghost_plan' }]);
    const o = await orgOn('ghost_plan');
    try {
      const err: unknown = await inOrg(o.orgId, () => svc().snapshot()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EntitlementsVersionSkewError);
      expect(toAppError(err).error.status).toBe(503);
    } finally {
      await o.dispose();
      orgs.splice(orgs.indexOf(o), 1);
      await disposeGhost();
    }
  });
});
```
(`ghost_plan` được chèn SAU khi app đã boot: catalogue check chạy một lần lúc boot; dòng được xoá trong `finally`, nên file sau boot trên DB sạch.)
Run: `pnpm vitest run --project integration test/integration/entitlements/entitlements-service.spec.ts`
Expected: PASS. (Viết file test này trước Step 2 để thấy RED: không có dòng `entitlements.read` trong DB thì `CatalogueCheck` của tenancy từ chối boot với `entitlements.read: in code, missing in the database`.)

- [ ] **Step 6: Sinh lại `.env.example`, kiểm toàn cục (api/worker thật khởi động với module mới)**

Run:
```bash
pnpm env:example && git diff --stat .env.example
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/core/entrypoints.e2e.spec.ts test/e2e/core/entrypoints-worker.e2e.spec.ts
pnpm vitest run --project integration test/integration test/e2e
```
Expected: `.env.example` thêm đúng 2 dòng `ENTITLEMENTS_*` có mô tả (nhánh B: 7A sinh từ composition, cùng kết quả); api và worker (composition thật `AppApiModule`/`AppWorkerModule`) khởi động (`CatalogueCheck` của tenancy đạt với 20 dòng, registry của entitlements đạt với `examplePlans`); toàn bộ integration + e2e của 3A xanh với harness mới.

- [ ] **Step 7: Commit**

```bash
git add src/migrations/entitlements src/plans.example.ts src/app.modules.ts src/scripts/gen-env-example.ts .env.example test/support test/integration/entitlements test/integration/tenancy/constraints.spec.ts test/e2e/tenancy/orgs.e2e.spec.ts test/smoke/tenancy.smoke.spec.ts
git commit -m "feat(entitlements): wire EntitlementsModule into api and worker with the example plan catalogue; seed entitlements.read"
```
(Nhánh B thêm `src/boilerplate.modules.ts`, `src/modules/entitlements/index.ts`, `test/unit/composition/compose.spec.ts` và test danh sách module đã sửa ở mục 5 vào `git add`.)

---

### Task 8: Migration mẫu `starter_plans` (vùng template), `EntitlementCatalogueCheck` code ↔ DB; migration data (DB-4); kiểm chứng prod-like #2

**Files:**
- Create: `src/migrations/example/Migration<ts>_starter_plans.ts` (CLI), `src/modules/entitlements/ports/catalogue.reader.ts`, `src/modules/entitlements/infra/sql/sql-entitlement-catalogue.reader.ts`, `src/modules/entitlements/application/catalogue-check.ts`
- Create (test): `test/unit/modules/entitlements/catalogue-diff.spec.ts`, `test/integration/entitlements/catalogue-check.spec.ts`, `test/integration/entitlements/migrations.spec.ts`, `test/smoke/entitlements.smoke.spec.ts`
- Modify: `src/modules/entitlements/entitlements.module.ts`

**Interfaces:**
- Consumes: `EntitlementCatalogueRegistry`, `EntitlementsMetrics`, `PlanChangedEvent` (Task 6), `examplePlans` (Task 7), `entitlementsCoreImports`, `FixtureFeaturesModule`, `fixturePlans` (Task 7), `createScratchDb` (3A Task 2), `coreMigrationList` (SP1), `runMigrations`, `parseEnvelope` (core), `toEnvelope`, `type OutboxRow` (`src/core/events/event-dispatch.handlers.ts`), `psql`, `logsSince`, `assertCleanLogs`, `workerHealth` (`test/smoke/smoke-support.ts`).
- Produces:
  - Migration `example/…_starter_plans`: `INSERT plans ('free'), ('pro')`; backfill theo mẫu 7 bước trên `ENTITLEMENT_BACKFILL_TABLES = organizations, org_entitlements` (thứ tự cố định): mọi org chưa có dòng nhận `free`/`DEFAULT` + đúng một event `entitlements.plan.changed@1` (actor `{ type: 'system', id: 'migration:starter_plans' }`); `down` từ chối (`RAISE`) khi còn dòng `plan_source <> 'DEFAULT'`, không thì xoá mọi dòng `org_entitlements` rồi hai dòng `plans`.
  - `type FeatureRow = { key; kind: FeatureKind; resetPeriod: ResetPeriod | null; deprecated: boolean }`, `type PlanRow = { key; retired: boolean }`, `abstract class EntitlementCatalogueReader { features(); plans() }`, `SqlEntitlementCatalogueReader`.
  - `entitlementsCatalogueDiff(features, featureRows, plans, planRows): string[]` (thông điệp `feature <k>: in code, missing in the database` / `in the database, missing in code` / `kind code=… db=…` / `resetPeriod code=… db=…` / `deprecated code=… db=…`; `plan <k>: …` / `retired code=… db=…`), `EntitlementCatalogueCheck` (`onModuleInit`, api + worker — cùng lý do 3A 0bcabd9: `WorkerHost`/`OutboxRelay` consume ở `onApplicationBootstrap`, nên worker lệch bị từ chối trước khi nhận job nào): lệch → metric + log ERROR `entitlements_catalogue_mismatch` + ném (app không khởi động).

- [ ] **Step 1: Test phép so catalogue (unit, fail)**

`test/unit/modules/entitlements/catalogue-diff.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { entitlementsCatalogueDiff } from '../../../../src/modules/entitlements/application/catalogue-check.js';
import { UNLIMITED, featureCatalogueData, mergeFeatureCatalogues } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import type { FeatureRow, PlanRow } from '../../../../src/modules/entitlements/ports/catalogue.reader.js';

const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: UNLIMITED },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
  }),
]);
const plans = definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: {} }, legacy: { retired: true, values: {} } } });
const featureRows: FeatureRow[] = [
  { key: 'x.flag', kind: 'FLAG', resetPeriod: null, deprecated: false },
  { key: 'x.calls', kind: 'QUOTA', resetPeriod: 'MONTH', deprecated: false },
  { key: 'x.old', kind: 'FLAG', resetPeriod: null, deprecated: true },
];
const planRows: PlanRow[] = [
  { key: 'free', retired: false },
  { key: 'legacy', retired: true },
];

describe('entitlementsCatalogueDiff (spec SP4 §8.3, EC-9)', () => {
  it('identical code and rows → no difference', () => {
    expect(entitlementsCatalogueDiff(features, featureRows, plans, planRows)).toEqual([]);
  });
  it('lists every difference by key and attribute, features then plans, sorted', () => {
    const fr: FeatureRow[] = [
      { key: 'x.flag', kind: 'LIMIT', resetPeriod: null, deprecated: false },
      { key: 'x.calls', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false },
      { key: 'x.ghost', kind: 'FLAG', resetPeriod: null, deprecated: false },
    ];
    const pr: PlanRow[] = [
      { key: 'legacy', retired: false },
      { key: 'gold', retired: false },
    ];
    expect(entitlementsCatalogueDiff(features, fr, plans, pr)).toEqual([
      'feature x.calls: resetPeriod code=MONTH db=NONE',
      'feature x.flag: kind code=FLAG db=LIMIT',
      'feature x.ghost: in the database, missing in code',
      'feature x.old: in code, missing in the database',
      'plan free: in code, missing in the database',
      'plan gold: in the database, missing in code',
      'plan legacy: retired code=true db=false',
    ]);
    expect(entitlementsCatalogueDiff(features, [...featureRows.slice(0, 2), { key: 'x.old', kind: 'FLAG', resetPeriod: null, deprecated: false }], plans, planRows)).toEqual([
      'feature x.old: deprecated code=true db=false',
    ]);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/catalogue-diff.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Reader, phép so, check; nạp vào module**

`src/modules/entitlements/ports/catalogue.reader.ts`:
```ts
import type { FeatureKind, ResetPeriod } from '../domain/feature-catalogue.js';

export type FeatureRow = { key: string; kind: FeatureKind; resetPeriod: ResetPeriod | null; deprecated: boolean };
export type PlanRow = { key: string; retired: boolean };
/** Hai bảng tra cứu global (không RLS), `app_user` chỉ SELECT; đọc lúc boot. */
export abstract class EntitlementCatalogueReader {
  abstract features(): Promise<FeatureRow[]>;
  abstract plans(): Promise<PlanRow[]>;
}
```
`src/modules/entitlements/infra/sql/sql-entitlement-catalogue.reader.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { FEATURE_KINDS, RESET_PERIODS } from '../../domain/feature-catalogue.js';
import { EntitlementCatalogueReader, type FeatureRow, type PlanRow } from '../../ports/catalogue.reader.js';

const FeatureRaw = z.object({ key: z.string(), kind: z.enum(FEATURE_KINDS), reset_period: z.enum(RESET_PERIODS).nullable(), deprecated: z.boolean() });
const PlanRaw = z.object({ key: z.string(), retired: z.boolean() });

@Injectable()
export class SqlEntitlementCatalogueReader extends EntitlementCatalogueReader {
  constructor(private readonly db: Db) {
    super();
  }
  async features(): Promise<FeatureRow[]> {
    const rows = await this.db.execute(`SELECT key, kind, reset_period, deprecated_at IS NOT NULL AS deprecated FROM entitlement_features ORDER BY key`);
    return rows.map((r) => {
      const f = FeatureRaw.parse(r);
      return { key: f.key, kind: f.kind, resetPeriod: f.reset_period, deprecated: f.deprecated };
    });
  }
  async plans(): Promise<PlanRow[]> {
    const rows = await this.db.execute(`SELECT key, retired_at IS NOT NULL AS retired FROM plans ORDER BY key`);
    return rows.map((r) => PlanRaw.parse(r));
  }
}
```
`src/modules/entitlements/application/catalogue-check.ts`:
```ts
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MergedFeatures } from '../domain/feature-catalogue.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import { EntitlementCatalogueReader, type FeatureRow, type PlanRow } from '../ports/catalogue.reader.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from './entitlements-metrics.js';

const sortedUnion = (a: Iterable<string>, b: Iterable<string>): string[] => [...new Set([...a, ...b])].sort();

/** Mọi khác biệt giữa catalogue trong code và hai bảng tra cứu (spec §8.3), tính năng rồi gói, sắp theo key. Rỗng = khớp. */
export function entitlementsCatalogueDiff(
  features: MergedFeatures,
  featureRows: readonly FeatureRow[],
  plans: PlanCatalogue,
  planRows: readonly PlanRow[],
): string[] {
  const out: string[] = [];
  const fdb = new Map(featureRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(features.keys(), fdb.keys())) {
    const code = features.get(key);
    const row = fdb.get(key);
    if (!row) out.push(`feature ${key}: in code, missing in the database`);
    else if (!code) out.push(`feature ${key}: in the database, missing in code`);
    else {
      const resetPeriod = code.kind === 'QUOTA' ? code.resetPeriod : null;
      if (code.kind !== row.kind) out.push(`feature ${key}: kind code=${code.kind} db=${row.kind}`);
      if (resetPeriod !== row.resetPeriod) out.push(`feature ${key}: resetPeriod code=${String(resetPeriod)} db=${String(row.resetPeriod)}`);
      if (code.deprecated !== row.deprecated) out.push(`feature ${key}: deprecated code=${String(code.deprecated)} db=${String(row.deprecated)}`);
    }
  }
  const pdb = new Map(planRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(plans.plans.keys(), pdb.keys())) {
    const code = plans.plans.get(key);
    const row = pdb.get(key);
    if (!row) out.push(`plan ${key}: in code, missing in the database`);
    else if (!code) out.push(`plan ${key}: in the database, missing in code`);
    else if (code.retired !== row.retired) out.push(`plan ${key}: retired code=${String(code.retired)} db=${String(row.retired)}`);
  }
  return out;
}

/**
 * Api và worker (spec §8.3, F-3): catalogue lệch DB (thiếu migration, pod lệch version) → app không khởi động (fail loud).
 * `onModuleInit`, không phải `onApplicationBootstrap` (lệch có chủ đích so với spec §8.3, Task 14 sửa spec): Nest chạy xong
 * mọi `onModuleInit` trước mọi `onApplicationBootstrap`, còn `WorkerHost` và `OutboxRelay` bắt đầu consume ở
 * `onApplicationBootstrap`; kiểm ở đó thì worker lệch đã chạy `entitlements.provision-org` trước khi chết (bài học 3A
 * Task 19, 0bcabd9). Registry tự nạp ở lần dùng đầu nên thứ tự init provider không quan trọng.
 */
@Injectable()
export class EntitlementCatalogueCheck implements OnModuleInit {
  private readonly logger = new Logger(EntitlementCatalogueCheck.name);

  constructor(
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly reader: EntitlementCatalogueReader,
    private readonly metrics: EntitlementsMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    const [featureRows, planRows] = await Promise.all([this.reader.features(), this.reader.plans()]);
    const differences = entitlementsCatalogueDiff(this.registry.features(), featureRows, this.registry.plans(), planRows);
    if (differences.length === 0) return;
    this.metrics.catalogueMismatch.add(1);
    this.logger.error({ event: 'entitlements_catalogue_mismatch', differences }, 'feature or plan catalogue in code does not match the database');
    throw new Error(`Entitlement catalogues do not match the database: ${differences.join('; ')}`);
  }
}
```
`src/modules/entitlements/entitlements.module.ts`: `EntitlementsCoreModule.register` thêm vào `providers` (sau `Entitlements`): `SqlEntitlementCatalogueReader`, `{ provide: EntitlementCatalogueReader, useExisting: SqlEntitlementCatalogueReader }`, `EntitlementCatalogueCheck` (import ba tên tương ứng).
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/catalogue-diff.spec.ts`
Expected: PASS.

- [ ] **Step 3: Test check trên DB thật và test migration mẫu (fail)**

`test/integration/entitlements/catalogue-check.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { Logger, Module, type INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../src/core/config/index.js';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule, OutboxRelay } from '../../../src/core/outbox/index.js';
import { JobQueue, QueueModule, WorkerHost } from '../../../src/core/queue/index.js';
import { RedisModule, redisClientOptions, redisConfig, redisNamespace } from '../../../src/core/redis/index.js';
import { SchedulerModule } from '../../../src/core/scheduler/index.js';
import { definePlanCatalogue } from '../../../src/modules/entitlements/domain/plan-catalogue.js';
import { EntitlementsModule } from '../../../src/modules/entitlements/index.js';
import { TenancyModule } from '../../../src/modules/tenancy/index.js';
import { examplePlans } from '../../../src/plans.example.js';
import { FixtureQueue, RecordJob, fixtureHandlers, seen } from '../../fixtures/fixture.jobs.js';
import { applyTestEnv, buildTestApp, createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import { FixtureFeaturesModule } from '../../support/entitlements-fixtures.js';
import { seedFeatures, seedPlans } from '../../support/entitlements-seed.js';

@Module({ providers: fixtureHandlers() })
class FixtureHandlers {}

const DRIFT = /feature fixture\.reports: in code, missing in the database/;

/** Queue BullMQ thô cùng connection/namespace với app (mẫu `test/integration/tenancy/catalogue-check.spec.ts` của 3A). */
function probeFixtureQueue(): Queue {
  applyTestEnv();
  return new Queue(FixtureQueue.name, {
    connection: { url: redisConfig().url, ...redisClientOptions(redisConfig(), false) },
    prefix: redisNamespace(redisConfig(), appConfig()),
  });
}

describe('EntitlementCatalogueCheck (spec SP4 §8.3, criterion 7, EC-9)', () => {
  let app: INestApplication | undefined;
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const boot = async (...args: Parameters<typeof entitlementsCoreImports>) => {
    app = await buildTestApp(entitlementsCoreImports(...args));
    return app.init();
  };

  it('the migrated database matches BoilerplateFeatures + examplePlans: the worker composition boots', async () => {
    await expect(boot(examplePlans)).resolves.toBeDefined();
  });
  it('a registered feature catalogue the migrations never seeded refuses to boot, naming the key', async () => {
    await expect(boot(examplePlans, [FixtureFeaturesModule])).rejects.toThrow(/feature fixture\.reports: in code, missing in the database/);
  });
  it('a plan row the code does not declare refuses to boot', async () => {
    cleanups.push(await seedPlans([{ key: 'cc_extra' }]));
    await expect(boot(examplePlans)).rejects.toThrow(/plan cc_extra: in the database, missing in code/);
  });
  it('a retired flag that differs refuses to boot', async () => {
    const retiredPro = definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: {} }, pro: { retired: true, values: {} } } });
    await expect(boot(retiredPro)).rejects.toThrow(/plan pro: retired code=true db=false/);
  });
  it('a feature row whose kind differs from the code refuses to boot', async () => {
    cleanups.push(await seedFeatures([{ key: 'fixture.reports', kind: 'LIMIT', resetPeriod: null, deprecated: false }]));
    await expect(boot(examplePlans, [FixtureFeaturesModule])).rejects.toThrow(/feature fixture\.reports: kind code=FLAG db=LIMIT/);
  });
  it('zero jobs consumed on entitlement catalogue drift: no Worker, no relay, the queued job still waits (3A Task 19 lesson)', async () => {
    // Job xếp hàng TRƯỚC khi worker boot, từ một producer không chạy worker (đóng trước khi worker dựng: một process chỉ có
    // một context MikroORM `app`).
    const probe = probeFixtureQueue();
    cleanups.push(() => probe.close());
    const key = `entitlements-drift-${randomUUID()}`;
    const producer = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false })]);
    const jobId = await producer
      .get(JobQueue)
      .enqueue(RecordJob, { key }, { jobId: key })
      .finally(() => producer.close());
    cleanups.push(async () => {
      await (await probe.getJob(jobId))?.remove();
    });
    expect(await probe.getJobState(jobId)).toBe('waiting');

    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const workerStarted = vi.spyOn(WorkerHost.prototype, 'onApplicationBootstrap');
    const relayStarted = vi.spyOn(OutboxRelay.prototype, 'onApplicationBootstrap');
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', FixtureQueue.name);
    // Tenancy khớp DB (EntitlementsCoreModule góp `entitlements.read`); chỉ catalogue tính năng lệch (fixture chưa seed).
    app = await buildTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: false }),
      SchedulerModule.forRoot({ worker: false }),
      TenancyModule.forWorker(),
      EntitlementsModule.forWorker(examplePlans),
      FixtureHandlers,
      FixtureFeaturesModule,
    ]);

    await expect(app.init()).rejects.toThrow(DRIFT);
    // `EntitlementCatalogueCheck` chạy ở `onModuleInit`: mọi `onModuleInit` xong trước mọi `onApplicationBootstrap`, nên
    // WorkerHost chưa tạo BullMQ Worker nào và relay chưa claim dòng outbox nào khi boot bị từ chối (tất định).
    expect(workerStarted).not.toHaveBeenCalled();
    expect(relayStarted).not.toHaveBeenCalled();
    expect(await probe.getJobState(jobId)).toBe('waiting');
    expect(seen.some((x) => x.key === key)).toBe(false);
  });
});
```
(Hai ca có `FixtureFeaturesModule` mà không seed đủ dòng sẽ báo thêm các key fixture khác; regex chỉ neo vào key được kiểm. Ca đầu còn là test hồi quy của C1: `entitlementsCoreImports` nạp tenancy với `entitlementPermissions: false`; nếu catalogue quyền của entitlements bị góp hai lần, `PermissionCatalogueRegistry` ném `is contributed twice` và ca này đỏ. Ca cuối chép mẫu ca "a drifted worker refuses to boot before it consumes anything" của 3A; kiểm trước `grep -n "export" test/fixtures/fixture.jobs.ts src/core/redis/index.ts` rằng `FixtureQueue`, `RecordJob`, `fixtureHandlers`, `seen`, `redisClientOptions`, `redisNamespace` vẫn là tên thật.)

Tạo migration: `pnpm exec mikro-orm migration:create --blank --path src/migrations/example --name starter_plans` (timestamp lớn hơn `…_entitlements_core`).

`test/integration/entitlements/migrations.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../src/core/database/index.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import { toEnvelope, type OutboxRow } from '../../../src/core/events/event-dispatch.handlers.js';
import { PlanChangedEvent } from '../../../src/modules/entitlements/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { readOrgEntitlement } from '../../support/entitlements-seed.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedOrg, withAppClient } from '../../support/tenancy-seed.js';

const OUTBOX_SQL = `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
  aggregate_version::text AS aggregate_version, payload, headers, occurred_at
  FROM outbox_events WHERE type = 'entitlements.plan.changed' AND org_id = ANY($1::uuid[]) ORDER BY org_id`;

/**
 * Spec SP4 §7.7 dòng `example/…_starter_plans`, DB-4: backfill org có sẵn trước SP4 (mẫu 7 bước), event parse được, FORCE
 * bật lại, down không làm mất gán của billing/nhân viên. Database riêng: org được seed TRƯỚC migration mẫu.
 */
describe('starter plans migration (template zone, spec SP4 §7.7, DB-4)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let beforeStarter: string;
  const orgIds: string[] = [];
  const force = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{ relname: string; f: boolean }>(
          `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('organizations', 'org_entitlements') ORDER BY relname`,
        )
      ).rows;
    } finally {
      await c.end();
    }
  };
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('starter');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_starter_plans'));
    if (at < 1) throw new Error('starter_plans migration not found');
    list = all.slice(0, at + 1);
    beforeStarter = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list: all.slice(0, at) } });
    for (let i = 0; i < 2; i++) orgIds.push((await seedOrg({ database: db.name })).orgId);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('backfills every existing org with free/DEFAULT and exactly one plan.changed event each, parsed by PlanChangedEvent; FORCE is back', async () => {
    await runMigrations('up', { source: { kind: 'list', list } });
    for (const id of orgIds)
      expect(await readOrgEntitlement(id, db.name)).toEqual({ planKey: 'free', source: 'DEFAULT', sourceRef: null, reason: null, lastBillingSeq: null, version: 1 });
    const c = await db.client('owner');
    try {
      const { rows } = await c.query<OutboxRow>(OUTBOX_SQL, [orgIds]);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const e = parseEnvelope(PlanChangedEvent, toEnvelope(row));
        expect(e.data).toEqual({ orgId: row.org_id, fromPlan: null, toPlan: 'free', cause: 'DEFAULT', causeRef: null });
        expect([e.actor, e.aggregate]).toEqual([
          { type: 'system', id: 'migration:starter_plans' },
          { type: 'org_entitlement', id: row.org_id, version: 1 },
        ]);
      }
      expect((await c.query(`SELECT key FROM plans ORDER BY key`)).rows).toEqual([{ key: 'free' }, { key: 'pro' }]);
    } finally {
      await c.end();
    }
    expect(await force()).toEqual([
      { relname: 'org_entitlements', f: true },
      { relname: 'organizations', f: true },
    ]);
  });
  it('down refuses while an org has a plan assigned by billing, leaving the database unchanged', async () => {
    const [first] = orgIds;
    if (!first) throw new Error('no seeded org');
    await withAppClient(
      (c) => inOrgTx(c, first, () => c.query(`UPDATE org_entitlements SET plan_source = 'BILLING', plan_source_ref = 'sub_1', last_billing_seq = 1`)),
      db.name,
    );
    await expect(runMigrations('down', { source: { kind: 'list', list }, to: beforeStarter })).rejects.toThrow(
      /assigned by billing or platform staff/,
    );
    expect((await readOrgEntitlement(first, db.name))?.source).toBe('BILLING');
    expect(await force()).toEqual([
      { relname: 'org_entitlements', f: true },
      { relname: 'organizations', f: true },
    ]);
  });
  it('once every row is DEFAULT again the down removes the rows and the two plans', async () => {
    const [first] = orgIds;
    if (!first) throw new Error('no seeded org');
    await withAppClient(
      (c) => inOrgTx(c, first, () => c.query(`UPDATE org_entitlements SET plan_source = 'DEFAULT', plan_source_ref = NULL`)),
      db.name,
    );
    await expect(runMigrations('down', { source: { kind: 'list', list }, to: beforeStarter })).resolves.toEqual([list.at(-1)!.name]);
    for (const id of orgIds) expect(await readOrgEntitlement(id, db.name)).toBeUndefined();
    const c = await db.client('owner');
    try {
      expect((await c.query(`SELECT count(*)::int AS n FROM plans`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await c.end();
    }
  });
});
```
**Ca có điều kiện (DB-4 "down của 4A fail to khi còn role tuỳ biến giữ `entitlements.read`"):** cần bảng `org_role_permissions` của 3B (cùng sóng W2, có thể chưa merge). Lúc thực thi: `git grep -n "org_role_permissions" src/migrations` trên `main`.
- Có (3B đã merge): thêm vào file trên một `describe` riêng trên database riêng khác (`createScratchDb('coredown')`): migrate toàn bộ, seed org + role tuỳ biến giữ `entitlements.read` bằng helper seed role tuỳ biến mà 3B để lại trong `test/support/` (tên lấy từ khối "Produces" của plan 3B), rồi `runMigrations('down', { to: <migration ngay trước …_entitlements_core> })` → `rejects.toThrow(/23001|violates foreign key/)` và `SELECT 1 FROM permissions WHERE key = 'entitlements.read'` vẫn còn một dòng.
- Chưa có: không viết ca này (không commit test `skip` vô điều kiện); ghi "DB-4 down-refusal với role tuỳ biến: carry sang 4B" vào báo cáo task và vào mô tả PR (4B phụ thuộc 3C ⊇ 3B nên chạy được chắc chắn).

Run: `pnpm vitest run --project integration test/integration/entitlements/catalogue-check.spec.ts test/integration/entitlements/migrations.spec.ts`
Expected: FAIL (check chưa nạp thì ca "refuses" resolve; migration mẫu rỗng thì không backfill).

- [ ] **Step 4: Viết migration mẫu**

`src/migrations/example/Migration<ts>_starter_plans.ts` (giữ tên lớp CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Vùng TEMPLATE (spec SP4 S4-D22, §7.7): gói khởi đầu khớp `src/plans.example.ts`. Upstream chạy nó trong CI như mọi
 * migration (migrator đọc đệ quy `dist/migrations/**`); clone nhận bản chép ở `src/migrations/app/<timestamp mới>_starter_plans`
 * lúc `upstream:init` và sửa theo gói thật. Dự án clone mới (chưa có org) chạy backfill trên bảng rỗng: không đổi gì.
 *
 * Mẫu 7 bước SP3 §8.8 trên `ENTITLEMENT_BACKFILL_TABLES = organizations, org_entitlements` (thứ tự cố định): `app_owner` không
 * có policy nào nên dưới FORCE nó thấy 0 org và backfill âm thầm không làm gì. Event: một `entitlements.plan.changed@1` mỗi
 * dòng vừa chèn (CTE `RETURNING`), envelope dựng bằng SQL theo cột `outbox_events`, actor `system`
 * `migration:starter_plans`; test contract parse bằng `parseEnvelope(PlanChangedEvent, …)`. Nếu SP6 6.0 đã lưu cờ
 * `audit`/`webhook` trong cột outbox, câu INSERT ghi đúng cờ của `PlanChangedEvent` (Task 8 Step 4 nhánh B).
 *
 * Khoá: `ACCESS EXCLUSIVE` ngắn trên `organizations` và `org_entitlements` (NO FORCE/FORCE) tới hết lô: chặn câu đường nóng
 * của SP3 §7.3 trong lô. Runbook (README): cửa sổ ít tải, `lock_timeout` của migrator.
 * Down: từ chối khi còn gán `BILLING`/`PLATFORM_ADMIN` (không mất dữ liệu âm thầm); dòng `DEFAULT` dẫn xuất lại được nên xoá.
 */
export class Migration<ts>_starter_plans extends Migration {
  override name = 'Migration<ts>_starter_plans';

  override up(): void | Promise<void> {
    this.addSql(`INSERT INTO plans (key) VALUES ('free'), ('pro');`);
    // Bước 2: bỏ FORCE, mỗi bảng một câu, thứ tự cố định.
    this.addSql(`ALTER TABLE public.organizations NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE public.org_entitlements NO FORCE ROW LEVEL SECURITY;`);
    // Bước 3: DML + event cùng câu (version của aggregate = version sau khi chèn).
    this.addSql(`WITH inserted AS (
  INSERT INTO public.org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
  SELECT o.id, p.id, 'DEFAULT', now() FROM public.organizations o CROSS JOIN public.plans p WHERE p.key = 'free'
  ON CONFLICT (org_id) DO NOTHING
  RETURNING org_id, version)
INSERT INTO public.outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
SELECT uuidv7(), 'entitlements.plan.changed', 1, i.org_id, 'org_entitlement', i.org_id::text, i.version,
       jsonb_build_object('orgId', i.org_id, 'fromPlan', NULL, 'toPlan', 'free', 'cause', 'DEFAULT', 'causeRef', NULL),
       jsonb_build_object('actorType', 'system', 'actorId', 'migration:starter_plans', 'correlationId', 'migration:starter_plans')
FROM inserted i;`);
    this.flushDeferredByName();
    this.restoreDeclaredModes();
    // Bước 6: bật lại FORCE, cùng tập, cùng thứ tự.
    this.addSql(`ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE public.org_entitlements FORCE ROW LEVEL SECURITY;`);
    // Bước 7 (inline: `migration-scan.spec.ts` đòi khối này nằm trong thân `up` sau `NO FORCE` cuối cùng).
    this.addSql(`DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`ALTER TABLE public.organizations NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE public.org_entitlements NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_entitlements WHERE plan_source <> 'DEFAULT') THEN
    RAISE EXCEPTION 'organizations have plans assigned by billing or platform staff; reverting the starter plans would lose them';
  END IF;
END $$;`);
    this.addSql(`DELETE FROM public.org_entitlements;`);
    this.flushDeferredByName();
    this.restoreDeclaredModes();
    this.addSql(`ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE public.org_entitlements FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`);
    this.addSql(`DELETE FROM plans WHERE key IN ('free', 'pro');`);
  }

  /** Bước 4: xả trigger hoãn khi `app_owner` còn thấy dòng; tên deferrable phải duy nhất theo schema; không bao giờ `ALL`. */
  private flushDeferredByName(): void {
    this.addSql(`DO $$ DECLARE r record; BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname IN ('public', 'auth')
             GROUP BY c.connamespace, c.conname HAVING count(*) > 1 AND bool_or(c.condeferrable)) THEN
    RAISE EXCEPTION 'a deferrable constraint name must be unique per schema';
  END IF;
  FOR r IN SELECT n.nspname, c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I IMMEDIATE', r.nspname, r.conname);
  END LOOP;
END $$;`);
  }

  /** Bước 5: trả từng constraint deferrable về chế độ khai báo (không rò sang migration sau trong lô). */
  private restoreDeclaredModes(): void {
    this.addSql(`DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.conname, c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I %s', r.nspname, r.conname, CASE WHEN r.condeferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END);
  END LOOP;
END $$;`);
  }
}
```
Hai helper bước 4/5 nằm sau `down` trong lớp: bộ quét (cắt thân theo `override up(`/`override down(`) chỉ đòi khối khẳng định FORCE nằm trong thân `up`/`down` sau `NO FORCE` cuối, nên khối bước 7 viết inline ở cả hai chỗ.

**Nhánh B (SP6 6.0 đã merge và lưu cờ event trong cột của `outbox_events`):** kiểm `\d outbox_events` trên DB test (`pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts` không đủ; dùng `psql` của container test hoặc đọc migration 6.0). Nếu có cột cờ, thêm cột đó vào danh sách cột và `SELECT` của câu INSERT với đúng giá trị `PlanChangedEvent.audit`/`.webhook` (`true`/`false`), và ca đầu của `migrations.spec.ts` thêm `expect(row.<cột>).toEqual(PlanChangedEvent.<cờ>)`. Nếu 6.0 chỉ lưu cờ trong định nghĩa (không trong DB), không đổi gì.

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations test/unit/modules/entitlements
pnpm vitest run --project integration test/integration/core/database test/integration/entitlements
pnpm vitest run --project integration test/e2e/core/entrypoints.e2e.spec.ts test/e2e/core/entrypoints-worker.e2e.spec.ts
```
Expected: PASS. Quét tĩnh: `NO FORCE` ở cả `up` và `down` đều có khối khẳng định sau nó; không `SET CONSTRAINTS ALL`; round-trip + sweep từng bước trên database riêng xanh (sweep chạy `down` của migration mẫu trên DB không có org: không `RAISE`); api/worker thật khởi động với catalogue check đạt (DB có `free`, `pro`, `tenancy.seats`).

- [ ] **Step 6: Prod-like #2 — schema 4A + catalogue check từ `dist` trên image thật**

`test/smoke/entitlements.smoke.spec.ts`:
```ts
import { describe, expect, inject, it } from 'vitest';
import { assertCleanLogs, logsSince, psql, workerHealth } from './smoke-support.js';

/**
 * Plan 4A trên image production (`NODE_ENV=production`, `docker compose --profile app`). Task 8: schema + catalogue check
 * chạy từ `dist`; Task 13 thêm luồng HTTP (đăng ký → tạo org → GET entitlements → xoá mềm).
 */
describe('prod-like smoke: plan 4A', () => {
  const { apiUrl } = inject('smoke');
  const bootEpoch = new Date(0).toISOString();

  it('the 4A migrations ran from dist: two starter plans, tenancy.seats, FORCE RLS on org_entitlements, entitlements.read → org.read, four triggers', () => {
    expect(psql(`SELECT string_agg(key || ':' || (retired_at IS NULL)::text, ',' ORDER BY key) FROM plans`)).toBe('free:true,pro:true');
    expect(psql(`SELECT string_agg(key || ':' || kind, ',' ORDER BY key) FROM entitlement_features`)).toBe('tenancy.seats:LIMIT');
    expect(psql(`SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_class WHERE relname = 'org_entitlements'`)).toBe('true:true');
    expect(
      psql(
        `SELECT count(*) FROM permissions p JOIN permission_requires r ON r.permission_id = p.id JOIN permissions q ON q.id = r.required_permission_id
         WHERE p.key = 'entitlements.read' AND q.key = 'org.read'`,
      ),
    ).toBe('1');
    expect(
      psql(
        `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal
         AND tgrelid IN ('entitlement_features'::regclass, 'plans'::regclass, 'org_entitlements'::regclass)`,
      ),
    ).toBe('entitlement_features_immutable,org_entitlements_billing_seq_monotonic,org_entitlements_plan_not_retired,plans_key_immutable');
  });
  it('api and worker booted through both catalogue checks: /health/ready 200, worker healthy, fallback report logged, logs clean', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    const logs = logsSince(bootEpoch);
    expect(logs).toContain('entitlements_plan_fallbacks');
    assertCleanLogs(logs, []);
  });
});
```
Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app`, migrate mọi migration (gồm `entitlements/` và `example/`) từ `dist`, mọi file smoke PASS; log api/worker JSON, không `error`; `/health/ready` 200; teardown `down -v` sạch.

- [ ] **Step 7: Commit**

```bash
git add src/migrations/example src/modules/entitlements test/unit/modules/entitlements/catalogue-diff.spec.ts test/integration/entitlements test/smoke/entitlements.smoke.spec.ts
git commit -m "feat(entitlements): starter plans in the template zone with a 7-step backfill, and the boot-time catalogue check against the database"
```

---
## Phần F — HTTP: API tenant và cổng tính năng (spec §6.3, §12.1, §12.3)

### Task 9: `GET /v1/orgs/{orgId}/entitlements` (HT-2a, nửa đầu HT-3), EXPLAIN câu snapshot trên 10 000 org

**Files:**
- Create: `src/modules/entitlements/http/schemas.ts`, `src/modules/entitlements/http/org-entitlements.controller.ts`, `src/modules/entitlements/http/entitlements-http.module.ts`
- Create (test): `test/unit/modules/entitlements/schemas.spec.ts`, `test/e2e/entitlements/org-entitlements.e2e.spec.ts`, `test/integration/entitlements/snapshot-explain.spec.ts`
- Modify: `src/modules/entitlements/entitlements.module.ts` (`forApi` nạp HTTP), `test/support/entitlements-app.ts` (`startEntitlementsApp`), `openapi.json` (sinh lại)

**Interfaces:**
- Consumes: `Entitlements`, `EntitlementSnapshot`, `EntitlementCatalogueRegistry`, `EntitlementPermissions` (Task 6), `VALUE_SOURCES`, `Limit` (Task 4), `RESET_PERIODS` (Task 3), `PLAN_SOURCES` (Task 3), `serialize`, `ApiOk`, `ApiProblems` (core/http), `startTenancyApp`, `authed`, `type TenancyAppOpts` (3A Task 22), `seedUserPrincipal`, `seedOrg`, `seedMember` (3A), `seedFixtureCatalogue`, `FixtureFeaturesModule`, `fixturePlans` (Task 7), `seedOrgEntitlement`, `deleteOrgEntitlement`, `seedPlans` (Task 5), `SNAPSHOT_SQL` (Task 6), `createScratchDb`, `coreMigrationList`.
- Produces:
  - `OrgEntitlementsResponse` (zod): `{ plan: { key, source: PlanSource, assignedAt }, features: (FLAG{ key, enabled, source, overrideExpiresAt } | LIMIT{ key, unlimited, limit: int | null, source, overrideExpiresAt } | QUOTA{ key, resetPeriod, unlimited, limit, source, overrideExpiresAt })[] }` sắp theo key, bỏ tính năng deprecated; `orgEntitlementsOf(snapshot, features)`. 4B thêm `used`/`state`/`periodStart`/`periodEnd` vào item QUOTA (thay đổi cộng thêm), 4C điền `overrideExpiresAt`.
  - Route `GET /v1/orgs/:orgId/entitlements` (`EntitlementPermissions.require('entitlements.read')`, không ETag), `EntitlementsHttpModule` (chỉ ở `forApi`).
  - `startEntitlementsApp(plans, opts?: Omit<TenancyAppOpts, 'entitlementPermissions'>)` (api + worker events trong một process: `startTenancyApp({ entitlementPermissions: false })` + `EntitlementsModule.forApi(plans)`).

- [ ] **Step 1: Test ánh xạ response (unit, fail)**

`test/unit/modules/entitlements/schemas.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { EntitlementSnapshot } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { UNLIMITED, featureCatalogueData, mergeFeatureCatalogues } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { OrgEntitlementsResponse, orgEntitlementsOf } from '../../../../src/modules/entitlements/http/schemas.js';

const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: { max: 3 } },
  }),
]);
const snapshot: EntitlementSnapshot = {
  version: 2,
  plan: { key: 'pro', source: 'BILLING', assignedAt: new Date('2026-10-01T00:00:00.000Z') },
  features: new Map([
    ['x.flag', { kind: 'FLAG', enabled: true, source: 'PLAN' }],
    ['x.old', { kind: 'FLAG', enabled: false, source: 'FALLBACK' }],
    ['x.seats', { kind: 'LIMIT', limit: { kind: 'UNLIMITED' }, source: 'FALLBACK' }],
    ['x.calls', { kind: 'QUOTA', limit: { kind: 'MAX', max: 3 }, resetPeriod: 'NONE', source: 'FALLBACK' }],
  ]),
};

describe('tenant entitlements response (spec SP4 §12.1)', () => {
  it('sorted by key, deprecated hidden, nullable fields present, UNLIMITED as unlimited:true, limit:null (Review Focus 4)', () => {
    const body = OrgEntitlementsResponse.parse(orgEntitlementsOf(snapshot, features));
    expect(body).toEqual({
      plan: { key: 'pro', source: 'BILLING', assignedAt: '2026-10-01T00:00:00.000Z' },
      features: [
        { key: 'x.calls', kind: 'QUOTA', resetPeriod: 'NONE', unlimited: false, limit: 3, source: 'FALLBACK', overrideExpiresAt: null },
        { key: 'x.flag', kind: 'FLAG', enabled: true, source: 'PLAN', overrideExpiresAt: null },
        { key: 'x.seats', kind: 'LIMIT', unlimited: true, limit: null, source: 'FALLBACK', overrideExpiresAt: null },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/Infinity|Symbol/);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/schemas.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Schema, controller, module HTTP**

`src/modules/entitlements/http/schemas.ts`:
```ts
import { z } from 'zod';
import type { EntitlementSnapshot } from '../application/entitlements.service.js';
import { PLAN_SOURCES } from '../constants.js';
import { VALUE_SOURCES, type EffectiveValue, type Limit } from '../domain/effective-value.js';
import { RESET_PERIODS, type MergedFeatures } from '../domain/feature-catalogue.js';

const iso = z.iso.datetime();
const source = z.enum(VALUE_SOURCES);
/** `limit` là `null` khi không giới hạn: `UNLIMITED` (Symbol) không bao giờ tới JSON (Review Focus 4). */
const numeric = { unlimited: z.boolean(), limit: z.int().min(0).nullable() };
const FlagItem = z.object({ key: z.string(), kind: z.literal('FLAG'), enabled: z.boolean(), source, overrideExpiresAt: iso.nullable() });
const LimitItem = z.object({ key: z.string(), kind: z.literal('LIMIT'), ...numeric, source, overrideExpiresAt: iso.nullable() });
const QuotaItem = z.object({
  key: z.string(),
  kind: z.literal('QUOTA'),
  resetPeriod: z.enum(RESET_PERIODS),
  ...numeric,
  source,
  overrideExpiresAt: iso.nullable(),
});
/**
 * Spec §12.1: không trả `plan_source_ref`, `plan_reason` (dữ liệu nội bộ của billing/nhân viên); LIMIT không có `used` (module
 * chủ đếm). 4B thêm `used`/`state`/`periodStart`/`periodEnd` cho QUOTA; 4C điền `overrideExpiresAt`.
 */
export const OrgEntitlementsResponse = z.object({
  plan: z.object({ key: z.string(), source: z.enum(PLAN_SOURCES), assignedAt: iso }),
  features: z.array(z.discriminatedUnion('kind', [FlagItem, LimitItem, QuotaItem])),
});
export type OrgEntitlementsResponse = z.infer<typeof OrgEntitlementsResponse>;
type Item = OrgEntitlementsResponse['features'][number];

function numericOf(limit: Limit): { unlimited: boolean; limit: number | null } {
  switch (limit.kind) {
    case 'UNLIMITED':
      return { unlimited: true, limit: null };
    case 'MAX':
      return { unlimited: false, limit: limit.max };
    default: {
      const unknownKind: never = limit;
      throw new Error(`unknown limit kind ${String(Reflect.get(unknownKind, 'kind'))}`);
    }
  }
}

function itemOf(key: string, v: EffectiveValue): Item {
  switch (v.kind) {
    case 'FLAG':
      return { key, kind: 'FLAG', enabled: v.enabled, source: v.source, overrideExpiresAt: null };
    case 'LIMIT':
      return { key, kind: 'LIMIT', ...numericOf(v.limit), source: v.source, overrideExpiresAt: null };
    case 'QUOTA':
      return { key, kind: 'QUOTA', resetPeriod: v.resetPeriod, ...numericOf(v.limit), source: v.source, overrideExpiresAt: null };
    default: {
      const unknownKind: never = v;
      throw new Error(`unknown effective value kind ${String(Reflect.get(unknownKind, 'kind'))}`);
    }
  }
}

/** Tính năng deprecated không liệt kê; sắp theo key để response ổn định giữa các pod. */
export function orgEntitlementsOf(s: EntitlementSnapshot, features: MergedFeatures): OrgEntitlementsResponse {
  return {
    plan: { key: s.plan.key, source: s.plan.source, assignedAt: s.plan.assignedAt.toISOString() },
    features: [...s.features]
      .filter(([key]) => features.get(key)?.deprecated === false)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => itemOf(key, v)),
  };
}
```
`src/modules/entitlements/http/org-entitlements.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, serialize } from '../../../core/http/index.js';
import { EntitlementCatalogueRegistry } from '../application/entitlement-catalogue.registry.js';
import { Entitlements } from '../application/entitlements.service.js';
import { EntitlementPermissions } from '../permissions.js';
import { OrgEntitlementsResponse, orgEntitlementsOf } from './schemas.js';

/**
 * Spec §12.1: org từ `ctx.orgId()` (middleware của SP3), không ETag (usage đổi mà `version` không đổi, 4B), không mutation
 * nên không cần marker G-8. Không có API tenant nào ghi entitlement (S4-D18).
 */
@Controller('v1/orgs/:orgId/entitlements')
export class OrgEntitlementsController {
  constructor(
    private readonly entitlements: Entitlements,
    private readonly registry: EntitlementCatalogueRegistry,
  ) {}

  @Get()
  @EntitlementPermissions.require('entitlements.read')
  @ApiOk(OrgEntitlementsResponse)
  @ApiProblems(CoreErrors.FORBIDDEN, CoreErrors.NOT_FOUND, CoreErrors.SERVICE_UNAVAILABLE)
  async get() {
    return serialize(OrgEntitlementsResponse, orgEntitlementsOf(await this.entitlements.snapshot(), this.registry.features()));
  }
}
```
`src/modules/entitlements/http/entitlements-http.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { OrgEntitlementsController } from './org-entitlements.controller.js';

/** Chỉ ở api (spec §6.2). Task 10 thêm `EntitlementRouteInventory`. Deps của controller đến từ `EntitlementsCoreModule` (`@Global`). */
@Module({ controllers: [OrgEntitlementsController] })
export class EntitlementsHttpModule {}
```
`src/modules/entitlements/entitlements.module.ts`: `forApi(plans)` trả `{ module: EntitlementsModule, imports: [EntitlementsCoreModule.register(plans), EntitlementsHttpModule] }`.
`test/support/entitlements-app.ts` thêm:
```ts
import type { INestApplication } from '@nestjs/common';
import { startTenancyApp, type TenancyAppOpts } from './tenancy-app.js';

/**
 * App e2e của tenancy (api + worker events/notifications trong một process) + `EntitlementsModule.forApi(plans)`.
 * `entitlementPermissions: false` luôn thắng `opts`: catalogue quyền của entitlements đã do `EntitlementsCoreModule` góp.
 */
export function startEntitlementsApp(plans: PlanCatalogue, opts: Omit<TenancyAppOpts, 'entitlementPermissions'> = {}): Promise<INestApplication> {
  return startTenancyApp({ ...opts, entitlementPermissions: false, extraImports: [EntitlementsModule.forApi(plans), ...(opts.extraImports ?? [])] });
}
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/schemas.spec.ts`
Expected: PASS.

- [ ] **Step 3: E2E route (HT-2a, HT-3 nửa đầu; fail trước Step 2)**

`test/e2e/entitlements/org-entitlements.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import { FixtureFeaturesModule, fixturePlans, seedFixtureCatalogue } from '../../support/entitlements-fixtures.js';
import { deleteOrgEntitlement, seedOrgEntitlement, seedPlans } from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

describe('GET /v1/orgs/{orgId}/entitlements (spec SP4 §12.1, HT-2a, HT-3)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  let owner: SeededPrincipal;
  let admin: SeededPrincipal;
  let member: SeededPrincipal;
  let outsider: SeededPrincipal;
  let pro: SeededOrg;
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgOf = async (plan: string | undefined, opts: Parameters<typeof seedOrgEntitlement>[2] = {}) => {
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, { extraImports: [FixtureFeaturesModule] });
    [owner, admin, member, outsider] = [await seedP(), await seedP(), await seedP(), await seedP()];
    pro = await orgOf('pro');
    await seedMember(pro, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(pro, 'MEMBER', { authUserId: member.authUserId });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await disposeCatalogue?.();
  });
  const get = (p: SeededPrincipal, o: SeededOrg) => authed(app, p).get(`/v1/orgs/${o.orgId}/entitlements`);

  it('OWNER, ADMIN and MEMBER read the documented shape: plan, sorted features, deprecated hidden, no ETag', async () => {
    for (const p of [owner, admin, member]) {
      const r = await get(p, pro);
      expect(r.status).toBe(200);
      expect(r.headers.etag).toBeUndefined();
      expect(r.body.plan).toMatchObject({ key: 'pro', source: 'DEFAULT' });
      expect(r.body.features).toEqual([
        { key: 'fixture.api_calls', kind: 'QUOTA', resetPeriod: 'MONTH', unlimited: false, limit: 100, source: 'FALLBACK', overrideExpiresAt: null },
        { key: 'fixture.exports', kind: 'FLAG', enabled: false, source: 'PLAN', overrideExpiresAt: null },
        { key: 'fixture.projects', kind: 'LIMIT', unlimited: true, limit: null, source: 'PLAN', overrideExpiresAt: null },
        { key: 'fixture.reports', kind: 'FLAG', enabled: true, source: 'PLAN', overrideExpiresAt: null },
        { key: 'tenancy.seats', kind: 'LIMIT', unlimited: false, limit: 10, source: 'PLAN', overrideExpiresAt: null },
      ]);
    }
  });
  it('a non-member gets the uniform 404 of SP3; without a principal 401', async () => {
    const r = await get(outsider, pro);
    expect([r.status, r.body.code]).toEqual([404, 'not_found']);
    expect((await request(app.getHttpServer()).get(`/v1/orgs/${pro.orgId}/entitlements`)).status).toBe(401);
  });
  it('billing source ref and staff reason never reach the tenant body', async () => {
    const billed = await orgOf('enterprise', { source: 'BILLING', sourceRef: 'sub_do_not_leak', lastBillingSeq: 1n });
    const r = await get(owner, billed);
    expect([r.status, r.body.plan.source]).toEqual([200, 'BILLING']);
    expect(JSON.stringify(r.body)).not.toContain('sub_do_not_leak');
  });
  it('HT-3 (first half): an org without its row answers 503 + Retry-After, never a default plan', async () => {
    const o = await orgOf('free');
    await deleteOrgEntitlement(o.orgId);
    const r = await get(owner, o);
    expect([r.status, r.body.code, r.headers['retry-after']]).toEqual([503, 'service_unavailable', '5']);
  });
  it('F-6: an org on a plan this pod does not know answers 503', async () => {
    const disposeGhost = await seedPlans([{ key: 'ghost_http' }]);
    const o = await orgOf('ghost_http');
    try {
      expect((await get(owner, o)).status).toBe(503);
    } finally {
      await o.dispose();
      orgs.splice(orgs.indexOf(o), 1);
      await disposeGhost();
    }
  });
});
```
Run: `pnpm vitest run --project integration test/e2e/entitlements/org-entitlements.e2e.spec.ts`
Expected: PASS (viết file trước Step 2 để thấy RED: route chưa có → `404` ở ca đầu).

- [ ] **Step 4: EXPLAIN (ANALYZE, BUFFERS) câu snapshot trên khối lượng thật**

`test/integration/entitlements/snapshot-explain.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { SNAPSHOT_SQL } from '../../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

const ORGS = 10_000;
/** Lô nhỏ: mỗi org mới qua trigger hoãn `organizations_bootstrap_ck` lúc COMMIT; lô 1 000 giữ bảng khoá của một transaction nhỏ. */
const BATCH = 1_000;
const FORCED = ['organizations', 'org_roles', 'org_members', 'org_entitlements'] as const;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];

describe('entitlement snapshot query plan on realistic volume (spec SP4 §8.4)', () => {
  let scratch: ScratchDb;
  let owner: pg.Client;
  let app: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    scratch = await createScratchDb('snapexplain');
    vi.stubEnv('DB_NAME', scratch.name);
    await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
    owner = await scratch.client('owner');
    app = await scratch.client('app');
    for (let from = 1; from <= ORGS; from += BATCH) {
      const to = from + BATCH - 1;
      await owner.query('BEGIN');
      for (const t of FORCED) await owner.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await owner.query(`INSERT INTO tenancy_users (external_subject) SELECT 'load:' || g FROM generate_series(${from}, ${to}) g`);
      await owner.query(
        `INSERT INTO organizations (id, name, created_by_user_id)
         SELECT uuidv7(), 'Load ' || g, u.id FROM generate_series(${from}, ${to}) g JOIN tenancy_users u ON u.external_subject = 'load:' || g`,
      );
      await owner.query(
        `INSERT INTO org_roles (org_id, system_key) SELECT o.id, k FROM organizations o CROSS JOIN unnest(ARRAY['OWNER', 'ADMIN', 'MEMBER']) k
         WHERE NOT EXISTS (SELECT 1 FROM org_roles r WHERE r.org_id = o.id)`,
      );
      await owner.query(
        `INSERT INTO org_members (org_id, user_id, role_id)
         SELECT o.id, o.created_by_user_id, r.id FROM organizations o JOIN org_roles r ON r.org_id = o.id AND r.system_key = 'OWNER'
         WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id)`,
      );
      await owner.query(
        `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
         SELECT o.id, p.id, 'DEFAULT', now() FROM organizations o CROSS JOIN plans p WHERE p.key = 'free' ON CONFLICT (org_id) DO NOTHING`,
      );
      for (const t of FORCED) await owner.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      await owner.query('COMMIT');
    }
    await owner.query('ANALYZE');
  }, 300_000);
  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await scratch?.drop();
    vi.unstubAllEnvs();
  });

  it('reads one org by the org_entitlements primary key (no sequential scan of org_entitlements) and prints EXPLAIN (ANALYZE, BUFFERS)', async () => {
    const { rows: pick } = await owner.query<{ id: string }>(`SELECT id::text AS id FROM organizations ORDER BY id OFFSET 4321 LIMIT 1`);
    const orgId = pick[0]?.id;
    if (!orgId) throw new Error('seed produced no organization');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const { rows } = await app.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SNAPSHOT_SQL}`);
    const text = await app.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${SNAPSHOT_SQL}`);
    await app.query('ROLLBACK');
    const plan = rows[0]?.['QUERY PLAN'][0];
    if (!plan) throw new Error('no plan');
    console.info(`entitlement snapshot plan (${ORGS} orgs):\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}`);
    const all = nodes(plan.Plan);
    expect(all.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'org_entitlements')).toEqual([]);
    expect(all.map((n) => n['Index Name'])).toContain('org_entitlements_pkey');
  });
});
```
Ghi chú: `plans` có vài dòng nên planner được phép quét tuần tự bảng đó (rẻ hơn index); khẳng định chỉ neo vào `org_entitlements` (bảng tăng theo số org). Bản in plan dán vào mô tả PR ở Task 15.
Run: `pnpm vitest run --project integration test/integration/entitlements/snapshot-explain.spec.ts`
Expected: PASS; log in plan có `Index Scan using org_entitlements_pkey`.

- [ ] **Step 5: OpenAPI, kiểm toàn cục, commit**

Run:
```bash
pnpm build && pnpm openapi:export && git diff --stat openapi.json
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/entitlements test/e2e/tenancy test/integration/entitlements
```
Expected: `openapi.json` chỉ thêm path `/v1/orgs/{orgId}/entitlements` và schema của nó (oasdiff chỉ thêm ở CI); e2e tenancy của 3A (gồm `OrgRouteInventory` của tenancy, ma trận role × route) xanh với controller mới (route tenant có policy, GET không cần marker).
```bash
git add src/modules/entitlements test/unit/modules/entitlements/schemas.spec.ts test/e2e/entitlements test/integration/entitlements/snapshot-explain.spec.ts test/support/entitlements-app.ts openapi.json
git commit -m "feat(entitlements): tenant GET /v1/orgs/{orgId}/entitlements with the plan and effective features; snapshot query plan on 10k orgs"
```

---

### Task 10: `requireEnabled` sau CASL trong OrgScope (HT-1, giữ spike S4-T1), với `@Idempotent()` ở hai thứ tự (HT-4), class + method (Review Focus 5); `EntitlementRouteInventory` lúc boot; đo thời gian kiểm lúc boot

**Files:**
- Create: `src/modules/entitlements/application/entitlement-route-inventory.ts`
- Create (test): `test/unit/modules/entitlements/entitlement-route-inventory.spec.ts`, `test/e2e/entitlements/require-enabled.e2e.spec.ts`, `test/e2e/entitlements/fixtures/feature-gate.module.ts`
- Modify: `src/modules/entitlements/http/entitlements-http.module.ts`

**Interfaces:**
- Consumes: `classifyTenantHandler` (Task 2), `FEATURE_REQUIREMENTS`, `FeatureRequirement`, `EntitlementInterceptor`, `EntitlementCatalogueRegistry`, `Entitlements` (Task 6), `EntitlementCatalogueCheck` (Task 8), `startEntitlementsApp` (Task 9), `FixtureFeatures`, `FixtureFeaturesModule`, `fixturePlans`, `seedFixtureCatalogue` (Task 7), `setOrgPlan`, `seedOrgEntitlement` (Task 5), `TenancyPermissions` (3A `src/modules/tenancy/permissions.ts`), `Idempotent` (core/http), `INTERCEPTORS_METADATA` (`@nestjs/common/constants.js`), `IdempotencyInterceptor` (`src/core/http/idempotency.interceptor.ts`).
- Produces: `EntitlementRouteInventory` (`onApplicationBootstrap`, api; `check(): string[]`): handler có metadata `requireEnabled` mà (a) `classifyTenantHandler` khác `'TENANT'`, (b) catalogue chưa đăng ký, (c) key không có trong catalogue gộp, (d) key không phải FLAG, (e) key deprecated → log ERROR `entitlements_route_inventory_failed` + ném (app không khởi động).

- [ ] **Step 1: Test inventory (unit, Nest thật, không mock `DiscoveryService`; fail)**

`test/unit/modules/entitlements/entitlement-route-inventory.spec.ts`:
```ts
import { Controller, Get, Injectable, Module, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_PLANS, EntitlementCatalogueRegistry, FeatureCatalogueContributor } from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { EntitlementRouteInventory } from '../../../../src/modules/entitlements/application/entitlement-route-inventory.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import { UNLIMITED } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import { FEATURE_REQUIREMENTS } from '../../../../src/modules/entitlements/http/feature-metadata.js';

const Fx = defineFeatureCatalogue({
  'fx.flag': { kind: 'FLAG', fallback: true },
  'fx.old': { kind: 'FLAG', fallback: true, deprecated: true },
  'fx.limit': { kind: 'LIMIT', fallback: UNLIMITED },
});
const Unregistered = defineFeatureCatalogue({ 'un.flag': { kind: 'FLAG', fallback: true } });
@Injectable() @FeatureCatalogueContributor(Fx) class FxContributor {}

@Controller('v1/orgs/:orgId/good') class Good { @Get() @Fx.requireEnabled('fx.flag') list() {} }
@Controller('v1/orgs/:orgId/good-class') @Fx.requireEnabled('fx.flag') class GoodClass { @Get() list() {} }
@Controller('v1/public') class NotTenant { @Get() @Fx.requireEnabled('fx.flag') list() {} }
@Controller(['v1/orgs/:orgId/mixed', 'v1/mixed']) class Mixed { @Get() @Fx.requireEnabled('fx.flag') list() {} }
@Controller('v1/orgs/:orgId/deprecated') class Deprecated { @Get() @Fx.requireEnabled('fx.old') list() {} }
@Controller('v1/orgs/:orgId/unreg') class NotRegistered { @Get() @Unregistered.requireEnabled('un.flag') list() {} }
/** Metadata viết tay (vượt qua kiểu và kiểm runtime của `requireEnabled`): inventory vẫn phải bắt. */
@Controller('v1/orgs/:orgId/forged') class Forged {
  @Get('limit') limit() {}
  @Get('ghost') ghost() {}
}
Reflect.defineMetadata(FEATURE_REQUIREMENTS, [{ catalogue: Fx, keys: ['fx.limit'] }], Forged.prototype.limit);
Reflect.defineMetadata(FEATURE_REQUIREMENTS, [{ catalogue: Fx, keys: ['fx.ghost'] }], Forged.prototype.ghost);

const plans = definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: {} } } });
async function problemsOf(controllers: Type[]): Promise<string[]> {
  @Module({ controllers }) class Fixture {}
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule, Fixture],
    providers: [FxContributor, EntitlementCatalogueRegistry, EntitlementsMetrics, EntitlementRouteInventory, { provide: ENTITLEMENT_PLANS, useValue: plans }],
  }).compile();
  ref.get(EntitlementCatalogueRegistry).onModuleInit();
  const problems = ref.get(EntitlementRouteInventory).check();
  await ref.close();
  return problems;
}

describe('EntitlementRouteInventory (spec SP4 §8.3, EC-9 inventory part)', () => {
  it('method-level and class-level requireEnabled on tenant routes pass', async () => {
    expect(await problemsOf([Good, GoodClass])).toEqual([]);
  });
  it.each([
    [NotTenant, /NotTenant\.list: requireEnabled needs a tenant route under v1\/orgs\/:orgId/],
    [Mixed, /Mixed\.list: requireEnabled needs a tenant route under v1\/orgs\/:orgId/],
    [Deprecated, /Deprecated\.list: "fx\.old" is deprecated/],
    [NotRegistered, /NotRegistered\.list: its feature catalogue is not registered/],
    [Forged, /Forged\.limit: "fx\.limit" is a LIMIT, requireEnabled takes FLAG keys only/],
    [Forged, /Forged\.ghost: "fx\.ghost" is not in the merged feature catalogue/],
  ])('%o refuses to boot', async (ctl, message) => {
    expect((await problemsOf([ctl])).join('\n')).toMatch(message);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/entitlement-route-inventory.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Inventory**

`src/modules/entitlements/application/entitlement-route-inventory.ts`:
```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { classifyTenantHandler } from '../../tenancy/index.js';
import { FEATURE_REQUIREMENTS, type FeatureRequirement } from '../http/feature-metadata.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';

/**
 * Kiểm lúc khởi động của api (spec §8.3): mọi handler có `requireEnabled` phải là route tenant theo CÙNG matcher của tenancy
 * (`classifyTenantHandler`), catalogue của decorator đã đăng ký, key có trong catalogue gộp, là FLAG và chưa deprecated.
 * Vi phạm → log ERROR + app không khởi động. Log thời gian (tiêu chí đo "kiểm lúc boot < 50 ms thêm", spec §20.4).
 */
@Injectable()
export class EntitlementRouteInventory implements OnApplicationBootstrap {
  private readonly logger = new Logger(EntitlementRouteInventory.name);
  private readonly scanner = new MetadataScanner();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly registry: EntitlementCatalogueRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const started = performance.now();
    const problems = this.check();
    const durationMs = Math.round(performance.now() - started);
    if (problems.length === 0) {
      this.logger.log({ event: 'entitlements_route_inventory', durationMs }, 'entitlement route inventory passed');
      return;
    }
    this.logger.error({ event: 'entitlements_route_inventory_failed', problems }, 'entitlement route inventory failed');
    throw new Error(`Entitlement route inventory failed: ${problems.join('; ')}`);
  }

  check(): string[] {
    const out: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const proto: object = controller.prototype;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler: unknown = Reflect.get(proto, name);
        if (typeof handler !== 'function' || this.reflector.get(PATH_METADATA, handler) === undefined) continue;
        const requirements = this.reflector.getAllAndMerge<FeatureRequirement[]>(FEATURE_REQUIREMENTS, [handler, controller]);
        if (requirements.length === 0) continue;
        out.push(...this.problemsOf(`${controller.name}.${name}`, controller, handler, requirements));
      }
    }
    return out;
  }

  private problemsOf(id: string, controller: Function, handler: Function, requirements: readonly FeatureRequirement[]): string[] {
    const out: string[] = [];
    if (classifyTenantHandler(controller, handler) !== 'TENANT') out.push(`${id}: requireEnabled needs a tenant route under v1/orgs/:orgId`);
    for (const r of requirements) {
      if (!this.registry.has(r.catalogue)) {
        out.push(`${id}: its feature catalogue is not registered (@FeatureCatalogueContributor missing)`);
        continue;
      }
      for (const key of r.keys) {
        const f = this.registry.features().get(key);
        if (!f) out.push(`${id}: "${key}" is not in the merged feature catalogue`);
        else if (f.kind !== 'FLAG') out.push(`${id}: "${key}" is a ${f.kind}, requireEnabled takes FLAG keys only`);
        else if (f.deprecated) out.push(`${id}: "${key}" is deprecated`);
      }
    }
    return out;
  }
}
```
`src/modules/entitlements/http/entitlements-http.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EntitlementRouteInventory } from '../application/entitlement-route-inventory.js';
import { OrgEntitlementsController } from './org-entitlements.controller.js';

/**
 * Chỉ ở api (spec §6.2). `DiscoveryModule` không `@Global`: inventory cần nó ở chính module này (cùng lý do review I6 của 3A).
 */
@Module({ imports: [DiscoveryModule], controllers: [OrgEntitlementsController], providers: [EntitlementRouteInventory] })
export class EntitlementsHttpModule {}
```
Run: `pnpm vitest run --project unit test/unit/modules/entitlements/entitlement-route-inventory.spec.ts`
Expected: PASS.

- [ ] **Step 3: Fixture route của `features/` và e2e (fail trước khi có dữ liệu gói đúng)**

`test/e2e/entitlements/fixtures/feature-gate.module.ts`:
```ts
import { Controller, Get, HttpCode, HttpStatus, Module, Post } from '@nestjs/common';
import { RequestContext } from '../../../../src/core/context/index.js';
import { Db } from '../../../../src/core/database/index.js';
import { Idempotent } from '../../../../src/core/http/index.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';
import { FixtureFeatures } from '../../../support/entitlements-fixtures.js';

let created = 0;
export const createdCount = (): number => created;

/** Route tenant giả của `features/` (ngoài module tenancy nên không vào luật G-8): quan sát context sau khi qua cổng. */
@Controller('v1/orgs/:orgId/fx')
export class FeatureGateController {
  constructor(
    private readonly ctx: RequestContext,
    private readonly db: Db,
  ) {}

  private async observe() {
    const [row] = await this.db.execute<{ org: string }>('SELECT app_current_org()::text AS org');
    return { orgId: this.ctx.orgId(), sqlOrg: row?.org ?? null };
  }

  @Get('guard-first')
  @TenancyPermissions.require('org.delete')
  @FixtureFeatures.requireEnabled('fixture.reports')
  guardFirst() {
    return this.observe();
  }

  @Get('feature-first')
  @FixtureFeatures.requireEnabled('fixture.reports')
  @TenancyPermissions.require('org.delete')
  featureFirst() {
    return this.observe();
  }

  @Post('idem-a')
  @HttpCode(HttpStatus.CREATED)
  @TenancyPermissions.require('org.read')
  @FixtureFeatures.requireEnabled('fixture.reports')
  @Idempotent()
  idemA() {
    created += 1;
    return { n: created };
  }

  @Post('idem-b')
  @HttpCode(HttpStatus.CREATED)
  @TenancyPermissions.require('org.read')
  @Idempotent()
  @FixtureFeatures.requireEnabled('fixture.reports')
  idemB() {
    created += 1;
    return { n: created };
  }
}

/** Cổng ở class (`fixture.exports`) cộng cổng ở method (`fixture.reports`): cả hai phải bật (Review Focus 5). */
@Controller('v1/orgs/:orgId/fx-class')
@FixtureFeatures.requireEnabled('fixture.exports')
class ClassGateController {
  @Get()
  @TenancyPermissions.require('org.read')
  @FixtureFeatures.requireEnabled('fixture.reports')
  both() {
    return { ok: true };
  }
}

@Module({ controllers: [FeatureGateController, ClassGateController] })
export class FeatureGateModule {}
```
`test/e2e/entitlements/require-enabled.e2e.spec.ts`:
```ts
import { Controller, Get, Logger, Module, type INestApplication } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IdempotencyInterceptor } from '../../../src/core/http/idempotency.interceptor.js';
import { EntitlementCatalogueCheck } from '../../../src/modules/entitlements/application/catalogue-check.js';
import { EntitlementRouteInventory } from '../../../src/modules/entitlements/application/entitlement-route-inventory.js';
import { Entitlements } from '../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementInterceptor } from '../../../src/modules/entitlements/http/entitlement.interceptor.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import { FixtureFeatures, FixtureFeaturesModule, fixturePlans, seedFixtureCatalogue } from '../../support/entitlements-fixtures.js';
import { seedOrgEntitlement, setOrgPlan } from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { FeatureGateController, FeatureGateModule, createdCount } from './fixtures/feature-gate.module.js';

/** Vị trí trong mảng interceptor của Nest = thứ tự chạy (phần tử đầu bọc ngoài cùng). */
const runsFirst = (handler: 'idemA' | 'idemB'): 'idempotency' | 'entitlement' => {
  const chain: unknown = Reflect.getMetadata(INTERCEPTORS_METADATA, FeatureGateController.prototype[handler]);
  if (!Array.isArray(chain)) throw new Error(`no interceptors on ${handler}`);
  return chain.indexOf(IdempotencyInterceptor) < chain.indexOf(EntitlementInterceptor) ? 'idempotency' : 'entitlement';
};

/** Route KHÔNG phải tenant có `requireEnabled`: inventory phải chặn boot (dùng ở describe cuối). */
@Controller('v1/public-gate')
class PublicGate {
  @Get()
  @FixtureFeatures.requireEnabled('fixture.reports')
  open() {
    return {};
  }
}
@Module({ controllers: [PublicGate] })
class PublicGateModule {}

describe('requireEnabled on real routes (spec SP4 §6.1, §12.3, S4-D7, HT-1, HT-4)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgOn = async (plan: string) => {
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(o);
    await seedMember(o, 'MEMBER', { authUserId: member.authUserId });
    await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, { extraImports: [FixtureFeaturesModule, FeatureGateModule] });
    owner = await seedP();
    member = await seedP();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await disposeCatalogue?.();
  });

  it.each(['guard-first', 'feature-first'])('HT-1 %s: a member lacking the permission gets 403 forbidden and the plan is never read', async (route) => {
    const o = await orgOn('free');
    const snapshot = vi.spyOn(Entitlements.prototype, 'snapshot');
    const r = await authed(app, member).get(`/v1/orgs/${o.orgId}/fx/${route}`);
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
  });
  it.each(['guard-first', 'feature-first'])('HT-1 %s: the owner on a plan without the feature gets 403 feature_not_in_plan naming the key', async (route) => {
    const o = await orgOn('free');
    const r = await authed(app, owner).get(`/v1/orgs/${o.orgId}/fx/${route}`);
    expect([r.status, r.body.code]).toEqual([403, 'feature_not_in_plan']);
    expect(r.body.errors).toEqual([{ path: 'feature', code: 'fixture.reports', message: 'Feature is not included in your plan' }]);
  });
  it.each(['guard-first', 'feature-first'])('HT-1 / S4-T1 %s: with the feature the handler runs in the OrgScope of the path org', async (route) => {
    const o = await orgOn('pro');
    const r = await authed(app, owner).get(`/v1/orgs/${o.orgId}/fx/${route}`);
    expect([r.status, r.body]).toEqual([200, { orgId: o.orgId, sqlOrg: o.orgId }]);
  });
  it('HT-4 covers both interceptor orders: idemA and idemB really run idempotency and the feature gate in opposite orders', () => {
    expect(new Set([runsFirst('idemA'), runsFirst('idemB')]).size).toBe(2);
  });
  it.each(['idemA', 'idemB'] as const)('HT-4 %s: the result matches §12.3 for the interceptor order Nest actually runs', async (handler) => {
    const o = await orgOn('free');
    const url = `/v1/orgs/${o.orgId}/fx/${handler === 'idemA' ? 'idem-a' : 'idem-b'}`;
    const key = `k-${randomUUID()}`;
    const first = await authed(app, owner).post(url).set('idempotency-key', key).send({});
    expect([first.status, first.body.code]).toEqual([403, 'feature_not_in_plan']);
    await setOrgPlan(o.orgId, 'pro');
    const before = createdCount();
    const second = await authed(app, owner).post(url).set('idempotency-key', key).send({});
    if (runsFirst(handler) === 'idempotency') {
      // Idempotency bọc ngoài: 403 đã được lưu và trả lại cho cùng key (cha §3.4); handler không chạy.
      expect([second.status, second.body.code, createdCount()]).toEqual([403, 'feature_not_in_plan', before]);
    } else {
      // Cổng tính năng bọc ngoài: 403 không được lưu; sau khi nâng gói, cùng key chạy handler đúng một lần.
      expect([second.status, createdCount()]).toEqual([201, before + 1]);
    }
  });
  it('Review Focus 5: class-level and method-level requireEnabled both apply', async () => {
    const free = await orgOn('free');
    const pro = await orgOn('pro');
    const enterprise = await orgOn('enterprise');
    const call = (o: SeededOrg) => authed(app, owner).get(`/v1/orgs/${o.orgId}/fx-class`);
    expect([(await call(free)).status, (await call(free)).body.errors?.[0]?.code]).toEqual([403, 'fixture.reports']);
    expect([(await call(pro)).status, (await call(pro)).body.errors?.[0]?.code]).toEqual([403, 'fixture.exports']);
    expect((await call(enterprise)).status).toBe(200);
  });
  it('boot-time checks: route inventory + catalogue check pass on the running app; the duration is logged, not asserted', async () => {
    const started = performance.now();
    expect(app.get(EntitlementRouteInventory).check()).toEqual([]);
    await expect(app.get(EntitlementCatalogueCheck).onModuleInit()).resolves.toBeUndefined();
    // Mốc < 50 ms (spec §20.4) chỉ khẳng định ở smoke trên image thật (Task 13, từ log boot): ở đây DB CI dùng chung, đo
    // thời gian sẽ chập chờn.
    new Logger('require-enabled.e2e').log({ event: 'entitlements_boot_checks', durationMs: Math.round(performance.now() - started) });
  });
});
```
Ghi chú về `runsFirst`: Nest chạy interceptor route theo thứ tự mảng `INTERCEPTORS_METADATA` (đầu mảng bọc ngoài). Test không đoán thứ tự áp decorator mà khẳng định hành vi đúng §12.3 cho thứ tự thật của từng route; hai route `idemA`/`idemB` đặt decorator ngược nhau, và ca "HT-4 covers both interceptor orders" khẳng định hai thứ tự thật sự khác nhau (nếu Nest gộp metadata theo cách làm hai route cùng thứ tự, ca đó đỏ thay vì HT-4 chỉ phủ một nhánh mà vẫn xanh).

Run: `pnpm vitest run --project integration test/e2e/entitlements/require-enabled.e2e.spec.ts`
Expected: PASS 11/11 (viết trước Step 2 thì ca boot-time đỏ vì `EntitlementRouteInventory` chưa có).

- [ ] **Step 4: Inventory chặn boot của app thật (G-1 của SP4)**

Thêm vào cuối `test/e2e/entitlements/require-enabled.e2e.spec.ts` (dùng `PublicGateModule` khai báo ở đầu file):
```ts
describe('the entitlement route inventory refuses to boot a misplaced requireEnabled (spec SP4 §8.3)', () => {
  it('requireEnabled on a non-tenant route stops the api from starting', async () => {
    const dispose = await seedFixtureCatalogue();
    try {
      await expect(startEntitlementsApp(fixturePlans, { extraImports: [FixtureFeaturesModule, PublicGateModule] })).rejects.toThrow(
        /PublicGate\.open: requireEnabled needs a tenant route/,
      );
    } finally {
      await dispose();
    }
  });
});
```
Ca này chạy sau `afterAll` của describe trên (app đầu đã đóng): một process chỉ có một app có `DatabaseModule` tại một thời điểm. Nếu vitest treo sau ca này (pool của app lỗi boot không được đóng), đổi sang `buildTestApp` + `app.init()` trong `expect(...).rejects` + `app.close()` trong `finally`, như `catalogue-check.spec.ts` (Task 8).
Run: lệnh của Step 3.
Expected: PASS.

- [ ] **Step 5: Kiểm toàn cục, commit**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/entitlements test/e2e/tenancy test/e2e/core/entrypoints.e2e.spec.ts
```
Expected: xanh; api thật khởi động (inventory không thấy vi phạm: boilerplate chưa có route nào dùng `requireEnabled`).
```bash
git add src/modules/entitlements test/unit/modules/entitlements/entitlement-route-inventory.spec.ts test/e2e/entitlements
git commit -m "feat(entitlements): requireEnabled runs after CASL inside OrgScope; boot-time route inventory for misplaced feature gates"
```

---
## Phần G — Vòng đời dòng `org_entitlements` và gán gói (spec §10, §13, §17)

### Task 11: Mọi org có đúng một dòng — participant tạo org, subscriber dự phòng `tenancy.org.created`, participant purge `order = 100` (PA-11, PA-12, R-1, nửa sau HT-3, ba `AUTH_MODE`)

**Files:**
- Create: `src/modules/entitlements/application/provision-org.participant.ts`, `src/modules/entitlements/application/provision-org.subscriber.ts`, `src/modules/entitlements/application/org-purge.participant.ts`
- Create (test): `test/e2e/entitlements/provisioning.e2e.spec.ts`, `test/integration/entitlements/provisioning.spec.ts`, `test/e2e/entitlements/auth-modes.e2e.spec.ts`
- Modify: `src/modules/entitlements/ports/org-entitlement.repository.ts`, `src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts`, `src/modules/entitlements/entitlements.module.ts`, `test/support/entitlements-app.ts`, `.dependency-cruiser.cjs` (gỡ ngoại lệ `entitlements-purge.sql.ts`)

**Interfaces:**
- Consumes: `OrgCreationParticipant`, `OrgCreationParticipantContributor`, `OrgCreationParticipantRegistry` (Task 2), `OrgPurgeParticipant`, `OrgPurgeParticipantContributor`, `OrgPurgeParticipantRegistry`, `OrgCreatedEvent` (tenancy `index.ts`, 3A Task 19), `PurgeOrgHandler` (`src/modules/tenancy/application/purge-orgs.handler.ts`, 3A Task 25), `EventSubscriber`, `EventHandler`, `EventPublisher`, `EventActor`, `EventEnvelope` (core/events), `ENTITLEMENTS_PURGE_STATEMENTS` (Task 5), `ENTITLEMENTS_PURGE_ORDER` (Task 3), `PlanChangedEvent`, `ORG_ENTITLEMENT_AGGREGATE`, `ENTITLEMENT_PLANS` (Task 6), `startEntitlementsApp` (Task 9), `entitlementsCoreImports` (Task 7), `tenancyCoreImports` (3A), `startFakeJwks` (SP2), `ResilienceModule` (SP1), `purgeOrgs`, `deleteTenancyUsersOf` (3A), `ownerQuery` (SP2).
- Produces:
  - `OrgEntitlementRepository` thêm `insertDefault(planKey): Promise<{ version: number }>` (không `ON CONFLICT`; gói thiếu → ném) và `insertDefaultIfAbsent(planKey): Promise<ProvisionResult>` với `type ProvisionResult = { kind: 'INSERTED'; version: number } | { kind: 'ALREADY_PROVISIONED' } | { kind: 'ORG_GONE' }`.
  - `ProvisionOrgParticipant` (`@OrgCreationParticipantContributor({ key: 'entitlements.provision', order: 0 })`, api + worker): chèn `DEFAULT` + `plan.changed { fromPlan: null, toPlan: defaultPlan, cause: 'DEFAULT', causeRef: null }` actor của thao tác tạo org, cùng transaction.
  - `ProvisionOrgSubscriber` (`@EventSubscriber({ consumer: 'entitlements.provision-org', event: OrgCreatedEvent })`, worker): cùng câu với `ON CONFLICT (org_id) DO NOTHING`, chỉ phát event khi thật sự chèn (actor `{ type: 'system', id: 'entitlements.provision-org' }`, `causationId = e.id`); org đã mất → log INFO `entitlements_provision_skipped_org_gone`, xử lý xong.
  - `EntitlementsPurgeParticipant` (`@OrgPurgeParticipantContributor({ key: 'entitlements', order: 100 })`, worker): chạy `ENTITLEMENTS_PURGE_STATEMENTS` trong transaction purge.
  - `startEntitlementsApp` nạp thêm `EntitlementsProvisionTestModule` (subscriber trong app e2e api + worker events một process).

- [ ] **Step 1: Test tích hợp — subscriber và purge (fail)**

`test/integration/entitlements/provisioning.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork, pgFields } from '../../../src/core/database/index.js';
import type { EventEnvelope } from '../../../src/core/events/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { ProvisionOrgSubscriber } from '../../../src/modules/entitlements/application/provision-org.subscriber.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { OrgPurgeParticipantRegistry } from '../../../src/modules/tenancy/application/org-purge-participant.registry.js';
import { examplePlans } from '../../../src/plans.example.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import { readOrgEntitlement, seedOrgEntitlement } from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const createdEvent = (orgId: string): EventEnvelope<{ orgId: string; createdByUserId: string }> => ({
  id: v7(),
  type: 'tenancy.org.created',
  version: 1,
  occurredAt: new Date().toISOString(),
  orgId,
  actor: { type: 'user', id: v7() },
  aggregate: { type: 'organization', id: orgId, version: 1 },
  correlationId: 'test',
  causationId: null,
  data: { orgId, createdByUserId: v7() },
});
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
const makeDue = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () => c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [orgId])),
  );
const planEvents = (orgId: string) =>
  ownerQuery<{ payload: { cause: string }; headers: { actorId: string } }>(
    `SELECT payload, headers FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed' ORDER BY id`,
    [orgId],
  );

describe('provisioning safety net and purge participant on the worker composition (spec SP4 §10.4, §13.2)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const handle = (orgId: string, e = createdEvent(orgId)) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(() => app.get(ProvisionOrgSubscriber).handle(e)));
  beforeAll(async () => {
    app = await createTestApp(entitlementsCoreImports(examplePlans));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
  });

  it('E-9: an org without a row is provisioned once with free/DEFAULT and one event; a replay is a no-op without event', async () => {
    const o = await seedOrg();
    orgs.push(o);
    await handle(o.orgId);
    await handle(o.orgId);
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'free', source: 'DEFAULT', version: 1 });
    const events = await planEvents(o.orgId);
    expect(events.map((e) => [e.payload.cause, e.headers.actorId])).toEqual([['DEFAULT', 'entitlements.provision-org']]);
  });
  it('PA-12: an organization already purged is done: INFO log, no row, no retry', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const gone = v7();
    await expect(handle(gone)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith({ event: 'entitlements_provision_skipped_org_gone' }, expect.any(String));
    expect(await readOrgEntitlement(gone)).toBeUndefined();
  });
  it('R-1: the participant is registered at order 100 after core.scheduled-tasks; a purge removes the row of that org only', async () => {
    const order = app.get(OrgPurgeParticipantRegistry).participants().map((p) => [p.key, p.order] as const);
    expect(order).toContainEqual(['entitlements', 100]);
    // Plan sau (SP6, SP7) thêm participant của mình; chỉ khẳng định vị trí tương đối và `order < 1000` (addendum 3D §A4).
    expect(order.findIndex(([k]) => k === 'core.scheduled-tasks')).toBeLessThan(order.findIndex(([k]) => k === 'entitlements'));
    const a = await seedOrg();
    const b = await seedOrg();
    orgs.push(a, b);
    await seedOrgEntitlement(a.orgId, 'free');
    await seedOrgEntitlement(b.orgId, 'pro');
    await makeDue(a.orgId);
    expect(await app.get(OrgScope).run(a.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(a.orgId)))).toBe('purged');
    expect(await readOrgEntitlement(a.orgId)).toBeUndefined();
    expect(await readOrgEntitlement(b.orgId)).toMatchObject({ planKey: 'pro' });
  });
});

describe('without the entitlements participant a purge fails loud (spec SP4 criterion 10, R-1)', () => {
  let app: INestApplication;
  let o: SeededOrg;
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    o = await seedOrg();
    await seedOrgEntitlement(o.orgId, 'free');
    await makeDue(o.orgId);
  });
  afterAll(async () => {
    await o?.dispose();
    await app?.close();
  });
  it('the organization delete hits FK RESTRICT (23001) and nothing is removed', async () => {
    const err: unknown = await app
      .get(OrgScope)
      .run(o.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(o.orgId)))
      .catch((e: unknown) => e);
    expect(pgFields(err)?.sqlState).toBe('23001');
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'free' });
  });
});
```
Run: `pnpm vitest run --project integration test/integration/entitlements/provisioning.spec.ts`
Expected: FAIL (`Cannot find module …/provision-org.subscriber.js`).

- [ ] **Step 2: Repository, participant, subscriber, purge participant**

`src/modules/entitlements/ports/org-entitlement.repository.ts` thêm:
```ts
export type ProvisionResult = { kind: 'INSERTED'; version: number } | { kind: 'ALREADY_PROVISIONED' } | { kind: 'ORG_GONE' };
```
và trong lớp:
```ts
  /** Participant tạo org: chèn `DEFAULT`; không `ON CONFLICT` (org vừa tạo không thể có dòng). Gói thiếu → ném. */
  abstract insertDefault(planKey: string): Promise<{ version: number }>;
  /** Subscriber dự phòng: `ON CONFLICT (org_id) DO NOTHING`, chỉ chèn khi org còn (join `organizations`, không bắt 23503). */
  abstract insertDefaultIfAbsent(planKey: string): Promise<ProvisionResult>;
```
`src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts` thêm (import `type ProvisionResult`):
```ts
const Version = z.object({ version: z.coerce.number().int().min(1) });
const Presence = z.object({ org_present: z.coerce.number().int(), row_present: z.coerce.number().int() });
```
```ts
  async insertDefault(planKey: string): Promise<{ version: number }> {
    const rows = await this.db.execute(
      `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
       SELECT app_current_org(), id, 'DEFAULT', now() FROM plans WHERE key = ? RETURNING version`,
      [planKey],
    );
    if (!rows[0]) throw new Error(`default plan "${planKey}" is not in the plans table (the catalogue check should have refused to boot)`);
    return Version.parse(rows[0]);
  }

  async insertDefaultIfAbsent(planKey: string): Promise<ProvisionResult> {
    const rows = await this.db.execute(
      `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
       SELECT o.id, p.id, 'DEFAULT', now() FROM organizations o JOIN plans p ON p.key = ? WHERE o.id = app_current_org()
       ON CONFLICT (org_id) DO NOTHING RETURNING version`,
      [planKey],
    );
    if (rows[0]) return { kind: 'INSERTED', version: Version.parse(rows[0]).version };
    const [raw] = await this.db.execute(
      `SELECT (SELECT count(*) FROM organizations WHERE id = app_current_org())::int AS org_present,
              (SELECT count(*) FROM org_entitlements WHERE org_id = app_current_org())::int AS row_present`,
    );
    const p = Presence.parse(raw);
    if (p.org_present === 0) return { kind: 'ORG_GONE' };
    if (p.row_present === 1) return { kind: 'ALREADY_PROVISIONED' };
    throw new Error(`default plan "${planKey}" is not in the plans table (the catalogue check should have refused to boot)`);
  }
```
`src/modules/entitlements/application/provision-org.participant.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { OrgCreationParticipant, OrgCreationParticipantContributor } from '../../tenancy/index.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import { EntitlementsContextError } from '../errors.js';
import { ORG_ENTITLEMENT_AGGREGATE, PlanChangedEvent } from '../events.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import { ENTITLEMENT_PLANS } from './entitlement-catalogue.registry.js';

/**
 * S4-D9: org mới có dòng `org_entitlements` NGAY trong transaction tạo org (không có cửa sổ "org chưa có gói"), chạy trước
 * `MemberAdmission` của người tạo (4B đọc ghế lúc đó; `minimum: 1` của `tenancy.seats` bảo đảm người tạo vào được).
 */
@Injectable()
@OrgCreationParticipantContributor({ key: 'entitlements.provision', order: 0 })
export class ProvisionOrgParticipant extends OrgCreationParticipant {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly events: EventPublisher,
    @Inject(ENTITLEMENT_PLANS) private readonly plans: PlanCatalogue,
  ) {
    super();
  }

  async onOrgCreated(orgId: string, actor: EventActor): Promise<void> {
    if (!this.uow.inTransaction() || this.ctx.orgId() !== orgId)
      throw new EntitlementsContextError('the entitlements creation participant must run in the creation transaction and OrgScope of the new org');
    const toPlan = this.plans.defaultPlan;
    const { version } = await this.repo.insertDefault(toPlan);
    await this.events.publish(PlanChangedEvent, {
      data: { orgId, fromPlan: null, toPlan, cause: 'DEFAULT', causeRef: null },
      aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
      actor,
    });
  }
}
```
`src/modules/entitlements/application/provision-org.subscriber.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher, EventSubscriber, type EventEnvelope, type EventHandler } from '../../../core/events/index.js';
import { OrgCreatedEvent } from '../../tenancy/index.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import { EntitlementsContextError } from '../errors.js';
import { ORG_ENTITLEMENT_AGGREGATE, PlanChangedEvent } from '../events.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import { ENTITLEMENT_PLANS } from './entitlement-catalogue.registry.js';

const PROVISION_ACTOR = { type: 'system', id: 'entitlements.provision-org' } as const;

/**
 * Lưới dự phòng (S4-D9, E-9): phủ cửa sổ rolling deploy (pod cũ tạo org không có participant). Chạy ở worker trong
 * UnitOfWork + Inbox (SP1) và OrgScope của event. Org đã purge trước khi event tới (`core.event.deliver` chạy cả trên org
 * không còn): câu chèn join `organizations` nên không lỗi FK; ghi INFO và coi là xong (không retry).
 */
@Injectable()
@EventSubscriber({ consumer: 'entitlements.provision-org', event: OrgCreatedEvent })
export class ProvisionOrgSubscriber implements EventHandler<typeof OrgCreatedEvent> {
  private readonly logger = new Logger(ProvisionOrgSubscriber.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly events: EventPublisher,
    @Inject(ENTITLEMENT_PLANS) private readonly plans: PlanCatalogue,
  ) {}

  async handle(e: EventEnvelope<z.infer<typeof OrgCreatedEvent.schema>>): Promise<void> {
    if (!this.uow.inTransaction() || this.ctx.orgId() !== e.data.orgId)
      throw new EntitlementsContextError('entitlements.provision-org must run in the UnitOfWork and OrgScope of the event organization');
    const toPlan = this.plans.defaultPlan;
    const result = await this.repo.insertDefaultIfAbsent(toPlan);
    switch (result.kind) {
      case 'ORG_GONE':
        this.logger.log({ event: 'entitlements_provision_skipped_org_gone' }, 'the organization is gone; nothing to provision');
        return;
      case 'ALREADY_PROVISIONED':
        return;
      case 'INSERTED':
        await this.events.publish(PlanChangedEvent, {
          data: { orgId: e.data.orgId, fromPlan: null, toPlan, cause: 'DEFAULT', causeRef: null },
          aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: e.data.orgId, version: result.version },
          actor: PROVISION_ACTOR,
          causationId: e.id,
        });
        return;
      default: {
        const unknownKind: never = result;
        throw new Error(`unknown provision result ${String(Reflect.get(unknownKind, 'kind'))}`);
      }
    }
  }
}
```
`src/modules/entitlements/application/org-purge.participant.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Db } from '../../../core/database/index.js';
import { OrgPurgeParticipant, OrgPurgeParticipantContributor } from '../../tenancy/index.js';
import { ENTITLEMENTS_PURGE_ORDER } from '../constants.js';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../infra/sql/entitlements-purge.sql.js';

/**
 * Xoá cứng (spec §13.2, R-X5, addendum 3D §A4): `order = 100`, trước tenancy core (1000) vì bảng SP4 trỏ tới
 * `organizations`. Chạy TRONG transaction purge (OrgScope của org), con trước cha; quên bảng nào thì purge fail to (23001).
 * Billing và audit không phải participant, nên transaction purge không khoá `billing_accounts` (E-16).
 */
@Injectable()
@OrgPurgeParticipantContributor({ key: 'entitlements', order: ENTITLEMENTS_PURGE_ORDER })
export class EntitlementsPurgeParticipant extends OrgPurgeParticipant {
  constructor(private readonly db: Db) {
    super();
  }
  async purge(): Promise<void> {
    for (const sql of ENTITLEMENTS_PURGE_STATEMENTS) await this.db.execute(sql);
  }
}
```
Kiểm lại mảnh `import` của `OrgPurgeParticipant`: phải đi qua `tenancy/index.ts` (luật `modules-only-index-of-other-modules`); 3A Task 19 export cả hai tên.

`src/modules/entitlements/entitlements.module.ts`:
- `EntitlementsCoreModule.register` thêm `ProvisionOrgParticipant` vào `providers` (tạo org chạy ở api; worker đối xứng, spec §13.2).
- `forWorker(plans)` trả `{ module: EntitlementsModule, imports: [EntitlementsCoreModule.register(plans)], providers: [ProvisionOrgSubscriber, EntitlementsPurgeParticipant] }`.

`.dependency-cruiser.cjs`: gỡ ngoại lệ `no-orphans` của `entitlements-purge.sql.ts` (Task 5) — participant đã import nó.

`test/support/entitlements-app.ts`:
```ts
import { Module } from '@nestjs/common';
import { ProvisionOrgSubscriber } from '../../src/modules/entitlements/application/provision-org.subscriber.js';

/** App e2e là api + worker events trong một process: subscriber dự phòng (chỉ ở `forWorker`) cần có mặt để event được giao. */
@Module({ providers: [ProvisionOrgSubscriber] })
export class EntitlementsProvisionTestModule {}
```
và `startEntitlementsApp` đổi `extraImports` thành `[EntitlementsModule.forApi(plans), EntitlementsProvisionTestModule, ...(opts.extraImports ?? [])]` (giữ `entitlementPermissions: false`).
Run: `pnpm vitest run --project integration test/integration/entitlements/provisioning.spec.ts`
Expected: PASS.

- [ ] **Step 3: E2E — tạo org qua API có đúng một dòng + một event; subscriber tự lành (PA-11, HT-3; fail trước Step 2)**

`test/e2e/entitlements/provisioning.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { ProvisionOrgSubscriber } from '../../../src/modules/entitlements/application/provision-org.subscriber.js';
import { examplePlans } from '../../../src/plans.example.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import { deleteOrgEntitlement, readOrgEntitlement } from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const planEvents = (orgId: string) =>
  ownerQuery<{ payload: Record<string, unknown>; headers: Record<string, string> }>(
    `SELECT payload, headers FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed' ORDER BY id`,
    [orgId],
  );

describe('every organization has exactly one entitlement row (spec SP4 criterion 1, S4-D9, PA-11, HT-3)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  const created: string[] = [];
  const createOrg = async () => {
    const r = await authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${randomUUID()}`).send({ name: 'Entitled' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    return r.body.id as string;
  };
  /** Chờ subscriber dự phòng (worker events chạy trong cùng process) xử lý xong `tenancy.org.created` của org. */
  const waitSafetyNet = async (orgId: string) => {
    const [createdEvent] = await ownerQuery<{ event_id: string }>(
      `SELECT event_id::text AS event_id FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.created'`,
      [orgId],
    );
    await vi.waitFor(
      async () =>
        expect(
          await ownerQuery(`SELECT 1 FROM processed_events WHERE consumer = 'entitlements.provision-org' AND event_id = $1`, [createdEvent?.event_id]),
        ).toHaveLength(1),
      { timeout: 30_000, interval: 250 },
    );
  };
  beforeAll(async () => {
    app = await startEntitlementsApp(examplePlans);
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf([p.authUserId]);
    await app?.close();
    await deleteSeededPrincipals([p]);
  });

  it('POST /v1/orgs commits the row with the default plan and one plan.changed by the creator; the safety net then adds nothing', async () => {
    const orgId = await createOrg();
    expect(await readOrgEntitlement(orgId)).toEqual({ planKey: 'free', source: 'DEFAULT', sourceRef: null, reason: null, lastBillingSeq: null, version: 1 });
    await waitSafetyNet(orgId);
    const events = await planEvents(orgId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ orgId, fromPlan: null, toPlan: 'free', cause: 'DEFAULT', causeRef: null });
    expect([events[0]?.headers.actorType, events[0]?.headers.actorId]).toEqual(['user', p.authUserId]);
    const r = await authed(app, p).get(`/v1/orgs/${orgId}/entitlements`);
    expect([r.status, r.body.plan.key, r.body.plan.source]).toEqual([200, 'free', 'DEFAULT']);
  });
  it('HT-3: a lost row answers 503; the safety-net subscriber restores it and the route answers 200 again', async () => {
    const orgId = await createOrg();
    // Subscriber đã xử lý event tạo org TRƯỚC khi xoá dòng: không có lần giao nào chen vào giữa xoá và GET (không flaky).
    await waitSafetyNet(orgId);
    await deleteOrgEntitlement(orgId);
    expect((await authed(app, p).get(`/v1/orgs/${orgId}/entitlements`)).status).toBe(503);
    await app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() =>
        app.get(ProvisionOrgSubscriber).handle({
          id: v7(),
          type: 'tenancy.org.created',
          version: 1,
          occurredAt: new Date().toISOString(),
          orgId,
          actor: { type: 'user', id: p.authUserId },
          aggregate: { type: 'organization', id: orgId, version: 1 },
          correlationId: 'ht-3',
          causationId: null,
          data: { orgId, createdByUserId: v7() },
        }),
      ),
    );
    const r = await authed(app, p).get(`/v1/orgs/${orgId}/entitlements`);
    expect([r.status, r.body.plan.key]).toEqual([200, 'free']);
    expect((await planEvents(orgId)).map((e) => e.headers.actorId)).toEqual([p.authUserId, 'entitlements.provision-org']);
  });
});
```
`test/e2e/entitlements/auth-modes.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { examplePlans } from '../../../src/plans.example.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { authed } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const nowSec = () => Math.floor(Date.now() / 1000);

describe('AUTH_MODE=external: an org created with an external token is provisioned and readable (spec SP4 §20.3)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const created: string[] = [];
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startEntitlementsApp(examplePlans, {
      extraImports: [ResilienceModule],
      env: {
        AUTH_MODE: 'external',
        BETTER_AUTH_SECRET: '',
        DB_AUTH_PASSWORD: '',
        AUTH_EXTERNAL_JWKS_URL: jwks.url,
        AUTH_EXTERNAL_ISSUER: ISS,
        AUTH_EXTERNAL_AUDIENCE: AUD,
        AUTH_EXTERNAL_ALGORITHMS: 'RS256',
        AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
        AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
        RESILIENCE_ALLOWED_SCHEMES: 'http,https',
        RESILIENCE_ALLOWED_PORTS: new URL(jwks.url).port,
        RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
      },
    });
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });
  it('POST /v1/orgs then GET …/entitlements → the default plan, no new env needed', async () => {
    const t = await jwks.sign({ iss: ISS, aud: AUD, sub: `ext-${v7()}`, iat: nowSec(), exp: nowSec() + 300, idtyp: 'user', auth_time: nowSec() });
    const http = () => request(app.getHttpServer());
    const r = await http().post('/v1/orgs').set('authorization', `Bearer ${t}`).set('idempotency-key', `k-${v7()}`).send({ name: 'External' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    const e = await http().get(`/v1/orgs/${r.body.id}/entitlements`).set('authorization', `Bearer ${t}`);
    expect([e.status, e.body.plan.key]).toEqual([200, 'free']);
  });
});

describe('AUTH_MODE=hybrid: the same with a Better Auth session', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  const created: string[] = [];
  beforeAll(async () => {
    app = await startEntitlementsApp(examplePlans, { env: { AUTH_MODE: 'hybrid' } });
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf([p.authUserId]);
    await app?.close();
    await deleteSeededPrincipals([p]);
    vi.unstubAllEnvs();
  });
  it('POST /v1/orgs then GET …/entitlements → the default plan', async () => {
    const r = await authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name: 'Hybrid' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    const e = await authed(app, p).get(`/v1/orgs/${r.body.id}/entitlements`);
    expect([e.status, e.body.plan.key]).toEqual([200, 'free']);
  });
});
```
Kiểm trước: env tối thiểu của `AUTH_MODE=hybrid` trong `test/e2e/tenancy/auth-modes.e2e.spec.ts` của 3A (Task 27 dựng `startFakeIdp` và các biến `AUTH_OIDC_*`); nếu `hybrid` không boot chỉ với `AUTH_MODE`, chép đúng khối `startFakeIdp` + env của file 3A vào `beforeAll` (và `idp.close()` ở `afterAll`). `local` là mode mặc định của mọi e2e khác của file này.
Run: `pnpm vitest run --project integration test/e2e/entitlements/provisioning.e2e.spec.ts test/e2e/entitlements/auth-modes.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 4: Kiểm toàn cục, commit**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e test/integration
```
Expected: xanh. E2E tenancy của 3A tạo org qua `startTenancyApp` (không có EntitlementsModule) không có participant → không dòng → `purgeOrgs` vẫn đúng; e2e qua composition thật (`AppApiModule` trong `api-entry.ts`) có dòng → `purgeOrgs` xoá theo `PURGE_ORDER` (Task 5).
```bash
git add src/modules/entitlements .dependency-cruiser.cjs test/support/entitlements-app.ts test/integration/entitlements/provisioning.spec.ts test/e2e/entitlements
git commit -m "feat(entitlements): provision the default plan inside org creation, a tenancy.org.created safety net, and the order-100 purge participant"
```

---

### Task 12: `PlanAssignments.assign` — điểm nối SP5 (R-X1): khoá, quyết định, ghi, event; hợp đồng ném lỗi (PA-9, PA-10, PA-13…PA-16, EV-10)

**Files:**
- Create: `src/modules/entitlements/application/plan-assignments.service.ts`, `test/fixtures/migrations/Migration<ts>_fixture_billing_accounts.ts` (CLI)
- Create (test): `test/integration/entitlements/plan-assignments.spec.ts`, `test/integration/entitlements/plan-assignments-races.spec.ts`, `test/support/entitlements-races.ts`, `test/unit/modules/entitlements/events.spec.ts` (nhánh 6.0 đã merge)
- Modify: `src/modules/entitlements/ports/org-entitlement.repository.ts`, `src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts`, `src/modules/entitlements/entitlements.module.ts`, `src/modules/entitlements/index.ts`, `test/integration/core/database/rls-catalog.spec.ts`

**Interfaces:**
- Consumes: `decideAssignment`, `AssignPlanCommand`, `AssignmentCause`, `CurrentAssignment` (Task 4), `EntitlementCatalogueRegistry`, `EntitlementsMetrics`, `AssignmentMetricResult`, `entitlementsSpan`, lỗi có tên, `PlanChangedEvent` (Task 6), `REASON_MAX_LENGTH`, `SOURCE_REF_MAX_LENGTH` (Task 3), `zodIssuesToFields`, `AppError`, `CoreErrors` (core/errors), `PurgeOrgHandler` (3A), `seedFixtureCatalogue`, `fixturePlans`, `FixtureFeaturesModule` (Task 7), `installOtelCapture`.
- Produces:
  - `type AssignmentResult = { kind: 'APPLIED'; fromPlan; toPlan; version } | { kind: 'UNCHANGED'; version } | { kind: 'STALE'; lastBillingSeq: bigint } | { kind: 'REJECTED_RETIRED'; planKey }`.
  - `PlanAssignments.assign(cmd: AssignPlanCommand): Promise<AssignmentResult>` (trong UoW + OrgScope của caller; lỗi theo "Hợp đồng ném lỗi" của Global Constraints), `PlanAssignments.defaultPlanKey(): string`.
  - Repository: `lockForAssignment(targetPlanKey): Promise<AssignmentRow | undefined>` với `AssignmentRow = { current: CurrentAssignment; target: { id: string; key: string; retired: boolean } | null }` (hai câu: khoá `FOR NO KEY UPDATE` chỉ trên `org_entitlements`, không JOIN; rồi tra `plans` — spec §10.2 bước 2, sửa sau chốt r2), `applyAssignment(a: { planId; source: 'BILLING' | 'PLATFORM_ADMIN'; sourceRef; reason; billingSequence: bigint | null }): Promise<number>` (version mới), `recordBillingSequence(sequence: bigint): Promise<void>`.
  - Export ở `index.ts`: `PlanAssignments`, `type AssignPlanCommand`, `type AssignmentCause`, `type AssignmentResult`.
  - Bảng fixture `fixture_billing_accounts (org_ref UUID UNIQUE, plan_assignment_seq BIGINT)`, global, không FK tới `organizations` (vai `billing_accounts` của SP5 cho PA-14, PA-15).
  - `test/support/entitlements-races.ts`: `holdEntitlementRow(orgId): Promise<{ pid: number; release(): Promise<void>; commitWith(sql: string, params?: unknown[]): Promise<void> }>`, `waitForBlocked(pid, count, deadlineMs?)`.

- [ ] **Step 1: Bảng fixture "billing" và helper race**

Run: `pnpm exec mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_billing_accounts`
Viết file vừa sinh:
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Vai `billing_accounts` của SP5 (spec SP4 PA-14, PA-15): khoá của caller đứng TRƯỚC `org_entitlements` trong thứ tự khoá
 * toàn hệ thống (§3.6). Không FK tới `organizations` (như S5-D4: account sống qua purge), không cột `org_id` (bảng global).
 */
export class Migration<ts>_fixture_billing_accounts extends Migration {
  override name = 'Migration<ts>_fixture_billing_accounts';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE fixture_billing_accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_ref UUID NOT NULL,
    plan_assignment_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fixture_billing_accounts_org_ref_uq UNIQUE (org_ref));`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON fixture_billing_accounts TO app_user;`);
    this.addSql(`GRANT UPDATE (plan_assignment_seq, updated_at) ON fixture_billing_accounts TO app_user;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE fixture_billing_accounts;`);
  }
}
```
`test/integration/core/database/rls-catalog.spec.ts`: `GLOBAL_TABLES` thêm `'fixture_billing_accounts',` cạnh các bảng fixture khác.
`test/support/entitlements-races.ts`:
```ts
import pg from 'pg';
import { getInfra } from './infra.js';

const DEFAULT_DEADLINE_MS = 10_000;
const POLL_MS = 20;

/**
 * Barrier của test race (spec SP3 §18.0 mẫu, SP4 §17): một kết nối `app_user` riêng giữ `FOR NO KEY UPDATE` trên dòng
 * `org_entitlements` của org; các transaction đang thử đều xếp hàng sau nó, `release()` thả cho chúng đua.
 */
export async function holdEntitlementRow(orgId: string): Promise<{ pid: number; release(): Promise<void> }> {
  const { pg: p } = getInfra();
  const c = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
  await c.query('SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE');
  const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('holder has no backend pid');
  return {
    pid,
    release: async () => {
      try {
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    },
    /** Ghi dưới khoá đang giữ rồi COMMIT (phiên chờ thấy phiên bản dòng mới): ca tất định của C2 (Task 12 Step 4). */
    commitWith: async (sql: string, params: unknown[] = []) => {
      try {
        await c.query(sql, params);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        await c.end();
      }
    },
  };
}

/** Chờ tới khi đúng `count` phiên đang bị `pid` chặn (có hạn chót, ledger 3A: không poll vô hạn). */
export async function waitForBlocked(pid: number, count: number, deadlineMs = DEFAULT_DEADLINE_MS): Promise<void> {
  const { pg: p } = getInfra();
  const c = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app });
  await c.connect();
  try {
    const until = Date.now() + deadlineMs;
    for (;;) {
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
      if ((rows[0]?.n ?? 0) >= count) return;
      if (Date.now() > until) throw new Error(`only ${rows[0]?.n ?? 0} of ${count} sessions queued behind pid ${pid} within ${deadlineMs} ms`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    await c.end();
  }
}
```

- [ ] **Step 2: Test hành vi `assign` (fail)**

`test/integration/entitlements/plan-assignments.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  PlanAssignments,
  UnknownPlanError,
  type AssignPlanCommand,
} from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import { FixtureFeaturesModule, fixturePlans, seedFixtureCatalogue } from '../../support/entitlements-fixtures.js';
import { readOrgEntitlement, seedOrgEntitlement, seedPlans, withOwner } from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const STAFF = v7();
const billing = (planKey: string, sequence: bigint, ref = 'sub_1'): AssignPlanCommand => ({ planKey, cause: { kind: 'BILLING', ref, sequence } });
const admin = (planKey: string, expectedVersion: number, reason = 'goodwill credit'): AssignPlanCommand => ({
  planKey,
  cause: { kind: 'PLATFORM_ADMIN', reason, expectedVersion },
});

describe('PlanAssignments.assign (spec SP4 §10, R-X1, R-X18, C-2)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  /** Một "transaction billing" (hoặc admin nếu có `staff`) trong UoW + OrgScope của org, như caller thật (spec §10.3). */
  const assignIn = (orgId: string, cmd: AssignPlanCommand, staff?: string) =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() => {
        if (staff) app.get(RequestContext).setPrincipal({ type: 'user', id: staff });
        return app.get(PlanAssignments).assign(cmd);
      }),
    );
  const events = (orgId: string) =>
    ownerQuery<{ payload: Record<string, unknown>; headers: Record<string, string>; aggregate_version: string }>(
      `SELECT payload, headers, aggregate_version::text AS aggregate_version FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed' ORDER BY id`,
      [orgId],
    );
  const orgOn = async (plan: string, opts: Parameters<typeof seedOrgEntitlement>[2] = {}) => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('PA-16 (R-X18): the per-period reassertion chain — applied, renewal unchanged, staff, billing takes the slot back, same plan applied', async () => {
    const o = await orgOn('free');
    expect(await assignIn(o.orgId, billing('pro', 1n))).toEqual({ kind: 'APPLIED', fromPlan: 'free', toPlan: 'pro', version: 2 });
    expect(await assignIn(o.orgId, billing('pro', 2n))).toEqual({ kind: 'UNCHANGED', version: 2 });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'pro', source: 'BILLING', lastBillingSeq: '2', version: 2 });
    expect(await assignIn(o.orgId, admin('free', 2), STAFF)).toEqual({ kind: 'APPLIED', fromPlan: 'pro', toPlan: 'free', version: 3 });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'free', source: 'PLATFORM_ADMIN', sourceRef: null, reason: 'goodwill credit', lastBillingSeq: '2' });
    expect(await assignIn(o.orgId, billing('pro', 3n))).toEqual({ kind: 'APPLIED', fromPlan: 'free', toPlan: 'pro', version: 4 });
    expect(await assignIn(o.orgId, admin('pro', 4), STAFF)).toEqual({ kind: 'APPLIED', fromPlan: 'pro', toPlan: 'pro', version: 5 });
    expect(await assignIn(o.orgId, billing('pro', 4n))).toEqual({ kind: 'APPLIED', fromPlan: 'pro', toPlan: 'pro', version: 6 });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'pro', source: 'BILLING', sourceRef: 'sub_1', reason: null, lastBillingSeq: '4', version: 6 });
    const e = await events(o.orgId);
    expect(e.map((x) => [x.payload.cause, x.payload.fromPlan, x.payload.toPlan, x.aggregate_version])).toEqual([
      ['BILLING', 'free', 'pro', '2'],
      ['PLATFORM_ADMIN', 'pro', 'free', '3'],
      ['BILLING', 'free', 'pro', '4'],
      ['PLATFORM_ADMIN', 'pro', 'pro', '5'],
      ['BILLING', 'pro', 'pro', '6'],
    ]);
    expect(e.map((x) => x.headers.actorId)).toEqual(['billing', STAFF, 'billing', STAFF, 'billing']);
    expect(e[0]?.payload.causeRef).toBe('sub_1');
    expect(e[1]?.payload.causeRef).toBeNull();
    // Phần "override đặt giữa chuỗi còn nguyên ở cuối" của PA-16 chạy ở 4C (bảng override thuộc 4C).
  });
  it('PA-13: REJECTED_RETIRED and UNCHANGED from billing record the sequence without version or event; a smaller one is then STALE', async () => {
    const o = await orgOn('enterprise', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 1n });
    expect(await assignIn(o.orgId, billing('legacy', 5n))).toEqual({ kind: 'REJECTED_RETIRED', planKey: 'legacy' });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'enterprise', lastBillingSeq: '5', version: 1 });
    expect(await assignIn(o.orgId, billing('enterprise', 6n))).toEqual({ kind: 'UNCHANGED', version: 1 });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ lastBillingSeq: '6', version: 1 });
    expect(await assignIn(o.orgId, billing('pro', 4n))).toEqual({ kind: 'STALE', lastBillingSeq: 6n });
    expect(await events(o.orgId)).toEqual([]);
  });
  it('PA-10 (E-8): staff assigns, a later billing sequence wins; an older billing command arriving afterwards is STALE', async () => {
    const o = await orgOn('free', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 3n });
    await assignIn(o.orgId, admin('enterprise', 1), STAFF);
    expect(await assignIn(o.orgId, billing('pro', 4n))).toMatchObject({ kind: 'APPLIED', fromPlan: 'enterprise', toPlan: 'pro' });
    expect(await assignIn(o.orgId, billing('free', 2n))).toEqual({ kind: 'STALE', lastBillingSeq: 4n });
    expect((await readOrgEntitlement(o.orgId))?.planKey).toBe('pro');
  });
  it('staff: a stale If-Match version is 412 before any write; a retired target is REJECTED_RETIRED without any write', async () => {
    const o = await orgOn('free');
    const before = (await otel.metric('entitlements_plan_assignments_total', { cause: 'PLATFORM_ADMIN', result: 'precondition_failed' })) ?? 0;
    const err: unknown = await assignIn(o.orgId, admin('pro', 7), STAFF).catch((e: unknown) => e);
    expect(err instanceof AppError ? err.error.code : undefined).toBe('precondition_failed');
    expect(await otel.metric('entitlements_plan_assignments_total', { cause: 'PLATFORM_ADMIN', result: 'precondition_failed' })).toBe(before + 1);
    expect(await assignIn(o.orgId, admin('legacy', 1), STAFF)).toEqual({ kind: 'REJECTED_RETIRED', planKey: 'legacy' });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'free', source: 'DEFAULT', version: 1, lastBillingSeq: null });
  });
  it('Review Focus 3: billing sequences beyond 2^53 compare exactly', async () => {
    const o = await orgOn('free');
    const big = 2n ** 53n + 1n;
    expect(await assignIn(o.orgId, billing('pro', big))).toMatchObject({ kind: 'APPLIED' });
    expect(await assignIn(o.orgId, billing('enterprise', big + 1n))).toMatchObject({ kind: 'APPLIED' });
    expect(await assignIn(o.orgId, billing('free', big))).toEqual({ kind: 'STALE', lastBillingSeq: big + 1n });
    expect((await readOrgEntitlement(o.orgId))?.lastBillingSeq).toBe((big + 1n).toString());
  });
  it('Review Focus 2: assign works on an org whose current plan is unknown to this pod (never EntitlementsVersionSkewError)', async () => {
    const disposeGhost = await seedPlans([{ key: 'ghost_assign' }]);
    const o = await seedOrg();
    try {
      await seedOrgEntitlement(o.orgId, 'ghost_assign');
      expect(await assignIn(o.orgId, billing('pro', 1n))).toEqual({ kind: 'APPLIED', fromPlan: 'ghost_assign', toPlan: 'pro', version: 2 });
    } finally {
      await o.dispose();
      await disposeGhost();
    }
  });
  it('PA-14 (C-2): named errors come before the first write, so the caller transaction keeps working and commits', async () => {
    const withRow = await orgOn('free');
    const noRow = await seedOrg();
    orgs.push(noRow);
    for (const org of [withRow.orgId, noRow.orgId])
      await withOwner((c) => c.query('INSERT INTO fixture_billing_accounts (org_ref) VALUES ($1)', [org]));
    const caught: unknown[] = [];
    /** Vai transaction billing của SP5: khoá account TRƯỚC (thứ tự §3.6), gọi `assign`, rồi ghi tiếp và COMMIT. */
    const billingTx = (orgId: string, cmd: AssignPlanCommand) =>
      app.get(OrgScope).run(orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const db = app.get(Db);
          const bump = () =>
            db.execute(`UPDATE fixture_billing_accounts SET plan_assignment_seq = plan_assignment_seq + 1, updated_at = now() WHERE org_ref = ?::uuid`, [orgId]);
          await bump();
          await app.get(PlanAssignments).assign(cmd).catch((e: unknown) => caught.push(e));
          await bump();
        }),
      );
    const seqOf = async (orgId: string) =>
      withOwner(async (c) => (await c.query<{ seq: string }>('SELECT plan_assignment_seq::text AS seq FROM fixture_billing_accounts WHERE org_ref = $1', [orgId])).rows[0]?.seq);
    // (a) key không có trong catalogue gói của pod.
    await billingTx(withRow.orgId, billing('platinum', 1n));
    // (b) org không có dòng `org_entitlements`.
    await billingTx(noRow.orgId, billing('pro', 1n));
    // (c) key có trong catalogue nhưng dòng `plans` chưa có (migration gói chưa chạy): xoá dòng `legacy` SAU khi app boot
    //     (không org nào ở `legacy`), khôi phục trong `finally` để catalogue check của file sau đạt.
    await withOwner((c) => c.query(`DELETE FROM plans WHERE key = 'legacy'`));
    try {
      await billingTx(withRow.orgId, billing('legacy', 1n));
    } finally {
      await seedPlans([{ key: 'legacy', retired: true }]);
    }
    expect(caught.map((e) => (e instanceof Error ? e.constructor.name : typeof e))).toEqual(['UnknownPlanError', 'EntitlementsRowMissingError', 'UnknownPlanError']);
    expect(caught[0]).toBeInstanceOf(UnknownPlanError);
    expect(caught[1]).toBeInstanceOf(EntitlementsRowMissingError);
    expect([await seqOf(withRow.orgId), await seqOf(noRow.orgId)]).toEqual(['4', '2']);
    expect(await readOrgEntitlement(withRow.orgId)).toMatchObject({ planKey: 'free', version: 1, lastBillingSeq: null });
    await withOwner((c) => c.query('DELETE FROM fixture_billing_accounts WHERE org_ref = ANY($1::uuid[])', [[withRow.orgId, noRow.orgId]]));
  });
  it('malformed commands are validation_failed before any SQL; missing context is an EntitlementsContextError', async () => {
    const o = await orgOn('free');
    for (const cmd of [billing('pro', 0n), billing('pro', 1n, ''), billing('pro', 1n, 'r'.repeat(129)), admin('pro', 1, ' padded '), admin('pro', 1, '😀'.repeat(501))]) {
      const err: unknown = await assignIn(o.orgId, cmd, STAFF).catch((e: unknown) => e);
      expect(err instanceof AppError ? err.error.code : err).toBe('validation_failed');
    }
    expect(await assignIn(o.orgId, admin('pro', 1, '😀'.repeat(500)), STAFF)).toMatchObject({ kind: 'APPLIED' });
    await expect(app.get(OrgScope).run(o.orgId, () => app.get(PlanAssignments).assign(billing('pro', 9n)))).rejects.toBeInstanceOf(EntitlementsContextError);
    await expect(assignIn(o.orgId, admin('free', 2))).rejects.toBeInstanceOf(EntitlementsContextError);
    expect(app.get(PlanAssignments).defaultPlanKey()).toBe('free');
  });
  it('the staff reason never reaches logs, spans, metrics or the event; the metric counts by cause and result', async () => {
    const o = await orgOn('free');
    const reason = `secret-reason-${v7()}`;
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void lines.push(JSON.stringify(args)));
    otel.reset();
    await assignIn(o.orgId, admin('pro', 1, reason), STAFF);
    expect(lines.join('\n')).not.toContain(reason);
    expect(JSON.stringify(otel.spans('entitlements.plan.assign').map((s) => s.attributes))).not.toContain(reason);
    expect(JSON.stringify(await events(o.orgId))).not.toContain(reason);
    expect(await otel.metric('entitlements_plan_assignments_total', { cause: 'PLATFORM_ADMIN', result: 'applied' })).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });
});
```
Ghi chú ca PA-14: `plan_assignment_seq` tăng 2 lần mỗi transaction (hai câu `bump`), nên org có dòng (2 transaction) = 4, org không dòng (1 transaction) = 2: câu `bump` thứ hai chạy và COMMIT sau lỗi có tên của `assign`, tức transaction của caller không hỏng.

Run: `pnpm vitest run --project integration test/integration/entitlements/plan-assignments.spec.ts`
Expected: FAIL (`PlanAssignments` chưa export).

- [ ] **Step 3: Repository và service**

`src/modules/entitlements/ports/org-entitlement.repository.ts` thêm:
```ts
import type { CurrentAssignment } from '../domain/plan-assignment.js';

export type AssignmentRow = { current: CurrentAssignment; target: { id: string; key: string; retired: boolean } | null };
export type AppliedAssignment = {
  planId: string;
  source: 'BILLING' | 'PLATFORM_ADMIN';
  sourceRef: string | null;
  reason: string | null;
  billingSequence: bigint | null;
};
```
và trong lớp:
```ts
  /**
   * Khoá `FOR NO KEY UPDATE` chỉ trên dòng `org_entitlements` rồi tra `plans` (spec §10.2 bước 2), cả hai trước câu ghi đầu
   * tiên; không có dòng → `undefined`; gói đích lạ → `target: null`.
   */
  abstract lockForAssignment(targetPlanKey: string): Promise<AssignmentRow | undefined>;
  /** Câu APPLIED: đổi gói/nguồn, `last_billing_seq = COALESCE(seq, last_billing_seq)`, `version + 1`; trả version mới. */
  abstract applyAssignment(a: AppliedAssignment): Promise<number>;
  /** UNCHANGED/REJECTED_RETIRED của BILLING: chỉ ghi nhận `last_billing_seq` (không version, không event). */
  abstract recordBillingSequence(sequence: bigint): Promise<void>;
```
`src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts` thêm (import `AssignmentRow`, `AppliedAssignment`):
```ts
const LockRaw = z.object({
  plan_id: z.string(),
  plan_source: z.enum(PLAN_SOURCES),
  plan_source_ref: z.string().nullable(),
  last_billing_seq: z.string().nullable(),
  version: z.coerce.number().int().min(1),
});
const PlanRaw = z.object({ id: z.string(), key: z.string(), retired: z.boolean() });
```
```ts
  async lockForAssignment(targetPlanKey: string): Promise<AssignmentRow | undefined> {
    // Câu 1 khoá CHỈ `org_entitlements`, không JOIN (C2 review 4A, spec §10.2 bước 2). Dưới READ COMMITTED, phiên chờ
    // khoá được Postgres kiểm lại (EvalPlanQual) trên phiên bản MỚI của dòng khoá nhưng ghép với dòng `plans` đã đọc TRƯỚC
    // khi chờ; nếu phiên kia vừa đổi `plan_id`, điều kiện JOIN `cur.id = e.plan_id` sai và câu trả 0 dòng → giả
    // `EntitlementsRowMissingError` (503) dù dòng còn — SP5 hiểu là org đã purge và commit tiền mà không áp gói (A10).
    // Không JOIN thì điều kiện duy nhất là `org_id = app_current_org()`, luôn đúng với phiên bản mới.
    const locked = await this.db.execute(
      `SELECT plan_id::text AS plan_id, plan_source, plan_source_ref, last_billing_seq::text AS last_billing_seq, version
       FROM org_entitlements WHERE org_id = app_current_org()
       FOR NO KEY UPDATE`,
    );
    if (locked.length > 1) throw new Error(`org_entitlements lock returned ${locked.length} rows (org_entitlements PK violated?)`);
    if (!locked[0]) return undefined;
    const e = LockRaw.parse(locked[0]);
    // Câu 2: `plans` là bảng global (không RLS, không khoá); câu mới có snapshot mới nên thấy gói mà phiên trước vừa commit.
    // Vẫn trước câu ghi đầu tiên, nên hợp đồng C-2 giữ nguyên.
    const plans = (
      await this.db.execute(`SELECT id::text AS id, key, retired_at IS NOT NULL AS retired FROM plans WHERE id = ?::bigint OR key = ?`, [
        e.plan_id,
        targetPlanKey,
      ])
    ).map((r) => PlanRaw.parse(r));
    const current = plans.find((p) => p.id === e.plan_id);
    if (!current) throw new Error(`org_entitlements.plan_id ${e.plan_id} has no plans row (FK org_entitlements.plan_id violated?)`);
    const target = plans.find((p) => p.key === targetPlanKey);
    return {
      current: {
        planKey: current.key,
        source: e.plan_source,
        sourceRef: e.plan_source_ref,
        lastBillingSeq: e.last_billing_seq === null ? null : BigInt(e.last_billing_seq),
        version: e.version,
      },
      target: target ? { id: target.id, key: target.key, retired: target.retired } : null,
    };
  }

  async applyAssignment(a: AppliedAssignment): Promise<number> {
    const rows = await this.db.execute(
      `UPDATE org_entitlements SET plan_id = ?::bigint, plan_source = ?, plan_source_ref = ?, plan_reason = ?, plan_assigned_at = now(),
              last_billing_seq = COALESCE(?::bigint, last_billing_seq), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() RETURNING version`,
      [a.planId, a.source, a.sourceRef, a.reason, a.billingSequence?.toString() ?? null],
    );
    if (!rows[0]) throw new Error('applyAssignment touched no row although the row was locked in this transaction');
    return Version.parse(rows[0]).version;
  }

  async recordBillingSequence(sequence: bigint): Promise<void> {
    const rows = await this.db.execute(
      `UPDATE org_entitlements SET last_billing_seq = ?::bigint, updated_at = now() WHERE org_id = app_current_org() RETURNING 1 AS ok`,
      [sequence.toString()],
    );
    if (!rows[0]) throw new Error('recordBillingSequence touched no row although the row was locked in this transaction');
  }
```
`src/modules/entitlements/application/plan-assignments.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors, zodIssuesToFields } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { REASON_MAX_LENGTH, SOURCE_REF_MAX_LENGTH } from '../constants.js';
import { decideAssignment, type AssignPlanCommand } from '../domain/plan-assignment.js';
import { entitlementsConfig } from '../entitlements.config.js';
import { entitlementsSpan } from '../entitlements-telemetry.js';
import { EntitlementsContextError, EntitlementsRowMissingError, UnknownPlanError } from '../errors.js';
import { ORG_ENTITLEMENT_AGGREGATE, PlanChangedEvent } from '../events.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { EntitlementsMetrics, type AssignmentMetricResult } from './entitlements-metrics.js';

export type AssignmentResult =
  | { readonly kind: 'APPLIED'; readonly fromPlan: string; readonly toPlan: string; readonly version: number }
  | { readonly kind: 'UNCHANGED'; readonly version: number }
  | { readonly kind: 'STALE'; readonly lastBillingSeq: bigint }
  | { readonly kind: 'REJECTED_RETIRED'; readonly planKey: string };

/** Code point như `char_length` của `CHECK` (một emoji là 1, không phải 2 đơn vị UTF-16). */
const codePoints = (s: string): number => [...s].length;
const Command = z.object({
  planKey: z.string().min(1),
  cause: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('BILLING'), ref: z.string().refine((r) => codePoints(r) >= 1 && codePoints(r) <= SOURCE_REF_MAX_LENGTH), sequence: z.bigint().min(1n) }),
    z.object({
      kind: z.literal('PLATFORM_ADMIN'),
      reason: z.string().refine((r) => r === r.trim() && codePoints(r) >= 1 && codePoints(r) <= REASON_MAX_LENGTH),
      expectedVersion: z.int().min(1),
    }),
  ]),
});
/** Actor của lệnh BILLING không có principal (job billing của SP5 chạy ở worker, spec §13.1). */
const BILLING_SYSTEM_ACTOR: EventActor = { type: 'system', id: 'billing' };

/**
 * Điểm nối SP5 (spec §10, R-X1): chạy TRONG UoW + OrgScope của caller, SAU khoá của caller (thứ tự §3.6), có hiệu lực lúc
 * commit. Kết quả nghiệp vụ không bao giờ là exception; lỗi có tên luôn ném trước câu ghi đầu tiên (C-2), nên transaction tiền
 * của SP5 vẫn commit được. Không đọc giá trị gói hiện tại trong catalogue của pod: không bao giờ `EntitlementsVersionSkewError`.
 */
@Injectable()
export class PlanAssignments {
  private readonly logger = new Logger(PlanAssignments.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly events: EventPublisher,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY) private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  /** Gói dự phòng khi subscription hết hạn (thay `BILLING_FALLBACK_PLAN_KEY` của SP5, R-X1). */
  defaultPlanKey(): string {
    return this.registry.plans().defaultPlan;
  }

  async assign(cmd: AssignPlanCommand): Promise<AssignmentResult> {
    const orgId = this.ctx.orgId();
    if (!this.uow.inTransaction() || orgId === undefined)
      throw new EntitlementsContextError('PlanAssignments.assign must run inside the caller UnitOfWork and OrgScope');
    const parsed = Command.safeParse(cmd);
    if (!parsed.success) throw new AppError(CoreErrors.VALIDATION_FAILED, { fields: zodIssuesToFields(parsed.error.issues) });
    const actor = this.actorOf(cmd);
    return entitlementsSpan('entitlements.plan.assign', () => this.run(orgId, cmd, actor), (r) => ({
      'entitlements.cause': cmd.cause.kind,
      'entitlements.result': r.kind,
    }));
  }

  private actorOf(cmd: AssignPlanCommand): EventActor {
    const p = this.ctx.principal();
    switch (cmd.cause.kind) {
      case 'BILLING':
        return p ? { type: 'user', id: p.id } : BILLING_SYSTEM_ACTOR;
      case 'PLATFORM_ADMIN':
        if (!p) throw new EntitlementsContextError('a PLATFORM_ADMIN assignment needs the staff principal in the request context');
        return { type: 'user', id: p.id };
      default: {
        const unknownCause: never = cmd.cause;
        throw new Error(`unknown assignment cause ${String(Reflect.get(unknownCause, 'kind'))}`);
      }
    }
  }

  private async run(orgId: string, cmd: AssignPlanCommand, actor: EventActor): Promise<AssignmentResult> {
    const cause = cmd.cause;
    if (!this.registry.plans().plans.has(cmd.planKey)) {
      this.count(cause.kind, 'unknown_plan');
      this.logger.error({ event: 'entitlements_unknown_plan', planKey: cmd.planKey, cause: cause.kind }, 'assign was given a plan this pod does not know');
      throw new UnknownPlanError(cmd.planKey);
    }
    const row = await this.repo.lockForAssignment(cmd.planKey);
    if (!row) {
      this.count(cause.kind, 'row_missing');
      this.metrics.rowMissing.add(1);
      this.logger.error({ event: 'entitlements_row_missing', cause: cause.kind }, 'assign found no org_entitlements row');
      throw new EntitlementsRowMissingError(this.cfg.rowMissingRetryAfterSec);
    }
    if (!row.target) {
      this.count(cause.kind, 'unknown_plan');
      this.logger.error({ event: 'entitlements_unknown_plan', planKey: cmd.planKey, cause: cause.kind }, 'the plan is in the catalogue but not in the plans table');
      throw new UnknownPlanError(cmd.planKey);
    }
    const decision = decideAssignment(row.current, { key: row.target.key, retired: row.target.retired }, cause);
    const billingSeq = cause.kind === 'BILLING' ? cause.sequence : null;
    switch (decision.kind) {
      case 'VERSION_MISMATCH':
        this.count(cause.kind, 'precondition_failed');
        throw new AppError(CoreErrors.PRECONDITION_FAILED, { expected: true });
      case 'STALE':
        this.count(cause.kind, 'stale');
        this.logger.log({ event: 'entitlements_assignment_stale', cause: cause.kind }, 'an older plan command was ignored');
        return { kind: 'STALE', lastBillingSeq: decision.lastBillingSeq };
      case 'REJECTED_RETIRED':
        if (billingSeq !== null) await this.repo.recordBillingSequence(billingSeq);
        this.count(cause.kind, 'rejected_retired');
        return { kind: 'REJECTED_RETIRED', planKey: cmd.planKey };
      case 'UNCHANGED':
        if (billingSeq !== null) await this.repo.recordBillingSequence(billingSeq);
        this.count(cause.kind, 'unchanged');
        return { kind: 'UNCHANGED', version: row.current.version };
      case 'APPLY': {
        const version = await this.repo.applyAssignment({
          planId: row.target.id,
          source: cause.kind,
          sourceRef: cause.kind === 'BILLING' ? cause.ref : null,
          reason: cause.kind === 'PLATFORM_ADMIN' ? cause.reason : null,
          billingSequence: billingSeq,
        });
        await this.events.publish(PlanChangedEvent, {
          data: { orgId, fromPlan: row.current.planKey, toPlan: cmd.planKey, cause: cause.kind, causeRef: cause.kind === 'BILLING' ? cause.ref : null },
          aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
          actor,
        });
        this.count(cause.kind, 'applied');
        return { kind: 'APPLIED', fromPlan: row.current.planKey, toPlan: cmd.planKey, version };
      }
      default: {
        const unknownDecision: never = decision;
        throw new Error(`unknown assignment decision ${String(Reflect.get(unknownDecision, 'kind'))}`);
      }
    }
  }

  private count(cause: AssignPlanCommand['cause']['kind'], result: AssignmentMetricResult): void {
    this.metrics.planAssignments.add(1, { cause, result });
  }
}
```
Ghi chú: `reason` không bao giờ vào log/span/event (chỉ vào `plan_reason`); `plan_source_ref` vào event (`causeRef`, spec §13.1: id opaque của billing) nhưng không vào log.
`src/modules/entitlements/entitlements.module.ts`: `EntitlementsCoreModule.register` thêm `PlanAssignments` vào `providers` và `exports`.
`src/modules/entitlements/index.ts` thêm:
```ts
export { PlanAssignments, type AssignmentResult } from './application/plan-assignments.service.js';
export type { AssignPlanCommand, AssignmentCause } from './domain/plan-assignment.js';
```
Run: `pnpm vitest run --project integration test/integration/entitlements/plan-assignments.spec.ts`
Expected: PASS.

- [ ] **Step 4: Race có barrier (PA-9 ×50, PA-15 ×50; fail trước Step 3)**

`test/integration/entitlements/plan-assignments-races.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { Db, OrgScope, UnitOfWork, pgFields } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { EntitlementsRowMissingError, PlanAssignments, type AssignmentResult } from '../../../src/modules/entitlements/index.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import { holdEntitlementRow, waitForBlocked } from '../../support/entitlements-races.js';
import { FixtureFeaturesModule, fixturePlans, seedFixtureCatalogue } from '../../support/entitlements-fixtures.js';
import { readOrgEntitlement, seedOrgEntitlement, withOwner } from '../../support/entitlements-seed.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const RUNS = 50;
const DEADLOCK = '40P01';
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'race',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('race'),
});

describe('plan assignment races with a row-lock barrier (spec SP4 §17 E-5, E-7, E-16; PA-9, PA-15)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]));
  }, 120_000);
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await withOwner((c) => c.query('DELETE FROM fixture_billing_accounts WHERE org_ref = ANY($1::uuid[])', [orgs.map((o) => o.orgId)]));
    await app?.close();
    await disposeCatalogue?.();
  });
  /**
   * `lockAccount`: khoá dòng account của caller trước (vai SP5, PA-15). PA-9 tắt nó: hai lệnh cùng org sẽ xếp hàng ở khoá
   * account (cơ chế CHÍNH của E-5) thay vì ở `org_entitlements`; PA-9 kiểm lớp chặn CUỐI (khoá `org_entitlements` + so seq).
   */
  const billingTx = (orgId: string, planKey: string, sequence: bigint, lockAccount = true): Promise<AssignmentResult | Error> =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(async () => {
        if (lockAccount)
          await app.get(Db).execute(`UPDATE fixture_billing_accounts SET plan_assignment_seq = plan_assignment_seq + 1, updated_at = now() WHERE org_ref = ?::uuid`, [orgId]);
        return app
          .get(PlanAssignments)
          .assign({ planKey, cause: { kind: 'BILLING', ref: 'sub_1', sequence } })
          .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      }),
    );

  it(`PA-9 (E-5): commands with sequences 6 and 7 racing on one row always end on the plan of 7, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await seedOrg();
      orgs.push(o);
      await seedOrgEntitlement(o.orgId, 'free', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 5n });
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [billingTx(o.orgId, 'pro', 6n, false), billingTx(o.orgId, 'enterprise', 7n, false)];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const results = await Promise.all(racing);
      expect(results.filter((r) => r instanceof Error), `run ${i}`).toEqual([]);
      const kinds = results.map((r) => (r instanceof Error ? 'error' : r.kind)).sort();
      expect([['APPLIED', 'APPLIED'], ['APPLIED', 'STALE']], `run ${i}`).toContainEqual(kinds);
      expect(await readOrgEntitlement(o.orgId), `run ${i}`).toMatchObject({ planKey: 'enterprise', lastBillingSeq: '7' });
    }
  }, 300_000);

  it('C2 (deterministic): a plan change committed while assign waits on the row lock → STALE or APPLIED on the new row, never EntitlementsRowMissingError', async () => {
    const cases = [
      { sequence: 6n, kind: 'STALE', end: { planKey: 'enterprise', lastBillingSeq: '7' } },
      { sequence: 8n, kind: 'APPLIED', end: { planKey: 'pro', lastBillingSeq: '8' } },
    ] as const;
    for (const c of cases) {
      const o = await seedOrg();
      orgs.push(o);
      await seedOrgEntitlement(o.orgId, 'free', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 5n });
      const holder = await holdEntitlementRow(o.orgId);
      const waiting = billingTx(o.orgId, 'pro', c.sequence, false);
      await waitForBlocked(holder.pid, 1);
      // Phiên giữ khoá đổi `plan_id` (free → enterprise, seq 7) rồi COMMIT: đúng tình huống làm câu khoá có JOIN trả 0 dòng.
      await holder.commitWith(
        `UPDATE org_entitlements SET plan_id = (SELECT id FROM plans WHERE key = 'enterprise'), plan_source = 'BILLING', last_billing_seq = 7,
                version = version + 1, updated_at = now() WHERE org_id = app_current_org()`,
      );
      const result = await waiting;
      expect(result, `sequence ${c.sequence}`).not.toBeInstanceOf(EntitlementsRowMissingError);
      expect(result instanceof Error ? result.constructor.name : result.kind, `sequence ${c.sequence}`).toBe(c.kind);
      expect(await readOrgEntitlement(o.orgId), `sequence ${c.sequence}`).toMatchObject(c.end);
    }
  });

  it(`E-7: two staff commands with the same expected version → exactly one APPLIED, the other 412 re-checked under the lock, ×${RUNS}`, async () => {
    const staff = v7();
    for (let i = 0; i < RUNS; i++) {
      const o = await seedOrg();
      orgs.push(o);
      await seedOrgEntitlement(o.orgId, 'free');
      const staffTx = (planKey: string): Promise<unknown> =>
        app
          .get(OrgScope)
          .run(o.orgId, () =>
            app.get(UnitOfWork).run(() => {
              app.get(RequestContext).setPrincipal({ type: 'user', id: staff });
              return app.get(PlanAssignments).assign({ planKey, cause: { kind: 'PLATFORM_ADMIN', reason: 'race', expectedVersion: 1 } });
            }),
          )
          .catch((e: unknown) => e);
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [staffTx('pro'), staffTx('enterprise')];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const results = await Promise.all(racing);
      expect(results.filter((r) => r instanceof AppError && r.error.code === 'precondition_failed'), `run ${i}`).toHaveLength(1);
      expect(results.filter((r) => !(r instanceof Error)), `run ${i}`).toEqual([expect.objectContaining({ kind: 'APPLIED', version: 2 })]);
      expect((await readOrgEntitlement(o.orgId))?.version, `run ${i}`).toBe(2);
    }
  }, 300_000);

  it(`PA-15 (E-16): purge racing a billing transaction that holds its account lock never deadlocks, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await seedOrg();
      await seedOrgEntitlement(o.orgId, 'free', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 1n });
      await withOwner((c) => c.query('INSERT INTO fixture_billing_accounts (org_ref) VALUES ($1)', [o.orgId]));
      await withAppClient((c) =>
        inOrgTx(c, o.orgId, () => c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [o.orgId])),
      );
      const holder = await holdEntitlementRow(o.orgId);
      const assign = billingTx(o.orgId, 'pro', 2n);
      const purge = app
        .get(OrgScope)
        .run(o.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(o.orgId)))
        .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const [a, p] = await Promise.all([assign, purge]);
      for (const r of [a, p]) expect(r instanceof Error ? pgFields(r)?.sqlState : undefined, `run ${i}`).not.toBe(DEADLOCK);
      expect(p, `run ${i}`).toBe('purged');
      if (a instanceof Error) expect(a, `run ${i}`).toBeInstanceOf(EntitlementsRowMissingError);
      else expect(a, `run ${i}`).toMatchObject({ kind: 'APPLIED', toPlan: 'pro' });
      expect(await readOrgEntitlement(o.orgId), `run ${i}`).toBeUndefined();
      // Transaction "billing" vẫn commit câu UPDATE của chính nó (spec PA-15), dù `assign` áp trước purge hay gặp dòng đã mất.
      const account = await withOwner((c) =>
        c.query<{ seq: string }>('SELECT plan_assignment_seq::text AS seq FROM fixture_billing_accounts WHERE org_ref = $1', [o.orgId]),
      );
      expect(account.rows, `run ${i}`).toEqual([{ seq: '1' }]);
      await withOwner((c) => c.query('DELETE FROM fixture_billing_accounts WHERE org_ref = $1', [o.orgId]));
      await o.dispose();
    }
  }, 300_000);
});
```
Run: `pnpm vitest run --project integration test/integration/entitlements/plan-assignments-races.spec.ts`
Expected: PASS (mỗi vòng: hai phiên xếp hàng sau barrier, không `40P01`; PA-9 luôn kết thúc ở `enterprise`/`7`, không bao giờ `EntitlementsRowMissingError`; ca C2 tất định: seq 6 → `STALE`, seq 8 → `APPLIED`; E-7 đúng một `APPLIED` và một `412`; PA-15: purge luôn xong, `assign` hoặc áp trước rồi bị xoá, hoặc gặp dòng đã mất → `EntitlementsRowMissingError` trước câu ghi, và transaction billing vẫn commit câu `UPDATE` của nó).

- [ ] **Step 5: EV-10 (chỉ khi 6.0 đã merge và `events.ts` có cờ — nhánh B của Task 6)**

`test/unit/modules/entitlements/events.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PlanChangedEvent } from '../../../../src/modules/entitlements/events.js';

describe('entitlements events declare explicit flags (spec SP4 §13.1, R-X3, EV-10)', () => {
  it('plan.changed is audited and never a webhook', () => {
    expect([PlanChangedEvent.audit, PlanChangedEvent.webhook]).toEqual([true, false]);
  });
});
```
Nhánh A (6.0 chưa merge): không tạo file này; 6.0 thêm cờ và test theo bảng §13.1 (spec §13.1, X6-2); ghi vào mô tả PR.

- [ ] **Step 6: Kiểm toàn cục, commit**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run --project unit
pnpm vitest run --project integration test/integration/core/database test/integration/entitlements test/e2e/entitlements
```
Expected: xanh; `no-orphans` không cần ngoại lệ nào của entitlements nữa (`plan-assignment.ts` đã có người import).
```bash
git add src/modules/entitlements test/fixtures/migrations test/support/entitlements-races.ts test/integration/entitlements test/integration/core/database/rls-catalog.spec.ts test/unit/modules/entitlements
git commit -m "feat(entitlements): PlanAssignments.assign for SP5 with ordered billing sequences, named results and errors before the first write"
```

---
## Phần H — Chaos, prod-like, tài liệu, bàn giao (spec §20.4, §22)

### Task 13: Chaos (DB mất giữa đọc snapshot và giữa `assign` → 503), prod-like #3 (luồng HTTP 4A trên image thật), số đo image ADR 0013

**Files:**
- Create: `test/chaos/entitlements-outages.spec.ts`, `test/smoke/smoke-devices.ts`
- Modify: `test/smoke/tenancy.smoke.spec.ts` (import thiết bị từ file dùng chung), `test/smoke/entitlements.smoke.spec.ts`, `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: `startTcpProxy`, `type TcpProxy` (`test/support/tcp-proxy.ts`), `getInfra`, `startEntitlementsApp`, `seedFixtureCatalogue`, `FixtureFeaturesModule`, `fixturePlans`, `seedOrgEntitlement`, `readOrgEntitlement`, `SqlOrgEntitlementRepository` (Task 6, 11, 12), `PlanAssignments`, `isDbInfraError` (core/database), `toAppError` (core/errors), `Device`, `verifiedDevice`, `PASSWORD` (đang là hàm/hằng cục bộ của `test/smoke/tenancy.smoke.spec.ts`, 3A Task 12/26/29), `Mailpit`, `psql`, `logsSince`, `assertCleanLogs`, `workerHealth`.
- Produces: bằng chứng tiêu chí 11 (DB lỗi/timeout trên snapshot và `assign` → `503`, không bao giờ `500`, không ghi nửa chừng); `test/smoke/smoke-devices.ts` (`Device`, `verifiedDevice`, `PASSWORD` export dùng chung cho mọi file smoke); smoke 4A đầy đủ; dòng "SP4 (4A)" của ADR 0013.

- [ ] **Step 1: Chaos (fail nếu có đường nào ra 500)**

`test/chaos/entitlements-outages.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork, isDbInfraError } from '../../src/core/database/index.js';
import { toAppError } from '../../src/core/errors/index.js';
import { PlanAssignments } from '../../src/modules/entitlements/index.js';
import { SqlOrgEntitlementRepository } from '../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { startEntitlementsApp } from '../support/entitlements-app.js';
import { FixtureFeaturesModule, fixturePlans, seedFixtureCatalogue } from '../support/entitlements-fixtures.js';
import { readOrgEntitlement, seedOrgEntitlement } from '../support/entitlements-seed.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { authed } from '../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

/** Cận trên của một request trong blackhole: chờ connection + query quá hạn + ROLLBACK quá hạn (mặc định của app) + dư. */
const OUTAGE_BOUND_MS = 20_000;
const RECOVERY = { timeout: 30_000, interval: 250 };

/**
 * Tiêu chí 11 / F-1 (spec SP4): chỉ pool `app` đi qua proxy; blackhole bật đúng lúc câu của entitlements sắp chạy (bọc phương
 * thức repository thật), nên lỗi rơi vào câu snapshot / câu khoá của `assign`, không vào tra membership của middleware.
 */
describe('the database lost under entitlement reads and assignments answers 503, never 500', () => {
  let proxy: TcpProxy;
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  /** Bật blackhole ngay trước câu snapshot thật (một lần). */
  const armSnapshot = () => {
    const original = SqlOrgEntitlementRepository.prototype.readSnapshot;
    vi.spyOn(SqlOrgEntitlementRepository.prototype, 'readSnapshot').mockImplementationOnce(function (this: SqlOrgEntitlementRepository) {
      proxy.state.blackhole = true;
      return original.call(this);
    });
  };
  /** Bật blackhole ngay trước câu khoá thật của `assign` (một lần). */
  const armAssignLock = () => {
    const original = SqlOrgEntitlementRepository.prototype.lockForAssignment;
    vi.spyOn(SqlOrgEntitlementRepository.prototype, 'lockForAssignment').mockImplementationOnce(function (this: SqlOrgEntitlementRepository, key: string) {
      proxy.state.blackhole = true;
      return original.call(this, key);
    });
  };
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule],
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port), THROTTLE_DEFAULT_LIMIT: '100000' },
    });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedOrgEntitlement(org.orgId, 'free');
  });
  afterAll(async () => {
    proxy.state.blackhole = false;
    vi.restoreAllMocks();
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await deleteSeededPrincipals([owner]);
    await disposeCatalogue?.();
    vi.unstubAllEnvs();
  });

  it('GET …/entitlements: DB lost at the snapshot query → 503 service_unavailable within the bound; recovers to 200', async () => {
    armSnapshot();
    try {
      const started = performance.now();
      const r = await authed(app, owner).get(`/v1/orgs/${org.orgId}/entitlements`);
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      proxy.state.blackhole = false;
    }
    await vi.waitFor(async () => expect((await authed(app, owner).get(`/v1/orgs/${org.orgId}/entitlements`)).status).toBe(200), RECOVERY);
  });
  it('assign: DB lost at the locking read → an infra error mapped to 503; nothing written, no event', async () => {
    armAssignLock();
    let err: unknown;
    try {
      err = await app
        .get(OrgScope)
        .run(org.orgId, () => app.get(UnitOfWork).run(() => app.get(PlanAssignments).assign({ planKey: 'pro', cause: { kind: 'BILLING', ref: 'sub_1', sequence: 1n } })))
        .catch((e: unknown) => e);
    } finally {
      proxy.state.blackhole = false;
    }
    expect(isDbInfraError(err)).toBe(true);
    expect(toAppError(err).error.status).toBe(503);
    await vi.waitFor(async () => expect(await readOrgEntitlement(org.orgId)).toMatchObject({ planKey: 'free', version: 1, lastBillingSeq: null }), RECOVERY);
    expect(await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed'`, [org.orgId])).toEqual([]);
  });
});
```
Run: `pnpm vitest run --project chaos test/chaos/entitlements-outages.spec.ts`
Expected: PASS (nếu một đường ra `500`: lỗi không được `dbErrorMapper` nhận là hạ tầng — dừng, tìm nguyên nhân gốc bằng skill `superpowers:systematic-debugging`, không nới kỳ vọng).

- [ ] **Step 2: Tách thiết bị smoke dùng chung**

Tạo `test/smoke/smoke-devices.ts` bằng cách **chuyển nguyên văn** từ `test/smoke/tenancy.smoke.spec.ts` (bản đã merge của 3A): hằng `PASSWORD`, `VERIFY_LINK`, `MIN_SECRET_LENGTH`, lớp `Device`, hàm `verifiedDevice` (cùng chữ ký đang có trên `main`), thêm `export` cho `PASSWORD`, `Device`, `verifiedDevice`, cùng các import chúng cần (`randomInt`, `randomUUID`, `expect`, `Mailpit`, `SMOKE_BASE_URL`, `CookieJar`). `tenancy.smoke.spec.ts` xoá phần đã chuyển và import từ `./smoke-devices.js`. Không đổi hành vi: `pnpm test:smoke` ở Step 4 chạy lại cả file tenancy.

- [ ] **Step 3: Luồng HTTP 4A trên image production**

`test/smoke/entitlements.smoke.spec.ts` — thêm import và ca (trước ca log sạch; dùng `verifiedDevice` đúng chữ ký của Step 2, ví dụ dưới là chữ ký ba tham số hiện có trên nhánh 3A):
```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Mailpit } from '../support/mailpit.js';
import { PASSWORD, verifiedDevice } from './smoke-devices.js';
```
```ts
  const { mailpitApiUrl } = inject('smoke');
  const mail = new Mailpit(mailpitApiUrl);
  /** Không dòng log nào của api/worker được chứa các giá trị này. */
  const forbidden: string[] = [PASSWORD];

  it('entitlements on the production image: sign up → verify → create org → default plan in GET …/entitlements → one plan.changed → soft delete → 404', async () => {
    const { device } = await verifiedDevice(apiUrl, mail, forbidden);
    const created = await device.call('POST', '/v1/orgs', { body: { name: 'Smoke 4A' }, headers: { 'idempotency-key': `smoke-${randomUUID()}` } });
    expect(created.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(await created.json());
    const ent = await device.call('GET', `/v1/orgs/${id}/entitlements`);
    expect(ent.status).toBe(200);
    expect(await ent.json()).toEqual({
      plan: { key: 'free', source: 'DEFAULT', assignedAt: expect.any(String) },
      features: [{ key: 'tenancy.seats', kind: 'LIMIT', unlimited: true, limit: null, source: 'FALLBACK', overrideExpiresAt: null }],
    });
    // Dòng tạo trong transaction tạo org (participant), đúng một event (subscriber dự phòng không thêm).
    expect(psql(`SELECT plan_source || ':' || version FROM org_entitlements WHERE org_id = '${id}'`)).toBe('DEFAULT:1');
    expect(psql(`SELECT count(*) FROM outbox_events WHERE org_id = '${id}' AND type = 'entitlements.plan.changed'`)).toBe('1');
    expect((await device.call('DELETE', `/v1/orgs/${id}`)).status).toBe(204);
    expect((await device.call('GET', `/v1/orgs/${id}/entitlements`)).status).toBe(404);
  });
```
và ca log sạch đổi `assertCleanLogs(logs, [])` thành `assertCleanLogs(logs, forbidden)`, thêm khẳng định thời gian inventory lúc boot:
```ts
    const inventory = logs
      .split('\n')
      .filter((l) => l.includes('"entitlements_route_inventory"'))
      .map((l) => z.object({ durationMs: z.number() }).parse(JSON.parse(l)));
    expect(inventory.length).toBeGreaterThan(0);
    for (const i of inventory) expect(i.durationMs).toBeLessThan(50);
```
(`id` do API trả đã qua `z.uuid()`; nối vào SQL của superuser smoke là an toàn. Route có `requireEnabled` không tồn tại trên image production vì boilerplate chưa có FLAG nào: `403 feature_not_in_plan` được chứng minh ở e2e HT-1 (Task 10) — spec §20.4 SM-1 phần "route fixture" không chạy được trên image, ghi ở mô tả PR.)

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app`, `NODE_ENV=production`, migrate từ `dist`, mọi file smoke PASS (`core`, `auth-email`, `dashboard`, `tenancy`, `entitlements`); log api/worker JSON, không `error`, không chứa mật khẩu/email/token; `/health/ready` 200; teardown `down -v` sạch.

- [ ] **Step 4: Đo image, ghi ADR 0013**

Run (cùng phương pháp dòng SP2/SP3 của ADR 0013):
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
git diff origin/main -- package.json pnpm-lock.yaml | head -1
```
Expected: không diff `package.json`/`pnpm-lock.yaml` (không package mới); image chưa nén chênh so với dòng SP3 (3A) chỉ bằng phần `dist` của entitlements (vài chục KB); ≤ 400 MB.
`docs/adr/0013-build-toolchain.md` — thêm mục ngay sau mục số đo SP3 (3A):
```markdown
### Số đo SP4 (4A) (<ngày đo>)

Đo sau `pnpm test:smoke` xanh của Task 13 (plan 4A), cùng máy và phương pháp với dòng SP3 (3A). 4A không thêm package (spec SP4 tiêu chí 12): `package.json` và `pnpm-lock.yaml` không đổi so với `main`.

| Chỉ số | SP3 (3A) | SP4 (4A) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | <số của dòng 3A> MB | <số đo> MB | <+x> MB |
| Image nén | <số của dòng 3A> MB | <số đo> MB | <+x> MB |
| Inventory route entitlements lúc boot (`entitlements_route_inventory.durationMs`, smoke) | — | <số đo> ms | mốc < 50 ms (spec §20.4) |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT | <ĐẠT/KHÔNG ĐẠT>, dư <n> MB | |
```
Thay mọi `<…>` bằng số đo thật (dữ liệu của lần chạy; dòng chỉ commit khi có số).

- [ ] **Step 5: Commit**

```bash
git add test/chaos/entitlements-outages.spec.ts test/smoke docs/adr/0013-build-toolchain.md
git commit -m "test(entitlements): DB outage on snapshot and assign answers 503; entitlements flow on the production image; record the SP4 (4A) image size"
```

---

### Task 14: Tài liệu — ADR 0018 hoàn chỉnh, cập nhật ADR 0005/0015/0017, sửa spec cha (P1–P10) và spec SP3 (T3, T4), README entitlements + nâng cấp lên SP4 + runbook

**Files:**
- Modify: `docs/adr/0018-entitlements-in-code.md`, `docs/adr/0005-multi-tenant-rls.md`, `docs/adr/0015-cache-deferred.md`, `docs/adr/0017-tenancy-own-module.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, `docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md` (§8.3, §19, nhật ký), `README.md`

**Interfaces:**
- Consumes: spec SP4 §4.1 (S4-D1…S4-D22), §8.5 (cache), §22.1 (P1–P10), §22.2 (T3, T4, A1, L1); tên thật của code Task 1–13.
- Produces: tài liệu khớp với cái 4A ship; tính năng của 4B/4C trong spec cha mang nhãn `(4B)`/`(4C)`.

- [ ] **Step 1: ADR 0018**

`docs/adr/0018-entitlements-in-code.md` — đổi trạng thái thành `Chấp nhận (<ngày>, controller chốt theo uỷ quyền "tự chốt, tự làm hết")`, giữ mục "Kết quả spike (plan 4A)" của Task 1, thêm các mục (nội dung lấy từ spec, câu chữ ngắn gọn):
- `## Bối cảnh`: spec cha §2/§8/Phụ lục C mục 4; SP3 đã có catalogue quyền trong code + bảng tra cứu kiểm lúc boot (mẫu được dùng lại).
- `## Quyết định`: bảng một dòng mỗi quyết định S4-D1…S4-D22 (mã, quyết định một câu, lý do một câu), nêu rõ: tính năng và gói khai báo trong code, DB chỉ bảng tra cứu cho FK (`entitlement_features`, `plans`), kiểm bằng nhau lúc boot (`EntitlementCatalogueCheck`); `requireEnabled` là interceptor route-scoped (sau mọi guard, trong OrgScope, spike S4-T1); `PlanAssignments.assign` là hợp đồng duy nhất với SP5 (R-X1), kết quả có tên, lỗi có tên trước câu ghi đầu tiên; mọi org có đúng một dòng từ transaction tạo org (participant T1) + subscriber dự phòng; không cache ở v1.
- `## Cache (khi đo được là cần)`: chép mục 8.5 của spec (điều kiện bật: p95 `entitlements_snapshot_read_duration_seconds` hoặc số câu snapshot/giây ở k6 600 RPS vượt ngân sách API đọc p95 < 200 ms; thiết kế Redis riêng `REDIS_CACHE_URL` là secret, khoá có version, bia mộ sau commit, ghi lại bằng Lua so version; không bao giờ cache bộ đếm quota, câu khoá của `assign`, API admin; lý do loại `cache-manager` + `@keyv/redis`).
- `## Hợp đồng với tenancy (sổ export L1)`: 4A thêm vào `modules/tenancy/index.ts`: `OrgCreationParticipant`, `OrgCreationParticipantContributor`, `OrgCreationParticipantRegistry`, `classifyTenantHandler`, `type OrgRouteKind`; 4A dùng: `OrgPurgeParticipant`, `OrgPurgeParticipantContributor`, `PermissionCatalogueContributor`, `definePermissionCatalogue`, `OrgCreatedEvent`; 4C sẽ dùng `@PlatformStaffAction()` (3D). Registry `order` purge: entitlements = 100 (addendum 3D §A4).
- `## Phương án đã loại`: gói trong DB sửa qua admin API; giá trị gói nhân bản vào DB; guard route-scoped + luật thứ tự decorator; cache L1 trong process; stack `cache-manager`; subscriber gán gói của billing; gán gói hẹn ngày (R-X1).
- `## Hệ quả`: dự án đổi giá trị gói bằng sửa code (không migration); thêm gói ở bản N, bán ở bản N+1 (F-6); đổi `ENTITLEMENTS_QUOTA_TIMEZONE` giữa kỳ làm kỳ chạy lại từ 0 (4B); 4B/4C mở rộng bảng và câu snapshot.
- `## Nguồn`: spec SP4 r2 (kèm sửa sau chốt), phán quyết R-X1…R-X24, spec SP3 r8, addendum 3D.

- [ ] **Step 2: ADR 0005, 0015, 0017**

- `docs/adr/0005-multi-tenant-rls.md`, thêm mục `## Cập nhật SP4 (4A) (<ngày>)`: bảng tenant `org_entitlements` (neo trực tiếp `organizations`, RLS FORCE, policy `org_entitlements_tenant TO app_user`), hai bảng global tra cứu `entitlement_features`, `plans` trong `GLOBAL_TABLES` của `rls-catalog.spec.ts` (hằng `ENTITLEMENTS_*_TABLES` ở `test/support/entitlements-catalog.ts`); bốn trigger INVOKER (không hoãn, chỉ đọc `NEW`/`OLD` hoặc bảng global) nên tập `SECURITY DEFINER` không đổi; migration mẫu `starter_plans` dùng mẫu `NO FORCE … FORCE` 7 bước của SP3 §8.8.
- `docs/adr/0015-cache-deferred.md`, mục `## Hệ quả` thêm đoạn: `SP4 (plan 4A) không cache entitlement ở v1: mỗi lần đọc là một câu theo PK; điều kiện bật và thiết kế có version ở ADR 0018. Stack cache-manager ở trên không dùng cho entitlement vì không so version khi ghi lại.`
- `docs/adr/0017-tenancy-own-module.md`: dòng `- chuỗi \`Auth → Org → Ability → Entitlement\`, …` thêm sau `Entitlement` chú thích `(SP4: \`EntitlementInterceptor\` route-scoped, chạy sau mọi guard và trong \`OrgScope\` của \`OrgScopeInterceptor\`; ADR 0018)`; mục `## Hệ quả` thêm một câu về participant tạo org (T1) và `classifyTenantHandler` (T2) do SP4 thêm vào public API của tenancy.

- [ ] **Step 3: Spec cha (P1–P10) và spec SP3 (T3, T4)**

`docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md` (3A Task 30 có thể đã đổi câu chữ quanh các chỗ này; tìm theo neo, sửa đúng nội dung):
- P1 (§2, bảng context, dòng `| Entitlements |`): cột aggregate thành `Plan (khai báo trong code của dự án), OrgEntitlement (gói + override (4C)), UsageCounter (4B)`; cột event thành `` `entitlements.plan.changed`, `entitlements.quota.reached` (4B; thay `entitlements.quota.exceeded`: chỉ phát khi tiêu thụ thành công chạm trần, SP4 S4-D16) ``.
- P2 (§3, dòng "Phân quyền"): phần `→ Entitlement` thành `→ \`OrgScopeInterceptor\` → \`EntitlementInterceptor\` (route-scoped, sau mọi guard, trong OrgScope; SP4 S4-D7)`.
- P3 (§5, bảng race) thêm hai dòng: `| Lệnh đổi gói của billing đảo thứ tự | billing gọi PlanAssignments.assign đồng bộ dưới khoá billing_accounts; sequence tăng dưới cùng khoá; khoá dòng org_entitlements + so sequence + trigger đơn điệu là lớp chặn cuối |` và `| Deadlock xuyên module | thứ tự khoá toàn hệ thống: organizations → khoá của module gọi (billing_accounts, …) → org_entitlements → usage_counters; entitlements không khoá bảng module khác sau khoá của mình |` (dòng ghế và dòng quota là của 4B).
- P4 (§8, "Ứng viên đầu tiên…" và "Stack đã chọn") thêm: `SP4 không cache entitlement (đọc một câu PK); khi đo được là cần: Redis riêng, khoá có version, ghi lại bằng Lua so version và bia mộ sau commit (ADR 0018). Stack cache-manager không dùng cho entitlement vì không so version khi ghi lại.`
- P5 (§13.1): "Flag nghiệp vụ nằm ở Entitlements" thêm `: tính năng FLAG theo gói của org (SP4); không có rollout theo phần trăm hay flag theo user`.
- P6 (§1.1, hoặc bảng vùng nếu SP7 A1 đã áp): thêm `src/app.plans.ts` (catalogue gói, bản chép từ `src/plans.example.ts` của vùng template lúc `upstream:init`) vào vùng dự án; `src/plans.example.ts` và `src/migrations/example/` vào vùng template.
- P7 (§15.1 cây thư mục): `migrations/ … entitlements/ · example/ (template) · app/ (dự án)`; `plans.example.ts (template: catalogue gói mẫu)`; `app.plans.ts (dự án: catalogue gói)`.
- P8 (§15 danh sách ADR): thêm `0018 Entitlements: catalogue và gói trong code, bộ đếm theo kỳ, không cache ở v1`.
- P9 (Phụ lục C mục 4): thay bằng câu của spec SP4 §22.1 P9 (nguyên văn).
- P10 (§3.2 bảng status, dòng `403`/`422`): ghi chú `feature_not_in_plan`/`quota_exceeded` mang key tính năng ở `errors[0]` (`path: "feature"`).

`docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`:
- T3: sơ đồ §5.1 (`PG --> EG["[SP4] EntitlementGuard"]`) thành `PG --> EG["[SP4] EntitlementInterceptor (route-scoped, sau mọi guard, trong OrgScope)"]`; §7.1 bước 6 (`6. **[SP4] \`EntitlementGuard\`**: điểm cắm, SP3 không làm.`) thành `6. **[SP4] \`EntitlementInterceptor\`** (route-scoped, gắn bởi \`requireEnabled\`, chạy sau mọi guard và bên trong \`OrgScopeInterceptor\`; SP4 S4-D7).`
- T4: §9.4 (R4A-N4, đoạn "Job tenant đã nằm trong queue") `huỷ subscription của SP4` thành `huỷ subscription của SP5`.
- Thêm một dòng vào nhật ký sửa cuối spec SP3: `SP4 plan 4A: T1 (participant tạo org, chữ ký onOrgCreated(orgId, actor)), T2 (classifyTenantHandler), T3, T4 áp theo spec SP4 §22.2.`

`docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md` (lệch có chủ đích của plan 4A; §10.2 bước 2 đã sửa lúc sửa plan theo review, không đụng lại):
- §8.3: tiêu đề `(… api và worker, onApplicationBootstrap)` thành `(… api và worker, onModuleInit)` và thêm một câu: `onModuleInit, không phải onApplicationBootstrap: WorkerHost và OutboxRelay bắt đầu consume ở onApplicationBootstrap, nên worker lệch catalogue phải bị từ chối trước khi nhận job nào (cùng lý do CatalogueCheck của SP3, commit 0bcabd9).` `EntitlementRouteInventory` giữ `onApplicationBootstrap` (chỉ api, HTTP chưa listen lúc đó).
- §19, tập `result` của `entitlements_plan_assignments_total`: thêm `precondition_failed` (412 của `PLATFORM_ADMIN`, E-7).
- Thêm một dòng vào cuối mục 26: `Sửa theo plan 4A: §8.3 kiểm catalogue ở onModuleInit (worker lệch không consume job); §19 thêm result precondition_failed.`

- [ ] **Step 4: README**

`README.md`, mục `## Cách thêm` thêm tiểu mục `### Tính năng theo gói (entitlements)`:
- khai báo catalogue: `export const ReportFeatures = defineFeatureCatalogue({ 'reports.export': { kind: 'FLAG', fallback: false } })` + provider `@FeatureCatalogueContributor(ReportFeatures)` ở **cả** `forApi()` lẫn `forWorker()`; migration chèn dòng `entitlement_features (key, kind, reset_period)` (catalogue check từ chối boot nếu thiếu); mỗi key đúng một `kind` (cổng + trần là hai key);
- route: `@Permissions.require(...)` **và** `@ReportFeatures.requireEnabled('reports.export')` (thứ tự decorator không quan trọng; entitlement luôn sau CASL); chỉ route tenant `v1/orgs/:orgId/...`;
- service: `Entitlements.isEnabled/assertEnabled/limitOf/assertWithinLimit` (trong org context); `assertWithinLimit` đòi caller **đếm dưới khoá tuần tự hoá** mọi đường thêm (check-then-insert không khoá là sai); tài nguyên không có khoá sẵn dùng `QUOTA` kỳ `NONE` (4B);
- gói: sửa `src/app.plans.ts`; đổi giá trị không cần migration; thêm gói = code + migration `app/` chèn dòng `plans`, **bán ở bản N+1** (pod cũ trả 503 cho org ở gói lạ); retire = lưu trữ giá SP5 trước, rồi `retired: true` + migration đặt `retired_at`;
- SP5: `PlanAssignments.assign({ planKey, cause: { kind: 'BILLING', ref, sequence } })` đồng bộ trong transaction billing, sau khoá `billing_accounts`; `switch` vét cạn bốn kết quả; bắt bằng `instanceof` đúng `UnknownPlanError`, `EntitlementsRowMissingError`; `defaultPlanKey()` khi hết hạn.
Mục mới `### Nâng cấp lên SP4`:
- clone đã `upstream:init` trước SP4: chép `git show <tag>:src/plans.example.ts > src/app.plans.ts` (giữ tên export `examplePlans` theo R-X20, sửa gói thật), tạo migration `pnpm exec mikro-orm migration:create --blank --path src/migrations/app --name starter_plans` và dán thân của `src/migrations/example/…_starter_plans.ts` từ tag, sửa key gói/gói mặc định; deploy trong cửa sổ ít tải (migration mẫu khoá `organizations` `ACCESS EXCLUSIVE` ngắn);
- quyền mới `entitlements.read` cấp cho ADMIN và MEMBER: `A = perms(ADMIN)` lớn lên, nên role tuỳ biến từng ⊇ `A` cũ thôi "tương đương admin" (admin quản lý được người giữ nó); owner thêm `entitlements.read` vào các role đó nếu muốn giữ mức bảo vệ (S4-D17, X-12);
- `ENTITLEMENTS_QUOTA_TIMEZONE` (mặc định `Asia/Ho_Chi_Minh`) quyết ranh giới tháng của quota (4B); đổi giữa kỳ làm kỳ chạy lại từ 0 — đổi vào đầu tháng.
Mục `### CLI và runbook` thêm:
- alert `entitlements_row_missing_total` tăng kéo dài 5 phút: kiểm job `core.event.deliver` của consumer `entitlements.provision-org`; thiếu dòng tự lành khi subscriber chạy; `503` + `Retry-After` trong lúc chờ;
- boot fail `Entitlement catalogues do not match the database`: thiếu migration (chạy migrate Job trước rollout) hoặc pod lệch version;
- rollback migration mẫu bị từ chối "assigned by billing or platform staff": không rollback khi đã có gán thật (mất dữ liệu); đưa về `DEFAULT` có chủ đích trước nếu thật sự cần;
- down của `…_entitlements_core` bị `23001`: role tuỳ biến/khoá/grant còn giữ `entitlements.read`, thu hồi trước.

- [ ] **Step 5: Kiểm, commit**

Run:
```bash
pnpm lint
git diff --stat
```
Expected: `prettier --check .` xanh (`docs/` nằm trong `.prettierignore`; README được kiểm); chỉ các file tài liệu trên thay đổi.
```bash
git add docs/adr docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md README.md
git commit -m "docs(entitlements): ADR 0018, ADR 0005/0015/0017 updates, parent and SP3 spec amendments for 4A, README and runbooks"
```

---

### Task 15: Kiểm chứng toàn nhánh, push, một PR cho 4A, CI xanh hoàn toàn

**Files:**
- Không file mới. Sửa bất kỳ file nào cần để pipeline xanh (mỗi sửa là commit riêng có lý do).

**Interfaces:**
- Consumes: mọi task 1–14.
- Produces: nhánh `sp4a-entitlements` trên `origin`, một PR `sp4a-entitlements → main` với mọi check CI xanh.

- [ ] **Step 1: Pipeline đầy đủ trên máy (cùng thứ tự như CI)**

Run:
```bash
git fetch origin main
pnpm install --frozen-lockfile
git diff --exit-code origin/main -- package.json pnpm-lock.yaml
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
Expected: mọi lệnh exit 0. Đọc output thật:
- `git diff --exit-code … package.json pnpm-lock.yaml`: không diff (tiêu chí 12: không package mới).
- `pnpm test:int` gồm `migrations.spec.ts` (up → down → up và sweep từng bước trên database riêng, gồm `…_entitlements_core` và `…_starter_plans`), `rls-catalog.spec.ts`, `normalization-inventory.spec.ts`, mọi integration/e2e entitlements và tenancy, `snapshot-explain.spec.ts` (copy khối plan vào mô tả PR), race ×50 (PA-9, PA-15).
- `pnpm test:smoke`: image production thật, `compose --profile app`, `NODE_ENV=production`, log JSON sạch, `/health/ready` 200, teardown sạch.
- `pnpm arch`: luật 20.8-a, 20.8-c bắt fixture; cây `src` thật sạch; không còn ngoại lệ `no-orphans` nào của entitlements.
Lệnh nào đỏ: tìm nguyên nhân gốc (skill `superpowers:systematic-debugging`), sửa, commit, chạy lại **toàn bộ** Step 1.

- [ ] **Step 2: Kiểm tay trước khi push**

Run:
```bash
git log --oneline origin/main..HEAD
git status --short
git diff --stat origin/main...HEAD
```
Expected: `git status` sạch; commit theo task, message conventional tiếng Anh; không có `test/integration/spike-sp4a/`, không file tạm, không secret. Timestamp migration của 4A (`entitlements/` và `example/`) lớn hơn migration mới nhất trên `origin/main` (`migration-order.spec.ts` đã chạy trong `pnpm test`); `main` đổi trong lúc làm (3B/6.0/7A cùng sóng W2 merge trước) thì rebase, tạo lại file migration qua CLI để có timestamp mới, chọn lại nhánh A/B ở Task 6 Step 2 và Task 7 Step 3 theo `main` mới, chạy lại Step 1.

- [ ] **Step 3: Push và mở PR (HARD STOP: cần Sếp duyệt rõ ràng)**

`git push` và `gh pr create` là thao tác ra ngoài, khó đảo ngược: theo luật của Sếp chúng là hard stop kể cả ở chế độ tự động. **Dừng ở đây**, báo Sếp kết quả Step 1–2 (lệnh + kết quả thật, `git log --oneline origin/main..HEAD`, nội dung PR dự kiến bên dưới) và chờ Sếp duyệt push + mở PR. Chưa có lời duyệt đó thì không chạy hai lệnh dưới. Lời duyệt áp cho nhánh `sp4a-entitlements` và PR này, gồm cả các lần push sửa CI ở Step 4; mọi thao tác khác (force-push, merge, đổi nhánh đích) cần hỏi lại.

Sau khi Sếp duyệt, run:
```bash
git push -u origin sp4a-entitlements
gh pr create --base main --head sp4a-entitlements --title "SP4 plan 4A: entitlements foundation" --body-file "$TMPDIR/sp4a-pr.md"
```
Nội dung `$TMPDIR/sp4a-pr.md` (viết file trong scratchpad, không commit):
```markdown
## SP4 plan 4A — entitlements foundation

Spec: docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md (r2, §21 hàng 4A)
Plan: docs/superpowers/plans/2026-09-29-sp4a-entitlements-foundation.md
ADR: 0018 (mới, kết quả spike S4-T1, S4-T3), 0005, 0013 (dòng "SP4 (4A)"), 0015, 0017

### Nội dung
- tenancy: participant tạo org (`OrgCreationParticipant`, chạy trong transaction tạo org trước khi người tạo vào org), `classifyTenantHandler`
- entitlements: catalogue tính năng/gói trong code, bảng tra cứu + `org_entitlements` (RLS FORCE), kiểm catalogue lúc boot, `Entitlements` (FLAG, LIMIT), `requireEnabled` sau CASL trong OrgScope, route inventory, `GET /v1/orgs/{orgId}/entitlements`, `PlanAssignments.assign` cho SP5, participant tạo org + subscriber dự phòng + participant purge `order = 100`
- vùng template: `src/plans.example.ts`, `src/migrations/example/…_starter_plans` (backfill 7 bước + event)
- nhánh phụ thuộc cùng sóng: cờ event 6.0 <A/B>, composition 7A <A/B>, ca DB-4 với role tuỳ biến 3B <chạy/carry sang 4B>

### Kiểm chứng (lệnh và kết quả thật)
<output tóm tắt từng lệnh Step 1: số test pass theo project, thời gian>

### EXPLAIN (ANALYZE, BUFFERS) câu snapshot — 10 000 org
<khối plan do snapshot-explain.spec.ts in ra>

### Image (ADR 0013)
<chưa nén / nén / chênh so với SP3 (3A); không package mới>

### Rủi ro còn lại
- SM-1 phần route fixture `403 feature_not_in_plan` không chạy được trên image production (không có FLAG nào trong boilerplate); đã chứng minh ở e2e HT-1.
- PA-16 phần override và HT-2b/HT-2c chạy ở 4C/4B.
```
Thay các khối `<…>` bằng output thật và lựa chọn nhánh thật trước khi chạy `gh pr create` (dữ liệu của lần chạy, không phải chỗ trống của plan).

- [ ] **Step 4: Chờ CI, sửa tới khi xanh**

Run: `gh pr checks --watch`
Expected: mọi check xanh (lint/arch/typecheck/unit, integration, chaos, smoke, env drift, openapi + oasdiff chỉ thêm, migration order với `fetch-depth: 0`, build image). Check đỏ: `gh run view <id> --log-failed`, tìm nguyên nhân gốc, sửa, commit, push, chờ lại. Không `--no-verify`, không tắt check, không đánh dấu flaky để qua.

- [ ] **Step 5: Báo cáo**

Báo Sếp: link PR, danh sách check xanh (`gh pr checks`), số test theo project, số đo image, rủi ro còn lại, việc chuyển sang 4B/4C. Không merge (merge là quyết định của Sếp).

---
## Self-review

### 0. Sửa theo review (`plan-4a-review.md`, 2026-09-29)

- **C1** (catalogue quyền góp hai lần làm mọi app test từ Task 7 không boot): `tenancyCoreImports({ entitlementPermissions })` và `TenancyAppOpts.entitlementPermissions` (mặc định `true`); `entitlementsCoreImports` và `startEntitlementsApp` luôn truyền `false`; sửa chú thích `entitlement-permissions.module.ts` (registry 3A ném, không khử trùng). Test hồi quy: ca đầu `catalogue-check.spec.ts` (Task 8). Kiểm với `src/modules/tenancy/application/permission-catalogue.registry.ts:54-62`.
- **C2** (câu khoá `assign` JOIN `plans` → 0 dòng sau khi phiên trước đổi `plan_id` → `EntitlementsRowMissingError` giả trên đường tiền): `lockForAssignment` thành hai câu — khoá `FOR NO KEY UPDATE` chỉ `org_entitlements` (không JOIN), rồi tra `plans` theo `plan_id` vừa khoá và key đích; cả hai trước câu ghi đầu tiên (C-2 giữ). PA-9 ×50 và E-7 ×50 giữ làm bằng chứng; thêm ca tất định có barrier (`holdEntitlementRow().commitWith`): seq 6 → `STALE`, seq 8 → `APPLIED`, không bao giờ `EntitlementsRowMissingError`. Spec §10.2 bước 2 + hợp đồng C-2 ("hai câu SELECT") + một dòng nhật ký mục 26 đã sửa ngay.
- **I1** (check catalogue ở `onApplicationBootstrap`): `EntitlementCatalogueCheck.onModuleInit`; `EntitlementCatalogueRegistry` nạp lười (`load()` như `PermissionCatalogueRegistry` 3A) và ném khi một catalogue tính năng được góp hai lần; thêm unit "góp hai lần", "nạp ở lần dùng đầu" và integration "zero jobs consumed on entitlement catalogue drift" (chép mẫu 3A); Task 10 gọi `.onModuleInit()`; Task 14 sửa spec §8.3.
- **I2** (nhánh B của Task 7 dựa vào `plans`/guard mà 7A không có khi merge trước): nhánh B chép công thức chuẩn của plan 7A Task 3 Step 6 (mục 1–4): `import type { PlanCatalogue }`, trường `plans?`, `requirePlans`, loader có guard, guard trong `composeAppModules`, ca hằng + ca UP-12 thiếu `plans` trong `compose.spec.ts`, cộng danh sách module đã nạp của smoke 7A.
- **I3** (R-X21): header trích `.superpowers/autonomous/rulings.md` R-X1…R-X24; bullet "vấn đề thiết kế mới" ở §6 thay bằng "đã giải quyết bởi R-X21, ship trong 3A Task 20b; 4A không thêm gì"; bỏ rủi ro đó khỏi PR; Task 1 Step 0 kiểm Task 20b có trên `main`. Theo phán quyết sửa 2026-09-29, R-X21 thuộc 3A chứ không phải 7A, nên an toàn rolling deploy không còn phụ thuộc 7A merge trước 4A (caveat 2 của review hết hiệu lực).
- **M1**: ca "boot-time checks" của Task 10 không còn khẳng định < 50 ms (log `durationMs`); mốc chỉ khẳng định ở smoke Task 13.
- **M2**: thêm ca "HT-4 covers both interceptor orders" (`new Set([runsFirst('idemA'), runsFirst('idemB')]).size === 2`); Task 10 Step 3 thành 11/11.
- **M3**: `REVOKE ALL ON FUNCTION … FROM PUBLIC` cho bốn hàm trigger (Postgres kiểm EXECUTE của hàm trigger lúc `CREATE TRIGGER`, không lúc bắn); ca schema khẳng định INVOKER, chủ `app_owner`, PUBLIC và `app_user` không EXECUTE.
- **M4**: `entitlementsSpan` truyền `span` cho `fn`; `assertEnabled` đặt `entitlements.result = denied` trước khi ném; integration Task 7 khẳng định.
- **M5**: `AssignmentMetricResult` thêm `precondition_failed`, đếm trước khi ném 412; ca 412 đơn khẳng định metric +1; Task 14 sửa spec §19.
- **M6**: PA-15 khẳng định `plan_assignment_seq = 1` (transaction billing commit câu UPDATE của nó) sau mỗi vòng.
- **M7**: Task 15 Step 3 thành HARD STOP, chờ Sếp duyệt push + mở PR. Ghi chú: Task 31 của plan 3A hiện KHÔNG có cổng duyệt tường minh này (review nói "như 3A Task 31"); 4A đặt cổng theo luật của Sếp, không theo 3A.
- **Theo phán quyết (ngoài finding):** R-X24 — kỳ vọng số quyền trong test 3A mà 4A sửa (constraints, orgs e2e, smoke) tính từ catalogue, không viết cứng 19/20; R-X20 — chú thích `plans.example.ts` và README giữ tên export `examplePlans` (bỏ `appPlans`).
- **Không bác finding nào.**


### 1. Độ phủ spec (mục 21 hàng "4A", tiêu chí 1–16, mục 22 dòng 4A)

| Hạng mục 4A của spec | Task |
|---|---|
| Spike S4-T1, S4-T3 (kết quả vào ADR 0018) | 1 (giữ thành test ở 2 và 10) |
| Module khung, `index.ts` (public API §6.4), `EntitlementsModule.forApi(plans)`/`forWorker(plans)` | 6, 7, 9, 11, 12 |
| `defineFeatureCatalogue`, `definePlanCatalogue`, `UNLIMITED`, kiểm catalogue (EC-1…EC-8) | 3, 6 |
| Registry Discovery `@FeatureCatalogueContributor` (+ kiểm gói lúc boot, log `fallback`) | 6 |
| `EntitlementCatalogueCheck` (code ↔ DB, tiêu chí 7, EC-9) | 8 |
| `EntitlementRouteInventory` (EC-9 phần inventory) | 10 |
| Tính năng boilerplate `tenancy.seats` (khai báo + dòng DB; chưa nối tenancy) | 5, 6 |
| Migration `entitlements/…_entitlements_core` (§7.1–7.3, 4 trigger, `tenancy.seats`, `entitlements.read`) | 5, 7 |
| Vùng template: `src/plans.example.ts`, `src/migrations/example/…_starter_plans` (backfill 7 bước + event, down từ chối) | 7, 8 |
| `resolveEffective`, `overrideStatus`, `quotaState` (EV-1…EV-9) | 4 |
| Snapshot (không override), `Entitlements` (FLAG, LIMIT; `limitOf` cả QUOTA) | 6, 7 |
| `EntitlementInterceptor` + `requireEnabled` (HT-0, HT-1, HT-4) | 6, 10 |
| `PlanAssignments.assign` (BILLING theo R-X1 + hợp đồng ném lỗi; PLATFORM_ADMIN có trong kiểu và `decideAssignment`, chưa có route) + `plan.changed` | 4, 12 |
| Participant tạo org (amendment tenancy T1, T2) | 2, 11 |
| Subscriber dự phòng `tenancy.org.created` | 11 |
| Participant purge `order = 100` (tiêu chí 10, R-1) | 11 |
| `EntitlementPermissions` + `GET /v1/orgs/{orgId}/entitlements` (FLAG, LIMIT; QUOTA không usage) | 6, 7, 9 |
| Config `ENTITLEMENTS_QUOTA_TIMEZONE`, `ENTITLEMENTS_ROW_MISSING_RETRY_AFTER_SEC` | 6 |
| Lỗi (§15), tám lớp có tên export ở `index.ts` (R-X19, EC-10) | 6 |
| Metric, span, log (§19; phần 4A) | 6, 7, 12 |
| Luật kiến trúc 20.8-a/b/c | 6 |
| ADR 0018; ADR 0005, 0015, 0017 (A1) | 1, 14 |
| Sửa spec cha P1–P10 (phần 4A); spec SP3 T3, T4 | 14 |
| Nối composition (§6.2), nghĩa vụ R-X16 (`markModuleLoaded` nếu 7A đã merge, `MODULE_REQUIRES`, không secret) | 6 (index), 7 |
| DB-1 (catalog), DB-2 (cô lập), DB-3 (ràng buộc), DB-4 (migration: sweep + backfill + down) | 5, 7, 8 |
| PA-1…PA-8 (unit) / PA-9, PA-10, PA-13, PA-14, PA-15, PA-16 (integration) / PA-11, PA-12 | 4 / 12 / 11 |
| R-1, HT-2a, HT-3 | 11 / 9 / 9 + 11 |
| EV-10 (khi 6.0 đã merge) | 12 (nhánh B) |
| Chaos (DB mất ở snapshot, assign → 503), PII (reason) | 13, 12 |
| SM-1 phần 4A, số đo image ADR 0013, thời gian kiểm lúc boot | 8, 13 (+ e2e đo ở 10) |
| Tiêu chí 1 | 7 (503 + log + metric khi thiếu dòng), 8 (backfill), 11 (participant + subscriber) |
| Tiêu chí 2 | 10 |
| Tiêu chí 6 | 12 |
| Tiêu chí 7 | 3, 6, 8 |
| Tiêu chí 8 (bảng 4A) | 5 |
| Tiêu chí 10 (bảng 4A) | 5, 11 |
| Tiêu chí 11 (đường 4A) | 7, 9, 13 |
| Tiêu chí 12 | 13, 15 |
| Tiêu chí 13 | 15 |
| Tiêu chí 15 (event của 4A) | 6 (nhánh B) / 12 (EV-10) — hoặc 6.0 đóng nếu merge sau |
| Tiêu chí 16 | 6, 7 |

### 2. Race của 4A → cơ chế → test

| Race (spec §17) | Cơ chế | Test (task) |
|---|---|---|
| E-5 lệnh billing đảo thứ tự/chạy lại | chính: SP5 gọi dưới khoá `billing_accounts` (R-X1); lớp chặn cuối: `FOR NO KEY UPDATE` trên `org_entitlements` (câu khoá không JOIN, gói tra ở câu thứ hai: phiên chờ luôn thấy dòng mới, không bao giờ `EntitlementsRowMissingError` giả) + so `sequence` dưới khoá → `STALE`; trigger `org_entitlements_billing_seq_monotonic` | PA-1…PA-4 (4), PA-9 ×50 có barrier, ca C2 tất định (12), trigger (5) |
| E-7 hai nhân viên sửa cùng org | `If-Match` ở route (4C) + khoá dòng gốc + kiểm lại `expectedVersion` sau khoá → 412 trước câu ghi | E-7 ×50 có barrier, 412 đơn (12) |
| E-8 nhân viên gán tay đua lệnh billing | cùng khoá dòng gốc (câu khoá không JOIN, xem E-5); thứ tự commit; seq cũ → `STALE`; billing kỳ sau khẳng định lại (R-X18) | PA-10, PA-16, ca C2 tất định (12) |
| E-9 participant tạo org và subscriber cùng chèn | PK `org_id` + `ON CONFLICT DO NOTHING`; chỉ bên chèn thật phát event | E-9/PA-11 (11) |
| E-11 purge đua `assign` (phần 4A; phần consume ở 4B) | purge khoá org rồi xoá con trước cha; `assign` thấy 0 dòng → `EntitlementsRowMissingError` trước câu ghi | PA-15 ×50 (12) |
| E-13 rolling deploy, hai pod khác catalogue gói | chấp nhận có tên; pod cũ trả 503 (`EntitlementsVersionSkewError`) cho org ở gói lạ; `assign` không phụ thuộc giá trị gói hiện tại | F-6 (7, 9), Review Focus 2 (12) |
| E-16 purge đua `assign` đồng bộ trong transaction billing | billing không phải purge participant (R-X5): hai bên cùng chờ một khoá, không chu trình | PA-15 ×50 với bảng fixture giữ khoá account trước (12) |
| (T1) org mới không có dòng trong cửa sổ | participant chạy trong transaction tạo org, trước `MemberAdmission` | Task 2 e2e, PA-11 (11) |

E-1…E-4, E-6, E-10, E-14, E-15, E-17 thuộc 4B (quota, ghế, dung lượng); E-12 (override hết hạn) thuộc 4C — biên `overrideStatus` đã có unit ở Task 4.

### 3. Quét chỗ trống

`<ts>` trong tên migration là quy ước của plan (tên do CLI sinh; code và test tìm theo hậu tố). Các `<…>` còn lại là **dữ liệu của lần chạy**: kết quả spike (Task 1 Step 5), số đo image và ngày (Task 13 Step 4, Task 14), output kiểm chứng, plan EXPLAIN và lựa chọn nhánh trong mô tả PR (Task 15 Step 3). Hai chỗ "nhánh A/B" (cờ event của 6.0 ở Task 6 Step 2 và Task 8 Step 4; composition của 7A ở Task 7 Step 3) có code cho cả hai nhánh và lệnh `grep` để chọn. Ca DB-4 "down bị role tuỳ biến chặn" phụ thuộc 3B: có hướng dẫn cho cả hai trường hợp (viết ca khi 3B đã merge; không thì carry sang 4B, không commit `skip`). Không còn "TBD", "tương tự Task N", hay bước mô tả mà không có code.

### 4. Nhất quán tên và kiểu

- Miền (Task 3–4): `FeatureEntry`, `MergedFeatures`, `NumericValue`, `UNLIMITED`, `PlanCatalogue`/`PlanEntry`/`PlanValue`, `Limit`, `EffectiveValue`, `ValueSource`, `OverrideInput`, `AssignPlanCommand`/`AssignmentCause`/`CurrentAssignment`/`TargetPlan`/`AssignmentDecision` — dùng đúng chữ ký ở Task 6 (service, registry), 9 (schema), 12 (`PlanAssignments`).
- Ứng dụng: `EntitlementCatalogueRegistry.{features, feature, plans, has}`, `ENTITLEMENT_PLANS`, `FeatureCatalogueContributor`, `Entitlements.{snapshot, isEnabled, assertEnabled, limitOf, assertWithinLimit}`, `EntitlementCatalogueCheck`, `entitlementsCatalogueDiff`, `EntitlementRouteInventory.check`, `PlanAssignments.{assign, defaultPlanKey}`, `ProvisionOrgParticipant`, `ProvisionOrgSubscriber`, `EntitlementsPurgeParticipant`.
- Port: `OrgEntitlementRepository.{readSnapshot (6), insertDefault, insertDefaultIfAbsent (11), lockForAssignment, applyAssignment, recordBillingSequence (12)}`; `EntitlementCatalogueReader.{features, plans}` (8).
- HTTP: `FEATURE_REQUIREMENTS`/`FeatureRequirement` (`http/feature-metadata.ts`), `defineFeatureCatalogue`/`FeatureCatalogue`/`FlagKey`, `EntitlementInterceptor`, `OrgEntitlementsResponse`/`orgEntitlementsOf`, `OrgEntitlementsController`, `EntitlementsHttpModule`.
- Hằng: `ENTITLEMENT_VALUE_MAX`, `FEATURE_KEY_PATTERN`, `PLAN_KEY_PATTERN`, `REASON_MAX_LENGTH`, `SOURCE_REF_MAX_LENGTH`, `ENTITLEMENTS_PURGE_ORDER`, `PLAN_SOURCES` (`constants.ts`); `ENTITLEMENTS_PURGE_STATEMENTS` (`infra/sql/entitlements-purge.sql.ts`); `SNAPSHOT_SQL`.
- Test support: `seedFeatures`, `seedPlans`, `seedOrgEntitlement`, `setOrgPlan`, `deleteOrgEntitlement`, `readOrgEntitlement`, `withOwner`, `featureRowsOf` (5); `FixtureFeatures`, `FixtureFeaturesModule`, `fixturePlans`, `seedFixtureCatalogue` (7); `entitlementsCoreImports` (7), `startEntitlementsApp` (9, 11), `EntitlementsProvisionTestModule` (11); `EntitlementPermissionsCatalogueModule` (7); `holdEntitlementRow`, `waitForBlocked` (12); `ENTITLEMENTS_*_TABLES` (5).
- Tên của 3A dùng (từ khối "Produces" của plan 3A): `OrgService.create`, `OrgPurgeParticipant(Contributor|Registry)`, `PermissionCatalogueContributor`, `PermissionCatalogueRegistry`, `definePermissionCatalogue`, `TenancyPermissions`, `TENANCY_CATALOGUE`, `OrgCreatedEvent`, `routeTemplateOf`, `classifyOrgRoute`, `OrgRouteKind`, `PurgeOrgHandler`, `SqlRoleRepository`, `tenancyCoreImports`, `startTenancyApp`, `TenancyAppOpts`, `authed`, `seedOrg`, `seedMember`, `purgeOrgs`, `deleteTenancyUsersOf`, `seedUserPrincipal`, `ORG_PURGE_STATEMENTS`, `createScratchDb`.

### 5. Lệch có chủ đích so với spec

- **`OrgCreationParticipant.onOrgCreated(orgId, actor)`** thay vì `onOrgCreated(orgId)` (spec §22.2 T1): event của participant phải mang actor của thao tác tạo org (§10.4), chỉ `OrgService` biết actor đó. Thêm tham số; `OrgCreationParticipantRegistry` cũng export (cần cho test/đọc thứ tự).
- **`defineFeatureCatalogue` ở `http/decorators.ts`**, không ở `domain/feature-catalogue.ts` (sơ đồ §6.2): luật `domain-pure` (cùng lý do 3A đặt `definePermissionCatalogue` ở `http/`). Public API không đổi.
- **`assertEnabled(...keys)`** nhận nhiều key (một snapshot cho cả tập, interceptor dùng); tương thích `assertEnabled(key)` của §6.4.
- **`EntitlementCatalogueCheck` chạy ở `onModuleInit`**, không `onApplicationBootstrap` (spec §8.3): worker lệch catalogue bị từ chối trước khi `WorkerHost`/`OutboxRelay` consume (bài học 3A Task 19). Task 14 sửa spec §8.3.
- **`entitlements_plan_assignments_total` có thêm `result = precondition_failed`** (spec §19 chưa có): 412 của nhân viên cũng được đếm. Task 14 sửa spec §19.
- **§10.2 bước 2 của spec đã sửa ngay lúc sửa plan** (không đợi Task 14): câu khoá không JOIN `plans`, gói tra ở câu thứ hai (C2).
- **Lệnh `assign` sai hình dạng** (seq < 1, ref rỗng/quá dài, reason có khoảng trắng đầu/cuối hoặc quá 500 code point) → `AppError(VALIDATION_FAILED)` **trước mọi SQL**: danh sách lỗi của §6.4 không nêu, nhưng không có cách fail-loud nào khác mà vẫn giữ "trước câu ghi đầu tiên"; route admin của 4C dùng đúng mã này (422).
- **Actor của lệnh BILLING không có principal** (job billing ở worker) là `{ type: 'system', id: 'billing' }`: spec §13.1 nói "actor trong `RequestContext` của transaction billing", mà job không có principal; SP5 đặt principal khi có (checkout).
- **Subscriber dự phòng không bắt `23503`** (spec §10.4): lỗi trong transaction của UoW + Inbox làm transaction hỏng, không commit được sau khi bắt. Câu chèn join `organizations` nên org đã mất cho 0 dòng (log INFO, xong); org bị purge ĐANG đua với câu chèn thì FK lỗi, job retry, lần sau thấy org đã mất. Kết quả quan sát được giống spec (xử lý xong, log INFO), không vòng retry vô hạn.
- **Câu snapshot đọc thêm `plan_assigned_at` và `now()`**: `plan.assignedAt` của response (§12.1) và mốc hết hạn override (4C) lấy từ DB.
- **EXPLAIN chỉ khẳng định `org_entitlements`**: bảng `plans` vài dòng thì quét tuần tự rẻ hơn index; spec nêu "PK plans" là index có sẵn, không phải đòi planner dùng nó.
- **Khoá của dòng `permissions` trong migration**: spec §7.7 ghi `SHARE ROW EXCLUSIVE` trên `permissions`; chèn dòng chỉ lấy `ROW EXCLUSIVE` (chú thích migration ghi đúng khoá thật). `SHARE ROW EXCLUSIVE` là trên `organizations` (tạo FK).
- **Bản đồ `key → id` của tính năng lúc boot** (§9.2) chưa làm ở 4A: người dùng duy nhất là `Quotas.consume` (4B). 4B thêm vào `EntitlementCatalogueCheck`.
- **SM-1 "route fixture `requireEnabled` → 403" trên image production** không chạy được (boilerplate không có FLAG nào, image không chứa route fixture); chứng minh ở e2e HT-1 (Task 10), ghi ở mô tả PR.

### 6. Hạng mục 4A chưa đặt được (và nơi xử lý)

- DB-4 "down của `…_entitlements_core` fail to khi còn role tuỳ biến giữ `entitlements.read`": cần bảng của 3B (cùng sóng W2). Viết ở Task 8 nếu 3B đã merge lúc thực thi; không thì carry sang 4B (4B phụ thuộc 3C ⊇ 3B).
- EV-10 và cờ `audit: true`, `webhook: false` của `PlanChangedEvent`: ở 4A nếu 6.0 merge trước (nhánh B), không thì 6.0 thêm (spec §13.1, X6-2).
- `markModuleLoaded('entitlements')`, mục `BOILERPLATE_MODULES`/`MODULE_REQUIRES`: ở 4A nếu 7A merge trước (nhánh B), không thì 7A thêm (SP7 amendment D1).
- PA-16 phần "override đặt giữa chuỗi còn nguyên": 4C (bảng override). HT-2b: 4C. HT-2c: 4B.
- **Dòng `entitlements.read` khi không có catalogue nào khai nó (module tắt qua SP7 `disable`, hoặc pod trước 4A khởi động lại sau migration 4A trong rolling deploy): đã giải quyết bởi R-X21, ship trong 3A (Task 20b).** Key chỉ có ở DB là WARN một lần lúc boot + metric `tenancy_catalogue_orphan_keys`, không chặn boot; key đó trơ (không route nào đòi, API không cấp được, grant cũ không cho gì; phía role tuỳ biến theo R-X23 của 3B). Vì 4A chỉ chạy trên `main` đã có 3A trọn vẹn (gồm Task 20b), an toàn của rolling deploy không phụ thuộc thứ tự merge 7A/4A. 4A không thêm gì cho R-X21; FATAL còn lại (key trong code thiếu ở DB, lệch cờ hoặc `requires`) không thể xảy ra với 4A: code và migration cùng khai `entitlements.read` → `org.read`, cùng cờ.

### 7. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **S4-T3, S4-T1** (spike Task 1): participant chạy được trong transaction tạo org dưới FORCE RLS + trigger hoãn bootstrap; interceptor route-scoped chạy trong `OrgScope` của interceptor global. S4-T3 không đạt → dừng, báo Sếp.
2. **Code 3A đã merge khớp khối "Produces" của plan 3A**: thứ tự trong `OrgService.create`, tên harness (`startTenancyApp`, `TenancyAppOpts`, `tenancyCoreImports`, `purgeOrgs`, `deleteTenancyUsersOf`), vòng `ORG_PURGE_STATEMENTS` trong `tenancy-seed.ts`, chữ ký `verifiedDevice` của smoke, `GET /v1/permissions` e2e (đếm cứng 19 hay đã tính từ catalogue theo R-X24), Task 20b (R-X21). Task 1 Step 0 `grep` trước; tên lệch → dùng tên thật.
3. **Idempotency của SP1 lưu response lỗi** (cha §3.4, spec §12.3): nhánh "idempotency bọc ngoài" của HT-4 đòi lần gửi lại trả lại `403` đã lưu. Nếu SP1 không lưu 4xx, test đỏ ở nhánh đó: dừng, đối chiếu ADR 0007/code `idempotency.interceptor.ts`, cập nhật kỳ vọng theo hành vi thật và ghi lệch vào spec (không sửa core trong 4A).
4. **`@Global()` + `register(plans)` động** làm `Entitlements`, `EntitlementsMetrics` thấy được từ module của controller `features/` khi Nest dựng `EntitlementInterceptor` (cùng cơ chế `TenancyCoreModule`, nhưng ở dạng dynamic): e2e Task 10 (controller fixture ở module riêng) chứng minh.
5. **`pg_blocking_pids` thấy phiên `app_user` đi qua PgBouncer** (barrier `waitForBlocked`, Task 12): cùng role nên được phép đọc; hạn chót 10 s nên không treo.
6. **`Reflector.getAllAndMerge` nối mảng metadata của method và class** (Review Focus 5, inventory): unit Task 6 và e2e Task 10 khẳng định.
7. **Cách 6.0 lưu cờ event** (trong định nghĩa hay cột outbox): quyết định câu INSERT outbox của migration mẫu (Task 8 nhánh B).
8. **Hình dạng `ComposeOptions`/`BOILERPLATE_MODULES`/ca hằng của `compose.spec.ts` khi 7A merge trước** (Task 7 nhánh B): 4A tự thêm trường `plans`, `requirePlans`, guard trong `composeAppModules` và ca UP-12 theo công thức chuẩn của plan 7A Task 3 Step 6; đọc file thật trước, tên lệch → dùng tên thật.
9. **`AUTH_MODE=hybrid` chỉ với env mặc định**: nếu không boot, chép khối `startFakeIdp` của e2e 3A (Task 11).
10. **Seed EXPLAIN theo lô 1 000 org/transaction** đủ nhỏ cho trigger hoãn và khoá advisory theo org của 3A (Task 9); đỏ vì bảng khoá thì giảm `BATCH`.

### 8. Phụ thuộc thật với plan khác

- **Cứng:** 3A (merge vào `main`): tenancy module, catalogue quyền + registry, `OrgService.create`, `OrgPurgeParticipant*`, `PurgeOrgHandler`, `OrgScopeInterceptor`/`PoliciesGuard`, bảng `organizations`/`permissions`, harness test.
- **Cùng sóng W2, không chặn (nhánh tường minh):** 6.0 (cờ `defineEvent`), 7A (composition, `markModuleLoaded`), 3B (ca DB-4 với role tuỳ biến; `A` của luật 2a lớn lên vì `entitlements.read`).
- **Plan sau dùng tên của 4A:** 4B (`Entitlements`, `OrgEntitlementRepository`, `EntitlementCatalogueCheck`, câu snapshot, `ENTITLEMENTS_PURGE_STATEMENTS`, `OrgEntitlementsResponse`), 4C (`PlanAssignments` với `PLATFORM_ADMIN`, `EntitlementsErrors`, `resolveEffective` với override, `overrideStatus`), 5A (`PlanAssignments.assign`, `defaultPlanKey`, FK `plans(id)`, lớp lỗi), 7D (`defineFeatureCatalogue`, `requireEnabled`).
