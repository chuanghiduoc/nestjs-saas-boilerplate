# 0005 — Cô lập tenant bằng RLS fail-closed

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Quên lọc org ở query không được làm lộ dữ liệu. Pool tái sử dụng connection và PgBouncer transaction mode đòi session tenant chỉ sống trong transaction.

## Quyết định

Bảng tenant có `org_id` bật cả RLS và FORCE RLS, policy dùng `USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`. Hàm `app_current_org()` ném `P0001` khi `app.org_id` NULL hoặc rỗng; không cast trực tiếp `current_setting`. Postgres giữ custom variable thành chuỗi rỗng sau transaction, nên kiểm tra NULL đơn thuần không đủ.

Policy chỉ viết trong migration SQL; không đồng thời sinh policy bằng filter `rls: true` của ORM. Grant theo từng bảng, không `ALTER DEFAULT PRIVILEGES`. `app_user` và `app_relay` đều NOBYPASSRLS; owner chỉ dùng cho migration. Role `app_admin` (BYPASSRLS) chưa được tạo trong SP1 vì chưa có use case, và không bao giờ khởi tạo trong process api (spec SP1 §5.3).

### Ngoại lệ có chủ đích (R10, R11)

`outbox_events` và `processed_events` là bảng hạ tầng bảo vệ bằng grant, không RLS. `app_user` chỉ INSERT outbox; inbox cấp quyền tối thiểu để chống trùng. `processed_events` dùng PK tự nhiên `(consumer, event_id)`, vẫn có `created_at`/`updated_at`.

`scheduled_tasks` là bảng tenant, vẫn RLS + FORCE. Policy org giới hạn `TO app_user`; policy bổ sung chỉ `FOR SELECT TO app_relay USING (true)`, với GRANT SELECT cho relay để reconcile nhiều org. Không áp policy gọi `app_current_org()` cho relay chưa có org. Hai role không là thành viên của nhau.

### OrgScope

`OrgScope.run(orgId, fn)` validate UUID, chuẩn hoá chữ thường; sai trả `400 org_context_invalid` trước khi truy cập DB. Fork EM với session `app.org_id`, bind vào CLS con và đặt org của RequestContext.

Nếu transaction đã mở, chỉ nhập khi session của EM thực sự mang cùng org. Khác org hoặc transaction mở không có org thì ném lỗi; giá trị CLS đơn thuần không đủ làm bằng chứng. Session áp bằng `set_config(..., true)` tại BEGIN, implicit query cũng được bọc transaction; commit không để org lưu lại trên connection dùng chung.

### Kiểm tra catalog (R20)

Đã có `test/integration/core/database/rls-catalog.spec.ts` từ Task 17: kiểm tra bảng có org dùng RLS + FORCE + policy `app_current_org`, chấp nhận allowlist hạ tầng và policy SELECT của relay, kiểm tra role không BYPASSRLS cùng allowlist bảng toàn cục. Đây là kiểm tra integration chạy với Docker, không phải việc còn chờ triển khai.

### Ánh xạ lỗi và retry

| SQLSTATE | Kết quả |
| --- | --- |
| 23505, 23503, 23001 | 409 conflict hoặc mã constraint đã đăng ký |
| 23514, 23502 | 422 validation_failed hoặc mã đã đăng ký |
| 42501 có dấu hiệu RLS/message hoặc routine ExecWithCheckOptions | 404 not_found, log cảnh báo bảo mật |
| 42501 do thiếu GRANT | 500 internal_error |
| 40001, 40P01, 57014 | 503 service_unavailable |
| P0001 thiếu org | 500 internal_error, lỗi lập trình phải sửa |

`dbErrorMapper` (đăng ký trong `DatabaseModule.onModuleInit`) đọc SQLSTATE từ `code` (`DriverException` của MikroORM chép mọi field của lỗi pg; lỗi phát sinh lúc `COMMIT` là lỗi pg thô), `sqlState` hoặc `cause.code`. Postgres 18 báo vi phạm FK `ON DELETE RESTRICT` là `23001 restrict_violation`, không phải `23503` (thấy trong integration test), nên 23001 cũng được map. Không lộ tên constraint/detail SQL cho client. `USING` có thể chỉ lọc ra 0 dòng khi UPDATE/DELETE tenant khác; repository phải xử lý 0 dòng thành không tìm thấy.

UnitOfWork ngoài cùng retry `40001`/`40P01` theo `DB_TX_RETRY_ATTEMPTS`, exponential backoff + full jitter; mỗi lần dùng fork mới. Callback tối đa `1 + DB_TX_RETRY_ATTEMPTS` lượt, side effect bên ngoài phải qua outbox.

## Cập nhật SP2 (2026-09-27)

