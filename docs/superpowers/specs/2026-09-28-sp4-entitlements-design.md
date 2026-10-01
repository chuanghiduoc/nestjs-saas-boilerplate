# Sub-project 4 — Entitlements (gói, flag theo gói, quota atomic, guard)

- **Ngày:** 2026-09-28.
- **Trạng thái:** Bản thiết kế **r2, đã chốt 2026-09-29** (controller chốt theo uỷ quyền "tự chốt, tự làm hết"; các giả định chưa chạy được kiểm bằng spike ở đầu plan tương ứng) (r1 sửa theo ba review vòng 1 của SP4–SP7 và các phán quyết chéo R-X1…R-X11, nhật ký ở mục 25; r2 sửa theo review hội tụ vòng 2 `sp4-7-review-r2.md` và các phán quyết R-X12…R-X19 trong `.superpowers/autonomous/rulings.md`, nhật ký ở mục 26). Hợp đồng `@PlatformStaffAction()`, port `PlatformAccessAudit` và registry order purge nay có văn bản: addendum SP3 của plan 3D `2026-09-28-sp3-addendum-platform-staff.md` (trích "addendum 3D §An"). Sếp đã giao toàn quyền quyết định kỹ thuật ("tự chốt, tự làm hết"); mục 4 ghi từng quyết định kèm lý do và phương án đã loại. Mục 4.2 không còn câu hỏi mở: Q-1 đã chốt theo phán quyết.
- **Spec cha:** `2026-09-24-saas-core-architecture-design.md` (trích "cha §n"). Mục 22 liệt kê chỗ phải sửa ở spec cha, ở SP3 và ở các SP chạy song song.
- **Nền:** SP1 (core), SP2 (identity, notifications) đã merge ở `origin/main`; **SP3 r8 đã commit** (`docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, trích "SP3 §n", theo R-X11) là nền trực tiếp. Mỗi plan SP4 chỉ đợi đúng plan nó cần (theo R-X7, mục 21): **4A cần 3A**; **4B cần 4A, 3C, 6A, 7A** (r2: 7A mang hằng `OPTIONAL_BRIDGES` mà 4B thêm dòng vào, R-X13; W2 < W4 nên không đổi sóng); **4C cần 4A, 3D**. Không plan nào của SP4 đợi "cả bốn plan 3A–3D".
- **ADR mới:** ADR 0018 "Entitlements: catalogue và gói trong code, bộ đếm theo kỳ, không cache ở v1" (số theo R-X6). ADR 0018 ghi thêm phần "Hệ quả" của ADR 0015 (cache hoãn): ứng viên cache đầu tiên (entitlement) vẫn không cache ở v1, và nêu lý do (mục 8.5).
- **Đã kiểm với code hiện có (worktree `sp2-identity`, HEAD `f6ed8d2`):** `defineEvent` hiện chỉ nhận `{ type, version, schema }` (`src/core/events/event-definition.ts:21`), chưa có cờ `audit`/`webhook`: cờ bắt buộc do SP6 6.0 thêm (R-X3, mục 13.1). `defineConfig` đăng ký namespace vào registry toàn cục **ngay lúc import** (`registerConfigEntry`, `config.registry.ts`), nên import `index.ts` của một module là kéo cả config của nó vào lượt kiểm lúc boot: đây là lý do adapter dung lượng nằm ở entry riêng (mục 9.7). Migrator runtime đọc **đệ quy** `dist/migrations/**` (`migrator.ts`, `readdirSync(…, { recursive: true })`), nên thư mục `example/` và `app/` đều chạy. `src/app.modules.ts` hiện là danh sách `APP_MODULES` viết tay (chưa có `composeAppModules`, SP7 7A). Các mục đã kiểm ở r0 vẫn đúng: `CoreErrors.FEATURE_NOT_IN_PLAN` (403) và `CoreErrors.QUOTA_EXCEEDED` (422) đã có ở `src/core/errors/error-codes.ts:61,95`; `AppError` nhận `fields` (thành `errors[]` của problem, `problem-body.ts`); `defineEvent`/`EventPublisher.publish` (org lấy từ `RequestContext`, `event-publisher.ts`), `envelope.ts` cho `aggregate.version` là `z.int().nonnegative()`; `@EventSubscriber` là marker Discovery (`subscriber.decorator.ts`); `defineConfig`/`defineConfigRule`/`defineProductionRule` (`config.registry.ts`); `normalizeTimezone` export từ `core/scheduler`; `UnitOfWork.inTransaction()`; `OrgScope.run` và `Db.execute` (câu lẻ trong OrgScope vẫn mang `app.org_id`, `org-scope.ts`, `db.ts`); `assertIfMatch`, `etagOf`, `serialize`, `ApiProblems` ở `core/http`. Chưa có cache nào trong repo (`package.json` không có `cache-manager`/`keyv`). **r2 kiểm lại:** `registerConfigEntry` được gọi lúc import ở `define-config.ts:47` (lý do entry riêng của adapter dung lượng vẫn đúng); `src/` chưa có `markModuleLoaded`/`loadedModules` (SP7 7A thêm ở `core/config`, R-X16); zod trong `node_modules` là 4.6.5 (có `.meta()`, SP7 S7-D33); `AuthState` của identity không `@Global()` (lý do addendum 3D §A1.4 đòi module `@Global()` cho guard).

**Ký hiệu:** `S4-D*` quyết định (mục 4); `E-*` race (mục 17); `F-*` failure mode (mục 18); mã test theo nhóm ở mục 20 (`EC` catalogue, `EV` đánh giá, `PA` gán gói, `QU` quota, `SE` ghế, `ST` dung lượng, `AD` admin, `HT` HTTP, `DB` dữ liệu/RLS, `SM` smoke). `R-X*` là phán quyết chéo SP (rulings), `X-*`/`C-*`/`Q-*`/`N-*`/`T-*` là finding của review interfaces, `SP4-*` của review money-security, `OPS-*` của review ops (mục 25).

---

## 1. Mục tiêu và tiêu chí hoàn thành

Sau SP4, dự án clone từ boilerplate có:
- **catalogue tính năng** trong code (mỗi module/feature khai báo tính năng của mình), ba loại: `FLAG` (bật/tắt), `LIMIT` (trần của thứ module tự đếm, ví dụ số ghế), `QUOTA` (bộ đếm tiêu thụ, kỳ `NONE` hoặc `MONTH`);
- **gói** (plan) khai báo trong code của dự án, mỗi gói gán giá trị cho tính năng; mỗi org gắn đúng một gói;
- **ghi đè theo org** (override) do nhân viên nền tảng đặt, có lý do, có hạn tuỳ chọn;
- **quota atomic** (không bao giờ vượt trần khi tiêu thụ song song) và **số ghế** gắn vào `MemberAdmission` của SP3;
- decorator cho route và API cho service; API đọc cho tenant; API quản trị cho nhân viên;
- **điểm nối cho SP5**: một API đổi gói có thứ tự (chống event billing đến trễ), phát event outbox.

Tiêu chí (mỗi tiêu chí chứng minh bằng test trên hạ tầng thật như SP3, cộng một lượt prod-like trên image thật bằng compose `--profile app`, `NODE_ENV=production`, HTTP đầu-cuối):

1. **Mọi org đang tồn tại có đúng một dòng `org_entitlements`** ngay khi transaction tạo org commit (participant của SP3 chạy trong cùng transaction); org có sẵn trước SP4 được backfill trong migration; subscriber `tenancy.org.created` là lưới dự phòng idempotent. Thiếu dòng trên đường đọc → `503` + log ERROR + metric, không bao giờ trả giá trị mặc định âm thầm.
2. **Route có `<Catalogue>.requireEnabled(key)`** trả `403 feature_not_in_plan` khi tính năng tắt với org, và chỉ được đánh giá **sau** CASL: member thiếu quyền luôn nhận `403 forbidden`, không bao giờ biết gói có tính năng hay không.
3. **Quota không bao giờ vượt trần:** `N` lần `consume(1)` song song trên bộ đếm còn `k < N` đơn vị → đúng `k` thành công, `N − k` nhận `422 quota_exceeded`, `used` cuối = trần; lặp ×50 ở integration.
4. **Kỳ `MONTH` tự reset** ở ranh giới tháng dương lịch theo `ENTITLEMENTS_QUOTA_TIMEZONE` (R-X10) mà không cần cron; tiêu thụ đua qua ranh giới không mất đơn vị nào (mỗi đơn vị rơi vào đúng một kỳ).
5. **Số ghế:** `N + k` lần chấp nhận lời mời/join link song song khi còn `N` ghế → đúng `N` membership; hạ gói xuống dưới số member hiện có không xoá ai, chỉ chặn thêm member.
6. **Gán gói có thứ tự:** lệnh `BILLING` có `sequence` ≤ `last_billing_seq` là no-op có tên (`STALE`); lệnh đến trễ không bao giờ ghi đè lệnh mới hơn; mỗi thay đổi thật phát đúng một `entitlements.plan.changed` cùng transaction. `assign` chỉ ném lỗi lập trình hoặc hạ tầng, **luôn trước câu ghi đầu tiên** nếu là lỗi có tên, nên transaction tiền của SP5 (gọi đồng bộ, R-X1) vẫn commit được sau một kết quả bị từ chối (mục 10.3).
7. **Catalogue khớp DB:** tập feature (key, kind, reset period, deprecated) và tập plan (key, retired) trong code khác DB → api và worker không khởi động; gói tham chiếu feature lạ, giá trị sai kiểu, giá trị dưới `minimum`, gói mặc định không tồn tại hoặc đã retire → không khởi động.
8. **RLS:** ba bảng tenant của SP4 đạt tiêu chí 1 của SP3 (đọc/sửa/xoá chéo org 0 dòng, INSERT chéo `42501`, không scope `P0001`) và nằm trong test catalog; hai bảng global nằm trong `GLOBAL_TABLES`.
9. **Admin:** mọi route `/v1/admin/**` của SP4 mang `@PlatformStaffAction()` của identity (ship ở 3D, R-X2; hợp đồng ở addendum 3D §A1), nên có cùng gate nhân viên + step-up và cùng audit truy cập (port `PlatformAccessAudit`, no-op tới khi SP6 6B cài, addendum 3D §A3) như mọi route admin khác; bộ ca chuẩn của addendum 3D §A5 xanh trên từng route. **Kiểm lúc boot** rằng mọi `/v1/admin/**` mang decorator là `PlatformStaffRouteInventory` của **SP6 6B** (R-X12, R-X17), không phải của 3D; ca inventory trên route của SP4 chạy ở plan merge sau trong cặp 4C/6B. Mọi thay đổi có `If-Match`, lý do bắt buộc, event outbox (actor là nhân viên, `audit: true`).
10. **Xoá cứng org** xoá mọi dòng SP4 của org qua `OrgPurgeParticipant` `order = 100` (R-X5); quên bước nào thì purge fail to (FK `RESTRICT`).
11. **DB lỗi → `503`**, không bao giờ `500`, trên đường đọc snapshot, consume, gán gói.
12. **Không package mới**, kích thước image không đổi (ghi lại số đo ở ADR 0013).
13. Pipeline xanh ở từng plan như SP3 tiêu chí 17 (lint, type-check, unit, integration, migration up → down → up và sweep S2-R57 với migration của plan, `oasdiff` chỉ thêm, luật kiến trúc có fixture).
14. **Dung lượng file là `LIMIT` của SP4** (R-X8, R-X13): trần `files.storage_bytes` của org tới SP6 qua port **`FileStorageLimit`** (SP6 sở hữu và export) do adapter ở entry riêng `modules/entitlements/integrations/files.ts` cài (mục 9.7), cùng mẫu `tenancy.seats`. Composition của SP7 nạp entry đó khi cả `entitlements` lẫn `files` bật; thiếu adapter trong khi `entitlements` bật → api và worker **không khởi động** (kiểm ở files, mục 9.7 mục 6). Không có bộ đếm thứ hai: SP6 tính `SUM(stored_bytes)` dưới `OrgMutationLock` (khoá dòng `organizations`), SP4 chỉ trả trần.
15. **Mọi event `entitlements.*` khai báo cờ tường minh** `audit: true`, `webhook: false` (R-X3); staff đổi gói/override luôn vào audit của SP6.
16. **Nghĩa vụ composition của SP7** (R-X16): dòng đầu của `modules/entitlements/index.ts` gọi `markModuleLoaded('entitlements')`; `MODULE_REQUIRES` có dòng `entitlements → tenancy`; config của SP4 không có trường secret nên không có `.meta({ secret })` nào (mục 14). Tắt `entitlements` thì config của nó không được đăng ký và `plans` không bắt buộc (SP7 §6.2).

---

## 2. Phạm vi

**Trong phạm vi:**
- `src/modules/entitlements` (mới): catalogue tính năng, catalogue gói (khai báo), đánh giá hiệu lực, quota, số ghế (qua port của tenancy), trần dung lượng file (qua port của files, entry riêng `integrations/files.ts`, mục 9.7), gán gói + điểm nối SP5, override, interceptor + decorator, API đọc tenant, API admin, participant tạo/xoá org, subscriber dự phòng, event `entitlements.*`.
- **Vùng template** (theo mô hình vùng của SP7 §6.1, X-6): `src/plans.example.ts` — catalogue gói khởi đầu `free` (mặc định) và `pro`; `src/migrations/example/…_starter_plans` — migration khởi đầu chèn hai gói và backfill org đã có. Upstream chạy chúng trong CI của chính nó; clone nhận bản chép vào vùng dự án (`src/app.plans.ts`, `src/migrations/app/…`) lúc `upstream:init` (mục 7.7, 22.3). Upstream **không** ghi file nào vào vùng dự án.
- Sửa nhỏ ở `modules/tenancy` (participant tạo org, port số ghế, export bộ phân loại route), mục 22.2. **Không sửa `modules/identity`:** route admin dùng `@PlatformStaffAction()` do 3D ship (R-X2).
- ADR 0018; cập nhật ADR 0005 (bảng mới trong test catalog), 0015 (hệ quả cache) và 0017 (thứ tự pipeline); sửa spec cha.

**Ngoài phạm vi (non-goals):**
- Giá, hoá đơn, subscription, trial, add-on mua thêm: **SP5**. SP4 chỉ nhận lệnh "org X dùng gói P **từ bây giờ**".
- Gán gói hẹn ngày tương lai (`effectiveAt`): **không có** (R-X1). Billing gọi `assign` đúng lúc gói bắt đầu có hiệu lực (mục 10.3).
- Đếm dung lượng file: SP6 tính `SUM(stored_bytes)` trên dòng `files` dưới `OrgMutationLock`, không có bảng đếm; SP4 chỉ trả trần (R-X8, R-X13).
- Kill switch vận hành qua `@openfeature/server-sdk` (cha §13.1): không thuộc mục 4 của Phụ lục C; làm khi có use case (SP7 hoặc sau).
- Rollout theo phần trăm, A/B, flag theo user: entitlement là theo **org**.
- Cache dùng chung (Redis) cho entitlement: không có ở v1 (S4-D8); thiết kế và điều kiện bật ghi ở mục 8.5.
- Dọn bộ đếm của kỳ cũ theo thời hạn: v1 giữ lại làm lịch sử (khối lượng ở mục 23). Khi thêm, dùng helper sweep dùng chung và role `sweep_definer` của SP6 6.0 (R-X4), không viết vòng quét riêng.
- Gắn tính năng của **tenancy** (role tuỳ biến, invite link…) vào gói bằng `requireEnabled`: tenancy không được import entitlements; số ghế là ngoại lệ duy nhất, qua port (mục 9.6). Mở rộng sau theo cùng mẫu port.
- Phê duyệt hai người cho thao tác admin: SP6.

---

## 3. Ràng buộc toàn cục

Giữ nguyên mục 3 của SP1/SP2/SP3. Riêng SP4:

1. **Package-first:** không cài package nào. Mọi nhu cầu có sẵn: `zod` (catalogue), `@nestjs/core` `DiscoveryService` (marker), `core/database` (SQL, UoW, OrgScope), `core/events` (outbox), `core/http` (ETag, problem). Lý do loại `@nestjs/cache-manager` + `cache-manager` 7.2.9 + `@keyv/redis` 5.1.6 (kéo `@redis/client` ^5.10 làm client Redis thứ hai): mục 8.5.
2. **Generator:** `nest g module|controller|service|interceptor` cho khung; `mikro-orm migration:create --blank --path src/migrations/entitlements` (và `--path src/migrations/example` cho migration khởi đầu của vùng template).
3. **Bất biến ở DB:** mọi điều biểu diễn được bằng `CHECK`/`UNIQUE`/`FK`/trigger thì nằm ở DB (mục 7); trigger ném `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = '<tên>'` để đi qua `defineConstraintErrors` sẵn có.
4. **Kiểu:** PK `BIGINT GENERATED ALWAYS AS IDENTITY` cho bảng global; bảng tenant dùng khoá tự nhiên có `org_id` đứng đầu (không có id ra ngoài: resource được định danh bằng `orgId` + key tính năng). `org_id UUID` theo SP3 S3-A1. Thời gian `TIMESTAMPTZ`. Enum `TEXT` + `CHECK`. Số đếm `BIGINT` giới hạn `[0, 2^53 − 1]` (hằng `ENTITLEMENT_VALUE_MAX = 9007199254740991`, dùng chung zod và `CHECK`) để JSON số không mất chính xác.
5. **FK có chủ đích:** `RESTRICT` mặc định; không `CASCADE` ở đâu cả (xoá cứng xoá tường minh qua participant, như SP3 §9.5).
6. **Khoá dòng `FOR NO KEY UPDATE`**, không `FOR UPDATE` (SP3 §3.13). Thứ tự khoá cố định, nối tiếp SP3 §3.14: `organizations` (tenancy; cũng là khoá `OrgMutationLock` mà SP6 files lấy trước khi đọc trần dung lượng) → **khoá của module gọi** (ví dụ `billing_accounts` của SP5) → `org_entitlements` → `usage_counters`. Luật: **entitlements luôn khoá sau mọi khoá của caller, và không bao giờ khoá bảng của module khác sau khi đã giữ khoá của mình**; mọi API của SP4 chạy trong transaction của caller nên caller quyết phần đầu của thứ tự. Consume **không** khoá `org_entitlements` (chỉ đọc), nên không có chu trình. Purge (E-16) không giữ khoá nào của billing vì billing không phải purge participant (R-X5). Dòng này được đưa vào bảng race của spec cha (P3, mục 22.1).
7. **Không hard-code:** thời gian, múi giờ kỳ quota lấy từ config (mục 14); giá trị của gói nằm trong catalogue gói của dự án (`src/app.plans.ts` ở clone, `src/plans.example.ts` ở upstream; config dạng code có kiểu, review được); hằng định dạng (regex key, độ dài lý do) là hằng có tên dùng chung zod và `CHECK`.
8. **Fail loud:** catalogue lệch DB, gói tham chiếu feature lạ, decorator trên route không phải tenant, thiếu dòng `org_entitlements`, trả quota vượt số đã dùng → ném lỗi có tên kèm log, không trả giá trị sai.
9. **Mọi race có tên và cơ chế chặn** (mục 17); check-then-insert không bao giờ là cơ chế.
10. **Migration:** SQL (`addSql`), `down` đối xứng đã test, grant theo bảng và theo cột cho `UPDATE`, đọc/ghi dữ liệu trên bảng `FORCE` trong migration theo mẫu 7 bước của SP3 §8.8; timestamp sau mọi migration trên `main` lúc merge, **trong cùng vùng** (luật SP3 §6.13 áp theo vùng, SP7 S7-D31/B1).

---

## 4. Quyết định

### 4.1 Quyết định em tự chốt

| # | Quyết định | Lý do | Phương án đã loại |
|---|---|---|---|
| S4-D1 | **Tính năng khai báo trong code** bằng `defineFeatureCatalogue`, mỗi module/feature một catalogue, đăng ký bằng marker Discovery `@FeatureCatalogueContributor` (đúng cơ chế catalogue quyền SP3 §8.2); DB có bảng tra cứu `entitlement_features` (key, kind, kỳ, deprecated) do migration ghi, kiểm bằng nhau lúc boot | Code kiểm tính năng bằng key có kiểu (sai key là lỗi compile); DB cần dòng để FK từ override và bộ đếm; cùng mẫu SP3 nên người đọc đã quen | Chỉ DB (admin tạo tính năng lúc chạy): code không kiểm được key nào tồn tại. Chỉ code, không bảng: override/bộ đếm không có FK (luật enum của cha §4) |
| S4-D2 | **Gói khai báo trong code của dự án** (`src/app.plans.ts`, `definePlanCatalogue`), tới module qua composition: `composeAppModules({ disable, features, plans })` của SP7 gọi `EntitlementsModule.forApi(plans)`/`forWorker(plans)` (X-7, mục 6.2). **Giá trị** của gói chỉ ở code; DB chỉ có bảng tra cứu `plans` (key, retired) cho FK | Gói là quyết định sản phẩm cần review và giống nhau ở mọi môi trường; đổi giá trị không cần migration (không có hai nguồn sự thật để lệch); SP5 FK `billing_prices.plan_id` vào `plans(id)` (R-X1). Upstream chỉ ship bản mẫu ở vùng template (S4-D22), nên `git merge upstream` không đụng file của dự án | Gói trong DB sửa qua admin API: thay đổi không review, test/staging lệch production, cần version hoá gói. Giá trị gói nhân bản vào DB (như `permissions`): mỗi lần chỉnh giới hạn phải viết migration khớp tay, thêm một chỗ lệch |
| S4-D3 | Mỗi tính năng khai báo **`fallback`** bắt buộc: giá trị cho gói không nhắc tới nó. Tính năng của boilerplate có `fallback` giữ nguyên hành vi trước SP4 (ví dụ `tenancy.seats` = không giới hạn) | Merge upstream thêm tính năng mới không làm hỏng mọi dự án; người sở hữu tính năng chọn mặc định an toàn; boot log liệt kê (gói, tính năng) đang dùng `fallback` để không ai bị bất ngờ | Buộc mọi gói liệt kê đủ mọi tính năng: mỗi lần merge upstream CI đỏ tới khi dự án cập nhật gói. Mặc định ngầm (`false`/0) do framework chọn: tính năng boilerplate mới sẽ khoá tính năng đang chạy của dự án |
| S4-D4 | Ba loại tính năng: `FLAG`, `LIMIT`, `QUOTA`. `LIMIT` = trần của thứ module chủ **tự đếm dưới khoá của mình** (entitlements chỉ trả trần); `QUOTA` = bộ đếm do entitlements giữ, tiêu thụ atomic | Số ghế đếm chính xác từ `org_members` dưới khoá org mà `MemberAdmission` đã giữ, không cần bộ đếm thứ hai có thể lệch (không phi chuẩn hoá); dung lượng file cùng mẫu: SP6 tính `SUM(stored_bytes)` dưới `OrgMutationLock`, SP4 trả trần qua port `FileStorageLimit` (R-X8, R-X13, mục 9.7); tài nguyên không có khoá sẵn dùng `QUOTA` | Mọi giới hạn là bộ đếm: ghế phải cộng/trừ ở 4 đường gỡ member của tenancy, dễ lệch. Chỉ `FLAG` + `LIMIT`: dự án phải tự viết đếm atomic |
| S4-D5 | Kỳ quota: `NONE` (phân bổ, ví dụ số bản ghi đã tạo) và `MONTH` (tháng dương lịch, múi giờ `ENTITLEMENTS_QUOTA_TIMEZONE`, mặc định `Asia/Ho_Chi_Minh`; phán quyết "SP4 quota period" và R-X10). **Không cron reset**: mỗi kỳ là một dòng `usage_counters` khoá theo `period_start`, tạo lười ở lần tiêu thụ đầu | Reset không có race ở ranh giới (mỗi đơn vị rơi vào dòng của kỳ tính từ `now()` của DB); dòng kỳ cũ là lịch sử dùng; không có job nào có thể lỡ | Cron đặt `used = 0`: race với tiêu thụ quanh nửa đêm, cron lỡ thì quota không reset. Kỳ `DAY`: chưa có use case (thêm sau bằng một giá trị `CHECK`). Kỳ neo theo chu kỳ billing: đã loại theo phán quyết (mục 4.2) |
| S4-D6 | Consume là **một câu** `INSERT … ON CONFLICT … DO UPDATE SET used = used + n WHERE used + n <= $limit RETURNING`, chạy **trong transaction của caller** | Khoá dòng bộ đếm + điều kiện trên bản mới nhất làm vượt trần không thể xảy ra (cha §5 dòng quota); chung transaction với side effect nên rollback trả lại quota và idempotency của caller (Idempotency-Key, Inbox) phủ luôn quota; không cần sổ cái tiêu thụ | Consume ở guard, transaction riêng: handler lỗi thì quota mất, phải bù. Sổ cái `usage_events` + idempotency key riêng: thêm bảng và ghi cho mỗi lần tiêu thụ mà không đem lại bảo đảm nào hơn |
| S4-D7 | **Kiểm tính năng ở route là interceptor route-scoped** (`EntitlementInterceptor`, gắn bởi `requireEnabled`), không phải guard | Nest chạy mọi guard trước mọi interceptor, nên kiểm entitlement **luôn** sau `PoliciesGuard` bất kể thứ tự viết decorator; interceptor chạy bên trong `OrgScopeInterceptor` (global) nên đọc được dưới RLS mà không tự mở scope (SP3 §7.1 bước 7). Guard route-scoped thì thứ tự giữa `PoliciesGuard` và guard entitlement phụ thuộc thứ tự decorator (mảng `UseGuards` được nối theo thứ tự áp decorator, dưới lên trên) | Guard + luật boot ép thứ tự decorator: đúng nhưng bắt developer nhớ một luật vô hình. `APP_GUARD`: chạy trước `PoliciesGuard` và có thể trước `AuthGuard` |
| S4-D8 | **Không cache entitlement ở v1**; mỗi lần cần đọc một câu theo PK. Thiết kế cache Redis có version và điều kiện bật ghi sẵn (mục 8.5) | Cha §8: "mặc định không cache, chỉ bật ở chỗ đã đo". Đường đọc là một câu PK + join nhỏ, chỉ chạy trên route có `requireEnabled` và ở service có kiểm; quota không bao giờ cache được (phải đọc trong transaction); tránh staleness sau khi thanh toán | Cache L1 trong process: không có bus xoá giữa pod, nâng cấp gói xong vẫn bị chặn tới hết TTL. Stack `cache-manager` của cha §8: `wrap` không so version khi ghi lại, không chặn được ghi đè cũ (mục 8.5), và kéo thêm client Redis thứ hai |
| S4-D9 | **Mọi org có đúng một dòng `org_entitlements`**: tạo trong transaction tạo org bằng participant mới của tenancy `@OrgCreationParticipantContributor` (cùng mẫu participant purge SP3 §9.5); subscriber `tenancy.org.created` làm lưới dự phòng `ON CONFLICT DO NOTHING`; migration khởi đầu backfill org cũ. Đọc mà thiếu dòng → `503` + ERROR | Không có cửa sổ "org vừa tạo chưa có gói"; không có fallback ngầm "thiếu dòng = gói mặc định" (đổi gói mặc định sẽ âm thầm đổi gói của org thiếu dòng); subscriber phủ cửa sổ rolling deploy (pod cũ tạo org không có participant) | Chỉ subscriber: vài giây sau khi tạo org, mọi route có kiểm entitlement trả lỗi. Fallback ngầm: sai âm thầm |
| S4-D10 | **Gán gói qua một API** `PlanAssignments.assign(cmd)` chạy trong UoW của caller, khoá `org_entitlements` `FOR NO KEY UPDATE`, trả kết quả có tên `APPLIED \| UNCHANGED \| STALE \| REJECTED_RETIRED`, **có hiệu lực lúc commit** (không gán tương lai). Đây là **hợp đồng duy nhất** với SP5 (R-X1): billing gọi `assign` đồng bộ trong transaction billing, `sequence` lấy từ `billing_accounts.plan_assignment_seq`; DB giữ `last_billing_seq` đơn điệu (trigger) | Gọi trong cùng transaction với tiền nên gói và tiền nguyên tử; `sequence` + trigger vẫn giữ làm lớp chặn cuối nếu sau này có caller bất đồng bộ; kết quả có tên để SP5 xử lý bằng `switch` vét cạn mà không ném, nên hoá đơn đã trả không bao giờ rollback vì gói (mục 10.3) | Port `assignPlan(orgId, planKey, effectiveAt)` hẹn ngày: cần bảng lịch và câu "gói ở thời điểm t", thêm một nguồn sự thật; loại theo R-X1. Subscriber của billing gọi `assign` (r0): tiền và gói không nguyên tử. So `occurredAt`: đồng hồ app, không đơn điệu giữa pod. So `aggregate.version` của subscription: subscription mới bắt đầu lại từ 1 |
| S4-D11 | **Ưu tiên nguồn gán gói (r2, R-X18):** lệnh mới nhất thắng. **Billing khẳng định lại gói ở mọi kỳ đã trả** (gọi `assign` ở mỗi lần kỳ đã trả bắt đầu, kể cả gia hạn), nên: gia hạn cùng gói, cùng subscription → `UNCHANGED` (không tăng `version`, không event); gán tay của nhân viên (`PLATFORM_ADMIN`) **bị ghi đè ở kỳ trả tiền kế tiếp** (`APPLIED`, nguồn về `BILLING`), trừ khi thứ nhân viên muốn giữ là **override** theo tính năng: override là lớp riêng, billing không bao giờ ghi đè nó và nó sống qua mọi lần đổi gói. Ngoại lệ có tên: gói của giá đang trả đã retire mà khác gói hiện tại → `REJECTED_RETIRED` mỗi kỳ (gói của nhân viên đứng yên, SP5 cảnh báo mỗi kỳ) cho tới khi nhân viên chuyển khách sang giá còn bán | Một khe gói, một luật đơn giản; gói hiệu lực không lệch lâu hơn một kỳ so với giá khách đang trả (không nâng gói không trả tiền, không hạ gói khi khách trả đủ); nhân viên muốn giữ ưu đãi lâu dài thì dùng override, có lý do và có hạn | "Gán tay ghim gói, billing bị bỏ qua": org trả tiền nâng cấp mà không nhận gói mới, sai theo hướng mất tiền của khách. "Gán tay sống tới lần đổi giá hoặc hết hạn" (phương án (b) của review X2-6): gói lệch với giá đang trả vô thời hạn; loại theo R-X18 |
| S4-D12 | Override **thay thế** giá trị của gói cho đúng tính năng đó (không cộng dồn); có `expires_at` tuỳ chọn, hết hạn suy ra khi đọc (không cron, không event) | Một luật ưu tiên (`OVERRIDE` > `PLAN` > `FALLBACK`); add-on mua thêm (cộng dồn) là việc của SP5 | Cộng dồn: cần định nghĩa "cộng" cho `FLAG`, và trộn với add-on có tiền |
| S4-D13 | **Hạ gói không xoá dữ liệu:** `used > limit` hoặc số member > số ghế là trạng thái hợp lệ `OVER_LIMIT`; chỉ chặn tiêu thụ/thêm mới tới khi xuống dưới trần | Xoá dữ liệu khi hạ gói là quyết định sản phẩm có hậu quả không đảo được; chặn tiêu thụ mới đủ cho mọi gói | Từ chối hạ gói khi đang vượt: billing hết hạn vẫn phải hạ được (cha Phụ lục A.1) |
| S4-D14 | **Lỗi**: dùng mã có sẵn của core `feature_not_in_plan` (403) và `quota_exceeded` (422) cho cả `LIMIT` lẫn `QUOTA`; key tính năng trả trong `errors: [{ path: 'feature', code: '<featureKey>', message }]` | Client cần biết tính năng nào mà không phải parse `detail`; không đổi `core/errors` | Thêm trường mở rộng `feature` vào problem: sửa `AppError`/`problemBody` của core cho một use case |
| S4-D15 | **Admin HTTP** dưới `/v1/admin/orgs/{orgId}/entitlements…` với **`@PlatformStaffAction()` của identity, ship ở 3D** (R-X2). SP4 chỉ dùng, không định nghĩa decorator nào; mọi hành vi của gate (nhân viên, credential nào được nhận, step-up TOTP tươi, `external`, mã lỗi, audit truy cập qua port) là của 3D | SP3 đã chốt mọi đường quyền nền tảng của nhân viên đòi TOTP tươi (SP3 §9.7); một decorator cho mọi route admin thì SP4, SP5, SP6 không lệch nhau; hợp đồng (mã theo `AUTH_MODE`, port audit, bộ ca test) ở addendum 3D; inventory lúc boot của SP6 6B kiểm được mọi `/v1/admin/**` (R-X17) | `@PlatformAdminOnly()` riêng của SP4 (r0): trùng tên và lệch hành vi với SP5/SP6 (X-1); loại theo R-X2. Gate chỉ `isPlatformAdmin()`: session bị đánh cắp của nhân viên đổi được gói của mọi org |
| S4-D16 | Event `entitlements.quota.reached` phát **khi một lần tiêu thụ thành công đưa `used` chạm trần** (cùng transaction), không phát cho lần bị từ chối | Lần bị từ chối nằm trong transaction sẽ rollback (event outbox mất theo), và phát mỗi lần từ chối là spam; "chạm trần" là sự kiện có nghĩa (báo owner). Đổi tên `quota.exceeded` của cha §2 | Phát ở transaction riêng cho mỗi lần từ chối: một request lặp tạo hàng nghìn event |
| S4-D17 | Quyền đọc entitlement là quyền mới `entitlements.read` trong catalogue `EntitlementPermissions` của module (đăng ký bằng `@PermissionCatalogueContributor` của SP3), `requires: ['org.read']`, cấp cho ADMIN và MEMBER, `apiKeyEligible`, `supportEligible`. Provider catalogue nằm ở **cả** `forApi()` lẫn `forWorker()` (SP3 §8.2 INT3-5). **Ghi chú nâng cấp (X-12):** `grantTo.admin = true` làm `A = perms(ADMIN)` lớn lên (SP3 §8.2), nên role tuỳ biến do owner tạo từng ⊇ `A` cũ sẽ thôi "tương đương admin" sau khi deploy 4A và admin quản lý được người giữ nó (luật 2a luôn so với `A` hiện tại); README "nâng cấp lên SP4" ghi rõ và hướng dẫn owner thêm `entitlements.read` vào các role đó nếu muốn giữ mức bảo vệ | Frontend của mọi member cần biết tính năng nào bật để hiển thị; tách khỏi `billing.read` (tiền, SP5) | Dùng `org.read`: không tách được khi dự án muốn giấu gói với member. Không cấp cho ADMIN để giữ nguyên `A`: admin là vai trò cần thấy gói nhất |
| S4-D18 | Không có API tenant nào ghi entitlement | Org chỉ đổi gói qua billing (SP5); cho owner tự đổi gói là lỗ hổng tiền | — |
| S4-D19 | **Ngoại lệ có tên:** service admin mở `OrgScope.run(orgId, …)` **không qua membership**, chỉ sau khi `@PlatformStaffAction()` đã cho qua. Cùng ngoại lệ mà SP6 gọi là S6-A39 cho route admin của nó | Nhân viên không phải member của org; RLS vẫn giới hạn mọi câu vào đúng một org; audit truy cập của decorator (R-X2) ghi lại lần mở scope | Vào org qua support grant: grant chỉ đọc (SP3 P-2) và do owner cấp, không dùng được để sửa gói |
| S4-D20 | **Cờ event tường minh** (R-X3): cả bốn event `entitlements.*` khai báo `audit: true`, `webhook: false` | Staff đổi gói/override là hành vi phải audit; `quota.reached` hiếm (một lần mỗi kỳ mỗi tính năng) nên audit rẻ. Webhook là hợp đồng công khai: bật sau là thay đổi thêm, không phá | `webhook: true` cho `plan.changed`: payload chứa key gói nội bộ, chưa có use case tích hợp |
| S4-D21 | **Dung lượng file là `LIMIT` qua port** (R-X8, R-X13): SP4 khai báo `files.storage_bytes` (`LIMIT`) trong catalogue boilerplate và cài port **`FileStorageLimit`** của SP6 (một tên, SP6 sở hữu) bằng adapter `FileStorageLimitAdapter` ở entry riêng `integrations/files.ts`; composition của SP7 nạp entry đó qua hằng `OPTIONAL_BRIDGES` khi cả `entitlements` lẫn `files` bật (mục 6.2, 9.7); thiếu adapter khi `entitlements` bật → không khởi động | SP6 tính dung lượng chính xác bằng `SUM(stored_bytes)` dưới khoá org (đúng định nghĩa `LIMIT` của S4-D4); một bộ đếm `QUOTA` thứ hai sẽ lệch. Entry riêng vì import `modules/files/index.ts` kéo config của files vào lượt kiểm lúc boot (`defineConfig` đăng ký lúc import, `define-config.ts:47`) dù files bị tắt. Kiểm lúc boot vì port là `@Optional()` và SP6 có mặc định config: thiếu adapter sẽ âm thầm thay trần theo gói bằng 1 GiB (X2-1) | `QUOTA` kỳ `NONE` (ví dụ r0): hai bộ đếm. Adapter trong `forApi()`/`forWorker()` của entitlements (SP6 r1 §18.4 đề xuất): bắt dự án có files mới boot được. Tên port riêng của SP4 (`StorageQuotaLimits`, r1): hai class cho một token DI, adapter cài token mà files không inject |
| S4-D22 | **Catalogue gói và migration khởi đầu là file vùng template** (X-6): upstream ship `src/plans.example.ts` + `src/migrations/example/…_starter_plans`; `upstream:init` chép sang `src/app.plans.ts` + `src/migrations/app/<timestamp mới>_starter_plans` | Upstream không bao giờ ghi vào vùng dự án (SP7 S7-D6, UP-9); CI upstream vẫn chạy migration khởi đầu thật; clone sở hữu bản chép và sửa theo gói thật | r0: ship thẳng vào `src/app.plans.ts` và `src/migrations/app/` kèm luật "file `app/` mới nhất lớn hơn mọi thư mục module": vỡ ngay ở upstream khi migration module sau SP4 merge và vỡ mọi `upstream:sync` |

### 4.2 Câu hỏi cho Sếp (đã đóng)

| # | Câu hỏi | Trạng thái |
|---|---|---|
| Q-1 | Quota theo tháng reset vào đầu tháng dương lịch hay vào ngày kỷ niệm chu kỳ thanh toán? | **Đã chốt** theo phán quyết "SP4 quota period" (2026-09-28) và R-X10: tháng dương lịch theo `ENTITLEMENTS_QUOTA_TIMEZONE`, mặc định `Asia/Ho_Chi_Minh` (S4-D5). Nếu sau này cần neo billing: SP5 thêm `resetPeriod: 'BILLING_PERIOD'` (một giá trị `CHECK` + port lấy mốc kỳ từ billing), bảng không đổi |

Không còn câu hỏi mở nào của SP4.

---

## 5. Spike (bước đầu của plan tương ứng)

| # | Plan | Câu hỏi | Đạt | Fallback |
|---|---|---|---|---|
| S4-T1 | 4A | Interceptor route-scoped chạy **bên trong** `OrgScope.run` của `OrgScopeInterceptor` (global) — `RequestContext.orgId()` có giá trị và `Db.execute` mang `app.org_id` — và luôn chạy sau `PoliciesGuard` bất kể thứ tự decorator | E2E fixture: route `@TenancyPermissions.require(...)` + `requireEnabled(...)` viết theo cả hai thứ tự; member thiếu quyền → `403 forbidden`, member đủ quyền trên gói tắt → `403 feature_not_in_plan`; câu SQL trong interceptor thấy đúng org | Interceptor tự `OrgScope.run(ctx.orgId(), …)` (OrgScope cho vào lại cùng org, `org-scope.ts`) |
| S4-T2 | 4B | Postgres 18: index `UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)` làm arbiter cho `ON CONFLICT (org_id, feature_id, period_start)` với `period_start IS NULL`, và `DO UPDATE … WHERE used + EXCLUDED.used <= $3` nhận tham số | Hai `INSERT … ON CONFLICT` với `period_start = NULL` → một dòng, lần hai đi nhánh `DO UPDATE`; `WHERE` sai → 0 dòng. **Đã chạy đạt** trên PostgreSQL 18.6 ở review money-security r1 (3 → 5 → 0 dòng, `count(*) = 1`); plan 4B giữ nó làm test hồi quy (QU-2), không còn là spike chặn | `period_start TIMESTAMPTZ NOT NULL` với `'-infinity'` cho kỳ `NONE` (giá trị thật của kiểu, không trùng kỳ nào), index `UNIQUE` thường |
| S4-T3 | 4A | `@OrgCreationParticipantContributor` quét bằng Discovery chạy trong transaction tạo org, **trước** `MemberAdmission` của người tạo, trong `OrgScope(newId)` | Tạo org → dòng `org_entitlements` cùng transaction; participant ném → không có org | Không có fallback: nếu tenancy không gọi được participant trong transaction thì dừng, báo Sếp (S4-D9 không còn đúng) |

---

## 6. Kiến trúc và ranh giới module

### 6.1 Entitlement khác permission (ranh giới chốt)

| | **Permission** (SP3, CASL) | **Entitlement** (SP4) |
|---|---|---|
| Trả lời | Người này (member, org key, support grant) **được làm gì** trong org | Org này **đã có (đã trả tiền cho) cái gì** |
| Chủ thể | principal trong một org | org |
| Nguồn | role (hệ thống/tuỳ biến) × catalogue quyền; phạm vi key/grant | gói của org × catalogue tính năng; override của nhân viên |
| Ai đổi | owner/admin của org (trong luật chống leo quyền) | billing (SP5); nhân viên nền tảng |
| Đánh giá | `PoliciesGuard` (guard), tính mỗi request | `EntitlementInterceptor` (sau mọi guard), `Entitlements`/`Quotas` ở service |
| Lỗi | `403 forbidden` | `403 feature_not_in_plan`, `422 quota_exceeded` |

Luật:
- **Cả hai phải đạt**; cái này không bao giờ thay cái kia. Owner giữ mọi quyền vẫn bị chặn bởi gói; gói có tính năng không cho member thiếu quyền dùng nó.
- **Thứ tự:** permission trước, entitlement sau (S4-D7). Member thiếu quyền không học được gì về gói qua mã lỗi.
- **Không lẫn nguồn:** ability của CASL không bao giờ chứa điều kiện về gói; catalogue quyền không có trường nào về gói; entitlements không đọc role. Không quyền nào tự bật theo gói (một route cần cả hai thì gắn cả hai decorator).
- **Mọi principal của org chịu cùng entitlement** (member, org API key, support grant): entitlement thuộc org, không thuộc người. Nhân viên nền tảng không có đường vòng qua entitlement; muốn mở cho org thì đặt override (có lý do, có event).
- Xem entitlement cũng là một quyền (`entitlements.read`, S4-D17).

### 6.2 Vị trí module

```
src/modules/entitlements/
  index.ts (dòng đầu: markModuleLoaded('entitlements'), R-X16) · entitlements.module.ts (forApi(plans) · forWorker(plans)) · entitlements.config.ts
  errors.ts (lớp lỗi có tên, export ở index.ts, R-X19) · events.ts · permissions.ts (EntitlementPermissions) · features.ts (BoilerplateFeatures: tenancy.seats, files.storage_bytes)
  integrations/  files.ts               (entry riêng, 4B: EntitlementsFilesPortsModule + FileStorageLimitAdapter; không gọi markModuleLoaded; mục 9.7)
  domain/        feature-catalogue.ts   (defineFeatureCatalogue, kiểu FeatureDef, validate)
                 plan-catalogue.ts      (definePlanCatalogue, UNLIMITED, validate với catalogue gộp)
                 effective-value.ts     (resolveEffective: OVERRIDE > PLAN > FALLBACK, switch vét cạn theo kind)
                 quota-period.ts        (kỳ → vị từ SQL; không tự tính giờ ở app)
                 plan-assignment.ts     (decideAssignment → AssignmentDecision, switch vét cạn theo cause)
  application/   entitlements.service.ts (Entitlements: snapshot, isEnabled, assertEnabled, limitOf, assertWithinLimit)
                 quotas.service.ts       (Quotas: consume, consumeOrThrow, release, releaseAllocation)
                 plan-assignments.service.ts (PlanAssignments: assign — điểm nối SP5)
                 overrides.service.ts (4C) · admin-entitlements.query.ts (4C)
                 feature-catalogue.registry.ts (quét marker) · catalogue-check.ts (code ↔ DB, lúc boot)
                 entitlement-route-inventory.ts (lúc boot) · provision-org.subscriber.ts
                 org-creation.participant.ts · org-purge.participant.ts · member-seat-limit.adapter.ts (4B)
  ports/         org-entitlement.repository.ts · usage-counter.repository.ts (4B) · override.repository.ts (4C)
                 catalogue.reader.ts
  http/          entitlement.interceptor.ts · decorators.ts (FeatureCatalogueContributor)
                 org-entitlements.controller.ts · admin-entitlements.controller.ts (4C) · schemas.ts
  infra/sql/     sql-*.repository.ts (Db.execute trên EM đang gắn; không import @mikro-orm ngoài infra)
src/plans.example.ts                     (vùng template: catalogue gói mẫu; clone có bản chép src/app.plans.ts, vùng dự án)
src/migrations/entitlements/             (vùng boilerplate)
src/migrations/example/…_starter_plans   (vùng template; clone có bản chép ở src/migrations/app/)
```

Hướng phụ thuộc: `entitlements → tenancy (index) → identity (index) → core`; `entitlements → identity (index)` (cho `@PlatformStaffAction` của 3D, `AuthFacts`); **chỉ entry `integrations/files.ts`** → `files (index)` (4B, R-X8); `features → entitlements (index)`; SP5 `billing → entitlements (index)`. **Tenancy, identity, notifications và files không import entitlements** (luật kiến trúc mục 20.5); tenancy và files mở port để entitlements cắm vào (mục 9.6, 9.7, 22.2), cùng mẫu `@Global()` + `@Optional()` của SP3 §5.2.

**Composition (X-7):** catalogue gói tới module qua `composeAppModules({ disable, features, plans })` của SP7 7A: `BOILERPLATE_MODULES.entitlements` là factory `(opts) => ({ api: EntitlementsModule.forApi(opts.plans), worker: EntitlementsModule.forWorker(opts.plans) })`; `plans` bắt buộc khi `entitlements` không nằm trong `disable` (thiếu → `composeAppModules` ném lỗi có tên chỉ tới README "nâng cấp lên SP4"). `MODULE_REQUIRES` thêm `entitlements → tenancy`. **Cặp tuỳ chọn `entitlements + files` (R-X13):** 4B thêm một dòng vào hằng `OPTIONAL_BRIDGES` của `src/boilerplate.modules.ts` (SP7 7A tạo hằng, SP7 §6.2): `{ key: 'entitlements-files', when: ['entitlements', 'files'], load: async () => { const m = await import('./modules/entitlements/integrations/files.js'); return { api: m.EntitlementsFilesPortsModule, worker: m.EntitlementsFilesPortsModule }; } }`. Composition nạp dòng này vào cả api lẫn worker khi **cả hai** module bật, sau khi đã nạp các module (mục 9.7). Nếu 4A merge trước 7A (cùng sóng W2), 4A sửa thẳng `APP_MODULES` hiện có (thêm `EntitlementsModule.forApi(examplePlans)`/`.forWorker(examplePlans)` sau `TenancyModule`) và 7A gộp vào composition; thứ tự merge nào cũng ra cùng kết quả. 4B luôn sau 7A (W4 > W2), nên dòng `OPTIONAL_BRIDGES` không có biến thể "trước composition".

**Nghĩa vụ của SP7 mà SP4 nhận (R-X16), plan 4A:**
- dòng đầu của `modules/entitlements/index.ts` là `markModuleLoaded('entitlements')` (hàm của `core/config`, SP7 7A). Nếu 4A merge trước 7A thì 7A thêm dòng này cùng lúc với dòng của identity, notifications, tenancy (SP7 amendment D1); entry `integrations/files.ts` **không** gọi hàm này (nó không phải module, và nó chỉ được nạp khi cả hai module đã bật);
- dòng `MODULE_REQUIRES`: `entitlements → tenancy` (như trên);
- `.meta({ secret })`: config của SP4 (mục 14) không có trường secret nào, nên không có dòng nào trong `files/secret-env.json` của chart. Trường secret tương lai (ví dụ `REDIS_CACHE_URL` của mục 8.5) bắt buộc mang `.meta({ secret: { roles } })` và chạy `pnpm chart:secrets`.

Bỏ module này (cách tuỳ biến thứ 4 của cha §1.1, `disable: ['entitlements']`): port ghế và port dung lượng vắng → tenancy coi là không giới hạn, files dùng `FILES_ORG_STORAGE_LIMIT_BYTES` của SP6 (kiểm lúc boot của files không đòi adapter vì `loadedModules()` không có `entitlements`, mục 9.7); mọi `requireEnabled` không import được nên không có route nào phụ thuộc.

### 6.3 Pipeline request (bổ sung bước 6 của SP3 §7.1)

```
PrincipalMiddleware → OrgContextMiddleware → APP_GUARD (AuthGuard, AppThrottlerGuard, OrgApiKeyConfinementGuard)
  → PoliciesGuard (route-scoped, CASL)                               ← mọi guard xong
  → OrgScopeInterceptor (APP_INTERCEPTOR: OrgScope.run(orgId, …))
      → EntitlementInterceptor (route-scoped, bởi requireEnabled)    ← [SP4] thay "EntitlementGuard" của SP3 bước 6
      → IdempotencyInterceptor (route, nếu có)                       (thứ tự hai interceptor route không quan trọng, mục 12.3)
      → Handler → service → UnitOfWork (Quotas.consume, Entitlements.assert* trong transaction)
```

### 6.4 API công khai (export ở `index.ts`)

```ts
// Khai báo
export const defineFeatureCatalogue: <const D extends FeatureCatalogueDef>(def: D) => FeatureCatalogue<D>;
//   FeatureCatalogue<D> = { keys: readonly Key<D>[]; requireEnabled(...keys: FlagKey<D>[]): MethodDecorator & ClassDecorator }
export const FeatureCatalogueContributor: (catalogue: FeatureCatalogue<FeatureCatalogueDef>) => ClassDecorator; // marker Discovery
export const definePlanCatalogue: (def: PlanCatalogueDef) => PlanCatalogue;
export const UNLIMITED: unique symbol;                       // giá trị LIMIT/QUOTA không giới hạn trong catalogue gói

// Đọc/kiểm (mọi hàm đòi org context: OrgScope hoặc job có meta.orgId)
export class Entitlements {
  snapshot(): Promise<EntitlementSnapshot>;
  isEnabled(key: string): Promise<boolean>;                  // chỉ FLAG
  assertEnabled(key: string): Promise<void>;                 // → 403 feature_not_in_plan
  limitOf(key: string): Promise<Limit>;                      // LIMIT hoặc QUOTA
  assertWithinLimit(key: string, currentCount: number, adding?: number): Promise<void>; // LIMIT → 422 quota_exceeded
}
export class Quotas {                                        // mọi hàm đòi UnitOfWork đang mở (inTransaction())
  consume(key: string, amount: number): Promise<ConsumeResult>;        // { kind: 'CONSUMED', receipt } | { kind: 'EXCEEDED', limit, used }
  consumeOrThrow(key: string, amount: number): Promise<QuotaReceipt>;  // EXCEEDED → 422 quota_exceeded
  release(receipt: QuotaReceipt): Promise<void>;                        // trả đúng lần tiêu thụ (cùng kỳ của receipt)
  releaseAllocation(key: string, amount: number): Promise<void>;        // chỉ QUOTA kỳ NONE (vd. xoá bản ghi đã tính quota)
}
// Điểm nối SP5 (mục 10, hợp đồng R-X1)
export class PlanAssignments {
  assign(cmd: AssignPlanCommand): Promise<AssignmentResult>;  // có hiệu lực lúc commit; lỗi có tên luôn ném trước câu ghi đầu tiên
  defaultPlanKey(): string;                                     // SP5 dùng khi EXPIRED (thay BILLING_FALLBACK_PLAN_KEY, R-X1)
}
export { EntitlementPermissions, EntitlementsModule, entitlementsConfig, PlanChangedEvent, OverrideSetEvent,
         OverrideRemovedEvent, QuotaReachedEvent, type EntitlementSnapshot, type Limit, type QuotaReceipt, … };
// Lớp lỗi có tên (r2, R-X19): caller bắt bằng instanceof, không so chuỗi message
export { EntitlementsErrors,                   // defineErrorCodes: plan_retired, unknown_plan
         EntitlementsContextError,             // thiếu UnitOfWork đang mở hoặc org context (lỗi lắp ráp, 500)
         UnknownPlanError,                     // planKey không có trong catalogue gói của pod hoặc trong bảng plans (500)
         EntitlementsRowMissingError,          // org không có dòng org_entitlements (503 + Retry-After)
         EntitlementsVersionSkewError,         // gói hiện tại của org lạ với pod khi đọc snapshot (503)
         UnknownFeatureError, FeatureKindMismatchError, QuotaReleaseUnderflowError };  // lỗi lập trình (500)
```

**Lỗi mà `PlanAssignments.assign` có thể ném** (hợp đồng mục 10.2, đầy đủ): `EntitlementsContextError`, `UnknownPlanError`, `EntitlementsRowMissingError` (đều trước câu ghi đầu tiên), `AppError(PRECONDITION_FAILED)` chỉ với `PLATFORM_ADMIN`, và lỗi hạ tầng DB. `assign` **không** ném `EntitlementsVersionSkewError`: nó so key gói trong DB, không tra giá trị gói hiện tại trong catalogue của pod, nên gói hiện tại lạ với pod không cản `assign`. SP5 chỉ bắt những lớp có trong danh sách này (R-X19).

Tham số `key` của `Entitlements`/`Quotas` là `string` ở chữ ký runtime nhưng mỗi catalogue export thêm helper có kiểu (`ReportFeatures.key('reports.export')`) để caller có lỗi compile khi gõ sai; key không có trong catalogue gộp đã đăng ký → `UnknownFeatureError` (500, log ERROR). Gọi `isEnabled` trên key không phải `FLAG`, `consume` trên key không phải `QUOTA`, `releaseAllocation` trên `QUOTA` kỳ `MONTH` → `FeatureKindMismatchError` (500): lỗi lập trình, fail loud.

---

## 7. Mô hình dữ liệu

### 7.1 `entitlement_features` (global, tra cứu; 4A)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | `BIGINT GENERATED ALWAYS AS IDENTITY` | PK |
| `key` | `TEXT NOT NULL` | `UNIQUE`; `CHECK (key ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,47}$')` (hằng `FEATURE_KEY_PATTERN`: `<module>.<tên>`) |
| `kind` | `TEXT NOT NULL` | `CHECK (kind IN ('FLAG','LIMIT','QUOTA'))` |
| `reset_period` | `TEXT NULL` | `CHECK (reset_period IN ('NONE','MONTH'))`; `entitlement_features_period_ck CHECK ((kind = 'QUOTA') = (reset_period IS NOT NULL))` |
| `deprecated_at` | `TIMESTAMPTZ NULL` | |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

- Trigger `entitlement_features_immutable` (`BEFORE UPDATE`): `key`, `kind`, `reset_period` đổi → `check_violation`. Đổi loại hay kỳ của tính năng làm dòng override/bộ đếm cũ mất nghĩa; cách đúng là key mới (mục 8.4).
- Ghi chỉ bằng migration (`app_owner`). `app_user`: `SELECT`. Không RLS (`GLOBAL_TABLES`, lý do: catalogue). Index: `UNIQUE (key)` → tra key ở catalogue check, admin API, câu snapshot.
- `fallback`, `minimum` và mô tả **không** vào DB: chỉ code đọc chúng (S4-D2).

### 7.2 `plans` (global, tra cứu; 4A)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | `BIGINT` identity | PK |
| `key` | `TEXT NOT NULL` | `UNIQUE`; `CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$')` (hằng `PLAN_KEY_PATTERN`) |
| `retired_at` | `TIMESTAMPTZ NULL` | |
| `created_at`, `updated_at` | | |

- Trigger `plans_key_immutable` (`BEFORE UPDATE OF key`). Ghi bằng migration của dự án (`src/migrations/app/`; ở upstream là bản mẫu `src/migrations/example/`, S4-D22). `app_user`: `SELECT`. Không RLS (`GLOBAL_TABLES`). Index: `UNIQUE (key)`.
- SP5: `billing_prices.plan_id BIGINT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT` (R-X1; index `(plan_id)` do SP5 tạo cho FK). Vì vậy xoá một dòng `plans` còn giá tham chiếu fail to `23503`; vòng đời "xoá gói" (mục 8.4) thêm bước lưu trữ/xoá giá của SP5 trước.

### 7.3 `org_entitlements` (tenant, gốc aggregate OrgEntitlement; 4A)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `org_id` | `UUID` | PK; `REFERENCES organizations(id) ON DELETE RESTRICT` (neo trực tiếp, amendment B5 của SP3) |
| `plan_id` | `BIGINT NOT NULL` | `REFERENCES plans(id) ON DELETE RESTRICT` |
| `plan_source` | `TEXT NOT NULL` | `CHECK (plan_source IN ('DEFAULT','BILLING','PLATFORM_ADMIN'))` |
| `plan_source_ref` | `TEXT NULL` | `org_entitlements_source_ref_ck CHECK ((plan_source = 'BILLING') = (plan_source_ref IS NOT NULL))`; `CHECK (char_length(plan_source_ref) BETWEEN 1 AND 128)` (id công khai của subscription, opaque) |
| `plan_reason` | `TEXT NULL` | `org_entitlements_reason_ck CHECK ((plan_source = 'PLATFORM_ADMIN') = (plan_reason IS NOT NULL))`; `CHECK (plan_reason = btrim(plan_reason) AND char_length(plan_reason) BETWEEN 1 AND 500)` (hằng `REASON_MAX_LENGTH`) |
| `last_billing_seq` | `BIGINT NULL` | `CHECK (last_billing_seq >= 1)`; lệnh `BILLING` mới nhất đã áp dụng (kể cả khi nguồn hiện tại là nhân viên) |
| `plan_assigned_at` | `TIMESTAMPTZ NOT NULL` | lúc gói hiện tại được gán |
| `version` | `INT NOT NULL DEFAULT 1` | `CHECK (version >= 1)`; ETag, `aggregate.version`; tăng ở **mọi** thay đổi của aggregate (gói, nguồn, override) |
| `created_at`, `updated_at` | | |

- Trigger `org_entitlements_billing_seq_monotonic` (`BEFORE UPDATE OF last_billing_seq`): `NEW.last_billing_seq IS DISTINCT FROM OLD.last_billing_seq AND OLD.last_billing_seq IS NOT NULL AND (NEW.last_billing_seq IS NULL OR NEW.last_billing_seq < OLD.last_billing_seq)` → `check_violation`. Lớp chặn cuối cho E-5 (app đã so dưới khoá). Vế "`IS DISTINCT FROM`" (r1) để câu `APPLIED` của `PLATFORM_ADMIN` (`last_billing_seq = COALESCE(NULL, last_billing_seq)`, giá trị không đổi nhưng cột có trong `SET`) không bị chặn nhầm; tăng lùi hoặc xoá về `NULL` vẫn bị chặn.
- Trigger `org_entitlements_plan_not_retired` (`BEFORE INSERT OR UPDATE OF plan_id`): gói đích có `retired_at` và (INSERT, hoặc `NEW.plan_id <> OLD.plan_id`) → `check_violation`. Org đang ở gói đã retire giữ được gói đó (gia hạn giữ nguyên), không ai gán **mới** vào gói đã retire.
- RLS: `ENABLE` + `FORCE`; policy `org_entitlements_tenant TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`.
- Grant `app_user`: `SELECT, INSERT, DELETE, UPDATE (plan_id, plan_source, plan_source_ref, plan_reason, last_billing_seq, plan_assigned_at, version, updated_at)`. `org_id`, `created_at` không có `UPDATE`.
- Index: PK `(org_id)` → câu snapshot, khoá khi gán gói, đích FK của hai bảng con; `org_entitlements_plan_idx (plan_id)` → kiểm FK `RESTRICT` khi migration xoá dòng `plans` (không bắt đầu bằng `org_id`: FK từ bảng global, ngoại lệ có tên B6 của SP3).

### 7.4 `org_entitlement_overrides` (tenant, con của OrgEntitlement; 4C)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `org_id` | `UUID NOT NULL` | `REFERENCES org_entitlements(org_id) ON DELETE RESTRICT` (neo bắc cầu tới `organizations`) |
| `feature_id` | `BIGINT NOT NULL` | `REFERENCES entitlement_features(id) ON DELETE RESTRICT` |
| `flag_value` | `BOOLEAN NULL` | |
| `limit_value` | `BIGINT NULL` | `CHECK (limit_value BETWEEN 0 AND 9007199254740991)`; `NULL` với tính năng số = không giới hạn |
| `reason` | `TEXT NOT NULL` | `CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)` |
| `expires_at` | `TIMESTAMPTZ NULL` | `NULL` = vĩnh viễn |
| `created_at`, `updated_at` | | PK `(org_id, feature_id)`; `CHECK (num_nonnulls(flag_value, limit_value) <= 1)` |

- Trigger `org_entitlement_overrides_value_ck` (`BEFORE INSERT OR UPDATE`): đọc `kind`, `deprecated_at` của tính năng; `FLAG` → `flag_value IS NOT NULL AND limit_value IS NULL`; `LIMIT`/`QUOTA` → `flag_value IS NULL`; tính năng đã deprecate → từ chối. Không lặp `kind` vào bảng (giữ 3NF, S4-D1).
- Không có `version` riêng: override thuộc aggregate `org_entitlements`; mọi ghi override khoá dòng gốc và tăng `org_entitlements.version` cùng transaction.
- Hết hạn là **suy ra** (`expires_at > now()` khi đọc); dòng hết hạn nằm lại tới khi bị ghi đè/xoá/purge (không event, như link hết hạn của SP3 §14.1).
- RLS như 7.3. Grant `app_user`: `SELECT, INSERT, DELETE, UPDATE (flag_value, limit_value, reason, expires_at, updated_at)`.
- Index: PK `(org_id, feature_id)` → câu snapshot (quét theo `org_id`), upsert/xoá của admin; `org_entitlement_overrides_feature_idx (feature_id)` → kiểm FK `RESTRICT` khi migration xoá tính năng (FK từ bảng global).

### 7.5 `usage_counters` (tenant, aggregate UsageCounter; 4B)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | `BIGINT` identity | PK (cần vì khoá tự nhiên có cột `NULL`) |
| `org_id` | `UUID NOT NULL` | `REFERENCES org_entitlements(org_id) ON DELETE RESTRICT` |
| `feature_id` | `BIGINT NOT NULL` | `REFERENCES entitlement_features(id) ON DELETE RESTRICT` |
| `period_start` | `TIMESTAMPTZ NULL` | `NULL` ⇔ kỳ `NONE` |
| `used` | `BIGINT NOT NULL DEFAULT 0` | `CHECK (used BETWEEN 0 AND 9007199254740991)` |
| `version` | `BIGINT NOT NULL DEFAULT 0` | `CHECK (version >= 0)`; tăng ở mỗi consume/release (`aggregate.version` của `quota.reached`) |
| `created_at`, `updated_at` | | `usage_counters_period_uq UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)` |

- Trigger `usage_counters_period_ck` (`BEFORE INSERT`): tính năng phải `QUOTA`, không deprecated, và `(reset_period = 'NONE') = (period_start IS NULL)`. Căn đầu kỳ (`period_start` đúng là đầu tháng theo múi giờ) do câu SQL duy nhất tính (mục 9.2), không kiểm ở DB vì múi giờ là config.
- Không `CHECK (used <= limit)`: trần đổi theo gói, và `used > limit` sau khi hạ gói là trạng thái hợp lệ (S4-D13).
- RLS như 7.3. Grant `app_user`: `SELECT, INSERT, DELETE, UPDATE (used, version, updated_at)`.
- Index: `usage_counters_period_uq` → arbiter của consume, release, đọc usage kỳ hiện tại; `usage_counters_feature_idx (feature_id)` → FK `RESTRICT` từ bảng global. PK `id` không phục vụ query nào ngoài `aggregate.id` (có sẵn theo PK).

### 7.6 Chuẩn hoá (cha §4, bắt buộc)

| Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng chuẩn | Ghi chú |
|---|---|---|---|---|
| `entitlement_features` | `{id}`, `{key}` | — | **BCNF** | `reset_period` chỉ có với `QUOTA` (`CHECK` hai chiều), vẫn là thuộc tính của khoá |
| `plans` | `{id}`, `{key}` | — | **BCNF** | Giá trị gói ở code (S4-D2), không có trong DB nên không có dị thường cập nhật |
| `org_entitlements` | `{org_id}` | — | **BCNF** | `plan_source_ref`, `plan_reason` là thuộc tính của lần gán hiện tại (khoá là org); `last_billing_seq` là sự thật độc lập (lệnh billing mới nhất đã áp), không phụ thuộc `plan_source` |
| `org_entitlement_overrides` | `{org_id, feature_id}` | — | **BCNF** | Không lặp `kind` (trigger đọc từ `entitlement_features`) |
| `usage_counters` | `{id}`, `{org_id, feature_id, period_start}` (trên dòng, `NULLS NOT DISTINCT`) | — | **BCNF** | Không có cột dẫn xuất (trần không lưu ở đây) |

Không có ngoại lệ phi chuẩn hoá. Test `normalization-inventory.spec.ts` (SP3) thêm mọi cột của 5 bảng.

### 7.7 Migration theo plan (khoá, down)

Mỗi plan một migration riêng trong `src/migrations/entitlements/`, timestamp sau mọi migration SP3; quy tắc chung của SP3 §6.13 (down đối xứng xoá cả hàm trigger; không `isTransactional() = false`; sweep S2-R57 từng bước; không rò `SET CONSTRAINTS`).

| Plan | Migration | Nội dung | Khoá (giữ tới hết lô) | Down |
|---|---|---|---|---|
| 4A | `entitlements/…_entitlements_core` | Bảng `entitlement_features`, `plans`, `org_entitlements` + index, RLS, policy, grant; hàm + trigger `entitlement_features_immutable`, `plans_key_immutable`, `org_entitlements_billing_seq_monotonic`, `org_entitlements_plan_not_retired`; chèn tính năng boilerplate `tenancy.seats` (`LIMIT`); chèn quyền `entitlements.read` vào `permissions` + cạnh `permission_requires` tới `org.read` (vòng đời "Thêm" của SP3 §8.8, bảng global không FORCE) | Bảng mới; `SHARE ROW EXCLUSIVE` trên `organizations` (FK) và `permissions` (FK của `permission_requires`) | `DELETE` cạnh + dòng `entitlements.read` (fail to `23503` nếu còn role tuỳ biến/key/grant giữ quyền: runbook thu hồi trước, như SP3 vòng đời "Xoá"); `DROP TABLE org_entitlements, plans, entitlement_features`; `DROP FUNCTION` 4 hàm trigger |
| 4A | `example/…_starter_plans` (vùng template; clone: bản chép `app/<timestamp mới>_starter_plans`, S4-D22) | `INSERT INTO plans (key) VALUES ('free'), ('pro')`; backfill: theo mẫu 7 bước SP3 §8.8 trên tập `ENTITLEMENT_BACKFILL_TABLES = organizations, org_entitlements` (thứ tự cố định): `NO FORCE` → `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT o.id, p.id, 'DEFAULT', now() FROM organizations o CROSS JOIN plans p WHERE p.key = 'free' ON CONFLICT (org_id) DO NOTHING` → `INSERT outbox_events` một `entitlements.plan.changed@1` mỗi dòng vừa chèn (CTE `RETURNING`, actor `{ type: 'system', id: 'migration:<tên>' }`, envelope dựng bằng SQL theo cột `outbox_events`; nếu SP6 6.0 lưu cờ `audit`/`webhook` trong envelope hoặc cột outbox thì migration ghi đúng giá trị của `PlanChangedEvent` (R-X3); test contract parse bằng `parseEnvelope` và so cờ với định nghĩa event) → bước 4/5 (xả/trả chế độ constraint theo tên) → `FORCE` → khẳng định FORCE | `ACCESS EXCLUSIVE` ngắn trên `organizations` và `org_entitlements` (NO FORCE/FORCE): chặn câu đường nóng SP3 §7.3 trong lô; runbook: cửa sổ ít tải | Mẫu 7 bước: `NO FORCE` → còn dòng `plan_source <> 'DEFAULT'` (gán bởi billing/nhân viên) → `RAISE` "còn gói đã gán bởi billing/nhân viên; rollback sẽ mất dữ liệu đó" (không mất dữ liệu âm thầm, như "down khi có dữ liệu chặn" của SP3 §6.13) → không thì `DELETE FROM org_entitlements` (mọi dòng còn lại là `DEFAULT`, dẫn xuất lại được) → `FORCE` → khẳng định → `DELETE FROM plans WHERE key IN ('free','pro')` (FK `RESTRICT` fail to nếu SP5 đã có giá tham chiếu) |
| 4B | `entitlements/…_usage_counters` | Bảng `usage_counters` + index, RLS, policy, grant; hàm + trigger `usage_counters_period_ck`; chèn tính năng boilerplate `files.storage_bytes` (`LIMIT`, R-X8) | Bảng mới; `SHARE ROW EXCLUSIVE` trên `org_entitlements`, `entitlement_features` | `DELETE` dòng `files.storage_bytes` (fail to `23503` nếu 4C đã có override trên nó: runbook xoá override trước); `DROP TABLE usage_counters`; `DROP FUNCTION` hàm trigger |
| 4C | `entitlements/…_overrides` | Bảng `org_entitlement_overrides` + index, RLS, policy, grant; hàm + trigger `org_entitlement_overrides_value_ck` | như 4B | `DROP TABLE`; `DROP FUNCTION` |

- **Vùng (S4-D22, X-6):** upstream ship migration khởi đầu và `src/plans.example.ts` ở **vùng template** (SP7 §6.1). Upstream chạy chúng trong CI như mọi migration (migrator đọc đệ quy `dist/migrations/**`). Ở clone, `upstream:init` (SP7 §6.3.4) chép hai file sang vùng dự án (`src/app.plans.ts`; migration tạo mới bằng `mikro-orm migration:create --blank --path src/migrations/app` rồi dán thân, nên timestamp mới hơn mọi migration module đang có) rồi xoá vùng template như với mẫu SP7. Dự án sửa key gói, gói mặc định và backfill theo gói thật trước lần deploy đầu có SP4; thêm gói về sau là migration mới của dự án. Upstream không bao giờ sửa bản chép.
- **Clone đã `upstream:init` trước khi có SP4** (vùng template đã xoá, `upstream:sync` giữ nó xoá): README "nâng cấp lên SP4" hướng dẫn chép hai file từ tag upstream (`git show <tag>:src/plans.example.ts`, cùng cách 6.3.3 bước 1 của SP7) trước khi deploy; `composeAppModules` thiếu `plans` thì ném lỗi có tên chỉ tới đoạn README đó.
- **Thứ tự:** bỏ luật r0 "file `app/` mới nhất lớn hơn mọi thư mục module". Luật thứ tự của SP3 áp **trong từng vùng** (SP7 S7-D31, B1); điều kiện chéo vùng duy nhất cần ở đây là migration `app/` chèn vào bảng của boilerplate phải chạy sau migration tạo bảng đó: bản chép có timestamp mới lúc `init`, còn test chạy thư mục `app/` sau mọi migration module trên DB rỗng của SP7 bắt ca lệch.
- Dự án clone mới (chưa có org) chạy backfill trên bảng rỗng: không đổi gì.

---

## 8. Đánh giá entitlement

### 8.1 Catalogue tính năng

```ts
export const ReportFeatures = defineFeatureCatalogue({
  'reports.export':       { kind: 'FLAG',  fallback: false,  description: '…' },
  'reports.scheduled':    { kind: 'LIMIT', fallback: { max: 0 }, minimum: 0 },
  'reports.api_calls':    { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 0 } },
  'reports.saved_reports': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: { max: 0 } },   // consume khi tạo, releaseAllocation khi xoá
  'reports.legacy_pdf':   { kind: 'FLAG',  fallback: false, deprecated: true },
} as const);

@FeatureCatalogueContributor(ReportFeatures)
@Injectable() export class ReportFeaturesProvider {}
```

- Kiểu `fallback`: `FLAG` → `boolean`; `LIMIT`/`QUOTA` → `{ max: number } | typeof UNLIMITED`. `minimum` (mặc định `0`) là giá trị nhỏ nhất gói/override được đặt (ví dụ `tenancy.seats` có `minimum: 1`: org phải chứa được người tạo).
- **Mỗi key có đúng một `kind`** trên catalogue gộp: một thứ vừa cần cổng bật/tắt vừa cần trần thì khai báo hai key (ví dụ `example.projects` `FLAG` và `example.project_count` `QUOTA`, xem SP7 Q-2).
- **Catalogue của boilerplate** (`features.ts`):
  - `tenancy.seats` (`LIMIT`, `fallback: UNLIMITED`, `minimum: 1`) — `fallback` giữ hành vi SP3 (S4-D3). 4A.
  - `files.storage_bytes` (`LIMIT`, đơn vị byte, `fallback: { max: FILES_STORAGE_FALLBACK_BYTES }`, `minimum: 0`) — hằng có tên `FILES_STORAGE_FALLBACK_BYTES = 1_073_741_824` (1 GiB, phán quyết C4) để org trên gói không nhắc tới tính năng này có đúng hạn mức mặc định của SP6. 4B (R-X8, mục 9.7). Khai báo **luôn**, kể cả khi dự án tắt files: dòng DB do migration 4B chèn vô điều kiện, nên catalogue phải khớp; tính năng không có người dùng thì chỉ hiện trong `GET …/entitlements`.
- Provider đặt ở **cả** `forApi()` lẫn `forWorker()` của module chủ (như catalogue quyền, SP3 §8.2 INT3-5); điều này áp cho cả `EntitlementPermissions` lẫn catalogue tính năng. Registry quét trong `onModuleInit`; provider không singleton tĩnh → ném lúc boot.
- **Kiểm catalogue (unit, boot):** key khớp `FEATURE_KEY_PATTERN`, duy nhất trên tập gộp; `fallback` và `minimum` đúng kiểu; `fallback` số ≥ `minimum`; `QUOTA` có `resetPeriod`, loại khác thì không.

### 8.2 Catalogue gói

```ts
// src/plans.example.ts (vùng template, upstream); clone: src/app.plans.ts (vùng dự án, export appPlans)
export const examplePlans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: {
    free: { values: { } },                                   // mọi tính năng dùng fallback
    pro:  { values: { 'tenancy.seats': UNLIMITED } },
    // legacy: { retired: true, values: { … } },
  },
});
```

- **Luật kiểm lúc boot** (hàm thuần `validatePlanCatalogue(plans, mergedFeatures)`, unit test đủ nhánh): key gói khớp `PLAN_KEY_PATTERN`; mọi key trong `values` có trong catalogue gộp và không deprecated; giá trị đúng kiểu `kind`; số ≥ `minimum` và ≤ `ENTITLEMENT_VALUE_MAX`; `defaultPlan` tồn tại và không `retired`. Vi phạm → không khởi động, log liệt kê từng lỗi.
- Log INFO lúc boot: với mỗi gói, danh sách tính năng đang dùng `fallback` (không có giá trị, chỉ key) — dự án thấy ngay tính năng mới từ upstream đang ở mặc định.
- Catalogue mẫu để `tenancy.seats` ở `fallback` (không giới hạn) và `files.storage_bytes` ở `fallback` (1 GiB) cho `free`: không đổi hành vi của test SP3 (link `N + k`, O-12…) và SP6; dự án đặt số thật. Test của SP4 dùng catalogue gói fixture.

### 8.3 Kiểm catalogue với DB (`EntitlementCatalogueCheck`, api và worker, `onModuleInit`)

`onModuleInit`, không phải `onApplicationBootstrap`: `WorkerHost` và `OutboxRelay` bắt đầu consume ở `onApplicationBootstrap`, nên worker lệch catalogue phải bị từ chối trước khi nhận job nào (cùng lý do `CatalogueCheck` của SP3, commit 0bcabd9). `EntitlementRouteInventory` giữ `onApplicationBootstrap` (chỉ api, HTTP chưa listen lúc đó).


- So `{ key, kind, reset_period, deprecated? }` của catalogue tính năng gộp với `entitlement_features`; so `{ key, retired? }` của catalogue gói với `plans`. Khác (thiếu, thừa, khác thuộc tính) → log ERROR liệt kê từng khác biệt, `entitlements_catalogue_mismatch_total` +1, **dừng khởi động** (như `CatalogueCheck` của SP3 §8.8). Test integration chạy cùng phép so.
- `EntitlementRouteInventory` (api, `onApplicationBootstrap`, `DiscoveryService` + `Reflector`): handler có metadata `requireEnabled` mà (a) không phải route tenant theo bộ phân loại của tenancy (`classifyTenantHandler`, export mới, mục 22.2), (b) key không có trong catalogue đã đăng ký (catalogue của decorator phải nằm trong registry, như luật INT3-5a của SP3), (c) key không phải `FLAG` hoặc đã deprecated → không khởi động.

### 8.4 Hàm hiệu lực và snapshot

`resolveEffective(feature, planValue | undefined, override | undefined): EffectiveValue` — hàm thuần, `switch (feature.kind)` vét cạn có kiểm `never`:
- nguồn: override còn hạn → `OVERRIDE`; không thì giá trị gói → `PLAN`; không thì `fallback` → `FALLBACK`;
- `EffectiveValue = { kind: 'FLAG'; enabled; source } | { kind: 'LIMIT'; limit: Limit; source } | { kind: 'QUOTA'; limit: Limit; resetPeriod; source }`, `Limit = { kind: 'UNLIMITED' } | { kind: 'MAX'; max: number }`.

**Câu snapshot** (một câu, trong org context; `$1` không có — dùng `app_current_org()`):

```sql
SELECT e.version, e.plan_source, p.key AS plan_key, f.key AS override_feature,
       o.flag_value, o.limit_value, o.expires_at
FROM org_entitlements e
JOIN plans p ON p.id = e.plan_id
LEFT JOIN org_entitlement_overrides o
       ON o.org_id = e.org_id AND (o.expires_at IS NULL OR o.expires_at > now())   -- 4C
LEFT JOIN entitlement_features f ON f.id = o.feature_id                            -- 4C
WHERE e.org_id = app_current_org();
```

- Index: PK `org_entitlements`, PK `plans`, PK override (quét theo `org_id`), PK `entitlement_features`. Plan 4A kèm `EXPLAIN (ANALYZE, BUFFERS)` trên seed 10.000 org × 5 override.
- 0 dòng → `EntitlementsRowMissingError`: log ERROR `{ event: 'entitlements_row_missing' }`, `entitlements_row_missing_total` +1, **`503 service_unavailable`** + `Retry-After: ENTITLEMENTS_ROW_MISSING_RETRY_AFTER_SEC` (lý do: cửa sổ rolling deploy tự lành nhờ subscriber, mục 13; kéo dài thì alert).
- `plan_key` không có trong catalogue của pod này (pod cũ lúc rolling deploy thấy gói vừa thêm) → `EntitlementsVersionSkewError`: log ERROR `entitlements_unknown_plan`, `503`. Override cho key tính năng pod này không biết → bỏ qua override đó, log WARN `entitlements_unknown_override_feature` (pod không có code nào kiểm tính năng đó nên bỏ qua không làm sai quyết định nào).
- **Vòng đời tính năng:** thêm = code + migration chèn dòng; deprecate (bản N) = code `deprecated: true` + migration đặt `deprecated_at` (không nhận override/bộ đếm mới: trigger); xoá (bản N+1) = migration xoá override và bộ đếm của key đó rồi xoá dòng (FK `RESTRICT` làm xoá thiếu bước fail to). Đổi `kind`/kỳ = key mới (trigger immutable). **Vòng đời gói:** thêm = code + migration chèn dòng (gán gói mới chỉ sau khi mọi pod chạy bản biết gói đó, F-6); retire = lưu trữ mọi giá SP5 còn bán gói đó (SP5 chặn lúc boot giá chưa lưu trữ trỏ tới gói đã retire, R-X1) rồi code `retired: true` + migration đặt `retired_at`; xoá = migration chuyển org khỏi gói, xoá giá SP5 tham chiếu (FK `RESTRICT`) rồi xoá dòng. **Đổi giá trị của gói** = sửa code, không migration.

### 8.5 Cache (không có ở v1; thiết kế khi đo được là cần)

- **v1:** không cache (S4-D8). Mỗi `Entitlements.*` đọc một câu snapshot; interceptor đọc một lần cho mọi key của route; `Quotas.consume` đọc lại **trong** transaction của caller (thấy override/gói vừa ghi trong cùng transaction). Không memo trong CLS: request đổi gói rồi kiểm tính năng trong cùng request sẽ đọc giá trị cũ.
- **Điều kiện bật** (ghi ở ADR 0018): p95 của `entitlements_snapshot_read_duration_seconds` hoặc số câu snapshot/giây đo trên load test k6 ở 600 RPS (cha §14) vượt ngân sách của API đọc p95 < 200 ms.
- **Thiết kế khi bật** (một plan riêng, không thuộc SP4):
  - Redis **riêng** cho cache (`REDIS_CACHE_URL`, `maxmemory` + `allkeys-lru`, cha §4), client ioredis thứ hai do `core/redis` tạo (không thêm package). `REDIS_CACHE_URL` có thể chứa mật khẩu nên khai báo là **secret** trong metadata config (danh sách secret sinh từ code của SP7, OPS-1), không để regex tên đoán. Khoá `{ns}:entitlements:v{SCHEMA}:{orgId}` (helper khoá của cha §8), TTL `ENTITLEMENTS_CACHE_TTL_SEC` ≤ 60 ± 10% jitter; giá trị là snapshot kèm `version`.
  - **Invalidation có version:** mọi thay đổi aggregate đã tăng `org_entitlements.version` cùng transaction; sau commit ghi **bia mộ** `{ version: v_new, tombstone: true }` (không `DEL`), lỗi Redis chỉ log WARN (TTL chặn trên độ cũ). Đọc: bia mộ hoặc trượt → đọc DB → ghi lại bằng Lua `SET` **chỉ khi** `version` mới ≥ `version` đang có. Vì vậy một request đọc DB trước khi thay đổi commit không ghi đè được giá trị mới hơn (race "ghi lại bản cũ" của mẫu `DEL` + `wrap`); độ cũ tối đa là các request đang bay lúc commit.
  - Không bao giờ cache: bộ đếm quota, câu đọc trong `Quotas.consume`, câu khoá của `PlanAssignments.assign`, API admin.
  - Lý do không dùng `cache-manager` 7 + `@keyv/redis` của cha §8: `wrap`/`set` không có so sánh version khi ghi, nên không chặn được race trên; thêm `@redis/client` làm client Redis thứ hai (cha §17 đòi một major ioredis cho cả cây, và mỗi dependency phải trả giá kích thước image).

---

## 9. Quota và giới hạn

### 9.1 Receipt

`QuotaReceipt = { featureKey: string; periodStart: string | null; amount: number }` (ISO UTC). `consume` trả receipt; `release(receipt)` trả đúng lần đó về đúng dòng kỳ của nó.

### 9.2 Consume (một câu, trong transaction của caller)

Tiền điều kiện (lỗi lập trình, 500): `uow.inTransaction()` và `ctx.orgId()` có (không thì `EntitlementsContextError`); key là `QUOTA` (không thì `FeatureKindMismatchError`); `amount` là số nguyên `1 … ENTITLEMENT_VALUE_MAX`.

1. Đọc snapshot (mục 8.4) trong transaction → `limit` hiệu lực.
2. `limit = MAX(m)` và `amount > m` → trả `EXCEEDED` ngay (không SQL).
3. Kỳ `MONTH`:

```sql
INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
VALUES (app_current_org(), $featureId, date_trunc('month', now(), $tz), $amount, 1)
ON CONFLICT (org_id, feature_id, period_start)
DO UPDATE SET used = usage_counters.used + EXCLUDED.used,
              version = usage_counters.version + 1, updated_at = now()
WHERE usage_counters.used + EXCLUDED.used <= $limit          -- bỏ WHERE khi UNLIMITED
RETURNING id, used, version, period_start;
```

   Kỳ `NONE`: `period_start` là `NULL` (arbiter `NULLS NOT DISTINCT`, spike S4-T2).
   - `$featureId` lấy từ bản đồ `key → id` mà `EntitlementCatalogueCheck` nạp lúc boot (dòng `entitlement_features` bất biến nhờ trigger, chỉ migration của bản mới xoá được), nên câu không phụ thuộc một phép tra có thể trả 0 dòng và bị hiểu nhầm là `EXCEEDED`.
   - `date_trunc(text, timestamptz, text)` (PG ≥ 16) tính đầu tháng theo múi giờ config từ `now()` của DB (cha §5 "mốc nghiệp vụ lấy `now()` của DB"); consume và release trong cùng transaction luôn cùng kỳ.
4. 1 dòng → `CONSUMED { receipt }`; nếu `limit = MAX(m)` và `used ≥ m` và `used − amount < m` → phát `entitlements.quota.reached` cùng transaction (S4-D16). 0 dòng → `EXCEEDED { limit, used: <đọc lại dòng> }`, metric `result="exceeded"`.

**Vì sao không vượt trần:** nhánh `DO UPDATE` khoá dòng xung đột rồi mới tính `WHERE` trên **phiên bản mới nhất** của dòng; hai consume song song tuần tự hoá trên khoá dòng, bên sau thấy `used` của bên trước (E-1). Nhánh `INSERT` chỉ xảy ra với dòng chưa có, khi đó `used = amount ≤ limit` đã kiểm ở bước 2; hai `INSERT` đồng thời thì bên sau chờ index unique rồi đi nhánh `DO UPDATE` (E-2).

**Trần đọc ở bước 1** là trần tại thời điểm snapshot của transaction; gói/override đổi đồng thời được xếp thứ tự "sau" lần tiêu thụ này (E-4), không làm `used` vượt trần hiệu lực lúc tiêu thụ.

**Idempotency:** consume nằm trong transaction của side effect, nên nó có đúng bảo đảm của caller: request `@Idempotent()` trả lại response đã lưu (không chạy lại transaction); subscriber có Inbox cùng transaction; job phải idempotent theo dữ liệu (cha §6). Consume trong một transaction riêng tách khỏi side effect là cách dùng sai, README ghi rõ.

### 9.3 Release

```sql
UPDATE usage_counters SET used = used - $amount, version = version + 1, updated_at = now()
WHERE org_id = app_current_org() AND feature_id = $featureId
  AND period_start = $periodStart            -- kỳ NONE: "AND period_start IS NULL" (hai biến thể, đều dùng index)
  AND used >= $amount
RETURNING used;
```

- 0 dòng → `QuotaReleaseUnderflowError` (500, log ERROR `quota_release_underflow`): trả nhiều hơn đã dùng là lỗi lập trình, không kẹp về 0 âm thầm. `CHECK (used >= 0)` là lớp chặn cuối.
- `release(receipt)`: dùng kỳ của receipt (trả trong kỳ cũ không ảnh hưởng kỳ hiện tại). `releaseAllocation(key, amount)`: chỉ `QUOTA` kỳ `NONE` (xoá bản ghi ngày hôm sau không có receipt; người dùng đầu tiên là feature mẫu của SP7, `example.project_count`).
- Không có release qua HTTP; chỉ code của module chủ gọi.

### 9.4 Trạng thái hiển thị của quota (suy ra, không lưu)

`QuotaState = 'WITHIN' | 'REACHED' | 'OVER_LIMIT'`: `used < max` → `WITHIN`; `used = max` → `REACHED`; `used > max` (sau hạ gói/override nhỏ hơn) → `OVER_LIMIT`; `UNLIMITED` → `WITHIN`. Hàm thuần, `switch` vét cạn trên `Limit`.

### 9.5 `LIMIT` (module tự đếm)

`Entitlements.limitOf(key)` trả `Limit`; `assertWithinLimit(key, currentCount, adding = 1)`: `MAX(m)` và `currentCount + adding > m` → `422 quota_exceeded` với `errors[{ path: 'feature', code: key }]`. **Caller phải đếm dưới khoá tuần tự hoá** mọi đường thêm (README; check-then-insert không khoá là sai). Tài nguyên không có khoá sẵn thì dùng `QUOTA` kỳ `NONE` (consume khi tạo, `releaseAllocation` khi xoá, cùng transaction).

### 9.6 Số ghế (tenancy × entitlements, 4B)

- **Port mới của tenancy** (export ở `tenancy/index.ts`, amendment 3A-code, mục 22.2): `abstract class MemberSeatLimit { abstract current(): Promise<SeatLimit> }`, `SeatLimit = { kind: 'UNLIMITED' } | { kind: 'MAX'; max: number; featureKey: string }`; inject `@Optional()` trong `MemberAdmission`; entitlements cung cấp qua module `@Global()` `EntitlementsTenancyPortsModule` trong `forApi()` **và** `forWorker()` (admission chạy ở api; worker không admit nhưng giữ đối xứng, test X-10 của SP3 chạy trên composition thật).
- **Trong `MemberAdmission`** (đã khoá org `FOR NO KEY UPDATE`, SP3 §9): sau khoá `tenancy_users`, trước `INSERT org_members`: `SELECT count(*) FROM org_members WHERE org_id = app_current_org()` (index `(org_id, …)`, chỉ quét index); `seat.current()`; `MAX(m)` và `count + 1 > m` → `422 quota_exceeded` với `errors[{ path: 'feature', code: featureKey }]`, không thay đổi gì (lời mời giữ `PENDING`, link không tăng `use_count` vì rollback). Port vắng → không giới hạn.
- **Ghế = một dòng `org_members`.** Lời mời `PENDING`, org API key, support grant không chiếm ghế; tạo lời mời không kiểm ghế (kiểm lúc chấp nhận — người được mời có thể chờ tới khi org nâng gói).
- **Người tạo org:** participant tạo `org_entitlements` chạy **trước** `MemberAdmission` của người tạo (S4-T3), và `minimum: 1` của `tenancy.seats` bảo đảm người tạo luôn vào được.
- Race: E-6 (khoá org của SP3 tuần tự hoá mọi admission; đếm chạy sau khoá dưới `READ COMMITTED` nên thấy dòng đã commit).

### 9.7 Dung lượng file (files × entitlements, 4B; hợp đồng adapter theo R-X8, R-X13)

Cùng mẫu 9.6: chủ tài nguyên (SP6 files) đếm dưới khoá của mình, SP4 chỉ trả trần. Không có bộ đếm thứ hai.

**Port `FileStorageLimit` (r2: một tên, SP6 sở hữu vì là bên dùng, R-X13; SP6 định nghĩa và export ở `modules/files/index.ts`, inject `@Optional()` nơi files kiểm dung lượng, SP6 §8.1 bước 4):**

```ts
export abstract class FileStorageLimit {
  /** Trần dung lượng hiệu lực của org trong context hiện tại. Gọi trong UnitOfWork + OrgScope của files. */
  abstract current(): Promise<StorageLimit>;
}
export type StorageLimit =
  | { kind: 'UNLIMITED' }
  | { kind: 'MAX'; max: number; featureKey: string };   // max: byte, số nguyên 0 … 2^53 − 1
