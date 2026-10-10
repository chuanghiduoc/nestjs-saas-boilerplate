# 0018 — Entitlements: catalogue và gói trong code, bộ đếm theo kỳ, không cache ở v1

- Trạng thái: Chấp nhận (2026-10-01, controller chốt theo uỷ quyền "tự chốt, tự làm hết")
- Ngày: 2026-09-29
- Spec: [SP4](../superpowers/specs/2026-09-28-sp4-entitlements-design.md) r2 (chốt 2026-09-29, sửa §10.2 bước 2 sau review plan 4A); phán quyết R-X1…R-X24.

## Bối cảnh

Spec cha (§2 bảng context, §8 caching, Phụ lục C mục 4) đặt Entitlements là context riêng: gói, override theo org, quota, kiểm tính năng sau CASL. SP3 đã có mẫu "catalogue trong code + bảng tra cứu do migration ghi + kiểm bằng nhau lúc boot" cho quyền (`definePermissionCatalogue`, `@PermissionCatalogueContributor`, `CatalogueCheck`); SP4 dùng lại đúng mẫu đó cho tính năng và gói. SP5 (billing) cần một điểm nối duy nhất, có thứ tự, chạy cùng transaction với tiền (R-X1).

## Quyết định

| Mã | Quyết định | Lý do |
|---|---|---|
| S4-D1 | Tính năng khai báo trong code (`defineFeatureCatalogue`, `@FeatureCatalogueContributor`); DB có bảng tra cứu `entitlement_features` cho FK | Key có kiểu (sai là lỗi compile), cùng mẫu SP3 |
| S4-D2 | Gói khai báo trong code của dự án (`definePlanCatalogue`, `src/app.plans.ts`) tới module qua `EntitlementsModule.forApi(plans)`/`forWorker(plans)`; DB chỉ có bảng tra cứu `plans` (key, retired) | Gói là quyết định sản phẩm cần review; đổi giá trị không cần migration; một nguồn sự thật |
| S4-D3 | Mỗi tính năng có `fallback` bắt buộc; boot log liệt kê (gói, tính năng) dùng `fallback` | Merge upstream thêm tính năng không làm hỏng dự án |
| S4-D4 | Ba loại `FLAG`, `LIMIT` (module chủ tự đếm dưới khoá), `QUOTA` (entitlements giữ bộ đếm, 4B) | Không có bộ đếm thứ hai có thể lệch |
| S4-D5 | Kỳ quota `NONE`/`MONTH` theo `ENTITLEMENTS_QUOTA_TIMEZONE`, không cron reset (4B) | Ranh giới kỳ không có race |
| S4-D6 | Consume là một câu `INSERT … ON CONFLICT … DO UPDATE … WHERE used + n <= limit` trong transaction của caller (4B) | Vượt trần không thể xảy ra; rollback trả lại quota |
| S4-D7 | Kiểm tính năng ở route là interceptor route-scoped `EntitlementInterceptor` (gắn bởi `requireEnabled`) | Nest chạy mọi guard trước mọi interceptor: luôn sau `PoliciesGuard`, bên trong `OrgScope` (spike S4-T1) |
| S4-D8 | Không cache entitlement ở v1 | Một câu theo PK; cache chỉ bật khi đo được (mục dưới) |
| S4-D9 | Mọi org có đúng một dòng `org_entitlements`: participant trong transaction tạo org + subscriber dự phòng `tenancy.org.created` + backfill; thiếu dòng → 503 | Không cửa sổ "org chưa có gói", không fallback ngầm |
| S4-D10 | `PlanAssignments.assign` là hợp đồng duy nhất với SP5: trong UoW của caller, khoá `FOR NO KEY UPDATE`, kết quả có tên (`APPLIED`/`UNCHANGED`/`STALE`/`REJECTED_RETIRED`), lỗi có tên trước câu ghi đầu tiên, hiệu lực lúc commit | Gói và tiền nguyên tử; SP5 `switch` vét cạn, không rollback tiền vì gói |
| S4-D11 | Lệnh mới nhất thắng; billing khẳng định lại gói mỗi kỳ đã trả (R-X18) | Gói không lệch giá đang trả quá một kỳ |
| S4-D12 | Override thay thế giá trị gói cho đúng tính năng, có hạn tuỳ chọn (4C) | Một luật ưu tiên `OVERRIDE > PLAN > FALLBACK` |
| S4-D13 | Hạ gói không xoá dữ liệu; vượt trần là `OVER_LIMIT` hợp lệ | Không mất dữ liệu không đảo được |
| S4-D14 | Lỗi dùng mã core `feature_not_in_plan` (403), `quota_exceeded` (422), key ở `errors[0]` (`path: "feature"`) | Không đổi `core/errors` |
| S4-D15 | Route admin dùng `@PlatformStaffAction()` của 3D (4C) | Một gate cho mọi route admin |
| S4-D16 | `entitlements.quota.reached` chỉ phát khi tiêu thụ thành công chạm trần (4B) | Không spam event |
| S4-D17 | Quyền mới `entitlements.read` (`requires: ['org.read']`, ADMIN + MEMBER) | Frontend của member cần biết tính năng bật |
| S4-D18 | Không có API tenant nào ghi entitlement | Đổi gói chỉ qua billing |
| S4-D19 | Service admin mở `OrgScope` không qua membership sau `@PlatformStaffAction()` (4C) | Nhân viên không phải member |
| S4-D20 | Cờ event tường minh `audit: true`, `webhook: false` (R-X3; thêm khi 6.0 có cờ) | Đổi gói phải audit; webhook là hợp đồng công khai |
| S4-D21 | Dung lượng file là `LIMIT` qua port `FileStorageLimit` của SP6 (4B) | Một bộ đếm, ở module chủ |
| S4-D22 | Catalogue gói và migration khởi đầu ở vùng template (`src/plans.example.ts`, `src/migrations/example/`) | Upstream không ghi vào vùng dự án |

