# Sub-project 4B — Entitlements: bộ đếm quota, consume/release, số ghế — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm phần 4B của SP4 vào module `entitlements` và `tenancy` đã có trên `main`: bảng `usage_counters` (một dòng mỗi org × tính năng × kỳ, kỳ `NONE`/`MONTH` tạo lười, không cron), `Quotas.consume/consumeOrThrow/release/releaseAllocation` atomic trong transaction của caller (không bao giờ vượt trần khi song song), event `entitlements.quota.reached`, trạng thái quota hiển thị (`used`/`state`/kỳ) trên `GET /v1/orgs/{orgId}/entitlements`, port `MemberSeatLimit` của tenancy cắm vào `MemberAdmission` cùng adapter của entitlements (số ghế `tenancy.seats` đếm dưới khoá org), và dòng tính năng `files.storage_bytes` (`LIMIT`) mà catalogue check cần; chứng minh bằng test trên Postgres 18 + PgBouncer + Redis + Mailpit thật và smoke trên image production qua `docker compose --profile app`; 4B ship một mình với CI xanh.

**Architecture:** Bộ đếm là bảng tenant RLS FORCE có khoá tự nhiên `(org_id, feature_id, period_start)` dưới `UNIQUE NULLS NOT DISTINCT` (kỳ `NONE` là `period_start NULL`); consume là **một câu** `INSERT … ON CONFLICT … DO UPDATE SET used = used + n WHERE used + n <= $max RETURNING` chạy trong `UnitOfWork` của caller, nên khoá dòng + điều kiện trên bản mới nhất làm vượt trần không thể xảy ra và rollback của caller trả lại quota. Kỳ `MONTH` do chính câu SQL tính (`date_trunc('month', now(), ENTITLEMENTS_QUOTA_TIMEZONE)`), không tính giờ ở app. Số ghế là `LIMIT`: tenancy mở port `MemberSeatLimit` (`@Optional()`), `MemberAdmission` đếm `org_members` sau khoá org và khoá `tenancy_users` (đã có), entitlements cài adapter bằng module `@Global()` ở cả `forApi()` lẫn `forWorker()`; tenancy không import entitlements.

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), PostgreSQL 18 (`UNIQUE NULLS NOT DISTINCT`, `date_trunc(text, timestamptz, text)`, `date_add(timestamptz, interval, text)`), zod 4.6.5, OpenTelemetry API 1.9.1, Vitest + Testcontainers, `test/support/tcp-proxy.ts` (chaos), Docker Compose smoke. **Không package mới.**

**Spec:** `docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md` (r2, chốt 2026-09-29; mục 21 hàng "4B" là nguồn phạm vi, kèm §7.5, §7.7 dòng 4B, §9.1–§9.6, §12.1, §13.1 dòng `quota.reached`, §15, §17 E-1…E-4/E-6/E-10/E-11/E-14/E-15, §19, §20 mã test của 4B, §22.1 P3 phần 4B, §22.2 T5/L1). Phán quyết: `D:/backend-demo/.claude/worktrees/sp2-identity/.superpowers/autonomous/rulings.md` (R-X1…R-X30, bản hiệu lực; bản commit `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` cũ hơn). Mẫu định dạng, tên đã có: `docs/superpowers/plans/2026-09-29-sp4a-entitlements-foundation.md` (khối "Produces" của 4A), `docs/superpowers/plans/2026-10-01-sp3d-delegation.md`, `docs/superpowers/plans/2026-09-29-sp3c-acquisition.md`.

**Tách phạm vi với 6A theo R-X29 (bắt buộc đọc trước):** 4B merge **trước** 6A, nên 4B **không ship code files nào**: không `FileStorageLimitAdapter`, không `src/modules/entitlements/integrations/files.ts`, không dòng `entitlements-files` trong `OPTIONAL_BRIDGES`, không kiểm lúc boot `file_storage_limit_adapter_missing`, không import `modules/files/**` ở bất kỳ đâu. ST-1, ST-2, ST-3, ST-4 và luật kiến trúc 20.8-d chuyển sang 6A (lý do ở Self-review mục 5). 4B **vẫn** chèn dòng tính năng `files.storage_bytes` (`LIMIT`, §7.7, §8.1) và khai báo nó trong `BoilerplateFeatures` với `fallback: { max: FILES_STORAGE_FALLBACK_BYTES }`, vì catalogue check so tập tính năng code ↔ DB.

**Điều kiện bắt đầu (phụ thuộc thật):** `origin/main` ở `24771c9` (merge PR #10 `sp3d-delegation`) hoặc mới hơn. Đã merge và 4B dùng: **4A** (`Entitlements`, `EntitlementCatalogueRegistry`, `EntitlementCatalogueCheck`, `OrgEntitlementRepository`, `ENTITLEMENTS_PURGE_STATEMENTS`, `OrgEntitlementsResponse`/`orgEntitlementsOf`, `quotaState`, `QuotaReleaseUnderflowError`, `FeatureKindMismatchError`, `quotaExceeded`, `entitlementsSpan`, `EntitlementsMetrics`, fixture `FixtureFeatures`/`fixturePlans`/`seedFixtureCatalogue`, `holdEntitlementRow`/`waitForBlocked`, `startEntitlementsApp`, `entitlementsCoreImports`), **3C** (`MemberAdmission` với ba nguồn `CREATOR`/`INVITATION`/`INVITE_LINK`, `raceOnOrgLock`, `seedInvitation`, `seedInviteLink`, `acceptInvitation`, `joinInviteLink`), **3B** (`seedCustomRole`, `seedMemberInRole` cho HT-2c), **6.0** (`defineEvent` đòi `audit`/`webhook`), **7A** (composition, `docs/boilerplate/README.md`, `.upstream/zones.json` theo tiền tố). Không cần 6A (R-X29) và không cần 3D.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2, 3A–3D và 4A (mục Global Constraints của `2026-09-29-sp4a-entitlements-foundation.md`), cộng các luật sau, bắt buộc cho mọi task:

- **Package-first:** không cài package nào (spec §3.1, tiêu chí 12). `package.json`/`pnpm-lock.yaml` không đổi (Task 16 kiểm bằng `git diff origin/main -- package.json pnpm-lock.yaml`).
- **Generator:** `pnpm exec mikro-orm migration:create --blank --path src/migrations/entitlements --name usage_counters`. Tên file do CLI sinh (`Migration<14 chữ số>_usage_counters.ts`); plan viết `Migration<ts>_usage_counters`, code và test tìm migration theo hậu tố `_usage_counters`, không viết cứng timestamp. Timestamp phải lớn hơn migration mới nhất trên `main` ở vùng boilerplate (hôm nay `notifications/Migration20261004143813_support_templates`; `migration-order.spec.ts` kiểm).
- **Không đoán API:** mọi tên của 4A/3C lấy từ code trên `main` (đã đối chiếu khi viết plan, liệt kê ở khối Interfaces của từng task). Tên lệch lúc thực thi → dùng tên thật, ghi vào báo cáo task. TDD, không `any`, không tắt lint, không `as never`/`as any` (`hardcode-scan.spec.ts`).
- **Bất biến ở DB (spec §7.5):** `CHECK (used BETWEEN 0 AND 9007199254740991)`, `CHECK (version >= 0)`, `UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)`, FK `RESTRICT` tới `org_entitlements(org_id)` và `entitlement_features(id)`, trigger `usage_counters_period_ck` (`BEFORE INSERT`: tính năng phải `QUOTA`, chưa deprecated, `(reset_period = 'NONE') = (period_start IS NULL)`) ném `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = 'usage_counters_period_ck'`, map bằng `defineConstraintErrors` → `validation_failed` (service còn log ERROR vì chỉ bắn khi code sai).
- **Trigger của 4B là INVOKER** (`LANGUAGE plpgsql SET search_path = pg_catalog, public`): nó chỉ đọc `NEW` và bảng global `entitlement_features` (không RLS, `app_user` có `SELECT`), không hoãn, không đọc bảng tenant dưới FORCE. Bài học "trigger bất biến đọc bảng tenant dưới FORCE RLS là `SECURITY DEFINER` với `search_path=''` + advisory lock" **không áp**; 4B không tạo hàm `SECURITY DEFINER` nào, nên tập definer mà `rls-catalog.spec.ts` khẳng định chính xác (`DEFINER_FUNCTIONS ∪ DEFINER_TRIGGER_FUNCTIONS ∪ SWEEP_DEFINER_FUNCTIONS ∪ PARTITION_OWNER_FUNCTIONS`) giữ nguyên; plan không sửa các hằng đó. Hàm trigger mới: `REVOKE ALL … FROM PUBLIC` như 4A.
- **Kiểu:** PK `id BIGINT GENERATED ALWAYS AS IDENTITY` (cần vì khoá tự nhiên có cột `NULL`); `org_id UUID`; `period_start TIMESTAMPTZ NULL`; số đếm `BIGINT`, đọc ra JS bằng `::text` rồi `Number` (giá trị ≤ `ENTITLEMENT_VALUE_MAX` nên chính xác). `created_at`/`updated_at` có ở bảng mới.
- **Khoá và thứ tự khoá (spec §3.6):** nhiều bộ đếm trong một transaction được tiêu thụ theo **thứ tự key tăng dần**, sau mọi khoá của caller (I2). `organizations` → khoá của caller (vd. `tenancy_users`, `org_invite_links` của 3C; `billing_accounts` của SP5) → `org_entitlements` → `usage_counters`. Consume **không** khoá `org_entitlements` (chỉ đọc snapshot; nhánh `INSERT` lấy `FOR KEY SHARE` của FK, không xung đột `FOR NO KEY UPDATE` của `assign`); khoá dòng bộ đếm do chính nhánh `DO UPDATE` lấy. Adapter ghế chỉ đọc (một câu snapshot, không `FOR …`). Không bao giờ `FOR UPDATE`.
- **Mốc thời gian:** kỳ của bộ đếm tính từ `now()` của DB (giờ bắt đầu transaction): consume, release và câu đọc usage trong cùng transaction luôn cùng kỳ (spec §9.2, E-3; lệch có chủ đích so với luật "sau khoá dùng `clock_timestamp()`", lý do ở Task 5). `updated_at` ghi sau khi có thể đã chờ khoá dòng dùng `clock_timestamp()` (bài học 3C).
- **Không hard-code:** múi giờ kỳ từ `entitlementsConfig.quotaTimezone` (`ENTITLEMENTS_QUOTA_TIMEZONE`, đã có ở 4A); hằng có tên `FILES_STORAGE_FALLBACK_BYTES = 1_073_741_824` (spec §14, tên duy nhất ở mọi spec). 4B không thêm env nào: `pnpm env:example` không đổi `.env.example` (Task 16 kiểm).
- **Kiểm catalogue chịu được DB mới hơn code (R-X30, Task 2):** dòng tính năng/gói chỉ có ở DB và dòng DB đã deprecate/retire mà code chưa → WARN có tên + metric, vẫn khởi động; code có mà DB thiếu, khác `kind`/`reset_period`, code đã deprecate/retire mà DB chưa → không khởi động. Mọi task thêm dòng `entitlement_features` dựa vào luật này.
- **Fail loud:** `ENTITLEMENTS_QUOTA_TIMEZONE` mà Postgres không biết → không khởi động (M6, Task 2); gọi `Quotas` ngoài `UnitOfWork` hoặc org context → `EntitlementsContextError`; key không phải `QUOTA` hoặc `releaseAllocation` trên kỳ `MONTH` → `FeatureKindMismatchError`; consume trên tính năng deprecated → `FeatureKindMismatchError`; `amount` không phải số nguyên trong `[1, ENTITLEMENT_VALUE_MAX]` hoặc receipt sai kỳ → `RangeError`; release quá `used` → `QuotaReleaseUnderflowError` + ERROR `quota_release_underflow`; thiếu dòng `org_entitlements` khi đọc trần (kể cả qua port ghế) → `EntitlementsRowMissingError` (503). Không kẹp về 0, không trả "không giới hạn" khi đọc lỗi.
- **Mọi race có tên và cơ chế chặn** (bảng race 4B ở Self-review mục 2): E-1, E-2, E-3, E-4, E-6, E-10, E-11 (phần consume), E-14, E-15. Check-then-insert không bao giờ là cơ chế. Race test ép giao nhau bằng seam có sẵn: `raceOnOrgLock` (`test/support/org-lock-barrier.ts`) cho ghế; `holdEntitlementRow`/`waitForBlocked` (`test/support/entitlements-races.ts`) và hai seam mới cùng file (`holdUsageCounter`, `holdUsageCounterInsert`) cho bộ đếm; không `sleep` may rủi. Lặp ×50 (`RUNS = 50`). Ca cần một thứ tự xen kẽ cụ thể (E-11, E-15) ép bằng transaction đang mở giữ khoá + `waitForBlocked`, hoặc bằng một "cửa" (`gate()`) bên trong `UnitOfWork.run` của code thật, không dựa vào may rủi của ×50.
- **Truy cập SQL:** chỉ qua `Db.execute` (placeholder `?`, `?::bigint`, `?::timestamptz`) trên EM đang gắn; không import `@mikro-orm` ngoài `infra/`; không mảng bind trong src (nếu cần: `ANY(ARRAY[?]::text[])`). Test đọc/ghi bảng FORCE RLS (`usage_counters`, `org_entitlements`) **bằng `app_user` trong OrgScope** (`withAppClient` + `inOrgTx`) và khẳng định `rowCount`; `ownerQuery`/`withOwner` thấy 0 dòng trên bảng FORCE nên chỉ dùng cho bảng global, `outbox_events` và catalog.
- **Problem+json:** trường lỗi của problem nằm ở `errors` (không `fields`); key tính năng ở `errors[0] = { path: 'feature', code: '<featureKey>' }` (S4-D14) cho cả quota lẫn ghế.
- **Event:** `QuotaReachedEvent` khai `audit: true`, `webhook: false` (R-X3, S4-D20); payload chỉ id/key/số, không PII. `event-flags.spec.ts` (ca "audited namespaces") tự phủ event mới; plan không sửa bảng `EXPECTED` của file đó (luật ghi ở đầu file).
- **Luật kiến trúc:** giữ mọi luật hiện có; 20.8-a (`modules/tenancy/**` không import `modules/entitlements/**`) phủ port ghế; 4B không thêm luật (20.8-d sang 6A, R-X29).
- **Không PII:** không email, token, `reason` trong log/metric/span/event; label metric là enum hữu hạn hoặc key tính năng (catalogue hữu hạn), không `orgId`.
- **Zone:** mọi file mới nằm dưới tiền tố đã phân vùng `boilerplate` của `.upstream/zones.json` (`src/modules/`, `src/migrations/`, `test/`, `docs/adr/`, `docs/boilerplate/`, `docs/superpowers/`); `node tools/upstream/check.mjs --self` xanh mà không sửa `zones.json`.
- **README:** mọi thay đổi README vào `docs/boilerplate/README.md` (R-X25).
- **OpenAPI:** Task 9 và Task 11 đổi bề mặt HTTP (schema response QUOTA, `@ApiProblems` của hai route thu nhận) → sinh lại `openapi.json` bằng `pnpm build && pnpm openapi:export` và commit cùng task; `oasdiff` chỉ được thấy thay đổi cộng thêm.
- **CodeQL:** `.github/codeql/accepted-findings.txt` khớp `rule path:line`; 4B không sửa file nào có trong danh sách đó (hôm nay chỉ `src/modules/tenancy/domain/acquisition-token.ts:8`). Task 16 kiểm lại.
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** Task 14 (luồng 4B trên image thật) và Task 16 (cuối) chạy `pnpm test:smoke`: build image production thật, `docker compose --profile app` với hạ tầng đầy đủ, `NODE_ENV=production`, migrate từ `dist`, smoke HTTP/psql trong `test/smoke/`, log container JSON sạch, `/health/ready` 200, `down -v`. Kích thước image ghi ở ADR 0013 (dòng "SP4 (4B)").
- **Spike:** code spike ở `test/integration/spike-sp4b/`, **không commit**, xoá ở bước cuối Task 1. Kết quả vào ADR 0018 mục "Kết quả spike (plan 4B)" và được commit.
- **Định dạng và commit:** trước mỗi commit `pnpm exec prettier --write <file đã đổi ngoài docs/>`; mỗi task một commit trở lên, conventional message tiếng Anh. Không push, không mở PR: Task 16 dừng ở "sẵn sàng cho PR" (controller push).

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không mã test nào của spec §20 phủ, dễ làm hỏng người dùng nhất:

1. **`amount` không phải số nguyên dương an toàn** (`0`, `-1`, `1.5`, `NaN`, `Infinity`, `2 ** 53`) truyền vào `consume`/`release`/`releaseAllocation` từ code của feature (thường là `body.count` chưa kiểm). Mong đợi: `RangeError` (500, lỗi lập trình) **trước mọi câu SQL**, không dòng bộ đếm nào được tạo hay đổi, không bao giờ `used` âm hay một lần "tiêu thụ 0" thành công. Test: Task 6 (`Review Focus 1: a non-integer or out-of-range amount is refused before any SQL`).
2. **Trả lại receipt của tháng trước sau khi đã sang tháng mới** (xoá bản ghi tạo cuối tháng vào đầu tháng sau): mong đợi chỉ dòng kỳ cũ giảm, dòng kỳ hiện tại không đổi, không `QuotaReleaseUnderflowError` khi dòng cũ đủ; receipt kỳ `MONTH` thiếu `periodStart` → `RangeError`. Test: Task 7 (`Review Focus 2: a receipt of an earlier month releases that month only`).
3. **Hạ gói làm `used > limit` (`OVER_LIMIT`)**: mong đợi `GET …/entitlements` trả `state: "OVER_LIMIT"` với `used` thật (không kẹp), consume tiếp bị `EXCEEDED`, release vẫn chạy, và ngay khi `used` xuống dưới trần thì consume lại thành công. Test: Task 9 (`Review Focus 3: OVER_LIMIT after a downgrade, release brings the org back under the limit`).
4. **Gói chỉ có 1 ghế** (`tenancy.seats: { max: 1 }`, đúng `minimum: 1`): người tạo org vẫn vào được (participant chạy trước `MemberAdmission`), mọi lời mời/link sau đó → `422 quota_exceeded` với `errors[0].code = 'tenancy.seats'`; biên `countUpTo(…, cap = max)` không lệch một. Test: Task 12 (`Review Focus 4: a one-seat plan admits the creator and nobody else`).
5. **Lần tiêu thụ chạm trần đến từ org API key** (principal `{ type: 'api_key' }`, không phải user): actor của `entitlements.quota.reached` không được ném như `userActor` của tenancy (một request hợp lệ thành `500` đúng lúc chạm trần). Mong đợi: event có actor `{ type: 'service', id: 'api_key:<publicId>' }`, consume thành công. Test: Task 6 (`Review Focus 5: reaching the limit under an org API key principal publishes with a service actor`).

---

## File Structure

```
src/
  migrations/entitlements/Migration<ts>_usage_counters.ts   (mới) bảng, index, RLS, grant, trigger, dòng files.storage_bytes
  modules/tenancy/                                          (sửa của 4B, spec §22.2 T5)
    ports/member-seat-limit.ts          (mới) MemberSeatLimit, SeatLimit
    application/member-admission.ts     kiểm ghế ngay sau INSERT org_members, trước event, dưới khoá org (I1)
    application/tenancy-metrics.ts      + tenancy_seat_limit_denied_total{source}; AcquisitionResult + 'seat_limit'
    application/invitation.service.ts · application/invite-link.service.ts   result="seat_limit" (M8)
    http/invitation-tokens.controller.ts · http/invite-link-tokens.controller.ts   + CoreErrors.QUOTA_EXCEEDED trong @ApiProblems
    index.ts                            + export MemberSeatLimit, type SeatLimit
  modules/entitlements/
    constants.ts (+FILES_STORAGE_FALLBACK_BYTES) · features.ts (+files.storage_bytes) · errors.ts (+usage_counters_period_ck)
    events.ts (+QuotaReachedEvent, USAGE_COUNTER_AGGREGATE) · index.ts (+Quotas, QuotaReachedEvent, kiểu quota)
    entitlements.module.ts (+UsageCounterRepository, Quotas, EntitlementsTenancyPortsModule ở forApi + forWorker)
    domain/        quota.ts (mới: QuotaReceipt, ConsumeResult, QuotaPeriod, periodOf, reachedLimit) · effective-value.ts (+QUOTA_STATES)
    ports/         usage-counter.repository.ts (mới) · catalogue.reader.ts (FeatureRow.id, probeTimezone)
    application/   quotas.service.ts (mới) · org-entitlements.query.ts (mới) · catalogue-check.ts ({ errors, warnings } R-X30, múi giờ, +featureId) · entitlements-metrics.ts (+4)
    infra/sql/     sql-usage-counter.repository.ts (mới) · sql-entitlement-catalogue.reader.ts (id) · entitlements-purge.sql.ts (+usage_counters)
    infra/tenancy/ member-seat-limit.adapter.ts (mới) · entitlements-tenancy-ports.module.ts (mới)
    http/          schemas.ts (QUOTA: used/state/periodStart/periodEnd) · org-entitlements.controller.ts · entitlements-http.module.ts
  boilerplate.modules.ts               chỉ chú thích của OPTIONAL_BRIDGES (dòng entitlements-files là của 6A, R-X29) — Task 15
openapi.json                           sinh lại (Task 9, Task 11)
test/
  support/  entitlements-catalog.ts (+_4B) · entitlements-fixtures.ts (fixture.saved_reports, 4 gói) · entitlements-seed.ts
            (seedCounter, readCounters, currentPeriodStart, QUOTA_TZ) · entitlements-races.ts (holdUsageCounter, holdUsageCounterInsert)
  unit/     modules/entitlements/{quota,quotas,catalogue-diff,catalogue-check,schemas,errors}.spec.ts
  integration/ entitlements/{catalogue-check,usage-counters-db,usage-counters-down,usage-counter-repository,quotas,quotas-races,entitlements-service,seat-limit-di}.spec.ts
            core/database/normalization-inventory.spec.ts
  e2e/      entitlements/{org-entitlements,quota-route,seats}.e2e.spec.ts · entitlements/fixtures/quota-route.module.ts
            tenancy/seat-limit-port.e2e.spec.ts
  chaos/    entitlements-outages.spec.ts
  smoke/    entitlements.smoke.spec.ts
docs/adr/ 0018 · 0005 · 0013
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (P1, P3 phần 4B) · 2026-09-28-sp3-tenancy-access-design.md (T5)
          · 2026-09-28-sp4-entitlements-design.md (lệch có chủ đích của 4B)
docs/boilerplate/README.md
```

**Vì sao adapter ghế ở `infra/tenancy/`, không ở `application/member-seat-limit.adapter.ts` như sơ đồ spec §6.2:** repo đã có mẫu cho "module A cài port của module B": `tenancy/infra/identity/tenancy-identity-ports.module.ts` (`@Global`, cài `UserDeletionGuard`, `OrgCredentialAuthenticator` của identity) và `tenancy/infra/queue/tenancy-queue-ports.module.ts`. 4B theo đúng mẫu đó (`entitlements/infra/tenancy/entitlements-tenancy-ports.module.ts`) để người đọc tìm adapter liên module ở một chỗ. Hợp đồng công khai không đổi.

**Vì sao không có `domain/quota-period.ts` chứa SQL:** spec §6.2 đặt "kỳ → vị từ SQL" ở `domain/`, nhưng chuỗi SQL là chi tiết hạ tầng (luật `domain-pure` không cấm chuỗi, nhưng cấm `infra`). `domain/quota.ts` giữ phần thuần (`periodOf: resetPeriod → QuotaPeriod`, `switch` vét cạn, spec §11); câu SQL của mỗi kỳ nằm ở `infra/sql/sql-usage-counter.repository.ts` (`switch` vét cạn trên `QuotaPeriod`).

**Vì sao `featureId` nằm ở `EntitlementCatalogueCheck`:** spec §9.2 chốt "`$featureId` lấy từ bản đồ `key → id` mà `EntitlementCatalogueCheck` nạp lúc boot": dòng `entitlement_features` bất biến (trigger 4A), check đã đọc chính các dòng đó, nên câu consume không phụ thuộc một phép tra có thể trả 0 dòng (bị hiểu nhầm là `EXCEEDED`).

**Vì sao `OrgEntitlementsQuery` mở `UnitOfWork`:** spec §12.1 đòi "một transaction đọc ngắn: snapshot + câu usage": cả hai câu dùng cùng `now()` (giờ bắt đầu transaction), nên kỳ hiện tại của usage khớp `periodStart` trả về. Dưới READ COMMITTED mỗi câu có snapshot riêng: transaction **không** che một lần đổi gói commit giữa hai câu (review M4; chấp nhận vì response chỉ để hiển thị).

---
## Phần A — Spike (bắt buộc làm trước mọi task khác, spec §5)

### Task 1: Spike S4-T2 (`UNIQUE NULLS NOT DISTINCT` làm arbiter của `ON CONFLICT` với `period_start IS NULL`; `WHERE` có tham số; kỳ theo múi giờ) và mục kết quả trong ADR 0018

S4-T2 đã được review money-security r1 chạy đạt trên PG 18.6; 4B chạy lại trên hạ tầng Testcontainers của repo (Postgres 18 của `docker/images.env`) trước khi viết migration, vì cả thiết kế bảng (`period_start NULL` cho kỳ `NONE`) dựa vào nó. Ba câu hỏi phụ cùng spike, vì code của Task 5–8 dựa vào chúng: (b) `date_trunc('month', ts, tz)` và `date_add(ts, interval, tz)` không phụ thuộc `TimeZone` của phiên; (c) trigger `BEFORE INSERT` chạy cả khi câu đi nhánh `DO UPDATE` (Quotas dựa vào trigger làm lớp chặn cuối cho tính năng deprecated trên cả hai nhánh).

**Files:**
- Throwaway: `test/integration/spike-sp4b/arbiter.spec.ts`
- Modify: `docs/adr/0018-entitlements-in-code.md` (thêm mục "Kết quả spike (plan 4B)")

**Interfaces:**
- Consumes: `withOwner` (`test/support/entitlements-seed.ts`, 4A: client `app_owner` thẳng Postgres).
- Produces: mục "Kết quả spike (plan 4B)" của ADR 0018. Các task sau dựa vào ba kết luận: (1) `ON CONFLICT (org_id, feature_id, period_start)` dùng `usage_counters_period_uq` làm arbiter khi `period_start IS NULL`; `DO UPDATE … WHERE … <= $n` nhận tham số và trả 0 dòng khi sai; (2) kỳ tháng chỉ phụ thuộc tham số múi giờ; (3) `BEFORE INSERT` chạy trên mọi dòng đề xuất, kể cả khi kết thúc ở `DO UPDATE`.

- [ ] **Step 0: Nhánh làm việc từ `main` mới nhất**

Run:
```bash
git fetch origin
git log --oneline -1 origin/main
git grep -n "class MemberAdmission\|countUpTo\|revokeGrantsOfGrantee" origin/main -- src/modules/tenancy/application/member-admission.ts src/modules/tenancy/ports/member-repository.ts | head
git grep -n "QuotaReleaseUnderflowError\|quotaExceeded\|ENTITLEMENTS_PURGE_STATEMENTS" origin/main -- src/modules/entitlements | head
git grep -n "OPTIONAL_BRIDGES" origin/main -- src/boilerplate.modules.ts
git switch -c sp4b-usage-quota-seats origin/main
```
Expected: `origin/main` chứa 4A, 3C, 3D (merge PR #10 hoặc mới hơn); các tên ở khối "Điều kiện bắt đầu" có mặt; `OPTIONAL_BRIDGES` rỗng. Tên lệch → dùng tên thật, ghi vào báo cáo task. Làm trong worktree riêng theo skill `superpowers:using-git-worktrees` nếu phiên đang ở worktree khác.

- [ ] **Step 1: Viết spike**

`test/integration/spike-sp4b/arbiter.spec.ts`:
```ts
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withOwner } from '../../support/entitlements-seed.js';

const ORG = '0198c000-0000-7000-8000-0000000000b1';
const UPSERT = `INSERT INTO spike_counters (org_id, feature_id, period_start, used, version)
  VALUES ($1, 1, $2::timestamptz, $3, 1)
  ON CONFLICT (org_id, feature_id, period_start)
  DO UPDATE SET used = spike_counters.used + EXCLUDED.used, version = spike_counters.version + 1
  WHERE spike_counters.used + EXCLUDED.used <= $4
  RETURNING used::text AS used, version::text AS version`;

/** Mọi thứ trong một transaction luôn ROLLBACK (DDL của Postgres có transaction): không để lại gì trong DB dùng chung. */
const inScratchTx = (fn: (c: pg.Client) => Promise<void>) =>
  withOwner(async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`CREATE TABLE spike_counters (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        org_id UUID NOT NULL, feature_id BIGINT NOT NULL, period_start TIMESTAMPTZ NULL,
        used BIGINT NOT NULL, version BIGINT NOT NULL,
        CONSTRAINT spike_counters_uq UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start))`);
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });

describe('spike S4-T2 (spec SP4 §5): NULLS NOT DISTINCT as the ON CONFLICT arbiter for a NULL period', () => {
  it('(a) NULL period: 3 → 5 → refused (0 rows), one row; the WHERE takes a parameter', () =>
    inScratchTx(async (c) => {
      const r1 = await c.query(UPSERT, [ORG, null, 3, 5]);
      const r2 = await c.query(UPSERT, [ORG, null, 2, 5]);
      const r3 = await c.query(UPSERT, [ORG, null, 1, 5]);
      expect([r1.rows, r2.rows, r3.rows]).toEqual([
        [{ used: '3', version: '1' }],
        [{ used: '5', version: '2' }],
        [],
      ]);
      expect((await c.query('SELECT count(*)::int AS n FROM spike_counters')).rows).toEqual([{ n: 1 }]);
    }));
  it('(a) a dated period and a NULL period are two different rows', () =>
    inScratchTx(async (c) => {
      await c.query(UPSERT, [ORG, null, 1, 9]);
      await c.query(UPSERT, [ORG, '2026-09-30T17:00:00Z', 1, 9]);
      await c.query(UPSERT, [ORG, '2026-09-30T17:00:00Z', 1, 9]);
      expect(
        (await c.query('SELECT used::text AS used FROM spike_counters ORDER BY period_start NULLS FIRST')).rows,
      ).toEqual([{ used: '1' }, { used: '2' }]);
    }));
  it('(b) the month start in a timezone does not depend on the session TimeZone', () =>
    inScratchTx(async (c) => {
      const q = `SELECT date_trunc('month', '2026-09-30T16:59:59Z'::timestamptz, 'Asia/Ho_Chi_Minh') AS before,
                        date_trunc('month', '2026-09-30T17:00:00Z'::timestamptz, 'Asia/Ho_Chi_Minh') AS at,
                        date_add(date_trunc('month', '2026-09-30T17:00:00Z'::timestamptz, 'Asia/Ho_Chi_Minh'),
                                 interval '1 month', 'Asia/Ho_Chi_Minh') AS next`;
      const expected = {
        before: '2026-08-31T17:00:00.000Z',
        at: '2026-09-30T17:00:00.000Z',
        next: '2026-10-31T17:00:00.000Z',
      };
      for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        await c.query(`SET LOCAL TIME ZONE '${tz}'`);
        const [row] = (await c.query<{ before: Date; at: Date; next: Date }>(q)).rows;
        expect(
          { before: row?.before.toISOString(), at: row?.at.toISOString(), next: row?.next.toISOString() },
          tz,
        ).toEqual(expected);
      }
    }));
  it('(c) a BEFORE INSERT trigger runs for every proposed row, also when the statement ends in DO UPDATE', () =>
    inScratchTx(async (c) => {
      await c.query('CREATE TABLE spike_fired (n int)');
      await c.query(`CREATE FUNCTION public.spike_fire() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO public.spike_fired VALUES (1); RETURN NEW; END $$`);
      await c.query(
        'CREATE TRIGGER spike_fire BEFORE INSERT ON spike_counters FOR EACH ROW EXECUTE FUNCTION public.spike_fire()',
      );
      await c.query(UPSERT, [ORG, null, 1, 9]);
      await c.query(UPSERT, [ORG, null, 1, 9]);
      expect((await c.query('SELECT count(*)::int AS n FROM spike_fired')).rows).toEqual([{ n: 2 }]);
    }));
});
```

- [ ] **Step 2: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp4b/arbiter.spec.ts`
Expected: PASS 4/4. Ca (a) đỏ (lần hai chèn dòng thứ hai, hoặc lỗi "there is no unique or exclusion constraint matching the ON CONFLICT specification") → **không đạt**: dùng fallback của spec §5 cho mọi task sau — `period_start TIMESTAMPTZ NOT NULL`, kỳ `NONE` là `'-infinity'::timestamptz`, index `UNIQUE` thường; ghi vào ADR, sửa Task 3 (cột + `CHECK ((reset_period = 'NONE') = (period_start = '-infinity'))` trong trigger), Task 5 (biến thể `NONE` của câu SQL dùng `'-infinity'`), và báo controller trước khi đi tiếp (thay đổi hình dạng bảng của spec §7.5). Ca (b) đỏ → dừng, báo controller (PG không có `date_trunc` ba tham số, sai phiên bản image). Ca (c) đỏ → không đổi thiết kế (Quotas đã từ chối tính năng deprecated trước SQL, Task 6); ghi vào ADR rằng trigger chỉ là lớp chặn cuối trên nhánh `INSERT`.

- [ ] **Step 3: Ghi kết quả vào ADR 0018**

`docs/adr/0018-entitlements-in-code.md` — thêm sau mục "Kết quả spike (plan 4A)":
```markdown
## Kết quả spike (plan 4B)

Chạy trên nhánh `sp4b-usage-quota-seats` (sau khi 4A, 3C, 3D merge), Postgres 18 của `docker/images.env` qua Testcontainers, bảng `spike_counters` cùng hình dạng `usage_counters` (spec §7.5) tạo bằng `app_owner` trong một transaction ROLLBACK.

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| S4-T2 (a) | `UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)` là arbiter của `ON CONFLICT` khi `period_start IS NULL`; `DO UPDATE … WHERE used + EXCLUDED.used <= $4` nhận tham số | <Đạt/Không đạt: 3 → 5 → 0 dòng, count = 1> | spike `arbiter.spec.ts` (không commit); giữ thành test hồi quy QU-2 ở Task 3 (SQL) và Task 8 (song song) |
| S4-T2 (b) | `date_trunc('month', ts, tz)`/`date_add(ts, '1 month', tz)` không phụ thuộc `TimeZone` của phiên | <Đạt/Không đạt> | cùng file; giữ thành QU-3 ở Task 5 |
| S4-T2 (c) | `BEFORE INSERT` chạy cả khi câu kết thúc ở `DO UPDATE` | <Đạt/Không đạt> | cùng file |
```
Thay ba ô `<…>` bằng kết quả thật của Step 2 (dữ liệu của lần chạy, không phải chỗ trống của thiết kế).

- [ ] **Step 4: Xoá code spike, commit ADR**

Run:
```bash
rm -rf test/integration/spike-sp4b
git status --short
git add docs/adr/0018-entitlements-in-code.md
git commit -m "docs(entitlements): record the S4-T2 spike results for plan 4B in ADR 0018"
```
Expected: `git status` trước `add` chỉ có ADR 0018.

---

## Phần A2 — Kiểm catalogue chịu được DB mới hơn code (R-X30, spec §1 tiêu chí 7, §8.3)

### Task 2: `EntitlementCatalogueCheck` — dòng chỉ có ở DB và dòng DB đã deprecate/retire là WARN (R-X30), lệch thật vẫn chặn boot; kiểm múi giờ quota ở Postgres lúc boot (M6)

4B là plan đầu tiên thêm dòng `entitlement_features` sau 4A, nên nó là plan đầu tiên làm pod cũ crash-loop nếu kiểm catalogue giữ bằng nhau hai chiều: migrate Job chạy trước rollout, pod 4A khởi động lại (crash, eviction, scale) thấy `files.storage_bytes` mà code của nó không có. R-X30 áp luật R-X21 của quyền (tenancy `CatalogueCheck`: key chỉ có ở DB là `orphans`, WARN) cho entitlements. Task này đi **trước** migration (Task 3) để không có commit nào trên nhánh mà pod cũ bị chặn.

**Phán quyết về gói chỉ có ở DB (controller giao kiểm):** 4A đánh giá org có `plan_key` lạ với pod bằng `EntitlementsVersionSkewError` (503, `entitlements.service.ts` `read()`: `this.registry.plans().plans.get(row.planKey)` → `undefined` → ném), và `PlanAssignments.assign` với gói lạ ném `UnknownPlanError` trước câu ghi đầu tiên (`plan-assignments.service.ts` `run()`). Giá trị gói chỉ ở code (S4-D2), nên pod không thể đánh giá **đúng** org ở gói nó không biết, nhưng nó cũng **không bao giờ đánh giá sai**: luôn fail closed có tên. Giữ "gói chỉ có ở DB" là lỗi boot thì không thứ tự deploy nào cứu được: "code trước migration" làm pod mới fail `plan <k>: in code, missing in the database` (vẫn là lỗi, `catalogue-check.ts`), "migration trước code" làm pod cũ khởi động lại fail. Vì vậy plan chọn **WARN** cho gói chỉ có ở DB (`entitlement_plan_unknown_to_code` + `entitlements_catalogue_unknown_plans_total`), đúng mẫu "thêm gói ở bản N, bán ở bản N+1" của README (F-6). Cùng lập luận cho chiều deprecate/retire: DB đã deprecate/retire (bản mới) mà code chưa → WARN; trigger của DB (`usage_counters_period_ck`, `org_entitlements_plan_not_retired`) vẫn là nguồn sự thật nên không đánh giá sai. Chiều ngược (code deprecate/retire mà DB chưa) là thiếu migration → vẫn lỗi.

**Files:**
- Modify: `src/modules/entitlements/application/catalogue-check.ts`, `src/modules/entitlements/application/entitlements-metrics.ts`, `src/modules/entitlements/ports/catalogue.reader.ts`, `src/modules/entitlements/infra/sql/sql-entitlement-catalogue.reader.ts`
- Modify (test): `test/unit/modules/entitlements/catalogue-diff.spec.ts`, `test/integration/entitlements/catalogue-check.spec.ts`
- Create (test): `test/unit/modules/entitlements/catalogue-check.spec.ts`

**Interfaces:**
- Consumes (4A, đối chiếu trên `main`): `entitlementsCatalogueDiff(features, featureRows, plans, planRows): string[]` (`catalogue-check.ts`, sẽ đổi kiểu trả); `EntitlementCatalogueCheck` (`onModuleInit`, deps `EntitlementCatalogueRegistry`, `EntitlementCatalogueReader`, `EntitlementsMetrics`); `EntitlementCatalogueReader { features(); plans() }`; `entitlementsConfig.quotaTimezone`; `pgFields` (core/database); test: `buildTestApp`, `entitlementsCoreImports`, `startEntitlementsApp`, `examplePlans`, `seedFeatures`, `seedPlans`, `seedOrgEntitlement`, `withOwner`, `installOtelCapture`, `seedUserPrincipal`, `seedOrg`, `authed`.
- Produces:
  - `type CatalogueWarning = { readonly event: 'entitlement_feature_unknown_to_code' | 'entitlement_feature_deprecated_in_db' | 'entitlement_plan_unknown_to_code' | 'entitlement_plan_retired_in_db'; readonly key: string }`; `type CatalogueDiff = { readonly errors: string[]; readonly warnings: CatalogueWarning[] }`; `entitlementsCatalogueDiff(...)` trả `CatalogueDiff` (chuỗi lỗi giữ nguyên định dạng của 4A).
  - `EntitlementsMetrics.catalogueUnknownFeatures` (`entitlements_catalogue_unknown_features_total`), `EntitlementsMetrics.catalogueUnknownPlans` (`entitlements_catalogue_unknown_plans_total`).
  - `EntitlementCatalogueReader.probeTimezone(timezone: string): Promise<void>` (một câu `SELECT date_trunc('month', now(), ?)`); `EntitlementCatalogueCheck` ném `Error('ENTITLEMENTS_QUOTA_TIMEZONE "<tz>" is not a time zone the database knows …')` khi Postgres trả `22023`, log ERROR `{ event: 'entitlements_quota_timezone_unknown' }`; lỗi khác của câu probe ném nguyên (lỗi hạ tầng).
  - `onModuleInit` chỉ ném khi `errors` khác rỗng; Task 5 nạp bản đồ `key → id` ngay trước `if (errors.length === 0) return;`.

- [ ] **Step 1: Unit test phép so (đỏ)**

`test/unit/modules/entitlements/catalogue-diff.spec.ts` — thay toàn bộ `describe`:
```ts
describe('entitlementsCatalogueDiff (spec SP4 §8.3, EC-9, R-X30)', () => {
  it('identical code and rows → no error, no warning', () => {
    expect(
      entitlementsCatalogueDiff(features, featureRows, plans, planRows),
    ).toEqual({ errors: [], warnings: [] });
  });
  it('errors: missing in the database, kind, resetPeriod, retired in code only; warnings: rows only in the database', () => {
    const fr: FeatureRow[] = [
      { key: 'x.flag', kind: 'LIMIT', resetPeriod: null, deprecated: false },
      { key: 'x.calls', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false },
      { key: 'x.ghost', kind: 'FLAG', resetPeriod: null, deprecated: false },
    ];
    const pr: PlanRow[] = [
      { key: 'legacy', retired: false },
      { key: 'gold', retired: false },
    ];
    expect(entitlementsCatalogueDiff(features, fr, plans, pr)).toEqual({
      errors: [
        'feature x.calls: resetPeriod code=MONTH db=NONE',
        'feature x.flag: kind code=FLAG db=LIMIT',
        'feature x.old: in code, missing in the database',
        'plan free: in code, missing in the database',
        'plan legacy: retired code=true db=false',
      ],
      warnings: [
        { event: 'entitlement_feature_unknown_to_code', key: 'x.ghost' },
        { event: 'entitlement_plan_unknown_to_code', key: 'gold' },
      ],
    });
  });
  it('deprecated in code but not in the database stays an error (a migration is missing)', () => {
    expect(
      entitlementsCatalogueDiff(
        features,
        [
          ...featureRows.slice(0, 2),
          { key: 'x.old', kind: 'FLAG', resetPeriod: null, deprecated: false },
        ],
        plans,
        planRows,
      ),
    ).toEqual({
      errors: ['feature x.old: deprecated code=true db=false'],
      warnings: [],
    });
  });
  it('deprecated or retired in the database only (a newer release ran its migration) is a warning', () => {
    expect(
      entitlementsCatalogueDiff(
        features,
        [
          { key: 'x.flag', kind: 'FLAG', resetPeriod: null, deprecated: true },
          ...featureRows.slice(1),
        ],
        plans,
        [
          { key: 'free', retired: true },
          { key: 'legacy', retired: true },
        ],
      ),
    ).toEqual({
      errors: [],
      warnings: [
        { event: 'entitlement_feature_deprecated_in_db', key: 'x.flag' },
        { event: 'entitlement_plan_retired_in_db', key: 'free' },
      ],
    });
  });
});
```

- [ ] **Step 2: Unit test của lớp check — log, metric, múi giờ (đỏ)**

`test/unit/modules/entitlements/catalogue-check.spec.ts`:
```ts
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntitlementCatalogueCheck } from '../../../../src/modules/entitlements/application/catalogue-check.js';
import { EntitlementCatalogueRegistry } from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import {
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { definePlanCatalogue } from '../../../../src/modules/entitlements/domain/plan-catalogue.js';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';
import {
  EntitlementCatalogueReader,
  type FeatureRow,
  type PlanRow,
} from '../../../../src/modules/entitlements/ports/catalogue.reader.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

const otel = installOtelCapture();
const features = mergeFeatureCatalogues([
  featureCatalogueData({ 'x.flag': { kind: 'FLAG', fallback: false } }),
]);
const plans = definePlanCatalogue({ defaultPlan: 'free', plans: { free: { values: {} } } });
const db: { features: FeatureRow[]; plans: PlanRow[]; tz: Error | undefined } = {
  features: [],
  plans: [],
  tz: undefined,
};
const pgError = (code: string): Error => Object.assign(new Error('time zone "Mars/Olympus" not recognized'), { code });

describe('EntitlementCatalogueCheck (spec SP4 §8.3, R-X30, M6; unit)', () => {
  let check: EntitlementCatalogueCheck;
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      providers: [
        EntitlementCatalogueCheck,
        EntitlementsMetrics,
        {
          provide: EntitlementCatalogueRegistry,
          useValue: { features: () => features, plans: () => plans },
        },
        {
          provide: EntitlementCatalogueReader,
          useValue: {
            features: () => Promise.resolve(db.features),
            plans: () => Promise.resolve(db.plans),
            probeTimezone: () => (db.tz ? Promise.reject(db.tz) : Promise.resolve()),
          },
        },
        {
          provide: entitlementsConfig.KEY,
          useValue: { quotaTimezone: 'Asia/Ho_Chi_Minh', rowMissingRetryAfterSec: 5 },
        },
      ],
    }).compile();
    check = m.get(EntitlementCatalogueCheck);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.tz = undefined;
  });
  const matching = () => {
    db.features = [{ key: 'x.flag', kind: 'FLAG', resetPeriod: null, deprecated: false }];
    db.plans = [{ key: 'free', retired: false }];
  };

  it('a row only in the database: one WARN per key with its event, the unknown-features counter, no throw, no mismatch count', async () => {
    matching();
    db.features.push({ key: 'x.ghost', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false });
    db.plans.push({ key: 'gold', retired: false });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const mismatch = (await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0;
    await expect(check.onModuleInit()).resolves.toBeUndefined();
    expect(warn.mock.calls.map(([m]) => m)).toEqual([
      { event: 'entitlement_feature_unknown_to_code', key: 'x.ghost' },
      { event: 'entitlement_plan_unknown_to_code', key: 'gold' },
    ]);
    expect(await otel.metric('entitlements_catalogue_unknown_features_total')).toBeGreaterThanOrEqual(1);
    expect(await otel.metric('entitlements_catalogue_unknown_plans_total')).toBeGreaterThanOrEqual(1);
    expect((await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0).toBe(mismatch);
  });
  it('an error still refuses to boot and counts a mismatch', async () => {
    matching();
    db.features = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(check.onModuleInit()).rejects.toThrow(/feature x\.flag: in code, missing in the database/);
  });
  it('M6: a timezone Postgres does not know (22023) refuses to boot, naming the env', async () => {
    matching();
    db.tz = pgError('22023');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(check.onModuleInit()).rejects.toThrow(/ENTITLEMENTS_QUOTA_TIMEZONE "Asia\/Ho_Chi_Minh"/);
    expect(error.mock.calls.map(([m]) => m)).toContainEqual(
      expect.objectContaining({ event: 'entitlements_quota_timezone_unknown' }),
    );
  });
  it('M6: any other error of the probe is an infrastructure error and propagates unchanged', async () => {
    matching();
    const infra = pgError('08006');
    db.tz = infra;
    await expect(check.onModuleInit()).rejects.toBe(infra);
  });
});
```

- [ ] **Step 3: Integration test trên Postgres thật (đỏ)**

`test/integration/entitlements/catalogue-check.spec.ts`:
- thêm import: `OrgScope` từ `'../../../src/core/database/index.js'` (cạnh `DatabaseModule`); `Entitlements`, `UnknownFeatureError` từ `'../../../src/modules/entitlements/index.js'` (cạnh `EntitlementsModule`); `startEntitlementsApp` từ `'../../support/entitlements-app.js'`; `seedOrgEntitlement`, `withOwner` từ `'../../support/entitlements-seed.js'`; `installOtelCapture` từ `'../../support/otel-capture.js'`; `authed` từ `'../../support/tenancy-app.js'`; `deleteSeededPrincipals`, `seedUserPrincipal` từ `'../../support/tenancy-principals.js'`; `seedOrg` từ `'../../support/tenancy-seed.js'`; và `const otel = installOtelCapture();` sau các import;
- thay ca `'a plan row the code does not declare refuses to boot'` bằng:
```ts
  it('R-X30: a plan row the code does not declare only warns (entitlement_plan_unknown_to_code); the composition boots', async () => {
    cleanups.push(await seedPlans([{ key: 'cc_extra' }]));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const before = (await otel.metric('entitlements_catalogue_unknown_plans_total')) ?? 0;
    await expect(boot(examplePlans)).resolves.toBeDefined();
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_plan_unknown_to_code',
      key: 'cc_extra',
    });
    expect(await otel.metric('entitlements_catalogue_unknown_plans_total')).toBe(before + 1);
  });
