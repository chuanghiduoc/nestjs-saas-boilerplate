# Sub-project 3B — Role tuỳ biến và chống leo quyền (custom roles and anti-escalation): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm role tuỳ biến theo org vào module `tenancy` đã có của 3A: bảng `org_role_permissions` (RLS FORCE, trigger guard, trigger hoãn "tập đóng" dùng chung với 3D), `RoleService` với `POST/PATCH/DELETE /v1/orgs/{orgId}/roles`, luật 1 (cả `oldSet` lẫn `newSet`), 2a(i)–(iii), 6, câu thứ hai của đường nóng (quyền role tuỳ biến) nối vào middleware, re-auth trong transaction và đổi role member, event `tenancy.role.*`, mẫu migration dữ liệu catalogue 7 bước cùng các test K-9/K-9b/K-9c/K-17 phần role; chứng minh bằng test trên Postgres 18 + PgBouncer + Redis + Mailpit thật và bằng smoke chạy image production qua `docker compose --profile app`; 3B ship một mình với CI xanh.

**Architecture:** Migration `tenancy/…_custom_role_permissions` (file mới, không sửa migration 3A) tạo bảng nối `org_role_permissions (org_id, role_id, permission_id)` với FK kép `CASCADE` tới `org_roles`, FK `RESTRICT` tới `permissions`, policy `TO app_user` + policy đọc của `tenancy_definer`, trigger `BEFORE INSERT` quyền caller (chỉ role tuỳ biến, không `ownerOnly`, không deprecated) và trigger hoãn `org_role_permissions_closed_ck` gọi hàm dùng chung `public.tenancy_permission_scope_closed_ck(owner_column)` — `SECURITY DEFINER` thuộc `tenancy_definer`, kiểm `READ COMMITTED`, lấy khoá advisory theo org (`tenancy_org_lock_key`) rồi đọc bằng snapshot mới, nên không phụ thuộc `app.org_id` lúc COMMIT và không có write skew khi hai kết nối SQL cùng sửa một tập. Ở app, `RolePermissions` (một câu `role_id = ANY(?)` trên PK) là nguồn duy nhất của tập quyền role tuỳ biến cho middleware (đường nóng), `ActorReauthorizer`, `MemberService` và `RoleService`; luật chống leo quyền là hàm thuần ở `domain/escalation.ts` và `domain/role.ts`, mọi mutation role khoá org → role `FOR NO KEY UPDATE` → member `FOR SHARE`, kiểm lại cửa và trần, ghi outbox cùng transaction.

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), `@casl/ability` 7.0.1 (đã có từ 3A, không thêm package), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), zod 4.6.5, uuid 14.0.2, Vitest + Testcontainers, `tcp-proxy.ts`, Docker Compose smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md` (r8, đã chốt; §22.3 Bảng 1–5 dòng 3B là nguồn phạm vi của plan này). Kèm theo, cùng ràng buộc: `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` (R-X7: 3B thuộc sóng W2 cùng 4A, 6.0, 7A; R-X3), `docs/superpowers/specs/2026-09-28-sp3-parent-spec-amendments.md` (bỏ nhãn `(3B)` khi merge), ADR 0017, spec cha `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`. Mẫu định dạng và tên code dùng lại: `docs/superpowers/plans/2026-09-28-sp3a-tenancy-foundation.md` (các khối "Produces"). Bài học của 3A: `.superpowers/sdd/2026-09-28-sp3a-tenancy-foundation/progress.md`.

**Điều kiện bắt đầu:** plan 3A đã merge vào `main` (PR của Task 31 3A, gồm Task 20b của R-X21: key chỉ có ở DB là WARN + metric `tenancy_catalogue_orphan_keys`, không chặn boot) và nhánh `sp3b-custom-roles` tạo từ `main` mới nhất. Mọi tên của 3A dùng trong plan này lấy từ khối "Produces" của plan 3A; Step 0 của Task 2 đối chiếu chúng với code đã merge.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2 và 3A (Global Constraints của `2026-09-28-sp3a-tenancy-foundation.md`), cộng các luật của SP3 (spec §3, bắt buộc cho mọi task):

- **Package-first:** 3B không cài package nào (spec §18.4: "3B, 3C, 3D không thêm dependency"). Không cài `fast-check` (generator tự viết, `test/unit/modules/tenancy/prng.ts` của 3A).
- **Generator:** `nest g service|controller <path> --no-spec` cho khung Nest; `pnpm exec mikro-orm migration:create --blank --path src/migrations/tenancy --name custom_role_permissions` cho migration. Tên file do CLI sinh (`Migration<14 chữ số>_custom_role_permissions`); plan viết `Migration<ts>_custom_role_permissions`, code và test không viết cứng timestamp (tìm theo hậu tố tên). Timestamp phải lớn hơn migration mới nhất trên `main` (`migration-order.spec.ts` của 3A).
- **Không đoán API:** CASL như 3A (spec §8.7); tên của 3A (`ActorReauthorizer`, `EscalationGuard`, `MemberService`, `RoleRepository`, `PermissionCatalogueRegistry`, `startTenancyApp`, `authed`, `seedOrg`, …) lấy từ khối "Produces" của plan 3A và được đối chiếu với code đã merge ở Step 0 của Task 2. TDD, không `any`, không tắt lint, không `as never`.
- **Bất biến nằm ở DB:** role hệ thống không nhận dòng quyền, quyền `ownerOnly`/deprecated không vào role tuỳ biến, tập quyền đã lưu luôn đóng theo `requires`, role đang có member không xoá được — đều là trigger/FK; app kiểm trước chỉ để trả lỗi đẹp. Vi phạm từ trigger: `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = '<tên>'`, map bằng `defineConstraintErrors`.
- **Trigger hoãn đọc bảng tenant là `SECURITY DEFINER` thuộc `tenancy_definer`** (bài học Task 13 của 3A): `SET search_path = ''`, mọi tên ghi `public.`, tạo/xoá dưới `SET LOCAL ROLE tenancy_definer … RESET ROLE`, kiểm `transaction_isolation = 'read committed'`, tuần tự hoá bằng `pg_advisory_xact_lock(public.tenancy_org_lock_key(org))` (definer không khoá được dòng). Trigger `BEFORE` không hoãn giữ quyền caller.
- **Kiểu dữ liệu:** bảng nối không có `id`/`public_id` (PK `(org_id, role_id, permission_id)`), `created_at`/`updated_at TIMESTAMPTZ`. Hằng định dạng dùng chung giữa zod và `CHECK`: `ROLE_NAME_MAX_LENGTH = 64`, `ROLE_DESCRIPTION_MAX_LENGTH = 500` (khớp `org_roles_name_ck`, `org_roles_description_ck` của 3A), `ROLE_PERMISSIONS_MAX = 256` (biên đầu vào của body).
- **FK có chủ đích:** `org_role_permissions → org_roles` là `CASCADE` (bảng nối thuộc hẳn role, spec §6.5); `→ permissions` là `RESTRICT` (xoá quyền khỏi catalogue mà quên migration dữ liệu thì fail to, PR10); `org_members → org_roles` giữ `RESTRICT` của 3A (xoá role đang dùng → `409 role_in_use`).
- **Mọi index gắn với một query:** PK `org_role_permissions_pk (org_id, role_id, permission_id)` → câu thứ hai của đường nóng và mọi lần đọc tập quyền; `org_role_permissions_permission_idx (permission_id)` → FK `RESTRICT` khi xoá quyền và migration dữ liệu catalogue (không bắt đầu bằng `org_id`: quét xuyên org, ghi lý do).
- **Migration:** SQL bằng `addSql`; `down` đối xứng đã test (up → down → up và sweep S2-R57 trên database riêng của `migrations.spec.ts`), xoá cả hàm trigger; không `ALTER DEFAULT PRIVILEGES`; mọi đọc/ghi dữ liệu trên bảng FORCE theo mẫu `NO FORCE … FORCE` + khối khẳng định; không `isTransactional()`; không `SET CONSTRAINTS ALL`. `down` từ chối khi còn role tuỳ biến (không mất dữ liệu âm thầm).
- **Chuẩn hoá (≥ 3NF, ưu tiên BCNF):** `org_role_permissions` chỉ đạt 1NF hình thức theo ngoại lệ E1 có tên của spec §6.12 (`role_id → org_id`, `org_id` ngoài khoá tối thiểu); cơ chế giữ nhất quán ở DB: FK kép, không grant `UPDATE` nào, `WITH CHECK`. Chép bảng chuẩn hoá vào chú thích đầu migration; `normalization-inventory.spec.ts` thêm bảng.
- **Mọi race có tên và cơ chế chặn** (bảng race 3B ở Self-review). Check-then-insert không bao giờ là cơ chế. Khoá dòng `FOR NO KEY UPDATE`, thứ tự cố định `organizations` → `tenancy_users` → `org_roles` → `org_members` (id tăng dần).
- **Không hard code:** 3B không thêm config (spec §22.3 Bảng 1: "Không thêm config"); hằng có tên ở `constants.ts`. `test/unit/architecture/hardcode-scan.spec.ts` phải xanh.
- **Fail loud, trừ key orphan (R-X23):** role tuỳ biến tới `effectivePermissions` mà không qua `RolePermissions` → ném; dòng quyền "trôi" khỏi catalogue lúc ghi (`INSERT … SELECT` chèn thiếu) → ném. Ngoại lệ có tên: key đã lưu trên role tuỳ biến mà không catalogue nào đã nạp khai báo (module bị tắt, R-X21) là **orphan** — đường nóng bỏ qua nó (không cấp gì, không 500), log WARN một lần mỗi key mỗi process (`{ event: 'orphan_permission_ignored', key }`) và cộng `tenancy_catalogue_orphan_keys`; sửa role gỡ được nó, không thêm lại được (`422 unknown_permission`). Chi tiết ở Task 5, 6, 7b.
- **Tập quyền trong test tính từ catalogue gộp (R-X24):** `ADMIN_KEYS`, C1 và mọi tập định nghĩa theo role hệ thống được tính lúc chạy (`adminKeys(merged)`, `roleSetC1(merged)` của `test/support/tenancy-seed.ts`, `merged` = `app.get(PermissionCatalogueRegistry).merged()` khi có app trong process); không viết cứng, để plan khác của sóng W2 thêm quyền (4A: `entitlements.read` cho ADMIN + MEMBER) không làm test 3B đỏ hay xanh sai lý do. Chỉ C0, C2 (tập tường minh của spec §18.3, không định nghĩa theo role hệ thống) là hằng.
- **Truy cập SQL:** chỉ qua `Db.execute` (placeholder `?`) trên EM đang gắn; không import `@mikro-orm` ngoài `infra/`. Không I/O ngoài trong `UnitOfWork.run`.
- **Không PII** trong log/metric/span: không email, token, tên/mô tả role, tập quyền trong log từ chối (`{ event: 'escalation_denied', rule }`).
- **Luật kiến trúc:** giữ luật 1–19 của 3A; 3B không thêm luật (không có biên module mới).
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** cuối nhóm schema (Task 3: migration 3B chạy từ `dist` trên image), cuối nhóm API (Task 12: luồng role tuỳ biến đầy đủ trên image) và ở Task 14 chạy `pnpm test:smoke`: build image production thật, `docker compose --profile app` với hạ tầng đầy đủ và `NODE_ENV=production`, migrate, smoke HTTP thật trong `test/smoke/`, log container JSON sạch (không PII, không `error`), `/health/ready` 200, rồi `down -v`. Đo lại kích thước image (ADR 0013; ghi dòng mới chỉ khi chênh > 1 MB so với dòng "SP3 (3A)").
- **Spike:** code spike là code bỏ đi (`test/integration/spike-sp3b/`, không commit). Kết quả ghi vào mục "Kết quả spike (plan 3B)" của ADR 0017 và được commit. Spike không đạt thì đi đúng nhánh fallback ghi trong Task 1.
- **Định dạng:** `pnpm lint` có `prettier --check .`; trước mỗi commit chạy `pnpm exec prettier --write <file đã đổi ngoài docs/>`.
- **Commit:** mỗi task một commit trở lên, conventional message tiếng Anh. Push và mở PR chỉ ở Task 14.

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không test nào của spec §18 phủ, dễ làm hỏng trải nghiệm người dùng nhất:

1. **Tên role chỉ khác hoa/thường, có khoảng trắng đầu/cuối, hoặc ngoài BMP:** `org_roles_name_uq` là `UNIQUE (org_id, lower(name))`, `CHECK` đếm code point. Mong đợi: `"Billing"` rồi `"BILLING"` trong cùng org → `409 role_name_taken` (org khác → `201`); `" Billing"`, `"Billing "` → `422 validation_failed` (không `500` từ `CHECK`); 64 emoji → `201`, 65 → `422`. Test: Task 4 (`roleName`), Task 6 (`role names: case-insensitive per org, trimmed, counted in code points`).
2. **`PATCH` không đổi gì** (cùng tập quyền nhưng khác thứ tự, lặp key, cùng tên): mong đợi `200`, **không** tăng `version` (ETag giữ nguyên), **không** event `tenancy.role.updated`, không xoá/chèn dòng quyền. Test: Task 6 (`a PATCH that changes nothing keeps the version and publishes no event`).
3. **`If-Match` trên `PATCH …/roles/{roleId}`**: thiếu → `428`, `*`/`"n"`/`W/"n"` → `200`, cũ → `412`; header `ETag` trả về luôn là dạng yếu `W/"n"` (`etagOf` của core, ADR 0007; `assertIfMatch` bỏ `W/` khi so); hai request song song cùng ETag → đúng một `200`, một `412` (so version dưới khoá role). Test: Task 6 (`If-Match on PATCH roles`), Task 8 (`two PATCHes with the same ETag: one 200, one 412`).
4. **Role với tập quyền rỗng `[]`**: spec không cấm; tập rỗng trội bởi mọi actor có `roles.write` nên không mở đường leo quyền. Mong đợi: tạo được (`201`), member giữ nó vẫn là member (`GET …/members/me` `200`) nhưng mọi route cần quyền → `403 forbidden`. Test: Task 6 (`an empty role is allowed and grants nothing`).
5. **Id role sai ở path/body**: `roleId` không phải UUID ở path → `404` (không `500` do `22P02`); `roleId` của org khác trong `PATCH …/members/{memberId}` → `422 validation_failed` (không lộ role của org khác); `PATCH`/`DELETE` role hệ thống → `409 system_role_immutable`. Test: Task 6 (`role ids that are not UUIDs are 404`, R-10, R-13), Task 7 (`a role id of another org is not assignable`).

---

## File Structure

```
src/
  migrations/tenancy/  Migration<ts>_custom_role_permissions.ts   (mới: bảng, trigger guard, hàm closure dùng chung, down có guard)
  modules/tenancy/
    constants.ts                       + ROLE_NAME_MAX_LENGTH, ROLE_DESCRIPTION_MAX_LENGTH, ROLE_PERMISSIONS_MAX
    errors.ts                          + CANNOT_EDIT_OWN_ROLE, ROLE_IN_USE, ROLE_NAME_TAKEN, MISSING_DEPENDENCIES,
                                         UNKNOWN_PERMISSION, PERMISSION_NOT_DELEGABLE + map constraint 3B
    events.ts                          + RoleCreatedEvent, RoleUpdatedEvent, RoleDeletedEvent
    domain/  role.ts (mới: roleName, roleDescription, checkCustomRoleSet, sameSet)
             escalation.ts (+ luật 1, 2a(i)–(iii), 6) · catalogue.ts (+ PERMISSION_KEY_PATTERN)
    application/
             authz/effective-permissions.ts (+ customRolePermissions: bỏ qua key orphan, R-X23)
             authz/role-permissions.ts (mới: RolePermissions, WARN + metric cho key orphan)
             role.service.ts (mới) · escalation-guard.ts (+ CANNOT_EDIT_OWN_ROLE) · actor-reauthorizer.ts, member.service.ts
             (đọc tập role tuỳ biến qua RolePermissions)
    ports/   role-repository.ts (+ permissionKeys, insertCustom, lockByPublicId, update, replacePermissions, deleteById)
    infra/sql/ sql-role.repository.ts (+ ROLE_PERMISSIONS_SQL) · org-purge.sql.ts (+ org_role_permissions)
    http/    org-context.middleware.ts (câu thứ hai của đường nóng) · roles.controller.ts (POST/PATCH/DELETE + đọc qua RoleService)
             schemas.ts (+ CreateRoleBody, PatchRoleBody, PermissionKey)
    tenancy.module.ts                  + RolePermissions, RoleService
openapi.json                           3 operation mới (oasdiff chỉ thêm)
test/
  support/  tenancy-catalog.ts (+ hằng *_3B) · tenancy-seed.ts (+ seedCustomRole, seedMemberInRole) · org-lock-barrier.ts (mới)
            catalogue-migration.ts (mới: mẫu 7 bước dùng cho fixture K-9)
  unit/modules/tenancy/  role.spec.ts · escalation-roles.spec.ts · role-permissions.spec.ts (mới) · effective-permissions.spec.ts
            escalation-guard.spec.ts · errors.spec.ts (sửa)
  integration/
    core/database/  rls-catalog.spec.ts · normalization-inventory.spec.ts (sửa)
    tenancy/  custom-role-permissions-down.spec.ts · role-permissions-db.spec.ts · catalogue-data-migration.spec.ts (mới)
              hot-path-explain.spec.ts (sửa)
  e2e/tenancy/  fixtures/payroll-permissions.ts (mới) · custom-role-access.e2e.spec.ts · roles.e2e.spec.ts
              custom-role-assignment.e2e.spec.ts · orphan-permission-keys.e2e.spec.ts · role-races.e2e.spec.ts (mới)
              role-route-matrix.e2e.spec.ts, auth-modes.e2e.spec.ts, member-toctou.e2e.spec.ts (sửa)
  chaos/    tenancy-roles-outages.spec.ts · tenancy-roles-api-kill.spec.ts (mới)
  smoke/    tenancy.smoke.spec.ts (sửa)
docs/adr/  0017 (kết quả spike 3B, lệch có chủ đích) · 0005 · 0013 (chỉ khi chênh > 1 MB)
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (bỏ nhãn `(3B)`)
README.md (role tuỳ biến, vòng đời quyền, mẫu migration dữ liệu 7 bước)
```

**Vì sao `RolePermissions` là nguồn duy nhất của tập quyền role tuỳ biến:** spec §7.3 chỉ viết "thêm một câu" cho đường nóng, nhưng cùng tập đó còn được đọc ở `ActorReauthorizer` (đọc lại actor trong transaction), `MemberService` (target và role được gán), `RoleService` (tập cũ khi sửa/xoá) và `GET …/roles`. Một service một câu SQL (`role_id = ANY(?)`, PK) cho mọi chỗ, nên không có hai định nghĩa "quyền của role" lệch nhau (ví dụ một chỗ quên lọc `deprecated_at`).

**Vì sao mẫu 7 bước là helper của test, không phải code trong `src`:** migration là ảnh chụp đóng băng; migration import helper của `src` sẽ đổi hành vi khi helper đổi (3A đã chốt "migration không import code"). Mẫu SQL nguyên văn nằm trong README cho `features/` chép; `test/support/catalogue-migration.ts` sinh đúng mẫu đó cho các migration fixture của K-9/K-17, để mẫu được chạy thật qua runner.

---

## Phần A — Spike (bắt buộc làm trước mọi task khác)

Spec §4 không giao spike T nào cho 3B (T1–T6, T8 ở 3A; T7 ở 3D). Bốn giả định dưới đây là của thiết kế 3B (hàm closure dùng chung, trigger guard, `CASCADE` dưới FORCE, write skew), chưa ai chạy; mỗi cái trả lời bằng code chạy thật trên database riêng.

### Task 1: Spike S3B-1 … S3B-4 (hàm closure `SECURITY DEFINER` dùng chung, guard so với RLS, `CASCADE` dưới FORCE, write skew hai kết nối)

**Files:**
- Create (không commit): `test/integration/spike-sp3b/closure.spike.spec.ts`
- Modify: `docs/adr/0017-tenancy-own-module.md` (mục "Kết quả spike (plan 3B)")

**Interfaces:**
- Consumes: `createScratchDb` (3A Task 2), `runMigrations`, `coreMigrationList` (SP1/3A), `seedOrg({ database })` (3A Task 14), `dbErrorMapper`, `pgFields`, `defineConstraintErrors`, `CoreErrors` (SP1).
- Produces: kết luận đạt/không đạt của S3B-1 … S3B-4 (bảng ADR 0017) — quyết định cách viết migration ở Task 2:
  - **S3B-1:** một hàm trigger `SECURITY DEFINER SET search_path = ''` thuộc `tenancy_definer`, nhận tên cột chủ tập qua `TG_ARGV[0]`, đọc cột đó bằng `to_jsonb(NEW|OLD) ->> TG_ARGV[0]`, truy vấn bằng `EXECUTE format('… %I.%I …', TG_TABLE_SCHEMA, TG_TABLE_NAME)` và `RAISE … CONSTRAINT = TG_NAME` lúc COMMIT: lỗi COMMIT có `code = '23514'`, `constraint = 'org_role_permissions_closed_ck'`; `dbErrorMapper` trả mã theo constraint (không phải `503`); đổi `app.org_id` sang org khác trước COMMIT vẫn bị chặn. Fallback: mỗi bảng phạm vi một hàm trigger riêng (3B viết hàm cho `org_role_permissions`, 3D viết hàm của mình), ghi ADR 0017.
  - **S3B-2:** trigger `BEFORE INSERT` quyền caller trả `NEW` khi không thấy dòng role (RLS giấu org khác) → `INSERT` dòng của org khác vẫn ra `42501` (tiêu chí 1), không phải `23514`. Fallback: guard ném khi không thấy role, isolation test kỳ vọng `23514` cho bảng này, ghi ADR 0017.
  - **S3B-3:** `app_user` xoá một role tuỳ biến trong OrgScope (FORCE RLS) → các dòng `org_role_permissions` bị `CASCADE` (hành động RI bỏ qua RLS), trigger closure (role đã mất, không còn dòng) đạt, COMMIT xanh. Fallback: `RoleService.delete` xoá dòng quyền tường minh trước khi xoá role.
  - **S3B-4:** hai kết nối `app_user` không khoá org ở caller: một `INSERT` quyền R (R `requires` P) vào role, một `DELETE` P khỏi cùng role; lịch TẤT ĐỊNH theo mẫu `definer-triggers.spec.ts` của 3A (x ghi rồi `SET CONSTRAINTS org_role_permissions_closed_ck IMMEDIATE` để kiểm ngay và giữ khoá advisory; y ghi rồi gửi `COMMIT`; test chờ tới khi backend của y đứng chờ khoá advisory trong `pg_locks`; x `COMMIT`), cả hai chiều (thêm trước ∥ bỏ trước) → bên sau luôn bị từ chối với `org_role_permissions_closed_ck`, tập cuối đóng. Bỏ khoá advisory khỏi hàm thì y không bao giờ chờ và test đỏ (chạy thử một lần, ghi vào ADR). Fallback: bỏ khoá advisory, ghi race còn lại có tên (chỉ SQL tay không khoá; đường app đã khoá org + role) trong ADR 0017.

- [ ] **Step 1: Spike (một file, database riêng, SQL giống hệt migration dự kiến của Task 2)**

`test/integration/spike-sp3b/closure.spike.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbErrorMapper, defineConstraintErrors, pgFields, runMigrations } from '../../../src/core/database/index.js';
import { CoreErrors } from '../../../src/core/errors/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const LOCK_WAIT_POLL_MS = 20;
const LOCK_WAIT_MAX_POLLS = 250;
/** SQL dự kiến của migration 3B (Task 2 chép nguyên nếu spike đạt). */
const SCHEMA = [
  `CREATE TABLE org_role_permissions (
    org_id UUID NOT NULL, role_id BIGINT NOT NULL, permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_role_permissions_pk PRIMARY KEY (org_id, role_id, permission_id),
    CONSTRAINT org_role_permissions_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_role_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE RESTRICT)`,
  `ALTER TABLE org_role_permissions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE org_role_permissions FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY org_role_permissions_tenant ON org_role_permissions TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`,
  `CREATE POLICY org_role_permissions_definer_read ON org_role_permissions FOR SELECT TO tenancy_definer USING (true)`,
  `GRANT SELECT, INSERT, DELETE ON org_role_permissions TO app_user`,
  `GRANT SELECT (org_id, role_id, permission_id) ON org_role_permissions TO tenancy_definer`,
  `GRANT SELECT (permission_id, required_permission_id) ON permission_requires TO tenancy_definer`,
  `CREATE FUNCTION tenancy_org_role_permissions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_system_key text; v_owner_only boolean; v_deprecated timestamptz;
BEGIN
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key IS NOT NULL THEN
    RAISE EXCEPTION 'system roles hold no stored permissions' USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_custom_only';
  END IF;
  SELECT owner_only, deprecated_at INTO v_owner_only, v_deprecated FROM public.permissions WHERE id = NEW.permission_id;
  IF FOUND AND v_owner_only THEN
    RAISE EXCEPTION 'owner-only permissions cannot be delegated' USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_not_delegable';
  END IF;
  IF FOUND AND v_deprecated IS NOT NULL THEN
    RAISE EXCEPTION 'deprecated permissions cannot be granted' USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_deprecated';
  END IF;
  RETURN NEW;
END $$`,
  `CREATE TRIGGER org_role_permissions_guard BEFORE INSERT ON org_role_permissions FOR EACH ROW EXECUTE FUNCTION tenancy_org_role_permissions_guard()`,
  `SET LOCAL ROLE tenancy_definer`,
  `CREATE FUNCTION public.tenancy_permission_scope_closed_ck() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row jsonb; v_org uuid; v_owner bigint; v_missing bigint;
BEGIN
  IF TG_NARGS <> 1 THEN RAISE EXCEPTION 'tenancy_permission_scope_closed_ck expects the owner column as its only argument'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the permission closure check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;
  v_org := (v_row ->> 'org_id')::uuid;
  v_owner := (v_row ->> TG_ARGV[0])::bigint;
  IF v_org IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'tenancy_permission_scope_closed_ck: row without org_id or %', TG_ARGV[0]; END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(v_org));
  EXECUTE format(
    'SELECT s.permission_id FROM %1$I.%2$I s JOIN public.permission_requires r ON r.permission_id = s.permission_id
     WHERE s.org_id = $1 AND s.%3$I = $2
       AND NOT EXISTS (SELECT 1 FROM %1$I.%2$I t WHERE t.org_id = $1 AND t.%3$I = $2 AND t.permission_id = r.required_permission_id)
     LIMIT 1', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0])
    INTO v_missing USING v_org, v_owner;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'a stored permission set must be closed under requires'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END $$`,
  `REVOKE ALL ON FUNCTION public.tenancy_permission_scope_closed_ck() FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION public.tenancy_permission_scope_closed_ck() TO app_owner`,
  `RESET ROLE`,
  `CREATE CONSTRAINT TRIGGER org_role_permissions_closed_ck AFTER INSERT OR DELETE ON org_role_permissions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_permission_scope_closed_ck('role_id')`,
];

