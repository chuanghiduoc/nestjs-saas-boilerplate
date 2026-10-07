# Sub-project 4C — Entitlements: override theo org và API quản trị — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm phần 4C của SP4 vào module `entitlements` đã có trên `main` (4A + 4B): bảng `org_entitlement_overrides` (một dòng mỗi org × tính năng, thay giá trị của gói, có hạn tuỳ chọn, hết hạn suy ra khi đọc), lớp `OVERRIDE` trong câu snapshot và `resolveEffective` (`OVERRIDE > PLAN > FALLBACK`, nên quota của 4B và ghế của `MemberAdmission` thấy override ngay), API quản trị `/v1/admin/**` cho nhân viên nền tảng (`@PlatformStaffAction()` của 3D, `If-Match`, lý do bắt buộc, event `entitlements.override.set`/`.removed` có `audit: true`), gán gói `PLATFORM_ADMIN` qua `PlanAssignments.assign` với `expectedVersion`, và ca HT-2b (org API key, support grant đọc entitlement); chứng minh bằng test trên Postgres 18 + PgBouncer + Redis + Mailpit thật, bộ ca `describePlatformStaffActionConformance` của 3D trên từng route, và smoke trên image production qua `docker compose --profile app`; 4C ship một mình với CI xanh.

**Architecture:** Override là con của aggregate `org_entitlements`: khoá tự nhiên `(org_id, feature_id)`, không `version` riêng; mọi ghi khoá dòng gốc `FOR NO KEY UPDATE`, so `If-Match` dưới khoá, ghi override, tăng `org_entitlements.version` và phát event outbox trong cùng `UnitOfWork`. Bất biến ở DB: trigger INVOKER `org_entitlement_overrides_value_ck` (giá trị đúng `kind`, tính năng chưa deprecated), `CHECK` biên số/lý do/một giá trị, `CHECK (expires_at > updated_at)` (override không bao giờ được ghi khi đã hết hạn), FK `RESTRICT`, RLS FORCE. Hết hạn không có sweep: câu snapshot lọc `expires_at > now()` (giờ bắt đầu transaction của caller), nên `Quotas.consume` và adapter ghế của 4B — vốn đọc snapshot trong transaction của chính chúng — thấy override còn hạn và bỏ override đã hết hạn mà không cần code mới. Route admin dùng `@PlatformStaffAction()` của identity, mở `OrgScope.run(orgId)` không qua membership (S4-D19).

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1, path-to-regexp 8.4.2), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), PostgreSQL 18, zod 4.6.5, nestjs-cls (`ClsService` trong test), OpenTelemetry API 1.9.1, Vitest + Testcontainers, supertest, `test/support/tcp-proxy.ts` (chaos), Docker Compose smoke. **Không package mới.**

**Spec:** `docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md` (r2, chốt 2026-09-29, kèm các sửa theo review 4A/4B ở mục 26; nguồn phạm vi là mọi mục gắn nhãn 4C: §7.4, dòng 4C của §7.7, lớp OVERRIDE của §8.4, §10.1–§10.2 nhánh `PLATFORM_ADMIN`, §12.1 HT-2b, §12.2, §13.1 hai event override, §15, §17 E-7/E-8/E-12, §19, §20 AD-*/HT-2b/DB-* bảng 4C/SM-1 phần override, §21 hàng 4C). Hợp đồng gate nhân viên: `docs/superpowers/specs/2026-09-28-sp3-addendum-platform-staff.md` (§A1–A5, bộ ca `describePlatformStaffActionConformance`). Phán quyết: `D:/backend-demo/.claude/worktrees/sp2-identity/.superpowers/autonomous/rulings.md` (R-X1…R-X30, bản hiệu lực; bản commit `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` cũ hơn, thiếu R-X28…R-X30). Mẫu định dạng và tên đã có: `docs/superpowers/plans/2026-10-05-sp4b-usage-quota-seats.md` và `docs/superpowers/plans/2026-09-29-sp4a-entitlements-foundation.md` (khối Produces).

**Điều kiện bắt đầu (phụ thuộc thật):** `origin/main` đã chứa PR 2 của 4B (nhánh `sp4b-usage-quota-seats`, migration `src/migrations/entitlements/Migration20261005164759_usage_counters.ts`). Đã merge và 4C dùng: **4A** (`Entitlements`, `PlanAssignments.assign` với nhánh `PLATFORM_ADMIN` và `decideAssignment`, `EntitlementCatalogueRegistry`, `EntitlementCatalogueCheck.featureId`, `OrgEntitlementRepository`, `SNAPSHOT_SQL`, `resolveEffective`/`overrideStatus`/`OverrideInput`, `ENTITLEMENTS_PURGE_STATEMENTS`, `OrgEntitlementsResponse`/`orgEntitlementsOf`, `EntitlementsErrors.PLAN_RETIRED`/`UNKNOWN_PLAN`, `EntitlementsMetrics.planAssignments`, fixture `FixtureFeatures`/`fixturePlans`/`seedFixtureCatalogue`, `holdEntitlementRow`/`holdInOrg`/`waitForBlocked`, `startEntitlementsApp`, `entitlementsCoreImports`), **4B** (`Quotas`, `MemberSeatLimitAdapter`, `UsageCounterRepository`, `R-X30` trong `entitlementsCatalogueDiff`, `seedCounter`/`readCounters`), **3D** (`PlatformStaffAction`, `PlatformAccessAudit`, `test/support/platform-staff-action.conformance.ts`, `seedStaffPrincipal`, `seedOrgApiKey`, `seedSupportGrant`, `supportPresetKeys`, `OrgApiKeyConfinementGuard`), **6.0** (`defineEvent` đòi `audit`/`webhook`, `routeTemplateOf` ở `core/http`), **7A** (composition, `docs/boilerplate/README.md`, `.upstream/zones.json` theo tiền tố). Không cần 6B (inventory admin là của 6B, R-X17; xem Task 10 Step 6), không cần 5A.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2, 3A–3D, 4A và 4B (mục Global Constraints của `2026-10-05-sp4b-usage-quota-seats.md`), cộng các luật sau, bắt buộc cho mọi task:

- **Package-first:** không cài package nào (spec §3.1, tiêu chí 12). `package.json`/`pnpm-lock.yaml` không đổi (Task 16 kiểm bằng `git diff origin/main -- package.json pnpm-lock.yaml`).
- **Generator:** `pnpm exec mikro-orm migration:create --blank --path src/migrations/entitlements --name overrides`. Tên file do CLI sinh (`Migration<14 chữ số>_overrides.ts`); plan viết `Migration<ts>_overrides`, code và test tìm migration theo hậu tố `_overrides`, không viết cứng timestamp. Timestamp phải lớn hơn `20261005164759` (migration của 4B) và lớn hơn migration mới nhất của vùng boilerplate trên `main` lúc merge (`migration-order.spec.ts` kiểm). Controller/route: `nest g controller` không dùng được cho controller trong module động có sẵn (đã thử ở 4A, sinh `spec` Jest và sửa module sai chỗ); tạo file tay theo mẫu `org-entitlements.controller.ts`.
- **Không đoán API:** mọi tên của 4A/4B/3D lấy từ code trên nhánh `sp4b-usage-quota-seats` (đối chiếu khi viết plan, liệt kê ở khối Interfaces của từng task). Tên lệch lúc thực thi → dùng tên thật, ghi vào báo cáo task. TDD, không `any`, không tắt lint, không `as never`/`as any` (`hardcode-scan.spec.ts`); không viết `limit: <số ≥ 2 chữ số>` trong `src/` (mẫu "ttl/timeout literal" của `hardcode-scan`).
- **Bất biến ở DB (spec §7.4):** `PRIMARY KEY (org_id, feature_id)`; FK `RESTRICT` tới `org_entitlements(org_id)` và `entitlement_features(id)`; `CHECK (limit_value BETWEEN 0 AND 9007199254740991)`; `CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)`; `CHECK (num_nonnulls(flag_value, limit_value) <= 1)`; thêm `org_entitlement_overrides_expiry_ck CHECK (expires_at IS NULL OR expires_at > updated_at)` (lệch có chủ đích, lý do ở Task 2); trigger `org_entitlement_overrides_value_ck` (`BEFORE INSERT OR UPDATE`) ném `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = 'org_entitlement_overrides_value_ck'`, map bằng `defineConstraintErrors` → `validation_failed`. `minimum` của tính năng chỉ ở code (S4-D2): service kiểm, không có ở DB.
- **Trigger của 4C là INVOKER** (`LANGUAGE plpgsql SET search_path = pg_catalog, public`): nó chỉ đọc `NEW` và bảng global `entitlement_features` (không RLS, `app_user` có `SELECT`), không hoãn, không đọc bảng tenant dưới FORCE. Bài học "trigger bất biến đọc bảng tenant dưới FORCE RLS là `SECURITY DEFINER` với `search_path=''`" **không áp**; 4C không tạo hàm `SECURITY DEFINER` nào, nên tập definer mà `rls-catalog.spec.ts` khẳng định chính xác (`DEFINER_FUNCTIONS ∪ DEFINER_TRIGGER_FUNCTIONS ∪ SWEEP_DEFINER_FUNCTIONS ∪ PARTITION_OWNER_FUNCTIONS`) giữ nguyên, và Task 2 khẳng định hàm mới `prosecdef = false`. Hàm trigger mới: `REVOKE ALL … FROM PUBLIC` như 4A/4B.
- **Kiểu:** `org_id UUID`, `feature_id BIGINT`, `limit_value BIGINT` (đọc ra JS bằng `::text` rồi `Number`, ≤ `ENTITLEMENT_VALUE_MAX` nên chính xác), `expires_at TIMESTAMPTZ NULL` (`NULL` = vĩnh viễn), `created_at`/`updated_at TIMESTAMPTZ`. `last_billing_seq` ra JSON là chuỗi thập phân (BIGINT).
- **Khoá và thứ tự khoá (spec §3.6):** mọi ghi override và gán gói của nhân viên khoá **chỉ** dòng `org_entitlements` `FOR NO KEY UPDATE` (không JOIN trong câu khoá, bài học C2 của 4A), rồi ghi `org_entitlement_overrides` (FK lấy `FOR KEY SHARE` trên chính dòng đã khoá) và `UPDATE org_entitlements SET version = version + 1`. Không khoá `organizations`, không khoá `usage_counters`, không bao giờ `FOR UPDATE`. Consume (4B) và adapter ghế chỉ đọc snapshot, không chờ khoá này.
- **Mốc thời gian:** hết hạn suy ra bằng `expires_at > now()` (giờ bắt đầu transaction của câu đọc), cùng biên với `overrideStatus` của 4A: override **hoạt động trên nửa khoảng `[ghi, expires_at)`**, hết hạn tại đúng `expires_at` (`now() = expires_at` → hết hạn). Không cron, không sweep, không event khi hết hạn (spec §7.4, §13.1, E-12). Ghi: `updated_at = clock_timestamp()` (sau khoá, bài học 3C); kiểm "`expiresAt` phải sau lúc này" dùng `clock_timestamp()` đọc **sau** câu khoá (câu riêng, không trong danh sách cột của câu khoá).
- **Không hard-code:** dùng hằng có sẵn `ENTITLEMENT_VALUE_MAX`, `REASON_MAX_LENGTH` (`constants.ts`); migration viết cứng cùng giá trị và Task 2 so hai phía. 4C không thêm env nào: `pnpm env:example` không đổi `.env.example` (Task 16 kiểm).
- **Fail loud:** key tính năng lạ/đã deprecated ở `PUT` → `404`; giá trị sai `kind`, dưới `minimum`, `expiresAt` không sau giờ DB → `422 validation_failed` có `errors[0].path`; gọi `Overrides` ngoài `UnitOfWork`/org context hoặc không có principal nhân viên → `EntitlementsContextError` (500, lỗi lắp ráp); override cho key pod này không biết (R-X30) → bỏ qua kèm **một** WARN `entitlements_unknown_override_feature` mỗi key mỗi process (cùng luật R-X26 của tenancy: WARN trên đường nóng một lần, không mỗi request); dòng override sai kiểu tới được lúc đọc → `InvalidEntitlementValueError` (500).
- **Mọi race có tên và cơ chế chặn** (bảng race 4C ở Self-review mục 2): E-4/E-15 (override ∥ consume), E-6b (override ∥ admission), E-7 (hai nhân viên, `If-Match` + khoá + so lại version), E-8 (override/gán tay ∥ lệnh billing), E-11c (purge ∥ ghi override), E-12 (hết hạn giữa hai câu). Check-then-insert không bao giờ là cơ chế. Race test ép giao nhau bằng seam có sẵn (`holdEntitlementRow`, `holdInOrg`, `waitForBlocked` của `test/support/entitlements-races.ts`) và cửa `gate()` bên trong `UnitOfWork.run` của code thật; không `sleep` may rủi (ngoại lệ có tên: E-12 dùng `pg_sleep` để **bảo đảm** đồng hồ DB đã qua `expires_at`, không phải để chờ một việc khác xảy ra). Lặp ×50 (`RUNS = 50`).
- **Truy cập SQL:** chỉ qua `Db.execute` (placeholder `?`, `?::bigint`, `?::boolean`, `?::timestamptz`) trên EM đang gắn; không import `@mikro-orm` ngoài `infra/`; không mảng bind trong `src` (nếu cần: `ANY(ARRAY[?]::text[])`). Test đọc/ghi bảng FORCE RLS (`org_entitlement_overrides`, `org_entitlements`, `usage_counters`) **bằng `app_user` trong OrgScope** (`withAppClient` + `inOrgTx`) và khẳng định `rowCount`; `ownerQuery`/`withOwner` thấy 0 dòng trên bảng FORCE nên chỉ dùng cho bảng global, `outbox_events` và catalog.
- **FK:** xoá dòng còn được tham chiếu bởi FK `RESTRICT` trả `23001` (`restrict_violation`), không `23503`; `23503` chỉ khi chèn dòng con trỏ tới dòng không có.
- **Problem+json:** trường lỗi của problem nằm ở `errors` (không `fields`); response kiểm `r.body.errors[0]`.
- **Đăng ký constraint → lỗi:** test chứng minh **sự đăng ký** bằng `defineConstraintErrors` ném khi trùng tên (`Constraint "<tên>" already mapped`): mọi `23514` chưa đăng ký cũng rơi về `validation_failed`, nên chỉ so mã sau khi map là test rỗng.
- **Event:** `OverrideSetEvent`, `OverrideRemovedEvent` khai `audit: true`, `webhook: false` (R-X3, S4-D20); payload chỉ id/key/số/thời điểm, **không `reason`** (spec §13.1, A9); aggregate `org_entitlement`, id = `orgId`, version = `org_entitlements.version` mới; actor `{ type: 'user', id: principal.id }` của nhân viên. `event-flags.spec.ts` (ca "audited namespaces") tự phủ event mới; plan không sửa bảng `EXPECTED` của file đó.
- **Route admin (addendum 3D):** mọi route `/v1/admin/**` của 4C mang `@PlatformStaffAction()` là guard route-scoped duy nhất; 4C không thêm guard, không định nghĩa mã lỗi cho gate; route cần step-up TOTP tươi (`local`/`hybrid`) hoặc `auth_time` tươi (`external`). Test dùng `seedStaffPrincipal()` (`test/support/tenancy-principals.ts`, factor + dấu TOTP tươi) và `describePlatformStaffActionConformance` cho **từng** route (AD-1). Service mở `OrgScope.run(orgId, …)` không qua membership (S4-D19).
- **Luật kiến trúc:** giữ mọi luật hiện có; `entitlements → identity (index)` được phép (spec §6.2, cho `PlatformStaffAction`, `IdentityErrors`); 20.8-a (tenancy/identity/notifications/files không import entitlements) không đổi; 4C không thêm luật.
- **Không PII:** không email, token, `reason`, `plan_source_ref` trong log/metric/span/event; label metric là enum hữu hạn hoặc key tính năng, không `orgId` (Task 13 kiểm bằng process thật).
- **Zone:** mọi file mới nằm dưới tiền tố đã phân vùng `boilerplate` của `.upstream/zones.json` (`src/modules/`, `src/migrations/`, `test/`, `docs/adr/`, `docs/boilerplate/`, `docs/superpowers/`); `node tools/upstream/check.mjs --self` xanh mà không sửa `zones.json`.
- **README:** mọi thay đổi README vào `docs/boilerplate/README.md` (R-X25).
- **OpenAPI:** Task 9 thêm năm route admin → sinh lại `openapi.json` bằng `pnpm build && pnpm openapi:export` và commit cùng task; `oasdiff` chỉ được thấy thay đổi cộng thêm (route mới, không sửa schema cũ: `OrgEntitlementsResponse` giữ nguyên hình dạng, `overrideExpiresAt` đã có từ 4A).
- **CodeQL:** `.github/codeql/accepted-findings.txt` khớp `rule path:line`; 4C không sửa file nào có trong danh sách đó (hôm nay chỉ `src/modules/tenancy/domain/acquisition-token.ts:8`). Task 16 kiểm lại.
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** Task 14 (luồng 4C trên image thật) và Task 16 (cuối) chạy `pnpm test:smoke`: build image production thật, `docker compose --profile app` với hạ tầng đầy đủ, `NODE_ENV=production`, migrate từ `dist`, smoke HTTP/psql trong `test/smoke/`, log container JSON sạch, `/health/ready` 200, `down -v`. Kích thước image ghi ở ADR 0013 (dòng "SP4 (4C)").
- **Spike:** code spike ở `test/integration/spike-sp4c/`, **không commit**, xoá ở bước cuối Task 1. Kết quả vào ADR 0018 mục "Kết quả spike (plan 4C)" và được commit.
- **Git:** chỉ commit mới; không `--amend`, không rebase, không force-push; cập nhật nhánh bằng `git merge origin/main`. Trước mỗi commit `pnpm exec prettier --write <file đã đổi ngoài docs/>`; mỗi task một commit trở lên, conventional message tiếng Anh. Không push, không mở PR: Task 16 dừng ở "sẵn sàng cho PR" (controller push).

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không mã test nào của spec §20 phủ, dễ làm hỏng người dùng nhất:

1. **Override hết hạn đúng tại `now()` của transaction đang tiêu thụ quota hoặc thu nhận member** (`expires_at = now()`): một khách đang chạy job dài tiêu thụ quota hoặc mời người đúng lúc ưu đãi hết. Mong đợi: biên là `>` (nửa khoảng `[ghi, expires_at)`): `expires_at = now()` → trần của gói; `expires_at = now() + 1 µs` → trần của override; cả hai câu trong một transaction thấy cùng trạng thái (E-12). Test: Task 5 (`Review Focus 1: an override that expires exactly at the transaction now() no longer applies to consume or seats`).
2. **Lý do có khoảng trắng hai đầu, emoji, chỉ khoảng trắng, đúng 500/501 code point** (nhân viên dán từ ticket): mong đợi `"  goodwill  "` lưu `"goodwill"`; 500 emoji (1000 đơn vị UTF-16) được nhận; 501 → `422`; `"   "` → `422`; không bao giờ `500` vì `CHECK` của DB (`btrim` của Postgres chỉ cắt dấu cách, `trim` của JS cắt rộng hơn nên luôn thoả). Test: Task 9 (`Review Focus 2: reasons are trimmed and measured in code points`).
3. **Override trên tính năng chỉ có ở DB (pod cũ lúc rolling deploy, R-X30) hoặc đã deprecated:** mong đợi snapshot bỏ qua override lạ với đúng một WARN mỗi process (không 500, không spam log mỗi request); `PUT` trên key lạ hoặc deprecated → `404`; `DELETE` trên key deprecated vẫn xoá được (dọn trước khi migration xoá tính năng, vòng đời spec §8.4). Test: Task 4 (`Review Focus 3: an override of a feature unknown to this pod is ignored with one warning`) và Task 9 (`DELETE of a deprecated feature's override`).
4. **Org đã xoá mềm:** nhân viên vẫn đọc/ghi được entitlement của org đang chờ purge (spec §12.2), và purge sau đó xoá cả override (không `23001`). Test: Task 9 (`Review Focus 4: a soft-deleted org stays readable and writable by staff; the purge removes its overrides`).
5. **Biên số của `limit`:** `2^53 − 1` được nhận và trả nguyên (JSON không mất chính xác); `2^53` → `422`; `null` trên một `QUOTA` = không giới hạn, và `Quotas.consume` sau đó đi nhánh `UNLIMITED` (vẫn đếm, không bao giờ `EXCEEDED`); `null` trên `FLAG` → `422`. Test: Task 9 (`Review Focus 5: limit bounds and null = unlimited`).

---

## File Structure

```
src/
  migrations/entitlements/Migration<ts>_overrides.ts        (mới) bảng, index, RLS, grant, trigger value_ck, CHECK expiry
  modules/entitlements/
    errors.ts (+2 tên constraint) · events.ts (+OverrideSetEvent, OverrideRemovedEvent) · index.ts (+2 event)
    entitlements.module.ts (+SqlOverrideRepository/OverrideRepository, Overrides, AdminEntitlementsQuery, AdminEntitlements)
    domain/        override.ts (mới: OverrideRequest, OverrideValue, decideOverrideValue, isReason)
                   effective-value.ts (+OVERRIDE_STATUSES; OverrideStatus giữ nguyên nghĩa)
    ports/         override.repository.ts (mới) · org-entitlement.repository.ts (SnapshotRow.overrides, readAdminRoot)
    application/   overrides.service.ts (mới) · admin-entitlements.query.ts (mới) · admin-entitlements.service.ts (mới)
                   entitlements.service.ts (snapshot nhận override, WARN một lần cho key lạ)
    infra/sql/     sql-override.repository.ts (mới) · sql-org-entitlement.repository.ts (SNAPSHOT_SQL + LEFT JOIN, readAdminRoot)
                   entitlements-purge.sql.ts (+override giữa hai câu)
    infra/tenancy/ member-seat-limit.adapter.ts (chỉ chú thích: override nay có thật)
    http/          admin-entitlements.controller.ts (mới) · schemas.ts (overrideExpiresAt thật; schema admin) · entitlements-http.module.ts
openapi.json                           sinh lại (Task 9)
test/
  support/  entitlements-catalog.ts (+_4C) · entitlements-seed.ts (seedOverride, readOverrides, outboxOf)
            platform-staff-action.conformance.ts (+tuỳ chọn entitlementPermissions, Task 10)
  unit/     modules/entitlements/{override,entitlements-service,schemas,errors,admin-schemas}.spec.ts
  integration/ entitlements/{overrides-db,overrides-down,snapshot-repository,entitlements-service,snapshot-explain,
            override-expiry,override-repository,overrides,admin-entitlements,overrides-races}.spec.ts
            core/database/normalization-inventory.spec.ts
  e2e/      entitlements/{org-entitlements,seats,admin-entitlements,admin-conformance,admin-billing-reassert,admin-pii-logs}.e2e.spec.ts
  chaos/    entitlements-outages.spec.ts
  smoke/    entitlements.smoke.spec.ts
docs/adr/ 0018 · 0005 · 0013
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (P1 phần 4C) · 2026-09-28-sp4-entitlements-design.md (lệch có chủ đích của 4C)
docs/boilerplate/README.md
```

**Vì sao có thêm `admin-entitlements.service.ts` ngoài hai file spec §6.2 nêu (`overrides.service.ts`, `admin-entitlements.query.ts`):** route admin cần một chỗ mở `OrgScope.run(orgId)` + `UnitOfWork.run` không qua membership (S4-D19), khoá dòng gốc, so `If-Match`, rồi gọi `PlanAssignments.assign` hoặc `Overrides` và đọc lại view trong cùng transaction. Đặt việc đó trong controller sẽ đưa `OrgScope`/`UnitOfWork` vào tầng HTTP; đặt trong `Overrides` sẽ trộn gán gói vào service override. Một service điều phối mỏng giữ mỗi file một trách nhiệm.

**Vì sao `Overrides`, `AdminEntitlementsQuery`, `AdminEntitlements` nằm ở `EntitlementsCoreModule` (cả api lẫn worker), chỉ controller nằm ở `EntitlementsHttpModule` (api):** cùng mẫu `PlanAssignments` (core, `@Global`): test integration và race (Task 7, 8, 12) dựng app bằng `entitlementsCoreImports` (không HTTP, không identity api), và controller ở module HTTP lấy service qua module `@Global`. Worker có thêm ba provider không ai gọi (không route, không job): chi phí DI không đáng kể, không mở đường nào mới.

**Vì sao view admin không có `used`/`state`/kỳ của quota (lệch có chủ đích so với "Như tenant" của §12.2):** ETag của view admin là `org_entitlements.version` (để `If-Match` của `PUT`/`DELETE` dùng được) và spec hứa `304`. Biểu diễn có `ETag` theo version phải là hàm của (aggregate, giờ): `used` đổi ở mỗi lần consume mà `version` không đổi, nên `304` sẽ trả usage cũ. View admin giữ mọi thứ suy ra được từ aggregate (gói, nguồn, override kể cả hết hạn với `status`, giá trị hiệu lực) và gửi `Cache-Control: no-store` (dữ liệu nội bộ của nhân viên, có `reason`: trình duyệt không lưu, nên không bao giờ tự gửi `If-None-Match`); client tự gửi `If-None-Match` nhận `304` nghĩa là "aggregate không đổi", và `status` tính lại được từ `expiresAt`. Giá nếu sai: thêm `used` vào view sau (thay đổi cộng thêm của OpenAPI).

---
## Phần A — Spike (bắt buộc làm trước mọi task khác)

### Task 1: Spike — trigger `BEFORE UPDATE` trên nhánh `DO UPDATE` của upsert, `CHECK` hết hạn trên nhánh đó, path param có dấu chấm, spy handler, `304` với `Cache-Control: no-store`; mục kết quả trong ADR 0018

Ba giả định chưa chạy được mà thiết kế 4C dựa vào: (a) Postgres chạy trigger `BEFORE UPDATE` cho nhánh `ON CONFLICT … DO UPDATE` với `NEW` là dòng **sau** `SET` (4B mới kiểm `BEFORE INSERT` trên dòng đề xuất), nên `org_entitlement_overrides_value_ck` chặn được cả nhánh cập nhật; và `CHECK (expires_at > updated_at)` được kiểm trên dòng sau `SET` của nhánh đó; (b) qua Nest + Express 5 thật, `:featureKey` nhận nguyên `tenancy.seats` (đã kiểm `path-to-regexp@8.4.2` trực tiếp khi viết plan: `{"featureKey":"tenancy.seats"}`, cả dạng `%2E`), và `vi.spyOn(Controller.prototype, 'method')` đặt **trước** khi dựng app đếm được lần chạy handler (Task 10 dùng làm `handlerCalls` cho ca C9/C10 của bộ ca 3D); (c) handler tự đặt `ETag` và `Cache-Control: no-store` thì `If-None-Match` khớp vẫn ra `304` và header `no-store` còn trên response (Task 9 dựa vào cả hai). Đã kiểm khi viết plan (không cần spike): zod 4.6.5 `z.int()` từ chối `2^53`, `z.union` của hai `.strict()` từ chối body có cả `enabled` lẫn `limit`, `z.iso.datetime()` từ chối offset `+07:00`.

**Files:**
- Throwaway: `test/integration/spike-sp4c/override-trigger.spec.ts`, `test/integration/spike-sp4c/admin-http.spec.ts`
- Modify: `docs/adr/0018-entitlements-in-code.md` (thêm mục "Kết quả spike (plan 4C)")

**Interfaces:**
- Consumes: `withOwner` (`test/support/entitlements-seed.ts`); `startTenancyApp` (`test/support/tenancy-app.ts`); `PublicRoute`, `etagOf`, `type HeaderWriter` (`src/core/http/index.ts`).
- Produces: mục "Kết quả spike (plan 4C)" của ADR 0018. Task 2 dựa vào kết luận (a) (trigger `BEFORE INSERT OR UPDATE` + `CHECK` hết hạn); Task 9 dựa vào (b) phần path param và (c); Task 10 dựa vào (b) phần spy.

- [ ] **Step 0: Nhánh làm việc từ `main` mới nhất**

Run:
```bash
git fetch origin
git log --oneline -1 origin/main
git ls-tree --name-only origin/main src/migrations/entitlements/
git grep -n "class PlatformStaffGuard\|export function describePlatformStaffActionConformance" origin/main -- src test | head
git grep -n "readSnapshot\|lockForAssignment\|SNAPSHOT_SQL" origin/main -- src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts | head
git grep -n "PlatformStaffRouteInventory" origin/main -- src || echo "6B not merged"
git switch -c sp4c-overrides-admin origin/main
```
Expected: `origin/main` có `Migration20261005164759_usage_counters.ts` (4B PR 2 đã merge) và chưa có `…_overrides`; hai tên của 3D có mặt; `6B not merged` (nếu 6B đã merge: ghi vào báo cáo task, Task 10 Step 6 xử lý). Tên lệch → dùng tên thật, ghi vào báo cáo task. Làm trong worktree riêng theo skill `superpowers:using-git-worktrees` nếu phiên đang ở worktree khác.

- [ ] **Step 1: Viết spike DB**

`test/integration/spike-sp4c/override-trigger.spec.ts`:
```ts
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withOwner } from '../../support/entitlements-seed.js';

const ORG = '0198c000-0000-7000-8000-0000000000c1';

/** Mọi thứ trong một transaction luôn ROLLBACK (DDL của Postgres có transaction): không để lại gì trong DB dùng chung. */
const inScratchTx = (fn: (c: pg.Client) => Promise<void>) =>
  withOwner(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        `CREATE TABLE spike_features (id BIGINT PRIMARY KEY, kind TEXT NOT NULL)`,
      );
      await c.query(`INSERT INTO spike_features VALUES (1, 'FLAG'), (2, 'LIMIT')`);
      await c.query(`CREATE TABLE spike_overrides (
        org_id UUID NOT NULL, feature_id BIGINT NOT NULL REFERENCES spike_features (id),
        flag_value BOOLEAN NULL, limit_value BIGINT NULL, expires_at TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, feature_id),
        CONSTRAINT spike_expiry_ck CHECK (expires_at IS NULL OR expires_at > updated_at))`);
      await c.query(`CREATE FUNCTION public.spike_value_ck() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE k text;
        BEGIN
          SELECT kind INTO k FROM public.spike_features WHERE id = NEW.feature_id;
          IF (k = 'FLAG' AND (NEW.flag_value IS NULL OR NEW.limit_value IS NOT NULL))
             OR (k <> 'FLAG' AND NEW.flag_value IS NOT NULL) THEN
            RAISE EXCEPTION 'bad value' USING ERRCODE = 'check_violation', CONSTRAINT = 'spike_value_ck';
          END IF;
          RETURN NEW;
        END $$`);
      await c.query(`CREATE TRIGGER spike_value_ck BEFORE INSERT OR UPDATE ON spike_overrides
        FOR EACH ROW EXECUTE FUNCTION public.spike_value_ck()`);
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });

/** Lỗi pg của câu `sql` trong một SAVEPOINT (transaction ngoài còn dùng tiếp được). */
async function errorOf(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<{ code: unknown; constraint: unknown } | undefined> {
  await c.query('SAVEPOINT s');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT s');
    return undefined;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    return {
      code: Reflect.get(Object(err), 'code'),
      constraint: Reflect.get(Object(err), 'constraint'),
    };
  }
}

describe('spike S4C-1 (plan 4C): BEFORE UPDATE and CHECK run on the DO UPDATE branch of an upsert', () => {
  it('(a) a DO UPDATE whose SET makes a LIMIT row carry a flag value is refused by the BEFORE UPDATE trigger', () =>
    inScratchTx(async (c) => {
      await c.query(
        `INSERT INTO spike_overrides (org_id, feature_id, limit_value) VALUES ($1, 2, 3)`,
        [ORG],
      );
      // Dòng đề xuất hợp lệ cho INSERT (BEFORE INSERT cho qua); chỉ dòng SAU `SET` mới sai.
      expect(
        await errorOf(
          c,
          `INSERT INTO spike_overrides (org_id, feature_id, limit_value) VALUES ($1, 2, 4)
           ON CONFLICT (org_id, feature_id) DO UPDATE SET flag_value = true`,
          [ORG],
        ),
      ).toEqual({ code: '23514', constraint: 'spike_value_ck' });
      expect(
        (await c.query('SELECT limit_value::text AS v, flag_value FROM spike_overrides')).rows,
      ).toEqual([{ v: '3', flag_value: null }]);
    }));
  it('(a) a valid DO UPDATE replaces the values (NEW of BEFORE UPDATE is the row after SET)', () =>
    inScratchTx(async (c) => {
      await c.query(
        `INSERT INTO spike_overrides (org_id, feature_id, flag_value) VALUES ($1, 1, true)`,
        [ORG],
      );
      await c.query(
        `INSERT INTO spike_overrides (org_id, feature_id, flag_value) VALUES ($1, 1, false)
         ON CONFLICT (org_id, feature_id) DO UPDATE SET flag_value = EXCLUDED.flag_value`,
        [ORG],
      );
      expect((await c.query('SELECT flag_value FROM spike_overrides')).rows).toEqual([
        { flag_value: false },
      ]);
    }));
  it('(a) the expiry CHECK is evaluated on the row after SET: an expires_at not later than clock_timestamp() is refused', () =>
    inScratchTx(async (c) => {
      await c.query(
        `INSERT INTO spike_overrides (org_id, feature_id, limit_value, expires_at) VALUES ($1, 2, 3, now() + interval '1 day')`,
        [ORG],
      );
      expect(
        await errorOf(
          c,
          `INSERT INTO spike_overrides (org_id, feature_id, limit_value, expires_at, updated_at)
           VALUES ($1, 2, 3, now() - interval '1 second', clock_timestamp())
           ON CONFLICT (org_id, feature_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
          [ORG],
        ),
      ).toEqual({ code: '23514', constraint: 'spike_expiry_ck' });
    }));
});
```

- [ ] **Step 2: Viết spike HTTP**

`test/integration/spike-sp4c/admin-http.spec.ts`:
```ts
import {
  Controller,
  Get,
  Module,
  Param,
  Res,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PublicRoute,
  etagOf,
  type HeaderWriter,
} from '../../../src/core/http/index.js';
import { startTenancyApp } from '../../support/tenancy-app.js';

const SPIKE_VERSION = 7;

@Controller('v1/__spike4c')
class SpikeController {
  @PublicRoute()
  @Get('items/:featureKey')
  get(
    @Param('featureKey') featureKey: string,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    res.setHeader('ETag', etagOf(SPIKE_VERSION));
    res.setHeader('Cache-Control', 'no-store');
    return { featureKey };
  }
}
@Module({ controllers: [SpikeController] })
class SpikeModule {}
/** Đặt TRƯỚC khi dựng app: Nest giữ tham chiếu `instance[method]` lúc đăng ký route. */
const handler = vi.spyOn(SpikeController.prototype, 'get');