Ở 4A: kiểm bằng nhau code ↔ DB là `EntitlementCatalogueCheck` (`onModuleInit`, api và worker: worker lệch catalogue bị từ chối trước khi consume job); kiểm vị trí `requireEnabled` là `EntitlementRouteInventory` (`onApplicationBootstrap`, chỉ api, cùng matcher `classifyTenantHandler` của tenancy).

## Cache (khi đo được là cần)

- v1 không cache: mỗi `Entitlements.*` đọc một câu snapshot theo PK; interceptor đọc một lần cho mọi key của route; không memo trong CLS.
- Điều kiện bật: p95 `entitlements_snapshot_read_duration_seconds` hoặc số câu snapshot/giây đo bằng k6 ở 600 RPS vượt ngân sách API đọc p95 < 200 ms.
- Thiết kế khi bật (plan riêng): Redis riêng `REDIS_CACHE_URL` (khai báo secret), khoá `{ns}:entitlements:v{SCHEMA}:{orgId}` có version, TTL ≤ 60 s có jitter; sau commit ghi bia mộ `{ version, tombstone }` (không `DEL`); đọc trượt → DB → ghi lại bằng Lua chỉ khi version mới ≥ version đang có.
- Không bao giờ cache: bộ đếm quota, câu đọc trong `Quotas.consume`, câu khoá của `PlanAssignments.assign`, API admin.
- Không dùng `cache-manager` + `@keyv/redis`: `wrap`/`set` không so version khi ghi lại (không chặn được ghi đè bản cũ) và thêm client Redis thứ hai.

## Hợp đồng với tenancy (sổ export L1)

- 4A thêm vào `modules/tenancy/index.ts`: `OrgCreationParticipant`, `OrgCreationParticipantContributor`, `OrgCreationParticipantRegistry`, `classifyTenantHandler`, `type OrgRouteKind`. `onOrgCreated(orgId, actor)` mang actor của thao tác tạo org (event `plan.changed` của participant cần nó).
- 4A dùng: `OrgPurgeParticipant`, `OrgPurgeParticipantContributor`, `PermissionCatalogueContributor`, `definePermissionCatalogue`, `OrgCreatedEvent`. 4C sẽ dùng `@PlatformStaffAction()` (3D).
- Registry `order` purge: entitlements = 100 (`ENTITLEMENTS_PURGE_ORDER`, addendum 3D §A4), trước tenancy core (1000).
- 4B thêm vào `modules/tenancy/index.ts`: `MemberSeatLimit`, `type SeatLimit` (port ghế, `@Optional()` trong `MemberAdmission`); entitlements cài bằng `EntitlementsTenancyPortsModule` (`@Global`, api + worker). 4B dùng `MemberAdmission` không đổi chữ ký.

## Phương án đã loại