```

Hình dạng trùng `SeatLimit` (9.6) và `Limit` của SP4 có thêm `featureKey`; mỗi module tự khai báo kiểu vì files không được import entitlements. SP4 không khai báo lại class nào: adapter import `FileStorageLimit` và `StorageLimit` từ `modules/files/index.ts`.

**Adapter (SP4, `modules/entitlements/integrations/files.ts`):** `FileStorageLimitAdapter extends FileStorageLimit` gọi `Entitlements.limitOf('files.storage_bytes')` và ánh xạ `{ kind: 'UNLIMITED' }` → `UNLIMITED`, `{ kind: 'MAX', max }` → `{ kind: 'MAX', max, featureKey: 'files.storage_bytes' }` bằng `switch` vét cạn trên `Limit`. Cài bằng module `@Global()` `EntitlementsFilesPortsModule` (`providers: [{ provide: FileStorageLimit, useClass: FileStorageLimitAdapter }]`, `exports: [FileStorageLimit]`), cùng một module cho api và worker (worker cần cho `FileStore.saveGenerated` của SP6).

**Hợp đồng (bảo đảm của SP4 cho SP6):**
1. **Tiền điều kiện:** có `ctx.orgId()` (OrgScope của request hoặc job có `meta.orgId`); gọi trong transaction của files để đọc đúng override/gói vừa ghi. Thiếu org context → `EntitlementsContextError` (500, lỗi lắp ráp).
2. **Giá trị:** trần hiệu lực theo `OVERRIDE > PLAN > FALLBACK` (8.4) tại snapshot của câu đọc; không cache (S4-D8), nên nâng gói có hiệu lực ngay ở lần upload kế tiếp.
3. **Không khoá, không ghi:** một câu snapshot `SELECT`, không `FOR …`. Files đã giữ khoá dòng `organizations` (`OrgMutationLock`, đầu thứ tự khoá mục 3.6) khi gọi; adapter không lấy khoá nào sau đó.
4. **Lỗi:** thiếu dòng `org_entitlements` → `EntitlementsRowMissingError` (503 + `Retry-After`); DB lỗi → `503`; không có kết quả nào khác. Adapter không bao giờ trả "không giới hạn" khi đọc lỗi (fail closed).
5. **Việc của SP6** (r2 theo SP6 r1, thay mô tả `used_bytes` của r0): dưới `OrgMutationLock`, `used = SUM(stored_bytes)` trên dòng `files` còn object của org (SP6 §6.3, §8.1 bước 4); `used + sizeBytes > max` → `422 quota_exceeded` với `errors[{ path: 'feature', code: featureKey }]` (S4-D14); `used > max` sau hạ gói là trạng thái hợp lệ `OVER_LIMIT`, chỉ chặn upload mới (S4-D13). Port vắng (entitlements tắt) → SP6 dùng `FILES_ORG_STORAGE_LIMIT_BYTES` (mặc định 1 GiB, phán quyết C4); khi port có mặt, env đó không được dùng (luật config và log WARN là việc của SP6).
6. **Nạp và kiểm lúc boot (R-X13):**
   - SP7 composition nạp `EntitlementsFilesPortsModule` vào **cả** api lẫn worker chỉ khi `entitlements` và `files` cùng bật, qua dòng `entitlements-files` của `OPTIONAL_BRIDGES` (mục 6.2). Entry riêng vì import `modules/files/index.ts` sẽ đăng ký config của files lúc import (`defineConfig`), làm boot đòi env của files kể cả khi files tắt. Luật kiến trúc 20.8-d: chỉ `src/boilerplate.modules.ts` được import entry này.
   - **Kiểm lúc boot** (định nghĩa ở SP6 §8.1 bước 4, F-34): files, trong `onApplicationBootstrap` của api và worker, thấy `loadedModules().has('entitlements')` (hàm của `core/config`, SP7 7A) mà `FileStorageLimit` không có provider → log ERROR `{ event: 'file_storage_limit_adapter_missing' }` và ném, app không khởi động. Nhờ vậy trần theo gói không bao giờ bị thay âm thầm bằng 1 GiB của config.
   - **Plan mang code kiểm:** 4B (plan merge sau trong cặp 6A/4B theo R-X7, W4 > W3), như một task "sửa code của 6A". Nếu 6A mang kiểm này thì `main` giữa W3 và W4 (entitlements bật, chưa có adapter) không khởi động được. 4B thêm adapter, dòng `OPTIONAL_BRIDGES` và kiểm lúc boot trong cùng một PR, nên không có trạng thái `main` nào có kiểm mà không có adapter.

Race: E-17.

---

## 10. Gán gói và điểm nối SP5

### 10.1 Lệnh và kết quả

```ts
type AssignPlanCommand = {
  planKey: string;
  cause:
    | { kind: 'BILLING'; ref: string; sequence: bigint }            // SP5: ref = public id của subscription, sequence = billing_accounts.plan_assignment_seq (R-X1)
    | { kind: 'PLATFORM_ADMIN'; reason: string; expectedVersion: number }; // API admin (4C)
};
type AssignmentResult =
  | { kind: 'APPLIED'; fromPlan: string; toPlan: string; version: number }
  | { kind: 'UNCHANGED'; version: number }
  | { kind: 'STALE'; lastBillingSeq: bigint }                       // chỉ BILLING
  | { kind: 'REJECTED_RETIRED'; planKey: string };