```
- thêm ba ca cuối `describe` (trước ca "zero jobs consumed…"):
```ts
  it('R-X30: a feature row only in the database warns with its key, counts, boots, and stays out of evaluation', async () => {
    cleanups.push(
      await seedFeatures([{ key: 'cc.ghost', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false }]),
    );
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const unknownBefore = (await otel.metric('entitlements_catalogue_unknown_features_total')) ?? 0;
    const mismatchBefore = (await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0;
    const a = await startEntitlementsApp(examplePlans);
    app = a;
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_feature_unknown_to_code',
      key: 'cc.ghost',
    });
    expect(await otel.metric('entitlements_catalogue_unknown_features_total')).toBe(unknownBefore + 1);
    expect((await otel.metric('entitlements_catalogue_mismatch_total')) ?? 0).toBe(mismatchBefore);
    const owner = await seedUserPrincipal();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    try {
      await seedOrgEntitlement(org.orgId, 'free');
      const r = await authed(a, owner).get(`/v1/orgs/${org.orgId}/entitlements`);
      expect(r.status).toBe(200);
      expect((r.body.features as { key: string }[]).map((f) => f.key)).not.toContain('cc.ghost');
      await expect(
        a.get(OrgScope).run(org.orgId, () => a.get(Entitlements).limitOf('cc.ghost')),
      ).rejects.toBeInstanceOf(UnknownFeatureError);
    } finally {
      await org.dispose();
      await deleteSeededPrincipals([owner]);
    }
  });
  it('R-X30: a feature the database already deprecated while the code has not only warns (entitlement_feature_deprecated_in_db)', async () => {
    await withOwner((c) =>
      c.query(`UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'tenancy.seats'`),
    );
    cleanups.push(() =>
      withOwner(async (c) => {
        await c.query(`UPDATE entitlement_features SET deprecated_at = NULL WHERE key = 'tenancy.seats'`);
      }),
    );
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await expect(boot(examplePlans)).resolves.toBeDefined();
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_feature_deprecated_in_db',
      key: 'tenancy.seats',
    });
  });
  it('R-X30: a plan the database already retired while the code has not only warns (entitlement_plan_retired_in_db)', async () => {
    await withOwner((c) => c.query(`UPDATE plans SET retired_at = now() WHERE key = 'pro'`));
    cleanups.push(() =>
      withOwner(async (c) => {
        await c.query(`UPDATE plans SET retired_at = NULL WHERE key = 'pro'`);
      }),
    );
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await expect(boot(examplePlans)).resolves.toBeDefined();
    expect(warn.mock.calls.map(([m]) => m)).toContainEqual({
      event: 'entitlement_plan_retired_in_db',
      key: 'pro',
    });
  });
```
Ca `'a retired flag that differs refuses to boot'` (code `retired: true`, DB chưa) và ca `kind` khác giữ nguyên: chúng vẫn là lỗi.

- [ ] **Step 4: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/catalogue-diff.spec.ts test/unit/modules/entitlements/catalogue-check.spec.ts
pnpm vitest run --project integration test/integration/entitlements/catalogue-check.spec.ts
```
Expected: FAIL — phép so còn trả `string[]`; reader chưa có `probeTimezone`; app từ chối boot với dòng chỉ có ở DB.

- [ ] **Step 5: Viết code**

`src/modules/entitlements/ports/catalogue.reader.ts` — thêm vào lớp:
```ts
  /** Một câu `date_trunc('month', now(), tz)`: Postgres nhận múi giờ hay không (tzdata của DB khác Intl của Node, M6). */
  abstract probeTimezone(timezone: string): Promise<void>;
```

`src/modules/entitlements/infra/sql/sql-entitlement-catalogue.reader.ts` — thêm phương thức:
```ts
  async probeTimezone(timezone: string): Promise<void> {
    await this.db.execute(`SELECT date_trunc('month', now(), ?) AS start`, [
      timezone,
    ]);
  }
```

`src/modules/entitlements/application/entitlements-metrics.ts` — thêm hai counter:
```ts
  readonly catalogueUnknownFeatures = this.meter.createCounter(
    'entitlements_catalogue_unknown_features_total',
    {
      description:
        'Feature rows found only in the database at boot (a newer release migrated first; R-X30)',
    },
  );
  readonly catalogueUnknownPlans = this.meter.createCounter(
    'entitlements_catalogue_unknown_plans_total',
    {
      description:
        'Plan rows found only in the database at boot (a newer release migrated first; R-X30)',
    },
  );
```

`src/modules/entitlements/application/catalogue-check.ts` — thay toàn bộ file:
```ts
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { pgFields } from '../../../core/database/index.js';
import type { MergedFeatures } from '../domain/feature-catalogue.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import { entitlementsConfig } from '../entitlements.config.js';
import {
  EntitlementCatalogueReader,
  type FeatureRow,
  type PlanRow,
} from '../ports/catalogue.reader.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from './entitlements-metrics.js';

/** `invalid_parameter_value`: Postgres không biết múi giờ (`time zone "…" not recognized`). */
const PG_UNKNOWN_TIMEZONE = '22023';

/** DB mới hơn code (R-X30): trơ với pod này, không chặn boot. Mỗi loại một event log có tên. */
export type CatalogueWarning = {
  readonly event:
    | 'entitlement_feature_unknown_to_code'
    | 'entitlement_feature_deprecated_in_db'
    | 'entitlement_plan_unknown_to_code'
    | 'entitlement_plan_retired_in_db';
  readonly key: string;
};
/** `errors` khác rỗng = thiếu migration hoặc lệch thật → không khởi động. `warnings` chỉ log + metric. */
export type CatalogueDiff = {
  readonly errors: string[];
  readonly warnings: CatalogueWarning[];
};

const sortedUnion = (a: Iterable<string>, b: Iterable<string>): string[] =>
  [...new Set([...a, ...b])].sort();

/**
 * Mọi khác biệt giữa catalogue trong code và hai bảng tra cứu (spec §8.3), tính năng rồi gói, sắp theo key. Code có mà DB
 * thiếu, khác `kind`/`reset_period`, code đã deprecate/retire mà DB chưa → lỗi (thiếu migration). Dòng chỉ có ở DB, DB đã
 * deprecate/retire mà code chưa → cảnh báo (R-X30): pod chạy code cũ trên DB đã migrate bởi bản mới không được crash-loop.
 */
export function entitlementsCatalogueDiff(
  features: MergedFeatures,
  featureRows: readonly FeatureRow[],
  plans: PlanCatalogue,
  planRows: readonly PlanRow[],
): CatalogueDiff {
  const errors: string[] = [];
  const warnings: CatalogueWarning[] = [];
  const fdb = new Map(featureRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(features.keys(), fdb.keys())) {
    const code = features.get(key);
    const row = fdb.get(key);
    if (!row) errors.push(`feature ${key}: in code, missing in the database`);
    else if (!code)
      warnings.push({ event: 'entitlement_feature_unknown_to_code', key });
    else {
      const resetPeriod = code.kind === 'QUOTA' ? code.resetPeriod : null;
      if (code.kind !== row.kind)
        errors.push(`feature ${key}: kind code=${code.kind} db=${row.kind}`);
      if (resetPeriod !== row.resetPeriod)
        errors.push(
          `feature ${key}: resetPeriod code=${String(resetPeriod)} db=${String(row.resetPeriod)}`,
        );
      if (code.deprecated && !row.deprecated)
        errors.push(`feature ${key}: deprecated code=true db=false`);
      else if (!code.deprecated && row.deprecated)
        warnings.push({ event: 'entitlement_feature_deprecated_in_db', key });
    }
  }
  const pdb = new Map(planRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(plans.plans.keys(), pdb.keys())) {
    const code = plans.plans.get(key);
    const row = pdb.get(key);
    if (!row) errors.push(`plan ${key}: in code, missing in the database`);
    else if (!code)
      warnings.push({ event: 'entitlement_plan_unknown_to_code', key });
    else if (code.retired && !row.retired)
      errors.push(`plan ${key}: retired code=true db=false`);
    else if (!code.retired && row.retired)
      warnings.push({ event: 'entitlement_plan_retired_in_db', key });
  }
  return { errors, warnings };
}

const warningMessage = (w: CatalogueWarning): string => {
  switch (w.event) {
    case 'entitlement_feature_unknown_to_code':
      return 'a feature row exists only in the database; this pod ignores it (a newer release migrated first)';
    case 'entitlement_feature_deprecated_in_db':
      return 'the database deprecated a feature this pod still declares active (a newer release migrated first)';
    case 'entitlement_plan_unknown_to_code':
      return 'a plan row exists only in the database; organizations on it get 503 from this pod (F-6)';
    case 'entitlement_plan_retired_in_db':
      return 'the database retired a plan this pod still declares active (a newer release migrated first)';
    default: {
      const unknown: never = w.event;
      throw new Error(`unknown catalogue warning ${String(unknown)}`);
    }
  }
};

/**
 * Api và worker (spec §8.3, F-3): lỗi catalogue (thiếu migration) → app không khởi động; DB mới hơn code → WARN + metric,
 * vẫn khởi động (R-X30, cùng luật R-X21 của quyền). `onModuleInit`, không phải `onApplicationBootstrap`: Nest chạy xong mọi
 * `onModuleInit` trước mọi `onApplicationBootstrap`, còn `WorkerHost` và `OutboxRelay` bắt đầu consume ở
 * `onApplicationBootstrap` (bài học 3A Task 19, 0bcabd9). Registry tự nạp ở lần dùng đầu nên thứ tự init provider không
 * quan trọng. Kiểm thêm múi giờ quota ở Postgres (M6): zod config kiểm bằng Intl của Node, câu SQL dùng tzdata của DB.
 */
@Injectable()
export class EntitlementCatalogueCheck implements OnModuleInit {
  private readonly logger = new Logger(EntitlementCatalogueCheck.name);

  constructor(
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly reader: EntitlementCatalogueReader,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.assertTimezone();
    const [featureRows, planRows] = await Promise.all([
      this.reader.features(),
      this.reader.plans(),
    ]);
    const { errors, warnings } = entitlementsCatalogueDiff(
      this.registry.features(),
      featureRows,
      this.registry.plans(),
      planRows,
    );
    for (const w of warnings)
      this.logger.warn({ event: w.event, key: w.key }, warningMessage(w));
    const count = (event: CatalogueWarning['event']) =>
      warnings.filter((w) => w.event === event).length;
    const unknownFeatures = count('entitlement_feature_unknown_to_code');
    const unknownPlans = count('entitlement_plan_unknown_to_code');
    if (unknownFeatures > 0)
      this.metrics.catalogueUnknownFeatures.add(unknownFeatures);
    if (unknownPlans > 0) this.metrics.catalogueUnknownPlans.add(unknownPlans);
    if (errors.length === 0) return;
    this.metrics.catalogueMismatch.add(1);
    this.logger.error(
      { event: 'entitlements_catalogue_mismatch', differences: errors },
      'feature or plan catalogue in code does not match the database',
    );
    throw new Error(
      `Entitlement catalogues do not match the database: ${errors.join('; ')}`,
    );
  }

  /** 22023 → lỗi cấu hình có tên, dừng boot; lỗi khác (DB mất) ném nguyên để readiness/khởi động báo đúng nguyên nhân. */
  private async assertTimezone(): Promise<void> {
    const tz = this.cfg.quotaTimezone;
    try {
      await this.reader.probeTimezone(tz);
    } catch (err) {
      if (pgFields(err)?.sqlState !== PG_UNKNOWN_TIMEZONE) throw err;
      this.logger.error(
        { event: 'entitlements_quota_timezone_unknown' },
        'ENTITLEMENTS_QUOTA_TIMEZONE is not a time zone the database knows',
      );
      throw new Error(
        `ENTITLEMENTS_QUOTA_TIMEZONE "${tz}" is not a time zone the database knows (PostgreSQL tzdata); pick a zone listed in pg_timezone_names`,
      );
    }
  }
}
```

- [ ] **Step 6: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm vitest run --project integration test/integration/entitlements test/e2e/entitlements test/integration/composition
pnpm typecheck
```
Expected: PASS. `require-enabled.e2e.spec.ts` gọi lại `onModuleInit()` trên app đang chạy vẫn `resolves.toBeUndefined()`.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements/catalogue-diff.spec.ts test/unit/modules/entitlements/catalogue-check.spec.ts test/integration/entitlements/catalogue-check.spec.ts
git add src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements/catalogue-check.spec.ts
git commit -m "feat(entitlements): catalogue rows only in the database warn instead of refusing to boot (R-X30); the quota timezone is checked against Postgres at boot"
```

---

## Phần B — Schema (spec §7.5, §7.6, §7.7 dòng 4B, §8.1, §13.2 purge)

### Task 3: Migration `usage_counters` (up) — bảng, index, RLS/FORCE/policy `TO app_user`, grant theo cột, trigger `usage_counters_period_ck`, dòng `files.storage_bytes`; purge con trước cha; catalog, cô lập, ràng buộc (DB-1, DB-2, DB-3, R-1, hồi quy SQL của S4-T2)

**Files:**
- Create: `src/migrations/entitlements/Migration<ts>_usage_counters.ts` (CLI sinh)
- Modify: `src/modules/entitlements/constants.ts`, `src/modules/entitlements/features.ts`, `src/modules/entitlements/errors.ts`, `src/modules/entitlements/infra/sql/entitlements-purge.sql.ts`
- Modify (test support): `test/support/entitlements-catalog.ts`, `test/support/entitlements-fixtures.ts`, `test/support/entitlements-seed.ts`
- Modify (test): `test/integration/core/database/normalization-inventory.spec.ts`, `test/unit/modules/entitlements/errors.spec.ts`, `test/integration/entitlements/entitlements-service.spec.ts`, `test/e2e/entitlements/org-entitlements.e2e.spec.ts`, `test/smoke/entitlements.smoke.spec.ts`
- Create (test): `test/integration/entitlements/usage-counters-db.spec.ts`

**Interfaces:**
- Consumes: bảng `org_entitlements(org_id)`, `entitlement_features(id, key, kind, reset_period, deprecated_at)` (4A); `app_current_org()` (SP1); `defineConstraintErrors`, `CoreErrors.VALIDATION_FAILED`; `ENTITLEMENT_VALUE_MAX`; `seedFeatures`, `seedPlans`, `seedOrgEntitlement`, `withOwner`, `featureRowsOf` (`test/support/entitlements-seed.ts`, 4A); `seedOrg`, `withAppClient`, `inOrgTx` (`test/support/tenancy-seed.ts`); `ORG_PURGE_STATEMENTS` (tenancy).
- Produces:
  - Bảng `usage_counters (id, org_id, feature_id, period_start, used, version, created_at, updated_at)`; constraint `usage_counters_org_fk`, `usage_counters_feature_fk`, `usage_counters_period_uq` (`UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)`), `usage_counters_used_ck`, `usage_counters_version_ck`; index `usage_counters_feature_idx`; policy `usage_counters_tenant`; hàm `entitlements_usage_counter_period_ck()` + trigger `usage_counters_period_ck`; dòng `entitlement_features ('files.storage_bytes', 'LIMIT')`.
  - `FILES_STORAGE_FALLBACK_BYTES = 1_073_741_824` (`constants.ts`); `BoilerplateFeatures` có thêm `'files.storage_bytes'` (`LIMIT`, `fallback: { max: FILES_STORAGE_FALLBACK_BYTES }`, `minimum: 0`).
  - `ENTITLEMENTS_PURGE_STATEMENTS = ['DELETE FROM usage_counters WHERE org_id = app_current_org()', 'DELETE FROM org_entitlements WHERE org_id = app_current_org()']` (4C chèn câu override vào GIỮA hai câu).
  - Test support: `ENTITLEMENTS_TENANT_TABLES_4B = ['usage_counters']`; `FixtureFeatures` thêm `'fixture.saved_reports'` (`QUOTA`, `NONE`, `fallback: { max: 3 }`); `fixturePlans` thêm `metered` (`fixture.api_calls` 3, `fixture.saved_reports` 2, `tenancy.seats` 3), `unmetered` (`fixture.api_calls`/`fixture.saved_reports` `UNLIMITED`), `solo` (`tenancy.seats` 1), `duo` (`tenancy.seats` 2); `QUOTA_TZ = 'Asia/Ho_Chi_Minh'`; `seedCounter(orgId, featureKey, { used, period: 'NONE' | { monthsAgo: number } }, database?)`; `readCounters(orgId, database?) → CounterRow[]` với `CounterRow = { feature: string; periodStart: Date | null; used: number; version: number }`; `periodStartOf(monthsAgo = 0) → Promise<Date>`.

- [ ] **Step 1: Test support — hằng catalog, fixture, helper bộ đếm**

`test/support/entitlements-catalog.ts` — thêm hằng của 4B và gộp (không sửa hằng 4A):
```ts
export const ENTITLEMENTS_TENANT_TABLES_4B = ['usage_counters'] as const;
export const ENTITLEMENTS_TENANT_TABLES: readonly string[] = [
  ...ENTITLEMENTS_TENANT_TABLES_4A,
  ...ENTITLEMENTS_TENANT_TABLES_4B,
];
```
(thay khối `ENTITLEMENTS_TENANT_TABLES` hiện có bằng khối trên; `ENTITLEMENTS_GLOBAL_TABLES` giữ nguyên: 4B không thêm bảng global).

`test/support/entitlements-fixtures.ts` — `FixtureFeatures` thêm một key (kỳ `NONE`, consume khi tạo, `releaseAllocation` khi xoá):
```ts
  'fixture.saved_reports': {
    kind: 'QUOTA',
    resetPeriod: 'NONE',
    fallback: { max: 3 },
  },
```
`fixturePlans.plans` thêm bốn gói (giá trị trong code, dòng `plans` do `seedFixtureCatalogue` chèn):
```ts
    metered: {
      values: {
        'fixture.api_calls': { max: 3 },
        'fixture.saved_reports': { max: 2 },
        'tenancy.seats': { max: 3 },
      },
    },
    unmetered: {
      values: {
        'fixture.api_calls': UNLIMITED,
        'fixture.saved_reports': UNLIMITED,
      },
    },
    solo: { values: { 'tenancy.seats': { max: 1 } } },
    duo: { values: { 'tenancy.seats': { max: 2 } } },
```

`test/support/entitlements-seed.ts` — thêm cuối file:
```ts
/** Múi giờ kỳ của test: mặc định của `ENTITLEMENTS_QUOTA_TIMEZONE` (env test không đặt biến này). */
export const QUOTA_TZ = 'Asia/Ho_Chi_Minh';

export type CounterRow = {
  feature: string;
  periodStart: Date | null;
  used: number;
  version: number;
};

/**
 * Một dòng `usage_counters` bằng `app_user` trong OrgScope (bảng FORCE RLS: `app_owner` không thấy dòng nào). Kỳ MONTH
 * lùi `monthsAgo` tháng từ kỳ hiện tại theo `QUOTA_TZ`, tính ở DB (cùng `date_trunc` của app).
 */
export async function seedCounter(
  orgId: string,
  featureKey: string,
  o: { used: number; period: 'NONE' | { monthsAgo: number } },
  database?: string,
): Promise<void> {
  const n = await withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const r = await c.query(
          `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
           SELECT app_current_org(), f.id,
                  CASE WHEN $2::int IS NULL THEN NULL
                       ELSE date_add(date_trunc('month', now(), $3), make_interval(months => -$2::int), $3) END,
                  $4::bigint, 1
           FROM entitlement_features f WHERE f.key = $1`,
          [
            featureKey,
            o.period === 'NONE' ? null : o.period.monthsAgo,
            QUOTA_TZ,
            o.used,
          ],
        );
        return r.rowCount ?? 0;
      }),
    database,
  );
  if (n !== 1)
    throw new Error(`seedCounter: feature "${featureKey}" does not exist`);
}

/** Mọi bộ đếm của org, đọc bằng `app_user` trong OrgScope; sắp theo key rồi kỳ (NONE trước). */
export async function readCounters(
  orgId: string,
  database?: string,
): Promise<CounterRow[]> {
  return withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const { rows } = await c.query<{
          feature: string;
          period_start: Date | null;
          used: string;
          version: string;
        }>(
          `SELECT f.key AS feature, u.period_start, u.used::text AS used, u.version::text AS version
           FROM usage_counters u JOIN entitlement_features f ON f.id = u.feature_id
           ORDER BY f.key, u.period_start NULLS FIRST`,
        );
        return rows.map((r) => ({
          feature: r.feature,
          periodStart: r.period_start,
          used: Number(r.used),
          version: Number(r.version),
        }));
      }),
    database,
  );
}

/** Đầu kỳ MONTH (lùi `monthsAgo` tháng) theo `QUOTA_TZ`, do DB tính: không bảng nào, nên `app_owner` đọc được. */
export async function periodStartOf(monthsAgo = 0): Promise<Date> {
  const rows = await withOwner(
    async (c) =>
      (
        await c.query<{ s: Date }>(
          `SELECT date_add(date_trunc('month', now(), $1), make_interval(months => -$2::int), $1) AS s`,
          [QUOTA_TZ, monthsAgo],
        )
      ).rows,
  );
  const s = rows[0]?.s;
  if (!s) throw new Error('periodStartOf: no row');
  return s;
}
```

- [ ] **Step 2: Viết test schema (đỏ)**