- Gói trong DB sửa qua admin API: thay đổi không review, môi trường lệch nhau, cần version hoá gói.
- Giá trị gói nhân bản vào DB: mỗi lần chỉnh giới hạn phải viết migration khớp tay.
- Guard route-scoped + luật thứ tự decorator: đúng nhưng bắt developer nhớ một luật vô hình.
- Cache L1 trong process: không xoá được giữa pod, nâng gói xong vẫn bị chặn tới hết TTL.
- Stack `cache-manager`: không so version khi ghi lại.
- Subscriber của billing gán gói: tiền và gói không nguyên tử.
- Gán gói hẹn ngày (`effectiveAt`): thêm bảng lịch và một nguồn sự thật (R-X1).

## Hệ quả

- Dự án đổi giá trị gói bằng sửa code, không migration.
- Thêm gói ở bản N, bán ở bản N+1: pod cũ trả 503 (`EntitlementsVersionSkewError`) cho org ở gói nó chưa biết (F-6); `assign` không phụ thuộc giá trị gói hiện tại nên billing vẫn chuyển gói được.
- Đổi `ENTITLEMENTS_QUOTA_TIMEZONE` giữa kỳ làm kỳ quota chạy lại từ 0 (4B).
- 4B/4C mở rộng bảng (`usage_counters`, `org_entitlement_overrides`) và câu snapshot.

## Nguồn

Spec SP4 r2 (kèm sửa sau chốt: §10.2 bước 2, §8.3, §19), phán quyết R-X1…R-X24, spec SP3 r8, addendum 3D.

## Kết quả spike (plan 4A)

Chạy trên nhánh của plan 4A (sau khi 3A merge), hạ tầng Testcontainers của repo (Postgres 18, PgBouncer, Redis, Mailpit), Nest 12.1, Express 5.2.1. S4-T2 thuộc 4B (review money-security r1 đã chạy đạt trên PG 18.6; 4B giữ làm test hồi quy QU-2).

| # | Câu hỏi (spec §5) | Kết quả | Bằng chứng |
|---|---|---|---|
| S4-T1 | Interceptor route-scoped chạy sau `PoliciesGuard` bất kể thứ tự decorator, và bên trong `OrgScope.run` của `OrgScopeInterceptor` | Đạt: 4/4 PASS (member thiếu `org.delete` → 403 `forbidden`, interceptor không chạy, ở cả hai thứ tự decorator; owner → `interceptorOrg` = `sqlOrg` (`app_current_org()`) = org trên path, `via: MEMBERSHIP`). Hệ quả: `EntitlementInterceptor` không tự mở `OrgScope` (không cần fallback §5) | spike `interceptor-scope.e2e.spec.ts` (không commit); giữ thành test HT-1 ở Task 10 |
| S4-T3 | Participant chạy trong transaction tạo org, sau 3 role hệ thống, trước `MemberAdmission`, trong `OrgScope(newId)`; ném → không có org | Đạt: 2/2 PASS (hook thấy `inTransaction() = true`, `ctx.orgId()` = id org mới, `org_members` = 0; dòng `fixture_org_items` có FK tới `organizations` chèn trước COMMIT dưới FORCE RLS và commit cùng org, `organizations_bootstrap_ck` vẫn đạt; hook ném → 500 và không còn org) | spike `org-creation-hook.e2e.spec.ts` (không commit); giữ thành test ở Task 2 |

## Kết quả spike (plan 4B)

Chạy trên nhánh `sp4b-usage-quota-seats` (sau khi 4A, 3C, 3D merge), Postgres 18 của `docker/images.env` (`postgres:18.6`) qua Testcontainers, bảng `spike_counters` cùng hình dạng `usage_counters` (spec §7.5) tạo bằng `app_owner` trong một transaction ROLLBACK.

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| S4-T2 (a) | `UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)` là arbiter của `ON CONFLICT` khi `period_start IS NULL`; `DO UPDATE … WHERE used + EXCLUDED.used <= $4` nhận tham số | Đạt: 2/2 PASS (kỳ `NULL`: 3 → 5 → lần ba 0 dòng, `count = 1`; kỳ có ngày và kỳ `NULL` là hai dòng riêng, dòng có ngày cộng dồn 1 → 2). Không cần fallback `'-infinity'` của spec §5 | spike `arbiter.spec.ts` (không commit); giữ thành test hồi quy QU-2 ở Task 3 (SQL) và Task 8 (song song) |
| S4-T2 (b) | `date_trunc('month', ts, tz)`/`date_add(ts, '1 month', tz)` không phụ thuộc `TimeZone` của phiên | Đạt: 1/1 PASS (với `TimeZone` phiên `UTC`, `America/New_York`, `Asia/Tokyo` đều cho `2026-08-31T17:00:00Z`, `2026-09-30T17:00:00Z`, `2026-10-31T17:00:00Z` với múi `Asia/Ho_Chi_Minh`) | cùng file; giữ thành QU-3 ở Task 5 |
| S4-T2 (c) | `BEFORE INSERT` chạy cả khi câu kết thúc ở `DO UPDATE` | Đạt: 1/1 PASS (hai câu upsert trên cùng khoá, lần hai đi nhánh `DO UPDATE`: trigger bắn 2 lần). Trigger `usage_counters_period_ck` chặn trên cả hai nhánh | cùng file |