```

`DEFAULT` không có trong lệnh công khai: chỉ participant tạo org, subscriber dự phòng và backfill ghi nguồn này (INSERT, không UPDATE).

### 10.2 Thuật toán (`PlanAssignments.assign`, trong UoW + OrgScope của caller)

1. Tiền điều kiện (không SQL): `uow.inTransaction()`, `ctx.orgId()` (thiếu → `EntitlementsContextError`, lỗi lập trình); `planKey` có trong catalogue gói của pod → không thì `UnknownPlanError` (500: lỗi cấu hình của caller hoặc gói mới khi còn pod cũ, F-6/F-7).
2. Khoá rồi tra gói, hai câu: (a) `SELECT plan_id, plan_source, plan_source_ref, last_billing_seq, version FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE` — khoá **chỉ** `org_entitlements`, **không JOIN** → 0 dòng → `EntitlementsRowMissingError` (503); (b) `SELECT id, key, retired_at FROM plans WHERE id = $planId OR key = $planKey` → gói hiện tại theo `plan_id` vừa khoá, gói đích theo key; không có gói đích (catalogue có mà DB không, chỉ xảy ra khi migration gói chưa chạy) → `UnknownPlanError`. Không JOIN `plans` vào câu khoá: dưới READ COMMITTED, phiên chờ khoá được kiểm lại (EvalPlanQual) trên phiên bản mới của dòng khoá nhưng ghép với dòng `plans` đọc trước khi chờ, nên khi phiên trước vừa đổi `plan_id`, điều kiện `cur.id = e.plan_id` sai và câu trả 0 dòng → `EntitlementsRowMissingError` giả, trong khi dòng vẫn còn (E-5, E-7, E-8; test PA-9, E-7 và ca tất định của plan 4A Task 12). Trạng thái retired của gói đích đọc từ DB (nguồn mà trigger `org_entitlements_plan_not_retired` dùng), không từ catalogue.
3. `decideAssignment(current, cmd)` (hàm thuần, `switch (cmd.cause.kind)` vét cạn):
   - `BILLING`: `current.lastBillingSeq !== null && cmd.sequence <= current.lastBillingSeq` → `STALE`.
   - `PLATFORM_ADMIN`: `cmd.expectedVersion !== current.version` → ném `AppError(PRECONDITION_FAILED)` (412; đường admin đã `assertIfMatch`, đây là kiểm lại sau khoá).
   - gói đích retired và khác gói hiện tại → `REJECTED_RETIRED`.
   - cùng gói, cùng nguồn, cùng `ref` → `UNCHANGED` (không tăng `version`, không event).
   - còn lại → `APPLIED`.
4. Ghi:
   - `APPLIED`: `UPDATE org_entitlements SET plan_id, plan_source, plan_source_ref, plan_reason, plan_assigned_at = now(), last_billing_seq = COALESCE($seq, last_billing_seq), version = version + 1, updated_at = now() … RETURNING version`; outbox `entitlements.plan.changed` (actor: `BILLING` → actor của `RequestContext` của caller, tức actor của SP5: user khi checkout/trial, system của job billing; `PLATFORM_ADMIN` → `{ type: 'user', id: principal.id }`).
   - `UNCHANGED` và `REJECTED_RETIRED` với `BILLING`: chỉ `UPDATE … SET last_billing_seq = $seq, updated_at = now()` (không tăng `version`, không event). Mọi `sequence` đã được SP4 xử lý đều được ghi nhận, nên bất biến "`last_billing_seq` = lệnh billing mới nhất đã xử lý" không phụ thuộc kết quả.
   - `STALE`, và `REJECTED_RETIRED`/`UNCHANGED` với `PLATFORM_ADMIN`: không ghi.
5. Metric `entitlements_plan_assignments_total{cause, result}`.

**Hợp đồng ném lỗi (C-2):** `assign` không làm I/O nào ngoài câu SQL trong transaction của caller (event là outbox cùng transaction). Nó chỉ ném:
- lỗi lập trình hoặc cấu hình có tên (`UnknownPlanError`, `EntitlementsContextError`) và `EntitlementsRowMissingError` (cả ba export ở `index.ts`, mục 6.4, R-X19): **luôn trước câu ghi đầu tiên**, sau nhiều nhất hai câu `SELECT` thành công (câu khoá và câu tra `plans` của bước 2), nên transaction của caller **vẫn dùng tiếp và commit được**;
- `412` chỉ với `PLATFORM_ADMIN`, cùng điều kiện "trước câu ghi";
- lỗi hạ tầng DB (timeout, mất kết nối, deadlock): transaction của caller đã hỏng, caller phải rollback; map `503` như mọi lỗi DB (F-1).
Kết quả nghiệp vụ (`APPLIED`, `UNCHANGED`, `STALE`, `REJECTED_RETIRED`) **không bao giờ** là exception. Trigger `org_entitlements_plan_not_retired` và `…_billing_seq_monotonic` không thể bắn trên đường đúng (bước 3 đã quyết dưới khoá); nếu bắn là lỗi code, transaction hỏng và log ERROR (mục 15).

### 10.3 Hợp đồng với SP5 (điểm nối)

Hợp đồng duy nhất là `PlanAssignments.assign` (R-X1). SP4 chỉ mô tả phần của mình và các giả định về phía SP5; thiết kế bên billing nằm ở spec SP5.

- **Nơi gọi: đồng bộ, trong transaction của billing.** Billing gọi `assign` trong chính `UnitOfWork` + `OrgScope(orgId)` đã đổi trạng thái subscription/hoá đơn, **sau** khi đã khoá dòng `billing_accounts` của org (thứ tự khoá mục 3.6: khoá của billing trước, `org_entitlements` sau). Tiền và gói vì vậy nguyên tử. Ngoại lệ với luật "một transaction một aggregate" của cha §2 do SP5 ghi trong ADR của SP5 (số 0019, R-X6). Không có biến thể subscriber (r0 đề xuất, đã bỏ).
- **`sequence`:** `billing_accounts.plan_assignment_seq`, SP5 tăng bằng `UPDATE … SET plan_assignment_seq = plan_assignment_seq + 1 … RETURNING` dưới khoá account trong cùng transaction, không bao giờ reset (account sống qua purge, id org không tái dùng). Dưới khoá đó mọi lệnh của một org đã tuần tự, nên `STALE` không thể xảy ra; SP4 vẫn giữ so sánh + trigger làm lớp chặn cuối (E-5).
- **Không gán tương lai.** `assign` có hiệu lực lúc commit. Billing gọi `assign` **đúng lúc gói bắt đầu có hiệu lực**: bắt đầu trial, kỳ trả tiền đầu tiên bắt đầu, bước `PERIOD_STARTED` của `advance-org` ở **mọi** kỳ đã trả bắt đầu, kể cả gia hạn cùng giá (R-X18; r1 chỉ ghi "kể cả kỳ đổi giá/đổi gói"), và `EXPIRED` với `PlanAssignments.defaultPlanKey()`. Trả trước cho kỳ sau **không** gọi `assign` lúc trả; khớp phán quyết Q2 của SP5 (đổi gói có hiệu lực từ kỳ sau, không proration). Kết quả của lần khẳng định lại mỗi kỳ (mục 10.2 bước 3):
  - gia hạn cùng gói, cùng subscription, nguồn hiện tại `BILLING` → `UNCHANGED` (không tăng `version`, không event; chỉ ghi `last_billing_seq`), chi phí một câu khoá dòng;
  - nguồn hiện tại `PLATFORM_ADMIN` (nhân viên gán tay) → `APPLIED` về gói của giá đang trả, nguồn `BILLING`, một event `plan.changed` (kể cả khi gói trùng gói nhân viên đã gán: `fromPlan = toPlan`, event ghi lại rằng billing lấy lại quyền sở hữu khe gói). Gán tay vì vậy chỉ sống tới kỳ trả tiền kế tiếp (S4-D11);
  - gói của giá đang trả đã retire và khác gói hiện tại → `REJECTED_RETIRED` (bảng dưới);
  - override theo tính năng không bị đụng tới ở mọi nhánh.
- **Xử lý kết quả ở SP5:** `switch` vét cạn trên bốn kết quả, không ném từ kết quả có tên:

  | Kết quả | SP5 làm |
  |---|---|
  | `APPLIED`, `UNCHANGED` | tiếp tục |
  | `STALE` | không thể xảy ra dưới khoá account: lỗi lập trình, log ERROR và ném (rollback đúng, vì là hỏng số thứ tự) |
  | `REJECTED_RETIRED` | giữ transaction tiền (hoá đơn vẫn `PAID`), log ERROR + metric, phát event cảnh báo của SP5 có `audit: true`; nhân viên xử lý bằng `PUT …/entitlements/plan` của SP4 (mục 12.2). SP4 đã ghi `last_billing_seq` (mục 10.2 bước 4). Vì billing khẳng định lại gói mỗi kỳ (R-X18), kết quả này lặp lại ở mỗi kỳ trả tiền tới khi subscription được chuyển sang giá của gói còn bán; gán tay của nhân viên giữ nguyên trong thời gian đó (gói đích retired thì không `APPLIED`). Runbook `REJECTED_RETIRED` ghi hai bước: gán tay ngay, rồi chuyển giá |

- **Lỗi ném:** theo "hợp đồng ném lỗi" ở 10.2. Lỗi có tên luôn ném trước câu ghi đầu tiên nên transaction tiền còn dùng được; SP5 bắt bằng `instanceof` đúng các lớp export ở mục 6.4 (`UnknownPlanError`, `EntitlementsRowMissingError`; `EntitlementsContextError` là lỗi lắp ráp, không bắt). `assign` không ném `EntitlementsVersionSkewError` (mục 6.4), nên SP5 không có nhánh cho lớp đó (R-X19). Cách SP5 xử lý từng lớp nằm ở spec SP5.
- **Định danh gói:** giá của SP5 tham chiếu gói bằng FK `billing_prices.plan_id → plans(id)` (R-X1, mục 7.2); SP5 truyền `plans.key` của giá đó làm `planKey`. Gói dự phòng khi hết hạn là `defaultPlanKey()`, thay cho `BILLING_FALLBACK_PLAN_KEY` (R-X1). SP4 không export `isKnownPlan`/`planKeys()`: FK + `EntitlementCatalogueCheck` đã bảo đảm `plans` khớp catalogue.
- **Ánh xạ trạng thái → gói** (cha Phụ lục A.1, SP5 sở hữu): `TRIALING`/`ACTIVE`/`PAST_DUE` (trong ân hạn) → gói của giá kỳ đang dùng; `EXPIRED` (kể cả sau `CANCELED` hết kỳ) → `defaultPlanKey()`.
- **Org đã purge:** billing không phải purge participant (R-X5) và account sống qua purge; `assign` trên org không còn dòng `org_entitlements` → `EntitlementsRowMissingError` trước mọi câu ghi, SP5 xử lý theo spec của mình.

### 10.4 Tạo org (participant) và lưới dự phòng

- `OrgCreationParticipant` của entitlements (`@OrgCreationParticipantContributor({ key: 'entitlements.provision', order: 0 })`): trong transaction tạo org, `OrgScope(newId)`: `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at) SELECT app_current_org(), id, 'DEFAULT', now() FROM plans WHERE key = $default` → outbox `entitlements.plan.changed { fromPlan: null, toPlan, cause: 'DEFAULT' }` (actor của thao tác tạo org).
- Subscriber `entitlements.provision-org` (`@EventSubscriber({ consumer: 'entitlements.provision-org', event: OrgCreatedEvent })`): cùng câu với `ON CONFLICT (org_id) DO NOTHING`; chỉ phát event khi thật sự chèn (`RETURNING`). `23503` (org đã purge trước khi event tới: `core.event.deliver` chạy cả trên org không còn) → log INFO `entitlements_provision_skipped_org_gone`, coi là xử lý xong.

---

## 11. State machine và hàm quyết định

SP4 không có luồng nhiều trạng thái lưu trong DB; mọi "trạng thái" là **hàm thuần có `switch` vét cạn + kiểm `never`**, unit test mọi cặp (đầu vào × nhánh):

| Hàm | Đầu vào | Nhánh |
|---|---|---|
| `resolveEffective` | `kind` × (override còn hạn? giá trị gói? ) | `FLAG`/`LIMIT`/`QUOTA` × `OVERRIDE`/`PLAN`/`FALLBACK` |
| `decideAssignment` | `cause.kind` × (seq, version, retired, cùng gói/nguồn/ref) | `APPLIED`/`UNCHANGED`/`STALE`/`REJECTED_RETIRED`/412 |
| `quotaState` | `Limit` × `used` | `WITHIN`/`REACHED`/`OVER_LIMIT` |
| `overrideStatus` | `expires_at` × `now()` | `ACTIVE`/`EXPIRED` (suy ra; hết hạn không có event) |
| `periodOf` | `resetPeriod` | `NONE` → `NULL`; `MONTH` → `date_trunc('month', now(), tz)` |

Nguồn gán gói là enum `DEFAULT | BILLING | PLATFORM_ADMIN` (không phải cờ boolean rời rạc); chuyển nguồn chỉ qua `assign` (và INSERT `DEFAULT`).

---

## 12. API HTTP

Tuân cha §3 (problem+json, ETag/`If-Match`, camelCase, enum `UPPER_SNAKE`, nullable luôn có mặt, schema zod request/response, `@ApiProblems`).

### 12.1 Tenant

| Method + path | Phân quyền | Status | Ghi chú |
|---|---|---|---|
| `GET /v1/orgs/{orgId}/entitlements` | `EntitlementPermissions.require('entitlements.read')` | `200`, `404` (SP3), `403`, `503` | Không ETag (usage đổi mà `version` không đổi). Không mutation nên không cần marker G-8 của SP3 |

Response:

```jsonc
{ "plan": { "key": "pro", "source": "BILLING", "assignedAt": "2026-10-01T00:00:00.000Z" },
  "features": [
    { "key": "reports.export", "kind": "FLAG", "enabled": true, "source": "PLAN", "overrideExpiresAt": null },
    { "key": "tenancy.seats", "kind": "LIMIT", "unlimited": false, "limit": 10, "source": "OVERRIDE",
      "overrideExpiresAt": "2027-01-01T00:00:00.000Z" },
    { "key": "reports.api_calls", "kind": "QUOTA", "resetPeriod": "MONTH", "unlimited": false, "limit": 1000,
      "used": 120, "state": "WITHIN", "periodStart": "2026-09-30T17:00:00.000Z",
      "periodEnd": "2026-10-31T17:00:00.000Z", "source": "PLAN", "overrideExpiresAt": null } ] }