describe('spike S4C-2/S4C-3 (plan 4C): dotted path param, prototype spy, 304 with no-store', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [SpikeModule] });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('(b) :featureKey receives tenancy.seats whole; a prototype spy installed before boot counts the handler', async () => {
    const r = await request(app.getHttpServer()).get(
      '/v1/__spike4c/items/tenancy.seats',
    );
    expect([r.status, r.body]).toEqual([200, { featureKey: 'tenancy.seats' }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('(c) If-None-Match equal to the handler ETag → 304, and Cache-Control: no-store stays on the response', async () => {
    const r = await request(app.getHttpServer())
      .get('/v1/__spike4c/items/x.y')
      .set('if-none-match', etagOf(SPIKE_VERSION));
    expect(r.status).toBe(304);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
```

- [ ] **Step 3: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp4c`
Expected: PASS 5/5. Xử lý khi không đạt:
- (a) ca đầu đỏ (câu `DO UPDATE` đi qua, dòng thành `flag_value = true`) → trigger không chặn nhánh cập nhật: Task 2 vẫn giữ trigger (chặn INSERT và `UPDATE` thường) nhưng `SqlOverrideRepository.upsert` (Task 6) đổi sang hai câu dưới khoá dòng gốc (`UPDATE … RETURNING` rồi `INSERT` khi 0 dòng; an toàn vì mọi ghi override đã tuần tự hoá trên khoá `org_entitlements`); ghi vào ADR và báo controller.
- (a) ca `CHECK` đỏ → bỏ `org_entitlement_overrides_expiry_ck` khỏi Task 2, giữ kiểm ở service; ghi vào ADR.
- (b) param đỏ → đổi path `PUT/DELETE …/overrides/:featureKey` sang `…/overrides/:module/:name` là thay đổi hợp đồng HTTP của spec §12.2: dừng, báo controller. (b) spy đỏ → Task 10 bỏ `handlerCalls` (bộ ca vẫn chạy; C10 chỉ kiểm `503` và port không ghi, như chú thích của `ConformanceOptions`); ghi vào ADR.
- (c) đỏ (không `304`) → Task 9 bỏ ca `304`, ghi lệch vào spec ở Task 15; (c) `no-store` mất → Task 9 đặt header bằng interceptor riêng; ghi vào ADR.

- [ ] **Step 4: Ghi kết quả vào ADR 0018**

`docs/adr/0018-entitlements-in-code.md` — thêm sau mục "Kết quả spike (plan 4B)":
```markdown
## Kết quả spike (plan 4C)

Chạy trên nhánh `sp4c-overrides-admin` (sau khi 4B PR 2 merge), Postgres 18 của `docker/images.env` qua Testcontainers (bảng `spike_*` tạo bằng `app_owner` trong một transaction ROLLBACK) và app Nest thật (`startTenancyApp`).

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| S4C-1 (a) | Trigger `BEFORE INSERT OR UPDATE` chặn nhánh `ON CONFLICT … DO UPDATE` theo dòng SAU `SET`; nhánh hợp lệ thay giá trị | <Đạt/Không đạt> | spike `override-trigger.spec.ts` (không commit); giữ thành DB-3 ở Task 2 |
| S4C-1 (a') | `CHECK (expires_at > updated_at)` được kiểm trên dòng sau `SET` của nhánh `DO UPDATE` | <Đạt/Không đạt> | cùng file; giữ thành DB-3 ở Task 2 |
| S4C-2 (b) | `:featureKey` qua Nest/Express 5 nhận nguyên `tenancy.seats` | <Đạt/Không đạt> | spike `admin-http.spec.ts`; giữ thành ca e2e ở Task 9 |
| S4C-2 (b') | `vi.spyOn(Controller.prototype, …)` đặt trước khi dựng app đếm được handler | <Đạt/Không đạt> | cùng file; dùng ở Task 10 (`handlerCalls`) |
| S4C-3 (c) | `If-None-Match` khớp ETag do handler đặt → `304`, `Cache-Control: no-store` còn | <Đạt/Không đạt> | cùng file; giữ thành ca e2e ở Task 9 |
```
Thay năm ô `<…>` bằng kết quả thật của Step 3 (dữ liệu của lần chạy, không phải chỗ trống của thiết kế).

- [ ] **Step 5: Xoá code spike, commit ADR**

Run:
```bash
rm -rf test/integration/spike-sp4c
git status --short
git add docs/adr/0018-entitlements-in-code.md
git commit -m "docs(entitlements): record the S4C spike results for plan 4C in ADR 0018"
```
Expected: `git status` trước `add` chỉ có ADR 0018.

---
## Phần B — Schema (spec §7.4, §7.6, §7.7 dòng 4C, §13.2 purge)

### Task 2: Migration `org_entitlement_overrides` (up) — bảng, index, RLS/FORCE/policy `TO app_user`, grant theo cột, trigger `org_entitlement_overrides_value_ck`, `CHECK` hết hạn; purge con trước cha; catalog, cô lập, ràng buộc (DB-1, DB-2, DB-3, R-1)

**Lệch có chủ đích (một):** thêm `org_entitlement_overrides_expiry_ck CHECK (expires_at IS NULL OR expires_at > updated_at)`. Spec §12.2 chỉ đòi service kiểm "`expiresAt` phải > `now()`". Bất biến "một override không bao giờ được ghi khi đã hết hạn" biểu diễn được trên dòng (mọi ghi đặt `updated_at = clock_timestamp()`), nên theo luật "bất biến nằm ở DB" (spec §3.3) nó vào DB; service vẫn kiểm trước để trả `422` có `errors[0].path = 'expiresAt'` (Task 7). Seed dòng đã hết hạn trong test đặt `updated_at` lùi trước `expires_at` (helper `seedOverride`), đúng trạng thái mà production có khi một override còn hạn lúc ghi rồi hết hạn sau đó.

**Files:**
- Create: `src/migrations/entitlements/Migration<ts>_overrides.ts` (CLI sinh)
- Modify: `src/modules/entitlements/infra/sql/entitlements-purge.sql.ts`, `src/modules/entitlements/errors.ts`
- Modify (test support): `test/support/entitlements-catalog.ts`, `test/support/entitlements-seed.ts`
- Create (test): `test/integration/entitlements/overrides-db.spec.ts`
- Modify (test): `test/integration/core/database/normalization-inventory.spec.ts`, `test/unit/modules/entitlements/errors.spec.ts`

**Interfaces:**
- Consumes: `ENTITLEMENT_VALUE_MAX`, `REASON_MAX_LENGTH` (`constants.ts`); `defineConstraintErrors` (`core/database`); `CoreErrors.VALIDATION_FAILED`; `ORG_PURGE_STATEMENTS` (`tenancy/infra/sql/org-purge.sql.ts`); `withOwner`, `seedFeatures`, `seedPlans`, `seedOrgEntitlement` (`entitlements-seed.ts`); `seedOrg`, `withAppClient`, `inOrgTx`, `type SeededOrg` (`tenancy-seed.ts`).
- Produces:
  - bảng `org_entitlement_overrides` (cột theo spec §7.4), constraint `org_entitlement_overrides_pkey`, `org_entitlement_overrides_org_fk`, `org_entitlement_overrides_feature_fk`, `org_entitlement_overrides_limit_ck`, `org_entitlement_overrides_reason_ck`, `org_entitlement_overrides_one_value_ck`, `org_entitlement_overrides_expiry_ck`; index `org_entitlement_overrides_feature_idx`; policy `org_entitlement_overrides_tenant`; hàm `entitlements_override_value_ck()` (INVOKER) + trigger `org_entitlement_overrides_value_ck`.
  - `ENTITLEMENTS_PURGE_STATEMENTS` = `[usage_counters, org_entitlement_overrides, org_entitlements]` (thứ tự này).
  - `defineConstraintErrors` thêm `org_entitlement_overrides_value_ck`, `org_entitlement_overrides_expiry_ck` → `CoreErrors.VALIDATION_FAILED`.
  - test support: `ENTITLEMENTS_TENANT_TABLES_4C`; `type OverrideSeed`, `seedOverride(orgId, featureKey, o, database?)`, `type OverrideDbRow`, `readOverrides(orgId, database?)`, `type OutboxRow`, `outboxOf(orgId, type)`.

- [ ] **Step 1: Helper seed và hằng catalog**

`test/support/entitlements-catalog.ts` — thêm sau dòng `ENTITLEMENTS_TENANT_TABLES_4B`, và gộp vào `ENTITLEMENTS_TENANT_TABLES`:
```ts
export const ENTITLEMENTS_TENANT_TABLES_4C = [
  'org_entitlement_overrides',
] as const;
export const ENTITLEMENTS_TENANT_TABLES: readonly string[] = [
  ...ENTITLEMENTS_TENANT_TABLES_4A,
  ...ENTITLEMENTS_TENANT_TABLES_4B,
  ...ENTITLEMENTS_TENANT_TABLES_4C,
];
```
(thay định nghĩa cũ của `ENTITLEMENTS_TENANT_TABLES`; không sửa hằng 4A/4B.)

`test/support/entitlements-seed.ts` — thêm cuối file:
```ts
export type OverrideSeed = {
  value: { enabled: boolean } | { limit: number | null };
  reason?: string;
  /** Giây tính từ `now()` của DB; âm = đã hết hạn; vắng = vĩnh viễn. */
  expiresInSec?: number;
};

/**
 * Một dòng `org_entitlement_overrides` bằng `app_user` trong OrgScope (bảng FORCE RLS). `updated_at`/`created_at` lùi trước
 * `expires_at` để seed được override đã hết hạn mà `org_entitlement_overrides_expiry_ck` vẫn đúng (trạng thái production có
 * khi override còn hạn lúc ghi rồi hết hạn sau đó). Seed thẳng: không tăng `org_entitlements.version`, không event.
 */
export async function seedOverride(
  orgId: string,
  featureKey: string,
  o: OverrideSeed,
  database?: string,
): Promise<void> {
  const flag = 'enabled' in o.value ? o.value.enabled : null;
  const limit = 'limit' in o.value ? o.value.limit : null;
  const n = await withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const r = await c.query(
          `INSERT INTO org_entitlement_overrides (org_id, feature_id, flag_value, limit_value, reason, expires_at, created_at, updated_at)
           SELECT app_current_org(), f.id, $2::boolean, $3::bigint, $4::text, e.at,
                  LEAST(now(), e.at - interval '1 second'), LEAST(now(), e.at - interval '1 second')
           FROM entitlement_features f,
                (SELECT CASE WHEN $5::double precision IS NULL THEN NULL
                             ELSE now() + make_interval(secs => $5::double precision) END AS at) e
           WHERE f.key = $1`,
          [
            featureKey,
            flag,
            limit === null ? null : String(limit),
            o.reason ?? 'seed override',
            o.expiresInSec ?? null,
          ],
        );
        return r.rowCount ?? 0;
      }),
    database,
  );
  if (n !== 1)
    throw new Error(`seedOverride: feature "${featureKey}" does not exist`);
}

export type OverrideDbRow = {
  feature: string;
  flagValue: boolean | null;
  limitValue: number | null;
  reason: string;
  expiresAt: Date | null;
};

/** Mọi override của org, đọc bằng `app_user` trong OrgScope; sắp theo key. */
export async function readOverrides(
  orgId: string,
  database?: string,
): Promise<OverrideDbRow[]> {
  return withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const { rows } = await c.query<{
          feature: string;
          flag_value: boolean | null;
          limit_value: string | null;
          reason: string;
          expires_at: Date | null;
        }>(
          `SELECT f.key AS feature, o.flag_value, o.limit_value::text AS limit_value, o.reason, o.expires_at
           FROM org_entitlement_overrides o JOIN entitlement_features f ON f.id = o.feature_id ORDER BY f.key`,
        );
        return rows.map((r) => ({
          feature: r.feature,
          flagValue: r.flag_value,
          limitValue: r.limit_value === null ? null : Number(r.limit_value),
          reason: r.reason,
          expiresAt: r.expires_at,
        }));
      }),
    database,
  );
}

export type OutboxRow = {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  aggregate_version: string;
};

/** Event outbox của một org theo type (bảng không FORCE: `app_owner` đọc được), theo thứ tự ghi. */
export const outboxOf = (orgId: string, type: string): Promise<OutboxRow[]> =>
  withOwner(
    async (c) =>
      (
        await c.query<OutboxRow>(
          `SELECT payload, headers, aggregate_version::text AS aggregate_version FROM outbox_events
           WHERE org_id = $1 AND type = $2 ORDER BY id`,
          [orgId, type],
        )
      ).rows,
  );
```

- [ ] **Step 2: Viết test schema (đỏ)**

`test/integration/entitlements/overrides-db.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_VALUE_MAX,
  REASON_MAX_LENGTH,
} from '../../../src/modules/entitlements/constants.js';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js';
import { ORG_PURGE_STATEMENTS } from '../../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import {
  readOverrides,
  seedFeatures,
  seedOrgEntitlement,
  seedPlans,
  withOwner,
} from '../../support/entitlements-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Lỗi pg có `code` (SQLSTATE) và `constraint`; đọc bằng `Reflect.get` để không cast. */
async function rejectsWith(
  p: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected a database error').toBeInstanceOf(Error);
  if (!(err instanceof Error)) return;
  expect(Reflect.get(err, 'code')).toBe(code);
  if (constraint) expect(Reflect.get(err, 'constraint')).toBe(constraint);
}
const inOrg = (orgId: string, sql: string, params: unknown[] = []) =>
  withAppClient((c) => inOrgTx(c, orgId, () => c.query(sql, params)));
const owner = (sql: string, params: unknown[] = []) =>
  withOwner((c) => c.query(sql, params));
/** Chèn bằng `app_user` trong OrgScope (đường của app); `cols` là cột tuỳ chọn ngoài khoá, giá trị là SQL. */
const insertOverride = (
  orgId: string,
  featureKey: string,
  cols: {
    flag?: string;
    limit?: string;
    reason?: string;
    expires?: string;
    updated?: string;
  } = {},
) =>
  inOrg(
    orgId,
    `INSERT INTO org_entitlement_overrides (org_id, feature_id, flag_value, limit_value, reason, expires_at, updated_at)
     SELECT app_current_org(), id, ${cols.flag ?? 'NULL'}, ${cols.limit ?? 'NULL'}, ${cols.reason ?? `'why'`},
            ${cols.expires ?? 'NULL'}, ${cols.updated ?? 'now()'}
     FROM entitlement_features WHERE key = $1`,
    [featureKey],
  );
const clear = (orgId: string) =>
  inOrg(orgId, 'DELETE FROM org_entitlement_overrides');

describe('org_entitlement_overrides schema (spec SP4 §7.4, DB-1, DB-2, DB-3, R-1)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let bare: SeededOrg;
  const disposers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    disposers.push(
      await seedFeatures([
        { key: 'ovdb.flag', kind: 'FLAG', resetPeriod: null, deprecated: false },
        { key: 'ovdb.cap', kind: 'LIMIT', resetPeriod: null, deprecated: false },
        { key: 'ovdb.calls', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false },
        { key: 'ovdb.old', kind: 'FLAG', resetPeriod: null, deprecated: true },
      ]),
    );
    disposers.push(await seedPlans([{ key: 'ovdb_plan' }]));
    a = await seedOrg();
    b = await seedOrg();
    bare = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'ovdb_plan');
    await seedOrgEntitlement(b.orgId, 'ovdb_plan');
  });
  afterAll(async () => {
    for (const o of [a, b, bare]) await o?.dispose();
    for (const d of disposers.reverse()) await d();
  });

  it('DB-1: RLS + FORCE; app_user has SELECT/INSERT/DELETE, no TRUNCATE, and UPDATE only on the five value columns', async () => {
    const { rows } = await owner(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              has_table_privilege('app_user', c.oid, 'SELECT') AS sel, has_table_privilege('app_user', c.oid, 'INSERT') AS ins,
              has_table_privilege('app_user', c.oid, 'DELETE') AS del, has_table_privilege('app_user', c.oid, 'TRUNCATE') AS trunc
       FROM pg_class c WHERE c.oid = 'public.org_entitlement_overrides'::regclass`,
    );
    expect(rows).toEqual([
      { rls: true, force: true, sel: true, ins: true, del: true, trunc: false },
    ]);
    const cols = await owner(
      `SELECT a.attname AS col FROM pg_attribute a
       WHERE a.attrelid = 'public.org_entitlement_overrides'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('app_user', a.attrelid, a.attname, 'UPDATE') ORDER BY a.attname`,
    );
    expect(cols.rows.map((r) => r.col)).toEqual([
      'expires_at',
      'flag_value',
      'limit_value',
      'reason',
      'updated_at',
    ]);
  });
  it('the value trigger function is INVOKER, owned by app_owner, not executable by PUBLIC or app_user', async () => {
    const { rows } = await owner(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec,
              p.proconfig AS config
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'entitlements_override_value_ck'`,
    );
    expect(rows).toEqual([
      {
        owner: 'app_owner',
        definer: false,
        app_user_exec: false,
        public_exec: false,
        config: ['search_path=pg_catalog, public'],
      },
    ]);
    const trig = await owner(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.org_entitlement_overrides'::regclass`,
    );
    expect(trig.rows).toEqual([{ tgname: 'org_entitlement_overrides_value_ck' }]);
  });
  it('the CHECKs carry the constants of the code (ENTITLEMENT_VALUE_MAX, REASON_MAX_LENGTH); the feature FK has its index', async () => {
    const { rows } = await owner(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.org_entitlement_overrides'::regclass AND contype = 'c' ORDER BY conname`,
    );
    const def = (name: string) => rows.find((r) => r.conname === name)?.def ?? '';
    expect(rows.map((r) => r.conname)).toEqual([
      'org_entitlement_overrides_expiry_ck',
      'org_entitlement_overrides_limit_ck',
      'org_entitlement_overrides_one_value_ck',
      'org_entitlement_overrides_reason_ck',
    ]);
    expect(def('org_entitlement_overrides_limit_ck')).toContain(
      String(ENTITLEMENT_VALUE_MAX),
    );
    expect(def('org_entitlement_overrides_reason_ck')).toContain(
      String(REASON_MAX_LENGTH),
    );
    const idx = await owner(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'org_entitlement_overrides_feature_idx'`,
    );
    expect(idx.rows).toEqual([
      {
        indexdef:
          'CREATE INDEX org_entitlement_overrides_feature_idx ON public.org_entitlement_overrides USING btree (feature_id)',
      },
    ]);
  });

  it.each([
    ['a FLAG override without a flag value', 'ovdb.flag', {}, 'org_entitlement_overrides_value_ck'],
    ['a FLAG override with a limit', 'ovdb.flag', { flag: 'true', limit: '3' }, 'org_entitlement_overrides_value_ck'],
    ['a LIMIT override with a flag value', 'ovdb.cap', { flag: 'true' }, 'org_entitlement_overrides_value_ck'],
    ['a QUOTA override with a flag value', 'ovdb.calls', { flag: 'false' }, 'org_entitlement_overrides_value_ck'],
    ['an override of a deprecated feature', 'ovdb.old', { flag: 'true' }, 'org_entitlement_overrides_value_ck'],
    ['limit = -1', 'ovdb.cap', { limit: '-1' }, 'org_entitlement_overrides_limit_ck'],
    ['limit = 2^53', 'ovdb.cap', { limit: '9007199254740992' }, 'org_entitlement_overrides_limit_ck'],
    ['an empty reason', 'ovdb.cap', { limit: '1', reason: `''` }, 'org_entitlement_overrides_reason_ck'],
    ['a reason with a leading space', 'ovdb.cap', { limit: '1', reason: `' why'` }, 'org_entitlement_overrides_reason_ck'],
    ['a reason of 501 characters', 'ovdb.cap', { limit: '1', reason: `repeat('x', 501)` }, 'org_entitlement_overrides_reason_ck'],
    ['an expiry not later than the write', 'ovdb.cap', { limit: '1', expires: 'now()', updated: 'now()' }, 'org_entitlement_overrides_expiry_ck'],
  ])('DB-3: INSERT %s → 23514 %s', async (_, key, cols, constraint) => {
    await rejectsWith(insertOverride(a.orgId, key, cols), '23514', constraint);
  });
  it('DB-3: valid rows — FLAG false, LIMIT NULL (unlimited), QUOTA 2^53 − 1, a 500-emoji reason, a future expiry', async () => {
    await insertOverride(a.orgId, 'ovdb.flag', { flag: 'false' });
    await insertOverride(a.orgId, 'ovdb.cap', {
      reason: `repeat('😀', ${REASON_MAX_LENGTH})`,
    });
    await insertOverride(a.orgId, 'ovdb.calls', {
      limit: String(ENTITLEMENT_VALUE_MAX),
      expires: `now() + interval '1 day'`,
    });
    expect(
      (await readOverrides(a.orgId)).map((r) => [r.feature, r.flagValue, r.limitValue]),
    ).toEqual([
      ['ovdb.calls', null, ENTITLEMENT_VALUE_MAX],
      ['ovdb.cap', null, null],
      ['ovdb.flag', false, null],
    ]);
    await clear(a.orgId);
  });
  it('DB-3: the trigger also guards UPDATE (S4C-1): turning a LIMIT override into a flag is refused', async () => {
    await insertOverride(a.orgId, 'ovdb.cap', { limit: '2' });
    try {
      await rejectsWith(
        inOrg(a.orgId, 'UPDATE org_entitlement_overrides SET flag_value = true'),
        '23514',
        'org_entitlement_overrides_value_ck',
      );
    } finally {
      await clear(a.orgId);
    }
  });
  it('DB-3: both values on an unknown feature id → 23514 one_value_ck (CHECK runs before the FK; the trigger leaves a missing feature to the FK)', async () => {
    await rejectsWith(
      inOrg(
        a.orgId,
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, flag_value, limit_value, reason) VALUES (app_current_org(), -1, true, 1, 'why')`,
      ),
      '23514',
      'org_entitlement_overrides_one_value_ck',
    );
  });
  it('DB-3: an unknown feature id → 23503 feature_fk; an org without an org_entitlements row → 23503 org_fk', async () => {
    await rejectsWith(
      inOrg(
        a.orgId,
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason) VALUES (app_current_org(), -1, 1, 'why')`,
      ),
      '23503',
      'org_entitlement_overrides_feature_fk',
    );
    await rejectsWith(
      insertOverride(bare.orgId, 'ovdb.cap', { limit: '1' }),
      '23503',
      'org_entitlement_overrides_org_fk',
    );
  });
  it('DB-3: a feature or a root row still referenced by an override cannot be deleted (FK RESTRICT → 23001)', async () => {
    await insertOverride(a.orgId, 'ovdb.cap', { limit: '1' });
    try {
      await rejectsWith(
        owner(`DELETE FROM entitlement_features WHERE key = 'ovdb.cap'`),
        '23001',
        'org_entitlement_overrides_feature_fk',
      );
      await rejectsWith(
        inOrg(a.orgId, 'DELETE FROM org_entitlements WHERE org_id = app_current_org()'),
        '23001',
        'org_entitlement_overrides_org_fk',
      );
    } finally {
      await clear(a.orgId);
    }
  });
  it('DB-3 (DB-4 last line): the boilerplate feature files.storage_bytes cannot be deleted while an override references it (23001)', async () => {
    await insertOverride(a.orgId, 'files.storage_bytes', { limit: '10' });
    try {
      await rejectsWith(
        owner(`DELETE FROM entitlement_features WHERE key = 'files.storage_bytes'`),
        '23001',
        'org_entitlement_overrides_feature_fk',
      );
    } finally {
      await clear(a.orgId);
    }
  });
  it.each(['org_id', 'feature_id', 'created_at'])(
    'DB-1: app_user cannot UPDATE %s (column grant → 42501)',
    async (col) => {
      await insertOverride(a.orgId, 'ovdb.cap', { limit: '1' });
      try {
        await rejectsWith(
          inOrg(a.orgId, `UPDATE org_entitlement_overrides SET ${col} = ${col}`),
          '42501',
        );
      } finally {
        await clear(a.orgId);
      }
    },
  );

  describe('DB-2 isolation (criterion 8)', () => {
    beforeAll(async () => {
      await insertOverride(b.orgId, 'ovdb.cap', { limit: '7' });
    });
    afterAll(async () => {
      await clear(b.orgId);
    });
    it('read/update/delete of org B from OrgScope(A) touch 0 rows and leave B unchanged', async () => {
      const before = await readOverrides(b.orgId);
      for (const sql of [
        'SELECT 1 FROM org_entitlement_overrides WHERE org_id = $1',
        'UPDATE org_entitlement_overrides SET limit_value = 8 WHERE org_id = $1',
        'DELETE FROM org_entitlement_overrides WHERE org_id = $1',
      ])
        expect((await inOrg(a.orgId, sql, [b.orgId])).rowCount, sql).toBe(0);
      expect(await readOverrides(b.orgId)).toEqual(before);
    });
    it('INSERT with org_id = B from OrgScope(A) is refused by RLS (42501)', async () => {
      await rejectsWith(
        inOrg(
          a.orgId,
          `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason)
           SELECT $1, id, 1, 'why' FROM entitlement_features WHERE key = 'ovdb.cap'`,
          [b.orgId],
        ),
        '42501',
      );
    });
    it('without an org context the table fails closed (P0001)', async () => {
      await rejectsWith(
        withAppClient((c) => c.query('SELECT 1 FROM org_entitlement_overrides')),
        'P0001',
      );
    });
  });

  it('R-1: a purge without the override statement fails loud (23001); all statements remove everything', async () => {
    const c = await seedOrg();
    await seedOrgEntitlement(c.orgId, 'ovdb_plan');
    await insertOverride(c.orgId, 'ovdb.cap', { limit: '2' });
    await insertOverride(c.orgId, 'ovdb.flag', { flag: 'true' });
    const purge = (statements: readonly string[]) =>
      withAppClient((cl) =>
        inOrgTx(cl, c.orgId, async () => {
          await cl.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org()`,
          );
          for (const sql of statements) await cl.query(sql);
        }),
      );
    await rejectsWith(
      purge([
        'DELETE FROM usage_counters WHERE org_id = app_current_org()',
        'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
        ...ORG_PURGE_STATEMENTS,
      ]),
      '23001',
      'org_entitlement_overrides_org_fk',
    );
    expect(await readOverrides(c.orgId)).toHaveLength(2);
    expect(ENTITLEMENTS_PURGE_STATEMENTS).toEqual([
      'DELETE FROM usage_counters WHERE org_id = app_current_org()',
      'DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org()',
      'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
    ]);
    await purge([...ENTITLEMENTS_PURGE_STATEMENTS, ...ORG_PURGE_STATEMENTS]);
    expect(await readOverrides(c.orgId)).toEqual([]);
    await c.dispose();
  });
});
```
(`it.each` dài dòng là chủ ý: mỗi dòng một ràng buộc, tên constraint là kỳ vọng. Prettier sẽ gãy dòng; giữ nguyên nội dung.)

`test/integration/core/database/normalization-inventory.spec.ts` — thêm sau mục `'public.usage_counters'`:
```ts
  // SP4 4C (spec §7.6): BCNF, khoá ứng viên {org_id, feature_id}; không lặp `kind` (trigger đọc từ entitlement_features).
  'public.org_entitlement_overrides': [
    'org_id',
    'feature_id',
    'flag_value',
    'limit_value',
    'reason',
    'expires_at',
    'created_at',
    'updated_at',
  ],
```

`test/unit/modules/entitlements/errors.spec.ts` — ca `'trigger names map to codes …'` thêm:
```ts
    expect(
      dbErrorMapper(pgError('23514', 'org_entitlement_overrides_value_ck'))
        ?.error.code,
    ).toBe('validation_failed');
```
và ca `'the two VALIDATION_FAILED triggers are registered by name …'` đổi tên thành `'every VALIDATION_FAILED trigger and CHECK of entitlements is registered by name (every unregistered 23514 also maps to validation_failed, so the mapping alone proves nothing)'`, mảng tên thành:
```ts
    for (const name of [
      'org_entitlements_billing_seq_monotonic',
      'usage_counters_period_ck',
      'org_entitlement_overrides_value_ck',
      'org_entitlement_overrides_expiry_ck',
    ])
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements/overrides-db.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/core/database/rls-catalog.spec.ts
pnpm vitest run --project unit test/unit/modules/entitlements/errors.spec.ts
```
Expected: FAIL — `relation "org_entitlement_overrides" does not exist`; `rls-catalog` đỏ ở ca policy của bảng entitlements (bảng 4C chưa có); `errors.spec` đỏ (`org_entitlement_overrides_value_ck` chưa được đăng ký: `defineConstraintErrors` không ném).

- [ ] **Step 4: Sinh migration và viết `up`**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/entitlements --name overrides`

`src/migrations/entitlements/Migration<ts>_overrides.ts` (giữ tên class và `name` CLI sinh; thay thân):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 4C (spec SP4 §7.4, §7.7 dòng `…_overrides`).
 *
 * Bảng chuẩn hoá (spec §7.6):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_entitlement_overrides | {org_id, feature_id} | — | BCNF (`kind` không lặp vào bảng: trigger đọc từ `entitlement_features`) |
 * Không phi chuẩn hoá. Không `version` riêng: override thuộc aggregate `org_entitlements` (mọi ghi khoá dòng gốc và tăng
 * `org_entitlements.version` cùng transaction).
 *
 * Index (mỗi cái một query): PK `(org_id, feature_id)` → LEFT JOIN của câu snapshot (quét theo `org_id`), upsert/xoá của
 * admin, danh sách override của view admin; `org_entitlement_overrides_feature_idx (feature_id)` → kiểm FK RESTRICT khi
 * migration xoá tính năng (FK từ bảng global, ngoại lệ có tên B6 của SP3: không bắt đầu bằng `org_id`).
 *
 * Trigger INVOKER (`SET search_path = pg_catalog, public`): chỉ đọc NEW và bảng global `entitlement_features` (không RLS,
 * app_user có SELECT), không hoãn. Không tạo hàm SECURITY DEFINER nào. `minimum` của tính năng chỉ ở code (S4-D2).
 *
 * `org_entitlement_overrides_expiry_ck` (lệch có chủ đích so với §7.4, plan 4C Task 2): mọi ghi đặt
 * `updated_at = clock_timestamp()`, nên "override không bao giờ được ghi khi đã hết hạn" là bất biến của dòng.
 *
 * Khoá (giữ tới hết lô): bảng mới; `SHARE ROW EXCLUSIVE` trên `org_entitlements` và `entitlement_features` (REFERENCES):
 * chặn ghi hai bảng đó trong lô (đổi gói, tạo org); đọc không bị chặn.
 */
export class Migration<ts>_overrides extends Migration {
  override name = 'Migration<ts>_overrides';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_entitlement_overrides (
    org_id UUID NOT NULL,
    feature_id BIGINT NOT NULL,
    flag_value BOOLEAN NULL,
    limit_value BIGINT NULL,
    reason TEXT NOT NULL,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_entitlement_overrides_pkey PRIMARY KEY (org_id, feature_id),
    CONSTRAINT org_entitlement_overrides_org_fk FOREIGN KEY (org_id) REFERENCES org_entitlements (org_id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlement_overrides_feature_fk FOREIGN KEY (feature_id) REFERENCES entitlement_features (id) ON DELETE RESTRICT,
    CONSTRAINT org_entitlement_overrides_limit_ck CHECK (limit_value BETWEEN 0 AND 9007199254740991),
    CONSTRAINT org_entitlement_overrides_reason_ck CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
    CONSTRAINT org_entitlement_overrides_one_value_ck CHECK (num_nonnulls(flag_value, limit_value) <= 1),
    CONSTRAINT org_entitlement_overrides_expiry_ck CHECK (expires_at IS NULL OR expires_at > updated_at));`);
    this.addSql(
      `CREATE INDEX org_entitlement_overrides_feature_idx ON org_entitlement_overrides (feature_id);`,
    );
    this.addSql(
      `ALTER TABLE org_entitlement_overrides ENABLE ROW LEVEL SECURITY;`,
    );
    this.addSql(`ALTER TABLE org_entitlement_overrides FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY org_entitlement_overrides_tenant ON org_entitlement_overrides TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON org_entitlement_overrides TO app_user;`,
    );
    // `ON CONFLICT … DO UPDATE` cần UPDATE trên đúng các cột nó ghi; khoá tự nhiên và created_at không sửa được.
    this.addSql(
      `GRANT UPDATE (flag_value, limit_value, reason, expires_at, updated_at) ON org_entitlement_overrides TO app_user;`,
    );
    // Spec §7.4: giá trị đúng `kind` của tính năng, tính năng chưa deprecated. Chạy ở BEFORE INSERT (dòng đề xuất) và
    // BEFORE UPDATE (dòng sau SET của nhánh DO UPDATE, spike S4C-1). Tính năng không tồn tại: để FK báo 23503.
    this
      .addSql(`CREATE FUNCTION entitlements_override_value_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE f record;
BEGIN
  SELECT kind, deprecated_at INTO f FROM public.entitlement_features WHERE id = NEW.feature_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF f.deprecated_at IS NOT NULL
     OR (f.kind = 'FLAG' AND (NEW.flag_value IS NULL OR NEW.limit_value IS NOT NULL))
     OR (f.kind <> 'FLAG' AND NEW.flag_value IS NOT NULL) THEN
    RAISE EXCEPTION 'an override needs an active feature and a value of its kind'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_entitlement_overrides_value_ck';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER org_entitlement_overrides_value_ck BEFORE INSERT OR UPDATE ON org_entitlement_overrides
    FOR EACH ROW EXECUTE FUNCTION entitlements_override_value_ck();`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.entitlements_override_value_ck() FROM PUBLIC;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE org_entitlement_overrides;`);
    this.addSql(`DROP FUNCTION entitlements_override_value_ck();`);
  }
}
```
(`down` tạm thời; Task 3 thay bằng `down` từ chối khi còn override.)

- [ ] **Step 5: Purge và đăng ký lỗi**

`src/modules/entitlements/infra/sql/entitlements-purge.sql.ts` — thay chú thích "4C chèn `org_entitlement_overrides` giữa hai câu" bằng "4C: `org_entitlement_overrides` giữa hai câu" và mảng thành:
```ts
export const ENTITLEMENTS_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM usage_counters WHERE org_id = app_current_org()',
  'DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org()',
  'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
];
```

`src/modules/entitlements/errors.ts` — chú thích của `defineConstraintErrors` thành `/** Tên trigger/CHECK (migration entitlements_core, usage_counters, overrides) → mã; tên không bao giờ ra client. Trigger seq và trigger kỳ chỉ bắn khi code sai (log ERROR ở service); trigger giá trị và CHECK hết hạn của override là lớp chặn cuối sau kiểm của Overrides. */` và khối:
```ts
defineConstraintErrors({
  org_entitlements_plan_not_retired: EntitlementsErrors.PLAN_RETIRED,
  org_entitlements_billing_seq_monotonic: CoreErrors.VALIDATION_FAILED,
  usage_counters_period_ck: CoreErrors.VALIDATION_FAILED,
  org_entitlement_overrides_value_ck: CoreErrors.VALIDATION_FAILED,
  org_entitlement_overrides_expiry_ck: CoreErrors.VALIDATION_FAILED,
});
```

- [ ] **Step 6: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements/overrides-db.spec.ts test/integration/entitlements/usage-counters-db.spec.ts test/integration/entitlements/schema.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/migrations.spec.ts
pnpm vitest run --project unit test/unit/modules/entitlements/errors.spec.ts test/unit/migrations
```
Expected: PASS. `usage-counters-db.spec.ts` R-1 vẫn xanh (câu override mới trong `ENTITLEMENTS_PURGE_STATEMENTS` không chạm dòng nào); `rls-catalog.spec.ts` xanh: bảng mới FORCE + policy `TO app_user`, M5/B5 neo bắc cầu qua `org_entitlements`, tập definer không đổi; `migration-scan.spec.ts` xanh (hàm `up` tạo được `down` xoá); `migration-order.spec.ts` xanh (timestamp mới hơn `20261005164759`).

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/migrations/entitlements src/modules/entitlements test/support test/integration/entitlements/overrides-db.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/unit/modules/entitlements/errors.spec.ts
git add src/migrations/entitlements src/modules/entitlements test/support test/integration/entitlements/overrides-db.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/unit/modules/entitlements/errors.spec.ts
git commit -m "feat(entitlements): org_entitlement_overrides table with RLS, an INVOKER value trigger, an expiry CHECK and the purge statement"
```

---

### Task 3: `down` của `org_entitlement_overrides` từ chối khi còn override (không mất quyết định của nhân viên âm thầm), nguyên tử với ghi đang bay; DB-4 ca (d) mang từ 4B

Spec §7.7 ghi `down` = `DROP TABLE; DROP FUNCTION`. Override là quyết định của nhân viên kèm lý do, không dẫn xuất lại được: `DROP` âm thầm xoá mọi ưu đãi đang chạy. 4C theo cùng luật "down khi có dữ liệu chặn → lỗi rõ ràng" của SP3 §6.13 mà `down` của `…_usage_counters` (4B) và `…_starter_plans` (4A) đã theo: còn dòng nào → `RAISE`, DB không đổi. Lệch có chủ đích so với §7.7, sửa spec ở Task 15.

**DB-4 ca (d) (mang từ 4B Task 4 Step 4):** spec §7.7/DB-4 nói `down` của 4B "fail to `23001` khi còn override trên `files.storage_bytes`". Migrator lùi theo thứ tự ngược, nên `down` của `…_overrides` (timestamp lớn hơn) luôn chạy **trước** `down` của `…_usage_counters`: với `down` của 4C từ chối khi còn override, chuỗi lùi về trước `…_usage_counters` dừng ngay ở bước 4C, và FK `RESTRICT` mà chú thích `down` của 4B nhắc tới là lớp chặn cuối (Task 2 đã kiểm `23001` trên `files.storage_bytes`). Ca (d) dưới đây khẳng định đúng hành vi thật đó trên chuỗi migration thật: override trên `files.storage_bytes` chặn việc lùi `…_usage_counters`, DB không đổi; xoá override thì lùi được. Không sửa migration của 4B (đã ship; chú thích của nó vẫn đúng: "runbook xoá override trước").

**Files:**
- Modify: `src/migrations/entitlements/Migration<ts>_overrides.ts` (`down`)
- Create (test): `test/integration/entitlements/overrides-down.spec.ts`

**Interfaces:**
- Consumes: migration của Task 2; `runMigrations`, `type MigrationObject` (`src/core/database/index.ts`); `applyTestEnv` (`test/support/app-factory.ts`); `coreMigrationList` (`test/support/migrate-test-db.ts`); `createScratchDb`, `type ScratchDb` (`test/support/scratch-db.ts`, `client(role: 'owner' | 'app' | 'auth')`); `seedOrgEntitlement`, `seedOverride`, `readOverrides` (Task 2), `seedOrg`, `withAppClient`, `inOrgTx`.
- Produces: `down` của `…_overrides`: `NO FORCE` (khoá `ACCESS EXCLUSIVE` tới hết lô) → `RAISE 'org entitlement overrides hold staff decisions; …'` nếu còn dòng → `DROP TABLE` → `DROP FUNCTION` → khối khẳng định FORCE (chuỗi `a tenant table lost FORCE ROW LEVEL SECURITY`, luật `migration-scan.spec.ts`).

- [ ] **Step 1: Viết test (đỏ)**

`test/integration/entitlements/overrides-down.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  readOverrides,
  seedOrgEntitlement,
  seedOverride,
} from '../../support/entitlements-seed.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const POLL_MS = 20;
const LOCK_DEADLINE_MS = 8_000;
const REFUSAL = /org entitlement overrides hold staff decisions/;