describe('spike 3B: closure trigger, guard, cascade, write skew', () => {
  let db: ScratchDb;
  let a: SeededOrg;
  let b: SeededOrg;
  let roleA: string;
  const app = () => db.client('app');
  const inOrg = async (c: pg.Client, org: string, fn: () => Promise<unknown>) => {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
    await fn();
    await c.query('COMMIT');
  };
  const perm = (key: string) => `(SELECT id FROM permissions WHERE key = '${key}')`;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('spike3b');
    vi.stubEnv('DB_NAME', db.name);
    await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
    const owner = await db.client('owner');
    try {
      await owner.query('BEGIN');
      for (const s of SCHEMA) await owner.query(s);
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    a = await seedOrg({ database: db.name });
    b = await seedOrg({ database: db.name });
    const c = await app();
    try {
      await inOrg(c, a.orgId, async () => {
        roleA = (await c.query<{ id: string }>(`INSERT INTO org_roles (org_id, name) VALUES ($1, 'Spike') RETURNING id::text AS id`, [a.orgId])).rows[0]!.id;
      });
    } finally {
      await c.end();
    }
    defineConstraintErrors({ org_role_permissions_closed_ck: CoreErrors.VALIDATION_FAILED });
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('S3B-1: a non-closed set fails at COMMIT with the trigger name as constraint, even after switching app.org_id', async () => {
    for (const switchOrg of [false, true]) {
      const c = await app();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [a.orgId]);
        await c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${perm('members.role.assign')})`, [a.orgId, roleA]);
        if (switchOrg) await c.query(`SELECT set_config('app.org_id', $1, true)`, [b.orgId]);
        const err = await c.query('COMMIT').then(() => undefined, (e: unknown) => e);
        expect(pgFields(err)).toMatchObject({ sqlState: '23514', constraint: 'org_role_permissions_closed_ck' });
        expect(dbErrorMapper(err)?.error.status).toBe(422);
      } finally {
        await c.end();
      }
    }
  });
  it('S3B-2: a row for another org is refused by RLS (42501), not by the guard', async () => {
    const c = await app();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [a.orgId]);
      await expect(
        c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${perm('org.read')})`, [b.orgId, b.roles.MEMBER.id]),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
  it('S3B-3: deleting a custom role as app_user cascades its permission rows under FORCE RLS and commits', async () => {
    const c = await app();
    try {
      let role = '';
      await inOrg(c, a.orgId, async () => {
        role = (await c.query<{ id: string }>(`INSERT INTO org_roles (org_id, name) VALUES ($1, 'Cascade') RETURNING id::text AS id`, [a.orgId])).rows[0]!.id;
        await c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key IN ('org.read', 'members.read')`, [a.orgId, role]);
      });
      await inOrg(c, a.orgId, () => c.query(`DELETE FROM org_roles WHERE id = $1`, [role]));
      await inOrg(c, a.orgId, async () => {
        expect((await c.query(`SELECT 1 FROM org_role_permissions WHERE role_id = $1`, [role])).rows).toEqual([]);
      });
    } finally {
      await c.end();
    }
  });
  const SKEW_STEP = {
    add: `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${perm('roles.write')})`,
    drop: `DELETE FROM org_role_permissions WHERE org_id = $1 AND role_id = $2 AND permission_id = ${perm('roles.read')}`,
  } as const;
  /** Mẫu tất định của 3A (`definer-triggers.spec.ts`): chờ tới khi backend `pid` đứng chờ một khoá advisory. */
  const waitForAdvisoryWait = async (probe: pg.Client, pid: number) => {
    for (let i = 0; i < LOCK_WAIT_MAX_POLLS; i++) {
      const { rows } = await probe.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`, [pid]);
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
    }
    throw new Error(`session ${pid} never waited on an advisory lock`);
  };
  it.each([
    ['add the dependant first, then drop its requirement', 'add', 'drop'],
    ['drop the requirement first, then add its dependant', 'drop', 'add'],
  ] as const)('S3B-4: two unlocked connections, %s → the later COMMIT waits on the advisory lock, then is refused', async (_n, first, second) => {
    const [x, y, probe] = [await app(), await app(), await app()];
    try {
      let role = '';
      await inOrg(x, a.orgId, async () => {
        role = (await x.query<{ id: string }>(`INSERT INTO org_roles (org_id, name) VALUES ($1, $2) RETURNING id::text AS id`, [a.orgId, `Skew ${first}`])).rows[0]!.id;
        await x.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${perm('roles.read')})`, [a.orgId, role]);
      });
      for (const c of [x, y]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [a.orgId]);
      }
      await x.query(SKEW_STEP[first], [a.orgId, role]);
      // x kiểm closure NGAY (tập của x còn đóng) và giữ khoá advisory của org tới hết transaction.
      await x.query('SET CONSTRAINTS org_role_permissions_closed_ck IMMEDIATE');
      await y.query(SKEW_STEP[second], [a.orgId, role]);
      const pid = (await y.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const yCommit = y.query('COMMIT').then(() => undefined, (e: unknown) => e);
      await waitForAdvisoryWait(probe, pid);
      await x.query('COMMIT');
      expect(pgFields(await yCommit)).toMatchObject({ sqlState: '23514', constraint: 'org_role_permissions_closed_ck' });
    } finally {
      await x.end();
      await y.end();
      await probe.end();
    }
  });
});
```
Ghi chú: `roles.write` `requires` `roles.read` (catalogue v1, migration `tenancy_core`), nên tập `{roles.write}` không đóng. Lịch cố định: y chỉ gửi `COMMIT` sau khi x đã giữ khoá advisory (câu kiểm `IMMEDIATE` của x), test chờ tới khi y thật sự đứng chờ khoá đó (`pg_locks … NOT granted`), rồi mới cho x commit; y đọc lại bằng snapshot mới (READ COMMITTED) và thấy phần x đã commit. Không phụ thuộc lịch chạy của hai `COMMIT` song song. Kiểm đột biến một lần: bỏ dòng `PERFORM pg_advisory_xact_lock(…)` khỏi `SCHEMA` → cả hai ca đỏ ở `session … never waited on an advisory lock`; ghi kết quả đó vào cột bằng chứng của ADR, rồi trả lại.

- [ ] **Step 2: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp3b/closure.spike.spec.ts`
Expected: PASS 5/5 (S3B-4 có hai chiều). Ca nào đỏ: đọc lỗi thật, đi đúng fallback của khối "Produces" ở trên, ghi vào ADR ở Step 3 và sửa Task 2 theo fallback trước khi làm tiếp (không sửa spike cho xanh).

- [ ] **Step 3: Ghi kết quả vào ADR 0017, xoá code spike**

Thêm vào `docs/adr/0017-tenancy-own-module.md`, ngay sau mục "## Kết quả spike (plan 3A)":
```markdown
## Kết quả spike (plan 3B)

Chạy trên nhánh `sp3b-custom-roles`, database riêng (`createScratchDb`, bootstrap bằng chính `01-roles.sh`), Postgres 18. Bốn giả định của thiết kế 3B (spec §4 không giao spike T nào cho 3B).

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| S3B-1 | Hàm trigger hoãn dùng chung `tenancy_permission_scope_closed_ck(owner_column)` (`SECURITY DEFINER` của `tenancy_definer`, `TG_ARGV`, `EXECUTE format`, `CONSTRAINT = TG_NAME`) chặn tập không đóng lúc COMMIT, kể cả khi đổi `app.org_id` trước COMMIT; lỗi mang tên trigger và map theo constraint | <Đạt/Không đạt + dòng lỗi thật> | spike `closure.spike.spec.ts` (không commit) |
| S3B-2 | Trigger `BEFORE INSERT` quyền caller trả `NEW` khi RLS giấu role → dòng của org khác vẫn `42501` | <…> | như trên |
| S3B-3 | Xoá role tuỳ biến bằng `app_user` dưới FORCE RLS `CASCADE` dòng quyền; closure đạt | <…> | như trên |
| S3B-4 | Write skew hai kết nối không khoá (INSERT quyền phụ thuộc ∥ DELETE quyền bị yêu cầu), lịch tất định cả hai chiều: bên commit sau chờ khoá advisory rồi bị từ chối `org_role_permissions_closed_ck`; bỏ khoá advisory → test đỏ | <…> | như trên |
```
Thay mỗi `<…>` bằng kết quả thật của Step 2 (đây là dữ liệu đo, không phải chỗ trống của plan; chỉ commit sau khi có). Rồi:
```bash
rm -rf test/integration/spike-sp3b
git add docs/adr/0017-tenancy-own-module.md
git commit -m "docs(adr): record the plan 3B spikes on the shared closure trigger, guard ordering, cascade and write skew"
```

---
## Phần B — Schema role tuỳ biến (spec §6.5, §6.12, §6.13 bảng 3B, §18.1)

### Task 2: Migration `custom_role_permissions` — bảng, RLS, guard, hàm closure dùng chung, `down` có guard; catalog, chuẩn hoá, thứ tự xoá cứng

**Files:**
- Create: `src/migrations/tenancy/Migration<ts>_custom_role_permissions.ts` (qua CLI), `test/integration/tenancy/custom-role-permissions-down.spec.ts`
- Modify: `src/modules/tenancy/infra/sql/org-purge.sql.ts`, `src/modules/tenancy/constants.ts`, `test/support/tenancy-catalog.ts`, `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: bảng `org_roles`, `permissions`, `permission_requires`, hàm `public.tenancy_org_lock_key(uuid)`, role `tenancy_definer` (3A Task 2, 13); hằng `DEFINER_*_3A`, `TENANCY_TENANT_TABLES_3A` (3A `test/support/tenancy-catalog.ts`); `ORG_PURGE_STATEMENTS` (3A Task 14); `createScratchDb`, `runMigrations`, `coreMigrationList`; kết luận S3B-1…4 (Task 1).
- Produces (tên là hợp đồng cho mọi task sau và cho 3D):
  - Bảng `org_role_permissions (org_id, role_id, permission_id, created_at, updated_at)`; constraint `org_role_permissions_pk`, `org_role_permissions_role_fk` (`(org_id, role_id) → org_roles(org_id, id) ON DELETE CASCADE`), `org_role_permissions_permission_fk` (`→ permissions(id) ON DELETE RESTRICT`); index `org_role_permissions_permission_idx`; policy `org_role_permissions_tenant` (`TO app_user`), `org_role_permissions_definer_read` (`FOR SELECT TO tenancy_definer`).
  - Grant: `app_user` `SELECT, INSERT, DELETE` (không `UPDATE`); `tenancy_definer` `SELECT (org_id, role_id, permission_id)` trên `org_role_permissions` và `SELECT (permission_id, required_permission_id)` trên `permission_requires`.
  - Hàm trigger quyền caller `tenancy_org_role_permissions_guard()` + trigger `org_role_permissions_guard` (`BEFORE INSERT`), vi phạm mang constraint `org_role_permissions_custom_only` / `org_role_permissions_not_delegable` / `org_role_permissions_deprecated`.
  - Hàm dùng chung `public.tenancy_permission_scope_closed_ck()` (`SECURITY DEFINER`, thuộc `tenancy_definer`, đối số trigger = tên cột chủ tập; `app_owner` có `EXECUTE` để `CREATE TRIGGER`, 3D gắn nó bằng `…('api_key_id')`, `…('grant_id')`) + constraint trigger `org_role_permissions_closed_ck` (`AFTER INSERT OR DELETE … DEFERRABLE INITIALLY DEFERRED`, đối số `'role_id'`).
  - `ORG_PURGE_STATEMENTS` có `DELETE FROM org_role_permissions …` trước `org_roles`.
  - `constants.ts`: `ROLE_NAME_MAX_LENGTH = 64`, `ROLE_DESCRIPTION_MAX_LENGTH = 500`, `ROLE_PERMISSIONS_MAX = 256`.
  - `tenancy-catalog.ts`: `DEFINER_READ_TABLES_3B = ['org_role_permissions']`, `TENANCY_TENANT_TABLES_3B = ['org_role_permissions']`, `DEFINER_TRIGGER_FUNCTIONS_3B = ['tenancy_permission_scope_closed_ck']`, `DEFINER_INTERNAL_FUNCTIONS_3B` (cùng tập); các hằng hợp (`DEFINER_READ_TABLES`, …) gộp thêm hằng 3B.

- [ ] **Step 0: Đối chiếu tên của 3A với code đã merge**

Run:
```bash
git fetch origin main && git log --oneline -1 origin/main
grep -n "export" src/modules/tenancy/index.ts src/modules/tenancy/ports/role-repository.ts src/modules/tenancy/application/actor-reauthorizer.ts src/modules/tenancy/application/escalation-guard.ts src/modules/tenancy/application/authz/effective-permissions.ts
grep -n "export" test/support/tenancy-app.ts test/support/tenancy-seed.ts test/support/tenancy-catalog.ts test/support/tenancy-principals.ts
grep -n "tenancy_catalogue_orphan_keys" -B2 -A3 src/modules/tenancy/application/tenancy-metrics.ts
ls src/migrations/tenancy
```
Expected: có `RoleRepository` (`insertSystemRoles`, `list`, `findByPublicId`, `findBySystemKey`), `ActorReauthorizer.require`, `EscalationGuard.enforce`, `effectivePermissions(role, merged)`, `startTenancyApp`, `authed`, `seedOrg`, `seedMember`, `withAppClient`, `inOrgTx`, `DEFINER_FUNCTIONS_3A`, `TENANCY_TENANT_TABLES_3A`, `definePermissionCatalogue`, `PermissionCatalogueContributor`, bốn migration 3A, và counter `tenancy_catalogue_orphan_keys` của Task 20b trên `TenancyMetrics` (plan này gọi field đó là `catalogueOrphanKeys` và gọi `add(1)` không attribute). Tên nào khác khối "Produces" của plan 3A: dùng tên thật của code cho mọi task sau và ghi một dòng vào mục "Lệch có chủ đích" của plan này trong commit của Task 2 (không đổi code 3A để khớp plan). Nếu 20b không để metric đó là một `Counter` trên `TenancyMetrics`, hoặc counter đòi attribute bắt buộc: DỪNG và hỏi controller (không tự đặt tên metric/label mới cho 3B).

- [ ] **Step 1: Hằng catalog 3B và test catalog (fail)**

`test/support/tenancy-catalog.ts` — thêm sau các hằng 3A (không sửa hằng 3A), rồi gộp vào các hằng hợp:
```ts
/** Plan 3B (spec §6.5; bài học Task 13 của 3A): hàm closure hoãn đọc bảng tenant nên là SECURITY DEFINER của tenancy_definer. */
export const DEFINER_READ_TABLES_3B = ['org_role_permissions'] as const;
export const TENANCY_TENANT_TABLES_3B = ['org_role_permissions'] as const;
export const DEFINER_TRIGGER_FUNCTIONS_3B = ['tenancy_permission_scope_closed_ck'] as const;
export const DEFINER_INTERNAL_FUNCTIONS_3B = [...DEFINER_TRIGGER_FUNCTIONS_3B] as const;
```
và sửa bốn hằng hợp:
```ts
export const DEFINER_READ_TABLES: readonly string[] = [...DEFINER_READ_TABLES_3A, ...DEFINER_READ_TABLES_3B];
export const TENANCY_TENANT_TABLES: readonly string[] = [...TENANCY_TENANT_TABLES_3A, ...TENANCY_TENANT_TABLES_3B];
export const DEFINER_TRIGGER_FUNCTIONS: readonly string[] = [...DEFINER_TRIGGER_FUNCTIONS_3A, ...DEFINER_TRIGGER_FUNCTIONS_3B];
export const DEFINER_INTERNAL_FUNCTIONS: readonly string[] = [...DEFINER_INTERNAL_FUNCTIONS_3A, ...DEFINER_INTERNAL_FUNCTIONS_3B];
```
(Nếu 3A đã khai báo hằng hợp ở vị trí khác trong file, giữ vị trí đó; chỉ nối thêm phần tử 3B. Các hằng hợp phải khai báo SAU hằng 3B.)

`test/integration/core/database/rls-catalog.spec.ts`, trong `it('tenancy_definer holds only column SELECT on the declared columns', …)` thêm trước `const tableLevel`:
```ts
      expect(cols('org_role_permissions')).toEqual(['org_id', 'permission_id', 'role_id']);
      // Hàm closure dùng chung (3B) đọc cạnh `requires`; không đọc cột nào khác của catalogue.
      expect(cols('permission_requires')).toEqual(['permission_id', 'required_permission_id']);
```
và trong `it('app_user UPDATE is column-scoped …', …)`: thêm `'org_role_permissions'` vào danh sách `table_name IN (…)` và dòng
```ts
      // Sửa role = xoá/thêm dòng (spec §6.5): bảng nối không có UPDATE nào.
      expect(cols('org_role_permissions')).toEqual([]);
```
Thêm một ca mới vào `describe('tenancy grants …')`:
```ts
    it('org_role_permissions: app_user holds SELECT, INSERT, DELETE and nothing else (spec §6.5)', async () => {
      const { rows } = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'org_role_permissions' ORDER BY privilege_type`,
      );
      expect(rows.map((r) => r.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT']);
    });
```
`test/integration/core/database/normalization-inventory.spec.ts` — thêm vào `ANALYSED_COLUMNS`:
```ts
  'public.org_role_permissions': ['org_id', 'role_id', 'permission_id', 'created_at', 'updated_at'],
```

Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts`
Expected: FAIL (bảng và hàm chưa có: tập policy definer, tập SECURITY DEFINER, cột `org_role_permissions` lệch).

- [ ] **Step 2: Test `down` từ chối khi còn role tuỳ biến (fail)**

`test/integration/tenancy/custom-role-permissions-down.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/**
 * Spec SP3 §6.13 "Down khi có dữ liệu chặn → lỗi rõ ràng, không mất dữ liệu" áp cho 3B: bỏ bảng khi còn role tuỳ biến
 * làm member giữ role đó mất mọi quyền, và code 3A (sau rollback) ném 500 cho role tuỳ biến. Database riêng, migrate tới
 * đúng migration 3B, nên không phụ thuộc migration của 3C/3D.
 */
describe('down of …_custom_role_permissions refuses while a custom role exists', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  let org: SeededOrg;
  let roleId: string;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('crpdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_custom_role_permissions'));
    if (at < 1) throw new Error('custom_role_permissions migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
    roleId = await withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, async () => {
          const { rows } = await c.query<{ id: string }>(`INSERT INTO org_roles (org_id, name) VALUES ($1, 'Kept') RETURNING id::text AS id`, [org.orgId]);
          await c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`, [org.orgId, rows[0]!.id]);
          return rows[0]!.id;
        }),
      db.name,
    );
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('a custom role seeded by app_user blocks the down; the table, the row and FORCE stay', async () => {
    await expect(runMigrations('down', { source: { kind: 'list', list }, to: previous })).rejects.toThrow(/custom roles exist/);
    const owner = await db.client('owner');
    try {
      expect((await owner.query(`SELECT to_regclass('public.org_role_permissions') IS NOT NULL AS present`)).rows).toEqual([{ present: true }]);
      expect((await owner.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname = 'org_roles'`)).rows).toEqual([{ relforcerowsecurity: true }]);
    } finally {
      await owner.end();
    }
    const kept = await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`SELECT 1 FROM org_role_permissions WHERE role_id = $1`, [roleId])), db.name);
    expect(kept.rows).toHaveLength(1);
  });
  it('once the custom role is gone the down succeeds and drops both functions', async () => {
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`DELETE FROM org_roles WHERE id = $1`, [roleId])), db.name);
    await expect(runMigrations('down', { source: { kind: 'list', list }, to: previous })).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      const { rows } = await owner.query(
        `SELECT proname FROM pg_proc WHERE proname IN ('tenancy_org_role_permissions_guard', 'tenancy_permission_scope_closed_ck')`,
      );
      expect(rows).toEqual([]);
    } finally {
      await owner.end();
    }
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/custom-role-permissions-down.spec.ts`
Expected: FAIL ("custom_role_permissions migration not found").

- [ ] **Step 3: Tạo migration bằng CLI và viết nội dung**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/tenancy --name custom_role_permissions`
Expected: file `src/migrations/tenancy/Migration<ts>_custom_role_permissions.ts` với timestamp lớn hơn mọi migration trên `main`.

Thay nội dung lớp (giữ tên lớp và `name` do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3B (spec SP3 §6.5, §6.13 bảng 3B): quyền của role tuỳ biến. Role hệ thống không có dòng ở đây (S3-A5, tập tính
 * trong code).
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_role_permissions | {role_id, permission_id} | role_id → org_id | 1NF hình thức: org_id ngoài khoá tối thiểu, phụ thuộc một phần khoá (vi phạm 2NF) — ngoại lệ E1 |
 * E1 — `org_id` lặp lại cho RLS không join và FK kép; giữ nhất quán ở DB: FK kép `(org_id, role_id) → org_roles(org_id, id)`
 * (bản sao không thể khác org của role), không grant UPDATE nào (bất biến), policy `WITH CHECK (org_id = app_current_org())`.
 * PK `(org_id, role_id, permission_id)` là siêu khoá, giữ `org_id` đứng đầu cho RLS.
 *
 * Index (mỗi cái một query): PK → câu thứ hai của đường nóng (spec §7.3) và mọi lần đọc tập quyền của role
 * (`org_id = app_current_org() AND role_id = ANY(?)`); `org_role_permissions_permission_idx` → FK RESTRICT khi xoá quyền
 * khỏi `permissions` và migration dữ liệu catalogue (quét xuyên org nên không bắt đầu bằng org_id).
 *
 * Trigger: `org_role_permissions_guard` (BEFORE INSERT, quyền caller: trigger không hoãn thấy đúng org của câu ghi);
 * `org_role_permissions_closed_ck` (hoãn) gọi hàm dùng chung `tenancy_permission_scope_closed_ck(owner_column)` —
 * SECURITY DEFINER của tenancy_definer (dưới quyền caller + FORCE RLS, câu kiểm lúc COMMIT chỉ thấy org của `app.org_id`
 * lúc COMMIT và đạt âm thầm khi caller đổi org; bài học Task 13 của 3A), kiểm READ COMMITTED, lấy khoá advisory theo org
 * (`tenancy_org_lock_key`, cùng khoá với trigger owner cuối) rồi mới đọc: hai kết nối SQL không khoá cùng sửa một tập
 * (thêm quyền phụ thuộc ∥ bỏ quyền bị yêu cầu) không commit được cả hai (write skew, spike S3B-4). 3D gắn cùng hàm lên
 * `org_api_key_permissions` ('api_key_id') và `org_support_grant_permissions` ('grant_id'); `down` của 3D không xoá hàm.
 *
 * Khoá: `SHARE ROW EXCLUSIVE` trên `org_roles` và `permissions` (FK) tới hết lô 3B: đọc không bị chặn, ghi role chờ (ngắn).
 */
export class Migration<ts>_custom_role_permissions extends Migration {
  override name = 'Migration<ts>_custom_role_permissions';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_role_permissions (
    org_id UUID NOT NULL,
    role_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_role_permissions_pk PRIMARY KEY (org_id, role_id, permission_id),
    CONSTRAINT org_role_permissions_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_role_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE RESTRICT);`);
    this.addSql(`CREATE INDEX org_role_permissions_permission_idx ON org_role_permissions (permission_id);`);
    this.addSql(`ALTER TABLE org_role_permissions ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_role_permissions FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY org_role_permissions_tenant ON org_role_permissions TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`CREATE POLICY org_role_permissions_definer_read ON org_role_permissions FOR SELECT TO tenancy_definer USING (true);`);
    // Sửa role = xoá/thêm dòng; không UPDATE (spec §6.5). DELETE cũng cho xoá cứng org (chạy bằng app_user trong OrgScope).
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_role_permissions TO app_user;`);
    this.addSql(`GRANT SELECT (org_id, role_id, permission_id) ON org_role_permissions TO tenancy_definer;`);
    this.addSql(`GRANT SELECT (permission_id, required_permission_id) ON permission_requires TO tenancy_definer;`);

    // Quyền caller: dòng role/quyền không thấy được (RLS giấu org khác; key không tồn tại) → trả NEW để WITH CHECK (42501)
    // hoặc FK (23503) quyết định, giữ đúng mã của tiêu chí 1 (spike S3B-2). Thấy được thì kiểm ba luật.
    this.addSql(`CREATE FUNCTION tenancy_org_role_permissions_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_system_key text;
  v_owner_only boolean;
  v_deprecated timestamptz;
BEGIN
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key IS NOT NULL THEN
    RAISE EXCEPTION 'system roles hold no stored permissions'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_custom_only';
  END IF;
  SELECT owner_only, deprecated_at INTO v_owner_only, v_deprecated FROM public.permissions WHERE id = NEW.permission_id;
  IF FOUND AND v_owner_only THEN
    RAISE EXCEPTION 'owner-only permissions cannot be delegated'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_not_delegable';
  END IF;
  IF FOUND AND v_deprecated IS NOT NULL THEN
    RAISE EXCEPTION 'deprecated permissions cannot be granted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_role_permissions_deprecated';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_role_permissions_guard BEFORE INSERT ON org_role_permissions
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_role_permissions_guard();`);

    // Hàm nội bộ của tenancy_definer (S3-A31: tạo dưới SET LOCAL ROLE). `app_owner` có EXECUTE chỉ vì CREATE TRIGGER đòi
    // (ở đây và ở migration 3D); lúc trigger bắn không kiểm EXECUTE nên app_user không cần grant.
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`CREATE FUNCTION public.tenancy_permission_scope_closed_ck() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row jsonb;
  v_org uuid;
  v_owner bigint;
  v_missing bigint;
BEGIN
  IF TG_NARGS <> 1 THEN
    RAISE EXCEPTION 'tenancy_permission_scope_closed_ck expects the owner column as its only argument';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the permission closure check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;
  v_org := (v_row ->> 'org_id')::uuid;
  v_owner := (v_row ->> TG_ARGV[0])::bigint;
  IF v_org IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'tenancy_permission_scope_closed_ck: row without org_id or %', TG_ARGV[0];
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(v_org));
  -- Tập đã bị xoá hết (role/key/grant bị xoá, CASCADE) → không còn dòng → đạt.
  EXECUTE format(
    'SELECT s.permission_id FROM %1$I.%2$I s JOIN public.permission_requires r ON r.permission_id = s.permission_id
     WHERE s.org_id = $1 AND s.%3$I = $2
       AND NOT EXISTS (SELECT 1 FROM %1$I.%2$I t WHERE t.org_id = $1 AND t.%3$I = $2 AND t.permission_id = r.required_permission_id)
     LIMIT 1', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0])
    INTO v_missing USING v_org, v_owner;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'a stored permission set must be closed under requires'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(`REVOKE ALL ON FUNCTION public.tenancy_permission_scope_closed_ck() FROM PUBLIC;`);
    this.addSql(`GRANT EXECUTE ON FUNCTION public.tenancy_permission_scope_closed_ck() TO app_owner;`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`CREATE CONSTRAINT TRIGGER org_role_permissions_closed_ck AFTER INSERT OR DELETE ON org_role_permissions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_permission_scope_closed_ck('role_id');`);
  }

  override down(): void | Promise<void> {
    // Không mất dữ liệu âm thầm: còn role tuỳ biến thì từ chối (member giữ nó sẽ mất mọi quyền; code 3A ném 500 cho role
    // tuỳ biến). `org_roles` là FORCE RLS: app_owner đọc theo mẫu NO FORCE … FORCE + khẳng định (spec §8.8).
    this.addSql(`ALTER TABLE public.org_roles NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_roles WHERE system_key IS NULL) THEN
    RAISE EXCEPTION 'custom roles exist: move their members to a system role and delete the custom roles before reverting plan 3B';
  END IF;
END $$;`);
    this.addSql(`ALTER TABLE public.org_roles FORCE ROW LEVEL SECURITY;`);
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
    this.addSql(`DROP TABLE org_role_permissions;`);
    this.addSql(`REVOKE SELECT (permission_id, required_permission_id) ON permission_requires FROM tenancy_definer;`);
    this.addSql(`DROP FUNCTION tenancy_org_role_permissions_guard();`);
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`DROP FUNCTION public.tenancy_permission_scope_closed_ck();`);
    this.addSql(`RESET ROLE;`);
  }
}
```
(`<ts>` là timestamp CLI đã sinh cho file này; không gõ tay.)

Thứ tự trong `down`: khối khẳng định FORCE đứng SAU `NO FORCE` cuối cùng của phương thức (luật quét `migration-scan.spec.ts` của 3A); `DROP TABLE` xoá policy, grant, trigger của bảng; hai hàm trigger xoá riêng (`DROP TABLE` không xoá hàm, spec §6.13).

- [ ] **Step 4: Thứ tự xoá cứng và hằng định dạng**

`src/modules/tenancy/infra/sql/org-purge.sql.ts` — thêm dòng trước `org_roles` (bảng nối thuộc role; `CASCADE` đã đủ về dữ liệu, nhưng thứ tự tường minh giữ đúng quy ước "con trước cha" của spec §9.5 và Bảng 5):
```ts
export const ORG_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM org_members WHERE org_id = app_current_org()',
  'DELETE FROM org_role_permissions WHERE org_id = app_current_org()',
  'DELETE FROM org_roles WHERE org_id = app_current_org()',
  'DELETE FROM organizations WHERE id = app_current_org()',
];
```
`src/modules/tenancy/constants.ts` — thêm:
```ts
/** Khớp `org_roles_name_ck` / `org_roles_description_ck` của migration `tenancy_core` (đếm code point như `char_length`). */
export const ROLE_NAME_MAX_LENGTH = 64;
export const ROLE_DESCRIPTION_MAX_LENGTH = 500;
/** Biên đầu vào của `permissions` trong body tạo/sửa role (lớn hơn hẳn catalogue gộp; chặn body khổng lồ). */
export const ROLE_PERMISSIONS_MAX = 256;
```

- [ ] **Step 5: Chạy lại, kiểm migration round-trip**

Run:
```bash
pnpm build
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/database/migrations.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/tenancy/custom-role-permissions-down.spec.ts test/integration/tenancy/seed-helper.spec.ts
```
Expected: PASS. `migration-scan.spec.ts` xanh (hàm `tenancy_permission_scope_closed_ck` thuộc `DEFINER_INTERNAL_FUNCTIONS` nằm giữa `SET LOCAL ROLE`/`RESET ROLE` ở cả `up` lẫn `down`; `NO FORCE` có khối khẳng định sau nó); `migration-order.spec.ts` xanh; `migrations.spec.ts` up → down → up và sweep S2-R57 gồm migration 3B; `rls-catalog.spec.ts` thấy policy definer mới, tập SECURITY DEFINER = hàm gọi được ∪ bốn hàm trigger, `org_role_permissions` là bảng tenant có `TO app_user`, không trùng tên constraint deferrable; `seed-helper.spec.ts` của 3A vẫn xanh với thứ tự xoá mới (nếu nó so nguyên văn danh sách `ORG_PURGE_STATEMENTS`, cập nhật danh sách mong đợi trong đúng test đó bằng dòng `org_role_permissions` của Step 4, không nới phép so).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/migrations/tenancy src/modules/tenancy/infra/sql/org-purge.sql.ts src/modules/tenancy/constants.ts test/support/tenancy-catalog.ts test/integration/core/database test/integration/tenancy/custom-role-permissions-down.spec.ts
pnpm typecheck && pnpm lint
git add src/migrations/tenancy src/modules/tenancy/infra/sql/org-purge.sql.ts src/modules/tenancy/constants.ts test/support/tenancy-catalog.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/tenancy
git commit -m "feat(tenancy): org_role_permissions with RLS, a guard trigger and the shared SECURITY DEFINER closure check; down refuses while custom roles exist"
```

---

### Task 3: Seed role tuỳ biến, cô lập và ràng buộc DB của `org_role_permissions`; kiểm chứng prod-like #1 (schema 3B chạy từ `dist`)

**Files:**
- Create (test): `test/integration/tenancy/role-permissions-db.spec.ts`
- Modify: `test/support/tenancy-seed.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: migration của Task 2; `seedOrg`, `seedMember`, `withAppClient`, `inOrgTx` (3A Task 14); `createTestApp`, `DatabaseModule`, `OrgScope`, `UnitOfWork`, `Db` (SP1); `ROLE_NAME_MAX_LENGTH` (Task 2); `psql`, `TENANCY_TENANT_TABLES_3B`, `DEFINER_TRIGGER_FUNCTIONS_3B` (Task 2); `mergeCatalogues`, `systemRolePermissions`, `TENANCY_CATALOGUE` (3A Task 17).
- Produces (test support dùng ở mọi task sau):
  - `type SeededRole = { id: string; publicId: string; name: string }`; `seedCustomRole(org: SeededOrg, o: { permissions: readonly string[]; name?: string }): Promise<SeededRole>` (một transaction trong OrgScope của org, cùng database với org; tập phải đóng, trigger kiểm lúc COMMIT).
  - `type SeededCustomMember = Omit<SeededMember, 'roleKey'> & { roleId: string }`; `seedMemberInRole(org: SeededOrg, role: SeededRole, subject?: SeedSubject): Promise<SeededCustomMember>`.
  - Tập quyền của ma trận spec §18.3: hằng `ROLE_SET_C0 = ['org.read']`, `ROLE_SET_C2 = ['org.read', 'roles.read', 'invitations.read']` (tập tường minh của spec); `roleSetC1(merged): string[]` = MEMBER ∪ {`members.role.assign`} và `adminKeys(merged): string[]` = `perms(ADMIN)`, tính từ catalogue gộp lúc chạy (R-X24), đã sắp; `TENANCY_ONLY_CATALOGUE: MergedCatalogue` (catalogue của riêng tenancy) cho test không có app trong process (DB, process con), nơi chỉ cần một tập đóng có thật trong DB.

- [ ] **Step 1: Helper seed**

`test/support/tenancy-seed.ts` — thêm ba import ở đầu file:
```ts
import { mergeCatalogues, type MergedCatalogue } from '../../src/modules/tenancy/domain/catalogue.js';
import { systemRolePermissions } from '../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../src/modules/tenancy/domain/tenancy-catalogue.js';
```
và thêm cuối file (dùng lại `upsertUser`, `insertMember`, `seedStateOf`, `subjectOf` đã có trong file):
```ts
export type SeededRole = { id: string; publicId: string; name: string };
export type SeededCustomMember = Omit<SeededMember, 'roleKey'> & { roleId: string };
/**
 * Tập quyền của ma trận leo quyền (spec SP3 §18.3): C0 ⊊ C1; C2 có quyền C1 không có. C0, C2 là tập tường minh của spec
 * (không định nghĩa theo role hệ thống) nên là hằng; C1 và ADMIN định nghĩa theo role hệ thống nên TÍNH từ catalogue gộp
 * lúc chạy (R-X24): plan khác thêm quyền cho MEMBER/ADMIN (4A: `entitlements.read`) thì C1 vẫn trội MEMBER, V vẫn ≡ ADMIN.
 */
export const ROLE_SET_C0 = ['org.read'] as const;
export const ROLE_SET_C2 = ['org.read', 'roles.read', 'invitations.read'] as const;
/** C1 = MEMBER ∪ {members.role.assign}, đã sắp. `merged` = `app.get(PermissionCatalogueRegistry).merged()` khi có app. */
export const roleSetC1 = (merged: MergedCatalogue): string[] =>
  [...new Set([...systemRolePermissions('MEMBER', merged), 'members.role.assign'])].sort();
/** `perms(ADMIN)` (tập của V, V′ ≡ ADMIN), đã sắp. */
export const adminKeys = (merged: MergedCatalogue): string[] => [...systemRolePermissions('ADMIN', merged)].sort();
/** Catalogue của riêng tenancy: cho test không có app trong process (DB, process con). Mọi key của nó có dòng trong DB. */
export const TENANCY_ONLY_CATALOGUE: MergedCatalogue = mergeCatalogues([TENANCY_CATALOGUE]);

/** Role tuỳ biến trong org đã seed: MỘT transaction trong OrgScope; key lạ → không chèn đủ dòng → ném. */
export async function seedCustomRole(org: SeededOrg, o: { permissions: readonly string[]; name?: string }): Promise<SeededRole> {
  const state = seedStateOf.get(org);
  if (!state) throw new Error('seedCustomRole: org was not created by seedOrg');
  const name = o.name ?? `Role ${randomUUID().slice(0, 8)}`;
  return withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(`INSERT INTO org_roles (org_id, name) VALUES ($1, $2) RETURNING id::text, public_id::text`, [org.orgId, name]);
        const role = rows[0];
        if (!role) throw new Error('seedCustomRole: role insert returned no row');
        const inserted = await c.query(
          `INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = ANY($3::text[])`,
          [org.orgId, role.id, [...new Set(o.permissions)]],
        );
        if (inserted.rowCount !== new Set(o.permissions).size) throw new Error(`seedCustomRole: unknown permission in ${o.permissions.join(',')}`);
        return { id: role.id, publicId: role.public_id, name };
      }),
    state.database,
  );
}

/** Thêm một member giữ role tuỳ biến đã seed (một transaction trong OrgScope, cùng database). */
export async function seedMemberInRole(org: SeededOrg, role: SeededRole, subject?: SeedSubject): Promise<SeededCustomMember> {
  const state = seedStateOf.get(org);
  if (!state) throw new Error('seedMemberInRole: org was not created by seedOrg');
  return withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const user = await upsertUser(c, subjectOf(subject));
        if (user.created) state.createdUsers.push(user.id);
        const m = await insertMember(c, org.orgId, user.id, role.id);
        return { memberId: m.id, memberPublicId: m.public_id, userId: user.id, userPublicId: user.publicId, roleId: role.id };
      }),
    state.database,
  );
}
```
`dispose()` của `seedOrg` không đổi: nó chạy `ORG_PURGE_STATEMENTS` (Task 2 đã thêm `org_role_permissions`).

- [ ] **Step 2: Test DB (fail trước Task 2, xanh sau; viết cả file rồi chạy)**

`test/integration/tenancy/role-permissions-db.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { ROLE_NAME_MAX_LENGTH } from '../../../src/modules/tenancy/constants.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import {
  TENANCY_ONLY_CATALOGUE,
  inOrgTx,
  roleSetC1,
  seedCustomRole,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';

/** Test DB không có app tenancy: một tập đóng có thật trong DB (members.role.assign cần members.read, roles.read). */
const C1 = roleSetC1(TENANCY_ONLY_CATALOGUE);
const LOCK_WAIT_POLL_MS = 20;
const LOCK_WAIT_MAX_POLLS = 250;
const permId = (key: string) => `(SELECT id FROM permissions WHERE key = '${key}')`;
const constraintOf = (err: unknown) => (typeof err === 'object' && err !== null && 'constraint' in err ? err.constraint : undefined);

describe('org_role_permissions: isolation, guard, closure and races (spec SP3 §6.5, §18.1, tiêu chí 1)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  let roleA: SeededRole;
  let roleB: SeededRole;
  const inA = <T>(fn: () => Promise<T>) => app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) => app.get(Db).execute<T>(q, p);
  const rowsOfB = () => withAppClient((c) => inOrgTx(c, b.orgId, async () => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM org_role_permissions')).rows[0]?.n));
  /** Một transaction của app_user trong OrgScope(org); trả lỗi của COMMIT (trigger hoãn) thay vì ném. */
  const commitErr = (org: string, body: (c: pg.Client) => Promise<unknown>) =>
    withAppClient(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      try {
        await body(c);
      } catch (err) {
        await c.query('ROLLBACK');
        return err;
      }
      return c.query('COMMIT').then(() => undefined, (e: unknown) => e);
    });

  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    a = await seedOrg();
    b = await seedOrg();
    roleA = await seedCustomRole(a, { permissions: C1 });
    roleB = await seedCustomRole(b, { permissions: C1 });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await app?.close();
  });

  describe('isolation (tiêu chí 1)', () => {
    it('SELECT and DELETE of org B rows from OrgScope(A) touch 0 rows; app_user has no UPDATE at all', async () => {
      const before = await rowsOfB();
      expect(before).toBe(C1.length);
      expect(await inA(() => sql('SELECT 1 FROM org_role_permissions WHERE org_id = ?', [b.orgId]))).toEqual([]);
      expect(await inA(() => sql('DELETE FROM org_role_permissions WHERE org_id = ? RETURNING 1', [b.orgId]))).toEqual([]);
      await expect(inA(() => sql('UPDATE org_role_permissions SET updated_at = now() WHERE org_id = ?', [b.orgId]))).rejects.toThrow(/permission denied/);
      expect(await rowsOfB()).toBe(before);
    });
    it('INSERT with org_id = B is refused by RLS (42501), not by the guard (spike S3B-2)', async () => {
      await expect(
        inA(() => sql(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES (?, ?, ${permId('org.read')})`, [b.orgId, roleB.id])),
      ).rejects.toThrow(/row-level security/);
    });
    it('without an org context it fails closed (P0001)', async () => {
      await expect(app.get(UnitOfWork).run(() => sql('SELECT 1 FROM org_role_permissions'))).rejects.toThrow(/org context is not set/);
    });
    it('a row in A pointing at a role of B violates the composite FK (23503)', async () => {
      await expect(
        inA(() => sql(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES (?, ?, ${permId('org.read')})`, [a.orgId, roleB.id])),
      ).rejects.toMatchObject({ code: '23503', constraint: 'org_role_permissions_role_fk' });
    });
  });

  describe('guard and closure (spec §6.5, §18.1)', () => {
    it.each([
      ['a system role', () => a.roles.ADMIN.id, 'org.read', 'org_role_permissions_custom_only'],
      ['an ownerOnly permission', () => roleA.id, 'org.delete', 'org_role_permissions_not_delegable'],
    ])('%s is refused by the BEFORE INSERT guard (23514)', async (_name, role, key, constraint) => {
      const err = await commitErr(a.orgId, (c) => c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId(key)})`, [a.orgId, role()]));
      expect({ code: (err as { code?: string }).code, constraint: constraintOf(err) }).toEqual({ code: '23514', constraint });
    });
    it('a deprecated permission is refused by the guard (deprecate inside the owner transaction, then roll back)', async () => {
      const { pg: p } = getInfra();
      const owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
      await owner.connect();
      try {
        // Mọi thay đổi nằm trong MỘT transaction của owner rồi ROLLBACK: bảng global `permissions` và cờ FORCE không bao
        // giờ lệch với file test sau. NO FORCE để owner (không policy) thấy dòng role cho guard.
        await owner.query('BEGIN');
        await owner.query(`UPDATE permissions SET deprecated_at = now() WHERE key = 'invitations.read'`);
        await owner.query('ALTER TABLE org_role_permissions NO FORCE ROW LEVEL SECURITY');
        await owner.query('ALTER TABLE org_roles NO FORCE ROW LEVEL SECURITY');
        await expect(
          owner.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('invitations.read')})`, [a.orgId, roleA.id]),
        ).rejects.toMatchObject({ code: '23514', constraint: 'org_role_permissions_deprecated' });
      } finally {
        await owner.query('ROLLBACK');
        await owner.end();
      }
    });
    it('a non-closed set is refused at COMMIT with org_role_permissions_closed_ck, even after switching app.org_id', async () => {
      for (const switchOrg of [false, true]) {
        const err = await commitErr(a.orgId, async (c) => {
          await c.query(`DELETE FROM org_role_permissions WHERE role_id = $1 AND permission_id = ${permId('members.read')}`, [roleA.id]);
          if (switchOrg) await c.query(`SELECT set_config('app.org_id', $1, true)`, [b.orgId]);
        });
        expect({ code: (err as { code?: string }).code, constraint: constraintOf(err) }).toEqual({ code: '23514', constraint: 'org_role_permissions_closed_ck' });
      }
    });
    it('a multi-statement replacement valid only at the end commits (the check is deferred)', async () => {
      const r = await seedCustomRole(a, { permissions: ['org.read'] });
      const err = await commitErr(a.orgId, async (c) => {
        await c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('roles.write')})`, [a.orgId, r.id]);
        await c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('roles.read')})`, [a.orgId, r.id]);
      });
      expect(err).toBeUndefined();
    });
    it('deleting a custom role cascades its rows; deleting a role with a member is 23001 org_members_role_fk', async () => {
      const lone = await seedCustomRole(a, { permissions: C1 });
      expect(await commitErr(a.orgId, (c) => c.query('DELETE FROM org_roles WHERE id = $1', [lone.id]))).toBeUndefined();
      expect(await withAppClient((c) => inOrgTx(c, a.orgId, async () => (await c.query('SELECT 1 FROM org_role_permissions WHERE role_id = $1', [lone.id])).rows))).toEqual([]);
      const held = await seedCustomRole(a, { permissions: C1 });
      await seedMemberInRole(a, held);
      const err = await commitErr(a.orgId, (c) => c.query('DELETE FROM org_roles WHERE id = $1', [held.id]));
      expect({ code: (err as { code?: string }).code, constraint: constraintOf(err) }).toEqual({ code: '23001', constraint: 'org_members_role_fk' });
    });
    it('the closure check refuses REPEATABLE READ (it relies on a fresh snapshot after its lock)', async () => {
      const err = await withAppClient(async (c) => {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [a.orgId]);
        await c.query(`INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('org.update')})`, [a.orgId, roleA.id]);
        return c.query('COMMIT').then(() => undefined, (e: unknown) => e);
      });
      expect(constraintOf(err)).toBe('org_role_permissions_closed_ck');
    });
    it(`the name CHECK counts code points like ROLE_NAME_MAX_LENGTH (${ROLE_NAME_MAX_LENGTH})`, async () => {
      const ok = await commitErr(a.orgId, (c) => c.query(`INSERT INTO org_roles (org_id, name) VALUES ($1, $2)`, [a.orgId, '😀'.repeat(ROLE_NAME_MAX_LENGTH)]));
      expect(ok).toBeUndefined();
      const tooLong = await commitErr(a.orgId, (c) => c.query(`INSERT INTO org_roles (org_id, name) VALUES ($1, $2)`, [a.orgId, '😀'.repeat(ROLE_NAME_MAX_LENGTH + 1)]));
      expect(constraintOf(tooLong)).toBe('org_roles_name_ck');
    });
  });

  describe('R3B-1: write skew between two connections with no lock in the callers (deterministic, 3A definer-triggers pattern)', () => {
    const SKEW_STEP = {
      add: `INSERT INTO org_role_permissions (org_id, role_id, permission_id) VALUES ($1, $2, ${permId('roles.write')})`,
      drop: `DELETE FROM org_role_permissions WHERE org_id = $1 AND role_id = $2 AND permission_id = ${permId('roles.read')}`,
    } as const;
    /** Chờ tới khi backend `pid` đứng chờ một khoá advisory; kết nối thứ ba (`pg_locks` là view toàn cluster, app_user đọc được). */
    const waitForAdvisoryWait = (pid: number) =>
      withAppClient(async (probe) => {
        for (let i = 0; i < LOCK_WAIT_MAX_POLLS; i++) {
          const { rows } = await probe.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`, [pid]);
          if (rows.length > 0) return;
          await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
        }
        throw new Error(`session ${pid} never waited on an advisory lock`);
      });
    const storedKeys = (roleId: string) =>
      withAppClient((c) =>
        inOrgTx(c, a.orgId, async () =>
          (await c.query<{ key: string }>(`SELECT p.key FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY p.key`, [roleId])).rows.map((r) => r.key),
        ),
      );
    it.each([
      ['add the dependant first, then drop its requirement', 'add', 'drop', ['org.read', 'roles.read', 'roles.write']],
      ['drop the requirement first, then add its dependant', 'drop', 'add', ['org.read']],
    ] as const)('%s → the later COMMIT waits on the advisory lock, then is refused; the stored set stays closed', async (_n, first, second, kept) => {
      const r = await seedCustomRole(a, { permissions: ['org.read', 'roles.read'] });
      await withAppClient((x) =>
        withAppClient(async (y) => {
          for (const c of [x, y]) {
            await c.query('BEGIN');
            await c.query(`SELECT set_config('app.org_id', $1, true)`, [a.orgId]);
          }
          await x.query(SKEW_STEP[first], [a.orgId, r.id]);
          // x kiểm closure NGAY (tập của x còn đóng) và giữ khoá advisory của org tới hết transaction.
          await x.query('SET CONSTRAINTS org_role_permissions_closed_ck IMMEDIATE');
          await y.query(SKEW_STEP[second], [a.orgId, r.id]);
          const pid = (await y.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
          const yCommit = y.query('COMMIT').then(() => undefined, (e: unknown) => e);
          await waitForAdvisoryWait(pid);
          await x.query('COMMIT');
          const err = await yCommit;
          expect({ code: (err as { code?: string } | undefined)?.code, constraint: constraintOf(err) }).toEqual({ code: '23514', constraint: 'org_role_permissions_closed_ck' });
        }),
      );
      expect(await storedKeys(r.id)).toEqual(kept);
    });
  });
});
```
Ghi chú: ca deprecated đổi `permissions` TRONG transaction của owner (kết nối thẳng Postgres) rồi `ROLLBACK`: bảng global dùng chung không bao giờ lệch catalogue cho file sau (CatalogueCheck của file sau so DB với code). R3B-1 dùng lịch cố định thay vì hai `COMMIT` đua bằng `Promise.all` (hai transaction đó thường chạy nối tiếp nên test xanh cả khi thiếu khoá): y chỉ gửi `COMMIT` sau khi x đã giữ khoá advisory, test chờ tới khi y thật sự đứng chờ khoá đó, rồi mới cho x commit.

Run: `pnpm vitest run --project integration test/integration/tenancy/role-permissions-db.spec.ts`
Expected: PASS (mọi ca; hai chiều của R3B-1 đều: bên sau bị từ chối `org_role_permissions_closed_ck`, tập cuối đóng). Kiểm đột biến một lần: tạm xoá dòng `PERFORM pg_advisory_xact_lock(…)` khỏi hàm closure của migration (DB test dựng lại từ đầu) → cả hai ca R3B-1 đỏ ở `session … never waited on an advisory lock`; trả lại, xanh. Ghi lần đỏ này vào mô tả commit của Step 4.

- [ ] **Step 3: Kiểm chứng prod-like #1 — schema 3B migrate từ `dist` trên image production**

`test/smoke/tenancy.smoke.spec.ts` — thêm import `TENANCY_TENANT_TABLES_3B`, `DEFINER_TRIGGER_FUNCTIONS_3B` từ `../support/tenancy-catalog.js`, và ca mới ngay sau ca "the tenancy schema of 3A migrated from dist …" (FORCE là thuộc tính của bảng tenant, nên tập kiểm là `TENANCY_TENANT_TABLES_3B`, không phải tập bảng definer đọc — hôm nay hai tập trùng nhau nhưng nghĩa khác):
```ts
  it('the 3B schema migrated from dist: org_role_permissions FORCE RLS, closure trigger owned by tenancy_definer and deferred', () => {
    const forced = [...TENANCY_TENANT_TABLES_3B].sort();
    expect(
      psql(`SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${forced.map((t) => `'${t}'`).join(', ')})`),
    ).toBe(forced.map((t) => `${t}:true:true`).join(','));
    const fns = [...DEFINER_TRIGGER_FUNCTIONS_3B].sort();
    expect(
      psql(`SELECT string_agg(proname || ':' || pg_get_userbyid(proowner) || ':' || prosecdef::text, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${fns.map((f) => `'${f}'`).join(', ')})`),
    ).toBe(fns.map((f) => `${f}:tenancy_definer:true`).join(','));
    expect(psql(`SELECT condeferrable::text || ',' || condeferred::text FROM pg_constraint WHERE conname = 'org_role_permissions_closed_ck'`)).toBe('true,true');
    expect(psql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'org_role_permissions_guard' AND NOT tgisinternal`)).toBe('1');
  });
```
Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`), migrate mọi migration (3A + 3B) từ `dist` trên image, mọi file smoke PASS, log api/worker JSON sạch, `/health/ready` 200, teardown `down -v` sạch.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/support/tenancy-seed.ts test/integration/tenancy/role-permissions-db.spec.ts test/smoke/tenancy.smoke.spec.ts
pnpm typecheck && pnpm lint
git add test/support/tenancy-seed.ts test/integration/tenancy/role-permissions-db.spec.ts test/smoke/tenancy.smoke.spec.ts
git commit -m "test(tenancy): custom role seed helpers; isolation, guard, deferred closure and write-skew cases of org_role_permissions; 3B schema on the production image"
```

---
## Phần C — Miền: luật role tuỳ biến (spec §8.1–8.4, luật 1, 2a(i)–(iii), 6)

### Task 4: `domain/role.ts` (tên, mô tả, kiểm tập quyền) và luật 1, 2a(i)–(iii), 6 trong `escalation.ts`; `EscalationGuard` + lỗi `cannot_edit_own_role` — R-1…R-17, R-19 (U), U15 cho đường role, B-2/3/7/19/21/22/23/24 (U)

**Files:**
- Create: `src/modules/tenancy/domain/role.ts`, `test/unit/modules/tenancy/role.spec.ts`, `test/unit/modules/tenancy/escalation-roles.spec.ts`
- Modify: `src/modules/tenancy/domain/escalation.ts`, `src/modules/tenancy/domain/catalogue.ts`, `src/modules/tenancy/application/escalation-guard.ts`, `src/modules/tenancy/errors.ts`, `test/unit/modules/tenancy/escalation-guard.spec.ts`, `test/unit/modules/tenancy/errors.spec.ts`

**Interfaces:**
- Consumes: `closure`, `isStrictSubset`, `isSubset` (3A Task 17), `dominates`, `isAdminEquivalent`, `assertCanBind`, `assertCanManage`, `type Actor`, `type EscalationDecision`, `type EscalationRule` (3A Task 18), `systemRolePermissions`, `adminCapability`, `mergeCatalogues`, `defineCatalogue`, `TENANCY_CATALOGUE`, `PERMISSION_RESOURCE_PATTERN`, `PERMISSION_ACTION_PATTERN` (3A Task 17), `ROLE_NAME_MAX_LENGTH`, `ROLE_DESCRIPTION_MAX_LENGTH` (Task 2), `prng`, `randomSubset` (3A `test/unit/modules/tenancy/prng.ts`).
- Produces:
  - `domain/catalogue.ts`: `PERMISSION_KEY_PATTERN` (`resource.action` với cùng hai regex của `CHECK`).
  - `domain/role.ts`: `roleName`, `roleDescription` (zod, đếm code point); `type CustomRoleSetCheck = { ok: true; permissions: ReadonlySet<string> } | { ok: false; reason: 'UNKNOWN_PERMISSION' | 'PERMISSION_NOT_DELEGABLE' | 'MISSING_DEPENDENCIES'; keys: readonly string[] }`; `checkCustomRoleSet(keys: Iterable<string>, merged): CustomRoleSetCheck` (thứ tự: key lạ/deprecated → `ownerOnly` → thiếu `requires`; `keys` đã sắp); `sameSet(a, b): boolean`.
  - `domain/escalation.ts`: `EscalationRule` thêm `'1' | '6'`; lý do thêm `'CANNOT_EDIT_OWN_ROLE'`; `assertCanCreateRole(actor, newSet, merged)`, `assertCanEditRole(actor, edit: { heldByActor: boolean; oldSet: ReadonlySet<string>; newSet: ReadonlySet<string> }, merged)`, `assertCanDeleteRole(actor, oldSet, merged)` — đều trả `EscalationDecision`.
  - `TenancyErrors.CANNOT_EDIT_OWN_ROLE` (`403 cannot_edit_own_role`); `EscalationGuard.enforce` đổi `CANNOT_EDIT_OWN_ROLE` thành lỗi đó (metric `tenancy_escalation_denied_total{rule="6"}`).

- [ ] **Step 1: Test tên, mô tả, kiểm tập (fail)**

`test/unit/modules/tenancy/role.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ROLE_DESCRIPTION_MAX_LENGTH, ROLE_NAME_MAX_LENGTH } from '../../../../src/modules/tenancy/constants.js';
import { PERMISSION_KEY_PATTERN, defineCatalogue, mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { checkCustomRoleSet, roleDescription, roleName, sameSet } from '../../../../src/modules/tenancy/domain/role.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const entry = { resource: 'legacy', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: false, member: false }, deprecated: true };
const merged = mergeCatalogues([TENANCY_CATALOGUE, defineCatalogue('legacy', { 'legacy.read': entry })]);

describe('roleName / roleDescription (Review Focus 1: code points like char_length)', () => {
  it.each([
    ['Billing', true],
    ['😀'.repeat(ROLE_NAME_MAX_LENGTH), true],
    ['😀'.repeat(ROLE_NAME_MAX_LENGTH + 1), false],
    ['', false],
    [' Billing', false],
    ['Billing ', false],
    ['\u00a0Billing', false],
    ['Billing\t', false],
  ])('%j → %s', (name, ok) => {
    expect(roleName.safeParse(name).success).toBe(ok);
  });
  it('a description may be empty and is capped in code points', () => {
    expect(roleDescription.safeParse('').success).toBe(true);
    expect(roleDescription.safeParse('é'.repeat(ROLE_DESCRIPTION_MAX_LENGTH)).success).toBe(true);
    expect(roleDescription.safeParse('é'.repeat(ROLE_DESCRIPTION_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('PERMISSION_KEY_PATTERN', () => {
  it('matches every key of the v1 catalogue and refuses wildcards and malformed keys (R-7)', () => {
    for (const k of TENANCY_CATALOGUE.keys) expect(PERMISSION_KEY_PATTERN.test(k), k).toBe(true);
    for (const bad of ['*', 'org', 'Org.read', 'org.', '.read', 'org.read.x.y', 'org read']) expect(PERMISSION_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('checkCustomRoleSet (spec SP3 §8.4 luật 1: tập mới đóng, key tồn tại, không deprecated, không ownerOnly)', () => {
  it('a closed set of delegable keys passes (duplicates collapse)', () => {
    const r = checkCustomRoleSet(['org.read', 'members.read', 'org.read'], merged);
    expect(r.ok && [...r.permissions].sort()).toEqual(['members.read', 'org.read']);
  });
  it('the empty set passes (Review Focus 4)', () => {
    expect(checkCustomRoleSet([], merged)).toMatchObject({ ok: true });
  });
  it.each([
    ['R-6 unknown', ['ghost.read'], 'UNKNOWN_PERMISSION', ['ghost.read']],
    ['R-6 deprecated', ['legacy.read'], 'UNKNOWN_PERMISSION', ['legacy.read']],
    ['R-7 manage/all', ['org.manage', 'all.read'], 'UNKNOWN_PERMISSION', ['all.read', 'org.manage']],
    ['R-2 ownerOnly', ['org.read', 'org.delete'], 'PERMISSION_NOT_DELEGABLE', ['org.delete']],
    ['R-5 missing requires (transitive)', ['invitations.write'], 'MISSING_DEPENDENCIES', ['invitations.read', 'roles.read']],
  ] as const)('%s → %s %j', (_name, keys, reason, listed) => {
    expect(checkCustomRoleSet(keys, merged)).toEqual({ ok: false, reason, keys: listed });
  });
  it('unknown wins over ownerOnly, ownerOnly wins over missing dependencies', () => {
    expect(checkCustomRoleSet(['ghost.read', 'org.delete'], merged)).toMatchObject({ reason: 'UNKNOWN_PERMISSION' });
    expect(checkCustomRoleSet(['org.delete', 'members.role.assign'], merged)).toMatchObject({ reason: 'PERMISSION_NOT_DELEGABLE' });
  });
  it('sameSet ignores order', () => {
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/role.spec.ts`
Expected: FAIL (module `domain/role.js` chưa có).

- [ ] **Step 2: Cài `domain/role.ts` và `PERMISSION_KEY_PATTERN`**

`src/modules/tenancy/domain/catalogue.ts` — thêm ngay sau `PERMISSION_ACTION_PATTERN`:
```ts
/** Key `resource.action` (hai regex trên nối bằng `.`): đầu vào HTTP; key hợp lệ về dạng nhưng không có trong catalogue vẫn bị từ chối sau. */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z_]{0,31}\.[a-z][a-z_]{0,31}(\.[a-z][a-z_]{0,31})?$/;
```
`src/modules/tenancy/domain/role.ts`:
```ts
import { z } from 'zod';
import { ROLE_DESCRIPTION_MAX_LENGTH, ROLE_NAME_MAX_LENGTH } from '../constants.js';
import type { MergedCatalogue } from './catalogue.js';
import { closure } from './permission-set.js';

const codePoints = (s: string): number => [...s].length;

/**
 * Tên role tuỳ biến: không khoảng trắng đầu/cuối (chặt hơn `btrim` của CHECK: cả NBSP, tab), 1–`ROLE_NAME_MAX_LENGTH`
 * CODE POINT, cùng cách đếm với `char_length` của `org_roles_name_ck` (Review Focus 1).
 */
export const roleName = z
  .string()
  .refine((s) => s === s.trim(), 'must not start or end with whitespace')
  .refine((s) => codePoints(s) >= 1 && codePoints(s) <= ROLE_NAME_MAX_LENGTH, `must be 1 to ${ROLE_NAME_MAX_LENGTH} characters`);
export const roleDescription = z
  .string()
  .refine((s) => codePoints(s) <= ROLE_DESCRIPTION_MAX_LENGTH, `must be at most ${ROLE_DESCRIPTION_MAX_LENGTH} characters`);

export type CustomRoleSetCheck =
  | { ok: true; permissions: ReadonlySet<string> }
  | { ok: false; reason: 'UNKNOWN_PERMISSION' | 'PERMISSION_NOT_DELEGABLE' | 'MISSING_DEPENDENCIES'; keys: readonly string[] };

/**
 * Luật 1 phần "tập mới hợp lệ" (spec SP3 §8.4, PR5, PR6): mọi key có trong catalogue gộp và không deprecated (`manage`/`all`
 * không bao giờ có trong catalogue nên rơi vào đây), không `ownerOnly`, và tập ĐÃ đóng theo `requires` (không tự thêm
 * quyền thiếu). Thứ tự lỗi cố định để client sửa từng lớp. Trigger `org_role_permissions_guard`/`_closed_ck` là lớp cuối.
 */
export function checkCustomRoleSet(keys: Iterable<string>, merged: MergedCatalogue): CustomRoleSetCheck {
  const set = new Set(keys);
  const unknown = [...set].filter((k) => merged.get(k)?.deprecated !== false).sort();
  if (unknown.length) return { ok: false, reason: 'UNKNOWN_PERMISSION', keys: unknown };
  const ownerOnly = [...set].filter((k) => merged.get(k)?.ownerOnly === true).sort();
  if (ownerOnly.length) return { ok: false, reason: 'PERMISSION_NOT_DELEGABLE', keys: ownerOnly };
  const missing = [...closure(set, merged)].filter((k) => !set.has(k)).sort();
  if (missing.length) return { ok: false, reason: 'MISSING_DEPENDENCIES', keys: missing };
  return { ok: true, permissions: set };
}

export const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((k) => b.has(k));
```
(`merged.get(k)?.deprecated !== false` đúng cho cả key không có — `undefined` — lẫn key deprecated.)

Run: `pnpm vitest run --project unit test/unit/modules/tenancy/role.spec.ts`
Expected: PASS.

- [ ] **Step 3: Test luật role (fail)**

`test/unit/modules/tenancy/escalation-roles.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { defineCatalogue, mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  assertCanBind,
  assertCanCreateRole,
  assertCanDeleteRole,
  assertCanEditRole,
  assertCanManage,
  isAdminEquivalent,
  type Actor,
} from '../../../../src/modules/tenancy/domain/escalation.js';
import { adminCapability, systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { prng, randomSubset } from './prng.js';

/** `payroll.read`: quyền fixture `grantTo.admin = false`, không ownerOnly (spec §18.3 "X"). */
const merged = mergeCatalogues([
  TENANCY_CATALOGUE,
  defineCatalogue('payroll', { 'payroll.read': { resource: 'payroll', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: false, member: false } } }),
]);
const S = (...k: string[]): ReadonlySet<string> => new Set(k);
const sys = (k: 'OWNER' | 'ADMIN' | 'MEMBER') => systemRolePermissions(k, merged);
const actor = (permissions: ReadonlySet<string>, isOwner = false, memberRef = 'actor'): Actor => ({ memberRef, isOwner, permissions });
const O = actor(sys('OWNER'), true);
const A = actor(sys('ADMIN'));
const C0 = S('org.read');
/** C1 = MEMBER ∪ {members.role.assign}, tính từ catalogue của test (R-X24), không viết cứng. */
const C1 = S(...sys('MEMBER'), 'members.role.assign');
const C2 = S('org.read', 'roles.read', 'invitations.read');
/** C1 + roles.write: người sửa role nhỏ nhất của ma trận. */
const Cw = actor(new Set([...C1, 'roles.write', 'roles.read']));
const X = actor(new Set([...sys('ADMIN'), 'payroll.read']));
const V = sys('ADMIN');
const SEEDS = 200;
const OWNER_ONLY = (rule: '2a' | '5') => ({ ok: false, rule, reason: 'OWNER_ONLY' });
const DENIED = (rule: '1' | '2' | '4') => ({ ok: false, rule, reason: 'ESCALATION_DENIED' });

describe('custom role rules (spec SP3 §8.4 luật 1, 2a(i)–(iii), 6; §18.3 R-*)', () => {
  it('R-1: an ADMIN creates a role strictly below itself', () => {
    expect(assertCanCreateRole(A, C1, merged)).toEqual({ ok: true });
  });
  it('R-15: creating a role equal to your own set is refused (⊊, S3-A4); for an ADMIN that set is admin-equivalent → owner_only', () => {
    expect(assertCanCreateRole(Cw, Cw.permissions, merged)).toEqual(DENIED('1'));
    expect(assertCanCreateRole(A, sys('ADMIN'), merged)).toEqual(OWNER_ONLY('2a'));
  });
  it('R-4: C1 + roles.write creating a role with a key it lacks → escalation_denied', () => {
    expect(assertCanCreateRole(Cw, C2, merged)).toEqual(DENIED('1'));
  });
  it('R-8: an ADMIN adding a key it lacks to a role → escalation_denied', () => {
    expect(assertCanEditRole(A, { heldByActor: false, oldSet: C0, newSet: S('org.read', 'payroll.read') }, merged)).toEqual(DENIED('1'));
  });
  it('R-9: editing the role you hold → cannot_edit_own_role (rule 6), even when the edit narrows it', () => {
    expect(assertCanEditRole(Cw, { heldByActor: true, oldSet: Cw.permissions, newSet: C0 }, merged)).toEqual({ ok: false, rule: '6', reason: 'CANNOT_EDIT_OWN_ROLE' });
  });
  it('R-12: C1 + roles.write deleting an unused role larger than itself → escalation_denied', () => {
    expect(assertCanDeleteRole(Cw, new Set([...Cw.permissions, 'invitations.read']), merged)).toEqual(DENIED('1'));
    expect(assertCanDeleteRole(Cw, C0, merged)).toEqual({ ok: true });
  });
  it('R-16: an ADMIN narrowing V ≡ ADMIN (held by Bob) → owner_only (the old set counts, SEC-C1)', () => {
    expect(assertCanEditRole(A, { heldByActor: false, oldSet: V, newSet: C0 }, merged)).toEqual(OWNER_ONLY('2a'));
  });
  it('R-17: C1 + roles.write narrowing a role larger than itself → escalation_denied (old set not dominated)', () => {
    expect(assertCanEditRole(Cw, { heldByActor: false, oldSet: new Set([...Cw.permissions, 'invitations.read']), newSet: C0 }, merged)).toEqual(DENIED('1'));
  });
  it('R-19: the holder of X = ADMIN ∪ {payroll.read} cannot create, edit or delete an admin-equivalent role; an OWNER can', () => {
    expect(assertCanCreateRole(X, V, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanCreateRole(X, new Set([...V, 'payroll.read']), merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanEditRole(X, { heldByActor: false, oldSet: V, newSet: C0 }, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanEditRole(X, { heldByActor: false, oldSet: C0, newSet: V }, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanDeleteRole(X, V, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanCreateRole(O, V, merged)).toEqual({ ok: true });
    expect(assertCanEditRole(O, { heldByActor: false, oldSet: V, newSet: C0 }, merged)).toEqual({ ok: true });
    expect(assertCanDeleteRole(O, V, merged)).toEqual({ ok: true });
  });
  it(`U15 for role paths (generator, ${SEEDS} seeds): any old/new set ⊇ A is owner-only; an owner is never refused`, () => {
    const keys = [...merged.keys()].filter((k) => merged.get(k)?.ownerOnly === false);
    const adminSet = adminCapability(merged);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = prng(seed);
      const pick = () => new Set(rnd() < 0.5 ? [...adminSet, ...randomSubset(keys, rnd)] : randomSubset(keys, rnd));
      const oldSet = pick();
      const newSet = pick();
      const nonOwner = actor(new Set(randomSubset(keys, rnd)));
      const adminEq = isAdminEquivalent(oldSet, merged) || isAdminEquivalent(newSet, merged);
      const edit = assertCanEditRole(nonOwner, { heldByActor: false, oldSet, newSet }, merged);
      if (adminEq) expect(edit, `seed ${seed}`).toEqual(OWNER_ONLY('2a'));
      if (isAdminEquivalent(newSet, merged)) expect(assertCanCreateRole(nonOwner, newSet, merged), `seed ${seed}`).toEqual(OWNER_ONLY('2a'));
      if (isAdminEquivalent(oldSet, merged)) expect(assertCanDeleteRole(nonOwner, oldSet, merged), `seed ${seed}`).toEqual(OWNER_ONLY('2a'));
      expect(assertCanEditRole(O, { heldByActor: false, oldSet, newSet }, merged), `seed ${seed}`).toEqual({ ok: true });
      expect(assertCanCreateRole(O, newSet, merged), `seed ${seed}`).toEqual({ ok: true });
      expect(assertCanDeleteRole(O, oldSet, merged), `seed ${seed}`).toEqual({ ok: true });
    }
  });
});

describe('binding and managing custom roles (spec SP3 §18.3 B-*)', () => {
  const C1holder = actor(C1);
  it('B-1: ADMIN assigns C1; B-21: C1 assigns C0', () => {
    expect(assertCanBind(A, { systemKey: null, permissions: C1 }, merged)).toEqual({ ok: true });
    expect(assertCanBind(C1holder, { systemKey: null, permissions: C0 }, merged)).toEqual({ ok: true });
  });
  it('B-2: C1 assigns C2 (not strictly below C1) → escalation_denied; B-3: C1 assigns ADMIN → owner_only', () => {
    expect(assertCanBind(C1holder, { systemKey: null, permissions: C2 }, merged)).toEqual(DENIED('2'));
    expect(assertCanBind(C1holder, { systemKey: 'ADMIN', permissions: sys('ADMIN') }, merged)).toEqual(OWNER_ONLY('2a'));
  });
  it('B-7: C1 manages an ADMIN → owner_only; B-19: an ADMIN assigns a custom role equal to ADMIN → owner_only', () => {
    expect(assertCanManage(C1holder, { memberRef: 'a', isOwner: false, permissions: sys('ADMIN') }, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanBind(A, { systemKey: null, permissions: V }, merged)).toEqual(OWNER_ONLY('2a'));
  });
  it('B-22/B-23/B-24 (direct paths): X assigns ADMIN or V′ ≡ ADMIN, or manages an ADMIN or Bob holding V → owner_only', () => {
    expect(assertCanBind(X, { systemKey: 'ADMIN', permissions: sys('ADMIN') }, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanBind(X, { systemKey: null, permissions: V }, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanManage(X, { memberRef: 'a', isOwner: false, permissions: sys('ADMIN') }, merged)).toEqual(OWNER_ONLY('2a'));
    expect(assertCanManage(X, { memberRef: 'bob', isOwner: false, permissions: V }, merged)).toEqual(OWNER_ONLY('2a'));
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/escalation-roles.spec.ts`
Expected: FAIL (`assertCanCreateRole` chưa có).

- [ ] **Step 4: Cài luật role, lỗi, `EscalationGuard`**

`src/modules/tenancy/domain/escalation.ts` — đổi hai kiểu và thêm ba hàm (giữ nguyên `dominates`, `isAdminEquivalent`, `assertCanBind`, `assertCanManage`, `assertNotSelf` của 3A):
```ts
export type EscalationRule = '1' | '2' | '2a' | '3' | '4' | '5' | '6';
export type EscalationDecision =
  | { ok: true }
  | { ok: false; rule: EscalationRule; reason: 'ESCALATION_DENIED' | 'OWNER_ONLY' | 'CANNOT_CHANGE_OWN_ROLE' | 'CANNOT_EDIT_OWN_ROLE' };

/** Luật 1 (tạo) + 2a(i) (spec SP3 §8.4): 2a trước, vì tập ⊇ A là việc của owner dù actor có trội hẳn hay không. */
export function assertCanCreateRole(actor: Actor, newSet: ReadonlySet<string>, merged: MergedCatalogue): EscalationDecision {
  if (actor.isOwner) return ALLOWED;
  if (isAdminEquivalent(newSet, merged)) return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, newSet, merged)) return { ok: false, rule: '1', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/**
 * Luật 6 + 2a(ii) + 1 (sửa, SEC-C1): sửa role đang có người giữ là đổi quyền của mọi người giữ nó (luật 4), nên actor phải
 * trội hẳn CẢ tập cũ lẫn tập mới. Người giữ role không sửa được nó (PR15), kể cả để thu hẹp.
 */
export function assertCanEditRole(
  actor: Actor,
  edit: { heldByActor: boolean; oldSet: ReadonlySet<string>; newSet: ReadonlySet<string> },
  merged: MergedCatalogue,
): EscalationDecision {
  if (edit.heldByActor) return { ok: false, rule: '6', reason: 'CANNOT_EDIT_OWN_ROLE' };
  if (actor.isOwner) return ALLOWED;
  if (isAdminEquivalent(edit.oldSet, merged) || isAdminEquivalent(edit.newSet, merged)) return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, edit.oldSet, merged) || !dominates(actor, edit.newSet, merged)) return { ok: false, rule: '1', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/** Luật 1 (xoá, PR17) + 2a(iii): so với tập hiện tại của role. Role còn người giữ thì FK `RESTRICT` từ chối (409 role_in_use). */
export function assertCanDeleteRole(actor: Actor, oldSet: ReadonlySet<string>, merged: MergedCatalogue): EscalationDecision {
  if (actor.isOwner) return ALLOWED;
  if (isAdminEquivalent(oldSet, merged)) return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, oldSet, merged)) return { ok: false, rule: '1', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}
```
`src/modules/tenancy/errors.ts` — thêm vào object của `defineErrorCodes` (ngay sau `CANNOT_CHANGE_OWN_ROLE`):
```ts
  CANNOT_EDIT_OWN_ROLE: { status: HttpStatus.FORBIDDEN, title: 'You cannot edit a role you hold' },
```
`src/modules/tenancy/application/escalation-guard.ts` — thêm nhánh vào `switch (d.reason)` (trước `default`):
```ts
      case 'CANNOT_EDIT_OWN_ROLE':
        throw new AppError(TenancyErrors.CANNOT_EDIT_OWN_ROLE);
```
`test/unit/modules/tenancy/escalation-guard.spec.ts` — thêm hai dòng vào bảng `it.each`:
```ts
    [{ ok: false, rule: '1', reason: 'ESCALATION_DENIED' } as const, TenancyErrors.ESCALATION_DENIED],
    [{ ok: false, rule: '6', reason: 'CANNOT_EDIT_OWN_ROLE' } as const, TenancyErrors.CANNOT_EDIT_OWN_ROLE],
```
`test/unit/modules/tenancy/errors.spec.ts` — thêm:
```ts
  it('cannot_edit_own_role is a 403 owned by tenancy (spec §15)', () => {
    expect([TenancyErrors.CANNOT_EDIT_OWN_ROLE.code, TenancyErrors.CANNOT_EDIT_OWN_ROLE.status]).toEqual(['cannot_edit_own_role', 403]);
  });
```

- [ ] **Step 5: Chạy, commit**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm typecheck && pnpm lint
```
Expected: PASS (R-* ở tầng U, U15 cho role 200 seed, B-* trực tiếp; `switch` vét cạn của `EscalationGuard` biên dịch được với lý do mới).
```bash
git add src/modules/tenancy/domain src/modules/tenancy/application/escalation-guard.ts src/modules/tenancy/errors.ts test/unit/modules/tenancy
git commit -m "feat(tenancy): custom role set checks and rules 1, 2a(i)-(iii), 6 as pure domain functions; cannot_edit_own_role"
```

---

## Phần D — Đường nóng và API role tuỳ biến (spec §7.3, §8.6, §12, §14, §15)

### Task 5: Quyền của role tuỳ biến trên đường nóng và trong transaction — `RolePermissions`, câu thứ hai của §7.3, `ActorReauthorizer`, `MemberService`, `GET …/roles`; EXPLAIN

**Files:**
- Create: `src/modules/tenancy/application/authz/role-permissions.ts`, `test/unit/modules/tenancy/role-permissions.spec.ts`, `test/e2e/tenancy/custom-role-access.e2e.spec.ts`
- Modify: `src/modules/tenancy/application/authz/effective-permissions.ts`, `src/modules/tenancy/ports/role-repository.ts`, `src/modules/tenancy/infra/sql/sql-role.repository.ts`, `src/modules/tenancy/http/org-context.middleware.ts`, `src/modules/tenancy/application/actor-reauthorizer.ts`, `src/modules/tenancy/application/member.service.ts`, `src/modules/tenancy/http/roles.controller.ts`, `src/modules/tenancy/tenancy.module.ts`, `test/unit/modules/tenancy/effective-permissions.spec.ts`, `test/integration/tenancy/hot-path-explain.spec.ts`

**Interfaces:**
- Consumes: `RoleRepository`, `SqlRoleRepository`, `MemberRow`, `RoleRow` (3A Task 20), `PermissionCatalogueRegistry.merged()` (3A Task 19), `TenancyMetrics.catalogueOrphanKeys` (counter `tenancy_catalogue_orphan_keys`, 3A Task 20b), `systemRolePermissions` (3A Task 17), `OrgContextMiddleware`, `AccessReader`, `MembershipLookup` (3A Task 22), `ActorReauthorizer` (3A Task 23), `MemberService` (3A Task 24), `seedCustomRole`, `seedMemberInRole`, `ROLE_SET_C0`, `roleSetC1` (Task 3), `startTenancyApp`, `authed` (3A Task 22).
- Produces:
  - `effectivePermissions(role: { systemKey: SystemRoleKey | null }, merged): string[]` — chữ ký 3A giữ nguyên; role hệ thống như 3A; role tuỳ biến → ném (`'… use RolePermissions'`): tập của nó chỉ đến từ `RolePermissions`.
  - `type CustomRolePermissions = { granted: string[]; orphans: string[] }`; `customRolePermissions(stored: readonly string[], merged): CustomRolePermissions` (hàm thuần, R-X23): key có trong catalogue gộp và không deprecated → `granted`; key deprecated trong code → bỏ (U10); key không catalogue nào đã nạp khai báo → `orphans` (không cấp gì, không ném). Cả hai mảng đã sắp, không trùng.
  - `RoleRepository.permissionKeys(roleIds: readonly string[]): Promise<Map<string, string[]>>` (mọi id đầu vào có mặt trong Map, rỗng khi không có dòng; key đã lọc `deprecated_at IS NULL`); `ROLE_PERMISSIONS_SQL` (export cho test EXPLAIN).
  - `type RoleRef = { id: string; systemKey: SystemRoleKey | null }`; `RolePermissions.of(role: RoleRef): Promise<string[]>` (tập đã cấp), `.ofMany(roles: readonly RoleRef[]): Promise<Map<string, string[]>>` (một câu SQL cho mọi role tuỳ biến; role hệ thống không query), `.detailOf(role: RoleRef): Promise<CustomRolePermissions>` (tập đã cấp + key orphan còn lưu; `RoleService.update` dùng để gỡ orphan). Mỗi key orphan gặp lần đầu trong process: WARN `{ event: 'orphan_permission_ignored', key }` + `catalogueOrphanKeys.add(1)`; lần sau im lặng. Provider của `TenancyCoreModule` (api + worker), export.
  - `OrgContextMiddleware`: câu thứ hai chạy trong CÙNG `OrgScope` + `UnitOfWork` với câu tra membership, nên lỗi DB ở câu thứ hai cũng thành `503` (tiêu chí 12).

- [ ] **Step 1: Unit `effectivePermissions` và `RolePermissions` (fail)**

`test/unit/modules/tenancy/effective-permissions.spec.ts` — thay ca "a custom role row on the 3A hot path fails loud" bằng:
```ts
  it('a custom role never goes through effectivePermissions: its stored keys come only from RolePermissions', () => {
    expect(() => effectivePermissions({ systemKey: null }, merged)).toThrow(/RolePermissions/);
  });
  it('customRolePermissions: sorted, de-duplicated, deprecated-in-code dropped, orphan keys ignored and listed (R-X23)', () => {
    const withLegacy = mergeCatalogues([
      TenancyPermissions,
      defineCatalogue('legacy', { 'legacy.read': { resource: 'legacy', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: false, member: false }, deprecated: true } }),
    ]);
    expect(customRolePermissions(['roles.read', 'org.read', 'legacy.read', 'org.read', 'payroll.read', 'ghost.read', 'payroll.read'], withLegacy)).toEqual({
      granted: ['org.read', 'roles.read'],
      orphans: ['ghost.read', 'payroll.read'],
    });
  });
  it('a set made only of orphan keys grants nothing and never throws (a disabled module, R-X21/R-X23)', () => {
    expect(customRolePermissions(['payroll.read'], merged)).toEqual({ granted: [], orphans: ['payroll.read'] });
  });
```
(Thêm import `defineCatalogue` từ `domain/catalogue.js` và `customRolePermissions` từ `application/authz/effective-permissions.js`.)

`test/unit/modules/tenancy/role-permissions.spec.ts`:
```ts
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RolePermissions } from '../../../../src/modules/tenancy/application/authz/role-permissions.js';
import type { PermissionCatalogueRegistry } from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import type { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import { mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import type { RoleRepository } from '../../../../src/modules/tenancy/ports/role-repository.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);
const registry = { merged: () => merged } as Pick<PermissionCatalogueRegistry, 'merged'> as PermissionCatalogueRegistry;
/** Repository giả: ghi lại mỗi lần gọi để khẳng định số câu SQL. */
const fakeRoles = (stored: Record<string, string[]>) => {
  const calls: string[][] = [];
  const repo = {
    permissionKeys: (ids: readonly string[]) => {
      calls.push([...ids]);
      return Promise.resolve(new Map(ids.map((id) => [id, stored[id] ?? []])));
    },
  } as Pick<RoleRepository, 'permissionKeys'> as RoleRepository;
  return { repo, calls };
};
/** Metric giả: ghi lại mỗi lần cộng `tenancy_catalogue_orphan_keys`. */
const fakeMetrics = () => {
  const adds: number[] = [];
  const add = (v: number): void => {
    adds.push(v);
  };
  const metrics = { catalogueOrphanKeys: { add } } as Pick<TenancyMetrics, 'catalogueOrphanKeys'> as TenancyMetrics;
  return { metrics, adds };
};
const build = (stored: Record<string, string[]>) => {
  const roles = fakeRoles(stored);
  const m = fakeMetrics();
  return { ...roles, ...m, rp: new RolePermissions(roles.repo, registry, m.metrics) };
};

describe('RolePermissions (spec SP3 §7.3: one extra query, only for custom roles)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('system roles never query; custom roles are read in one batched call', async () => {
    const { rp, calls } = build({ '7': ['org.read'], '8': ['org.read', 'members.read'] });
    const out = await rp.ofMany([
      { id: '1', systemKey: 'ADMIN' },
      { id: '7', systemKey: null },
      { id: '8', systemKey: null },
    ]);
    expect(calls).toEqual([['7', '8']]);
    expect(out.get('1')).toEqual([...systemRolePermissions('ADMIN', merged)].sort());
    expect(out.get('8')).toEqual(['members.read', 'org.read']);
  });
  it('only system roles → no query at all; a custom role without rows is the empty set', async () => {
    const { rp, calls } = build({});
    await rp.of({ id: '1', systemKey: 'MEMBER' });
    expect(calls).toEqual([]);
    expect(await rp.of({ id: '9', systemKey: null })).toEqual([]);
  });
  it('R-X23: orphan keys grant nothing and never throw; each is logged WARN and counted once per process', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { rp, adds } = build({ '7': ['org.read', 'payroll.read'], '8': ['ghost.read', 'payroll.read'] });
    expect(await rp.of({ id: '7', systemKey: null })).toEqual(['org.read']);
    expect(await rp.detailOf({ id: '8', systemKey: null })).toEqual({ granted: [], orphans: ['ghost.read', 'payroll.read'] });
    expect(await rp.ofMany([{ id: '7', systemKey: null }, { id: '8', systemKey: null }])).toEqual(new Map([['7', ['org.read']], ['8', []]]));
    expect(warn.mock.calls.map(([payload]) => payload)).toEqual([
      { event: 'orphan_permission_ignored', key: 'payroll.read' },
      { event: 'orphan_permission_ignored', key: 'ghost.read' },
    ]);
    expect(adds).toEqual([1, 1]);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/effective-permissions.spec.ts test/unit/modules/tenancy/role-permissions.spec.ts`
Expected: FAIL.

- [ ] **Step 2: Cài `effectivePermissions`, `permissionKeys`, `RolePermissions`**

`src/modules/tenancy/application/authz/effective-permissions.ts` (thay toàn bộ file; tên và chữ ký của `effectivePermissions` giữ nguyên như 3A):
```ts
import type { SystemRoleKey } from '../../constants.js';
import type { MergedCatalogue } from '../../domain/catalogue.js';
import { systemRolePermissions } from '../../domain/system-roles.js';

/**
 * Quyền hiệu lực của role HỆ THỐNG (spec SP3 §7.1 bước 3.9): tính trong code từ catalogue gộp. Role tuỳ biến không đi qua
 * đây: tập của nó là dòng đã lưu, chỉ đọc bằng `RolePermissions` (câu thứ hai của đường nóng) rồi lọc bằng
 * `customRolePermissions`. Không cache (PR18).
 */
export function effectivePermissions(role: { systemKey: SystemRoleKey | null }, merged: MergedCatalogue): string[] {
  if (role.systemKey === null) throw new Error('a custom role has stored permissions: use RolePermissions');
  return [...systemRolePermissions(role.systemKey, merged)].sort();
}

export type CustomRolePermissions = { granted: string[]; orphans: string[] };

/**
 * Tập đã lưu của một role tuỳ biến → quyền cấp thật (spec §7.3; R-X21, R-X23). Key deprecated trong code bị bỏ (U10; DB đã
 * lọc `deprecated_at`). Key không catalogue nào đã nạp khai báo là ORPHAN (module của nó bị tắt; dòng `permissions` ở lại
 * DB): không cấp gì và KHÔNG ném — route chỉ đến từ catalogue đã nạp nên không route nào đòi nó; ném ở đây sẽ biến mọi
 * request của người giữ role thành 500 và chặn cả owner sửa role để gỡ key (R-X23). Trả orphan để caller báo (WARN +
 * metric) và để `RoleService` gỡ nó khi sửa role.
 */
export function customRolePermissions(stored: readonly string[], merged: MergedCatalogue): CustomRolePermissions {
  const granted = new Set<string>();
  const orphans = new Set<string>();
  for (const key of stored) {
    const entry = merged.get(key);
    if (!entry) orphans.add(key);
    else if (!entry.deprecated) granted.add(key);
  }
  return { granted: [...granted].sort(), orphans: [...orphans].sort() };
}
```
`src/modules/tenancy/ports/role-repository.ts` — thêm vào lớp trừu tượng:
```ts
  /** Key (không deprecated) đã lưu của các role tuỳ biến trong org hiện tại; mọi id đầu vào có mặt trong Map. */
  abstract permissionKeys(roleIds: readonly string[]): Promise<Map<string, string[]>>;
```
`src/modules/tenancy/infra/sql/sql-role.repository.ts` — thêm (import `z` từ `zod`):
```ts
/**
 * Câu thứ hai của đường nóng (spec SP3 §7.3) và mọi lần đọc tập quyền role tuỳ biến. Index: PK
 * `org_role_permissions_pk (org_id, role_id, permission_id)`; `permissions` nhỏ (catalogue) nên join theo PK của nó.
 */
export const ROLE_PERMISSIONS_SQL = `SELECT rp.role_id::text AS role_id, p.key
FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id
WHERE rp.org_id = app_current_org() AND rp.role_id = ANY(?::bigint[]) AND p.deprecated_at IS NULL
ORDER BY rp.role_id, p.key`;
const RoleKeyRow = z.object({ role_id: z.string(), key: z.string() });
```
và phương thức trong `SqlRoleRepository`:
```ts
  async permissionKeys(roleIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(roleIds.map((id) => [id, []]));
    if (roleIds.length === 0) return out;
    for (const raw of await this.db.execute(ROLE_PERMISSIONS_SQL, [roleIds])) {
      const row = RoleKeyRow.parse(raw);
      const keys = out.get(row.role_id);
      if (!keys) throw new Error(`permissionKeys returned role ${row.role_id} that was not asked for`);
      keys.push(row.key);
    }
    return out;
  }
```
`src/modules/tenancy/application/authz/role-permissions.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import type { SystemRoleKey } from '../../constants.js';
import { RoleRepository } from '../../ports/role-repository.js';
import { PermissionCatalogueRegistry } from '../permission-catalogue.registry.js';
import { TenancyMetrics } from '../tenancy-metrics.js';
import { customRolePermissions, effectivePermissions, type CustomRolePermissions } from './effective-permissions.js';

export type RoleRef = { id: string; systemKey: SystemRoleKey | null };

/**
 * Nguồn DUY NHẤT của quyền hiệu lực của một role (middleware, `ActorReauthorizer`, `MemberService`, `RoleService`,
 * `GET …/roles`): role hệ thống tính trong code, role tuỳ biến đọc bằng MỘT câu cho cả lô. Chạy trong OrgScope +
 * transaction của caller (sau khoá org ở các mutation, nên thấy tập đã commit mới nhất, T-8). Key orphan (R-X23) bị bỏ
 * qua; mỗi key WARN + cộng metric MỘT lần mỗi process (đường nóng không làm ngập log; tập nhớ bị chặn bởi số key có dòng
 * `permissions` mà không catalogue nào nạp, tức vài key của module đã tắt).
 */
@Injectable()
export class RolePermissions {
  private readonly logger = new Logger(RolePermissions.name);
  private readonly reportedOrphans = new Set<string>();

  constructor(
    private readonly roles: RoleRepository,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
  ) {}

  async of(role: RoleRef): Promise<string[]> {
    return (await this.detailOf(role)).granted;
  }

  async ofMany(roles: readonly RoleRef[]): Promise<Map<string, string[]>> {
    const detail = await this.detailMany(roles);
    return new Map([...detail].map(([id, d]) => [id, d.granted]));
  }

  /** Tập đã cấp + key orphan còn lưu (role hệ thống: không có orphan). */
  async detailOf(role: RoleRef): Promise<CustomRolePermissions> {
    const out = (await this.detailMany([role])).get(role.id);
    if (!out) throw new Error(`RolePermissions lost role ${role.id}`);
    return out;
  }

  private async detailMany(roles: readonly RoleRef[]): Promise<Map<string, CustomRolePermissions>> {
    const merged = this.registry.merged();
    const custom = roles.filter((r) => r.systemKey === null).map((r) => r.id);
    const stored = custom.length > 0 ? await this.roles.permissionKeys(custom) : new Map<string, string[]>();
    const out = new Map<string, CustomRolePermissions>();
    for (const r of roles) {
      if (r.systemKey !== null) {
        out.set(r.id, { granted: effectivePermissions(r, merged), orphans: [] });
        continue;
      }
      const keys = stored.get(r.id);
      if (keys === undefined) throw new Error(`permissionKeys did not return role ${r.id}`);
      const set = customRolePermissions(keys, merged);
      for (const key of set.orphans) this.reportOrphan(key);
      out.set(r.id, set);
    }
    return out;
  }

  private reportOrphan(key: string): void {
    if (this.reportedOrphans.has(key)) return;
    this.reportedOrphans.add(key);
    this.metrics.catalogueOrphanKeys.add(1);
    // Key catalogue không phải PII; không log role, org hay user.
    this.logger.warn({ event: 'orphan_permission_ignored', key }, 'a custom role holds a permission that no loaded catalogue declares; it grants nothing');
  }
}
```
`src/modules/tenancy/tenancy.module.ts` — thêm `RolePermissions` vào `providers` và `exports` của `TenancyCoreModule` (cạnh `EscalationGuard`; `TenancyMetrics` đã là provider của module này).

Run: `pnpm vitest run --project unit test/unit/modules/tenancy/effective-permissions.spec.ts test/unit/modules/tenancy/role-permissions.spec.ts`
Expected: PASS.

- [ ] **Step 3: Nối vào middleware, re-auth, `MemberService`, `GET …/roles`**

`src/modules/tenancy/http/org-context.middleware.ts`:
- Constructor: bỏ `PermissionCatalogueRegistry` (chỉ dùng cho `effectivePermissions`), thêm `private readonly rolePermissions: RolePermissions` (import từ `../application/authz/role-permissions.js`); bỏ import `effectivePermissions`.
- `lookup()` trả cả quyền, tính trong CÙNG scope và transaction:
```ts
  private async lookup(principal: Principal, orgId: string): Promise<{ membership: MembershipLookup; permissions: string[] }> {
    const started = performance.now();
    try {
      return await this.scope.run(orgId, () =>
        this.uow.run(async () => {
          const membership = await this.reader.lookup(this.subjects.of(principal));
          const member = membership.org === 'PRESENT' ? membership.member : null;
          // Câu thứ hai của spec §7.3, chỉ cho role tuỳ biến; lỗi DB ở đây cũng rơi vào nhánh 503 bên dưới (tiêu chí 12).
          const permissions = member ? await this.rolePermissions.of({ id: member.roleId, systemKey: member.systemKey }) : [];
          return { membership, permissions };
        }),
      );
    } catch (err) {
```
(phần `catch`/`finally` giữ nguyên của 3A).
- Trong `resolve()`: `const { membership: lookup, permissions } = await this.lookup(principal, orgId);` và xoá dòng `const permissions = effectivePermissions(member, this.registry.merged());` (biến `permissions` giờ lấy từ `lookup`). Phần còn lại không đổi.

`src/modules/tenancy/application/actor-reauthorizer.ts`: constructor thay `PermissionCatalogueRegistry` bằng `RolePermissions` (nếu `registry` không còn dùng chỗ nào khác); dòng tính quyền thành:
```ts
    const permissions = new Set(await this.rolePermissions.of({ id: actor.roleId, systemKey: actor.systemKey }));
```

`src/modules/tenancy/application/member.service.ts`: inject `RolePermissions`; trong `changeRole` và `remove` thay hai biểu thức `new Set(effectivePermissions(current, merged))` bằng `new Set(await this.rolePermissions.of({ id: current.roleId, systemKey: current.systemKey }))`, và `new Set(effectivePermissions(role, merged))` bằng `new Set(await this.rolePermissions.of(role))` (`RoleRow` có `id` và `systemKey`). Bỏ import `effectivePermissions` nếu không còn dùng. Mọi lần đọc này chạy SAU `lockActiveOrg()`, nên đọc tập đã commit mới nhất của role (T-8).

`src/modules/tenancy/http/roles.controller.ts` (3A: chỉ đọc) — hai handler đọc dùng `RolePermissions` thay `effectivePermissions`:
```ts
  constructor(
    private readonly roles: RoleRepository,
    private readonly rolePermissions: RolePermissions,
  ) {}

  @Get()
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleListResponse)
  async list() {
    const rows = await this.roles.list();
    const perms = await this.rolePermissions.ofMany(rows);
    return serialize(RoleListResponse, { data: rows.map((r) => roleOf(r, perms.get(r.id) ?? [])) });
  }

  @Get(':roleId')
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleResponse)
  async get(@Param('roleId') roleId: string) {
    const id = PublicIdParam.safeParse(roleId);
    const role = id.success ? await this.roles.findByPublicId(id.data.toLowerCase()) : undefined;
    if (!role) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return serialize(RoleResponse, roleOf(role, await this.rolePermissions.of(role)));
  }
```
(Task 6 chuyển hai handler này sang `RoleService` cùng lúc thêm route ghi.)

Kiểm không còn chỗ gọi nào bỏ sót role tuỳ biến:
```bash
grep -rn "effectivePermissions(" src/modules/tenancy
```
Expected: chỉ còn định nghĩa trong `effective-permissions.ts` và lời gọi trong `role-permissions.ts`; mọi chỗ khác (7 lời gọi của 3A: middleware 1, `ActorReauthorizer` 1, `MemberService` 3 — hai trong `changeRole`, một trong `remove` —, `RolesController` 2) đã qua `RolePermissions`.

- [ ] **Step 4: E2E truy cập bằng role tuỳ biến (fail trước Step 3)**

`test/e2e/tenancy/custom-role-access.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ROLE_SET_C0, inOrgTx, roleSetC1, seedCustomRole, seedMember, seedMemberInRole, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

describe('custom roles on the hot path and in the in-transaction re-check (spec SP3 §7.3, §8.6)', () => {
  let app: INestApplication;
  /** C1 = MEMBER ∪ {members.role.assign} của catalogue gộp thật của app (R-X24): B-21 cần C1 trội MEMBER. */
  let C1: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const c1 = await seedCustomRole(org, { permissions: C1, name: 'C1' });
    const c0 = await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'C0' });
    const c1p = await seedP();
    const c0p = await seedP();
    const mp = await seedP();
    await seedMemberInRole(org, c1, { authUserId: c1p.authUserId });
    await seedMemberInRole(org, c0, { authUserId: c0p.authUserId });
    const m = await seedMember(org, 'MEMBER', { authUserId: mp.authUserId });
    return { org, c1, c0, c1p, c0p, m };
  };
  beforeAll(async () => {
    app = await startTenancyApp();
    C1 = roleSetC1(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a C1 holder passes the guard for its keys; a C0 holder is a member without members.read', async () => {
    const c = await cast();
    expect((await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/members`)).status).toBe(200);
    expect((await authed(app, c.c0p).get(`/v1/orgs/${c.org.orgId}/members/me`)).status).toBe(200);
    const denied = await authed(app, c.c0p).get(`/v1/orgs/${c.org.orgId}/members`);
    expect([denied.status, denied.body.code]).toEqual([403, 'forbidden']);
  });
  it('GET roles lists system and custom roles; a custom role carries its stored keys, sorted', async () => {
    const c = await cast();
    const r = await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/roles`);
    expect(r.status).toBe(200);
    expect(r.body.data.find((x: { id: string }) => x.id === c.c1.publicId)).toMatchObject({ systemKey: null, name: 'C1', permissions: C1 });
    expect((await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/roles/${c.c0.publicId}`)).body.permissions).toEqual(['org.read']);
  });
  it('the in-transaction re-check reads the custom set: C1 moves a MEMBER to C0 (B-21 through the API)', async () => {
    const c = await cast();
    const r = await authed(app, c.c1p).patch(`/v1/orgs/${c.org.orgId}/members/${c.m.memberPublicId}`).set('if-match', '*').send({ roleId: c.c0.publicId });
    expect(r.status).toBe(200);
    expect(r.body.role).toEqual({ id: c.c0.publicId, systemKey: null, name: 'C0' });
  });
  it('R-14 (SQL): removing members.read (and its dependant) from C1 takes effect on the next request (no cache, PR18)', async () => {
    const c = await cast();
    expect((await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/members`)).status).toBe(200);
    await withAppClient((db) =>
      inOrgTx(db, c.org.orgId, () =>
        db.query(`DELETE FROM org_role_permissions rp USING permissions p WHERE p.id = rp.permission_id AND rp.role_id = $1 AND p.key IN ('members.read', 'members.role.assign')`, [c.c1.id]),
      ),
    );
    expect((await authed(app, c.c1p).get(`/v1/orgs/${c.org.orgId}/members`)).status).toBe(403);
  });
});
```
Run: `pnpm vitest run --project integration test/e2e/tenancy/custom-role-access.e2e.spec.ts`
Expected: PASS sau Step 3 (trước Step 3: `500` từ nhánh "custom roles are introduced by plan 3B" của 3A).

- [ ] **Step 5: EXPLAIN câu thứ hai trên 10.000 org × 20 member (DB riêng)**

`test/integration/tenancy/hot-path-explain.spec.ts` (3A Task 22) — ba chỗ sửa:
1. `TENANT_TABLES` thêm `'org_role_permissions'`; import `ROLE_PERMISSIONS_SQL` từ `src/modules/tenancy/infra/sql/sql-role.repository.js`, và `roleSetC1`, `TENANCY_ONLY_CATALOGUE` từ `../../support/tenancy-seed.js`; hằng file `const C1 = roleSetC1(TENANCY_ONLY_CATALOGUE);` (test DB không có app: một tập đóng có thật trong DB, R-X24).
2. Trong `beforeAll`, sau câu `INSERT INTO org_members …` và TRƯỚC vòng `FORCE` lại, thêm (một role tuỳ biến C1 mỗi org):
```ts
    await owner.query(`INSERT INTO org_roles (org_id, name) SELECT id, 'Custom' FROM organizations`);
    // Seed hàng loạt: tắt trigger closure trong chính transaction seed (tập C1 đã đóng; 40 000 lần kiểm lúc COMMIT không
    // chứng minh thêm gì cho EXPLAIN), bật lại trước COMMIT. Chỉ ở DB riêng của test này.
    await owner.query('ALTER TABLE org_role_permissions DISABLE TRIGGER org_role_permissions_closed_ck');
    await owner.query(
      `INSERT INTO org_role_permissions (org_id, role_id, permission_id)
       SELECT r.org_id, r.id, p.id FROM org_roles r CROSS JOIN permissions p
       WHERE r.system_key IS NULL AND p.key = ANY($1::text[])`,
      [C1],
    );
    await owner.query('ALTER TABLE org_role_permissions ENABLE TRIGGER org_role_permissions_closed_ck');
```
3. Thêm ca:
```ts
  it('the custom-role query (second statement of spec §7.3) uses the PK of org_role_permissions and filters deprecated keys', async () => {
    const { rows: pick } = await owner.query<{ org_id: string; role_id: string }>(
      `SELECT org_id::text AS org_id, id::text AS role_id FROM org_roles WHERE system_key IS NULL OFFSET 4321 LIMIT 1`,
    );
    const target = pick[0];
    if (!target) throw new Error('seed produced no custom role');
    const sql = ROLE_PERMISSIONS_SQL.replace('?', '$1');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.org_id', $1, true)`, [target.org_id]);
    const { rows } = await app.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [[target.role_id]]);
    const text = await app.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [[target.role_id]]);
    const keys = await app.query<{ key: string }>(sql, [[target.role_id]]);
    await app.query('ROLLBACK');
    console.info(`custom role query plan (${ORGS} orgs):\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}`);
    const all = nodes(rows[0]!['QUERY PLAN'][0].Plan);
    expect(all.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'org_role_permissions')).toEqual([]);
    expect(all.map((n) => n['Index Name']).filter(Boolean)).toContain('org_role_permissions_pk');
    expect(keys.rows.map((r) => r.key)).toEqual(C1);
    // deprecated_at lọc ở SQL: đánh dấu một key trong transaction owner rồi ROLLBACK (DB riêng; không đổi catalogue thật).
    await owner.query('BEGIN');
    await owner.query(`UPDATE permissions SET deprecated_at = now() WHERE key = 'roles.read'`);
    await owner.query(`ALTER TABLE org_role_permissions NO FORCE ROW LEVEL SECURITY`);
    await owner.query(`SELECT set_config('app.org_id', $1, true)`, [target.org_id]);
    const filtered = await owner.query<{ key: string }>(sql, [[target.role_id]]);
    await owner.query('ROLLBACK');
    expect(filtered.rows.map((r) => r.key)).not.toContain('roles.read');
  });
