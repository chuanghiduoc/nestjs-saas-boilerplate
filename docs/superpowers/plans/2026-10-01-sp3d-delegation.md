# Sub-project 3D — Ủy quyền (delegation): org API key, support grant, step-up 2FA của nhân viên — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm phần ủy quyền của SP3 vào module `tenancy` và `identity` đã có trên `main`: org API key `oak_` (credential máy gắn cứng một org, chạy ở cả ba `AUTH_MODE`), support grant chỉ đọc có hạn do owner cấp cho nhân viên nền tảng, bảo đảm 2FA của nhân viên bằng step-up TOTP trong session (dấu `auth.session_second_factor`, gate mọi đường quyền nền tảng, lockout consume trước, lệnh CLI `identity:staff-2fa-reset`, hàng rào sau ghi cho nhân viên chưa có factor), decorator `@PlatformStaffAction()` + port `PlatformAccessAudit` cho route `/v1/admin/**` của SP4/SP5/SP6, và luật `order` duy nhất của registry participant xoá cứng; chứng minh bằng test trên Postgres 18 + PgBouncer + Redis + Mailpit thật và bằng smoke chạy image production qua `docker compose --profile app`; 3D ship một mình với CI xanh.

**Architecture:** Identity nhận hai migration (`auth.session_second_factor` với hai FK `CASCADE`; kind `operator_reset` + cột `ticket` của `auth.security_notice`) và module `staff-step-up.ts` chứa mọi câu SQL về factor/dấu của nhân viên, dùng chung cho hook Better Auth, Bull Board, `PlatformStaffGuard`, `AuthFacts`, hàng rào sau ghi và lệnh CLI; luật của nhân viên nằm ở `staff-hooks.ts` và `staff-credential-fence.ts`, ghép vào `createAuthHooks`/`createAuthInstance` có sẵn. Tenancy nhận migration `…_delegation` (4 bảng RLS FORCE, trigger guard quyền caller, trigger closure dùng chung của 3B, hai constraint trigger hoãn grantee/member `SECURITY DEFINER` thuộc `tenancy_definer` tuần tự hoá bằng `pg_advisory_xact_lock(public.tenancy_org_lock_key(org))`, hai hàm definer), cài port `OrgCredentialAuthenticator` và `PlatformRoleChangeListener` của identity, mở rộng `OrgContextMiddleware` với nhánh org key và nhánh support grant (đọc dấu step-up lười qua `AuthFacts.secondFactorVerifiedAt()`), và mọi đường gán ủy quyền đi qua một hàm miền `checkDelegatedScope`; quyền hiệu lực của key/grant = phạm vi đã lưu ∩ quyền hiện tại của người ủy quyền ∩ tập eligible, tính ở mỗi request, cắt tới điểm bất động, key orphan bị bỏ qua (R-X23).

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), better-auth 1.7.6 (+ `@better-auth/api-key` 1.7.6, `@better-auth/core` 1.7.6), `@casl/ability` 7.0.1 (có từ 3A), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), `pg` (pool `auth_user`), rate-limiter-flexible 11.2.1 (`LoginLockout`), zod 4.6.5, uuid 14.0.2, `node:crypto`, `node:util` `parseArgs`, `node:readline/promises`, `otpauth` 9.5.2 (devDependency, chỉ sinh mã TOTP trong test), Vitest + Testcontainers, `test/support/tcp-proxy.ts`, Docker Compose smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md` (r8, đã chốt; §22.3 Bảng 1–5 dòng 3D là nguồn phạm vi; thiết kế step-up nhân viên r4–r8 ở §5.2 hàng `auth-hooks.ts`/CLI/`identity-directory.ts`, §9.7, §27–§31) và `docs/superpowers/specs/2026-09-28-sp3-addendum-platform-staff.md` (A1–A10: `@PlatformStaffAction()`, `PlatformAccessAudit`, registry `order`). Kèm theo, cùng ràng buộc: phán quyết chéo R-X1…R-X27 (`docs/superpowers/specs/2026-09-28-sp3-7-cross-sp-rulings.md`; dòng chạm 3D: R-X2, R-X3, R-X5, R-X7, R-X12, R-X17, R-X21, R-X23, R-X24, R-X25), `docs/superpowers/specs/2026-09-28-sp3-parent-spec-amendments.md` (dòng A7 và bỏ nhãn `(3D)`), ADR 0017, spec cha `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`. Mẫu định dạng và tên code dùng lại: `docs/superpowers/plans/2026-09-29-sp3c-acquisition.md`, `docs/superpowers/plans/2026-09-29-sp3b-custom-roles.md`.

**Điều kiện bắt đầu (phụ thuộc thật):** `origin/main` ở `90340a4` (merge PR #9 `sp3c-acquisition`) hoặc mới hơn. Đã merge và 3D dùng: **3A** (pipeline, `PrincipalResolver` định tuyến `oak_` tới port `OrgCredentialAuthenticator`, `AuthFacts`, `UserDeletionGuard`, `adminTargetUserId`, registry participant với luật `order ∈ [0, 1000)`), **3B** (`RolePermissions` + key orphan R-X23, `assertCanBind`/`assertCanManage` với `orphans`, hàm closure `tenancy_permission_scope_closed_ck`, `test/support/catalogue-migration.ts`), **3C** (`org_invitations`/`org_invite_links`/`org_ownership_transfers`, `GrantorRecheck`, `TransferSettlement`, `resolveTenancyFeatures` hai cờ, `TenancyFeatures`, `raceOnOrgLock`, hằng `*_3C` của `test/support/tenancy-catalog.ts`, `clock_timestamp()` sau khoá, trigger trạng thái cuối), **6.0** (`routeTemplateOf`/`normalizeTemplate` ở `src/core/http/route-template.ts`; `defineEvent` đòi cờ `audit`/`webhook` — R-X3; `defineOrgSweep`, kill switch), **7A** (composition, `.upstream/zones.json` phân vùng theo tiền tố, README ở `docs/boilerplate/README.md`), **4A** (catalogue `entitlements` có `entitlements.read` `apiKeyEligible` + `supportEligible`; route `tenancy.*` có `requireEnabled` chạy sau CASL). Nhánh `sp3d-delegation` tạo từ `origin/main` mới nhất. 3D là plan merge SAU 3C nên ghi dòng "SP3 (cuối)" vào ADR 0013 (spec §18.4, Bảng 5).

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, SP2, 3A, 3B, 3C (mục Global Constraints của `2026-09-28-sp3a-tenancy-foundation.md`, `2026-09-29-sp3b-custom-roles.md`, `2026-09-29-sp3c-acquisition.md`), cộng các luật của SP3 (spec §3) và addendum, bắt buộc cho mọi task:

- **Package-first:** 3D không cài package nào (spec §18.4: "3B, 3C, 3D không thêm dependency"). `otpauth` 9.5.2 đã là devDependency của SP2 (chỉ dùng trong `test/`). Token/hash bằng `node:crypto` (`randomBytes`, `createHash('sha256')`); tham số CLI bằng `node:util` `parseArgs`; xác nhận bằng `node:readline/promises`.
- **Generator:** `pnpm exec mikro-orm migration:create --blank --path src/migrations/<module> --name <tên>`; tên file do CLI sinh (`Migration<14 chữ số>_<tên>`), plan viết `Migration<ts>_<tên>` (`<ts>` = timestamp CLI sinh lúc chạy), code và test tìm migration theo hậu tố tên. Thứ tự timestamp của 3D: `identity` (Task 3, Task 10) → `tenancy` (Task 14) → `notifications` (Task 23) — đúng thứ tự task nên CLI tự sinh tăng dần (spec §6.13); mọi timestamp lớn hơn migration mới nhất trên `main` ở cùng vùng (hôm nay `notifications/Migration20261001090216_acquisition_templates`, `tenancy/Migration20261001090207_acquisition`; `migration-order.spec.ts`). Khung Nest bằng `nest g controller|guard <path> --no-spec` rồi thay nội dung.
- **Không đoán API:** Better Auth 1.7.6 chỉ dựa vào điều spike T7 (Task 1–2) đã chạy thật; nhánh không đạt đi đúng fallback của spec §4 (không đạt (a)/(b) → support grant tắt ở mọi mode; không đạt (g) → bỏ lớp chặn trước câu ghi; không đạt (h) ở bất kỳ điểm hook nào → **dừng 3D và báo Sếp**). TDD, không `any`, không tắt lint, không `as never`.
- **Bất biến nằm ở DB:** phạm vi key/grant đóng theo `requires` (constraint trigger hoãn dùng chung của 3B); eligibility (`api_key_eligible`/`support_eligible` + `action = 'read'`, không `owner_only`, không deprecated) là trigger guard; grantee không là member và member không có grant mở là hai constraint trigger hoãn; một grant mở mỗi `(org, grantee)` là partial `UNIQUE`; key/grant đã thu hồi giữ nguyên thu hồi (trigger trạng thái cuối, bài học 3C); dấu step-up mất theo factor/session bằng FK `CASCADE`; `ticket` chỉ có với `operator_reset` là `CHECK`. Vi phạm từ trigger: `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = '<tên>'`, map bằng `defineConstraintErrors`.
- **Trigger đọc bảng tenant lúc COMMIT là `SECURITY DEFINER` thuộc `tenancy_definer`** (carry của 3A Task 13 và bài học 3B): `SET search_path = ''`, tên đủ `public.`, tạo/xoá dưới `SET LOCAL ROLE tenancy_definer … RESET ROLE`, kiểm `current_setting('transaction_isolation') = 'read committed'` trước mọi đọc, tuần tự hoá bằng `pg_advisory_xact_lock(public.tenancy_org_lock_key(org))` (definer không khoá được dòng), `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` như ba trigger hoãn của 3A. Trigger quyền caller dưới FORCE RLS mù khi caller đổi `app.org_id` giữa transaction; test đổi context trước `COMMIT` cho cả hai trigger (Task 15).
- **Mốc thời gian sau khoá (bài học 3C):** mọi giá trị ghi sau khi đã lấy khoá dòng org (`revoked_at`, `first_used_at`) dùng `clock_timestamp()`, không `now()`; mọi so hết hạn sau khoá dùng `clock_timestamp()` (spec §3.15). Đọc không chờ khoá (hàm definer, tra quyền ở middleware) dùng `now()`.
- **Kiểu dữ liệu:** PK `BIGINT GENERATED ALWAYS AS IDENTITY` + `public_id UUID DEFAULT uuidv7()`; bảng nối không có `id`; `auth.session_second_factor` PK là `session_id` (thuộc hẳn session). Thời gian `TIMESTAMPTZ`; enum `TEXT` + `CHECK`. Hằng định dạng dùng chung giữa zod và `CHECK`/SQL: `ORG_API_KEY_PREFIX = 'oak_'` (identity, đã có), `ORG_API_KEY_SECRET_BYTES = 32`, `KEY_HINT_LENGTH = 6`, `ORG_API_KEY_NAME_MAX_LENGTH = 64`, `SUPPORT_GRANT_REASON_MAX_LENGTH = 500`, `STAFF_RESET_TICKET_MAX_LENGTH = 128`, `STAFF_RESET_PASSWORD_BYTES = 18`, `STAFF_RESET_TX_ATTEMPTS = 3`, `STAFF_RESET_EXIT_NOT_COMMITTED = 1`, `STAFF_RESET_EXIT_COMMITTED = 2` (migration viết cứng cùng giá trị; test khoá hai bên bằng nhau).
- **FK có chủ đích:** `org_api_keys → org_members` `CASCADE` (ủy quyền không sống lâu hơn membership của người ủy quyền); bảng nối → cha `CASCADE`, → `permissions` `RESTRICT`; `org_api_keys.org_id`, `org_support_grants.org_id → organizations` `RESTRICT` (neo trực tiếp, M5/B5); `grantee_user_id → tenancy_users` `SET NULL`; `granted_by_member_id` FK kép `SET NULL (granted_by_member_id)`; `auth.session_second_factor` → `auth.session`, `auth.two_factor` `CASCADE`.
- **Mọi index gắn với một query** (chú thích đầu migration); index của bảng tenant bắt đầu bằng `org_id`, trừ `UNIQUE (token_hash)` (hàm definer tra theo hash, không biết org), `(grantee_user_id)` (FK `SET NULL` + hàm definer quét nhiều org), `(permission_id)` của bảng nối (FK `RESTRICT` + migration catalogue quét xuyên org).
- **Migration:** SQL bằng `addSql`; `down` đối xứng đã test (up → down → up và sweep S2-R57 trên database riêng của `migrations.spec.ts`), xoá cả hàm trigger và trigger gắn trên bảng sống (`org_members`); không `ALTER DEFAULT PRIVILEGES`; mọi đọc/ghi dữ liệu trên bảng FORCE theo mẫu `NO FORCE … FORCE` + khối khẳng định; không `isTransactional()`; không `SET CONSTRAINTS ALL`. `down` của `…_delegation` từ chối khi còn key/grant chưa thu hồi còn hạn (không xoá credential âm thầm, cùng lý do `down` của 3C); `down` của `…_security_notice_operator_reset` khoá bảng trước, từ chối khi còn marker/thư `operator_reset` chưa xong (spec §6.13).
- **Chuẩn hoá (≥ 3NF, ưu tiên BCNF):** chép bảng spec §6.12 vào chú thích đầu migration (4 bảng 3D + `auth.session_second_factor` + cột `ticket`); ngoại lệ E1 có tên (FK kép, không grant `UPDATE` trên `org_id`, `WITH CHECK`); `normalization-inventory.spec.ts` thêm đủ cột.
- **Mọi race có tên và cơ chế chặn** (bảng race 3D ở Self-review, spec Bảng 2: T-11 (key), T-15, T-17, T-19, T-20, T-30, T-31, T-35, T-37, T-38, T-39, T-40, T-41, T-42, T-43). Check-then-insert không bao giờ là cơ chế. Khoá dòng `FOR NO KEY UPDATE`, thứ tự `organizations` → `tenancy_users` → `org_roles` → `org_members` (id tăng dần) → bảng còn lại; race test ép giao nhau bằng seam có sẵn (`raceOnOrgLock` của `test/support/org-lock-barrier.ts`, `TenancyTestHooks.afterGuard`/`beforeRelease`) hoặc seam mới có tên, không bằng `sleep` may rủi; transaction của lệnh reset: câu đầu khoá dòng user, thứ tự câu bất biến (spec §9.7 (5)).
- **Mọi đường gán ủy quyền kiểm lại người ủy quyền:** tạo key/grant đọc lại actor dưới khoá org bằng `ActorReauthorizer.require` (TOCTOU, T-10); thu hồi key của người khác dùng `assertCanManage` (luật 4 + 2a(v)) với quyền HIỆN TẠI của người tạo; key orphan trong phạm vi đã lưu không cấp gì (R-X23) và được báo một lần mỗi key mỗi process.
- **Không hard code:** giới hạn, thời hạn lấy từ `tenancy.config.ts` (5 env mới của spec §13) và config identity có sẵn (`AUTH_SESSION_FRESH_AGE_SEC`, `AUTH_LOCKOUT_*`); hằng định dạng có tên. `test/unit/architecture/hardcode-scan.spec.ts` xanh.
- **Fail loud:** request state thiếu subject ở `PASSWORD_WRITE_PATHS` → `500` + ERROR; hàng rào lỗi DB → `503`; `PlatformStaffGuard` ở `local`/`hybrid` mà vắng `StaffStepUp` → ném lúc chạy; port audit ném → `503`; hàm definer nhận `NULL`/hash sai độ dài → `RAISE`; actor của event tenancy với principal không phải user → ném. Ngoại lệ có tên (R-X23): key orphan trong phạm vi key/grant không cấp gì, không 500.
- **Tập quyền trong test tính từ catalogue gộp (R-X24):** preset support = mọi quyền `supportEligible` có `action = 'read'` của catalogue gộp; phạm vi key "đủ" = mọi quyền `apiKeyEligible` không `ownerOnly`, không deprecated; không viết cứng.
- **Luật lỗi trong hook Better Auth:** mọi từ chối là `problem()` của `createAuthHooks` hoặc `APIError` có mã trong `AUTH_CODE_MAP`; không ném `AppError` ra khỏi hook.
- **Truy cập SQL:** tenancy chỉ qua `Db.execute` (placeholder `?`; mảng truyền bằng `ARRAY[?]::<kiểu>[]` hoặc `?::text[]`, bài học Task 20 của 3A); identity dùng pool `auth_user` (`AUTH_POOL`). Không I/O ngoài trong `UnitOfWork.run` của request HTTP; lời gọi pool auth (`IdentityDirectory`, `AuthFacts.secondFactorVerifiedAt`) nằm ngoài transaction của pool app ở mọi đường HTTP. Ngoại lệ có tên duy nhất: subscriber `tenancy.notify-owners` gọi `IdentityDirectory.findUsers` bên trong transaction inbox của chính nó (spec §9.7 "Thông báo owner"; pool khác nên không tự khoá, có deadline `DB_AUTH_QUERY_TIMEOUT_MS`).
- **Luật kiến trúc:** giữ luật 1–27 hiện có; 3D không thêm luật; `modules/identity/**` không import `modules/tenancy/**` (luật 18), `test/support/platform-staff-action.conformance.ts` chỉ import `test/support/*` và `index.ts` của module (PSA-9).
- **Không PII:** không email, token, mật khẩu, `key_hint`, `reason` của grant, ticket trong metric/span; log của identity chỉ `userId` (principal id) và `ticket` ở đúng các dòng spec §16 liệt kê; không secret nào trong log.
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** cuối nhóm identity (Task 13), cuối nhóm schema tenancy (Task 15) và ở Task 28 chạy `pnpm test:smoke`: build image production thật, `docker compose --profile app` với hạ tầng đầy đủ và `NODE_ENV=production`, migrate từ `dist`, smoke HTTP thật trong `test/smoke/`, log container JSON sạch (không PII, không `error`), `/health/ready` 200, `down -v`. Đo lại kích thước image (ADR 0013; 3D merge sau 3C nên ghi dòng "SP3 (cuối)").
- **Spike:** code spike là code bỏ đi (`test/integration/spike-sp3d/`, không commit). Kết quả ghi vào mục "Kết quả spike (plan 3D)" của ADR 0017 và được commit.
- **Upstream:** mọi file mới của 3D nằm dưới tiền tố đã phân vùng `boilerplate` của `.upstream/zones.json` (`src/modules/`, `src/migrations/`, `test/`, `docs/adr/`, `docs/boilerplate/`, `docs/superpowers/`); `node tools/upstream/check.mjs --self` phải xanh ở Task 30 mà không sửa `zones.json`.
- **Định dạng và commit:** trước mỗi commit `pnpm exec prettier --write <file đã đổi ngoài docs/>`; mỗi task một commit trở lên, conventional message tiếng Anh. Không push, không mở PR: Task 30 dừng ở "sẵn sàng cho PR" (controller push và mở PR).

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không test nào của spec §18 phủ, dễ làm hỏng trải nghiệm người dùng nhất:

1. **Org key có tiền tố viết hoa, thừa ký tự hoặc cắt cụt** (`OAK_…`, thừa một ký tự, 20 ký tự đầu, một ký tự ngoài base64url, chỉ `oak_`; khoảng trắng đầu/cuối bị parser HTTP bỏ nên không phải biến thể): `isOrgApiKey` so không phân biệt hoa thường nên mọi dạng đều tới `OrgApiKeyAuthenticator` (không bao giờ tới Better Auth). Mong đợi: `401 unauthenticated` giống hệt key không tồn tại, không `500`, hàm definer không bao giờ nhận hash sai độ dài (hash luôn 32 byte), metric `tenancy_org_api_key_auth_total{result="invalid"}`. Test: Task 20 (`Review Focus 1: malformed and case-mangled oak_ keys are a plain 401`).
2. **Tạo key/grant với `permissions` lặp, khác thứ tự, rỗng, hoặc có key không tồn tại; `expiresInSec` ở đúng biên:** mong đợi lặp/khác thứ tự lưu đúng tập (không `23505` PK của bảng nối → `500`), mảng rỗng → `422 validation_failed`, key lạ → `422 unknown_permission`, `expiresInSec = TENANCY_ORG_API_KEY_MAX_TTL_SEC` → `201`, `+1` → `422 ttl_out_of_range`, `0`/số âm/số thực/chuỗi → `422 validation_failed`. Test: Task 19 (`Review Focus 2: scope duplicates, order, empty, unknown; TTL boundaries`), Task 21 (grant: `expiresInSec` biên `TENANCY_SUPPORT_GRANT_MAX_TTL_SEC`).
3. **Nhân viên đã step-up gọi route tenant của một org mà họ ĐỒNG THỜI có grant và vừa được mời thành member:** membership thắng (support grant bị thu hồi lúc admit, SEC-M5) — mong đợi `orgAccess.via = MEMBERSHIP`, không bao giờ `SUPPORT_GRANT` trên org mà mình là member, và không có `403 second_factor_required` cho member. Test: Task 24 (`Review Focus 3 / S-15: a grantee who becomes a member is served as a member`).
4. **Step-up bằng mã TOTP đã dùng trong cùng cửa sổ 30 s và mã có khoảng trắng/độ dài sai:** Better Auth không ghi mã đã dùng nên dùng lại mã vẫn `200` (hành vi thư viện, ghi README); mã sai định dạng → lỗi 4xx của Better Auth và **vẫn** bị lockout đếm (consume trước), không bao giờ `500`, không dấu. Test: Task 6 (`no mark: … a malformed code (Review Focus 4)`, `right codes are counted too`).
5. **Lệnh reset với `--user-id` viết hoa, có khoảng trắng hoặc không phải UUID:** `auth."user".id` là `uuid` nên Postgres tìm ra user với id viết hoa; lệnh phải đòi dạng chữ thường chuẩn (cùng luật `adminTargetUserId`) và exit `1` trước mọi truy cập DB, để marker/log mang đúng id. Test: Task 11 (`Review Focus 5: --user-id must be a canonical lowercase UUID`).

---

## File Structure

```
src/
  core/context/principal.ts          CREDENTIAL_KINDS + 'ORG_API_KEY'; Credential.orgId
  migrations/
    identity/      Migration<ts>_session_second_factor.ts (Task 3) · Migration<ts>_security_notice_operator_reset.ts (Task 10)
    tenancy/       Migration<ts>_delegation.ts (Task 14)
    notifications/ Migration<ts>_support_templates.ts (Task 23)
  modules/identity/
    index.ts                         + PlatformRoleChangeListener, isBanned, PlatformStaffAction, PLATFORM_STAFF_ACTION,
                                       hasPlatformStaffAction, PlatformAccessAudit, NoopPlatformAccessAudit, PlatformAccessEntry
    errors.ts (+SECOND_FACTOR_REQUIRED, LAST_PLATFORM_ADMIN, API_KEY_NOT_ALLOWED_HERE) · identity-metrics.ts (+3 counter)
    identity.module.ts (+PlatformStaffGuardModule ở forApi)
    ports/         auth-provider.ts (+sessionId) · identity-directory.ts (hasAdminRole bỏ trim)
                   platform-role-change-listener.ts (mới) · platform-access-audit.ts (mới) · security-notice-ledger.ts (+operator_reset)
    http/          credential-detector.ts (DetectedCredentialKind) · auth.guard.ts (ORG_API_KEY) · auth-facts.ts (+secondFactorVerifiedAt)
                   platform-staff-action.decorator.ts · staff-access.ts · platform-staff.guard.ts · platform-staff-guard.module.ts (mới)
    application/   auth-emails.ts (kind → tham số thư)
    infra/better-auth/
                   staff-step-up.ts (mới: câu dấu, factor, "còn admin khác", ghi dấu, revokeUserCredentials, hằng)
                   staff-hooks.ts (mới: luật (1)–(8) của spec §5.2) · staff-credential-fence.ts (mới: lớp chặn trước câu ghi + hàng rào (9))
                   admin-target.ts (mới: asRecord, stringField, adminTargetUserId chuyển từ auth-hooks.ts)
                   auth-hooks.ts (ghép staff hooks, resetPasswordToken, hooks.after /api-key/create)
                   auth-instance.ts (databaseHooks ghép fence) · auth-request-state.ts (+stepUp, subjects, factors)
                   auth-error.mapper.ts (+3 mã trong AUTH_CODE_MAP) · login-lockout.ts (scope step-up, accountKey, lockoutRowKeys)
                   auth-schema.ts (+SESSION_SECOND_FACTOR_TABLE) · better-auth.provider.ts (sessionId)
                   better-auth-core.module.ts (StaffStepUp, listener optional) · pg-security-notice-ledger.ts (kind mới)
                   auth.cli-config.ts (export pool) · staff-2fa-reset.ts · staff-2fa-reset.cli.ts (mới)
    infra/jwks/jwks.provider.ts (sessionId: undefined)
    infra/dashboard/platform-admin.authorizer.ts (gate dấu TOTP)
  modules/notifications/
    templates.ts (+support-access-notice, two-factor-changed.operatorReset)
    templates/support-access-notice/en/{subject.hbs,body.mjml,text.hbs} (mới) · templates/two-factor-changed/en/* (nhánh operatorReset)
  modules/tenancy/
    constants.ts · errors.ts · events.ts · tenancy.config.ts · tenancy.module.ts · index.ts
    domain/        delegation.ts · org-api-key.ts · support-grant.ts (mới) · escalation.ts (+rule 'delegation')
                   tenancy-features.ts (+cờ supportGrants, lý do EXTERNAL_MODE)
    application/   org-api-key.service.ts · support-grant.service.ts · delegation-revocations.ts · notify-owners.subscriber.ts (mới)
                   authz/delegated-permissions.ts (mới) · tenancy-features.ts · actor-reauthorizer.ts (userActor fail loud)
                   member-admission.ts · member.service.ts · user-deletion.service.ts · org-lifecycle.service.ts
                   org-purge-participant.registry.ts (order duy nhất, addendum A4 luật 1) · tenancy-metrics.ts
    ports/         org-api-key-repository.ts · support-grant-repository.ts (mới)
    infra/sql/     sql-org-api-key.repository.ts · sql-support-grant.repository.ts (mới) · org-purge.sql.ts (+4 bảng)
    infra/identity/ org-api-key.authenticator.ts · platform-role-change.listener.ts (mới) · tenancy-identity-ports.module.ts
    http/          api-keys.controller.ts · support-grants.controller.ts · org-api-key-confinement.guard.ts (mới)
                   org-context.middleware.ts (nhánh key + support) · policy-metadata.ts (NARROWING_ROUTES) · schemas.ts
                   tenancy-http.module.ts
package.json                         script "identity:staff-2fa-reset"
test/
  support/  seed-staff-step-up.ts · staff.ts · platform-staff-action.conformance.ts (mới)
            tenancy-seed.ts (+seedOrgApiKey, seedSupportGrant, PURGE thứ tự 3D) · tenancy-principals.ts (+seedStaffPrincipal)
            tenancy-catalog.ts (+hằng 3D) · identity-app.ts (promoteToStaff) · catalogue-migration.ts (+key/grant)
  unit/     modules/identity/{lockout-row-keys,reset-password-token,password-route-drift,staff-2fa-reset-args,staff-access,
                              platform-staff-action,admin-plugin-config,auth-guard-proof,auth-facts}.spec.ts
            modules/tenancy/{delegation,org-api-key-token,tenancy-features,registries,org-api-key-confinement}.spec.ts
            core/events/event-flags.spec.ts (7 event mới)
  integration/ identity/{session-second-factor-schema,staff-step-up,admin-role-equivalence,password-write-guard,
                         staff-credential-fence,security-notice-operator-reset,staff-2fa-reset,staff-2fa-reset-races}.spec.ts
               identity/{auth-schema,auth-hooks}.spec.ts (sửa)
               tenancy/{delegation-db,delegation-isolation,delegation-definer,delegation-down,delegation-repositories,
                        delegation-catalogue-migration,platform-staff-di}.spec.ts
               core/database/{rls-catalog,normalization-inventory,migrations}.spec.ts (sửa)
  e2e/identity/{me-admin-role,step-up,staff-gate,staff-password-rules,staff-credential-fence,staff-credential-fence-idp,
                platform-staff-action}.e2e.spec.ts
  e2e/tenancy/{org-api-keys,org-api-key-auth,support-grants,support-access,support-role-change,delegation-lifecycle,
               delegation-races}.e2e.spec.ts · role-route-matrix.e2e.spec.ts (+cột key, grant; route 3D) · auth-modes.e2e.spec.ts (+3D)
  chaos/delegation-outages.spec.ts · chaos/delegation-api-kill.spec.ts
  smoke/tenancy.smoke.spec.ts (+3D) · dashboard.smoke.spec.ts (admin step-up TOTP thật)
docs/adr/ 0017 (kết quả spike 3D, cập nhật 3D) · 0005 · 0007 · 0010 · 0013 (dòng "SP3 (cuối)")
docs/boilerplate/README.md (org API key, support grant, step-up nhân viên, runbook lệnh reset)
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (A7, bỏ nhãn `(3D)`)
```

**Vì sao `staff-hooks.ts` và `staff-credential-fence.ts` tách khỏi `auth-hooks.ts`:** `auth-hooks.ts` đã 781 dòng và chứa luật của SP2/3A; luật nhân viên (tám luật + hàng rào) là một khối có cùng tập phụ thuộc (`StaffStepUp`, request state, lockout), đổi cùng nhau, test cùng nhau. `createAuthHooks` gọi hai module này ở đúng điểm spec quy định (sau kiểm email S2-R76, trước kiểm độ mới), nên thứ tự luật vẫn đọc được ở một chỗ.

**Vì sao `API_KEY_NOT_ALLOWED_HERE` thuộc identity, không thuộc tenancy như spec §15 ghi (lệch có chủ đích):** org key trên route `@SessionOnly()` ngoài tenant (mọi route admin có `@PlatformStaffAction()`) bị **hai** `APP_GUARD` từ chối: `AuthGuard` (identity, nhánh `@SessionOnly`) và `OrgApiKeyConfinementGuard` (tenancy). Thứ tự giữa `APP_GUARD` của các module khác nhau không được bảo đảm (spec §7.1 bước 4), nên nếu hai guard trả hai mã khác nhau thì mã ra client phụ thuộc thứ tự import. Identity sở hữu mã (identity không import tenancy; tenancy dùng lại `IdentityErrors.API_KEY_NOT_ALLOWED_HERE` như `SECOND_FACTOR_REQUIRED`), hai guard trả cùng `403 api_key_not_allowed_here`, bộ ca C4 của addendum tất định. API key của Better Auth trên `@SessionOnly` vẫn `403 forbidden` (hành vi SP2).

**Vì sao `PlatformAdminAuthorizer` và `PlatformStaffGuard` không gọi lại `getSession` (lệch có chủ đích so với spec §5.2 hàng `platform-admin.authorizer.ts`):** 3D đưa `session.id` vào kết quả `AUTHENTICATED` của `BetterAuthProvider` (`sessionId`, đọc từ CHÍNH lời gọi `getSession` mà provider đã làm), nên câu dấu TOTP có đủ `(userId, sessionId)` mà không cần lời gọi thứ hai; một lời gọi thêm vừa tốn một lookup vừa có thể thấy session khác (đua với xoá). Hook Better Auth vẫn đọc session bằng `d.session(headers)` như SP2 (spec R4C-N4-1).

**Vì sao không có port `DelegationAccessReader` riêng:** câu đọc của nhánh key và nhánh support ở middleware là phương thức của chính hai repository (`findActiveForAccess`, `findOpenForAccess`), chạy trong cùng `UnitOfWork` đọc ngắn với câu đường nóng của 3A; một port thứ ba chỉ chuyển tiếp lời gọi (KISS).

---

## Phần A — Spike T7 (bắt buộc làm trước mọi task khác, spec §4 hàng T7)

Spec §4 giao T7 cho 3D vì nó cần bảng `auth.session_second_factor` và nhánh support grant. Mỗi câu hỏi (a)–(h) được trả lời bằng code chạy thật trên Better Auth 1.7.6 đã cài; kết quả (đạt/không đạt + bằng chứng) ghi vào ADR 0017 mục "Kết quả spike (plan 3D)" và được commit. Spike dùng một instance Better Auth **trần** dựng bằng đúng `corePlugins(...)` của repo (cùng plugin, cùng option) cộng hook/`databaseHooks` thăm dò, trên pool `auth_user` thật của hạ tầng test, để quan sát hành vi thư viện mà không phụ thuộc hook của repo. Bảng dấu được tạo tạm bằng `app_owner` với **đúng** DDL của migration Task 3 và xoá ở cuối. Code spike nằm ở `test/integration/spike-sp3d/` (project `integration`), **không commit**.

### Task 1: Spike T7 (a)–(f) — step-up trong session, hook thấy session (cả bearer), `after` đọc `returned`, `CASCADE` của dấu, `/admin/*` và `/token` qua cùng hook

**Files:**
- Throwaway: `test/integration/spike-sp3d/harness.ts`, `test/integration/spike-sp3d/step-up.spike.spec.ts`
- Modify: `docs/adr/0017-tenancy-own-module.md` (mục mới "Kết quả spike (plan 3D)", dòng T7a–T7f)

**Interfaces:**
- Consumes: `corePlugins`, `AUTH_SCHEMA` (`src/modules/identity/infra/better-auth/auth-schema.ts`), `identityConfig`, `identityGuardConfig`, `authDatabaseConfig` (`identity.config.ts`), `createAuthPool` (`auth-pool.ts`), `databaseConfig` (core), `applyTestEnv` (`test/support/app-factory.ts`), `getInfra` (`test/support/infra.ts`), `otpauth` `URI`.
- Produces: kết luận T7a–T7f trong ADR 0017; quyết định cho Task 6, 7: (1) hook `before` đọc session bằng `auth.api.getSession({ headers })` (không `getSessionFromCtx`); (2) `ctx.context.returned` ở hook `after` là `{ token, user }` khi thành công, `APIError` có `body.code` `INVALID_CODE`/`INVALID_BACKUP_CODE` khi sai; (3) nhánh có session không tạo session mới và không đổi `two_factor.verified`; (4) xoá dòng `auth.two_factor` (qua `/two-factor/disable` hoặc SQL của `auth_user`) và xoá session `CASCADE` sang dấu.

- [ ] **Step 1: Harness (instance trần + thăm dò)**

`test/integration/spike-sp3d/harness.ts`:
```ts
import { betterAuth } from 'better-auth';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig, identityConfig, identityGuardConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { AUTH_SCHEMA, corePlugins } from '../../../src/modules/identity/infra/better-auth/auth-schema.js';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'spike sp3d correct horse';
/** DDL giống hệt migration `…_session_second_factor` (Task 3): spike kiểm đúng thứ sẽ ship. */
export const MARK_DDL = `CREATE TABLE auth.session_second_factor (
  session_id uuid PRIMARY KEY REFERENCES auth.session (id) ON DELETE CASCADE,
  two_factor_id uuid NOT NULL REFERENCES auth.two_factor (id) ON DELETE CASCADE,
  method text NOT NULL CONSTRAINT session_second_factor_method_ck CHECK (method IN ('totp', 'backup_code')),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX session_second_factor_two_factor_idx ON auth.session_second_factor (two_factor_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.session_second_factor TO auth_user;`;

export type Probe = { path: string; sessionViaApi: string | null; sessionViaCtx: string | null; returned?: unknown };
export function spikeAuth(extra: Partial<Parameters<typeof betterAuth>[0]> = {}) {
  const id = identityConfig();
  const pool: pg.Pool = createAuthPool(authDatabaseConfig(), databaseConfig());
  const before: Probe[] = [];
  const after: Probe[] = [];
  const auth = betterAuth({
    secret: id.secret,
    baseURL: ORIGIN,
    basePath: '/api/auth',
    database: {
      db: new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] }),
      type: 'postgres',
      schemaName: AUTH_SCHEMA,
      transaction: true,
    },
    emailAndPassword: { enabled: true, autoSignIn: false },
    advanced: { database: { generateId: 'uuid' }, disableOriginCheck: false, disableCSRFCheck: false },
    plugins: corePlugins(id, { serviceName: 'spike' }, identityGuardConfig()),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const viaApi = await auth.api.getSession({ headers: ctx.headers ?? new Headers(), query: { disableCookieCache: true, disableRefresh: true } });
        const viaCtx = await getSessionFromCtx(ctx).catch(() => null);
        before.push({ path: ctx.path, sessionViaApi: viaApi?.session.id ?? null, sessionViaCtx: viaCtx?.session.id ?? null });
      }),
      after: createAuthMiddleware(async (ctx) => {
        after.push({ path: ctx.path, sessionViaApi: null, sessionViaCtx: null, returned: ctx.context.returned });
      }),
    },
    ...extra,
  });
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) =>
    auth.handler(new Request(`${ORIGIN}/api/auth${path}`, {
      method: init.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: init.method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
    }));
  const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  /** User mới đã có mật khẩu (sign-up), đăng nhập → cookie + bearer. */
  const signedIn = async (role?: string) => {
    const email = `spike3d-${randomUUID()}@example.test`;
    const up = await call('/sign-up/email', { body: { email, password: PASSWORD, name: 'Spike' } });
    if (up.status >= 400) throw new Error(`sign-up ${up.status}`);
    if (role) await pool.query(`UPDATE auth."user" SET role = $2 WHERE email = $1`, [email, role]);
    const r = await call('/sign-in/email', { body: { email, password: PASSWORD } });
    const token = r.headers.get('set-auth-token') ?? '';
    const userId = (await pool.query<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email])).rows[0]!.id;
    return { email, userId, cookie: cookieOf(r), bearer: token };
  };
  return { auth, pool, before, after, call, cookieOf, signedIn };
}
```
(Harness chỉ tồn tại trong spike. `x-forwarded-for` không được tin ở instance trần; IP không ảnh hưởng câu hỏi nào của T7.)

- [ ] **Step 2: Spike (a)–(f)**

`test/integration/spike-sp3d/step-up.spike.spec.ts`:
```ts
import { URI, type TOTP } from 'otpauth';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { MARK_DDL, PASSWORD, spikeAuth } from './harness.js';

describe('spike T7 (a)–(f): step-up in session on Better Auth 1.7.6', () => {
  let owner: pg.Client;
  let h: ReturnType<typeof spikeAuth>;
  const enable = async (u: { cookie: string }) => {
    const en = await h.call('/two-factor/enable', { body: { password: PASSWORD }, cookie: u.cookie });
    expect(en.status).toBe(200);
    const body = (await en.json()) as { totpURI: string; backupCodes: string[] };
    const totp = URI.parse(body.totpURI) as TOTP;
    const v = await h.call('/two-factor/verify-totp', { body: { code: totp.generate() }, cookie: u.cookie });
    expect(v.status).toBe(200);
    // Nhánh bật (verified=false) XOÁ session cũ và đặt cookie session mới (spec §9.7 (9)(i)(b)).
    return { totp, backupCodes: body.backupCodes, cookie: h.cookieOf(v), bearer: (await v.clone().json() as { token: string }).token };
  };
  beforeAll(async () => {
    applyTestEnv();
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
    await owner.query(MARK_DDL);
    h = spikeAuth();
  });
  afterAll(async () => {
    await owner.query('DROP TABLE IF EXISTS auth.session_second_factor');
    await owner.end();
    await h.pool.end();
  });

  it('(a) verify-totp WITH a session checks the code and returns the same session; no new session, verified unchanged', async () => {
    const u = await h.signedIn('admin');
    const s = await enable(u);
    const sessionsBefore = await h.pool.query(`SELECT id, token FROM auth.session WHERE user_id = $1 ORDER BY id`, [u.userId]);
    for (const creds of [{ cookie: s.cookie }, { bearer: s.bearer }]) {
      const r = await h.call('/two-factor/verify-totp', { body: { code: s.totp.generate() }, ...creds });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { token: string; user: { id: string } };
      expect(body.user.id).toBe(u.userId);
      expect(sessionsBefore.rows.map((x) => x.token)).toContain(body.token);
      expect(r.headers.getSetCookie().filter((c) => c.includes('session_token'))).toEqual([]);
    }
    const sessionsAfter = await h.pool.query(`SELECT id, token FROM auth.session WHERE user_id = $1 ORDER BY id`, [u.userId]);
    expect(sessionsAfter.rows).toEqual(sessionsBefore.rows);
    expect((await h.pool.query(`SELECT verified FROM auth.two_factor WHERE user_id = $1`, [u.userId])).rows).toEqual([{ verified: true }]);
    const code = s.backupCodes[0]!;
    const bc = await h.call('/two-factor/verify-backup-code', { body: { code }, bearer: s.bearer });
    expect(bc.status).toBe(200);
    expect((await h.call('/two-factor/verify-backup-code', { body: { code }, bearer: s.bearer })).status).toBe(401); // đã tiêu thụ
  });
  it('(b) the user before-hook sees a bearer-only session through auth.api.getSession, not through getSessionFromCtx', async () => {
    const u = await h.signedIn('admin');
    const s = await enable(u);
    h.before.length = 0;
    await h.call('/two-factor/verify-totp', { body: { code: s.totp.generate() }, bearer: s.bearer });
    const probe = h.before.find((p) => p.path === '/two-factor/verify-totp');
    expect(probe?.sessionViaApi).not.toBeNull();
    expect(probe?.sessionViaCtx).toBeNull();
  });
  it('(c) the after-hook reads success or INVALID_CODE / INVALID_BACKUP_CODE from ctx.context.returned', async () => {
    const u = await h.signedIn('admin');
    const s = await enable(u);
    h.after.length = 0;
    await h.call('/two-factor/verify-totp', { body: { code: s.totp.generate() }, bearer: s.bearer });
    await h.call('/two-factor/verify-totp', { body: { code: '000000' }, bearer: s.bearer });
    await h.call('/two-factor/verify-backup-code', { body: { code: 'nope-nope' }, bearer: s.bearer });
    const [ok, bad, badBackup] = h.after.map((p) => p.returned);
    expect(ok).toMatchObject({ token: expect.any(String), user: expect.any(Object) });
    expect(bad).toMatchObject({ statusCode: 401, body: { code: 'INVALID_CODE' } });
    expect(badBackup).toMatchObject({ statusCode: 401, body: { code: 'INVALID_BACKUP_CODE' } });
  });
  it('(d) /two-factor/disable and an auth_user DELETE of the factor, and a session delete, cascade to the mark', async () => {
    const mark = async (sessionId: string, factorId: string) =>
      h.pool.query(`INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'totp', now())`, [sessionId, factorId]);
    const count = async (uid: string) =>
      Number((await h.pool.query<{ n: string }>(`SELECT count(*) AS n FROM auth.session_second_factor m JOIN auth.session s ON s.id = m.session_id WHERE s.user_id = $1`, [uid])).rows[0]!.n);
    for (const route of ['disable', 'sql', 'session'] as const) {
      const u = await h.signedIn('user');
      const s = await enable(u);
      const f = (await h.pool.query<{ id: string }>(`SELECT id FROM auth.two_factor WHERE user_id = $1`, [u.userId])).rows[0]!.id;
      const sid = (await h.pool.query<{ id: string }>(`SELECT id FROM auth.session WHERE token = $1`, [s.bearer])).rows[0]!.id;
      await mark(sid, f);
      expect(await count(u.userId)).toBe(1);
      if (route === 'disable') expect((await h.call('/two-factor/disable', { body: { password: PASSWORD }, bearer: s.bearer })).status).toBe(200);
      if (route === 'sql') await h.pool.query(`DELETE FROM auth.two_factor WHERE user_id = $1`, [u.userId]);
      if (route === 'session') await h.pool.query(`DELETE FROM auth.session WHERE id = $1`, [sid]);
      expect(await count(u.userId)).toBe(0);
    }
  });
  it('(e) every /admin/* path runs the user before-hook with the session read by getSession, bearer-only included; set-user-password without a session never reaches its handler', async () => {
    const u = await h.signedIn('admin');
    h.before.length = 0;
    for (const path of ['/admin/list-users', '/admin/set-role', '/admin/set-user-password', '/admin/update-user']) {
      await h.call(path, { method: path === '/admin/list-users' ? 'GET' : 'POST', body: { userId: u.userId, role: 'admin', newPassword: 'x'.repeat(12), data: {} }, bearer: u.bearer });
      expect(h.before.find((p) => p.path === path)?.sessionViaApi, path).not.toBeNull();
    }
    const before = (await h.pool.query(`SELECT password FROM auth.account WHERE user_id = $1`, [u.userId])).rows;
    expect((await h.call('/admin/set-user-password', { body: { userId: u.userId, newPassword: 'y'.repeat(12) } })).status).toBe(401);
    expect((await h.pool.query(`SELECT password FROM auth.account WHERE user_id = $1`, [u.userId])).rows).toEqual(before);
  });
  it('(f) GET /token runs the before-hook with the session; the JWT payload carries role', async () => {
    const u = await h.signedIn('admin');
    h.before.length = 0;
    const r = await h.call('/token', { method: 'GET', bearer: u.bearer });
    expect(r.status).toBe(200);
    expect(h.before.find((p) => p.path === '/token')?.sessionViaApi).not.toBeNull();
    const { token } = (await r.json()) as { token: string };
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { role?: string };
    expect(payload.role).toBe('admin');
  });
});
```

- [ ] **Step 3: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp3d/step-up.spike.spec.ts`
Expected: PASS 6/6. Ca nào đỏ: đọc source `node_modules/better-auth/dist/plugins/two-factor/{verify-two-factor,totp/index,backup-codes/index}.mjs`, `api/dispatch.mjs`, `plugins/admin/routes.mjs`, `plugins/jwt/index.mjs` để biết vì sao, ghi vào ADR; (a) hoặc (b) không đạt → nhánh fallback spec §4: support grant tắt ở mọi mode (`TENANCY_SUPPORT_GRANTS=on` → không khởi động; Task 16 viết luật config theo nhánh này), ghi ADR 0017, báo controller trước khi làm Task 6. (c)–(f) không đạt: dừng, báo controller (không có fallback trong spec).

- [ ] **Step 4: Ghi ADR 0017**

`docs/adr/0017-tenancy-own-module.md` — thêm ngay sau mục "Kết quả spike (plan 3B)":
```markdown
## Kết quả spike (plan 3D)

Chạy trên nhánh `sp3d-delegation`, Better Auth 1.7.6 (`@better-auth/api-key` 1.7.6), instance trần dựng bằng `corePlugins` của repo cộng hook thăm dò, pool `auth_user` của hạ tầng Testcontainers (Postgres 18). Bảng dấu tạo tạm bằng đúng DDL của migration `…_session_second_factor`.

| # | Kết quả | Bằng chứng |
|---|---|---|
| T7a | <Đạt/Không đạt>. `verify-totp`/`verify-backup-code` gửi khi đã có session (cookie hoặc chỉ bearer) với factor đã verify chỉ kiểm mã và trả `{ token, user }` của chính session đó; không tạo session, không `Set-Cookie` session, `two_factor.verified` giữ nguyên; backup code bị tiêu thụ. | `step-up.spike.spec.ts` (a) |
| T7b | <…>. Hook `before` của user thấy session bearer-only qua `auth.api.getSession({ headers })`; `getSessionFromCtx` trả `null` (hook user chạy trước hook `bearer`). | (b) |
| T7c | <…>. Hook `after` đọc `ctx.context.returned`: thành công `{ token, user }`, sai `APIError` 401 `body.code` `INVALID_CODE` / `INVALID_BACKUP_CODE`. | (c) |
| T7d | <…>. `/two-factor/disable`, `DELETE auth.two_factor` bằng `auth_user` và xoá session đều `CASCADE` sang dấu. | (d) |
| T7e | <…>. Mọi `/admin/*` (kể cả bearer-only) chạy hook `before` với session đọc được; `/admin/set-user-password` không session → 401 của `adminMiddleware`, không ghi mật khẩu. | (e) |
| T7f | <…>. `GET /token` qua hook `before` với session; payload JWT có `role`. | (f) |
| T7g | (Task 2) | |
| T7h | (Task 2) | |
```
Thay `<…>` bằng kết quả thật của Step 3 (dữ liệu của lần chạy, không phải chỗ trống của plan).

- [ ] **Step 5: Commit (chỉ ADR; spike không commit)**

```bash
git add docs/adr/0017-tenancy-own-module.md
git commit -m "docs(adr): record SP3 plan 3D spike T7 (a)-(f) on Better Auth 1.7.6"
```

---

### Task 2: Spike T7 (g)–(h) — request state trong `databaseHooks.account.*.before` của ba path ghi mật khẩu; `*.create.after`/`account.update.after` chạy sau câu ghi và lỗi ném ở đó đi ngược tới handler; `hooks.after` của `/api-key/create`

**Files:**
- Throwaway: `test/integration/spike-sp3d/password-write.spike.spec.ts`
- Modify: `docs/adr/0017-tenancy-own-module.md` (dòng T7g, T7h)

**Interfaces:**
- Consumes: harness Task 1 (`spikeAuth`, `PASSWORD`), `defineRequestState` (`@better-auth/core/context`), `APIError` (`better-auth/api`).
- Produces: kết luận T7g, T7h; quyết định cho Task 8 (lớp chặn trước câu ghi ở `account.update.before`/`account.create.before` nhận `ctx.path` và `data = { password }`, ném `APIError` ở đó thì câu `UPDATE` không chạy) và Task 9 (`session.create.after` nhận `ctx.path`, `ctx.body`, `ctx.context.session`, `ctx.context.password.verify`; ném ở đó → handler không trả `Set-Cookie`; `account.create.after`/`account.update.after` chạy sau câu ghi; `hooks.after` của `/api-key/create` đọc `returned.id`, `returned.referenceId` và thay response được).

- [ ] **Step 1: Spike (g)–(h)**

`test/integration/spike-sp3d/password-write.spike.spec.ts`:
```ts
import { defineRequestState } from '@better-auth/core/context';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestEnv } from '../../support/app-factory.js';
import { PASSWORD, spikeAuth } from './harness.js';

const subject = defineRequestState<string | null>(() => null);
type Seen = { hook: string; path: string | undefined; keys: string[]; subject: string | null };

describe('spike T7 (g)–(h): password-write and post-write hooks on Better Auth 1.7.6', () => {
  const seen: Seen[] = [];
  let refuse = false;
  let refuseAfter = false;
  let h: ReturnType<typeof spikeAuth>;
  beforeAll(() => {
    applyTestEnv();
    h = spikeAuth({
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (['/reset-password', '/change-password', '/admin/set-user-password'].includes(ctx.path)) await subject.set(`hook:${ctx.path}`);
        }),
        after: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== '/api-key/create') return;
          const r = ctx.context.returned as { id?: string; referenceId?: string } | undefined;
          seen.push({ hook: 'after:/api-key/create', path: ctx.path, keys: Object.keys(r ?? {}), subject: r?.referenceId ?? null });
          if (refuseAfter) return new Response(JSON.stringify({ code: 'refused' }), { status: 403 });
        }),
      },
      databaseHooks: {
        account: {
          update: {
            before: async (data, ctx) => {
              seen.push({ hook: 'account.update.before', path: ctx?.path, keys: Object.keys(data), subject: await subject.get() });
              if (refuse) throw APIError.from('BAD_REQUEST', { code: 'SPIKE_REFUSED', message: 'refused' });
            },
            after: async (_a, ctx) => { seen.push({ hook: 'account.update.after', path: ctx?.path, keys: [], subject: await subject.get() }); },
          },
          create: {
            before: async (data, ctx) => { seen.push({ hook: 'account.create.before', path: ctx?.path, keys: Object.keys(data), subject: await subject.get() }); },
            after: async (_a, ctx) => { seen.push({ hook: 'account.create.after', path: ctx?.path, keys: [], subject: await subject.get() }); },
          },
        },
        session: {
          create: {
            after: async (s, ctx) => {
              const visible = (await h.pool.query(`SELECT 1 FROM auth.session WHERE id = $1`, [s.id])).rowCount;
              const verify = ctx?.context.password?.verify;
              seen.push({ hook: 'session.create.after', path: ctx?.path, keys: [String(visible), typeof verify, ctx?.context.session ? 'has-session' : 'no-session', typeof (ctx?.body as { password?: unknown } | undefined)?.password], subject: null });
              if (refuseAfter) throw APIError.from('UNAUTHORIZED', { code: 'SPIKE_FENCED', message: 'fenced' });
            },
          },
        },
      },
    });
  });
  afterAll(async () => h.pool.end());

  it('(g) /reset-password: state set in hooks.before is read in account.update.before with path /reset-password and data = { password }; throwing there leaves the password', async () => {
    const u = await h.signedIn();
    await h.pool.query(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('reset-password:tok-g', $1, now() + interval '1 hour')`, [u.userId]);
    const hash = (await h.pool.query(`SELECT password FROM auth.account WHERE user_id = $1`, [u.userId])).rows;
    refuse = true;
    const r = await h.call('/reset-password', { body: { token: 'tok-g', newPassword: 'n'.repeat(12) } });
    refuse = false;
    expect(r.status).toBe(400);
    expect(seen.find((s) => s.hook === 'account.update.before')).toEqual({ hook: 'account.update.before', path: '/reset-password', keys: ['password'], subject: 'hook:/reset-password' });
    expect((await h.pool.query(`SELECT password FROM auth.account WHERE user_id = $1`, [u.userId])).rows).toEqual(hash);
  });
  it('(g) same for /change-password and /admin/set-user-password; /reset-password of a user without credential goes through account.create.before', async () => {
    seen.length = 0;
    const u = await h.signedIn('admin');
    refuse = true;
    await h.call('/change-password', { body: { currentPassword: PASSWORD, newPassword: 'c'.repeat(12) }, bearer: u.bearer });
    await h.call('/admin/set-user-password', { body: { userId: u.userId, newPassword: 's'.repeat(12) }, bearer: u.bearer });
    refuse = false;
    expect(seen.filter((s) => s.hook === 'account.update.before').map((s) => [s.path, s.keys, s.subject])).toEqual([
      ['/change-password', ['password'], 'hook:/change-password'],
      ['/admin/set-user-password', ['password'], 'hook:/admin/set-user-password'],
    ]);
    seen.length = 0;
    const v = await h.signedIn();
    await h.pool.query(`DELETE FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`, [v.userId]);
    await h.pool.query(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('reset-password:tok-c', $1, now() + interval '1 hour')`, [v.userId]);
    await h.call('/reset-password', { body: { token: 'tok-c', newPassword: 'n'.repeat(12) } });
    expect(seen.find((s) => s.hook === 'account.create.before')?.path).toBe('/reset-password');
    expect(seen.find((s) => s.hook === 'account.create.after')?.path).toBe('/reset-password');
  });
  it('(h) session.create.after runs after the INSERT is visible to another connection, sees path/body/password.verify, and a throw there means no Set-Cookie', async () => {
    seen.length = 0;
    const u = await h.signedIn();
    const ev = seen.find((s) => s.hook === 'session.create.after');
    expect(ev?.path).toBe('/sign-in/email');
    expect(ev?.keys).toEqual(['1', 'function', 'no-session', 'string']);
    refuseAfter = true;
    const r = await h.call('/sign-in/email', { body: { email: u.email, password: PASSWORD } });
    refuseAfter = false;
    expect(r.status).toBe(401);
    expect(r.headers.getSetCookie().filter((c) => c.includes('session_token'))).toEqual([]);
    expect(r.headers.get('set-auth-token')).toBeNull();
  });
  it('(h) account.update.after runs after the password write committed; hooks.after of /api-key/create reads id and referenceId and can replace the response', async () => {
    seen.length = 0;
    const u = await h.signedIn();
    await h.call('/change-password', { body: { currentPassword: PASSWORD, newPassword: 'z'.repeat(12) }, bearer: u.bearer });
    expect(seen.map((s) => s.hook)).toContain('account.update.after');
    seen.length = 0;
    const v = await h.signedIn();
    refuseAfter = true;
    const r = await h.call('/api-key/create', { body: { name: 'spike' }, bearer: v.bearer });
    refuseAfter = false;
    expect(r.status).toBe(403);
    const ev = seen.find((s) => s.hook === 'after:/api-key/create');
    expect(ev?.keys).toEqual(expect.arrayContaining(['id', 'referenceId', 'key']));
    expect(ev?.subject).toBe(v.userId);
  });
});
```

- [ ] **Step 2: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp3d/password-write.spike.spec.ts`
Expected: PASS 4/4. (g) không đạt → fallback spec §4: Task 8 bỏ lớp chặn trước câu ghi, giữ hook `before`, hàng rào sau ghi và bước kiểm sau commit của lệnh reset; ghi ADR. (h) không đạt ở **bất kỳ** điểm hook nào (`session.create.after`, `account.create.after`, `account.update.after`, `hooks.after` của `/api-key/create`) → **dừng 3D, báo Sếp** (T-42/T-43 mở lại ở đường đó; spec §4).

- [ ] **Step 3: Ghi ADR 0017** — điền dòng T7g, T7h của bảng Task 1:
```markdown
| T7g | <…>. Request state (`defineRequestState`) đặt ở hook `before` đọc được trong `databaseHooks.account.update.before`/`create.before` của cùng lời gọi, với `ctx.path` ∈ {`/reset-password`, `/change-password`, `/admin/set-user-password`} và `data` chỉ có `password`; ném `APIError` ở `update.before` thì câu `UPDATE` không chạy (hash giữ nguyên). `/reset-password` của user không có account `credential` đi qua `account.create.before`/`after`. | `password-write.spike.spec.ts` (g) |
| T7h | <…>. `session.create.after` chạy khi dòng session đã thấy được từ connection khác, nhận `ctx.path`, `ctx.body`, `ctx.context.password.verify`, `ctx.context.session`; ném `APIError` ở đó → không `Set-Cookie`/`set-auth-token`. `account.update.after` chạy sau câu ghi mật khẩu. `hooks.after` của `/api-key/create` đọc `returned.id`, `returned.referenceId` và trả `Response` thay kết quả. | (h) |
```

- [ ] **Step 4: Xoá code spike, commit ADR**

Run:
```bash
rm -rf test/integration/spike-sp3d
git status --short
```
Expected: chỉ `docs/adr/0017-tenancy-own-module.md` đổi.
```bash
git add docs/adr/0017-tenancy-own-module.md
git commit -m "docs(adr): record SP3 plan 3D spike T7 (g)-(h): password-write and post-write hooks"
```

---

## Phần B — Identity: dấu step-up, gate quyền nền tảng, luật mật khẩu, hàng rào, lệnh reset, `@PlatformStaffAction()` (spec §5.2 hàng "Plan = 3D", §9.7, addendum A1–A3, A5)

### Task 3: Migration `identity/…_session_second_factor` — bảng dấu step-up, `SESSION_SECOND_FACTOR_TABLE` trong `AUTH_TABLES`; catalog, chuẩn hoá

**Files:**
- Create: `src/migrations/identity/Migration<ts>_session_second_factor.ts`, `test/integration/identity/session-second-factor-schema.spec.ts`
- Modify: `src/modules/identity/infra/better-auth/auth-schema.ts`, `test/integration/core/database/normalization-inventory.spec.ts`, `test/integration/identity/auth-schema.spec.ts`

**Interfaces:**
- Consumes: `AUTH_TABLES`, `USER_RECLAIM_TABLE`, `SECURITY_NOTICE_TABLE` (SP2 `auth-schema.ts`); `createAuthPool`, `authDatabaseConfig`, `databaseConfig`, `applyTestEnv`, `getInfra`, `ownerQuery` (SP2).
- Produces: bảng `auth.session_second_factor (session_id uuid PK → auth.session(id) CASCADE, two_factor_id uuid NOT NULL → auth.two_factor(id) CASCADE, method text CHECK ∈ {totp, backup_code} (constraint `session_second_factor_method_ck`), verified_at, created_at, updated_at)`; index `session_second_factor_two_factor_idx (two_factor_id)`; grant `auth_user` `SELECT, INSERT, UPDATE, DELETE`; hằng `SESSION_SECOND_FACTOR_TABLE = 'session_second_factor'` trong `AUTH_TABLES`.

- [ ] **Step 1: Test schema (fail)**

`test/integration/identity/session-second-factor-schema.spec.ts`:
```ts
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { AUTH_TABLES, SESSION_SECOND_FACTOR_TABLE } from '../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

/** Spec SP3 §5.2 hàng migration + `auth-hooks.ts`, §6.12, §6.13 bảng 3D: dấu step-up thuộc hẳn session và factor. */
describe('auth.session_second_factor (spec SP3 §5.2, §9.7 (2))', () => {
  let pool: pg.Pool;
  const user = async () => {
    const [u] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at)
       VALUES ('Mark', $1, true, now(), now(), now()) RETURNING id`, [`mark-${randomUUID()}@example.test`]);
    const [s] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
      [randomUUID(), u!.id]);
    const [f] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('x', 'x', $1, true) RETURNING id`, [u!.id]);
    return { userId: u!.id, sessionId: s!.id, factorId: f!.id };
  };
  const marks = async (sessionId: string) =>
    (await pool.query(`SELECT method FROM auth.session_second_factor WHERE session_id = $1`, [sessionId])).rows;
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
  });
  afterAll(async () => pool?.end());

  it('is listed in AUTH_TABLES (the schema-auth allowlist of rls-catalog and auth-schema specs)', () => {
    expect(AUTH_TABLES).toContain(SESSION_SECOND_FACTOR_TABLE);
    expect(SESSION_SECOND_FACTOR_TABLE).toBe('session_second_factor');
  });
  it('auth_user writes a mark; method is a closed set; one row per session (upsert target)', async () => {
    const a = await user();
    await pool.query(`INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'totp', now())`, [a.sessionId, a.factorId]);
    await expect(pool.query(`INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'totp', now())`, [a.sessionId, a.factorId]))
      .rejects.toMatchObject({ code: '23505' });
    const b = await user();
    await expect(pool.query(`INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'sms', now())`, [b.sessionId, b.factorId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'session_second_factor_method_ck' });
  });
  it('deleting the factor or the session removes the mark in the same statement (FK CASCADE, T-35)', async () => {
    const a = await user();
    await pool.query(`INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'backup_code', now())`, [a.sessionId, a.factorId]);
    await pool.query(`DELETE FROM auth.two_factor WHERE id = $1`, [a.factorId]);
    expect(await marks(a.sessionId)).toEqual([]);
    const b = await user();
    await pool.query(`INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, 'totp', now())`, [b.sessionId, b.factorId]);
    await pool.query(`DELETE FROM auth.session WHERE id = $1`, [b.sessionId]);
    expect(await marks(b.sessionId)).toEqual([]);
  });
  it('the two_factor_id index serves the CASCADE delete', async () => {
    const rows = await ownerQuery<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'auth' AND indexname = 'session_second_factor_two_factor_idx'`);
    expect(rows[0]?.indexdef).toContain('(two_factor_id)');
  });
});
```

Run: `pnpm vitest run --project integration test/integration/identity/session-second-factor-schema.spec.ts`
Expected: FAIL (`SESSION_SECOND_FACTOR_TABLE` không export; bảng không tồn tại).

- [ ] **Step 2: Migration bằng CLI**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/identity --name session_second_factor`
Expected: file `src/migrations/identity/Migration<ts>_session_second_factor.ts`, timestamp lớn hơn mọi migration trên `main`.

Thay nội dung lớp (giữ tên lớp và `name` do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3D (spec SP3 §5.2 hàng migration + `auth-hooks.ts`, §9.7 (2), §6.13 bảng 3D): dấu step-up 2FA TRONG session.
 * Một dòng = "session này vừa chứng minh factor hiện tại" (verify-totp / verify-backup-code gửi khi đã có session).
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | auth.session_second_factor | {session_id} | — | BCNF |
 * `verified_at` là lần step-up gần nhất, `method` là phương thức của CHÍNH lần đó (ghi cùng câu upsert), `created_at` là
 * lần đầu. Ràng buộc liên bảng "factor thuộc user của session" do câu ghi duy nhất bảo đảm (join `tf.user_id =
 * s.user_id`) và mọi câu đọc đều join qua user của session.
 *
 * FK: cả hai `ON DELETE CASCADE` (dòng thuộc hẳn session và factor): thu hồi session, gỡ/thay factor (disable, lệnh reset)
 * xoá dấu trong cùng câu lệnh (T-35); kiểm FK giữ `FOR KEY SHARE` trên dòng factor nên câu ghi dấu và câu xoá factor tự
 * tuần tự hoá (T-37). Không trigger, không hàm.
 *
 * Index (mỗi cái một query): PK `session_id` → mọi câu đọc dấu (theo session) và upsert; `session_second_factor_two_factor_idx`
 * → câu `DELETE … WHERE two_factor_id = $1` của hành động CASCADE khi xoá factor.
 *
 * Khoá (giữ tới hết lô 3D, `allOrNothing`): `SHARE ROW EXCLUSIVE` trên `auth.session` và `auth.two_factor` (REFERENCES):
 * đăng nhập (tạo session) và bật/tắt 2FA chờ tới hết lô — chạy trong cửa sổ ít ghi (runbook, spec §6.13).
 */
export class Migration<ts>_session_second_factor extends Migration {
  override name = 'Migration<ts>_session_second_factor';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE auth.session_second_factor (
    session_id uuid PRIMARY KEY REFERENCES auth.session (id) ON DELETE CASCADE,
    two_factor_id uuid NOT NULL REFERENCES auth.two_factor (id) ON DELETE CASCADE,
    method text NOT NULL CONSTRAINT session_second_factor_method_ck CHECK (method IN ('totp', 'backup_code')),
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());`);
    this.addSql(
      `CREATE INDEX session_second_factor_two_factor_idx ON auth.session_second_factor (two_factor_id);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON auth.session_second_factor TO auth_user;`,
    );
  }

  override down(): void | Promise<void> {
    // Dấu là trạng thái ngắn hạn (nhân viên step-up lại); DROP TABLE xoá index, FK, CHECK và grant.
    this.addSql(`DROP TABLE auth.session_second_factor;`);
  }
}
```

- [ ] **Step 3: `AUTH_TABLES`**

`src/modules/identity/infra/better-auth/auth-schema.ts` — sau `SECURITY_NOTICE_TABLE`:
```ts
/** Spec SP3 §5.2 (3D): dấu step-up 2FA trong session (`Migration…_session_second_factor`, `staff-step-up.ts`). */
export const SESSION_SECOND_FACTOR_TABLE = 'session_second_factor';
```
và thêm `SESSION_SECOND_FACTOR_TABLE` vào cuối mảng `AUTH_TABLES`. Bảng có đủ `SELECT/INSERT/UPDATE/DELETE` cho `auth_user`, nên test "library-shaped" của `auth-schema.spec.ts` (`auth_user has exactly SELECT/INSERT/UPDATE/DELETE on each library-shaped auth table`) áp nguyên cho nó (R5-C2); test "ids default to uuidv7()" chỉ xét cột tên `id`, bảng này không có.

- [ ] **Step 4: Inventory chuẩn hoá**

`test/integration/core/database/normalization-inventory.spec.ts` — thêm vào `ANALYSED_COLUMNS` ngay sau `'auth.security_notice'`:
```ts
  'auth.session_second_factor': [
    'session_id',
    'two_factor_id',
    'method',
    'verified_at',
    'created_at',
    'updated_at',
  ],
```

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm build
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/identity/session-second-factor-schema.spec.ts test/integration/identity/auth-schema.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/core/database/migrations.spec.ts
```
Expected: PASS. `rls-catalog.spec.ts` "schema auth holds only the Better Auth allowlist" xanh nhờ `AUTH_TABLES`; `auth_user holds no privilege … in public` không đổi; `migrations.spec.ts` up → down → up và sweep S2-R57 gồm migration mới; `migration-order.spec.ts` xanh.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/migrations/identity src/modules/identity/infra/better-auth/auth-schema.ts test/integration/identity/session-second-factor-schema.spec.ts test/integration/core/database/normalization-inventory.spec.ts
pnpm typecheck && pnpm lint
git add src/migrations/identity src/modules/identity/infra/better-auth/auth-schema.ts test/integration/identity/session-second-factor-schema.spec.ts test/integration/core/database/normalization-inventory.spec.ts
git commit -m "feat(identity): auth.session_second_factor step-up marks with CASCADE to session and factor"
```

---

### Task 4: Credential `ORG_API_KEY`, `sessionId` nội bộ của `AUTHENTICATED`, `@SessionOnly` từ chối org key, mã lỗi mới; `hasAdminRole` bỏ `trim` (N7-2)

**Files:**
- Modify: `src/core/context/principal.ts`, `src/modules/identity/http/credential-detector.ts`, `src/modules/identity/ports/auth-provider.ts`, `src/modules/identity/infra/better-auth/better-auth.provider.ts`, `src/modules/identity/infra/jwks/jwks.provider.ts`, `src/modules/identity/http/auth.guard.ts`, `src/modules/identity/errors.ts`, `src/modules/identity/ports/identity-directory.ts`, `src/modules/identity/index.ts`, `test/unit/modules/identity/admin-plugin-config.spec.ts`, `test/unit/modules/identity/auth-guard-proof.spec.ts`, `test/unit/modules/identity/principal-resolver.spec.ts`, `test/integration/identity/better-auth-provider.spec.ts`, `test/integration/identity/jwks-provider.spec.ts`
- Create: `test/integration/identity/admin-role-equivalence.spec.ts`

**Interfaces:**
- Consumes: `AuthGuard`, `AuthResult`, metadata `SESSION_ONLY`, `IdentityErrors`, `defineErrorCodes` (SP2/3A); `BETTER_AUTH`, `ADMIN_ROLE`, `DEFAULT_ROLE` (SP2); `startIdentityApp` (SP2 test support).
- Produces:
  - `CREDENTIAL_KINDS` gồm `'ORG_API_KEY'`; `Credential = { kind; id?: string; orgId?: string }` (`orgId` chỉ có với `ORG_API_KEY`).
  - `DetectedCredentialKind = Exclude<CredentialKind, 'ORG_API_KEY'>`; `DetectedCredential.kind: DetectedCredentialKind` (ba `switch` vét cạn trên credential đã phát hiện không phải sửa).
  - `AuthResult` nhánh `AUTHENTICATED` thêm `sessionId: string | undefined` (id `auth.session` của credential session Better Auth; `undefined` với mọi credential khác). Chỉ identity đọc (`AuthFacts`, `PlatformStaffGuard`, `PlatformAdminAuthorizer`); tenancy chỉ điền `undefined` ở authenticator của nó.
  - `IdentityErrors.SECOND_FACTOR_REQUIRED` (403 `second_factor_required`), `IdentityErrors.LAST_PLATFORM_ADMIN` (409 `last_platform_admin`), `IdentityErrors.API_KEY_NOT_ALLOWED_HERE` (403 `api_key_not_allowed_here`, identity sở hữu — lý do ở "File Structure").
  - `AuthGuard`: credential `ORG_API_KEY` trên route `@SessionOnly()` → `403 api_key_not_allowed_here`; `API_KEY` giữ `403 forbidden`; API key (hai loại) không bao giờ "mới".
  - `hasAdminRole(role) = (role ?? '').split(',').includes('admin')` (không `trim`); `isBanned` export ở `modules/identity/index.ts` (tenancy dùng ở authenticator, Task 20).

- [ ] **Step 1: Test (fail)**

`test/unit/modules/identity/admin-plugin-config.spec.ts` — thay mảng của `it.each` bằng bảng của spec §5.2 hàng `identity-directory.ts` (r8), và thêm hai ca `''`/`null` tường minh:
```ts
  it.each([
    'admin',
    'user',
    'user,admin',
    'admin,user',
    'user, admin',
    ' admin',
    'admin ',
    'Admin',
    'administrator',
    'admin,',
    ',admin',
  ])(
    'role %j: hasAdminRole grants exactly when the default plugin roles grant user:delete',
    (role) => {
      const pluginGrants = role
        .split(',')
        .some((r) => DEFAULT_ROLES.get(r)?.authorize({ user: ['delete'] }).success === true);
      expect(hasAdminRole(role)).toBe(pluginGrants);
    },
  );
  it("'' and null fall back to the default role 'user' in the plugin: never admin", () => {
    expect(hasAdminRole('')).toBe(false);
    expect(hasAdminRole(null)).toBe(false);
  });
```
(`' admin'`, `'user, admin'`, `'admin '` đỏ với bản có `trim`: đó là lỗi N7-2.)

`test/integration/identity/admin-role-equivalence.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasAdminRole } from '../../../src/modules/identity/ports/identity-directory.js';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { ADMIN_ROLE, DEFAULT_ROLE } from '../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { startIdentityApp } from '../../support/identity-app.js';

const NON_EMPTY_ROLES = ['admin', 'user', 'user,admin', 'admin,user', 'user, admin', ' admin', 'admin ', 'Admin', 'administrator', 'admin,', ',admin'];

/**
 * Spec SP3 §5.2 hàng `identity-directory.ts` (r8, R8-S3 ≡ R8-C4): "nhân viên" của gate, luật (8), `--for-promotion` và
 * `isPlatformAdmin` phải là "admin" của plugin (người dùng được `/admin/*`). (1) assert cấu hình trên CHÍNH instance
 * runtime; (2) tương đương với `auth.api.userHasPermission` trên role khác rỗng; (3) `''`/`null` ở unit test.
 */
describe('hasAdminRole equals the admin plugin on the runtime instance', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  beforeAll(async () => {
    app = await startIdentityApp();
    auth = app.get<AuthInstance>(BETTER_AUTH);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('the admin plugin options on the runtime instance: no roles, no adminUserIds, adminRoles = [admin], defaultRole = user', () => {
    const admin = auth.options.plugins.find((p) => p.id === 'admin');
    const options: unknown = admin && 'options' in admin ? admin.options : undefined;
    // Thông điệp khi đỏ: vị từ nhân viên (`hasAdminRole`, câu "còn admin khác") phải đổi theo cấu hình plugin admin.
    expect(options, 'the staff predicate (hasAdminRole, "another admin" query) must follow the admin plugin config').toEqual({
      adminRoles: [ADMIN_ROLE],
      defaultRole: DEFAULT_ROLE,
    });
  });
  it.each(NON_EMPTY_ROLES)('role %j: hasAdminRole equals userHasPermission(user:set-role)', async (role) => {
    const r = await auth.api.userHasPermission({ body: { role, permissions: { user: ['set-role'] } } });
    expect(hasAdminRole(role)).toBe(r.success);
  });
});
```

`test/unit/modules/identity/auth-guard-proof.spec.ts` — fixture `authed(...)` của file thêm `sessionId: undefined`; lớp `Probe` thêm một handler (import `SessionOnly` từ `src/modules/identity/http/session-only.decorator.js`):
```ts
  @SessionOnly()
  @Get('session-only')
  sessionOnly(this: void) {
    return 1;
  }
```
và thêm hai ca (dùng `run`, `authed` có sẵn của file):
```ts
  it('an org API key on a @SessionOnly() route is 403 api_key_not_allowed_here; a Better Auth key stays 403 forbidden', () => {
    const orgKey = authed({ principal: { type: 'api_key', id: 'k' }, credential: { kind: 'ORG_API_KEY', id: 'k', orgId: 'o' }, emailVerified: false, verifiedEmail: undefined });
    expect(() => run(orgKey, Probe.prototype.sessionOnly)).toThrow(
      expect.objectContaining({ error: IdentityErrors.API_KEY_NOT_ALLOWED_HERE }),
    );
    const userKey = authed({ credential: { kind: 'API_KEY', id: 'k' }, authenticatedAt: undefined });
    expect(() => run(userKey, Probe.prototype.sessionOnly)).toThrow(
      expect.objectContaining({ error: CoreErrors.FORBIDDEN }),
    );
  });
  it('an org API key is never fresh, whatever authenticatedAt a port attached', () => {
    const orgKey = authed({ principal: { type: 'api_key', id: 'k' }, credential: { kind: 'ORG_API_KEY', id: 'k', orgId: 'o' }, authenticatedAt: NOW });
    expect(() => run(orgKey, Probe.prototype.fresh)).toThrow(
      expect.objectContaining({ error: IdentityErrors.REAUTHENTICATION_REQUIRED }),
    );
  });
```

Run: `pnpm vitest run --project unit test/unit/modules/identity/admin-plugin-config.spec.ts test/unit/modules/identity/auth-guard-proof.spec.ts` và `pnpm vitest run --project integration test/integration/identity/admin-role-equivalence.spec.ts`
Expected: FAIL (`' admin'` được coi là admin; `'ORG_API_KEY'` không thuộc `CredentialKind`; `API_KEY_NOT_ALLOWED_HERE` không tồn tại). Ca `userHasPermission` của `' admin'` đỏ ở bản `trim`.

- [ ] **Step 2: Core + detector**

`src/core/context/principal.ts`:
```ts
export const CREDENTIAL_KINDS = [
  'SESSION_COOKIE',
  'BEARER_SESSION',
  'API_KEY',
  'EXTERNAL_COOKIE',
  'EXTERNAL_BEARER',
  /** Spec SP3 §5.2 (3D): org API key `oak_…`, principal `{ type: 'api_key' }`, gắn cứng một org. */
  'ORG_API_KEY',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** `id` chỉ có với API key (id của key, không phải bí mật); `orgId` chỉ có với `ORG_API_KEY`. */
export type Credential = { kind: CredentialKind; id?: string; orgId?: string };
```

`src/modules/identity/http/credential-detector.ts`:
```ts
/**
 * Kind mà detector có thể trả (spec SP3 §5.2): header API key luôn là `API_KEY`; việc tách `oak_` làm ở `PrincipalResolver`.
 * Kiểu hẹp làm `ORG_API_KEY` không bao giờ tới ba `switch` vét cạn trên credential đã phát hiện (provider Better Auth,
 * sign-out, JWKS), compiler chứng minh.
 */
export type DetectedCredentialKind = Exclude<CredentialKind, 'ORG_API_KEY'>;
export type DetectedCredential = {
  kind: DetectedCredentialKind;
  value: string;
  cookieName?: string;
};
```
`src/modules/identity/http/origin-check.ts` — `isCookieCredential(kind: CredentialKind)` giữ kiểu rộng (không đổi).

- [ ] **Step 3: `AuthResult.sessionId` và hai provider**

`src/modules/identity/ports/auth-provider.ts` — trong nhánh `AUTHENTICATED`, sau `verifiedEmail`:
```ts
      /**
       * Spec SP3 §5.2 (3D): id `auth.session` của credential session Better Auth (`SESSION_COOKIE`/`BEARER_SESSION`),
       * đọc từ chính lời gọi `getSession` của provider (không query thêm); `undefined` với API key, org key và `external`.
       * NỘI BỘ identity: `AuthFacts` không trả nó; chỉ câu dấu step-up (`staff-step-up.ts`) dùng.
       */
      sessionId: string | undefined;
```
`better-auth.provider.ts` — nhánh session trả thêm `sessionId: s.session.id`; nhánh `apiKey` trả `sessionId: undefined`.
`infra/jwks/jwks.provider.ts` — mọi `AUTHENTICATED` trả thêm `sessionId: undefined`.
Rồi sửa mọi fixture:
```bash
grep -rln "kind: 'AUTHENTICATED'" src test
```
Expected: `auth-facts.ts`, `auth.guard.ts` (chỉ đọc, không dựng), `better-auth.provider.ts`, `jwks.provider.ts`, `auth-provider.ts`, và bốn file test (`better-auth-provider.spec.ts`, `jwks-provider.spec.ts`, `auth-guard-proof.spec.ts`, `principal-resolver.spec.ts`). Mỗi object `AUTHENTICATED` dựng tay trong test thêm `sessionId: undefined` (hoặc id session thật ở ca session của `better-auth-provider.spec.ts`, khẳng định `sessionId` bằng `id` của dòng `auth.session` vừa seed).

- [ ] **Step 4: `AuthGuard` và mã lỗi**

`src/modules/identity/errors.ts` — thêm vào `defineErrorCodes`:
```ts
  /**
   * Spec SP3 §9.7, §15 (3D): session của nhân viên thiếu dấu step-up hợp lệ (gate quyền nền tảng: dấu TOTP tươi; support
   * grant: dấu TOTP hoặc backup code không cũ hơn `TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC`); nhân viên chưa có factor đổi
   * mật khẩu / tạo credential mới. Identity sở hữu; tenancy dùng lại ở nhánh support grant.
   */
  SECOND_FACTOR_REQUIRED: {
    status: HttpStatus.FORBIDDEN,
    title: 'A recent two-factor step-up in this session is required',
  },
  /** Spec SP3 §9.7 (8) (3D, r6 N6-5): admin nền tảng cuối cùng chưa bị ban bỏ role admin của chính mình. */
  LAST_PLATFORM_ADMIN: {
    status: HttpStatus.CONFLICT,
    title: 'The last platform admin cannot drop their own admin role',
  },
  /**
   * Spec SP3 §15 (3D): org API key trên route không cho nó. Identity sở hữu (lệch có chủ đích với cột "Chủ" của spec):
   * `AuthGuard` (nhánh `@SessionOnly`) và `OrgApiKeyConfinementGuard` của tenancy đều từ chối và thứ tự APP_GUARD giữa
   * module không được bảo đảm, nên hai guard phải trả CÙNG một mã.
   */
  API_KEY_NOT_ALLOWED_HERE: {
    status: HttpStatus.FORBIDDEN,
    title: 'This API key cannot be used on this route',
  },
```

`src/modules/identity/http/auth.guard.ts`:
```ts
  private isFresh(r: Extract<AuthResult, { kind: 'AUTHENTICATED' }>): boolean {
    if (
      r.credential.kind === 'API_KEY' ||
      r.credential.kind === 'ORG_API_KEY' ||
      r.authenticatedAt === undefined
    )
      return false;
    …phần còn lại giữ nguyên…
  }
```
và trong `canActivate`, nhánh `AUTHENTICATED`, thay khối `@SessionOnly` bằng:
```ts
        if (!isPublic && flag(SESSION_ONLY)) {
          // Spec SP3 §5.2 (3D, PR8, B-17): thao tác chỉ-session không bao giờ chạy bằng key.
          if (r.credential.kind === 'ORG_API_KEY')
            throw new AppError(IdentityErrors.API_KEY_NOT_ALLOWED_HERE);
          if (r.credential.kind === 'API_KEY')
            throw new AppError(CoreErrors.FORBIDDEN, {
              detail: 'This operation requires a signed-in session',
            });
        }
```

- [ ] **Step 5: `hasAdminRole` và export**

`src/modules/identity/ports/identity-directory.ts`:
```ts
/**
 * "Admin" của plugin `admin` Better Auth 1.7.6 (`plugins/admin/has-permission.mjs`: tách theo `,`, KHÔNG trim, so khớp
 * đúng phần tử, phân biệt hoa thường; `null`/`''` rơi về `defaultRole = 'user'`) với cấu hình của SP2 (`adminRoles:
 * ['admin']`, không `roles`, không `adminUserIds`). Spec SP3 §5.2 (r7 N7-2): bỏ `trim` — `trim` làm vị từ rộng hơn plugin
 * (role `user, admin` được coi là admin mà không dùng được `/admin/*`). Dùng ở `isPlatformAdmin`, `/v1/me`, gate nhân viên,
 * luật (8), `--for-promotion`, điều kiện grantee. Test tương đương: `admin-role-equivalence.spec.ts`.
 */
export const hasAdminRole = (role: string | null | undefined): boolean =>
  (role ?? '').split(',').includes('admin');
```
`src/modules/identity/index.ts` — sửa dòng export `IdentityDirectory` thành:
```ts
export {
  IdentityDirectory,
  isBanned,
  type DirectoryUser,
} from './ports/identity-directory.js';
```

- [ ] **Step 6: `/v1/me` theo vị từ mới**

`test/e2e/identity/me-admin-role.e2e.spec.ts` (mới):
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startIdentityApp } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';

/** Spec SP3 §5.2 hàng `identity-directory.ts` (N7-2): `/v1/me` dùng `hasAdminRole` như plugin, không `trim`. */
describe('GET /v1/me role follows the admin plugin predicate', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });
  it.each([
    ['admin', 'ADMIN'],
    ['user,admin', 'ADMIN'],
    ['user, admin', 'USER'],
    [' admin', 'USER'],
    ['Admin', 'USER'],
  ])('role %j → %s', async (role, expected) => {
    const p = await seedUserPrincipal({ role });
    principals.push(p);
    const r = await request(app.getHttpServer()).get('/v1/me').set('authorization', `Bearer ${p.bearer}`);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe(expected);
  });
});
```

- [ ] **Step 7: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/identity
pnpm vitest run --project integration test/integration/identity/admin-role-equivalence.spec.ts test/integration/identity/better-auth-provider.spec.ts test/integration/identity/jwks-provider.spec.ts
pnpm vitest run --project integration test/e2e/identity/me-admin-role.e2e.spec.ts test/e2e/identity/principal-guard.e2e.spec.ts test/e2e/identity/user-deletion-precheck.e2e.spec.ts
```
Expected: PASS. `typecheck` xanh chứng minh ba `switch` trên `DetectedCredential.kind` không cần sửa (spec §5.2 hàng `credential-detector.ts`). `directory-ledger.spec.ts:76-78` vẫn xanh.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write src/core/context/principal.ts src/modules/identity test/unit/modules/identity test/integration/identity test/e2e/identity/me-admin-role.e2e.spec.ts
pnpm lint
git add src/core/context/principal.ts src/modules/identity test/unit/modules/identity test/integration/identity test/e2e/identity/me-admin-role.e2e.spec.ts
git commit -m "feat(identity): ORG_API_KEY credential kind, internal sessionId, SessionOnly refuses org keys; hasAdminRole matches the admin plugin (no trim)"
```

---

### Task 5: `staff-step-up.ts` — câu dấu, "factor hiện tại", "nhân viên chưa có factor" khoá đọc, "còn admin khác", ghi dấu, `revokeUserCredentials`; `LoginLockout` scope `step-up` + `lockoutRowKeys`

**Files:**
- Create: `src/modules/identity/infra/better-auth/staff-step-up.ts`, `test/unit/modules/identity/lockout-row-keys.spec.ts`, `test/integration/identity/staff-step-up.spec.ts`
- Modify: `src/modules/identity/infra/better-auth/login-lockout.ts`, `src/modules/identity/infra/better-auth/better-auth-core.module.ts`, `test/integration/identity/login-lockout.spec.ts`

**Interfaces:**
- Consumes: `AUTH_POOL`, `LoginLockout`, `LockoutScope`, `emailHash` (SP2), `hasAdminRole` (Task 4), bảng dấu (Task 3), `ownerQuery`, `createAuthPool`.
- Produces (tên là hợp đồng cho Task 6–12, 21):
  - `type StepUpMethod = 'totp' | 'backup_code'`; `STEP_UP_METHOD_BY_PATH: Readonly<Record<string, StepUpMethod>>` (`/two-factor/verify-totp` → `totp`, `/two-factor/verify-backup-code` → `backup_code`); `STEP_UP_PATHS: ReadonlySet<string>`; `STAFF_RESET_TX_ATTEMPTS = 3`.
  - `type StepUpMark = { sessionId: string; factorId: string; method: StepUpMethod }`; `type StaffFactorState = { exists: boolean; role: string | null; factorId: string | null }`; `staffLacksFactorOf(s: StaffFactorState): boolean`; `type Sql = { query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> }`.
  - `class StaffStepUp` (provider trong `BetterAuthCoreModule`, export; api + worker, chỉ `local`/`hybrid`):
    - `totpMarkFresh(userId: string, sessionId: string, maxAgeSec: number): Promise<boolean>` — câu dấu TOTP (spec §5.2), độ mới so bằng `now()` của DB.
    - `anyMarkVerifiedAt(sessionId: string, userId: string): Promise<Date | undefined>` — dấu mọi `method` trên factor hiện tại (câu của `AuthFacts.secondFactorVerifiedAt()`); 0 dòng → `undefined`.
    - `currentFactorId(userId: string): Promise<string | undefined>` — câu chụp `factorId` của luật (1).
    - `factorState(userId: string, q?: Sql): Promise<StaffFactorState>` — câu "nhân viên chưa có factor" `FOR SHARE OF u` (chờ transaction đang giữ dòng user).
    - `staffLacksFactor(userId: string, q?: Sql): Promise<boolean>`.
    - `otherAdminExists(userId: string): Promise<boolean>` — vị từ của plugin (không `btrim`), bỏ admin đang bị ban.
    - `writeMark(m: StepUpMark): Promise<'MARKED' | 'SKIPPED'>` — upsert `INSERT … SELECT … ON CONFLICT (session_id)`; 0 dòng, `23503`, `40P01` → `SKIPPED`; lỗi khác ném.
  - `revokeUserCredentials(client: Sql, userId: string, opts: { apiKeys: boolean }): Promise<{ apiKeysDeleted: number }>` — năm câu xoá của spec §9.7 (5) bước 2, đúng thứ tự (factor → thiết bị tin cậy + token đặt lại → liên kết IdP → [API key] → session).
  - `login-lockout.ts`: `LockoutScope = { kind: 'signin'; email: string } | { kind: 'step-up'; userId: string }`; `accountKey(scope): string` (hàm thuần cấp module, `never`); `lockoutRowKeys(scope): { exact: string[]; prefixes: string[] }`.

- [ ] **Step 1: Unit `lockoutRowKeys` (fail)**

`test/unit/modules/identity/lockout-row-keys.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emailHash } from '../../../../src/modules/identity/infra/better-auth/email-normalize.js';
import { accountKey, lockoutRowKeys } from '../../../../src/modules/identity/infra/better-auth/login-lockout.js';

describe('lockout row keys (spec SP3 §5.2 hàng auth-hooks.ts (1), r6 N6-2)', () => {
  it('accountKey: signin hashes the email, step-up keys by user id', () => {
    expect(accountKey({ kind: 'signin', email: 'a@example.test' })).toBe(`signin:${emailHash('a@example.test')}`);
    expect(accountKey({ kind: 'step-up', userId: '0190e1c8-0000-7000-8000-000000000001' })).toBe('step-up:0190e1c8-0000-7000-8000-000000000001');
  });
  it('rows: the block row exactly, attempts and tickets of every window by prefix', () => {
    const scope = { kind: 'step-up', userId: 'u' } as const;
    expect(lockoutRowKeys(scope)).toEqual({ exact: ['blocks:step-up:u'], prefixes: ['attempts:step-up:u:', 'tickets:step-up:u:'] });
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/identity/lockout-row-keys.spec.ts`
Expected: FAIL (`accountKey`, `lockoutRowKeys` không export).

- [ ] **Step 2: `login-lockout.ts`**

Thay kiểu `LockoutScope` và phương thức `accountKey`:
```ts
export type LockoutScope =
  /** Đăng nhập mật khẩu (SP2). Khoá 2FA lúc đăng nhập là `accountLockout` có sẵn của plugin `twoFactor` (S2-R6). */
  | { kind: 'signin'; email: string }
  /** Spec SP3 §9.7 (1) (3D, r5 N5-2): step-up 2FA trong session của nhân viên; consume trước verify, không refund. */
  | { kind: 'step-up'; userId: string };

/**
 * Thuần, đồng bộ, không I/O (spec SP3 §5.2, r6 N6-2): dùng chung cho `guard()` và `lockoutRowKeys()` để lệnh reset xoá
 * đúng dòng mà không chép tiền tố. Kind lạ là lỗi lập trình (500), không bao giờ 503.
 */
export function accountKey(scope: LockoutScope): string {
  switch (scope.kind) {
    case 'signin':
      return `signin:${emailHash(scope.email)}`;
    case 'step-up':
      return `step-up:${scope.userId}`;
    default: {
      const unknown: never = scope;
      throw new Error(`Unknown lockout scope kind: ${JSON.stringify(unknown)}`);
    }
  }
}
/** `getKey` của rate-limiter-flexible 11.2.1 (`RateLimiterAbstract.js:106-108`): `<keyPrefix>:<key>`. S-22 khoá định dạng này với `guard()` thật. */
const rowKey = (prefix: string, key: string): string => `${prefix}:${key}`;
/** Khoá dòng vé: dùng chung cho `issueTicket`/`refund` và `lockoutRowKeys`. */
const ticketRowKey = (attemptKeyWithTicket: string): string => rowKey(TICKETS_PREFIX, attemptKeyWithTicket);
/** Mọi dòng `auth.login_attempts` của một scope (spec §9.7 (5) bước 2: lệnh reset xoá bộ đếm `step-up` và `signin`). */
export function lockoutRowKeys(scope: LockoutScope): { exact: string[]; prefixes: string[] } {
  const a = accountKey(scope);
  return {
    exact: [rowKey(BLOCKS_PREFIX, a)],
    prefixes: [rowKey(ATTEMPTS_PREFIX, `${a}:`), ticketRowKey(`${a}:`)],
  };
}
```
Trong lớp `LoginLockout`: xoá phương thức riêng `accountKey`, `consume` gọi `accountKey(scope)` cấp module; `issueTicket` và `refund` dùng `ticketRowKey(ticket.attemptKey)` thay cho `` `${TICKETS_PREFIX}:${ticket.attemptKey}` ``. `refund` giữ `TICKET_PATTERN` chỉ nhận vé `signin:` (step-up không bao giờ refund, spec §9.7 (1): "mọi lần thử đều đếm").

- [ ] **Step 3: Integration `StaffStepUp` + `lockoutRowKeys` với `guard()` thật (fail)**

`test/integration/identity/staff-step-up.spec.ts`:
```ts
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { LoginLockout, LockoutBlockedError, lockoutRowKeys } from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import { StaffStepUp, revokeUserCredentials, staffLacksFactorOf } from '../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

const RACE_ROUNDS = 50;
type Staff = { userId: string; sessionId: string; factorId: string | null };

describe('StaffStepUp against the real auth schema (spec SP3 §5.2, §9.7)', () => {
  let pool: pg.Pool;
  let s: StaffStepUp;
  const staff = async (o: { role?: string | null; factor?: 'verified' | 'pending' | 'none'; flag?: boolean; banned?: boolean } = {}): Promise<Staff> => {
    const factor = o.factor ?? 'verified';
    const [u] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, role, two_factor_enabled, banned, created_at, updated_at, registered_event_emitted_at)
       VALUES ('Staff', $1, true, $2, $3, $4, now(), now(), now()) RETURNING id`,
      [`staff-${randomUUID()}@example.test`, o.role === undefined ? 'admin' : o.role, o.flag ?? factor === 'verified', o.banned ?? false]);
    const [sess] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`, [randomUUID(), u!.id]);
    const f = factor === 'none' ? [] : await ownerQuery<{ id: string }>(
      `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('x', 'x', $1, $2) RETURNING id`, [u!.id, factor === 'verified']);
    return { userId: u!.id, sessionId: sess!.id, factorId: f[0]?.id ?? null };
  };
  const mark = (x: Staff, method: 'totp' | 'backup_code', ageSec = 0) =>
    ownerQuery(`INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at) VALUES ($1, $2, $3, now() - make_interval(secs => $4))`,
      [x.sessionId, x.factorId, method, ageSec]);
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    s = new StaffStepUp(pool);
  });
  afterAll(async () => pool?.end());

  it('TOTP mark: only a fresh totp mark on the current verified factor with the flag on counts', async () => {
    const a = await staff();
    expect(await s.totpMarkFresh(a.userId, a.sessionId, 600)).toBe(false);
    await mark(a, 'totp');
    expect(await s.totpMarkFresh(a.userId, a.sessionId, 600)).toBe(true);
    const b = await staff();
    await mark(b, 'backup_code');
    expect(await s.totpMarkFresh(b.userId, b.sessionId, 600)).toBe(false);
    const c = await staff();
    await mark(c, 'totp', 700);
    expect(await s.totpMarkFresh(c.userId, c.sessionId, 600)).toBe(false);
    const d = await staff();
    await mark(d, 'totp');
    await ownerQuery(`UPDATE auth."user" SET two_factor_enabled = false WHERE id = $1`, [d.userId]);
    expect(await s.totpMarkFresh(d.userId, d.sessionId, 600)).toBe(false);
  });
  it('R4A-N3: a session deleted after the read has no mark; there is no "0 rows = allow" branch', async () => {
    const a = await staff();
    await mark(a, 'totp');
    await ownerQuery(`DELETE FROM auth.session WHERE id = $1`, [a.sessionId]);
    expect(await s.totpMarkFresh(a.userId, a.sessionId, 600)).toBe(false);
    expect(await s.anyMarkVerifiedAt(a.sessionId, a.userId)).toBeUndefined();
  });
  it('anyMarkVerifiedAt accepts totp and backup_code marks, and only for the session owner', async () => {
    const a = await staff();
    await mark(a, 'backup_code');
    expect(await s.anyMarkVerifiedAt(a.sessionId, a.userId)).toBeInstanceOf(Date);
    const other = await staff();
    expect(await s.anyMarkVerifiedAt(a.sessionId, other.userId)).toBeUndefined();
  });
  it('factorState: staff without a factor (none, pending, flag off) lacks it; FOR SHARE waits for a transaction holding the user row', async () => {
    for (const o of [{ factor: 'none' as const }, { factor: 'pending' as const, flag: false }, { factor: 'verified' as const, flag: false }])
      expect(staffLacksFactorOf(await s.factorState((await staff(o)).userId))).toBe(true);
    expect(staffLacksFactorOf(await s.factorState((await staff()).userId))).toBe(false);
    expect(staffLacksFactorOf(await s.factorState((await staff({ role: 'user', factor: 'none' })).userId))).toBe(false);
    expect((await s.factorState(randomUUID())).exists).toBe(false);
    const a = await staff({ factor: 'none' });
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`, [a.userId]);
      await holder.query(`INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('y', 'y', $1, true)`, [a.userId]);
      await holder.query(`UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`, [a.userId]);
      const waiting = s.factorState(a.userId);
      await new Promise((r) => setTimeout(r, 200));
      await holder.query('COMMIT');
      expect(staffLacksFactorOf(await waiting)).toBe(false);
    } finally {
      holder.release();
    }
  });
  it('otherAdminExists follows the plugin predicate: whitespace roles and banned admins do not count, an expired ban does', async () => {
    const me = await staff();
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE role LIKE '%admin%' AND id <> $1`, [me.userId]);
    expect(await s.otherAdminExists(me.userId)).toBe(false);
    await staff({ role: 'user, admin' });
    await staff({ role: 'admin', banned: true });
    expect(await s.otherAdminExists(me.userId)).toBe(false);
    const expired = await staff({ role: 'user,admin' });
    await ownerQuery(`UPDATE auth."user" SET banned = true, ban_expires = now() - interval '1 minute' WHERE id = $1`, [expired.userId]);
    expect(await s.otherAdminExists(me.userId)).toBe(true);
  });
  it('writeMark upserts one row; a replaced factor (captured id gone) is SKIPPED, not an error', async () => {
    const a = await staff();
    expect(await s.writeMark({ sessionId: a.sessionId, factorId: a.factorId!, method: 'totp' })).toBe('MARKED');
    expect(await s.writeMark({ sessionId: a.sessionId, factorId: a.factorId!, method: 'backup_code' })).toBe('MARKED');
    expect((await ownerQuery(`SELECT method FROM auth.session_second_factor WHERE session_id = $1`, [a.sessionId]))).toEqual([{ method: 'backup_code' }]);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE id = $1`, [a.factorId]);
    await ownerQuery(`INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('z', 'z', $1, true)`, [a.userId]);
    expect(await s.writeMark({ sessionId: a.sessionId, factorId: a.factorId!, method: 'totp' })).toBe('SKIPPED');
  });
  it(`S-19 (T-37): mark write ∥ factor delete ×${RACE_ROUNDS} → no mark survives the delete`, async () => {
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const a = await staff();
      const [w, d] = await Promise.allSettled([
        s.writeMark({ sessionId: a.sessionId, factorId: a.factorId!, method: 'totp' }),
        pool.query(`DELETE FROM auth.two_factor WHERE id = $1`, [a.factorId]),
      ]);
      expect(d.status).toBe('fulfilled');
      if (w.status === 'rejected') throw w.reason;
      expect(await ownerQuery(`SELECT 1 FROM auth.session_second_factor WHERE session_id = $1`, [a.sessionId])).toEqual([]);
    }
  });
  it('revokeUserCredentials removes factor, trust-device and reset tokens, IdP links, API keys (when asked) and sessions of that user only', async () => {
    const a = await staff();
    const b = await staff();
    for (const x of [a, b]) {
      await ownerQuery(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('trust-device-' || $1, $1, now() + interval '1 day'), ('reset-password:' || $1, $1, now() + interval '1 day')`, [x.userId]);
      await ownerQuery(`INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, 'google', $1, now()), ($1, 'credential', $1, now())`, [x.userId]);
      await ownerQuery(`INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`, [x.userId, randomUUID()]);
    }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await revokeUserCredentials(c, a.userId, { apiKeys: true })).toEqual({ apiKeysDeleted: 1 });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const left = async (x: Staff) => ({
      factor: (await ownerQuery(`SELECT 1 FROM auth.two_factor WHERE user_id = $1`, [x.userId])).length,
      verification: (await ownerQuery(`SELECT 1 FROM auth.verification WHERE value = $1`, [x.userId])).length,
      accounts: (await ownerQuery<{ provider_id: string }>(`SELECT provider_id FROM auth.account WHERE user_id = $1 ORDER BY 1`, [x.userId])).map((r) => r.provider_id),
      apiKeys: (await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [x.userId])).length,
      sessions: (await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [x.userId])).length,
    });
    expect(await left(a)).toEqual({ factor: 0, verification: 0, accounts: ['credential'], apiKeys: 0, sessions: 0 });
    expect(await left(b)).toEqual({ factor: 1, verification: 2, accounts: ['credential', 'google'], apiKeys: 1, sessions: 1 });
  });
  it('R7-C7: lockoutRowKeys covers every row the real guard() wrote for signin and step-up, and nothing of another user', async () => {
    const lockout = new LoginLockout(pool, { maxFailures: 2, windowSec: 60, blockSec: 60 });
    const email = `lk-${randomUUID()}@example.test`;
    const userId = randomUUID();
    for (const scope of [{ kind: 'signin' as const, email }, { kind: 'step-up' as const, userId }]) {
      for (let i = 0; i < 3; i++) await lockout.guard(scope).catch((e: unknown) => { if (!(e instanceof LockoutBlockedError)) throw e; });
    }
    await lockout.guard({ kind: 'step-up', userId: randomUUID() });
    const keys = (await ownerQuery<{ key: string }>(`SELECT key FROM auth.login_attempts`)).map((r) => r.key);
    const covered = (scope: Parameters<typeof lockoutRowKeys>[0]) => {
      const k = lockoutRowKeys(scope);
      return keys.filter((key) => k.exact.includes(key) || k.prefixes.some((p) => key.startsWith(p)));
    };
    const mine = [...covered({ kind: 'signin', email }), ...covered({ kind: 'step-up', userId })];
    expect(mine.some((k) => k.startsWith('blocks:'))).toBe(true);
    expect(mine.some((k) => k.startsWith('attempts:'))).toBe(true);
    expect(mine.some((k) => k.startsWith('tickets:'))).toBe(true);
    expect(mine.every((k) => k.includes(userId) || k.includes('signin:'))).toBe(true);
    expect(keys.filter((k) => k.includes(`step-up:${userId}`)).sort()).toEqual(covered({ kind: 'step-up', userId }).sort());
  });
});
```
Run: `pnpm vitest run --project integration test/integration/identity/staff-step-up.spec.ts`
Expected: FAIL (`staff-step-up.js` không tồn tại).

- [ ] **Step 4: `staff-step-up.ts`**

`src/modules/identity/infra/better-auth/staff-step-up.ts`:
```ts
import type pg from 'pg';
import { hasAdminRole } from '../../ports/identity-directory.js';

/** Phương thức của một lần step-up (cột `method`, `session_second_factor_method_ck`). */
export type StepUpMethod = 'totp' | 'backup_code';
/** Spec SP3 §5.2 hàng `auth-hooks.ts` (1): path → phương thức ghi vào dấu. */
export const STEP_UP_METHOD_BY_PATH: Readonly<Record<string, StepUpMethod>> = {
  '/two-factor/verify-totp': 'totp',
  '/two-factor/verify-backup-code': 'backup_code',
};
export const STEP_UP_PATHS: ReadonlySet<string> = new Set(Object.keys(STEP_UP_METHOD_BY_PATH));
/** Lần chạy lại transaction khi `40P01`/`40001` (lệnh reset, hàng rào (9)(iv); spec §9.7 (5), N5-5). */
export const STAFF_RESET_TX_ATTEMPTS = 3;

export type StepUpMark = { sessionId: string; factorId: string; method: StepUpMethod };
export type StaffFactorState = { exists: boolean; role: string | null; factorId: string | null };
/** Pool hoặc client đang ở trong transaction: mọi câu dưới chạy được trên cả hai. */
export type Sql = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
};
/** Spec §9.7 (7): "nhân viên chưa có factor" = có dòng user, `hasAdminRole(role)`, không factor hiện tại. */
export const staffLacksFactorOf = (s: StaffFactorState): boolean => s.exists && hasAdminRole(s.role) && s.factorId === null;

const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_DEADLOCK = '40P01';
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;

/**
 * "Factor hiện tại" (spec §5.2, r6 N6-6): dòng `two_factor` đã verify của user VÀ cờ `two_factor_enabled` bật. Mọi câu dưới
 * dùng đúng định nghĩa này, nên helper test không bao giờ phải nới câu nào của `src`.
 */
const TOTP_MARK_FRESH = `SELECT 1 FROM auth.two_factor tf
JOIN auth."user" u ON u.id = tf.user_id
JOIN auth.session_second_factor ssf ON ssf.two_factor_id = tf.id AND ssf.session_id = $2
WHERE tf.user_id = $1 AND tf.verified AND u.two_factor_enabled AND ssf.method = 'totp'
  AND ssf.verified_at >= now() - make_interval(secs => $3)`;
const ANY_MARK = `SELECT ssf.verified_at FROM auth.session_second_factor ssf
JOIN auth.two_factor tf ON tf.id = ssf.two_factor_id
JOIN auth."user" u ON u.id = tf.user_id
WHERE ssf.session_id = $1 AND u.id = $2 AND tf.verified AND u.two_factor_enabled`;
const CURRENT_FACTOR = `SELECT tf.id FROM auth.two_factor tf JOIN auth."user" u ON u.id = tf.user_id
WHERE tf.user_id = $1 AND tf.verified AND u.two_factor_enabled`;
/**
 * Khoá ĐỌC (r7 N7-4): transaction của lệnh reset đang giữ dòng user thì câu này chờ lệnh commit rồi thấy bản đã commit.
 * Subquery đọc snapshot của câu lệnh, nên quyết định phải đi qua cờ `u.two_factor_enabled` của dòng đã khoá (lệnh luôn
 * ghi cờ `false`; không được bỏ cờ khỏi câu này). `two_factor_user_id_unique` bảo đảm ≤ 1 factor.
 */
const FACTOR_STATE = `SELECT u.role, CASE WHEN u.two_factor_enabled THEN (
    SELECT tf.id FROM auth.two_factor tf WHERE tf.user_id = u.id AND tf.verified) END AS factor_id
FROM auth."user" u WHERE u.id = $1 FOR SHARE OF u`;
/** Cùng vị từ `hasAdminRole` (tách theo `,`, không `btrim`) và cùng điều kiện `isBanned` (spec §5.2, r7 N7-2). */
const OTHER_ADMIN = `SELECT EXISTS (SELECT 1 FROM auth."user" u WHERE u.id <> $1
  AND 'admin' = ANY (string_to_array(u.role, ','))
  AND NOT (u.banned IS TRUE AND (u.ban_expires IS NULL OR u.ban_expires > now()))) AS present`;
/** Luật (2): chỉ ghi khi session và factor ĐÃ CHỤP còn tồn tại và cùng user (T-37: factor bị thay → 0 dòng). */
const WRITE_MARK = `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at, created_at, updated_at)
SELECT s.id, tf.id, $3, now(), now(), now() FROM auth.session s JOIN auth.two_factor tf ON tf.user_id = s.user_id
WHERE s.id = $1 AND tf.id = $2
ON CONFLICT (session_id) DO UPDATE SET two_factor_id = EXCLUDED.two_factor_id, method = EXCLUDED.method,
  verified_at = EXCLUDED.verified_at, updated_at = EXCLUDED.updated_at`;

/**
 * Mọi câu SQL về factor và dấu step-up của nhân viên (spec SP3 §5.2 hàng `auth-hooks.ts`, §9.7): một chỗ cho hook Better
 * Auth, Bull Board, `PlatformStaffGuard`, `AuthFacts`, hàng rào sau ghi và lệnh reset, nên các nơi không lệch nhau.
 * Pool `auth_user`; lỗi hạ tầng ném lên (caller trả 503).
 */
export class StaffStepUp {
  constructor(private readonly pool: pg.Pool) {}

  async totpMarkFresh(userId: string, sessionId: string, maxAgeSec: number): Promise<boolean> {
    return (await this.pool.query(TOTP_MARK_FRESH, [userId, sessionId, maxAgeSec])).rowCount === 1;
  }
  async anyMarkVerifiedAt(sessionId: string, userId: string): Promise<Date | undefined> {
    const { rows } = await this.pool.query<{ verified_at: Date }>(ANY_MARK, [sessionId, userId]);
    return rows[0]?.verified_at;
  }
  async currentFactorId(userId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ id: string }>(CURRENT_FACTOR, [userId]);
    return rows[0]?.id;
  }
  async factorState(userId: string, q: Sql = this.pool): Promise<StaffFactorState> {
    const { rows } = await q.query<{ role: string | null; factor_id: string | null }>(FACTOR_STATE, [userId]);
    const r = rows[0];
    return r ? { exists: true, role: r.role, factorId: r.factor_id } : { exists: false, role: null, factorId: null };
  }
  async staffLacksFactor(userId: string, q: Sql = this.pool): Promise<boolean> {
    return staffLacksFactorOf(await this.factorState(userId, q));
  }
  async otherAdminExists(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ present: boolean }>(OTHER_ADMIN, [userId]);
    return rows[0]?.present === true;
  }
  /** `SKIPPED`: session hoặc factor vừa mất (0 dòng, `23503`) hoặc đua với transaction của lệnh reset (`40P01`, T-37). */
  async writeMark(m: StepUpMark): Promise<'MARKED' | 'SKIPPED'> {
    try {
      const r = await this.pool.query(WRITE_MARK, [m.sessionId, m.factorId, m.method]);
      return r.rowCount === 1 ? 'MARKED' : 'SKIPPED';
    } catch (err) {
      const code = codeOf(err);
      if (code === PG_FOREIGN_KEY_VIOLATION || code === PG_DEADLOCK) return 'SKIPPED';
      throw err;
    }
  }
}

/**
 * Năm câu xoá credential của spec §9.7 (5) bước 2, ĐÚNG thứ tự (r7 R7-C3): dùng chung cho lệnh reset và hàng rào
 * (9)(iv) (r8), chạy trong transaction của caller đã khoá dòng user. Factor xoá trước (dấu `CASCADE`); session là câu cuối.
 */
export async function revokeUserCredentials(client: Sql, userId: string, opts: { apiKeys: boolean }): Promise<{ apiKeysDeleted: number }> {
  await client.query(`DELETE FROM auth.two_factor WHERE user_id = $1`, [userId]);
  await client.query(
    `DELETE FROM auth.verification WHERE value = $1 AND (identifier LIKE 'trust-device-%' OR identifier LIKE 'reset-password:%')`,
    [userId],
  );
  await client.query(`DELETE FROM auth.account WHERE user_id = $1 AND provider_id <> 'credential'`, [userId]);
  const apiKeysDeleted = opts.apiKeys
    ? ((await client.query(`DELETE FROM auth.apikey WHERE reference_id = $1`, [userId])).rowCount ?? 0)
    : 0;
  await client.query(`DELETE FROM auth.session WHERE user_id = $1`, [userId]);
  return { apiKeysDeleted };
}
```

`src/modules/identity/infra/better-auth/better-auth-core.module.ts` — thêm provider và export:
```ts
    {
      provide: StaffStepUp,
      inject: [AUTH_POOL],
      useFactory: (pool: pg.Pool) => new StaffStepUp(pool),
    },
```
(`exports` thêm `StaffStepUp`; import `StaffStepUp` từ `./staff-step-up.js`.)

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/identity/lockout-row-keys.spec.ts
pnpm vitest run --project integration test/integration/identity/staff-step-up.spec.ts test/integration/identity/login-lockout.spec.ts
```
Expected: PASS. `login-lockout.spec.ts` của SP2 (refund, khoá, vé) xanh không sửa — định dạng khoá không đổi.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/identity/infra/better-auth test/unit/modules/identity/lockout-row-keys.spec.ts test/integration/identity/staff-step-up.spec.ts
pnpm typecheck && pnpm lint
git add src/modules/identity/infra/better-auth test/unit/modules/identity/lockout-row-keys.spec.ts test/integration/identity/staff-step-up.spec.ts
git commit -m "feat(identity): StaffStepUp queries (TOTP mark, current factor, locked factor state, other admin, mark upsert), revokeUserCredentials; step-up lockout scope and lockoutRowKeys"
```

---

### Task 6: Step-up trong session — lockout consume trước (1), chụp factor và ghi dấu có `method` (2), `AuthFacts.secondFactorVerifiedAt()`, metric `identity_second_factor_step_up_total`

**Files:**
- Create: `src/modules/identity/infra/better-auth/staff-hooks.ts`, `test/support/staff.ts`, `test/e2e/identity/step-up.e2e.spec.ts`
- Modify: `src/modules/identity/infra/better-auth/auth-request-state.ts`, `src/modules/identity/infra/better-auth/auth-hooks.ts`, `src/modules/identity/infra/better-auth/auth-instance.ts`, `src/modules/identity/infra/better-auth/better-auth-core.module.ts`, `src/modules/identity/identity-metrics.ts`, `src/modules/identity/http/auth-facts.ts`, `test/integration/identity/auth-hooks.spec.ts` (deps mới)

**Interfaces:**
- Consumes: `StaffStepUp`, `STEP_UP_PATHS`, `STEP_UP_METHOD_BY_PATH`, `StepUpMark` (Task 5), `LoginLockout.guard({ kind: 'step-up', userId })`, `LockoutBlockedError`, `LockoutUnavailableError` (SP2/Task 5), `hasAdminRole` (Task 4), `AuthState`, `AuthResult.sessionId` (Task 4), `createAuthHooks`/`AuthHookDeps`/`problem`/`rateLimited`/`authUnavailable` (SP2), kết luận T7a–T7c (Task 1).
- Produces:
  - `staff-hooks.ts`: `type StaffHookCtx = { path: string; request?: Request | undefined; query?: unknown }`; `type StaffHookSession = { user: { id: string; role?: string | null }; session: { id: string } }`; `type StaffResponder = { problem(ctx, err: AppError): Response; rateLimited(ctx, retryAfterSec: number): Response; unavailable(ctx): Response; invalidField(ctx, path: string, code: string, message: string): Response }`; `type StaffHookDeps`; `createStaffHooks(d: StaffHookDeps, r: StaffResponder): { beforeWithSession(ctx, session: StaffHookSession | null, body: Record<string, unknown>): Promise<Response | undefined>; after(ctx, o: { failed: boolean; code: string | undefined; body: Record<string, unknown> }): Promise<Response | undefined> }` (Task 7, 8 thêm luật vào hai hàm này).
  - `AuthRequestState.setStepUp(m: StepUpMark | null)`, `.stepUp(): Promise<StepUpMark | null>`.
  - `IdentityMetrics.stepUp` (`identity_second_factor_step_up_total{result, method}`, `result` ∈ `marked | skipped | invalid_code | rate_limited | mark_failed`), `IdentityMetrics.staffStepUpRequired` (`identity_staff_step_up_required_total{surface}`, Task 7 dùng).
  - `AuthFacts.secondFactorVerifiedAt(): Promise<Date | undefined>` (đọc lười, cache trong CLS; credential không phải session hoặc `external` → `undefined`; lỗi hạ tầng ném).
  - `AuthHookDeps`/`AuthInstanceDeps` thêm `stepUp: StaffStepUp`, `metrics: IdentityMetrics`.
  - Test support `test/support/staff.ts`: `STAFF_PASSWORD`, `type EnrolledStaff = { client: AuthClient; email: string; userId: string; totp: TOTP; backupCodes: string[] }`, `enrolStaff(app, opts?: { role?: string }): Promise<EnrolledStaff>` (đăng ký, xác thực email, bật 2FA thật khi còn là user thường, rồi đặt `role`), `stepUp(s, via?: { bearer?: string; backupCode?: string }): Promise<Response>`, `marksOf(userId): Promise<{ session_id: string; two_factor_id: string; method: string; verified_at: Date }[]>`.

- [ ] **Step 1: Test support `staff.ts`**

`test/support/staff.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { URI, type TOTP } from 'otpauth';
import type { Response } from 'supertest';
import { AuthClient } from './auth-client.js';
import { ownerQuery } from './identity-app.js';

export const STAFF_PASSWORD = 'staff correct horse battery';
export type EnrolledStaff = { client: AuthClient; email: string; userId: string; totp: TOTP; backupCodes: string[] };

const must = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`enrolStaff: ${what}`);
};

/**
 * Nhân viên có factor THẬT qua endpoint của Better Auth (spec SP3 §18.0: ca S-* đi qua `verify-totp` thật). 2FA được bật
 * khi user còn là user thường (không tốn lượt lockout step-up, không đi qua hàng rào (9)); `role` đặt bằng SQL sau đó —
 * trạng thái mà production có sau `enable` + `verify-totp` của một nhân viên. Chưa có dấu step-up.
 */
export async function enrolStaff(app: INestApplication, opts: { role?: string } = {}): Promise<EnrolledStaff> {
  const client = new AuthClient(app.getHttpServer());
  const email = `staff-${randomUUID()}@example.test`;
  must((await client.signUp(email, STAFF_PASSWORD)).status === 202, 'sign-up');
  await ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
  must((await client.signIn(email, STAFF_PASSWORD)).status === 200, 'sign-in');
  const en = await client.request('post', '/api/auth/two-factor/enable', { body: { password: STAFF_PASSWORD } });
  must(en.status === 200, `enable ${en.status}`);
  const totp = URI.parse(String(en.body.totpURI)) as TOTP;
  const v = await client.request('post', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } });
  must(v.status === 200, `verify-totp (enable) ${v.status}`);
  await ownerQuery(`UPDATE auth."user" SET role = $2 WHERE email = $1`, [email, opts.role ?? 'admin']);
  const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
  if (!row) throw new Error('enrolStaff: user row missing');
  const backupCodes: unknown = en.body.backupCodes;
  return { client, email, userId: row.id, totp, backupCodes: Array.isArray(backupCodes) ? backupCodes.map(String) : [] };
}

/** Step-up trong session hiện có của client (cookie), hoặc chỉ bằng bearer. */
export function stepUp(s: EnrolledStaff, via: { bearer?: string; backupCode?: string } = {}): Promise<Response> {
  const path = via.backupCode ? '/api/auth/two-factor/verify-backup-code' : '/api/auth/two-factor/verify-totp';
  const code = via.backupCode ?? s.totp.generate();
  return s.client.request('post', path, { body: { code }, ...(via.bearer ? { cookie: false, bearer: via.bearer } : {}) });
}

export const marksOf = (userId: string) =>
  ownerQuery<{ session_id: string; two_factor_id: string; method: string; verified_at: Date }>(
    `SELECT m.session_id, m.two_factor_id, m.method, m.verified_at FROM auth.session_second_factor m
     JOIN auth.session s ON s.id = m.session_id WHERE s.user_id = $1 ORDER BY m.verified_at`,
    [userId],
  );
```

- [ ] **Step 2: E2E step-up (fail)**

`test/e2e/identity/step-up.e2e.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { STAFF_PASSWORD, enrolStaff, marksOf, stepUp } from '../../support/staff.js';

const otel = installOtelCapture();
const MAX = 4;
const EXTRA = 20;
const sessionIdOf = async (bearer: string) =>
  (await ownerQuery<{ id: string }>(`SELECT id FROM auth.session WHERE token = $1`, [bearer]))[0]?.id;
const factorOf = async (userId: string) =>
  (await ownerQuery<{ id: string }>(`SELECT id FROM auth.two_factor WHERE user_id = $1`, [userId]))[0]?.id;

describe('step-up 2FA in a session (spec SP3 §9.7 (1)(2), T7a–c, S-12 identity part, S-20)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentityApp({ env: { AUTH_LOCKOUT_MAX_FAILURES: String(MAX), AUTH_TWO_FACTOR_RATE_MAX: '10000' } });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('TOTP step-up over the cookie and over a bearer alone marks that session on the current factor; the session is unchanged', async () => {
    const s = await enrolStaff(app);
    expect(await marksOf(s.userId)).toEqual([]); // nhánh bật (verified=false) không ghi dấu
    const bearer = s.client.bearer ?? '';
    const before = await ownerQuery(`SELECT id, token FROM auth.session WHERE user_id = $1 ORDER BY id`, [s.userId]);
    const r1 = await stepUp(s);
    expect(r1.status).toBe(200);
    const r2 = await stepUp(s, { bearer });
    expect(r2.status).toBe(200);
    expect(await ownerQuery(`SELECT id, token FROM auth.session WHERE user_id = $1 ORDER BY id`, [s.userId])).toEqual(before);
    const [m] = await marksOf(s.userId);
    expect(m).toMatchObject({ session_id: await sessionIdOf(bearer), two_factor_id: await factorOf(s.userId), method: 'totp' });
    expect(Math.abs(Date.now() - new Date(m!.verified_at).getTime())).toBeLessThan(60_000);
    expect(await otel.metric('identity_second_factor_step_up_total', { result: 'marked', method: 'totp' })).toBeGreaterThanOrEqual(2);
  });
  it('a backup code marks method=backup_code', async () => {
    const s = await enrolStaff(app);
    expect((await stepUp(s, { backupCode: s.backupCodes[0] })).status).toBe(200);
    expect((await marksOf(s.userId)).map((m) => m.method)).toEqual(['backup_code']);
  });
  it('no mark: sign-in with password + TOTP (no-session branch), a non-staff user, a wrong code, a malformed code (Review Focus 4)', async () => {
    const s = await enrolStaff(app);
    const fresh = new AuthClient(app.getHttpServer());
    expect((await fresh.signIn(s.email, STAFF_PASSWORD)).body.twoFactorRedirect).toBe(true);
    expect((await fresh.request('post', '/api/auth/two-factor/verify-totp', { body: { code: s.totp.generate() } })).status).toBe(200);
    expect(await marksOf(s.userId)).toEqual([]);
    expect((await s.client.request('post', '/api/auth/two-factor/verify-totp', { body: { code: '000000' } })).status).toBe(401);
    const malformed = await s.client.request('post', '/api/auth/two-factor/verify-totp', { body: { code: 'abc' } });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    expect(await marksOf(s.userId)).toEqual([]);
    const user = await enrolStaff(app, { role: 'user' });
    expect((await stepUp(user)).status).toBe(200);
    expect(await marksOf(user.userId)).toEqual([]);
  });
  it('a failing mark write keeps verify 200, leaves no mark and logs ERROR (fail closed)', async () => {
    const s = await enrolStaff(app);
    const errors = vi.spyOn(Logger.prototype, 'error');
    await ownerQuery(`REVOKE INSERT ON auth.session_second_factor FROM auth_user`);
    try {
      expect((await stepUp(s)).status).toBe(200);
    } finally {
      await ownerQuery(`GRANT INSERT ON auth.session_second_factor TO auth_user`);
    }
    expect(await marksOf(s.userId)).toEqual([]);
    expect(errors.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'second_factor_mark_failed')).toBe(true);
    errors.mockRestore();
  });
  it(`S-20 (T-38): ${MAX + EXTRA} parallel wrong codes → exactly ${MAX} reach the handler, the rest 429 + Retry-After; then even a right code is 429`, async () => {
    const s = await enrolStaff(app);
    const before = (await otel.metric('identity_second_factor_step_up_total', { result: 'invalid_code', method: 'totp' })) ?? 0;
    const rs = await Promise.all(
      Array.from({ length: MAX + EXTRA }, () => s.client.request('post', '/api/auth/two-factor/verify-totp', { body: { code: '000000' } })),
    );
    expect(rs.filter((r) => r.status === 401)).toHaveLength(MAX);
    const limited = rs.filter((r) => r.status === 429);
    expect(limited).toHaveLength(EXTRA);
    expect(limited.every((r) => Number(r.headers['retry-after']) > 0)).toBe(true);
    expect((await otel.metric('identity_second_factor_step_up_total', { result: 'invalid_code', method: 'totp' })) ?? 0).toBe(before + MAX);
    expect((await stepUp(s)).status).toBe(429);
    expect(await marksOf(s.userId)).toEqual([]);
  });
  it('right codes are counted too (no refund): MAX correct step-ups, then 429', async () => {
    const s = await enrolStaff(app);
    for (let i = 0; i < MAX; i++) expect((await stepUp(s)).status).toBe(200);
    expect((await stepUp(s)).status).toBe(429);
  });
  it('a non-staff user in a session is not counted by the step-up lockout', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    const rs = await Promise.all(Array.from({ length: MAX + 2 }, () => u.client.request('post', '/api/auth/two-factor/verify-totp', { body: { code: '000000' } })));
    expect(rs.every((r) => r.status === 401)).toBe(true);
  });
});
```
(Ca "không dấu" dùng hai lượt thử của `s`, dưới `MAX = 4`. Chaos "storage lockout lỗi → 503" ở Task 27.)

Run: `pnpm vitest run --project integration test/e2e/identity/step-up.e2e.spec.ts`
Expected: FAIL (không có dấu nào được ghi; không có `429` từ lockout step-up).

- [ ] **Step 3: Request state, metric**

`src/modules/identity/infra/better-auth/auth-request-state.ts` — thêm (import type `StepUpMark` từ `./staff-step-up.js`):
```ts
  /** Spec SP3 §9.7 (1)→(2): `{ sessionId, factorId, method }` chụp ở `before` (TRƯỚC khi handler đọc factor, T-37). */
  private readonly stepUpMark = defineRequestState<StepUpMark | null>(() => null);
  async setStepUp(m: StepUpMark | null): Promise<void> {
    await this.stepUpMark.set(m);
  }
  async stepUp(): Promise<StepUpMark | null> {
    return this.stepUpMark.get();
  }
```

`src/modules/identity/identity-metrics.ts` — trong `IdentityMetrics`:
```ts
  /** Spec SP3 §16 (3D): `result` ∈ marked | skipped | invalid_code | rate_limited | mark_failed; `method` ∈ totp | backup_code. */
  readonly stepUp = this.meter.createCounter('identity_second_factor_step_up_total', {
    description: 'Staff step-up attempts in a session, by outcome and method',
  });
  /** Spec SP3 §16 (3D, r5): `surface` ∈ factor | admin | token | dashboard. */
  readonly staffStepUpRequired = this.meter.createCounter('identity_staff_step_up_required_total', {
    description: 'Staff platform-power requests refused for lacking a fresh TOTP step-up, by surface',
  });
```

- [ ] **Step 4: `staff-hooks.ts` (luật (1), (2))**

`src/modules/identity/infra/better-auth/staff-hooks.ts`:
```ts
import type { Logger } from '@nestjs/common';
import type { AppError } from '../../../../core/errors/index.js';
import type { IdentityMetrics } from '../../identity-metrics.js';
import { hasAdminRole } from '../../ports/identity-directory.js';
import type { AuthRequestState } from './auth-request-state.js';
import { LockoutBlockedError, LockoutUnavailableError, type LoginLockout } from './login-lockout.js';
import { STEP_UP_METHOD_BY_PATH, STEP_UP_PATHS, type StaffStepUp } from './staff-step-up.js';

export type StaffHookCtx = { path: string; request?: Request | undefined; query?: unknown };
export type StaffHookSession = { user: { id: string; role?: string | null }; session: { id: string } };
export type StaffResponder = {
  problem(ctx: StaffHookCtx, err: AppError): Response;
  rateLimited(ctx: StaffHookCtx, retryAfterSec: number): Response;
  unavailable(ctx: StaffHookCtx): Response;
  invalidField(ctx: StaffHookCtx, path: string, code: string, message: string): Response;
};
export type StaffHookDeps = {
  stepUp: Pick<StaffStepUp, 'totpMarkFresh' | 'currentFactorId' | 'writeMark' | 'staffLacksFactor' | 'otherAdminExists'>;
  lockout: Pick<LoginLockout, 'guard'>;
  state: AuthRequestState;
  /** `AUTH_SESSION_FRESH_AGE_SEC`: độ mới của dấu TOTP ở gate (3). */
  freshAgeSec: number;
  metrics: Pick<IdentityMetrics, 'stepUp' | 'staffStepUpRequired'>;
  logger: Pick<Logger, 'error' | 'log' | 'warn'>;
};
/** Mã của Better Auth 1.7.6 cho mã sai ở nhánh có session (spike T7c). */
const INVALID_CODES: ReadonlySet<string> = new Set(['INVALID_CODE', 'INVALID_BACKUP_CODE']);

/**
 * Luật của nhân viên nền tảng trong hook Better Auth (spec SP3 §5.2 hàng `auth-hooks.ts`, §9.7). "Nhân viên" =
 * `hasAdminRole(session.user.role)`; session là `d.session(headers)` mà `createAuthHooks` đã đọc (thấy cả bearer, R4C-N4-1).
 * User không phải nhân viên giữ hành vi SP2.
 */
export function createStaffHooks(d: StaffHookDeps, r: StaffResponder) {
  /** (1): lockout theo user, consume TRƯỚC verify (mọi lần thử đều đếm, không refund, N5-2), rồi chụp factor hiện tại. */
  const stepUpBefore = async (ctx: StaffHookCtx, session: StaffHookSession): Promise<Response | undefined> => {
    const method = STEP_UP_METHOD_BY_PATH[ctx.path];
    if (method === undefined) throw new Error(`stepUpBefore on a non step-up path ${ctx.path}`);
    try {
      await d.lockout.guard({ kind: 'step-up', userId: session.user.id });
    } catch (err) {
      if (err instanceof LockoutBlockedError) {
        d.metrics.stepUp.add(1, { result: 'rate_limited', method });
        return r.rateLimited(ctx, err.retryAfterSec);
      }
      if (err instanceof LockoutUnavailableError) return r.unavailable(ctx);
      throw err;
    }
    const factorId = await d.stepUp.currentFactorId(session.user.id);
    // Không có factor hiện tại (chưa bật, đang chờ verify ở nhánh bật): handler tự quyết, không bao giờ có dấu.
    await d.state.setStepUp(factorId ? { sessionId: session.session.id, factorId, method } : null);
    return undefined;
  };

  /** (2): thành công + đã chụp factor → ghi dấu; 0 dòng/23503/40P01 → không dấu (INFO); lỗi khác → ERROR, response giữ nguyên. */
  const stepUpAfter = async (failed: boolean, code: string | undefined): Promise<void> => {
    const mark = await d.state.stepUp();
    if (!mark) return;
    if (failed) {
      if (code !== undefined && INVALID_CODES.has(code)) d.metrics.stepUp.add(1, { result: 'invalid_code', method: mark.method });
      return;
    }
    try {
      const out = await d.stepUp.writeMark(mark);
      d.metrics.stepUp.add(1, { result: out === 'MARKED' ? 'marked' : 'skipped', method: mark.method });
      if (out === 'SKIPPED')
        d.logger.log({ event: 'second_factor_mark_skipped', method: mark.method }, 'step-up verified but its session or factor is gone; no mark');
    } catch (err) {
      d.metrics.stepUp.add(1, { result: 'mark_failed', method: mark.method });
      d.logger.error(
        { event: 'second_factor_mark_failed', method: mark.method, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        'step-up mark write failed; the session stays without a mark (fail closed)',
      );
    }
  };

  return {
    /** Sau kiểm email S2-R76, trước kiểm độ mới (spec §5.2). Task 7, 8 thêm luật (3)–(8). */
    async beforeWithSession(ctx: StaffHookCtx, session: StaffHookSession | null, _body: Record<string, unknown>): Promise<Response | undefined> {
      if (!session || !hasAdminRole(session.user.role)) return undefined;
      if (STEP_UP_PATHS.has(ctx.path)) return stepUpBefore(ctx, session);
      return undefined;
    },
    async after(ctx: StaffHookCtx, o: { failed: boolean; code: string | undefined; body: Record<string, unknown> }): Promise<Response | undefined> {
      if (STEP_UP_PATHS.has(ctx.path)) await stepUpAfter(o.failed, o.code);
      return undefined;
    },
  };
}
```

- [ ] **Step 5: Ghép vào `createAuthHooks` và `createAuthInstance`**

`src/modules/identity/infra/better-auth/auth-hooks.ts`:
- `AuthHookDeps` thêm:
```ts
  /** Spec SP3 §5.2 (3D): mọi câu SQL về factor/dấu của nhân viên. */
  stepUp: StaffStepUp;
  metrics: Pick<IdentityMetrics, 'stepUp' | 'staffStepUpRequired'>;
```
- Trong `createAuthHooks`, sau khi định nghĩa `problem`, `rateLimited`, `invalidField`:
```ts
  const staff = createStaffHooks(
    { stepUp: d.stepUp, lockout: d.lockout, state: d.state, freshAgeSec: d.freshAgeSec, metrics: d.metrics, logger: d.logger },
    {
      problem,
      rateLimited,
      unavailable: (ctx) => problem(ctx, authUnavailable(d.unavailableRetryAfterSec)),
      invalidField,
    },
  );
```
- Trong `before`, ngay SAU khối S2-R76 (`if (verifiedOwner && session && session.user.emailVerified !== true) return …`) và TRƯỚC khối kiểm độ mới:
```ts
    // Spec SP3 §5.2 hàng `auth-hooks.ts`: luật của nhân viên chạy sau kiểm email S2-R76, trước kiểm độ mới.
    const staffRefusal = await staff.beforeWithSession(ctx, session, body);
    if (staffRefusal) return staffRefusal;
```
- Trong `after`, ngay sau vòng refund của `SIGN_IN`:
```ts
    const staffAfter = await staff.after(ctx, { failed, code, body: asRecord(ctx.body) });
    if (staffAfter) return staffAfter;
```

`src/modules/identity/infra/better-auth/auth-instance.ts` — `AuthInstanceDeps` thêm `stepUp: StaffStepUp; metrics: IdentityMetrics;` và truyền vào `createAuthHooks({ …, stepUp: d.stepUp, metrics: d.metrics })`.

`src/modules/identity/infra/better-auth/better-auth-core.module.ts` — factory `BETTER_AUTH`: `inject` thêm `StaffStepUp`, `IdentityMetrics` (import từ `../../identity-metrics.js`; module `@Global` ở cả api lẫn worker); tham số `stepUp: StaffStepUp, metrics: IdentityMetrics`; `createAuthInstance({ …, stepUp, metrics })`. `imports` của module thêm `IdentityMetricsModule` (không phụ thuộc thứ tự nạp module global).

`test/integration/identity/auth-hooks.spec.ts` — `deps` thêm `stepUp: new StaffStepUp(pool)`, `metrics: new IdentityMetrics()` (không đổi ca nào).

- [ ] **Step 6: `AuthFacts.secondFactorVerifiedAt()`**

`src/modules/identity/http/auth-facts.ts`:
```ts
import { Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { StaffStepUp } from '../infra/better-auth/staff-step-up.js';
import type { AuthResult } from '../ports/auth-provider.js';
import { AuthState } from './auth-state.js';

type Authenticated = Extract<AuthResult, { kind: 'AUTHENTICATED' }>;
const SECOND_FACTOR_KEY = 'identity:secondFactorVerifiedAt';

@Injectable()
export class AuthFacts {
  constructor(
    private readonly state: AuthState,
    private readonly cls: ClsService,
    /** Chỉ `local`/`hybrid` (`BetterAuthCoreModule`); `external` không có Better Auth → luôn `undefined`. */
    @Optional() private readonly stepUp?: StaffStepUp,
  ) {}
  …isPlatformAdmin / authenticatedAt / emailVerified / verifiedEmail giữ nguyên…

  /**
   * Spec SP3 §5.2 hàng `AuthFacts` (3D): lần step-up gần nhất của CHÍNH session này trên factor hiện tại (TOTP hoặc backup
   * code). Đọc LƯỜI — chỉ nhánh support grant của `OrgContextMiddleware` gọi, sau khi đã tìm thấy grant (DB2-N8) — một câu
   * trên pool `auth_user`, cache trong CLS của request. Credential không phải session → `undefined`; 0 dòng (chưa step-up,
   * factor bị gỡ/thay, session vừa bị thu hồi: dấu `CASCADE`) → `undefined` (fail closed); lỗi hạ tầng → ném.
   */
  async secondFactorVerifiedAt(): Promise<Date | undefined> {
    const a = this.authed();
    if (!a || a.sessionId === undefined || !this.stepUp) return undefined;
    const cached = this.cls.get<{ value: Date | undefined } | undefined>(SECOND_FACTOR_KEY);
    if (cached) return cached.value;
    const value = await this.stepUp.anyMarkVerifiedAt(a.sessionId, a.principal.id);
    this.cls.set(SECOND_FACTOR_KEY, { value });
    return value;
  }
}
```
(`private authed()` giữ nguyên.) Test unit của `AuthFacts` (có sẵn từ 3A, `test/unit/modules/identity/…`) dựng `new AuthFacts(state, cls)` — tham số thứ ba tuỳ chọn, không phải sửa; thêm hai ca: không `stepUp` → `undefined`; `stepUp` giả trả một `Date` → gọi hai lần chỉ chạm `anyMarkVerifiedAt` một lần (cache CLS). Nếu 3A chưa có file unit cho `AuthFacts`, tạo `test/unit/modules/identity/auth-facts.spec.ts` với hai ca đó.

- [ ] **Step 7: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/identity
pnpm vitest run --project integration test/e2e/identity/step-up.e2e.spec.ts test/integration/identity/auth-hooks.spec.ts test/e2e/identity/two-factor-apikey-jwt.e2e.spec.ts
```
Expected: PASS. `two-factor-apikey-jwt.e2e.spec.ts` (SP2, user thường) xanh không sửa: user thường không bị lockout step-up và không có dấu.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write src/modules/identity test/support/staff.ts test/e2e/identity/step-up.e2e.spec.ts test/integration/identity/auth-hooks.spec.ts test/unit/modules/identity
pnpm lint
git add src/modules/identity test/support/staff.ts test/e2e/identity/step-up.e2e.spec.ts test/integration/identity/auth-hooks.spec.ts test/unit/modules/identity
git commit -m "feat(identity): staff step-up in session with a consume-first per-user lockout and a method-tagged mark; AuthFacts.secondFactorVerifiedAt"
```

---

### Task 7: Gate quyền nền tảng của nhân viên (3), chặn `disable` (4), `twoFactorEnabled` ở `/admin/update-user` (5), id đích chữ thường chuẩn cho mọi `/admin/*`, admin cuối (8), port `PlatformRoleChangeListener` (6), Bull Board; helper dấu cho test và sửa test SP2 gọi quyền nền tảng

**Files:**
- Create: `src/modules/identity/infra/better-auth/admin-target.ts`, `src/modules/identity/ports/platform-role-change-listener.ts`, `test/support/seed-staff-step-up.ts`, `test/e2e/identity/staff-gate.e2e.spec.ts`
- Modify: `src/modules/identity/infra/better-auth/staff-hooks.ts`, `src/modules/identity/infra/better-auth/auth-hooks.ts`, `src/modules/identity/infra/better-auth/auth-instance.ts`, `src/modules/identity/infra/better-auth/better-auth-core.module.ts`, `src/modules/identity/infra/dashboard/platform-admin.authorizer.ts`, `src/modules/identity/index.ts`, `test/support/identity-app.ts`, `test/support/tenancy-principals.ts`, test SP2/3A liệt kê ở Step 7
- Test: `test/e2e/identity/queue-dashboard-access.e2e.spec.ts` (thêm ca)

**Interfaces:**
- Consumes: `createStaffHooks` (Task 6), `StaffStepUp.totpMarkFresh/staffLacksFactor/otherAdminExists` (Task 5), `adminTargetUserId`, `asRecord`, `stringField` (3A `auth-hooks.ts`, chuyển sang `admin-target.ts`), `IdentityErrors.SECOND_FACTOR_REQUIRED`, `LAST_PLATFORM_ADMIN` (Task 4), `CoreErrors.FORBIDDEN`, `CoreErrors.VALIDATION_FAILED`, `AuthResult.sessionId` (Task 4).
- Produces:
  - `admin-target.ts`: `asRecord(v: unknown): Record<string, unknown>`, `stringField(v: unknown, key: string): string | undefined`, `adminTargetUserId(body: unknown): string | undefined` (chuyển nguyên văn từ `auth-hooks.ts`; `auth-hooks.ts` re-export `adminTargetUserId` để import của 3A không đổi).
  - `abstract class PlatformRoleChangeListener { abstract onPlatformRoleChanged(authUserId: string): Promise<void> }` (export ở `index.ts`; `@Global` + `@Optional`, tenancy cài ở Task 23).
  - `staff-hooks.ts`: `STAFF_TOTP_GATED_PATHS`, `ADMIN_PREFIX = '/admin/'`, luật (3), id chuẩn, (4), (5), (8) trong `beforeWithSession`; (6) trong `after`; `StaffHookDeps.roleChange: PlatformRoleChangeListener | undefined`.
  - `PlatformAdminAuthorizer`: nhánh session local/hybrid của nhân viên đòi `StaffStepUp.totpMarkFresh(principal.id, sessionId, AUTH_SESSION_FRESH_AGE_SEC)`; thiếu → `deny(SECOND_FACTOR_REQUIRED)`; lỗi DB → `deny(SERVICE_UNAVAILABLE)` + `Retry-After`.
  - Test support `test/support/seed-staff-step-up.ts`: `seedStaffFactor(authUserId): Promise<string>` (id factor; chèn `auth.two_factor` đã verify nếu chưa có, bật cờ, đánh dấu marker vừa sinh là đã gửi), `seedStepUpMark(o: { sessionId: string; factorId: string; method?: 'totp' | 'backup_code'; ageSec?: number }): Promise<void>`, `seedStaffStepUp(who: { authUserId: string } | { email: string }, o?: { method?: 'totp' | 'backup_code'; ageSec?: number }): Promise<void>` (factor + dấu cho MỌI session hiện có của user).
  - `test/support/tenancy-principals.ts`: `seedStaffPrincipal(opts?: { sessionAgeSec?: number; method?: 'totp' | 'backup_code'; markAgeSec?: number; mark?: boolean }): Promise<SeededPrincipal>` (role `admin`, factor, dấu cho session của nó — trừ `mark: false`).
  - `test/support/identity-app.ts`: `promoteToStaff(email): Promise<void>` = `promoteToAdmin` + `seedStaffStepUp({ email })` (gọi SAU khi đăng nhập).

- [ ] **Step 1: Helper dấu cho test**

`test/support/seed-staff-step-up.ts`:
```ts
import { ownerQuery } from './identity-app.js';

/**
 * Dựng ĐÚNG trạng thái mà production có sau `enable` + `verify-totp` + step-up (spec SP3 §5.3, r6 N6-6): không câu SQL nào
 * của `src` được nới cho test xanh. Luật depcruise `not-to-test` chặn `src` import file này.
 */
export async function seedStaffFactor(authUserId: string): Promise<string> {
  const [f] = await ownerQuery<{ id: string }>(
    `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('seeded-unused', 'seeded-unused', $1, true)
     ON CONFLICT (user_id) DO UPDATE SET verified = true RETURNING id`,
    [authUserId],
  );
  if (!f) throw new Error('seedStaffFactor: no two_factor row');
  const flipped = await ownerQuery(
    `UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1 AND NOT two_factor_enabled RETURNING id`,
    [authUserId],
  );
  // Trigger `user_two_factor_notice_trg` vừa ghi marker: đánh dấu đã gửi để cron không gửi thư thật trong test.
  if (flipped.length > 0)
    await ownerQuery(
      `UPDATE auth.security_notice SET notified_at = GREATEST(clock_timestamp(), created_at)
       WHERE user_id = $1 AND notified_at IS NULL AND abandoned_at IS NULL`,
      [authUserId],
    );
  return f.id;
}

export async function seedStepUpMark(o: { sessionId: string; factorId: string; method?: 'totp' | 'backup_code'; ageSec?: number }): Promise<void> {
  await ownerQuery(
    `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at)
     VALUES ($1, $2, $3, now() - make_interval(secs => $4))
     ON CONFLICT (session_id) DO UPDATE SET two_factor_id = EXCLUDED.two_factor_id, method = EXCLUDED.method,
       verified_at = EXCLUDED.verified_at, updated_at = now()`,
    [o.sessionId, o.factorId, o.method ?? 'totp', o.ageSec ?? 0],
  );
}

/** Factor + dấu cho MỌI session hiện có của user (gọi SAU khi đăng nhập). */
export async function seedStaffStepUp(
  who: { authUserId: string } | { email: string },
  o: { method?: 'totp' | 'backup_code'; ageSec?: number } = {},
): Promise<void> {
  const id =
    'authUserId' in who
      ? who.authUserId
      : (await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [who.email]))[0]?.id;
  if (!id) throw new Error('seedStaffStepUp: user not found');
  const factorId = await seedStaffFactor(id);
  const sessions = await ownerQuery<{ id: string }>(`SELECT id FROM auth.session WHERE user_id = $1`, [id]);
  if (sessions.length === 0) throw new Error('seedStaffStepUp: the user has no session yet (sign in first)');
  for (const s of sessions) await seedStepUpMark({ sessionId: s.id, factorId, ...o });
}
```
`test/support/identity-app.ts` — thêm (import `seedStaffStepUp` từ `./seed-staff-step-up.js`):
```ts
/** Spec SP3 §5.3 (N5-1): admin của test SP2 dùng `/admin/*`/Bull Board/`/token` phải có dấu TOTP. Gọi SAU khi đăng nhập. */
export async function promoteToStaff(email: string): Promise<void> {
  await promoteToAdmin(email);
  await seedStaffStepUp({ email });
}
```
`test/support/tenancy-principals.ts` — thêm:
```ts
/**
 * Principal nhân viên cho G-6 và ca support (spec SP3 §5.3, R5-C3): user `role = 'admin'`, factor đã verify, dấu step-up
 * cho session của nó (mặc định TOTP, vừa xong). Ca S-* đi qua `verify-totp` thật (`test/support/staff.ts`).
 */
export async function seedStaffPrincipal(
  opts: { sessionAgeSec?: number; method?: 'totp' | 'backup_code'; markAgeSec?: number; mark?: boolean } = {},
): Promise<SeededPrincipal> {
  const p = await seedUserPrincipal({ role: 'admin', sessionAgeSec: opts.sessionAgeSec });
  const factorId = await seedStaffFactor(p.authUserId);
  if (opts.mark !== false) await seedStepUpMark({ sessionId: p.sessionId, factorId, method: opts.method, ageSec: opts.markAgeSec });
  return p;
}
```

- [ ] **Step 2: E2E gate (fail)**

`test/e2e/identity/staff-gate.e2e.spec.ts`:
```ts
import { Global, Logger, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRoleChangeListener } from '../../../src/modules/identity/index.js';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { seedStaffFactor, seedStepUpMark } from '../../support/seed-staff-step-up.js';
import { STAFF_PASSWORD, enrolStaff, stepUp, type EnrolledStaff } from '../../support/staff.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';

class FakeRoleChangeListener extends PlatformRoleChangeListener {
  readonly calls: string[] = [];
  fail = false;
  async onPlatformRoleChanged(authUserId: string): Promise<void> {
    this.calls.push(authUserId);
    if (this.fail) throw new Error('listener down');
  }
}
const listener = new FakeRoleChangeListener();
@Global()
@Module({ providers: [{ provide: PlatformRoleChangeListener, useValue: listener }], exports: [PlatformRoleChangeListener] })
class FakeListenerModule {}

const GATED_ADMIN: readonly [string, 'get' | 'post', Record<string, unknown>][] = [
  ['/api/auth/admin/list-users', 'get', {}],
  ['/api/auth/admin/set-role', 'post', { role: 'user' }],
  ['/api/auth/admin/set-user-password', 'post', { newPassword: 'n'.repeat(16) }],
  ['/api/auth/admin/create-user', 'post', { email: 'x@example.test', password: 'p'.repeat(16), name: 'X', role: 'admin' }],
  ['/api/auth/admin/update-user', 'post', { data: { name: 'Renamed' } }],
];

describe('staff platform-power gate (spec SP3 §9.7 (3)(4)(5)(6)(8), S-18, S-21, S-25, N5-1, N6-5, N7-2/3, R8-S2)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  const seeded: SeededPrincipal[] = [];
  const as = (p: SeededPrincipal) => ({
    get: (u: string) => request(app.getHttpServer()).get(u).set('authorization', `Bearer ${p.bearer}`).set('origin', 'http://localhost:3000'),
    post: (u: string, body: object) => request(app.getHttpServer()).post(u).set('authorization', `Bearer ${p.bearer}`).set('origin', 'http://localhost:3000').send(body),
  });
  const roleOf = async (id: string) => (await ownerQuery<{ role: string | null }>(`SELECT role FROM auth."user" WHERE id = $1`, [id]))[0]?.role;
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [FakeListenerModule] });
    auth = app.get<AuthInstance>(BETTER_AUTH);
  });
  beforeEach(() => {
    listener.calls.length = 0;
    listener.fail = false;
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
    vi.unstubAllEnvs();
  });
  const staff = async (o?: Parameters<typeof seedStaffPrincipal>[0]) => {
    const p = await seedStaffPrincipal(o);
    seeded.push(p);
    return p;
  };

  it.each([
    ['no mark', { mark: false }],
    ['a backup_code mark', { method: 'backup_code' as const }],
    ['a TOTP mark older than AUTH_SESSION_FRESH_AGE_SEC', { markAgeSec: 3600 }],
  ])('S-18: a staff session with %s is refused on every /admin/*, /token and factor read, with no DB change', async (_n, o) => {
    const p = await staff(o);
    const target = await seedUserPrincipal();
    seeded.push(target);
    for (const [path, method, body] of GATED_ADMIN) {
      const r = method === 'get' ? await as(p).get(path) : await as(p).post(path, { userId: target.authUserId, ...body });
      expect([path, r.status, r.body.code]).toEqual([path, 403, 'second_factor_required']);
    }
    for (const path of ['/api/auth/two-factor/get-totp-uri', '/api/auth/two-factor/generate-backup-codes'])
      expect((await as(p).post(path, { password: STAFF_PASSWORD })).body.code).toBe('second_factor_required');
    expect((await as(p).get('/api/auth/token')).body.code).toBe('second_factor_required');
    expect(await roleOf(target.authUserId)).toBeNull();
    expect(await ownerQuery(`SELECT 1 FROM auth."user" WHERE email = 'x@example.test'`)).toEqual([]);
  });
  it('S-18: after a real TOTP step-up the same calls pass; /token then carries role', async () => {
    const s = await enrolStaff(app);
    expect((await s.client.request('get', '/api/auth/admin/list-users')).status).toBe(403);
    expect((await stepUp(s)).status).toBe(200);
    expect((await s.client.request('get', '/api/auth/admin/list-users')).status).toBe(200);
    const t = await s.client.request('get', '/api/auth/token');
    expect(t.status).toBe(200);
    expect(JSON.parse(Buffer.from(String(t.body.token).split('.')[1], 'base64url').toString('utf8')).role).toBe('admin');
    expect((await s.client.request('post', '/api/auth/two-factor/get-totp-uri', { body: { password: STAFF_PASSWORD } })).status).toBe(200);
  });
  it('S-18: a backup-code step-up opens none of /admin/*, get-totp-uri, generate-backup-codes', async () => {
    const s = await enrolStaff(app);
    expect((await stepUp(s, { backupCode: s.backupCodes[0] })).status).toBe(200);
    expect((await s.client.request('get', '/api/auth/admin/list-users')).body.code).toBe('second_factor_required');
    expect((await s.client.request('post', '/api/auth/two-factor/generate-backup-codes', { body: { password: STAFF_PASSWORD } })).body.code).toBe('second_factor_required');
  });
  it('(4): a staff member cannot /two-factor/disable, even with a fresh TOTP mark; a regular user still can (SP2)', async () => {
    const s = await enrolStaff(app);
    await stepUp(s);
    const r = await s.client.request('post', '/api/auth/two-factor/disable', { body: { password: STAFF_PASSWORD } });
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(await ownerQuery(`SELECT 1 FROM auth.two_factor WHERE user_id = $1`, [s.userId])).toHaveLength(1);
    const u = await enrolStaff(app, { role: 'user' });
    expect((await u.client.request('post', '/api/auth/two-factor/disable', { body: { password: STAFF_PASSWORD } })).status).toBe(200);
  });
  it('a regular user keeps SP2 behaviour on get-totp-uri, generate-backup-codes and /token', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    expect((await u.client.request('post', '/api/auth/two-factor/get-totp-uri', { body: { password: STAFF_PASSWORD } })).status).toBe(200);
    expect((await u.client.request('get', '/api/auth/token')).status).toBe(200);
  });
  it.each([{ twoFactorEnabled: false }, { two_factor_enabled: false }, { TwoFactorEnabled: false }])(
    'S-21: /admin/update-user with %j → 422, the flag does not change',
    async (data) => {
      const p = await staff();
      const target = await staff();
      const r = await as(p).post('/api/auth/admin/update-user', { userId: target.authUserId, data });
      expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
      expect((await ownerQuery(`SELECT two_factor_enabled FROM auth."user" WHERE id = $1`, [target.authUserId]))[0]).toEqual({ two_factor_enabled: true });
    },
  );
  it.each([
    ['/api/auth/admin/ban-user', {}],
    ['/api/auth/admin/list-user-sessions', {}],
    ['/api/auth/admin/update-user', { data: { banned: true } }],
  ])('R8-S2: %s with an uppercase userId → 422 before any other rule; lowercase keeps SP2 behaviour', async (path, extra) => {
    const p = await staff();
    const r = await as(p).post(path, { userId: p.authUserId.toUpperCase(), ...extra });
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
    expect((await ownerQuery(`SELECT banned FROM auth."user" WHERE id = $1`, [p.authUserId]))[0]).toEqual({ banned: false });
  });
  it('/admin/impersonate-user stays disabled (SP2 D7): 404 whatever the id form, no session created for the target', async () => {
    const p = await staff();
    const target = await seedUserPrincipal({ role: 'admin' });
    seeded.push(target);
    const before = await ownerQuery(`SELECT id FROM auth.session WHERE user_id = $1`, [target.authUserId]);
    for (const userId of [target.authUserId, target.authUserId.toUpperCase()])
      expect((await as(p).post('/api/auth/admin/impersonate-user', { userId })).status).toBe(404);
    expect(await ownerQuery(`SELECT id FROM auth.session WHERE user_id = $1`, [target.authUserId])).toEqual(before);
  });
  describe('S-25 (T-41): the last platform admin cannot drop their own admin role', () => {
    let me: SeededPrincipal;
    beforeEach(async () => {
      me = await staff();
      // Integration chạy tuần tự theo file: admin do file khác để lại được hạ, để "admin cuối cùng" có nghĩa trong file này.
      await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id <> $1 AND role IS NOT NULL AND role <> 'user'`, [me.authUserId]);
    });
    it.each([
      ['/api/auth/admin/set-role', { role: 'user' }],
      ['/api/auth/admin/set-role', { role: ['user'] }],
      ['/api/auth/admin/set-role', { role: 'user, admin' }],
      ['/api/auth/admin/set-role', { role: ' admin' }],
      ['/api/auth/admin/update-user', { data: { role: 'user' } }],
    ])('%s %j on myself → 409 last_platform_admin, role unchanged, grant port not called', async (path, body) => {
      const info = vi.spyOn(Logger.prototype, 'log');
      const r = await as(me).post(path, { userId: me.authUserId, ...body });
      expect([r.status, r.body.code]).toEqual([409, 'last_platform_admin']);
      expect(await roleOf(me.authUserId)).toBe('admin');
      expect(listener.calls).toEqual([]);
      expect(info.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'last_platform_admin_refused')).toBe(true);
      info.mockRestore();
    });
    it('userId as a one-element array is read like the plugin (z.coerce.string) → 409', async () => {
      expect((await as(me).post('/api/auth/admin/set-role', { userId: [me.authUserId], role: 'user' })).status).toBe(409);
    });
    it("role 'admin,user' keeps admin → 200; a user with role 'user, admin' does not count as another admin → 409", async () => {
      expect((await as(me).post('/api/auth/admin/set-role', { userId: me.authUserId, role: 'admin,user' })).status).toBe(200);
      const ws = await seedUserPrincipal({ role: 'user, admin' });
      seeded.push(ws);
      expect((await as(me).post('/api/auth/admin/set-role', { userId: me.authUserId, role: 'user' })).status).toBe(409);
    });
    it('another non-banned admin → 200 (SP2); the only other admin banned → 409', async () => {
      const other = await staff();
      await ownerQuery(`UPDATE auth."user" SET banned = true WHERE id = $1`, [other.authUserId]);
      expect((await as(me).post('/api/auth/admin/set-role', { userId: me.authUserId, role: 'user' })).status).toBe(409);
      await ownerQuery(`UPDATE auth."user" SET banned = false WHERE id = $1`, [other.authUserId]);
      expect((await as(me).post('/api/auth/admin/set-role', { userId: me.authUserId, role: 'user' })).status).toBe(200);
      expect(listener.calls).toEqual([me.authUserId]);
    });
    it('a stale session is refused by the TOTP gate before this rule', async () => {
      const stale = await staff({ mark: false });
      expect((await as(stale).post('/api/auth/admin/set-role', { userId: stale.authUserId, role: 'user' })).body.code).toBe('second_factor_required');
    });
  });
  describe('(6) writing a platform role calls PlatformRoleChangeListener with the plugin-coerced lowercase id (S-23 identity part)', () => {
    it('set-role, update-user with data.role → called once each; update-user without role → not called', async () => {
      const p = await staff();
      const t = await staff();
      await as(p).post('/api/auth/admin/set-role', { userId: [t.authUserId], role: 'user' });
      await as(p).post('/api/auth/admin/update-user', { userId: t.authUserId, data: { role: 'admin' } });
      await as(p).post('/api/auth/admin/update-user', { userId: t.authUserId, data: { name: 'N' } });
      expect(listener.calls).toEqual([t.authUserId, t.authUserId]);
    });
    it('the port throws → 503 service_unavailable + ERROR log; the role is written; the same request again calls the port again', async () => {
      const p = await staff();
      const t = await staff();
      listener.fail = true;
      const errors = vi.spyOn(Logger.prototype, 'error');
      const r = await as(p).post('/api/auth/admin/set-role', { userId: t.authUserId, role: 'user' });
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(await roleOf(t.authUserId)).toBe('user');
      expect(errors.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'platform_role_change_listener_failed')).toBe(true);
      errors.mockRestore();
      listener.fail = false;
      expect((await as(p).post('/api/auth/admin/set-role', { userId: t.authUserId, role: 'user' })).status).toBe(200);
      expect(listener.calls).toEqual([t.authUserId, t.authUserId]);
    });
    it('an uppercase target id → 422, role unchanged, port not called', async () => {
      const p = await staff();
      const t = await staff();
      expect((await as(p).post('/api/auth/admin/set-role', { userId: t.authUserId.toUpperCase(), role: 'user' })).status).toBe(422);
      expect(await roleOf(t.authUserId)).toBe('admin');
      expect(listener.calls).toEqual([]);
    });
  });
  it('S-18: the first admin made by a server call (auth:create-admin path, no session) is still created', async () => {
    const email = `first-admin-${Date.now()}@example.test`;
    const r = await auth.api.createUser({ body: { email, password: 'p'.repeat(16), name: 'First', role: 'admin' } });
    expect(r.user.email).toBe(email);
    const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    await seedStaffFactor(row!.id); // dọn: không để admin chưa có factor rơi vào ca "admin cuối" của file khác
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id = $1`, [row!.id]);
  });
});
```
(`seedStepUpMark` import sẵn cho ca Bull Board ở Step 6.)

Run: `pnpm vitest run --project integration test/e2e/identity/staff-gate.e2e.spec.ts`
Expected: FAIL (không có gate; `PlatformRoleChangeListener` không export).

- [ ] **Step 3: `admin-target.ts`, port**

`src/modules/identity/infra/better-auth/admin-target.ts` — chuyển nguyên văn `asRecord`, `stringField`, `PluginUserId`, `adminTargetUserId` (kèm chú thích của 3A) từ `auth-hooks.ts` sang file này và `export` cả ba hàm; `auth-hooks.ts` import chúng từ `./admin-target.js` và giữ `export { adminTargetUserId } from './admin-target.js';` (test `admin-target-user-id.spec.ts` của 3A import từ `auth-hooks.js`). Lý do: `staff-hooks.ts` cần `adminTargetUserId` mà không tạo vòng import `auth-hooks.ts` ↔ `staff-hooks.ts`.

`src/modules/identity/ports/platform-role-change-listener.ts`:
```ts
/**
 * Spec SP3 §5.2 (3D, r5 N5-1), §9.7 (6): mọi lần ghi role nền tảng qua `/admin/set-role` hoặc `/admin/update-user` có
 * `data.role` (thành công) thu hồi mọi support grant chưa thu hồi của user đó ở mọi org. Tenancy cài trong
 * `TenancyIdentityPortsModule` (`@Global`, chỉ api); identity inject `@Optional()` (identity không import tenancy). Chỉ
 * ném với lỗi hạ tầng hoặc lỗi lập trình; gọi lại cùng id là idempotent.
 */
export abstract class PlatformRoleChangeListener {
  abstract onPlatformRoleChanged(authUserId: string): Promise<void>;
}
```
`src/modules/identity/index.ts` thêm `export { PlatformRoleChangeListener } from './ports/platform-role-change-listener.js';`.

- [ ] **Step 4: Luật (3), id chuẩn, (4), (5), (8), (6) trong `staff-hooks.ts`**

Thêm import `AppError`, `CoreErrors` (giá trị, không chỉ kiểu), `IdentityErrors`, `adminTargetUserId`, `asRecord`, `PlatformRoleChangeListener`, `authUnavailable` không cần (dùng `r.unavailable`). Thêm vào `StaffHookDeps`:
```ts
  /** Port của tenancy (§9.7 (6)); vắng → không làm gì. */
  roleChange: PlatformRoleChangeListener | undefined;
```
Hằng và hàm thêm vào `staff-hooks.ts`:
```ts
export const ADMIN_PREFIX = '/admin/';
/** Gate (3) (r5 N5-1, r6 N6-7): đọc factor, sinh bộ mã mới, mint JWT mang `role`, cộng MỌI path tiền tố `/admin/`. */
export const STAFF_TOTP_GATED_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/token',
]);
const DISABLE_2FA = '/two-factor/disable';
const SET_ROLE = '/admin/set-role';
const UPDATE_USER = '/admin/update-user';
type Surface = 'factor' | 'admin' | 'token';
const surfaceOf = (path: string): Surface => (path.startsWith(ADMIN_PREFIX) ? 'admin' : path === '/token' ? 'token' : 'factor');
/** (5): khoá `twoFactorEnabled` so không phân biệt hoa thường, bỏ `_` (R4A-N2(b)). */
const flipsTwoFactor = (data: Record<string, unknown>): boolean =>
  Object.keys(data).some((k) => k.toLowerCase().replaceAll('_', '') === 'twofactorenabled');
/** Role mới của (8) như `parseRoles` của plugin: mảng nối bằng `,`; kiểu khác → plugin tự từ chối trước khi ghi. */
const newRoleOf = (path: string, body: Record<string, unknown>): string | undefined => {
  const raw = path === SET_ROLE ? body.role : asRecord(body.data).role;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((x): x is string => typeof x === 'string')) return raw.join(',');
  return undefined;
};
const writesRole = (path: string, body: Record<string, unknown>): boolean =>
  path === SET_ROLE || (path === UPDATE_USER && Object.hasOwn(asRecord(body.data), 'role'));
```
Trong `createStaffHooks`, thêm các luật và thay `beforeWithSession`/`after`:
```ts
  /** (3): dấu TOTP tươi trên factor hiện tại; thiếu/backup code/cũ/0 dòng → 403. */
  const totpGate = async (ctx: StaffHookCtx, session: StaffHookSession): Promise<Response | undefined> => {
    if (await d.stepUp.totpMarkFresh(session.user.id, session.session.id, d.freshAgeSec)) return undefined;
    d.metrics.staffStepUpRequired.add(1, { surface: surfaceOf(ctx.path) });
    return r.problem(ctx, new AppError(IdentityErrors.SECOND_FACTOR_REQUIRED));
  };
  /** (8): tự bỏ role admin khi không còn admin nào khác chưa bị ban → 409 (không khoá, T-41 có tên). */
  const lastAdmin = async (ctx: StaffHookCtx, session: StaffHookSession, body: Record<string, unknown>): Promise<Response | undefined> => {
    if (!writesRole(ctx.path, body) || adminTargetUserId(body) !== session.user.id) return undefined;
    const next = newRoleOf(ctx.path, body);
    if (next === undefined || hasAdminRole(next) || (await d.stepUp.otherAdminExists(session.user.id))) return undefined;
    d.logger.log({ event: 'last_platform_admin_refused', userId: session.user.id }, 'the last platform admin tried to drop their own admin role');
    return r.problem(ctx, new AppError(IdentityErrors.LAST_PLATFORM_ADMIN));
  };
```
```ts
    async beforeWithSession(ctx: StaffHookCtx, session: StaffHookSession | null, body: Record<string, unknown>): Promise<Response | undefined> {
      // (5) mọi session (người không phải admin bị plugin từ chối sau đó).
      if (ctx.path === UPDATE_USER && flipsTwoFactor(asRecord(body.data)))
        return r.invalidField(ctx, 'data.twoFactorEnabled', 'not_allowed', 'twoFactorEnabled cannot be changed here; staff factors are reset by the operator command');
      if (!session || !hasAdminRole(session.user.role)) return undefined;
      if (ctx.path.startsWith(ADMIN_PREFIX) || STAFF_TOTP_GATED_PATHS.has(ctx.path)) {
        const refused = await totpGate(ctx, session);
        if (refused) return refused;
      }
      // Quy tắc chung (r8 R8-S2): mọi `/admin/*` có khoá `userId` phải là UUID chữ thường chuẩn sau ép kiểu như plugin.
      if (ctx.path.startsWith(ADMIN_PREFIX) && Object.hasOwn(body, 'userId') && adminTargetUserId(body) === undefined)
        return r.invalidField(ctx, 'userId', 'invalid_user_id', 'userId must be a canonical lowercase UUID');
      if (ctx.path === DISABLE_2FA)
        return r.problem(ctx, new AppError(CoreErrors.FORBIDDEN, { detail: 'Staff factors are replaced only by the operator reset command (pnpm identity:staff-2fa-reset)' }));
      const lastAdminRefusal = await lastAdmin(ctx, session, body);
      if (lastAdminRefusal) return lastAdminRefusal;
      if (STEP_UP_PATHS.has(ctx.path)) return stepUpBefore(ctx, session);
      return undefined;
    },
    async after(ctx: StaffHookCtx, o: { failed: boolean; code: string | undefined; body: Record<string, unknown> }): Promise<Response | undefined> {
      if (STEP_UP_PATHS.has(ctx.path)) await stepUpAfter(o.failed, o.code);
      if (!o.failed && d.roleChange && writesRole(ctx.path, o.body)) {
        const target = adminTargetUserId(o.body);
        if (target === undefined) throw new Error('a role write reached the after-hook without a canonical target id');
        try {
          await d.roleChange.onPlatformRoleChanged(target);
        } catch (err) {
          d.logger.error(
            { event: 'platform_role_change_listener_failed', userId: target, errorClass: err instanceof Error ? err.constructor.name : typeof err },
            'the role was written but revoking the support grants failed; the same request can be retried',
          );
          return r.unavailable(ctx);
        }
      }
      return undefined;
    },
```
(`writesRole` đọc `o.body`, là `ctx.body` đã qua hook `before` — cùng giá trị plugin đã dùng.)

`auth-hooks.ts`: `AuthHookDeps` thêm `roleChange: PlatformRoleChangeListener | undefined;` truyền vào `createStaffHooks`. `auth-instance.ts`: `AuthInstanceDeps` thêm `roleChange?: PlatformRoleChangeListener`, truyền `roleChange: d.roleChange`. `better-auth-core.module.ts`: factory `inject` thêm `{ token: PlatformRoleChangeListener, optional: true }` (sau `UserDeletionGuard`), tham số `roleChange: PlatformRoleChangeListener | undefined`, truyền vào `createAuthInstance`. `test/integration/identity/auth-hooks.spec.ts`: `deps.roleChange = undefined` (khai rõ).

Lưu ý thứ tự trong `before` của `auth-hooks.ts` (Task 6 đã đặt `staff.beforeWithSession` ngay sau S2-R76): hook xoá user (`deletionPrecheck`, 3A) chạy SAU gate, nên `/admin/remove-user` bằng session nhân viên chưa step-up là `403 second_factor_required` trước cả kiểm dạng `userId` — đúng thứ tự spec (gate (3) rồi mới đến mọi luật khác).

- [ ] **Step 5: Bull Board**

`src/modules/identity/infra/dashboard/platform-admin.authorizer.ts` — constructor thêm `@Optional() private readonly stepUp?: StaffStepUp` (import `Optional`; `StaffStepUp` từ `../better-auth/staff-step-up.js`) và `@Inject(identityConfig.KEY) private readonly identity: IdentityConfig` (đổi tham số `identity` hiện có thành field). Nhánh `AUTHENTICATED`:
```ts
      case 'AUTHENTICATED': {
        if (!r.isPlatformAdmin) return this.deny(CoreErrors.FORBIDDEN, credential.kind);
        // Spec SP3 §5.2 hàng `platform-admin.authorizer.ts` (3D, r5 N5-1): session Better Auth của nhân viên đòi dấu TOTP tươi.
        // `external` (EXTERNAL_*): MFA của nhân viên do IdP chịu — giữ hành vi SP2.
        if (credential.kind !== 'SESSION_COOKIE' && credential.kind !== 'BEARER_SESSION') return { allowed: true };
        if (!this.stepUp || r.sessionId === undefined)
          throw new Error('a Better Auth staff session reached the dashboard without StaffStepUp or a session id');
        let fresh: boolean;
        try {
          fresh = await this.stepUp.totpMarkFresh(r.principal.id, r.sessionId, this.identity.sessionFreshAgeSec);
        } catch {
          return this.deny(CoreErrors.SERVICE_UNAVAILABLE, credential.kind, { 'Retry-After': String(this.guard.unavailableRetryAfterSec) });
        }
        return fresh ? { allowed: true } : this.deny(IdentityErrors.SECOND_FACTOR_REQUIRED, credential.kind);
      }
```
(Không gọi lại `getSession`: `sessionId` đến từ chính lần xác thực vừa rồi — lệch có chủ đích, "File Structure".) `IdentityMetrics.staffStepUpRequired.add(1, { surface: 'dashboard' })` gọi trong `deny` khi `error === IdentityErrors.SECOND_FACTOR_REQUIRED`.

`test/e2e/identity/queue-dashboard-access.e2e.spec.ts` — theo harness có sẵn của file (worker + dashboard), đổi mọi admin hiện có sang có dấu (gọi `seedStaffStepUp({ email })` ngay sau khi admin đăng nhập) và thêm ba ca: admin session không dấu → `403` body `second_factor_required`; dấu `backup_code` (`seedStepUpMark({ …, method: 'backup_code' })`) → `403 second_factor_required`; dấu TOTP → được vào (hành vi cũ của ca "admin opens the dashboard").

- [ ] **Step 6: Chạy nhóm mới**

Run: `pnpm vitest run --project integration test/e2e/identity/staff-gate.e2e.spec.ts test/e2e/identity/queue-dashboard-access.e2e.spec.ts test/e2e/identity/step-up.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 7: Sửa test SP2/3A gọi quyền nền tảng bằng session admin (spec §5.3 hàng N5-1)**

Run (liệt kê, không đoán):
```bash
grep -rln "promoteToAdmin\|role = 'admin'\|role: 'admin'\|/admin/\|/api/auth/token\|dashboard\|set-role\|change-password\|reset-password" test --include=*.ts | sort
```
Expected (đã đối chiếu với `origin/main` `90340a4` lúc viết plan; file gọi quyền nền tảng bằng session admin, cần sửa):
  - `test/e2e/identity/auth-mount.e2e.spec.ts` (ca `/admin/ban-user` user không tồn tại → 404, ~dòng 720),
  - `test/e2e/identity/web-mobile.e2e.spec.ts` (`adminClient`: `/admin/ban-user`, `/admin/remove-user`),
  - `test/e2e/identity/oidc-linking.e2e.spec.ts` (`adminClient`: `/admin/create-user`),
  - `test/e2e/identity/queue-dashboard-access.e2e.spec.ts` (`session('admin')` → Bull Board; Step 5),
  - `test/e2e/identity/user-deletion-precheck.e2e.spec.ts`, `test/e2e/identity/user-deletion-without-tenancy.e2e.spec.ts`,
  - `test/e2e/tenancy/account-deletion.e2e.spec.ts`, `test/e2e/tenancy/account-deletion-races.e2e.spec.ts`, `test/e2e/tenancy/pii-logs.e2e.spec.ts`,
  - 3C (ghi chú bàn giao của 3C): `test/e2e/tenancy/acquisition-lifecycle.e2e.spec.ts` (~dòng 324) và `test/e2e/tenancy/acquisition-races.e2e.spec.ts` (O-12, ~dòng 569) gọi `/admin/remove-user`,
  - `test/integration/identity/auth-hooks.spec.ts` (ca S2-R75 M4), `test/integration/identity/user-deletion-release.spec.ts` (nếu dựng admin gọi `/admin/*`),
  - `test/smoke/{dashboard,tenancy}.smoke.spec.ts` (Task 13).
  Không sửa (đã đọc): `fresh-session` (role `admin` chỉ để đọc `AuthFacts`), `orgs-single-mode` (`TENANCY_ORG_CREATION=platform_admin` không thuộc gate), `two-factor-apikey-jwt` (`/token` của user thường), `directory-ledger`, các file unit chỉ nhắc chữ `admin`/`dashboard`. Luật sửa cho từng file (chạy file sau mỗi sửa):
- Admin dựng bằng `promoteToAdmin(email)` + `signIn` rồi gọi `/admin/*`, Bull Board hoặc `/token`: thêm `await seedStaffStepUp({ email })` ngay sau `signIn` (hoặc đổi helper `adminClient` của file sang `promoteToStaff(email)` đặt sau `signIn`). Áp cho `web-mobile` (`adminClient`), `oidc-linking` (`adminClient`), `queue-dashboard-access` (Step 5), `auth-mount` (ca ~dòng 720: admin đăng nhập rồi `seedStaffStepUp({ email })`).
- Admin dựng bằng `seedUserPrincipal({ role: 'admin' })` / `seedP({ role: 'admin' })` rồi gọi `/admin/*`: đổi sang `seedStaffPrincipal()` (giữ đúng tên biến, push vào cùng danh sách dọn). Áp cho `user-deletion-precheck`, `user-deletion-without-tenancy`, `account-deletion`, `account-deletion-races`, `pii-logs`, `acquisition-lifecycle`, `acquisition-races`, `user-deletion-release` (nếu dùng helper này).
- Ca `/admin/impersonate-user` của `auth-mount` (path tắt, 404) giữ nguyên.
- Ca đang khẳng định admin **chưa có dấu** được `/admin/*` (nếu có) đổi kỳ vọng thành `403 second_factor_required` và ghi lý do (N5-1) trong chú thích test.
- `test/integration/identity/auth-hooks.spec.ts:791-830` (S2-R75 M4, lật `twoFactorEnabled` qua `/admin/update-user`): tạm đổi kỳ vọng của bước lật cờ thành `422 validation_failed` (luật (5)) và **giữ** phần còn lại của ý định ("đường ngoài endpoint 2FA vẫn có thông báo") bằng câu `UPDATE auth."user" SET two_factor_enabled = false` qua `owner` như một đường ghi ngoài endpoint; Task 11 thay câu `UPDATE` này bằng lệnh reset thật (spec §5.3: "Ca M4 đổi sang lệnh reset").
- `test/smoke/*.smoke.spec.ts`: sửa ở Task 13 (smoke chạy trên image; cần step-up TOTP thật, không có quyền SQL để chèn dấu một cách hợp lệ ngoài `psql` của harness).
- Test mà user role `admin` **chưa có factor** gọi `/api-key/create`, `/link-social`, đăng nhập IdP (hàng rào (9), Task 9): chưa đỏ ở task này; Task 9 Step 5 quét lại.

- [ ] **Step 8: Chạy toàn bộ integration liên quan identity/tenancy**

Run: `pnpm vitest run --project integration test/e2e/identity test/integration/identity test/e2e/tenancy`
Expected: PASS (mọi file đã sửa theo Step 7).

- [ ] **Step 9: Commit**

```bash
pnpm exec prettier --write src/modules/identity test/support test/e2e test/integration/identity test/chaos/identity-outages.spec.ts
pnpm typecheck && pnpm lint && pnpm arch
git add src/modules/identity test/support test/e2e test/integration/identity test/chaos/identity-outages.spec.ts
git commit -m "feat(identity): staff platform-power gate (TOTP mark for /admin/*, /token, factor reads, Bull Board), no self-disable, no twoFactorEnabled via admin, canonical admin target ids, last platform admin, PlatformRoleChangeListener port"
```

---

### Task 8: Luật (7) — nhân viên chưa có factor không đổi mật khẩu qua HTTP: hook `before` trên ba path (mọi token của `/reset-password`), `resetPasswordToken` dùng chung với reclaim, lớp chặn trước câu ghi (`account.update.before`/`create.before`), test drift `password.mjs`

**Files:**
- Create: `src/modules/identity/infra/better-auth/staff-credential-fence.ts`, `test/unit/modules/identity/reset-password-token.spec.ts`, `test/unit/modules/identity/password-route-drift.spec.ts`, `test/integration/identity/password-write-guard.spec.ts`, `test/e2e/identity/staff-password-rules.e2e.spec.ts`
- Modify: `src/modules/identity/infra/better-auth/staff-hooks.ts`, `src/modules/identity/infra/better-auth/auth-hooks.ts`, `src/modules/identity/infra/better-auth/auth-request-state.ts`, `src/modules/identity/infra/better-auth/auth-instance.ts`, `src/modules/identity/infra/better-auth/auth-error.mapper.ts`

**Interfaces:**
- Consumes: `createStaffHooks` (Task 6–7), `StaffStepUp.factorState/staffLacksFactor`, `staffLacksFactorOf` (Task 5), `stringField`, `adminTargetUserId` (Task 7 `admin-target.ts`), kết luận T7g (Task 2), `createImplicitLinkGuard` (SP2), `AUTH_CODE_MAP` (SP2).
- Produces:
  - `auth-hooks.ts`: `resetPasswordToken(body: unknown, query: unknown): string | undefined` = `stringField(body, 'token') || stringField(query, 'token')` (đúng biểu thức `api/routes/password.mjs`; reclaim S2-R40 dùng hàm này).
  - `staff-hooks.ts`: `PASSWORD_WRITE_PATHS: ReadonlySet<string>` (`/reset-password`, `/change-password`, `/admin/set-user-password`); `beforeResetPassword(ctx, body, query, find: (identifier: string) => Promise<{ value: string } | null>): Promise<Response | undefined>`; `/change-password` và `/admin/set-user-password` trong `beforeWithSession`.
  - `AuthRequestState.setPasswordWriteSubjects(ids: readonly string[])`, `.passwordWriteSubjects(): Promise<readonly string[] | null>` (`null` = hook `before` chưa ghi), `.setWriteFactors(m: ReadonlyMap<string, string | null>)`, `.writeFactors(): Promise<ReadonlyMap<string, string | null>>`.
  - `staff-credential-fence.ts`: `type FenceCtx`, `type StaffCredentialFenceDeps = { pool: pg.Pool; stepUp: StaffStepUp; state: AuthRequestState; logger: Pick<Logger, 'error' | 'warn'> }`, `createStaffCredentialFence(d)` với `passwordWriteBefore(data: Record<string, unknown>, ctx: FenceCtx): Promise<void>` (Task 9 thêm `sessionCreated`, `accountCreated`, `accountUpdated`, `apiKeyCreated`).
  - Mã của identity trong `AUTH_CODE_MAP`: `SECOND_FACTOR_REQUIRED` → `IdentityErrors.SECOND_FACTOR_REQUIRED`, `STAFF_PASSWORD_WRITE_FORBIDDEN` → `CoreErrors.FORBIDDEN`, `STAFF_SESSION_FENCED` → `CoreErrors.UNAUTHENTICATED` (Task 9 dùng); hằng `SECOND_FACTOR_REQUIRED_CODE`, `STAFF_PASSWORD_WRITE_FORBIDDEN_CODE`, `STAFF_SESSION_FENCED_CODE`, `PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE`.

- [ ] **Step 1: Unit `resetPasswordToken` và drift (fail)**

`test/unit/modules/identity/reset-password-token.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { resetPasswordToken } from '../../../../src/modules/identity/infra/better-auth/auth-hooks.js';

/** Spec SP3 §5.2 (7), r7 N7-1: đúng biểu thức của handler `ctx.body.token || ctx.query?.token`. */
describe('resetPasswordToken', () => {
  it.each([
    [{ token: 'b' }, { token: 'q' }, 'b'],
    [{ token: '' }, { token: 'q' }, 'q'],
    [{}, { token: 'q' }, 'q'],
    [{ token: 5 }, { token: 'q' }, 'q'],
    [{}, {}, undefined],
    [{}, { token: ['q1', 'q2'] }, undefined],
  ])('body %j + query %j → %j', (body, query, expected) => {
    expect(resetPasswordToken(body, query)).toBe(expected);
  });
});
```
`test/unit/modules/identity/password-route-drift.spec.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec SP3 §5.2 (7) (r7, r8 R8-S4): luật mật khẩu của nhân viên dựa vào ba chỗ của `api/routes/password.mjs` bản đã cài
 * (mẫu `better-auth-hardening.spec.ts`). Nâng Better Auth mà đổi một chỗ thì test đỏ trước khi luật âm thầm lệch handler.
 */
describe('better-auth /reset-password still reads the token the way the hook assumes (drift)', () => {
  const src = readFileSync(join(process.cwd(), 'node_modules', 'better-auth', 'dist', 'api', 'routes', 'password.mjs'), 'utf8');
  const route = src.slice(src.indexOf('const resetPassword = createAuthEndpoint("/reset-password"'));
  it('query and body token are plain z.string() (no coercion)', () => {
    expect(route).toContain('query: z.object({ token: z.string().optional() }).optional()');
    expect(route).toMatch(/token: z\.string\(\)\.meta\(\{ description: "The token to reset the password" \}\)\.optional\(\)/);
  });
  it('the handler picks body before query with ||', () => {
    expect(route).toContain('const token = ctx.body.token || ctx.query?.token;');
  });
  it('the verification identifier is reset-password:<token>', () => {
    expect(route).toContain('const id = `reset-password:${token}`;');
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/identity/reset-password-token.spec.ts test/unit/modules/identity/password-route-drift.spec.ts`
Expected: `reset-password-token` FAIL (`resetPasswordToken` không export); drift PASS ngay (khoá hiện trạng của 1.7.6).

- [ ] **Step 2: E2E luật (7) (fail)**

`test/e2e/identity/staff-password-rules.e2e.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { seedStaffStepUp } from '../../support/seed-staff-step-up.js';
import { STAFF_PASSWORD, enrolStaff } from '../../support/staff.js';

const NEW_PASSWORD = 'a brand new staff passphrase';
type Person = { client: AuthClient; email: string; userId: string };
const hashOf = async (userId: string) =>
  (await ownerQuery<{ password: string | null }>(`SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`, [userId]))[0]?.password;
const tokenRows = (userId: string) =>
  ownerQuery(`SELECT 1 FROM auth.verification WHERE value = $1 AND identifier LIKE 'reset-password:%'`, [userId]);
const seedResetToken = async (userId: string, expired = false) => {
  const token = randomUUID().replaceAll('-', '');
  await ownerQuery(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [`reset-password:${token}`, userId, expired ? -60 : 3600]);
  return token;
};
const warned = (spy: ReturnType<typeof vi.spyOn>, stage: string) =>
  spy.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'staff_password_change_refused' && 'stage' in o && o.stage === stage);

describe('staff without a factor cannot change or reset a password over HTTP (spec SP3 §9.7 (7), N6-1, N7-1, R8-S1, R8-S4)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  /** Người có mật khẩu, đã xác thực email, đang đăng nhập; `role` như tham số (không factor). */
  const person = async (role: string | null): Promise<Person> => {
    const client = new AuthClient(app.getHttpServer());
    const email = `pw-${randomUUID()}@example.test`;
    await client.signUp(email, STAFF_PASSWORD);
    await ownerQuery(`UPDATE auth."user" SET email_verified = true, role = $2 WHERE email = $1`, [email, role]);
    expect((await client.signIn(email, STAFF_PASSWORD)).status).toBe(200);
    const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    return { client, email, userId: row!.id };
  };
  const reset = (c: AuthClient, body: object, query = '') =>
    c.request('post', `/api/auth/reset-password${query}`, { body, cookie: false });
  beforeAll(async () => {
    app = await startIdentityApp();
    auth = app.get<AuthInstance>(BETTER_AUTH);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('/request-password-reset + /reset-password of staff without a factor → 400 invalid_or_expired_token; the mail is still sent, the token stays, the password is unchanged', async () => {
    const s = await person('admin');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    expect((await s.client.request('post', '/api/auth/request-password-reset', { body: { email: s.email, redirectTo: '/' }, cookie: false })).status).toBeLessThan(300);
    const [t] = await ownerQuery<{ token: string }>(
      `SELECT substring(identifier from 16) AS token FROM auth.verification WHERE value = $1 AND identifier LIKE 'reset-password:%' ORDER BY created_at DESC LIMIT 1`, [s.userId]);
    const before = await hashOf(s.userId);
    const r = await reset(s.client, { token: t!.token, newPassword: NEW_PASSWORD });
    expect([r.status, r.body.code]).toEqual([400, 'invalid_or_expired_token']);
    expect(await tokenRows(s.userId)).toHaveLength(1);
    expect(await hashOf(s.userId)).toBe(before);
    expect(warned(warn, 'hook')).toBe(true);
    expect(await ownerQuery(`SELECT 1 FROM email_deliveries WHERE template = 'reset-password' AND idempotency_key LIKE 'reset-password:%' ORDER BY created_at DESC LIMIT 1`)).toHaveLength(1);
    expect((await new AuthClient(app.getHttpServer()).signIn(s.email, STAFF_PASSWORD)).status).toBe(200);
    warn.mockRestore();
  });
  it('N7-1 / R8-S4: every token of the request is checked — empty body token + query, query only, an expired row, and a regular user token mixed with a staff token (both orders)', async () => {
    const s = await person('admin');
    const x = await person(null);
    const cases: [object, string][] = [
      [{ token: '', newPassword: NEW_PASSWORD }, `?token=${await seedResetToken(s.userId)}`],
      [{ newPassword: NEW_PASSWORD }, `?token=${await seedResetToken(s.userId)}`],
      [{ token: await seedResetToken(s.userId, true), newPassword: NEW_PASSWORD }, ''],
      [{ token: await seedResetToken(x.userId), newPassword: NEW_PASSWORD }, `?token=${await seedResetToken(s.userId)}`],
      [{ token: await seedResetToken(s.userId), newPassword: NEW_PASSWORD }, `?token=${await seedResetToken(x.userId)}`],
    ];
    const hashes = [await hashOf(s.userId), await hashOf(x.userId)];
    for (const [body, query] of cases) {
      const r = await reset(s.client, body, query);
      expect([JSON.stringify(body), query, r.status, r.body.code]).toEqual([JSON.stringify(body), query, 400, 'invalid_or_expired_token']);
    }
    expect([await hashOf(s.userId), await hashOf(x.userId)]).toEqual(hashes);
  });
  it('/change-password of staff without a factor → 403 second_factor_required', async () => {
    const s = await person('admin');
    const r = await s.client.request('post', '/api/auth/change-password', { body: { currentPassword: STAFF_PASSWORD, newPassword: NEW_PASSWORD } });
    expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
  });
  it('another stepped-up admin → /admin/set-user-password for staff without a factor → 403 forbidden', async () => {
    const admin = await person('admin');
    await seedStaffStepUp({ authUserId: admin.userId });
    const s = await person('admin');
    const before = await hashOf(s.userId);
    const r = await admin.client.request('post', '/api/auth/admin/set-user-password', { body: { userId: s.userId, newPassword: NEW_PASSWORD } });
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(await hashOf(s.userId)).toBe(before);
  });
  it('the same three refusals for an admin made by a server call (auth:create-admin path)', async () => {
    const email = `ca-${randomUUID()}@example.test`;
    await auth.api.createUser({ body: { email, password: STAFF_PASSWORD, name: 'CA', role: 'admin' } });
    await ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
    const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    const c = new AuthClient(app.getHttpServer());
    expect((await c.signIn(email, STAFF_PASSWORD)).status).toBe(200);
    expect((await reset(c, { token: await seedResetToken(row!.id), newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await c.request('post', '/api/auth/change-password', { body: { currentPassword: STAFF_PASSWORD, newPassword: NEW_PASSWORD } })).body.code).toBe('second_factor_required');
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id = $1`, [row!.id]);
  });
  it('staff WITH a factor keeps SP2: a reset link works and the next sign-in has the 2FA challenge', async () => {
    const s = await enrolStaff(app);
    const r = await reset(s.client, { token: await seedResetToken(s.userId), newPassword: NEW_PASSWORD });
    expect(r.status).toBe(200);
    expect((await new AuthClient(app.getHttpServer()).signIn(s.email, NEW_PASSWORD)).body.twoFactorRedirect).toBe(true);
  });
  it('a regular user keeps SP2 on all three paths', async () => {
    const x = await person(null);
    expect((await reset(x.client, { token: await seedResetToken(x.userId), newPassword: NEW_PASSWORD })).status).toBe(200);
  });
});
```
`test/integration/identity/password-write-guard.spec.ts` (lớp chặn trước câu ghi, gọi thẳng hàm trong request state của Better Auth):
```ts
import { Logger } from '@nestjs/common';
import { runWithRequestState } from '@better-auth/core/context';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { AuthRequestState } from '../../../src/modules/identity/infra/better-auth/auth-request-state.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { createStaffCredentialFence } from '../../../src/modules/identity/infra/better-auth/staff-credential-fence.js';
import { StaffStepUp } from '../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

describe('pre-write password guard (spec SP3 §9.7 (7), N7-4, R8-S1)', () => {
  let pool: pg.Pool;
  const state = new AuthRequestState();
  let fence: ReturnType<typeof createStaffCredentialFence>;
  const staffWithoutFactor = async () =>
    (await ownerQuery<{ id: string }>(`INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at)
      VALUES ('W', $1, true, 'admin', now(), now(), now()) RETURNING id`, [`w-${randomUUID()}@example.test`]))[0]!.id;
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    fence = createStaffCredentialFence({ pool, stepUp: new StaffStepUp(pool), state, logger: new Logger('fence-test') });
  });
  afterAll(async () => pool?.end());

  it.each(['/reset-password', '/change-password', '/admin/set-user-password'])(
    '%s: a password write without subjects in the request state → 500 PASSWORD_WRITE_SUBJECT_UNRESOLVED + ERROR (fail closed)',
    async (path) => {
      const errors = vi.spyOn(Logger.prototype, 'error');
      await expect(runWithRequestState(new WeakMap(), () => fence.passwordWriteBefore({ password: 'h' }, { path }))).rejects.toMatchObject({
        statusCode: 500,
        body: { code: 'PASSWORD_WRITE_SUBJECT_UNRESOLVED' },
      });
      expect(errors.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'password_write_subject_unresolved')).toBe(true);
      errors.mockRestore();
    },
  );
  it('create.before with a userId outside the recorded subjects → 500', async () => {
    await expect(
      runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([randomUUID()]);
        await fence.passwordWriteBefore({ password: 'h', userId: randomUUID(), providerId: 'credential' }, { path: '/reset-password' });
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
  it.each([
    ['/reset-password', 400, 'INVALID_TOKEN'],
    ['/change-password', 403, 'SECOND_FACTOR_REQUIRED'],
    ['/admin/set-user-password', 403, 'STAFF_PASSWORD_WRITE_FORBIDDEN'],
  ])('%s: a recorded subject that is staff without a factor → %i %s (stage write), factors recorded otherwise', async (path, status, code) => {
    const staff = await staffWithoutFactor();
    await expect(
      runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([staff]);
        await fence.passwordWriteBefore({ password: 'h' }, { path });
      }),
    ).rejects.toMatchObject({ statusCode: status, body: { code } });
    const regular = (await ownerQuery<{ id: string }>(`INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at) VALUES ('R', $1, true, now(), now(), now()) RETURNING id`, [`r-${randomUUID()}@example.test`]))[0]!.id;
    const factors = await runWithRequestState(new WeakMap(), async () => {
      await state.setPasswordWriteSubjects([regular]);
      await fence.passwordWriteBefore({ password: 'h' }, { path });
      return state.writeFactors();
    });
    expect([...factors]).toEqual([[regular, null]]);
  });
  it('writes on other paths or without a password field are ignored', async () => {
    await expect(runWithRequestState(new WeakMap(), () => fence.passwordWriteBefore({ accessToken: 'x' }, { path: '/change-password' }))).resolves.toBeUndefined();
    await expect(runWithRequestState(new WeakMap(), () => fence.passwordWriteBefore({ password: 'h' }, { path: '/callback/:id' }))).resolves.toBeUndefined();
  });
});
```
(Barrier "hook `before` cho qua, lệnh `--for-promotion` commit, thả handler" chạy ở Task 11 vì cần lệnh reset thật.)

Run: `pnpm vitest run --project integration test/e2e/identity/staff-password-rules.e2e.spec.ts test/integration/identity/password-write-guard.spec.ts`
Expected: FAIL (reset của nhân viên chưa có factor thành công; `staff-credential-fence.js` không tồn tại).

- [ ] **Step 3: Request state, mã lỗi, `resetPasswordToken`**

`auth-request-state.ts` — thêm:
```ts
  /** Spec SP3 §9.7 (7) (r8): mọi subject mà hook `before` xác định cho một câu ghi mật khẩu (0–2 ở `/reset-password`). */
  private readonly writeSubjects = defineRequestState<readonly string[] | null>(() => null);
  /** `factor_id` của từng subject lúc lớp chặn trước câu ghi kiểm (hàng rào (9)(iv) so sánh sau câu ghi). */
  private readonly writeFactorIds = defineRequestState<ReadonlyMap<string, string | null>>(() => new Map());
  async setPasswordWriteSubjects(ids: readonly string[]): Promise<void> {
    await this.writeSubjects.set([...ids]);
  }
  async passwordWriteSubjects(): Promise<readonly string[] | null> {
    return this.writeSubjects.get();
  }
  async setWriteFactors(m: ReadonlyMap<string, string | null>): Promise<void> {
    await this.writeFactorIds.set(new Map(m));
  }
  async writeFactors(): Promise<ReadonlyMap<string, string | null>> {
    return this.writeFactorIds.get();
  }
```
`auth-error.mapper.ts` — sau `USER_DELETION_BLOCKED_CODE`:
```ts
/** Mã do CHÍNH identity ném trong `databaseHooks`/hook của nhân viên (spec SP3 §9.7 (7), (9), 3D). */
export const SECOND_FACTOR_REQUIRED_CODE = 'SECOND_FACTOR_REQUIRED';
export const STAFF_PASSWORD_WRITE_FORBIDDEN_CODE = 'STAFF_PASSWORD_WRITE_FORBIDDEN';
export const STAFF_SESSION_FENCED_CODE = 'STAFF_SESSION_FENCED';
/** 500 fail closed: handler ghi mật khẩu cho subject mà hook `before` không xác định (không cần mục trong map: status 500). */
export const PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE = 'PASSWORD_WRITE_SUBJECT_UNRESOLVED';
```
và thêm vào `AUTH_CODE_MAP`:
```ts
  [SECOND_FACTOR_REQUIRED_CODE]: IdentityErrors.SECOND_FACTOR_REQUIRED,
  [STAFF_PASSWORD_WRITE_FORBIDDEN_CODE]: CoreErrors.FORBIDDEN,
  [STAFF_SESSION_FENCED_CODE]: CoreErrors.UNAUTHENTICATED,
```
`auth-hooks.ts` — thêm và dùng trong `reclaimOnReset` (thay biểu thức `stringField(body, 'token') || stringField(ctx.query, 'token')`):
```ts
/**
 * Token đặt lại mật khẩu mà handler CHỌN (`api/routes/password.mjs`: `ctx.body.token || ctx.query?.token`; test drift
 * `password-route-drift.spec.ts`). Reclaim S2-R40 dùng đúng một token này; luật (7) của nhân viên kiểm MỌI token (r8 R8-S4).
 */
export const resetPasswordToken = (body: unknown, query: unknown): string | undefined =>
  stringField(body, 'token') || stringField(query, 'token');
```

- [ ] **Step 4: Luật (7) trong `staff-hooks.ts`**

Thêm hằng và hàm (import `APIError` không cần ở file này; `IdentityErrors`, `CoreErrors`, `AppError`, `stringField` đã có):
```ts
const RESET_PASSWORD = '/reset-password';
const CHANGE_PASSWORD = '/change-password';
const SET_USER_PASSWORD = '/admin/set-user-password';
/** Mọi đường HTTP ghi mật khẩu của một user đã có (spec §9.7 (7); `setPassword` là serverOnly, `/admin/update-user` chặn `password`). */
export const PASSWORD_WRITE_PATHS: ReadonlySet<string> = new Set([RESET_PASSWORD, CHANGE_PASSWORD, SET_USER_PASSWORD]);
const RESET_IDENTIFIER_PREFIX = 'reset-password:';
```
Trong `createStaffHooks`:
```ts
  const refuseWrite = (ctx: StaffHookCtx, userId: string, err: AppError): Response => {
    d.logger.warn({ event: 'staff_password_change_refused', path: ctx.path, userId, stage: 'hook' }, 'a password write for staff without a second factor was refused');
    return r.problem(ctx, err);
  };
```
Trong `beforeWithSession`, NGAY SAU khối (5) (áp cho mọi session, trước kiểm "nhân viên"):
```ts
      if (ctx.path === CHANGE_PASSWORD && session) {
        await d.state.setPasswordWriteSubjects([session.user.id]);
        if (await d.stepUp.staffLacksFactor(session.user.id))
          return refuseWrite(ctx, session.user.id, new AppError(IdentityErrors.SECOND_FACTOR_REQUIRED));
      }
```
và sau khối (8) `lastAdmin` (chỉ nhân viên, đã qua gate và kiểm id chuẩn):
```ts
      if (ctx.path === SET_USER_PASSWORD) {
        const target = adminTargetUserId(body);
        if (target === undefined) throw new Error('set-user-password passed the canonical id rule without a target');
        await d.state.setPasswordWriteSubjects([target]);
        if (await d.stepUp.staffLacksFactor(target))
          return refuseWrite(ctx, target, new AppError(CoreErrors.FORBIDDEN, { detail: 'Use the operator reset command (pnpm identity:staff-2fa-reset) for staff without a second factor' }));
      }
```
Thêm phương thức mới vào object trả về:
```ts
    /**
     * `/reset-password` (không session): phân giải MỌI token khác rỗng ở body và query (tối đa hai; query lặp khoá thành
     * mảng thì bỏ — zod của handler từ chối trước khi handler chạy), đọc dòng `verification` BẤT KỂ hạn, ghi tập subject
     * vào request state; bất kỳ subject nào là nhân viên chưa có factor → 400 như token sai (không oracle; token không bị
     * tiêu thụ). Chạy TRƯỚC reclaim S2-R40.
     */
    async beforeResetPassword(
      ctx: StaffHookCtx,
      body: Record<string, unknown>,
      query: unknown,
      find: (identifier: string) => Promise<{ value: string } | null>,
    ): Promise<Response | undefined> {
      const tokens = [...new Set([stringField(body, 'token'), stringField(query, 'token')])].filter(
        (t): t is string => t !== undefined && t !== '',
      );
      const subjects: string[] = [];
      for (const t of tokens) {
        const v = await find(`${RESET_IDENTIFIER_PREFIX}${t}`);
        if (v && !subjects.includes(v.value)) subjects.push(v.value);
      }
      await d.state.setPasswordWriteSubjects(subjects);
      for (const s of subjects)
        if (await d.stepUp.staffLacksFactor(s)) return refuseWrite(ctx, s, new AppError(IdentityErrors.INVALID_OR_EXPIRED_TOKEN));
      return undefined;
    },
```
`auth-hooks.ts` — trong `before`, thay dòng `if (ctx.path === RESET_PASSWORD) await reclaimOnReset(body);` bằng:
```ts
    if (ctx.path === RESET_PASSWORD) {
      const refused = await staff.beforeResetPassword(ctx, body, ctx.query, (id) =>
        ctx.context.internalAdapter.findVerificationValue(id),
      );
      if (refused) return refused;
      await reclaimOnReset(body);
    }
```

- [ ] **Step 5: Lớp chặn trước câu ghi**

`src/modules/identity/infra/better-auth/staff-credential-fence.ts`:
```ts
import type { Logger } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type pg from 'pg';
import {
  PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE,
  SECOND_FACTOR_REQUIRED_CODE,
  STAFF_PASSWORD_WRITE_FORBIDDEN_CODE,
} from './auth-error.mapper.js';
import type { AuthRequestState } from './auth-request-state.js';
import { PASSWORD_WRITE_PATHS } from './staff-hooks.js';
import { staffLacksFactorOf, type StaffStepUp } from './staff-step-up.js';

/** Endpoint context mà `databaseHooks.*` nhận (spike T7g/h): chỉ đọc các trường dưới. */
export type FenceCtx = {
  path?: string;
  body?: unknown;
  context?: {
    session?: { session: { id: string; userId: string } } | null;
    password?: { verify(i: { hash: string; password: string }): Promise<boolean> };
  };
} | null;
export type StaffCredentialFenceDeps = {
  pool: pg.Pool;
  stepUp: StaffStepUp;
  state: AuthRequestState;
  logger: Pick<Logger, 'error' | 'warn'>;
};

/** Lỗi của từng path khi subject là nhân viên chưa có factor (cùng lỗi với hook `before`, spec §9.7 (7)). */
export const passwordRefusalFor = (path: string): APIError => {
  switch (path) {
    case '/reset-password':
      return APIError.from('BAD_REQUEST', { code: 'INVALID_TOKEN', message: 'Invalid or expired token' });
    case '/change-password':
      return APIError.from('FORBIDDEN', { code: SECOND_FACTOR_REQUIRED_CODE, message: 'Enrol and verify a second factor first' });
    case '/admin/set-user-password':
      return APIError.from('FORBIDDEN', { code: STAFF_PASSWORD_WRITE_FORBIDDEN_CODE, message: 'Use the operator reset command' });
    default:
      throw new Error(`no password refusal for path ${path}`);
  }
};

/**
 * Lớp chặn trước câu ghi mật khẩu và hàng rào sau ghi cho credential của nhân viên chưa có factor (spec SP3 §5.2 hàng
 * `auth-hooks.ts` (7), (9); §9.7). Mọi câu đầu là `factorState` (`FOR SHARE OF u`): transaction của lệnh reset đang mở
 * thì chờ nó commit rồi thấy bản đã commit, nên quyết định dựa trên trạng thái đã commit, không trên thời điểm. Lỗi DB
 * được log rồi ném NGUYÊN (mount đổi lỗi hạ tầng của pool auth thành 503; lỗi lập trình là 500 — fail loud).
 */
export function createStaffCredentialFence(d: StaffCredentialFenceDeps) {
  return {
    /**
     * `databaseHooks.account.update.before` / `account.create.before` (`credential`) trên `PASSWORD_WRITE_PATHS` khi `data`
     * có `password` (spike T7g: `data = { password }`, không `userId`). Tập subject lấy từ request state; rỗng, hoặc
     * `create.before` có `userId` ngoài tập → 500 (handler ghi cho subject hook không thấy: fail closed).
     */
    async passwordWriteBefore(data: Record<string, unknown>, ctx: FenceCtx): Promise<void> {
      const path = ctx?.path;
      if (path === undefined || !PASSWORD_WRITE_PATHS.has(path) || !Object.hasOwn(data, 'password')) return;
      const subjects = await d.state.passwordWriteSubjects();
      const createUserId = typeof data.userId === 'string' ? data.userId : undefined;
      if (!subjects || subjects.length === 0 || (createUserId !== undefined && !subjects.includes(createUserId))) {
        d.logger.error({ event: 'password_write_subject_unresolved', path }, 'a password write reached the database for a subject the before-hook did not resolve');
        throw APIError.from('INTERNAL_SERVER_ERROR', { code: PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE, message: 'Password write refused' });
      }
      const factors = new Map<string, string | null>();
      for (const s of subjects) {
        const st = await d.stepUp.factorState(s);
        factors.set(s, st.factorId);
        if (staffLacksFactorOf(st)) {
          d.logger.warn({ event: 'staff_password_change_refused', path, userId: s, stage: 'write' }, 'a password write for staff without a second factor was refused at write time');
          throw passwordRefusalFor(path);
        }
      }
      await d.state.setWriteFactors(factors);
    },
  };
}
```

`auth-instance.ts` — dựng `const fence = createStaffCredentialFence({ pool: d.pool, stepUp: d.stepUp, state: d.state, logger: d.logger });` cạnh `reclaimer`, và ghép vào `databaseHooks.account` (thêm `account.update` vào danh sách kiểm M3 "buildAuthOptions now sets a database hook…"):
```ts
      account: {
        ...baseDbHooks.account,
        create: {
          ...baseDbHooks.account?.create,
          before: async (account, ctx) => {
            const linked = await implicitLinkGuard(account, ctx);
            if (linked === false) return false;
            if (account.providerId === 'credential') await fence.passwordWriteBefore(account, ctx);
            return undefined;
          },
        },
        update: {
          ...baseDbHooks.account?.update,
          before: async (data, ctx) => {
            await fence.passwordWriteBefore(data, ctx);
            return undefined;
          },
        },
      },
```
(`implicitLinkGuard` = giá trị `createImplicitLinkGuard(...)` hiện có, gán vào biến trước khi dựng `betterAuth`.)

- [ ] **Step 6: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/identity
pnpm vitest run --project integration test/e2e/identity/staff-password-rules.e2e.spec.ts test/integration/identity/password-write-guard.spec.ts test/integration/identity/auth-hooks.spec.ts test/e2e/identity/oidc-linking.e2e.spec.ts
```
Expected: PASS. Ca reclaim S2-R40 của `auth-hooks.spec.ts` (PR #2 của SP2) vẫn xanh sau khi reclaim dùng `resetPasswordToken`; `oidc-linking` (S2-R49, `create.before`) xanh.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/identity test/unit/modules/identity test/integration/identity test/e2e/identity
pnpm lint
git add src/modules/identity test/unit/modules/identity test/integration/identity test/e2e/identity
git commit -m "feat(identity): staff without a factor cannot reset, change or have a password set over HTTP; every reset token is checked; a pre-write guard on all three password paths"
```

---

### Task 9: Hàng rào sau ghi (9) cho credential của nhân viên chưa có factor — session (`session.create.after`), liên kết IdP (`account.create.after`), API key Better Auth (`hooks.after` của `/api-key/create`), câu ghi mật khẩu đã lọt (`account.update.after`/`create.after`, vô hiệu mọi credential)

**Files:**
- Modify: `src/modules/identity/infra/better-auth/staff-credential-fence.ts`, `src/modules/identity/infra/better-auth/auth-instance.ts`, `src/modules/identity/infra/better-auth/auth-hooks.ts`
- Create: `test/e2e/identity/staff-credential-fence.e2e.spec.ts`, `test/e2e/identity/staff-credential-fence-idp.e2e.spec.ts`, `test/integration/identity/staff-credential-fence.spec.ts`

**Interfaces:**
- Consumes: `createStaffCredentialFence`, `FenceCtx`, `passwordRefusalFor` (Task 8), `revokeUserCredentials`, `STAFF_RESET_TX_ATTEMPTS`, `staffLacksFactorOf` (Task 5), `createSessionFence` (SP2), `SECOND_FACTOR_REQUIRED_CODE`, `STAFF_SESSION_FENCED_CODE` (Task 8), `hasAdminRole` (Task 4), kết luận T7h (Task 2).
- Produces: `createStaffCredentialFence(d)` thêm `sessionCreated(session: { id: string; userId: string }, ctx: FenceCtx): Promise<void>`, `accountCreated(account: { id: string; userId: string; providerId: string }, ctx: FenceCtx): Promise<void>`, `accountUpdated(ctx: FenceCtx): Promise<void>`, `apiKeyCreated(key: { id: string; referenceId: string }, path: string): Promise<boolean>` (`true` = key vừa bị xoá); `neutralizeStaffCredentials(pool, userId, path, logger)` (export cho test Task 11).

- [ ] **Step 1: E2E (fail)**

`test/e2e/identity/staff-credential-fence.e2e.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { URI, type TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { STAFF_PASSWORD, enrolStaff } from '../../support/staff.js';

describe('post-write fence for staff without a factor (spec SP3 §9.7 (9), T-43, R8-S5) — requests with no reset in flight', () => {
  let app: INestApplication;
  const lacking = async () => {
    const client = new AuthClient(app.getHttpServer());
    const email = `fence-${randomUUID()}@example.test`;
    await client.signUp(email, STAFF_PASSWORD);
    await ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
    expect((await client.signIn(email, STAFF_PASSWORD)).status).toBe(200);
    await ownerQuery(`UPDATE auth."user" SET role = 'admin' WHERE email = $1`, [email]);
    const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    return { client, email, userId: row!.id };
  };
  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('(a) sign-in with the CURRENT password keeps the session (the operator-set password path)', async () => {
    const s = await lacking();
    const c = new AuthClient(app.getHttpServer());
    const r = await c.signIn(s.email, STAFF_PASSWORD);
    expect(r.status).toBe(200);
    expect(r.headers['set-auth-token']).toBeDefined();
  });
  it('(b) enable → verify-totp (enable branch) rotates from a live session of the same user → 200, not fenced', async () => {
    const s = await lacking();
    const en = await s.client.request('post', '/api/auth/two-factor/enable', { body: { password: STAFF_PASSWORD } });
    expect(en.status).toBe(200);
    const totp = URI.parse(String(en.body.totpURI)) as TOTP;
    const v = await s.client.request('post', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } });
    expect(v.status).toBe(200);
    expect(await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [s.userId])).toHaveLength(1);
  });
  it('(iii) /api-key/create → 403 second_factor_required, the key row is deleted, no secret in the response', async () => {
    const s = await lacking();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const r = await s.client.request('post', '/api/auth/api-key/create', { body: { name: 'x' } });
    expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
    expect(r.body.key).toBeUndefined();
    expect(await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [s.userId])).toEqual([]);
    expect(warn.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'kind' in o && o.kind === 'api_key')).toBe(true);
    warn.mockRestore();
  });
  it('a regular user and staff WITH a factor keep SP2: sign-in and /api-key/create succeed', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    expect((await u.client.request('post', '/api/auth/api-key/create', { body: { name: 'u' } })).status).toBe(200);
    const s = await enrolStaff(app);
    expect((await s.client.request('post', '/api/auth/api-key/create', { body: { name: 's' } })).status).toBe(200);
  });
  it('the fence fails on the DB (the user row is held past the auth_user statement_timeout) → 503, ERROR staff_credential_fence_failed, no Set-Cookie', async () => {
    const s = await lacking();
    const errors = vi.spyOn(Logger.prototype, 'error');
    const { default: pg } = await import('pg');
    const { getInfra } = await import('../../support/infra.js');
    const { pg: p } = getInfra();
    const holder = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`, [s.userId]);
      const r = await new AuthClient(app.getHttpServer()).signIn(s.email, STAFF_PASSWORD);
      expect(r.status).toBe(503);
      expect(r.headers['set-cookie']).toBeUndefined();
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(errors.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'staff_credential_fence_failed')).toBe(true);
    errors.mockRestore();
  }, 30_000);
});
```
`test/e2e/identity/staff-credential-fence-idp.e2e.spec.ts` — theo đúng harness của `oidc-linking.e2e.spec.ts` (`startFakeIdp`, `oidcEnv`, `beginLogin` chép nguyên từ file đó vào file này):
```ts
  it('(ii) /link-social by staff without a factor: the new IdP link is removed; staff WITH a factor links normally', async () => {
    const email = `li-${v7()}@example.test`;
    const owner = new AuthClient(app.getHttpServer());
    await owner.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    expect((await owner.signIn(email, PASSWORD)).status).toBe(200);
    await ownerQuery(`UPDATE auth."user" SET role = 'admin' WHERE email = $1`, [email]);
    const linked = await owner.request('get', await beginLogin(owner, claimsFor(email, { email_verified: true }), '/api/auth/link-social'));
    expect(errorOf(linked)).not.toBeNull();
    expect(await accountProviders(email)).toEqual(['credential']);
  });
```
(`app` dựng bằng `startIdentityApp({ env: oidcEnv('') })`; `errorOf`, `accountProviders`, `claimsFor`, `beginLogin`, `verifyEmailDirect` chép/nhập như `oidc-linking.e2e.spec.ts`.)

`test/integration/identity/staff-credential-fence.spec.ts` — gọi thẳng hàm trong request state (giống Task 8 Step 2):
```ts
  it('(iv) a password write that slipped past the pre-write guard (subject is now staff without a factor) is neutralized: password NULL, factor/sessions/IdP/API keys gone; ERROR staff_password_write_neutralized', async () => {
    const id = await staffWithFactorAndCredentials(); // helper của file: admin + two_factor verified + cờ, credential, google, apikey, 2 session
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [id]);
    await ownerQuery(`UPDATE auth."user" SET two_factor_enabled = false WHERE id = $1`, [id]);
    const errors = vi.spyOn(Logger.prototype, 'error');
    await expect(
      runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([id]);
        await state.setWriteFactors(new Map([[id, 'factor-before']]));
        await fence.accountUpdated({ path: '/reset-password' });
      }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'INVALID_TOKEN' } });
    expect(await left(id)).toEqual({ password: null, factor: 0, sessions: 0, idp: 0, apiKeys: 0 });
    expect(errors.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'staff_password_write_neutralized')).toBe(true);
    errors.mockRestore();
  });
  it('(iv) a factor that changed between the pre-write check and the write (enrolled with the new password) is neutralized too', async () => {
    const id = await staffWithFactorAndCredentials();
    await expect(
      runWithRequestState(new WeakMap(), async () => {
        await state.setPasswordWriteSubjects([id]);
        await state.setWriteFactors(new Map([[id, null]]));
        await fence.accountUpdated({ path: '/change-password' });
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await left(id)).factor).toBe(0);
  });
  it('(iv) staff whose factor id is unchanged (the SP2 reset-by-mail case) → nothing happens', async () => {
    const id = await staffWithFactorAndCredentials();
    const [{ id: factorId }] = await ownerQuery<{ id: string }>(`SELECT id FROM auth.two_factor WHERE user_id = $1`, [id]) as [{ id: string }];
    await runWithRequestState(new WeakMap(), async () => {
      await state.setPasswordWriteSubjects([id]);
      await state.setWriteFactors(new Map([[id, factorId]]));
      await fence.accountUpdated({ path: '/reset-password' });
    });
    expect((await left(id)).factor).toBe(1);
  });
  it('a regular user costs exactly one extra auth query on session create (pg log count)', async () => { /* đếm bằng pool bọc query() đếm lời gọi; kỳ vọng 1 */ });
```
Ca cuối viết đầy đủ như sau (thay chú thích):
```ts
  it('a regular user costs exactly one extra auth query on session create', async () => {
    const counted = createAuthPool(authDatabaseConfig(), databaseConfig());
    let n = 0;
    const original = counted.query.bind(counted) as (...a: unknown[]) => unknown;
    Object.assign(counted, { query: (...a: unknown[]) => { n++; return original(...a); } });
    const f = createStaffCredentialFence({ pool: counted, stepUp: new StaffStepUp(counted), state, logger: new Logger('fence-test') });
    const [u] = await ownerQuery<{ id: string }>(`INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at) VALUES ('U', $1, true, now(), now(), now()) RETURNING id`, [`u-${randomUUID()}@example.test`]);
    const [s] = await ownerQuery<{ id: string }>(`INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`, [randomUUID(), u!.id]);
    await f.sessionCreated({ id: s!.id, userId: u!.id }, { path: '/sign-in/email' });
    expect(n).toBe(0); // sessionCreated dùng client của pool (connect), không query() trực tiếp
    await counted.end();
  });
```
(Đếm câu trên client: `sessionCreated` chạy trên một client trong transaction — `BEGIN`, câu khoá, `COMMIT` — nên đo đúng hơn bằng số lần `pool.connect()` = 1 và không có câu nào khác ngoài `BEGIN`/`factorState`/`COMMIT`: thay khối đếm bằng spy trên `connect` trả client có `query` được đếm, kỳ vọng các câu là đúng `['BEGIN', FACTOR_STATE, 'COMMIT']`.)

Run: `pnpm vitest run --project integration test/e2e/identity/staff-credential-fence.e2e.spec.ts test/e2e/identity/staff-credential-fence-idp.e2e.spec.ts test/integration/identity/staff-credential-fence.spec.ts`
Expected: FAIL (`/api-key/create` của nhân viên chưa có factor trả 200 có `key`; liên kết IdP còn; `accountUpdated` không tồn tại).

- [ ] **Step 2: Hàng rào trong `staff-credential-fence.ts`**

Thêm import `hasAdminRole` (`../../ports/identity-directory.js`), `revokeUserCredentials`, `STAFF_RESET_TX_ATTEMPTS`, `STAFF_SESSION_FENCED_CODE`; thêm hằng và hàm cấp module:
```ts
const SIGN_IN = '/sign-in/email';
const CREDENTIAL = 'credential';
const PG_DEADLOCK = '40P01';
const PG_SERIALIZATION = '40001';
type FenceKind = 'session' | 'idp_link' | 'api_key';
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
const errorClassOf = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

/**
 * (9)(iv): gỡ MỌI credential của subject trong một transaction mở đầu bằng khoá dòng user `FOR NO KEY UPDATE`: cờ 2FA tắt,
 * mật khẩu `NULL`, rồi đúng các câu xoá của bước 2 lệnh reset (`revokeUserCredentials`, `apiKeys: true`). Không ghi `role`,
 * không marker. `40P01`/`40001` (đua câu ghi dấu, như T-37) → chạy lại, tối đa `STAFF_RESET_TX_ATTEMPTS` lần.
 */
export async function neutralizeStaffCredentials(pool: pg.Pool, userId: string, path: string, logger: Pick<Logger, 'error'>): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= STAFF_RESET_TX_ATTEMPTS; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT 1 FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`, [userId]);
      await c.query(`UPDATE auth."user" SET two_factor_enabled = false, updated_at = now() WHERE id = $1`, [userId]);
      await c.query(`UPDATE auth.account SET password = NULL, updated_at = now() WHERE user_id = $1 AND provider_id = 'credential'`, [userId]);
      await revokeUserCredentials(c, userId, { apiKeys: true });
      await c.query('COMMIT');
      logger.error({ event: 'staff_password_write_neutralized', path, userId }, 'a password write slipped past the staff pre-write guard; every credential of the user was removed');
      return;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      last = err;
      const code = codeOf(err);
      if (code !== PG_DEADLOCK && code !== PG_SERIALIZATION) break;
    } finally {
      c.release();
    }
  }
  logger.error({ event: 'staff_password_write_neutralize_failed', path, userId, errorClass: errorClassOf(last) }, 'could not neutralize a raced staff password write; run the operator reset for this user now');
  throw last;
}
```
Trong object của `createStaffCredentialFence`, thêm (và một helper nội bộ `fenceFailed`):
```ts
  const fenceFailed = (kind: FenceKind, path: string, userId: string, err: unknown): never => {
    d.logger.error({ event: 'staff_credential_fence_failed', kind, path, userId, errorClass: errorClassOf(err) }, 'the staff credential fence could not reach the auth database');
    throw err;
  };
  const fenced = (kind: FenceKind, path: string, userId: string) =>
    d.logger.warn({ event: 'staff_credential_fenced', kind, path, userId }, 'a new credential of staff without a second factor was removed');
```
```ts
    /**
     * (9)(i) `session.create.after` (ghép SAU `createSessionFence`): nhân viên chưa có factor chỉ giữ session (a) đăng nhập
     * `/sign-in/email` bằng mật khẩu HIỆN TẠI (hash đọc trong cùng transaction với câu khoá), hoặc (b) xoay từ một session
     * còn sống của chính user. Không đạt → xoá session, 401 (ở sign-in: đúng lỗi sai mật khẩu, không oracle).
     */
    async sessionCreated(session: { id: string; userId: string }, ctx: FenceCtx): Promise<void> {
      const path = ctx?.path ?? 'server';
      const c = await d.pool.connect();
      let lacks = false;
      let hash: string | null = null;
      try {
        await c.query('BEGIN');
        lacks = staffLacksFactorOf(await d.stepUp.factorState(session.userId, c));
        if (lacks && path === SIGN_IN)
          hash = (await c.query<{ password: string | null }>(`SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`, [session.userId])).rows[0]?.password ?? null;
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        fenceFailed('session', path, session.userId, err);
      } finally {
        c.release();
      }
      if (!lacks) return;
      const password = typeof (ctx?.body as { password?: unknown } | undefined)?.password === 'string' ? (ctx?.body as { password: string }).password : undefined;
      const viaCurrentPassword =
        path === SIGN_IN && hash !== null && password !== undefined && ctx?.context?.password !== undefined
          ? await ctx.context.password.verify({ hash, password })
          : false;
      const parent = ctx?.context?.session?.session;
      const rotatedFromLive =
        parent !== undefined && parent.userId === session.userId && parent.id !== session.id
          ? ((await d.pool.query(`SELECT 1 FROM auth.session WHERE id = $1 AND user_id = $2`, [parent.id, session.userId])).rowCount ?? 0) === 1
          : false;
      if (viaCurrentPassword || rotatedFromLive) return;
      try {
        await d.pool.query(`DELETE FROM auth.session WHERE id = $1`, [session.id]);
      } catch (err) {
        fenceFailed('session', path, session.userId, err);
      }
      fenced('session', path, session.userId);
      throw path === SIGN_IN
        ? APIError.from('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' })
        : APIError.from('UNAUTHORIZED', { code: STAFF_SESSION_FENCED_CODE, message: 'Sign in again with your password' });
    },
    /** (9)(ii) liên kết IdP mới (`providerId <> 'credential'`) → xoá, 403; (9)(iv) account `credential` tạo trên `PASSWORD_WRITE_PATHS`. */
    async accountCreated(account: { id: string; userId: string; providerId: string }, ctx: FenceCtx): Promise<void> {
      const path = ctx?.path ?? 'server';
      if (account.providerId === CREDENTIAL) {
        if (PASSWORD_WRITE_PATHS.has(path)) await this.accountUpdated(ctx);
        return;
      }
      let lacks: boolean;
      try {
        lacks = await d.stepUp.staffLacksFactor(account.userId);
        if (lacks) await d.pool.query(`DELETE FROM auth.account WHERE id = $1`, [account.id]);
      } catch (err) {
        return fenceFailed('idp_link', path, account.userId, err);
      }
      if (!lacks) return;
      fenced('idp_link', path, account.userId);
      throw APIError.from('FORBIDDEN', { code: SECOND_FACTOR_REQUIRED_CODE, message: 'Link identity providers after enrolling a second factor' });
    },
    /**
     * (9)(iv) `account.update.after`/`create.after` (`credential`) trên `PASSWORD_WRITE_PATHS`: subject là nhân viên và
     * (chưa có factor, hoặc `factor_id` khác lúc lớp chặn trước kiểm) → câu ghi đã lọt (T-42) hoặc ai đó vừa đăng ký
     * factor bằng chính mật khẩu vừa ghi → vô hiệu mọi credential, ném lỗi của path. Factor giữ nguyên → không làm gì.
     */
    async accountUpdated(ctx: FenceCtx): Promise<void> {
      const path = ctx?.path;
      if (path === undefined || !PASSWORD_WRITE_PATHS.has(path)) return;
      const subjects = (await d.state.passwordWriteSubjects()) ?? [];
      const before = await d.state.writeFactors();
      for (const s of subjects) {
        const st = await d.stepUp.factorState(s);
        if (!st.exists || !hasAdminRole(st.role)) continue;
        if (st.factorId !== null && st.factorId === (before.get(s) ?? null)) continue;
        await neutralizeStaffCredentials(d.pool, s, path, d.logger);
        throw passwordRefusalFor(path);
      }
    },
    /** (9)(iii) `hooks.after` của `/api-key/create` thành công: key của nhân viên chưa có factor bị xoá theo `id`. */
    async apiKeyCreated(key: { id: string; referenceId: string }, path: string): Promise<boolean> {
      try {
        if (!(await d.stepUp.staffLacksFactor(key.referenceId))) return false;
        await d.pool.query(`DELETE FROM auth.apikey WHERE id = $1`, [key.id]);
      } catch (err) {
        return fenceFailed('api_key', path, key.referenceId, err);
      }
      fenced('api_key', path, key.referenceId);
      return true;
    },
```
(`this.accountUpdated` trong `accountCreated`: object trả về là object literal có phương thức, `this` trỏ đúng khi gọi `fence.accountCreated(...)`; nếu lint cấm `this` trong object literal, tách `accountUpdated` thành hàm `const` trong closure và gọi trực tiếp.)

- [ ] **Step 3: Ghép vào Better Auth**

`auth-instance.ts`:
```ts
      session: {
        ...baseDbHooks.session,
        create: {
          ...baseDbHooks.session?.create,
          after: async (session, ctx) => {
            await sessionFence(session, ctx);
            await fence.sessionCreated(session, ctx);
          },
        },
      },
```
(`sessionFence = createSessionFence(reclaimer)`; thứ tự: fence OAuth của SP2 trước, hàng rào nhân viên sau — spec §5.2 (9)(i).) `account.create.after: (account, ctx) => fence.accountCreated(account, ctx)`, `account.update.after: (_account, ctx) => fence.accountUpdated(ctx)`; thêm `session.create.after`, `account.create.after`, `account.update.after` vào điều kiện M3.

`auth-hooks.ts` — `AuthHookDeps` thêm `fence: { apiKeyCreated(key: { id: string; referenceId: string }, path: string): Promise<boolean> }`; `createAuthInstance` dựng `fence` TRƯỚC `createAuthHooks` và truyền vào. Trong `after`, ngay sau `staff.after(...)`:
```ts
    if (!failed && ctx.path === API_KEY_CREATE) {
      const created = asRecord(returned);
      if (typeof created.id === 'string' && typeof created.referenceId === 'string' && (await d.fence.apiKeyCreated({ id: created.id, referenceId: created.referenceId }, ctx.path)))
        return problem(ctx, new AppError(IdentityErrors.SECOND_FACTOR_REQUIRED));
    }
```
`test/integration/identity/auth-hooks.spec.ts` không dựng `createAuthHooks` trực tiếp (đi qua `createAuthInstance`), không phải sửa thêm.

- [ ] **Step 4: Chạy**

Run: `pnpm vitest run --project integration test/e2e/identity/staff-credential-fence.e2e.spec.ts test/e2e/identity/staff-credential-fence-idp.e2e.spec.ts test/integration/identity/staff-credential-fence.spec.ts test/e2e/identity/step-up.e2e.spec.ts test/e2e/identity/oidc-linking.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 5: Quét lại test có admin chưa có factor tạo credential (spec §5.3, r8)**

Run: `grep -rln "api-key/create\|link-social\|sign-in/social\|callback/" test --include=*.ts | sort`
Với mỗi file: nếu user tạo credential là `role = 'admin'` **không** có factor (dựng bằng `promoteToAdmin`/`seedUserPrincipal({ role: 'admin' })` mà chưa `seedStaffStepUp`), dùng `promoteToStaff`/`seedStaffPrincipal()` (có factor) — hàng rào không áp cho nhân viên có factor; ca nào CỐ Ý cần admin chưa có factor thì giữ và đổi kỳ vọng theo hàng rào (session → `401`, liên kết IdP/API key → `403`), ghi lý do (r8) trong chú thích. Chạy lại từng file đã sửa.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/identity test/e2e/identity test/integration/identity
pnpm typecheck && pnpm lint
git add src/modules/identity test/e2e/identity test/integration/identity
git commit -m "feat(identity): post-write fence for staff without a factor (sessions, IdP links, API keys) and neutralization of a raced password write"
```

---

### Task 10: Migration `identity/…_security_notice_operator_reset` — kind `operator_reset`, cột `ticket`, `down` nguyên tử có guard; ledger, thư `two-factor-changed` nhánh vận hành

**Files:**
- Create: `src/migrations/identity/Migration<ts>_security_notice_operator_reset.ts`, `test/integration/identity/security-notice-operator-reset.spec.ts`
- Modify: `src/modules/identity/ports/security-notice-ledger.ts`, `src/modules/identity/application/auth-emails.ts`, `src/modules/notifications/templates.ts`, `src/modules/notifications/templates/two-factor-changed/en/{subject.hbs,body.mjml,text.hbs}`, `test/integration/identity/auth-schema.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`, `test/unit/modules/notifications/renderer.spec.ts`

**Interfaces:**
- Consumes: bảng `auth.security_notice` và trigger `user_two_factor_notice_trg` (SP2 `Migration20260928082958_security_notice`), `AuthEmails.twoFactorChanged`, `TEMPLATE_PARAMS` (notifications), `createScratchDb`, `coreMigrationList`, `runMigrations` (3A/3C test support).
- Produces:
  - `SECURITY_NOTICE_KINDS = ['two_factor_enabled', 'two_factor_disabled', 'operator_reset']`; `STAFF_RESET_TICKET_MAX_LENGTH = 128` (export ở `ports/security-notice-ledger.ts`, Task 11 dùng).
  - `auth.security_notice.ticket text NULL` + `security_notice_ticket_check`; `security_notice_kind_check` ba giá trị.
  - `TEMPLATE_PARAMS['two-factor-changed']` thêm `operatorReset: z.boolean().optional()`; `AuthEmails` gửi `{ enabled: false, operatorReset: true }` cho kind `operator_reset`.

- [ ] **Step 1: Test schema và `down` (fail)**

`test/integration/identity/auth-schema.spec.ts` — thay khối assert constraint của ca `S2-R75: security_notice belongs to its user …` (đoạn `expect(rows.map((r) => r.def)).toEqual([...])`) bằng so sánh đã sắp ở JS (không phụ thuộc collation của `ORDER BY`), thêm hai assert hằng, và thêm một ca mới:
```ts
    expect(rows.map((r) => r.def).sort()).toEqual(
      [
        'CHECK ((abandoned_at >= created_at))',
        "CHECK ((kind = ANY (ARRAY['two_factor_enabled'::text, 'two_factor_disabled'::text, 'operator_reset'::text])))",
        'CHECK ((notified_at >= created_at))',
        'CHECK (((notified_at IS NULL) OR (abandoned_at IS NULL)))',
        "CHECK ((((kind = 'operator_reset'::text) = (ticket IS NOT NULL)) AND ((ticket IS NULL) OR ((char_length(ticket) >= 1) AND (char_length(ticket) <= 128)))))",
        'FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE',
        'NOT NULL created_at',
        'NOT NULL id',
        'NOT NULL kind',
        'NOT NULL user_id',
        'PRIMARY KEY (id)',
      ].sort(),
    );
    // Spec SP3 §5.3 (R7-C2): migration viết cứng danh sách kind và cận trên của ticket; khoá hai bên bằng nhau.
    const kindDef = rows.map((r) => r.def).find((d) => d.includes('kind = ANY'));
    expect([...(kindDef ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])).toEqual([...SECURITY_NOTICE_KINDS]);
    const ticketDef = rows.map((r) => r.def).find((d) => d.includes('char_length(ticket)'));
    expect(Number(/char_length\(ticket\) <= (\d+)/.exec(ticketDef ?? '')?.[1])).toBe(STAFF_RESET_TICKET_MAX_LENGTH);
```
(import thêm `SECURITY_NOTICE_KINDS`, `STAFF_RESET_TICKET_MAX_LENGTH` từ `../../../src/modules/identity/ports/security-notice-ledger.js`.) Ca mới cuối `describe`:
```ts
  it('SP3 §5.2 (3D, R7-C2): ticket exists exactly for operator_reset markers, 1–128 characters', async () => {
    const [u] = (await owner.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at)
       VALUES ('T', $1, true, now(), now(), now()) RETURNING id`, [`ticket-${v7()}@example.test`])).rows;
    const insert = (kind: string, ticket: string | null) =>
      owner.query(`INSERT INTO auth.security_notice (user_id, kind, ticket) VALUES ($1, $2, $3)`, [u!.id, kind, ticket]);
    for (const [kind, ticket] of [
      ['operator_reset', null],
      ['two_factor_disabled', 'T-1'],
      ['operator_reset', ''],
      ['operator_reset', 'x'.repeat(129)],
    ] as const)
      await expect(insert(kind, ticket), `${kind} ${String(ticket)}`).rejects.toMatchObject({ code: '23514', constraint: 'security_notice_ticket_check' });
    await expect(insert('operator_reset', 'x'.repeat(128))).resolves.toBeDefined();
    await expect(insert('two_factor_enabled', null)).resolves.toBeDefined();
    await owner.query(`DELETE FROM auth."user" WHERE id = $1`, [u!.id]);
  });
```
(`v7` từ `uuid`: file đã import; nếu chưa, thêm `import { v7 } from 'uuid';`.)

`test/integration/core/database/normalization-inventory.spec.ts` — trong `ANALYSED_COLUMNS['auth.security_notice']` thêm `'ticket'` (sau `'abandoned_at'`).

`test/integration/identity/security-notice-operator-reset.spec.ts`:
```ts
import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

const POLL_MS = 20;
const WAIT_DEADLINE_MS = 4_000;
type Shape = { constraints: string[]; columns: string[] };

/**
 * Spec SP3 §6.13 bảng 3D (r7 R7-C1, r8 R8-C3): `down` của `…_security_notice_operator_reset` lấy `ACCESS EXCLUSIVE` TRƯỚC
 * mọi đọc, từ chối khi còn marker `operator_reset` chưa ở trạng thái cuối HOẶC thư của chúng còn `PENDING`/`SENDING`, rồi
 * mới xoá marker và trả schema về đúng bản chụp TRƯỚC `up` (không so với assert của `auth-schema.spec.ts`, vì 3D sửa nó).
 */
describe('down of …_security_notice_operator_reset', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  let before: Shape;
  let owner: pg.Client;
  let userId: string;
  const shape = async (): Promise<Shape> => ({
    constraints: (await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'auth.security_notice'::regclass`,
    )).rows.map((r) => r.def).sort(),
    columns: (await owner.query<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'security_notice'`,
    )).rows.map((r) => r.c).sort(),
  });
  const down = () => runMigrations('down', { source: { kind: 'list', list }, to: previous });
  const marker = async (o: { notified?: boolean; abandoned?: boolean } = {}) =>
    (await owner.query<{ id: string }>(
      `INSERT INTO auth.security_notice (user_id, kind, ticket, notified_at, abandoned_at)
       VALUES ($1, 'operator_reset', 'T-1', CASE WHEN $2 THEN clock_timestamp() END, CASE WHEN $3 THEN clock_timestamp() END) RETURNING id`,
      [userId, o.notified ?? false, o.abandoned ?? false],
    )).rows[0]!.id;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('opreset');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_security_notice_operator_reset'));
    if (at < 1) throw new Error('security_notice_operator_reset migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list: list.slice(0, at) } });
    owner = await db.client('owner');
    before = await shape();
    await runMigrations('up', { source: { kind: 'list', list } });
    userId = (await owner.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at, registered_event_emitted_at)
       VALUES ('Op', $1, true, now(), now(), now()) RETURNING id`, [`op-${v7()}@example.test`],
    )).rows[0]!.id;
    // Một marker `two_factor_*` đã gửi: phải còn nguyên sau down.
    await owner.query(`INSERT INTO auth.security_notice (user_id, kind, notified_at) VALUES ($1, 'two_factor_disabled', clock_timestamp())`, [userId]);
  }, 180_000);
  afterAll(async () => {
    await owner?.end();
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('(a) a pending operator_reset marker → RAISE, schema and rows unchanged', async () => {
    const id = await marker();
    await expect(down()).rejects.toThrow(/operator_reset markers or mails are not finished/);
    expect((await owner.query(`SELECT 1 FROM auth.security_notice WHERE id = $1`, [id])).rows).toHaveLength(1);
    expect((await shape()).columns).toContain('ticket');
    await owner.query(`UPDATE auth.security_notice SET notified_at = GREATEST(clock_timestamp(), created_at) WHERE id = $1`, [id]);
  });
  it('(b) a notified marker whose mail is still PENDING → RAISE', async () => {
    const [{ id } = { id: '' }] = (await owner.query<{ id: string }>(
      `SELECT id FROM auth.security_notice WHERE kind = 'operator_reset' AND notified_at IS NOT NULL`)).rows;
    const pid = v7();
    await owner.query(
      `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key)
       VALUES ($1, 'two-factor-changed', 'en', 'x', 'y', 'PENDING', $2)`,
      [pid, `two-factor-changed:${userId}:${id}`],
    );
    await expect(down()).rejects.toThrow(/operator_reset markers or mails are not finished/);
    await owner.query(
      `UPDATE email_deliveries SET state = 'SENT', params_enc = NULL, attempts = 1, completed_at = now() WHERE public_id = $1`, [pid]);
  });
  it('(d) atomic: a marker inserted by an open transaction before the down acquires its lock makes the down RAISE once committed', async () => {
    const b = await db.client('auth');
    try {
      await b.query('BEGIN');
      await b.query(`INSERT INTO auth.security_notice (user_id, kind, ticket) VALUES ($1, 'operator_reset', 'T-2')`, [userId]);
      const pending = down();
      pending.catch(() => undefined);
      const until = Date.now() + WAIT_DEADLINE_MS;
      // Tiến trình của down đang chờ khoá trên auth.security_notice (không ngủ cố định).
      for (;;) {
        const { rows } = await owner.query(
          `SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE c.relname = 'security_notice' AND NOT l.granted AND l.mode = 'AccessExclusiveLock'`);
        if (rows.length > 0) break;
        if (Date.now() > until) throw new Error('down never queued on auth.security_notice');
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      await b.query('COMMIT');
      await expect(pending).rejects.toThrow(/operator_reset markers or mails are not finished/);
      expect((await owner.query(`SELECT 1 FROM auth.security_notice WHERE ticket = 'T-2'`)).rows).toHaveLength(1);
    } finally {
      await b.end();
    }
    await owner.query(`UPDATE auth.security_notice SET abandoned_at = GREATEST(clock_timestamp(), created_at) WHERE ticket = 'T-2'`);
  });
  it('(c) every marker terminal and every mail SENT → down passes: operator_reset markers deleted, two_factor_* kept, schema equals the snapshot before up', async () => {
    await marker({ abandoned: true });
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    expect((await owner.query(`SELECT kind FROM auth.security_notice WHERE user_id = $1`, [userId])).rows).toEqual([{ kind: 'two_factor_disabled' }]);
    expect(await shape()).toEqual(before);
  });
});
```
(Thứ tự ca: (a) → (b) → (d) → (c), vì (c) chạy `down` thành công cuối cùng.)

`test/unit/modules/notifications/renderer.spec.ts` — trong `samples` thêm một ca render riêng cho nhánh vận hành (ngay sau vòng lặp render mọi key):
```ts
  it('two-factor-changed: the operator reset branch says what happened and what to do next', () => {
    const out = r.render('two-factor-changed', 'en', {
      name: 'Ann',
      enabled: false,
      operatorReset: true,
      occurredAt: '2026-10-01T00:00:00.000Z',
    });
    expect(out.subject).toBe('Your password and two-factor authentication were reset');
    expect(out.text).toContain('An operator reset the password and two-factor authentication of your account');
    expect(out.html).toContain('An operator reset the password and two-factor authentication of your account');
  });
```
(`r` là renderer mà file đã dựng cho các ca có sẵn; dùng đúng biến của file.)

Run:
```bash
pnpm vitest run --project unit test/unit/modules/notifications/renderer.spec.ts
pnpm vitest run --project integration test/integration/identity/auth-schema.spec.ts test/integration/identity/security-notice-operator-reset.spec.ts test/integration/core/database/normalization-inventory.spec.ts
```
Expected: FAIL (`operatorReset` bị `.strict()` từ chối; không có cột `ticket`; không có migration).

- [ ] **Step 2: Migration bằng CLI**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/identity --name security_notice_operator_reset`

Thay nội dung lớp (giữ tên lớp và `name` do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3D (spec SP3 §5.2 hàng migration `…_security_notice_operator_reset`, §6.12, §6.13 bảng 3D; r6 N6-3): lệnh vận hành
 * `identity:staff-2fa-reset` ghi marker bền `operator_reset` kèm ticket trong CHÍNH transaction của nó; cron
 * `identity.reconcile-security-notices` của SP2 gửi thư cho chủ tài khoản.
 *
 * Chuẩn hoá (spec §6.12): `auth.security_notice` vẫn BCNF, khoá {id}; `ticket` chỉ phụ thuộc khoá (`id → ticket`), có đúng
 * khi kind = `operator_reset` (`CHECK` hai chiều). Không index mới (không query nào lọc theo ticket; dấu vết lâu dài là log
 * WARN `identity_staff_2fa_reset`).
 *
 * Khoá: `ACCESS EXCLUSIVE` trên `auth.security_notice` trong lúc kiểm hai `CHECK` (bảng marker nhỏ); trigger
 * `user_two_factor_notice_trg` chèn vào bảng này nên bật/tắt 2FA chờ tới hết lô 3D (vốn đã chờ vì `…_session_second_factor`).
 *
 * Down (r7 R7-C1, r8 R8-C3): câu ĐẦU TIÊN lấy `ACCESS EXCLUSIVE` (không nâng khoá giữa chừng), nên guard và câu xoá thấy
 * cùng tập dòng. An toàn khi (a) mọi marker `operator_reset` ở trạng thái cuối VÀ (b) không thư nào của chúng còn
 * `PENDING`/`SENDING` (code cũ `.strict()` không render được `operatorReset`, thư thành FAILED vĩnh viễn). Đọc
 * `public.email_deliveries` là ngoại lệ có tên (chỉ đọc, chỉ ở down; bảng không RLS, thuộc `app_owner`). Đạt → xoá marker
 * `operator_reset` (code cũ không bao giờ đọc marker ở trạng thái cuối), rồi trả schema về hai giá trị.
 */
export class Migration<ts>_security_notice_operator_reset extends Migration {
  override name = 'Migration<ts>_security_notice_operator_reset';

  override up(): void | Promise<void> {
    this.addSql(`ALTER TABLE auth.security_notice DROP CONSTRAINT security_notice_kind_check;`);
    this.addSql(
      `ALTER TABLE auth.security_notice ADD CONSTRAINT security_notice_kind_check CHECK (kind IN ('two_factor_enabled', 'two_factor_disabled', 'operator_reset'));`,
    );
    this.addSql(`ALTER TABLE auth.security_notice ADD COLUMN ticket text NULL;`);
    // 128 = STAFF_RESET_TICKET_MAX_LENGTH (auth-schema.spec.ts khoá hai bên bằng nhau).
    this.addSql(
      `ALTER TABLE auth.security_notice ADD CONSTRAINT security_notice_ticket_check CHECK ((kind = 'operator_reset') = (ticket IS NOT NULL) AND (ticket IS NULL OR char_length(ticket) BETWEEN 1 AND 128));`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`LOCK TABLE auth.security_notice IN ACCESS EXCLUSIVE MODE;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM auth.security_notice n
             WHERE n.kind = 'operator_reset' AND n.notified_at IS NULL AND n.abandoned_at IS NULL)
     OR EXISTS (SELECT 1 FROM auth.security_notice n
                JOIN public.email_deliveries d ON d.idempotency_key = 'two-factor-changed:' || n.user_id || ':' || n.id
                WHERE n.kind = 'operator_reset' AND d.state IN ('PENDING', 'SENDING')) THEN
    RAISE EXCEPTION 'operator_reset markers or mails are not finished: wait for identity.reconcile-security-notices and the mail worker, then run the down again';
  END IF;
END $$;`);
    this.addSql(`DELETE FROM auth.security_notice WHERE kind = 'operator_reset';`);
    this.addSql(`ALTER TABLE auth.security_notice DROP CONSTRAINT security_notice_ticket_check;`);
    this.addSql(`ALTER TABLE auth.security_notice DROP COLUMN ticket;`);
    this.addSql(`ALTER TABLE auth.security_notice DROP CONSTRAINT security_notice_kind_check;`);
    this.addSql(
      `ALTER TABLE auth.security_notice ADD CONSTRAINT security_notice_kind_check CHECK (kind IN ('two_factor_enabled', 'two_factor_disabled'));`,
    );
  }
}
```

- [ ] **Step 3: Ledger, thư, template**

`src/modules/identity/ports/security-notice-ledger.ts`:
```ts
/** Loại thông báo bảo mật; khớp `CHECK` của `auth.security_notice.kind` (SP2 + 3D `…_security_notice_operator_reset`). */
export const SECURITY_NOTICE_KINDS = [
  'two_factor_enabled',
  'two_factor_disabled',
  /** Spec SP3 §5.2 (3D, r6 N6-3): lệnh vận hành đặt lại mật khẩu + 2FA của user (marker mang ticket). */
  'operator_reset',
] as const;
/** Cận trên của `--ticket` của lệnh reset và của `security_notice_ticket_check` (migration viết cứng 128). */
export const STAFF_RESET_TICKET_MAX_LENGTH = 128;
```
`src/modules/identity/application/auth-emails.ts` — thay `twoFactorEnabledBy` bằng:
```ts
/** Kind → tham số của thư `two-factor-changed` (`switch` có `never`: kind mới làm compiler đỏ). */
const twoFactorNoticeParams = (
  kind: SecurityNoticeKind,
): { enabled: boolean; operatorReset?: true } => {
  switch (kind) {
    case 'two_factor_enabled':
      return { enabled: true };
    case 'two_factor_disabled':
      return { enabled: false };
    case 'operator_reset':
      return { enabled: false, operatorReset: true };
    default: {
      const unknown: never = kind;
      throw new Error(`unknown security notice kind: ${String(unknown)}`);
    }
  }
};
```
và trong `twoFactorChanged`: `params: { name: user.name, ...twoFactorNoticeParams(notice.kind), occurredAt: notice.occurredAt.toISOString() }`.

`src/modules/notifications/templates.ts` — `'two-factor-changed'`:
```ts
  // 3D: `operatorReset` THÊM (không đổi `enabled`): `send-email.handler.ts` parse lại tham số đã lưu lúc gửi, nên đổi tên
  // tham số sẽ làm hỏng thư đang chờ lúc deploy (spec SP3 §5.2).
  'two-factor-changed': z
    .object({
      name: displayName,
      enabled: z.boolean(),
      operatorReset: z.boolean().optional(),
      occurredAt: z.iso.datetime(),
    })
    .strict(),
```
`templates/two-factor-changed/en/subject.hbs`:
```hbs
{{#if operatorReset}}Your password and two-factor authentication were reset{{else}}{{#if enabled}}Two-factor authentication turned on{{else}}Two-factor authentication turned off{{/if}}{{/if}}
```
`templates/two-factor-changed/en/text.hbs`:
```hbs
Hi {{name}},

{{#if operatorReset}}An operator reset the password and two-factor authentication of your account at {{occurredAt}} (UTC), following a support ticket. Sign in with the temporary password from your ticket, set up two-factor authentication again, then choose a new password.{{else}}{{#if enabled}}Two-factor authentication was turned on{{else}}Two-factor authentication was turned off{{/if}} for your account at {{occurredAt}} (UTC).{{/if}}

If this was not you, contact support immediately.
```
`templates/two-factor-changed/en/body.mjml`:
```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hi {{name}},</mj-text>
        <mj-text>{{#if operatorReset}}An operator reset the password and two-factor authentication of your account at {{occurredAt}} (UTC), following a support ticket. Sign in with the temporary password from your ticket, set up two-factor authentication again, then choose a new password.{{else}}{{#if enabled}}Two-factor authentication was turned on{{else}}Two-factor authentication was turned off{{/if}} for your account at {{occurredAt}} (UTC).{{/if}}</mj-text>
        <mj-text>If this was not you, contact support immediately.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
(Câu cuối đổi từ "reset your password and contact support immediately" sang "contact support immediately": với nhánh vận hành, "reset your password" mâu thuẫn với hướng dẫn ngay trên. Nếu `renderer.spec.ts` có assert nguyên văn câu cũ, cập nhật cùng commit.)

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm build
pnpm vitest run --project unit test/unit/modules/notifications test/unit/modules/identity test/unit/migrations
pnpm vitest run --project integration test/integration/identity/auth-schema.spec.ts test/integration/identity/security-notice-operator-reset.spec.ts test/integration/identity/security-notice.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/core/database/migrations.spec.ts test/integration/core/database/rls-catalog.spec.ts
```
Expected: PASS. `migrations.spec.ts`: up → down → up và sweep S2-R57 gồm migration mới (DB riêng, không có marker `operator_reset`, `down` đạt). `security-notice.spec.ts` của SP2 xanh không sửa (hai kind cũ giữ nguyên tham số thư).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/migrations/identity src/modules/identity/ports/security-notice-ledger.ts src/modules/identity/application/auth-emails.ts src/modules/notifications/templates.ts test/integration/identity test/integration/core/database/normalization-inventory.spec.ts test/unit/modules/notifications/renderer.spec.ts
pnpm typecheck && pnpm lint
git add src/migrations/identity src/modules/identity/ports/security-notice-ledger.ts src/modules/identity/application/auth-emails.ts src/modules/notifications/templates.ts src/modules/notifications/templates/two-factor-changed test/integration/identity test/integration/core/database/normalization-inventory.spec.ts test/unit/modules/notifications/renderer.spec.ts
git commit -m "feat(identity): operator_reset security notice with a ticket; the two-factor-changed mail gains an operator reset branch; an atomic guarded down"
```

---

### Task 11: Lệnh `identity:staff-2fa-reset` (spec §9.7 (5)) — một transaction, chế độ `RESET`/`PROMOTE` theo trạng thái, kiểm sau commit, mã thoát `1`/`2`; S-22, S-24 và các ca barrier của luật (7)/(9)

**Files:**
- Create: `src/modules/identity/infra/better-auth/staff-2fa-reset.ts`, `src/modules/identity/infra/better-auth/staff-2fa-reset.cli.ts`, `test/unit/modules/identity/staff-2fa-reset-args.spec.ts`, `test/integration/identity/staff-2fa-reset.spec.ts`, `test/integration/identity/staff-2fa-reset-races.spec.ts`
- Modify: `src/modules/identity/infra/better-auth/auth.cli-config.ts` (export `pool`), `package.json` (script), `test/integration/identity/auth-hooks.spec.ts` (ca S2-R75 M4)

**Interfaces:**
- Consumes: `StaffStepUp.factorState`, `revokeUserCredentials`, `STAFF_RESET_TX_ATTEMPTS`, `staffLacksFactorOf` (Task 5), `lockoutRowKeys` (Task 5), `hasAdminRole` (Task 4), `STAFF_RESET_TICKET_MAX_LENGTH` (Task 10), `AuthRequestState` (Task 6/8: `passwordWriteSubjects`, `setWriteFactors`), `enrolStaff`, `stepUp`, `STAFF_PASSWORD` (`test/support/staff.ts`), `startTcpProxy` (`test/support/tcp-proxy.ts`), `ReconcileSecurityNoticesHandler`, `Mailpit`.
- Produces:
  - `staff-2fa-reset.ts`: `STAFF_RESET_PASSWORD_BYTES = 18`, `STAFF_RESET_EXIT_OK = 0`, `STAFF_RESET_EXIT_NOT_COMMITTED = 1`, `STAFF_RESET_EXIT_COMMITTED = 2`, `type StaffResetExit = 0 | 1 | 2`, `type StaffResetArgs = { userId: string; ticket: string; forPromotion: boolean; passwordFile: string | undefined }`, `parseStaffResetArgs(argv: readonly string[]): { ok: true; args: StaffResetArgs } | { ok: false; message: string }`, `terminalProblem(args: StaffResetArgs, t: Pick<StaffResetTerminal, 'stdinIsTTY' | 'stdoutIsTTY'>): string | undefined`, `type StaffResetTerminal = { stdinIsTTY: boolean; stdoutIsTTY: boolean; confirm(prompt: string): Promise<string>; writeSecret(secret: string): Promise<void>; info(line: string): void }`, `type StaffResetSeams = { afterLockUser?(c: Sql): Promise<void>; afterUpsert?(c: Sql): Promise<void>; afterCommit?(): Promise<void> }`, `type StaffResetDeps = { auth: { $context: Promise<{ password: { hash(password: string): Promise<string> } }> }; pool: pg.Pool; log(level: 'warn' | 'error', entry: Record<string, unknown>, message: string): void; seams?: StaffResetSeams }`, `runStaffTwoFactorReset(args: StaffResetArgs, t: StaffResetTerminal, d: StaffResetDeps): Promise<StaffResetExit>`.
  - `auth.cli-config.ts`: `export const pool` (pool `auth_user` mà `auth` dùng).
  - Script `"identity:staff-2fa-reset": "node dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js"` (đúng spec §5.2; chạy trong image/sau `pnpm build`).

- [ ] **Step 1: Unit tham số (fail)**

`test/unit/modules/identity/staff-2fa-reset-args.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  parseStaffResetArgs,
  terminalProblem,
} from '../../../../src/modules/identity/infra/better-auth/staff-2fa-reset.js';

const ID = '0190e1c8-0000-7000-8000-0000000000a1';
const ok = (argv: string[]) => {
  const r = parseStaffResetArgs(argv);
  if (!r.ok) throw new Error(r.message);
  return r.args;
};

/** Spec SP3 §5.2 hàng CLI (r6 N6-3, N6-4): lỗi cách dùng không phụ thuộc env, không chạm DB. */
describe('identity:staff-2fa-reset arguments and terminal', () => {
  it('parses the required --user-id and --ticket, the optional --for-promotion and --password-file', () => {
    expect(ok(['--user-id', ID, '--ticket', 'SUP-42'])).toEqual({ userId: ID, ticket: 'SUP-42', forPromotion: false, passwordFile: undefined });
    expect(ok(['--user-id', ID, '--ticket', 'SUP-42', '--for-promotion', '--password-file', '/tmp/p'])).toEqual({
      userId: ID, ticket: 'SUP-42', forPromotion: true, passwordFile: '/tmp/p',
    });
  });
  it.each([
    [[ '--ticket', 'T' ], /--user-id is required/],
    [[ '--user-id', ID ], /--ticket is required/],
    [[ '--user-id', ID, '--ticket', '' ], /--ticket must be 1-128 printable characters/],
    [[ '--user-id', ID, '--ticket', 'x'.repeat(129) ], /--ticket must be 1-128 printable characters/],
    [[ '--user-id', ID, '--ticket', 'a\nb' ], /--ticket must be 1-128 printable characters/],
    [[ '--user-id', ID, '--ticket', 'T', '--yes' ], /Unknown option '--yes'/],
  ])('%j → refused before any DB access', (argv, message) => {
    const r = parseStaffResetArgs(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(message);
  });
  it.each([ID.toUpperCase(), ` ${ID}`, `{${ID}}`, ID.replaceAll('-', ''), 'not-a-uuid'])(
    'Review Focus 5: --user-id %j must be a canonical lowercase UUID',
    (userId) => {
      const r = parseStaffResetArgs(['--user-id', userId, '--ticket', 'T']);
      expect(r).toEqual({ ok: false, message: '--user-id must be a canonical lowercase UUID' });
    },
  );
  it('the confirmation is always interactive: no TTY on stdin → refused; stdout not a TTY needs --password-file', () => {
    const args = ok(['--user-id', ID, '--ticket', 'T']);
    expect(terminalProblem(args, { stdinIsTTY: false, stdoutIsTTY: true })).toMatch(/interactive terminal/);
    expect(terminalProblem(args, { stdinIsTTY: true, stdoutIsTTY: false })).toMatch(/--password-file/);
    expect(terminalProblem({ ...args, passwordFile: '/tmp/p' }, { stdinIsTTY: true, stdoutIsTTY: false })).toBeUndefined();
    expect(terminalProblem(args, { stdinIsTTY: true, stdoutIsTTY: true })).toBeUndefined();
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/identity/staff-2fa-reset-args.spec.ts`
Expected: FAIL (`staff-2fa-reset.js` không tồn tại).

- [ ] **Step 2: `staff-2fa-reset.ts`**

`src/modules/identity/infra/better-auth/staff-2fa-reset.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { z } from 'zod';
import { hasAdminRole } from '../../ports/identity-directory.js';
import { STAFF_RESET_TICKET_MAX_LENGTH } from '../../ports/security-notice-ledger.js';
import { lockoutRowKeys } from './login-lockout.js';
import { STAFF_RESET_TX_ATTEMPTS, revokeUserCredentials, type Sql } from './staff-step-up.js';

export const STAFF_RESET_PASSWORD_BYTES = 18;
export const STAFF_RESET_EXIT_OK = 0;
/** DB KHÔNG đổi (lỗi tham số, terminal, xác nhận; user đổi sau xác nhận; transaction lỗi/hết lượt thử, đã ROLLBACK). */
export const STAFF_RESET_EXIT_NOT_COMMITTED = 1;
/** DB CÓ THỂ đã đổi, mật khẩu tạm CHƯA được giao (kiểm sau commit thất bại, giao lỗi, COMMIT không rõ kết quả). */
export const STAFF_RESET_EXIT_COMMITTED = 2;
export type StaffResetExit = typeof STAFF_RESET_EXIT_OK | typeof STAFF_RESET_EXIT_NOT_COMMITTED | typeof STAFF_RESET_EXIT_COMMITTED;
type Mode = 'RESET' | 'PROMOTE';

export type StaffResetArgs = { userId: string; ticket: string; forPromotion: boolean; passwordFile: string | undefined };
export type StaffResetTerminal = {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  confirm(prompt: string): Promise<string>;
  writeSecret(secret: string): Promise<void>;
  /** stderr: hướng dẫn cho vận hành; không bao giờ mang secret. */
  info(line: string): void;
};
/** Seam cho test barrier (spec §18.3 S-22, S-24): production không truyền. */
export type StaffResetSeams = {
  afterLockUser?(c: Sql): Promise<void>;
  afterUpsert?(c: Sql): Promise<void>;
  afterCommit?(): Promise<void>;
};
export type StaffResetDeps = {
  auth: { $context: Promise<{ password: { hash(password: string): Promise<string> } }> };
  pool: pg.Pool;
  log(level: 'warn' | 'error', entry: Record<string, unknown>, message: string): void;
  seams?: StaffResetSeams;
};

/** Cùng luật `adminTargetUserId`: UUID ở dạng chữ thường chuẩn, không chuẩn hoá (marker/log mang đúng id; R8-S2). */
const CanonicalUuid = z.uuid().refine((v) => v === v.toLowerCase());
const PRINTABLE = /^[\x20-\x7E]+$/;
const TICKET_MESSAGE = `--ticket must be 1-${STAFF_RESET_TICKET_MAX_LENGTH} printable characters without line breaks`;

export function parseStaffResetArgs(
  argv: readonly string[],
): { ok: true; args: StaffResetArgs } | { ok: false; message: string } {
  let values: { 'user-id'?: string; ticket?: string; 'for-promotion'?: boolean; 'password-file'?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        'user-id': { type: 'string' },
        ticket: { type: 'string' },
        'for-promotion': { type: 'boolean' },
        'password-file': { type: 'string' },
      },
    }));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const userId = values['user-id'];
  const ticket = values.ticket;
  if (userId === undefined) return { ok: false, message: '--user-id is required' };
  if (!CanonicalUuid.safeParse(userId).success) return { ok: false, message: '--user-id must be a canonical lowercase UUID' };
  if (ticket === undefined) return { ok: false, message: '--ticket is required' };
  if (ticket.length < 1 || ticket.length > STAFF_RESET_TICKET_MAX_LENGTH || !PRINTABLE.test(ticket))
    return { ok: false, message: TICKET_MESSAGE };
  return {
    ok: true,
    args: { userId, ticket, forPromotion: values['for-promotion'] === true, passwordFile: values['password-file'] },
  };
}

/** Chạy TRƯỚC khi nạp config (lỗi cách dùng không phụ thuộc env). Không `--yes`: thao tác phá kính luôn hỏi lại. */
export function terminalProblem(
  args: StaffResetArgs,
  t: Pick<StaffResetTerminal, 'stdinIsTTY' | 'stdoutIsTTY'>,
): string | undefined {
  if (!t.stdinIsTTY) return 'this command needs an interactive terminal (docker compose run --rm, kubectl exec -it)';
  if (!t.stdoutIsTTY && args.passwordFile === undefined)
    return 'stdout is not a terminal: pass --password-file <path> so the temporary password does not reach a log';
  return undefined;
}

const PG_DEADLOCK = '40P01';
const PG_SERIALIZATION = '40001';
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
const errorClassOf = (err: unknown): string => (err instanceof Error ? err.constructor.name : typeof err);

type Subject = { email: string; role: string | null; hasFactor: boolean; apiKeys: number };
const READ_SUBJECT = `SELECT u.email, u.role,
    (u.two_factor_enabled OR EXISTS (SELECT 1 FROM auth.two_factor tf WHERE tf.user_id = u.id AND tf.verified)) AS has_factor,
    (SELECT count(*)::int FROM auth.apikey k WHERE k.reference_id = u.id) AS api_keys
  FROM auth."user" u WHERE u.id = $1`;
/** Bước 2, câu ĐẦU: khoá dòng user trước mọi câu ghi (thứ tự là bất biến, R7-C3). */
const LOCK_USER = `SELECT email, role FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`;
const UPSERT_CREDENTIAL = `INSERT INTO auth.account (account_id, provider_id, user_id, password, created_at, updated_at)
  VALUES ($1::uuid::text, 'credential', $1::uuid, $2, now(), now())
  ON CONFLICT (provider_id, account_id) DO UPDATE SET password = EXCLUDED.password, updated_at = EXCLUDED.updated_at
  WHERE auth.account.user_id = EXCLUDED.user_id RETURNING id`;
const DELETE_LOCKOUT = `DELETE FROM auth.login_attempts WHERE key = ANY($1::text[])
  OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS p(prefix) WHERE starts_with(key, p.prefix))`;
/** Bước 3 (r8): chỉ đọc hash và factor, chờ một câu ghi mật khẩu đang chạy trên dòng account (`FOR SHARE OF a`). */
const POST_COMMIT = `SELECT a.password,
    (u.two_factor_enabled OR EXISTS (SELECT 1 FROM auth.two_factor tf WHERE tf.user_id = u.id AND tf.verified)) AS has_factor
  FROM auth."user" u JOIN auth.account a ON a.user_id = u.id AND a.provider_id = 'credential' AND a.account_id = u.id::text
  WHERE u.id = $1 FOR SHARE OF a`;

class Refused extends Error {}
/** Lỗi trên chính câu COMMIT: không biết đã commit hay chưa (mất kết nối giữa chừng) → exit 2. */
class CommitOutcomeUnknown extends Error {}

/**
 * Lệnh vận hành reset 2FA nhân viên và nâng quyền (spec SP3 §9.7 (5), §5.2 hàng CLI; r8). Không đường HTTP; chạy được cả
 * khi không còn admin nào đăng nhập được. Mọi câu ghi nằm trong MỘT transaction (exit 1 = DB không đổi). Chế độ quyết
 * định ở bước 0 theo trạng thái nhân viên LÚC NÀY (R8-C1): nhân viên → RESET (xoá API key), user thường + `--for-promotion`
 * → PROMOTE (ghi role admin, giữ API key), user thường thiếu cờ → exit 1.
 */
export async function runStaffTwoFactorReset(
  args: StaffResetArgs,
  t: StaffResetTerminal,
  d: StaffResetDeps,
): Promise<StaffResetExit> {
  const usage = terminalProblem(args, t);
  if (usage) {
    t.info(`identity:staff-2fa-reset: ${usage}`);
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  const { rows } = await d.pool.query<{ email: string; role: string | null; has_factor: boolean; api_keys: number }>(READ_SUBJECT, [args.userId]);
  const row = rows[0];
  if (!row) {
    t.info('identity:staff-2fa-reset: no user with this id');
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  const subject: Subject = { email: row.email, role: row.role, hasFactor: row.has_factor, apiKeys: row.api_keys };
  const staff = hasAdminRole(subject.role);
  if (!staff && !args.forPromotion) {
    t.info('identity:staff-2fa-reset: the user is not platform staff; pass --for-promotion to promote them (the only supported promotion path)');
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  const mode: Mode = staff ? 'RESET' : 'PROMOTE';
  t.info(`user ${args.userId}: email ${subject.email}, role ${subject.role ?? '(none)'}, second factor ${subject.hasFactor ? 'present' : 'none'}`);
  t.info(`ticket ${args.ticket}, mode ${mode}, Better Auth API keys ${mode === 'RESET' ? 'to delete' : 'kept'}: ${subject.apiKeys}`);
  if ((await t.confirm('Type the user email to confirm: ')).trim() !== subject.email) {
    t.info('identity:staff-2fa-reset: the email does not match; nothing changed');
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  if (args.passwordFile !== undefined) {
    try {
      file = await open(args.passwordFile, 'wx', 0o600);
    } catch (err) {
      t.info(`identity:staff-2fa-reset: cannot create ${args.passwordFile} (${codeOf(err) ?? errorClassOf(err)}); it must not exist`);
      return STAFF_RESET_EXIT_NOT_COMMITTED;
    }
  }
  const dropFile = async () => {
    if (!file || args.passwordFile === undefined) return;
    await file.close().catch(() => undefined);
    await unlink(args.passwordFile).catch(() => undefined);
  };
  const password = randomBytes(STAFF_RESET_PASSWORD_BYTES).toString('base64url');
  const hash = await (await d.auth.$context).password.hash(password);
  let apiKeysDeleted: number;
  try {
    apiKeysDeleted = await commitReset(args, subject, mode, hash, d);
  } catch (err) {
    await dropFile();
    if (err instanceof CommitOutcomeUnknown) {
      t.info('identity:staff-2fa-reset: the connection was lost while COMMIT was in flight; run the same command again');
      return STAFF_RESET_EXIT_COMMITTED;
    }
    t.info(`identity:staff-2fa-reset: ${err instanceof Refused ? err.message : `transaction failed (${codeOf(err) ?? errorClassOf(err)})`}; nothing changed`);
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  await d.seams?.afterCommit?.();
  const raced = await postCommitCheck(args.userId, hash, d.pool);
  if (raced) {
    await dropFile();
    d.log('warn', { event: 'identity_staff_2fa_reset_raced', userId: args.userId, ticket: args.ticket, reason: raced }, 'staff 2FA reset committed but something changed right after; the temporary password was not delivered');
    t.info('identity:staff-2fa-reset: committed, but the password or a second factor changed right after; treat it as an incident and run the same command again');
    return STAFF_RESET_EXIT_COMMITTED;
  }
  try {
    if (file) {
      await file.writeFile(`${password}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
    } else await t.writeSecret(password);
  } catch (err) {
    await dropFile();
    t.info(`identity:staff-2fa-reset: committed, but the temporary password could not be delivered (${errorClassOf(err)}); run the same command again`);
    return STAFF_RESET_EXIT_COMMITTED;
  }
  d.log('warn', { event: 'identity_staff_2fa_reset', userId: args.userId, ticket: args.ticket, mode, apiKeysDeleted }, 'staff 2FA reset committed');
  t.info(`done: ${apiKeysDeleted} Better Auth API key(s) deleted`);
  return STAFF_RESET_EXIT_OK;
}

/** Bước 2: MỘT transaction, các câu theo đúng thứ tự spec §9.7 (5); `40P01`/`40001` → chạy lại (T-37, N5-5). */
async function commitReset(args: StaffResetArgs, subject: Subject, mode: Mode, hash: string, d: StaffResetDeps): Promise<number> {
  let last: unknown;
  for (let attempt = 1; attempt <= STAFF_RESET_TX_ATTEMPTS; attempt++) {
    const c = await d.pool.connect();
    let committing = false;
    try {
      await c.query('BEGIN');
      const locked = (await c.query<{ email: string; role: string | null }>(LOCK_USER, [args.userId])).rows[0];
      if (!locked || locked.email !== subject.email || hasAdminRole(locked.role) !== (mode === 'RESET'))
        throw new Refused('the user changed after you confirmed; run the command again to confirm the new state');
      await d.seams?.afterLockUser?.(c);
      await c.query(
        mode === 'PROMOTE'
          ? `UPDATE auth."user" SET two_factor_enabled = false, role = 'admin', updated_at = now() WHERE id = $1`
          : `UPDATE auth."user" SET two_factor_enabled = false, updated_at = now() WHERE id = $1`,
        [args.userId],
      );
      if ((await c.query(UPSERT_CREDENTIAL, [args.userId, hash])).rowCount !== 1)
        throw new Refused('the credential account row belongs to another user');
      await d.seams?.afterUpsert?.(c);
      const step = lockoutRowKeys({ kind: 'step-up', userId: args.userId });
      const signin = lockoutRowKeys({ kind: 'signin', email: subject.email });
      await c.query(DELETE_LOCKOUT, [[...step.exact, ...signin.exact], [...step.prefixes, ...signin.prefixes]]);
      const { apiKeysDeleted } = await revokeUserCredentials(c, args.userId, { apiKeys: mode === 'RESET' });
      await c.query(`INSERT INTO auth.security_notice (user_id, kind, ticket) VALUES ($1, 'operator_reset', $2)`, [args.userId, args.ticket]);
      committing = true;
      await c.query('COMMIT');
      return apiKeysDeleted;
    } catch (err) {
      if (committing) throw new CommitOutcomeUnknown('COMMIT outcome unknown', { cause: err });
      await c.query('ROLLBACK').catch(() => undefined);
      last = err;
      const code = codeOf(err);
      if (code !== PG_DEADLOCK && code !== PG_SERIALIZATION) throw err;
    } finally {
      c.release();
    }
  }
  throw last;
}

/** Bước 3 (r7 N7-4, r8 R8-C4): hàm của trạng thái đã commit; không đếm session/API key (hàng rào (9) gỡ tại nguồn). */
async function postCommitCheck(userId: string, hash: string, pool: pg.Pool): Promise<'password_changed' | 'factor_present' | undefined> {
  const r = (await pool.query<{ password: string | null; has_factor: boolean }>(POST_COMMIT, [userId])).rows[0];
  if (!r || r.password !== hash) return 'password_changed';
  if (r.has_factor) return 'factor_present';
  return undefined;
}
```
(`Error` nhận `{ cause }` từ ES2022; tsconfig của repo đã bật `lib` ES2022+.)

- [ ] **Step 3: Entry CLI, export pool, script**

`src/modules/identity/infra/better-auth/auth.cli-config.ts` — đổi `const pool = loadOrExplain(…)` thành `export const pool = loadOrExplain(…)` và thêm chú thích một dòng: `/** Spec SP3 §5.2 (r7 R7-C8): lệnh reset dùng CHÍNH pool này cho transaction của nó và đóng nó khi thoát. */`.

`src/modules/identity/infra/better-auth/staff-2fa-reset.cli.ts`:
```ts
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  STAFF_RESET_EXIT_NOT_COMMITTED,
  parseStaffResetArgs,
  runStaffTwoFactorReset,
  terminalProblem,
  type StaffResetTerminal,
} from './staff-2fa-reset.js';

/**
 * Entry mỏng của `pnpm identity:staff-2fa-reset` (spec SP3 §5.2 hàng CLI): kiểm tham số và terminal TRƯỚC khi nạp
 * `auth.cli-config.js` (import động: lỗi cách dùng không phụ thuộc env, không chạm DB), rồi đóng pool trên mọi đường thoát.
 * Log có cấu trúc là một dòng JSON trên stderr (process ngắn, không dựng Nest).
 */
const terminal: StaffResetTerminal = {
  stdinIsTTY: stdin.isTTY === true,
  stdoutIsTTY: stdout.isTTY === true,
  async confirm(prompt) {
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  },
  writeSecret: (secret) =>
    new Promise<void>((resolve, reject) => stdout.write(`${secret}\n`, (err) => (err ? reject(err) : resolve()))),
  info: (line) => {
    stderr.write(`${line}\n`);
  },
};

const parsed = parseStaffResetArgs(process.argv.slice(2));
if (!parsed.ok) {
  terminal.info(`identity:staff-2fa-reset: ${parsed.message}`);
  process.exitCode = STAFF_RESET_EXIT_NOT_COMMITTED;
} else {
  const problem = terminalProblem(parsed.args, terminal);
  if (problem) {
    terminal.info(`identity:staff-2fa-reset: ${problem}`);
    process.exitCode = STAFF_RESET_EXIT_NOT_COMMITTED;
  } else {
    const { auth, pool } = await import('./auth.cli-config.js');
    try {
      process.exitCode = await runStaffTwoFactorReset(parsed.args, terminal, {
        auth,
        pool,
        log: (level, entry, message) => {
          stderr.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...entry, msg: message })}\n`);
        },
      });
    } finally {
      await pool.end();
    }
  }
}
```
`package.json` — `scripts` thêm (cạnh `auth:create-admin`):
```json
    "identity:staff-2fa-reset": "node dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js",
```

Run: `pnpm vitest run --project unit test/unit/modules/identity/staff-2fa-reset-args.spec.ts`
Expected: PASS.

- [ ] **Step 4: Integration S-22 (logic thật trên DB thật)**

`test/integration/identity/staff-2fa-reset.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { URI, type TOTP } from 'otpauth';
import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReconcileSecurityNoticesHandler } from '../../../src/modules/identity/application/reconcile-security-notices.handler.js';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { LOGIN_LOCKOUT, LockoutBlockedError, lockoutRowKeys, type LoginLockout } from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import {
  STAFF_RESET_EXIT_COMMITTED,
  STAFF_RESET_EXIT_NOT_COMMITTED,
  STAFF_RESET_EXIT_OK,
  runStaffTwoFactorReset,
  type StaffResetArgs,
  type StaffResetSeams,
  type StaffResetTerminal,
} from '../../../src/modules/identity/infra/better-auth/staff-2fa-reset.js';
import { AuthClient } from '../../support/auth-client.js';
import { getInfra } from '../../support/infra.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { Mailpit } from '../../support/mailpit.js';
import { STAFF_PASSWORD, enrolStaff, stepUp, type EnrolledStaff } from '../../support/staff.js';

const STALE = "interval '1 hour'";
type Logged = { level: string; entry: Record<string, unknown>; message: string };

describe('identity:staff-2fa-reset on the real database (spec SP3 §9.7 (5), S-22)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  let pool: pg.Pool;
  let lockout: LoginLockout;
  const logs: Logged[] = [];
  const deps = (seams?: StaffResetSeams) => ({
    auth,
    pool,
    seams,
    log: (level: 'warn' | 'error', entry: Record<string, unknown>, message: string) => logs.push({ level, entry, message }),
  });
  const terminal = (o: { answer?: string; stdinIsTTY?: boolean; stdoutIsTTY?: boolean; failWrite?: boolean } = {}) => {
    const secrets: string[] = [];
    const lines: string[] = [];
    const t: StaffResetTerminal = {
      stdinIsTTY: o.stdinIsTTY ?? true,
      stdoutIsTTY: o.stdoutIsTTY ?? true,
      confirm: async () => o.answer ?? '',
      writeSecret: async (s) => {
        if (o.failWrite) throw new Error('stdout closed');
        secrets.push(s);
      },
      info: (l) => lines.push(l),
    };
    return { t, secrets, lines };
  };
  const args = (userId: string, o: Partial<StaffResetArgs> = {}): StaffResetArgs => ({
    userId, ticket: 'SUP-1', forPromotion: false, passwordFile: undefined, ...o,
  });
  const emailOf = async (id: string) => (await ownerQuery<{ email: string }>(`SELECT email FROM auth."user" WHERE id = $1`, [id]))[0]!.email;
  /** Ảnh chụp mọi dòng auth của user (exit 1 = DB không đổi). */
  const snapshot = async (id: string) => ({
    user: await ownerQuery(`SELECT role, two_factor_enabled FROM auth."user" WHERE id = $1`, [id]),
    accounts: await ownerQuery(`SELECT provider_id, password FROM auth.account WHERE user_id = $1 ORDER BY provider_id`, [id]),
    factors: await ownerQuery(`SELECT id FROM auth.two_factor WHERE user_id = $1`, [id]),
    sessions: await ownerQuery(`SELECT id FROM auth.session WHERE user_id = $1 ORDER BY id`, [id]),
    keys: await ownerQuery(`SELECT id FROM auth.apikey WHERE reference_id = $1 ORDER BY id`, [id]),
    verification: await ownerQuery(`SELECT identifier FROM auth.verification WHERE value = $1 ORDER BY identifier`, [id]),
    notices: await ownerQuery(`SELECT kind, ticket FROM auth.security_notice WHERE user_id = $1 ORDER BY created_at, id`, [id]),
  });
  /** Nhân viên đầy đủ: factor thật, hai session, thiết bị tin cậy, token đặt lại còn hạn, liên kết IdP, API key, lockout. */
  const richStaff = async (): Promise<EnrolledStaff & { otherUserKey: string }> => {
    const s = await enrolStaff(app);
    await ownerQuery(`INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now())`, [randomUUID(), s.userId]);
    await ownerQuery(
      `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('trust-device-' || $1, $1, now() + interval '1 day'), ('reset-password:' || $2, $1, now() + interval '1 hour')`,
      [s.userId, randomUUID()],
    );
    await ownerQuery(`INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, 'google', $1, now())`, [s.userId]);
    await ownerQuery(`INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now()), ('default', $1, $3, now(), now())`, [s.userId, randomUUID(), randomUUID()]);
    for (const scope of [{ kind: 'signin' as const, email: s.email }, { kind: 'step-up' as const, userId: s.userId }])
      for (let i = 0; i < 12; i++) await lockout.guard(scope).catch((e: unknown) => { if (!(e instanceof LockoutBlockedError)) throw e; });
    const other = `other-${randomUUID()}@example.test`;
    await lockout.guard({ kind: 'signin', email: other });
    return { ...s, otherUserKey: other };
  };
  beforeAll(async () => {
    app = await startIdentityApp();
    auth = app.get<AuthInstance>(BETTER_AUTH);
    pool = app.get<pg.Pool>(AUTH_POOL);
    lockout = app.get<LoginLockout>(LOGIN_LOCKOUT);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('RESET of staff with everything: exit 0, one secret, every credential removed, one operator_reset marker with the ticket; mails go out; the temp password signs in; enable → step-up → /admin/* and /change-password work', async () => {
    const s = await richStaff();
    const mail = new Mailpit(getInfra().mailpit.apiUrl);
    const since = await mail.now();
    const { t, secrets, lines } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId, { ticket: 'SUP-22' }), t, deps())).toBe(STAFF_RESET_EXIT_OK);
    expect(secrets).toHaveLength(1);
    const [temp] = secrets;
    expect(lines.join('\n')).not.toContain(temp);
    expect(JSON.stringify(logs)).not.toContain(temp);
    expect(logs.at(-1)).toMatchObject({ level: 'warn', entry: { event: 'identity_staff_2fa_reset', userId: s.userId, ticket: 'SUP-22', mode: 'RESET', apiKeysDeleted: 2 } });
    const after = await snapshot(s.userId);
    expect(after.user).toEqual([{ role: 'admin', two_factor_enabled: false }]);
    expect(after.accounts.map((a) => a.provider_id)).toEqual(['credential']);
    expect([after.factors, after.sessions, after.keys, after.verification]).toEqual([[], [], [], []]);
    expect(after.notices.filter((n) => n.kind === 'operator_reset')).toEqual([{ kind: 'operator_reset', ticket: 'SUP-22' }]);
    const lockKeys = (await ownerQuery<{ key: string }>(`SELECT key FROM auth.login_attempts`)).map((r) => r.key);
    const covered = (scope: Parameters<typeof lockoutRowKeys>[0]) => {
      const k = lockoutRowKeys(scope);
      return lockKeys.filter((x) => k.exact.includes(x) || k.prefixes.some((p) => x.startsWith(p)));
    };
    expect([...covered({ kind: 'signin', email: s.email }), ...covered({ kind: 'step-up', userId: s.userId })]).toEqual([]);
    expect(covered({ kind: 'signin', email: s.otherUserKey })).not.toEqual([]); // bộ đếm của user khác còn nguyên
    await ownerQuery(`UPDATE auth.security_notice SET created_at = created_at - ${STALE} WHERE user_id = $1`, [s.userId]);
    await app.get(ReconcileSecurityNoticesHandler).handle({
      payload: {}, meta: {}, jobId: v7(), attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log: new Logger('t'),
    });
    await mail.waitFor(s.email, { subject: /Your password and two-factor authentication were reset/, after: since });
    await mail.waitFor(s.email, { subject: /Two-factor authentication turned off/, after: since });
    expect((await new AuthClient(app.getHttpServer()).signIn(s.email, STAFF_PASSWORD)).status).toBe(401);
    const c = new AuthClient(app.getHttpServer());
    expect((await c.signIn(s.email, temp!)).status).toBe(200);
    const en = await c.request('post', '/api/auth/two-factor/enable', { body: { password: temp } });
    expect(en.status).toBe(200);
    const totp = URI.parse(String(en.body.totpURI)) as TOTP;
    expect((await c.request('post', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } })).status).toBe(200);
    const fresh = { ...s, client: c, totp };
    expect((await stepUp(fresh)).status).toBe(200);
    expect((await c.request('get', '/api/auth/admin/list-users')).status).toBe(200);
    expect((await c.request('post', '/api/auth/change-password', { body: { currentPassword: temp, newPassword: 'a new staff passphrase 22' } })).status).toBe(200);
  });
  it('N6-1: right after the command, every HTTP password path refuses (reset 400, change 403 second_factor_required, admin set 403 forbidden) and the temporary password still signs in', async () => {
    const s = await enrolStaff(app);
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(STAFF_RESET_EXIT_OK);
    const temp = secrets[0]!;
    const token = randomUUID().replaceAll('-', '');
    await ownerQuery(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`reset-password:${token}`, s.userId]);
    const anon = new AuthClient(app.getHttpServer());
    expect((await anon.request('post', '/api/auth/reset-password', { body: { token, newPassword: 'attacker passphrase 1' }, cookie: false })).status).toBe(400);
    const c = new AuthClient(app.getHttpServer());
    expect((await c.signIn(s.email, temp)).status).toBe(200);
    expect((await c.request('post', '/api/auth/change-password', { body: { currentPassword: temp, newPassword: 'x'.repeat(20) } })).body.code).toBe('second_factor_required');
    const admin = await enrolStaff(app);
    await stepUp(admin);
    expect((await admin.client.request('post', '/api/auth/admin/set-user-password', { body: { userId: s.userId, newPassword: 'y'.repeat(20) } })).body.code).toBe('forbidden');
    expect((await new AuthClient(app.getHttpServer()).signIn(s.email, temp)).status).toBe(200);
  });
  it('last admin, no factor, no session: the command still restores access (N5-4)', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(`DELETE FROM auth.session WHERE user_id = $1`, [s.userId]);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [s.userId]);
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id <> $1 AND role IS NOT NULL AND role <> 'user'`, [s.userId]);
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(STAFF_RESET_EXIT_OK);
    const c = new AuthClient(app.getHttpServer());
    expect((await c.signIn(s.email, secrets[0]!)).status).toBe(200);
    const en = await c.request('post', '/api/auth/two-factor/enable', { body: { password: secrets[0] } });
    const totp = URI.parse(String(en.body.totpURI)) as TOTP;
    await c.request('post', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } });
    expect((await stepUp({ ...s, client: c, totp })).status).toBe(200);
    expect((await c.request('get', '/api/auth/admin/list-users')).status).toBe(200);
  });
  it('PROMOTE (N6-5): a regular user with 2FA, sessions and an IdP link → role admin, everything removed in ONE transaction (a concurrent reader never sees admin with the old factor); API keys kept', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    await ownerQuery(`INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, 'google', $1, now())`, [u.userId]);
    await ownerQuery(`INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`, [u.userId, randomUUID()]);
    const seen: { role: string | null; factors: number }[] = [];
    const seams: StaffResetSeams = {
      afterUpsert: async () => {
        // Kết nối khác đọc trong lúc transaction mở: vẫn là bản trước lệnh (role thường, factor cũ).
        seen.push(...(await ownerQuery<{ role: string | null; factors: number }>(
          `SELECT u.role, (SELECT count(*)::int FROM auth.two_factor f WHERE f.user_id = u.id) AS factors FROM auth."user" u WHERE u.id = $1`, [u.userId])));
      },
    };
    const { t } = terminal({ answer: u.email });
    expect(await runStaffTwoFactorReset(args(u.userId, { forPromotion: true }), t, deps(seams))).toBe(STAFF_RESET_EXIT_OK);
    expect(seen).toEqual([{ role: null, factors: 1 }]);
    const after = await snapshot(u.userId);
    expect(after.user).toEqual([{ role: 'admin', two_factor_enabled: false }]);
    expect([after.factors, after.sessions, after.accounts.map((a) => a.provider_id), after.keys.length]).toEqual([[], [], ['credential'], 1]);
    expect(logs.at(-1)?.entry).toMatchObject({ mode: 'PROMOTE', apiKeysDeleted: 0 });
  });
  it('an IdP-only staff member (no credential account) gets a credential account', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(`DELETE FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`, [s.userId]);
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(STAFF_RESET_EXIT_OK);
    expect((await new AuthClient(app.getHttpServer()).signIn(s.email, secrets[0]!)).status).toBe(200);
  });
  it('arguments and terminal (N6-3, N6-4): each refusal is exit 1 with the DB unchanged and no file left', async () => {
    const s = await richStaff();
    const u = await enrolStaff(app, { role: 'user' });
    const before = await snapshot(s.userId);
    const dir = await mkdtemp(join(tmpdir(), 'staff-reset-'));
    try {
      expect(await runStaffTwoFactorReset(args(u.userId), terminal({ answer: u.email }).t, deps())).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await runStaffTwoFactorReset(args(s.userId), terminal({ answer: 'someone@else.test' }).t, deps())).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await runStaffTwoFactorReset(args(s.userId), terminal({ answer: s.email, stdinIsTTY: false }).t, deps())).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await runStaffTwoFactorReset(args(s.userId), terminal({ answer: s.email, stdoutIsTTY: false }).t, deps())).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await runStaffTwoFactorReset(args(randomUUID()), terminal().t, deps())).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      const existing = join(dir, 'exists');
      await writeFile(existing, 'keep');
      expect(await runStaffTwoFactorReset(args(s.userId, { passwordFile: existing }), terminal({ answer: s.email, stdoutIsTTY: false }).t, deps())).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await readFile(existing, 'utf8')).toBe('keep');
      expect(await snapshot(s.userId)).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('--password-file without a TTY on stdout: exit 0, file mode 0600 holds the password, nothing on stdout', async () => {
    const s = await enrolStaff(app);
    const dir = await mkdtemp(join(tmpdir(), 'staff-reset-'));
    try {
      const file = join(dir, 'pw');
      const { t, secrets } = terminal({ answer: s.email, stdoutIsTTY: false });
      expect(await runStaffTwoFactorReset(args(s.userId, { passwordFile: file }), t, deps())).toBe(STAFF_RESET_EXIT_OK);
      expect(secrets).toEqual([]);
      const temp = (await readFile(file, 'utf8')).trim();
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await new AuthClient(app.getHttpServer()).signIn(s.email, temp)).status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('R8-S6: exit 1 means the DB did not change — a failure right after the password upsert, and three deadlocks in a row', async () => {
    const s = await richStaff();
    const before = await snapshot(s.userId);
    const dir = await mkdtemp(join(tmpdir(), 'staff-reset-'));
    try {
      const file = join(dir, 'pw');
      const boom: StaffResetSeams = { afterUpsert: async () => { throw new Error('seam'); } };
      expect(await runStaffTwoFactorReset(args(s.userId, { passwordFile: file }), terminal({ answer: s.email }).t, deps(boom))).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      const deadlock: StaffResetSeams = { afterUpsert: async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); } };
      expect(await runStaffTwoFactorReset(args(s.userId), terminal({ answer: s.email }).t, deps(deadlock))).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
      expect(await snapshot(s.userId)).toEqual(before);
      expect((await new AuthClient(app.getHttpServer()).signIn(s.email, STAFF_PASSWORD)).body.twoFactorRedirect).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('the user changes between the confirmation and the transaction (role, email) → exit 1, DB unchanged', async () => {
    const s = await enrolStaff(app);
    const before = await snapshot(s.userId);
    const t = terminal({ answer: s.email }).t;
    const changing: StaffResetTerminal = {
      ...t,
      confirm: async () => {
        await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE id = $1`, [s.userId]);
        return s.email;
      },
    };
    expect(await runStaffTwoFactorReset(args(s.userId), changing, deps())).toBe(STAFF_RESET_EXIT_NOT_COMMITTED);
    expect((await snapshot(s.userId)).factors).toEqual(before.factors);
    expect((await snapshot(s.userId)).notices).toEqual(before.notices);
  });
  it('N7-4: the hash or the factor changes after the commit → exit 2 with the reason, no secret delivered, file removed; the same command again → exit 0', async () => {
    const s = await enrolStaff(app);
    const hashChange: StaffResetSeams = {
      afterCommit: async () => {
        await ownerQuery(`UPDATE auth.account SET password = 'raced' WHERE user_id = $1 AND provider_id = 'credential'`, [s.userId]);
      },
    };
    const a = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), a.t, deps(hashChange))).toBe(STAFF_RESET_EXIT_COMMITTED);
    expect(a.secrets).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ entry: { event: 'identity_staff_2fa_reset_raced', reason: 'password_changed', ticket: 'SUP-1' } });
    const factorOn: StaffResetSeams = {
      afterCommit: async () => {
        await ownerQuery(`UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`, [s.userId]);
      },
    };
    expect(await runStaffTwoFactorReset(args(s.userId), terminal({ answer: s.email }).t, deps(factorOn))).toBe(STAFF_RESET_EXIT_COMMITTED);
    expect(logs.at(-1)?.entry).toMatchObject({ reason: 'factor_present' });
    const again = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), again.t, deps())).toBe(STAFF_RESET_EXIT_OK);
    expect((await new AuthClient(app.getHttpServer()).signIn(s.email, again.secrets[0]!)).status).toBe(200);
  });
  it('R7-C5/R8-C1: delivery fails after a --for-promotion commit → exit 2; the same command (still --for-promotion) runs as RESET: exit 0, two markers, API keys deleted', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    await ownerQuery(`INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`, [u.userId, randomUUID()]);
    expect(await runStaffTwoFactorReset(args(u.userId, { forPromotion: true }), terminal({ answer: u.email, failWrite: true }).t, deps())).toBe(STAFF_RESET_EXIT_COMMITTED);
    expect(await runStaffTwoFactorReset(args(u.userId, { forPromotion: true }), terminal({ answer: u.email }).t, deps())).toBe(STAFF_RESET_EXIT_OK);
    const after = await snapshot(u.userId);
    expect([after.user[0], after.keys, after.notices.filter((n) => n.kind === 'operator_reset').length]).toEqual([{ role: 'admin', two_factor_enabled: false }, [], 2]);
  });
  it('R8-C1: after an attacker won T-42 (other password, a verified factor, an API key, a session), the same command runs as RESET and removes all of it', async () => {
    const u = await enrolStaff(app, { role: 'user' });
    expect(await runStaffTwoFactorReset(args(u.userId, { forPromotion: true }), terminal({ answer: u.email }).t, deps())).toBe(STAFF_RESET_EXIT_OK);
    await ownerQuery(`UPDATE auth.account SET password = 'attacker' WHERE user_id = $1 AND provider_id = 'credential'`, [u.userId]);
    await ownerQuery(`INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('a', 'a', $1, true)`, [u.userId]);
    await ownerQuery(`UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`, [u.userId]);
    await ownerQuery(`INSERT INTO auth.apikey (config_id, reference_id, key, created_at, updated_at) VALUES ('default', $1, $2, now(), now())`, [u.userId, randomUUID()]);
    await ownerQuery(`INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now())`, [randomUUID(), u.userId]);
    const again = terminal({ answer: u.email });
    expect(await runStaffTwoFactorReset(args(u.userId, { forPromotion: true }), again.t, deps())).toBe(STAFF_RESET_EXIT_OK);
    const after = await snapshot(u.userId);
    expect([after.factors, after.keys, after.sessions]).toEqual([[], [], []]);
    expect((await new AuthClient(app.getHttpServer()).signIn(u.email, again.secrets[0]!)).status).toBe(200);
  });
  it('twice in a row: the second run is exit 0 too, same end state plus one marker', async () => {
    const s = await enrolStaff(app);
    expect(await runStaffTwoFactorReset(args(s.userId), terminal({ answer: s.email }).t, deps())).toBe(STAFF_RESET_EXIT_OK);
    expect(await runStaffTwoFactorReset(args(s.userId), terminal({ answer: s.email }).t, deps())).toBe(STAFF_RESET_EXIT_OK);
    expect((await snapshot(s.userId)).notices.filter((n) => n.kind === 'operator_reset')).toHaveLength(2);
  });
  it('N6-2: an IdP session that drained the step-up lockout cannot block the factor enrolment after the command', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(`INSERT INTO auth.account (account_id, provider_id, user_id, updated_at) VALUES ($1, 'google', $1, now())`, [s.userId]);
    for (let i = 0; i < 12; i++) await s.client.request('post', '/api/auth/two-factor/verify-totp', { body: { code: '000000' } });
    expect((await stepUp(s)).status).toBe(429);
    const { t, secrets } = terminal({ answer: s.email });
    expect(await runStaffTwoFactorReset(args(s.userId), t, deps())).toBe(STAFF_RESET_EXIT_OK);
    expect(await ownerQuery(`SELECT 1 FROM auth.account WHERE user_id = $1 AND provider_id = 'google'`, [s.userId])).toEqual([]);
    const c = new AuthClient(app.getHttpServer());
    await c.signIn(s.email, secrets[0]!);
    const en = await c.request('post', '/api/auth/two-factor/enable', { body: { password: secrets[0] } });
    const totp = URI.parse(String(en.body.totpURI)) as TOTP;
    expect((await c.request('post', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } })).status).toBe(200);
  });
  it('R7-C8: the real CLI entry without a TTY exits 1 before touching the database and leaves the process on its own (no hang)', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js', '--user-id', randomUUID(), '--ticket', 'T'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    expect([r.status, r.stderr]).toEqual([1, expect.stringContaining('needs an interactive terminal')]);
  });
});
```
(Ca cuối dùng `dist/` của `pnpm build` ở Step 6; process con không có TTY nên dừng ở `terminalProblem`, trước `import()` của config: chứng minh "lỗi cách dùng không chạm DB". Ca "process thoát không cần `process.exit`" với một user thật cần TTY giả; phần đóng pool được chứng minh bằng `finally { await pool.end() }` của entry và bằng việc ca này không treo tới `timeout`.)

- [ ] **Step 5: Integration race và barrier (S-24, luật (7) lúc ghi, hàng rào (9), COMMIT không rõ kết quả)**

`test/integration/identity/staff-2fa-reset-races.spec.ts`:
```ts
import { type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { AuthRequestState } from '../../../src/modules/identity/infra/better-auth/auth-request-state.js';
import {
  STAFF_RESET_EXIT_COMMITTED,
  STAFF_RESET_EXIT_OK,
  runStaffTwoFactorReset,
  type StaffResetSeams,
} from '../../../src/modules/identity/infra/better-auth/staff-2fa-reset.js';
import { StaffStepUp } from '../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import type { Sql } from '../../../src/modules/identity/infra/better-auth/staff-step-up.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { getInfra } from '../../support/infra.js';
import { STAFF_PASSWORD, enrolStaff, stepUp } from '../../support/staff.js';
import { startTcpProxy } from '../../support/tcp-proxy.js';

const RACE_ROUNDS = 50;
const POLL_MS = 20;
const DEADLINE_MS = 8_000;
const NEW_PASSWORD = 'attacker chosen passphrase 1';

/** Một cổng: test mở cổng, code tới cổng thì báo `arrived` rồi chờ `open()`. */
class Gate {
  private release!: () => void;
  readonly opened = new Promise<void>((r) => (this.release = r));
  private arrive!: () => void;
  readonly arrived = new Promise<void>((r) => (this.arrive = r));
  async pass(): Promise<void> {
    this.arrive();
    await this.opened;
  }
  open(): void {
    this.release();
  }
}
/**
 * Seam của test (spec §18.3 S-22 "seam giữ handler"): request state CỦA CHÍNH app (provider `AuthRequestState`) chờ ở đúng
 * điểm. `writeGate`: lớp chặn trước câu ghi đọc subject (TRƯỚC câu khoá đọc); `afterGuardGate`: lớp chặn đã ghi factor (SAU
 * kiểm, TRƯỚC câu UPDATE). Không cổng nào mở thì hành vi y như production.
 */
class GatedState extends AuthRequestState {
  writeGate: Gate | undefined;
  afterGuardGate: Gate | undefined;
  override async passwordWriteSubjects(): Promise<readonly string[] | null> {
    const g = this.writeGate;
    this.writeGate = undefined;
    if (g) await g.pass();
    return super.passwordWriteSubjects();
  }
  override async setWriteFactors(m: ReadonlyMap<string, string | null>): Promise<void> {
    await super.setWriteFactors(m);
    const g = this.afterGuardGate;
    this.afterGuardGate = undefined;
    if (g) await g.pass();
  }
}

describe('reset command races (spec SP3 §9.7 (5), T-37/S-24, T-42, T-43)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  let pool: pg.Pool;
  const state = new GatedState();
  const deps = (seams?: StaffResetSeams, p: pg.Pool = pool) => ({ auth, pool: p, seams, log: () => undefined });
  const term = (answer: string) => ({
    stdinIsTTY: true, stdoutIsTTY: true, confirm: async () => answer, writeSecret: async () => undefined, info: () => undefined,
  });
  /** Chờ tới khi một backend bị `pid` chặn (trực tiếp), không ngủ cố định. */
  const waitBlockedBy = async (pid: number) => {
    const until = Date.now() + DEADLINE_MS;
    for (;;) {
      const [r] = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
      if ((r?.n ?? 0) > 0) return;
      if (Date.now() > until) throw new Error('nothing queued behind the reset transaction');
      await new Promise((ok) => setTimeout(ok, POLL_MS));
    }
  };
  const pidOf = async (c: Sql) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const regularWithPassword = async () => {
    const c = new AuthClient(app.getHttpServer());
    const email = `race-${randomUUID()}@example.test`;
    await c.signUp(email, STAFF_PASSWORD);
    await ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
    await c.signIn(email, STAFF_PASSWORD);
    const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    return { client: c, email, userId: row!.id };
  };
  beforeAll(async () => {
    app = await startIdentityApp({
      configure: (b) => b.overrideProvider(AuthRequestState).useValue(state),
    });
    auth = app.get<AuthInstance>(BETTER_AUTH);
    pool = app.get<pg.Pool>(AUTH_POOL);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it.each(['/reset-password', '/change-password', '/admin/set-user-password'])(
    'R8-S1 %s: the before-hook passes while the user is regular, --for-promotion commits, then the write is refused at write time; the temporary password survives, no new session',
    async (path) => {
      const u = await regularWithPassword();
      // Chuẩn bị mọi thứ TRƯỚC khi đặt cổng: chỉ câu ghi mật khẩu của request đích được đi qua cổng.
      const admin = path === '/admin/set-user-password' ? await enrolStaff(app) : undefined;
      if (admin) expect((await stepUp(admin)).status).toBe(200);
      const token = randomUUID().replaceAll('-', '');
      await ownerQuery(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`reset-password:${token}`, u.userId]);
      const gate = new Gate();
      state.writeGate = gate;
      const inFlight =
        path === '/reset-password'
          ? new AuthClient(app.getHttpServer()).request('post', `/api/auth${path}`, { body: { token, newPassword: NEW_PASSWORD }, cookie: false })
          : path === '/change-password'
            ? u.client.request('post', `/api/auth${path}`, { body: { currentPassword: STAFF_PASSWORD, newPassword: NEW_PASSWORD } })
            : admin!.client.request('post', `/api/auth${path}`, { body: { userId: u.userId, newPassword: NEW_PASSWORD } });
      await gate.arrived;
      let secret = '';
      const t = { ...term(u.email), writeSecret: async (s: string) => { secret = s; } };
      expect(await runStaffTwoFactorReset({ userId: u.userId, ticket: 'R8-S1', forPromotion: true, passwordFile: undefined }, t, deps())).toBe(STAFF_RESET_EXIT_OK);
      gate.open();
      const r = await inFlight;
      const expected = { '/reset-password': [400, 'invalid_or_expired_token'], '/change-password': [403, 'second_factor_required'], '/admin/set-user-password': [403, 'forbidden'] } as const;
      expect([r.status, r.body.code]).toEqual(expected[path as keyof typeof expected]);
      expect((await new AuthClient(app.getHttpServer()).signIn(u.email, secret)).status).toBe(200);
      expect((await new AuthClient(app.getHttpServer()).signIn(u.email, NEW_PASSWORD)).status).toBe(401);
    },
  );
  it('T-42 (9)(iv): the write slips past the pre-write guard and lands after the commit → the fence neutralizes every credential; the command then reports password_changed (exit 2); a rerun is exit 0', async () => {
    const u = await regularWithPassword();
    const gate = new Gate();
    state.afterGuardGate = gate;
    const token = randomUUID().replaceAll('-', '');
    await ownerQuery(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [`reset-password:${token}`, u.userId]);
    const inFlight = new AuthClient(app.getHttpServer()).request('post', '/api/auth/reset-password', { body: { token, newPassword: NEW_PASSWORD }, cookie: false });
    await gate.arrived;
    const seams: StaffResetSeams = {
      afterCommit: async () => {
        gate.open();
        await inFlight;
      },
    };
    expect(await runStaffTwoFactorReset({ userId: u.userId, ticket: 'T-42', forPromotion: true, passwordFile: undefined }, term(u.email), deps(seams))).toBe(STAFF_RESET_EXIT_COMMITTED);
    const r = await inFlight;
    expect(r.status).toBe(400);
    expect(await ownerQuery(`SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`, [u.userId])).toEqual([{ password: null }]);
    expect(await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [u.userId])).toEqual([]);
    let secret = '';
    expect(await runStaffTwoFactorReset({ userId: u.userId, ticket: 'T-42b', forPromotion: false, passwordFile: undefined }, { ...term(u.email), writeSecret: async (s) => { secret = s; } }, deps())).toBe(STAFF_RESET_EXIT_OK);
    expect((await new AuthClient(app.getHttpServer()).signIn(u.email, secret)).status).toBe(200);
  });
  it('T-43: a sign-in with the OLD password that read the hash before the commit is fenced after it (session deleted, 401 like a wrong password, no Set-Cookie)', async () => {
    const s = await enrolStaff(app);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [s.userId]);
    await ownerQuery(`UPDATE auth."user" SET two_factor_enabled = false WHERE id = $1`, [s.userId]);
    let signIn: Promise<{ status: number; headers: Record<string, unknown> }> | undefined;
    const seams: StaffResetSeams = {
      afterLockUser: async (c) => {
        signIn = new AuthClient(app.getHttpServer()).signIn(s.email, STAFF_PASSWORD);
        await waitBlockedBy(await pidOf(c)); // hàng rào (FOR SHARE) xếp hàng sau khoá của lệnh
      },
    };
    expect(await runStaffTwoFactorReset({ userId: s.userId, ticket: 'T-43', forPromotion: false, passwordFile: undefined }, term(s.email), deps(seams))).toBe(STAFF_RESET_EXIT_OK);
    const r = await signIn!;
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(await ownerQuery(`SELECT 1 FROM auth.session WHERE user_id = $1`, [s.userId])).toEqual([]);
  });
  it('T-43: /api-key/create by a session from before the command, held behind the transaction → the key is removed, 403, no secret', async () => {
    const s = await enrolStaff(app);
    let created: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    const seams: StaffResetSeams = {
      afterLockUser: async (c) => {
        created = s.client.request('post', '/api/auth/api-key/create', { body: { name: 'during reset' } });
        await waitBlockedBy(await pidOf(c));
      },
    };
    expect(await runStaffTwoFactorReset({ userId: s.userId, ticket: 'T-43b', forPromotion: false, passwordFile: undefined }, term(s.email), deps(seams))).toBe(STAFF_RESET_EXIT_OK);
    const r = await created!;
    // Plugin đã đọc session (còn sống trước commit) và ghi key; hàng rào (9)(iii) chờ lệnh commit rồi thấy nhân viên chưa có
    // factor → xoá key, 403, không secret.
    expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
    expect(r.body.key).toBeUndefined();
    expect(await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [s.userId])).toEqual([]);
  });
  it(`S-24 (T-37): reset transaction ∥ step-up mark of the same staff ×${RACE_ROUNDS} → no mark after the commit; a deadlock only ever hits one side`, async () => {
    const stepUp = new StaffStepUp(pool);
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const s = await enrolStaff(app);
      const [f] = await ownerQuery<{ id: string }>(`SELECT id FROM auth.two_factor WHERE user_id = $1`, [s.userId]);
      const [sess] = await ownerQuery<{ id: string }>(`SELECT id FROM auth.session WHERE user_id = $1 LIMIT 1`, [s.userId]);
      const [reset, mark] = await Promise.allSettled([
        runStaffTwoFactorReset({ userId: s.userId, ticket: `S24-${i}`, forPromotion: false, passwordFile: undefined }, term(s.email), deps()),
        stepUp.writeMark({ sessionId: sess!.id, factorId: f!.id, method: 'totp' }),
      ]);
      expect(reset).toEqual({ status: 'fulfilled', value: STAFF_RESET_EXIT_OK });
      expect(mark.status).toBe('fulfilled');
      expect(await ownerQuery(`SELECT 1 FROM auth.session_second_factor m JOIN auth.session x ON x.id = m.session_id WHERE x.user_id = $1`, [s.userId])).toEqual([]);
    }
  }, 180_000);
  it('the connection drops while COMMIT is in flight → exit 2 (outcome unknown); the same command again → exit 0', async () => {
    const { pg: p } = getInfra();
    const proxy = await startTcpProxy(p.host, p.port);
    const flaky = createAuthPool({ ...authDatabaseConfig(), host: '127.0.0.1', port: proxy.port }, databaseConfig());
    try {
      const s = await enrolStaff(app);
      proxy.state.commit = 'pooler-crash';
      expect(await runStaffTwoFactorReset({ userId: s.userId, ticket: 'COMMIT', forPromotion: false, passwordFile: undefined }, term(s.email), deps(undefined, flaky))).toBe(STAFF_RESET_EXIT_COMMITTED);
      proxy.state.commit = 'pass';
      expect(await runStaffTwoFactorReset({ userId: s.userId, ticket: 'COMMIT2', forPromotion: false, passwordFile: undefined }, term(s.email), deps())).toBe(STAFF_RESET_EXIT_OK);
    } finally {
      await flaky.end().catch(() => undefined);
      await proxy.close();
    }
  });
});
```
(Thứ tự của ca barrier là cố định: request được gửi, `gate.arrived`, lệnh commit, `gate.open()`; không có `sleep`. `authDatabaseConfig()` có `host`/`port` (`DB_AUTH_HOST`/`DB_AUTH_PORT`, `identity.config.ts`). Ca COMMIT dùng `pooler-crash` của `tcp-proxy.ts`: COMMIT tới server, câu trả lời bị bỏ, client nhận `08P01` → lệnh không biết kết quả → exit 2.)

- [ ] **Step 6: Đổi ca S2-R75 M4 sang lệnh reset (spec §5.3)**

`test/integration/identity/auth-hooks.spec.ts` — thay toàn bộ ca `S2-R75 M4: 2FA notice on the admin /admin/update-user path too …` (Task 7 đã tạm đổi) bằng:
```ts
  it('S2-R75 M4 (3D): a 2FA flip outside the two-factor endpoints — the operator reset command — still records a durable marker and the reconcile cron delivers it; the gauge reflects the backlog', async () => {
    const email = await verifiedUser();
    const id = await idOf(email);
    await owner.query(`UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`, [id]);
    await owner.query(`UPDATE auth.security_notice SET notified_at = GREATEST(clock_timestamp(), created_at) WHERE user_id = $1`, [id]);
    const code = await runStaffTwoFactorReset(
      { userId: id, ticket: 'M4', forPromotion: true, passwordFile: undefined },
      { stdinIsTTY: true, stdoutIsTTY: true, confirm: async () => email, writeSecret: async () => undefined, info: () => undefined },
      { auth, pool: deps.pool, log: () => undefined },
    );
    expect(code).toBe(0);
    // Lệnh không đi qua hook của Better Auth: không có đường gửi nhanh, chỉ marker bền (trigger SP2 + marker của lệnh).
    expect((await twoFactorNotices(id)).filter((n) => !n.notified).map((n) => n.kind).sort()).toEqual(['operator_reset', 'two_factor_disabled']);
    await owner.query(`UPDATE auth.security_notice SET created_at = created_at - ${STALE} WHERE user_id = $1`, [id]);
    const log = vi.spyOn(Logger.prototype, 'log');
    await securityNotices.handle({
      payload: {}, meta: {}, jobId: v7(), attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log: new Logger('t'),
    });
    expect((await twoFactorNotices(id)).every((n) => n.notified && n.deliveries === 1)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ processed: expect.any(Number), failed: 0, oldestPendingSec: expect.any(Number) }),
      'security notices reconciled',
    );
    log.mockRestore();
  });
```
(import `runStaffTwoFactorReset` từ `../../../src/modules/identity/infra/better-auth/staff-2fa-reset.js`; `auth` là instance file đã dựng bằng `createAuthInstance(deps)` — đặt tên biến đúng như file (nếu file gọi là `instance`, dùng tên đó). Helper `twoFactorNotices` của file đọc `kind`, `notified`, `deliveries`: nếu nó lọc `kind LIKE 'two_factor_%'`, nới thành mọi kind của user.)

- [ ] **Step 7: Chạy**

Run:
```bash
pnpm build
pnpm vitest run --project unit test/unit/modules/identity
pnpm vitest run --project integration test/integration/identity/staff-2fa-reset.spec.ts test/integration/identity/staff-2fa-reset-races.spec.ts test/integration/identity/auth-hooks.spec.ts test/integration/identity/staff-step-up.spec.ts
```
Expected: PASS. Chạy `staff-2fa-reset-races.spec.ts` ba lần liền (race ×50 và barrier phải xanh ổn định).

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write src/modules/identity/infra/better-auth test/unit/modules/identity/staff-2fa-reset-args.spec.ts test/integration/identity package.json
pnpm typecheck && pnpm lint && pnpm arch
git add src/modules/identity/infra/better-auth package.json test/unit/modules/identity/staff-2fa-reset-args.spec.ts test/integration/identity
git commit -m "feat(identity): identity:staff-2fa-reset — one transaction, RESET/PROMOTE by the staff state, post-commit check, exit 1 = unchanged / 2 = committed"
```

---

### Task 12: `@PlatformStaffAction()`, `PlatformStaffGuard`, port `PlatformAccessAudit` (addendum A1–A3; PSA-1, PSA-2, PSA-5, PSA-9)

**Files:**
- Create: `src/modules/identity/ports/platform-access-audit.ts`, `src/modules/identity/http/staff-access.ts`, `src/modules/identity/http/platform-staff-action.decorator.ts`, `src/modules/identity/http/platform-staff.guard.ts`, `src/modules/identity/http/platform-staff-guard.module.ts`, `test/unit/modules/identity/staff-access.spec.ts`, `test/unit/modules/identity/platform-staff-action.spec.ts`, `test/integration/tenancy/platform-staff-di.spec.ts`
- Modify: `src/modules/identity/index.ts`, `src/modules/identity/identity.module.ts`, `src/modules/identity/identity-metrics.ts`

**Interfaces:**
- Consumes: `AuthState`, `AuthResult.sessionId` (Task 4), `StaffStepUp.totpMarkFresh` (Task 5), `SessionOnly`, `identityConfig` (`mode`, `sessionFreshAgeSec`, `externalClockToleranceSec`), `identityGuardConfig.unavailableRetryAfterSec`, `routeTemplateOf` (`src/core/http`), `isDbInfraError` (core), `IdentityErrors.SECOND_FACTOR_REQUIRED`/`REAUTHENTICATION_REQUIRED`.
- Produces (addendum A1.1, A3 — hợp đồng cho SP4 4C, SP5 5B, SP6 6B/6D):
  - `PLATFORM_STAFF_ACTION = 'identity:platformStaffAction'`; `PlatformStaffAction(): ClassDecorator & MethodDecorator` (= `SetMetadata` + `SessionOnly()` + `UseGuards(PlatformStaffGuard)`); `hasPlatformStaffAction(controller: Function, handler: Function): boolean`.
  - `abstract class PlatformAccessAudit { abstract record(entry: PlatformAccessEntry): Promise<void> }`, `class NoopPlatformAccessAudit`, `type PlatformAccessEntry`, `NOOP_PLATFORM_ACCESS_AUDIT`.
  - `type StaffAccessDecision = 'ALLOW' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'SECOND_FACTOR_REQUIRED' | 'REAUTHENTICATION_REQUIRED' | 'CHECK_TOTP_MARK'`; `decideStaffAccess(i: { auth: AuthResult; mode: AuthMode; totpMarkFresh?: boolean; authTimeFresh?: boolean }): StaffAccessDecision`.
  - `PlatformStaffGuard` (route-scoped), `PlatformStaffGuardModule` (`@Global`, chỉ `IdentityModule.forApi()`).
  - `IdentityMetrics.platformStaffDecisions` (`identity_platform_staff_decisions_total{result}`, `result` ∈ `allowed | forbidden | second_factor_required | reauthentication_required | unauthenticated | unavailable | audit_failed`).

- [ ] **Step 1: Unit (fail)**

`test/unit/modules/identity/staff-access.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Credential } from '../../../../src/core/context/index.js';
import { decideStaffAccess } from '../../../../src/modules/identity/http/staff-access.js';
import type { AuthResult } from '../../../../src/modules/identity/ports/auth-provider.js';

const authed = (kind: Credential['kind'], isPlatformAdmin = true): AuthResult => ({
  kind: 'AUTHENTICATED',
  principal: { type: kind === 'ORG_API_KEY' ? 'api_key' : 'user', id: 'u' },
  credential: { kind },
  isPlatformAdmin,
  authenticatedAt: new Date(),
  emailVerified: true,
  verifiedEmail: 'u@example.test',
  sessionId: kind === 'SESSION_COOKIE' || kind === 'BEARER_SESSION' ? 's' : undefined,
});

/** Addendum A1.3 / PSA-1: bảng quyết định đầy đủ (AuthResult × credential × mode × dấu × auth_time). */
describe('decideStaffAccess', () => {
  it.each(['local', 'hybrid'] as const)('%s session of staff: CHECK_TOTP_MARK, then ALLOW only with a fresh TOTP mark', (mode) => {
    for (const kind of ['SESSION_COOKIE', 'BEARER_SESSION'] as const) {
      expect(decideStaffAccess({ auth: authed(kind), mode })).toBe('CHECK_TOTP_MARK');
      expect(decideStaffAccess({ auth: authed(kind), mode, totpMarkFresh: true })).toBe('ALLOW');
      expect(decideStaffAccess({ auth: authed(kind), mode, totpMarkFresh: false })).toBe('SECOND_FACTOR_REQUIRED');
    }
  });
  it('external: auth_time must be fresh; never a TOTP query', () => {
    for (const kind of ['EXTERNAL_COOKIE', 'EXTERNAL_BEARER'] as const) {
      expect(decideStaffAccess({ auth: authed(kind), mode: 'external', authTimeFresh: true })).toBe('ALLOW');
      expect(decideStaffAccess({ auth: authed(kind), mode: 'external', authTimeFresh: false })).toBe('REAUTHENTICATION_REQUIRED');
      expect(decideStaffAccess({ auth: authed(kind), mode: 'external' })).toBe('REAUTHENTICATION_REQUIRED');
    }
  });
  it.each(['API_KEY', 'ORG_API_KEY'] as const)('%s is FORBIDDEN in every mode (second line of defence)', (kind) => {
    for (const mode of ['local', 'hybrid', 'external'] as const) expect(decideStaffAccess({ auth: authed(kind), mode })).toBe('FORBIDDEN');
  });
  it('not staff → FORBIDDEN; no principal → UNAUTHENTICATED (fail closed, even on a public route)', () => {
    expect(decideStaffAccess({ auth: authed('SESSION_COOKIE', false), mode: 'local' })).toBe('FORBIDDEN');
    for (const auth of [{ kind: 'ANONYMOUS' }, { kind: 'REJECTED' }, { kind: 'EMAIL_NOT_VERIFIED' }, { kind: 'UNAVAILABLE' }] as const)
      expect(decideStaffAccess({ auth, mode: 'local' })).toBe('UNAUTHENTICATED');
  });
  it('a session credential in external mode or an external credential in local mode is FORBIDDEN (credential does not belong to the mode)', () => {
    expect(decideStaffAccess({ auth: authed('SESSION_COOKIE'), mode: 'external' })).toBe('FORBIDDEN');
    expect(decideStaffAccess({ auth: authed('EXTERNAL_BEARER'), mode: 'local' })).toBe('FORBIDDEN');
  });
});
```
`test/unit/modules/identity/platform-staff-action.spec.ts`:
```ts
import { Controller, Get, SetMetadata } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as identity from '../../../../src/modules/identity/index.js';
import {
  PLATFORM_STAFF_ACTION,
  PlatformStaffAction,
  hasPlatformStaffAction,
} from '../../../../src/modules/identity/http/platform-staff-action.decorator.js';

@Controller('v1/admin/m')
class OnMethod {
  @PlatformStaffAction()
  @Get()
  a(this: void) {
    return 1;
  }
  @Get('b')
  b(this: void) {
    return 1;
  }
}
@PlatformStaffAction()
@Controller('v1/admin/c')
class OnClass {
  @Get()
  c(this: void) {
    return 1;
  }
}
@Controller('v1/admin/raw')
class RawMetadata {
  @SetMetadata(PLATFORM_STAFF_ACTION, true)
  @Get()
  r(this: void) {
    return 1;
  }
}

describe('@PlatformStaffAction metadata (addendum A1.1, A2; PSA-2, PSA-9)', () => {
  it('handler, class, none; a raw SetMetadata without the guard still reads true (inventory of 6B checks the guard)', () => {
    expect(hasPlatformStaffAction(OnMethod, OnMethod.prototype.a)).toBe(true);
    expect(hasPlatformStaffAction(OnMethod, OnMethod.prototype.b)).toBe(false);
    expect(hasPlatformStaffAction(OnClass, OnClass.prototype.c)).toBe(true);
    expect(hasPlatformStaffAction(RawMetadata, RawMetadata.prototype.r)).toBe(true);
  });
  it('PSA-9: identity/index.ts exports the six names of A1.1', () => {
    for (const name of ['PlatformStaffAction', 'PLATFORM_STAFF_ACTION', 'hasPlatformStaffAction', 'PlatformAccessAudit', 'NoopPlatformAccessAudit'] as const)
      expect(identity[name], name).toBeDefined();
    // `PlatformAccessEntry` là kiểu: kiểm bằng nguồn của index (không tồn tại lúc chạy).
    expect(readFileSync('src/modules/identity/index.ts', 'utf8')).toMatch(/type PlatformAccessEntry/);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/identity/staff-access.spec.ts test/unit/modules/identity/platform-staff-action.spec.ts`
Expected: FAIL (module không tồn tại).

- [ ] **Step 2: Port, quyết định, decorator, guard, module**

`src/modules/identity/ports/platform-access-audit.ts`:
```ts
import type { CredentialKind } from '../../../core/context/index.js';

/** Addendum A3: một lần truy cập mà gate nhân viên đã cho qua; chỉ path param, không query/body (A-D5). */
export type PlatformAccessEntry = {
  readonly method: string;
  readonly routeTemplate: string;
  readonly params: Readonly<Record<string, string>>;
  readonly actor: { readonly type: 'user'; readonly id: string };
  readonly credentialKind: Extract<CredentialKind, 'SESSION_COOKIE' | 'BEARER_SESSION' | 'EXTERNAL_COOKIE' | 'EXTERNAL_BEARER'>;
};

/**
 * Port audit truy cập route quyền nền tảng (addendum A3; SP6 6B cài). `@Global` + `@Optional`: identity KHÔNG đăng ký
 * provider (A-D4); vắng → `NOOP_PLATFORM_ACCESS_AUDIT`. `record` chỉ trả về sau khi bản ghi đã bền; ném → guard 503.
 */
export abstract class PlatformAccessAudit {
  abstract record(entry: PlatformAccessEntry): Promise<void>;
}
export class NoopPlatformAccessAudit extends PlatformAccessAudit {
  record(): Promise<void> {
    return Promise.resolve();
  }
}
export const NOOP_PLATFORM_ACCESS_AUDIT = new NoopPlatformAccessAudit();
```
`src/modules/identity/http/staff-access.ts`:
```ts
import type { AuthMode } from '../identity.config.js';
import type { AuthResult } from '../ports/auth-provider.js';

export type StaffAccessDecision =
  | 'ALLOW'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SECOND_FACTOR_REQUIRED'
  | 'REAUTHENTICATION_REQUIRED'
  | 'CHECK_TOTP_MARK';

/**
 * Addendum A1.2: "session nhân viên được dùng quyền nền tảng" — cùng định nghĩa với gate (3) của hook và Bull Board. Hàm
 * thuần; guard gọi lại với `totpMarkFresh` khi lần đầu trả `CHECK_TOTP_MARK` (chỉ nhánh local/hybrid của nhân viên chạm
 * pool auth, PSA-7).
 */
export function decideStaffAccess(i: {
  auth: AuthResult;
  mode: AuthMode;
  totpMarkFresh?: boolean;
  authTimeFresh?: boolean;
}): StaffAccessDecision {
  const a = i.auth;
  switch (a.kind) {
    case 'ANONYMOUS':
    case 'REJECTED':
    case 'EMAIL_NOT_VERIFIED':
    case 'UNAVAILABLE':
      return 'UNAUTHENTICATED';
    case 'AUTHENTICATED':
      break;
    default: {
      const unknown: never = a;
      throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
    }
  }
  if (!a.isPlatformAdmin) return 'FORBIDDEN';
  switch (a.credential.kind) {
    case 'API_KEY':
    case 'ORG_API_KEY':
      return 'FORBIDDEN';
    case 'SESSION_COOKIE':
    case 'BEARER_SESSION':
      if (i.mode === 'external') return 'FORBIDDEN';
      if (i.totpMarkFresh === undefined) return 'CHECK_TOTP_MARK';
      return i.totpMarkFresh ? 'ALLOW' : 'SECOND_FACTOR_REQUIRED';
    case 'EXTERNAL_COOKIE':
    case 'EXTERNAL_BEARER':
      if (i.mode !== 'external') return 'FORBIDDEN';
      return i.authTimeFresh === true ? 'ALLOW' : 'REAUTHENTICATION_REQUIRED';
    default: {
      const unknown: never = a.credential.kind;
      throw new Error(`unknown credential kind ${String(unknown)}`);
    }
  }
}
```
`src/modules/identity/http/platform-staff-action.decorator.ts`:
```ts
import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformStaffGuard } from './platform-staff.guard.js';
import { SessionOnly } from './session-only.decorator.js';

export const PLATFORM_STAFF_ACTION = 'identity:platformStaffAction';
const reflector = new Reflector();

/** Route quyền nền tảng của nhân viên (addendum A1). Không tham số (A-D2). Guard route-scoped ĐẦU TIÊN của handler. */
export const PlatformStaffAction = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(PLATFORM_STAFF_ACTION, true), SessionOnly(), UseGuards(PlatformStaffGuard));

/** Cho inventory của SP6 6B (A2): handler trước, class sau (cùng ngữ nghĩa `getAllAndOverride` của `AuthGuard`). */
export function hasPlatformStaffAction(controller: Function, handler: Function): boolean {
  return reflector.getAllAndOverride<boolean | undefined>(PLATFORM_STAFF_ACTION, [handler, controller]) === true;
}
```
`src/modules/identity/http/platform-staff.guard.ts`:
```ts
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { isDbInfraError } from '../../../core/database/index.js';
import { AppError, CoreErrors, type ErrorCode } from '../../../core/errors/index.js';
import { routeTemplateOf } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import { IdentityMetrics } from '../identity-metrics.js';
import {
  identityConfig,
  identityGuardConfig,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../identity.config.js';
import { StaffStepUp } from '../infra/better-auth/staff-step-up.js';
import {
  NOOP_PLATFORM_ACCESS_AUDIT,
  PlatformAccessAudit,
  type PlatformAccessEntry,
} from '../ports/platform-access-audit.js';
import { AuthState } from './auth-state.js';
import { decideStaffAccess } from './staff-access.js';

const MS_PER_SECOND = 1000;
type Req = IncomingMessage & { params?: Record<string, unknown> };

/**
 * Addendum A1.2–A1.4: chạy SAU mọi APP_GUARD (route-scoped), TRƯỚC mọi interceptor (A-D1). Ở local/hybrid dùng đúng câu
 * dấu TOTP của `staff-step-up.ts` và ngưỡng `AUTH_SESSION_FRESH_AGE_SEC`; ở external đòi `auth_time` tươi. Cho qua → ghi
 * audit (ném → 503, handler không chạy); từ chối → không ghi audit (A-D6).
 */
@Injectable()
export class PlatformStaffGuard implements CanActivate {
  private readonly logger = new Logger(PlatformStaffGuard.name);

  constructor(
    private readonly state: AuthState,
    private readonly metrics: IdentityMetrics,
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
    @Inject(identityGuardConfig.KEY) private readonly guard: IdentityGuardConfig,
    @Optional() private readonly stepUp?: StaffStepUp,
    @Optional() private readonly audit?: PlatformAccessAudit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = this.state.get();
    const mode = this.identity.mode;
    let d = decideStaffAccess({ auth, mode, authTimeFresh: this.authTimeFresh() });
    if (d === 'CHECK_TOTP_MARK') {
      if (auth.kind !== 'AUTHENTICATED' || auth.sessionId === undefined || !this.stepUp)
        throw new Error('PlatformStaffGuard needs StaffStepUp and a session id for a Better Auth staff session');
      let fresh: boolean;
      try {
        fresh = await this.stepUp.totpMarkFresh(auth.principal.id, auth.sessionId, this.identity.sessionFreshAgeSec);
      } catch (err) {
        if (!isDbInfraError(err)) throw err;
        this.metrics.platformStaffDecisions.add(1, { result: 'unavailable' });
        throw this.unavailable();
      }
      d = decideStaffAccess({ auth, mode, totpMarkFresh: fresh });
    }
    switch (d) {
      case 'ALLOW':
        break;
      case 'UNAUTHENTICATED':
        return this.deny('unauthenticated', CoreErrors.UNAUTHENTICATED);
      case 'FORBIDDEN':
        return this.deny('forbidden', CoreErrors.FORBIDDEN);
      case 'SECOND_FACTOR_REQUIRED':
        return this.deny('second_factor_required', IdentityErrors.SECOND_FACTOR_REQUIRED);
      case 'REAUTHENTICATION_REQUIRED':
        return this.deny('reauthentication_required', IdentityErrors.REAUTHENTICATION_REQUIRED);
      case 'CHECK_TOTP_MARK':
        throw new Error('decideStaffAccess asked for the TOTP mark twice');
      default: {
        const unknown: never = d;
        throw new Error(`unknown staff decision ${String(unknown)}`);
      }
    }
    if (auth.kind !== 'AUTHENTICATED') throw new Error('an ALLOW decision without a principal');
    const kind = auth.credential.kind;
    if (kind === 'API_KEY' || kind === 'ORG_API_KEY') throw new Error('an ALLOW decision for an API key');
    const req = context.switchToHttp().getRequest<Req>();
    const entry: PlatformAccessEntry = {
      method: (req.method ?? 'GET').toUpperCase(),
      routeTemplate: routeTemplateOf(context.getClass(), context.getHandler())[0] ?? '',
      params: Object.fromEntries(
        Object.entries(req.params ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
      actor: { type: 'user', id: auth.principal.id },
      credentialKind: kind,
    };
    try {
      await (this.audit ?? NOOP_PLATFORM_ACCESS_AUDIT).record(entry);
    } catch (err) {
      this.metrics.platformStaffDecisions.add(1, { result: 'audit_failed' });
      this.logger.error(
        { event: 'platform_access_audit_failed', errorClass: err instanceof Error ? err.constructor.name : typeof err },
        'platform access audit failed; the staff request is refused',
      );
      throw this.unavailable();
    }
    this.metrics.platformStaffDecisions.add(1, { result: 'allowed' });
    return true;
  }

  /** Cùng luật `@RequireFreshSession()` ở external (SP3 §11, SEC-I6): thiếu `auth_time` → không tươi; không fallback `iat`. */
  private authTimeFresh(): boolean {
    const a = this.state.get();
    if (a.kind !== 'AUTHENTICATED' || a.authenticatedAt === undefined) return false;
    const ageMs = Date.now() - a.authenticatedAt.getTime();
    return ageMs <= this.identity.sessionFreshAgeSec * MS_PER_SECOND && ageMs >= -this.identity.externalClockToleranceSec * MS_PER_SECOND;
  }

  private unavailable(): AppError {
    return new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
      headers: { 'Retry-After': String(this.guard.unavailableRetryAfterSec) },
      expected: true,
    });
  }

  private deny(result: string, error: ErrorCode): never {
    this.metrics.platformStaffDecisions.add(1, { result });
    this.logger.debug({ event: 'platform_staff_denied', reason: error.code }, 'platform staff route refused');
    throw new AppError(error, { expected: true });
  }
}
```
`src/modules/identity/http/platform-staff-guard.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { IdentityMetricsModule } from '../identity-metrics.js';
import { PlatformStaffGuard } from './platform-staff.guard.js';

/**
 * Addendum A1.4: `@Global` (chỉ `IdentityModule.forApi()`), để module của SP4/SP5/SP6 dùng `@PlatformStaffAction()` mà
 * không import module nội bộ của identity. `AuthState` do `IdentityRequestModule` (`@Global`) cung cấp; `StaffStepUp` do
 * `BetterAuthCoreModule` (`@Global`, local/hybrid). Worker không có route HTTP nên không có module này.
 */
@Global()
@Module({ imports: [IdentityMetricsModule], providers: [PlatformStaffGuard], exports: [PlatformStaffGuard] })
export class PlatformStaffGuardModule {}
```
`src/modules/identity/identity-metrics.ts` — trong `IdentityMetrics`:
```ts
  /** Addendum A1.3: `result` ∈ allowed | forbidden | second_factor_required | reauthentication_required | unauthenticated | unavailable | audit_failed. */
  readonly platformStaffDecisions = this.meter.createCounter('identity_platform_staff_decisions_total', {
    description: 'Decisions of the platform staff gate on /v1/admin/** routes, by result',
  });
```
`src/modules/identity/identity.module.ts` — `forApi().imports` thêm `PlatformStaffGuardModule` (sau `IdentityHttpModule`).
`src/modules/identity/index.ts` — thêm:
```ts
export {
  PLATFORM_STAFF_ACTION,
  PlatformStaffAction,
  hasPlatformStaffAction,
} from './http/platform-staff-action.decorator.js';
export {
  NoopPlatformAccessAudit,
  PlatformAccessAudit,
  type PlatformAccessEntry,
} from './ports/platform-access-audit.js';
```

- [ ] **Step 3: DI qua module không import identity (PSA-5)**

`test/integration/tenancy/platform-staff-di.spec.ts` (đặt ở thư mục tenancy vì dựng app có tenancy như module SP4/SP6 sẽ dùng; chỉ import `index.ts` của identity):
```ts
import { Controller, Get, Global, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PlatformAccessAudit,
  PlatformStaffAction,
  type PlatformAccessEntry,
} from '../../../src/modules/identity/index.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';

const recorded: PlatformAccessEntry[] = [];
@Controller('v1/admin/__fixture')
class FixtureAdminController {
  @PlatformStaffAction()
  @Get(':itemId')
  get(this: void) {
    return { ok: true };
  }
}
/** Module "của SP4/SP6": KHÔNG import IdentityModule (addendum A1.4, A10.1). */
@Module({ controllers: [FixtureAdminController] })
class FixtureAdminModule {}
class RecordingAudit extends PlatformAccessAudit {
  record(entry: PlatformAccessEntry): Promise<void> {
    recorded.push(entry);
    return Promise.resolve();
  }
}
@Global()
@Module({ providers: [{ provide: PlatformAccessAudit, useClass: RecordingAudit }], exports: [PlatformAccessAudit] })
class AuditModule {}

describe('PSA-5: @PlatformStaffAction() in a module that does not import identity', () => {
  let app: INestApplication;
  const ps: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [FixtureAdminModule, AuditModule] });
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(ps);
    vi.unstubAllEnvs();
  });
  it('the app boots; a stepped-up staff session passes and the port gets exactly one entry; a regular user is 403', async () => {
    const staff = await seedStaffPrincipal();
    const user = await seedUserPrincipal();
    ps.push(staff, user);
    const ok = await request(app.getHttpServer()).get('/v1/admin/__fixture/42?q=secret').set('authorization', `Bearer ${staff.bearer}`);
    expect(ok.status).toBe(200);
    expect(recorded).toEqual([
      { method: 'GET', routeTemplate: 'v1/admin/__fixture/:itemId', params: { itemId: '42' }, actor: { type: 'user', id: staff.authUserId }, credentialKind: 'BEARER_SESSION' },
    ]);
    const no = await request(app.getHttpServer()).get('/v1/admin/__fixture/42').set('authorization', `Bearer ${user.bearer}`);
    expect([no.status, no.body.code]).toEqual([403, 'forbidden']);
    expect(recorded).toHaveLength(1);
  });
});
```
(`seedStaffPrincipal` có từ Task 7.)

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/identity test/unit/architecture
pnpm vitest run --project integration test/integration/tenancy/platform-staff-di.spec.ts test/e2e/identity/staff-gate.e2e.spec.ts
```
Expected: PASS. `test/unit/architecture/rules.spec.ts` xanh (identity không import tenancy; `staff.guard` chỉ import core + identity). Bộ ca C1–C11 chạy ở Task 26 (cần org key của Task 20 cho C4).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/identity test/unit/modules/identity test/integration/tenancy/platform-staff-di.spec.ts
pnpm typecheck && pnpm lint && pnpm arch
git add src/modules/identity test/unit/modules/identity test/integration/tenancy/platform-staff-di.spec.ts
git commit -m "feat(identity): @PlatformStaffAction(), PlatformStaffGuard and the PlatformAccessAudit port for /v1/admin/** routes"
```

---

### Task 13: Kiểm chứng prod-like #1 — gate nhân viên và lệnh reset trên image production; sửa smoke dùng quyền nền tảng

**Files:**
- Modify: `test/smoke/smoke-devices.ts` (helper `staffDevice`), `test/smoke/dashboard.smoke.spec.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: `Device`, `verifiedDevice`, `PASSWORD` (`smoke-devices.ts`), `psql`, `compose` (`smoke-support.ts`), `otpauth` `URI`.
- Produces: `staffDevice(apiUrl, mail, forbidden): Promise<{ device: Device; email: string; totp: TOTP }>` — user đã xác thực, role `admin`, factor TOTP thật (bật bằng `enable` + `verify-totp` nhánh bật), session đã step-up bằng TOTP.

- [ ] **Step 1: Helper nhân viên đã step-up**

`test/smoke/smoke-devices.ts` — thêm:
```ts
import { URI, type TOTP } from 'otpauth';
import { psql } from './smoke-support.js';

/**
 * Nhân viên trên image (spec SP3 §5.3 r6, N5-1): đăng nhập bằng mật khẩu (nhân viên chưa có factor: hàng rào (9) chỉ giữ
 * session đăng nhập bằng mật khẩu hiện tại), `enable` + `verify-totp` nhánh bật (session xoay từ session còn sống), rồi
 * step-up TOTP thật. Không SQL nào chèn dấu: production có đúng trạng thái này sau ba lời gọi HTTP.
 */
export async function staffDevice(
  apiUrl: string,
  mail: Mailpit,
  forbidden: string[],
): Promise<{ device: Device; email: string; totp: TOTP }> {
  const { device, email } = await verifiedDevice(apiUrl, mail, forbidden);
  psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${email}'`);
  const relogin = await device.call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
  expect(relogin.status).toBe(200);
  const en = await device.call('POST', '/api/auth/two-factor/enable', { body: { password: PASSWORD } });
  expect(en.status).toBe(200);
  const body = (await en.json()) as { totpURI: string };
  const totp = URI.parse(body.totpURI) as TOTP;
  forbidden.push(totp.secret.base32);
  expect((await device.call('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } })).status).toBe(200);
  expect((await device.call('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } })).status).toBe(200);
  return { device, email, totp };
}
```
(Mã TOTP ở hai lời gọi liền có thể trùng (cùng cửa sổ 30 s): Better Auth không ghi mã đã dùng (Review Focus 4), nên lần hai vẫn `200`.)

- [ ] **Step 2: Sửa smoke dùng quyền nền tảng, thêm ca 3D identity**

`test/smoke/dashboard.smoke.spec.ts` — `signedIn('admin')` hiện dựng admin bằng `psql` rồi đăng nhập: sau 3D session đó chưa có dấu TOTP nên Bull Board trả `403 second_factor_required`. Đổi ca `ordinary user → 403; platform admin via cookie → 200 …`: admin lấy từ `staffDevice` (dựng `Session` của file từ `device.jar.header()` và bearer của lần step-up cuối, `forbidden` như cũ), và thêm ngay trước khối đó:
```ts
  it('3D: a staff session without a TOTP step-up is 403 second_factor_required on the dashboard', async () => {
    const plain = await signedIn('admin');
    const r = probe(`${DASHBOARD}/api/queues`, { headers: { cookie: plain.cookie } });
    expect([r.status, problem(r).code]).toEqual([403, 'second_factor_required']);
  });
```
`test/smoke/tenancy.smoke.spec.ts`:
- ca `identity of 3A …`: admin chưa step-up gọi `/admin/remove-user` với id viết hoa nay nhận `403 second_factor_required` (gate (3) chạy TRƯỚC kiểm dạng id). Đổi kỳ vọng ca đó thành `403 second_factor_required`, và thêm cùng lời gọi bằng nhân viên từ `staffDevice` → `422` (kiểm dạng id sau gate);
- ca `account deletion …`: `admin` lấy từ `staffDevice` thay cho `verifiedDevice` + `psql role`;
- ca mới cuối `describe` (trước ca log sạch):
```ts
  it('3D identity on the production image: staff step-up opens /admin/*, a backup-code step-up does not, disable is forbidden, the reset command refuses without a TTY', async () => {
    const { device } = await staffDevice(apiUrl, mail, forbidden);
    expect((await device.call('GET', '/api/auth/admin/list-users?limit=1')).status).toBe(200);
    const off = await device.call('POST', '/api/auth/two-factor/disable', { body: { password: PASSWORD } });
    expect([off.status, ((await off.json()) as { code: string }).code]).toEqual([403, 'forbidden']);
    const id = psql(`SELECT id FROM auth."user" ORDER BY created_at DESC LIMIT 1`);
    let failure = '';
    try {
      compose(['exec', '-T', 'api', 'node', 'dist/modules/identity/infra/better-auth/staff-2fa-reset.cli.js', '--user-id', id, '--ticket', 'SMOKE-3D'], { timeoutMs: 60_000 });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    expect(failure).toContain('needs an interactive terminal');
    expect(psql(`SELECT count(*) FROM auth.security_notice WHERE ticket = 'SMOKE-3D'`)).toBe('0');
  });
```
(import `staffDevice` từ `./smoke-devices.js`, `compose` từ `./smoke-support.js`.)

- [ ] **Step 3: Chạy prod-like**

Run: `pnpm test:smoke`
Expected: build image production thật; `compose --profile app` (`NODE_ENV=production`) migrate từ `dist` gồm hai migration identity mới; mọi file smoke PASS; log api/worker JSON không `error`, không chứa giá trị trong `forbidden` (email, cookie, bearer, secret TOTP); `/health/ready` 200; teardown `down -v` sạch. Lệnh reset trong container không TTY thoát `1` trước khi nạp config (không marker).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/smoke
git add test/smoke
git commit -m "test(smoke): staff step-up gate, disable refusal and the reset command on the production image"
```

---

## Phần C — Schema ủy quyền của tenancy (spec §6.10–6.14, §18.1)

### Task 14: Migration `tenancy/…_delegation` — bốn bảng RLS FORCE, trigger guard, closure dùng chung, hai constraint trigger definer grantee/member, trạng thái cuối, hai hàm definer, `down` có guard; hằng catalog, chuẩn hoá, thứ tự xoá cứng, hằng định dạng

**Files:**
- Create: `src/migrations/tenancy/Migration<ts>_delegation.ts`
- Modify: `src/modules/tenancy/constants.ts`, `src/modules/tenancy/infra/sql/org-purge.sql.ts`, `test/support/tenancy-catalog.ts`, `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: `organizations`, `org_members`, `tenancy_users`, `permissions` (3A), `tenancy_org_lock_key`, `tenancy_permission_scope_closed_ck()` (3B), mẫu migration 3C (`Migration20261001090207_acquisition.ts`), hằng `*_3A/3B/3C` của `test/support/tenancy-catalog.ts`.
- Produces:
  - Bảng `org_api_keys (id, public_id, org_id, created_by_member_id, name, token_hash, key_hint, expires_at, revoked_at, version, created_at, updated_at)`, `org_api_key_permissions (org_id, api_key_id, permission_id, created_at, updated_at)`, `org_support_grants (id, public_id, org_id, grantee_user_id, granted_by_member_id, reason, expires_at, revoked_at, first_used_at, version, created_at, updated_at)`, `org_support_grant_permissions (org_id, grant_id, permission_id, created_at, updated_at)`.
  - Tên constraint/trigger (hợp đồng cho map lỗi Task 16 và test Task 15): `org_api_keys_name_ck`, `org_api_keys_key_hint_ck`, `org_api_keys_token_hash_uq`, `org_api_keys_revoked_once`, `org_api_key_permissions_guard`, `org_api_key_permissions_closed_ck`, `org_support_grants_reason_ck`, `org_support_grants_active_uq`, `org_support_grants_revoked_once`, `org_support_grants_first_used_once`, `org_support_grant_permissions_guard`, `org_support_grant_permissions_closed_ck`, `org_support_grants_grantee_not_member`, `org_members_no_active_support_grant`.
  - Hàm definer `public.tenancy_find_org_api_key(bytea) → (org_id uuid, api_key_id bigint, api_key_public_id uuid)`, `public.tenancy_grantee_open_grant_orgs(bigint) → (org_id uuid)`; hàm trigger definer `public.tenancy_org_support_grants_grantee_not_member()`, `public.tenancy_org_members_no_active_support_grant()`.
  - `constants.ts`: `ORG_API_KEY_SECRET_BYTES = 32`, `KEY_HINT_LENGTH = 6`, `ORG_API_KEY_NAME_MAX_LENGTH = 64`, `SUPPORT_GRANT_REASON_MAX_LENGTH = 500`, `DELEGATION_PERMISSIONS_MAX = ROLE_PERMISSIONS_MAX`.
  - `ORG_PURGE_STATEMENTS` thêm 4 câu đầu danh sách.
  - `test/support/tenancy-catalog.ts`: `DEFINER_FUNCTIONS_3D`, `DEFINER_READ_TABLES_3D`, `TENANCY_TENANT_TABLES_3D`, `DEFINER_TRIGGER_FUNCTIONS_3D`, `DEFINER_INTERNAL_FUNCTIONS_3D` (hợp vào các hằng gộp).

- [ ] **Step 1: Hằng catalog và assert catalog (fail)**

`test/support/tenancy-catalog.ts` — thêm sau khối 3C và nối vào năm hằng gộp:
```ts
/**
 * Plan 3D (spec §6.10–6.11, §6.14, §18.1): tra org key theo hash (không cần OrgScope) và org có grant mở của một grantee
 * (thu hồi khi role nền tảng đổi). Bốn bảng có policy `_definer_read`: hai bảng gốc cho hai hàm trên và hai trigger hoãn,
 * hai bảng nối cho hàm closure dùng chung của 3B (`tenancy_permission_scope_closed_ck`, SECURITY DEFINER của
 * `tenancy_definer`, đọc bảng nối của chính trigger). Hai trigger hoãn grantee/member là SECURITY DEFINER (bài học 3A Task 13).
 */
export const DEFINER_FUNCTIONS_3D = [
  'tenancy_find_org_api_key',
  'tenancy_grantee_open_grant_orgs',
] as const;
export const DEFINER_READ_TABLES_3D = [
  'org_api_keys',
  'org_api_key_permissions',
  'org_support_grants',
  'org_support_grant_permissions',
] as const;
export const TENANCY_TENANT_TABLES_3D = [
  'org_api_keys',
  'org_api_key_permissions',
  'org_support_grants',
  'org_support_grant_permissions',
] as const;
export const DEFINER_TRIGGER_FUNCTIONS_3D = [
  'tenancy_org_support_grants_grantee_not_member',
  'tenancy_org_members_no_active_support_grant',
] as const;
export const DEFINER_INTERNAL_FUNCTIONS_3D = [...DEFINER_TRIGGER_FUNCTIONS_3D] as const;
```
và `DEFINER_FUNCTIONS` thêm `...DEFINER_FUNCTIONS_3D`; `DEFINER_READ_TABLES` thêm `...DEFINER_READ_TABLES_3D`; `TENANCY_TENANT_TABLES` thêm `...TENANCY_TENANT_TABLES_3D`; `DEFINER_TRIGGER_FUNCTIONS` thêm `...DEFINER_TRIGGER_FUNCTIONS_3D`; `DEFINER_INTERNAL_FUNCTIONS` thêm `...DEFINER_INTERNAL_FUNCTIONS_3D`. (`OWNED_FUNCTIONS` của `test/support/core-catalog.ts` đọc các hằng gộp này, nên `migration-scan.spec.ts` tự đòi bốn hàm mới nằm giữa `SET LOCAL ROLE tenancy_definer … RESET ROLE`.)

`test/integration/core/database/rls-catalog.spec.ts`:
- ca `tenancy_definer holds only column SELECT on the declared columns` — thêm trước `const tableLevel`:
```ts
      // Plan 3D: hai hàm definer, hai trigger hoãn và hàm closure dùng chung đọc đúng các cột này (spec §6.10, §6.11).
      expect(cols('org_api_keys')).toEqual(['expires_at', 'id', 'org_id', 'public_id', 'revoked_at', 'token_hash']);
      expect(cols('org_api_key_permissions')).toEqual(['api_key_id', 'org_id', 'permission_id']);
      expect(cols('org_support_grants')).toEqual(['grantee_user_id', 'id', 'org_id', 'revoked_at']);
      expect(cols('org_support_grant_permissions')).toEqual(['grant_id', 'org_id', 'permission_id']);
```
- ca `app_user UPDATE is column-scoped …` — thêm bốn bảng vào danh sách `table_name IN (…)` của câu SQL và các assert:
```ts
      // Spec §6.10–6.11: tên, hash, hint, hạn, người tạo/cấp, lý do và phạm vi là bất biến; chỉ thu hồi và lần dùng đầu.
      expect(cols('org_api_keys')).toEqual(['revoked_at', 'updated_at', 'version']);
      expect(cols('org_api_key_permissions')).toEqual([]);
      expect(cols('org_support_grants')).toEqual(['first_used_at', 'revoked_at', 'updated_at', 'version']);
      expect(cols('org_support_grant_permissions')).toEqual([]);
```
- thêm một ca trong `describe('tenancy grants …')`:
```ts
    it('3D bridge tables: app_user holds SELECT, INSERT, DELETE and nothing else (spec §6.10, §6.11)', async () => {
      for (const t of ['org_api_key_permissions', 'org_support_grant_permissions']) {
        const { rows } = await client.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = $1 ORDER BY privilege_type`,
          [t],
        );
        expect(rows.map((r) => r.privilege_type), t).toEqual(['DELETE', 'INSERT', 'SELECT']);
      }
    });
```
`test/integration/core/database/normalization-inventory.spec.ts` — `ANALYSED_COLUMNS` thêm (sau `'public.org_ownership_transfers'`):
```ts
  'public.org_api_keys': [
    'id', 'public_id', 'org_id', 'created_by_member_id', 'name', 'token_hash', 'key_hint',
    'expires_at', 'revoked_at', 'version', 'created_at', 'updated_at',
  ],
  'public.org_api_key_permissions': ['org_id', 'api_key_id', 'permission_id', 'created_at', 'updated_at'],
  'public.org_support_grants': [
    'id', 'public_id', 'org_id', 'grantee_user_id', 'granted_by_member_id', 'reason', 'expires_at',
    'revoked_at', 'first_used_at', 'version', 'created_at', 'updated_at',
  ],
  'public.org_support_grant_permissions': ['org_id', 'grant_id', 'permission_id', 'created_at', 'updated_at'],
```

Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts`
Expected: FAIL (bốn bảng, bốn hàm chưa tồn tại).

- [ ] **Step 2: Migration bằng CLI**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/tenancy --name delegation`
Expected: `src/migrations/tenancy/Migration<ts>_delegation.ts`, timestamp lớn hơn `Migration20261001090207_acquisition` và hai migration identity của Task 3, Task 10.

Thay nội dung lớp (giữ tên lớp và `name` do CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

const TABLES = [
  'org_api_keys',
  'org_api_key_permissions',
  'org_support_grants',
  'org_support_grant_permissions',
] as const;
/** Bảng mà `down` đọc để từ chối khi còn ủy quyền đang mở (mẫu NO FORCE … FORCE, spec §8.8). */
const GUARDED = ['org_api_keys', 'org_support_grants'] as const;

/**
 * Plan 3D (spec SP3 §6.10–6.11, §6.13 bảng 3D, §6.14): org API key và support grant.
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | org_api_keys | {id}, {org_id, public_id}, {token_hash} | created_by_member_id → org_id | 3NF (org_id là thuộc tính khoá); không BCNF — E1. `token_hash → key_hint` là phụ thuộc từ khoá ứng viên (tầm thường); `key_hint` là snapshot bất biến |
 * | org_api_key_permissions | {api_key_id, permission_id} | api_key_id → org_id | 1NF hình thức (vi phạm 2NF) — E1 |
 * | org_support_grants | {id}, {org_id, public_id} | granted_by_member_id → org_id | 3NF; không BCNF — E1 |
 * | org_support_grant_permissions | {grant_id, permission_id} | grant_id → org_id | 1NF hình thức (vi phạm 2NF) — E1 |
 * E1 — `org_id` lặp lại cho RLS không join và FK kép; giữ nhất quán ở DB: FK kép `(org_id, x) → cha(org_id, id)` (bản sao
 * không khác org của cha), `SET NULL (cột)` chỉ xoá cột con, không grant `UPDATE (org_id)`, `WITH CHECK (org_id =
 * app_current_org())`, và FK `org_id → organizations` trực tiếp ở hai bảng gốc (neo, M5/B5). Phạm vi là bảng nối có FK tới
 * `permissions` (không JSON, spec §6.12 "Enum"). Không có cột `access_level` (P-2, CDX-14): grant v1 chỉ đọc.
 *
 * Index (mỗi cái một query): `org_api_keys_token_hash_uq` → `tenancy_find_org_api_key` ở mỗi request mang key (xuyên org);
 * `org_api_keys_creator_idx (org_id, created_by_member_id)` → liệt kê key của tôi, trần key mỗi member, FK CASCADE;
 * `org_api_keys_created_idx (org_id, created_at)` → liệt kê mọi key; `org_support_grants_active_uq (org_id, grantee_user_id)
 * WHERE revoked_at IS NULL` → một grant mở mỗi người nhận (T-20) và tra grant ở mỗi request của nhân viên; 
 * `org_support_grants_grantee_idx (grantee_user_id)` → FK SET NULL khi xoá `tenancy_users` và
 * `tenancy_grantee_open_grant_orgs` (xuyên org); `org_support_grants_granter_idx (org_id, granted_by_member_id)` → FK SET
 * NULL; `org_support_grants_created_idx (org_id, created_at)` → liệt kê; PK bảng nối → đọc phạm vi;
 * `*_permission_idx (permission_id)` → FK RESTRICT và migration catalogue (xuyên org).
 *
 * Trigger: hai guard BEFORE INSERT quyền caller (eligibility; dòng quyền không thấy được → cho qua để FK quyết định);
 * closure hoãn dùng chung của 3B (`tenancy_permission_scope_closed_ck('api_key_id' | 'grant_id')`); trạng thái cuối
 * (`revoked_at` đặt một lần, `first_used_at` đặt một lần; bài học final review 3C M-2); hai constraint trigger hoãn
 * SECURITY DEFINER của `tenancy_definer` (grantee không là member ↔ member không có grant mở): kiểm READ COMMITTED, khoá
 * advisory theo org (`tenancy_org_lock_key`, cùng khoá với trigger owner cuối), rồi đọc lại dòng của chính nó; không phụ
 * thuộc `app.org_id` lúc COMMIT (T-19, DB2-M5, CDX-10).
 *
 * Hàm definer (S3-A31: tạo/xoá dưới SET LOCAL ROLE): `tenancy_find_org_api_key` (hash 32 byte; key chưa thu hồi còn hạn
 * theo `now()`, đọc không chờ khoá §3.15; trả `api_key_public_id` cho principal, SEC-M2), `tenancy_grantee_open_grant_orgs`
 * (mọi org có grant chưa thu hồi của grantee, kể cả đã hết hạn, ORDER BY org_id). NULL/sai độ dài → RAISE (DB-M3).
 *
 * Khoá: `SHARE ROW EXCLUSIVE` trên `organizations`, `org_members` (FK + CREATE TRIGGER trên bảng sống), `tenancy_users`,
 * `permissions` tới hết lô 3D: đọc không bị chặn, ghi member/org chờ (ngắn).
 *
 * Down: từ chối khi còn key hoặc grant chưa thu hồi còn hạn (không xoá credential âm thầm), rồi xoá ngược thứ tự: trigger
 * trên `org_members`, bốn bảng, hàm definer và hai hàm trigger definer (dưới SET LOCAL ROLE), bốn hàm trigger quyền caller.
 * Không xoá hàm closure của 3B.
 */
export class Migration<ts>_delegation extends Migration {
  override name = 'Migration<ts>_delegation';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE org_api_keys (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    created_by_member_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    token_hash BYTEA NOT NULL,
    key_hint TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_api_keys_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_api_keys_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_api_keys_token_hash_uq UNIQUE (token_hash),
    CONSTRAINT org_api_keys_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_api_keys_creator_fk FOREIGN KEY (org_id, created_by_member_id) REFERENCES org_members (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_api_keys_name_ck CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT org_api_keys_token_hash_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT org_api_keys_key_hint_ck CHECK (key_hint ~ '^oak_[A-Za-z0-9_-]{6}$'),
    CONSTRAINT org_api_keys_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_api_keys_revoked_ck CHECK (revoked_at >= created_at),
    CONSTRAINT org_api_keys_version_ck CHECK (version >= 1));`);
    this.addSql(`CREATE INDEX org_api_keys_creator_idx ON org_api_keys (org_id, created_by_member_id);`);
    this.addSql(`CREATE INDEX org_api_keys_created_idx ON org_api_keys (org_id, created_at);`);

    this.addSql(`CREATE TABLE org_api_key_permissions (
    org_id UUID NOT NULL,
    api_key_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_api_key_permissions_pk PRIMARY KEY (org_id, api_key_id, permission_id),
    CONSTRAINT org_api_key_permissions_key_fk FOREIGN KEY (org_id, api_key_id) REFERENCES org_api_keys (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_api_key_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE RESTRICT);`);
    this.addSql(`CREATE INDEX org_api_key_permissions_permission_idx ON org_api_key_permissions (permission_id);`);

    this.addSql(`CREATE TABLE org_support_grants (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    grantee_user_id BIGINT NULL,
    granted_by_member_id BIGINT NULL,
    reason TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    first_used_at TIMESTAMPTZ NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_support_grants_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_support_grants_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_support_grants_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_support_grants_grantee_fk FOREIGN KEY (grantee_user_id) REFERENCES tenancy_users (id) ON DELETE SET NULL,
    CONSTRAINT org_support_grants_granter_fk FOREIGN KEY (org_id, granted_by_member_id) REFERENCES org_members (org_id, id) ON DELETE SET NULL (granted_by_member_id),
    CONSTRAINT org_support_grants_reason_ck CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
    CONSTRAINT org_support_grants_expires_ck CHECK (expires_at > created_at),
    CONSTRAINT org_support_grants_revoked_ck CHECK (revoked_at >= created_at),
    CONSTRAINT org_support_grants_first_used_ck CHECK (first_used_at >= created_at),
    CONSTRAINT org_support_grants_version_ck CHECK (version >= 1));`);
    this.addSql(
      `CREATE UNIQUE INDEX org_support_grants_active_uq ON org_support_grants (org_id, grantee_user_id) WHERE revoked_at IS NULL;`,
    );
    this.addSql(`CREATE INDEX org_support_grants_grantee_idx ON org_support_grants (grantee_user_id);`);
    this.addSql(`CREATE INDEX org_support_grants_granter_idx ON org_support_grants (org_id, granted_by_member_id);`);
    this.addSql(`CREATE INDEX org_support_grants_created_idx ON org_support_grants (org_id, created_at);`);

    this.addSql(`CREATE TABLE org_support_grant_permissions (
    org_id UUID NOT NULL,
    grant_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_support_grant_permissions_pk PRIMARY KEY (org_id, grant_id, permission_id),
    CONSTRAINT org_support_grant_permissions_grant_fk FOREIGN KEY (org_id, grant_id) REFERENCES org_support_grants (org_id, id) ON DELETE CASCADE,
    CONSTRAINT org_support_grant_permissions_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE RESTRICT);`);
    this.addSql(
      `CREATE INDEX org_support_grant_permissions_permission_idx ON org_support_grant_permissions (permission_id);`,
    );

    for (const t of TABLES) {
      this.addSql(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      this.addSql(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
      this.addSql(
        `CREATE POLICY ${t}_tenant ON ${t} TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`,
      );
      this.addSql(`CREATE POLICY ${t}_definer_read ON ${t} FOR SELECT TO tenancy_definer USING (true);`);
    }
    // Spec §6.10–6.11: DELETE cho xoá cứng org (app_user trong OrgScope); UPDATE theo cột — chỉ thu hồi, lần dùng đầu và
    // version; phạm vi (bảng nối) bất biến sau khi tạo (không UPDATE; DELETE lẻ chỉ ở xoá cứng/migration catalogue).
    this.addSql(`GRANT SELECT, INSERT, DELETE, UPDATE (revoked_at, version, updated_at) ON org_api_keys TO app_user;`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_api_key_permissions TO app_user;`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE, UPDATE (revoked_at, first_used_at, version, updated_at) ON org_support_grants TO app_user;`,
    );
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_support_grant_permissions TO app_user;`);
    this.addSql(
      `GRANT SELECT (id, public_id, org_id, token_hash, revoked_at, expires_at) ON org_api_keys TO tenancy_definer;`,
    );
    this.addSql(`GRANT SELECT (org_id, api_key_id, permission_id) ON org_api_key_permissions TO tenancy_definer;`);
    this.addSql(`GRANT SELECT (id, org_id, grantee_user_id, revoked_at) ON org_support_grants TO tenancy_definer;`);
    this.addSql(`GRANT SELECT (org_id, grant_id, permission_id) ON org_support_grant_permissions TO tenancy_definer;`);

    // Quyền caller: dòng quyền không thấy được (key không tồn tại) → cho qua để FK (23503) quyết định (spike S3B-2).
    this.addSql(`CREATE FUNCTION tenancy_org_api_key_permissions_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_eligible boolean;
  v_owner_only boolean;
  v_deprecated timestamptz;
BEGIN
  SELECT api_key_eligible, owner_only, deprecated_at INTO v_eligible, v_owner_only, v_deprecated
    FROM public.permissions WHERE id = NEW.permission_id;
  IF FOUND AND (NOT v_eligible OR v_owner_only OR v_deprecated IS NOT NULL) THEN
    RAISE EXCEPTION 'this permission cannot be delegated to an organization API key'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_api_key_permissions_guard';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_api_key_permissions_guard BEFORE INSERT ON org_api_key_permissions
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_api_key_permissions_guard();`);
    // P-2: grant v1 chỉ đọc — eligible VÀ action = 'read'.
    this.addSql(`CREATE FUNCTION tenancy_org_support_grant_permissions_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_eligible boolean;
  v_action text;
  v_owner_only boolean;
  v_deprecated timestamptz;
BEGIN
  SELECT support_eligible, action, owner_only, deprecated_at INTO v_eligible, v_action, v_owner_only, v_deprecated
    FROM public.permissions WHERE id = NEW.permission_id;
  IF FOUND AND (NOT v_eligible OR v_action <> 'read' OR v_owner_only OR v_deprecated IS NOT NULL) THEN
    RAISE EXCEPTION 'this permission cannot be delegated to a support grant (read-only, support-eligible permissions only)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grant_permissions_guard';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_support_grant_permissions_guard BEFORE INSERT ON org_support_grant_permissions
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_support_grant_permissions_guard();`);
    this.addSql(`CREATE FUNCTION tenancy_org_api_keys_terminal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked organization API key stays revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_api_keys_revoked_once';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_api_keys_revoked_once BEFORE UPDATE OF revoked_at ON org_api_keys
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_api_keys_terminal();`);
    this.addSql(`CREATE FUNCTION tenancy_org_support_grants_terminal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked support grant stays revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_revoked_once';
  END IF;
  -- T-15: lần dùng đầu ghi đúng một lần; event \`.used\` gắn với lần ghi đó.
  IF OLD.first_used_at IS NOT NULL AND NEW.first_used_at IS DISTINCT FROM OLD.first_used_at THEN
    RAISE EXCEPTION 'the first use of a support grant is recorded once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_first_used_once';
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER org_support_grants_terminal BEFORE UPDATE OF revoked_at, first_used_at ON org_support_grants
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_support_grants_terminal();`);
    // Closure dùng chung của 3B (app_owner có EXECUTE cho CREATE TRIGGER, migration 3B).
    this.addSql(`CREATE CONSTRAINT TRIGGER org_api_key_permissions_closed_ck AFTER INSERT OR DELETE ON org_api_key_permissions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_permission_scope_closed_ck('api_key_id');`);
    this.addSql(`CREATE CONSTRAINT TRIGGER org_support_grant_permissions_closed_ck AFTER INSERT OR DELETE ON org_support_grant_permissions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_permission_scope_closed_ck('grant_id');`);

    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`CREATE FUNCTION public.tenancy_org_support_grants_grantee_not_member() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_grantee bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the support grantee check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_grantee_not_member';
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(NEW.org_id));
  -- Đọc lại dòng của chính nó: đã thu hồi (MemberAdmission, cấp lại) hoặc người nhận đã SET NULL → không còn gì để kiểm.
  SELECT g.grantee_user_id INTO v_grantee FROM public.org_support_grants g
    WHERE g.org_id = NEW.org_id AND g.id = NEW.id AND g.revoked_at IS NULL;
  IF v_grantee IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = NEW.org_id AND m.user_id = v_grantee) THEN
    RAISE EXCEPTION 'a support grantee must not be a member of the organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_support_grants_grantee_not_member';
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_org_members_no_active_support_grant() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the member/support grant check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_no_active_support_grant';
  END IF;
  PERFORM pg_advisory_xact_lock(public.tenancy_org_lock_key(NEW.org_id));
  IF NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id = NEW.org_id AND m.id = NEW.id) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.org_support_grants g
             WHERE g.org_id = NEW.org_id AND g.grantee_user_id = NEW.user_id AND g.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a member must not hold an unrevoked support grant of the same organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_no_active_support_grant';
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_find_org_api_key(p_token_hash bytea)
RETURNS TABLE (org_id uuid, api_key_id bigint, api_key_public_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL THEN RAISE EXCEPTION 'tenancy_find_org_api_key: p_token_hash must not be NULL'; END IF;
  IF octet_length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'tenancy_find_org_api_key: p_token_hash must be 32 bytes'; END IF;
  RETURN QUERY SELECT k.org_id, k.id, k.public_id FROM public.org_api_keys k
    WHERE k.token_hash = p_token_hash AND k.revoked_at IS NULL AND k.expires_at > now();
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_grantee_open_grant_orgs(p_user_id bigint)
RETURNS TABLE (org_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_grantee_open_grant_orgs: p_user_id must not be NULL'; END IF;
  RETURN QUERY SELECT DISTINCT g.org_id FROM public.org_support_grants g
    WHERE g.grantee_user_id = p_user_id AND g.revoked_at IS NULL ORDER BY g.org_id;
END $$;`);
    for (const sig of ['tenancy_find_org_api_key(bytea)', 'tenancy_grantee_open_grant_orgs(bigint)']) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_user;`);
    }
    for (const sig of ['tenancy_org_support_grants_grantee_not_member()', 'tenancy_org_members_no_active_support_grant()']) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      // CREATE TRIGGER (chạy bằng app_owner) đòi EXECUTE; lúc trigger bắn không kiểm EXECUTE nên app_user không cần.
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_owner;`);
    }
    this.addSql(`RESET ROLE;`);
    this.addSql(`CREATE CONSTRAINT TRIGGER org_support_grants_grantee_not_member AFTER INSERT ON org_support_grants
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_org_support_grants_grantee_not_member();`);
    this.addSql(`CREATE CONSTRAINT TRIGGER org_members_no_active_support_grant AFTER INSERT ON org_members
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tenancy_org_members_no_active_support_grant();`);
  }

  override down(): void | Promise<void> {
    for (const t of GUARDED) this.addSql(`ALTER TABLE public.${t} NO FORCE ROW LEVEL SECURITY;`);
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_api_keys WHERE revoked_at IS NULL AND expires_at > now())
     OR EXISTS (SELECT 1 FROM public.org_support_grants WHERE revoked_at IS NULL AND expires_at > now()) THEN
    RAISE EXCEPTION 'unrevoked organization API keys or support grants exist: revoke them (or wait for them to expire) before reverting plan 3D';
  END IF;
END $$;`);
    for (const t of GUARDED) this.addSql(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY;`);
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
    this.addSql(`DROP TRIGGER org_members_no_active_support_grant ON org_members;`);
    this.addSql(`DROP TABLE org_support_grant_permissions;`);
    this.addSql(`DROP TABLE org_support_grants;`);
    this.addSql(`DROP TABLE org_api_key_permissions;`);
    this.addSql(`DROP TABLE org_api_keys;`);
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`DROP FUNCTION public.tenancy_grantee_open_grant_orgs(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_find_org_api_key(bytea);`);
    this.addSql(`DROP FUNCTION public.tenancy_org_members_no_active_support_grant();`);
    this.addSql(`DROP FUNCTION public.tenancy_org_support_grants_grantee_not_member();`);
    this.addSql(`RESET ROLE;`);
    this.addSql(`DROP FUNCTION tenancy_org_support_grants_terminal();`);
    this.addSql(`DROP FUNCTION tenancy_org_api_keys_terminal();`);
    this.addSql(`DROP FUNCTION tenancy_org_support_grant_permissions_guard();`);
    this.addSql(`DROP FUNCTION tenancy_org_api_key_permissions_guard();`);
  }
}
```

- [ ] **Step 3: Hằng định dạng và thứ tự xoá cứng**

`src/modules/tenancy/constants.ts` — thêm:
```ts
/** Spec SP3 §10, §13: org key = `oak_` + base64url(32 byte); `key_hint` = `oak_` + 6 ký tự đầu phần ngẫu nhiên (`org_api_keys_key_hint_ck`). */
export const ORG_API_KEY_SECRET_BYTES = 32;
export const KEY_HINT_LENGTH = 6;
/** Khớp `org_api_keys_name_ck` / `org_support_grants_reason_ck` của migration `delegation` (đếm code point như `char_length`). */
export const ORG_API_KEY_NAME_MAX_LENGTH = 64;
export const SUPPORT_GRANT_REASON_MAX_LENGTH = 500;
/** Biên đầu vào của `permissions` trong body tạo key (cùng biên với role). */
export const DELEGATION_PERMISSIONS_MAX = ROLE_PERMISSIONS_MAX;
```
(đặt `DELEGATION_PERMISSIONS_MAX` sau khai báo `ROLE_PERMISSIONS_MAX`.)

`src/modules/tenancy/infra/sql/org-purge.sql.ts` — đầu mảng (spec §9.5: con trước cha, bảng 3D trước bảng 3C):
```ts
export const ORG_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM org_support_grant_permissions WHERE org_id = app_current_org()',
  'DELETE FROM org_support_grants WHERE org_id = app_current_org()',
  'DELETE FROM org_api_key_permissions WHERE org_id = app_current_org()',
  'DELETE FROM org_api_keys WHERE org_id = app_current_org()',
  'DELETE FROM org_ownership_transfers WHERE org_id = app_current_org()',
  …giữ nguyên phần còn lại…
];
```
(Xoá cả bảng nối và key trong cùng transaction: trigger closure hoãn bắn lúc COMMIT trên tập đã rỗng → đạt.)

Thêm unit test thứ tự (vào `test/unit/modules/tenancy/registries.spec.ts` hoặc file của 3A đang khoá `ORG_PURGE_STATEMENTS` nếu có — `grep -rln ORG_PURGE_STATEMENTS test/unit` trước):
```ts
  it('purge order: 3D tables first (bridge before parent), then 3C, then members (spec §9.5)', () => {
    const tables = ORG_PURGE_STATEMENTS.map((s) => /DELETE FROM (\w+)/.exec(s)?.[1]);
    expect(tables.slice(0, 5)).toEqual(['org_support_grant_permissions', 'org_support_grants', 'org_api_key_permissions', 'org_api_keys', 'org_ownership_transfers']);
    expect(tables.indexOf('org_api_keys')).toBeLessThan(tables.indexOf('org_members'));
  });
```

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm build
pnpm vitest run --project unit test/unit/migrations test/unit/modules/tenancy
pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/integration/core/database/migrations.spec.ts test/integration/tenancy/org-purge.spec.ts test/integration/tenancy/seed-helper.spec.ts
```
Expected: PASS. `migration-scan.spec.ts`: bốn hàm definer tạo/xoá giữa `SET LOCAL ROLE tenancy_definer … RESET ROLE`, mỗi `CREATE FUNCTION` có `DROP FUNCTION`, `NO FORCE` có khẳng định ở cuối `down`. `migration-order.spec.ts`: `…_delegation` mới nhất ở vùng của nó. `rls-catalog.spec.ts`: bốn bảng RLS + FORCE + policy `TO app_user`, policy `_definer_read` đúng tập hằng, bốn hàm mới đúng owner/`search_path`/`EXECUTE`, "deferrable constraint name unique" xanh. `migrations.spec.ts`: up → down → up và sweep S2-R57 gồm `…_delegation` (DB riêng, không có key/grant → `down` đạt). `seed-helper.spec.ts`/`org-purge.spec.ts`: thứ tự xoá mới không phá dispose/purge.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/migrations/tenancy src/modules/tenancy/constants.ts src/modules/tenancy/infra/sql/org-purge.sql.ts test/support/tenancy-catalog.ts test/integration/core/database test/unit/modules/tenancy
pnpm typecheck && pnpm lint
git add src/migrations/tenancy src/modules/tenancy/constants.ts src/modules/tenancy/infra/sql/org-purge.sql.ts test/support/tenancy-catalog.ts test/integration/core/database test/unit/modules/tenancy
git commit -m "feat(tenancy): delegation schema — org API keys and support grants with RLS, eligibility guards, the shared closure, deferred definer grantee/member checks, terminal states and two definer functions"
```

---

### Task 15: Helper seed 3D, cô lập, ràng buộc DB, trigger definer (đổi context trước COMMIT, T-19 ×50), hàm definer, `down`; kiểm chứng prod-like #2 (schema 3D chạy từ `dist`)

**Files:**
- Create: `test/integration/tenancy/delegation-db.spec.ts`, `test/integration/tenancy/delegation-isolation.spec.ts`, `test/integration/tenancy/delegation-definer.spec.ts`, `test/integration/tenancy/delegation-down.spec.ts`
- Modify: `test/support/tenancy-seed.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: migration Task 14, `seedOrg`, `seedMember`, `withAppClient`, `inOrgTx`, `createScratchDb`, `coreMigrationList`, `runMigrations`, `ownerQuery`, `TENANCY_ONLY_CATALOGUE` (3A/3C test support), hằng 3D (Task 14).
- Produces (helper test, dùng ở Task 18–27):
  - `newOrgApiKeyToken(): string` (`oak_` + 43 ký tự base64url), `orgApiKeyHint(token: string): string`.
  - `type SeededOrgApiKey = { id: string; publicId: string; token: string }`; `seedOrgApiKey(org: SeededOrg, o: { createdByMemberId: string; permissions: readonly string[]; name?: string; expiresInSec?: number; revoked?: boolean }): Promise<SeededOrgApiKey>`.
  - `type SeededSupportGrant = { id: string; publicId: string; granteeUserId: string | null }`; `seedSupportGrant(org: SeededOrg, o: { grantee: SeedSubject | null; grantedByMemberId: string | null; permissions: readonly string[]; reason?: string; expiresInSec?: number; revoked?: boolean }): Promise<SeededSupportGrant>` (upsert `tenancy_users` của người nhận trong cùng transaction; dòng mới được `dispose()` dọn).
  - `supportPresetKeys(merged: MergedCatalogue): string[]`, `apiKeyEligibleKeys(merged: MergedCatalogue): string[]` (tính từ catalogue gộp, R-X24).

- [ ] **Step 1: Helper seed**

`test/support/tenancy-seed.ts` — thêm (cuối file; import `randomBytes` đã có):
```ts
const ORG_API_KEY_TOKEN_BYTES = 32;
/** Token như app sinh (`oak_` + base64url 32 byte) — chỉ test. */
export const newOrgApiKeyToken = (): string => `oak_${randomBytes(ORG_API_KEY_TOKEN_BYTES).toString('base64url')}`;
/** `key_hint` = `oak_` + 6 ký tự đầu phần ngẫu nhiên (`org_api_keys_key_hint_ck`). */
export const orgApiKeyHint = (token: string): string => token.slice(0, 'oak_'.length + 6);
/** R-X24: tập quyền tính từ catalogue gộp, không viết cứng. */
export const apiKeyEligibleKeys = (merged: MergedCatalogue): string[] =>
  [...merged.values()].filter((e) => e.apiKeyEligible && !e.ownerOnly && !e.deprecated).map((e) => e.key).sort();
export const supportPresetKeys = (merged: MergedCatalogue): string[] =>
  [...merged.values()]
    .filter((e) => e.supportEligible && e.action === 'read' && !e.ownerOnly && !e.deprecated)
    .map((e) => e.key)
    .sort();

export type SeededOrgApiKey = { id: string; publicId: string; token: string };
/** Một transaction trong OrgScope; phạm vi chèn theo key (key lạ → không đủ dòng → ném). `created_at` lùi như lời mời. */
export async function seedOrgApiKey(
  org: SeededOrg,
  o: { createdByMemberId: string; permissions: readonly string[]; name?: string; expiresInSec?: number; revoked?: boolean },
): Promise<SeededOrgApiKey> {
  const token = newOrgApiKeyToken();
  const keys = [...new Set(o.permissions)];
  const row = await withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at, revoked_at, created_at)
           SELECT $1, $2, $3, decode($4, 'hex'), $5, e.at, CASE WHEN $6 THEN LEAST(now(), e.at - interval '1 hour') END,
                  LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $7::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [org.orgId, o.createdByMemberId, o.name ?? 'seed key', hashToken(token), orgApiKeyHint(token), o.revoked ?? false, o.expiresInSec ?? DEFAULT_SEED_TTL_SEC],
        );
        const key = rows[0];
        if (!key) throw new Error('seedOrgApiKey: insert returned no row');
        const inserted = await c.query(
          `INSERT INTO org_api_key_permissions (org_id, api_key_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = ANY($3::text[])`,
          [org.orgId, key.id, keys],
        );
        if (inserted.rowCount !== keys.length) throw new Error(`seedOrgApiKey: unknown permission in ${keys.join(',')}`);
        return key;
      }),
    databaseOf(org),
  );
  return { id: row.id, publicId: row.public_id, token };
}

export type SeededSupportGrant = { id: string; publicId: string; granteeUserId: string | null };
export async function seedSupportGrant(
  org: SeededOrg,
  o: {
    grantee: SeedSubject | null;
    grantedByMemberId: string | null;
    permissions: readonly string[];
    reason?: string;
    expiresInSec?: number;
    revoked?: boolean;
  },
): Promise<SeededSupportGrant> {
  const state = seedStateOf.get(org);
  if (!state) throw new Error('seedSupportGrant: org was not created by seedOrg');
  const keys = [...new Set(o.permissions)];
  return withAppClient(
    (c) =>
      inOrgTx(c, org.orgId, async () => {
        let granteeUserId: string | null = null;
        if (o.grantee) {
          const user = await upsertUser(c, o.grantee);
          if (user.created) state.createdUsers.push(user.id);
          granteeUserId = user.id;
        }
        const { rows } = await c.query<IdRow>(
          `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at, revoked_at, created_at)
           SELECT $1, $2, $3, $4, e.at, CASE WHEN $5 THEN LEAST(now(), e.at - interval '1 hour') END, LEAST(now(), e.at - interval '1 hour')
           FROM (SELECT now() + make_interval(secs => $6::double precision) AS at) e
           RETURNING id::text, public_id::text`,
          [org.orgId, granteeUserId, o.grantedByMemberId, o.reason ?? 'SUP-SEED', o.revoked ?? false, o.expiresInSec ?? DEFAULT_SEED_TTL_SEC],
        );
        const grant = rows[0];
        if (!grant) throw new Error('seedSupportGrant: insert returned no row');
        const inserted = await c.query(
          `INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = ANY($3::text[])`,
          [org.orgId, grant.id, keys],
        );
        if (inserted.rowCount !== keys.length) throw new Error(`seedSupportGrant: unknown permission in ${keys.join(',')}`);
        return { id: grant.id, publicId: grant.public_id, granteeUserId };
      }),
    state.database,
  );
}
```
(`DEFAULT_SEED_TTL_SEC`, `hashToken`, `databaseOf`, `upsertUser`, `seedStateOf` có sẵn trong file từ 3A/3C. `dispose()` dùng `PURGE_ORDER` mà `ORG_PURGE_STATEMENTS` của Task 14 đã mở rộng.)

- [ ] **Step 2: Ràng buộc DB và trigger hoãn (fail trước Task 14 nếu chạy riêng; ở đây chạy sau Task 14 — RED bằng cách tạm comment hai `CREATE CONSTRAINT TRIGGER` cuối `up`, chạy, thấy đỏ ở ca T-19 và ca context, rồi bỏ comment)**

`test/integration/tenancy/delegation-db.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import {
  TENANCY_ONLY_CATALOGUE,
  apiKeyEligibleKeys,
  hashToken,
  inOrgTx,
  newOrgApiKeyToken,
  orgApiKeyHint,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const RACE_ROUNDS = 50;
const FIXTURE_WRITE = 'zz_fixture.write';
/** Lỗi lúc COMMIT của trigger hoãn: `pg` ném ở câu COMMIT, `inOrgTx` ROLLBACK rồi ném lại. */
const commitFails = (p: Promise<unknown>, constraint: string) =>
  expect(p).rejects.toMatchObject({ code: '23514', constraint });

describe('delegation constraints at the database (spec SP3 §6.10–6.11, §18.1)', () => {
  let org: SeededOrg;
  let other: SeededOrg;
  const raceUsers: string[] = [];
  const sql = (o: SeededOrg, q: string, params: unknown[] = []) =>
    withAppClient((c) => inOrgTx(c, o.orgId, () => c.query(q, params)));
  const keyRow = (o: SeededOrg, extra: Partial<{ name: string; hint: string; hash: string; expires: string }> = {}) => {
    const t = newOrgApiKeyToken();
    return sql(
      o,
      `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at)
       VALUES ($1, $2, $3, decode($4, 'hex'), $5, ${extra.expires ?? "now() + interval '1 day'"}) RETURNING id::text`,
      [o.orgId, o.owner.memberId, extra.name ?? 'k', extra.hash ?? hashToken(t), extra.hint ?? orgApiKeyHint(t)],
    );
  };
  beforeAll(async () => {
    org = await seedOrg();
    other = await seedOrg();
    // Quyền fixture "support_eligible nhưng không phải read" (catalogue không có): chỉ để chứng minh luật P-2 của trigger.
    await ownerQuery(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('zz_fixture', 'write', false, true, true) ON CONFLICT (key) DO NOTHING`,
    );
  });
  afterAll(async () => {
    await org?.dispose();
    await other?.dispose();
    await ownerQuery(`DELETE FROM tenancy_users WHERE id = ANY($1::bigint[])`, [raceUsers]);
    await ownerQuery(`DELETE FROM permissions WHERE key = $1`, [FIXTURE_WRITE]);
  });

  it('key name, hint, hash length and expiry are CHECKed; token_hash is unique', async () => {
    await expect(keyRow(org, { name: ' padded' })).rejects.toMatchObject({ code: '23514', constraint: 'org_api_keys_name_ck' });
    await expect(keyRow(org, { name: 'x'.repeat(65) })).rejects.toMatchObject({ constraint: 'org_api_keys_name_ck' });
    await expect(keyRow(org, { hint: 'oak_abc' })).rejects.toMatchObject({ constraint: 'org_api_keys_key_hint_ck' });
    await expect(keyRow(org, { hash: 'ab'.repeat(16) })).rejects.toMatchObject({ constraint: 'org_api_keys_token_hash_ck' });
    await expect(keyRow(org, { expires: "now() - interval '1 second'" })).rejects.toMatchObject({ constraint: 'org_api_keys_expires_ck' });
    const k = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read'] });
    await expect(keyRow(org, { hash: hashToken(k.token) })).rejects.toMatchObject({ code: '23505', constraint: 'org_api_keys_token_hash_uq' });
  });
  it('key scope: only api-key-eligible, non-owner-only, non-deprecated permissions; closed under requires at COMMIT', async () => {
    await expect(seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read', 'org.update'] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'org_api_key_permissions_guard' });
    await expect(seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read', 'org.delete'] }))
      .rejects.toMatchObject({ constraint: 'org_api_key_permissions_guard' });
    // billing.read requires org.read (cả hai api-key-eligible): thiếu org.read → closure hoãn bắn lúc COMMIT.
    await commitFails(seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['billing.read'] }), 'org_api_key_permissions_closed_ck');
    const full = apiKeyEligibleKeys(TENANCY_ONLY_CATALOGUE);
    await expect(seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: full })).resolves.toBeDefined();
  });
  it('grant scope: support-eligible READ permissions only (P-2); closed under requires at COMMIT', async () => {
    const staff = { externalSubject: `test:${v7()}` };
    await expect(seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: ['org.read', 'billing.read'] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'org_support_grant_permissions_guard' });
    await expect(seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: [FIXTURE_WRITE] }))
      .rejects.toMatchObject({ constraint: 'org_support_grant_permissions_guard' });
    await commitFails(seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: ['invitations.read'] }), 'org_support_grant_permissions_closed_ck');
    await expect(seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: supportPresetKeys(TENANCY_ONLY_CATALOGUE) })).resolves.toBeDefined();
  });
  it('one unrevoked grant per (org, grantee); a revoked one does not count', async () => {
    const staff = { externalSubject: `test:${v7()}` };
    const preset = supportPresetKeys(TENANCY_ONLY_CATALOGUE);
    await seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: preset, revoked: true });
    await seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: preset });
    await expect(seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: preset }))
      .rejects.toMatchObject({ code: '23505', constraint: 'org_support_grants_active_uq' });
  });
  it('terminal states: a revoked key/grant stays revoked; first_used_at is written once', async () => {
    const k = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read'], revoked: true });
    await expect(sql(org, `UPDATE org_api_keys SET revoked_at = NULL WHERE id = $1`, [k.id])).rejects.toMatchObject({ constraint: 'org_api_keys_revoked_once' });
    const g = await seedSupportGrant(org, { grantee: { externalSubject: `test:${v7()}` }, grantedByMemberId: org.owner.memberId, permissions: ['org.read'] });
    await sql(org, `UPDATE org_support_grants SET first_used_at = clock_timestamp() WHERE id = $1`, [g.id]);
    await expect(sql(org, `UPDATE org_support_grants SET first_used_at = clock_timestamp() WHERE id = $1`, [g.id])).rejects.toMatchObject({ constraint: 'org_support_grants_first_used_once' });
    await sql(org, `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`, [g.id]);
    await expect(sql(org, `UPDATE org_support_grants SET revoked_at = NULL WHERE id = $1`, [g.id])).rejects.toMatchObject({ constraint: 'org_support_grants_revoked_once' });
  });
  it('removing the creator member cascades its keys and their scope (delegation never outlives the membership)', async () => {
    const m = await seedMember(org, 'ADMIN');
    const k = await seedOrgApiKey(org, { createdByMemberId: m.memberId, permissions: ['org.read'] });
    await sql(org, `DELETE FROM org_members WHERE id = $1`, [m.memberId]);
    expect((await sql(org, `SELECT 1 FROM org_api_keys WHERE id = $1`, [k.id])).rows).toEqual([]);
    expect((await sql(org, `SELECT 1 FROM org_api_key_permissions WHERE api_key_id = $1`, [k.id])).rows).toEqual([]);
  });
  it('a grant for a member → 23514 org_support_grants_grantee_not_member at COMMIT; a member while a grant is open → 23514 org_members_no_active_support_grant; after revocation the member insert passes', async () => {
    const subject = { externalSubject: `test:${v7()}` };
    await seedMember(org, 'MEMBER', subject);
    await commitFails(seedSupportGrant(org, { grantee: subject, grantedByMemberId: org.owner.memberId, permissions: ['org.read'] }), 'org_support_grants_grantee_not_member');
    const staff = { externalSubject: `test:${v7()}` };
    const g = await seedSupportGrant(org, { grantee: staff, grantedByMemberId: org.owner.memberId, permissions: ['org.read'] });
    await commitFails(seedMember(org, 'MEMBER', staff), 'org_members_no_active_support_grant');
    await sql(org, `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`, [g.id]);
    await expect(seedMember(org, 'MEMBER', staff)).resolves.toBeDefined();
  });
  it('the deferred triggers do not depend on app.org_id at COMMIT (definer + advisory lock): switching the org context before COMMIT still refuses', async () => {
    const subject = { externalSubject: `test:${v7()}` };
    const member = await seedMember(org, 'MEMBER', subject);
    await expect(
      withAppClient(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at)
             VALUES ($1, $2, $3, 'ctx', now() + interval '1 day') RETURNING id::text`,
            [org.orgId, member.userId, org.owner.memberId],
          );
          await c.query(`INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`, [org.orgId, rows[0]!.id]);
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [other.orgId]); // dưới FORCE RLS một trigger quyền caller sẽ mù ở đây
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'org_support_grants_grantee_not_member' });
  });
  it('REPEATABLE READ is refused by both deferred triggers (they rely on a fresh snapshot after the lock)', async () => {
    const staff = { externalSubject: `test:${v7()}` };
    await expect(
      withAppClient(async (c) => {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
          const { rows } = await c.query<{ id: string }>(`INSERT INTO tenancy_users (external_subject) VALUES ($1) RETURNING id::text`, [staff.externalSubject]);
          await c.query(`INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`, [org.orgId, rows[0]!.id, org.roles.MEMBER.id]);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'org_members_no_active_support_grant' });
  });
  it(`X-12 / T-19: two direct SQL connections (no org lock) — one INSERT member, one INSERT grant for the same user — ×${RACE_ROUNDS} → exactly one commits`, async () => {
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const subject = `test:${v7()}`;
      const user = (await ownerQuery<{ id: string }>(`INSERT INTO tenancy_users (external_subject) VALUES ($1) RETURNING id::text`, [subject]))[0]!.id;
      raceUsers.push(user);
      const asMember = withAppClient((c) =>
        inOrgTx(c, org.orgId, () => c.query(`INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`, [org.orgId, user, org.roles.MEMBER.id])),
      );
      const asGrantee = withAppClient((c) =>
        inOrgTx(c, org.orgId, async () => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at) VALUES ($1, $2, $3, 'race', now() + interval '1 day') RETURNING id::text`,
            [org.orgId, user, org.owner.memberId],
          );
          await c.query(`INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`, [org.orgId, rows[0]!.id]);
        }),
      );
      const results = await Promise.allSettled([asMember, asGrantee]);
      expect(results.filter((r) => r.status === 'fulfilled'), `round ${i}`).toHaveLength(1);
      for (const r of results)
        if (r.status === 'rejected')
          expect(r.reason).toMatchObject({ code: '23514', constraint: expect.stringMatching(/^(org_members_no_active_support_grant|org_support_grants_grantee_not_member)$/) });
    }
  }, 120_000);
  it('deleting the grantee tenancy user sets grantee_user_id NULL; deleting the granter member sets granted_by_member_id NULL', async () => {
    const staffSub = `test:${v7()}`;
    const g = await seedSupportGrant(org, { grantee: { externalSubject: staffSub }, grantedByMemberId: org.owner.memberId, permissions: ['org.read'] });
    const owner2 = await seedMember(org, 'OWNER');
    const g2 = await seedSupportGrant(org, { grantee: { externalSubject: `test:${v7()}` }, grantedByMemberId: owner2.memberId, permissions: ['org.read'] });
    await sql(org, `UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`, [g.id]);
    await withAppClient((c) => c.query(`DELETE FROM tenancy_users WHERE external_subject = $1`, [staffSub]));
    await sql(org, `DELETE FROM org_members WHERE id = $1`, [owner2.memberId]);
    expect((await sql(org, `SELECT id::text AS id, grantee_user_id, granted_by_member_id FROM org_support_grants WHERE id = ANY($1::bigint[]) ORDER BY id`, [[g.id, g2.id]])).rows).toEqual([
      { id: g.id, grantee_user_id: null, granted_by_member_id: org.owner.memberId },
      { id: g2.id, grantee_user_id: g2.granteeUserId, granted_by_member_id: null },
    ]);
  });
});
```
(Không import `pg`: file chỉ dùng helper.)

`test/integration/tenancy/delegation-isolation.spec.ts` (tiêu chí 1, mẫu `acquisition-isolation.spec.ts`):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { TENANCY_TENANT_TABLES_3D } from '../../support/tenancy-catalog.js';
import {
  hashToken,
  inOrgTx,
  newOrgApiKeyToken,
  orgApiKeyHint,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 tiêu chí 1 cho bốn bảng 3D, bằng `app_user` qua kết nối thật (không qua RLS-bypass nào). */
describe('delegation tables are isolated by RLS (tiêu chí 1, phần 3D)', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  let keyB: { id: string };
  let grantB: { id: string };
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
    keyB = await seedOrgApiKey(b, { createdByMemberId: b.owner.memberId, permissions: ['org.read'] });
    grantB = await seedSupportGrant(b, { grantee: { externalSubject: `test:${v7()}` }, grantedByMemberId: b.owner.memberId, permissions: ['org.read'] });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });
  const inA = <T>(fn: (c: import('pg').Client) => Promise<T>) => withAppClient((c) => inOrgTx(c, a.orgId, () => fn(c)));

  it.each([...TENANCY_TENANT_TABLES_3D])('%s: rows of org B are invisible, not updatable, not deletable from OrgScope(A)', async (t) => {
    expect((await inA((c) => c.query(`SELECT 1 FROM ${t} WHERE org_id = $1`, [b.orgId]))).rows).toEqual([]);
    expect((await inA((c) => c.query(`UPDATE ${t} SET updated_at = now() WHERE org_id = $1`, [b.orgId]))).rowCount).toBe(0);
    expect((await inA((c) => c.query(`DELETE FROM ${t} WHERE org_id = $1`, [b.orgId]))).rowCount).toBe(0);
  });
  it.each([...TENANCY_TENANT_TABLES_3D])('%s: no org context → P0001', async (t) => {
    await expect(withAppClient((c) => c.query(`SELECT 1 FROM ${t}`))).rejects.toMatchObject({ code: 'P0001' });
  });
  it('INSERT with org_id = B from OrgScope(A) → 42501; a bridge row pointing at a parent of org B → 23503', async () => {
    const t = newOrgApiKeyToken();
    await expect(
      inA((c) => c.query(
        `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at) VALUES ($1, $2, 'x', decode($3, 'hex'), $4, now() + interval '1 day')`,
        [b.orgId, b.owner.memberId, hashToken(t), orgApiKeyHint(t)],
      )),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inA((c) => c.query(`INSERT INTO org_api_key_permissions (org_id, api_key_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`, [a.orgId, keyB.id])),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inA((c) => c.query(`INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id) SELECT $1, $2, id FROM permissions WHERE key = 'org.read'`, [a.orgId, grantB.id])),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inA((c) => c.query(
        `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at) VALUES ($1, $2, 'x', decode($3, 'hex'), $4, now() + interval '1 day')`,
        [a.orgId, b.owner.memberId, hashToken(t), orgApiKeyHint(t)],
      )),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
```

`test/integration/tenancy/delegation-definer.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import {
  hashToken,
  newOrgApiKeyToken,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Spec SP3 §6.14 (3D), §18.1 "Hàm definer": gọi bằng app_user KHÔNG có org context; tham số ngoài biên → lỗi. */
describe('3D definer functions', () => {
  let a: SeededOrg;
  let b: SeededOrg;
  beforeAll(async () => {
    a = await seedOrg();
    b = await seedOrg();
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });
  const find = (hex: string | null) =>
    withAppClient((c) => c.query(`SELECT org_id::text, api_key_id::text, api_key_public_id::text FROM tenancy_find_org_api_key(decode($1, 'hex'))`, [hex]));

  it('tenancy_find_org_api_key: an active key → (org, id, public id); revoked, expired and unknown → empty; NULL or not 32 bytes → error', async () => {
    const live = await seedOrgApiKey(a, { createdByMemberId: a.owner.memberId, permissions: ['org.read'] });
    const revoked = await seedOrgApiKey(a, { createdByMemberId: a.owner.memberId, permissions: ['org.read'], revoked: true });
    const expired = await seedOrgApiKey(a, { createdByMemberId: a.owner.memberId, permissions: ['org.read'], expiresInSec: -60 });
    expect((await find(hashToken(live.token))).rows).toEqual([{ org_id: a.orgId, api_key_id: live.id, api_key_public_id: live.publicId }]);
    for (const k of [revoked, expired]) expect((await find(hashToken(k.token))).rows).toEqual([]);
    expect((await find(hashToken(newOrgApiKeyToken()))).rows).toEqual([]);
    await expect(find(null)).rejects.toThrow(/must not be NULL/);
    await expect(find('ab'.repeat(31))).rejects.toThrow(/must be 32 bytes/);
  });
  it('tenancy_grantee_open_grant_orgs: every org with an unrevoked grant of the user (expired included), ordered; revoked ignored; NULL → error', async () => {
    const subject = { externalSubject: `test:${v7()}` };
    await seedSupportGrant(a, { grantee: subject, grantedByMemberId: a.owner.memberId, permissions: ['org.read'], expiresInSec: -60 });
    const gb = await seedSupportGrant(b, { grantee: subject, grantedByMemberId: b.owner.memberId, permissions: ['org.read'] });
    const call = (id: string | null) => withAppClient((c) => c.query<{ org_id: string }>(`SELECT org_id::text FROM tenancy_grantee_open_grant_orgs($1)`, [id]));
    expect((await call(gb.granteeUserId)).rows.map((r) => r.org_id)).toEqual([a.orgId, b.orgId].sort());
    await withAppClient((c) => c.query(`SELECT set_config('app.org_id', $1, false)`, [b.orgId]).then(() => c.query(`UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`, [gb.id])));
    expect((await call(gb.granteeUserId)).rows.map((r) => r.org_id)).toEqual([a.orgId]);
    await expect(call(null)).rejects.toThrow(/must not be NULL/);
  });
  it('T2: dropping a 3D definer function as bare app_owner → 42501; under SET LOCAL ROLE tenancy_definer it would pass (rolled back)', async () => {
    await expect(ownerQuery(`DROP FUNCTION public.tenancy_find_org_api_key(bytea)`)).rejects.toMatchObject({ code: '42501' });
    await expect(
      ownerQuery(`BEGIN; SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.tenancy_grantee_open_grant_orgs(bigint); RESET ROLE; ROLLBACK;`),
    ).resolves.toBeDefined();
  });
});
```
(`ownerQuery` gửi chuỗi nhiều câu qua simple protocol khi không có tham số: `pg` chấp nhận; ca cuối không để lại thay đổi vì `ROLLBACK`.)

`test/integration/tenancy/delegation-down.spec.ts` (mẫu `acquisition-down.spec.ts`):
```ts
import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../src/core/database/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedOrg, seedOrgApiKey, seedSupportGrant, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/** Spec SP3 §6.13 "Down khi có dữ liệu chặn → lỗi rõ ràng": bỏ bốn bảng khi còn key/grant đang dùng được là xoá credential âm thầm. */
describe('down of …_delegation refuses while a key or a grant is still usable', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  let org: SeededOrg;
  const inOrg = <T>(fn: (c: pg.Client) => Promise<T>) => withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)), db.name);
  const down = () => runMigrations('down', { source: { kind: 'list', list }, to: previous });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('delegdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_delegation'));
    if (at < 1) throw new Error('delegation migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
    org = await seedOrg({ database: db.name });
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('an active key blocks; then an active grant blocks; once both are revoked the down drops tables, triggers and functions', async () => {
    const k = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read'] });
    await expect(down()).rejects.toThrow(/unrevoked organization API keys or support grants exist/);
    await inOrg((c) => c.query(`UPDATE org_api_keys SET revoked_at = clock_timestamp() WHERE id = $1`, [k.id]));
    const g = await seedSupportGrant(org, { grantee: { externalSubject: `test:${v7()}` }, grantedByMemberId: org.owner.memberId, permissions: ['org.read'] });
    await expect(down()).rejects.toThrow(/unrevoked organization API keys or support grants exist/);
    await inOrg((c) => c.query(`UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE id = $1`, [g.id]));
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    const owner = await db.client('owner');
    try {
      expect((await owner.query(`SELECT proname FROM pg_proc WHERE proname LIKE 'tenancy\\_%' AND (proname LIKE '%org\\_api\\_key%' OR proname LIKE '%support\\_grant%' OR proname = 'tenancy_grantee_open_grant_orgs')`)).rows).toEqual([]);
      expect((await owner.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'org_members_no_active_support_grant'`)).rows).toEqual([]);
      expect((await owner.query(`SELECT proname FROM pg_proc WHERE proname = 'tenancy_permission_scope_closed_ck'`)).rows).toHaveLength(1);
    } finally {
      await owner.end();
    }
  });
});
```

Run: `pnpm vitest run --project integration test/integration/tenancy/delegation-db.spec.ts test/integration/tenancy/delegation-isolation.spec.ts test/integration/tenancy/delegation-definer.spec.ts test/integration/tenancy/delegation-down.spec.ts`
Expected (RED có chủ đích ở Step 2): với hai constraint trigger cuối bị comment, ca context và ca T-19 đỏ (member và grant cùng commit). Bỏ comment, `pnpm build`, chạy lại → PASS.

- [ ] **Step 3: Prod-like #2 — schema 3D chạy từ `dist`**

`test/smoke/tenancy.smoke.spec.ts` — thêm ca sau ca schema 3C (import `TENANCY_TENANT_TABLES_3D`, `DEFINER_FUNCTIONS_3D`, `DEFINER_TRIGGER_FUNCTIONS_3D` từ `../support/tenancy-catalog.js`):
```ts
  it('the delegation schema of 3D migrated from dist: FORCE RLS on four tables, definer functions and deferred definer triggers owned by tenancy_definer', () => {
    const tables = [...TENANCY_TENANT_TABLES_3D].sort();
    expect(
      psql(`SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${tables.map((t) => `'${t}'`).join(', ')})`),
    ).toBe(tables.map((t) => `${t}:true:true`).join(','));
    const fns = [...DEFINER_FUNCTIONS_3D, ...DEFINER_TRIGGER_FUNCTIONS_3D].sort();
    expect(
      psql(`SELECT string_agg(proname || ':' || pg_get_userbyid(proowner) || ':' || prosecdef::text, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${fns.map((f) => `'${f}'`).join(', ')})`),
    ).toBe(fns.map((f) => `${f}:tenancy_definer:true`).join(','));
    expect(
      psql(`SELECT string_agg(conname || ':' || condeferrable::text || ':' || condeferred::text, ',' ORDER BY conname) FROM pg_constraint WHERE conname IN ('org_api_key_permissions_closed_ck', 'org_members_no_active_support_grant', 'org_support_grant_permissions_closed_ck', 'org_support_grants_grantee_not_member')`),
    ).toBe('org_api_key_permissions_closed_ck:true:true,org_members_no_active_support_grant:true:true,org_support_grant_permissions_closed_ck:true:true,org_support_grants_grantee_not_member:true:true');
  });
```
Run: `pnpm test:smoke`
Expected: image production build; migrate từ `dist` tới `…_delegation`; ca mới PASS cùng mọi ca có sẵn (Task 13 đã sửa ca identity); log sạch; `down -v`.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/support/tenancy-seed.ts test/integration/tenancy test/smoke/tenancy.smoke.spec.ts
pnpm typecheck && pnpm lint
git add test/support/tenancy-seed.ts test/integration/tenancy test/smoke/tenancy.smoke.spec.ts
git commit -m "test(tenancy): delegation seed helpers, isolation, DB constraints, deferred definer triggers (context switch, T-19 x50), definer functions, guarded down; 3D schema on the production image"
```

---

## Phần D — Nền ứng dụng của ủy quyền: config, lỗi, event, metric, miền, repository (spec §8.5, §10, §13–§16)

### Task 16: Config 3D, cờ `supportGrants` của `resolveTenancyFeatures` (U17 đủ 3 cờ), lỗi + map constraint, event key/grant, metric, luật escalation `delegation`, registry participant `order` duy nhất (addendum A4 luật 1)

**Files:**
- Modify: `src/modules/tenancy/tenancy.config.ts`, `src/modules/tenancy/domain/tenancy-features.ts`, `src/modules/tenancy/application/tenancy-features.ts`, `src/modules/tenancy/errors.ts`, `src/modules/tenancy/events.ts`, `src/modules/tenancy/index.ts`, `src/modules/tenancy/application/tenancy-metrics.ts`, `src/modules/tenancy/domain/escalation.ts`, `src/modules/tenancy/application/org-purge-participant.registry.ts`, `test/unit/modules/tenancy/tenancy-features.spec.ts`, `test/unit/modules/tenancy/tenancy-config.spec.ts`, `test/unit/modules/tenancy/registries.spec.ts`, `test/unit/core/events/event-flags.spec.ts`, `.env.example` (sinh lại)
- Create: `src/modules/tenancy/domain/org-api-key.ts` (chỉ hằng lý do ở task này; Task 17 thêm phần token), `src/modules/tenancy/domain/support-grant.ts` (hằng lý do)

**Interfaces:**
- Consumes: `defineConfig`, `defineConfigRule`, `FEATURE_TRI_STATES`, `resolveTenancyFeatures`, `featureConfigProblems`, `TenancyFeatures` (3C), `defineEvent` (6.0 R-X3), `defineErrorCodes`, `defineConstraintErrors`, `EscalationRule` (3A/3B).
- Produces:
  - `TenancyConfig` thêm `orgApiKeyMaxTtlSec` (`TENANCY_ORG_API_KEY_MAX_TTL_SEC`, mặc định `31536000`, 86400–63072000), `maxActiveOrgApiKeysPerMember` (`TENANCY_MAX_ACTIVE_ORG_API_KEYS_PER_MEMBER`, `20`, 1–1000), `supportGrants` (`TENANCY_SUPPORT_GRANTS`, `auto`), `supportGrantMaxTtlSec` (`TENANCY_SUPPORT_GRANT_MAX_TTL_SEC`, `259200`, 900–259200), `supportStepUpMaxAgeSec` (`TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC`, `3600`, 300–86400).
  - `FeatureDisabledReason` thêm `'EXTERNAL_MODE'`; `TenancyFeatureStates.supportGrants`; `TenancyFeatureInput.supportGrants: FeatureTriState`; `TenancyFeatures.require('supportGrants')`.
  - `TenancyErrors.PERMISSION_NOT_API_KEY_ELIGIBLE` (422 `permission_not_api_key_eligible`), `PERMISSION_NOT_SUPPORT_ELIGIBLE` (422 `permission_not_support_eligible`), `SUPPORT_GRANTEE_INELIGIBLE` (422 `support_grantee_ineligible`), `API_KEYS_LIMIT` (422 `api_keys_limit`); map 12 constraint của Task 14.
  - `domain/org-api-key.ts`: `API_KEY_REVOKE_REASONS = ['REVOKED', 'CREATOR_REMOVED'] as const`, `type ApiKeyRevokeReason`; `domain/support-grant.ts`: `SUPPORT_GRANT_REVOKE_REASONS = ['REVOKED', 'GRANTEE_BECAME_MEMBER', 'GRANTEE_ROLE_CHANGED'] as const`, `type SupportGrantRevokeReason`.
  - Event (`audit: true, webhook: false`, export ở `index.ts`): `ApiKeyCreatedEvent` `tenancy.api_key.created` `{ apiKeyId, createdByMemberId, permissions, expiresAt }`; `ApiKeyRevokedEvent` `{ apiKeyId, reason }`; `ApiKeyScopeNarrowedEvent` `{ apiKeyId, permissions }`; `SupportAccessGrantedEvent`/`SupportAccessUsedEvent` `{ grantId, granteeUserId: uuid | null, grantedByMemberId: uuid | null, permissions, expiresAt }`; `SupportAccessRevokedEvent` (cùng + `reason`); `SupportAccessScopeNarrowedEvent` `{ grantId, permissions }`.
  - `TenancyMetrics.orgApiKeyAuth` (`tenancy_org_api_key_auth_total{result}`, `result` ∈ `ok | invalid | creator_banned | creator_unverified | unavailable`), `.supportAccess` (`tenancy_support_access_requests_total{result}`, ∈ `granted | no_grant | no_second_factor | second_factor_stale | granter_not_owner`), `.supportGrantsRevokedOnRoleChange` (`tenancy_support_grants_revoked_on_role_change_total`); `type OrgApiKeyAuthResult`, `type SupportAccessResult`.
  - `EscalationRule` thêm `'delegation'`.
  - `OrgPurgeParticipantRegistry` từ chối `order` trùng (spec §8.2, addendum A4 luật 1).

- [ ] **Step 1: Test (fail)**

`test/unit/modules/tenancy/tenancy-features.spec.ts` — mọi object input có sẵn thêm `supportGrants: 'off'` (ba vòng lặp và hai ca `featureConfigProblems`); thêm cuối `describe`:
```ts
  for (const mode of MODES)
    for (const value of FEATURE_TRI_STATES)
      it(`supportGrants=${value}, mode=${mode} (U17: needs Better Auth sessions; off in external)`, () => {
        const states = resolveTenancyFeatures(
          { emailInvitations: 'off', invitationAcceptUrl: undefined, inviteLinks: 'off', inviteLinkJoinUrl: undefined, supportGrants: value },
          { mode, externalEmailClaim: undefined },
        );
        expect(states.supportGrants).toEqual(
          value === 'off' ? { enabled: false, reason: 'OFF' } : mode === 'external' ? { enabled: false, reason: 'EXTERNAL_MODE' } : on,
        );
      });
  it('TENANCY_SUPPORT_GRANTS=on in external mode is a config error; auto stays quiet', () => {
    const t = { emailInvitations: 'off', invitationAcceptUrl: undefined, inviteLinks: 'off', inviteLinkJoinUrl: undefined, supportGrants: 'on' } as const;
    expect(featureConfigProblems(t, resolveTenancyFeatures(t, { mode: 'external', externalEmailClaim: undefined }))).toEqual([
      'TENANCY_SUPPORT_GRANTS=on needs AUTH_MODE=local or hybrid (support grants rely on Better Auth sessions and their second factor)',
    ]);
    const auto = { ...t, supportGrants: 'auto' } as const;
    expect(featureConfigProblems(auto, resolveTenancyFeatures(auto, { mode: 'external', externalEmailClaim: undefined }))).toEqual([]);
  });
```
`test/unit/modules/tenancy/tenancy-config.spec.ts` — thêm (theo cách file đang parse schema, ví dụ `tenancyConfig.schema.parse({...})`):
```ts
  it('3D defaults and bounds (spec §13)', () => {
    const d = tenancyConfig.schema.parse({});
    expect([d.orgApiKeyMaxTtlSec, d.maxActiveOrgApiKeysPerMember, d.supportGrants, d.supportGrantMaxTtlSec, d.supportStepUpMaxAgeSec])
      .toEqual([31_536_000, 20, 'auto', 259_200, 3_600]);
    for (const bad of [
      { orgApiKeyMaxTtlSec: '86399' }, { orgApiKeyMaxTtlSec: '63072001' },
      { maxActiveOrgApiKeysPerMember: '0' }, { maxActiveOrgApiKeysPerMember: '1001' },
      { supportGrantMaxTtlSec: '899' }, { supportGrantMaxTtlSec: '259201' },
      { supportStepUpMaxAgeSec: '299' }, { supportStepUpMaxAgeSec: '86401' },
      { supportGrants: 'yes' },
    ])
      expect(tenancyConfig.schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
```
`test/unit/modules/tenancy/registries.spec.ts` — ca `participants with the same order run by key, not by registration order` thay bằng:
```ts
  it('addendum A4 rule 1 (spec §8.2): two participants with the same order refuse to boot', async () => {
    await expect(
      boot([{ module: class Z {}, providers: [Zeta] }, { module: class Al {}, providers: [Alpha] }]),
    ).rejects.toThrow(/Duplicate org purge participant order 3 \("alpha", "zeta"\)/);
  });
```
`test/unit/core/events/event-flags.spec.ts` — `EXPECTED` thêm bảy dòng 3D:
```ts
    'tenancy.api_key.created@1': { audit: true, webhook: false },
    'tenancy.api_key.revoked@1': { audit: true, webhook: false },
    'tenancy.api_key.scope_narrowed@1': { audit: true, webhook: false },
    'tenancy.support_access.granted@1': { audit: true, webhook: false },
    'tenancy.support_access.used@1': { audit: true, webhook: false },
    'tenancy.support_access.revoked@1': { audit: true, webhook: false },
    'tenancy.support_access.scope_narrowed@1': { audit: true, webhook: false },
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy test/unit/core/events/event-flags.spec.ts`
Expected: FAIL (khoá `supportGrants` không có; event không tồn tại; order trùng vẫn boot).

- [ ] **Step 2: Config và cờ**

`src/modules/tenancy/domain/tenancy-features.ts`:
```ts
export type FeatureDisabledReason =
  'OFF' | 'MISSING_ACCEPT_URL' | 'MISSING_JOIN_URL' | 'MISSING_EMAIL_CLAIM' | 'EXTERNAL_MODE';
export type TenancyFeatureStates = {
  emailInvitations: FeatureState;
  inviteLinks: FeatureState;
  /** 3D (spec §11, §13): support grant cần session Better Auth và factor 2FA của nó; `external` → tắt. */
  supportGrants: FeatureState;
};
export type TenancyFeatureInput = {
  emailInvitations: FeatureTriState;
  invitationAcceptUrl: string | undefined;
  inviteLinks: FeatureTriState;
  inviteLinkJoinUrl: string | undefined;
  supportGrants: FeatureTriState;
};
```
trong `resolveTenancyFeatures` thêm `const supportGrants = t.supportGrants === 'off' ? disabled('OFF') : id.mode === 'external' ? disabled('EXTERNAL_MODE') : ENABLED;` và trả `{ emailInvitations, inviteLinks, supportGrants }`; `need()` thêm:
```ts
    case 'EXTERNAL_MODE':
      return 'AUTH_MODE=local or hybrid (support grants rely on Better Auth sessions and their second factor)';
```
`featureConfigProblems` thêm:
```ts
  if (t.supportGrants === 'on' && !s.supportGrants.enabled)
    out.push(`TENANCY_SUPPORT_GRANTS=on needs ${need(s.supportGrants.reason)}`);
```
`src/modules/tenancy/application/tenancy-features.ts` — log thêm `supportGrants: labelOf(this.states.supportGrants)` và câu log đổi thành `'tenancy features resolved'`.

`src/modules/tenancy/tenancy.config.ts`:
```ts
const MAX_ORG_API_KEY_TTL_SEC = 2 * 365 * SECONDS_PER_DAY;
const MAX_ACTIVE_ORG_API_KEYS = 1000;
const MIN_SUPPORT_GRANT_TTL_SEC = 15 * 60;
/** Trần cứng 72 h mọi môi trường (spec §13): grant là quyền truy cập ngắn hạn của nhân viên. */
const SUPPORT_GRANT_TTL_CEILING_SEC = 72 * SECONDS_PER_HOUR;
const MIN_STEP_UP_AGE_SEC = 5 * 60;
```
(đặt sau `MAX_ACTIVE_INVITE_LINKS`; `SECONDS_PER_HOUR` đã có). Bảng env thêm:
```ts
    orgApiKeyMaxTtlSec: 'TENANCY_ORG_API_KEY_MAX_TTL_SEC',
    maxActiveOrgApiKeysPerMember: 'TENANCY_MAX_ACTIVE_ORG_API_KEYS_PER_MEMBER',
    supportGrants: 'TENANCY_SUPPORT_GRANTS',
    supportGrantMaxTtlSec: 'TENANCY_SUPPORT_GRANT_MAX_TTL_SEC',
    supportStepUpMaxAgeSec: 'TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC',
```
schema thêm:
```ts
    orgApiKeyMaxTtlSec: positiveInt
      .min(SECONDS_PER_DAY)
      .max(MAX_ORG_API_KEY_TTL_SEC)
      .default(31_536_000)
      .describe('Longest lifetime (expiresInSec) of an organization API key'),
    maxActiveOrgApiKeysPerMember: positiveInt
      .max(MAX_ACTIVE_ORG_API_KEYS)
      .default(20)
      .describe('Unrevoked, unexpired organization API keys one member may hold'),
    supportGrants: triState
      .default('auto')
      .describe('auto: on in local/hybrid, off in external; on: required (refused in external); off'),
    supportGrantMaxTtlSec: positiveInt
      .min(MIN_SUPPORT_GRANT_TTL_SEC)
      .max(SUPPORT_GRANT_TTL_CEILING_SEC)
      .default(259_200)
      .describe('Longest lifetime (expiresInSec) of a support grant (hard ceiling 72 hours)'),
    supportStepUpMaxAgeSec: positiveInt
      .min(MIN_STEP_UP_AGE_SEC)
      .max(SECONDS_PER_DAY)
      .default(3_600)
      .describe('A request through a support grant needs a second-factor step-up of the same session no older than this'),
```
`FeatureRuleInput.tenancy` thêm `supportGrants: triState`.

Run: `pnpm env:example`
Expected: `.env.example` thêm 5 khoá với mô tả trên (không file nào khác đổi).

- [ ] **Step 3: Lỗi, event, metric, luật, registry**

`src/modules/tenancy/errors.ts` — trong `TenancyErrors` thêm:
```ts
  PERMISSION_NOT_API_KEY_ELIGIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This permission cannot be delegated to an API key',
  },
  PERMISSION_NOT_SUPPORT_ELIGIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This permission cannot be delegated to a support grant',
  },
  /** Spec §9.7: một mã cho mọi lý do (không phải nhân viên, chưa có 2FA, bị ban, là member, không tồn tại) — không lộ lý do. */
  SUPPORT_GRANTEE_INELIGIBLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'This user cannot receive a support grant',
  },
  API_KEYS_LIMIT: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Active API key limit reached',
  },
```
và cuối file:
```ts
/** Constraint/trigger của migration `delegation` (3D) → mã; tên không bao giờ ra client. */
defineConstraintErrors({
  org_api_key_permissions_guard: TenancyErrors.PERMISSION_NOT_API_KEY_ELIGIBLE,
  org_support_grant_permissions_guard: TenancyErrors.PERMISSION_NOT_SUPPORT_ELIGIBLE,
  org_api_key_permissions_closed_ck: TenancyErrors.MISSING_DEPENDENCIES,
  org_support_grant_permissions_closed_ck: TenancyErrors.MISSING_DEPENDENCIES,
  org_support_grants_grantee_not_member: TenancyErrors.SUPPORT_GRANTEE_INELIGIBLE,
  // Đường app thu hồi grant TRƯỚC khi thêm member/cấp lại (spec §9 MemberAdmission, §9.7): tới được đây là đua với SQL tay.
  org_members_no_active_support_grant: CoreErrors.CONFLICT,
  org_support_grants_active_uq: CoreErrors.CONFLICT,
  org_api_keys_revoked_once: CoreErrors.CONFLICT,
  org_support_grants_revoked_once: CoreErrors.CONFLICT,
  org_support_grants_first_used_once: CoreErrors.CONFLICT,
  // Lớp chặn cuối nếu zod và `btrim`/`char_length` của Postgres lệch nhau trên một ký tự: 422, không 500.
  org_api_keys_name_ck: CoreErrors.VALIDATION_FAILED,
  org_support_grants_reason_ck: CoreErrors.VALIDATION_FAILED,
});
```
`src/modules/tenancy/domain/org-api-key.ts`:
```ts
/** Spec §14: lý do thu hồi org key (chuyển trạng thái ngầm khi người tạo bị gỡ: §14.1). */
export const API_KEY_REVOKE_REASONS = ['REVOKED', 'CREATOR_REMOVED'] as const;
export type ApiKeyRevokeReason = (typeof API_KEY_REVOKE_REASONS)[number];
```
`src/modules/tenancy/domain/support-grant.ts`:
```ts
/** Spec §14, §14.1: thu hồi tường minh, người nhận thành member (SEC-M5), role nền tảng của người nhận được ghi (N5-1). */
export const SUPPORT_GRANT_REVOKE_REASONS = ['REVOKED', 'GRANTEE_BECAME_MEMBER', 'GRANTEE_ROLE_CHANGED'] as const;
export type SupportGrantRevokeReason = (typeof SUPPORT_GRANT_REVOKE_REASONS)[number];
```
`src/modules/tenancy/events.ts` — cuối file (import `API_KEY_REVOKE_REASONS`, `SUPPORT_GRANT_REVOKE_REASONS`):
```ts
/**
 * Event của 3D (spec SP3 §14): chỉ id công khai; không `key_hint`, không `reason` của grant, không token. `granteeUserId`
 * là `tenancy_users.public_id` (`null` khi tài khoản nhân viên đã bị xoá: FK SET NULL); `grantedByMemberId` `null` khi
 * owner cấp đã rời org. Cờ R-X3: vào audit, không phải hợp đồng webhook công khai.
 */
const apiKey = z.object({ apiKeyId: id, createdByMemberId: id, permissions: permissionKeys, expiresAt: z.iso.datetime() });
const grant = z.object({
  grantId: id,
  granteeUserId: id.nullable(),
  grantedByMemberId: id.nullable(),
  permissions: permissionKeys,
  expiresAt: z.iso.datetime(),
});
export const ApiKeyCreatedEvent = defineEvent({ type: 'tenancy.api_key.created', version: 1, schema: apiKey, audit: true, webhook: false });
export const ApiKeyRevokedEvent = defineEvent({
  type: 'tenancy.api_key.revoked',
  version: 1,
  schema: z.object({ apiKeyId: id, reason: z.enum(API_KEY_REVOKE_REASONS) }),
  audit: true,
  webhook: false,
});
export const ApiKeyScopeNarrowedEvent = defineEvent({
  type: 'tenancy.api_key.scope_narrowed',
  version: 1,
  schema: z.object({ apiKeyId: id, permissions: permissionKeys }),
  audit: true,
  webhook: false,
});
export const SupportAccessGrantedEvent = defineEvent({ type: 'tenancy.support_access.granted', version: 1, schema: grant, audit: true, webhook: false });
export const SupportAccessUsedEvent = defineEvent({ type: 'tenancy.support_access.used', version: 1, schema: grant, audit: true, webhook: false });
export const SupportAccessRevokedEvent = defineEvent({
  type: 'tenancy.support_access.revoked',
  version: 1,
  schema: grant.extend({ reason: z.enum(SUPPORT_GRANT_REVOKE_REASONS) }),
  audit: true,
  webhook: false,
});
export const SupportAccessScopeNarrowedEvent = defineEvent({
  type: 'tenancy.support_access.scope_narrowed',
  version: 1,
  schema: z.object({ grantId: id, permissions: permissionKeys }),
  audit: true,
  webhook: false,
});
```
(`permissionKeys` và `id` là hằng có sẵn ở đầu file.) `src/modules/tenancy/index.ts` — thêm bảy event vào khối `export { … } from './events.js'`.

`src/modules/tenancy/application/tenancy-metrics.ts`:
```ts
export type OrgApiKeyAuthResult = 'ok' | 'invalid' | 'creator_banned' | 'creator_unverified' | 'unavailable';
export type SupportAccessResult = 'granted' | 'no_grant' | 'no_second_factor' | 'second_factor_stale' | 'granter_not_owner';
```
và trong lớp:
```ts
  readonly orgApiKeyAuth = this.meter.createCounter('tenancy_org_api_key_auth_total', {
    description: 'Organization API key authentications by result',
  });
  readonly supportAccess = this.meter.createCounter('tenancy_support_access_requests_total', {
    description: 'Requests of platform staff without a membership that looked for a support grant, by result',
  });
  readonly supportGrantsRevokedOnRoleChange = this.meter.createCounter('tenancy_support_grants_revoked_on_role_change_total', {
    description: 'Support grants revoked because the platform role of their grantee was written',
  });
```
`src/modules/tenancy/domain/escalation.ts`: `export type EscalationRule = '1' | '2' | '2a' | '3' | '4' | '5' | '6' | 'delegation';` (spec §16 `tenancy_escalation_denied_total{rule}`).

`src/modules/tenancy/application/org-purge-participant.registry.ts` — trước `found.push(...)`:
```ts
      const sameOrder = found.find((p) => p.order === meta.order);
      if (sameOrder)
        throw new Error(
          `Duplicate org purge participant order ${meta.order} (${[sameOrder.key, meta.key].sort().map((k) => `"${k}"`).join(', ')}): each participant needs its own order (spec SP3 §8.2, addendum 3D §A4)`,
        );
```
và sắp chỉ theo `order` (`found.sort((a, b) => a.order - b.order)`; khoá phụ không còn cần).

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/tenancy test/unit/core/events/event-flags.spec.ts test/unit/core/config
pnpm vitest run --project integration test/e2e/tenancy/tenancy-http-boot.e2e.spec.ts
```
Expected: PASS. `test/unit/core/config` (luật config) xanh; `tenancy-http-boot` vẫn boot (log `tenancy_features` có `supportGrants: 'enabled'` ở local).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/unit/modules/tenancy test/unit/core/events/event-flags.spec.ts
pnpm lint
git add src/modules/tenancy test/unit/modules/tenancy test/unit/core/events/event-flags.spec.ts .env.example
git commit -m "feat(tenancy): delegation config and the support grant feature flag, errors and constraint map, api_key/support_access events, metrics, unique purge participant order"
```

---

### Task 17: Miền ủy quyền — `checkDelegatedScope`, `effectiveDelegation` (điểm bất động, key orphan), preset support; token org key; trạng thái key/grant (U16, generator)

**Files:**
- Create: `src/modules/tenancy/domain/delegation.ts`, `test/unit/modules/tenancy/delegation.spec.ts`, `test/unit/modules/tenancy/org-api-key-token.spec.ts`
- Modify: `src/modules/tenancy/domain/org-api-key.ts`, `src/modules/tenancy/domain/support-grant.ts`

**Interfaces:**
- Consumes: `MergedCatalogue`, `CatalogueEntry` (3A), `isAdminEquivalent` (3B), `systemRolePermissions` (3A), `ORG_API_KEY_SECRET_BYTES`, `KEY_HINT_LENGTH` (Task 14), `prng`, `randomSubset` (test).
- Produces:
  - `type DelegationKind = 'API_KEY' | 'SUPPORT_GRANT'`; `delegableKeys(kind, merged): ReadonlySet<string>`; `supportPreset(merged): string[]`.
  - `type ScopeRefusalReason = 'UNKNOWN_PERMISSION' | 'NOT_ELIGIBLE' | 'MISSING_DEPENDENCIES' | 'EXCEEDS_GRANTOR'`; `checkDelegatedScope(kind, requested: readonly string[], grantor: ReadonlySet<string>, merged): { ok: true; scope: string[] } | { ok: false; reason: ScopeRefusalReason; keys: string[] }`.
  - `effectiveDelegation(kind, stored: readonly string[], grantor: ReadonlySet<string>, merged): { granted: string[]; orphans: string[] }`.
  - `org-api-key.ts`: `type OrgApiKeySecret = { token: string; hashHex: string; hint: string }`; `newOrgApiKeySecret(prefix: string): OrgApiKeySecret`; `orgApiKeyHashHex(token: string): string`; `ORG_API_KEY_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const`, `orgApiKeyStatusOf(k: { revokedAt: Date | null; expiresAt: Date }, now: Date)`.
  - `support-grant.ts`: `SUPPORT_GRANT_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const`, `supportGrantStatusOf(g, now)`.

- [ ] **Step 1: Unit (fail)**

`test/unit/modules/tenancy/delegation.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { defineCatalogue, mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  checkDelegatedScope,
  delegableKeys,
  effectiveDelegation,
  supportPreset,
} from '../../../../src/modules/tenancy/domain/delegation.js';
import { isAdminEquivalent } from '../../../../src/modules/tenancy/domain/escalation.js';
import { closure } from '../../../../src/modules/tenancy/domain/permission-set.js';
import { systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { prng, randomSubset } from './prng.js';

const entry = (resource: string, action: string, o: { requires?: string[]; apiKey?: boolean; support?: boolean; deprecated?: boolean } = {}) => ({
  resource,
  action,
  requires: o.requires ?? [],
  ownerOnly: false,
  apiKeyEligible: o.apiKey ?? false,
  supportEligible: o.support ?? false,
  grantTo: { admin: true, member: false },
  ...(o.deprecated ? { deprecated: true } : {}),
});
/** Catalogue fixture: chuỗi `audit.read → audit.export_meta`, quyền support không phải read, quyền deprecated. */
const merged = mergeCatalogues([
  TENANCY_CATALOGUE,
  defineCatalogue('fx', {
    'audit.export_meta': entry('audit', 'export_meta', { apiKey: true, support: true }),
    'audit.read': entry('audit', 'read', { requires: ['audit.export_meta'], apiKey: true, support: true }),
    'notes.write': entry('notes', 'write', { apiKey: true, support: true }),
    'old.read': entry('old', 'read', { apiKey: true, support: true, deprecated: true }),
  }),
]);
const OWNER = systemRolePermissions('OWNER', merged);
const MEMBER = systemRolePermissions('MEMBER', merged);

describe('delegation model (spec SP3 §8.5, §10)', () => {
  it('eligible sets: api keys = apiKeyEligible; support = supportEligible AND action read; never owner-only or deprecated', () => {
    expect([...delegableKeys('API_KEY', merged)].sort()).toEqual(
      ['audit.export_meta', 'audit.read', 'billing.read', 'members.read', 'notes.write', 'org.read', 'roles.read'].sort(),
    );
    expect(supportPreset(merged)).toEqual(['audit.read', 'invitations.read', 'members.read', 'org.read', 'roles.read'].sort());
    expect(supportPreset(merged)).not.toContain('billing.read'); // SEC-M6, S-14
  });
  it('U16: no api-key-eligible or support-eligible set is ever admin-equivalent', () => {
    expect(isAdminEquivalent(delegableKeys('API_KEY', merged), merged)).toBe(false);
    expect(isAdminEquivalent(delegableKeys('SUPPORT_GRANT', merged), merged)).toBe(false);
  });
  it('checkDelegatedScope: unknown/deprecated, not eligible, not closed, exceeding the grantor — each refused with the offending keys', () => {
    expect(checkDelegatedScope('API_KEY', ['org.read', 'nope.read', 'old.read'], OWNER, merged)).toEqual({ ok: false, reason: 'UNKNOWN_PERMISSION', keys: ['nope.read', 'old.read'] });
    expect(checkDelegatedScope('API_KEY', ['org.read', 'org.update'], OWNER, merged)).toEqual({ ok: false, reason: 'NOT_ELIGIBLE', keys: ['org.update'] });
    expect(checkDelegatedScope('SUPPORT_GRANT', ['notes.write'], OWNER, merged)).toEqual({ ok: false, reason: 'NOT_ELIGIBLE', keys: ['notes.write'] });
    expect(checkDelegatedScope('API_KEY', ['audit.read'], OWNER, merged)).toEqual({ ok: false, reason: 'MISSING_DEPENDENCIES', keys: ['audit.export_meta'] });
    expect(checkDelegatedScope('API_KEY', ['org.read', 'billing.read'], MEMBER, merged)).toEqual({ ok: false, reason: 'EXCEEDS_GRANTOR', keys: ['billing.read'] });
  });
  it('Review Focus 2: duplicates and order do not matter; the stored scope is the sorted set', () => {
    expect(checkDelegatedScope('API_KEY', ['roles.read', 'org.read', 'roles.read'], OWNER, merged)).toEqual({ ok: true, scope: ['org.read', 'roles.read'] });
  });
  it('effectiveDelegation: stored ∩ grantor ∩ eligible, trimmed to a fixpoint; orphan keys grant nothing and are reported', () => {
    const grantor = new Set(['org.read', 'audit.read']); // grantor mất audit.export_meta
    expect(effectiveDelegation('API_KEY', ['org.read', 'audit.read', 'audit.export_meta', 'gone.read'], grantor, merged)).toEqual({
      granted: ['org.read'],
      orphans: ['gone.read'],
    });
  });
  it('generator: the effective set is always ⊆ stored ∩ grantor ∩ eligible, closed under requires, and idempotent', () => {
    const all = [...merged.keys()];
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      for (const kind of ['API_KEY', 'SUPPORT_GRANT'] as const) {
        const stored = randomSubset(all, rnd);
        const grantor = new Set(randomSubset(all, rnd));
        const { granted } = effectiveDelegation(kind, stored, grantor, merged);
        const eligible = delegableKeys(kind, merged);
        for (const k of granted) expect(stored.includes(k) && grantor.has(k) && eligible.has(k), `seed ${seed} ${k}`).toBe(true);
        expect([...closure(granted, merged)].sort(), `seed ${seed}`).toEqual([...granted].sort());
        expect(effectiveDelegation(kind, granted, grantor, merged).granted, `seed ${seed}`).toEqual(granted);
      }
    }
  });
});
```
`test/unit/modules/tenancy/org-api-key-token.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  newOrgApiKeySecret,
  orgApiKeyHashHex,
  orgApiKeyStatusOf,
} from '../../../../src/modules/tenancy/domain/org-api-key.js';
import { supportGrantStatusOf } from '../../../../src/modules/tenancy/domain/support-grant.js';

const NOW = new Date('2026-10-01T00:00:00Z');
describe('org API key secret (spec SP3 §10)', () => {
  it('oak_ + 43 base64url characters (32 random bytes); hint = prefix + 6; hash = hex SHA-256 of the whole key', () => {
    const s = newOrgApiKeySecret('oak_');
    expect(s.token).toMatch(/^oak_[A-Za-z0-9_-]{43}$/);
    expect(s.hint).toBe(s.token.slice(0, 10));
    expect(s.hint).toMatch(/^oak_[A-Za-z0-9_-]{6}$/);
    expect(s.hashHex).toBe(orgApiKeyHashHex(s.token));
    expect(s.hashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(newOrgApiKeySecret('oak_').token).not.toBe(s.token);
  });
  it('Review Focus 1: any string hashes to 32 bytes (the definer function never sees a wrong length)', () => {
    for (const raw of ['OAK_x', 'oak_', 'oak_abc\n', 'x'.repeat(10_000)]) expect(orgApiKeyHashHex(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('status is derived: revoked wins, then expired at expires_at <= now', () => {
    expect(orgApiKeyStatusOf({ revokedAt: NOW, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe('REVOKED');
    expect(orgApiKeyStatusOf({ revokedAt: null, expiresAt: NOW }, NOW)).toBe('EXPIRED');
    expect(orgApiKeyStatusOf({ revokedAt: null, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe('ACTIVE');
    expect(supportGrantStatusOf({ revokedAt: null, expiresAt: NOW }, NOW)).toBe('EXPIRED');
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/delegation.spec.ts test/unit/modules/tenancy/org-api-key-token.spec.ts`
Expected: FAIL (module không tồn tại).

- [ ] **Step 2: Cài**

`src/modules/tenancy/domain/delegation.ts`:
```ts
import type { CatalogueEntry, MergedCatalogue } from './catalogue.js';

export type DelegationKind = 'API_KEY' | 'SUPPORT_GRANT';
export type ScopeRefusalReason = 'UNKNOWN_PERMISSION' | 'NOT_ELIGIBLE' | 'MISSING_DEPENDENCIES' | 'EXCEEDS_GRANTOR';
export type ScopeCheck = { ok: true; scope: string[] } | { ok: false; reason: ScopeRefusalReason; keys: string[] };

const READ = 'read';
/** Cùng luật với hai trigger guard của migration `delegation` (DB là lớp cuối; đây chỉ để trả lỗi đẹp). */
const eligible = (kind: DelegationKind, e: CatalogueEntry): boolean => {
  if (e.deprecated || e.ownerOnly) return false;
  switch (kind) {
    case 'API_KEY':
      return e.apiKeyEligible;
    case 'SUPPORT_GRANT':
      return e.supportEligible && e.action === READ;
    default: {
      const unknown: never = kind;
      throw new Error(`unknown delegation kind ${String(unknown)}`);
    }
  }
};

export function delegableKeys(kind: DelegationKind, merged: MergedCatalogue): ReadonlySet<string> {
  return new Set([...merged.values()].filter((e) => eligible(kind, e)).map((e) => e.key));
}
/** Spec §9.7 (P-2): preset chỉ đọc = mọi quyền `supportEligible` có `action = 'read'` của catalogue GỘP (R-X24). */
export const supportPreset = (merged: MergedCatalogue): string[] => [...delegableKeys('SUPPORT_GRANT', merged)].sort();

/**
 * Luật ủy quyền lúc tạo (spec SP3 §8.5, §10): phạm vi TƯỜNG MINH (không wildcard, không "mọi quyền của tôi"), mọi key có
 * trong catalogue gộp và không deprecated, eligible với loại ủy quyền, đóng theo `requires` (SEC-M4; thiếu → danh sách),
 * và ⊆ quyền HIỆN TẠI của người ủy quyền (`⊆`, không `⊊`: key không bao giờ vượt người tạo lúc dùng). Mảng lặp/khác thứ tự
 * cho cùng một tập đã sắp (Review Focus 2).
 */
export function checkDelegatedScope(
  kind: DelegationKind,
  requested: readonly string[],
  grantor: ReadonlySet<string>,
  merged: MergedCatalogue,
): ScopeCheck {
  const scope = [...new Set(requested)].sort();
  const unknown = scope.filter((k) => merged.get(k)?.deprecated !== false);
  if (unknown.length > 0) return { ok: false, reason: 'UNKNOWN_PERMISSION', keys: unknown };
  const entryOf = (k: string): CatalogueEntry => {
    const e = merged.get(k);
    if (!e) throw new Error(`checkDelegatedScope lost ${k}`);
    return e;
  };
  const notEligible = scope.filter((k) => !eligible(kind, entryOf(k)));
  if (notEligible.length > 0) return { ok: false, reason: 'NOT_ELIGIBLE', keys: notEligible };
  const set = new Set(scope);
  const missing = [...new Set(scope.flatMap((k) => entryOf(k).requires.filter((r) => !set.has(r))))].sort();
  if (missing.length > 0) return { ok: false, reason: 'MISSING_DEPENDENCIES', keys: missing };
  const exceeds = scope.filter((k) => !grantor.has(k));
  if (exceeds.length > 0) return { ok: false, reason: 'EXCEEDS_GRANTOR', keys: exceeds };
  return { ok: true, scope };
}

/**
 * Quyền hiệu lực lúc dùng (spec §8.5): phạm vi đã lưu ∩ quyền hiện tại của người ủy quyền ∩ eligible, KHÔNG `closure`
 * (closure lúc dùng sẽ tự thêm quyền, trái PR5); phép giao có thể không đóng nên cắt tới điểm bất động. Key không có trong
 * catalogue đã nạp là orphan (module bị tắt, R-X21/R-X23): không cấp gì, không ném; trả về để caller báo.
 */
export function effectiveDelegation(
  kind: DelegationKind,
  stored: readonly string[],
  grantor: ReadonlySet<string>,
  merged: MergedCatalogue,
): { granted: string[]; orphans: string[] } {
  const orphans = [...new Set(stored.filter((k) => !merged.has(k)))].sort();
  const set = new Set(
    stored.filter((k) => {
      const e = merged.get(k);
      return e !== undefined && eligible(kind, e) && grantor.has(k);
    }),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const k of set) {
      const e = merged.get(k);
      if (e && e.requires.some((r) => !set.has(r))) {
        set.delete(k);
        changed = true;
      }
    }
  }
  return { granted: [...set].sort(), orphans };
}
```
(`merged.get(k)?.deprecated !== false` gom "không có" và "deprecated" thành `UNKNOWN_PERMISSION` như role của 3B.)

`src/modules/tenancy/domain/org-api-key.ts` — thêm:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { KEY_HINT_LENGTH, ORG_API_KEY_SECRET_BYTES } from '../constants.js';

export type OrgApiKeySecret = { token: string; hashHex: string; hint: string };
/** SHA-256 của toàn bộ key (secret 256 bit ngẫu nhiên, không cần băm chậm; spec §10). Hex để đi qua `decode(?, 'hex')`. */
export const orgApiKeyHashHex = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
/** `prefix` = `ORG_API_KEY_PREFIX` của identity (application truyền vào: domain không import module khác). */
export function newOrgApiKeySecret(prefix: string): OrgApiKeySecret {
  const random = randomBytes(ORG_API_KEY_SECRET_BYTES).toString('base64url');
  const token = `${prefix}${random}`;
  return { token, hashHex: orgApiKeyHashHex(token), hint: `${prefix}${random.slice(0, KEY_HINT_LENGTH)}` };
}
export const ORG_API_KEY_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type OrgApiKeyStatus = (typeof ORG_API_KEY_STATUSES)[number];
/** Trạng thái suy ra (không lưu, không cron; S3-A36). */
export const orgApiKeyStatusOf = (k: { revokedAt: Date | null; expiresAt: Date }, now: Date): OrgApiKeyStatus =>
  k.revokedAt !== null ? 'REVOKED' : k.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
```
`src/modules/tenancy/domain/support-grant.ts` — thêm:
```ts
export const SUPPORT_GRANT_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type SupportGrantStatus = (typeof SUPPORT_GRANT_STATUSES)[number];
/** Spec §9.7 state machine: REVOKED lưu, EXPIRED suy ra ở mỗi lần đọc; "vô hiệu vì owner mất quyền" suy ra ở middleware. */
export const supportGrantStatusOf = (g: { revokedAt: Date | null; expiresAt: Date }, now: Date): SupportGrantStatus =>
  g.revokedAt !== null ? 'REVOKED' : g.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
```

- [ ] **Step 3: Chạy**

Run: `pnpm vitest run --project unit test/unit/modules/tenancy`
Expected: PASS (`architecture` của `domain-pure`: `delegation.ts`, `org-api-key.ts` chỉ import `node:crypto` và file cùng module).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy/domain test/unit/modules/tenancy
pnpm typecheck && pnpm lint && pnpm arch
git add src/modules/tenancy/domain test/unit/modules/tenancy
git commit -m "feat(tenancy): delegation domain — explicit closed scopes within the grantor, effective permissions trimmed to a fixpoint, the read-only support preset, org API key secrets"
```

---

### Task 18: Port + repository SQL của org key và support grant; quyền hiệu lực theo người ủy quyền (`DelegatedPermissions`)

**Files:**
- Create: `src/modules/tenancy/ports/org-api-key-repository.ts`, `src/modules/tenancy/ports/support-grant-repository.ts`, `src/modules/tenancy/infra/sql/sql-org-api-key.repository.ts`, `src/modules/tenancy/infra/sql/sql-support-grant.repository.ts`, `src/modules/tenancy/application/authz/delegated-permissions.ts`, `test/integration/tenancy/delegation-repositories.spec.ts`
- Modify: `src/modules/tenancy/tenancy.module.ts`

**Interfaces:**
- Consumes: `Db`, `countUpTo` (core), `single`, `MEMBER_SELECT` (tenancy `rows.ts`), `RolePermissions`, `PermissionCatalogueRegistry`, `TenancyMetrics` (3A/3B), `effectiveDelegation`, `systemRolePermissions` (Task 17), `tenancyCoreImports` (test).
- Produces:
  - `OrgApiKeyRow = { id; publicId; name; keyHint; createdByMemberId; createdByMemberPublicId; permissions: string[]; expiresAt: Date; revokedAt: Date | null; version: number; createdAt: Date; updatedAt: Date }`; `OrgApiKeyMatch = { orgId; id; publicId }`; `ActiveKeyAccess = { keyId; keyPublicId; creatorMemberId; creatorAuthUserId: string | null; creatorRoleId; creatorSystemKey: SystemRoleKey | null; scope: string[] }`.
  - `abstract class OrgApiKeyRepository { findByTokenHash(hashHex): Promise<OrgApiKeyMatch | undefined>; findActiveForAccess(publicId): Promise<ActiveKeyAccess | undefined>; insert(k: { createdByMemberId; name; tokenHashHex; keyHint; expiresInSec; permissions: readonly string[] }): Promise<OrgApiKeyRow>; countActiveForMember(memberId): Promise<number>; findByPublicId(publicId); lockByPublicId(publicId); revoke(id): Promise<OrgApiKeyRow | undefined>; revokeAll(): Promise<void>; unrevokedOfMember(memberId): Promise<{ publicId: string; version: number }[]>; list(q: { memberId?: string; limit; offset }): Promise<OrgApiKeyRow[]>; countUpTo(memberId: string | undefined, cap): Promise<number> }`.
  - `SupportGrantRow = { id; publicId; granteeUserId: string | null; granteeUserPublicId: string | null; grantedByMemberId: string | null; grantedByMemberPublicId: string | null; reason; permissions: string[]; expiresAt; revokedAt; firstUsedAt; version; createdAt; updatedAt }`; `OpenGrantAccess = { grantId; grantPublicId; firstUsedAt: Date | null; granterSystemKey: SystemRoleKey | null; scope: string[] }`.
  - `abstract class SupportGrantRepository { insert(g: { granteeUserId; grantedByMemberId; reason; expiresInSec; permissions }): Promise<SupportGrantRow>; revokeOpenForGrantee(granteeUserId): Promise<SupportGrantRow[]>; findByPublicId; lockByPublicId; revoke(id): Promise<SupportGrantRow | undefined>; revokeAll(): Promise<void>; list(q: { limit; offset }); countUpTo(cap); findOpenForAccess(authUserId): Promise<OpenGrantAccess | undefined>; markFirstUse(id): Promise<SupportGrantRow | undefined>; granteeOpenGrantOrgs(userId): Promise<string[]> }`.
  - `DelegatedPermissions.forApiKey(a: ActiveKeyAccess): Promise<string[]>`, `.forSupportGrant(scope: readonly string[]): string[]` (provider của `TenancyCoreModule`).

- [ ] **Step 1: Integration repository (fail)**

`test/integration/tenancy/delegation-repositories.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { DelegatedPermissions } from '../../../src/modules/tenancy/application/authz/delegated-permissions.js';
import { OrgApiKeyRepository } from '../../../src/modules/tenancy/ports/org-api-key-repository.js';
import { SupportGrantRepository } from '../../../src/modules/tenancy/ports/support-grant-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  TENANCY_ONLY_CATALOGUE,
  apiKeyEligibleKeys,
  hashToken,
  newOrgApiKeyToken,
  orgApiKeyHint,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('delegation SQL repositories and effective permissions (spec SP3 §6.10–6.11, §7.1 bước 3.7, §8.5)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  const inOrg = <T>(fn: () => Promise<T>) => app.get(OrgScope).run(org.orgId, () => app.get(UnitOfWork).run(fn));
  const keys = () => app.get(OrgApiKeyRepository);
  const grants = () => app.get(SupportGrantRepository);
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it('key: insert (deduplicated scope) → token lookup without an org context → access row → revoke once; listing per member', async () => {
    const admin = await seedMember(org, 'ADMIN');
    const token = newOrgApiKeyToken();
    const k = await inOrg(() =>
      keys().insert({ createdByMemberId: admin.memberId, name: 'ci', tokenHashHex: hashToken(token), keyHint: orgApiKeyHint(token), expiresInSec: 3600, permissions: ['roles.read', 'org.read'] }),
    );
    expect(k).toMatchObject({ name: 'ci', keyHint: orgApiKeyHint(token), createdByMemberPublicId: admin.memberPublicId, permissions: ['org.read', 'roles.read'], revokedAt: null, version: 1 });
    expect(await keys().findByTokenHash(hashToken(token))).toEqual({ orgId: org.orgId, id: k.id, publicId: k.publicId });
    expect(await inOrg(() => keys().findActiveForAccess(k.publicId))).toMatchObject({ keyPublicId: k.publicId, creatorMemberId: admin.memberId, creatorSystemKey: 'ADMIN', scope: ['org.read', 'roles.read'] });
    expect(await inOrg(() => keys().countActiveForMember(admin.memberId))).toBe(1);
    expect((await inOrg(() => keys().list({ memberId: admin.memberId, limit: 10, offset: 0 }))).map((r) => r.publicId)).toEqual([k.publicId]);
    const revoked = await inOrg(async () => {
      const locked = await keys().lockByPublicId(k.publicId);
      return locked ? keys().revoke(locked.id) : undefined;
    });
    expect(revoked).toMatchObject({ version: 2, revokedAt: expect.any(Date) });
    expect(await inOrg(() => keys().revoke(k.id))).toBeUndefined();
    expect(await keys().findByTokenHash(hashToken(token))).toBeUndefined();
    expect(await inOrg(() => keys().findActiveForAccess(k.publicId))).toBeUndefined();
  });
  it('key: unrevokedOfMember lists what the member removal must announce; revokeAll revokes the rest of the org', async () => {
    const m = await seedMember(org, 'ADMIN');
    const a = await seedOrgApiKey(org, { createdByMemberId: m.memberId, permissions: ['org.read'] });
    await seedOrgApiKey(org, { createdByMemberId: m.memberId, permissions: ['org.read'], revoked: true });
    expect(await inOrg(() => keys().unrevokedOfMember(m.memberId))).toEqual([{ publicId: a.publicId, version: 1 }]);
    await inOrg(() => keys().revokeAll());
    expect(await inOrg(() => keys().unrevokedOfMember(m.memberId))).toEqual([]);
  });
  it('grant: insert → open access for the grantee auth user → first use once (T-15) → revokeOpenForGrantee', async () => {
    const authUserId = (await ownerQuery<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at) VALUES ('S', $1, true, 'admin', now(), now(), now()) RETURNING id`,
      [`staff-${v7()}@example.test`],
    ))[0]!.id;
    const user = (await ownerQuery<{ id: string }>(`INSERT INTO tenancy_users (auth_user_id) VALUES ($1) RETURNING id::text`, [authUserId]))[0]!.id;
    const preset = supportPresetKeys(TENANCY_ONLY_CATALOGUE);
    const g = await inOrg(() => grants().insert({ granteeUserId: user, grantedByMemberId: org.owner.memberId, reason: 'SUP-1', expiresInSec: 3600, permissions: preset }));
    expect(g).toMatchObject({ granteeUserId: user, grantedByMemberPublicId: org.owner.memberPublicId, reason: 'SUP-1', permissions: preset, firstUsedAt: null });
    expect(await inOrg(() => grants().findOpenForAccess(authUserId))).toMatchObject({ grantPublicId: g.publicId, granterSystemKey: 'OWNER', scope: preset, firstUsedAt: null });
    expect(await inOrg(() => grants().markFirstUse(g.id))).toMatchObject({ firstUsedAt: expect.any(Date), version: 2 });
    expect(await inOrg(() => grants().markFirstUse(g.id))).toBeUndefined();
    expect(await grants().granteeOpenGrantOrgs(user)).toEqual([org.orgId]);
    const revoked = await inOrg(() => grants().revokeOpenForGrantee(user));
    expect(revoked.map((r) => r.publicId)).toEqual([g.publicId]);
    expect(await inOrg(() => grants().findOpenForAccess(authUserId))).toBeUndefined();
    await ownerQuery(`DELETE FROM tenancy_users WHERE id = $1`, [user]);
    await ownerQuery(`DELETE FROM auth."user" WHERE id = $1`, [authUserId]);
  });
  it('DelegatedPermissions: a key follows the CURRENT role of its creator (K-4/K-5); a grant is its eligible scope', async () => {
    const m = await seedMember(org, 'ADMIN');
    const full = apiKeyEligibleKeys(TENANCY_ONLY_CATALOGUE);
    const k = await seedOrgApiKey(org, { createdByMemberId: m.memberId, permissions: full });
    const asAdmin = await inOrg(async () => app.get(DelegatedPermissions).forApiKey((await keys().findActiveForAccess(k.publicId))!));
    expect(asAdmin).toEqual(full);
    await ownerQuery(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [org.roles.MEMBER.id, m.memberId]);
    const asMember = await inOrg(async () => app.get(DelegatedPermissions).forApiKey((await keys().findActiveForAccess(k.publicId))!));
    expect(asMember).not.toContain('billing.read');
    expect(asMember).toContain('org.read');
    const g = await seedSupportGrant(org, { grantee: { externalSubject: `test:${v7()}` }, grantedByMemberId: org.owner.memberId, permissions: supportPresetKeys(TENANCY_ONLY_CATALOGUE) });
    expect(app.get(DelegatedPermissions).forSupportGrant(supportPresetKeys(TENANCY_ONLY_CATALOGUE))).toEqual(supportPresetKeys(TENANCY_ONLY_CATALOGUE));
    expect(g.publicId).toBeDefined();
  });
});
```
(`ownerQuery` bỏ qua RLS: sửa role trực tiếp chỉ để đổi "role hiện tại" giữa hai lần đọc; `tenancyCoreImports()` nạp `TenancyCoreModule` có repository và `DelegatedPermissions`.)

Run: `pnpm vitest run --project integration test/integration/tenancy/delegation-repositories.spec.ts`
Expected: FAIL (port không tồn tại).

- [ ] **Step 2: Port**

`src/modules/tenancy/ports/org-api-key-repository.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';

export type OrgApiKeyRow = {
  id: string;
  publicId: string;
  name: string;
  keyHint: string;
  createdByMemberId: string;
  createdByMemberPublicId: string;
  /** Phạm vi đã lưu, không deprecated, đã sắp (spec §12 `OrgApiKey.permissions`). */
  permissions: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/** Kết quả hàm definer `tenancy_find_org_api_key` (không cần OrgScope). */
export type OrgApiKeyMatch = { orgId: string; id: string; publicId: string };
/** Dòng của nhánh key ở `PrincipalResolver` và `OrgContextMiddleware`: key còn dùng được + người tạo + role HIỆN TẠI. */
export type ActiveKeyAccess = {
  keyId: string;
  keyPublicId: string;
  creatorMemberId: string;
  creatorAuthUserId: string | null;
  creatorRoleId: string;
  creatorSystemKey: SystemRoleKey | null;
  scope: string[];
};

/** Phương thức trừ `findByTokenHash` chạy trong OrgScope của org (RLS). */
export abstract class OrgApiKeyRepository {
  abstract findByTokenHash(hashHex: string): Promise<OrgApiKeyMatch | undefined>;
  /** Key chưa thu hồi, còn hạn theo `now()` (đọc không chờ khoá, §3.15), org chưa xoá mềm; người tạo còn là member (CASCADE). */
  abstract findActiveForAccess(publicId: string): Promise<ActiveKeyAccess | undefined>;
  abstract insert(k: {
    createdByMemberId: string;
    name: string;
    tokenHashHex: string;
    keyHint: string;
    expiresInSec: number;
    permissions: readonly string[];
  }): Promise<OrgApiKeyRow>;
  /** Chưa thu hồi và còn hạn theo `clock_timestamp()` (đo SAU khoá org, §3.15; T-11). */
  abstract countActiveForMember(memberId: string): Promise<number>;
  abstract findByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined>;
  /** `revoked_at = clock_timestamp()` khi còn NULL; `undefined` khi đã thu hồi. */
  abstract revoke(id: string): Promise<OrgApiKeyRow | undefined>;
  /** Xoá mềm org (spec §9.4): mọi key chưa thu hồi; không event riêng (§14.1). */
  abstract revokeAll(): Promise<void>;
  /** Key chưa thu hồi của một member (event `CREATOR_REMOVED` trước câu xoá member, §14.1). */
  abstract unrevokedOfMember(memberId: string): Promise<{ publicId: string; version: number }[]>;
  abstract list(q: { memberId?: string; limit: number; offset: number }): Promise<OrgApiKeyRow[]>;
  abstract countUpTo(memberId: string | undefined, cap: number): Promise<number>;
}
```
`src/modules/tenancy/ports/support-grant-repository.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';

export type SupportGrantRow = {
  id: string;
  publicId: string;
  granteeUserId: string | null;
  granteeUserPublicId: string | null;
  grantedByMemberId: string | null;
  grantedByMemberPublicId: string | null;
  reason: string;
  permissions: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  firstUsedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/** Dòng của nhánh support ở middleware: grant mở còn hạn của user trong org + role HIỆN TẠI của owner đã cấp (S3-P3). */
export type OpenGrantAccess = {
  grantId: string;
  grantPublicId: string;
  firstUsedAt: Date | null;
  granterSystemKey: SystemRoleKey | null;
  scope: string[];
};

export abstract class SupportGrantRepository {
  abstract insert(g: {
    granteeUserId: string;
    grantedByMemberId: string;
    reason: string;
    expiresInSec: number;
    permissions: readonly string[];
  }): Promise<SupportGrantRow>;
  /** `revoked_at = clock_timestamp()` cho grant chưa thu hồi của người nhận trong org hiện tại (cấp lại, SEC-M5, N5-1). */
  abstract revokeOpenForGrantee(granteeUserId: string): Promise<SupportGrantRow[]>;
  abstract findByPublicId(publicId: string): Promise<SupportGrantRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<SupportGrantRow | undefined>;
  abstract revoke(id: string): Promise<SupportGrantRow | undefined>;
  abstract revokeAll(): Promise<void>;
  abstract list(q: { limit: number; offset: number }): Promise<SupportGrantRow[]>;
  abstract countUpTo(cap: number): Promise<number>;
  /** Spec §7.1 bước 3.7: không tạo `tenancy_users` (Review Focus 2 của 3A); local/hybrid → theo `auth_user_id`. */
  abstract findOpenForAccess(authUserId: string): Promise<OpenGrantAccess | undefined>;
  /** Bước 3.10 (T-15): `first_used_at` khi còn NULL; `undefined` khi đã ghi. */
  abstract markFirstUse(id: string): Promise<SupportGrantRow | undefined>;
  /** Hàm definer `tenancy_grantee_open_grant_orgs` (không cần OrgScope). */
  abstract granteeOpenGrantOrgs(userId: string): Promise<string[]>;
}
```

- [ ] **Step 3: Repository SQL**

`src/modules/tenancy/infra/sql/sql-org-api-key.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import {
  OrgApiKeyRepository,
  type ActiveKeyAccess,
  type OrgApiKeyMatch,
  type OrgApiKeyRow,
} from '../../ports/org-api-key-repository.js';
import { single } from './rows.js';

const keyList = z.array(z.string());
const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    name: z.string(),
    key_hint: z.string(),
    created_by_member_id: z.string(),
    created_by_member_public_id: z.string(),
    permissions: keyList,
    expires_at: z.coerce.date(),
    revoked_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform((r): OrgApiKeyRow => ({
    id: r.id,
    publicId: r.public_id,
    name: r.name,
    keyHint: r.key_hint,
    createdByMemberId: r.created_by_member_id,
    createdByMemberPublicId: r.created_by_member_public_id,
    permissions: r.permissions,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
const Access = z
  .object({
    key_id: z.string(),
    key_public_id: z.string(),
    creator_member_id: z.string(),
    creator_auth_user_id: z.string().nullable(),
    creator_role_id: z.string(),
    creator_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    scope: keyList,
  })
  .transform((r): ActiveKeyAccess => ({
    keyId: r.key_id,
    keyPublicId: r.key_public_id,
    creatorMemberId: r.creator_member_id,
    creatorAuthUserId: r.creator_auth_user_id,
    creatorRoleId: r.creator_role_id,
    creatorSystemKey: r.creator_system_key,
    scope: r.scope,
  }));
const Match = z
  .object({ org_id: z.string(), id: z.string(), public_id: z.string() })
  .transform((r): OrgApiKeyMatch => ({ orgId: r.org_id, id: r.id, publicId: r.public_id }));
const Count = z.object({ n: z.coerce.number().int() });
const Revoked = z
  .object({ public_id: z.string(), version: z.coerce.number().int() })
  .transform((r) => ({ publicId: r.public_id, version: r.version }));
/** Phạm vi không deprecated, đã sắp (PK bảng nối). */
const SCOPE = `COALESCE((SELECT array_agg(p.key ORDER BY p.key) FROM org_api_key_permissions kp JOIN permissions p ON p.id = kp.permission_id
  WHERE kp.org_id = k.org_id AND kp.api_key_id = k.id AND p.deprecated_at IS NULL), '{}'::text[])`;
const SELECT = `SELECT k.id::text AS id, k.public_id::text AS public_id, k.name, k.key_hint,
    k.created_by_member_id::text AS created_by_member_id, m.public_id::text AS created_by_member_public_id,
    ${SCOPE} AS permissions, k.expires_at, k.revoked_at, k.version, k.created_at, k.updated_at
  FROM org_api_keys k JOIN org_members m ON m.org_id = k.org_id AND m.id = k.created_by_member_id`;
const IN_ORG = 'k.org_id = app_current_org()';

/** Mốc thu hồi dùng `clock_timestamp()` (ghi SAU khoá org; bài học final review 3C M-1). */
@Injectable()
export class SqlOrgApiKeyRepository extends OrgApiKeyRepository {
  constructor(private readonly db: Db) {
    super();
  }
  private async one(where: string, params: unknown[], lock: boolean): Promise<OrgApiKeyRow | undefined> {
    const [row] = await this.db.execute(`${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF k' : ''}`, params);
    return row ? Row.parse(row) : undefined;
  }
  async findByTokenHash(hashHex: string): Promise<OrgApiKeyMatch | undefined> {
    const [row] = await this.db.execute(
      `SELECT org_id::text AS org_id, api_key_id::text AS id, api_key_public_id::text AS public_id FROM tenancy_find_org_api_key(decode(?, 'hex'))`,
      [hashHex],
    );
    return row ? Match.parse(row) : undefined;
  }
  async findActiveForAccess(publicId: string): Promise<ActiveKeyAccess | undefined> {
    const [row] = await this.db.execute(
      `SELECT k.id::text AS key_id, k.public_id::text AS key_public_id, m.id::text AS creator_member_id,
         u.auth_user_id::text AS creator_auth_user_id, r.id::text AS creator_role_id, r.system_key AS creator_system_key,
         ${SCOPE} AS scope
       FROM org_api_keys k
       JOIN organizations o ON o.id = k.org_id
       JOIN org_members m ON m.org_id = k.org_id AND m.id = k.created_by_member_id
       JOIN tenancy_users u ON u.id = m.user_id
       JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE ${IN_ORG} AND k.public_id = ? AND k.revoked_at IS NULL AND k.expires_at > now() AND o.deleted_at IS NULL`,
      [publicId],
    );
    return row ? Access.parse(row) : undefined;
  }
  async insert(k: {
    createdByMemberId: string;
    name: string;
    tokenHashHex: string;
    keyHint: string;
    expiresInSec: number;
    permissions: readonly string[];
  }): Promise<OrgApiKeyRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at)
         VALUES (app_current_org(), ?, ?, decode(?, 'hex'), ?, now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [k.createdByMemberId, k.name, k.tokenHashHex, k.keyHint, k.expiresInSec],
      ),
      'insert org api key',
    );
    const keys = [...new Set(k.permissions)];
    const inserted = await this.db.execute(
      `INSERT INTO org_api_key_permissions (org_id, api_key_id, permission_id)
       SELECT app_current_org(), ?, p.id FROM permissions p WHERE p.key = ANY(?::text[]) RETURNING permission_id`,
      [created.id, keys],
    );
    if (inserted.length !== keys.length) throw new Error('insert org api key: a scope key has no permissions row');
    const row = await this.one('k.id = ?', [created.id], false);
    if (!row) throw new Error('insert org api key: row vanished');
    return row;
  }
  async countActiveForMember(memberId: string): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute(
          `SELECT count(*)::int AS n FROM org_api_keys WHERE org_id = app_current_org() AND created_by_member_id = ?
             AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
          [memberId],
        ),
        'count active keys',
      ),
    ).n;
  }
  findByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined> {
    return this.one('k.public_id = ?', [publicId], false);
  }
  lockByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined> {
    return this.one('k.public_id = ?', [publicId], true);
  }
  async revoke(id: string): Promise<OrgApiKeyRow | undefined> {
    const [r] = await this.db.execute<{ id: string }>(
      `UPDATE org_api_keys SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
      [id],
    );
    return r ? this.one('k.id = ?', [r.id], false) : undefined;
  }
  async revokeAll(): Promise<void> {
    await this.db.execute(
      `UPDATE org_api_keys SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND revoked_at IS NULL`,
    );
  }
  async unrevokedOfMember(memberId: string): Promise<{ publicId: string; version: number }[]> {
    const rows = await this.db.execute(
      `SELECT public_id::text AS public_id, version FROM org_api_keys
       WHERE org_id = app_current_org() AND created_by_member_id = ? AND revoked_at IS NULL ORDER BY id`,
      [memberId],
    );
    return rows.map((r) => Revoked.parse(r));
  }
  async list(q: { memberId?: string; limit: number; offset: number }): Promise<OrgApiKeyRow[]> {
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG}${q.memberId === undefined ? '' : ' AND k.created_by_member_id = ?'} ORDER BY k.created_at, k.id LIMIT ? OFFSET ?`,
      q.memberId === undefined ? [q.limit, q.offset] : [q.memberId, q.limit, q.offset],
    );
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(memberId: string | undefined, cap: number): Promise<number> {
    return memberId === undefined
      ? countUpTo(this.db, 'SELECT 1 FROM org_api_keys WHERE org_id = app_current_org()', [], cap)
      : countUpTo(this.db, 'SELECT 1 FROM org_api_keys WHERE org_id = app_current_org() AND created_by_member_id = ?', [memberId], cap);
  }
}
```
`src/modules/tenancy/infra/sql/sql-support-grant.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import {
  SupportGrantRepository,
  type OpenGrantAccess,
  type SupportGrantRow,
} from '../../ports/support-grant-repository.js';
import { single } from './rows.js';

const keyList = z.array(z.string());
const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    grantee_user_id: z.string().nullable(),
    grantee_user_public_id: z.string().nullable(),
    granted_by_member_id: z.string().nullable(),
    granted_by_member_public_id: z.string().nullable(),
    reason: z.string(),
    permissions: keyList,
    expires_at: z.coerce.date(),
    revoked_at: z.coerce.date().nullable(),
    first_used_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform((r): SupportGrantRow => ({
    id: r.id,
    publicId: r.public_id,
    granteeUserId: r.grantee_user_id,
    granteeUserPublicId: r.grantee_user_public_id,
    grantedByMemberId: r.granted_by_member_id,
    grantedByMemberPublicId: r.granted_by_member_public_id,
    reason: r.reason,
    permissions: r.permissions,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    firstUsedAt: r.first_used_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
const Access = z
  .object({
    grant_id: z.string(),
    grant_public_id: z.string(),
    first_used_at: z.coerce.date().nullable(),
    granter_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    scope: keyList,
  })
  .transform((r): OpenGrantAccess => ({
    grantId: r.grant_id,
    grantPublicId: r.grant_public_id,
    firstUsedAt: r.first_used_at,
    granterSystemKey: r.granter_system_key,
    scope: r.scope,
  }));
const SCOPE = `COALESCE((SELECT array_agg(p.key ORDER BY p.key) FROM org_support_grant_permissions gp JOIN permissions p ON p.id = gp.permission_id
  WHERE gp.org_id = g.org_id AND gp.grant_id = g.id AND p.deprecated_at IS NULL), '{}'::text[])`;
const SELECT = `SELECT g.id::text AS id, g.public_id::text AS public_id, g.grantee_user_id::text AS grantee_user_id,
    u.public_id::text AS grantee_user_public_id, g.granted_by_member_id::text AS granted_by_member_id,
    m.public_id::text AS granted_by_member_public_id, g.reason, ${SCOPE} AS permissions, g.expires_at, g.revoked_at,
    g.first_used_at, g.version, g.created_at, g.updated_at
  FROM org_support_grants g
  LEFT JOIN tenancy_users u ON u.id = g.grantee_user_id
  LEFT JOIN org_members m ON m.org_id = g.org_id AND m.id = g.granted_by_member_id`;
const IN_ORG = 'g.org_id = app_current_org()';

@Injectable()
export class SqlSupportGrantRepository extends SupportGrantRepository {
  constructor(private readonly db: Db) {
    super();
  }
  private async one(where: string, params: unknown[], lock: boolean): Promise<SupportGrantRow | undefined> {
    const [row] = await this.db.execute(`${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF g' : ''}`, params);
    return row ? Row.parse(row) : undefined;
  }
  private async reread(rows: readonly { id: string }[]): Promise<SupportGrantRow[]> {
    const out: SupportGrantRow[] = [];
    for (const r of rows) {
      const row = await this.one('g.id = ?', [r.id], false);
      if (!row) throw new Error('updated support grant vanished');
      out.push(row);
    }
    return out;
  }
  async insert(g: { granteeUserId: string; grantedByMemberId: string; reason: string; expiresInSec: number; permissions: readonly string[] }): Promise<SupportGrantRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at)
         VALUES (app_current_org(), ?, ?, ?, now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [g.granteeUserId, g.grantedByMemberId, g.reason, g.expiresInSec],
      ),
      'insert support grant',
    );
    const keys = [...new Set(g.permissions)];
    const inserted = await this.db.execute(
      `INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id)
       SELECT app_current_org(), ?, p.id FROM permissions p WHERE p.key = ANY(?::text[]) RETURNING permission_id`,
      [created.id, keys],
    );
    if (inserted.length !== keys.length) throw new Error('insert support grant: a preset key has no permissions row');
    const row = await this.one('g.id = ?', [created.id], false);
    if (!row) throw new Error('insert support grant: row vanished');
    return row;
  }
  async revokeOpenForGrantee(granteeUserId: string): Promise<SupportGrantRow[]> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_support_grants SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND grantee_user_id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
        [granteeUserId],
      ),
    );
  }
  findByPublicId(publicId: string): Promise<SupportGrantRow | undefined> {
    return this.one('g.public_id = ?', [publicId], false);
  }
  lockByPublicId(publicId: string): Promise<SupportGrantRow | undefined> {
    return this.one('g.public_id = ?', [publicId], true);
  }
  async revoke(id: string): Promise<SupportGrantRow | undefined> {
    const [row] = await this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_support_grants SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
        [id],
      ),
    );
    return row;
  }
  async revokeAll(): Promise<void> {
    await this.db.execute(
      `UPDATE org_support_grants SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND revoked_at IS NULL`,
    );
  }
  async list(q: { limit: number; offset: number }): Promise<SupportGrantRow[]> {
    const rows = await this.db.execute(`${SELECT} WHERE ${IN_ORG} ORDER BY g.created_at, g.id LIMIT ? OFFSET ?`, [q.limit, q.offset]);
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(cap: number): Promise<number> {
    return countUpTo(this.db, 'SELECT 1 FROM org_support_grants WHERE org_id = app_current_org()', [], cap);
  }
  async findOpenForAccess(authUserId: string): Promise<OpenGrantAccess | undefined> {
    const [row] = await this.db.execute(
      `WITH u AS (SELECT id FROM tenancy_users WHERE auth_user_id = ?::uuid)
       SELECT g.id::text AS grant_id, g.public_id::text AS grant_public_id, g.first_used_at, r.system_key AS granter_system_key,
         ${SCOPE} AS scope
       FROM org_support_grants g
       LEFT JOIN org_members m ON m.org_id = g.org_id AND m.id = g.granted_by_member_id
       LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE ${IN_ORG} AND g.grantee_user_id = (SELECT id FROM u) AND g.revoked_at IS NULL AND g.expires_at > now()`,
      [authUserId],
    );
    return row ? Access.parse(row) : undefined;
  }
  async markFirstUse(id: string): Promise<SupportGrantRow | undefined> {
    const [row] = await this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_support_grants SET first_used_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND first_used_at IS NULL RETURNING id::text AS id`,
        [id],
      ),
    );
    return row;
  }
  async granteeOpenGrantOrgs(userId: string): Promise<string[]> {
    const rows = await this.db.execute<{ org_id: string }>(`SELECT org_id::text AS org_id FROM tenancy_grantee_open_grant_orgs(?)`, [userId]);
    return rows.map((r) => z.string().parse(r.org_id));
  }
}
```
`src/modules/tenancy/application/authz/delegated-permissions.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { effectiveDelegation, type DelegationKind } from '../../domain/delegation.js';
import { systemRolePermissions } from '../../domain/system-roles.js';
import type { ActiveKeyAccess } from '../../ports/org-api-key-repository.js';
import { PermissionCatalogueRegistry } from '../permission-catalogue.registry.js';
import { TenancyMetrics } from '../tenancy-metrics.js';
import { RolePermissions } from './role-permissions.js';

/**
 * Quyền hiệu lực của org key / support grant ở MỖI request (spec SP3 §8.5, không cache, PR18). Key: phạm vi ∩ quyền của
 * role HIỆN TẠI của người tạo (`RolePermissions`, gồm role tuỳ biến) ∩ eligible. Grant: người cấp phải đang là OWNER
 * (middleware kiểm), owner giữ mọi quyền nên = phạm vi ∩ eligible. Key orphan: WARN + metric MỘT lần mỗi key mỗi process
 * (R-X23, R-X26), không bao giờ 500.
 */
@Injectable()
export class DelegatedPermissions {
  private readonly logger = new Logger(DelegatedPermissions.name);
  private readonly reportedOrphans = new Set<string>();

  constructor(
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
  ) {}

  async forApiKey(a: ActiveKeyAccess): Promise<string[]> {
    const grantor = new Set(await this.rolePermissions.of({ id: a.creatorRoleId, systemKey: a.creatorSystemKey }));
    return this.effective('API_KEY', a.scope, grantor);
  }

  forSupportGrant(scope: readonly string[]): string[] {
    const merged = this.registry.merged();
    return this.effective('SUPPORT_GRANT', scope, systemRolePermissions('OWNER', merged));
  }

  private effective(kind: DelegationKind, scope: readonly string[], grantor: ReadonlySet<string>): string[] {
    const { granted, orphans } = effectiveDelegation(kind, scope, grantor, this.registry.merged());
    for (const key of orphans) {
      if (this.reportedOrphans.has(key)) continue;
      this.reportedOrphans.add(key);
      this.metrics.catalogueOrphanKeys.add(1, { source: 'delegation' });
      this.logger.warn({ event: 'orphan_permission_ignored', key, source: kind }, 'a delegation scope holds a permission that no loaded catalogue declares; it grants nothing');
    }
    return granted;
  }
}
```
`src/modules/tenancy/tenancy.module.ts` — `TenancyCoreModule.providers` thêm:
```ts
    SqlOrgApiKeyRepository,
    { provide: OrgApiKeyRepository, useExisting: SqlOrgApiKeyRepository },
    SqlSupportGrantRepository,
    { provide: SupportGrantRepository, useExisting: SqlSupportGrantRepository },
    DelegatedPermissions,
```
và `exports` thêm `OrgApiKeyRepository`, `SupportGrantRepository`, `DelegatedPermissions`.

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project integration test/integration/tenancy/delegation-repositories.spec.ts test/integration/tenancy/repositories.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/integration/tenancy/delegation-repositories.spec.ts
pnpm lint && pnpm arch
git add src/modules/tenancy test/integration/tenancy/delegation-repositories.spec.ts
git commit -m "feat(tenancy): org API key and support grant repositories; effective delegated permissions from the grantor's current role"
```

---

## Phần E — Bề mặt HTTP và pipeline của ủy quyền (spec §7.1 bước 2, 3.6, 3.7, 3.10; §9.7; §10; §12)

### Task 19: Org API key — service, controller, schema; tạo/liệt kê/thu hồi (K-1, K-2, K-3, K-8, K-12, K-15, K-16, B-22/B-24 phần key, T-11 key, Review Focus 2)

**Files:**
- Create: `src/modules/tenancy/application/org-api-key.service.ts`, `src/modules/tenancy/application/delegation-scope.ts`, `src/modules/tenancy/http/api-keys.controller.ts` (khung bằng `pnpm exec nest g controller modules/tenancy/http/api-keys --flat --no-spec`, rồi thay nội dung), `test/e2e/tenancy/org-api-keys.e2e.spec.ts`
- Modify: `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/policy-metadata.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `src/modules/tenancy/application/actor-reauthorizer.ts`, `test/e2e/tenancy/role-route-matrix.e2e.spec.ts` (bảng `ROUTES_3D` + `NARROWING`, Task 25 thêm cột)

**Interfaces:**
- Consumes: `OrgApiKeyRepository` (Task 18), `checkDelegatedScope`, `newOrgApiKeySecret` (Task 17), `ORG_API_KEY_PREFIX` (identity `index.ts`), `ActorReauthorizer.require`, `actorOfMember`, `assertCanManage`, `EscalationGuard.enforce`, `RolePermissions.of`, `PermissionCatalogueRegistry.merged`, `OrgRepository.lockCurrent`, `TenancyTestHooks.afterGuard`, `ApiKeyCreatedEvent`, `ApiKeyRevokedEvent` (Task 16), `TenancyErrors.API_KEYS_LIMIT`, `TTL_OUT_OF_RANGE`, `PERMISSION_NOT_API_KEY_ELIGIBLE`, `UNKNOWN_PERMISSION`, `MISSING_DEPENDENCIES`.
- Produces:
  - `delegation-scope.ts`: `scopeOrThrow(kind: DelegationKind, check: ScopeCheck, escalation: EscalationGuard): string[]` (lỗi có `fields` như `RoleService`; `EXCEEDS_GRANTOR` → `EscalationGuard.enforce({ ok: false, rule: 'delegation', reason: 'ESCALATION_DENIED' })` → `403 escalation_denied`).
  - `OrgApiKeyService.create(i: { name: string; permissions: string[]; expiresInSec: number }): Promise<{ key: OrgApiKeyRow; token: string }>`; `.list(q: { page; pageSize; cap; mine: boolean })`; `.revokeMine(publicId)`; `.revoke(publicId)`.
  - `userActor(ctx)` ném khi principal không phải `user` (fail loud; key không bao giờ là actor của mutation quản trị, spec §10 "Actor của event").
  - Schema: `CreateOrgApiKeyBody`, `OrgApiKeyResponse`, `CreatedOrgApiKeyResponse`, `orgApiKeyOf(row)`.
  - `NARROWING_ROUTES` thêm `'DELETE v1/orgs/:orgId/api-keys/mine/:keyId'`, `'DELETE v1/orgs/:orgId/api-keys/:keyId'` (Task 21 thêm route grant).

- [ ] **Step 1: E2E (fail)**

`test/e2e/tenancy/org-api-keys.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { ownerQuery } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  adminKeys,
  apiKeyEligibleKeys,
  seedCustomRole,
  seedMember,
  seedMemberInRole,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import {
  PayrollPermissionsModule,
  installPayrollPermission,
  permissionRowCount,
  removePayrollPermission,
} from './fixtures/payroll-permissions.js';

const MAX_TTL = 86_400;
const LIMIT = 3;
const STALE_SEC = 3600;

describe('org API keys: create, list, revoke (spec SP3 §10, §12; §18.3 K-1–K-3, K-8, K-12, K-15, K-16, B-22/B-24; Review Focus 2)', () => {
  let app: INestApplication;
  let full: string[];
  let rowsBefore: number;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const cast = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const O = await seedP(o);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedP(o);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const M = await seedP(o);
    const m = await seedMember(org, 'MEMBER', { authUserId: M.authUserId });
    return { org, O, A, a, M, m };
  };
  const create = (p: SeededPrincipal, org: SeededOrg, body: Record<string, unknown>) =>
    authed(app, p).post(`/v1/orgs/${org.orgId}/api-keys`).send(body);
  const ok = { name: 'ci', permissions: ['org.read'], expiresInSec: 3600 };

  beforeAll(async () => {
    rowsBefore = await permissionRowCount();
    await installPayrollPermission();
    app = await startTenancyApp({
      extraImports: [PayrollPermissionsModule],
      env: { TENANCY_ORG_API_KEY_MAX_TTL_SEC: String(MAX_TTL), TENANCY_MAX_ACTIVE_ORG_API_KEYS_PER_MEMBER: String(LIMIT) },
    });
    full = apiKeyEligibleKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await removePayrollPermission();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    expect(await permissionRowCount()).toBe(rowsBefore);
  });

  it('201: the key is returned once (no-store), hashed at rest, listed without it; event api_key.created in the same transaction', async () => {
    const c = await cast();
    const r = await create(c.A, c.org, { ...ok, permissions: full });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.location).toBe(`/v1/orgs/${c.org.orgId}/api-keys/${r.body.id}`);
    expect(r.body.key).toMatch(/^oak_[A-Za-z0-9_-]{43}$/);
    expect(r.body).toMatchObject({ name: 'ci', keyHint: r.body.key.slice(0, 10), permissions: full, createdByMemberId: c.a.memberPublicId, revokedAt: null });
    const [row] = await ownerQuery<{ h: string }>(`SELECT encode(token_hash, 'hex') AS h FROM org_api_keys WHERE public_id = $1`, [r.body.id]);
    expect(row?.h).not.toContain(r.body.key);
    const list = await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/api-keys`);
    expect(list.body.data.map((k: { id: string }) => k.id)).toEqual([r.body.id]);
    expect(JSON.stringify(list.body)).not.toContain(r.body.key);
    const [ev] = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.api_key.created' AND aggregate_id = $1`,
      [r.body.id],
    );
    expect(ev?.payload).toEqual({ apiKeyId: r.body.id, createdByMemberId: c.a.memberPublicId, permissions: full, expiresAt: r.body.expiresAt });
  });
  it('K-1: a scope beyond the creator → 403 escalation_denied; K-2: an admin permission → 422 permission_not_api_key_eligible', async () => {
    const c = await cast();
    const k1 = await create(c.M, c.org, { ...ok, permissions: ['org.read', 'billing.read'] });
    expect([k1.status, k1.body.code]).toEqual([403, 'forbidden']); // MEMBER không có cửa api_keys.write_own (guard)
    const x = await seedCustomRole(c.org, { name: 'keys-no-billing', permissions: ['org.read', 'api_keys.write_own'] });
    const K = await seedP();
    await seedMemberInRole(c.org, x, { authUserId: K.authUserId });
    const beyond = await create(K, c.org, { ...ok, permissions: ['org.read', 'members.read'] });
    expect([beyond.status, beyond.body.code]).toEqual([403, 'escalation_denied']);
    const k2 = await create(c.O, c.org, { ...ok, permissions: ['org.read', 'org.update'] });
    expect([k2.status, k2.body.code]).toEqual([422, 'permission_not_api_key_eligible']);
    expect(k2.body.fields).toEqual([{ path: 'permissions', code: 'permission_not_api_key_eligible', message: 'org.update' }]);
  });
  it('K-12: a scope not closed under requires → 422 missing_dependencies naming the missing keys', async () => {
    const c = await cast();
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const withRequires = full.find((k) => (merged.get(k)?.requires.length ?? 0) > 0);
    if (!withRequires) throw new Error('fixture: no api-key-eligible permission has requires');
    const r = await create(c.O, c.org, { ...ok, permissions: [withRequires] });
    expect([r.status, r.body.code]).toEqual([422, 'missing_dependencies']);
  });
  it('Review Focus 2: scope duplicates, order, empty, unknown; TTL boundaries', async () => {
    const c = await cast();
    const dup = await create(c.O, c.org, { ...ok, permissions: ['roles.read', 'org.read', 'roles.read'] });
    expect([dup.status, dup.body.permissions]).toEqual([201, ['org.read', 'roles.read']]);
    expect((await create(c.O, c.org, { ...ok, permissions: [] })).body.code).toBe('validation_failed');
    const unknown = await create(c.O, c.org, { ...ok, permissions: ['org.read', 'nope.read'] });
    expect([unknown.status, unknown.body.code]).toEqual([422, 'unknown_permission']);
    const atMax = await create(c.O, c.org, { ...ok, expiresInSec: MAX_TTL });
    expect(atMax.status).toBe(201);
    const over = await create(c.O, c.org, { ...ok, expiresInSec: MAX_TTL + 1 });
    expect([over.status, over.body.code]).toEqual([422, 'ttl_out_of_range']);
    for (const bad of [0, -1, 1.5, '3600', null])
      expect((await create(c.O, c.org, { ...ok, expiresInSec: bad })).body.code, String(bad)).toBe('validation_failed');
    for (const name of ['', '   ', 'a'.repeat(65), 'two\nlines'])
      expect((await create(c.O, c.org, { ...ok, name })).body.code, JSON.stringify(name)).toBe('validation_failed');
  });
  it('T-11 (key): N concurrent creations over the per-member limit → exactly the limit succeed, the rest 422 api_keys_limit', async () => {
    const c = await cast();
    const rs = await Promise.all(Array.from({ length: LIMIT + 4 }, () => create(c.A, c.org, ok)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(LIMIT);
    expect(rs.filter((r) => r.status === 422).every((r) => r.body.code === 'api_keys_limit')).toBe(true);
    expect(rs.some((r) => r.status >= 500)).toBe(false);
  });
  it('K-8: a MEMBER with a custom role holding api_keys.write_all revokes an ADMIN key → 403 escalation_denied (rule 4)', async () => {
    const c = await cast();
    const key = await create(c.A, c.org, ok);
    const w = await seedCustomRole(c.org, { name: 'revoker', permissions: ['org.read', 'api_keys.read', 'api_keys.write_all'] });
    const R = await seedP();
    await seedMemberInRole(c.org, w, { authUserId: R.authUserId });
    const r = await authed(app, R).delete(`/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`);
    expect([r.status, r.body.code]).toEqual([403, 'escalation_denied']);
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`)).status).toBe(204);
    const [ev] = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.api_key.revoked' AND aggregate_id = $1`,
      [key.body.id],
    );
    expect(ev?.payload).toEqual({ apiKeyId: key.body.id, reason: 'REVOKED' });
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`)).status).toBe(204); // idempotent
  });
  it('B-22/B-24 (keys): X (ADMIN ∪ payroll.read) revokes the key of an ADMIN, or of Bob holding V ≡ ADMIN → 403 owner_only', async () => {
    const c = await cast();
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const x = await seedCustomRole(c.org, { name: 'X', permissions: [...adminKeys(merged), 'payroll.read'] });
    const v = await seedCustomRole(c.org, { name: 'V', permissions: adminKeys(merged) });
    const X = await seedP();
    await seedMemberInRole(c.org, x, { authUserId: X.authUserId });
    const Bob = await seedP();
    await seedMemberInRole(c.org, v, { authUserId: Bob.authUserId });
    for (const holder of [c.A, Bob]) {
      const key = await create(holder, c.org, ok);
      expect(key.status).toBe(201);
      const r = await authed(app, X).delete(`/v1/orgs/${c.org.orgId}/api-keys/${key.body.id}`);
      expect([r.status, r.body.code]).toEqual([403, 'owner_only']);
    }
  });
  it('K-15: creating a key with an unverified session when AUTH_REQUIRE_EMAIL_VERIFICATION=false → 403 email_not_verified', async () => {
    const c = await cast({ emailVerified: false });
    const r = await create(c.O, c.org, ok);
    expect([r.status, r.body.code]).toEqual([403, 'email_not_verified']);
  });
  it('K-16: A demoted to MEMBER still lists and revokes their own key with a stale session; …/mine/{other} → 404', async () => {
    const c = await cast();
    const mine = await create(c.A, c.org, ok);
    const others = await create(c.O, c.org, ok);
    await ownerQuery(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [c.org.roles.MEMBER.id, c.a.memberId]);
    await ownerQuery(`UPDATE auth.session SET created_at = now() - make_interval(secs => $2) WHERE token = $1`, [c.A.bearer, STALE_SEC]);
    const list = await authed(app, c.A).get(`/v1/orgs/${c.org.orgId}/api-keys/mine`);
    expect(list.body.data.map((k: { id: string }) => k.id)).toEqual([mine.body.id]);
    expect((await authed(app, c.A).delete(`/v1/orgs/${c.org.orgId}/api-keys/mine/${others.body.id}`)).status).toBe(404);
    expect((await authed(app, c.A).delete(`/v1/orgs/${c.org.orgId}/api-keys/mine/${mine.body.id}`)).status).toBe(204);
    expect((await authed(app, c.A).delete(`/v1/orgs/${c.org.orgId}/api-keys/mine/not-a-uuid`)).status).toBe(404);
  });
});
```
`test/e2e/tenancy/role-route-matrix.e2e.spec.ts` — thêm hằng và dùng trong ca bảng route:
```ts
/** Route tenant của 3D (spec §12). */
const ROUTES_3D = [
  'POST v1/orgs/:orgId/api-keys',
  'GET v1/orgs/:orgId/api-keys',
  'GET v1/orgs/:orgId/api-keys/mine',
  'DELETE v1/orgs/:orgId/api-keys/mine/:keyId',
  'DELETE v1/orgs/:orgId/api-keys/:keyId',
];
```
ca `the tenant route table…` thành `[...ROUTES_3A, ...ROUTES_3B, ...ROUTES_3C, ...ROUTES_3D]`; `Cast` thêm `key: string` (seed bằng `seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read'] })` trong `cast()`), `call` thêm `.replace(':keyId', c.key)` và body `route.id === 'POST v1/orgs/:orgId/api-keys' ? { name: 'matrix', permissions: ['org.read'], expiresInSec: 3600 }`; `NARROWING` thêm:
```ts
  'DELETE v1/orgs/:orgId/api-keys/mine/:keyId': { as: (c) => c.as.OWNER, status: 204 },
  'DELETE v1/orgs/:orgId/api-keys/:keyId': { as: (c) => c.as.OWNER, status: 204 },
```
(`c.key` do OWNER tạo nên OWNER thu hồi được qua cả hai route.)

Run: `pnpm vitest run --project e2e test/e2e/tenancy/org-api-keys.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts`
Expected: FAIL (route không tồn tại → `404`).

- [ ] **Step 2: Schema, scope helper, `userActor` fail loud**

`src/modules/tenancy/http/schemas.ts` — thêm (import `ORG_API_KEY_NAME_MAX_LENGTH`, `DELEGATION_PERMISSIONS_MAX` từ `../constants.js`, `OrgApiKeyRow`):
```ts
const singleLine = /^[^\r\n]*$/;
/** Phạm vi ủy quyền: tường minh, không rỗng (spec §8.5: không wildcard); lặp/khác thứ tự được chuẩn hoá ở domain. */
const delegationPermissions = z.array(PermissionKey).min(1).max(DELEGATION_PERMISSIONS_MAX);
/** `expiresInSec` ≥ 1 ở đây; trần `TENANCY_*_MAX_TTL_SEC` kiểm ở service (đọc config) → `422 ttl_out_of_range`. */
const expiresInSec = z.number().int().min(1);
export const CreateOrgApiKeyBody = z
  .object({
    // Cùng luật với `org_api_keys_name_ck` (`btrim`, 1–64): trim trước khi đo.
    name: z.string().trim().min(1).max(ORG_API_KEY_NAME_MAX_LENGTH).regex(singleLine, 'must be a single line'),
    permissions: delegationPermissions,
    expiresInSec,
  })
  .strict();
export const OrgApiKeyResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  keyHint: z.string(),
  permissions: z.array(z.string()),
  createdByMemberId: z.uuid(),
  expiresAt: iso,
  revokedAt: iso.nullable(),
  createdAt: iso,
});
export const orgApiKeyOf = (k: OrgApiKeyRow): z.infer<typeof OrgApiKeyResponse> => ({
  id: k.publicId,
  name: k.name,
  keyHint: k.keyHint,
  permissions: k.permissions,
  createdByMemberId: k.createdByMemberPublicId,
  expiresAt: k.expiresAt.toISOString(),
  revokedAt: k.revokedAt?.toISOString() ?? null,
  createdAt: k.createdAt.toISOString(),
});
/** `key` chỉ có ở `201`, đúng một lần (S3-A8). */
export const CreatedOrgApiKeyResponse = OrgApiKeyResponse.extend({ key: z.string() });
```
`src/modules/tenancy/application/delegation-scope.ts`:
```ts
import { AppError } from '../../../core/errors/index.js';
import type { DelegationKind, ScopeCheck } from '../domain/delegation.js';
import { TenancyErrors } from '../errors.js';
import type { EscalationGuard } from './escalation-guard.js';

/**
 * Lỗi của `checkDelegatedScope` → HTTP (spec SP3 §10, §15): `fields` liệt kê key vi phạm (như `RoleService`); vượt người
 * ủy quyền đi qua `EscalationGuard` (metric `tenancy_escalation_denied_total{rule="delegation"}`, WARN không kèm tập quyền).
 */
export function scopeOrThrow(kind: DelegationKind, check: ScopeCheck, escalation: EscalationGuard): string[] {
  if (check.ok) return check.scope;
  const fields = (code: string) => check.keys.map((key) => ({ path: 'permissions', code, message: key }));
  switch (check.reason) {
    case 'UNKNOWN_PERMISSION':
      throw new AppError(TenancyErrors.UNKNOWN_PERMISSION, { fields: fields('unknown_permission') });
    case 'NOT_ELIGIBLE':
      throw kind === 'API_KEY'
        ? new AppError(TenancyErrors.PERMISSION_NOT_API_KEY_ELIGIBLE, { fields: fields('permission_not_api_key_eligible') })
        : new AppError(TenancyErrors.PERMISSION_NOT_SUPPORT_ELIGIBLE, { fields: fields('permission_not_support_eligible') });
    case 'MISSING_DEPENDENCIES':
      throw new AppError(TenancyErrors.MISSING_DEPENDENCIES, { fields: fields('missing_dependency') });
    case 'EXCEEDS_GRANTOR':
      escalation.enforce({ ok: false, rule: 'delegation', reason: 'ESCALATION_DENIED' });
      throw new Error('EscalationGuard.enforce returned on a refusal');
    default: {
      const unknown: never = check.reason;
      throw new Error(`unknown delegation scope problem ${String(unknown)}`);
    }
  }
}
```
`src/modules/tenancy/application/actor-reauthorizer.ts` — `userActor`:
```ts
/**
 * Actor của event cho thao tác trực tiếp của user (spec SP3 §14): `principal.id`. Fail loud với principal không phải user
 * (org key: mọi route quản trị đòi quyền không `apiKeyEligible` hoặc `@SessionOnly`, nên tới được đây là lỗi lắp ráp).
 */
export function userActor(ctx: RequestContext): EventActor {
  const p = ctx.principal();
  if (!p) throw new Error('a user-initiated tenancy mutation ran without a principal');
  if (p.type !== 'user') throw new Error(`a user-initiated tenancy mutation ran with a ${p.type} principal`);
  return { type: 'user', id: p.id };
}
```

- [ ] **Step 3: Service**

`src/modules/tenancy/application/org-api-key.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { ORG_API_KEY_PREFIX } from '../../identity/index.js';
import { checkDelegatedScope } from '../domain/delegation.js';
import { assertCanManage } from '../domain/escalation.js';
import { newOrgApiKeySecret } from '../domain/org-api-key.js';
import { TenancyErrors } from '../errors.js';
import { ApiKeyCreatedEvent, ApiKeyRevokedEvent } from '../events.js';
import { MemberRepository } from '../ports/member-repository.js';
import { OrgApiKeyRepository, type OrgApiKeyRow } from '../ports/org-api-key-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { RolePermissions } from './authz/role-permissions.js';
import { scopeOrThrow } from './delegation-scope.js';
import { EscalationGuard } from './escalation-guard.js';
import { actorOfMember } from './invite-role.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

const WRITE_OWN = 'api_keys.write_own';
const WRITE_ALL = 'api_keys.write_all';
const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/**
 * Org API key (spec SP3 §10, §8.4 đường e). Tạo: dưới khoá org, đọc lại actor (T-10), phạm vi qua `checkDelegatedScope`
 * với quyền HIỆN TẠI của actor, đếm giới hạn dưới khoá (T-11). Thu hồi key của người khác: `api_keys.write_all` + luật 4,
 * 2a(v), 5 với quyền HIỆN TẠI của người tạo (`assertCanManage`). `…/mine`: chỉ key của chính member, không cần cửa (SEC2-N7).
 */
@Injectable()
export class OrgApiKeyService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly keys: OrgApiKeyRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly escalation: EscalationGuard,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async create(i: { name: string; permissions: string[]; expiresInSec: number }): Promise<{ key: OrgApiKeyRow; token: string }> {
    if (i.expiresInSec > this.cfg.orgApiKeyMaxTtlSec) throw new AppError(TenancyErrors.TTL_OUT_OF_RANGE);
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([WRITE_OWN]);
      const scope = scopeOrThrow(
        'API_KEY',
        checkDelegatedScope('API_KEY', i.permissions, permissions, this.registry.merged()),
        this.escalation,
      );
      // T-11: đếm dưới khoá org; `clock_timestamp()` vì câu chạy sau khi chờ khoá (§3.15).
      if ((await this.keys.countActiveForMember(actor.id)) >= this.cfg.maxActiveOrgApiKeysPerMember)
        throw new AppError(TenancyErrors.API_KEYS_LIMIT);
      const secret = newOrgApiKeySecret(ORG_API_KEY_PREFIX);
      const key = await this.keys.insert({
        createdByMemberId: actor.id,
        name: i.name,
        tokenHashHex: secret.hashHex,
        keyHint: secret.hint,
        expiresInSec: i.expiresInSec,
        permissions: scope,
      });
      await this.events.publish(ApiKeyCreatedEvent, {
        data: {
          apiKeyId: key.publicId,
          createdByMemberId: actor.publicId,
          permissions: key.permissions,
          expiresAt: key.expiresAt.toISOString(),
        },
        aggregate: { type: 'api_key', id: key.publicId, version: key.version },
        actor: userActor(this.ctx),
      });
      return { key, token: secret.token };
    });
  }

  async list(q: { page: number; pageSize: number; cap: number; mine: boolean }): Promise<{ rows: OrgApiKeyRow[]; total: number }> {
    const memberId = q.mine ? (await this.self()).id : undefined;
    const [rows, total] = await Promise.all([
      this.keys.list({ memberId, limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      this.keys.countUpTo(memberId, q.cap),
    ]);
    return { rows, total };
  }

  /** `…/mine/{keyId}`: key của người khác (hoặc không có) → `404` (không lộ tồn tại). */
  async revokeMine(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor } = await this.reauth.require([]);
      const key = await this.keys.lockByPublicId(publicId);
      if (!key || key.createdByMemberId !== actor.id) throw notFound();
      await this.revokeLocked(key);
    });
  }

  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      const found = await this.keys.findByPublicId(publicId);
      if (!found) throw notFound();
      // Thứ tự khoá §3.14: org → member (actor + người tạo, id tăng dần) → key.
      const { actor, permissions, locked } = await this.reauth.require([WRITE_ALL], [found.createdByMemberId]);
      const creator = locked.find((m) => m.id === found.createdByMemberId);
      if (!creator) throw notFound(); // FK CASCADE: người tạo rời org thì key đã mất
      if (creator.id !== actor.id)
        this.escalation.enforce(
          assertCanManage(
            actorOfMember(actor, permissions),
            {
              memberRef: creator.publicId,
              isOwner: creator.systemKey === 'OWNER',
              permissions: new Set(await this.rolePermissions.of({ id: creator.roleId, systemKey: creator.systemKey })),
            },
            this.registry.merged(),
          ),
        );
      const key = await this.keys.lockByPublicId(publicId);
      if (!key) throw notFound();
      await this.revokeLocked(key);
    });
  }

  /** Đã thu hồi → no-op (`DELETE` idempotent; trigger trạng thái cuối giữ `revoked_at`). */
  private async revokeLocked(key: OrgApiKeyRow): Promise<void> {
    const done = await this.keys.revoke(key.id);
    if (!done) return;
    await this.events.publish(ApiKeyRevokedEvent, {
      data: { apiKeyId: done.publicId, reason: 'REVOKED' },
      aggregate: { type: 'api_key', id: done.publicId, version: done.version },
      actor: userActor(this.ctx),
    });
  }

  private async self() {
    const access = this.ctx.orgAccess();
    if (access?.via !== 'MEMBERSHIP') throw new Error('an api-keys/mine route ran without a MEMBERSHIP orgAccess');
    const me = await this.members.findByPublicId(access.ref);
    if (!me) throw notFound();
    return me;
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw notFound(); // T-12
  }
}
```

- [ ] **Step 4: Controller, `NARROWING_ROUTES`, module**

`src/modules/tenancy/http/api-keys.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Paginator,
  paginationConfig,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { OrgApiKeyService } from '../application/org-api-key.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { NarrowingTenancyAction, OrgMemberOnly, SensitiveTenancyAction } from './decorators.js';
import {
  CreateOrgApiKeyBody,
  CreatedOrgApiKeyResponse,
  ListAcquisitionPage,
  OrgApiKeyResponse,
  orgApiKeyOf,
  publicIdOrNotFound,
} from './schemas.js';

/** Route `…/mine` khai báo TRƯỚC `…/{keyId}` (INT-M2). Không `@Idempotent()` ở POST: response chứa secret (S3-A8). */
@Controller('v1/orgs/:orgId/api-keys')
export class ApiKeysController {
  constructor(
    private readonly keys: OrgApiKeyService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY) private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Post()
  @TenancyPermissions.require('api_keys.write_own')
  @SensitiveTenancyAction()
  @ApiOk(CreatedOrgApiKeyResponse)
  @ApiProblems(
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.PERMISSION_NOT_API_KEY_ELIGIBLE,
    TenancyErrors.MISSING_DEPENDENCIES,
    TenancyErrors.UNKNOWN_PERMISSION,
    TenancyErrors.API_KEYS_LIMIT,
    TenancyErrors.TTL_OUT_OF_RANGE,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(@Body({ schema: CreateOrgApiKeyBody }) body: z.infer<typeof CreateOrgApiKeyBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const { key, token } = await this.keys.create(body);
    const orgId = this.ctx.orgId();
    if (orgId === undefined) throw new Error('ApiKeysController.create ran without an org context');
    setLocation(res, `/v1/orgs/${orgId}/api-keys/${key.publicId}`);
    res.setHeader('Cache-Control', 'no-store');
    return serialize(CreatedOrgApiKeyResponse, { ...orgApiKeyOf(key), key: token });
  }

  @Get('mine')
  @OrgMemberOnly()
  @ApiOk(OrgApiKeyResponse)
  listMine(@Query({ schema: ListAcquisitionPage }) page: z.infer<typeof ListAcquisitionPage>) {
    return this.page(page, true);
  }

  @Delete('mine/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrgMemberOnly()
  @NarrowingTenancyAction()
  async revokeMine(@Param('keyId') keyId: string): Promise<void> {
    await this.keys.revokeMine(publicIdOrNotFound(keyId));
  }

  @Get()
  @TenancyPermissions.require('api_keys.read')
  @ApiOk(OrgApiKeyResponse)
  list(@Query({ schema: ListAcquisitionPage }) page: z.infer<typeof ListAcquisitionPage>) {
    return this.page(page, false);
  }

  @Delete(':keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('api_keys.write_all')
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.ESCALATION_DENIED, TenancyErrors.OWNER_ONLY)
  async revoke(@Param('keyId') keyId: string): Promise<void> {
    await this.keys.revoke(publicIdOrNotFound(keyId));
  }

  private async page(page: z.infer<typeof ListAcquisitionPage>, mine: boolean) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=createdAt (ascending) is supported.' });
    const { rows, total } = await this.keys.list({ page: page.page, pageSize: page.pageSize, cap: this.pagination.totalCountCap, mine });
    return this.pages.offset(rows.map((k) => serialize(OrgApiKeyResponse, orgApiKeyOf(k))), page, total);
  }
}
```
`src/modules/tenancy/http/policy-metadata.ts` — `NARROWING_ROUTES` thêm:
```ts
  'DELETE v1/orgs/:orgId/api-keys/mine/:keyId',
  'DELETE v1/orgs/:orgId/api-keys/:keyId',
```
`src/modules/tenancy/http/tenancy-http.module.ts` — `controllers` thêm `ApiKeysController`, `providers` thêm `OrgApiKeyService`.

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm vitest run --project e2e test/e2e/tenancy/org-api-keys.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/tenancy-http-boot.e2e.spec.ts
```
Expected: PASS. G-8 (boot) chấp nhận ba route ghi mới (một ✓, hai thu hẹp); bảng thu hẹp của ma trận khớp `NARROWING_ROUTES`.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy/org-api-keys.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts
pnpm lint && pnpm arch
git add src/modules/tenancy test/e2e/tenancy/org-api-keys.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts
git commit -m "feat(tenancy): org API keys — create within the creator's current permissions, list, revoke own or others under rule 4"
```

---

### Task 20: Xác thực org key (`OrgApiKeyAuthenticator`), nhánh key của `OrgContextMiddleware`, `OrgApiKeyConfinementGuard` (K-4, K-5, K-7, K-10, K-13, K-14, B-17, T-17, T-30, limiter với org key, Review Focus 1)

**Files:**
- Create: `src/modules/tenancy/infra/identity/org-api-key.authenticator.ts`, `src/modules/tenancy/http/org-api-key-confinement.guard.ts`, `test/unit/modules/tenancy/org-api-key-confinement.spec.ts`, `test/e2e/tenancy/org-api-key-auth.e2e.spec.ts`
- Modify: `src/modules/tenancy/infra/identity/tenancy-identity-ports.module.ts`, `src/modules/tenancy/http/org-context.middleware.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `src/modules/tenancy/application/tenancy-metrics.ts`

**Interfaces:**
- Consumes: `OrgCredentialAuthenticator`, `AuthResult`, `IdentityDirectory`, `isBanned`, `identityConfig`, `IdentityErrors.API_KEY_NOT_ALLOWED_HERE` (Task 4, identity `index.ts`), `OrgApiKeyRepository.findByTokenHash/findActiveForAccess`, `DelegatedPermissions.forApiKey` (Task 18), `orgApiKeyHashHex` (Task 17), `classifyTenantHandler` (3A/SP4), `TenancyMetrics.orgApiKeyAuth` (Task 16).
- Produces:
  - `OrgApiKeyAuthenticator extends OrgCredentialAuthenticator` (provider của `TenancyIdentityPortsModule`, `@Global`), `AUTHENTICATED { principal: { type: 'api_key', id: keyPublicId }, credential: { kind: 'ORG_API_KEY', id: keyPublicId, orgId }, isPlatformAdmin: false, authenticatedAt: undefined, emailVerified: false, verifiedEmail: undefined, sessionId: undefined }`.
  - `OrgAccessResult` thêm `'second_factor_required'` (Task 22 dùng); metric `tenancy_org_access_total{via, result}` nhận `via` thật.
  - `OrgApiKeyConfinementGuard` (`APP_GUARD` của `TenancyHttpModule`).

- [ ] **Step 1: Unit guard (fail)**

`test/unit/modules/tenancy/org-api-key-confinement.spec.ts`:
```ts
import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../../../../src/core/context/index.js';
import { OrgApiKeyConfinementGuard } from '../../../../src/modules/tenancy/http/org-api-key-confinement.guard.js';

@Controller('v1/orgs/:orgId/things')
class Tenant {
  @Get() list(): void {}
}
@Controller('v1/me')
class Me {
  @Get() get(): void {}
}
const exec = (cls: Function, handler: Function): ExecutionContext =>
  ({ getType: () => 'http', getClass: () => cls, getHandler: () => handler }) as unknown as ExecutionContext;
const ctxWith = (kind: string | undefined) => ({ credential: () => (kind ? { kind } : undefined) }) as unknown as RequestContext;

describe('OrgApiKeyConfinementGuard (spec SP3 §7.1 bước 4, §10)', () => {
  it('an org key on a tenant route passes; anywhere else → 403 api_key_not_allowed_here', () => {
    const g = new OrgApiKeyConfinementGuard(ctxWith('ORG_API_KEY'));
    expect(g.canActivate(exec(Tenant, Tenant.prototype.list))).toBe(true);
    expect(() => g.canActivate(exec(Me, Me.prototype.get))).toThrow(expect.objectContaining({ code: 'api_key_not_allowed_here' }));
  });
  it('every other credential is not this guard’s business', () => {
    for (const kind of [undefined, 'SESSION_COOKIE', 'BEARER_SESSION', 'API_KEY', 'EXTERNAL_BEARER'])
      expect(new OrgApiKeyConfinementGuard(ctxWith(kind)).canActivate(exec(Me, Me.prototype.get))).toBe(true);
  });
});
```
(Ép kiểu `as unknown as` chỉ ở fixture test cho hai interface của Nest; không có ở `src`.)

Run: `pnpm vitest run --project unit test/unit/modules/tenancy/org-api-key-confinement.spec.ts`
Expected: FAIL (module không tồn tại).

- [ ] **Step 2: E2E (fail)**

`test/e2e/tenancy/org-api-key-auth.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { apiKeyEligibleKeys, seedMember, seedOrg, seedOrgApiKey, type SeededOrg } from '../../support/tenancy-seed.js';

const HEADER = 'x-api-key';
const MISS_LIMIT = 3;

describe('org API key authentication and confinement (spec SP3 §7.1 bước 2, 3.6, 3.7; §10; §18.2; §18.3 K-4–K-7, K-10, K-13, K-14, B-17; Review Focus 1)', () => {
  let app: INestApplication;
  let full: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const keyGet = (token: string, url: string) => request(app.getHttpServer()).get(url).set(HEADER, token);
  const setup = async () => {
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = await seedUserPrincipal();
    principals.push(A);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const key = await seedOrgApiKey(org, { createdByMemberId: a.memberId, permissions: full });
    return { org, O, A, a, key };
  };

  beforeAll(async () => {
    app = await startTenancyApp({ env: { TENANCY_ORG_MISS_RATE_LIMIT: String(MISS_LIMIT) } });
    full = apiKeyEligibleKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a valid key reads its org (via ORG_API_KEY); it never authenticates on Better Auth', async () => {
    const s = await setup();
    const r = await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`);
    expect(r.status).toBe(200);
    expect(r.headers['x-ratelimit-limit']).toBeDefined(); // throttler khoá `principal:api_key:<id>:<org>`
  });
  it('K-4/K-5/T-30: the creator demoted → the route needing the lost permission 403; promoted again → 200 at the next request', async () => {
    const s = await setup();
    expect((await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/api-keys`)).status).toBe(200);
    await ownerQuery(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [s.org.roles.MEMBER.id, s.a.memberId]);
    expect((await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status).toBe(200);
    const demoted = await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/api-keys`);
    expect([demoted.status, demoted.body.code]).toEqual([403, 'forbidden']);
    await ownerQuery(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [s.org.roles.ADMIN.id, s.a.memberId]);
    expect((await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/api-keys`)).status).toBe(200);
  });
  it('K-7: a valid key on another org → the same 404 as a non-member, counted by the org-miss limiter, then 429', async () => {
    const s = await setup();
    const other = await setup();
    const miss = await keyGet(s.key.token, `/v1/orgs/${other.org.orgId}/members`);
    expect([miss.status, miss.body.code]).toEqual([404, 'not_found']);
    expect(miss.headers['x-ratelimit-limit']).toBeUndefined();
    for (let i = 1; i < MISS_LIMIT; i++) await keyGet(s.key.token, `/v1/orgs/${other.org.orgId}/members`);
    const blocked = await keyGet(s.key.token, `/v1/orgs/${other.org.orgId}/members`);
    expect([blocked.status, blocked.body.code]).toEqual([429, 'rate_limited']);
  });
  it('K-13/T-31: a key of a soft-deleted org → 401; K-14: creator banned or unverified → 401; revoked (T-17) or expired → 401', async () => {
    const s = await setup();
    await ownerQuery(`UPDATE auth."user" SET banned = true WHERE id = $1`, [s.A.authUserId]);
    expect((await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status).toBe(401);
    await ownerQuery(`UPDATE auth."user" SET banned = false, email_verified = false WHERE id = $1`, [s.A.authUserId]);
    expect((await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status).toBe(401);
    await ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE id = $1`, [s.A.authUserId]);
    expect((await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status).toBe(200);
    const del = await request(app.getHttpServer())
      .delete(`/v1/orgs/${s.org.orgId}`)
      .set('authorization', `Bearer ${s.O.bearer}`);
    expect(del.status).toBe(204);
    expect((await keyGet(s.key.token, `/v1/orgs/${s.org.orgId}/members`)).status).toBe(401);
    const t = await setup();
    const revoked = await seedOrgApiKey(t.org, { createdByMemberId: t.a.memberId, permissions: ['org.read'], revoked: true });
    const expired = await seedOrgApiKey(t.org, { createdByMemberId: t.a.memberId, permissions: ['org.read'], expiresInSec: -60 });
    for (const k of [revoked, expired]) expect((await keyGet(k.token, `/v1/orgs/${t.org.orgId}`)).status).toBe(401);
  });
  it('Review Focus 1: malformed and case-mangled oak_ keys are a plain 401', async () => {
    const s = await setup();
    // Khoảng trắng đầu/cuối của giá trị header bị parser HTTP bỏ (OWS) nên không phải một biến thể; ký tự xuống dòng không
    // gửi được trong header.
    const variants = [
      `OAK_${s.key.token.slice(4)}`,
      `${s.key.token}x`,
      s.key.token.slice(0, 20),
      `${s.key.token.slice(0, -1)}*`,
      'oak_',
    ];
    for (const v of variants) {
      const r = await keyGet(v, `/v1/orgs/${s.org.orgId}`);
      expect([r.status, r.body.code], JSON.stringify(v)).toEqual([401, 'unauthenticated']);
    }
  });
  it('confinement: an org key on /v1/me and /v1/orgs → 403 api_key_not_allowed_here; K-10: a Better Auth user key on a tenant route → 403 api_key_not_org_scoped', async () => {
    const s = await setup();
    for (const url of ['/v1/me', '/v1/orgs', '/v1/permissions']) {
      const r = await keyGet(s.key.token, url);
      expect([r.status, r.body.code], url).toEqual([403, 'api_key_not_allowed_here']);
    }
    const created = await request(app.getHttpServer())
      .post('/api/auth/api-key/create')
      .set('authorization', `Bearer ${s.A.bearer}`)
      .set('origin', 'http://localhost:3000')
      .send({ name: 'user key' });
    expect(created.status).toBe(200);
    const r = await keyGet(String(created.body.key), `/v1/orgs/${s.org.orgId}`);
    expect([r.status, r.body.code]).toEqual([403, 'api_key_not_org_scoped']);
  });
  it('B-17: every binding path called with an org key holding the full eligible scope → 403', async () => {
    const s = await setup();
    const owner = await seedOrgApiKey(s.org, { createdByMemberId: s.org.owner.memberId, permissions: full });
    const base = `/v1/orgs/${s.org.orgId}`;
    const writes: [string, string, Record<string, unknown>][] = [
      ['patch', `${base}/members/${s.a.memberPublicId}`, { roleId: s.org.roles.MEMBER.publicId }],
      ['post', `${base}/roles`, { name: 'k', permissions: ['org.read'] }],
      ['post', `${base}/invitations`, { email: 'k@example.test', roleId: s.org.roles.MEMBER.publicId }],
      ['post', `${base}/invite-links`, { roleId: s.org.roles.MEMBER.publicId, maxUses: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
      ['post', `${base}/api-keys`, { name: 'k', permissions: ['org.read'], expiresInSec: 60 }],
      ['post', `${base}/support-grants`, { staffUserId: s.A.authUserId, expiresInSec: 900, reason: 'x' }],
      ['post', `${base}/ownership-transfers`, { toMemberId: s.a.memberPublicId, stepDownTo: null }],
    ];
    for (const [method, url, body] of writes) {
      const agent = request(app.getHttpServer());
      const req = method === 'patch' ? agent.patch(url).set('if-match', '*') : agent.post(url).set('idempotency-key', `k-${url}`);
      const r = await req.set(HEADER, owner.token).send(body);
      expect(r.status, `${method} ${url}`).toBe(403);
    }
  });
});
```
(Ca K-4 dùng `GET …/api-keys` (`api_keys.read`, `apiKeyEligible`: ADMIN có, MEMBER không). Header là `AUTH_API_KEY_HEADER` mặc định `x-api-key` của SP2. Route support-grants có từ Task 21: ca B-17 chạy đủ ở Task 21 Step 4.)

Run: `pnpm vitest run --project e2e test/e2e/tenancy/org-api-key-auth.e2e.spec.ts`
Expected: FAIL (`oak_` hợp lệ vẫn `401` vì port vắng).

- [ ] **Step 3: Authenticator**

`src/modules/tenancy/infra/identity/org-api-key.authenticator.ts`:
```ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../../core/config/index.js';
import { OrgScope, UnitOfWork, isDbInfraError } from '../../../../core/database/index.js';
import {
  IdentityDirectory,
  OrgCredentialAuthenticator,
  identityConfig,
  isBanned,
  type AuthResult,
} from '../../../identity/index.js';
import { TenancyMetrics, type OrgApiKeyAuthResult } from '../../application/tenancy-metrics.js';
import { orgApiKeyHashHex } from '../../domain/org-api-key.js';
import { OrgApiKeyRepository } from '../../ports/org-api-key-repository.js';

const REJECTED: AuthResult = { kind: 'REJECTED' };
const UNAVAILABLE: AuthResult = { kind: 'UNAVAILABLE' };

/**
 * Spec SP3 §7.1 bước 2, §10 (SEC-I4, SEC-I8): SHA-256 của toàn bộ chuỗi (mọi dạng `oak_…`, kể cả hoa/thường hay cắt cụt,
 * cho đúng 32 byte, Review Focus 1) → hàm definer (không cần OrgScope) → dòng key còn hạn, chưa thu hồi, org chưa xoá mềm,
 * người tạo còn member (FK CASCADE) → local/hybrid: user của người tạo còn, không bị ban, đã xác thực email. Mọi lỗi của
 * chính credential → `REJECTED` (401); lỗi hạ tầng → `UNAVAILABLE` (503), không ném. Lời gọi pool auth nằm NGOÀI transaction
 * của pool app.
 */
@Injectable()
export class OrgApiKeyAuthenticator extends OrgCredentialAuthenticator {
  private readonly logger = new Logger(OrgApiKeyAuthenticator.name);

  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly keys: OrgApiKeyRepository,
    private readonly metrics: TenancyMetrics,
    @Inject(identityConfig.KEY) private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {
    super();
  }

  async authenticate(rawKey: string): Promise<AuthResult> {
    let access;
    let orgId: string;
    try {
      const match = await this.keys.findByTokenHash(orgApiKeyHashHex(rawKey));
      if (!match) return this.done('invalid', REJECTED);
      orgId = match.orgId;
      access = await this.scope.run(match.orgId, () => this.uow.run(() => this.keys.findActiveForAccess(match.publicId)));
      if (!access) return this.done('invalid', REJECTED);
    } catch (err) {
      if (!isDbInfraError(err)) throw err;
      return this.done('unavailable', UNAVAILABLE);
    }
    if (this.identity.mode !== 'external') {
      if (!this.directory) throw new Error('org API keys in local/hybrid mode need IdentityDirectory');
      // Người tạo seed ở external rồi đổi mode: không có auth user → key không dùng được (runbook đổi mode).
      if (access.creatorAuthUserId === null) return this.done('invalid', REJECTED);
      let user;
      try {
        user = await this.directory.findUser(access.creatorAuthUserId);
      } catch (err) {
        this.logger.error({ event: 'org_api_key_directory_failed', err }, 'identity directory failed during org API key authentication');
        return this.done('unavailable', UNAVAILABLE);
      }
      if (!user) return this.done('invalid', REJECTED);
      if (isBanned(user, new Date())) return this.done('creator_banned', REJECTED);
      if (!user.emailVerified) return this.done('creator_unverified', REJECTED);
    }
    return this.done('ok', {
      kind: 'AUTHENTICATED',
      principal: { type: 'api_key', id: access.keyPublicId },
      credential: { kind: 'ORG_API_KEY', id: access.keyPublicId, orgId },
      isPlatformAdmin: false,
      authenticatedAt: undefined,
      emailVerified: false,
      verifiedEmail: undefined,
      sessionId: undefined,
    });
  }

  private done(result: OrgApiKeyAuthResult, r: AuthResult): AuthResult {
    this.metrics.orgApiKeyAuth.add(1, { result });
    return r;
  }
}
```
(Lỗi directory ghi ERROR có `err` nhưng không có key/email: lỗi pg của pool auth không chứa giá trị của câu `findUser` ngoài id user, là principal id được phép log.)

`src/modules/tenancy/infra/identity/tenancy-identity-ports.module.ts` — `providers` thêm `OrgApiKeyAuthenticator, { provide: OrgCredentialAuthenticator, useExisting: OrgApiKeyAuthenticator }`, `exports` thêm `OrgCredentialAuthenticator`; chú thích lớp thêm câu "3D: `OrgCredentialAuthenticator` (§5.2), `PlatformRoleChangeListener` (Task 23)".

- [ ] **Step 4: Nhánh key của middleware**

`src/modules/tenancy/application/tenancy-metrics.ts` — `OrgAccessResult` thêm `| 'second_factor_required'`.

`src/modules/tenancy/http/org-context.middleware.ts` — constructor thêm `private readonly keys: OrgApiKeyRepository, private readonly delegated: DelegatedPermissions`; `use()` đổi span và metric theo `via` thật:
```ts
    await tenancySpan(
      'tenancy.org_context.resolve',
      () => this.resolve(req, principal, orgId),
      (outcome) => ({ 'tenancy.access.via': outcome.via, 'tenancy.access.result': outcome.result }),
    );
```
`resolve` trả `Outcome = { via: OrgAccessVia; result: OrgAccessResult }`; mọi `this.count(result)` thành `this.count(via, result)`; khối đầu của `resolve`:
```ts
    const credential = this.ctx.credential();
    if (credential?.kind === 'API_KEY') {
      this.count('MEMBERSHIP', 'user_key_rejected');
      throw new AppError(TenancyErrors.API_KEY_NOT_ORG_SCOPED);
    }
    const via: OrgAccessVia = credential?.kind === 'ORG_API_KEY' ? 'ORG_API_KEY' : 'MEMBERSHIP';
    const limiterKey = `principal:${principal.type}:${principal.id}`;
    const peek = await this.orgMiss.peek(limiterKey);
    if (peek.blocked) { /* như cũ, count(via, 'rate_limited') */ }
    if (credential?.kind === 'ORG_API_KEY') return this.resolveOrgKey(credential, orgId, limiterKey);
```
và thêm:
```ts
  /** Bước 3.6–3.7 nhánh key: org khác → trượt thật; cùng org → phạm vi ∩ quyền HIỆN TẠI của người tạo (§8.5, T-30). */
  private async resolveOrgKey(credential: Credential, orgId: string, limiterKey: string): Promise<Outcome> {
    if (credential.id === undefined || credential.orgId === undefined)
      throw new Error('an ORG_API_KEY credential without id/orgId');
    const keyId = credential.id;
    const permissions =
      credential.orgId === orgId
        ? await this.readInOrg('ORG_API_KEY', orgId, async () => {
            const access = await this.keys.findActiveForAccess(keyId);
            return access ? this.delegated.forApiKey(access) : undefined;
          })
        : undefined;
    if (!permissions) return this.miss('ORG_API_KEY', limiterKey);
    this.ctx.setOrgId(orgId);
    this.ctx.setOrgAccess({ via: 'ORG_API_KEY', ref: keyId, permissions, orgDeleted: false });
    this.count('ORG_API_KEY', 'granted');
    return { via: 'ORG_API_KEY', result: 'granted' };
  }
```
`lookup` cũ tách phần bắt lỗi thành `readInOrg<T>(via: OrgAccessVia, orgId: string, fn: () => Promise<T>): Promise<T>` (OrgScope + UnitOfWork, `isDbInfraError` → `count(via, 'unavailable')` + `503` + `Retry-After`, ghi `orgContextDuration`), và nhánh membership gọi `readInOrg('MEMBERSHIP', …)`. Nhánh trượt cũ thành:
```ts
  /** Chỗ DUY NHẤT ghi vào limiter và ném 404 (bước 3.8): mọi nhánh trượt đi qua đây. */
  private async miss(via: OrgAccessVia, limiterKey: string): Promise<never> {
    await this.orgMiss.consume(limiterKey);
    this.count(via, 'not_found');
    throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  }
  private count(via: OrgAccessVia, result: OrgAccessResult): void {
    this.metrics.orgAccess.add(1, { via, result });
  }
```
(Import `type Credential`, `type OrgAccessVia` từ `core/context`.)

- [ ] **Step 5: Guard giam key**

`src/modules/tenancy/http/org-api-key-confinement.guard.ts`:
```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { AppError } from '../../../core/errors/index.js';
import { IdentityErrors } from '../../identity/index.js';
import { classifyTenantHandler } from './org-route.js';

/**
 * Spec SP3 §7.1 bước 4, §10 (Q3): org key chỉ dùng trên route tenant của org của nó. Route ngoài tenant (kể cả `@PublicRoute`
 * và route `features/` ngoài `v1/orgs/:orgId`) → `403 api_key_not_allowed_here` (mã của identity: `AuthGuard` trả cùng mã ở
 * `@SessionOnly`, nên thứ tự giữa hai `APP_GUARD` không đổi response). Cùng matcher với inventory (INT-I5).
 */
@Injectable()
export class OrgApiKeyConfinementGuard implements CanActivate {
  constructor(private readonly ctx: RequestContext) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    if (this.ctx.credential()?.kind !== 'ORG_API_KEY') return true;
    if (classifyTenantHandler(context.getClass(), context.getHandler()) === 'TENANT') return true;
    throw new AppError(IdentityErrors.API_KEY_NOT_ALLOWED_HERE, { expected: true });
  }
}
```
`tenancy-http.module.ts` — `providers` thêm `{ provide: APP_GUARD, useClass: OrgApiKeyConfinementGuard }` (import `APP_GUARD` từ `@nestjs/core`).

- [ ] **Step 6: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm vitest run --project e2e test/e2e/tenancy/org-api-key-auth.e2e.spec.ts test/e2e/tenancy/org-context.e2e.spec.ts test/e2e/tenancy/org-miss-limiter.e2e.spec.ts test/e2e/tenancy/middleware-order-identity-first.e2e.spec.ts test/e2e/tenancy/middleware-order-tenancy-first.e2e.spec.ts test/e2e/tenancy/telemetry-pii.e2e.spec.ts
```
Expected: PASS, trừ ca B-17: dòng `support-grants` của nó cần route của Task 21, nên ở bước này chạy file với bộ lọc tên loại ca đó; Task 21 Step 4 chạy đủ file:
```bash
pnpm vitest run --project e2e test/e2e/tenancy/org-api-key-auth.e2e.spec.ts -t "^(?!.*B-17)"
```

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/unit/modules/tenancy/org-api-key-confinement.spec.ts test/e2e/tenancy/org-api-key-auth.e2e.spec.ts
pnpm lint && pnpm arch
git add src/modules/tenancy test/unit/modules/tenancy/org-api-key-confinement.spec.ts test/e2e/tenancy/org-api-key-auth.e2e.spec.ts
git commit -m "feat(tenancy): authenticate org API keys, resolve their org access from the creator's current role, confine them to tenant routes"
```

---

### Task 21: Support grant — cấp, liệt kê, thu hồi (S-1, S-2, S-3, S-8, S-13, S-14, T-20, U17 HTTP, Review Focus 2 phần grant)

**Files:**
- Create: `src/modules/tenancy/application/support-grant.service.ts`, `src/modules/tenancy/http/support-grants.controller.ts` (khung bằng `pnpm exec nest g controller modules/tenancy/http/support-grants --flat --no-spec`), `test/e2e/tenancy/support-grants.e2e.spec.ts`
- Modify: `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/policy-metadata.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `src/modules/tenancy/application/delegation-revocations.ts` (tạo ở Task 21 với `revokeOpenForGrantee`, Task 24 thêm phương thức), `test/e2e/tenancy/role-route-matrix.e2e.spec.ts`

**Interfaces:**
- Consumes: `SupportGrantRepository` (Task 18), `supportPreset` (Task 17), `IdentityDirectory.findUser`, `hasAdminRole`, `isBanned` (identity `index.ts`), `TenancyUserRepository.upsertAndLock`, `MemberRepository.findByUserId`, `TenancyFeatures.require('supportGrants')`, `SupportAccessGrantedEvent`, `SupportAccessRevokedEvent`, `TenancyErrors.SUPPORT_GRANTEE_INELIGIBLE`.
- Produces:
  - `DelegationRevocations` (provider của `TenancyCoreModule`): `revokeGrantsOfGrantee(granteeUserId: string, reason: SupportGrantRevokeReason, actor: EventActor): Promise<number>` (thu hồi + một event mỗi grant; Task 23, 24 dùng).
  - `SupportGrantService.grant(i: { staffUserId: string; expiresInSec: number; reason: string }): Promise<SupportGrantRow>`; `.list(q)`; `.revoke(publicId)`.
  - Schema: `CreateSupportGrantBody { staffUserId: uuid, expiresInSec: int ≥ 1, reason: string 1–500 trim }`, `SupportGrantResponse`, `supportGrantOf(row)`.
  - `NARROWING_ROUTES` thêm `'DELETE v1/orgs/:orgId/support-grants/:grantId'` (tổng 8 route, spec §12).

- [ ] **Step 1: E2E (fail)**

`test/e2e/tenancy/support-grants.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgRouteInventory } from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, supportPresetKeys, type SeededOrg } from '../../support/tenancy-seed.js';

const MAX_TTL = 7_200;

describe('support grants: grant, list, revoke (spec SP3 §9.7, §12; §18.3 S-1–S-3, S-8, S-13, S-14; T-20; Review Focus 2)', () => {
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const track = <T extends SeededPrincipal>(p: T) => (principals.push(p), p);
  const cast = async () => {
    const O = track(await seedUserPrincipal());
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const A = track(await seedUserPrincipal());
    await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const staff = track(await seedStaffPrincipal());
    return { org, O, A, staff };
  };
  const grant = (p: SeededPrincipal, org: SeededOrg, body: Record<string, unknown>) =>
    authed(app, p).post(`/v1/orgs/${org.orgId}/support-grants`).set('idempotency-key', `k-${v7()}`).send(body);
  const body = (staff: SeededPrincipal, extra: Record<string, unknown> = {}) => ({
    staffUserId: staff.authUserId,
    expiresInSec: 900,
    reason: 'SUP-1234',
    ...extra,
  });
  const tenancyUsersOf = async (authUserId: string) =>
    (await ownerQuery(`SELECT 1 FROM tenancy_users WHERE auth_user_id = $1`, [authUserId])).length;

  beforeAll(async () => {
    app = await startTenancyApp({ env: { TENANCY_SUPPORT_GRANT_MAX_TTL_SEC: String(MAX_TTL) } });
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('201: the owner grants the read-only preset (S-14: never billing.read); event granted; GET lists it', async () => {
    const c = await cast();
    const r = await grant(c.O, c.org, body(c.staff));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ permissions: preset, reason: 'SUP-1234', revokedAt: null, firstUsedAt: null });
    expect(r.body.permissions).not.toContain('billing.read');
    const [ev] = await ownerQuery<{ payload: Record<string, unknown>; headers: Record<string, string> }>(
      `SELECT payload, headers FROM outbox_events WHERE type = 'tenancy.support_access.granted' AND aggregate_id = $1`,
      [r.body.id],
    );
    expect(ev?.payload).toEqual({
      grantId: r.body.id,
      granteeUserId: r.body.granteeUserId,
      grantedByMemberId: c.org.owner.memberPublicId,
      permissions: preset,
      expiresAt: r.body.expiresAt,
    });
    expect(JSON.stringify(ev?.payload)).not.toContain('SUP-1234'); // reason không vào event
    const list = await authed(app, c.O).get(`/v1/orgs/${c.org.orgId}/support-grants`);
    expect(list.body.data.map((g: { id: string }) => g.id)).toEqual([r.body.id]);
  });
  it('S-1: an ADMIN grants → 403; S-2: there is no route for staff to grant themselves anything', async () => {
    const c = await cast();
    expect((await grant(c.A, c.org, body(c.staff))).status).toBe(403);
    const ids = app.get(OrgRouteInventory).tenantRoutes().map((r) => r.id).filter((id) => id.includes('support-grants'));
    expect(ids.sort()).toEqual(
      ['DELETE v1/orgs/:orgId/support-grants/:grantId', 'GET v1/orgs/:orgId/support-grants', 'POST v1/orgs/:orgId/support-grants'].sort(),
    );
  });
  it('S-3/S-13: a member, a user without 2FA, a non-staff user, a banned staff, a random id → one 422 support_grantee_ineligible, no tenancy_users row', async () => {
    const c = await cast();
    const noFactor = track(await seedUserPrincipal({ role: 'admin' }));
    const plain = track(await seedUserPrincipal());
    const banned = track(await seedStaffPrincipal());
    await ownerQuery(`UPDATE auth."user" SET banned = true WHERE id = $1`, [banned.authUserId]);
    const member = track(await seedStaffPrincipal());
    await seedMember(c.org, 'MEMBER', { authUserId: member.authUserId });
    for (const who of [noFactor, plain, banned])
      expect(await (async () => {
        const r = await grant(c.O, c.org, body(who));
        return [r.status, r.body.code, await tenancyUsersOf(who.authUserId)];
      })()).toEqual([422, 'support_grantee_ineligible', 0]);
    const asMember = await grant(c.O, c.org, body(member));
    expect([asMember.status, asMember.body.code]).toEqual([422, 'support_grantee_ineligible']);
    const random = await grant(c.O, c.org, { ...body(c.staff), staffUserId: v7() });
    expect([random.status, random.body.code]).toEqual([422, 'support_grantee_ineligible']);
  });
  it('T-20: granting again revokes the open grant of the same staff (one open grant per grantee) with event REVOKED', async () => {
    const c = await cast();
    const first = await grant(c.O, c.org, body(c.staff));
    const second = await grant(c.O, c.org, body(c.staff));
    expect(second.status).toBe(201);
    const rows = await ownerQuery<{ public_id: string; revoked: boolean }>(
      `SELECT public_id::text, revoked_at IS NOT NULL AS revoked FROM org_support_grants WHERE org_id = $1 ORDER BY id`,
      [c.org.orgId],
    );
    expect(rows).toEqual([{ public_id: first.body.id, revoked: true }, { public_id: second.body.id, revoked: false }]);
    const rs = await Promise.all([grant(c.O, c.org, body(c.staff)), grant(c.O, c.org, body(c.staff))]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    const open = await ownerQuery(`SELECT 1 FROM org_support_grants WHERE org_id = $1 AND revoked_at IS NULL`, [c.org.orgId]);
    expect(open).toHaveLength(1);
  });
  it('Review Focus 2 (grant): expiresInSec at the max → 201, max + 1 → 422 ttl_out_of_range; bad numbers and reasons → 422 validation_failed', async () => {
    const c = await cast();
    expect((await grant(c.O, c.org, body(c.staff, { expiresInSec: MAX_TTL }))).status).toBe(201);
    const over = await grant(c.O, c.org, body(c.staff, { expiresInSec: MAX_TTL + 1 }));
    expect([over.status, over.body.code]).toEqual([422, 'ttl_out_of_range']);
    for (const bad of [0, -5, 2.5, '900'])
      expect((await grant(c.O, c.org, body(c.staff, { expiresInSec: bad }))).body.code).toBe('validation_failed');
    for (const reason of ['', '  ', 'x'.repeat(501)])
      expect((await grant(c.O, c.org, body(c.staff, { reason }))).body.code).toBe('validation_failed');
    expect((await grant(c.O, c.org, body(c.staff, { staffUserId: 'NOT-A-UUID' }))).body.code).toBe('validation_failed');
  });
  it('S-8: the staff cannot extend or re-grant through the org (403/404), even with a step-up; the owner revokes → 204, event REVOKED, idempotent', async () => {
    const c = await cast();
    const g = await grant(c.O, c.org, body(c.staff));
    const self = await grant(c.staff, c.org, body(c.staff, { expiresInSec: MAX_TTL }));
    expect([403, 404]).toContain(self.status);
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/support-grants/${g.body.id}`)).status).toBe(204);
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/support-grants/${g.body.id}`)).status).toBe(204);
    const evs = await ownerQuery<{ payload: { reason: string } }>(
      `SELECT payload FROM outbox_events WHERE type = 'tenancy.support_access.revoked' AND aggregate_id = $1`,
      [g.body.id],
    );
    expect(evs.map((e) => e.payload.reason)).toEqual(['REVOKED']);
  });
});

describe('support grants switched off (U17: TENANCY_SUPPORT_GRANTS=off)', () => {
  it('POST → 403 feature_disabled; GET and DELETE still work for grants that exist', async () => {
    const app = await startTenancyApp({ env: { TENANCY_SUPPORT_GRANTS: 'off' } });
    const O = await seedUserPrincipal();
    const staff = await seedStaffPrincipal();
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    try {
      const r = await authed(app, O)
        .post(`/v1/orgs/${org.orgId}/support-grants`)
        .set('idempotency-key', `k-${v7()}`)
        .send({ staffUserId: staff.authUserId, expiresInSec: 900, reason: 'x' });
      expect([r.status, r.body.code]).toEqual([403, 'feature_disabled']);
      expect((await authed(app, O).get(`/v1/orgs/${org.orgId}/support-grants`)).status).toBe(200);
    } finally {
      await org.dispose();
      await app.close();
      await deleteSeededPrincipals([O, staff]);
    }
  });
});
```
Run: `pnpm vitest run --project e2e test/e2e/tenancy/support-grants.e2e.spec.ts`
Expected: FAIL (route không tồn tại).

- [ ] **Step 2: Schema, revocations, service**

`src/modules/tenancy/http/schemas.ts` — thêm (import `SUPPORT_GRANT_REASON_MAX_LENGTH`, `SupportGrantRow`):
```ts
export const CreateSupportGrantBody = z
  .object({
    /** Id `auth."user"` của nhân viên (spec §9.7, SEC-I9): không bao giờ email. */
    staffUserId: z.uuid(),
    expiresInSec,
    // Cùng luật với `org_support_grants_reason_ck` (`btrim`, 1–500).
    reason: z.string().trim().min(1).max(SUPPORT_GRANT_REASON_MAX_LENGTH),
  })
  .strict();
export const SupportGrantResponse = z.object({
  id: z.uuid(),
  granteeUserId: z.uuid().nullable(),
  permissions: z.array(z.string()),
  reason: z.string(),
  expiresAt: iso,
  revokedAt: iso.nullable(),
  firstUsedAt: iso.nullable(),
  createdAt: iso,
});
export const supportGrantOf = (g: SupportGrantRow): z.infer<typeof SupportGrantResponse> => ({
  id: g.publicId,
  granteeUserId: g.granteeUserPublicId,
  permissions: g.permissions,
  reason: g.reason,
  expiresAt: g.expiresAt.toISOString(),
  revokedAt: g.revokedAt?.toISOString() ?? null,
  firstUsedAt: g.firstUsedAt?.toISOString() ?? null,
  createdAt: g.createdAt.toISOString(),
});
```
`src/modules/tenancy/application/delegation-revocations.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import type { SupportGrantRevokeReason } from '../domain/support-grant.js';
import { SupportAccessRevokedEvent } from '../events.js';
import { SupportGrantRepository, type SupportGrantRow } from '../ports/support-grant-repository.js';

/**
 * Mọi đường thu hồi ủy quyền NGẦM (spec SP3 §9.7 state machine, §14.1): cấp lại (T-20), người nhận thành member (SEC-M5),
 * role nền tảng của người nhận được ghi (N5-1); Task 24 thêm key của member bị gỡ và xoá mềm org. Gọi trong transaction đã
 * khoá org; mỗi dòng thu hồi một event (actor do caller truyền).
 */
@Injectable()
export class DelegationRevocations {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly grants: SupportGrantRepository,
    private readonly events: EventPublisher,
  ) {}

  async revokeGrantsOfGrantee(granteeUserId: string, reason: SupportGrantRevokeReason, actor: EventActor): Promise<number> {
    if (!this.uow.inTransaction()) throw new Error('DelegationRevocations must run inside UnitOfWork.run');
    const revoked = await this.grants.revokeOpenForGrantee(granteeUserId);
    for (const g of revoked) await this.publishGrantRevoked(g, reason, actor);
    return revoked.length;
  }

  async publishGrantRevoked(g: SupportGrantRow, reason: SupportGrantRevokeReason, actor: EventActor): Promise<void> {
    await this.events.publish(SupportAccessRevokedEvent, {
      data: {
        grantId: g.publicId,
        granteeUserId: g.granteeUserPublicId,
        grantedByMemberId: g.grantedByMemberPublicId,
        permissions: g.permissions,
        expiresAt: g.expiresAt.toISOString(),
        reason,
      },
      aggregate: { type: 'support_grant', id: g.publicId, version: g.version },
      actor,
    });
  }
}
```
`tenancy.module.ts` — `TenancyCoreModule` `providers`/`exports` thêm `DelegationRevocations`.

`src/modules/tenancy/application/support-grant.service.ts`:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { IdentityDirectory, hasAdminRole, isBanned } from '../../identity/index.js';
import { supportPreset } from '../domain/delegation.js';
import { TenancyErrors } from '../errors.js';
import { SupportAccessGrantedEvent } from '../events.js';
import { MemberRepository } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { SupportGrantRepository, type SupportGrantRow } from '../ports/support-grant-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { DelegationRevocations } from './delegation-revocations.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';
import { TenancyFeatures } from './tenancy-features.js';

const GRANT = 'support_access.grant';
const ineligible = () => new AppError(TenancyErrors.SUPPORT_GRANTEE_INELIGIBLE);
const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/**
 * Support grant (spec SP3 §9.7, S3-Q6, PR19, PR21). Điều kiện người nhận đọc trên pool auth NGOÀI transaction của pool app
 * (§3 Truy cập SQL); dưới khoá org chỉ còn "không phải member" (trigger hoãn definer là lớp chặn cuối, T-19) — upsert
 * `tenancy_users` chỉ sau khi mọi điều kiện đạt (SEC-I9, S-13). Một grant mở mỗi người nhận: cấp lại thu hồi grant cũ (T-20,
 * partial UNIQUE là lớp cuối). Đua với ghi role nền tảng (T-40): grant chèn sau lượt thu hồi vô dụng khi người nhận không còn là
 * nhân viên (middleware đòi `isPlatformAdmin()` mỗi request) và bị thu hồi ở lần ghi role kế tiếp.
 */
@Injectable()
export class SupportGrantService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly users: TenancyUserRepository,
    private readonly members: MemberRepository,
    private readonly grants: SupportGrantRepository,
    private readonly revocations: DelegationRevocations,
    private readonly reauth: ActorReauthorizer,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly features: TenancyFeatures,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  async grant(i: { staffUserId: string; expiresInSec: number; reason: string }): Promise<SupportGrantRow> {
    this.features.require('supportGrants');
    if (i.expiresInSec > this.cfg.supportGrantMaxTtlSec) throw new AppError(TenancyErrors.TTL_OUT_OF_RANGE);
    if (!this.directory) throw new Error('support grants are enabled without IdentityDirectory');
    const staff = await this.directory.findUser(i.staffUserId);
    if (!staff || !hasAdminRole(staff.role) || !staff.twoFactorEnabled || isBanned(staff, new Date())) throw ineligible();
    const preset = supportPreset(this.registry.merged());
    if (preset.length === 0) throw new Error('the merged catalogue has no support-eligible read permission');
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor } = await this.reauth.require([GRANT]);
      const grantee = await this.users.upsertAndLock({ kind: 'AUTH_USER', authUserId: staff.id });
      if (await this.members.findByUserId(grantee.id)) throw ineligible(); // rollback cả upsert (S-13)
      const by = userActor(this.ctx);
      await this.revocations.revokeGrantsOfGrantee(grantee.id, 'REVOKED', by);
      const g = await this.grants.insert({
        granteeUserId: grantee.id,
        grantedByMemberId: actor.id,
        reason: i.reason,
        expiresInSec: i.expiresInSec,
        permissions: preset,
      });
      await this.events.publish(SupportAccessGrantedEvent, {
        data: {
          grantId: g.publicId,
          granteeUserId: g.granteeUserPublicId,
          grantedByMemberId: g.grantedByMemberPublicId,
          permissions: g.permissions,
          expiresAt: g.expiresAt.toISOString(),
        },
        aggregate: { type: 'support_grant', id: g.publicId, version: g.version },
        actor: by,
      });
      return g;
    });
  }

  async list(q: { page: number; pageSize: number; cap: number }): Promise<{ rows: SupportGrantRow[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.grants.list({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      this.grants.countUpTo(q.cap),
    ]);
    return { rows, total };
  }

  /** Thu hồi chạy được cả khi tính năng tắt (đóng cửa luôn phải làm được). Đã thu hồi → no-op. */
  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      await this.reauth.require([GRANT]);
      const g = await this.grants.lockByPublicId(publicId);
      if (!g) throw notFound();
      const done = await this.grants.revoke(g.id);
      if (done) await this.revocations.publishGrantRevoked(done, 'REVOKED', userActor(this.ctx));
    });
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw notFound();
  }
}
```
(Ở `external`, cờ luôn tắt (Task 16) nên `features.require` ném trước khi đọc directory; `staffUserId` là id `auth."user"` nên subject là `AUTH_USER`.)

- [ ] **Step 3: Controller, `NARROWING_ROUTES`, module**

`src/modules/tenancy/http/support-grants.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Idempotent,
  Paginator,
  paginationConfig,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { SupportGrantService } from '../application/support-grant.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { NarrowingTenancyAction, SensitiveTenancyAction } from './decorators.js';
import {
  CreateSupportGrantBody,
  ListAcquisitionPage,
  SupportGrantResponse,
  publicIdOrNotFound,
  supportGrantOf,
} from './schemas.js';

@Controller('v1/orgs/:orgId/support-grants')
export class SupportGrantsController {
  constructor(
    private readonly grants: SupportGrantService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY) private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @TenancyPermissions.require('support_access.read')
  @ApiOk(SupportGrantResponse)
  async list(@Query({ schema: ListAcquisitionPage }) page: z.infer<typeof ListAcquisitionPage>) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=createdAt (ascending) is supported.' });
    const { rows, total } = await this.grants.list({ page: page.page, pageSize: page.pageSize, cap: this.pagination.totalCountCap });
    return this.pages.offset(rows.map((g) => serialize(SupportGrantResponse, supportGrantOf(g))), page, total);
  }

  /** `@Idempotent()`: response không chứa secret (spec §9.7). */
  @Post()
  @Idempotent()
  @TenancyPermissions.require('support_access.grant')
  @SensitiveTenancyAction()
  @ApiOk(SupportGrantResponse)
  @ApiProblems(TenancyErrors.FEATURE_DISABLED, TenancyErrors.SUPPORT_GRANTEE_INELIGIBLE, TenancyErrors.TTL_OUT_OF_RANGE, CoreErrors.VALIDATION_FAILED)
  async create(@Body({ schema: CreateSupportGrantBody }) body: z.infer<typeof CreateSupportGrantBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const g = await this.grants.grant({ ...body, staffUserId: body.staffUserId.toLowerCase() });
    const orgId = this.ctx.orgId();
    if (orgId === undefined) throw new Error('SupportGrantsController.create ran without an org context');
    setLocation(res, `/v1/orgs/${orgId}/support-grants/${g.publicId}`);
    return serialize(SupportGrantResponse, supportGrantOf(g));
  }

  @Delete(':grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('support_access.grant')
  @NarrowingTenancyAction()
  async revoke(@Param('grantId') grantId: string): Promise<void> {
    await this.grants.revoke(publicIdOrNotFound(grantId));
  }
}
```

`policy-metadata.ts` — `NARROWING_ROUTES` thêm `'DELETE v1/orgs/:orgId/support-grants/:grantId'`. `tenancy-http.module.ts` — `controllers` thêm `SupportGrantsController`, `providers` thêm `SupportGrantService`.

`role-route-matrix.e2e.spec.ts` — `ROUTES_3D` thêm `'GET v1/orgs/:orgId/support-grants'`, `'POST v1/orgs/:orgId/support-grants'`, `'DELETE v1/orgs/:orgId/support-grants/:grantId'`; `Cast` thêm `grant: string` (seed bằng `seedSupportGrant(org, { grantee: { externalSubject: \`matrix:${v7()}\` }, grantedByMemberId: org.owner.memberId, permissions: supportPresetKeys(merged) })`), `call` thêm `.replace(':grantId', c.grant)` và body cho `POST v1/orgs/:orgId/support-grants` = `{ staffUserId: c.staff.authUserId, expiresInSec: 900, reason: 'matrix' }` (`c.staff = await seedStaffPrincipal()` trong `cast`); `NARROWING` thêm `'DELETE v1/orgs/:orgId/support-grants/:grantId': { as: (c) => c.as.OWNER, status: 204 }`.

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project e2e test/e2e/tenancy/support-grants.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/tenancy-http-boot.e2e.spec.ts
pnpm vitest run --project e2e test/e2e/tenancy/org-api-key-auth.e2e.spec.ts
```
Expected: PASS, gồm đủ ca B-17 của Task 20 (route support-grants nay tồn tại, org key → `403 forbidden` vì `support_access.grant` là ownerOnly, không eligible).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy/support-grants.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts
pnpm lint && pnpm arch
git add src/modules/tenancy test/e2e/tenancy/support-grants.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts
git commit -m "feat(tenancy): support grants — owner grants the read-only preset to a staff member with 2FA, lists and revokes"
```

---

### Task 22: Nhánh support grant của `OrgContextMiddleware` — step-up đòi trên session, lần dùng đầu (S-4, S-5, S-6, S-7, S-9, S-10, S-11, S-12, S-16, S-17; T-15, T-35)

**Files:**
- Create: `test/e2e/tenancy/support-access.e2e.spec.ts`
- Modify: `src/modules/tenancy/http/org-context.middleware.ts`, `src/modules/tenancy/application/tenancy-metrics.ts` (không đổi tên; dùng `supportAccess` của Task 16)

**Interfaces:**
- Consumes: `AuthFacts.isPlatformAdmin()`, `AuthFacts.secondFactorVerifiedAt()` (Task 6), `IdentityErrors.SECOND_FACTOR_REQUIRED`, `SupportGrantRepository.findOpenForAccess/markFirstUse`, `DelegatedPermissions.forSupportGrant`, `TenancyFeatures.states.supportGrants`, `OrgRepository.clockNow`, `SupportAccessUsedEvent`, `EventPublisher`, `enrolStaff`, `stepUp`, `seedStaffPrincipal`, `seedStaffFactor`, `seedStepUpMark` (Task 6–7).
- Produces: `orgAccess { via: 'SUPPORT_GRANT', ref: grantPublicId, permissions, orgDeleted: false }`; metric `tenancy_support_access_requests_total{result}`; span attribute `tenancy.access.via = SUPPORT_GRANT`.

- [ ] **Step 1: E2E (fail)**

`test/e2e/tenancy/support-access.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { seedStaffFactor, seedStepUpMark } from '../../support/seed-staff-step-up.js';
import { enrolStaff, stepUp, type EnrolledStaff } from '../../support/staff.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, seedSupportGrant, supportPresetKeys, type SeededOrg } from '../../support/tenancy-seed.js';

const STEP_UP_MAX_AGE = 600;
type Pool = { query: (...a: unknown[]) => Promise<unknown> };

describe('support access through a grant (spec SP3 §7.1 bước 3.7, 3.10; §9.7; §18.3 S-4–S-12, S-16, S-17)', () => {
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const as = (p: SeededPrincipal) => authed(app, p);
  /** Org + grant do owner cấp cho `staff` (auth user id). */
  const granted = async (staffAuthUserId: string, o: { revoked?: boolean; expiresInSec?: number } = {}) => {
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const g = await seedSupportGrant(org, {
      grantee: { authUserId: staffAuthUserId },
      grantedByMemberId: org.owner.memberId,
      permissions: preset,
      ...o,
    });
    return { O, org, g };
  };
  const staffP = async (o?: Parameters<typeof seedStaffPrincipal>[0]) => {
    const p = await seedStaffPrincipal(o);
    principals.push(p);
    return p;
  };
  /** Đếm câu chạm `auth.session_second_factor` trên pool auth (S-16, S-17). */
  const countMarkQueries = async (fn: () => Promise<unknown>) => {
    const pool = app.get<Pool>(AUTH_POOL);
    const spy = vi.spyOn(pool, 'query');
    try {
      await fn();
      return spy.mock.calls.filter((c) => String(c[0]).includes('session_second_factor')).length;
    } finally {
      spy.mockRestore();
    }
  };

  beforeAll(async () => {
    app = await startTenancyApp({ env: { TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC: String(STEP_UP_MAX_AGE) } });
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('S-5: a stepped-up staff reads routes of the preset → 200 via SUPPORT_GRANT; S-4: role, member-write, key and grant routes → 403', async () => {
    const s = await staffP();
    const { org } = await granted(s.authUserId);
    const base = `/v1/orgs/${org.orgId}`;
    for (const url of [base, `${base}/members`, `${base}/roles`, `${base}/invitations`])
      expect((await as(s).get(url)).status, url).toBe(200);
    expect((await as(s).get(`${base}/support-grants`)).status).toBe(403);
    expect((await as(s).get(`${base}/api-keys`)).status).toBe(403);
    expect((await as(s).get(`${base}/api-keys/mine`)).status).toBe(403); // @OrgMemberOnly
    expect((await as(s).post(`${base}/roles`).set('idempotency-key', `k-${v7()}`).send({ name: 'x', permissions: ['org.read'] })).status).toBe(403);
    expect((await as(s).post(`${base}/api-keys`).send({ name: 'x', permissions: ['org.read'], expiresInSec: 60 })).status).toBe(403);
    expect((await as(s).delete(`${base}/members/me`)).status).toBe(403);
  });
  it('S-6: after expiry or revocation → 404 at the next request; S-9: another org → 404; S-7: the granting owner demoted → 404', async () => {
    const s = await staffP();
    const expired = await granted(s.authUserId, { expiresInSec: -1 });
    expect((await as(s).get(`/v1/orgs/${expired.org.orgId}`)).status).toBe(404);
    const live = await granted(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${live.org.orgId}`)).status).toBe(200);
    await ownerQuery(`UPDATE org_support_grants SET revoked_at = clock_timestamp() WHERE public_id = $1`, [live.g.publicId]);
    expect((await as(s).get(`/v1/orgs/${live.org.orgId}`)).status).toBe(404);
    const other = await granted((await staffP()).authUserId);
    expect((await as(s).get(`/v1/orgs/${other.org.orgId}`)).status).toBe(404);
    const s7 = await granted(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${s7.org.orgId}`)).status).toBe(200);
    const O2 = await seedUserPrincipal();
    principals.push(O2);
    await seedMember(s7.org, 'OWNER', { authUserId: O2.authUserId });
    await ownerQuery(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [s7.org.roles.ADMIN.id, s7.org.owner.memberId]);
    expect((await as(s).get(`/v1/orgs/${s7.org.orgId}`)).status).toBe(404);
  });
  it('S-12: a grant without a valid mark → 403 second_factor_required (never 404) on every branch; the same session after step-up → 200', async () => {
    const s = await enrolStaff(app);
    const { org } = await granted(s.userId);
    const url = `/v1/orgs/${org.orgId}/members`;
    // Đăng nhập mật khẩu + TOTP không ghi dấu.
    const signedIn = await s.client.request('get', url);
    expect([signedIn.status, signedIn.body.code]).toEqual([403, 'second_factor_required']);
    expect((await stepUp(s)).status).toBe(200);
    expect((await s.client.request('get', url)).status).toBe(200);
    // Dấu cũ hơn TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC.
    await ownerQuery(`UPDATE auth.session_second_factor SET verified_at = now() - make_interval(secs => $2) WHERE session_id IN (SELECT id FROM auth.session WHERE user_id = $1)`, [s.userId, STEP_UP_MAX_AGE + 1]);
    expect((await s.client.request('get', url)).body.code).toBe('second_factor_required');
    // Dấu của session KHÁC của cùng nhân viên.
    const other = await staffP({ mark: false });
    const f = await seedStaffFactor(other.authUserId);
    const second = await granted(other.authUserId);
    const [otherSession] = await ownerQuery<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, created_at, updated_at) VALUES ($1, $2, now() + interval '1 day', now(), now()) RETURNING id`,
      [`t-${v7()}`, other.authUserId],
    );
    await seedStepUpMark({ sessionId: otherSession!.id, factorId: f });
    expect((await as(other).get(`/v1/orgs/${second.org.orgId}`)).body.code).toBe('second_factor_required');
    // Dấu bằng backup code mở được grant (N5-3).
    const backup = await enrolStaff(app);
    const third = await granted(backup.userId);
    expect((await stepUp(backup, { backupCode: backup.backupCodes[0] })).status).toBe(200);
    expect((await backup.client.request('get', `/v1/orgs/${third.org.orgId}`)).status).toBe(200);
  });
  it('S-10/T-35: removing the factor drops the mark (CASCADE); a new factor without a step-up → still 403; step-up with it → 200', async () => {
    const s = await staffP();
    const { org } = await granted(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
    await ownerQuery(`DELETE FROM auth.two_factor WHERE user_id = $1`, [s.authUserId]);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).body.code).toBe('second_factor_required');
    const f = await seedStaffFactor(s.authUserId);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).body.code).toBe('second_factor_required');
    await seedStepUpMark({ sessionId: s.sessionId, factorId: f });
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
  });
  it('S-11/T-15: two parallel first requests → first_used_at once, exactly one support_access.used', async () => {
    const s = await staffP();
    const { org, g } = await granted(s.authUserId);
    const rs = await Promise.all([as(s).get(`/v1/orgs/${org.orgId}`), as(s).get(`/v1/orgs/${org.orgId}/members`)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const evs = await ownerQuery(`SELECT 1 FROM outbox_events WHERE type = 'tenancy.support_access.used' AND aggregate_id = $1`, [g.publicId]);
    expect(evs).toHaveLength(1);
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
    expect(await ownerQuery(`SELECT 1 FROM outbox_events WHERE type = 'tenancy.support_access.used' AND aggregate_id = $1`, [g.publicId])).toHaveLength(1);
  });
  it('S-16: a non-staff session, a member, and staff without a grant never query the mark table; S-17: a served grant queries it exactly once', async () => {
    const plain = await seedUserPrincipal();
    principals.push(plain);
    const s = await staffP();
    const { O, org } = await granted(s.authUserId);
    const noGrant = await staffP();
    expect(await countMarkQueries(() => as(plain).get(`/v1/orgs/${org.orgId}`))).toBe(0);
    expect(await countMarkQueries(() => as(O).get(`/v1/orgs/${org.orgId}`))).toBe(0);
    expect(await countMarkQueries(() => as(noGrant).get(`/v1/orgs/${org.orgId}`))).toBe(0);
    expect(await countMarkQueries(() => as(s).get(`/v1/orgs/${org.orgId}`))).toBe(1);
  });
  it('S-17: the staff session revoked between authentication and the support branch → 403, never 500', async () => {
    const s = await staffP();
    const { org } = await granted(s.authUserId);
    const pool = app.get<Pool>(AUTH_POOL);
    const real = pool.query.bind(pool);
    const spy = vi.spyOn(pool, 'query').mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes('session_second_factor'))
        await ownerQuery(`DELETE FROM auth.session WHERE id = $1`, [s.sessionId]);
      return real(...args);
    });
    try {
      const r = await as(s).get(`/v1/orgs/${org.orgId}`);
      expect([r.status, r.body.code]).toEqual([403, 'second_factor_required']);
    } finally {
      spy.mockRestore();
    }
  });
  it('Review Focus 3 (pre-check): a staff member who is a member is served as a member, with no step-up asked', async () => {
    const s = await staffP({ mark: false });
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    await seedMember(org, 'MEMBER', { authUserId: s.authUserId });
    expect((await as(s).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
  });
  it('support grants off → a staff member with a grant gets the plain 404', async () => {
    const off = await startTenancyApp({ env: { TENANCY_SUPPORT_GRANTS: 'off' } });
    try {
      const s = await staffP();
      const { org } = await granted(s.authUserId);
      expect((await request(off.getHttpServer()).get(`/v1/orgs/${org.orgId}`).set('authorization', `Bearer ${s.bearer}`)).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});
```
(`AUTH_POOL` là token pool `auth_user` có sẵn của SP2, cùng import với `test/chaos/identity-outages.spec.ts`. Ca "ghi dấu lỗi (bảng bị khoá)" và "IdP, thiết bị tin cậy, bearer" của S-12 nằm ở `step-up.e2e.spec.ts` của Task 6 cho phần ghi dấu; phần grant của chúng thêm vào Task 6 Step 4 bằng cùng helper `granted` là trùng lặp, nên ở đây phủ nhánh đọc dấu, còn nhánh tạo dấu đã chứng minh "không có dấu" ở Task 6.)

Run: `pnpm vitest run --project e2e test/e2e/tenancy/support-access.e2e.spec.ts`
Expected: FAIL (staff không phải member → `404`).

- [ ] **Step 2: Nhánh support**

`src/modules/tenancy/http/org-context.middleware.ts` — constructor thêm `private readonly facts: AuthFacts, private readonly features: TenancyFeatures, private readonly grants: SupportGrantRepository, private readonly orgs: OrgRepository, private readonly events: EventPublisher` và `@Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>` (`TenancyFeatures` là provider của `TenancyHttpModule`, cùng module với middleware). Nhánh membership của `resolve` đổi phần "không phải member":
```ts
    const read = await this.readInOrg('MEMBERSHIP', orgId, async () => {
      const membership = await this.reader.lookup(this.subjects.of(principal));
      const member = membership.org === 'PRESENT' ? membership.member : null;
      const permissions = member ? await this.rolePermissions.of({ id: member.roleId, systemKey: member.systemKey }) : [];
      // Bước 3.7: chỉ non-member là platform admin, org còn hoạt động, tính năng bật mới chạm bảng grant (S-16).
      const grant =
        !member && membership.org === 'PRESENT' && membership.deletedAt === null && this.supportCandidate()
          ? await this.grants.findOpenForAccess(principal.id)
          : undefined;
      return { membership, permissions, grant, now: grant ? await this.orgs.clockNow() : undefined };
    });
    const member = this.admitted(req, read.membership);
    if (member) { /* như cũ: setOrgAccess MEMBERSHIP, count('MEMBERSHIP', 'granted') */ }
    if (read.grant && read.now) return this.resolveSupport(principal, orgId, read.grant, read.now, limiterKey);
    if (read.grant === undefined && this.supportCandidate()) this.metrics.supportAccess.add(1, { result: 'no_grant' });
    return this.miss('MEMBERSHIP', limiterKey);
```
và thêm:
```ts
  private supportCandidate(): boolean {
    return this.facts.isPlatformAdmin() && this.features.states.supportGrants.enabled;
  }

  /**
   * Spec §9.7 "Dùng": người cấp phải còn là OWNER (S3-P3) — không thì trượt như non-member; có grant hợp lệ mới đọc dấu step-up
   * (pool auth, NGOÀI transaction của pool app, đúng một câu, S-17). Không dấu/dấu cũ → `403 second_factor_required` (S3-A63),
   * không consume limiter. Lần dùng đầu: transaction ghi riêng + event (T-15); lỗi hạ tầng → 503 (không dùng grant thiếu audit).
   */
  private async resolveSupport(principal: Principal, orgId: string, grant: OpenGrantAccess, now: Date, limiterKey: string): Promise<Outcome> {
    if (grant.granterSystemKey !== 'OWNER') {
      this.metrics.supportAccess.add(1, { result: 'granter_not_owner' });
      return this.miss('SUPPORT_GRANT', limiterKey);
    }
    const verifiedAt = await this.secondFactor();
    if (verifiedAt === undefined || now.getTime() - verifiedAt.getTime() > this.cfg.supportStepUpMaxAgeSec * MS_PER_SEC) {
      this.metrics.supportAccess.add(1, { result: verifiedAt === undefined ? 'no_second_factor' : 'second_factor_stale' });
      this.count('SUPPORT_GRANT', 'second_factor_required');
      throw new AppError(IdentityErrors.SECOND_FACTOR_REQUIRED, { expected: true });
    }
    if (grant.firstUsedAt === null)
      await this.readInOrg('SUPPORT_GRANT', orgId, async () => {
        const used = await this.grants.markFirstUse(grant.grantId);
        if (!used) return; // T-15: request song song đã ghi
        await this.events.publish(SupportAccessUsedEvent, {
          data: {
            grantId: used.publicId,
            granteeUserId: used.granteeUserPublicId,
            grantedByMemberId: used.grantedByMemberPublicId,
            permissions: used.permissions,
            expiresAt: used.expiresAt.toISOString(),
          },
          aggregate: { type: 'support_grant', id: used.publicId, version: used.version },
          actor: { type: 'user', id: principal.id },
        });
      });
    this.ctx.setOrgId(orgId);
    this.ctx.setOrgAccess({
      via: 'SUPPORT_GRANT',
      ref: grant.grantPublicId,
      permissions: this.delegated.forSupportGrant(grant.scope),
      orgDeleted: false,
    });
    this.metrics.supportAccess.add(1, { result: 'granted' });
    this.count('SUPPORT_GRANT', 'granted');
    return { via: 'SUPPORT_GRANT', result: 'granted' };
  }

  /** `AuthFacts.secondFactorVerifiedAt()` đọc pool auth; lỗi hạ tầng → 503 như mọi lỗi DB của middleware (tiêu chí 12). */
  private async secondFactor(): Promise<Date | undefined> {
    try {
      return await this.facts.secondFactorVerifiedAt();
    } catch (err) {
      if (!isDbInfraError(err)) throw err;
      this.count('SUPPORT_GRANT', 'unavailable');
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        headers: { 'Retry-After': String(this.guard.unavailableRetryAfterSec) },
        expected: true,
      });
    }
  }
```
(`readInOrg` mở `UnitOfWork.run` mới nên lần ghi đầu là transaction riêng sau transaction đọc, đúng bước 3.10; trong transaction ghi không có I/O ngoài. `now` là giờ DB lấy trong transaction đọc — không so với đồng hồ của app.)

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project e2e test/e2e/tenancy/support-access.e2e.spec.ts test/e2e/tenancy/org-context.e2e.spec.ts test/e2e/tenancy/org-miss-limiter.e2e.spec.ts test/e2e/identity/step-up.e2e.spec.ts
```
Expected: PASS. `org-miss-limiter` vẫn xanh (non-admin trượt không chạm bảng grant).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy/support-access.e2e.spec.ts
pnpm lint && pnpm arch
git add src/modules/tenancy test/e2e/tenancy/support-access.e2e.spec.ts
git commit -m "feat(tenancy): serve staff through a support grant only after a fresh in-session step-up; record the first use once"
```

---

### Task 23: Template `support-access-notice`, subscriber `tenancy.notify-owners`, `PlatformRoleChangeListener` của tenancy (S-23, T-40)

**Files:**
- Create: migration `src/migrations/notifications/Migration<ts>_support_templates.ts` (`pnpm exec mikro-orm migration:create --blank --path src/migrations/notifications --name support_templates`), `src/modules/notifications/templates/support-access-notice/en/{subject.hbs,body.mjml,text.hbs}`, `src/modules/tenancy/application/notify-owners.subscriber.ts`, `src/modules/tenancy/infra/identity/platform-role-change.listener.ts`, `test/integration/notifications/support-templates-down.spec.ts`, `test/e2e/tenancy/support-role-change.e2e.spec.ts`
- Modify: `src/modules/notifications/templates.ts`, `src/modules/tenancy/ports/member-repository.ts`, `src/modules/tenancy/infra/sql/sql-member.repository.ts`, `src/modules/tenancy/infra/identity/tenancy-identity-ports.module.ts`, `src/modules/tenancy/tenancy.module.ts`, `test/unit/modules/notifications/templates.spec.ts`

**Interfaces:**
- Consumes: `EventSubscriber`, `EventHandler`, `EventEnvelope` (core events), `EmailNotifications`, `DISPLAY_NAME_MAX` (notifications `index.ts`), `oneLine` (`domain/display-text.ts`), `IdentityDirectory.findUsers`, `identityConfig.directoryBatchMax`, `PlatformRoleChangeListener` (Task 7), `DelegationRevocations.revokeGrantsOfGrantee` (Task 21), `SupportGrantRepository.granteeOpenGrantOrgs` (Task 18), `TenancyUserRepository.find`, `OrgRepository.lockCurrent/readCurrent`, ba event support (Task 16).
- Produces:
  - Template key `support-access-notice`, params `{ name: string; orgName: string; kind: 'granted' | 'used' | 'revoked'; expiresAt: string }` (`.strict()`).
  - `MemberRepository.owners(): Promise<MemberRow[]>` (mọi member giữ role `OWNER` của org hiện tại, theo `id`).
  - Ba subscriber `tenancy.notify-owners.granted|used|revoked` (một consumer mỗi event: decorator nhận đúng một `type@version`) dùng chung `OwnerNotifier.notify(e, kind)`.
  - `TenancyPlatformRoleChangeListener extends PlatformRoleChangeListener` (provider của `TenancyIdentityPortsModule`).

- [ ] **Step 1: Test (fail)**

`test/unit/modules/notifications/templates.spec.ts` — thêm:
```ts
  it('support-access-notice: kind is one of granted|used|revoked; params are strict and single-line', () => {
    const s = TEMPLATE_PARAMS['support-access-notice'];
    const ok = { name: 'Owner', orgName: 'Acme', kind: 'used', expiresAt: '2026-10-02T00:00:00.000Z' };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, kind: 'expired' }).success).toBe(false);
    expect(s.safeParse({ ...ok, orgName: 'A\nB' }).success).toBe(false);
    expect(s.safeParse({ ...ok, reason: 'SUP-1' }).success).toBe(false); // reason của grant không vào thư
  });
```
`test/integration/notifications/support-templates-down.spec.ts` — chép `acquisition-templates-down.spec.ts`, thay hậu tố `_acquisition_templates` → `_support_templates`, tên DB `suptpl`, key `'org-invitation'` → `'support-access-notice'`, danh sách hai key → một key `[{ key: 'support-access-notice' }]`, câu đếm `key IN (…)` → `key = 'support-access-notice'`, và tiêu đề `describe('down of …_support_templates', …)`.

`test/e2e/tenancy/support-role-change.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyPlatformRoleChangeListener } from '../../../src/modules/tenancy/infra/identity/platform-role-change.listener.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { seedStaffStepUp } from '../../support/seed-staff-step-up.js';
import { enrolStaff, stepUp } from '../../support/staff.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, seedSupportGrant, supportPresetKeys, type SeededOrg } from '../../support/tenancy-seed.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';

const RACE_ROUNDS = 50;

describe('platform role writes revoke support grants; owners are told (spec SP3 §9.7 (6), "Thông báo owner"; §18.3 S-23; T-40)', () => {
  const mail = mailpitFromInfra();
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const ownerWithOrg = async () => {
    const O = await seedUserPrincipal();
    principals.push(O);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    return { O, org };
  };
  const openGrantsOf = (authUserId: string) =>
    ownerQuery(
      `SELECT g.public_id FROM org_support_grants g JOIN tenancy_users u ON u.id = g.grantee_user_id
       WHERE u.auth_user_id = $1 AND g.revoked_at IS NULL`,
      [authUserId],
    );

  beforeAll(async () => {
    app = await startTenancyApp();
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('S-23: /admin/set-role user on a staff with grants in two orgs → both revoked, two events GRANTEE_ROLE_CHANGED (system actor), owners mailed; promoting again does not revive them', async () => {
    const admin = await enrolStaff(app);
    expect((await stepUp(admin)).status).toBe(200);
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    for (const o of [a, b])
      await seedSupportGrant(o.org, { grantee: { authUserId: staff.authUserId }, grantedByMemberId: o.org.owner.memberId, permissions: preset });
    const since = new Date();
    const r = await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: staff.authUserId, role: 'user' } });
    expect(r.status).toBe(200);
    expect(await openGrantsOf(staff.authUserId)).toEqual([]);
    const evs = await ownerQuery<{ payload: { reason: string }; headers: Record<string, string> }>(
      `SELECT payload, headers FROM outbox_events WHERE type = 'tenancy.support_access.revoked' AND org_id = ANY($1::uuid[])`,
      [[a.org.orgId, b.org.orgId]],
    );
    expect(evs.map((e) => [e.payload.reason, e.headers['actorType'], e.headers['actorId']])).toEqual([
      ['GRANTEE_ROLE_CHANGED', 'system', 'identity.platform-role-change'],
      ['GRANTEE_ROLE_CHANGED', 'system', 'identity.platform-role-change'],
    ]);
    for (const o of [a, b]) {
      const mail = await mail.waitFor(o.O.email, { subject: 'Support access revoked', after: since });
      expect(mail.Text).not.toContain(staff.email);
    }
    expect((await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: staff.authUserId, role: 'admin' } })).status).toBe(200);
    await seedStaffStepUp({ authUserId: staff.authUserId });
    expect((await authed(app, staff).get(`/v1/orgs/${a.org.orgId}`)).status).toBe(404);
  });
  it('S-23: /admin/update-user with data.role revokes; without role keeps the grant; ["<id>"] array revokes; an uppercase id → 422 and nothing changes', async () => {
    const admin = await enrolStaff(app);
    expect((await stepUp(admin)).status).toBe(200);
    const grantTo = async () => {
      const staff = await seedStaffPrincipal();
      principals.push(staff);
      const o = await ownerWithOrg();
      await seedSupportGrant(o.org, { grantee: { authUserId: staff.authUserId }, grantedByMemberId: o.org.owner.memberId, permissions: preset });
      return staff;
    };
    const s1 = await grantTo();
    expect((await admin.client.request('post', '/api/auth/admin/update-user', { body: { userId: s1.authUserId, data: { name: 'Renamed' } } })).status).toBe(200);
    expect(await openGrantsOf(s1.authUserId)).toHaveLength(1);
    expect((await admin.client.request('post', '/api/auth/admin/update-user', { body: { userId: s1.authUserId, data: { role: 'user' } } })).status).toBe(200);
    expect(await openGrantsOf(s1.authUserId)).toEqual([]);
    const s2 = await grantTo();
    expect((await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: [s2.authUserId], role: 'user' } })).status).toBe(200);
    expect(await openGrantsOf(s2.authUserId)).toEqual([]);
    const s3 = await grantTo();
    const upper = await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: s3.authUserId.toUpperCase(), role: 'user' } });
    expect([upper.status, upper.body.code]).toEqual([422, 'validation_failed']);
    expect(await openGrantsOf(s3.authUserId)).toHaveLength(1);
  });
  it('S-23: the listener throws → 503 + ERROR platform_role_change_listener_failed; the role is written; the same request again revokes', async () => {
    const admin = await enrolStaff(app);
    expect((await stepUp(admin)).status).toBe(200);
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const o = await ownerWithOrg();
    await seedSupportGrant(o.org, { grantee: { authUserId: staff.authUserId }, grantedByMemberId: o.org.owner.memberId, permissions: preset });
    const listener = app.get(TenancyPlatformRoleChangeListener);
    const spy = vi.spyOn(listener, 'onPlatformRoleChanged').mockRejectedValueOnce(new Error('fixture: listener down'));
    const first = await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: staff.authUserId, role: 'user' } });
    expect(first.status).toBe(503);
    expect((await ownerQuery<{ role: string }>(`SELECT role FROM auth."user" WHERE id = $1`, [staff.authUserId]))[0]?.role).toBe('user');
    expect(await openGrantsOf(staff.authUserId)).toHaveLength(1);
    spy.mockRestore();
    expect((await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: staff.authUserId, role: 'user' } })).status).toBe(200);
    expect(await openGrantsOf(staff.authUserId)).toEqual([]);
  });
  it('T-40: granting ∥ /admin/set-role user ×50 → after promoting again, no grant of the staff is open', async () => {
    const admin = await enrolStaff(app);
    expect((await stepUp(admin)).status).toBe(200);
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const staff = await seedStaffPrincipal();
      principals.push(staff);
      const o = await ownerWithOrg();
      await raceOnOrgLock(o.org.orgId, 1, () =>
        Promise.all([
          authed(app, o.O)
            .post(`/v1/orgs/${o.org.orgId}/support-grants`)
            .set('idempotency-key', `k-${v7()}`)
            .send({ staffUserId: staff.authUserId, expiresInSec: 900, reason: 'T-40' }),
          admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: staff.authUserId, role: 'user' } }),
        ]),
      );
      expect((await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: staff.authUserId, role: 'admin' } })).status).toBe(200);
      expect(await openGrantsOf(staff.authUserId), `round ${i}`).toEqual([]);
    }
  });
  it('notify-owners: granted, used and revoked each mail every owner once (idempotency key per event and owner)', async () => {
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const o = await ownerWithOrg();
    const since = new Date();
    const g = await authed(app, o.O)
      .post(`/v1/orgs/${o.org.orgId}/support-grants`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ staffUserId: staff.authUserId, expiresInSec: 900, reason: 'SUP-77' });
    expect(g.status).toBe(201);
    expect((await authed(app, staff).get(`/v1/orgs/${o.org.orgId}`)).status).toBe(200);
    expect((await authed(app, o.O).delete(`/v1/orgs/${o.org.orgId}/support-grants/${g.body.id}`)).status).toBe(204);
    for (const subject of ['Support access granted', 'Support access used', 'Support access revoked']) {
      const m = await mail.waitFor(o.O.email, { subject, after: since });
      expect(m.Text).not.toContain('SUP-77');
    }
    const keys = await ownerQuery<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM email_deliveries WHERE template = 'support-access-notice' AND idempotency_key LIKE $1`,
      [`%:${o.org.owner.memberPublicId}`],
    );
    expect(keys).toHaveLength(3);
  });
});
```
(`mailpitFromInfra().waitFor(to, { subject, after })` là helper có sẵn của `test/support/mailpit.ts`, cùng cách `account-deletion.e2e.spec.ts` và `tokenFromMail` dùng.)

Run:
```bash
pnpm vitest run --project unit test/unit/modules/notifications/templates.spec.ts
pnpm vitest run --project e2e test/e2e/tenancy/support-role-change.e2e.spec.ts
```
Expected: FAIL (template key không tồn tại; grant không bị thu hồi khi ghi role).

- [ ] **Step 2: Template + migration**

`src/modules/notifications/templates.ts` — `TEMPLATE_KEYS` thêm `'support-access-notice'`; `TEMPLATE_PARAMS` thêm:
```ts
  /** Spec SP3 §9.7 "Thông báo owner": `kind` của event; không email/tên nhân viên, không `reason` của grant (không PII sang thư). */
  'support-access-notice': z
    .object({
      name: displayName,
      orgName: displayName,
      kind: z.enum(['granted', 'used', 'revoked']),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
```
`src/modules/notifications/templates/support-access-notice/en/subject.hbs`:
```hbs
Support access {{kind}} for {{orgName}}
```
`text.hbs`:
```hbs
Hi {{name}},

Platform support access to {{orgName}} was {{kind}}. The grant is read-only and ends at {{expiresAt}} (UTC) at the latest.

You can see and revoke support grants in the organization settings. If you did not expect this, revoke the grant and contact support.
```
`body.mjml`:
```mjml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hi {{name}},</mj-text>
        <mj-text>Platform support access to {{orgName}} was {{kind}}. The grant is read-only and ends at {{expiresAt}} (UTC) at the latest.</mj-text>
        <mj-text>You can see and revoke support grants in the organization settings. If you did not expect this, revoke the grant and contact support.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
(Không có helper so sánh trong renderer: `kind` là động từ quá khứ đọc thẳng được trong câu, nên một template phục vụ cả ba sự kiện.)

`src/migrations/notifications/Migration<ts>_support_templates.ts`:
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3D (spec SP3 §5.2 hàng notifications, §6.13 bảng 3D): template `support-access-notice` là DÒNG của bảng tra cứu
 * `email_templates` (3C ∥ 3D chỉ chèn dòng, INT2-N-3). Không bảng mới, không đổi chuẩn hoá. Khoá: `ROW EXCLUSIVE`.
 * Down: xoá dòng; FK RESTRICT từ `email_deliveries` làm down fail to (`23001`) khi còn thư dùng key — runbook như 3C.
 */
export class Migration<ts>_support_templates extends Migration {
  override name = 'Migration<ts>_support_templates';

  override up(): void | Promise<void> {
    this.addSql(`INSERT INTO email_templates (key) VALUES ('support-access-notice');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DELETE FROM email_templates WHERE key = 'support-access-notice';`);
  }
}
```

- [ ] **Step 3: Owners + subscriber**

`src/modules/tenancy/ports/member-repository.ts` — thêm `abstract owners(): Promise<MemberRow[]>;` (chú thích: "Mọi OWNER của org hiện tại theo `id` (thư `support-access-notice`); org có ít owner nên không phân trang."). `sql-member.repository.ts`:
```ts
  async owners(): Promise<MemberRow[]> {
    const rows = await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} AND r.system_key = 'OWNER' ORDER BY m.id`);
    return rows.map((r) => MemberRowSchema.parse(r));
  }
```
`src/modules/tenancy/application/notify-owners.subscriber.ts`:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventSubscriber, type EventEnvelope, type EventHandler } from '../../../core/events/index.js';
import { IdentityDirectory, identityConfig } from '../../identity/index.js';
import { DISPLAY_NAME_MAX, EmailNotifications } from '../../notifications/index.js';
import { oneLine } from '../domain/display-text.js';
import { SupportAccessGrantedEvent, SupportAccessRevokedEvent, SupportAccessUsedEvent } from '../events.js';
import { MemberRepository } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';

type Kind = 'granted' | 'used' | 'revoked';
type SupportData = z.infer<typeof SupportAccessGrantedEvent.schema>;

/**
 * Spec SP3 §9.7 "Thông báo owner": một thư cho MỖI owner, trong Inbox + UnitOfWork + OrgScope của event (worker). Ngoại lệ có
 * tên của luật "không I/O ngoài trong transaction": `IdentityDirectory.findUsers` chạy trên pool `auth_user` (pool khác, không
 * tự khoá; deadline `DB_AUTH_QUERY_TIMEOUT_MS`). Thư đi qua outbox của notifications cùng transaction; idempotency key
 * `support-access-notice:<eventId>:<ownerMemberPublicId>` nên chạy lại không gửi trùng.
 */
@Injectable()
export class OwnerNotifier {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly emails: EmailNotifications,
    @Inject(identityConfig.KEY) private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  async notify(e: EventEnvelope<SupportData>, kind: Kind): Promise<void> {
    if (!this.uow.inTransaction() || this.ctx.orgId() !== e.orgId)
      throw new Error('tenancy.notify-owners must run in the UnitOfWork and OrgScope of the event organization');
    // Support grant chỉ bật ở local/hybrid (Task 16); event tới đây ở external là lỗi lắp ráp.
    if (this.identity.mode === 'external' || !this.directory)
      throw new Error('tenancy.notify-owners needs IdentityDirectory (support grants are off in external mode)');
    const org = await this.orgs.readCurrent();
    if (!org) return; // org đã purge trước khi event tới: không còn ai để báo
    const owners = (await this.members.owners()).filter((m) => m.authUserId !== null);
    const batch = this.identity.directoryBatchMax;
    for (let i = 0; i < owners.length; i += batch) {
      const page = owners.slice(i, i + batch);
      const users = new Map((await this.directory.findUsers(page.map((m) => m.authUserId ?? ''))).map((u) => [u.id, u]));
      for (const m of page) {
        const u = m.authUserId ? users.get(m.authUserId) : undefined;
        if (!u) continue;
        await this.emails.request({
          template: 'support-access-notice',
          to: u.email,
          params: {
            name: oneLine(u.name, DISPLAY_NAME_MAX),
            orgName: oneLine(org.name, DISPLAY_NAME_MAX),
            kind,
            expiresAt: e.data.expiresAt,
          },
          idempotencyKey: `support-access-notice:${e.id}:${m.publicId}`,
        });
      }
    }
  }
}

@Injectable()
@EventSubscriber({ consumer: 'tenancy.notify-owners.granted', event: SupportAccessGrantedEvent })
export class NotifyOwnersOnGranted implements EventHandler<typeof SupportAccessGrantedEvent> {
  constructor(private readonly notifier: OwnerNotifier) {}
  handle = (e: EventEnvelope<z.infer<typeof SupportAccessGrantedEvent.schema>>): Promise<void> => this.notifier.notify(e, 'granted');
}
@Injectable()
@EventSubscriber({ consumer: 'tenancy.notify-owners.used', event: SupportAccessUsedEvent })
export class NotifyOwnersOnUsed implements EventHandler<typeof SupportAccessUsedEvent> {
  constructor(private readonly notifier: OwnerNotifier) {}
  handle = (e: EventEnvelope<z.infer<typeof SupportAccessUsedEvent.schema>>): Promise<void> => this.notifier.notify(e, 'used');
}
@Injectable()
@EventSubscriber({ consumer: 'tenancy.notify-owners.revoked', event: SupportAccessRevokedEvent })
export class NotifyOwnersOnRevoked implements EventHandler<typeof SupportAccessRevokedEvent> {
  constructor(private readonly notifier: OwnerNotifier) {}
  handle = (e: EventEnvelope<z.infer<typeof SupportAccessRevokedEvent.schema>>): Promise<void> => this.notifier.notify(e, 'revoked');
}
```
(`SupportAccessRevokedEvent` có thêm `reason`; kiểu `EventEnvelope<…revoked>` gán được cho `EventEnvelope<SupportData>` vì `SupportData` là tập con trường.) `tenancy.module.ts` — `forWorker().providers` thêm `OwnerNotifier, NotifyOwnersOnGranted, NotifyOwnersOnUsed, NotifyOwnersOnRevoked` (subscriber chạy ở worker, như `ProvisionOrgSubscriber` của entitlements).

- [ ] **Step 4: Listener của tenancy**

`src/modules/tenancy/infra/identity/platform-role-change.listener.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { OrgScope, UnitOfWork } from '../../../../core/database/index.js';
import { PlatformRoleChangeListener } from '../../../identity/index.js';
import { DelegationRevocations } from '../../application/delegation-revocations.js';
import { TenancyMetrics } from '../../application/tenancy-metrics.js';
import { OrgRepository } from '../../ports/org-repository.js';
import { SupportGrantRepository } from '../../ports/support-grant-repository.js';
import { TenancyUserRepository } from '../../ports/tenancy-user-repository.js';

const ROLE_CHANGE_ACTOR = { type: 'system', id: 'identity.platform-role-change' } as const;

/**
 * Spec SP3 §9.7 (6) (N5-1, T-40): mọi lần ghi role nền tảng của một user qua `/admin/*` thu hồi mọi grant chưa thu hồi của
 * user đó, mỗi org một transaction (khoá org → UPDATE … RETURNING → event), kể cả nâng quyền/ghi lại cùng role (không đọc
 * role cũ). Lỗi giữa chừng: org đã commit giữ kết quả, hook trả 503, gọi lại cùng request là idempotent.
 */
@Injectable()
export class TenancyPlatformRoleChangeListener extends PlatformRoleChangeListener {
  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly grants: SupportGrantRepository,
    private readonly revocations: DelegationRevocations,
    private readonly metrics: TenancyMetrics,
  ) {
    super();
  }

  async onPlatformRoleChanged(authUserId: string): Promise<void> {
    const user = await this.users.find({ kind: 'AUTH_USER', authUserId });
    if (!user) return;
    for (const orgId of await this.grants.granteeOpenGrantOrgs(user.id)) {
      const revoked = await this.scope.run(orgId, () =>
        this.uow.run(async () => {
          if (!(await this.orgs.lockCurrent())) return 0; // org vừa purge
          return this.revocations.revokeGrantsOfGrantee(user.id, 'GRANTEE_ROLE_CHANGED', ROLE_CHANGE_ACTOR);
        }),
      );
      if (revoked > 0) this.metrics.supportGrantsRevokedOnRoleChange.add(revoked);
    }
  }
}
```
`tenancy-identity-ports.module.ts` — `providers` thêm `TenancyPlatformRoleChangeListener, { provide: PlatformRoleChangeListener, useExisting: TenancyPlatformRoleChangeListener }`, `exports` thêm `PlatformRoleChangeListener`.

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project unit test/unit/modules/notifications test/unit/modules/tenancy
pnpm vitest run --project integration test/integration/notifications test/integration/core/database/migration-order.spec.ts
pnpm vitest run --project e2e test/e2e/tenancy/support-role-change.e2e.spec.ts test/e2e/identity/staff-gate.e2e.spec.ts
```
Expected: PASS. `email-deliveries-schema.spec.ts` (tập key của `email_templates` = `TEMPLATE_KEYS`) xanh với key mới; `migration-order` xanh (timestamp notifications > tenancy của Task 14).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/modules/notifications src/modules/tenancy src/migrations/notifications test/unit/modules/notifications test/integration/notifications/support-templates-down.spec.ts test/e2e/tenancy/support-role-change.e2e.spec.ts
pnpm lint && pnpm arch
git add src/modules/notifications src/modules/tenancy src/migrations/notifications test/unit/modules/notifications test/integration/notifications/support-templates-down.spec.ts test/e2e/tenancy/support-role-change.e2e.spec.ts
git commit -m "feat(tenancy): tell owners about support access and revoke grants whenever the grantee's platform role is written"
```

---

### Task 24: Vòng đời — người nhận thành member, member bị gỡ, xoá tài khoản, xoá mềm org (K-6, S-15, Review Focus 3, T-19 đường app, T-31, tiêu chí 8)

**Files:**
- Create: `test/e2e/tenancy/delegation-lifecycle.e2e.spec.ts`, `test/e2e/tenancy/delegation-races.e2e.spec.ts`
- Modify: `src/modules/tenancy/application/delegation-revocations.ts`, `src/modules/tenancy/application/member-admission.ts`, `src/modules/tenancy/application/member.service.ts`, `src/modules/tenancy/application/user-deletion.service.ts`, `src/modules/tenancy/application/org-lifecycle.service.ts`

**Interfaces:**
- Consumes: `OrgApiKeyRepository.unrevokedOfMember/revokeAll`, `SupportGrantRepository.revokeAll`, `ApiKeyRevokedEvent`, `DelegationRevocations.revokeGrantsOfGrantee` (Task 21), `joinInviteLink`, `seedInviteLink`, `raceOnOrgLock`.
- Produces: `DelegationRevocations.announceKeysOfRemovedMember(memberId: string, actor: EventActor): Promise<void>`; `DelegationRevocations.revokeAllOfOrg(): Promise<void>`.

- [ ] **Step 1: E2E (fail)**

`test/e2e/tenancy/delegation-lifecycle.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { ownerQuery } from '../../support/identity-app.js';
import { joinInviteLink } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import {
  seedInviteLink,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const HEADER = 'x-api-key';

describe('delegations through the membership and organization lifecycle (spec SP3 §9.4, §9.6, §9.7, §14.1; §18.3 K-6, S-15; tiêu chí 8)', () => {
  let app: INestApplication;
  let preset: string[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const keyGet = (token: string, url: string) => request(app.getHttpServer()).get(url).set(HEADER, token);
  const revokedEvents = (aggregateId: string) =>
    ownerQuery<{ payload: { reason: string } }>(
      `SELECT payload FROM outbox_events WHERE type IN ('tenancy.api_key.revoked', 'tenancy.support_access.revoked') AND aggregate_id = $1 ORDER BY id`,
      [aggregateId],
    );
  const cast = async () => {
    const O = await seedUserPrincipal();
    const A = await seedUserPrincipal();
    principals.push(O, A);
    const org = await seedOrg({ owner: { authUserId: O.authUserId } });
    orgs.push(org);
    const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
    const key = await seedOrgApiKey(org, { createdByMemberId: a.memberId, permissions: ['org.read'] });
    return { O, A, a, org, key };
  };

  beforeAll(async () => {
    app = await startTenancyApp();
    preset = supportPresetKeys(app.get(PermissionCatalogueRegistry).merged());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('K-6: removing the creator → 401, the key row is gone, event api_key.revoked CREATOR_REMOVED; leaving does the same', async () => {
    const c = await cast();
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}/members/${c.a.memberPublicId}`)).status).toBe(204);
    expect((await keyGet(c.key.token, `/v1/orgs/${c.org.orgId}`)).status).toBe(401);
    expect(await ownerQuery(`SELECT 1 FROM org_api_keys WHERE public_id = $1`, [c.key.publicId])).toEqual([]);
    expect((await revokedEvents(c.key.publicId)).map((e) => e.payload.reason)).toEqual(['CREATOR_REMOVED']);
    const d = await cast();
    expect((await authed(app, d.A).delete(`/v1/orgs/${d.org.orgId}/members/me`)).status).toBe(204);
    expect((await revokedEvents(d.key.publicId)).map((e) => e.payload.reason)).toEqual(['CREATOR_REMOVED']);
  });
  it('K-6 (account deletion): a stepped-up staff removes the creator account (/admin/remove-user) → event CREATOR_REMOVED', async () => {
    const c = await cast();
    const admin = await seedStaffPrincipal();
    principals.push(admin);
    const del = await authed(app, admin)
      .post('/api/auth/admin/remove-user')
      .set('origin', 'http://localhost:3000')
      .send({ userId: c.A.authUserId });
    expect(del.status).toBe(200);
    expect((await revokedEvents(c.key.publicId)).map((e) => e.payload.reason)).toEqual(['CREATOR_REMOVED']);
  });
  it('tiêu chí 8 / T-31: soft delete → keys 401 and grants 404 at once; both stay revoked after restore', async () => {
    const c = await cast();
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    const g = await seedSupportGrant(c.org, { grantee: { authUserId: staff.authUserId }, grantedByMemberId: c.org.owner.memberId, permissions: preset });
    expect((await authed(app, staff).get(`/v1/orgs/${c.org.orgId}`)).status).toBe(200);
    expect((await authed(app, c.O).delete(`/v1/orgs/${c.org.orgId}`)).status).toBe(204);
    expect((await keyGet(c.key.token, `/v1/orgs/${c.org.orgId}`)).status).toBe(401);
    expect((await authed(app, staff).get(`/v1/orgs/${c.org.orgId}`)).status).toBe(404);
    expect((await authed(app, c.O).post(`/v1/orgs/${c.org.orgId}/restore`).set('idempotency-key', `k-${c.org.orgId}`)).status).toBe(200);
    expect((await keyGet(c.key.token, `/v1/orgs/${c.org.orgId}`)).status).toBe(401);
    expect((await authed(app, staff).get(`/v1/orgs/${c.org.orgId}`)).status).toBe(404);
    const rows = await ownerQuery<{ k: boolean; g: boolean }>(
      `SELECT (SELECT revoked_at IS NOT NULL FROM org_api_keys WHERE public_id = $1) AS k,
              (SELECT revoked_at IS NOT NULL FROM org_support_grants WHERE public_id = $2) AS g`,
      [c.key.publicId, g.publicId],
    );
    expect(rows).toEqual([{ k: true, g: true }]);
  });
  it('Review Focus 3 / S-15: a grantee who becomes a member is served as a member', async () => {
    const c = await cast();
    const staff = await seedStaffPrincipal({ mark: false });
    principals.push(staff);
    const g = await seedSupportGrant(c.org, { grantee: { authUserId: staff.authUserId }, grantedByMemberId: c.org.owner.memberId, permissions: preset });
    const link = await seedInviteLink(c.org, { roleId: c.org.roles.MEMBER.id, createdByMemberId: c.org.owner.memberId });
    expect((await joinInviteLink(app, staff, { token: link.token })).status).toBe(200);
    expect((await revokedEvents(g.publicId)).map((e) => e.payload.reason)).toEqual(['GRANTEE_BECAME_MEMBER']);
    const r = await authed(app, staff).get(`/v1/orgs/${c.org.orgId}/members/me`); // @OrgMemberOnly: chỉ MEMBERSHIP qua được
    expect(r.status).toBe(200);
    expect((await ownerQuery(`SELECT 1 FROM org_support_grants WHERE public_id = $1 AND revoked_at IS NULL`, [g.publicId]))).toEqual([]);
  });
});
```
`test/e2e/tenancy/delegation-races.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import { ownerQuery } from '../../support/identity-app.js';
import { joinInviteLink } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedInviteLink, seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const ROUNDS = 10;

describe('delegation races through the app (spec SP3 §17; T-19 app path, member removal ∥ key creation)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  beforeAll(async () => {
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`T-19 (app): granting ∥ the staff joining through a link ×${ROUNDS} → never both a membership and an open grant`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const O = await seedUserPrincipal();
      const staff = await seedStaffPrincipal();
      principals.push(O, staff);
      const org = await seedOrg({ owner: { authUserId: O.authUserId } });
      orgs.push(org);
      const link = await seedInviteLink(org, { roleId: org.roles.MEMBER.id, createdByMemberId: org.owner.memberId });
      const [grant, join] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          authed(app, O)
            .post(`/v1/orgs/${org.orgId}/support-grants`)
            .set('idempotency-key', `k-${v7()}`)
            .send({ staffUserId: staff.authUserId, expiresInSec: 900, reason: 'T-19' }),
          joinInviteLink(app, staff, { token: link.token }),
        ]),
      );
      expect(join.status, `round ${i}`).toBe(200);
      expect([201, 422], `round ${i}`).toContain(grant.status);
      const open = await ownerQuery(
        `SELECT 1 FROM org_support_grants g JOIN tenancy_users u ON u.id = g.grantee_user_id WHERE g.org_id = $1 AND u.auth_user_id = $2 AND g.revoked_at IS NULL`,
        [org.orgId, staff.authUserId],
      );
      expect(open, `round ${i}`).toEqual([]);
    }
  });
  it(`removing a member ∥ that member creating a key ×${ROUNDS} → either the key never exists or it was announced CREATOR_REMOVED; no 500`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const O = await seedUserPrincipal();
      const A = await seedUserPrincipal();
      principals.push(O, A);
      const org = await seedOrg({ owner: { authUserId: O.authUserId } });
      orgs.push(org);
      const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
      const [created, removed] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          authed(app, A).post(`/v1/orgs/${org.orgId}/api-keys`).send({ name: 'race', permissions: ['org.read'], expiresInSec: 60 }),
          authed(app, O).delete(`/v1/orgs/${org.orgId}/members/${a.memberPublicId}`),
        ]),
      );
      expect(removed.status, `round ${i}`).toBe(204);
      expect([201, 404], `round ${i}`).toContain(created.status);
      if (created.status === 201) {
        const ev = await ownerQuery<{ payload: { reason: string } }>(
          `SELECT payload FROM outbox_events WHERE type = 'tenancy.api_key.revoked' AND aggregate_id = $1`,
          [created.body.id],
        );
        expect(ev.map((e) => e.payload.reason), `round ${i}`).toEqual(['CREATOR_REMOVED']);
      }
      expect(await ownerQuery(`SELECT 1 FROM org_api_keys WHERE org_id = $1`, [org.orgId]), `round ${i}`).toEqual([]);
    }
  });
});
```
Run: `pnpm vitest run --project e2e test/e2e/tenancy/delegation-lifecycle.e2e.spec.ts test/e2e/tenancy/delegation-races.e2e.spec.ts`
Expected: FAIL (không event `CREATOR_REMOVED`; xoá mềm không thu hồi key/grant; join của grantee bị trigger `org_members_no_active_support_grant` → `409`).

- [ ] **Step 2: Revocations + điểm nối**

`src/modules/tenancy/application/delegation-revocations.ts` — constructor thêm `private readonly keys: OrgApiKeyRepository`; thêm:
```ts
  /**
   * Spec §14.1: key của member bị gỡ (xoá khỏi org, rời org, xoá tài khoản) mất theo FK CASCADE trong câu xoá member; event
   * `api_key.revoked { CREATOR_REMOVED }` phát TRƯỚC câu xoá, từ chính dòng còn đọc được, version + 1 (chuyển trạng thái cuối).
   */
  async announceKeysOfRemovedMember(memberId: string, actor: EventActor): Promise<void> {
    if (!this.uow.inTransaction()) throw new Error('DelegationRevocations must run inside UnitOfWork.run');
    for (const k of await this.keys.unrevokedOfMember(memberId))
      await this.events.publish(ApiKeyRevokedEvent, {
        data: { apiKeyId: k.publicId, reason: 'CREATOR_REMOVED' },
        aggregate: { type: 'api_key', id: k.publicId, version: k.version + 1 },
        actor,
      });
  }

  /** Xoá mềm org (spec §9.4, Bảng 5): mọi key và grant chưa thu hồi; không event riêng (`tenancy.org.deleted` hàm ý). */
  async revokeAllOfOrg(): Promise<void> {
    if (!this.uow.inTransaction()) throw new Error('DelegationRevocations must run inside UnitOfWork.run');
    await this.keys.revokeAll();
    await this.grants.revokeAll();
  }
```
`member-admission.ts` — constructor thêm `private readonly revocations: DelegationRevocations`; thay dòng chú thích `// 3D (SEC-M5): …` bằng:
```ts
        // 3D (SEC-M5, T-19): thu hồi support grant chưa thu hồi của chính user trong org, TRƯỚC INSERT; trigger hoãn
        // `org_members_no_active_support_grant` là lớp chặn cuối khi code quên hoặc SQL tay.
        await this.revocations.revokeGrantsOfGrantee(i.user.id, 'GRANTEE_BECAME_MEMBER', i.actor);
```
`member.service.ts` — `deleteWithEvent`, ngay sau `settleForRemovedMember`:
```ts
    await this.revocations.announceKeysOfRemovedMember(m.id, userActor(this.ctx));
```
(constructor thêm `DelegationRevocations`; chú thích "3D: phát `api_key.revoked` từng key" thay bằng câu gọi.) `user-deletion.service.ts` — `releaseOrg`, ngay sau `settleForRemovedMember(member.id, DELETION_ACTOR)`:
```ts
          await this.revocations.announceKeysOfRemovedMember(member.id, DELETION_ACTOR);
```
`org-lifecycle.service.ts` — `softDelete`, thay dòng `// 3D thu hồi key, grant (spec Bảng 5).` bằng `await this.revocations.revokeAllOfOrg();` đặt ngay sau `await this.transfers.cancelAllPending();`.

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm typecheck
pnpm vitest run --project e2e test/e2e/tenancy/delegation-lifecycle.e2e.spec.ts test/e2e/tenancy/delegation-races.e2e.spec.ts test/e2e/tenancy/org-lifecycle.e2e.spec.ts test/e2e/tenancy/members.e2e.spec.ts test/e2e/tenancy/account-deletion.e2e.spec.ts test/e2e/tenancy/invite-links.e2e.spec.ts test/e2e/tenancy/support-access.e2e.spec.ts
pnpm vitest run --project integration test/integration/tenancy/org-purge.spec.ts test/integration/tenancy/single-org-admission.spec.ts
```
Expected: PASS. Purge xoá cứng org có key và grant (4 câu đầu của `ORG_PURGE_STATEMENTS`, Task 14) — `org-purge.spec.ts` thêm key + grant vào org được purge ở Task 15 đã có; chạy lại ở đây.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/modules/tenancy test/e2e/tenancy/delegation-lifecycle.e2e.spec.ts test/e2e/tenancy/delegation-races.e2e.spec.ts
pnpm lint && pnpm arch
git add src/modules/tenancy test/e2e/tenancy/delegation-lifecycle.e2e.spec.ts test/e2e/tenancy/delegation-races.e2e.spec.ts
git commit -m "feat(tenancy): revoke delegations along the lifecycle — admission, member removal, account deletion and soft delete"
```

---

### Task 25: Migration catalogue thu hẹp key và grant (K-9, K-17 phần key/grant), cột org key + support grant của G-6, ba `AUTH_MODE` (K-11, U17), orphan trong phạm vi ủy quyền (R-X23)

**Files:**
- Create: `test/integration/tenancy/delegation-catalogue-migration.spec.ts`, `test/e2e/tenancy/delegation-orphans.e2e.spec.ts`
- Modify: `test/support/catalogue-migration.ts`, `test/integration/tenancy/catalogue-data-migration.spec.ts` (không đổi ca; chạy lại), `test/e2e/tenancy/role-route-matrix.e2e.spec.ts`, `test/e2e/tenancy/auth-modes.e2e.spec.ts`

**Interfaces:**
- Consumes: `narrowRolesToFixpoint`, `removePermissionDml`, `addRequiresEdgesDml`, `sevenStep`, `catalogueMigration` (3B), `ApiKeyScopeNarrowedEvent`, `SupportAccessScopeNarrowedEvent` (Task 16), `seedOrgApiKey`, `seedSupportGrant`, `seedStaffPrincipal`.
- Produces: `narrowDelegationsToFixpoint(migration: string, initialDelete?: { keys?: string; grants?: string }): string` (một khối `DO` cho cả hai bảng nối); `removePermissionDml`/`addRequiresEdgesDml` gọi nó sau phần role (khi bảng 3D tồn tại).

- [ ] **Step 1: Test (fail)**

`test/integration/tenancy/delegation-catalogue-migration.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { toEnvelope } from '../../../src/core/events/event-dispatch.handlers.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import { ApiKeyScopeNarrowedEvent, SupportAccessScopeNarrowedEvent } from '../../../src/modules/tenancy/events.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { addRequiresEdgesDml, catalogueMigration, removePermissionDml, sevenStep } from '../../support/catalogue-migration.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { inOrgTx, seedOrg, seedOrgApiKey, seedSupportGrant, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const TABLE = 'mikro_orm_migrations_delegation_catalogue';
/** Fixture eligible cho cả key lẫn grant (read): chuỗi R → P → Q dựng bằng cạnh mới; hình thoi top → left/right → base. */
const KEYS = [
  ['chain', 'read'],
  ['chainp', 'read'],
  ['chainq', 'read'],
  ['gone', 'read'],
  ['top', 'read'],
  ['left', 'read'],
  ['right', 'read'],
  ['base', 'read'],
] as const;

describe('catalogue migrations narrow org key and support grant scopes (spec SP3 §8.8; §18.3 K-9, K-17 key/grant)', () => {
  let db: ScratchDb;
  let owner: pg.Client;
  let org: SeededOrg;
  let key: { publicId: string };
  let grant: { publicId: string };
  const run = (...m: ReturnType<typeof catalogueMigration>[]) => runMigrations('up', { source: { kind: 'list', list: m }, tableName: TABLE });
  const scopeOf = (table: 'org_api_key_permissions' | 'org_support_grant_permissions', parent: string, publicId: string) =>
    withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, async () =>
          (
            await c.query<{ key: string }>(
              `SELECT p.key FROM ${table} j JOIN permissions p ON p.id = j.permission_id JOIN ${parent} x ON x.org_id = j.org_id AND x.id = j.${parent === 'org_api_keys' ? 'api_key_id' : 'grant_id'}
               WHERE x.public_id = $1 ORDER BY p.key`,
              [publicId],
            )
          ).rows.map((r) => r.key),
        ),
      db.name,
    );
  const events = async (migration: string) =>
    (
      await owner.query(
        `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
                aggregate_version::text AS aggregate_version, payload, headers, occurred_at
         FROM outbox_events WHERE headers->>'actorId' = $1 AND type <> 'tenancy.role.updated' ORDER BY id`,
        [`catalogue-migration:${migration}`],
      )
    ).rows.map((row) =>
      row.type === 'tenancy.api_key.scope_narrowed'
        ? parseEnvelope(ApiKeyScopeNarrowedEvent, toEnvelope(row))
        : parseEnvelope(SupportAccessScopeNarrowedEvent, toEnvelope(row)),
    );

  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('delcat');
    vi.stubEnv('DB_NAME', db.name);
    await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
    owner = await db.client('owner');
    await owner.query(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) SELECT r, a, false, true, true FROM unnest($1::text[], $2::text[]) AS k (r, a)`,
      [KEYS.map(([r]) => r), KEYS.map(([, a]) => a)],
    );
    await owner.query(
      `INSERT INTO permission_requires (permission_id, required_permission_id) SELECT p.id, q.id FROM (VALUES ('top.read','left.read'),('top.read','right.read')) e (k, req) JOIN permissions p ON p.key = e.k JOIN permissions q ON q.key = e.req`,
    );
    org = await seedOrg({ database: db.name });
    const scope = ['chain.read', 'chainp.read', 'gone.read', 'top.read', 'left.read', 'right.read'];
    key = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: scope });
    grant = await seedSupportGrant(org, { grantee: { externalSubject: 'test:delcat' }, grantedByMemberId: org.owner.memberId, permissions: scope });
    await owner.query(`UPDATE permissions SET deprecated_at = now() WHERE key = 'gone.read'`);
  }, 180_000);
  afterAll(async () => {
    await owner?.end();
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('K-9 (key/grant): removing a permission deletes its rows from both scopes, bumps version, emits one scope_narrowed per touched delegation', async () => {
    const name = 'Migration29990201000001_remove_gone';
    await run(catalogueMigration(name, sevenStep(removePermissionDml(name, 'gone.read'))));
    expect(await scopeOf('org_api_key_permissions', 'org_api_keys', key.publicId)).not.toContain('gone.read');
    expect(await scopeOf('org_support_grant_permissions', 'org_support_grants', grant.publicId)).not.toContain('gone.read');
    const evs = await events(name);
    expect(evs.map((e) => [e.type, e.aggregate.id])).toEqual([
      ['tenancy.api_key.scope_narrowed', key.publicId],
      ['tenancy.support_access.scope_narrowed', grant.publicId],
    ]);
  });
  it('K-17 (key/grant): a new requires edge on R → P → Q and the diamond leaves every scope closed, never larger, each touched one with an event', async () => {
    const before = {
      key: await scopeOf('org_api_key_permissions', 'org_api_keys', key.publicId),
      grant: await scopeOf('org_support_grant_permissions', 'org_support_grants', grant.publicId),
    };
    const name = 'Migration29990201000002_edges';
    await run(
      catalogueMigration(
        name,
        sevenStep(addRequiresEdgesDml(name, [['chain.read', 'chainp.read'], ['chainp.read', 'chainq.read'], ['left.read', 'base.read']])),
      ),
    );
    const after = {
      key: await scopeOf('org_api_key_permissions', 'org_api_keys', key.publicId),
      grant: await scopeOf('org_support_grant_permissions', 'org_support_grants', grant.publicId),
    };
    for (const k of ['key', 'grant'] as const) {
      expect(after[k].every((p) => before[k].includes(p)), k).toBe(true);
      expect(after[k], k).not.toContain('chain.read'); // chainp thiếu chainq → bị gỡ → chain thiếu chainp → bị gỡ (bắc cầu)
      expect(after[k], k).not.toContain('top.read'); // left thiếu base → bị gỡ → top thiếu left → bị gỡ
      expect(after[k], k).toContain('right.read');
    }
    for (const [join, fk] of [['org_api_key_permissions', 'api_key_id'], ['org_support_grant_permissions', 'grant_id']] as const) {
      const open = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${join} s JOIN permission_requires r ON r.permission_id = s.permission_id
         WHERE NOT EXISTS (SELECT 1 FROM ${join} t WHERE t.org_id = s.org_id AND t.${fk} = s.${fk} AND t.permission_id = r.required_permission_id)`,
      );
      expect(open.rows[0]?.n, join).toBe(0);
    }
    expect((await events(name)).map((e) => e.type).sort()).toEqual(['tenancy.api_key.scope_narrowed', 'tenancy.support_access.scope_narrowed']);
    const v = await owner.query<{ k: number; g: number }>(
      `SELECT (SELECT version FROM org_api_keys WHERE public_id = $1) AS k, (SELECT version FROM org_support_grants WHERE public_id = $2) AS g`,
      [key.publicId, grant.publicId],
    );
    expect(v.rows[0]).toEqual({ k: 3, g: 3 });
  });
});
```
`test/e2e/tenancy/delegation-orphans.e2e.spec.ts` (app ở process con để đọc đúng output JSON của pino, cùng cách `roles-pii-logs.e2e.spec.ts`):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, seedOrgApiKey, type SeededOrg } from '../../support/tenancy-seed.js';

/** R-X23: quyền chỉ có trong DB (module của nó không nạp ở app này), eligible cho key. */
const ORPHAN = 'ghost.read';
const PROCESS_ENV: Record<string, string> = { HTTP_PORT: '0', HTTP_HOST: '127.0.0.1', HTTP_TRUST_PROXY: 'loopback' };

describe('orphan keys inside a delegation scope (R-X21, R-X23)', () => {
  let api: AppProcess | undefined;
  let O: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    await ownerQuery(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('ghost', 'read', false, true, true) ON CONFLICT ON CONSTRAINT permissions_key_uq DO NOTHING`,
    );
    api = await startAppProcess('test/support/api-entry.ts', { ...baseTestEnv(), ...PROCESS_ENV });
    O = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: O.authUserId } });
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await org?.dispose();
    await ownerQuery(`DELETE FROM permissions WHERE key = $1`, [ORPHAN]);
    await deleteSeededPrincipals([O]);
  });
  it('a key whose stored scope holds an unloaded permission still works for the rest; the orphan grants nothing; WARN once per key', async () => {
    const key = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read', ORPHAN] });
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`http://127.0.0.1:${api?.port}/v1/orgs/${org.orgId}`, { headers: { 'x-api-key': key.token } });
      expect(r.status).toBe(200);
    }
    const lines = (api?.output() ?? '').split('\n').filter((l) => l.includes('orphan_permission_ignored'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ORPHAN);
    expect(api?.output()).not.toContain(key.token);
  });
});
```

`test/e2e/tenancy/role-route-matrix.e2e.spec.ts` — G-6 thêm hai cột (spec §18.3 G-6: "org key đủ phạm vi, support grant đã step-up"):
```ts
type Column = SystemRoleKey | 'C1' | 'KEY' | 'SUPPORT';
const COLUMNS: readonly Column[] = ['OWNER', 'ADMIN', 'MEMBER', 'C1', 'KEY', 'SUPPORT'];
```
`Cast.as` thành `Record<SystemRoleKey | 'C1' | 'SUPPORT', SeededPrincipal>` cộng `keyToken: string`; `cast()` thêm:
```ts
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const fullKey = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: apiKeyEligibleKeys(merged) });
    const staff = await seedStaffPrincipal();
    principals.push(staff);
    await seedSupportGrant(org, { grantee: { authUserId: staff.authUserId }, grantedByMemberId: org.owner.memberId, permissions: supportPresetKeys(merged) });
```
`call` nhận `caller: { bearer: string } | { apiKey: string }` (đặt `authorization` hoặc `x-api-key`); ca G-6 tính:
```ts
      const perms =
        column === 'KEY'
          ? new Set(apiKeyEligibleKeys(merged))
          : column === 'SUPPORT'
            ? new Set(supportPresetKeys(merged))
            : column === 'C1'
              ? new Set(roleSetC1(merged))
              : systemRolePermissions(column, merged);
      // Org key bị `@SessionOnly` (route ✓ và route thu hẹp) và `@OrgMemberOnly` từ chối; support grant bị `@OrgMemberOnly` từ chối.
      const sessionOnly = route.sensitive || route.narrowing;
      const allowed =
        route.policy.kind === 'MEMBER_ONLY'
          ? column !== 'KEY' && column !== 'SUPPORT'
          : route.policy.keys.every((k) => perms.has(k)) && !(column === 'KEY' && sessionOnly);
      const r = await call(route, c, column === 'KEY' ? { apiKey: c.keyToken } : { bearer: c.as[column].bearer });
      const denied = column === 'KEY' || column === 'SUPPORT' ? r.status === 403 : r.status === 403 && r.body.code === 'forbidden';
      if (r.status >= 500 || denied === allowed) failures.push(/* như cũ */);
```
(Hai cột mới so `403` bất kỳ mã: org key ở route `@SessionOnly` nhận `api_key_not_allowed_here` từ `AuthGuard` trước `PoliciesGuard`; mọi lỗi khác của ô đều là sai.)

`test/e2e/tenancy/auth-modes.e2e.spec.ts` — trong `describe('AUTH_MODE=external …')` thêm:
```ts
  it('K-11: an org key works on its org in external mode; U17: support grants are off (POST → 403 feature_disabled)', async () => {
    const sub = `ext-${v7()}`;
    const org = await seedOrg({ owner: { externalSubject: sub } });
    seeded.push(org);
    const key = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read'] });
    expect((await http().get(`/v1/orgs/${org.orgId}`).set('x-api-key', key.token)).status).toBe(200);
    const g = await http()
      .post(`/v1/orgs/${org.orgId}/support-grants`)
      .set('authorization', `Bearer ${token(sub, { auth_time: nowSec() })}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ staffUserId: v7(), expiresInSec: 900, reason: 'x' });
    expect([g.status, g.body.code]).toEqual([403, 'feature_disabled']);
  });
```
và trong `describe` của `hybrid` (đã có trong file) thêm một ca: org key của owner local gọi org → `200`; nhân viên `seedStaffPrincipal()` có grant → `200` qua `SUPPORT_GRANT` (spec §11 bảng: hybrid như local).

Run:
```bash
pnpm vitest run --project integration test/integration/tenancy/delegation-catalogue-migration.spec.ts
pnpm vitest run --project e2e test/e2e/tenancy/delegation-orphans.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts
```
Expected: FAIL ở `delegation-catalogue-migration` (bảng nối của key/grant giữ `gone.read`, không event; migration catalogue thất bại ở câu `DELETE FROM permissions` vì FK `RESTRICT` từ bảng nối 3D). Ba file e2e còn lại: ca orphan và G-6 XANH ngay nếu Task 18–22 đúng (chúng là test hồi quy cho mô hình); `auth-modes` XANH.

- [ ] **Step 2: Thu hẹp phạm vi ủy quyền trong migration catalogue**

`test/support/catalogue-migration.ts` — thêm:
```ts
/**
 * Bước 3 cho org key và support grant (spec §8.8, K-9/K-17 mở rộng cho key và grant): cùng điểm bất động như role; mỗi key/grant
 * bị chạm: `version + 1` và đúng một `*.scope_narrowed` dựng từ giá trị SAU khi tăng. Bỏ qua khi bảng 3D chưa có (`to_regclass`).
 */
export function narrowDelegationsToFixpoint(migration: string, initialDelete?: { keys: string; grants: string }): string {
  const actor = `catalogue-migration:${migration}`;
  const block = (o: {
    join: string;
    parent: string;
    fk: string;
    touched: string;
    eventType: string;
    aggregateType: string;
    idField: string;
    initial: string | undefined;
  }) => `
  DROP TABLE IF EXISTS pg_temp.${o.touched};
  CREATE TEMP TABLE ${o.touched} (org_id uuid NOT NULL, id bigint NOT NULL, PRIMARY KEY (org_id, id)) ON COMMIT DROP;
  ${o.initial === undefined ? '' : `WITH d AS (${o.initial} RETURNING j.org_id, j.${o.fk}) INSERT INTO ${o.touched} SELECT DISTINCT org_id, ${o.fk} FROM d ON CONFLICT DO NOTHING;`}
  LOOP
    WITH d AS (
      DELETE FROM public.${o.join} j
      WHERE EXISTS (
        SELECT 1 FROM public.permission_requires r
        WHERE r.permission_id = j.permission_id
          AND NOT EXISTS (SELECT 1 FROM public.${o.join} x
                          WHERE x.org_id = j.org_id AND x.${o.fk} = j.${o.fk} AND x.permission_id = r.required_permission_id))
      RETURNING j.org_id, j.${o.fk}),
    i AS (INSERT INTO ${o.touched} SELECT DISTINCT org_id, ${o.fk} FROM d ON CONFLICT DO NOTHING)
    SELECT count(*) INTO v_removed FROM d;
    EXIT WHEN v_removed = 0;
  END LOOP;
  WITH u AS (
    UPDATE public.${o.parent} p SET version = p.version + 1, updated_at = now()
    FROM ${o.touched} t WHERE p.org_id = t.org_id AND p.id = t.id
    RETURNING p.org_id, p.id, p.public_id, p.version)
  INSERT INTO public.outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
  SELECT uuidv7(), '${o.eventType}', 1, u.org_id, '${o.aggregateType}', u.public_id::text, u.version,
    jsonb_build_object('${o.idField}', u.public_id, 'permissions', COALESCE((
      SELECT jsonb_agg(p.key ORDER BY p.key) FROM public.${o.join} j JOIN public.permissions p ON p.id = j.permission_id
      WHERE j.org_id = u.org_id AND j.${o.fk} = u.id AND p.deprecated_at IS NULL), '[]'::jsonb)),
    jsonb_build_object('actorType', 'system', 'actorId', '${actor}', 'correlationId', '${actor}')
  FROM u;`;
  return `DO $$
DECLARE v_removed bigint;
BEGIN
  IF to_regclass('public.org_api_key_permissions') IS NULL THEN RETURN; END IF;
  ${block({ join: 'org_api_key_permissions', parent: 'org_api_keys', fk: 'api_key_id', touched: 'catalogue_touched_keys', eventType: 'tenancy.api_key.scope_narrowed', aggregateType: 'api_key', idField: 'apiKeyId', initial: initialDelete?.keys })}
  ${block({ join: 'org_support_grant_permissions', parent: 'org_support_grants', fk: 'grant_id', touched: 'catalogue_touched_grants', eventType: 'tenancy.support_access.scope_narrowed', aggregateType: 'support_grant', idField: 'grantId', initial: initialDelete?.grants })}
END $$;`;
}
```
`removePermissionDml` — sau phần tử `narrowRolesToFixpoint(…)` chèn:
```ts
    narrowDelegationsToFixpoint(migration, {
      keys: `DELETE FROM public.org_api_key_permissions j USING public.permissions p WHERE p.id = j.permission_id AND p.key = '${key}'`,
      grants: `DELETE FROM public.org_support_grant_permissions j USING public.permissions p WHERE p.id = j.permission_id AND p.key = '${key}'`,
    }),
```
`addRequiresEdgesDml` — sau `narrowRolesToFixpoint(migration)` thêm `narrowDelegationsToFixpoint(migration)`.

(Trigger trạng thái cuối của Task 14 chỉ khoá `revoked_at`/`first_used_at`, không chặn `version`/`updated_at`; key/grant đã thu hồi vẫn được thu hẹp phạm vi và có event — hồ sơ audit đúng với dữ liệu.)

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm vitest run --project integration test/integration/tenancy/delegation-catalogue-migration.spec.ts test/integration/tenancy/catalogue-data-migration.spec.ts
pnpm vitest run --project e2e test/e2e/tenancy/delegation-orphans.e2e.spec.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts
```
Expected: PASS. `catalogue-data-migration.spec.ts` của 3B xanh không đổi (khối mới bỏ qua khi không có key/grant nào chạm; ca K-9c vẫn rollback cả khối).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/support/catalogue-migration.ts test/integration/tenancy/delegation-catalogue-migration.spec.ts test/e2e/tenancy
pnpm lint
git add test/support/catalogue-migration.ts test/integration/tenancy/delegation-catalogue-migration.spec.ts test/e2e/tenancy
git commit -m "test(tenancy): catalogue migrations narrow key and grant scopes; org key and support grant columns of the role-route matrix; auth modes"
```

---

## Phần F — Hợp đồng nhân viên cho module khác, sự cố, prod-like, tài liệu, bàn giao

### Task 26: Bộ ca `describePlatformStaffActionConformance` (addendum A5) trên route fixture ở ba `AUTH_MODE` (PSA-3, PSA-6, PSA-7)

**Files:**
- Create: `test/support/platform-staff-action.conformance.ts`, `test/e2e/identity/platform-staff-action.e2e.spec.ts`, `test/unit/architecture/platform-staff-conformance-imports.spec.ts`

**Interfaces:**
- Consumes: `PlatformStaffAction`, `PlatformAccessAudit`, `type PlatformAccessEntry` (identity `index.ts`, Task 12), `startTenancyApp`, `seedUserPrincipal`, `seedStaffPrincipal` (Task 7), `seedOrg`, `seedOrgApiKey`, `startFakeJwks`, `startFakeIdp` (test support).
- Produces (addendum A5 — hợp đồng cho SP4 4C, SP5 5B, SP6 6B):
  - `type PlatformStaffConformanceTarget = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body?: unknown; headers?: Readonly<Record<string, string>>; expectAllowedStatus: number }`.
  - `type ConformanceContext = { readonly app: INestApplication; readonly mode: 'local' | 'hybrid' | 'external' }`.
  - `type ConformanceOptions = { readonly extraImports?: ModuleImport[]; readonly modes?: readonly ('local' | 'hybrid' | 'external')[]; readonly handlerCalls?: () => number }`.
  - `describePlatformStaffActionConformance(name: string, target: (ctx: ConformanceContext) => PlatformStaffConformanceTarget, opts?: ConformanceOptions): void`.

- [ ] **Step 1: Helper conformance**

`test/support/platform-staff-action.conformance.ts`:
```ts
import { Global, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformAccessAudit, type PlatformAccessEntry } from '../../src/modules/identity/index.js';
import type { ModuleImport } from './app-factory.js';
import { FAKE_IDP_CLIENT_ID, FAKE_IDP_CLIENT_SECRET, startFakeIdp, type FakeIdp } from './fake-idp.js';
import { startFakeJwks, type FakeJwks } from './fake-jwks.js';
import { TEST_ORIGIN } from './auth-client.js';
import { ownerQuery } from './identity-app.js';
import { startTenancyApp } from './tenancy-app.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from './tenancy-principals.js';
import { seedOrg, seedOrgApiKey, type SeededOrg } from './tenancy-seed.js';

export type PlatformStaffConformanceTarget = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expectAllowedStatus: number;
};
type Mode = 'local' | 'hybrid' | 'external';
export type ConformanceContext = { readonly app: INestApplication; readonly mode: Mode };
/**
 * Lệch có chủ đích khỏi chữ ký hai tham số của addendum A5: helper không biết module nào chứa route, nên module gọi truyền
 * `extraImports` (thêm, tuỳ chọn; gọi hai tham số vẫn hợp lệ). `handlerCalls`: bộ đếm lần chạy handler của route (C10).
 */
export type ConformanceOptions = {
  readonly extraImports?: ModuleImport[];
  readonly modes?: readonly Mode[];
  readonly handlerCalls?: () => number;
};

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const ADMIN_CLAIM = 'role';
const TOKEN_TTL_SEC = 300;
/** Cũ hơn `AUTH_SESSION_FRESH_AGE_SEC` mặc định của test (C7, C8). */
const STALE_SEC = 3_600;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Port fixture ghi lại entry (C9) hoặc ném (C10); thứ tự với handler kiểm bằng `handlerCalls` lúc `record` chạy. */
class ConformanceAudit extends PlatformAccessAudit {
  entries: { entry: PlatformAccessEntry; handlerCallsAtRecord: number }[] = [];
  fail = false;
  handlerCalls: () => number = () => 0;
  record(entry: PlatformAccessEntry): Promise<void> {
    if (this.fail) return Promise.reject(new Error('conformance: audit store down'));
    this.entries.push({ entry, handlerCallsAtRecord: this.handlerCalls() });
    return Promise.resolve();
  }
}
const audit = new ConformanceAudit();
@Global()
@Module({ providers: [{ provide: PlatformAccessAudit, useValue: audit }], exports: [PlatformAccessAudit] })
class ConformanceAuditModule {}

/**
 * Addendum A5: C1–C10 cho MỘT route `@PlatformStaffAction()` ở mỗi `AUTH_MODE`. Module gọi hàm này cho mọi route admin của
 * mình; không định nghĩa lại mã lỗi, không test lại gate. C11 (lỗi hạ tầng của câu dấu) chỉ ở chaos của 3D.
 */
export function describePlatformStaffActionConformance(
  name: string,
  target: (ctx: ConformanceContext) => PlatformStaffConformanceTarget,
  opts: ConformanceOptions = {},
): void {
  for (const mode of opts.modes ?? (['local', 'hybrid', 'external'] as const))
    describe(`${name} — @PlatformStaffAction conformance [${mode}] (addendum A5)`, () => {
      let app: INestApplication;
      let jwks: FakeJwks | undefined;
      let idp: FakeIdp | undefined;
      let org: SeededOrg;
      const principals: SeededPrincipal[] = [];
      const send = (t: PlatformStaffConformanceTarget, auth: Record<string, string>) => {
        const agent = request(app.getHttpServer());
        const method = t.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
        let req = agent[method](t.path).set('origin', TEST_ORIGIN);
        for (const [k, v] of Object.entries({ ...t.headers, ...auth })) req = req.set(k, v);
        return t.body === undefined ? req : req.send(t.body as object);
      };
      const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
      const staffToken = (extra: Record<string, unknown>) =>
        jwks!.sign({ iss: ISS, aud: AUD, sub: `staff-${v7()}`, iat: nowSec(), exp: nowSec() + TOKEN_TTL_SEC, idtyp: 'user', [ADMIN_CLAIM]: 'admin', ...extra });
      const userToken = () =>
        jwks!.sign({ iss: ISS, aud: AUD, sub: `user-${v7()}`, iat: nowSec(), exp: nowSec() + TOKEN_TTL_SEC, idtyp: 'user', auth_time: nowSec() });
      const local = mode !== 'external';
      const staff = async (o: Parameters<typeof seedStaffPrincipal>[0] = {}) => {
        const p = await seedStaffPrincipal(o);
        principals.push(p);
        return bearer(p.bearer);
      };
      const tgt = () => target({ app, mode });

      beforeAll(async () => {
        const env: Record<string, string> = {};
        if (mode === 'external') {
          jwks = await startFakeJwks();
          Object.assign(env, {
            AUTH_MODE: 'external',
            BETTER_AUTH_SECRET: '',
            DB_AUTH_PASSWORD: '',
            AUTH_EXTERNAL_JWKS_URL: jwks.url,
            AUTH_EXTERNAL_ISSUER: ISS,
            AUTH_EXTERNAL_AUDIENCE: AUD,
            AUTH_EXTERNAL_ALGORITHMS: 'RS256',
            AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
            AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
            AUTH_EXTERNAL_ADMIN_CLAIM: ADMIN_CLAIM,
            AUTH_EXTERNAL_ADMIN_VALUE: 'admin',
            RESILIENCE_ALLOWED_SCHEMES: 'http,https',
            RESILIENCE_ALLOWED_PORTS: new URL(jwks.url).port,
            RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
          });
        }
        if (mode === 'hybrid') {
          idp = await startFakeIdp({ redirectUri: `${TEST_ORIGIN}/api/auth/callback/corp` });
          Object.assign(env, {
            AUTH_MODE: 'hybrid',
            AUTH_OIDC_PROVIDER_ID: 'corp',
            AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
            AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
            AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
            AUTH_TRUSTED_PROVIDERS: 'corp',
          });
        }
        app = await startTenancyApp({ env, extraImports: [ConformanceAuditModule, ...(opts.extraImports ?? [])] });
        audit.handlerCalls = opts.handlerCalls ?? (() => 0);
        org = local
          ? await seedOrg({ owner: { authUserId: (await seedUserPrincipal()).authUserId } })
          : await seedOrg({ owner: { externalSubject: `owner-${v7()}` } });
      });
      afterAll(async () => {
        await org?.dispose();
        await app?.close();
        await jwks?.close();
        await idp?.close();
        await deleteSeededPrincipals(principals);
        vi.unstubAllEnvs();
      });
      const refused = async (auth: Record<string, string>, status: number, code: string | undefined) => {
        const before = audit.entries.length;
        const r = await send(tgt(), auth);
        expect([r.status, code === undefined ? undefined : r.body.code]).toEqual([status, code]);
        expect(audit.entries.length, 'a refused request never reaches PlatformAccessAudit (A-D6)').toBe(before);
      };

      it('C1: no credential → 401', () => refused({}, 401, 'unauthenticated'));
      it('C2: a session that is not staff → 403 forbidden', async () => {
        if (local) {
          const u = await seedUserPrincipal();
          principals.push(u);
          await refused(bearer(u.bearer), 403, 'forbidden');
        } else await refused(bearer(userToken()), 403, 'forbidden');
      });
      it('C3: a Better Auth API key → 403 forbidden (local/hybrid), 401 (external)', async () => {
        if (!local) return refused({ 'x-api-key': 'not-an-org-key' }, 401, 'unauthenticated');
        const u = await seedUserPrincipal();
        principals.push(u);
        const created = await request(app.getHttpServer())
          .post('/api/auth/api-key/create')
          .set('authorization', `Bearer ${u.bearer}`)
          .set('origin', TEST_ORIGIN)
          .send({ name: 'conformance' });
        expect(created.status).toBe(200);
        await refused({ 'x-api-key': String(created.body.key) }, 403, 'forbidden');
      });
      it('C4: an org API key → 403 api_key_not_allowed_here', async () => {
        const key = await seedOrgApiKey(org, { createdByMemberId: org.owner.memberId, permissions: ['org.read'] });
        await refused({ 'x-api-key': key.token }, 403, 'api_key_not_allowed_here');
      });
      it('C5–C7 (local/hybrid): staff without a step-up, with a backup-code step-up, or with a stale TOTP mark → 403 second_factor_required', async () => {
        if (!local) return;
        await refused(await staff({ mark: false }), 403, 'second_factor_required');
        await refused(await staff({ method: 'backup_code' }), 403, 'second_factor_required');
        await refused(await staff({ markAgeSec: STALE_SEC }), 403, 'second_factor_required');
      });
      it('C8 (external): staff token without auth_time, or with a stale one → 403 reauthentication_required', async () => {
        if (local) return;
        await refused(bearer(staffToken({})), 403, 'reauthentication_required');
        await refused(bearer(staffToken({ auth_time: nowSec() - STALE_SEC })), 403, 'reauthentication_required');
      });
      it('C9: valid staff → expectAllowedStatus; exactly one entry (template, path params, actor, credential kind), recorded before the handler', async () => {
        const auth = local ? await staff() : bearer(staffToken({ auth_time: nowSec() }));
        const before = audit.entries.length;
        const calls = (opts.handlerCalls ?? (() => 0))();
        const r = await send(tgt(), auth);
        expect(r.status).toBe(tgt().expectAllowedStatus);
        const added = audit.entries.slice(before);
        expect(added).toHaveLength(1);
        const [{ entry, handlerCallsAtRecord }] = added as [(typeof added)[number]];
        expect(entry.method).toBe(tgt().method);
        expect(entry.actor.type).toBe('user');
        expect(entry.credentialKind).toBe(local ? 'BEARER_SESSION' : 'EXTERNAL_BEARER');
        expect(handlerCallsAtRecord).toBe(calls);
        expect(JSON.stringify(entry)).not.toMatch(/[?&]/); // không query string (A-D5)
      });
      it('C10: the audit port throws → 503 + Retry-After, the handler does not run', async () => {
        const auth = local ? await staff() : bearer(staffToken({ auth_time: nowSec() }));
        const calls = (opts.handlerCalls ?? (() => 0))();
        audit.fail = true;
        try {
          const r = await send(tgt(), auth);
          expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
          expect(r.headers['retry-after']).toBeDefined();
          expect((opts.handlerCalls ?? (() => 0))()).toBe(calls);
        } finally {
          audit.fail = false;
        }
      });
      it('PSA-7: a non-staff session never queries the auth pool in the guard (no mark query)', async () => {
        if (!local) return;
        const u = await seedUserPrincipal();
        principals.push(u);
        const before = Number((await ownerQuery<{ n: string }>(`SELECT sum(seq_scan + idx_scan)::text AS n FROM pg_stat_user_tables WHERE schemaname = 'auth' AND relname = 'session_second_factor'`))[0]?.n ?? 0);
        await send(tgt(), bearer(u.bearer));
        await ownerQuery(`SELECT pg_stat_force_next_flush()`);
        const after = Number((await ownerQuery<{ n: string }>(`SELECT sum(seq_scan + idx_scan)::text AS n FROM pg_stat_user_tables WHERE schemaname = 'auth' AND relname = 'session_second_factor'`))[0]?.n ?? 0);
        expect(after).toBe(before);
      });
    });
}
```
(`pg_stat_force_next_flush()` có từ Postgres 15; bộ đếm theo bảng là cách đếm câu không phụ thuộc pool nào gửi — chạy file với `fileParallelism: false` của project e2e nên không có truy vấn song song của file khác. Ở `external` không có pool auth nên PSA-7 chỉ chạy ở local/hybrid.)

- [ ] **Step 2: E2E trên route fixture + luật import**

`test/e2e/identity/platform-staff-action.e2e.spec.ts`:
```ts
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { PlatformStaffAction } from '../../../src/modules/identity/index.js';
import { describePlatformStaffActionConformance } from '../../support/platform-staff-action.conformance.js';

let handlerCalls = 0;
@Controller('v1/admin/__fixture')
class FixtureAdminController {
  @PlatformStaffAction()
  @Get(':itemId')
  get(@Param('itemId') itemId: string) {
    handlerCalls += 1;
    return { itemId };
  }
  @PlatformStaffAction()
  @Post(':itemId/actions')
  act(@Param('itemId') itemId: string, @Body() _body: unknown) {
    handlerCalls += 1;
    return { itemId };
  }
}
@Module({ controllers: [FixtureAdminController] })
class FixtureAdminModule {}

/** PSA-3/PSA-6/PSA-7 (addendum A7): C1–C10 trên GET và POST ở cả ba AUTH_MODE. */
describePlatformStaffActionConformance(
  'GET /v1/admin/__fixture/:itemId',
  () => ({ method: 'GET', path: '/v1/admin/__fixture/42?q=secret', expectAllowedStatus: 200 }),
  { extraImports: [FixtureAdminModule], handlerCalls: () => handlerCalls },
);
describePlatformStaffActionConformance(
  'POST /v1/admin/__fixture/:itemId/actions',
  () => ({ method: 'POST', path: '/v1/admin/__fixture/42/actions', body: { reason: 'secret body' }, expectAllowedStatus: 201 }),
  { extraImports: [FixtureAdminModule], handlerCalls: () => handlerCalls },
);
```
`test/unit/architecture/platform-staff-conformance-imports.spec.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** PSA-9 (addendum A7): file conformance chỉ import `test/support/*`, thư viện, và `index.ts` của module. */
describe('platform-staff-action.conformance.ts imports', () => {
  it('imports only test support, libraries and a module index', () => {
    const src = readFileSync('test/support/platform-staff-action.conformance.ts', 'utf8');
    const relative = [...src.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]);
    for (const path of relative)
      expect(path.startsWith('./') || /^\.\.\/\.\.\/src\/modules\/[a-z-]+\/index\.js$/.test(path ?? ''), path).toBe(true);
  });
});
```

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/architecture/platform-staff-conformance-imports.spec.ts
pnpm vitest run --project e2e test/e2e/identity/platform-staff-action.e2e.spec.ts
```
Expected: PASS ở cả ba mode cho cả hai route (C3 external `401`; C5–C7 bỏ qua ở external; C8 bỏ qua ở local/hybrid).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/support/platform-staff-action.conformance.ts test/e2e/identity/platform-staff-action.e2e.spec.ts test/unit/architecture/platform-staff-conformance-imports.spec.ts
pnpm lint
git add test/support/platform-staff-action.conformance.ts test/e2e/identity/platform-staff-action.e2e.spec.ts test/unit/architecture/platform-staff-conformance-imports.spec.ts
git commit -m "test(identity): exported conformance suite for @PlatformStaffAction routes in the three auth modes"
```

---

### Task 27: Chaos — DB lỗi ở mọi câu mới của 3D (tiêu chí 12), giết api giữa thao tác ủy quyền (tiêu chí 11), C11/PSA-4

**Files:**
- Create: `test/chaos/delegation-outages.spec.ts`, `test/chaos/delegation-api-kill.spec.ts`

**Interfaces:**
- Consumes: `startProxy`/`TcpProxy` (`test/support/tcp-proxy.ts`: `blackhole()`, `restore()`), mẫu dựng app qua proxy của `test/chaos/tenancy-acquisition-outages.spec.ts` và `test/chaos/identity-outages.spec.ts` (pool app và pool auth đi qua hai proxy riêng), mẫu giết process của `test/chaos/tenancy-acquisition-api-kill.spec.ts` (`spawnApi`, `kill('SIGKILL')`), `seedOrgApiKey`, `seedSupportGrant`, `seedStaffPrincipal`, `enrolStaff`, `stepUp`.
- Produces: không có API mới.

- [ ] **Step 1: Outages (fail trước khi chạy)**

`test/chaos/delegation-outages.spec.ts` — dựng app như `identity-outages.spec.ts` (hai proxy: `appDb` cho `DB_HOST/DB_PORT`, `authDb` cho `DB_AUTH_HOST/DB_AUTH_PORT`), mỗi ca `blackhole()` đúng một proxy rồi `restore()` trong `finally`:
```ts
  it('org key authentication with the app DB blackholed → 503 + Retry-After, never 401', async () => {
    const s = await keyCast();
    appDb.blackhole();
    try {
      const r = await request(app.getHttpServer()).get(`/v1/orgs/${s.org.orgId}`).set('x-api-key', s.key.token);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(r.headers['retry-after']).toBeDefined();
    } finally {
      appDb.restore();
    }
  });
  it('org key authentication with the auth DB blackholed (creator lookup) → 503, never 401', async () => {
    const s = await keyCast();
    authDb.blackhole();
    try {
      expect((await request(app.getHttpServer()).get(`/v1/orgs/${s.org.orgId}`).set('x-api-key', s.key.token)).status).toBe(503);
    } finally {
      authDb.restore();
    }
  });
  it('support branch: the auth DB blackholed exactly at the mark read (secondFactorVerifiedAt) → 503, not 403 and not 404', async () => {
    const g = await grantCast();
    const facts = app.get(AuthFacts);
    const realRead = facts.secondFactorVerifiedAt.bind(facts);
    const spy = vi.spyOn(facts, 'secondFactorVerifiedAt').mockImplementationOnce(async () => {
      authDb.blackhole();
      try {
        return await realRead();
      } finally {
        authDb.restore();
      }
    });
    try {
      const r = await authed(app, g.staff).get(`/v1/orgs/${g.org.orgId}`);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      spy.mockRestore();
    }
  });
  it('support first use: the write transaction on a blackholed app DB → 503; the grant stays unused and no used event', async () => {
    const g = await grantCast();
    const repo = app.get(SupportGrantRepository);
    const realMark = repo.markFirstUse.bind(repo);
    const spy = vi.spyOn(repo, 'markFirstUse').mockImplementationOnce(async (id) => {
      appDb.blackhole();
      try {
        return await realMark(id);
      } finally {
        appDb.restore();
      }
    });
    try {
      expect((await authed(app, g.staff).get(`/v1/orgs/${g.org.orgId}`)).status).toBe(503);
      expect(await ownerQuery(`SELECT first_used_at FROM org_support_grants WHERE public_id = $1`, [g.grant.publicId])).toEqual([{ first_used_at: null }]);
    } finally {
      spy.mockRestore();
    }
  });
  it('S-20: the step-up lockout storage down (auth DB blackholed) → 503, the verify handler does not run, no mark', async () => {
    const s = await enrolStaff(app);
    authDb.blackhole();
    try {
      expect((await stepUp(s)).status).toBe(503);
    } finally {
      authDb.restore();
    }
    expect(await marksOf(s.userId)).toEqual([]);
  });
  it('PSA-4 / C11: the TOTP-mark query of PlatformStaffGuard on a blackholed auth DB → 503 + Retry-After; the audit port is not called', async () => {
    const staff = await seedStaffPrincipal();
    const calls = auditCalls();
    authDb.blackhole();
    try {
      const r = await request(app.getHttpServer()).get('/v1/admin/__fixture/1').set('authorization', `Bearer ${staff.bearer}`);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(r.headers['retry-after']).toBeDefined();
    } finally {
      authDb.restore();
    }
    expect(auditCalls()).toBe(calls);
  });
  it('S-23: revoking grants on a role write with the app DB blackholed → 503 + ERROR platform_role_change_listener_failed; retry revokes', async () => {
    const g = await grantCast();
    const admin = await enrolStaff(app);
    expect((await stepUp(admin)).status).toBe(200);
    const listener = app.get(PlatformRoleChangeListener);
    const realChange = listener.onPlatformRoleChanged.bind(listener);
    const spy = vi.spyOn(listener, 'onPlatformRoleChanged').mockImplementationOnce(async (id) => {
      appDb.blackhole();
      try {
        return await realChange(id);
      } finally {
        appDb.restore();
      }
    });
    try {
      expect((await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: g.staff.authUserId, role: 'user' } })).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect((await admin.client.request('post', '/api/auth/admin/set-role', { body: { userId: g.staff.authUserId, role: 'user' } })).status).toBe(200);
  });
```
Trong `describe` của file: `keyCast()` = owner + org + ADMIN + `seedOrgApiKey`; `grantCast()` = owner + org + `seedStaffPrincipal()` + `seedSupportGrant` (trả `{ org, staff, grant }`); route fixture `/v1/admin/__fixture/:id` (`@PlatformStaffAction()`) và module audit fixture đếm lần gọi (`auditCalls()`) như Task 26, khai trong `extraImports` của app. Import thêm `AuthFacts`, `PlatformRoleChangeListener` từ `src/modules/identity/index.js`, `SupportGrantRepository` từ `src/modules/tenancy/ports/support-grant-repository.js`, `enrolStaff`, `stepUp`, `marksOf` từ `test/support/staff.js`. Mỗi ca bọc phương thức thật bằng `bind` trước `vi.spyOn` để chỉ đúng câu cần thử rơi vào lúc proxy bị cắt.

Run: `pnpm test:chaos test/chaos/delegation-outages.spec.ts`
Expected: PASS nếu Task 20–23 đúng (đây là test hồi quy cho tiêu chí 12 trên đường mới; ca nào đỏ là lỗi thật ở task đó, sửa ở task đó).

- [ ] **Step 2: Giết api giữa thao tác (tiêu chí 11)**

`test/chaos/delegation-api-kill.spec.ts` — cùng khung `tenancy-acquisition-api-kill.spec.ts` (api là process con của `test/support/api-entry.ts`; test giữ một khoá dòng để transaction đứng chờ SAU câu ghi đầu tiên, `SIGKILL`, PgBouncer đóng connection server → rollback). Điểm chờ: câu `INSERT` bảng nối (`org_api_key_permissions` / `org_support_grant_permissions`) kiểm FK tới `permissions` bằng `FOR KEY SHARE`; test giữ `FOR UPDATE` trên dòng `permissions` của `org.read` bằng kết nối owner (bảng global, `app_user` chỉ có `SELECT`). Khi đó dòng `org_api_keys`/`org_support_grants` đã ghi, event chưa ghi:
```ts
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../support/app-process.js';
import { baseTestEnv } from '../support/env.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { exitCode } from '../support/spawn-worker.js';
import { deleteSeededPrincipals, seedStaffPrincipal, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';

const WAIT_MS = 60_000;
const API_ENTRY = 'test/support/api-entry.ts';
const PROCESS_ENV = { HTTP_PORT: '0', HTTP_HOST: '127.0.0.1', HTTP_TRUST_PROXY: 'loopback' };
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
const post = (port: number, bearer: string, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'idempotency-key': `kill-${Date.now()}` },
    body: JSON.stringify(body),
  });

type Case = { name: string; table: string; event: string; path: (orgId: string) => string; body: (staffId: string) => unknown };
const CASES: Case[] = [
  {
    name: 'org API key creation',
    table: 'org_api_keys',
    event: 'tenancy.api_key.created',
    path: (o) => `/v1/orgs/${o}/api-keys`,
    body: () => ({ name: 'kill', permissions: ['org.read'], expiresInSec: 600 }),
  },
  {
    name: 'support grant',
    table: 'org_support_grants',
    event: 'tenancy.support_access.granted',
    path: (o) => `/v1/orgs/${o}/support-grants`,
    body: (staffId) => ({ staffUserId: staffId, expiresInSec: 900, reason: 'kill' }),
  },
];

/** Spec SP3 tiêu chí 11 cho key và grant (§18.4): dòng và event cùng commit hoặc cùng mất. */
describe('api killed inside a delegation transaction (spec SP3 tiêu chí 11, phần 3D)', () => {
  const apis: AppProcess[] = [];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    for (const o of orgs) await o.dispose();
    await deleteSeededPrincipals(principals);
  });

  it.each(CASES)('$name: SIGKILL while the scope insert waits → no row, no event; a fresh api succeeds exactly once', async (c) => {
    const owner = await seedUserPrincipal();
    const staff = await seedStaffPrincipal();
    principals.push(owner, staff);
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const state = async () => ({
      rows: (await ownerQuery(`SELECT 1 FROM ${c.table} WHERE org_id = $1`, [org.orgId])).length,
      events: (await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = $2`, [org.orgId, c.event])).length,
    });
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
      const pending = post(first.port, owner.bearer, c.path(org.orgId), c.body(staff.authUserId)).then(
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
    } finally {
      await lock.end();
    }
    await until(async () => (await ownerQuery(`SELECT 1 FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state <> 'idle'`, [blocked])).length === 0);
    expect(await state()).toEqual({ rows: 0, events: 0 });
    const second = await startApi();
    apis.push(second);
    expect((await post(second.port, owner.bearer, c.path(org.orgId), c.body(staff.authUserId))).status).toBe(201);
    expect(await state()).toEqual({ rows: 1, events: 1 });
  }, 120_000);
});
```

Run: `pnpm test:chaos test/chaos/delegation-api-kill.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write test/chaos/delegation-outages.spec.ts test/chaos/delegation-api-kill.spec.ts src/modules/tenancy
pnpm lint
git add test/chaos/delegation-outages.spec.ts test/chaos/delegation-api-kill.spec.ts src/modules/tenancy
git commit -m "test(chaos): delegation paths answer 503 on DB outages and leave no half-written key or grant when the api dies"
```

---

### Task 28: Prod-like trên image production — smoke 3D tenancy, đo image, dòng "SP3 (cuối)" của ADR 0013

**Files:**
- Modify: `test/smoke/tenancy.smoke.spec.ts`, `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: `staffDevice` (Task 13), `verifiedDevice`, `psql`, `compose`, `Device.call` (`test/smoke/*`).
- Produces: ca smoke 3D tenancy; mục "Số đo SP3 (cuối)" trong ADR 0013.

- [ ] **Step 1: Ca smoke**

`test/smoke/tenancy.smoke.spec.ts` — thêm trước ca log sạch:
```ts
  it('3D on the production image: an org key reads its org, is refused elsewhere, and dies with the soft delete; a stepped-up staff uses a grant', async () => {
    const { device: owner } = await verifiedDevice(apiUrl, mail, forbidden);
    forbidden.push('SMOKE-3D'); // `reason` của grant không bao giờ vào log hay event
    const created = await owner.call('POST', '/v1/orgs', { body: { name: 'Smoke 3D' }, headers: { 'idempotency-key': `smoke-${Date.now()}` } });
    expect(created.status).toBe(201);
    const orgId = ((await created.json()) as { id: string }).id;
    const keyRes = await owner.call('POST', `/v1/orgs/${orgId}/api-keys`, { body: { name: 'smoke', permissions: ['org.read', 'members.read'], expiresInSec: 3600 } });
    expect(keyRes.status).toBe(201);
    expect(keyRes.headers.get('cache-control')).toBe('no-store');
    const key = ((await keyRes.json()) as { key: string }).key;
    forbidden.push(key);
    const asKey = (path: string) => fetch(`${apiUrl}${path}`, { headers: { 'x-api-key': key } });
    expect((await asKey(`/v1/orgs/${orgId}/members`)).status).toBe(200);
    expect((await asKey('/v1/me')).status).toBe(403);
    const { device: staff } = await staffDevice(apiUrl, mail, forbidden);
    const staffId = ((await (await staff.call('GET', '/v1/me')).json()) as { id: string }).id;
    const grant = await owner.call('POST', `/v1/orgs/${orgId}/support-grants`, {
      body: { staffUserId: staffId, expiresInSec: 900, reason: 'SMOKE-3D' },
      headers: { 'idempotency-key': `smoke-g-${Date.now()}` },
    });
    expect(grant.status).toBe(201);
    expect((await staff.call('GET', `/v1/orgs/${orgId}/members`)).status).toBe(200);
    expect((await staff.call('POST', `/v1/orgs/${orgId}/roles`, { body: { name: 'x', permissions: ['org.read'] }, headers: { 'idempotency-key': `s-${Date.now()}` } })).status).toBe(403);
    expect((await owner.call('DELETE', `/v1/orgs/${orgId}`)).status).toBe(204);
    expect((await asKey(`/v1/orgs/${orgId}/members`)).status).toBe(401);
    expect((await staff.call('GET', `/v1/orgs/${orgId}`)).status).toBe(404);
    expect(psql(`SELECT count(*) FROM outbox_events WHERE type LIKE 'tenancy.support_access.%' AND org_id = '${orgId}'`)).toBe('2'); // granted + used
  });
```
(`Device.call(method, path, { body, headers })` và `forbidden` là của file: mọi giá trị trong `forbidden` không được xuất hiện trong log container — key `oak_`, secret TOTP và `reason` của grant được thêm vào.)

- [ ] **Step 2: Chạy prod-like**

Run: `pnpm test:smoke`
Expected: build image production thật; `docker compose --profile app` (`NODE_ENV=production`) migrate từ `dist` (gồm `…_session_second_factor`, `…_security_notice_operator_reset`, `…_delegation`, `…_support_templates`); mọi file smoke PASS (core, auth-email, dashboard, composition, entitlements, tenancy); log api/worker là JSON, không dòng `error`, không chứa giá trị nào của `forbidden` (email, cookie, bearer, key `oak_`, secret TOTP, `SMOKE-3D`); `/health/ready` 200; `down -v` sạch. Worker gửi hai thư `support-access-notice` qua Mailpit (granted, used; xoá mềm thu hồi grant không event riêng — §14.1 — nên không có thư revoked).

- [ ] **Step 3: Đo image, ghi ADR 0013**

Run (cùng phương pháp các dòng trước của ADR 0013):
```bash
docker history --no-trunc --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
docker image inspect --format '{{.Size}}' nestjs-saas-boilerplate:nsb-smoke
```
`docs/adr/0013-build-toolchain.md` — thêm cuối:
```markdown
### Số đo SP3 (cuối) (<ngày chạy, YYYY-MM-DD>)

Đo sau `pnpm test:smoke` xanh của Task 28 (plan 3D) trên HEAD nhánh `sp3d-delegation`, cùng máy và phương pháp với dòng SP3 (3C). 3D là plan SP3 merge sau cùng (spec SP3 §18.4, Bảng 5) và không thêm package (`package.json`, `pnpm-lock.yaml` không đổi so với `main`); thay đổi là code của `identity`, `tenancy`, `notifications` và bốn migration.

| Chỉ số | SP3 (3C) | SP3 (cuối) | Chênh |
|---|---|---|---|
| Tổng layer (`docker history`) | <số của dòng 3C> | <số đo> | <chênh> |
| Nén (`docker image inspect .Size`) | <số của dòng 3C> | <số đo> | <chênh> |
```
Ba ô `<…>` điền bằng số thật vừa đo và số của mục "Số đo SP3 (3C)" ngay trên trong cùng file (đây là dữ liệu đo lúc chạy, không phải chỗ trống của plan). Chênh > 1 MB phải có một câu giải thích nguồn.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write test/smoke/tenancy.smoke.spec.ts
git add test/smoke/tenancy.smoke.spec.ts docs/adr/0013-build-toolchain.md
git commit -m "test(smoke): org API key and support grant on the production image; record the final SP3 image size"
```

---

### Task 29: Tài liệu — README, ADR 0005/0007/0010/0017, spec cha (A7, bỏ nhãn `(3D)`)

**Files:**
- Modify: `docs/boilerplate/README.md`, `docs/adr/0005-multi-tenant-rls.md`, `docs/adr/0007-http-conventions.md`, `docs/adr/0010-better-auth-and-auth-modes.md`, `docs/adr/0017-tenancy-own-module.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`

**Interfaces:**
- Consumes: mọi tên, env, mã lỗi, lệnh của Task 3–28.
- Produces: tài liệu khớp code.

- [ ] **Step 1: README**

`docs/boilerplate/README.md` — thêm ba mục (sau mục tenancy của 3C), mỗi mục chỉ nêu điều người dùng boilerplate phải biết:
```markdown
## Org API key (SP3 3D)

- Tạo: `POST /v1/orgs/{orgId}/api-keys { name, permissions, expiresInSec }` (cần `api_keys.write_own`, session mới, email đã xác thực). Key `oak_…` trả **một lần** ở `201`; DB chỉ giữ SHA-256. Gửi bằng header `AUTH_API_KEY_HEADER` (mặc định `x-api-key`).
- Phạm vi tường minh, đóng theo `requires`, chỉ quyền `apiKeyEligible`, không vượt quyền hiện tại của người tạo. Lúc dùng: phạm vi ∩ quyền HIỆN TẠI của người tạo — hạ role người tạo thì key mất quyền ngay request sau; người tạo rời org thì key mất.
- Chỉ dùng trên route `/v1/orgs/{orgId của key}/…`; org khác → `404`; route khác → `403 api_key_not_allowed_here`; key sai/thu hồi/hết hạn, org xoá mềm, người tạo bị ban hoặc chưa xác thực email → `401`.
- Tự liệt kê và thu hồi key của mình: `GET/DELETE …/api-keys/mine[/{keyId}]` (không cần session mới). Thu hồi key của người khác: `api_keys.write_all` và chỉ khi trội hẳn người tạo.
- Env: `TENANCY_ORG_API_KEY_MAX_TTL_SEC`, `TENANCY_MAX_ACTIVE_ORG_API_KEYS_PER_MEMBER`.

## Support grant (SP3 3D)

- Owner cấp quyền chỉ đọc có hạn cho nhân viên nền tảng: `POST /v1/orgs/{orgId}/support-grants { staffUserId, expiresInSec, reason }`. `staffUserId` là `id` trong `GET /v1/me` của nhân viên (nhân viên gửi qua ticket). Người nhận phải là platform admin có 2FA, không bị ban, không là member; mọi lý do khác → một mã `422 support_grantee_ineligible`.
- Phạm vi = mọi quyền `supportEligible` có `action = 'read'` của catalogue gộp. Hết hạn tự suy ra; thu hồi: `DELETE …/support-grants/{grantId}`. Owner nhận thư khi grant được cấp, dùng lần đầu, bị thu hồi.
- Nhân viên dùng grant bằng session của mình **sau khi step-up** trong chính session đó: `POST /api/auth/two-factor/verify-totp { code }` (hoặc backup code). Không có/cũ hơn `TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC` → `403 second_factor_required`.
- Grant bị thu hồi khi người nhận thành member của org, khi role nền tảng của họ được ghi qua `/admin/set-role`/`/admin/update-user`, khi org bị xoá mềm. Đổi role nền tảng bằng SQL tay không thu hồi grant: luôn đổi role qua endpoint admin hoặc lệnh reset bên dưới.
- Env: `TENANCY_SUPPORT_GRANTS` (`auto`: bật ở local/hybrid, tắt ở external), `TENANCY_SUPPORT_GRANT_MAX_TTL_SEC` (≤ 72 h), `TENANCY_SUPPORT_STEP_UP_MAX_AGE_SEC`.

## Nhân viên nền tảng: step-up 2FA và lệnh reset (SP3 3D)

- Mọi đường quyền nền tảng của nhân viên (`/api/auth/admin/*`, `/two-factor/get-totp-uri`, `/two-factor/generate-backup-codes`, `/api/auth/token`, Bull Board, route có `@PlatformStaffAction()`) đòi step-up **TOTP** trong session, không cũ hơn `AUTH_SESSION_FRESH_AGE_SEC`; thiếu → `403 second_factor_required`. Step-up bị lockout theo user (`AUTH_LOCKOUT_*`), mọi lần thử đều đếm. Mã TOTP dùng lại trong cùng cửa sổ 30 s vẫn được Better Auth nhận (hành vi thư viện).
- Nhân viên không tự tắt 2FA (`disable` → `403`), không đổi/đặt lại mật khẩu qua HTTP khi chưa có factor, admin cuối cùng không tự bỏ role admin (`409 last_platform_admin`).
- **Runbook — reset 2FA nhân viên / nâng user thành nhân viên** (đường nâng quyền duy nhất được hỗ trợ): trong terminal tương tác, `docker compose run --rm api pnpm identity:staff-2fa-reset --user-id <uuid chữ thường> --ticket <id> [--for-promotion] [--password-file <path>]`. Lệnh in trạng thái, đòi gõ lại email, ghi mọi thay đổi trong MỘT transaction (mật khẩu tạm, xoá factor, dấu, session, liên kết IdP, API key Better Auth ở chế độ reset, bộ đếm lockout; marker `operator_reset` kèm ticket gửi thư cho chủ tài khoản), rồi giao mật khẩu tạm một lần. Exit `0` xong; `1` DB không đổi; `2` DB đã đổi nhưng mật khẩu chưa giao hoặc phát hiện đua — **chạy lại đúng lệnh** và coi là sự cố. Nhân viên: đăng nhập bằng mật khẩu tạm → `enable` + `verify-totp` → step-up → đổi mật khẩu.
- Route admin của module bạn viết: đánh `@PlatformStaffAction()` (export từ `src/modules/identity/index.ts`), cài `PlatformAccessAudit` nếu cần sổ truy cập, và chạy `describePlatformStaffActionConformance` (`test/support/platform-staff-action.conformance.ts`) cho mỗi route.
- Participant xoá cứng: `order` phải duy nhất trong `[0, 1000)` (boot fail khi trùng).
```

- [ ] **Step 2: ADR và spec cha**

- `docs/adr/0005-multi-tenant-rls.md` — mục "Cập nhật SP3 (3D)": bốn bảng tenant mới (FORCE RLS, policy `TO app_user`, policy `definer_read`), hai hàm definer (`tenancy_find_org_api_key`, `tenancy_grantee_open_grant_orgs`), hai constraint trigger hoãn `SECURITY DEFINER` tuần tự hoá bằng `pg_advisory_xact_lock(public.tenancy_org_lock_key(org))` và đòi `READ COMMITTED` (vì trigger quyền caller mù khi caller đổi `app.org_id` giữa transaction).
- `docs/adr/0007-http-conventions.md` — mục "Cập nhật SP3 (3D)": `403 api_key_not_allowed_here` (thuộc identity, hai guard trả cùng mã), `403 second_factor_required`, `409 last_platform_admin`; route tạo org key không `@Idempotent()` (secret); tám route thu hẹp (`NARROWING_ROUTES`).
- `docs/adr/0010-better-auth-and-auth-modes.md` — mục "Cập nhật SP3 (3D)": step-up trong session (`auth.session_second_factor`, FK `CASCADE` theo factor và session), gate theo tiền tố `/admin/`, lớp chặn trước câu ghi + hàng rào sau ghi cho nhân viên chưa có factor, lệnh CLI reset, `hasAdminRole` khớp plugin (không `trim`), `sessionId` nội bộ của `AUTHENTICATED`; kết quả spike T7 ở ADR 0017.
- `docs/adr/0017-tenancy-own-module.md` — mục "Cập nhật 3D" (sau mục kết quả spike của Task 2): org key là bảng riêng của tenancy, chạy ở cả ba mode; support grant thay plugin organization; quyền hiệu lực tính mỗi request, cắt tới điểm bất động, key orphan bỏ qua.
- `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md` — áp dòng A7 của `2026-09-28-sp3-parent-spec-amendments.md` (§11 `AUTH_MODE`, câu "Service principal và API key theo org thuộc SP3." → văn bản cột "Sau" của A7), và bỏ mọi nhãn `(3D)` (đúng 6 chỗ hôm nay) — văn bản giữ nguyên, chỉ xoá nhãn.

Run:
```bash
grep -c "(3D)" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
grep -n "Service principal và API key theo org thuộc SP3" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
```
Expected: `0` và không dòng nào.

- [ ] **Step 3: Commit**

```bash
git add docs/boilerplate/README.md docs/adr docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
git commit -m "docs: org API keys, support grants, staff step-up and the reset runbook; ADR updates; apply A7 and drop the (3D) labels"
```

---

### Task 30: Kiểm chứng toàn nhánh — sẵn sàng cho PR (controller push và mở PR)

**Files:** không sửa file nào ngoài các lỗi mà bước kiểm phát hiện (mỗi lỗi sửa ở task gốc của nó, commit riêng).

- [ ] **Step 1: Rebase lên `main` mới nhất và kiểm timestamp migration**

Run:
```bash
git fetch origin
git rebase origin/main
ls src/migrations/identity src/migrations/tenancy src/migrations/notifications | tail -n 20
pnpm vitest run --project integration test/integration/core/database/migration-order.spec.ts
```
Expected: rebase sạch (xung đột văn bản với plan khác merge trong lúc làm: giải và chạy lại toàn bộ bước dưới); bốn migration 3D có timestamp lớn hơn mọi migration trên `main` ở cùng vùng; nếu không, sinh lại bằng CLI (`migration:create --blank`), chép nội dung, xoá file cũ, chạy lại test của task gốc.

- [ ] **Step 2: Toàn bộ kiểm tĩnh**

Run:
```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm arch
pnpm vitest run --project unit
node tools/upstream/check.mjs --self
git diff origin/main --stat -- package.json pnpm-lock.yaml .upstream/zones.json
```
Expected: mọi lệnh xanh; `hardcode-scan.spec.ts` và `rules.spec.ts` trong project unit xanh; `upstream:check --self` xanh (mọi file mới nằm dưới tiền tố đã phân vùng); diff của `package.json`, `pnpm-lock.yaml`, `.upstream/zones.json` rỗng (3D không thêm package, không sửa zones).

- [ ] **Step 3: Toàn bộ test có DB, chaos, prod-like**

Run:
```bash
pnpm vitest run --project integration
pnpm vitest run --project e2e
pnpm test:chaos
pnpm test:smoke
```
Expected: mọi project xanh; smoke như Task 28 (log sạch, `/health/ready` 200, `down -v`). Ghi lại thời gian chạy của e2e và chaos để so với `main` (3D thêm khoảng 15 file e2e).

- [ ] **Step 4: Rà diff lần cuối**

Run:
```bash
git log --oneline origin/main..HEAD
git diff origin/main --stat
grep -rn "TODO\|FIXME\|it.only\|describe.only\|as any\|eslint-disable" $(git diff origin/main --name-only -- src test) || true
```
Expected: mỗi task có ít nhất một commit conventional; không `TODO`/`.only`/`as any`/`eslint-disable` mới; không file spike (`test/integration/spike-sp3d/`) nào được track.

- [ ] **Step 5: Sẵn sàng cho PR**

Nhánh `sp3d-delegation` đã rebase lên `origin/main`, mọi kiểm ở Step 1–4 xanh trên máy local. **Dừng ở đây**: không push, không mở PR — controller push nhánh, mở PR "SP3 3D: delegation (org API keys, support grants, staff step-up)" và chờ mọi job CI xanh (socket/timing test chạy trên Linux CI).

---

## Chỗ đụng code của plan trước và lệch có chủ đích

**Code của 3A/3B/3C mà 3D sửa (spec §22.3 Bảng 5, cột "3D sửa"):** `principal.ts` (`ORG_API_KEY`, `orgId`), `credential-detector.ts`, `auth.guard.ts`, `auth-facts.ts`, `auth-hooks.ts`, `auth-instance.ts`, `auth-request-state.ts`, `login-lockout.ts`, `identity-directory.ts` (bỏ `trim`), `platform-admin.authorizer.ts` (Task 3–12); `org-context.middleware.ts` (nhánh key, nhánh support, `via` thật trong metric/span), `member-admission.ts`, `member.service.ts`, `user-deletion.service.ts`, `org-lifecycle.service.ts`, `actor-reauthorizer.ts` (`userActor` fail loud), `org-purge-participant.registry.ts` (`order` duy nhất), `tenancy-features.ts` (cờ thứ ba), `policy-metadata.ts` (`NARROWING_ROUTES` đủ 8), `org-purge.sql.ts` (4 câu đầu) (Task 14–24); test support `tenancy-seed.ts`, `tenancy-principals.ts`, `tenancy-catalog.ts` (hằng `*_3D` cạnh hằng 3C, không sửa hằng cũ), `catalogue-migration.ts`, `identity-app.ts`; ma trận G-6; mọi test SP2/3A/3C gọi `/admin/*`, Bull Board, `/token` chuyển sang nhân viên đã step-up TOTP (Task 7 Step 7, Task 13).

**Lệch có chủ đích (mỗi dòng có lý do ở task):**
1. `API_KEY_NOT_ALLOWED_HERE` thuộc `IdentityErrors` (spec §15 ghi cột "Chủ" là tenancy) — hai `APP_GUARD` cùng trả mã này, thứ tự giữa chúng không bảo đảm (File Structure).
2. `PlatformAdminAuthorizer`/`PlatformStaffGuard` không gọi `getSession` lần hai; `sessionId` đi theo `AuthResult` (File Structure).
3. Không có port `DelegationAccessReader`; câu đọc của middleware là phương thức của hai repository (File Structure).
4. Mốc `revoked_at`, `first_used_at` ghi bằng `clock_timestamp()` (spec §9.7 (6), §7.1 bước 3.10 viết `now()`): ghi sau khi chờ khoá org (bài học final review 3C).
5. Subscriber `tenancy.notify-owners` là ba consumer `tenancy.notify-owners.granted|used|revoked` dùng chung `OwnerNotifier`: `@EventSubscriber` nhận đúng một `type@version` (Task 23).
6. Template `support-access-notice` dùng `{{kind}}` làm động từ trong câu (renderer không có helper so sánh); biến vẫn đúng tên `kind` của spec (Task 23).
7. `describePlatformStaffActionConformance` có tham số thứ ba tuỳ chọn `opts` (module chứa route, bộ đếm handler) ngoài chữ ký hai tham số của addendum A5 (Task 26).
8. Migration catalogue thu hẹp cả key/grant đã thu hồi (version + event): trigger trạng thái cuối chỉ khoá `revoked_at`/`first_used_at`, và hồ sơ audit phải khớp dữ liệu (Task 25).
9. Độ tươi của dấu step-up cho support grant so hai giờ của DB (`verified_at` ghi bằng `now()` của pool auth, `clock_timestamp()` đọc trong transaction đọc của pool app), không dùng đồng hồ của process (Task 22).

---

## Self-review

### 1. Phủ spec (§22.3 Bảng 1 và Bảng 3, dòng 3D; addendum A7)

| Hạng mục spec | Task | Test |
|---|---|---|
| Spike T7 (a)–(h), ADR 0017 "Kết quả spike (plan 3D)" | 1, 2 | spike (không commit) + ADR |
| `CREDENTIAL_KINDS` + `ORG_API_KEY`, `DetectedCredentialKind`, `@SessionOnly` từ chối org key, `sessionId` nội bộ | 4 | `auth-guard-proof.spec.ts`, `better-auth-provider.spec.ts` |
| `hasAdminRole` không `trim` + tương đương `userHasPermission`, cấu hình plugin `admin` (R8-S3) | 4 | `admin-role-equivalence`, `admin-plugin-config` |
| Migration `…_session_second_factor`, `AUTH_TABLES`, grant `auth_user` | 3 | `session-second-factor-schema`, `rls-catalog` |
| Step-up trong session, lockout consume trước, `method`, `AuthFacts.secondFactorVerifiedAt()` (S-12 nhánh tạo dấu, S-19, S-20) | 5, 6 | `step-up.e2e`, `staff-step-up` |
| Gate quyền nền tảng (get-totp-uri, generate-backup-codes, `/admin/*`, `/token`, Bull Board), `disable` chặn, `twoFactorEnabled` (S-18, S-21), id chữ thường, `last_platform_admin` (S-25) | 7 | `staff-gate.e2e`, `queue-dashboard-access.e2e` |
| Luật (7) ba lớp, `resetPasswordToken`, drift `password.mjs` | 8 | `password-write-guard`, `reset-password-token`, `password-route-drift` |
| Hàng rào sau ghi (9) (T-42, T-43) | 9 | `staff-credential-fence(-idp)` |
| Migration `…_security_notice_operator_reset` + `down` (ca thư `PENDING`, hai kết nối), template `operatorReset` | 10 | `security-notice-operator-reset`, `auth-schema` |
| Lệnh `identity:staff-2fa-reset` (S-22, S-24, mã thoát, pool đóng) | 11 | `staff-2fa-reset(-races)`, `staff-2fa-reset-args` |
| `@PlatformStaffAction()`, `PlatformStaffGuard`, `PlatformAccessAudit` (PSA-1, PSA-2, PSA-5, PSA-9) | 12 | `staff-access`, `platform-staff-action`, `platform-staff-di` |
| §5.3 phần 3D: test SP2 gọi `/admin/*`/Bull Board/`/token`, `dashboard.smoke` | 7, 13 | file liệt kê ở Task 7 Step 7, smoke |
| Migration `…_delegation`: 4 bảng, RLS, guard, closure, hai trigger definer, hai hàm definer, `down` | 14 | `delegation-db`, `-isolation`, `-definer`, `-down`, `rls-catalog`, `normalization-inventory` |
| §18.1: ràng buộc 4 bảng, X-12 (T-19 ×50, đổi context trước COMMIT) | 15 | `delegation-db.spec.ts` |
| Config 5 env, cờ support (U17), lỗi, event, metric, `order` duy nhất (PSA-8) | 16 | `tenancy-features`, `tenancy-config`, `registries`, `event-flags` |
| §8.5 quyền hiệu lực, preset, U16 | 17, 18 | `delegation.spec`, `delegation-repositories` |
| §10 org key: K-1, K-2, K-3, K-8, K-12, K-15, K-16, B-22/B-24 (key), T-11 | 19 | `org-api-keys.e2e` |
| §7.1 bước 2, 3.6: K-4, K-5, K-7, K-10, K-13, K-14, B-17, limiter với org key, org key trên `/v1/me` | 20 | `org-api-key-auth.e2e`, `org-api-key-confinement` |
| §9.7 cấp/thu hồi: S-1, S-2, S-3, S-8, S-13, S-14, T-20, cờ tắt | 21 | `support-grants.e2e` |
| §7.1 bước 3.7, 3.10: S-4–S-7, S-9–S-12, S-16, S-17, T-15, T-35 | 22 | `support-access.e2e` |
| Template `support-access-notice`, `notify-owners`, `PlatformRoleChangeListener` (S-23, T-40) | 23 | `support-role-change.e2e`, `support-templates-down`, `templates.spec` |
| Vòng đời: K-6, S-15, xoá mềm (tiêu chí 8), T-19 đường app, T-31 | 24 | `delegation-lifecycle.e2e`, `delegation-races.e2e` |
| K-9, K-17 (key, grant), K-9b/K-9c chạy lại, R-X23 orphan, G-6 cột key + support, K-11, ba mode | 25 | `delegation-catalogue-migration`, `catalogue-data-migration`, `delegation-orphans.e2e`, `role-route-matrix.e2e`, `auth-modes.e2e` |
| Addendum A5: conformance C1–C10 (PSA-3, PSA-6, PSA-7) | 26 | `platform-staff-action.e2e` |
| Tiêu chí 12 (DB lỗi → 503 trên mọi đường mới), C11/PSA-4, tiêu chí 11 (giết process) | 27 | `delegation-outages`, `delegation-api-kill` |
| Smoke 3D (org key → xoá mềm → 401; nhân viên step-up dùng grant), đo image, ADR 0013 "SP3 (cuối)" | 13, 28 | `tenancy.smoke`, `dashboard.smoke` |
| README, ADR 0005/0007/0010/0017, A7, bỏ nhãn `(3D)` | 29 | grep ở Task 29 Step 2 |

Không còn hạng mục nào của dòng 3D thiếu task.

### 2. Race có tên của 3D (spec Bảng 2) → cơ chế → test

| Race | Cơ chế | Test |
|---|---|---|
| T-11 (key) | đếm `countActiveForMember` dưới khoá org, `clock_timestamp()` | Task 19 `T-11 (key)` |
| T-15 | `UPDATE … WHERE first_used_at IS NULL RETURNING` + trigger `first_used_once` | Task 22 `S-11/T-15`, Task 15 |
| T-17 | quyền tính mỗi request, không cache | Task 20 (revoked → 401), Task 22 (S-6) |
| T-19 | app: khoá org + `MemberAdmission` thu hồi trước INSERT; DB: hai constraint trigger definer + advisory lock theo org | Task 15 X-12 ×50, Task 24 đường app ×10 |
| T-20 | partial `UNIQUE` + khoá org + thu hồi grant cũ trong cùng transaction | Task 21 `T-20` (tuần tự + song song) |
| T-30 | phạm vi ∩ role HIỆN TẠI của người tạo mỗi request | Task 20 `K-4/K-5/T-30` |
| T-31 | xoá mềm thu hồi key dưới khoá org | Task 20 (K-13), Task 24 (tiêu chí 8) |
| T-35 | FK `two_factor_id … CASCADE` | Task 22 `S-10/T-35`, Task 3 |
| T-37 | `factorId` chụp ở `before`, `INSERT … SELECT … tf.id = $factorId` + FK | Task 5, 6, S-19, S-24 (Task 11) |
| T-38 | lockout consume trước (upsert nguyên tử) | Task 6 S-20 |
| T-39 | gate chỉ dựa vào dấu; handler tự đọc lại session/factor | Task 7 (integration gate với session đã xoá) |
| T-40 | mọi lần ghi role thu hồi; grant sót vô dụng (middleware đòi `isPlatformAdmin`) | Task 23 `T-40` ×50 |
| T-41 | chấp nhận có tên (không khoá), lối ra là lệnh reset `--for-promotion` | Task 7 S-25 (tuần tự) |
| T-42 | xoá token trong transaction lệnh + lớp chặn trước câu ghi + hàng rào sau ghi | Task 8, 9, 11 |
| T-43 | hàng rào (9) trên session/account/API key | Task 9, Task 11 races |

### 3. Quét placeholder

Đã quét `TBD`, `TODO`, `implement later`, `fill in`, `similar to Task`, `add appropriate`: không còn. `<ts>` là timestamp CLI sinh lúc chạy (luật ở Global Constraints); ba ô `<…>` của bảng ADR 0013 ở Task 28 là số đo lúc chạy, có lệnh đo và nguồn số đối chiếu.

### 4. Nhất quán kiểu và tên

- `OrgApiKeyRepository` (Task 18) ↔ `OrgApiKeyService` (Task 19), `OrgApiKeyAuthenticator`, middleware (Task 20), `DelegationRevocations` (Task 21, 24): `findByTokenHash`, `findActiveForAccess`, `insert({ … expiresInSec })`, `countActiveForMember`, `lockByPublicId`, `revoke`, `revokeAll`, `unrevokedOfMember`, `list({ memberId })`, `countUpTo(memberId, cap)` — khớp.
- `SupportGrantRepository` ↔ `SupportGrantService`, middleware, listener: `insert`, `revokeOpenForGrantee`, `findOpenForAccess(authUserId)`, `markFirstUse`, `granteeOpenGrantOrgs(userId)` — khớp; `OpenGrantAccess.granterSystemKey` dùng ở Task 22.
- `checkDelegatedScope`/`ScopeCheck`/`scopeOrThrow`; `effectiveDelegation` → `DelegatedPermissions.forApiKey/forSupportGrant` — khớp.
- `EscalationRule` thêm `'delegation'` (Task 16) trước khi `scopeOrThrow` dùng (Task 19).
- Event: tên trường `apiKeyId`, `grantId`, `granteeUserId`, `grantedByMemberId`, `permissions`, `expiresAt`, `reason` giống nhau ở Task 16 (schema), 19, 21, 22, 23, 24, 25 (SQL dựng payload `apiKeyId`/`grantId` + `permissions`).
- Helper test: `seedOrgApiKey(org, { createdByMemberId, permissions, expiresInSec?, revoked? })`, `seedSupportGrant(org, { grantee, grantedByMemberId, permissions, … })`, `apiKeyEligibleKeys`, `supportPresetKeys` (Task 15) dùng đúng chữ ký ở Task 18–28; `seedStaffPrincipal(opts)` (Task 7) với `mark`, `method`, `markAgeSec` ở Task 22, 26.
- `OrgAccessResult` thêm `'second_factor_required'` ở Task 20 trước khi Task 22 dùng.

### 5. Phán quyết trên chỗ spec mơ hồ (phán quyết — vì sao — giá nếu sai)

1. Ba consumer cho `notify-owners` — decorator nhận một event — đổi tên consumer sau này làm Inbox coi event cũ là chưa xử lý (thư trùng một lần).
2. Vượt người tạo khi tạo key → `403 escalation_denied`, metric `rule="delegation"` (spec K-1 chỉ ghi `403`) — cùng mã luật 1/2/4 theo §15 — client phân biệt bằng `fields`, không bằng mã.
3. `revoked_at`/`first_used_at` dùng `clock_timestamp()` — bài học 3C — nếu sai chỉ lệch mốc vài ms so với `now()` của spec.
4. Grant bị thu hồi lúc xoá mềm không có event/thư (§14.1 "tenancy.org.deleted hàm ý tất cả") — owner đã tự xoá org — nếu Sếp muốn thư revoked thì thêm một vòng `publishGrantRevoked` trong `revokeAllOfOrg`.
5. Hai cột G-6 mới chấp nhận `403` mọi mã (org key ở route `@SessionOnly` nhận `api_key_not_allowed_here` trước `PoliciesGuard`) — thứ tự APP_GUARD vs guard route là cố định của Nest — nếu sai, ô có thể đỏ giả vì mã khác, không lọt.

### 6. Hạng mục chưa đặt / ngoài phạm vi

Không có. Service principal (spec A7 "cài đặt ở SP sau"), audit + phê duyệt hai người cho platform admin (SP6) và domain join (S3-Q4 C) nằm ngoài 3D theo spec §19.

### 7. Giả định yếu nhất và cách kiểm

1. **Kết quả spike T7 (g)/(h)** — `databaseHooks.account.*.before` thấy request state qua `runWithRequestState` trên cả ba path ghi mật khẩu, và các hook `*.after` chạy sau câu ghi trong cùng request. Task 8, 9, 11 dựa hoàn toàn vào đó. Kiểm: Task 2 chạy thật trên better-auth 1.7.6; không đạt (h) ở bất kỳ điểm nào → dừng 3D và báo Sếp (Global Constraints).
2. **Seam race của lệnh reset** (`overrideProvider(AuthRequestState)` với `GatedState`) chặn đúng giữa hook `before` và câu ghi: nếu Better Auth đọc state ở chỗ khác, race test R8-S1 có thể xanh giả. Kiểm: mỗi race test của Task 11 có assertion "seam đã chạm" (`waitBlockedBy(pid)`) trước khi thả.
3. **Chi phí trigger hoãn definer trên mọi `INSERT org_members`** (advisory lock theo org + một câu đọc grant theo index `(org_id, grantee_user_id)`): plan không có test đo riêng. Kiểm: Task 30 Step 3 chạy lại `member-races.e2e.spec.ts` (X-5, 20 mutation đồng thời) và so thời gian e2e với `main`; tăng rõ thì đo bằng `EXPLAIN (ANALYZE, BUFFERS)` trước khi merge.

### 8. Review Focus → test

| # | Test | Task |
|---|---|---|
| 1 | `Review Focus 1: malformed and case-mangled oak_ keys are a plain 401` (+ unit `any string hashes to 32 bytes`) | 20 (+17) |
| 2 | `Review Focus 2: scope duplicates, order, empty, unknown; TTL boundaries`; `Review Focus 2 (grant): …` | 19, 21 |
| 3 | `Review Focus 3 / S-15: a grantee who becomes a member is served as a member` (+ `Review Focus 3 (pre-check)`) | 24 (+22) |
| 4 | `no mark: … a malformed code (Review Focus 4)`, `right codes are counted too` | 6 |
| 5 | `Review Focus 5: --user-id must be a canonical lowercase UUID` | 11 |