/**
 * DB-4 (spec SP4 §7.7) cho migration 4C, trên database riêng (down để lại schema khác DB dùng chung). Danh sách migration
 * cắt tới `…_overrides`, để down chỉ lùi đúng các migration của SP4 dù sau này có migration mới hơn.
 */
describe('org_entitlement_overrides down refuses to drop staff decisions (spec SP4 §7.7, DB-4)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let beforeOverrides: string;
  let beforeCounters: string;
  let org: SeededOrg;
  const catalogState = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{
          overrides: string | null;
          counters: string | null;
          fn: string | null;
          storage: number;
          force: boolean | null;
        }>(
          `SELECT to_regclass('public.org_entitlement_overrides')::text AS overrides,
                  to_regclass('public.usage_counters')::text AS counters,
                  to_regprocedure('public.entitlements_override_value_ck()')::text AS fn,
                  (SELECT count(*)::int FROM entitlement_features WHERE key = 'files.storage_bytes') AS storage,
                  (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.org_entitlement_overrides')) AS force`,
        )
      ).rows[0];
    } finally {
      await c.end();
    }
  };
  const down = (to: string) =>
    runMigrations('down', { source: { kind: 'list', list }, to });
  const up = () => runMigrations('up', { source: { kind: 'list', list } });
  const clearOverrides = () =>
    withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, () =>
          c.query('DELETE FROM org_entitlement_overrides'),
        ),
      db.name,
    );
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('ovdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_overrides'));
    const counters = all.findIndex((m) => m.name.endsWith('_usage_counters'));
    if (at < 1 || counters < 1 || counters > at)
      throw new Error('overrides or usage_counters migration not found in order');
    list = all.slice(0, at + 1);
    beforeOverrides = all[at - 1]!.name;
    beforeCounters = all[counters - 1]!.name;
    await up();
    org = await seedOrg({ database: db.name });
    await seedOrgEntitlement(org.orgId, 'free', {}, db.name);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) down refuses while an override exists; the table, the function, FORCE and the override stay', async () => {
    await seedOverride(org.orgId, 'tenancy.seats', { value: { limit: 4 } }, db.name);
    await expect(down(beforeOverrides)).rejects.toThrow(REFUSAL);
    expect(await catalogState()).toMatchObject({
      overrides: 'org_entitlement_overrides',
      fn: 'entitlements_override_value_ck()',
      force: true,
    });
    expect((await readOverrides(org.orgId, db.name)).map((r) => r.limitValue)).toEqual([4]);
  });
  it('(b) atomic: an override committed while the down waits on the table lock is seen, and the down refuses', async () => {
    await clearOverrides();
    const writer = await db.client('app');
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      await writer.query(
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason)
         SELECT app_current_org(), id, 2, 'in flight' FROM entitlement_features WHERE key = 'tenancy.seats'`,
      );
      const pending = down(beforeOverrides);
      pending.catch(() => undefined);
      const watcher = await db.client('owner');
      try {
        const until = Date.now() + LOCK_DEADLINE_MS;
        for (;;) {
          const { rows } = await watcher.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.relation = to_regclass('public.org_entitlement_overrides')`,
          );
          if ((rows[0]?.n ?? 0) > 0) break;
          if (Date.now() > until)
            throw new Error('the down never waited on the org_entitlement_overrides lock');
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } finally {
        await watcher.end();
      }
      await writer.query('COMMIT');
      await expect(pending).rejects.toThrow(REFUSAL);
    } finally {
      await writer.end();
    }
    expect((await readOverrides(org.orgId, db.name)).map((r) => r.limitValue)).toEqual([2]);
  });
  it('(c) with no override left the down drops the table and the function; up restores them', async () => {
    await clearOverrides();
    await expect(down(beforeOverrides)).resolves.toEqual([list.at(-1)!.name]);
    expect(await catalogState()).toMatchObject({ overrides: null, fn: null, force: null });
    await up();
    expect(await catalogState()).toMatchObject({
      overrides: 'org_entitlement_overrides',
      fn: 'entitlements_override_value_ck()',
      force: true,
    });
  });
  it('(d) carried from 4B: an override on files.storage_bytes blocks reverting usage_counters; nothing changes; without it the chain reverts and up restores', async () => {
    await seedOverride(org.orgId, 'files.storage_bytes', { value: { limit: 10 } }, db.name);
    await expect(down(beforeCounters)).rejects.toThrow(REFUSAL);
    expect(await catalogState()).toEqual({
      overrides: 'org_entitlement_overrides',
      counters: 'usage_counters',
      fn: 'entitlements_override_value_ck()',
      storage: 1,
      force: true,
    });
    expect((await readOverrides(org.orgId, db.name)).map((r) => r.feature)).toEqual([
      'files.storage_bytes',
    ]);
    await clearOverrides();
    await down(beforeCounters);
    expect(await catalogState()).toEqual({
      overrides: null,
      counters: null,
      fn: null,
      storage: 0,
      force: null,
    });
    await up();
    expect(await catalogState()).toMatchObject({
      overrides: 'org_entitlement_overrides',
      counters: 'usage_counters',
      storage: 1,
      force: true,
    });
  });
});
```

- [ ] **Step 2: Chạy cho thấy đỏ**

Run: `pnpm vitest run --project integration test/integration/entitlements/overrides-down.spec.ts`
Expected: FAIL ở (a), (b), (d): `down` của Task 2 xanh dù còn override (`resolves`), bảng biến mất.

- [ ] **Step 3: Viết `down` có từ chối**

`src/migrations/entitlements/Migration<ts>_overrides.ts` — thay `down()`:
```ts
  override down(): void | Promise<void> {
    // Dưới FORCE, app_owner không có policy nên thấy 0 dòng: bỏ FORCE để câu kiểm thấy thật. ALTER TABLE lấy ACCESS
    // EXCLUSIVE giữ tới hết lô, nên không ghi override nào chen vào giữa câu kiểm và DROP (ghi đang mở thì down chờ nó).
    // RAISE → cả lô rollback, FORCE còn nguyên. Đây cũng là chỗ chặn ca DB-4 (d): lùi `…_usage_counters` khi còn override
    // trên `files.storage_bytes` dừng ở bước này (migrator lùi migration mới nhất trước).
    this.addSql(
      `ALTER TABLE public.org_entitlement_overrides NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_entitlement_overrides) THEN
    RAISE EXCEPTION 'org entitlement overrides hold staff decisions; reverting org_entitlement_overrides would drop every override';
  END IF;
END $$;`);
    this.addSql(`DROP TABLE org_entitlement_overrides;`);
    this.addSql(`DROP FUNCTION entitlements_override_value_ck();`);
    // Bước 7 của mẫu SP3 §8.8 (`migration-scan.spec.ts` đòi khối này sau `NO FORCE` cuối cùng): không bảng tenant nào còn
    // lại mà mất FORCE.
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
```
Thêm vào chú thích đầu file một dòng: ` * Down: từ chối khi còn override (quyết định của nhân viên không dẫn xuất lại được; lệch có chủ đích so với §7.7, SP3 §6.13 "down khi có dữ liệu chặn"); chặn luôn việc lùi …_usage_counters khi còn override trên files.storage_bytes (DB-4 (d)).`

- [ ] **Step 4: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements/overrides-down.spec.ts test/integration/entitlements/usage-counters-down.spec.ts test/integration/core/database/migrations.spec.ts
pnpm vitest run --project unit test/unit/migrations
```
Expected: PASS. `usage-counters-down.spec.ts` (4B) vẫn xanh: danh sách của nó cắt tới `…_usage_counters`, không chứa migration 4C. `migrations.spec.ts` (up → down → up, sweep S2-R57 từng bước trên DB rỗng) xanh: bảng rỗng nên `down` đi tiếp. `migration-scan.spec.ts` xanh (khối khẳng định sau `NO FORCE`).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/migrations/entitlements test/integration/entitlements/overrides-down.spec.ts
git add src/migrations/entitlements test/integration/entitlements/overrides-down.spec.ts
git commit -m "feat(entitlements): the overrides down refuses while staff overrides exist, which also blocks reverting usage_counters (DB-4 d)"
```

---
## Phần C — Đánh giá có override (spec §8.4, §9.6, §12.1; mục mang từ 4B)

### Task 4: Câu snapshot thêm override còn hạn; `Entitlements` áp `OVERRIDE > PLAN > FALLBACK`; override của tính năng pod không biết bị bỏ qua với một WARN; EXPLAIN 10 000 org × 5 override

**Files:**
- Modify: `src/modules/entitlements/ports/org-entitlement.repository.ts`, `src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts`, `src/modules/entitlements/application/entitlements.service.ts`
- Modify (test): `test/unit/modules/entitlements/entitlements-service.spec.ts`, `test/unit/modules/entitlements/schemas.spec.ts`, `test/integration/entitlements/snapshot-repository.spec.ts`, `test/integration/entitlements/entitlements-service.spec.ts`, `test/integration/entitlements/snapshot-explain.spec.ts`

**Interfaces:**
- Consumes: `resolveEffective(feature, planValue, override, now)`, `type OverrideInput` (`domain/effective-value.ts`, 4A: override cấu trúc `{ flagValue, limitValue, expiresAt }`, tự bỏ override hết hạn bằng `overrideStatus`); `EntitlementCatalogueRegistry.features()`; `seedOverride` (Task 2); `seedFeatures`, `seedPlans`, `seedOrgEntitlement`.
- Produces:
  - `type SnapshotOverride = { featureKey: string; flagValue: boolean | null; limitValue: number | null; expiresAt: Date | null }`; `SnapshotRow.overrides: readonly SnapshotOverride[]` (chỉ override còn hạn, sắp theo key).
  - `SNAPSHOT_SQL` (export giữ tên): `LEFT JOIN org_entitlement_overrides o ON o.org_id = e.org_id AND (o.expires_at IS NULL OR o.expires_at > now())` + `LEFT JOIN entitlement_features f ON f.id = o.feature_id`, `ORDER BY f.key`.
  - `EntitlementSnapshot.overrides: ReadonlyMap<string, { readonly expiresAt: Date | null }>` — override còn hạn **đang thắng** (`source: 'OVERRIDE'`), theo key; Task 5 và Task 9 đọc nó cho `overrideExpiresAt`.
  - log WARN `{ event: 'entitlements_unknown_override_feature', feature }` một lần mỗi key mỗi process.

- [ ] **Step 1: Viết test unit (đỏ)**

`test/unit/modules/entitlements/entitlements-service.spec.ts`:
- import thêm: `Logger` (cạnh `Injectable` từ `@nestjs/common`), `vi` (từ `vitest`), `type SnapshotOverride` (cạnh `type SnapshotRow`);
- hàm `row` thành:
```ts
const row = (
  planKey: string,
  overrides: readonly SnapshotOverride[] = [],
): SnapshotRow => ({
  version: 1,
  planKey,
  planSource: 'DEFAULT',
  planAssignedAt: new Date(),
  now: new Date(),
  overrides,
});
```
- thêm hai ca cuối `describe`:
```ts
  it('4C: an active override wins over the plan and is listed in snapshot.overrides; one at its expiry instant is ignored (boundary >)', async () => {
    const now = new Date('2026-10-07T00:00:00.000Z');
    const until = new Date('2026-11-01T00:00:00.000Z');
    state.orgId = ORG;
    state.row = {
      ...row('pro', [
        { featureKey: 'x.flag', flagValue: false, limitValue: null, expiresAt: until },
        { featureKey: 'x.seats', flagValue: null, limitValue: 3, expiresAt: now },
      ]),
      now,
    };
    const s = await svc.snapshot();
    expect(s.features.get('x.flag')).toEqual({
      kind: 'FLAG',
      enabled: false,
      source: 'OVERRIDE',
    });
    expect(s.features.get('x.seats')).toEqual({
      kind: 'LIMIT',
      limit: { kind: 'UNLIMITED' },
      source: 'PLAN',
    });
    expect([...s.overrides]).toEqual([['x.flag', { expiresAt: until }]]);
  });
  it('Review Focus 3: an override of a feature unknown to this pod is ignored with one warning per key and process', async () => {
    state.orgId = ORG;
    state.row = row('free', [
      { featureKey: 'x.ghost', flagValue: true, limitValue: null, expiresAt: null },
    ]);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const s = await svc.snapshot();
      await svc.snapshot();
      expect([s.features.has('x.ghost'), s.overrides.size]).toEqual([false, 0]);
      expect(
        warn.mock.calls.filter(
          ([o]) =>
            Reflect.get(Object(o), 'event') ===
            'entitlements_unknown_override_feature',
        ),
      ).toEqual([
        [
          { event: 'entitlements_unknown_override_feature', feature: 'x.ghost' },
          expect.any(String),
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
```

`test/unit/modules/entitlements/schemas.spec.ts` — hằng `snapshot` thêm trường cuối `overrides: new Map(),` (chưa có override; Task 5 thêm ca có override).

- [ ] **Step 2: Viết test integration (đỏ)**

`test/integration/entitlements/snapshot-repository.spec.ts`:
- import thêm `Db` (cạnh `DatabaseModule, OrgScope, UnitOfWork`), `seedFeatures`, `seedOverride` (cạnh `seedOrgEntitlement, seedPlans`);
- `let disposeFeatures: () => Promise<void>;` cạnh `disposePlans`; trong `beforeAll`, trước `disposePlans = …`:
```ts
    disposeFeatures = await seedFeatures([
      { key: 'snap.a', kind: 'FLAG', resetPeriod: null, deprecated: false },
      { key: 'snap.b', kind: 'LIMIT', resetPeriod: null, deprecated: false },
      { key: 'snap.c', kind: 'LIMIT', resetPeriod: null, deprecated: false },
    ]);
```
- trong `afterAll`, sau `await b?.dispose();` thêm `await disposeFeatures?.();` (org dispose trước: purge xoá override, FK `RESTRICT`);
- ca đầu thêm khẳng định `expect(s?.overrides).toEqual([]);`;
- thêm hai ca:
```ts
  it('4C: reads only the active overrides of the org, sorted by feature key, as parsed types (one row per override)', async () => {
    await seedOverride(a.orgId, 'snap.b', { value: { limit: 2 }, expiresInSec: 3600 });
    await seedOverride(a.orgId, 'snap.a', { value: { enabled: true } });
    await seedOverride(a.orgId, 'snap.c', { value: { limit: 1 }, expiresInSec: -60 });
    const s = await read(a.orgId);
    expect(
      s?.overrides.map((o) => [o.featureKey, o.flagValue, o.limitValue, o.expiresAt instanceof Date]),
    ).toEqual([
      ['snap.a', true, null, false],
      ['snap.b', null, 2, true],
    ]);
    expect(s?.version).toBe(1);
    expect(await read(b.orgId)).toBeUndefined();
  });
  it('4C boundary (SQL): in one transaction an override expiring exactly at now() is gone and one at now() + 1 µs is active', async () => {
    const s = await app.get(OrgScope).run(a.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        const db = app.get(Db);
        await db.execute(
          `DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org()`,
        );
        await db.execute(
          `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason, expires_at, updated_at)
           SELECT app_current_org(), f.id, 1, 'boundary',
                  CASE f.key WHEN 'snap.b' THEN now() ELSE now() + interval '1 microsecond' END,
                  now() - interval '1 second'
           FROM entitlement_features f WHERE f.key IN ('snap.b', 'snap.c')`,
        );
        return app.get(SqlOrgEntitlementRepository).readSnapshot();
      }),
    );
    expect(s?.overrides.map((o) => o.featureKey)).toEqual(['snap.c']);
  });
```

`test/integration/entitlements/entitlements-service.spec.ts` — import thêm `seedOverride`; thêm ca:
```ts
  it('4C: overrides through SQL — a FLAG turned off, a LIMIT capped until a date, a QUOTA made unlimited — win over the plan', async () => {
    const o = await orgOn('pro');
    await seedOverride(o.orgId, 'fixture.reports', { value: { enabled: false } });
    await seedOverride(o.orgId, 'tenancy.seats', { value: { limit: 3 }, expiresInSec: 3600 });
    await seedOverride(o.orgId, 'fixture.api_calls', { value: { limit: null } });
    const s = await inOrg(o.orgId, () => svc().snapshot());
    expect(s.features.get('fixture.reports')).toEqual({
      kind: 'FLAG',
      enabled: false,
      source: 'OVERRIDE',
    });
    expect(s.features.get('tenancy.seats')).toEqual({
      kind: 'LIMIT',
      limit: { kind: 'MAX', max: 3 },
      source: 'OVERRIDE',
    });
    expect(s.features.get('fixture.api_calls')).toEqual({
      kind: 'QUOTA',
      limit: { kind: 'UNLIMITED' },
      resetPeriod: 'MONTH',
      source: 'OVERRIDE',
    });
    expect(s.features.get('fixture.exports')).toEqual({
      kind: 'FLAG',
      enabled: false,
      source: 'PLAN',
    });
    expect([...s.overrides.keys()].sort()).toEqual([
      'fixture.api_calls',
      'fixture.reports',
      'tenancy.seats',
    ]);
    expect(s.overrides.get('tenancy.seats')?.expiresAt).toBeInstanceOf(Date);
    expect(s.overrides.get('fixture.reports')?.expiresAt).toBeNull();
  });
```

`test/integration/entitlements/snapshot-explain.spec.ts`:
- hằng mới `const OVERRIDES_PER_ORG = 5;`; `FORCED` thêm `'org_entitlement_overrides'` cuối mảng;
- sau vòng `for (const t of FORCED) … NO FORCE` và trước vòng lô, thêm:
```ts
    await owner.query(
      `INSERT INTO entitlement_features (key, kind) SELECT 'load.f' || g, 'LIMIT' FROM generate_series(1, ${OVERRIDES_PER_ORG}) g`,
    );
```
- trong mỗi lô, sau câu `INSERT INTO org_entitlements …` và trước `COMMIT`:
```ts
      await owner.query(
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason)
         SELECT o.id, f.id, 1, 'load' FROM organizations o CROSS JOIN entitlement_features f
         WHERE f.key LIKE 'load.f%' AND NOT EXISTS (SELECT 1 FROM org_entitlement_overrides x WHERE x.org_id = o.id)`,
      );
```
- mô tả `describe`/`it` thêm "× 5 overrides"; trong ca, sau `const all = nodes(plan.Plan);` thêm:
```ts
    expect(
      all.filter(
        (n) =>
          n['Node Type'] === 'Seq Scan' &&
          n['Relation Name'] === 'org_entitlement_overrides',
      ),
    ).toEqual([]);
    expect(all.map((n) => n['Index Name'])).toContain(
      'org_entitlement_overrides_pkey',
    );
```
- trước `await app.query('ROLLBACK');` thêm khẳng định số dòng của câu thật:
```ts
    expect((await app.query(SNAPSHOT_SQL)).rowCount).toBe(OVERRIDES_PER_ORG);
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/entitlements-service.spec.ts test/unit/modules/entitlements/schemas.spec.ts
pnpm vitest run --project integration test/integration/entitlements/snapshot-repository.spec.ts test/integration/entitlements/entitlements-service.spec.ts test/integration/entitlements/snapshot-explain.spec.ts
```
Expected: FAIL — `pnpm typecheck` của test báo `overrides` không có trong `SnapshotRow`/`EntitlementSnapshot`; snapshot chưa đọc override (`overrides` `undefined`, nguồn vẫn `PLAN`); EXPLAIN chưa chạm bảng override (thiếu `org_entitlement_overrides_pkey`).

- [ ] **Step 4: Port và repository**

`src/modules/entitlements/ports/org-entitlement.repository.ts` — thay chú thích và kiểu `SnapshotRow`:
```ts
/** Override còn hạn của org trong câu snapshot (spec §8.4, 4C): hết hạn đã lọc ở SQL bằng `expires_at > now()`. */
export type SnapshotOverride = {
  featureKey: string;
  flagValue: boolean | null;
  limitValue: number | null;
  expiresAt: Date | null;
};
/** Một dòng `org_entitlements` + key gói + `now()` của DB (mốc hết hạn override) + override còn hạn, sắp theo key. */
export type SnapshotRow = {
  version: number;
  planKey: string;
  planSource: PlanSource;
  planAssignedAt: Date;
  now: Date;
  overrides: readonly SnapshotOverride[];
};
```

`src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts`:
- import thêm `type SnapshotOverride`;
- thay `SNAPSHOT_SQL`, `SnapshotRaw` và `readSnapshot`:
```ts
/**
 * Câu snapshot (spec §8.4): một dòng mỗi override còn hạn, hoặc một dòng với cột override NULL khi không có. Index: PK
 * `org_entitlements`, PK `plans`, PK override (quét theo `org_id`), PK `entitlement_features` (EXPLAIN ở
 * `snapshot-explain.spec.ts`). `now()` là giờ bắt đầu transaction: mọi câu của một transaction thấy cùng trạng thái hết
 * hạn (E-12).
 */
export const SNAPSHOT_SQL = `SELECT e.version, p.key AS plan_key, e.plan_source, e.plan_assigned_at, now() AS now,
       f.key AS override_feature, o.flag_value, o.limit_value::text AS limit_value, o.expires_at
FROM org_entitlements e
JOIN plans p ON p.id = e.plan_id
LEFT JOIN org_entitlement_overrides o
       ON o.org_id = e.org_id AND (o.expires_at IS NULL OR o.expires_at > now())
LEFT JOIN entitlement_features f ON f.id = o.feature_id
WHERE e.org_id = app_current_org()
ORDER BY f.key`;
/** `Db.execute` trả TIMESTAMPTZ dạng chuỗi (bài học 3A): `z.coerce.date()`; BIGINT qua `::text`. */
const SnapshotRaw = z.object({
  version: z.coerce.number().int().min(1),
  plan_key: z.string(),
  plan_source: z.enum(PLAN_SOURCES),
  plan_assigned_at: z.coerce.date(),
  now: z.coerce.date(),
  override_feature: z.string().nullable(),
  flag_value: z.boolean().nullable(),
  limit_value: z.string().nullable(),
  expires_at: z.coerce.date().nullable(),
});
```
```ts
  async readSnapshot(): Promise<SnapshotRow | undefined> {
    const rows = (await this.db.execute(SNAPSHOT_SQL)).map((r) =>
      SnapshotRaw.parse(r),
    );
    const [first] = rows;
    if (!first) return undefined;
    const overrides: SnapshotOverride[] = [];
    for (const r of rows) {
      if (r.version !== first.version || r.plan_key !== first.plan_key)
        throw new Error(
          'entitlement snapshot rows disagree on the org_entitlements row (org_entitlements PK violated?)',
        );
      if (r.override_feature === null) {
        if (rows.length > 1)
          throw new Error(
            'entitlement snapshot returned an override without a feature (FK org_entitlement_overrides.feature_id violated?)',
          );
        continue;
      }
      overrides.push({
        featureKey: r.override_feature,
        flagValue: r.flag_value,
        limitValue: r.limit_value === null ? null : Number(r.limit_value),
        expiresAt: r.expires_at,
      });
    }
    return {
      version: first.version,
      planKey: first.plan_key,
      planSource: first.plan_source,
      planAssignedAt: first.plan_assigned_at,
      now: first.now,
      overrides,
    };
  }
```

- [ ] **Step 5: `Entitlements` áp override**

`src/modules/entitlements/application/entitlements.service.ts`:
- import thêm `type SnapshotOverride` (cạnh `OrgEntitlementRepository`);
- `EntitlementSnapshot` thêm trường cuối:
```ts
  /** Override còn hạn đang thắng (`source: 'OVERRIDE'`), theo key (4C); `expiresAt: null` = vĩnh viễn. */
  readonly overrides: ReadonlyMap<string, { readonly expiresAt: Date | null }>;
```
- field mới của class, cạnh `logger`:
```ts
  /** R-X30 + luật R-X26: key override pod này không biết được báo MỘT lần mỗi process, không mỗi request. */
  private readonly warnedOverrideKeys = new Set<string>();
```
- trong `read()`, thay khối từ `const features = new Map<string, EffectiveValue>();` tới hết `return { … }` bằng:
```ts
    const known = this.registry.features();
    const byKey = new Map<string, SnapshotOverride>();
    for (const o of row.overrides) {
      if (known.has(o.featureKey)) byKey.set(o.featureKey, o);
      else this.warnUnknownOverride(o.featureKey);
    }
    const features = new Map<string, EffectiveValue>();
    const overrides = new Map<string, { readonly expiresAt: Date | null }>();
    for (const f of known.values()) {
      const o = byKey.get(f.key);
      const v = resolveEffective(f, plan.values.get(f.key), o, row.now);
      features.set(f.key, v);
      if (o && v.source === 'OVERRIDE')
        overrides.set(f.key, { expiresAt: o.expiresAt });
    }
    return {
      version: row.version,
      plan: {
        key: plan.key,
        source: row.planSource,
        assignedAt: row.planAssignedAt,
      },
      features,
      overrides,
    };
  }

  /** Override cho key không có trong catalogue gộp (DB mới hơn code, R-X30): pod không kiểm tính năng đó nên bỏ qua là đúng. */
  private warnUnknownOverride(key: string): void {
    if (this.warnedOverrideKeys.has(key)) return;
    this.warnedOverrideKeys.add(key);
    this.logger.warn(
      { event: 'entitlements_unknown_override_feature', feature: key },
      'an override names a feature this pod does not know; it is ignored',
    );
  }
```
(Giữ `}` đóng của `read()` đúng một lần: khối trên đã đóng `read()` rồi mở `warnUnknownOverride`; xoá `}` cũ của `read()`.)

- [ ] **Step 6: Chạy lại cho thấy xanh**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm vitest run --project integration test/integration/entitlements/snapshot-repository.spec.ts test/integration/entitlements/entitlements-service.spec.ts test/integration/entitlements/snapshot-explain.spec.ts test/integration/entitlements/quotas.spec.ts test/e2e/entitlements/org-entitlements.e2e.spec.ts
```
Expected: PASS. EXPLAIN in ra plan có `Index Scan using org_entitlement_overrides_pkey` (dán đoạn in vào báo cáo task). `quotas.spec.ts` và `org-entitlements.e2e.spec.ts` (4B) xanh không đổi: không org nào của chúng có override.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements
git add src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements
git commit -m "feat(entitlements): the snapshot reads active overrides so OVERRIDE > PLAN > FALLBACK holds everywhere; unknown override features warn once"
```

---

### Task 5: Người đọc của 4B và API tenant thấy override; hết hạn suy ra lúc đọc trên đường quota và ghế (mục mang từ 4B); HT-2b

Mục mang từ 4B: chú thích adapter ghế ghi "OVERRIDE (4C) > PLAN > FALLBACK; hôm nay `resolveEffective` chưa nhận override nào". Task 4 làm điều đó thành thật cho **mọi** người đọc snapshot. Cách 4B thấy override hết hạn (phán quyết): **suy ra lúc đọc, không sweep**. `Quotas.consume` và `MemberSeatLimitAdapter.current()` đọc trần qua `Entitlements.limitOf` → một câu snapshot **trong transaction của chính chúng**, nên biên hết hạn là `now()` của transaction đó: override hoạt động trên `[ghi, expires_at)`; mọi câu trong transaction thấy cùng trạng thái (E-12); transaction sau thấy trạng thái mới mà không có câu ghi, event hay đổi `version` nào. Task này khẳng định điều đó bằng test tất định (override chèn **trong** transaction của câu đọc, nên `now()` của nó là mốc chung).

**Files:**
- Modify: `src/modules/entitlements/http/schemas.ts`, `src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.ts` (chú thích)
- Create (test): `test/integration/entitlements/override-expiry.spec.ts`
- Modify (test): `test/unit/modules/entitlements/schemas.spec.ts`, `test/e2e/entitlements/org-entitlements.e2e.spec.ts`, `test/e2e/entitlements/seats.e2e.spec.ts`

**Interfaces:**
- Consumes: `EntitlementSnapshot.overrides` (Task 4); `Quotas.consume(key, amount): Promise<ConsumeResult>`, `MemberSeatLimit.current(): Promise<SeatLimit>` (4B); `seedOverride`, `readOverrides`, `outboxOf` (Task 2); `readOrgEntitlement`; `seedOrgApiKey(org, { createdByMemberId, permissions })`, `seedSupportGrant(org, { grantee, grantedByMemberId, permissions })`, `supportPresetKeys(merged)` (`tenancy-seed.ts`); `PermissionCatalogueRegistry.merged()` (`src/modules/tenancy/application/permission-catalogue.registry.ts`); `seedStaffPrincipal` (`tenancy-principals.ts`).
- Produces: `orgEntitlementsOf` điền `overrideExpiresAt` (ISO) khi `source: 'OVERRIDE'` và override có hạn; `null` khi vĩnh viễn hoặc không có override. Hình dạng `OrgEntitlementsResponse` không đổi (OpenAPI không đổi).

- [ ] **Step 1: Viết test (đỏ)**

`test/unit/modules/entitlements/schemas.spec.ts` — import thêm `type EffectiveValue` từ `'../../../../src/modules/entitlements/domain/effective-value.js'`; thêm ca:
```ts
  it('4C: an active override shows source OVERRIDE and its expiry; a permanent override has overrideExpiresAt null', () => {
    const s: EntitlementSnapshot = {
      ...snapshot,
      features: new Map<string, EffectiveValue>([
        ...snapshot.features,
        ['x.flag', { kind: 'FLAG', enabled: false, source: 'OVERRIDE' }],
        ['x.seats', { kind: 'LIMIT', limit: { kind: 'MAX', max: 4 }, source: 'OVERRIDE' }],
      ]),
      overrides: new Map([
        ['x.flag', { expiresAt: new Date('2027-01-01T00:00:00.000Z') }],
        ['x.seats', { expiresAt: null }],
      ]),
    };
    const body = OrgEntitlementsResponse.parse(orgEntitlementsOf(s, features, usage));
    expect(body.features.find((f) => f.key === 'x.flag')).toEqual({
      key: 'x.flag',
      kind: 'FLAG',
      enabled: false,
      source: 'OVERRIDE',
      overrideExpiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(body.features.find((f) => f.key === 'x.seats')).toEqual({
      key: 'x.seats',
      kind: 'LIMIT',
      unlimited: false,
      limit: 4,
      source: 'OVERRIDE',
      overrideExpiresAt: null,
    });
  });
```

`test/integration/entitlements/override-expiry.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { Quotas } from '../../../src/modules/entitlements/index.js';
import { MemberSeatLimit } from '../../../src/modules/tenancy/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** `version` của dòng gốc vừa seed: hết hạn không bao giờ tăng nó. */
const SEEDED_VERSION = 1;
/** Đủ để đồng hồ DB chắc chắn qua `expires_at` trước khi transaction sau bắt đầu (E-12). */
const EXPIRES_AFTER = `interval '50 milliseconds'`;
const SLEEP_SEC = 0.1;
type Expiry = 'at-now' | 'just-after-now';
const EXPIRY_SQL: Record<Expiry, string> = {
  'at-now': 'now()',
  'just-after-now': `now() + interval '1 microsecond'`,
};

describe('override expiry is derived at read time on the 4B paths (spec SP4 §7.4, §8.4, E-12; carried from 4B)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  /** Chèn TRONG transaction của câu đọc: `now()` ở đây là `now()` mà snapshot dùng (mốc chung, tất định). */
  const overrideIn = (key: string, limit: number | null, expiry: Expiry) =>
    app.get(Db).execute(
      `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason, expires_at, updated_at)
       SELECT app_current_org(), id, ?::bigint, 'expiry', ${EXPIRY_SQL[expiry]}, now() - interval '1 second'
       FROM entitlement_features WHERE key = ?`,
      [limit === null ? null : String(limit), key],
    );
  const orgOn = async (plan: string) => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('Review Focus 1 (quota): an override that expires exactly at the transaction now() no longer applies to consume; 1 µs later it does', async () => {
    const atNow = await orgOn('metered');
    expect(
      await inTx(atNow.orgId, async () => {
        await overrideIn('fixture.api_calls', 1, 'at-now');
        return app.get(Quotas).consume('fixture.api_calls', 2);
      }),
    ).toMatchObject({ kind: 'CONSUMED' });
    const later = await orgOn('metered');
    expect(
      await inTx(later.orgId, async () => {
        await overrideIn('fixture.api_calls', 1, 'just-after-now');
        return app.get(Quotas).consume('fixture.api_calls', 2);
      }),
    ).toEqual({ kind: 'EXCEEDED', limit: 1, used: 0 });
  });
  it('Review Focus 1 (seats): the seat port reads the plan at expires_at = now() and the override 1 µs before; NULL is unlimited', async () => {
    const cases: [Expiry, number | null, unknown][] = [
      ['at-now', 1, { kind: 'MAX', max: 3, featureKey: 'tenancy.seats' }],
      ['just-after-now', 1, { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' }],
      ['just-after-now', null, { kind: 'UNLIMITED' }],
    ];
    for (const [expiry, limit, expected] of cases) {
      const o = await orgOn('metered');
      expect(
        await inTx(o.orgId, async () => {
          await overrideIn('tenancy.seats', limit, expiry);
          return app.get(MemberSeatLimit).current();
        }),
        `${expiry} ${String(limit)}`,
      ).toEqual(expected);
    }
  });
  it('E-12: the expiry state is fixed for a whole transaction and moves for the next one without any write, event or version change', async () => {
    const o = await orgOn('metered');
    await inTx(o.orgId, async () => {
      await app.get(Db).execute(
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason, expires_at, updated_at)
         SELECT app_current_org(), id, 1, 'e-12', now() + ${EXPIRES_AFTER}, now() - interval '1 second'
         FROM entitlement_features WHERE key = 'tenancy.seats'`,
      );
      const seats = () => app.get(MemberSeatLimit).current();
      expect(await seats()).toEqual({ kind: 'MAX', max: 1, featureKey: 'tenancy.seats' });
      await app.get(Db).execute(`SELECT pg_sleep(?)`, [SLEEP_SEC]);
      expect(await seats()).toEqual({ kind: 'MAX', max: 1, featureKey: 'tenancy.seats' });
    });
    // Transaction sau bắt đầu sau khi transaction trên (đã ngủ 100 ms) commit, nên now() của nó > expires_at.
    expect(await inTx(o.orgId, () => app.get(MemberSeatLimit).current())).toEqual({
      kind: 'MAX',
      max: 3,
      featureKey: 'tenancy.seats',
    });
    expect((await readOverrides(o.orgId)).map((r) => r.feature)).toEqual(['tenancy.seats']);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(SEEDED_VERSION);
    expect([
      ...(await outboxOf(o.orgId, 'entitlements.override.set')),
      ...(await outboxOf(o.orgId, 'entitlements.override.removed')),
    ]).toEqual([]);
  });
});
```

`test/e2e/entitlements/org-entitlements.e2e.spec.ts`:
- import thêm: `PermissionCatalogueRegistry` từ `'../../../src/modules/tenancy/application/permission-catalogue.registry.js'`; `seedOverride` (cạnh các seed entitlements); `seedStaffPrincipal` (cạnh `seedUserPrincipal`); `seedOrgApiKey`, `seedSupportGrant`, `supportPresetKeys` (cạnh `seedOrg`);
- thêm hai ca:
```ts
  it('4C: the tenant sees an active override as source OVERRIDE with its expiry, and an expired one not at all', async () => {
    const o = await orgOf('pro');
    await seedOverride(o.orgId, 'fixture.reports', { value: { enabled: false }, expiresInSec: 3600 });
    await seedOverride(o.orgId, 'fixture.projects', { value: { limit: 5 }, expiresInSec: -60 });
    const r = await get(owner, o);
    expect(r.status).toBe(200);
    const f = (key: string) =>
      (r.body.features as { key: string }[]).find((x) => x.key === key);
    expect(f('fixture.reports')).toMatchObject({
      enabled: false,
      source: 'OVERRIDE',
      overrideExpiresAt: expect.stringMatching(/Z$/),
    });
    expect(f('fixture.projects')).toMatchObject({
      unlimited: true,
      limit: null,
      source: 'PLAN',
      overrideExpiresAt: null,
    });
  });
  it('HT-2b (4C, needs 3D): an org API key holding entitlements.read reads 200, one without it is 403; a stepped-up support grant reads 200', async () => {
    const url = `/v1/orgs/${pro.orgId}/entitlements`;
    const key = await seedOrgApiKey(pro, {
      createdByMemberId: pro.owner.memberId,
      permissions: ['org.read', 'entitlements.read'],
    });
    const viaKey = await request(app.getHttpServer()).get(url).set('x-api-key', key.token);
    expect([viaKey.status, viaKey.body.plan?.key]).toEqual([200, 'pro']);
    const narrow = await seedOrgApiKey(pro, {
      createdByMemberId: pro.owner.memberId,
      permissions: ['org.read'],
    });
    const refused = await request(app.getHttpServer()).get(url).set('x-api-key', narrow.token);
    expect([refused.status, refused.body.code]).toEqual([403, 'forbidden']);
    const preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
    expect(preset).toContain('entitlements.read');
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    await seedSupportGrant(pro, {
      grantee: { authUserId: staff.authUserId },
      grantedByMemberId: pro.owner.memberId,
      permissions: preset,
    });
    const viaGrant = await authed(app, staff).get(url);
    expect([viaGrant.status, viaGrant.body.plan?.key]).toEqual([200, 'pro']);
  });