```
Run: `pnpm vitest run --project integration test/integration/tenancy/hot-path-explain.spec.ts`
Expected: PASS; log có plan với `Index Scan`/`Index Only Scan using org_role_permissions_pk`. Copy bản in vào mô tả PR ở Task 14.

- [ ] **Step 6: Kiểm toàn cục, commit**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/tenancy test/integration/tenancy
```
Expected: xanh; e2e của 3A (members, member-races, member-toctou, org-context, role-route-matrix) không đổi hành vi với role hệ thống.
```bash
git add src/modules/tenancy test/unit/modules/tenancy test/e2e/tenancy/custom-role-access.e2e.spec.ts test/integration/tenancy/hot-path-explain.spec.ts
git commit -m "feat(tenancy): custom role permissions on the hot path, in the re-authorization and in member changes through one batched query"
```

---
### Task 6: `RoleService` và `POST/PATCH/DELETE /v1/orgs/{orgId}/roles` — lỗi, event `tenancy.role.*`, repository ghi, OpenAPI; R-1…R-7, R-9…R-17, R-20 (E) và Review Focus 1–5

**Files:**
- Create: `src/modules/tenancy/application/role.service.ts`, `test/e2e/tenancy/roles.e2e.spec.ts`
- Modify: `src/modules/tenancy/errors.ts`, `src/modules/tenancy/events.ts`, `src/modules/tenancy/ports/role-repository.ts`, `src/modules/tenancy/infra/sql/sql-role.repository.ts`, `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/roles.controller.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `test/unit/modules/tenancy/errors.spec.ts`, `openapi.json`

**Interfaces:**
- Consumes: `checkCustomRoleSet`, `sameSet`, `roleName`, `roleDescription`, `assertCanCreateRole`, `assertCanEditRole`, `assertCanDeleteRole`, `PERMISSION_KEY_PATTERN`, `ROLE_PERMISSIONS_MAX` (Task 2, 4), `RolePermissions` (Task 5), `ActorReauthorizer.require`, `userActor`, `type Reauthorized` (3A Task 23), `EscalationGuard`, `TenancyTestHooks`, `OrgRepository.lockCurrent`, `EventPublisher`, `assertIfMatch`, `etagOf`, `setLocation`, `serialize`, `Idempotent`, `mergePatchSchema`, `roleOf`, `RoleResponse`, `RoleListResponse`, `PublicIdParam`, `SensitiveTenancyAction`, `TenancyPermissions` (SP1, 3A).
- Produces:
  - `TenancyErrors.{ROLE_IN_USE (409 role_in_use), ROLE_NAME_TAKEN (409 role_name_taken), MISSING_DEPENDENCIES (422 missing_dependencies), UNKNOWN_PERMISSION (422 unknown_permission), PERMISSION_NOT_DELEGABLE (422 permission_not_delegable)}`; constraint map: `org_role_permissions_custom_only` → `system_role_immutable`, `org_role_permissions_not_delegable` → `permission_not_delegable`, `org_role_permissions_deprecated` → `unknown_permission`, `org_role_permissions_closed_ck` → `missing_dependencies`, `org_roles_name_uq` → `role_name_taken`, `org_members_role_fk` → `role_in_use`.
  - Event: `RoleCreatedEvent` (`tenancy.role.created`, `{ roleId, permissions }`), `RoleUpdatedEvent` (`tenancy.role.updated`, `{ roleId, permissions }`; cũng là event của migration catalogue, Task 11), `RoleDeletedEvent` (`tenancy.role.deleted`, `{ roleId }`); aggregate `role`, id `org_roles.public_id`, version = cột `version` sau thay đổi (xoá: `version + 1`).
  - `RoleRepository` thêm: `insertCustom(r: { name: string; description: string | null }): Promise<RoleRow>`, `lockByPublicId(publicId): Promise<RoleRow | undefined>` (`FOR NO KEY UPDATE`), `update(id, r: { name: string; description: string | null }): Promise<RoleRow>` (tăng `version`), `replacePermissions(roleId, keys: ReadonlySet<string>): Promise<void>` (xoá dòng ngoài tập, chèn dòng thiếu; chèn thiếu so với tập → ném), `deleteById(id): Promise<void>`.
  - `type RoleView = { role: RoleRow; permissions: string[] }` (`permissions` là tập đã cấp: không bao giờ chứa key orphan); `RoleService.list(): Promise<RoleView[]>`, `.get(publicId)`, `.create({ name, description, permissions })`, `.update(publicId, ifMatch, patch: { name?; description?: string | null; permissions? })` (có `permissions` → gỡ mọi key orphan còn lưu, R-X23), `.delete(publicId)`. `RoleService.delete` là điểm mở rộng của 3C (spec Bảng 5: lời mời hết hạn → `EXPIRED`, thu hồi link không còn mở + event `ROLE_DELETED`, trước câu xoá).
  - Schema: `PermissionKey`, `CreateRoleBody { name, description?, permissions }`, `PatchRoleBody` (merge-patch: `name`, `description` nullable, `permissions` thay nguyên mảng).
  - Route: `POST /v1/orgs/:orgId/roles` (`roles.write`, `@SensitiveTenancyAction()`, `@Idempotent()`, `201` + `Location` + `ETag`), `PATCH /v1/orgs/:orgId/roles/:roleId` (`roles.write`, `@SensitiveTenancyAction()`, `If-Match` bắt buộc), `DELETE /v1/orgs/:orgId/roles/:roleId` (`roles.write`, `@SensitiveTenancyAction()`, `204`).

- [ ] **Step 1: Lỗi, map constraint, event (unit fail → pass)**

`test/unit/modules/tenancy/errors.spec.ts` — thêm vào bảng `it.each` của ca map constraint:
```ts
    ['23514', 'org_role_permissions_custom_only', TenancyErrors.SYSTEM_ROLE_IMMUTABLE],
    ['23514', 'org_role_permissions_not_delegable', TenancyErrors.PERMISSION_NOT_DELEGABLE],
    ['23514', 'org_role_permissions_deprecated', TenancyErrors.UNKNOWN_PERMISSION],
    ['23514', 'org_role_permissions_closed_ck', TenancyErrors.MISSING_DEPENDENCIES],
    ['23505', 'org_roles_name_uq', TenancyErrors.ROLE_NAME_TAKEN],
    ['23001', 'org_members_role_fk', TenancyErrors.ROLE_IN_USE],