`test/integration/entitlements/usage-counters-db.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../../../src/modules/entitlements/infra/sql/entitlements-purge.sql.js';
import { ORG_PURGE_STATEMENTS } from '../../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import {
  QUOTA_TZ,
  readCounters,
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
const MONTH = `date_trunc('month', now(), '${QUOTA_TZ}')`;
/** Chèn bằng `app_user` trong OrgScope của org (đường của app). */
const insertCounter = (
  orgId: string,
  featureKey: string,
  period: string,
  used = '0',
  version = '1',
) =>
  inOrg(
    orgId,
    `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
     SELECT app_current_org(), id, ${period}, ${used}, ${version} FROM entitlement_features WHERE key = $1`,
    [featureKey],
  );
/** Câu consume của spec §9.2 (kỳ NONE) viết bằng tham số pg: hồi quy SQL của S4-T2 trên bảng thật. */
const consumeNone = (orgId: string, featureKey: string, n: number, max: number) =>
  inOrg(
    orgId,
    `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
     SELECT app_current_org(), id, NULL, $2, 1 FROM entitlement_features WHERE key = $1
     ON CONFLICT (org_id, feature_id, period_start)
     DO UPDATE SET used = usage_counters.used + EXCLUDED.used, version = usage_counters.version + 1, updated_at = clock_timestamp()
     WHERE usage_counters.used + EXCLUDED.used <= $3
     RETURNING used::text AS used, version::text AS version`,
    [featureKey, n, max],
  );

describe('usage_counters schema (spec SP4 §7.5, DB-1, DB-2, DB-3, R-1)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let bare: SeededOrg;
  const disposers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    disposers.push(
      await seedFeatures([
        { key: 'ucdb.month', kind: 'QUOTA', resetPeriod: 'MONTH', deprecated: false },
        { key: 'ucdb.none', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false },
        { key: 'ucdb.cap', kind: 'LIMIT', resetPeriod: null, deprecated: false },
        { key: 'ucdb.old', kind: 'QUOTA', resetPeriod: 'MONTH', deprecated: true },
      ]),
    );
    disposers.push(await seedPlans([{ key: 'ucdb_plan' }]));
    a = await seedOrg();
    b = await seedOrg();
    bare = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'ucdb_plan');
    await seedOrgEntitlement(b.orgId, 'ucdb_plan');
  });
  afterAll(async () => {
    for (const o of [a, b, bare]) await o?.dispose();
    for (const d of disposers.reverse()) await d();
  });

  it('DB-1: RLS + FORCE; app_user has SELECT/INSERT/DELETE and UPDATE only on used, version, updated_at', async () => {
    const { rows } = await owner(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              has_table_privilege('app_user', c.oid, 'SELECT') AS sel, has_table_privilege('app_user', c.oid, 'INSERT') AS ins,
              has_table_privilege('app_user', c.oid, 'DELETE') AS del, has_table_privilege('app_user', c.oid, 'TRUNCATE') AS trunc
       FROM pg_class c WHERE c.oid = 'public.usage_counters'::regclass`,
    );
    expect(rows).toEqual([
      { rls: true, force: true, sel: true, ins: true, del: true, trunc: false },
    ]);
    const cols = await owner(
      `SELECT a.attname AS col FROM pg_attribute a
       WHERE a.attrelid = 'public.usage_counters'::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('app_user', a.attrelid, a.attname, 'UPDATE') ORDER BY a.attname`,
    );
    expect(cols.rows.map((r) => r.col)).toEqual(['updated_at', 'used', 'version']);
  });
  it('the period trigger function is INVOKER, owned by app_owner, not executable by PUBLIC or app_user', async () => {
    const { rows } = await owner(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec,
              p.proconfig AS config
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'entitlements_usage_counter_period_ck'`,
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
  });
  it('the arbiter is UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)', async () => {
    const { rows } = await owner(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'usage_counters_period_uq'`,
    );
    expect(rows).toEqual([
      { def: 'UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)' },
    ]);
  });
  it('files.storage_bytes is seeded as a LIMIT without a reset period (spec §8.1)', async () => {
    const { rows } = await owner(
      `SELECT kind, reset_period, deprecated_at FROM entitlement_features WHERE key = 'files.storage_bytes'`,
    );
    expect(rows).toEqual([{ kind: 'LIMIT', reset_period: null, deprecated_at: null }]);
  });

  it.each([
    ['a counter of a LIMIT feature', 'ucdb.cap', 'NULL', '0', '1', 'usage_counters_period_ck'],
    ['a NONE counter with a period', 'ucdb.none', MONTH, '0', '1', 'usage_counters_period_ck'],
    ['a MONTH counter without a period', 'ucdb.month', 'NULL', '0', '1', 'usage_counters_period_ck'],
    ['a counter of a deprecated feature', 'ucdb.old', MONTH, '0', '1', 'usage_counters_period_ck'],
    ['used = -1', 'ucdb.none', 'NULL', '-1', '1', 'usage_counters_used_ck'],
    ['used = 2^53', 'ucdb.none', 'NULL', '9007199254740992', '1', 'usage_counters_used_ck'],
    ['version = -1', 'ucdb.none', 'NULL', '0', '-1', 'usage_counters_version_ck'],
  ])('DB-3: INSERT with %s → 23514 %s', async (_, key, period, used, version, constraint) => {
    await rejectsWith(insertCounter(a.orgId, key, period, used, version), '23514', constraint);
  });
  it('DB-3: a second NONE row of the same org and feature → 23505 usage_counters_period_uq (NULLS NOT DISTINCT)', async () => {
    await insertCounter(b.orgId, 'ucdb.none', 'NULL');
    await rejectsWith(insertCounter(b.orgId, 'ucdb.none', 'NULL'), '23505', 'usage_counters_period_uq');
    await inOrg(b.orgId, 'DELETE FROM usage_counters');
  });
  it('DB-3: a counter for an org without an org_entitlements row → 23503 usage_counters_org_fk', async () => {
    await rejectsWith(insertCounter(bare.orgId, 'ucdb.none', 'NULL'), '23503', 'usage_counters_org_fk');
  });
  it('DB-3: an unknown feature id → 23503 usage_counters_feature_fk (the trigger leaves a missing feature to the FK)', async () => {
    await rejectsWith(
      inOrg(a.orgId, `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version) VALUES (app_current_org(), -1, NULL, 0, 1)`),
      '23503',
      'usage_counters_feature_fk',
    );
  });
  it('DB-3: a feature still referenced by a counter cannot be deleted (FK RESTRICT → 23001)', async () => {
    await insertCounter(a.orgId, 'ucdb.none', 'NULL');
    try {
      await rejectsWith(owner(`DELETE FROM entitlement_features WHERE key = 'ucdb.none'`), '23001', 'usage_counters_feature_fk');
    } finally {
      await inOrg(a.orgId, 'DELETE FROM usage_counters');
    }
  });
  it.each(['org_id', 'feature_id', 'period_start', 'created_at'])(
    'DB-1: app_user cannot UPDATE %s (column grant → 42501)',
    async (col) => {
      await insertCounter(a.orgId, 'ucdb.none', 'NULL');
      try {
        await rejectsWith(inOrg(a.orgId, `UPDATE usage_counters SET ${col} = ${col}`), '42501');
      } finally {
        await inOrg(a.orgId, 'DELETE FROM usage_counters');
      }
    },
  );
  it('S4-T2 regression on the real table (QU-2, sequential): NULL period 3 → 5 → refused, one row, version 2', async () => {
    const r1 = await consumeNone(a.orgId, 'ucdb.none', 3, 5);
    const r2 = await consumeNone(a.orgId, 'ucdb.none', 2, 5);
    const r3 = await consumeNone(a.orgId, 'ucdb.none', 1, 5);
    expect([r1.rows, r2.rows, r3.rowCount]).toEqual([
      [{ used: '3', version: '1' }],
      [{ used: '5', version: '2' }],
      0,
    ]);
    expect((await readCounters(a.orgId)).map((r) => [r.feature, r.periodStart, r.used, r.version])).toEqual([
      ['ucdb.none', null, 5, 2],
    ]);
    await inOrg(a.orgId, 'DELETE FROM usage_counters');
  });

  describe('DB-2 isolation (criterion 8)', () => {
    beforeAll(async () => {
      await insertCounter(b.orgId, 'ucdb.month', MONTH, '7');
    });
    afterAll(async () => {
      await inOrg(b.orgId, 'DELETE FROM usage_counters');
    });
    it('read/update/delete of org B from OrgScope(A) touch 0 rows and leave B unchanged', async () => {
      const before = await readCounters(b.orgId);
      expect((await inOrg(a.orgId, 'SELECT 1 FROM usage_counters WHERE org_id = $1', [b.orgId])).rowCount).toBe(0);
      expect((await inOrg(a.orgId, 'UPDATE usage_counters SET used = used + 1 WHERE org_id = $1', [b.orgId])).rowCount).toBe(0);
      expect((await inOrg(a.orgId, 'DELETE FROM usage_counters WHERE org_id = $1', [b.orgId])).rowCount).toBe(0);
      expect(await readCounters(b.orgId)).toEqual(before);
    });
    it('INSERT with org_id = B from OrgScope(A) is refused by RLS (42501)', async () => {
      await rejectsWith(
        inOrg(
          a.orgId,
          `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
           SELECT $1, id, NULL, 0, 1 FROM entitlement_features WHERE key = 'ucdb.none'`,
          [b.orgId],
        ),
        '42501',
      );
    });
    it('without an org context the table fails closed (P0001)', async () => {
      await rejectsWith(withAppClient((c) => c.query('SELECT 1 FROM usage_counters')), 'P0001');
    });
  });

  it('R-1: a purge without the entitlements statements fails loud; the 4A statement alone fails on the counters; all statements remove everything', async () => {
    const c = await seedOrg();
    await seedOrgEntitlement(c.orgId, 'ucdb_plan');
    await insertCounter(c.orgId, 'ucdb.none', 'NULL', '2');
    await insertCounter(c.orgId, 'ucdb.month', MONTH, '1');
    const purge = (statements: readonly string[]) =>
      withAppClient((cl) =>
        inOrgTx(cl, c.orgId, async () => {
          await cl.query(
            `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org()`,
          );
          for (const sql of statements) await cl.query(sql);
        }),
      );
    await rejectsWith(purge(ORG_PURGE_STATEMENTS), '23001', 'org_entitlements_org_fk');
    await rejectsWith(
      purge(['DELETE FROM org_entitlements WHERE org_id = app_current_org()', ...ORG_PURGE_STATEMENTS]),
      '23001',
      'usage_counters_org_fk',
    );
    expect(await readCounters(c.orgId)).toHaveLength(2);
    await purge([...ENTITLEMENTS_PURGE_STATEMENTS, ...ORG_PURGE_STATEMENTS]);
    expect(await readCounters(c.orgId)).toEqual([]);
    await c.dispose();
  });
});
```

`test/integration/core/database/normalization-inventory.spec.ts` — thêm vào hằng bảng (sau `'public.org_entitlements'`):
```ts
  // SP4 4B (spec §7.6): BCNF, khoá ứng viên {id} và {org_id, feature_id, period_start} (NULLS NOT DISTINCT).
  'public.usage_counters': [
    'id',
    'org_id',
    'feature_id',
    'period_start',
    'used',
    'version',
    'created_at',
    'updated_at',
  ],
```

`test/unit/modules/entitlements/errors.spec.ts` — trong ca `'trigger names map to codes (the name never reaches the client)'`, thêm:
```ts
    expect(
      dbErrorMapper(pgError('23514', 'usage_counters_period_ck'))?.error.code,
    ).toBe('validation_failed');
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements/usage-counters-db.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/core/database/rls-catalog.spec.ts
pnpm vitest run --project unit test/unit/modules/entitlements/errors.spec.ts
```
Expected: FAIL — `relation "usage_counters" does not exist`; `rls-catalog` báo thiếu policy của `usage_counters`; `errors.spec` nhận `undefined` cho `usage_counters_period_ck`.

- [ ] **Step 4: Sinh migration, viết `up` và `down` đối xứng**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/entitlements --name usage_counters`

Thay nội dung file sinh ra (giữ tên lớp CLI sinh, plan viết `<ts>`):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 4B (spec SP4 §7.5, §7.7 dòng `…_usage_counters`).
 *
 * Bảng chuẩn hoá (spec §7.6):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | usage_counters | {id}, {org_id, feature_id, period_start} (NULLS NOT DISTINCT) | — | BCNF (không cột dẫn xuất: trần không lưu ở đây) |
 * Không phi chuẩn hoá. `kind`/`reset_period` không lặp vào bảng: trigger đọc từ `entitlement_features`.
 *
 * Index (mỗi cái một query): `usage_counters_period_uq` → arbiter `ON CONFLICT` của consume, khoá của release, câu đọc
 * usage kỳ hiện tại (quét theo `org_id`); `usage_counters_feature_idx (feature_id)` → kiểm FK RESTRICT khi migration xoá
 * tính năng (FK từ bảng global, ngoại lệ có tên B6 của SP3: không bắt đầu bằng `org_id`). PK `id` chỉ là `aggregate.id`
 * của `entitlements.quota.reached` (cần vì khoá tự nhiên có cột NULL).
 *
 * Trigger INVOKER (`SET search_path = pg_catalog, public`): chỉ đọc NEW và bảng global `entitlement_features` (không RLS,
 * app_user có SELECT), không hoãn. Không tạo hàm SECURITY DEFINER nào.
 *
 * Không `CHECK (used <= limit)`: trần đổi theo gói và `used > limit` sau hạ gói là trạng thái hợp lệ (S4-D13).
 *
 * Khoá (giữ tới hết lô): bảng mới; `SHARE ROW EXCLUSIVE` trên `org_entitlements` và `entitlement_features` (REFERENCES):
 * chặn ghi hai bảng đó trong lô (đổi gói, tạo org); đọc không bị chặn. INSERT dòng `files.storage_bytes` lấy ROW EXCLUSIVE.
 */
export class Migration<ts>_usage_counters extends Migration {
  override name = 'Migration<ts>_usage_counters';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE usage_counters (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    feature_id BIGINT NOT NULL,
    period_start TIMESTAMPTZ NULL,
    used BIGINT NOT NULL DEFAULT 0,
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT usage_counters_org_fk FOREIGN KEY (org_id) REFERENCES org_entitlements (org_id) ON DELETE RESTRICT,
    CONSTRAINT usage_counters_feature_fk FOREIGN KEY (feature_id) REFERENCES entitlement_features (id) ON DELETE RESTRICT,
    CONSTRAINT usage_counters_period_uq UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start),
    CONSTRAINT usage_counters_used_ck CHECK (used BETWEEN 0 AND 9007199254740991),
    CONSTRAINT usage_counters_version_ck CHECK (version >= 0));`);
    this.addSql(
      `CREATE INDEX usage_counters_feature_idx ON usage_counters (feature_id);`,
    );
    this.addSql(`ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY usage_counters_tenant ON usage_counters TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON usage_counters TO app_user;`);
    // `ON CONFLICT … DO UPDATE` cần UPDATE trên đúng các cột nó ghi; khoá tự nhiên và created_at không sửa được.
    this.addSql(
      `GRANT UPDATE (used, version, updated_at) ON usage_counters TO app_user;`,
    );
    // Spec §7.5: Postgres chạy BEFORE INSERT cho MỌI dòng đề xuất, kể cả khi câu kết thúc ở DO UPDATE (spike S4-T2 (c)),
    // nên consume trên tính năng sai loại/deprecated luôn bị chặn. Tính năng không tồn tại: để FK báo 23503.
    this
      .addSql(`CREATE FUNCTION entitlements_usage_counter_period_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE f record;
BEGIN
  SELECT kind, reset_period, deprecated_at INTO f FROM public.entitlement_features WHERE id = NEW.feature_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF f.kind <> 'QUOTA' OR f.deprecated_at IS NOT NULL OR (f.reset_period = 'NONE') <> (NEW.period_start IS NULL) THEN
    RAISE EXCEPTION 'a usage counter needs an active QUOTA feature and a period matching its reset period'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'usage_counters_period_ck';
  END IF;
  RETURN NEW;
END $$;`);
    this
      .addSql(`CREATE TRIGGER usage_counters_period_ck BEFORE INSERT ON usage_counters
    FOR EACH ROW EXECUTE FUNCTION entitlements_usage_counter_period_ck();`);
    this.addSql(
      `REVOKE ALL ON FUNCTION public.entitlements_usage_counter_period_ck() FROM PUBLIC;`,
    );
    // Tính năng boilerplate (spec §8.1, R-X8): trần dung lượng file. Chèn vô điều kiện (kể cả khi dự án tắt files) vì
    // catalogue check so tập tính năng code ↔ DB; `fallback`/`minimum` chỉ ở code (S4-D2). Adapter là của 6A (R-X29).
    this.addSql(
      `INSERT INTO entitlement_features (key, kind) VALUES ('files.storage_bytes', 'LIMIT');`,
    );
  }

  override down(): void | Promise<void> {
    // Fail to (23001) nếu 4C đã có override trên `files.storage_bytes`: runbook xoá override trước (spec §7.7).
    this.addSql(
      `DELETE FROM entitlement_features WHERE key = 'files.storage_bytes';`,
    );
    this.addSql(`DROP TABLE usage_counters;`);
    this.addSql(`DROP FUNCTION entitlements_usage_counter_period_ck();`);
  }
}
```
(Task 4 thêm lớp từ chối "còn bộ đếm" vào `down` bằng TDD.)

- [ ] **Step 5: Code đi cùng dòng DB — hằng, tính năng, mã lỗi, purge**

`src/modules/entitlements/constants.ts` — thêm:
```ts
/**
 * `fallback` của `files.storage_bytes` (spec §8.1, §14, phán quyết C4): 1 GiB, bằng mặc định `FILES_ORG_STORAGE_LIMIT_BYTES`
 * của SP6. Tên duy nhất ở mọi spec; 6A thêm test so với `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES` (ST-3, R-X29).
 */
export const FILES_STORAGE_FALLBACK_BYTES = 1_073_741_824;
```

`src/modules/entitlements/features.ts` — thay toàn bộ:
```ts
import { FILES_STORAGE_FALLBACK_BYTES } from './constants.js';
import { UNLIMITED } from './domain/feature-catalogue.js';
import { defineFeatureCatalogue } from './http/decorators.js';

/**
 * Catalogue tính năng của boilerplate (spec §8.1). `tenancy.seats` giữ hành vi SP3 bằng `fallback: UNLIMITED` (S4-D3);
 * `minimum: 1` để org luôn chứa được người tạo; nối vào tenancy qua `MemberSeatLimit` (4B). `files.storage_bytes` (byte)
 * khai báo luôn, kể cả khi dự án tắt files: dòng DB do migration 4B chèn vô điều kiện; adapter `FileStorageLimit` là của
 * 6A (R-X29).
 */
export const BoilerplateFeatures = defineFeatureCatalogue({
  'tenancy.seats': {
    kind: 'LIMIT',
    fallback: UNLIMITED,
    minimum: 1,
    description: 'Members an organization may have (one seat per member)',
  },
  'files.storage_bytes': {
    kind: 'LIMIT',
    fallback: { max: FILES_STORAGE_FALLBACK_BYTES },
    minimum: 0,
    description: 'Bytes of stored files an organization may keep',
  },
});
```

`src/modules/entitlements/errors.ts` — trong `defineConstraintErrors({ … })` thêm một dòng:
```ts
  usage_counters_period_ck: CoreErrors.VALIDATION_FAILED,
```
và sửa chú thích phía trên thành: `/** Tên trigger (migration entitlements_core, usage_counters) → mã; tên không bao giờ ra client. Trigger seq và trigger kỳ chỉ bắn khi code sai (log ERROR ở service). */`

`src/modules/entitlements/infra/sql/entitlements-purge.sql.ts` — thay mảng:
```ts
export const ENTITLEMENTS_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM usage_counters WHERE org_id = app_current_org()',
  'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
];
```
và câu chú thích "4B chèn `usage_counters`, 4C chèn …" thành "4B: `usage_counters` trước dòng gốc; 4C chèn `org_entitlement_overrides` giữa hai câu.".

- [ ] **Step 6: Cập nhật test mong đợi tập tính năng cố định**

Tập tính năng gộp có thêm `files.storage_bytes` (boilerplate) và `fixture.saved_reports` (fixture):

`test/integration/entitlements/entitlements-service.spec.ts` — trong ca `'a pro org resolves plan values, fallbacks and the boilerplate LIMIT under RLS, in and out of a transaction'`, thêm hai mục vào đối tượng `toEqual`:
```ts
      'fixture.saved_reports': {
        kind: 'QUOTA',
        limit: { kind: 'MAX', max: 3 },
        resetPeriod: 'NONE',
        source: 'FALLBACK',
      },
      'files.storage_bytes': {
        kind: 'LIMIT',
        limit: { kind: 'MAX', max: 1_073_741_824 },
        source: 'FALLBACK',
      },
```

`test/e2e/entitlements/org-entitlements.e2e.spec.ts` — trong ca `'OWNER, ADMIN and MEMBER read the documented shape…'`, thêm phần tử đầu mảng `features` (sắp theo key: `files.` < `fixture.`):
```ts
        {
          key: 'files.storage_bytes',
          kind: 'LIMIT',
          unlimited: false,
          limit: 1_073_741_824,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
```
và phần tử sau `fixture.reports`, trước `tenancy.seats`:
```ts
        {
          key: 'fixture.saved_reports',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          unlimited: false,
          limit: 3,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
```
(Task 9 thêm `used`/`state`/`periodStart`/`periodEnd` vào hai mục QUOTA của mảng này.)

`test/smoke/entitlements.smoke.spec.ts` — ca `'the 4A migrations ran from dist…'`: chuỗi mong đợi của `entitlement_features` thành `'files.storage_bytes:LIMIT,tenancy.seats:LIMIT'`; ca `'entitlements on the production image…'`: thêm phần tử đầu mảng `features`:
```ts
        {
          key: 'files.storage_bytes',
          kind: 'LIMIT',
          unlimited: false,
          limit: 1_073_741_824,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
```
(smoke chạy ở Task 14.)

- [ ] **Step 7: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements test/integration/core/database/normalization-inventory.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/migrations.spec.ts test/e2e/entitlements
pnpm vitest run --project unit test/unit/modules/entitlements test/unit/migrations
```
Expected: PASS. `rls-catalog.spec.ts` thấy `usage_counters` có RLS + FORCE + policy `TO app_user` (qua `ENTITLEMENTS_TENANT_TABLES`), có đường FK tới `organizations` qua `org_entitlements` (M5), tập SECURITY DEFINER không đổi; `migrations.spec.ts` (up → down → up và sweep S2-R57 trên DB riêng) xanh với migration mới; `migration-scan.spec.ts` xanh (hàm tạo ở `up` được xoá ở `down`); `migration-order.spec.ts` xanh (timestamp mới hơn mọi migration của vùng trên `main`); catalogue check của mọi app test entitlements đạt (code và DB cùng có `files.storage_bytes`).

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write src/migrations/entitlements src/modules/entitlements test/support/entitlements-catalog.ts test/support/entitlements-fixtures.ts test/support/entitlements-seed.ts test/integration/entitlements test/integration/core/database/normalization-inventory.spec.ts test/unit/modules/entitlements/errors.spec.ts test/e2e/entitlements test/smoke/entitlements.smoke.spec.ts
git add src/migrations/entitlements src/modules/entitlements test/support test/integration test/unit/modules/entitlements/errors.spec.ts test/e2e/entitlements test/smoke/entitlements.smoke.spec.ts
git commit -m "feat(entitlements): usage_counters table with RLS, column grants and the period trigger; files.storage_bytes LIMIT row; purge counters before the root row"
```

---
### Task 4: `down` của `usage_counters` từ chối khi còn bộ đếm (không mất usage âm thầm), nguyên tử với consume đang bay (DB-4)

Spec §7.7 ghi `down` = xoá dòng `files.storage_bytes`, `DROP TABLE`, `DROP FUNCTION`. Bộ đếm là quota khách đã tiêu thụ, không dẫn xuất lại được: `DROP` âm thầm trả lại toàn bộ quota cho mọi org. 4B theo luật "down khi có dữ liệu chặn → lỗi rõ ràng, không mất dữ liệu" của SP3 §6.13 (cùng cách `down` của `starter_plans` 4A từ chối khi còn gán billing): còn dòng nào → `RAISE`, DB không đổi. Lệch có chủ đích so với §7.7, sửa spec ở Task 15.

**Files:**
- Modify: `src/migrations/entitlements/Migration<ts>_usage_counters.ts` (`down`)
- Create (test): `test/integration/entitlements/usage-counters-down.spec.ts`

**Interfaces:**
- Consumes: migration của Task 3; `runMigrations`, `MigrationObject` (`src/core/database/index.ts`); `applyTestEnv` (`test/support/app-factory.ts`); `coreMigrationList` (`test/support/migrate-test-db.ts`); `createScratchDb`, `ScratchDb` (`test/support/scratch-db.ts`); `seedFeatures`, `seedOrgEntitlement`, `seedCounter`, `readCounters` (Task 3), `seedOrg`, `withAppClient`, `inOrgTx`.
- Produces: `down` của `…_usage_counters`: `NO FORCE` (khoá `ACCESS EXCLUSIVE` tới hết lô) → `RAISE 'usage counters hold consumed quota; …'` nếu còn dòng → xoá dòng `files.storage_bytes` → `DROP TABLE` → `DROP FUNCTION` → khối khẳng định FORCE (chuỗi `a tenant table lost FORCE ROW LEVEL SECURITY`, luật `migration-scan.spec.ts`).

- [ ] **Step 1: Viết test (đỏ)**

