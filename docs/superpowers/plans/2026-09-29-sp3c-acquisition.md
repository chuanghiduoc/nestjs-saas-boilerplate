# Sub-project 3C — Thu nhận (acquisition: lời mời email, invite link, chuyển quyền sở hữu): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm vào module `tenancy` (3A + 3B đã merge) ba đường thu nhận thành viên và chuyển quyền: lời mời email một lần (token 256 bit chỉ lưu SHA-256, chấp nhận đúng một lần, email đã xác thực phải trùng), invite link dùng chung có trần lượt dùng atomic, chuyển quyền sở hữu hai bên có `step_down_to`; mọi đường gán role qua `assertCanBind` và được kiểm lại **cửa + trần + 2a** lúc chấp nhận/join; nối các điểm mở rộng của 3A/3B (xoá mềm, xoá role, gỡ member, xoá tài khoản, `MemberAdmission`); đóng lỗ M7 (chế độ single-org: khôi phục org để lại một member ở hai org); chứng minh bằng test trên Postgres 18 + PgBouncer + Redis + Mailpit thật và smoke image production qua `docker compose --profile app`; 3C ship một mình với CI xanh.

**Architecture:** Migration `tenancy/…_acquisition` (file mới) tạo `org_invitations`, `org_invite_links`, `org_ownership_transfers` (RLS FORCE, policy `TO app_user`, FK kép `SET NULL (<cột>)` + `CHECK` gắn trạng thái, neo `org_id → organizations RESTRICT`), bốn trigger quyền caller (`token_clear_only`, hai `role_not_owner`, `use_count_monotonic`) và ba hàm `SECURITY DEFINER` chỉ đọc của `tenancy_definer` (`tenancy_find_invitation`, `tenancy_find_invite_link` tra token không cần OrgScope; `tenancy_count_user_memberships` cho M7). Migration `notifications/…_acquisition_templates` chèn hai dòng `email_templates`. Route có org (`/v1/orgs/{orgId}/invitations|invite-links|ownership-transfers`) đi qua pipeline 3A; route cầm token (`/v1/invitations/*`, `/v1/invite-links/*`) nằm ngoài path org: tra hàm definer theo hash rồi `OrgScope.run(orgId)` + `UnitOfWork`, khoá org `FOR NO KEY UPDATE` → khoá `tenancy_users` → khoá lời mời/link → đọc người mời `FOR SHARE` và kiểm lại cửa + trần (`GrantorRecheck`) → CAS trạng thái → `MemberAdmission` (nguồn `INVITATION`/`INVITE_LINK`) → outbox, cùng transaction. Hai route preview là `@PublicRoute()` giới hạn theo IP bằng bucket `tenancy.token-preview`. Trạng thái tính năng (`resolveTenancyFeatures`) là hàm thuần dùng chung cho luật config và provider runtime.

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), `@casl/ability` 7.0.1 (đã có từ 3A, không thêm package), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), better-auth 1.7.6, jose (external), zod 4.6.5, uuid 14.0.2, `node:crypto` (`randomBytes`, `createHash('sha256')`), mjml + handlebars (template của notifications), Vitest + Testcontainers, `tcp-proxy.ts`, Docker Compose smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md` (r8, đã chốt; §22.3 Bảng 1–5 dòng 3C là nguồn phạm vi). Kèm theo, cùng ràng buộc: `docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md` (R-X1..R-X27: R-X3 cờ event, R-X7 sóng W3 `3C ∥ 3D ∥ 6A ∥ 6C ∥ 7B`, R-X24 tập quyền trong test tính từ catalogue, R-X25 luật merge sau 7A, **R-X26: 3C sở hữu R-18 và phần lời mời/link của R-11**, R-X27 bảng partitioned không FK `organizations` — ba bảng 3C là bảng thường nên vẫn neo `org_id → organizations`), `docs/superpowers/specs/2026-09-28-sp3-parent-spec-amendments.md` (bỏ nhãn `(3C)` khi merge), ADR 0017, spec cha `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`. Tên code của 3A, 3B, 4A, 6.0, 7A lấy từ `src/` trên `main` (đều đã merge; plan này đã đối chiếu từng interface nó dùng với code tại commit merge PR #8 `055c013`) và được đối chiếu lại ở Step 0 của Task 1. M7 (final review 3A, gửi sang 3C): chế độ single-org đếm bằng `tenancy_count_user_orgs(user, true)`, hàm chỉ tính org xoá mềm khi user là OWNER, nên khôi phục org để lại một MEMBER ở hai org.

**Điều kiện bắt đầu:** 3A, 3B, 4A, 6.0, 7A đã merge vào `main` (spec §22.3: 3C phụ thuộc 3B ở B-10–B-15, B-20, B-23 và `RolePermissions`, `RoleService.delete`, `ROLE_IN_USE`). Nhánh `sp3c-acquisition` tạo từ `main` mới nhất (merge PR #8). 3D chạy song song (R-X7): plan merge sau rebase, giải xung đột văn bản ở các chỗ chung liệt kê ở mục "Chỗ đụng với 3D" (cuối plan), đổi timestamp migration cho lớn hơn migration mới nhất trên `main`, rồi chạy lại **toàn bộ** pipeline.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2, 3A, 3B (Global Constraints của `2026-09-28-sp3a-tenancy-foundation.md` và `2026-09-29-sp3b-custom-roles.md`), cộng các luật của SP3 (spec §3, bắt buộc cho mọi task):

- **Package-first:** 3C không cài package nào (spec §18.4: "3B, 3C, 3D không thêm dependency"). Token và hash dùng `node:crypto` (`randomBytes(INVITE_TOKEN_BYTES = 32)` base64url, `createHash('sha256')`). Không cài `fast-check`.
- **Generator:** `pnpm exec nest g controller|service <path> --no-spec` cho khung Nest; `pnpm exec mikro-orm migration:create --blank --path src/migrations/tenancy --name acquisition` và `… --path src/migrations/notifications --name acquisition_templates`. Tên file do CLI sinh (`Migration<14 chữ số>_<tên>`); plan viết `Migration<ts>_<tên>`; code và test không viết cứng timestamp (tìm theo hậu tố tên). Timestamp lớn hơn migration mới nhất trên `main` (`migration-order.spec.ts`).
- **Không đoán API:** tên của 3A đối chiếu với `src/`; tên của 3B (`RolePermissions.of`, `RoleService.delete`, `TenancyErrors.ROLE_IN_USE`, `seedCustomRole`, `seedMemberInRole`, `roleSetC1`, `adminKeys`, `ROLE_SET_C0`, `ROLE_SET_C2`, `raceOnOrgLock`, `PayrollPermissionsModule`, `installPayrollPermission`, `removePayrollPermission`, `permissionRowCount`) đối chiếu ở Task 1 Step 0. TDD, không `any`, không tắt lint, không `as never`.
- **Bất biến nằm ở DB:** role của lời mời/link không bao giờ là `OWNER` (trigger), lời mời `PENDING` luôn có token + role, token chỉ được xoá (trigger), `use_count ≤ max_uses` và chỉ tăng (`CHECK` + trigger), một lời mời `PENDING` mỗi `(org, email)` và một yêu cầu chuyển quyền `PENDING` mỗi org (partial `UNIQUE`), yêu cầu `PENDING` luôn có đủ hai member (`CHECK`). App kiểm trước chỉ để trả lỗi đẹp. Vi phạm từ trigger: `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = '<tên>'`, map bằng `defineConstraintErrors`.
- **Trigger:** bốn trigger `BEFORE` không hoãn của 3C giữ quyền caller (bài học 3A: chỉ trigger hoãn đọc bảng tenant mới phải là `SECURITY DEFINER`). Hàm definer đọc (`tenancy_find_*`, `tenancy_count_user_memberships`): `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''`, mọi tên ghi `public.`, tham số `NULL`/ngoài biên → `RAISE`, tạo/xoá giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE`, `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO app_user`.
- **Kiểu dữ liệu:** PK `BIGINT GENERATED ALWAYS AS IDENTITY` + `public_id UUID DEFAULT uuidv7()`; `TIMESTAMPTZ`; enum `TEXT` + `CHECK`; `created_at`/`updated_at`; `version INT CHECK (version >= 1)` tăng ở mọi `UPDATE`. Hằng định dạng dùng chung giữa code và `CHECK`: `INVITE_TOKEN_BYTES = 32`, `TOKEN_HASH_BYTES = 32`, `INVITATION_EMAIL_MAX_LENGTH = 254`, `TOKEN_INPUT_MAX_LENGTH = 128`.
- **FK có chủ đích:** `org_id → organizations(id) ON DELETE RESTRICT` trực tiếp cho cả ba bảng (neo trực tiếp, spec §6.1 DB-I8); FK kép tới `org_roles`/`org_members` là `ON DELETE SET NULL (<cột>)` (PG ≥ 15, chỉ cột đó) kèm `CHECK` gắn trạng thái; không `CASCADE`.
- **Mọi index gắn với một query** (ghi trong chú thích migration); index bắt đầu bằng `org_id`, trừ `UNIQUE (token_hash)` phục vụ hàm definer tra token xuyên org.
- **Migration:** SQL bằng `addSql`; `down` đối xứng đã test (up → down → up và sweep S2-R57 trên database riêng), xoá cả hàm trigger; `down` của `…_acquisition` **từ chối** khi còn lời mời `PENDING` chưa hết hạn, link đang mở hoặc yêu cầu chuyển quyền `PENDING` chưa hết hạn (đọc theo mẫu `NO FORCE … FORCE` + khẳng định); `down` của `…_acquisition_templates` fail to (`23503`) khi còn thư dùng key. Không `ALTER DEFAULT PRIVILEGES`, không `isTransactional()`, không `SET CONSTRAINTS ALL`.
- **Chuẩn hoá (≥ 3NF, ưu tiên BCNF):** ba bảng đạt 3NF theo ngoại lệ E1 của spec §6.12 (`role_id → org_id`, `*_member_id → org_id`; `org_id` là thuộc tính khoá của `{org_id, public_id}`), không BCNF; cơ chế giữ nhất quán: FK kép, `SET NULL` chỉ cột con, không grant `UPDATE (org_id)`, `WITH CHECK`, FK `org_id` trực tiếp. Chép bảng chuẩn hoá vào chú thích đầu migration; `normalization-inventory.spec.ts` thêm ba bảng.
- **Mọi race có tên và cơ chế chặn** (bảng race 3C ở Self-review: T-2, T-3, T-4, T-5, T-9 phần lời mời/link, T-11 lời mời/link, T-16, T-18 (O-12), T-21, T-27, T-29, cộng M7). Check-then-insert không bao giờ là cơ chế. Khoá dòng `FOR NO KEY UPDATE`; thứ tự `organizations` → `tenancy_users` → (lời mời/link/chuyển quyền) → `org_members` `FOR SHARE` (id tăng dần). So sánh hết hạn sau khi chờ khoá dùng `clock_timestamp()` (`OrgRepository.clockNow()` hoặc predicate SQL).
- **Không hard code:** giới hạn, thời hạn, URL lấy từ `tenancy.config.ts` (13 env của spec §13 dòng 3C) và `identity.config.ts` (`AUTH_EXTERNAL_EMAIL_CLAIM`, `AUTH_EXTERNAL_EMAIL_VERIFIED_CLAIM`); hằng định dạng ở `constants.ts`. `test/unit/architecture/hardcode-scan.spec.ts` xanh.
- **Mặc định khởi động được ở mọi mode** (spec §13 INT-I12): URL trống → tính năng `auto` tắt (log INFO lý do), không env nào bắt buộc; `on` thiếu điều kiện → không khởi động.
- **Token:** chỉ ở fragment URL (`#token=`), chỉ trong thư (mã hoá at-rest bằng `FieldCipher` của notifications) hoặc trong response `201` tạo link đúng một lần; không bao giờ trong log, span, metric, event, body khác; route tạo link **không** `@Idempotent()` (S3-A8).
- **Chống dò:** mọi lỗi tra token trả **cùng** `404 invitation_not_found` / `404 invite_link_not_found` (không tồn tại, hết hạn, đã dùng/hết lượt, thu hồi, org xoá mềm); `403 invitation_email_mismatch` chỉ sau khi token đúng và không nêu email được mời.
- **Truy cập SQL:** chỉ qua `Db.execute` (placeholder `?`) trên EM đang gắn; hash token truyền dạng hex và giải mã trong SQL (`decode(?, 'hex')`), không truyền `Buffer` qua `formatQuery`; mảng dùng `ARRAY[?]::<kiểu>[]` (bài học 3A: `Db.execute` nội suy mảng thành danh sách). Không I/O ngoài trong `UnitOfWork.run` (đọc `IdentityDirectory` trước transaction).
- **Không PII** trong log/metric/span/failed reason: không email, token, `token_hash`, tên org/role/người; label metric là enum hữu hạn.
- **Cờ event (R-X3, 6.0 đã merge):** mọi event mới của 3C khai `audit: true, webhook: false` (spec SP6 §8.3: sáu event webhook công khai đều là event 3A; không sửa bảng `EXPECTED` của `test/unit/core/events/event-flags.spec.ts`, ca "audited namespaces" tự ép `audit: true` cho mọi `tenancy.*`).
- **Luật kiến trúc:** giữ luật 1–19 của 3A; 3C không thêm luật. Tenancy chỉ import `modules/identity/index.ts` và `modules/notifications/index.ts`.
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** cuối nhóm schema (Task 4: migration 3C chạy từ `dist` trên image), cuối nhóm API (Task 16: luồng mời → thư Mailpit có `#token=` → chấp nhận → đổi role → link join → chuyển quyền trên image) và ở Task 18 chạy lại `pnpm test:smoke` trong pipeline đầy đủ: build image production thật, `docker compose --profile app` với hạ tầng đầy đủ và `NODE_ENV=production`, migrate, smoke HTTP thật trong `test/smoke/`, log container JSON sạch (không PII, không `error`, không token), `/health/ready` 200, rồi `down -v`. Đo lại kích thước image (ADR 0013; ghi dòng mới chỉ khi chênh > 1 MB, hoặc dòng "SP3 (cuối)" nếu 3C là plan merge sau cùng trong 3C ∥ 3D).
- **Spike:** code spike là code bỏ đi (`test/integration/spike-sp3c/`, không commit). Kết quả ghi vào mục "Kết quả spike (plan 3C)" của ADR 0017 và được commit. Spike không đạt thì đi đúng nhánh fallback ghi trong Task 1.
- **README (R-X25, 7A đã merge):** nội dung README và runbook của 3C vào `docs/boilerplate/README.md` (không có thư mục `docs/runbooks/` trên `main`; runbook là tiểu mục của README như 3A/3B). Không thêm import config module vào `gen-env-example.ts`.
- **Vùng upstream (7A):** mọi file mới của 3C nằm dưới tiền tố đã khai ở `.upstream/zones.json` vùng `boilerplate` (`src/modules/`, `src/migrations/`, `test/`, `docs/adr/`, `docs/boilerplate/`, `docs/superpowers/`); không sửa `zones.json`. `test/unit/migrations/migration-zones.spec.ts` xanh.
- **Ghế (4A/4B):** spec SP4 §9.6 giao kiểm `tenancy.seats` cho **4B** (port `MemberSeatLimit` `@Optional()` trong `MemberAdmission`, sau khoá `tenancy_users`, trước `INSERT org_members`). 3C **không** gọi `Entitlements.assertWithinLimit` và không import `entitlements` (luật depcruise SP4 20.8-a cấm tenancy → entitlements). Mọi đường thu nhận của 3C đi qua `MemberAdmission`, nên 4B phủ chúng mà không sửa service của 3C; `plans.example` để `tenancy.seats` ở `fallback` = không giới hạn, nên test 3C (link `N + k`, O-12) không đổi khi 4B merge.
- **Composition (7A):** `MODULE_REQUIRES.tenancy` giữ `['identity']`: tenancy nay import `modules/notifications/index.ts` (`EmailNotifications`, `DISPLAY_NAME_MAX`), và `notifications` đã nằm trong bao đóng `tenancy → identity → notifications` mà `composition-probe.ts` tính (UP-12c xanh, `compose.spec.ts` không đổi).
- **Định dạng:** `pnpm lint` có `prettier --check .`; trước mỗi commit chạy `pnpm exec prettier --write <file đã đổi ngoài docs/>`.
- **Commit:** mỗi task một commit trở lên, conventional message tiếng Anh. Push và mở PR chỉ ở Task 18.
- **Hết hạn suy ra, không quét (spec §9.1, §9.3, §14.1, S3-A24):** lời mời/chuyển quyền `PENDING` quá hạn chỉ được ghi `EXPIRED` khi bị chạm (chấp nhận, thu hồi, mời lại cùng email, tạo yêu cầu mới, xoá role, gỡ member); người đọc thấy `EXPIRED` nhờ hàm thuần với giờ DB. 3C **không** thêm cron/sweep hết hạn (phán quyết ở Self-review §5 mục 1): spec §13 không có env lịch quét, §16 đã bỏ một hàm definer chỉ để đo backlog (INT-M5), và mọi chỗ dòng quá hạn có thể chặn đã tự chạm nó (Task 12 chứng minh từng chỗ).

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không test nào của spec §18 phủ, dễ làm hỏng trải nghiệm người dùng nhất:

1. **Email được mời viết khác dạng với email đã xác thực** (`" Ann@Example.TEST "` so với `ann@example.test`, chữ hoa, khoảng trắng): mong đợi lời mời lưu dạng chuẩn (`trim → lowercase → NFC`, cùng `normalizeEmail` của identity) và người có email đã xác thực `ann@example.test` chấp nhận được (`201`); email thật sự khác → `403 invitation_email_mismatch` mà body không chứa email được mời; địa chỉ không hợp lệ → `422 validation_failed`, không bao giờ `500` từ `CHECK`. Test: Task 9 (`the invited email is normalised and matched case-insensitively; a real mismatch never echoes the invited address`).
2. **Người được mời đã là member của org** chấp nhận lời mời: mong đợi `409 already_member`, lời mời **vẫn `PENDING`** (rollback cả lượt, T-3), không event nào, token vẫn dùng được về sau nếu người đó rời org. Test: Task 9 (`accepting while already a member is 409 already_member and leaves the invitation pending`).
3. **Body token rác ở preview/accept/join** (chuỗi rỗng, 10 KB, ký tự ngoài base64url, số, thiếu trường, khoá lạ): mong đợi thiếu/sai kiểu/quá `TOKEN_INPUT_MAX_LENGTH` → `422 validation_failed`; chuỗi đúng kiểu nhưng không phải token nào → cùng `404 *_not_found` như token hết hạn, không bao giờ `500` (hash luôn 32 byte nên hàm definer không `RAISE`). Test: Task 9 (`garbage tokens are 422 or the uniform 404, never 500`), Task 10 (cùng tên cho link).
4. **Hạn và lượt của invite link ở biên**: `expiresAt` ở quá khứ, bằng đúng lúc này, vượt `now + TENANCY_INVITE_LINK_MAX_TTL_SEC` → `422 ttl_out_of_range`; `maxUses` = 0 hoặc > `TENANCY_INVITE_LINK_MAX_USES_LIMIT` → `422 validation_failed`; không bao giờ `500` từ `CHECK (expires_at > created_at)`. Link tạo với `maxUses = 1`: join lần hai (người khác) → `404`, `status = EXHAUSTED` trong danh sách, không chiếm trần link đang mở. Test: Task 10 (`link TTL and max uses at the boundaries`, `an exhausted link frees a slot of the open-link cap`).
5. **Người không phải bên nhận thao tác trên yêu cầu chuyển quyền**: một member khác (kể cả ADMIN) hoặc chính người khởi tạo gọi `…/accept` hay `…/decline` → `404 not_found` (không lộ yêu cầu), yêu cầu giữ `PENDING`; member thường `GET …/ownership-transfers` chỉ thấy yêu cầu mình là bên gửi/nhận. Test: Task 11 (`only the recipient can accept or decline; others get 404 and the request stays pending`, `non-owners list only their own requests`).

---

## File Structure

```
src/
  migrations/tenancy/        Migration<ts>_acquisition.ts            (mới: 3 bảng, 4 trigger, 3 hàm definer, down có guard)
  migrations/notifications/  Migration<ts>_acquisition_templates.ts  (mới: 2 dòng email_templates)
  modules/tenancy/
    constants.ts             + INVITE_TOKEN_BYTES, TOKEN_HASH_BYTES, INVITATION_EMAIL_MAX_LENGTH, TOKEN_INPUT_MAX_LENGTH,
                               SYSTEM_ROLE_LABELS, STEP_DOWN_ROLES
    tenancy.config.ts        + 12 env của 3C, luật `tenancy-features-on`, luật production `tenancy-frontend-urls`
    errors.ts                + 15 mã 3C + map constraint
    events.ts                + 12 event invitation/invite_link/ownership_transfer
    domain/  acquisition-token.ts · invitation.ts · invite-link.ts · ownership-transfer.ts · display-text.ts ·
             tenancy-features.ts (resolveTenancyFeatures, thuần)
    ports/   invitation-repository.ts · invite-link-repository.ts · ownership-transfer-repository.ts (mới)
             org-repository.ts (+ countMembershipsForUser)
    infra/sql/ sql-invitation.repository.ts · sql-invite-link.repository.ts · sql-ownership-transfer.repository.ts (mới)
             sql-org.repository.ts (+ countMembershipsForUser) · org-purge.sql.ts (+ 3 bảng)
    application/
             member-admission.ts (nguồn INVITATION/INVITE_LINK, M7) · grantor-recheck.ts (mới) ·
             transfer-settlement.ts (mới) · tenancy-features.ts (provider TenancyFeatures, mới) ·
             invite-role.ts · tenancy-user-lock.ts (mới, dùng chung cho chấp nhận/join) ·
             invitation.service.ts · invite-link.service.ts · ownership-transfer.service.ts (mới) ·
             org.service.ts (gọi admit mới) · org-lifecycle.service.ts (xoá mềm thu hồi) · member.service.ts,
             user-deletion.service.ts (huỷ chuyển quyền) · role.service.ts của 3B (xoá role) · tenancy-metrics.ts (+2 counter)
    http/    invitations.controller.ts · invitation-tokens.controller.ts · invite-links.controller.ts ·
             invite-link-tokens.controller.ts · ownership-transfers.controller.ts (mới) · token-preview.bucket.ts (mới) ·
             schemas.ts (+) · policy-metadata.ts (+4 route thu hẹp) · tenancy-http.module.ts (+)
    tenancy.module.ts        + repository, GrantorRecheck, TransferSettlement
  modules/identity/  identity.config.ts (+2 env) · infra/jwks/jwks.provider.ts (claim email) · index.ts (export normalizeEmail)
  modules/notifications/ templates.ts (+2 key) · templates/org-invitation/en/* · templates/ownership-transfer-requested/en/*
openapi.json                  17 operation mới (oasdiff chỉ thêm)
.env.example                  sinh lại (`pnpm env:example`)
test/
  support/  tenancy-catalog.ts (+ hằng *_3C) · tenancy-seed.ts (+ seedInvitation, seedInviteLink, seedTransfer,
            newToken, hashToken) · env.ts (+ 2 URL) · tenancy-acquisition.ts (mới: token từ Mailpit, helper HTTP thu nhận)
  unit/modules/tenancy/  acquisition-token.spec.ts · invitation.spec.ts · invite-link.spec.ts · ownership-transfer.spec.ts ·
            display-text.spec.ts · tenancy-features.spec.ts · tenancy-config.spec.ts · errors.spec.ts (sửa)
  unit/modules/notifications/ templates.spec.ts · renderer.spec.ts (sửa)
  unit/modules/identity/ identity-config.spec.ts (sửa)
  integration/
    core/database/  rls-catalog.spec.ts · normalization-inventory.spec.ts (sửa)
    notifications/  email-templates-lookup-migration.spec.ts (sửa) · acquisition-templates-down.spec.ts (mới)
    tenancy/  acquisition-down.spec.ts · acquisition-db.spec.ts · acquisition-isolation.spec.ts ·
              acquisition-definer.spec.ts · acquisition-repositories.spec.ts · single-org-admission.spec.ts (mới)
  e2e/tenancy/  invitations.e2e.spec.ts · invite-links.e2e.spec.ts · ownership-transfers.e2e.spec.ts ·
              token-preview-limiter.e2e.spec.ts · acquisition-lifecycle.e2e.spec.ts · acquisition-races.e2e.spec.ts ·
              acquisition-external.e2e.spec.ts · acquisition-pii-logs.e2e.spec.ts (mới) ·
              role-route-matrix.e2e.spec.ts · telemetry-pii.e2e.spec.ts (sửa)
  chaos/    tenancy-acquisition-outages.spec.ts · tenancy-acquisition-api-kill.spec.ts (mới)
  smoke/    tenancy.smoke.spec.ts · smoke-app-env.ts (sửa)
docs/adr/  0017 (spike 3C, M7, lệch có chủ đích) · 0005 (bảng + hàm definer 3C) · 0007 (route cầm token, bucket token-preview) · 0013 (khi chênh)
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (bỏ nhãn `(3C)`)
docs/boilerplate/README.md (R-X25: tiểu mục lời mời/link/chuyển quyền + runbook 3C)
```

**Vì sao route cầm token tách controller riêng (`v1/invitations`, `v1/invite-links`):** route tenant phải nằm dưới `v1/orgs/:orgId` (matcher §7.4); route cầm token không biết org cho tới khi tra hash, nên thuộc `OTHER` (không `OrgContextMiddleware`, không `PoliciesGuard`, không `OrgScopeInterceptor`), service tự vào `OrgScope`. Tách lớp giữ quy tắc "decorator quyền chỉ trên route `TENANT`" của `OrgRouteInventory`.

**Vì sao `GrantorRecheck` là một lớp riêng:** lời mời (đường b) và link (đường c) kiểm lại cùng một điều lúc chấp nhận/join (người mời/người tạo hiện tại còn là member, còn `invitations.write`, còn `assertCanBind` gồm 2a). Một chỗ, không hai định nghĩa lệch nhau; lý do vô hiệu (`INVITER_GONE`/`INVITER_LACKS_GATE`/`INVITER_NOT_DOMINANT`) là enum của event.

**Vì sao `TransferSettlement` ở `TenancyCoreModule`:** hai đường gỡ member (`MemberService` ở api, `UserDeletionService` ở `TenancyIdentityPortsModule`) phải huỷ chuyển quyền `PENDING` của member trước khi xoá (spec §9.3, `CHECK` ở §6.9). Provider dùng chung, `@Global` export.

**Vì sao trạng thái hiển thị tính ở app (domain) với giờ DB:** lời mời/chuyển quyền `PENDING` đã quá hạn hiển thị `EXPIRED`, link có trạng thái suy ra (`REVOKED > EXPIRED > EXHAUSTED > ACTIVE`, spec §6.8). Một hàm thuần mỗi loại (unit test mọi nhánh), `now` lấy bằng `OrgRepository.clockNow()` một lần mỗi request; SQL chỉ lọc, không nhân đôi luật.

---

## Phần A — Spike (bắt buộc làm trước mọi task khác)

Spec §4 không giao spike T nào cho 3C (T1–T6, T8 ở 3A; T7 ở 3D). Các giả định dưới đây là của thiết kế 3C (hành động FK `SET NULL (<cột>)` trên FK kép dưới FORCE RLS, `CHECK` gắn trạng thái bắn khi `SET NULL`, trigger `role_not_owner` gặp `UPDATE` do hành động FK sinh ra, mã lỗi của câu ghi chéo org khi có trigger `BEFORE`), chưa ai chạy; mỗi cái trả lời bằng code chạy thật trên database riêng.

### Task 1: Spike S3C-1 … S3C-3 (`SET NULL (cột)` dưới FORCE RLS, `CHECK` gắn trạng thái, trigger `role_not_owner` và mã lỗi chéo org)

**Files:**
- Create (không commit): `test/integration/spike-sp3c/acquisition.spike.spec.ts`
- Modify: `docs/adr/0017-tenancy-own-module.md` (mục "Kết quả spike (plan 3C)")

**Interfaces:**
- Consumes: `createScratchDb`, `runMigrations`, `coreMigrationList` (3A), `applyTestEnv` (SP1), `seedOrg({ database })`, `seedMember`, `withAppClient`, `inOrgTx` (3A Task 14), migration `…_custom_role_permissions` (3B, cho phép role tuỳ biến).
- Produces: kết luận đạt/không đạt của S3C-1 … S3C-3 (bảng ADR 0017), quyết định cách viết migration ở Task 2 và `RoleService.delete` ở Task 12:
  - **S3C-1:** `app_user` trong OrgScope xoá role tuỳ biến mà chỉ lời mời đã kết thúc tham chiếu → câu `DELETE` xanh, `role_id` của lời mời thành `NULL`, `org_id` giữ nguyên (hành động RI chạy bằng quyền owner, bỏ qua RLS). Còn lời mời `PENDING` → `23514` với `constraint = 'org_invitations_pending_role_ck'` (tên tới được `pgFields`). Fallback: FK `RESTRICT` + `RoleService.delete` tự `UPDATE org_invitations SET role_id = NULL WHERE role_id = ? AND status <> 'PENDING'` trước khi xoá (cần grant `UPDATE (role_id)`), ghi ADR 0017.
  - **S3C-2:** trigger `org_invitations_role_not_owner` (`BEFORE INSERT OR UPDATE OF role_id`, quyền caller) cho qua `NEW.role_id IS NULL` (câu `UPDATE` do `SET NULL` sinh ra có `role_id` trong target list), từ chối role `OWNER` với `23514 org_invitations_role_not_owner`; câu `INSERT` với `org_id` của org khác (RLS giấu role của org đó) ra `42501` (`WITH CHECK`), không phải lỗi của trigger. Fallback: trigger ném khi không thấy role; test cô lập kỳ vọng `23514` cho bảng này, ghi ADR 0017.
  - **S3C-3:** gỡ member đang là `from`/`to` của yêu cầu `PENDING` → `23514 org_ownership_transfers_pending_members_ck`; yêu cầu đã kết thúc chỉ mất id member (`SET NULL (from_member_id)`), `org_id` giữ nguyên. Fallback như S3C-1 (RESTRICT + tự gỡ), ghi ADR 0017.

- [ ] **Step 0: Đối chiếu tên của 3A/3B với code đã merge**

Run:
```bash
git fetch origin main && git log --oneline -3 origin/main
ls src/migrations/tenancy
grep -n "export" src/modules/tenancy/application/authz/role-permissions.ts src/modules/tenancy/application/role.service.ts src/modules/tenancy/ports/role-repository.ts
grep -n "ROLE_IN_USE\|org_members_role_fk" src/modules/tenancy/errors.ts
grep -n "export" test/support/tenancy-seed.ts test/support/org-lock-barrier.ts test/e2e/tenancy/fixtures/payroll-permissions.ts
grep -n "async delete" -A20 src/modules/tenancy/application/role.service.ts
grep -n "audit\|webhook" src/core/events/define-event.ts
```
Expected: migration `…_custom_role_permissions` có trên `main`; `RolePermissions` có `of(role: { id; systemKey })`; `RoleService.delete` có chú thích "Điểm mở rộng của 3C" ngay trước `this.roles.deleteById(role.id)`; `TenancyErrors.ROLE_IN_USE`; `seedCustomRole`, `seedMemberInRole`, `roleSetC1`, `adminKeys`, `ROLE_SET_C0`, `ROLE_SET_C2`, `raceOnOrgLock`; fixture payroll. Dòng `grep` cuối cho biết 6.0 đã merge chưa (cờ `audit`/`webhook` của `defineEvent`, R-X3). Tên nào khác khối "Produces" của plan 3B: dùng tên thật của code cho mọi task sau và ghi một dòng vào "Lệch có chủ đích" (cuối plan) trong commit của Task 2. `RoleService.delete` không có chỗ mở rộng như mô tả: DỪNG và hỏi controller.

- [ ] **Step 1: Spike (một file, database riêng, SQL giống hệt DDL của Task 2 cho hai bảng liên quan)**

`test/integration/spike-sp3c/acquisition.spike.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/** DDL dự kiến của migration 3C cho hai bảng spike cần (Task 2 chép nguyên nếu spike đạt). */
const SCHEMA = [
  `CREATE TABLE org_invitations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, public_id UUID NOT NULL DEFAULT uuidv7(), org_id UUID NOT NULL,
    email TEXT NOT NULL, role_id BIGINT NULL, inviter_member_id BIGINT NULL, status TEXT NOT NULL, token_hash BYTEA NULL,
    expires_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ NULL, accepted_member_id BIGINT NULL,
    version INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_invitations_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_invitations_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE SET NULL (role_id),
    CONSTRAINT org_invitations_inviter_fk FOREIGN KEY (org_id, inviter_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (inviter_member_id),
    CONSTRAINT org_invitations_status_ck CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'INVALIDATED')),
    CONSTRAINT org_invitations_pending_token_ck CHECK ((status = 'PENDING') = (token_hash IS NOT NULL)),
    CONSTRAINT org_invitations_pending_resolved_ck CHECK ((status = 'PENDING') = (resolved_at IS NULL)),
    CONSTRAINT org_invitations_pending_role_ck CHECK (status <> 'PENDING' OR role_id IS NOT NULL))`,
  `ALTER TABLE org_invitations ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE org_invitations FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY org_invitations_tenant ON org_invitations TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`,
  `GRANT SELECT, INSERT, DELETE, UPDATE (status, token_hash, resolved_at, version, updated_at) ON org_invitations TO app_user`,
  `CREATE FUNCTION tenancy_org_invitations_role_not_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_system_key text;
BEGIN
  IF NEW.role_id IS NULL THEN RETURN NEW; END IF;
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key = 'OWNER' THEN
    RAISE EXCEPTION 'the owner role cannot be granted by an invitation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invitations_role_not_owner';
  END IF;
  RETURN NEW;
END $$`,
  `CREATE TRIGGER org_invitations_role_not_owner BEFORE INSERT OR UPDATE OF role_id ON org_invitations
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invitations_role_not_owner()`,
  `CREATE TABLE org_ownership_transfers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, public_id UUID NOT NULL DEFAULT uuidv7(), org_id UUID NOT NULL,
    from_member_id BIGINT NULL, to_member_id BIGINT NULL, step_down_to TEXT NULL, status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_ownership_transfers_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_ownership_transfers_from_fk FOREIGN KEY (org_id, from_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (from_member_id),
    CONSTRAINT org_ownership_transfers_to_fk FOREIGN KEY (org_id, to_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (to_member_id),
    CONSTRAINT org_ownership_transfers_pending_members_ck CHECK (status <> 'PENDING' OR (from_member_id IS NOT NULL AND to_member_id IS NOT NULL)))`,
  `ALTER TABLE org_ownership_transfers ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE org_ownership_transfers FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY org_ownership_transfers_tenant ON org_ownership_transfers TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`,
  `GRANT SELECT, INSERT, DELETE, UPDATE (status, resolved_at, version, updated_at) ON org_ownership_transfers TO app_user`,
];
const TOKEN_HEX = 'ab'.repeat(32);

describe('spike 3C: SET NULL (column) under FORCE RLS, state CHECKs and the role_not_owner trigger', () => {
  let db: ScratchDb;
  let a: SeededOrg;
  let b: SeededOrg;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('sp3cspike');
    vi.stubEnv('DB_NAME', db.name);
    await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
    const owner = await db.client('owner');
    try {
      for (const sql of SCHEMA) await owner.query(sql);
    } finally {
      await owner.end();
    }
    a = await seedOrg({ database: db.name });
    b = await seedOrg({ database: db.name });
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });
  const inA = <T>(fn: (c: import('pg').Client) => Promise<T>) =>
    withAppClient((c) => inOrgTx(c, a.orgId, () => fn(c)), db.name);
  const customRole = () =>
    inA(async (c) => (await c.query<{ id: string }>(`INSERT INTO org_roles (org_id, name) VALUES ($1, $2) RETURNING id::text AS id`, [a.orgId, `Spike ${Date.now()}`])).rows[0]!.id);
  const invite = (roleId: string, status: 'PENDING' | 'ACCEPTED') =>
    inA((c) =>
      c.query(
        `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at, resolved_at)
         VALUES ($1, 'spike@example.test', $2, $3, $4, CASE WHEN $4 = 'PENDING' THEN decode($5, 'hex') END, now() + interval '1 day',
                 CASE WHEN $4 = 'PENDING' THEN NULL ELSE now() END)`,
        [a.orgId, roleId, a.owner.memberId, status, TOKEN_HEX],
      ),
    );

  it('S3C-1: a role referenced only by a finished invitation is deleted; role_id becomes NULL, org_id stays', async () => {
    const roleId = await customRole();
    await invite(roleId, 'ACCEPTED');
    await inA((c) => c.query('DELETE FROM org_roles WHERE id = $1', [roleId]));
    const rows = await inA(async (c) => (await c.query(`SELECT org_id::text AS org_id, role_id FROM org_invitations WHERE status = 'ACCEPTED'`)).rows);
    expect(rows).toEqual([{ org_id: a.orgId, role_id: null }]);
  });
  it('S3C-1: a PENDING invitation blocks the role delete with 23514 org_invitations_pending_role_ck', async () => {
    const roleId = await customRole();
    await invite(roleId, 'PENDING');
    await expect(inA((c) => c.query('DELETE FROM org_roles WHERE id = $1', [roleId]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_pending_role_ck',
    });
  });
  it('S3C-2: role_not_owner refuses OWNER, lets NULL through, and a cross-org insert is 42501', async () => {
    await expect(invite(a.roles.OWNER.id, 'PENDING')).rejects.toMatchObject({ code: '23514', constraint: 'org_invitations_role_not_owner' });
    await expect(
      inA((c) =>
        c.query(
          `INSERT INTO org_invitations (org_id, email, role_id, status, token_hash, expires_at) VALUES ($1, 'x@example.test', $2, 'PENDING', decode($3, 'hex'), now() + interval '1 day')`,
          [b.orgId, b.roles.MEMBER.id, 'cd'.repeat(32)],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('S3C-3: removing a member of a PENDING transfer is 23514; a finished transfer only loses the member id', async () => {
    const m = await seedMember(a, 'MEMBER');
    const n = await seedMember(a, 'MEMBER');
    await inA((c) =>
      c.query(
        `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, status, expires_at) VALUES ($1, $2, $3, 'PENDING', now() + interval '1 day')`,
        [a.orgId, a.owner.memberId, m.memberId],
      ),
    );
    await expect(inA((c) => c.query('DELETE FROM org_members WHERE id = $1', [m.memberId]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_ownership_transfers_pending_members_ck',
    });
    await inA((c) =>
      c.query(
        `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, status, expires_at, resolved_at) VALUES ($1, $2, $3, 'DECLINED', now() + interval '1 day', now())`,
        [a.orgId, a.owner.memberId, n.memberId],
      ),
    );
    await inA((c) => c.query('DELETE FROM org_members WHERE id = $1', [n.memberId]));
    const rows = await inA(async (c) => (await c.query(`SELECT org_id::text AS org_id, to_member_id FROM org_ownership_transfers WHERE status = 'DECLINED'`)).rows);
    expect(rows).toEqual([{ org_id: a.orgId, to_member_id: null }]);
  });
});
```

- [ ] **Step 2: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp3c/acquisition.spike.spec.ts`
Expected: PASS cả bốn ca. Ca nào đỏ: đọc lỗi, xác nhận không do code spike (tên cột, quyền), rồi áp đúng fallback của Produces và ghi vào ADR.

- [ ] **Step 3: Ghi kết quả vào ADR 0017, xoá code spike**

`docs/adr/0017-tenancy-own-module.md` — thêm sau mục "Kết quả spike (plan 3B)" (hoặc "(plan 3A)" nếu 3B đặt tên khác):
```markdown
## Kết quả spike (plan 3C)

| # | Câu hỏi | Kết quả | Hệ quả |
|---|---|---|---|
| S3C-1 | FK kép `ON DELETE SET NULL (role_id)` khi `app_user` xoá role dưới FORCE RLS; `CHECK` gắn trạng thái bắn lúc `SET NULL` | <ĐẠT/KHÔNG ĐẠT: một câu mô tả thứ đã quan sát> | <giữ FK SET NULL (cột) + CHECK / fallback RESTRICT + gỡ tay> |
| S3C-2 | Trigger `role_not_owner` quyền caller: cho qua `NULL` của `SET NULL`, từ chối `OWNER`, câu ghi chéo org vẫn `42501` | <…> | <…> |
| S3C-3 | Gỡ member của yêu cầu chuyển quyền `PENDING` → `23514`; yêu cầu đã kết thúc chỉ mất id member | <…> | <…> |
```
Thay `<…>` bằng kết quả thật của Step 2 (đây là dữ liệu đo, chỉ commit sau khi có). Rồi `rm -r test/integration/spike-sp3c`.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0017-tenancy-own-module.md
git commit -m "docs(adr): record the plan 3C spikes (SET NULL column actions under FORCE RLS, state checks, role_not_owner)"
```

---

## Kết quả spike (plan 3C)

Điền sau Task 1 (bảng ở ADR 0017). Nếu một spike đi nhánh fallback, Task 2 và Task 12 áp fallback đó trước khi viết code còn lại, và dòng tương ứng của "Lệch có chủ đích" ghi lại.

---

## Phần B — Schema thu nhận (spec §6.7–6.9, §6.12–6.14, §18.1)

### Task 2: Migration `acquisition` — ba bảng, RLS, bốn trigger, ba hàm definer, `down` có guard; catalog, chuẩn hoá, thứ tự xoá cứng, hằng định dạng

**Files:**
- Create: `src/migrations/tenancy/Migration<ts>_acquisition.ts` (qua CLI), `test/integration/tenancy/acquisition-down.spec.ts`
- Modify: `src/modules/tenancy/constants.ts`, `src/modules/tenancy/infra/sql/org-purge.sql.ts`, `test/support/tenancy-catalog.ts`, `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`, `test/integration/tenancy/seed-helper.spec.ts` (chỉ khi nó so nguyên văn `ORG_PURGE_STATEMENTS`)

**Interfaces:**
- Consumes: bảng `organizations`, `org_roles`, `org_members`, `tenancy_users` (3A), role `tenancy_definer`; hằng `DEFINER_*_3A`, `DEFINER_*_3B`, `TENANCY_TENANT_TABLES_3A/3B` và các hằng hợp của `test/support/tenancy-catalog.ts`; `ORG_PURGE_STATEMENTS` (3A + 3B); `createScratchDb`, `runMigrations`, `coreMigrationList`, `seedOrg`, `seedMember`, `withAppClient`, `inOrgTx`; kết luận S3C-1…3 (Task 1).
- Produces (tên là hợp đồng cho mọi task sau):
  - Bảng `org_invitations`, `org_invite_links`, `org_ownership_transfers` với đúng tên constraint trong DDL dưới đây (map lỗi ở Task 7 dùng các tên này).
  - Hàm trigger quyền caller `tenancy_org_invitations_token_clear_only()`, `tenancy_org_invitations_role_not_owner()`, `tenancy_org_invite_links_role_not_owner()`, `tenancy_org_invite_links_use_count_monotonic()`; trigger cùng tên bỏ tiền tố `tenancy_`.
  - Hàm definer: `public.tenancy_find_invitation(p_token_hash bytea) RETURNS TABLE (org_id uuid, invitation_id bigint)` (chỉ `PENDING`), `public.tenancy_find_invite_link(p_token_hash bytea) RETURNS TABLE (org_id uuid, invite_link_id bigint)` (chỉ `revoked_at IS NULL`), `public.tenancy_count_user_memberships(p_user_id bigint) RETURNS bigint` (mọi membership của user, kể cả org xoá mềm; M7).
  - `constants.ts`: `INVITE_TOKEN_BYTES = 32`, `TOKEN_HASH_BYTES = 32`, `INVITATION_EMAIL_MAX_LENGTH = 254`, `TOKEN_INPUT_MAX_LENGTH = 128`, `STEP_DOWN_ROLES = ['ADMIN', 'MEMBER'] as const`, `type StepDownRole`, `SYSTEM_ROLE_LABELS: Readonly<Record<SystemRoleKey, string>>`.
  - `tenancy-catalog.ts`: `DEFINER_FUNCTIONS_3C`, `DEFINER_READ_TABLES_3C`, `TENANCY_TENANT_TABLES_3C`; các hằng hợp gộp thêm.
  - `ORG_PURGE_STATEMENTS` có ba câu của 3C trước `org_members`.

- [ ] **Step 1: Hằng catalog 3C và test catalog (fail)**

`test/support/tenancy-catalog.ts` — thêm sau các hằng 3B (không sửa hằng 3A/3B), rồi gộp vào các hằng hợp:
```ts
/**
 * Plan 3C (spec §6.14, §18.1): hai hàm tra token (không cần OrgScope) và hàm đếm membership của M7 (single-org, mọi org
 * kể cả xoá mềm). Hàm definer đọc `org_invitations`, `org_invite_links` qua policy `_definer_read`; `org_members` đã có
 * policy của 3A. `org_ownership_transfers` không có policy definer (không hàm nào đọc nó xuyên org).
 */
export const DEFINER_FUNCTIONS_3C = ['tenancy_find_invitation', 'tenancy_find_invite_link', 'tenancy_count_user_memberships'] as const;
export const DEFINER_READ_TABLES_3C = ['org_invitations', 'org_invite_links'] as const;
export const TENANCY_TENANT_TABLES_3C = ['org_invitations', 'org_invite_links', 'org_ownership_transfers'] as const;
```
và nối phần tử 3C vào ba hằng hợp (giữ vị trí khai báo hiện có; hằng hợp phải đứng SAU hằng 3C):
```ts
export const DEFINER_FUNCTIONS: readonly string[] = [...DEFINER_FUNCTIONS_3A, ...DEFINER_FUNCTIONS_3C];
export const DEFINER_READ_TABLES: readonly string[] = [...DEFINER_READ_TABLES_3A, ...DEFINER_READ_TABLES_3B, ...DEFINER_READ_TABLES_3C];
export const TENANCY_TENANT_TABLES: readonly string[] = [...TENANCY_TENANT_TABLES_3A, ...TENANCY_TENANT_TABLES_3B, ...TENANCY_TENANT_TABLES_3C];
```
(Nếu 3D đã merge trước và thêm `…_3D`, giữ phần tử 3D; chỉ nối thêm 3C. 3C không có hàm trigger `SECURITY DEFINER` nên `DEFINER_TRIGGER_FUNCTIONS`, `DEFINER_INTERNAL_FUNCTIONS` không đổi.)

`test/integration/core/database/rls-catalog.spec.ts`, trong `it('tenancy_definer holds only column SELECT on the declared columns', …)` thêm trước `const tableLevel`:
```ts
      // Plan 3C: hai hàm tra token đọc đúng các cột này (spec §6.7, §6.8); không đọc email hay role.
      expect(cols('org_invitations')).toEqual(['id', 'org_id', 'status', 'token_hash']);
      expect(cols('org_invite_links')).toEqual(['id', 'org_id', 'revoked_at', 'token_hash']);
      expect(cols('org_ownership_transfers')).toEqual([]);
```
trong `it('app_user UPDATE is column-scoped …', …)`: thêm `'org_invitations', 'org_invite_links', 'org_ownership_transfers'` vào danh sách `table_name IN (…)` và:
```ts
      // Spec §6.7–6.9: org_id, public_id, email, role_id, token_hash của link, max_uses, expires_at, cột member là bất biến
      // (hành động FK SET NULL chạy bằng quyền owner, không cần grant).
      expect(cols('org_invitations')).toEqual(['accepted_member_id', 'resolved_at', 'status', 'token_hash', 'updated_at', 'version']);
      expect(cols('org_invite_links')).toEqual(['revoked_at', 'updated_at', 'use_count', 'version']);
      expect(cols('org_ownership_transfers')).toEqual(['resolved_at', 'status', 'updated_at', 'version']);
```
`test/integration/core/database/normalization-inventory.spec.ts` — thêm vào `ANALYSED_COLUMNS`:
```ts
  'public.org_invitations': ['id', 'public_id', 'org_id', 'email', 'role_id', 'inviter_member_id', 'status', 'token_hash', 'expires_at', 'resolved_at', 'accepted_member_id', 'version', 'created_at', 'updated_at'],
  'public.org_invite_links': ['id', 'public_id', 'org_id', 'role_id', 'created_by_member_id', 'token_hash', 'max_uses', 'use_count', 'expires_at', 'revoked_at', 'version', 'created_at', 'updated_at'],
  'public.org_ownership_transfers': ['id', 'public_id', 'org_id', 'from_member_id', 'to_member_id', 'step_down_to', 'status', 'expires_at', 'resolved_at', 'version', 'created_at', 'updated_at'],
```
Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts`
Expected: FAIL (bảng và hàm chưa có: tập policy definer, tập SECURITY DEFINER, cột lệch).

- [ ] **Step 2: Test `down` từ chối khi còn lời mời/link/chuyển quyền đang chờ (fail)**

`test/integration/tenancy/acquisition-down.spec.ts`:
```ts
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/**
 * Spec SP3 §6.13 "Down khi có dữ liệu chặn → lỗi rõ ràng, không mất dữ liệu" áp cho 3C: bỏ ba bảng khi còn lời mời
 * đang chờ, link đang mở hoặc chuyển quyền đang chờ làm người đang cầm token/yêu cầu mất nó âm thầm. Dòng đã kết thúc
 * (lịch sử) không chặn: lịch sử bền nằm ở event outbox (SP6 audit). Database riêng, migrate tới đúng migration 3C.
 */
describe('down of …_acquisition refuses while an invitation, a link or a transfer is still open', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  let org: SeededOrg;
  const inOrg = <T>(fn: (c: pg.Client) => Promise<T>) => withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)), db.name);
  const down = () => runMigrations('down', { source: { kind: 'list', list }, to: previous });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('acqdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_acquisition'));
    if (at < 1) throw new Error('acquisition migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('an open invitation blocks the down; tables, rows and FORCE stay', async () => {
    await inOrg((c) =>
      c.query(
        `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at)
         VALUES ($1, 'down@example.test', $2, $3, 'PENDING', decode($4, 'hex'), now() + interval '1 day')`,
        [org.orgId, org.roles.MEMBER.id, org.owner.memberId, '01'.repeat(32)],
      ),
    );
    await expect(down()).rejects.toThrow(/open invitations, invite links or ownership transfers exist/);
    const owner = await db.client('owner');
    try {
      expect(
        (await owner.query(`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('org_invitations', 'org_invite_links', 'org_ownership_transfers') ORDER BY relname`)).rows,
      ).toEqual([
        { relname: 'org_invitations', relforcerowsecurity: true },
        { relname: 'org_invite_links', relforcerowsecurity: true },
        { relname: 'org_ownership_transfers', relforcerowsecurity: true },
      ]);
    } finally {
      await owner.end();
    }
    expect((await inOrg((c) => c.query(`SELECT 1 FROM org_invitations`))).rows).toHaveLength(1);
  });
  it('an open link and a pending transfer each block the down on their own', async () => {
    await inOrg((c) => c.query(`UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = now()`));
    await inOrg((c) =>
      c.query(
        `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, expires_at)
         VALUES ($1, $2, $3, decode($4, 'hex'), 5, now() + interval '1 day')`,
        [org.orgId, org.roles.MEMBER.id, org.owner.memberId, '02'.repeat(32)],
      ),
    );
    await expect(down()).rejects.toThrow(/open invitations, invite links or ownership transfers exist/);
    await inOrg((c) => c.query(`UPDATE org_invite_links SET revoked_at = now()`));
    const to = await seedMember(org, 'MEMBER');
    await inOrg((c) =>
      c.query(
        `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, status, expires_at) VALUES ($1, $2, $3, 'PENDING', now() + interval '1 day')`,
        [org.orgId, org.owner.memberId, to.memberId],
      ),
    );
    await expect(down()).rejects.toThrow(/open invitations, invite links or ownership transfers exist/);
  });
  it('once nothing is open the down succeeds, dropping the tables, the trigger functions and the definer functions', async () => {
    await inOrg((c) => c.query(`UPDATE org_ownership_transfers SET status = 'CANCELLED', resolved_at = now()`));
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      const { rows } = await owner.query(
        `SELECT proname FROM pg_proc WHERE proname IN ('tenancy_find_invitation', 'tenancy_find_invite_link', 'tenancy_count_user_memberships',
           'tenancy_org_invitations_token_clear_only', 'tenancy_org_invitations_role_not_owner', 'tenancy_org_invite_links_role_not_owner',
           'tenancy_org_invite_links_use_count_monotonic')`,
      );
      expect(rows).toEqual([]);
      expect((await owner.query(`SELECT to_regclass('public.org_invitations') AS t`)).rows).toEqual([{ t: null }]);
    } finally {
      await owner.end();
    }
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/acquisition-down.spec.ts`
Expected: FAIL ("acquisition migration not found").

- [ ] **Step 3: Tạo migration bằng CLI và viết nội dung**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/tenancy --name acquisition`
Expected: file `src/migrations/tenancy/Migration<ts>_acquisition.ts`, timestamp lớn hơn mọi migration trên `main`.

Thay nội dung lớp (giữ tên lớp và `name` do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

const TABLES = ['org_invitations', 'org_invite_links', 'org_ownership_transfers'] as const;
const FORCE_ASSERT = `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`;

/**
 * Plan 3C (spec SP3 §6.7–6.9, §6.13 bảng 3C, §6.14): lời mời email, invite link, chuyển quyền sở hữu.
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_invitations | {id}, {org_id, public_id}, {token_hash} (khi khác NULL) | role_id → org_id, inviter_member_id → org_id, accepted_member_id → org_id | 3NF (org_id là thuộc tính khoá); không BCNF — E1 |
 * | org_invite_links | {id}, {org_id, public_id}, {token_hash} | role_id → org_id, created_by_member_id → org_id | 3NF; không BCNF — E1 |
 * | org_ownership_transfers | {id}, {org_id, public_id} | from_member_id → org_id, to_member_id → org_id | 3NF; không BCNF — E1 |
 * E1 — `org_id` lặp lại cho RLS không join và FK kép; giữ nhất quán ở DB: mọi FK tới cha là FK kép `(org_id, x)` (bản sao
 * không khác org của cha), `SET NULL (x)` chỉ xoá cột con, không grant `UPDATE (org_id)`, `WITH CHECK (org_id =
 * app_current_org())`, và FK `org_id → organizations` trực tiếp (mọi FK kép có thể NULL, DB-I8). `email` là địa chỉ được
 * mời (có thể chưa có tài khoản), không phải bản sao `auth."user".email`. Trạng thái link suy ra, không lưu (spec §6.8).
 *
 * Index (mỗi cái một query): `*_token_hash_uq` → hàm definer tra token (xuyên org nên không bắt đầu bằng org_id);
 * `org_invitations_pending_email_uq` → chặn mời trùng song song (T-4) và đếm lời mời PENDING mỗi org (T-11, quét tiền tố
 * org_id); `*_created_idx (org_id, created_at)` → liệt kê; `*_role_idx`, `*_inviter_idx`, `*_accepted_member_idx`,
 * `*_created_by_idx`, `*_from_idx`, `*_to_idx` → hành động FK SET NULL khi xoá role/member, dọn theo role (xoá role) và
 * lọc theo bên tham gia; `org_invite_links_active_idx (org_id) WHERE revoked_at IS NULL` → đếm link đang mở (spec §6.8);
 * `org_ownership_transfers_pending_uq` → một yêu cầu PENDING mỗi org (T-16); `*_org_public_id_uq` → API và FK org_id.
 * Danh sách chuyển quyền mỗi org rất nhỏ (tối đa một PENDING), nên sắp theo `created_at` trên kết quả lọc `org_id` của
 * `*_org_public_id_uq`, không thêm index. Không có `UNIQUE (org_id, id)`: không bảng nào có FK kép trỏ tới ba bảng này.
 *
 * Trigger: bốn trigger BEFORE quyền caller (không hoãn: thấy đúng org của câu ghi; dòng role của org khác bị RLS giấu thì
 * cho qua để WITH CHECK trả 42501, spike S3C-2). `*_role_not_owner` cho qua `NEW.role_id IS NULL` (hành động FK SET NULL
 * là UPDATE có role_id trong target list, DB2-M1).
 *
 * Hàm definer (S3-A31: tạo dưới SET LOCAL ROLE): `tenancy_find_invitation`, `tenancy_find_invite_link` (tra hash 32 byte,
 * không cần OrgScope; tham số NULL hoặc sai độ dài → RAISE, DB-M3), `tenancy_count_user_memberships` (M7: mọi membership
 * của user, kể cả org xoá mềm, cho chế độ single-org). Chỉ đọc; `EXECUTE` chỉ cho app_user.
 *
 * Khoá: `SHARE ROW EXCLUSIVE` trên `organizations`, `org_roles`, `org_members` (FK) tới hết lô 3C: đọc không bị chặn, ghi
 * member/role chờ (ngắn, spec §6.13 runbook).
 *
 * Down: từ chối khi còn lời mời PENDING chưa hết hạn, link đang mở, chuyển quyền PENDING chưa hết hạn (đọc theo mẫu
 * NO FORCE … FORCE + khẳng định, spec §8.8); rồi xoá ngược thứ tự: hàm definer (dưới SET LOCAL ROLE), bảng, hàm trigger.
 */
export class Migration<ts>_acquisition extends Migration {
  override name = 'Migration<ts>_acquisition';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_invitations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    email TEXT NOT NULL,
    role_id BIGINT NULL,
    inviter_member_id BIGINT NULL,
    status TEXT NOT NULL,
    token_hash BYTEA NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ NULL,
    accepted_member_id BIGINT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_invitations_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_invitations_token_hash_uq UNIQUE (token_hash),
    CONSTRAINT org_invitations_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_invitations_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE SET NULL (role_id),
    CONSTRAINT org_invitations_inviter_fk FOREIGN KEY (org_id, inviter_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (inviter_member_id),
    CONSTRAINT org_invitations_accepted_member_fk FOREIGN KEY (org_id, accepted_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (accepted_member_id),
    CONSTRAINT org_invitations_email_ck CHECK (email = lower(btrim(email)) AND email IS NFC NORMALIZED AND char_length(email) <= 254),
    CONSTRAINT org_invitations_status_ck CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'INVALIDATED')),
    CONSTRAINT org_invitations_token_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT org_invitations_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_invitations_resolved_ck CHECK (resolved_at >= created_at),
    CONSTRAINT org_invitations_pending_token_ck CHECK ((status = 'PENDING') = (token_hash IS NOT NULL)),
    CONSTRAINT org_invitations_pending_resolved_ck CHECK ((status = 'PENDING') = (resolved_at IS NULL)),
    CONSTRAINT org_invitations_accepted_member_ck CHECK (status = 'ACCEPTED' OR accepted_member_id IS NULL),
    CONSTRAINT org_invitations_pending_role_ck CHECK (status <> 'PENDING' OR role_id IS NOT NULL),
    CONSTRAINT org_invitations_version_ck CHECK (version >= 1));`);
    this.addSql(`CREATE UNIQUE INDEX org_invitations_pending_email_uq ON org_invitations (org_id, email) WHERE status = 'PENDING';`);
    this.addSql(`CREATE INDEX org_invitations_created_idx ON org_invitations (org_id, created_at);`);
    this.addSql(`CREATE INDEX org_invitations_role_idx ON org_invitations (org_id, role_id);`);
    this.addSql(`CREATE INDEX org_invitations_inviter_idx ON org_invitations (org_id, inviter_member_id);`);
    this.addSql(`CREATE INDEX org_invitations_accepted_member_idx ON org_invitations (org_id, accepted_member_id);`);

    this.addSql(`CREATE TABLE org_invite_links (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    role_id BIGINT NULL,
    created_by_member_id BIGINT NULL,
    token_hash BYTEA NOT NULL,
    max_uses INT NOT NULL,
    use_count INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_invite_links_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_invite_links_token_hash_uq UNIQUE (token_hash),
    CONSTRAINT org_invite_links_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_invite_links_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE SET NULL (role_id),
    CONSTRAINT org_invite_links_created_by_fk FOREIGN KEY (org_id, created_by_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (created_by_member_id),
    CONSTRAINT org_invite_links_token_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT org_invite_links_max_uses_ck CHECK (max_uses >= 1),
    CONSTRAINT org_invite_links_use_count_ck CHECK (use_count >= 0 AND use_count <= max_uses),
    CONSTRAINT org_invite_links_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_invite_links_revoked_ck CHECK (revoked_at >= created_at),
    CONSTRAINT org_invite_links_active_role_ck CHECK (revoked_at IS NOT NULL OR role_id IS NOT NULL),
    CONSTRAINT org_invite_links_version_ck CHECK (version >= 1));`);
    this.addSql(`CREATE INDEX org_invite_links_created_idx ON org_invite_links (org_id, created_at);`);
    this.addSql(`CREATE INDEX org_invite_links_active_idx ON org_invite_links (org_id) WHERE revoked_at IS NULL;`);
    this.addSql(`CREATE INDEX org_invite_links_role_idx ON org_invite_links (org_id, role_id);`);
    this.addSql(`CREATE INDEX org_invite_links_created_by_idx ON org_invite_links (org_id, created_by_member_id);`);

    this.addSql(`CREATE TABLE org_ownership_transfers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    from_member_id BIGINT NULL,
    to_member_id BIGINT NULL,
    step_down_to TEXT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_ownership_transfers_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_ownership_transfers_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_ownership_transfers_from_fk FOREIGN KEY (org_id, from_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (from_member_id),
    CONSTRAINT org_ownership_transfers_to_fk FOREIGN KEY (org_id, to_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (to_member_id),
    CONSTRAINT org_ownership_transfers_step_down_ck CHECK (step_down_to IN ('ADMIN', 'MEMBER')),
    CONSTRAINT org_ownership_transfers_status_ck CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
    CONSTRAINT org_ownership_transfers_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_ownership_transfers_resolved_ck CHECK (resolved_at >= created_at),
    CONSTRAINT org_ownership_transfers_pending_resolved_ck CHECK ((status = 'PENDING') = (resolved_at IS NULL)),
    CONSTRAINT org_ownership_transfers_pending_members_ck CHECK (status <> 'PENDING' OR (from_member_id IS NOT NULL AND to_member_id IS NOT NULL)),
    CONSTRAINT org_ownership_transfers_distinct_ck CHECK (from_member_id IS DISTINCT FROM to_member_id OR from_member_id IS NULL),
    CONSTRAINT org_ownership_transfers_version_ck CHECK (version >= 1));`);
    this.addSql(`CREATE UNIQUE INDEX org_ownership_transfers_pending_uq ON org_ownership_transfers (org_id) WHERE status = 'PENDING';`);
    this.addSql(`CREATE INDEX org_ownership_transfers_from_idx ON org_ownership_transfers (org_id, from_member_id);`);
    this.addSql(`CREATE INDEX org_ownership_transfers_to_idx ON org_ownership_transfers (org_id, to_member_id);`);

    for (const t of TABLES) {
      this.addSql(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      this.addSql(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
      this.addSql(`CREATE POLICY ${t}_tenant ON ${t} TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    }
    this.addSql(`CREATE POLICY org_invitations_definer_read ON org_invitations FOR SELECT TO tenancy_definer USING (true);`);
    this.addSql(`CREATE POLICY org_invite_links_definer_read ON org_invite_links FOR SELECT TO tenancy_definer USING (true);`);
    // Spec §6.7–6.9: DELETE cho xoá cứng org (chạy bằng app_user trong OrgScope); UPDATE theo cột, không bao giờ org_id,
    // public_id, email, role_id, token_hash của link, max_uses, expires_at hay cột member (hành động FK chạy bằng owner).
    this.addSql(`GRANT SELECT, INSERT, DELETE, UPDATE (status, token_hash, resolved_at, accepted_member_id, version, updated_at) ON org_invitations TO app_user;`);
    this.addSql(`GRANT SELECT, INSERT, DELETE, UPDATE (use_count, revoked_at, version, updated_at) ON org_invite_links TO app_user;`);
    this.addSql(`GRANT SELECT, INSERT, DELETE, UPDATE (status, resolved_at, version, updated_at) ON org_ownership_transfers TO app_user;`);
    this.addSql(`GRANT SELECT (id, org_id, token_hash, status) ON org_invitations TO tenancy_definer;`);
    this.addSql(`GRANT SELECT (id, org_id, token_hash, revoked_at) ON org_invite_links TO tenancy_definer;`);

    this.addSql(`CREATE FUNCTION tenancy_org_invitations_token_clear_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- DB-M12: token chỉ được xoá (lời mời rời PENDING), không bao giờ đổi sang giá trị khác.
  IF NEW.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION 'an invitation token can only be cleared'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invitations_token_clear_only';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_invitations_token_clear_only BEFORE UPDATE OF token_hash ON org_invitations
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invitations_token_clear_only();`);
    this.addSql(`CREATE FUNCTION tenancy_org_invitations_role_not_owner() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_system_key text;
BEGIN
  IF NEW.role_id IS NULL THEN RETURN NEW; END IF;
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key = 'OWNER' THEN
    RAISE EXCEPTION 'the owner role cannot be granted by an invitation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invitations_role_not_owner';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_invitations_role_not_owner BEFORE INSERT OR UPDATE OF role_id ON org_invitations
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invitations_role_not_owner();`);
    this.addSql(`CREATE FUNCTION tenancy_org_invite_links_role_not_owner() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_system_key text;
BEGIN
  IF NEW.role_id IS NULL THEN RETURN NEW; END IF;
  SELECT system_key INTO v_system_key FROM public.org_roles WHERE org_id = NEW.org_id AND id = NEW.role_id;
  IF FOUND AND v_system_key = 'OWNER' THEN
    RAISE EXCEPTION 'the owner role cannot be granted by an invite link'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invite_links_role_not_owner';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_invite_links_role_not_owner BEFORE INSERT OR UPDATE OF role_id ON org_invite_links
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invite_links_role_not_owner();`);
    this.addSql(`CREATE FUNCTION tenancy_org_invite_links_use_count_monotonic() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.use_count < OLD.use_count THEN
    RAISE EXCEPTION 'an invite link use count only grows'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_invite_links_use_count_monotonic';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_invite_links_use_count_monotonic BEFORE UPDATE OF use_count ON org_invite_links
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_invite_links_use_count_monotonic();`);

    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`CREATE FUNCTION public.tenancy_find_invitation(p_token_hash bytea)
RETURNS TABLE (org_id uuid, invitation_id bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'tenancy_find_invitation: p_token_hash must not be NULL'; END IF;
  IF octet_length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'tenancy_find_invitation: p_token_hash must be 32 bytes'; END IF;
  RETURN QUERY SELECT i.org_id, i.id FROM public.org_invitations i WHERE i.token_hash = p_token_hash AND i.status = 'PENDING';
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_find_invite_link(p_token_hash bytea)
RETURNS TABLE (org_id uuid, invite_link_id bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'tenancy_find_invite_link: p_token_hash must not be NULL'; END IF;
  IF octet_length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'tenancy_find_invite_link: p_token_hash must be 32 bytes'; END IF;
  RETURN QUERY SELECT l.org_id, l.id FROM public.org_invite_links l WHERE l.token_hash = p_token_hash AND l.revoked_at IS NULL;
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_count_user_memberships(p_user_id bigint)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_count_user_memberships: p_user_id must not be NULL'; END IF;
  RETURN (SELECT count(*) FROM public.org_members m WHERE m.user_id = p_user_id);
END $$;`);
    for (const sig of ['tenancy_find_invitation(bytea)', 'tenancy_find_invite_link(bytea)', 'tenancy_count_user_memberships(bigint)']) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_user;`);
    }
    this.addSql(`RESET ROLE;`);
  }

  override down(): void | Promise<void> {
    // Không mất việc đang chờ âm thầm: người cầm token/yêu cầu sẽ nhận 404 mà không ai biết vì sao.
    for (const t of TABLES) this.addSql(`ALTER TABLE public.${t} NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_invitations WHERE status = 'PENDING' AND expires_at > now())
     OR EXISTS (SELECT 1 FROM public.org_invite_links WHERE revoked_at IS NULL AND expires_at > now() AND use_count < max_uses)
     OR EXISTS (SELECT 1 FROM public.org_ownership_transfers WHERE status = 'PENDING' AND expires_at > now()) THEN
    RAISE EXCEPTION 'open invitations, invite links or ownership transfers exist: revoke them or wait for them to expire before reverting plan 3C';
  END IF;
END $$;`);
    for (const t of TABLES) this.addSql(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY;`);
    this.addSql(FORCE_ASSERT);
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`DROP FUNCTION public.tenancy_count_user_memberships(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_find_invite_link(bytea);`);
    this.addSql(`DROP FUNCTION public.tenancy_find_invitation(bytea);`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP TABLE org_ownership_transfers;`);
    this.addSql(`DROP TABLE org_invite_links;`);
    this.addSql(`DROP TABLE org_invitations;`);
    this.addSql(`DROP FUNCTION tenancy_org_invite_links_use_count_monotonic();`);
    this.addSql(`DROP FUNCTION tenancy_org_invite_links_role_not_owner();`);
    this.addSql(`DROP FUNCTION tenancy_org_invitations_role_not_owner();`);
    this.addSql(`DROP FUNCTION tenancy_org_invitations_token_clear_only();`);
  }
}
```
(`<ts>` là timestamp CLI đã sinh; không gõ tay. Nếu spike Task 1 đi fallback, sửa FK tương ứng theo ADR trước Step 5.)

Hai điểm về luật quét của 3A (`test/unit/migrations/migration-scan.spec.ts`): (1) khối khẳng định FORCE (`FORCE_ASSERT`) đứng SAU `NO FORCE` cuối cùng của `down`; (2) ba hàm definer tạo/xoá giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE`; bốn hàm trigger quyền caller tạo/xoá ngoài khối đó (chúng thuộc `app_owner`). Mỗi `CREATE FUNCTION` của `up` có `DROP FUNCTION` cùng tên trong `down`. Nếu luật quét đọc tên hàm từ literal SQL mà không đọc được tên sinh trong vòng `for` của `REVOKE/GRANT`, thì không sao: luật đối xứng chỉ xét `CREATE FUNCTION`/`DROP FUNCTION`, và cả sáu câu đó là literal.

- [ ] **Step 4: Thứ tự xoá cứng và hằng định dạng**

`src/modules/tenancy/infra/sql/org-purge.sql.ts` — thêm ba câu của 3C ngay trước `org_members` (con trước cha, spec §9.5 và Bảng 5; nếu 3D đã thêm câu của mình trước `org_members`, đặt ba câu này SAU các câu của 3D và TRƯỚC `org_members`):
```ts
export const ORG_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM org_ownership_transfers WHERE org_id = app_current_org()',
  'DELETE FROM org_invite_links WHERE org_id = app_current_org()',
  'DELETE FROM org_invitations WHERE org_id = app_current_org()',
  'DELETE FROM org_members WHERE org_id = app_current_org()',
  'DELETE FROM org_role_permissions WHERE org_id = app_current_org()',
  'DELETE FROM org_roles WHERE org_id = app_current_org()',
  'DELETE FROM organizations WHERE id = app_current_org()',
];
```
(Chuyển quyền xoá trước member: `CHECK` "PENDING có đủ hai member" không bao giờ bắn trong lúc purge.)

`src/modules/tenancy/constants.ts` — thêm:
```ts
/** Spec SP3 §13: token lời mời/link 256 bit (`randomBytes`), lưu SHA-256 (32 byte; khớp `*_token_hash_ck`). */
export const INVITE_TOKEN_BYTES = 32;
export const TOKEN_HASH_BYTES = 32;
/** Khớp `org_invitations_email_ck` (`char_length(email) <= 254`). */
export const INVITATION_EMAIL_MAX_LENGTH = 254;
/** Biên đầu vào của `token` trong body preview/accept/join: token thật là 43 ký tự base64url; chặn body khổng lồ. */
export const TOKEN_INPUT_MAX_LENGTH = 128;
/** Role hệ thống người khởi tạo nhận sau khi chuyển quyền (khớp `org_ownership_transfers_step_down_ck`). */
export const STEP_DOWN_ROLES = ['ADMIN', 'MEMBER'] as const;
export type StepDownRole = (typeof STEP_DOWN_ROLES)[number];
/** Tên hiển thị của role hệ thống trong thư (spec §6.5: tên role hệ thống không lưu; thư chỉ có locale mặc định). */
export const SYSTEM_ROLE_LABELS: Readonly<Record<SystemRoleKey, string>> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
```

- [ ] **Step 5: Chạy lại, kiểm migration round-trip**

Run:
```bash
pnpm build
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/database/migrations.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/tenancy/acquisition-down.spec.ts test/integration/tenancy/seed-helper.spec.ts test/integration/tenancy/org-purge.spec.ts
```
Expected: PASS. `migration-scan.spec.ts` xanh; `migration-order.spec.ts` xanh; `migrations.spec.ts` up → down → up và sweep S2-R57 gồm migration 3C (DB riêng rỗng nên guard của `down` không chặn); `rls-catalog.spec.ts` thấy ba bảng tenant có `TO app_user`, hai policy definer mới, tập SECURITY DEFINER = `DEFINER_FUNCTIONS` ∪ hàm trigger definer, không trùng tên constraint deferrable, mọi bảng có `org_id` có FK tới `organizations`; `seed-helper.spec.ts`, `org-purge.spec.ts` xanh với thứ tự xoá mới (nếu `seed-helper.spec.ts` so nguyên văn `ORG_PURGE_STATEMENTS`, cập nhật danh sách mong đợi trong đúng test đó bằng danh sách của Step 4, không nới phép so).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/migrations/tenancy src/modules/tenancy/infra/sql/org-purge.sql.ts src/modules/tenancy/constants.ts test/support/tenancy-catalog.ts test/integration/core/database test/integration/tenancy/acquisition-down.spec.ts
pnpm typecheck && pnpm lint
git add src/migrations/tenancy src/modules/tenancy/infra/sql/org-purge.sql.ts src/modules/tenancy/constants.ts test/support/tenancy-catalog.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/tenancy
git commit -m "feat(tenancy): invitations, invite links and ownership transfers tables with RLS, guard triggers and token lookup definer functions; down refuses while anything is open"
```

---

### Task 3: Template thư `org-invitation`, `ownership-transfer-requested` và migration `acquisition_templates`

**Files:**
- Create: `src/modules/notifications/templates/org-invitation/en/{subject.hbs,body.mjml,text.hbs}`, `src/modules/notifications/templates/ownership-transfer-requested/en/{subject.hbs,body.mjml,text.hbs}`, `src/migrations/notifications/Migration<ts>_acquisition_templates.ts` (qua CLI), `test/integration/notifications/acquisition-templates-down.spec.ts`
- Modify: `src/modules/notifications/templates.ts`, `test/unit/modules/notifications/templates.spec.ts`, `test/unit/modules/notifications/renderer.spec.ts`, `test/integration/notifications/email-templates-lookup-migration.spec.ts`

**Interfaces:**
- Consumes: bảng `email_templates` + FK `email_deliveries_template_fk` (3A), `TEMPLATE_KEYS`, `TEMPLATE_PARAMS`, `displayName`, `MjmlHandlebarsRenderer` (SP2/3A).
- Produces:
  - `TEMPLATE_KEYS` thêm `'org-invitation'`, `'ownership-transfer-requested'`.
  - `TEMPLATE_PARAMS['org-invitation'] = z.object({ orgName: displayName, inviterName: displayName.nullable(), roleName: displayName, acceptUrl: z.url(), expiresAt: z.iso.datetime() }).strict()` (`inviterName` luôn có mặt, `null` ở external: handlebars `strict` đòi khoá tồn tại; spec §5.2 INT-M3).
  - `TEMPLATE_PARAMS['ownership-transfer-requested'] = z.object({ name: displayName, orgName: displayName, requestedByName: displayName, expiresAt: z.iso.datetime() }).strict()` (không link: người nhận xem yêu cầu qua `GET …/ownership-transfers`; không thêm config URL).
  - Migration `notifications/Migration<ts>_acquisition_templates` chèn hai dòng; `down` xoá hai dòng (FK `RESTRICT` → `23503` khi còn thư).

- [ ] **Step 1: Test catalog template (fail)**

`test/unit/modules/notifications/templates.spec.ts` — thay ca đầu (ca đó so `TEMPLATE_KEYS` với `CHECK` của migration SP2, vốn đã bị 3A thay bằng bảng tra cứu và không còn là nguồn sự thật):
```ts
  it('matches the template folders, the params map and exactly the keys inserted into email_templates by the migrations', () => {
    expect(new Set(readdirSync('src/modules/notifications/templates'))).toEqual(new Set(TEMPLATE_KEYS));
    expect(Object.keys(TEMPLATE_PARAMS)).toEqual([...TEMPLATE_KEYS]);
    // Nguồn sự thật của key ở DB là các dòng `INSERT INTO email_templates (key) VALUES …` (spec SP3 §6.13): 3A chèn năm
    // key của SP2, 3C và 3D mỗi plan chèn dòng của mình. Chỉ đọc phần `up` của từng migration notifications.
    const dir = 'src/migrations/notifications';
    const inserted = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => {
        const up = /override up\(\)[\s\S]*?override down\(\)/.exec(readFileSync(`${dir}/${f}`, 'utf8'))?.[0] ?? '';
        const values = /INSERT INTO email_templates \(key\) VALUES ([^;]+);/.exec(up)?.[1] ?? '';
        return [...values.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
      });
    expect(inserted.sort()).toEqual([...TEMPLATE_KEYS].sort());
  });
  it('org-invitation: inviterName is nullable but always present, URLs are validated, no address field', () => {
    const schema = TEMPLATE_PARAMS['org-invitation'];
    const params = { orgName: 'Acme', inviterName: null, roleName: 'Member', acceptUrl: 'https://app.example.test/invitations#token=x', expiresAt: '2026-10-06T00:00:00.000Z' };
    expect(schema.safeParse(params).success).toBe(true);
    expect(schema.safeParse({ ...params, inviterName: 'Ann' }).success).toBe(true);
    for (const invalid of [
      { ...params, inviterName: undefined },
      { ...params, orgName: 'Acme\r\nBcc: x@example.test' },
      { ...params, acceptUrl: 'not a url' },
      { ...params, email: 'x@example.test' },
    ])
      expect(schema.safeParse(invalid).success).toBe(false);
  });
```
(Giữ import `readdirSync`, `readFileSync` đã có trong file.)

`test/unit/modules/notifications/renderer.spec.ts` — trong ca `renders every shipped template for the default locale`, thêm vào object `samples`:
```ts
      'org-invitation': {
        orgName: 'Acme',
        inviterName: 'Ann',
        roleName: 'Member',
        acceptUrl: 'https://app.example.test/invitations/accept#token=abc',
        expiresAt: '2026-10-06T00:00:00.000Z',
      },
      'ownership-transfer-requested': {
        name: 'Ann',
        orgName: 'Acme',
        requestedByName: 'Bob',
        expiresAt: '2026-10-06T00:00:00.000Z',
      },
```
và thêm ca:
```ts
  it('org-invitation renders without an inviter name (external mode) and keeps the token fragment in the link', async () => {
    const r = await make();
    const acceptUrl = 'https://app.example.test/invitations/accept#token=Zm9v_YmFy-';
    const out = r.render('org-invitation', 'en', { orgName: '<b>Acme</b>', inviterName: null, roleName: 'Member', acceptUrl, expiresAt: '2026-10-06T00:00:00.000Z' });
    expect(out.subject).toBe("You're invited to join <b>Acme</b>");
    expect(out.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(out.text).toContain('You are invited to join <b>Acme</b> as Member.');
    expect(hrefs(out.html)).toContain(acceptUrl);
    expect(out.text).toContain(acceptUrl);
    const named = r.render('org-invitation', 'en', { orgName: 'Acme', inviterName: 'Ann', roleName: 'Admin', acceptUrl, expiresAt: '2026-10-06T00:00:00.000Z' });
    expect(named.text).toContain('Ann invited you to join Acme as Admin.');
  });
```
Run: `pnpm vitest run --project unit test/unit/modules/notifications`
Expected: FAIL (key, thư mục, schema chưa có).

- [ ] **Step 2: Template và schema**

`src/modules/notifications/templates.ts` — `TEMPLATE_KEYS` thêm hai key cuối danh sách:
```ts
export const TEMPLATE_KEYS = [
  'verify-email',
  'reset-password',
  'two-factor-changed',
  'existing-account',
  'change-email-confirmation',
  'org-invitation',
  'ownership-transfer-requested',
] as const;
```
và `TEMPLATE_PARAMS` thêm (sau `change-email-confirmation`):
```ts
  // Spec SP3 §9.1: token chỉ nằm ở fragment của `acceptUrl`; `inviterName` null ở external (không có directory).
  'org-invitation': z
    .object({
      orgName: displayName,
      inviterName: displayName.nullable(),
      roleName: displayName,
      acceptUrl: z.url(),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  // Spec SP3 §9.3: chỉ local/hybrid (external không có email người nhận); không link, người nhận xem qua API.
  'ownership-transfer-requested': z
    .object({
      name: displayName,
      orgName: displayName,
      requestedByName: displayName,
      expiresAt: z.iso.datetime(),
    })
    .strict(),
```
(Nếu 3D đã merge trước và thêm `support-access-notice`, giữ key đó; chỉ chèn hai key của 3C.)

`src/modules/notifications/templates/org-invitation/en/subject.hbs`:
```hbs
You're invited to join {{orgName}}
```
`src/modules/notifications/templates/org-invitation/en/body.mjml`:
```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>{{#if inviterName}}{{inviterName}} invited you{{else}}You are invited{{/if}} to join {{orgName}} as {{roleName}}.</mj-text>
        <mj-button href="{{acceptUrl}}">Accept the invitation</mj-button>
        <mj-text>The link works once and expires at {{expiresAt}} (UTC). If you did not expect this, ignore this email.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
`src/modules/notifications/templates/org-invitation/en/text.hbs`:
```hbs
{{#if inviterName}}{{inviterName}} invited you{{else}}You are invited{{/if}} to join {{orgName}} as {{roleName}}.

Accept the invitation (the link works once and expires at {{expiresAt}} UTC):
{{acceptUrl}}

If you did not expect this, ignore this email.
```
`src/modules/notifications/templates/ownership-transfer-requested/en/subject.hbs`:
```hbs
Ownership transfer requested for {{orgName}}
```
`src/modules/notifications/templates/ownership-transfer-requested/en/body.mjml`:
```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hi {{name}},</mj-text>
        <mj-text>{{requestedByName}} asked to transfer ownership of {{orgName}} to you.</mj-text>
        <mj-text>Sign in to accept or decline the request before {{expiresAt}} (UTC). If you did not expect this, decline it or ignore this email.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
`src/modules/notifications/templates/ownership-transfer-requested/en/text.hbs`:
```hbs
Hi {{name}},

{{requestedByName}} asked to transfer ownership of {{orgName}} to you.

Sign in to accept or decline the request before {{expiresAt}} (UTC). If you did not expect this, decline it or ignore this email.
```

- [ ] **Step 3: Migration chèn dòng và test `down` (fail → pass)**

`test/integration/notifications/acquisition-templates-down.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

/** Spec SP3 §6.13 bảng 3C: `down` xoá hai dòng tra cứu; còn thư dùng key → FK RESTRICT `23503`, không mất thư. */
describe('down of …_acquisition_templates', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  const down = () => runMigrations('down', { source: { kind: 'list', list }, to: previous });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('acqtpl');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_acquisition_templates'));
    if (at < 1) throw new Error('acquisition_templates migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('a delivery that uses org-invitation blocks the down with 23503; the rows stay', async () => {
    const app = await db.client('app');
    const id = v7();
    try {
      await app.query(
        `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key) VALUES ($1, 'org-invitation', 'en', 'x', 'y', 'PENDING', $2)`,
        [id, `org-invitation:${id}`],
      );
    } finally {
      await app.end();
    }
    await expect(down()).rejects.toMatchObject({ code: '23503' });
    const owner = await db.client('owner');
    try {
      expect((await owner.query(`SELECT key FROM email_templates WHERE key IN ('org-invitation', 'ownership-transfer-requested') ORDER BY key`)).rows).toEqual([
        { key: 'org-invitation' },
        { key: 'ownership-transfer-requested' },
      ]);
      await owner.query(`DELETE FROM email_deliveries WHERE public_id = $1`, [id]);
    } finally {
      await owner.end();
    }
  });
  it('without deliveries the down removes exactly the two keys', async () => {
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      expect((await owner.query(`SELECT count(*)::int AS n FROM email_templates WHERE key IN ('org-invitation', 'ownership-transfer-requested')`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await owner.end();
    }
  });
});
```
Run: `pnpm vitest run --project integration test/integration/notifications/acquisition-templates-down.spec.ts` → FAIL ("migration not found").

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/notifications --name acquisition_templates`

Thay nội dung lớp:
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3C (spec SP3 §5.2 hàng notifications, §6.13 bảng 3C): hai template của thu nhận là DÒNG của bảng tra cứu
 * `email_templates` (FK từ `email_deliveries.template`), nên 3C ∥ 3D chỉ chèn dòng, không ghi đè nhau (INT2-N-3).
 * Không bảng mới, không đổi chuẩn hoá (`email_templates` BCNF, spec §6.12). Khoá: `ROW EXCLUSIVE` trên `email_templates`.
 * Down: xoá hai dòng; FK RESTRICT từ `email_deliveries` làm down fail to (`23503`) khi còn thư dùng key — runbook: chờ
 * cron dọn `NOTIFICATIONS_RETENTION_DAYS` hoặc xoá dòng thư đã ở trạng thái cuối. Không đọc bảng FORCE.
 */
export class Migration<ts>_acquisition_templates extends Migration {
  override name = 'Migration<ts>_acquisition_templates';

  override up(): void | Promise<void> {
    this.addSql(`INSERT INTO email_templates (key) VALUES ('org-invitation'), ('ownership-transfer-requested');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DELETE FROM email_templates WHERE key IN ('org-invitation', 'ownership-transfer-requested');`);
  }
}
```

- [ ] **Step 4: Sửa test đọc `TEMPLATE_KEYS` như ảnh chụp của migration cũ**

`test/integration/notifications/email-templates-lookup-migration.spec.ts` chèn một dòng mỗi `TEMPLATE_KEYS` TRƯỚC khi migration lookup chạy, tức dưới `CHECK` năm key của SP2: với hai key mới ca này đỏ vì `CHECK`. Migration là ảnh chụp đóng băng, nên test của nó dùng đúng năm key của ảnh chụp đó. Thay dòng `import { TEMPLATE_KEYS } …` bằng hằng cục bộ đặt sau các import:
```ts
/** Năm key của `email_deliveries_template_check` (SP2, `Migration20260927145436_email_deliveries`): ảnh chụp của migration. */
const SP2_TEMPLATE_KEYS = ['verify-email', 'reset-password', 'two-factor-changed', 'existing-account', 'change-email-confirmation'] as const;
```
và đổi hai chỗ dùng `TEMPLATE_KEYS` trong file (vòng chèn và `toHaveLength`) thành `SP2_TEMPLATE_KEYS`.

- [ ] **Step 5: Chạy, commit**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/notifications test/unit/migrations
pnpm vitest run --project integration test/integration/notifications test/integration/core/database/migrations.spec.ts
```
Expected: PASS (renderer biên dịch hai template mới lúc boot với `strict` + `knownHelpersOnly`; `email_templates` = `TEMPLATE_KEYS` ở `email-deliveries-schema.spec.ts`; `down` 23503 rồi xanh).
```bash
pnpm exec prettier --write src/modules/notifications src/migrations/notifications test/unit/modules/notifications test/integration/notifications
git add src/modules/notifications src/migrations/notifications test/unit/modules/notifications test/integration/notifications
git commit -m "feat(notifications): org-invitation and ownership-transfer-requested templates as email_templates rows"
```

---

### Task 4: Helper seed, cô lập, ràng buộc DB và hàm definer của ba bảng 3C; kiểm chứng prod-like #1 (schema 3C chạy từ `dist`)

**Files:**
- Create (test): `test/integration/tenancy/acquisition-db.spec.ts`, `test/integration/tenancy/acquisition-isolation.spec.ts`, `test/integration/tenancy/acquisition-definer.spec.ts`
- Modify: `test/support/tenancy-seed.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: migration của Task 2; `seedOrg`, `seedMember`, `withAppClient`, `inOrgTx`, `seedStateOf` (nội bộ của `tenancy-seed.ts`), `seedCustomRole`, `ROLE_SET_C0` (3B Task 3); `createTestApp`, `DatabaseModule`, `OrgScope`, `UnitOfWork`, `Db` (SP1); `DEFINER_FUNCTIONS_3C`, `DEFINER_READ_TABLES_3C` (Task 2); `psql` (smoke).
- Produces (test support dùng ở mọi task sau, `test/support/tenancy-seed.ts`):
  - `newToken(): string` (32 byte base64url), `hashToken(token: string): string` (hex SHA-256, cùng công thức với `tokenHashHex` của Task 6).
  - `type SeededInvitation = { id: string; publicId: string; token: string }`; `seedInvitation(org: SeededOrg, o: { email: string; roleId: string; inviterMemberId: string | null; status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED' | 'INVALIDATED'; expiresInSec?: number }): Promise<SeededInvitation>` (`expiresInSec` âm = đã hết hạn; `created_at` lùi đủ để `expires_at > created_at`).
  - `type SeededInviteLink = { id: string; publicId: string; token: string }`; `seedInviteLink(org, o: { roleId: string; createdByMemberId: string | null; maxUses?: number; useCount?: number; expiresInSec?: number; revoked?: boolean }): Promise<SeededInviteLink>`.
  - `type SeededTransfer = { id: string; publicId: string }`; `seedTransfer(org, o: { fromMemberId: string; toMemberId: string; stepDownTo?: 'ADMIN' | 'MEMBER' | null; status?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED'; expiresInSec?: number }): Promise<SeededTransfer>`.

- [ ] **Step 1: Helper seed**

`test/support/tenancy-seed.ts` — thêm import `createHash`, `randomBytes` vào dòng `import { randomUUID } from 'node:crypto';` (thành `import { createHash, randomBytes, randomUUID } from 'node:crypto';`) và thêm cuối file (dùng lại `withAppClient`, `inOrgTx`, `seedStateOf`, `IdRow` đã có):
```ts
const SEED_TOKEN_BYTES = 32;
const DEFAULT_SEED_TTL_SEC = 86_400;
/** Token như app sinh (`INVITE_TOKEN_BYTES` byte, base64url) và hash hex SHA-256 như `tokenHashHex` của domain. */
export const newToken = (): string => randomBytes(SEED_TOKEN_BYTES).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export type SeededInvitation = { id: string; publicId: string; token: string };
export type SeededInviteLink = { id: string; publicId: string; token: string };
export type SeededTransfer = { id: string; publicId: string };

const databaseOf = (org: SeededOrg): string | undefined => {
  const state = seedStateOf.get(org);
  if (!state) throw new Error('seed: org was not created by seedOrg');
  return state.database;
};
/**
 * `created_at` = min(now, expires_at − 1 giờ): `CHECK (expires_at > created_at)` và `resolved_at >= created_at` đạt cả khi
 * `expiresInSec` âm (dòng đã hết hạn). Dòng không PENDING có `token_hash = NULL` và `resolved_at = now()` (CHECK §6.7).
 */
export async function seedInvitation(
  org: SeededOrg,
  o: { email: string; roleId: string; inviterMemberId: string | null; status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED' | 'INVALIDATED'; expiresInSec?: number },
): Promise<SeededInvitation> {
  const token = newToken();
  const status = o.status ?? 'PENDING';
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at, resolved_at, created_at)
           SELECT $1, $2, $3, $4, $5, CASE WHEN $5 = 'PENDING' THEN decode($6, 'hex') END, e.at,
                  CASE WHEN $5 = 'PENDING' THEN NULL ELSE now() END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $7::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [org.orgId, o.email, o.roleId, o.inviterMemberId, status, hashToken(token), o.expiresInSec ?? DEFAULT_SEED_TTL_SEC],
        );
        return rows[0];
      }),
    databaseOf(org),
  );
  if (!row) throw new Error('seedInvitation: insert returned no row');
  return { id: row.id, publicId: row.public_id, token };
}

export async function seedInviteLink(
  org: SeededOrg,
  o: { roleId: string; createdByMemberId: string | null; maxUses?: number; useCount?: number; expiresInSec?: number; revoked?: boolean },
): Promise<SeededInviteLink> {
  const token = newToken();
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, use_count, expires_at, revoked_at, created_at)
           SELECT $1, $2, $3, decode($4, 'hex'), $5, $6, e.at, CASE WHEN $7 THEN now() END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $8::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [org.orgId, o.roleId, o.createdByMemberId, hashToken(token), o.maxUses ?? 5, o.useCount ?? 0, o.revoked ?? false, o.expiresInSec ?? DEFAULT_SEED_TTL_SEC],
        );
        return rows[0];
      }),
    databaseOf(org),
  );
  if (!row) throw new Error('seedInviteLink: insert returned no row');
  return { id: row.id, publicId: row.public_id, token };
}

export async function seedTransfer(
  org: SeededOrg,
  o: { fromMemberId: string; toMemberId: string; stepDownTo?: 'ADMIN' | 'MEMBER' | null; status?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED'; expiresInSec?: number },
): Promise<SeededTransfer> {
  const status = o.status ?? 'PENDING';
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, step_down_to, status, expires_at, resolved_at, created_at)
           SELECT $1, $2, $3, $4, $5, e.at, CASE WHEN $5 = 'PENDING' THEN NULL ELSE now() END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $6::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [org.orgId, o.fromMemberId, o.toMemberId, o.stepDownTo ?? null, status, o.expiresInSec ?? DEFAULT_SEED_TTL_SEC],
        );
        return rows[0];
      }),
    databaseOf(org),
  );
  if (!row) throw new Error('seedTransfer: insert returned no row');
  return { id: row.id, publicId: row.public_id };
}
```

- [ ] **Step 2: Ràng buộc DB (viết, chạy — xanh ngay vì Task 2 đã có schema; mỗi ca phải đỏ khi bỏ đúng constraint của nó)**

`test/integration/tenancy/acquisition-db.spec.ts`:
```ts
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ROLE_SET_C0,
  inOrgTx,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 §18.1 "Ràng buộc DB" phần 3C: mỗi CHECK/trigger/UNIQUE một ca bị từ chối, bằng app_user trong OrgScope. */
describe('acquisition DB constraints (spec SP3 §6.7–6.9, §18.1)', () => {
  let org: SeededOrg;
  const orgs: SeededOrg[] = [];
  const inOrg = <T>(fn: (c: pg.Client) => Promise<T>) => withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)));
  const pendingInvite = (email: string, roleId = org.roles.MEMBER.id) =>
    inOrg((c) =>
      c.query(
        `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, 'PENDING', decode(md5(random()::text) || md5(random()::text), 'hex'), now() + interval '1 day')`,
        [org.orgId, email, roleId, org.owner.memberId],
      ),
    );
  beforeAll(async () => {
    org = await seedOrg();
    orgs.push(org);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
  });

  it('an invitation or a link carrying OWNER is refused by the trigger (S3-P5, B-16 at the DB)', async () => {
    await expect(pendingInvite('owner@example.test', org.roles.OWNER.id)).rejects.toMatchObject({ code: '23514', constraint: 'org_invitations_role_not_owner' });
    await expect(seedInviteLink(org, { roleId: org.roles.OWNER.id, createdByMemberId: org.owner.memberId })).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_role_not_owner',
    });
  });
  it('the email must be canonical (lowercase, trimmed, NFC, ≤ 254)', async () => {
    for (const email of ['Ann@example.test', ' ann@example.test', `${'a'.repeat(250)}@x.test`, 'á@example.test'])
      await expect(pendingInvite(email)).rejects.toMatchObject({ code: '23514', constraint: 'org_invitations_email_ck' });
  });
  it('T-4 at the DB: a second PENDING invitation for the same email is 23505 org_invitations_pending_email_uq; a finished one does not count', async () => {
    await seedInvitation(org, { email: 'dup@example.test', roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId, status: 'REVOKED' });
    await pendingInvite('dup@example.test');
    await expect(pendingInvite('dup@example.test')).rejects.toMatchObject({ code: '23505', constraint: 'org_invitations_pending_email_uq' });
  });
  it('the token can only be cleared; a finished invitation cannot keep a token', async () => {
    const inv = await seedInvitation(org, { email: 'tok@example.test', roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    await expect(inOrg((c) => c.query(`UPDATE org_invitations SET token_hash = decode(repeat('ff', 32), 'hex') WHERE id = $1`, [inv.id]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_token_clear_only',
    });
    await expect(inOrg((c) => c.query(`UPDATE org_invitations SET status = 'REVOKED', resolved_at = now() WHERE id = $1`, [inv.id]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_pending_token_ck',
    });
    await inOrg((c) => c.query(`UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = now() WHERE id = $1`, [inv.id]));
  });
  it('use_count never exceeds max_uses and never decreases', async () => {
    const link = await seedInviteLink(org, { roleId: org.roles.MEMBER.id, createdByMemberId: org.owner.memberId, maxUses: 1 });
    await inOrg((c) => c.query(`UPDATE org_invite_links SET use_count = 1 WHERE id = $1`, [link.id]));
    await expect(inOrg((c) => c.query(`UPDATE org_invite_links SET use_count = 2 WHERE id = $1`, [link.id]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_use_count_ck',
    });
    await expect(inOrg((c) => c.query(`UPDATE org_invite_links SET use_count = 0 WHERE id = $1`, [link.id]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_use_count_monotonic',
    });
  });
  it('R-11 / R-18 at the DB: a PENDING invitation or an unrevoked link blocks the role delete; finished rows only lose role_id', async () => {
    const pendingRole = await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'Pending holder' });
    await pendingInvite('r11@example.test', pendingRole.id);
    await expect(inOrg((c) => c.query('DELETE FROM org_roles WHERE id = $1', [pendingRole.id]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invitations_pending_role_ck',
    });
    const linkRole = await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'Link holder' });
    await seedInviteLink(org, { roleId: linkRole.id, createdByMemberId: org.owner.memberId, expiresInSec: -60 });
    await expect(inOrg((c) => c.query('DELETE FROM org_roles WHERE id = $1', [linkRole.id]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_invite_links_active_role_ck',
    });
    const doneRole = await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'Finished only' });
    const done = await seedInvitation(org, { email: 'r18@example.test', roleId: doneRole.id, inviterMemberId: org.owner.memberId, status: 'ACCEPTED' });
    await seedInviteLink(org, { roleId: doneRole.id, createdByMemberId: org.owner.memberId, revoked: true });
    await inOrg((c) => c.query('DELETE FROM org_roles WHERE id = $1', [doneRole.id]));
    expect((await inOrg((c) => c.query(`SELECT org_id::text AS org_id, role_id FROM org_invitations WHERE id = $1`, [done.id]))).rows).toEqual([{ org_id: org.orgId, role_id: null }]);
  });
  it('a member in a PENDING transfer cannot be deleted; one PENDING transfer per org; from ≠ to', async () => {
    const a = await seedMember(org, 'ADMIN');
    const b = await seedMember(org, 'MEMBER');
    await seedTransfer(org, { fromMemberId: org.owner.memberId, toMemberId: a.memberId });
    await expect(seedTransfer(org, { fromMemberId: org.owner.memberId, toMemberId: b.memberId })).rejects.toMatchObject({
      code: '23505',
      constraint: 'org_ownership_transfers_pending_uq',
    });
    await expect(inOrg((c) => c.query('DELETE FROM org_members WHERE id = $1', [a.memberId]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_ownership_transfers_pending_members_ck',
    });
    await expect(seedTransfer(org, { fromMemberId: b.memberId, toMemberId: b.memberId, status: 'DECLINED' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'org_ownership_transfers_distinct_ck',
    });
  });
  it('deleting the organization while a directly anchored row remains fails loud (23001), never orphans', async () => {
    const other = await seedOrg();
    orgs.push(other);
    await seedInvitation(other, { email: 'orphan@example.test', roleId: other.roles.MEMBER.id, inviterMemberId: other.owner.memberId, status: 'REVOKED' });
    await expect(
      withAppClient((c) =>
        inOrgTx(c, other.orgId, async () => {
          await c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = $1`, [other.orgId]);
          await c.query('DELETE FROM org_members WHERE org_id = $1', [other.orgId]);
          await c.query('DELETE FROM org_role_permissions WHERE org_id = $1', [other.orgId]);
          await c.query('DELETE FROM org_roles WHERE org_id = $1', [other.orgId]);
          await c.query('DELETE FROM organizations WHERE id = $1', [other.orgId]);
        }),
      ),
    ).rejects.toMatchObject({ code: '23001', constraint: 'org_invitations_org_fk' });
  });
  it('an expiry not after creation is refused', async () => {
    await expect(
      inOrg((c) =>
        c.query(
          `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, expires_at) VALUES ($1, $2, $3, decode(repeat('ee', 32), 'hex'), 1, now())`,
          [org.orgId, org.roles.MEMBER.id, org.owner.memberId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'org_invite_links_expires_ck' });
  });
});
```
(Xoá org ở ca cuối bị rollback — `withAppClient` + `inOrgTx` rollback khi ném — nên `other.dispose()` ở `afterAll` vẫn chạy đúng thứ tự `ORG_PURGE_STATEMENTS` và xoá được.)

- [ ] **Step 3: Cô lập ba bảng (tiêu chí 1)**

`test/integration/tenancy/acquisition-isolation.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { inOrgTx, seedInvitation, seedInviteLink, seedMember, seedOrg, seedTransfer, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const TABLES = ['org_invitations', 'org_invite_links', 'org_ownership_transfers'] as const;

describe('tenant isolation of the 3C tables through the app (spec SP3 §1 criterion 1, §18.1)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  const inA = <T>(fn: () => Promise<T>) => app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) => app.get(Db).execute<T>(q, p);
  const rowsOfB = () =>
    withAppClient((c) =>
      inOrgTx(c, b.orgId, async () => {
        const out: Record<string, number> = {};
        for (const t of TABLES) out[t] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n ?? -1;
        return out;
      }),
    );
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    a = await seedOrg();
    b = await seedOrg();
    const bm = await seedMember(b, 'MEMBER');
    await seedInvitation(b, { email: 'iso@example.test', roleId: b.roles.MEMBER.id, inviterMemberId: b.owner.memberId });
    await seedInviteLink(b, { roleId: b.roles.MEMBER.id, createdByMemberId: b.owner.memberId });
    await seedTransfer(b, { fromMemberId: b.owner.memberId, toMemberId: bm.memberId });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await app?.close();
  });

  it.each(TABLES)('%s: read/update/delete of org B from OrgScope(A) touch 0 rows', async (table) => {
    const before = await rowsOfB();
    expect(before[table]).toBe(1);
    expect(await inA(() => sql(`SELECT 1 FROM ${table} WHERE org_id = ?`, [b.orgId]))).toEqual([]);
    expect(await inA(() => sql(`UPDATE ${table} SET updated_at = now() WHERE org_id = ? RETURNING 1`, [b.orgId]))).toEqual([]);
    expect(await inA(() => sql(`DELETE FROM ${table} WHERE org_id = ? RETURNING 1`, [b.orgId]))).toEqual([]);
    expect(await rowsOfB()).toEqual(before);
  });
  it('INSERT with org_id = B is refused by RLS (42501), not by a trigger', async () => {
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_invitations (org_id, email, role_id, status, token_hash, expires_at) VALUES (?, 'x@example.test', ?, 'PENDING', decode(repeat('aa', 32), 'hex'), now() + interval '1 day')`,
          [b.orgId, b.roles.MEMBER.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_invite_links (org_id, role_id, token_hash, max_uses, expires_at) VALUES (?, ?, decode(repeat('ab', 32), 'hex'), 1, now() + interval '1 day')`,
          [b.orgId, b.roles.MEMBER.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it('a child row in A pointing at a parent of B is 23503 (double FK)', async () => {
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_invitations (org_id, email, role_id, status, token_hash, expires_at) VALUES (?, 'y@example.test', ?, 'PENDING', decode(repeat('ac', 32), 'hex'), now() + interval '1 day')`,
          [a.orgId, b.roles.MEMBER.id],
        ),
      ),
    ).rejects.toThrow(/org_invitations_role_fk/);
  });
  it('without an org context every 3C table fails closed (P0001)', async () => {
    for (const t of TABLES) await expect(app.get(UnitOfWork).run(() => sql(`SELECT 1 FROM ${t}`))).rejects.toThrow(/org context is not set/);
  });
});
```

- [ ] **Step 4: Hàm definer của 3C**

`test/integration/tenancy/acquisition-definer.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, inOrgTx, seedInvitation, seedInviteLink, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/** Spec SP3 §6.14, §18.1 "Hàm definer" phần 3C: gọi bằng app_user KHÔNG có org context. */
describe('3C definer functions (spec SP3 §6.14)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  const call = <T extends object>(sql: string, params: unknown[]) => withAppClient(async (c) => (await c.query<T>(sql, params)).rows);
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });

  it('tenancy_find_invitation returns (org, id) of a PENDING invitation only', async () => {
    const pending = await seedInvitation(a, { email: 'p@example.test', roleId: a.roles.MEMBER.id, inviterMemberId: a.owner.memberId });
    expect(await call(`SELECT org_id::text AS org_id, invitation_id::text AS id FROM tenancy_find_invitation(decode($1, 'hex'))`, [hashToken(pending.token)])).toEqual([
      { org_id: a.orgId, id: pending.id },
    ]);
    await withAppClient((c) => inOrgTx(c, a.orgId, () => c.query(`UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = now() WHERE id = $1`, [pending.id])));
    expect(await call(`SELECT * FROM tenancy_find_invitation(decode($1, 'hex'))`, [hashToken(pending.token)])).toEqual([]);
    expect(await call(`SELECT * FROM tenancy_find_invitation(decode($1, 'hex'))`, [hashToken('unknown')])).toEqual([]);
  });
  it('tenancy_find_invite_link returns unrevoked links (expiry and uses are checked later under the org lock)', async () => {
    const expired = await seedInviteLink(b, { roleId: b.roles.MEMBER.id, createdByMemberId: b.owner.memberId, expiresInSec: -60 });
    const revoked = await seedInviteLink(b, { roleId: b.roles.MEMBER.id, createdByMemberId: b.owner.memberId, revoked: true });
    expect(await call(`SELECT org_id::text AS org_id, invite_link_id::text AS id FROM tenancy_find_invite_link(decode($1, 'hex'))`, [hashToken(expired.token)])).toEqual([
      { org_id: b.orgId, id: expired.id },
    ]);
    expect(await call(`SELECT * FROM tenancy_find_invite_link(decode($1, 'hex'))`, [hashToken(revoked.token)])).toEqual([]);
  });
  it('tenancy_count_user_memberships counts every membership, soft-deleted orgs included (M7)', async () => {
    const m = await seedMember(a, 'MEMBER');
    await seedMember(b, 'MEMBER', { externalSubject: (await subjectOf(m.userId)) });
    await withAppClient((c) => inOrgTx(c, a.orgId, () => c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`, [a.orgId])));
    expect(await call(`SELECT tenancy_count_user_memberships($1)::int AS n`, [m.userId])).toEqual([{ n: 2 }]);
    await withAppClient((c) => inOrgTx(c, a.orgId, () => c.query(`UPDATE organizations SET deleted_at = NULL, purge_after = NULL WHERE id = $1`, [a.orgId])));
  });
  it.each<[string, string, unknown[]]>([
    ['find_invitation: NULL', 'SELECT * FROM tenancy_find_invitation($1)', [null]],
    ['find_invitation: 31 bytes', `SELECT * FROM tenancy_find_invitation(decode(repeat('aa', 31), 'hex'))`, []],
    ['find_invite_link: NULL', 'SELECT * FROM tenancy_find_invite_link($1)', [null]],
    ['find_invite_link: 33 bytes', `SELECT * FROM tenancy_find_invite_link(decode(repeat('aa', 33), 'hex'))`, []],
    ['count_user_memberships: NULL', 'SELECT tenancy_count_user_memberships($1)', [null]],
  ])('%s raises (DB-M3)', async (_name, sql, params) => {
    await expect(call(sql, params)).rejects.toThrow(/must (not be NULL|be 32 bytes)/);
  });
});

/** `external_subject` của dòng `tenancy_users` (bảng global): để seedMember ở org B dùng lại đúng user đó. */
async function subjectOf(userId: string): Promise<string> {
  const rows = await withAppClient(async (c) => (await c.query<{ s: string }>('SELECT external_subject AS s FROM tenancy_users WHERE id = $1', [userId])).rows);
  const s = rows[0]?.s;
  if (!s) throw new Error('seeded member without an external subject');
  return s;
}
```

- [ ] **Step 5: Chạy các test DB**

Run: `pnpm vitest run --project integration test/integration/tenancy/acquisition-db.spec.ts test/integration/tenancy/acquisition-isolation.spec.ts test/integration/tenancy/acquisition-definer.spec.ts test/integration/tenancy/seed-helper.spec.ts`
Expected: PASS. Kiểm đột biến một lần mỗi file (không commit đột biến): bỏ `IF NEW.role_id IS NULL THEN RETURN NEW; END IF;` khỏi trigger (qua một migration fixture tạm hoặc `CREATE OR REPLACE` trong transaction test) → ca R-18 đỏ; bỏ điều kiện `i.status = 'PENDING'` khỏi `tenancy_find_invitation` → ca đầu của file definer đỏ.

- [ ] **Step 6: Kiểm chứng prod-like #1 — schema 3C từ `dist` trên image production**

`test/smoke/tenancy.smoke.spec.ts` — thêm import `DEFINER_FUNCTIONS_3C`, `TENANCY_TENANT_TABLES_3C` từ `../support/tenancy-catalog.js`, và ca mới ngay sau ca "the tenancy schema of 3A migrated from dist …":
```ts
  it('the acquisition schema of 3C migrated from dist: FORCE RLS on three tables, three definer functions owned by tenancy_definer, two template rows', () => {
    const tables = [...TENANCY_TENANT_TABLES_3C].sort();
    expect(
      psql(
        `SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${tables.map((t) => `'${t}'`).join(', ')})`,
      ),
    ).toBe(tables.map((t) => `${t}:true:true`).join(','));
    const fns = [...DEFINER_FUNCTIONS_3C].sort();
    expect(
      psql(
        `SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || has_function_privilege('app_user', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${fns.map((f) => `'${f}'`).join(', ')})`,
      ),
    ).toBe(fns.map((f) => `${f}:tenancy_definer:true:true`).join(','));
    expect(psql(`SELECT count(*) FROM email_templates WHERE key IN ('org-invitation', 'ownership-transfer-requested')`)).toBe('2');
  });
```
Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer), migrate mọi migration tới 3C trên image (lô 3C khoá `organizations`, `org_roles`, `org_members` ngắn), mọi file smoke PASS, log api/worker JSON không `error`, `/health/ready` 200, teardown `down -v` sạch.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write test/support/tenancy-seed.ts test/integration/tenancy test/smoke/tenancy.smoke.spec.ts
pnpm typecheck && pnpm lint
git add test/support/tenancy-seed.ts test/integration/tenancy/acquisition-db.spec.ts test/integration/tenancy/acquisition-isolation.spec.ts test/integration/tenancy/acquisition-definer.spec.ts test/smoke/tenancy.smoke.spec.ts
git commit -m "test(tenancy): seed helpers, isolation, DB constraints and definer functions of the acquisition tables; 3C schema on the production image"
```

---

## Phần C — Config và identity (spec §5.2, §11, §13)

### Task 5: Config thu nhận, `resolveTenancyFeatures` (U17), claim email của `external`, `normalizeEmail` export

**Files:**
- Create: `src/modules/tenancy/domain/tenancy-features.ts`, `src/modules/tenancy/application/tenancy-features.ts`, `test/unit/modules/tenancy/tenancy-features.spec.ts`
- Modify: `src/modules/tenancy/tenancy.config.ts`, `src/modules/tenancy/errors.ts` (`FEATURE_DISABLED`), `src/modules/tenancy/http/tenancy-http.module.ts`, `src/modules/identity/identity.config.ts`, `src/modules/identity/infra/jwks/jwks.provider.ts`, `src/modules/identity/index.ts`, `test/unit/modules/tenancy/tenancy-config.spec.ts`, `test/unit/modules/identity/identity-config.spec.ts`, `test/support/env.ts`, `test/smoke/smoke-app-env.ts`, `.env.example`

**Interfaces:**
- Consumes: `defineConfig`, `defineConfigRule`, `defineProductionRule`, `ConfigOf` (SP1), `identityConfig` (SP2), `AppError`, `defineErrorCodes` (SP1), `normalizeEmail` (SP2 `infra/better-auth/email-normalize.ts`).
- Produces:
  - `tenancyConfig` thêm: `emailInvitations: 'auto' | 'on' | 'off'`, `invitationAcceptUrl: string | undefined`, `invitationTtlSec: number`, `maxPendingInvitationsPerOrg: number`, `inviteLinks: 'auto' | 'on' | 'off'`, `inviteLinkJoinUrl: string | undefined`, `inviteLinkMaxTtlSec: number`, `inviteLinkMaxUsesLimit: number`, `maxActiveInviteLinksPerOrg: number`, `tokenPreviewLimit: number`, `tokenPreviewTtlMs: number`, `ownershipTransferTtlSec: number`.
  - `domain/tenancy-features.ts`: `FEATURE_TRI_STATES`, `type FeatureTriState`, `type FeatureDisabledReason = 'OFF' | 'MISSING_ACCEPT_URL' | 'MISSING_JOIN_URL' | 'MISSING_EMAIL_CLAIM'`, `type FeatureState`, `type TenancyFeatureStates = { emailInvitations: FeatureState; inviteLinks: FeatureState }`, `type TenancyFeatureInput`, `type IdentityFeatureInput`, `resolveTenancyFeatures(t, id): TenancyFeatureStates`, `featureConfigProblems(t, states): string[]`.
  - `application/tenancy-features.ts`: `TenancyFeatures` (provider của `TenancyHttpModule`) với `readonly states: TenancyFeatureStates` và `require(feature: keyof TenancyFeatureStates): void` (ném `403 feature_disabled`); log INFO `tenancy_features` lúc `onModuleInit`.
  - `TenancyErrors.FEATURE_DISABLED` (`403 feature_disabled`).
  - `identityConfig` thêm `externalEmailClaim: string | undefined` (`AUTH_EXTERNAL_EMAIL_CLAIM`, trống = tắt), `externalEmailVerifiedClaim: string` (`AUTH_EXTERNAL_EMAIL_VERIFIED_CLAIM`, mặc định `email_verified`); `JwksAuthProvider` đặt `verifiedEmail` = claim email đã chuẩn hoá khi claim verified `=== true`.
  - `modules/identity/index.ts` export `normalizeEmail`.
  - `test/support/env.ts`: `TENANCY_INVITATION_ACCEPT_URL = 'http://localhost:3000/invitations/accept'`, `TENANCY_INVITE_LINK_JOIN_URL = 'http://localhost:3000/join'` trong `baseTestEnv()`; smoke: `https://localhost/invitations/accept`, `https://localhost/join`.

- [ ] **Step 1: Unit `resolveTenancyFeatures` — U17 (fail)**

`test/unit/modules/tenancy/tenancy-features.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  FEATURE_TRI_STATES,
  featureConfigProblems,
  resolveTenancyFeatures,
  type FeatureState,
} from '../../../../src/modules/tenancy/domain/tenancy-features.js';

const MODES = ['local', 'hybrid', 'external'] as const;
const URL_A = 'https://app.example.test/invitations/accept';
const URL_J = 'https://app.example.test/join';
const on: FeatureState = { enabled: true };

describe('resolveTenancyFeatures (spec SP3 §13 INT2-N-13, U17): 2 flags × 3 values × 3 modes', () => {
  for (const mode of MODES)
    for (const value of FEATURE_TRI_STATES)
      it(`emailInvitations=${value}, mode=${mode}`, () => {
        const withAll = resolveTenancyFeatures(
          { emailInvitations: value, invitationAcceptUrl: URL_A, inviteLinks: 'off', inviteLinkJoinUrl: undefined },
          { mode, externalEmailClaim: 'email' },
        );
        expect(withAll.emailInvitations).toEqual(value === 'off' ? { enabled: false, reason: 'OFF' } : on);
        const noUrl = resolveTenancyFeatures(
          { emailInvitations: value, invitationAcceptUrl: undefined, inviteLinks: 'off', inviteLinkJoinUrl: undefined },
          { mode, externalEmailClaim: 'email' },
        );
        expect(noUrl.emailInvitations).toEqual({ enabled: false, reason: value === 'off' ? 'OFF' : 'MISSING_ACCEPT_URL' });
        const noClaim = resolveTenancyFeatures(
          { emailInvitations: value, invitationAcceptUrl: URL_A, inviteLinks: 'off', inviteLinkJoinUrl: undefined },
          { mode, externalEmailClaim: undefined },
        );
        expect(noClaim.emailInvitations).toEqual(
          value === 'off' ? { enabled: false, reason: 'OFF' } : mode === 'external' ? { enabled: false, reason: 'MISSING_EMAIL_CLAIM' } : on,
        );
      });
  for (const mode of MODES)
    for (const value of FEATURE_TRI_STATES)
      it(`inviteLinks=${value}, mode=${mode} (links need no email claim)`, () => {
        const states = resolveTenancyFeatures(
          { emailInvitations: 'off', invitationAcceptUrl: undefined, inviteLinks: value, inviteLinkJoinUrl: URL_J },
          { mode, externalEmailClaim: undefined },
        );
        expect(states.inviteLinks).toEqual(value === 'off' ? { enabled: false, reason: 'OFF' } : on);
        const noUrl = resolveTenancyFeatures(
          { emailInvitations: 'off', invitationAcceptUrl: undefined, inviteLinks: value, inviteLinkJoinUrl: undefined },
          { mode, externalEmailClaim: undefined },
        );
        expect(noUrl.inviteLinks).toEqual({ enabled: false, reason: value === 'off' ? 'OFF' : 'MISSING_JOIN_URL' });
      });
  it('featureConfigProblems: only "on" with a missing condition is an error; "auto" disables quietly', () => {
    const t = { emailInvitations: 'on', invitationAcceptUrl: undefined, inviteLinks: 'auto', inviteLinkJoinUrl: undefined } as const;
    const states = resolveTenancyFeatures(t, { mode: 'local', externalEmailClaim: undefined });
    expect(featureConfigProblems(t, states)).toEqual(['TENANCY_EMAIL_INVITATIONS=on needs TENANCY_INVITATION_ACCEPT_URL']);
    const ext = { emailInvitations: 'on', invitationAcceptUrl: URL_A, inviteLinks: 'on', inviteLinkJoinUrl: undefined } as const;
    expect(featureConfigProblems(ext, resolveTenancyFeatures(ext, { mode: 'external', externalEmailClaim: undefined }))).toEqual([
      'TENANCY_EMAIL_INVITATIONS=on needs AUTH_EXTERNAL_EMAIL_CLAIM when AUTH_MODE=external',
      'TENANCY_INVITE_LINKS=on needs TENANCY_INVITE_LINK_JOIN_URL',
    ]);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/tenancy-features.spec.ts` → FAIL (module chưa có).

- [ ] **Step 2: Hàm thuần**

`src/modules/tenancy/domain/tenancy-features.ts`:
```ts
/**
 * Trạng thái hiệu lực của hai cờ tri-state của 3C (spec SP3 §13, INT2-N-13). Hàm thuần dùng chung cho luật config (boot
 * fail khi `on` thiếu điều kiện) và provider runtime (log INFO lý do khi `auto` tắt): không có hai định nghĩa lệch nhau.
 * 3D thêm cờ support grant vào cùng kiểu.
 */
export const FEATURE_TRI_STATES = ['auto', 'on', 'off'] as const;
export type FeatureTriState = (typeof FEATURE_TRI_STATES)[number];
export type FeatureDisabledReason = 'OFF' | 'MISSING_ACCEPT_URL' | 'MISSING_JOIN_URL' | 'MISSING_EMAIL_CLAIM';
export type FeatureState = { enabled: true } | { enabled: false; reason: FeatureDisabledReason };
export type TenancyFeatureStates = { emailInvitations: FeatureState; inviteLinks: FeatureState };
export type TenancyFeatureInput = {
  emailInvitations: FeatureTriState;
  invitationAcceptUrl: string | undefined;
  inviteLinks: FeatureTriState;
  inviteLinkJoinUrl: string | undefined;
};
export type IdentityFeatureInput = { mode: string; externalEmailClaim: string | undefined };

const ENABLED: FeatureState = { enabled: true };
const disabled = (reason: FeatureDisabledReason): FeatureState => ({ enabled: false, reason });

export function resolveTenancyFeatures(t: TenancyFeatureInput, id: IdentityFeatureInput): TenancyFeatureStates {
  const emailInvitations =
    t.emailInvitations === 'off'
      ? disabled('OFF')
      : !t.invitationAcceptUrl
        ? disabled('MISSING_ACCEPT_URL')
        : id.mode === 'external' && !id.externalEmailClaim
          ? disabled('MISSING_EMAIL_CLAIM')
          : ENABLED;
  const inviteLinks = t.inviteLinks === 'off' ? disabled('OFF') : !t.inviteLinkJoinUrl ? disabled('MISSING_JOIN_URL') : ENABLED;
  return { emailInvitations, inviteLinks };
}

function need(reason: FeatureDisabledReason): string {
  switch (reason) {
    case 'MISSING_ACCEPT_URL':
      return 'TENANCY_INVITATION_ACCEPT_URL';
    case 'MISSING_JOIN_URL':
      return 'TENANCY_INVITE_LINK_JOIN_URL';
    case 'MISSING_EMAIL_CLAIM':
      return 'AUTH_EXTERNAL_EMAIL_CLAIM when AUTH_MODE=external';
    case 'OFF':
      throw new Error('an "on" flag cannot resolve to OFF');
    default: {
      const unknown: never = reason;
      throw new Error(`unknown feature reason ${String(unknown)}`);
    }
  }
}

/** Cờ `on` mà điều kiện thiếu là lỗi cấu hình (không khởi động); `auto` tắt êm và provider log lý do. */
export function featureConfigProblems(t: TenancyFeatureInput, s: TenancyFeatureStates): string[] {
  const out: string[] = [];
  if (t.emailInvitations === 'on' && !s.emailInvitations.enabled) out.push(`TENANCY_EMAIL_INVITATIONS=on needs ${need(s.emailInvitations.reason)}`);
  if (t.inviteLinks === 'on' && !s.inviteLinks.enabled) out.push(`TENANCY_INVITE_LINKS=on needs ${need(s.inviteLinks.reason)}`);
  return out;
}
```
Run lại Step 1 → PASS.

- [ ] **Step 3: Config tenancy (fail → pass)**

`test/unit/modules/tenancy/tenancy-config.spec.ts` — trong ca `defaults boot with no env at all`, thêm vào object mong đợi:
```ts
      emailInvitations: 'auto',
      invitationAcceptUrl: undefined,
      invitationTtlSec: 604_800,
      maxPendingInvitationsPerOrg: 100,
      inviteLinks: 'auto',
      inviteLinkJoinUrl: undefined,
      inviteLinkMaxTtlSec: 2_592_000,
      inviteLinkMaxUsesLimit: 1000,
      maxActiveInviteLinksPerOrg: 10,
      tokenPreviewLimit: 20,
      tokenPreviewTtlMs: 60_000,
      ownershipTransferTtlSec: 604_800,
```
thêm vào bảng `it.each` của ca `rejects %j`:
```ts
    [{ emailInvitations: 'yes' }],
    [{ invitationAcceptUrl: 'app.example.test/accept' }],
    [{ invitationAcceptUrl: 'https://app.example.test/accept?x=1' }],
    [{ invitationAcceptUrl: 'https://app.example.test/accept#token=' }],
    [{ invitationAcceptUrl: 'ftp://app.example.test/accept' }],
    [{ invitationTtlSec: '3599' }],
    [{ invitationTtlSec: '2592001' }],
    [{ maxPendingInvitationsPerOrg: '10001' }],
    [{ inviteLinkMaxTtlSec: '31536001' }],
    [{ inviteLinkMaxUsesLimit: '100001' }],
    [{ maxActiveInviteLinksPerOrg: '1001' }],
    [{ tokenPreviewLimit: '0' }],
    [{ tokenPreviewTtlMs: '1500' }],
    [{ ownershipTransferTtlSec: '3599' }],
```
và các ca:
```ts
  it('every environment: an "on" feature missing its condition refuses to boot, "auto" does not', () => {
    const r = configRuleRegistry().find((x) => x.name === 'tenancy-features-on');
    if (!r) throw new Error('config rule tenancy-features-on is not registered');
    const tenancy = { emailInvitations: 'on', invitationAcceptUrl: undefined, inviteLinks: 'auto', inviteLinkJoinUrl: undefined };
    expect(r.rule({ tenancy, identity: { mode: 'local', externalEmailClaim: undefined } })).toMatch(/TENANCY_EMAIL_INVITATIONS=on needs TENANCY_INVITATION_ACCEPT_URL/);
    expect(r.rule({ tenancy: { ...tenancy, emailInvitations: 'auto' }, identity: { mode: 'local', externalEmailClaim: undefined } })).toBeUndefined();
    expect(
      r.rule({ tenancy: { ...tenancy, invitationAcceptUrl: 'https://a.test/x' }, identity: { mode: 'external', externalEmailClaim: undefined } }),
    ).toMatch(/AUTH_EXTERNAL_EMAIL_CLAIM/);
  });
  it('production: frontend URLs must be https and on an origin of HTTP_CORS_ORIGINS', () => {
    const r = rule('tenancy-frontend-urls');
    const http = { corsOrigins: ['https://app.example.test'] };
    expect(r({ http, tenancy: { invitationAcceptUrl: 'https://app.example.test/accept', inviteLinkJoinUrl: 'https://app.example.test/join' } })).toBeUndefined();
    expect(r({ http, tenancy: { invitationAcceptUrl: undefined, inviteLinkJoinUrl: undefined } })).toBeUndefined();
    expect(r({ http, tenancy: { invitationAcceptUrl: 'http://app.example.test/accept' } })).toMatch(/TENANCY_INVITATION_ACCEPT_URL must use https/);
    expect(r({ http, tenancy: { inviteLinkJoinUrl: 'https://evil.example.test/join' } })).toMatch(/TENANCY_INVITE_LINK_JOIN_URL must be on an origin listed in HTTP_CORS_ORIGINS/);
  });
```
(Thêm import `configRuleRegistry` từ `../../../../src/core/config/config.registry.js`.)

Run: `pnpm vitest run --project unit test/unit/modules/tenancy/tenancy-config.spec.ts` → FAIL.

`src/modules/tenancy/tenancy.config.ts` — thêm `defineConfigRule` vào import có sẵn từ `../../core/config/index.js` (một câu import mỗi module, không import trùng), rồi thêm import và hằng:
```ts
import { FEATURE_TRI_STATES, featureConfigProblems, resolveTenancyFeatures } from './domain/tenancy-features.js';

const SECONDS_PER_HOUR = 3600;
const MIN_TOKEN_TTL_SEC = SECONDS_PER_HOUR;
const MAX_INVITATION_TTL_SEC = 30 * SECONDS_PER_DAY;
const MAX_INVITE_LINK_TTL_SEC = 365 * SECONDS_PER_DAY;
const MAX_TRANSFER_TTL_SEC = 30 * SECONDS_PER_DAY;
const MAX_PENDING_INVITATIONS = 10_000;
const MAX_INVITE_LINK_USES = 100_000;
const MAX_ACTIVE_INVITE_LINKS = 1000;

/** URL frontend tuyệt đối (http/https), không query, không fragment: app nối `#token=` vào cuối (spec §13). */
const isFrontendUrl = (s: string): boolean => {
  if (!URL.canParse(s) || s.includes('?') || s.includes('#')) return false;
  const u = new URL(s);
  return u.protocol === 'https:' || u.protocol === 'http:';
};
const frontendUrl = z
  .string()
  .optional()
  .transform((s) => (s ? s : undefined))
  .refine((s) => s === undefined || isFrontendUrl(s), 'must be an absolute http(s) URL without query or fragment');
const triState = z.enum(FEATURE_TRI_STATES);
```
(`SECONDS_PER_DAY` đã có trong file; khai hằng mới SAU nó.) Trong object env của `defineConfig` thêm:
```ts
    emailInvitations: 'TENANCY_EMAIL_INVITATIONS',
    invitationAcceptUrl: 'TENANCY_INVITATION_ACCEPT_URL',
    invitationTtlSec: 'TENANCY_INVITATION_TTL_SEC',
    maxPendingInvitationsPerOrg: 'TENANCY_MAX_PENDING_INVITATIONS_PER_ORG',
    inviteLinks: 'TENANCY_INVITE_LINKS',
    inviteLinkJoinUrl: 'TENANCY_INVITE_LINK_JOIN_URL',
    inviteLinkMaxTtlSec: 'TENANCY_INVITE_LINK_MAX_TTL_SEC',
    inviteLinkMaxUsesLimit: 'TENANCY_INVITE_LINK_MAX_USES_LIMIT',
    maxActiveInviteLinksPerOrg: 'TENANCY_MAX_ACTIVE_INVITE_LINKS_PER_ORG',
    tokenPreviewLimit: 'TENANCY_TOKEN_PREVIEW_RATE_LIMIT',
    tokenPreviewTtlMs: 'TENANCY_TOKEN_PREVIEW_RATE_TTL_MS',
    ownershipTransferTtlSec: 'TENANCY_OWNERSHIP_TRANSFER_TTL_SEC',
```
và trong `z.object({...})`:
```ts
    emailInvitations: triState
      .default('auto')
      .describe('auto: on when TENANCY_INVITATION_ACCEPT_URL is set (and AUTH_EXTERNAL_EMAIL_CLAIM in external mode); on: required; off'),
    invitationAcceptUrl: frontendUrl.describe('Frontend page that accepts an invitation; the app appends #token=<token> (production: https, on HTTP_CORS_ORIGINS)'),
    invitationTtlSec: positiveInt.min(MIN_TOKEN_TTL_SEC).max(MAX_INVITATION_TTL_SEC).default(604_800).describe('Seconds an email invitation stays valid'),
    maxPendingInvitationsPerOrg: positiveInt.max(MAX_PENDING_INVITATIONS).default(100).describe('Pending, unexpired invitations one organization may hold'),
    inviteLinks: triState.default('auto').describe('auto: on when TENANCY_INVITE_LINK_JOIN_URL is set; on: required; off'),
    inviteLinkJoinUrl: frontendUrl.describe('Frontend page that joins through an invite link; the app appends #token=<token> (production: https, on HTTP_CORS_ORIGINS)'),
    inviteLinkMaxTtlSec: positiveInt.min(MIN_TOKEN_TTL_SEC).max(MAX_INVITE_LINK_TTL_SEC).default(2_592_000).describe('Longest lifetime of an invite link'),
    inviteLinkMaxUsesLimit: positiveInt.max(MAX_INVITE_LINK_USES).default(1000).describe('Largest maxUses of an invite link'),
    maxActiveInviteLinksPerOrg: positiveInt.max(MAX_ACTIVE_INVITE_LINKS).default(10).describe('Open (unrevoked, unexpired, not exhausted) invite links per organization'),
    tokenPreviewLimit: positiveInt.default(20).describe('Invitation/invite link previews per window per client IP'),
    tokenPreviewTtlMs: windowMs.default(60_000).describe('Token preview window and block duration (ms, whole seconds)'),
    ownershipTransferTtlSec: positiveInt.min(MIN_TOKEN_TTL_SEC).max(MAX_TRANSFER_TTL_SEC).default(604_800).describe('Seconds an ownership transfer request stays open'),
```
Thêm cuối file:
```ts
/** Spec SP3 §13 "Luật mọi môi trường": cờ `on` thiếu điều kiện → không khởi động (qua CÙNG hàm của provider runtime). */
const FeatureRuleInput = z.object({
  tenancy: z.object({
    emailInvitations: triState,
    invitationAcceptUrl: z.string().optional(),
    inviteLinks: triState,
    inviteLinkJoinUrl: z.string().optional(),
  }),
  identity: z.object({ mode: z.string(), externalEmailClaim: z.string().optional() }),
});
defineConfigRule('tenancy-features-on', (c) => {
  const parsed = FeatureRuleInput.safeParse(c);
  if (!parsed.success) return 'tenancy features rule needs the tenancy and identity namespaces';
  const { tenancy, identity } = parsed.data;
  const t = { ...tenancy, invitationAcceptUrl: tenancy.invitationAcceptUrl, inviteLinkJoinUrl: tenancy.inviteLinkJoinUrl };
  const problems = featureConfigProblems(t, resolveTenancyFeatures(t, { mode: identity.mode, externalEmailClaim: identity.externalEmailClaim }));
  return problems.length ? problems.join('; ') : undefined;
});
/** Spec SP3 §13 "Luật production": URL frontend (khi có) là https và thuộc HTTP_CORS_ORIGINS. */
defineProductionRule('tenancy-frontend-urls', (c) => {
  const origins = Array.isArray(c.http?.corsOrigins) ? c.http.corsOrigins : [];
  const urls: [string, unknown][] = [
    ['TENANCY_INVITATION_ACCEPT_URL', c.tenancy?.invitationAcceptUrl],
    ['TENANCY_INVITE_LINK_JOIN_URL', c.tenancy?.inviteLinkJoinUrl],
  ];
  for (const [name, value] of urls) {
    if (typeof value !== 'string') continue;
    const u = new URL(value);
    if (u.protocol !== 'https:') return `${name} must use https in production`;
    if (!origins.includes(u.origin)) return `${name} must be on an origin listed in HTTP_CORS_ORIGINS`;
  }
  return undefined;
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/tenancy-config.spec.ts test/unit/modules/tenancy/tenancy-features.spec.ts` → PASS.

- [ ] **Step 4: Claim email của `external` và export `normalizeEmail`**

`test/unit/modules/identity/identity-config.spec.ts` — thêm ca:
```ts
  it('external email claim: empty by default (off), verified claim defaults to email_verified (spec SP3 §5.2)', () => {
    stub({});
    expect(identityConfig()).toMatchObject({ externalEmailClaim: undefined, externalEmailVerifiedClaim: 'email_verified' });
    stub({ ...EXTERNAL_MIN, AUTH_EXTERNAL_EMAIL_CLAIM: 'email', AUTH_EXTERNAL_EMAIL_VERIFIED_CLAIM: 'mail_ok' });
    expect(identityConfig()).toMatchObject({ externalEmailClaim: 'email', externalEmailVerifiedClaim: 'mail_ok' });
  });
```
Run → FAIL.

`src/modules/identity/identity.config.ts` — thêm vào object env (cạnh `externalAdminValue`):
```ts
    externalEmailClaim: 'AUTH_EXTERNAL_EMAIL_CLAIM',
    externalEmailVerifiedClaim: 'AUTH_EXTERNAL_EMAIL_VERIFIED_CLAIM',
```
và vào schema (cạnh `externalAdminValue`):
```ts
      externalEmailClaim: optionalText.describe(
        'Claim carrying the user email (external mode); empty disables email invitations in external mode (spec SP3 §11)',
      ),
      externalEmailVerifiedClaim: z
        .string()
        .min(1)
        .default('email_verified')
        .describe('Claim that must be exactly true for the email claim to count as verified'),
```
`src/modules/identity/infra/jwks/jwks.provider.ts` — thêm import `import { normalizeEmail } from '../better-auth/email-normalize.js';`, hằng `const MAX_EMAIL_LENGTH = 254;` (cạnh `MAX_SUB_LENGTH`), đổi `verifiedEmail: undefined,` trong `verify()` thành `verifiedEmail: this.verifiedEmailOf(payload),` và thêm method cạnh `isAdmin`:
```ts
  /**
   * Spec SP3 §11 (3C): email chỉ dùng ở chấp nhận lời mời, nên chỉ nhận khi claim verified là đúng `true` (không phải
   * chuỗi "true"); thiếu cấu hình, sai kiểu, rỗng hoặc dài hơn 254 → `undefined` (lời mời trả `403 email_not_verified`).
   */
  private verifiedEmailOf(payload: JWTPayload): string | undefined {
    const claim = this.cfg.externalEmailClaim;
    if (!claim) return undefined;
    const email = payload[claim];
    if (typeof email !== 'string' || email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined;
    return payload[this.cfg.externalEmailVerifiedClaim] === true ? normalizeEmail(email) : undefined;
  }
```
Sửa chú thích của field `verifiedEmail` trong `src/modules/identity/ports/auth-provider.ts` thành: `/** Email chuẩn hoá khi đã xác thực: local/hybrid từ \`user.email\`; external từ claim \`AUTH_EXTERNAL_EMAIL_CLAIM\` khi claim verified === true (3C). */`.

`src/modules/identity/index.ts` — thêm:
```ts
export { normalizeEmail } from './infra/better-auth/email-normalize.js';
```
(Tenancy chuẩn hoá email được mời bằng CÙNG hàm với email đã xác thực của identity; spec §9.1 bước 1. Luật `modules-only-index-of-other-modules` buộc đi qua `index.ts`.)

Run: `pnpm vitest run --project unit test/unit/modules/identity/identity-config.spec.ts test/unit/modules/identity/email-normalize.spec.ts` → PASS.

- [ ] **Step 5: Lỗi `feature_disabled`, provider `TenancyFeatures`, env test/smoke, `.env.example`**

`src/modules/tenancy/errors.ts` — thêm vào `TenancyErrors`:
```ts
  FEATURE_DISABLED: {
    status: HttpStatus.FORBIDDEN,
    title: 'This feature is disabled',
  },
```
(Nếu 3D đã merge trước và định nghĩa `FEATURE_DISABLED`, không thêm lần hai: `defineErrorCodes` ném khi trùng mã; dùng mã có sẵn.)

`src/modules/tenancy/application/tenancy-features.ts`:
```ts
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { AppError } from '../../../core/errors/index.js';
import { identityConfig } from '../../identity/index.js';
import { resolveTenancyFeatures, type FeatureState, type TenancyFeatureStates } from '../domain/tenancy-features.js';
import { TenancyErrors } from '../errors.js';
import { tenancyConfig } from '../tenancy.config.js';

const labelOf = (s: FeatureState): string => (s.enabled ? 'enabled' : s.reason);

/**
 * Trạng thái hiệu lực của cờ thu nhận (spec SP3 §13): tính MỘT lần bằng cùng hàm với luật config, log INFO lúc boot (không
 * URL, không secret) để `auto` thiếu URL ở production không tắt tính năng âm thầm.
 */
@Injectable()
export class TenancyFeatures implements OnModuleInit {
  private readonly logger = new Logger(TenancyFeatures.name);
  readonly states: TenancyFeatureStates;

  constructor(
    @Inject(tenancyConfig.KEY) cfg: ConfigOf<typeof tenancyConfig>,
    @Inject(identityConfig.KEY) identity: ConfigOf<typeof identityConfig>,
  ) {
    this.states = resolveTenancyFeatures(cfg, { mode: identity.mode, externalEmailClaim: identity.externalEmailClaim });
  }

  onModuleInit(): void {
    this.logger.log(
      { event: 'tenancy_features', emailInvitations: labelOf(this.states.emailInvitations), inviteLinks: labelOf(this.states.inviteLinks) },
      'tenancy acquisition features resolved',
    );
  }

  /** Route tạo lời mời/link khi tính năng tắt → `403 feature_disabled` (chấp nhận/preview của cái đã có vẫn chạy). */
  require(feature: keyof TenancyFeatureStates): void {
    if (!this.states[feature].enabled) throw new AppError(TenancyErrors.FEATURE_DISABLED, { expected: true });
  }
}
```
`src/modules/tenancy/http/tenancy-http.module.ts` — thêm `TenancyFeatures` vào `providers` (import từ `../application/tenancy-features.js`).

`test/support/env.ts` — trong object của `baseTestEnv()` thêm (sau `HTTP_CORS_ORIGINS`):
```ts
    // Spec SP3 §13 "Env cần sửa": bật lời mời/link trong e2e (origin trùng HTTP_CORS_ORIGINS như luật production).
    TENANCY_INVITATION_ACCEPT_URL: 'http://localhost:3000/invitations/accept',
    TENANCY_INVITE_LINK_JOIN_URL: 'http://localhost:3000/join',
```
`test/smoke/smoke-app-env.ts` — trong object trả về của `smokeAppEnv` thêm:
```ts
  TENANCY_INVITATION_ACCEPT_URL: `${SMOKE_BASE_URL}/invitations/accept`,
  TENANCY_INVITE_LINK_JOIN_URL: `${SMOKE_BASE_URL}/join`,
```
Run: `pnpm env:example` rồi `git diff --stat .env.example` → thêm 14 khoá mới (12 tenancy + 2 identity) với mô tả.

- [ ] **Step 6: Chạy, commit**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/tenancy test/unit/modules/identity test/unit/core/config
pnpm vitest run --project integration test/e2e/tenancy/tenancy-http-boot.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts
```
Expected: PASS; `auth-modes` (external không có env mới) vẫn khởi động — cờ `auto` tắt với lý do `MISSING_ACCEPT_URL`/`MISSING_EMAIL_CLAIM`, không lỗi (INT-I12).
```bash
pnpm exec prettier --write src/modules/tenancy src/modules/identity test/unit/modules/tenancy test/unit/modules/identity test/support/env.ts test/smoke/smoke-app-env.ts
git add src/modules/tenancy src/modules/identity test/unit/modules/tenancy test/unit/modules/identity test/support/env.ts test/smoke/smoke-app-env.ts .env.example
git commit -m "feat(tenancy): acquisition config, resolveTenancyFeatures and the feature_disabled error; identity reads a verified email claim in external mode"
```

---

## Phần D — Miền thuần (spec §9.1–9.3, §13)

### Task 6: Token, state machine lời mời/chuyển quyền, trạng thái suy ra của link, văn bản một dòng cho thư

**Files:**
- Create: `src/modules/tenancy/domain/acquisition-token.ts`, `src/modules/tenancy/domain/expiry.ts`, `src/modules/tenancy/domain/invitation.ts`, `src/modules/tenancy/domain/invite-link.ts`, `src/modules/tenancy/domain/ownership-transfer.ts`, `src/modules/tenancy/domain/display-text.ts`, `test/unit/modules/tenancy/acquisition-token.spec.ts`, `test/unit/modules/tenancy/invitation.spec.ts`, `test/unit/modules/tenancy/invite-link.spec.ts`, `test/unit/modules/tenancy/ownership-transfer.spec.ts`, `test/unit/modules/tenancy/display-text.spec.ts`

**Interfaces:**
- Consumes: `INVITE_TOKEN_BYTES`, `TOKEN_HASH_BYTES`, `STEP_DOWN_ROLES` (Task 2).
- Produces:
  - `acquisition-token.ts`: `type AcquisitionToken = { token: string; hashHex: string }`, `newAcquisitionToken(): AcquisitionToken`, `tokenHashHex(token: string): string` (64 ký tự hex), `tokenUrl(base: string, token: string): string` (`<base>#token=<token>`).
  - `expiry.ts`: `isLapsed(expiresAt: Date, now: Date): boolean` (`expiresAt <= now`: đúng lúc hết hạn là đã hết, khớp `expires_at > clock_timestamp()` của SQL).
  - `invitation.ts`: `INVITATION_STATUSES`, `type InvitationStatus`, `type InvitationEvent = 'ACCEPT' | 'REVOKE' | 'EXPIRE' | 'INVALIDATE'`, `transitionInvitation(from, event): { ok: true; to } | { ok: false; reason: 'NOT_PENDING' }`, `effectiveInvitationStatus(r: { status; expiresAt }, now): InvitationStatus`, `INVALIDATION_REASONS`, `type InvalidationReason = 'INVITER_GONE' | 'INVITER_LACKS_GATE' | 'INVITER_NOT_DOMINANT'`.
  - `invite-link.ts`: `INVITE_LINK_STATUSES`, `type InviteLinkStatus = 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'REVOKED'`, `inviteLinkStatusOf(l: { revokedAt; expiresAt; useCount; maxUses }, now): InviteLinkStatus`, `INVITE_LINK_REVOKE_REASONS`, `type InviteLinkRevokeReason = 'REVOKED' | 'INVALIDATED' | 'ROLE_DELETED'`.
  - `ownership-transfer.ts`: `TRANSFER_STATUSES`, `type TransferStatus`, `type TransferEvent = 'ACCEPT' | 'DECLINE' | 'CANCEL' | 'EXPIRE'`, `transitionTransfer(from, event)`, `effectiveTransferStatus(r, now)`, `TRANSFER_CANCEL_REASONS`, `type TransferCancelReason = 'CANCELLED' | 'MEMBER_REMOVED' | 'INITIATOR_NOT_OWNER'`.
  - `display-text.ts`: `oneLine(s: string, max: number): string` (gộp mọi ngắt dòng thành một khoảng trắng, cắt ở `max` đơn vị UTF-16 không tách đôi cặp surrogate).

- [ ] **Step 1: Test (fail)**

`test/unit/modules/tenancy/acquisition-token.spec.ts`:
```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newAcquisitionToken, tokenHashHex, tokenUrl } from '../../../../src/modules/tenancy/domain/acquisition-token.js';

describe('acquisition tokens (spec SP3 §9.1: 256 bit, only the SHA-256 is stored)', () => {
  it('a token is 32 random bytes in base64url (43 chars) and its hash is 32 bytes of hex', () => {
    const { token, hashHex } = newAcquisitionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHex).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(tokenHashHex(token)).toBe(hashHex);
  });
  it('two tokens never collide in practice', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newAcquisitionToken().token));
    expect(seen.size).toBe(1000);
  });
  it('the token goes in the URL fragment (never logged by servers, never in Referer)', () => {
    expect(tokenUrl('https://app.example.test/invitations/accept', 'abc')).toBe('https://app.example.test/invitations/accept#token=abc');
  });
});
```
`test/unit/modules/tenancy/invitation.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isLapsed } from '../../../../src/modules/tenancy/domain/expiry.js';
import {
  INVITATION_STATUSES,
  effectiveInvitationStatus,
  transitionInvitation,
  type InvitationEvent,
} from '../../../../src/modules/tenancy/domain/invitation.js';

const EVENTS: readonly InvitationEvent[] = ['ACCEPT', 'REVOKE', 'EXPIRE', 'INVALIDATE'];
const TO = { ACCEPT: 'ACCEPTED', REVOKE: 'REVOKED', EXPIRE: 'EXPIRED', INVALIDATE: 'INVALIDATED' } as const;

describe('invitation state machine (spec SP3 §9.1): every (status × event) pair', () => {
  for (const status of INVITATION_STATUSES)
    for (const event of EVENTS)
      it(`${status} --${event}-->`, () => {
        expect(transitionInvitation(status, event)).toEqual(status === 'PENDING' ? { ok: true, to: TO[event] } : { ok: false, reason: 'NOT_PENDING' });
      });
  it('a PENDING invitation reads as EXPIRED at and after expires_at; other statuses never change', () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    expect(isLapsed(at, new Date(at.getTime() - 1))).toBe(false);
    expect(isLapsed(at, at)).toBe(true);
    expect(effectiveInvitationStatus({ status: 'PENDING', expiresAt: at }, at)).toBe('EXPIRED');
    expect(effectiveInvitationStatus({ status: 'PENDING', expiresAt: at }, new Date(at.getTime() - 1))).toBe('PENDING');
    expect(effectiveInvitationStatus({ status: 'REVOKED', expiresAt: at }, new Date(at.getTime() + 1))).toBe('REVOKED');
  });
});
```
`test/unit/modules/tenancy/invite-link.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { inviteLinkStatusOf } from '../../../../src/modules/tenancy/domain/invite-link.js';

const now = new Date('2026-10-01T00:00:00.000Z');
const later = new Date(now.getTime() + 1000);
const base = { revokedAt: null, expiresAt: later, useCount: 0, maxUses: 2 };

describe('invite link derived status (spec SP3 §6.8: REVOKED > EXPIRED > EXHAUSTED > ACTIVE)', () => {
  it.each([
    ['ACTIVE', base],
    ['EXHAUSTED', { ...base, useCount: 2 }],
    ['EXPIRED', { ...base, expiresAt: now }],
    ['EXPIRED', { ...base, expiresAt: now, useCount: 2 }],
    ['REVOKED', { ...base, revokedAt: now }],
    ['REVOKED', { ...base, revokedAt: now, expiresAt: now, useCount: 2 }],
  ] as const)('%s', (expected, link) => {
    expect(inviteLinkStatusOf(link, now)).toBe(expected);
  });
});
```
`test/unit/modules/tenancy/ownership-transfer.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  TRANSFER_STATUSES,
  effectiveTransferStatus,
  transitionTransfer,
  type TransferEvent,
} from '../../../../src/modules/tenancy/domain/ownership-transfer.js';

const EVENTS: readonly TransferEvent[] = ['ACCEPT', 'DECLINE', 'CANCEL', 'EXPIRE'];
const TO = { ACCEPT: 'ACCEPTED', DECLINE: 'DECLINED', CANCEL: 'CANCELLED', EXPIRE: 'EXPIRED' } as const;

describe('ownership transfer state machine (spec SP3 §9.3): every (status × event) pair', () => {
  for (const status of TRANSFER_STATUSES)
    for (const event of EVENTS)
      it(`${status} --${event}-->`, () => {
        expect(transitionTransfer(status, event)).toEqual(status === 'PENDING' ? { ok: true, to: TO[event] } : { ok: false, reason: 'NOT_PENDING' });
      });
  it('a PENDING request reads as EXPIRED at expires_at', () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    expect(effectiveTransferStatus({ status: 'PENDING', expiresAt: at }, at)).toBe('EXPIRED');
    expect(effectiveTransferStatus({ status: 'DECLINED', expiresAt: at }, at)).toBe('DECLINED');
  });
});
```
`test/unit/modules/tenancy/display-text.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { oneLine } from '../../../../src/modules/tenancy/domain/display-text.js';

describe('oneLine (email params reject CR/LF and > DISPLAY_NAME_MAX; org/role names may contain them)', () => {
  it.each([
    ['Acme', 10, 'Acme'],
    ['Acme\r\nBcc: x@example.test', 100, 'Acme Bcc: x@example.test'],
    ['A B C\nD', 100, 'A B C D'],
    ['  padded  ', 100, 'padded'],
    ['abcdef', 3, 'abc'],
    ['ab😀', 3, 'ab'],
    ['😀😀', 4, '😀😀'],
  ])('%j (max %i) → %j', (input, max, expected) => {
    expect(oneLine(input, max)).toBe(expected);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/acquisition-token.spec.ts test/unit/modules/tenancy/invitation.spec.ts test/unit/modules/tenancy/invite-link.spec.ts test/unit/modules/tenancy/ownership-transfer.spec.ts test/unit/modules/tenancy/display-text.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Cài đặt**

`src/modules/tenancy/domain/acquisition-token.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { INVITE_TOKEN_BYTES } from '../constants.js';

export type AcquisitionToken = { token: string; hashHex: string };

/** Spec SP3 §9.1: chỉ SHA-256 được lưu; hex để đi qua `Db.execute` rồi `decode(?, 'hex')` trong SQL. */
export const tokenHashHex = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export function newAcquisitionToken(): AcquisitionToken {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
  return { token, hashHex: tokenHashHex(token) };
}

/** Token ở fragment URL: không vào log server, không vào `Referer` của frontend (spec §9.1). */
export const tokenUrl = (base: string, token: string): string => `${base}#token=${token}`;
```
`src/modules/tenancy/domain/expiry.ts`:
```ts
/** Đúng lúc `expires_at` là đã hết hạn: khớp predicate SQL `expires_at > clock_timestamp()` của CAS (spec §3.15). */
export const isLapsed = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() <= now.getTime();
```
`src/modules/tenancy/domain/invitation.ts`:
```ts
import { isLapsed } from './expiry.js';

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'INVALIDATED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
export type InvitationEvent = 'ACCEPT' | 'REVOKE' | 'EXPIRE' | 'INVALIDATE';
export type InvitationTransition = { ok: true; to: InvitationStatus } | { ok: false; reason: 'NOT_PENDING' };
/** Lý do vô hiệu lúc chấp nhận (spec §14): kiểm lại cửa + trần với người mời HIỆN TẠI (§8.4 đường b). */
export const INVALIDATION_REASONS = ['INVITER_GONE', 'INVITER_LACKS_GATE', 'INVITER_NOT_DOMINANT'] as const;
export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

/** Spec §9.1: chỉ PENDING chuyển được; bốn trạng thái còn lại là cuối. */
export function transitionInvitation(from: InvitationStatus, event: InvitationEvent): InvitationTransition {
  switch (from) {
    case 'PENDING':
      switch (event) {
        case 'ACCEPT':
          return { ok: true, to: 'ACCEPTED' };
        case 'REVOKE':
          return { ok: true, to: 'REVOKED' };
        case 'EXPIRE':
          return { ok: true, to: 'EXPIRED' };
        case 'INVALIDATE':
          return { ok: true, to: 'INVALIDATED' };
        default: {
          const unknown: never = event;
          throw new Error(`unknown invitation event ${String(unknown)}`);
        }
      }
    case 'ACCEPTED':
    case 'REVOKED':
    case 'EXPIRED':
    case 'INVALIDATED':
      return { ok: false, reason: 'NOT_PENDING' };
    default: {
      const unknown: never = from;
      throw new Error(`unknown invitation status ${String(unknown)}`);
    }
  }
}

/** Hết hạn suy ra từ thời gian (S3-A24): PENDING quá hạn hiển thị EXPIRED, dòng chỉ được ghi EXPIRED khi bị chạm. */
export const effectiveInvitationStatus = (r: { status: InvitationStatus; expiresAt: Date }, now: Date): InvitationStatus =>
  r.status === 'PENDING' && isLapsed(r.expiresAt, now) ? 'EXPIRED' : r.status;
```
`src/modules/tenancy/domain/invite-link.ts`:
```ts
import { isLapsed } from './expiry.js';

export const INVITE_LINK_STATUSES = ['ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED'] as const;
export type InviteLinkStatus = (typeof INVITE_LINK_STATUSES)[number];
export const INVITE_LINK_REVOKE_REASONS = ['REVOKED', 'INVALIDATED', 'ROLE_DELETED'] as const;
export type InviteLinkRevokeReason = (typeof INVITE_LINK_REVOKE_REASONS)[number];

/** Spec §6.8: trạng thái suy ra, không lưu; "đang mở" = ACTIVE (cùng định nghĩa cho trần mỗi org, preview, join). */
export function inviteLinkStatusOf(
  l: { revokedAt: Date | null; expiresAt: Date; useCount: number; maxUses: number },
  now: Date,
): InviteLinkStatus {
  if (l.revokedAt !== null) return 'REVOKED';
  if (isLapsed(l.expiresAt, now)) return 'EXPIRED';
  if (l.useCount >= l.maxUses) return 'EXHAUSTED';
  return 'ACTIVE';
}
```
`src/modules/tenancy/domain/ownership-transfer.ts`:
```ts
import { isLapsed } from './expiry.js';

export const TRANSFER_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export type TransferEvent = 'ACCEPT' | 'DECLINE' | 'CANCEL' | 'EXPIRE';
export type TransferTransition = { ok: true; to: TransferStatus } | { ok: false; reason: 'NOT_PENDING' };
export const TRANSFER_CANCEL_REASONS = ['CANCELLED', 'MEMBER_REMOVED', 'INITIATOR_NOT_OWNER'] as const;
export type TransferCancelReason = (typeof TRANSFER_CANCEL_REASONS)[number];

/** Spec §9.3 (PR13). */
export function transitionTransfer(from: TransferStatus, event: TransferEvent): TransferTransition {
  switch (from) {
    case 'PENDING':
      switch (event) {
        case 'ACCEPT':
          return { ok: true, to: 'ACCEPTED' };
        case 'DECLINE':
          return { ok: true, to: 'DECLINED' };
        case 'CANCEL':
          return { ok: true, to: 'CANCELLED' };
        case 'EXPIRE':
          return { ok: true, to: 'EXPIRED' };
        default: {
          const unknown: never = event;
          throw new Error(`unknown transfer event ${String(unknown)}`);
        }
      }
    case 'ACCEPTED':
    case 'DECLINED':
    case 'CANCELLED':
    case 'EXPIRED':
      return { ok: false, reason: 'NOT_PENDING' };
    default: {
      const unknown: never = from;
      throw new Error(`unknown transfer status ${String(unknown)}`);
    }
  }
}

export const effectiveTransferStatus = (r: { status: TransferStatus; expiresAt: Date }, now: Date): TransferStatus =>
  r.status === 'PENDING' && isLapsed(r.expiresAt, now) ? 'EXPIRED' : r.status;
```
`src/modules/tenancy/domain/display-text.ts`:
```ts
const LINE_BREAKS = /[\r\n  ]+/g;

/**
 * Tên org/role/người vào thư (schema `displayName` của notifications chặn CR/LF và độ dài): tên org/role hợp lệ ở DB có
 * thể chứa ngắt dòng hoặc dài hơn trần hiển thị. Gộp ngắt dòng thành khoảng trắng, cắt theo code point (không tách đôi
 * cặp surrogate) ở tối đa `max` đơn vị UTF-16 (cách `z.string().max` đếm).
 */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(LINE_BREAKS, ' ').trim();
  let out = '';
  for (const ch of flat) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
```

- [ ] **Step 3: Chạy, commit**

Run: lệnh của Step 1 → PASS; `pnpm arch` → không vi phạm (`domain-pure`: chỉ `node:crypto` và file cùng thư mục).
```bash
pnpm exec prettier --write src/modules/tenancy/domain test/unit/modules/tenancy
git add src/modules/tenancy/domain test/unit/modules/tenancy
git commit -m "feat(tenancy): acquisition tokens, invitation and transfer state machines, derived invite link status"
```

---

## Phần E — Ứng dụng: repository, admission, dịch vụ, HTTP (spec §8.4 đường b–d, §9, §12, §14–§16)

### Task 7: Lỗi, map constraint, event, metric, và ba repository SQL

**Files:**
- Create: `src/modules/tenancy/ports/invitation-repository.ts`, `src/modules/tenancy/ports/invite-link-repository.ts`, `src/modules/tenancy/ports/ownership-transfer-repository.ts`, `src/modules/tenancy/infra/sql/sql-invitation.repository.ts`, `src/modules/tenancy/infra/sql/sql-invite-link.repository.ts`, `src/modules/tenancy/infra/sql/sql-ownership-transfer.repository.ts`, `test/integration/tenancy/acquisition-repositories.spec.ts`
- Modify: `src/modules/tenancy/errors.ts`, `src/modules/tenancy/events.ts`, `src/modules/tenancy/index.ts`, `src/modules/tenancy/application/tenancy-metrics.ts`, `src/modules/tenancy/ports/org-repository.ts`, `src/modules/tenancy/infra/sql/sql-org.repository.ts`, `src/modules/tenancy/tenancy.module.ts`, `test/unit/modules/tenancy/errors.spec.ts`

**Interfaces:**
- Consumes: `Db`, `single`, `countUpTo` (SP1/3A `rows.ts`), `defineConstraintErrors`, `defineErrorCodes`, `defineEvent`, `CoreErrors`, `TenancyErrors.ROLE_IN_USE` (3B), domain của Task 6, `tenancyCoreImports` (3A test support), `seedInvitation`, `seedInviteLink`, `seedTransfer`, `hashToken` (Task 4).
- Produces:
  - `TenancyErrors` thêm (mã = khoá chữ thường): `INVITATION_EMAIL_MISMATCH` (403), `INVITATION_NOT_FOUND` (404), `INVITE_LINK_NOT_FOUND` (404), `INVITATION_PENDING_EXISTS` (409), `INVITATION_NOT_PENDING` (409), `INVITATION_INVALIDATED` (409), `INVITE_LINK_INVALIDATED` (409), `OWNERSHIP_TRANSFER_PENDING` (409), `OWNERSHIP_TRANSFER_NOT_PENDING` (409), `OWNERSHIP_TRANSFER_INVALIDATED` (409), `OWNER_NOT_INVITABLE` (422), `PENDING_INVITATIONS_LIMIT` (422), `INVITE_LINKS_LIMIT` (422), `TTL_OUT_OF_RANGE` (422). Map constraint: `org_invitations_pending_email_uq` → `invitation_pending_exists`, `org_invitations_role_not_owner` / `org_invite_links_role_not_owner` → `owner_not_invitable`, `org_invitations_pending_role_ck` / `org_invite_links_active_role_ck` → `role_in_use`, `org_ownership_transfers_pending_uq` → `ownership_transfer_pending`, `org_invitations_email_ck` → `validation_failed`.
  - Event (`audit: true, webhook: false`, R-X3): `InvitationCreatedEvent`, `InvitationRevokedEvent` (`{ invitationId, roleId }`), `InvitationAcceptedEvent` (`+ memberId`), `InvitationInvalidatedEvent` (`+ reason`), `InviteLinkCreatedEvent` (`{ inviteLinkId, roleId, maxUses, expiresAt }`), `InviteLinkRevokedEvent` (`{ inviteLinkId, reason }`), `OwnershipTransferRequestedEvent`, `OwnershipTransferAcceptedEvent`, `OwnershipTransferDeclinedEvent` (`{ transferId, fromMemberId, toMemberId, stepDownTo }`), `OwnershipTransferCancelledEvent` (`+ reason`). Aggregate `invitation` / `invite_link` / `ownership_transfer`, id = `public_id`, version = cột `version` sau thay đổi. Export ở `index.ts`.
  - `TenancyMetrics` thêm `invitations` (`tenancy_invitations_total{result}`), `inviteLinkJoins` (`tenancy_invite_link_joins_total{result}`); `type AcquisitionResult = 'accepted' | 'not_found' | 'invalidated' | 'email_mismatch' | 'already_member'`; `LastOwnerPath` thêm `'transfer'`.
  - Port + SQL (provider của `TenancyCoreModule`, export):
    - `InvitationRepository` với `type InvitationRow`, `type TokenMatch = { orgId: string; id: string }`: `findByTokenHash(hashHex)`, `insert({ email, roleId, inviterMemberId, tokenHashHex, ttlSec })`, `findByPublicId`, `findById`, `lockById`, `lockByPublicId`, `countOpen()`, `expireLapsedForEmail(email)`, `resolve(id, to: 'REVOKED' | 'EXPIRED' | 'INVALIDATED')`, `accept(id, acceptedMemberId)`, `list({ limit, offset })`, `countUpTo(cap)`, `expireLapsedForRole(roleId)`, `revokeAllPending()`.
    - `InviteLinkRepository` với `type InviteLinkRow`: `findByTokenHash`, `insert({ roleId, createdByMemberId, tokenHashHex, maxUses, expiresAt })`, `findByPublicId`, `findById` (preview: đọc không khoá), `lockById`, `lockByPublicId`, `countOpen()`, `consumeUse(id)`, `revoke(id)`, `revokeClosedForRole(roleId): Promise<{ publicId: string; version: number }[]>`, `revokeAll()`, `list`, `countUpTo`.
    - `OwnershipTransferRepository` với `type TransferRow`: `insert({ fromMemberId, toMemberId, stepDownTo, ttlSec })`, `findByPublicId`, `lockByPublicId`, `expireLapsed()`, `resolve(id, to: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED')`, `lockPendingForMember(memberId)`, `cancelAllPending()`, `list({ participantMemberId?, status?, limit, offset })`, `countUpTo(q, cap)`.
    - `OrgRepository.countMembershipsForUser(userId): Promise<number>` (hàm definer `tenancy_count_user_memberships`).

- [ ] **Step 1: Lỗi và map constraint (unit fail → pass)**

`test/unit/modules/tenancy/errors.spec.ts` — thêm vào bảng `it.each` của ca map constraint:
```ts
    ['23505', 'org_invitations_pending_email_uq', TenancyErrors.INVITATION_PENDING_EXISTS],
    ['23514', 'org_invitations_role_not_owner', TenancyErrors.OWNER_NOT_INVITABLE],
    ['23514', 'org_invite_links_role_not_owner', TenancyErrors.OWNER_NOT_INVITABLE],
    ['23514', 'org_invitations_pending_role_ck', TenancyErrors.ROLE_IN_USE],
    ['23514', 'org_invite_links_active_role_ck', TenancyErrors.ROLE_IN_USE],
    ['23505', 'org_ownership_transfers_pending_uq', TenancyErrors.OWNERSHIP_TRANSFER_PENDING],
    ['23514', 'org_invitations_email_ck', CoreErrors.VALIDATION_FAILED],
```
(thêm import `CoreErrors` từ `../../../../src/core/errors/index.js`) và ca:
```ts
  it('3C codes carry the statuses of spec §15', () => {
    expect(
      [
        TenancyErrors.FEATURE_DISABLED,
        TenancyErrors.INVITATION_EMAIL_MISMATCH,
        TenancyErrors.INVITATION_NOT_FOUND,
        TenancyErrors.INVITE_LINK_NOT_FOUND,
        TenancyErrors.INVITATION_PENDING_EXISTS,
        TenancyErrors.INVITATION_NOT_PENDING,
        TenancyErrors.INVITATION_INVALIDATED,
        TenancyErrors.INVITE_LINK_INVALIDATED,
        TenancyErrors.OWNERSHIP_TRANSFER_PENDING,
        TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING,
        TenancyErrors.OWNERSHIP_TRANSFER_INVALIDATED,
        TenancyErrors.OWNER_NOT_INVITABLE,
        TenancyErrors.PENDING_INVITATIONS_LIMIT,
        TenancyErrors.INVITE_LINKS_LIMIT,
        TenancyErrors.TTL_OUT_OF_RANGE,
      ].map((e) => [e.code, e.status]),
    ).toEqual([
      ['feature_disabled', 403],
      ['invitation_email_mismatch', 403],
      ['invitation_not_found', 404],
      ['invite_link_not_found', 404],
      ['invitation_pending_exists', 409],
      ['invitation_not_pending', 409],
      ['invitation_invalidated', 409],
      ['invite_link_invalidated', 409],
      ['ownership_transfer_pending', 409],
      ['ownership_transfer_not_pending', 409],
      ['ownership_transfer_invalidated', 409],
      ['owner_not_invitable', 422],
      ['pending_invitations_limit', 422],
      ['invite_links_limit', 422],
      ['ttl_out_of_range', 422],
    ]);
  });
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/errors.spec.ts` → FAIL.

`src/modules/tenancy/errors.ts` — thêm vào `TenancyErrors` (sau `FEATURE_DISABLED` của Task 5):
```ts
  INVITATION_EMAIL_MISMATCH: {
    status: HttpStatus.FORBIDDEN,
    title: 'This invitation was sent to another email address',
  },
  INVITATION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    title: 'Invitation not found',
  },
  INVITE_LINK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    title: 'Invite link not found',
  },
  INVITATION_PENDING_EXISTS: {
    status: HttpStatus.CONFLICT,
    title: 'A pending invitation already exists for this email',
  },
  INVITATION_NOT_PENDING: {
    status: HttpStatus.CONFLICT,
    title: 'Invitation is not pending',
  },
  INVITATION_INVALIDATED: {
    status: HttpStatus.CONFLICT,
    title: 'This invitation is no longer valid; ask for a new one',
  },
  INVITE_LINK_INVALIDATED: {
    status: HttpStatus.CONFLICT,
    title: 'This invite link is no longer valid; ask for a new one',
  },
  OWNERSHIP_TRANSFER_PENDING: {
    status: HttpStatus.CONFLICT,
    title: 'An ownership transfer is already pending',
  },
  OWNERSHIP_TRANSFER_NOT_PENDING: {
    status: HttpStatus.CONFLICT,
    title: 'Ownership transfer is not pending',
  },
  OWNERSHIP_TRANSFER_INVALIDATED: {
    status: HttpStatus.CONFLICT,
    title: 'The initiator is no longer an owner; the transfer was cancelled',
  },
  OWNER_NOT_INVITABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'The owner role cannot be granted by an invitation or an invite link',
  },
  PENDING_INVITATIONS_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Pending invitation limit reached',
  },
  INVITE_LINKS_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Open invite link limit reached',
  },
  TTL_OUT_OF_RANGE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Expiry is out of the allowed range',
  },
```
(Nếu 3D đã merge trước và định nghĩa `TTL_OUT_OF_RANGE`, không thêm lần hai.) Thêm cuối file (import `CoreErrors` từ `../../core/errors/index.js`):
```ts
/** Constraint/trigger của migration `acquisition` (3C) → mã; tên không bao giờ ra client. */
defineConstraintErrors({
  org_invitations_pending_email_uq: TenancyErrors.INVITATION_PENDING_EXISTS,
  org_invitations_role_not_owner: TenancyErrors.OWNER_NOT_INVITABLE,
  org_invite_links_role_not_owner: TenancyErrors.OWNER_NOT_INVITABLE,
  // Xoá role còn lời mời PENDING/link chưa thu hồi: hành động FK `SET NULL (role_id)` vi phạm CHECK gắn trạng thái (DB-I2).
  org_invitations_pending_role_ck: TenancyErrors.ROLE_IN_USE,
  org_invite_links_active_role_ck: TenancyErrors.ROLE_IN_USE,
  org_ownership_transfers_pending_uq: TenancyErrors.OWNERSHIP_TRANSFER_PENDING,
  // Lớp chặn cuối nếu zod và `lower()` của Postgres lệch nhau trên một ký tự: 422, không 500.
  org_invitations_email_ck: CoreErrors.VALIDATION_FAILED,
});
```
Run lại → PASS.

- [ ] **Step 2: Event và metric**

`src/modules/tenancy/events.ts` — thêm (dùng `id = z.uuid()` đã có; import `STEP_DOWN_ROLES` từ `./constants.js`, `INVALIDATION_REASONS` từ `./domain/invitation.js`, `INVITE_LINK_REVOKE_REASONS` từ `./domain/invite-link.js`, `TRANSFER_CANCEL_REASONS` từ `./domain/ownership-transfer.js`):
```ts
/**
 * Event của 3C (spec SP3 §14): chỉ id công khai, không email, token, tên người. Cờ R-X3: vào audit, không phải hợp đồng
 * webhook công khai (sáu event webhook đều là của 3A, spec SP6 §8.3).
 */
const invitation = z.object({ invitationId: id, roleId: id });
const transfer = z.object({ transferId: id, fromMemberId: id, toMemberId: id, stepDownTo: z.enum(STEP_DOWN_ROLES).nullable() });
export const InvitationCreatedEvent = defineEvent({ type: 'tenancy.invitation.created', version: 1, schema: invitation, audit: true, webhook: false });
export const InvitationRevokedEvent = defineEvent({ type: 'tenancy.invitation.revoked', version: 1, schema: invitation, audit: true, webhook: false });
export const InvitationAcceptedEvent = defineEvent({
  type: 'tenancy.invitation.accepted',
  version: 1,
  schema: invitation.extend({ memberId: id }),
  audit: true,
  webhook: false,
});
export const InvitationInvalidatedEvent = defineEvent({
  type: 'tenancy.invitation.invalidated',
  version: 1,
  schema: invitation.extend({ reason: z.enum(INVALIDATION_REASONS) }),
  audit: true,
  webhook: false,
});
export const InviteLinkCreatedEvent = defineEvent({
  type: 'tenancy.invite_link.created',
  version: 1,
  schema: z.object({ inviteLinkId: id, roleId: id, maxUses: z.number().int().positive(), expiresAt: z.iso.datetime() }),
  audit: true,
  webhook: false,
});
export const InviteLinkRevokedEvent = defineEvent({
  type: 'tenancy.invite_link.revoked',
  version: 1,
  schema: z.object({ inviteLinkId: id, reason: z.enum(INVITE_LINK_REVOKE_REASONS) }),
  audit: true,
  webhook: false,
});
export const OwnershipTransferRequestedEvent = defineEvent({ type: 'tenancy.ownership_transfer.requested', version: 1, schema: transfer, audit: true, webhook: false });
export const OwnershipTransferAcceptedEvent = defineEvent({ type: 'tenancy.ownership_transfer.accepted', version: 1, schema: transfer, audit: true, webhook: false });
export const OwnershipTransferDeclinedEvent = defineEvent({ type: 'tenancy.ownership_transfer.declined', version: 1, schema: transfer, audit: true, webhook: false });
export const OwnershipTransferCancelledEvent = defineEvent({
  type: 'tenancy.ownership_transfer.cancelled',
  version: 1,
  schema: transfer.extend({ reason: z.enum(TRANSFER_CANCEL_REASONS) }),
  audit: true,
  webhook: false,
});
```
(6.0 đã merge: `defineEvent` đòi hai cờ; thiếu một cờ là lỗi typecheck.) `src/modules/tenancy/index.ts` — thêm mười tên vào khối `export { … } from './events.js';`.

`src/modules/tenancy/application/tenancy-metrics.ts` — thêm:
```ts
export type AcquisitionResult = 'accepted' | 'not_found' | 'invalidated' | 'email_mismatch' | 'already_member';
```
đổi `LastOwnerPath` thành `'demote' | 'remove' | 'leave' | 'account_delete' | 'restore' | 'transfer'`, và thêm trong lớp:
```ts
  readonly invitations = this.meter.createCounter('tenancy_invitations_total', {
    description: 'Invitation accept attempts by result',
  });
  readonly inviteLinkJoins = this.meter.createCounter('tenancy_invite_link_joins_total', {
    description: 'Invite link join attempts by result',
  });
```

- [ ] **Step 3: Port**

`src/modules/tenancy/ports/invitation-repository.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';
import type { InvitationStatus } from '../domain/invitation.js';

export type InvitationRow = {
  id: string;
  publicId: string;
  email: string;
  roleId: string | null;
  rolePublicId: string | null;
  roleSystemKey: SystemRoleKey | null;
  roleName: string | null;
  inviterMemberId: string | null;
  status: InvitationStatus;
  expiresAt: Date;
  resolvedAt: Date | null;
  acceptedMemberId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/** Kết quả hàm definer tra token (không cần OrgScope; spec §6.14). */
export type TokenMatch = { orgId: string; id: string };

/** Mọi phương thức trừ `findByTokenHash` chạy trong OrgScope của org (RLS); `lock*` chỉ dưới khoá org (spec §8.6). */
export abstract class InvitationRepository {
  abstract findByTokenHash(hashHex: string): Promise<TokenMatch | undefined>;
  abstract insert(i: { email: string; roleId: string; inviterMemberId: string; tokenHashHex: string; ttlSec: number }): Promise<InvitationRow>;
  abstract findByPublicId(publicId: string): Promise<InvitationRow | undefined>;
  abstract findById(id: string): Promise<InvitationRow | undefined>;
  abstract lockById(id: string): Promise<InvitationRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<InvitationRow | undefined>;
  /** PENDING chưa hết hạn theo `clock_timestamp()` (trần mỗi org, T-11). */
  abstract countOpen(): Promise<number>;
  /** PENDING đã hết hạn của cùng email → EXPIRED (không event, §14.1): giải phóng `pending_email_uq`. */
  abstract expireLapsedForEmail(email: string): Promise<void>;
  /** CAS PENDING → `to` (T-21); `undefined` khi dòng không còn PENDING. Xoá token, đặt `resolved_at`. */
  abstract resolve(id: string, to: 'REVOKED' | 'EXPIRED' | 'INVALIDATED'): Promise<InvitationRow | undefined>;
  /** CAS PENDING và còn hạn theo `clock_timestamp()` → ACCEPTED (T-2, T-29). */
  abstract accept(id: string, acceptedMemberId: string): Promise<InvitationRow | undefined>;
  abstract list(q: { limit: number; offset: number }): Promise<InvitationRow[]>;
  abstract countUpTo(cap: number): Promise<number>;
  /** Xoá role (Bảng 5): PENDING đã hết hạn của role → EXPIRED, để `SET NULL (role_id)` không chạm PENDING còn sống. */
  abstract expireLapsedForRole(roleId: string): Promise<void>;
  /** Xoá mềm org (Bảng 5): mọi PENDING → REVOKED, không event riêng (§14.1). */
  abstract revokeAllPending(): Promise<void>;
}
```
`src/modules/tenancy/ports/invite-link-repository.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';
import type { TokenMatch } from './invitation-repository.js';

export type InviteLinkRow = {
  id: string;
  publicId: string;
  roleId: string | null;
  rolePublicId: string | null;
  roleSystemKey: SystemRoleKey | null;
  roleName: string | null;
  createdByMemberId: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export abstract class InviteLinkRepository {
  abstract findByTokenHash(hashHex: string): Promise<TokenMatch | undefined>;
  abstract insert(l: { roleId: string; createdByMemberId: string; tokenHashHex: string; maxUses: number; expiresAt: Date }): Promise<InviteLinkRow>;
  abstract findByPublicId(publicId: string): Promise<InviteLinkRow | undefined>;
  abstract findById(id: string): Promise<InviteLinkRow | undefined>;
  abstract lockById(id: string): Promise<InviteLinkRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<InviteLinkRow | undefined>;
  /** Link "đang mở" (§6.8 DB-M2) theo `clock_timestamp()`: chưa thu hồi, chưa hết hạn, chưa hết lượt. */
  abstract countOpen(): Promise<number>;
  /** Câu điều kiện atomic (T-5, T-29): tăng `use_count` khi còn mở; `undefined` khi không. */
  abstract consumeUse(id: string): Promise<InviteLinkRow | undefined>;
  /** `revoked_at = now()` khi còn NULL; `undefined` khi đã thu hồi. */
  abstract revoke(id: string): Promise<InviteLinkRow | undefined>;
  /** Xoá role (Bảng 5): thu hồi link chưa thu hồi mà KHÔNG còn mở của role; trả dòng đã thu hồi để phát event. */
  abstract revokeClosedForRole(roleId: string): Promise<{ publicId: string; version: number }[]>;
  /** Xoá mềm org: thu hồi mọi link chưa thu hồi (không event riêng, §14.1). */
  abstract revokeAll(): Promise<void>;
  abstract list(q: { limit: number; offset: number }): Promise<InviteLinkRow[]>;
  abstract countUpTo(cap: number): Promise<number>;
}
```
`src/modules/tenancy/ports/ownership-transfer-repository.ts`:
```ts
import type { StepDownRole } from '../constants.js';
import type { TransferStatus } from '../domain/ownership-transfer.js';

export type TransferRow = {
  id: string;
  publicId: string;
  fromMemberId: string | null;
  fromMemberPublicId: string | null;
  toMemberId: string | null;
  toMemberPublicId: string | null;
  stepDownTo: StepDownRole | null;
  status: TransferStatus;
  expiresAt: Date;
  resolvedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export type TransferQuery = { participantMemberId?: string; status?: TransferStatus };

export abstract class OwnershipTransferRepository {
  abstract insert(t: { fromMemberId: string; toMemberId: string; stepDownTo: StepDownRole | null; ttlSec: number }): Promise<TransferRow>;
  abstract findByPublicId(publicId: string): Promise<TransferRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<TransferRow | undefined>;
  /** PENDING đã hết hạn của org → EXPIRED (chạm sau hạn, §9.3): giải phóng `pending_uq` trước khi tạo yêu cầu mới. */
  abstract expireLapsed(): Promise<void>;
  /** CAS PENDING → `to` (T-16); `undefined` khi không còn PENDING. */
  abstract resolve(id: string, to: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED'): Promise<TransferRow | undefined>;
  /** Yêu cầu PENDING mà member là bên gửi hoặc nhận, khoá `FOR NO KEY UPDATE` (gỡ member, §9.3). */
  abstract lockPendingForMember(memberId: string): Promise<TransferRow[]>;
  /** Xoá mềm org: mọi PENDING → CANCELLED (không event riêng, §14.1). */
  abstract cancelAllPending(): Promise<void>;
  /** `status` là trạng thái HIỆU LỰC (PENDING quá hạn tính là EXPIRED, theo `now()` của transaction đọc). */
  abstract list(q: TransferQuery & { limit: number; offset: number }): Promise<TransferRow[]>;
  abstract countUpTo(q: TransferQuery, cap: number): Promise<number>;
}
```
`src/modules/tenancy/ports/org-repository.ts` — thêm vào lớp:
```ts
  /** M7: mọi membership của user, kể cả ở org xoá mềm (hàm definer `tenancy_count_user_memberships`). */
  abstract countMembershipsForUser(userId: string): Promise<number>;
```

- [ ] **Step 4: Test repository (fail)**

`test/integration/tenancy/acquisition-repositories.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { InvitationRepository } from '../../../src/modules/tenancy/ports/invitation-repository.js';
import { InviteLinkRepository } from '../../../src/modules/tenancy/ports/invite-link-repository.js';
import { OrgRepository } from '../../../src/modules/tenancy/ports/org-repository.js';
import { OwnershipTransferRepository } from '../../../src/modules/tenancy/ports/ownership-transfer-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { ROLE_SET_C0, hashToken, seedCustomRole, seedInvitation, seedInviteLink, seedMember, seedOrg, seedTransfer, type SeededOrg } from '../../support/tenancy-seed.js';

const TOKEN_HEX = 'a1'.repeat(32);

describe('acquisition SQL repositories (spec SP3 §6.7–6.9, §9)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  const inOrg = <T>(fn: () => Promise<T>) => app.get(OrgScope).run(org.orgId, () => app.get(UnitOfWork).run(fn));
  const invitations = () => app.get(InvitationRepository);
  const links = () => app.get(InviteLinkRepository);
  const transfers = () => app.get(OwnershipTransferRepository);
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it('invitation: insert → token lookup without an org context → lock → CAS accept once (T-2)', async () => {
    const m = await seedMember(org, 'MEMBER');
    const inv = await inOrg(() =>
      invitations().insert({ email: 'repo@example.test', roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId, tokenHashHex: TOKEN_HEX, ttlSec: 3600 }),
    );
    expect(inv).toMatchObject({ email: 'repo@example.test', status: 'PENDING', rolePublicId: org.roles.MEMBER.publicId, roleSystemKey: 'MEMBER', version: 1 });
    expect(await invitations().findByTokenHash(TOKEN_HEX)).toEqual({ orgId: org.orgId, id: inv.id });
    const first = await inOrg(async () => {
      await invitations().lockById(inv.id);
      return invitations().accept(inv.id, m.memberId);
    });
    expect(first).toMatchObject({ status: 'ACCEPTED', acceptedMemberId: m.memberId, version: 2 });
    expect(await inOrg(() => invitations().accept(inv.id, m.memberId))).toBeUndefined();
    expect(await invitations().findByTokenHash(TOKEN_HEX)).toBeUndefined();
  });
  it('invitation: countOpen ignores lapsed and finished rows; expireLapsedForEmail frees the pending slot', async () => {
    const before = await inOrg(() => invitations().countOpen());
    await seedInvitation(org, { email: 'lapsed@example.test', roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId, expiresInSec: -60 });
    await seedInvitation(org, { email: 'done@example.test', roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId, status: 'REVOKED' });
    await seedInvitation(org, { email: 'open@example.test', roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    expect(await inOrg(() => invitations().countOpen())).toBe(before + 1);
    await inOrg(() => invitations().expireLapsedForEmail('lapsed@example.test'));
    const again = await inOrg(() =>
      invitations().insert({ email: 'lapsed@example.test', roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId, tokenHashHex: 'b2'.repeat(32), ttlSec: 3600 }),
    );
    expect(again.status).toBe('PENDING');
  });
  it('invitation: expireLapsedForRole touches only lapsed PENDING rows of that role; revokeAllPending revokes every PENDING row', async () => {
    const role = await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'Repo role' });
    const lapsed = await seedInvitation(org, { email: 'r1@example.test', roleId: role.id, inviterMemberId: org.owner.memberId, expiresInSec: -60 });
    const live = await seedInvitation(org, { email: 'r2@example.test', roleId: role.id, inviterMemberId: org.owner.memberId });
    await inOrg(() => invitations().expireLapsedForRole(role.id));
    expect((await inOrg(() => invitations().findById(lapsed.id)))?.status).toBe('EXPIRED');
    expect((await inOrg(() => invitations().findById(live.id)))?.status).toBe('PENDING');
    await inOrg(() => invitations().revokeAllPending());
    expect((await inOrg(() => invitations().findById(live.id)))?.status).toBe('REVOKED');
    expect(await invitations().findByTokenHash(hashToken(live.token))).toBeUndefined();
  });
  it('link: consumeUse stops at max_uses (T-5); revoke is once; revokeClosedForRole spares open links', async () => {
    const link = await inOrg(() =>
      links().insert({ roleId: org.roles.MEMBER.id, createdByMemberId: org.owner.memberId, tokenHashHex: 'c3'.repeat(32), maxUses: 2, expiresAt: new Date(Date.now() + 3_600_000) }),
    );
    expect(await links().findByTokenHash('c3'.repeat(32))).toEqual({ orgId: org.orgId, id: link.id });
    expect((await inOrg(() => links().consumeUse(link.id)))?.useCount).toBe(1);
    expect((await inOrg(() => links().consumeUse(link.id)))?.useCount).toBe(2);
    expect(await inOrg(() => links().consumeUse(link.id))).toBeUndefined();
    const role = await seedCustomRole(org, { permissions: ROLE_SET_C0, name: 'Link role' });
    const expired = await seedInviteLink(org, { roleId: role.id, createdByMemberId: org.owner.memberId, expiresInSec: -60 });
    const open = await seedInviteLink(org, { roleId: role.id, createdByMemberId: org.owner.memberId });
    expect(await inOrg(() => links().revokeClosedForRole(role.id))).toEqual([{ publicId: expired.publicId, version: 2 }]);
    expect((await inOrg(() => links().findByPublicId(open.publicId)))?.revokedAt).toBeNull();
    expect((await inOrg(() => links().revoke(open.id)))?.revokedAt).toBeInstanceOf(Date);
    expect(await inOrg(() => links().revoke(open.id))).toBeUndefined();
  });
  it('transfer: one PENDING per org; lockPendingForMember sees both sides; effective status filter treats lapsed PENDING as EXPIRED', async () => {
    const a = await seedMember(org, 'ADMIN');
    const t = await inOrg(() => transfers().insert({ fromMemberId: org.owner.memberId, toMemberId: a.memberId, stepDownTo: 'ADMIN', ttlSec: 3600 }));
    expect(t).toMatchObject({ status: 'PENDING', fromMemberPublicId: org.owner.memberPublicId, toMemberPublicId: a.memberPublicId, stepDownTo: 'ADMIN' });
    expect((await inOrg(() => transfers().lockPendingForMember(a.memberId))).map((x) => x.id)).toEqual([t.id]);
    expect((await inOrg(() => transfers().lockPendingForMember(org.owner.memberId))).map((x) => x.id)).toEqual([t.id]);
    expect((await inOrg(() => transfers().resolve(t.id, 'DECLINED')))?.status).toBe('DECLINED');
    expect(await inOrg(() => transfers().resolve(t.id, 'CANCELLED'))).toBeUndefined();
    const lapsed = await seedTransfer(org, { fromMemberId: org.owner.memberId, toMemberId: a.memberId, expiresInSec: -60 });
    const expiredList = await inOrg(() => transfers().list({ status: 'EXPIRED', limit: 50, offset: 0 }));
    expect(expiredList.map((x) => x.publicId)).toContain(lapsed.publicId);
    expect(await inOrg(() => transfers().countUpTo({ status: 'PENDING' }, 100))).toBe(0);
    await inOrg(() => transfers().expireLapsed());
    expect((await inOrg(() => transfers().findByPublicId(lapsed.publicId)))?.status).toBe('EXPIRED');
  });
  it('countMembershipsForUser counts memberships of soft-deleted orgs too (M7)', async () => {
    const other = await seedOrg();
    const u = await seedMember(other, 'MEMBER');
    expect(await app.get(OrgRepository).countMembershipsForUser(u.userId)).toBe(1);
    await app.get(OrgScope).run(other.orgId, () => app.get(UnitOfWork).run(() => app.get(OrgRepository).softDelete(86_400)));
    expect(await app.get(OrgRepository).countMembershipsForUser(u.userId)).toBe(1);
    await other.dispose();
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/acquisition-repositories.spec.ts` → FAIL (port chưa có provider).

- [ ] **Step 5: SQL repository**

`src/modules/tenancy/infra/sql/sql-invitation.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import { INVITATION_STATUSES } from '../../domain/invitation.js';
import { InvitationRepository, type InvitationRow, type TokenMatch } from '../../ports/invitation-repository.js';
import { single } from './rows.js';

const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    email: z.string(),
    role_id: z.string().nullable(),
    role_public_id: z.string().nullable(),
    role_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    role_name: z.string().nullable(),
    inviter_member_id: z.string().nullable(),
    status: z.enum(INVITATION_STATUSES),
    expires_at: z.coerce.date(),
    resolved_at: z.coerce.date().nullable(),
    accepted_member_id: z.string().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform(
    (r): InvitationRow => ({
      id: r.id,
      publicId: r.public_id,
      email: r.email,
      roleId: r.role_id,
      rolePublicId: r.role_public_id,
      roleSystemKey: r.role_system_key,
      roleName: r.role_name,
      inviterMemberId: r.inviter_member_id,
      status: r.status,
      expiresAt: r.expires_at,
      resolvedAt: r.resolved_at,
      acceptedMemberId: r.accepted_member_id,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
const Match = z.object({ org_id: z.string(), id: z.string() }).transform((r): TokenMatch => ({ orgId: r.org_id, id: r.id }));
const Count = z.object({ n: z.coerce.number().int() });
/** Lời mời + role (LEFT JOIN: role của lời mời đã kết thúc có thể đã bị xoá, `role_id` NULL, DB-I2). */
const SELECT = `SELECT i.id::text AS id, i.public_id::text AS public_id, i.email, i.role_id::text AS role_id,
    r.public_id::text AS role_public_id, r.system_key AS role_system_key, r.name AS role_name,
    i.inviter_member_id::text AS inviter_member_id, i.status, i.expires_at, i.resolved_at,
    i.accepted_member_id::text AS accepted_member_id, i.version, i.created_at, i.updated_at
  FROM org_invitations i LEFT JOIN org_roles r ON r.org_id = i.org_id AND r.id = i.role_id`;
const IN_ORG = 'i.org_id = app_current_org()';

@Injectable()
export class SqlInvitationRepository extends InvitationRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async byId(id: string, lock = false): Promise<InvitationRow | undefined> {
    const [row] = await this.db.execute(`${SELECT} WHERE ${IN_ORG} AND i.id = ?${lock ? ' FOR NO KEY UPDATE OF i' : ''}`, [id]);
    return row ? Row.parse(row) : undefined;
  }
  private async byPublicId(publicId: string, lock = false): Promise<InvitationRow | undefined> {
    const [row] = await this.db.execute(`${SELECT} WHERE ${IN_ORG} AND i.public_id = ?${lock ? ' FOR NO KEY UPDATE OF i' : ''}`, [publicId]);
    return row ? Row.parse(row) : undefined;
  }
  private async reread(rows: readonly { id: string }[], what: string): Promise<InvitationRow | undefined> {
    const [r] = rows;
    if (!r) return undefined;
    const row = await this.byId(r.id);
    if (!row) throw new Error(`${what}: updated invitation vanished`);
    return row;
  }

  async findByTokenHash(hashHex: string): Promise<TokenMatch | undefined> {
    const [row] = await this.db.execute(`SELECT org_id::text AS org_id, invitation_id::text AS id FROM tenancy_find_invitation(decode(?, 'hex'))`, [hashHex]);
    return row ? Match.parse(row) : undefined;
  }
  async insert(i: { email: string; roleId: string; inviterMemberId: string; tokenHashHex: string; ttlSec: number }): Promise<InvitationRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at)
         VALUES (app_current_org(), ?, ?, ?, 'PENDING', decode(?, 'hex'), now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [i.email, i.roleId, i.inviterMemberId, i.tokenHashHex, i.ttlSec],
      ),
      'insert invitation',
    );
    const row = await this.byId(created.id);
    if (!row) throw new Error('insert invitation: row vanished');
    return row;
  }
  findByPublicId(publicId: string): Promise<InvitationRow | undefined> {
    return this.byPublicId(publicId);
  }
  findById(id: string): Promise<InvitationRow | undefined> {
    return this.byId(id);
  }
  lockById(id: string): Promise<InvitationRow | undefined> {
    return this.byId(id, true);
  }
  lockByPublicId(publicId: string): Promise<InvitationRow | undefined> {
    return this.byPublicId(publicId, true);
  }
  async countOpen(): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute(
          `SELECT count(*)::int AS n FROM org_invitations WHERE org_id = app_current_org() AND status = 'PENDING' AND expires_at > clock_timestamp()`,
        ),
        'count open invitations',
      ),
    ).n;
  }
  async expireLapsedForEmail(email: string): Promise<void> {
    await this.db.execute(
      `UPDATE org_invitations SET status = 'EXPIRED', token_hash = NULL, resolved_at = now(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND email = ? AND status = 'PENDING' AND expires_at <= clock_timestamp()`,
      [email],
    );
  }
  async resolve(id: string, to: 'REVOKED' | 'EXPIRED' | 'INVALIDATED'): Promise<InvitationRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invitations SET status = ?, token_hash = NULL, resolved_at = now(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND status = 'PENDING' RETURNING id::text AS id`,
        [to, id],
      ),
      'resolve invitation',
    );
  }
  async accept(id: string, acceptedMemberId: string): Promise<InvitationRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invitations SET status = 'ACCEPTED', token_hash = NULL, resolved_at = now(), accepted_member_id = ?,
           version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND status = 'PENDING' AND expires_at > clock_timestamp() RETURNING id::text AS id`,
        [acceptedMemberId, id],
      ),
      'accept invitation',
    );
  }
  async list(q: { limit: number; offset: number }): Promise<InvitationRow[]> {
    const rows = await this.db.execute(`${SELECT} WHERE ${IN_ORG} ORDER BY i.created_at, i.id LIMIT ? OFFSET ?`, [q.limit, q.offset]);
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(cap: number): Promise<number> {
    return countUpTo(this.db, 'SELECT 1 FROM org_invitations WHERE org_id = app_current_org()', [], cap);
  }
  async expireLapsedForRole(roleId: string): Promise<void> {
    await this.db.execute(
      `UPDATE org_invitations SET status = 'EXPIRED', token_hash = NULL, resolved_at = now(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND role_id = ? AND status = 'PENDING' AND expires_at <= clock_timestamp()`,
      [roleId],
    );
  }
  async revokeAllPending(): Promise<void> {
    await this.db.execute(
      `UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = now(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND status = 'PENDING'`,
    );
  }
}
```
`src/modules/tenancy/infra/sql/sql-invite-link.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import type { TokenMatch } from '../../ports/invitation-repository.js';
import { InviteLinkRepository, type InviteLinkRow } from '../../ports/invite-link-repository.js';
import { single } from './rows.js';

const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    role_id: z.string().nullable(),
    role_public_id: z.string().nullable(),
    role_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    role_name: z.string().nullable(),
    created_by_member_id: z.string().nullable(),
    max_uses: z.coerce.number().int(),
    use_count: z.coerce.number().int(),
    expires_at: z.coerce.date(),
    revoked_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform(
    (r): InviteLinkRow => ({
      id: r.id,
      publicId: r.public_id,
      roleId: r.role_id,
      rolePublicId: r.role_public_id,
      roleSystemKey: r.role_system_key,
      roleName: r.role_name,
      createdByMemberId: r.created_by_member_id,
      maxUses: r.max_uses,
      useCount: r.use_count,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
const Match = z.object({ org_id: z.string(), id: z.string() }).transform((r): TokenMatch => ({ orgId: r.org_id, id: r.id }));
const Count = z.object({ n: z.coerce.number().int() });
const Revoked = z.object({ public_id: z.string(), version: z.coerce.number().int() }).transform((r) => ({ publicId: r.public_id, version: r.version }));
const SELECT = `SELECT l.id::text AS id, l.public_id::text AS public_id, l.role_id::text AS role_id,
    r.public_id::text AS role_public_id, r.system_key AS role_system_key, r.name AS role_name,
    l.created_by_member_id::text AS created_by_member_id, l.max_uses, l.use_count, l.expires_at, l.revoked_at,
    l.version, l.created_at, l.updated_at
  FROM org_invite_links l LEFT JOIN org_roles r ON r.org_id = l.org_id AND r.id = l.role_id`;
const IN_ORG = 'l.org_id = app_current_org()';
/** "Đang mở" (spec §6.8 DB-M2), đo SAU khoá org nên dùng `clock_timestamp()` (§3.15). */
const OPEN = 'revoked_at IS NULL AND expires_at > clock_timestamp() AND use_count < max_uses';

@Injectable()
export class SqlInviteLinkRepository extends InviteLinkRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(where: string, params: unknown[], lock: boolean): Promise<InviteLinkRow | undefined> {
    const [row] = await this.db.execute(`${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF l' : ''}`, params);
    return row ? Row.parse(row) : undefined;
  }
  private async reread(rows: readonly { id: string }[]): Promise<InviteLinkRow | undefined> {
    const [r] = rows;
    if (!r) return undefined;
    const row = await this.one('l.id = ?', [r.id], false);
    if (!row) throw new Error('updated invite link vanished');
    return row;
  }

  async findByTokenHash(hashHex: string): Promise<TokenMatch | undefined> {
    const [row] = await this.db.execute(`SELECT org_id::text AS org_id, invite_link_id::text AS id FROM tenancy_find_invite_link(decode(?, 'hex'))`, [hashHex]);
    return row ? Match.parse(row) : undefined;
  }
  async insert(l: { roleId: string; createdByMemberId: string; tokenHashHex: string; maxUses: number; expiresAt: Date }): Promise<InviteLinkRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, expires_at)
         VALUES (app_current_org(), ?, ?, decode(?, 'hex'), ?, ?::timestamptz) RETURNING id::text AS id`,
        [l.roleId, l.createdByMemberId, l.tokenHashHex, l.maxUses, l.expiresAt.toISOString()],
      ),
      'insert invite link',
    );
    const row = await this.one('l.id = ?', [created.id], false);
    if (!row) throw new Error('insert invite link: row vanished');
    return row;
  }
  findByPublicId(publicId: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.public_id = ?', [publicId], false);
  }
  findById(id: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.id = ?', [id], false);
  }
  lockById(id: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.id = ?', [id], true);
  }
  lockByPublicId(publicId: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.public_id = ?', [publicId], true);
  }
  async countOpen(): Promise<number> {
    return Count.parse(single(await this.db.execute(`SELECT count(*)::int AS n FROM org_invite_links WHERE org_id = app_current_org() AND ${OPEN}`), 'count open links')).n;
  }
  async consumeUse(id: string): Promise<InviteLinkRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invite_links SET use_count = use_count + 1, version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND ${OPEN} RETURNING id::text AS id`,
        [id],
      ),
    );
  }
  async revoke(id: string): Promise<InviteLinkRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invite_links SET revoked_at = now(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
        [id],
      ),
    );
  }
  async revokeClosedForRole(roleId: string): Promise<{ publicId: string; version: number }[]> {
    const rows = await this.db.execute(
      `UPDATE org_invite_links SET revoked_at = now(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND role_id = ? AND revoked_at IS NULL
         AND (expires_at <= clock_timestamp() OR use_count >= max_uses)
       RETURNING public_id::text AS public_id, version`,
      [roleId],
    );
    return rows.map((r) => Revoked.parse(r));
  }
  async revokeAll(): Promise<void> {
    await this.db.execute(`UPDATE org_invite_links SET revoked_at = now(), version = version + 1, updated_at = now() WHERE org_id = app_current_org() AND revoked_at IS NULL`);
  }
  async list(q: { limit: number; offset: number }): Promise<InviteLinkRow[]> {
    const rows = await this.db.execute(`${SELECT} WHERE ${IN_ORG} ORDER BY l.created_at, l.id LIMIT ? OFFSET ?`, [q.limit, q.offset]);
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(cap: number): Promise<number> {
    return countUpTo(this.db, 'SELECT 1 FROM org_invite_links WHERE org_id = app_current_org()', [], cap);
  }
}
```
`src/modules/tenancy/infra/sql/sql-ownership-transfer.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { STEP_DOWN_ROLES } from '../../constants.js';
import { TRANSFER_STATUSES } from '../../domain/ownership-transfer.js';
import { OwnershipTransferRepository, type TransferQuery, type TransferRow } from '../../ports/ownership-transfer-repository.js';
import { single } from './rows.js';

const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    from_member_id: z.string().nullable(),
    from_member_public_id: z.string().nullable(),
    to_member_id: z.string().nullable(),
    to_member_public_id: z.string().nullable(),
    step_down_to: z.enum(STEP_DOWN_ROLES).nullable(),
    status: z.enum(TRANSFER_STATUSES),
    expires_at: z.coerce.date(),
    resolved_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform(
    (r): TransferRow => ({
      id: r.id,
      publicId: r.public_id,
      fromMemberId: r.from_member_id,
      fromMemberPublicId: r.from_member_public_id,
      toMemberId: r.to_member_id,
      toMemberPublicId: r.to_member_public_id,
      stepDownTo: r.step_down_to,
      status: r.status,
      expiresAt: r.expires_at,
      resolvedAt: r.resolved_at,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
const SELECT = `SELECT t.id::text AS id, t.public_id::text AS public_id,
    t.from_member_id::text AS from_member_id, f.public_id::text AS from_member_public_id,
    t.to_member_id::text AS to_member_id, o.public_id::text AS to_member_public_id,
    t.step_down_to, t.status, t.expires_at, t.resolved_at, t.version, t.created_at, t.updated_at
  FROM org_ownership_transfers t
  LEFT JOIN org_members f ON f.org_id = t.org_id AND f.id = t.from_member_id
  LEFT JOIN org_members o ON o.org_id = t.org_id AND o.id = t.to_member_id`;
const IN_ORG = 't.org_id = app_current_org()';
const RESOLVE = `UPDATE org_ownership_transfers SET status = ?, resolved_at = now(), version = version + 1, updated_at = now()
  WHERE org_id = app_current_org() AND id = ? AND status = 'PENDING' RETURNING id::text AS id`;

/** Bộ lọc theo trạng thái HIỆU LỰC (spec §9.3: PENDING quá hạn là EXPIRED với người đọc) và theo bên tham gia. */
function filterOf(q: TransferQuery): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (q.participantMemberId !== undefined) {
    parts.push('(t.from_member_id = ? OR t.to_member_id = ?)');
    params.push(q.participantMemberId, q.participantMemberId);
  }
  switch (q.status) {
    case undefined:
      break;
    case 'PENDING':
      parts.push(`t.status = 'PENDING' AND t.expires_at > now()`);
      break;
    case 'EXPIRED':
      parts.push(`(t.status = 'EXPIRED' OR (t.status = 'PENDING' AND t.expires_at <= now()))`);
      break;
    case 'ACCEPTED':
    case 'DECLINED':
    case 'CANCELLED':
      parts.push('t.status = ?');
      params.push(q.status);
      break;
    default: {
      const unknown: never = q.status;
      throw new Error(`unknown transfer status filter ${String(unknown)}`);
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

@Injectable()
export class SqlOwnershipTransferRepository extends OwnershipTransferRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(where: string, params: unknown[], lock: boolean): Promise<TransferRow | undefined> {
    const [row] = await this.db.execute(`${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF t' : ''}`, params);
    return row ? Row.parse(row) : undefined;
  }

  async insert(t: { fromMemberId: string; toMemberId: string; stepDownTo: 'ADMIN' | 'MEMBER' | null; ttlSec: number }): Promise<TransferRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, step_down_to, status, expires_at)
         VALUES (app_current_org(), ?, ?, ?, 'PENDING', now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [t.fromMemberId, t.toMemberId, t.stepDownTo, t.ttlSec],
      ),
      'insert ownership transfer',
    );
    const row = await this.one('t.id = ?', [created.id], false);
    if (!row) throw new Error('insert ownership transfer: row vanished');
    return row;
  }
  findByPublicId(publicId: string): Promise<TransferRow | undefined> {
    return this.one('t.public_id = ?', [publicId], false);
  }
  lockByPublicId(publicId: string): Promise<TransferRow | undefined> {
    return this.one('t.public_id = ?', [publicId], true);
  }
  async expireLapsed(): Promise<void> {
    await this.db.execute(
      `UPDATE org_ownership_transfers SET status = 'EXPIRED', resolved_at = now(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND status = 'PENDING' AND expires_at <= clock_timestamp()`,
    );
  }
  async resolve(id: string, to: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED'): Promise<TransferRow | undefined> {
    const [r] = await this.db.execute<{ id: string }>(RESOLVE, [to, id]);
    if (!r) return undefined;
    const row = await this.one('t.id = ?', [r.id], false);
    if (!row) throw new Error('resolve ownership transfer: row vanished');
    return row;
  }
  async lockPendingForMember(memberId: string): Promise<TransferRow[]> {
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND t.status = 'PENDING' AND (t.from_member_id = ? OR t.to_member_id = ?) ORDER BY t.id FOR NO KEY UPDATE OF t`,
      [memberId, memberId],
    );
    return rows.map((r) => Row.parse(r));
  }
  async cancelAllPending(): Promise<void> {
    await this.db.execute(
      `UPDATE org_ownership_transfers SET status = 'CANCELLED', resolved_at = now(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND status = 'PENDING'`,
    );
  }
  async list(q: TransferQuery & { limit: number; offset: number }): Promise<TransferRow[]> {
    const f = filterOf(q);
    const rows = await this.db.execute(`${SELECT} WHERE ${IN_ORG}${f.sql} ORDER BY t.created_at, t.id LIMIT ? OFFSET ?`, [...f.params, q.limit, q.offset]);
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(q: TransferQuery, cap: number): Promise<number> {
    const f = filterOf(q);
    return countUpTo(this.db, `SELECT 1 FROM org_ownership_transfers t WHERE ${IN_ORG}${f.sql}`, f.params, cap);
  }
}
```
`src/modules/tenancy/infra/sql/sql-org.repository.ts` — thêm method (dùng `Count` đã có trong file):
```ts
  async countMembershipsForUser(userId: string): Promise<number> {
    return Count.parse(
      single(await this.db.execute('SELECT tenancy_count_user_memberships(?)::int AS n', [userId]), 'tenancy_count_user_memberships'),
    ).n;
  }
```
`src/modules/tenancy/tenancy.module.ts` — trong `TenancyCoreModule.providers` thêm:
```ts
    SqlInvitationRepository,
    { provide: InvitationRepository, useExisting: SqlInvitationRepository },
    SqlInviteLinkRepository,
    { provide: InviteLinkRepository, useExisting: SqlInviteLinkRepository },
    SqlOwnershipTransferRepository,
    { provide: OwnershipTransferRepository, useExisting: SqlOwnershipTransferRepository },
```
và thêm `InvitationRepository`, `InviteLinkRepository`, `OwnershipTransferRepository` vào `exports` (import tương ứng từ `./ports/*` và `./infra/sql/*`).

- [ ] **Step 6: Chạy, commit**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm vitest run --project integration test/integration/tenancy/acquisition-repositories.spec.ts test/integration/tenancy/repositories.spec.ts
```
Expected: PASS (`resolve` lần hai trả `undefined`, `consumeUse` dừng ở `max_uses`, `revokeClosedForRole` chỉ thu hồi link đã đóng và trả `version` sau tăng, bộ lọc trạng thái hiệu lực coi PENDING quá hạn là EXPIRED).
```bash
pnpm exec prettier --write src/modules/tenancy test/unit/modules/tenancy/errors.spec.ts test/integration/tenancy/acquisition-repositories.spec.ts
git add src/modules/tenancy test/unit/modules/tenancy/errors.spec.ts test/integration/tenancy/acquisition-repositories.spec.ts
git commit -m "feat(tenancy): acquisition errors, events, metrics and SQL repositories for invitations, invite links and ownership transfers"
```

---

### Task 8: `MemberAdmission` nguồn `INVITATION`/`INVITE_LINK`, đóng M7 (single-org), `GrantorRecheck`, `TransferSettlement`

**Files:**
- Create: `src/modules/tenancy/application/grantor-recheck.ts`, `src/modules/tenancy/application/transfer-settlement.ts`, `test/integration/tenancy/single-org-admission.spec.ts`
- Modify: `src/modules/tenancy/application/member-admission.ts`, `src/modules/tenancy/application/org.service.ts`, `src/modules/tenancy/tenancy.module.ts`

**Interfaces:**
- Consumes: `MemberRepository.lockForShare`, `type MemberRow` (3A), `RolePermissions.of(role)` và `RolePermissions.detailOf(role): { granted; orphans }` (3B Task 5; `assertCanBind` của 3B đòi `orphans` bắt buộc), `PermissionCatalogueRegistry.merged()` (3A), `assertCanBind`, `type Actor` (3A `domain/escalation.ts`), `OrgRepository.countMembershipsForUser`, `OrgRepository.clockNow` (Task 7/3A), `OwnershipTransferRepository` (Task 7), `OwnershipTransferCancelledEvent` (Task 7), `isLapsed` (Task 6), `EventPublisher`, `type EventActor` (SP1).
- Produces:
  - `member-admission.ts`: `type Admission = { source: 'CREATOR' } | { source: 'INVITATION'; invitationId: string } | { source: 'INVITE_LINK'; inviteLinkId: string }`; `MemberAdmission.admit(i: { user: TenancyUserRef; role: RoleRow; actor: EventActor; admission: Admission }): Promise<MemberRow>` (thay tham số `source` của 3A); chế độ single-org đếm **mọi** membership của user (kể cả ở org xoá mềm, M7) bằng `countMembershipsForUser`.
  - `grantor-recheck.ts`: `type GrantorCheck = { ok: true } | { ok: false; reason: InvalidationReason }`; `GrantorRecheck.check(grantorMemberId: string | null, role: { id: string; systemKey: SystemRoleKey | null }): Promise<GrantorCheck>` (gọi trong transaction đã khoá org; đọc người mời `FOR SHARE`).
  - `transfer-settlement.ts`: `transferEventData(t: TransferRow): { transferId; fromMemberId; toMemberId; stepDownTo }` (ném khi thiếu member: chỉ gọi khi dòng còn PENDING hoặc vừa rời PENDING trong cùng transaction); `TransferSettlement.settleForRemovedMember(memberId: string, actor: EventActor): Promise<void>` (PENDING đã hết hạn → EXPIRED không event; còn hạn → CANCELLED + event `{ reason: 'MEMBER_REMOVED' }`).
  - `TenancyCoreModule` provider + export: `GrantorRecheck`, `TransferSettlement`.

- [ ] **Step 1: Test M7 (fail trên code 3A: member của org xoá mềm vẫn vào được org khác)**

`test/integration/tenancy/single-org-admission.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { MemberAdmission } from '../../../src/modules/tenancy/application/member-admission.js';
import { OrgRepository } from '../../../src/modules/tenancy/ports/org-repository.js';
import { RoleRepository } from '../../../src/modules/tenancy/ports/role-repository.js';
import { TenancyUserRepository } from '../../../src/modules/tenancy/ports/tenancy-user-repository.js';
import { applyTestEnv, createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const ACTOR = { type: 'system', id: 'test.single-org' } as const;

/**
 * M7 (3A final review, carry sang 3C): chế độ single-org đếm bằng `tenancy_count_user_orgs(user, true)`, hàm chỉ tính org
 * xoá mềm khi user là OWNER. Một MEMBER của org A đã xoá mềm vì vậy vào được org B; khôi phục A để lại user ở HAI org.
 * 3C đếm mọi membership (kể cả org xoá mềm) ở `MemberAdmission`, chỗ duy nhất mọi đường join đi qua.
 */
describe('single-org admission counts memberships of soft-deleted orgs (M7)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const setDeleted = (org: SeededOrg, deleted: boolean) =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          deleted
            ? `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`
            : `UPDATE organizations SET deleted_at = NULL, purge_after = NULL WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
  const admitInto = (org: SeededOrg, subject: string) =>
    app.get(OrgScope).run(org.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        await app.get(OrgRepository).lockCurrent();
        const user = await app.get(TenancyUserRepository).upsertAndLock({ kind: 'EXTERNAL', externalSubject: subject });
        const role = await app.get(RoleRepository).findByPublicId(org.roles.MEMBER.publicId);
        if (!role) throw new Error('member role missing');
        return app.get(MemberAdmission).admit({ user, role, actor: ACTOR, admission: { source: 'INVITATION', invitationId: v7() } });
      }),
    );
  beforeAll(async () => {
    applyTestEnv();
    vi.stubEnv('TENANCY_MEMBERSHIP_MODE', 'single');
    app = await createTestApp(tenancyCoreImports());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('a MEMBER of a soft-deleted org cannot join another org; after the restore they still belong to exactly one', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    orgs.push(a, b);
    const subject = `m7:${v7()}`;
    const m = await seedMember(a, 'MEMBER', { externalSubject: subject });
    await setDeleted(a, true);
    await expect(admitInto(b, subject)).rejects.toMatchObject({ error: { code: 'already_in_an_org' } });
    await setDeleted(a, false);
    expect(await app.get(OrgRepository).countMembershipsForUser(m.userId)).toBe(1);
  });
  it('a user with no membership anywhere joins normally in single mode', async () => {
    const c = await seedOrg();
    orgs.push(c);
    const member = await admitInto(c, `m7-free:${v7()}`);
    expect(member.systemKey).toBe('MEMBER');
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/single-org-admission.spec.ts`
Expected: FAIL — ca đầu: typecheck của `admission: {…}` (tham số chưa có); sau khi đổi chữ ký ở Step 2 mà CHƯA đổi phép đếm, ca đầu vẫn đỏ vì `admit` vào được B (bằng chứng M7). Ghi RED đó vào báo cáo task.

- [ ] **Step 2: `MemberAdmission`**

`src/modules/tenancy/application/member-admission.ts` — thay `export type AdmissionSource …` và phương thức `admit` bằng:
```ts
/** Nguồn membership (spec §14 `tenancy.member.added.source`); lời mời/link mang id công khai của chính nó vào event. */
export type Admission =
  | { source: 'CREATOR' }
  | { source: 'INVITATION'; invitationId: string }
  | { source: 'INVITE_LINK'; inviteLinkId: string };

const refOf = (a: Admission): { invitationId?: string; inviteLinkId?: string } => {
  switch (a.source) {
    case 'CREATOR':
      return {};
    case 'INVITATION':
      return { invitationId: a.invitationId };
    case 'INVITE_LINK':
      return { inviteLinkId: a.inviteLinkId };
    default: {
      const unknown: never = a;
      throw new Error(`unknown admission ${JSON.stringify(unknown)}`);
    }
  }
};
```
```ts
  async admit(i: { user: TenancyUserRef; role: RoleRow; actor: EventActor; admission: Admission }): Promise<MemberRow> {
    if (!this.uow.inTransaction()) throw new Error('MemberAdmission.admit must run inside UnitOfWork.run');
    return tenancySpan(
      'tenancy.member.admit',
      async () => {
        // T-7: đếm SAU khi đã khoá tenancy_users của user, nên hai lần join song song thấy nhau. M7: đếm MỌI membership,
        // kể cả ở org xoá mềm — khôi phục org đó không được để user ở hai org (một MEMBER không tự rời được org xoá mềm;
        // họ vào được org khác sau khi org cũ bị purge hoặc sau khi được gỡ khỏi nó lúc đã khôi phục).
        if (this.cfg.membershipMode === 'single' && (await this.orgs.countMembershipsForUser(i.user.id)) > 0)
          throw new AppError(TenancyErrors.ALREADY_IN_AN_ORG);
        // 4B (spec SP4 §9.6): kiểm ghế `tenancy.seats` qua port `MemberSeatLimit` (@Optional) đặt ở ĐÂY — sau khoá
        // tenancy_users, trước INSERT — nên phủ mọi nguồn (CREATOR, INVITATION, INVITE_LINK) mà 3C không gọi entitlements.
        // 3D (SEC-M5): thu hồi support grant chưa thu hồi của chính user trong org, trước INSERT (spec Bảng 5).
        // Extension point (S3-Q4 C): verified-domain auto-join — spec §19; dùng lại hàm này với nguồn `DOMAIN`.
        const member = await this.members.insert({ userId: i.user.id, roleId: i.role.id });
        await this.events.publish(MemberAddedEvent, {
          data: {
            memberId: member.publicId,
            userId: i.user.publicId,
            roleId: i.role.publicId,
            source: i.admission.source,
            ...refOf(i.admission),
          },
          aggregate: { type: 'member', id: member.publicId, version: member.version },
          actor: i.actor,
        });
        return member;
      },
      () => ({ 'tenancy.member.source': i.admission.source }),
    );
  }
```
(Bỏ `export type AdmissionSource` cùng import của nó: không còn nơi nào dùng sau khi `OrgService` đổi lời gọi; `pnpm typecheck` xác nhận.)

`src/modules/tenancy/application/org.service.ts` — trong `create`, đổi lời gọi (giữ nguyên vòng participant tạo org của 4A ngay trước nó: participant chạy TRƯỚC khi người tạo vào org):
```ts
        await this.admission.admit({
          user,
          role: roles.OWNER,
          actor,
          admission: { source: 'CREATOR' },
        });
```
Run lại Step 1 → PASS. Chạy thêm `pnpm vitest run --project integration test/e2e/tenancy/orgs-single-mode.e2e.spec.ts test/e2e/tenancy/orgs.e2e.spec.ts` → PASS (T-7 và tạo org không đổi hành vi).

- [ ] **Step 3: `GrantorRecheck` và `TransferSettlement`**

`src/modules/tenancy/application/grantor-recheck.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { SystemRoleKey } from '../constants.js';
import { assertCanBind, type Actor } from '../domain/escalation.js';
import type { InvalidationReason } from '../domain/invitation.js';
import { MemberRepository } from '../ports/member-repository.js';
import { RolePermissions } from './authz/role-permissions.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

const INVITATIONS_WRITE = 'invitations.write';
export type GrantorCheck = { ok: true } | { ok: false; reason: InvalidationReason };

/**
 * Spec SP3 §8.4 đường (b), (c) (SEC-M3): lúc chấp nhận lời mời / join link, kiểm lại CỬA (`invitations.write`) và TRẦN
 * (`assertCanBind`, gồm luật 2a theo tập) với người mời/người tạo HIỆN TẠI. Gọi trong transaction đã khoá org; đọc
 * người đó `FOR SHARE` (thứ tự khoá §3.14: org → tenancy_users → lời mời/link → member).
 */
@Injectable()
export class GrantorRecheck {
  constructor(
    private readonly members: MemberRepository,
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
  ) {}

  async check(grantorMemberId: string | null, role: { id: string; systemKey: SystemRoleKey | null }): Promise<GrantorCheck> {
    if (grantorMemberId === null) return { ok: false, reason: 'INVITER_GONE' };
    const [grantor] = await this.members.lockForShare([grantorMemberId]);
    if (!grantor) return { ok: false, reason: 'INVITER_GONE' };
    const permissions = new Set(await this.rolePermissions.of({ id: grantor.roleId, systemKey: grantor.systemKey }));
    if (!permissions.has(INVITATIONS_WRITE)) return { ok: false, reason: 'INVITER_LACKS_GATE' };
    const actor: Actor = { memberRef: grantor.publicId, isOwner: grantor.systemKey === 'OWNER', permissions };
    // 3B: `orphans` bắt buộc — role còn key orphan chỉ owner gán được, kể cả lúc kiểm lại (R-X23, final review 3B I-1).
    const detail = await this.rolePermissions.detailOf(role);
    const target = { systemKey: role.systemKey, permissions: new Set(detail.granted), orphans: detail.orphans };
    return assertCanBind(actor, target, this.registry.merged()).ok ? { ok: true } : { ok: false, reason: 'INVITER_NOT_DOMINANT' };
  }
}
```
`src/modules/tenancy/application/transfer-settlement.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import type { StepDownRole } from '../constants.js';
import { isLapsed } from '../domain/expiry.js';
import { OwnershipTransferCancelledEvent } from '../events.js';
import { OrgRepository } from '../ports/org-repository.js';
import { OwnershipTransferRepository, type TransferRow } from '../ports/ownership-transfer-repository.js';

/** Dữ liệu event của yêu cầu (spec §14): id công khai của hai member; chỉ gọi khi cả hai còn (dòng vừa là PENDING). */
export function transferEventData(t: TransferRow): { transferId: string; fromMemberId: string; toMemberId: string; stepDownTo: StepDownRole | null } {
  if (t.fromMemberPublicId === null || t.toMemberPublicId === null)
    throw new Error('an ownership transfer event needs both members (org_ownership_transfers_pending_members_ck)');
  return { transferId: t.publicId, fromMemberId: t.fromMemberPublicId, toMemberId: t.toMemberPublicId, stepDownTo: t.stepDownTo };
}

/**
 * Spec SP3 §9.3: gỡ một member đang là bên gửi/nhận của yêu cầu PENDING phải huỷ yêu cầu TRƯỚC khi xoá trong cùng
 * transaction (không thì CHECK `…_pending_members_ck` làm transaction fail to). Yêu cầu đã quá hạn chỉ chuyển EXPIRED
 * (trạng thái suy ra từ thời gian, không event, §14.1). Gọi dưới khoá org, trước câu `DELETE org_members`.
 */
@Injectable()
export class TransferSettlement {
  constructor(
    private readonly orgs: OrgRepository,
    private readonly transfers: OwnershipTransferRepository,
    private readonly events: EventPublisher,
  ) {}

  async settleForRemovedMember(memberId: string, actor: EventActor): Promise<void> {
    const pending = await this.transfers.lockPendingForMember(memberId);
    if (pending.length === 0) return;
    const now = await this.orgs.clockNow();
    for (const t of pending) {
      if (isLapsed(t.expiresAt, now)) {
        await this.transfers.resolve(t.id, 'EXPIRED');
        continue;
      }
      const data = transferEventData(t);
      const done = await this.transfers.resolve(t.id, 'CANCELLED');
      if (!done) throw new Error('a locked PENDING ownership transfer was no longer PENDING');
      await this.events.publish(OwnershipTransferCancelledEvent, {
        data: { ...data, reason: 'MEMBER_REMOVED' },
        aggregate: { type: 'ownership_transfer', id: done.publicId, version: done.version },
        actor,
      });
    }
  }
}
```
(`data` lấy từ dòng TRƯỚC khi resolve: sau CAS vẫn còn hai member vì chưa xoá, nhưng đọc trước làm rõ ý đồ.)

`src/modules/tenancy/tenancy.module.ts` — thêm `GrantorRecheck`, `TransferSettlement` vào `TenancyCoreModule.providers` và `exports`.

- [ ] **Step 4: Chạy, commit**

Run:
```bash
pnpm typecheck && pnpm arch
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm vitest run --project integration test/integration/tenancy/single-org-admission.spec.ts test/e2e/tenancy/orgs-single-mode.e2e.spec.ts test/e2e/tenancy/orgs.e2e.spec.ts
```
Expected: PASS.
```bash
pnpm exec prettier --write src/modules/tenancy test/integration/tenancy/single-org-admission.spec.ts
git add src/modules/tenancy test/integration/tenancy/single-org-admission.spec.ts
git commit -m "feat(tenancy): admission sources for invitations and links, single-org counts soft-deleted memberships (M7), grantor recheck and transfer settlement"
```

---

### Task 9: Lời mời email — `InvitationService`, bucket `tenancy.token-preview`, năm route lời mời, ma trận route; Review Focus 1–3, B-10, B-12, B-13, B-16, B-20, B-22/B-23/B-24 (phần lời mời)

**Files:**
- Create: `src/modules/tenancy/application/tenancy-user-lock.ts`, `src/modules/tenancy/application/invite-role.ts`, `src/modules/tenancy/application/invitation.service.ts` (qua CLI), `src/modules/tenancy/http/token-preview.bucket.ts`, `src/modules/tenancy/http/invitations.controller.ts`, `src/modules/tenancy/http/invitation-tokens.controller.ts` (qua CLI), `test/support/tenancy-acquisition.ts`, `test/e2e/tenancy/invitations.e2e.spec.ts`
- Modify: `src/modules/tenancy/domain/display-text.ts`, `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/policy-metadata.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `test/unit/modules/tenancy/display-text.spec.ts`, `test/e2e/tenancy/role-route-matrix.e2e.spec.ts`, `openapi.json`

**Interfaces:**
- Consumes: `InvitationRepository`, `TokenMatch` (Task 7), `newAcquisitionToken`, `tokenHashHex`, `tokenUrl`, `isLapsed`, `effectiveInvitationStatus`, `oneLine` (Task 6), `GrantorRecheck`, `MemberAdmission.admit({ …, admission })` (Task 8), `TenancyFeatures.require` (Task 5), `TenancyErrors.*` 3C, `InvitationCreatedEvent`, `InvitationRevokedEvent`, `InvitationAcceptedEvent`, `InvitationInvalidatedEvent`, `TenancyMetrics.invitations` (Task 7), `SYSTEM_ROLE_LABELS`, `INVITATION_EMAIL_MAX_LENGTH`, `TOKEN_INPUT_MAX_LENGTH` (Task 2); 3A/3B: `ActorReauthorizer.require`, `userActor`, `EscalationGuard.enforce`, `assertCanBind` (với `orphans`), `RolePermissions.detailOf`, `PermissionCatalogueRegistry.merged`, `OrgRepository.{lockCurrent, readCurrent, clockNow}`, `RoleRepository.findByPublicId`, `MemberRepository.findByPublicId`, `MemberService.get` (`MemberView`), `TenancyUserRepository.upsertAndLock`, `TenancyUserVanishedError`, `SubjectResolver.of`, `TenancyTestHooks.afterGuard`, `tenancySpan`, `memberOf`, `MemberResponse`; SP1/SP2: `OrgScope.run`, `UnitOfWork.run`, `pgFields`, `RateLimitBuckets.register`, `clientIpTracker`, `PublicRoute`, `Idempotent`, `Paginator.offset`, `offsetPageQuery`, `serialize`, `setLocation`, `etagOf`, `ApiOk`, `ApiProblems`, `AuthFacts.verifiedEmail`, `IdentityErrors.EMAIL_NOT_VERIFIED`, `IdentityDirectory.findUser`, `identityConfig`, `normalizeEmail` (Task 5), `EmailNotifications.request`, `DISPLAY_NAME_MAX`; test: `seedInvitation`, `newToken`, `hashToken` (Task 4), `seedUserPrincipal`, `authed`, `startTenancyApp`, `mailpitFromInfra`, `PayrollPermissionsModule`, `installPayrollPermission`, `removePayrollPermission`, `adminKeys`, `roleSetC1`.
- Produces:
  - `domain/display-text.ts`: `roleLabelOf(r: { systemKey: SystemRoleKey | null; name: string | null }): string` (role hệ thống → `SYSTEM_ROLE_LABELS`; role tuỳ biến → tên; cả hai `null` → ném).
  - `application/tenancy-user-lock.ts`: `lockAdmittedUser(users: TenancyUserRepository, subject: TenancySubject): Promise<TenancyUserRef>` (`TenancyUserVanishedError` → `409 conflict`).
  - `application/invite-role.ts`: `actorOfMember(m: MemberRow, permissions: ReadonlySet<string>): Actor`; `InviteRole.bindable(rolePublicId: string, actor: Actor): Promise<RoleRow>` (role thiếu → `422 validation_failed` trường `roleId`; `OWNER` → `422 owner_not_invitable`; `assertCanBind` gồm `orphans`).
  - `http/token-preview.bucket.ts`: `TOKEN_PREVIEW_BUCKET`, `tokenPreviewBucketProvider` (bucket `tenancy.token-preview`, `refundable: false`), `TokenPreviewLimiter.consume(ip: unknown): Promise<void>` (`429 rate_limited` + `Retry-After`).
  - `application/invitation.service.ts`: `type TokenPreview = { orgName: string; roleName: string; expiresAt: Date }`; `InvitationService.list({ page, pageSize, cap }): Promise<{ rows: InvitationRow[]; total: number }>` (`status` là trạng thái hiệu lực), `.create({ email, roleId }): Promise<InvitationRow>`, `.revoke(publicId): Promise<void>`, `.preview(token): Promise<TokenPreview>`, `.accept(token): Promise<{ orgId: string; member: MemberView }>`.
  - `http/schemas.ts`: `publicIdOrNotFound(raw)`, `RoleRefResponse`, `roleRefOf(r)`, `InvitationEmail`, `InvitationResponse`, `invitationOf(i)`, `CreateInvitationBody`, `ListAcquisitionPage`, `TokenBody`, `TokenPreviewResponse`, `tokenPreviewOf(p)`.
  - Route: `GET /v1/orgs/:orgId/invitations` (`invitations.read`), `POST /v1/orgs/:orgId/invitations` (`invitations.write`, `@SensitiveTenancyAction()`, `@Idempotent()`, `201` + `Location`), `DELETE /v1/orgs/:orgId/invitations/:invitationId` (`invitations.write`, `@NarrowingTenancyAction()`, `204`), `POST /v1/invitations/preview` (`@PublicRoute()`, `200`), `POST /v1/invitations/accept` (`@SensitiveTenancyAction()`, `@Idempotent()`, `201` + `Location` của member).
  - `NARROWING_ROUTES` thêm `'DELETE v1/orgs/:orgId/invitations/:invitationId'`.
  - `test/support/tenancy-acquisition.ts`: `previewIp()`, `tokenFromMail(mail, to, subject, after): Promise<string>`, `acceptInvitation(app, p, body)`, `joinInviteLink(app, p, body)`, `previewToken(app, kind: 'invitations' | 'invite-links', body, ip?)`, `problemCore(body)`.

- [ ] **Step 1: `roleLabelOf` (unit fail → pass)**

`test/unit/modules/tenancy/display-text.spec.ts` — thêm import `roleLabelOf` và ca:
```ts
describe('roleLabelOf (role name in an email or a token preview)', () => {
  it('system roles use their fixed label, custom roles their name; a role with neither is a programming error', () => {
    expect(roleLabelOf({ systemKey: 'ADMIN', name: null })).toBe('Admin');
    expect(roleLabelOf({ systemKey: null, name: 'Payroll clerks' })).toBe('Payroll clerks');
    expect(() => roleLabelOf({ systemKey: null, name: null })).toThrow(/neither a system key nor a name/);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/display-text.spec.ts` → FAIL.

`src/modules/tenancy/domain/display-text.ts` — thêm:
```ts
import { SYSTEM_ROLE_LABELS, type SystemRoleKey } from '../constants.js';

/** Tên hiển thị của role (spec §6.5: role hệ thống không lưu tên). `org_roles_kind_ck` bảo đảm có đúng một trong hai. */
export function roleLabelOf(r: { systemKey: SystemRoleKey | null; name: string | null }): string {
  if (r.systemKey !== null) return SYSTEM_ROLE_LABELS[r.systemKey];
  if (r.name !== null) return r.name;
  throw new Error('a role with neither a system key nor a name (org_roles_kind_ck)');
}
```
Run lại → PASS.

- [ ] **Step 2: Helper test, schema, e2e (fail)**

`test/support/tenancy-acquisition.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { v7 } from 'uuid';
import type { Mailpit } from './mailpit.js';
import { authed } from './tenancy-app.js';
import type { SeededPrincipal } from './tenancy-principals.js';

/** Token 32 byte base64url ở fragment của link trong thư (spec §9.1). Không bao giờ log nó. */
const TOKEN_FRAGMENT = /#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;
/** IP riêng mỗi lần preview (dải benchmark RFC 2544, như `AuthClient`): bucket `tenancy.token-preview` khoá theo IP. */
export const previewIp = (): string => `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;

export async function tokenFromMail(mail: Mailpit, to: string, subject: RegExp, after: number): Promise<string> {
  const msg = await mail.waitFor(to, { subject, after });
  const token = TOKEN_FRAGMENT.exec(msg.Text)?.[1];
  if (!token) throw new Error('no #token= fragment in the email');
  return token;
}
export const acceptInvitation = (app: INestApplication, p: SeededPrincipal, body: unknown) =>
  authed(app, p).post('/v1/invitations/accept').set('idempotency-key', `k-${v7()}`).send(body as object);
export const joinInviteLink = (app: INestApplication, p: SeededPrincipal, body: unknown) =>
  authed(app, p).post('/v1/invite-links/join').set('idempotency-key', `k-${v7()}`).send(body as object);
/** Route public: không credential; IP qua `x-forwarded-for` (app test chạy với `HTTP_TRUST_PROXY=loopback`). */
export const previewToken = (app: INestApplication, kind: 'invitations' | 'invite-links', body: unknown, ip = previewIp()) =>
  request(app.getHttpServer()).post(`/v1/${kind}/preview`).set('x-forwarded-for', ip).send(body as object);
/** Phần của problem+json phải giống hệt giữa các đường lỗi (bỏ `instance`, `requestId`, `timestamp`; spec §18.2). */
export const problemCore = (b: Record<string, unknown>) => ({ type: b['type'], title: b['title'], status: b['status'], code: b['code'], detail: b['detail'] });
```
(`body as object`: supertest `send` nhận `string | object`; test cố ý gửi body rác như số hay `null` ở Review Focus 3, nên tham số là `unknown`.)

`src/modules/tenancy/http/schemas.ts` — thêm import `INVITATION_STATUSES`, `type InvitationStatus` từ `../domain/invitation.js`, `INVITATION_EMAIL_MAX_LENGTH`, `TOKEN_INPUT_MAX_LENGTH` từ `../constants.js`, `normalizeEmail` từ `../../identity/index.js`, `AppError`, `CoreErrors` từ `../../../core/errors/index.js`, `type InvitationRow` từ `../ports/invitation-repository.js`, `type TokenPreview` từ `../application/invitation.service.js`, rồi thêm:
```ts
/** Id không phải UUID là "không có resource như vậy" (404), không phải lỗi SQL 22P02 (500). */
export const publicIdOrNotFound = (raw: string): string => {
  const r = PublicIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};
export const RoleRefResponse = z.object({ id: z.uuid(), systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(), name: z.string().nullable() });
/** `role` là `null` khi role đã bị xoá sau khi lời mời/link kết thúc (spec §12, DB-I2). */
export const roleRefOf = (r: { rolePublicId: string | null; roleSystemKey: (typeof SYSTEM_ROLE_KEYS)[number] | null; roleName: string | null }) =>
  r.rolePublicId === null ? null : { id: r.rolePublicId, systemKey: r.roleSystemKey, name: r.roleName };
/**
 * Review Focus 1: chuẩn hoá `trim → lowercase → NFC` bằng CÙNG hàm của identity rồi mới kiểm định dạng và độ dài, nên
 * `" Ann@Example.TEST "` thành `ann@example.test`; độ dài so bằng đơn vị UTF-16 (≥ số code point mà `char_length` đếm).
 */
export const InvitationEmail = z
  .string()
  .transform(normalizeEmail)
  .refine((e) => e.length <= INVITATION_EMAIL_MAX_LENGTH && z.email().safeParse(e).success, 'must be an email address');
export const CreateInvitationBody = z.object({ email: InvitationEmail, roleId: z.uuid() }).strict();
export const InvitationResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  role: RoleRefResponse.nullable(),
  status: z.enum(INVITATION_STATUSES),
  expiresAt: iso,
  createdAt: iso,
  resolvedAt: iso.nullable(),
});
export const invitationOf = (i: InvitationRow & { status: InvitationStatus }): z.infer<typeof InvitationResponse> => ({
  id: i.publicId,
  email: i.email,
  role: roleRefOf(i),
  status: i.status,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
});
export const ListAcquisitionPage = offsetPageQuery({ sortable: ['createdAt'] as const });
/** Review Focus 3: thiếu/sai kiểu/ngoài base64url/quá dài → 422; đúng kiểu mà không phải token nào → 404 thống nhất. */
export const TokenBody = z
  .object({ token: z.string().min(1).max(TOKEN_INPUT_MAX_LENGTH).regex(/^[A-Za-z0-9_-]+$/, 'must be a base64url token') })
  .strict();
/** Preview (spec §9.1): không email được mời, không tên người mời — người cầm token đã có thư. */
export const TokenPreviewResponse = z.object({ orgName: z.string(), roleName: z.string(), expiresAt: iso });
export const tokenPreviewOf = (p: TokenPreview): z.infer<typeof TokenPreviewResponse> => ({
  orgName: p.orgName,
  roleName: p.roleName,
  expiresAt: p.expiresAt.toISOString(),
});
```
(`schemas.ts` đã import kiểu từ `../application/member.service.js`; import kiểu từ service khác cùng module không tạo vòng runtime vì là `import type`.)

`test/e2e/tenancy/invitations.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { acceptInvitation, previewToken, problemCore, tokenFromMail } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  adminKeys,
  inOrgTx,
  newToken,
  roleSetC1,
  seedCustomRole,
  seedInvitation,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';
import { PayrollPermissionsModule, installPayrollPermission, removePayrollPermission } from './fixtures/payroll-permissions.js';

const PENDING_CAP = 3;
const SUBJECT = /You're invited to join/;

describe('email invitations (spec SP3 §9.1, §12; §18.3 B-10, B-12, B-13, B-16, B-20, B-22–B-24; Review Focus 1–3)', () => {
  let app: INestApplication;
  /** Tính từ catalogue gộp lúc chạy (R-X24). */
  let ADMIN_KEYS: string[];
  let C1: string[];
  const mail = mailpitFromInfra();
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** O owner, A admin, Xp giữ X = ADMIN ∪ {payroll.read}; c1 = C1, vPrime ≡ ADMIN (owner tạo, chưa ai giữ). */
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId }, name: 'Acme' });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const c1 = await seedCustomRole(org, { permissions: C1, name: `C1 ${v7()}` });
    const vPrime = await seedCustomRole(org, { permissions: ADMIN_KEYS, name: `V' ${v7()}` });
    const x = await seedCustomRole(org, { permissions: [...ADMIN_KEYS, 'payroll.read'], name: `X ${v7()}` });
    const Xp = await seedP();
    await seedMemberInRole(org, x, { authUserId: Xp.authUserId });
    return { org, O, A, aMemberId: a.memberId, c1, vPrime, Xp };
  };
  const invite = (p: SeededPrincipal, org: SeededOrg, body: object) =>
    authed(app, p).post(`/v1/orgs/${org.orgId}/invitations`).set('idempotency-key', `k-${v7()}`).send(body);
  const list = (p: SeededPrincipal, org: SeededOrg) => authed(app, p).get(`/v1/orgs/${org.orgId}/invitations?pageSize=100`);
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) => withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id', [aggregateId]);
  const statusOf = async (org: SeededOrg, invitationId: string) =>
    (await sql(org, 'SELECT status FROM org_invitations WHERE id = $1', [invitationId])).rows[0]?.status;
  const membersOf = async (org: SeededOrg, p: SeededPrincipal) =>
    (await sql(org, 'SELECT 1 FROM org_members m JOIN tenancy_users u ON u.id = m.user_id WHERE u.auth_user_id = $1', [p.authUserId])).rows.length;

  beforeAll(async () => {
    await installPayrollPermission();
    app = await startTenancyApp({
      extraImports: [PayrollPermissionsModule],
      env: {
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
        HTTP_TRUST_PROXY: 'loopback',
        TENANCY_MAX_PENDING_INVITATIONS_PER_ORG: String(PENDING_CAP),
      },
    });
    const merged = app.get(PermissionCatalogueRegistry).merged();
    ADMIN_KEYS = adminKeys(merged);
    C1 = roleSetC1(merged);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await removePayrollPermission();
    vi.unstubAllEnvs();
  });

  it('create → 201 + Location, no token in the body, one email with #token=; preview; accept → 201 member; the token is single-use', async () => {
    const c = await cast();
    const invitee = await seedP();
    const after = await mail.now();
    const created = await invite(c.A, c.org, { email: invitee.email, roleId: c.c1.publicId });
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(`/v1/orgs/${c.org.orgId}/invitations/${created.body.id}`);
    expect(created.body).toMatchObject({ email: invitee.email, status: 'PENDING', role: { id: c.c1.publicId, systemKey: null }, resolvedAt: null });
    expect(JSON.stringify(created.body)).not.toMatch(/token/i);
    const token = await tokenFromMail(mail, invitee.email, SUBJECT, after);
    const preview = await previewToken(app, 'invitations', { token });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ orgName: 'Acme', roleName: c.c1.name, expiresAt: created.body.expiresAt });
    const accepted = await acceptInvitation(app, invitee, { token });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.location).toBe(`/v1/orgs/${c.org.orgId}/members/${accepted.body.id}`);
    expect(accepted.body).toMatchObject({ role: { id: c.c1.publicId }, email: invitee.email });
    expect((await events(created.body.id)).map((e) => e.type)).toEqual(['tenancy.invitation.created', 'tenancy.invitation.accepted']);
    expect((await events(accepted.body.id)).map((e) => [e.type, e.payload['source'], e.payload['invitationId']])).toEqual([
      ['tenancy.member.added', 'INVITATION', created.body.id],
    ]);
    const again = await acceptInvitation(app, await seedP(), { token });
    expect([again.status, again.body.code]).toEqual([404, 'invitation_not_found']);
    expect((await list(c.A, c.org)).body.data.find((i: { id: string }) => i.id === created.body.id)).toMatchObject({ status: 'ACCEPTED' });
  });
  it('Review Focus 1: the invited email is normalised and matched case-insensitively; a real mismatch never echoes the invited address', async () => {
    const c = await cast();
    const invitee = await seedP();
    const padded = ` ${invitee.email.toUpperCase()} `;
    const created = await invite(c.A, c.org, { email: padded, roleId: c.org.roles.MEMBER.publicId });
    expect([created.status, created.body.email]).toEqual([201, invitee.email]);
    const stranger = await seedP();
    const other = await seedInvitation(c.org, { email: `other-${v7()}@example.test`, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.aMemberId });
    const mismatch = await acceptInvitation(app, stranger, { token: other.token });
    expect([mismatch.status, mismatch.body.code]).toEqual([403, 'invitation_email_mismatch']);
    expect(JSON.stringify(mismatch.body)).not.toContain('other-');
    expect(await statusOf(c.org, other.id)).toBe('PENDING');
    for (const email of ['not-an-email', 'a@', `${'a'.repeat(250)}@example.test`])
      expect((await invite(c.A, c.org, { email, roleId: c.org.roles.MEMBER.publicId })).body.code).toBe('validation_failed');
  });
  it('Review Focus 2: accepting while already a member is 409 already_member and leaves the invitation pending', async () => {
    const c = await cast();
    const inv = await seedInvitation(c.org, { email: c.A.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.org.owner.memberId });
    const r = await acceptInvitation(app, c.A, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([409, 'already_member']);
    expect(await statusOf(c.org, inv.id)).toBe('PENDING');
    expect(await events(inv.publicId)).toEqual([]);
  });
  it('Review Focus 3: garbage tokens are 422 or the uniform 404, never 500', async () => {
    const p = await seedP();
    const bodies422: unknown[] = [{}, { token: '' }, { token: 'x'.repeat(10_000) }, { token: 'abc$%' }, { token: 42 }, { token: 'abc', extra: 1 }, null];
    for (const body of bodies422) {
      expect((await previewToken(app, 'invitations', body)).status, JSON.stringify(body)).toBe(422);
      expect((await acceptInvitation(app, p, body)).status, JSON.stringify(body)).toBe(422);
    }
    for (const token of [newToken(), 'a', 'A'.repeat(128)]) {
      expect((await previewToken(app, 'invitations', { token })).body.code).toBe('invitation_not_found');
      expect((await acceptInvitation(app, p, { token })).body.code).toBe('invitation_not_found');
    }
  });
  it('unknown, expired, used, revoked and soft-deleted-org tokens give one identical 404 at preview and accept', async () => {
    const c = await cast();
    const p = await seedP();
    const base = { email: p.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.aMemberId };
    const expired = await seedInvitation(c.org, { ...base, expiresInSec: -60 });
    const revoked = await seedInvitation(c.org, { ...base, email: `r-${v7()}@example.test` });
    expect((await authed(app, c.A).delete(`/v1/orgs/${c.org.orgId}/invitations/${revoked.publicId}`)).status).toBe(204);
    const deletedOrg = await cast();
    const inDeleted = await seedInvitation(deletedOrg.org, { email: p.email, roleId: deletedOrg.org.roles.MEMBER.id, inviterMemberId: deletedOrg.aMemberId });
    expect((await authed(app, deletedOrg.O).delete(`/v1/orgs/${deletedOrg.org.orgId}`)).status).toBe(204);
    const tokens = [newToken(), expired.token, revoked.token, inDeleted.token];
    const previews = await Promise.all(tokens.map((token) => previewToken(app, 'invitations', { token })));
    const accepts = [];
    for (const token of tokens) accepts.push(await acceptInvitation(app, p, { token }));
    for (const r of [...previews, ...accepts]) expect(r.status).toBe(404);
    expect(new Set([...previews, ...accepts].map((r) => JSON.stringify(problemCore(r.body)))).size).toBe(1);
    // Chạm sau hạn ghi EXPIRED (không event, §14.1); dòng còn lại đã thu hồi không đổi.
    expect(await statusOf(c.org, expired.id)).toBe('EXPIRED');
    expect((await events(expired.publicId)).map((e) => e.type)).toEqual([]);
  });
  it('revoke: 204 + one tenancy.invitation.revoked; again → 409 invitation_not_pending; a lapsed one → 409 and EXPIRED without an event', async () => {
    const c = await cast();
    const inv = await seedInvitation(c.org, { email: `rv-${v7()}@example.test`, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.aMemberId });
    const url = `/v1/orgs/${c.org.orgId}/invitations/${inv.publicId}`;
    expect((await authed(app, c.A).delete(url)).status).toBe(204);
    expect((await authed(app, c.A).delete(url)).body.code).toBe('invitation_not_pending');
    expect((await events(inv.publicId)).map((e) => e.type)).toEqual(['tenancy.invitation.revoked']);
    const lapsed = await seedInvitation(c.org, { email: `lp-${v7()}@example.test`, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.aMemberId, expiresInSec: -60 });
    expect((await authed(app, c.A).delete(`/v1/orgs/${c.org.orgId}/invitations/${lapsed.publicId}`)).body.code).toBe('invitation_not_pending');
    expect(await statusOf(c.org, lapsed.id)).toBe('EXPIRED');
    expect(await events(lapsed.publicId)).toEqual([]);
    expect((await authed(app, c.A).delete(`/v1/orgs/${c.org.orgId}/invitations/not-a-uuid`)).status).toBe(404);
  });
  it('T-4 / T-11: a second pending invitation for the same email is 409; the per-org cap counts only pending, unexpired invitations', async () => {
    const c = await cast();
    const email = `dup-${v7()}@example.test`;
    await seedInvitation(c.org, { email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.aMemberId, expiresInSec: -60 });
    expect((await invite(c.A, c.org, { email, roleId: c.org.roles.MEMBER.publicId })).status).toBe(201); // lapsed → EXPIRED trước INSERT
    expect((await invite(c.A, c.org, { email, roleId: c.org.roles.MEMBER.publicId })).body.code).toBe('invitation_pending_exists');
    await seedInvitation(c.org, { email: `done-${v7()}@example.test`, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.aMemberId, status: 'REVOKED' });
    for (let i = 1; i < PENDING_CAP; i++)
      expect((await invite(c.A, c.org, { email: `cap-${i}-${v7()}@example.test`, roleId: c.org.roles.MEMBER.publicId })).status).toBe(201);
    const over = await invite(c.A, c.org, { email: `over-${v7()}@example.test`, roleId: c.org.roles.MEMBER.publicId });
    expect([over.status, over.body.code]).toEqual([422, 'pending_invitations_limit']);
  });
  it('B-16 / B-22 / B-23 / B-10 at creation: OWNER is never invitable; X cannot invite with ADMIN or V′; a role the actor does not strictly dominate is refused', async () => {
    const c = await cast();
    const email = () => `b-${v7()}@example.test`;
    expect((await invite(c.O, c.org, { email: email(), roleId: c.org.roles.OWNER.publicId })).body.code).toBe('owner_not_invitable');
    expect((await invite(c.A, c.org, { email: email(), roleId: c.org.roles.OWNER.publicId })).body.code).toBe('owner_not_invitable');
    expect((await invite(c.Xp, c.org, { email: email(), roleId: c.org.roles.ADMIN.publicId })).body.code).toBe('owner_only');
    expect((await invite(c.Xp, c.org, { email: email(), roleId: c.vPrime.publicId })).body.code).toBe('owner_only');
    expect((await invite(c.A, c.org, { email: email(), roleId: c.org.roles.ADMIN.publicId })).body.code).toBe('owner_only');
    // B-10: người giữ C1 không có `invitations.write` (C1 = MEMBER ∪ {members.role.assign}) → guard 403.
    const K = await seedP();
    await seedMemberInRole(c.org, c.c1, { authUserId: K.authUserId });
    expect((await invite(K, c.org, { email: email(), roleId: c.org.roles.MEMBER.publicId })).body.code).toBe('forbidden');
    // Luật 2 thuần: role có quyền A không có (payroll.read) → 403 escalation_denied.
    const payroll = await seedCustomRole(c.org, { permissions: ['org.read', 'payroll.read'], name: `P ${v7()}` });
    expect((await invite(c.A, c.org, { email: email(), roleId: payroll.publicId })).body.code).toBe('escalation_denied');
    expect((await invite(c.A, c.org, { email: email(), roleId: v7() })).body.code).toBe('validation_failed');
  });

  /** Mời bằng `inviter`, đổi trạng thái của người mời/role bằng `mutate`, rồi chấp nhận: 409 + INVALIDATED + event có `reason`. */
  const invalidatedBy = async (
    c: Awaited<ReturnType<typeof cast>>,
    o: { inviterMemberId: string; role: SeededRole | { id: string; publicId: string }; mutate: () => Promise<unknown>; reason: string },
  ) => {
    const invitee = await seedP();
    const inv = await seedInvitation(c.org, { email: invitee.email, roleId: o.role.id, inviterMemberId: o.inviterMemberId });
    await o.mutate();
    const r = await acceptInvitation(app, invitee, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([409, 'invitation_invalidated']);
    expect(await statusOf(c.org, inv.id)).toBe('INVALIDATED');
    expect((await events(inv.publicId)).map((e) => [e.type, e.payload['reason']])).toEqual([['tenancy.invitation.invalidated', o.reason]]);
    expect(await membersOf(c.org, invitee)).toBe(0);
    expect((await acceptInvitation(app, invitee, { token: inv.token })).body.code).toBe('invitation_not_found');
  };
  it('B-12: the inviter is demoted to MEMBER before the accept → INVITER_LACKS_GATE', async () => {
    const c = await cast();
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.c1,
      mutate: () => sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [c.org.roles.MEMBER.id, c.aMemberId]),
      reason: 'INVITER_LACKS_GATE',
    });
  });
  it('B-20: the inviter loses invitations.write but still dominates C1 → INVITER_LACKS_GATE', async () => {
    const c = await cast();
    const noInvite = await seedCustomRole(c.org, { permissions: ADMIN_KEYS.filter((k) => k !== 'invitations.write'), name: `A- ${v7()}` });
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.c1,
      mutate: () => sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [noInvite.id, c.aMemberId]),
      reason: 'INVITER_LACKS_GATE',
    });
  });
  it('B-13: C1 gains a permission the inviter lacks before the accept → INVITER_NOT_DOMINANT', async () => {
    const c = await cast();
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.c1,
      mutate: () =>
        sql(c.org, `INSERT INTO org_role_permissions (org_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'payroll.read'`, [c.org.orgId, c.c1.id]),
      reason: 'INVITER_NOT_DOMINANT',
    });
  });
  it('B-24 (invitation part): an owner invites with V′ ≡ ADMIN and is demoted to ADMIN before the accept → INVITER_NOT_DOMINANT (rule 2a)', async () => {
    const c = await cast();
    await seedMember(c.org, 'OWNER', { authUserId: (await seedP()).authUserId }); // còn owner khác: hạ O không chạm owner cuối
    await invalidatedBy(c, {
      inviterMemberId: c.org.owner.memberId,
      role: c.vPrime,
      mutate: () => sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [c.org.roles.ADMIN.id, c.org.owner.memberId]),
      reason: 'INVITER_NOT_DOMINANT',
    });
  });
  it('the inviter left the organization → INVITER_GONE', async () => {
    const c = await cast();
    await invalidatedBy(c, {
      inviterMemberId: c.aMemberId,
      role: c.org.roles.MEMBER,
      mutate: () => sql(c.org, 'DELETE FROM org_members WHERE id = $1', [c.aMemberId]),
      reason: 'INVITER_GONE',
    });
  });
  it('accept is a sensitive action: a stale session → 403 reauthentication_required, an unverified email → 403 email_not_verified; the invitation stays pending', async () => {
    const c = await cast();
    for (const [opts, code] of [
      [{ sessionAgeSec: 3600 }, 'reauthentication_required'],
      [{ emailVerified: false }, 'email_not_verified'],
    ] as const) {
      const p = await seedP(opts);
      const inv = await seedInvitation(c.org, { email: p.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.aMemberId });
      expect((await acceptInvitation(app, p, { token: inv.token })).body.code).toBe(code);
      expect(await statusOf(c.org, inv.id)).toBe('PENDING');
    }
  });
});

describe('email invitations switched off (TENANCY_EMAIL_INVITATIONS=off, spec §13)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    app = await startTenancyApp({ env: { TENANCY_EMAIL_INVITATIONS: 'off' } });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('creating is 403 feature_disabled; an invitation that already exists still previews and accepts', async () => {
    const O = await seedUserPrincipal();
    const p = await seedUserPrincipal();
    principals.push(O, p);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const r = await authed(app, O).post(`/v1/orgs/${org.orgId}/invitations`).set('idempotency-key', `k-${v7()}`).send({ email: p.email, roleId: org.roles.MEMBER.publicId });
    expect([r.status, r.body.code]).toEqual([403, 'feature_disabled']);
    const inv = await seedInvitation(org, { email: p.email, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    expect((await previewToken(app, 'invitations', { token: inv.token })).status).toBe(200);
    expect((await acceptInvitation(app, p, { token: inv.token })).status).toBe(201);
  });
});
```

Run: `pnpm vitest run --project integration test/e2e/tenancy/invitations.e2e.spec.ts`
Expected: FAIL (route chưa có: 404 ở mọi ca).

- [ ] **Step 3: Phần dùng chung — khoá user, role được mời, bucket preview**

`src/modules/tenancy/application/tenancy-user-lock.ts`:
```ts
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { TenancyUserVanishedError } from '../errors.js';
import type { TenancySubject, TenancyUserRef, TenancyUserRepository } from '../ports/tenancy-user-repository.js';

/**
 * Khoá `tenancy_users` của người vào org (spec §8.6 bước 2; T-25, T-7) cho chấp nhận lời mời và join link. Dòng bị bước
 * `release` của xoá tài khoản xoá giữa upsert và khoá (DB2-M10) → `409 conflict`; không thử lại (sẽ tạo lại dòng cho một
 * user đang bị xoá). Cùng cách `OrgService.create` xử lý.
 */
export async function lockAdmittedUser(users: TenancyUserRepository, subject: TenancySubject): Promise<TenancyUserRef> {
  try {
    return await users.upsertAndLock(subject);
  } catch (err) {
    if (err instanceof TenancyUserVanishedError)
      throw new AppError(CoreErrors.CONFLICT, { detail: 'This account is being deleted.', expected: true });
    throw err;
  }
}
```
`src/modules/tenancy/application/invite-role.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { assertCanBind, type Actor } from '../domain/escalation.js';
import { TenancyErrors } from '../errors.js';
import type { MemberRow } from '../ports/member-repository.js';
import { RoleRepository, type RoleRow } from '../ports/role-repository.js';
import { RolePermissions } from './authz/role-permissions.js';
import { EscalationGuard } from './escalation-guard.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

export const actorOfMember = (m: MemberRow, permissions: ReadonlySet<string>): Actor => ({
  memberRef: m.publicId,
  isOwner: m.systemKey === 'OWNER',
  permissions,
});

/**
 * Spec §8.4 đường (b), (c) lúc TẠO lời mời/link (dưới khoá org, actor đã đọc lại `FOR SHARE`): role phải thuộc org
 * (`422`), không bao giờ là OWNER (`422 owner_not_invitable`, S3-P5 — kể cả với owner; trigger `*_role_not_owner` là
 * lớp chặn cuối), và qua `assertCanBind` (luật 2, 2a theo tập, key orphan chỉ owner gán được).
 */
@Injectable()
export class InviteRole {
  constructor(
    private readonly roles: RoleRepository,
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly escalation: EscalationGuard,
  ) {}

  async bindable(rolePublicId: string, actor: Actor): Promise<RoleRow> {
    const role = await this.roles.findByPublicId(rolePublicId);
    if (!role)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [{ path: 'roleId', code: 'not_found', message: 'roleId is not a role of this organization' }],
      });
    if (role.systemKey === 'OWNER') throw new AppError(TenancyErrors.OWNER_NOT_INVITABLE);
    const detail = await this.rolePermissions.detailOf(role);
    this.escalation.enforce(
      assertCanBind(actor, { systemKey: role.systemKey, permissions: new Set(detail.granted), orphans: detail.orphans }, this.registry.merged()),
    );
    return role;
  }
}
```
`src/modules/tenancy/http/token-preview.bucket.ts`:
```ts
import { type FactoryProvider, Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { RateLimitBuckets, clientIpTracker, type RateLimitBucket } from '../../../core/http/index.js';
import { tenancyConfig } from '../tenancy.config.js';

/** Token của handle bucket `tenancy.token-preview` (một instance mỗi app; đăng ký ở provider singleton, review C1 của 3A). */
export const TOKEN_PREVIEW_BUCKET = Symbol('tenancy.token-preview');
export const tokenPreviewBucketProvider: FactoryProvider<RateLimitBucket> = {
  provide: TOKEN_PREVIEW_BUCKET,
  inject: [RateLimitBuckets, tenancyConfig.KEY],
  useFactory: (buckets: RateLimitBuckets, cfg: ConfigOf<typeof tenancyConfig>): RateLimitBucket =>
    buckets.register({ owner: 'tenancy', name: 'token-preview', ttlMs: cfg.tokenPreviewTtlMs, limit: cfg.tokenPreviewLimit, refundable: false }),
};

/**
 * Spec §7.2 (INT-I8): hai route preview là public nên giới hạn theo IP (`clientIpTracker`, cùng khoá IP với throttler;
 * khoá IP cả khi request có principal), mỗi lần preview đếm một lượt. Token 256 bit nên bucket chống tải DB/quét, không
 * phải chống đoán. Redis lỗi → storage rơi sang insurance trong process (SP1), chỉ lỗi cả hai mới `503`.
 */
@Injectable()
export class TokenPreviewLimiter {
  constructor(@Inject(TOKEN_PREVIEW_BUCKET) private readonly bucket: RateLimitBucket) {}

  async consume(ip: unknown): Promise<void> {
    const d = await this.bucket.consume(clientIpTracker(ip));
    if (d.blocked)
      throw new AppError(CoreErrors.RATE_LIMITED, { headers: { 'Retry-After': String(d.retryAfterSec) }, expected: true });
  }
}
```

- [ ] **Step 4: `InvitationService`**

Run: `pnpm exec nest g service modules/tenancy/application/invitation --flat --no-spec --skip-import`
Expected: `src/modules/tenancy/application/invitation.service.ts`. Thay toàn bộ nội dung:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { OrgScope, UnitOfWork, pgFields } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { AuthFacts, IdentityDirectory, IdentityErrors, identityConfig } from '../../identity/index.js';
import { DISPLAY_NAME_MAX, EmailNotifications } from '../../notifications/index.js';
import { newAcquisitionToken, tokenHashHex, tokenUrl } from '../domain/acquisition-token.js';
import { oneLine, roleLabelOf } from '../domain/display-text.js';
import { isLapsed } from '../domain/expiry.js';
import { effectiveInvitationStatus, type InvitationStatus } from '../domain/invitation.js';
import { TenancyErrors } from '../errors.js';
import { InvitationAcceptedEvent, InvitationCreatedEvent, InvitationInvalidatedEvent, InvitationRevokedEvent } from '../events.js';
import { InvitationRepository, type InvitationRow } from '../ports/invitation-repository.js';
import { MemberRepository, type MemberRow } from '../ports/member-repository.js';
import { OrgRepository, type OrgRow } from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { GrantorRecheck } from './grantor-recheck.js';
import { InviteRole, actorOfMember } from './invite-role.js';
import { MemberAdmission } from './member-admission.js';
import { MemberService, type MemberView } from './member.service.js';
import { SubjectResolver } from './subject-resolver.js';
import { TenancyFeatures } from './tenancy-features.js';
import { TenancyMetrics } from './tenancy-metrics.js';
import { lockAdmittedUser } from './tenancy-user-lock.js';

export type TokenPreview = { orgName: string; roleName: string; expiresAt: Date };
type AcceptOutcome = { kind: 'ACCEPTED'; member: MemberRow } | { kind: 'NOT_FOUND' } | { kind: 'INVALIDATED' };
const INVITATIONS_WRITE = 'invitations.write';
const ALREADY_MEMBER_CONSTRAINT = 'org_members_org_user_uq';

/** PENDING luôn có role (`org_invitations_pending_role_ck`); thiếu là lỗi lập trình, không phải 404. */
function pendingRole(i: InvitationRow): { id: string; publicId: string } {
  if (i.roleId === null || i.rolePublicId === null) throw new Error('a PENDING invitation without a role (org_invitations_pending_role_ck)');
  return { id: i.roleId, publicId: i.rolePublicId };
}
const notFound = () => new AppError(TenancyErrors.INVITATION_NOT_FOUND, { expected: true });

/**
 * Lời mời email (spec SP3 §9.1, §8.4 đường b). Route có org chạy trong OrgScope của interceptor; route cầm token
 * (preview, accept) tra hàm definer theo hash rồi tự vào `OrgScope(orgId)`. Mọi ghi trong MỘT transaction theo thứ tự
 * khoá §8.6: org → tenancy_users → lời mời → member `FOR SHARE`. Kết cục phải COMMIT rồi mới báo lỗi (hết hạn → EXPIRED,
 * kiểm lại không đạt → INVALIDATED) trả về dạng kết quả và ném SAU `uow.run`.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly facts: AuthFacts,
    private readonly subjects: SubjectResolver,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly members: MemberRepository,
    private readonly invitations: InvitationRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly inviteRole: InviteRole,
    private readonly grantor: GrantorRecheck,
    private readonly admission: MemberAdmission,
    private readonly memberViews: MemberService,
    private readonly emails: EmailNotifications,
    private readonly events: EventPublisher,
    private readonly features: TenancyFeatures,
    private readonly metrics: TenancyMetrics,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
    @Inject(identityConfig.KEY) private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  /** `status` là trạng thái hiệu lực (PENDING quá hạn → EXPIRED) theo giờ DB đọc một lần mỗi request. */
  async list(q: { page: number; pageSize: number; cap: number }): Promise<{ rows: (InvitationRow & { status: InvitationStatus })[]; total: number }> {
    const now = await this.orgs.clockNow();
    const [rows, total] = await Promise.all([
      this.invitations.list({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      this.invitations.countUpTo(q.cap),
    ]);
    return { rows: rows.map((r) => ({ ...r, status: effectiveInvitationStatus(r, now) })), total };
  }

  async create(input: { email: string; roleId: string }): Promise<InvitationRow> {
    this.features.require('emailInvitations');
    const acceptBase = this.cfg.invitationAcceptUrl;
    if (acceptBase === undefined) throw new Error('email invitations are enabled without TENANCY_INVITATION_ACCEPT_URL');
    await this.hooks.afterGuard();
    const inviterName = await this.inviterName(); // spec §9.1 bước 2: I/O ngoài (pool auth) TRƯỚC transaction
    return this.uow.run(async () => {
      const org = await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([INVITATIONS_WRITE]);
      const role = await this.inviteRole.bindable(input.roleId, actorOfMember(actor, permissions));
      // T-11: đếm dưới khoá org (mọi đường tạo lời mời đều khoá org trước), theo `clock_timestamp()` sau khoá.
      if ((await this.invitations.countOpen()) >= this.cfg.maxPendingInvitationsPerOrg) throw new AppError(TenancyErrors.PENDING_INVITATIONS_LIMIT);
      await this.invitations.expireLapsedForEmail(input.email); // giải phóng `pending_email_uq` (T-4 còn lại do partial UNIQUE)
      const token = newAcquisitionToken();
      const inv = await this.invitations.insert({
        email: input.email,
        roleId: role.id,
        inviterMemberId: actor.id,
        tokenHashHex: token.hashHex,
        ttlSec: this.cfg.invitationTtlSec,
      });
      // Cùng transaction (`uow.run` lồng nhau dùng lại transaction): thư và lời mời cùng commit hoặc cùng mất.
      await this.emails.request({
        template: 'org-invitation',
        to: inv.email,
        params: {
          orgName: oneLine(org.name, DISPLAY_NAME_MAX),
          inviterName: inviterName === null ? null : oneLine(inviterName, DISPLAY_NAME_MAX),
          roleName: oneLine(roleLabelOf(role), DISPLAY_NAME_MAX),
          acceptUrl: tokenUrl(acceptBase, token.token),
          expiresAt: inv.expiresAt.toISOString(),
        },
        idempotencyKey: `org-invitation:${inv.publicId}`,
      });
      await this.events.publish(InvitationCreatedEvent, {
        data: { invitationId: inv.publicId, roleId: role.publicId },
        aggregate: { type: 'invitation', id: inv.publicId, version: inv.version },
        actor: userActor(this.ctx),
      });
      return inv;
    });
  }

  /** CAS PENDING → REVOKED (T-21). PENDING quá hạn: ghi EXPIRED (chạm sau hạn, không event) rồi `409` SAU commit. */
  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    const outcome = await this.uow.run(async (): Promise<'REVOKED' | 'NOT_PENDING'> => {
      await this.lockActiveOrg();
      await this.reauth.require([INVITATIONS_WRITE]);
      const inv = await this.invitations.lockByPublicId(publicId);
      if (!inv) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
      if (inv.status !== 'PENDING') return 'NOT_PENDING';
      if (isLapsed(inv.expiresAt, await this.orgs.clockNow())) {
        await this.invitations.resolve(inv.id, 'EXPIRED');
        return 'NOT_PENDING';
      }
      const role = pendingRole(inv);
      const done = await this.invitations.resolve(inv.id, 'REVOKED');
      if (!done) throw new Error('a locked PENDING invitation was no longer PENDING');
      await this.events.publish(InvitationRevokedEvent, {
        data: { invitationId: done.publicId, roleId: role.publicId },
        aggregate: { type: 'invitation', id: done.publicId, version: done.version },
        actor: userActor(this.ctx),
      });
      return 'REVOKED';
    });
    if (outcome === 'NOT_PENDING') throw new AppError(TenancyErrors.INVITATION_NOT_PENDING);
  }

  /** Spec §9.1 "Xem trước": mọi trạng thái khác PENDING hiệu lực, org xoá mềm, không tìm thấy → CÙNG một 404. */
  async preview(token: string): Promise<TokenPreview> {
    const match = await this.invitations.findByTokenHash(tokenHashHex(token));
    if (!match) throw notFound();
    const view = await this.scope.run(match.orgId, () =>
      this.uow.run(async (): Promise<TokenPreview | undefined> => {
        const org = await this.orgs.readCurrent();
        if (!org || org.deletedAt) return undefined;
        const inv = await this.invitations.findById(match.id);
        if (!inv || effectiveInvitationStatus(inv, await this.orgs.clockNow()) !== 'PENDING') return undefined;
        return { orgName: org.name, roleName: roleLabelOf({ systemKey: inv.roleSystemKey, name: inv.roleName }), expiresAt: inv.expiresAt };
      }),
    );
    if (!view) throw notFound();
    return view;
  }

  async accept(token: string): Promise<{ orgId: string; member: MemberView }> {
    const { orgId, member } = await tenancySpan(
      'tenancy.invitation.accept',
      () => this.acceptOnce(token),
      () => ({ 'tenancy.acquisition.result': 'accepted' }),
    );
    // Sau commit: hồ sơ hiển thị qua directory (I/O ngoài, không trong transaction).
    return { orgId, member: await this.scope.run(orgId, () => this.memberViews.get(member.publicId)) };
  }

  private async acceptOnce(token: string): Promise<{ orgId: string; member: MemberRow }> {
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    // Spec §9.1 bước 1: local/hybrid = email đã xác thực của user; external = claim email khi claim verified === true.
    const verified = this.facts.verifiedEmail();
    if (verified === undefined) throw new AppError(IdentityErrors.EMAIL_NOT_VERIFIED);
    const match = await this.invitations.findByTokenHash(tokenHashHex(token));
    if (!match) {
      this.metrics.invitations.add(1, { result: 'not_found' });
      throw notFound();
    }
    const subject = this.subjects.of(principal);
    const actor = userActor(this.ctx);
    let outcome: AcceptOutcome;
    try {
      outcome = await this.scope.run(match.orgId, () =>
        this.uow.run(async (): Promise<AcceptOutcome> => {
          const org = await this.orgs.lockCurrent();
          if (!org || org.deletedAt) return { kind: 'NOT_FOUND' }; // T-27: xoá mềm thắng thì lời mời đã REVOKED
          const user = await lockAdmittedUser(this.users, subject);
          const inv = await this.invitations.lockById(match.id);
          if (!inv || inv.status !== 'PENDING') return { kind: 'NOT_FOUND' };
          if (inv.email !== verified) {
            this.metrics.invitations.add(1, { result: 'email_mismatch' });
            throw new AppError(TenancyErrors.INVITATION_EMAIL_MISMATCH); // rollback: lời mời giữ PENDING, không nêu email
          }
          if (isLapsed(inv.expiresAt, await this.orgs.clockNow())) {
            await this.invitations.resolve(inv.id, 'EXPIRED'); // §3.15: so SAU khi có khoá; commit rồi 404
            return { kind: 'NOT_FOUND' };
          }
          const ref = pendingRole(inv);
          const check = await this.grantor.check(inv.inviterMemberId, { id: ref.id, systemKey: inv.roleSystemKey });
          if (!check.ok) {
            const done = await this.invitations.resolve(inv.id, 'INVALIDATED');
            if (!done) throw new Error('a locked PENDING invitation was no longer PENDING');
            await this.events.publish(InvitationInvalidatedEvent, {
              data: { invitationId: done.publicId, roleId: ref.publicId, reason: check.reason },
              aggregate: { type: 'invitation', id: done.publicId, version: done.version },
              actor,
            });
            return { kind: 'INVALIDATED' };
          }
          const role = await this.roles.findByPublicId(ref.publicId);
          if (!role) throw new Error('the role of a PENDING invitation vanished under the org lock');
          const member = await this.admission.admit({ user, role, actor, admission: { source: 'INVITATION', invitationId: inv.publicId } });
          // T-2: CAS cuối cùng; 0 dòng (hết hạn giữa lần đọc giờ và câu này) → ném để rollback cả membership.
          const accepted = await this.invitations.accept(inv.id, member.id);
          if (!accepted) {
            this.metrics.invitations.add(1, { result: 'not_found' });
            throw notFound();
          }
          await this.events.publish(InvitationAcceptedEvent, {
            data: { invitationId: accepted.publicId, roleId: role.publicId, memberId: member.publicId },
            aggregate: { type: 'invitation', id: accepted.publicId, version: accepted.version },
            actor,
          });
          return { kind: 'ACCEPTED', member };
        }),
      );
    } catch (err) {
      // T-3: `UNIQUE (org_id, user_id)` → 409 already_member qua constraint map; lời mời giữ PENDING (rollback).
      if (pgFields(err)?.constraint === ALREADY_MEMBER_CONSTRAINT) this.metrics.invitations.add(1, { result: 'already_member' });
      throw err;
    }
    switch (outcome.kind) {
      case 'ACCEPTED':
        this.metrics.invitations.add(1, { result: 'accepted' });
        return { orgId: match.orgId, member: outcome.member };
      case 'NOT_FOUND':
        this.metrics.invitations.add(1, { result: 'not_found' });
        throw notFound();
      case 'INVALIDATED':
        this.metrics.invitations.add(1, { result: 'invalidated' });
        throw new AppError(TenancyErrors.INVITATION_INVALIDATED);
      default: {
        const unknown: never = outcome;
        throw new Error(`unknown accept outcome ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async lockActiveOrg(): Promise<OrgRow> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
    return org;
  }

  /** Local/hybrid: tên người mời qua directory; external: `null` (không có directory, template cho phép; spec §5.2, §11). */
  private async inviterName(): Promise<string | null> {
    if (this.identity.mode === 'external' || !this.directory) return null;
    const ref = this.ctx.orgAccess()?.ref;
    const me = ref === undefined ? undefined : await this.members.findByPublicId(ref);
    if (!me?.authUserId) return null;
    return (await this.directory.findUser(me.authUserId))?.name ?? null;
  }
}
```
(Attribute span chỉ là enum; lỗi được `tenancySpan` ghi tên lớp + mã `AppError`, không token/email — spec §16.)

- [ ] **Step 5: Controller, module, route thu hẹp**

Run:
```bash
pnpm exec nest g controller modules/tenancy/http/invitations --flat --no-spec --skip-import
pnpm exec nest g controller modules/tenancy/http/invitation-tokens --flat --no-spec --skip-import
```
`src/modules/tenancy/http/invitations.controller.ts` (thay toàn bộ):
```ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, Paginator, paginationConfig, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { InvitationService } from '../application/invitation.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { NarrowingTenancyAction, SensitiveTenancyAction } from './decorators.js';
import { CreateInvitationBody, InvitationResponse, ListAcquisitionPage, invitationOf, publicIdOrNotFound } from './schemas.js';

/** Spec SP3 §12: lời mời của org; org lấy từ context, không từ param. */
@Controller('v1/orgs/:orgId/invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY) private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @TenancyPermissions.require('invitations.read')
  @ApiOk(InvitationResponse)
  async list(@Query({ schema: ListAcquisitionPage }) page: z.infer<typeof ListAcquisitionPage>) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=createdAt (ascending) is supported.' });
    const { rows, total } = await this.invitations.list({ page: page.page, pageSize: page.pageSize, cap: this.pagination.totalCountCap });
    return this.pages.offset(rows.map((i) => serialize(InvitationResponse, invitationOf(i))), page, total);
  }

  @Post()
  @TenancyPermissions.require('invitations.write')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(InvitationResponse)
  @ApiProblems(
    TenancyErrors.FEATURE_DISABLED,
    TenancyErrors.OWNER_NOT_INVITABLE,
    TenancyErrors.OWNER_ONLY,
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.PENDING_INVITATIONS_LIMIT,
    TenancyErrors.INVITATION_PENDING_EXISTS,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(@Body({ schema: CreateInvitationBody }) body: z.infer<typeof CreateInvitationBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const inv = await this.invitations.create({ email: body.email, roleId: body.roleId.toLowerCase() });
    const orgId = this.ctx.orgId();
    if (orgId === undefined) throw new Error('InvitationsController.create ran without an org context');
    // Spec §12 không có GET một lời mời: `Location` là URL định danh resource (đích của DELETE).
    setLocation(res, `/v1/orgs/${orgId}/invitations/${inv.publicId}`);
    return serialize(InvitationResponse, invitationOf({ ...inv, status: 'PENDING' }));
  }

  @Delete(':invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('invitations.write')
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.INVITATION_NOT_PENDING)
  async revoke(@Param('invitationId') invitationId: string): Promise<void> {
    await this.invitations.revoke(publicIdOrNotFound(invitationId));
  }
}
```
`src/modules/tenancy/http/invitation-tokens.controller.ts` (thay toàn bộ):
```ts
import { Body, Controller, HttpCode, HttpStatus, Ip, Post, Res } from '@nestjs/common';
import type { z } from 'zod';
import { CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, PublicRoute, etagOf, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { IdentityErrors } from '../../identity/index.js';
import { InvitationService } from '../application/invitation.service.js';
import { TenancyErrors } from '../errors.js';
import { SensitiveTenancyAction } from './decorators.js';
import { MemberResponse, TokenBody, TokenPreviewResponse, memberOf, tokenPreviewOf } from './schemas.js';
import { TokenPreviewLimiter } from './token-preview.bucket.js';

/**
 * Route cầm token (spec SP3 §7.2): ngoài path org (matcher: `OTHER`, không OrgContextMiddleware/PoliciesGuard/
 * OrgScopeInterceptor); service tra hàm definer theo hash rồi tự vào OrgScope. Token chỉ ở body, không ở URL.
 */
@Controller('v1/invitations')
export class InvitationTokensController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly limiter: TokenPreviewLimiter,
  ) {}

  /** Public, chỉ đọc (allowlist `MARKER_EXEMPT_ROUTES`); `POST` chỉ để token không vào URL/log truy cập. */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @PublicRoute()
  @ApiOk(TokenPreviewResponse)
  @ApiProblems(TenancyErrors.INVITATION_NOT_FOUND, CoreErrors.RATE_LIMITED, CoreErrors.VALIDATION_FAILED)
  async preview(@Ip() ip: string, @Body({ schema: TokenBody }) body: z.infer<typeof TokenBody>) {
    await this.limiter.consume(ip);
    return serialize(TokenPreviewResponse, tokenPreviewOf(await this.invitations.preview(body.token)));
  }

  @Post('accept')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(MemberResponse)
  @ApiProblems(
    TenancyErrors.INVITATION_NOT_FOUND,
    TenancyErrors.INVITATION_EMAIL_MISMATCH,
    TenancyErrors.INVITATION_INVALIDATED,
    TenancyErrors.ALREADY_MEMBER,
    TenancyErrors.ALREADY_IN_AN_ORG,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    CoreErrors.VALIDATION_FAILED,
  )
  async accept(@Body({ schema: TokenBody }) body: z.infer<typeof TokenBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const { orgId, member } = await this.invitations.accept(body.token);
    setLocation(res, `/v1/orgs/${orgId}/members/${member.publicId}`);
    res.setHeader('ETag', etagOf(member.version));
    return serialize(MemberResponse, memberOf(member));
  }
}
```
`src/modules/tenancy/http/policy-metadata.ts` — `NARROWING_ROUTES`:
```ts
export const NARROWING_ROUTES: readonly string[] = [
  'DELETE v1/orgs/:orgId/members/me',
  'DELETE v1/orgs/:orgId/invitations/:invitationId',
];
```
`src/modules/tenancy/http/tenancy-http.module.ts` — thêm `InvitationsController`, `InvitationTokensController` vào `controllers`; thêm `tokenPreviewBucketProvider`, `TokenPreviewLimiter`, `InviteRole`, `InvitationService` vào `providers` (import từ `./token-preview.bucket.js`, `../application/invite-role.js`, `../application/invitation.service.js`, `./invitations.controller.js`, `./invitation-tokens.controller.js`). `InvitationService` cần `EmailNotifications` (global của `NotificationsModule.forApi()`), `AuthFacts` (identity, như `OrgService`), `GrantorRecheck`, `MemberAdmission` (export của `TenancyCoreModule`, Task 8).

- [ ] **Step 6: Ma trận route × role (G-6) và bảng route thu hẹp nhận route lời mời**

`test/e2e/tenancy/role-route-matrix.e2e.spec.ts`:
1. Thêm import `seedInvitation` vào khối import của `../../support/tenancy-seed.js`.
2. Sau `ROUTES_3B` thêm:
```ts
/** Route tenant của 3C (spec §12); Task 10, 11 nối thêm. */
const ROUTES_3C = [
  'GET v1/orgs/:orgId/invitations',
  'POST v1/orgs/:orgId/invitations',
  'DELETE v1/orgs/:orgId/invitations/:invitationId',
];
/** Người gọi và status thành công của mỗi route thu hẹp với session CŨ (SEC3-2): rời org là member; thu hồi cần quyền. */
const NARROWING: Record<string, { as: (c: Cast) => SeededPrincipal; status: number }> = {
  'DELETE v1/orgs/:orgId/members/me': { as: (c) => c.as.MEMBER, status: 204 },
  'DELETE v1/orgs/:orgId/invitations/:invitationId': { as: (c) => c.as.OWNER, status: 204 },
};
```
3. Kiểu `Cast` thêm `targetP: SeededPrincipal; invitation: string;`. Trong `cast`, thay
```ts
    const target = await seedMember(org, 'MEMBER', {
      authUserId: (await seedP()).authUserId,
    });
```
bằng
```ts
    const targetP = await seedP(opts);
    const target = await seedMember(org, 'MEMBER', { authUserId: targetP.authUserId });
```
và trước `return` thêm
```ts
    const invitation = await seedInvitation(org, { email: `matrix-${v7()}@example.test`, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
```
rồi object trả về thêm `targetP, invitation: invitation.publicId`.
4. Trong `call`, chuỗi `.replace(':roleId', c.role)` nối thêm `.replace(':invitationId', c.invitation)`; trong biểu thức `body` thêm nhánh trước `: {}`:
```ts
              : route.id === 'POST v1/orgs/:orgId/invitations'
                ? { email: `matrix-${v7()}@example.test`, roleId: c.org.roles.MEMBER.publicId }
```
5. Ca bảng route: tên thành `'the tenant route table of 3A, 3B and 3C is exactly the one in the spec'` và so với `[...ROUTES_3A, ...ROUTES_3B, ...ROUTES_3C].sort()`.
6. Thay thân ca `every narrowing route succeeds with a stale session …` bằng:
```ts
    const narrowing = routes.filter((r) => r.narrowing);
    expect(narrowing.map((r) => r.id).sort()).toEqual(Object.keys(NARROWING).sort());
    for (const route of narrowing) {
      const n = NARROWING[route.id];
      if (!n) throw new Error(`no caller for narrowing route ${route.id}`);
      const c = await cast({ sessionAgeSec: STALE_SEC });
      expect((await call(route, c, n.as(c))).status, route.id).toBe(n.status);
    }
```

- [ ] **Step 7: Chạy, OpenAPI, commit**

Run:
```bash
pnpm typecheck && pnpm arch
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm vitest run --project integration test/e2e/tenancy/invitations.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/tenancy-http-boot.e2e.spec.ts
pnpm build && pnpm openapi:export && git diff --stat openapi.json
```
Expected: PASS; inventory boot xanh (route ghi lời mời mang đúng một marker; hai route preview ở `MARKER_EXEMPT_ROUTES`; `NARROWING_ROUTES` khớp); G-6 cho ba route lời mời (MEMBER, C1 → `403 forbidden`; OWNER, ADMIN qua guard); bảng nhạy cảm gồm `POST …/invitations` (session cũ → `403 reauthentication_required`); `openapi.json` thêm năm operation (oasdiff chỉ thêm).
```bash
pnpm exec prettier --write src/modules/tenancy test/support/tenancy-acquisition.ts test/e2e/tenancy test/unit/modules/tenancy
git add src/modules/tenancy test/support/tenancy-acquisition.ts test/e2e/tenancy test/unit/modules/tenancy/display-text.spec.ts openapi.json
git commit -m "feat(tenancy): email invitations — create, list, revoke, token preview behind tenancy.token-preview and accept with the inviter recheck"
```

---

### Task 10: Invite link — `InviteLinkService`, năm route link; Review Focus 4, tiêu chí 7 (tuần tự), B-11, B-14, B-22/B-23 (phần link)

**Files:**
- Create: `src/modules/tenancy/application/invite-link.service.ts` (qua CLI), `src/modules/tenancy/http/invite-links.controller.ts`, `src/modules/tenancy/http/invite-link-tokens.controller.ts` (qua CLI), `test/e2e/tenancy/invite-links.e2e.spec.ts`, `test/e2e/tenancy/token-preview-limiter.e2e.spec.ts`
- Modify: `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/policy-metadata.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `test/e2e/tenancy/role-route-matrix.e2e.spec.ts`, `openapi.json`

**Interfaces:**
- Consumes: `InviteLinkRepository`, `InviteLinkRow` (Task 7), `inviteLinkStatusOf`, `INVITE_LINK_STATUSES` (Task 6), `InviteLinkCreatedEvent`, `InviteLinkRevokedEvent`, `TenancyMetrics.inviteLinkJoins` (Task 7), `GrantorRecheck`, `MemberAdmission` (Task 8), `InviteRole`, `actorOfMember`, `lockAdmittedUser`, `TokenPreviewLimiter`, `type TokenPreview`, `roleLabelOf`, `publicIdOrNotFound`, `RoleRefResponse`, `roleRefOf`, `TokenBody`, `TokenPreviewResponse`, `tokenPreviewOf`, `ListAcquisitionPage` (Task 9), `TenancyFeatures.require('inviteLinks')`, `cfg.inviteLinkJoinUrl`, `cfg.inviteLinkMaxTtlSec`, `cfg.inviteLinkMaxUsesLimit`, `cfg.maxActiveInviteLinksPerOrg` (Task 5); test: `seedInviteLink`, `joinInviteLink`, `previewToken`, `problemCore`.
- Produces:
  - `InviteLinkService.list({ page, pageSize, cap })` (`status` suy ra), `.create({ roleId, maxUses, expiresAt })` → `{ link: InviteLinkRow; url: string }`, `.revoke(publicId): Promise<void>` (đã thu hồi → `204` không event), `.preview(token): Promise<TokenPreview>`, `.join(token): Promise<{ orgId: string; member: MemberView }>`.
  - Schema: `InviteLinkResponse`, `inviteLinkOf(l)`, `CreatedInviteLinkResponse` (`+ url`), `CreateInviteLinkBody`.
  - Route: `GET /v1/orgs/:orgId/invite-links` (`invitations.read`), `POST /v1/orgs/:orgId/invite-links` (`invitations.write`, `@SensitiveTenancyAction()`, **không** `@Idempotent()`, `201` + `Location` + `Cache-Control: no-store`), `DELETE /v1/orgs/:orgId/invite-links/:linkId` (`invitations.write`, `@NarrowingTenancyAction()`, `204`), `POST /v1/invite-links/preview` (`@PublicRoute()`), `POST /v1/invite-links/join` (`@SensitiveTenancyAction()`, `@Idempotent()`, `201`).
  - `NARROWING_ROUTES` thêm `'DELETE v1/orgs/:orgId/invite-links/:linkId'`.

- [ ] **Step 1: Schema và e2e (fail)**

`src/modules/tenancy/http/schemas.ts` — thêm import `INVITE_LINK_STATUSES`, `type InviteLinkStatus` từ `../domain/invite-link.js`, `type InviteLinkRow` từ `../ports/invite-link-repository.js`, rồi:
```ts
export const InviteLinkResponse = z.object({
  id: z.uuid(),
  role: RoleRefResponse.nullable(),
  maxUses: z.number().int(),
  useCount: z.number().int(),
  status: z.enum(INVITE_LINK_STATUSES),
  expiresAt: iso,
  revokedAt: iso.nullable(),
  createdAt: iso,
});
export const inviteLinkOf = (l: InviteLinkRow & { status: InviteLinkStatus }): z.infer<typeof InviteLinkResponse> => ({
  id: l.publicId,
  role: roleRefOf(l),
  maxUses: l.maxUses,
  useCount: l.useCount,
  status: l.status,
  expiresAt: l.expiresAt.toISOString(),
  revokedAt: l.revokedAt?.toISOString() ?? null,
  createdAt: l.createdAt.toISOString(),
});
/** `url` (chứa token ở fragment) chỉ có ở response 201 này, đúng một lần (S3-A8). */
export const CreatedInviteLinkResponse = InviteLinkResponse.extend({ url: z.url() });
/** `maxUses` ≥ 1 ở đây; trần `TENANCY_INVITE_LINK_MAX_USES_LIMIT` và biên của `expiresAt` kiểm ở service (đọc config, giờ DB). */
export const CreateInviteLinkBody = z.object({ roleId: z.uuid(), maxUses: z.number().int().min(1), expiresAt: z.iso.datetime() }).strict();
```

`test/e2e/tenancy/invite-links.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { joinInviteLink, previewToken, problemCore } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  adminKeys,
  inOrgTx,
  newToken,
  seedCustomRole,
  seedInviteLink,
  seedMember,
  seedMemberInRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import { PayrollPermissionsModule, installPayrollPermission, removePayrollPermission } from './fixtures/payroll-permissions.js';

const MAX_TTL_SEC = 86_400;
const MAX_USES_LIMIT = 50;
const ACTIVE_CAP = 2;

describe('invite links (spec SP3 §9.2, §12; §18.3 B-11, B-14, B-22/B-23; Review Focus 4)', () => {
  let app: INestApplication;
  let ADMIN_KEYS: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId }, name: 'Linkco' });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const vPrime = await seedCustomRole(org, { permissions: ADMIN_KEYS, name: `V' ${v7()}` });
    const x = await seedCustomRole(org, { permissions: [...ADMIN_KEYS, 'payroll.read'], name: `X ${v7()}` });
    const Xp = await seedP();
    await seedMemberInRole(org, x, { authUserId: Xp.authUserId });
    return { org, O, A, aMemberId: a.memberId, vPrime, Xp };
  };
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const create = (p: SeededPrincipal, org: SeededOrg, body: object) => authed(app, p).post(`/v1/orgs/${org.orgId}/invite-links`).send(body);
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) => withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id', [aggregateId]);
  const tokenOf = (url: string) => {
    const t = /#token=([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
    if (!t) throw new Error('invite link url without #token=');
    return t;
  };

  beforeAll(async () => {
    await installPayrollPermission();
    app = await startTenancyApp({
      extraImports: [PayrollPermissionsModule],
      env: {
        HTTP_TRUST_PROXY: 'loopback',
        TENANCY_INVITE_LINK_MAX_TTL_SEC: String(MAX_TTL_SEC),
        TENANCY_INVITE_LINK_MAX_USES_LIMIT: String(MAX_USES_LIMIT),
        TENANCY_MAX_ACTIVE_INVITE_LINKS_PER_ORG: String(ACTIVE_CAP),
      },
    });
    ADMIN_KEYS = adminKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    await removePayrollPermission();
    vi.unstubAllEnvs();
  });

  it('create → 201 with the url exactly once (no-store, never in the list); preview; join → 201 member; one event each', async () => {
    const c = await cast();
    const r = await create(c.A, c.org, { roleId: c.org.roles.MEMBER.publicId, maxUses: 3, expiresAt: inHours(2) });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.location).toBe(`/v1/orgs/${c.org.orgId}/invite-links/${r.body.id}`);
    expect(r.body).toMatchObject({ status: 'ACTIVE', maxUses: 3, useCount: 0, role: { systemKey: 'MEMBER' } });
    expect(r.body.url).toMatch(/^http:\/\/localhost:3000\/join#token=[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(r.body.url);
    const listed = await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/invite-links`);
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect((await previewToken(app, 'invite-links', { token })).body).toEqual({ orgName: 'Linkco', roleName: 'Member', expiresAt: r.body.expiresAt });
    const joiner = await seedP();
    const joined = await joinInviteLink(app, joiner, { token });
    expect(joined.status).toBe(201);
    expect(joined.headers.location).toBe(`/v1/orgs/${c.org.orgId}/members/${joined.body.id}`);
    expect((await events(r.body.id)).map((e) => e.type)).toEqual(['tenancy.invite_link.created']);
    expect((await events(joined.body.id)).map((e) => [e.payload['source'], e.payload['inviteLinkId']])).toEqual([['INVITE_LINK', r.body.id]]);
    expect((await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/invite-links`)).body.data[0]).toMatchObject({ useCount: 1, status: 'ACTIVE' });
  });
  it('Review Focus 4: link TTL and max uses at the boundaries', async () => {
    const c = await cast();
    const role = c.org.roles.MEMBER.publicId;
    for (const expiresAt of [new Date(Date.now() - 1000).toISOString(), new Date().toISOString(), new Date(Date.now() + (MAX_TTL_SEC + 60) * 1000).toISOString()])
      expect((await create(c.A, c.org, { roleId: role, maxUses: 1, expiresAt })).body.code, expiresAt).toBe('ttl_out_of_range');
    for (const maxUses of [0, -1, MAX_USES_LIMIT + 1, 1.5])
      expect((await create(c.A, c.org, { roleId: role, maxUses, expiresAt: inHours(1) })).body.code, String(maxUses)).toBe('validation_failed');
    expect((await create(c.A, c.org, { roleId: role, maxUses: MAX_USES_LIMIT, expiresAt: inHours(MAX_TTL_SEC / 3600 - 1) })).status).toBe(201);
  });
  it('Review Focus 4: an exhausted link frees a slot of the open-link cap; a second join of a maxUses=1 link is 404 and the link reads EXHAUSTED', async () => {
    const c = await cast();
    const role = c.org.roles.MEMBER.publicId;
    const one = await create(c.A, c.org, { roleId: role, maxUses: 1, expiresAt: inHours(1) });
    expect((await create(c.A, c.org, { roleId: role, maxUses: 5, expiresAt: inHours(1) })).status).toBe(201);
    expect((await create(c.A, c.org, { roleId: role, maxUses: 5, expiresAt: inHours(1) })).body.code).toBe('invite_links_limit');
    expect((await joinInviteLink(app, await seedP(), { token: tokenOf(one.body.url) })).status).toBe(201);
    const second = await joinInviteLink(app, await seedP(), { token: tokenOf(one.body.url) });
    expect([second.status, second.body.code]).toEqual([404, 'invite_link_not_found']);
    const listed = (await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/invite-links`)).body.data as { id: string; status: string }[];
    expect(listed.find((l) => l.id === one.body.id)?.status).toBe('EXHAUSTED');
    expect((await create(c.A, c.org, { roleId: role, maxUses: 5, expiresAt: inHours(1) })).status).toBe(201); // EXHAUSTED không chiếm trần
  });
  it('Review Focus 3 (links): garbage tokens are 422 or the uniform 404, never 500', async () => {
    const p = await seedP();
    for (const body of [{}, { token: '' }, { token: 'y'.repeat(10_000) }, { token: '!!' }, { token: 7 }, null] as unknown[]) {
      expect((await previewToken(app, 'invite-links', body)).status).toBe(422);
      expect((await joinInviteLink(app, p, body)).status).toBe(422);
    }
    expect((await joinInviteLink(app, p, { token: newToken() })).body.code).toBe('invite_link_not_found');
  });
  it('unknown, expired, exhausted, revoked and soft-deleted-org links give one identical 404 at preview and join', async () => {
    const c = await cast();
    const role = c.org.roles.MEMBER.id;
    const expired = await seedInviteLink(c.org, { roleId: role, createdByMemberId: c.aMemberId, expiresInSec: -60 });
    const exhausted = await seedInviteLink(c.org, { roleId: role, createdByMemberId: c.aMemberId, maxUses: 1, useCount: 1 });
    const revoked = await seedInviteLink(c.org, { roleId: role, createdByMemberId: c.aMemberId, revoked: true });
    const gone = await cast();
    const inDeleted = await seedInviteLink(gone.org, { roleId: gone.org.roles.MEMBER.id, createdByMemberId: gone.aMemberId });
    expect((await authed(app, gone.O).delete(`/v1/orgs/${gone.org.orgId}`)).status).toBe(204);
    const p = await seedP();
    const all = [];
    for (const token of [newToken(), expired.token, exhausted.token, revoked.token, inDeleted.token]) {
      all.push(await previewToken(app, 'invite-links', { token }));
      all.push(await joinInviteLink(app, p, { token }));
    }
    for (const r of all) expect(r.status).toBe(404);
    expect(new Set(all.map((r) => JSON.stringify(problemCore(r.body)))).size).toBe(1);
  });
  it('revoke: 204 + one tenancy.invite_link.revoked { REVOKED }; revoking again is a no-op 204 without a second event', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.aMemberId });
    const url = `/v1/orgs/${c.org.orgId}/invite-links/${link.publicId}`;
    expect((await authed(app, c.A).delete(url)).status).toBe(204);
    expect((await authed(app, c.A).delete(url)).status).toBe(204);
    expect((await events(link.publicId)).map((e) => [e.type, e.payload['reason']])).toEqual([['tenancy.invite_link.revoked', 'REVOKED']]);
    expect((await joinInviteLink(app, await seedP(), { token: link.token })).body.code).toBe('invite_link_not_found');
  });
  it('B-11 / B-22 / B-23 (links): OWNER never; X cannot link ADMIN or V′; ADMIN cannot link ADMIN', async () => {
    const c = await cast();
    const body = (roleId: string) => ({ roleId, maxUses: 1, expiresAt: inHours(1) });
    expect((await create(c.O, c.org, body(c.org.roles.OWNER.publicId))).body.code).toBe('owner_not_invitable');
    expect((await create(c.Xp, c.org, body(c.org.roles.ADMIN.publicId))).body.code).toBe('owner_only');
    expect((await create(c.Xp, c.org, body(c.vPrime.publicId))).body.code).toBe('owner_only');
    expect((await create(c.A, c.org, body(c.org.roles.ADMIN.publicId))).body.code).toBe('owner_only');
  });
  it('B-14: the creator was removed from the organization → join 409 invite_link_invalidated, the link is revoked with { INVALIDATED }, no membership', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.aMemberId });
    await sql(c.org, 'DELETE FROM org_members WHERE id = $1', [c.aMemberId]);
    const joiner = await seedP();
    const r = await joinInviteLink(app, joiner, { token: link.token });
    expect([r.status, r.body.code]).toEqual([409, 'invite_link_invalidated']);
    expect((await events(link.publicId)).map((e) => [e.type, e.payload['reason']])).toEqual([['tenancy.invite_link.revoked', 'INVALIDATED']]);
    expect((await sql(c.org, 'SELECT use_count, revoked_at IS NOT NULL AS revoked FROM org_invite_links WHERE id = $1', [link.id])).rows).toEqual([{ use_count: 0, revoked: true }]);
    expect((await joinInviteLink(app, joiner, { token: link.token })).body.code).toBe('invite_link_not_found');
  });
  it('joining while already a member is 409 already_member and the use count stays (rollback)', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.aMemberId, maxUses: 2 });
    expect((await joinInviteLink(app, c.A, { token: link.token })).body.code).toBe('already_member');
    expect((await sql(c.org, 'SELECT use_count FROM org_invite_links WHERE id = $1', [link.id])).rows).toEqual([{ use_count: 0 }]);
  });
});
```
`test/e2e/tenancy/token-preview-limiter.e2e.spec.ts` (file riêng: `REDIS_KEY_PREFIX` của test là theo file, nên bộ đếm không dính file khác):
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { previewIp, previewToken } from '../../support/tenancy-acquisition.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { newToken } from '../../support/tenancy-seed.js';

const LIMIT = 4;

describe('bucket tenancy.token-preview counts previews per client IP (spec SP3 §7.2, INT-I8)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  beforeAll(async () => {
    app = await startTenancyApp({ env: { HTTP_TRUST_PROXY: 'loopback', TENANCY_TOKEN_PREVIEW_RATE_LIMIT: String(LIMIT) } });
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals([p]);
    vi.unstubAllEnvs();
  });

  it('LIMIT previews from one IP pass (404 for unknown tokens), the next is 429 + Retry-After, across both preview routes and with or without a principal', async () => {
    const ip = previewIp();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const kind = i % 2 === 0 ? 'invitations' : 'invite-links';
      const req = previewToken(app, kind, { token: newToken() }, ip);
      statuses.push((i === 1 ? await req.set('authorization', `Bearer ${p.bearer}`) : await req).status);
    }
    expect(statuses).toEqual(Array(LIMIT).fill(404));
    const blocked = await previewToken(app, 'invitations', { token: newToken() }, ip);
    expect([blocked.status, blocked.body.code]).toEqual([429, 'rate_limited']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await previewToken(app, 'invitations', { token: newToken() }, previewIp())).status).toBe(404); // IP khác không bị chặn
  });
});
```

Run: `pnpm vitest run --project integration test/e2e/tenancy/invite-links.e2e.spec.ts test/e2e/tenancy/token-preview-limiter.e2e.spec.ts` → FAIL (route link chưa có).

- [ ] **Step 2: `InviteLinkService`**

Run: `pnpm exec nest g service modules/tenancy/application/invite-link --flat --no-spec --skip-import`
Thay toàn bộ `src/modules/tenancy/application/invite-link.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { OrgScope, UnitOfWork, pgFields } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { newAcquisitionToken, tokenHashHex, tokenUrl } from '../domain/acquisition-token.js';
import { roleLabelOf } from '../domain/display-text.js';
import { inviteLinkStatusOf, type InviteLinkStatus } from '../domain/invite-link.js';
import { TenancyErrors } from '../errors.js';
import { InviteLinkCreatedEvent, InviteLinkRevokedEvent } from '../events.js';
import { InviteLinkRepository, type InviteLinkRow } from '../ports/invite-link-repository.js';
import type { MemberRow } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { GrantorRecheck } from './grantor-recheck.js';
import type { TokenPreview } from './invitation.service.js';
import { InviteRole, actorOfMember } from './invite-role.js';
import { MemberAdmission } from './member-admission.js';
import { MemberService, type MemberView } from './member.service.js';
import { SubjectResolver } from './subject-resolver.js';
import { TenancyFeatures } from './tenancy-features.js';
import { TenancyMetrics } from './tenancy-metrics.js';
import { lockAdmittedUser } from './tenancy-user-lock.js';

type JoinOutcome = { kind: 'JOINED'; member: MemberRow } | { kind: 'NOT_FOUND' } | { kind: 'INVALIDATED' };
const INVITATIONS_WRITE = 'invitations.write';
const ALREADY_MEMBER_CONSTRAINT = 'org_members_org_user_uq';
const MS_PER_SEC = 1000;
const notFound = () => new AppError(TenancyErrors.INVITE_LINK_NOT_FOUND, { expected: true });
/** Link chưa thu hồi luôn có role (`org_invite_links_active_role_ck`). */
function activeRole(l: InviteLinkRow): { id: string; publicId: string } {
  if (l.roleId === null || l.rolePublicId === null) throw new Error('an unrevoked invite link without a role (org_invite_links_active_role_ck)');
  return { id: l.roleId, publicId: l.rolePublicId };
}

/**
 * Invite link dùng chung (spec SP3 §9.2, §8.4 đường c). Cùng khung với `InvitationService`: route cầm token tra hàm definer
 * rồi vào OrgScope; thứ tự khoá org → tenancy_users → link → member `FOR SHARE`; lượt dùng tăng bằng câu điều kiện atomic
 * (T-5, T-29) và rollback cùng membership khi `409 already_member`.
 * Extension point (S3-Q4 C): verified-domain auto-join — spec §19; domain join dùng lại `MemberAdmission` với nguồn `DOMAIN`.
 */
@Injectable()
export class InviteLinkService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly subjects: SubjectResolver,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly links: InviteLinkRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly inviteRole: InviteRole,
    private readonly grantor: GrantorRecheck,
    private readonly admission: MemberAdmission,
    private readonly memberViews: MemberService,
    private readonly events: EventPublisher,
    private readonly features: TenancyFeatures,
    private readonly metrics: TenancyMetrics,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async list(q: { page: number; pageSize: number; cap: number }): Promise<{ rows: (InviteLinkRow & { status: InviteLinkStatus })[]; total: number }> {
    const now = await this.orgs.clockNow();
    const [rows, total] = await Promise.all([
      this.links.list({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      this.links.countUpTo(q.cap),
    ]);
    return { rows: rows.map((l) => ({ ...l, status: inviteLinkStatusOf(l, now) })), total };
  }

  /** Không `@Idempotent()` ở route (S3-A8): retry tạo thêm một link thu hồi được, secret không vào Redis. */
  async create(input: { roleId: string; maxUses: number; expiresAt: Date }): Promise<{ link: InviteLinkRow; url: string }> {
    this.features.require('inviteLinks');
    const joinBase = this.cfg.inviteLinkJoinUrl;
    if (joinBase === undefined) throw new Error('invite links are enabled without TENANCY_INVITE_LINK_JOIN_URL');
    if (input.maxUses > this.cfg.inviteLinkMaxUsesLimit)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [{ path: 'maxUses', code: 'too_big', message: `maxUses must be at most ${this.cfg.inviteLinkMaxUsesLimit}` }],
      });
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([INVITATIONS_WRITE]);
      const role = await this.inviteRole.bindable(input.roleId, actorOfMember(actor, permissions));
      // Giờ DB sau khoá (§3.15): `expiresAt` phải sau lúc này và không quá trần; `CHECK (expires_at > created_at)` không bao giờ bắn.
      const now = await this.orgs.clockNow();
      const ms = input.expiresAt.getTime() - now.getTime();
      if (ms <= 0 || ms > this.cfg.inviteLinkMaxTtlSec * MS_PER_SEC) throw new AppError(TenancyErrors.TTL_OUT_OF_RANGE);
      if ((await this.links.countOpen()) >= this.cfg.maxActiveInviteLinksPerOrg) throw new AppError(TenancyErrors.INVITE_LINKS_LIMIT); // T-11
      const token = newAcquisitionToken();
      const link = await this.links.insert({ roleId: role.id, createdByMemberId: actor.id, tokenHashHex: token.hashHex, maxUses: input.maxUses, expiresAt: input.expiresAt });
      await this.events.publish(InviteLinkCreatedEvent, {
        data: { inviteLinkId: link.publicId, roleId: role.publicId, maxUses: link.maxUses, expiresAt: link.expiresAt.toISOString() },
        aggregate: { type: 'invite_link', id: link.publicId, version: link.version },
        actor: userActor(this.ctx),
      });
      return { link, url: tokenUrl(joinBase, token.token) };
    });
  }

  /** `revoked_at = now()` khi còn NULL + event `{ REVOKED }`; đã thu hồi → no-op (DELETE idempotent, spec §15 không có mã riêng). */
  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      await this.reauth.require([INVITATIONS_WRITE]);
      const link = await this.links.lockByPublicId(publicId);
      if (!link) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
      const done = await this.links.revoke(link.id);
      if (!done) return;
      await this.events.publish(InviteLinkRevokedEvent, {
        data: { inviteLinkId: done.publicId, reason: 'REVOKED' },
        aggregate: { type: 'invite_link', id: done.publicId, version: done.version },
        actor: userActor(this.ctx),
      });
    });
  }

  /** Spec §9.2 "Xem trước": `404 invite_link_not_found` cho mọi trạng thái khác ACTIVE. */
  async preview(token: string): Promise<TokenPreview> {
    const match = await this.links.findByTokenHash(tokenHashHex(token));
    if (!match) throw notFound();
    const view = await this.scope.run(match.orgId, () =>
      this.uow.run(async (): Promise<TokenPreview | undefined> => {
        const org = await this.orgs.readCurrent();
        if (!org || org.deletedAt) return undefined;
        const link = await this.links.findById(match.id);
        if (!link || inviteLinkStatusOf(link, await this.orgs.clockNow()) !== 'ACTIVE') return undefined;
        return { orgName: org.name, roleName: roleLabelOf({ systemKey: link.roleSystemKey, name: link.roleName }), expiresAt: link.expiresAt };
      }),
    );
    if (!view) throw notFound();
    return view;
  }

  async join(token: string): Promise<{ orgId: string; member: MemberView }> {
    const { orgId, member } = await tenancySpan('tenancy.invite_link.join', () => this.joinOnce(token), () => ({ 'tenancy.acquisition.result': 'accepted' }));
    return { orgId, member: await this.scope.run(orgId, () => this.memberViews.get(member.publicId)) };
  }

  private async joinOnce(token: string): Promise<{ orgId: string; member: MemberRow }> {
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    const match = await this.links.findByTokenHash(tokenHashHex(token));
    if (!match) {
      this.metrics.inviteLinkJoins.add(1, { result: 'not_found' });
      throw notFound();
    }
    const subject = this.subjects.of(principal);
    const actor = userActor(this.ctx);
    let outcome: JoinOutcome;
    try {
      outcome = await this.scope.run(match.orgId, () =>
        this.uow.run(async (): Promise<JoinOutcome> => {
          const org = await this.orgs.lockCurrent();
          if (!org || org.deletedAt) return { kind: 'NOT_FOUND' }; // T-27
          const user = await lockAdmittedUser(this.users, subject);
          const link = await this.links.lockById(match.id);
          if (!link || inviteLinkStatusOf(link, await this.orgs.clockNow()) !== 'ACTIVE') return { kind: 'NOT_FOUND' };
          const ref = activeRole(link);
          const check = await this.grantor.check(link.createdByMemberId, { id: ref.id, systemKey: link.roleSystemKey });
          if (!check.ok) {
            const done = await this.links.revoke(link.id);
            if (!done) throw new Error('a locked unrevoked invite link was already revoked');
            await this.events.publish(InviteLinkRevokedEvent, {
              data: { inviteLinkId: done.publicId, reason: 'INVALIDATED' },
              aggregate: { type: 'invite_link', id: done.publicId, version: done.version },
              actor,
            });
            return { kind: 'INVALIDATED' };
          }
          // T-5, T-29: câu điều kiện với `clock_timestamp()`; 0 dòng (hết lượt/hết hạn khi đang chờ khoá) → 404.
          if (!(await this.links.consumeUse(link.id))) return { kind: 'NOT_FOUND' };
          const role = await this.roles.findByPublicId(ref.publicId);
          if (!role) throw new Error('the role of an unrevoked invite link vanished under the org lock');
          const member = await this.admission.admit({ user, role, actor, admission: { source: 'INVITE_LINK', inviteLinkId: link.publicId } });
          return { kind: 'JOINED', member };
        }),
      );
    } catch (err) {
      if (pgFields(err)?.constraint === ALREADY_MEMBER_CONSTRAINT) this.metrics.inviteLinkJoins.add(1, { result: 'already_member' });
      throw err;
    }
    switch (outcome.kind) {
      case 'JOINED':
        this.metrics.inviteLinkJoins.add(1, { result: 'accepted' });
        return { orgId: match.orgId, member: outcome.member };
      case 'NOT_FOUND':
        this.metrics.inviteLinkJoins.add(1, { result: 'not_found' });
        throw notFound();
      case 'INVALIDATED':
        this.metrics.inviteLinkJoins.add(1, { result: 'invalidated' });
        throw new AppError(TenancyErrors.INVITE_LINK_INVALIDATED);
      default: {
        const unknown: never = outcome;
        throw new Error(`unknown join outcome ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
  }
}
```
- [ ] **Step 3: Controller, module, route thu hẹp**

Run:
```bash
pnpm exec nest g controller modules/tenancy/http/invite-links --flat --no-spec --skip-import
pnpm exec nest g controller modules/tenancy/http/invite-link-tokens --flat --no-spec --skip-import
```
`src/modules/tenancy/http/invite-links.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Paginator, paginationConfig, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { InviteLinkService } from '../application/invite-link.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { NarrowingTenancyAction, SensitiveTenancyAction } from './decorators.js';
import { CreateInviteLinkBody, CreatedInviteLinkResponse, InviteLinkResponse, ListAcquisitionPage, inviteLinkOf, publicIdOrNotFound } from './schemas.js';

@Controller('v1/orgs/:orgId/invite-links')
export class InviteLinksController {
  constructor(
    private readonly links: InviteLinkService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY) private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @TenancyPermissions.require('invitations.read')
  @ApiOk(InviteLinkResponse)
  async list(@Query({ schema: ListAcquisitionPage }) page: z.infer<typeof ListAcquisitionPage>) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=createdAt (ascending) is supported.' });
    const { rows, total } = await this.links.list({ page: page.page, pageSize: page.pageSize, cap: this.pagination.totalCountCap });
    return this.pages.offset(rows.map((l) => serialize(InviteLinkResponse, inviteLinkOf(l))), page, total);
  }

  /** Không `@Idempotent()` (S3-A8, amendment B9): response chứa secret và idempotency lưu body vào Redis. */
  @Post()
  @TenancyPermissions.require('invitations.write')
  @SensitiveTenancyAction()
  @ApiOk(CreatedInviteLinkResponse)
  @ApiProblems(
    TenancyErrors.FEATURE_DISABLED,
    TenancyErrors.OWNER_NOT_INVITABLE,
    TenancyErrors.OWNER_ONLY,
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.INVITE_LINKS_LIMIT,
    TenancyErrors.TTL_OUT_OF_RANGE,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(@Body({ schema: CreateInviteLinkBody }) body: z.infer<typeof CreateInviteLinkBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const { link, url } = await this.links.create({ roleId: body.roleId.toLowerCase(), maxUses: body.maxUses, expiresAt: new Date(body.expiresAt) });
    const orgId = this.ctx.orgId();
    if (orgId === undefined) throw new Error('InviteLinksController.create ran without an org context');
    setLocation(res, `/v1/orgs/${orgId}/invite-links/${link.publicId}`);
    // Secret một lần: không cache ở proxy/trình duyệt.
    res.setHeader('Cache-Control', 'no-store');
    return serialize(CreatedInviteLinkResponse, { ...inviteLinkOf({ ...link, status: 'ACTIVE' }), url });
  }

  @Delete(':linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('invitations.write')
  @NarrowingTenancyAction()
  async revoke(@Param('linkId') linkId: string): Promise<void> {
    await this.links.revoke(publicIdOrNotFound(linkId));
  }
}
```
`src/modules/tenancy/http/invite-link-tokens.controller.ts`:
```ts
import { Body, Controller, HttpCode, HttpStatus, Ip, Post, Res } from '@nestjs/common';
import type { z } from 'zod';
import { CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, PublicRoute, etagOf, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { IdentityErrors } from '../../identity/index.js';
import { InviteLinkService } from '../application/invite-link.service.js';
import { TenancyErrors } from '../errors.js';
import { SensitiveTenancyAction } from './decorators.js';
import { MemberResponse, TokenBody, TokenPreviewResponse, memberOf, tokenPreviewOf } from './schemas.js';
import { TokenPreviewLimiter } from './token-preview.bucket.js';

/** Route cầm token của invite link (spec SP3 §7.2, §9.2); link không ràng buộc email, `@RequireVerifiedEmail()` vẫn áp. */
@Controller('v1/invite-links')
export class InviteLinkTokensController {
  constructor(
    private readonly links: InviteLinkService,
    private readonly limiter: TokenPreviewLimiter,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @PublicRoute()
  @ApiOk(TokenPreviewResponse)
  @ApiProblems(TenancyErrors.INVITE_LINK_NOT_FOUND, CoreErrors.RATE_LIMITED, CoreErrors.VALIDATION_FAILED)
  async preview(@Ip() ip: string, @Body({ schema: TokenBody }) body: z.infer<typeof TokenBody>) {
    await this.limiter.consume(ip);
    return serialize(TokenPreviewResponse, tokenPreviewOf(await this.links.preview(body.token)));
  }

  @Post('join')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(MemberResponse)
  @ApiProblems(
    TenancyErrors.INVITE_LINK_NOT_FOUND,
    TenancyErrors.INVITE_LINK_INVALIDATED,
    TenancyErrors.ALREADY_MEMBER,
    TenancyErrors.ALREADY_IN_AN_ORG,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    CoreErrors.VALIDATION_FAILED,
  )
  async join(@Body({ schema: TokenBody }) body: z.infer<typeof TokenBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const { orgId, member } = await this.links.join(body.token);
    setLocation(res, `/v1/orgs/${orgId}/members/${member.publicId}`);
    res.setHeader('ETag', etagOf(member.version));
    return serialize(MemberResponse, memberOf(member));
  }
}
```
`policy-metadata.ts` — `NARROWING_ROUTES` thêm `'DELETE v1/orgs/:orgId/invite-links/:linkId'`. `tenancy-http.module.ts` — thêm hai controller và provider `InviteLinkService`.

- [ ] **Step 4: Ma trận route nhận route link**

`test/e2e/tenancy/role-route-matrix.e2e.spec.ts`: import thêm `seedInviteLink`; `ROUTES_3C` nối `'GET v1/orgs/:orgId/invite-links'`, `'POST v1/orgs/:orgId/invite-links'`, `'DELETE v1/orgs/:orgId/invite-links/:linkId'`; `NARROWING` thêm `'DELETE v1/orgs/:orgId/invite-links/:linkId': { as: (c) => c.as.OWNER, status: 204 }`; `Cast` thêm `link: string`; trong `cast` trước `return`:
```ts
    const link = await seedInviteLink(org, { roleId: org.roles.MEMBER.id, createdByMemberId: org.owner.memberId });
```
và object trả về thêm `link: link.publicId`; `call` nối `.replace(':linkId', c.link)`; `body` thêm nhánh:
```ts
              : route.id === 'POST v1/orgs/:orgId/invite-links'
                ? { roleId: c.org.roles.MEMBER.publicId, maxUses: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
```

- [ ] **Step 5: Chạy, OpenAPI, commit**

Run:
```bash
pnpm typecheck && pnpm arch
pnpm vitest run --project integration test/e2e/tenancy/invite-links.e2e.spec.ts test/e2e/tenancy/token-preview-limiter.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/invitations.e2e.spec.ts test/integration/tenancy/acquisition-repositories.spec.ts
pnpm build && pnpm openapi:export && git diff --stat openapi.json
```
Expected: PASS; limiter: `LIMIT` lần `404` từ một IP rồi `429` + `Retry-After`, IP khác `404`; `openapi.json` thêm năm operation.
```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy
git add src/modules/tenancy test/e2e/tenancy openapi.json
git commit -m "feat(tenancy): shared invite links — create once with the secret url, list, revoke, preview and join with an atomic use count and the creator recheck"
```

---

### Task 11: Chuyển quyền sở hữu — `OwnershipTransferService`, năm route; O-6, O-7, O-8, O-16, Review Focus 5

**Files:**
- Create: `src/modules/tenancy/application/ownership-transfer.service.ts` (qua CLI), `src/modules/tenancy/http/ownership-transfers.controller.ts` (qua CLI), `test/e2e/tenancy/ownership-transfers.e2e.spec.ts`
- Modify: `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/policy-metadata.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `test/e2e/tenancy/role-route-matrix.e2e.spec.ts`, `openapi.json`

**Interfaces:**
- Consumes: `OwnershipTransferRepository`, `TransferRow`, `TransferQuery` (Task 7), `effectiveTransferStatus`, `isLapsed`, `TRANSFER_STATUSES`, `STEP_DOWN_ROLES` (Task 2, 6), `transferEventData` (Task 8), `OwnershipTransfer{Requested,Accepted,Declined,Cancelled}Event` (Task 7), `TenancyMetrics.lastOwnerBlocked` với path `'transfer'` (Task 7), `cfg.ownershipTransferTtlSec` (Task 5), `oneLine`, `publicIdOrNotFound`, `ListAcquisitionPage` (Task 9); 3A: `MemberRepository.{findByPublicId, changeRole}`, `RoleRepository.list`, `MemberRoleChangedEvent`, `ActorReauthorizer.require(keys, lockAlso)`, `RolePermissions.of`, `IdentityDirectory.findUser` (`emailVerified`, `email`, `name`), `EmailNotifications.request('ownership-transfer-requested')`, `OrgMemberOnly`.
- Produces:
  - `OwnershipTransferService.list({ status?, page, pageSize, cap })` (owner — có `ownership.transfer` — thấy mọi yêu cầu; member khác chỉ yêu cầu mình là bên gửi/nhận, INT-M2), `.create({ toMemberId, stepDownTo })`, `.accept(publicId)`, `.decline(publicId)`, `.cancel(publicId)`; mọi phương thức ghi trả `TransferRow` (trừ `cancel`: `void`).
  - Schema: `OwnershipTransferResponse`, `transferOf(t)`, `CreateOwnershipTransferBody`, `TransferStatusQuery`.
  - Route: `GET /v1/orgs/:orgId/ownership-transfers` (`@OrgMemberOnly()`, `?status=`), `POST /v1/orgs/:orgId/ownership-transfers` (`ownership.transfer`, `@SensitiveTenancyAction()`, `@Idempotent()`, `201`), `POST …/:transferId/accept` (`@OrgMemberOnly()` + là `to`, `@SensitiveTenancyAction()`, `@Idempotent()`, `200`), `POST …/:transferId/decline` (`@OrgMemberOnly()` + là `to`, `@NarrowingTenancyAction()`, `@Idempotent()`, `200`), `DELETE …/:transferId` (`ownership.transfer`, `@NarrowingTenancyAction()`, `204`).
  - `NARROWING_ROUTES` thêm `'POST v1/orgs/:orgId/ownership-transfers/:transferId/decline'`, `'DELETE v1/orgs/:orgId/ownership-transfers/:transferId'`.

- [ ] **Step 1: Schema và e2e (fail)**

`src/modules/tenancy/http/schemas.ts` — thêm import `TRANSFER_STATUSES`, `type TransferStatus` từ `../domain/ownership-transfer.js`, `STEP_DOWN_ROLES` từ `../constants.js`, `type TransferRow` từ `../ports/ownership-transfer-repository.js`, rồi:
```ts
export const OwnershipTransferResponse = z.object({
  id: z.uuid(),
  fromMemberId: z.uuid().nullable(),
  toMemberId: z.uuid().nullable(),
  stepDownTo: z.enum(STEP_DOWN_ROLES).nullable(),
  status: z.enum(TRANSFER_STATUSES),
  expiresAt: iso,
  createdAt: iso,
  resolvedAt: iso.nullable(),
});
export const transferOf = (t: TransferRow & { status: TransferStatus }): z.infer<typeof OwnershipTransferResponse> => ({
  id: t.publicId,
  fromMemberId: t.fromMemberPublicId,
  toMemberId: t.toMemberPublicId,
  stepDownTo: t.stepDownTo,
  status: t.status,
  expiresAt: t.expiresAt.toISOString(),
  createdAt: t.createdAt.toISOString(),
  resolvedAt: t.resolvedAt?.toISOString() ?? null,
});
/** `stepDownTo: null` = người khởi tạo vẫn là owner (spec §6.9). */
export const CreateOwnershipTransferBody = z.object({ toMemberId: z.uuid(), stepDownTo: z.enum(STEP_DOWN_ROLES).nullable().default(null) }).strict();
export const TransferStatusQuery = z.object({ status: z.enum(TRANSFER_STATUSES).optional() });
```

`test/e2e/tenancy/ownership-transfers.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { inOrgTx, seedMember, seedOrg, seedTransfer, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

describe('ownership transfer (spec SP3 §9.3, §12; §18.3 O-6, O-7, O-8, O-16; Review Focus 5)', () => {
  let app: INestApplication;
  const mail = mailpitFromInfra();
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** O owner, A admin, M member (người nhận mặc định). */
  const cast = async (opts: { sessionAgeSec?: number } = {}) => {
    const O = await seedP(opts);
    const org = await seedOrg({ owner: { authUserId: O.authUserId }, name: 'Handover' });
    orgs.push(org);
    const A = await seedP(opts);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP(opts);
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const base = (org: SeededOrg) => `/v1/orgs/${org.orgId}/ownership-transfers`;
  const request = (p: SeededPrincipal, org: SeededOrg, body: object) =>
    authed(app, p).post(base(org)).set('idempotency-key', `k-${v7()}`).send(body);
  const act = (p: SeededPrincipal, org: SeededOrg, id: string, verb: 'accept' | 'decline') =>
    authed(app, p).post(`${base(org)}/${id}/${verb}`).set('idempotency-key', `k-${v7()}`).send({});
  const roleOf = async (org: SeededOrg, memberId: string) =>
    (await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('SELECT r.system_key FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE m.id = $1', [memberId])))).rows[0]?.system_key;
  const statusOf = async (org: SeededOrg, id: string) =>
    (await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('SELECT status FROM org_ownership_transfers WHERE public_id = $1', [id])))).rows[0]?.status;
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id', [aggregateId]);

  beforeAll(async () => {
    app = await startTenancyApp({ env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' } });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('O-6: request → mail to the recipient → accept with step_down_to=ADMIN; ≥ 1 owner throughout; events and two role_changed', async () => {
    const c = await cast();
    const after = await mail.now();
    const r = await request(c.O, c.org, { toMemberId: c.m.memberPublicId, stepDownTo: 'ADMIN' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fromMemberId: c.org.owner.memberPublicId, toMemberId: c.m.memberPublicId, stepDownTo: 'ADMIN', status: 'PENDING' });
    const msg = await mail.waitFor(c.M.email, { subject: /Ownership transfer requested for Handover/, after });
    expect(msg.Text).not.toMatch(/token/i);
    expect((await authed(app, c.M).get(`${base(c.org)}?status=PENDING`)).body.data.map((t: { id: string }) => t.id)).toEqual([r.body.id]);
    const ok = await act(c.M, c.org, r.body.id, 'accept');
    expect([ok.status, ok.body.status]).toEqual([200, 'ACCEPTED']);
    expect(await roleOf(c.org, c.m.memberId)).toBe('OWNER');
    expect(await roleOf(c.org, c.org.owner.memberId)).toBe('ADMIN');
    expect((await events(r.body.id)).map((e) => e.type)).toEqual(['tenancy.ownership_transfer.requested', 'tenancy.ownership_transfer.accepted']);
    const changed = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.role_changed' ORDER BY id`,
      [c.org.orgId],
    );
    expect(changed.map((e) => [e.payload['memberId'], e.payload['reason']])).toEqual([
      [c.m.memberPublicId, 'OWNERSHIP_TRANSFER'],
      [c.org.owner.memberPublicId, 'OWNERSHIP_TRANSFER'],
    ]);
  });
  it('without step_down_to the initiator stays an owner; a recipient who is already an owner lets the initiator step down only', async () => {
    const c = await cast();
    const r = await request(c.O, c.org, { toMemberId: c.a.memberPublicId });
    expect((await act(c.A, c.org, r.body.id, 'accept')).status).toBe(200);
    expect([await roleOf(c.org, c.a.memberId), await roleOf(c.org, c.org.owner.memberId)]).toEqual(['OWNER', 'OWNER']);
    const down = await request(c.O, c.org, { toMemberId: c.a.memberPublicId, stepDownTo: 'MEMBER' });
    expect((await act(c.A, c.org, down.body.id, 'accept')).status).toBe(200);
    expect(await roleOf(c.org, c.org.owner.memberId)).toBe('MEMBER');
    const roleChanges = await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.role_changed'`, [c.org.orgId]);
    expect(roleChanges).toHaveLength(2); // A → OWNER (lần 1), O → MEMBER (lần 2); A đã là OWNER ở lần 2 nên không có event cho A
  });
  it('O-7: a recipient who is not a member, oneself, or whose email is unverified → 422; one PENDING per org → 409', async () => {
    const c = await cast();
    expect((await request(c.O, c.org, { toMemberId: v7() })).body.code).toBe('validation_failed');
    expect((await request(c.O, c.org, { toMemberId: c.org.owner.memberPublicId })).body.code).toBe('validation_failed');
    const U = await seedP({ emailVerified: false });
    const u = await seedMember(c.org, 'MEMBER', { authUserId: U.authUserId });
    expect((await request(c.O, c.org, { toMemberId: u.memberPublicId })).body.code).toBe('validation_failed');
    expect((await request(c.O, c.org, { toMemberId: c.m.memberPublicId })).status).toBe(201);
    expect((await request(c.O, c.org, { toMemberId: c.a.memberPublicId })).body.code).toBe('ownership_transfer_pending');
    expect((await request(c.A, c.org, { toMemberId: c.m.memberPublicId })).body.code).toBe('forbidden'); // ownership.transfer là ownerOnly
  });
  it('O-8: requesting with a stale session → 403 reauthentication_required', async () => {
    const c = await cast({ sessionAgeSec: 3600 });
    expect((await request(c.O, c.org, { toMemberId: c.m.memberPublicId })).body.code).toBe('reauthentication_required');
  });
  it('O-16: the initiator was demoted before the accept → 409 ownership_transfer_invalidated, the request is CANCELLED { INITIATOR_NOT_OWNER } and committed', async () => {
    const c = await cast();
    const O2 = await seedP();
    await seedMember(c.org, 'OWNER', { authUserId: O2.authUserId });
    const r = await request(c.O, c.org, { toMemberId: c.m.memberPublicId, stepDownTo: 'ADMIN' });
    await withAppClient((cl) => inOrgTx(cl, c.org.orgId, () => cl.query('UPDATE org_members SET role_id = $1 WHERE id = $2', [c.org.roles.ADMIN.id, c.org.owner.memberId])));
    const bad = await act(c.M, c.org, r.body.id, 'accept');
    expect([bad.status, bad.body.code]).toEqual([409, 'ownership_transfer_invalidated']);
    expect(await statusOf(c.org, r.body.id)).toBe('CANCELLED');
    expect((await events(r.body.id)).map((e) => [e.type, e.payload['reason'] ?? null])).toEqual([
      ['tenancy.ownership_transfer.requested', null],
      ['tenancy.ownership_transfer.cancelled', 'INITIATOR_NOT_OWNER'],
    ]);
    expect(await roleOf(c.org, c.m.memberId)).toBe('MEMBER');
  });
  it('Review Focus 5: only the recipient can accept or decline; others get 404 and the request stays pending', async () => {
    const c = await cast();
    const r = await request(c.O, c.org, { toMemberId: c.m.memberPublicId });
    for (const p of [c.O, c.A])
      for (const verb of ['accept', 'decline'] as const) expect((await act(p, c.org, r.body.id, verb)).status, `${verb}`).toBe(404);
    expect(await statusOf(c.org, r.body.id)).toBe('PENDING');
    const declined = await act(c.M, c.org, r.body.id, 'decline');
    expect([declined.status, declined.body.status]).toEqual([200, 'DECLINED']);
    expect((await act(c.M, c.org, r.body.id, 'accept')).body.code).toBe('ownership_transfer_not_pending');
  });
  it('Review Focus 5: non-owners list only their own requests; owners list all; ?status= filters by the effective status', async () => {
    const c = await cast();
    await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.a.memberId, status: 'DECLINED' });
    const mine = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.m.memberId, status: 'CANCELLED' });
    const lapsed = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.m.memberId, expiresInSec: -60 });
    const ids = async (p: SeededPrincipal, q = '') => ((await authed(app, p).get(`${base(c.org)}${q}`)).body.data as { id: string }[]).map((t) => t.id).sort();
    expect(await ids(c.M)).toEqual([mine.publicId, lapsed.publicId].sort());
    expect(await ids(c.O)).toHaveLength(3);
    expect(await ids(c.O, '?status=EXPIRED')).toEqual([lapsed.publicId]);
    expect(await ids(c.O, '?status=PENDING')).toEqual([]);
  });
  it('cancel by an owner: 204 + cancelled { CANCELLED }; a lapsed request → 409 not_pending and EXPIRED without an event', async () => {
    const c = await cast();
    const r = await request(c.O, c.org, { toMemberId: c.m.memberPublicId });
    expect((await authed(app, c.O).delete(`${base(c.org)}/${r.body.id}`)).status).toBe(204);
    expect((await events(r.body.id)).map((e) => e.payload['reason'] ?? null)).toEqual([null, 'CANCELLED']);
    const lapsed = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.a.memberId, expiresInSec: -60 });
    expect((await act(c.A, c.org, lapsed.publicId, 'accept')).body.code).toBe('ownership_transfer_not_pending');
    expect(await statusOf(c.org, lapsed.publicId)).toBe('EXPIRED');
    expect(await events(lapsed.publicId)).toEqual([]);
  });
});
```
Run: `pnpm vitest run --project integration test/e2e/tenancy/ownership-transfers.e2e.spec.ts` → FAIL.

- [ ] **Step 2: `OwnershipTransferService`**

Run: `pnpm exec nest g service modules/tenancy/application/ownership-transfer --flat --no-spec --skip-import`
Thay toàn bộ `src/modules/tenancy/application/ownership-transfer.service.ts`:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import { AppError, CoreErrors, type FieldError } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { IdentityDirectory, identityConfig, type DirectoryUser } from '../../identity/index.js';
import { DISPLAY_NAME_MAX, EmailNotifications } from '../../notifications/index.js';
import type { StepDownRole, SystemRoleKey } from '../constants.js';
import { oneLine } from '../domain/display-text.js';
import { isLapsed } from '../domain/expiry.js';
import { effectiveTransferStatus, type TransferStatus } from '../domain/ownership-transfer.js';
import { TenancyErrors } from '../errors.js';
import {
  MemberRoleChangedEvent,
  OwnershipTransferAcceptedEvent,
  OwnershipTransferCancelledEvent,
  OwnershipTransferDeclinedEvent,
  OwnershipTransferRequestedEvent,
} from '../events.js';
import { MemberRepository, type MemberRow } from '../ports/member-repository.js';
import { OrgRepository, type OrgRow } from '../ports/org-repository.js';
import { OwnershipTransferRepository, type TransferRow } from '../ports/ownership-transfer-repository.js';
import { RoleRepository, type RoleRow } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { RolePermissions } from './authz/role-permissions.js';
import { TenancyMetrics } from './tenancy-metrics.js';
import { transferEventData } from './transfer-settlement.js';

const OWNERSHIP_TRANSFER = 'ownership.transfer';
const LAST_OWNER_CONSTRAINT = 'org_members_last_owner_ck';
type Recipient = { member: MemberRow; user: DirectoryUser | undefined };
type Resolution = { kind: 'DONE'; row: TransferRow } | { kind: 'NOT_PENDING' } | { kind: 'INVALIDATED' };
const recipientInvalid = (message: string) =>
  new AppError(CoreErrors.VALIDATION_FAILED, { fields: [{ path: 'toMemberId', code: 'invalid_recipient', message } satisfies FieldError] });
const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/**
 * Chuyển quyền sở hữu hai bên (spec SP3 §9.3, PR13, §8.4 đường d). Mọi ghi trong một transaction đã khoá org; thứ tự khoá
 * org → yêu cầu → member `FOR SHARE` (id tăng dần). Kết cục cần COMMIT trước khi báo lỗi (hết hạn → EXPIRED, người khởi tạo
 * hết là owner → CANCELLED, DB-M11) trả về dạng kết quả và ném sau `uow.run`. Đây là đường DUY NHẤT để owner tự xuống quyền.
 */
@Injectable()
export class OwnershipTransferService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly members: MemberRepository,
    private readonly transfers: OwnershipTransferRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly rolePermissions: RolePermissions,
    private readonly emails: EmailNotifications,
    private readonly events: EventPublisher,
    private readonly metrics: TenancyMetrics,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
    @Inject(identityConfig.KEY) private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  /** INT-M2: người có `ownership.transfer` thấy mọi yêu cầu; người khác chỉ yêu cầu mình là bên gửi/nhận. */
  async list(q: { status?: TransferStatus; page: number; pageSize: number; cap: number }): Promise<{ rows: (TransferRow & { status: TransferStatus })[]; total: number }> {
    const me = await this.self();
    const sees = new Set(await this.rolePermissions.of({ id: me.roleId, systemKey: me.systemKey })).has(OWNERSHIP_TRANSFER);
    const filter = { status: q.status, participantMemberId: sees ? undefined : me.id };
    const now = await this.orgs.clockNow();
    const [rows, total] = await Promise.all([
      this.transfers.list({ ...filter, limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      this.transfers.countUpTo(filter, q.cap),
    ]);
    return { rows: rows.map((t) => ({ ...t, status: effectiveTransferStatus(t, now) })), total };
  }

  async create(input: { toMemberId: string; stepDownTo: StepDownRole | null }): Promise<TransferRow> {
    await this.hooks.afterGuard();
    const recipient = await this.recipient(input.toMemberId); // directory (pool auth) TRƯỚC transaction
    const initiatorName = await this.nameOf(await this.self());
    return this.uow.run(async () => {
      const org = await this.lockActiveOrg();
      const { actor, locked } = await this.reauth.require([OWNERSHIP_TRANSFER], [recipient.member.id]);
      const to = locked.find((m) => m.id === recipient.member.id);
      if (!to) throw recipientInvalid('toMemberId is not a member of this organization');
      if (to.id === actor.id) throw recipientInvalid('the recipient must be another member');
      await this.transfers.expireLapsed(); // chạm sau hạn: giải phóng `pending_uq` trước INSERT (không event)
      const t = await this.transfers.insert({ fromMemberId: actor.id, toMemberId: to.id, stepDownTo: input.stepDownTo, ttlSec: this.cfg.ownershipTransferTtlSec });
      // Local/hybrid: thư tới người nhận cùng transaction; external: không thư (không có email), người nhận dùng GET (INT-M3).
      if (recipient.user)
        await this.emails.request({
          template: 'ownership-transfer-requested',
          to: recipient.user.email,
          params: {
            name: oneLine(recipient.user.name, DISPLAY_NAME_MAX),
            orgName: oneLine(org.name, DISPLAY_NAME_MAX),
            requestedByName: oneLine(initiatorName ?? 'An owner', DISPLAY_NAME_MAX),
            expiresAt: t.expiresAt.toISOString(),
          },
          idempotencyKey: `ownership-transfer-requested:${t.publicId}`,
        });
      await this.events.publish(OwnershipTransferRequestedEvent, {
        data: transferEventData(t),
        aggregate: { type: 'ownership_transfer', id: t.publicId, version: t.version },
        actor: userActor(this.ctx),
      });
      return t;
    });
  }

  async accept(publicId: string): Promise<TransferRow> {
    await this.hooks.afterGuard();
    const r = await this.lastOwnerGuarded(() =>
      this.uow.run(async (): Promise<Resolution> => {
        await this.lockActiveOrg();
        const t = await this.transfers.lockByPublicId(publicId);
        if (!t) throw notFound();
        const { actor, locked } = await this.reauth.require([], t.fromMemberId === null ? [] : [t.fromMemberId]);
        if (t.toMemberId !== actor.id) throw notFound(); // Review Focus 5: không lộ yêu cầu cho người khác
        const pending = await this.stillPending(t);
        if (!pending) return { kind: 'NOT_PENDING' };
        const from = locked.find((m) => m.id === t.fromMemberId);
        const by = userActor(this.ctx);
        if (!from || from.systemKey !== 'OWNER') {
          // DB-M11: commit CANCELLED rồi 409 (spec §8.4 đường d).
          const data = transferEventData(t);
          const done = await this.mustResolve(t, 'CANCELLED');
          await this.publishCancelled(done, data, 'INITIATOR_NOT_OWNER', by);
          return { kind: 'INVALIDATED' };
        }
        const data = transferEventData(t);
        const done = await this.mustResolve(t, 'ACCEPTED');
        const system = await this.systemRoles();
        // Người nhận lên OWNER TRƯỚC, rồi mới hạ người khởi tạo: trigger hoãn owner cuối luôn thấy ≥ 1 owner.
        if (actor.systemKey !== 'OWNER') await this.changeRole(actor, system.OWNER, by);
        if (t.stepDownTo !== null) await this.changeRole(from, system[t.stepDownTo], by);
        await this.events.publish(OwnershipTransferAcceptedEvent, {
          data,
          aggregate: { type: 'ownership_transfer', id: done.publicId, version: done.version },
          actor: by,
        });
        return { kind: 'DONE', row: done };
      }),
    );
    return this.settled(r);
  }

  /** Thu hẹp (`@NarrowingTenancyAction()`): người nhận từ chối. */
  async decline(publicId: string): Promise<TransferRow> {
    const r = await this.uow.run(async (): Promise<Resolution> => {
      await this.lockActiveOrg();
      const t = await this.transfers.lockByPublicId(publicId);
      if (!t) throw notFound();
      const { actor } = await this.reauth.require([]);
      if (t.toMemberId !== actor.id) throw notFound();
      if (!(await this.stillPending(t))) return { kind: 'NOT_PENDING' };
      const data = transferEventData(t);
      const done = await this.mustResolve(t, 'DECLINED');
      await this.events.publish(OwnershipTransferDeclinedEvent, {
        data,
        aggregate: { type: 'ownership_transfer', id: done.publicId, version: done.version },
        actor: userActor(this.ctx),
      });
      return { kind: 'DONE', row: done };
    });
    return this.settled(r);
  }

  /** Thu hẹp: mọi owner (`ownership.transfer`, ownerOnly) huỷ yêu cầu đang chờ. */
  async cancel(publicId: string): Promise<void> {
    const r = await this.uow.run(async (): Promise<Resolution> => {
      await this.lockActiveOrg();
      await this.reauth.require([OWNERSHIP_TRANSFER]);
      const t = await this.transfers.lockByPublicId(publicId);
      if (!t) throw notFound();
      if (!(await this.stillPending(t))) return { kind: 'NOT_PENDING' };
      const data = transferEventData(t);
      const done = await this.mustResolve(t, 'CANCELLED');
      await this.publishCancelled(done, data, 'CANCELLED', userActor(this.ctx));
      return { kind: 'DONE', row: done };
    });
    this.settled(r);
  }

  /** PENDING và còn hạn theo `clock_timestamp()` sau khoá; PENDING quá hạn được ghi EXPIRED (không event, §14.1). */
  private async stillPending(t: TransferRow): Promise<boolean> {
    if (t.status !== 'PENDING') return false;
    if (!isLapsed(t.expiresAt, await this.orgs.clockNow())) return true;
    await this.transfers.resolve(t.id, 'EXPIRED');
    return false;
  }

  private async mustResolve(t: TransferRow, to: 'ACCEPTED' | 'DECLINED' | 'CANCELLED'): Promise<TransferRow> {
    const done = await this.transfers.resolve(t.id, to); // T-16: CAS PENDING → to
    if (!done) throw new Error('a locked PENDING ownership transfer was no longer PENDING');
    return done;
  }

  private publishCancelled(done: TransferRow, data: ReturnType<typeof transferEventData>, reason: 'CANCELLED' | 'INITIATOR_NOT_OWNER', actor: EventActor) {
    return this.events.publish(OwnershipTransferCancelledEvent, {
      data: { ...data, reason },
      aggregate: { type: 'ownership_transfer', id: done.publicId, version: done.version },
      actor,
    });
  }

  private settled(r: Resolution): TransferRow {
    switch (r.kind) {
      case 'DONE':
        return r.row;
      case 'NOT_PENDING':
        throw new AppError(TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING);
      case 'INVALIDATED':
        throw new AppError(TenancyErrors.OWNERSHIP_TRANSFER_INVALIDATED);
      default: {
        const unknown: never = r;
        throw new Error(`unknown transfer resolution ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async changeRole(m: MemberRow, role: RoleRow, actor: EventActor): Promise<void> {
    if (m.roleId === role.id) return;
    const updated = await this.members.changeRole(m.id, role.id);
    await this.events.publish(MemberRoleChangedEvent, {
      data: { memberId: updated.publicId, userId: updated.userPublicId, fromRoleId: m.rolePublicId, toRoleId: updated.rolePublicId, reason: 'OWNERSHIP_TRANSFER' },
      aggregate: { type: 'member', id: updated.publicId, version: updated.version },
      actor,
    });
  }

  private async systemRoles(): Promise<Record<SystemRoleKey, RoleRow>> {
    const all = await this.roles.list();
    const pick = (k: SystemRoleKey): RoleRow => {
      const r = all.find((x) => x.systemKey === k);
      if (!r) throw new Error(`system role ${k} missing (organizations_bootstrap_ck)`);
      return r;
    };
    return { OWNER: pick('OWNER'), ADMIN: pick('ADMIN'), MEMBER: pick('MEMBER') };
  }

  /** O-7: người nhận phải là member khác và (local/hybrid) có email đã xác thực; external: IdP chịu trách nhiệm. */
  private async recipient(toMemberPublicId: string): Promise<Recipient> {
    const member = await this.members.findByPublicId(toMemberPublicId);
    if (!member) throw recipientInvalid('toMemberId is not a member of this organization');
    if (this.identity.mode === 'external' || !this.directory || member.authUserId === null) return { member, user: undefined };
    const user = await this.directory.findUser(member.authUserId);
    if (!user?.emailVerified) throw recipientInvalid('the recipient must have a verified email');
    return { member, user };
  }

  private async nameOf(m: MemberRow): Promise<string | null> {
    if (this.identity.mode === 'external' || !this.directory || m.authUserId === null) return null;
    return (await this.directory.findUser(m.authUserId))?.name ?? null;
  }

  private async self(): Promise<MemberRow> {
    const ref = this.ctx.orgAccess()?.ref;
    const me = ref === undefined ? undefined : await this.members.findByPublicId(ref);
    if (!me) throw notFound();
    return me;
  }

  private async lockActiveOrg(): Promise<OrgRow> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw notFound(); // T-12, O-10
    return org;
  }

  /** Trigger hoãn owner cuối bắn lúc COMMIT; 409 do constraint map, ở đây chỉ đếm metric path `transfer` (§16). */
  private async lastOwnerGuarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgFields(err)?.constraint === LAST_OWNER_CONSTRAINT) this.metrics.lastOwnerBlocked.add(1, { path: 'transfer' });
      throw err;
    }
  }
}
```
(`initiatorName ?? 'An owner'`: ở local/hybrid người khởi tạo luôn có user trong directory; chuỗi dự phòng chỉ để kiểu không rỗng nếu user vừa bị xoá giữa hai lần đọc — thư vẫn đi, không lỗi 500. `email` của `DirectoryUser` là email của user, không ghi vào log.)

- [ ] **Step 3: Controller, module, route thu hẹp**

Run: `pnpm exec nest g controller modules/tenancy/http/ownership-transfers --flat --no-spec --skip-import`
Thay toàn bộ `src/modules/tenancy/http/ownership-transfers.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, Paginator, paginationConfig, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { OwnershipTransferService } from '../application/ownership-transfer.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { NarrowingTenancyAction, OrgMemberOnly, SensitiveTenancyAction } from './decorators.js';
import {
  CreateOwnershipTransferBody,
  ListAcquisitionPage,
  OwnershipTransferResponse,
  TransferStatusQuery,
  publicIdOrNotFound,
  transferOf,
} from './schemas.js';

@Controller('v1/orgs/:orgId/ownership-transfers')
export class OwnershipTransfersController {
  constructor(
    private readonly transfers: OwnershipTransferService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY) private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @OrgMemberOnly()
  @ApiOk(OwnershipTransferResponse)
  async list(
    @Query({ schema: ListAcquisitionPage }) page: z.infer<typeof ListAcquisitionPage>,
    @Query({ schema: TransferStatusQuery }) filter: z.infer<typeof TransferStatusQuery>,
  ) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=createdAt (ascending) is supported.' });
    const { rows, total } = await this.transfers.list({ status: filter.status, page: page.page, pageSize: page.pageSize, cap: this.pagination.totalCountCap });
    return this.pages.offset(rows.map((t) => serialize(OwnershipTransferResponse, transferOf(t))), page, total);
  }

  @Post()
  @TenancyPermissions.require('ownership.transfer')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OwnershipTransferResponse)
  @ApiProblems(TenancyErrors.OWNERSHIP_TRANSFER_PENDING, CoreErrors.VALIDATION_FAILED)
  async create(@Body({ schema: CreateOwnershipTransferBody }) body: z.infer<typeof CreateOwnershipTransferBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const t = await this.transfers.create({ toMemberId: body.toMemberId.toLowerCase(), stepDownTo: body.stepDownTo });
    const orgId = this.ctx.orgId();
    if (orgId === undefined) throw new Error('OwnershipTransfersController.create ran without an org context');
    setLocation(res, `/v1/orgs/${orgId}/ownership-transfers/${t.publicId}`);
    return serialize(OwnershipTransferResponse, transferOf({ ...t, status: 'PENDING' }));
  }

  @Post(':transferId/accept')
  @HttpCode(HttpStatus.OK)
  @OrgMemberOnly()
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OwnershipTransferResponse)
  @ApiProblems(TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING, TenancyErrors.OWNERSHIP_TRANSFER_INVALIDATED, TenancyErrors.LAST_OWNER)
  async accept(@Param('transferId') transferId: string) {
    const t = await this.transfers.accept(publicIdOrNotFound(transferId));
    return serialize(OwnershipTransferResponse, transferOf({ ...t, status: t.status }));
  }

  @Post(':transferId/decline')
  @HttpCode(HttpStatus.OK)
  @OrgMemberOnly()
  @NarrowingTenancyAction()
  @Idempotent()
  @ApiOk(OwnershipTransferResponse)
  @ApiProblems(TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING)
  async decline(@Param('transferId') transferId: string) {
    const t = await this.transfers.decline(publicIdOrNotFound(transferId));
    return serialize(OwnershipTransferResponse, transferOf({ ...t, status: t.status }));
  }

  @Delete(':transferId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('ownership.transfer')
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING)
  async cancel(@Param('transferId') transferId: string): Promise<void> {
    await this.transfers.cancel(publicIdOrNotFound(transferId));
  }
}
```
`policy-metadata.ts` — `NARROWING_ROUTES` thêm `'POST v1/orgs/:orgId/ownership-transfers/:transferId/decline'`, `'DELETE v1/orgs/:orgId/ownership-transfers/:transferId'` (tổng của 3C: bốn route). `tenancy-http.module.ts` — thêm `OwnershipTransfersController` và provider `OwnershipTransferService`.

- [ ] **Step 4: Ma trận route nhận route chuyển quyền**

`test/e2e/tenancy/role-route-matrix.e2e.spec.ts`: import thêm `seedTransfer`; `ROUTES_3C` nối
```ts
  'GET v1/orgs/:orgId/ownership-transfers',
  'POST v1/orgs/:orgId/ownership-transfers',
  'POST v1/orgs/:orgId/ownership-transfers/:transferId/accept',
  'POST v1/orgs/:orgId/ownership-transfers/:transferId/decline',
  'DELETE v1/orgs/:orgId/ownership-transfers/:transferId',
```
`NARROWING` thêm
```ts
  'POST v1/orgs/:orgId/ownership-transfers/:transferId/decline': { as: (c) => c.targetP, status: 200 },
  'DELETE v1/orgs/:orgId/ownership-transfers/:transferId': { as: (c) => c.as.OWNER, status: 204 },
```
`Cast` thêm `transfer: string`; trong `cast` trước `return`:
```ts
    const transfer = await seedTransfer(org, { fromMemberId: org.owner.memberId, toMemberId: target.memberId });
```
object trả về thêm `transfer: transfer.publicId`; `call` nối `.replace(':transferId', c.transfer)`; `body` thêm nhánh:
```ts
              : route.id === 'POST v1/orgs/:orgId/ownership-transfers'
                ? { toMemberId: c.target, stepDownTo: null }
```
(Ô `POST …/ownership-transfers` trả `409 ownership_transfer_pending` khi qua guard vì `cast` đã có một yêu cầu: vẫn là "qua guard". Ô `accept` của người không phải `to` trả `404`: cũng qua guard, đúng Review Focus 5.)

- [ ] **Step 5: Chạy, OpenAPI, commit**

Run:
```bash
pnpm typecheck && pnpm arch
pnpm vitest run --project integration test/e2e/tenancy/ownership-transfers.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/members.e2e.spec.ts
pnpm build && pnpm openapi:export && git diff --stat openapi.json
```
Expected: PASS; bảng route tenant 3A + 3B + 3C khớp spec §12; bảng thu hẹp có đúng năm route (1 của 3A + 4 của 3C); `openapi.json` thêm năm operation.
```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy
git add src/modules/tenancy test/e2e/tenancy openapi.json
git commit -m "feat(tenancy): two-party ownership transfer with step_down_to, recipient-only accept/decline and owner cancel"
```

---

## Phần F — Nối vào vòng đời của 3A/3B, race, chế độ external, chaos/PII (spec Bảng 5, §9.3–§9.6, §11, §17, §18.3–§18.4)

### Task 12: Điểm mở rộng của 3A/3B — `RoleService.delete` (R-11, R-18, B-15), xoá mềm, gỡ member/rời org, xoá tài khoản; S2-R43

**Files:**
- Create: `test/e2e/tenancy/acquisition-lifecycle.e2e.spec.ts`
- Modify: `src/modules/tenancy/application/role.service.ts`, `src/modules/tenancy/application/org-lifecycle.service.ts`, `src/modules/tenancy/application/member.service.ts`, `src/modules/tenancy/application/user-deletion.service.ts`

**Interfaces:**
- Consumes: `InvitationRepository.{expireLapsedForRole, revokeAllPending}`, `InviteLinkRepository.{revokeClosedForRole, revokeAll}`, `OwnershipTransferRepository.cancelAllPending`, `InviteLinkRevokedEvent` (Task 7), `TransferSettlement.settleForRemovedMember` (Task 8); chỗ mở rộng có chú thích của 3A/3B: `RoleService.delete` (trước `this.roles.deleteById`), `OrgLifecycleService.softDelete` (trước `suspendAllForCurrentOrg`), `MemberService.deleteWithEvent` (trước `this.members.deleteById`), `UserDeletionService.releaseOrg` (trước `this.members.deleteById`); test: `seedInvitation`, `seedInviteLink`, `seedTransfer`, `AuthClient`, `mailpitFromInfra`, `acceptInvitation`, `previewToken`.
- Produces: hành vi của spec Bảng 5 cột 3C; không API mới.

- [ ] **Step 1: e2e vòng đời (fail)**

`test/e2e/tenancy/acquisition-lifecycle.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { acceptInvitation, previewToken } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  deleteTenancyUsersOf,
  inOrgTx,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const PASSWORD = 'acquisition-3c correct horse battery';

describe('3C inside the lifecycle of 3A/3B (spec Bảng 5; §9.3, §9.4, §9.6; R-11, R-18, B-15; tiêu chí 8; S2-R43)', () => {
  let app: INestApplication;
  let admin: SeededPrincipal;
  const mail = mailpitFromInfra();
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const registered: string[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP();
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) => withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const events = (aggregateId: string) =>
    ownerQuery<{ type: string; aggregate_version: string; payload: Record<string, unknown>; headers: { actorType: string; actorId: string } }>(
      'SELECT type, aggregate_version::text, payload, headers FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [aggregateId],
    );

  beforeAll(async () => {
    app = await startTenancyApp({ env: { HTTP_TRUST_PROXY: 'loopback' } });
    admin = await seedP({ role: 'admin' });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await deleteTenancyUsersOf(registered);
    for (const id of registered) await ownerQuery('DELETE FROM auth."user" WHERE id = $1', [id]);
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('tiêu chí 8: soft delete revokes pending invitations and every link and cancels pending transfers, without events of their own; restore revives none', async () => {
    const c = await cast();
    const p = await seedP();
    const inv = await seedInvitation(c.org, { email: p.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId });
    const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.a.memberId });
    const t = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.m.memberId });
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}`)).status).toBe(204);
    const state = async () => ({
      inv: (await sql(c.org, 'SELECT status, token_hash IS NULL AS cleared FROM org_invitations WHERE id = $1', [inv.id])).rows[0],
      link: (await sql(c.org, 'SELECT revoked_at IS NOT NULL AS revoked FROM org_invite_links WHERE id = $1', [link.id])).rows[0],
      t: (await sql(c.org, 'SELECT status FROM org_ownership_transfers WHERE id = $1', [t.id])).rows[0],
    });
    const revoked = { inv: { status: 'REVOKED', cleared: true }, link: { revoked: true }, t: { status: 'CANCELLED' } };
    expect(await state()).toEqual(revoked);
    for (const id of [inv.publicId, link.publicId, t.publicId]) expect(await events(id)).toEqual([]);
    const restored = await authed(app, c.O).post(`/v1/orgs/${c.org.orgId}/restore`).set('idempotency-key', `k-${v7()}`).send({});
    expect(restored.status).toBe(200);
    expect(await state()).toEqual(revoked);
    expect((await previewToken(app, 'invitations', { token: inv.token })).status).toBe(404);
    expect((await previewToken(app, 'invite-links', { token: link.token })).status).toBe(404);
    expect((await acceptInvitation(app, p, { token: inv.token })).body.code).toBe('invitation_not_found');
  });
  it('R-11 / B-15: a custom role held by a PENDING invitation or an open link cannot be deleted (409 role_in_use); once revoked it can', async () => {
    const c = await cast();
    const role = await seedCustomRole(c.org, { permissions: ROLE_SET_C0, name: `R11 ${v7()}` });
    const url = `/v1/orgs/${c.org.orgId}/roles/${role.publicId}`;
    const inv = await seedInvitation(c.org, { email: `r11-${v7()}@example.test`, roleId: role.id, inviterMemberId: c.org.owner.memberId });
    expect((await authed(app, c.O).delete(url)).body.code).toBe('role_in_use');
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/invitations/${inv.publicId}`)).status).toBe(204);
    const link = await seedInviteLink(c.org, { roleId: role.id, createdByMemberId: c.org.owner.memberId });
    expect((await authed(app, c.O).delete(url)).body.code).toBe('role_in_use');
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/invite-links/${link.publicId}`)).status).toBe(204);
    expect((await authed(app, c.O).delete(url)).status).toBe(204);
  });
  it('R-18: finished invitations and closed links do not hold a role; lapsed invitations read EXPIRED; each closed link is revoked with ROLE_DELETED', async () => {
    const c = await cast();
    const role = await seedCustomRole(c.org, { permissions: ROLE_SET_C0, name: `R18 ${v7()}` });
    const base = { roleId: role.id, inviterMemberId: c.org.owner.memberId };
    const accepted = await seedInvitation(c.org, { ...base, email: `acc-${v7()}@example.test`, status: 'ACCEPTED' });
    const lapsed = await seedInvitation(c.org, { ...base, email: `lap-${v7()}@example.test`, expiresInSec: -60 });
    const linkBase = { roleId: role.id, createdByMemberId: c.org.owner.memberId };
    const alreadyRevoked = await seedInviteLink(c.org, { ...linkBase, revoked: true });
    const expired = await seedInviteLink(c.org, { ...linkBase, expiresInSec: -60 });
    const exhausted = await seedInviteLink(c.org, { ...linkBase, maxUses: 1, useCount: 1 });
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/roles/${role.publicId}`)).status).toBe(204);
    const invs = (await authed(app, c.O).get(`/v1/orgs/${c.org.orgId}/invitations?pageSize=100`)).body.data as { id: string; status: string; role: unknown }[];
    expect(invs.find((i) => i.id === accepted.publicId)).toMatchObject({ status: 'ACCEPTED', role: null });
    expect(invs.find((i) => i.id === lapsed.publicId)).toMatchObject({ status: 'EXPIRED', role: null });
    expect(await events(lapsed.publicId)).toEqual([]);
    for (const l of [expired, exhausted])
      expect((await events(l.publicId)).map((e) => [e.type, e.payload['reason'], e.aggregate_version, e.headers.actorId])).toEqual([
        ['tenancy.invite_link.revoked', 'ROLE_DELETED', '2', c.O.authUserId],
      ]);
    expect(await events(alreadyRevoked.publicId)).toEqual([]);
    const links = (await authed(app, c.O).get(`/v1/orgs/${c.org.orgId}/invite-links?pageSize=100`)).body.data as { status: string; role: unknown }[];
    expect(links.map((l) => [l.status, l.role])).toEqual([
      ['REVOKED', null],
      ['REVOKED', null],
      ['REVOKED', null],
    ]);
  });
  it('removing or losing a member of a PENDING transfer cancels it first with { MEMBER_REMOVED } (actor = the remover); a lapsed one only expires', async () => {
    const c = await cast();
    const removed = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.m.memberId });
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/members/${c.m.memberPublicId}`)).status).toBe(204);
    expect((await events(removed.publicId)).map((e) => [e.payload['reason'], e.headers.actorType, e.headers.actorId])).toEqual([
      ['MEMBER_REMOVED', 'user', c.O.authUserId],
    ]);
    const O2 = await seedP();
    const o2 = await seedMember(c.org, 'OWNER', { authUserId: O2.authUserId });
    const left = await seedTransfer(c.org, { fromMemberId: o2.memberId, toMemberId: c.a.memberId });
    expect((await authed(app, O2).delete(`/v1/orgs/${c.org.orgId}/members/me`)).status).toBe(204);
    expect((await events(left.publicId)).map((e) => e.payload['reason'])).toEqual(['MEMBER_REMOVED']);
    const lapsed = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.a.memberId, expiresInSec: -60 });
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/members/${c.a.memberPublicId}`)).status).toBe(204);
    expect((await sql(c.org, 'SELECT status FROM org_ownership_transfers WHERE id = $1', [lapsed.id])).rows).toEqual([{ status: 'EXPIRED' }]);
    expect(await events(lapsed.publicId)).toEqual([]);
  });
  it('account deletion cancels the PENDING transfer of the deleted member ({ MEMBER_REMOVED }, actor system:identity.user-deletion)', async () => {
    const c = await cast();
    const t = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.m.memberId });
    const r = await authed(app, admin).post('/api/auth/admin/remove-user').set('origin', 'http://localhost:3000').send({ userId: c.M.authUserId });
    expect(r.status).toBe(200);
    expect((await events(t.publicId)).map((e) => [e.payload['reason'], e.headers.actorType, e.headers.actorId])).toEqual([
      ['MEMBER_REMOVED', 'system', 'identity.user-deletion'],
    ]);
  });
  it('S2-R43: a user who just signed up accepts an invitation; tenancy never emits identity.user.registered', async () => {
    const c = await cast();
    const email = `s2r43-${randomUUID()}@example.test`;
    const client = new AuthClient(app.getHttpServer());
    const after = await mail.now();
    expect((await client.signUp(email, PASSWORD)).status).toBeLessThan(300);
    await client.verifyEmailFromMailpit(mail, email, after);
    expect((await client.signIn(email, PASSWORD)).status).toBe(200);
    const [row] = await ownerQuery<{ id: string }>('SELECT id FROM auth."user" WHERE email = $1', [email]);
    if (!row) throw new Error('registered user not found');
    registered.push(row.id);
    const inv = await seedInvitation(c.org, { email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId });
    const r = await client.request('post', '/v1/invitations/accept', { body: { token: inv.token }, headers: { 'idempotency-key': `k-${v7()}` } });
    expect(r.status).toBe(201);
    expect((await ownerQuery(`SELECT 1 FROM outbox_events WHERE type = 'identity.user.registered' AND aggregate_id = $1`, [row.id])).length).toBe(1);
  });
});
```
Run: `pnpm vitest run --project integration test/e2e/tenancy/acquisition-lifecycle.e2e.spec.ts`
Expected: FAIL — xoá mềm không thu hồi (ca 1), xoá role còn lời mời quá hạn/link đã đóng trả `409` (ca 3), gỡ member của chuyển quyền PENDING trả `409 conflict`/`500` do `23514 org_ownership_transfers_pending_members_ck` (ca 4, 5). Ca R-11 và S2-R43 có thể xanh sẵn (FK `SET NULL` + `CHECK` của Task 2 làm việc chặn; Task 9 đã có accept): giữ chúng để khoá hành vi.

- [ ] **Step 2: `RoleService.delete`**

`src/modules/tenancy/application/role.service.ts` — inject thêm `private readonly invitations: InvitationRepository, private readonly links: InviteLinkRepository` (import từ `../ports/invitation-repository.js`, `../ports/invite-link-repository.js`; thêm `InviteLinkRevokedEvent` vào import của `../events.js`), và thay hai dòng chú thích "Điểm mở rộng của 3C" bằng:
```ts
      // 3C (spec Bảng 5, §6.7, §6.8, R-18): lời mời PENDING đã hết hạn của role → EXPIRED (trạng thái suy ra từ thời gian,
      // không event); link chưa thu hồi mà không còn mở → thu hồi + `tenancy.invite_link.revoked { ROLE_DELETED }` từng link
      // (ghi `revoked_at` là thay đổi thật, DB2-M3). Lời mời PENDING còn hạn / link đang mở còn lại làm `SET NULL (role_id)`
      // vi phạm `*_pending_role_ck` / `*_active_role_ck` → 409 role_in_use (R-11, B-15, T-9).
      await this.invitations.expireLapsedForRole(role.id);
      for (const l of await this.links.revokeClosedForRole(role.id))
        await this.events.publish(InviteLinkRevokedEvent, {
          data: { inviteLinkId: l.publicId, reason: 'ROLE_DELETED' },
          aggregate: { type: 'invite_link', id: l.publicId, version: l.version },
          actor: userActor(this.ctx),
        });
```
(`role-races.e2e.spec.ts`, `roles.e2e.spec.ts` của 3B dựng `RoleService` qua DI: không sửa test nào của 3B.)

- [ ] **Step 3: Xoá mềm**

`src/modules/tenancy/application/org-lifecycle.service.ts` — inject `InvitationRepository`, `InviteLinkRepository`, `OwnershipTransferRepository`; thay dòng chú thích "3C thu hồi link, …" bằng:
```ts
      // 3C (spec §9.4, Bảng 5): thu hồi mọi link chưa thu hồi, lời mời PENDING → REVOKED, chuyển quyền PENDING → CANCELLED,
      // dưới cùng khoá org. Không event riêng (§14.1: `tenancy.org.deleted` hàm ý tất cả). Khôi phục không làm sống lại.
      // 3D thu hồi key, grant (spec Bảng 5).
      await this.invitations.revokeAllPending();
      await this.links.revokeAll();
      await this.transfers.cancelAllPending();
```
(`OrgLifecycleService` thuộc `TenancyCoreModule`, nơi ba repository đã là provider từ Task 7; chạy ở cả api lẫn worker.)

- [ ] **Step 4: Gỡ member, rời org, xoá tài khoản**

`src/modules/tenancy/application/member.service.ts` — inject `private readonly settlement: TransferSettlement` (import từ `./transfer-settlement.js`); trong `deleteWithEvent` thay dòng chú thích "3C: huỷ chuyển quyền PENDING …" bằng:
```ts
    // 3C (spec §9.3): huỷ chuyển quyền PENDING của member TRƯỚC câu xoá (không thì `…_pending_members_ck` làm transaction
    // fail to); quá hạn → EXPIRED không event. 3D: phát `api_key.revoked` từng key (spec Bảng 5).
    await this.settlement.settleForRemovedMember(m.id, userActor(this.ctx));
```
`src/modules/tenancy/application/user-deletion.service.ts` — inject `private readonly settlement: TransferSettlement`; trong `releaseOrg` thay dòng chú thích "3C: huỷ chuyển quyền PENDING …" bằng:
```ts
          // 3C (spec §9.6): huỷ chuyển quyền PENDING của member trước khi xoá, actor system có tên (§14.1).
          // 3D: đọc key của member để phát `api_key.revoked` (spec Bảng 5).
          await this.settlement.settleForRemovedMember(member.id, DELETION_ACTOR);
```
(`UserDeletionService` nằm ở `TenancyIdentityPortsModule`; `TransferSettlement` là export của `TenancyCoreModule` `@Global`, Task 8.)

- [ ] **Step 5: Chạy, commit**

Run:
```bash
pnpm typecheck && pnpm arch
pnpm vitest run --project integration test/e2e/tenancy/acquisition-lifecycle.e2e.spec.ts test/e2e/tenancy/roles.e2e.spec.ts test/e2e/tenancy/role-races.e2e.spec.ts test/e2e/tenancy/members.e2e.spec.ts test/e2e/tenancy/org-lifecycle.e2e.spec.ts test/e2e/tenancy/account-deletion.e2e.spec.ts test/integration/tenancy/org-purge.spec.ts
```
Expected: PASS; test 3A/3B về xoá role, gỡ member, vòng đời org, xoá tài khoản không đổi hành vi khi không có dữ liệu 3C.
```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy/acquisition-lifecycle.e2e.spec.ts
git add src/modules/tenancy test/e2e/tenancy/acquisition-lifecycle.e2e.spec.ts
git commit -m "feat(tenancy): role delete, soft delete, member removal and account deletion settle invitations, links and ownership transfers"
```

---

### Task 13: Race của 3C — tiêu chí 6 và 7 song song, T-2, T-3, T-4, T-5, T-9 (lời mời/link), T-11, T-16, T-18 (O-12), T-21, T-27 (X-8), T-29 (X-11)

**Files:**
- Create: `test/e2e/tenancy/acquisition-races.e2e.spec.ts`

**Interfaces:**
- Consumes: `raceOnOrgLock(orgId, waiters, fire)` (3A, `test/support/org-lock-barrier.ts`), mọi route của Task 9–11, `acceptInvitation`, `joinInviteLink`, `seedInvitation`, `seedInviteLink`, `seedTransfer`, `withAppClient`, `inOrgTx`, `ownerQuery`.
- Produces: bằng chứng chạy thật cho mọi race của 3C ở spec Bảng 2 (bảng Self-review §2).

- [ ] **Step 1: Test race (barrier trên khoá dòng org, lặp)**

`test/e2e/tenancy/acquisition-races.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import { acceptInvitation, joinInviteLink } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  ROLE_SET_C0,
  deleteTenancyUsersOf,
  inOrgTx,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ROUNDS = 5;
const PENDING_CAP = 3;
const LINK_CAP = 2;
/** Dưới `idle_in_transaction_session_timeout` (10 s) của DB test. */
const HOLD_PAST_EXPIRY_MS = 4_000;
const EXPIRES_IN_SEC = 2;

describe('3C races on the org lock (spec SP3 §17; tiêu chí 6, 7; X-8, X-11, O-12)', () => {
  let app: INestApplication;
  let admin: SeededPrincipal;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async () => {
    const O = await seedP();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP();
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP();
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const sql = (org: SeededOrg, q: string, params: unknown[] = []) => withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  const memberCount = async (org: SeededOrg) => Number((await sql(org, 'SELECT count(*)::int AS n FROM org_members')).rows[0]?.n);
  const invite = (p: SeededPrincipal, org: SeededOrg, email: string, roleId: string) =>
    authed(app, p).post(`/v1/orgs/${org.orgId}/invitations`).set('idempotency-key', `k-${v7()}`).send({ email, roleId });
  const createLink = (p: SeededPrincipal, org: SeededOrg, roleId: string) =>
    authed(app, p).post(`/v1/orgs/${org.orgId}/invite-links`).send({ roleId, maxUses: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  /** T-29 / X-11: giữ khoá dòng org qua mốc hết hạn trong khi `fire` đứng chờ ở bước khoá org, rồi thả. */
  const holdOrgLockPast = <T>(org: SeededOrg, untilMs: number, fire: () => Promise<T>) =>
    withAppClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
        await holder.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [org.orgId]);
        const [{ pid } = { pid: -1 }] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
        const pending = fire();
        pending.catch(() => undefined);
        await vi.waitFor(
          async () => expect((await ownerQuery('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).length).toBe(1),
          { timeout: 3_000, interval: 20 },
        );
        const wait = untilMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await holder.query('COMMIT');
        return await pending;
      } catch (err) {
        await holder.query('ROLLBACK');
        throw err;
      }
    });

  beforeAll(async () => {
    app = await startTenancyApp({
      env: {
        THROTTLE_DEFAULT_LIMIT: '100000',
        TENANCY_MAX_PENDING_INVITATIONS_PER_ORG: String(PENDING_CAP),
        TENANCY_MAX_ACTIVE_INVITE_LINKS_PER_ORG: String(LINK_CAP),
      },
    });
    admin = await seedP({ role: 'admin' });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`tiêu chí 6 / T-2: 4 parallel accepts of one invitation × ${ROUNDS} → exactly one 201, the rest the uniform 404; one member, one accepted event`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const p = await seedP();
      const inv = await seedInvitation(c.org, { email: p.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId });
      const before = await memberCount(c.org);
      const rs = await raceOnOrgLock(c.org.orgId, 4, () => Promise.all(Array.from({ length: 4 }, () => acceptInvitation(app, p, { token: inv.token }))));
      expect(rs.map((r) => r.status).sort()).toEqual([201, 404, 404, 404]);
      expect(await memberCount(c.org)).toBe(before + 1);
      expect(await ownerQuery(`SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND type = 'tenancy.invitation.accepted'`, [inv.publicId])).toHaveLength(1);
    }
  });
  it('tiêu chí 7 / T-5: a link with maxUses = 3 and 6 parallel joins → exactly 3 × 201 and 3 × 404; use_count = 3', async () => {
    const c = await cast();
    const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.a.memberId, maxUses: 3 });
    const joiners = await Promise.all(Array.from({ length: 6 }, () => seedP()));
    const before = await memberCount(c.org);
    const rs = await raceOnOrgLock(c.org.orgId, 6, () => Promise.all(joiners.map((p) => joinInviteLink(app, p, { token: link.token }))));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 201, 201, 404, 404, 404]);
    expect((await sql(c.org, 'SELECT use_count FROM org_invite_links WHERE id = $1', [link.id])).rows).toEqual([{ use_count: 3 }]);
    expect(await memberCount(c.org)).toBe(before + 3);
  });
  it('T-3: an invitation and a link of the same org for the same user in parallel → one 201, one 409 already_member; the loser leaves no trace', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const p = await seedP();
      const inv = await seedInvitation(c.org, { email: p.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId });
      const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.a.memberId, maxUses: 2 });
      const [a, j] = await raceOnOrgLock(c.org.orgId, 2, () => Promise.all([acceptInvitation(app, p, { token: inv.token }), joinInviteLink(app, p, { token: link.token })]));
      expect([a.status, j.status].sort()).toEqual([201, 409]);
      const invStatus = (await sql(c.org, 'SELECT status FROM org_invitations WHERE id = $1', [inv.id])).rows[0]?.status;
      const uses = (await sql(c.org, 'SELECT use_count FROM org_invite_links WHERE id = $1', [link.id])).rows[0]?.use_count;
      expect([invStatus, uses]).toEqual(a.status === 201 ? ['ACCEPTED', 0] : ['PENDING', 1]);
    }
  });
  it('T-4: two admins invite the same email in parallel → one 201, one 409 invitation_pending_exists', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const email = `t4-${v7()}@example.test`;
      const rs = await raceOnOrgLock(c.org.orgId, 2, () => Promise.all([invite(c.O, c.org, email, c.org.roles.MEMBER.publicId), invite(c.A, c.org, email, c.org.roles.MEMBER.publicId)]));
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(rs.find((r) => r.status === 409)?.body.code).toBe('invitation_pending_exists');
    }
  });
  it('T-11: the per-org caps hold under parallel creates (invitations and links)', async () => {
    const c = await cast();
    const rs = await raceOnOrgLock(c.org.orgId, 6, () =>
      Promise.all(Array.from({ length: 6 }, () => invite(c.A, c.org, `t11-${v7()}@example.test`, c.org.roles.MEMBER.publicId))),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(PENDING_CAP);
    expect(rs.filter((r) => r.status === 422).map((r) => r.body.code)).toEqual(Array(6 - PENDING_CAP).fill('pending_invitations_limit'));
    const ls = await raceOnOrgLock(c.org.orgId, 5, () => Promise.all(Array.from({ length: 5 }, () => createLink(c.A, c.org, c.org.roles.MEMBER.publicId))));
    expect(ls.filter((r) => r.status === 201)).toHaveLength(LINK_CAP);
    expect(ls.filter((r) => r.status === 422).map((r) => r.body.code)).toEqual(Array(5 - LINK_CAP).fill('invite_links_limit'));
  });
  it('T-9 (invitation/link part): deleting a role races creating an invitation or a link with it → never both succeed, never a dangling role', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      for (const create of [
        (roleId: string) => invite(c.O, c.org, `t9-${v7()}@example.test`, roleId),
        (roleId: string) => createLink(c.O, c.org, roleId),
      ]) {
        const role = await seedCustomRole(c.org, { permissions: ROLE_SET_C0, name: `T9 ${v7()}` });
        const [made, del] = await raceOnOrgLock(c.org.orgId, 2, () => Promise.all([create(role.publicId), authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/roles/${role.publicId}`)]));
        const pair = `${made.status}/${del.status}`;
        expect(['201/409', '422/204'], pair).toContain(pair);
        if (del.status === 409) expect(del.body.code).toBe('role_in_use');
        if (made.status === 422) expect(made.body.code).toBe('validation_failed');
      }
    }
  });
  it('T-16: accept ∥ decline ∥ cancel of one transfer → exactly one wins, the others 409 ownership_transfer_not_pending', async () => {
    const c = await cast();
    for (let i = 0; i < ROUNDS; i++) {
      const t = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.m.memberId });
      const base = `/v1/orgs/${c.org.orgId}/ownership-transfers/${t.publicId}`;
      const rs = await raceOnOrgLock(c.org.orgId, 3, () =>
        Promise.all([
          authed(app, c.M).post(`${base}/accept`).set('idempotency-key', `k-${v7()}`).send({}),
          authed(app, c.M).post(`${base}/decline`).set('idempotency-key', `k-${v7()}`).send({}),
          authed(app, c.O).delete(base),
        ]),
      );
      expect(rs.filter((r) => r.status === 200 || r.status === 204)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(['ownership_transfer_not_pending', 'ownership_transfer_not_pending']);
      // Nếu accept thắng, M thành owner: hạ M về MEMBER bằng SQL cho vòng sau (O vẫn là owner).
      await sql(c.org, 'UPDATE org_members SET role_id = $1 WHERE id = $2', [c.org.roles.MEMBER.id, c.m.memberId]);
    }
  });
  it('T-21: two admins revoke one invitation → one 204, one 409 invitation_not_pending', async () => {
    const c = await cast();
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await seedInvitation(c.org, { email: `t21-${v7()}@example.test`, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId });
      const url = `/v1/orgs/${c.org.orgId}/invitations/${inv.publicId}`;
      const rs = await raceOnOrgLock(c.org.orgId, 2, () => Promise.all([authed(app, c.O).delete(url), authed(app, c.A).delete(url)]));
      expect(rs.map((r) => r.status).sort()).toEqual([204, 409]);
    }
  });
  it('T-27 / X-8: accepting races a soft delete → (201, ACCEPTED) or (404, REVOKED); the soft delete always wins its own 204', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const p = await seedP();
      const inv = await seedInvitation(c.org, { email: p.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId });
      const [acc, del] = await raceOnOrgLock(c.org.orgId, 2, () => Promise.all([acceptInvitation(app, p, { token: inv.token }), authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}`)]));
      expect(del.status).toBe(204);
      const status = (await sql(c.org, 'SELECT status FROM org_invitations WHERE id = $1', [inv.id])).rows[0]?.status;
      expect([acc.status, status]).toEqual(acc.status === 201 ? [201, 'ACCEPTED'] : [404, 'REVOKED']);
    }
  });
  it('T-29 / X-11: waiting on the org lock past expires_at → accept 404, join 404, transfer accept 409; rows read EXPIRED where stored', async () => {
    const c = await cast();
    const p = await seedP();
    const inv = await seedInvitation(c.org, { email: p.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId, expiresInSec: EXPIRES_IN_SEC });
    const acc = await holdOrgLockPast(c.org, Date.now() + HOLD_PAST_EXPIRY_MS, () => acceptInvitation(app, p, { token: inv.token }));
    expect([acc.status, acc.body.code]).toEqual([404, 'invitation_not_found']);
    expect((await sql(c.org, 'SELECT status FROM org_invitations WHERE id = $1', [inv.id])).rows).toEqual([{ status: 'EXPIRED' }]);
    const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.a.memberId, expiresInSec: EXPIRES_IN_SEC });
    const join = await holdOrgLockPast(c.org, Date.now() + HOLD_PAST_EXPIRY_MS, () => joinInviteLink(app, p, { token: link.token }));
    expect([join.status, join.body.code]).toEqual([404, 'invite_link_not_found']);
    expect((await sql(c.org, 'SELECT use_count FROM org_invite_links WHERE id = $1', [link.id])).rows).toEqual([{ use_count: 0 }]);
    const t = await seedTransfer(c.org, { fromMemberId: c.org.owner.memberId, toMemberId: c.m.memberId, expiresInSec: EXPIRES_IN_SEC });
    const ta = await holdOrgLockPast(c.org, Date.now() + HOLD_PAST_EXPIRY_MS, () =>
      authed(app, c.M).post(`/v1/orgs/${c.org.orgId}/ownership-transfers/${t.publicId}/accept`).set('idempotency-key', `k-${v7()}`).send({}),
    );
    expect([ta.status, ta.body.code]).toEqual([409, 'ownership_transfer_not_pending']);
    expect((await sql(c.org, 'SELECT status FROM org_ownership_transfers WHERE id = $1', [t.id])).rows).toEqual([{ status: 'EXPIRED' }]);
  });
  it(`T-18 / O-12: account deletion races accepting an invitation × ${ROUNDS} → never a 5xx, never an orphan; a 409 keeps the account`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const c = await cast();
      const u = await seedP();
      const inv = await seedInvitation(c.org, { email: u.email, roleId: c.org.roles.MEMBER.id, inviterMemberId: c.a.memberId });
      const [acc, del] = await Promise.all([
        acceptInvitation(app, u, { token: inv.token }),
        authed(app, admin).post('/api/auth/admin/remove-user').set('origin', 'http://localhost:3000').send({ userId: u.authUserId }),
      ]);
      expect(acc.status).toBeLessThan(500);
      expect(del.status).toBeLessThan(500);
      const tenancyRows = await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [u.authUserId]);
      const authRows = await ownerQuery('SELECT 1 FROM auth."user" WHERE id = $1', [u.authUserId]);
      if (del.status === 200) expect([tenancyRows.length, authRows.length]).toEqual([0, 0]);
      else {
        expect([del.status, del.body.code]).toEqual([409, 'user_deletion_blocked']);
        expect(authRows).toHaveLength(1);
      }
    }
  });
});
```
(T-3: không có hai lời mời `PENDING` cùng `(org, email)` — partial `UNIQUE` của T-4 — nên "hai lời mời khác nhau cho cùng user" trong cùng org là một lời mời và một link; giữa hai org thì không có race vì `UNIQUE (org_id, user_id)` theo org. Ghi ở "Lệch có chủ đích".)

- [ ] **Step 2: Chạy (lặp để tìm flake), commit**

Run:
```bash
pnpm vitest run --project integration test/e2e/tenancy/acquisition-races.e2e.spec.ts
for i in 1 2 3; do pnpm vitest run --project integration test/e2e/tenancy/acquisition-races.e2e.spec.ts || break; done
```
Expected: PASS ba lần liền; không deadlock (`40P01` hết retry sẽ thành `503` và làm ca đỏ). Ca nào đỏ: tìm nguyên nhân gốc (skill `superpowers:systematic-debugging`) trong thứ tự khoá §8.6, không nới assert.
```bash
pnpm exec prettier --write test/e2e/tenancy/acquisition-races.e2e.spec.ts
git add test/e2e/tenancy/acquisition-races.e2e.spec.ts
git commit -m "test(tenancy): acquisition races on the org lock — parallel accepts, link N+k, caps, role delete, transfer CAS, expiry while waiting, account deletion"
```

---

### Task 14: Chế độ `external` (tiêu chí 13) — claim email đã xác thực, không thư chuyển quyền, cờ `auto` tắt êm

**Files:**
- Create: `test/e2e/tenancy/acquisition-external.e2e.spec.ts`

**Interfaces:**
- Consumes: `startFakeJwks`, `FakeJwks.sign` (SP2), env external của `auth-modes.e2e.spec.ts` (3A), `AUTH_EXTERNAL_EMAIL_CLAIM`/`_VERIFIED_CLAIM` (Task 5), `tokenFromMail`, `acceptInvitation` không dùng được (helper dùng bearer của principal seed) → test gọi `request(app.getHttpServer())` với JWT; `seedOrg({ owner: { externalSubject } })`, `seedMember`.
- Produces: bằng chứng spec §11 hàng "Lời mời email", "Thư chuyển quyền sở hữu" và §13 `auto`.

- [ ] **Step 1: Test**

`test/e2e/tenancy/acquisition-external.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { tokenFromMail } from '../../support/tenancy-acquisition.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const TOKEN_TTL_SEC = 300;
const nowSec = () => Math.floor(Date.now() / 1000);
const externalEnv = (jwks: FakeJwks): Record<string, string> => ({
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
});

describe('acquisition in AUTH_MODE=external with AUTH_EXTERNAL_EMAIL_CLAIM (spec SP3 §11, §13; tiêu chí 13)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const mail = mailpitFromInfra();
  const orgs: SeededOrg[] = [];
  const bearer = (sub: string, extra: Record<string, unknown> = {}) =>
    jwks.sign({ iss: ISS, aud: AUD, sub, iat: nowSec(), exp: nowSec() + TOKEN_TTL_SEC, idtyp: 'user', auth_time: nowSec(), ...extra });
  const as = async (sub: string, extra: Record<string, unknown> = {}) => {
    const t = await bearer(sub, extra);
    const agent = request(app.getHttpServer());
    return {
      post: (url: string, body: object) => agent.post(url).set('authorization', `Bearer ${t}`).set('idempotency-key', `k-${v7()}`).send(body),
      get: (url: string) => agent.get(url).set('authorization', `Bearer ${t}`),
    };
  };
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startTenancyApp({ extraImports: [ResilienceModule], env: { ...externalEnv(jwks), AUTH_EXTERNAL_EMAIL_CLAIM: 'email' } });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('invite (no inviter name) → mail → accept with a verified email claim of another case → 201; member email/name are null', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner }, name: 'Ext Org' });
    orgs.push(org);
    const email = `ext-${v7()}@example.test`;
    const after = await mail.now();
    const created = await (await as(owner)).post(`/v1/orgs/${org.orgId}/invitations`, { email, roleId: org.roles.MEMBER.publicId });
    expect(created.status).toBe(201);
    const msg = await mail.waitFor(email, { subject: /You're invited to join Ext Org/, after });
    expect(msg.Text).toContain('You are invited to join Ext Org as Member.');
    const token = await tokenFromMail(mail, email, /You're invited/, after);
    const invitee = `ext-i-${v7()}`;
    const accepted = await (await as(invitee, { email: email.toUpperCase(), email_verified: true })).post('/v1/invitations/accept', { token });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ email: null, name: null });
  });
  it('an email claim that is not exactly verified (string "true", false, missing) → 403 email_not_verified and the invitation stays pending', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const email = `ext-nv-${v7()}@example.test`;
    const after = await mail.now();
    expect((await (await as(owner)).post(`/v1/orgs/${org.orgId}/invitations`, { email, roleId: org.roles.MEMBER.publicId })).status).toBe(201);
    const token = await tokenFromMail(mail, email, /You're invited/, after);
    for (const claims of [{ email, email_verified: 'true' }, { email, email_verified: false }, { email_verified: true }])
      expect((await (await as(`ext-x-${v7()}`, claims)).post('/v1/invitations/accept', { token })).body.code, JSON.stringify(claims)).toBe('email_not_verified');
    expect((await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('SELECT status FROM org_invitations')))).rows).toEqual([{ status: 'PENDING' }]);
  });
  it('ownership transfer in external: no email is requested; the recipient finds it with GET ?status=PENDING and accepts', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const to = `ext-t-${v7()}`;
    const m = await seedMember(org, 'MEMBER', { externalSubject: to });
    const r = await (await as(owner)).post(`/v1/orgs/${org.orgId}/ownership-transfers`, { toMemberId: m.memberPublicId });
    expect(r.status).toBe(201);
    expect(await ownerQuery('SELECT 1 FROM email_deliveries WHERE idempotency_key = $1', [`ownership-transfer-requested:${r.body.id}`])).toEqual([]);
    const listed = await (await as(to)).get(`/v1/orgs/${org.orgId}/ownership-transfers?status=PENDING`);
    expect(listed.body.data.map((t: { id: string }) => t.id)).toEqual([r.body.id]);
    expect((await (await as(to)).post(`/v1/orgs/${org.orgId}/ownership-transfers/${r.body.id}/accept`, {})).status).toBe(200);
  });
  it('invite links need no email claim: create → join with a plain external token → 201', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const link = await (await as(owner)).post(`/v1/orgs/${org.orgId}/invite-links`, {
      roleId: org.roles.MEMBER.publicId,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(link.status).toBe(201);
    const token = /#token=([A-Za-z0-9_-]{43})$/.exec(String(link.body.url))?.[1] ?? '';
    expect((await (await as(`ext-j-${v7()}`)).post('/v1/invite-links/join', { token })).status).toBe(201);
  });
});

describe('external without AUTH_EXTERNAL_EMAIL_CLAIM: email invitations auto-disable, nothing refuses to boot (INT-I12)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startTenancyApp({ extraImports: [ResilienceModule], env: externalEnv(jwks) });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('POST invitations → 403 feature_disabled; invite links still work', async () => {
    const owner = `ext-o-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: owner } });
    orgs.push(org);
    const t = await jwks.sign({ iss: ISS, aud: AUD, sub: owner, iat: nowSec(), exp: nowSec() + TOKEN_TTL_SEC, idtyp: 'user', auth_time: nowSec() });
    const http = () => request(app.getHttpServer());
    const inv = await http().post(`/v1/orgs/${org.orgId}/invitations`).set('authorization', `Bearer ${t}`).set('idempotency-key', `k-${v7()}`).send({ email: `x-${v7()}@example.test`, roleId: org.roles.MEMBER.publicId });
    expect([inv.status, inv.body.code]).toEqual([403, 'feature_disabled']);
    const link = await http()
      .post(`/v1/orgs/${org.orgId}/invite-links`)
      .set('authorization', `Bearer ${t}`)
      .send({ roleId: org.roles.MEMBER.publicId, maxUses: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(link.status).toBe(201);
  });
});
```

- [ ] **Step 2: Chạy, commit**

Run: `pnpm vitest run --project integration test/e2e/tenancy/acquisition-external.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts`
Expected: PASS; `auth-modes` (env external của SP2, không env mới) vẫn khởi động, log INFO `tenancy_features` ghi `emailInvitations: MISSING_EMAIL_CLAIM`.
```bash
pnpm exec prettier --write test/e2e/tenancy/acquisition-external.e2e.spec.ts
git add test/e2e/tenancy/acquisition-external.e2e.spec.ts
git commit -m "test(tenancy): acquisition in external mode — verified email claim, no transfer mail, invitations auto-disable without the claim"
```

---

### Task 15: Chaos và PII của đường lỗi 3C — DB mất giữa chấp nhận/join (tiêu chí 12), giết api giữa transaction chấp nhận (tiêu chí 11), Redis sập (preview, accept), log/span/metric/failed reason không email/token (tiêu chí 16)

**Files:**
- Create: `test/chaos/tenancy-acquisition-outages.spec.ts`, `test/chaos/tenancy-acquisition-api-kill.spec.ts`, `test/e2e/tenancy/acquisition-pii-logs.e2e.spec.ts`

**Interfaces:**
- Consumes: `startTcpProxy` (SP1 `tcp-proxy.ts`), `getInfra().pgbouncer`, `SqlInvitationRepository`, `SqlInviteLinkRepository` (Task 7, provider `useExisting`), `Db`, Toxiproxy + `readImages()` (mẫu `tenancy-outages.spec.ts` của 3A), `startAppProcess`/`stopAppProcess`, `api-entry.ts`, `worker-entry.ts`, `exitCode`, `installOtelCapture`, `seedInvitation`, `seedInviteLink`, `acceptInvitation`, `joinInviteLink`, `previewToken`, `previewIp`.
- Produces: bằng chứng tiêu chí 11, 12, 16 cho phần 3C; chaos Redis cho bucket preview.

- [ ] **Step 1: DB mất đúng lúc khoá lời mời/link, và Redis sập**

`test/chaos/tenancy-acquisition-outages.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { ToxiProxyContainer, type CreatedProxy, type StartedToxiProxyContainer } from '@testcontainers/toxiproxy';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/core/database/index.js';
import { SqlInvitationRepository } from '../../src/modules/tenancy/infra/sql/sql-invitation.repository.js';
import { SqlInviteLinkRepository } from '../../src/modules/tenancy/infra/sql/sql-invite-link.repository.js';
import type { InvitationRow } from '../../src/modules/tenancy/ports/invitation-repository.js';
import type { InviteLinkRow } from '../../src/modules/tenancy/ports/invite-link-repository.js';
import { getInfra } from '../support/infra.js';
import { readImages } from '../support/images.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import { acceptInvitation, joinInviteLink, previewIp, previewToken } from '../support/tenancy-acquisition.js';
import { startTenancyApp } from '../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { inOrgTx, newToken, seedInvitation, seedInviteLink, seedOrg, withAppClient, type SeededOrg } from '../support/tenancy-seed.js';

const OUTAGE_BOUND_MS = 20_000;
const RECOVERY = { timeout: 30_000, interval: 250 };
const REDIS_PORT = 6379;
const PREVIEW_LIMIT = 3;

/** Bật blackhole đúng lúc câu khoá lời mời chạy: khoá org và khoá tenancy_users đã xong qua proxy. */
class BlackholeOnInvitationLock extends SqlInvitationRepository {
  armed: TcpProxy | undefined;
  override lockById(id: string): Promise<InvitationRow | undefined> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return super.lockById(id);
  }
}
class BlackholeOnLinkLock extends SqlInviteLinkRepository {
  armed: TcpProxy | undefined;
  override lockById(id: string): Promise<InviteLinkRow | undefined> {
    const proxy = this.armed;
    this.armed = undefined;
    if (proxy) proxy.state.blackhole = true;
    return super.lockById(id);
  }
}

describe('app DB lost inside accept and join (spec SP3 tiêu chí 12, phần 3C)', () => {
  let proxy: TcpProxy;
  let app: INestApplication;
  let invitations: BlackholeOnInvitationLock | undefined;
  let links: BlackholeOnLinkLock | undefined;
  let owner: SeededPrincipal;
  let invitee: SeededPrincipal;
  let org: SeededOrg;
  const sql = (q: string, params: unknown[] = []) => withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(q, params)));
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    app = await startTenancyApp({
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port), THROTTLE_DEFAULT_LIMIT: '100000' },
      configure: (b) =>
        b
          .overrideProvider(SqlInvitationRepository)
          .useFactory({ factory: (db: Db) => (invitations = new BlackholeOnInvitationLock(db)), inject: [Db] })
          .overrideProvider(SqlInviteLinkRepository)
          .useFactory({ factory: (db: Db) => (links = new BlackholeOnLinkLock(db)), inject: [Db] }),
    });
    owner = await seedUserPrincipal();
    invitee = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    proxy.state.blackhole = false;
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await deleteSeededPrincipals([owner, invitee]);
    vi.unstubAllEnvs();
  });

  it('accept: DB lost at the invitation lock → 503 + Retry-After within the bound; the invitation stays PENDING, no member; a retry after recovery is 201', async () => {
    const repo = invitations;
    if (!repo) throw new Error('the SqlInvitationRepository override was not built');
    const inv = await seedInvitation(org, { email: invitee.email, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    repo.armed = proxy;
    try {
      const started = performance.now();
      const r = await acceptInvitation(app, invitee, { token: inv.token });
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(repo.armed).toBeUndefined();
    } finally {
      repo.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(async () => expect((await sql('SELECT status FROM org_invitations WHERE id = $1', [inv.id])).rows).toEqual([{ status: 'PENDING' }]), RECOVERY);
    await vi.waitFor(async () => expect((await acceptInvitation(app, invitee, { token: inv.token })).status).toBe(201), RECOVERY);
  });
  it('join: DB lost at the link lock → 503; use_count unchanged; a retry after recovery is 201', async () => {
    const repo = links;
    if (!repo) throw new Error('the SqlInviteLinkRepository override was not built');
    const joiner = await seedUserPrincipal();
    try {
      const link = await seedInviteLink(org, { roleId: org.roles.MEMBER.id, createdByMemberId: org.owner.memberId });
      repo.armed = proxy;
      try {
        const r = await joinInviteLink(app, joiner, { token: link.token });
        expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      } finally {
        repo.armed = undefined;
        proxy.state.blackhole = false;
      }
      await vi.waitFor(async () => expect((await joinInviteLink(app, joiner, { token: link.token })).status).toBe(201), RECOVERY);
      expect((await sql('SELECT use_count FROM org_invite_links WHERE id = $1', [link.id])).rows).toEqual([{ use_count: 1 }]);
    } finally {
      await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM org_members WHERE user_id = (SELECT id FROM tenancy_users WHERE auth_user_id = $1)', [joiner.authUserId])));
      await deleteSeededPrincipals([joiner]);
    }
  });
});

describe('Redis down: token previews fall back to the per-pod insurance limiter, accept (idempotent) answers 503 (spec §18.4, CDX-13)', () => {
  let network: StartedNetwork | undefined;
  let redis: StartedTestContainer | undefined;
  let toxi: StartedToxiProxyContainer | undefined;
  let proxy: CreatedProxy | undefined;
  let app: INestApplication | undefined;
  let owner: SeededPrincipal;
  let invitee: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const images = readImages();
    if (!images.IMAGE_REDIS || !images.IMAGE_TOXIPROXY) throw new Error('IMAGE_REDIS and IMAGE_TOXIPROXY must be pinned in docker/images.env');
    network = await new Network().start();
    redis = await new GenericContainer(images.IMAGE_REDIS).withNetwork(network).withNetworkAliases('redis').withExposedPorts(REDIS_PORT).start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY).withNetwork(network).start();
    proxy = await toxi.createProxy({ name: 'redis', upstream: `redis:${REDIS_PORT}` });
    app = await startTenancyApp({
      env: {
        REDIS_URL: `redis://${proxy.host}:${proxy.port}`,
        HTTP_TRUST_PROXY: 'loopback',
        TENANCY_TOKEN_PREVIEW_RATE_LIMIT: String(PREVIEW_LIMIT),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
    });
    owner = await seedUserPrincipal();
    invitee = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    await proxy?.setEnabled(true);
    await org?.dispose();
    await app?.close();
    await toxi?.stop();
    await redis?.stop();
    await network?.stop();
    await deleteSeededPrincipals([owner, invitee]);
    vi.unstubAllEnvs();
  });

  it('previews: PREVIEW_LIMIT × 404 then 429 from one IP while Redis is down; accept → 503 and the invitation stays PENDING', async () => {
    if (!app || !proxy) throw new Error('not started');
    const inv = await seedInvitation(org, { email: invitee.email, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    await proxy.setEnabled(false);
    try {
      const ip = previewIp();
      for (let i = 0; i < PREVIEW_LIMIT; i++) expect((await previewToken(app, 'invitations', { token: newToken() }, ip)).status, `preview ${i + 1}`).toBe(404);
      expect((await previewToken(app, 'invitations', { token: newToken() }, ip)).status).toBe(429);
      expect((await acceptInvitation(app, invitee, { token: inv.token })).status).toBe(503);
    } finally {
      await proxy.setEnabled(true);
    }
    expect((await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('SELECT status FROM org_invitations WHERE id = $1', [inv.id])))).rows).toEqual([
      { status: 'PENDING' },
    ]);
  });
});
```
(`ToxiProxyContainer`/`GenericContainer` và `readImages` là đúng các import của `test/chaos/tenancy-outages.spec.ts` của 3A; ảnh pin ở `docker/images.env`. Lần `@Idempotent()` lúc Redis sập trả `503` theo chính sách của SP1, không chạm DB nên lời mời còn PENDING.)

- [ ] **Step 2: Giết api giữa transaction chấp nhận (tiêu chí 11)**

`test/chaos/tenancy-acquisition-api-kill.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../support/app-process.js';
import { baseTestEnv } from '../support/env.js';
import { ownerQuery } from '../support/identity-app.js';
import { exitCode } from '../support/spawn-worker.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { inOrgTx, seedInvitation, seedOrg, withAppClient, type SeededInvitation, type SeededOrg } from '../support/tenancy-seed.js';

const WAIT_MS = 60_000;
const API_ENTRY = 'test/support/api-entry.ts';
const PROCESS_ENV: Record<string, string> = { HTTP_PORT: '0', HTTP_HOST: '127.0.0.1', HTTP_TRUST_PROXY: 'loopback' };

const until = async (pred: () => Promise<boolean>, ms = WAIT_MS): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const startApi = async (): Promise<AppProcess & { port: number }> => {
  const api = await startAppProcess(API_ENTRY, { ...baseTestEnv(), ...PROCESS_ENV });
  if (api.port === undefined) {
    await stopAppProcess(api);
    throw new Error('api-entry reported no port');
  }
  return { ...api, port: api.port };
};
const accept = (port: number, p: SeededPrincipal, token: string) =>
  fetch(`http://127.0.0.1:${port}/v1/invitations/accept`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.bearer}`, 'content-type': 'application/json', 'idempotency-key': `kill-${Date.now()}` },
    body: JSON.stringify({ token }),
  });

/**
 * Spec SP3 §1 tiêu chí 11 cho chấp nhận lời mời (§18.4): test giữ `FOR UPDATE` trên dòng role MEMBER của org (bằng
 * `app_user` trong OrgScope: bảng FORCE RLS). Transaction chấp nhận đứng chờ ở kiểm FK `FOR KEY SHARE` của câu `INSERT
 * org_members` — SAU khi đã khoá org, upsert `tenancy_users`, khoá lời mời và kiểm lại người mời — TRƯỚC CAS ACCEPTED và
 * event. SIGKILL api → PgBouncer đóng connection server → rollback: lời mời PENDING, không member, không event.
 */
describe('api killed inside the accept transaction (spec SP3 tiêu chí 11, phần 3C)', () => {
  const apis: AppProcess[] = [];
  let owner: SeededPrincipal | undefined;
  let invitee: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  let inv: SeededInvitation | undefined;
  beforeAll(async () => {
    owner = await seedUserPrincipal();
    invitee = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    inv = await seedInvitation(org, { email: invitee.email, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
  });
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    await org?.dispose();
    if (owner && invitee) await deleteSeededPrincipals([owner, invitee]);
  });

  it('SIGKILL while the member insert waits: invitation PENDING, no member, no event; a fresh api accepts exactly once', async () => {
    if (!owner || !invitee || !org || !inv) throw new Error('not seeded');
    // Hằng cục bộ: thu hẹp kiểu của biến `let` không đi qua các closure bên dưới.
    const p = invitee;
    const o = org;
    const invId = inv.id;
    const token = inv.token;
    const state = async () => ({
      status: (await withAppClient((c) => inOrgTx(c, o.orgId, () => c.query('SELECT status FROM org_invitations WHERE id = $1', [invId])))).rows[0]?.status,
      members: (
        await withAppClient((c) =>
          inOrgTx(c, o.orgId, () => c.query('SELECT 1 FROM org_members m JOIN tenancy_users u ON u.id = m.user_id WHERE u.auth_user_id = $1', [p.authUserId])),
        )
      ).rows.length,
      events: (await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type IN ('tenancy.invitation.accepted', 'tenancy.member.added')`, [o.orgId])).length,
    });
    const first = await startApi();
    apis.push(first);
    let blocked: number[] = [];
    await withAppClient(async (lock) => {
      await lock.query('BEGIN');
      try {
        await lock.query(`SELECT set_config('app.org_id', $1, true)`, [o.orgId]);
        await lock.query('SELECT 1 FROM org_roles WHERE id = $1 FOR UPDATE', [o.roles.MEMBER.id]);
        const [{ pid } = { pid: -1 }] = (await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
        const pending = accept(first.port, p, token).then(
          (r) => r.status,
          (err: unknown) => err,
        );
        await until(async () => {
          blocked = (await ownerQuery<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).map((r) => r.pid);
          return blocked.length > 0;
        });
        const exited = exitCode(first.child);
        first.child.kill('SIGKILL');
        await exited;
        expect(await pending).toBeInstanceOf(Error);
        await lock.query('COMMIT');
      } catch (err) {
        await lock.query('ROLLBACK');
        throw err;
      }
    });
    // Chờ backend bị bỏ rơi kết thúc (PgBouncer đóng connection server của client đã chết → rollback).
    await until(async () => (await ownerQuery(`SELECT 1 FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state <> 'idle'`, [blocked])).length === 0);
    expect(await state()).toEqual({ status: 'PENDING', members: 0, events: 0 });
    const second = await startApi();
    apis.push(second);
    expect((await accept(second.port, p, token)).status).toBe(201);
    expect(await state()).toEqual({ status: 'ACCEPTED', members: 1, events: 2 });
  }, 120_000);
});
```

- [ ] **Step 3: PII ở log, span, metric và failed reason (tiêu chí 16)**

`test/e2e/tenancy/acquisition-pii-logs.e2e.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { hashToken, newToken, seedInvitation, seedInviteLink, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const PROCESS_ENV: Record<string, string> = { LOG_LEVEL: 'debug', HTTP_PORT: '0', HTTP_HOST: '127.0.0.1', HTTP_TRUST_PROXY: 'loopback' };
/** Cổng không có SMTP: mọi lần gửi thư mời thất bại `SMTP_CONNECTION` (spec §18.4 "SMTP lỗi khi gửi thư mời"). */
const DEAD_SMTP = { SMTP_HOST: '127.0.0.1', SMTP_PORT: '9' };

/** Spec SP3 §16, §18.4, tiêu chí 16: email được mời, token, `token_hash` không vào log api/worker hay failed reason. */
describe('no invited email, token or token hash in the logs and failure records of the 3C error paths', () => {
  let api: AppProcess | undefined;
  let worker: AppProcess | undefined;
  let owner: SeededPrincipal;
  let stranger: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    api = await startAppProcess('test/support/api-entry.ts', { ...baseTestEnv(), ...PROCESS_ENV, ...DEAD_SMTP });
    worker = await startAppProcess('test/support/worker-entry.ts', { ...baseTestEnv(), APP_ROLE: 'worker', LOG_LEVEL: 'debug', ...DEAD_SMTP });
    owner = await seedUserPrincipal();
    stranger = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await stopAppProcess(worker);
    await org?.dispose();
    await deleteSeededPrincipals([owner, stranger]);
  });

  it('a mail that cannot be sent, an email mismatch, unknown tokens and previews leave no email, token or hash anywhere', async () => {
    const base = `http://127.0.0.1:${api?.port}`;
    const call = (p: SeededPrincipal | undefined, method: string, path: string, body?: object) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          ...(p ? { authorization: `Bearer ${p.bearer}` } : {}),
          'content-type': 'application/json',
          'idempotency-key': `k-${v7()}`,
          'x-forwarded-for': '198.18.7.7',
        },
        body: body && JSON.stringify(body),
      });
    const invited = `pii-${v7()}@example.test`;
    const created = await call(owner, 'POST', `/v1/orgs/${org.orgId}/invitations`, { email: invited, roleId: org.roles.MEMBER.publicId });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const mismatch = await seedInvitation(org, { email: `other-${v7()}@example.test`, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    expect((await call(stranger, 'POST', '/v1/invitations/accept', { token: mismatch.token })).status).toBe(403);
    const unknown = newToken();
    expect((await call(stranger, 'POST', '/v1/invitations/accept', { token: unknown })).status).toBe(404);
    expect((await call(undefined, 'POST', '/v1/invitations/preview', { token: unknown })).status).toBe(404);
    const link = await seedInviteLink(org, { roleId: org.roles.MEMBER.id, createdByMemberId: org.owner.memberId });
    expect((await call(undefined, 'POST', '/v1/invite-links/preview', { token: link.token })).status).toBe(200);
    // Worker đã thử gửi và thất bại (failed reason chỉ là mã enum của SP2).
    const failed = async () =>
      ownerQuery<{ code: string | null }>(`SELECT last_error_code AS code FROM email_deliveries WHERE idempotency_key = $1`, [`org-invitation:${id}`]);
    for (let i = 0; i < 300 && (await failed())[0]?.code == null; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await failed())[0]?.code).toBe('SMTP_CONNECTION');
    await new Promise((r) => setTimeout(r, 1_000));
    const output = `${api?.output() ?? ''}${worker?.output() ?? ''}`;
    for (const secret of [invited, mismatch.token, hashToken(mismatch.token), unknown, hashToken(unknown), link.token, hashToken(link.token), owner.bearer, stranger.bearer])
      expect(output.includes(secret)).toBe(false);
    expect(output).not.toContain('#token=');
    // Đường lỗi có dấu vết (mã lỗi), chỉ là không mang dữ liệu: đúng một dòng metric/log mang mã enum.
    expect(output).toContain('invitation_email_mismatch');
  });
});
```
(Span và label metric của 3C — `tenancy.invitation.accept`, `tenancy.invite_link.join`, `tenancy.member.admit`, `tenancy_invitations_total{result}`, `tenancy_invite_link_joins_total{result}` — được ca "no attribute value contains an id, email or token" của `test/e2e/tenancy/telemetry-pii.e2e.spec.ts` (3A) phủ khi Step 4 thêm luồng 3C vào nó.)

- [ ] **Step 4: Span và metric không định danh**

`test/e2e/tenancy/telemetry-pii.e2e.spec.ts` — import thêm `acceptInvitation`, `joinInviteLink` từ `../../support/tenancy-acquisition.js`, `seedInvitation`, `seedInviteLink` từ `../../support/tenancy-seed.js`; trong ca hiện có, ngay trước `const policyResults = …` thêm:
```ts
    // 3C: chấp nhận (thành công + email sai), join; span §16 của 3C có mặt, attribute chỉ là enum.
    const invitee = await seedUserPrincipal();
    const inv = await seedInvitation(org, { email: invitee.email, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    expect((await acceptInvitation(app, invitee, { token: inv.token })).status).toBe(201);
    const wrong = await seedInvitation(org, { email: `nobody-${v7()}@example.test`, roleId: org.roles.MEMBER.id, inviterMemberId: org.owner.memberId });
    expect((await acceptInvitation(app, member, { token: wrong.token })).status).toBe(403);
    const link = await seedInviteLink(org, { roleId: org.roles.MEMBER.id, createdByMemberId: org.owner.memberId });
    const joiner = await seedUserPrincipal();
    expect((await joinInviteLink(app, joiner, { token: link.token })).status).toBe(201);
    expect(otel.spanNames()).toEqual(expect.arrayContaining(['tenancy.invitation.accept', 'tenancy.invite_link.join']));
    expect(await otel.metric('tenancy_invitations_total', { result: 'email_mismatch' })).toBe(1);
```
và nối vào mảng `forbidden`: `invitee.email, invitee.bearer, joiner.bearer, inv.token, wrong.token, link.token, hashToken(inv.token)` (import `hashToken`); `afterAll` thêm `invitee`, `joiner` vào `deleteSeededPrincipals` (khai hai biến ở phạm vi `describe`, gán trong ca). Ca `admits` đổi kỳ vọng `toHaveLength(1)` thành `toHaveLength(3)` và kiểm tập nguồn `['CREATOR', 'INVITATION', 'INVITE_LINK']`.

- [ ] **Step 5: Chạy, commit**

Run:
```bash
pnpm vitest run --project chaos test/chaos/tenancy-acquisition-outages.spec.ts test/chaos/tenancy-acquisition-api-kill.spec.ts
pnpm vitest run --project integration test/e2e/tenancy/acquisition-pii-logs.e2e.spec.ts test/e2e/tenancy/telemetry-pii.e2e.spec.ts
```
Expected: PASS; nếu backend bị bỏ rơi commit thay vì rollback, ca kill đỏ ở `state()` — đó là lỗi cần sửa (không nới).
```bash
pnpm exec prettier --write test/chaos test/e2e/tenancy
git add test/chaos/tenancy-acquisition-outages.spec.ts test/chaos/tenancy-acquisition-api-kill.spec.ts test/e2e/tenancy/acquisition-pii-logs.e2e.spec.ts test/e2e/tenancy/telemetry-pii.e2e.spec.ts
git commit -m "test(tenancy): acquisition chaos (DB loss in accept/join, Redis down, api killed mid-accept) and no PII in logs, spans, metrics or failure records"
```

---

## Phần G — Prod-like, tài liệu, bàn giao (spec §18.4, §22)

### Task 16: Kiểm chứng prod-like #2 — luồng thu nhận trên image production; đo lại kích thước image (ADR 0013)

**Files:**
- Modify: `test/smoke/tenancy.smoke.spec.ts`, `docs/adr/0013-build-toolchain.md` (chỉ khi chênh > 1 MB, hoặc dòng "SP3 (cuối)" khi 3C là plan merge sau cùng của 3C ∥ 3D)

**Interfaces:**
- Consumes: `Device`, `verifiedDevice(apiUrl, mail, forbidden)`, `PASSWORD`, `Mailpit.waitFor`, `Mailpit.now`, `psql`, `forbidden` (smoke 3A, `smoke-devices.ts`), route của Task 9–11, `TENANCY_INVITATION_ACCEPT_URL`/`TENANCY_INVITE_LINK_JOIN_URL` của `smoke-app-env.ts` (Task 5: `https://localhost/invitations/accept`, `https://localhost/join`).
- Produces: smoke 3C (spec §22.3 Bảng 3: mời → Mailpit có fragment token → chấp nhận → đổi role → link join), cộng chuyển quyền; số đo image.

- [ ] **Step 1: Luồng thu nhận trên image**

`test/smoke/tenancy.smoke.spec.ts` — thêm ca trong `describe`, trước ca log sạch:
```ts
  it('acquisition on the production image: invite → Mailpit #token= → preview → accept → change role → invite link join → ownership transfer accepted', async () => {
    const { device: owner } = await verifiedDevice(apiUrl, mail, forbidden);
    const { device: invitee, email: inviteeEmail } = await verifiedDevice(apiUrl, mail, forbidden);
    const { device: joiner } = await verifiedDevice(apiUrl, mail, forbidden);
    const idem = () => ({ 'idempotency-key': `smoke-${randomUUID()}` });
    const Id = z.object({ id: z.uuid() });
    const org = await owner.call('POST', '/v1/orgs', { body: { name: 'Smoke 3C' }, headers: idem() });
    expect(org.status).toBe(201);
    const { id: orgId } = Id.parse(await org.json());
    const memberRole = psql(`SELECT public_id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'MEMBER'`);
    const adminRole = psql(`SELECT public_id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'ADMIN'`);

    const after = await mail.now();
    const invited = await owner.call('POST', `/v1/orgs/${orgId}/invitations`, { body: { email: inviteeEmail, roleId: memberRole }, headers: idem() });
    expect(invited.status).toBe(201);
    const msg = await mail.waitFor(inviteeEmail, { subject: /You're invited to join Smoke 3C/, after, timeoutMs: 60_000 });
    const token = /https:\/\/localhost\/invitations\/accept#token=([A-Za-z0-9_-]{43})/.exec(msg.Text)?.[1];
    if (!token) throw new Error('no https accept link with #token= in the invitation');
    forbidden.push(token);
    const preview = await new Device(apiUrl).call('POST', '/v1/invitations/preview', { body: { token }, cookie: false });
    expect([preview.status, z.object({ roleName: z.string() }).parse(await preview.json()).roleName]).toEqual([200, 'Member']);
    const accepted = await invitee.call('POST', '/v1/invitations/accept', { body: { token }, headers: idem() });
    expect(accepted.status).toBe(201);
    const { id: memberId } = Id.parse(await accepted.json());
    expect(accepted.headers.get('location')).toBe(`/v1/orgs/${orgId}/members/${memberId}`);

    expect((await owner.call('PATCH', `/v1/orgs/${orgId}/members/${memberId}`, { body: { roleId: adminRole }, headers: { 'if-match': '*' } })).status).toBe(200);

    const link = await owner.call('POST', `/v1/orgs/${orgId}/invite-links`, {
      body: { roleId: memberRole, maxUses: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect([link.status, link.headers.get('cache-control')]).toEqual([201, 'no-store']);
    const linkToken = /^https:\/\/localhost\/join#token=([A-Za-z0-9_-]{43})$/.exec(z.object({ url: z.string() }).parse(await link.json()).url)?.[1];
    if (!linkToken) throw new Error('invite link url without an https #token=');
    forbidden.push(linkToken);
    expect((await joiner.call('POST', '/v1/invite-links/join', { body: { token: linkToken }, headers: idem() })).status).toBe(201);

    const t = await owner.call('POST', `/v1/orgs/${orgId}/ownership-transfers`, { body: { toMemberId: memberId, stepDownTo: 'ADMIN' }, headers: idem() });
    expect(t.status).toBe(201);
    const { id: transferId } = Id.parse(await t.json());
    await mail.waitFor(inviteeEmail, { subject: /Ownership transfer requested for Smoke 3C/, after, timeoutMs: 60_000 });
    const ok = await invitee.call('POST', `/v1/orgs/${orgId}/ownership-transfers/${transferId}/accept`, { body: {}, headers: idem() });
    expect(ok.status).toBe(200);
    expect(psql(`SELECT r.system_key FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE m.public_id = '${memberId}'`)).toBe('OWNER');
    // Event của cả luồng, cùng transaction với từng thay đổi.
    expect(
      psql(
        `SELECT string_agg(type, ',' ORDER BY id) FROM outbox_events WHERE org_id = '${orgId}' AND type ~ '^tenancy\\.(invitation|invite_link|ownership_transfer)\\.'`,
      ),
    ).toBe(
      'tenancy.invitation.created,tenancy.invitation.accepted,tenancy.invite_link.created,tenancy.ownership_transfer.requested,tenancy.ownership_transfer.accepted',
    );
    expect(psql(`SELECT count(*) FROM outbox_events WHERE org_id = '${orgId}' AND type = 'tenancy.member.added'`)).toBe('3');
    expect(psql(`SELECT count(*) FROM org_invitations WHERE org_id = '${orgId}' AND token_hash IS NOT NULL`)).toBe('0');
  });
```
(`psql` chạy bằng superuser của smoke, bỏ qua RLS; giá trị nối vào SQL là id do Postgres sinh, như ca 3A/3B. Token vào `forbidden` ngay khi đọc được: ca log sạch cuối file khẳng định chúng không có trong log api/worker.)

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer, luật production `tenancy-frontend-urls` đạt với URL `https://localhost/...`), migrate mọi migration tới 3C trên image, mọi file smoke PASS, log api/worker JSON không `error`, không chứa giá trị nào trong `forbidden` (email, token lời mời, token link, cookie, bearer); `/health/ready` 200; teardown `down -v` sạch.

- [ ] **Step 2: Đo image như ADR 0013**

Run (Git Bash, cùng máy với dòng "SP3 (3A)"):
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
git fetch origin main && git log --oneline origin/main | grep -c "sp3d" || true
```
Expected: tổng layer chưa nén ≤ 400 MB (vượt → dừng, pipeline coi là đỏ, spec §18.4). 3C không thêm dependency nên chênh gần 0 so với dòng gần nhất của ADR 0013. Ghi ADR khi (a) chênh > 1 MB ở chỉ số nào (dòng "SP3 (3C)" với số thật và lý do), hoặc (b) 3D đã merge trước 3C (dòng grep cuối > 0) — khi đó 3C là plan merge sau cùng của cặp, ghi dòng "SP3 (cuối)" (spec §18.4, Bảng 5). Không rơi vào hai trường hợp đó thì không sửa ADR; số đo vào mô tả PR (Task 18).

- [ ] **Step 3: Commit**

```bash
git add test/smoke/tenancy.smoke.spec.ts
git commit -m "test(smoke): invitation, invite link and ownership transfer on the production image"
```
(Thêm `docs/adr/0013-build-toolchain.md` vào commit chỉ khi Step 2 ghi dòng mới.)

---

### Task 17: Tài liệu — ADR 0005, 0007, 0017, README + runbook 3C (`docs/boilerplate/README.md`), bỏ nhãn `(3C)` ở spec cha

**Files:**
- Modify: `docs/adr/0005-multi-tenant-rls.md`, `docs/adr/0007-http-conventions.md`, `docs/adr/0017-tenancy-own-module.md`, `docs/boilerplate/README.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`

**Interfaces:**
- Consumes: tên thật của code Task 2–15; `docs/superpowers/specs/2026-09-28-sp3-parent-spec-amendments.md` mục "Cách áp" (plan mang tính năng bỏ nhãn của mình khi merge).
- Produces: tài liệu khớp với cái 3C ship.

- [ ] **Step 1: ADR**

`docs/adr/0005-multi-tenant-rls.md` — thêm mục ngay sau mục cập nhật mới nhất của SP3 trên `main`:
```markdown
## Cập nhật SP3 (3C) (<ngày merge>)

- **Ba bảng thu nhận** `org_invitations`, `org_invite_links`, `org_ownership_transfers`: RLS + FORCE, policy `TO app_user`, neo `org_id → organizations ON DELETE RESTRICT` trực tiếp, FK kép tới `org_roles`/`org_members` là `ON DELETE SET NULL (<cột>)` (chỉ cột con, PG ≥ 15) kèm `CHECK` gắn trạng thái (`*_pending_role_ck`, `*_active_role_ck`, `*_pending_members_ck`): xoá role/member còn việc đang mở fail to (`23514` → `409`), việc đã kết thúc chỉ mất tham chiếu (spike S3C-1…3). 3NF theo ngoại lệ E1, không BCNF.
- **Bất biến ở DB:** role của lời mời/link không bao giờ là `OWNER` (trigger `*_role_not_owner`, cho qua `NULL` của `SET NULL`), token lời mời chỉ được xoá (`org_invitations_token_clear_only`), `use_count ≤ max_uses` và chỉ tăng (`CHECK` + `org_invite_links_use_count_monotonic`), một lời mời `PENDING` mỗi `(org, email)`, một chuyển quyền `PENDING` mỗi org (partial `UNIQUE`). Bốn trigger giữ quyền caller (không hoãn).
- **Ba hàm definer chỉ đọc** của `tenancy_definer`: `tenancy_find_invitation(bytea)`, `tenancy_find_invite_link(bytea)` (tra hash 32 byte không cần OrgScope; policy `*_definer_read`, `SELECT` theo cột `id, org_id, token_hash, status|revoked_at`), `tenancy_count_user_memberships(bigint)` (M7: chế độ single-org đếm cả membership ở org xoá mềm). Hằng catalog `DEFINER_FUNCTIONS_3C`, `DEFINER_READ_TABLES_3C`, `TENANCY_TENANT_TABLES_3C`.
- **`down` không làm mất việc đang chờ âm thầm:** `down` của `…_acquisition` từ chối khi còn lời mời `PENDING` chưa hết hạn, link đang mở hoặc chuyển quyền `PENDING` chưa hết hạn (mẫu `NO FORCE … FORCE` + khẳng định); `down` của `…_acquisition_templates` fail to (`23503`) khi còn thư dùng key.
```
`docs/adr/0007-http-conventions.md` — thêm mục sau mục cập nhật SP3 (3A):
```markdown
## Cập nhật SP3 (3C) (<ngày merge>)

- **Route cầm token ngoài path org:** `POST /v1/invitations/{preview,accept}`, `POST /v1/invite-links/{preview,join}` (token trong body, không bao giờ trong URL). Service tra hàm definer theo SHA-256 của token rồi tự vào `OrgScope`. Mọi lỗi tra token trả CÙNG một `404 invitation_not_found` / `404 invite_link_not_found` (không tồn tại, hết hạn, đã dùng/hết lượt, thu hồi, org xoá mềm).
- **Bucket `tenancy.token-preview`** (`RateLimitBuckets`, khoá `clientIpTracker`, cả khi có principal; `TENANCY_TOKEN_PREVIEW_RATE_LIMIT`/`_TTL_MS`): hai route preview là `@PublicRoute()` và nằm ở `MARKER_EXEMPT_ROUTES`. Redis sập → insurance theo pod như mọi bucket.
- **Secret một lần không `@Idempotent()`:** `POST …/invite-links` trả `url` (`#token=` ở fragment) đúng một lần, `Cache-Control: no-store`; retry tạo thêm một link thu hồi được. Thư mời mang token ở fragment, mã hoá at-rest bằng `FieldCipher`.
- **Kết cục phải commit trước khi báo lỗi** (lời mời hết hạn → `EXPIRED` rồi `404`; kiểm lại người mời không đạt → `INVALIDATED` rồi `409`; người khởi tạo chuyển quyền không còn owner → `CANCELLED` rồi `409`): service trả kết quả có tên từ `UnitOfWork.run` và ném SAU commit.
```
`docs/adr/0017-tenancy-own-module.md` — thêm mục sau "## Kết quả spike (plan 3C)" (Task 1):
```markdown
## Cập nhật SP3 (3C) (<ngày merge>)

- Thu nhận: lời mời email (token 256 bit chỉ lưu SHA-256, chấp nhận một lần, email đã xác thực phải trùng), invite link (trần lượt atomic, trần link đang mở), chuyển quyền sở hữu hai bên với `step_down_to` — đường duy nhất để owner tự xuống quyền. Mọi đường gán role qua `assertCanBind` (gồm key orphan, R-X23) lúc tạo, và `GrantorRecheck` kiểm lại cửa (`invitations.write`) + trần (gồm 2a) với người mời/người tạo HIỆN TẠI lúc chấp nhận/join.
- `MemberAdmission` nhận `Admission` (`CREATOR` | `INVITATION` | `INVITE_LINK`, kèm id công khai vào `tenancy.member.added`). **M7 đóng:** chế độ single-org đếm mọi membership của user, kể cả ở org xoá mềm (`tenancy_count_user_memberships`), nên khôi phục org không để user ở hai org. Kiểm ghế `tenancy.seats` là của 4B (port `MemberSeatLimit` trong `MemberAdmission`), không phải 3C.
- Điểm mở rộng của 3A/3B đã nối: `RoleService.delete` (lời mời quá hạn → `EXPIRED`, link đã đóng → thu hồi + `ROLE_DELETED`), xoá mềm (thu hồi lời mời/link, huỷ chuyển quyền, không event riêng), gỡ member/rời org/xoá tài khoản (`TransferSettlement`: chuyển quyền `PENDING` → `CANCELLED { MEMBER_REMOVED }` trước câu xoá).
- Hết hạn là trạng thái suy ra (S3-A24): không cron quét; dòng quá hạn được ghi `EXPIRED` khi bị chạm.
- Cờ `TENANCY_EMAIL_INVITATIONS`/`TENANCY_INVITE_LINKS` (`auto`/`on`/`off`) qua `resolveTenancyFeatures` dùng chung cho luật config và log INFO `tenancy_features` lúc boot. External: email từ claim `AUTH_EXTERNAL_EMAIL_CLAIM` khi claim `AUTH_EXTERNAL_EMAIL_VERIFIED_CLAIM` đúng `true`; không thư chuyển quyền.
- Lệch có chủ đích (chi tiết ở plan 3C, mục "Lệch có chủ đích"): <chép nguyên văn danh sách đánh số của mục đó khi viết ADR>.
```
Thay `<ngày merge>` bằng ngày thật lúc viết (YYYY-MM-DD); dòng "Lệch có chủ đích" chép nguyên văn danh sách đánh số ở cuối plan này (tại thời điểm viết đã cố định, không phải dữ liệu đo).

- [ ] **Step 2: README và runbook**

`docs/boilerplate/README.md` — trong mục tenancy (sau tiểu mục "Vòng đời quyền" / "Mẫu migration dữ liệu catalogue (7 bước)" của 3B), thêm tiểu mục `### Lời mời, invite link, chuyển quyền sở hữu` gồm:
1. **Bật tính năng:** bảng 12 env của 3C (spec §13 dòng 3C) + `AUTH_EXTERNAL_EMAIL_CLAIM`/`_VERIFIED_CLAIM`; `auto` = bật khi có URL frontend (và claim email ở external), `on` thiếu điều kiện → không khởi động, `off` → `403 feature_disabled` ở route tạo (chấp nhận/preview của cái đã có vẫn chạy); production: URL `https` và cùng origin với `HTTP_CORS_ORIGINS`; log INFO `tenancy_features` cho biết tính năng nào tắt và vì sao.
2. **Hợp đồng frontend:** trang chấp nhận/join đọc `#token=` từ fragment (không gửi lên server trong URL), gọi `POST /v1/invitations/preview` (public) rồi `POST /v1/invitations/accept` sau khi đăng nhập; mọi token sai/hết hạn/đã dùng/thu hồi là cùng `404`; `403 invitation_email_mismatch` không nêu email được mời; chấp nhận cần session mới (`403 reauthentication_required` → đăng nhập lại rồi thử lại). Link: `url` chỉ có ở response tạo, lưu ngay.
3. **Luật:** owner không bao giờ mời/link được (`422 owner_not_invitable`); người mời phải trội hẳn role (và chỉ owner chạm role ⊇ quyền admin); lúc chấp nhận/join, người mời/người tạo phải vẫn là member, vẫn có `invitations.write` và vẫn trội role, không thì lời mời `INVALIDATED`/link bị thu hồi (`409`). Chuyển quyền: owner khởi tạo, người nhận (member khác, email đã xác thực ở local/hybrid) chấp nhận/từ chối; `stepDownTo` là cách duy nhất để owner tự xuống quyền.
4. **Gửi lại lời mời** = thu hồi + tạo mới (token không lưu). Xoá role còn lời mời `PENDING`/link đang mở → `409 role_in_use`: thu hồi chúng trước.
5. **Runbook 3C:** (a) rollback migration: `down` của `…_acquisition` từ chối khi còn việc đang mở — thu hồi lời mời/link, huỷ chuyển quyền (hoặc chờ hết hạn) rồi chạy lại; `down` của `…_acquisition_templates` fail khi còn thư dùng key — chờ cron dọn `NOTIFICATIONS_RETENTION_DAYS` hoặc xoá dòng thư ở trạng thái cuối. (b) Thư mời không tới: xem `email_deliveries.last_error_code` (enum, không PII) và metric của notifications; lời mời vẫn `PENDING` tới khi hết hạn, gửi lại bằng thu hồi + tạo mới. (c) Dòng `PENDING` quá hạn tồn tại tới khi bị chạm hoặc org bị purge (không cron quét, đọc thấy `EXPIRED`). (d) Metric cần dashboard: `tenancy_invitations_total{result}`, `tenancy_invite_link_joins_total{result}`, `tenancy_last_owner_blocked_total{path="transfer"}`.

- [ ] **Step 3: Bỏ nhãn `(3C)` ở spec cha**

Run: `grep -n "(3C)" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`
Với mỗi dòng tìm được: xoá đúng chuỗi ` (3C)` (hoặc `(3C)` đứng riêng) để câu mô tả tính năng thành hiện tại; không sửa chữ nào khác. Câu mang nhãn `(3D)` giữ nguyên.
Run lại: `grep -c "(3C)" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git diff --check
git add docs/adr/0005-multi-tenant-rls.md docs/adr/0007-http-conventions.md docs/adr/0017-tenancy-own-module.md docs/boilerplate/README.md docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
git commit -m "docs(tenancy): invitations, invite links and ownership transfer; ADR 0005/0007/0017 for plan 3C; runbook; drop the (3C) labels from the parent spec"
```

---

### Task 18: Kiểm chứng toàn nhánh, push, một PR cho 3C, CI xanh hoàn toàn

**Files:**
- Không file mới. Sửa bất kỳ file nào cần để pipeline xanh (mỗi sửa là commit riêng có lý do).

**Interfaces:**
- Consumes: mọi task 1–17.
- Produces: nhánh `sp3c-acquisition` trên `origin`, một PR `sp3c-acquisition → main` với mọi check CI xanh.

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
- `pnpm test`: `migration-scan.spec.ts`, `migration-order.spec.ts` (hai migration 3C mới nhất ở vùng của chúng), `migration-zones.spec.ts`, `hardcode-scan.spec.ts`, unit tenancy (U17, state machine, token, display text), `event-flags.spec.ts` (mười event 3C `audit: true, webhook: false`; đúng sáu webhook tenancy), `compose.spec.ts`.
- `pnpm test:int`: `migrations.spec.ts` (up → down → up và sweep S2-R57 gồm hai migration 3C, database riêng), `rls-catalog.spec.ts` (hằng 3C), `normalization-inventory.spec.ts` (+3 bảng), `acquisition-down.spec.ts`, `acquisition-templates-down.spec.ts`, `acquisition-db.spec.ts`, `acquisition-isolation.spec.ts`, `acquisition-definer.spec.ts`, `acquisition-repositories.spec.ts`, `single-org-admission.spec.ts`, `module-isolation.spec.ts` (UP-12c), mọi e2e tenancy (gồm ma trận G-6 với route 3C, race của Task 13 ba lần liền xanh ở Task 13).
- `pnpm test:chaos`: hai file chaos 3C cùng chaos của 3A/3B.
- `pnpm test:smoke`: image production thật, luồng 3C, log sạch, teardown sạch.
- `.env.example` đã sinh ở Task 5 (14 khoá mới) và không đổi thêm; `openapi.json` khớp code; `oasdiff` của CI chỉ thấy thêm (17 operation).
Lệnh nào đỏ: tìm nguyên nhân gốc (skill `superpowers:systematic-debugging`), sửa, commit, chạy lại **toàn bộ** Step 1.

- [ ] **Step 2: Kiểm tay trước khi push; rebase nếu `main` đã nhận plan khác của sóng W3**

Run:
```bash
git fetch origin main
git log --oneline origin/main..HEAD
git status --short
git diff --stat origin/main...HEAD
ls test/integration/spike-sp3c 2>/dev/null || echo "no spike code"
```
Expected: `git status` sạch; commit theo task, message conventional tiếng Anh; không file spike, không file tạm, không secret.

Nếu `main` đã nhận plan khác trong lúc làm (R-X7 sóng W3: 3D, 6A, 6C, 7B), rebase rồi chạy lại **toàn bộ** Step 1:
- **Có migration mới trên `main`:** tạo lại hai file migration 3C bằng CLI (`migration:create --blank` cùng `--name`, chép nội dung, xoá file cũ) để timestamp lớn hơn (`migration-order.spec.ts`); chạy trước `pnpm vitest run --project unit test/unit/migrations` và `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/migrations.spec.ts`.
- **3D đã merge:** giải xung đột theo mục "Chỗ đụng với 3D" (dưới); test 3C gọi `/admin/remove-user` (Task 12 ca xoá tài khoản, Task 13 O-12) cần admin đã step-up TOTP của 3D: dùng helper principal nhân viên của 3D (`seed-staff-step-up.ts`) cho `admin` ở hai file đó; ADR 0013 ghi dòng "SP3 (cuối)" (Task 16 Step 2).
- **6A/6C đã merge:** chạy lại `rls-catalog.spec.ts`, `normalization-inventory.spec.ts`, `event-flags.spec.ts`; giữ phần của plan kia và phần 3C (độc lập).
- **7B đã merge:** nếu 7B thêm `.meta({ secret })` cho field config, 3C không có field secret (spec §13 "Không có secret"); chạy lại `pnpm env:example` và kiểm `git diff .env.example`.

- [ ] **Step 3: Push và mở PR**

Run:
```bash
git push -u origin sp3c-acquisition
gh pr create --base main --head sp3c-acquisition --title "SP3 plan 3C: acquisition (invitations, invite links, ownership transfer)" --body-file "$TMPDIR/sp3c-pr.md"
```
Nội dung `$TMPDIR/sp3c-pr.md` (viết trong scratchpad, không commit):
```markdown
## SP3 plan 3C — acquisition

Spec: docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md (r8, §22.3 Bảng 1–5, dòng 3C)
Plan: docs/superpowers/plans/2026-09-29-sp3c-acquisition.md
ADR: 0017 (spike S3C-1…3, cập nhật 3C), 0005, 0007 (cập nhật 3C)

### Nội dung
- migration `tenancy/…_acquisition` (3 bảng RLS FORCE, 4 trigger, 3 hàm definer, `down` có guard) + `notifications/…_acquisition_templates`
- lời mời email, invite link, chuyển quyền sở hữu: 17 operation; kiểm lại người mời lúc chấp nhận/join; bucket `tenancy.token-preview`
- `MemberAdmission` nguồn INVITATION/INVITE_LINK; M7 (single-org đếm cả org xoá mềm)
- điểm mở rộng 3A/3B: xoá role, xoá mềm, gỡ member, xoá tài khoản
- external: claim email đã xác thực

### Kiểm chứng (lệnh và kết quả thật)
<output tóm tắt của từng lệnh Step 1: số test pass theo project, thời gian>

### Image (ADR 0013)
<chưa nén / nén / chênh so với dòng gần nhất — số của Task 16>

### Rủi ro còn lại
- Dòng `PENDING` quá hạn ở lại tới khi bị chạm hoặc purge (không cron quét; đọc thấy `EXPIRED`).
- Kiểm ghế `tenancy.seats` thuộc 4B; trước 4B, lời mời/link không bị trần ghế.
```
Thay hai khối `<…>` bằng dữ liệu thật của lần chạy trước khi `gh pr create`.

- [ ] **Step 4: Chờ CI, sửa tới khi xanh**

Run: `gh pr checks --watch`
Expected: mọi check xanh (lint/arch/typecheck/unit, integration, chaos, env drift, openapi + oasdiff chỉ thêm, migration order, build image, smoke). Check đỏ: `gh run view <id> --log-failed`, tìm nguyên nhân gốc, sửa, commit, push, chờ lại. Không `--no-verify`, không tắt check, không đánh dấu flaky để qua.

- [ ] **Step 5: Báo cáo**

Báo Sếp: link PR, danh sách check xanh (`gh pr checks`), số test theo project, số đo image, rủi ro còn lại. Không merge (merge là quyết định của Sếp).

---

## Chỗ đụng với 3D

3C ∥ 3D (R-X7) không cùng sửa đối tượng schema nào; cả hai sửa CODE của 3A/3B ở các chỗ dưới. Plan merge sau rebase, giữ phần của cả hai (độc lập), đổi timestamp migration của mình, chạy lại toàn bộ pipeline.

| Chỗ | 3C thêm | 3D thêm | Cách giải |
|---|---|---|---|
| `org-purge.sql.ts` (`ORG_PURGE_STATEMENTS`) | 3 câu trước `org_members` | 4 câu trước `org_members` | Thứ tự spec §9.5: `org_support_grant_permissions`, `org_support_grants`, `org_api_key_permissions`, `org_api_keys`, rồi 3 câu 3C, rồi `org_members` |
| `test/support/tenancy-catalog.ts` + `rls-catalog.spec.ts` + `normalization-inventory.spec.ts` | hằng `*_3C`, cột của 3 bảng | hằng `*_3D`, 4 bảng, `auth.session_second_factor` | Nối cả hai vào hằng hợp |
| `TEMPLATE_KEYS`, `TEMPLATE_PARAMS`, `renderer.spec.ts` samples | `org-invitation`, `ownership-transfer-requested` | `support-access-notice` | Giữ cả ba key; dòng `email_templates` mỗi plan chèn bằng migration riêng |
| `resolveTenancyFeatures`, `TenancyFeatureStates`, `FeatureDisabledReason` | hai cờ | cờ `supportGrants`, lý do `EXTERNAL_MODE` | 3D mở rộng kiểu và bảng U17 lên 3 cờ |
| `TenancyErrors` | 15 mã 3C + `FEATURE_DISABLED`, `TTL_OUT_OF_RANGE` | mã key/grant; có thể cũng định nghĩa `FEATURE_DISABLED`/`TTL_OUT_OF_RANGE` | Một định nghĩa mỗi mã (`defineErrorCodes` ném khi trùng): plan merge sau xoá bản trùng của mình |
| `MemberAdmission.admit` | `admission` (nguồn + id) | thu hồi grant của user (SEC-M5) trước `INSERT` | Giữ cả hai; chú thích 4B về ghế giữ nguyên |
| `MemberService.deleteWithEvent`, `UserDeletionService.releaseOrg` | `TransferSettlement.settleForRemovedMember` | đọc key → `api_key.revoked { CREATOR_REMOVED }` | Cả hai trước câu xoá; thứ tự: chuyển quyền trước, key sau (độc lập) |
| `OrgLifecycleService.softDelete` | thu hồi lời mời/link, huỷ chuyển quyền | thu hồi key, grant | Cả hai trước `suspendAllForCurrentOrg` |
| `NARROWING_ROUTES` | 4 route | 3 route | Tổng 8 (spec §12) |
| `role-route-matrix.e2e.spec.ts` | `ROUTES_3C`, `NARROWING`, `cast` có lời mời/link/chuyển quyền | cột org key, support grant; route 3D | Gộp `cast` và `call`; `NARROWING` có 8 dòng |
| `TenancyMetrics` | `invitations`, `inviteLinkJoins`, path `'transfer'` | metric key/support | Độc lập |
| `tenancy-http.module.ts` | 5 controller, 7 provider | controller/provider 3D | Độc lập |
| Test gọi `/admin/*` (Task 12, Task 13 O-12) | admin seed `role: 'admin'` | gate step-up TOTP cho mọi `/admin/*` | Dùng principal nhân viên đã step-up của 3D |
| ADR 0013 | đo lại | đo lại | Plan merge sau cùng ghi "SP3 (cuối)" |

---

## Lệch có chủ đích

1. **`down` của `…_acquisition` từ chối khi còn việc đang mở** (spec §6.13 chỉ ghi `DROP TABLE; DROP FUNCTION`): không làm người cầm token/người nhận mất việc âm thầm (cùng lý do với `down` của 3B).
2. **`role_not_owner` cho qua khi RLS giấu role** (không thấy dòng role → `RETURN NEW`): câu ghi chéo org vẫn ra `42501` của `WITH CHECK` (tiêu chí 1), không phải lỗi của trigger (spike S3C-2).
3. **Lời mời được admit TRƯỚC CAS `ACCEPTED`** (spec §9.1 bước 3 viết CAS → admit → cập nhật `accepted_member_id`): một câu CAS ghi luôn `accepted_member_id`; CAS 0 dòng (hết hạn giữa lần đọc giờ và câu CAS) ném để rollback cả membership. Kết quả quan sát giống spec (T-2 bên thua `404`), bớt một câu `UPDATE`.
4. **Thu hồi link đã thu hồi là `204` no-op** (spec §9.2 không định nghĩa; §15 không có `invite_link_not_pending`): DELETE idempotent, không event thứ hai.
5. **`Location` của `201` trỏ tới URL định danh của resource** (`…/invitations/{id}`, `…/invite-links/{id}`, `…/ownership-transfers/{id}`) dù spec §12 không có `GET` một phần tử: đó là URL mà `DELETE` dùng; không thêm route ngoài bảng §12.
6. **Người nhận chuyển quyền đã là OWNER được phép**: chấp nhận không đổi role của người nhận (không `role_changed` cho họ) và chỉ áp `step_down_to` cho người khởi tạo — đây là cách một trong nhiều owner tự xuống quyền (luật 3), spec §9.3 không cấm.
7. **Bucket preview đếm MỌI lần preview**, không chỉ lần trượt (khác `tenancy.org-miss`): spec §7.2 ghi "giới hạn theo IP", không ghi "chỉ lần trượt"; token 256 bit nên bucket chống tải/quét.
8. **T-3** được kiểm bằng một lời mời và một link của cùng org cho cùng user: partial `UNIQUE (org_id, email) WHERE PENDING` (T-4) làm "hai lời mời khác nhau cùng org cùng user" không tồn tại được.
9. **Không có cron hết hạn** (Self-review §5 mục 1).
10. **`MODULE_REQUIRES.tenancy` không thêm `notifications`** dù tenancy nay import `modules/notifications/index.ts`: bao đóng `tenancy → identity → notifications` đã chứa nó, test UP-12c đọc bao đóng, `compose.spec.ts` khoá giá trị hiện tại.
11. **`InviteLinkRepository.findById`** (đọc không khoá) thêm cho preview link, ngoài danh sách phương thức của bản nháp Task 7.

---

## Self-review

### 1. Độ phủ spec (§22.3 Bảng 1 và Bảng 3, dòng 3C)

| Hạng mục spec | Task |
|---|---|
| Migration `…_acquisition` (3 bảng, index, RLS, policy, grant, 4 trigger, `down` có guard) | 1 (spike), 2 |
| Migration `…_acquisition_templates`; template `org-invitation`, `ownership-transfer-requested` | 3 |
| Hàm `find_invitation`, `find_invite_link` (+ `count_user_memberships` cho M7) | 2, 4 |
| §8.4 đường (b), (c), (d) + kiểm lại cửa + trần + 2a | 8 (`GrantorRecheck`), 9, 10, 11 |
| §9.1 lời mời (tạo, preview, chấp nhận, thu hồi, gửi lại = thu hồi + tạo) | 9 |
| §9.2 invite link (tạo không idempotent, join atomic, preview, thu hồi) | 10 |
| §9.3 chuyển quyền (khởi tạo, chấp nhận, từ chối, huỷ, gỡ member huỷ yêu cầu) | 11, 12 |
| `MemberAdmission` nguồn `INVITATION`/`INVITE_LINK` | 8, 9, 10 |
| Bucket `tenancy.token-preview` | 9 (provider), 10 (test), 15 (Redis sập) |
| Claim email `external` | 5, 14 |
| `resolveTenancyFeatures` (hai cờ) — U17 | 5 |
| Event invitation/link/transfer (`audit: true, webhook: false`) | 7, 9–12 |
| Config 12 env tenancy + 2 env identity | 5 |
| Tiêu chí 6, 7 | 9, 10 (tuần tự), 13 (song song) |
| B-10, B-12, B-13, B-16, B-20, B-22/B-23/B-24 (lời mời) | 9 |
| B-11, B-14, B-22/B-23 (link) | 10 |
| B-15 | 12 (+ Task 4 ở DB) |
| O-6, O-7, O-8, O-16 | 11 |
| O-12 | 13 |
| X-8, X-11 | 13 |
| R-11 (lời mời/link), R-18 (R-X26) | 12 (E), 4 (DB) |
| §18.1 isolation + ràng buộc 3 bảng; definer `find_*`; hằng catalog `DEFINER_FUNCTIONS_3C`, `DEFINER_READ_TABLES_3C` | 4, 2 |
| "Lời mời, link, vòng đời": email khác → 403; token sai/hết hạn/đã dùng/thu hồi → cùng 404; trần link chỉ đếm link đang mở; xoá mềm thu hồi lời mời/link; S2-R43 | 9, 10, 12 |
| G-6 thêm route 3C; bảng route nhạy cảm/thu hẹp | 9, 10, 11 |
| §18.4: giết api giữa chấp nhận; PII (email sai, token sai, SMTP lỗi); Redis sập | 15 |
| Smoke 3C | 4 (schema), 16 (luồng) |
| M7 | 2 (hàm), 8 (admission), 7 (repository) |
| Bảng 4 (kiểm lại phần 3C): 1 / 3, 18 / 4 / 5 / 8 / 11 / 12 / 13 / 15 / 16 / 17 | 4 / 9–11 / 8–11 / 11, 13 / 12 / 9–11 (event cùng transaction), 15 / 15 / 14 / 2 / 15 / 18 |
| Bảng 5 cột 3C: kiểm lại lúc chấp nhận/join; `RoleService.delete`; xoá mềm; thứ tự purge; `release`; `MemberService`; `MemberAdmission`; `RateLimitBuckets`; ADR 0013; `resolveTenancyFeatures`; `TEMPLATE_KEYS`; hằng `rls-catalog`; inventory chuẩn hoá; G-6; §14.1/§15/§16 | 8; 12; 12; 2; 12; 12; 8; 9; 16; 5; 3; 2; 2; 9–11; 7, 17 |
| Bỏ nhãn `(3C)` ở spec cha | 17 |

### 2. Race của 3C (spec Bảng 2) → cơ chế → test

| Race | Cơ chế | Test |
|---|---|---|
| T-2 (chấp nhận hai lần) | Khoá org + khoá lời mời + CAS `WHERE status = 'PENDING' AND expires_at > clock_timestamp()` + `UNIQUE (org_id, user_id)` | Task 13 (4 song song × 5), Task 9 (lần hai `404`), Task 7 (repository) |
| T-3 (hai đường vào cho cùng user) | `UNIQUE (org_id, user_id)` → `409 already_member`, bên thua rollback (lời mời giữ `PENDING`/`use_count` không tăng) | Task 13, Task 9 (Review Focus 2), Task 10 |
| T-4 (mời trùng email) | Partial `UNIQUE (org_id, email) WHERE PENDING` | Task 13, Task 9, Task 4 (DB) |
| T-5 (link vượt `max_uses`) | `UPDATE … WHERE use_count < max_uses AND revoked_at IS NULL AND expires_at > clock_timestamp()` + `CHECK` | Task 13 (N + k), Task 10, Task 4, Task 7 |
| T-9 (xoá role ∥ lời mời/link mang nó) | Khoá org ở cả hai; `SET NULL (role_id)` + `*_pending_role_ck`/`*_active_role_ck` | Task 13, Task 12, Task 4 |
| T-11 (trần lời mời/link) | Đếm dưới khoá org theo `clock_timestamp()` | Task 13, Task 9, Task 10 |
| T-16 (chấp nhận/từ chối/huỷ) | Khoá org + khoá yêu cầu + CAS + partial `UNIQUE (org_id) WHERE PENDING` | Task 13, Task 11 |
| T-18 / O-12 (xoá tài khoản ∥ chấp nhận) | `hooks.before` + `23001 org_members_user_fk` → `BLOCKED_RACE` → `409` (3A) | Task 13 |
| T-21 (hai lần thu hồi) | CAS `WHERE status = 'PENDING'` | Task 13, Task 9 |
| T-27 / X-8 (chấp nhận/join ∥ xoá mềm) | Cả hai khoá org; accept/join kiểm `deleted_at` sau khoá; xoá mềm thu hồi trong cùng transaction | Task 13, Task 12 |
| T-29 / X-11 (hết hạn trong lúc chờ khoá) | So hết hạn bằng `clock_timestamp()` sau khoá + predicate của CAS | Task 13 (giữ khoá qua mốc) |
| M7 (khôi phục org để user ở hai org) | `MemberAdmission` đếm mọi membership kể cả org xoá mềm (hàm definer), sau khoá `tenancy_users` | Task 8 |

### 3. Quét chỗ trống

Không có "TBD"/"TODO"/"xử lý sau"/"tương tự Task N". Các `<…>` còn lại chỉ là dữ liệu của lần chạy: kết quả spike (Task 1 Step 3), ngày merge và danh sách lệch chép nguyên văn (Task 17), output và số đo trong mô tả PR (Task 18) — mỗi chỗ ghi rõ phải thay bằng giá trị thật trước khi commit/đăng. `Migration<ts>_…` là tên do CLI sinh (quy ước 3A/3B; timestamp lớn hơn migration mới nhất trên `main` ở cùng vùng, hôm nay `tenancy/…041247_custom_role_permissions` và tổng `example/…054247_starter_plans`).

### 4. Nhất quán tên và kiểu

- Repository (Task 7) ↔ service: `InvitationRepository.{findByTokenHash, insert, findById, lockById, lockByPublicId, countOpen, expireLapsedForEmail, resolve, accept, list, countUpTo, expireLapsedForRole, revokeAllPending}` dùng ở Task 9, 12; `InviteLinkRepository.{findByTokenHash, insert, findById, findByPublicId, lockById, lockByPublicId, countOpen, consumeUse, revoke, revokeClosedForRole, revokeAll, list, countUpTo}` ở Task 10, 12; `OwnershipTransferRepository.{insert, findByPublicId, lockByPublicId, expireLapsed, resolve, lockPendingForMember, cancelAllPending, list, countUpTo}` ở Task 8, 11, 12.
- `TokenMatch = { orgId; id }` (Task 7) — `id` là `bigint` dạng text, dùng cho `lockById`/`findById`; không bao giờ ra API.
- `GrantorRecheck.check(grantorMemberId | null, { id, systemKey })` → `{ ok } | { ok: false; reason: InvalidationReason }`; `reason` đi thẳng vào `InvitationInvalidatedEvent` (enum `INVALIDATION_REASONS`, Task 6/7). `assertCanBind` luôn nhận `orphans` (Task 8, `InviteRole`).
- `MemberAdmission.admit({ user, role, actor, admission })` (Task 8) ở `OrgService.create`, `InvitationService`, `InviteLinkService`, test M7.
- `TenancyFeatures.require('emailInvitations' | 'inviteLinks')` (Task 5) ở Task 9, 10.
- `TokenPreview` (Task 9) dùng ở `InviteLinkService.preview` và `tokenPreviewOf`; `TokenBody` ở bốn route cầm token.
- Mã lỗi: `TenancyErrors.*` của Task 5, 7 khớp `ApiProblems` của Task 9–11 và assert e2e (`invitation_not_found`, `invite_link_not_found`, `invitation_email_mismatch`, `invitation_invalidated`, `invite_link_invalidated`, `invitation_pending_exists`, `invitation_not_pending`, `ownership_transfer_pending`, `ownership_transfer_not_pending`, `ownership_transfer_invalidated`, `owner_not_invitable`, `pending_invitations_limit`, `invite_links_limit`, `ttl_out_of_range`, `feature_disabled`).
- Metric: `TenancyMetrics.invitations`/`inviteLinkJoins` với `{ result: AcquisitionResult }`; `lastOwnerBlocked` path `'transfer'` (Task 7 thêm vào `LastOwnerPath`, Task 11 dùng).
- Constraint/trigger: tên ở migration (Task 2) = tên ở map lỗi (Task 7) = tên ở test DB (Task 4) = spike (Task 1).
- Route id ở `NARROWING_ROUTES` (Task 9–11) = khoá của `NARROWING` trong ma trận = spec §12.
- Helper test: `newToken`, `hashToken`, `seedInvitation`, `seedInviteLink`, `seedTransfer` (Task 4); `previewIp`, `tokenFromMail`, `acceptInvitation`, `joinInviteLink`, `previewToken`, `problemCore` (Task 9) dùng ở Task 10–16.

### 5. Phán quyết trên chỗ spec mơ hồ (ruling — lý do — giá nếu sai)

1. **Không cron/sweep hết hạn.** Brief điều phối liệt kê "sweeps/crons (expiry) trên queue maintenance", nhưng spec (ràng buộc) định nghĩa hết hạn là suy ra và chỉ ghi `EXPIRED` khi chạm (§9.1, §9.3, §14.1, S3-A24), §13 không có env lịch quét, §16 (INT-M5) đã bỏ một hàm definer chỉ để đo backlog; mọi chỗ dòng quá hạn có thể chặn (trần, mời lại, xoá role, gỡ member, `down`, purge) đều tự chạm hoặc bỏ qua nó (Task 12, 13 chứng minh). — Giá nếu sai: một plan sau thêm `defineOrgSweep` (`tenancy.invitations.expire`) với một hàm `sweep_definer` và một env cron; không đổi schema ba bảng.
2. **Ghế `tenancy.seats` thuộc 4B, 3C không gọi `Entitlements.assertWithinLimit`.** Spec SP4 §9.6 giao kiểm ghế cho 4B qua port `MemberSeatLimit` trong `MemberAdmission`; luật depcruise SP4 20.8-a cấm tenancy import entitlements. — Giá nếu sai: thêm một lời gọi port trong `MemberAdmission` (một chỗ, phủ mọi nguồn).
3. **Lời mời được admit trước CAS** (Lệch #3). — Giá: đổi sang CAS → admit → `UPDATE accepted_member_id`, thêm một phương thức repository.
4. **Thu hồi link đã thu hồi là `204` no-op** (Lệch #4). — Giá: thêm mã `invite_link_not_pending` (409) và một assert.
5. **`Location` trỏ URL của DELETE** (Lệch #5). — Giá: thêm `GET` một phần tử cho ba resource (3 operation, cột G-6).
6. **Người nhận đã là OWNER vẫn hợp lệ** (Lệch #6). — Giá: một kiểm `422` ở `create`.
7. **Bucket preview đếm mọi lần** (Lệch #7). — Giá: đổi `consume` thành peek + consume khi `404` như org-miss.
8. **`MODULE_REQUIRES` giữ nguyên** (Lệch #10). — Giá: thêm `'notifications'` và sửa `compose.spec.ts`.
9. **Người nhận chuyển quyền chưa xác thực email ở local/hybrid → `422 validation_failed` (field `toMemberId`)**; spec O-7 ghi "422" mà không đặt mã: dùng mã chung có `errors[]`, không thêm mã mới. — Giá: thêm mã riêng.
10. **`TOKEN_INPUT_MAX_LENGTH = 128`** cho `token` (token thật 43 ký tự) và token đúng ký tự nhưng sai độ dài → cùng `404` (không `422`): không lộ định dạng token qua mã lỗi khác nhau. — Giá: đổi regex thành đúng 43 ký tự.

### 6. Hạng mục của dòng 3C chưa đặt được (và lý do)

Không có. Hạng mục phụ thuộc 3D (O-12 với admin step-up, cờ support trong `resolveTenancyFeatures`) ghi ở "Chỗ đụng với 3D".

### 7. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **Spike S3C-1…3:** hành động FK `SET NULL (<cột>)` dưới FORCE RLS chạy bằng quyền owner và `CHECK` gắn trạng thái bắn đúng tên tới `pgFields`; trigger quyền caller cho câu ghi chéo org ra `42501`. Kiểm ở Task 1; fallback ghi sẵn.
2. **`EmailNotifications.request` tham gia transaction của caller**: `MikroOrmUnitOfWork.run` lồng nhau dùng lại transaction đang mở (đã đọc `mikro-orm-unit-of-work.ts`); thư và lời mời cùng commit/rollback. `UnitOfWork` có thể chạy lại callback khi `40P01`: token sinh lại và thư ghi lại trong cùng lần chạy, nhất quán.
3. **PgBouncer rollback transaction của client bị giết** (Task 15 kill) — cùng giả định đã đúng ở 3A/3B; nếu backend commit, test đỏ.
4. **`@Ip()` của Nest trả `req.ip` đã áp `HTTP_TRUST_PROXY`** (bucket preview theo IP, Task 10 limiter, Task 15 Redis) — cùng nguồn với `AppThrottlerGuard`.
5. **Mailpit trả `Text` chứa nguyên URL có fragment** (`tokenFromMail`): template text in `{{acceptUrl}}` không escape `#`.
6. **Đồng hồ host và DB lệch < 1 s** cho X-11 (Task 13 giữ khoá 4 s qua mốc hết hạn 2 s tính bằng `now()` của DB).
7. **`seedCustomRole` với `ADMIN − invitations.write` đóng theo `requires`** (B-20, Task 9): không quyền nào `requires` `invitations.write` trong catalogue gộp hiện tại; nếu có, trigger closure làm seed ném rõ ràng và test chọn bỏ thêm quyền phụ thuộc.

### 8. Review Focus → test

| # | Test |
|---|---|
| 1 | Task 9 (`Review Focus 1: the invited email is normalised …`), Task 4 (`the email must be canonical`), Task 7 (map `org_invitations_email_ck` → `422`) |
| 2 | Task 9 (`Review Focus 2: accepting while already a member …`), Task 10 (`joining while already a member …`), Task 13 (T-3) |
| 3 | Task 9 (`Review Focus 3: garbage tokens …`), Task 10 (`Review Focus 3 (links) …`) |
| 4 | Task 10 (`Review Focus 4: link TTL and max uses at the boundaries`, `… an exhausted link frees a slot …`) |
| 5 | Task 11 (`Review Focus 5: only the recipient …`, `… non-owners list only their own requests …`) |