```
và ca:
```ts
  it('3B codes carry the statuses of spec §15', () => {
    expect([TenancyErrors.ROLE_IN_USE, TenancyErrors.ROLE_NAME_TAKEN, TenancyErrors.MISSING_DEPENDENCIES, TenancyErrors.UNKNOWN_PERMISSION, TenancyErrors.PERMISSION_NOT_DELEGABLE].map((e) => [e.code, e.status])).toEqual([
      ['role_in_use', 409],
      ['role_name_taken', 409],
      ['missing_dependencies', 422],
      ['unknown_permission', 422],
      ['permission_not_delegable', 422],
    ]);
  });
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/errors.spec.ts` → FAIL.

`src/modules/tenancy/errors.ts` — thêm vào object của `defineErrorCodes`:
```ts
  ROLE_IN_USE: { status: HttpStatus.CONFLICT, title: 'The role is still assigned' },
  ROLE_NAME_TAKEN: { status: HttpStatus.CONFLICT, title: 'A role with this name already exists' },
  MISSING_DEPENDENCIES: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'The permission set lacks permissions it requires' },
  UNKNOWN_PERMISSION: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Unknown or deprecated permission' },
  PERMISSION_NOT_DELEGABLE: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'This permission cannot be delegated' },
```
và một khối map mới (sau khối của 3A; tên không bao giờ ra client):
```ts
/**
 * Constraint của 3B (migration `custom_role_permissions`, `org_roles_name_uq` của `tenancy_core`). `org_members_role_fk`:
 * 23001 khi xoá role còn member; 23503 trên cùng FK chỉ xảy ra khi gán role không tồn tại, mà service đã kiểm role dưới
 * khoá org trước khi ghi, nên mã chung `role_in_use` không che lỗi nào của đường app.
 */
defineConstraintErrors({
  org_role_permissions_custom_only: TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
  org_role_permissions_not_delegable: TenancyErrors.PERMISSION_NOT_DELEGABLE,
  org_role_permissions_deprecated: TenancyErrors.UNKNOWN_PERMISSION,
  org_role_permissions_closed_ck: TenancyErrors.MISSING_DEPENDENCIES,
  org_roles_name_uq: TenancyErrors.ROLE_NAME_TAKEN,
  org_members_role_fk: TenancyErrors.ROLE_IN_USE,
});
```
`src/modules/tenancy/events.ts` — thêm:
```ts
const permissionKeys = z.array(z.string());
/** Spec §14: tập quyền cuối cùng (đã sắp, không deprecated). `.updated` cũng do migration catalogue phát (actor system). */
export const RoleCreatedEvent = defineEvent({ type: 'tenancy.role.created', version: 1, schema: z.object({ roleId: id, permissions: permissionKeys }) });
export const RoleUpdatedEvent = defineEvent({ type: 'tenancy.role.updated', version: 1, schema: z.object({ roleId: id, permissions: permissionKeys }) });
export const RoleDeletedEvent = defineEvent({ type: 'tenancy.role.deleted', version: 1, schema: z.object({ roleId: id }) });
```
(R-X3: nếu plan 6.0 đã merge trước thì `defineEvent` đòi cờ `audit`/`webhook` tường minh (`pnpm typecheck` báo thiếu ở đúng ba lời gọi này). Giá trị đã chốt cho cả ba — `tenancy.role.created`, `tenancy.role.updated`, `tenancy.role.deleted` — là `audit: true, webhook: false` (plan 6.0 Task 16 Step 2; spec SP6 §5.3, §8.3: sáu event webhook công khai đều là event 3A). Viết `defineEvent({ type: 'tenancy.role.created', version: 1, schema: …, audit: true, webhook: false })` và tương tự cho hai event kia. Không sửa bảng `EXPECTED` của `test/unit/core/events/event-flags.spec.ts` (6.0 ghi rõ plan sau không sửa bảng đó).)

Run: `pnpm vitest run --project unit test/unit/modules/tenancy/errors.spec.ts` → PASS.

- [ ] **Step 2: Repository ghi**

`src/modules/tenancy/ports/role-repository.ts` — thêm:
```ts
  abstract insertCustom(r: { name: string; description: string | null }): Promise<RoleRow>;
  /** `FOR NO KEY UPDATE` (spec §8.6 bước 3): sửa/xoá role tuần tự hoá với nhau và với gán role (đã khoá org trước). */
  abstract lockByPublicId(publicId: string): Promise<RoleRow | undefined>;
  /** Ghi tên/mô tả và tăng `version` (ETag, `aggregate.version`), kể cả khi chỉ tập quyền đổi. */
  abstract update(id: string, r: { name: string; description: string | null }): Promise<RoleRow>;
  /** Tập đã lưu = `keys` (xoá dòng ngoài tập, chèn dòng thiếu); tập trung gian được trigger hoãn kiểm lúc COMMIT. */
  abstract replacePermissions(roleId: string, keys: ReadonlySet<string>): Promise<void>;
  abstract deleteById(id: string): Promise<void>;
```
`src/modules/tenancy/infra/sql/sql-role.repository.ts` — thêm (import `single` từ `./rows.js`):
```ts
  async insertCustom(r: { name: string; description: string | null }): Promise<RoleRow> {
    return RoleRowSchema.parse(
      single(await this.db.execute(`INSERT INTO org_roles (org_id, name, description) VALUES (app_current_org(), ?, ?) RETURNING ${ROLE_COLUMNS}`, [r.name, r.description]), 'insert custom role'),
    );
  }
  async lockByPublicId(publicId: string): Promise<RoleRow | undefined> {
    const [row] = await this.db.execute(`SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() AND public_id = ? FOR NO KEY UPDATE`, [publicId]);
    return row ? RoleRowSchema.parse(row) : undefined;
  }
  async update(id: string, r: { name: string; description: string | null }): Promise<RoleRow> {
    return RoleRowSchema.parse(
      single(
        await this.db.execute(
          `UPDATE org_roles SET name = ?, description = ?, version = version + 1, updated_at = now() WHERE org_id = app_current_org() AND id = ? RETURNING ${ROLE_COLUMNS}`,
          [r.name, r.description, id],
        ),
        'update custom role',
      ),
    );
  }
  async replacePermissions(roleId: string, keys: ReadonlySet<string>): Promise<void> {
    const wanted = [...keys];
    await this.db.execute(
      `DELETE FROM org_role_permissions rp USING permissions p
       WHERE rp.org_id = app_current_org() AND rp.role_id = ? AND p.id = rp.permission_id AND NOT (p.key = ANY(?::text[]))`,
      [roleId, wanted],
    );
    await this.db.execute(
      `INSERT INTO org_role_permissions (org_id, role_id, permission_id)
       SELECT app_current_org(), ?, p.id FROM permissions p
       WHERE p.key = ANY(?::text[])
         AND NOT EXISTS (SELECT 1 FROM org_role_permissions x WHERE x.org_id = app_current_org() AND x.role_id = ? AND x.permission_id = p.id)`,
      [roleId, wanted, roleId],
    );
    const [count] = await this.db.execute<{ n: string }>(
      `SELECT count(*)::text AS n FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.org_id = app_current_org() AND rp.role_id = ? AND p.key = ANY(?::text[])`,
      [roleId, wanted],
    );
    // Key hợp lệ theo catalogue trong code nhưng thiếu dòng `permissions` là lệch catalogue mà CatalogueCheck đã phải chặn
    // lúc boot: fail loud, không lưu âm thầm một tập nhỏ hơn yêu cầu.
    if (Number(count?.n) !== wanted.length) throw new Error(`role ${roleId}: stored permissions drifted from the catalogue`);
  }
  async deleteById(id: string): Promise<void> {
    single(await this.db.execute('DELETE FROM org_roles WHERE org_id = app_current_org() AND id = ? RETURNING id', [id]), 'delete custom role');
  }
```

- [ ] **Step 3: `RoleService`**

`src/modules/tenancy/application/role.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors, type FieldError } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { assertCanCreateRole, assertCanDeleteRole, assertCanEditRole, type Actor } from '../domain/escalation.js';
import { checkCustomRoleSet, sameSet } from '../domain/role.js';
import { TenancyErrors } from '../errors.js';
import { RoleCreatedEvent, RoleDeletedEvent, RoleUpdatedEvent } from '../events.js';
import type { MemberRow } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { RoleRepository, type RoleRow } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { RolePermissions } from './authz/role-permissions.js';
import { EscalationGuard } from './escalation-guard.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

export type RoleView = { role: RoleRow; permissions: string[] };
export type RolePatch = { name?: string; description?: string | null; permissions?: readonly string[] };
type CustomRole = RoleRow & { name: string };
const ROLES_WRITE = 'roles.write';

/**
 * Role tuỳ biến (spec SP3 §8.4 luật 1, 2a(i)–(iii), 6; §8.6): khoá org → khoá role `FOR NO KEY UPDATE` → đọc lại actor
 * `FOR SHARE` và kiểm lại cửa → kiểm tập mới → luật → ghi → outbox, trong MỘT transaction. Trigger guard/closure và FK
 * `RESTRICT` là lớp chặn cuối. Mọi mutation là `@SensitiveTenancyAction()` ở controller.
 */