`test/integration/entitlements/usage-counters-down.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  readCounters,
  seedCounter,
  seedFeatures,
  seedOrgEntitlement,
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
const REFUSAL = /usage counters hold consumed quota/;

/**
 * DB-4 (spec SP4 §7.7) cho migration 4B, trên database riêng (down để lại schema khác DB dùng chung). Danh sách migration
 * cắt tới `…_usage_counters` để down chỉ lùi đúng migration này dù sau này có migration mới hơn.
 */
describe('usage_counters down refuses to lose consumed quota (spec SP4 §7.7, DB-4)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let before: string;
  let org: SeededOrg;
  const catalogState = async () => {
    const c = await db.client('owner');
    try {
      return (
        await c.query<{ table: string | null; fn: string | null; feature: number; force: boolean | null }>(
          `SELECT to_regclass('public.usage_counters')::text AS table,
                  to_regprocedure('public.entitlements_usage_counter_period_ck()')::text AS fn,
                  (SELECT count(*)::int FROM entitlement_features WHERE key = 'files.storage_bytes') AS feature,
                  (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.usage_counters')) AS force`,
        )
      ).rows[0];
    } finally {
      await c.end();
    }
  };
  const down = () =>
    runMigrations('down', { source: { kind: 'list', list }, to: before });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('ucdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_usage_counters'));
    if (at < 1) throw new Error('usage_counters migration not found');
    list = all.slice(0, at + 1);
    before = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    await seedFeatures(
      [{ key: 'ucdown.calls', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false }],
      db.name,
    );
    org = await seedOrg({ database: db.name });
    await seedOrgEntitlement(org.orgId, 'free', {}, db.name);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) down refuses while a counter holds consumed quota; the table, the function, the feature row and FORCE stay', async () => {
    await seedCounter(org.orgId, 'ucdown.calls', { used: 4, period: 'NONE' }, db.name);
    await expect(down()).rejects.toThrow(REFUSAL);
    expect(await catalogState()).toEqual({
      table: 'usage_counters',
      fn: 'entitlements_usage_counter_period_ck()',
      feature: 1,
      force: true,
    });
    expect((await readCounters(org.orgId, db.name)).map((r) => r.used)).toEqual([4]);
  });
  it('(b) atomic: a consume committed while the down waits on the table lock is seen, and the down refuses', async () => {
    await withAppClient(
      (c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM usage_counters')),
      db.name,
    );
    const writer = await db.client('app');
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      await writer.query(
        `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
         SELECT app_current_org(), id, NULL, 1, 1 FROM entitlement_features WHERE key = 'ucdown.calls'`,
      );
      const pending = down();
      pending.catch(() => undefined);
      const watcher = await db.client('owner');
      try {
        const until = Date.now() + LOCK_DEADLINE_MS;
        for (;;) {
          const { rows } = await watcher.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.relation = to_regclass('public.usage_counters')`,
          );
          if ((rows[0]?.n ?? 0) > 0) break;
          if (Date.now() > until) throw new Error('the down never waited on the usage_counters lock');
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
    expect((await readCounters(org.orgId, db.name)).map((r) => r.used)).toEqual([1]);
  });
  it('(c) with no counter left the down drops the table, the function and the files.storage_bytes row; up restores them', async () => {
    await withAppClient(
      (c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM usage_counters')),
      db.name,
    );
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    expect(await catalogState()).toEqual({ table: null, fn: null, feature: 0, force: null });
    await runMigrations('up', { source: { kind: 'list', list } });
    expect(await catalogState()).toEqual({
      table: 'usage_counters',
      fn: 'entitlements_usage_counter_period_ck()',
      feature: 1,
      force: true,
    });
  });
});
```
(`ScratchDb.client(role: 'owner' | 'app' | 'auth')` có sẵn ở `test/support/scratch-db.ts`; ca (b) giữ một kết nối `app_user` mở để transaction chưa commit.)

- [ ] **Step 2: Chạy cho thấy đỏ**

Run: `pnpm vitest run --project integration test/integration/entitlements/usage-counters-down.spec.ts`
Expected: FAIL ở (a) và (b): `down` của Task 3 xanh dù còn bộ đếm (`resolves`), bảng biến mất.

- [ ] **Step 3: Viết `down` có từ chối**

`src/migrations/entitlements/Migration<ts>_usage_counters.ts` — thay `down()`:
```ts
  override down(): void | Promise<void> {
    // Dưới FORCE, app_owner không có policy nên thấy 0 dòng: bỏ FORCE để câu kiểm thấy thật. ALTER TABLE lấy ACCESS
    // EXCLUSIVE giữ tới hết lô, nên không consume nào chen vào giữa câu kiểm và DROP (consume đang mở thì down chờ nó).
    // RAISE → cả lô rollback, FORCE còn nguyên.
    this.addSql(
      `ALTER TABLE public.usage_counters NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.usage_counters) THEN
    RAISE EXCEPTION 'usage counters hold consumed quota; reverting usage_counters would reset the usage of every organization';
  END IF;
END $$;`);
    // Fail to (23001) nếu 4C đã có override trên `files.storage_bytes`: runbook xoá override trước (spec §7.7).
    this.addSql(
      `DELETE FROM entitlement_features WHERE key = 'files.storage_bytes';`,
    );
    this.addSql(`DROP TABLE usage_counters;`);
    this.addSql(`DROP FUNCTION entitlements_usage_counter_period_ck();`);
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
Thêm vào chú thích đầu file một dòng: ` * Down: từ chối khi còn bộ đếm (usage không dẫn xuất lại được; lệch có chủ đích so với §7.7, SP3 §6.13 "down khi có dữ liệu chặn").`

- [ ] **Step 4: Ca override của 4C (chỉ khi 4C đã merge)**

Run: `git grep -l "org_entitlement_overrides" origin/main -- src/migrations`
- Có file (4C đã merge trước 4B): thêm ca này vào cuối `describe` của Step 1, rồi chạy lại:
```ts
  it('(d) down fails on the foreign key while a 4C override references files.storage_bytes (runbook: remove overrides first)', async () => {
    await withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, () =>
          c.query(
            `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason)
             SELECT app_current_org(), id, 10, 'db-4' FROM entitlement_features WHERE key = 'files.storage_bytes'`,
          ),
        ),
      db.name,
    );
    await expect(down()).rejects.toThrow(/org_entitlement_overrides/);
    expect((await catalogState())?.table).toBe('usage_counters');
  });
```
  (cột của `org_entitlement_overrides` theo spec §7.4; tên lệch với migration thật của 4C → dùng tên thật).
- Không có file (4C chưa merge): không viết ca này, không commit test `skip`; ghi "DB-4 down bị override 4C chặn: carry sang 4C" vào báo cáo task và mô tả PR (4C là plan merge sau trong cặp, nó có cả hai bảng).

- [ ] **Step 5: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements/usage-counters-down.spec.ts test/integration/core/database/migrations.spec.ts
pnpm vitest run --project unit test/unit/migrations
```
Expected: PASS. `migrations.spec.ts` (up → down → up, sweep S2-R57 từng bước trên DB rỗng) vẫn xanh: bảng rỗng nên `down` đi tiếp; `migration-scan.spec.ts` xanh (khối khẳng định sau `NO FORCE`).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/migrations/entitlements test/integration/entitlements/usage-counters-down.spec.ts
git add src/migrations/entitlements test/integration/entitlements/usage-counters-down.spec.ts
git commit -m "feat(entitlements): the usage_counters down refuses while counters hold consumed quota, atomically with in-flight consumes"
```

---

## Phần C — Bộ đếm: miền, repository SQL, Quotas (spec §9.1–§9.4, §11, §13.1, §17, §19)

### Task 5: Miền quota, port `UsageCounterRepository` và repository SQL (consume một câu, release, đọc usage), bản đồ `key → id` của tính năng lúc boot

**Files:**
- Create: `src/modules/entitlements/domain/quota.ts`, `src/modules/entitlements/ports/usage-counter.repository.ts`, `src/modules/entitlements/infra/sql/sql-usage-counter.repository.ts`
- Modify: `src/modules/entitlements/ports/catalogue.reader.ts`, `src/modules/entitlements/infra/sql/sql-entitlement-catalogue.reader.ts`, `src/modules/entitlements/application/catalogue-check.ts`, `src/modules/entitlements/entitlements.module.ts`
- Create (test): `test/unit/modules/entitlements/quota.spec.ts`, `test/integration/entitlements/usage-counter-repository.spec.ts`
- Modify (test): `test/unit/modules/entitlements/catalogue-diff.spec.ts`, `test/unit/modules/entitlements/catalogue-check.spec.ts` (thêm `id` vào literal `FeatureRow`), `test/integration/entitlements/catalogue-check.spec.ts` (`featureId('cc.ghost')`)

**Interfaces:**
- Consumes: `ResetPeriod` (`domain/feature-catalogue.ts`), `Db` (`core/database`), `UnknownFeatureError` (`errors.ts`), `EntitlementCatalogueCheck` (4A), bảng của Task 3; test: `createTestApp` (`test/support/app-factory.ts`), `entitlementsCoreImports` (`test/support/entitlements-app.ts`), `FixtureFeaturesModule`, `fixturePlans`, `seedFixtureCatalogue`, `seedCounter`, `readCounters`, `periodStartOf`, `QUOTA_TZ`, `withOwner`.
- Produces:
  - `domain/quota.ts`: `type QuotaReceipt = { readonly featureKey: string; readonly periodStart: string | null; readonly amount: number }`; `type ConsumeResult = { readonly kind: 'CONSUMED'; readonly receipt: QuotaReceipt } | { readonly kind: 'EXCEEDED'; readonly limit: number; readonly used: number }`; `type QuotaPeriod = { readonly kind: 'NONE' } | { readonly kind: 'MONTH'; readonly timezone: string }`; `periodOf(resetPeriod: ResetPeriod, timezone: string): QuotaPeriod`; `reachedLimit(max: number, used: number, amount: number): boolean`.
  - `ports/usage-counter.repository.ts`: `type ConsumedCounter = { readonly id: string; readonly used: number; readonly version: number; readonly periodStart: Date | null }`; `type CurrentUsage = { readonly periodStart: Date; readonly periodEnd: Date; readonly used: ReadonlyMap<string, number> }`; `abstract class UsageCounterRepository { consume(i: { featureId: string; period: QuotaPeriod; amount: number; max: number | null }): Promise<ConsumedCounter | undefined>; usedNow(i: { featureId: string; period: QuotaPeriod }): Promise<number>; release(i: { featureId: string; periodStart: string | null; amount: number }): Promise<number | undefined>; currentUsage(timezone: string): Promise<CurrentUsage> }`.
  - `infra/sql/sql-usage-counter.repository.ts`: `SqlUsageCounterRepository extends UsageCounterRepository`; `monthPeriodStartSql(clock: string): string` (mảnh SQL `date_trunc('month', <clock>, ?)`, tham số múi giờ đi sau tham số của `clock`).
  - `FeatureRow` thêm `id: string`; `EntitlementCatalogueCheck.featureId(key: string): string` (ném `UnknownFeatureError` với key lạ, ném `Error` nếu gọi trước khi check chạy).
  - `EntitlementsCoreModule` provide + export `UsageCounterRepository` (`useExisting: SqlUsageCounterRepository`; `OrgEntitlementsQuery` ở `EntitlementsHttpModule` cần nó, Task 9).

- [ ] **Step 1: Unit test miền (đỏ)**

`test/unit/modules/entitlements/quota.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  periodOf,
  reachedLimit,
} from '../../../../src/modules/entitlements/domain/quota.js';

describe('quota domain (spec SP4 §9.1, §11 periodOf, S4-D16, E-10)', () => {
  it('periodOf: NONE has no period; MONTH carries the configured timezone (the DB computes the instant)', () => {
    expect(periodOf('NONE', 'Asia/Ho_Chi_Minh')).toEqual({ kind: 'NONE' });
    expect(periodOf('MONTH', 'Asia/Ho_Chi_Minh')).toEqual({
      kind: 'MONTH',
      timezone: 'Asia/Ho_Chi_Minh',
    });
  });
  it.each([
    [3, 3, 1, true],
    [3, 3, 3, true],
    [3, 2, 1, false],
    [3, 1, 1, false],
    [1, 1, 1, true],
  ])('reachedLimit(max %i, used %i, amount %i) = %s: only the consume that crosses the limit', (max, used, amount, out) => {
    expect(reachedLimit(max, used, amount)).toBe(out);
  });
});
```

`test/unit/modules/entitlements/catalogue-diff.spec.ts` — thêm `id` vào mọi literal `FeatureRow` (kiểu mới bắt buộc; phép so bỏ qua `id`):
```ts
const featureRows: FeatureRow[] = [
  { id: '1', key: 'x.flag', kind: 'FLAG', resetPeriod: null, deprecated: false },
  { id: '2', key: 'x.calls', kind: 'QUOTA', resetPeriod: 'MONTH', deprecated: false },
  { id: '3', key: 'x.old', kind: 'FLAG', resetPeriod: null, deprecated: true },
];
```
và trong ca thứ hai:
```ts
    const fr: FeatureRow[] = [
      { id: '1', key: 'x.flag', kind: 'LIMIT', resetPeriod: null, deprecated: false },
      { id: '2', key: 'x.calls', kind: 'QUOTA', resetPeriod: 'NONE', deprecated: false },
      { id: '9', key: 'x.ghost', kind: 'FLAG', resetPeriod: null, deprecated: false },
    ];
```
(các literal `FeatureRow` khác của file và của `test/unit/modules/entitlements/catalogue-check.spec.ts` (Task 2) thêm `id` cùng cách, mỗi literal một id khác nhau).

- [ ] **Step 2: Integration test repository (đỏ)**

`test/integration/entitlements/usage-counter-repository.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { EntitlementCatalogueCheck } from '../../../src/modules/entitlements/application/catalogue-check.js';
import { UnknownFeatureError } from '../../../src/modules/entitlements/index.js';
import { monthPeriodStartSql } from '../../../src/modules/entitlements/infra/sql/sql-usage-counter.repository.js';
import { UsageCounterRepository } from '../../../src/modules/entitlements/ports/usage-counter.repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  QUOTA_TZ,
  periodStartOf,
  readCounters,
  seedCounter,
  seedOrgEntitlement,
  withOwner,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const MONTH = { kind: 'MONTH', timezone: QUOTA_TZ } as const;
const NONE = { kind: 'NONE' } as const;
const iso = (v: unknown) => z.coerce.date().parse(v).toISOString();

describe('SqlUsageCounterRepository (spec SP4 §9.2, §9.3, §12.1; S4-T2, QU-3)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const repo = () => app.get(UsageCounterRepository);
  const id = (key: string) => app.get(EntitlementCatalogueCheck).featureId(key);
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  const freshOrg = async () => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, 'metered');
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

  it('featureId is the id of the entitlement_features row read by the boot-time check; an unknown key is UnknownFeatureError', async () => {
    const rows = await withOwner(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT id::text AS id FROM entitlement_features WHERE key = 'fixture.api_calls'`,
          )
        ).rows,
    );
    expect(id('fixture.api_calls')).toBe(rows[0]?.id);
    expect(() => id('fixture.nope')).toThrow(UnknownFeatureError);
  });
  it('S4-T2 through Db.execute placeholders: NULL period 3 → 5 → refused; one row, version 2', async () => {
    const o = await freshOrg();
    const f = id('fixture.saved_reports');
    const r1 = await inTx(o.orgId, () => repo().consume({ featureId: f, period: NONE, amount: 3, max: 5 }));
    const r2 = await inTx(o.orgId, () => repo().consume({ featureId: f, period: NONE, amount: 2, max: 5 }));
    const r3 = await inTx(o.orgId, () => repo().consume({ featureId: f, period: NONE, amount: 1, max: 5 }));
    expect([r1?.used, r1?.version, r1?.periodStart, r2?.used, r2?.version, r3]).toEqual([3, 1, null, 5, 2, undefined]);
    expect(r2?.id).toBe(r1?.id);
    expect((await readCounters(o.orgId)).map((r) => [r.feature, r.used])).toEqual([['fixture.saved_reports', 5]]);
  });
  it('max: null (UNLIMITED) has no guard: the counter still counts', async () => {
    const o = await freshOrg();
    const r = await inTx(o.orgId, () =>
      repo().consume({ featureId: id('fixture.api_calls'), period: MONTH, amount: 1_000_000, max: null }),
    );
    expect(r?.used).toBe(1_000_000);
  });
  it('QU-3: a MONTH consume lands on the month start of the configured timezone, whatever the session TimeZone', async () => {
    const o = await freshOrg();
    const r = await inTx(o.orgId, async () => {
      await app.get(Db).execute(`SET LOCAL TIME ZONE 'America/New_York'`);
      return repo().consume({ featureId: id('fixture.api_calls'), period: MONTH, amount: 1, max: 3 });
    });
    expect(r?.periodStart?.toISOString()).toBe((await periodStartOf(0)).toISOString());
  });
  it('QU-3 boundary: 16:59:59Z and 17:00:00Z of the last day of September fall in two months in UTC+7', async () => {
    const [row] = await app
      .get(Db)
      .execute<{ a: unknown; b: unknown }>(
        `SELECT ${monthPeriodStartSql('?::timestamptz')} AS a, ${monthPeriodStartSql('?::timestamptz')} AS b`,
        ['2026-09-30T16:59:59Z', QUOTA_TZ, '2026-09-30T17:00:00Z', QUOTA_TZ],
      );
    expect([iso(row?.a), iso(row?.b)]).toEqual([
      '2026-08-31T17:00:00.000Z',
      '2026-09-30T17:00:00.000Z',
    ]);
  });
  it('QU-3: a full counter of the previous month does not block the current month (lazy reset, two rows)', async () => {
    const o = await freshOrg();
    await seedCounter(o.orgId, 'fixture.api_calls', { used: 3, period: { monthsAgo: 1 } });
    const r = await inTx(o.orgId, () =>
      repo().consume({ featureId: id('fixture.api_calls'), period: MONTH, amount: 1, max: 3 }),
    );
    expect(r?.used).toBe(1);
    expect(
      (await readCounters(o.orgId)).map((c) => [c.periodStart?.toISOString(), c.used]),
    ).toEqual([
      [(await periodStartOf(1)).toISOString(), 3],
      [(await periodStartOf(0)).toISOString(), 1],
    ]);
  });
  it('usedNow: 0 without a row; the value of the current period otherwise (read only)', async () => {
    const o = await freshOrg();
    const f = id('fixture.api_calls');
    expect(await inTx(o.orgId, () => repo().usedNow({ featureId: f, period: MONTH }))).toBe(0);
    await seedCounter(o.orgId, 'fixture.api_calls', { used: 2, period: { monthsAgo: 0 } });
    await seedCounter(o.orgId, 'fixture.api_calls', { used: 9, period: { monthsAgo: 1 } });
    expect(await inTx(o.orgId, () => repo().usedNow({ featureId: f, period: MONTH }))).toBe(2);
  });
  it('release: the right period decrements and bumps the version; more than used, a missing row or another period → undefined, nothing changes', async () => {
    const o = await freshOrg();
    const f = id('fixture.api_calls');
    await seedCounter(o.orgId, 'fixture.api_calls', { used: 3, period: { monthsAgo: 0 } });
    const current = (await periodStartOf(0)).toISOString();
    const previous = (await periodStartOf(1)).toISOString();
    expect(await inTx(o.orgId, () => repo().release({ featureId: f, periodStart: current, amount: 2 }))).toBe(1);
    expect(await inTx(o.orgId, () => repo().release({ featureId: f, periodStart: current, amount: 2 }))).toBeUndefined();
    expect(await inTx(o.orgId, () => repo().release({ featureId: f, periodStart: previous, amount: 1 }))).toBeUndefined();
    expect(
      await inTx(o.orgId, () => repo().release({ featureId: id('fixture.saved_reports'), periodStart: null, amount: 1 })),
    ).toBeUndefined();
    expect((await readCounters(o.orgId)).map((c) => [c.used, c.version])).toEqual([[1, 2]]);
  });
  it('currentUsage: month bounds in the timezone; used by key for current MONTH and NONE counters only', async () => {
    const o = await freshOrg();
    await seedCounter(o.orgId, 'fixture.api_calls', { used: 9, period: { monthsAgo: 1 } });
    await seedCounter(o.orgId, 'fixture.api_calls', { used: 2, period: { monthsAgo: 0 } });
    await seedCounter(o.orgId, 'fixture.saved_reports', { used: 1, period: 'NONE' });
    const u = await inTx(o.orgId, () => repo().currentUsage(QUOTA_TZ));
    expect(u.periodStart.toISOString()).toBe((await periodStartOf(0)).toISOString());
    expect(u.periodEnd.toISOString()).toBe((await periodStartOf(-1)).toISOString());
    expect(Object.fromEntries(u.used)).toEqual({
      'fixture.api_calls': 2,
      'fixture.saved_reports': 1,
    });
  });
  it('currentUsage of an org without counters: the bounds and an empty map', async () => {
    const o = await freshOrg();
    const u = await inTx(o.orgId, () => repo().currentUsage(QUOTA_TZ));
    expect([u.used.size, u.periodEnd > u.periodStart]).toEqual([0, true]);
  });
});
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/quota.spec.ts test/unit/modules/entitlements/catalogue-diff.spec.ts
pnpm vitest run --project integration test/integration/entitlements/usage-counter-repository.spec.ts
```
Expected: FAIL — module `domain/quota.js`, `usage-counter.repository.js`, `sql-usage-counter.repository.js` không tồn tại; `catalogue-diff.spec.ts` lỗi kiểu (`id` không có trong `FeatureRow`).

- [ ] **Step 4: Miền**

`src/modules/entitlements/domain/quota.ts`:
```ts
import type { ResetPeriod } from './feature-catalogue.js';

/** Một lần tiêu thụ (spec §9.1): `periodStart` ISO UTC của dòng kỳ (`null` với kỳ NONE); `release` trả đúng dòng đó. */
export type QuotaReceipt = {
  readonly featureKey: string;
  readonly periodStart: string | null;
  readonly amount: number;
};
/** Kết quả nghiệp vụ, không phải exception: `consumeOrThrow` mới đổi `EXCEEDED` thành `422 quota_exceeded`. */
export type ConsumeResult =
  | { readonly kind: 'CONSUMED'; readonly receipt: QuotaReceipt }
  | {
      readonly kind: 'EXCEEDED';
      readonly limit: number;
      readonly used: number;
    };
/** Kỳ của bộ đếm (spec §11 `periodOf`): mốc thời gian do câu SQL tính từ `now()` của DB, không ở app. */
export type QuotaPeriod =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'MONTH'; readonly timezone: string };

export function periodOf(
  resetPeriod: ResetPeriod,
  timezone: string,
): QuotaPeriod {
  switch (resetPeriod) {
    case 'NONE':
      return { kind: 'NONE' };
    case 'MONTH':
      return { kind: 'MONTH', timezone };
    default: {
      const unknown: never = resetPeriod;
      throw new Error(`unknown reset period ${String(unknown)}`);
    }
  }
}

/**
 * Lần tiêu thụ thành công này đưa `used` chạm trần (S4-D16): `used ≥ max` và trước nó `used − amount < max`. Hai consume
 * song song tuần tự hoá trên khoá dòng, nên mỗi lần chuyển sang "chạm trần" đúng một consume thoả điều kiện (E-10);
 * chạm lại sau một `release` là một lần chuyển mới và phát lại (review M3, không khử trùng theo kỳ).
 */
export const reachedLimit = (
  max: number,
  used: number,
  amount: number,
): boolean => used >= max && used - amount < max;
```

- [ ] **Step 5: Port và repository SQL**

`src/modules/entitlements/ports/usage-counter.repository.ts`:
```ts
import type { QuotaPeriod } from '../domain/quota.js';

/** Dòng sau một consume thành công; `periodStart` là `null` với kỳ NONE. */
export type ConsumedCounter = {
  readonly id: string;
  readonly used: number;
  readonly version: number;
  readonly periodStart: Date | null;
};
/** Usage cho API tenant (spec §12.1): ranh giới kỳ MONTH hiện tại và `used` theo key (kỳ hiện tại hoặc NONE). */
export type CurrentUsage = {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly used: ReadonlyMap<string, number>;
};

/** Mọi phương thức chạy trong transaction + org context của caller (RLS); SQL vẫn ghi `org_id = app_current_org()`. */
export abstract class UsageCounterRepository {
  /** Một câu `INSERT … ON CONFLICT … DO UPDATE … WHERE` (spec §9.2); `max: null` = UNLIMITED (không WHERE); 0 dòng → `undefined`. */
  abstract consume(i: {
    featureId: string;
    period: QuotaPeriod;
    amount: number;
    max: number | null;
  }): Promise<ConsumedCounter | undefined>;
  /** `used` của dòng kỳ hiện tại, 0 khi chưa có dòng; chỉ đọc (dùng cho `EXCEEDED`). */
  abstract usedNow(i: { featureId: string; period: QuotaPeriod }): Promise<number>;
  /** Trả `amount` về đúng dòng kỳ (spec §9.3); 0 dòng (không có dòng hoặc `used < amount`) → `undefined`; trả `used` mới. */
  abstract release(i: {
    featureId: string;
    periodStart: string | null;
    amount: number;
  }): Promise<number | undefined>;
  abstract currentUsage(timezone: string): Promise<CurrentUsage>;
}
```

`src/modules/entitlements/infra/sql/sql-usage-counter.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import type { QuotaPeriod } from '../../domain/quota.js';
import {
  UsageCounterRepository,
  type ConsumedCounter,
  type CurrentUsage,
} from '../../ports/usage-counter.repository.js';

/**
 * Đầu tháng của `clock` theo múi giờ tham số (spec §9.2, PG ≥ 16): tham số múi giờ đi SAU tham số (nếu có) của `clock`.
 * App dùng `now()` (giờ bắt đầu transaction: consume, release, đọc usage trong cùng transaction luôn cùng kỳ; E-3 "mỗi
 * transaction rơi vào đúng một kỳ"); test QU-3 dùng một mốc cố định.
 */
export const monthPeriodStartSql = (clock: string): string =>
  `date_trunc('month', ${clock}, ?)`;

/** Biểu thức kỳ + tham số theo `QuotaPeriod`, `switch` vét cạn. NONE là NULL (arbiter NULLS NOT DISTINCT, spike S4-T2). */
function periodSql(p: QuotaPeriod): { sql: string; params: unknown[] } {
  switch (p.kind) {
    case 'NONE':
      return { sql: 'NULL::timestamptz', params: [] };
    case 'MONTH':
      return { sql: monthPeriodStartSql('now()'), params: [p.timezone] };
    default: {
      const unknown: never = p;
      throw new Error(`unknown quota period ${JSON.stringify(unknown)}`);
    }
  }
}
/** Vị từ theo kỳ dùng được index (`IS NOT DISTINCT FROM` không dùng được index btree). */
function periodWhere(p: QuotaPeriod): { sql: string; params: unknown[] } {
  switch (p.kind) {
    case 'NONE':
      return { sql: 'period_start IS NULL', params: [] };
    case 'MONTH':
      return {
        sql: `period_start = ${monthPeriodStartSql('now()')}`,
        params: [p.timezone],
      };
    default: {
      const unknown: never = p;
      throw new Error(`unknown quota period ${JSON.stringify(unknown)}`);
    }
  }
}

/** `Db.execute` trả BIGINT dạng chuỗi (đọc bằng `::text`) và TIMESTAMPTZ dạng chuỗi (bài học 3A): coerce. */
const Consumed = z.object({
  id: z.string(),
  used: z.coerce.number().int().min(0),
  version: z.coerce.number().int().min(0),
  period_start: z.coerce.date().nullable(),
});
const Used = z.object({ used: z.coerce.number().int().min(0) });
const UsageRow = z.object({
  period_start: z.coerce.date(),
  period_end: z.coerce.date(),
  feature: z.string().nullable(),
  used: z.coerce.number().int().min(0).nullable(),
});

@Injectable()
export class SqlUsageCounterRepository extends UsageCounterRepository {
  constructor(private readonly db: Db) {
    super();
  }

  /**
   * Spec §9.2. Nhánh DO UPDATE khoá dòng xung đột rồi mới tính WHERE trên phiên bản mới nhất (E-1); hai INSERT đồng thời:
   * bên sau chờ index unique rồi đi DO UPDATE (E-2). `updated_at = clock_timestamp()`: ghi sau khi có thể đã chờ khoá dòng.
   */
  async consume(i: {
    featureId: string;
    period: QuotaPeriod;
    amount: number;
    max: number | null;
  }): Promise<ConsumedCounter | undefined> {
    const p = periodSql(i.period);
    const guard =
      i.max === null
        ? ''
        : 'WHERE usage_counters.used + EXCLUDED.used <= ?::bigint';
    const rows = await this.db.execute(
      `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
       VALUES (app_current_org(), ?::bigint, ${p.sql}, ?::bigint, 1)
       ON CONFLICT (org_id, feature_id, period_start)
       DO UPDATE SET used = usage_counters.used + EXCLUDED.used, version = usage_counters.version + 1,
                     updated_at = clock_timestamp()
       ${guard}
       RETURNING id::text AS id, used::text AS used, version::text AS version, period_start`,
      [
        i.featureId,
        ...p.params,
        String(i.amount),
        ...(i.max === null ? [] : [String(i.max)]),
      ],
    );
    if (rows.length > 1)
      throw new Error(`consume returned ${rows.length} rows (usage_counters_period_uq violated?)`);
    if (!rows[0]) return undefined;
    const r = Consumed.parse(rows[0]);
    return { id: r.id, used: r.used, version: r.version, periodStart: r.period_start };
  }

  async usedNow(i: { featureId: string; period: QuotaPeriod }): Promise<number> {
    const w = periodWhere(i.period);
    const rows = await this.db.execute(
      `SELECT used::text AS used FROM usage_counters
       WHERE org_id = app_current_org() AND feature_id = ?::bigint AND ${w.sql}`,
      [i.featureId, ...w.params],
    );
    return rows[0] ? Used.parse(rows[0]).used : 0;
  }

  /** Spec §9.3: hai biến thể theo kỳ (đều dùng `usage_counters_period_uq`); `used >= amount` + `CHECK (used >= 0)` (E-14). */
  async release(i: {
    featureId: string;
    periodStart: string | null;
    amount: number;
  }): Promise<number | undefined> {
    const period =
      i.periodStart === null
        ? { sql: 'period_start IS NULL', params: [] }
        : { sql: 'period_start = ?::timestamptz', params: [i.periodStart] };
    const rows = await this.db.execute(
      `UPDATE usage_counters SET used = used - ?::bigint, version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND feature_id = ?::bigint AND ${period.sql} AND used >= ?::bigint
       RETURNING used::text AS used`,
      [String(i.amount), i.featureId, ...period.params, String(i.amount)],
    );
    return rows[0] ? Used.parse(rows[0]).used : undefined;
  }

  /**
   * Spec §12.1: một câu, luôn ≥ 1 dòng (dòng ranh giới kỳ); `periodEnd = date_add(start, '1 month', tz)`. Bộ đếm của kỳ
   * MONTH cũ không lọt vào (chỉ `period_start IS NULL` hoặc = kỳ hiện tại); index `usage_counters_period_uq` (theo org).
   */
  async currentUsage(timezone: string): Promise<CurrentUsage> {
    const rows = (
      await this.db.execute(
        `SELECT p.start AS period_start, date_add(p.start, interval '1 month', ?) AS period_end,
                f.key AS feature, c.used::text AS used
         FROM (SELECT ${monthPeriodStartSql('now()')} AS start) p
         LEFT JOIN usage_counters c ON c.org_id = app_current_org() AND (c.period_start IS NULL OR c.period_start = p.start)
         LEFT JOIN entitlement_features f ON f.id = c.feature_id`,
        [timezone, timezone],
      )
    ).map((r) => UsageRow.parse(r));
    const [first] = rows;
    if (!first) throw new Error('the usage query returned no row (the bounds row is unconditional)');
    const used = new Map<string, number>();
    for (const r of rows)
      if (r.feature !== null && r.used !== null) used.set(r.feature, r.used);
    return { periodStart: first.period_start, periodEnd: first.period_end, used };
  }
}
```

- [ ] **Step 6: Bản đồ `key → id` lúc boot**

`src/modules/entitlements/ports/catalogue.reader.ts` — `FeatureRow` thêm `id: string` (dòng đầu của kiểu):
```ts
export type FeatureRow = {
  id: string;
  key: string;
  kind: FeatureKind;
  resetPeriod: ResetPeriod | null;
  deprecated: boolean;
};
```

`src/modules/entitlements/infra/sql/sql-entitlement-catalogue.reader.ts` — `FeatureRaw` thêm `id: z.string()`, câu SQL thành `SELECT id::text AS id, key, kind, reset_period, deprecated_at IS NOT NULL AS deprecated FROM entitlement_features ORDER BY key`, và `map` trả thêm `id: f.id`.

`src/modules/entitlements/application/catalogue-check.ts` — thêm import `UnknownFeatureError` từ `'../errors.js'`; trong lớp `EntitlementCatalogueCheck`:
```ts
  /** `key → id` của `entitlement_features`, nạp khi check đạt (spec §9.2: câu consume không tra key → id lúc chạy). */
  private ids: ReadonlyMap<string, string> | undefined;
```
trong `onModuleInit` (dạng của Task 2), thay `if (errors.length === 0) return;` bằng (bản đồ chỉ nạp khi không có lỗi và chỉ với key code biết, nên dòng chỉ có ở DB không bao giờ có id, R-X30):
```ts
    if (errors.length === 0) {
      const known = this.registry.features();
      this.ids = new Map(
        featureRows.filter((r) => known.has(r.key)).map((r) => [r.key, r.id]),
      );
      return;
    }
```
và thêm phương thức:
```ts
  /** Dòng bất biến (trigger 4A), nên id nạp lúc boot đúng tới khi pod dừng; key lạ → lỗi lập trình có tên. */
  featureId(key: string): string {
    if (!this.ids)
      throw new Error(
        'EntitlementCatalogueCheck.featureId was called before the boot-time catalogue check passed',
      );
    const id = this.ids.get(key);
    if (id === undefined) throw new UnknownFeatureError(key);
    return id;
  }
```

`src/modules/entitlements/entitlements.module.ts` — import `SqlUsageCounterRepository` và `UsageCounterRepository`; trong `providers` của `EntitlementsCoreModule.register` thêm:
```ts
        SqlUsageCounterRepository,
        {
          provide: UsageCounterRepository,
          useExisting: SqlUsageCounterRepository,
        },
```
và trong `exports` thêm `UsageCounterRepository`.

`test/integration/entitlements/catalogue-check.spec.ts` — import `EntitlementCatalogueCheck` từ `'../../../src/modules/entitlements/application/catalogue-check.js'`; trong ca R-X30 `'a feature row only in the database warns with its key, counts, boots, and stays out of evaluation'` (Task 2), sau khẳng định metric mismatch, thêm:
```ts
    expect(() => a.get(EntitlementCatalogueCheck).featureId('cc.ghost')).toThrow(UnknownFeatureError);
```

- [ ] **Step 7: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm vitest run --project integration test/integration/entitlements
pnpm typecheck
```
Expected: PASS; `typecheck` sạch.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements/usage-counter-repository.spec.ts
git add src/modules/entitlements test/unit/modules/entitlements test/integration/entitlements/usage-counter-repository.spec.ts
git commit -m "feat(entitlements): usage counter repository (one-statement consume, release, current usage) and the boot-time feature id map"
```

---
### Task 6: `Quotas.consume`/`consumeOrThrow` trong transaction của caller, event `entitlements.quota.reached`, metric và span (QU-3 phần app, QU-4, QU-5, QU-6 tuần tự, QU-9, Review Focus 1 và 5)

**Files:**
- Create: `src/modules/entitlements/application/quotas.service.ts`
- Modify: `src/modules/entitlements/events.ts`, `src/modules/entitlements/application/entitlements-metrics.ts`, `src/modules/entitlements/entitlements.module.ts`, `src/modules/entitlements/index.ts`
- Create (test): `test/unit/modules/entitlements/quotas.spec.ts`, `test/integration/entitlements/quotas.spec.ts`

**Interfaces:**
- Consumes: `UnitOfWork.inTransaction()`, `RequestContext.orgId()/principal()/setPrincipal()`, `EventPublisher.publish(def, { data, aggregate, actor })`, `EventActor` (core); `Entitlements.limitOf(key): Promise<Limit>` (4A; đọc snapshot trong transaction của caller); `EntitlementCatalogueRegistry.feature(key): FeatureEntry` (4A); `EntitlementCatalogueCheck.featureId(key)`, `UsageCounterRepository`, `periodOf`, `reachedLimit`, `QuotaReceipt`, `ConsumeResult` (Task 5); `entitlementsSpan` (4A); `quotaExceeded(featureKey): AppError`, `EntitlementsContextError`, `FeatureKindMismatchError`, `UnknownFeatureError` (4A); `isCount` (`domain/feature-catalogue.ts`); `pgFields` (core/database); test: `installOtelCapture` (`test/support/otel-capture.ts`), `ownerQuery` (`test/support/identity-app.ts`), `parseEnvelope` (core/events), `toEnvelope`, `OutboxRow` (`src/core/events/event-dispatch.handlers.ts`).
- Produces:
  - `class Quotas { consume(key: string, amount: number): Promise<ConsumeResult>; consumeOrThrow(key: string, amount: number): Promise<QuotaReceipt> }` (Task 7 thêm `release`, `releaseAllocation`), provider + export của `EntitlementsCoreModule` (`@Global`), export ở `index.ts`.
  - `QuotaReachedEvent` (`entitlements.quota.reached@1`, `audit: true`, `webhook: false`, `data: { orgId, feature, periodStart: string | null, limit: number, used: number }`), `USAGE_COUNTER_AGGREGATE = 'usage_counter'` (`events.ts`); export `QuotaReachedEvent` ở `index.ts`.
  - `EntitlementsMetrics.quotaConsume` (`entitlements_quota_consume_total{feature, result}`, `result ∈ consumed | exceeded`), `EntitlementsMetrics.quotaConsumeDuration` (`entitlements_quota_consume_duration_seconds`); span `entitlements.quota.consume` với `entitlements.result`.
  - Log ERROR `{ event: 'entitlements_counter_refused', feature }` khi trigger `usage_counters_period_ck` bắn (code và catalogue lệch DB).
  - Actor của `quota.reached`: user → `{ type: 'user', id }`; org API key → `{ type: 'service', id: 'api_key:<publicId>' }`; service → `{ type: 'service', id }`; không principal (job) → `{ type: 'system', id: 'entitlements.quotas' }`.

- [ ] **Step 1: Unit test (đỏ)**

`test/unit/modules/entitlements/quotas.spec.ts`:
```ts
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestContext, type Principal } from '../../../../src/core/context/index.js';
import { UnitOfWork } from '../../../../src/core/database/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { EventPublisher } from '../../../../src/core/events/index.js';
import { EntitlementCatalogueCheck } from '../../../../src/modules/entitlements/application/catalogue-check.js';
import { EntitlementCatalogueRegistry } from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import { Quotas } from '../../../../src/modules/entitlements/application/quotas.service.js';
import type { Limit } from '../../../../src/modules/entitlements/domain/effective-value.js';
import {
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';
import {
  EntitlementsContextError,
  FeatureKindMismatchError,
  UnknownFeatureError,
} from '../../../../src/modules/entitlements/errors.js';
import {
  UsageCounterRepository,
  type ConsumedCounter,
} from '../../../../src/modules/entitlements/ports/usage-counter.repository.js';

const ORG = '0198c000-0000-7000-8000-00000000000b';
const FEATURES = mergeFeatureCatalogues([
  featureCatalogueData({
    'q.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 3 } },
    'q.saved': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: { max: 2 } },
    'q.old': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: { max: 2 }, deprecated: true },
    'q.flag': { kind: 'FLAG', fallback: false },
    'q.cap': { kind: 'LIMIT', fallback: { max: 1 } },
  }),
]);
type State = {
  inTx: boolean;
  orgId: string | undefined;
  principal: Principal | undefined;
  limit: Limit;
  row: ConsumedCounter | undefined;
  used: number;
  consumeCalls: number;
  published: { data: unknown; aggregate: unknown; actor: unknown }[];
};
const state: State = {
  inTx: true,
  orgId: ORG,
  principal: undefined,
  limit: { kind: 'MAX', max: 3 },
  row: undefined,
  used: 0,
  consumeCalls: 0,
  published: [],
};
const counter = (used: number, version = 1): ConsumedCounter => ({
  id: '41',
  used,
  version,
  periodStart: new Date('2026-09-30T17:00:00.000Z'),
});

describe('Quotas (spec SP4 §6.4, §9.2; unit with fakes)', () => {
  let ref: INestApplicationContext;
  let quotas: Quotas;
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      providers: [
        Quotas,
        EntitlementsMetrics,
        { provide: UnitOfWork, useValue: { inTransaction: () => state.inTx } },
        {
          provide: RequestContext,
          useValue: { orgId: () => state.orgId, principal: () => state.principal },
        },
        { provide: Entitlements, useValue: { limitOf: () => Promise.resolve(state.limit) } },
        {
          provide: EntitlementCatalogueRegistry,
          useValue: {
            feature: (k: string) => {
              const f = FEATURES.get(k);
              if (!f) throw new UnknownFeatureError(k);
              return f;
            },
          },
        },
        { provide: EntitlementCatalogueCheck, useValue: { featureId: () => '7' } },
        {
          provide: UsageCounterRepository,
          useValue: {
            consume: () => {
              state.consumeCalls += 1;
              return Promise.resolve(state.row);
            },
            usedNow: () => Promise.resolve(state.used),
          },
        },
        {
          provide: EventPublisher,
          useValue: {
            publish: (_def: unknown, input: State['published'][number]) => {
              state.published.push(input);
              return Promise.resolve();
            },
          },
        },
        {
          provide: entitlementsConfig.KEY,
          useValue: { quotaTimezone: 'Asia/Ho_Chi_Minh', rowMissingRetryAfterSec: 5 },
        },
      ],
    }).compile();
    ref = await m.init();
    quotas = ref.get(Quotas);
  });
  beforeEach(() => {
    Object.assign(state, {
      inTx: true,
      orgId: ORG,
      principal: undefined,
      limit: { kind: 'MAX', max: 3 },
      row: undefined,
      used: 0,
      consumeCalls: 0,
      published: [],
    });
  });

  it('QU-9: outside a UnitOfWork or an organization context → EntitlementsContextError, no SQL', async () => {
    state.inTx = false;
    await expect(quotas.consume('q.calls', 1)).rejects.toBeInstanceOf(EntitlementsContextError);
    state.inTx = true;
    state.orgId = undefined;
    await expect(quotas.consume('q.calls', 1)).rejects.toBeInstanceOf(EntitlementsContextError);
    expect(state.consumeCalls).toBe(0);
  });
  it('a FLAG, a LIMIT or a deprecated QUOTA → FeatureKindMismatchError; an unknown key → UnknownFeatureError', async () => {
    for (const k of ['q.flag', 'q.cap', 'q.old'])
      await expect(quotas.consume(k, 1), k).rejects.toBeInstanceOf(FeatureKindMismatchError);
    await expect(quotas.consume('q.nope', 1)).rejects.toBeInstanceOf(UnknownFeatureError);
    expect(state.consumeCalls).toBe(0);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'Review Focus 1: amount %s is refused before any SQL (RangeError)',
    async (amount) => {
      await expect(quotas.consume('q.calls', amount)).rejects.toBeInstanceOf(RangeError);
      expect(state.consumeCalls).toBe(0);
    },
  );
  it('amount above the limit → EXCEEDED with the current usage, the consume statement never runs (QU-5)', async () => {
    state.used = 1;
    expect(await quotas.consume('q.calls', 4)).toEqual({ kind: 'EXCEEDED', limit: 3, used: 1 });
    expect(state.consumeCalls).toBe(0);
  });
  it('0 rows from the guarded statement → EXCEEDED; consumeOrThrow → 422 quota_exceeded with the key in errors[0]', async () => {
    state.used = 3;
    expect(await quotas.consume('q.calls', 1)).toEqual({ kind: 'EXCEEDED', limit: 3, used: 3 });
    const err: unknown = await quotas.consumeOrThrow('q.calls', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    if (err instanceof AppError)
      expect([err.error.code, err.opts.fields]).toEqual([
        'quota_exceeded',
        [{ path: 'feature', code: 'q.calls', message: 'Quota exceeded' }],
      ]);
  });
  it('an UNLIMITED consume that returns no row is a broken repository contract (fail loud)', async () => {
    state.limit = { kind: 'UNLIMITED' };
    await expect(quotas.consume('q.calls', 1)).rejects.toThrow(/UNLIMITED consume/);
  });
  it('CONSUMED carries the receipt; quota.reached is published only by the consume that reaches the limit (S4-D16)', async () => {
    state.row = counter(2);
    expect(await quotas.consume('q.calls', 1)).toEqual({
      kind: 'CONSUMED',
      receipt: { featureKey: 'q.calls', periodStart: '2026-09-30T17:00:00.000Z', amount: 1 },
    });
    expect(state.published).toEqual([]);
    state.row = counter(3, 3);
    await quotas.consume('q.calls', 1);
    expect(state.published).toEqual([
      {
        data: { orgId: ORG, feature: 'q.calls', periodStart: '2026-09-30T17:00:00.000Z', limit: 3, used: 3 },
        aggregate: { type: 'usage_counter', id: '41', version: 3 },
        actor: { type: 'system', id: 'entitlements.quotas' },
      },
    ]);
  });
  it.each([
    [{ type: 'user', id: 'u1' }, { type: 'user', id: 'u1' }],
    [{ type: 'api_key', id: 'k1' }, { type: 'service', id: 'api_key:k1' }],
    [{ type: 'service', id: 's1' }, { type: 'service', id: 's1' }],
  ] as const)('Review Focus 5 (unit): principal %o → actor %o', async (principal, actor) => {
    state.principal = principal;
    state.row = counter(3);
    await quotas.consume('q.calls', 1);
    expect(state.published.at(-1)?.actor).toEqual(actor);
  });
});
```

- [ ] **Step 2: Integration test (đỏ)**

`test/integration/entitlements/quotas.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext, type Principal } from '../../../src/core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import { toEnvelope, type OutboxRow } from '../../../src/core/events/event-dispatch.handlers.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  FeatureKindMismatchError,
  QuotaReachedEvent,
  Quotas,
} from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  periodStartOf,
  readCounters,
  seedCounter,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
const OUTBOX_SQL = `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
  aggregate_version::text AS aggregate_version, payload, headers, occurred_at
  FROM outbox_events WHERE type = 'entitlements.quota.reached' AND org_id = $1 ORDER BY id`;

describe('Quotas.consume on Postgres (spec SP4 §9.2, S4-D6, S4-D16; QU-3…QU-6, QU-9)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const quotas = () => app.get(Quotas);
  /** Transaction của caller (feature thật gọi trong `UnitOfWork.run` của side effect, spec §9.2). */
  const inTx = <T>(orgId: string, fn: () => Promise<T>, principal?: Principal) =>
    app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() => {
        if (principal) app.get(RequestContext).setPrincipal(principal);
        return fn();
      }),
    );
  const orgOn = async (plan: string | undefined) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  const reached = (orgId: string) =>
    ownerQuery<OutboxRow>(OUTBOX_SQL, [orgId]).then((rows) =>
      rows.map((r) => parseEnvelope(QuotaReachedEvent, toEnvelope(r))),
    );
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

  it('consumes in the caller transaction; the receipt names the period row; metric and span say consumed', async () => {
    const o = await orgOn('metered');
    const r = await inTx(o.orgId, () => quotas().consume('fixture.api_calls', 2));
    expect(r).toEqual({
      kind: 'CONSUMED',
      receipt: {
        featureKey: 'fixture.api_calls',
        periodStart: (await periodStartOf(0)).toISOString(),
        amount: 2,
      },
    });
    expect((await readCounters(o.orgId)).map((c) => [c.feature, c.used, c.version])).toEqual([
      ['fixture.api_calls', 2, 1],
    ]);
    expect(
      await otel.metric('entitlements_quota_consume_total', { feature: 'fixture.api_calls', result: 'consumed' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      otel.spans('entitlements.quota.consume').map((s) => s.attributes['entitlements.result']),
    ).toContain('consumed');
  });
  it('QU-4: the caller transaction rolls back → the quota comes back (no row, no event)', async () => {
    const o = await orgOn('metered');
    await expect(
      inTx(o.orgId, async () => {
        await quotas().consume('fixture.api_calls', 3);
        throw new Error('side effect failed');
      }),
    ).rejects.toThrow('side effect failed');
    expect(await readCounters(o.orgId)).toEqual([]);
    expect(await reached(o.orgId)).toEqual([]);
  });
  it('QU-5: UNLIMITED still counts; amount above a MAX limit is EXCEEDED and creates no row', async () => {
    const u = await orgOn('unmetered');
    await inTx(u.orgId, () => quotas().consume('fixture.saved_reports', 1_000));
    expect((await readCounters(u.orgId)).map((c) => c.used)).toEqual([1_000]);
    const m = await orgOn('metered');
    expect(await inTx(m.orgId, () => quotas().consume('fixture.saved_reports', 3))).toEqual({
      kind: 'EXCEEDED',
      limit: 2,
      used: 0,
    });
    expect(await readCounters(m.orgId)).toEqual([]);
    expect(
      await otel.metric('entitlements_quota_consume_total', { feature: 'fixture.saved_reports', result: 'exceeded' }),
    ).toBeGreaterThanOrEqual(1);
  });
  it('consumeOrThrow at the limit → 422 quota_exceeded with errors[0] = { path: feature, code: <key> }; nothing changes', async () => {
    const o = await orgOn('metered');
    await inTx(o.orgId, () => quotas().consumeOrThrow('fixture.saved_reports', 2));
    const err: unknown = await inTx(o.orgId, () => quotas().consumeOrThrow('fixture.saved_reports', 1)).catch(
      (e: unknown) => e,
    );
    expect(err instanceof AppError ? [err.error.code, err.opts.fields?.[0]?.path, err.opts.fields?.[0]?.code] : []).toEqual([
      'quota_exceeded',
      'feature',
      'fixture.saved_reports',
    ]);
    expect((await readCounters(o.orgId)).map((c) => c.used)).toEqual([2]);
  });
  it('QU-6 (sequential): quota.reached once, by the consume that reaches the limit; never for a refused consume', async () => {
    const o = await orgOn('metered');
    const user: Principal = { type: 'user', id: v7() };
    for (let i = 0; i < 3; i++) await inTx(o.orgId, () => quotas().consume('fixture.api_calls', 1), user);
    expect((await inTx(o.orgId, () => quotas().consume('fixture.api_calls', 1), user)).kind).toBe('EXCEEDED');
    const events = await reached(o.orgId);
    expect(events).toHaveLength(1);
    expect([events[0]?.data, events[0]?.aggregate.type, events[0]?.aggregate.version, events[0]?.actor]).toEqual([
      {
        orgId: o.orgId,
        feature: 'fixture.api_calls',
        periodStart: (await periodStartOf(0)).toISOString(),
        limit: 3,
        used: 3,
      },
      'usage_counter',
      3,
      user,
    ]);
  });
  it('Review Focus 5: reaching the limit under an org API key principal publishes with a service actor', async () => {
    const o = await orgOn('metered');
    const key: Principal = { type: 'api_key', id: v7() };
    const r = await inTx(o.orgId, () => quotas().consume('fixture.saved_reports', 2), key);
    expect(r.kind).toBe('CONSUMED');
    expect((await reached(o.orgId)).map((e) => e.actor)).toEqual([{ type: 'service', id: `api_key:${key.id}` }]);
  });
  it('QU-3 (app path): a full previous-month counter does not block this month; the new row is the current period', async () => {
    const o = await orgOn('metered');
    await seedCounter(o.orgId, 'fixture.api_calls', { used: 3, period: { monthsAgo: 1 } });
    expect((await inTx(o.orgId, () => quotas().consume('fixture.api_calls', 1))).kind).toBe('CONSUMED');
    expect((await readCounters(o.orgId)).map((c) => [c.periodStart?.toISOString(), c.used])).toEqual([
      [(await periodStartOf(1)).toISOString(), 3],
      [(await periodStartOf(0)).toISOString(), 1],
    ]);
  });
  it('QU-9: outside a UnitOfWork, or without an organization context → EntitlementsContextError', async () => {
    const o = await orgOn('metered');
    await expect(
      app.get(OrgScope).run(o.orgId, () => quotas().consume('fixture.api_calls', 1)),
    ).rejects.toBeInstanceOf(EntitlementsContextError);
    await expect(
      app.get(UnitOfWork).run(() => quotas().consume('fixture.api_calls', 1)),
    ).rejects.toBeInstanceOf(EntitlementsContextError);
  });
  it('a LIMIT or a FLAG key → FeatureKindMismatchError (500); an org without its row → EntitlementsRowMissingError (503)', async () => {
    const o = await orgOn('metered');
    for (const k of ['fixture.projects', 'fixture.reports'])
      await expect(inTx(o.orgId, () => quotas().consume(k, 1)), k).rejects.toBeInstanceOf(FeatureKindMismatchError);
    const bare = await orgOn(undefined);
    const error = vi.spyOn(Logger.prototype, 'error');
    await expect(inTx(bare.orgId, () => quotas().consume('fixture.api_calls', 1))).rejects.toBeInstanceOf(
      EntitlementsRowMissingError,
    );
    expect(error.mock.calls.some(([m]) => JSON.stringify(m).includes('entitlements_row_missing'))).toBe(true);
    error.mockRestore();
  });
  it('Review Focus 1: a non-integer or out-of-range amount is refused before any SQL; no row', async () => {
    const o = await orgOn('metered');
    for (const amount of [0, -1, 1.5, Number.NaN, 2 ** 53])
      await expect(inTx(o.orgId, () => quotas().consume('fixture.api_calls', amount)), String(amount)).rejects.toBeInstanceOf(
        RangeError,
      );
    expect(await readCounters(o.orgId)).toEqual([]);
  });
});
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/quotas.spec.ts
pnpm vitest run --project integration test/integration/entitlements/quotas.spec.ts
```
Expected: FAIL — `quotas.service.js` không tồn tại; `QuotaReachedEvent`, `Quotas` không có trong `index.ts`.

- [ ] **Step 4: Event và metric**

`src/modules/entitlements/events.ts` — thêm cuối file:
```ts
/** Aggregate của `entitlements.quota.reached` (spec §13.1): id = `usage_counters.id`, version = `usage_counters.version`. */
export const USAGE_COUNTER_AGGREGATE = 'usage_counter';

/**
 * Spec §13.1, S4-D16: phát CÙNG transaction khi một lần tiêu thụ thành công đưa `used` chạm trần (không phát cho lần bị
 * từ chối: lần đó rollback cùng caller và phát mỗi lần là spam). `audit: true`, `webhook: false` (R-X3, S4-D20).
 */
export const QuotaReachedEvent = defineEvent({
  type: 'entitlements.quota.reached',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({
    orgId: z.uuid(),
    feature: z.string(),
    periodStart: z.iso.datetime().nullable(),
    limit: z.int().min(0),
    used: z.int().min(0),
  }),
});
```

`src/modules/entitlements/application/entitlements-metrics.ts` — thêm kiểu và hai instrument; sửa chú thích "Metric quota/ghế thuộc 4B" thành "Ghế: `tenancy_seat_limit_denied_total` ở tenancy (bên quyết định từ chối, Task 11).":
```ts
export type QuotaConsumeResult = 'consumed' | 'exceeded';
```
```ts
  readonly quotaConsume = this.meter.createCounter(
    'entitlements_quota_consume_total',
    { description: 'Quotas.consume outcomes by feature and result' },
  );
  readonly quotaConsumeDuration = this.meter.createHistogram(
    'entitlements_quota_consume_duration_seconds',
    {
      description:
        'Duration of one Quotas.consume, the hot-counter signal of spec §19 (alert above 100 ms p95)',
      unit: 's',
    },
  );
```

- [ ] **Step 5: `Quotas` (consume)**

`src/modules/entitlements/application/quotas.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import type { Limit } from '../domain/effective-value.js';
import { isCount, type FeatureEntry } from '../domain/feature-catalogue.js';
import {
  periodOf,
  reachedLimit,
  type ConsumeResult,
  type QuotaPeriod,
  type QuotaReceipt,
} from '../domain/quota.js';
import { entitlementsConfig } from '../entitlements.config.js';
import { entitlementsSpan } from '../entitlements-telemetry.js';
import {
  EntitlementsContextError,
  FeatureKindMismatchError,
  quotaExceeded,
} from '../errors.js';
import { QuotaReachedEvent, USAGE_COUNTER_AGGREGATE } from '../events.js';
import { UsageCounterRepository } from '../ports/usage-counter.repository.js';
import { EntitlementCatalogueCheck } from './catalogue-check.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { Entitlements } from './entitlements.service.js';
import {
  EntitlementsMetrics,
  type QuotaConsumeResult,
} from './entitlements-metrics.js';

type QuotaEntry = Extract<FeatureEntry, { kind: 'QUOTA' }>;
const MS_PER_SEC = 1000;
/** Trigger của migration 4B: chỉ bắn khi code/catalogue lệch DB (Quotas đã kiểm loại và deprecated trước SQL). */
const COUNTER_TRIGGER = 'usage_counters_period_ck';
/** Actor khi không có principal (job có `meta.orgId`, subscriber): spec §13.1. */
const QUOTAS_SYSTEM_ACTOR: EventActor = {
  type: 'system',
  id: 'entitlements.quotas',
};

const resultOf = (r: ConsumeResult): QuotaConsumeResult => {
  switch (r.kind) {
    case 'CONSUMED':
      return 'consumed';
    case 'EXCEEDED':
      return 'exceeded';
    default: {
      const unknown: never = r;
      throw new Error(`unknown consume result ${JSON.stringify(unknown)}`);
    }
  }
};
const maxOf = (limit: Limit): number | null => {
  switch (limit.kind) {
    case 'UNLIMITED':
      return null;
    case 'MAX':
      return limit.max;
    default: {
      const unknown: never = limit;
      throw new Error(`unknown limit ${JSON.stringify(unknown)}`);
    }
  }
};
/** Số nguyên an toàn ≥ 1 (spec §9.2 tiền điều kiện): sai là lỗi lập trình của caller, trước mọi câu SQL. */
function requireAmount(op: string, key: string, amount: number): void {
  if (!isCount(amount, 1))
    throw new RangeError(
      `Quotas.${op}("${key}") needs an integer amount in [1, ${Number.MAX_SAFE_INTEGER}], got ${String(amount)}`,
    );
}

/**
 * Quota atomic (spec §9, S4-D6): mọi hàm chạy TRONG `UnitOfWork` + org context của caller, cùng transaction với side
 * effect: rollback của caller trả lại quota, và idempotency của caller (`@Idempotent()`, Inbox) phủ luôn quota. Không bao giờ
 * vượt trần: một câu `INSERT … ON CONFLICT … DO UPDATE … WHERE used + n <= max` khoá dòng và kiểm trên bản mới nhất (E-1,
 * E-2). Trần đọc trong transaction (snapshot, không cache, S4-D8): đổi gói commit sau được xếp "sau" lần này (E-4).
 * Thứ tự khoá (spec §3.6): mọi khoá của caller trước; consume không khoá `org_entitlements`, khoá dòng bộ đếm sau cùng;
 * nhiều key trong một transaction: tiêu thụ theo thứ tự key tăng dần (I2). Nhánh `EXCEEDED` vẫn giữ khoá dòng bộ đếm tới khi
 * caller kết thúc (`ON CONFLICT DO UPDATE` khoá dòng kể cả khi `WHERE` sai, M7): caller nhận `EXCEEDED` nên kết thúc sớm.
 */
@Injectable()
export class Quotas {
  private readonly logger = new Logger(Quotas.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly entitlements: Entitlements,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly catalogue: EntitlementCatalogueCheck,
    private readonly counters: UsageCounterRepository,
    private readonly events: EventPublisher,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  async consume(key: string, amount: number): Promise<ConsumeResult> {
    const orgId = this.requireTx('consume');
    const feature = this.quota(key);
    if (feature.deprecated)
      throw new FeatureKindMismatchError(key, 'an active QUOTA', 'a deprecated QUOTA');
    requireAmount('consume', key, amount);
    const started = performance.now();
    try {
      const result = await entitlementsSpan(
        'entitlements.quota.consume',
        () => this.consumeIn(orgId, feature, amount),
        (r) => ({ 'entitlements.result': resultOf(r) }),
      );
      this.metrics.quotaConsume.add(1, { feature: key, result: resultOf(result) });
      return result;
    } finally {
      this.metrics.quotaConsumeDuration.record(
        (performance.now() - started) / MS_PER_SEC,
      );
    }
  }

  /** `EXCEEDED` → `422 quota_exceeded` với key ở `errors[0]` (S4-D14). */
  async consumeOrThrow(key: string, amount: number): Promise<QuotaReceipt> {
    const r = await this.consume(key, amount);
    switch (r.kind) {
      case 'CONSUMED':
        return r.receipt;
      case 'EXCEEDED':
        throw quotaExceeded(key);
      default: {
        const unknown: never = r;
        throw new Error(`unknown consume result ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async consumeIn(
    orgId: string,
    feature: QuotaEntry,
    amount: number,
  ): Promise<ConsumeResult> {
    const max = maxOf(await this.entitlements.limitOf(feature.key));
    const period = periodOf(feature.resetPeriod, this.cfg.quotaTimezone);
    const featureId = this.catalogue.featureId(feature.key);
    // Spec §9.2 bước 2: nhánh INSERT không có WHERE, nên `amount > max` phải dừng TRƯỚC câu consume.
    if (max !== null && amount > max)
      return this.exceeded(featureId, period, max);
    const row = await this.guarded(feature.key, () =>
      this.counters.consume({ featureId, period, amount, max }),
    );
    if (!row) {
      if (max === null)
        throw new Error(
          `an UNLIMITED consume of "${feature.key}" returned no row (the statement has no guard)`,
        );
      return this.exceeded(featureId, period, max);
    }
    const receipt: QuotaReceipt = {
      featureKey: feature.key,
      periodStart: row.periodStart?.toISOString() ?? null,
      amount,
    };
    if (max !== null && reachedLimit(max, row.used, amount))
      await this.events.publish(QuotaReachedEvent, {
        data: {
          orgId,
          feature: feature.key,
          periodStart: receipt.periodStart,
          limit: max,
          used: row.used,
        },
        aggregate: { type: USAGE_COUNTER_AGGREGATE, id: row.id, version: row.version },
        actor: this.actor(),
      });
    return { kind: 'CONSUMED', receipt };
  }

  private async exceeded(
    featureId: string,
    period: QuotaPeriod,
    max: number,
  ): Promise<ConsumeResult> {
    return {
      kind: 'EXCEEDED',
      limit: max,
      used: await this.counters.usedNow({ featureId, period }),
    };
  }

  /** Trigger của DB là lớp chặn cuối: bắn nghĩa là code sai, nên ngoài 422 của mapper còn một dòng ERROR (spec §15). */
  private async guarded<T>(key: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgFields(err)?.constraint === COUNTER_TRIGGER)
        this.logger.error(
          { event: 'entitlements_counter_refused', feature: key },
          'the database refused a usage counter row: code and catalogue disagree with entitlement_features',
        );
      throw err;
    }
  }

  private requireTx(op: string): string {
    const orgId = this.ctx.orgId();
    if (!this.uow.inTransaction() || orgId === undefined)
      throw new EntitlementsContextError(
        `Quotas.${op} must run inside the caller UnitOfWork and an organization context (spec SP4 §9.2)`,
      );
    return orgId;
  }

  private quota(key: string): QuotaEntry {
    const f = this.registry.feature(key);
    if (f.kind !== 'QUOTA') throw new FeatureKindMismatchError(key, 'QUOTA', f.kind);
    return f;
  }

  /** Org API key và service principal không phải user: actor `service`, không ném như `userActor` của tenancy. */
  private actor(): EventActor {
    const p = this.ctx.principal();
    if (!p) return QUOTAS_SYSTEM_ACTOR;
    switch (p.type) {
      case 'user':
        return { type: 'user', id: p.id };
      case 'api_key':
        return { type: 'service', id: `api_key:${p.id}` };
      case 'service':
        return { type: 'service', id: p.id };
      default: {
        const unknown: never = p.type;
        throw new Error(`unknown principal type ${String(unknown)}`);
      }
    }
  }
}
```

`src/modules/entitlements/entitlements.module.ts` — import `Quotas`; thêm `Quotas` vào `providers` và `exports` của `EntitlementsCoreModule.register`.

`src/modules/entitlements/index.ts` — sửa dòng event và thêm hai export:
```ts
export { PlanChangedEvent, QuotaReachedEvent } from './events.js';
export { Quotas } from './application/quotas.service.js';
export type { ConsumeResult, QuotaReceipt } from './domain/quota.js';
```

- [ ] **Step 6: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements test/unit/core/events/event-flags.spec.ts
pnpm vitest run --project integration test/integration/entitlements
pnpm typecheck
```
Expected: PASS. `event-flags.spec.ts` ca "audited namespaces" phủ `entitlements.quota.reached@1` (audit, không webhook) mà không sửa bảng `EXPECTED` (EV-10).

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements/quotas.spec.ts test/integration/entitlements/quotas.spec.ts
git add src/modules/entitlements test/unit/modules/entitlements/quotas.spec.ts test/integration/entitlements/quotas.spec.ts
git commit -m "feat(entitlements): Quotas.consume and consumeOrThrow in the caller transaction; quota.reached once at the limit; consume metrics and span"
```

---

### Task 7: `Quotas.release`/`releaseAllocation` — trả đúng dòng kỳ, không kẹp về 0 (QU-7 phần tuần tự, Review Focus 2)

**Files:**
- Modify: `src/modules/entitlements/application/quotas.service.ts`
- Modify (test): `test/unit/modules/entitlements/quotas.spec.ts`, `test/integration/entitlements/quotas.spec.ts`

**Interfaces:**
- Consumes: `UsageCounterRepository.release({ featureId, periodStart, amount }) → Promise<number | undefined>` (Task 5); `QuotaReleaseUnderflowError(featureKey, amount)` (4A); các helper riêng của `Quotas` (`requireTx`, `quota`, `requireAmount`) của Task 6.
- Produces: `Quotas.release(receipt: QuotaReceipt): Promise<void>`; `Quotas.releaseAllocation(key: string, amount: number): Promise<void>` (chỉ `QUOTA` kỳ `NONE`); log ERROR `{ event: 'quota_release_underflow', feature }`.

- [ ] **Step 1: Unit test (đỏ)**

`test/unit/modules/entitlements/quotas.spec.ts` — trong provider giả của `UsageCounterRepository` thêm `release: () => Promise.resolve(state.releaseLeft)` và thêm `releaseLeft: number | undefined` vào `State` (mặc định `0` trong `beforeEach` và trong khởi tạo `state`); thêm import `QuotaReleaseUnderflowError` từ `errors.js`; thêm các ca:
```ts
  it('release: a NONE receipt with a period, a MONTH receipt without one or with a bad date → RangeError', async () => {
    await expect(
      quotas.release({ featureKey: 'q.saved', periodStart: '2026-09-30T17:00:00.000Z', amount: 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(quotas.release({ featureKey: 'q.calls', periodStart: null, amount: 1 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      quotas.release({ featureKey: 'q.calls', periodStart: 'not a date', amount: 1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
  it('releaseAllocation: only a QUOTA with resetPeriod NONE (QU-7); a deprecated QUOTA can still be released', async () => {
    await expect(quotas.releaseAllocation('q.calls', 1)).rejects.toBeInstanceOf(FeatureKindMismatchError);
    await expect(quotas.releaseAllocation('q.flag', 1)).rejects.toBeInstanceOf(FeatureKindMismatchError);
    await expect(quotas.releaseAllocation('q.old', 1)).resolves.toBeUndefined();
  });
  it('release more than used (repository answers no row) → QuotaReleaseUnderflowError, never clamped to zero', async () => {
    state.releaseLeft = undefined;
    await expect(quotas.releaseAllocation('q.saved', 5)).rejects.toBeInstanceOf(QuotaReleaseUnderflowError);
  });
  it('release outside a UnitOfWork → EntitlementsContextError', async () => {
    state.inTx = false;
    await expect(quotas.releaseAllocation('q.saved', 1)).rejects.toBeInstanceOf(EntitlementsContextError);
  });
```

- [ ] **Step 2: Integration test (đỏ)**

`test/integration/entitlements/quotas.spec.ts` — thêm import `QuotaReleaseUnderflowError` từ `index.ts` và một `describe` mới cuối file (dùng chung `app`, `inTx`, `orgOn` bằng cách đặt nó **bên trong** `describe` ngoài, sau ca cuối):
```ts
  describe('release and releaseAllocation (spec SP4 §9.3)', () => {
    it('release(receipt) gives the exact amount back to the row of the receipt; version + 1', async () => {
      const o = await orgOn('metered');
      const receipt = await inTx(o.orgId, () => quotas().consumeOrThrow('fixture.api_calls', 3));
      await inTx(o.orgId, () => quotas().release(receipt));
      expect((await readCounters(o.orgId)).map((c) => [c.used, c.version])).toEqual([[0, 2]]);
      expect((await inTx(o.orgId, () => quotas().consume('fixture.api_calls', 3))).kind).toBe('CONSUMED');
    });
    it('releaseAllocation on a NONE quota (a deleted record) frees one unit; on a MONTH quota → FeatureKindMismatchError', async () => {
      const o = await orgOn('metered');
      await inTx(o.orgId, () => quotas().consumeOrThrow('fixture.saved_reports', 2));
      await inTx(o.orgId, () => quotas().releaseAllocation('fixture.saved_reports', 1));
      expect((await readCounters(o.orgId)).map((c) => c.used)).toEqual([1]);
      await expect(
        inTx(o.orgId, () => quotas().releaseAllocation('fixture.api_calls', 1)),
      ).rejects.toBeInstanceOf(FeatureKindMismatchError);
    });
    it('QU-7: releasing more than used, or with no row at all → QuotaReleaseUnderflowError + ERROR quota_release_underflow; used unchanged', async () => {
      const o = await orgOn('metered');
      await inTx(o.orgId, () => quotas().consumeOrThrow('fixture.saved_reports', 1));
      const error = vi.spyOn(Logger.prototype, 'error');
      await expect(
        inTx(o.orgId, () => quotas().releaseAllocation('fixture.saved_reports', 2)),
      ).rejects.toBeInstanceOf(QuotaReleaseUnderflowError);
      expect(error.mock.calls.some(([m]) => JSON.stringify(m).includes('quota_release_underflow'))).toBe(true);
      error.mockRestore();
      expect((await readCounters(o.orgId)).map((c) => c.used)).toEqual([1]);
      const empty = await orgOn('metered');
      await expect(
        inTx(empty.orgId, () => quotas().releaseAllocation('fixture.saved_reports', 1)),
      ).rejects.toBeInstanceOf(QuotaReleaseUnderflowError);
    });
    it('Review Focus 2: a receipt of an earlier month releases that month only; the current month is untouched', async () => {
      const o = await orgOn('metered');
      await seedCounter(o.orgId, 'fixture.api_calls', { used: 2, period: { monthsAgo: 1 } });
      await inTx(o.orgId, () => quotas().consumeOrThrow('fixture.api_calls', 1));
      const previous = (await periodStartOf(1)).toISOString();
      await inTx(o.orgId, () =>
        quotas().release({ featureKey: 'fixture.api_calls', periodStart: previous, amount: 2 }),
      );
      expect((await readCounters(o.orgId)).map((c) => [c.periodStart?.toISOString(), c.used])).toEqual([
        [previous, 0],
        [(await periodStartOf(0)).toISOString(), 1],
      ]);
      await expect(
        inTx(o.orgId, () => quotas().release({ featureKey: 'fixture.api_calls', periodStart: null, amount: 1 })),
      ).rejects.toBeInstanceOf(RangeError);
    });
    it('M3: reaching the limit again after a release publishes quota.reached again (one event per transition into the limit)', async () => {
      const o = await orgOn('metered');
      const receipt = await inTx(o.orgId, () => quotas().consumeOrThrow('fixture.saved_reports', 2));
      await inTx(o.orgId, () => quotas().release({ ...receipt, amount: 1 }));
      await inTx(o.orgId, () => quotas().consume('fixture.saved_reports', 1));
      expect((await reached(o.orgId)).map((e) => e.data.used)).toEqual([2, 2]);
    });
  });
```

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/quotas.spec.ts
pnpm vitest run --project integration test/integration/entitlements/quotas.spec.ts
```
Expected: FAIL — `quotas.release is not a function`.

- [ ] **Step 4: Viết `release`/`releaseAllocation`**

`src/modules/entitlements/application/quotas.service.ts` — thêm `QuotaReleaseUnderflowError` vào import từ `'../errors.js'`; thêm hàm thuần trên lớp:
```ts
/** Kỳ của receipt phải khớp `resetPeriod` của tính năng (receipt dựng tay hoặc lưu sai kiểu là lỗi lập trình). */
function receiptPeriod(f: QuotaEntry, r: QuotaReceipt): string | null {
  switch (f.resetPeriod) {
    case 'NONE':
      if (r.periodStart !== null)
        throw new RangeError(
          `the receipt of "${f.key}" carries a period, but the feature has resetPeriod NONE`,
        );
      return null;
    case 'MONTH':
      if (r.periodStart === null || Number.isNaN(Date.parse(r.periodStart)))
        throw new RangeError(
          `the receipt of "${f.key}" needs the ISO period start of its MONTH counter`,
        );
      return r.periodStart;
    default: {
      const unknown: never = f.resetPeriod;
      throw new Error(`unknown reset period ${String(unknown)}`);
    }
  }
}
```
và trong lớp `Quotas`, sau `consumeOrThrow`:
```ts
  /** Trả đúng lần tiêu thụ về đúng dòng kỳ của receipt (spec §9.3): trả ở tháng sau không chạm kỳ hiện tại. */
  async release(receipt: QuotaReceipt): Promise<void> {
    this.requireTx('release');
    const feature = this.quota(receipt.featureKey);
    requireAmount('release', feature.key, receipt.amount);
    await this.releaseIn(feature.key, receiptPeriod(feature, receipt), receipt.amount);
  }

  /** Chỉ QUOTA kỳ NONE (xoá bản ghi đã tính quota, không còn receipt). Tính năng deprecated vẫn trả được. */
  async releaseAllocation(key: string, amount: number): Promise<void> {
    this.requireTx('releaseAllocation');
    const feature = this.quota(key);
    if (feature.resetPeriod !== 'NONE')
      throw new FeatureKindMismatchError(
        key,
        'a QUOTA with resetPeriod NONE',
        `a QUOTA with resetPeriod ${feature.resetPeriod}`,
      );
    requireAmount('releaseAllocation', key, amount);
    await this.releaseIn(key, null, amount);
  }

  /** 0 dòng = trả nhiều hơn đã dùng (hoặc chưa từng dùng): lỗi lập trình, `CHECK (used >= 0)` là lớp chặn cuối (F-9). */
  private async releaseIn(
    key: string,
    periodStart: string | null,
    amount: number,
  ): Promise<void> {
    const left = await this.counters.release({
      featureId: this.catalogue.featureId(key),
      periodStart,
      amount,
    });
    if (left !== undefined) return;
    this.logger.error(
      { event: 'quota_release_underflow', feature: key },
      'a quota release would make the usage negative',
    );
    throw new QuotaReleaseUnderflowError(key, amount);
  }
```

- [ ] **Step 5: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm vitest run --project integration test/integration/entitlements/quotas.spec.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements/application/quotas.service.ts test/unit/modules/entitlements/quotas.spec.ts test/integration/entitlements/quotas.spec.ts
git add src/modules/entitlements/application/quotas.service.ts test/unit/modules/entitlements/quotas.spec.ts test/integration/entitlements/quotas.spec.ts
git commit -m "feat(entitlements): Quotas.release and releaseAllocation return the exact row of a receipt and fail loud on underflow"
```

---
### Task 8: Race của bộ đếm trên Postgres thật, ×50 và tất định (QU-1/E-1, QU-2/E-2, QU-6/E-10, QU-7/E-14, QU-8/E-4, E-15 ép xen kẽ, E-11 hai chiều, I2)

**Files:**
- Modify: `test/support/entitlements-races.ts`
- Create (test): `test/integration/entitlements/quotas-races.spec.ts`

**Interfaces:**
- Consumes: `holdEntitlementRow`, `waitForBlocked`, `EntitlementRowHolder` (4A, `test/support/entitlements-races.ts`); `Quotas` (Task 6–7); `PlanAssignments` (4A); `PurgeOrgHandler` (`src/modules/tenancy/application/purge-orgs.handler.ts`, `handle(ctx: JobContext<unknown>) → 'purged' | …`); `pgFields`; `seedCounter`, `readCounters`, `periodStartOf`, `setOrgPlan`, `seedOrgEntitlement`, `QUOTA_TZ` (Task 3, 5A); `ownerQuery`.
- Produces: `holdInOrg(orgId: string, sql: string, params: unknown[], rows: number): Promise<EntitlementRowHolder>` (export: một transaction `app_user` mở trong OrgScope, giữ khoá của câu vừa chạy; phía purge của E-11); `holdUsageCounter(orgId: string, featureKey: string, timezone: string | null): Promise<EntitlementRowHolder>` (giữ `FOR NO KEY UPDATE` dòng kỳ hiện tại, `null` = kỳ NONE; dòng phải có sẵn); `holdUsageCounterInsert(orgId, featureKey, timezone: string | null): Promise<EntitlementRowHolder>` (chèn dòng kỳ hiện tại chưa commit; `release()` = ROLLBACK, để hai consume đầu tiên đua trên dòng chưa có). `holdEntitlementRow` giữ nguyên chữ ký, viết lại trên helper chung `holdInOrg`.

- [ ] **Step 1: Seam mới cho bộ đếm**

`test/support/entitlements-races.ts` — thay hàm `holdEntitlementRow` bằng helper chung + ba hàm công khai (phần `appClient`, `waitForBlocked`, hằng giữ nguyên):
```ts
/**
 * Một kết nối `app_user` riêng mở transaction trong OrgScope của org, chạy `sql` (phải chạm đúng `rows` dòng) và GIỮ
 * transaction: các transaction đang thử xếp hàng sau nó; `release()` (ROLLBACK) thả cho chúng đua.
 */
export async function holdInOrg(
  orgId: string,
  sql: string,
  params: unknown[],
  rows: number,
): Promise<EntitlementRowHolder> {
  const c = appClient();
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const r = await c.query(sql, params);
    if (r.rowCount !== rows)
      throw new Error(`holder touched ${String(r.rowCount)} rows, expected ${rows}`);
    const { rows: pidRows } = await c.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const pid = pidRows[0]?.pid;
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
      commitWith: async (q: string, p: unknown[] = []) => {
        try {
          await c.query(q, p);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          await c.end();
        }
      },
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
    throw err;
  }
}

/** Barrier của test race gán gói (spec SP4 §17 E-5, E-15): giữ `FOR NO KEY UPDATE` trên dòng `org_entitlements`. */
export const holdEntitlementRow = (orgId: string): Promise<EntitlementRowHolder> =>
  holdInOrg(
    orgId,
    'SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE',
    [],
    1,
  );

/** Kỳ hiện tại theo `timezone` (cùng `date_trunc` của app) hoặc kỳ NONE (`null`). */
const PERIOD_OF = `CASE WHEN $2::text IS NULL THEN NULL ELSE date_trunc('month', now(), $2::text) END`;

/** Barrier E-1/E-14: giữ khoá dòng bộ đếm (đã seed) như một consume đang mở; consume/release khác xếp hàng sau nó. */
export const holdUsageCounter = (
  orgId: string,
  featureKey: string,
  timezone: string | null,
): Promise<EntitlementRowHolder> =>
  holdInOrg(
    orgId,
    `SELECT 1 FROM usage_counters u JOIN entitlement_features f ON f.id = u.feature_id
     WHERE u.org_id = app_current_org() AND f.key = $1 AND u.period_start IS NOT DISTINCT FROM ${PERIOD_OF}
     FOR NO KEY UPDATE OF u`,
    [featureKey, timezone],
    1,
  );

/** Barrier E-2: chèn (chưa commit) dòng kỳ hiện tại; consume khác chờ index unique; `release()` = ROLLBACK, dòng chưa từng có. */
export const holdUsageCounterInsert = (
  orgId: string,
  featureKey: string,
  timezone: string | null,
): Promise<EntitlementRowHolder> =>
  holdInOrg(
    orgId,
    `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
     SELECT app_current_org(), id, ${PERIOD_OF}, 0, 1 FROM entitlement_features WHERE key = $1`,
    [featureKey, timezone],
    1,
  );
```

- [ ] **Step 2: Viết test race**

`test/integration/entitlements/quotas-races.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, OrgScope, UnitOfWork, pgFields } from '../../../src/core/database/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import {
  EntitlementsRowMissingError,
  PlanAssignments,
  Quotas,
  type ConsumeResult,
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
  holdUsageCounter,
  holdUsageCounterInsert,
  waitForBlocked,
} from '../../support/entitlements-races.js';
import {
  QUOTA_TZ,
  periodStartOf,
  readCounters,
  seedCounter,
  seedOrgEntitlement,
  setOrgPlan,
} from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RUNS = 50;
const DEADLOCK = '40P01';
const RESTRICT = '23001';
const FK_VIOLATION = '23503';
/** Hạn chót cho "consume không bị khoá org_entitlements chặn" (E-15): dưới idle_in_transaction_session_timeout 10 s. */
const NOT_BLOCKED_MS = 3_000;
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
/** Một cửa: `wait` chờ tới khi `open()`; ép thứ tự xen kẽ bên trong `UnitOfWork.run` của code thật, không ngủ. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
const blocked = () =>
  new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), NOT_BLOCKED_MS));

describe('quota races with a row-lock barrier (spec SP4 §17)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  const consume = (orgId: string, key: string, n = 1) =>
    settle(
      app.get(OrgScope).run(orgId, () =>
        app.get(UnitOfWork).run(() => app.get(Quotas).consume(key, n)),
      ),
    );
  const orgOn = async (plan: string, opts: Parameters<typeof seedOrgEntitlement>[2] = {}) => {
    const o = await seedOrg();
    orgs.push(o);
    await seedOrgEntitlement(o.orgId, plan, opts);
    return o;
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
  const kinds = (rs: (ConsumeResult | Error)[]) =>
    rs.map((r) => (r instanceof Error ? `error:${r.name}` : r.kind)).sort();
  const reachedCount = async (orgId: string) =>
    (
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.quota.reached'`,
        [orgId],
      )
    ).length;
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  }, 120_000);
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it(`QU-1 (E-1): 6 parallel consume(1) with 3 left → exactly 3 CONSUMED, 3 EXCEEDED, used = 3, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await seedCounter(o.orgId, 'fixture.api_calls', { used: 0, period: { monthsAgo: 0 } });
      const holder = await holdUsageCounter(o.orgId, 'fixture.api_calls', QUOTA_TZ);
      const racing = Array.from({ length: 6 }, () => consume(o.orgId, 'fixture.api_calls'));
      await waitForBlocked(holder.pid, 6);
      await holder.release();
      expect(kinds(await Promise.all(racing)), `run ${i}`).toEqual([
        'CONSUMED', 'CONSUMED', 'CONSUMED', 'EXCEEDED', 'EXCEEDED', 'EXCEEDED',
      ]);
      expect((await readCounters(o.orgId)).map((c) => c.used), `run ${i}`).toEqual([3]);
    }
  }, 300_000);
  it(`QU-2 (E-2): the first two consumes of a new period race on a row that does not exist yet → one row, used = 2, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      const holder = await holdUsageCounterInsert(o.orgId, 'fixture.saved_reports', null);
      const racing = [consume(o.orgId, 'fixture.saved_reports'), consume(o.orgId, 'fixture.saved_reports')];
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      expect(kinds(await Promise.all(racing)), `run ${i}`).toEqual(['CONSUMED', 'CONSUMED']);
      expect(
        (await readCounters(o.orgId)).map((c) => [c.periodStart, c.used, c.version]),
        `run ${i}`,
      ).toEqual([[null, 2, 2]]);
    }
  }, 300_000);
  it(`QU-6 (E-10): 5 parallel consume(1) reaching a limit of 3 → exactly one quota.reached, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await seedCounter(o.orgId, 'fixture.api_calls', { used: 0, period: { monthsAgo: 0 } });
      const holder = await holdUsageCounter(o.orgId, 'fixture.api_calls', QUOTA_TZ);
      const racing = Array.from({ length: 5 }, () => consume(o.orgId, 'fixture.api_calls'));
      await waitForBlocked(holder.pid, 5);
      await holder.release();
      await Promise.all(racing);
      expect(await reachedCount(o.orgId), `run ${i}`).toBe(1);
    }
  }, 300_000);
  it(`QU-7 (E-14): release ∥ consume on a full counter → used stays in [0, limit] and matches the outcome, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await seedCounter(o.orgId, 'fixture.api_calls', { used: 3, period: { monthsAgo: 0 } });
      const receipt = {
        featureKey: 'fixture.api_calls',
        periodStart: (await periodStartOf(0)).toISOString(),
        amount: 1,
      };
      const holder = await holdUsageCounter(o.orgId, 'fixture.api_calls', QUOTA_TZ);
      const released = settle(
        app.get(OrgScope).run(o.orgId, () =>
          app.get(UnitOfWork).run(() => app.get(Quotas).release(receipt)),
        ),
      );
      const consumed = consume(o.orgId, 'fixture.api_calls');
      await waitForBlocked(holder.pid, 2);
      await holder.release();
      const [r, c] = await Promise.all([released, consumed]);
      expect(r, `run ${i}`).toBeUndefined();
      const used = (await readCounters(o.orgId))[0]?.used;
      if (c instanceof Error) throw c;
      expect(used, `run ${i}`).toBe(c.kind === 'CONSUMED' ? 3 : 2);
    }
  }, 300_000);
  it('QU-8 (E-4): a downgrade between two consumes → the next one is EXCEEDED with the real usage (OVER_LIMIT is valid)', async () => {
    const o = await orgOn('free');
    expect((await consume(o.orgId, 'fixture.api_calls', 5)) instanceof Error).toBe(false);
    await setOrgPlan(o.orgId, 'metered');
    expect(await consume(o.orgId, 'fixture.api_calls')).toEqual({ kind: 'EXCEEDED', limit: 3, used: 5 });
    expect((await readCounters(o.orgId)).map((c) => c.used)).toEqual([5]);
  });
  it('E-15 (forced, assign first): a consume completes while an open assign transaction holds org_entitlements FOR NO KEY UPDATE', async () => {
    const o = await orgOn('metered', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 1n });
    const locked = gate();
    const release = gate();
    const assigning = settle(
      app.get(OrgScope).run(o.orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const r = await app.get(PlanAssignments).assign({
            planKey: 'unmetered',
            cause: { kind: 'BILLING', ref: 'sub_1', sequence: 2n },
          });
          locked.open();
          await release.wait;
          return r;
        }),
      ),
    );
    await locked.wait;
    try {
      const c = await Promise.race([consume(o.orgId, 'fixture.api_calls'), blocked()]);
      expect(c === 'blocked' || c instanceof Error ? c : c.kind).toBe('CONSUMED');
    } finally {
      release.open();
    }
    const a = await assigning;
    expect(a instanceof Error ? a.message : a.kind).toBe('APPLIED');
  });
  it('E-15 (forced, consume first): an assign completes while an open consume transaction holds its counter and FOR KEY SHARE on org_entitlements', async () => {
    const o = await orgOn('metered', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 1n });
    const consumed = gate();
    const release = gate();
    const consuming = settle(
      app.get(OrgScope).run(o.orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const r = await app.get(Quotas).consume('fixture.api_calls', 1);
          consumed.open();
          await release.wait;
          return r;
        }),
      ),
    );
    await consumed.wait;
    try {
      const a = await Promise.race([
        settle(
          app.get(OrgScope).run(o.orgId, () =>
            app.get(UnitOfWork).run(() =>
              app.get(PlanAssignments).assign({
                planKey: 'unmetered',
                cause: { kind: 'BILLING', ref: 'sub_1', sequence: 2n },
              }),
            ),
          ),
        ),
        blocked(),
      ]);
      expect(a === 'blocked' || a instanceof Error ? a : a.kind).toBe('APPLIED');
    } finally {
      release.open();
    }
    const c = await consuming;
    expect(c instanceof Error ? c.message : c.kind).toBe('CONSUMED');
  });
  it(`E-15: billing assign ∥ consume on one org never deadlock, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered', { source: 'BILLING', sourceRef: 'sub_1', lastBillingSeq: 1n });
      const holder = await holdEntitlementRow(o.orgId);
      const assign = settle(
        app.get(OrgScope).run(o.orgId, () =>
          app.get(UnitOfWork).run(() =>
            app.get(PlanAssignments).assign({
              planKey: 'unmetered',
              cause: { kind: 'BILLING', ref: 'sub_1', sequence: 2n },
            }),
          ),
        ),
      );
      const consumed = consume(o.orgId, 'fixture.api_calls');
      await waitForBlocked(holder.pid, 1);
      await holder.release();
      const [a, c] = await Promise.all([assign, consumed]);
      for (const r of [a, c])
        expect(r instanceof Error ? pgFields(r)?.sqlState ?? r.name : 'ok', `run ${i}`).toBe('ok');
    }
  }, 300_000);
  it(`E-11: purge ∥ consume → no deadlock; the consume is named-failed or its row is removed by the purge (after one retry), ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      await withAppClient((c) =>
        inOrgTx(c, o.orgId, () =>
          c.query(
            `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
            [o.orgId],
          ),
        ),
      );
      const purge = () =>
        settle(app.get(OrgScope).run(o.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(o.orgId))));
      const [p, c] = await Promise.all([purge(), consume(o.orgId, 'fixture.api_calls')]);
      for (const r of [p, c])
        expect(r instanceof Error ? pgFields(r)?.sqlState : undefined, `run ${i}`).not.toBe(DEADLOCK);
      if (c instanceof Error)
        expect(
          c instanceof EntitlementsRowMissingError || pgFields(c)?.sqlState === FK_VIOLATION,
          `run ${i}: ${c.message}`,
        ).toBe(true);
      // Consume chèn bộ đếm TRƯỚC khi purge xoá dòng gốc: kiểm RESTRICT của purge thấy dòng mới → purge fail to, job retry.
      if (p instanceof Error) {
        expect(pgFields(p)?.sqlState, `run ${i}`).toBe(RESTRICT);
        expect(await purge(), `run ${i}`).toBe('purged');
      } else expect(p, `run ${i}`).toBe('purged');
      expect(await readCounters(o.orgId), `run ${i}`).toEqual([]);
    }
  }, 300_000);
  it('E-11 (deterministic, consume first): an open consume holds its new counter while the purge waits → purge 23001, the retry purges everything', async () => {
    const o = await orgOn('metered');
    await softDeleteDue(o.orgId);
    const inserted = gate();
    const release = gate();
    let pid = -1;
    const consuming = settle(
      app.get(OrgScope).run(o.orgId, () =>
        app.get(UnitOfWork).run(async () => {
          const r = await app.get(Quotas).consume('fixture.api_calls', 1);
          const [row] = await app.get(Db).execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          pid = row?.pid ?? -1;
          inserted.open();
          await release.wait;
          return r;
        }),
      ),
    );
    await inserted.wait;
    const purging = purgeOnce(o.orgId);
    await waitForBlocked(pid, 1);
    release.open();
    const c = await consuming;
    expect(c instanceof Error ? c.message : c.kind).toBe('CONSUMED');
    const p = await purging;
    expect(p instanceof Error ? pgFields(p)?.sqlState : p).toBe(RESTRICT);
    expect(await purgeOnce(o.orgId)).toBe('purged');
    expect(await readCounters(o.orgId)).toEqual([]);
  });
  it('E-11 (deterministic, purge first): the purge deleted the root row uncommitted → the waiting consume fails 23503 once it commits', async () => {
    const o = await orgOn('metered');
    const purger = await holdInOrg(
      o.orgId,
      'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
      [],
      1,
    );
    const consuming = consume(o.orgId, 'fixture.api_calls');
    await waitForBlocked(purger.pid, 1);
    await purger.commitWith('SELECT 1');
    const c = await consuming;
    expect(c instanceof Error ? [pgFields(c)?.sqlState, pgFields(c)?.constraint] : c).toEqual([
      FK_VIOLATION,
      'usage_counters_org_fk',
    ]);
    expect(await readCounters(o.orgId)).toEqual([]);
  });
  it(`I2: two transactions consuming two counters in ascending key order never deadlock, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = await orgOn('metered');
      const both = () =>
        settle(
          app.get(OrgScope).run(o.orgId, () =>
            app.get(UnitOfWork).run(async () => {
              // Thứ tự key tăng dần (spec §3.6, I2): `fixture.api_calls` < `fixture.saved_reports`.
              for (const key of ['fixture.api_calls', 'fixture.saved_reports'])
                await app.get(Quotas).consume(key, 1);
              return 'ok' as const;
            }),
          ),
        );
      const rs = await Promise.all([both(), both()]);
      expect(rs.map((r) => (r instanceof Error ? pgFields(r)?.sqlState ?? r.message : r)), `run ${i}`).toEqual([
        'ok',
        'ok',
      ]);
    }
  }, 300_000);
});
```

- [ ] **Step 3: Chạy**

Run: `pnpm vitest run --project integration test/integration/entitlements/quotas-races.spec.ts`
Expected: PASS (mọi vòng). Chạy file ba lần liền để chắc barrier ổn định (`waitForBlocked` có hạn chót và in `pg_stat_activity` khi quá hạn). Một vòng đỏ ở QU-1/QU-6 là bug thật của câu consume (không phải test chập chờn): đọc ảnh chụp, không nới kỳ vọng.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/support/entitlements-races.ts test/integration/entitlements/quotas-races.spec.ts
git add test/support/entitlements-races.ts test/integration/entitlements/quotas-races.spec.ts
git commit -m "test(entitlements): quota races x50 and forced interleavings — parallel consume, first row of a period, quota.reached once per transition, release vs consume, assign and purge both ways, two counters in key order"
```

---

## Phần D — HTTP: trạng thái quota cho tenant, quota trên route (spec §9.4, §12.1, §12.3, §20.3)

### Task 9: `GET /v1/orgs/{orgId}/entitlements` trả `used`/`state`/`periodStart`/`periodEnd` cho QUOTA trong một transaction đọc; HT-2a (cập nhật), HT-2c, Review Focus 3

**Files:**
- Create: `src/modules/entitlements/application/org-entitlements.query.ts`
- Modify: `src/modules/entitlements/domain/effective-value.ts`, `src/modules/entitlements/http/schemas.ts`, `src/modules/entitlements/http/org-entitlements.controller.ts`, `src/modules/entitlements/http/entitlements-http.module.ts`, `src/modules/entitlements/index.ts`, `openapi.json`
- Modify (test): `test/unit/modules/entitlements/schemas.spec.ts`, `test/e2e/entitlements/org-entitlements.e2e.spec.ts`

**Interfaces:**
- Consumes: `Entitlements.snapshot()`, `EntitlementCatalogueRegistry.features()`, `quotaState(limit, used)` (4A); `UsageCounterRepository.currentUsage(timezone): CurrentUsage` (Task 5); `UnitOfWork.run`; `entitlementsConfig.quotaTimezone`; test: `startEntitlementsApp`, `seedCustomRole`, `seedMemberInRole`, `setOrgPlan`, `Quotas`.
- Produces:
  - `QUOTA_STATES = ['WITHIN', 'REACHED', 'OVER_LIMIT'] as const`, `type QuotaState` suy từ nó (`effective-value.ts`); export `type QuotaState` ở `index.ts`.
  - `class OrgEntitlementsQuery { read(): Promise<{ snapshot: EntitlementSnapshot; usage: CurrentUsage }> }` (một `UnitOfWork`), provider của `EntitlementsHttpModule`.
  - `orgEntitlementsOf(s: EntitlementSnapshot, features: MergedFeatures, usage: CurrentUsage): OrgEntitlementsResponse`; item QUOTA thêm `used: number` (≥ 0), `state: QuotaState`, `periodStart: string | null`, `periodEnd: string | null` (cả hai `null` với kỳ NONE).

- [ ] **Step 1: Unit test schema (đỏ)**

`test/unit/modules/entitlements/schemas.spec.ts` — thêm import `type CurrentUsage` từ `'../../../../src/modules/entitlements/ports/usage-counter.repository.js'`; thêm một tính năng `x.month` (`QUOTA`, `MONTH`, `fallback: { max: 10 }`) vào `features` và snapshot (`{ kind: 'QUOTA', limit: { kind: 'MAX', max: 10 }, resetPeriod: 'MONTH', source: 'PLAN' }`), một hằng usage:
```ts
const usage: CurrentUsage = {
  periodStart: new Date('2026-09-30T17:00:00.000Z'),
  periodEnd: new Date('2026-10-31T17:00:00.000Z'),
  used: new Map([
    ['x.calls', 3],
    ['x.month', 12],
  ]),
};
```
mọi lời gọi `orgEntitlementsOf(snapshot, features)` thành `orgEntitlementsOf(snapshot, features, usage)`, và trong mảng mong đợi: mục `x.calls` thêm `used: 3, state: 'REACHED', periodStart: null, periodEnd: null`; thêm mục mới (sau `x.flag` theo thứ tự key):
```ts
        {
          key: 'x.month',
          kind: 'QUOTA',
          resetPeriod: 'MONTH',
          unlimited: false,
          limit: 10,
          used: 12,
          state: 'OVER_LIMIT',
          periodStart: '2026-09-30T17:00:00.000Z',
          periodEnd: '2026-10-31T17:00:00.000Z',
          source: 'PLAN',
          overrideExpiresAt: null,
        },
```
và một ca:
```ts
  it('a QUOTA without a counter row is used 0, WITHIN; an UNLIMITED quota is always WITHIN (spec §9.4)', () => {
    const body = orgEntitlementsOf(
      {
        ...snapshot,
        features: new Map([
          ['x.calls', { kind: 'QUOTA', limit: { kind: 'UNLIMITED' }, resetPeriod: 'NONE', source: 'PLAN' }],
        ]),
      },
      features,
      { ...usage, used: new Map() },
    );
    expect(body.features).toEqual([
      expect.objectContaining({ key: 'x.calls', unlimited: true, limit: null, used: 0, state: 'WITHIN' }),
    ]);
  });
```

- [ ] **Step 2: E2E (đỏ)**

`test/e2e/entitlements/org-entitlements.e2e.spec.ts`:
- thêm import: `OrgScope, UnitOfWork` từ `'../../../src/core/database/index.js'`, `Quotas` từ `'../../../src/modules/entitlements/index.js'`, `periodStartOf, setOrgPlan` từ `entitlements-seed.js`, `seedCustomRole, seedMemberInRole` từ `tenancy-seed.js`;
- trong ca `'OWNER, ADMIN and MEMBER read the documented shape…'`, đọc mốc kỳ trước vòng lặp (`const start = (await periodStartOf(0)).toISOString(); const end = (await periodStartOf(-1)).toISOString();`), và hai mục QUOTA của mảng mong đợi thành:
```ts
        {
          key: 'fixture.api_calls',
          kind: 'QUOTA',
          resetPeriod: 'MONTH',
          unlimited: false,
          limit: 100,
          used: 0,
          state: 'WITHIN',
          periodStart: start,
          periodEnd: end,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
```
```ts
        {
          key: 'fixture.saved_reports',
          kind: 'QUOTA',
          resetPeriod: 'NONE',
          unlimited: false,
          limit: 3,
          used: 0,
          state: 'WITHIN',
          periodStart: null,
          periodEnd: null,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
```
- thêm helper và ba ca cuối `describe`:
```ts
  const consume = (o: SeededOrg, key: string, n: number) =>
    app.get(OrgScope).run(o.orgId, () =>
      app.get(UnitOfWork).run(() => app.get(Quotas).consumeOrThrow(key, n)),
    );
  const quotaItem = async (o: SeededOrg, key: string) =>
    ((await get(owner, o)).body.features as { key: string }[]).find((f) => f.key === key);

  it('usage is visible: after consuming 2 of 3 the item says used 2, WITHIN; at 3 REACHED', async () => {
    const o = await orgOf('metered');
    await consume(o, 'fixture.api_calls', 2);
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({ limit: 3, used: 2, state: 'WITHIN' });
    await consume(o, 'fixture.api_calls', 1);
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({ used: 3, state: 'REACHED' });
  });
  it('Review Focus 3: OVER_LIMIT after a downgrade, release brings the org back under the limit', async () => {
    const o = await orgOf('free');
    const receipt = await consume(o, 'fixture.api_calls', 5);
    await setOrgPlan(o.orgId, 'metered');
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({ limit: 3, used: 5, state: 'OVER_LIMIT' });
    await expect(consume(o, 'fixture.api_calls', 1)).rejects.toMatchObject({ error: { code: 'quota_exceeded' } });
    await app.get(OrgScope).run(o.orgId, () =>
      app.get(UnitOfWork).run(() => app.get(Quotas).release(receipt)),
    );
    expect(await quotaItem(o, 'fixture.api_calls')).toMatchObject({ used: 0, state: 'WITHIN' });
    await expect(consume(o, 'fixture.api_calls', 1)).resolves.toMatchObject({ amount: 1 });
  });
  it('HT-2c: a member whose custom role lacks entitlements.read gets 403 forbidden; with it, 200', async () => {
    const without = await seedCustomRole(pro, { permissions: ['org.read'] });
    const withRead = await seedCustomRole(pro, { permissions: ['org.read', 'entitlements.read'] });
    const p1 = await seedP();
    const p2 = await seedP();
    await seedMemberInRole(pro, without, { authUserId: p1.authUserId });
    await seedMemberInRole(pro, withRead, { authUserId: p2.authUserId });
    const r1 = await get(p1, pro);
    expect([r1.status, r1.body.code]).toEqual([403, 'forbidden']);
    expect((await get(p2, pro)).status).toBe(200);
  });
```
(`SeededOrg` đã được import ở đầu file của 4A; nếu chưa có, thêm `type SeededOrg` vào import từ `tenancy-seed.js`.)

- [ ] **Step 3: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements/schemas.spec.ts
pnpm vitest run --project integration test/e2e/entitlements/org-entitlements.e2e.spec.ts
```
Expected: FAIL — `orgEntitlementsOf` chưa nhận `usage`; item QUOTA thiếu `used`/`state`/kỳ. HT-2c xanh ngay từ 4A (route đã có quyền) là chấp nhận được: nó là ca của spec chưa ai viết, giữ làm hồi quy.

- [ ] **Step 4: Viết code**

`src/modules/entitlements/domain/effective-value.ts` — thay dòng `export type QuotaState = 'WITHIN' | 'REACHED' | 'OVER_LIMIT';` bằng:
```ts
export const QUOTA_STATES = ['WITHIN', 'REACHED', 'OVER_LIMIT'] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];
```

`src/modules/entitlements/application/org-entitlements.query.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { entitlementsConfig } from '../entitlements.config.js';
import {
  UsageCounterRepository,
  type CurrentUsage,
} from '../ports/usage-counter.repository.js';
import {
  Entitlements,
  type EntitlementSnapshot,
} from './entitlements.service.js';

/**
 * Đọc của API tenant (spec §12.1): snapshot + usage trong MỘT transaction đọc ngắn, nên hai câu thấy cùng `now()` (kỳ của
 * usage khớp `periodStart` trả về). READ COMMITTED: mỗi câu một snapshot, nên một lần đổi gói commit giữa hai câu vẫn được
 * câu sau thấy (chấp nhận: response chỉ để hiển thị, M4). Không ghi gì (S4-D18).
 */
@Injectable()
export class OrgEntitlementsQuery {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly entitlements: Entitlements,
    private readonly usage: UsageCounterRepository,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  read(): Promise<{ snapshot: EntitlementSnapshot; usage: CurrentUsage }> {
    return this.uow.run(async () => ({
      snapshot: await this.entitlements.snapshot(),
      usage: await this.usage.currentUsage(this.cfg.quotaTimezone),
    }));
  }
}
```

`src/modules/entitlements/http/schemas.ts`:
- import thêm `QUOTA_STATES`, `quotaState` từ `'../domain/effective-value.js'` và `type CurrentUsage` từ `'../ports/usage-counter.repository.js'`;
- `QuotaItem` thành:
```ts
const QuotaItem = z.object({
  key: z.string(),
  kind: z.literal('QUOTA'),
  resetPeriod: z.enum(RESET_PERIODS),
  ...numeric,
  used: z.int().min(0),
  state: z.enum(QUOTA_STATES),
  periodStart: iso.nullable(),
  periodEnd: iso.nullable(),
  source,
  overrideExpiresAt: iso.nullable(),
});
```
- chú thích của `OrgEntitlementsResponse`: "4B thêm …" thành "QUOTA mang `used`/`state` (suy ra, spec §9.4) và kỳ hiện tại (`null` với kỳ NONE); LIMIT không có `used` (module chủ đếm); 4C điền `overrideExpiresAt`.";
- `itemOf` nhận thêm `usage: CurrentUsage`; nhánh `'QUOTA'` thành:
```ts
    case 'QUOTA': {
      const used = usage.used.get(key) ?? 0;
      const period =
        v.resetPeriod === 'MONTH'
          ? { periodStart: usage.periodStart.toISOString(), periodEnd: usage.periodEnd.toISOString() }
          : { periodStart: null, periodEnd: null };
      return {
        key,
        kind: 'QUOTA',
        resetPeriod: v.resetPeriod,
        ...numericOf(v.limit),
        used,
        state: quotaState(v.limit, used),
        ...period,
        source: v.source,
        overrideExpiresAt: null,
      };
    }
```
- `orgEntitlementsOf(s, features, usage: CurrentUsage)` truyền `usage` vào `itemOf(key, v, usage)`.

`src/modules/entitlements/http/org-entitlements.controller.ts` — constructor nhận `OrgEntitlementsQuery` thay `Entitlements`; handler:
```ts
  async get() {
    const { snapshot, usage } = await this.query.read();
    return serialize(
      OrgEntitlementsResponse,
      orgEntitlementsOf(snapshot, this.registry.features(), usage),
    );
  }
```
(chú thích lớp: bỏ "4B" trong câu ETag, giữ lý do "usage đổi mà `version` không đổi").

`src/modules/entitlements/http/entitlements-http.module.ts` — `providers: [EntitlementRouteInventory, OrgEntitlementsQuery]`.

`src/modules/entitlements/index.ts` — `export type { EffectiveValue, Limit, QuotaState } from './domain/effective-value.js';`

- [ ] **Step 5: Sinh lại OpenAPI**

Run:
```bash
pnpm build && pnpm openapi:export
git diff --stat openapi.json
```
Expected: chỉ schema item QUOTA của `GET /v1/orgs/{orgId}/entitlements` thêm bốn thuộc tính (thay đổi cộng thêm trên response; `oasdiff` không báo breaking).

- [ ] **Step 6: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/entitlements
pnpm vitest run --project integration test/e2e/entitlements test/integration/entitlements
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/unit/modules/entitlements/schemas.spec.ts test/e2e/entitlements/org-entitlements.e2e.spec.ts
git add src/modules/entitlements test/unit/modules/entitlements/schemas.spec.ts test/e2e/entitlements/org-entitlements.e2e.spec.ts openapi.json
git commit -m "feat(entitlements): tenant entitlements show used, state and the current period of every quota in one read transaction"
```

---

### Task 10: Quota trên một route `@Idempotent()` — gửi lại không trừ hai lần, handler lỗi trả lại quota (HT-5, QU-4 qua HTTP)

**Files:**
- Create (test): `test/e2e/entitlements/fixtures/quota-route.module.ts`, `test/e2e/entitlements/quota-route.e2e.spec.ts`

**Interfaces:**
- Consumes: `Quotas.consumeOrThrow` (Task 6), `UnitOfWork.run`, `Db.execute`, `Idempotent` (`src/core/http/index.ts`), `TenancyPermissions.require` (`src/modules/tenancy/permissions.ts`), bảng fixture `fixture_org_items (org_id, body)` (`test/fixtures/migrations/Migration20260928222157_fixture_org_items.ts`, FK `RESTRICT` tới `organizations`); `startEntitlementsApp`, `authed`, `seedUserPrincipal`, `seedOrg`, `seedOrgEntitlement`, `readCounters`.
- Produces: không có API mới. Route fixture `POST /v1/orgs/:orgId/fx-quota/reports[?fail=1]` (chỉ trong test) chứng minh hợp đồng README: consume cùng `UnitOfWork` với side effect.

- [ ] **Step 1: Route fixture**

`test/e2e/entitlements/fixtures/quota-route.module.ts`:
```ts
import {
  Controller,
  HttpCode,
  HttpStatus,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { Db, UnitOfWork } from '../../../../src/core/database/index.js';
import { Idempotent } from '../../../../src/core/http/index.js';
import { Quotas } from '../../../../src/modules/entitlements/index.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';

/**
 * Route tenant giả của một feature (ngoài module tenancy nên không vào luật G-8): tạo một "báo cáo đã lưu" tính quota kỳ
 * NONE, consume và INSERT trong CÙNG `UnitOfWork` (README "consume cùng transaction với side effect", spec §9.2).
 * `?fail=1`: side effect hỏng SAU consume → rollback cả hai.
 */
@Controller('v1/orgs/:orgId/fx-quota')
export class QuotaRouteController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
    private readonly quotas: Quotas,
  ) {}

  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  @TenancyPermissions.require('org.read')
  @Idempotent()
  create(@Query('fail') fail?: string) {
    return this.uow.run(async () => {
      const receipt = await this.quotas.consumeOrThrow('fixture.saved_reports', 1);
      await this.db.execute(
        `INSERT INTO fixture_org_items (org_id, body) VALUES (app_current_org(), ?)`,
        [receipt.featureKey],
      );
      if (fail === '1')
        throw new Error('fixture side effect failed after the consume');
      return { amount: receipt.amount };
    });
  }
}

@Module({ controllers: [QuotaRouteController] })
export class QuotaRouteModule {}
```

- [ ] **Step 2: E2E**

`test/e2e/entitlements/quota-route.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import { readCounters, seedOrgEntitlement } from '../../support/entitlements-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import { QuotaRouteModule } from './fixtures/quota-route.module.js';

describe('quota on an @Idempotent() route (spec SP4 §9.2 idempotency, HT-5, QU-4 over HTTP)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  const items = () =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, async () =>
        Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM fixture_org_items')).rows[0]?.n),
      ),
    );
  const post = (key: string, fail = false) =>
    authed(app, owner)
      .post(`/v1/orgs/${org.orgId}/fx-quota/reports${fail ? '?fail=1' : ''}`)
      .set('idempotency-key', key)
      .send({});
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(fixturePlans, {
      extraImports: [FixtureFeaturesModule, QuotaRouteModule],
    });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedOrgEntitlement(org.orgId, 'metered');
  });
  afterAll(async () => {
    if (org)
      await withAppClient((c) =>
        inOrgTx(c, org.orgId, () => c.query('DELETE FROM fixture_org_items')),
      );
    await org?.dispose();
    await app?.close();
    if (owner) await deleteSeededPrincipals([owner]);
    await disposeCatalogue?.();
  });

  it('HT-5: the same Idempotency-Key twice → the stored response, the quota is consumed once', async () => {
    const key = `k-${v7()}`;
    const first = await post(key);
    const again = await post(key);
    expect([first.status, again.status, again.body]).toEqual([201, 201, first.body]);
    expect((await readCounters(org.orgId)).map((c) => c.used)).toEqual([1]);
    expect(await items()).toBe(1);
  });
  it('QU-4 over HTTP: the handler fails after the consume → 500 and the quota comes back with the side effect', async () => {
    const r = await post(`k-${v7()}`, true);
    expect(r.status).toBe(500);
    expect((await readCounters(org.orgId)).map((c) => c.used)).toEqual([1]);
    expect(await items()).toBe(1);
  });
  it('a new key consumes; at the limit the route answers 422 quota_exceeded with the feature in errors[0]', async () => {
    expect((await post(`k-${v7()}`)).status).toBe(201);
    const full = await post(`k-${v7()}`);
    expect([full.status, full.body.code, full.body.errors?.[0]]).toEqual([
      422,
      'quota_exceeded',
      { path: 'feature', code: 'fixture.saved_reports', message: 'Quota exceeded' },
    ]);
    expect((await readCounters(org.orgId)).map((c) => c.used)).toEqual([2]);
    expect(await items()).toBe(2);
  });
});
```

- [ ] **Step 3: Chạy**

Run: `pnpm vitest run --project integration test/e2e/entitlements/quota-route.e2e.spec.ts`
Expected: PASS (code của Task 6 đã đủ; task này là hợp đồng HTTP của consume, chưa có test nào phủ). Nếu ca HT-5 đỏ vì lần hai trả `409 idempotency_in_progress` (request đầu chưa lưu xong): lỗi nằm ở test gửi song song — hai lời gọi ở đây tuần tự, nên đỏ là bug thật của interceptor, báo controller.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/e2e/entitlements/fixtures/quota-route.module.ts test/e2e/entitlements/quota-route.e2e.spec.ts
git add test/e2e/entitlements/fixtures/quota-route.module.ts test/e2e/entitlements/quota-route.e2e.spec.ts
git commit -m "test(entitlements): a quota consumed in an idempotent route is consumed once and comes back when the handler fails (HT-5)"
```

---
## Phần E — Số ghế (spec §9.6, §22.2 T5, E-6)

### Task 11: Port `MemberSeatLimit` của tenancy; `MemberAdmission` kiểm ghế ngay sau `INSERT org_members`, dưới khoá org (I1); metric `tenancy_seat_limit_denied_total` và `result="seat_limit"` (M8); `quota_exceeded` trong OpenAPI của hai route thu nhận

**Files:**
- Create: `src/modules/tenancy/ports/member-seat-limit.ts`
- Modify: `src/modules/tenancy/application/member-admission.ts`, `src/modules/tenancy/application/tenancy-metrics.ts`, `src/modules/tenancy/application/invitation.service.ts`, `src/modules/tenancy/application/invite-link.service.ts`, `src/modules/tenancy/http/invitation-tokens.controller.ts`, `src/modules/tenancy/http/invite-link-tokens.controller.ts`, `src/modules/tenancy/index.ts`, `openapi.json`
- Create (test): `test/e2e/tenancy/seat-limit-port.e2e.spec.ts`

**Interfaces:**
- Consumes (3A/3C, đã đối chiếu trên `main`): `MemberAdmission.admit({ user, role, actor, admission })` (`application/member-admission.ts`; caller đã khoá `organizations` — trừ org mới tạo — rồi `tenancy_users`, cùng transaction); `MemberRepository.countUpTo(roleId: string | undefined, cap: number): Promise<number>` (trả `min(count, cap + 1)`); `TenancyMetrics` (provider của `TenancyCoreModule`); `AppError`, `CoreErrors.QUOTA_EXCEEDED` (core); lock order của ba đường: `OrgService.create` (khoá `tenancy_users` → INSERT org + 3 role → participant tạo org → `admit` CREATOR), `InvitationService.acceptOnce` (khoá `organizations` → `tenancy_users` → `org_invitations` → `admit` → CAS accept), `InviteLinkService.joinOnce` (khoá `organizations` → `tenancy_users` → `org_invite_links` → `consumeUse` → `admit`); test: `startTenancyApp`, `seedOrg`, `seedInviteLink`, `seedInvitation`, `joinInviteLink`, `acceptInvitation`, `seedUserPrincipal`, `installOtelCapture`.
- Produces:
  - `abstract class MemberSeatLimit { abstract current(): Promise<SeatLimit> }`, `type SeatLimit = { readonly kind: 'UNLIMITED' } | { readonly kind: 'MAX'; readonly max: number; readonly featureKey: string }`, export ở `tenancy/index.ts`.
  - `MemberAdmission` inject `@Optional() seats?: MemberSeatLimit`; port vắng → không giới hạn (hành vi SP3). Kiểm **ngay sau** `members.insert`, **trước** `publish(MemberAddedEvent)`, vẫn dưới khoá org (review I1): `MAX(m)` và (`m = 0` hoặc `countUpTo(undefined, m) > m`, đếm có cả dòng vừa chèn) → `AppError(QUOTA_EXCEEDED, { fields: [{ path: 'feature', code: featureKey, message }], expected: true })`; ném làm cả transaction rollback (dòng member, thu hồi grant của 3D, `use_count`). Vi phạm unique `org_members_org_user_uq` bắn trước nên `409 already_member` giữ nguyên (chế độ `multi`); chế độ `single` kiểm `already_in_an_org` trước INSERT như 3C.
  - `AcquisitionResult` thêm `'seat_limit'`; `tenancy_invitations_total` và `tenancy_invite_link_joins_total` đếm `result="seat_limit"` khi lỗi là `quota_exceeded` (M8).
  - `TenancyMetrics.seatLimitDenied` = `tenancy_seat_limit_denied_total{source}` (`source ∈ CREATOR | INVITATION | INVITE_LINK`).
  - `@ApiProblems` của `POST /v1/invitations/accept` và `POST /v1/invite-links/join` có thêm `CoreErrors.QUOTA_EXCEEDED`.

- [ ] **Step 1: E2E với port giả và không có port (đỏ)**

`test/e2e/tenancy/seat-limit-port.e2e.spec.ts`:
```ts
import { Global, Module, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import {
  MemberSeatLimit,
  type SeatLimit,
} from '../../../src/modules/tenancy/index.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import {
  acceptInvitation,
  joinInviteLink,
} from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  deleteTenancyUsersOf,
  inOrgTx,
  purgeOrgs,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const otel = installOtelCapture();
/** Trần do test đặt; `throw` mô phỏng adapter đọc lỗi (DB) → phải fail closed, không bao giờ "không giới hạn". */
const port: { limit: SeatLimit; fail: AppError | undefined } = {
  limit: { kind: 'UNLIMITED' },
  fail: undefined,
};
class StubSeatLimit extends MemberSeatLimit {
  current(): Promise<SeatLimit> {
    return port.fail ? Promise.reject(port.fail) : Promise.resolve(port.limit);
  }
}
/** Cùng hình dạng module của entitlements (`@Global`, export đúng token): tenancy không biết ai cài port. */
@Global()
@Module({
  providers: [{ provide: MemberSeatLimit, useClass: StubSeatLimit }],
  exports: [MemberSeatLimit],
})
class StubSeatLimitModule {}

const sql = (org: SeededOrg, q: string, params: unknown[] = []) =>
  withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
const memberCount = async (org: SeededOrg) =>
  Number((await sql(org, 'SELECT count(*)::int AS n FROM org_members')).rows[0]?.n);
const useCount = async (org: SeededOrg, linkId: string) =>
  Number((await sql(org, 'SELECT use_count FROM org_invite_links WHERE id = $1', [linkId])).rows[0]?.use_count);

describe('MemberSeatLimit in MemberAdmission (spec SP4 §9.6, §22.2 T5)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const created: string[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgWithLink = async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 10,
    });
    return { org, owner, link };
  };
  beforeAll(async () => {
    app = await startTenancyApp({
      extraImports: [StubSeatLimitModule],
      env: { THROTTLE_DEFAULT_LIMIT: '100000' },
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const o of orgs) await o.dispose();
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
  });

  it('MAX(2) with one member: a join fits, the next one is 422 quota_exceeded with errors[0].code = featureKey; nothing is written', async () => {
    port.limit = { kind: 'MAX', max: 2, featureKey: 'tenancy.seats' };
    const { org, link } = await orgWithLink();
    expect((await joinInviteLink(app, await seedP(), { token: link.token })).status).toBe(201);
    const full = await joinInviteLink(app, await seedP(), { token: link.token });
    expect([full.status, full.body.code, full.body.errors?.[0]]).toEqual([
      422,
      'quota_exceeded',
      { path: 'feature', code: 'tenancy.seats', message: 'Quota exceeded' },
    ]);
    expect([await memberCount(org), await useCount(org, link.id)]).toEqual([2, 1]);
    expect(await otel.metric('tenancy_seat_limit_denied_total', { source: 'INVITE_LINK' })).toBeGreaterThanOrEqual(1);
    expect(await otel.metric('tenancy_invite_link_joins_total', { result: 'seat_limit' })).toBeGreaterThanOrEqual(1);
  });
  it('I1: an existing member joining or accepting into a full org still gets 409 already_member (the unique violation fires before the seat check)', async () => {
    port.limit = { kind: 'MAX', max: 2, featureKey: 'tenancy.seats' };
    const { org, link } = await orgWithLink();
    const member = await seedP();
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    const join = await joinInviteLink(app, member, { token: link.token });
    expect([join.status, join.body.code]).toEqual([409, 'already_member']);
    const inv = await seedInvitation(org, {
      email: member.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    const accepted = await acceptInvitation(app, member, { token: inv.token });
    expect([accepted.status, accepted.body.code]).toEqual([409, 'already_member']);
    expect([await memberCount(org), await useCount(org, link.id)]).toEqual([2, 0]);
  });
  it('an invitation accepted at the limit is 422 and the invitation stays PENDING (a pending invitation takes no seat)', async () => {
    port.limit = { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' };
    const { org } = await orgWithLink();
    const invitee = await seedP();
    const inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    const r = await acceptInvitation(app, invitee, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([422, 'quota_exceeded']);
    expect((await sql(org, 'SELECT status FROM org_invitations WHERE id = $1', [inv.id])).rows).toEqual([
      { status: 'PENDING' },
    ]);
    expect(await otel.metric('tenancy_invitations_total', { result: 'seat_limit' })).toBeGreaterThanOrEqual(1);
  });
  it('creating an org: MAX(1) admits the creator; MAX(0) refuses it and no organization is left behind', async () => {
    const creator = await seedP();
    port.limit = { kind: 'MAX', max: 1, featureKey: 'tenancy.seats' };
    const ok = await authed(app, creator).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name: 'Seat 1' });
    expect(ok.status).toBe(201);
    created.push(ok.body.id);
    port.limit = { kind: 'MAX', max: 0, featureKey: 'tenancy.seats' };
    const refused = await authed(app, creator).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name: 'Seat 0' });
    expect([refused.status, refused.body.code]).toEqual([422, 'quota_exceeded']);
    const list = await authed(app, creator).get('/v1/orgs');
    expect((list.body.data as { id: string }[]).map((o) => o.id)).toEqual([ok.body.id]);
  });
  it('the port failing (an infrastructure error of the adapter) fails closed: 503, the link use and the membership roll back', async () => {
    port.limit = { kind: 'UNLIMITED' };
    port.fail = new AppError(CoreErrors.SERVICE_UNAVAILABLE);
    try {
      const { org, link } = await orgWithLink();
      const r = await joinInviteLink(app, await seedP(), { token: link.token });
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect([await memberCount(org), await useCount(org, link.id)]).toEqual([1, 0]);
    } finally {
      port.fail = undefined;
    }
  });
});

describe('SE-3: without a MemberSeatLimit provider (entitlements not installed) seats are unlimited, as in SP3', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  let org: SeededOrg;
  beforeAll(async () => {
    app = await startTenancyApp({ env: { THROTTLE_DEFAULT_LIMIT: '100000' } });
  });
  afterAll(async () => {
    await org?.dispose();
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
  });
  it('five joins through one link all succeed', async () => {
    const owner = await seedUserPrincipal();
    principals.push(owner);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 5,
    });
    for (let i = 0; i < 5; i++) {
      const p = await seedUserPrincipal();
      principals.push(p);
      expect((await joinInviteLink(app, p, { token: link.token })).status).toBe(201);
    }
    expect(await memberCount(org)).toBe(6);
  });
});
```
(`GET /v1/orgs` trả trang offset của `src/core/http/pagination.ts`: danh sách ở `data`.)

- [ ] **Step 2: Chạy cho thấy đỏ**

Run: `pnpm vitest run --project integration test/e2e/tenancy/seat-limit-port.e2e.spec.ts`
Expected: FAIL — `MemberSeatLimit` không được export từ `tenancy/index.ts` (lỗi import); sau khi export mà chưa nối `MemberAdmission`: join thứ hai `201`.

- [ ] **Step 3: Port**

`src/modules/tenancy/ports/member-seat-limit.ts`:
```ts
/** Trần số ghế hiện hành của org trong context hiện tại (spec SP4 §9.6). Ghế = một dòng `org_members`. */
export type SeatLimit =
  | { readonly kind: 'UNLIMITED' }
  | {
      readonly kind: 'MAX';
      readonly max: number;
      readonly featureKey: string;
    };

/**
 * Port (spec SP4 §9.6, amendment T5; cùng mẫu `@Global()` + `@Optional()` của SP3 §5.2): entitlements cài bằng module
 * `@Global()` ở api và worker; tenancy KHÔNG import entitlements (luật 20.8-a). Vắng → không giới hạn (hành vi SP3).
 * Gọi trong UnitOfWork + OrgScope của `MemberAdmission`, sau khoá org; adapter chỉ đọc (không khoá, không ghi). Đọc lỗi →
 * ném (fail closed: 503), không bao giờ trả "không giới hạn".
 */
export abstract class MemberSeatLimit {
  abstract current(): Promise<SeatLimit>;
}
```

`src/modules/tenancy/index.ts` — thêm:
```ts
export {
  MemberSeatLimit,
  type SeatLimit,
} from './ports/member-seat-limit.js';
```

- [ ] **Step 4: Kiểm ghế trong `MemberAdmission`**

`src/modules/tenancy/application/tenancy-metrics.ts` — thêm instrument (cạnh các counter khác):
```ts
  readonly seatLimitDenied = this.meter.createCounter(
    'tenancy_seat_limit_denied_total',
    {
      description:
        'Admissions refused because the organization has no free seat (spec SP4 §9.6), by admission source',
    },
  );
```

`src/modules/tenancy/application/member-admission.ts`:
- import: `Inject, Injectable, Optional` từ `@nestjs/common`; `AppError, CoreErrors` từ core/errors (thay import `AppError` hiện có); `MemberSeatLimit` từ `'../ports/member-seat-limit.js'`; `TenancyMetrics` từ `'./tenancy-metrics.js'`;
- constructor thêm hai tham số cuối:
```ts
    private readonly metrics: TenancyMetrics,
    /** Spec SP4 §9.6: vắng (entitlements không cài) → không giới hạn. */
    @Optional() private readonly seats?: MemberSeatLimit,
```
- trong `admit`, xoá khối chú thích ba dòng "4B (spec SP4 §9.6): kiểm ghế `tenancy.seats` qua port … đặt ở ĐÂY …" (chỗ đặt cũ, trước thu hồi grant), và thêm lời gọi ngay sau `const member = await this.members.insert({ … });`, trước `await this.events.publish(MemberAddedEvent, …)`:
```ts
        // Spec SP4 §9.6 (review 4B, I1): SAU INSERT, vẫn dưới khoá org, trước event: vi phạm unique (đã là member) bắn
        // trước nên `409 already_member` giữ nguyên; phủ mọi nguồn (CREATOR, INVITATION, INVITE_LINK) mà 3C không gọi
        // entitlements; ném → cả transaction của caller rollback (member, thu hồi grant, lượt dùng link).
        await this.assertSeat(i.admission.source);
```
- thêm phương thức riêng:
```ts
  /**
   * Ghế = một dòng `org_members` (spec SP4 §9.6, E-6). Gọi SAU INSERT (dòng vừa chèn được đếm, nên đầy là `count > max`) và
   * sau khoá org của caller (mọi đường thêm member khoá org trước; org vừa tạo chưa ai thấy được) dưới READ COMMITTED (mỗi
   * câu một snapshot mới), nên thấy mọi member đã commit; đếm có trần (`countUpTo`, cap = max, trả tối đa max + 1) nên không
   * quét cả org. `max = 0`: không ai vào được (`countUpTo` đòi cap ≥ 1). Lời mời PENDING, org key, support grant không
   * chiếm ghế.
   */
  private async assertSeat(source: Admission['source']): Promise<void> {
    if (!this.seats) return;
    const limit = await this.seats.current();
    switch (limit.kind) {
      case 'UNLIMITED':
        return;
      case 'MAX': {
        const full =
          limit.max === 0 ||
          (await this.members.countUpTo(undefined, limit.max)) > limit.max;
        if (!full) return;
        this.metrics.seatLimitDenied.add(1, { source });
        throw new AppError(CoreErrors.QUOTA_EXCEEDED, {
          fields: [
            {
              path: 'feature',
              code: limit.featureKey,
              message: CoreErrors.QUOTA_EXCEEDED.title,
            },
          ],
          expected: true,
        });
      }
      default: {
        const unknown: never = limit;
        throw new Error(`unknown seat limit ${JSON.stringify(unknown)}`);
      }
    }
  }
```

`src/modules/tenancy/http/invitation-tokens.controller.ts` và `src/modules/tenancy/http/invite-link-tokens.controller.ts` — trong `@ApiProblems(…)` của `accept` và `join`, thêm `CoreErrors.QUOTA_EXCEEDED` (ngay trước `CoreErrors.VALIDATION_FAILED`).

`src/modules/tenancy/application/tenancy-metrics.ts` — `AcquisitionResult` thêm `| 'seat_limit'` (cuối union). `src/modules/tenancy/application/invitation.service.ts` (`acceptOnce`) và `src/modules/tenancy/application/invite-link.service.ts` (`joinOnce`) — trong `catch`, thêm một nhánh sau nhánh `TenancyErrors.ALREADY_IN_AN_ORG` (M8; ví dụ của `joinOnce`, `acceptOnce` dùng `this.metrics.invitations`):
```ts
      // Spec SP4 §9.6: org đầy ghế (`MemberAdmission`, port `MemberSeatLimit`).
      else if (
        err instanceof AppError &&
        err.error === CoreErrors.QUOTA_EXCEEDED
      )
        this.metrics.inviteLinkJoins.add(1, { result: 'seat_limit' });
```

- [ ] **Step 5: Chạy lại, sinh lại OpenAPI**

Run:
```bash
pnpm vitest run --project integration test/e2e/tenancy/seat-limit-port.e2e.spec.ts test/e2e/tenancy/acquisition-races.e2e.spec.ts test/e2e/tenancy/invite-links.e2e.spec.ts test/e2e/tenancy/invitations.e2e.spec.ts test/integration/tenancy/single-org-admission.spec.ts test/e2e/tenancy/orgs.e2e.spec.ts
pnpm build && pnpm openapi:export && git diff --stat openapi.json
pnpm arch
```
Expected: PASS; mọi test 3C/3A cũ xanh nguyên (port vắng ở `startTenancyApp`); `openapi.json` chỉ thêm `422 quota_exceeded` vào hai route; `pnpm arch` xanh (tenancy không import entitlements).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy/seat-limit-port.e2e.spec.ts
git add src/modules/tenancy test/e2e/tenancy/seat-limit-port.e2e.spec.ts openapi.json
git commit -m "feat(tenancy): MemberSeatLimit port; MemberAdmission counts members under the org lock and refuses a full org with quota_exceeded"
```

---

### Task 12: Adapter `MemberSeatLimit` của entitlements (`tenancy.seats`) ở api và worker; ghế song song ×50, hạ gói, gói một ghế, thiếu dòng (SE-1, SE-2, SE-3 phần người tạo, Review Focus 4)

**Files:**
- Create: `src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.ts`, `src/modules/entitlements/infra/tenancy/entitlements-tenancy-ports.module.ts`
- Modify: `src/modules/entitlements/entitlements.module.ts`
- Create (test): `test/e2e/entitlements/seats.e2e.spec.ts`, `test/integration/entitlements/seat-limit-di.spec.ts`

**Interfaces:**
- Consumes: `MemberSeatLimit`, `SeatLimit` (`tenancy/index.ts`, Task 11); `Entitlements.limitOf(key): Promise<Limit>` (4A: ném `EntitlementsRowMissingError` khi thiếu dòng, `EntitlementsVersionSkewError` khi gói lạ); `BoilerplateFeatures.key('tenancy.seats')` (4A, helper có kiểu); test: `startEntitlementsApp`, `entitlementsCoreImports`, `createTestApp`, `raceOnOrgLock`, `joinInviteLink`, `acceptInvitation`, `seedInviteLink`, `seedInvitation`, `seedMember`, `seedOrg`, `seedOrgEntitlement`, `setOrgPlan`, `fixturePlans` (gói `metered` 3 ghế, `duo` 2, `solo` 1, `pro` 10), `seedFixtureCatalogue`, `FixtureFeaturesModule`.
- Produces: `MemberSeatLimitAdapter extends MemberSeatLimit` (`limitOf('tenancy.seats')` → `SeatLimit`, `switch` vét cạn); `EntitlementsTenancyPortsModule` (`@Global()`, `providers: [MemberSeatLimitAdapter, { provide: MemberSeatLimit, useExisting: MemberSeatLimitAdapter }]`, `exports: [MemberSeatLimit]`) được import trong **cả** `EntitlementsModule.forApi()` lẫn `forWorker()`.

- [ ] **Step 1: Test DI và e2e (đỏ)**

`test/integration/entitlements/seat-limit-di.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberSeatLimitAdapter } from '../../../src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.js';
import { MemberSeatLimit } from '../../../src/modules/tenancy/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';

/** Spec SP4 §9.6: adapter ở CẢ worker (đối xứng, X-10 của SP3); api được phủ bởi `seats.e2e.spec.ts`. */
describe('the seat adapter is wired in the worker composition', () => {
  let app: INestApplication;
  let dispose: () => Promise<void>;
  beforeAll(async () => {
    dispose = await seedFixtureCatalogue();
    app = await createTestApp(entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]));
  });
  afterAll(async () => {
    await app?.close();
    await dispose?.();
  });
  it('MemberSeatLimit resolves to the entitlements adapter', () => {
    expect(app.get(MemberSeatLimit)).toBeInstanceOf(MemberSeatLimitAdapter);
  });
});
```

`test/e2e/entitlements/seats.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberSeatLimitAdapter } from '../../../src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.js';
import { MemberSeatLimit } from '../../../src/modules/tenancy/index.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import { seedOrgEntitlement, setOrgPlan } from '../../support/entitlements-seed.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import {
  acceptInvitation,
  joinInviteLink,
} from '../../support/tenancy-acquisition.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  deleteTenancyUsersOf,
  inOrgTx,
  purgeOrgs,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RUNS = 50;
const JOINERS = 4;
/** Gói mặc định một ghế cho cả file (Review Focus 4): org tạo qua API rơi vào `solo`; ca khác seed gói tường minh. */
const soloFirst = { ...fixturePlans, defaultPlan: 'solo' };
const SEAT_ERROR = { path: 'feature', code: 'tenancy.seats', message: 'Quota exceeded' };

describe('seats through the entitlements adapter (spec SP4 §9.6, E-6; SE-1, SE-2, SE-3)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  let owner: SeededPrincipal;
  const joiners: SeededPrincipal[] = [];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const created: string[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const sql = (orgId: string, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, orgId, () => c.query(q, params)));
  const memberCount = async (orgId: string) =>
    Number((await sql(orgId, 'SELECT count(*)::int AS n FROM org_members')).rows[0]?.n);
  const orgOn = async (plan: string) => {
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    await seedOrgEntitlement(org.orgId, plan);
    return org;
  };
  const linkOf = (org: SeededOrg, maxUses = 10) =>
    seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses,
    });
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await startEntitlementsApp(soloFirst, {
      extraImports: [FixtureFeaturesModule],
      env: { THROTTLE_DEFAULT_LIMIT: '100000' },
    });
    owner = await seedP();
    for (let i = 0; i < JOINERS; i++) joiners.push(await seedP());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    await disposeCatalogue?.();
  });

  it('the api composition resolves MemberSeatLimit to the entitlements adapter', () => {
    expect(app.get(MemberSeatLimit)).toBeInstanceOf(MemberSeatLimitAdapter);
  });
  it(`SE-1 (E-6): ${JOINERS} parallel joins with 2 free seats → exactly 2 members, 2 × 422 quota_exceeded, use_count 2, ×${RUNS}`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const org = await orgOn('metered');
      const link = await linkOf(org);
      const rs = await raceOnOrgLock(org.orgId, JOINERS, () =>
        Promise.all(joiners.map((p) => joinInviteLink(app, p, { token: link.token }))),
      );
      expect(rs.map((r) => r.status).sort(), `run ${i}`).toEqual([201, 201, 422, 422]);
      for (const r of rs.filter((x) => x.status === 422))
        expect([r.body.code, r.body.errors?.[0]], `run ${i}`).toEqual(['quota_exceeded', SEAT_ERROR]);
      expect(await memberCount(org.orgId), `run ${i}`).toBe(3);
      expect(
        (await sql(org.orgId, 'SELECT use_count FROM org_invite_links WHERE id = $1', [link.id])).rows,
        `run ${i}`,
      ).toEqual([{ use_count: 2 }]);
    }
  }, 600_000);
  it('SE-2: a downgrade below the member count removes nobody; accepting is refused; after removing 4 members it succeeds', async () => {
    const org = await orgOn('pro');
    const extra: string[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await seedMember(org, 'MEMBER', { authUserId: (await seedP()).authUserId });
      extra.push(m.memberPublicId);
    }
    await setOrgPlan(org.orgId, 'duo');
    expect(await memberCount(org.orgId)).toBe(5);
    const invitee = await seedP();
    const inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    const refused = await acceptInvitation(app, invitee, { token: inv.token });
    expect([refused.status, refused.body.errors?.[0]]).toEqual([422, SEAT_ERROR]);
    expect(await memberCount(org.orgId)).toBe(5);
    for (const id of extra)
      expect((await authed(app, owner).delete(`/v1/orgs/${org.orgId}/members/${id}`)).status).toBe(204);
    expect((await acceptInvitation(app, invitee, { token: inv.token })).status).toBe(201);
    expect(await memberCount(org.orgId)).toBe(2);
  });
  it('Review Focus 4: a one-seat plan admits the creator and nobody else', async () => {
    const creator = await seedP();
    const r = await authed(app, creator)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'One seat' });
    expect(r.status).toBe(201);
    const orgId: string = r.body.id;
    created.push(orgId);
    expect((await authed(app, creator).get(`/v1/orgs/${orgId}/entitlements`)).body.features).toContainEqual(
      expect.objectContaining({ key: 'tenancy.seats', limit: 1, unlimited: false }),
    );
    const role = (
      await sql(orgId, `SELECT public_id::text AS id FROM org_roles WHERE system_key = 'MEMBER'`)
    ).rows[0]?.id;
    const link = await authed(app, creator)
      .post(`/v1/orgs/${orgId}/invite-links`)
      .send({ roleId: role, maxUses: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(link.status).toBe(201);
    const token = new URL(link.body.url).hash.replace('#token=', '');
    const join = await joinInviteLink(app, await seedP(), { token });
    expect([join.status, join.body.errors?.[0]]).toEqual([422, SEAT_ERROR]);
    expect(await memberCount(orgId)).toBe(1);
  });
  it('an org without its entitlement row: a join answers 503 + Retry-After and nothing is written (fail closed, never unlimited)', async () => {
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const link = await linkOf(org);
    const r = await joinInviteLink(app, joiners[0]!, { token: link.token });
    expect([r.status, r.body.code, r.headers['retry-after']]).toEqual([503, 'service_unavailable', '5']);
    expect(await memberCount(org.orgId)).toBe(1);
    expect(
      (await sql(org.orgId, 'SELECT use_count FROM org_invite_links WHERE id = $1', [link.id])).rows,
    ).toEqual([{ use_count: 0 }]);
  });
});
```

- [ ] **Step 2: Chạy cho thấy đỏ**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements/seat-limit-di.spec.ts test/e2e/entitlements/seats.e2e.spec.ts
```
Expected: FAIL — module `member-seat-limit.adapter.js` không tồn tại.

- [ ] **Step 3: Adapter và module port**

`src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { MemberSeatLimit, type SeatLimit } from '../../../tenancy/index.js';
import { Entitlements } from '../../application/entitlements.service.js';
import { BoilerplateFeatures } from '../../features.js';

const SEATS = BoilerplateFeatures.key('tenancy.seats');

/**
 * Port ghế của tenancy (spec SP4 §9.6): trần hiệu lực `OVERRIDE > PLAN > FALLBACK` của `tenancy.seats` tại snapshot của
 * câu đọc, trong transaction của `MemberAdmission` (thấy gói vừa ghi cùng transaction). Một câu snapshot, không khoá, không
 * ghi: khoá org đã do tenancy giữ (đầu thứ tự khoá §3.6). Thiếu dòng / gói lạ → lỗi có tên (503), không bao giờ "không
 * giới hạn" (fail closed).
 */
@Injectable()
export class MemberSeatLimitAdapter extends MemberSeatLimit {
  constructor(private readonly entitlements: Entitlements) {
    super();
  }

  async current(): Promise<SeatLimit> {
    const limit = await this.entitlements.limitOf(SEATS);
    switch (limit.kind) {
      case 'UNLIMITED':
        return { kind: 'UNLIMITED' };
      case 'MAX':
        return { kind: 'MAX', max: limit.max, featureKey: SEATS };
      default: {
        const unknown: never = limit;
        throw new Error(`unknown limit ${JSON.stringify(unknown)}`);
      }
    }
  }
}
```

`src/modules/entitlements/infra/tenancy/entitlements-tenancy-ports.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { MemberSeatLimit } from '../../../tenancy/index.js';
import { MemberSeatLimitAdapter } from './member-seat-limit.adapter.js';

/**
 * `@Global`: `MemberAdmission` (tenancy, `TenancyCoreModule` `@Global`) inject `@Optional()` token `MemberSeatLimit`;
 * tenancy không import entitlements (luật 20.8-a). Cùng mẫu `TenancyIdentityPortsModule`. Nạp ở CẢ api lẫn worker (spec
 * §9.6: admission chạy ở api; worker giữ đối xứng để composition thật của cả hai vai cùng hình dạng).
 */
@Global()
@Module({
  providers: [
    MemberSeatLimitAdapter,
    { provide: MemberSeatLimit, useExisting: MemberSeatLimitAdapter },
  ],
  exports: [MemberSeatLimit],
})
export class EntitlementsTenancyPortsModule {}
```

`src/modules/entitlements/entitlements.module.ts` — import `EntitlementsTenancyPortsModule`; `forApi` thành `imports: [EntitlementsCoreModule.register(plans), EntitlementsHttpModule, EntitlementsTenancyPortsModule]`, `forWorker` thành `imports: [EntitlementsCoreModule.register(plans), EntitlementsTenancyPortsModule]`; chú thích của `EntitlementsModule` thêm: "Cả hai vai: port ghế của tenancy (`EntitlementsTenancyPortsModule`, spec §9.6)."

- [ ] **Step 4: Chạy lại cho thấy xanh**

Run:
```bash
pnpm vitest run --project integration test/integration/entitlements test/e2e/entitlements test/e2e/tenancy/seat-limit-port.e2e.spec.ts test/integration/composition
pnpm arch
```
Expected: PASS. `test/integration/composition` (composition thật, có entitlements) vẫn boot: port được nạp, mọi org ở gói mặc định `free` (`tenancy.seats` = fallback `UNLIMITED`) nên không test SP3 nào đổi hành vi. `seats.e2e.spec.ts` SE-1 chạy ba lần liền để chắc barrier ổn định.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/entitlements test/e2e/entitlements/seats.e2e.spec.ts test/integration/entitlements/seat-limit-di.spec.ts
git add src/modules/entitlements test/e2e/entitlements/seats.e2e.spec.ts test/integration/entitlements/seat-limit-di.spec.ts
git commit -m "feat(entitlements): tenancy.seats adapter for MemberSeatLimit in api and worker; parallel joins never exceed the seats (SE-1 x50)"
```

---

## Phần F — Sự cố, prod-like, tài liệu, bàn giao (spec §18, §20.4, §22)

### Task 13: Chaos — DB mất giữa câu consume và giữa câu đọc trần ghế → 503, không 500, không ghi gì (tiêu chí 11, F-1)

**Files:**
- Modify: `test/chaos/entitlements-outages.spec.ts`

**Interfaces:**
- Consumes: `startTcpProxy`, `TcpProxy` (`test/support/tcp-proxy.ts`); `SqlUsageCounterRepository.consume` (Task 5), `SqlOrgEntitlementRepository.readSnapshot` (4A); `Quotas` (Task 6); `isDbInfraError`, `toAppError`; `seedInviteLink`, `joinInviteLink`; các helper sẵn có của file (`armSnapshot`, `proxy`, `app`, `org`, `owner`).
- Produces: hai ca chaos mới; không code src.

- [ ] **Step 1: Viết ca**

`test/chaos/entitlements-outages.spec.ts`:
- thêm import: `Quotas` (cạnh `PlanAssignments`) từ `index.ts`; `SqlUsageCounterRepository` từ `'../../src/modules/entitlements/infra/sql/sql-usage-counter.repository.js'`; `readCounters` từ `entitlements-seed.js`; `joinInviteLink` từ `'../support/tenancy-acquisition.js'`; `inOrgTx, seedInviteLink, withAppClient` từ `tenancy-seed.js`;
- trong `beforeAll`, sau `seedOrgEntitlement(org.orgId, 'free')`, đổi gói của org sang `metered` (có trần ghế và quota nhỏ): thay dòng đó bằng `await seedOrgEntitlement(org.orgId, 'metered');` (hai ca 4A cũ chỉ đọc snapshot và gán `pro` theo `BILLING`, không phụ thuộc gói đầu là `free`; ca `assign` của 4A khẳng định `planKey: 'free'` sau sự cố → sửa kỳ vọng đó thành `'metered'`);
- thêm helper cạnh `armAssignLock`:
```ts
  /** Bật blackhole ngay trước câu consume thật (một lần): lỗi rơi vào câu INSERT … ON CONFLICT, không vào câu snapshot. */
  const armConsume = () => {
    const repo = app.get(SqlUsageCounterRepository);
    const original = repo.consume.bind(repo);
    vi.spyOn(repo, 'consume').mockImplementationOnce((i) => {
      proxy.state.blackhole = true;
      return original(i);
    });
  };
```
- thêm hai ca cuối `describe`:
```ts
  it('consume: DB lost at the consume statement → an infra error mapped to 503; no counter, no event', async () => {
    armConsume();
    let err: unknown;
    try {
      err = await app
        .get(OrgScope)
        .run(org.orgId, () =>
          app.get(UnitOfWork).run(() => app.get(Quotas).consume('fixture.api_calls', 1)),
        )
        .catch((e: unknown) => e);
    } finally {
      proxy.state.blackhole = false;
    }
    expect(isDbInfraError(err)).toBe(true);
    expect(toAppError(err).error.status).toBe(503);
    await vi.waitFor(async () => expect(await readCounters(org.orgId)).toEqual([]), RECOVERY);
    expect(
      await ownerQuery(
        `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.quota.reached'`,
        [org.orgId],
      ),
    ).toEqual([]);
  });
  it('join: DB lost at the seat read (the snapshot inside MemberAdmission) → 503; no member, the link use rolls back', async () => {
    const joiner = await seedUserPrincipal();
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
      maxUses: 5,
    });
    try {
      armSnapshot();
      let status: number;
      try {
        const started = performance.now();
        const r = await joinInviteLink(app, joiner, { token: link.token });
        expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
        status = r.status;
      } finally {
        proxy.state.blackhole = false;
      }
      expect(status).toBe(503);
      await vi.waitFor(
        async () =>
          expect(
            (
              await withAppClient((c) =>
                inOrgTx(c, org.orgId, () =>
                  c.query(
                    'SELECT (SELECT count(*)::int FROM org_members) AS members, (SELECT use_count FROM org_invite_links WHERE id = $1) AS uses',
                    [link.id],
                  ),
                ),
              )
            ).rows,
          ).toEqual([{ members: 1, uses: 0 }]),
        RECOVERY,
      );
    } finally {
      await deleteSeededPrincipals([joiner]);
    }
  });