```

`test/e2e/entitlements/seats.e2e.spec.ts` — import thêm `seedOverride`; thêm ca cuối:
```ts
  it('4C: a seat override below the plan blocks the next join through the real MemberAdmission; an expired one does not', async () => {
    const capped = await orgOn('metered');
    await seedOverride(capped.orgId, 'tenancy.seats', { value: { limit: 1 }, expiresInSec: 3600 });
    const [joiner] = joiners;
    if (!joiner) throw new Error('no joiner seeded');
    const refused = await joinInviteLink(app, joiner, { token: (await linkOf(capped)).token });
    expect([refused.status, refused.body.code, refused.body.errors?.[0]]).toEqual([
      422,
      'quota_exceeded',
      SEAT_ERROR,
    ]);
    expect(await memberCount(capped.orgId)).toBe(1);
    const lapsed = await orgOn('metered');
    await seedOverride(lapsed.orgId, 'tenancy.seats', { value: { limit: 1 }, expiresInSec: -1 });
    const ok = await joinInviteLink(app, joiner, { token: (await linkOf(lapsed)).token });
    expect(ok.status).toBe(201);
    expect(await memberCount(lapsed.orgId)).toBe(2);
  });
```

- [ ] **Step 2: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/schemas.spec.ts
pnpm vitest run --project integration test/integration/entitlements/override-expiry.spec.ts test/e2e/entitlements/org-entitlements.e2e.spec.ts test/e2e/entitlements/seats.e2e.spec.ts
```
Expected: `schemas.spec` FAIL (`overrideExpiresAt` vẫn `null`); ca `4C: the tenant sees …` FAIL ở `overrideExpiresAt`. `override-expiry.spec.ts`, HT-2b và ca ghế **xanh ngay**: Task 4 đã làm cho mọi người đọc snapshot thấy override, đúng điều mục mang từ 4B cần chứng minh; ghi điều này vào báo cáo task (đây là test hồi quy của hành vi đã có, không phải đỏ-trước của code mới).

- [ ] **Step 3: `overrideExpiresAt` thật**

`src/modules/entitlements/http/schemas.ts`:
- thêm trước `itemOf`:
```ts
/** Chỉ khi override còn hạn đang thắng (`source: OVERRIDE`) và có hạn; `null` khi vĩnh viễn hoặc không có override (4C). */
const overrideExpiryOf = (
  s: EntitlementSnapshot,
  key: string,
): string | null => s.overrides.get(key)?.expiresAt?.toISOString() ?? null;
```
- `itemOf` nhận thêm tham số cuối `overrideExpiresAt: string | null` và ba chỗ `overrideExpiresAt: null` trong `itemOf` thành `overrideExpiresAt,`;
- trong `orgEntitlementsOf`: `.map(([key, v]) => itemOf(key, v, usage, overrideExpiryOf(s, key)))`;
- chú thích của `OrgEntitlementsResponse`: "4C điền `overrideExpiresAt`" thành "`overrideExpiresAt` là hạn của override đang thắng (4C)".

`src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.ts` — chú thích class thành:
```ts
/**
 * Port ghế của tenancy (spec SP4 §9.6): trần hiệu lực `OVERRIDE > PLAN > FALLBACK` của `tenancy.seats` tại snapshot của câu
 * đọc, trong transaction của `MemberAdmission` (thấy gói/override vừa ghi cùng transaction). Override hết hạn suy ra bằng
 * `now()` của chính transaction đó (`expires_at > now()`, 4C): không sweep, không event. Một câu snapshot, không khoá, không
 * ghi: khoá org đã do tenancy giữ (đầu thứ tự khoá §3.6). Thiếu dòng / gói lạ → lỗi có tên (503), không bao giờ "không giới
 * hạn" (fail closed).
 */
```

- [ ] **Step 4: Chạy lại cho thấy xanh**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm vitest run --project integration test/integration/entitlements/override-expiry.spec.ts test/e2e/entitlements/org-entitlements.e2e.spec.ts test/e2e/entitlements/seats.e2e.spec.ts
pnpm build && pnpm openapi:export && git diff --exit-code openapi.json
```
Expected: PASS; `openapi.json` không đổi (hình dạng response giữ nguyên).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements/override-expiry.spec.ts test/e2e/entitlements
git add src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements/override-expiry.spec.ts test/e2e/entitlements
git commit -m "feat(entitlements): tenants see the expiry of a winning override; quota and seats derive override expiry at read time (HT-2b)"
```

---
## Phần D — Ghi override và API quản trị (spec §10.1–§10.2 `PLATFORM_ADMIN`, §12.2, §13.1)

### Task 6: Port `OverrideRepository` + repository SQL (khoá dòng gốc, upsert, xoá, tăng version, liệt kê kể cả hết hạn) và `readAdminRoot`

**Files:**
- Create: `src/modules/entitlements/ports/override.repository.ts`, `src/modules/entitlements/infra/sql/sql-override.repository.ts`
- Modify: `src/modules/entitlements/ports/org-entitlement.repository.ts`, `src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts`, `src/modules/entitlements/entitlements.module.ts`
- Create (test): `test/integration/entitlements/override-repository.spec.ts`

**Interfaces:**
- Consumes: `Db.execute(sql, params?)` (`core/database`); `seedFeatures`, `seedPlans`, `seedOrgEntitlement`, `seedOverride`, `withOwner`; `withAppClient`, `inOrgTx`, `seedOrg`.
- Produces:
  - `type LockedRoot = { version: number; now: Date }` (`now` = `clock_timestamp()` đọc **sau** câu khoá).
  - `type OverrideWrite = { featureId: string; flagValue: boolean | null; limitValue: number | null; reason: string; expiresAt: Date | null }`.
  - `type OverrideRow = { featureKey: string; flagValue: boolean | null; limitValue: number | null; reason: string; expiresAt: Date | null; updatedAt: Date }`.
  - `abstract class OverrideRepository { lockRoot(): Promise<LockedRoot | undefined>; upsert(o: OverrideWrite): Promise<void>; remove(featureId: string): Promise<boolean>; bumpVersion(): Promise<number>; listAll(): Promise<OverrideRow[]> }`; bản cài `SqlOverrideRepository` (provider + `{ provide: OverrideRepository, useExisting: SqlOverrideRepository }` trong `EntitlementsCoreModule`, export `OverrideRepository`).
  - `type AdminRootRow = { version: number; sourceRef: string | null; reason: string | null; lastBillingSeq: bigint | null; now: Date }`; `OrgEntitlementRepository.readAdminRoot(): Promise<AdminRootRow | undefined>` (`now` = `now()` của transaction, mốc `status` của override trong view admin).

- [ ] **Step 1: Viết test (đỏ)**

`test/integration/entitlements/override-repository.spec.ts`:
```ts
import { Module, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import { SqlOrgEntitlementRepository } from '../../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { SqlOverrideRepository } from '../../../src/modules/entitlements/infra/sql/sql-override.repository.js';
import { createTestApp } from '../../support/app-factory.js';
import {
  readOrgEntitlement,
  seedFeatures,
  seedOrgEntitlement,
  seedOverride,
  seedPlans,
  withOwner,
} from '../../support/entitlements-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const LOCK_NOT_AVAILABLE = '55P03';
const HOUR_MS = 3_600_000;

@Module({ providers: [SqlOverrideRepository, SqlOrgEntitlementRepository] })
class RepoModule {}

describe('SqlOverrideRepository and readAdminRoot (spec SP4 §7.4, §12.2)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let bare: SeededOrg;
  let cap: string;
  const disposers: (() => Promise<void>)[] = [];
  const repo = () => app.get(SqlOverrideRepository);
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  const write = (limitValue: number | null, reason: string, expiresAt: Date | null) =>
    inTx(a.orgId, () =>
      repo().upsert({ featureId: cap, flagValue: null, limitValue, reason, expiresAt }),
    );
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RepoModule]);
    disposers.push(
      await seedFeatures([
        { key: 'ovrepo.cap', kind: 'LIMIT', resetPeriod: null, deprecated: false },
        { key: 'ovrepo.flag', kind: 'FLAG', resetPeriod: null, deprecated: false },
      ]),
    );
    disposers.push(await seedPlans([{ key: 'ovrepo_plan' }]));
    const [row] = (
      await withOwner((c) =>
        c.query<{ id: string }>(`SELECT id::text AS id FROM entitlement_features WHERE key = 'ovrepo.cap'`),
      )
    ).rows;
    if (!row) throw new Error('ovrepo.cap not seeded');
    cap = row.id;
    a = await seedOrg();
    bare = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'ovrepo_plan', {
      source: 'BILLING',
      sourceRef: 'sub_7',
      lastBillingSeq: 4n,
    });
  });
  afterAll(async () => {
    for (const o of [a, bare]) await o?.dispose();
    for (const d of disposers.reverse()) await d();
    await app?.close();
  });

  it('lockRoot returns the version and the clock after the lock, and holds FOR NO KEY UPDATE until the transaction ends; no row → undefined', async () => {
    await inTx(a.orgId, async () => {
      const root = await repo().lockRoot();
      expect(root?.version).toBe(1);
      expect(root?.now).toBeInstanceOf(Date);
      const other = await withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(
            'SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE NOWAIT',
          ),
        ),
      ).then(
        () => 'acquired',
        (e: unknown) => Reflect.get(Object(e), 'code'),
      );
      expect(other).toBe(LOCK_NOT_AVAILABLE);
    });
    expect(await inTx(bare.orgId, () => repo().lockRoot())).toBeUndefined();
  });
  it('upsert inserts, then replaces every value of the same feature (created_at kept, updated_at moves)', async () => {
    await write(5, 'first', null);
    const until = new Date(Date.now() + HOUR_MS);
    await write(9, 'second', until);
    const [row] = await inTx(a.orgId, () => repo().listAll());
    expect(row).toMatchObject({
      featureKey: 'ovrepo.cap',
      flagValue: null,
      limitValue: 9,
      reason: 'second',
      expiresAt: until,
    });
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });
  it('upsert of an expiry not later than the write is refused by the DB (23514 org_entitlement_overrides_expiry_ck)', async () => {
    const err: unknown = await write(1, 'late', new Date(Date.now() - HOUR_MS)).catch((e: unknown) => e);
    expect([Reflect.get(Object(err), 'code'), Reflect.get(Object(err), 'constraint')]).toEqual([
      '23514',
      'org_entitlement_overrides_expiry_ck',
    ]);
  });
  it('listAll includes expired overrides, sorted by feature key', async () => {
    await seedOverride(a.orgId, 'ovrepo.flag', { value: { enabled: true }, expiresInSec: -60 });
    const rows = await inTx(a.orgId, () => repo().listAll());
    expect(rows.map((r) => [r.featureKey, r.flagValue, r.limitValue])).toEqual([
      ['ovrepo.cap', null, 9],
      ['ovrepo.flag', true, null],
    ]);
  });
  it('remove deletes the row of the feature (true), then finds nothing (false)', async () => {
    expect(await inTx(a.orgId, () => repo().remove(cap))).toBe(true);
    expect(await inTx(a.orgId, () => repo().remove(cap))).toBe(false);
  });
  it('bumpVersion increments org_entitlements.version and returns the new value', async () => {
    const before = (await readOrgEntitlement(a.orgId))?.version ?? 0;
    expect(await inTx(a.orgId, () => repo().bumpVersion())).toBe(before + 1);
    expect((await readOrgEntitlement(a.orgId))?.version).toBe(before + 1);
  });
  it('readAdminRoot returns the source ref, reason, last billing sequence and the DB clock; no row → undefined', async () => {
    const root = await inTx(a.orgId, () =>
      app.get(SqlOrgEntitlementRepository).readAdminRoot(),
    );
    expect(root).toMatchObject({ sourceRef: 'sub_7', reason: null, lastBillingSeq: 4n });
    expect(root?.version).toBeGreaterThanOrEqual(1);
    expect(root?.now).toBeInstanceOf(Date);
    expect(
      await inTx(bare.orgId, () => app.get(SqlOrgEntitlementRepository).readAdminRoot()),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Chạy cho thấy đỏ**

Run: `pnpm vitest run --project integration test/integration/entitlements/override-repository.spec.ts`
Expected: FAIL — module `sql-override.repository.js` không tồn tại.

- [ ] **Step 3: Port**

`src/modules/entitlements/ports/override.repository.ts`:
```ts
/** Dòng gốc đã khoá `FOR NO KEY UPDATE` + `clock_timestamp()` đọc SAU khoá (mốc "expiresAt phải sau lúc này", 4C). */
export type LockedRoot = { version: number; now: Date };
export type OverrideWrite = {
  featureId: string;
  flagValue: boolean | null;
  limitValue: number | null;
  reason: string;
  expiresAt: Date | null;
};
/** Một override của org, kể cả đã hết hạn (view admin, spec §12.2). */
export type OverrideRow = {
  featureKey: string;
  flagValue: boolean | null;
  limitValue: number | null;
  reason: string;
  expiresAt: Date | null;
  updatedAt: Date;
};

/**
 * Ghi override (spec §7.4): mọi phương thức chạy trong UnitOfWork + OrgScope của caller (RLS), SAU `lockRoot()` trong cùng
 * transaction: override là con của aggregate `org_entitlements`, nên mọi ghi tuần tự hoá trên khoá dòng gốc (E-7).
 */
export abstract class OverrideRepository {
  /** Khoá CHỈ dòng `org_entitlements` (không JOIN, bài học C2 của 4A); không có dòng → `undefined`. */
  abstract lockRoot(): Promise<LockedRoot | undefined>;
  /** `INSERT … ON CONFLICT (org_id, feature_id) DO UPDATE`, `updated_at = clock_timestamp()`. */
  abstract upsert(o: OverrideWrite): Promise<void>;
  /** `true` khi có dòng bị xoá. */
  abstract remove(featureId: string): Promise<boolean>;
  /** `version + 1` của dòng gốc đã khoá; trả version mới (ETag, `aggregate.version`). */
  abstract bumpVersion(): Promise<number>;
  abstract listAll(): Promise<OverrideRow[]>;
}
```

`src/modules/entitlements/ports/org-entitlement.repository.ts` — thêm kiểu và phương thức trừu tượng cuối class:
```ts
/** Phần nội bộ của dòng gốc cho view admin (spec §12.2): không bao giờ ra API tenant. `now` = `now()` của transaction. */
export type AdminRootRow = {
  version: number;
  sourceRef: string | null;
  reason: string | null;
  lastBillingSeq: bigint | null;
  now: Date;
};
```
```ts
  /** Một câu theo PK, không khoá; không có dòng → `undefined` (route admin trả 404). */
  abstract readAdminRoot(): Promise<AdminRootRow | undefined>;
```

- [ ] **Step 4: Repository SQL**

`src/modules/entitlements/infra/sql/sql-override.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import {
  OverrideRepository,
  type LockedRoot,
  type OverrideRow,
  type OverrideWrite,
} from '../../ports/override.repository.js';

const Version = z.object({ version: z.coerce.number().int().min(1) });
const Clock = z.object({ now: z.coerce.date() });
const Row = z.object({
  feature: z.string(),
  flag_value: z.boolean().nullable(),
  limit_value: z.string().nullable(),
  reason: z.string(),
  expires_at: z.coerce.date().nullable(),
  updated_at: z.coerce.date(),
});

@Injectable()
export class SqlOverrideRepository extends OverrideRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async lockRoot(): Promise<LockedRoot | undefined> {
    const locked = await this.db.execute(
      `SELECT version FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE`,
    );
    if (locked.length > 1)
      throw new Error(
        `org_entitlements lock returned ${locked.length} rows (org_entitlements PK violated?)`,
      );
    if (!locked[0]) return undefined;
    const { version } = Version.parse(locked[0]);
    // Câu riêng SAU khoá: đồng hồ trong danh sách cột của câu khoá có thể được tính trước khi chờ khoá.
    const [clock] = await this.db.execute(`SELECT clock_timestamp() AS now`);
    return { version, now: Clock.parse(clock).now };
  }

  async upsert(o: OverrideWrite): Promise<void> {
    const rows = await this.db.execute(
      `INSERT INTO org_entitlement_overrides (org_id, feature_id, flag_value, limit_value, reason, expires_at, updated_at)
       VALUES (app_current_org(), ?::bigint, ?::boolean, ?::bigint, ?, ?::timestamptz, clock_timestamp())
       ON CONFLICT (org_id, feature_id) DO UPDATE SET flag_value = EXCLUDED.flag_value, limit_value = EXCLUDED.limit_value,
         reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
       RETURNING 1 AS ok`,
      [
        o.featureId,
        o.flagValue,
        o.limitValue === null ? null : String(o.limitValue),
        o.reason,
        o.expiresAt?.toISOString() ?? null,
      ],
    );
    if (rows.length !== 1)
      throw new Error(`override upsert touched ${rows.length} rows`);
  }

  async remove(featureId: string): Promise<boolean> {
    const rows = await this.db.execute(
      `DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org() AND feature_id = ?::bigint RETURNING 1 AS ok`,
      [featureId],
    );
    return rows.length === 1;
  }

  async bumpVersion(): Promise<number> {
    const rows = await this.db.execute(
      `UPDATE org_entitlements SET version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() RETURNING version`,
    );
    if (!rows[0])
      throw new Error(
        'bumpVersion touched no row although the row was locked in this transaction',
      );
    return Version.parse(rows[0]).version;
  }

  async listAll(): Promise<OverrideRow[]> {
    const rows = await this.db.execute(
      `SELECT f.key AS feature, o.flag_value, o.limit_value::text AS limit_value, o.reason, o.expires_at, o.updated_at
       FROM org_entitlement_overrides o JOIN entitlement_features f ON f.id = o.feature_id
       WHERE o.org_id = app_current_org() ORDER BY f.key`,
    );
    return rows.map((raw) => {
      const r = Row.parse(raw);
      return {
        featureKey: r.feature,
        flagValue: r.flag_value,
        limitValue: r.limit_value === null ? null : Number(r.limit_value),
        reason: r.reason,
        expiresAt: r.expires_at,
        updatedAt: r.updated_at,
      };
    });
  }
}
```

`src/modules/entitlements/infra/sql/sql-org-entitlement.repository.ts` — import thêm `type AdminRootRow`; hằng parse cạnh `LockRaw`:
```ts
const AdminRootRaw = z.object({
  version: z.coerce.number().int().min(1),
  plan_source_ref: z.string().nullable(),
  plan_reason: z.string().nullable(),
  last_billing_seq: z.string().nullable(),
  now: z.coerce.date(),
});
```
và phương thức cuối class:
```ts
  async readAdminRoot(): Promise<AdminRootRow | undefined> {
    const rows = await this.db.execute(
      `SELECT version, plan_source_ref, plan_reason, last_billing_seq::text AS last_billing_seq, now() AS now
       FROM org_entitlements WHERE org_id = app_current_org()`,
    );
    if (rows.length > 1)
      throw new Error(
        `admin root read returned ${rows.length} rows (org_entitlements PK violated?)`,
      );
    if (!rows[0]) return undefined;
    const r = AdminRootRaw.parse(rows[0]);
    return {
      version: r.version,
      sourceRef: r.plan_source_ref,
      reason: r.plan_reason,
      lastBillingSeq: r.last_billing_seq === null ? null : BigInt(r.last_billing_seq),
      now: r.now,
    };
  }
```

`src/modules/entitlements/entitlements.module.ts` — import `SqlOverrideRepository` và `OverrideRepository`; trong `EntitlementsCoreModule.register` thêm provider sau khối `UsageCounterRepository`:
```ts
        SqlOverrideRepository,
        {
          provide: OverrideRepository,
          useExisting: SqlOverrideRepository,
        },
```
và `OverrideRepository` vào `exports`.

- [ ] **Step 5: Chạy lại cho thấy xanh**

Run:
```bash
pnpm typecheck
pnpm vitest run --project integration test/integration/entitlements/override-repository.spec.ts test/integration/entitlements/snapshot-repository.spec.ts
pnpm arch
```
Expected: PASS; `pnpm arch` xanh (`no-orphans`: repository mới được module import).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/integration/entitlements/override-repository.spec.ts
git add src/modules/entitlements test/integration/entitlements/override-repository.spec.ts
git commit -m "feat(entitlements): an override repository that locks the root row, upserts, removes and bumps the aggregate version; the admin root read"
```

---
### Task 7: Miền override (`decideOverrideValue`, `isReason`), event `entitlements.override.set`/`.removed`, service `Overrides` (khoá gốc → `If-Match` → ghi → `version + 1` → event)

**Files:**
- Create: `src/modules/entitlements/domain/override.ts`, `src/modules/entitlements/application/overrides.service.ts`
- Modify: `src/modules/entitlements/events.ts`, `src/modules/entitlements/index.ts`, `src/modules/entitlements/entitlements.module.ts`, `src/modules/entitlements/domain/effective-value.ts`
- Create (test): `test/unit/modules/entitlements/override.spec.ts`, `test/integration/entitlements/overrides.spec.ts`

**Interfaces:**
- Consumes: `type FeatureEntry` (`domain/feature-catalogue.ts`, `minimum` luôn có với LIMIT/QUOTA); `ENTITLEMENT_VALUE_MAX`, `REASON_MAX_LENGTH`; `type FieldError` (`core/errors`); `assertIfMatch(ifMatch, version, { required: true })` (`core/http`, `*` khớp mọi version); `EventPublisher.publish(def, { data, aggregate, actor })`; `ORG_ENTITLEMENT_AGGREGATE`; `RequestContext.orgId()/principal()`; `UnitOfWork.inTransaction()`; `EntitlementCatalogueRegistry.features()`; `EntitlementCatalogueCheck.featureId(key)` (4B; có cả key deprecated mà code biết); `OverrideRepository` (Task 6).
- Produces:
  - `domain/override.ts`: `type OverrideRequest = { readonly enabled: boolean } | { readonly limit: number | null }`; `type OverrideValue = { readonly kind: 'FLAG'; readonly enabled: boolean } | { readonly kind: 'LIMIT' | 'QUOTA'; readonly limit: number | null }`; `type OverrideDecision = { ok: true; value: OverrideValue } | { ok: false; problem: FieldError }`; `decideOverrideValue(feature: FeatureEntry, input: OverrideRequest): OverrideDecision`; `isReason(r: string): boolean`.
  - `domain/effective-value.ts`: `OVERRIDE_STATUSES = ['ACTIVE', 'EXPIRED'] as const` (kiểu `OverrideStatus` giữ nguyên nghĩa, nay suy từ hằng).
  - `events.ts`: `OverrideSetEvent` (`entitlements.override.set`@1, `{ orgId, feature, value: OverrideValue, expiresAt: string | null }`), `OverrideRemovedEvent` (`entitlements.override.removed`@1, `{ orgId, feature }`); cả hai `audit: true`, `webhook: false`; export ở `index.ts`.
  - `application/overrides.service.ts`: `type SetOverrideCommand = { readonly value: OverrideRequest; readonly reason: string; readonly expiresAt: Date | null }`; `class Overrides { lockAggregate(ifMatch: string | undefined): Promise<LockedRoot>; set(featureKey: string, cmd: SetOverrideCommand, ifMatch: string | undefined): Promise<number>; remove(featureKey: string, ifMatch: string | undefined): Promise<number> }` (trả `version` mới); provider + export của `EntitlementsCoreModule`.

- [ ] **Step 1: Viết test unit (đỏ)**

`test/unit/modules/entitlements/override.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_VALUE_MAX,
  REASON_MAX_LENGTH,
} from '../../../../src/modules/entitlements/constants.js';
import {
  UNLIMITED,
  featureCatalogueData,
  mergeFeatureCatalogues,
  type FeatureEntry,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  decideOverrideValue,
  isReason,
  type OverrideRequest,
} from '../../../../src/modules/entitlements/domain/override.js';

const merged = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 3 } },
  }),
]);
const f = (key: string): FeatureEntry => {
  const e = merged.get(key);
  if (!e) throw new Error(`no feature ${key}`);
  return e;
};

describe('decideOverrideValue (spec SP4 §12.2: value of the kind, within [minimum, 2^53 − 1] or null)', () => {
  it.each<[string, OverrideRequest, unknown]>([
    ['x.flag', { enabled: true }, { kind: 'FLAG', enabled: true }],
    ['x.seats', { limit: 1 }, { kind: 'LIMIT', limit: 1 }],
    ['x.seats', { limit: null }, { kind: 'LIMIT', limit: null }],
    ['x.seats', { limit: ENTITLEMENT_VALUE_MAX }, { kind: 'LIMIT', limit: ENTITLEMENT_VALUE_MAX }],
    ['x.calls', { limit: 0 }, { kind: 'QUOTA', limit: 0 }],
  ])('%s %j → accepted as %j', (key, input, value) => {
    expect(decideOverrideValue(f(key), input)).toEqual({ ok: true, value });
  });
  it.each<[string, OverrideRequest, string, string]>([
    ['x.flag', { limit: 3 }, 'limit', 'invalid_value'],
    ['x.flag', { limit: null }, 'limit', 'invalid_value'],
    ['x.seats', { enabled: true }, 'enabled', 'invalid_value'],
    ['x.seats', { limit: 0 }, 'limit', 'too_small'],
    ['x.seats', { limit: 1.5 }, 'limit', 'invalid_value'],
    ['x.seats', { limit: 2 ** 53 }, 'limit', 'invalid_value'],
    ['x.calls', { limit: -1 }, 'limit', 'too_small'],
  ])('%s %j → refused on %s (%s)', (key, input, path, code) => {
    const d = decideOverrideValue(f(key), input);
    expect(d.ok ? undefined : [d.problem.path, d.problem.code]).toEqual([path, code]);
  });
});

describe('isReason (the CHECK of the database: trimmed, 1–500 code points)', () => {
  it.each<[string, boolean]>([
    ['goodwill', true],
    ['😀'.repeat(REASON_MAX_LENGTH), true],
    ['😀'.repeat(REASON_MAX_LENGTH + 1), false],
    ['x'.repeat(REASON_MAX_LENGTH + 1), false],
    ['', false],
    [' goodwill', false],
    ['goodwill\n', false],
  ])('%j → %s', (r, ok) => {
    expect(isReason(r)).toBe(ok);
  });
});
```

- [ ] **Step 2: Viết test integration (đỏ)**

`test/integration/entitlements/overrides.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import {
  Overrides,
  type SetOverrideCommand,
} from '../../../src/modules/entitlements/application/overrides.service.js';
import { EntitlementsContextError } from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
  seedOverride,
  withOwner,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** Id của principal nhân viên trong context (chỉ là actor của event; gate là việc của 3D, không chạy ở đây). */
const STAFF = '0198c000-0000-7000-8000-00000000c7a1';
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const v1 = 'W/"1"';
const cmd = (
  value: SetOverrideCommand['value'],
  o: Partial<Omit<SetOverrideCommand, 'value'>> = {},
): SetOverrideCommand => ({
  value,
  reason: o.reason ?? 'goodwill credit',
  expiresAt: o.expiresAt ?? null,
});
const codeOf = (e: unknown) =>
  e instanceof AppError
    ? [e.error.code, e.opts.fields?.[0]?.path]
    : e instanceof Error
      ? e.name
      : e;

describe('Overrides (spec SP4 §7.4, §12.2, §13.1)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  /** CLS của một "request" nhân viên: principal rồi OrgScope + UoW, như route admin (S4-D19). */
  const asStaff = <T>(orgId: string, fn: () => Promise<T>, staff = true) =>
    app.get(ClsService).run(() => {
      if (staff)
        app.get(RequestContext).setPrincipal({ type: 'user', id: STAFF });
      return app
        .get(OrgScope)
        .run(orgId, () => app.get(UnitOfWork).run(fn));
    });
  const set = (orgId: string, key: string, c: SetOverrideCommand, ifMatch: string | undefined = v1) =>
    asStaff(orgId, () => app.get(Overrides).set(key, c, ifMatch));
  const remove = (orgId: string, key: string, ifMatch: string | undefined) =>
    asStaff(orgId, () => app.get(Overrides).remove(key, ifMatch));
  const failure = (p: Promise<unknown>) => p.then(() => 'resolved', codeOf);
  const orgOn = async (plan: string | undefined) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('set writes the override, bumps the aggregate version and publishes override.set with the staff actor and without the reason', async () => {
    const o = await orgOn('pro');
    const secret = 'goodwill-secret-7731';
    expect(await set(o.orgId, 'tenancy.seats', cmd({ limit: 4 }, { reason: secret }))).toBe(2);
    expect(await readOverrides(o.orgId)).toEqual([
      { feature: 'tenancy.seats', flagValue: null, limitValue: 4, reason: secret, expiresAt: null },
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(2);
    const events = await outboxOf(o.orgId, 'entitlements.override.set');
    expect(events.map((e) => [e.payload, e.headers.actorType, e.headers.actorId, e.aggregate_version])).toEqual([
      [
        { orgId: o.orgId, feature: 'tenancy.seats', value: { kind: 'LIMIT', limit: 4 }, expiresAt: null },
        'user',
        STAFF,
        '2',
      ],
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
  it('a second set of the same feature replaces it (one row, version 3); a FLAG takes enabled; the expiry is stored as given', async () => {
    const o = await orgOn('pro');
    const until = new Date(Date.now() + HOUR_MS);
    await set(o.orgId, 'fixture.reports', cmd({ enabled: true }));
    expect(await set(o.orgId, 'fixture.reports', cmd({ enabled: false }, { expiresAt: until }), 'W/"2"')).toBe(3);
    expect(await readOverrides(o.orgId)).toMatchObject([
      { feature: 'fixture.reports', flagValue: false, limitValue: null, expiresAt: until },
    ]);
    expect((await outboxOf(o.orgId, 'entitlements.override.set')).map((e) => e.payload.value)).toEqual([
      { kind: 'FLAG', enabled: true },
      { kind: 'FLAG', enabled: false },
    ]);
  });
  it('validation order: unknown or deprecated feature → 404; wrong kind → 422 on the sent field; below minimum → 422; a bad reason → 422; nothing written', async () => {
    const o = await orgOn('pro');
    expect([
      await failure(set(o.orgId, 'fixture.nope', cmd({ enabled: true }))),
      await failure(set(o.orgId, 'fixture.legacy_pdf', cmd({ enabled: true }))),
      await failure(set(o.orgId, 'fixture.reports', cmd({ limit: 1 }))),
      await failure(set(o.orgId, 'tenancy.seats', cmd({ limit: 0 }))),
      await failure(set(o.orgId, 'tenancy.seats', cmd({ limit: 1 }, { reason: ' padded' }))),
    ]).toEqual([
      ['not_found', undefined],
      ['not_found', undefined],
      ['validation_failed', 'limit'],
      ['validation_failed', 'limit'],
      ['validation_failed', 'reason'],
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
    expect(await readOverrides(o.orgId)).toEqual([]);
    expect(await outboxOf(o.orgId, 'entitlements.override.set')).toEqual([]);
  });
  it('If-Match under the lock: missing → 428, stale → 412, * accepted; an org without a root row → 404', async () => {
    const o = await orgOn('pro');
    expect(await failure(set(o.orgId, 'tenancy.seats', cmd({ limit: 2 }), undefined))).toEqual([
      'precondition_required',
      undefined,
    ]);
    expect(await failure(set(o.orgId, 'tenancy.seats', cmd({ limit: 2 }), 'W/"9"'))).toEqual([
      'precondition_failed',
      undefined,
    ]);
    expect(await set(o.orgId, 'tenancy.seats', cmd({ limit: 2 }), '*')).toBe(2);
    const bare = await orgOn(undefined);
    expect(await failure(set(bare.orgId, 'tenancy.seats', cmd({ limit: 2 })))).toEqual(['not_found', undefined]);
  });
  it('expiresAt not later than the DB clock read after the lock → 422 on expiresAt; nothing written', async () => {
    const o = await orgOn('pro');
    expect(
      await failure(set(o.orgId, 'tenancy.seats', cmd({ limit: 2 }, { expiresAt: new Date(Date.now() - MINUTE_MS) }))),
    ).toEqual(['validation_failed', 'expiresAt']);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('remove deletes, bumps and publishes override.removed; a missing override → 404 with the version unchanged; a deprecated feature can be cleaned up', async () => {
    const o = await orgOn('pro');
    await set(o.orgId, 'fixture.projects', cmd({ limit: 5 }));
    expect(await remove(o.orgId, 'fixture.projects', 'W/"2"')).toBe(3);
    expect((await outboxOf(o.orgId, 'entitlements.override.removed')).map((e) => [e.payload, e.aggregate_version])).toEqual([
      [{ orgId: o.orgId, feature: 'fixture.projects' }, '3'],
    ]);
    expect(await failure(remove(o.orgId, 'fixture.projects', 'W/"3"'))).toEqual(['not_found', undefined]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(3);
    // Override tạo khi tính năng còn active, rồi tính năng bị deprecate (vòng đời spec §8.4): trigger chặn override MỚI,
    // nên seed phải chạy lúc DB chưa deprecate.
    await withOwner((c) => c.query(`UPDATE entitlement_features SET deprecated_at = NULL WHERE key = 'fixture.legacy_pdf'`));
    try {
      await seedOverride(o.orgId, 'fixture.legacy_pdf', { value: { enabled: true } });
    } finally {
      await withOwner((c) => c.query(`UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'fixture.legacy_pdf'`));
    }
    expect(await remove(o.orgId, 'fixture.legacy_pdf', 'W/"3"')).toBe(4);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('outside a UnitOfWork, or without a staff principal → EntitlementsContextError (an assembly error, never a write)', async () => {
    const o = await orgOn('pro');
    const noTx = await app
      .get(OrgScope)
      .run(o.orgId, () => app.get(Overrides).set('tenancy.seats', cmd({ limit: 2 }), v1))
      .catch((e: unknown) => e);
    expect(noTx).toBeInstanceOf(EntitlementsContextError);
    const noStaff = await asStaff(o.orgId, () => app.get(Overrides).set('tenancy.seats', cmd({ limit: 2 }), v1), false).catch(
      (e: unknown) => e,
    );
    expect(noStaff).toBeInstanceOf(EntitlementsContextError);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
});
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/override.spec.ts
pnpm vitest run --project integration test/integration/entitlements/overrides.spec.ts
```
Expected: FAIL — module `domain/override.js` và `application/overrides.service.js` không tồn tại.

- [ ] **Step 4: Miền**

`src/modules/entitlements/domain/effective-value.ts` — thay `export type OverrideStatus = 'ACTIVE' | 'EXPIRED';` bằng:
```ts
export const OVERRIDE_STATUSES = ['ACTIVE', 'EXPIRED'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];
```

`src/modules/entitlements/domain/override.ts`:
```ts
import type { FieldError } from '../../../core/errors/index.js';
import { ENTITLEMENT_VALUE_MAX, REASON_MAX_LENGTH } from '../constants.js';
import type { FeatureEntry } from './feature-catalogue.js';

/** Giá trị nhân viên gửi (spec §12.2): `{ enabled }` cho FLAG, `{ limit }` cho LIMIT/QUOTA (`null` = không giới hạn). */
export type OverrideRequest =
  | { readonly enabled: boolean }
  | { readonly limit: number | null };
/** Giá trị đã khớp `kind`: cũng là `data.value` của `entitlements.override.set` (spec §13.1). */
export type OverrideValue =
  | { readonly kind: 'FLAG'; readonly enabled: boolean }
  | { readonly kind: 'LIMIT' | 'QUOTA'; readonly limit: number | null };
export type OverrideDecision =
  | { readonly ok: true; readonly value: OverrideValue }
  | { readonly ok: false; readonly problem: FieldError };

/** Code point như `char_length` của `CHECK` (một emoji là 1, không phải 2 đơn vị UTF-16). */
const codePoints = (s: string): number => Array.from(s).length;

/**
 * Cùng luật với `org_entitlement_overrides_reason_ck` và `org_entitlements_reason_ck`: đã trim, 1–500 code point. `trim`
 * của JS cắt rộng hơn `btrim` của Postgres (chỉ dấu cách), nên chuỗi thoả hàm này luôn thoả `CHECK`.
 */
export const isReason = (r: string): boolean =>
  r === r.trim() &&
  codePoints(r) >= 1 &&
  codePoints(r) <= REASON_MAX_LENGTH;

const refuse = (
  path: string,
  code: string,
  message: string,
): OverrideDecision => ({ ok: false, problem: { path, code, message } });

/**
 * Khớp giá trị gửi lên với `kind` và `minimum` của tính năng (spec §12.2; `minimum` chỉ ở code, S4-D2). Hàm thuần, `switch`
 * vét cạn. Sai `kind` báo ở chính trường đã gửi (`limit` cho FLAG, `enabled` cho LIMIT/QUOTA).
 */
export function decideOverrideValue(
  feature: FeatureEntry,
  input: OverrideRequest,
): OverrideDecision {
  switch (feature.kind) {
    case 'FLAG':
      if (!('enabled' in input))
        return refuse(
          'limit',
          'invalid_value',
          `"${feature.key}" is a FLAG: send enabled, not limit`,
        );
      return { ok: true, value: { kind: 'FLAG', enabled: input.enabled } };
    case 'LIMIT':
    case 'QUOTA': {
      if (!('limit' in input))
        return refuse(
          'enabled',
          'invalid_value',
          `"${feature.key}" is a ${feature.kind}: send limit, not enabled`,
        );
      const { limit } = input;
      if (limit !== null) {
        if (!Number.isSafeInteger(limit) || limit > ENTITLEMENT_VALUE_MAX)
          return refuse(
            'limit',
            'invalid_value',
            `limit must be null (unlimited) or an integer up to ${ENTITLEMENT_VALUE_MAX}`,
          );
        if (limit < feature.minimum)
          return refuse(
            'limit',
            'too_small',
            `limit must be at least ${feature.minimum} for "${feature.key}"`,
          );
      }
      return { ok: true, value: { kind: feature.kind, limit } };
    }
    default: {
      const unknownKind: never = feature;
      throw new Error(
        `unknown feature kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}