@Injectable()
export class RoleService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly rolePermissions: RolePermissions,
    private readonly reauth: ActorReauthorizer,
    private readonly escalation: EscalationGuard,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
  ) {}

  async list(): Promise<RoleView[]> {
    const rows = await this.roles.list();
    const perms = await this.rolePermissions.ofMany(rows);
    return rows.map((role) => ({ role, permissions: perms.get(role.id) ?? [] }));
  }

  async get(publicId: string): Promise<RoleView> {
    const role = await this.roles.findByPublicId(publicId);
    if (!role) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return { role, permissions: await this.rolePermissions.of(role) };
  }

  async create(input: { name: string; description: string | null; permissions: readonly string[] }): Promise<RoleView> {
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([ROLES_WRITE]);
      const next = this.validated(input.permissions);
      this.escalation.enforce(assertCanCreateRole(this.actorOf(actor, permissions), next, this.registry.merged()));
      const role = await this.roles.insertCustom({ name: input.name, description: input.description });
      await this.roles.replacePermissions(role.id, next);
      const keys = [...next].sort();
      await this.events.publish(RoleCreatedEvent, {
        data: { roleId: role.publicId, permissions: keys },
        aggregate: { type: 'role', id: role.publicId, version: role.version },
        actor: userActor(this.ctx),
      });
      return { role, permissions: keys };
    });
  }

  async update(publicId: string, ifMatch: string | undefined, patch: RolePatch): Promise<RoleView> {
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const locked = await this.lockRole(publicId);
      const { actor, permissions } = await this.reauth.require([ROLES_WRITE]);
      const role = this.customOnly(locked);
      assertIfMatch(ifMatch, role.version, { required: true });
      // Tập cũ cho luật 1/2a là tập ĐÃ CẤP (key orphan không cấp gì, R-X23); `validated` từ chối thêm key orphan (422
      // unknown_permission) vì nó không có trong catalogue gộp.
      const stored = await this.rolePermissions.detailOf(role);
      const oldSet: ReadonlySet<string> = new Set(stored.granted);
      const newSet = patch.permissions === undefined ? oldSet : this.validated(patch.permissions);
      this.escalation.enforce(
        assertCanEditRole(this.actorOf(actor, permissions), { heldByActor: actor.roleId === role.id, oldSet, newSet }, this.registry.merged()),
      );
      const name = patch.name ?? role.name;
      const description = patch.description === undefined ? role.description : patch.description;
      // R-X23: PATCH có `permissions` luôn gỡ key orphan còn lưu (tập mới đã qua catalogue nên không chứa orphan), kể cả khi
      // tập đã cấp không đổi — đó là cách owner dọn role sau khi tắt module.
      const permissionsChanged = patch.permissions !== undefined && (!sameSet(oldSet, newSet) || stored.orphans.length > 0);
      // Review Focus 2: không đổi gì → không tăng version, không event, không ghi dòng.
      if (!permissionsChanged && name === role.name && description === role.description) return { role, permissions: [...oldSet].sort() };
      if (permissionsChanged) await this.roles.replacePermissions(role.id, newSet);
      const updated = await this.roles.update(role.id, { name, description });
      const keys = [...newSet].sort();
      await this.events.publish(RoleUpdatedEvent, {
        data: { roleId: updated.publicId, permissions: keys },
        aggregate: { type: 'role', id: updated.publicId, version: updated.version },
        actor: userActor(this.ctx),
      });
      return { role: updated, permissions: keys };
    });
  }

  async delete(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      const locked = await this.lockRole(publicId);
      const { actor, permissions } = await this.reauth.require([ROLES_WRITE]);
      const role = this.customOnly(locked);
      const oldSet: ReadonlySet<string> = new Set(await this.rolePermissions.of(role));
      this.escalation.enforce(assertCanDeleteRole(this.actorOf(actor, permissions), oldSet, this.registry.merged()));
      // Điểm mở rộng của 3C (spec Bảng 5): chuyển lời mời hết hạn của role sang EXPIRED và thu hồi link không còn mở
      // (event `tenancy.invite_link.revoked { reason: 'ROLE_DELETED' }`) ngay trước câu xoá dưới đây.
      await this.roles.deleteById(role.id); // còn member → 23001 org_members_role_fk → 409 role_in_use (T-9)
      await this.events.publish(RoleDeletedEvent, {
        data: { roleId: role.publicId },
        aggregate: { type: 'role', id: role.publicId, version: role.version + 1 },
        actor: userActor(this.ctx),
      });
    });
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
  }

  /** Thứ tự khoá cố định (spec §3.14): org (đã khoá) → role → member (`ActorReauthorizer`, `FOR SHARE`). */
  private async lockRole(publicId: string): Promise<RoleRow> {
    const role = await this.roles.lockByPublicId(publicId);
    if (!role) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // R-13: role của org khác không thấy được
    return role;
  }

  private customOnly(role: RoleRow): CustomRole {
    if (role.systemKey !== null) throw new AppError(TenancyErrors.SYSTEM_ROLE_IMMUTABLE); // R-10
    if (role.name === null) throw new Error('a custom role without a name (org_roles_kind_ck)');
    return { ...role, name: role.name };
  }

  private actorOf(actor: MemberRow, permissions: ReadonlySet<string>): Actor {
    return { memberRef: actor.publicId, isOwner: actor.systemKey === 'OWNER', permissions };
  }

  /** Luật 1 phần "tập hợp lệ" → 422 có danh sách key (spec §15: `errors[]` liệt kê key). */
  private validated(keys: readonly string[]): ReadonlySet<string> {
    const check = checkCustomRoleSet(keys, this.registry.merged());
    if (check.ok) return check.permissions;
    const fields = (code: string): FieldError[] => check.keys.map((key) => ({ path: 'permissions', code, message: key }));
    switch (check.reason) {
      case 'UNKNOWN_PERMISSION':
        throw new AppError(TenancyErrors.UNKNOWN_PERMISSION, { fields: fields('unknown_permission') });
      case 'PERMISSION_NOT_DELEGABLE':
        throw new AppError(TenancyErrors.PERMISSION_NOT_DELEGABLE, { fields: fields('permission_not_delegable') });
      case 'MISSING_DEPENDENCIES':
        throw new AppError(TenancyErrors.MISSING_DEPENDENCIES, { fields: fields('missing_dependency') });
      default: {
        const unknown: never = check.reason;
        throw new Error(`unknown role set problem ${String(unknown)}`);
      }
    }
  }
}
```
(Key trong `errors[].message` đã qua regex `PERMISSION_KEY_PATTERN` ở schema, không phải PII.)

- [ ] **Step 4: Schema, controller, module**

`src/modules/tenancy/http/schemas.ts` — thêm (import `PERMISSION_KEY_PATTERN` từ `../domain/catalogue.js`, `roleName`, `roleDescription` từ `../domain/role.js`, `ROLE_PERMISSIONS_MAX` từ `../constants.js`):
```ts
export const PermissionKey = z.string().regex(PERMISSION_KEY_PATTERN, 'must be a permission key (resource.action)');
const permissionList = z.array(PermissionKey).max(ROLE_PERMISSIONS_MAX);
export const CreateRoleBody = z.object({ name: roleName, description: roleDescription.nullable().default(null), permissions: permissionList }).strict();
/** Merge-patch (SP1): `description: null` xoá mô tả; `name: null` → 422 (không nullable); `permissions` thay nguyên mảng. */
export const PatchRoleBody = mergePatchSchema(z.object({ name: roleName, description: roleDescription.nullable(), permissions: permissionList }));
```
`src/modules/tenancy/http/roles.controller.ts` (thay toàn bộ):
```ts
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Res } from '@nestjs/common';
import type { z } from 'zod';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, etagOf, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { RoleService, type RoleView } from '../application/role.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { SensitiveTenancyAction } from './decorators.js';
import { CreateRoleBody, PatchRoleBody, PublicIdParam, RoleListResponse, RoleResponse, roleOf } from './schemas.js';

/** Id không phải UUID là "không có role như vậy" (404), không phải 22P02 (500) — Review Focus 5. */
const idOrNotFound = (raw: string): string => {
  const r = PublicIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};
const viewOf = (v: RoleView) => roleOf(v.role, v.permissions);
const ROLE_WRITE_PROBLEMS = [
  TenancyErrors.OWNER_ONLY,
  TenancyErrors.ESCALATION_DENIED,
  TenancyErrors.MISSING_DEPENDENCIES,
  TenancyErrors.UNKNOWN_PERMISSION,
  TenancyErrors.PERMISSION_NOT_DELEGABLE,
] as const;

/** Spec SP3 §12: role hệ thống chỉ đọc; role tuỳ biến tạo/sửa/xoá bằng `roles.write`. Org lấy từ context, không từ param. */
@Controller('v1/orgs/:orgId/roles')
export class RolesController {
  constructor(
    private readonly roles: RoleService,
    private readonly ctx: RequestContext,
  ) {}

  @Get()
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleListResponse)
  async list() {
    return serialize(RoleListResponse, { data: (await this.roles.list()).map(viewOf) });
  }

  @Get(':roleId')
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleResponse)
  async get(@Param('roleId') roleId: string, @Res({ passthrough: true }) res: HeaderWriter) {
    const v = await this.roles.get(idOrNotFound(roleId));
    res.setHeader('ETag', etagOf(v.role.version));
    return serialize(RoleResponse, viewOf(v));
  }

  @Post()
  @TenancyPermissions.require('roles.write')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(RoleResponse)
  @ApiProblems(...ROLE_WRITE_PROBLEMS, TenancyErrors.ROLE_NAME_TAKEN, CoreErrors.VALIDATION_FAILED)
  async create(@Body({ schema: CreateRoleBody }) body: z.infer<typeof CreateRoleBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const v = await this.roles.create(body);
    const orgId = this.ctx.orgId();
    if (orgId === undefined) throw new Error('RolesController.create ran without an org context');
    setLocation(res, `/v1/orgs/${orgId}/roles/${v.role.publicId}`);
    res.setHeader('ETag', etagOf(v.role.version));
    return serialize(RoleResponse, viewOf(v));
  }

  @Patch(':roleId')
  @TenancyPermissions.require('roles.write')
  @SensitiveTenancyAction()
  @ApiOk(RoleResponse)
  @ApiProblems(...ROLE_WRITE_PROBLEMS, TenancyErrors.CANNOT_EDIT_OWN_ROLE, TenancyErrors.SYSTEM_ROLE_IMMUTABLE, TenancyErrors.ROLE_NAME_TAKEN, CoreErrors.PRECONDITION_REQUIRED, CoreErrors.PRECONDITION_FAILED)
  async update(
    @Param('roleId') roleId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchRoleBody }) body: z.infer<typeof PatchRoleBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const v = await this.roles.update(idOrNotFound(roleId), ifMatch, body);
    res.setHeader('ETag', etagOf(v.role.version));
    return serialize(RoleResponse, viewOf(v));
  }

  @Delete(':roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('roles.write')
  @SensitiveTenancyAction()
  @ApiProblems(TenancyErrors.OWNER_ONLY, TenancyErrors.ESCALATION_DENIED, TenancyErrors.ROLE_IN_USE, TenancyErrors.SYSTEM_ROLE_IMMUTABLE)
  async remove(@Param('roleId') roleId: string): Promise<void> {
    await this.roles.delete(idOrNotFound(roleId));
  }
}
```
`tenancy-http.module.ts`: `providers` thêm `RoleService`. `CreateRoleBody` có `.default(null)` nên `body.description` là `string | null` đúng kiểu `RoleService.create`. `ApiProblems` của core là `(...errors: ErrorCode[])` (`src/core/http/api-problems.decorator.ts:12`), nên spread hằng `ROLE_WRITE_PROBLEMS` hợp lệ.

- [ ] **Step 5: E2E route role (viết trước Step 3–4, chạy thấy đỏ, rồi xanh)**

`test/e2e/tenancy/roles.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  ROLE_SET_C2,
  adminKeys,
  inOrgTx,
  roleSetC1,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';

const STALE_SEC = 3600;

describe('custom roles API (spec SP3 §8.4 luật 1, 2a, 6; §12; §18.3 R-*)', () => {
  let app: INestApplication;
  /** Tính từ catalogue gộp của app lúc chạy (R-X24): V ≡ ADMIN, C1 = MEMBER ∪ {members.role.assign}, CW = C1 + roles.write. */
  let ADMIN_KEYS: string[];
  let C1: string[];
  let CW: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** O owner, A admin, W giữ CW (C1 + roles.write), K giữ C1, Bob giữ V ≡ ADMIN (owner tạo). */
  const cast = async (opts: { sessionAgeSec?: number } = {}) => {
    const O = await seedP(opts);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP(opts);
    await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const cw = await seedCustomRole(org, { permissions: CW, name: 'CW' });
    const c1 = await seedCustomRole(org, { permissions: C1, name: 'C1' });
    const v = await seedCustomRole(org, { permissions: ADMIN_KEYS, name: 'V' });
    const W = await seedP(opts);
    await seedMemberInRole(org, cw, { authUserId: W.authUserId });
    const K = await seedP(opts);
    await seedMemberInRole(org, c1, { authUserId: K.authUserId });
    const Bob = await seedP(opts);
    await seedMemberInRole(org, v, { authUserId: Bob.authUserId });
    return { org, O, A, W, K, Bob, cw, c1, v };
  };
  const url = (org: SeededOrg, role?: SeededRole | string) => `/v1/orgs/${org.orgId}/roles${role === undefined ? '' : `/${typeof role === 'string' ? role : role.publicId}`}`;
  const create = (p: SeededPrincipal, org: SeededOrg, body: object) => authed(app, p).post(url(org)).set('idempotency-key', `k-${v7()}`).send(body);
  const patch = (p: SeededPrincipal, org: SeededOrg, role: SeededRole | string, body: object, ifMatch = '*') => authed(app, p).patch(url(org, role)).set('if-match', ifMatch).send(body);
  const events = (type: string, roleId: string) => ownerQuery<{ aggregate_version: string; payload: unknown }>(`SELECT aggregate_version::text, payload FROM outbox_events WHERE type = $1 AND aggregate_id = $2 ORDER BY id`, [type, roleId]);

  beforeAll(async () => {
    app = await startTenancyApp();
    const merged = app.get(PermissionCatalogueRegistry).merged();
    ADMIN_KEYS = adminKeys(merged);
    C1 = roleSetC1(merged);
    CW = [...C1, 'roles.write'].sort();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('R-1: an ADMIN creates a role strictly below itself → 201 + Location + ETag + one tenancy.role.created', async () => {
    const c = await cast();
    const r = await create(c.A, c.org, { name: 'Support', description: 'Helps', permissions: ['members.read', 'org.read'] });
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(`/v1/orgs/${c.org.orgId}/roles/${r.body.id}`);
    expect(r.headers.etag).toBe('W/"1"'); // ETag yếu của `etagOf` (ADR 0007)
    expect(r.body).toMatchObject({ systemKey: null, name: 'Support', description: 'Helps', permissions: ['members.read', 'org.read'] });
    expect(await events('tenancy.role.created', r.body.id)).toEqual([{ aggregate_version: '1', payload: { roleId: r.body.id, permissions: ['members.read', 'org.read'] } }]);
  });
  it.each([
    ['R-2 ownerOnly', ['org.read', 'org.delete'], 'permission_not_delegable', ['org.delete']],
    ['R-5 missing requires', ['members.role.assign'], 'missing_dependencies', ['members.read', 'roles.read']],
    ['R-6 unknown', ['ghost.read'], 'unknown_permission', ['ghost.read']],
    ['R-7 manage', ['org.manage'], 'unknown_permission', ['org.manage']],
  ] as const)('%s → 422 %s listing the keys', async (_n, permissions, code, keys) => {
    const c = await cast();
    const r = await create(c.O, c.org, { name: `R ${v7()}`, permissions });
    expect([r.status, r.body.code]).toEqual([422, code]);
    expect(r.body.errors.map((e: { message: string }) => e.message)).toEqual(keys);
  });
  it('R-7: a wildcard is not even a permission key → 422 validation_failed', async () => {
    const c = await cast();
    const r = await create(c.O, c.org, { name: 'Star', permissions: ['*'] });
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
  });
  it('R-3: a C1 holder (no roles.write) → 403 forbidden at the guard', async () => {
    const c = await cast();
    expect((await create(c.K, c.org, { name: 'x', permissions: ['org.read'] })).body.code).toBe('forbidden');
  });
  it('R-4: CW creating a role with a key it lacks (C2) → 403 escalation_denied; R-15: CW creating its own set → 403 escalation_denied; an ADMIN creating the ADMIN set → 403 owner_only', async () => {
    const c = await cast();
    expect((await create(c.W, c.org, { name: 'C2', permissions: ROLE_SET_C2 })).body.code).toBe('escalation_denied');
    expect((await create(c.W, c.org, { name: 'Clone', permissions: CW })).body.code).toBe('escalation_denied');
    expect((await create(c.A, c.org, { name: 'Admin clone', permissions: ADMIN_KEYS })).body.code).toBe('owner_only');
  });
  it('R-9: CW editing CW (its own role) → 403 cannot_edit_own_role, even to narrow it', async () => {
    const c = await cast();
    const r = await patch(c.W, c.org, c.cw, { permissions: ROLE_SET_C0 });
    expect([r.status, r.body.code]).toEqual([403, 'cannot_edit_own_role']);
  });
  it('R-10: PATCH or DELETE of a system role → 409 system_role_immutable', async () => {
    const c = await cast();
    expect((await patch(c.O, c.org, c.org.roles.MEMBER.publicId, { name: 'Members' })).body.code).toBe('system_role_immutable');
    expect((await authed(app, c.O).delete(url(c.org, c.org.roles.ADMIN.publicId))).body.code).toBe('system_role_immutable');
  });
  it('R-11 (member part, T-9): deleting a role that a member holds → 409 role_in_use; the role stays', async () => {
    const c = await cast();
    const r = await authed(app, c.O).delete(url(c.org, c.c1));
    expect([r.status, r.body.code]).toEqual([409, 'role_in_use']);
    expect((await authed(app, c.O).get(url(c.org, c.c1))).status).toBe(200);
  });
  it('R-12: CW deleting an unused role larger than C1 → 403 escalation_denied; deleting an unused smaller role → 204 + tenancy.role.deleted', async () => {
    const c = await cast();
    const big = await seedCustomRole(c.org, { permissions: [...CW, 'invitations.read'], name: 'Big' });
    expect((await authed(app, c.W).delete(url(c.org, big))).body.code).toBe('escalation_denied');
    const small = await seedCustomRole(c.org, { permissions: ROLE_SET_C0, name: 'Small' });
    expect((await authed(app, c.W).delete(url(c.org, small))).status).toBe(204);
    expect(await events('tenancy.role.deleted', small.publicId)).toEqual([{ aggregate_version: '2', payload: { roleId: small.publicId } }]);
  });
  it('R-13: a role of org B through the path of org A → 404', async () => {
    const a = await cast();
    const b = await cast();
    expect((await patch(a.O, a.org, b.c1, { name: 'x' })).status).toBe(404);
    expect((await authed(app, a.O).delete(url(a.org, b.c1))).status).toBe(404);
  });
  it('R-14 (API): the owner removes members.read from C1 → the C1 holder loses it on the next request; one tenancy.role.updated with version 2', async () => {
    const c = await cast();
    expect((await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members`)).status).toBe(200);
    const r = await patch(c.O, c.org, c.c1, { permissions: ['org.read', 'roles.read'] });
    expect([r.status, r.headers.etag, r.body.permissions]).toEqual([200, 'W/"2"', ['org.read', 'roles.read']]);
    expect((await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members`)).status).toBe(403);
    expect(await events('tenancy.role.updated', c.c1.publicId)).toEqual([{ aggregate_version: '2', payload: { roleId: c.c1.publicId, permissions: ['org.read', 'roles.read'] } }]);
  });
  it('R-16: an ADMIN narrowing V ≡ ADMIN held by Bob → 403 owner_only; Bob keeps members.remove', async () => {
    const c = await cast();
    expect((await patch(c.A, c.org, c.v, { permissions: ROLE_SET_C0 })).body.code).toBe('owner_only');
    expect((await authed(app, c.Bob).get(url(c.org, c.v))).body.permissions).toEqual(ADMIN_KEYS);
  });
  it('R-17: CW narrowing a role larger than itself → 403 escalation_denied', async () => {
    const c = await cast();
    const big = await seedCustomRole(c.org, { permissions: [...CW, 'invitations.read'], name: 'Big2' });
    expect((await patch(c.W, c.org, big, { permissions: ROLE_SET_C0 })).body.code).toBe('escalation_denied');
  });
  it('R-20: PATCH, POST and DELETE of roles with a stale session → 403 reauthentication_required', async () => {
    const c = await cast({ sessionAgeSec: STALE_SEC });
    expect((await patch(c.O, c.org, c.c1, { name: 'Stale' })).body.code).toBe('reauthentication_required');
    expect((await create(c.O, c.org, { name: 'Stale', permissions: ['org.read'] })).body.code).toBe('reauthentication_required');
    expect((await authed(app, c.O).delete(url(c.org, c.cw))).body.code).toBe('reauthentication_required');
  });

  describe('Review Focus', () => {
    it('1: role names are case-insensitive per org, trimmed and counted in code points', async () => {
      const c = await cast();
      expect((await create(c.O, c.org, { name: 'Billing', permissions: [] })).status).toBe(201);
      expect((await create(c.O, c.org, { name: 'BILLING', permissions: [] })).body.code).toBe('role_name_taken');
      const other = await cast();
      expect((await create(other.O, other.org, { name: 'BILLING', permissions: [] })).status).toBe(201);
      expect((await create(c.O, c.org, { name: ' Spaced', permissions: [] })).body.code).toBe('validation_failed');
      expect((await create(c.O, c.org, { name: '😀'.repeat(64), permissions: [] })).status).toBe(201);
      expect((await create(c.O, c.org, { name: '😀'.repeat(65), permissions: [] })).body.code).toBe('validation_failed');
    });
    it('2: a PATCH that changes nothing (same set in another order, duplicates, same name) keeps the version and publishes no event', async () => {
      const c = await cast();
      // Cùng tập C1, thứ tự đảo, lặp một key.
      const r = await patch(c.O, c.org, c.c1, { name: 'C1', permissions: [...[...C1].reverse(), C1[0]] });
      expect([r.status, r.headers.etag]).toEqual([200, 'W/"1"']);
      expect(await events('tenancy.role.updated', c.c1.publicId)).toEqual([]);
    });
    it('3: If-Match on PATCH roles: missing 428, stale 412, "1" and W/"1" accepted; description null clears it', async () => {
      const c = await cast();
      expect((await authed(app, c.O).patch(url(c.org, c.c1)).send({ name: 'x' })).status).toBe(428);
      expect((await patch(c.O, c.org, c.c1, { name: 'Renamed' }, '"7"')).status).toBe(412);
      const ok = await patch(c.O, c.org, c.c1, { description: 'Temp' }, 'W/"1"');
      expect([ok.status, ok.headers.etag]).toEqual([200, 'W/"2"']);
      const cleared = await patch(c.O, c.org, c.c1, { description: null }, '"2"');
      expect([cleared.status, cleared.body.description]).toEqual([200, null]);
      expect((await patch(c.O, c.org, c.c1, { name: null })).body.code).toBe('validation_failed');
    });
    it('4: an empty role is allowed and grants nothing', async () => {
      const c = await cast();
      const r = await create(c.O, c.org, { name: 'Nothing', permissions: [] });
      expect([r.status, r.body.permissions]).toEqual([201, []]);
      const p = await seedP();
      // `org_roles` là FORCE RLS: id nội bộ đọc bằng app_user trong OrgScope của org (owner thấy 0 dòng).
      const [row] = await withAppClient((db) => inOrgTx(db, c.org.orgId, async () => (await db.query<{ id: string }>(`SELECT id::text AS id FROM org_roles WHERE public_id = $1`, [r.body.id])).rows));
      await seedMemberInRole(c.org, { id: row!.id, publicId: r.body.id, name: 'Nothing' }, { authUserId: p.authUserId });
      expect((await authed(app, p).get(`/v1/orgs/${c.org.orgId}/members/me`)).status).toBe(200);
      expect((await authed(app, p).get(`/v1/orgs/${c.org.orgId}`)).body.code).toBe('forbidden');
    });
    it('5: role ids that are not UUIDs are 404, never 500', async () => {
      const c = await cast();
      expect((await authed(app, c.O).get(url(c.org, 'not-a-uuid'))).status).toBe(404);
      expect((await patch(c.O, c.org, 'not-a-uuid', { name: 'x' })).status).toBe(404);
      expect((await authed(app, c.O).delete(url(c.org, 'not-a-uuid'))).status).toBe(404);
    });
  });
});
```
(`outbox_events` không có RLS và thuộc app_owner nên `events()` đọc bằng `ownerQuery` là đúng.)

Run: `pnpm vitest run --project integration test/e2e/tenancy/roles.e2e.spec.ts`
Expected: trước Step 3–4 FAIL (`404` route chưa có); sau: PASS mọi ca.

- [ ] **Step 6: OpenAPI, kiểm toàn cục, commit**

Run:
```bash
pnpm build && pnpm openapi:export && git diff --stat openapi.json
pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/tenancy
```
Expected: đúng 3 operation mới (`POST …/roles`, `PATCH …/roles/{roleId}`, `DELETE …/roles/{roleId}`), hai operation đọc không đổi hình dạng; `OrgRouteInventory` (G-1, G-8) cho khởi động: ba route ghi mang `@SensitiveTenancyAction()`, `NARROWING_ROUTES` không đổi; e2e tenancy xanh.
```bash
git add src/modules/tenancy openapi.json test/unit/modules/tenancy/errors.spec.ts test/e2e/tenancy/roles.e2e.spec.ts
git commit -m "feat(tenancy): create, edit and delete custom roles under rules 1, 2a and 6 with tenancy.role events"
```

---
## Phần E — Ma trận leo quyền với role tuỳ biến, race, chaos (spec §17, §18.2–§18.4)

### Task 7: Gán và quản lý bằng role tuỳ biến qua API — B-1, B-2, B-3, B-7, B-19, B-22, B-23, B-24 (đường trực tiếp), R-8, R-19 với quyền fixture `payroll.read`

**Files:**
- Create (test): `test/e2e/tenancy/fixtures/payroll-permissions.ts`, `test/e2e/tenancy/custom-role-assignment.e2e.spec.ts`

**Interfaces:**
- Consumes: `definePermissionCatalogue`, `PermissionCatalogueContributor` (tenancy `index.ts`, 3A Task 19/21), `PermissionCatalogueRegistry` (3A Task 19), `ownerQuery` (SP2), `startTenancyApp({ extraImports })`, `authed` (3A Task 22), `seedCustomRole`, `seedMemberInRole`, `ROLE_SET_C0`, `ROLE_SET_C2`, `roleSetC1`, `adminKeys` (Task 3), route role (Task 6).
- Produces (test support): `PayrollPermissions` (catalogue fixture một key `payroll.read`, `grantTo.admin = false`, không `ownerOnly`), `PayrollPermissionsModule`, `installPayrollPermission()`, `removePayrollPermission()`, `permissionRowCount()`.

- [ ] **Step 1: Catalogue fixture `payroll`**

Catalogue v1 không có quyền nào vừa không cấp cho ADMIN vừa không `ownerOnly` (mọi key ngoài `A` đều `ownerOnly`), nên role "X = ADMIN ∪ {…}" của spec §18.3 chỉ dựng được bằng quyền fixture. `CatalogueCheck` so DB với catalogue gộp lúc boot: key có trong code mà thiếu dòng DB vẫn là FATAL, nên dòng DB phải có TRƯỚC khi app nạp `PayrollPermissionsModule` khởi động; dòng chỉ có ở DB chỉ là WARN (R-X21, 3A Task 20b), nhưng file vẫn xoá nó sau khi app đóng và khẳng định số dòng `permissions` trở lại đúng như trước file (đọc lúc `beforeAll`, không ghi số cứng: plan khác của sóng W2 thêm dòng của mình, R-X24). Project `integration` chạy file tuần tự (`vitest.config.ts`: `fileParallelism: false`), nên không file nào khác boot khi dòng này tồn tại. Task 7b dùng lại fixture này để dựng key orphan (dòng DB có, catalogue không nạp).

`test/e2e/tenancy/fixtures/payroll-permissions.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { PermissionCatalogueContributor, definePermissionCatalogue } from '../../../../src/modules/tenancy/index.js';
import { ownerQuery } from '../../../support/identity-app.js';

/** Spec SP3 §18.3 "X": quyền fixture `grantTo.admin = false`, không ownerOnly. */
export const PayrollPermissions = definePermissionCatalogue('payroll', {
  'payroll.read': { resource: 'payroll', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: false, member: false } },
});

@Injectable()
@PermissionCatalogueContributor(PayrollPermissions)
export class PayrollCatalogue {}

@Module({ providers: [PayrollCatalogue] })
export class PayrollPermissionsModule {}