```

- [ ] **Step 2: Chạy**

Run: `pnpm test:chaos -- test/chaos/entitlements-outages.spec.ts`
Expected: PASS 4/4 trong giới hạn `OUTAGE_BOUND_MS`; không ca nào trả `500`.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write test/chaos/entitlements-outages.spec.ts
git add test/chaos/entitlements-outages.spec.ts
git commit -m "test(chaos): a database lost at the consume statement or at the seat read answers 503 and writes nothing"
```

---
### Task 14: Prod-like trên image production — schema 4B chạy từ `dist`, ghế đi qua adapter trên luồng HTTP thật, đo image (ADR 0013 "SP4 (4B)")

**Files:**
- Modify: `test/smoke/entitlements.smoke.spec.ts`, `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: `verifiedDevice`, `PASSWORD` (`test/smoke/smoke-devices.ts`), `psql` (superuser, bỏ qua RLS), `logsSince`, `assertCleanLogs`, `workerHealth` (`test/smoke/smoke-support.ts`); `Device.call(method, path, { body, headers })`; env smoke có `TENANCY_INVITE_LINK_JOIN_URL` (`test/smoke/smoke-app-env.ts`).
- Produces: hai ca smoke 4B; mục "Số đo SP4 (4B)" của ADR 0013.

- [ ] **Step 1: Ca smoke**

`test/smoke/entitlements.smoke.spec.ts` — sửa mô tả `describe` thành `'prod-like smoke: plans 4A and 4B'`; thêm hai ca **trước** ca log sạch (ca cuối của file):
```ts
  it('the 4B migration ran from dist: usage_counters with FORCE RLS, the NULLS NOT DISTINCT arbiter, an INVOKER period trigger, UPDATE on three columns only', () => {
    expect(
      psql(
        `SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_class WHERE relname = 'usage_counters'`,
      ),
    ).toBe('true:true');
    expect(
      psql(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'usage_counters_period_uq'`,
      ),
    ).toBe('UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)');
    expect(
      psql(
        `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'usage_counters'::regclass`,
      ),
    ).toBe('usage_counters_period_ck');
    expect(
      psql(
        `SELECT prosecdef::text FROM pg_proc WHERE proname = 'entitlements_usage_counter_period_ck'`,
      ),
    ).toBe('false');
    expect(
      psql(
        `SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a
         WHERE a.attrelid = 'usage_counters'::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND has_column_privilege('app_user', a.attrelid, a.attname, 'UPDATE')`,
      ),
    ).toBe('updated_at,used,version');
  });
  it('seats on the production image: creating an org and joining through an invite link go through the seat adapter; the tenant view lists both boilerplate LIMITs', async () => {
    const { device: owner } = await verifiedDevice(apiUrl, mail, forbidden);
    const created = await owner.call('POST', '/v1/orgs', {
      body: { name: 'Smoke 4B' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(await created.json());
    const roleId = psql(
      `SELECT public_id FROM org_roles WHERE org_id = '${id}' AND system_key = 'MEMBER'`,
    );
    const link = await owner.call('POST', `/v1/orgs/${id}/invite-links`, {
      body: {
        roleId,
        maxUses: 2,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(link.status).toBe(201);
    const { url } = z.object({ url: z.string() }).parse(await link.json());
    const token = new URL(url).hash.replace('#token=', '');
    forbidden.push(token); // token một lần không bao giờ vào log
    const { device: joiner } = await verifiedDevice(apiUrl, mail, forbidden);
    const joined = await joiner.call('POST', '/v1/invite-links/join', {
      body: { token },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(joined.status).toBe(201);
    expect(psql(`SELECT count(*) FROM org_members WHERE org_id = '${id}'`)).toBe('2');
    const ent = await owner.call('GET', `/v1/orgs/${id}/entitlements`);
    expect(ent.status).toBe(200);
    const { features } = z
      .object({ features: z.array(z.object({ key: z.string() }).passthrough()) })
      .parse(await ent.json());
    expect(features.map((f) => f.key)).toEqual(['files.storage_bytes', 'tenancy.seats']);
    expect(psql(`SELECT count(*) FROM usage_counters WHERE org_id = '${id}'`)).toBe('0');
  });
```
Ghi chú phạm vi (đưa vào mô tả PR, Task 16): phần "consume tới trần → 422" của SM-1 **không** chạy được trên image của boilerplate vì chưa route nào ship tiêu thụ một `QUOTA` (catalogue boilerplate chỉ có hai `LIMIT`; người dùng `QUOTA` đầu tiên là feature mẫu `example.project_count` của SP7 7D). Đường consume qua HTTP được phủ bởi `quota-route.e2e.spec.ts` (Task 10) trên app Nest thật; trên image, SM-1 của 4B phủ schema từ `dist` và đường ghế (adapter thật trong `MemberAdmission`). 7D thêm ca consume tới `422` vào smoke của nó.

- [ ] **Step 2: Chạy prod-like**

Run: `pnpm test:smoke`
Expected: build image production thật; `docker compose --profile app` (`NODE_ENV=production`) migrate từ `dist` (gồm `…_usage_counters`); mọi file smoke PASS (core, core-shared, auth-email, dashboard, composition, tenancy, entitlements); catalogue check của api và worker đạt (code và DB cùng có `files.storage_bytes`); log api/worker JSON, không dòng `error`, không giá trị nào của `forbidden`; `/health/ready` 200; `down -v` sạch.

- [ ] **Step 3: Đo image, ghi ADR 0013**

Run (cùng phương pháp các dòng trước của ADR 0013):
```bash
docker history --no-trunc --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
docker image inspect --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
```
`docs/adr/0013-build-toolchain.md` — thêm sau mục "Số đo SP3 (cuối)":
```markdown
### Số đo SP4 (4B) (<ngày chạy, YYYY-MM-DD>)

Đo sau `pnpm test:smoke` xanh của Task 14 (plan 4B) trên HEAD nhánh `sp4b-usage-quota-seats`, cùng máy và phương pháp với dòng SP3 (cuối) (tổng layer `docker history`; nén = `docker image inspect --format '{{.Size}}'`). 4B không thêm package (spec SP4 tiêu chí 12): `package.json` và `pnpm-lock.yaml` không đổi so với `main`; thay đổi là code của `entitlements`, `tenancy` và một migration.

| Chỉ số | SP3 (cuối) | SP4 (4B) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 356,5 MB | <số đo> | <chênh> |
| Image nén | 81,8 MB | <số đo> | <chênh> |
| Layer `dist` | 7,24 MB | <số đo> | <chênh> |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT, dư 43,5 MB | <ĐẠT/KHÔNG, dư …> | |
```
Các ô `<…>` điền bằng số đo thật của lần chạy (dữ liệu đo, không phải chỗ trống của plan). Chênh > 1 MB phải có một câu giải thích nguồn.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/smoke/entitlements.smoke.spec.ts
git add test/smoke/entitlements.smoke.spec.ts docs/adr/0013-build-toolchain.md
git commit -m "test(smoke): usage_counters from dist and the seat adapter on the production image; record the SP4 (4B) image size"
```

---

### Task 15: Tài liệu — ADR 0018/0005, spec cha (P1, P3 phần 4B), spec SP3 (T5), spec SP4 (lệch có chủ đích của 4B), README, chú thích `OPTIONAL_BRIDGES`

**Files:**
- Modify: `docs/adr/0018-entitlements-in-code.md`, `docs/adr/0005-multi-tenant-rls.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, `docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md`, `docs/boilerplate/README.md`, `src/boilerplate.modules.ts` (chỉ chú thích)

**Interfaces:**
- Consumes: mọi tên, mã lỗi, metric của Task 3–14.
- Produces: tài liệu khớp code; không còn nhãn `(4B)` ở spec cha.

- [ ] **Step 1: ADR 0018**

`docs/adr/0018-entitlements-in-code.md`:
- mục "Hợp đồng với tenancy (sổ export L1)" thêm dòng: `- 4B thêm vào \`modules/tenancy/index.ts\`: \`MemberSeatLimit\`, \`type SeatLimit\` (port ghế, \`@Optional()\` trong \`MemberAdmission\`); entitlements cài bằng \`EntitlementsTenancyPortsModule\` (\`@Global\`, api + worker). 4B dùng \`MemberAdmission\` không đổi chữ ký.`
- thêm mục cuối:
```markdown
## Cập nhật plan 4B (<ngày merge>)

- **Bộ đếm** `usage_counters`: một dòng mỗi (org, tính năng QUOTA, kỳ); kỳ `NONE` là `period_start NULL` dưới `UNIQUE NULLS NOT DISTINCT` (spike S4-T2 ở trên); kỳ `MONTH` do câu SQL tính (`date_trunc('month', now(), ENTITLEMENTS_QUOTA_TIMEZONE)`), tạo lười, không cron. Consume là một câu `INSERT … ON CONFLICT … DO UPDATE … WHERE used + n <= max` trong transaction của caller; release trả đúng dòng của receipt; trả quá → `QuotaReleaseUnderflowError`.
- **Thứ tự kiểm của `Quotas.consume`:** transaction + org → key là QUOTA, không deprecated → `amount` nguyên trong `[1, 2^53 − 1]` → trần (snapshot trong transaction) → `amount > max` trả `EXCEEDED` không ghi → câu consume. `EXCEEDED` mang `used` đọc lại (một câu đọc, không ghi).
- **`quota.reached`** phát cùng transaction ở mỗi lần `used` chuyển từ dưới trần sang đúng trần (kể cả chạm lại sau `release`; không khử trùng theo kỳ, M3); actor: user, `service` (`api_key:<id>` cho org API key), hoặc `system` `entitlements.quotas` khi không có principal.
- **Ghế:** port `MemberSeatLimit` của tenancy; `MemberAdmission` kiểm ngay sau `INSERT org_members` (dòng mới được đếm: `countUpTo(…, max) > max`), dưới khoá org, trước event; vi phạm unique bắn trước nên `409 already_member` thắng `422`; đầy → `422 quota_exceeded` (`errors[0].code = 'tenancy.seats'`) và `tenancy_seat_limit_denied_total{source}` (metric ở tenancy, bên quyết định; spec §19 đổi tên theo đó). Adapter đọc snapshot, thiếu dòng → 503 (fail closed).
- **`down` của `…_usage_counters` từ chối khi còn bộ đếm** (usage không dẫn xuất lại được), nguyên tử với consume đang mở (khoá `ACCESS EXCLUSIVE` của `NO FORCE`).
- **Tách với 6A (R-X29):** 4B merge trước 6A nên chỉ ship dòng `files.storage_bytes` (`LIMIT`, `fallback` 1 GiB `FILES_STORAGE_FALLBACK_BYTES`); adapter `FileStorageLimit`, entry `integrations/files.ts`, dòng `OPTIONAL_BRIDGES` `entitlements-files`, kiểm lúc boot của files, ST-1…ST-4 và luật 20.8-d là của 6A.
- **Kiểm catalogue (R-X30):** dòng tính năng/gói chỉ có ở DB và dòng DB đã deprecate/retire mà code chưa là WARN (`entitlement_feature_unknown_to_code`, `entitlement_feature_deprecated_in_db`, `entitlement_plan_unknown_to_code`, `entitlement_plan_retired_in_db`) + `entitlements_catalogue_unknown_features_total`/`…_plans_total`; thiếu migration vẫn chặn boot; `ENTITLEMENTS_QUOTA_TIMEZONE` được kiểm bằng `date_trunc` ở Postgres lúc boot.
- **Dòng bộ đếm nóng:** khoá dòng giữ tới hết transaction của caller, kể cả ở nhánh `EXCEEDED` (M7); nhiều bộ đếm trong một transaction: theo thứ tự key tăng dần (I2); gọi consume gần cuối transaction ngắn; theo dõi p95 `entitlements_quota_consume_duration_seconds` (alert > 100 ms). Điểm mở rộng khi đo được: bộ đếm chia mảnh.
```

- [ ] **Step 2: ADR 0005**

`docs/adr/0005-multi-tenant-rls.md` — thêm sau mục "Cập nhật SP4 (4A)":
```markdown
## Cập nhật SP4 (4B) (<ngày merge>)

- **Bảng tenant `usage_counters`** (RLS + FORCE, policy `usage_counters_tenant TO app_user`, `USING`/`WITH CHECK` trên `org_id`), neo bắc cầu tới `organizations` qua FK `RESTRICT` `org_id → org_entitlements(org_id)` (M5); hằng `ENTITLEMENTS_TENANT_TABLES_4B` ở `test/support/entitlements-catalog.ts`.
- **Grant theo cột:** `app_user` chỉ `UPDATE (used, version, updated_at)`; khoá tự nhiên `(org_id, feature_id, period_start)` bất biến với app.
- **Trigger INVOKER** `usage_counters_period_ck` (`BEFORE INSERT`, `SET search_path = pg_catalog, public`): chỉ đọc bảng global `entitlement_features`, nên không cần `SECURITY DEFINER`; tập definer không đổi.
- **Purge:** participant entitlements (`order = 100`) xoá `usage_counters` trước `org_entitlements`; quên câu nào thì purge fail to `23001`.
```

- [ ] **Step 3: Spec cha, spec SP3**

`docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`:
- §2 bảng context, dòng `| Entitlements |`: `UsageCounter (4B)` → `UsageCounter`; `` `entitlements.quota.reached` (4B; thay `` → `` `entitlements.quota.reached` (thay ``.
- §5 bảng race: dòng `| Vượt quota khi request song song | \`UPDATE … SET used=used+n WHERE used+n<=limit RETURNING\` |` thành `| Vượt quota khi request song song | \`INSERT … ON CONFLICT DO UPDATE SET used = used + n WHERE used + n <= limit RETURNING\` (một câu, trong transaction của caller; kỳ NONE dưới UNIQUE NULLS NOT DISTINCT) |`; thêm sau dòng `| Deadlock xuyên module | … |`: `| Vượt số ghế khi nhiều người vào org song song | khoá dòng org của MemberAdmission, đếm org_members sau khoá (port MemberSeatLimit, không bộ đếm thứ hai) |`.

`docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md` — §19, dòng `| Số ghế / giới hạn member theo gói | SP4 | …`: cột cơ chế thành `` `MemberAdmission` chạy dưới khoá org → port `MemberSeatLimit` (`@Optional()`, SP4 4B): đếm `org_members` sau khoá (không bộ đếm), đầy → `422 quota_exceeded` với `errors[0].code = 'tenancy.seats'`; `EntitlementInterceptor` ở bước 6 của pipeline (SP4 S4-D7) ``.

Run:
```bash
grep -c "(4B" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
grep -n "used+1 <= limit\|used + 1 <= limit" docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md
```
Expected: `0` và không dòng nào.

- [ ] **Step 4: Spec SP4 — ghi lệch có chủ đích của 4B**

`docs/superpowers/specs/2026-09-28-sp4-entitlements-design.md` — thêm đoạn cuối (sau "Sửa theo plan 4A: …"):
```markdown
Sửa theo plan 4B (R-X29 và lệch có chủ đích của plan; phần của review đã vào spec ở commit riêng): §19 metric ghế là `tenancy_seat_limit_denied_total{source}` (tenancy quyết định từ chối, port giữ đúng hình dạng `current()` của §9.6); §6.2 adapter ghế ở `infra/tenancy/` (mẫu `TenancyIdentityPortsModule`), kỳ → SQL ở `infra/sql/sql-usage-counter.repository.ts` (không `domain/quota-period.ts`); §9.2 consume trên tính năng deprecated bị từ chối trước SQL (`FeatureKindMismatchError`), `EXCEEDED.used` đọc lại bằng một câu đọc; §13.1 actor của `quota.reached`: user, `service` (`api_key:<id>`), `system` `entitlements.quotas`; §9.7, §20 ST-1…ST-4, §20.5 20.8-d, §21 hàng 4B (adapter dung lượng, `OPTIONAL_BRIDGES`, kiểm lúc boot của files) chuyển sang 6A theo R-X29 (4B merge trước 6A); §20.4 SM-1 phần "consume tới trần" trên image chuyển sang 7D (chưa route nào của boilerplate tiêu thụ QUOTA).
```

- [ ] **Step 5: README**

`docs/boilerplate/README.md` — trong mục "### Tính năng theo gói (entitlements)", thay gạch đầu dòng **Service** bằng ba gạch đầu dòng:
```markdown
- **Service:** `Entitlements.isEnabled/assertEnabled/limitOf/assertWithinLimit` trong org context. `assertWithinLimit` đòi caller **đếm dưới khoá tuần tự hoá** mọi đường thêm (check-then-insert không khoá là sai); tài nguyên không có khoá sẵn dùng `QUOTA` kỳ `NONE`.
- **Quota (`QUOTA`):** `Quotas.consumeOrThrow(key, n)` (hoặc `consume` trả `CONSUMED`/`EXCEEDED`) **trong cùng `UnitOfWork.run` với side effect**: rollback trả lại quota, `@Idempotent()`/Inbox của bạn phủ luôn quota; consume trong transaction riêng là dùng sai. Kỳ `MONTH` reset ở đầu tháng theo `ENTITLEMENTS_QUOTA_TIMEZONE`, không cron; kỳ `NONE` là phân bổ: `releaseAllocation(key, n)` khi xoá bản ghi. `release(receipt)` trả đúng lần tiêu thụ (cả khi đã sang tháng). Gọi consume **gần cuối** transaction ngắn: dòng bộ đếm bị khoá tới hết transaction, kể cả khi kết quả là `EXCEEDED` (kết thúc transaction ngay khi nhận nó). Tiêu thụ nhiều quota trong một transaction: **theo thứ tự key tăng dần**, sau mọi khoá của bạn (tránh deadlock giữa hai request). Hết quota → `422 quota_exceeded`, key ở `errors[0].code`; chạm trần phát `entitlements.quota.reached` (audit). `amount` phải là số nguyên ≥ 1 (sai → 500 lỗi lập trình).
- **Ghế (`tenancy.seats`):** đặt `{ max: n }` cho từng gói trong `src/app.plans.ts` (mặc định không giới hạn, `minimum: 1`). Chấp nhận lời mời/join link khi đầy → `422 quota_exceeded` (`errors[0].code = 'tenancy.seats'`); lời mời đang chờ, org API key, support grant không chiếm ghế; hạ gói không gỡ ai, chỉ chặn thêm. `files.storage_bytes` (byte, mặc định 1 GiB) là trần dung lượng của module files (SP6 6A).
```
và trong "### Nâng cấp lên SP4" thêm gạch đầu dòng:
```markdown
- 4B: migration `…_usage_counters` thêm bảng bộ đếm và dòng `files.storage_bytes`. Pod chạy code cũ khởi động lại sau migration vẫn boot (R-X30): tính năng hoặc gói chỉ có ở DB chỉ là WARN `entitlement_feature_unknown_to_code`/`entitlement_plan_unknown_to_code` + metric, tính năng đó bị bỏ qua, org ở gói pod chưa biết nhận `503` tới hết rollout (thêm gói ở bản N, bán ở bản N+1). Thiếu migration (code có mà DB thiếu) vẫn chặn boot: chạy migrate Job trước rollout. Rollback `…_usage_counters` bị từ chối khi còn bộ đếm (usage không dựng lại được); nếu chấp nhận mất toàn bộ usage: `TRUNCATE usage_counters;` bằng `app_owner` (chủ bảng do migration tạo; RLS không áp cho `TRUNCATE`; `app_user` không có quyền này; khoá `ACCESS EXCLUSIVE` ngắn) rồi chạy lại rollback.
```

- [ ] **Step 6: Chú thích `OPTIONAL_BRIDGES`**

`src/boilerplate.modules.ts` — chú thích trên `OPTIONAL_BRIDGES`: `/** Cầu nối tuỳ chọn (R-X13). Rỗng ở 7A; SP4 4B thêm dòng \`entitlements-files\`. Entry của cầu nối chỉ import từ đây. */` thành `/** Cầu nối tuỳ chọn (R-X13). Rỗng ở 7A và 4B; SP6 6A thêm dòng \`entitlements-files\` (R-X29: 4B merge trước 6A). Entry của cầu nối chỉ import từ đây. */`. Không đổi code.

- [ ] **Step 7: Kiểm và commit**

Run:
```bash
pnpm exec prettier --write src/boilerplate.modules.ts
pnpm typecheck
git add docs/adr docs/superpowers/specs docs/boilerplate/README.md src/boilerplate.modules.ts
git commit -m "docs(entitlements): quotas, seats and the 4B migration in ADR 0018/0005, the parent and SP3 specs, the SP4 deviations and the README"
```

---

### Task 16: Kiểm chứng toàn nhánh — sẵn sàng cho PR (controller push và mở PR)

**Files:** không sửa file nào ngoài lỗi mà bước kiểm phát hiện (mỗi lỗi sửa ở task gốc của nó, commit riêng).

- [ ] **Step 1: Rebase lên `main` mới nhất, kiểm timestamp migration**

Run:
```bash
git fetch origin
git rebase origin/main
ls src/migrations/entitlements
pnpm vitest run --project unit test/unit/migrations
```
Expected: rebase sạch (xung đột văn bản với 4C/6A/6B merge trong lúc làm: giải theo luật của plan kia — 4C chèn câu override **giữa** hai câu của `ENTITLEMENTS_PURGE_STATEMENTS`, thêm hằng `_4C` cạnh `_4B` — rồi chạy lại toàn bộ bước dưới); `…_usage_counters` có timestamp lớn hơn migration mới nhất của vùng boilerplate trên `main`; nếu không, sinh lại bằng CLI (`migration:create --blank --path src/migrations/entitlements --name usage_counters`), chép thân, xoá file cũ, chạy lại test của Task 3–4. Nếu 4C đã merge trong lúc làm: làm Step 4 của Task 4 (ca override).

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
Expected: mọi lệnh xanh; `hardcode-scan.spec.ts`, `migration-scan.spec.ts`, `migration-order.spec.ts`, `event-flags.spec.ts` xanh; `upstream:check --self` xanh (mọi file mới dưới tiền tố đã phân vùng); `.env.example` và `openapi.json` không đổi so với commit (đã sinh lại ở Task 9, Task 11); diff `package.json`, `pnpm-lock.yaml`, `.upstream/zones.json` rỗng; không file nào của `.github/codeql/accepted-findings.txt` bị sửa (dòng `rule path:line` vẫn khớp).

- [ ] **Step 3: Test có DB, chaos, prod-like**

Run:
```bash
pnpm test:int
pnpm test:chaos
pnpm test:smoke
```
Expected: mọi project xanh (`integration` gồm cả `test/e2e/**`); smoke như Task 14. Chạy `quotas-races.spec.ts` và `seats.e2e.spec.ts` thêm hai lần (race ×50 phải xanh ổn định); ghi thời gian chạy hai file này vào mô tả PR.

- [ ] **Step 4: Rà diff lần cuối**

Run:
```bash
git log --oneline origin/main..HEAD
git diff origin/main --stat
grep -rn "TODO\|FIXME\|it.only\|describe.only\|as any\|eslint-disable\|oxlint-disable" $(git diff origin/main --name-only -- src test) || true
git grep -n "modules/files" -- src/modules/entitlements src/boilerplate.modules.ts || true
```
Expected: mỗi task có ít nhất một commit conventional; không `TODO`/`.only`/`as any`/tắt lint mới; không file spike (`test/integration/spike-sp4b/`) nào được track; không import `modules/files` nào (R-X29; chú thích có chữ "files" trong `boilerplate.modules.ts` là chấp nhận).

- [ ] **Step 5: Sẵn sàng cho PR**

Nhánh `sp4b-usage-quota-seats` đã rebase lên `origin/main`, mọi kiểm ở Step 1–4 xanh trên máy local. Mô tả PR (controller dùng): nội dung theo task, lệnh kiểm chứng và kết quả thật, số đo image (ADR 0013), thời gian chạy hai file race, tách phạm vi R-X29 (ST-1…ST-4, 20.8-d, adapter dung lượng sang 6A), SM-1 phần consume sang 7D, trạng thái ca DB-4 override (viết hay carry sang 4C). **Dừng ở đây**: không push, không mở PR — controller push nhánh, mở PR "SP4 4B: usage counters, quotas and seats" và chờ mọi job CI xanh (race/timing chạy trên Linux CI).

---
## Chỗ đụng code của plan trước và lệch có chủ đích

**Code của 3A/3C/4A mà 4B sửa:** `entitlements/application/catalogue-check.ts`, `ports/catalogue.reader.ts`, `infra/sql/sql-entitlement-catalogue.reader.ts`, `application/entitlements-metrics.ts` (R-X30, múi giờ; Task 2); `entitlements/features.ts`, `constants.ts`, `errors.ts`, `infra/sql/entitlements-purge.sql.ts` (Task 3); `ports/catalogue.reader.ts`, `infra/sql/sql-entitlement-catalogue.reader.ts`, `application/catalogue-check.ts` (`id`, `featureId`; Task 5); `events.ts`, `application/entitlements-metrics.ts`, `entitlements.module.ts`, `index.ts` (Task 5, 6, 12); `domain/effective-value.ts`, `http/schemas.ts`, `http/org-entitlements.controller.ts`, `http/entitlements-http.module.ts` (Task 9); `tenancy/application/member-admission.ts` (kiểm ghế sau INSERT; chú thích chỗ đặt của 3C thay bằng lời gọi), `tenancy/application/tenancy-metrics.ts` (+1 counter, `AcquisitionResult` + `seat_limit`), `tenancy/application/invitation.service.ts`, `tenancy/application/invite-link.service.ts` (nhánh metric `seat_limit`), `tenancy/http/invitation-tokens.controller.ts`, `tenancy/http/invite-link-tokens.controller.ts` (`@ApiProblems`), `tenancy/index.ts` (+export) (Task 11); `src/boilerplate.modules.ts` (chỉ chú thích, Task 15); test support `entitlements-catalog.ts` (thêm hằng `_4B`, không sửa hằng 4A), `entitlements-fixtures.ts` (thêm một key, bốn gói), `entitlements-seed.ts` (thêm helper), `entitlements-races.ts` (helper chung `holdInOrg` export, chữ ký `holdEntitlementRow` giữ nguyên); test của 4A đổi kỳ vọng vì phép so trả `{ errors, warnings }` và tập tính năng gộp lớn lên (`catalogue-diff.spec.ts`, `catalogue-check.spec.ts` integration, `entitlements-service.spec.ts`, `org-entitlements.e2e.spec.ts`, `entitlements.smoke.spec.ts`, `schemas.spec.ts`, `errors.spec.ts`, `chaos/entitlements-outages.spec.ts`).

**Lệch có chủ đích (mỗi dòng có lý do ở task; phần đã vào spec ở commit `docs(spec): SP4 amendments from the 4B plan review`, phần còn lại Task 15 ghi):**
1. `down` của `…_usage_counters` từ chối khi còn bộ đếm (đã vào spec §7.7): usage không dẫn xuất lại được; luật SP3 §6.13 (Task 4).
2. Metric ghế `tenancy_seat_limit_denied_total{source}` thay `entitlements_seat_limit_denied_total` (spec §19): tenancy là bên quyết định từ chối; port giữ đúng hình dạng `current()` của §9.6 (Task 11).
3. Adapter ghế ở `entitlements/infra/tenancy/` (spec §6.2: `application/member-seat-limit.adapter.ts`): mẫu `TenancyIdentityPortsModule` của repo (File Structure).
4. Không `domain/quota-period.ts` chứa SQL: miền giữ `periodOf` thuần, SQL theo kỳ ở `infra/sql/` (File Structure).
5. Consume trên tính năng deprecated bị từ chối trước SQL bằng `FeatureKindMismatchError`; release vẫn được (Task 6–7).
6. `EXCEEDED.used` đọc lại bằng một câu `SELECT` cả ở nhánh `amount > max` (Task 6).
7. Actor của `quota.reached` theo principal (Review Focus 5).
8. Kỳ của bộ đếm từ `now()`; `updated_at` từ `clock_timestamp()` (Global Constraints).
9. Theo R-X29: không adapter dung lượng, không `integrations/files.ts`, không dòng `OPTIONAL_BRIDGES`, không kiểm lúc boot của files; ST-1, ST-2, ST-4 sang 6A, **ST-3 và luật 20.8-d cũng sang 6A** (mục 5).
10. SM-1 phần "consume tới trần → 422" trên image sang 7D (Task 14).
11. R-X30 mở rộng cho **gói** chỉ có ở DB và chiều "DB đã deprecate/retire mà code chưa" (đã vào spec §8.3; lý do ở Task 2).

---

## Self-review

### 0. Sửa theo review plan 4B (2026-10-05, phán quyết controller)

| Finding | Sửa | Task | Test |
|---|---|---|---|
| C1 (R-X30) | Task mới ngay sau spike: `entitlementsCatalogueDiff` trả `{ errors, warnings }`; dòng chỉ có ở DB → WARN `entitlement_feature_unknown_to_code` + `entitlements_catalogue_unknown_features_total`; DB deprecated mà code chưa → WARN `entitlement_feature_deprecated_in_db` (chiều ngược vẫn lỗi); gói chỉ có ở DB → **WARN** `entitlement_plan_unknown_to_code` + `entitlements_catalogue_unknown_plans_total` (lý do ở Task 2: đánh giá fail closed, không thứ tự deploy nào cứu được nếu giữ lỗi); DB retired mà code chưa → WARN `entitlement_plan_retired_in_db`; bản đồ `key → id` chỉ nạp khi `errors` rỗng và chỉ key code biết | 2, 5, 15 | `catalogue-diff.spec`, `catalogue-check.spec` (unit), `catalogue-check.spec` (integration: `cc.ghost`, `cc_extra`, deprecated/retired ở DB, `featureId('cc.ghost')`) |
| I1 | Kiểm ghế ngay sau `INSERT org_members`, trước `publish`, dưới khoá org: `countUpTo(undefined, m) > m` (và `m = 0`) → ném, rollback cả thu hồi grant; unique bắn trước nên `409 already_member` giữ | 11 | `seat-limit-port.e2e` (I1: join + accept của member đã có → 409), SE-* kiểm lại với chỗ đặt mới (Task 12) |
| I2 | Nhiều bộ đếm trong một transaction: thứ tự key tăng dần, sau mọi khoá của caller (spec §3.6, README) | 8, 15 | `quotas-races` I2 ×50 |
| I3 | E-11 tất định hai chiều (consume chèn trước → purge `23001` → retry `purged`; purge xoá gốc chưa commit → consume `23503`); E-15 ép xen kẽ bằng cửa (gate) hai chiều trên code thật | 8 | `quotas-races` |
| M1 | `23503` → `23001` cho xoá dòng còn tham chiếu `RESTRICT` (spec §7.2, §7.7, DB-3, DB-4) | spec | `usage-counters-db` (DB-3 `23001`) |
| M2 | E-6b (admission ∥ hạ gói/override ghế → `OVER_LIMIT`, như E-4) | spec, mục 2 | SE-2 (tuần tự) |
| M3 | `quota.reached` phát ở mỗi lần chuyển sang "chạm trần", kể cả sau `release`; không khử trùng | 5, 7, 15 | `quotas.spec` (M3) |
| M4 | Lý do `UnitOfWork` của `OrgEntitlementsQuery`: chỉ "cùng `now()`" đúng dưới READ COMMITTED | File Structure, 9 | — (lý do, không hành vi) |
| M5 | README: lùi khi còn bộ đếm = `TRUNCATE usage_counters` bằng `app_owner` (chủ bảng do migration tạo; RLS không áp cho `TRUNCATE`; `app_user` không có quyền `TRUNCATE`, DB-1 khẳng định) | 15 | `usage-counters-db` DB-1 (`trunc: false` cho `app_user`) |
| M6 | Kiểm `date_trunc('month', now(), ENTITLEMENTS_QUOTA_TIMEZONE)` lúc boot; `22023` → boot fail có tên | 2 | `catalogue-check.spec` (unit) |
| M7 | Nhánh `EXCEEDED` giữ khoá dòng tới khi caller kết thúc (spec §9.2, chú thích `Quotas`, README, ADR) | 6, 15 | — (tài liệu; QU-7 phủ hành vi khoá) |
| M8 | `result="seat_limit"` của `tenancy_invitations_total`, `tenancy_invite_link_joins_total` | 11 | `seat-limit-port.e2e` (otel) |
| M9 | Chu trình purge ↔ caller giữ `FOR KEY SHARE` trên `organizations` là chấp nhận có tên (spec E-11) | spec | — (chấp nhận có tên) |
| Actor `api_key` → `service` | Giữ; ghi là quy ước liên SP cho audit 6B (mục 5) | 6 | Review Focus 5 |

### 1. Phủ spec (mọi hạng mục 4B: §21 hàng 4B, tiêu chí 3/4/5/7 phần R-X30/8/10/11/12/13/15, §22 dòng 4B)

| Hạng mục spec | Task | Test |
|---|---|---|
| S4-T2 (§5) — spike, giữ làm hồi quy QU-2 | 1, 3, 5, 8 | spike (không commit) + `usage-counters-db` (SQL), `usage-counter-repository` (qua `Db.execute`), `quotas-races` QU-2 ×50 |
| Tiêu chí 7 + §8.3 (R-X30): DB mới hơn code là WARN, thiếu migration là lỗi; kiểm múi giờ | 2 | `catalogue-diff.spec`, `catalogue-check.spec` (unit + integration) |
| §7.5 `usage_counters`: cột, PK, 2 FK `RESTRICT`, `UNIQUE NULLS NOT DISTINCT`, 2 `CHECK`, trigger, RLS/FORCE/policy, grant theo cột, 2 index | 3 | `usage-counters-db` (DB-1, DB-3), `rls-catalog`, smoke |
| §7.6 chuẩn hoá BCNF | 3 | `normalization-inventory` |
| §7.7 dòng 4B (up, khoá, down từ chối khi còn bộ đếm) | 3, 4 | `migrations.spec`, `usage-counters-down` (a)(b)(c), (d) nếu 4C đã merge, `migration-scan` |
| §8.1 `files.storage_bytes` | 3 | `usage-counters-db`, `entitlements-service`, `org-entitlements.e2e`, smoke |
| §9.1 receipt | 5, 6 | `quotas` (unit + integration) |
| §9.2 consume (tiền điều kiện, `amount > max`, một câu, kỳ, `featureId` từ boot, `quota.reached`, M7 khoá ở nhánh EXCEEDED) | 5, 6 | `quota.spec`, `quotas.spec`, `usage-counter-repository` |
| §9.3 release, `releaseAllocation`, underflow | 5, 7 | `quotas.spec` (QU-7 tuần tự), `quotas-races` (QU-7) |
| §9.4 `QuotaState` | 9 | `schemas.spec`, `org-entitlements.e2e` (Review Focus 3) |
| §9.6 ghế: port, kiểm sau INSERT (I1), thứ tự ưu tiên lỗi, `422`, port vắng, người tạo, api + worker | 11, 12 | `seat-limit-port.e2e`, `seats.e2e` (SE-1 ×50, SE-2, Review Focus 4, thiếu dòng), `seat-limit-di` |
| §9.7 trần dung lượng | — | **6A** (R-X29); 4B chỉ dòng tính năng (Task 3) |
| §12.1 `used`/`state`/kỳ, một transaction đọc | 9 | `org-entitlements.e2e`, `schemas.spec` |
| §13.1 `quota.reached` (cờ, aggregate, M3) | 6, 7 | `quotas.spec`, `event-flags.spec` (EV-10) |
| §13.2 purge xoá `usage_counters` trước dòng gốc | 3 | `usage-counters-db` (R-1), `quotas-races` (E-11) |
| §3.6 thứ tự khoá, nhiều bộ đếm theo key tăng dần (I2) | 6, 8, 15 | `quotas-races` (E-15, I2) |
| §14 không env mới; `FILES_STORAGE_FALLBACK_BYTES` | 3, 16 | `pnpm env:example` không đổi `.env.example` |
| §15 `quota_exceeded`, `usage_counters_period_ck`, `QuotaReleaseUnderflowError` | 3, 6, 7, 11 | `errors.spec`, `quotas.spec`, `seat-limit-port.e2e`, `quota-route.e2e` |
| §17 E-1, E-2, E-3, E-4, E-6, E-6b, E-10, E-11, E-14, E-15 | 5, 6, 8, 11, 12 | bảng race mục 2 |
| §18 F-1, F-3 (R-X30), F-8, F-9 | 2, 6, 7, 13 | `chaos/entitlements-outages`, `catalogue-check.spec`, `quotas.spec` |
| §19 metric (consume, duration, ghế, `seat_limit`, catalogue unknown) ; span; log | 2, 6, 7, 11 | `quotas.spec`, `catalogue-check.spec`, `seat-limit-port.e2e` (otel) |
| §20 HT-2c | 9 | `org-entitlements.e2e` |
| §20 HT-5 | 10 | `quota-route.e2e` |
| §20 ST-1…ST-4 | — | **6A** |
| §20.4 SM-1 phần 4B | 14 | `entitlements.smoke`; phần consume → 7D |
| §20.5 20.8-a phủ port ghế; 20.8-d | 11; — | `pnpm arch`; 20.8-d → **6A** |
| §22.1 P1, P3 | 15 | `grep -c "(4B"` = 0 |
| §22.2 T5, L1 | 11, 15 | ADR 0018, spec SP3 |
| Tiêu chí 12, 13 | 9, 11, 14, 16 | `git diff … package.json pnpm-lock.yaml`, ADR 0013, `openapi.json` |

### 2. Race của 4B → cơ chế → test

| # | Tình huống | Cơ chế | Test (task) |
|---|---|---|---|
| E-1 | N consume song song vượt trần | một câu `INSERT … ON CONFLICT DO UPDATE … WHERE used + n <= max`: khoá dòng, `WHERE` trên bản mới nhất | QU-1 ×50 (8) |
| E-2 | Hai consume đầu tiên của kỳ cùng chèn | `usage_counters_period_uq` (`NULLS NOT DISTINCT`) | QU-2 ×50 (8), hồi quy SQL (3, 5) |
| E-3 | Consume quanh ranh giới tháng | kỳ từ `now()` của DB, múi giờ config (kiểm ở DB lúc boot, M6); không cron | QU-3 (5, 6) |
| E-4 | Hạ gói đồng thời với consume | trần đọc trong transaction; đổi sau xếp "sau"; `OVER_LIMIT` hợp lệ | QU-8 (8), Review Focus 3 (9) |
| E-6 | N + k admission song song khi còn N ghế | khoá dòng org tuần tự hoá `MemberAdmission`; INSERT rồi `countUpTo(…, m) > m` dưới khoá (I1) | SE-1 ×50 (12), port giả (11) |
| E-6b | Admission đồng thời hạ gói/override ghế | như E-4: admission đọc trần trong transaction; `assign` chỉ khoá `org_entitlements`; `OVER_LIMIT` hợp lệ | SE-2 (12, tuần tự; lập luận như E-4) |
| E-10 | Hai consume cùng vượt ngưỡng `quota.reached` | tuần tự trên khoá dòng: mỗi lần chuyển sang "chạm trần" đúng một consume (M3) | QU-6 ×50 (8), M3 (7) |
| E-11 | Purge đua consume | consume chèn trước → purge `23001`, job retry; purge xoá gốc trước → consume `23503`; chu trình với caller giữ `FOR KEY SHARE` trên `organizations` → `40P01` có tên (M9) | E-11 tất định hai chiều + ×50 (8) |
| E-14 | Release đua consume | cùng khoá dòng; `WHERE used >= n` + `CHECK` | QU-7 ×50 (8) |
| E-15 | Deadlock assign ↔ consume | consume chỉ `FOR KEY SHARE` trên `org_entitlements` (tương thích `FOR NO KEY UPDATE`) | E-15 ép xen kẽ hai chiều + ×50 (8) |
| I2 | Hai transaction tiêu thụ hai bộ đếm | thứ tự key tăng dần (spec §3.6) | I2 ×50 (8) |
| (mới) | `down` của 4B đua consume đang mở | `NO FORCE` lấy `ACCESS EXCLUSIVE` tới hết lô | `usage-counters-down` (b) (4) |
| (mới) | Pod cũ khởi động lại sau migration 4B | R-X30: dòng chỉ có ở DB là WARN | `catalogue-check.spec` (2) |
| E-17 | Upload ∥ hạ gói dung lượng | — | **6A** |

### 3. Quét chỗ trống

Không có "TBD", "TODO", "tương tự Task N", hay bước code không có code. Dấu `<…>` là **dữ liệu của lần chạy**: `<ts>` của migration (CLI sinh; code/test tìm theo hậu tố `_usage_counters`), ba ô kết quả spike (Task 1 Step 3), ngày và số đo image (Task 14 Step 3), ngày merge trong ADR (Task 15). Hai nhánh theo thứ tự merge có hướng dẫn tường minh: ca DB-4 override (Task 4 Step 4) và xung đột rebase với 4C ở `ENTITLEMENTS_PURGE_STATEMENTS` (Task 16 Step 1).

### 4. Nhất quán tên và kiểu

`CatalogueDiff`, `CatalogueWarning` (4 event), `entitlementsCatalogueDiff → { errors, warnings }`, `EntitlementCatalogueReader.probeTimezone`, `EntitlementsMetrics.catalogueUnknownFeatures/catalogueUnknownPlans` (Task 2) dùng nguyên ở Task 5 (`errors.length === 0` trước khi nạp `ids`). `QuotaReceipt`, `ConsumeResult`, `QuotaPeriod`, `periodOf`, `reachedLimit` (Task 5) dùng nguyên ở Task 6–10; `UsageCounterRepository` (`consume`, `usedNow`, `release`, `currentUsage`), `ConsumedCounter`, `CurrentUsage`, `monthPeriodStartSql` (Task 5); `EntitlementCatalogueCheck.featureId` (Task 5) ở Task 6–7; `Quotas.consume/consumeOrThrow` (Task 6), `release/releaseAllocation` (Task 7); `QuotaReachedEvent`, `USAGE_COUNTER_AGGREGATE` (Task 6); `QUOTA_STATES`/`QuotaState`, `OrgEntitlementsQuery.read()`, `orgEntitlementsOf(s, features, usage)` (Task 9); `MemberSeatLimit`, `SeatLimit` (Task 11) dùng nguyên ở Task 12; `MemberSeatLimitAdapter`, `EntitlementsTenancyPortsModule` (Task 12); metric `quotaConsume`, `quotaConsumeDuration` (Task 6), `seatLimitDenied`, `AcquisitionResult` + `'seat_limit'` (Task 11). Test support: `QUOTA_TZ`, `seedCounter`, `readCounters`, `CounterRow`, `periodStartOf` (Task 3), `holdInOrg` (export), `holdUsageCounter`, `holdUsageCounterInsert` (Task 8); gói fixture `metered`, `unmetered`, `solo`, `duo` và key `fixture.saved_reports` (Task 3) dùng nguyên ở Task 5–13. Tên của 4A/3C đối chiếu trên `main`: `Entitlements.limitOf`, `EntitlementCatalogueRegistry.feature/features/plans`, `quotaState`, `quotaExceeded`, `QuotaReleaseUnderflowError`, `FeatureKindMismatchError`, `EntitlementsContextError`, `EntitlementsVersionSkewError`, `UnknownPlanError`, `entitlementsSpan`, `EntitlementsMetrics`, `ENTITLEMENTS_PURGE_STATEMENTS`, `holdEntitlementRow`, `waitForBlocked`, `raceOnOrgLock`, `MemberRepository.countUpTo` (cap ≥ 1, trả `min(count, cap + 1)`), `MemberRepository.insert`, `TenancyMetrics`, `TenancyErrors.ALREADY_MEMBER` (`org_members_org_user_uq`), `TenancyErrors.ALREADY_IN_AN_ORG`, `BoilerplateFeatures.key`, `setOrgPlan`, `seedOrgEntitlement`, `PurgeOrgHandler.handle`.

### 5. Phán quyết trên chỗ spec mơ hồ (lý do — giá nếu sai)

1. **ST-3 và luật 20.8-d sang 6A cùng ST-1/2/4** — ST-3 import export của `modules/files` (chưa tồn tại), 20.8-d chỉ có nghĩa với `integrations/**` — giá: một test và một luật thêm ở plan khác.
2. **`down` từ chối khi còn bộ đếm** — giá: operator `TRUNCATE` bằng `app_owner` trước khi lùi (README, M5).
3. **Metric ghế ở tenancy** — giá: đổi tên một metric.
4. **SM-1 consume trên image sang 7D** — giá: một ca smoke ở 7D.
5. **Kỳ từ `now()`, `updated_at` từ `clock_timestamp()`** — giá: transaction bắc qua nửa đêm đầu tháng tính vào kỳ cũ (đúng E-3).
6. **Deprecated QUOTA: consume từ chối trước SQL, release được** — giá: đổi một nhánh.
7. **Actor `quota.reached` theo principal; `api_key` → `{ type: 'service', id: 'api_key:<publicId>' }`** — quy ước liên SP: audit của 6B và mọi event phát từ request của org API key dùng cùng dạng này (không phải user, không ném) — giá: đổi ánh xạ ở một hàm và báo 6B.
8. **`EXCEEDED.used` đọc bằng một câu `SELECT`** — giá: một câu đọc mỗi lần bị từ chối.
9. **Gói chỉ có ở DB là WARN** (controller giao kiểm, Task 2) — đánh giá không bao giờ sai (503/`UnknownPlanError`), giữ lỗi thì không thứ tự deploy nào tránh crash-loop ("code trước migration" fail ở chiều "in code, missing in the database") — giá nếu sai: một pod cũ phục vụ org ở gói mới bằng 503 thay vì không khởi động (đã là F-6).
10. **DB retired mà code chưa là WARN** (đối xứng với deprecated, controller chỉ chốt chiều deprecated) — `assign` đọc retired từ DB và trigger chặn gán mới — giá: đổi một nhánh của phép so.
11. **Thứ tự ưu tiên lỗi khi org đầy (I1):** controller ghi `already_member > already_in_an_org > quota_exceeded`; code thật kiểm `already_in_an_org` (chế độ `single`) **trước** INSERT và hàm `tenancy_count_user_memberships` đếm mọi membership kể cả của chính org này (`member-admission.ts` dòng 73–77, migration `…_acquisition` dòng 314–318), nên ở chế độ `single` member đã có nhận `already_in_an_org`, không `already_member`. Plan ghi đúng hành vi: `single`: `already_in_an_org` > `quota_exceeded`; `multi`: `already_member` > `quota_exceeded` (spec §9.6 đã ghi như vậy). Không đổi thứ tự của 3C — giá: nếu muốn `already_member` thắng ở `single`, 3C phải đổi hàm đếm (ngoài 4B).

### 6. Hạng mục 4B không đặt ở plan này (và nơi xử lý)

- Adapter `FileStorageLimitAdapter`, `integrations/files.ts`, dòng `entitlements-files` của `OPTIONAL_BRIDGES`, kiểm lúc boot của files, ST-1…ST-4, 20.8-d, E-17, tiêu chí 14 → **6A** (R-X29).
- SM-1 "consume tới trần → 422" trên image → **7D**.
- DB-4 "down của 4B fail `23001` khi còn override trên `files.storage_bytes`" → 4B nếu 4C đã merge lúc thực thi, không thì **4C** (Task 4 Step 4).
- Rủi ro "pod cũ crash-loop sau migration 4B" của bản trước: **đã đóng** bằng Task 2 (R-X30).

### 7. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **Placeholder `?` của MikroORM/knex giữ đúng thứ tự tham số trong câu consume có mảnh SQL động**, và TIMESTAMPTZ qua `z.coerce.date()` → `toISOString()` khớp đúng giá trị DB để `release` tìm lại dòng. Kiểm ở Task 5 (`usage-counter-repository.spec.ts`).
2. `FOR KEY SHARE` của FK không chờ `FOR NO KEY UPDATE` đang giữ (E-15 ép xen kẽ, Task 8); ca E-11 tất định không dựa vào việc người xin khoá tương thích chen hàng (dùng consume thật giữ transaction, purge chờ nó).
3. Trigger `BEFORE INSERT` chạy cả khi `ON CONFLICT` đi nhánh `DO UPDATE` (spike Task 1 (c)).
4. Postgres trả `22023` cho múi giờ lạ trong `date_trunc` (M6, Task 2 unit dùng lỗi giả; nếu SQLSTATE thật khác, ca integration boot với múi giờ hợp lệ vẫn xanh và chỉ hằng `PG_UNKNOWN_TIMEZONE` cần sửa).
5. Pool 10 kết nối đủ cho 6 consume song song + middleware (QU-1).

### 8. Phụ thuộc thật với plan khác

- **Cần đã merge:** 4A, 3C, 3B, 6.0, 7A. Không cần 3D, không cần 6A (R-X29).
- **Song song (W4):** 4C sửa cùng `ENTITLEMENTS_PURGE_STATEMENTS`, `entitlements-catalog.ts`, `schemas.ts`/`orgEntitlementsOf`, và giờ thêm `catalogue-check.ts` (4C chèn dòng tính năng nào thì đi qua phép so `{ errors, warnings }` của Task 2); plan merge sau rebase và chạy lại pipeline. 6B không đụng file của 4B, nhưng dùng quy ước actor ở mục 5.7.
- **Plan sau dùng tên của 4B:** 6A (`FILES_STORAGE_FALLBACK_BYTES`, dòng `files.storage_bytes`, `Entitlements.limitOf`, chú thích `OPTIONAL_BRIDGES`, R-X30 cho dòng tính năng của nó), 7D (`Quotas.consumeOrThrow`/`releaseAllocation`, thứ tự key khi tiêu thụ nhiều quota, ca smoke consume), SP6 6B audit (`entitlements.quota.reached` `audit: true`, actor `service`).