```

- Không trả `plan_source_ref`, `plan_reason`, `reason` của override (dữ liệu nội bộ của nhân viên/billing). Tính năng deprecated không liệt kê. `LIMIT` không có `used` (module chủ đếm; số member có ở `GET …/members` của SP3 với `totalCount`).
- Đọc bằng một transaction đọc ngắn: snapshot + `SELECT feature_id, used FROM usage_counters WHERE org_id = app_current_org() AND (period_start IS NULL OR period_start = ANY($currentPeriods))` (index `usage_counters_period_uq`); `periodEnd` = `date_add(period_start, '1 month', tz)`.
- Org API key và support grant đọc được (quyền `apiKeyEligible`, `supportEligible`). Hai loại principal này có từ 3D, nên ca test của chúng (HT-2b) chạy ở 4C, plan đã phụ thuộc 3D (mục 21); 4A chỉ cần 3A.

### 12.2 Admin (4C)

Mọi route mang `@PlatformStaffAction()` của identity (ship ở 3D, R-X2). SP4 không thêm guard nào khác và không định nghĩa lại hành vi của gate: người không phải nhân viên, credential không phải session, thiếu step-up TOTP tươi, `external` thiếu `auth_time` tươi, DB lỗi đều theo bảng status của addendum 3D §A1.3. Decorator ghi **audit truy cập** trước handler qua port `PlatformAccessAudit` (addendum 3D §A3; no-op `NoopPlatformAccessAudit` tới khi SP6 6B cài, R-X2), nên route của SP4 được audit như route của module admin (X-2). Kiểm lúc boot rằng không route `/v1/admin/**` nào thiếu decorator là `PlatformStaffRouteInventory` của **SP6 6B** (R-X17), đọc metadata qua `hasPlatformStaffAction` của identity (addendum 3D §A2). Service mở `OrgScope.run(orgId, …)` không qua membership (ngoại lệ có tên S4-D19; route không khớp `v1/orgs/:orgId` nên không qua `OrgContextMiddleware`; org không có dòng `org_entitlements` → `404 not_found`). Org đã xoá mềm vẫn đọc/ghi được (thay đổi vô hại: bị purge cùng org hoặc giữ khi khôi phục). Org API key trên route này → `403 api_key_not_allowed_here` (SP3 `OrgApiKeyConfinementGuard`).

| Method + path | Body | Status | Ghi chú |
|---|---|---|---|
| `GET /v1/admin/plans` | — | `200` | Catalogue gói của pod (`key`, `retired`, `default`, `values` theo tính năng) |
| `GET /v1/admin/orgs/{orgId}/entitlements` | — | `200` + `ETag` (weak, `version`), `304` | Như tenant + `plan.sourceRef`, `plan.reason`, `lastBillingSeq`, override đầy đủ (`reason`, `expiresAt`, kể cả đã hết hạn với `status`) |
| `PUT /v1/admin/orgs/{orgId}/entitlements/plan` | `{ planKey, reason }` | `200` (snapshot admin), `412`, `428`, `422 plan_retired`, `422 unknown_plan` | `If-Match` bắt buộc (`assertIfMatch`); `assign` với `PLATFORM_ADMIN`; `UNCHANGED` → `200` như cũ; `STALE` không thể xảy ra (không phải `BILLING`). Đây cũng là đường nhân viên xử lý cảnh báo `REJECTED_RETIRED` của SP5 (mục 10.3) |
| `PUT /v1/admin/orgs/{orgId}/entitlements/overrides/{featureKey}` | `{ enabled }` hoặc `{ limit: number \| null }` + `{ reason, expiresAt: string \| null }` | `200` (snapshot admin), `404` (key không có hoặc deprecated), `412`, `428`, `422` | Upsert `ON CONFLICT (org_id, feature_id) DO UPDATE`; khoá dòng gốc `FOR NO KEY UPDATE` trước, tăng `version`; `expiresAt` phải > `now()`; số trong `[minimum, ENTITLEMENT_VALUE_MAX]`; outbox `entitlements.override.set` |
| `DELETE /v1/admin/orgs/{orgId}/entitlements/overrides/{featureKey}` | — | `204`, `404`, `412`, `428` | Khoá gốc, `DELETE`, tăng `version`; outbox `entitlements.override.removed`; không có dòng → `404` |

- `PUT` thay vì `POST`/`PATCH`: thay nguyên giá trị (idempotent theo ngữ nghĩa); không `@Idempotent()` (cha §3.4 chỉ đòi cho POST/PATCH; `If-Match` chặn ghi chồng). Trả `200` + snapshot của aggregate (cha §3.2: PUT thành công trả resource sau khi sửa).
- Không có API reset bộ đếm quota (YAGNI: override nâng trần là đủ; cần thì thêm sau).

### 12.3 Decorator route và interceptor

- `ReportFeatures.requireEnabled('reports.export', …)` = `applyDecorators(SetMetadata(FEATURE_REQUIREMENTS, { catalogue, keys }), UseInterceptors(EntitlementInterceptor))`. Nhiều key: tất cả phải bật.
- `EntitlementInterceptor.intercept`: không có `ctx.orgId()` hoặc không có `orgAccess` → ném `EntitlementsContextError` (500, lỗi lắp ráp; luật boot mục 8.3 đã chặn trường hợp route không phải tenant). Đọc snapshot một lần; key tắt đầu tiên → `AppError(FEATURE_NOT_IN_PLAN, { fields: [{ path: 'feature', code: key, message }] })`; metric `entitlements_feature_denied_total{feature}`.
- Thứ tự với `IdempotencyInterceptor` (cả hai route-scoped) không ảnh hưởng đúng/sai: nếu idempotency chạy trước, `403` được lưu và trả lại cho cùng key (cha §3.4: response lỗi cũng được lưu, client đổi request thì đổi key); nếu sau, `403` không được lưu. Test HT-4 chứng minh cả hai thứ tự.

---

## 13. Async, job, event

### 13.1 Event (`entitlements.*`, `defineEvent`, payload v1, chỉ id/key, không PII, không văn bản tự do)

| Type | Aggregate (`type`, `id`, `version`) | `data` |
|---|---|---|
| `entitlements.plan.changed` | `org_entitlement`, `orgId`, `org_entitlements.version` | `{ orgId, fromPlan: string \| null, toPlan, cause: 'DEFAULT' \| 'BILLING' \| 'PLATFORM_ADMIN', causeRef: string \| null }` (`causeRef` = `ref` của billing; `reason` của nhân viên **không** vào event, nằm ở `plan_reason`) |
| `entitlements.override.set` | `org_entitlement`, `orgId`, `version` | `{ orgId, feature, value: { kind: 'FLAG', enabled } \| { kind: 'LIMIT' \| 'QUOTA', limit: number \| null }, expiresAt: string \| null }` |
| `entitlements.override.removed` | `org_entitlement`, `orgId`, `version` | `{ orgId, feature }` |
| `entitlements.quota.reached` | `usage_counter`, `String(usage_counters.id)`, `usage_counters.version` | `{ orgId, feature, periodStart: string \| null, limit, used }` |

- **Cờ (R-X3, S4-D20):** cả bốn event khai báo tường minh `audit: true`, `webhook: false` trong `defineEvent`. Cờ bắt buộc do SP6 6.0 thêm vào `defineEvent` (code hiện tại chưa có, `event-definition.ts:21`). 4A và 6.0 cùng sóng W2 (R-X7): 4A merge sau 6.0 thì khai báo cờ ngay; 4A merge trước thì 6.0 thêm cờ vào `events.ts` của entitlements theo đúng bảng này (6.0 liệt kê file đó trong bảng "sửa code của plan trước"). 4B/4C luôn sau 6.0 nên khai báo cờ ngay.
- Ghi cùng transaction qua `EventPublisher` (org từ `RequestContext`). Override hết hạn, org rơi vào `OVER_LIMIT` sau hạ gói: **không** event (suy ra; `plan.changed` hàm ý).
- Actor: nhân viên → `{ type: 'user', id: principal.id }`; participant tạo org → actor của thao tác tạo org; subscriber dự phòng → `{ type: 'system', id: 'entitlements.provision-org' }`; migration → `{ type: 'system', id: 'migration:<tên>' }`; `BILLING` → actor trong `RequestContext` của transaction billing (gọi đồng bộ, R-X1).
- Tiêu thụ: SP6 audit nhận cả bốn nhờ `audit: true`; SP5/notifications có thể tiêu thụ `quota.reached` (báo owner). SP4 không gửi thư.

### 13.2 Subscriber và job

- `entitlements.provision-org` (mục 10.4) — duy nhất. Chạy ở worker, `UnitOfWork` + `Inbox` (cơ chế SP1).
- **Không cron, không sweep.** Kỳ quota reset lười (S4-D5); override hết hạn suy ra khi đọc; không có dọn kỳ cũ ở v1 (mục 23). Vì SP4 không quét nên không dùng helper sweep của R-X4; nếu sau này thêm dọn kỳ cũ thì bắt buộc dùng helper đó.
- **Participant purge:** `@OrgPurgeParticipantContributor({ key: 'entitlements', order: 100 })` (SP3 §9.5; giá trị 100 lấy từ registry `order` ở addendum 3D §A4, R-X5, R-X12: `core.scheduled-tasks` 0, entitlements 100, files 110, integrations 120, sample 200, tenancy core 1000 chạy cuối và không phải participant). Order tương đối chỉ quan trọng với FK: bảng SP4 trỏ tới `organizations`, nên phải xoá trước tenancy core (1000); không có FK nào giữa SP4 và files/integrations/sample. Billing và audit không phải participant (R-X5), nên transaction purge không bao giờ khoá `billing_accounts` (E-16). Trong transaction purge: `DELETE FROM usage_counters`, `DELETE FROM org_entitlement_overrides`, `DELETE FROM org_entitlements` (đều `WHERE org_id = app_current_org()`, theo thứ tự con trước cha). Provider ở `forWorker()`. Participant tạo org ở `forApi()` (tạo org chạy ở api) và `forWorker()` (đối xứng; job nào tạo org cũng có).

---

## 14. Config (`entitlements.config.ts`)

`defineConfig` + zod; mặc định khởi động được ở cả ba `AUTH_MODE` với env hiện có (nguyên tắc INT-I12 của SP3); `.env.example` sinh lại bằng `pnpm env:example`.

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `ENTITLEMENTS_QUOTA_TIMEZONE` | `Asia/Ho_Chi_Minh` | Tên theo R-X10 (r0 dùng `ENTITLEMENTS_QUOTA_PERIOD_TZ`; đổi trước khi có bản phát hành nào nên không cần alias). IANA (`normalizeTimezone`); **đổi giá trị là đổi ranh giới kỳ**: kỳ đang chạy bị tính lại từ mốc mới (bộ đếm mới bắt đầu từ 0) — README ghi, runbook đổi vào đầu tháng |
| `ENTITLEMENTS_ROW_MISSING_RETRY_AFTER_SEC` | `5` | 1–60; `Retry-After` của `503` khi thiếu dòng (mục 8.4) |

Hằng có tên (định dạng, không phải tunable): `FEATURE_KEY_PATTERN`, `PLAN_KEY_PATTERN`, `REASON_MAX_LENGTH = 500`, `SOURCE_REF_MAX_LENGTH = 128`, `ENTITLEMENT_VALUE_MAX = 9007199254740991`, `FILES_STORAGE_FALLBACK_BYTES = 1073741824` (`fallback` của `files.storage_bytes`; r2: đây là **tên duy nhất** của hằng này ở mọi spec, SP6 §18.4 trích đúng tên này. Giá trị bằng mặc định của env `FILES_ORG_STORAGE_LIMIT_BYTES` của SP6, mà SP6 export dưới tên `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES` (phán quyết C4); test ST-3 khẳng định hai giá trị bằng nhau). Giá trị của gói nằm trong `src/app.plans.ts` (config dạng code của dự án, S4-D2). Không thêm luật production.

---

## 15. Lỗi

`EntitlementsErrors = defineErrorCodes({...})`; mã core dùng lại không định nghĩa lại (registry ném khi trùng).

| Status | `code` | Khi nào | Chủ |
|---|---|---|---|
| 403 | `feature_not_in_plan` | `requireEnabled`/`assertEnabled` với tính năng tắt; `errors[0] = { path: 'feature', code: <key> }` | core |
| 422 | `quota_exceeded` | `consumeOrThrow` hết quota; `assertWithinLimit`; ghế ở `MemberAdmission` (tenancy ném); `errors[0]` như trên | core |
| 422 | `plan_retired` | admin gán gói đã retire (khác gói hiện tại); trigger `org_entitlements_plan_not_retired` (qua `defineConstraintErrors`) | entitlements |
| 422 | `unknown_plan` | admin gửi `planKey` không có trong catalogue | entitlements |
| 422 | `validation_failed` | body sai (giá trị sai kiểu với `kind`, dưới `minimum`, `expiresAt` quá khứ, lý do rỗng); trigger `org_entitlement_overrides_value_ck` | core |
| 404 | `not_found` | org/khoá tính năng không có (admin); org khác (SP3) | core |
| 412 / 428 | `precondition_failed` / `precondition_required` | `If-Match` admin | core |
| 4xx/503 của gate | theo 3D | `@PlatformStaffAction()` (không phải nhân viên, credential không hợp lệ, thiếu dấu TOTP tươi, audit truy cập ghi lỗi): mã và status do identity/3D định nghĩa (R-X2); SP4 không thêm mã nào | identity |
| 500 | `internal_error` | `UnknownFeatureError`, `FeatureKindMismatchError`, `UnknownPlanError` (caller truyền key lạ), `QuotaReleaseUnderflowError`, `EntitlementsContextError` (thiếu UoW/org context, kể cả interceptor) | core |
| 503 | `service_unavailable` | DB lỗi/timeout; thiếu dòng `org_entitlements` (`EntitlementsRowMissingError`, cả khi đọc qua port ghế/dung lượng); gói hiện tại của org lạ với pod khi đọc snapshot (`EntitlementsVersionSkewError`) | core |

`defineConstraintErrors`: `org_entitlements_plan_not_retired` → `plan_retired`; `org_entitlement_overrides_value_ck`, `usage_counters_period_ck`, `org_entitlements_billing_seq_monotonic` → `validation_failed` về hình thức, nhưng hai cái sau chỉ bắn khi code sai, nên service còn log ERROR (lớp chặn cuối, không phải đường lỗi của người dùng).

---

## 16. Bảo mật và threat model

**Tài sản:** thứ org đã trả tiền (không mở không mất tiền; không khoá oan khách đã trả); ranh giới tenant; quyền của nhân viên nền tảng.

**Kẻ tấn công trong phạm vi và biện pháp:**

| # | Kẻ tấn công | Mục tiêu | Biện pháp |
|---|---|---|---|
| A1 | Member/owner của org | Dùng quá quota bằng request song song | Consume một câu có khoá dòng (E-1); test ×50 |
| A2 | Member/owner | Tự nâng gói hoặc đặt override | Không có API tenant ghi (S4-D18); grant `app_user` chỉ qua service; RLS |
| A3 | Member thiếu quyền | Dò gói/tính năng của org qua mã lỗi | Entitlement đánh giá sau CASL (S4-D7, test HT-1); đọc gói cần `entitlements.read` |
| A4 | Principal của org A | Đọc/ghi entitlement hoặc bộ đếm của org B | Org từ path + membership (SP3); RLS `FORCE` trên ba bảng; admin route không nhận org từ header |
| A5 | Org API key / support grant | Vượt phạm vi | Chỉ đọc qua `entitlements.read` (catalogue cho phép); không route ghi nào cho tenant; route admin chặn org key (SP3) |
| A6 | Kẻ giữ session bị đánh cắp của nhân viên | Đổi gói/override hàng loạt | `@PlatformStaffAction()` (3D, R-X2) đòi step-up TOTP tươi (SP3 §9.7) và ghi audit truy cập trước handler; `If-Match`, lý do bắt buộc, event `audit: true` mỗi thay đổi (SP6 audit) |
| A7 | Lệnh gán gói cũ được áp sau lệnh mới (lỗi phân tán hoặc caller bất đồng bộ sau này) | Đưa org về gói cũ | Gọi đồng bộ dưới khoá account của billing (R-X1); `sequence` tăng nghiêm ngặt + so dưới khoá + trigger đơn điệu làm lớp chặn cuối (E-5) |
| A10 | Lỗi gán gói làm mất ghi nhận tiền | Khách đã trả mà hoá đơn không `PAID` | Kết quả nghiệp vụ không bao giờ là exception; lỗi có tên ném trước câu ghi đầu tiên (hợp đồng ném lỗi, mục 10.2) |
| A8 | Client retry | Trừ quota hai lần | Consume chung transaction với side effect + `@Idempotent()`/Inbox (S4-D6) |
| A9 | Input admin độc hại | Giá trị khổng lồ, key lạ, lý do chứa script | zod + `CHECK` biên; key tra trong catalogue; `reason` không bao giờ vào event, log hay HTML của boilerplate |

**Ngoài phạm vi:** kẻ có credential DB hoặc SQLi dưới `app_user` (ghi thẳng `org_entitlements`; SP3 đã ghi ranh giới); nhân viên nền tảng **cố ý** lạm quyền với factor TOTP hợp lệ (SP6: audit + phê duyệt hai người); gian lận thanh toán (SP5); thao túng đồng hồ của máy DB; DoS làm nóng một dòng bộ đếm (rate limit của SP1 là lớp chặn).

**Riêng tư:** không email, tên, `reason` trong log/metric/span/event; `plan_source_ref` là id opaque; label metric chỉ là enum hữu hạn (key tính năng thuộc catalogue hữu hạn, không phải id org).

---

## 17. Race condition đã gọi tên

| # | Tình huống | Cơ chế chặn |
|---|---|---|
| E-1 | Nhiều consume song song trên cùng bộ đếm vượt trần | `INSERT … ON CONFLICT DO UPDATE … WHERE used + n <= limit RETURNING`: khoá dòng, `WHERE` tính trên bản mới nhất |
| E-2 | Hai consume đầu tiên của kỳ mới cùng chèn dòng | Index `usage_counters_period_uq` (`NULLS NOT DISTINCT`): bên sau chờ index rồi đi nhánh `DO UPDATE` |
| E-3 | Consume quanh ranh giới tháng | Kỳ tính từ `now()` của DB trong câu; mỗi transaction rơi vào đúng một kỳ; không cron |
| E-4 | Hạ gói/đặt override nhỏ hơn đồng thời với consume | Consume đọc trần trong transaction của nó; thay đổi commit sau được xếp "sau" lần tiêu thụ; `used > limit` sau đó là `OVER_LIMIT` hợp lệ (S4-D13); không có lần tiêu thụ nào vượt trần hiệu lực tại thời điểm của nó |
| E-5 | Lệnh billing đảo thứ tự hoặc chạy lại | Chính: SP5 gọi đồng bộ dưới khoá `billing_accounts`, `sequence` tăng dưới cùng khoá (R-X1). Lớp chặn cuối: khoá `org_entitlements` `FOR NO KEY UPDATE` + so `sequence` với `last_billing_seq` dưới khoá → `STALE`; trigger `org_entitlements_billing_seq_monotonic` |
| E-6 | `N + k` admission song song khi còn `N` ghế | Khoá dòng org của SP3 tuần tự hoá `MemberAdmission`; đếm `org_members` sau khoá (`READ COMMITTED`: snapshot mới mỗi câu) |
| E-7 | Hai nhân viên sửa cùng org | `If-Match` (412) + khoá dòng gốc + kiểm lại `expectedVersion` sau khoá |
| E-8 | Nhân viên gán tay đua với lệnh billing | Cùng khoá dòng gốc; thứ tự commit quyết định; lệnh billing cũ hơn (seq ≤) bị bỏ; luật ưu tiên S4-D11: lệnh billing của kỳ trả tiền kế tiếp luôn khẳng định lại gói của giá đang trả (R-X18), nên gán tay thắng cuộc đua chỉ sống tới kỳ đó |
| E-9 | Participant tạo org và subscriber dự phòng cùng chèn | PK `org_id` + `ON CONFLICT DO NOTHING`; chỉ bên chèn thật phát event |
| E-10 | Hai lần consume cùng vượt ngưỡng `quota.reached` | Tuần tự trên khoá dòng: chỉ đúng một lần có `used − n < limit ≤ used` |
| E-11 | Purge org đua với consume/assign | Purge khoá org (SP3) rồi xoá con trước cha; `INSERT` bộ đếm lấy `FOR KEY SHARE` trên `org_entitlements` và chờ; sau purge FK `23503`/0 dòng → request/job của org đã mất fail có tên (org đã `404` từ middleware trước đó) |
| E-12 | Override hết hạn giữa hai câu của một request | Suy ra bằng `now()` (giờ bắt đầu transaction): mọi câu trong transaction thấy cùng một trạng thái; request sau thấy hết hạn (trễ tối đa một request) |
| E-13 | Rolling deploy: hai pod có catalogue gói khác nhau | Giá trị gói lệch nhau trong thời gian rollout (chấp nhận có tên, như quyền SP3 T-22); gói **mới** chỉ được gán sau khi mọi pod biết nó (F-6) |
| E-14 | Release đua với consume trên cùng dòng | Cùng khoá dòng; `WHERE used >= n` + `CHECK (used >= 0)` |
| E-15 | Deadlock giữa assign và consume | Consume không khoá `org_entitlements` (chỉ `FOR KEY SHARE` của FK, không xung đột `FOR NO KEY UPDATE`); thứ tự khoá cố định mục 3.6 |
| E-16 | Purge org đua với `assign` đồng bộ trong transaction billing (SP4-I2, SP5-I5) | Billing không phải purge participant (R-X5), nên purge không bao giờ khoá `billing_accounts`; transaction billing giữ `billing_accounts` rồi chờ `org_entitlements`, purge giữ `organizations` rồi chờ `org_entitlements`: hai bên cùng chờ **một** khoá, không có chu trình. Điều kiện của lập luận: transaction billing không giữ khoá nào trên dòng `organizations` (SP5 không có FK tới `organizations`, S5-D4; câu `UPDATE` của `assign` không đổi `org_id` nên không lấy `FOR KEY SHARE` trên `organizations`); SP5 phải giữ điều kiện này, test PA-15 bắt nếu vỡ. Bên nào sau thấy kết quả của bên trước: purge xoá sau khi billing commit, hoặc `assign` nhận 0 dòng → `EntitlementsRowMissingError` trước câu ghi (mục 10.3). Test PA-15 chạy đua với `assign` thật |
| E-17 | Upload file đua với hạ gói/override dung lượng | Cùng lập luận E-4: adapter đọc trần trong transaction của files (mục 9.7), thay đổi commit sau xếp "sau" upload; `SUM(stored_bytes) > max` sau đó là `OVER_LIMIT` hợp lệ. Hai upload song song chống vượt trần là việc của `OrgMutationLock` của SP6 (R6-1), không của SP4 |

Mọi race kiểm ở integration (hai `UnitOfWork` + barrier giữ khoá dòng trên kết nối riêng, lặp ×50, mẫu SP3 §18.0).

---

## 18. Failure mode

| # | Hỏng | Hành vi | Phát hiện |
|---|---|---|---|
| F-1 | DB lỗi/timeout trên snapshot, consume, assign | `503` (`isDbInfraError` qua `dbErrorMapper`), không bao giờ 500 | metric HTTP, trace |
| F-2 | Thiếu dòng `org_entitlements` | `503` + `Retry-After`; subscriber dự phòng tự lành | ERROR `entitlements_row_missing`, `entitlements_row_missing_total` (alert > 0 kéo dài 5 phút) |
| F-3 | Catalogue lệch DB (thiếu migration) | api/worker không khởi động (migration chạy thành Job trước rollout, cha §4) | log ERROR, readiness không lên |
| F-4 | Redis sập | Không ảnh hưởng SP4 (không cache); route `@Idempotent()` có consume vẫn `503` theo SP1 | — |
| F-5 | Worker chết giữa subscriber | Retry; Inbox chống trùng; `ON CONFLICT DO NOTHING` | queue metrics |
| F-6 | Gói mới được gán khi còn pod cũ | Pod cũ trả `503` cho org đó tới hết rollout | ERROR `entitlements_unknown_plan`; README: thêm gói ở bản N, bán ở bản N+1 |
| F-7 | SP5 gửi gói không có (hoặc gói mới khi còn pod cũ) | `UnknownPlanError` ném **trước câu ghi đầu tiên**; transaction billing còn dùng được, SP5 quyết commit tiền kèm cảnh báo hay rollback theo spec của mình (mục 10.3) | log ERROR, metric `entitlements_plan_assignments_total{result="unknown_plan"}` |
| F-8 | Dòng bộ đếm nóng (một org tiêu thụ rất nhiều) | Request chờ khoá dòng tới `statement_timeout` → `503` | p95 `entitlements_quota_consume_duration_seconds`; điểm mở rộng: bộ đếm chia mảnh (mục 23) |
| F-9 | Code release sai (`releaseAllocation` thừa) | `500` + ERROR, `used` không bao giờ âm | log `quota_release_underflow` |
| F-10 | Participant tạo org ném | Không có org (transaction rollback), `503`/`500` theo lỗi | log của tenancy |

---

## 19. Observability (không PII, không label `orgId`)

- **Span:** `entitlements.snapshot.read`, `entitlements.feature.check` (`entitlements.result`), `entitlements.quota.consume` (`entitlements.result`), `entitlements.plan.assign` (`entitlements.cause`, `entitlements.result`).
- **Metric:** `entitlements_feature_denied_total{feature}`; `entitlements_quota_consume_total{feature, result}` (`consumed`, `exceeded`); `entitlements_quota_consume_duration_seconds` (histogram); `entitlements_snapshot_read_duration_seconds` (histogram, điều kiện bật cache mục 8.5); `entitlements_plan_assignments_total{cause, result}` (`result` ∈ `applied`, `unchanged`, `stale`, `rejected_retired`, `unknown_plan`, `row_missing`, `precondition_failed` (412 của `PLATFORM_ADMIN`, E-7); tập hữu hạn); `entitlements_row_missing_total`; `entitlements_catalogue_mismatch_total`; `entitlements_seat_limit_denied_total`. (Số lần từ chối vì dung lượng là metric của SP6, người so trần.)
- **Log:** INFO lúc boot: danh sách (gói → tính năng dùng `fallback`); WARN `entitlements_unknown_override_feature`; ERROR `entitlements_row_missing`, `entitlements_unknown_plan`, `quota_release_underflow`; INFO `entitlements_assignment_stale { cause }`. Không log `reason`, `plan_source_ref`.
- **Alert (runbook):** `entitlements_row_missing_total` tăng; job `entitlements.provision-org` failed; p95 consume > 100 ms.

---

## 20. Testing

Tầng rẻ nhất chứng minh được bất biến (SP3 §18.0). Seed: `test/support/entitlements-seed.ts` (`seedFeatures(fixture)`, `seedPlans(keys)`, `seedOrgEntitlement(orgId, plan)`) dùng cùng `tenancy-seed.ts` của SP3; catalogue fixture có đủ ba loại và hai kỳ.

### 20.1 Unit
- **EC-1…EC-8** catalogue: key sai regex / trùng giữa hai catalogue / `fallback` sai kiểu / `QUOTA` thiếu kỳ / `FLAG` có kỳ / `minimum` > `fallback` → ném; gói có key lạ, key deprecated, giá trị sai kiểu, dưới `minimum`, `defaultPlan` thiếu hoặc retired → ném; log `fallback` đúng danh sách.
- **EV-1…EV-9** `resolveEffective`: mỗi `kind` × {override còn hạn, override hết hạn, chỉ gói, chỉ fallback}; `UNLIMITED`; `quotaState` ba nhánh; `overrideStatus` tại đúng `expires_at` (biên `>`: hết hạn tại đúng mốc).
- **PA-1…PA-8** `decideAssignment`: seq nhỏ hơn/bằng/lớn hơn; `last_billing_seq` null; admin sai version → 412; gói retired khác/cùng gói hiện tại; cùng gói khác nguồn → `APPLIED`; cùng gói cùng nguồn cùng ref → `UNCHANGED`.
- **HT-0** metadata `requireEnabled` chỉ nhận key `FLAG` (test kiểu `expectTypeOf` + runtime).
- **EV-10** (R-X3) bốn định nghĩa event có `audit === true`, `webhook === false` (chạy khi `defineEvent` đã có cờ, tức sau SP6 6.0).
- **EC-10** (4A, R-X19) `modules/entitlements/index.ts` export đủ tám lớp lỗi của mục 6.4; lỗi ném từ trong module thoả `instanceof` với lớp import qua `index.ts` (một bản class, không bản sao).
- **ST-1** (4B) adapter `FileStorageLimitAdapter`: `Limit` `UNLIMITED` → `UNLIMITED`; `MAX(m)` → `{ kind: 'MAX', max: m, featureKey: 'files.storage_bytes' }` (switch vét cạn, kiểm `never`).

### 20.2 Integration (Postgres thật, `app_user`)
- **DB-1** catalog: ba bảng tenant RLS + FORCE + policy `TO app_user`; hai bảng global trong `GLOBAL_TABLES`; ma trận grant theo cột (không `UPDATE` trên `org_id`, `key`, `kind`…).
- **DB-2** isolation mỗi bảng tenant (tiêu chí 8).
- **DB-3** ràng buộc: nguồn/ref/reason sai tổ hợp; `last_billing_seq` giảm hoặc về `NULL` → trigger, giữ nguyên giá trị trong `SET` (câu `APPLIED` của nhân viên) → được; gán mới vào gói retired → trigger, giữ gói retired đang có → được; override sai kiểu theo `kind`, override trên tính năng deprecated; bộ đếm cho tính năng không phải `QUOTA`, kỳ sai (`NONE` có `period_start`); `used < 0`; đổi `kind`/`key` tính năng → trigger; xoá `plans`/`entitlement_features` còn tham chiếu → `23503`.
- **DB-4** migration: up → down → up, sweep S2-R57 từng bước; down của 4A fail to khi còn role tuỳ biến giữ `entitlements.read`; migration khởi đầu (`example/…_starter_plans`) backfill org seed sẵn (mỗi org đúng một dòng + một event parse được bằng `parseEnvelope`, cờ khớp `PlanChangedEvent`), FORCE bật lại (khẳng định); down của nó khi còn gán `BILLING`/`PLATFORM_ADMIN` → `RAISE`, DB không đổi; down của 4B fail to khi còn override trên `files.storage_bytes`.
- **QU-1** (E-1) `N` consume(1) song song, còn `k` → đúng `k` thành công, `used` = trần, ×50.
- **QU-2** (E-2) kỳ mới, hai consume đầu song song → một dòng, `used` = 2.
- **QU-3** (E-3) consume với `now()` giả qua ranh giới (transaction đặt `SET LOCAL timezone` không ảnh hưởng; test chèn dòng kỳ trước rồi consume ở kỳ sau) → hai dòng, kỳ đúng theo `ENTITLEMENTS_QUOTA_TIMEZONE` (ca `UTC+7` 17:00Z ngày cuối tháng).
- **QU-4** consume rồi rollback transaction của caller → `used` không đổi.
- **QU-5** `UNLIMITED` vẫn đếm; `amount > limit` → `EXCEEDED` không chạm DB.
- **QU-6** (E-10) `quota.reached` đúng một lần khi `N` consume song song chạm trần; không phát khi bị từ chối.
- **QU-7** (E-14) release đua consume; release quá `used` → `QuotaReleaseUnderflowError`, `used` giữ nguyên; `releaseAllocation` trên kỳ `MONTH` → `FeatureKindMismatchError`.
- **QU-8** (E-4) hạ override giữa hai consume → lần sau `EXCEEDED`, `state = OVER_LIMIT`.
- **QU-9** consume ngoài UoW → lỗi lập trình có tên.
- **PA-9** (E-5) lệnh seq 5 rồi seq 4 → `STALE`, gói giữ theo seq 5; hai lệnh song song seq 6 và 7 ×50 → gói cuối luôn theo seq 7.
- **PA-10** (E-8) admin gán tay rồi billing seq lớn hơn → billing thắng; billing seq nhỏ hơn đến sau → `STALE`.
- **PA-16** (R-X18, mục 10.3) chuỗi khẳng định lại mỗi kỳ trên một org: `BILLING` seq 1 gói `pro` → `APPLIED`; seq 2 `pro` cùng `ref` → `UNCHANGED` (`version` giữ, không event, `last_billing_seq = 2`); `PLATFORM_ADMIN` `free` → `APPLIED`; seq 3 `pro` → `APPLIED` về `BILLING`; `PLATFORM_ADMIN` `pro`; seq 4 `pro` → `APPLIED` với `fromPlan = toPlan = 'pro'`, nguồn `BILLING`; override đặt giữa chuỗi còn nguyên ở cuối.
- **PA-11** (E-9) participant + subscriber → một dòng, một event `plan.changed`.
- **PA-12** subscriber dự phòng trên org đã purge (`23503`) → xử lý xong, log INFO, không retry.
- **PA-13** (10.2 bước 4) `BILLING` với `REJECTED_RETIRED` và `UNCHANGED`: `last_billing_seq` = seq của lệnh, `version` không đổi, không event; lệnh sau có seq nhỏ hơn → `STALE`.
- **PA-14** (hợp đồng ném lỗi, C-2) trong một transaction: ghi một dòng thử của caller → `assign` với `planKey` lạ (`UnknownPlanError`), rồi với org không có dòng (`EntitlementsRowMissingError`) → bắt lỗi → caller ghi tiếp và `COMMIT` thành công, dòng của caller còn, `org_entitlements` không đổi. Thêm ca `assign` bên trong `UnitOfWork` giả lập transaction billing (khoá trước một dòng của bảng fixture test đóng vai `billing_accounts`, vì 4A chạy trước SP5) để khẳng định thứ tự khoá mục 3.6.
- **PA-15** (E-16) purge org chạy đua với transaction "billing" fixture (bảng fixture như PA-14, không FK tới `organizations`) giữ khoá dòng account rồi gọi `assign` thật (barrier trên kết nối riêng, ×50): không `40P01`; hoặc `assign` áp xong rồi purge xoá, hoặc `assign` nhận `EntitlementsRowMissingError`.
- **ST-2** (4B, R-X8, R-X13, E-17) adapter trong composition thật có cả files (qua `OPTIONAL_BRIDGES`): `current()` trả trần theo gói, theo override (4C nếu đã merge), theo `fallback` 1 GiB; thiếu dòng → `503`; composition tắt `files` → không nạp entry `integrations/files.ts`, boot không đòi env của files; tắt `entitlements` → SP6 không có port (dùng `FILES_ORG_STORAGE_LIMIT_BYTES`) và kiểm lúc boot của files không đòi adapter.
- **ST-3** `FILES_STORAGE_FALLBACK_BYTES` bằng `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES` export từ `modules/files/index.ts` (test ở `integrations/`, nơi duy nhất được import cả hai).
- **ST-4** (4B, R-X13; kiểm lúc boot do 4B thêm vào files, mục 9.7 mục 6) child process, composition `entitlements` + `files` bật nhưng dòng `entitlements-files` bị gỡ khỏi `OPTIONAL_BRIDGES` (fixture `composeFrom` của SP7) → api và worker **không khởi động**, log ERROR `file_storage_limit_adapter_missing`; khôi phục dòng → khởi động; `entitlements` tắt, `files` bật → khởi động không cần adapter.
- **SE-1** (E-6) link `max_uses` lớn, còn `N` ghế, `N + k` join song song ×50 → đúng `N` member, `k` lỗi `422 quota_exceeded`, `use_count` = `N`.
- **SE-2** hạ gói còn 2 ghế khi có 5 member → không ai bị xoá; chấp nhận lời mời → `422`; xoá 4 member → chấp nhận được.
- **SE-3** port vắng (module không cài) → không giới hạn (hành vi SP3); org mới luôn nhận được người tạo (`minimum: 1`).
- **R-1** purge org có bộ đếm, override → mọi dòng mất; participant không đăng ký → purge fail to `23001`; org khác không đổi.
- **EC-9** catalogue check: thiếu/thừa/khác thuộc tính giữa code và DB (feature và plan) → boot fail; route inventory: `requireEnabled` trên route không phải tenant, key không đăng ký, key `QUOTA`, key deprecated → boot fail (fixture Nest thật, không mock `DiscoveryService`).

### 20.3 E2E (supertest, app thật, ba `AUTH_MODE`)
- **HT-1** (S4-T1) route có cả quyền và `requireEnabled` (hai thứ tự decorator): member thiếu quyền trên gói tắt → `403 forbidden`; member đủ quyền trên gói tắt → `403 feature_not_in_plan` với `errors[0].code = <key>`; gói bật → `200`.
- **HT-2a** (4A) `GET /v1/orgs/{orgId}/entitlements`: đúng hình dạng; non-member → `404` thống nhất SP3; OWNER/ADMIN/MEMBER → `200`.
- **HT-2c** (4B: cần role tuỳ biến của 3B; 4B đã phụ thuộc 3C nên 3B chắc chắn có) member giữ role tuỳ biến không có `entitlements.read` → `403`.
- **HT-2b** (4C, cần 3D) org API key đủ phạm vi → `200`; support grant đã step-up → `200`.
- **HT-3** thiếu dòng (xoá tay) → `503` + `Retry-After`; subscriber chạy lại → `200`.
- **HT-4** route `@Idempotent()` + `requireEnabled` ở hai thứ tự interceptor: kết quả đúng như mục 12.3.
- **HT-5** consume trong route `@Idempotent()`: gửi lại cùng key → response đã lưu, `used` không tăng lần hai.
- **AD-1** (R-X2, R-X17) mỗi route admin của SP4 mang `@PlatformStaffAction()`: gọi `describePlatformStaffActionConformance` của addendum 3D §A5 cho **từng** route §12.2 (ca C1–C10: không credential, không phải nhân viên, API key Better Auth, org key, chưa step-up TOTP, step-up bằng backup code, dấu cũ, `external` thiếu/cũ `auth_time`, cho qua với đúng một entry audit trước handler, port ném → `503` và DB không đổi); SP4 không tự đặt mã lỗi (4C). **Phần inventory** (`PlatformStaffRouteInventory` của SP6 6B chạy trên app có route SP4 và không báo thiếu; fixture route SP4 bỏ decorator → không khởi động) chạy ở **plan merge sau trong cặp 4C/6B** (cùng sóng W4, mẫu bảng 4 của SP6): 4C merge sau thì 4C thêm ca đó; 6B merge sau thì A-26 của SP6 đã chạy trên tập route thật có route SP4.
- **AD-5** (R-X18, S4-D11; lệnh billing gửi bằng `assign` cause `BILLING` trong một `UnitOfWork` fixture vì 4C chạy trước SP5, như PA-14):
  - (a) billing seq `n` với gói `legacy` đã retire (org đang ở `free`) → `REJECTED_RETIRED`; nhân viên `PUT …/plan` sang `pro` → `200`, `plan_source = PLATFORM_ADMIN`; kỳ sau billing khẳng định lại `legacy` (seq `n + 1`) → lại `REJECTED_RETIRED`, gói vẫn `pro` do nhân viên đặt, `last_billing_seq = n + 1`;
  - (b) nhân viên `PUT …/plan` sang `pro` trên org mà billing đang trả gói `free` còn bán; kỳ trả tiền kế tiếp billing khẳng định lại `free` (seq lớn hơn) → `APPLIED`, `plan_source = BILLING`, một event `plan.changed` actor của transaction billing; override đặt trước đó còn nguyên;
  - (c) sau (b), kỳ kế tiếp nữa billing gửi lại `free` cùng `ref` → `UNCHANGED`, `version` không đổi, không event;
  - (d) nhân viên `PUT …/plan` sang **đúng** gói billing đang trả; kỳ sau billing khẳng định lại cùng gói → `APPLIED` với `fromPlan = toPlan`, nguồn về `BILLING` (mục 10.3).
- **AD-2** `PUT …/plan` thiếu `If-Match` → `428`; sai → `412`; gói retired → `422 plan_retired`; key lạ → `422 unknown_plan`; thành công → `200`, ETag mới, event `plan.changed` actor là nhân viên, `plan_reason` lưu, không có trong event.
- **AD-3** override: `FLAG` với `limit` → `422`; dưới `minimum` → `422`; `expiresAt` quá khứ → `422`; key lạ/deprecated → `404`; set → tenant thấy `source: OVERRIDE`; hết hạn (thời gian giả qua seed `expires_at` gần) → tenant thấy `source: PLAN`; xoá → `204`, event `override.removed`; đổi gói sau đó → override còn nguyên (S4-D11).
- **AD-4** org API key trên `/v1/admin/**` → `403 api_key_not_allowed_here`; org không tồn tại → `404`.

### 20.4 Chaos, PII, prod-like
- Toxiproxy cắt DB giữa snapshot/consume/assign → `503`, không 500; latency > `DB_QUERY_TIMEOUT_MS` → `503`.
- PII: log/metric/span/event của các đường lỗi (quota vượt, admin sai input có `reason`) không chứa `reason`, email.
- **SM-1 prod-like** (image thật, compose `--profile app`, `NODE_ENV=production`): đăng ký → tạo org → `GET …/entitlements` thấy gói mặc định → route fixture `requireEnabled` `403` → nhân viên step-up TOTP đặt override qua route có `@PlatformStaffAction()` → route `200` → consume tới trần → `422` → xoá mềm org → `404`. Mỗi plan chạy phần của mình (4A: tới `403`; 4B: consume; 4C: override). Đo lại thời gian khởi động (catalogue check + inventory < 50 ms thêm) và kích thước image (không đổi).

### 20.5 Kiến trúc (dependency-cruiser, có fixture phải fail)
- **20.8-a** `modules/tenancy/**`, `modules/identity/**`, `modules/notifications/**`, `modules/files/**` không import `modules/entitlements/**`.
- **20.8-b** `features/**` chỉ import entitlements qua `modules/entitlements/index.ts`.
- **20.8-c** `src/app.plans.ts` và `src/plans.example.ts` chỉ import `modules/entitlements/index.ts` và catalogue tính năng (không import infra).
- **20.8-d** (4B) `modules/entitlements/integrations/**` chỉ được import bởi `src/boilerplate.modules.ts` (dòng `entitlements-files` của `OPTIONAL_BRIDGES`; 4B luôn sau 7A nên không có biến thể `app.modules.ts`); `modules/entitlements/index.ts` và mọi file khác của entitlements không import `modules/files/**`.

---

## 21. Chia plan (mỗi plan tự ship, CI xanh, theo thứ tự phụ thuộc)

```
3A ──► 4A Nền (W2) ──┬──► 4B Quota + ghế + dung lượng (W4; cũng cần 3C, 6A, 7A)
                     └──► 4C Override + admin          (W4; cũng cần 3D)       (4B ∥ 4C)
```

Sóng theo thứ tự toàn cục R-X7: W1 3A · W2 3B ∥ **4A** ∥ 6.0 ∥ 7A · W3 3C ∥ 3D ∥ 6A ∥ 6C ∥ 7B · W4 **4B** ∥ **4C** ∥ 6B ∥ 7C · W5 5A ∥ 6D ∥ 7D · … Người dùng SP4 ở sóng sau: 5A cần 4A (`PlanAssignments`, FK `plans`), 6D và 7D đến sau 4B/4C theo sóng, 7D cần 4B (`Quotas`). Đường nhân viên xử lý `REJECTED_RETIRED` của SP5 (`PUT …/plan`) có từ 4C, trước 5A theo sóng.

| Plan | Phụ thuộc thật (vì sao) | Nội dung |
|---|---|---|
| **4A Nền** | **3A** (sửa `OrgService.create` cho participant, export `classifyTenantHandler`, catalogue quyền + dòng `permissions`, `OrgPurgeParticipant`). Không cần 3B/3C/3D: ca org key/support grant dời sang 4C, ca role tuỳ biến sang 4B. Không cần 6.0 (cờ event: mục 13.1) hay 7A (composition: mục 6.2) | Spike S4-T1, S4-T3. Module khung, `defineFeatureCatalogue`/`definePlanCatalogue`/`UNLIMITED`, registry Discovery, `EntitlementCatalogueCheck`, `EntitlementRouteInventory`; tính năng boilerplate `tenancy.seats` (khai báo + dòng DB; chưa nối tenancy); migration `…_entitlements_core` (§7.1–7.3) + vùng template `example/…_starter_plans` + `src/plans.example.ts` (S4-D22); `resolveEffective`, snapshot (không override), `Entitlements` (FLAG, LIMIT), `EntitlementInterceptor` + `requireEnabled`; `PlanAssignments.assign` (cause `BILLING` với hợp đồng R-X1 và hợp đồng ném lỗi; cause `PLATFORM_ADMIN` đã có trong kiểu và `decideAssignment` nhưng chưa có route) + event `plan.changed`; participant tạo org (amendment tenancy T1, T2), subscriber dự phòng, participant purge `order = 100`; `EntitlementPermissions` + route `GET /v1/orgs/{orgId}/entitlements` (FLAG, LIMIT); config `ENTITLEMENTS_QUOTA_TIMEZONE`; lỗi; metric; luật kiến trúc 20.8-a/b/c; ADR 0018; sửa spec cha phần 4A; nối composition (mục 6.2); nghĩa vụ R-X16 (`markModuleLoaded('entitlements')` nếu 7A đã merge, không thì 7A thêm; dòng `MODULE_REQUIRES`); export lớp lỗi (R-X19, mục 6.4). Test: EC-* (gồm EC-10), EV-1…EV-9 (+EV-10 nếu merge sau 6.0), PA-1…PA-16, DB-1…DB-4 (bảng 4A), R-1 (bảng 4A), HT-1, HT-2a, HT-3, HT-4, SM-1 phần 4A |
| **4B Quota + ghế + dung lượng** | **4A**; **3C** (`MemberAdmission` nguồn lời mời/link mà SE-1/SE-2 cần; 3C ⊇ 3B cho HT-2c); **6A** (port `FileStorageLimit` của files, R-X8, R-X13); **7A** (hằng `OPTIONAL_BRIDGES` và `loadedModules()`, R-X13, R-X16; cạnh này r1 chưa khai, review X2 mục 3) | Migration `…_usage_counters` (§7.5, + dòng `files.storage_bytes`); `Quotas` (consume/consumeOrThrow/release/releaseAllocation), event `quota.reached`; snapshot tenant thêm `used`/`state`/kỳ; port `MemberSeatLimit` (amendment tenancy T5) + adapter; tính năng `files.storage_bytes` + `integrations/files.ts` (`FileStorageLimitAdapter`) + dòng `entitlements-files` của `OPTIONAL_BRIDGES` + kiểm lúc boot của files (sửa code của 6A, mục 9.7 mục 6, R-X13); purge thêm `usage_counters`; luật 20.8-d. Test: QU-* (QU-2 là hồi quy của S4-T2 đã đạt), SE-*, ST-1…ST-4, HT-2c, HT-5, EV-10, DB-1…DB-4 (bảng 4B), R-1 mở rộng, SM-1 phần consume |
| **4C Override + admin** | **4A**; **3D** (`@PlatformStaffAction()`, `PlatformAccessAudit`, bộ ca `describePlatformStaffActionConformance`: addendum 3D, R-X2, R-X12; org API key và support grant cho HT-2b) | Migration `…_overrides` (§7.4); snapshot thêm override; route admin §12.2 dùng `@PlatformStaffAction()` (không sửa identity); event `override.set`/`.removed`; purge thêm override. Test: AD-* (AD-1 phần inventory chỉ khi 4C merge sau 6B, mục 20.3), HT-2b, EV (override), EV-10, DB-1…DB-4 (bảng 4C), SM-1 phần override |

**Rủi ro 3D:** SP3 r8 §4 T7(h) có thể dừng 3D. 4C (và qua đó 5B) chờ theo; 4A, 4B không phụ thuộc 3D nên vẫn đi tiếp (mục 23).

**4B ∥ 4C:** không cùng sửa đối tượng schema; cùng sửa code của 4A ở ba chỗ (câu snapshot, participant purge, schema response tenant) — plan merge sau rebase, đổi timestamp migration lớn hơn migration mới nhất trên `main` (luật SP3 §6.13), chạy lại toàn bộ pipeline. Câu snapshot của 4B không đổi (quota đọc bộ đếm bằng câu riêng), nên xung đột thực tế chỉ ở participant purge và schema response.

**4C ∥ 6B (cùng W4, R-X17):** 4C không phụ thuộc 6B. Trước 6B, route SP4 chạy với `NoopPlatformAccessAudit` và chưa có inventory; plan merge sau trong cặp chạy ca inventory trên route SP4 (AD-1). Không có cạnh ẩn nào còn lại giữa hai plan.

**Bảng tiêu chí → plan đóng:** 1, 2, 6, 7, 11 (đường 4A), 12, 13, 16 → 4A; 3, 4, 5, 14 → 4B; 9 → 4C (phần inventory: plan merge sau trong cặp 4C/6B); 8, 10, 15 → mỗi plan cho bảng/event của mình (15 ở 4A chỉ đóng nếu 4A merge sau 6.0, không thì 6.0 đóng phần của 4A).

---

## 22. Sửa spec cha và SP trước

### 22.1 Spec cha (`2026-09-24-saas-core-architecture-design.md`)

| # | Plan | Chỗ | Sửa |
|---|---|---|---|
| P1 | 4A | §2 bảng context, dòng Entitlements | `Plan (khai báo trong code của dự án), OrgEntitlement (gói + override), UsageCounter` · event `entitlements.plan.changed`, `entitlements.quota.reached` (thay `entitlements.quota.exceeded`: chỉ phát khi tiêu thụ thành công chạm trần, S4-D16) |
| P2 | 4A | §3 dòng "Phân quyền" (đã sửa bởi SP3 A4) | "→ Entitlement (SP4)" thành "→ `OrgScopeInterceptor` → `EntitlementInterceptor` (route-scoped, sau mọi guard, trong OrgScope; SP4 S4-D7)" |
| P3 | 4A | §5 bảng race | thêm: `| Lệnh đổi gói của billing đảo thứ tự | billing gọi PlanAssignments.assign đồng bộ dưới khoá billing_accounts; sequence tăng dưới cùng khoá; khoá dòng org_entitlements + so sequence + trigger đơn điệu là lớp chặn cuối |`, `| Deadlock xuyên module | thứ tự khoá toàn hệ thống: organizations → khoá của module gọi (billing_accounts, …) → org_entitlements → usage_counters; entitlements không khoá bảng module khác sau khoá của mình |`, `| Vượt số ghế khi nhiều người vào org song song | khoá dòng org của MemberAdmission, đếm org_members sau khoá |` (4B); dòng quota sửa thành `INSERT … ON CONFLICT DO UPDATE SET used = used + n WHERE used + n <= limit RETURNING` (một câu, trong transaction của caller) (4B) |
| P4 | 4A | §8 Caching, "Ứng viên đầu tiên: kết quả kiểm tra entitlement theo org" và "Stack đã chọn" | thêm: `SP4 không cache entitlement (đọc một câu PK); khi đo được là cần: Redis riêng, khoá có version, ghi lại bằng Lua so version và bia mộ sau commit (ADR 0018). Stack cache-manager không dùng cho entitlement vì không so version khi ghi lại.` |
| P5 | 4A | §13.1 Feature flag | "Flag nghiệp vụ nằm ở Entitlements" thêm: `: tính năng FLAG theo gói của org (SP4); không có rollout theo phần trăm hay flag theo user` |
| P6 | 4A | §1.1 vùng dự án | thêm `src/app.plans.ts` (catalogue gói, bản chép từ `src/plans.example.ts` của vùng template lúc `upstream:init`) vào danh sách thuộc dự án. Nếu SP7 A1 (bảng vùng) đã áp thì sửa trên bảng đó thay vì câu cũ |
| P7 | 4A | §15.1 cây thư mục | `migrations/ … entitlements/ · … · example/ (template) · app/ (dự án)`; `plans.example.ts (template: catalogue gói mẫu)`; `app.plans.ts (dự án: catalogue gói)` |
| P8 | 4A | §15 danh sách ADR | thêm `0018 Entitlements: catalogue và gói trong code, bộ đếm theo kỳ, không cache ở v1` |
| P9 | 4A | Phụ lục C mục 4 | `4. **Entitlements**: catalogue tính năng trong code (FLAG/LIMIT/QUOTA), gói trong code của dự án, override theo org, quota atomic theo kỳ (NONE/MONTH), số ghế qua port của tenancy, trần dung lượng file qua port của files (LIMIT, không bộ đếm thứ hai), interceptor kiểm tính năng sau CASL, API gán gói có thứ tự, có hiệu lực lúc commit, SP5 gọi đồng bộ trong transaction billing; chia 3 plan 4A → 4B ∥ 4C.` |
| P10 | 4A | §3.2 bảng status, dòng `403`/`422` | ghi chú: `feature_not_in_plan`/`quota_exceeded` mang key tính năng ở `errors[0]` (`path: "feature"`) |

### 22.2 SP3 (tenancy, identity; spec r8 đã commit) — sửa code đã merge, làm trong plan SP4 tương ứng

| # | Plan | Chỗ | Sửa |
|---|---|---|---|
| T1 | 4A | `tenancy` (mới, export `index.ts`) | `abstract class OrgCreationParticipant { abstract onOrgCreated(orgId: string): Promise<void> }` + decorator `@OrgCreationParticipantContributor({ key, order })` (marker Discovery, registry giống `OrgPurgeParticipantRegistry`, kiểm key/order trùng lúc boot); `OrgService.create` gọi mọi participant theo `order` tăng dần **sau** INSERT org + 3 role hệ thống, **trước** `MemberAdmission` của người tạo, trong cùng transaction và `OrgScope(newId)` |
| T2 | 4A | `tenancy/http/org-route.ts` | export qua `index.ts`: `classifyTenantHandler(controllerClass, handler): 'TENANT' \| 'INVALID' \| 'OTHER'` (bọc `classifyOrgRoute(routeTemplateOf(...))`), để inventory của module khác dùng **cùng** matcher (INT-I5 của SP3) |
| T3 | 4A | SP3 §7.1 bước 6, sơ đồ §5.1 | "[SP4] `EntitlementGuard`" → "[SP4] `EntitlementInterceptor` (route-scoped, sau mọi guard, trong OrgScope)" |
| T4 | 4A | SP3 §9.4 (R4A-N4) | "huỷ subscription của SP4" → "của SP5" |
| T5 | 4B | `tenancy` (mới, export) + `MemberAdmission` | port `MemberSeatLimit` (`@Optional()`), đếm `org_members` sau khoá và ném `quota_exceeded` (mục 9.6); SP3 §19 dòng "Số ghế" sửa cơ chế thành "đếm dưới khoá org, không bộ đếm" |
| T6 | 4A, 4B | `.dependency-cruiser.cjs` | luật 20.8-a/b/c (4A), 20.8-d (4B) |
| I1 | — | `modules/identity` | **Bỏ** (r1): SP4 không thêm decorator nào vào identity; dùng `@PlatformStaffAction()` do 3D ship (R-X2) |
| A1 | 4A | ADR 0017, 0005, 0015 | 0017: thứ tự pipeline (T3); 0005: bảng mới trong test catalog; 0015: phần "Hệ quả" ghi "SP4 không cache entitlement ở v1, xem ADR 0018" |
| L1 | 4A, 4B | sổ export của tenancy/identity trong amendment SP3 (T-1) | SP4 ghi các export nó thêm: `OrgCreationParticipant`, `OrgCreationParticipantContributor`, `classifyTenantHandler` (4A); `MemberSeatLimit`, `SeatLimit` (4B); và export nó dùng: `@PlatformStaffAction()` (3D, addendum 3D §A1), `OrgPurgeParticipantContributor`, `PermissionCatalogueContributor`, `definePermissionCatalogue`, `AuthFacts`. Registry `order` purge (R-X5, R-X12) nằm ở addendum 3D §A4; SP4 = 100, và `order < 1000` được registry kiểm lúc boot |

### 22.3 Sửa ở SP chạy song song (phía SP4 của từng phán quyết; SP kia sở hữu thiết kế của mình)

| # | SP (plan) | Chỗ | SP4 cần gì |
|---|---|---|---|
| X5-1 | SP5 (5A) | hợp đồng gán gói | theo R-X1 và mục 10.3: gọi `assign` đồng bộ dưới khoá `billing_accounts`; `plan_assignment_seq`; gọi ở `PERIOD_STARTED`; `switch` vét cạn bốn kết quả; `billing_prices.plan_id` FK `plans(id)`; `defaultPlanKey()`; transaction billing không khoá `organizations` (E-16) |
| X5-2 | SP5 (5B) | khẳng định lại gói mỗi kỳ (R-X18) | billing gọi `assign` ở mọi kỳ đã trả bắt đầu, kể cả gia hạn cùng giá; kết quả thường là `UNCHANGED` (mục 10.3) |
| X5-3 | SP5 (5A) | lớp lỗi (R-X19) | bắt bằng `instanceof` đúng các lớp export ở mục 6.4; không có nhánh `EntitlementsVersionSkewError` |
| X6-1 | SP6 (6A) | port `FileStorageLimit` (R-X13, SP6 sở hữu) | hình dạng và ngữ nghĩa ở mục 9.7 (R-X8): `current(): Promise<StorageLimit>`, inject `@Optional()`, so trần dưới `OrgMutationLock`, `422 quota_exceeded` với `errors[{ path: 'feature', code: featureKey }]`; export `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES` cho ST-3 |
| X6-4 | SP6 (6A code, 4B sửa) | kiểm lúc boot của files (R-X13) | `loadedModules().has('entitlements')` mà không có provider `FileStorageLimit` → không khởi động; định nghĩa ở SP6 §8.1, code do 4B thêm (mục 9.7 mục 6) |
| X6-2 | SP6 (6.0) | `defineEvent` | cờ `audit`/`webhook` bắt buộc (R-X3); nếu 4A merge trước thì 6.0 thêm cờ vào `modules/entitlements/events.ts` theo mục 13.1 |
| X6-3 | SP6 (6B) | port `PlatformAccessAudit` (addendum 3D §A3) và `PlatformStaffRouteInventory` (R-X17) | route admin của SP4 được audit như mọi route admin khác (R-X2) và nằm trong tập route mà inventory kiểm; SP4 không cài gì thêm; ca inventory trên route SP4 chạy ở plan merge sau trong cặp 4C/6B |
| X7-1 | SP7 (7A) | `composeAppModules` | thêm tham số `plans: PlanCatalogue` (bắt buộc khi `entitlements` bật), `BOILERPLATE_MODULES.entitlements` là factory nhận `plans`, `MODULE_REQUIRES` thêm `entitlements → tenancy`; hằng `OPTIONAL_BRIDGES` (7A tạo, rỗng) mà 4B thêm dòng `entitlements-files` nạp `EntitlementsFilesPortsModule` (R-X13, mục 6.2, 9.7); `markModuleLoaded`/`loadedModules()` ở `core/config` (R-X16) |
| X7-2 | SP7 (7A) | vùng template, `upstream:init` | thêm `src/plans.example.ts` vào vùng template; `upstream:init` chép `src/plans.example.ts` → `src/app.plans.ts` và `src/migrations/example/…_starter_plans` → `src/migrations/app/<timestamp mới>_starter_plans` trước khi xoá vùng template, rồi đổi import `plans` trong `app.modules.ts` (S4-D22, mục 7.7) |
| X7-3 | SP7 (7D) | feature mẫu | dùng hai key `example.projects` (`FLAG`) và `example.project_count` (`QUOTA`, `NONE`); `requireEnabled` (interceptor, không `EntitlementGuard`); migration chèn dòng `entitlement_features` vô điều kiện |

---

## 23. Rủi ro mở

| Rủi ro | Xử lý |
|---|---|
| **Giả định yếu nhất:** interceptor route-scoped luôn chạy trong CLS của `OrgScope.run` do interceptor global mở (S4-D7) | Spike S4-T1 trước mọi thứ; SP3 đã dựa vào cùng giả định cho `IdempotencyInterceptor`; fallback: interceptor tự vào `OrgScope` cùng org |
| Dòng bộ đếm nóng khi một org tiêu thụ rất nhiều (khoá dòng giữ tới hết transaction của caller) | README: gọi consume gần cuối transaction ngắn; đo p95; điểm mở rộng: bộ đếm chia `N` mảnh (`shard SMALLINT` trong khoá, tổng khi đọc) — chỉ khi đo được |
| Bộ đếm kỳ cũ không bị dọn: 10.000 org × số quota `MONTH` × 12 dòng/năm (5 quota → 600.000 dòng/năm, vài chục MB) | Nằm trong ngân sách < 50 GB/năm của cha §0.3; điểm mở rộng: cron dọn kỳ cũ bằng helper sweep dùng chung + role `sweep_definer` của SP6 6.0 (R-X4), không vòng quét riêng |
| Consume nằm ngoài transaction của side effect (dùng sai) làm lệch quota | Tiền điều kiện `inTransaction()` chặn gọi ngoài UoW; README; review |
| `LIMIT` do module chủ đếm mà quên khoá | README ghi mẫu; trong boilerplate chỉ `tenancy.seats` (test race SE-1 ở SP4) và `files.storage_bytes` (test race là của SP6, trên khoá của files) dùng `LIMIT`; tài nguyên khác khuyến nghị `QUOTA` kỳ `NONE` |
| Đổi `ENTITLEMENTS_QUOTA_TIMEZONE` giữa kỳ làm kỳ hiện tại bắt đầu lại từ 0 | README + runbook đổi vào đầu tháng |
| 3D dừng ở SP3 r8 T7(h) | Chỉ 4C (và các plan cần 4C) chờ; 4A, 4B không phụ thuộc 3D (mục 21). Không có đường vòng: route admin không ship khi chưa có `@PlatformStaffAction()` |
| Cờ event: 4A merge trước 6.0 | 6.0 thêm cờ vào `events.ts` của entitlements theo bảng 13.1 (X6-2); EV-10 chạy từ plan đầu tiên có cờ |
| `FILES_STORAGE_FALLBACK_BYTES` lệch mặc định của SP6 | ST-3 bắt |
| (r2) Adapter dung lượng không được nạp khi cả hai module bật (dòng `OPTIONAL_BRIDGES` bị gỡ, lỗi composition) | Kiểm lúc boot của files (R-X13, mục 9.7 mục 6): không khởi động, ST-4 |
| (r2) Gói của giá đang trả đã retire: billing khẳng định lại mỗi kỳ và nhận `REJECTED_RETIRED` mỗi kỳ (R-X18) | Hành vi đúng (không gán mới vào gói đã retire); SP5 cảnh báo mỗi kỳ; runbook `REJECTED_RETIRED`: gán tay ngay, rồi chuyển subscription sang giá còn bán (AD-5 (a)) |
| (r2) Nhân viên gán tay với ý định giữ lâu dài | Bị ghi đè ở kỳ trả tiền kế tiếp (R-X18); README admin và runbook ghi: ưu đãi lâu dài dùng override (có lý do, có hạn), không dùng gán gói |
| Clone đã `upstream:init` trước SP4 quên chép catalogue gói | `composeAppModules` ném lỗi có tên khi thiếu `plans`; README "nâng cấp lên SP4" |
| Rolling deploy: pod cũ không biết gói mới → `503` cho org ở gói đó | Quy trình "thêm gói ở bản N, bán ở bản N+1" (README, F-6) |
| Dự án đã chạy SP3 ở production phải sửa bản chép migration khởi đầu cho đúng gói thật trước khi deploy SP4 | README "nâng cấp lên SP4"; boot fail to nếu gói mặc định của catalogue không có trong DB (catalogue check) |
| Migration khởi đầu khoá `organizations` `ACCESS EXCLUSIVE` trong lô (mẫu NO FORCE) | Cửa sổ ít tải; `lock_timeout` 5 s |
| SP5 vi phạm hợp đồng (gọi `assign` ngoài khoá account, hoặc khoá `organizations` trước) | Hợp đồng ở mục 10.3 (R-X1); `STALE` + trigger là lớp chặn cuối cho thứ tự; PA-15 khẳng định không chu trình khoá, SP5 chạy lại ca tương ứng trên code thật |
| Staleness của thiết kế cache (khi bật sau này) | Không có ở v1; thiết kế có version + bia mộ giới hạn ở request đang bay |

---

## 24. Self-review

- **Placeholder:** không có "TBD"/"TODO". Tên timestamp migration để `…` là quy ước của SP3 (sinh bằng generator lúc code). Số mặc định của config và hằng đều có giá trị.
- **Mâu thuẫn đã rà:**
  - Cha §5 dòng quota (`UPDATE … WHERE used+n<=limit`) vs S4-D6 (một câu `INSERT … ON CONFLICT DO UPDATE`): cùng bảo đảm, thêm nhánh tạo dòng kỳ mới; ghi sửa P3.
  - Cha §8 (stack cache-manager, entitlement là ứng viên cache đầu tiên) vs S4-D8 (không cache): cha §8 cũng nói "chỉ bật ở chỗ đã đo"; ghi P4 và lý do loại stack.
  - SP3 §7.1 "EntitlementGuard" vs interceptor (S4-D7): ghi T3.
  - SP3 §19 "số ghế bằng `UPDATE … WHERE used + 1 <= limit`" vs S4-D4 (đếm dưới khoá, không bộ đếm): ghi T5.
  - SP3 S3-A40 dành `quota_exceeded` cho quota theo gói: SP4 dùng đúng mã đó cho ghế và quota; các `*_limit` của tenancy (giới hạn config) giữ nguyên.
  - Cha §2 event `entitlements.quota.exceeded` vs `quota.reached`: ghi P1.
  - Mục 7.7 down của migration khởi đầu: từ chối khi còn gán `BILLING`/`PLATFORM_ADMIN` (không mất dữ liệu âm thầm), chỉ xoá dòng `DEFAULT`; down của `…_entitlements_core` chạy sau nó (thứ tự ngược của lô) nên `DROP TABLE` gặp bảng rỗng. Test DB-4 thêm ca "down khi có gán billing → `RAISE`, DB không đổi".
  - (r1) Hợp đồng SP4↔SP5: r0 đề xuất subscriber, SP5 r0 giả định `assignPlan(…, effectiveAt)`; r1 theo R-X1 (đồng bộ, có hiệu lực lúc commit, `PERIOD_STARTED`), mục 10.3.
  - (r1) Ba decorator nhân viên: r1 bỏ `@PlatformAdminOnly()`, dùng `@PlatformStaffAction()` (R-X2).
  - (r1) `files.storage_bytes` `QUOTA` ở ví dụ r0 vs bộ đếm của SP6: r1 là `LIMIT` qua port (R-X8).
  - (r1) Luật thứ tự migration `app/` của r0 vs S7-D31: r1 bỏ luật của SP4 (S4-D22, mục 7.7).
  - (r2) Tên port dung lượng: không còn `StorageQuotaLimits` ở phần hiện hành; một tên `FileStorageLimit` ở tiêu chí 14, S4-D21, 6.2, 9.7, 17 E-17, 20 ST-*, 21, 22.3 (chỉ nhật ký r1 còn tên cũ, là lịch sử).
  - (r2) Mô tả SP6: không còn `file_storage_usage`/`used_bytes` ở phần hiện hành; SP6 tính `SUM(stored_bytes)` dưới `OrgMutationLock` (mục 2, 3.6, 9.7, E-17).
  - (r2) Chủ inventory route admin: 6B ở tiêu chí 9, S4-D15, 12.2, AD-1, 21 (không còn "luật boot của 3D").
  - (r2) S4-D11, mục 10.3, E-8, AD-5 và PA-16 cùng một luật (R-X18): billing khẳng định lại gói mỗi kỳ đã trả; cùng gói cùng nguồn cùng ref → `UNCHANGED`; gán tay bị ghi đè ở kỳ trả tiền kế tiếp; override không bị đụng; gói retired → `REJECTED_RETIRED` mỗi kỳ.
- **Mơ hồ còn lại (đã chốt):** kỳ quota theo lịch (Q-1, đóng theo phán quyết); ưu tiên admin/billing (S4-D11); override thay thế không cộng (S4-D12); hạ gói không xoá dữ liệu (S4-D13); ghế không tính lời mời chờ (mục 9.6); `webhook: false` cho mọi event (S4-D20).
- **Phạm vi:** chỉ gồm mục 4 Phụ lục C (gói, flag, quota atomic, guard) + những gì đúng đắn đòi (participant tạo org, thứ tự lệnh billing, RLS, purge) + adapter dung lượng (R-X8). Đã loại: cache, kỳ `DAY`, reset bộ đếm qua admin, API gói cho tenant, kill switch, dọn kỳ cũ, bộ đếm chia mảnh, add-on, gán gói hẹn ngày. Admin API có vì đề bài yêu cầu, gói gọn trong 4C.
- **Giả định chưa kiểm được bằng chạy code** (sẽ kiểm ở spike/test): S4-T1 (interceptor trong OrgScope), S4-T3 (participant trong transaction tạo org). S4-T2 **đã kiểm** trên PG 18.6 (review money-security r1), cùng `date_trunc('month', now(), tz)` và `date_add(…, '1 month', tz)`. Các interface SP3 (`definePermissionCatalogue`, `@OrgPurgeParticipantContributor`, `MemberAdmission`, `AuthFacts`, `classifyOrgRoute`) lấy theo spec r8 đã commit, **chưa có code** trên nhánh hiện tại. Các interface của SP chạy song song (r2): `@PlatformStaffAction()`, `PlatformAccessAudit`, bộ ca test và registry order lấy theo addendum 3D (văn bản đã có, chưa có code); cờ bắt buộc của `defineEvent` (6.0, R-X3) và `FileStorageLimit` (6A, R-X13) lấy theo SP6 r2; `composeAppModules`, `OPTIONAL_BRIDGES`, `markModuleLoaded`/`loadedModules()` và `upstream:init` (7A) lấy theo SP7 r2; `billing_accounts.plan_assignment_seq`, `PERIOD_STARTED` ở mọi kỳ và các nhánh bắt lỗi (SP5, R-X1, R-X18, R-X19) lấy theo phán quyết, vì SP5 r2 đang sửa song song.

---

## 25. Nhật ký sửa r1

Nguồn: ba review vòng 1 (`sp4-7-review-interfaces.md`, `sp4-7-review-money-security.md`, `sp4-7-review-ops.md`) và phán quyết chéo R-X1…R-X11. Khi cách sửa reviewer đề xuất khác phán quyết, spec theo phán quyết (ghi ở cột "Sửa"); đó không phải từ chối finding. **Kết quả: 27 finding đã sửa, 0 finding bị từ chối** (nhiều finding trùng nhau giữa các review, ghi cả hai mã).

### 25.1 Review interfaces

| Finding | Sửa | Mục đổi |
|---|---|---|
| X-1 (ba decorator nhân viên) | Bỏ `@PlatformAdminOnly()` của SP4, dùng `@PlatformStaffAction()` của 3D (R-X2; tên và nơi ship theo phán quyết, không theo đề xuất "`@PlatformAdminOnly` ở 4C" của reviewer); SP4 không đặt mã lỗi nào cho gate | Header, 1 (tiêu chí 9), 2, 4.1 S4-D15, 6.2, 12.2, 15, 16 A6, 20.3 AD-1, 21 (4C), 22.2 I1 |
| X-2 (audit truy cập route admin) | Audit truy cập đi cùng decorator qua port của identity, no-op tới 6B (R-X2; reviewer ghi 6D, phán quyết ghi 6B); ngoại lệ có tên S4-D19 cho `OrgScope` không membership, cùng ngoại lệ S6-A39 | 4.1 S4-D19, 12.2, 22.3 X6-3 |
| X-3 (cờ event) | Bốn event khai báo `audit: true`, `webhook: false` (R-X3); kế hoạch khi 4A merge trước/sau 6.0; migration backfill ghi đúng cờ | 1 (tiêu chí 15), 4.1 S4-D20, 7.7, 13.1, 20.1 EV-10, 20.2 DB-4, 22.3 X6-2, 23 |
| X-4 (definer/sweep) | SP4 không quét; ghi rằng mọi sweep sau này dùng helper + `sweep_definer` dùng chung (R-X4) | 2, 13.2, 23 |
| X-5 (trùng `order` purge) | `order = 100` lấy từ bảng cấp phát trong amendment SP3 (R-X5; giá trị bảng reviewer đề xuất bị thay bằng bảng phán quyết); giải thích vì sao thứ tự tương đối đúng | 1 (tiêu chí 10), 13.2, 22.2 L1 |
| X-6 (file vùng dự án do upstream ship, luật thứ tự mâu thuẫn) | Catalogue gói mẫu + migration khởi đầu chuyển sang vùng template (`src/plans.example.ts`, `src/migrations/example/`), `upstream:init` chép sang vùng dự án; bỏ luật "`app/` mới nhất > module"; đường nâng cấp cho clone cũ | 2, 3 (mục 2, 10), 4.1 S4-D2, S4-D22, 6.2, 7.2, 7.7, 8.2, 20.2 DB-4, 20.5 20.8-c, 22.1 P6/P7, 22.3 X7-2, 23 |
| X-7 (`forApi(plans)` với `composeAppModules`) | Catalogue tới qua `composeAppModules({ …, plans })`, factory trong `BOILERPLATE_MODULES`, `MODULE_REQUIRES`; cách làm khi 4A merge trước 7A | 4.1 S4-D2, 6.2, 22.3 X7-1 |
| X-8 (phụ thuộc plan quá rộng) | Phụ thuộc thật theo R-X7: 4A ← 3A; 4B ← 4A, 3C, 6A; 4C ← 4A, 3D. Ca org key/support grant dời sang 4C (HT-2b), ca role tuỳ biến sang 4B (HT-2c) | Header, 12.1, 20.3 HT-2a/b/c, 21 |
| X-9 (số ADR) | ADR 0018 của SP4 giữ nguyên, khớp R-X6; thêm cập nhật "Hệ quả" của ADR 0015 | Header, 22.2 A1 |
| X-10 (cron fan-out lặp) | Không áp dụng cho SP4 (không cron); ghi ràng buộc dùng helper R-X4 nếu thêm | 13.2, 23 |
| X-11 (trích SP3 r7, `EntitlementGuard`) | Mọi trích dẫn SP3 trỏ spec r8 đã commit (R-X11); thêm rủi ro dừng 3D (T7(h)) | Header, 21, 22.2, 23, 24 |
| X-12 (`grantTo.admin` làm `A` lớn lên) | Ghi chú nâng cấp trong S4-D17 và README | 4.1 S4-D17 |
| C-1 (phần SP4: hợp đồng gán gói) | Hợp đồng duy nhất `assign` theo R-X1: đồng bộ trong transaction billing, `plan_assignment_seq`, không gán tương lai, gọi ở `PERIOD_STARTED`, SP5 `switch` vét cạn bốn kết quả | 2, 4.1 S4-D10, 6.4, 10.1, 10.3, 13.1, 16 A7, 17 E-5 |
| C-2 (phần SP4: lỗi gán gói không được rollback tiền) | "Hợp đồng ném lỗi": không I/O ngoài SQL của caller, lỗi có tên luôn trước câu ghi đầu tiên, kết quả nghiệp vụ không bao giờ là exception; `REJECTED_RETIRED`/`UNCHANGED` ghi `last_billing_seq` | 1 (tiêu chí 6), 10.2, 10.3, 16 A10, 18 F-7, 19, 20.2 PA-13, PA-14 |
| C-3 (phần SP4: FK giá → `plans`) | `billing_prices.plan_id` FK `plans(id)`, `defaultPlanKey()` thay `BILLING_FALLBACK_PLAN_KEY`, không export `isKnownPlan`; vòng đời retire/xoá gói tính tới giá | 6.4, 7.2, 8.4, 10.3 |
| Q-1 (dung lượng dùng cả hai loại) | `files.storage_bytes` là `LIMIT` qua port `StorageQuotaLimits` (R-X8); định nghĩa hợp đồng adapter; entry riêng `integrations/files.ts` vì `defineConfig` đăng ký lúc import; `fallback` 1 GiB (phán quyết C4); sửa ví dụ `QUOTA` sai | 1 (tiêu chí 14), 2, 4.1 S4-D4, S4-D21, 6.2, 7.7, 8.1, 9.7 (mới), 14, 17 E-17, 20 ST-1…ST-3, 20.5 20.8-a/d, 21 (4B), 22.3 X6-1 |
| Q-2 (phần SP4: mẫu SP7 dùng một key cho hai loại) | Ghi luật "mỗi key một `kind`" và cách tách hai key; yêu cầu cho 7D | 8.1, 22.3 X7-3 |
| Bảng §3 của review (provider `EntitlementPermissions` ở cả api lẫn worker) | Ghi tường minh | 4.1 S4-D17, 8.1 |
| T-1 (sổ export tenancy) | SP4 liệt kê export nó thêm và dùng để đưa vào sổ ở amendment SP3 | 22.2 L1 |
| N-1 (tên env, Q-1 còn mở) | `ENTITLEMENTS_QUOTA_TIMEZONE` (R-X10); Q-1 đóng theo phán quyết | 1 (tiêu chí 4), 4.1 S4-D5, 4.2, 14, 20.2 QU-3, 23 |

### 25.2 Review money-security

| Finding | Sửa | Mục đổi |
|---|---|---|
| SP4-I1 (= X-1) | Như X-1 | như X-1 |
| SP4-I2 (trùng `order` + chu trình khoá với billing, kèm SP5-I5) | `order = 100` theo R-X5; chu trình không còn vì billing không phải participant (R-X5), nên đề xuất "billing order 50" của reviewer không cần; ghi thứ tự khoá toàn hệ thống "caller trước, entitlements sau" và điều kiện billing không khoá `organizations`; test đua PA-15 | 3 (mục 6), 13.2, 17 E-16, 20.2 PA-15, 22.1 P3, 23 |
| SP4-I3 (= C-1) | Như C-1 | như C-1 |
| SP4-M1 (= N-1) | Như N-1 | như N-1 |
| SP4-M2 (= Q-1 interfaces) | Như Q-1 | như Q-1 |

### 25.3 Review ops

| Finding | Sửa | Mục đổi |
|---|---|---|
| OPS-M (tên env) | Một tên duy nhất `ENTITLEMENTS_QUOTA_TIMEZONE` theo R-X10; đề xuất giữ hậu tố `_TZ` của reviewer bị phán quyết thay | như N-1 |
| OPS-1 (`REDIS_CACHE_URL` tương lai phải là secret) | Ghi trong thiết kế cache: khai báo secret qua metadata config | 8.5 |

### 25.4 Sửa kèm theo (tìm thấy khi đối chiếu, không thuộc finding nào)

| # | Sửa | Mục đổi |
|---|---|---|
| K-1 | Trigger `org_entitlements_billing_seq_monotonic` của r0 chặn nhầm câu `APPLIED` của `PLATFORM_ADMIN` (`last_billing_seq` trong `SET` với giá trị không đổi làm `NEW <= OLD` đúng): thêm vế `IS DISTINCT FROM`, so `<` | 7.3, 20.2 DB-3 |
| K-2 | `assign` đọc trạng thái retired của gói đích từ DB trong câu khoá (cùng nguồn với trigger); gói có trong catalogue mà không có trong DB → `UnknownPlanError` thay vì nhầm với thiếu dòng | 10.2 |
| K-3 | Ca "member thiếu `entitlements.read`" cần role tuỳ biến (3B), không chạy được ở 4A chỉ cần 3A: dời sang 4B (HT-2c) | 20.3, 21 |
| K-4 | Vòng đời retire/xoá gói thêm bước với giá của SP5 (FK `RESTRICT`) | 7.2, 8.4 |
| K-5 | Spike S4-T2 đã được review chạy đạt trên PG 18.6: hạ xuống test hồi quy QU-2 | 5, 21, 24 |

---

## 26. Nhật ký sửa r2

Nguồn: review hội tụ vòng 2 `sp4-7-review-r2.md` (finding cho SP4: X2-1, X2-4, X2-5, X2-6, X2-m1) và phán quyết R-X12…R-X19. Chỉ sửa phía SP4 của mỗi hợp đồng; phía SP5, SP6, SP7 do spec của chúng mang (SP5 sửa song song). **Kết quả: 5 finding đã sửa, 0 finding bị từ chối.** Đề xuất của review khác phán quyết thì spec theo phán quyết (ghi ở cột "Sửa"), không tính là từ chối.

| Finding | Sửa | Mục đổi |
|---|---|---|
| X2-1 (port dung lượng: hai tên, chỗ cài lệch, không ai nạp adapter) | Theo R-X13: một port `FileStorageLimit` do SP6 sở hữu, SP4 bỏ `StorageQuotaLimits` và không khai lại class; adapter `FileStorageLimitAdapter` ở entry riêng `integrations/files.ts` (giữ S4-D21, bác đề xuất "trong `forApi()`/`forWorker()`" của SP6 r1); SP7 nạp entry qua dòng `entitlements-files` của `OPTIONAL_BRIDGES` do 4B thêm; kiểm lúc boot của files (`loadedModules().has('entitlements')` mà không có provider → không khởi động) do 4B thêm vì plan merge sau trong cặp 6A/4B; phụ thuộc 4B → 7A khai tường minh. Kèm theo: mô tả SP6 đổi sang `SUM(stored_bytes)` dưới `OrgMutationLock`; một tên hằng `FILES_STORAGE_FALLBACK_BYTES`, ST-3 so với `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES` do SP6 export | Header, 1 (tiêu chí 14), 2, 3 (mục 6), 4.1 S4-D4, S4-D21, 6.2, 9.7, 14, 17 E-17, 20.1 ST-1, 20.2 ST-2…ST-4, 20.5 20.8-d, 21 (4B), 22.3 X6-1, X6-4, X7-1, 23 |
| X2-4 (nghĩa vụ composition/secret của SP7) | Theo R-X16: `markModuleLoaded('entitlements')` ở dòng đầu `index.ts` (4A, hoặc 7A thêm nếu 4A merge trước), entry `integrations/files.ts` không gọi; dòng `MODULE_REQUIRES` `entitlements → tenancy`; SP4 không có trường secret nên không có `.meta({ secret })`, trường secret tương lai bắt buộc mang nó | 1 (tiêu chí 16 mới), 6.2, 21 (4A) |
| X2-5 (hợp đồng 3D chưa có văn bản; chủ boot check lệch) | Addendum 3D đã viết (R-X12): SP4 trích nó cho gate, bảng status theo `AUTH_MODE`, port `PlatformAccessAudit`, registry order, bộ ca `describePlatformStaffActionConformance`. Inventory lúc boot là của 6B (R-X17); AD-1 phần inventory chạy ở plan merge sau trong cặp 4C/6B; 4C chỉ phụ thuộc 3D | Header, 1 (tiêu chí 9), 4.1 S4-D15, 12.2, 13.2, 20.3 AD-1, 21 (4C, đoạn 4C ∥ 6B), 22.2 L1, 22.3 X6-3, 24 |
| X2-6 (gia hạn cùng gói: SP5 không gọi `assign`) | Theo R-X18 (phương án (a) của review): billing khẳng định lại gói ở mọi kỳ đã trả; S4-D11 và AD-5 viết lại cho khớp: cùng gói cùng nguồn cùng ref → `UNCHANGED`; gán tay bị ghi đè ở kỳ trả tiền kế tiếp trừ khi là override; gói retired → `REJECTED_RETIRED` mỗi kỳ; test PA-16 cho chuỗi nhiều kỳ | 4.1 S4-D11, 10.3, 17 E-8, 20.2 PA-16, 20.3 AD-5, 22.3 X5-2, 23 |
| X2-m1 (`EntitlementsVersionSkewError` và lớp lỗi không export) | Theo R-X19: export tám lớp lỗi có tên ở `index.ts` (thêm tên `EntitlementsContextError` cho lỗi thiếu UoW/org context vốn chỉ là "`Error` có tên" ở r1); ghi danh sách đầy đủ lỗi mà `assign` ném và khẳng định `assign` không ném `EntitlementsVersionSkewError`; test EC-10 | 6.2, 6.4, 9.7, 10.2, 10.3, 15, 20.1 EC-10, 22.3 X5-3 |

**Không thuộc SP4:** X2-2 (helper sweep; SP4 không quét, mục 13.2 không đổi), X2-3 (phê duyệt hai người cho route tiền của SP5), X2-m2 (`_starter_prices` của SP7).

**Sửa sau chốt r2 (2026-09-29, review plan 4A finding C2):** §10.2 bước 2 bỏ JOIN `plans` khỏi câu `FOR NO KEY UPDATE` (khoá chỉ `org_entitlements`, tra gói bằng câu thứ hai trước câu ghi đầu tiên) vì JOIN làm phiên chờ khoá nhận 0 dòng sau khi phiên trước đổi `plan_id` → `EntitlementsRowMissingError` giả trên đường tiền; hợp đồng C-2 đổi "nhiều nhất một câu `SELECT`" thành "hai".

Sửa theo plan 4A: §8.3 kiểm catalogue ở onModuleInit (worker lệch không consume job); §19 thêm result precondition_failed.