export const installPayrollPermission = () =>
  ownerQuery(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('payroll', 'read', false, false, false) ON CONFLICT ON CONSTRAINT permissions_key_uq DO NOTHING`);
/** Gọi SAU khi mọi org có role giữ `payroll.read` đã dispose (FK RESTRICT) và app đã đóng. */
export const removePayrollPermission = () => ownerQuery(`DELETE FROM permissions WHERE key = 'payroll.read'`);
/** Số dòng `permissions` của DB test: đọc trước khi cài fixture, khẳng định lại sau khi gỡ (không ghi số cứng, R-X24). */
export const permissionRowCount = async (): Promise<number> =>
  Number((await ownerQuery<{ n: string }>('SELECT count(*)::text AS n FROM permissions'))[0]?.n);
```

- [ ] **Step 2: E2E (viết, chạy)**

`test/e2e/tenancy/custom-role-assignment.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  ROLE_SET_C2,
  adminKeys,
  roleSetC1,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';
import { PayrollPermissionsModule, installPayrollPermission, permissionRowCount, removePayrollPermission } from './fixtures/payroll-permissions.js';

describe('assigning and managing with custom roles (spec SP3 §8.4 luật 2, 2a, 4; §18.3 B-*, R-8, R-19)', () => {
  let app: INestApplication;
  /** Tính từ catalogue gộp của app lúc chạy (R-X24); `payroll.read` không thuộc ADMIN (`grantTo.admin = false`). */
  let ADMIN_KEYS: string[];
  let C1: string[];
  let permissionRowsBefore: number;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  /** O owner, A admin, M member, K giữ C1, Bob giữ V ≡ ADMIN, Xp giữ X = ADMIN ∪ {payroll.read}; V′ ≡ ADMIN chưa ai giữ. */
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const roles = {
      c0: await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'C0' }),
      c1: await seedCustomRole(org, { permissions: C1, name: 'C1' }),
      c2: await seedCustomRole(org, { permissions: ROLE_SET_C2, name: 'C2' }),
      v: await seedCustomRole(org, { permissions: ADMIN_KEYS, name: 'V' }),
      vPrime: await seedCustomRole(org, { permissions: ADMIN_KEYS, name: 'V prime' }),
      x: await seedCustomRole(org, { permissions: [...ADMIN_KEYS, 'payroll.read'], name: 'X' }),
    };
    const person = async (role: SeededRole | 'ADMIN' | 'MEMBER') => {
      const p = await seedP();
      const m = typeof role === 'string' ? await seedMember(org, role, { authUserId: p.authUserId }) : await seedMemberInRole(org, role, { authUserId: p.authUserId });
      return { p, memberId: m.memberPublicId };
    };
    return { org, O, roles, A: await person('ADMIN'), M: await person('MEMBER'), K: await person(roles.c1), Bob: await person(roles.v), X: await person(roles.x) };
  };
  const assign = (as: SeededPrincipal, org: SeededOrg, memberId: string, roleId: string) =>
    authed(app, as).patch(`/v1/orgs/${org.orgId}/members/${memberId}`).set('if-match', '*').send({ roleId });
  const remove = (as: SeededPrincipal, org: SeededOrg, memberId: string) => authed(app, as).delete(`/v1/orgs/${org.orgId}/members/${memberId}`);
  const expectCode = async (req: PromiseLike<{ status: number; body: { code?: string } }>, status: number, code?: string) => {
    const r = await req;
    expect([r.status, r.body.code]).toEqual([status, code]);
  };

  beforeAll(async () => {
    permissionRowsBefore = await permissionRowCount();
    await installPayrollPermission();
    app = await startTenancyApp({ extraImports: [PayrollPermissionsModule] });
    const merged = app.get(PermissionCatalogueRegistry).merged();
    ADMIN_KEYS = adminKeys(merged);
    C1 = roleSetC1(merged);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await removePayrollPermission();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    // DB trở lại đúng như trước file (file sau boot không thấy `payroll.read`).
    expect(await permissionRowCount()).toBe(permissionRowsBefore);
  });

  it('B-1: an ADMIN assigns C1 to a member → 200', async () => {
    const c = await cast();
    await expectCode(assign(c.A.p, c.org, c.M.memberId, c.roles.c1.publicId), 200, undefined);
  });
  it('B-2: C1 assigns C2 (has a key C1 lacks) → 403 escalation_denied; B-3: C1 assigns ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(assign(c.K.p, c.org, c.M.memberId, c.roles.c2.publicId), 403, 'escalation_denied');
    await expectCode(assign(c.K.p, c.org, c.M.memberId, c.org.roles.ADMIN.publicId), 403, 'owner_only');
  });
  it('B-7: C1 changes the role of an ADMIN → 403 owner_only; C1 removing an ADMIN → 403 (C1 lacks members.remove)', async () => {
    const c = await cast();
    await expectCode(assign(c.K.p, c.org, c.A.memberId, c.roles.c0.publicId), 403, 'owner_only');
    expect((await remove(c.K.p, c.org, c.A.memberId)).status).toBe(403);
  });
  it('B-19: an ADMIN assigns a custom role equal to ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(assign(c.A.p, c.org, c.M.memberId, c.roles.vPrime.publicId), 403, 'owner_only');
  });
  it('B-22 (direct paths): X assigns ADMIN, demotes or removes an ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(assign(c.X.p, c.org, c.M.memberId, c.org.roles.ADMIN.publicId), 403, 'owner_only');
    await expectCode(assign(c.X.p, c.org, c.A.memberId, c.org.roles.MEMBER.publicId), 403, 'owner_only');
    await expectCode(remove(c.X.p, c.org, c.A.memberId), 403, 'owner_only');
  });
  it('B-23 (direct): X assigns V′ ≡ ADMIN (created by the owner) → 403 owner_only; the owner can', async () => {
    const c = await cast();
    await expectCode(assign(c.X.p, c.org, c.M.memberId, c.roles.vPrime.publicId), 403, 'owner_only');
    await expectCode(assign(c.O, c.org, c.M.memberId, c.roles.vPrime.publicId), 200, undefined);
  });
  it('B-24 (demote/remove): X demotes or removes Bob who holds V ≡ ADMIN → 403 owner_only', async () => {
    const c = await cast();
    await expectCode(assign(c.X.p, c.org, c.Bob.memberId, c.roles.c0.publicId), 403, 'owner_only');
    await expectCode(remove(c.X.p, c.org, c.Bob.memberId), 403, 'owner_only');
  });
  it('R-8: an ADMIN adding a key it lacks (payroll.read) to a role → 403 escalation_denied', async () => {
    const c = await cast();
    const r = await authed(app, c.A.p).patch(`/v1/orgs/${c.org.orgId}/roles/${c.roles.c0.publicId}`).set('if-match', '*').send({ permissions: ['org.read', 'payroll.read'] });
    expect([r.status, r.body.code]).toEqual([403, 'escalation_denied']);
  });
  it('R-19: X creates a role equal to (or above) ADMIN, edits or deletes V′ → 403 owner_only; the owner does the same → 201/200/204', async () => {
    const c = await cast();
    const post = (as: SeededPrincipal, permissions: string[]) =>
      authed(app, as).post(`/v1/orgs/${c.org.orgId}/roles`).set('idempotency-key', `k-${v7()}`).send({ name: `R19 ${v7()}`, permissions });
    const url = `/v1/orgs/${c.org.orgId}/roles/${c.roles.vPrime.publicId}`;
    await expectCode(post(c.X.p, ADMIN_KEYS), 403, 'owner_only');
    await expectCode(post(c.X.p, [...ADMIN_KEYS, 'payroll.read']), 403, 'owner_only');
    await expectCode(authed(app, c.X.p).patch(url).set('if-match', '*').send({ permissions: ROLE_SET_C0 }), 403, 'owner_only');
    await expectCode(authed(app, c.X.p).delete(url), 403, 'owner_only');
    expect((await post(c.O, ADMIN_KEYS)).status).toBe(201);
    expect((await authed(app, c.O).patch(url).set('if-match', '*').send({ name: 'V prime renamed' })).status).toBe(200);
    expect((await authed(app, c.O).delete(url)).status).toBe(204);
  });
  it('Review Focus 5: a role id of another org is not assignable → 422 validation_failed', async () => {
    const a = await cast();
    const b = await cast();
    await expectCode(assign(a.O, a.org, a.M.memberId, b.roles.c0.publicId), 422, 'validation_failed');
  });
});
```
Run: `pnpm vitest run --project integration test/e2e/tenancy/custom-role-assignment.e2e.spec.ts`
Expected: PASS; `afterAll` khẳng định số dòng `permissions` trở lại đúng số đọc lúc `beforeAll` (không phải một số cứng: 4A/7A của sóng W2 có thể đã thêm dòng của mình).

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write test/e2e/tenancy/fixtures/payroll-permissions.ts test/e2e/tenancy/custom-role-assignment.e2e.spec.ts
pnpm typecheck && pnpm lint
git add test/e2e/tenancy/fixtures/payroll-permissions.ts test/e2e/tenancy/custom-role-assignment.e2e.spec.ts
git commit -m "test(tenancy): set-based escalation matrix with custom roles through the API, including an admin-plus role from a fixture catalogue"
```

---

### Task 7b: Key orphan trên role tuỳ biến (R-X23) — đường nóng bỏ qua + WARN + metric, sửa role gỡ được, không thêm lại được

R-X23 giao 3B cài và test cả hai điểm. Code đã có ở Task 5 (`customRolePermissions`, `RolePermissions.reportOrphan`) và Task 6 (`RoleService.update` gỡ orphan, `validated` từ chối key không có trong catalogue gộp); task này chứng minh chúng qua HTTP thật với đúng kịch bản "module bị tắt": dòng `permissions` của `payroll.read` có trong DB, role tuỳ biến giữ nó, nhưng app KHÔNG nạp catalogue `payroll`.

**Files:**
- Create (test): `test/e2e/tenancy/orphan-permission-keys.e2e.spec.ts`

**Interfaces:**
- Consumes: `installPayrollPermission`, `removePayrollPermission`, `permissionRowCount` (Task 7), boot WARN cho key chỉ có ở DB (R-X21, 3A Task 20b), `RolePermissions` (Task 5), route role (Task 6), `installOtelCapture` (SP1 `test/support/otel-capture.ts`), `seedCustomRole`, `seedMemberInRole`, `withAppClient`, `inOrgTx` (Task 3, 3A Task 14), `startTenancyApp`, `authed` (3A Task 22).
- Produces: bằng chứng R-X23 (đường nóng, sửa role) trên app thật.

- [ ] **Step 1: E2E (viết, chạy)**

`test/e2e/tenancy/orphan-permission-keys.e2e.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { inOrgTx, seedCustomRole, seedMemberInRole, seedOrg, withAppClient, type SeededOrg, type SeededRole } from '../../support/tenancy-seed.js';
import { installPayrollPermission, permissionRowCount, removePayrollPermission } from './fixtures/payroll-permissions.js';

/** Một lần mỗi file, trước khi app tạo meter (TenancyMetrics lấy meter từ provider toàn cục lúc khởi tạo). */
const otel = installOtelCapture();
const ORPHAN = 'payroll.read';
const ORPHAN_METRIC = 'tenancy_catalogue_orphan_keys';

const isOrphanWarn = (payload: unknown): boolean =>
  typeof payload === 'object' && payload !== null && 'event' in payload && payload.event === 'orphan_permission_ignored' && 'key' in payload && payload.key === ORPHAN;

/**
 * R-X23 (+ R-X21 của 3A Task 20b): module có quyền `payroll.read` bị tắt — dòng `permissions` và dòng quyền của role tuỳ
 * biến ở lại DB, app không nạp catalogue `payroll`. Boot chỉ WARN; đường nóng bỏ qua key (không 500, không cấp gì, WARN +
 * metric một lần); sửa role gỡ được key; thêm lại → 422 unknown_permission.
 */
describe('orphan permission keys on custom roles (R-X23)', () => {
  let app: INestApplication;
  let permissionRowsBefore: number;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  /** Role `Pay` = {org.read, members.read, payroll.read} seed thẳng bằng SQL (API không cấp được key orphan); K giữ nó. */
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const pay = await seedCustomRole(org, { permissions: ['org.read', 'members.read', ORPHAN], name: `Pay ${v7()}` });
    const K = await seedP();
    await seedMemberInRole(org, pay, { authUserId: K.authUserId });
    return { O, K, org, pay };
  };
  const roleUrl = (org: SeededOrg, role?: SeededRole) => `/v1/orgs/${org.orgId}/roles${role ? `/${role.publicId}` : ''}`;
  const patch = (as: SeededPrincipal, org: SeededOrg, role: SeededRole, body: object) => authed(app, as).patch(roleUrl(org, role)).set('if-match', '*').send(body);
  /** Key đã lưu của role, gồm cả orphan (đọc bằng app_user trong OrgScope, bỏ qua catalogue của app). */
  const storedKeys = (org: SeededOrg, role: SeededRole) =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, async () =>
        (await c.query<{ key: string }>(`SELECT p.key FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY p.key`, [role.id])).rows.map((r) => r.key),
      ),
    );

  beforeAll(async () => {
    permissionRowsBefore = await permissionRowCount();
    await installPayrollPermission();
    // KHÔNG có PayrollPermissionsModule: `payroll.read` chỉ có ở DB → orphan; boot WARN (R-X21), không từ chối.
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose(); // xoá dòng quyền trước (FK RESTRICT của permissions)
    await app?.close();
    await removePayrollPermission();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    expect(await permissionRowCount()).toBe(permissionRowsBefore);
  });

  it('hot path: the holder is not a 500, keeps its catalogue keys, gets nothing from the orphan; one WARN and one metric increment per process', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const metricBefore = (await otel.metric(ORPHAN_METRIC)) ?? 0; // boot của 20b có thể đã cộng cho cùng key
      const c = await cast();
      expect((await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members`)).status).toBe(200);
      expect((await authed(app, c.K).get(`/v1/orgs/${c.org.orgId}/members/me`)).status).toBe(200);
      const role = await authed(app, c.O).get(roleUrl(c.org, c.pay));
      expect([role.status, role.body.permissions]).toEqual([200, ['members.read', 'org.read']]);
      expect(warn.mock.calls.filter(([payload]) => isOrphanWarn(payload))).toHaveLength(1);
      expect(await otel.metric(ORPHAN_METRIC)).toBe(metricBefore + 1);
    } finally {
      warn.mockRestore();
    }
  });
  it('a PATCH with permissions removes the orphan even when the granted set is unchanged → 200, version 2', async () => {
    const c = await cast();
    const r = await patch(c.O, c.org, c.pay, { permissions: ['org.read', 'members.read'] });
    expect([r.status, r.headers.etag, r.body.permissions]).toEqual([200, 'W/"2"', ['members.read', 'org.read']]);
    expect(await storedKeys(c.org, c.pay)).toEqual(['members.read', 'org.read']);
  });
  it('a PATCH without permissions (rename) leaves the stored orphan alone', async () => {
    const c = await cast();
    expect((await patch(c.O, c.org, c.pay, { name: `Renamed ${v7()}` })).status).toBe(200);
    expect(await storedKeys(c.org, c.pay)).toEqual(['members.read', 'org.read', ORPHAN]);
  });
  it('adding the orphan key (PATCH or POST) → 422 unknown_permission listing it; nothing stored changes', async () => {
    const c = await cast();
    const r = await patch(c.O, c.org, c.pay, { permissions: ['org.read', 'members.read', ORPHAN] });
    expect([r.status, r.body.code, r.body.errors.map((e: { message: string }) => e.message)]).toEqual([422, 'unknown_permission', [ORPHAN]]);
    expect(await storedKeys(c.org, c.pay)).toEqual(['members.read', 'org.read', ORPHAN]);
    const created = await authed(app, c.O).post(roleUrl(c.org)).set('idempotency-key', `k-${v7()}`).send({ name: `New ${v7()}`, permissions: ['org.read', ORPHAN] });
    expect([created.status, created.body.code]).toEqual([422, 'unknown_permission']);
  });
  it('an unused role that holds an orphan key deletes → 204 (its rows cascade)', async () => {
    const c = await cast();
    const spare = await seedCustomRole(c.org, { permissions: ['org.read', ORPHAN], name: `Spare ${v7()}` });
    expect((await authed(app, c.O).delete(roleUrl(c.org, spare))).status).toBe(204);
    expect(await storedKeys(c.org, spare)).toEqual([]);
  });
});
```
Ghi chú:
- "Gỡ luôn được" nghĩa là key orphan không bao giờ chặn việc sửa (không 500, không 422); luật 1/2a vẫn áp lên tập ĐÃ CẤP (orphan không cấp gì nên không tính vào tập cũ). Owner ở đây nên không có luật nào từ chối.
- `metricBefore` đọc SAU boot: nếu Task 20b cộng cùng counter lúc boot cho `payroll.read`, delta của đường nóng vẫn đúng 1.
- Ca đầu tiên chạy trước mọi ca khác của file (Vitest chạy `it` theo thứ tự khai báo), nên lần WARN duy nhất của key trong process rơi đúng vào nó; ba request trong ca chứng minh "một lần mỗi process".

Run: `pnpm vitest run --project integration test/e2e/tenancy/orphan-permission-keys.e2e.spec.ts`
Expected: PASS. Kiểm đột biến một lần: tạm đổi nhánh `if (!entry) orphans.add(key)` của `customRolePermissions` thành `throw new UnknownPermissionError(key)` → ca đầu đỏ (`500` thay vì `200`) và ca PATCH đỏ; trả lại, xanh. Ghi lần đỏ này vào mô tả commit.

- [ ] **Step 2: Commit**

```bash
pnpm exec prettier --write test/e2e/tenancy/orphan-permission-keys.e2e.spec.ts
pnpm typecheck && pnpm lint
git add test/e2e/tenancy/orphan-permission-keys.e2e.spec.ts
git commit -m "test(tenancy): orphan permission keys on custom roles are ignored on the hot path, removable and never re-grantable (R-X23)"
```

---

### Task 8: Race có khoá org — X-1, X-2 (T-8), X-3 (T-9 phần member), X-4 (T-10, role tuỳ biến của actor), X-5 với role tuỳ biến (T-24), trùng tên và cùng ETag

**Files:**
- Create (test): `test/support/org-lock-barrier.ts`, `test/e2e/tenancy/role-races.e2e.spec.ts`
- Modify (test): `test/e2e/tenancy/member-toctou.e2e.spec.ts` (X-4 với role tuỳ biến của actor)

**Interfaces:**
- Consumes: `withAppClient`, `seedOrg`, `seedMember`, `seedCustomRole`, `seedMemberInRole`, `ROLE_SET_C0`, `roleSetC1` (3A Task 14, Task 3), `PermissionCatalogueRegistry` (3A Task 19), `ownerQuery` (SP2), `prng` (3A), bảng fixture `fixture_org_items` (3A Task 14), route role (Task 6), `test/e2e/tenancy/member-toctou.e2e.spec.ts` + `ScriptedHooks` (3A Task 24, seam `TenancyTestHooks.afterGuard`).
- Produces: `raceOnOrgLock<T>(orgId: string, waiters: number, fire: () => Promise<T>): Promise<T>` — barrier của spec §18.0 (INT2-N-5): một kết nối `app_user` giữ `SELECT … FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, `fire()` gửi các request, test chờ tới khi đúng `waiters` backend bị chính kết nối đó chặn (`pg_blocking_pids`, có hạn chót), rồi COMMIT để thả cùng lúc.

- [ ] **Step 1: Barrier**

`test/support/org-lock-barrier.ts`:
```ts
import { ownerQuery } from './identity-app.js';
import { withAppClient } from './tenancy-seed.js';

const POLL_MS = 20;
const DEADLINE_MS = 10_000;

/**
 * Spec SP3 §18.0 (INT2-N-5): mutation quản trị xếp hàng ở bước khoá org (§8.6 bước 1). Test giữ khoá dòng org trên kết
 * nối riêng; chờ tới khi đúng `waiters` backend bị kết nối đó chặn (lọc bằng `pg_blocking_pids`, không đếm khoá của test
 * khác), rồi COMMIT để thả tất cả cùng lúc. Quá hạn chót → ném, không treo.
 */
export async function raceOnOrgLock<T>(orgId: string, waiters: number, fire: () => Promise<T>): Promise<T> {
  return withAppClient(async (holder) => {
    await holder.query('BEGIN');
    let pending: Promise<T> | undefined;
    try {
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      await holder.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgId]);
      const [{ pid } = { pid: -1 }] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      pending = fire();
      pending.catch(() => undefined); // lỗi được ném lại khi await bên dưới; tránh unhandled rejection trong lúc chờ
      const until = Date.now() + DEADLINE_MS;
      for (;;) {
        const [row] = await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
        if ((row?.n ?? 0) >= waiters) break;
        if (Date.now() > until) throw new Error(`barrier: ${row?.n ?? 0} of ${waiters} transactions queued on the org lock`);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      await holder.query('COMMIT');
    } catch (err) {
      await holder.query('ROLLBACK');
      throw err;
    }
    return pending;
  });
}
```

- [ ] **Step 2: E2E race**

`test/e2e/tenancy/role-races.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ROLE_SET_C0, inOrgTx, roleSetC1, seedCustomRole, seedMember, seedMemberInRole, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';
import { prng } from '../../unit/modules/tenancy/prng.js';

const ROUNDS = 20;
const X5_OPS = 20;
const INSERT_BUDGET_MS = 1000;

describe('role races under the org lock (spec SP3 §17 T-8, T-9, T-24; §18.3 X-1, X-2, X-3, X-5)', () => {
  let app: INestApplication;
  /** C1 = MEMBER ∪ {members.role.assign} của catalogue gộp thật (R-X24): ở X-2, Y = C1 ∪ {members.remove} phải trội MEMBER để chỉ luật 2 quyết định. */
  let C1: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const newOrg = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    return { O, org };
  };
  const assign = (as: SeededPrincipal, org: SeededOrg, memberId: string, roleId: string) =>
    authed(app, as).patch(`/v1/orgs/${org.orgId}/members/${memberId}`).set('if-match', '*').send({ roleId });
  const outboxId = async (type: string, aggregateId: string) =>
    BigInt((await ownerQuery<{ id: string }>(`SELECT id::text FROM outbox_events WHERE type = $1 AND aggregate_id = $2 ORDER BY id DESC LIMIT 1`, [type, aggregateId]))[0]?.id ?? '0');
  /** Không role tuỳ biến nào của org thiếu quyền mà nó `requires` (đọc bằng app_user trong OrgScope). */
  const openSets = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(c, orgId, async () =>
        (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_role_permissions s JOIN permission_requires r ON r.permission_id = s.permission_id
          WHERE NOT EXISTS (SELECT 1 FROM org_role_permissions t WHERE t.org_id = s.org_id AND t.role_id = s.role_id AND t.permission_id = r.required_permission_id)`)).rows[0]?.n,
      ),
    );
  const owners = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(c, orgId, async () =>
        Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`)).rows[0]?.n),
      ),
    );
  beforeAll(async () => {
    app = await startTenancyApp({ env: { THROTTLE_DEFAULT_LIMIT: '100000' } });
    C1 = roleSetC1(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`X-1 ×${ROUNDS}: the owner demotes A2 while A2 assigns C1 → A2's assignment never commits after it lost members.role.assign`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { O, org } = await newOrg();
      const c1 = await seedCustomRole(org, { permissions: C1 });
      const A2 = await seedP();
      const a2 = await seedMember(org, 'ADMIN', { authUserId: A2.authUserId });
      const m = await seedMember(org, 'MEMBER', { authUserId: (await seedP()).authUserId });
      const [demote, give] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([assign(O, org, a2.memberPublicId, org.roles.MEMBER.publicId), assign(A2, org, m.memberPublicId, c1.publicId)]),
      );
      expect(demote.status).toBe(200);
      expect([200, 403]).toContain(give.status);
      if (give.status === 200)
        expect(await outboxId('tenancy.member.role_changed', m.memberPublicId)).toBeLessThan(await outboxId('tenancy.member.role_changed', a2.memberPublicId));
    }
  }, 180_000);
  it(`X-2 / T-8 ×${ROUNDS}: the owner adds a key to C1 that the assigner lacks while it assigns C1 → never both on the widened set`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { O, org } = await newOrg();
      const c1 = await seedCustomRole(org, { permissions: C1 });
      const y = await seedCustomRole(org, { permissions: [...C1, 'members.remove'] });
      const Y = await seedP();
      await seedMemberInRole(org, y, { authUserId: Y.authUserId });
      const m = await seedMember(org, 'MEMBER', { authUserId: (await seedP()).authUserId });
      const [edit, give] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          authed(app, O).patch(`/v1/orgs/${org.orgId}/roles/${c1.publicId}`).set('if-match', '*').send({ permissions: [...C1, 'invitations.read'] }),
          assign(Y, org, m.memberPublicId, c1.publicId),
        ]),
      );
      expect(edit.status).toBe(200);
      expect([give.status, give.body.code]).toEqual(give.status === 200 ? [200, undefined] : [403, 'escalation_denied']);
      if (give.status === 200)
        expect(await outboxId('tenancy.member.role_changed', m.memberPublicId)).toBeLessThan(await outboxId('tenancy.role.updated', c1.publicId));
    }
  }, 180_000);
  it(`X-3 / T-9 ×${ROUNDS}: deleting C1 while assigning it → one side fails with a code, never an orphan`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { O, org } = await newOrg();
      const c1 = await seedCustomRole(org, { permissions: C1 });
      const m = await seedMember(org, 'MEMBER', { authUserId: (await seedP()).authUserId });
      const [del, give] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([authed(app, O).delete(`/v1/orgs/${org.orgId}/roles/${c1.publicId}`), assign(O, org, m.memberPublicId, c1.publicId)]),
      );
      const outcome = [del.status, give.status, give.body.code ?? del.body.code];
      expect([[204, 422, 'validation_failed'], [409, 200, 'role_in_use']]).toContainEqual(outcome);
    }
  }, 180_000);
  it('R3B-2: two creates with the same name at once → one 201, one 409 role_name_taken', async () => {
    const { O, org } = await newOrg();
    const name = `Twin ${v7()}`;
    const post = () => authed(app, O).post(`/v1/orgs/${org.orgId}/roles`).set('idempotency-key', `k-${v7()}`).send({ name, permissions: ROLE_SET_C0 });
    const rs = await raceOnOrgLock(org.orgId, 2, () => Promise.all([post(), post()]));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)?.body.code).toBe('role_name_taken');
  });
  it('R3B-3: two PATCHes with the same ETag → one 200, one 412', async () => {
    const { O, org } = await newOrg();
    const c0 = await seedCustomRole(org, { permissions: ROLE_SET_C0 });
    const put = (name: string) => authed(app, O).patch(`/v1/orgs/${org.orgId}/roles/${c0.publicId}`).set('if-match', '"1"').send({ name });
    const rs = await raceOnOrgLock(org.orgId, 2, () => Promise.all([put('First'), put('Second')]));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 412]);
  });
  it(`X-5 / T-24 with custom roles: ${X5_OPS} random role edits and assignments at once — no deadlock, no 5xx, ≥ 1 owner, every set closed, feature INSERTs not blocked`, async () => {
    const { O, org } = await newOrg();
    const O2 = await seedP();
    const o2 = await seedMember(org, 'OWNER', { authUserId: O2.authUserId });
    const c0 = await seedCustomRole(org, { permissions: ROLE_SET_C0 });
    const c1 = await seedCustomRole(org, { permissions: C1 });
    // O2 cũng là đích: hai owner hạ nhau cùng lúc chạm trigger owner cuối (T-1) trong cùng mớ khoá với role tuỳ biến.
    const targets = [o2];
    for (let i = 0; i < 3; i++) targets.push(await seedMember(org, 'MEMBER', { authUserId: (await seedP()).authUserId }));
    const rnd = prng(20260929);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const ops = Array.from({ length: X5_OPS }, () =>
      rnd() < 0.5
        ? assign(pick([O, O2]), org, pick(targets).memberPublicId, pick([org.roles.ADMIN, org.roles.MEMBER, c0, c1]).publicId)
        : authed(app, pick([O, O2]))
            .patch(`/v1/orgs/${org.orgId}/roles/${pick([c0, c1]).publicId}`)
            .set('if-match', '*')
            .send({ permissions: pick([[...C1], [...C1, 'invitations.read'], ['org.read', 'roles.read', 'invitations.read'], [...ROLE_SET_C0]]) }),
    );
    const inserts = Array.from({ length: 5 }, () =>
      withAppClient((c) =>
        inOrgTx(c, org.orgId, async () => {
          const started = performance.now();
          await c.query('INSERT INTO fixture_org_items (org_id) VALUES ($1)', [org.orgId]);
          return performance.now() - started;
        }),
      ),
    );
    const [responses, latencies] = await Promise.all([Promise.all(ops), Promise.all(inserts)]);
    expect(responses.filter((r) => r.status >= 500).map((r) => r.body)).toEqual([]);
    expect(Math.max(...latencies)).toBeLessThan(INSERT_BUDGET_MS);
    expect(await owners(org.orgId)).toBeGreaterThanOrEqual(1);
    expect(await openSets(org.orgId)).toBe(0);
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [org.orgId])));
  }, 120_000);
});
```
Ghi chú X-1: spec viết "A1 hạ A2", nhưng S3-P1 (luật 2a) cấm admin quản lý admin, nên người hạ là owner (một ADMIN hạ ADMIN luôn `403 owner_only`, không có race để kiểm).

Run: `pnpm vitest run --project integration test/e2e/tenancy/role-races.e2e.spec.ts`
Expected: PASS; không vòng nào treo quá hạn chót của barrier.

- [ ] **Step 3: X-4 / T-10 với role tuỳ biến CỦA ACTOR (seam `afterGuard`)**

X-1 chỉ có actor giữ role hệ thống. Ca này thu hẹp role tuỳ biến mà chính actor đang giữ, giữa `PoliciesGuard` (đường nóng đã thấy `members.role.assign`) và transaction của `MemberService`: lần kiểm trong transaction phải đọc tập MỚI qua `RolePermissions` và từ chối.

`test/e2e/tenancy/member-toctou.e2e.spec.ts` (3A Task 24) — dùng lại `ScriptedHooks`, `hooks`, `app`, `principals` của file; thêm import `PermissionCatalogueRegistry` từ `../../../src/modules/tenancy/application/permission-catalogue.registry.js`, `ROLE_SET_C0`, `roleSetC1`, `seedCustomRole`, `seedMemberInRole` từ `../../support/tenancy-seed.js`, và một ca trong `describe` sẵn có:
```ts
  it('a custom role the actor holds loses members.role.assign after the guard → 403 from the in-transaction check; the target keeps its role', async () => {
    const owner = await seedUserPrincipal();
    const actor = await seedUserPrincipal();
    const target = await seedUserPrincipal();
    principals.push(owner, actor, target);
    const o = await seedOrg({ owner: { authUserId: owner.authUserId } });
    // C1 của catalogue gộp thật (R-X24): trội MEMBER, nên chỉ việc mất members.role.assign mới làm ca này 403.
    const assigner = await seedCustomRole(o, { permissions: roleSetC1(app.get(PermissionCatalogueRegistry).merged()), name: 'Assigner' });
    const c0 = await seedCustomRole(o, { permissions: ROLE_SET_C0, name: 'C0' });
    await seedMemberInRole(o, assigner, { authUserId: actor.authUserId });
    const tm = await seedMember(o, 'MEMBER', { authUserId: target.authUserId });
    // Tập còn lại {org.read, members.read, roles.read, …} vẫn đóng: trigger closure cho COMMIT.
    hooks.next = () =>
      withAppClient((c) =>
        inOrgTx(c, o.orgId, () =>
          c.query(`DELETE FROM org_role_permissions rp USING permissions p WHERE p.id = rp.permission_id AND rp.role_id = $1 AND p.key = 'members.role.assign'`, [assigner.id]),
        ),
      );
    try {
      const r = await authed(app, actor).patch(`/v1/orgs/${o.orgId}/members/${tm.memberPublicId}`).set('if-match', '*').send({ roleId: c0.publicId });
      expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
      expect(hooks.next).toBeUndefined(); // seam đã chạy: guard đã cho qua với tập cũ
      const after = await authed(app, owner).get(`/v1/orgs/${o.orgId}/members/${tm.memberPublicId}`);
      expect(after.body.role).toMatchObject({ id: o.roles.MEMBER.publicId, systemKey: 'MEMBER' });
    } finally {
      hooks.next = undefined;
      await o.dispose();
    }
  });
```
(Nếu file 3A đặt `org` ở mức `describe` và `dispose` trong `afterAll`, ca này dùng biến riêng `o` và tự `dispose` như trên để không ghi đè `org` của ca 3A.)

Run: `pnpm vitest run --project integration test/e2e/tenancy/member-toctou.e2e.spec.ts`
Expected: PASS (ca 3A và ca mới). Kiểm đột biến một lần: tạm cho `ActorReauthorizer.require` dùng lại `ctx.orgAccess().permissions` (tập của guard) thay vì `RolePermissions` → ca mới đỏ (`200`); trả lại, xanh.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/support/org-lock-barrier.ts test/e2e/tenancy/role-races.e2e.spec.ts test/e2e/tenancy/member-toctou.e2e.spec.ts
pnpm typecheck && pnpm lint
git add test/support/org-lock-barrier.ts test/e2e/tenancy/role-races.e2e.spec.ts test/e2e/tenancy/member-toctou.e2e.spec.ts
git commit -m "test(tenancy): barrier-driven races between role edits, deletions and assignments; concurrent names and ETags"
```

---

### Task 9: Chaos và PII của đường lỗi 3B — DB mất giữa mutation role và giữa câu thứ hai của đường nóng (tiêu chí 12), giết api giữa transaction tạo role (tiêu chí 11), log không chứa tên/mô tả role hay credential (tiêu chí 16)

**Files:**
- Create (test): `test/chaos/tenancy-roles-outages.spec.ts`, `test/chaos/tenancy-roles-api-kill.spec.ts`, `test/e2e/tenancy/roles-pii-logs.e2e.spec.ts`

**Interfaces:**
- Consumes: `startTcpProxy`, `type TcpProxy` (SP1/SP2 `test/support/tcp-proxy.ts`), `TenancyTestHooks` (3A Task 19; `RoleService` gọi `afterGuard()`), `SqlRoleRepository` (3A Task 20; `permissionKeys` của Task 5), `Db` (SP1), `startTenancyApp({ env, configure })`, `authed` (3A Task 22), `startAppProcess`, `stopAppProcess`, `type AppProcess` (SP2), `baseTestEnv`, `getInfra`, `exitCode`, `installOtelCapture` (SP1), `ownerQuery`, `seedCustomRole`, `seedMemberInRole`, `roleSetC1`, `TENANCY_ONLY_CATALOGUE` (Task 3), `PermissionCatalogueRegistry` (3A Task 19).
- Produces: bằng chứng tiêu chí 11, 12, 16 cho phần mới của 3B (spec §22.3 Bảng 4).

- [ ] **Step 1: DB mất sau guard, trong transaction của `POST …/roles`; và ĐÚNG ở câu thứ hai của đường nóng (câu membership đã xong)**

`test/chaos/tenancy-roles-outages.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/core/database/index.js';
import { PermissionCatalogueRegistry } from '../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { SqlRoleRepository } from '../../src/modules/tenancy/infra/sql/sql-role.repository.js';
import { TenancyTestHooks } from '../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { installOtelCapture } from '../support/otel-capture.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { authed, startTenancyApp } from '../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { roleSetC1, seedCustomRole, seedMemberInRole, seedOrg, type SeededOrg } from '../support/tenancy-seed.js';

const OUTAGE_BOUND_MS = 20_000;
const RECOVERY = { timeout: 30_000, interval: 250 };
/** Một lần mỗi file, trước khi app tạo meter. */
const otel = installOtelCapture();
const UNAVAILABLE = { via: 'MEMBERSHIP', result: 'unavailable' };

/**
 * Bật blackhole đúng lúc câu thứ hai của đường nóng (spec §7.3) bắt đầu: câu tra membership (câu thứ nhất) đã chạy xong
 * qua proxy, nên lỗi hạ tầng chỉ đến từ câu mới của 3B.
 */
class BlackholeOnPermissionKeys extends SqlRoleRepository {
  armed: TcpProxy | undefined;
  override permissionKeys(roleIds: readonly string[]): Promise<Map<string, string[]>> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return super.permissionKeys(roleIds);
  }
}

/** Bật blackhole đúng một lần ở `afterGuard` (sau `PoliciesGuard`, trước transaction của `RoleService`). */
class BlackholeAfterGuard extends TenancyTestHooks {
  armed: TcpProxy | undefined;
  afterGuard(): Promise<void> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return Promise.resolve();
  }
  beforeRelease(): Promise<void> {
    return Promise.resolve();
  }
}

describe('app DB lost during custom role work (spec SP3 tiêu chí 12, phần 3B)', () => {
  const hooks = new BlackholeAfterGuard();
  let secondStatement: BlackholeOnPermissionKeys | undefined;
  let proxy: TcpProxy;
  let app: INestApplication;
  let owner: SeededPrincipal;
  let holder: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    // Chỉ pool `app` qua proxy; pool `auth_user` đi thẳng PgBouncer nên xác thực vẫn chạy. `RoleRepository` là
    // `useExisting: SqlRoleRepository` (3A), nên thay `SqlRoleRepository` là thay repository của mọi chỗ gọi.
    app = await startTenancyApp({
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port), THROTTLE_DEFAULT_LIMIT: '100000' },
      configure: (b) =>
        b
          .overrideProvider(TenancyTestHooks)
          .useValue(hooks)
          .overrideProvider(SqlRoleRepository)
          .useFactory({ factory: (db: Db) => (secondStatement = new BlackholeOnPermissionKeys(db)), inject: [Db] }),
    });
    owner = await seedUserPrincipal();
    holder = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const c1 = roleSetC1(app.get(PermissionCatalogueRegistry).merged());
    await seedMemberInRole(org, await seedCustomRole(org, { permissions: c1 }), { authUserId: holder.authUserId });
  });
  afterAll(async () => {
    proxy.state.blackhole = false;
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await deleteSeededPrincipals([owner, holder]);
    vi.unstubAllEnvs();
  });

  it('POST roles: DB lost after the guard → 503 within the bound; no role, no tenancy.role.created', async () => {
    const name = `Outage ${v7()}`;
    hooks.armed = proxy;
    try {
      const started = performance.now();
      const r = await authed(app, owner).post(`/v1/orgs/${org.orgId}/roles`).set('idempotency-key', `k-${v7()}`).send({ name, permissions: ['org.read'] });
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      hooks.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(async () => expect((await authed(app, owner).get(`/v1/orgs/${org.orgId}/roles`)).status).toBe(200), RECOVERY);
    const roles = (await authed(app, owner).get(`/v1/orgs/${org.orgId}/roles`)).body.data as { name: string | null }[];
    expect(roles.map((x) => x.name)).not.toContain(name);
    expect(await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.role.created'`, [org.orgId])).toEqual([]);
  });
  it('a custom-role holder: DB lost exactly at the second hot-path statement → 503 + Retry-After from the guarded lookup (tiêu chí 12 for the 3B query)', async () => {
    const repo = secondStatement;
    if (!repo) throw new Error('the SqlRoleRepository override was not built');
    const unavailableBefore = (await otel.metric('tenancy_org_access_total', UNAVAILABLE)) ?? 0;
    repo.armed = proxy;
    try {
      const started = performance.now();
      const r = await authed(app, holder).get(`/v1/orgs/${org.orgId}/members`);
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      // Seam đã chạy: câu membership (câu thứ nhất) xong rồi mới tới `permissionKeys`, nơi blackhole bật.
      expect(repo.armed).toBeUndefined();
      // Nhánh `unavailable` của `lookup()` (không phải filter toàn cục) đã xử lý: câu thứ hai nằm trong try/catch của nó.
      expect(await otel.metric('tenancy_org_access_total', UNAVAILABLE)).toBe(unavailableBefore + 1);
    } finally {
      repo.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(async () => expect((await authed(app, holder).get(`/v1/orgs/${org.orgId}/members`)).status).toBe(200), RECOVERY);
  });
});
```
Ghi chú: ca thứ hai không bật blackhole trước request (lúc đó câu membership đã ra `503` và test xanh dù câu thứ hai nằm ngoài `try/catch`); lỗi hạ tầng chỉ được tiêm vào câu thứ hai. Kiểm đột biến một lần: tạm dời lời gọi `rolePermissions.of` ra ngoài `try/catch` của `lookup()` → ca đỏ ở metric `unavailable` (filter toàn cục vẫn có thể trả 503 nhưng không đếm nhánh `unavailable`); trả lại, xanh.

- [ ] **Step 2: Giết api khi transaction tạo role đã ghi dòng role và đang chờ khoá (tiêu chí 11)**

`test/chaos/tenancy-roles-api-kill.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../support/app-process.js';
import { baseTestEnv } from '../support/env.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { exitCode } from '../support/spawn-worker.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../support/tenancy-seed.js';

const WAIT_MS = 60_000;
const API_ENTRY = 'test/support/api-entry.ts';
const NAME = 'Killed mid-transaction';
const PROCESS_ENV: Record<string, string> = { HTTP_PORT: '0', HTTP_HOST: '127.0.0.1', HTTP_TRUST_PROXY: 'loopback' };

const until = async (pred: () => Promise<boolean>, ms = WAIT_MS): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const rolesNamed = (orgId: string) =>
  withAppClient((c) => inOrgTx(c, orgId, async () => (await c.query('SELECT 1 FROM org_roles WHERE name = $1', [NAME])).rows.length));
const createdEvents = (orgId: string) => ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.role.created'`, [orgId]);
const startApi = async (): Promise<AppProcess & { port: number }> => {
  const api = await startAppProcess(API_ENTRY, { ...baseTestEnv(), ...PROCESS_ENV });
  if (api.port === undefined) {
    await stopAppProcess(api);
    throw new Error('api-entry reported no port');
  }
  return { ...api, port: api.port };
};
const createRole = (port: number, p: SeededPrincipal, orgId: string) =>
  fetch(`http://127.0.0.1:${port}/v1/orgs/${orgId}/roles`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.bearer}`, 'content-type': 'application/json', 'idempotency-key': `kill-${orgId}-${Date.now()}` },
    body: JSON.stringify({ name: NAME, permissions: ['org.read'] }),
  });

/**
 * Spec SP3 §1 tiêu chí 11 cho `tenancy.role.created`: test giữ `FOR UPDATE` trên dòng `permissions` của `org.read`; câu
 * chèn quyền của `RoleService.create` đứng chờ ở kiểm FK (`FOR KEY SHARE`) SAU khi dòng `org_roles` đã được ghi trong
 * cùng transaction và TRƯỚC khi event được ghi. SIGKILL api → PgBouncer đóng connection server → transaction rollback:
 * không role, không event. Api mới làm lại: đúng một role, đúng một event.
 */
describe('api killed inside the create-role transaction (spec SP3 tiêu chí 11, phần 3B)', () => {
  const apis: AppProcess[] = [];
  let owner: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  beforeAll(async () => {
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    await org?.dispose();
    if (owner) await deleteSeededPrincipals([owner]);
  });

  it('SIGKILL while the permission insert waits: no role, no event; a fresh api creates exactly one of each', async () => {
    if (!owner || !org) throw new Error('not seeded');
    const first = await startApi();
    apis.push(first);
    const { pg: p } = getInfra();
    const lock = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await lock.connect();
    let blocked: number[] = [];
    try {
      await lock.query('BEGIN');
      await lock.query(`SELECT 1 FROM permissions WHERE key = 'org.read' FOR UPDATE`);
      const [{ pid } = { pid: -1 }] = (await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      const pending = createRole(first.port, owner, org.orgId).then((r) => r.status, (err: unknown) => err);
      // Backend của transaction tạo role đứng chờ khoá của test (kiểm FK trên dòng `permissions`), lọc theo pid của test.
      await until(async () => {
        blocked = (await ownerQuery<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).map((r) => r.pid);
        return blocked.length > 0;
      });
      const exited = exitCode(first.child);
      first.child.kill('SIGKILL');
      await exited;
      expect(await pending).toBeInstanceOf(Error);
      await lock.query('COMMIT');
    } finally {
      await lock.end();
    }
    // Chờ backend bị bỏ rơi kết thúc (PgBouncer đóng connection server của client đã chết → rollback); nếu nó commit thì
    // dòng role xuất hiện và assert dưới đỏ, đúng là lỗi cần bắt.
    await until(async () => (await ownerQuery(`SELECT 1 FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state <> 'idle'`, [blocked])).length === 0);
    expect(await rolesNamed(org.orgId)).toBe(0);
    expect(await createdEvents(org.orgId)).toEqual([]);
    const second = await startApi();
    apis.push(second);
    expect((await createRole(second.port, owner, org.orgId)).status).toBe(201);
    expect(await rolesNamed(org.orgId)).toBe(1);
    expect(await createdEvents(org.orgId)).toHaveLength(1);
  }, 120_000);
});
```
(Chờ khoá dòng hiện trong `pg_locks` là `transactionid` không có `relation`, nên test lọc theo `pg_blocking_pids` của chính kết nối giữ khoá, không theo tên bảng.)

- [ ] **Step 3: PII trong log của đường lỗi role**

`test/e2e/tenancy/roles-pii-logs.e2e.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { TENANCY_ONLY_CATALOGUE, roleSetC1, seedCustomRole, seedMemberInRole, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const PROCESS_ENV: Record<string, string> = { LOG_LEVEL: 'debug', HTTP_PORT: '0', HTTP_HOST: '127.0.0.1', HTTP_TRUST_PROXY: 'loopback' };
/** App chạy ở process con (không có registry trong process này): chỉ cần một tập đóng thiếu `invitations.read`. */
const C1 = roleSetC1(TENANCY_ONLY_CATALOGUE);

/** Spec SP3 §16, tiêu chí 16: log từ chối leo quyền chỉ có `rule`; tên/mô tả role (nội dung của org) và credential không vào log. */
describe('no role names, descriptions or credentials in logs of the 3B error paths', () => {
  let api: AppProcess | undefined;
  let owner: SeededPrincipal;
  let holder: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    api = await startAppProcess('test/support/api-entry.ts', { ...baseTestEnv(), ...PROCESS_ENV });
    owner = await seedUserPrincipal();
    holder = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMemberInRole(org, await seedCustomRole(org, { permissions: [...C1, 'roles.write'] }), { authUserId: holder.authUserId });
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await org?.dispose();
    await deleteSeededPrincipals([owner, holder]);
  });

  it('422, 403 escalation, 409 name taken and 409 role_in_use write no role name, description or bearer', async () => {
    const base = `http://127.0.0.1:${api?.port}/v1/orgs/${org.orgId}/roles`;
    const marker = `pii-${v7()}`;
    const call = (p: SeededPrincipal, method: string, url: string, body?: object) =>
      fetch(url, { method, headers: { authorization: `Bearer ${p.bearer}`, 'content-type': 'application/json', 'idempotency-key': `k-${v7()}`, 'if-match': '*' }, body: body && JSON.stringify(body) });
    expect((await call(owner, 'POST', base, { name: `${marker}-a`, description: `${marker}-d`, permissions: ['members.role.assign'] })).status).toBe(422);
    expect((await call(holder, 'POST', base, { name: `${marker}-b`, description: `${marker}-d`, permissions: ['org.read', 'roles.read', 'invitations.read'] })).status).toBe(403);
    const created = await call(owner, 'POST', base, { name: `${marker}-c`, description: `${marker}-d`, permissions: ['org.read'] });
    expect(created.status).toBe(201);
    expect((await call(owner, 'POST', base, { name: `${marker}-c`, permissions: ['org.read'] })).status).toBe(409);
    const holderRole = (await (await call(owner, 'GET', `http://127.0.0.1:${api?.port}/v1/orgs/${org.orgId}/members`)).json()) as { data: { role: { id: string; systemKey: string | null } }[] };
    const custom = holderRole.data.find((m) => m.role.systemKey === null)?.role.id;
    expect((await call(owner, 'DELETE', `${base}/${custom}`)).status).toBe(409);
    await new Promise((r) => setTimeout(r, 1_000));
    const output = api?.output() ?? '';
    expect(output.includes(marker)).toBe(false);
    for (const secret of [owner.bearer, holder.bearer]) expect(output.includes(secret)).toBe(false);
    // Đường từ chối có log (WARN `escalation_denied` với `rule`), chỉ là không mang nội dung.
    expect(output).toContain('escalation_denied');
  });
});
```
(`setTimeout(…, 1_000)` chỉ để log của process con kịp flush, như test PII của 3A; không phải chờ trạng thái.)

- [ ] **Step 4: Chạy, commit**

Run:
```bash
pnpm vitest run --project chaos test/chaos/tenancy-roles-outages.spec.ts test/chaos/tenancy-roles-api-kill.spec.ts
pnpm vitest run --project integration test/e2e/tenancy/roles-pii-logs.e2e.spec.ts
```
Expected: PASS.
```bash
pnpm exec prettier --write test/chaos/tenancy-roles-outages.spec.ts test/chaos/tenancy-roles-api-kill.spec.ts test/e2e/tenancy/roles-pii-logs.e2e.spec.ts
pnpm typecheck && pnpm lint
git add test/chaos/tenancy-roles-outages.spec.ts test/chaos/tenancy-roles-api-kill.spec.ts test/e2e/tenancy/roles-pii-logs.e2e.spec.ts
git commit -m "test(tenancy): DB outage and api kill inside custom role work; no role names or credentials in logs"
```

---

### Task 10: Ma trận role × route thêm cột C1 và ba route role (G-6), bảng route nhạy cảm gồm route role (R-20, tiêu chí 18), `AUTH_MODE=external` cho route role (tiêu chí 13)

**Files:**
- Modify (test): `test/e2e/tenancy/role-route-matrix.e2e.spec.ts`, `test/e2e/tenancy/auth-modes.e2e.spec.ts`

**Interfaces:**
- Consumes: `OrgRouteInventory.tenantRoutes()`, `type TenantRoute` (3A Task 27), `PermissionCatalogueRegistry` (3A Task 19, file 3A đã import), `seedCustomRole`, `seedMemberInRole`, `ROLE_SET_C0`, `roleSetC1` (Task 3), `startFakeJwks` (SP2), route role (Task 6).
- Produces: G-6 có cột C1 (spec Bảng 5, dòng "G-6"); bảng route tenant = route 3A ∪ `ROUTES_3B`.

- [ ] **Step 1: Ma trận** — đọc file của 3A đã merge trước, rồi sửa đúng năm chỗ (giữ nguyên mọi phần khác):

1. Import thêm `ROLE_SET_C0`, `roleSetC1`, `seedCustomRole`, `seedMemberInRole` từ `../../support/tenancy-seed.js`, và `SystemRoleKey` từ `../../../src/modules/tenancy/constants.js` nếu file còn lấy nó từ `tenancy-seed.js`.
2. Sau `ROUTES_3A` thêm:
```ts
/** Route tenant của 3B (spec §12). */
const ROUTES_3B = ['POST v1/orgs/:orgId/roles', 'PATCH v1/orgs/:orgId/roles/:roleId', 'DELETE v1/orgs/:orgId/roles/:roleId'];
type Column = SystemRoleKey | 'C1';
const COLUMNS: readonly Column[] = ['OWNER', 'ADMIN', 'MEMBER', 'C1'];
```
và ca "the tenant route table …" so với `[...ROUTES_3A, ...ROUTES_3B].sort()`.
3. `Cast` thành `{ org: SeededOrg; as: Record<Column, SeededPrincipal>; target: string; role: string }`; trong `cast()` thêm (trước `return`):
```ts
    // C1 của catalogue gộp thật (R-X24); cùng hàm với cột C1 của ca G-6 bên dưới.
    const c1 = await seedCustomRole(org, { permissions: roleSetC1(app.get(PermissionCatalogueRegistry).merged()), name: `C1 ${v7()}` });
    const c1p = await seedP(opts);
    await seedMemberInRole(org, c1, { authUserId: c1p.authUserId });
    // `:roleId` trỏ vào role tuỳ biến chưa ai giữ: route ghi role đi tới cuối (không dừng ở 409 role hệ thống / role_in_use).
    const spare = await seedCustomRole(org, { permissions: ROLE_SET_C0, name: `Spare ${v7()}` });