```

- [ ] **Step 5: Event**

`src/modules/entitlements/events.ts` — thêm cuối file:
```ts
/** `data.value` của `override.set` (spec §13.1): cùng hình dạng `OverrideValue` của miền. */
const OverrideValueSchema = z.union([
  z.object({ kind: z.literal('FLAG'), enabled: z.boolean() }),
  z.object({
    kind: z.enum(['LIMIT', 'QUOTA']),
    limit: z.int().min(0).nullable(),
  }),
]);

/**
 * Spec §13.1, S4-D12: nhân viên đặt/thay override; aggregate `org_entitlement`, version = `org_entitlements.version` mới.
 * Không `reason` (văn bản tự do của nhân viên ở `org_entitlement_overrides.reason`, A9). `audit: true`, `webhook: false`
 * (R-X3, S4-D20). Hết hạn KHÔNG có event (suy ra khi đọc).
 */
export const OverrideSetEvent = defineEvent({
  type: 'entitlements.override.set',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({
    orgId: z.uuid(),
    feature: z.string(),
    value: OverrideValueSchema,
    expiresAt: z.iso.datetime().nullable(),
  }),
});

/** Spec §13.1: nhân viên xoá override; `audit: true`, `webhook: false` (R-X3). */
export const OverrideRemovedEvent = defineEvent({
  type: 'entitlements.override.removed',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({ orgId: z.uuid(), feature: z.string() }),
});
```

`src/modules/entitlements/index.ts` — dòng export event thành:
```ts
export {
  OverrideRemovedEvent,
  OverrideSetEvent,
  PlanChangedEvent,
  QuotaReachedEvent,
} from './events.js';
```

- [ ] **Step 6: Service `Overrides`**

`src/modules/entitlements/application/overrides.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { REASON_MAX_LENGTH } from '../constants.js';
import type { FeatureEntry } from '../domain/feature-catalogue.js';
import {
  decideOverrideValue,
  isReason,
  type OverrideRequest,
} from '../domain/override.js';
import { EntitlementsContextError } from '../errors.js';
import {
  ORG_ENTITLEMENT_AGGREGATE,
  OverrideRemovedEvent,
  OverrideSetEvent,
} from '../events.js';
import {
  OverrideRepository,
  type LockedRoot,
} from '../ports/override.repository.js';
import { EntitlementCatalogueCheck } from './catalogue-check.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';

export type SetOverrideCommand = {
  readonly value: OverrideRequest;
  readonly reason: string;
  readonly expiresAt: Date | null;
};

const notFound = (): AppError =>
  new AppError(CoreErrors.NOT_FOUND, { expected: true });
const invalid = (path: string, code: string, message: string): AppError =>
  new AppError(CoreErrors.VALIDATION_FAILED, {
    fields: [{ path, code, message }],
    expected: true,
  });

/**
 * Override của nhân viên (spec §7.4, §12.2, S4-D12): chạy TRONG UnitOfWork + OrgScope của caller (route admin mở scope không
 * qua membership, S4-D19). Thứ tự kiểm cố định: tính năng (404) → giá trị theo `kind`/`minimum`, lý do (422) → khoá dòng gốc
 * (404 khi org không có dòng) → `If-Match` DƯỚI khoá (428/412) → `expiresAt` sau giờ DB đọc sau khoá (422) → ghi override →
 * `version + 1` → event outbox, cùng transaction.
 * Race (spec §17): hai nhân viên (E-7) xếp hàng ở khoá dòng gốc, bên sau đọc `version` mới sau khi chờ và nhận 412; lệnh
 * billing (E-8) cũng xếp hàng ở đó và không so version, nên cả hai áp theo thứ tự commit (override là lớp riêng, billing không
 * đụng). Thứ tự khoá (spec §3.6): chỉ `org_entitlements` (FK của override lấy `FOR KEY SHARE` trên chính dòng đó); không khoá
 * `organizations` hay `usage_counters`, nên consume và admission không bao giờ chờ nó (E-4, E-6b).
 */
@Injectable()
export class Overrides {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly catalogue: EntitlementCatalogueCheck,
    private readonly repo: OverrideRepository,
    private readonly events: EventPublisher,
  ) {}

  /** Khoá dòng gốc rồi so `If-Match` dưới khoá (mẫu `OrgService.rename`); gán gói của nhân viên dùng chung. */
  async lockAggregate(ifMatch: string | undefined): Promise<LockedRoot> {
    this.requireTx('lockAggregate');
    const root = await this.repo.lockRoot();
    if (!root) throw notFound();
    assertIfMatch(ifMatch, root.version, { required: true });
    return root;
  }

  async set(
    featureKey: string,
    cmd: SetOverrideCommand,
    ifMatch: string | undefined,
  ): Promise<number> {
    const orgId = this.requireTx('set');
    const actor = this.staffActor();
    const feature = this.feature(featureKey);
    if (!feature || feature.deprecated) throw notFound();
    const decided = decideOverrideValue(feature, cmd.value);
    if (!decided.ok)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [decided.problem],
        expected: true,
      });
    if (!isReason(cmd.reason))
      throw invalid(
        'reason',
        'invalid_value',
        `reason must be trimmed and 1–${REASON_MAX_LENGTH} characters`,
      );
    if (cmd.expiresAt !== null && Number.isNaN(cmd.expiresAt.getTime()))
      throw invalid('expiresAt', 'invalid_value', 'expiresAt is not an instant');
    const root = await this.lockAggregate(ifMatch);
    // Giờ DB sau khoá; `org_entitlement_overrides_expiry_ck` là lớp chặn cuối nếu đồng hồ đi tiếp trước câu ghi.
    if (cmd.expiresAt !== null && cmd.expiresAt.getTime() <= root.now.getTime())
      throw invalid('expiresAt', 'too_small', 'expiresAt must be later than now');
    const value = decided.value;
    await this.repo.upsert({
      featureId: this.catalogue.featureId(featureKey),
      flagValue: value.kind === 'FLAG' ? value.enabled : null,
      limitValue: value.kind === 'FLAG' ? null : value.limit,
      reason: cmd.reason,
      expiresAt: cmd.expiresAt,
    });
    const version = await this.repo.bumpVersion();
    await this.events.publish(OverrideSetEvent, {
      data: {
        orgId,
        feature: featureKey,
        value,
        expiresAt: cmd.expiresAt?.toISOString() ?? null,
      },
      aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
      actor,
    });
    return version;
  }

  /** Tính năng đã deprecated vẫn xoá được (dọn override trước khi migration xoá tính năng, spec §8.4). */
  async remove(featureKey: string, ifMatch: string | undefined): Promise<number> {
    const orgId = this.requireTx('remove');
    const actor = this.staffActor();
    if (!this.feature(featureKey)) throw notFound();
    await this.lockAggregate(ifMatch);
    if (!(await this.repo.remove(this.catalogue.featureId(featureKey))))
      throw notFound();
    const version = await this.repo.bumpVersion();
    await this.events.publish(OverrideRemovedEvent, {
      data: { orgId, feature: featureKey },
      aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
      actor,
    });
    return version;
  }

  /** Key do nhân viên gõ: tra mềm (404), không `registry.feature()` (ném `UnknownFeatureError` + ERROR, dành cho lỗi code). */
  private feature(key: string): FeatureEntry | undefined {
    return this.registry.features().get(key);
  }

  private requireTx(op: string): string {
    const orgId = this.ctx.orgId();
    if (!this.uow.inTransaction() || orgId === undefined)
      throw new EntitlementsContextError(
        `Overrides.${op} must run inside the caller UnitOfWork and an organization context`,
      );
    return orgId;
  }

  /** Gate của 3D đã đảm bảo một session nhân viên; vắng principal user là lỗi lắp ráp, không bao giờ ghi không actor. */
  private staffActor(): EventActor {
    const p = this.ctx.principal();
    if (p?.type !== 'user')
      throw new EntitlementsContextError(
        'an override write needs the staff principal in the request context',
      );
    return { type: 'user', id: p.id };
  }
}
```

`src/modules/entitlements/entitlements.module.ts` — import `Overrides`; thêm `Overrides` vào `providers` (sau `Quotas`) và `exports` của `EntitlementsCoreModule.register`.

- [ ] **Step 7: Chạy lại cho thấy xanh**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/entitlements test/unit/core/events
pnpm vitest run --project integration test/integration/entitlements/overrides.spec.ts
pnpm arch
```
Expected: PASS. `event-flags.spec.ts` (thư mục `test/unit/core/events`) phủ hai event mới qua ca "audited namespaces" (cờ tường minh `audit: true`, `webhook: false`). `pnpm arch` xanh (`domain-pure`: `domain/override.ts` chỉ import kiểu của `core/errors` và hằng).

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements/override.spec.ts test/integration/entitlements/overrides.spec.ts
git add src/modules/entitlements test/unit/modules/entitlements/override.spec.ts test/integration/entitlements/overrides.spec.ts
git commit -m "feat(entitlements): staff overrides lock the aggregate, check If-Match under the lock, bump the version and publish audited events"
```

---

### Task 8: `AdminEntitlementsQuery` (view admin trong một snapshot) và `AdminEntitlements` (mở `OrgScope` không qua membership; gán gói `PLATFORM_ADMIN` với `expectedVersion`; ánh xạ lỗi; metric)

**Files:**
- Create: `src/modules/entitlements/application/admin-entitlements.query.ts`, `src/modules/entitlements/application/admin-entitlements.service.ts`
- Modify: `src/modules/entitlements/entitlements.module.ts`
- Create (test): `test/integration/entitlements/admin-entitlements.spec.ts`

**Interfaces:**
- Consumes: `Entitlements.snapshot()`; `OrgEntitlementRepository.readAdminRoot()`, `type AdminRootRow`; `OverrideRepository.listAll()`, `type OverrideRow` (Task 6); `Overrides.lockAggregate/set/remove`, `type SetOverrideCommand` (Task 7); `PlanAssignments.assign({ planKey, cause: { kind: 'PLATFORM_ADMIN', reason, expectedVersion } }): Promise<AssignmentResult>` (4A: `UnknownPlanError` trước câu ghi, `REJECTED_RETIRED` là kết quả); `EntitlementCatalogueRegistry.plans()/features()`; `EntitlementsMetrics.planAssignments` (counter `{cause, result}`), `type AssignmentMetricResult`; `EntitlementsErrors.PLAN_RETIRED`, `EntitlementsErrors.UNKNOWN_PLAN`; `OrgScope.run`, `UnitOfWork.run(fn, { isolation: 'repeatable read' })`; `installOtelCapture()` (`test/support/otel-capture.ts`, `metric(name, attrs?)`).
- Produces:
  - `type AdminView = { readonly snapshot: EntitlementSnapshot; readonly root: AdminRootRow; readonly overrides: readonly OverrideRow[] }`; `class AdminEntitlementsQuery { read(): Promise<AdminView> }` (trong UoW + OrgScope của caller; không dòng gốc → `404`; override của key code không biết bị lọc).
  - `type StaffPlanCommand = { readonly planKey: string; readonly reason: string }`; `class AdminEntitlements { view(orgId: string): Promise<AdminView>; assignPlan(orgId: string, ifMatch: string | undefined, cmd: StaffPlanCommand): Promise<AdminView>; setOverride(orgId: string, featureKey: string, ifMatch: string | undefined, cmd: SetOverrideCommand): Promise<AdminView>; removeOverride(orgId: string, featureKey: string, ifMatch: string | undefined): Promise<number> }` (`orgId` đã là UUID chữ thường: controller kiểm).
  - Metric: `entitlements_plan_assignments_total{cause="PLATFORM_ADMIN", result="unknown_plan"|"precondition_failed"}` cho hai nhánh mà route admin chặn trước `assign` (các nhánh khác do `assign` tự đếm).

- [ ] **Step 1: Viết test (đỏ)**

`test/integration/entitlements/admin-entitlements.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import { AdminEntitlements } from '../../../src/modules/entitlements/application/admin-entitlements.service.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  seedOrgEntitlement,
  seedOverride,
} from '../../support/entitlements-seed.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const STAFF = '0198c000-0000-7000-8000-00000000c7a2';
const codeOf = (e: unknown) => (e instanceof AppError ? e.error.code : e);

describe('AdminEntitlements (spec SP4 §10.2 PLATFORM_ADMIN, §12.2, S4-D19)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const admin = () => app.get(AdminEntitlements);
  const asStaff = <T>(fn: () => Promise<T>) =>
    app.get(ClsService).run(() => {
      app.get(RequestContext).setPrincipal({ type: 'user', id: STAFF });
      return fn();
    });
  const metric = async (result: string) =>
    (await otel.metric('entitlements_plan_assignments_total', {
      cause: 'PLATFORM_ADMIN',
      result,
    })) ?? 0;
  const orgOn = async (plan: string | undefined, opts: Parameters<typeof seedOrgEntitlement>[2] = {}) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('view: root, snapshot and every override (expired included) from one REPEATABLE READ snapshot; an org without a root row → 404', async () => {
    const o = await orgOn('pro', { source: 'BILLING', sourceRef: 'sub_3', lastBillingSeq: 2n });
    await seedOverride(o.orgId, 'fixture.projects', { value: { limit: 4 }, expiresInSec: -60 });
    await seedOverride(o.orgId, 'tenancy.seats', { value: { limit: 6 } });
    const v = await asStaff(() => admin().view(o.orgId));
    expect([v.root.version, v.snapshot.version, v.root.sourceRef, v.root.lastBillingSeq]).toEqual([1, 1, 'sub_3', 2n]);
    expect(v.overrides.map((x) => x.featureKey)).toEqual(['fixture.projects', 'tenancy.seats']);
    expect(v.snapshot.features.get('tenancy.seats')).toMatchObject({ source: 'OVERRIDE' });
    expect(v.snapshot.features.get('fixture.projects')).toMatchObject({ source: 'PLAN' });
    const bare = await orgOn(undefined);
    expect(await asStaff(() => admin().view(bare.orgId)).catch(codeOf)).toBe('not_found');
  });
  it('assignPlan: APPLIED returns the new view (PLATFORM_ADMIN, reason kept internally); the same plan again is UNCHANGED (no version, no event)', async () => {
    const o = await orgOn('free');
    const v = await asStaff(() => admin().assignPlan(o.orgId, 'W/"1"', { planKey: 'pro', reason: 'pilot' }));
    expect([v.root.version, v.snapshot.plan.key, v.snapshot.plan.source, v.root.reason]).toEqual([2, 'pro', 'PLATFORM_ADMIN', 'pilot']);
    const again = await asStaff(() => admin().assignPlan(o.orgId, 'W/"2"', { planKey: 'pro', reason: 'pilot' }));
    expect(again.root.version).toBe(2);
    expect((await outboxOf(o.orgId, 'entitlements.plan.changed')).map((e) => e.headers.actorId)).toEqual([STAFF]);
  });
  it('assignPlan: an unknown plan → 422 unknown_plan before any lock or ERROR log, counted; a retired plan → 422 plan_retired; nothing changes', async () => {
    const o = await orgOn('free');
    const error = vi.spyOn(Logger.prototype, 'error');
    const before = await metric('unknown_plan');
    expect(await asStaff(() => admin().assignPlan(o.orgId, 'W/"1"', { planKey: 'gold', reason: 'typo' })).catch(codeOf)).toBe('unknown_plan');
    expect(await metric('unknown_plan')).toBe(before + 1);
    expect(error.mock.calls.filter(([x]) => Reflect.get(Object(x), 'event') === 'entitlements_unknown_plan')).toEqual([]);
    error.mockRestore();
    expect(await asStaff(() => admin().assignPlan(o.orgId, 'W/"1"', { planKey: 'legacy', reason: 'old' })).catch(codeOf)).toBe('plan_retired');
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'free', source: 'DEFAULT', version: 1 });
  });
  it('assignPlan: a stale If-Match → 412 counted as precondition_failed; * is accepted', async () => {
    const o = await orgOn('free');
    const before = await metric('precondition_failed');
    expect(await asStaff(() => admin().assignPlan(o.orgId, 'W/"5"', { planKey: 'pro', reason: 'x' })).catch(codeOf)).toBe('precondition_failed');
    expect(await metric('precondition_failed')).toBe(before + 1);
    expect((await asStaff(() => admin().assignPlan(o.orgId, '*', { planKey: 'pro', reason: 'x' }))).root.version).toBe(2);
  });
  it('setOverride returns the view with the active override; removeOverride returns the new version', async () => {
    const o = await orgOn('pro');
    const v = await asStaff(() =>
      admin().setOverride(o.orgId, 'tenancy.seats', 'W/"1"', { value: { limit: 2 }, reason: 'promo', expiresAt: null }),
    );
    expect([v.root.version, v.overrides.map((x) => [x.featureKey, x.limitValue])]).toEqual([2, [['tenancy.seats', 2]]]);
    expect(v.snapshot.features.get('tenancy.seats')).toEqual({ kind: 'LIMIT', limit: { kind: 'MAX', max: 2 }, source: 'OVERRIDE' });
    expect(await asStaff(() => admin().removeOverride(o.orgId, 'tenancy.seats', 'W/"2"'))).toBe(3);
  });
});
```

- [ ] **Step 2: Chạy cho thấy đỏ**

Run: `pnpm vitest run --project integration test/integration/entitlements/admin-entitlements.spec.ts`
Expected: FAIL — module `admin-entitlements.service.js` không tồn tại.

- [ ] **Step 3: Query**

`src/modules/entitlements/application/admin-entitlements.query.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  OrgEntitlementRepository,
  type AdminRootRow,
} from '../ports/org-entitlement.repository.js';
import {
  OverrideRepository,
  type OverrideRow,
} from '../ports/override.repository.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import {
  Entitlements,
  type EntitlementSnapshot,
} from './entitlements.service.js';

export type AdminView = {
  readonly snapshot: EntitlementSnapshot;
  readonly root: AdminRootRow;
  readonly overrides: readonly OverrideRow[];
};

/**
 * View admin (spec §12.2): gói + phần nội bộ của dòng gốc + giá trị hiệu lực + mọi override (kể cả hết hạn, `status` suy ra
 * ở HTTP bằng `root.now`). Chạy trong UoW + OrgScope của caller. Org không có dòng gốc → 404 (route admin nhận org từ path:
 * org không tồn tại hay chưa có dòng đều là "không có resource"). Override của key code không biết (R-X30) bị lọc: pod này
 * không có code nào kiểm tính năng đó.
 */
@Injectable()
export class AdminEntitlementsQuery {
  constructor(
    private readonly entitlements: Entitlements,
    private readonly roots: OrgEntitlementRepository,
    private readonly overrides: OverrideRepository,
    private readonly registry: EntitlementCatalogueRegistry,
  ) {}

  async read(): Promise<AdminView> {
    const root = await this.roots.readAdminRoot();
    if (!root) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    const snapshot = await this.entitlements.snapshot();
    const known = this.registry.features();
    const overrides = (await this.overrides.listAll()).filter((o) =>
      known.has(o.featureKey),
    );
    return { snapshot, root, overrides };
  }
}
```

- [ ] **Step 4: Service điều phối**

`src/modules/entitlements/application/admin-entitlements.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { OrgScope, UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EntitlementsErrors, UnknownPlanError } from '../errors.js';
import type { LockedRoot } from '../ports/override.repository.js';
import {
  AdminEntitlementsQuery,
  type AdminView,
} from './admin-entitlements.query.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import {
  EntitlementsMetrics,
  type AssignmentMetricResult,
} from './entitlements-metrics.js';
import { Overrides, type SetOverrideCommand } from './overrides.service.js';
import {
  PlanAssignments,
  type AssignmentResult,
} from './plan-assignments.service.js';

export type StaffPlanCommand = {
  readonly planKey: string;
  readonly reason: string;
};

const unknownPlan = (): AppError =>
  new AppError(EntitlementsErrors.UNKNOWN_PLAN, { expected: true });

/**
 * Điều phối route admin (spec §12.2): mở `OrgScope.run(orgId)` KHÔNG qua membership (ngoại lệ có tên S4-D19, chỉ sau khi
 * `@PlatformStaffAction()` đã cho qua; RLS vẫn giới hạn mọi câu vào đúng org) + `UnitOfWork`, khoá dòng gốc và so `If-Match`
 * dưới khoá, rồi gán gói (`PlanAssignments.assign` với `PLATFORM_ADMIN` + `expectedVersion` = version đã khoá, nên nhánh 412
 * của `assign` là kiểm lại trùng) hoặc ghi override, và đọc lại view trong cùng transaction (ETag mới khớp nội dung).
 */
@Injectable()
export class AdminEntitlements {
  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly query: AdminEntitlementsQuery,
    private readonly overrides: Overrides,
    private readonly assignments: PlanAssignments,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly metrics: EntitlementsMetrics,
  ) {}

  /** REPEATABLE READ: gốc, snapshot, override thấy cùng một snapshot, nên `version` (ETag) khớp nội dung trả về. */
  view(orgId: string): Promise<AdminView> {
    return this.scope.run(orgId, () =>
      this.uow.run(() => this.query.read(), { isolation: 'repeatable read' }),
    );
  }

  assignPlan(
    orgId: string,
    ifMatch: string | undefined,
    cmd: StaffPlanCommand,
  ): Promise<AdminView> {
    return this.inOrg(orgId, async () => {
      // Key nhân viên gõ sai là lỗi của người dùng (422), không phải ERROR vận hành của `assign`.
      if (!this.registry.plans().plans.has(cmd.planKey)) {
        this.count('unknown_plan');
        throw unknownPlan();
      }
      const root = await this.lockCounted(ifMatch);
      const r = await this.assign(cmd, root.version);
      switch (r.kind) {
        case 'APPLIED':
        case 'UNCHANGED':
          return this.query.read();
        case 'REJECTED_RETIRED':
          throw new AppError(EntitlementsErrors.PLAN_RETIRED, {
            expected: true,
          });
        case 'STALE':
          throw new Error(
            'a PLATFORM_ADMIN assignment returned STALE, which only a BILLING command can',
          );
        default: {
          const unknown: never = r;
          throw new Error(`unknown assignment result ${JSON.stringify(unknown)}`);
        }
      }
    });
  }

  setOverride(
    orgId: string,
    featureKey: string,
    ifMatch: string | undefined,
    cmd: SetOverrideCommand,
  ): Promise<AdminView> {
    return this.inOrg(orgId, async () => {
      await this.overrides.set(featureKey, cmd, ifMatch);
      return this.query.read();
    });
  }

  removeOverride(
    orgId: string,
    featureKey: string,
    ifMatch: string | undefined,
  ): Promise<number> {
    return this.inOrg(orgId, () => this.overrides.remove(featureKey, ifMatch));
  }

  private inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return this.scope.run(orgId, () => this.uow.run(fn));
  }

  /** 412 của nhân viên vào `entitlements_plan_assignments_total{result="precondition_failed"}` (spec §19, E-7). */
  private async lockCounted(ifMatch: string | undefined): Promise<LockedRoot> {
    try {
      return await this.overrides.lockAggregate(ifMatch);
    } catch (err) {
      if (
        err instanceof AppError &&
        err.error.code === CoreErrors.PRECONDITION_FAILED.code
      )
        this.count('precondition_failed');
      throw err;
    }
  }

  /** Gói có trong catalogue mà thiếu ở bảng `plans` (migration chưa chạy): `assign` đã log ERROR; với nhân viên vẫn là 422. */
  private async assign(
    cmd: StaffPlanCommand,
    expectedVersion: number,
  ): Promise<AssignmentResult> {
    try {
      return await this.assignments.assign({
        planKey: cmd.planKey,
        cause: { kind: 'PLATFORM_ADMIN', reason: cmd.reason, expectedVersion },
      });
    } catch (err) {
      if (err instanceof UnknownPlanError) throw unknownPlan();
      throw err;
    }
  }

  private count(result: AssignmentMetricResult): void {
    this.metrics.planAssignments.add(1, { cause: 'PLATFORM_ADMIN', result });
  }
}
```

`src/modules/entitlements/entitlements.module.ts` — import `AdminEntitlementsQuery`, `AdminEntitlements`; thêm vào `providers` (sau `Overrides`) và `exports` của `EntitlementsCoreModule.register`. Chú thích của `EntitlementsCoreModule` thêm câu: `Service admin (Overrides, AdminEntitlementsQuery, AdminEntitlements) ở đây như PlanAssignments; chỉ controller admin nằm ở EntitlementsHttpModule (api).`

- [ ] **Step 5: Chạy lại cho thấy xanh**

Run:
```bash
pnpm typecheck
pnpm vitest run --project integration test/integration/entitlements/admin-entitlements.spec.ts test/integration/entitlements/plan-assignments.spec.ts
```
Expected: PASS; `plan-assignments.spec.ts` (4A) không đổi.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/integration/entitlements/admin-entitlements.spec.ts
git add src/modules/entitlements test/integration/entitlements/admin-entitlements.spec.ts
git commit -m "feat(entitlements): an admin service that scopes staff into the org, assigns PLATFORM_ADMIN plans with expectedVersion and reads a consistent view"
```

---

### Task 9: API HTTP quản trị — năm route `@PlatformStaffAction()`, schema, `ETag`/`304`/`no-store`, OpenAPI (AD-2, AD-3, AD-4, Review Focus 2–5)

**Files:**
- Create: `src/modules/entitlements/http/admin-entitlements.controller.ts`
- Modify: `src/modules/entitlements/http/schemas.ts`, `src/modules/entitlements/http/entitlements-http.module.ts`, `openapi.json` (sinh lại)
- Create (test): `test/unit/modules/entitlements/admin-schemas.spec.ts`, `test/e2e/entitlements/admin-entitlements.e2e.spec.ts`

**Interfaces:**
- Consumes: `AdminEntitlements`, `type AdminView`, `type StaffPlanCommand` (Task 8); `type SetOverrideCommand` (Task 7); `isReason`, `type OverrideRequest` (Task 7); `OVERRIDE_STATUSES`, `overrideStatus`, `resolveEffective`, `type EffectiveValue` (`domain/effective-value.ts`); `type PlanCatalogue`; `type MergedFeatures`, `type FeatureEntry`, `RESET_PERIODS`; `PLAN_SOURCES`, `REASON_MAX_LENGTH`; `PlatformStaffAction`, `IdentityErrors` (`modules/identity/index.ts`); `ApiOk`, `ApiProblems`, `etagOf`, `serialize`, `type HeaderWriter` (`core/http`); `@Body({ schema })`, `@Headers('if-match')` (Nest 12, mẫu `org.controller.ts`).
- Produces:
  - Route: `GET /v1/admin/plans` → `200` `AdminPlansResponse`; `GET /v1/admin/orgs/{orgId}/entitlements` → `200` + `ETag: W/"<version>"` + `Cache-Control: no-store`, `304`; `PUT …/entitlements/plan` (`PutPlanBody`) → `200`; `PUT …/entitlements/overrides/{featureKey}` (`PutOverrideBody`) → `200`; `DELETE …/entitlements/overrides/{featureKey}` → `204` + `ETag` mới.
  - `schemas.ts`: `PutPlanBody`, `PutOverrideBody`, `AdminOrgEntitlementsResponse` (`orgId, version, plan{key, source, sourceRef, reason, assignedAt}, lastBillingSeq: string|null, features[], overrides[]`), `AdminPlansResponse` (`defaultPlan, plans[{key, retired, default, features[]}]`), `adminEntitlementsOf(orgId, view, features)`, `adminPlansOf(plans, features)`.

- [ ] **Step 1: Viết test unit của schema (đỏ)**

`test/unit/modules/entitlements/admin-schemas.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { AdminView } from '../../../../src/modules/entitlements/application/admin-entitlements.query.js';
import {
  UNLIMITED,
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import {
  AdminOrgEntitlementsResponse,
  AdminPlansResponse,
  PutOverrideBody,
  PutPlanBody,
  adminEntitlementsOf,
  adminPlansOf,
} from '../../../../src/modules/entitlements/http/schemas.js';

const ORG = '0198c000-0000-7000-8000-00000000000c';
const NOW = new Date('2026-10-07T00:00:00.000Z');
const features = mergeFeatureCatalogues([
  featureCatalogueData({
    'x.flag': { kind: 'FLAG', fallback: false },
    'x.old': { kind: 'FLAG', fallback: false, deprecated: true },
    'x.seats': { kind: 'LIMIT', fallback: UNLIMITED, minimum: 1 },
    'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 3 } },
  }),
]);
const view: AdminView = {
  snapshot: {
    version: 4,
    plan: { key: 'pro', source: 'PLATFORM_ADMIN', assignedAt: NOW },
    features: new Map([
      ['x.flag', { kind: 'FLAG', enabled: true, source: 'PLAN' }],
      ['x.old', { kind: 'FLAG', enabled: false, source: 'FALLBACK' }],
      ['x.seats', { kind: 'LIMIT', limit: { kind: 'MAX', max: 2 }, source: 'OVERRIDE' }],
      ['x.calls', { kind: 'QUOTA', limit: { kind: 'MAX', max: 3 }, resetPeriod: 'MONTH', source: 'FALLBACK' }],
    ]),
    overrides: new Map([['x.seats', { expiresAt: new Date('2026-12-01T00:00:00.000Z') }]]),
  },
  root: { version: 4, sourceRef: null, reason: 'pilot', lastBillingSeq: 12n, now: NOW },
  overrides: [
    { featureKey: 'x.flag', flagValue: false, limitValue: null, reason: 'old promo', expiresAt: NOW, updatedAt: NOW },
    { featureKey: 'x.seats', flagValue: null, limitValue: 2, reason: 'promo', expiresAt: new Date('2026-12-01T00:00:00.000Z'), updatedAt: NOW },
  ],
};

describe('admin schemas (spec SP4 §12.2)', () => {
  it('the admin view: internal fields, BIGINT as a decimal string, no usage, deprecated hidden, override status from the DB clock (EXPIRED at expires_at)', () => {
    const body = AdminOrgEntitlementsResponse.parse(adminEntitlementsOf(ORG, view, features));
    expect(body).toMatchObject({
      orgId: ORG,
      version: 4,
      plan: { key: 'pro', source: 'PLATFORM_ADMIN', sourceRef: null, reason: 'pilot', assignedAt: NOW.toISOString() },
      lastBillingSeq: '12',
    });
    expect(body.features.map((f) => f.key)).toEqual(['x.calls', 'x.flag', 'x.seats']);
    expect(body.features.find((f) => f.key === 'x.calls')).toEqual({
      key: 'x.calls', kind: 'QUOTA', resetPeriod: 'MONTH', unlimited: false, limit: 3, source: 'FALLBACK', overrideExpiresAt: null,
    });
    expect(body.features.find((f) => f.key === 'x.seats')).toMatchObject({ source: 'OVERRIDE', overrideExpiresAt: '2026-12-01T00:00:00.000Z' });
    expect(body.overrides).toEqual([
      { kind: 'FLAG', enabled: false, feature: 'x.flag', reason: 'old promo', expiresAt: NOW.toISOString(), status: 'EXPIRED', updatedAt: NOW.toISOString() },
      { kind: 'LIMIT', unlimited: false, limit: 2, feature: 'x.seats', reason: 'promo', expiresAt: '2026-12-01T00:00:00.000Z', status: 'ACTIVE', updatedAt: NOW.toISOString() },
    ]);
  });
  it('the plan catalogue: sorted plans, default flag, each active feature with PLAN or FALLBACK', () => {
    const plans = definePlanCatalogue({
      defaultPlan: 'free',
      plans: { pro: { values: { 'x.flag': true } }, free: { values: {} }, old: { retired: true, values: {} } },
    });
    const body = AdminPlansResponse.parse(adminPlansOf(plans, features));
    expect(body.plans.map((p) => [p.key, p.default, p.retired])).toEqual([
      ['free', true, false],
      ['old', false, true],
      ['pro', false, false],
    ]);
    expect(body.plans[2]?.features.map((f) => [f.key, f.source])).toEqual([
      ['x.calls', 'FALLBACK'],
      ['x.flag', 'PLAN'],
      ['x.seats', 'FALLBACK'],
    ]);
  });
  it('request bodies: plan needs planKey and a reason; an override takes enabled XOR limit, an ISO UTC expiry or null, nothing else', () => {
    expect(PutPlanBody.safeParse({ planKey: 'pro', reason: '  pilot ' }).data).toEqual({ planKey: 'pro', reason: 'pilot' });
    expect(PutPlanBody.safeParse({ planKey: 'pro', reason: '   ' }).success).toBe(false);
    expect(PutPlanBody.safeParse({ planKey: 'pro', reason: 'x', extra: 1 }).success).toBe(false);
    const ok = { reason: 'r', expiresAt: null };
    expect(PutOverrideBody.safeParse({ enabled: true, ...ok }).success).toBe(true);
    expect(PutOverrideBody.safeParse({ limit: null, ...ok }).success).toBe(true);
    expect(PutOverrideBody.safeParse({ enabled: true, limit: 1, ...ok }).success).toBe(false);
    expect(PutOverrideBody.safeParse({ limit: 2 ** 53, ...ok }).success).toBe(false);
    expect(PutOverrideBody.safeParse({ limit: 1, reason: 'r' }).success).toBe(false);
    expect(PutOverrideBody.safeParse({ limit: 1, reason: 'r', expiresAt: '2026-10-07T10:00:00+07:00' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Viết test e2e (đỏ)**

`test/e2e/entitlements/admin-entitlements.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import {
  ENTITLEMENT_VALUE_MAX,
  REASON_MAX_LENGTH,
} from '../../../src/modules/entitlements/constants.js';
import { Quotas } from '../../../src/modules/entitlements/index.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
  seedOverride,
  withOwner,
} from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedOrg,
  seedOrgApiKey,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

type Item = { key: string } & Record<string, unknown>;
const MINUTE_MS = 60_000;
const feature = (body: { features: Item[] }, key: string) =>
  body.features.find((f) => f.key === key);