Schema `auth` có role runtime riêng `auth_user`, role này không có quyền trên `public`; bảng `auth.*` không có `org_id`, nằm ngoài RLS và tách khỏi `app_user`/`app_relay`. Role owner quản lý migration; quyền runtime chỉ cấp từng bảng cho `auth_user`. Thu hồi `PUBLIC` USAGE trên schema `public`, CONNECT/TEMPORARY trên database và EXECUTE mặc định cho hàm mới (S2-R18). Test ma trận quyền kiểm cả schema, bảng và hàm; không coi chỉ REVOKE trên bảng là đủ.

Membership theo org thuộc SP3, không giả định SP2 đã có view membership/RLS. Mã hoá token và quyền auth pool theo ADR 0010.

## Cập nhật SP3 (3A) (2026-09-29)

- **Role `tenancy_definer`** (`NOLOGIN NOSUPERUSER NOBYPASSRLS`, script `docker/postgres/init/01-roles.sh`): chủ sở hữu duy nhất của 6 hàm `SECURITY DEFINER` chỉ đọc của tenancy (`tenancy_list_user_orgs`, `tenancy_count_user_orgs`, `tenancy_count_orgs_created_by`, `tenancy_user_sole_owner_orgs`, `tenancy_user_related_org_ids`, `tenancy_orgs_due_for_purge`; `SET search_path = ''`, tham số `NULL`/ngoài biên → `RAISE`, `EXECUTE` chỉ cho `app_user`). Có `USAGE, CREATE` trên `public` vì hàm được tạo DƯỚI role này; `app_owner` là member `INHERIT FALSE, SET TRUE`, nên từ PG 16 mọi DDL trên hàm definer phải nằm giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE` (test quét migration ép). Không có `app_admin`: cron quét nhiều org gọi hàm definer rồi làm việc từng org trong `OrgScope` bằng `app_user`.
- **Policy `TO app_user`** trên mọi bảng tenant của SP3; policy `FOR SELECT TO tenancy_definer USING (true)` chỉ trên `organizations`, `org_roles`, `org_members` (đúng các bảng hàm definer đọc; hằng `DEFINER_READ_TABLES_3A` của test catalog). `organizations` là bảng gốc tenant (`id = app_current_org()`, không có cột `org_id`). FK kép `(org_id, id)` cho role của member; bảng tenant neo org trực tiếp bằng FK `RESTRICT` tới `organizations` (quy ước B5; `scheduled_tasks_org_fk` của core).
- **Migration đọc/ghi dữ liệu trên bảng FORCE** theo mẫu 7 bước (spec SP3 §8.8): `NO FORCE` từng bảng theo thứ tự cố định → DML + tăng version + event → `SET CONSTRAINTS <schema>.<tên> IMMEDIATE` theo tên (không bao giờ `ALL`) → trả chế độ khai báo → `FORCE` lại → khối `DO` khẳng định không bảng tenant nào mất FORCE (chạy ở mọi môi trường). Tên constraint deferrable duy nhất theo schema và không trùng constraint nào khác (khối bước 4 `RAISE`; `rls-catalog.spec.ts` kiểm ở CI). Không migration nào `isTransactional()`.
- **Down đối xứng** xoá cả hàm trigger và hàm definer (test quét `CREATE`/`DROP FUNCTION`); migration chia theo plan (3A: `core/…_scheduled_tasks_suspended_at`, `notifications/…_email_templates_lookup`, `tenancy/…_tenancy_core`, `tenancy/…_scheduled_tasks_org_link`), timestamp sau migration mới nhất trên `main` (`migration-order.spec.ts`).
- **`migrations.spec.ts` chạy trên database riêng** (`test/support/scratch-db.ts`): tạo bằng superuser bootstrap không `OWNER`, rồi chạy chính `01-roles.sh` cho database đó; test khẳng định owner/`pg_database_owner` như production.
- **Rủi ro còn lại:** SQL injection dưới `app_user` vẫn bị RLS giới hạn trong org của session, nhưng đọc được mọi bảng global mà `app_user` có `SELECT` (`tenancy_users`, `permissions`); không có dữ liệu bí mật ở đó.

## Cập nhật SP6 (6.0) (2026-09-29)

- **Hai role NOLOGIN mới** trong `docker/postgres/init/01-roles.sh` (`NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, `USAGE, CREATE ON SCHEMA public`, `app_owner` là member `INHERIT FALSE, SET TRUE`): `partition_owner` sở hữu mọi bảng partitioned và hàm bảo trì partition (drop partition cần quyền owner, runtime không có `app_owner`); `sweep_definer` sở hữu **mọi** hàm `SECURITY DEFINER` quét xuyên org của mọi module/feature (R-X4) — `tenancy_definer` giữ nguyên, chỉ cho tenancy. Mọi DDL trên đối tượng của ba role NOLOGIN nằm giữa `SET LOCAL ROLE <role>` và `RESET ROLE`; `migration-scan.spec.ts` ép theo `NOLOGIN_OWNER_ROLES` và `OWNED_FUNCTIONS` (`test/support/core-catalog.ts`), gồm cả `CREATE TABLE … PARTITION BY` phải dưới `partition_owner`.
- **Hàm của hai role:** `SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC` rồi `GRANT EXECUTE … TO app_user` (default privilege của `01-roles.sh` chỉ phủ hàm do `app_owner` tạo); tham số `NULL`/ngoài biên → `RAISE`. Hàm bảo trì partition khai `SET lock_timeout = '5s'` là thuộc tính hàm, không `set_config` trong thân (giá trị trong thân sống tới hết transaction của caller, gồm cả lô migration); `rls-catalog.spec.ts` khẳng định `proconfig` và cấm `set_config('lock_timeout', …)` trong thân mọi hàm của hai role. Policy đọc của `sweep_definer` tên `<bảng>_definer_read`, grant chỉ theo cột.
- **Bảng partitioned:** RLS, FORCE, policy, grant, index, trigger khai trên bảng cha; partition không có RLS riêng nên không được có grant nào (`app_user` đọc thẳng partition → `42501`). `rls-catalog.spec.ts` khẳng định owner `partition_owner` và không grant cho `app_user`/`app_relay`/`auth_user` trên mọi partition; tập `SECURITY DEFINER` của `public` = hợp các hằng theo plan (tenancy ∪ sweep ∪ partition).
- **Rủi ro còn lại:** SQL injection dưới `app_user` gọi được mọi hàm quét (chỉ trả `org_id`) và hàm bảo trì (sàn retention cứng trong thân hàm, không hạ được).