## Cập nhật plan 4B (2026-10-06)

- **Bộ đếm** `usage_counters`: một dòng mỗi (org, tính năng QUOTA, kỳ); kỳ `NONE` là `period_start NULL` dưới `UNIQUE NULLS NOT DISTINCT` (spike S4-T2 ở trên); kỳ `MONTH` do câu SQL tính (`date_trunc('month', now(), ENTITLEMENTS_QUOTA_TIMEZONE)`), tạo lười, không cron. Consume là một câu `INSERT … ON CONFLICT … DO UPDATE … WHERE used + n <= max` trong transaction của caller; release trả đúng dòng của receipt; trả quá → `QuotaReleaseUnderflowError`.
- **Thứ tự kiểm của `Quotas.consume`:** transaction + org → key là QUOTA, không deprecated → `amount` nguyên trong `[1, 2^53 − 1]` → trần (snapshot trong transaction) → `amount > max` trả `EXCEEDED` không ghi → câu consume. `EXCEEDED` mang `used` đọc lại (một câu đọc, không ghi).
- **`quota.reached`** phát cùng transaction ở mỗi lần `used` chuyển từ dưới trần sang đúng trần (kể cả chạm lại sau `release`; không khử trùng theo kỳ, M3); actor: user, `service` (`api_key:<id>` cho org API key), hoặc `system` `entitlements.quotas` khi không có principal.
- **Ghế:** port `MemberSeatLimit` của tenancy; `MemberAdmission` kiểm ngay sau `INSERT org_members` (dòng mới được đếm: `countUpTo(…, max) > max`), dưới khoá org, trước event; vi phạm unique bắn trước nên `409 already_member` thắng `422`; đầy → `422 quota_exceeded` (`errors[0].code = 'tenancy.seats'`) và `tenancy_seat_limit_denied_total{source}` (metric ở tenancy, bên quyết định; spec §19 đổi tên theo đó). Adapter đọc snapshot, thiếu dòng → 503 (fail closed).
- **`down` của `…_usage_counters` từ chối khi còn bộ đếm** (usage không dẫn xuất lại được), nguyên tử với consume đang mở (khoá `ACCESS EXCLUSIVE` của `NO FORCE`).
- **Tách với 6A (R-X29):** 4B merge trước 6A nên chỉ ship dòng `files.storage_bytes` (`LIMIT`, `fallback` 1 GiB `FILES_STORAGE_FALLBACK_BYTES`); adapter `FileStorageLimit`, entry `integrations/files.ts`, dòng `OPTIONAL_BRIDGES` `entitlements-files`, kiểm lúc boot của files, ST-1…ST-4 và luật 20.8-d là của 6A.
- **Kiểm catalogue (R-X30):** dòng tính năng/gói chỉ có ở DB và dòng DB đã deprecate/retire mà code chưa là WARN (`entitlement_feature_unknown_to_code`, `entitlement_feature_deprecated_in_db`, `entitlement_plan_unknown_to_code`, `entitlement_plan_retired_in_db`) + `entitlements_catalogue_unknown_features_total`/`…_plans_total`; thiếu migration vẫn chặn boot; `ENTITLEMENTS_QUOTA_TIMEZONE` được kiểm bằng `date_trunc` ở Postgres lúc boot.
- **Dòng bộ đếm nóng:** khoá dòng giữ tới hết transaction của caller, kể cả ở nhánh `EXCEEDED` (M7); nhiều bộ đếm trong một transaction: theo thứ tự key tăng dần (I2); gọi consume gần cuối transaction ngắn; theo dõi p95 `entitlements_quota_consume_duration_seconds` (alert > 100 ms). Điểm mở rộng khi đo được: bộ đếm chia mảnh.