describe('admin entitlements API (spec SP4 §12.2; AD-2, AD-3, AD-4; Review Focus 2–5)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let staff: SeededPrincipal;
  let owner: SeededPrincipal;
  const orgs: SeededOrg[] = [];
  const call = (
    method: 'get' | 'put' | 'delete',
    path: string,
    o: { ifMatch?: string; body?: object } = {},
  ) => {
    let req = request(app.getHttpServer())[method](path).set('authorization', `Bearer ${staff.bearer}`);
    if (o.ifMatch !== undefined) req = req.set('if-match', o.ifMatch);
    return o.body === undefined ? req : req.send(o.body);
  };
  const orgOn = async (plan: string | undefined, opts: Parameters<typeof seedOrgEntitlement>[2] = {}) => {
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  const base = (o: SeededOrg) => `/v1/admin/orgs/${o.orgId}/entitlements`;
  const tenantView = (o: SeededOrg) => authed(app, owner).get(`/v1/orgs/${o.orgId}/entitlements`);
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, { extraImports: [FixtureFeaturesModule] });
    staff = await seedStaffPrincipal();
    owner = await seedUserPrincipal();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals([staff, owner].filter(Boolean));
    await disposeCatalogue?.();
  });

  it('GET /v1/admin/plans: the pod catalogue — default, retired, effective values per plan (PLAN or FALLBACK), deprecated hidden, no-store', async () => {
    const r = await call('get', '/v1/admin/plans');
    expect([r.status, r.headers['cache-control']]).toEqual([200, 'no-store']);
    const plan = (k: string) => (r.body.plans as ({ key: string; features: Item[] } & Record<string, unknown>)[]).find((p) => p.key === k);
    expect(r.body.defaultPlan).toBe('free');
    expect(r.body.plans.map((p: { key: string }) => p.key)).toEqual([...fixturePlans.plans.keys()].sort());
    expect(plan('legacy')).toMatchObject({ retired: true, default: false });
    expect(plan('free')).toMatchObject({ retired: false, default: true });
    expect(feature(plan('pro')!, 'tenancy.seats')).toEqual({
      key: 'tenancy.seats', kind: 'LIMIT', unlimited: false, limit: 10, source: 'PLAN', overrideExpiresAt: null,
    });
    expect(feature(plan('free')!, 'fixture.api_calls')).toEqual({
      key: 'fixture.api_calls', kind: 'QUOTA', resetPeriod: 'MONTH', unlimited: false, limit: 100, source: 'FALLBACK', overrideExpiresAt: null,
    });
    expect(feature(plan('free')!, 'fixture.legacy_pdf')).toBeUndefined();
  });
  it('GET …/entitlements: internal fields, ETag W/"version", no-store, no usage; If-None-Match → 304; unknown org, malformed id, org without a row → 404', async () => {
    const o = await orgOn('pro', { source: 'BILLING', sourceRef: 'sub_9', lastBillingSeq: 3n });
    await seedOverride(o.orgId, 'fixture.projects', { value: { limit: 4 }, reason: 'trial extension', expiresInSec: -60 });
    const r = await call('get', base(o));
    expect([r.status, r.headers.etag, r.headers['cache-control']]).toEqual([200, 'W/"1"', 'no-store']);
    expect(r.body).toMatchObject({
      orgId: o.orgId,
      version: 1,
      plan: { key: 'pro', source: 'BILLING', sourceRef: 'sub_9', reason: null },
      lastBillingSeq: '3',
    });
    expect(feature(r.body, 'fixture.projects')).toMatchObject({ unlimited: true, source: 'PLAN' });
    expect(r.body.features.some((f: Item) => 'used' in f)).toBe(false);
    expect(r.body.overrides).toEqual([
      {
        feature: 'fixture.projects', kind: 'LIMIT', unlimited: false, limit: 4, reason: 'trial extension',
        expiresAt: expect.stringMatching(/Z$/), status: 'EXPIRED', updatedAt: expect.stringMatching(/Z$/),
      },
    ]);
    expect((await call('get', base(o)).set('if-none-match', 'W/"1"')).status).toBe(304);
    expect((await call('get', `/v1/admin/orgs/${v7()}/entitlements`)).status).toBe(404);
    expect((await call('get', '/v1/admin/orgs/not-a-uuid/entitlements')).status).toBe(404);
    expect((await call('get', base(await orgOn(undefined)))).status).toBe(404);
  });
  it('AD-2: PUT …/plan — no If-Match 428, stale 412, retired 422 plan_retired, unknown 422 unknown_plan; success 200 + new ETag + a staff event without the reason; the same plan again is 200 unchanged', async () => {
    const o = await orgOn('free');
    const put = (body: object, ifMatch?: string) => call('put', `${base(o)}/plan`, { body, ifMatch });
    const good = { planKey: 'pro', reason: 'sales-approved-uplift-8821' };
    const refusals = [
      await put(good),
      await put(good, 'W/"7"'),
      await put({ ...good, planKey: 'legacy' }, 'W/"1"'),
      await put({ ...good, planKey: 'gold' }, 'W/"1"'),
    ];
    expect(refusals.map((r) => [r.status, r.body.code])).toEqual([
      [428, 'precondition_required'],
      [412, 'precondition_failed'],
      [422, 'plan_retired'],
      [422, 'unknown_plan'],
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
    const ok = await put(good, 'W/"1"');
    expect([ok.status, ok.headers.etag]).toEqual([200, 'W/"2"']);
    expect(ok.body.plan).toMatchObject({ key: 'pro', source: 'PLATFORM_ADMIN', reason: good.reason, sourceRef: null });
    const events = await outboxOf(o.orgId, 'entitlements.plan.changed');
    expect(events.map((e) => [e.payload.cause, e.payload.fromPlan, e.payload.toPlan, e.headers.actorType, e.headers.actorId, e.aggregate_version])).toEqual([
      ['PLATFORM_ADMIN', 'free', 'pro', 'user', staff.authUserId, '2'],
    ]);
    expect(JSON.stringify(events)).not.toContain(good.reason);
    const again = await put({ ...good, reason: 'a different reason' }, 'W/"2"');
    expect([again.status, again.headers.etag, again.body.plan.reason]).toEqual([200, 'W/"2"', good.reason]);
    expect(await outboxOf(o.orgId, 'entitlements.plan.changed')).toHaveLength(1);
  });
  it('AD-3: PUT …/overrides/{key} — wrong kind, below minimum, past expiry → 422 on the field; unknown or deprecated key → 404; set → tenant sees OVERRIDE; DELETE → 204 + event; again → 404', async () => {
    const o = await orgOn('pro');
    const put = (key: string, body: object, ifMatch = 'W/"1"') => call('put', `${base(o)}/overrides/${key}`, { body, ifMatch });
    const why = { reason: 'support ticket 4410', expiresAt: null };
    const refusals = [
      await put('fixture.reports', { limit: 3, ...why }),
      await put('tenancy.seats', { limit: 0, ...why }),
      await put('tenancy.seats', { enabled: true, ...why }),
      await put('tenancy.seats', { limit: 2, reason: why.reason, expiresAt: new Date(Date.now() - MINUTE_MS).toISOString() }),
      await put('fixture.nope', { enabled: true, ...why }),
      await put('fixture.legacy_pdf', { enabled: true, ...why }),
    ];
    expect(refusals.map((r) => [r.status, r.body.errors?.[0]?.path])).toEqual([
      [422, 'limit'],
      [422, 'limit'],
      [422, 'enabled'],
      [422, 'expiresAt'],
      [404, undefined],
      [404, undefined],
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
    const set = await put('fixture.reports', { enabled: false, ...why });
    expect([set.status, set.headers.etag]).toEqual([200, 'W/"2"']);
    expect(set.body.overrides).toMatchObject([{ feature: 'fixture.reports', kind: 'FLAG', enabled: false, status: 'ACTIVE', expiresAt: null }]);
    expect(feature((await tenantView(o)).body, 'fixture.reports')).toMatchObject({ enabled: false, source: 'OVERRIDE' });
    expect((await outboxOf(o.orgId, 'entitlements.override.set')).map((e) => e.payload)).toEqual([
      { orgId: o.orgId, feature: 'fixture.reports', value: { kind: 'FLAG', enabled: false }, expiresAt: null },
    ]);
    const del = await call('delete', `${base(o)}/overrides/fixture.reports`, { ifMatch: 'W/"2"' });
    expect([del.status, del.headers.etag]).toEqual([204, 'W/"3"']);
    expect((await outboxOf(o.orgId, 'entitlements.override.removed')).map((e) => e.payload)).toEqual([
      { orgId: o.orgId, feature: 'fixture.reports' },
    ]);
    expect(feature((await tenantView(o)).body, 'fixture.reports')).toMatchObject({ enabled: true, source: 'PLAN' });
    expect((await call('delete', `${base(o)}/overrides/fixture.reports`, { ifMatch: 'W/"3"' })).status).toBe(404);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(3);
  });
  it('AD-3: an override survives a plan change (S4-D11); an expired one reads as PLAN for the tenant and EXPIRED for staff', async () => {
    const o = await orgOn('pro');
    expect((await call('put', `${base(o)}/overrides/fixture.projects`, { ifMatch: 'W/"1"', body: { limit: 7, reason: 'pilot', expiresAt: null } })).status).toBe(200);
    const moved = await call('put', `${base(o)}/plan`, { ifMatch: 'W/"2"', body: { planKey: 'enterprise', reason: 'pilot plan' } });
    expect([moved.status, moved.headers.etag]).toEqual([200, 'W/"3"']);
    expect(feature(moved.body, 'fixture.projects')).toMatchObject({ unlimited: false, limit: 7, source: 'OVERRIDE' });
    expect((await readOverrides(o.orgId)).map((x) => x.feature)).toEqual(['fixture.projects']);
    const lapsed = await orgOn('pro');
    await seedOverride(lapsed.orgId, 'fixture.reports', { value: { enabled: false }, expiresInSec: -1 });
    expect(feature((await tenantView(lapsed)).body, 'fixture.reports')).toMatchObject({ enabled: true, source: 'PLAN' });
    expect((await call('get', base(lapsed))).body.overrides).toMatchObject([{ feature: 'fixture.reports', status: 'EXPIRED' }]);
  });
  it('AD-4: an org API key on /v1/admin/** → 403 api_key_not_allowed_here; an ordinary session → 403 forbidden', async () => {
    const o = await orgOn('pro');
    const key = await seedOrgApiKey(o, { createdByMemberId: o.owner.memberId, permissions: ['org.read', 'entitlements.read'] });
    const viaKey = await request(app.getHttpServer()).get(base(o)).set('x-api-key', key.token);
    expect([viaKey.status, viaKey.body.code]).toEqual([403, 'api_key_not_allowed_here']);
    const plain = await authed(app, owner).get(base(o));
    expect([plain.status, plain.body.code]).toEqual([403, 'forbidden']);
  });
  it('Review Focus 2: reasons are trimmed and measured in code points (500 emoji pass, 501 fail, blanks fail), never a 500', async () => {
    const o = await orgOn('pro');
    let version = 1;
    const put = (reason: string) =>
      call('put', `${base(o)}/overrides/fixture.projects`, { ifMatch: `W/"${version}"`, body: { limit: 3, reason, expiresAt: null } });
    expect((await put('   goodwill   ')).status).toBe(200);
    version += 1;
    expect((await readOverrides(o.orgId))[0]?.reason).toBe('goodwill');
    expect((await put('😀'.repeat(REASON_MAX_LENGTH))).status).toBe(200);
    version += 1;
    for (const bad of ['😀'.repeat(REASON_MAX_LENGTH + 1), '   ', ''])
      expect((await put(bad)).status, `${bad.length} UTF-16 units`).toBe(422);
  });
  it('Review Focus 3: DELETE removes the override of a deprecated feature (cleanup before the feature is dropped)', async () => {
    const o = await orgOn('pro');
    await withOwner((c) => c.query(`UPDATE entitlement_features SET deprecated_at = NULL WHERE key = 'fixture.legacy_pdf'`));
    try {
      await seedOverride(o.orgId, 'fixture.legacy_pdf', { value: { enabled: true } });
    } finally {
      await withOwner((c) => c.query(`UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'fixture.legacy_pdf'`));
    }
    expect((await call('delete', `${base(o)}/overrides/fixture.legacy_pdf`, { ifMatch: 'W/"1"' })).status).toBe(204);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('Review Focus 4: a soft-deleted org stays readable and writable by staff; the purge removes its overrides', async () => {
    const o = await orgOn('pro');
    const r = await withAppClient((c) =>
      inOrgTx(c, o.orgId, () =>
        c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`, [o.orgId]),
      ),
    );
    expect(r.rowCount).toBe(1);
    expect((await call('get', base(o))).status).toBe(200);
    expect((await call('put', `${base(o)}/overrides/tenancy.seats`, { ifMatch: 'W/"1"', body: { limit: 2, reason: 'retention offer', expiresAt: null } })).status).toBe(200);
    await o.dispose();
    orgs.splice(orgs.indexOf(o), 1);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('Review Focus 5: limit bounds — 2^53 − 1 kept exactly, 2^53 → 422, null on a FLAG → 422, null on a QUOTA is unlimited for consume', async () => {
    const o = await orgOn('metered');
    const put = (key: string, body: object, v: number) =>
      call('put', `${base(o)}/overrides/${key}`, { ifMatch: `W/"${v}"`, body: { ...body, reason: 'bounds', expiresAt: null } });
    const max = await put('fixture.projects', { limit: ENTITLEMENT_VALUE_MAX }, 1);
    expect([max.status, feature(max.body, 'fixture.projects')?.limit]).toEqual([200, ENTITLEMENT_VALUE_MAX]);
    expect((await put('fixture.projects', { limit: 2 ** 53 }, 2)).status).toBe(422);
    const flagNull = await put('fixture.reports', { limit: null }, 2);
    expect([flagNull.status, flagNull.body.errors?.[0]?.path]).toEqual([422, 'limit']);
    const unlimited = await put('fixture.api_calls', { limit: null }, 2);
    expect(feature(unlimited.body, 'fixture.api_calls')).toMatchObject({ unlimited: true, limit: null, source: 'OVERRIDE' });
    const consumed = await app.get(OrgScope).run(o.orgId, () =>
      app.get(UnitOfWork).run(() => app.get(Quotas).consume('fixture.api_calls', 50)),
    );
    expect(consumed.kind).toBe('CONSUMED');
  });
});
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/admin-schemas.spec.ts
pnpm vitest run --project integration test/e2e/entitlements/admin-entitlements.e2e.spec.ts
```
Expected: FAIL — `adminEntitlementsOf` chưa có; route `/v1/admin/**` trả `404`.

- [ ] **Step 4: Schema**

`src/modules/entitlements/http/schemas.ts`:
- import thêm: `type AdminView` (`'../application/admin-entitlements.query.js'`); `REASON_MAX_LENGTH` (cạnh `PLAN_SOURCES`); `OVERRIDE_STATUSES, overrideStatus, resolveEffective` (cạnh `QUOTA_STATES, VALUE_SOURCES, quotaState`); `type FeatureEntry` (cạnh `RESET_PERIODS, type MergedFeatures`); `isReason` (`'../domain/override.js'`); `type PlanCatalogue` (`'../domain/plan-catalogue.js'`); `type OverrideRow` (`'../ports/override.repository.js'`);
- thêm cuối file:
```ts
/** Lý do của nhân viên (spec §12.2): trim rồi 1–500 code point, cùng luật `CHECK` của DB (Review Focus 2). */
const reasonText = z
  .string()
  .trim()
  .refine(isReason, {
    message: `must be 1–${REASON_MAX_LENGTH} characters after trimming`,
  });
export const PutPlanBody = z
  .object({ planKey: z.string().min(1), reason: reasonText })
  .strict();
const overrideCommon = { reason: reasonText, expiresAt: iso.nullable() };
/** `{ enabled }` cho FLAG hoặc `{ limit }` cho LIMIT/QUOTA (`null` = không giới hạn); `kind`/`minimum` kiểm ở service. */
export const PutOverrideBody = z.union([
  z.object({ enabled: z.boolean(), ...overrideCommon }).strict(),
  z.object({ limit: z.int().min(0).nullable(), ...overrideCommon }).strict(),
]);

const QuotaConfigItem = z.object({
  key: z.string(),
  kind: z.literal('QUOTA'),
  resetPeriod: z.enum(RESET_PERIODS),
  ...numeric,
  source,
  overrideExpiresAt: iso.nullable(),
});
/** Giá trị hiệu lực không có usage: hàm của (aggregate, giờ), nên khớp ETag theo `version` (plan 4C, File Structure). */
const ConfigItem = z.discriminatedUnion('kind', [
  FlagItem,
  LimitItem,
  QuotaConfigItem,
]);
type ConfigItem = z.infer<typeof ConfigItem>;
const overrideMeta = {
  feature: z.string(),
  reason: z.string(),
  expiresAt: iso.nullable(),
  status: z.enum(OVERRIDE_STATUSES),
  updatedAt: iso,
};
const AdminOverrideItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('FLAG'), enabled: z.boolean(), ...overrideMeta }),
  z.object({ kind: z.literal('LIMIT'), ...numeric, ...overrideMeta }),
  z.object({ kind: z.literal('QUOTA'), ...numeric, ...overrideMeta }),
]);
type AdminOverrideItem = z.infer<typeof AdminOverrideItem>;
/** Spec §12.2: như tenant (không usage) + phần nội bộ + mọi override kể cả hết hạn. `lastBillingSeq` là BIGINT → chuỗi. */
export const AdminOrgEntitlementsResponse = z.object({
  orgId: z.uuid(),
  version: z.int().min(1),
  plan: z.object({
    key: z.string(),
    source: z.enum(PLAN_SOURCES),
    sourceRef: z.string().nullable(),
    reason: z.string().nullable(),
    assignedAt: iso,
  }),
  lastBillingSeq: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .nullable(),
  features: z.array(ConfigItem),
  overrides: z.array(AdminOverrideItem),
});
export type AdminOrgEntitlementsResponse = z.infer<
  typeof AdminOrgEntitlementsResponse
>;
export const AdminPlansResponse = z.object({
  defaultPlan: z.string(),
  plans: z.array(
    z.object({
      key: z.string(),
      retired: z.boolean(),
      default: z.boolean(),
      features: z.array(ConfigItem),
    }),
  ),
});
export type AdminPlansResponse = z.infer<typeof AdminPlansResponse>;

function configItemOf(
  key: string,
  v: EffectiveValue,
  overrideExpiresAt: string | null,
): ConfigItem {
  switch (v.kind) {
    case 'FLAG':
      return { key, kind: 'FLAG', enabled: v.enabled, source: v.source, overrideExpiresAt };
    case 'LIMIT':
      return { key, kind: 'LIMIT', ...numericOf(v.limit), source: v.source, overrideExpiresAt };
    case 'QUOTA':
      return {
        key,
        kind: 'QUOTA',
        resetPeriod: v.resetPeriod,
        ...numericOf(v.limit),
        source: v.source,
        overrideExpiresAt,
      };
    default: {
      const unknownKind: never = v;
      throw new Error(
        `unknown effective value kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}

const numericOfValue = (
  limit: number | null,
): { unlimited: boolean; limit: number | null } =>
  limit === null ? { unlimited: true, limit: null } : { unlimited: false, limit };

/** `kind` lấy từ catalogue của code (trigger của DB đã bảo đảm giá trị khớp kind); `status` theo `now()` của DB (biên `>`). */
function overrideItemOf(
  o: OverrideRow,
  f: FeatureEntry,
  now: Date,
): AdminOverrideItem {
  const meta = {
    feature: o.featureKey,
    reason: o.reason,
    expiresAt: o.expiresAt?.toISOString() ?? null,
    status: overrideStatus(o.expiresAt, now),
    updatedAt: o.updatedAt.toISOString(),
  };
  switch (f.kind) {
    case 'FLAG':
      if (o.flagValue === null)
        throw new Error(
          `the FLAG override of "${o.featureKey}" has no flag value (org_entitlement_overrides_value_ck violated?)`,
        );
      return { kind: 'FLAG', enabled: o.flagValue, ...meta };
    case 'LIMIT':
      return { kind: 'LIMIT', ...numericOfValue(o.limitValue), ...meta };
    case 'QUOTA':
      return { kind: 'QUOTA', ...numericOfValue(o.limitValue), ...meta };
    default: {
      const unknownKind: never = f;
      throw new Error(
        `unknown feature kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}

const byKey = <T extends readonly [string, unknown]>(a: T, b: T): number =>
  a[0].localeCompare(b[0]);

export function adminEntitlementsOf(
  orgId: string,
  view: AdminView,
  features: MergedFeatures,
): AdminOrgEntitlementsResponse {
  const { snapshot: s, root } = view;
  return {
    orgId,
    version: root.version,
    plan: {
      key: s.plan.key,
      source: s.plan.source,
      sourceRef: root.sourceRef,
      reason: root.reason,
      assignedAt: s.plan.assignedAt.toISOString(),
    },
    lastBillingSeq: root.lastBillingSeq?.toString() ?? null,
    features: [...s.features]
      .filter(([key]) => features.get(key)?.deprecated === false)
      .sort(byKey)
      .map(([key, v]) => configItemOf(key, v, overrideExpiryOf(s, key))),
    overrides: view.overrides.flatMap((o) => {
      const f = features.get(o.featureKey);
      return f ? [overrideItemOf(o, f, root.now)] : [];
    }),
  };
}

/** Giá trị gói không có override, nên mốc giờ của `resolveEffective` (chỉ dùng cho hạn override) không tham gia. */
const NO_OVERRIDE_CLOCK = new Date(0);

export function adminPlansOf(
  plans: PlanCatalogue,
  features: MergedFeatures,
): AdminPlansResponse {
  const active = [...features.values()]
    .filter((f) => !f.deprecated)
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    defaultPlan: plans.defaultPlan,
    plans: [...plans.plans.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((p) => ({
        key: p.key,
        retired: p.retired,
        default: p.key === plans.defaultPlan,
        features: active.map((f) =>
          configItemOf(
            f.key,
            resolveEffective(f, p.values.get(f.key), undefined, NO_OVERRIDE_CLOCK),
            null,
          ),
        ),
      })),
  };
}
```
(`byKey` thay hai chỗ `.sort(([a], [b]) => a.localeCompare(b))` mới; không sửa `orgEntitlementsOf`.)

- [ ] **Step 5: Controller và module**

`src/modules/entitlements/http/admin-entitlements.controller.ts`:
```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  etagOf,
  serialize,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { IdentityErrors, PlatformStaffAction } from '../../identity/index.js';
import type { AdminView } from '../application/admin-entitlements.query.js';
import { AdminEntitlements } from '../application/admin-entitlements.service.js';
import { EntitlementCatalogueRegistry } from '../application/entitlement-catalogue.registry.js';
import type { OverrideRequest } from '../domain/override.js';
import { EntitlementsErrors } from '../errors.js';
import {
  AdminOrgEntitlementsResponse,
  AdminPlansResponse,
  PutOverrideBody,
  PutPlanBody,
  adminEntitlementsOf,
  adminPlansOf,
} from './schemas.js';

/** Mã của gate (addendum 3D §A1.3, do identity/tenancy trả): chỉ khai trong OpenAPI, 4C không định nghĩa mã nào. */
const GATE_PROBLEMS = [
  CoreErrors.UNAUTHENTICATED,
  CoreErrors.FORBIDDEN,
  IdentityErrors.SECOND_FACTOR_REQUIRED,
  IdentityErrors.REAUTHENTICATION_REQUIRED,
  IdentityErrors.API_KEY_NOT_ALLOWED_HERE,
  CoreErrors.SERVICE_UNAVAILABLE,
] as const;
const WRITE_PROBLEMS = [
  CoreErrors.NOT_FOUND,
  CoreErrors.PRECONDITION_REQUIRED,
  CoreErrors.PRECONDITION_FAILED,
] as const;
/** Dữ liệu nội bộ của nhân viên (có `reason`): không lưu ở cache trình duyệt/proxy (plan 4C, File Structure). */
const NO_STORE = 'no-store';
const OrgIdParam = z.uuid();
/** Id không phải UUID là "không có resource như vậy" (404), không phải `400 org_context_invalid` của `OrgScope`. */
const orgIdOrNotFound = (raw: string): string => {
  const r = OrgIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};

/**
 * API quản trị (spec §12.2, S4-D15): mọi route mang `@PlatformStaffAction()` của identity (3D) làm guard route-scoped duy
 * nhất; gate, step-up và audit truy cập là của 3D. Route không khớp `v1/orgs/:orgId` nên không qua `OrgContextMiddleware`;
 * service mở `OrgScope` không qua membership (S4-D19). Org API key bị `OrgApiKeyConfinementGuard` chặn (403).
 */
@Controller('v1/admin')
export class AdminEntitlementsController {
  constructor(
    private readonly admin: AdminEntitlements,
    private readonly registry: EntitlementCatalogueRegistry,
  ) {}

  @Get('plans')
  @PlatformStaffAction()
  @ApiOk(AdminPlansResponse)
  @ApiProblems(...GATE_PROBLEMS)
  plans(@Res({ passthrough: true }) res: HeaderWriter) {
    res.setHeader('Cache-Control', NO_STORE);
    return serialize(
      AdminPlansResponse,
      adminPlansOf(this.registry.plans(), this.registry.features()),
    );
  }

  @Get('orgs/:orgId/entitlements')
  @PlatformStaffAction()
  @ApiOk(AdminOrgEntitlementsResponse)
  @ApiProblems(...GATE_PROBLEMS, CoreErrors.NOT_FOUND)
  async view(
    @Param('orgId') orgId: string,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const id = orgIdOrNotFound(orgId);
    return this.send(res, id, await this.admin.view(id));
  }

  @Put('orgs/:orgId/entitlements/plan')
  @PlatformStaffAction()
  @ApiOk(AdminOrgEntitlementsResponse)
  @ApiProblems(
    ...GATE_PROBLEMS,
    ...WRITE_PROBLEMS,
    CoreErrors.VALIDATION_FAILED,
    EntitlementsErrors.PLAN_RETIRED,
    EntitlementsErrors.UNKNOWN_PLAN,
  )
  async putPlan(
    @Param('orgId') orgId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PutPlanBody }) body: z.infer<typeof PutPlanBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const id = orgIdOrNotFound(orgId);
    return this.send(res, id, await this.admin.assignPlan(id, ifMatch, body));
  }

  @Put('orgs/:orgId/entitlements/overrides/:featureKey')
  @PlatformStaffAction()
  @ApiOk(AdminOrgEntitlementsResponse)
  @ApiProblems(...GATE_PROBLEMS, ...WRITE_PROBLEMS, CoreErrors.VALIDATION_FAILED)
  async putOverride(
    @Param('orgId') orgId: string,
    @Param('featureKey') featureKey: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PutOverrideBody }) body: z.infer<typeof PutOverrideBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const id = orgIdOrNotFound(orgId);
    const value: OverrideRequest =
      'enabled' in body ? { enabled: body.enabled } : { limit: body.limit };
    const view = await this.admin.setOverride(id, featureKey, ifMatch, {
      value,
      reason: body.reason,
      expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
    });
    return this.send(res, id, view);
  }

  @Delete('orgs/:orgId/entitlements/overrides/:featureKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PlatformStaffAction()
  @ApiProblems(...GATE_PROBLEMS, ...WRITE_PROBLEMS)
  async deleteOverride(
    @Param('orgId') orgId: string,
    @Param('featureKey') featureKey: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderWriter,
  ): Promise<void> {
    const id = orgIdOrNotFound(orgId);
    const version = await this.admin.removeOverride(id, featureKey, ifMatch);
    res.setHeader('ETag', etagOf(version));
    res.setHeader('Cache-Control', NO_STORE);
  }

  /** ETag = `org_entitlements.version` (cho `If-Match` của lần ghi sau); `304` do Express so `If-None-Match` với nó. */
  private send(res: HeaderWriter, orgId: string, view: AdminView) {
    res.setHeader('ETag', etagOf(view.root.version));
    res.setHeader('Cache-Control', NO_STORE);
    return serialize(
      AdminOrgEntitlementsResponse,
      adminEntitlementsOf(orgId, view, this.registry.features()),
    );
  }
}
```

`src/modules/entitlements/http/entitlements-http.module.ts` — import `AdminEntitlementsController`; `controllers: [OrgEntitlementsController, AdminEntitlementsController]`; chú thích thêm: `Controller admin dùng @PlatformStaffAction(): PlatformStaffGuard đến từ PlatformStaffGuardModule (@Global, IdentityModule.forApi()), không import module nội bộ của identity (addendum 3D §A1.4, PSA-5).`

- [ ] **Step 6: Chạy lại cho thấy xanh, sinh OpenAPI**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/entitlements test/unit/architecture
pnpm vitest run --project unit test/unit/modules/tenancy/org-route-inventory.spec.ts test/unit/modules/tenancy/classify-tenant-handler.spec.ts
pnpm vitest run --project integration test/e2e/entitlements test/e2e/tenancy/orgs.e2e.spec.ts
pnpm arch
pnpm build && pnpm openapi:export
git diff --stat openapi.json
```
Expected: PASS. `hardcode-scan.spec.ts` xanh (không `limit: <số>` trong `src`). Mỗi lần dựng app e2e chạy `OrgRouteInventory` của tenancy và `EntitlementRouteInventory` lúc boot: route `v1/admin/orgs/:orgId/...` xếp `OTHER` (hai segment đầu `v1/admin` là literal, không khớp `v1/orgs/`), nên app khởi động — chính việc các ca e2e chạy được là bằng chứng. `openapi.json` chỉ thêm năm operation dưới `/v1/admin/` và các schema mới; không đổi schema cũ.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements/admin-schemas.spec.ts test/e2e/entitlements/admin-entitlements.e2e.spec.ts openapi.json
git add src/modules/entitlements test/unit/modules/entitlements/admin-schemas.spec.ts test/e2e/entitlements/admin-entitlements.e2e.spec.ts openapi.json
git commit -m "feat(entitlements): the staff admin API for plans and overrides behind @PlatformStaffAction, with If-Match, ETag and no-store"
```

---
### Task 10: AD-1 — bộ ca chuẩn của 3D (`describePlatformStaffActionConformance`, C1–C10 + PSA-7) trên **từng** route admin của SP4, ở cả ba `AUTH_MODE`

Bộ ca của 3D dựng app bằng `startTenancyApp`, vốn mặc định góp catalogue quyền `EntitlementPermissions` riêng (`EntitlementPermissionsCatalogueModule`); app có `EntitlementsModule` mà góp thêm lần nữa thì `PermissionCatalogueRegistry` từ chối boot (`Permission catalogue "entitlements" is contributed twice`, chú thích của `test/support/entitlement-permissions.module.ts`). Task này thêm một tuỳ chọn cộng thêm vào `ConformanceOptions` (cùng tên và nghĩa với tuỳ chọn của `startTenancyApp`), không đổi hành vi của caller hiện có (vắng = `true`).

**Files:**
- Modify (test support của 3D): `test/support/platform-staff-action.conformance.ts`
- Create (test): `test/e2e/entitlements/admin-conformance.e2e.spec.ts`

**Interfaces:**
- Consumes: `describePlatformStaffActionConformance(name, target, opts)`, `type PlatformStaffConformanceTarget`, `type ConformanceOptions` (`extraImports`, `modes`, `handlerCalls`) (3D); `startTenancyApp({ entitlementPermissions })`; `EntitlementsModule.forApi(plans)`; `examplePlans` (`src/plans.example.ts`: `free`, `pro`, khớp hai dòng `plans` của migration mẫu); `AdminEntitlementsController` (Task 9: method `plans`, `view`, `putPlan`, `putOverride`, `deleteOverride`); `seedOrg`, `seedOrgEntitlement`, `seedOverride`.
- Produces: `ConformanceOptions.entitlementPermissions?: boolean` (truyền thẳng vào `startTenancyApp`); 5 × 3 khối conformance (C1–C10 mỗi khối; PSA-7 ở `local`/`hybrid`).

- [ ] **Step 1: Tuỳ chọn của bộ ca**

`test/support/platform-staff-action.conformance.ts`:
- `ConformanceOptions` thêm trường cuối:
```ts
  /** `false` khi `extraImports` có `EntitlementsModule`: catalogue quyền của nó không được góp hai lần (như `startEntitlementsApp`). */
  readonly entitlementPermissions?: boolean;
```
- trong `beforeAll`, lời gọi `startTenancyApp` thành:
```ts
        app = await startTenancyApp({
          env,
          extraImports: [ConformanceAuditModule, ...(opts.extraImports ?? [])],
          entitlementPermissions: opts.entitlementPermissions,
        });
```

- [ ] **Step 2: Viết test**

`test/e2e/entitlements/admin-conformance.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, vi } from 'vitest';
import { AdminEntitlementsController } from '../../../src/modules/entitlements/http/admin-entitlements.controller.js';
import { EntitlementsModule } from '../../../src/modules/entitlements/index.js';
import { examplePlans } from '../../../src/plans.example.js';
import {
  seedOrgEntitlement,
  seedOverride,
} from '../../support/entitlements-seed.js';
import {
  describePlatformStaffActionConformance,
  type ConformanceOptions,
} from '../../support/platform-staff-action.conformance.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

type Mode = 'local' | 'hybrid' | 'external';
type Route = 'view' | 'plan' | 'override' | 'remove';
const MODES: readonly Mode[] = ['local', 'hybrid', 'external'];
const ROUTES: readonly Route[] = ['view', 'plan', 'override', 'remove'];
const IF_MATCH = { 'if-match': 'W/"1"' };

/**
 * Mỗi route × mode một org ở `version` 1: trong bộ ca chỉ C9 tới handler (một lần mỗi mode; C10 và PSA-7 dừng ở port audit,
 * mọi ca khác dừng ở gate), nên `If-Match: W/"1"` đúng đúng lúc nó cần đúng.
 */
const orgs = new Map<string, SeededOrg>();
const orgFor = (route: Route, mode: Mode): string => {
  const o = orgs.get(`${route}:${mode}`);
  if (!o) throw new Error(`conformance org ${route}:${mode} was not seeded`);
  return o.orgId;
};
/** Spy trên prototype đặt TRƯỚC khi bộ ca dựng app (spike S4C-2 (b')): đếm lần chạy handler thật cho C9/C10. */
const spies = (
  ['plans', 'view', 'putPlan', 'putOverride', 'deleteOverride'] as const
).map((m) => vi.spyOn(AdminEntitlementsController.prototype, m));
const opts: ConformanceOptions = {
  extraImports: [EntitlementsModule.forApi(examplePlans)],
  entitlementPermissions: false,
  handlerCalls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
};

beforeAll(async () => {
  for (const route of ROUTES)
    for (const mode of MODES) {
      const o = await seedOrg();
      await seedOrgEntitlement(o.orgId, 'free');
      if (route === 'remove')
        await seedOverride(o.orgId, 'tenancy.seats', { value: { limit: 3 } });
      orgs.set(`${route}:${mode}`, o);
    }
});
afterAll(async () => {
  for (const o of orgs.values()) await o.dispose();
  vi.restoreAllMocks();
});

describePlatformStaffActionConformance(
  'GET /v1/admin/plans',
  () => ({ method: 'GET', path: '/v1/admin/plans', expectAllowedStatus: 200 }),
  opts,
);
describePlatformStaffActionConformance(
  'GET /v1/admin/orgs/{orgId}/entitlements',
  ({ mode }) => ({
    method: 'GET',
    path: `/v1/admin/orgs/${orgFor('view', mode)}/entitlements`,
    expectAllowedStatus: 200,
  }),
  opts,
);
describePlatformStaffActionConformance(
  'PUT /v1/admin/orgs/{orgId}/entitlements/plan',
  ({ mode }) => ({
    method: 'PUT',
    path: `/v1/admin/orgs/${orgFor('plan', mode)}/entitlements/plan`,
    headers: IF_MATCH,
    body: { planKey: 'pro', reason: 'conformance plan' },
    expectAllowedStatus: 200,
  }),
  opts,
);
describePlatformStaffActionConformance(
  'PUT /v1/admin/orgs/{orgId}/entitlements/overrides/{featureKey}',
  ({ mode }) => ({
    method: 'PUT',
    path: `/v1/admin/orgs/${orgFor('override', mode)}/entitlements/overrides/tenancy.seats`,
    headers: IF_MATCH,
    body: { limit: 5, reason: 'conformance override', expiresAt: null },
    expectAllowedStatus: 200,
  }),
  opts,
);
describePlatformStaffActionConformance(
  'DELETE /v1/admin/orgs/{orgId}/entitlements/overrides/{featureKey}',
  ({ mode }) => ({
    method: 'DELETE',
    path: `/v1/admin/orgs/${orgFor('remove', mode)}/entitlements/overrides/tenancy.seats`,
    headers: IF_MATCH,
    expectAllowedStatus: 204,
  }),
  opts,
);
```
(Hook gốc của file chạy trước `beforeAll` của từng khối conformance, nên org có trước khi app đầu tiên nhận request. Body của C9 không lặp lại trong entry: `reason`, `planKey` không phải path param.)

- [ ] **Step 3: Chạy**

Run: `pnpm vitest run --project integration test/e2e/entitlements/admin-conformance.e2e.spec.ts test/e2e/identity/platform-staff-action.e2e.spec.ts`
Expected: PASS: 5 route × 3 mode, mỗi khối C1–C10 (C5–C7 chỉ `local`/`hybrid`, C8 chỉ `external`) và PSA-7 ở `local`/`hybrid`; ca 3D của chính bộ ca vẫn xanh (tuỳ chọn mới vắng = hành vi cũ). Một ca đỏ ở đây nghĩa là route lệch hợp đồng của addendum 3D: sửa route (không sửa bộ ca, không tự đặt mã lỗi).

- [ ] **Step 4: Ca 3D vẫn đúng với tuỳ chọn vắng**

Run:
```bash
pnpm vitest run --project integration test/integration/tenancy/platform-staff-di.spec.ts
pnpm test:chaos -- test/chaos/delegation-outages.spec.ts
```
Expected: PASS (hai caller khác của `@PlatformStaffAction()`/`startTenancyApp` không đổi).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write test/support/platform-staff-action.conformance.ts test/e2e/entitlements/admin-conformance.e2e.spec.ts
git add test/support/platform-staff-action.conformance.ts test/e2e/entitlements/admin-conformance.e2e.spec.ts
git commit -m "test(entitlements): run the 3D platform staff conformance suite on every SP4 admin route in all three auth modes (AD-1)"
```

- [ ] **Step 6: Phần inventory của AD-1 (R-X17, spec §20.3) — chỉ khi 6B đã merge**

Run: `git fetch origin && git grep -n "PlatformStaffRouteInventory" origin/main -- src || echo "6B not merged"`
- `6B not merged` (trường hợp dự kiến: 6B chưa có plan): **không** viết ca inventory. Theo spec §20.3 và §21 (đoạn "4C ∥ 6B"), ca inventory trên route SP4 thuộc plan merge **sau** trong cặp 4C/6B; khi 6B merge sau 4C, A-26 của SP6 chạy trên tập route thật có năm route trên. Ghi "AD-1 phần inventory: carry sang 6B (6B merge sau)" vào báo cáo task và mô tả PR.
- Có kết quả (6B đã merge trước): dừng, báo controller. API của `PlatformStaffRouteInventory` chỉ có trong code của 6B; ca phải theo đúng chữ ký đó (app có năm route SP4 → khởi động không báo thiếu; fixture route SP4 bỏ decorator → không khởi động), không đoán.

---

### Task 11: AD-5 — billing khẳng định lại gói mỗi kỳ đã trả, đối đầu với thao tác của nhân viên (R-X18, S4-D11, spec §10.3)

Lệnh billing gửi bằng `PlanAssignments.assign` cause `BILLING` trong một `UnitOfWork` fixture (4C chạy trước SP5, như PA-14 của 4A); thao tác nhân viên đi qua HTTP thật.

**Files:**
- Create (test): `test/e2e/entitlements/admin-billing-reassert.e2e.spec.ts`

**Interfaces:**
- Consumes: `PlanAssignments.assign(cmd): Promise<AssignmentResult>`, `type AssignmentResult` (`modules/entitlements/index.ts`); route admin (Task 9); `startEntitlementsApp`; `fixturePlans` (`legacy` retired, `free`, `pro`), `seedFixtureCatalogue`, `FixtureFeaturesModule`; `seedOrgEntitlement`, `readOrgEntitlement`, `readOverrides`, `outboxOf`; `seedStaffPrincipal`.
- Produces: bốn ca AD-5 (a)–(d); không code src.

- [ ] **Step 1: Viết test**

`test/e2e/entitlements/admin-billing-reassert.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import {
  PlanAssignments,
  type AssignmentResult,
} from '../../../src/modules/entitlements/index.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const SUB = 'sub_1';

describe('AD-5: billing reasserts the plan every paid period against staff actions (spec SP4 §10.3, S4-D11, R-X18)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let staff: SeededPrincipal;
  const orgs: SeededOrg[] = [];
  /** "Transaction billing" của SP5: UoW + OrgScope, không principal (job của SP5) → actor `system` `billing`. */
  const billing = (orgId: string, planKey: string, sequence: bigint): Promise<AssignmentResult> =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() =>
        app.get(PlanAssignments).assign({ planKey, cause: { kind: 'BILLING', ref: SUB, sequence } }),
      ),
    );
  const admin = (o: SeededOrg) => `/v1/admin/orgs/${o.orgId}/entitlements`;
  const etag = async (o: SeededOrg): Promise<string> =>
    String(
      (await request(app.getHttpServer()).get(admin(o)).set('authorization', `Bearer ${staff.bearer}`)).headers.etag,
    );
  const staffPut = async (o: SeededOrg, path: string, body: object) =>
    request(app.getHttpServer())
      .put(`${admin(o)}${path}`)
      .set('authorization', `Bearer ${staff.bearer}`)
      .set('if-match', await etag(o))
      .send(body);
  const billedOrg = async () => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, 'free', { source: 'BILLING', sourceRef: SUB, lastBillingSeq: 1n });
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, { extraImports: [FixtureFeaturesModule] });
    staff = await seedStaffPrincipal();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    if (staff) await deleteSeededPrincipals([staff]);
    await disposeCatalogue?.();
  });

  it('(a) the billed plan is retired: REJECTED_RETIRED each period; the staff plan set in between stays; last_billing_seq advances', async () => {
    const o = await billedOrg();
    expect(await billing(o.orgId, 'legacy', 2n)).toEqual({ kind: 'REJECTED_RETIRED', planKey: 'legacy' });
    const put = await staffPut(o, '/plan', { planKey: 'pro', reason: 'rejected-retired runbook' });
    expect([put.status, put.body.plan.source]).toEqual([200, 'PLATFORM_ADMIN']);
    expect(await billing(o.orgId, 'legacy', 3n)).toEqual({ kind: 'REJECTED_RETIRED', planKey: 'legacy' });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'pro', source: 'PLATFORM_ADMIN', lastBillingSeq: '3' });
  });
  it('(b)+(c) staff moves a billed org to pro; the next paid period reasserts free → APPLIED back to BILLING (billing actor), the earlier override stays; the period after is UNCHANGED', async () => {
    const o = await billedOrg();
    expect((await staffPut(o, '/overrides/fixture.projects', { limit: 7, reason: 'pilot', expiresAt: null })).status).toBe(200);
    expect((await staffPut(o, '/plan', { planKey: 'pro', reason: 'goodwill' })).status).toBe(200);
    expect(await billing(o.orgId, 'free', 2n)).toEqual({ kind: 'APPLIED', fromPlan: 'pro', toPlan: 'free', version: 4 });
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({ planKey: 'free', source: 'BILLING', sourceRef: SUB, reason: null });
    expect(
      (await outboxOf(o.orgId, 'entitlements.plan.changed')).map((e) => [e.payload.cause, e.headers.actorType, e.headers.actorId]),
    ).toEqual([
      ['PLATFORM_ADMIN', 'user', staff.authUserId],
      ['BILLING', 'system', 'billing'],
    ]);
    expect((await readOverrides(o.orgId)).map((r) => [r.feature, r.limitValue])).toEqual([['fixture.projects', 7]]);
    // (c): kỳ kế tiếp nữa, cùng gói cùng subscription → UNCHANGED: không version, không event, chỉ ghi nhận seq.
    expect(await billing(o.orgId, 'free', 3n)).toEqual({ kind: 'UNCHANGED', version: 4 });
    expect(await outboxOf(o.orgId, 'entitlements.plan.changed')).toHaveLength(2);
    expect((await readOrgEntitlement(o.orgId))?.lastBillingSeq).toBe('3');
  });
  it('(d) staff assigns the very plan billing pays for; the next period reasserts it → APPLIED with fromPlan = toPlan, source back to BILLING', async () => {
    const o = await billedOrg();
    const put = await staffPut(o, '/plan', { planKey: 'free', reason: 'manual confirmation' });
    expect([put.status, put.headers.etag, put.body.plan.source]).toEqual([200, 'W/"2"', 'PLATFORM_ADMIN']);
    expect(await billing(o.orgId, 'free', 2n)).toEqual({ kind: 'APPLIED', fromPlan: 'free', toPlan: 'free', version: 3 });
    expect((await readOrgEntitlement(o.orgId))?.source).toBe('BILLING');
  });
});
```

- [ ] **Step 2: Chạy**

Run: `pnpm vitest run --project integration test/e2e/entitlements/admin-billing-reassert.e2e.spec.ts`
Expected: PASS (hồi quy của `decideAssignment` 4A qua route thật của 4C; không có code mới, nên không có bước đỏ-trước: test này khẳng định hợp đồng R-X18 giữ nguyên khi đường nhân viên đi qua HTTP).

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write test/e2e/entitlements/admin-billing-reassert.e2e.spec.ts
git add test/e2e/entitlements/admin-billing-reassert.e2e.spec.ts
git commit -m "test(entitlements): billing reasserts the paid plan each period over staff assignments while overrides survive (AD-5)"
```

---
## Phần E — Race, sự cố, riêng tư (spec §17, §18, §16, §20.4)

### Task 12: Race của ghi override và gán gói của nhân viên trên Postgres thật — ép xen kẽ và ×50 (E-7, E-8, E-4/E-15, E-6b, E-11c)

**Files:**
- Create (test): `test/integration/entitlements/overrides-races.spec.ts`

**Interfaces:**
- Consumes: `AdminEntitlements.setOverride/assignPlan` (Task 8), `Overrides.set` (Task 7), `PlanAssignments.assign`, `Quotas.consume`; `PurgeOrgHandler.handle(jobCtx)` (`src/modules/tenancy/application/purge-orgs.handler.ts`, trả `'purged'` khi xong); `holdEntitlementRow`, `holdInOrg`, `waitForBlocked` (`test/support/entitlements-races.ts`); `Db.execute`, `pgFields`; `installOtelCapture`; `readOverrides`, `readOrgEntitlement`, `outboxOf`, `seedOrgEntitlement`.
- Produces: bảng race 4C ở Self-review mục 2, mỗi dòng một ca; không code src.

- [ ] **Step 1: Viết test**

`test/integration/entitlements/overrides-races.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import {
  Db,
  OrgScope,
  UnitOfWork,
  pgFields,
} from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import type { AdminView } from '../../../src/modules/entitlements/application/admin-entitlements.query.js';
import { AdminEntitlements } from '../../../src/modules/entitlements/application/admin-entitlements.service.js';
import { Overrides } from '../../../src/modules/entitlements/application/overrides.service.js';
import {
  PlanAssignments,
  Quotas,
} from '../../../src/modules/entitlements/index.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  holdEntitlementRow,
  holdInOrg,
  waitForBlocked,
} from '../../support/entitlements-races.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const RUNS = 50;
const DEADLOCK = '40P01';
const RESTRICT = '23001';
const STAFF = '0198c000-0000-7000-8000-00000000c7a3';
/** Hạn chót cho "không bị khoá chặn": dưới idle_in_transaction_session_timeout 10 s (như quotas-races của 4B). */
const NOT_BLOCKED_MS = 3_000;
const v1 = 'W/"1"';
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'race',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('race'),
});
const settle = <T>(p: Promise<T>): Promise<T | Error> =>
  p.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
/** Tên kết quả: mã `AppError`, SQLSTATE, tên lớp lỗi, hoặc `ok`. */
const outcome = (r: unknown): string =>
  r instanceof AppError
    ? r.error.code
    : r instanceof Error
      ? (pgFields(r)?.sqlState ?? `error:${r.name}`)
      : 'ok';
/** Một cửa: `wait` chờ tới khi `open()`; ép thứ tự xen kẽ bên trong `UnitOfWork.run` của code thật, không ngủ. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
/** `promise` thành `'blocked'` sau `NOT_BLOCKED_MS`; `cancel()` trong `finally` để không để lại timer sau `Promise.race`. */
function blockedTimer(): { promise: Promise<'blocked'>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'blocked'>((resolve) => {
    handle = setTimeout(() => resolve('blocked'), NOT_BLOCKED_MS);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

describe('override and staff plan races with row-lock barriers (spec SP4 §17)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const asStaff = <T>(fn: () => Promise<T>) =>
    app.get(ClsService).run(() => {
      app.get(RequestContext).setPrincipal({ type: 'user', id: STAFF });
      return fn();
    });
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  const setOverride = (orgId: string, key: string, limit: number | null, ifMatch = v1) =>
    settle(
      asStaff(() =>
        app.get(AdminEntitlements).setOverride(orgId, key, ifMatch, { value: { limit }, reason: 'race', expiresAt: null }),
      ),
    );
  const assignPlan = (orgId: string, planKey: string, ifMatch = v1) =>
    settle(asStaff(() => app.get(AdminEntitlements).assignPlan(orgId, ifMatch, { planKey, reason: 'race' })));
  const billing = (orgId: string, planKey: string, sequence: bigint) =>
    settle(
      inTx(orgId, () =>
        app.get(PlanAssignments).assign({ planKey, cause: { kind: 'BILLING', ref: 'sub_1', sequence } }),
      ),
    );
  const consume = (orgId: string, key: string, n = 1) =>
    settle(inTx(orgId, () => app.get(Quotas).consume(key, n)));
  /** Override của nhân viên mở dở: ghi xong (khoá gốc + dòng + version) rồi chờ `release`; trả pid để `waitForBlocked`. */
  const openOverrideWrite = (orgId: string, key: string, limit: number) => {
    const written = gate();
    const release = gate();
    let pid = -1;
    const done = settle(
      asStaff(() =>
        inTx(orgId, async () => {
          const v = await app
            .get(Overrides)
            .set(key, { value: { limit }, reason: 'race', expiresAt: null }, v1);
          const [row] = await app.get(Db).execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          pid = row?.pid ?? -1;
          written.open();
          await release.wait;
          return v;
        }),
      ),
    );
    return { written: written.wait, release: release.open, done, pid: () => pid };
  };
  const softDeleteDue = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(c, orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
          [orgId],
        ),
      ),
    );
  const purgeOnce = (orgId: string) =>
    settle(app.get(OrgScope).run(orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(orgId))));
  const orgOn = async (plan: string, opts: Parameters<typeof seedOrgEntitlement>[2] = {}) => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
  };
  const versionsOf = async (orgId: string) =>
    (
      await Promise.all(
        ['entitlements.override.set', 'entitlements.plan.changed'].map((t) => outboxOf(orgId, t)),
      )
    )
      .flat()
      .map((e) => e.aggregate_version)
      .sort();
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]));
  }, 120_000);
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it(`E-7: two staff PUTs of one override with the same ETag → exactly one wins, one 412; the winner's value and one event, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('pro');
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [setOverride(o.orgId, 'fixture.projects', 3), setOverride(o.orgId, 'fixture.projects', 4)];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const rs = await Promise.all(racing);
      expect(rs.map(outcome).sort(), `run ${i}`).toEqual(['ok', 'precondition_failed']);
      const winner = rs.find((r): r is AdminView => !(r instanceof Error));
      expect((await readOverrides(o.orgId)).map((r) => r.limitValue), `run ${i}`).toEqual([
        winner?.overrides[0]?.limitValue,
      ]);
      expect((await outboxOf(o.orgId, 'entitlements.override.set')).map((e) => e.aggregate_version), `run ${i}`).toEqual(['2']);
    }
  }, 300_000);
  it(`E-7: two staff plan PUTs with the same ETag → one 200, one 412 counted as precondition_failed; the plan is the winner's, ×${RUNS}`, async () => {
    const before =
      (await otel.metric('entitlements_plan_assignments_total', { cause: 'PLATFORM_ADMIN', result: 'precondition_failed' })) ?? 0;
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('free');
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [assignPlan(o.orgId, 'pro'), assignPlan(o.orgId, 'enterprise')];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const rs = await Promise.all(racing);
      expect(rs.map(outcome).sort(), `run ${i}`).toEqual(['ok', 'precondition_failed']);
      const winner = rs.find((r): r is AdminView => !(r instanceof Error));
      expect((await readOrgEntitlement(o.orgId))?.planKey, `run ${i}`).toBe(winner?.snapshot.plan.key);
      expect(await outboxOf(o.orgId, 'entitlements.plan.changed'), `run ${i}`).toHaveLength(1);
    }
    expect(
      await otel.metric('entitlements_plan_assignments_total', { cause: 'PLATFORM_ADMIN', result: 'precondition_failed' }),
    ).toBe(before + RUNS);
  }, 300_000);
  it(`E-7: an override PUT and a plan PUT with the same ETag → one wins, one 412 (one aggregate, one lock), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('free');
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [setOverride(o.orgId, 'tenancy.seats', 2), assignPlan(o.orgId, 'pro')];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      expect((await Promise.all(racing)).map(outcome).sort(), `run ${i}`).toEqual(['ok', 'precondition_failed']);
      expect((await readOrgEntitlement(o.orgId))?.version, `run ${i}`).toBe(2);
    }
  }, 300_000);
  it('E-8 (forced, override first): a billing command waits on the open override write, then applies on top of it; the override stays and versions are 2 then 3', async () => {
    const o = await orgOn('free', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 1n });
    const w = openOverrideWrite(o.orgId, 'fixture.projects', 9);
    await w.written;
    const billed = billing(o.orgId, 'pro', 2n);
    await waitForBlocked(w.pid(), 1);
    w.release();
    expect(await w.done).toBe(2);
    expect(await billed).toEqual({ kind: 'APPLIED', fromPlan: 'free', toPlan: 'pro', version: 3 });
    expect((await readOverrides(o.orgId)).map((r) => r.limitValue)).toEqual([9]);
    expect(await versionsOf(o.orgId)).toEqual(['2', '3']);
  });
  it(`E-8: staff override ∥ billing command → billing always applies; the staff write wins its race or gets 412 (never a lost update, never a deadlock), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('free', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 1n });
      const holder = await holdEntitlementRow(o.orgId);
      const racing = [setOverride(o.orgId, 'fixture.projects', 5), billing(o.orgId, 'pro', 2n)];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const [staffWrite, billed] = await Promise.all(racing);
      expect(outcome(billed), `run ${i}`).toBe('ok');
      expect(['ok', 'precondition_failed'], `run ${i}`).toContain(outcome(staffWrite));
      const applied = outcome(staffWrite) === 'ok';
      expect((await readOverrides(o.orgId)).map((r) => r.limitValue), `run ${i}`).toEqual(applied ? [5] : []);
      expect(await readOrgEntitlement(o.orgId), `run ${i}`).toMatchObject({ planKey: 'pro', source: 'BILLING', version: applied ? 3 : 2 });
      expect(await versionsOf(o.orgId), `run ${i}`).toEqual(applied ? ['2', '3'] : ['2']);
    }
  }, 300_000);
  it('E-4/E-15 (forced, override first): a consume completes while an override write holds the root row, with the old limit; after the commit the next consume sees the new one (OVER_LIMIT is valid)', async () => {
    const o = await orgOn('metered');
    const w = openOverrideWrite(o.orgId, 'fixture.api_calls', 1);
    await w.written;
    const timer = blockedTimer();
    try {
      const c = await Promise.race([consume(o.orgId, 'fixture.api_calls', 2), timer.promise]);
      expect(c === 'blocked' || c instanceof Error ? c : c.kind).toBe('CONSUMED');
    } finally {
      timer.cancel();
      w.release();
    }
    expect(await w.done).toBe(2);
    expect(await consume(o.orgId, 'fixture.api_calls', 1)).toEqual({ kind: 'EXCEEDED', limit: 1, used: 2 });
  });
  it('E-4/E-15 (forced, consume first): an override write completes while an open consume holds its counter and FOR KEY SHARE on the root row', async () => {
    const o = await orgOn('metered');
    const consumed = gate();
    const release = gate();
    const consuming = settle(
      inTx(o.orgId, async () => {
        const r = await app.get(Quotas).consume('fixture.api_calls', 1);
        consumed.open();
        await release.wait;
        return r;
      }),
    );
    await consumed.wait;
    const timer = blockedTimer();
    try {
      const w = await Promise.race([setOverride(o.orgId, 'fixture.api_calls', 2), timer.promise]);
      expect(w === 'blocked' ? w : outcome(w)).toBe('ok');
    } finally {
      timer.cancel();
      release.open();
    }
    expect(outcome(await consuming)).toBe('ok');
  });
  it('E-6b: an override write never waits on the organizations row lock that MemberAdmission holds (lock order §3.6)', async () => {
    const o = await orgOn('metered');
    const admission = await holdInOrg(
      o.orgId,
      'SELECT 1 FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE',
      [],
      1,
    );
    const timer = blockedTimer();
    try {
      const w = await Promise.race([setOverride(o.orgId, 'tenancy.seats', 1), timer.promise]);
      expect(w === 'blocked' ? w : outcome(w)).toBe('ok');
    } finally {
      timer.cancel();
      await admission.release();
    }
  });
  it('E-11c (deterministic, override first): an open override write holds the root row while the purge waits → purge 23001, the retry purges everything', async () => {
    const o = await orgOn('pro');
    await softDeleteDue(o.orgId);
    const w = openOverrideWrite(o.orgId, 'fixture.projects', 3);
    await w.written;
    const purging = purgeOnce(o.orgId);
    await waitForBlocked(w.pid(), 1);
    w.release();
    expect(await w.done).toBe(2);
    expect(outcome(await purging)).toBe(RESTRICT);
    expect(await purgeOnce(o.orgId)).toBe('purged');
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('E-11c (deterministic, purge first): the purge deleted the root row uncommitted → the waiting override write answers 404 once it commits', async () => {
    const o = await orgOn('pro');
    const purger = await holdInOrg(o.orgId, 'DELETE FROM org_entitlements WHERE org_id = app_current_org()', [], 1);
    const writing = setOverride(o.orgId, 'fixture.projects', 3);
    await waitForBlocked(purger.pid, 1);
    await purger.commitWith('SELECT 1');
    expect(outcome(await writing)).toBe('not_found');
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it(`E-11c: purge ∥ override write → no deadlock; the write is 404 or its row is removed by the purge (after one retry), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('pro');
      await softDeleteDue(o.orgId);
      const [p, w] = await Promise.all([purgeOnce(o.orgId), setOverride(o.orgId, 'fixture.projects', 3)]);
      for (const r of [p, w]) expect(outcome(r), `run ${i}`).not.toBe(DEADLOCK);
      expect(['ok', 'not_found'], `run ${i}`).toContain(outcome(w));
      if (p instanceof Error) {
        expect(outcome(p), `run ${i}`).toBe(RESTRICT);
        expect(await purgeOnce(o.orgId), `run ${i}`).toBe('purged');
      } else expect(p, `run ${i}`).toBe('purged');
      expect(await readOverrides(o.orgId), `run ${i}`).toEqual([]);
    }
  }, 300_000);
});
```

- [ ] **Step 2: Chạy (hai lần: race phải xanh ổn định)**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements/overrides-races.spec.ts
pnpm vitest run --project integration test/integration/entitlements/overrides-races.spec.ts
```
Expected: PASS cả hai lần, không ca nào `40P01`, không `blocked`. Ghi thời gian chạy vào báo cáo task (mô tả PR dùng). Ca nào đỏ là race thật: tìm nguyên nhân gốc (thứ tự khoá, câu khoá có JOIN, đồng hồ trước khoá…), sửa ở task gốc của code đó, không nới kỳ vọng.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write test/integration/entitlements/overrides-races.spec.ts
git add test/integration/entitlements/overrides-races.spec.ts
git commit -m "test(entitlements): staff override and plan races — If-Match under the root lock, billing on top, consume and admission never blocked, purge both ways"
```

---

### Task 13: Sự cố và riêng tư — DB mất giữa câu ghi override → 503, không ghi gì (F-1); không `reason` nào trong log hay event của đường admin (A9, §20.4)

**Files:**
- Modify (test): `test/chaos/entitlements-outages.spec.ts`
- Create (test): `test/e2e/entitlements/admin-pii-logs.e2e.spec.ts`

**Interfaces:**
- Consumes: `startTcpProxy`, `TcpProxy` (`test/support/tcp-proxy.ts`); `SqlOverrideRepository.upsert` (Task 6); các helper sẵn có của file chaos (`proxy`, `app`, `owner`, `OUTAGE_BOUND_MS`, `RECOVERY`); `seedStaffPrincipal`, `deleteSeededPrincipals`; `readOverrides`, `readOrgEntitlement`, `outboxOf`, `seedOrgEntitlement`; `startAppProcess`, `stopAppProcess`, `type AppProcess` (`test/support/app-process.ts`, `output()`), `baseTestEnv` (`test/support/env.ts`); `seedOrg`.
- Produces: một ca chaos, một ca PII bằng process thật; không code src.

- [ ] **Step 1: Ca chaos**

`test/chaos/entitlements-outages.spec.ts`:
- import thêm: `request` từ `'supertest'`; `SqlOverrideRepository` từ `'../../src/modules/entitlements/infra/sql/sql-override.repository.js'`; `outboxOf`, `readOverrides` (cạnh `readCounters, readOrgEntitlement, seedOrgEntitlement`); `seedStaffPrincipal` (cạnh `deleteSeededPrincipals, seedUserPrincipal`);
- helper cạnh `armConsume`:
```ts
  /** Bật blackhole ngay trước câu upsert override thật (một lần): khoá dòng gốc đã lấy, lỗi rơi vào câu ghi. */
  const armOverrideUpsert = () => {
    const repo = app.get(SqlOverrideRepository);
    const original = repo.upsert.bind(repo);
    vi.spyOn(repo, 'upsert').mockImplementationOnce((o) => {
      proxy.state.blackhole = true;
      return original(o);
    });
  };
```
- ca cuối `describe`:
```ts
  it('admin override: DB lost at the upsert → 503 within the bound; no override, no version change, no event; the retry succeeds', async () => {
    const staff = await seedStaffPrincipal();
    const target = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedOrgEntitlement(target.orgId, 'metered');
    const put = () =>
      request(app.getHttpServer())
        .put(`/v1/admin/orgs/${target.orgId}/entitlements/overrides/tenancy.seats`)
        .set('authorization', `Bearer ${staff.bearer}`)
        .set('if-match', 'W/"1"')
        .send({ limit: 1, reason: 'chaos', expiresAt: null });
    try {
      armOverrideUpsert();
      let status: number;
      try {
        const started = performance.now();
        const r = await put();
        expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
        status = r.status;
      } finally {
        proxy.state.blackhole = false;
      }
      expect(status).toBe(503);
      await vi.waitFor(async () => expect(await readOverrides(target.orgId)).toEqual([]), RECOVERY);
      expect((await readOrgEntitlement(target.orgId))?.version).toBe(1);
      expect(await outboxOf(target.orgId, 'entitlements.override.set')).toEqual([]);
      await vi.waitFor(async () => expect((await put()).status).toBe(200), RECOVERY);
    } finally {
      await target.dispose();
      await deleteSeededPrincipals([staff]);
    }
  });
```

- [ ] **Step 2: Ca PII bằng process thật**

`test/e2e/entitlements/admin-pii-logs.e2e.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import {
  outboxOf,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { baseTestEnv } from '../../support/env.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const FLUSH_MS = 1_000;
const PROCESS_ENV: Record<string, string> = {
  LOG_LEVEL: 'debug',
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
};
const EVENT_TYPES = [
  'entitlements.override.set',
  'entitlements.override.removed',
  'entitlements.plan.changed',
] as const;

/** Spec SP4 §16 A9, §19, §20.4: `reason` của nhân viên không bao giờ vào log (kể cả DEBUG) hay event; chỉ ở cột của DB. */
describe('no staff reason in logs or events of the 4C admin paths (real api process, production logging)', () => {
  let api: AppProcess | undefined;
  let base = '';
  let staff: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  beforeAll(async () => {
    api = await startAppProcess('test/support/api-entry.ts', { ...baseTestEnv(), ...PROCESS_ENV });
    base = `http://127.0.0.1:${api.port}`;
    staff = await seedStaffPrincipal();
    org = await seedOrg();
    await seedOrgEntitlement(org.orgId, 'free');
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await org?.dispose();
    if (staff) await deleteSeededPrincipals([staff]);
  });

  it('200, 422, 412, 404 and 204 on the plan and override routes log no reason and publish none', async () => {
    if (!staff || !org) throw new Error('fixture not seeded');
    const bearer = staff.bearer;
    const orgId = org.orgId;
    const reasons = ['a', 'b', 'c', 'd', 'e'].map((n) => `pii-reason-${n}-${v7()}`);
    const call = (method: 'PUT' | 'DELETE', path: string, ifMatch: string, body?: object) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'if-match': ifMatch },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const admin = `/v1/admin/orgs/${orgId}/entitlements`;
    const statuses = [
      (await call('PUT', `${admin}/overrides/tenancy.seats`, 'W/"1"', { limit: 2, reason: reasons[0], expiresAt: null })).status,
      (await call('PUT', `${admin}/overrides/tenancy.seats`, 'W/"2"', { limit: 0, reason: reasons[1], expiresAt: null })).status,
      (await call('PUT', `${admin}/plan`, 'W/"1"', { planKey: 'pro', reason: reasons[2] })).status,
      (await call('PUT', `${admin}/overrides/no.such_feature`, 'W/"2"', { enabled: true, reason: reasons[3], expiresAt: null })).status,
      (await call('PUT', `${admin}/plan`, 'W/"2"', { planKey: 'pro', reason: reasons[4] })).status,
      (await call('DELETE', `${admin}/overrides/tenancy.seats`, 'W/"3"')).status,
    ];
    expect(statuses).toEqual([200, 422, 412, 404, 200, 204]);
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    const output = api?.output() ?? '';
    expect(output.length).toBeGreaterThan(0);
    for (const r of reasons) expect(output.includes(r), 'a staff reason reached the logs').toBe(false);
    const events = (await Promise.all(EVENT_TYPES.map((t) => outboxOf(orgId, t)))).flat();
    expect(events).toHaveLength(3);
    const serialized = JSON.stringify(events);
    for (const r of reasons) expect(serialized.includes(r), 'a staff reason reached an event').toBe(false);
  });
});
```

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm test:chaos -- test/chaos/entitlements-outages.spec.ts
pnpm vitest run --project integration test/e2e/entitlements/admin-pii-logs.e2e.spec.ts
```
Expected: PASS; chaos: mọi ca trong giới hạn `OUTAGE_BOUND_MS`, không ca nào `500`. PII: sáu status đúng thứ tự, không lý do nào trong output JSON của pino (gồm DEBUG) hay trong ba event.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/chaos/entitlements-outages.spec.ts test/e2e/entitlements/admin-pii-logs.e2e.spec.ts
git add test/chaos/entitlements-outages.spec.ts test/e2e/entitlements/admin-pii-logs.e2e.spec.ts
git commit -m "test(entitlements): a database lost at the override write answers 503 and writes nothing; no staff reason reaches logs or events"
```

---
## Phần F — Prod-like, tài liệu, bàn giao (spec §20.4, §22)

### Task 14: Prod-like trên image production — schema 4C chạy từ `dist`, nhân viên step-up TOTP thật đặt override ghế qua route `@PlatformStaffAction()`, ghế bị chặn rồi mở lại, gán gói được audit; đo image (ADR 0013 "SP4 (4C)")

Spec §20.4 SM-1 phần 4C ghi "nhân viên step-up TOTP đặt override qua route có `@PlatformStaffAction()` → route `200`" trên một route fixture `requireEnabled`. Image của boilerplate không ship route `requireEnabled` nào (catalogue boilerplate chỉ có hai `LIMIT`; feature mẫu là của SP7 7D), nên smoke dùng tính năng boilerplate có người đọc thật trên image: override `tenancy.seats` đi qua adapter ghế trong `MemberAdmission`. Lệch có chủ đích, ghi ở Task 15.

**Files:**
- Modify: `test/smoke/entitlements.smoke.spec.ts`, `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: `verifiedDevice`, `staffDevice`, `PASSWORD` (`test/smoke/smoke-devices.ts`: `staffDevice` trả thiết bị có session cookie đã step-up TOTP thật); `psql` (superuser, bỏ qua RLS), `logsSince`, `assertCleanLogs`, `workerHealth` (`test/smoke/smoke-support.ts`); `Device.call(method, path, { body, headers })`.
- Produces: hai ca smoke 4C; mục "Số đo SP4 (4C)" của ADR 0013.