```
và trả `as: { OWNER: owner, ADMIN: admin, MEMBER: member, C1: c1p }`, `role: spare.publicId`.
4. Trong `call()`: `.replace(':roleId', c.role)` thay cho role `MEMBER`, và body:
```ts
    const body =
      route.id === 'PATCH v1/orgs/:orgId' ? { name: 'Matrix' }
      : route.id === 'PATCH v1/orgs/:orgId/members/:memberId' ? { roleId: c.org.roles.MEMBER.publicId }
      : route.id === 'POST v1/orgs/:orgId/roles' ? { name: `Matrix ${v7()}`, permissions: ['org.read'] }
      : route.id === 'PATCH v1/orgs/:orgId/roles/:roleId' ? { name: `Renamed ${v7()}` }
      : {};
```
5. Ca G-6 lặp `COLUMNS` thay `ROLES`, với tập quyền của cột:
```ts
      const perms = column === 'C1' ? new Set(roleSetC1(merged)) : systemRolePermissions(column, merged);
```
(tên biến vòng lặp đổi `role` → `column`; phần còn lại của ô giữ nguyên: `allowed` ⇔ `MEMBER_ONLY` hoặc đủ mọi key; lệch hoặc `5xx` → ghi vào `failures`.)

Ca "every sensitive route …" và "every narrowing route …" không sửa: chúng sinh từ `tenantRoutes()`, nên ba route role (đều `@SensitiveTenancyAction()`) tự vào bảng session cũ/email chưa xác thực (R-20 cho cả ba), còn tập route "thu hẹp" vẫn đúng `['DELETE v1/orgs/:orgId/members/me']`.

- [ ] **Step 2: `AUTH_MODE=external` cho route role** — trong `describe('AUTH_MODE=external …')` của `test/e2e/tenancy/auth-modes.e2e.spec.ts` thêm:
```ts
  it('roles: a fresh token (auth_time) creates a custom role; without auth_time the same call → 403 reauthentication_required', async () => {
    const ownerSub = `ext-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: ownerSub } });
    seeded.push(org);
    const fresh = await token(ownerSub, { auth_time: nowSec() });
    const ok = await http().post(`/v1/orgs/${org.orgId}/roles`).set('authorization', `Bearer ${fresh}`).set('idempotency-key', `k-${v7()}`).send({ name: 'External role', permissions: ['org.read'] });
    expect([ok.status, ok.body.permissions]).toEqual([201, ['org.read']]);
    const stale = await token(ownerSub);
    const denied = await http().post(`/v1/orgs/${org.orgId}/roles`).set('authorization', `Bearer ${stale}`).set('idempotency-key', `k-${v7()}`).send({ name: 'No auth_time', permissions: ['org.read'] });
    expect([denied.status, denied.body.code]).toEqual([403, 'reauthentication_required']);
  });
```
`local` là mode mặc định của mọi e2e role khác (Task 5–8); `hybrid` dùng cùng principal Better Auth với `local` (3A đã phủ phần principal), nên 3B chỉ thêm ca `external`, nơi "session mới" là claim `auth_time`.

- [ ] **Step 3: Chạy, commit**

Run: `pnpm vitest run --project integration test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts`
Expected: PASS (không ô nào lệch ở bốn cột; mọi route ✓ gồm ba route role trả `403 reauthentication_required`/`email_not_verified`; `external` tạo role với `auth_time`, từ chối khi thiếu).
```bash
git add test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts
git commit -m "test(tenancy): role x route matrix with a C1 column and the role routes; external mode on role writes"
```

---
## Phần F — Vòng đời quyền: mẫu migration dữ liệu 7 bước (spec §8.8)

### Task 11: Mẫu migration dữ liệu catalogue 7 bước chạy thật qua runner — K-9, K-9b (a)(b)(c), K-9c, K-17 phần role

**Files:**
- Create (test): `test/support/catalogue-migration.ts`, `test/integration/tenancy/catalogue-data-migration.spec.ts`

**Interfaces:**
- Consumes: `runMigrations`, `type MigrationObject` (SP1), `Migration` (`@mikro-orm/migrations`), `createScratchDb`, `coreMigrationList`, `applyTestEnv` (3A), `seedOrg({ database })`, `seedCustomRole`, `withAppClient`, `inOrgTx` (3A Task 14, Task 3), `ROLE_PERMISSIONS_SQL` (Task 5), `RoleUpdatedEvent` (Task 6), `parseEnvelope` (core `events`), `toEnvelope` (`src/core/events/event-dispatch.handlers.ts`).
- Produces (test support, 3D mở rộng cho key/grant):
  - `CATALOGUE_DATA_TABLES` (spec §8.8 bước 2, thứ tự cố định; bảng chưa có bị bỏ qua bằng `to_regclass`).
  - `sevenStep(dml: readonly string[], opts?: { skipForceRestore?: boolean }): string[]` — bước 2 (NO FORCE từng bảng), `dml` (bước 3), bước 4 (kiểm tên deferrable duy nhất + `SET CONSTRAINTS <schema>.<tên> IMMEDIATE` theo tên), bước 5 (trả về chế độ khai báo), bước 6 (FORCE lại), bước 7 (khẳng định FORCE). `skipForceRestore` chỉ cho K-9c.
  - `narrowRolesToFixpoint(migration: string, initialDelete?: string): string` — bước 3 cho role: (xoá ban đầu) → lặp `DELETE` quyền thiếu `requires` tới điểm bất động → tăng `version` mỗi role bị chạm → một `tenancy.role.updated` mỗi role (actor `system`, id `catalogue-migration:<migration>`).
  - `removePermissionDml(migration, key): string[]` (dòng vòng đời "Xoá (bản N+1)"), `addRequiresEdgesDml(migration, edges: readonly (readonly [string, string])[]): string[]` (dòng "Thêm cạnh `requires`").
  - `catalogueMigration(name: string, statements: readonly string[]): MigrationObject` (migration fixture chỉ đi tới).

- [ ] **Step 1: Mẫu 7 bước**

`test/support/catalogue-migration.ts`:
```ts
import { Migration } from '@mikro-orm/migrations';
import type { MigrationObject } from '../../src/core/database/index.js';

/**
 * Spec SP3 §8.8 bước 2: tập bảng mà DML, trigger và câu dựng event của migration catalogue chạm tới, thứ tự cố định (thứ tự
 * lấy ACCESS EXCLUSIVE luôn giống nhau). Bảng của 3D chưa có ở 3B thì bị bỏ qua (`to_regclass`).
 */
export const CATALOGUE_DATA_TABLES = ['org_roles', 'org_role_permissions', 'org_api_keys', 'org_api_key_permissions', 'org_support_grants', 'org_support_grant_permissions'] as const;

const eachTable = (mode: 'NO FORCE' | 'FORCE'): string => `DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[${CATALOGUE_DATA_TABLES.map((t) => `'${t}'`).join(', ')}] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ${mode} ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;`;

/** Bước 4: tên deferrable phải duy nhất theo schema (R4C-N4-4, R5-C1), rồi xả trigger hoãn THEO TÊN (không bao giờ `ALL`, R3-DB-2). */
const FLUSH_DEFERRED = `DO $$ DECLARE r record; BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname IN ('public', 'auth') GROUP BY c.connamespace, c.conname HAVING count(*) > 1 AND bool_or(c.condeferrable)
  ) THEN
    RAISE EXCEPTION 'a deferrable constraint name must be unique per schema';
  END IF;
  FOR r IN SELECT n.nspname, c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I IMMEDIATE', r.nspname, r.conname);
  END LOOP;
END $$;`;

/** Bước 5: trả từng constraint deferrable về chế độ khai báo (không rò `IMMEDIATE` sang migration sau, CDX-4). */
const RESTORE_DECLARED = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.conname, c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I %s', r.nspname, r.conname, CASE WHEN r.condeferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END);
  END LOOP;
END $$;`;

/** Bước 7: cùng khối khẳng định với migration 3A/3B (chuỗi RAISE là hằng mà `migration-scan.spec.ts` tìm). */
const ASSERT_FORCE = `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`;

export function sevenStep(dml: readonly string[], opts: { skipForceRestore?: boolean } = {}): string[] {
  return [eachTable('NO FORCE'), ...dml, FLUSH_DEFERRED, RESTORE_DECLARED, ...(opts.skipForceRestore ? [] : [eachTable('FORCE')]), ASSERT_FORCE];
}

/**
 * Bước 3 cho role (spec §8.8, dòng "Xoá" và "Thêm cạnh requires"): mọi tập đã lưu thu hẹp tới điểm bất động — lặp xoá quyền
 * có ít nhất một quyền yêu cầu trực tiếp không nằm trong tập, tới khi một vòng không xoá gì (quyền phụ thuộc BẮC CẦU cũng bị
 * gỡ). Mỗi role bị chạm: `version + 1` và đúng một `tenancy.role.updated` dựng từ giá trị SAU khi tăng. Vòng đời không bao
 * giờ mở rộng quyền.
 */
export function narrowRolesToFixpoint(migration: string, initialDelete?: string): string {
  const actor = `catalogue-migration:${migration}`;
  return `DO $$
DECLARE v_removed bigint;
BEGIN
  DROP TABLE IF EXISTS pg_temp.catalogue_touched_roles;
  CREATE TEMP TABLE catalogue_touched_roles (org_id uuid NOT NULL, role_id bigint NOT NULL, PRIMARY KEY (org_id, role_id)) ON COMMIT DROP;
  ${
    initialDelete === undefined
      ? ''
      : `WITH d AS (${initialDelete} RETURNING rp.org_id, rp.role_id)
  INSERT INTO catalogue_touched_roles SELECT DISTINCT org_id, role_id FROM d ON CONFLICT DO NOTHING;`
  }
  LOOP
    WITH d AS (
      DELETE FROM public.org_role_permissions rp
      WHERE EXISTS (
        SELECT 1 FROM public.permission_requires r
        WHERE r.permission_id = rp.permission_id
          AND NOT EXISTS (SELECT 1 FROM public.org_role_permissions x
                          WHERE x.org_id = rp.org_id AND x.role_id = rp.role_id AND x.permission_id = r.required_permission_id))
      RETURNING rp.org_id, rp.role_id),
    i AS (INSERT INTO catalogue_touched_roles SELECT DISTINCT org_id, role_id FROM d ON CONFLICT DO NOTHING)
    SELECT count(*) INTO v_removed FROM d;
    EXIT WHEN v_removed = 0;
  END LOOP;
  WITH u AS (
    UPDATE public.org_roles r SET version = r.version + 1, updated_at = now()
    FROM catalogue_touched_roles t WHERE r.org_id = t.org_id AND r.id = t.role_id
    RETURNING r.org_id, r.id, r.public_id, r.version)
  INSERT INTO public.outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
  SELECT uuidv7(), 'tenancy.role.updated', 1, u.org_id, 'role', u.public_id::text, u.version,
    jsonb_build_object('roleId', u.public_id, 'permissions', COALESCE((
      SELECT jsonb_agg(p.key ORDER BY p.key) FROM public.org_role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
      WHERE rp.org_id = u.org_id AND rp.role_id = u.id AND p.deprecated_at IS NULL), '[]'::jsonb)),
    jsonb_build_object('actorType', 'system', 'actorId', '${actor}', 'correlationId', '${actor}')
  FROM u;
END $$;`;
}

/** Dòng vòng đời "Xoá (bản N+1)": quyền đã deprecate ở bản N; gỡ khỏi mọi tập, thu hẹp, rồi cạnh `requires`, rồi dòng catalogue. */
export function removePermissionDml(migration: string, key: string): string[] {
  const id = `(SELECT id FROM public.permissions WHERE key = '${key}')`;
  return [
    narrowRolesToFixpoint(migration, `DELETE FROM public.org_role_permissions rp USING public.permissions p WHERE p.id = rp.permission_id AND p.key = '${key}'`),
    `DELETE FROM public.permission_requires WHERE permission_id = ${id} OR required_permission_id = ${id};`,
    `DELETE FROM public.permissions WHERE key = '${key}';`,
  ];
}

/** Dòng vòng đời "Thêm cạnh requires P → Q": chèn cạnh TRƯỚC, rồi thu hẹp mọi tập (không bù Q). */
export function addRequiresEdgesDml(migration: string, edges: readonly (readonly [string, string])[]): string[] {
  return [
    `INSERT INTO public.permission_requires (permission_id, required_permission_id)
     SELECT p.id, q.id FROM (VALUES ${edges.map(([from, to]) => `('${from}', '${to}')`).join(', ')}) AS e (k, req)
     JOIN public.permissions p ON p.key = e.k JOIN public.permissions q ON q.key = e.req;`,
    narrowRolesToFixpoint(migration),
  ];
}

/** Migration fixture chỉ đi tới (không bao giờ `down`), tên đúng dạng `Migration<14 chữ số>_<tên>` của runner. */
export function catalogueMigration(name: string, statements: readonly string[]): MigrationObject {
  class CatalogueFixtureMigration extends Migration {
    override up(): void {
      for (const s of statements) this.addSql(s);
    }
    override down(): void {
      throw new Error(`${name} is a forward-only test migration`);
    }
  }
  Object.defineProperty(CatalogueFixtureMigration, 'name', { value: name });
  return { name, class: CatalogueFixtureMigration };
}
```
(Key và tên migration là hằng của test, không phải đầu vào người dùng, nên nối chuỗi SQL ở đây là an toàn.)

- [ ] **Step 2: Test K-9, K-9b, K-9c, K-17 (viết, chạy thấy đỏ ở ca nào đi ngược mẫu, rồi xanh)**

`test/integration/tenancy/catalogue-data-migration.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { toEnvelope } from '../../../src/core/events/event-dispatch.handlers.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import { RoleUpdatedEvent } from '../../../src/modules/tenancy/events.js';
import { ROLE_PERMISSIONS_SQL } from '../../../src/modules/tenancy/infra/sql/sql-role.repository.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { addRequiresEdgesDml, catalogueMigration, removePermissionDml, sevenStep } from '../../support/catalogue-migration.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedCustomRole, seedOrg, withAppClient, type SeededOrg, type SeededRole } from '../../support/tenancy-seed.js';

const TABLE = 'mikro_orm_migrations_catalogue_fixtures';
/** Catalogue fixture (chỉ ở DB riêng của test): chuỗi, hình thoi, và một nhánh cho K-9b. */
const FIXTURE_KEYS = [
  ['payroll', 'read'], ['payroll', 'export'], ['payroll', 'approve'],
  ['ledger', 'close'], ['ledger', 'post'], ['ledger', 'read'],
  ['audit', 'top'], ['audit', 'left'], ['audit', 'right'], ['audit', 'base'],
  ['stock', 'count'], ['stock', 'view'],
] as const;
const FIXTURE_EDGES = [
  ['payroll.export', 'payroll.read'], ['payroll.approve', 'payroll.export'],
  ['ledger.close', 'ledger.post'],
  ['audit.top', 'audit.left'], ['audit.top', 'audit.right'],
  ['stock.count', 'stock.view'],
] as const;

describe('catalogue data migrations through the real runner (spec SP3 §8.8; §18.3 K-9, K-9b, K-9c, K-17 role part)', () => {
  let db: ScratchDb;
  let owner: pg.Client;
  let org: SeededOrg;
  const role: Record<string, SeededRole> = {};
  const run = (...migrations: ReturnType<typeof catalogueMigration>[]) => runMigrations('up', { source: { kind: 'list', list: migrations }, tableName: TABLE });
  /** Tập đã lưu của mọi role tuỳ biến, gồm cả key deprecated (đọc bằng app_user trong OrgScope). */
  const sets = () =>
    withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, async () => {
          const { rows } = await c.query<{ role_id: string; key: string }>(`SELECT rp.role_id::text AS role_id, p.key FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id`);
          const out = new Map<string, Set<string>>(Object.values(role).map((r) => [r.id, new Set<string>()]));
          for (const r of rows) out.get(r.role_id)?.add(r.key);
          return out;
        }),
      db.name,
    );
  const versions = () =>
    withAppClient((c) => inOrgTx(c, org.orgId, async () => new Map((await c.query<{ id: string; version: number }>(`SELECT id::text AS id, version FROM org_roles`)).rows.map((r) => [r.id, r.version]))), db.name);
  const openSets = () =>
    withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, async () =>
          (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_role_permissions s JOIN permission_requires r ON r.permission_id = s.permission_id
            WHERE NOT EXISTS (SELECT 1 FROM org_role_permissions t WHERE t.org_id = s.org_id AND t.role_id = s.role_id AND t.permission_id = r.required_permission_id)`)).rows[0]?.n,
        ),
      db.name,
    );
  const events = async (migration: string) =>
    (
      await owner.query<{ id: string; event_id: string; type: string; version: number; org_id: string | null; aggregate_type: string; aggregate_id: string; aggregate_version: string; payload: unknown; headers: Record<string, string>; occurred_at: Date }>(
        `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
                aggregate_version::text AS aggregate_version, payload, headers, occurred_at
         FROM outbox_events WHERE headers->>'actorId' = $1 ORDER BY id`,
        [`catalogue-migration:${migration}`],
      )
    ).rows.map((row) => parseEnvelope(RoleUpdatedEvent, toEnvelope(row)));
  const forced = async () =>
    (await owner.query<{ relname: string; f: boolean }>(`SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('org_roles', 'org_role_permissions') ORDER BY relname`)).rows;
  /** Vòng đời chỉ thu hẹp hoặc giữ nguyên (spec §8.8): mỗi tập sau ⊆ tập trước. */
  const expectNarrowedOnly = (before: Map<string, Set<string>>, after: Map<string, Set<string>>) => {
    for (const [id, b] of before) expect([...(after.get(id) ?? [])].every((k) => b.has(k)), `role ${id} grew`).toBe(true);
  };

  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('catmig');
    vi.stubEnv('DB_NAME', db.name);
    await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
    owner = await db.client('owner');
    await owner.query(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) SELECT r, a, false, false, false FROM unnest($1::text[], $2::text[]) AS k (r, a)`,
      [FIXTURE_KEYS.map(([r]) => r), FIXTURE_KEYS.map(([, a]) => a)],
    );
    await owner.query(
      `INSERT INTO permission_requires (permission_id, required_permission_id) SELECT p.id, q.id FROM unnest($1::text[], $2::text[]) AS e (k, req) JOIN permissions p ON p.key = e.k JOIN permissions q ON q.key = e.req`,
      [FIXTURE_EDGES.map(([k]) => k), FIXTURE_EDGES.map(([, r]) => r)],
    );
    org = await seedOrg({ database: db.name });
    const seed = async (name: string, permissions: string[]) => {
      role[name] = await seedCustomRole(org, { name, permissions });
    };
    await seed('pay3', ['payroll.read', 'payroll.export', 'payroll.approve']);
    await seed('pay2', ['payroll.read', 'payroll.export']);
    await seed('untouched', ['org.read']);
    await seed('chain', ['ledger.close', 'ledger.post']);
    await seed('chainFull', ['ledger.close', 'ledger.post', 'ledger.read']);
    await seed('diamond', ['audit.top', 'audit.left', 'audit.right']);
    await seed('diamondFull', ['audit.top', 'audit.left', 'audit.right', 'audit.base']);
    await seed('replaced', ['org.read']);
    // Bản N của dòng "Xoá": payroll.export và quyền phụ thuộc nó (approve) được deprecate cùng lúc (U2).
    await owner.query(`UPDATE permissions SET deprecated_at = now() WHERE key IN ('payroll.export', 'payroll.approve')`);
  }, 180_000);
  afterAll(async () => {
    await owner?.end();
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('K-9c: a catalogue migration that forgets step 6 is rolled back by step 7; data and FORCE unchanged', async () => {
    const before = await sets();
    const name = 'Migration29990101000001_k9c_forgot_force';
    await expect(run(catalogueMigration(name, sevenStep(removePermissionDml(name, 'payroll.export'), { skipForceRestore: true })))).rejects.toThrow(/a tenant table lost FORCE ROW LEVEL SECURITY/);
    expect(await sets()).toEqual(before);
    expect(await forced()).toEqual([{ relname: 'org_role_permissions', f: true }, { relname: 'org_roles', f: true }]);
    expect(await events(name)).toEqual([]);
  });

  it('K-9: removing a deprecated permission narrows every holding role to its fixpoint, bumps each touched role once and emits one event each', async () => {
    const before = await sets();
    const v0 = await versions();
    const name = 'Migration29990101000002_k9_remove_payroll_export';
    await run(catalogueMigration(name, sevenStep(removePermissionDml(name, 'payroll.export'))));
    const after = await sets();
    expect([...(after.get(role.pay3!.id) ?? [])]).toEqual(['payroll.read']);
    expect([...(after.get(role.pay2!.id) ?? [])]).toEqual(['payroll.read']);
    expect(after.get(role.untouched!.id)).toEqual(before.get(role.untouched!.id));
    expectNarrowedOnly(before, after);
    const v1 = await versions();
    for (const r of [role.pay3!, role.pay2!]) expect(v1.get(r.id)).toBe((v0.get(r.id) ?? 0) + 1);
    expect(v1.get(role.untouched!.id)).toBe(v0.get(role.untouched!.id));
    const evs = (await events(name)).sort((a, b) => a.aggregate.id.localeCompare(b.aggregate.id));
    expect(evs.map((e) => [e.aggregate.id, e.aggregate.version, e.data.permissions, e.actor])).toEqual(
      [role.pay3!, role.pay2!]
        .map((r) => [r.publicId, v1.get(r.id), ['payroll.read'], { type: 'system', id: `catalogue-migration:${name}` }])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect((await owner.query(`SELECT 1 FROM permissions WHERE key = 'payroll.export'`)).rows).toEqual([]);
    expect(await openSets()).toBe(0);
    expect(await forced()).toEqual([{ relname: 'org_role_permissions', f: true }, { relname: 'org_roles', f: true }]);
    // "gọi → 403": câu thứ hai của đường nóng (Task 5) không còn trả key đã xoá.
    const hot = await withAppClient((c) => inOrgTx(c, org.orgId, async () => (await c.query<{ key: string }>(ROLE_PERMISSIONS_SQL.replace('?', '$1'), [[role.pay3!.id]])).rows.map((r) => r.key)), db.name);
    expect(hot).toEqual(['payroll.read']);
  });

  it('K-9b (a): two data migrations in one batch; the second replaces a set with DELETE then several INSERTs valid only at the end → green (step 5 leaks no IMMEDIATE)', async () => {
    const first = 'Migration29990101000003_k9b_remove_payroll_approve';
    const second = 'Migration29990101000004_k9b_replace_set';
    const r = role.replaced!;
    await run(
      catalogueMigration(first, sevenStep(removePermissionDml(first, 'payroll.approve'))),
      catalogueMigration(second, sevenStep([
        `DELETE FROM public.org_role_permissions WHERE role_id = ${r.id};`,
        `INSERT INTO public.org_role_permissions (org_id, role_id, permission_id) SELECT org_id, id, (SELECT id FROM public.permissions WHERE key = 'stock.count') FROM public.org_roles WHERE id = ${r.id};`,
        `INSERT INTO public.org_role_permissions (org_id, role_id, permission_id) SELECT org_id, id, (SELECT id FROM public.permissions WHERE key = 'stock.view') FROM public.org_roles WHERE id = ${r.id};`,
      ])),
    );
    expect([...((await sets()).get(r.id) ?? [])].sort()).toEqual(['stock.count', 'stock.view']);
  });

  it('K-9b (b): a catalogue migration, then a migration creating a NEW deferred constraint trigger and multi-step DML valid only at the end → green', async () => {
    const first = 'Migration29990101000005_k9b_noop_catalogue';
    const second = 'Migration29990101000006_k9b_new_deferred_trigger';
    await run(
      catalogueMigration(first, sevenStep([])),
      catalogueMigration(second, [
        `CREATE TABLE k9b_pairs (n int NOT NULL);`,
        `CREATE FUNCTION k9b_pairs_even() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           IF (SELECT count(*) FROM public.k9b_pairs) % 2 <> 0 THEN RAISE EXCEPTION 'odd' USING ERRCODE = 'check_violation', CONSTRAINT = 'k9b_pairs_even_ck'; END IF;
           RETURN NULL; END $$;`,
        `CREATE CONSTRAINT TRIGGER k9b_pairs_even_ck AFTER INSERT ON k9b_pairs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION k9b_pairs_even();`,
        `INSERT INTO k9b_pairs (n) VALUES (1);`,
        `INSERT INTO k9b_pairs (n) VALUES (2);`,
      ]),
    );
    expect((await owner.query(`SELECT count(*)::int AS n FROM k9b_pairs`)).rows).toEqual([{ n: 2 }]);
  });

  it.each([
    ['two deferrable triggers with the same name (DEFERRED and IMMEDIATE)', 'trigger', [`CREATE CONSTRAINT TRIGGER k9c_dup_ck AFTER INSERT ON k9c_b DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION k9c_noop();`]],
    ['a deferrable trigger named like a CHECK of another table', 'check', [`ALTER TABLE k9c_b ADD CONSTRAINT k9c_dup_ck CHECK (n >= 0);`]],
    // Spec §8.8/§18.3 (R5-C1): FK KHÔNG deferrable cùng tên với một trigger deferrable — `SET CONSTRAINTS <tên>` theo tên
    // sẽ chạm cả hai; bước 4 phải từ chối (nhóm theo tên có `bool_or(condeferrable)` dù FK tự nó không deferrable).
    ['a NOT DEFERRABLE foreign key named like a deferrable trigger of another table', 'fk', [
      `ALTER TABLE k9c_a ADD CONSTRAINT k9c_a_pk PRIMARY KEY (n);`,
      `ALTER TABLE k9c_b ADD CONSTRAINT k9c_dup_ck FOREIGN KEY (n) REFERENCES k9c_a (n) NOT DEFERRABLE;`,
    ]],
  ] as const)('K-9b (c): %s → step 4 raises and the whole batch rolls back', async (_n, suffix, clash) => {
    const fixture = `Migration29990101000007_k9c_dup_names_${suffix}`;
    const catalogue = `Migration29990101000008_k9c_catalogue_${suffix}`;
    await expect(
      run(
        catalogueMigration(fixture, [
          `CREATE TABLE k9c_a (n int);`,
          `CREATE TABLE k9c_b (n int);`,
          `CREATE FUNCTION k9c_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;`,
          `CREATE CONSTRAINT TRIGGER k9c_dup_ck AFTER INSERT ON k9c_a DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION k9c_noop();`,
          ...clash,
        ]),
        catalogueMigration(catalogue, sevenStep([])),
      ),
    ).rejects.toThrow(/a deferrable constraint name must be unique per schema/);
    expect((await owner.query(`SELECT to_regclass('public.k9c_a') IS NULL AS gone`)).rows).toEqual([{ gone: true }]);
  });

  it('K-17 (role): adding requires edges on a chain R → P (+ P → Q) and a diamond (L → B, R → B) narrows to the fixpoint; full sets and other roles unchanged; no set grows', async () => {
    const before = await sets();
    const v0 = await versions();
    const name = 'Migration29990101000009_k17_add_requires';
    await run(catalogueMigration(name, sevenStep(addRequiresEdgesDml(name, [['ledger.post', 'ledger.read'], ['audit.left', 'audit.base'], ['audit.right', 'audit.base']]))));
    const after = await sets();
    expect([...(after.get(role.chain!.id) ?? [])]).toEqual([]);
    expect([...(after.get(role.diamond!.id) ?? [])]).toEqual([]);
    expect(after.get(role.chainFull!.id)).toEqual(before.get(role.chainFull!.id));
    expect(after.get(role.diamondFull!.id)).toEqual(before.get(role.diamondFull!.id));
    expectNarrowedOnly(before, after);
    expect(await openSets()).toBe(0);
    const v1 = await versions();
    const touched = [role.chain!, role.diamond!];
    for (const r of touched) expect(v1.get(r.id)).toBe((v0.get(r.id) ?? 0) + 1);
    for (const r of [role.chainFull!, role.diamondFull!]) expect(v1.get(r.id)).toBe(v0.get(r.id));
    expect((await events(name)).map((e) => e.aggregate.id).sort()).toEqual(touched.map((r) => r.publicId).sort());
  });
});
```
Ghi chú thứ tự: K-9c chạy trước K-9 (cùng key `payroll.export`) để chứng minh lô rollback để lại dữ liệu y nguyên; `it` trong một file chạy tuần tự theo thứ tự khai báo. `k9c_*` được tạo trong lô bị rollback nên ca sau của `it.each` tạo lại được (ba ca: trigger, CHECK, FK không deferrable).

Run: `pnpm vitest run --project integration test/integration/tenancy/catalogue-data-migration.spec.ts`
Expected: PASS mọi ca. Kiểm tay rằng test bắt được lỗi: tạm đổi `RESTORE_DECLARED` thành chuỗi rỗng → K-9b (a) đỏ ở câu `INSERT` đầu (closure bắn ngay); tạm đổi bước 4 thành `SET CONSTRAINTS ALL IMMEDIATE` → K-9b (b) đỏ; trả lại, xanh. Ghi hai lần đỏ này vào mô tả commit.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write test/support/catalogue-migration.ts test/integration/tenancy/catalogue-data-migration.spec.ts
pnpm typecheck && pnpm lint
git add test/support/catalogue-migration.ts test/integration/tenancy/catalogue-data-migration.spec.ts
git commit -m "test(tenancy): seven-step catalogue data migrations through the runner: removal, added requires edges, no IMMEDIATE leak, unique deferrable names, forgotten FORCE"
```

---

## Phần G — Prod-like, tài liệu, bàn giao (spec §18.4, §22)

### Task 12: Kiểm chứng prod-like #2 — luồng role tuỳ biến trên image production; đo lại kích thước image (ADR 0013)

**Files:**
- Modify: `test/smoke/tenancy.smoke.spec.ts`, `docs/adr/0013-build-toolchain.md` (chỉ khi chênh > 1 MB)

**Interfaces:**
- Consumes: `Device`, `verifiedDevice(apiUrl, mail, forbidden)`, `forbidden`, `psql` (smoke 3A), route role (Task 6), đổi role member (3A).
- Produces: smoke 3B (spec §22.3 Bảng 3: tạo role tuỳ biến → gán cho member seed → sửa → xoá bị `409 role_in_use`), số đo image.

- [ ] **Step 1: Luồng role trên image**

`test/smoke/tenancy.smoke.spec.ts` — thêm ca trong `describe`, trước ca log sạch:
```ts
  it('custom roles on the production image: create → assign to a seeded member → edit → delete refused 409 role_in_use → unassign → delete 204', async () => {
    const { device } = await verifiedDevice(apiUrl, mail, forbidden);
    const org = await device.call('POST', '/v1/orgs', { body: { name: 'Smoke 3B' }, headers: { 'idempotency-key': `smoke-${randomUUID()}` } });
    expect(org.status).toBe(201);
    const { id: orgId } = z.object({ id: z.uuid() }).parse(await org.json());
    // Member seed: một user đã xác thực khác, thêm thẳng bằng superuser (3B chưa có lời mời; 3C thêm đường API).
    const { email: memberEmail } = await verifiedDevice(apiUrl, mail, forbidden);
    const authId = psql(`SELECT id FROM auth."user" WHERE email = '${memberEmail}'`);
    const memberRole = psql(`SELECT id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'MEMBER'`);
    psql(`INSERT INTO tenancy_users (auth_user_id) VALUES ('${authId}') ON CONFLICT (auth_user_id) DO NOTHING`);
    const memberId = psql(`INSERT INTO org_members (org_id, user_id, role_id) SELECT '${orgId}', id, ${memberRole} FROM tenancy_users WHERE auth_user_id = '${authId}' RETURNING public_id`);
    const base = `/v1/orgs/${orgId}/roles`;
    const created = await device.call('POST', base, { body: { name: 'Support', permissions: ['org.read', 'members.read'] }, headers: { 'idempotency-key': `smoke-${randomUUID()}` } });
    expect(created.status).toBe(201);
    const { id: roleId } = z.object({ id: z.uuid() }).parse(await created.json());
    expect((await device.call('PATCH', `/v1/orgs/${orgId}/members/${memberId}`, { body: { roleId }, headers: { 'if-match': '*' } })).status).toBe(200);
    const edited = await device.call('PATCH', `${base}/${roleId}`, { body: { permissions: ['org.read'] }, headers: { 'if-match': '"1"' } });
    expect([edited.status, edited.headers.get('etag')]).toEqual([200, 'W/"2"']); // ETag yếu của `etagOf` (ADR 0007)
    const refused = await device.call('DELETE', `${base}/${roleId}`);
    expect(refused.status).toBe(409);
    expect(z.object({ code: z.string() }).parse(await refused.json()).code).toBe('role_in_use');
    const memberRolePublic = psql(`SELECT public_id FROM org_roles WHERE id = ${memberRole}`);
    expect((await device.call('PATCH', `/v1/orgs/${orgId}/members/${memberId}`, { body: { roleId: memberRolePublic }, headers: { 'if-match': '*' } })).status).toBe(200);
    expect((await device.call('DELETE', `${base}/${roleId}`)).status).toBe(204);
    // role.created, role.updated, role.deleted cùng transaction với từng thay đổi.
    expect(psql(`SELECT string_agg(type, ',' ORDER BY id) FROM outbox_events WHERE org_id = '${orgId}' AND type LIKE 'tenancy.role.%'`)).toBe('tenancy.role.created,tenancy.role.updated,tenancy.role.deleted');
    expect(psql(`SELECT count(*) FROM org_role_permissions WHERE org_id = '${orgId}'`)).toBe('0');
  });
```
(`psql` chạy bằng superuser của smoke: bỏ qua RLS; id do Postgres sinh, email do smoke sinh bằng `randomUUID`; nối vào SQL là an toàn, như ca 3A.)

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer, rate limit bật), migrate 3A + 3B trên image, mọi file smoke PASS, log api/worker JSON, không `error`, không chứa giá trị nào trong `forbidden`; `/health/ready` 200; teardown `down -v` sạch. Image `nestjs-saas-boilerplate:nsb-smoke` còn lại cho Step 2.

- [ ] **Step 2: Đo image như ADR 0013**

Run (Git Bash, cùng máy với số "SP3 (3A)"):
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
```
Expected: tổng layer chưa nén ≤ 400 MB (vượt → dừng, pipeline coi là đỏ, spec §18.4). So với dòng "SP3 (3A)" của `docs/adr/0013-build-toolchain.md`: 3B không thêm dependency nên chênh gần 0. Chỉ khi chênh > 1 MB ở chỉ số nào, thêm dòng "SP3 (3B)" vào bảng số đo SP3 với số thật và lý do chênh; không chênh thì không sửa ADR (spec §18.4) và ghi số đo vào mô tả PR (Task 14).

- [ ] **Step 3: Commit**

```bash
git add test/smoke/tenancy.smoke.spec.ts
git commit -m "test(smoke): custom role lifecycle on the production image"
```
(Thêm `docs/adr/0013-build-toolchain.md` vào commit chỉ khi Step 2 ghi dòng mới.)

---

### Task 13: Tài liệu — ADR 0005, 0017, README (role tuỳ biến, vòng đời quyền, mẫu migration dữ liệu 7 bước), bỏ nhãn `(3B)` ở spec cha

**Files:**
- Modify: `docs/adr/0005-multi-tenant-rls.md`, `docs/adr/0017-tenancy-own-module.md`, `README.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`

**Interfaces:**
- Consumes: tên thật của code Task 2–11; `test/support/catalogue-migration.ts` (Task 11) là nguồn nguyên văn của mẫu SQL; `docs/superpowers/specs/2026-09-28-sp3-parent-spec-amendments.md` mục "Cách áp" (plan mang tính năng bỏ nhãn của mình khi merge).
- Produces: tài liệu khớp với cái 3B ship.

- [ ] **Step 1: ADR 0005 và 0017**

`docs/adr/0005-multi-tenant-rls.md` — thêm mục ngay sau "## Cập nhật SP3 (3A) …":
```markdown
## Cập nhật SP3 (3B) (<ngày merge>)