## Cập nhật SP3 (3B) (2026-09-29)

- **`org_role_permissions`** (bảng nối của role tuỳ biến): RLS + FORCE, policy `TO app_user`, FK kép `(org_id, role_id) → org_roles ON DELETE CASCADE`, FK `permission_id → permissions ON DELETE RESTRICT`; `app_user` chỉ `SELECT, INSERT, DELETE` (sửa role = xoá/thêm dòng). Chuẩn hoá: 1NF hình thức theo ngoại lệ E1 (`role_id → org_id`), giữ nhất quán bằng FK kép + không `UPDATE` + `WITH CHECK`.
- **Trigger hoãn đọc bảng tenant là `SECURITY DEFINER` của `tenancy_definer`**: hàm dùng chung `tenancy_permission_scope_closed_ck(owner_column)` (tập quyền đã lưu phải đóng theo `requires`) đọc qua policy `org_role_permissions_definer_read` và grant `SELECT` theo cột trên `org_role_permissions`, `permission_requires`; kiểm `READ COMMITTED` rồi lấy `pg_advisory_xact_lock(tenancy_org_lock_key(org))` trước khi đọc, nên đổi `app.org_id` trước COMMIT không làm nó đạt âm thầm và hai kết nối SQL không khoá không tạo write skew (spike S3B-1, S3B-4). 3D gắn cùng hàm lên hai bảng phạm vi của mình. Trigger `BEFORE INSERT` (`org_role_permissions_guard`) giữ quyền caller và trả `NEW` khi RLS giấu role, để câu ghi chéo org vẫn ra `42501` (S3B-2).
- **`down` không làm mất dữ liệu âm thầm:** `down` của `…_custom_role_permissions` từ chối khi còn role tuỳ biến (đọc `org_roles` theo mẫu `NO FORCE … FORCE` + khẳng định).
- **Migration dữ liệu catalogue** (mẫu 7 bước của spec §8.8) có test chạy thật qua runner: xoá quyền, thêm cạnh `requires` (thu hẹp tới điểm bất động), không rò `IMMEDIATE`, tên constraint deferrable duy nhất, quên bước 6 thì bước 7 rollback cả lô (`test/integration/tenancy/catalogue-data-migration.spec.ts`).

## Phương án đã loại

Chỉ lọc org ở app, policy đọc session không kiểm tra rỗng, dùng role BYPASSRLS cho API và đổi org giữa transaction đều không bảo đảm fail-closed.

## Hệ quả

App phải thiết lập OrgScope trước transaction tenant; đọc nhiều org chỉ qua quyền hẹp đã khai báo. FK kép `(org_id, x_id)` thuộc SP3. RLS không thay thế xác thực hay kiểm tra quyền nghiệp vụ.

## Nguồn

Spec SP1 §5.3–5.4, §5.7; review trước thực thi §2.3–2.8; R10–R11, R20; báo cáo Task 7, 9, 11 và 17.