- [ ] **Step 1: Ca smoke**

`test/smoke/entitlements.smoke.spec.ts`:
- import thêm `staffDevice` (cạnh `PASSWORD, verifiedDevice`); mô tả `describe` thành `'prod-like smoke: plans 4A, 4B and 4C'`; chú thích đầu file thêm câu: `Plan 4C (Task 14): schema override từ dist, nhân viên step-up TOTP thật đặt/xoá override ghế qua route @PlatformStaffAction(), gán gói PLATFORM_ADMIN.`;
- thêm hai ca **trước** ca log sạch (ca cuối của file):
```ts
  it('the 4C migration ran from dist: org_entitlement_overrides with FORCE RLS, an INVOKER value trigger, the expiry CHECK, UPDATE on five columns only', () => {
    expect(
      psql(
        `SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_class WHERE relname = 'org_entitlement_overrides'`,
      ),
    ).toBe('true:true');
    expect(
      psql(
        `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'org_entitlement_overrides'::regclass`,
      ),
    ).toBe('org_entitlement_overrides_value_ck');
    expect(
      psql(`SELECT prosecdef::text FROM pg_proc WHERE proname = 'entitlements_override_value_ck'`),
    ).toBe('false');
    expect(
      psql(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'org_entitlement_overrides_expiry_ck'`,
      ),
    ).toMatch(/expires_at > updated_at/);
    expect(
      psql(
        `SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a
         WHERE a.attrelid = 'org_entitlement_overrides'::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND has_column_privilege('app_user', a.attrelid, a.attname, 'UPDATE')`,
      ),
    ).toBe('expires_at,flag_value,limit_value,reason,updated_at');
  });
  it('staff on the production image: a TOTP-stepped-up session reads the admin view, caps seats with an override (the owner sees it, a join is refused), deletes it (the join passes), assigns a plan; all audited, no reason in events', async () => {
    const { device: owner } = await verifiedDevice(apiUrl, mail, forbidden);
    const created = await owner.call('POST', '/v1/orgs', {
      body: { name: 'Smoke 4C' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(await created.json());
    const { device: staff } = await staffDevice(apiUrl, mail, forbidden);
    const admin = `/v1/admin/orgs/${id}/entitlements`;
    const view = await staff.call('GET', admin);
    expect([view.status, view.headers.get('etag'), view.headers.get('cache-control')]).toEqual([
      200,
      'W/"1"',
      'no-store',
    ]);
    const reason = `smoke override reason ${randomUUID()}`;
    forbidden.push(reason);
    const capped = await staff.call('PUT', `${admin}/overrides/tenancy.seats`, {
      body: { limit: 1, reason, expiresAt: null },
      headers: { 'if-match': 'W/"1"' },
    });
    expect([capped.status, capped.headers.get('etag')]).toEqual([200, 'W/"2"']);
    const ent = await owner.call('GET', `/v1/orgs/${id}/entitlements`);
    const seats = z
      .object({ features: z.array(z.object({ key: z.string() }).passthrough()) })
      .parse(await ent.json())
      .features.find((f) => f.key === 'tenancy.seats');
    expect(seats).toMatchObject({ limit: 1, source: 'OVERRIDE' });
    const roleId = psql(
      `SELECT public_id FROM org_roles WHERE org_id = '${id}' AND system_key = 'MEMBER'`,
    );
    const link = await owner.call('POST', `/v1/orgs/${id}/invite-links`, {
      body: { roleId, maxUses: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(link.status).toBe(201);
    const { url } = z.object({ url: z.string() }).parse(await link.json());
    const token = new URL(url).hash.replace('#token=', '');
    forbidden.push(token); // token một lần không bao giờ vào log
    const { device: joiner } = await verifiedDevice(apiUrl, mail, forbidden);
    const join = () =>
      joiner.call('POST', '/v1/invite-links/join', {
        body: { token },
        headers: { 'idempotency-key': `smoke-${randomUUID()}` },
      });
    const refused = await join();
    expect([refused.status, z.object({ code: z.string() }).passthrough().parse(await refused.json()).code]).toEqual([
      422,
      'quota_exceeded',
    ]);
    const lifted = await staff.call('DELETE', `${admin}/overrides/tenancy.seats`, {
      headers: { 'if-match': 'W/"2"' },
    });
    expect([lifted.status, lifted.headers.get('etag')]).toEqual([204, 'W/"3"']);
    expect((await join()).status).toBe(201);
    const plan = await staff.call('PUT', `${admin}/plan`, {
      body: { planKey: 'pro', reason },
      headers: { 'if-match': 'W/"3"' },
    });
    expect(plan.status).toBe(200);
    expect(
      psql(
        `SELECT string_agg(type || ':' || (headers->>'actorType'), ',' ORDER BY id) FROM outbox_events
         WHERE org_id = '${id}' AND (type IN ('entitlements.override.set', 'entitlements.override.removed')
           OR (type = 'entitlements.plan.changed' AND payload->>'cause' = 'PLATFORM_ADMIN'))`,
      ),
    ).toBe('entitlements.override.set:user,entitlements.override.removed:user,entitlements.plan.changed:user');
    expect(
      psql(
        `SELECT count(*) FROM outbox_events WHERE org_id = '${id}' AND strpos(payload::text, '${reason}') > 0`,
      ),
    ).toBe('0');
  });
```
(`staff.call` dùng cookie session của thiết bị nhân viên: cùng session đã step-up mà `staffDevice` trả `bearer`; gửi cả cookie lẫn bearer là "nhiều credential" và bị từ chối như SP2, nên chỉ cookie. `Device` tự gửi `origin` cho CSRF của cookie.)

- [ ] **Step 2: Chạy prod-like**

Run: `pnpm test:smoke`
Expected: build image production thật; `docker compose --profile app` (`NODE_ENV=production`) migrate từ `dist` (gồm `…_overrides`); mọi file smoke PASS (core, core-shared, auth-email, dashboard, composition, tenancy, entitlements); catalogue check của api và worker đạt; log api/worker JSON, không dòng `error`, không giá trị nào của `forbidden` (gồm `reason` và token); `/health/ready` 200; `down -v` sạch.

- [ ] **Step 3: Đo image, ghi ADR 0013**

Run (cùng phương pháp các dòng trước của ADR 0013):
```bash
docker history --no-trunc --human=false --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
docker image inspect --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
```
`docs/adr/0013-build-toolchain.md` — thêm sau mục "Số đo SP4 (4B)":
```markdown
### Số đo SP4 (4C) (<ngày chạy, YYYY-MM-DD>)

Đo sau `pnpm test:smoke` xanh của Task 14 (plan 4C) trên HEAD nhánh `sp4c-overrides-admin`, cùng máy và phương pháp với dòng SP4 (4B) (tổng layer `docker history --human=false`, MB = 10^6 byte; nén = `docker image inspect --format '{{.Size}}'`). 4C không thêm package (spec SP4 tiêu chí 12): `package.json` và `pnpm-lock.yaml` không đổi so với `main`; thay đổi là code của `entitlements`, một migration và `openapi.json`.

| Chỉ số | SP4 (4B) | SP4 (4C) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 356,0 MB | <số đo> | <chênh> |
| Image nén | 81,8 MB | <số đo> | <chênh> |
| Layer `dist` | 7,41 MB | <số đo> | <chênh> |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT, dư 44,0 MB | <ĐẠT/KHÔNG, dư …> | |
```
Các ô `<…>` điền bằng số đo thật của lần chạy (dữ liệu đo, không phải chỗ trống của plan). Chênh > 1 MB phải có một câu giải thích nguồn.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/smoke/entitlements.smoke.spec.ts
git add test/smoke/entitlements.smoke.spec.ts docs/adr/0013-build-toolchain.md
git commit -m "test(smoke): overrides from dist and a TOTP-stepped-up staff capping seats on the production image; record the SP4 (4C) image size"
```

---

### Task 15: Tài liệu — ADR 0018/0005, spec cha (P1 phần 4C), spec SP4 (lệch có chủ đích của 4C), README

**Files:**
- Modify: `docs/adr/0018-entitlements-in-code.md`, `docs/adr/0005-multi-tenant-rls.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md`, `docs/boilerplate/README.md`

**Interfaces:**
- Consumes: mọi tên, mã lỗi, route, event của Task 2–14.
- Produces: tài liệu khớp code; không còn nhãn `(4C` ở spec cha.

- [ ] **Step 1: ADR 0018**

`docs/adr/0018-entitlements-in-code.md`:
- mục "Hợp đồng với tenancy (sổ export L1)" thêm dòng: `- 4C dùng từ identity (index): \`PlatformStaffAction\`, \`IdentityErrors\` (chỉ để khai OpenAPI của gate); không thêm export nào vào tenancy hay identity. Test support của 3D (\`describePlatformStaffActionConformance\`) có thêm tuỳ chọn cộng thêm \`entitlementPermissions\`.`
- thêm mục cuối:
```markdown
## Cập nhật plan 4C (<ngày merge>)

- **Override** `org_entitlement_overrides`: con của aggregate `org_entitlements`, khoá `(org_id, feature_id)`, thay giá trị của gói cho đúng tính năng (`OVERRIDE > PLAN > FALLBACK`, không cộng dồn, S4-D12), `expires_at` tuỳ chọn. Bất biến ở DB: trigger INVOKER `org_entitlement_overrides_value_ck` (giá trị đúng `kind`, tính năng chưa deprecated; chạy cả nhánh `DO UPDATE`, spike S4C-1), `CHECK` biên số/lý do/một giá trị, `org_entitlement_overrides_expiry_ck (expires_at > updated_at)`: không bao giờ ghi một override đã hết hạn. `minimum` chỉ ở code.
- **Hết hạn suy ra, không sweep:** câu snapshot lọc `expires_at > now()` (giờ bắt đầu transaction); override hoạt động trên `[ghi, expires_at)`. `Quotas.consume` và adapter ghế đọc snapshot trong transaction của chính chúng, nên thấy override ngay và bỏ override hết hạn mà không có câu ghi, event hay đổi `version` nào. Override cho key pod này không biết (R-X30) bị bỏ qua với một WARN mỗi key mỗi process.
- **Ghi:** khoá chỉ dòng `org_entitlements` `FOR NO KEY UPDATE` → `If-Match` dưới khoá → ghi → `version + 1` → event outbox `entitlements.override.set`/`.removed` (`audit: true`, `webhook: false`, không `reason`), một transaction. Không khoá `organizations`/`usage_counters`: consume và admission không chờ (E-4, E-6b). Hai nhân viên cùng ETag → một thắng, một 412 (E-7); lệnh billing không so version nên áp chồng lên (E-8).
- **API quản trị** `/v1/admin/plans`, `/v1/admin/orgs/{orgId}/entitlements` (`GET`, `PUT …/plan`, `PUT|DELETE …/overrides/{featureKey}`): `@PlatformStaffAction()` của 3D là guard duy nhất; service mở `OrgScope` không qua membership (S4-D19). View admin không có usage (ETag = `version`: biểu diễn là hàm của aggregate và giờ), `Cache-Control: no-store`. Gán gói của nhân viên đi qua `PlanAssignments.assign` (`PLATFORM_ADMIN`, `expectedVersion` = version đã khoá); key gói gõ sai → `422 unknown_plan` không log ERROR.
- **`down` của `…_overrides` từ chối khi còn override** (quyết định của nhân viên không dẫn xuất lại được); vì migrator lùi migration mới nhất trước, nó cũng chặn việc lùi `…_usage_counters` khi còn override trên `files.storage_bytes` (DB-4 (d)).
- **Inventory admin lúc boot** (`PlatformStaffRouteInventory`) là của 6B (R-X17); trước 6B, route SP4 chạy với `NoopPlatformAccessAudit`.
```

- [ ] **Step 2: ADR 0005**

`docs/adr/0005-multi-tenant-rls.md` — thêm sau mục "Cập nhật SP4 (4B)":
```markdown
## Cập nhật SP4 (4C) (<ngày merge>)

- **Bảng tenant `org_entitlement_overrides`** (RLS + FORCE, policy `org_entitlement_overrides_tenant TO app_user`, `USING`/`WITH CHECK` trên `org_id`), neo bắc cầu tới `organizations` qua FK `RESTRICT` `org_id → org_entitlements(org_id)` (M5); hằng `ENTITLEMENTS_TENANT_TABLES_4C` ở `test/support/entitlements-catalog.ts`.
- **Grant theo cột:** `app_user` chỉ `UPDATE (flag_value, limit_value, reason, expires_at, updated_at)`; khoá tự nhiên `(org_id, feature_id)` bất biến với app; không `TRUNCATE`.
- **Trigger INVOKER** `org_entitlement_overrides_value_ck` (`BEFORE INSERT OR UPDATE`, `SET search_path = pg_catalog, public`): chỉ đọc bảng global `entitlement_features`, nên không cần `SECURITY DEFINER`; tập definer không đổi.
- **Ngoại lệ có tên S4-D19:** route admin của SP4 mở `OrgScope.run(orgId)` không qua membership, chỉ sau `@PlatformStaffAction()`; RLS vẫn giới hạn mọi câu vào đúng org đó.
- **Purge:** participant entitlements (`order = 100`) xoá `usage_counters`, `org_entitlement_overrides` rồi `org_entitlements`; quên câu nào thì purge fail to `23001`.
```

- [ ] **Step 3: Spec cha**

`docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md` — §2 bảng context, dòng `| Entitlements |`: `OrgEntitlement (gói + override (4C))` → `OrgEntitlement (gói + override)`; cột event thêm `, \`entitlements.override.set\`, \`entitlements.override.removed\`` sau `` `entitlements.plan.changed` ``.

Run:
```bash
grep -c "(4C" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
```
Expected: `0`.

- [ ] **Step 4: Spec SP4 — ghi lệch có chủ đích của 4C**

`docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md` — thêm đoạn cuối (sau "Sửa theo plan 4B (R-X29 …)"):
```markdown
Sửa theo plan 4C (lệch có chủ đích của plan): §7.4 thêm `org_entitlement_overrides_expiry_ck CHECK (expires_at IS NULL OR expires_at > updated_at)` (mọi ghi đặt `updated_at = clock_timestamp()`; service vẫn trả `422` có `errors[0].path = 'expiresAt'`); §7.7 dòng 4C: `down` từ chối khi còn override (như `…_usage_counters`, SP3 §6.13), và vì migrator lùi migration mới nhất trước, đó cũng là chỗ chặn việc lùi `…_usage_counters` khi còn override trên `files.storage_bytes` (DB-4 (d); FK `23001` là lớp chặn cuối); §12.2 view admin (`GET`, response của `PUT`) không có `used`/`state`/kỳ của quota (ETag = `version` và `304` chỉ đúng khi biểu diễn là hàm của aggregate và giờ) và gửi `Cache-Control: no-store`; `DELETE …/overrides/{featureKey}` nhận cả tính năng đã deprecated (dọn trước khi migration xoá tính năng, §8.4), `PUT` trên tính năng deprecated vẫn `404`; `PUT …/plan` cùng gói mà nguồn đã là `PLATFORM_ADMIN` là `UNCHANGED` (`200`, không ghi lý do mới, không event); key gói lạ → `422 unknown_plan` ngay, không log ERROR `entitlements_unknown_plan` (lỗi của người dùng, không phải vận hành); §6.2 thêm `application/admin-entitlements.service.ts` (mở `OrgScope` + `UnitOfWork` cho route admin), `ports/override.repository.ts` có thêm `lockRoot`/`bumpVersion`, `OrgEntitlementRepository.readAdminRoot`; §19 không thêm metric override (event `audit: true` + `PlatformAccessAudit` là sổ của thao tác nhân viên), hai nhánh 412 và `unknown_plan` của route gán gói được đếm vào `entitlements_plan_assignments_total{cause="PLATFORM_ADMIN"}`; §20.4 SM-1 phần override chạy trên `tenancy.seats` (image không có route `requireEnabled`); AD-1 phần inventory chuyển sang 6B (6B merge sau 4C, R-X17).
```

- [ ] **Step 5: README**

`docs/boilerplate/README.md` — trong mục "### Tính năng theo gói (entitlements)", thêm gạch đầu dòng sau **SP5:**:
```markdown
- **Override và API quản trị (nhân viên nền tảng):** `GET /v1/admin/plans` (catalogue gói của pod), `GET /v1/admin/orgs/{orgId}/entitlements` (gói, nguồn, lý do, `lastBillingSeq`, giá trị hiệu lực, mọi override kể cả đã hết hạn với `status`; `ETag` theo version, `Cache-Control: no-store`, không có usage), `PUT …/entitlements/plan` `{ planKey, reason }`, `PUT …/entitlements/overrides/{featureKey}` `{ enabled }` hoặc `{ limit: number | null }` + `{ reason, expiresAt: string | null }`, `DELETE …/overrides/{featureKey}`. Mọi route cần session nhân viên đã step-up TOTP (`external`: `auth_time` tươi) qua `@PlatformStaffAction()`; ghi cần `If-Match` (ETag của lần đọc trước; thiếu → `428`, cũ → `412`). Override thay giá trị của gói cho đúng tính năng (không cộng dồn), sống qua mọi lần đổi gói, hết hạn tại đúng `expiresAt` (suy ra khi đọc, không event). Gán gói tay chỉ sống tới kỳ trả tiền kế tiếp (billing khẳng định lại gói mỗi kỳ, R-X18): ưu đãi lâu dài dùng override có hạn. `reason` lưu ở DB cho nhân viên, không bao giờ vào log, event hay API tenant. Tenant thấy override qua `source: "OVERRIDE"` và `overrideExpiresAt` trong `GET /v1/orgs/{orgId}/entitlements`.
```
và trong "### Nâng cấp lên SP4" thêm gạch đầu dòng:
```markdown
- 4C: migration `…_overrides` thêm bảng `org_entitlement_overrides` (không thêm dòng tính năng hay gói, nên không cần thứ tự deploy đặc biệt). Rollback `…_overrides` bị từ chối khi còn override (quyết định của nhân viên không dựng lại được) và vì thế cũng chặn rollback `…_usage_counters`; nếu chấp nhận mất mọi override: xoá chúng qua `DELETE /v1/admin/orgs/{orgId}/entitlements/overrides/{featureKey}` (có event audit), hoặc `TRUNCATE org_entitlement_overrides;` bằng `app_owner` (không audit), rồi chạy lại rollback. Xoá một tính năng (bản N+1 của vòng đời): migration xoá override của key đó trước dòng `entitlement_features` (FK `RESTRICT`).
```

- [ ] **Step 6: Kiểm và commit**

Run:
```bash
pnpm exec prettier --check docs/boilerplate/README.md
git add docs/adr docs/superpowers/specs docs/boilerplate/README.md
git commit -m "docs(entitlements): overrides and the admin API in ADR 0018/0005, the parent spec, the SP4 deviations and the README"
```

---

### Task 16: Kiểm chứng toàn nhánh — sẵn sàng cho PR (controller push và mở PR)

**Files:** không sửa file nào ngoài lỗi mà bước kiểm phát hiện (mỗi lỗi sửa ở task gốc của nó, commit riêng).

- [ ] **Step 1: Merge `main` mới nhất (không rebase), kiểm timestamp migration**

Run:
```bash
git fetch origin
git merge origin/main
ls src/migrations/entitlements
pnpm vitest run --project unit test/unit/migrations
```
Expected: merge sạch (xung đột văn bản với 6A/6B/7D merge trong lúc làm: giải theo luật của plan kia — 6A thêm dòng `OPTIONAL_BRIDGES` và adapter dung lượng, không đụng file của 4C; nếu 6A sửa `ENTITLEMENTS_PURGE_STATEMENTS` hay `entitlements-catalog.ts` thì giữ cả hai phía, thứ tự con trước cha — rồi chạy lại toàn bộ bước dưới); `…_overrides` có timestamp lớn hơn migration mới nhất của vùng boilerplate trên `main`; nếu không, sinh lại bằng CLI (`migration:create --blank --path src/migrations/entitlements --name overrides`), chép thân, xoá file cũ, chạy lại test của Task 2–3. Nếu 6B đã merge trong lúc làm: làm Task 10 Step 6.

- [ ] **Step 2: Kiểm tĩnh**

Run:
```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm arch
pnpm vitest run --project unit
node tools/upstream/check.mjs --self
pnpm env:example && git diff --exit-code .env.example
pnpm build && pnpm openapi:export && git diff --exit-code openapi.json
git diff origin/main --stat -- package.json pnpm-lock.yaml .upstream/zones.json
git diff origin/main --name-only | grep -F "src/modules/tenancy/domain/acquisition-token.ts" || echo "no accepted CodeQL finding moved"
```
Expected: mọi lệnh xanh; `hardcode-scan.spec.ts`, `migration-scan.spec.ts`, `migration-order.spec.ts`, `event-flags.spec.ts` xanh; `upstream:check --self` xanh (mọi file mới dưới tiền tố đã phân vùng); `.env.example` không đổi; `openapi.json` không đổi so với commit của Task 9; diff `package.json`, `pnpm-lock.yaml`, `.upstream/zones.json` rỗng; không file nào của `.github/codeql/accepted-findings.txt` bị sửa (dòng `rule path:line` vẫn khớp). Chạy `oasdiff` như job CI (`oasdiff breaking origin/main:openapi.json openapi.json` hoặc lệnh của `.github/workflows/ci.yml`): không thay đổi phá vỡ.

- [ ] **Step 3: Test có DB, chaos, prod-like**

Run:
```bash
pnpm test:int
pnpm test:chaos
pnpm test:smoke
```
Expected: mọi project xanh (`integration` gồm cả `test/e2e/**`); smoke như Task 14. Chạy `overrides-races.spec.ts` và `admin-conformance.e2e.spec.ts` thêm hai lần (race ×50 và ba `AUTH_MODE` phải xanh ổn định); ghi thời gian chạy hai file này vào mô tả PR.

- [ ] **Step 4: Rà diff lần cuối**

Run:
```bash
git log --oneline origin/main..HEAD
git diff origin/main --stat
grep -rn "TODO\|FIXME\|it.only\|describe.only\|as any\|eslint-disable\|oxlint-disable" $(git diff origin/main --name-only -- src test) || true
git diff origin/main -- src | grep -n "^+.*FOR UPDATE" || echo "no FOR UPDATE added"
git diff origin/main -- src | grep -n "^+.*reason" | grep -i "log\|span\|setAttribute" || echo "no reason in logs or spans"
```
Expected: mỗi task có ít nhất một commit conventional; không `TODO`/`.only`/`as any`/tắt lint mới; không file spike (`test/integration/spike-sp4c/`) nào được track; không `FOR UPDATE` mới (chỉ `FOR NO KEY UPDATE`); không chỗ nào đưa `reason` vào log/span.

- [ ] **Step 5: Sẵn sàng cho PR**

Nhánh `sp4c-overrides-admin` đã merge `origin/main`, mọi kiểm ở Step 1–4 xanh trên máy local. Mô tả PR (controller dùng): nội dung theo task, lệnh kiểm chứng và kết quả thật, số đo image (ADR 0013), thời gian chạy hai file race/conformance, lệch có chủ đích (mục dưới), AD-1 phần inventory carry sang 6B, SM-1 phần override trên `tenancy.seats`. **Dừng ở đây**: không push, không mở PR — controller push nhánh, mở PR "SP4 4C: overrides and the admin API" và chờ mọi job CI xanh (race/timing chạy trên Linux CI).

---
## Chỗ đụng code của plan trước và lệch có chủ đích

**Code của 3D/4A/4B mà 4C sửa:** `entitlements/ports/org-entitlement.repository.ts` (`SnapshotRow.overrides`, `readAdminRoot`), `infra/sql/sql-org-entitlement.repository.ts` (`SNAPSHOT_SQL` + LEFT JOIN, `readSnapshot` nhiều dòng, `readAdminRoot`), `application/entitlements.service.ts` (`EntitlementSnapshot.overrides`, override vào `resolveEffective`, WARN một lần), `domain/effective-value.ts` (`OVERRIDE_STATUSES`), `infra/sql/entitlements-purge.sql.ts` (+1 câu ở giữa), `errors.ts` (+2 tên constraint), `events.ts`, `index.ts` (+2 event), `entitlements.module.ts` (+repository, ba service), `http/schemas.ts` (`overrideExpiresAt` thật, schema admin), `http/entitlements-http.module.ts` (+controller), `infra/tenancy/member-seat-limit.adapter.ts` (chỉ chú thích, mục mang từ 4B); test support `entitlements-catalog.ts` (thêm hằng `_4C`, không sửa hằng 4A/4B), `entitlements-seed.ts` (thêm helper), `platform-staff-action.conformance.ts` của 3D (tuỳ chọn cộng thêm `entitlementPermissions`); test của 4A/4B đổi theo hình dạng mới (`entitlements-service.spec.ts` unit: `row()` có `overrides`; `schemas.spec.ts`: snapshot có `overrides`; `snapshot-repository.spec.ts`, `entitlements-service.spec.ts` integration, `snapshot-explain.spec.ts`, `org-entitlements.e2e.spec.ts`, `seats.e2e.spec.ts`, `errors.spec.ts`, `normalization-inventory.spec.ts`, `chaos/entitlements-outages.spec.ts`, `smoke/entitlements.smoke.spec.ts`: thêm ca, không bỏ ca nào).

**Lệch có chủ đích (mỗi dòng có lý do ở task; Task 15 ghi vào spec):**
1. `org_entitlement_overrides_expiry_ck` (bất biến vào DB; Task 2).
2. `down` của `…_overrides` từ chối khi còn override; DB-4 (d) thực hiện qua chuỗi lùi thật (Task 3).
3. View admin không có usage, `Cache-Control: no-store` (File Structure, Task 9).
4. `DELETE` override nhận tính năng deprecated; `PUT` thì `404` (Task 7, Review Focus 3).
5. Key gói lạ ở route admin → `422` trước khoá, không ERROR; đếm `unknown_plan` (Task 8).
6. Thêm `admin-entitlements.service.ts`; service admin ở `EntitlementsCoreModule` (File Structure).
7. Không metric override riêng (Task 15 Step 4).
8. SM-1 phần override trên `tenancy.seats` (Task 14).
9. AD-1 phần inventory sang 6B (Task 10 Step 6).
10. `ConformanceOptions.entitlementPermissions` (sửa test support của 3D, cộng thêm; Task 10).

---

## Self-review

### 1. Phủ spec (mọi hạng mục 4C: §21 hàng 4C, tiêu chí 8/9/10/11/15 phần 4C, §22 dòng 4C) và mục mang từ 4B

| Hạng mục spec | Task | Test |
|---|---|---|
| §7.4 bảng `org_entitlement_overrides`: cột, PK, 2 FK `RESTRICT`, 3 `CHECK` + `expiry_ck`, trigger `value_ck` (INSERT và UPDATE), RLS/FORCE/policy, grant theo cột, index `feature_idx` | 1, 2 | spike S4C-1; `overrides-db` (DB-1, DB-3), `rls-catalog`, smoke |
| §7.6 chuẩn hoá BCNF | 2 | `normalization-inventory` |
| §7.7 dòng 4C (up, khoá, down) | 2, 3 | `overrides-down` (a)(b)(c), `migrations.spec`, `migration-scan`, `migration-order` |
| §8.4 lớp OVERRIDE trong câu snapshot và `resolveEffective`; `expires_at > now()`; override key lạ → WARN | 4 | `entitlements-service` (unit + integration), `snapshot-repository` (gồm biên SQL), `snapshot-explain` (10 000 × 5) |
| §8.4 EXPLAIN 10 000 org × 5 override | 4 | `snapshot-explain` |
| §10.1–§10.2 `PLATFORM_ADMIN` với `expectedVersion`; 412; `REJECTED_RETIRED` → `plan_retired`; `UnknownPlanError` → `unknown_plan` | 8, 9 | `admin-entitlements.spec`, `admin-entitlements.e2e` (AD-2), `overrides-races` (E-7) |
| §12.1 `overrideExpiresAt`; HT-2b (org API key, support grant) | 5 | `schemas.spec`, `org-entitlements.e2e` |
| §12.2 năm route, `@PlatformStaffAction()`, `If-Match`, `ETag`/`304`, `404` org/khoá, soft-delete đọc/ghi được, `PUT` idempotent theo nghĩa | 8, 9 | `admin-entitlements.e2e` (AD-2, AD-3, AD-4, Review Focus 2–5), `admin-schemas.spec` |
| §12.2 S4-D19 `OrgScope` không qua membership | 8 | `admin-entitlements.spec`, `admin-entitlements.e2e` |
| §13.1 `override.set`/`.removed` (cờ, aggregate, actor, không `reason`) | 7 | `overrides.spec`, `event-flags.spec` (EV-10), `admin-entitlements.e2e`, `admin-pii-logs.e2e`, smoke |
| §13.2 purge xoá override giữa hai câu | 2 | `overrides-db` (R-1), `overrides-races` (E-11c), `admin-entitlements.e2e` (Review Focus 4) |
| §15 `plan_retired`, `unknown_plan`, `validation_failed` (trigger + CHECK, đăng ký chứng minh bằng ném-khi-trùng), `404`, `412`/`428` | 2, 7, 8, 9 | `errors.spec`, `overrides.spec`, `admin-entitlements.e2e` |
| §16 A6 (gate 3D), A9 (`reason` không vào event/log) | 9, 10, 13 | `admin-conformance.e2e`, `admin-pii-logs.e2e`, smoke |
| §17 E-7, E-8, E-12 + biến thể override của E-4/E-15, E-6b, E-11 | 5, 12 | `overrides-races`, `override-expiry` |
| §18 F-1 trên đường ghi admin | 13 | `chaos/entitlements-outages` |
| §19 `entitlements_plan_assignments_total{cause="PLATFORM_ADMIN"}` (`precondition_failed`, `unknown_plan`), WARN `entitlements_unknown_override_feature` | 4, 8, 12 | `entitlements-service.spec` (unit), `admin-entitlements.spec`, `overrides-races` |
| §20 AD-1 (bộ ca 3D mỗi route) | 10 | `admin-conformance.e2e`; phần inventory → **6B** |
| §20 AD-2, AD-3, AD-4 | 9 | `admin-entitlements.e2e` |
| §20 AD-5 (a)–(d) | 11 | `admin-billing-reassert.e2e` |
| §20 HT-2b | 5 | `org-entitlements.e2e` |
| §20 EV (override), EV-10 | 4, 7 | `entitlements-service`, `event-flags.spec` |
| §20 DB-1…DB-4 (bảng 4C) | 2, 3 | `overrides-db`, `overrides-down` |
| §20.4 PII; SM-1 phần override | 13, 14 | `admin-pii-logs.e2e`, `entitlements.smoke` |
| Tiêu chí 9 (admin), 8 (RLS), 10 (purge), 11 (503), 15 (cờ event) phần 4C | 2, 9, 10, 12, 13 | như trên |
| Tiêu chí 12, 13 (không package, pipeline xanh, `oasdiff` chỉ thêm) | 9, 14, 16 | `git diff … package.json`, ADR 0013, `openapi.json` |
| §22.1 P1 phần 4C | 15 | `grep -c "(4C"` = 0 |
| **Mang từ 4B: DB-4 ca (d)** | 3 | `overrides-down` (d) + `overrides-db` (FK `23001` trên `files.storage_bytes`) |
| **Mang từ 4B: chú thích adapter ghế "OVERRIDE (4C) > PLAN > FALLBACK"** | 4, 5 | `override-expiry` (ghế), `seats.e2e` (ca 4C) |
| **Mang từ 4B: 4B thấy override hết hạn thế nào** (suy ra lúc đọc, không sweep; biên `>`) | 5 | `override-expiry` (Review Focus 1, E-12), `entitlements-service` (unit, biên) |

### 2. Race của 4C → cơ chế → test

| # | Tình huống | Cơ chế | Test (task) |
|---|---|---|---|
| E-7 | Hai nhân viên sửa cùng override / cùng gói / override ∥ gói với cùng ETag | khoá dòng gốc `FOR NO KEY UPDATE`; `If-Match` so **dưới** khoá (bên sau đọc `version` mới sau khi chờ) → 412; `expectedVersion` của `assign` là lớp kiểm lại | ×50 ba biến thể (12); `overrides.spec` (412 tuần tự, 7) |
| E-8 | Ghi override hoặc gán tay của nhân viên ∥ lệnh billing | cùng khoá dòng gốc; billing không so version nên áp chồng theo thứ tự commit; nhân viên đến sau nhận 412; override là lớp riêng, billing không đụng | ép xen kẽ + ×50 (12); AD-5 (11) |
| E-4/E-15 | Ghi override ∥ consume | consume đọc trần trong transaction của nó, không khoá gốc; nhánh INSERT lấy `FOR KEY SHARE` (tương thích `FOR NO KEY UPDATE`); override commit sau xếp "sau"; `OVER_LIMIT` hợp lệ | ép xen kẽ hai chiều (12) |
| E-6b | Ghi override ghế ∥ admission | override không khoá `organizations`; admission đọc trần dưới khoá org trong transaction của nó | ép: giữ khoá org, override không chờ (12); `seats.e2e` ca 4C (5) |
| E-11c | Purge ∥ ghi override | ghi trước → purge `23001` (RESTRICT thấy dòng vừa commit), job retry xoá hết; purge trước → `lockRoot` 0 dòng → 404 | tất định hai chiều + ×50 (12) |
| E-12 | Override hết hạn giữa hai câu của một request | `now()` = giờ bắt đầu transaction: mọi câu cùng trạng thái; transaction sau thấy trạng thái mới, không ghi gì | `override-expiry` (5) |
| (biên) | Hết hạn đúng tại `now()` | `expires_at > now()`: nửa khoảng `[ghi, expires_at)` | `snapshot-repository` (SQL, 4), `override-expiry` (quota + ghế, 5), unit (4) |
| (mới) | `down` của 4C ∥ ghi override đang mở | `NO FORCE` lấy `ACCESS EXCLUSIVE` tới hết lô; câu kiểm thấy dòng vừa commit | `overrides-down` (b) (3) |
| (mới) | Ghi override chen giữa kiểm `expiresAt` và câu ghi | kiểm bằng `clock_timestamp()` sau khoá; `CHECK (expires_at > updated_at)` với `updated_at = clock_timestamp()` của chính câu ghi là lớp chặn cuối | `override-repository` (23514, 6), `overrides.spec` (7) |

### 3. Quét chỗ trống

Không có "TBD", "TODO", "tương tự Task N", hay bước code không có code. Dấu `<…>` là **dữ liệu của lần chạy**: `<ts>` của migration (CLI sinh; code/test tìm theo hậu tố `_overrides`), năm ô kết quả spike (Task 1 Step 4), ngày và số đo image (Task 14 Step 3), ngày merge trong ADR (Task 15). Hai nhánh theo trạng thái `main` có hướng dẫn tường minh: AD-1 phần inventory (Task 10 Step 6: carry sang 6B, hoặc dừng báo controller nếu 6B đã merge — không đoán API của 6B) và xung đột khi merge `main` (Task 16 Step 1).

### 4. Nhất quán tên và kiểu

`SnapshotOverride`, `SnapshotRow.overrides`, `EntitlementSnapshot.overrides`, `SNAPSHOT_SQL` (Task 4) dùng nguyên ở Task 5, 8, 9. `ENTITLEMENTS_TENANT_TABLES_4C`, `seedOverride(orgId, featureKey, { value, reason?, expiresInSec? }, database?)`, `readOverrides`, `OverrideDbRow`, `outboxOf(orgId, type)`, `OutboxRow` (Task 2) dùng ở Task 3–14. `LockedRoot`, `OverrideWrite`, `OverrideRow`, `OverrideRepository.lockRoot/upsert/remove/bumpVersion/listAll`, `SqlOverrideRepository`, `AdminRootRow`, `OrgEntitlementRepository.readAdminRoot` (Task 6) dùng ở Task 7–9, 13. `OverrideRequest`, `OverrideValue`, `OverrideDecision`, `decideOverrideValue`, `isReason`, `OVERRIDE_STATUSES`, `OverrideSetEvent`, `OverrideRemovedEvent`, `SetOverrideCommand`, `Overrides.lockAggregate/set/remove` (Task 7) dùng ở Task 8, 9, 12. `AdminView`, `AdminEntitlementsQuery.read`, `StaffPlanCommand`, `AdminEntitlements.view/assignPlan/setOverride/removeOverride` (Task 8) dùng ở Task 9, 12. `PutPlanBody`, `PutOverrideBody`, `AdminOrgEntitlementsResponse`, `AdminPlansResponse`, `adminEntitlementsOf`, `adminPlansOf`, `AdminEntitlementsController` (method `plans`, `view`, `putPlan`, `putOverride`, `deleteOverride`) (Task 9) dùng ở Task 10. `ConformanceOptions.entitlementPermissions` (Task 10). Tên của 3D/4A/4B đối chiếu trên nhánh `sp4b-usage-quota-seats`: `PlatformStaffAction`, `hasPlatformStaffAction`, `PlatformAccessAudit`, `describePlatformStaffActionConformance(name, target, { extraImports, modes, handlerCalls })`, `startTenancyApp({ entitlementPermissions })`, `startEntitlementsApp`, `entitlementsCoreImports`, `seedStaffPrincipal`, `seedOrgApiKey`, `seedSupportGrant`, `supportPresetKeys`, `PermissionCatalogueRegistry.merged`, `IdentityErrors.SECOND_FACTOR_REQUIRED/REAUTHENTICATION_REQUIRED/API_KEY_NOT_ALLOWED_HERE`, `CoreErrors.UNAUTHENTICATED/FORBIDDEN/NOT_FOUND/PRECONDITION_REQUIRED/PRECONDITION_FAILED/VALIDATION_FAILED/SERVICE_UNAVAILABLE`, `EntitlementsErrors.PLAN_RETIRED/UNKNOWN_PLAN`, `UnknownPlanError`, `EntitlementsContextError`, `PlanAssignments.assign`, `AssignmentResult`, `decideAssignment` (`VERSION_MISMATCH`), `EntitlementsMetrics.planAssignments`, `AssignmentMetricResult`, `resolveEffective(feature, planValue, override, now)`, `overrideStatus`, `OverrideInput` (4A, `{ flagValue, limitValue, expiresAt }`: dòng DB vào `resolveEffective`; input HTTP mới của 4C tên `OverrideRequest` để không trùng), `EntitlementCatalogueCheck.featureId`, `Quotas.consume`, `MemberSeatLimit.current`, `MemberSeatLimitAdapter`, `assertIfMatch`, `etagOf`, `serialize`, `ApiOk`, `ApiProblems`, `HeaderWriter`, `OrgScope.run`, `UnitOfWork.run(fn, { isolation })`, `Db.execute`, `pgFields`, `holdEntitlementRow`, `holdInOrg`, `waitForBlocked`, `PurgeOrgHandler.handle`, `installOtelCapture().metric`, `startAppProcess`/`output()`, `baseTestEnv`, `staffDevice`, `verifiedDevice`, `psql`.

**Tránh trùng tên:** input HTTP của override là `OverrideRequest` (`domain/override.ts`), khác `OverrideInput` của 4A (`domain/effective-value.ts`, dòng DB đưa vào `resolveEffective`); không file nào import cả hai dưới cùng một tên.

### 5. Phán quyết trên chỗ spec mơ hồ (lý do — giá nếu sai)

1. **Hết hạn suy ra lúc đọc cho đường 4B, biên `>`** — `now()` của transaction là mốc chung của consume/ghế; không sweep nên không có job lỡ — giá: một job dài bắc qua `expires_at` dùng trạng thái lúc nó bắt đầu (E-12, chấp nhận có tên).
2. **`CHECK (expires_at > updated_at)`** — bất biến biểu diễn được trên dòng — giá: bỏ một `CHECK` và test seed đơn giản hơn.
3. **`down` từ chối khi còn override; DB-4 (d) = chuỗi lùi bị chặn ở bước 4C** — thứ tự lùi của migrator làm FK của 4B không thể là chỗ chặn đầu — giá: operator xoá override trước khi lùi (README).
4. **View admin không usage, `no-store`** — ETag theo version đòi biểu diễn là hàm của aggregate và giờ — giá: thêm `used` sau (cộng thêm OpenAPI).
5. **`DELETE` override trên tính năng deprecated được phép** — vòng đời xoá tính năng (§8.4) cần dọn override; `PUT` vẫn 404 (trigger chặn ghi mới) — giá: đổi một điều kiện.
6. **`PUT …/plan` cùng gói, nguồn đã `PLATFORM_ADMIN` → `UNCHANGED`, lý do mới không được ghi** — theo `decideAssignment` của 4A (`ref` null hai phía) — giá: muốn ghi lý do mới thì `decideAssignment` coi đổi lý do là `APPLY` (đổi 4A, thêm event).
7. **Key gói lạ ở route admin → 422 trước khoá, không ERROR** — lỗi của người dùng, không phải vận hành; vẫn đếm metric — giá: một log ERROR mỗi lần nhân viên gõ sai nếu sai.
8. **Không metric override riêng** — spec §19 không có; event audit + `PlatformAccessAudit` đã là sổ — giá: thêm một counter.
9. **`Overrides`/`AdminEntitlements` ở core module (cả worker)** — test integration không cần HTTP; mẫu `PlanAssignments` — giá: chuyển ba provider sang `EntitlementsHttpModule` và dựng test bằng `startEntitlementsApp`.
10. **SM-1 dùng `tenancy.seats`** — image không có route `requireEnabled` — giá: 7D thêm ca override trên feature mẫu.
11. **AD-1 inventory sang 6B** — spec §20.3/§21: plan merge sau trong cặp; 6B chưa có plan — giá: một ca thêm ở 6B (đã là nghĩa vụ của 6B theo addendum A9).
12. **Thứ tự kiểm của `PUT` override: tính năng (404) → giá trị/lý do (422) → org (404) → `If-Match` (428/412) → `expiresAt` (422)** — kiểm rẻ, không DB trước; `expiresAt` cần giờ DB sau khoá — giá: đổi thứ tự hai nhóm kiểm (không đổi hành vi đúng/sai, chỉ đổi mã trả về khi có nhiều lỗi cùng lúc).

### 6. Hạng mục 4C không đặt ở plan này (và nơi xử lý)

- AD-1 phần inventory (`PlatformStaffRouteInventory` trên route SP4, fixture bỏ decorator → không khởi động) → **6B** (R-X17; Task 10 Step 6 dừng-báo nếu 6B đã merge).
- `PlatformAccessAudit` bản cài thật → **6B** (addendum A3); 4C chạy với no-op như spec §12.2 cho phép.
- Phê duyệt hai người cho thao tác admin → **SP6** (spec §2 non-goals).
- SM-1 override trên một route `requireEnabled` của image → **7D** (feature mẫu đầu tiên có route như vậy).
- Không mục nào khác của spec gắn nhãn 4C bị bỏ.

### 7. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **Trigger `BEFORE UPDATE` chặn nhánh `ON CONFLICT … DO UPDATE` theo dòng sau `SET`, và `CHECK` hết hạn được kiểm trên dòng đó** — spike S4C-1 (Task 1); fallback đã viết sẵn (upsert hai câu dưới khoá gốc).
2. **Spy trên prototype của controller đặt trước khi dựng app đếm được handler qua cả ba `AUTH_MODE`** — spike S4C-2 (b'); fallback: bỏ `handlerCalls` (bộ ca vẫn chạy, C10 yếu hơn).
3. **`UnitOfWork.run(fn, { isolation: 'repeatable read' })` bên trong `OrgScope.run` đặt `app.org_id` đúng cho cả ba câu của view** — Task 8 (`admin-entitlements.spec` view) kiểm; nếu MikroORM không áp session variable dưới isolation khác, đổi `view` về READ COMMITTED và thêm khẳng định `root.version === snapshot.version` (lệch → đọc lại một lần).
4. `clock_timestamp()` ở câu riêng sau khoá phản ánh thời điểm sau khi có khoá — hành vi đã biết của Postgres; `CHECK` là lớp chặn cuối nên sai cũng không làm hỏng dữ liệu.
5. `304` của Express với ETag do handler đặt và `no-store` — spike S4C-3; core có ca `304` sẵn (`http-conventions.e2e.spec.ts`).

### 8. Phụ thuộc thật với plan khác

- **Cần đã merge:** 4B PR 2 (bắt buộc: snapshot, `Quotas`, adapter ghế, `usage_counters`, R-X30 đã ở PR 1), 4A, 3D, 6.0, 7A. Không cần 6A, 6B, 5A.
- **Song song (W4):** 6B không đụng file của 4C; plan merge sau trong cặp 4C/6B chạy ca inventory trên route SP4 (dự kiến 6B). 6A thêm `FileStorageLimitAdapter` (đọc `Entitlements.limitOf('files.storage_bytes')`, nên tự thấy override của 4C — ST-2 của 6A khẳng định "theo override (4C nếu đã merge)"); xung đột văn bản có thể ở `entitlements.module.ts`/`index.ts`, giữ cả hai phía.
- **Plan sau dùng tên của 4C:** 5A/5B (`PUT …/plan` là đường nhân viên xử lý `REJECTED_RETIRED`; SP5 bắt `UnknownPlanError` như 4A), 6B (audit `entitlements.override.set`/`.removed` `audit: true`; inventory trên năm route), 6D (cùng mẫu route admin + bộ ca 3D với tuỳ chọn `entitlementPermissions` nếu app của nó có `EntitlementsModule`), 7D (override trên feature mẫu trong smoke).