- **`org_role_permissions`** (bảng nối của role tuỳ biến): RLS + FORCE, policy `TO app_user`, FK kép `(org_id, role_id) → org_roles ON DELETE CASCADE`, FK `permission_id → permissions ON DELETE RESTRICT`; `app_user` chỉ `SELECT, INSERT, DELETE` (sửa role = xoá/thêm dòng). Chuẩn hoá: 1NF hình thức theo ngoại lệ E1 (`role_id → org_id`), giữ nhất quán bằng FK kép + không `UPDATE` + `WITH CHECK`.
- **Trigger hoãn đọc bảng tenant là `SECURITY DEFINER` của `tenancy_definer`**: hàm dùng chung `tenancy_permission_scope_closed_ck(owner_column)` (tập quyền đã lưu phải đóng theo `requires`) đọc qua policy `org_role_permissions_definer_read` và grant `SELECT` theo cột trên `org_role_permissions`, `permission_requires`; kiểm `READ COMMITTED` rồi lấy `pg_advisory_xact_lock(tenancy_org_lock_key(org))` trước khi đọc, nên đổi `app.org_id` trước COMMIT không làm nó đạt âm thầm và hai kết nối SQL không khoá không tạo write skew (spike S3B-1, S3B-4). 3D gắn cùng hàm lên hai bảng phạm vi của mình. Trigger `BEFORE INSERT` (`org_role_permissions_guard`) giữ quyền caller và trả `NEW` khi RLS giấu role, để câu ghi chéo org vẫn ra `42501` (S3B-2).
- **`down` không làm mất dữ liệu âm thầm:** `down` của `…_custom_role_permissions` từ chối khi còn role tuỳ biến (đọc `org_roles` theo mẫu `NO FORCE … FORCE` + khẳng định).
- **Migration dữ liệu catalogue** (mẫu 7 bước của spec §8.8) có test chạy thật qua runner: xoá quyền, thêm cạnh `requires` (thu hẹp tới điểm bất động), không rò `IMMEDIATE`, tên constraint deferrable duy nhất, quên bước 6 thì bước 7 rollback cả lô (`test/integration/tenancy/catalogue-data-migration.spec.ts`).
```
`docs/adr/0017-tenancy-own-module.md` — thêm mục sau "## Kết quả spike (plan 3B)":
```markdown
## Cập nhật SP3 (3B) (<ngày merge>)

- Role tuỳ biến: `RoleService` + `POST/PATCH/DELETE /v1/orgs/{orgId}/roles` (`@SensitiveTenancyAction()`), luật 1 (actor trội hẳn CẢ tập cũ lẫn tập mới khi sửa), 2a(i)–(iii) (tập ⊇ `perms(ADMIN)` chỉ owner chạm), 6 (không sửa role mình giữ); event `tenancy.role.created|updated|deleted`.
- Quyền của role tuỳ biến đọc bằng MỘT câu (`RolePermissions`, PK `org_role_permissions_pk`) ở mọi chỗ: câu thứ hai của đường nóng, re-auth trong transaction, đổi role member, `GET …/roles`. Không cache (PR18).
- **Key orphan (R-X23, cùng R-X21 của 3A):** key đã lưu trên role tuỳ biến mà không catalogue nào đã nạp khai báo (module bị tắt) không cấp gì và không làm request lỗi; WARN `orphan_permission_ignored` một lần mỗi key mỗi process + `tenancy_catalogue_orphan_keys`. `PATCH …/roles/{roleId}` có `permissions` gỡ nó; thêm nó → `422 unknown_permission`. Lệch có chủ đích so với U13 của spec (fail loud).
- **Lệch có chủ đích so với spec §6.5 (bài học Task 13 của 3A):** hàm closure là `SECURITY DEFINER` của `tenancy_definer` có khoá advisory theo org; thêm hằng `DEFINER_READ_TABLES_3B`, `DEFINER_TRIGGER_FUNCTIONS_3B`, `DEFINER_INTERNAL_FUNCTIONS_3B`, `TENANCY_TENANT_TABLES_3B` vào test catalog. `down` của 3B từ chối khi còn role tuỳ biến.
- Còn lại cho 3C (spec Bảng 5): `RoleService.delete` chuyển lời mời hết hạn → `EXPIRED`, thu hồi link không còn mở; R-11/R-18 phần lời mời/link; B-22/B-23/B-24 phần lời mời/link. Cho 3D: K-9/K-17 phần key/grant (mở rộng `narrowRolesToFixpoint`), gắn `tenancy_permission_scope_closed_ck` lên bảng phạm vi.
```
Thay `<ngày merge>` bằng ngày thật lúc viết (YYYY-MM-DD).

- [ ] **Step 2: README**

`README.md` — trong mục tenancy (3A đã tạo), thêm ba tiểu mục:
1. **"Role tuỳ biến"**: route (`POST/PATCH/DELETE /v1/orgs/{orgId}/roles`, `If-Match` bắt buộc khi sửa), luật (non-owner chỉ tạo/sửa/xoá/gán thứ nhỏ hơn hẳn mình; tập ⊇ `perms(ADMIN)` chỉ owner; không sửa role mình giữ; tập phải đóng theo `requires` — `422 missing_dependencies` liệt kê key thiếu; `ownerOnly` → `422 permission_not_delegable`; xoá role còn member → `409 role_in_use`), role rỗng hợp lệ; tắt một module khi role tuỳ biến còn giữ quyền của nó: quyền đó thành orphan (không cấp gì, log WARN `orphan_permission_ignored`, metric `tenancy_catalogue_orphan_keys`), owner dọn bằng `PATCH …/roles/{roleId}` gửi lại `permissions` (danh sách `GET` trả về đã không có key orphan).
2. **"Vòng đời quyền"**: bảng của spec §8.8 (Thêm / Deprecate (bản N) / Xoá (bản N+1) / Thêm cạnh `requires` / Bỏ cạnh / Đổi tên / Tách), mỗi dòng một câu cách làm; ghi rõ "vòng đời không bao giờ mở rộng quyền" và `tenancy.role.updated` có actor `system:catalogue-migration:<tên>`.
3. **"Mẫu migration dữ liệu catalogue (7 bước)"**: chép NGUYÊN VĂN các khối SQL mà `test/support/catalogue-migration.ts` sinh (`sevenStep` với `removePermissionDml` làm ví dụ cho key `billing.export` giả định), kèm bảy câu giải thích của spec §8.8 (không giả định chế độ constraint; NO FORCE từng bảng theo thứ tự `CATALOGUE_DATA_TABLES`; DML + tăng version + event; xả trigger hoãn theo tên, không bao giờ `ALL`, tên deferrable duy nhất theo schema, quy ước `<bảng>_<luật>`; trả về chế độ khai báo; FORCE lại; khối khẳng định), và cảnh báo vận hành: `ACCESS EXCLUSIVE` trên `org_roles`/`org_role_permissions` chặn câu đường nóng của mọi request tenant tới hết lô → chạy trong cửa sổ ít tải, `lock_timeout` 5 s. Thêm một dòng runbook rollback 3B: `down` từ chối khi còn role tuỳ biến; chuyển member về role hệ thống, xoá role tuỳ biến, rồi chạy lại.

- [ ] **Step 3: Bỏ nhãn `(3B)` ở spec cha**

Run: `grep -n "(3B)" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`
Với mỗi dòng tìm được: xoá đúng chuỗi ` (3B)` (hoặc `(3B)` đứng riêng) để câu mô tả tính năng thành hiện tại; không sửa chữ nào khác. Câu mang nhãn `(3C)`/`(3D)` giữ nguyên.
Run lại: `grep -c "(3B)" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0005-multi-tenant-rls.md docs/adr/0017-tenancy-own-module.md README.md docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
git commit -m "docs(tenancy): custom roles, permission lifecycle and the seven-step data migration template; ADR 0005/0017 for plan 3B; drop the (3B) labels from the parent spec"
```

---

### Task 14: Kiểm chứng toàn nhánh, push, một PR cho 3B, CI xanh hoàn toàn

**Files:**
- Không file mới. Sửa bất kỳ file nào cần để pipeline xanh (mỗi sửa là commit riêng có lý do).

**Interfaces:**
- Consumes: mọi task 1–13.
- Produces: nhánh `sp3b-custom-roles` trên `origin`, một PR `sp3b-custom-roles → main` với mọi check CI xanh.

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
Expected: mọi lệnh exit 0; đọc output thật:
- `pnpm test`: `migration-scan.spec.ts`, `migration-order.spec.ts` (migration 3B mới nhất, timestamp > `main`), `hardcode-scan.spec.ts`, unit tenancy (R-*, U15 role, B-*).
- `pnpm test:int`: `migrations.spec.ts` (up → down → up và sweep S2-R57 gồm migration 3B, database riêng), `rls-catalog.spec.ts` (hằng 3B), `normalization-inventory.spec.ts` (+`org_role_permissions`), `custom-role-permissions-down.spec.ts`, `role-permissions-db.spec.ts`, `catalogue-data-migration.spec.ts`, `hot-path-explain.spec.ts` (copy hai khối plan in ra log vào mô tả PR), mọi e2e tenancy (gồm ma trận G-6 bốn cột, race X-1/X-2/X-3/X-5).
- `pnpm test:chaos`: hai file chaos 3B cùng chaos của 3A.
- `pnpm test:smoke`: image production thật, log sạch, teardown sạch.
- `.env.example` không đổi (3B không thêm config); `openapi.json` khớp code; `oasdiff` của CI chỉ thấy thêm.
Lệnh nào đỏ: tìm nguyên nhân gốc (skill `superpowers:systematic-debugging`), sửa, commit, chạy lại **toàn bộ** Step 1.

- [ ] **Step 2: Kiểm tay trước khi push**

Run:
```bash
git fetch origin main
git log --oneline origin/main..HEAD
git status --short
git diff --stat origin/main...HEAD
ls test/integration/spike-sp3b 2>/dev/null || echo "no spike code"
```
Expected: `git status` sạch; commit theo task, message conventional tiếng Anh; không file spike (`no spike code`), không file tạm, không secret; migration 3B có timestamp lớn hơn migration mới nhất trên `origin/main`.

Nếu `main` đã nhận plan khác của sóng W2 trong lúc làm, rebase rồi xử lý theo plan đã merge, sau đó chạy lại **toàn bộ** Step 1:
- **Mọi trường hợp có migration mới trên `main`:** tạo lại file migration 3B bằng CLI để timestamp lớn hơn (`migration-order.spec.ts`), rồi chạy riêng trước `pnpm vitest run --project unit test/unit/migrations` và `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/migrations.spec.ts`.
- **6.0 đã merge:** 6.0 sửa `rls-catalog.spec.ts` (hai role NOLOGIN mới, `EXPECTED_PRIVS`) và thêm migration. Khi rebase, giữ cả phần 6.0 lẫn phần 3B của Task 2 Step 1 (hai phần độc lập: 3B chỉ thêm cột/bảng của `org_role_permissions`, `permission_requires`); chạy lại `rls-catalog`, `migration-scan`. Ba event `tenancy.role.*` thêm `audit: true, webhook: false` (Task 6 Step 1).
- **4A đã merge:** `entitlements.read` vào `perms(ADMIN)` và `perms(MEMBER)`, và `EntitlementPermissionsCatalogueModule` vào `startTenancyApp()`/`tenancyCoreImports()`. Không sửa test 3B nào: `ADMIN_KEYS`, C1 tính từ catalogue gộp lúc chạy (R-X24), nên V/V′ vẫn ≡ ADMIN và C1 vẫn trội MEMBER. Chạy lại mọi e2e role (`pnpm vitest run --project integration test/e2e/tenancy`) và `hot-path-explain.spec.ts`; ca nào đỏ là lỗi thật (không phải số cứng lỗi thời), tìm nguyên nhân gốc.
- **7A đã merge:** `README.md` đã `git mv` sang `docs/boilerplate/README.md` (luật giải xung đột của plan 7A, Global Constraints): ba tiểu mục của Task 13 Step 2 vào `docs/boilerplate/README.md`, liên kết tương đối đổi theo Task 11 Step 1 của 7A, `README.md` gốc giữ hạt giống 3 dòng. 7A cũng sửa `normalization-inventory.spec.ts` (hằng gộp) và `migration-order.spec.ts` (so theo vùng): khi rebase giữ dòng `'public.org_role_permissions'` của Task 2 Step 1 trong hằng gộp của 7A, chạy lại `normalization-inventory.spec.ts` và `test/unit/migrations`.

- [ ] **Step 3: Push và mở PR**

Run:
```bash
git push -u origin sp3b-custom-roles
gh pr create --base main --head sp3b-custom-roles --title "SP3 plan 3B: custom roles and anti-escalation" --body-file "$TMPDIR/sp3b-pr.md"
```
Nội dung `$TMPDIR/sp3b-pr.md` (viết trong scratchpad, không commit):
```markdown
## SP3 plan 3B — custom roles and anti-escalation

Spec: docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md (r8, §22.3 Bảng 1–5, dòng 3B)
Plan: docs/superpowers/plans/2026-09-29-sp3b-custom-roles.md
ADR: 0017 (spike S3B-1…4, cập nhật 3B), 0005 (cập nhật 3B)

### Nội dung
- migration `tenancy/…_custom_role_permissions`: `org_role_permissions` (RLS FORCE, FK kép CASCADE, guard, closure `SECURITY DEFINER` dùng chung với 3D), `down` từ chối khi còn role tuỳ biến
- `RoleService` + `POST/PATCH/DELETE /v1/orgs/{orgId}/roles`, luật 1 (tập cũ và mới), 2a(i)–(iii), 6; event `tenancy.role.*`
- `RolePermissions`: câu thứ hai của đường nóng, re-auth, đổi role member dùng chung một câu
- mẫu migration dữ liệu catalogue 7 bước + K-9/K-9b/K-9c/K-17 (role)

### Kiểm chứng (lệnh và kết quả thật)
<output tóm tắt của từng lệnh Step 1: số test pass theo project, thời gian>

### EXPLAIN (ANALYZE, BUFFERS) — câu thứ hai của đường nóng, 10 000 org
<khối plan do hot-path-explain.spec.ts in ra>

### Image (ADR 0013)
<chưa nén / nén / chênh so với "SP3 (3A)" — số của Task 12>

### Rủi ro còn lại
- `ACCESS EXCLUSIVE` của migration dữ liệu catalogue chặn đường nóng tới hết lô (runbook: cửa sổ ít tải).
- Không giới hạn số role tuỳ biến mỗi org (spec không có quy tắc; `GET …/roles` trả mọi role).
```
Thay ba khối `<…>` bằng dữ liệu thật của lần chạy trước khi `gh pr create`.

- [ ] **Step 4: Chờ CI, sửa tới khi xanh**

Run: `gh pr checks --watch`
Expected: mọi check xanh (lint/arch/typecheck/unit, integration, chaos, env drift, openapi + oasdiff chỉ thêm, migration order, build image, smoke). Check đỏ: `gh run view <id> --log-failed`, tìm nguyên nhân gốc, sửa, commit, push, chờ lại. Không `--no-verify`, không tắt check, không đánh dấu flaky để qua.

- [ ] **Step 5: Báo cáo**

Báo Sếp: link PR, danh sách check xanh (`gh pr checks`), số test theo project, số đo image, rủi ro còn lại, việc chuyển sang 3C ∥ 3D. Không merge (merge là quyết định của Sếp).

---

## Self-review

### 1. Độ phủ spec (§22.3 Bảng 1 và Bảng 3, dòng 3B)

| Hạng mục spec | Task |
|---|---|
| Migration `…_custom_role_permissions` (bảng, index, RLS, policy, grant, trigger guard, hàm closure dùng chung, constraint trigger), `down` | 2 (spike 1) |
| Luật 1 (cả `oldSet` lẫn `newSet`), 2a(i)–(iii), 6 | 4 (U), 6 (E) |
| `RoleService`; route `POST/PATCH/DELETE …/roles` (§12: `@Idempotent()`, `If-Match`, `409 role_in_use`) | 6 |
| Câu thứ hai của đường nóng §7.3 + EXPLAIN 10 000 org | 5 |
| Mẫu migration dữ liệu 7 bước (§8.8) + dòng vòng đời "thêm `requires`"/"xoá" cho role | 11 (test), 13 (README) |
| Event `tenancy.role.*` | 6 (API), 11 (migration) |
| Không thêm config | Global Constraints; Task 14 kiểm `.env.example` không đổi |
| R-1…R-20 | 4 (U: 1, 2, 4–9, 12, 15–17, 19), 6 (E: 1–7, 9–17, 20), 5 (R-14 SQL), 7 (R-8, R-19 E) — R-11/R-18 phần lời mời/link: xem mục 6 |
| B-1, B-2, B-3, B-7, B-19, B-21, B-22 (X tuỳ biến), B-23 (gán trực tiếp), B-24 (hạ/xoá) | 4 (U), 5 (B-21 E), 7 (E) |
| U15 (đường role) | 4 |
| X-1, X-2, X-3, X-5 (role tuỳ biến) | 8 |
| K-9, K-9b, K-9c, K-17 (phần role) | 11 |
| §18.1 isolation + ràng buộc `org_role_permissions` (role hệ thống / ownerOnly / deprecated / không đóng) | 3 |
| G-6 thêm C1 | 10 |
| Session mới cho route role (R-20) | 6, 10 |
| Smoke 3B | 3 (schema), 12 (luồng) |
| Bảng 4: tiêu chí 1, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18 (kiểm lại phần 3B) | 1: 3; 3/18: 6 (inventory + G-8 boot), 10; 4: 4–8; 11: 6, 9; 12: 9; 13: 10; 14: 11; 15: 2; 16: 9; 17: 14 |
| Bảng 5 cột 3B: đường nóng; `assertCanBind`/2a/`MemberService`; thứ tự xoá cứng; hằng catalog; inventory chuẩn hoá; G-6; §14.1/§15/§16; K-9; ADR 0013 | 5; 5; 2; 2; 2; 10; 6, 4; 11; 12 |
| Bỏ nhãn `(3B)` của spec cha | 13 |
| R-X23 (key orphan trên role tuỳ biến: đường nóng bỏ qua + WARN + metric; sửa role gỡ được, không thêm được) | 5 (U: `customRolePermissions`, `RolePermissions`), 6 (`RoleService.update`), 7b (E) |
| R-X24 (tập quyền trong test tính từ catalogue gộp) | 3 (`roleSetC1`, `adminKeys`, `TENANCY_ONLY_CATALOGUE`), 4–10 (mọi chỗ dùng C1/ADMIN), 7 (số dòng `permissions` so với đầu file) |

### 2. Race của 3B (spec Bảng 2) → cơ chế → test

| Race | Cơ chế | Test |
|---|---|---|
| T-8 (gán R ∥ R được thêm quyền người gán không có) | Cả hai khoá org `FOR NO KEY UPDATE` trước; sửa role khoá thêm dòng role; tập quyền đọc SAU khoá (READ COMMITTED) | Task 8 X-2 (barrier, ×20; nếu cả hai 200 thì event gán đứng trước event sửa) |
| T-9 phần member (xoá role ∥ gán nó) | Khoá org; FK `org_members_role_fk RESTRICT` → `409 role_in_use`; role đã xoá → `422` khi gán | Task 8 X-3; Task 3 (`23001` bằng SQL); Task 6 R-11 |
| T-24 + X-5 với role tuỳ biến | Thứ tự khoá cố định org → role → member (id tăng dần) | Task 8 X-5 (không 5xx, không deadlock, mọi tập đóng, INSERT feature < 1 s) |
| T-10 với actor giữ role tuỳ biến | `ActorReauthorizer` đọc tập role tuỳ biến trong transaction (`RolePermissions`) | Task 8 Step 3 (X-4: seam `afterGuard` gỡ `members.role.assign` khỏi role tuỳ biến CỦA actor → `403` từ lần kiểm trong transaction); Task 8 X-1 (actor role hệ thống: owner hạ A2 ∥ A2 gán) |
| R3B-1 (mới): thêm quyền phụ thuộc ∥ bỏ quyền bị yêu cầu, hai kết nối SQL không khoá | Hàm closure `SECURITY DEFINER` lấy khoá advisory theo org rồi đọc snapshot mới | Task 1 S3B-4, Task 3 — lịch tất định cả hai chiều (x `SET CONSTRAINTS … IMMEDIATE` giữ khoá; chờ y đứng chờ khoá advisory trong `pg_locks`; x commit; y bị từ chối). Bỏ khoá advisory → test đỏ (kiểm đột biến ghi vào commit) |
| R3B-2 (mới): hai lần tạo cùng tên | Partial `UNIQUE org_roles_name_uq` → `409 role_name_taken` | Task 8 |
| R3B-3 (mới): hai `PATCH` cùng ETag | Khoá role `FOR NO KEY UPDATE`, so `version` dưới khoá → `412` | Task 8 |
| Đổi `app.org_id` trước COMMIT để né kiểm closure | Hàm closure `SECURITY DEFINER` đọc qua policy definer | Task 1 S3B-1, Task 3 |

### 3. Quét chỗ trống

Không có "TBD"/"TODO"/"xử lý sau". Các `<…>` còn lại chỉ ở: kết quả spike (Task 1 Step 3), ngày merge (Task 13), số đo và output thật trong mô tả PR (Task 14) — đều là dữ liệu của lần chạy, được ghi rõ phải thay bằng số thật trước khi commit/đăng. `Migration<ts>_…` là tên CLI sinh (quy ước của plan 3A).

### 4. Nhất quán tên và kiểu

- `RolePermissions.of/ofMany(RoleRef)` (Task 5) được dùng ở middleware, `ActorReauthorizer`, `MemberService`, `RoleService` (Task 6), `RolesController`; `RoleRow`/`MemberRow` thoả `RoleRef` (có `id`, `systemKey`; member dùng `{ id: roleId, systemKey }`).
- `effectivePermissions(role, merged)` (Task 5) giữ nguyên chữ ký 3A, chỉ cho role hệ thống; role tuỳ biến đi `RolePermissions` → `customRolePermissions(stored, merged): { granted, orphans }`. `RolePermissions.detailOf` chỉ `RoleService.update` dùng (gỡ orphan); mọi chỗ khác dùng `of`/`ofMany` (tập đã cấp).
- `checkCustomRoleSet` trả `reason` trùng tên khoá `TenancyErrors` (`UNKNOWN_PERMISSION`, `PERMISSION_NOT_DELEGABLE`, `MISSING_DEPENDENCIES`); `RoleService.validated` `switch` vét cạn.
- `EscalationRule` thêm `'1' | '6'`, lý do thêm `'CANNOT_EDIT_OWN_ROLE'` (Task 4) — `EscalationGuard` sửa cùng task để `switch` vét cạn còn biên dịch.
- Seed: `seedCustomRole → SeededRole { id, publicId, name }`, `seedMemberInRole(org, SeededRole, subject)`; `ROLE_SET_C0`, `ROLE_SET_C2` (hằng), `roleSetC1(merged)`, `adminKeys(merged)` (tính lúc chạy) dùng ở Task 3, 5–10; `TENANCY_ONLY_CATALOGUE` chỉ ở test không có app trong process (Task 3 DB, Task 5 EXPLAIN, Task 9 PII).
- Metric/log key orphan: `TenancyMetrics.catalogueOrphanKeys` (`tenancy_catalogue_orphan_keys`, 3A Task 20b), event log `orphan_permission_ignored` — cùng tên ở `RolePermissions` (Task 5), unit (Task 5), e2e (Task 7b).
- ETag trả về là dạng yếu `W/"n"` ở mọi assert (Task 6, 7b, 12), khớp `etagOf` của core.
- Constraint: `org_role_permissions_pk`, `_role_fk`, `_permission_fk`, `_permission_idx`, `_guard`, `_custom_only`, `_not_delegable`, `_deprecated`, `_closed_ck` — cùng tên ở migration, map lỗi (Task 6), test (Task 3), smoke (Task 3).

### 5. Lệch có chủ đích so với tên/chữ trong spec

1. Hàm closure `tenancy_permission_scope_closed_ck` là `SECURITY DEFINER` của `tenancy_definer`, kiểm `READ COMMITTED` và lấy khoá advisory theo org (spec §6.5 không nói; bài học Task 13 của 3A: trigger hoãn quyền caller dưới FORCE RLS đạt âm thầm khi đổi `app.org_id`). Kéo theo policy `org_role_permissions_definer_read`, grant `SELECT` theo cột cho `tenancy_definer` trên `org_role_permissions` và `permission_requires`, hằng catalog `*_3B`.
2. `down` của migration 3B từ chối khi còn role tuỳ biến (spec §6.13 chỉ ghi "DROP TABLE; DROP FUNCTION"); lý do: không mất quyền của member âm thầm, code 3A sau rollback ném 500 cho role tuỳ biến.
3. Câu thứ hai của §7.3 viết `rp.org_id = app_current_org() AND rp.role_id = ANY(?)` (một câu cho cả lô, dùng lại cho `GET …/roles`) thay `$2/$3`; cùng index PK.
4. X-1: người hạ A2 là owner (spec "A1 hạ A2"; S3-P1 cấm admin quản lý admin nên ca đó luôn `403`, không có race).
5. R-15: ADMIN tạo role bằng đúng tập ADMIN nhận `403 owner_only` (2a xét trước ⊊); ca "⊊ thuần" chứng minh bằng CW (C1 + `roles.write`) → `403 escalation_denied`.
6. K-9 "gọi → 403": chứng minh bằng câu thứ hai của đường nóng (`ROLE_PERMISSIONS_SQL`) trên DB của migration mẫu; đường HTTP "bỏ quyền → request kế tiếp 403" là R-14 (Task 5, 6).
7. Guard `BEFORE INSERT` trả `NEW` khi không thấy role/quyền (để `WITH CHECK`/FK quyết định mã), giữ `42501` cho câu ghi chéo org (tiêu chí 1).
8. Test giết api (tiêu chí 11) giữ khoá dòng `permissions` để transaction dừng SAU khi dòng role đã ghi, thay vì giữ khoá org như 3A (chỗ dừng đó trước mọi câu ghi).
9. **Key orphan trên role tuỳ biến (R-X23 thay U13/SEC-M10 cho tập đã lưu của role):** spec §7.3/U13 muốn key đã lưu mà không có trong catalogue gộp là fail loud (500). Theo R-X23 (ruling mới hơn spec, khớp R-X21 của 3A Task 20b), đường nóng bỏ qua key đó (không cấp gì), WARN một lần mỗi key mỗi process + `tenancy_catalogue_orphan_keys`; `PATCH …/roles` có `permissions` gỡ nó, thêm nó → `422 unknown_permission`. Không phân biệt "module tắt" với "pod lệch version": cả hai đều là key không route nào của pod này đòi được, và boot của 20b đã không từ chối key chỉ có ở DB, nên ném ở đây chỉ biến lệch version thành 500 cho người dùng.

### 6. Hạng mục của dòng 3B chưa đặt được (và lý do)

- **R-11 phần "lời mời `PENDING`/link đang mở"** và **R-18** (xoá role chỉ còn lời mời đã kết thúc → `role_id` thành `NULL`): cần `org_invitations`/`org_invite_links` của 3C. 3C sở hữu `RoleService.delete` phần lời mời/link (spec Bảng 5) và B-15 (xoá C1 khi còn lời mời → `409`). **Carry có tên (cần controller):** spec §22.3 Bảng 3 giao R-1–R-20 cho 3B, nên R-18 và phần lời mời/link của R-11 chỉ có chủ khi controller ghi chúng vào plan 3C ("3C test R-11 (lời mời/link) và R-18 qua `RoleService.delete` của 3B") hoặc sửa dòng 3B/3C của Bảng 3. Plan 3B không tự sửa spec hay plan 3C.
- **B-22 (mời/tạo link/thu hồi key với `ADMIN`), B-23 (lời mời/link mang V′), B-24 (thu hồi key của Bob; lời mời bị vô hiệu lúc chấp nhận)**: thuộc 3C/3D theo chính Bảng 3; 3B phủ phần gán trực tiếp và hạ/xoá.
- **K-9/K-17 cho key và grant**: 3D mở rộng `narrowRolesToFixpoint` (Bảng 5 dòng "Test K-9").

### 7. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **S3B-1:** `RAISE … CONSTRAINT = TG_NAME` trong hàm dùng chung đưa đúng tên trigger tới lỗi COMMIT và `defineConstraintErrors` map được (T3 của 3A chỉ chứng minh với tên hằng). Kiểm ở Task 1; fallback: hàm riêng mỗi bảng.
2. **S3B-4:** khoá advisory trong trigger hoãn chặn write skew hai kết nối (cùng mẫu trigger owner cuối của 3A, nhưng câu đọc là `EXECUTE` động). Kiểm ở Task 1, Task 3.
3. **S3B-3:** `CASCADE` của FK kép xoá dòng quyền dưới FORCE RLS khi `app_user` xoá role (hành động RI bỏ qua RLS). Kiểm ở Task 1.
4. **PgBouncer đóng connection server khi client chết giữa transaction** để transaction đang chờ khoá rollback (Task 9); nếu backend commit, test đỏ và phải đổi chỗ dừng.
5. **`pg_blocking_pids` và `pg_stat_activity` đọc được bằng `app_owner`** cho barrier (Task 8) — test 3A đã đọc `pg_locks` bằng owner; `pg_blocking_pids` là hàm công khai.
6. **R-X3 / plan 6.0** (cùng sóng W2): nếu 6.0 merge trước và `defineEvent` đòi cờ `audit`/`webhook`, ba event role thêm cờ theo giá trị 6.0 đã chốt cho event `tenancy.*`.
7. **Tên của 3A** lấy từ khối "Produces" của plan 3A (code 3A Task 21–31 và 20b chưa có trên nhánh lúc sửa plan); Step 0 của Task 2 đối chiếu với code đã merge.
8. **Metric của 3A Task 20b** là một `Counter` tên `tenancy_catalogue_orphan_keys` trên `TenancyMetrics`, gọi được `add(1)` không attribute (plan này gọi field là `catalogueOrphanKeys`). Lúc sửa plan, 20b đang làm (chưa commit): test của nó spy `app.get(TenancyMetrics).catalogueOrphanKeys` và kỳ vọng boot gọi `add(2)` cho hai key orphan, không attribute, WARN `{ event: 'catalogue_orphan_keys', keys }` — khớp tên và cách đếm theo key của plan này (event hot path `orphan_permission_ignored` khác tên để không lẫn). Task 2 Step 0 vẫn kiểm trên code đã merge; sai khác về kiểu/attribute thì dừng hỏi controller. "Đếm" của R-X23 ở đường nóng: một lần mỗi key mỗi process, cùng lúc với WARN.
9. **`vi.spyOn(Logger.prototype, 'warn')`** bắt được `this.logger.warn` của `RolePermissions`: `node_modules/@nestjs/common/services/logger.service.js` khai `warn` là method instance trên prototype (dòng 77; bản `static warn` là hàm khác). Unit Task 5 chứng minh trước khi e2e Task 7b dựa vào nó.

### 8. Review Focus → test

| # | Test |
|---|---|
| 1 | Task 4 (`roleName`), Task 6 (`1: role names …`), Task 3 (CHECK đếm code point) |
| 2 | Task 6 (`2: a PATCH that changes nothing …`) |
| 3 | Task 6 (`3: If-Match on PATCH roles …`), Task 8 (R3B-3) |
| 4 | Task 4 (`the empty set passes`), Task 6 (`4: an empty role …`) |
| 5 | Task 6 (`5: role ids that are not UUIDs …`, R-10, R-13), Task 7 (`Review Focus 5 …`) |



### 9. Sửa theo review (wave-2 plan review 3B: I-1…I-5, M-1…M-8; ruling R-X23, R-X24)

- **I-1 (ETag):** mọi assert header `ETag` đổi sang dạng yếu `'W/"n"'` (Task 6 R-1, R-14, Review Focus 2, 3; Task 7b; Task 12 smoke), khớp `etagOf` của `src/core/http/conditional.ts` (ADR 0007). Giá trị gửi lên ở `If-Match` (`'"1"'`, `'W/"1"'`) giữ nguyên vì `assertIfMatch` bỏ `W/`. Review Focus 3 ghi rõ dạng yếu.
- **I-2 (tập viết cứng; controller chốt R-X24):** `ROLE_SET_C1` và hai hằng `ADMIN_KEYS` bị bỏ. `tenancy-seed.ts` có `roleSetC1(merged)`, `adminKeys(merged)`, `TENANCY_ONLY_CATALOGUE`; e2e tính từ `app.get(PermissionCatalogueRegistry).merged()` (Task 5, 6, 7, 8, 9 chaos, 10), test không có app trong process dùng catalogue tenancy (Task 3 DB, Task 5 EXPLAIN, Task 9 PII), unit tính từ `sys('MEMBER')` (Task 4). Task 7 bỏ số cứng "19": `permissionRowCount()` đọc lúc `beforeAll`, khẳng định lại ở `afterAll`. Task 14 Step 2 có nhánh "4A đã merge". Review Focus 2 dùng C1 đảo thứ tự thay danh sách viết tay.
- **I-3 (key orphan; controller chốt R-X23, cách (a) không cần tập orphan lúc boot):** `effectivePermissions` giữ chữ ký 3A cho role hệ thống; `customRolePermissions` (thuần) tách `granted`/`orphans`; `RolePermissions` WARN + `tenancy_catalogue_orphan_keys` một lần mỗi key mỗi process, không bao giờ ném cho orphan; `RoleService.update` dùng `detailOf` và `PATCH` có `permissions` luôn gỡ orphan; thêm orphan → `422 unknown_permission` (qua `checkCustomRoleSet`). Test: unit Task 5 (hàm thuần, WARN/metric một lần), e2e mới Task 7b (không 500, không cấp gì, WARN + metric trên app thật; gỡ bằng PATCH; rename giữ nguyên; thêm lại 422 ở PATCH và POST; xoá role giữ orphan 204). Global Constraints "Fail loud" và Self-review §5 mục 9 ghi ngoại lệ.
- **I-4 (write skew không tất định):** S3B-4 (Task 1) và R3B-1 (Task 3) viết lại theo mẫu `definer-triggers.spec.ts:249-274` của 3A, cả hai chiều (thêm trước ∥ bỏ trước): x `SET CONSTRAINTS org_role_permissions_closed_ck IMMEDIATE` giữ khoá, y gửi `COMMIT`, chờ `pg_locks … advisory AND NOT granted` cho pid của y, x commit, y bị từ chối `org_role_permissions_closed_ck`, tập cuối đóng. Có bước kiểm đột biến (bỏ khoá advisory → đỏ) ghi vào ADR/commit.
- **I-5 (chaos câu thứ hai):** ca đường nóng của Task 9 không bật blackhole trước request nữa; `SqlRoleRepository` được thay (qua `overrideProvider(...).useFactory`, `RoleRepository` là `useExisting`) bằng lớp con bật blackhole ngay trong `permissionKeys`, sau khi câu membership đã xong. Assert `503 service_unavailable` + `Retry-After`, seam đã chạy, và metric `tenancy_org_access_total{via=MEMBERSHIP,result=unavailable}` +1 (chứng minh lỗi đi qua `try/catch` của `lookup()`).
- **M-1:** Task 6 Step 1 ghi thẳng `audit: true, webhook: false` cho ba event `tenancy.role.*` (plan 6.0 Task 16 Step 2; SP6 §5.3, §8.3), không sửa bảng `EXPECTED` của 6.0.
- **M-2:** Task 8 Step 3 thêm X-4 với role tuỳ biến CỦA actor vào `member-toctou.e2e.spec.ts` (seam `afterGuard` gỡ `members.role.assign` → `403` từ kiểm trong transaction, target giữ role); bảng race cập nhật.
- **M-3:** X-5 (Task 8) khẳng định `owners ≥ 1`, và O2 thành một đích của các lần gán để trigger owner cuối thật sự bị chạm.
- **M-4:** K-9b (c) (Task 11) thêm ca "FK KHÔNG deferrable cùng tên với trigger deferrable" (R5-C1); `it.each` đổi sang mảng câu lệnh + hậu tố tên.
- **M-5:** R-18 và phần lời mời/link của R-11 ghi thành carry có tên cần controller (mục 6); plan 3B không tự sửa spec/plan 3C.
- **M-6:** Task 5 Step 3 sửa chữ thành 7 lời gọi (middleware 1, `ActorReauthorizer` 1, `MemberService` 3, `RolesController` 2), đã đối chiếu plan 3A.
- **M-7:** smoke Task 3 kiểm FORCE bằng `TENANCY_TENANT_TABLES_3B`.
- **M-8:** Task 14 Step 2 liệt kê việc khi rebase qua 6.0 (giữ phần 6.0 của `rls-catalog.spec.ts`, chạy lại `rls-catalog`, `migration-scan`), 4A (chạy lại e2e role, không sửa tập) và 7A (README sang `docs/boilerplate/README.md`, hằng gộp của `normalization-inventory`, `migration-order` theo vùng).
