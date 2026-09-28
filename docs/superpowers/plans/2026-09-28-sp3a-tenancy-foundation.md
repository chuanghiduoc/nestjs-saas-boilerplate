# Sub-project 3A — Tenancy nền (tenancy foundation): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm `src/modules/tenancy` phần nền của SP3 (org, member, role hệ thống, catalogue quyền 19 key, CASL `Ability` trần, pipeline `OrgContextMiddleware` → `PoliciesGuard` → `OrgScopeInterceptor`, vòng đời org xoá mềm/khôi phục/xoá cứng, bảo vệ owner cuối kể cả khi xoá tài khoản) cùng các thay đổi tối thiểu ở `core/`, `modules/identity`, `modules/notifications` mà plan 3A sở hữu, chứng minh bằng test trên Postgres 18 + PgBouncer + Redis + Mailpit thật và bằng smoke chạy image production qua `docker compose --profile app` với `NODE_ENV=production`; 3A ship một mình với CI xanh.

**Architecture:** Tenancy là module tự xây (ADR 0017) trong schema `public`: 6 bảng mới (`tenancy_users`, `permissions`, `permission_requires`, `organizations`, `org_roles`, `org_members`), RLS FORCE với policy `TO app_user`, FK kép, trigger hoãn giữ bất biến owner, 6 hàm `SECURITY DEFINER` chỉ đọc do role NOLOGIN `tenancy_definer` sở hữu. Org lấy từ path `/v1/orgs/{orgId}`; `OrgContextMiddleware` (sau `PrincipalResolver.ensure` idempotent của identity, trước throttler) tra membership trong `OrgScope`, trả `404` thống nhất và đếm lần trượt thật vào bucket `tenancy.org-miss` của `RateLimitBuckets`; `PoliciesGuard` route-scoped dựng CASL `Ability` trần từ quyền hiệu lực; `OrgScopeInterceptor` bọc handler. Mọi mutation quản trị khoá dòng org `FOR NO KEY UPDATE`, đọc lại actor, kiểm lại cửa và trần, ghi outbox cùng transaction. Identity mở `PrincipalResolver`, `AuthFacts`, hai decorator, port `UserDeletionGuard` (`@Global` + `@Optional`) cho tenancy cắm vào; core mở `RateLimitBuckets`, `orgAccess`, `JobDef.onInactiveOrg` + port `OrgActivityGate`, `scheduled_tasks.suspended_at`.

**Tech Stack:** NestJS 12.1 (ESM, Express 5.2.1), `@casl/ability` 7.0.1 (package mới duy nhất), MikroORM 7.2.1 (`Db.execute`, `UnitOfWork`, `OrgScope`), better-auth 1.7.6, rate-limiter-flexible 11.2.1, BullMQ, zod 4.6.5, uuid 14.0.2 (`v7`), Vitest + Testcontainers, Toxiproxy/`tcp-proxy.ts`, Docker Compose smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md` (r8, đã chốt; mục 22.3 chia plan, Bảng 1–5 là nguồn phạm vi của plan này). Kèm theo, cùng ràng buộc: `docs/superpowers/specs/2026-09-28-sp3-parent-spec-amendments.md` (chỉ áp các dòng cột Plan = `3A`/`3A+`), `docs/adr/0017-tenancy-own-module.md`, spec cha `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`. Mẫu định dạng: `docs/superpowers/plans/2026-09-27-sp2-identity-notifications.md`.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1 và SP2 (Global Constraints của `2026-09-27-sp2-identity-notifications.md`), cộng các luật của SP3 (spec §3, bắt buộc cho mọi task):

- **Package-first:** chỉ cài `@casl/ability` (`pnpm view @casl/ability dist-tags peerDependencies`, rồi `pnpm add @casl/ability` không ghi version; mong đợi `7.0.1`). Không cài `nest-casl`, `@ucast/sql`, `casbin`, SDK FGA, `fast-check`. Token và hash dùng `node:crypto`. Lệnh cài ra version khác thì dừng, đọc changelog, cập nhật spec, báo Sếp.
- **Generator:** `nest g module|controller|service|guard|interceptor|middleware <path> --no-spec` cho khung Nest; `pnpm exec mikro-orm migration:create --blank --path src/migrations/<module> --name <tên>` cho migration. Tên file migration do CLI sinh (`Migration<14 chữ số>_<tên>`); plan viết `Migration<ts>_<tên>`, code và test không bao giờ viết cứng timestamp (tìm migration theo hậu tố tên).
- **Không đoán API:** CASL theo spec §8.7 (đã đối chiếu `.d.ts` của tarball 7.0.1: `new Ability(rules, { anyAction, anySubjectType })`, `ForbiddenError.from(ability).throwUnlessCan(action, subject)`). Option nào khác thì đọc `.d.ts` trước. TDD, không `any`, không tắt lint, không `as never`.
- **Bất biến nằm ở DB:** mọi bất biến biểu diễn được bằng `CHECK`, `UNIQUE`, partial `UNIQUE`, `FOREIGN KEY`, trigger (kể cả `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`) thì nằm ở DB; kiểm ở app chỉ để trả lỗi đẹp. Vi phạm từ trigger: `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = '<tên>'`, map bằng `defineConstraintErrors` sẵn có.
- **Kiểu dữ liệu:** PK `BIGINT GENERATED ALWAYS AS IDENTITY` + `public_id UUID DEFAULT uuidv7()`; ngoại lệ duy nhất `organizations.id UUID` v7 sinh ở app (S3-A1). Thời gian `TIMESTAMPTZ`. Enum `TEXT` + `CHECK`. Mọi bảng có `created_at`/`updated_at`.
- **FK có chủ đích:** mặc định `RESTRICT`; không `CASCADE` từ `organizations` (xoá cứng xoá con tường minh theo thứ tự, spec §9.5); `SET NULL` chỉ cho `organizations.created_by_user_id`.
- **Mọi index gắn với một query** (ghi trong chú thích migration); index của bảng tenant bắt đầu bằng `org_id`, trừ index phục vụ hàm definer quét nhiều org hoặc FK từ bảng global (ghi lý do).
- **Migration:** SQL bằng `addSql`, `down` **đối xứng** đã test (up → down → up và sweep từng bước S2-R57 trên **database riêng**), xoá cả hàm trigger; grant theo bảng/cột, không `ALTER DEFAULT PRIVILEGES`; mọi DDL trên hàm definer nằm giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE`; mọi đọc/ghi dữ liệu trên bảng `FORCE ROW LEVEL SECURITY` trong migration theo mẫu `NO FORCE … FORCE` + khối khẳng định FORCE; không `isTransactional()`; không `SET CONSTRAINTS ALL`. Mọi migration SP3 có timestamp sau `Migration20260927163904_better_auth_schema` và sau migration mới nhất trên `main`.
- **Chuẩn hoá (≥ 3NF, ưu tiên BCNF):** mỗi migration tạo/sửa bảng chép bảng chuẩn hoá của spec §6.12 (khoá ứng viên, phụ thuộc hàm, dạng chuẩn, ngoại lệ E1 + cơ chế giữ nhất quán) vào chú thích đầu file; `normalization-inventory.spec.ts` so cột thật với danh sách đã phân tích.
- **Mọi race có tên và cơ chế chặn** (spec §17; bảng race của 3A ở cuối plan). Check-then-insert không bao giờ là cơ chế. Khoá dòng: `FOR NO KEY UPDATE`, không bao giờ `FOR UPDATE`; thứ tự khoá cố định `organizations` → `tenancy_users` → `org_roles` → `org_members` (id tăng dần). So sánh hết hạn sau khi chờ khoá dùng `clock_timestamp()`.
- **Không hard code:** giới hạn, thời hạn, cron, batch lấy từ `tenancy.config.ts` (`defineConfig` + zod, `.describe()`); hằng định dạng là hằng có tên dùng chung giữa zod và `CHECK` (`ORG_NAME_MAX_LENGTH = 100`, `DEFINER_LIMIT_MAX = 1000`, `PURGE_CURSOR_START`, `ORG_API_KEY_PREFIX = 'oak_'`). `test/unit/architecture/hardcode-scan.spec.ts` phải xanh.
- **Fail loud:** thiếu metadata phân quyền, catalogue lệch DB, route tenant tới guard mà không có `orgAccess`, key không có trong catalogue, hàm definer nhận `NULL`/tham số ngoài biên đều ném lỗi có log.
- **Truy cập SQL:** tenancy chỉ qua `Db.execute` (placeholder `?`) trên EM đang gắn; không import `@mikro-orm` ngoài `infra/`. Không I/O ngoài (Redis, SMTP, HTTP) bên trong `UnitOfWork.run`: gỡ scheduler Redis gọi **sau** commit.
- **Luật kiến trúc** (`.dependency-cruiser.cjs`, mỗi luật có fixture phải fail): giữ luật 1–16; thêm 17 (`@casl/ability` chỉ trong `src/modules/tenancy/application/authz/**` và `src/modules/tenancy/http/**`), 18 (`modules/identity/**`, `modules/notifications/**` không import `modules/tenancy/**`), 19 (`TenancyTestHooks` không được import từ ngoài `src/modules/tenancy/**`).
- **Không PII** trong log/metric/span/failed reason: không email, token, id user làm label; log chỉ `orgId`, `org.access.via`, `org.access.ref` (public id), `userId` là `principal.id` chỉ ở log đã có của identity.
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** cuối mỗi nhóm (Task 8 core + notifications, Task 12 identity, Task 16 schema tenancy + role `tenancy_definer` chạy từ `dist`, Task 26 identity ↔ tenancy khi xoá tài khoản, Task 29 tenancy, Task 31 cuối) chạy `pnpm test:smoke`: build **image production thật** (`docker build` với build-arg từ `docker/images.env`), `docker compose --profile app` với hạ tầng đầy đủ và `NODE_ENV=production`, migrate, smoke HTTP thật trong `test/smoke/`, kiểm log container (JSON, không PII, không `error`) và `/health/ready`, rồi `down -v`. Luật production không bị nới trong code (TLS cục bộ như SP2).
- **Spike:** code spike là code bỏ đi (thư mục `test/integration/spike-sp3a/`, không commit), trừ phần task ghi rõ "được giữ". Kết quả spike ghi vào mục "Kết quả spike (plan 3A)" của ADR 0017 và được commit. Spike không đạt thì đi đúng nhánh fallback của spec §4; spike không có fallback (T5) thì dừng và báo Sếp.
- **Định dạng:** code trong plan viết gọn dòng để đọc; `pnpm lint` có `prettier --check .`, nên trước mỗi commit chạy `pnpm exec prettier --write <file đã đổi ngoài docs/>` (không sửa tay khoảng trắng; `docs/` nằm trong `.prettierignore`).
- **Commit:** mỗi task một commit trở lên, conventional message tiếng Anh. Push và mở PR chỉ ở Task 31 (lệnh của Sếp trong đầu việc của plan này: "push and open one PR for 3A").

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không test nào của spec phủ, dễ làm hỏng trải nghiệm người dùng nhất:

1. **Tên org có ký tự ngoài BMP (emoji, chữ ghép)**: `CHECK (char_length(name) BETWEEN 1 AND 100)` đếm code point, còn `z.string().max(100)` đếm đơn vị UTF-16; nếu zod đếm UTF-16 thì tên 60 emoji hợp lệ ở DB bị API từ chối. Mong đợi: zod đếm code point như DB (100 emoji → `201`, 101 emoji → `422 validation_failed`), khoảng trắng đầu/cuối (kể cả NBSP, tab) → `422`, không bao giờ `500`. Test: Task 18 (`orgName` unit), Task 23 (`org names are measured in code points like the DB CHECK`).
2. **Principal chưa từng chạm tenancy** (user mới đăng ký, không có dòng `tenancy_users`) gọi một route tenant hoặc `GET /v1/orgs`: câu đường nóng có subquery `(SELECT id FROM u)` rỗng. Mong đợi: route tenant → `404` thống nhất, `GET /v1/orgs` → trang rỗng `200`, và **không** tạo dòng `tenancy_users` (dòng chỉ tạo lười khi tạo org). Test: Task 22 (`a principal that never touched tenancy gets the uniform 404 and no tenancy_users row`), Task 23 (`GET /v1/orgs is an empty page for a new principal`).
3. **`GET /v1/orgs?includeDeleted=true` của member không phải owner**: org xoá mềm chỉ hiện với owner (spec §6.14). Mong đợi: member thường không thấy org đã xoá mềm dù truyền cờ, owner thấy kèm `deletedAt`/`purgeAfter`, `totalCount` khớp đúng tập được trả. Test: Task 23 (`includeDeleted lists soft-deleted orgs to owners only and the count matches`).
4. **`If-Match` ở mọi dạng** trên `PATCH /v1/orgs/{orgId}` và `PATCH …/members/{memberId}`: thiếu → `428`, `W/"n"`, `"n"`, `*` → `200`, cũ → `412`; hai request song song cùng ETag → đúng một `200`, một `412` (khoá org rồi so version dưới khoá). Test: Task 23 (`If-Match on PATCH: missing 428, W/"n", "n" and * accepted, stale 412`, `concurrent renames with the same ETag: one 200, one 412`), Task 24 (`member role change honours If-Match`).
5. **UUID hợp lệ về cú pháp nhưng không phải v7 hoặc là UUID nil** ở path (`/v1/orgs/00000000-0000-0000-0000-000000000000`, UUID v4): không có org nào như vậy (CHECK `uuid_extract_version(id) = 7`). Mong đợi: `404` thống nhất giống org không tồn tại (không `400`, không `500`), và body `POST /v1/orgs` có trường `id` bị bỏ qua (client không chọn được id org). Test: Task 22 (`404 is identical for a missing org, a non-member, a soft-deleted org, nil and v4 ids …`), Task 23 (`POST /v1/orgs → 201 + Location + ETag …`: id `00000000-0000-7000-8000-000000000000` trong body bị bỏ qua).

---

## File Structure

```
src/
  app.modules.ts                     bật TenancyModule.forApi()/forWorker() sau identity + notifications
                                     (composition.config.ts không đổi: luật production của tenancy nằm trong tenancy.config.ts)
  core/
    context/     org-access.ts (mới: OrgAccess) · context.keys.ts (+orgAccess) · request-context.ts (+orgAccess/setOrgAccess) · index.ts
    logging/     logging.module.ts (contextLogFields + org.access.via/ref)
    http/        rate-limit-buckets.ts (mới) · rate-limiter.storage.ts (+peek) · pre-auth-rate-limiter.ts (viết lại trên bucket)
                 http.module.ts · index.ts
    queue/       org-activity-gate.ts (mới) · job-definition.ts (+onInactiveOrg) · worker-host.ts (gate) · index.ts
    observability/ queue-metrics.ts (+queue_jobs_skipped_total)
    outbox/      outbox.jobs.ts (core.event.dispatch: 'run')
    events/      event-dispatch.handlers.ts (core.event.deliver: 'run')
    scheduler/   scheduled-task.service.ts (+suspend/resume/remove/sync) · schedule-reconciler.ts (suspended_at)
    database/    index.ts (export pgFields)
  migrations/
    core/          Migration<ts>_scheduled_tasks_suspended_at.ts
    notifications/ Migration<ts>_email_templates_lookup.ts
    tenancy/       Migration<ts>_tenancy_core.ts · Migration<ts>_scheduled_tasks_org_link.ts
  modules/identity/
    index.ts · errors.ts (+USER_DELETION_BLOCKED) · identity.config.ts (+AUTH_DIRECTORY_BATCH_MAX) · identity.module.ts
    ports/   auth-provider.ts (+authenticatedAt/emailVerified/verifiedEmail) · identity-directory.ts (+findUsers)
             org-credential-authenticator.ts (mới) · user-deletion-guard.ts (mới)
    http/    principal-resolver.ts (mới) · principal.middleware.ts · identity-request.module.ts (mới, @Global)
             auth-facts.ts (mới) · fresh-session.decorator.ts (mới) · auth.guard.ts
    infra/better-auth/ auth-hooks.ts (xoá user, adminTargetUserId, prefix oak_) · auth-options.ts (delete.before, onError 23001)
             auth-db-failures.ts (+path của mount) · auth-mount.middleware.ts · auth-error.mapper.ts · auth-instance.ts
             better-auth-core.module.ts · better-auth.provider.ts · pg-identity-directory.ts
    infra/jwks/ jwks.provider.ts (auth_time)
  modules/notifications/ jobs.ts (send-email: 'run') · templates.ts (chú thích bảng tra cứu)
  modules/tenancy/
    index.ts · tenancy.module.ts · tenancy.config.ts · errors.ts · events.ts · jobs.ts · permissions.ts · constants.ts
    tenancy-telemetry.ts
    domain/        tenancy-catalogue.ts · catalogue.ts · permission-set.ts · system-roles.ts · escalation.ts · organization.ts
    application/   authz/ability.factory.ts · authz/effective-permissions.ts
                   org.service.ts · org-lifecycle.service.ts · member.service.ts · member-admission.ts
                   actor-reauthorizer.ts · escalation-guard.ts · subject-resolver.ts
                   user-deletion.service.ts · purge-orgs.handler.ts · scheduled-tasks.participant.ts
                   catalogue-check.ts · org-route-inventory.ts · permission-catalogue.registry.ts
                   org-purge-participant.registry.ts · org-activity.gate.ts · tenancy-metrics.ts
    ports/         tenancy-user-repository.ts · org-repository.ts · role-repository.ts · member-repository.ts
                   access-reader.ts · catalogue-reader.ts · org-purge-participant.ts · tenancy-test-hooks.ts
    http/          org-route.ts · policy-metadata.ts · decorators.ts · org-context.middleware.ts · policies.guard.ts
                   org-scope.interceptor.ts · tenancy-http.module.ts · schemas.ts
                   orgs.controller.ts · org.controller.ts · members.controller.ts · roles.controller.ts · permissions.controller.ts
    infra/sql/     rows.ts · org-purge.sql.ts · sql-tenancy-user.repository.ts · sql-org.repository.ts · sql-role.repository.ts
                   sql-member.repository.ts · sql-access.reader.ts · sql-catalogue.reader.ts
    infra/identity/ tenancy-identity-ports.module.ts
    infra/queue/   tenancy-queue-ports.module.ts
docker/postgres/init/01-roles.sh     + role tenancy_definer
.dependency-cruiser.cjs              luật 17–19
.github/workflows/ci.yml             checkout fetch-depth 0 cho job checks (migration-order so với main)
test/
  support/  app-factory.ts (+configure, nestedIn) · identity-app.ts (+identityDepth, configure) · tenancy-catalog.ts
            tenancy-seed.ts · tenancy-principals.ts · tenancy-app.ts · tenancy-core-app.ts
            scratch-db.ts (DB riêng qua docker exec)
  fixtures/ migrations/Migration<ts>_fixture_org_items.ts
  architecture/fixtures/src/ fixture phải fail của luật 17–19
  unit/     migrations/migration-scan.spec.ts · migrations/migration-order.spec.ts · core/http/rate-limit-buckets.spec.ts
            modules/tenancy/*.spec.ts · modules/identity/principal-resolver.spec.ts …
  integration/ core/… (sửa) · tenancy/*.spec.ts · identity/user-deletion-hooks.spec.ts
  e2e/tenancy/*.e2e.spec.ts · e2e/identity/user-deletion-without-tenancy.e2e.spec.ts
  chaos/tenancy-outages.spec.ts · chaos/tenancy-purge-kill.spec.ts · chaos/tenancy-api-kill.spec.ts
  smoke/tenancy.smoke.spec.ts
docs/adr/ 0017 (kết quả spike) · 0005 · 0006 · 0007 · 0009 · 0010 · 0013 (dòng "SP3 (3A)")
docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md (áp dòng 3A của amendments)
README.md (mục tenancy)
```

**Vì sao `definePermissionCatalogue` ở `http/decorators.ts`, không ở `domain/catalogue.ts` như sơ đồ spec §5.1:** hàm trả về decorator `require(...)` (gắn `UseGuards(PoliciesGuard)`), mà luật `domain-pure` cấm `domain/` import `http/`. `domain/catalogue.ts` giữ phần thuần (kiểu mục, gộp, kiểm U1–U5); `http/decorators.ts` bọc nó thành catalogue có `require`. Không đổi hợp đồng công khai (`index.ts` vẫn export `definePermissionCatalogue`).

**Vì sao tách `OrgLifecycleService` khỏi `OrgService`:** xoá mềm/khôi phục không phụ thuộc identity (không `AuthFacts`), nên nằm trong `TenancyCoreModule` dùng chung api + worker; test X-10 chạy trên composition `AppWorkerModule` thật gọi được nó (một process chỉ dựng được một app có `DatabaseModule`, `scheduler.spec.ts:95-99`). `OrgService` (tạo, đổi tên, liệt kê) cần `AuthFacts` nên chỉ ở api.

---

## Phần A — Spike (bắt buộc làm trước mọi task khác, spec §4)

Plan 3A chạy T1–T6 và T8 (T7 thuộc 3D). Mỗi spike trả lời đúng một câu hỏi ở spec §4 bằng code chạy thật; kết quả (đạt/không đạt + bằng chứng: lệnh, output rút gọn) ghi vào ADR 0017 mục "Kết quả spike (plan 3A)" và được commit. Code spike nằm ở `test/integration/spike-sp3a/` (chạy bằng project `integration` để có hạ tầng thật), **không commit**, xoá ở bước cuối của task, trừ phần ghi "được giữ".

### Task 1: Cài `@casl/ability`, khung kết quả spike trong ADR 0017, spike T1 (CASL ESM + sentinel), giữ thành test hợp đồng

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `renovate.json`, `docs/adr/0017-tenancy-own-module.md`
- Create (được giữ): `test/unit/modules/tenancy/casl-contract.spec.ts`

**Interfaces:**
- Consumes: không.
- Produces: dependency `@casl/ability` 7.0.1; hằng `NO_WILDCARD = '__no_wildcard__'` được khẳng định hành vi (Task 17 dùng lại cùng giá trị); mục "Kết quả spike (plan 3A)" trong ADR 0017 với dòng T1 đã điền, các dòng T2–T6, T8 chờ Task 2–3 và Task 22.

- [ ] **Step 1: Kiểm version và peer trước khi cài**

Run:
```bash
pnpm view @casl/ability dist-tags peerDependencies dependencies
```
Expected: `latest = 7.0.1`, không có `peerDependencies`, `dependencies = { "@ucast/mongo2js": "^2.0.0" }`. Khác thì **dừng**, ghi output vào ADR 0017 và báo Sếp.

- [ ] **Step 2: Viết test hợp đồng CASL (fail vì package chưa cài)**

`test/unit/modules/tenancy/casl-contract.spec.ts`:
```ts
import * as casl from '@casl/ability';
import { Ability, ForbiddenError } from '@casl/ability';
import { describe, expect, it } from 'vitest';

/** Cùng giá trị với `NO_WILDCARD` của `ability.factory.ts` (Task 17); regex của catalogue bắt đầu bằng [a-z]. */
const SENTINEL = '__no_wildcard__';
const bare = (rules: ConstructorParameters<typeof Ability>[0]) =>
  new Ability<[string, string]>(rules, {
    anyAction: SENTINEL,
    anySubjectType: SENTINEL,
  });

/**
 * Spike T1 của spec SP3 §4, giữ lại làm test hợp đồng: nâng `@casl/ability` mà đổi bất kỳ điều nào dưới đây thì
 * test đỏ trước khi PoliciesGuard âm thầm đổi nghĩa.
 */
describe('@casl/ability 7.0.1 contract (spike T1)', () => {
  it('loads as ESM under SWC with Ability/ForbiddenError and without the removed PureAbility/rulesToQuery', () => {
    expect(typeof casl.Ability).toBe('function');
    expect(typeof casl.ForbiddenError).toBe('function');
    expect('PureAbility' in casl).toBe(false);
    expect('rulesToQuery' in casl).toBe(false);
  });
  it('the sentinel strips the wildcard meaning of manage/all', () => {
    const a = bare([{ action: 'manage', subject: 'all' }]);
    expect(a.can('read', 'org')).toBe(false);
    expect(a.can('manage', 'all')).toBe(true);
  });
  it('without the sentinel manage/all is a live wildcard (why the catalogue bans them)', () => {
    const a = new Ability<[string, string]>([
      { action: 'manage', subject: 'all' },
    ]);
    expect(a.can('read', 'org')).toBe(true);
  });
  it('a rule whose action equals the sentinel is itself a wildcard (why keys must start with [a-z], U12)', () => {
    expect(bare([{ action: SENTINEL, subject: 'org' }]).can('delete', 'org')).toBe(
      true,
    );
  });
  it('throwUnlessCan throws an instanceof ForbiddenError whose message names action and subject', () => {
    const a = bare([{ action: 'read', subject: 'org' }]);
    let caught: unknown;
    try {
      ForbiddenError.from(a).throwUnlessCan('delete', 'org');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(caught instanceof Error ? caught.message : '').toBe(
      'Cannot execute "delete" on "org"',
    );
  });
  it('a bare Ability refuses conditions and fields at construction (fail loud)', () => {
    expect(() =>
      bare([{ action: 'read', subject: 'org', conditions: { x: 1 } }]),
    ).toThrow(/conditionsMatcher/);
    expect(() =>
      bare([{ action: 'read', subject: 'org', fields: ['name'] }]),
    ).toThrow(/fieldMatcher/);
  });
  it('an inverted rule wins, matching is exact (no case folding) and dotted actions are whole tokens', () => {
    expect(
      bare([
        { action: 'read', subject: 'org' },
        { action: 'read', subject: 'org', inverted: true },
      ]).can('read', 'org'),
    ).toBe(false);
    const a = bare([
      { action: 'read', subject: 'org' },
      { action: 'role.assign', subject: 'members' },
    ]);
    expect([a.can('Read', 'org'), a.can('read', 'Org')]).toEqual([false, false]);
    expect([a.can('role.assign', 'members'), a.can('role', 'members')]).toEqual(
      [true, false],
    );
    expect(bare([]).can('read', 'org')).toBe(false);
  });
});
```

- [ ] **Step 3: Chạy để thấy fail**

Run: `pnpm vitest run --project unit test/unit/modules/tenancy/casl-contract.spec.ts`
Expected: FAIL `Cannot find package '@casl/ability'`.

- [ ] **Step 4: Cài package**

Run:
```bash
pnpm add @casl/ability
pnpm list @casl/ability @ucast/mongo2js
```
Expected: `@casl/ability 7.0.1` trong `dependencies` (save-exact), `@ucast/mongo2js` 2.x trong cây; `minimumReleaseAge` không chặn (7.0.1 phát hành 2026-07-06).

Sửa `renovate.json`, thêm vào `packageRules` (giữ rule đang có):
```json
{
  "groupName": "casl",
  "matchPackageNames": ["@casl/{/,}**", "@ucast/{/,}**"],
  "description": "Major bumps must re-run test/unit/modules/tenancy/casl-contract.spec.ts (spike T1, spec SP3 §8.7)"
}
```
Run: `pnpm dlx --package renovate renovate-config-validator renovate.json`
Expected: `Config validated successfully`.

- [ ] **Step 5: Chạy test hợp đồng**

Run: `pnpm vitest run --project unit test/unit/modules/tenancy/casl-contract.spec.ts`
Expected: PASS 7/7. (Đã probe trên tarball 7.0.1 lúc viết plan: `Cannot execute "delete" on "org"`, `conditionsMatcher`/`fieldMatcher` ném ở constructor.)

- [ ] **Step 6: Khung kết quả spike trong ADR 0017**

Thêm vào cuối `docs/adr/0017-tenancy-own-module.md`, trước mục `## Nguồn`:
```markdown
## Kết quả spike (plan 3A)

Chạy trên nhánh `sp3-tenancy`, hạ tầng Testcontainers của repo (Postgres 18, PgBouncer, Redis, Mailpit), Better Auth 1.7.6, Nest 12.1.0, Express 5.2.1, `@casl/ability` 7.0.1. T7 thuộc plan 3D.

| # | Kết quả | Bằng chứng |
|---|---|---|
| T1 | Đạt. `@casl/ability` 7.0.1 nạp ESM dưới SWC/`nodenext`; `new Ability(rules, { anyAction: '__no_wildcard__', anySubjectType: '__no_wildcard__' })` làm `manage`/`all` mất nghĩa wildcard; rule có action bằng sentinel là wildcard (lý do bất biến regex `[a-z]` đầu key); `ForbiddenError.from(a).throwUnlessCan(action, subject)` ném lỗi nhận bằng `instanceof`, message `Cannot execute "<action>" on "<subject>"`; `Ability` trần ném ngay ở constructor khi rule có `conditions` (`conditionsMatcher`) hoặc `fields` (`fieldMatcher`). | `test/unit/modules/tenancy/casl-contract.spec.ts` (giữ làm test hợp đồng) |
| T2 | (Task 2) | |
| T3 | (Task 2) | |
| T4 | (Task 2) | |
| T5 | (Task 3) | |
| T6 | (Task 3 phần thứ tự middleware; bằng chứng e2e ở Task 22) | |
| T8 | (Task 3) | |
```

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml renovate.json docs/adr/0017-tenancy-own-module.md test/unit/modules/tenancy/casl-contract.spec.ts
git commit -m "build(tenancy): add @casl/ability 7.0.1 and keep spike T1 as a contract test"
```

---

### Task 2: Role `tenancy_definer` trong script init; spike T2, T3, T4 trên database riêng

**Files:**
- Modify (được giữ): `docker/postgres/init/01-roles.sh`
- Create (được giữ): `test/support/scratch-db.ts`
- Throwaway: `test/integration/spike-sp3a/db-spikes.spec.ts`
- Modify: `docs/adr/0017-tenancy-own-module.md` (dòng T2, T3, T4)

**Interfaces:**
- Consumes: `getInfra()`, `runMigrations`, `coreMigrationList()` (SP1/SP2).
- Produces:
  - role `tenancy_definer` (`NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, `USAGE, CREATE ON SCHEMA public`, member của nó là `app_owner` với `INHERIT FALSE, SET TRUE`).
  - `test/support/scratch-db.ts`: `createScratchDb(prefix: string): Promise<ScratchDb>` với `ScratchDb = { name: string; client(role: 'owner' | 'app' | 'auth'): Promise<pg.Client>; drop(): Promise<void> }` — tạo database **không `OWNER`** bằng superuser bootstrap qua `docker exec`, rồi chạy lại chính `01-roles.sh` với `POSTGRES_DB=<tên>` (spec §5.3). Task 4 dùng cho `migrations.spec.ts`.

- [ ] **Step 1: Thêm role vào script init**

`docker/postgres/init/01-roles.sh`: thay dòng `unnest(ARRAY[...])` và thêm khối `tenancy_definer` ngay sau khối `ALTER ROLE auth_user …`:
```bash
SELECT format('CREATE ROLE %I', r)
FROM unnest(ARRAY['app_owner', 'app_user', 'app_relay', 'auth_user', 'tenancy_definer']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

ALTER ROLE app_owner WITH LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE app_user  WITH LOGIN PASSWORD :'user_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE app_relay WITH LOGIN PASSWORD :'relay_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE auth_user WITH LOGIN PASSWORD :'auth_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
-- SP3 (ADR 0005, 0017): chủ sở hữu duy nhất của các hàm SECURITY DEFINER chỉ đọc của tenancy. Không đăng nhập được,
-- không BYPASSRLS; chỉ có SELECT theo cột + policy `FOR SELECT TO tenancy_definer USING (true)` do migration cấp.
ALTER ROLE tenancy_definer WITH NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
```
và sau dòng `GRANT USAGE ON SCHEMA public TO app_user, app_relay;`:
```bash
-- CREATE vì migration tạo hàm DƯỚI `SET LOCAL ROLE tenancy_definer` (hàm sinh ra thuộc tenancy_definer). Role NOLOGIN
-- nên không ai đăng nhập bằng nó để tạo đối tượng khác.
GRANT USAGE, CREATE ON SCHEMA public TO tenancy_definer;
-- INHERIT FALSE: app_owner KHÔNG hưởng quyền/policy của tenancy_definer (đọc bảng FORCE RLS), và từ PG 16 không được
-- coi là owner của hàm do tenancy_definer sở hữu, nên mọi DDL trên hàm đó phải `SET LOCAL ROLE` (S3-A31).
-- SET TRUE: migration (app_owner) được `SET ROLE tenancy_definer`. GRANT lặp lại cập nhật option (chạy lại được).
GRANT tenancy_definer TO app_owner WITH INHERIT FALSE, SET TRUE;
```

- [ ] **Step 2: Helper database riêng (được giữ)**

`test/support/scratch-db.ts`:
```ts
import pg from 'pg';
import { getContainerRuntimeClient } from 'testcontainers';
import { getInfra, type Creds } from './infra.js';

/** Tên database chỉ gồm chữ thường, số, `_` (không cần quote trong SQL của `exec`). */
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const INIT_SCRIPT = '/docker-entrypoint-initdb.d/01-roles.sh';

async function execInPg(cmd: string): Promise<string> {
  const runtime = await getContainerRuntimeClient();
  const container = runtime.container.getById(getInfra().pg.containerId);
  const r = await runtime.container.exec(container, ['bash', '-c', cmd]);
  if (r.exitCode !== 0)
    throw new Error(`docker exec failed (${r.exitCode}): ${r.output}`);
  return r.output;
}

export type ScratchDb = {
  name: string;
  client(role: 'owner' | 'app' | 'auth'): Promise<pg.Client>;
  drop(): Promise<void>;
};

/**
 * Database riêng cho test migration (spec SP3 §5.3, S3-A53, S3-A66): tạo bằng superuser bootstrap, KHÔNG `OWNER`
 * (owner = superuser như production), rồi chạy lại CHÍNH script init của DBA cho database đó (quyền theo database:
 * schema `auth`, grant schema, default privilege, `lc_messages`). Test migration không đụng DB dùng chung.
 */
export async function createScratchDb(prefix: string): Promise<ScratchDb> {
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}`;
  if (!NAME.test(name)) throw new Error(`invalid scratch database name ${name}`);
  await execInPg(
    `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'CREATE DATABASE ${name} TEMPLATE template0'`,
  );
  await execInPg(`POSTGRES_DB=${name} bash ${INIT_SCRIPT}`);
  const { pg: p } = getInfra();
  const creds: Record<'owner' | 'app' | 'auth', Creds> = {
    owner: p.owner,
    app: p.app,
    auth: p.auth,
  };
  return {
    name,
    async client(role) {
      const c = new pg.Client({
        host: p.host,
        port: p.port,
        database: name,
        ...creds[role],
      });
      await c.connect();
      return c;
    },
    async drop() {
      await execInPg(
        `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'DROP DATABASE IF EXISTS ${name} WITH (FORCE)'`,
      );
    },
  };
}
```
`Creds` đã export ở `test/support/infra.ts`.

- [ ] **Step 3: Viết spike T2, T3, T4 (throwaway)**

`test/integration/spike-sp3a/db-spikes.spec.ts`:
```ts
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defineConstraintErrors,
  dbErrorMapper,
  runMigrations,
} from '../../../src/core/database/index.js';
import { CoreErrors } from '../../../src/core/errors/index.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';

let db: ScratchDb;
let owner: pg.Client;
beforeAll(async () => {
  applyTestEnv();
  db = await createScratchDb('spike3a');
  vi.stubEnv('DB_NAME', db.name);
  await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
  owner = await db.client('owner');
});
afterAll(async () => {
  await owner?.end();
  vi.unstubAllEnvs();
  await db?.drop();
});

describe('T2 tenancy_definer + SET LOCAL ROLE + definer read under FORCE RLS', () => {
  it('a SECURITY DEFINER function owned by tenancy_definer reads a FORCE RLS table for app_user without org context', async () => {
    await owner.query('BEGIN');
    await owner.query(`CREATE TABLE spike_t (org_id uuid NOT NULL, v int)`);
    await owner.query(`ALTER TABLE spike_t ENABLE ROW LEVEL SECURITY`);
    await owner.query(`ALTER TABLE spike_t FORCE ROW LEVEL SECURITY`);
    await owner.query(`CREATE POLICY spike_t_tenant ON spike_t TO app_user USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`);
    await owner.query(`CREATE POLICY spike_t_definer_read ON spike_t FOR SELECT TO tenancy_definer USING (true)`);
    await owner.query(`GRANT SELECT, INSERT ON spike_t TO app_user`);
    await owner.query(`GRANT SELECT (v) ON spike_t TO tenancy_definer`);
    await owner.query(`SET LOCAL ROLE tenancy_definer`);
    await owner.query(`CREATE FUNCTION public.spike_count() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN (SELECT count(v) FROM public.spike_t); END $$`);
    await owner.query(`REVOKE ALL ON FUNCTION public.spike_count() FROM PUBLIC`);
    await owner.query(`GRANT EXECUTE ON FUNCTION public.spike_count() TO app_user`);
    await owner.query(`RESET ROLE`);
    await owner.query('COMMIT');
    await owner.query(`ALTER TABLE spike_t NO FORCE ROW LEVEL SECURITY`);
    await owner.query(`INSERT INTO spike_t VALUES ($1, 1), ($2, 2)`, [v7(), v7()]);
    await owner.query(`ALTER TABLE spike_t FORCE ROW LEVEL SECURITY`);
    const app = await db.client('app');
    try {
      expect((await app.query('SELECT public.spike_count() AS n')).rows).toEqual([{ n: '2' }]);
      await expect(app.query('SELECT * FROM spike_t')).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await app.end();
    }
    // INHERIT FALSE: app_owner không hưởng policy của definer (dưới FORCE thấy 0 dòng).
    expect((await owner.query('SELECT count(*)::int AS n FROM spike_t')).rows).toEqual([{ n: 0 }]);
  });
  it('from PG 16 app_owner is not the owner of a tenancy_definer function: bare DROP is 42501, under SET LOCAL ROLE it works', async () => {
    await expect(owner.query('DROP FUNCTION public.spike_count()')).rejects.toMatchObject({ code: '42501' });
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE tenancy_definer');
    await owner.query('DROP FUNCTION public.spike_count()');
    await owner.query('RESET ROLE');
    await owner.query('COMMIT');
    await owner.query('DROP TABLE spike_t');
  });
});

describe('T3 deferred constraint trigger that locks the org row', () => {
  it('RAISE check_violation with CONSTRAINT at COMMIT reaches the mapper as a 23 error with the constraint name', async () => {
    await owner.query(`CREATE TABLE spike_org (id uuid PRIMARY KEY, deleted_at timestamptz)`);
    await owner.query(`CREATE TABLE spike_owner (org_id uuid NOT NULL REFERENCES spike_org(id), n int NOT NULL)`);
    await owner.query(`GRANT SELECT, INSERT, DELETE ON spike_org, spike_owner TO app_user`);
    await owner.query(`GRANT UPDATE (deleted_at) ON spike_org TO app_user`);
    await owner.query(`CREATE FUNCTION spike_last_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
      BEGIN
        PERFORM 1 FROM public.spike_org WHERE id = OLD.org_id FOR NO KEY UPDATE;
        IF NOT EXISTS (SELECT 1 FROM public.spike_owner WHERE org_id = OLD.org_id) THEN
          RAISE EXCEPTION 'no owner left' USING ERRCODE = 'check_violation', CONSTRAINT = 'spike_last_owner_ck';
        END IF;
        RETURN NULL;
      END $$`);
    await owner.query(`CREATE CONSTRAINT TRIGGER spike_last_owner_ck AFTER DELETE ON spike_owner DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spike_last_owner()`);
    const org = v7();
    await owner.query(`INSERT INTO spike_org VALUES ($1, NULL)`, [org]);
    await owner.query(`INSERT INTO spike_owner VALUES ($1, 1), ($1, 2)`, [org]);
    const [a, b] = [await db.client('app'), await db.client('app')];
    try {
      // Hai kết nối KHÔNG khoá org ở caller, lặp ×50: đúng một bên thắng, org luôn còn ≥ 1 owner.
      for (let i = 0; i < 50; i++) {
        await owner.query(`INSERT INTO spike_owner SELECT $1, 2 WHERE NOT EXISTS (SELECT 1 FROM spike_owner WHERE org_id = $1 AND n = 2)`, [org]);
        await owner.query(`INSERT INTO spike_owner SELECT $1, 1 WHERE NOT EXISTS (SELECT 1 FROM spike_owner WHERE org_id = $1 AND n = 1)`, [org]);
        await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
        await a.query(`DELETE FROM spike_owner WHERE org_id = $1 AND n = 1`, [org]);
        await b.query(`DELETE FROM spike_owner WHERE org_id = $1 AND n = 2`, [org]);
        const results = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')]);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected');
        const reason: unknown = rejected?.status === 'rejected' ? rejected.reason : undefined;
        expect(reason).toMatchObject({ code: '23514', constraint: 'spike_last_owner_ck' });
        expect((await owner.query(`SELECT count(*)::int AS n FROM spike_owner WHERE org_id = $1`, [org])).rows[0].n).toBe(1);
      }
    } finally {
      await a.end();
      await b.end();
    }
  });
  it('defineConstraintErrors maps the constraint name of a COMMIT-time trigger error', () => {
    defineConstraintErrors({ spike_last_owner_ck: CoreErrors.CONFLICT });
    const err = Object.assign(new Error('no owner left'), { code: '23514', constraint: 'spike_last_owner_ck' });
    expect(dbErrorMapper(err)?.error.code).toBe('conflict');
  });
  it('step 4 (IMMEDIATE by name, with the duplicate-name guard) and step 5 (back to declared mode) run in plpgsql; a trigger created afterwards stays deferred', async () => {
    await owner.query('BEGIN');
    await owner.query(`DO $$ DECLARE r record; BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname IN ('public', 'auth') GROUP BY c.connamespace, c.conname HAVING count(*) > 1 AND bool_or(c.condeferrable)) THEN
        RAISE EXCEPTION 'a deferrable constraint name must be unique per schema';
      END IF;
      FOR r IN SELECT n.nspname, c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
        EXECUTE format('SET CONSTRAINTS %I.%I IMMEDIATE', r.nspname, r.conname);
      END LOOP; END $$`);
    await owner.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT n.nspname, c.conname, c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
        EXECUTE format('SET CONSTRAINTS %I.%I %s', r.nspname, r.conname, CASE WHEN r.condeferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END);
      END LOOP; END $$`);
    await owner.query(`CREATE TABLE spike_later (org_id uuid, n int)`);
    await owner.query(`CREATE FUNCTION spike_later_ck() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM spike_later) = 1 THEN RAISE EXCEPTION 'odd' USING ERRCODE = 'check_violation', CONSTRAINT = 'spike_later_ck'; END IF; RETURN NULL; END $$`);
    await owner.query(`CREATE CONSTRAINT TRIGGER spike_later_ck AFTER INSERT ON spike_later DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spike_later_ck()`);
    // Hợp lệ chỉ ở cuối: sau câu đầu có 1 dòng (lẻ). Còn deferred thì không nổ ở từng câu.
    await owner.query(`INSERT INTO spike_later VALUES (NULL, 1)`);
    await owner.query(`INSERT INTO spike_later VALUES (NULL, 2)`);
    await owner.query('ROLLBACK');
    await owner.query('DROP TABLE spike_owner, spike_org');
    await owner.query('DROP FUNCTION spike_last_owner()');
  });
});

describe('T4 cross-schema FK public → auth."user" ON DELETE RESTRICT', () => {
  it('auth_user deleting a referenced user gets 23001 without any grant on public', async () => {
    await owner.query(`CREATE TABLE spike_users (auth_user_id uuid REFERENCES auth."user"(id) ON DELETE RESTRICT)`);
    const { rows } = await owner.query<{ id: string }>(`INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at) VALUES ('S', $1, true, now(), now()) RETURNING id`, [`spike-${v7()}@example.test`]);
    await owner.query(`INSERT INTO spike_users VALUES ($1)`, [rows[0]!.id]);
    const auth = await db.client('auth');
    try {
      await expect(auth.query(`DELETE FROM auth."user" WHERE id = $1`, [rows[0]!.id])).rejects.toMatchObject({ code: '23001' });
      expect((await auth.query(`SELECT has_schema_privilege('auth_user', 'public', 'USAGE') AS u`)).rows).toEqual([{ u: false }]);
    } finally {
      await auth.end();
    }
    await owner.query('DROP TABLE spike_users');
  });
});
```

- [ ] **Step 4: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp3a/db-spikes.spec.ts`
Expected: PASS mọi ca. Ca nào đỏ:
- T2 đỏ → fallback spec §4: hàm do `app_owner` sở hữu + policy `TO app_owner`; ghi ADR 0005, **dừng và báo Sếp** trước khi viết migration Task 13 (thay đổi thiết kế đi xa).
- T3 đỏ (lỗi COMMIT không mang lớp 23 hoặc tên constraint) → fallback spec §4: trigger `BEFORE` không defer + khoá org; ghi ADR 0017, báo Sếp.
- T4 đỏ → fallback: bỏ FK, giữ `UserDeletionGuard` là lớp duy nhất; ghi rủi ro, báo Sếp.

- [ ] **Step 5: Ghi kết quả vào ADR 0017 và dọn spike**

Thay ba dòng T2, T3, T4 của bảng "Kết quả spike (plan 3A)" bằng kết quả thật (mẫu khi đạt):
```markdown
| T2 | Đạt. `tenancy_definer NOLOGIN NOBYPASSRLS`, `GRANT tenancy_definer TO app_owner WITH INHERIT FALSE, SET TRUE`; hàm tạo dưới `SET LOCAL ROLE tenancy_definer` thuộc `tenancy_definer`, `SECURITY DEFINER SET search_path = ''` đọc được bảng FORCE RLS nhờ `FOR SELECT TO tenancy_definer USING (true)` khi `app_user` gọi không có org context; `app_user` đọc thẳng bảng → `P0001`; `app_owner` thấy 0 dòng (INHERIT FALSE); `DROP FUNCTION` bằng `app_owner` trần → `42501`, dưới `SET LOCAL ROLE` → đạt. | `test/integration/spike-sp3a/db-spikes.spec.ts` (không commit), PG 18, database riêng không `OWNER` |
| T3 | Đạt. `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` + `RAISE … ERRCODE 'check_violation', CONSTRAINT` lúc `COMMIT` tới client là `23514` mang tên constraint; `defineConstraintErrors` map đúng; trigger tự `FOR NO KEY UPDATE` dòng org: hai kết nối `app_user` không khoá ở caller xoá hai owner ×50 → đúng một bên `23514`, luôn còn 1 owner. Khối bước 4 (kiểm tên trùng + `SET CONSTRAINTS <schema>.<tên> IMMEDIATE` theo tên) và bước 5 (trả về chế độ khai báo) chạy được qua `EXECUTE`; constraint trigger tạo sau bước 5 vẫn hoãn tới commit. | như trên |
| T4 | Đạt. FK `public.* → auth."user"(id) ON DELETE RESTRICT`: `auth_user` (không `USAGE` trên `public`) xoá user bị tham chiếu → `23001`; không cần grant mới. | như trên |
```
Run: `rm -r test/integration/spike-sp3a`

- [ ] **Step 6: Commit**

```bash
git add docker/postgres/init/01-roles.sh test/support/scratch-db.ts docs/adr/0017-tenancy-own-module.md
git commit -m "feat(db): tenancy_definer role in the init script; record spikes T2-T4 in ADR 0017"
```

---

### Task 3: Spike T5, T8 (đường xoá user của Better Auth, `onError` với `23001`) và T6 (thứ tự middleware theo `distance`)

**Files:**
- Throwaway: `test/integration/spike-sp3a/user-deletion.spec.ts`, `test/integration/spike-sp3a/middleware-order.spec.ts`
- Modify: `docs/adr/0017-tenancy-own-module.md` (dòng T5, T6, T8)

**Interfaces:**
- Consumes: `startIdentityApp`, `ownerQuery`, `promoteToAdmin`, `AuthClient`, `mailpitFromInfra` (SP2), `BETTER_AUTH`.
- Produces: kết quả T5 (hook `before` chạy trước xoá; thứ tự session → account → user; `/delete-user`, `/delete-user/callback` trả 404), T8 (lỗi mà `onAPIError.onError` nhận được khi FK `RESTRICT` chặn xoá `auth."user"`: lớp, `code`, có qua nguyên không; scope `runWithAuthDbFailureScope` còn hiệu lực trong `onError`), T6 (Nest 12.1 xếp middleware theo `distance` lớn nhất trong cây import) — quyết định cách viết ở Task 11–12 và Task 22.

- [ ] **Step 1: Viết spike T5 + T8**

`test/integration/spike-sp3a/user-deletion.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { recordedAuthDbError } from '../../../src/modules/identity/infra/better-auth/auth-db-failures.js';
import { AuthClient } from '../../support/auth-client.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { ownerQuery, promoteToAdmin, startIdentityApp } from '../../support/identity-app.js';

const PASSWORD = 'spike correct horse battery';
const mail = mailpitFromInfra();
let app: INestApplication;
beforeAll(async () => {
  app = await startIdentityApp();
  await ownerQuery(`CREATE TABLE spike_refs (auth_user_id uuid REFERENCES auth."user"(id) ON DELETE RESTRICT)`);
});
afterAll(async () => {
  await ownerQuery('DROP TABLE IF EXISTS spike_refs');
  await app?.close();
});

async function verifiedUser(prefix: string): Promise<{ client: AuthClient; email: string; id: string }> {
  const client = new AuthClient(app.getHttpServer());
  const email = `${prefix}-${randomUUID()}@example.test`;
  expect((await client.signUp(email, PASSWORD)).status).toBe(202);
  await client.verifyEmailFromMailpit(mail, email);
  expect((await client.signIn(email, PASSWORD)).status).toBe(200);
  const [row] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
  return { client, email, id: row!.id };
}

describe('T5 + T8: Better Auth 1.7.6 user deletion', () => {
  it('records what onAPIError.onError receives when the FK blocks the user DELETE, and the delete order', async () => {
    const admin = await verifiedUser('spike-admin');
    await promoteToAdmin(admin.email);
    expect((await admin.client.signIn(admin.email, PASSWORD)).status).toBe(200);
    const victim = await verifiedUser('spike-victim');
    await ownerQuery(`INSERT INTO spike_refs VALUES ($1)`, [victim.id]);
    const auth = app.get<AuthInstance>(BETTER_AUTH);
    const seen: unknown[] = [];
    const original = auth.options.onAPIError?.onError;
    const spy = vi.spyOn(auth.options.onAPIError as { onError: (e: unknown, c: unknown) => void }, 'onError').mockImplementation((e, c) => {
      seen.push({ class: e instanceof Error ? e.constructor.name : typeof e, code: (e as { code?: unknown }).code, scopeDbError: recordedAuthDbError() });
      original?.(e, c as never);
    });
    const res = await admin.client.request('post', '/api/auth/admin/remove-user', { body: { userId: victim.id } });
    spy.mockRestore();
    // Ghi lại nguyên trạng cho ADR: status, những gì onError thấy, và dòng nào còn.
    const left = await ownerQuery<{ u: number; a: number; s: number }>(
      `SELECT (SELECT count(*)::int FROM auth."user" WHERE id = $1) AS u, (SELECT count(*)::int FROM auth.account WHERE user_id = $1) AS a, (SELECT count(*)::int FROM auth.session WHERE user_id = $1) AS s`,
      [victim.id],
    );
    process.stdout.write(`${JSON.stringify({ status: res.status, body: res.body, seen, left })}\n`);
    expect(left[0]).toMatchObject({ u: 1, a: 0, s: 0 });
    await ownerQuery(`DELETE FROM spike_refs`);
  });
  it('/delete-user and /delete-user/callback answer 404 because user.deleteUser is off', async () => {
    const u = await verifiedUser('spike-self');
    expect((await u.client.request('post', '/api/auth/delete-user', { body: { password: PASSWORD } })).status).toBe(404);
    expect((await u.client.request('get', '/api/auth/delete-user/callback?token=x')).status).toBe(404);
  });
});
```
(`as` ở spike chỉ để quan sát, file không commit.)

- [ ] **Step 2: Viết spike T6**

`test/integration/spike-sp3a/middleware-order.spec.ts`:
```ts
import { Controller, Get, Injectable, type MiddlewareConsumer, Module, type NestMiddleware, type NestModule } from '@nestjs/common';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../support/app-factory.js';

const order: string[] = [];
@Injectable() class A implements NestMiddleware { use(_q: unknown, _s: unknown, n: () => void) { order.push('A'); n(); } }
@Injectable() class B implements NestMiddleware { use(_q: unknown, _s: unknown, n: () => void) { order.push('B'); n(); } }
@Controller('v1/orgs/:orgId') class C { @Get() get() { return {}; } }
@Module({ providers: [A] }) class MA implements NestModule { configure(c: MiddlewareConsumer) { c.apply(A).forRoutes('{*path}'); } }
@Module({ providers: [B], controllers: [C] }) class MB implements NestModule { configure(c: MiddlewareConsumer) { c.apply(B).forRoutes('v1/orgs/:orgId{/*path}'); } }
@Module({ imports: [MA] }) class Deep1 {}
@Module({ imports: [Deep1] }) class Deep2 {}

describe('T6: Nest 12.1 middleware order follows the deepest import distance', () => {
  it.each([
    ['A shallow, B shallow', [MA, MB], ['A', 'B']],
    ['A deeper than B', [Deep2, MB], ['B', 'A']],
  ])('%s', async (_n, imports, expected) => {
    order.length = 0;
    const app = await createTestApp(imports);
    try {
      await request(app.getHttpServer()).get(`/v1/orgs/${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}`);
      expect(order).toEqual(expected);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 3: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp3a`
Expected: T6 PASS (thứ tự đổi theo `distance`, xác nhận lý do `PrincipalResolver.ensure` idempotent); `/delete-user*` 404; ca xoá có FK: status (mong đợi `500` trước khi sửa) và dòng log `seen` in ra. Đọc dòng JSON:
- `seen[0].code === '23001'` (lỗi pg đi nguyên tới `onError`) → Task 12 đổi lỗi theo `code`.
- `seen[0].code` khác nhưng `seen[0].scopeDbError.code === '23001'` → Task 12 dùng nhánh fallback `recordedAuthDbError()?.code === '23001'` (spec T8 fallback). Cả hai nhánh đều được cài ở Task 12; spike chỉ quyết định nhánh nào là nhánh chính trong ADR.
- `left` phải là `{ u: 1, a: 0, s: 0 }`: xác nhận thứ tự session → account → user (`internal-adapter.mjs:232-246`) và vì sao chỗ từ chối chính là `hooks.before`.
Nếu `hooks.before` không chạy trước handler (Task 11 kiểm lại bằng test thật) thì T5 không có fallback: **dừng và báo Sếp**.

- [ ] **Step 4: Ghi kết quả vào ADR 0017, dọn spike**

Thay các dòng T5, T6, T8 (mẫu khi đạt, sửa đúng theo output):
```markdown
| T5 | Đạt. `/admin/remove-user` xoá session → account → user, không transaction; `databaseHooks.user.delete.before` chạy sau khi session và account đã mất; `/delete-user`, `/delete-user/callback` trả 404 (SP2 không bật `user.deleteUser`). Chỗ từ chối chính là `hooks.before` (chạy trước handler). | spike `user-deletion.spec.ts` (không commit): sau khi FK chặn, còn `auth."user"` nhưng 0 account, 0 session |
| T6 | Đạt. Nest 12.1 sắp middleware theo `distance` (độ sâu lớn nhất trong cây import): bọc module A sâu hơn thì middleware của B chạy trước. Cơ chế `PrincipalResolver.ensure` idempotent (Task 9) làm thứ tự không còn quan trọng; bằng chứng một span `identity.authenticate` mỗi request ở cả hai thứ tự: `test/e2e/tenancy/pipeline.e2e.spec.ts` (Task 22). | spike `middleware-order.spec.ts` (không commit) |
| T8 | Đạt. Khi FK `RESTRICT` chặn câu xoá `auth."user"`, `onAPIError.onError` nhận <lớp lỗi quan sát được> với `code = <giá trị>`; scope `runWithAuthDbFailureScope` của mount còn hiệu lực trong `onError` và `recordedAuthDbError()` mang `code: '23001'`. Task 12 đổi lỗi theo `code` của lỗi, fallback theo scope. | spike `user-deletion.spec.ts` (không commit) |
```
Run: `rm -r test/integration/spike-sp3a`

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0017-tenancy-own-module.md
git commit -m "docs(adr): record spikes T5, T6 and T8 for plan 3A"
```

---

## Phần B — Core, notifications và hạ tầng test migration (spec §5.2 hàng "Plan = 3A", §5.3, §6.13)

### Task 4: `migrations.spec.ts` trên database riêng, quét tĩnh migration, thứ tự timestamp, catalog role `tenancy_definer`

**Files:**
- Modify: `test/integration/core/database/migrations.spec.ts`, `test/integration/core/database/rls-catalog.spec.ts`, `.github/workflows/ci.yml`
- Create: `test/support/tenancy-catalog.ts`, `test/unit/migrations/migration-scan.spec.ts`, `test/unit/migrations/migration-order.spec.ts`

**Interfaces:**
- Consumes: `createScratchDb` (Task 2), `runMigrations`, `coreMigrationList`/`fixtureMigrationList`.
- Produces:
  - `test/support/tenancy-catalog.ts`: `DEFINER_FUNCTIONS_3A`, `DEFINER_READ_TABLES_3A`, `DEFINER_FUNCTIONS: readonly string[]`, `DEFINER_READ_TABLES: readonly string[]` (hợp các hằng đang có; 3C/3D thêm hằng riêng, không sửa hằng 3A).
  - `migrations.spec.ts` chạy mọi vòng up/down/sweep trên database riêng; export nội bộ `catalogSnapshot(database)`. Ca "down bị dữ liệu chặn" không nằm ở file này: Task 7 đặt nó ở file riêng `test/integration/core/database/suspended-at-down.spec.ts`.
  - Quét tĩnh `migration-scan.spec.ts` và `migration-order.spec.ts` áp cho mọi file `src/migrations/**`.

- [ ] **Step 1: Hằng catalog của tenancy (dùng chung cho test catalog và quét tĩnh)**

`test/support/tenancy-catalog.ts`:
```ts
/**
 * Tập tên theo plan (spec SP3 §6.14, §18.1, INT3-3): test so với HỢP các hằng đang có mặt, không so số tuyệt đối, để
 * 3C ∥ 3D chỉ xung đột văn bản ở dòng khai báo hằng. Plan sau THÊM hằng của mình, không sửa hằng 3A.
 */
export const DEFINER_FUNCTIONS_3A = [
  'tenancy_list_user_orgs',
  'tenancy_count_user_orgs',
  'tenancy_count_orgs_created_by',
  'tenancy_user_sole_owner_orgs',
  'tenancy_user_related_org_ids',
  'tenancy_orgs_due_for_purge',
] as const;
export const DEFINER_READ_TABLES_3A = [
  'organizations',
  'org_roles',
  'org_members',
] as const;
/** Bảng tenant của tenancy có policy `<bảng>_tenant TO app_user` (không kể bảng global và bảng gốc). */
export const TENANCY_TENANT_TABLES_3A = ['org_roles', 'org_members'] as const;
export const DEFINER_FUNCTIONS: readonly string[] = [...DEFINER_FUNCTIONS_3A];
export const DEFINER_READ_TABLES: readonly string[] = [
  ...DEFINER_READ_TABLES_3A,
];
export const TENANCY_TENANT_TABLES: readonly string[] = [
  ...TENANCY_TENANT_TABLES_3A,
];
```

- [ ] **Step 2: Viết quét tĩnh migration (fail trên fixture chuỗi xấu trước khi có code quét)**

`test/unit/migrations/migration-scan.spec.ts`:
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFINER_FUNCTIONS } from '../../support/tenancy-catalog.js';

const ROOT = 'src/migrations';
const CREATE_FN = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_.]*)\s*\(/gi;
const DROP_FN = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_.]*)\s*\(/gi;
const SET_DEFINER = /SET\s+LOCAL\s+ROLE\s+tenancy_definer/gi;
const RESET_ROLE = /RESET\s+ROLE/gi;
const NO_FORCE = /NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
/** Câu `RAISE` của khối khẳng định bước 7 (spec §8.8): mọi migration có `NO FORCE` phải kết thúc bằng khối này. */
const FORCE_ASSERTION = 'a tenant table lost FORCE ROW LEVEL SECURITY';

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
  if (up < 0 || down < up)
    throw new Error('a migration declares override up() and then override down()');
  return { up: src.slice(up, down), down: src.slice(down) };
}

/** Mọi vi phạm của một file migration; rỗng = hợp lệ. Hàm thuần để test chính bộ quét bằng chuỗi xấu. */
function scanMigration(src: string, definers: readonly string[]): string[] {
  const problems: string[] = [];
  if (/isTransactional/.test(src)) problems.push('overrides isTransactional()');
  if (/SET\s+CONSTRAINTS\s+ALL/i.test(src)) problems.push('uses SET CONSTRAINTS ALL');
  const { up, down } = methodsOf(src);
  const dropped = new Set(positions(down, DROP_FN).map((p) => p.name));
  for (const { name } of positions(up, CREATE_FN))
    if (!dropped.has(name)) problems.push(`up creates function ${name} that down never drops`);
  for (const [label, body] of [['up', up], ['down', down]] as const) {
    const sets = positions(body, SET_DEFINER).map((p) => p.at);
    const resets = positions(body, RESET_ROLE).map((p) => p.at);
    if (sets.length !== resets.length || sets.some((s, i) => (resets[i] ?? -1) < s))
      problems.push(`${label}: every SET LOCAL ROLE tenancy_definer needs a RESET ROLE after it`);
    const inside = (at: number) => sets.some((s, i) => s < at && at < (resets[i] ?? -1));
    for (const fn of [...positions(body, CREATE_FN), ...positions(body, DROP_FN)])
      if (definers.includes(fn.name) && !inside(fn.at))
        problems.push(`${label}: definer function ${fn.name} is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE`);
    const lastNoForce = positions(body, NO_FORCE).at(-1)?.at;
    if (lastNoForce !== undefined && !body.slice(lastNoForce).includes(FORCE_ASSERTION))
      problems.push(`${label}: NO FORCE ROW LEVEL SECURITY without the final FORCE assertion block`);
  }
  return problems;
}

describe('migration scanner (spec SP3 §6.13, §18.5)', () => {
  const wrap = (up: string, down: string) =>
    `class M { override up() { ${up} } override down() { ${down} } }`;
  it('catches every forbidden shape', () => {
    expect(scanMigration(wrap('CREATE FUNCTION f() x', ''), [])).toEqual([
      'up creates function f that down never drops',
    ]);
    expect(scanMigration(wrap('SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x', 'SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE'), ['g'])).toContain(
      'up: every SET LOCAL ROLE tenancy_definer needs a RESET ROLE after it',
    );
    expect(scanMigration(wrap('CREATE FUNCTION public.g() x', 'DROP FUNCTION public.g()'), ['g'])).toEqual([
      'up: definer function g is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE',
      'down: definer function g is created or dropped outside SET LOCAL ROLE tenancy_definer … RESET ROLE',
    ]);
    expect(scanMigration(wrap('ALTER TABLE t NO FORCE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY', ''), [])).toEqual([
      'up: NO FORCE ROW LEVEL SECURITY without the final FORCE assertion block',
    ]);
    expect(scanMigration(`${wrap('', '')} isTransactional`, [])).toContain('overrides isTransactional()');
    expect(scanMigration(wrap('SET CONSTRAINTS ALL IMMEDIATE', ''), [])).toContain('uses SET CONSTRAINTS ALL');
  });
  it('accepts the correct shape', () => {
    expect(
      scanMigration(
        wrap(
          `SET LOCAL ROLE tenancy_definer; CREATE FUNCTION public.g() x; RESET ROLE; ALTER TABLE t NO FORCE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY; RAISE '${FORCE_ASSERTION}'`,
          'SET LOCAL ROLE tenancy_definer; DROP FUNCTION public.g(); RESET ROLE',
        ),
        ['g'],
      ),
    ).toEqual([]);
  });
  it.each(files(ROOT))('%s passes the scanner', (file) => {
    expect(scanMigration(readFileSync(file, 'utf8'), DEFINER_FUNCTIONS)).toEqual([]);
  });
});
```

- [ ] **Step 3: Viết test thứ tự timestamp**

`test/unit/migrations/migration-order.spec.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'src/migrations';
const NAME = /^Migration(\d{14})_[a-z0-9_]+\.ts$/;
/** Mọi migration SP3 chạy sau schema Better Auth (FK xuyên schema, spec §6.2 DB-M10). */
const BETTER_AUTH_SCHEMA_TS = '20260927163904';
const MAIN = 'origin/main';

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();
const tsOf = (file: string): string => {
  const m = NAME.exec(basename(file));
  if (!m?.[1]) throw new Error(`${file} does not follow Migration<14 digits>_<snake_name>.ts`);
  return m[1];
};
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('migration timestamps (spec SP3 §6.13 "Thứ tự merge")', () => {
  const all = files(ROOT);
  it('are unique across modules, so the runner order is the timestamp order', () => {
    const stamps = all.map(tsOf);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
  it('tenancy migrations run after the Better Auth schema', () => {
    for (const f of all.filter((f) => f.replaceAll('\\', '/').includes('/tenancy/')))
      expect(tsOf(f) > BETTER_AUTH_SCHEMA_TS, f).toBe(true);
  });
  it(`every migration added on this branch is newer than the newest migration on ${MAIN}`, () => {
    let base: string;
    try {
      base = git('merge-base', 'HEAD', MAIN);
    } catch {
      throw new Error(`${MAIN} is not available: fetch it (CI checks out with fetch-depth 0)`);
    }
    const onMain = git('ls-tree', '-r', '--name-only', base, '--', ROOT).split('\n').filter(Boolean);
    const newest = onMain.map(tsOf).sort().at(-1) ?? '';
    const added = [
      ...git('diff', '--name-only', '--diff-filter=A', base, 'HEAD', '--', ROOT).split('\n'),
      ...git('ls-files', '--others', '--exclude-standard', '--', ROOT).split('\n'),
    ].filter((f) => f.endsWith('.ts'));
    for (const f of added) expect(tsOf(f) > newest, `${f} must be newer than ${newest}`).toBe(true);
  });
});
```

- [ ] **Step 4: Chạy hai file quét**

Run: `pnpm vitest run --project unit test/unit/migrations`
Expected: PASS (migration SP1/SP2 hiện có đã đối xứng: `app_current_org`, `auth.record_two_factor_notice`; chưa có hàm definer). `origin/main` phải có (`git fetch origin main` nếu thiếu).

- [ ] **Step 5: `migrations.spec.ts` chạy trên database riêng**

Sửa `test/integration/core/database/migrations.spec.ts`:
1. Import thêm `beforeAll` và `createScratchDb, type ScratchDb` từ `../../../support/scratch-db.js`.
2. `catalogSnapshot()` nhận database:
```ts
async function catalogSnapshot(database: string): Promise<Record<string, string[]>> {
  const { pg: p } = getInfra();
  const owner = new pg.Client({ host: p.host, port: p.port, database, ...p.owner });
  // (thân hàm giữ nguyên)
```
và `assertEachMigrationRevertsCleanly(fullList, database, tableName?)` gọi `catalogSnapshot(database)`.
3. Thay khối `describe('migrations', …)` mở đầu bằng:
```ts
describe('migrations (own database per run, spec SP3 §5.3)', () => {
  applyTestEnv();
  const source = { kind: 'list' as const, list: coreMigrationList() };
  const fixtures = {
    source: { kind: 'list' as const, list: fixtureMigrationList() },
    tableName: FIXTURE_MIGRATIONS_TABLE,
  };
  let scratch: ScratchDb;
  beforeAll(async () => {
    scratch = await createScratchDb('migrations');
    // `databaseConfig()` đọc env ở mỗi lần gọi: mọi `runMigrations` của file này đi vào database riêng.
    vi.stubEnv('DB_NAME', scratch.name);
    await runMigrations('up', { source });
    await runMigrations('up', fixtures);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await scratch?.drop();
  });

  it('the scratch database is bootstrapped like production (spec §5.3 (3), R4C-N4-2)', async () => {
    const { pg: p } = getInfra();
    const c = await scratch.client('owner');
    try {
      const { rows } = await c.query<Record<string, unknown>>(
        `SELECT
           (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'auth') AS auth_owner,
           has_schema_privilege('tenancy_definer', 'public', 'CREATE') AS definer_create,
           EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclrole = 'app_owner'::regrole) AS owner_default_acl,
           (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) =
             (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = $1) AS same_db_owner,
           pg_has_role('app_owner', 'pg_database_owner', 'USAGE') AS owner_is_db_owner,
           has_database_privilege('app_owner', current_database(), 'CREATE') AS owner_db_create`,
        [p.database],
      );
      expect(rows[0]).toEqual({
        auth_owner: 'app_owner',
        definer_create: true,
        owner_default_acl: true,
        same_db_owner: true,
        owner_is_db_owner: false,
        owner_db_create: false,
      });
    } finally {
      await c.end();
    }
  });
```
4. Trong các ca có sẵn: bỏ `afterAll` cũ (re-up trên DB chung không còn cần); mọi `catalogSnapshot()` thành `catalogSnapshot(scratch.name)`; `assertEachMigrationRevertsCleanly(coreMigrationList(), scratch.name)` và `(fixtureMigrationList(), scratch.name, FIXTURE_MIGRATIONS_TABLE)`. Ca `refuses to run without DB_MIGRATION_HOST` giữ nguyên.

- [ ] **Step 6: Catalog phần role và quyền của `tenancy_definer`**

Sửa `test/integration/core/database/rls-catalog.spec.ts`:
- Ca `no application role bypasses RLS (and all four roles exist)` → đổi tên `… (and all five roles exist)`, danh sách role thêm `'tenancy_definer'` (theo thứ tự tên), mong đợi thêm `{ rolname: 'tenancy_definer', rolbypassrls: false }`.
- Thêm ca:
```ts
  it('tenancy_definer cannot log in and app_owner holds it WITH INHERIT FALSE, SET TRUE (spec §6.13, T2)', async () => {
    const { rows } = await client.query(
      `SELECT r.rolcanlogin, m.inherit_option, m.set_option
       FROM pg_roles r
       JOIN pg_auth_members m ON m.roleid = r.oid
       JOIN pg_roles u ON u.oid = m.member AND u.rolname = 'app_owner'
       WHERE r.rolname = 'tenancy_definer'`,
    );
    expect(rows).toEqual([
      { rolcanlogin: false, inherit_option: false, set_option: true },
    ]);
  });
```
- `EXPECTED_PRIVS` thêm (sau `auth_user`):
```ts
  {
    role: 'tenancy_definer',
    public_usage: true,
    public_create: true,
    auth_usage: false,
    auth_create: false,
    db_connect: false,
    db_temp: false,
  },
```

- [ ] **Step 7: CI lấy đủ lịch sử cho so sánh với `main`**

`.github/workflows/ci.yml`, job `checks`, bước checkout:
```yaml
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        # migration-order.spec.ts so migration mới của nhánh với migration mới nhất của origin/main (spec SP3 §6.13).
        with: { fetch-depth: 0 }
```

- [ ] **Step 8: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/database/migrations.spec.ts test/integration/core/database/rls-catalog.spec.ts
```
Expected: PASS; `migrations.spec.ts` in thời gian (dự kiến chậm hơn vài giây vì bootstrap database riêng). Ca `re-running the init script …` (rls-catalog) xanh với role mới.

- [ ] **Step 9: Commit**

```bash
git add test/support/tenancy-catalog.ts test/unit/migrations test/integration/core/database/migrations.spec.ts test/integration/core/database/rls-catalog.spec.ts .github/workflows/ci.yml
git commit -m "test(db): run migration round-trips on their own database; static migration scan and timestamp order; tenancy_definer catalog"
```

---

### Task 5: `core/context` — `orgAccess` trong context và log; `core/http` — `RateLimitBuckets` và `PreAuthRateLimiter` viết lại trên nó

**Files:**
- Create: `src/core/context/org-access.ts`, `src/core/http/rate-limit-buckets.ts`, `test/unit/core/http/rate-limit-buckets.spec.ts`, `test/integration/core/http/rate-limit-buckets.spec.ts`, `test/unit/core/context/org-access.spec.ts`
- Modify: `src/core/context/context.keys.ts`, `src/core/context/request-context.ts`, `src/core/context/index.ts`, `src/core/logging/logging.module.ts`, `src/core/http/rate-limiter.storage.ts`, `src/core/http/pre-auth-rate-limiter.ts`, `src/core/http/http.module.ts`, `src/core/http/index.ts`, `test/unit/core/http/pre-auth-rate-limiter.spec.ts`, `test/unit/core/logging/context-log-fields.spec.ts`

**Interfaces:**
- Consumes: `RateLimiterThrottlerStorage`, `rateLimitKey`, `clientIpTracker`, `throttleConfig` (SP1/SP2).
- Produces:
  - `ORG_ACCESS_VIAS = ['MEMBERSHIP', 'SUPPORT_GRANT', 'ORG_API_KEY'] as const`, `type OrgAccessVia`, `type OrgAccess = { via: OrgAccessVia; ref: string; permissions: readonly string[]; orgDeleted: boolean }` (export `core/context`).
  - `RequestContext.orgAccess(): OrgAccess | undefined`, `RequestContext.setOrgAccess(a: OrgAccess): void`.
  - `contextLogFields` thêm khoá `'org.access.via'`, `'org.access.ref'`.
  - `RateLimiterThrottlerStorage.peek(key, ttlMs, limit, blockMs, name): Promise<BucketDecision>`; `type BucketDecision = { blocked: false } | { blocked: true; retryAfterSec: number }`.
  - `RateLimitBuckets.register(def: { owner; name; ttlMs; limit; refundable: true }): RefundableRateLimitBucket` và `(… refundable: false): RateLimitBucket`; `RateLimitBucket = { readonly name: string; peek(key): Promise<BucketDecision>; consume(key): Promise<BucketDecision> }`, `RefundableRateLimitBucket = RateLimitBucket & { refund(key): Promise<void> }`. Tên trong storage `<owner>.<name>`; đăng ký trùng → ném lúc boot. Export `core/http`.
  - `PreAuthRateLimiter(buckets: RateLimitBuckets, cfg)`; bucket `core.pre-auth`, `refundable: true`; API `consume(req)`/`refund(req)` giữ nguyên hành vi S2-R51/R53.

- [ ] **Step 1: Test `orgAccess` trong context và log (fail)**

`test/unit/core/context/org-access.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';
import { contextLogFields } from '../../../../src/core/logging/index.js';

describe('RequestContext.orgAccess (spec SP3 §5.2, SEC-M11)', () => {
  it('stores the decision of the org middleware and logs via/ref (never the permission list)', async () => {
    const mod = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [RequestContext],
    }).compile();
    const ctx = mod.get(RequestContext);
    const cls = mod.get(ClsService);
    await ctx.run({ requestId: 'r1' }, async () => {
      expect(ctx.orgAccess()).toBeUndefined();
      ctx.setOrgAccess({
        via: 'MEMBERSHIP',
        ref: '0190a1b2-0000-7000-8000-000000000001',
        permissions: ['org.read'],
        orgDeleted: false,
      });
      expect(ctx.orgAccess()?.permissions).toEqual(['org.read']);
      const fields = contextLogFields(cls);
      expect(fields).toMatchObject({
        'org.access.via': 'MEMBERSHIP',
        'org.access.ref': '0190a1b2-0000-7000-8000-000000000001',
      });
      expect(JSON.stringify(fields)).not.toContain('org.read');
    });
  });
  it('rejects an unknown via at write time (fail loud)', async () => {
    const mod = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [RequestContext],
    }).compile();
    const ctx = mod.get(RequestContext);
    await ctx.run({}, async () => {
      expect(() =>
        ctx.setOrgAccess({
          via: 'BACKDOOR' as 'MEMBERSHIP',
          ref: 'x',
          permissions: [],
          orgDeleted: false,
        }),
      ).toThrow('Unknown org access via "BACKDOOR"');
    });
  });
});
```
(`as 'MEMBERSHIP'` chỉ trong test để giả lập giá trị ngoài kiểu từ JS thuần.)

Run: `pnpm vitest run --project unit test/unit/core/context/org-access.spec.ts`
Expected: FAIL `ctx.orgAccess is not a function`.

- [ ] **Step 2: Cài đặt `orgAccess`**

`src/core/context/org-access.ts`:
```ts
/** Nguồn cấp quyền trong một org (spec SP3 §5.2). `SUPPORT_GRANT`, `ORG_API_KEY` có từ plan 3D. */
export const ORG_ACCESS_VIAS = [
  'MEMBERSHIP',
  'SUPPORT_GRANT',
  'ORG_API_KEY',
] as const;
export type OrgAccessVia = (typeof ORG_ACCESS_VIAS)[number];
/**
 * Quyết định của `OrgContextMiddleware` cho request tenant, tính một lần và đọc lại ở guard. `ref` là public id của
 * member/grant/key (không phải PII), vào mọi dòng log. `permissions` không bao giờ vào log.
 */
export type OrgAccess = {
  via: OrgAccessVia;
  ref: string;
  permissions: readonly string[];
  orgDeleted: boolean;
};
export const isOrgAccessVia = (v: string): v is OrgAccessVia =>
  (ORG_ACCESS_VIAS as readonly string[]).includes(v);
```
`src/core/context/context.keys.ts`: thêm `orgAccess: 'core:orgAccess',` vào `CTX` (sau `credential`).
`src/core/context/request-context.ts`: import `isOrgAccessVia, type OrgAccess` từ `./org-access.js`, thêm:
```ts
  orgAccess(): OrgAccess | undefined {
    return this.read<OrgAccess>(CTX.orgAccess);
  }
  setOrgAccess(a: OrgAccess): void {
    if (!isOrgAccessVia(a.via))
      throw new Error(`Unknown org access via "${String(a.via)}"`);
    this.cls.set(CTX.orgAccess, a);
  }
```
`src/core/context/index.ts` thêm:
```ts
export {
  ORG_ACCESS_VIAS,
  type OrgAccess,
  type OrgAccessVia,
} from './org-access.js';
```
`src/core/logging/logging.module.ts`, trong `contextLogFields`:
```ts
export function contextLogFields(cls: ClsService): Record<string, unknown> {
  if (!cls.isActive()) return {};
  const access: unknown = cls.get(CTX.orgAccess);
  const via =
    typeof access === 'object' && access !== null && 'via' in access
      ? access.via
      : undefined;
  const ref =
    typeof access === 'object' && access !== null && 'ref' in access
      ? access.ref
      : undefined;
  return {
    requestId: cls.get(CTX.requestId),
    traceId: cls.get(CTX.traceId),
    orgId: cls.get(CTX.orgId),
    jobId: cls.get(CTX.jobId),
    credential: cls.get(CTX.credential),
    'org.access.via': via,
    'org.access.ref': ref,
  };
}
```
`test/unit/core/logging/context-log-fields.spec.ts`: giữ nguyên (dùng `toMatchObject`, khoá mới là `undefined`).

Run: `pnpm vitest run --project unit test/unit/core/context test/unit/core/logging`
Expected: PASS (gồm `context-keys.spec.ts`: khoá mới không có `.`).

- [ ] **Step 3: Test `RateLimitBuckets` (unit, fail)**

`test/unit/core/http/rate-limit-buckets.spec.ts`:
```ts
import type { ThrottlerStorage } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientIpTracker,
  rateLimitKey,
} from '../../../../src/core/http/client-ip.js';
import { RateLimitBuckets } from '../../../../src/core/http/rate-limit-buckets.js';
import { RateLimiterThrottlerStorage } from '../../../../src/core/http/rate-limiter.storage.js';

type Rec = Awaited<ReturnType<ThrottlerStorage['increment']>>;
const record = (over: Partial<Rec>): Rec => ({
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...over,
});
const redis = new Redis({ lazyConnect: true });
const storage = new RateLimiterThrottlerStorage(redis, 'unit');
const def = { ttlMs: 60000, limit: 30 };

describe('RateLimitBuckets (spec SP3 §5.2, SEC2-N5)', () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => redis.disconnect());

  it('refuses a storage that is not the SP1 RateLimiterThrottlerStorage', () => {
    const other: ThrottlerStorage = { increment: async () => record({}) };
    expect(() => new RateLimitBuckets(other)).toThrow(
      'RateLimitBuckets requires the RateLimiterThrottlerStorage of HttpModule',
    );
  });
  it('names a bucket <owner>.<name>, refuses duplicates and malformed parts at registration', () => {
    const buckets = new RateLimitBuckets(storage);
    expect(buckets.register({ owner: 'tenancy', name: 'org-miss', refundable: false, ...def }).name).toBe('tenancy.org-miss');
    expect(() => buckets.register({ owner: 'tenancy', name: 'org-miss', refundable: false, ...def })).toThrow(
      'Rate limit bucket "tenancy.org-miss" is already registered',
    );
    for (const bad of [{ owner: 'Tenancy', name: 'x' }, { owner: 'tenancy', name: 'a.b' }, { owner: '', name: 'x' }])
      expect(() => buckets.register({ ...bad, refundable: false, ...def })).toThrow(/must match/);
    expect(() => buckets.register({ owner: 'core', name: 'z', refundable: false, ttlMs: 60000, limit: 0 })).toThrow(/limit/);
  });
  it('hashes the caller key under the bucket name and never exposes other buckets', async () => {
    const increment = vi.spyOn(storage, 'increment').mockResolvedValue(record({}));
    const peek = vi.spyOn(storage, 'peek').mockResolvedValue({ blocked: false });
    const b = new RateLimitBuckets(storage).register({ owner: 'tenancy', name: 'org-miss', refundable: false, ...def });
    const tracker = 'principal:user:u1';
    await b.peek(tracker);
    await b.consume(tracker);
    const key = rateLimitKey('tenancy.org-miss', tracker);
    expect(peek).toHaveBeenCalledWith(key, 60000, 30, 60000, 'tenancy.org-miss');
    expect(increment).toHaveBeenCalledWith(key, 60000, 30, 60000, 'tenancy.org-miss');
    expect('refund' in b).toBe(false);
  });
  it('consume reports a block instead of throwing; the caller decides the response', async () => {
    vi.spyOn(storage, 'increment').mockResolvedValue(record({ isBlocked: true, timeToBlockExpire: 42 }));
    const b = new RateLimitBuckets(storage).register({ owner: 'core', name: 'x', refundable: true, ...def });
    await expect(b.consume(clientIpTracker('198.51.100.9'))).resolves.toEqual({ blocked: true, retryAfterSec: 42 });
  });
});
```

- [ ] **Step 4: Cài đặt `peek` và `RateLimitBuckets`**

`src/core/http/rate-limiter.storage.ts` — thêm sau `refund`:
```ts
  /**
   * Chỉ đọc (spec SP3 §5.2, P-3): `get` của rate-limiter-flexible không tăng bộ đếm; lỗi Redis rơi sang insurance như
   * `consume` (`RateLimiterInsuredAbstract.get`). Bị khoá khi số điểm đã tiêu vượt `limit` (limiter giữ khoá tới hết
   * `blockDuration`). Cả Redis lẫn insurance lỗi → 503 như `increment`.
   */
  async peek(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<BucketDecision> {
    const l = this.limiter(throttlerName, ttl, limit, blockDuration);
    let res: RateLimiterRes | null;
    try {
      res = await l.get(key);
    } catch (err) {
      throw this.unavailable(err, ttl);
    }
    if (res === null || res.consumedPoints <= limit) return { blocked: false };
    return { blocked: true, retryAfterSec: toSec(res.msBeforeNext) };
  }
```
và khai báo kiểu ở đầu file (sau `toSec`):
```ts
/** Kết quả của một lần hỏi/đếm của bucket (`RateLimitBuckets`). */
export type BucketDecision =
  | { blocked: false }
  | { blocked: true; retryAfterSec: number };
```

`src/core/http/rate-limit-buckets.ts`:
```ts
import { Injectable } from '@nestjs/common';
import {
  InjectThrottlerStorage,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { rateLimitKey } from './client-ip.js';
import {
  RateLimiterThrottlerStorage,
  type BucketDecision,
} from './rate-limiter.storage.js';

export type { BucketDecision };
/** Không có `.`: dấu `.` nối `<owner>.<name>`, nên tên bucket không bao giờ trùng throttler của `@Throttle`/`default`. */
const PART = /^[a-z][a-z0-9-]{0,31}$/;

export type BucketDef = {
  owner: string;
  name: string;
  ttlMs: number;
  limit: number;
};
/**
 * Ngữ nghĩa của `limit` (hợp đồng cho mọi caller, review I4): `limit` = số lần tiêu điểm được phép trước khi bị khoá.
 * `peek` chỉ báo `blocked` khi số điểm đã tiêu VƯỢT `limit` (`consumedPoints > limit`). Caller theo mẫu "peek → làm việc →
 * consume khi trượt" (như `OrgContextMiddleware`) vì vậy trả lỗi thường (vd. `404`) cho cả lần thứ `limit + 1` — lần
 * consume làm vượt ngưỡng — và chỉ từ lần `limit + 2` mới nhận `429` ở `peek`. Không đổi `peek` thành `>=`.
 */
export interface RateLimitBucket {
  readonly name: string;
  /** Chỉ đọc: không bao giờ tiêu điểm. `blocked` khi số điểm đã tiêu > `limit`. */
  peek(key: string): Promise<BucketDecision>;
  /** Tiêu một điểm; lần làm vượt ngưỡng trả `blocked` (không ném): caller quyết định response. */
  consume(key: string): Promise<BucketDecision>;
}
export interface RefundableRateLimitBucket extends RateLimitBucket {
  refund(key: string): Promise<void>;
}

/**
 * Bucket rate limit ngoài `@Throttle` (spec SP3 §5.2): tham số decorator được đánh giá lúc import (trước khi config
 * nạp), và `@nestjs/throttler` chỉ được import trong `core/http`. Mỗi module đăng ký bucket của mình MỘT lần lúc
 * khởi tạo provider và giữ handle; không có API nào thao tác bucket theo tên, nên không module nào hoàn điểm bucket
 * của module khác (SEC2-N5). Cùng storage của SP1: khoá băm (`rateLimitKey`), insurance theo pod khi Redis lỗi, 503
 * khi cả hai lỗi. `refund` chỉ có trên bucket đăng ký `refundable: true`.
 */
@Injectable()
export class RateLimitBuckets {
  private readonly storage: RateLimiterThrottlerStorage;
  private readonly names = new Set<string>();

  constructor(@InjectThrottlerStorage() storage: ThrottlerStorage) {
    if (!(storage instanceof RateLimiterThrottlerStorage))
      throw new Error(
        'RateLimitBuckets requires the RateLimiterThrottlerStorage of HttpModule',
      );
    this.storage = storage;
  }

  register(def: BucketDef & { refundable: true }): RefundableRateLimitBucket;
  register(def: BucketDef & { refundable: false }): RateLimitBucket;
  register(
    def: BucketDef & { refundable: boolean },
  ): RateLimitBucket | RefundableRateLimitBucket {
    if (!PART.test(def.owner) || !PART.test(def.name))
      throw new Error(
        `Rate limit bucket owner and name must match ${PART}, got "${def.owner}.${def.name}"`,
      );
    if (!Number.isInteger(def.limit) || def.limit < 1)
      throw new Error(
        `Rate limit bucket "${def.owner}.${def.name}" limit must be a positive integer`,
      );
    const name = `${def.owner}.${def.name}`;
    if (this.names.has(name))
      throw new Error(`Rate limit bucket "${name}" is already registered`);
    this.names.add(name);
    const { storage } = this;
    const { ttlMs, limit } = def;
    const keyOf = (key: string) => rateLimitKey(name, key);
    const bucket: RateLimitBucket = {
      name,
      peek: (key) => storage.peek(keyOf(key), ttlMs, limit, ttlMs, name),
      consume: async (key) => {
        const r = await storage.increment(keyOf(key), ttlMs, limit, ttlMs, name);
        return r.isBlocked
          ? { blocked: true, retryAfterSec: r.timeToBlockExpire }
          : { blocked: false };
      },
    };
    if (!def.refundable) return bucket;
    return {
      ...bucket,
      refund: (key) => storage.refund(keyOf(key), ttlMs, limit, ttlMs, name),
    };
  }
}
```

`src/core/http/pre-auth-rate-limiter.ts` — thay constructor và hai phương thức (giữ chú thích lớp):
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { clientIpTracker } from './client-ip.js';
import {
  RateLimitBuckets,
  type RefundableRateLimitBucket,
} from './rate-limit-buckets.js';
import { throttleConfig } from './throttle.config.js';

@Injectable()
export class PreAuthRateLimiter {
  private readonly logger = new Logger(PreAuthRateLimiter.name);
  private readonly bucket: RefundableRateLimitBucket;

  /**
   * Bucket `core.pre-auth` (spec SP3 §5.2): cùng storage và hành vi S2-R51/R53. Đổi tên trong storage (trước đây
   * `pre-auth`) làm bộ đếm pre-auth về 0 một lần lúc deploy: chấp nhận được.
   */
  constructor(
    buckets: RateLimitBuckets,
    @Inject(throttleConfig.KEY) cfg: ConfigOf<typeof throttleConfig>,
  ) {
    this.bucket = buckets.register({
      owner: 'core',
      name: 'pre-auth',
      ttlMs: cfg.preAuthTtlMs,
      limit: cfg.preAuthLimit,
      refundable: true,
    });
  }

  async consume(req: { ip?: unknown }): Promise<void> {
    const d = await this.bucket.consume(clientIpTracker(req.ip));
    if (d.blocked)
      throw new AppError(CoreErrors.RATE_LIMITED, {
        headers: { 'Retry-After': String(d.retryAfterSec) },
        expected: true,
      });
  }

  /** IP không xác định vẫn ném ở `clientIpTracker` TRƯỚC `try` (như bản cũ ném ở `keyOf`): không phải lỗi hoàn điểm. */
  async refund(req: { ip?: unknown }): Promise<void> {
    const tracker = clientIpTracker(req.ip);
    try {
      await this.bucket.refund(tracker);
    } catch (err) {
      this.logger.warn(
        {
          event: 'pre_auth_refund_failed',
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        },
        'pre-authentication rate limit refund failed; the limit stays stricter',
      );
    }
  }
}
```
`src/core/http/http.module.ts`: thêm `RateLimitBuckets` vào `providers` và `exports` (trước `PreAuthRateLimiter`). `src/core/http/index.ts` thêm:
```ts
export {
  RateLimitBuckets,
  type BucketDecision,
  type BucketDef,
  type RateLimitBucket,
  type RefundableRateLimitBucket,
} from './rate-limit-buckets.js';
```

- [ ] **Step 5: Sửa test của `PreAuthRateLimiter` theo bucket**

`test/unit/core/http/pre-auth-rate-limiter.spec.ts`:
- import thêm `RateLimitBuckets` từ `../../../../src/core/http/rate-limit-buckets.js`;
- `const limiter = () => new PreAuthRateLimiter(new RateLimitBuckets(storage), cfg);`
- ca "refuses a storage that cannot refund" đổi thành: `expect(() => new PreAuthRateLimiter(new RateLimitBuckets(other), cfg)).toThrow('RateLimitBuckets requires the RateLimiterThrottlerStorage of HttpModule');`
- ca "counts per client IP…": `const key = rateLimitKey('core.pre-auth', clientIpTracker('2001:db8::1'));` và hai kỳ vọng `…toHaveBeenCalledWith(key, 30000, 3, 30000, 'core.pre-auth')`.
Các ca còn lại giữ nguyên (mỗi `limiter()` dựng `RateLimitBuckets` mới nên không trùng đăng ký).

- [ ] **Step 6: Test tích hợp trên Redis thật (peek không tiêu điểm, chặn, insurance)**

`test/integration/core/http/rate-limit-buckets.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimitBuckets } from '../../../../src/core/http/rate-limit-buckets.js';
import { RateLimiterThrottlerStorage } from '../../../../src/core/http/rate-limiter.storage.js';
import { getInfra } from '../../../support/infra.js';

const LIMIT = 3;
const TTL_MS = 60_000;

describe('RateLimitBuckets on Redis (spec SP3 §7.1 step 3.5, P-3)', () => {
  const ns = `t${randomBytes(4).toString('hex')}`;
  let redis: Redis;
  let buckets: RateLimitBuckets;
  beforeAll(() => {
    redis = new Redis(getInfra().redis.url, { maxRetriesPerRequest: 1 });
    buckets = new RateLimitBuckets(new RateLimiterThrottlerStorage(redis, ns));
  });
  afterAll(async () => {
    const keys = await redis.keys(`${ns}-*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('peek never spends a point, even under 2 x limit parallel calls; only consume counts and then blocks', async () => {
    const b = buckets.register({ owner: 'tenancy', name: 'org-miss', ttlMs: TTL_MS, limit: LIMIT, refundable: false });
    const decisions = await Promise.all(Array.from({ length: 2 * LIMIT }, () => b.peek('principal:user:a')));
    expect(decisions.every((d) => !d.blocked)).toBe(true);
    for (let i = 0; i < LIMIT; i++) expect(await b.consume('principal:user:a')).toEqual({ blocked: false });
    const over = await b.consume('principal:user:a');
    expect(over.blocked).toBe(true);
    const peeked = await b.peek('principal:user:a');
    expect(peeked.blocked).toBe(true);
    expect(peeked.blocked && peeked.retryAfterSec).toBeGreaterThan(0);
    expect(await b.peek('principal:user:b')).toEqual({ blocked: false });
  });
  it('two owners with the same name never share a counter', async () => {
    const x = buckets.register({ owner: 'alpha', name: 'shared', ttlMs: TTL_MS, limit: 1, refundable: false });
    const y = buckets.register({ owner: 'beta', name: 'shared', ttlMs: TTL_MS, limit: 1, refundable: false });
    await x.consume('k');
    await x.consume('k');
    expect((await x.peek('k')).blocked).toBe(true);
    expect((await y.peek('k')).blocked).toBe(false);
  });
});
```

- [ ] **Step 7: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/core
pnpm vitest run --project integration test/integration/core/http test/e2e/identity/principal-guard.e2e.spec.ts
```
Expected: PASS; e2e của pre-auth (S2-R51/R53 trong `principal-guard.e2e.spec.ts`) vẫn xanh với bucket mới.

- [ ] **Step 8: Commit**

```bash
git add src/core/context src/core/logging/logging.module.ts src/core/http test/unit/core test/integration/core/http/rate-limit-buckets.spec.ts
git commit -m "feat(core): orgAccess in the request context and logs; owned RateLimitBuckets with peek, pre-auth on top of it"
```

---

### Task 6: `core/queue` — `JobDef.onInactiveOrg`, port `OrgActivityGate`, gate trong `WorkerHost`, metric `queue_jobs_skipped_total`

**Files:**
- Create: `src/core/queue/org-activity-gate.ts`, `test/integration/core/queue/worker-org-gate.spec.ts`
- Modify: `src/core/queue/job-definition.ts`, `src/core/queue/worker-host.ts`, `src/core/queue/index.ts`, `src/core/observability/queue-metrics.ts`, `src/core/outbox/outbox.jobs.ts`, `src/core/events/event-dispatch.handlers.ts`, `src/modules/notifications/jobs.ts`, `test/unit/core/queue/job-definition.spec.ts`

**Interfaces:**
- Consumes: `WorkerHost`, `OrgScope`, `QueueMetrics` (SP1).
- Produces:
  - `ON_INACTIVE_ORG = ['skip', 'run'] as const`, `type OnInactiveOrg`, `type OrgActivity = { kind: 'ACTIVE' } | { kind: 'DELETED'; deletedAt: Date } | { kind: 'GONE' }`, `abstract class OrgActivityGate { abstract check(): Promise<OrgActivity> }` (export `core/queue`).
  - `JobDef.onInactiveOrg: OnInactiveOrg` (mặc định `'skip'` trong `defineJob`).
  - `WorkerHost` inject `@Optional() OrgActivityGate`; job có `meta.orgId` + `'skip'` + gate có mặt: gọi `check()` **trong** `OrgScope`, trước handler; khác `ACTIVE` → không gọi handler, job `completed`, log INFO `job_skipped_org_inactive` hoặc WARN `job_skipped_org_inactive_after_delete` (`GONE`, hoặc `job.timestamp > deletedAt`), metric `queue_jobs_skipped_total{reason="org_inactive"}`. Gate ném → job lỗi (BullMQ retry).
  - `'run'`: `core.event.dispatch`, `core.event.deliver`, `notifications.send-email` (plan này), `tenancy.org.purge` (Task 25).
  - `QueueMetrics.skipped(reason: 'org_inactive'): void`.

- [ ] **Step 1: Test đơn vị của `defineJob` (fail)**

Thêm vào `test/unit/core/queue/job-definition.spec.ts`:
```ts
describe('onInactiveOrg (spec SP3 §5.2, S3-A45)', () => {
  it('defaults to skip and keeps an explicit run', () => {
    const q = defineQueue('unit-inactive', { kind: 'io' });
    expect(defineJob({ name: 'unit.inactive.default', queue: q, version: 1, schema: z.object({}) }).onInactiveOrg).toBe('skip');
    expect(defineJob({ name: 'unit.inactive.run', queue: q, version: 1, schema: z.object({}), onInactiveOrg: 'run' }).onInactiveOrg).toBe('run');
  });
  it('the event relay jobs and the email sender declare run', async () => {
    const { DispatchEventJob } = await import('../../../../src/core/outbox/outbox.jobs.js');
    const { DeliverEventJob } = await import('../../../../src/core/events/event-dispatch.handlers.js');
    const { SendEmailJob } = await import('../../../../src/modules/notifications/jobs.js');
    expect([DispatchEventJob, DeliverEventJob, SendEmailJob].map((j) => j.onInactiveOrg)).toEqual(['run', 'run', 'run']);
  });
});
```
(dùng `defineQueue`, `defineJob`, `z` đã import ở đầu file; nếu chưa có thì thêm import từ `../../../../src/core/queue/index.js` và `zod`.)

Run: `pnpm vitest run --project unit test/unit/core/queue/job-definition.spec.ts`
Expected: FAIL (`onInactiveOrg` undefined).

- [ ] **Step 2: Port và trường của `JobDef`**

`src/core/queue/org-activity-gate.ts`:
```ts
export const ON_INACTIVE_ORG = ['skip', 'run'] as const;
export type OnInactiveOrg = (typeof ON_INACTIVE_ORG)[number];
/**
 * Trạng thái org của job lúc bắt đầu (spec SP3 §5.2, R4A-N4): trả LÝ DO (không `boolean`) để job khai sai không
 * im lặng — `WorkerHost` log WARN khi org đã mất hoặc job được enqueue sau khi org bị xoá mềm.
 */
export type OrgActivity =
  | { kind: 'ACTIVE' }
  | { kind: 'DELETED'; deletedAt: Date }
  | { kind: 'GONE' };
/**
 * Port của core, module tenancy cài (`TenancyQueuePortsModule`, `@Global`, chỉ trong `forWorker()`). Được gọi BÊN
 * TRONG `OrgScope` của job; lỗi hạ tầng thì ném (BullMQ retry theo backoff), không bao giờ đoán là `ACTIVE`.
 */
export abstract class OrgActivityGate {
  abstract check(): Promise<OrgActivity>;
}
```
`src/core/queue/job-definition.ts`:
- import `type OnInactiveOrg` từ `./org-activity-gate.js`;
- `JobDef` thêm `readonly onInactiveOrg: OnInactiveOrg;` (sau `tenantSchedulable`) kèm chú thích: `/** Org của job (meta.orgId) không còn hoạt động lúc job bắt đầu: 'skip' (mặc định) bỏ qua, 'run' vẫn chạy (spec SP3 §5.2). */`;
- `defineJob` nhận thêm `onInactiveOrg?: OnInactiveOrg;` và dựng:
```ts
  const full: JobDef<S> = {
    ...def,
    tenantSchedulable: def.tenantSchedulable ?? false,
    onInactiveOrg: def.onInactiveOrg ?? 'skip',
  };
```
`src/core/queue/index.ts` thêm:
```ts
export {
  ON_INACTIVE_ORG,
  OrgActivityGate,
  type OnInactiveOrg,
  type OrgActivity,
} from './org-activity-gate.js';
```
Ba job `'run'`:
- `src/core/outbox/outbox.jobs.ts` `DispatchEventJob`: thêm `onInactiveOrg: 'run',` kèm chú thích `// Chỉ chuyển tiếp (spec SP3 §5.2, INT3-1): bị bỏ qua thì event của org vừa xoá mềm/purge mất vĩnh viễn; job con tự chịu gate của mình.`
- `src/core/events/event-dispatch.handlers.ts` `DeliverEventJob`: thêm `onInactiveOrg: 'run',` kèm `// Event của chính thao tác xoá mềm/xoá cứng phải tới subscriber (spec SP3 §5.2).`
- `src/modules/notifications/jobs.ts` `SendEmailJob`: thêm `onInactiveOrg: 'run',` kèm `// Dòng email_deliveries đã nhận phải tới trạng thái cuối, không thì đối soát enqueue lại mãi (spec SP3 §5.2).`

Run: `pnpm vitest run --project unit test/unit/core/queue/job-definition.spec.ts`
Expected: PASS.

- [ ] **Step 3: Test tích hợp của gate trong `WorkerHost` (fail)**

`test/integration/core/queue/worker-org-gate.spec.ts`:
```ts
import {
  Global,
  Injectable,
  Logger,
  Module,
  type INestApplication,
} from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RequestContext } from '../../../../src/core/context/index.js';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import {
  JobHandler,
  JobQueue,
  OrgActivityGate,
  QueueModule,
  defineJob,
  defineQueue,
  type JobContext,
  type OrgActivity,
} from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const GateQueue = defineQueue('gate-fixture', { kind: 'io' });
const SkipJob = defineJob({ name: 'gate.skip', queue: GateQueue, version: 1, schema: z.object({ k: z.string() }) });
const RunJob = defineJob({ name: 'gate.run', queue: GateQueue, version: 1, schema: z.object({ k: z.string() }), onInactiveOrg: 'run' });
const handled: string[] = [];
/** Trạng thái org của gate giả (không DB) và org của OrgScope mỗi lần gate chạy. */
const state = new Map<string, OrgActivity>();
const calls: (string | undefined)[] = [];

@Injectable()
@JobHandler(SkipJob)
class SkipHandler {
  async handle(c: JobContext<{ k: string }>) {
    handled.push(c.payload.k);
  }
}
@Injectable()
@JobHandler(RunJob)
class RunHandler {
  async handle(c: JobContext<{ k: string }>) {
    handled.push(c.payload.k);
  }
}
@Injectable()
class FakeGate extends OrgActivityGate {
  constructor(private readonly ctx: RequestContext) {
    super();
  }
  async check(): Promise<OrgActivity> {
    const org = this.ctx.orgId();
    calls.push(org);
    return (org ? state.get(org) : undefined) ?? { kind: 'ACTIVE' };
  }
}
/**
 * `@Global()`: `WorkerHost` nằm trong `QueueModule` (global) và resolve `@Optional()` theo phạm vi module của nó, nên
 * provider gate phải global — cùng lý do tenancy cài gate trong một module `@Global()` (spec §5.2, INT3-5b).
 */
@Global()
@Module({ providers: [FakeGate, { provide: OrgActivityGate, useExisting: FakeGate }], exports: [OrgActivityGate] })
class GateModule {}
@Module({ providers: [SkipHandler, RunHandler] })
class Handlers {}

type SkipLog = { event: string; jobId: string };
const isSkipLog = (v: unknown): v is SkipLog =>
  typeof v === 'object' && v !== null && 'event' in v && 'jobId' in v &&
  typeof v.event === 'string' && v.event.startsWith('job_skipped') && typeof v.jobId === 'string';
const until = async (pred: () => boolean, ms = 15_000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const base = () => [DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: true }), Handlers];

describe('WorkerHost org activity gate (spec SP3 §5.2, §5.3)', () => {
  afterEach(() => {
    handled.length = 0;
    calls.length = 0;
    state.clear();
    vi.restoreAllMocks();
  });

  describe('with a gate', () => {
    let app: INestApplication;
    beforeAll(async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'gate-fixture');
      app = await createTestApp([...base(), GateModule]);
    });
    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });

    it('an active org runs the handler, and the gate ran inside the OrgScope of the job', async () => {
      const org = v7();
      await app.get(JobQueue).enqueue(SkipJob, { k: 'active' }, { meta: { orgId: org } });
      await until(() => handled.includes('active'));
      expect(calls).toEqual([org]);
    });
    it('DELETED before enqueue → INFO; enqueued after deletedAt or GONE → WARN; handler never runs', async () => {
      const log = vi.spyOn(Logger.prototype, 'log');
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const [before, after, gone] = [v7(), v7(), v7()];
      state.set(before, { kind: 'DELETED', deletedAt: new Date(Date.now() + 60_000) });
      state.set(after, { kind: 'DELETED', deletedAt: new Date(Date.now() - 60_000) });
      state.set(gone, { kind: 'GONE' });
      const q = app.get(JobQueue);
      const ids = [
        await q.enqueue(SkipJob, { k: 'before' }, { meta: { orgId: before } }),
        await q.enqueue(SkipJob, { k: 'after' }, { meta: { orgId: after } }),
        await q.enqueue(SkipJob, { k: 'gone' }, { meta: { orgId: gone } }),
      ];
      const skipped = () => [...log.mock.calls, ...warn.mock.calls].map((c) => c[0]).filter(isSkipLog);
      await until(() => skipped().length >= 3);
      expect(handled).toEqual([]);
      const byId = new Map(skipped().map((s) => [s.jobId, s.event]));
      expect(ids.map((id) => byId.get(id))).toEqual([
        'job_skipped_org_inactive',
        'job_skipped_org_inactive_after_delete',
        'job_skipped_org_inactive_after_delete',
      ]);
    });
    it("onInactiveOrg: 'run' runs even when the org is gone; a job without orgId never asks the gate", async () => {
      const org = v7();
      state.set(org, { kind: 'GONE' });
      await app.get(JobQueue).enqueue(RunJob, { k: 'run-gone' }, { meta: { orgId: org } });
      await app.get(JobQueue).enqueue(SkipJob, { k: 'no-org' });
      await until(() => handled.includes('run-gone') && handled.includes('no-org'));
      expect(calls).toEqual([]);
    });
  });

  describe('without a gate provider', () => {
    let app: INestApplication;
    beforeAll(async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'gate-fixture');
      app = await createTestApp(base());
    });
    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });
    it('behaves as before: the handler runs', async () => {
      await app.get(JobQueue).enqueue(SkipJob, { k: 'legacy' }, { meta: { orgId: v7() } });
      await until(() => handled.includes('legacy'));
    });
  });
});
```

Run: `pnpm vitest run --project integration test/integration/core/queue/worker-org-gate.spec.ts`
Expected: FAIL (ca `DELETED`: handler vẫn chạy, `handled` khác rỗng).

- [ ] **Step 4: Metric và gate trong `WorkerHost`**

`src/core/observability/queue-metrics.ts` thêm vào `QueueMetrics`:
```ts
  private readonly skippedTotal: Counter = metrics
    .getMeter(METER)
    .createCounter('queue_jobs_skipped_total', {
      description:
        'Jobs completed without running their handler (reason=org_inactive: the organization was soft-deleted or purged)',
    });

  /** Label chỉ là lý do (tập đóng), không queue/org/job. */
  skipped(reason: 'org_inactive'): void {
    this.skippedTotal.add(1, { reason });
  }
```
`src/core/queue/worker-host.ts`:
- import `Optional` từ `@nestjs/common`; import `OrgActivityGate` từ `./org-activity-gate.js`;
- constructor thêm tham số cuối `@Optional() private readonly orgGate?: OrgActivityGate,`;
- trong `process`, thay `const run = …` bằng:
```ts
    const run = () =>
      withRemoteParent(meta.traceparent, `job ${job.name}`, async () => {
        this.ctx.setTraceId(currentTraceId());
        // Spec SP3 §5.2: kiểm BÊN TRONG OrgScope (meta.orgId), trước handler. Job đã bắt đầu thì chạy hết.
        if (await this.skippedForInactiveOrg(entry.def, job, meta)) return;
        await handle();
      });
```
- thêm hai phương thức:
```ts
  /** `true` = job kết thúc `completed` mà không gọi handler. Gate ném (lỗi hạ tầng) → lỗi của job, BullMQ retry. */
  private async skippedForInactiveOrg(
    def: JobDef,
    job: Job<JobData>,
    meta: JobMeta,
  ): Promise<boolean> {
    if (!meta.orgId || def.onInactiveOrg === 'run' || !this.orgGate)
      return false;
    const activity = await this.orgGate.check();
    switch (activity.kind) {
      case 'ACTIVE':
        return false;
      case 'DELETED':
        this.recordSkip(job, job.timestamp > activity.deletedAt.getTime());
        return true;
      case 'GONE':
        this.recordSkip(job, true);
        return true;
      default: {
        const unknown: never = activity;
        throw new Error(`unknown org activity ${JSON.stringify(unknown)}`);
      }
    }
  }

  /**
   * R4A-N4: org đã mất, hoặc job được enqueue SAU khi org bị xoá mềm, gần như chắc chắn là job phản ứng với vòng đời
   * org mà khai thiếu `onInactiveOrg: 'run'` → WARN. Job enqueue trước khi xoá mềm bị bỏ là hành vi mong đợi → INFO.
   */
  private recordSkip(job: Job<JobData>, suspicious: boolean): void {
    this.queueMetrics.skipped('org_inactive');
    const fields = {
      event: suspicious
        ? 'job_skipped_org_inactive_after_delete'
        : 'job_skipped_org_inactive',
      job: job.name,
      jobId: job.id,
    };
    if (suspicious)
      this.logger.warn(
        fields,
        "tenant job skipped after its organization was deleted; a job reacting to the org lifecycle must declare onInactiveOrg: 'run'",
      );
    else this.logger.log(fields, 'tenant job skipped: organization is not active');
  }
```

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/core/queue
pnpm vitest run --project integration test/integration/core/queue test/integration/core/outbox test/e2e/core/events.e2e.spec.ts
```
Expected: PASS; hành vi cũ không đổi khi không có gate (mọi test queue/outbox SP1 xanh).

- [ ] **Step 6: Commit**

```bash
git add src/core/queue src/core/observability/queue-metrics.ts src/core/outbox/outbox.jobs.ts src/core/events/event-dispatch.handlers.ts src/modules/notifications/jobs.ts test/unit/core/queue/job-definition.spec.ts test/integration/core/queue/worker-org-gate.spec.ts
git commit -m "feat(queue): onInactiveOrg and the OrgActivityGate port checked inside the job's OrgScope"
```

---

### Task 7: `core/scheduler` — cột `scheduled_tasks.suspended_at`, treo/khôi phục/xoá lịch của org hiện tại, reconciler bỏ lịch treo

**Files:**
- Create: `src/migrations/core/Migration<ts>_scheduled_tasks_suspended_at.ts` (CLI), `test/integration/core/database/suspended-at-down.spec.ts`
- Modify: `src/core/scheduler/scheduled-task.service.ts`, `src/core/scheduler/schedule-reconciler.ts`, `test/integration/core/scheduler/scheduler.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: `UnitOfWork.inTransaction()`, `Db`, `JobScheduler.listIds/upsert/remove`, `tenantTaskId`, `findJob` (SP1), `createScratchDb` (Task 2).
- Produces:
  - Cột `scheduled_tasks.suspended_at TIMESTAMPTZ NULL` (trạng thái của nền tảng; `enabled` vẫn là ý định của feature).
  - `ScheduledTaskService.suspendAllForCurrentOrg(): Promise<number>`, `resumeAllForCurrentOrg(): Promise<number>`, `removeAllForCurrentOrg(): Promise<number>` — **chỉ** ghi DB, **bắt buộc** chạy trong transaction đang mở của caller, trong `OrgScope` (không thì ném). `syncCurrentOrg(): Promise<{ upserted: number; removed: number }>` — gọi **sau** commit, đưa scheduler Redis của org hiện tại về khớp DB (`enabled AND suspended_at IS NULL`).
  - `upsert` đọc `RETURNING suspended_at`; dòng đang treo thì không đẩy lên Redis (gỡ id nếu có). Nhánh `ON CONFLICT DO UPDATE` không ghi `suspended_at`.
  - `ScheduleReconciler` chỉ upsert `WHERE enabled AND suspended_at IS NULL` (lịch treo bị gỡ như lịch tắt).

- [ ] **Step 1: Tạo migration bằng CLI**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/core --name scheduled_tasks_suspended_at`
Expected: file mới `src/migrations/core/Migration<ts>_scheduled_tasks_suspended_at.ts` với timestamp lớn hơn `20260928082958`.

- [ ] **Step 2: Test "down bị dữ liệu chặn" (fail vì migration còn rỗng)**

`test/integration/core/database/suspended-at-down.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationObject } from '../../../../src/core/database/index.js';
import { applyTestEnv } from '../../../support/app-factory.js';
import { coreMigrationList } from '../../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../../support/scratch-db.js';

/**
 * Spec SP3 §6.13 bảng 3A + "Test migration": `down` của `suspended_at` phải từ chối khi còn lịch của org xoá mềm,
 * vì bỏ cột sẽ làm lịch đó chạy lại. Chạy trên database riêng, migrate tới đúng migration này, nên không phụ thuộc các
 * migration sau (FK tới `organizations` ở Task 16).
 */
describe('down of …_scheduled_tasks_suspended_at refuses while a suspended schedule exists', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let previous: string;
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('suspdown');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_scheduled_tasks_suspended_at'));
    if (at < 1) throw new Error('suspended_at migration not found');
    list = all.slice(0, at + 1);
    previous = all[at - 1]!.name;
    await runMigrations('up', { source: { kind: 'list', list } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('a suspended row seeded by app_user inside its org blocks the down; the owner under FORCE would see nothing (why NO FORCE)', async () => {
    const org = v7();
    const app = await db.client('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      await app.query(
        `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled, suspended_at)
         VALUES ($1, 'report', 'fixture.tenant.report', '0 8 * * 1', 'UTC', '{}', true, now())`,
        [org],
      );
      await app.query('COMMIT');
    } finally {
      await app.end();
    }
    const owner = await db.client('owner');
    try {
      // r1 đọc dưới FORCE bằng app_owner (không policy): 0 dòng, guard không bao giờ chặn (DB2-N2).
      expect((await owner.query(`SELECT count(*)::int AS n FROM scheduled_tasks WHERE suspended_at IS NOT NULL`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await owner.end();
    }
    await expect(runMigrations('down', { source: { kind: 'list', list }, to: previous })).rejects.toThrow(
      /scheduled tasks of soft-deleted organizations would run again/,
    );
    const again = await db.client('owner');
    try {
      const { rows } = await again.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'scheduled_tasks' AND column_name = 'suspended_at'`);
      expect(rows).toEqual([{ n: 1 }]);
      const force = await again.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname = 'scheduled_tasks'`);
      expect(force.rows).toEqual([{ relforcerowsecurity: true }]);
    } finally {
      await again.end();
    }
  });
  it('once the suspended row is gone the down succeeds', async () => {
    const owner = await db.client('owner');
    try {
      await owner.query(`ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY`);
      await owner.query(`DELETE FROM scheduled_tasks`);
      await owner.query(`ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY`);
    } finally {
      await owner.end();
    }
    await expect(runMigrations('down', { source: { kind: 'list', list }, to: previous })).resolves.toEqual([
      list.at(-1)!.name,
    ]);
  });
});
```

Run: `pnpm vitest run --project integration test/integration/core/database/suspended-at-down.spec.ts`
Expected: FAIL (cột `suspended_at` chưa có: INSERT lỗi `column "suspended_at" … does not exist`).

- [ ] **Step 3: Viết migration**

`src/migrations/core/Migration<ts>_scheduled_tasks_suspended_at.ts` (tên lớp = tên file):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Spec SP3 §5.2, §6.13 bảng 3A (DB-I10, S3-A39): lịch của org xoá mềm bị treo bằng cột riêng, không đụng `enabled`.
 *
 * Bảng chuẩn hoá (spec §6.12, bảng bị sửa):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm | Dạng |
 * |---|---|---|---|
 * | scheduled_tasks | {id}, {org_id, key} | như SP1; `suspended_at` là trạng thái của nền tảng, độc lập với `enabled` (ý định của feature) | BCNF |
 *
 * Khoá: `ACCESS EXCLUSIVE` trên `scheduled_tasks` (chỉ đổi metadata, không quét), giữ tới hết lô 3A (`allOrNothing`).
 * Không index: mọi câu lọc `suspended_at` đi kèm `org_id = app_current_org()` (UNIQUE (org_id, key)) hoặc quét toàn bảng
 * của reconciler (đã quét toàn bảng từ SP1).
 *
 * Down: đọc bảng FORCE RLS bằng `app_owner` phải theo mẫu `NO FORCE … FORCE` + khẳng định (spec §8.8): dưới FORCE
 * `app_owner` thấy 0 dòng và guard không bao giờ chặn (DB2-N2).
 */
export class Migration<ts>_scheduled_tasks_suspended_at extends Migration {
  override name = 'Migration<ts>_scheduled_tasks_suspended_at';

  override up(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE scheduled_tasks ADD COLUMN suspended_at TIMESTAMPTZ NULL;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE public.scheduled_tasks NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.scheduled_tasks WHERE suspended_at IS NOT NULL) THEN
    RAISE EXCEPTION 'scheduled tasks of soft-deleted organizations would run again; restore or purge those organizations before reverting';
  END IF;
END $$;`);
    this.addSql(`ALTER TABLE public.scheduled_tasks FORCE ROW LEVEL SECURITY;`);
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
    this.addSql(`ALTER TABLE scheduled_tasks DROP COLUMN suspended_at;`);
  }
}
```
Thay `<ts>` ở hai chỗ bằng đúng timestamp của tên file CLI vừa sinh.

Sửa `test/integration/core/database/normalization-inventory.spec.ts`: thêm mục
```ts
  'public.scheduled_tasks': [
    'id',
    'org_id',
    'key',
    'job_name',
    'cron',
    'timezone',
    'payload',
    'enabled',
    'created_at',
    'updated_at',
    'suspended_at',
  ],
```
và đổi chú thích đầu file thành "Cột của mọi bảng SP2 và SP3 đã được phân tích (spec SP2 §5.16, spec SP3 §6.12)".

- [ ] **Step 4: Test service và reconciler (fail)**

Thêm vào `test/integration/core/scheduler/scheduler.spec.ts`, trong `describe('scheduler')`, sau `describe('tenant tasks')`:
```ts
  describe('org suspension (spec SP3 §5.2, DB-I10)', () => {
    const org = randomUUID();
    const inOrg = <T>(fn: () => Promise<T>) => w1.get(OrgScope).run(org, fn);
    const inTx = <T>(fn: () => Promise<T>) => inOrg(() => w1.get(UnitOfWork).run(fn));
    const svc = () => w1.get(ScheduledTaskService);
    const task = { key: 'nightly', job: TenantReport, cron: '0 2 * * *', timezone: 'UTC', payload: { src: 's' }, enabled: true };
    const ids = () => w1.get(JobScheduler).listIds(`task-${org}-`);

    it('suspend/resume/remove refuse to run outside the caller transaction or outside an org', async () => {
      await expect(inOrg(() => svc().suspendAllForCurrentOrg())).rejects.toThrow(/inside the caller's UnitOfWork transaction/);
      await expect(w1.get(UnitOfWork).run(() => svc().suspendAllForCurrentOrg())).rejects.toMatchObject({ error: { code: 'org_context_invalid' } });
      await expect(inTx(() => svc().syncCurrentOrg())).rejects.toThrow(/after the caller commits/);
    });
    it('suspend keeps enabled, sync removes the Redis scheduler and the reconciler does not revive it', async () => {
      await inOrg(() => svc().upsert(task));
      await inOrg(() => svc().upsert({ ...task, key: 'off', enabled: false }));
      expect(await ids()).toEqual([tenantTaskId(org, 'nightly')]);
      expect(await inTx(() => svc().suspendAllForCurrentOrg())).toBe(2);
      expect(await inOrg(() => svc().syncCurrentOrg())).toEqual({ upserted: 0, removed: 1 });
      expect(await ids()).toEqual([]);
      await w1.get(ScheduleReconciler).reconcile();
      expect(await ids()).toEqual([]);
      const rows = await inTx(() => w1.get(Db).execute<{ key: string; enabled: boolean; suspended: boolean }>(`SELECT key, enabled, suspended_at IS NOT NULL AS suspended FROM scheduled_tasks ORDER BY key`));
      expect(rows).toEqual([
        { key: 'nightly', enabled: true, suspended: true },
        { key: 'off', enabled: false, suspended: true },
      ]);
    });
    it('an upsert of a suspended row never reaches Redis and does not clear suspended_at', async () => {
      await inOrg(() => svc().upsert({ ...task, cron: '0 3 * * *' }));
      expect(await ids()).toEqual([]);
      const [row] = await inTx(() => w1.get(Db).execute<{ cron: string; suspended: boolean }>(`SELECT cron, suspended_at IS NOT NULL AS suspended FROM scheduled_tasks WHERE key = 'nightly'`));
      expect(row).toEqual({ cron: '0 3 * * *', suspended: true });
    });
    it('resume restores exactly the enabled intent; remove deletes every row of the org only', async () => {
      expect(await inTx(() => svc().resumeAllForCurrentOrg())).toBe(2);
      expect(await inOrg(() => svc().syncCurrentOrg())).toEqual({ upserted: 1, removed: 0 });
      expect(await ids()).toEqual([tenantTaskId(org, 'nightly')]);
      expect(await inTx(() => svc().removeAllForCurrentOrg())).toBe(2);
      expect(await inOrg(() => svc().syncCurrentOrg())).toEqual({ upserted: 0, removed: 1 });
      expect(await ids()).toEqual([]);
    });
  });
```
Run: `pnpm vitest run --project integration test/integration/core/scheduler/scheduler.spec.ts`
Expected: FAIL (`svc().suspendAllForCurrentOrg is not a function`).

- [ ] **Step 5: Cài đặt trong service và reconciler**

`src/core/scheduler/scheduled-task.service.ts` — thêm import `z` từ `zod` và `findJob` từ `../queue/index.js`; thay thân `upsert` (phần ghi DB + Redis) và thêm các phương thức:
```ts
const SuspendedRow = z.object({ suspended_at: z.date().nullable() });
const SyncRow = z.object({
  key: z.string(),
  job_name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  payload: z.unknown(),
});
```
```ts
    const [row] = await this.uow.run(() =>
      this.db.execute(
        `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
         ON CONFLICT ON CONSTRAINT scheduled_tasks_org_key_uq DO UPDATE SET job_name = EXCLUDED.job_name, cron = EXCLUDED.cron,
         timezone = EXCLUDED.timezone, payload = EXCLUDED.payload, enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING suspended_at`,
        [org, i.key, i.job.name, i.cron, timezone, JSON.stringify(parsed.data), i.enabled],
      ),
    );
    const { suspended_at: suspendedAt } = SuspendedRow.parse(row);
    const id = tenantTaskId(org, i.key);
    // Spec SP3 §5.2 (T-32): dòng đang treo (org xoá mềm, hoặc trigger của tenancy vừa treo lịch mới) không lên Redis.
    if (i.enabled && suspendedAt === null)
      await this.scheduler.upsert(id, i.job, parsed.data, { cron: i.cron, tz: timezone }, { orgId: org });
    else await this.scheduler.remove(id);
  }

  /** Spec SP3 §5.2: treo mọi lịch của org hiện tại. Chỉ ghi DB, trong transaction của caller (xoá mềm org). */
  async suspendAllForCurrentOrg(): Promise<number> {
    this.assertInCallerTransaction('suspendAllForCurrentOrg');
    const rows = await this.db.execute(
      `UPDATE scheduled_tasks SET suspended_at = now(), updated_at = now()
       WHERE org_id = app_current_org() AND suspended_at IS NULL RETURNING id`,
    );
    return rows.length;
  }

  /** Gỡ treo (khôi phục org): `enabled` của feature giữ nguyên. */
  async resumeAllForCurrentOrg(): Promise<number> {
    this.assertInCallerTransaction('resumeAllForCurrentOrg');
    const rows = await this.db.execute(
      `UPDATE scheduled_tasks SET suspended_at = NULL, updated_at = now()
       WHERE org_id = app_current_org() AND suspended_at IS NOT NULL RETURNING id`,
    );
    return rows.length;
  }

  /** Xoá mọi lịch của org hiện tại (participant xoá cứng của tenancy, spec §9.5). Chỉ DB. */
  async removeAllForCurrentOrg(): Promise<number> {
    this.assertInCallerTransaction('removeAllForCurrentOrg');
    const rows = await this.db.execute(
      `DELETE FROM scheduled_tasks WHERE org_id = app_current_org() RETURNING id`,
    );
    return rows.length;
  }

  /**
   * Gọi SAU commit của caller: đưa scheduler Redis của org hiện tại về khớp DB (upsert lịch `enabled` chưa treo, gỡ
   * mọi id `task-<org>-*` khác). Lỗi Redis ném cho caller; reconciler sửa ở lần chạy sau. Không bao giờ gỡ Redis trong
   * transaction rồi rollback (DB-I10).
   */
  async syncCurrentOrg(): Promise<{ upserted: number; removed: number }> {
    const org = this.orgOrThrow();
    if (this.uow.inTransaction())
      throw new Error(
        'ScheduledTaskService.syncCurrentOrg must run after the caller commits (Redis is never touched inside a transaction)',
      );
    const rows = z
      .array(SyncRow)
      .parse(
        await this.db.execute(
          `SELECT key, job_name, cron, timezone, payload FROM scheduled_tasks WHERE enabled AND suspended_at IS NULL`,
        ),
      );
    const keep = new Set<string>();
    let upserted = 0;
    for (const r of rows) {
      const job = findJob(r.job_name);
      const id = tenantTaskId(org, r.key);
      // Job lạ (bản mới hơn khi rolling deploy): giữ scheduler như reconciler; job không còn tenantSchedulable: gỡ.
      if (!job) {
        keep.add(id);
        continue;
      }
      if (!job.tenantSchedulable) continue;
      keep.add(id);
      await this.scheduler.upsert(id, job, r.payload, { cron: r.cron, tz: r.timezone }, { orgId: org });
      upserted++;
    }
    let removed = 0;
    for (const id of await this.scheduler.listIds(tenantTaskId(org, '')))
      if (!keep.has(id)) {
        await this.scheduler.remove(id);
        removed++;
      }
    return { upserted, removed };
  }

  private assertInCallerTransaction(op: string): void {
    this.orgOrThrow();
    if (!this.uow.inTransaction())
      throw new Error(
        `ScheduledTaskService.${op} must run inside the caller's UnitOfWork transaction (spec SP3 §5.2)`,
      );
  }
```
Ghi chú: `tenantTaskId(org, '')` = `task-<org>-`, đúng tiền tố mà test dùng; `listIds` so `startsWith`.

`src/core/scheduler/schedule-reconciler.ts`: câu SELECT đổi thành `… FROM scheduled_tasks WHERE enabled AND suspended_at IS NULL`, thêm vào chú thích lớp một gạch đầu dòng: `- Lịch treo (\`suspended_at\`, org xoá mềm, spec SP3 §5.2) bị bỏ như lịch tắt: scheduler của nó bị gỡ ở vòng dọn.`

- [ ] **Step 6: Chạy**

Run:
```bash
pnpm vitest run --project integration test/integration/core/scheduler/scheduler.spec.ts test/integration/core/database/suspended-at-down.spec.ts test/integration/core/database/migrations.spec.ts test/integration/core/database/normalization-inventory.spec.ts
pnpm vitest run --project unit test/unit/migrations
```
Expected: PASS; quét tĩnh nhận khối khẳng định FORCE sau `NO FORCE` trong `down`.

- [ ] **Step 7: Commit**

```bash
git add src/migrations/core src/core/scheduler test/integration/core/scheduler/scheduler.spec.ts test/integration/core/database/suspended-at-down.spec.ts test/integration/core/database/normalization-inventory.spec.ts
git commit -m "feat(scheduler): suspended_at, org-wide suspend/resume/remove in the caller transaction, post-commit sync"
```

---

### Task 8: `notifications` — bảng tra cứu `email_templates` thay `CHECK` template; kiểm chứng prod-like #1 (core + notifications trên image thật)

**Files:**
- Create: `src/migrations/notifications/Migration<ts>_email_templates_lookup.ts` (CLI), `test/smoke/tenancy.smoke.spec.ts`
- Modify: `src/modules/notifications/templates.ts` (chú thích), `test/integration/notifications/email-deliveries-schema.spec.ts`, `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: `TEMPLATE_KEYS` (SP2), bộ smoke (`test/smoke/*`, SP2 Task 17/43).
- Produces:
  - Bảng global `email_templates (key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{0,63}$'), created_at, updated_at)` với 5 key của SP2; FK `email_deliveries_template_fk (template) → email_templates(key) ON DELETE RESTRICT`; bỏ `email_deliveries_template_check`. Plan 3C/3D chỉ **chèn dòng** (không viết lại `CHECK`).
  - `test/smoke/tenancy.smoke.spec.ts` (Task 12, 16, 26 và 29 mở rộng): khẳng định migration/role của 3A đã áp trên image production.

- [ ] **Step 1: Tạo migration**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/notifications --name email_templates_lookup`
Expected: file `Migration<ts>_email_templates_lookup.ts`, timestamp lớn hơn migration `suspended_at` của Task 7 (thứ tự 3A: core → notifications → tenancy, spec §6.13).

- [ ] **Step 2: Sửa test schema (fail)**

`test/integration/notifications/email-deliveries-schema.spec.ts`:
- thay ca `matches the template CHECK catalog to TEMPLATE_KEYS exactly` bằng:
```ts
  it('email_templates holds exactly TEMPLATE_KEYS (catches a template lost in a 3C/3D merge)', async () => {
    const { rows } = await app.query<{ key: string }>(
      `SELECT key FROM email_templates ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual([...TEMPLATE_KEYS].sort());
  });
  it('an unknown template violates the lookup FK (23503), not a CHECK', async () => {
    await expect(
      insert({ template: 'newsletter', idempotency_key: `newsletter:${v7()}` }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'email_deliveries_template_fk',
    });
  });
```
- xoá phần tử `'unknown template'` khỏi bảng `it.each` của các ca `23514`.

Run: `pnpm vitest run --project integration test/integration/notifications/email-deliveries-schema.spec.ts`
Expected: FAIL (`relation "email_templates" does not exist`).

- [ ] **Step 3: Viết migration**

`src/migrations/notifications/Migration<ts>_email_templates_lookup.ts`:
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Spec SP3 §5.2 hàng notifications, §6.13 bảng 3A (INT2-N-3, S3-A47): template là DÒNG của bảng tra cứu, không còn là
 * một `CHECK` danh sách đóng — plan 3C và 3D mỗi plan chèn dòng của mình nên merge song song không ghi đè nhau.
 * Luật enum của spec cha: "lookup table với FK hoặc CHECK".
 *
 * Bảng chuẩn hoá (spec §6.12):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm | Dạng |
 * |---|---|---|---|
 * | email_templates | {key} | — (toàn khoá, cộng created_at/updated_at) | BCNF |
 * | email_deliveries | như SP2 | `template` nay là FK tới `email_templates(key)` | BCNF (không đổi) |
 *
 * Grant `app_user`: `SELECT` (FK không cần; để test đọc). Không RLS: bảng global (`GLOBAL_TABLES`).
 * Index: PK (đích FK). Khoá: `SHARE ROW EXCLUSIVE` trên `email_deliveries` khi thêm FK (quét kiểm dữ liệu), `ACCESS
 * EXCLUSIVE` ngắn khi bỏ CHECK; giữ tới hết lô 3A (`allOrNothing`).
 *
 * Down: thêm lại đúng `CHECK` của SP2 (kiểm dữ liệu: còn dòng template mới của 3C/3D thì fail to, tức down của plan
 * đó chưa chạy), bỏ FK, xoá bảng. Không đọc dữ liệu trên bảng FORCE nên không cần mẫu `NO FORCE`.
 */
export class Migration<ts>_email_templates_lookup extends Migration {
  override name = 'Migration<ts>_email_templates_lookup';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE email_templates (
    key TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT email_templates_key_ck CHECK (key ~ '^[a-z][a-z0-9-]{0,63}$'));`);
    this.addSql(
      `INSERT INTO email_templates (key) VALUES ('verify-email'), ('reset-password'), ('two-factor-changed'), ('existing-account'), ('change-email-confirmation');`,
    );
    this.addSql(
      `ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_template_fk FOREIGN KEY (template) REFERENCES email_templates (key) ON DELETE RESTRICT;`,
    );
    this.addSql(
      `ALTER TABLE email_deliveries DROP CONSTRAINT email_deliveries_template_check;`,
    );
    this.addSql(`GRANT SELECT ON email_templates TO app_user;`);
  }

  override down(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_template_check CHECK (template IN ('verify-email', 'reset-password', 'two-factor-changed', 'existing-account', 'change-email-confirmation'));`,
    );
    this.addSql(
      `ALTER TABLE email_deliveries DROP CONSTRAINT email_deliveries_template_fk;`,
    );
    this.addSql(`DROP TABLE email_templates;`);
  }
}
```
(Thay `<ts>` bằng timestamp của file CLI.) `src/modules/notifications/templates.ts`: chú thích của `TEMPLATE_KEYS` đổi thành `/** Key template: trùng các dòng của bảng tra cứu \`email_templates\` (FK từ \`email_deliveries.template\`, spec SP3 §6.13) và tên thư mục \`templates/<key>/\`. Thêm template = thêm key ở đây + migration chèn dòng. */`.

Catalog và inventory:
- `test/integration/core/database/rls-catalog.spec.ts`: `GLOBAL_TABLES` thêm `// global: bảng tra cứu template (spec SP3 §6.13)` + `'email_templates',`.
- `test/integration/core/database/normalization-inventory.spec.ts`: thêm `'public.email_templates': ['key', 'created_at', 'updated_at'],`.

- [ ] **Step 4: Chạy (DB test dùng chung đã migrate ở global setup mỗi lần chạy)**

Run:
```bash
pnpm vitest run --project integration test/integration/notifications test/integration/core/database
pnpm vitest run --project unit test/unit/migrations
```
Expected: PASS (round-trip + sweep trên database riêng xác nhận `down` khôi phục đúng `email_deliveries_template_check` — catalog snapshot bằng nhau).

- [ ] **Step 5: Smoke prod-like của 3A (khung) — migration và role trên image production**

`test/smoke/tenancy.smoke.spec.ts`:
```ts
import { describe, expect, inject, it } from 'vitest';
import { TEMPLATE_KEYS } from '../../src/modules/notifications/templates.js';
import { assertCleanLogs, logsSince, psql, workerHealth } from './smoke-support.js';

/**
 * Plan 3A trên image production (`NODE_ENV=production`, TLS mọi nơi, `docker compose --profile app`). Task 12 thêm
 * kịch bản identity, Task 16 schema tenancy, Task 26 xoá tài khoản có guard, Task 29 luồng tenancy đầy đủ.
 */
describe('prod-like smoke: plan 3A', () => {
  const { apiUrl } = inject('smoke');
  const since = new Date().toISOString();

  it('the 3A migrations and the tenancy_definer role are in place', () => {
    expect(psql(`SELECT string_agg(key, ',' ORDER BY key) FROM email_templates`)).toBe([...TEMPLATE_KEYS].sort().join(','));
    expect(psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'scheduled_tasks' AND column_name = 'suspended_at'`)).toBe('1');
    expect(psql(`SELECT rolcanlogin::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = 'tenancy_definer'`)).toBe('false,false');
    expect(psql(`SELECT count(*) FROM pg_constraint WHERE conname = 'email_deliveries_template_fk'`)).toBe('1');
  });
  it('/health/ready is 200, the worker is healthy, and api/worker logs are clean JSON without errors', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(logsSince(since), []);
  });
});
```

- [ ] **Step 6: Kiểm chứng prod-like #1**

Run: `pnpm test:smoke`
Expected: build image production thật (build-arg từ `docker/images.env`), `compose --profile app` với `NODE_ENV=production`, migrate chạy mọi migration mới trên image, `core.smoke.spec.ts`, `auth-email.smoke.spec.ts`, `dashboard.smoke.spec.ts`, `tenancy.smoke.spec.ts` PASS; teardown `down -v`. Xác nhận `docker compose -p nsb-smoke ps -a` rỗng. Log api/worker không có dòng `error` (khẳng định trong spec).

- [ ] **Step 7: Commit**

```bash
git add src/migrations/notifications src/modules/notifications/templates.ts test/integration/notifications/email-deliveries-schema.spec.ts test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts test/smoke/tenancy.smoke.spec.ts
git commit -m "feat(notifications): email_templates lookup table instead of a closed CHECK; prod-like smoke for plan 3A migrations"
```

---

## Phần C — Identity (spec §5.2 hàng "Plan = 3A")

### Task 9: `PrincipalResolver` idempotent, `IdentityRequestModule` global, trường mới của `AUTHENTICATED`, định tuyến `oak_` tới port `OrgCredentialAuthenticator`

**Files:**
- Create: `src/modules/identity/ports/org-credential-authenticator.ts`, `src/modules/identity/http/principal-resolver.ts`, `src/modules/identity/http/identity-request.module.ts`, `test/unit/modules/identity/principal-resolver.spec.ts`
- Modify: `src/modules/identity/ports/auth-provider.ts`, `src/modules/identity/http/principal.middleware.ts`, `src/modules/identity/identity.module.ts`, `src/modules/identity/index.ts`, `src/modules/identity/infra/better-auth/better-auth.provider.ts`, `src/modules/identity/infra/jwks/jwks.provider.ts`, `test/integration/identity/better-auth-provider.spec.ts`, `test/integration/identity/jwks-provider.spec.ts`, `test/e2e/identity/principal-guard.e2e.spec.ts`

**Interfaces:**
- Consumes: `AuthProvider`, `AuthState`, `IdentityMetrics`, `PreAuthRateLimiter`, `detectCredentials`, `csrfAllows`, `identitySpan` (SP2).
- Produces:
  - `ORG_API_KEY_PREFIX = 'oak_'`; `abstract class OrgCredentialAuthenticator { abstract authenticate(rawKey: string): Promise<AuthResult> }` (identity sở hữu, tenancy cài ở 3D).
  - `AuthResult` nhánh `AUTHENTICATED` thêm `authenticatedAt: Date | undefined`, `emailVerified: boolean`, `verifiedEmail: string | undefined`.
  - `PrincipalResolver.ensure(req: IncomingMessage & { ip?: string }, res: ServerResponse): Promise<void>` — idempotent theo request (khoá CLS `identity:principalResolved` đặt ngay đầu lần chạy thứ nhất); lần đầu ném lỗi thì ném (không `next(err)`), các lần sau no-op. Credential `API_KEY` có giá trị bắt đầu bằng `ORG_API_KEY_PREFIX` (không phân biệt hoa thường) đi tới `OrgCredentialAuthenticator` (vắng → `REJECTED`), không bao giờ tới Better Auth; `preAuth.consume`/`refund` áp như mọi API key.
  - `@Global() IdentityRequestModule` cung cấp và export `AuthState`, `PrincipalResolver` (Task 10 thêm `AuthFacts`); `IdentityHttpModule` import nó, vẫn đăng ký `PrincipalMiddleware` và `APP_GUARD`.
  - `identity/index.ts` export `PrincipalResolver`, `OrgCredentialAuthenticator`, `ORG_API_KEY_PREFIX`, `type AuthResult`.

- [ ] **Step 1: Test đơn vị của `PrincipalResolver` (U18, fail)**

`test/unit/modules/identity/principal-resolver.spec.ts`:
```ts
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../../src/core/config/index.js';
import { RequestContext } from '../../../../src/core/context/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { PreAuthRateLimiter, httpConfig } from '../../../../src/core/http/index.js';
import { AuthState } from '../../../../src/modules/identity/http/auth-state.js';
import { PrincipalResolver } from '../../../../src/modules/identity/http/principal-resolver.js';
import { IdentityMetrics } from '../../../../src/modules/identity/identity-metrics.js';
import { identityConfig } from '../../../../src/modules/identity/identity.config.js';
import { AuthProvider, type AuthResult } from '../../../../src/modules/identity/ports/auth-provider.js';
import { OrgCredentialAuthenticator } from '../../../../src/modules/identity/ports/org-credential-authenticator.js';

const identity = { mode: 'local', cookiePrefix: 'app', apiKeyHeader: 'x-api-key', baseUrl: 'http://localhost:3000' };
const authed: AuthResult = {
  kind: 'AUTHENTICATED',
  principal: { type: 'user', id: 'u1' },
  credential: { kind: 'BEARER_SESSION' },
  isPlatformAdmin: false,
  authenticatedAt: new Date(),
  emailVerified: true,
  verifiedEmail: 'u1@example.test',
};

function request(headers: [string, string][], method = 'GET'): IncomingMessage & { ip: string } {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.rawHeaders = headers.flat();
  req.headers = Object.fromEntries(headers.map(([k, v]) => [k.toLowerCase(), v]));
  return Object.assign(req, { ip: '198.51.100.1' });
}

async function build(opts: { orgAuthenticator?: OrgCredentialAuthenticator } = {}) {
  const provider = { authenticate: vi.fn(async (): Promise<AuthResult> => authed) };
  const preAuth = { consume: vi.fn(async () => undefined), refund: vi.fn(async () => undefined) };
  const mod = await Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true })],
    providers: [
      PrincipalResolver,
      AuthState,
      RequestContext,
      IdentityMetrics,
      { provide: AuthProvider, useValue: provider },
      { provide: PreAuthRateLimiter, useValue: preAuth },
      { provide: identityConfig.KEY, useValue: identity },
      { provide: appConfig.KEY, useValue: { serviceName: 'app' } },
      { provide: httpConfig.KEY, useValue: { corsOrigins: ['http://localhost:3000'] } },
      ...(opts.orgAuthenticator ? [{ provide: OrgCredentialAuthenticator, useValue: opts.orgAuthenticator }] : []),
    ],
  }).compile();
  return { resolver: mod.get(PrincipalResolver), state: mod.get(AuthState), ctx: mod.get(RequestContext), cls: mod.get(ClsService), provider, preAuth };
}
const res = (req: IncomingMessage) => new ServerResponse(req);

describe('PrincipalResolver.ensure (spec SP3 §5.2, T6, U18)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('anonymous: the second call is a no-op', async () => {
    const t = await build();
    const set = vi.spyOn(t.state, 'set');
    const req = request([]);
    await t.cls.run(async () => {
      await t.resolver.ensure(req, res(req));
      await t.resolver.ensure(req, res(req));
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(t.provider.authenticate).not.toHaveBeenCalled();
  });
  it('authenticated: the provider runs once across two calls and the principal is set', async () => {
    const t = await build();
    const req = request([['Authorization', 'Bearer tok']]);
    await t.cls.run(async () => {
      await t.resolver.ensure(req, res(req));
      await t.resolver.ensure(req, res(req));
      expect(t.ctx.principal()).toEqual({ type: 'user', id: 'u1' });
    });
    expect(t.provider.authenticate).toHaveBeenCalledTimes(1);
  });
  it('the first call throws (ambiguous credentials) and a later call does not run again', async () => {
    const t = await build();
    const req = request([['Authorization', 'Bearer a'], ['Authorization', 'Bearer b']]);
    await t.cls.run(async () => {
      await expect(t.resolver.ensure(req, res(req))).rejects.toMatchObject({ error: { code: 'ambiguous_credentials' } });
      await expect(t.resolver.ensure(req, res(req))).resolves.toBeUndefined();
    });
    expect(t.provider.authenticate).not.toHaveBeenCalled();
  });
  it('an oak_ key never reaches Better Auth: REJECTED without an authenticator, pre-auth consumed once', async () => {
    const t = await build();
    const req = request([['x-api-key', 'OAK_abc']]);
    await t.cls.run(async () => {
      await t.resolver.ensure(req, res(req));
      expect(t.state.get()).toEqual({ kind: 'REJECTED' });
    });
    expect(t.provider.authenticate).not.toHaveBeenCalled();
    expect(t.preAuth.consume).toHaveBeenCalledTimes(1);
    expect(t.preAuth.refund).not.toHaveBeenCalled();
  });
  it('an oak_ key goes to the OrgCredentialAuthenticator when one is installed (3D), refunded on success', async () => {
    const orgAuth = { authenticate: vi.fn(async (): Promise<AuthResult> => ({ ...authed, credential: { kind: 'API_KEY', id: 'k1' } })) };
    const t = await build({ orgAuthenticator: orgAuth });
    const req = request([['x-api-key', 'oak_abc']]);
    await t.cls.run(() => t.resolver.ensure(req, res(req)));
    expect(orgAuth.authenticate).toHaveBeenCalledWith('oak_abc');
    expect(t.provider.authenticate).not.toHaveBeenCalled();
    expect(t.preAuth.refund).toHaveBeenCalledTimes(1);
  });
  it('outside a CLS context it fails loud', async () => {
    const t = await build();
    const req = request([]);
    await expect(t.resolver.ensure(req, res(req))).rejects.toThrow();
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/identity/principal-resolver.spec.ts`
Expected: FAIL `Cannot find module …/principal-resolver.js`.

- [ ] **Step 2: Port `OrgCredentialAuthenticator` và trường mới của `AUTHENTICATED`**

`src/modules/identity/ports/org-credential-authenticator.ts`:
```ts
import type { AuthResult } from './auth-provider.js';

/**
 * Tiền tố của org API key (spec SP3 §10, S3-A8). Hằng của IDENTITY (identity không import tenancy, luật 18): identity
 * định tuyến key mang tiền tố này và cấm Better Auth tạo key mang nó (`/api-key/create`).
 */
export const ORG_API_KEY_PREFIX = 'oak_';
export const isOrgApiKey = (value: string): boolean =>
  value.toLowerCase().startsWith(ORG_API_KEY_PREFIX);

/**
 * Port cho org API key (spec SP3 §5.2): tenancy cài ở plan 3D (`TenancyIdentityPortsModule`, `@Global`). Identity inject
 * `@Optional()`: vắng thì mọi `oak_…` là `REJECTED` (401). Mọi lỗi của chính credential → `REJECTED`; lỗi hạ tầng →
 * `UNAVAILABLE` (không ném).
 */
export abstract class OrgCredentialAuthenticator {
  abstract authenticate(rawKey: string): Promise<AuthResult>;
}
```
`src/modules/identity/ports/auth-provider.ts`, nhánh `AUTHENTICATED`:
```ts
  | {
      kind: 'AUTHENTICATED';
      principal: Principal;
      credential: Credential;
      isPlatformAdmin: boolean;
      /**
       * Spec SP3 §5.2: lúc chứng minh danh tính gần nhất — local/hybrid: `session.createdAt` (cùng cách Better Auth tính
       * độ mới); external: claim `auth_time`, KHÔNG fallback `iat`; API key: `undefined`.
       */
      authenticatedAt: Date | undefined;
      /** local/hybrid: `user.emailVerified`; external: `true` (IdP chứng minh danh tính, spec §11); API key: `false`. */
      emailVerified: boolean;
      /** Email chuẩn hoá khi đã xác thực (local/hybrid); external: claim email của 3C, tới đó `undefined`. */
      verifiedEmail: string | undefined;
      setCookies?: readonly string[];
    }
```

- [ ] **Step 3: Provider điền ba trường**

`src/modules/identity/infra/better-auth/better-auth.provider.ts` — import `normalizeEmail` từ `./email-normalize.js`; cuối `session()`:
```ts
    const verified = s.user.emailVerified === true;
    return {
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: s.user.id },
      credential: { kind },
      isPlatformAdmin: hasAdminRole(s.user.role),
      authenticatedAt: new Date(s.session.createdAt),
      emailVerified: verified,
      verifiedEmail: verified ? normalizeEmail(s.user.email) : undefined,
      ...cookies,
    };
```
cuối `apiKey()`:
```ts
    return {
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: owner.id },
      credential: { kind: 'API_KEY', id: r.key.id },
      isPlatformAdmin: false,
      authenticatedAt: undefined,
      emailVerified: false,
      verifiedEmail: undefined,
    };
```
`src/modules/identity/infra/jwks/jwks.provider.ts` — thêm hằng và hàm cấp module:
```ts
const MS_PER_SECOND = 1000;
/** Claim `auth_time` (OIDC Core §2): giây Unix; sai kiểu hoặc thiếu → `undefined` (không fallback `iat`, SEC-I6). */
const authTimeOf = (payload: JWTPayload): Date | undefined => {
  const t = payload.auth_time;
  return typeof t === 'number' && Number.isFinite(t) && t > 0
    ? new Date(t * MS_PER_SECOND)
    : undefined;
};
```
và kết quả của `verify`:
```ts
    return {
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: sub },
      credential: { kind },
      isPlatformAdmin: this.isAdmin(payload),
      authenticatedAt: authTimeOf(payload),
      emailVerified: true,
      verifiedEmail: undefined,
    };
```

- [ ] **Step 4: `PrincipalResolver` (thân `use()` cũ) và middleware mỏng**

`src/modules/identity/http/principal-resolver.ts`:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ConfigOf, appConfig } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError } from '../../../core/errors/index.js';
import { PreAuthRateLimiter, httpConfig } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import { IdentityMetrics } from '../identity-metrics.js';
import { identitySpan } from '../identity-telemetry.js';
import { identityConfig, type IdentityConfig } from '../identity.config.js';
import { AuthProvider, type AuthResult } from '../ports/auth-provider.js';
import {
  OrgCredentialAuthenticator,
  isOrgApiKey,
} from '../ports/org-credential-authenticator.js';
import { AuthState } from './auth-state.js';
import {
  detectCredentials,
  detectionConfigOf,
  type DetectedCredential,
  type DetectionConfig,
} from './credential-detector.js';
import {
  SAFE_METHODS,
  csrfAllows,
  isCookieCredential,
  singleHeader,
  trustedOriginList,
} from './origin-check.js';
import { toWebHeaders } from './web-headers.js';

/** Khoá CLS riêng, đặt NGAY đầu lần chạy thứ nhất (không suy từ `AuthState`: `get()` trả ANONYMOUS cả khi chưa đặt). */
const RESOLVED = 'identity:principalResolved';
const REJECTED: AuthResult = { kind: 'REJECTED' };

/**
 * Xác định principal của request, IDEMPOTENT (spec SP3 §5.2, §7.1 bước 2, T6, INT-I1): Nest 12.1 sắp middleware theo
 * `distance` của module, nên `OrgContextMiddleware` (tenancy) có thể chạy trước `PrincipalMiddleware`; cả hai gọi
 * `ensure`, lần sau là no-op, nên mỗi request xác thực đúng một lần bất kể thứ tự. Lần đầu ném (đa credential, CSRF,
 * 429 pre-auth) thì request kết thúc ở đó; không có lần chạy thứ hai.
 */
@Injectable()
export class PrincipalResolver {
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly provider: AuthProvider,
    private readonly ctx: RequestContext,
    private readonly state: AuthState,
    private readonly metrics: IdentityMetrics,
    private readonly preAuth: PreAuthRateLimiter,
    private readonly cls: ClsService,
    @Inject(identityConfig.KEY) identity: IdentityConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
    @Optional() private readonly orgCredentials?: OrgCredentialAuthenticator,
  ) {
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(trustedOriginList(http.corsOrigins, identity.baseUrl));
  }

  async ensure(req: IncomingMessage & { ip?: string }, res: ServerResponse): Promise<void> {
    if (this.cls.get(RESOLVED) === true) return;
    // `set` ném khi không có CLS (fail loud): mọi request HTTP có CLS từ `contextMiddleware()`.
    this.cls.set(RESOLVED, true);
    const d = detectCredentials(req.rawHeaders, this.detection);
    if (!d.ok) {
      this.metrics.ambiguous.add(1);
      throw new AppError(IdentityErrors.AMBIGUOUS_CREDENTIALS);
    }
    const credential = d.credentials[0];
    if (!credential) {
      this.state.set({ kind: 'ANONYMOUS' });
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    if (
      !SAFE_METHODS.has(method) &&
      isCookieCredential(credential.kind) &&
      !csrfAllows(
        {
          method,
          origin: singleHeader(req, 'origin'),
          secFetchSite: singleHeader(req, 'sec-fetch-site'),
        },
        this.trusted,
      )
    ) {
      this.metrics.csrfRejected.add(1);
      throw new AppError(IdentityErrors.ORIGIN_NOT_ALLOWED);
    }
    // S2-R51: mọi API key (kể cả `oak_`) bị giới hạn theo IP trước khi chạm storage; hoàn điểm khi thành công (S2-R53).
    if (credential.kind === 'API_KEY') await this.preAuth.consume(req);
    const result = await identitySpan(
      'identity.authenticate',
      () => this.authenticate(req, credential),
      (r) => ({
        'identity.credential.kind': credential.kind,
        'identity.auth.result': r.kind,
      }),
    );
    this.state.set(result);
    switch (result.kind) {
      case 'AUTHENTICATED':
        if (credential.kind === 'API_KEY') await this.preAuth.refund(req);
        this.forwardCookies(res, result.setCookies);
        this.ctx.setPrincipal(result.principal);
        this.ctx.setCredential(result.credential);
        return;
      case 'REJECTED':
        this.forwardCookies(res, result.setCookies);
        return;
      case 'UNAVAILABLE':
        this.metrics.unavailable.add(1);
        return;
      case 'EMAIL_NOT_VERIFIED':
      case 'ANONYMOUS':
        return;
      default: {
        const unknown: never = result;
        throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** `oak_…` không bao giờ tới Better Auth (spec §5.2): port của tenancy, vắng thì 401. */
  private authenticate(req: IncomingMessage, credential: DetectedCredential): Promise<AuthResult> {
    if (credential.kind === 'API_KEY' && isOrgApiKey(credential.value))
      return this.orgCredentials
        ? this.orgCredentials.authenticate(credential.value)
        : Promise.resolve(REJECTED);
    return this.provider.authenticate({ headers: toWebHeaders(req), credential });
  }

  /** Mỗi `Set-Cookie` một header riêng (RFC 6265 §3). */
  private forwardCookies(res: ServerResponse, setCookies: readonly string[] | undefined): void {
    for (const c of setCookies ?? []) res.appendHeader('Set-Cookie', c);
  }
}
```
`src/modules/identity/http/principal.middleware.ts` (thay toàn bộ):
```ts
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrincipalResolver } from './principal-resolver.js';

/**
 * Principal xác định ở middleware, trước mọi guard (ADR 0007). Toàn bộ logic ở `PrincipalResolver.ensure`
 * (idempotent), để `OrgContextMiddleware` của tenancy gọi được cùng hàm bất kể thứ tự middleware (spec SP3 T6).
 */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  constructor(private readonly resolver: PrincipalResolver) {}

  use(
    req: IncomingMessage & { ip?: string },
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void {
    this.resolver.ensure(req, res).then(() => next(), next);
  }
}
```
`src/modules/identity/http/identity-request.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { IdentityMetricsModule } from '../identity-metrics.js';
import { AuthState } from './auth-state.js';
import { PrincipalResolver } from './principal-resolver.js';

/**
 * `@Global()` (spec SP3 §5.2): tenancy inject `PrincipalResolver` (và `AuthFacts`, Task 10) mà không import module của
 * identity. Không đăng ký middleware ở đây: `IdentityHttpModule` (không global) vẫn đăng ký `PrincipalMiddleware`, nên
 * thứ tự middleware giữa module giữ nguyên cơ chế `distance` của Nest.
 */
@Global()
@Module({
  imports: [IdentityMetricsModule],
  providers: [AuthState, PrincipalResolver],
  exports: [AuthState, PrincipalResolver],
})
export class IdentityRequestModule {}
```
`src/modules/identity/identity.module.ts`, `IdentityHttpModule`:
```ts
@Module({
  imports: [IdentityMetricsModule, IdentityRequestModule],
  providers: [PrincipalMiddleware, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class IdentityHttpModule implements NestModule {
```
(bỏ `AuthState` khỏi `providers`; import `IdentityRequestModule` từ `./http/identity-request.module.js`.)
`src/modules/identity/index.ts` thêm:
```ts
export { PrincipalResolver } from './http/principal-resolver.js';
export type { AuthResult } from './ports/auth-provider.js';
export {
  ORG_API_KEY_PREFIX,
  OrgCredentialAuthenticator,
} from './ports/org-credential-authenticator.js';
```

- [ ] **Step 5: Cập nhật test có sẵn theo hình dạng mới**

- `test/integration/identity/better-auth-provider.spec.ts`: ba kỳ vọng `toEqual` của session (dòng ~121, ~127, ~139) thêm `authenticatedAt: expect.any(Date), emailVerified: true, verifiedEmail: <email của user đó>` (user của helper `user()` đã xác thực email); kỳ vọng của API key (dòng ~188) thêm `authenticatedAt: undefined, emailVerified: false, verifiedEmail: undefined`. Thêm ca:
```ts
  it('authenticatedAt is the session creation time Better Auth uses for freshness', async () => {
    const u = await user();
    const r = await provider.authenticate({ headers: new Headers({ cookie: u.cookie }), credential: { kind: 'SESSION_COOKIE', value: 'x' } });
    const [row] = (await owner.query<{ created_at: Date }>(`SELECT created_at FROM auth.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.id])).rows;
    expect(r).toMatchObject({ kind: 'AUTHENTICATED', authenticatedAt: row!.created_at });
  });
```
(biến `provider`, `owner`, `user()` đã có trong file; `credential.value` không được provider đọc ở nhánh session.)
- `test/integration/identity/jwks-provider.spec.ts`: kỳ vọng `toEqual` (dòng ~97) thêm `authenticatedAt: undefined, emailVerified: true, verifiedEmail: undefined`. Thêm ca:
```ts
  it('auth_time becomes authenticatedAt; a non-numeric auth_time is ignored, never replaced by iat (SEC-I6)', async () => {
    const at = Math.floor(Date.now() / 1000) - 30;
    expect(await bearer(await jwks.sign({ ...good(), auth_time: at }))).toMatchObject({ authenticatedAt: new Date(at * 1000) });
    expect(await bearer(await jwks.sign({ ...good(), auth_time: 'yesterday' }))).toMatchObject({ authenticatedAt: undefined });
  });
```
- `test/e2e/identity/principal-guard.e2e.spec.ts`: import thêm `PreAuthRateLimiter` vào dòng import có sẵn từ `../../../src/core/http/index.js` (cạnh `PublicRoute`); thêm ca (dùng `app`, `request`, `AuthProvider` có sẵn trong file). Review M3: tên ca nói "không tới Better Auth" và "một điểm pre-auth" nên ca phải khẳng định cả hai.
```ts
  it('an oak_ key is never handed to Better Auth: 401 on a Nest route, exactly one pre-auth point spent and not refunded', async () => {
    // spyOn không mock (gọi hàm gốc). Middleware gọi `this.preAuth.consume(req)` mỗi request, tra prototype lúc gọi.
    const consume = vi.spyOn(PreAuthRateLimiter.prototype, 'consume');
    const refund = vi.spyOn(PreAuthRateLimiter.prototype, 'refund');
    const authenticate = vi.spyOn(app.get(AuthProvider), 'authenticate');
    try {
      const res = await request(app.getHttpServer()).get('/probe/who').set('x-api-key', `oak_${'a'.repeat(40)}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthenticated');
      expect(authenticate).not.toHaveBeenCalled();
      expect(consume).toHaveBeenCalledTimes(1);
      expect(refund).not.toHaveBeenCalled();
    } finally {
      consume.mockRestore();
      refund.mockRestore();
      authenticate.mockRestore();
    }
  });
```

- [ ] **Step 6: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/identity
pnpm typecheck
pnpm vitest run --project integration test/integration/identity test/e2e/identity
```
Expected: PASS; `typecheck` bắt mọi chỗ dựng `AUTHENTICATED` thiếu trường (không còn).

- [ ] **Step 7: Commit**

```bash
git add src/modules/identity test/unit/modules/identity/principal-resolver.spec.ts test/integration/identity/better-auth-provider.spec.ts test/integration/identity/jwks-provider.spec.ts test/e2e/identity/principal-guard.e2e.spec.ts
git commit -m "feat(identity): idempotent PrincipalResolver, facts on AUTHENTICATED, oak_ keys routed to an optional port"
```

---

### Task 10: `AuthFacts`, `@RequireFreshSession()` / `@RequireVerifiedEmail()` trong `AuthGuard`, `IdentityDirectory.findUsers`, `AUTH_DIRECTORY_BATCH_MAX`; helper principal e2e

**Files:**
- Create: `src/modules/identity/http/auth-facts.ts`, `src/modules/identity/http/fresh-session.decorator.ts`, `test/support/tenancy-principals.ts`, `test/e2e/identity/fresh-session.e2e.spec.ts`, `test/unit/modules/identity/directory-batch-rule.spec.ts`
- Modify: `src/modules/identity/http/auth.guard.ts`, `src/modules/identity/http/identity-request.module.ts`, `src/modules/identity/identity.config.ts`, `src/modules/identity/ports/identity-directory.ts`, `src/modules/identity/infra/better-auth/pg-identity-directory.ts`, `src/modules/identity/index.ts`, `test/integration/identity/directory-ledger.spec.ts`, `test/integration/identity/auth-hooks.spec.ts`

**Interfaces:**
- Consumes: `AuthState`, `AuthResult` (Task 9), `identityConfig.sessionFreshAgeSec`, `paginationConfig` (SP1).
- Produces:
  - `AuthFacts` (global qua `IdentityRequestModule`): `isPlatformAdmin(): boolean`, `authenticatedAt(): Date | undefined`, `emailVerified(): boolean`, `verifiedEmail(): string | undefined` — đồng bộ, đọc `AuthState` của request (tenancy không đọc `AuthState` nội bộ).
  - `RequireFreshSession()`, `RequireVerifiedEmail()` (`ClassDecorator & MethodDecorator`), khoá metadata `REQUIRE_FRESH_SESSION`, `REQUIRE_VERIFIED_EMAIL`. `AuthGuard` (APP_GUARD) với principal `AUTHENTICATED`: thiếu email đã xác thực → `403 email_not_verified`; `authenticatedAt` thiếu hoặc cũ hơn `AUTH_SESSION_FRESH_AGE_SEC` → `403 reauthentication_required`. Không phụ thuộc `AUTH_REQUIRE_EMAIL_VERIFICATION`.
  - `IdentityDirectory.findUsers(ids: readonly string[]): Promise<DirectoryUser[]>` (một query `WHERE id = ANY($1)`, tối đa `AUTH_DIRECTORY_BATCH_MAX`, quá → ném).
  - Env `AUTH_DIRECTORY_BATCH_MAX` (namespace `identity`, khoá `directoryBatchMax`, mặc định 100, 1–1000) + luật mọi môi trường `identity-directory-batch-covers-page` (`≥ PAGINATION_MAX_PAGE_SIZE`).
  - `test/support/tenancy-principals.ts`: `seedUserPrincipal(opts?: { role?: string; emailVerified?: boolean; sessionAgeSec?: number }): Promise<SeededPrincipal>`, `SeededPrincipal = { authUserId: string; email: string; bearer: string; sessionId: string }`, `deleteSeededPrincipals(ps: readonly SeededPrincipal[]): Promise<void>`.

- [ ] **Step 1: Helper principal e2e**

`test/support/tenancy-principals.ts`:
```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { ownerQuery } from './identity-app.js';

export type SeededPrincipal = {
  authUserId: string;
  email: string;
  bearer: string;
  sessionId: string;
};
/** Mặc định `AUTH_SESSION_EXPIRES_IN_SEC`: session seed không tới ngưỡng gia hạn trong một lần chạy test. */
const SESSION_TTL_SEC = 604_800;
const TOKEN_BYTES = 32;

/**
 * Principal local/hybrid cho e2e (spec SP3 §5.3, §18.0): chèn thẳng `auth."user"` KÈM `registered_event_emitted_at =
 * now()` (chèn thẳng bỏ qua `databaseHooks.user.create.after`; để NULL thì cron đối soát phát `identity.user.registered`
 * thừa, INT2-N-14) và một `auth.session`, rồi dùng token làm bearer (plugin `bearer` nhận token trần). `sessionAgeSec`
 * lùi `created_at` để thử `@RequireFreshSession`. Không có account `credential`: không đăng nhập bằng mật khẩu được.
 */
export async function seedUserPrincipal(
  opts: { role?: string; emailVerified?: boolean; sessionAgeSec?: number } = {},
): Promise<SeededPrincipal> {
  const email = `seed-${randomUUID()}@example.test`;
  const [user] = await ownerQuery<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at)
     VALUES ('Seeded', $1, $2, $3, now(), now(), now()) RETURNING id`,
    [email, opts.emailVerified ?? true, opts.role ?? null],
  );
  if (!user) throw new Error('seedUserPrincipal: user insert returned no row');
  const bearer = randomBytes(TOKEN_BYTES).toString('base64url');
  const [session] = await ownerQuery<{ id: string }>(
    `INSERT INTO auth.session (token, user_id, expires_at, created_at, updated_at)
     VALUES ($1, $2, now() + make_interval(secs => $3), now() - make_interval(secs => $4), now() - make_interval(secs => $4))
     RETURNING id`,
    [bearer, user.id, SESSION_TTL_SEC, opts.sessionAgeSec ?? 0],
  );
  if (!session) throw new Error('seedUserPrincipal: session insert returned no row');
  return { authUserId: user.id, email, bearer, sessionId: session.id };
}

/** Xoá user seed (session/account `CASCADE`). Dòng `tenancy_users` tham chiếu user phải được dọn trước (FK RESTRICT). */
export async function deleteSeededPrincipals(ps: readonly SeededPrincipal[]): Promise<void> {
  if (ps.length === 0) return;
  await ownerQuery(`DELETE FROM auth."user" WHERE id = ANY($1::uuid[])`, [ps.map((p) => p.authUserId)]);
}
```

- [ ] **Step 2: Test e2e của hai decorator (fail)**

`test/e2e/identity/fresh-session.e2e.spec.ts`:
```ts
import { Controller, Get, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AuthFacts,
  RequireFreshSession,
  RequireVerifiedEmail,
  SessionOnly,
} from '../../../src/modules/identity/index.js';
import { startIdentityApp } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';

@Controller('probe-fresh')
class FreshProbe {
  constructor(private readonly facts: AuthFacts) {}
  @Get('facts') facts() {
    return {
      admin: this.facts.isPlatformAdmin(),
      verified: this.facts.emailVerified(),
      email: this.facts.verifiedEmail() ?? null,
      at: this.facts.authenticatedAt()?.toISOString() ?? null,
    };
  }
  @SessionOnly() @RequireFreshSession() @RequireVerifiedEmail() @Post('sensitive') sensitive() {
    return { ok: true };
  }
}
@Module({ controllers: [FreshProbe] })
class ProbeModule {}

/** Mặc định `AUTH_SESSION_FRESH_AGE_SEC`. */
const FRESH_AGE_SEC = 600;

describe('@RequireFreshSession / @RequireVerifiedEmail (spec SP3 §5.2, S2-R76, SEC-I4)', () => {
  let app: INestApplication;
  const seeded: SeededPrincipal[] = [];
  const seed = async (o: Parameters<typeof seedUserPrincipal>[0] = {}) => {
    const p = await seedUserPrincipal(o);
    seeded.push(p);
    return p;
  };
  beforeAll(async () => {
    // Cờ tắt: decorator vẫn đòi email đã xác thực (không phụ thuộc AUTH_REQUIRE_EMAIL_VERIFICATION).
    app = await startIdentityApp({ extraImports: [ProbeModule], env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' } });
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
    vi.unstubAllEnvs();
  });
  const post = (p: SeededPrincipal) => request(app.getHttpServer()).post('/probe-fresh/sensitive').set('authorization', `Bearer ${p.bearer}`);

  it('AuthFacts reflect the authenticated principal', async () => {
    const p = await seed({ role: 'admin' });
    const r = await request(app.getHttpServer()).get('/probe-fresh/facts').set('authorization', `Bearer ${p.bearer}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ admin: true, verified: true, email: p.email });
    expect(Date.now() - Date.parse(r.body.at)).toBeLessThan(FRESH_AGE_SEC * 1000);
  });
  it('fresh + verified → 200', async () => {
    expect((await post(await seed())).status).toBe(201);
  });
  it('a session older than AUTH_SESSION_FRESH_AGE_SEC → 403 reauthentication_required', async () => {
    const r = await post(await seed({ sessionAgeSec: FRESH_AGE_SEC + 60 }));
    expect([r.status, r.body.code]).toEqual([403, 'reauthentication_required']);
  });
  it('an unverified user with AUTH_REQUIRE_EMAIL_VERIFICATION=false → 403 email_not_verified', async () => {
    const r = await post(await seed({ emailVerified: false }));
    expect([r.status, r.body.code]).toEqual([403, 'email_not_verified']);
  });
});
```
Run: `pnpm vitest run --project integration test/e2e/identity/fresh-session.e2e.spec.ts`
Expected: FAIL (`AuthFacts` không được export).

- [ ] **Step 3: `AuthFacts`, decorator và kiểm trong `AuthGuard`**

`src/modules/identity/http/auth-facts.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { AuthResult } from '../ports/auth-provider.js';
import { AuthState } from './auth-state.js';

type Authenticated = Extract<AuthResult, { kind: 'AUTHENTICATED' }>;

/**
 * Sự thật về principal của request, chỉ đọc (spec SP3 §5.2): tenancy dùng thay vì đọc `AuthState` (luật
 * `modules-only-index-of-other-modules`). Đồng bộ, từ kết quả xác thực đã có; không query. Không có principal → mọi
 * giá trị "không" (false/undefined).
 */
@Injectable()
export class AuthFacts {
  constructor(private readonly state: AuthState) {}
  private authed(): Authenticated | undefined {
    const r = this.state.get();
    return r.kind === 'AUTHENTICATED' ? r : undefined;
  }
  isPlatformAdmin(): boolean {
    return this.authed()?.isPlatformAdmin ?? false;
  }
  authenticatedAt(): Date | undefined {
    return this.authed()?.authenticatedAt;
  }
  emailVerified(): boolean {
    return this.authed()?.emailVerified ?? false;
  }
  verifiedEmail(): string | undefined {
    return this.authed()?.verifiedEmail;
  }
}
```
`src/modules/identity/http/fresh-session.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const REQUIRE_FRESH_SESSION = 'identity:requireFreshSession';
export const REQUIRE_VERIFIED_EMAIL = 'identity:requireVerifiedEmail';
/** Spec SP3 §5.2: thao tác nhạy cảm cần lần xác thực trong `AUTH_SESSION_FRESH_AGE_SEC` (external: claim `auth_time`). */
export const RequireFreshSession = (): ClassDecorator & MethodDecorator =>
  SetMetadata(REQUIRE_FRESH_SESSION, true);
/** Spec SP3 §5.2, S2-R76: email đã xác thực, BẤT KỂ `AUTH_REQUIRE_EMAIL_VERIFICATION`. */
export const RequireVerifiedEmail = (): ClassDecorator & MethodDecorator =>
  SetMetadata(REQUIRE_VERIFIED_EMAIL, true);
```
`src/modules/identity/http/auth.guard.ts` — import `identityConfig, type IdentityConfig` và hai khoá; constructor thêm `@Inject(identityConfig.KEY) private readonly identity: IdentityConfig`; nhánh `AUTHENTICATED`:
```ts
      case 'AUTHENTICATED': {
        if (isPublic) return true;
        const flag = (key: string) =>
          this.reflector.getAllAndOverride<boolean>(key, targets) === true;
        if (r.credential.kind === 'API_KEY' && flag(SESSION_ONLY))
          throw new AppError(CoreErrors.FORBIDDEN, {
            detail: 'This operation requires a signed-in session',
          });
        if (flag(REQUIRE_VERIFIED_EMAIL) && !r.emailVerified)
          throw new AppError(IdentityErrors.EMAIL_NOT_VERIFIED);
        if (
          flag(REQUIRE_FRESH_SESSION) &&
          (r.authenticatedAt === undefined ||
            Date.now() - r.authenticatedAt.getTime() >
              this.identity.sessionFreshAgeSec * MS_PER_SECOND)
        )
          throw new AppError(IdentityErrors.REAUTHENTICATION_REQUIRED);
        return true;
      }
```
với `const MS_PER_SECOND = 1000;` ở đầu file.
`src/modules/identity/http/identity-request.module.ts`: thêm `AuthFacts` vào `providers` và `exports`.
`src/modules/identity/index.ts` thêm:
```ts
export { AuthFacts } from './http/auth-facts.js';
export {
  RequireFreshSession,
  RequireVerifiedEmail,
} from './http/fresh-session.decorator.js';
```

- [ ] **Step 4: `findUsers` và `AUTH_DIRECTORY_BATCH_MAX`**

Test trước — `test/unit/modules/identity/directory-batch-rule.spec.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { paginationConfig } from '../../../../src/core/http/index.js';
import { identityConfig } from '../../../../src/modules/identity/identity.config.js';

const LOCAL = { AUTH_MODE: 'local', BETTER_AUTH_SECRET: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0', AUTH_BASE_URL: 'http://localhost:3000' };
const check = () => {
  const r = configRuleRegistry().find((x) => x.name === 'identity-directory-batch-covers-page');
  if (!r) throw new Error('rule not registered');
  return r.rule({ identity: identityConfig(), pagination: paginationConfig() });
};

describe('AUTH_DIRECTORY_BATCH_MAX (spec SP3 §5.2, §13)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to 100, accepts 1..1000 and must cover one page of members', () => {
    for (const [k, v] of Object.entries(LOCAL)) vi.stubEnv(k, v);
    expect(identityConfig().directoryBatchMax).toBe(100);
    expect(check()).toBeUndefined();
    vi.stubEnv('AUTH_DIRECTORY_BATCH_MAX', '1001');
    expect(() => identityConfig()).toThrow(/AUTH_DIRECTORY_BATCH_MAX/);
    vi.stubEnv('AUTH_DIRECTORY_BATCH_MAX', '50');
    expect(check()).toBe('AUTH_DIRECTORY_BATCH_MAX (50) must be at least PAGINATION_MAX_PAGE_SIZE (100)');
  });
});
```
`src/modules/identity/identity.config.ts`:
- map env: thêm `directoryBatchMax: 'AUTH_DIRECTORY_BATCH_MAX',` (cuối object env của `identityConfig`);
- schema: thêm
```ts
      directoryBatchMax: positiveInt
        .max(MAX_DIRECTORY_BATCH)
        .default(100)
        .describe(
          'Max user ids per IdentityDirectory.findUsers query (one member page = one query); must be at least PAGINATION_MAX_PAGE_SIZE',
        ),
```
với hằng `const MAX_DIRECTORY_BATCH = 1000;` cạnh các hằng đầu file;
- luật (sau `identity-session-fresh-age`):
```ts
/** Spec SP3 §13: một trang member tra directory đúng một lần, nên lô tối đa phải phủ trang lớn nhất. */
defineConfigRule('identity-directory-batch-covers-page', (c) => {
  const batch = c.identity?.directoryBatchMax;
  const page = c.pagination?.maxPageSize;
  if (typeof batch !== 'number' || typeof page !== 'number') return undefined;
  return batch >= page
    ? undefined
    : `AUTH_DIRECTORY_BATCH_MAX (${batch}) must be at least PAGINATION_MAX_PAGE_SIZE (${page})`;
});
```
`src/modules/identity/ports/identity-directory.ts` — `IdentityDirectory` thêm:
```ts
  /** Spec SP3 §5.2: một query cho cả trang (không N+1); id không tồn tại bị bỏ qua; quá `AUTH_DIRECTORY_BATCH_MAX` → ném. */
  abstract findUsers(ids: readonly string[]): Promise<DirectoryUser[]>;
```
`src/modules/identity/infra/better-auth/pg-identity-directory.ts`:
```ts
@Injectable()
export class PgIdentityDirectory extends IdentityDirectory {
  private readonly batchMax: number;
  constructor(
    @Inject(AUTH_POOL) private readonly pool: pg.Pool,
    @Inject(identityConfig.KEY) identity: IdentityConfig,
  ) {
    super();
    this.batchMax = identity.directoryBatchMax;
  }
  // findUser, findUserByEmail giữ nguyên
  async findUsers(ids: readonly string[]): Promise<DirectoryUser[]> {
    if (ids.length === 0) return [];
    if (ids.length > this.batchMax)
      throw new Error(
        `IdentityDirectory.findUsers accepts at most ${this.batchMax} ids (AUTH_DIRECTORY_BATCH_MAX), got ${ids.length}`,
      );
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth."user" WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return z.array(Row).parse(rows).map(toUser);
  }
}
```
(import `identityConfig, type IdentityConfig` từ `../../identity.config.js`.)
`test/integration/identity/auth-hooks.spec.ts` (review I2: file dựng `PgIdentityDirectory` bằng tay ở hai chỗ; `tsconfig.json` có `include: ["src", "test"]` nên thiếu tham số mới làm `pnpm typecheck` đỏ). `identityConfig` đã được import từ `identity.config.js` trong file; gọi nó đọc env của test như các chỗ khác trong file (`identityConfig().secret`):
- trong `beforeAll` của describe đầu: `const directory = new PgIdentityDirectory(pool);` → `const directory = new PgIdentityDirectory(pool, identityConfig());`
- trong ca dựng `createAuthInstance` với pool một connection: `directory: new PgIdentityDirectory(small),` → `directory: new PgIdentityDirectory(small, identityConfig()),`
Thêm vào `test/integration/identity/directory-ledger.spec.ts`:
```ts
  it('findUsers reads a whole page in one query and skips unknown ids; more than the batch max is refused', async () => {
    const a = await insertUser(`fa-${v7()}@example.test`);
    const b = await insertUser(`fb-${v7()}@example.test`);
    const dir = app.get(PgIdentityDirectory);
    const found = await dir.findUsers([a, b, v7()]);
    expect(found.map((u) => u.id).sort()).toEqual([a, b].sort());
    expect(await dir.findUsers([])).toEqual([]);
    await expect(dir.findUsers(Array.from({ length: 101 }, () => v7()))).rejects.toThrow(/AUTH_DIRECTORY_BATCH_MAX/);
  });
```

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/identity
pnpm vitest run --project integration test/e2e/identity test/integration/identity/directory-ledger.spec.ts test/integration/identity/auth-hooks.spec.ts
pnpm typecheck
pnpm env:example && git diff --stat .env.example
```
Expected: PASS; `typecheck` xanh (không còn lời gọi `new PgIdentityDirectory(pool)` một tham số); `.env.example` có thêm `AUTH_DIRECTORY_BATCH_MAX=100` kèm mô tả.

- [ ] **Step 6: Commit**

```bash
git add src/modules/identity test/support/tenancy-principals.ts test/e2e/identity/fresh-session.e2e.spec.ts test/unit/modules/identity/directory-batch-rule.spec.ts test/integration/identity/directory-ledger.spec.ts test/integration/identity/auth-hooks.spec.ts .env.example
git commit -m "feat(identity): AuthFacts, RequireFreshSession/RequireVerifiedEmail in AuthGuard, batched IdentityDirectory.findUsers"
```

---

### Task 11: Port `UserDeletionGuard`, mã `user_deletion_blocked`, `hooks.before` trên mọi đường xoá user (id đích như plugin), cấm tiền tố `oak_` ở `/api-key/create`

**Files:**
- Create: `src/modules/identity/ports/user-deletion-guard.ts`, `test/e2e/identity/user-deletion-precheck.e2e.spec.ts`, `test/unit/modules/identity/admin-target-user-id.spec.ts`
- Modify: `src/modules/identity/errors.ts`, `src/modules/identity/index.ts`, `src/modules/identity/infra/better-auth/auth-hooks.ts`, `src/modules/identity/infra/better-auth/auth-instance.ts`, `src/modules/identity/infra/better-auth/better-auth-core.module.ts`, `src/modules/identity/infra/better-auth/auth-error.mapper.ts`, `test/unit/modules/identity/auth-error.mapper.spec.ts`

**Interfaces:**
- Consumes: `hasAdminRole`, `problem()` của hook, `d.session(headers)` (SP2), `ORG_API_KEY_PREFIX`/`isOrgApiKey` (Task 9).
- Produces:
  - `type UserDeletionCheck = { kind: 'ALLOWED' } | { kind: 'BLOCKED_LAST_OWNER'; orgCount: number }`, `type UserDeletionRelease = { kind: 'RELEASED' } | { kind: 'BLOCKED_RACE'; reason: 'MEMBERSHIP_CREATED' | 'LAST_OWNER' }`, `abstract class UserDeletionGuard { abstract check(authUserId: string): Promise<UserDeletionCheck>; abstract release(authUserId: string): Promise<UserDeletionRelease> }` (export `identity/index.ts`; tenancy cài ở Task 26 bằng module `@Global`).
  - `IdentityErrors.USER_DELETION_BLOCKED` (409, `user_deletion_blocked`); `USER_DELETION_BLOCKED_CODE = 'USER_DELETION_BLOCKED'` trong `AUTH_CODE_MAP`, kèm `detail` cố định (nhánh đua, Task 12).
  - `USER_DELETION_PATHS: ReadonlySet<string>` = `/admin/remove-user`, `/delete-user`, `/delete-user/callback`; `adminTargetUserId(body: unknown): string | undefined` — `body.userId` ép bằng `z.coerce.string()` như plugin, rồi `z.uuid()`, rồi đòi đúng dạng chữ thường; không đạt → `undefined` (hook trả `422` cho mọi `/admin/remove-user` có session admin, có hay không có guard — review I1). 3D dùng lại hàm này.
  - `AuthHookDeps.userDeletion: UserDeletionGuard | undefined`; `AuthInstanceDeps.userDeletion?: UserDeletionGuard`; `BetterAuthCoreModule` inject `{ token: UserDeletionGuard, optional: true }`.

- [ ] **Step 1: Test đơn vị của `adminTargetUserId` (fail)**

`test/unit/modules/identity/admin-target-user-id.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { adminTargetUserId } from '../../../../src/modules/identity/infra/better-auth/auth-hooks.js';

const ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('adminTargetUserId (spec SP3 §5.2, r7 N7-3, r8 R8-S2)', () => {
  it('reads the id exactly as the admin plugin coerces it', () => {
    expect(adminTargetUserId({ userId: ID })).toBe(ID);
    expect(adminTargetUserId({ userId: [ID] })).toBe(ID);
  });
  it.each([
    ['uppercase', { userId: ID.toUpperCase() }],
    ['braces', { userId: `{${ID}}` }],
    ['no hyphens', { userId: ID.replaceAll('-', '') }],
    ['a number', { userId: 42 }],
    ['missing', {}],
    ['two ids', { userId: [ID, ID] }],
    ['not an object', 'x'],
  ])('refuses %s (the hook answers 422 before any guard runs)', (_n, body) => {
    expect(adminTargetUserId(body)).toBeUndefined();
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/identity/admin-target-user-id.spec.ts`
Expected: FAIL (không export `adminTargetUserId`).

- [ ] **Step 2: Port, mã lỗi, mapper**

`src/modules/identity/ports/user-deletion-guard.ts`:
```ts
/** Kết quả kiểm trước khi Better Auth xoá gì (spec SP3 §9.6 bước 1). */
export type UserDeletionCheck =
  | { kind: 'ALLOWED' }
  | { kind: 'BLOCKED_LAST_OWNER'; orgCount: number };
/**
 * Kết quả dọn tenancy trong `databaseHooks.user.delete.before` (bước 3), SAU khi session và account đã bị xoá. Đua
 * được trả thành kết quả có tên, không ném (lỗi không phải `APIError` trong hook thành 500, spec §15).
 */
export type UserDeletionRelease =
  | { kind: 'RELEASED' }
  | { kind: 'BLOCKED_RACE'; reason: 'MEMBERSHIP_CREATED' | 'LAST_OWNER' };

/**
 * Port (spec SP3 §5.2): tenancy cài bằng module `@Global()` chỉ ở process api; identity inject `@Optional()` (vắng →
 * hook bỏ qua, lớp chặn còn lại là FK `tenancy_users_auth_user_fk`). Chỉ ném với lỗi hạ tầng/lỗi lập trình.
 */
export abstract class UserDeletionGuard {
  abstract check(authUserId: string): Promise<UserDeletionCheck>;
  abstract release(authUserId: string): Promise<UserDeletionRelease>;
}
```
`src/modules/identity/errors.ts` thêm (sau `EMAIL_TAKEN`):
```ts
  /** Spec SP3 §9.6, §15: identity sở hữu mã (identity không import tenancy); `last_owner` của tenancy chỉ ở route tenancy. */
  USER_DELETION_BLOCKED: {
    status: HttpStatus.CONFLICT,
    title: 'The account is the only owner of an active organization',
  },
```
`src/modules/identity/infra/better-auth/auth-error.mapper.ts`:
- thêm hằng và detail:
```ts
/** Mã do CHÍNH identity ném trong `databaseHooks.user.delete.before` và `onAPIError.onError` (nhánh đua, spec SP3 §9.6). */
export const USER_DELETION_BLOCKED_CODE = 'USER_DELETION_BLOCKED';
/** Detail cố định cho mã của mình (quy tắc 6: không chép message của Better Auth). */
export const AUTH_CODE_DETAIL: Readonly<Record<string, string>> = {
  [USER_DELETION_BLOCKED_CODE]:
    'The account lost its sessions and password during a race with an organization change; see the runbook for a partially deleted account',
};
```
- `AUTH_CODE_MAP` thêm `[USER_DELETION_BLOCKED_CODE]: IdentityErrors.USER_DELETION_BLOCKED,`;
- trong `mapAuthError`, nhánh `decision && input.code`:
```ts
    const detail = AUTH_CODE_DETAIL[input.code];
    return new AppError(decision.error, {
      ...(fields ? { fields } : {}),
      ...(detail ? { detail } : {}),
    });
```
`test/unit/modules/identity/auth-error.mapper.spec.ts` thêm:
```ts
  it('USER_DELETION_BLOCKED (our own race branch) maps to 409 user_deletion_blocked with the runbook detail', () => {
    const e = mapAuthError({ status: 409, code: 'USER_DELETION_BLOCKED', path: '/admin/remove-user' }, { unavailableRetryAfterSec: 5 });
    expect([e.error.status, e.error.code]).toEqual([409, 'user_deletion_blocked']);
    expect(e.opts.detail).toMatch(/runbook/);
  });
```
(ca "every Better Auth code … has an explicit decision" vẫn xanh: mã của mình nằm trong `AUTH_CODE_MAP`, không trùng.)

- [ ] **Step 3: Test e2e của kiểm trước (fail)**

`test/e2e/identity/user-deletion-precheck.e2e.spec.ts`:
```ts
import { Global, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  UserDeletionGuard,
  type UserDeletionCheck,
  type UserDeletionRelease,
} from '../../../src/modules/identity/index.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';

const guard = {
  check: vi.fn(async (_id: string): Promise<UserDeletionCheck> => ({ kind: 'ALLOWED' })),
  release: vi.fn(async (_id: string): Promise<UserDeletionRelease> => ({ kind: 'RELEASED' })),
};
@Global()
@Module({ providers: [{ provide: UserDeletionGuard, useValue: guard }], exports: [UserDeletionGuard] })
class FakeGuardModule {}

const credentialsLeft = async (id: string) =>
  (await ownerQuery<{ u: number; s: number }>(
    `SELECT (SELECT count(*)::int FROM auth."user" WHERE id = $1) AS u, (SELECT count(*)::int FROM auth.session WHERE user_id = $1) AS s`,
    [id],
  ))[0];

describe('user deletion pre-check in hooks.before (spec SP3 §9.6, O-2, O-2b, O-17, T5)', () => {
  let app: INestApplication;
  const seeded: SeededPrincipal[] = [];
  const seed = async (role?: string) => {
    const p = await seedUserPrincipal({ role });
    seeded.push(p);
    return p;
  };
  const removeUser = (as: SeededPrincipal, userId: unknown) =>
    request(app.getHttpServer()).post('/api/auth/admin/remove-user').set('authorization', `Bearer ${as.bearer}`).send({ userId });
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [FakeGuardModule] });
  });
  afterEach(() => {
    guard.check.mockClear();
    guard.release.mockClear();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
  });

  it('BLOCKED_LAST_OWNER → 409 user_deletion_blocked with the org count; nothing is deleted', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    guard.check.mockResolvedValueOnce({ kind: 'BLOCKED_LAST_OWNER', orgCount: 2 });
    const r = await removeUser(admin, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/2 active organization/);
    expect(guard.check).toHaveBeenCalledWith(victim.authUserId);
    expect(guard.release).not.toHaveBeenCalled();
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it('O-2b: userId sent as ["<id>"] is read as the plugin coerces it and still blocked', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    guard.check.mockResolvedValueOnce({ kind: 'BLOCKED_LAST_OWNER', orgCount: 1 });
    const r = await removeUser(admin, [victim.authUserId]);
    expect(r.status).toBe(409);
    expect(guard.check).toHaveBeenCalledWith(victim.authUserId);
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it.each([
    ['an uppercase id', (id: string) => id.toUpperCase()],
    ['a braced id', (id: string) => `{${id}}`],
    ['an id without hyphens', (id: string) => id.replaceAll('-', '')],
  ])('O-2b: %s → 422 validation_failed before any guard or plugin runs', async (_n, shape) => {
    const [admin, victim] = [await seed('admin'), await seed()];
    const r = await removeUser(admin, shape(victim.authUserId));
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
    expect(guard.check).not.toHaveBeenCalled();
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it("O-2b: the admin's own id in uppercase → 422, the admin keeps its session", async () => {
    const admin = await seed('admin');
    const r = await removeUser(admin, admin.authUserId.toUpperCase());
    expect(r.status).toBe(422);
    expect(await credentialsLeft(admin.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it('O-17: a non-admin gets the plugin permission error, never 409 (no last-owner oracle)', async () => {
    const [user, victim] = [await seed(), await seed()];
    const r = await removeUser(user, victim.authUserId);
    expect(r.status).not.toBe(409);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(guard.check).not.toHaveBeenCalled();
  });
  it('ALLOWED → Better Auth deletes; release runs in databaseHooks.user.delete.before (Task 12)', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    const r = await removeUser(admin, victim.authUserId);
    expect(r.status).toBe(200);
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 0, s: 0 });
  });
  it('/api-key/create refuses the reserved oak_ prefix in any case (INT-I9)', async () => {
    const user = await seed();
    for (const prefix of ['oak_x', 'OAK_', 'Oak_team']) {
      const r = await request(app.getHttpServer()).post('/api/auth/api-key/create').set('authorization', `Bearer ${user.bearer}`).send({ name: 'k', prefix });
      expect([r.status, r.body.code], prefix).toEqual([422, 'validation_failed']);
      expect(r.body.errors?.[0]?.path).toBe('prefix');
    }
    const ok = await request(app.getHttpServer()).post('/api/auth/api-key/create').set('authorization', `Bearer ${user.bearer}`).send({ name: 'k', prefix: 'oakx' });
    expect(ok.status).toBe(200);
  });
});

describe('without a UserDeletionGuard the admin target id is still checked (review I1, R8-S2)', () => {
  let app: INestApplication;
  const seeded: SeededPrincipal[] = [];
  const seed = async (role?: string) => {
    const p = await seedUserPrincipal({ role });
    seeded.push(p);
    return p;
  };
  const removeUser = (as: SeededPrincipal, userId: unknown) =>
    request(app.getHttpServer()).post('/api/auth/admin/remove-user').set('authorization', `Bearer ${as.bearer}`).send({ userId });
  beforeAll(async () => {
    // App identity như SP2 (không tenancy, không FakeGuardModule): hook không có guard.
    app = await startIdentityApp();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
  });

  it("the admin's own id in uppercase → 422 validation_failed; the admin keeps its user and session", async () => {
    const admin = await seed('admin');
    const r = await removeUser(admin, admin.authUserId.toUpperCase());
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
    expect(r.body.errors?.[0]?.path).toBe('userId');
    expect(await credentialsLeft(admin.authUserId)).toEqual({ u: 1, s: 1 });
  });
  it('a canonical lowercase id of another user is deleted as in SP2', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    const r = await removeUser(admin, victim.authUserId);
    expect(r.status).toBe(200);
    expect(await credentialsLeft(victim.authUserId)).toEqual({ u: 0, s: 0 });
  });
});
```
Ghi chú: ca `ALLOWED` phụ thuộc Task 12 ở phần `release` (hook `delete.before`); ở Task 11 nó xanh vì chưa có hook `delete.before` nào. `seedUserPrincipal` tạo session mới ngay (không vướng độ mới của `/api-key/create`, `SENSITIVE`). Hai `describe` dựng app lần lượt (app đầu đóng ở `afterAll` trước khi app sau khởi động), như `user-deletion-release.spec.ts` của Task 12. Ca thứ hai của `describe` sau xoá `victim` thật; `deleteSeededPrincipals` bỏ qua user đã mất.

Run: `pnpm vitest run --project integration test/e2e/identity/user-deletion-precheck.e2e.spec.ts`
Expected: FAIL (các ca `409`/`422` nhận `200`).

- [ ] **Step 4: Hook**

`src/modules/identity/infra/better-auth/auth-hooks.ts`:
- import thêm: `import { z } from 'zod';`, `hasAdminRole` (giá trị) và `type UserDeletionGuard` từ `../../ports/…`, `ORG_API_KEY_PREFIX, isOrgApiKey` từ `../../ports/org-credential-authenticator.js`;
- hằng và hàm export (sau `EMAIL_FIELDS_BY_PATH`):
```ts
const ADMIN_REMOVE_USER = '/admin/remove-user';
const API_KEY_CREATE = '/api-key/create';
/**
 * Mọi đường xoá `auth."user"` của Better Auth 1.7.6 (spec SP3 §9.6, liệt kê từ source): hai path sau trả 404 ở SP2
 * (không bật `user.deleteUser`) nhưng vẫn được phủ để dự án bật sau không mở lỗ.
 */
export const USER_DELETION_PATHS: ReadonlySet<string> = new Set([
  ADMIN_REMOVE_USER,
  '/delete-user',
  '/delete-user/callback',
]);
/** Cùng `z.coerce.string()` của schema plugin admin (`plugins/admin/routes.mjs`), rồi đòi UUID. */
const PluginUserId = z.coerce.string().pipe(z.uuid());
/**
 * Id đích của `/admin/*` đúng như plugin đọc (spec SP3 §5.2, r7 N7-3, r8 R8-S2): `["<id>"]` thành `"<id>"`. Chỉ nhận dạng
 * chữ thường chuẩn, KHÔNG chuẩn hoá: Postgres so `uuid` không phân biệt hoa thường còn plugin so "chính mình" bằng chuỗi
 * thô, nên chỉ dạng chữ thường làm chuỗi hook đọc, chuỗi plugin so và user Postgres tìm là một. `undefined` → 422.
 */
export const adminTargetUserId = (body: unknown): string | undefined => {
  const parsed = PluginUserId.safeParse(asRecord(body).userId);
  if (!parsed.success) return undefined;
  return parsed.data === parsed.data.toLowerCase() ? parsed.data : undefined;
};
```
(`asRecord` đã có ở dưới trong file: di chuyển khai báo `asRecord`/`stringField` lên trên `adminTargetUserId`.)
- `HookSession.user` thêm `role?: string | null | undefined`:
```ts
export type HookSession = {
  user: User & {
    twoFactorEnabled?: boolean | null | undefined;
    role?: string | null | undefined;
  };
  session: { id: string; createdAt: Date };
};
```
- `AuthHookDeps` thêm:
```ts
  /**
   * Spec SP3 §9.6: port của tenancy (`@Optional`); vắng → không gọi `check()` (dạng `userId` của admin vẫn bị kiểm),
   * còn FK và `onError` (Task 12).
   */
  userDeletion: UserDeletionGuard | undefined;
```
- trong `createAuthHooks`, cạnh `nameProblem`:
```ts
  const invalidField = (ctx: HookCtx, path: string, code: string, message: string) =>
    problem(ctx, new AppError(CoreErrors.VALIDATION_FAILED, { fields: [{ path, code, message }] }));

  /**
   * Spec SP3 §9.6 bước 1: từ chối owner duy nhất TRƯỚC khi Better Auth xoá gì. Với admin path chỉ chạy khi session là
   * platform admin và đích khác chính mình (không thì plugin tự từ chối: không biến hook thành oracle "X là owner cuối").
   * Kiểm dạng `userId` của `/admin/remove-user` (→ `422`) KHÔNG phụ thuộc guard có mặt (review I1, spec §5.2 hàng
   * `auth-hooks.ts`): id viết hoa làm plugin coi đích khác chính mình trong khi Postgres tìm ra chính admin (R8-S2), lỗ
   * này tồn tại cả ở app không bật tenancy. Chỉ lời gọi `check()` cần guard.
   */
  const deletionPrecheck = async (
    ctx: HookCtx,
    session: HookSession | null,
    body: Record<string, unknown>,
  ): Promise<Response | undefined> => {
    if (!session) return undefined;
    let subject = session.user.id;
    if (ctx.path === ADMIN_REMOVE_USER) {
      if (!hasAdminRole(session.user.role)) return undefined;
      const target = adminTargetUserId(body);
      if (target === undefined)
        return invalidField(ctx, 'userId', 'invalid_user_id', 'userId must be a canonical lowercase UUID');
      if (target === session.user.id) return undefined;
      subject = target;
    }
    if (!d.userDeletion) return undefined;
    const r = await d.userDeletion.check(subject);
    switch (r.kind) {
      case 'ALLOWED':
        return undefined;
      case 'BLOCKED_LAST_OWNER':
        d.logger.warn({ event: 'user_deletion_blocked', path: ctx.path, orgCount: r.orgCount }, 'account deletion refused: the user is the only owner of an active organization');
        return problem(
          ctx,
          new AppError(IdentityErrors.USER_DELETION_BLOCKED, {
            detail: `The account is the only owner of ${r.orgCount} active organization(s); transfer ownership or delete them first`,
          }),
        );
      default: {
        const unknown: never = r;
        throw new Error(`unknown user deletion check ${JSON.stringify(unknown)}`);
      }
    }
  };
```
- trong `before`: ngay sau khối `nameProblem`:
```ts
    // INT-I9, SEC-M14 (spec SP3 §5.2): Better Auth nhận `prefix` từ client; key mang `oak_` sẽ bị định tuyến sang
    // tenancy và hỏng âm thầm. Đi cùng plan với định tuyến `oak_` của PrincipalResolver (INT2-N-6).
    if (ctx.path === API_KEY_CREATE) {
      const prefix = stringField(body, 'prefix');
      if (prefix !== undefined && isOrgApiKey(prefix))
        return invalidField(ctx, 'prefix', 'reserved_prefix', `The ${ORG_API_KEY_PREFIX} prefix is reserved for organization API keys`);
    }
```
đổi điều kiện đọc session thành `SENSITIVE.has(ctx.path) || verifiedOwner || USER_DELETION_PATHS.has(ctx.path)`, và ngay sau kiểm độ mới (khối `REAUTHENTICATION_REQUIRED`):
```ts
    if (USER_DELETION_PATHS.has(ctx.path)) {
      const refused = await deletionPrecheck(ctx, session, body);
      if (refused) return refused;
    }
```
`src/modules/identity/infra/better-auth/auth-instance.ts`: `AuthInstanceDeps` thêm `userDeletion?: UserDeletionGuard;` (import type từ `../../ports/user-deletion-guard.js`); trong `createAuthHooks({...})` thêm `userDeletion: d.userDeletion,`.
`src/modules/identity/infra/better-auth/better-auth-core.module.ts`: `inject` của `BETTER_AUTH` thêm phần tử cuối `{ token: UserDeletionGuard, optional: true }`, `useFactory` thêm tham số cuối `userDeletion: UserDeletionGuard | undefined` và truyền `userDeletion` vào `createAuthInstance`.
`src/modules/identity/index.ts` thêm:
```ts
export {
  UserDeletionGuard,
  type UserDeletionCheck,
  type UserDeletionRelease,
} from './ports/user-deletion-guard.js';
```

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/identity
pnpm vitest run --project integration test/e2e/identity test/integration/identity/auth-hooks.spec.ts
```
Expected: PASS; test SP2 (`web-mobile.e2e.spec.ts` ca `/admin/remove-user`) xanh: app đó không có guard (không gọi `check()`), và id nó gửi là UUID chữ thường do `DEFAULT uuidv7()` sinh nên qua kiểm dạng `userId`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/identity test/unit/modules/identity test/e2e/identity/user-deletion-precheck.e2e.spec.ts
git commit -m "feat(identity): UserDeletionGuard port checked before Better Auth deletes anything; plugin-exact admin target id; oak_ prefix reserved"
```

---

### Task 12: `release` trong `databaseHooks.user.delete.before`, `onAPIError.onError` đổi `23001` thành `409` trước khi log (path đọc từ scope của mount); kiểm chứng prod-like #2 (identity trên image thật)

**Files:**
- Create: `test/integration/identity/user-deletion-release.spec.ts`
- Modify: `src/modules/identity/infra/better-auth/auth-db-failures.ts`, `src/modules/identity/infra/better-auth/auth-mount.middleware.ts`, `src/modules/identity/infra/better-auth/auth-options.ts`, `src/modules/identity/infra/better-auth/auth-instance.ts`, `test/unit/modules/identity/auth-db-failures.spec.ts`, `test/unit/modules/identity/auth-options.spec.ts`, `test/integration/identity/auth-options.spec.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: `UserDeletionGuard`, `USER_DELETION_PATHS`, `USER_DELETION_BLOCKED_CODE` (Task 11), `runWithAuthDbFailureScope`, `recordedAuthDbError` (SP2), `PG.RESTRICT_VIOLATION` (core).
- Produces:
  - `recordAuthPath(path: string): void`, `recordedAuthPath(): string | undefined` (`auth-db-failures.ts`): mount ghi path Better Auth (đã bỏ `basePath`) vào scope của request; `onError` đọc lại (chữ ký `onError(error, ctx: AuthContext)` không có request, T8).
  - `AuthOptionsInput.userDeletion?: UserDeletionGuard`, `AuthOptionsInput.onUserDeletionBlocked(reason: 'LAST_OWNER' | 'MEMBERSHIP_CREATED' | 'USER_ROW_REFERENCED'): void`.
  - `databaseHooks.user.delete.before` → `release`; `BLOCKED_RACE` → `APIError` 409 mã `USER_DELETION_BLOCKED` (detail runbook). `onError`: path ∈ `USER_DELETION_PATHS` và lỗi pg `23001` (hoặc `recordedAuthDbError()?.code === '23001'` khi Better Auth không chuyển nguyên lỗi) → WARN `user_deletion_blocked_race`, ném `APIError` 409 **trước** `onApiError` (không log ERROR `better_auth_unhandled_error`, không 5xx). Path khác → hành vi SP2 (500 có log).

- [ ] **Step 1: Test đơn vị của path trong scope (fail)**

Thêm vào `test/unit/modules/identity/auth-db-failures.spec.ts`:
```ts
describe('recordAuthPath / recordedAuthPath (spec SP3 T8, INT3-4)', () => {
  it('is visible inside the scope of the same call only', async () => {
    expect(recordedAuthPath()).toBeUndefined();
    await runWithAuthDbFailureScope(async () => {
      recordAuthPath('/admin/remove-user');
      await Promise.resolve();
      expect(recordedAuthPath()).toBe('/admin/remove-user');
    });
    await runWithAuthDbFailureScope(async () => {
      expect(recordedAuthPath()).toBeUndefined();
    });
    recordAuthPath('/outside');
    expect(recordedAuthPath()).toBeUndefined();
  });
});
```
(import `recordAuthPath, recordedAuthPath, runWithAuthDbFailureScope` từ file nguồn.)
`test/unit/modules/identity/auth-options.spec.ts`: `baseInput` thêm `onUserDeletionBlocked: () => undefined,` (field bắt buộc mới); thêm (import `vi` từ `vitest` và `recordAuthPath, runWithAuthDbFailureScope` từ `auth-db-failures.js`):
```ts
describe('onAPIError.onError and user deletion (spec SP3 §5.2, T8)', () => {
  const pgRestrict = Object.assign(new Error('update or delete on table "user" violates foreign key constraint'), { code: '23001' });
  it('on a user deletion path, 23001 becomes 409 USER_DELETION_BLOCKED before onApiError is called', async () => {
    const onApiError = vi.fn();
    const onUserDeletionBlocked = vi.fn();
    const opts = buildAuthOptions({ ...baseInput({ mode: 'local' }), onApiError, onUserDeletionBlocked });
    await runWithAuthDbFailureScope(async () => {
      recordAuthPath('/admin/remove-user');
      let thrown: unknown;
      try {
        opts.onAPIError.onError(pgRestrict);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ statusCode: 409, body: { code: 'USER_DELETION_BLOCKED' } });
    });
    expect(onApiError).not.toHaveBeenCalled();
    expect(onUserDeletionBlocked).toHaveBeenCalledWith('USER_ROW_REFERENCED');
  });
  it('the same error on another path stays a 500 that is logged (INT3-4)', async () => {
    const onApiError = vi.fn();
    const opts = buildAuthOptions({ ...baseInput({ mode: 'local' }), onApiError, onUserDeletionBlocked: vi.fn() });
    await runWithAuthDbFailureScope(async () => {
      recordAuthPath('/admin/revoke-user-sessions');
      expect(() => opts.onAPIError.onError(pgRestrict)).toThrow();
    });
    expect(onApiError).toHaveBeenCalledWith(pgRestrict);
  });
});
```
`test/integration/identity/auth-options.spec.ts` (review I3: `tsconfig.json` có `include: ["src", "test"]`, nên trường bắt buộc mới làm `pnpm typecheck` đỏ ở đây): trong `makeAuth`, lời gọi `buildAuthOptions({...})` thêm ngay sau `onApiError: () => undefined,`:
```ts
        onUserDeletionBlocked: () => undefined,
```
(file này không truyền `userDeletion`: Better Auth của nó không có hook `delete.before`, đúng hành vi SP2 mà các ca của file kiểm.)

Run: `pnpm vitest run --project unit test/unit/modules/identity/auth-db-failures.spec.ts test/unit/modules/identity/auth-options.spec.ts`
Expected: FAIL (hàm chưa có).

- [ ] **Step 2: Scope mang path; mount ghi path**

`src/modules/identity/infra/better-auth/auth-db-failures.ts`: `Scope` thêm `path?: string;` và:
```ts
/**
 * Spec SP3 T8: path Better Auth (đã bỏ `basePath`) của request mà mount đang phục vụ. `onAPIError.onError(error, ctx)`
 * không có request (router gọi nó sau khi endpoint thoát), nhưng vẫn chạy trong `AsyncLocalStorage` của scope này.
 * Ngoài scope (lời gọi `auth.api.*` của server) không có path: `onError` không đổi lỗi (INT3-4).
 */
export function recordAuthPath(path: string): void {
  const scope = store.getStore();
  if (scope) scope.path = path;
}
export function recordedAuthPath(): string | undefined {
  return store.getStore()?.path;
}
```
`src/modules/identity/infra/better-auth/auth-mount.middleware.ts`: import `recordAuthPath`; ngay sau dòng `if (path === undefined) return writeProblem(res, new AppError(CoreErrors.NOT_FOUND), meta);`:
```ts
    // Spec SP3 T8: `onAPIError.onError` đọc path từ scope để đổi 23001 của đường xoá user thành 409.
    recordAuthPath(path);
```

- [ ] **Step 3: `release` và `onError`**

`src/modules/identity/infra/better-auth/auth-options.ts`:
- import: `PG` từ `../../../../core/database/index.js`, `safeErrorFields` từ `../../identity-telemetry.js`, `type UserDeletionGuard` từ `../../ports/user-deletion-guard.js`, `USER_DELETION_BLOCKED_CODE` từ `./auth-error.mapper.js`, `recordedAuthDbError, recordedAuthPath` từ `./auth-db-failures.js`, `USER_DELETION_PATHS` từ `./auth-hooks.js`.
- `AuthOptionsInput` thêm:
```ts
  /** Spec SP3 §9.6 bước 3: port của tenancy (`@Optional`); vắng → không có hook `delete.before`. */
  userDeletion?: UserDeletionGuard;
  /** WARN có cấu trúc khi một lần xoá user thua đua (không PII). */
  onUserDeletionBlocked(reason: 'LAST_OWNER' | 'MEMBERSHIP_CREATED' | 'USER_ROW_REFERENCED'): void;
```
- hàm cấp module:
```ts
const FIRST_SERVER_ERROR = 500;
const blockedDeletion = (): APIError =>
  APIError.from('CONFLICT', {
    code: USER_DELETION_BLOCKED_CODE,
    message: 'account deletion raced with an organization change',
  });
/**
 * Spec SP3 T8, DB2-M7: trên đường xoá user, `23001` từ pool `auth_user` chỉ có thể đến từ FK trỏ vào `auth."user"` từ
 * ngoài schema `auth` (identity không cần biết tên constraint của tenancy). Lỗi pg có thể tới nguyên, hoặc bị Better
 * Auth bọc thành `APIError` 5xx — khi đó dựa vào lỗi DB mà scope đã ghi.
 */
const isUserRowReferenced = (err: unknown): boolean => {
  const path = recordedAuthPath();
  if (path === undefined || !USER_DELETION_PATHS.has(path)) return false;
  if (isAPIError(err) && err.statusCode < FIRST_SERVER_ERROR) return false;
  return (
    safeErrorFields(err).code === PG.RESTRICT_VIOLATION ||
    recordedAuthDbError()?.code === PG.RESTRICT_VIOLATION
  );
};
```
- `databaseHooks.user`:
```ts
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string }) => input.onUserCreated(user.id),
        },
        ...(input.userDeletion
          ? {
              delete: {
                /**
                 * Spec SP3 §9.6 bước 3: chạy SAU khi Better Auth đã xoá session và account; chỉ dọn tenancy. Đua (membership
                 * mới, owner cuối) → 409 có tên, body nói credential đã bị gỡ (runbook), không 500.
                 */
                before: async (user: { id: string }) => {
                  const guard = input.userDeletion;
                  if (!guard) return;
                  const r = await guard.release(user.id);
                  switch (r.kind) {
                    case 'RELEASED':
                      return;
                    case 'BLOCKED_RACE':
                      input.onUserDeletionBlocked(r.reason);
                      throw blockedDeletion();
                    default: {
                      const unknown: never = r;
                      throw new Error(`unknown user deletion release ${JSON.stringify(unknown)}`);
                    }
                  }
                },
              },
            }
          : {}),
      },
    },
```
- `onAPIError.onError`:
```ts
      onError: (err: unknown) => {
        // Spec SP3 T8: đổi TRƯỚC khi log/đếm 5xx, để đua với xoá tài khoản không thành "lỗi không giải thích được".
        if (isUserRowReferenced(err)) {
          input.onUserDeletionBlocked('USER_ROW_REFERENCED');
          throw blockedDeletion();
        }
        input.onApiError(err);
        if (!isAPIError(err)) throw new APIError('INTERNAL_SERVER_ERROR');
      },
```
`src/modules/identity/infra/better-auth/auth-instance.ts`, trong `buildAuthOptions({...})`:
```ts
    userDeletion: d.userDeletion,
    onUserDeletionBlocked: (reason) =>
      d.logger.warn(
        { event: 'user_deletion_blocked_race', reason },
        'account deletion blocked after Better Auth removed its sessions and password; see the runbook for a partially deleted account',
      ),
```
Kiểm vòng import: `auth-options.ts` import `auth-hooks.ts` (`USER_DELETION_PATHS`); `auth-hooks.ts` không import `auth-options.ts` → không vòng. Chạy `pnpm arch` ở Step 5 để chắc.

- [ ] **Step 4: Test tích hợp trên Better Auth thật (FK fixture tự tạo và tự xoá)**

`test/integration/identity/user-deletion-release.spec.ts`:
```ts
import { Global, Logger, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  UserDeletionGuard,
  type UserDeletionCheck,
  type UserDeletionRelease,
} from '../../../src/modules/identity/index.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';

const guard = {
  check: vi.fn(async (_id: string): Promise<UserDeletionCheck> => ({ kind: 'ALLOWED' })),
  release: vi.fn(async (_id: string): Promise<UserDeletionRelease> => ({ kind: 'RELEASED' })),
};
@Global()
@Module({ providers: [{ provide: UserDeletionGuard, useValue: guard }], exports: [UserDeletionGuard] })
class FakeGuardModule {}

/** Trường `event` của các dòng log (tham số đầu của Logger). */
const errorEvents = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
  spy.mock.calls.flatMap((c) => {
    const f = c[0];
    return typeof f === 'object' && f !== null && 'event' in f ? [f.event] : [];
  });

const seeded: SeededPrincipal[] = [];
const seed = async (role?: string) => {
  const p = await seedUserPrincipal({ role });
  seeded.push(p);
  return p;
};
const removeUser = (app: INestApplication, as: SeededPrincipal, userId: string) =>
  request(app.getHttpServer()).post('/api/auth/admin/remove-user').set('authorization', `Bearer ${as.bearer}`).send({ userId });

beforeAll(async () => {
  // FK fixture thay cho `tenancy_users_auth_user_fk` (bảng đó có từ Task 13; O-19 thật chạy ở Task 26).
  await ownerQuery(`CREATE TABLE fixture_user_refs (auth_user_id uuid REFERENCES auth."user"(id) ON DELETE RESTRICT)`);
  await ownerQuery(`CREATE TABLE fixture_session_refs (session_id uuid REFERENCES auth.session(id) ON DELETE RESTRICT)`);
});
afterAll(async () => {
  await ownerQuery('DROP TABLE IF EXISTS fixture_user_refs');
  await ownerQuery('DROP TABLE IF EXISTS fixture_session_refs');
  await deleteSeededPrincipals(seeded);
});

describe('T8 without a guard: the FK is the last line and answers 409, not 500', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => app?.close());
  afterEach(() => vi.restoreAllMocks());

  it('23001 on /admin/remove-user → 409 user_deletion_blocked with the runbook detail; no ERROR log', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    await ownerQuery(`INSERT INTO fixture_user_refs VALUES ($1)`, [victim.authUserId]);
    const error = vi.spyOn(Logger.prototype, 'error');
    const r = await removeUser(app, admin, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/runbook/);
    expect(errorEvents(error)).not.toContain('better_auth_unhandled_error');
    expect(errorEvents(error)).not.toContain('auth_endpoint_error');
    await ownerQuery(`DELETE FROM fixture_user_refs`);
  });
  it('INT3-4: 23001 on a path outside USER_DELETION_PATHS stays a logged 500', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    await ownerQuery(`INSERT INTO fixture_session_refs VALUES ($1)`, [victim.sessionId]);
    const error = vi.spyOn(Logger.prototype, 'error');
    const r = await request(app.getHttpServer()).post('/api/auth/admin/revoke-user-sessions').set('authorization', `Bearer ${admin.bearer}`).send({ userId: victim.authUserId });
    expect(r.status).toBe(500);
    expect(errorEvents(error)).toContain('better_auth_unhandled_error');
    await ownerQuery(`DELETE FROM fixture_session_refs`);
  });
});

describe('release in databaseHooks.user.delete.before (spec SP3 §9.6 step 3)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [FakeGuardModule] });
  });
  afterAll(async () => app?.close());
  afterEach(() => {
    guard.release.mockReset();
    guard.release.mockResolvedValue({ kind: 'RELEASED' });
  });

  it.each(['LAST_OWNER', 'MEMBERSHIP_CREATED'] as const)('BLOCKED_RACE %s → 409; the user row stays but sessions and accounts are gone', async (reason) => {
    const [admin, victim] = [await seed('admin'), await seed()];
    guard.release.mockResolvedValueOnce({ kind: 'BLOCKED_RACE', reason });
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const r = await removeUser(app, admin, victim.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(guard.release).toHaveBeenCalledWith(victim.authUserId);
    expect(warn.mock.calls.some((c) => JSON.stringify(c[0]).includes('user_deletion_blocked_race'))).toBe(true);
    const [left] = await ownerQuery<{ u: number; s: number }>(`SELECT (SELECT count(*)::int FROM auth."user" WHERE id = $1) AS u, (SELECT count(*)::int FROM auth.session WHERE user_id = $1) AS s`, [victim.authUserId]);
    expect(left).toEqual({ u: 1, s: 0 });
  });
  it('RELEASED → the user is deleted', async () => {
    const [admin, victim] = [await seed('admin'), await seed()];
    expect((await removeUser(app, admin, victim.authUserId)).status).toBe(200);
    expect(guard.release).toHaveBeenCalledWith(victim.authUserId);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/identity/user-deletion-release.spec.ts`
Expected: PASS sau Step 3 (chạy trước Step 3 thì ca đầu nhận `500`).

- [ ] **Step 5: Chạy toàn bộ identity + kiến trúc**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/identity
pnpm vitest run --project integration test/integration/identity test/e2e/identity
pnpm arch && pnpm typecheck
```
Expected: PASS, không vòng import.

- [ ] **Step 6: Smoke prod-like cho phần identity của 3A**

Thêm vào `test/smoke/tenancy.smoke.spec.ts` (import thêm `randomInt, randomUUID` từ `node:crypto`, `Mailpit` từ `../support/mailpit.js`, `SMOKE_BASE_URL` từ `./smoke-app-env.js`, `CookieJar` từ `./smoke-support.js`):
```ts
const PASSWORD = 'smoke-3a correct horse battery';
const VERIFY_LINK = /https:\/\/localhost\/api\/auth\/verify-email\?[^\s"<>]+/;

/** Một thiết bị phía sau ingress giả: cookie jar + IP riêng (`HTTP_TRUST_PROXY=1` của smoke). */
class Device {
  readonly jar = new CookieJar();
  readonly ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
  constructor(private readonly apiUrl: string) {}
  async call(method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; cookie?: boolean } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': this.ip, origin: SMOKE_BASE_URL, ...o.headers };
    if (o.cookie !== false && this.jar.header()) headers.cookie = this.jar.header();
    const res = await fetch(`${this.apiUrl}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: 'manual' });
    if (o.cookie !== false) this.jar.absorb(res);
    return res;
  }
}
/** Đăng ký → thư qua SMTP STARTTLS → xác thực → đăng nhập bằng cookie. */
async function verifiedDevice(apiUrl: string, mail: Mailpit): Promise<{ device: Device; email: string }> {
  const device = new Device(apiUrl);
  const email = `smoke3a-${randomUUID()}@example.test`;
  expect((await device.call('POST', '/api/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'Smoke 3A' }, cookie: false })).status).toBe(202);
  const msg = await mail.waitFor(email, { subject: /Verify your email/, timeoutMs: 60_000 });
  const link = VERIFY_LINK.exec(msg.Text)?.[0];
  if (!link) throw new Error('no https verify-email link in the email');
  const u = new URL(link.replaceAll('&amp;', '&'));
  expect((await new Device(apiUrl).call('GET', `${u.pathname}${u.search}`, { cookie: false })).status).toBeLessThan(400);
  expect((await device.call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(200);
  return { device, email };
}
```
và trong `describe`:
```ts
  const { mailpitApiUrl } = inject('smoke');
  const mail = new Mailpit(mailpitApiUrl);
  it('identity of 3A on the production image: oak_ prefix refused, an oak_ key is 401, an uppercase admin target id is 422', async () => {
    const { device, email } = await verifiedDevice(apiUrl, mail);
    const created = await device.call('POST', '/api/auth/api-key/create', { body: { name: 'smoke', prefix: 'oak_x' } });
    expect(created.status).toBe(422);
    expect((await created.json()).fields?.[0]?.path).toBe('prefix');
    const anon = new Device(apiUrl);
    expect((await anon.call('GET', '/v1/me', { headers: { 'x-api-key': `oak_${randomUUID().replaceAll('-', '')}` }, cookie: false })).status).toBe(401);
    psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${email}'`);
    const id = psql(`SELECT id FROM auth."user" WHERE email = '${email}'`);
    // Image lúc này chưa có `UserDeletionGuard` (Task 26): `422` đến từ kiểm dạng `userId` của hook, vốn không cần guard
    // (Task 11, review I1). Task 26 thêm ca xoá tài khoản có guard.
    const r = await device.call('POST', '/api/auth/admin/remove-user', { body: { userId: id.toUpperCase() } });
    expect(r.status).toBe(422);
    expect(psql(`SELECT count(*) FROM auth.session WHERE user_id = '${id}'`)).not.toBe('0');
  });
```
(email/id do chính smoke sinh bằng `randomUUID`, không phải input ngoài; nối vào SQL của superuser smoke là an toàn.) Ca log sạch ở cuối file thêm `email` vào danh sách chuỗi cấm: đổi `assertCleanLogs(logsSince(since), [])` thành `assertCleanLogs(logsSince(since), [PASSWORD])`.

- [ ] **Step 7: Kiểm chứng prod-like #2**

Run: `pnpm test:smoke`
Expected: mọi file smoke PASS trên image production vừa build (`NODE_ENV=production`, TLS, rate limit bật), log api/worker là JSON, không `error`, không chứa mật khẩu smoke; `/health/ready` 200; teardown `down -v` sạch.

- [ ] **Step 8: Commit**

```bash
git add src/modules/identity test/unit/modules/identity test/integration/identity/user-deletion-release.spec.ts test/integration/identity/auth-options.spec.ts test/smoke/tenancy.smoke.spec.ts
git commit -m "feat(identity): release tenancy in user.delete.before and map 23001 of user deletion to 409 before logging; prod-like smoke of 3A identity"
```

---

## Phần D — Schema tenancy (spec §6.1–6.6, §6.12–6.14, §18.1)

### Task 13: Migration `tenancy_core` — 6 bảng, RLS/FORCE/policy `TO app_user`, grant theo cột, 4 trigger bất biến, seed đủ 19 quyền; catalog và inventory

**Files:**
- Create: `src/migrations/tenancy/Migration<ts>_tenancy_core.ts` (CLI)
- Modify: `test/integration/core/database/rls-catalog.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: role `tenancy_definer` (Task 2), `app_current_org()` (SP1), `auth."user"` (SP2), `DEFINER_READ_TABLES_3A`, `TENANCY_TENANT_TABLES_3A` (Task 4).
- Produces (tên là hợp đồng cho mọi task sau):
  - Bảng `tenancy_users`, `permissions`, `permission_requires`, `organizations`, `org_roles`, `org_members` đúng spec §6.2–6.6 (không có `org_role_permissions`: 3B).
  - Constraint: `tenancy_users_auth_user_fk`, `tenancy_users_one_subject_ck`, `tenancy_users_external_subject_ck`, `permissions_key_uq`, `permissions_owner_only_ck`, `organizations_id_v7_ck`, `organizations_name_ck`, `organizations_deleted_pair_ck`, `organizations_purge_after_ck`, `organizations_created_by_fk`, `org_roles_org_fk`, `org_roles_org_id_uq`, `org_roles_org_public_id_uq`, `org_roles_org_system_key_uq`, `org_roles_kind_ck`, `org_members_org_user_uq`, `org_members_org_id_uq`, `org_members_org_public_id_uq`, `org_members_user_fk`, `org_members_role_fk`; index `org_roles_name_uq`, `organizations_deleted_idx`, `organizations_created_by_idx`, `org_members_org_role_idx`, `org_members_user_idx`, `permission_requires_required_idx`.
  - Trigger (tên = constraint trong `RAISE`): `organizations_bootstrap_ck`, `organizations_restore_owner_ck` (constraint trigger hoãn), `org_roles_system_immutable` (`BEFORE UPDATE OR DELETE`), `org_members_last_owner_ck` (constraint trigger hoãn, tự khoá dòng org, đòi `READ COMMITTED`); hàm trigger `tenancy_organizations_bootstrap_ck()`, `tenancy_organizations_restore_owner_ck()`, `tenancy_org_roles_system_immutable()`, `tenancy_org_members_last_owner_ck()`.
  - Dữ liệu: 19 dòng `permissions` + 18 cạnh `permission_requires` (spec §8.2).
  - Task 15 thêm 6 hàm definer vào **cùng file** (chưa merge nên sửa được).

- [ ] **Step 1: Tạo migration**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/tenancy --name tenancy_core`
Expected: `src/migrations/tenancy/Migration<ts>_tenancy_core.ts`, timestamp lớn hơn migration `email_templates_lookup` (Task 8).

- [ ] **Step 2: Test catalog, inventory (fail)**

`test/integration/core/database/rls-catalog.spec.ts`:
- import `DEFINER_READ_TABLES, TENANCY_TENANT_TABLES` từ `../../../support/tenancy-catalog.js`;
- `GLOBAL_TABLES` thêm:
```ts
  // SP3 (spec §6.2–6.3): registry principal và catalogue quyền, không chứa dữ liệu tenant
  'tenancy_users',
  'permissions',
  'permission_requires',
```
- hằng mới và kiểm bảng gốc tenant:
```ts
/** Bảng gốc tenant (spec SP3 §18.1): không có cột `org_id`, policy dùng `app_current_org()` trên `id`. */
const ORG_ROOT_TABLES = ['organizations'];
```
trong ca `protects every tenant table and explicitly inventories global tables`, điều kiện bảng không `org_id` đổi thành `!row.has_org && !GLOBAL_TABLES.includes(row.name) && !ORG_ROOT_TABLES.includes(row.name)` và thêm:
```ts
    expect(
      rows
        .filter((row) => ORG_ROOT_TABLES.includes(row.name))
        .map((r) => ({ name: r.name, rls: r.rls, force: r.force_rls, policy: r.org_policy })),
    ).toEqual(ORG_ROOT_TABLES.map((name) => ({ name, rls: true, force: true, policy: true })));
```
- thay ca `allows USING (true) only for SELECT TO app_relay` bằng:
```ts
  it('allows USING (true) only for SELECT TO app_relay, or SELECT TO tenancy_definer on the declared tables', async () => {
    const { rows } = await client.query<{ tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null }>(
      `SELECT tablename, policyname, cmd, roles::text[] AS roles, qual FROM pg_policies WHERE schemaname = 'public'`,
    );
    const unrestricted = rows.filter((row) => row.qual?.replace(/[()\s]/g, '').toLowerCase() === 'true');
    expect(unrestricted.some((row) => row.tablename === 'scheduled_tasks')).toBe(true);
    for (const policy of unrestricted) {
      const definer = policy.roles.length === 1 && policy.roles[0] === 'tenancy_definer';
      expect(policy.cmd, policy.policyname).toBe('SELECT');
      if (definer) expect(DEFINER_READ_TABLES, policy.policyname).toContain(policy.tablename);
      else expect(policy.roles, policy.policyname).toEqual(['app_relay']);
    }
    expect(unrestricted.filter((p) => p.roles[0] === 'tenancy_definer').map((p) => p.tablename).sort()).toEqual([...DEFINER_READ_TABLES].sort());
  });
  it('every tenant policy of tenancy tables is limited TO app_user (never PUBLIC, S3-A3)', async () => {
    const { rows } = await client.query<{ tablename: string; roles: string[] }>(
      `SELECT tablename, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND policyname = tablename || '_tenant' AND tablename = ANY($1::text[])`,
      [['organizations', ...TENANCY_TENANT_TABLES]],
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual(['organizations', ...TENANCY_TENANT_TABLES].sort());
    for (const r of rows) expect(r.roles, r.tablename).toEqual(['app_user']);
  });
  it('a deferrable constraint name is unique per schema (R4C-N4-4, R5-C1)', async () => {
    const { rows } = await client.query(
      `SELECT n.nspname, c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname IN ('public', 'auth') GROUP BY n.nspname, c.conname HAVING count(*) > 1 AND bool_or(c.condeferrable)`,
    );
    expect(rows).toEqual([]);
  });
```
- thêm `describe('tenancy grants (spec SP3 §6.2–6.6, §18.1)')` vào khối `schema and database privileges (R20)`:
```ts
  it('tenancy_definer holds only column SELECT on the declared columns', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string; privilege_type: string }>(
      `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
       WHERE grantee = 'tenancy_definer' AND table_schema = 'public' ORDER BY table_name, column_name`,
    );
    expect(rows.every((r) => r.privilege_type === 'SELECT')).toBe(true);
    const cols = (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.column_name).sort();
    expect(cols('organizations')).toEqual(['created_by_user_id', 'deleted_at', 'id', 'name', 'purge_after']);
    expect(cols('org_roles')).toEqual(['id', 'name', 'org_id', 'public_id', 'system_key']);
    expect(cols('org_members')).toEqual(['created_at', 'id', 'org_id', 'public_id', 'role_id', 'user_id']);
    const tableLevel = await client.query(
      `SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'tenancy_definer'`,
    );
    expect(tableLevel.rows).toEqual([]);
  });
  it('app_user UPDATE is column-scoped: identity columns are immutable (spec §6.1)', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
       WHERE grantee = 'app_user' AND privilege_type = 'UPDATE' AND table_schema = 'public'
         AND table_name IN ('tenancy_users', 'organizations', 'org_roles', 'org_members', 'permissions', 'permission_requires')
       ORDER BY table_name, column_name`,
    );
    const cols = (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.column_name);
    expect(cols('tenancy_users')).toEqual(['updated_at']);
    expect(cols('organizations')).toEqual(['created_by_user_id', 'deleted_at', 'name', 'purge_after', 'updated_at', 'version']);
    expect(cols('org_roles')).toEqual(['description', 'name', 'updated_at', 'version']);
    expect(cols('org_members')).toEqual(['role_id', 'updated_at', 'version']);
    expect(cols('permissions')).toEqual([]);
    expect(cols('permission_requires')).toEqual([]);
  });
```
`test/integration/core/database/normalization-inventory.spec.ts` thêm sáu mục:
```ts
  'public.tenancy_users': ['id', 'public_id', 'auth_user_id', 'external_subject', 'created_at', 'updated_at'],
  'public.permissions': ['id', 'resource', 'action', 'key', 'owner_only', 'api_key_eligible', 'support_eligible', 'deprecated_at', 'created_at', 'updated_at'],
  'public.permission_requires': ['permission_id', 'required_permission_id', 'created_at', 'updated_at'],
  'public.organizations': ['id', 'name', 'created_by_user_id', 'version', 'deleted_at', 'purge_after', 'created_at', 'updated_at'],
  'public.org_roles': ['id', 'public_id', 'org_id', 'system_key', 'name', 'description', 'version', 'created_at', 'updated_at'],
  'public.org_members': ['id', 'public_id', 'org_id', 'user_id', 'role_id', 'version', 'created_at', 'updated_at'],
```
Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts`
Expected: FAIL (bảng chưa có).

- [ ] **Step 3: Viết migration**

`src/migrations/tenancy/Migration<ts>_tenancy_core.ts` (giữ tên lớp CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3A (spec SP3 §6.2–6.6, §6.13 bảng 3A). Task 15 thêm 6 hàm definer vào cuối `up` và đầu `down` của CHÍNH file này.
 *
 * Bảng chuẩn hoá (spec §6.12; khoá ứng viên suy từ ràng buộc DB):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | tenancy_users | {id}, {public_id}, {auth_user_id}*, {external_subject}* | — | BCNF (đúng một subject: CHECK num_nonnulls) |
 * | permissions | {id}, {key}, {resource, action} | {resource, action} → key (cột sinh, đơn ánh) | BCNF |
 * | permission_requires | {permission_id, required_permission_id} | — | BCNF (toàn khoá) |
 * | organizations | {id} | — | BCNF (`purge_after` là lời hứa lúc xoá, không dẫn xuất từ `deleted_at`) |
 * | org_roles | {id}, {org_id, public_id}, {org_id, system_key}*, {org_id, lower(name)} (role tuỳ biến) | — | BCNF |
 * | org_members | {id}, {org_id, public_id}, {org_id, user_id}, {role_id, user_id} | role_id → org_id | 3NF (org_id là thuộc tính khoá); không BCNF — ngoại lệ E1 |
 * (*) khoá trên các dòng khác NULL (DB2-M8).
 * E1 — `org_id` lặp ở bảng con cho RLS không join; giữ nhất quán ở DB: FK kép `(org_id, role_id) → org_roles(org_id, id)`,
 * không grant UPDATE trên `org_id`, policy `WITH CHECK (org_id = app_current_org())`.
 *
 * Index (mỗi cái một query): PK `organizations` (mọi tra trong OrgScope, câu đường nóng §7.3); `organizations_deleted_idx`
 * → `tenancy_orgs_due_for_purge` (keyset theo id trong tập org xoá mềm); `organizations_created_by_idx` →
 * `tenancy_count_orgs_created_by`, `tenancy_user_related_org_ids`, FK SET NULL từ `tenancy_users` (không bắt đầu bằng
 * org_id: hàm definer quét nhiều org / FK từ bảng global); `org_roles_org_id_uq` (đích FK kép, câu đường nóng),
 * `org_roles_org_public_id_uq` (API), `org_roles_org_system_key_uq` (tra role OWNER khi đếm owner, tạo org),
 * `org_roles_name_uq` (tên role tuỳ biến, 3B); `org_members_org_user_uq` (tra membership mỗi request tenant),
 * `org_members_org_id_uq` (đích FK kép), `org_members_org_public_id_uq` (API), `org_members_org_role_idx` (đếm owner
 * trong trigger, FK RESTRICT khi xoá role, `?roleId=`), `org_members_user_idx` (hàm definer theo user, FK RESTRICT từ
 * `tenancy_users`); `permission_requires_required_idx` (FK RESTRICT, closure 3B); UNIQUE của `tenancy_users` (tra
 * principal → id mỗi request, tra theo id của API).
 *
 * Khoá (giữ tới hết lô 3A, `allOrNothing`): bảng mới; `SHARE ROW EXCLUSIVE` trên `auth."user"` (REFERENCES): chạy
 * trong cửa sổ ít ghi (runbook, spec §6.13).
 */
export class Migration<ts>_tenancy_core extends Migration {
  override name = 'Migration<ts>_tenancy_core';

  override up(): void | Promise<void> {
    this.addSql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenancy_definer') THEN
    RAISE EXCEPTION 'role tenancy_definer is missing: run docker/postgres/init/01-roles.sh (DBA) before this migration';
  END IF;
END $$;`);

    this.addSql(`CREATE TABLE tenancy_users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    auth_user_id UUID NULL,
    external_subject TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenancy_users_public_id_uq UNIQUE (public_id),
    CONSTRAINT tenancy_users_auth_user_uq UNIQUE (auth_user_id),
    CONSTRAINT tenancy_users_external_subject_uq UNIQUE (external_subject),
    CONSTRAINT tenancy_users_auth_user_fk FOREIGN KEY (auth_user_id) REFERENCES auth."user" (id) ON DELETE RESTRICT,
    CONSTRAINT tenancy_users_external_subject_ck CHECK (char_length(external_subject) BETWEEN 1 AND 255),
    CONSTRAINT tenancy_users_one_subject_ck CHECK (num_nonnulls(auth_user_id, external_subject) = 1));`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON tenancy_users TO app_user;`);
    // Chỉ để khoá dòng (`FOR NO KEY UPDATE` đòi UPDATE trên ít nhất một cột, SEC-I2); không code nào sửa dòng này.
    this.addSql(`GRANT UPDATE (updated_at) ON tenancy_users TO app_user;`);

    this.addSql(`CREATE TABLE permissions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resource TEXT NOT NULL,
    action TEXT NOT NULL,
    key TEXT GENERATED ALWAYS AS (resource || '.' || action) STORED,
    owner_only BOOLEAN NOT NULL,
    api_key_eligible BOOLEAN NOT NULL,
    support_eligible BOOLEAN NOT NULL,
    deprecated_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT permissions_key_uq UNIQUE (key),
    CONSTRAINT permissions_resource_ck CHECK (resource ~ '^[a-z][a-z_]{0,31}$' AND resource <> 'all'),
    CONSTRAINT permissions_action_ck CHECK (action ~ '^[a-z][a-z_]{0,31}(\\.[a-z][a-z_]{0,31})?$' AND action <> 'manage'),
    CONSTRAINT permissions_owner_only_ck CHECK (NOT owner_only OR (NOT api_key_eligible AND NOT support_eligible)));`);
    this.addSql(`CREATE TABLE permission_requires (
    permission_id BIGINT NOT NULL,
    required_permission_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT permission_requires_pk PRIMARY KEY (permission_id, required_permission_id),
    CONSTRAINT permission_requires_permission_fk FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE,
    CONSTRAINT permission_requires_required_fk FOREIGN KEY (required_permission_id) REFERENCES permissions (id) ON DELETE RESTRICT,
    CONSTRAINT permission_requires_not_self_ck CHECK (permission_id <> required_permission_id));`);
    this.addSql(`CREATE INDEX permission_requires_required_idx ON permission_requires (required_permission_id);`);
    this.addSql(`GRANT SELECT ON permissions, permission_requires TO app_user;`);

    this.addSql(`CREATE TABLE organizations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    created_by_user_id BIGINT NULL,
    version INT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ NULL,
    purge_after TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT organizations_id_v7_ck CHECK (uuid_extract_version(id) = 7),
    CONSTRAINT organizations_name_ck CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT organizations_version_ck CHECK (version >= 1),
    CONSTRAINT organizations_deleted_pair_ck CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
    CONSTRAINT organizations_purge_after_ck CHECK (purge_after > deleted_at),
    CONSTRAINT organizations_created_by_fk FOREIGN KEY (created_by_user_id) REFERENCES tenancy_users (id) ON DELETE SET NULL);`);
    this.addSql(`CREATE INDEX organizations_deleted_idx ON organizations (id) WHERE deleted_at IS NOT NULL;`);
    this.addSql(`CREATE INDEX organizations_created_by_idx ON organizations (created_by_user_id);`);
    this.addSql(`ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE organizations FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY organizations_tenant ON organizations TO app_user
    USING (id = app_current_org()) WITH CHECK (id = app_current_org());`);
    this.addSql(`CREATE POLICY organizations_definer_read ON organizations FOR SELECT TO tenancy_definer USING (true);`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON organizations TO app_user;`);
    this.addSql(`GRANT UPDATE (name, version, deleted_at, purge_after, created_by_user_id, updated_at) ON organizations TO app_user;`);
    this.addSql(`GRANT SELECT (id, name, created_by_user_id, deleted_at, purge_after) ON organizations TO tenancy_definer;`);

    this.addSql(`CREATE TABLE org_roles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    system_key TEXT NULL,
    name TEXT NULL,
    description TEXT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_roles_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    CONSTRAINT org_roles_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_roles_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_roles_org_system_key_uq UNIQUE (org_id, system_key),
    CONSTRAINT org_roles_system_key_ck CHECK (system_key IN ('OWNER', 'ADMIN', 'MEMBER')),
    CONSTRAINT org_roles_name_ck CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT org_roles_description_ck CHECK (char_length(description) <= 500),
    CONSTRAINT org_roles_version_ck CHECK (version >= 1),
    CONSTRAINT org_roles_kind_ck CHECK ((system_key IS NULL) = (name IS NOT NULL)),
    CONSTRAINT org_roles_system_no_description_ck CHECK (system_key IS NULL OR description IS NULL));`);
    this.addSql(`CREATE UNIQUE INDEX org_roles_name_uq ON org_roles (org_id, lower(name)) WHERE system_key IS NULL;`);
    this.addSql(`ALTER TABLE org_roles ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_roles FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY org_roles_tenant ON org_roles TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`CREATE POLICY org_roles_definer_read ON org_roles FOR SELECT TO tenancy_definer USING (true);`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_roles TO app_user;`);
    this.addSql(`GRANT UPDATE (name, description, version, updated_at) ON org_roles TO app_user;`);
    this.addSql(`GRANT SELECT (id, org_id, public_id, system_key, name) ON org_roles TO tenancy_definer;`);

    this.addSql(`CREATE TABLE org_members (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT uuidv7(),
    org_id UUID NOT NULL,
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT org_members_org_user_uq UNIQUE (org_id, user_id),
    CONSTRAINT org_members_org_id_uq UNIQUE (org_id, id),
    CONSTRAINT org_members_org_public_id_uq UNIQUE (org_id, public_id),
    CONSTRAINT org_members_user_fk FOREIGN KEY (user_id) REFERENCES tenancy_users (id) ON DELETE RESTRICT,
    CONSTRAINT org_members_role_fk FOREIGN KEY (org_id, role_id) REFERENCES org_roles (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT org_members_version_ck CHECK (version >= 1));`);
    this.addSql(`CREATE INDEX org_members_org_role_idx ON org_members (org_id, role_id);`);
    this.addSql(`CREATE INDEX org_members_user_idx ON org_members (user_id);`);
    this.addSql(`ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE org_members FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY org_members_tenant ON org_members TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`CREATE POLICY org_members_definer_read ON org_members FOR SELECT TO tenancy_definer USING (true);`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON org_members TO app_user;`);
    this.addSql(`GRANT UPDATE (role_id, version, updated_at) ON org_members TO app_user;`);
    this.addSql(`GRANT SELECT (id, public_id, org_id, user_id, role_id, created_at) ON org_members TO tenancy_definer;`);

    // T-23: lúc COMMIT, org mới (nếu còn) có đủ 3 role hệ thống và ≥ 1 member OWNER. Tạo org thiếu owner là không thể.
    this.addSql(`CREATE FUNCTION tenancy_organizations_bootstrap_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.id) THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM public.org_roles WHERE org_id = NEW.id AND system_key IS NOT NULL) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE m.org_id = NEW.id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an organization must be created with its three system roles and an owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organizations_bootstrap_ck';
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(`CREATE CONSTRAINT TRIGGER organizations_bootstrap_ck AFTER INSERT ON organizations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenancy_organizations_bootstrap_ck();`);

    // DB-M6: khôi phục (deleted_at NOT NULL → NULL) đòi còn owner lúc COMMIT; chặn cả runbook SQL.
    this.addSql(`CREATE FUNCTION tenancy_organizations_restore_owner_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.id AND deleted_at IS NULL) THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.org_id = NEW.id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an organization without an owner cannot be restored'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organizations_restore_owner_ck';
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(`CREATE CONSTRAINT TRIGGER organizations_restore_owner_ck AFTER UPDATE OF deleted_at ON organizations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
    EXECUTE FUNCTION tenancy_organizations_restore_owner_ck();`);

    // S3-A5: role hệ thống là dòng bất biến; chỉ xoá được khi org đã xoá mềm (đang xoá cứng).
    this.addSql(`CREATE FUNCTION tenancy_org_roles_system_immutable() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.system_key IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM public.organizations WHERE id = OLD.org_id AND deleted_at IS NOT NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'system roles cannot be changed or deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'org_roles_system_immutable';
END $$;`);
    this.addSql(`CREATE TRIGGER org_roles_system_immutable BEFORE UPDATE OR DELETE ON org_roles
    FOR EACH ROW EXECUTE FUNCTION tenancy_org_roles_system_immutable();`);

    // T-1, T-28 (DB-I1): tự khoá dòng org TRƯỚC khi đếm; dưới READ COMMITTED câu đếm sau khoá thấy phần đã commit của bên
    // kia. Org đã xoá mềm hoặc đã mất (purge) được miễn. Không SECURITY DEFINER: tenancy_definer không khoá được dòng.
    this.addSql(`CREATE FUNCTION tenancy_org_members_last_owner_ck() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the last-owner check needs READ COMMITTED (it relies on a fresh snapshot after the lock)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_last_owner_ck';
  END IF;
  SELECT deleted_at INTO v_deleted_at FROM public.organizations WHERE id = OLD.org_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.org_id = OLD.org_id AND r.system_key = 'OWNER') THEN
    RAISE EXCEPTION 'an active organization must keep at least one owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_members_last_owner_ck';
  END IF;
  RETURN NULL;
END $$;`);
    this.addSql(`CREATE CONSTRAINT TRIGGER org_members_last_owner_ck AFTER UPDATE OF role_id OR DELETE ON org_members
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenancy_org_members_last_owner_ck();`);

    // Catalogue v1 (spec §8.2): migration không import code; `CatalogueCheck` (Task 19) so với catalogue trong code lúc boot.
    this.addSql(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES
    ('org', 'read', false, true, true),
    ('org', 'update', false, false, false),
    ('org', 'delete', true, false, false),
    ('org', 'restore', true, false, false),
    ('ownership', 'transfer', true, false, false),
    ('members', 'read', false, true, true),
    ('members', 'role.assign', false, false, false),
    ('members', 'remove', false, false, false),
    ('roles', 'read', false, true, true),
    ('roles', 'write', false, false, false),
    ('invitations', 'read', false, false, true),
    ('invitations', 'write', false, false, false),
    ('api_keys', 'read', false, false, false),
    ('api_keys', 'write_own', false, false, false),
    ('api_keys', 'write_all', false, false, false),
    ('support_access', 'read', false, false, false),
    ('support_access', 'grant', true, false, false),
    ('billing', 'read', false, true, false),
    ('billing', 'write', true, false, false);`);
    this.addSql(`INSERT INTO permission_requires (permission_id, required_permission_id)
SELECT p.id, r.id FROM (VALUES
    ('org.update', 'org.read'),
    ('org.delete', 'org.read'),
    ('org.restore', 'org.read'),
    ('ownership.transfer', 'members.read'),
    ('members.role.assign', 'members.read'),
    ('members.role.assign', 'roles.read'),
    ('members.remove', 'members.read'),
    ('roles.write', 'roles.read'),
    ('invitations.read', 'roles.read'),
    ('invitations.write', 'invitations.read'),
    ('invitations.write', 'roles.read'),
    ('api_keys.read', 'members.read'),
    ('api_keys.write_all', 'api_keys.read'),
    ('api_keys.write_all', 'members.read'),
    ('support_access.grant', 'support_access.read'),
    ('support_access.grant', 'members.read'),
    ('billing.read', 'org.read'),
    ('billing.write', 'billing.read')
  ) AS e (k, req)
JOIN permissions p ON p.key = e.k
JOIN permissions r ON r.key = e.req;`);
  }

  override down(): void | Promise<void> {
    // Ngược thứ tự (spec §6.13, DB2-N1): con trước cha; DROP TABLE xoá trigger, policy, index, grant; hàm trigger phải
    // xoá riêng (không đi theo bảng).
    this.addSql(`DROP TABLE org_members;`);
    this.addSql(`DROP TABLE org_roles;`);
    this.addSql(`DROP TABLE organizations;`);
    this.addSql(`DROP TABLE permission_requires;`);
    this.addSql(`DROP TABLE permissions;`);
    this.addSql(`DROP TABLE tenancy_users;`);
    this.addSql(`DROP FUNCTION tenancy_org_members_last_owner_ck();`);
    this.addSql(`DROP FUNCTION tenancy_org_roles_system_immutable();`);
    this.addSql(`DROP FUNCTION tenancy_organizations_restore_owner_ck();`);
    this.addSql(`DROP FUNCTION tenancy_organizations_bootstrap_ck();`);
  }
}
```
Ghi chú mã: trong template literal TypeScript, `\\.` cho ra `\.` trong SQL (regex `permissions_action_ck`); kiểm lại bằng `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'permissions_action_ck'` ở Step 4.

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/core/database
```
Expected: PASS; quét tĩnh thấy 4 `CREATE FUNCTION` có `DROP FUNCTION` tương ứng; round-trip và sweep trên database riêng xanh (hàm trigger được xoá nên catalog trước = sau); catalog: bảng gốc `organizations` RLS + FORCE + policy, policy tenant `TO app_user`, `USING (true)` cho definer đúng 3 bảng, grant `UPDATE` theo cột, tên deferrable duy nhất; inventory khớp. Regex của `permissions_action_ck` được khoá bởi test ràng buộc ở Task 14 (`role.assign` hợp lệ, `x.y.z`, `manage`, `all`, `_x` bị `23514`).

- [ ] **Step 5: Commit**

```bash
git add src/migrations/tenancy test/integration/core/database/rls-catalog.spec.ts test/integration/core/database/normalization-inventory.spec.ts
git commit -m "feat(tenancy): tenancy_core migration with RLS, column grants, deferred owner triggers and the v1 permission catalogue"
```

---

### Task 14: Helper seed `seedOrg`/`seedMember`, thứ tự xoá cứng dùng chung, cô lập 4 bảng tenant, ràng buộc DB và race không khoá (O-3, O-13/T-28, O-14, T-23)

**Files:**
- Create: `src/modules/tenancy/infra/sql/org-purge.sql.ts`, `test/support/tenancy-seed.ts`, `test/fixtures/migrations/Migration<ts>_fixture_org_items.ts` (CLI), `test/integration/tenancy/seed-helper.spec.ts`, `test/integration/tenancy/isolation.spec.ts`, `test/integration/tenancy/constraints.spec.ts`

**Interfaces:**
- Consumes: schema của Task 13, `getInfra()`, `DatabaseModule`, `OrgScope`, `UnitOfWork`, `Db` (SP1).
- Produces:
  - `ORG_PURGE_STATEMENTS: readonly string[]` (`src/modules/tenancy/infra/sql/org-purge.sql.ts`): câu xoá theo thứ tự con trước cha của một org trong OrgScope; job purge (Task 25) và `dispose()` dùng chung.
  - `test/support/tenancy-seed.ts`:
    - `type SeedSubject = { authUserId: string } | { externalSubject: string }`
    - `type SeededMember = { memberId: string; memberPublicId: string; userId: string; userPublicId: string; roleKey: SystemRoleKey }`
    - `type SeededOrg = { orgId: string; owner: SeededMember; roles: Record<SystemRoleKey, { id: string; publicId: string }>; dispose(): Promise<void> }`
    - `seedOrg(opts?: { owner?: SeedSubject; name?: string; database?: string }): Promise<SeededOrg>`
    - `seedMember(org: SeededOrg, roleKey: SystemRoleKey, subject?: SeedSubject): Promise<SeededMember>`
    - `withAppClient<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T>`, `inOrgTx<T>(c: pg.Client, orgId: string, fn: () => Promise<T>): Promise<T>`
    - `SystemRoleKey = 'OWNER' | 'ADMIN' | 'MEMBER'`
  - Bảng fixture `fixture_org_items (org_id → organizations RESTRICT)`, RLS như bảng tenant: bảng "của `features/`" cho test khoá không chặn INSERT con (DB-I3), purge quên participant (Task 25), X-5 (Task 24).

- [ ] **Step 1: Thứ tự xoá cứng dùng chung**

`src/modules/tenancy/infra/sql/org-purge.sql.ts`:
```ts
/**
 * Xoá cứng các bảng tenancy của MỘT org, con trước cha (spec SP3 §9.5), chạy trong OrgScope của org đó (RLS). Dùng chung
 * cho job purge (`SqlOrgRepository.purgeCurrent`) và `seedOrg().dispose()` của test để hai nơi không lệch (DB2-N7).
 * Không `CASCADE` từ `organizations`: bảng thiếu ở đây làm câu cuối lỗi `23001` (fail to), không để dòng mồ côi.
 * Plan sau chèn bảng của mình: 3B `org_role_permissions` trước `org_roles`; 3C, 3D bảng của mình trước `org_members`.
 */
export const ORG_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM org_members WHERE org_id = app_current_org()',
  'DELETE FROM org_roles WHERE org_id = app_current_org()',
  'DELETE FROM organizations WHERE id = app_current_org()',
];
```

- [ ] **Step 2: Bảng fixture có FK tới `organizations`**

Run: `pnpm exec mikro-orm migration:create --blank --path test/fixtures/migrations --name fixture_org_items`
Viết file vừa sinh:
```ts
import { Migration } from '@mikro-orm/migrations';

/** Bảng "nghiệp vụ" giả của `features/` (spec SP3 §18.1): FK RESTRICT tới org như quy ước B5, RLS như mọi bảng tenant. */
export class Migration<ts>_fixture_org_items extends Migration {
  override name = 'Migration<ts>_fixture_org_items';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE fixture_org_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    this.addSql(`CREATE INDEX fixture_org_items_org_idx ON fixture_org_items (org_id);`);
    this.addSql(`ALTER TABLE fixture_org_items ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE fixture_org_items FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY fixture_org_items_tenant ON fixture_org_items TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON fixture_org_items TO app_user;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE fixture_org_items;`);
  }
}
```

- [ ] **Step 3: Helper seed**

`test/support/tenancy-seed.ts`:
```ts
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { v7 } from 'uuid';
import { ORG_PURGE_STATEMENTS } from '../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import { getInfra } from './infra.js';

export type SystemRoleKey = 'OWNER' | 'ADMIN' | 'MEMBER';
export type SeedSubject = { authUserId: string } | { externalSubject: string };
export type SeededMember = {
  memberId: string;
  memberPublicId: string;
  userId: string;
  userPublicId: string;
  roleKey: SystemRoleKey;
};
type RoleRef = { id: string; publicId: string };
export type SeededOrg = {
  orgId: string;
  owner: SeededMember;
  roles: Record<SystemRoleKey, RoleRef>;
  dispose(): Promise<void>;
};
const SYSTEM_ROLES: readonly SystemRoleKey[] = ['OWNER', 'ADMIN', 'MEMBER'];
const PG_RESTRICT = '23001';
/** Dòng `tenancy_users` do helper tạo, theo org đã seed (dispose chỉ xoá những dòng này). */
const createdUsersOf = new WeakMap<SeededOrg, string[]>();

/** Một client `app_user` thẳng Postgres: chỉ ở test/ (luật `not-to-test` chặn src import helper). */
export async function withAppClient<T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> {
  const { pg: p } = getInfra();
  const c = new pg.Client({ host: p.host, port: p.port, database: database ?? p.database, ...p.app });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Một transaction trong "OrgScope" (`set_config('app.org_id', …, true)`, đúng cách MikroORM áp session). */
export async function inOrgTx<T>(c: pg.Client, orgId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const out = await fn();
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
}

const subjectOf = (s: SeedSubject | undefined): SeedSubject =>
  s ?? { externalSubject: `test:${randomUUID()}` };

/** Upsert `tenancy_users` theo đúng cột của subject; `created` khi chính lần gọi này tạo dòng. */
async function upsertUser(c: pg.Client, s: SeedSubject): Promise<{ id: string; publicId: string; created: boolean }> {
  const byAuth = 'authUserId' in s;
  const value = byAuth ? s.authUserId : s.externalSubject;
  const inserted = byAuth
    ? await c.query<{ id: string; public_id: string }>(`INSERT INTO tenancy_users (auth_user_id) VALUES ($1) ON CONFLICT (auth_user_id) DO NOTHING RETURNING id::text, public_id::text`, [value])
    : await c.query<{ id: string; public_id: string }>(`INSERT INTO tenancy_users (external_subject) VALUES ($1) ON CONFLICT (external_subject) DO NOTHING RETURNING id::text, public_id::text`, [value]);
  const existing = inserted.rows[0]
    ? undefined
    : byAuth
      ? await c.query<{ id: string; public_id: string }>(`SELECT id::text, public_id::text FROM tenancy_users WHERE auth_user_id = $1`, [value])
      : await c.query<{ id: string; public_id: string }>(`SELECT id::text, public_id::text FROM tenancy_users WHERE external_subject = $1`, [value]);
  const row = inserted.rows[0] ?? existing?.rows[0];
  if (!row) throw new Error('seed: tenancy_users row vanished');
  return { id: row.id, publicId: row.public_id, created: inserted.rows.length === 1 };
}

async function insertMember(c: pg.Client, orgId: string, userId: string, roleId: string): Promise<{ id: string; public_id: string }> {
  const { rows } = await c.query<{ id: string; public_id: string }>(
    `INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3) RETURNING id::text, public_id::text`,
    [orgId, userId, roleId],
  );
  const row = rows[0];
  if (!row) throw new Error('seed: member insert returned no row');
  return row;
}

/**
 * Spec SP3 §5.3: MỘT transaction bằng `app_user` trong OrgScope(id): tenancy_users + organizations + 3 role hệ thống +
 * một member OWNER; trigger bootstrap đạt lúc COMMIT. Không cần `auth."user"` (subject mặc định `test:<uuid>`).
 * `dispose()` = MỘT transaction: xoá mềm (trigger role hệ thống cho xoá, trigger owner cuối miễn), xoá lịch, rồi
 * `ORG_PURGE_STATEMENTS` (đúng thứ tự của job purge); sau đó xoá từng dòng `tenancy_users` do helper tạo — `23001` nghĩa
 * là user còn là member ở org khác, giữ lại.
 */
export async function seedOrg(opts: { owner?: SeedSubject; name?: string; database?: string } = {}): Promise<SeededOrg> {
  const orgId = v7();
  const createdUsers: string[] = [];
  const seeded = await withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const user = await upsertUser(c, subjectOf(opts.owner));
        if (user.created) createdUsers.push(user.id);
        await c.query(`INSERT INTO organizations (id, name, created_by_user_id) VALUES ($1, $2, $3)`, [orgId, opts.name ?? `Seed ${orgId.slice(-6)}`, user.id]);
        const { rows } = await c.query<{ id: string; public_id: string; system_key: string }>(
          `INSERT INTO org_roles (org_id, system_key) SELECT $1, k FROM unnest($2::text[]) AS k RETURNING id::text, public_id::text, system_key`,
          [orgId, SYSTEM_ROLES],
        );
        const roleOf = (k: SystemRoleKey): RoleRef => {
          const r = rows.find((x) => x.system_key === k);
          if (!r) throw new Error(`seed: system role ${k} missing`);
          return { id: r.id, publicId: r.public_id };
        };
        const roles = { OWNER: roleOf('OWNER'), ADMIN: roleOf('ADMIN'), MEMBER: roleOf('MEMBER') };
        const m = await insertMember(c, orgId, user.id, roles.OWNER.id);
        const owner: SeededMember = { memberId: m.id, memberPublicId: m.public_id, userId: user.id, userPublicId: user.publicId, roleKey: 'OWNER' };
        return { roles, owner };
      }),
    opts.database,
  );
  const org: SeededOrg = {
    orgId,
    ...seeded,
    dispose: () =>
      withAppClient(async (c) => {
        await inOrgTx(c, orgId, async () => {
          await c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org() AND deleted_at IS NULL`);
          await c.query(`DELETE FROM scheduled_tasks WHERE org_id = app_current_org()`);
          for (const sql of ORG_PURGE_STATEMENTS) await c.query(sql);
        });
        for (const id of createdUsersOf.get(org) ?? [])
          await c.query(`DELETE FROM tenancy_users WHERE id = $1`, [id]).catch((err: unknown) => {
            if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === PG_RESTRICT)) throw err;
          });
      }, opts.database),
  };
  createdUsersOf.set(org, createdUsers);
  return org;
}

/** Thêm một member với role hệ thống vào org đã seed (một transaction trong OrgScope của org). */
export async function seedMember(org: SeededOrg, roleKey: SystemRoleKey, subject?: SeedSubject): Promise<SeededMember> {
  return withAppClient((c) =>
    inOrgTx(c, org.orgId, async () => {
      const user = await upsertUser(c, subjectOf(subject));
      if (user.created) createdUsersOf.get(org)?.push(user.id);
      const m = await insertMember(c, org.orgId, user.id, org.roles[roleKey].id);
      return { memberId: m.id, memberPublicId: m.public_id, userId: user.id, userPublicId: user.publicId, roleKey };
    }),
  );
}
```

- [ ] **Step 4: Test helper (seed → dispose về như trước)**

`test/integration/tenancy/seed-helper.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { inOrgTx, seedMember, seedOrg, withAppClient } from '../../support/tenancy-seed.js';

const counts = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(c, orgId, async () => {
      const q = async (sql: string) => Number((await c.query<{ n: string }>(sql)).rows[0]?.n);
      return {
        orgs: await q(`SELECT count(*) AS n FROM organizations`),
        roles: await q(`SELECT count(*) AS n FROM org_roles`),
        members: await q(`SELECT count(*) AS n FROM org_members`),
      };
    }),
  );

describe('seedOrg / dispose (spec SP3 §5.3)', () => {
  it('seeds an org that passes the bootstrap trigger and disposes it completely, users included', async () => {
    const org = await seedOrg();
    const admin = await seedMember(org, 'ADMIN');
    expect(await counts(org.orgId)).toEqual({ orgs: 1, roles: 3, members: 2 });
    await org.dispose();
    expect(await counts(org.orgId)).toEqual({ orgs: 0, roles: 0, members: 0 });
    const users = await withAppClient((c) => c.query(`SELECT 1 FROM tenancy_users WHERE id = ANY($1::bigint[])`, [[org.owner.userId, admin.userId]]));
    expect(users.rows).toEqual([]);
  });
  it('keeps a user that is still a member of another org (the 23001 branch of dispose)', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const subject = { externalSubject: `test:shared-${a.orgId}` };
    // Review M2: thứ tự có chủ đích. `a` TẠO dòng `tenancy_users` (nên dòng nằm trong danh sách xoá của `a.dispose()`),
    // `b` chỉ dùng lại dòng đó; `a.dispose()` vì vậy thật sự thử xoá và phải đi nhánh bắt `23001` rồi giữ lại.
    const shared = await seedMember(a, 'MEMBER', subject);
    const again = await seedMember(b, 'MEMBER', subject);
    expect(again.userId).toBe(shared.userId);
    await a.dispose();
    const users = await withAppClient((c) => c.query(`SELECT 1 FROM tenancy_users WHERE id = $1`, [shared.userId]));
    expect(users.rows).toHaveLength(1);
    await b.dispose();
    // `b` không tạo dòng này nên không xoá nó: dọn tay khi không còn membership nào.
    await withAppClient((c) => c.query(`DELETE FROM tenancy_users WHERE id = $1`, [shared.userId]));
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/seed-helper.spec.ts`
Expected: PASS (migration fixture mới được global setup áp).

- [ ] **Step 5: Cô lập mỗi bảng tenant qua app thật (tiêu chí 1)**

`test/integration/tenancy/isolation.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

describe('tenant isolation of the 3A tables through the app (spec SP3 §1 criterion 1, §18.1)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  const inA = <T>(fn: () => Promise<T>) => app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) => app.get(Db).execute<T>(q, p);
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    a = await seedOrg();
    b = await seedOrg();
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await app?.close();
  });

  it.each([
    ['organizations', 'id'],
    ['org_roles', 'org_id'],
    ['org_members', 'org_id'],
    ['scheduled_tasks', 'org_id'],
  ])('%s: read/update/delete of org B from OrgScope(A) touch 0 rows', async (table, col) => {
    expect(await inA(() => sql(`SELECT 1 FROM ${table} WHERE ${col} = ?`, [b.orgId]))).toEqual([]);
    expect(await inA(() => sql(`UPDATE ${table} SET updated_at = now() WHERE ${col} = ? RETURNING 1`, [b.orgId]))).toEqual([]);
    const del = table === 'organizations' || table === 'org_roles' ? [] : await inA(() => sql(`DELETE FROM ${table} WHERE ${col} = ? RETURNING 1`, [b.orgId]));
    expect(del).toEqual([]);
  });
  it('INSERT with org_id = B is refused by RLS (42501 → 404 at the mapper)', async () => {
    await expect(inA(() => sql(`INSERT INTO org_roles (org_id, name) VALUES (?, 'x')`, [b.orgId]))).rejects.toThrow(/row-level security/);
    await expect(inA(() => sql(`INSERT INTO organizations (id, name) VALUES (?, 'x')`, [v7()]))).rejects.toThrow(/row-level security/);
    await expect(
      inA(() => sql(`INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES (?, 'k', 'a.b', '0 1 * * *', 'UTC', '{}', true)`, [b.orgId])),
    ).rejects.toThrow(/row-level security/);
  });
  it('without an org context every tenancy table fails closed (P0001)', async () => {
    for (const t of ['organizations', 'org_roles', 'org_members'])
      await expect(app.get(UnitOfWork).run(() => sql(`SELECT 1 FROM ${t}`))).rejects.toThrow(/org context is not set/);
  });
  it('a child row in A pointing at a parent in B violates the composite FK (23503)', async () => {
    await expect(
      inA(() => sql(`INSERT INTO org_members (org_id, user_id, role_id) VALUES (?, ?, ?)`, [a.orgId, b.owner.userId, b.roles.MEMBER.id])),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('a reused connection does not keep the org of a committed transaction', async () => {
    await withAppClient(async (c) => {
      await inOrgTx(c, a.orgId, () => c.query('SELECT 1 FROM org_members'));
      await expect(c.query('SELECT 1 FROM org_members')).rejects.toMatchObject({ code: 'P0001' });
    });
  });
});
```
(`organizations`/`org_roles` không có `DELETE` trong ca đầu: xoá org B ở scope A đã trả 0 dòng bằng RLS trong ca `UPDATE`; `DELETE` role hệ thống bị trigger kiểm trên dòng thấy được, mà dòng của B không thấy được, nên kết quả vẫn 0 — gộp để ca ngắn.)

Run: `pnpm vitest run --project integration test/integration/tenancy/isolation.spec.ts`
Expected: PASS.

- [ ] **Step 6: Ràng buộc DB và race không khoá**

`test/integration/tenancy/constraints.spec.ts`:
```ts
import pg from 'pg';
import { v4, v7 } from 'uuid';
import { afterAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../support/infra.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const RACE_ROUNDS = 50;
const disposers: SeededOrg[] = [];
const seed = async () => {
  const o = await seedOrg();
  disposers.push(o);
  return o;
};
afterAll(async () => {
  for (const o of disposers) await o.dispose();
});
const rejectsWith = (p: Promise<unknown>, code: string, constraint?: string) =>
  expect(p).rejects.toMatchObject(constraint ? { code, constraint } : { code });
const owners = (c: pg.Client) =>
  c.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`);

describe('last owner (spec SP3 §6.6, O-3, O-13, T-1, T-28)', () => {
  it('O-3: deleting or demoting the only owner of an active org fails at COMMIT (23514 org_members_last_owner_ck)', async () => {
    const o = await seed();
    await withAppClient(async (c) => {
      await rejectsWith(inOrgTx(c, o.orgId, () => c.query(`DELETE FROM org_members WHERE id = $1`, [o.owner.memberId])), '23514', 'org_members_last_owner_ck');
      await rejectsWith(inOrgTx(c, o.orgId, () => c.query(`UPDATE org_members SET role_id = $2 WHERE id = $1`, [o.owner.memberId, o.roles.MEMBER.id])), '23514', 'org_members_last_owner_ck');
    });
  });
  it(`O-13 / T-28: two app_user connections deleting two owners without locking the org, ×${RACE_ROUNDS} → the org always keeps an owner`, async () => {
    const o = await seed();
    const { pg: p } = getInfra();
    const [a, b] = [new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app }), new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app })];
    await Promise.all([a.connect(), b.connect()]);
    try {
      for (let i = 0; i < RACE_ROUNDS; i++) {
        const x = await seedMember(o, 'OWNER');
        const y = await seedMember(o, 'OWNER');
        // Đúng hai owner (x, y) trước mỗi vòng: xoá mọi owner khác bằng một transaction thường (hợp lệ vì x, y còn).
        await withAppClient((c) =>
          inOrgTx(c, o.orgId, () => c.query(`DELETE FROM org_members WHERE role_id = $1 AND id <> ALL($2::bigint[])`, [o.roles.OWNER.id, [x.memberId, y.memberId]])),
        );
        for (const [conn, m] of [[a, x], [b, y]] as const) {
          await conn.query('BEGIN');
          await conn.query(`SELECT set_config('app.org_id', $1, true)`, [o.orgId]);
          await conn.query(`DELETE FROM org_members WHERE id = $1`, [m.memberId]);
        }
        const results = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')]);
        const left = await withAppClient((c) => inOrgTx(c, o.orgId, () => owners(c)));
        expect(left.rows[0]?.n, `round ${i}`).toBeGreaterThanOrEqual(1);
        expect(results.filter((r) => r.status === 'rejected').length, `round ${i}`).toBe(1);
      }
    } finally {
      await a.end();
      await b.end();
    }
  });
  it('the trigger refuses REPEATABLE READ (its correctness relies on a fresh snapshot after the lock)', async () => {
    const o = await seed();
    const admin = await seedMember(o, 'ADMIN');
    await withAppClient(async (c) => {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [o.orgId]);
      await c.query(`DELETE FROM org_members WHERE id = $1`, [admin.memberId]);
      await rejectsWith(c.query('COMMIT'), '23514', 'org_members_last_owner_ck');
    });
  });
  it('a soft-deleted org is exempt (account deletion must not be blocked by a deleted org, S3-A12)', async () => {
    const o = await seed();
    await withAppClient((c) =>
      inOrgTx(c, o.orgId, async () => {
        await c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`);
        await c.query(`DELETE FROM org_members WHERE id = $1`, [o.owner.memberId]);
      }),
    );
  });
});

describe('restore and bootstrap (spec SP3 §6.4, O-14, T-23)', () => {
  it('O-14: restoring an org with no owner left fails at COMMIT (23514 organizations_restore_owner_ck)', async () => {
    const o = await seed();
    await withAppClient(async (c) => {
      await inOrgTx(c, o.orgId, async () => {
        await c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`);
        await c.query(`DELETE FROM org_members`);
      });
      await rejectsWith(inOrgTx(c, o.orgId, () => c.query(`UPDATE organizations SET deleted_at = NULL, purge_after = NULL`)), '23514', 'organizations_restore_owner_ck');
    });
  });
  it('T-23: an org without its three system roles or without an owner cannot commit', async () => {
    await withAppClient(async (c) => {
      const noRoles = v7();
      await rejectsWith(inOrgTx(c, noRoles, () => c.query(`INSERT INTO organizations (id, name) VALUES ($1, 'x')`, [noRoles])), '23514', 'organizations_bootstrap_ck');
      const noOwner = v7();
      await rejectsWith(
        inOrgTx(c, noOwner, async () => {
          await c.query(`INSERT INTO organizations (id, name) VALUES ($1, 'x')`, [noOwner]);
          await c.query(`INSERT INTO org_roles (org_id, system_key) VALUES ($1, 'OWNER'), ($1, 'ADMIN'), ($1, 'MEMBER')`, [noOwner]);
        }),
        '23514',
        'organizations_bootstrap_ck',
      );
    });
  });
  it('deleting an org that still has children is refused (23001), even while soft-deleted', async () => {
    const o = await seed();
    await withAppClient((c) =>
      rejectsWith(
        inOrgTx(c, o.orgId, async () => {
          await c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`);
          await c.query(`DELETE FROM organizations`);
        }),
        '23001',
      ),
    );
  });
});

describe('system roles and row shapes (spec SP3 §6.2–6.5)', () => {
  it('a system role cannot be updated or deleted while the org is active (23514 org_roles_system_immutable)', async () => {
    const o = await seed();
    await withAppClient(async (c) => {
      await rejectsWith(inOrgTx(c, o.orgId, () => c.query(`UPDATE org_roles SET updated_at = now() WHERE id = $1`, [o.roles.ADMIN.id])), '23514', 'org_roles_system_immutable');
      await rejectsWith(inOrgTx(c, o.orgId, () => c.query(`DELETE FROM org_roles WHERE id = $1`, [o.roles.ADMIN.id])), '23514', 'org_roles_system_immutable');
    });
  });
  it.each([
    ['both subjects NULL', `INSERT INTO tenancy_users DEFAULT VALUES`, [], 'tenancy_users_one_subject_ck'],
    ['both subjects set', `INSERT INTO tenancy_users (auth_user_id, external_subject) VALUES ($1, 'x')`, [v4()], 'tenancy_users_one_subject_ck'],
    ['a 256-char subject', `INSERT INTO tenancy_users (external_subject) VALUES ($1)`, ['s'.repeat(256)], 'tenancy_users_external_subject_ck'],
  ])('tenancy_users: %s → 23514', async (_n, sql, params, constraint) => {
    await withAppClient(async (c) => {
      await c.query('BEGIN');
      await rejectsWith(c.query(sql, params), '23514', constraint);
      await c.query('ROLLBACK');
    });
  });
  it.each([
    ['a v4 id', v4(), 'Name', 'organizations_id_v7_ck'],
    ['a padded name', v7(), ' Name', 'organizations_name_ck'],
    ['a 101-code-point name', v7(), '😀'.repeat(101), 'organizations_name_ck'],
  ])('organizations: %s → 23514', async (_n, id, name, constraint) => {
    await withAppClient((c) => rejectsWith(inOrgTx(c, id, () => c.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, name])), '23514', constraint));
  });
  it('permissions: app_user is read-only; the CHECKs refuse wildcards and malformed keys (owner, rolled back)', async () => {
    await withAppClient((c) => rejectsWith(c.query(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('x', 'y', false, false, false)`), '42501'));
    const { pg: p } = getInfra();
    const owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
    try {
      const bad: [string, string, string][] = [
        ['org', 'manage', 'permissions_action_ck'],
        ['all', 'read', 'permissions_resource_ck'],
        ['_x', 'read', 'permissions_resource_ck'],
        ['org', 'a.b.c', 'permissions_action_ck'],
        ['org', 'Read', 'permissions_action_ck'],
      ];
      for (const [resource, action, constraint] of bad) {
        await owner.query('BEGIN');
        await rejectsWith(owner.query(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ($1, $2, false, false, false)`, [resource, action]), '23514', constraint);
        await owner.query('ROLLBACK');
      }
      await owner.query('BEGIN');
      await rejectsWith(owner.query(`INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('org', 'x', true, true, false)`), '23514', 'permissions_owner_only_ck');
      await owner.query('ROLLBACK');
      const catalogue = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM permissions`);
      expect(catalogue.rows).toEqual([{ n: 19 }]);
    } finally {
      await owner.end();
    }
  });
});

describe('FOR NO KEY UPDATE on the org row never blocks a child INSERT (spec SP3 §3.13, DB-I3)', () => {
  it('a feature INSERT with an FK to organizations proceeds while an admin transaction holds the org lock', async () => {
    const o = await seed();
    const { pg: p } = getInfra();
    const holder = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [o.orgId]);
      await holder.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [o.orgId]);
      await withAppClient(async (c) => {
        await c.query(`SET lock_timeout = '1s'`);
        await inOrgTx(c, o.orgId, () => c.query(`INSERT INTO fixture_org_items (org_id) VALUES ($1)`, [o.orgId]));
        await inOrgTx(c, o.orgId, () => c.query(`DELETE FROM fixture_org_items`));
      });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });
});
```
Ghi chú ca O-13: mỗi vòng dựng đúng hai owner `x`, `y`, rồi hai kết nối **không** khoá org ở caller xoá `x` và `y` song song: trigger của bên commit trước lấy khoá dòng org, còn thấy owner kia nên đạt; trigger của bên sau chờ khoá, rồi (snapshot mới dưới `READ COMMITTED`) đếm thấy 0 owner và bị từ chối. Khẳng định: đúng một bên thất bại và org luôn còn ≥ 1 owner. Ca composite FK dùng user của org B (không phải member của A) để `UNIQUE (org_id, user_id)` không bắn trước FK.

Run: `pnpm vitest run --project integration test/integration/tenancy`
Expected: PASS.

- [ ] **Step 7: Chạy migration/catalog lại (fixture mới)**

Run: `pnpm vitest run --project integration test/integration/core/database`
Expected: PASS (sweep fixture có `fixture_org_items`; catalog: bảng có `org_id` có RLS + FORCE + policy).

- [ ] **Step 8: Commit**

```bash
git add src/modules/tenancy/infra/sql/org-purge.sql.ts test/support/tenancy-seed.ts test/fixtures/migrations test/integration/tenancy
git commit -m "test(tenancy): seed helper sharing the purge order; isolation of the 3A tables; DB invariants and unlocked owner races"
```

---

### Task 15: Sáu hàm `SECURITY DEFINER` chỉ đọc (dưới `SET LOCAL ROLE tenancy_definer`), catalog hàm, hành vi và biên tham số

**Files:**
- Create: `src/modules/tenancy/constants.ts`, `test/integration/tenancy/definer-functions.spec.ts`
- Modify: `src/migrations/tenancy/Migration<ts>_tenancy_core.ts` (thêm cuối `up`, đầu `down`), `test/integration/core/database/rls-catalog.spec.ts`

**Interfaces:**
- Consumes: bảng Task 13, `DEFINER_FUNCTIONS` (Task 4), `seedOrg`/`seedMember`/`withAppClient`/`inOrgTx` (Task 14).
- Produces:
  - `src/modules/tenancy/constants.ts`: `ORG_NAME_MAX_LENGTH = 100`, `DEFINER_LIMIT_MAX = 1000`, `PURGE_CURSOR_START = '00000000-0000-0000-0000-000000000000'`, `SYSTEM_ROLE_KEYS = ['OWNER', 'ADMIN', 'MEMBER'] as const`, `type SystemRoleKey`.
  - Hàm (chữ ký đúng spec §6.14): `tenancy_list_user_orgs(bigint, boolean, integer, integer)`, `tenancy_count_user_orgs(bigint, boolean)`, `tenancy_count_orgs_created_by(bigint)`, `tenancy_user_sole_owner_orgs(bigint)`, `tenancy_user_related_org_ids(bigint)`, `tenancy_orgs_due_for_purge(uuid, integer)`; owner `tenancy_definer`, `SET search_path = ''`, `EXECUTE` chỉ cho `app_user`; tham số `NULL` hoặc ngoài biên → `RAISE`.

- [ ] **Step 1: Hằng của tenancy**

`src/modules/tenancy/constants.ts`:
```ts
/** Spec SP3 §13 "Hằng số có tên": định dạng, dùng chung giữa zod và CHECK/hàm SQL (migration viết cứng cùng giá trị). */
export const ORG_NAME_MAX_LENGTH = 100;
/** Trần `p_limit` của hàm definer (`RAISE` khi vượt, DB-M3). */
export const DEFINER_LIMIT_MAX = 1000;
/** Con trỏ keyset lượt đầu của cron xoá cứng (UUID nil, nhỏ hơn mọi UUID v7; CDX-8). */
export const PURGE_CURSOR_START = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_ROLE_KEYS = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];
```

- [ ] **Step 2: Test catalog và hành vi (fail)**

`test/integration/core/database/rls-catalog.spec.ts`, trong `describe('schema and database privileges (R20)')`, import `DEFINER_FUNCTIONS` từ `../../../support/tenancy-catalog.js` và thêm:
```ts
  it('app_user EXECUTEs exactly the declared SECURITY DEFINER functions; each is owned by tenancy_definer with search_path=""', async () => {
    const { rows } = await client.query<{ name: string; owner: string; config: string[] | null; app: boolean; pub: boolean }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.name)).toEqual([...DEFINER_FUNCTIONS].sort());
    for (const r of rows) expect(r, r.name).toMatchObject({ owner: 'tenancy_definer', config: ['search_path=""'], app: true, pub: false });
  });
  it('PUBLIC holds EXECUTE on no function in public', async () => {
    const { rows } = await client.query(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('public', p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });
```
`test/integration/tenancy/definer-functions.spec.ts`:
```ts
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFINER_LIMIT_MAX, PURGE_CURSOR_START } from '../../../src/modules/tenancy/constants.js';
import { getInfra } from '../../support/infra.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const subject = `test:definer-${v7()}`;
const orgs: SeededOrg[] = [];
let userId = '';
let owned: SeededOrg;
let memberOf: SeededOrg;
let deletedOwned: SeededOrg;
let deletedMemberOf: SeededOrg;
let createdThenLeft: SeededOrg;

const call = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => withAppClient(async (c) => (await c.query<T>(sql, params)).rows);
const softDelete = (o: SeededOrg, purgeAfter: string) =>
  withAppClient((c) => inOrgTx(c, o.orgId, () => c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = ${purgeAfter}`)));

beforeAll(async () => {
  owned = await seedOrg({ owner: { externalSubject: subject } });
  userId = owned.owner.userId;
  memberOf = await seedOrg();
  await seedMember(memberOf, 'MEMBER', { externalSubject: subject });
  deletedOwned = await seedOrg({ owner: { externalSubject: subject } });
  deletedMemberOf = await seedOrg();
  await seedMember(deletedMemberOf, 'ADMIN', { externalSubject: subject });
  createdThenLeft = await seedOrg({ owner: { externalSubject: subject } });
  // "Tạo org rồi rời": thêm một owner khác rồi xoá membership của user (hợp lệ vì org còn owner).
  await seedMember(createdThenLeft, 'OWNER');
  await withAppClient((c) => inOrgTx(c, createdThenLeft.orgId, () => c.query(`DELETE FROM org_members WHERE id = $1`, [createdThenLeft.owner.memberId])));
  await softDelete(deletedOwned, `now() - interval '1 day'`);
  await softDelete(deletedMemberOf, `now() + interval '1 day'`);
  orgs.push(owned, memberOf, deletedOwned, deletedMemberOf, createdThenLeft);
});
afterAll(async () => {
  for (const o of orgs) await o.dispose();
});

describe('definer functions called by app_user without an org context (spec SP3 §6.14)', () => {
  it('tenancy_list_user_orgs lists memberships in join order; soft-deleted orgs only for owners and only when asked', async () => {
    const active = await call<{ org_id: string; role_system_key: string }>(`SELECT org_id::text, role_system_key FROM tenancy_list_user_orgs($1, false, 100, 0)`, [userId]);
    expect(active.map((r) => r.org_id)).toEqual([owned.orgId, memberOf.orgId]);
    const withDeleted = await call<{ org_id: string; org_deleted_at: Date | null }>(`SELECT org_id::text, org_deleted_at FROM tenancy_list_user_orgs($1, true, 100, 0)`, [userId]);
    expect(withDeleted.map((r) => r.org_id)).toEqual([owned.orgId, memberOf.orgId, deletedOwned.orgId]);
    expect(withDeleted.at(-1)?.org_deleted_at).toBeInstanceOf(Date);
    const [count] = await call<{ n: string }>(`SELECT tenancy_count_user_orgs($1, true) AS n`, [userId]);
    expect(Number(count?.n)).toBe(withDeleted.length);
    const page = await call(`SELECT * FROM tenancy_list_user_orgs($1, false, 1, 1)`, [userId]);
    expect(page).toHaveLength(1);
  });
  it('tenancy_count_orgs_created_by counts orgs the user created, soft-deleted included (S3-A22)', async () => {
    const [r] = await call<{ n: string }>(`SELECT tenancy_count_orgs_created_by($1) AS n`, [userId]);
    expect(Number(r?.n)).toBe(3);
  });
  it('tenancy_user_sole_owner_orgs returns active orgs where the user is the only owner', async () => {
    const rows = await call<{ org_id: string }>(`SELECT org_id::text FROM tenancy_user_sole_owner_orgs($1)`, [userId]);
    expect(rows.map((r) => r.org_id)).toEqual([owned.orgId]);
  });
  it('tenancy_user_related_org_ids covers memberships and created orgs the user left, ordered by org id', async () => {
    const rows = await call<{ org_id: string }>(`SELECT org_id::text FROM tenancy_user_related_org_ids($1)`, [userId]);
    expect(rows.map((r) => r.org_id)).toEqual([owned, memberOf, deletedOwned, deletedMemberOf, createdThenLeft].map((o) => o.orgId).sort());
  });
  it('tenancy_orgs_due_for_purge walks soft-deleted orgs past purge_after by keyset', async () => {
    const first = await call<{ org_id: string }>(`SELECT org_id::text FROM tenancy_orgs_due_for_purge($1, $2)`, [PURGE_CURSOR_START, DEFINER_LIMIT_MAX]);
    expect(first.map((r) => r.org_id)).toContain(deletedOwned.orgId);
    expect(first.map((r) => r.org_id)).not.toContain(deletedMemberOf.orgId);
    const after = await call(`SELECT org_id FROM tenancy_orgs_due_for_purge($1, $2)`, [deletedOwned.orgId, DEFINER_LIMIT_MAX]);
    expect(after.map((r) => String(r.org_id))).not.toContain(deletedOwned.orgId);
  });
  it.each([
    ['NULL user', `SELECT * FROM tenancy_list_user_orgs(NULL, false, 1, 0)`],
    ['NULL flag', `SELECT * FROM tenancy_count_user_orgs(1, NULL)`],
    ['limit 0', `SELECT * FROM tenancy_list_user_orgs(1, false, 0, 0)`],
    [`limit ${DEFINER_LIMIT_MAX + 1}`, `SELECT * FROM tenancy_list_user_orgs(1, false, ${DEFINER_LIMIT_MAX + 1}, 0)`],
    ['negative offset', `SELECT * FROM tenancy_list_user_orgs(1, false, 1, -1)`],
    ['NULL cursor', `SELECT * FROM tenancy_orgs_due_for_purge(NULL, 1)`],
    ['NULL user (sole owner)', `SELECT * FROM tenancy_user_sole_owner_orgs(NULL)`],
    ['NULL user (related)', `SELECT * FROM tenancy_user_related_org_ids(NULL)`],
    ['NULL user (created)', `SELECT tenancy_count_orgs_created_by(NULL)`],
  ])('%s → raises (DB-M3: never an empty answer that would allow a deletion)', async (_n, sql) => {
    await expect(call(sql, [])).rejects.toMatchObject({ code: 'P0001' });
  });
});

describe('the definer role cannot write, and only SET LOCAL ROLE can drop its functions (T2, S3-A31)', () => {
  const { pg: p } = getInfra();
  let owner: pg.Client;
  beforeAll(async () => {
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE tenancy_definer');
    await owner.query(`CREATE FUNCTION public.tenancy_probe_write() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN UPDATE public.organizations SET name = name; END $$`);
    await owner.query(`REVOKE ALL ON FUNCTION public.tenancy_probe_write() FROM PUBLIC`);
    await owner.query(`GRANT EXECUTE ON FUNCTION public.tenancy_probe_write() TO app_user`);
    await owner.query('RESET ROLE');
    await owner.query('COMMIT');
  });
  afterAll(async () => {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE tenancy_definer');
    await owner.query('DROP FUNCTION IF EXISTS public.tenancy_probe_write()');
    await owner.query('RESET ROLE');
    await owner.query('COMMIT');
    await owner.end();
  });
  it('a definer function that tries to UPDATE fails with 42501', async () => {
    await expect(call(`SELECT public.tenancy_probe_write()`, [])).rejects.toMatchObject({ code: '42501' });
  });
  it('bare app_owner cannot DROP it (42501); under SET LOCAL ROLE tenancy_definer it can', async () => {
    await expect(owner.query('DROP FUNCTION public.tenancy_probe_write()')).rejects.toMatchObject({ code: '42501' });
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/definer-functions.spec.ts test/integration/core/database/rls-catalog.spec.ts`
Expected: FAIL (`function tenancy_list_user_orgs(...) does not exist`; catalog: danh sách hàm rỗng).

- [ ] **Step 3: Thêm 6 hàm vào migration `tenancy_core`**

Cuối `up()` của `src/migrations/tenancy/Migration<ts>_tenancy_core.ts` (sau hai câu seed catalogue):
```ts
    // Spec §6.14, S3-A2, S3-A31: hàm SECURITY DEFINER chỉ đọc, sở hữu bởi tenancy_definer (chỉ SELECT theo cột + policy
    // `FOR SELECT TO tenancy_definer USING (true)`, không ghi được). Tạo/xoá DƯỚI `SET LOCAL ROLE`: với INHERIT FALSE,
    // app_owner không phải owner của hàm (PG ≥ 16). Tham số NULL hoặc ngoài biên → RAISE (không STRICT: STRICT trả rỗng
    // âm thầm, và `tenancy_user_sole_owner_orgs(NULL)` rỗng sẽ cho phép xoá tài khoản).
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`CREATE FUNCTION public.tenancy_list_user_orgs(p_user_id bigint, p_include_deleted boolean, p_limit integer, p_offset integer)
RETURNS TABLE (org_id uuid, org_name text, org_deleted_at timestamptz, org_purge_after timestamptz,
               member_public_id uuid, role_public_id uuid, role_system_key text, role_name text, joined_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL OR p_include_deleted IS NULL OR p_limit IS NULL OR p_offset IS NULL THEN
    RAISE EXCEPTION 'tenancy_list_user_orgs: arguments must not be NULL';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'tenancy_list_user_orgs: p_limit must be between 1 and 1000'; END IF;
  IF p_offset < 0 THEN RAISE EXCEPTION 'tenancy_list_user_orgs: p_offset must not be negative'; END IF;
  RETURN QUERY
    SELECT o.id, o.name, o.deleted_at, o.purge_after, m.public_id, r.public_id, r.system_key, r.name, m.created_at
    FROM public.org_members m
    JOIN public.organizations o ON o.id = m.org_id
    JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.user_id = p_user_id AND (o.deleted_at IS NULL OR (p_include_deleted AND r.system_key = 'OWNER'))
    ORDER BY m.created_at, m.id
    LIMIT p_limit OFFSET p_offset;
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_count_user_orgs(p_user_id bigint, p_include_deleted boolean)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL OR p_include_deleted IS NULL THEN RAISE EXCEPTION 'tenancy_count_user_orgs: arguments must not be NULL'; END IF;
  RETURN (
    SELECT count(*) FROM public.org_members m
    JOIN public.organizations o ON o.id = m.org_id
    JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    WHERE m.user_id = p_user_id AND (o.deleted_at IS NULL OR (p_include_deleted AND r.system_key = 'OWNER')));
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_count_orgs_created_by(p_user_id bigint)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_count_orgs_created_by: p_user_id must not be NULL'; END IF;
  RETURN (SELECT count(*) FROM public.organizations o WHERE o.created_by_user_id = p_user_id);
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_user_sole_owner_orgs(p_user_id bigint)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_user_sole_owner_orgs: p_user_id must not be NULL'; END IF;
  RETURN QUERY
    SELECT m.org_id FROM public.org_members m
    JOIN public.org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
    JOIN public.organizations o ON o.id = m.org_id
    WHERE m.user_id = p_user_id AND r.system_key = 'OWNER' AND o.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.org_members m2
        JOIN public.org_roles r2 ON r2.org_id = m2.org_id AND r2.id = m2.role_id
        WHERE m2.org_id = m.org_id AND r2.system_key = 'OWNER' AND m2.user_id <> p_user_id)
    ORDER BY m.org_id;
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_user_related_org_ids(p_user_id bigint)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'tenancy_user_related_org_ids: p_user_id must not be NULL'; END IF;
  RETURN QUERY
    SELECT x.org_id FROM (
      SELECT m.org_id FROM public.org_members m WHERE m.user_id = p_user_id
      UNION
      SELECT o.id FROM public.organizations o WHERE o.created_by_user_id = p_user_id) AS x
    ORDER BY x.org_id;
END $$;`);
    this.addSql(`CREATE FUNCTION public.tenancy_orgs_due_for_purge(p_after uuid, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_after IS NULL OR p_limit IS NULL THEN RAISE EXCEPTION 'tenancy_orgs_due_for_purge: arguments must not be NULL'; END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'tenancy_orgs_due_for_purge: p_limit must be between 1 and 1000'; END IF;
  RETURN QUERY
    SELECT o.id FROM public.organizations o
    WHERE o.deleted_at IS NOT NULL AND o.purge_after <= now() AND o.id > p_after
    ORDER BY o.id LIMIT p_limit;
END $$;`);
    for (const sig of [
      'tenancy_list_user_orgs(bigint, boolean, integer, integer)',
      'tenancy_count_user_orgs(bigint, boolean)',
      'tenancy_count_orgs_created_by(bigint)',
      'tenancy_user_sole_owner_orgs(bigint)',
      'tenancy_user_related_org_ids(bigint)',
      'tenancy_orgs_due_for_purge(uuid, integer)',
    ]) {
      this.addSql(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      this.addSql(`GRANT EXECUTE ON FUNCTION public.${sig} TO app_user;`);
    }
    this.addSql(`RESET ROLE;`);
```
Đầu `down()` (trước `DROP TABLE org_members`):
```ts
    this.addSql(`SET LOCAL ROLE tenancy_definer;`);
    this.addSql(`DROP FUNCTION public.tenancy_orgs_due_for_purge(uuid, integer);`);
    this.addSql(`DROP FUNCTION public.tenancy_user_related_org_ids(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_user_sole_owner_orgs(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_count_orgs_created_by(bigint);`);
    this.addSql(`DROP FUNCTION public.tenancy_count_user_orgs(bigint, boolean);`);
    this.addSql(`DROP FUNCTION public.tenancy_list_user_orgs(bigint, boolean, integer, integer);`);
    this.addSql(`RESET ROLE;`);
```
Chú thích đầu file thêm dòng: `* Hàm definer (6, spec §6.14): biên p_limit 1000 = DEFINER_LIMIT_MAX của \`constants.ts\` (migration không import code; test definer-functions.spec.ts khoá hai giá trị bằng nhau).`

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/tenancy test/integration/core/database
```
Expected: PASS; quét tĩnh xác nhận mọi `CREATE/DROP` của 6 hàm nằm giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE`; round-trip trên database riêng không có `OWNER` (nên một `down` quên `SET LOCAL ROLE` sẽ `42501` ở đây như ở production).

- [ ] **Step 5: Commit**

```bash
git add src/modules/tenancy/constants.ts src/migrations/tenancy test/integration/tenancy/definer-functions.spec.ts test/integration/core/database/rls-catalog.spec.ts
git commit -m "feat(tenancy): six read-only SECURITY DEFINER functions owned by tenancy_definer with bounded arguments"
```

---

### Task 16: Migration `scheduled_tasks_org_link` — FK tới `organizations`, trigger treo lịch tạo trong/sau xoá mềm (T-32, X-9); sửa test SP1

**Files:**
- Create: `src/migrations/tenancy/Migration<ts>_scheduled_tasks_org_link.ts` (CLI), `test/integration/tenancy/schedules-soft-delete.spec.ts`
- Modify: `test/integration/core/scheduler/scheduler.spec.ts`, `test/integration/core/database/sp1-normalization-followups.spec.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: `ScheduledTaskService.upsert/suspendAllForCurrentOrg/syncCurrentOrg` (Task 7), `seedOrg`, `withAppClient`, `inOrgTx` (Task 14), `DEFINER_FUNCTIONS_3A`, `DEFINER_READ_TABLES_3A` (Task 4), `psql` (SP2 smoke support), `tenancy.smoke.spec.ts` (Task 8, 12).
- Produces: FK `scheduled_tasks_org_fk (org_id) → organizations(id) ON DELETE RESTRICT`; trigger `scheduled_tasks_suspend_if_org_deleted` (`BEFORE INSERT`, `FOR SHARE` trên dòng org, đặt `suspended_at = deleted_at` khi org đã xoá mềm), hàm `tenancy_scheduled_tasks_suspend_if_org_deleted()`.

- [ ] **Step 1: Tạo migration**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/tenancy --name scheduled_tasks_org_link`
Expected: timestamp lớn hơn `tenancy_core`.

- [ ] **Step 2: Test X-9 (fail)**

`test/integration/tenancy/schedules-soft-delete.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseModule, Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { JobScheduler, MaintenanceQueue, QueueModule, defineJob } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { ScheduledTaskService, SchedulerModule, tenantTaskId } from '../../../src/core/scheduler/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';
import pg from 'pg';

const ROUNDS = 20;
const LOCK_WAIT_POLL_MS = 20;
const Nightly = defineJob({ name: 'fixture.tenancy.nightly', queue: MaintenanceQueue, version: 1, schema: z.object({}), tenantSchedulable: true });

describe('schedules of a soft-deleted org (spec SP3 §9.4, T-32, X-9, DB2-N5)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const svc = () => app.get(ScheduledTaskService);
  const task = (key: string) => ({ key, job: Nightly, cron: '0 2 * * *', timezone: 'UTC', payload: {}, enabled: true });
  const suspended = (orgId: string) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(() => app.get(Db).execute<{ key: string; suspended: boolean }>(`SELECT key, suspended_at IS NOT NULL AS suspended FROM scheduled_tasks ORDER BY key`)));
  const seed = async () => {
    const o = await seedOrg();
    orgs.push(o);
    return o;
  };
  beforeAll(async () => {
    vi.stubEnv('APP_ROLE', 'api');
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), SchedulerModule.forRoot({ worker: false })]);
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('a schedule created after the soft delete is suspended by the trigger and never reaches Redis', async () => {
    const o = await seed();
    await withAppClient((c) => inOrgTx(c, o.orgId, () => c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day'`)));
    await app.get(OrgScope).run(o.orgId, () => svc().upsert(task('late')));
    expect(await suspended(o.orgId)).toEqual([{ key: 'late', suspended: true }]);
    expect(await app.get(JobScheduler).listIds(tenantTaskId(o.orgId, ''))).toEqual([]);
  });
  it(`an upsert racing the soft delete waits for it (FOR SHARE vs FOR NO KEY UPDATE) and ends suspended, ×${ROUNDS}`, async () => {
    const { pg: p } = getInfra();
    const watcher = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await watcher.connect();
    try {
      for (let i = 0; i < ROUNDS; i++) {
        const o = await seed();
        await withAppClient(async (c) => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.org_id', $1, true)`, [o.orgId]);
          await c.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [o.orgId]);
          await c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`, [o.orgId]);
          const racing = app.get(OrgScope).run(o.orgId, () => svc().upsert(task(`race${i}`)));
          // Chờ tới khi INSERT của upsert thật sự đứng đợi khoá dòng org (pg_locks đọc được bởi mọi role).
          for (;;) {
            const { rows } = await watcher.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
            if ((rows[0]?.n ?? 0) > 0) break;
            await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
          }
          await c.query('COMMIT');
          await racing;
        });
        expect(await suspended(o.orgId), `round ${i}`).toEqual([{ key: `race${i}`, suspended: true }]);
        expect(await app.get(JobScheduler).listIds(tenantTaskId(o.orgId, ''))).toEqual([]);
      }
    } finally {
      await watcher.end();
    }
  });
  it('an org that does not exist cannot own a schedule (23503 scheduled_tasks_org_fk)', async () => {
    await expect(
      withAppClient((c) =>
        inOrgTx(c, '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', () =>
          c.query(`INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ('0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b', 'k', 'a.b', '0 1 * * *', 'UTC', '{}', true)`),
        ),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'scheduled_tasks_org_fk' });
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/schedules-soft-delete.spec.ts`
Expected: FAIL (ca đầu: `suspended: false`; ca FK: INSERT thành công).

- [ ] **Step 3: Viết migration**

`src/migrations/tenancy/Migration<ts>_scheduled_tasks_org_link.ts`:
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Plan 3A (spec SP3 §6.13 bảng 3A, §9.4, T-32, DB2-N5, S3-A46).
 * - FK `scheduled_tasks.org_id → organizations(id) ON DELETE RESTRICT` (quy ước B5): xoá cứng org thiếu bước xoá lịch thì
 *   fail to (`23001`); participant `core.scheduled-tasks` (Task 25) xoá chúng trước. FK dùng index UNIQUE (org_id, key)
 *   có sẵn (cột đầu là org_id) cho kiểm RESTRICT.
 * - Trigger `BEFORE INSERT` khoá dòng org `FOR SHARE` (không `FOR KEY SHARE`: chỉ `FOR SHARE` xung đột với `FOR NO KEY
 *   UPDATE` của xoá mềm/khôi phục), nên INSERT lịch song song với xoá mềm chờ xoá mềm commit rồi thấy `deleted_at`
 *   (READ COMMITTED: câu khoá trả phiên bản đã commit mới nhất) và tự treo. Nhánh `ON CONFLICT DO UPDATE` của `upsert`
 *   không ghi `suspended_at`: giá trị do trigger đặt trên hàng đề xuất bị bỏ, dòng cũ giữ trạng thái của nó.
 * Chạy dưới app_user trong OrgScope (`WITH CHECK` đã buộc `NEW.org_id` = org hiện tại); `FOR SHARE` cần UPDATE một cột
 * của `organizations` (đã có).
 *
 * Bảng chuẩn hoá: không đổi (thêm FK và trigger, không thêm cột).
 * Khoá: `SHARE ROW EXCLUSIVE` trên `scheduled_tasks` và `organizations`, giữ tới hết lô 3A. Lần deploy đầu, mọi dòng
 * `scheduled_tasks` cũ đều mồ côi (bảng `organizations` mới rỗng) → lô fail to; runbook (README): tạo org tương ứng
 * hoặc xoá lịch mồ côi trước.
 */
export class Migration<ts>_scheduled_tasks_org_link extends Migration {
  override name = 'Migration<ts>_scheduled_tasks_org_link';

  override up(): void | Promise<void> {
    this.addSql(`ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_org_fk FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE RESTRICT;`);
    this.addSql(`CREATE FUNCTION tenancy_scheduled_tasks_suspend_if_org_deleted() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  SELECT deleted_at INTO v_deleted_at FROM public.organizations WHERE id = NEW.org_id FOR SHARE;
  IF v_deleted_at IS NOT NULL THEN
    NEW.suspended_at := v_deleted_at;
  END IF;
  RETURN NEW;
END $$;`);
    this.addSql(`CREATE TRIGGER scheduled_tasks_suspend_if_org_deleted BEFORE INSERT ON scheduled_tasks
    FOR EACH ROW EXECUTE FUNCTION tenancy_scheduled_tasks_suspend_if_org_deleted();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TRIGGER scheduled_tasks_suspend_if_org_deleted ON scheduled_tasks;`);
    this.addSql(`DROP FUNCTION tenancy_scheduled_tasks_suspend_if_org_deleted();`);
    this.addSql(`ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_org_fk;`);
  }
}
```

- [ ] **Step 4: Sửa test SP1 dùng org thật (spec §5.3)**

`test/integration/core/scheduler/scheduler.spec.ts`:
- import `seedOrg, type SeededOrg` từ `../../../support/tenancy-seed.js`;
- trong `describe('tenant tasks')`: thay `const org = randomUUID();` bằng
```ts
    let seeded: SeededOrg;
    let org = '';
    beforeAll(async () => {
      seeded = await seedOrg();
      org = seeded.orgId;
    });
    afterAll(async () => seeded?.dispose());
```
- ca `outside any org, the reconciler restores schedulers for several orgs`: thay `const orgs = [randomUUID(), randomUUID()];` bằng
```ts
        const seededOrgs = [await seedOrg(), await seedOrg()];
        const orgs = seededOrgs.map((s) => s.orgId);
```
và cuối ca: `for (const s of seededOrgs) await s.dispose();` (trong `finally`).
- `describe('org suspension …')` (Task 7): làm như `tenant tasks` (thay `const org = randomUUID()` bằng org seed + `dispose` ở `afterAll`).
- `afterAll` của `describe('scheduler')` giữ nguyên phần gỡ scheduler; `dispose()` xoá dòng `scheduled_tasks`.
`test/integration/core/database/sp1-normalization-followups.spec.ts`:
```ts
import { seedOrg, type SeededOrg } from '../../../support/tenancy-seed.js';
// …
  let org: SeededOrg;
  beforeAll(async () => {
    org = await seedOrg();
    // (kết nối app như cũ)
  });
  afterAll(async () => {
    await app?.end();
    await org?.dispose();
  });
  const insert = async (jobName: string) => {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      await app.query(
        `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'k', $2, '0 * * * *', 'UTC', '{}', true)`,
        [org.orgId, jobName],
      );
    } finally {
      await app.query('ROLLBACK');
    }
  };
```
(bỏ import `v7` nếu không còn dùng.)

- [ ] **Step 5: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/migrations
pnpm vitest run --project integration test/integration/tenancy test/integration/core
```
Expected: PASS; sweep và round-trip xanh; test lịch SP1 xanh với org thật.

- [ ] **Step 6: Smoke prod-like của schema tenancy — migration chạy từ `dist` trên image production (review I10)**

Migration tenancy (Task 13, 15, 16) là migration đầu tiên dùng `SET LOCAL ROLE tenancy_definer`; lần đầu chúng chạy từ `dist` qua container `migrate` của image thật là ở đây, không đợi tới Task 29.
`test/smoke/tenancy.smoke.spec.ts`: import thêm `DEFINER_FUNCTIONS_3A, DEFINER_READ_TABLES_3A` từ `../support/tenancy-catalog.js`; trong `describe`, ngay sau ca `the 3A migrations and the tenancy_definer role are in place`:
```ts
  it('the tenancy schema of 3A migrated from dist: FORCE RLS, definer functions owned by tenancy_definer, 19 permissions, schedules linked to organizations', () => {
    const forced = [...DEFINER_READ_TABLES_3A].sort();
    expect(
      psql(`SELECT string_agg(relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${forced.map((t) => `'${t}'`).join(', ')})`),
    ).toBe(forced.map((t) => `${t}:true:true`).join(','));
    const fns = [...DEFINER_FUNCTIONS_3A].sort();
    // Hàm definer do DDL giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE` tạo ra: chủ là tenancy_definer, SECURITY
    // DEFINER, app_user gọi được, PUBLIC không.
    expect(
      psql(`SELECT string_agg(p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || has_function_privilege('app_user', p.oid, 'EXECUTE')::text || ':' || (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))::text, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${fns.map((f) => `'${f}'`).join(', ')})`),
    ).toBe(fns.map((f) => `${f}:tenancy_definer:true:true:false`).join(','));
    expect(psql(`SELECT count(*) FROM permissions`)).toBe('19');
    expect(psql(`SELECT count(*) FROM pg_constraint WHERE conname = 'scheduled_tasks_org_fk'`)).toBe('1');
    expect(psql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'scheduled_tasks_suspend_if_org_deleted' AND NOT tgisinternal`)).toBe('1');
  });
```
(Tên bảng/hàm lấy từ hằng của test, không phải input ngoài; nối vào SQL của superuser smoke là an toàn. Cột cuối là "PUBLIC gọi được": `proacl IS NULL` nghĩa là ACL mặc định, tức PUBLIC có `EXECUTE`; `aclexplode(...).grantee = 0` là mục của PUBLIC.)

- [ ] **Step 7: Kiểm chứng prod-like — schema tenancy**

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer), container `migrate` chạy từ `dist` mọi migration tới `scheduled_tasks_org_link` (gồm các khối `SET LOCAL ROLE tenancy_definer` … `RESET ROLE`) không lỗi; mọi file smoke PASS; log api/worker là JSON, không `error`; `/health/ready` 200; teardown `down -v` sạch (`docker compose -p nsb-smoke ps -a` rỗng).

- [ ] **Step 8: Commit**

```bash
git add src/migrations/tenancy test/integration/tenancy/schedules-soft-delete.spec.ts test/integration/core/scheduler/scheduler.spec.ts test/integration/core/database/sp1-normalization-followups.spec.ts test/smoke/tenancy.smoke.spec.ts
git commit -m "feat(tenancy): scheduled_tasks belong to an org; schedules created during or after a soft delete are suspended; prod-like smoke of the tenancy schema"
```

---

## Phần E — Miền tenancy thuần (spec §8.1–8.4, §8.7, §9.4)

### Task 17: Catalogue quyền (định nghĩa, gộp, kiểm U1–U5/U12), tập quyền (closure, ⊊), role hệ thống (U3, U6, U16), CASL `Ability` trần (U7–U10, U13)

**Files:**
- Create: `src/modules/tenancy/domain/catalogue.ts`, `src/modules/tenancy/domain/permission-set.ts`, `src/modules/tenancy/domain/system-roles.ts`, `src/modules/tenancy/domain/tenancy-catalogue.ts`, `src/modules/tenancy/application/authz/ability.factory.ts`, `test/unit/modules/tenancy/catalogue.spec.ts`, `test/unit/modules/tenancy/system-roles.spec.ts`, `test/unit/modules/tenancy/ability.spec.ts`, `test/unit/modules/tenancy/prng.ts`

**Interfaces:**
- Consumes: `@casl/ability` (Task 1), `SystemRoleKey` (Task 15 `constants.ts`).
- Produces:
  - `domain/catalogue.ts`: `type CatalogueEntryDef = { resource; action; requires: readonly string[]; ownerOnly; apiKeyEligible; supportEligible; grantTo: { admin: boolean; member: boolean }; deprecated?: boolean }`; `type CatalogueDef<K extends string>` = `{ name: string; entries: Readonly<Record<K, CatalogueEntryDef>>; keys: readonly K[] }`; `defineCatalogue<const D>(name, entries: D): CatalogueDef<keyof D & string>`; `type CatalogueEntry = CatalogueEntryDef & { key: string; catalogue: string; deprecated: boolean }`; `type MergedCatalogue = ReadonlyMap<string, CatalogueEntry>`; `mergeCatalogues(defs): MergedCatalogue` (ném `CatalogueError` liệt kê mọi vi phạm); `catalogueProblems(defs): string[]`; `catalogueEntrySchema` (zod, kiểm runtime cho catalogue của `features/`); `PERMISSION_RESOURCE_PATTERN`, `PERMISSION_ACTION_PATTERN` (cùng regex với `CHECK` của `permissions`); `class UnknownPermissionError extends Error { key }`; `class CatalogueError extends Error { problems }`.
  - `domain/permission-set.ts`: `closure(keys: Iterable<string>, merged): Set<string>`, `isSubset(a, b)`, `isStrictSubset(a, b)`.
  - `domain/system-roles.ts`: `systemRolePermissions(key: SystemRoleKey, merged): ReadonlySet<string>`; `adminCapability(merged): ReadonlySet<string>` (= `A`, spec §8.2).
  - `domain/tenancy-catalogue.ts`: `TENANCY_CATALOGUE` (19 key của spec §8.2, `name = 'tenancy'`).
  - `application/authz/ability.factory.ts`: `NO_WILDCARD = '__no_wildcard__'`, `type TenancyAbility = Ability<[string, string]>`, `buildAbility(permissions: readonly string[], merged): TenancyAbility` (key lạ → `UnknownPermissionError`; key deprecated bị bỏ).

- [ ] **Step 1: PRNG cho test sinh ngẫu nhiên (không cài `fast-check`, spec §18.0)**

`test/unit/modules/tenancy/prng.ts`:
```ts
/** mulberry32: PRNG có seed, đủ cho test sinh tập ngẫu nhiên lặp lại được (in seed khi test đỏ). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randomSubset = <T>(items: readonly T[], rnd: () => number): T[] =>
  items.filter(() => rnd() < 0.5);
```

- [ ] **Step 2: Test catalogue và role hệ thống (fail)**

`test/unit/modules/tenancy/catalogue.spec.ts`:
```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CatalogueError,
  catalogueEntrySchema,
  catalogueProblems,
  defineCatalogue,
  mergeCatalogues,
  type CatalogueEntryDef,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import { NO_WILDCARD } from '../../../../src/modules/tenancy/application/authz/ability.factory.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const entry = (resource: string, action: string, over: Partial<CatalogueEntryDef> = {}): CatalogueEntryDef => ({
  resource,
  action,
  requires: [],
  ownerOnly: false,
  apiKeyEligible: false,
  supportEligible: false,
  grantTo: { admin: false, member: false },
  ...over,
});

describe('permission catalogue (spec SP3 §8.2, U1–U5, U12)', () => {
  it('the tenancy catalogue v1 has the 19 keys of the spec and passes every check', () => {
    expect(TENANCY_CATALOGUE.keys).toHaveLength(19);
    expect(catalogueProblems([TENANCY_CATALOGUE])).toEqual([]);
    expect(mergeCatalogues([TENANCY_CATALOGUE]).get('members.role.assign')).toMatchObject({ resource: 'members', action: 'role.assign', catalogue: 'tenancy', deprecated: false });
  });
  it('U1: keys are unique across catalogues, match the regex and never name the CASL wildcards', () => {
    const dup = defineCatalogue('feature', { 'org.read': entry('org', 'read') });
    expect(catalogueProblems([TENANCY_CATALOGUE, dup])).toContain('duplicate key "org.read" (tenancy, feature)');
    expect(catalogueProblems([defineCatalogue('x', { 'org.manage': entry('org', 'manage') })])).toContain('"org.manage": action must match the pattern and not be "manage"');
    expect(catalogueProblems([defineCatalogue('x', { 'all.read': entry('all', 'read') })])).toContain('"all.read": resource must match the pattern and not be "all"');
    expect(catalogueProblems([defineCatalogue('x', { 'Org.read': entry('Org', 'read') })])).toContain('"Org.read": resource must match the pattern and not be "all"');
    expect(catalogueProblems([defineCatalogue('x', { 'org.read': entry('org', 'reads') })])).toContain('"org.read": key must equal resource.action ("org.reads")');
  });
  it('U12: no key of the merged catalogue can equal the ability sentinel (regex starts with [a-z])', () => {
    const merged = mergeCatalogues([TENANCY_CATALOGUE]);
    for (const e of merged.values()) expect([e.resource, e.action]).not.toContain(NO_WILDCARD);
    expect(catalogueProblems([defineCatalogue('x', { [`${NO_WILDCARD}.read`]: entry(NO_WILDCARD, 'read') })])).not.toEqual([]);
  });
  it('U2: requires targets exist, form no cycle, and an active key never requires a deprecated one', () => {
    expect(catalogueProblems([defineCatalogue('x', { 'a.read': entry('a', 'read', { requires: ['b.read'] }) })])).toContain('"a.read" requires unknown "b.read"');
    expect(
      catalogueProblems([defineCatalogue('x', { 'a.read': entry('a', 'read', { requires: ['b.read'] }), 'b.read': entry('b', 'read', { requires: ['a.read'] }) })]),
    ).toContain('requires cycle through "a.read"');
    expect(
      catalogueProblems([defineCatalogue('x', { 'a.read': entry('a', 'read', { requires: ['b.read'] }), 'b.read': entry('b', 'read', { deprecated: true }) })]),
    ).toContain('"a.read" is active but requires deprecated "b.read"');
  });
  it('U3: the admin and member allow-lists are closed under requires', () => {
    expect(
      catalogueProblems([defineCatalogue('x', { 'a.write': entry('a', 'write', { requires: ['a.read'], grantTo: { admin: true, member: false } }), 'a.read': entry('a', 'read') })]),
    ).toContain('grantTo.admin is not closed: "a.write" requires "a.read"');
  });
  it('U4: grantTo is required at compile time and at runtime', () => {
    expectTypeOf<CatalogueEntryDef>().toHaveProperty('grantTo');
    const { grantTo: _dropped, ...withoutGrant } = entry('a', 'read');
    expect(catalogueEntrySchema.safeParse(withoutGrant).success).toBe(false);
  });
  it('U5: an ownerOnly entry is granted to nobody else and is not eligible for keys or support', () => {
    const bad = defineCatalogue('x', { 'a.delete': entry('a', 'delete', { ownerOnly: true, apiKeyEligible: true, grantTo: { admin: true, member: false } }) });
    expect(catalogueProblems([bad])).toEqual(expect.arrayContaining(['"a.delete" is ownerOnly but granted to admin or member', '"a.delete" is ownerOnly but eligible for API keys or support']));
  });
  it('mergeCatalogues throws a CatalogueError listing every problem (fail loud at boot)', () => {
    const dup = defineCatalogue('feature', { 'org.read': entry('org', 'read') });
    expect(() => mergeCatalogues([TENANCY_CATALOGUE, dup])).toThrow(CatalogueError);
  });
});
```
`test/unit/modules/tenancy/system-roles.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { defineCatalogue, mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { closure, isStrictSubset, isSubset } from '../../../../src/modules/tenancy/domain/permission-set.js';
import { adminCapability, systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('system roles (spec SP3 §8.3, U3, U6, U16)', () => {
  it('U6: role × permission matrix (any diff here must be reviewed)', () => {
    expect(sorted(systemRolePermissions('OWNER', merged))).toEqual([...TENANCY_CATALOGUE.keys].sort());
    expect(sorted(systemRolePermissions('ADMIN', merged))).toEqual([
      'api_keys.read', 'api_keys.write_all', 'api_keys.write_own', 'billing.read', 'invitations.read', 'invitations.write',
      'members.read', 'members.remove', 'members.role.assign', 'org.read', 'org.update', 'roles.read', 'roles.write',
      'support_access.read',
    ]);
    expect(sorted(systemRolePermissions('MEMBER', merged))).toEqual(['members.read', 'org.read', 'roles.read']);
  });
  it('U3: every system role is closed under requires; OWNER is every non-deprecated key', () => {
    for (const k of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      const s = systemRolePermissions(k, merged);
      expect(sorted(closure(s, merged)), k).toEqual(sorted(s));
    }
    const withDeprecated = mergeCatalogues([
      TENANCY_CATALOGUE,
      defineCatalogue('legacy', { 'legacy.read': { resource: 'legacy', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: true, member: true }, deprecated: true } }),
    ]);
    for (const k of ['OWNER', 'ADMIN', 'MEMBER'] as const) expect(systemRolePermissions(k, withDeprecated).has('legacy.read'), k).toBe(false);
  });
  it('MEMBER ⊊ ADMIN ⊊ OWNER', () => {
    const [o, a, m] = (['OWNER', 'ADMIN', 'MEMBER'] as const).map((k) => systemRolePermissions(k, merged));
    expect(isStrictSubset(m!, a!)).toBe(true);
    expect(isStrictSubset(a!, o!)).toBe(true);
    expect(isSubset(a!, a!)).toBe(true);
    expect(isStrictSubset(a!, a!)).toBe(false);
  });
  it('U16: no API-key-eligible or support-eligible set contains the admin capability A', () => {
    const A = adminCapability(merged);
    const eligible = (pick: 'apiKeyEligible' | 'supportEligible') => new Set([...merged.values()].filter((e) => e[pick] && !e.deprecated).map((e) => e.key));
    for (const pick of ['apiKeyEligible', 'supportEligible'] as const) expect(isSubset(A, closure(eligible(pick), merged)), pick).toBe(false);
  });
  it('closure adds requires transitively and refuses unknown keys', () => {
    expect(sorted(closure(['members.role.assign'], merged))).toEqual(['members.read', 'members.role.assign', 'roles.read']);
    expect(() => closure(['ghost.read'], merged)).toThrow('Permission "ghost.read" is not in any registered catalogue');
  });
});
```
`test/unit/modules/tenancy/ability.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildAbility } from '../../../../src/modules/tenancy/application/authz/ability.factory.js';
import { UnknownPermissionError, defineCatalogue, mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);

describe('buildAbility (spec SP3 §8.7, U7–U10, U13)', () => {
  it('U7: an empty ability refuses every catalogue key', () => {
    const a = buildAbility([], merged);
    for (const e of merged.values()) expect(a.can(e.action, e.resource), e.key).toBe(false);
  });
  it('grants exactly the listed keys, from the resource/action fields (dotted actions intact)', () => {
    const a = buildAbility(['members.role.assign', 'org.read'], merged);
    expect(a.can('role.assign', 'members')).toBe(true);
    expect(a.can('read', 'org')).toBe(true);
    expect(a.can('update', 'org')).toBe(false);
  });
  it('U9: case and whitespace variants never match', () => {
    const a = buildAbility(['org.read'], merged);
    expect([a.can('Read', 'org'), a.can('read', 'Org'), a.can('read ', 'org'), a.can('read', ' org')]).toEqual([false, false, false, false]);
  });
  it('U10: a deprecated key never enters the ability even if a stored set still carries it', () => {
    const withDeprecated = mergeCatalogues([
      TENANCY_CATALOGUE,
      defineCatalogue('legacy', { 'legacy.read': { resource: 'legacy', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: false, member: false }, deprecated: true } }),
    ]);
    expect(buildAbility(['legacy.read'], withDeprecated).can('read', 'legacy')).toBe(false);
  });
  it('U13: a key unknown to every registered catalogue is a named error, never ignored', () => {
    expect(() => buildAbility(['ghost.read'], merged)).toThrow(UnknownPermissionError);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy`
Expected: FAIL (module chưa có).

- [ ] **Step 3: Cài đặt miền catalogue và tập quyền**

`src/modules/tenancy/domain/catalogue.ts`:
```ts
import { z } from 'zod';

/** Cùng regex với `CHECK` của bảng `permissions` (migration `tenancy_core`); bắt đầu bằng [a-z] nên không key nào trùng sentinel của ability. */
export const PERMISSION_RESOURCE_PATTERN = /^[a-z][a-z_]{0,31}$/;
export const PERMISSION_ACTION_PATTERN = /^[a-z][a-z_]{0,31}(\.[a-z][a-z_]{0,31})?$/;
/** Wildcard sống của CASL (PR6): cấm ở catalogue và ở DB. */
const CASL_ANY_ACTION = 'manage';
const CASL_ANY_SUBJECT = 'all';

export const catalogueEntrySchema = z
  .object({
    resource: z.string(),
    action: z.string(),
    requires: z.array(z.string()),
    ownerOnly: z.boolean(),
    apiKeyEligible: z.boolean(),
    supportEligible: z.boolean(),
    grantTo: z.object({ admin: z.boolean(), member: z.boolean() }).strict(),
    deprecated: z.boolean().optional(),
  })
  .strict();
export type CatalogueEntryDef = {
  readonly resource: string;
  readonly action: string;
  readonly requires: readonly string[];
  readonly ownerOnly: boolean;
  readonly apiKeyEligible: boolean;
  readonly supportEligible: boolean;
  /** Bắt buộc (PR7): quyền mới không bao giờ tự vào ADMIN/MEMBER. */
  readonly grantTo: { readonly admin: boolean; readonly member: boolean };
  readonly deprecated?: boolean;
};
export type CatalogueDef<K extends string = string> = {
  readonly name: string;
  readonly entries: Readonly<Record<K, CatalogueEntryDef>>;
  readonly keys: readonly K[];
};
export type CatalogueEntry = Omit<CatalogueEntryDef, 'deprecated'> & {
  readonly key: string;
  readonly catalogue: string;
  readonly deprecated: boolean;
};
export type MergedCatalogue = ReadonlyMap<string, CatalogueEntry>;

export class UnknownPermissionError extends Error {
  constructor(readonly key: string) {
    super(`Permission "${key}" is not in any registered catalogue`);
    this.name = 'UnknownPermissionError';
  }
}
export class CatalogueError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid permission catalogue: ${problems.join('; ')}`);
    this.name = 'CatalogueError';
  }
}

/** Khai báo catalogue `as const`: K là union key của CHÍNH catalogue (sai key ở `require(...)` là lỗi compile). */
export function defineCatalogue<const D extends Record<string, CatalogueEntryDef>>(
  name: string,
  entries: D,
): CatalogueDef<Extract<keyof D, string>> {
  const keys = Object.keys(entries).filter((k): k is Extract<keyof D, string> => k in entries);
  return { name, entries, keys };
}

const entriesOf = (defs: readonly CatalogueDef[]): CatalogueEntry[] =>
  defs.flatMap((d) =>
    Object.entries(d.entries).map(([key, e]: [string, CatalogueEntryDef]) => ({
      ...e,
      key,
      catalogue: d.name,
      deprecated: e.deprecated === true,
    })),
  );

/** Mọi vi phạm U1–U5, U12 trên catalogue gộp (spec §8.2). Rỗng = hợp lệ. */
export function catalogueProblems(defs: readonly CatalogueDef[]): string[] {
  const problems: string[] = [];
  const all = entriesOf(defs);
  const byKey = new Map<string, CatalogueEntry>();
  for (const e of all) {
    const shape = catalogueEntrySchema.safeParse({ resource: e.resource, action: e.action, requires: [...e.requires], ownerOnly: e.ownerOnly, apiKeyEligible: e.apiKeyEligible, supportEligible: e.supportEligible, grantTo: { ...e.grantTo }, deprecated: e.deprecated });
    if (!shape.success) problems.push(`"${e.key}": malformed entry (${shape.error.issues.map((i) => i.path.join('.')).join(', ')})`);
    const prev = byKey.get(e.key);
    if (prev) problems.push(`duplicate key "${e.key}" (${prev.catalogue}, ${e.catalogue})`);
    else byKey.set(e.key, e);
    if (!PERMISSION_RESOURCE_PATTERN.test(e.resource) || e.resource === CASL_ANY_SUBJECT)
      problems.push(`"${e.key}": resource must match the pattern and not be "${CASL_ANY_SUBJECT}"`);
    if (!PERMISSION_ACTION_PATTERN.test(e.action) || e.action === CASL_ANY_ACTION)
      problems.push(`"${e.key}": action must match the pattern and not be "${CASL_ANY_ACTION}"`);
    if (e.key !== `${e.resource}.${e.action}`)
      problems.push(`"${e.key}": key must equal resource.action ("${e.resource}.${e.action}")`);
    if (e.ownerOnly && (e.grantTo.admin || e.grantTo.member))
      problems.push(`"${e.key}" is ownerOnly but granted to admin or member`);
    if (e.ownerOnly && (e.apiKeyEligible || e.supportEligible))
      problems.push(`"${e.key}" is ownerOnly but eligible for API keys or support`);
  }
  for (const e of byKey.values())
    for (const r of e.requires) {
      const target = byKey.get(r);
      if (!target) problems.push(`"${e.key}" requires unknown "${r}"`);
      else if (r === e.key) problems.push(`"${e.key}" requires itself`);
      else if (!e.deprecated && target.deprecated) problems.push(`"${e.key}" is active but requires deprecated "${r}"`);
    }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (k: string): void => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') {
      problems.push(`requires cycle through "${k}"`);
      return;
    }
    state.set(k, 'visiting');
    for (const r of byKey.get(k)?.requires ?? []) if (byKey.has(r)) visit(r);
    state.set(k, 'done');
  };
  for (const k of byKey.keys()) visit(k);
  for (const role of ['admin', 'member'] as const) {
    const granted = new Set([...byKey.values()].filter((e) => e.grantTo[role] && !e.deprecated).map((e) => e.key));
    for (const k of granted)
      for (const r of byKey.get(k)?.requires ?? [])
        if (!granted.has(r)) problems.push(`grantTo.${role} is not closed: "${k}" requires "${r}"`);
  }
  return problems;
}

/** Catalogue gộp; vi phạm → `CatalogueError` (app không khởi động). */
export function mergeCatalogues(defs: readonly CatalogueDef[]): MergedCatalogue {
  const problems = catalogueProblems(defs);
  if (problems.length) throw new CatalogueError(problems);
  return new Map(entriesOf(defs).map((e) => [e.key, e]));
}
```
`src/modules/tenancy/domain/permission-set.ts`:
```ts
import { UnknownPermissionError, type MergedCatalogue } from './catalogue.js';

/** Đóng tập theo `requires` (PR5); key lạ → lỗi có tên (fail loud, SEC-M10). */
export function closure(keys: Iterable<string>, merged: MergedCatalogue): Set<string> {
  const out = new Set<string>();
  const stack = [...keys];
  while (stack.length) {
    const k = stack.pop();
    if (k === undefined || out.has(k)) continue;
    const e = merged.get(k);
    if (!e) throw new UnknownPermissionError(k);
    out.add(k);
    stack.push(...e.requires);
  }
  return out;
}
export const isSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  [...a].every((k) => b.has(k));
/** Tập con THỰC SỰ (S3-A4: non-owner chỉ tạo/gán/quản lý thứ nhỏ hơn hẳn mình). */
export const isStrictSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size < b.size && isSubset(a, b);
```
`src/modules/tenancy/domain/system-roles.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';
import type { MergedCatalogue } from './catalogue.js';
import { closure } from './permission-set.js';

/**
 * Tập quyền của role hệ thống tính trong code từ catalogue gộp (S3-A5, spec §8.3): OWNER = mọi quyền không deprecated
 * của MỌI catalogue; ADMIN/MEMBER = closure của allow-list `grantTo`, bỏ deprecated. Không lưu ở DB.
 */
export function systemRolePermissions(key: SystemRoleKey, merged: MergedCatalogue): ReadonlySet<string> {
  const active = [...merged.values()].filter((e) => !e.deprecated);
  switch (key) {
    case 'OWNER':
      return new Set(active.map((e) => e.key));
    case 'ADMIN':
      return withoutDeprecated(closure(active.filter((e) => e.grantTo.admin).map((e) => e.key), merged), merged);
    case 'MEMBER':
      return withoutDeprecated(closure(active.filter((e) => e.grantTo.member).map((e) => e.key), merged), merged);
    default: {
      const unknown: never = key;
      throw new Error(`unknown system role ${String(unknown)}`);
    }
  }
}
const withoutDeprecated = (s: Set<string>, merged: MergedCatalogue): ReadonlySet<string> =>
  new Set([...s].filter((k) => merged.get(k)?.deprecated !== true));

/** `A = perms(ADMIN)` của luật 2a (spec §8.4): tính lại mỗi lần gộp catalogue, không lưu. */
export const adminCapability = (merged: MergedCatalogue): ReadonlySet<string> =>
  systemRolePermissions('ADMIN', merged);
```
`src/modules/tenancy/domain/tenancy-catalogue.ts`:
```ts
import { defineCatalogue, type CatalogueEntryDef } from './catalogue.js';

const e = (
  resource: string,
  action: string,
  o: { requires?: readonly string[]; ownerOnly?: boolean; apiKey?: boolean; support?: boolean; admin?: boolean; member?: boolean } = {},
): CatalogueEntryDef => ({
  resource,
  action,
  requires: o.requires ?? [],
  ownerOnly: o.ownerOnly ?? false,
  apiKeyEligible: o.apiKey ?? false,
  supportEligible: o.support ?? false,
  grantTo: { admin: o.admin ?? false, member: o.member ?? false },
});

/**
 * Catalogue v1 của tenancy (spec SP3 §8.2, S3-A26; 19 key). Phải khớp dòng `permissions` do migration `tenancy_core` seed:
 * `CatalogueCheck` (Task 19) chặn khởi động khi lệch. `billing.*` đặt chỗ cho SP5 (`billing.write` ownerOnly, S3-P2);
 * `billing.read` không supportEligible (SEC-M6).
 */
export const TENANCY_CATALOGUE = defineCatalogue('tenancy', {
  'org.read': e('org', 'read', { apiKey: true, support: true, admin: true, member: true }),
  'org.update': e('org', 'update', { requires: ['org.read'], admin: true }),
  'org.delete': e('org', 'delete', { requires: ['org.read'], ownerOnly: true }),
  'org.restore': e('org', 'restore', { requires: ['org.read'], ownerOnly: true }),
  'ownership.transfer': e('ownership', 'transfer', { requires: ['members.read'], ownerOnly: true }),
  'members.read': e('members', 'read', { apiKey: true, support: true, admin: true, member: true }),
  'members.role.assign': e('members', 'role.assign', { requires: ['members.read', 'roles.read'], admin: true }),
  'members.remove': e('members', 'remove', { requires: ['members.read'], admin: true }),
  'roles.read': e('roles', 'read', { apiKey: true, support: true, admin: true, member: true }),
  'roles.write': e('roles', 'write', { requires: ['roles.read'], admin: true }),
  'invitations.read': e('invitations', 'read', { requires: ['roles.read'], support: true, admin: true }),
  'invitations.write': e('invitations', 'write', { requires: ['invitations.read', 'roles.read'], admin: true }),
  'api_keys.read': e('api_keys', 'read', { requires: ['members.read'], admin: true }),
  'api_keys.write_own': e('api_keys', 'write_own', { admin: true }),
  'api_keys.write_all': e('api_keys', 'write_all', { requires: ['api_keys.read', 'members.read'], admin: true }),
  'support_access.read': e('support_access', 'read', { admin: true }),
  'support_access.grant': e('support_access', 'grant', { requires: ['support_access.read', 'members.read'], ownerOnly: true }),
  'billing.read': e('billing', 'read', { requires: ['org.read'], apiKey: true, admin: true }),
  'billing.write': e('billing', 'write', { requires: ['billing.read'], ownerOnly: true }),
});
```
`src/modules/tenancy/application/authz/ability.factory.ts`:
```ts
import { Ability } from '@casl/ability';
import { UnknownPermissionError, type MergedCatalogue } from '../../domain/catalogue.js';

/** Sentinel không trùng action/resource nào (regex bắt đầu bằng [a-z]): `manage`/`all` mất nghĩa wildcard (S3-P6, T1). */
export const NO_WILDCARD = '__no_wildcard__';
export type TenancyAbility = Ability<[string, string]>;

/**
 * `Ability` trần của CASL 7.0.1 dựng theo request từ quyền hiệu lực (spec §8.7): rule lấy thẳng `resource`/`action` của
 * catalogue gộp, không parse chuỗi key; không `conditions`/`fields` (Ability trần ném nếu ai đó thêm); không cache.
 * Key lạ → `UnknownPermissionError` (500, log ERROR); key deprecated bị bỏ (U10).
 */
export function buildAbility(permissions: readonly string[], merged: MergedCatalogue): TenancyAbility {
  const rules = permissions.flatMap((k) => {
    const entry = merged.get(k);
    if (!entry) throw new UnknownPermissionError(k);
    return entry.deprecated ? [] : [{ action: entry.action, subject: entry.resource }];
  });
  return new Ability<[string, string]>(rules, { anyAction: NO_WILDCARD, anySubjectType: NO_WILDCARD });
}
```

- [ ] **Step 4: Chạy**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm typecheck && pnpm arch
```
Expected: PASS; `domain/` không import `http/`/`infra/`/CASL (luật `domain-pure`; CASL chỉ ở `application/authz`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/tenancy/domain src/modules/tenancy/application/authz test/unit/modules/tenancy
git commit -m "feat(tenancy): permission catalogue v1 with boot-time checks, closure and system roles, bare CASL ability"
```

---

### Task 18: Luật chống leo quyền (2, 2a theo tập, 3, 4, 5) và state machine vòng đời org — U11, U15, B-4/5/6/8/9/18

**Files:**
- Create: `src/modules/tenancy/domain/escalation.ts`, `src/modules/tenancy/domain/organization.ts`, `test/unit/modules/tenancy/escalation.spec.ts`, `test/unit/modules/tenancy/organization.spec.ts`

**Interfaces:**
- Consumes: `closure`, `isSubset`, `isStrictSubset` (Task 17), `adminCapability`, `systemRolePermissions`, `MergedCatalogue`, `ORG_NAME_MAX_LENGTH`, `SystemRoleKey`.
- Produces:
  - `type Actor = { memberRef: string; isOwner: boolean; permissions: ReadonlySet<string> }`, `type BindTarget = { systemKey: SystemRoleKey | null; permissions: ReadonlySet<string> }`, `type ManagedMember = { memberRef: string; isOwner: boolean; permissions: ReadonlySet<string> }`.
  - `type EscalationRule = '2' | '2a' | '3' | '4' | '5'`; `type EscalationDecision = { ok: true } | { ok: false; rule: EscalationRule; reason: 'ESCALATION_DENIED' | 'OWNER_ONLY' | 'CANNOT_CHANGE_OWN_ROLE' }`.
  - `dominates(actor, target, merged): boolean`; `isAdminEquivalent(set, merged): boolean`; `assertCanBind(actor, role, merged)`, `assertCanManage(actor, target, merged)`, `assertNotSelf(actor, targetRef)` — đều trả `EscalationDecision` (application đổi sang lỗi HTTP + metric + log).
  - `domain/organization.ts`: `ORG_STATES`, `type OrgState = 'ACTIVE' | 'DELETED'`, `type OrgEvent = 'SOFT_DELETE' | 'RESTORE' | 'PURGE'`, `orgStateOf({ deletedAt })`, `transitionOrg(state, event, { now, purgeAfter }): OrgTransition` với `OrgTransition = { ok: true; to: 'ACTIVE' | 'DELETED' | 'PURGED' } | { ok: false; reason: 'NOT_ACTIVE' | 'NOT_DELETED' | 'GRACE_EXPIRED' | 'NOT_DUE' }`; `orgName` (zod: không khoảng trắng đầu/cuối, 1–`ORG_NAME_MAX_LENGTH` code point — cùng cách đếm với `char_length`).

- [ ] **Step 1: Test luật (fail)**

`test/unit/modules/tenancy/escalation.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { defineCatalogue, mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import {
  assertCanBind,
  assertCanManage,
  assertNotSelf,
  dominates,
  isAdminEquivalent,
  type Actor,
} from '../../../../src/modules/tenancy/domain/escalation.js';
import { closure, isStrictSubset } from '../../../../src/modules/tenancy/domain/permission-set.js';
import { adminCapability, systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import { prng, randomSubset } from './prng.js';

/** Catalogue fixture: `payroll.read` KHÔNG cấp cho admin (luật 2a theo tập, spec §18.3 "X"). */
const merged = mergeCatalogues([
  TENANCY_CATALOGUE,
  defineCatalogue('payroll', { 'payroll.read': { resource: 'payroll', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: false, member: false } } }),
]);
const perms = (k: 'OWNER' | 'ADMIN' | 'MEMBER') => systemRolePermissions(k, merged);
const actor = (k: 'OWNER' | 'ADMIN' | 'MEMBER', ref = `m-${k}`): Actor => ({ memberRef: ref, isOwner: k === 'OWNER', permissions: perms(k) });
const role = (k: 'OWNER' | 'ADMIN' | 'MEMBER') => ({ systemKey: k, permissions: perms(k) });
const managed = (k: 'OWNER' | 'ADMIN' | 'MEMBER', ref = `t-${k}`) => ({ memberRef: ref, isOwner: k === 'OWNER', permissions: perms(k) });
const X: Actor = { memberRef: 'x', isOwner: false, permissions: new Set([...perms('ADMIN'), 'payroll.read']) };
const SEEDS = 200;

describe('binding and managing (spec SP3 §8.4, rules 2, 2a, 3, 4, 5)', () => {
  it('B-4: an ADMIN assigning OWNER → owner_only (rule 5); B-5: an OWNER assigning OWNER → allowed', () => {
    expect(assertCanBind(actor('ADMIN'), role('OWNER'), merged)).toEqual({ ok: false, rule: '5', reason: 'OWNER_ONLY' });
    expect(assertCanBind(actor('OWNER'), role('OWNER'), merged)).toEqual({ ok: true });
  });
  it('B-18: an ADMIN assigning ADMIN → owner_only (rule 2a, S3-P1)', () => {
    expect(assertCanBind(actor('ADMIN'), role('ADMIN'), merged)).toEqual({ ok: false, rule: '2a', reason: 'OWNER_ONLY' });
  });
  it('an ADMIN may assign MEMBER; a MEMBER may not assign MEMBER (not strictly smaller, S3-A4)', () => {
    expect(assertCanBind(actor('ADMIN'), role('MEMBER'), merged)).toEqual({ ok: true });
    expect(assertCanBind(actor('MEMBER'), role('MEMBER'), merged)).toEqual({ ok: false, rule: '2', reason: 'ESCALATION_DENIED' });
  });
  it('B-6: nobody changes their own role, owners included (rule 3)', () => {
    for (const k of ['OWNER', 'ADMIN', 'MEMBER'] as const)
      expect(assertNotSelf(actor(k, 'same'), 'same')).toEqual({ ok: false, rule: '3', reason: 'CANNOT_CHANGE_OWN_ROLE' });
    expect(assertNotSelf(actor('ADMIN', 'a'), 'b')).toEqual({ ok: true });
  });
  it('B-8: an ADMIN managing another ADMIN → owner_only; B-9: an ADMIN managing an OWNER → owner_only', () => {
    expect(assertCanManage(actor('ADMIN'), managed('ADMIN'), merged)).toEqual({ ok: false, rule: '2a', reason: 'OWNER_ONLY' });
    expect(assertCanManage(actor('ADMIN'), managed('OWNER'), merged)).toEqual({ ok: false, rule: '5', reason: 'OWNER_ONLY' });
  });
  it('an OWNER manages another OWNER (two owners may demote each other, O-4); an ADMIN manages a MEMBER; a MEMBER manages nobody (rule 4)', () => {
    expect(assertCanManage(actor('OWNER'), managed('OWNER'), merged)).toEqual({ ok: true });
    expect(assertCanManage(actor('ADMIN'), managed('MEMBER'), merged)).toEqual({ ok: true });
    expect(assertCanManage(actor('MEMBER'), managed('MEMBER'), merged)).toEqual({ ok: false, rule: '4', reason: 'ESCALATION_DENIED' });
  });
  it('rule 2a is about capability, not labels: X = ADMIN ∪ {payroll.read} strictly dominates ADMIN but is still refused (B-22)', () => {
    expect(dominates(X, perms('ADMIN'), merged)).toBe(true);
    expect(assertCanBind(X, role('ADMIN'), merged)).toEqual({ ok: false, rule: '2a', reason: 'OWNER_ONLY' });
    expect(assertCanManage(X, managed('ADMIN'), merged)).toEqual({ ok: false, rule: '2a', reason: 'OWNER_ONLY' });
  });
  it(`U15 (generator, ${SEEDS} seeds): any target set ⊇ A is refused to every non-owner and allowed to an owner`, () => {
    const A = adminCapability(merged);
    const keys = [...merged.keys()];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = prng(seed);
      const extra = randomSubset(keys, rnd);
      const containsA = rnd() < 0.5;
      const target = new Set(containsA ? [...A, ...extra] : extra);
      const nonOwner: Actor = { memberRef: 'n', isOwner: false, permissions: new Set(randomSubset(keys, rnd)) };
      const adminEq = isAdminEquivalent(target, merged);
      // Review M3: khẳng định độc lập với định nghĩa của `isAdminEquivalent` (không viết lại nó): tập dựng từ A luôn tương
      // đương admin, nên nhánh từ chối bên dưới chắc chắn được chạy ở khoảng một nửa số seed.
      if (containsA) expect(adminEq, `seed ${seed}`).toBe(true);
      const bind = assertCanBind(nonOwner, { systemKey: null, permissions: target }, merged);
      const manage = assertCanManage(nonOwner, { memberRef: 't', isOwner: false, permissions: target }, merged);
      if (adminEq) {
        expect(bind, `seed ${seed}`).toMatchObject({ ok: false, reason: 'OWNER_ONLY' });
        expect(manage, `seed ${seed}`).toMatchObject({ ok: false, reason: 'OWNER_ONLY' });
      }
      expect(assertCanBind(actor('OWNER'), { systemKey: null, permissions: target }, merged), `seed ${seed}`).toEqual({ ok: true });
    }
  });
  it(`U11 (generator, ${SEEDS} seeds): isStrictSubset on closures matches the naive definition`, () => {
    const keys = [...merged.keys()];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = prng(seed);
      const s = closure(randomSubset(keys, rnd), merged);
      const t = closure(randomSubset(keys, rnd), merged);
      const naive = [...s].every((k) => t.has(k)) && [...t].some((k) => !s.has(k));
      expect(isStrictSubset(s, t), `seed ${seed}`).toBe(naive);
    }
  });
});
```
`test/unit/modules/tenancy/organization.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ORG_NAME_MAX_LENGTH } from '../../../../src/modules/tenancy/constants.js';
import { orgName, orgStateOf, transitionOrg } from '../../../../src/modules/tenancy/domain/organization.js';

const now = new Date('2026-10-01T00:00:00Z');
const past = new Date('2026-09-30T00:00:00Z');
const future = new Date('2026-10-02T00:00:00Z');

describe('organization lifecycle (spec SP3 §9.4): every (state × event) pair', () => {
  it.each([
    ['ACTIVE', 'SOFT_DELETE', null, { ok: true, to: 'DELETED' }],
    ['ACTIVE', 'RESTORE', null, { ok: false, reason: 'NOT_DELETED' }],
    ['ACTIVE', 'PURGE', null, { ok: false, reason: 'NOT_DELETED' }],
    ['DELETED', 'SOFT_DELETE', future, { ok: false, reason: 'NOT_ACTIVE' }],
    ['DELETED', 'RESTORE', future, { ok: true, to: 'ACTIVE' }],
    ['DELETED', 'RESTORE', past, { ok: false, reason: 'GRACE_EXPIRED' }],
    ['DELETED', 'RESTORE', now, { ok: false, reason: 'GRACE_EXPIRED' }],
    ['DELETED', 'PURGE', past, { ok: true, to: 'PURGED' }],
    ['DELETED', 'PURGE', now, { ok: true, to: 'PURGED' }],
    ['DELETED', 'PURGE', future, { ok: false, reason: 'NOT_DUE' }],
  ] as const)('%s + %s (purgeAfter %s)', (state, event, purgeAfter, expected) => {
    expect(transitionOrg(state, event, { now, purgeAfter })).toEqual(expected);
  });
  it('a DELETED org without purgeAfter is a data error (CHECK makes it impossible), never a silent answer', () => {
    expect(() => transitionOrg('DELETED', 'RESTORE', { now, purgeAfter: null })).toThrow(/purge_after/);
  });
  it('orgStateOf reads deleted_at', () => {
    expect([orgStateOf({ deletedAt: null }), orgStateOf({ deletedAt: past })]).toEqual(['ACTIVE', 'DELETED']);
  });
});

describe('orgName (Review Focus 1: counted in code points like char_length)', () => {
  it.each([
    ['Acme', true],
    ['😀'.repeat(ORG_NAME_MAX_LENGTH), true],
    ['😀'.repeat(ORG_NAME_MAX_LENGTH + 1), false],
    ['', false],
    [' Acme', false],
    ['Acme ', false],
    ['\tAcme', false],
  ])('%j → %s', (name, ok) => {
    expect(orgName.safeParse(name).success).toBe(ok);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/escalation.spec.ts test/unit/modules/tenancy/organization.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Cài đặt**

`src/modules/tenancy/domain/escalation.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';
import type { MergedCatalogue } from './catalogue.js';
import { closure, isStrictSubset, isSubset } from './permission-set.js';
import { adminCapability } from './system-roles.js';

export type Actor = { memberRef: string; isOwner: boolean; permissions: ReadonlySet<string> };
export type BindTarget = { systemKey: SystemRoleKey | null; permissions: ReadonlySet<string> };
export type ManagedMember = { memberRef: string; isOwner: boolean; permissions: ReadonlySet<string> };
export type EscalationRule = '2' | '2a' | '3' | '4' | '5';
export type EscalationDecision =
  | { ok: true }
  | { ok: false; rule: EscalationRule; reason: 'ESCALATION_DENIED' | 'OWNER_ONLY' | 'CANNOT_CHANGE_OWN_ROLE' };

const ALLOWED: EscalationDecision = { ok: true };

/** `dominates(actor, S)` ≔ actor là OWNER hoặc `perms(S) ⊊ perms(actor)` (spec §8.4, S3-A4): so tập, không theo hạng. */
export function dominates(actor: Actor, target: ReadonlySet<string>, merged: MergedCatalogue): boolean {
  return actor.isOwner || isStrictSubset(closure(target, merged), closure(actor.permissions, merged));
}

/** Luật 2a (S3-A41): tương đương admin về NĂNG LỰC khi closure của tập chứa toàn bộ `A = perms(ADMIN)`. */
export const isAdminEquivalent = (s: ReadonlySet<string>, merged: MergedCatalogue): boolean =>
  isSubset(adminCapability(merged), closure(s, merged));

/** Luật 2 + 2a(iv) + 5 cho MỌI đường gán role (PR4): đổi role (3A); lời mời, link (3C); dùng lại, không viết lại. */
export function assertCanBind(actor: Actor, role: BindTarget, merged: MergedCatalogue): EscalationDecision {
  if (role.systemKey === 'OWNER' && !actor.isOwner) return { ok: false, rule: '5', reason: 'OWNER_ONLY' };
  if (!actor.isOwner && isAdminEquivalent(role.permissions, merged)) return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, role.permissions, merged)) return { ok: false, rule: '2', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/** Luật 4 + 2a(v) + 5: quản lý người khác (đổi role, xoá khỏi org; thu hồi key của họ ở 3D) so với quyền HIỆN TẠI của họ. */
export function assertCanManage(actor: Actor, target: ManagedMember, merged: MergedCatalogue): EscalationDecision {
  if (target.isOwner && !actor.isOwner) return { ok: false, rule: '5', reason: 'OWNER_ONLY' };
  if (!actor.isOwner && isAdminEquivalent(target.permissions, merged)) return { ok: false, rule: '2a', reason: 'OWNER_ONLY' };
  if (!dominates(actor, target.permissions, merged)) return { ok: false, rule: '4', reason: 'ESCALATION_DENIED' };
  return ALLOWED;
}

/** Luật 3 (PR11): không tự đổi role của mình, kể cả owner (owner xuống quyền chỉ qua chuyển quyền sở hữu, 3C). */
export function assertNotSelf(actor: Actor, targetRef: string): EscalationDecision {
  return actor.memberRef === targetRef ? { ok: false, rule: '3', reason: 'CANNOT_CHANGE_OWN_ROLE' } : ALLOWED;
}
```
`src/modules/tenancy/domain/organization.ts`:
```ts
import { z } from 'zod';
import { ORG_NAME_MAX_LENGTH } from '../constants.js';

export const ORG_STATES = ['ACTIVE', 'DELETED'] as const;
export type OrgState = (typeof ORG_STATES)[number];
export type OrgEvent = 'SOFT_DELETE' | 'RESTORE' | 'PURGE';
export type OrgTransition =
  | { ok: true; to: 'ACTIVE' | 'DELETED' | 'PURGED' }
  | { ok: false; reason: 'NOT_ACTIVE' | 'NOT_DELETED' | 'GRACE_EXPIRED' | 'NOT_DUE' };

/** DB giữ hai cột thời gian có CHECK (không cột trạng thái trùng thông tin); domain suy trạng thái. */
export const orgStateOf = (row: { deletedAt: Date | null }): OrgState => (row.deletedAt === null ? 'ACTIVE' : 'DELETED');

/**
 * Spec §9.4: `now` là `clock_timestamp()` đọc SAU khi đã khoá dòng org (spec §3.15, T-13, T-29), không `now()` của
 * transaction. Khôi phục đúng lúc `purge_after` là quá hạn (so `>`), xoá cứng đúng lúc đó là tới hạn (`<=`).
 */
export function transitionOrg(state: OrgState, event: OrgEvent, ctx: { now: Date; purgeAfter: Date | null }): OrgTransition {
  switch (state) {
    case 'ACTIVE':
      switch (event) {
        case 'SOFT_DELETE':
          return { ok: true, to: 'DELETED' };
        case 'RESTORE':
        case 'PURGE':
          return { ok: false, reason: 'NOT_DELETED' };
        default:
          return unknownEvent(event);
      }
    case 'DELETED': {
      if (ctx.purgeAfter === null) throw new Error('a DELETED organization must have purge_after (organizations_deleted_pair_ck)');
      const due = ctx.purgeAfter.getTime() <= ctx.now.getTime();
      switch (event) {
        case 'SOFT_DELETE':
          return { ok: false, reason: 'NOT_ACTIVE' };
        case 'RESTORE':
          return due ? { ok: false, reason: 'GRACE_EXPIRED' } : { ok: true, to: 'ACTIVE' };
        case 'PURGE':
          return due ? { ok: true, to: 'PURGED' } : { ok: false, reason: 'NOT_DUE' };
        default:
          return unknownEvent(event);
      }
    }
    default: {
      const unknown: never = state;
      throw new Error(`unknown organization state ${String(unknown)}`);
    }
  }
}
function unknownEvent(event: never): never {
  throw new Error(`unknown organization event ${String(event)}`);
}

/**
 * Tên org: không khoảng trắng đầu/cuối (chặt hơn `btrim` của CHECK: cả NBSP, tab), 1–`ORG_NAME_MAX_LENGTH` CODE POINT
 * (cùng cách đếm với `char_length` của CHECK `organizations_name_ck`; `z.string().max` đếm UTF-16 sẽ từ chối tên
 * emoji mà DB nhận — Review Focus 1).
 */
export const orgName = z
  .string()
  .refine((s) => s === s.trim(), 'must not start or end with whitespace')
  .refine((s) => {
    const n = [...s].length;
    return n >= 1 && n <= ORG_NAME_MAX_LENGTH;
  }, `must be 1 to ${ORG_NAME_MAX_LENGTH} characters`);
```

- [ ] **Step 3: Chạy**

Run: `pnpm vitest run --project unit test/unit/modules/tenancy`
Expected: PASS (U11, U15 với 200 seed; mọi cặp trạng thái × sự kiện).

- [ ] **Step 4: Commit**

```bash
git add src/modules/tenancy/domain test/unit/modules/tenancy
git commit -m "feat(tenancy): set-based escalation rules (2, 2a, 3, 4, 5) and the organization lifecycle state machine"
```

---

## Phần F — Module tenancy: khung, pipeline HTTP và API (spec §7, §8.5–§8.8, §9, §12–§16)

### Task 19: Khung module tenancy — config, lỗi, event, telemetry, hai registry Discovery, `CatalogueCheck`, luật kiến trúc 17–19

**Files:**
- Create: `src/modules/tenancy/tenancy.config.ts`, `src/modules/tenancy/errors.ts`, `src/modules/tenancy/events.ts`, `src/modules/tenancy/tenancy-telemetry.ts`, `src/modules/tenancy/application/tenancy-metrics.ts`, `src/modules/tenancy/application/permission-catalogue.registry.ts`, `src/modules/tenancy/application/org-purge-participant.registry.ts`, `src/modules/tenancy/application/catalogue-check.ts`, `src/modules/tenancy/ports/org-purge-participant.ts`, `src/modules/tenancy/ports/catalogue-reader.ts`, `src/modules/tenancy/ports/tenancy-test-hooks.ts`, `src/modules/tenancy/infra/sql/sql-catalogue.reader.ts`, `src/modules/tenancy/tenancy.module.ts`, `src/modules/tenancy/index.ts`
- Create (test): `test/support/tenancy-core-app.ts`, `test/unit/modules/tenancy/tenancy-config.spec.ts`, `test/unit/modules/tenancy/errors.spec.ts`, `test/unit/modules/tenancy/catalogue-diff.spec.ts`, `test/unit/modules/tenancy/registries.spec.ts`, `test/integration/tenancy/catalogue-check.spec.ts`, `test/architecture/fixtures/src/modules/billing/infra/uses-casl.ts`, `test/architecture/fixtures/src/modules/identity/http/uses-tenancy.ts`, `test/architecture/fixtures/src/modules/tenancy/index.ts`, `test/architecture/fixtures/src/modules/tenancy/ports/tenancy-test-hooks.ts`, `test/architecture/fixtures/src/features/x/uses-tenancy-test-hooks.ts`
- Modify: `src/app.modules.ts`, `src/scripts/gen-env-example.ts`, `.dependency-cruiser.cjs`, `test/unit/architecture/rules.spec.ts`, `.env.example` (sinh lại)

**Interfaces:**
- Consumes: `defineConfig`, `defineProductionRule`, `isValidCron`, `normalizeTimezone`, `defineErrorCodes`, `defineConstraintErrors`, `defineEvent`, `Db` (SP1); `CatalogueDef`, `MergedCatalogue`, `mergeCatalogues`, `TENANCY_CATALOGUE` (Task 17); `DEFINER_LIMIT_MAX` (Task 15).
- Produces:
  - `tenancyConfig` (namespace `tenancy`), `type TenancyConfig = ConfigOf<typeof tenancyConfig>` với khoá `membershipMode: 'multi' | 'single'`, `orgCreation: 'self_service' | 'platform_admin'`, `maxOrgsCreatedPerUser`, `orgDeleteGraceSec`, `purgeCron`, `purgeTz`, `purgeBatchSize`, `purgeMaxBatches`, `orgMissLimit`, `orgMissTtlMs`; luật production `tenancy-org-delete-grace`, `tenancy-org-miss-not-looser`.
  - `TenancyErrors.{ESCALATION_DENIED, OWNER_ONLY, CANNOT_CHANGE_OWN_ROLE, API_KEY_NOT_ORG_SCOPED, ORG_CREATION_DISABLED, LAST_OWNER, ALREADY_MEMBER, ALREADY_IN_AN_ORG, SYSTEM_ROLE_IMMUTABLE, ORG_NOT_DELETED, ORG_LIMIT_REACHED}`; constraint map `org_members_last_owner_ck`/`organizations_restore_owner_ck` → `last_owner`, `org_members_org_user_uq` → `already_member`, `org_roles_system_immutable` → `system_role_immutable`.
  - Event (`events.ts`): `OrgCreatedEvent`, `OrgUpdatedEvent`, `OrgDeletedEvent`, `OrgRestoredEvent`, `OrgPurgedEvent`, `MemberAddedEvent`, `MemberRoleChangedEvent`, `MemberRemovedEvent` (type/data đúng spec §14).
  - `TENANCY_TRACER`, `TENANCY_METER`, `tenancySpan<T>(name, fn, attrsOf?)`; `TenancyMetrics` với `orgAccess{via,result}`, `orgContextDuration` (histogram, giây), `policyDenied{reason}`, `escalationDenied{rule}`, `lastOwnerBlocked{path}`, `orgPurge{result}`, `orgPurgeFailed`, `catalogueMismatch`.
  - `PermissionCatalogueContributor` (Discovery decorator, tham số `CatalogueDef`), `PermissionCatalogueRegistry.merged(): MergedCatalogue`, `.has(def: CatalogueDef): boolean`.
  - `abstract class OrgPurgeParticipant { abstract purge(orgId: string): Promise<void> }`, `OrgPurgeParticipantContributor({ key, order })`, `OrgPurgeParticipantRegistry.participants(): readonly RegisteredParticipant[]` (`{ key; order; participant }`, sắp theo `order` rồi `key`).
  - `abstract class TenancyTestHooks { afterGuard(): Promise<void>; beforeRelease(authUserId: string, orgId: string): Promise<void> }` + `NoopTenancyTestHooks` (mặc định); test thay bằng `overrideProvider` (Task 22 thêm `configure`).
  - `catalogueDiff(merged, rows: readonly CatalogueRow[]): string[]`; `CatalogueCheck` (`onApplicationBootstrap`, api + worker) — lệch → metric + log ERROR + ném (app không khởi động).
  - `@Global() TenancyCoreModule` (registry, metric, `CatalogueCheck`, `TenancyTestHooks`); `TenancyModule.forApi()`, `.forWorker()` (Task 20/22/25 bổ sung provider riêng từng process).
  - Luật depcruise `casl-only-in-tenancy-authz-or-http` (17), `identity-notifications-independent-of-tenancy` (18), `tenancy-test-hooks-only-in-tenancy` (19).

- [ ] **Step 1: Test config, lỗi, diff catalogue (fail)**

`test/unit/modules/tenancy/tenancy-config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { tenancyConfig } from '../../../../src/modules/tenancy/tenancy.config.js';

const parse = (env: Record<string, unknown>) => tenancyConfig.schema.safeParse(env);
const rule = (name: string) => {
  const r = productionRuleRegistry().find((x) => x.name === name);
  if (!r) throw new Error(`production rule ${name} is not registered`);
  return r.rule;
};

describe('tenancy config (spec SP3 §13, INT-I12)', () => {
  it('defaults boot with no env at all', () => {
    expect(parse({}).data).toEqual({
      membershipMode: 'multi',
      orgCreation: 'self_service',
      maxOrgsCreatedPerUser: 5,
      orgDeleteGraceSec: 2_592_000,
      purgeCron: '0 3 * * *',
      purgeTz: 'UTC',
      purgeBatchSize: 50,
      purgeMaxBatches: 10,
      orgMissLimit: 30,
      orgMissTtlMs: 60_000,
    });
  });
  it.each([
    [{ membershipMode: 'solo' }],
    [{ orgCreation: 'anyone' }],
    [{ maxOrgsCreatedPerUser: '0' }],
    [{ maxOrgsCreatedPerUser: '1001' }],
    [{ orgDeleteGraceSec: '86399' }],
    [{ orgDeleteGraceSec: '31536001' }],
    [{ purgeCron: 'not a cron' }],
    [{ purgeTz: 'Mars/Olympus' }],
    [{ purgeBatchSize: '1001' }],
    [{ purgeMaxBatches: '0' }],
    [{ orgMissLimit: '0' }],
    [{ orgMissTtlMs: '1500' }],
  ])('rejects %j', (env) => {
    expect(parse(env).success).toBe(false);
  });
  it('production: grace must be at least 7 days', () => {
    const r = rule('tenancy-org-delete-grace');
    expect(r({ tenancy: { orgDeleteGraceSec: 604_799 } })).toMatch(/TENANCY_ORG_DELETE_GRACE_SEC/);
    expect(r({ tenancy: { orgDeleteGraceSec: 604_800 } })).toBeUndefined();
  });
  it('production: the org-miss limiter is never looser than the default throttler (count and window)', () => {
    const r = rule('tenancy-org-miss-not-looser');
    const throttle = { limit: 300, ttlMs: 60_000 };
    expect(r({ throttle, tenancy: { orgMissLimit: 30, orgMissTtlMs: 60_000 } })).toBeUndefined();
    expect(r({ throttle, tenancy: { orgMissLimit: 301, orgMissTtlMs: 60_000 } })).toMatch(/TENANCY_ORG_MISS_RATE_LIMIT/);
    expect(r({ throttle, tenancy: { orgMissLimit: 30, orgMissTtlMs: 10_000 } })).toMatch(/TENANCY_ORG_MISS_RATE_TTL_MS/);
    expect(r({ tenancy: { orgMissLimit: 30, orgMissTtlMs: 60_000 } })).toMatch(/needs the throttle and tenancy namespaces/);
  });
});
```
`test/unit/modules/tenancy/errors.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dbErrorMapper } from '../../../../src/core/database/index.js';
import { TenancyErrors } from '../../../../src/modules/tenancy/errors.js';

/** Lỗi pg thô như lúc COMMIT (trigger hoãn), có `code` + `constraint`. */
const pgError = (code: string, constraint: string): Error =>
  Object.assign(new Error('violation'), { code, constraint });

describe('tenancy constraint errors (spec SP3 §15)', () => {
  it.each([
    ['23514', 'org_members_last_owner_ck', TenancyErrors.LAST_OWNER],
    ['23514', 'organizations_restore_owner_ck', TenancyErrors.LAST_OWNER],
    ['23505', 'org_members_org_user_uq', TenancyErrors.ALREADY_MEMBER],
    ['23514', 'org_roles_system_immutable', TenancyErrors.SYSTEM_ROLE_IMMUTABLE],
  ])('%s %s → %s', (code, constraint, expected) => {
    expect(dbErrorMapper(pgError(code, constraint))?.error).toBe(expected);
  });
  it('codes are the lower-case keys with the spec statuses', () => {
    expect([TenancyErrors.LAST_OWNER.code, TenancyErrors.LAST_OWNER.status]).toEqual(['last_owner', 409]);
    expect([TenancyErrors.OWNER_ONLY.code, TenancyErrors.OWNER_ONLY.status]).toEqual(['owner_only', 403]);
    expect([TenancyErrors.ORG_LIMIT_REACHED.code, TenancyErrors.ORG_LIMIT_REACHED.status]).toEqual(['org_limit_reached', 422]);
  });
});
```
`test/unit/modules/tenancy/catalogue-diff.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { catalogueDiff } from '../../../../src/modules/tenancy/application/catalogue-check.js';
import { mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import type { CatalogueRow } from '../../../../src/modules/tenancy/ports/catalogue-reader.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);
const rowsFromCode = (): CatalogueRow[] =>
  [...merged.values()].map((e) => ({
    key: e.key,
    resource: e.resource,
    action: e.action,
    ownerOnly: e.ownerOnly,
    apiKeyEligible: e.apiKeyEligible,
    supportEligible: e.supportEligible,
    deprecated: e.deprecated,
    requires: [...e.requires].sort(),
  }));

describe('catalogueDiff (spec SP3 §8.8)', () => {
  it('identical catalogue and rows → no difference', () => {
    expect(catalogueDiff(merged, rowsFromCode())).toEqual([]);
  });
  it('lists every difference by key and field', () => {
    const rows = rowsFromCode()
      .filter((r) => r.key !== 'billing.write')
      .map((r) => (r.key === 'org.read' ? { ...r, supportEligible: false } : r))
      .map((r) => (r.key === 'roles.write' ? { ...r, requires: [] } : r));
    rows.push({ key: 'ghost.read', resource: 'ghost', action: 'read', ownerOnly: false, apiKeyEligible: false, supportEligible: false, deprecated: false, requires: [] });
    expect(catalogueDiff(merged, rows)).toEqual([
      'billing.write: in code, missing in the database',
      'ghost.read: in the database, missing in code',
      'org.read: supportEligible code=true db=false',
      'roles.write: requires code=[roles.read] db=[]',
    ]);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/tenancy-config.spec.ts test/unit/modules/tenancy/errors.spec.ts test/unit/modules/tenancy/catalogue-diff.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Config, lỗi, event, telemetry, metric**

`src/modules/tenancy/tenancy.config.ts`:
```ts
import { z } from 'zod';
import { type ConfigOf, defineConfig, defineProductionRule } from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { DEFINER_LIMIT_MAX } from './constants.js';

const MS_PER_SEC = 1000;
const SECONDS_PER_DAY = 86_400;
const MIN_GRACE_SEC = SECONDS_PER_DAY;
const MAX_GRACE_SEC = 365 * SECONDS_PER_DAY;
/** Spec SP3 §13: production giữ org xoá mềm ít nhất 7 ngày trước khi xoá cứng. */
const PRODUCTION_MIN_GRACE_SEC = 7 * SECONDS_PER_DAY;
const MAX_ORGS_PER_USER = 1000;

export const TENANCY_MEMBERSHIP_MODES = ['multi', 'single'] as const;
export const TENANCY_ORG_CREATION_MODES = ['self_service', 'platform_admin'] as const;

const positiveInt = z.coerce.number().int().positive();
// rate-limiter-flexible đếm cửa sổ theo giây nguyên (quy ước `throttle.config.ts`, INT-M6).
const windowMs = positiveInt.multipleOf(MS_PER_SEC);
const cron = z.string().min(1).refine(isValidCron, 'must be a valid cron expression');
const timezone = z.string().min(1).refine((tz) => normalizeTimezone(tz) !== undefined, 'must be an IANA timezone name');

export const tenancyConfig = defineConfig(
  'tenancy',
  {
    membershipMode: 'TENANCY_MEMBERSHIP_MODE',
    orgCreation: 'TENANCY_ORG_CREATION',
    maxOrgsCreatedPerUser: 'TENANCY_MAX_ORGS_CREATED_PER_USER',
    orgDeleteGraceSec: 'TENANCY_ORG_DELETE_GRACE_SEC',
    purgeCron: 'TENANCY_ORG_PURGE_CRON',
    purgeTz: 'TENANCY_ORG_PURGE_TZ',
    purgeBatchSize: 'TENANCY_ORG_PURGE_BATCH_SIZE',
    purgeMaxBatches: 'TENANCY_ORG_PURGE_MAX_BATCHES',
    orgMissLimit: 'TENANCY_ORG_MISS_RATE_LIMIT',
    orgMissTtlMs: 'TENANCY_ORG_MISS_RATE_TTL_MS',
  },
  z.object({
    membershipMode: z
      .enum(TENANCY_MEMBERSHIP_MODES)
      .default('multi')
      .describe('multi: a user may belong to many organizations; single: at most one (applies to new joins only)'),
    orgCreation: z
      .enum(TENANCY_ORG_CREATION_MODES)
      .default('self_service')
      .describe('Who may create organizations: any verified user, or platform admins only'),
    maxOrgsCreatedPerUser: positiveInt
      .max(MAX_ORGS_PER_USER)
      .default(5)
      .describe('Organizations one user may have created (soft-deleted ones count until purged)'),
    orgDeleteGraceSec: positiveInt
      .min(MIN_GRACE_SEC)
      .max(MAX_GRACE_SEC)
      .default(2_592_000)
      .describe('Seconds a soft-deleted organization can be restored before it is purged (production: at least 604800)'),
    purgeCron: cron.default('0 3 * * *').describe('Cron of tenancy.orgs.purge'),
    purgeTz: timezone.default('UTC').describe('Timezone of the purge cron'),
    purgeBatchSize: positiveInt.max(DEFINER_LIMIT_MAX).default(50).describe('Organizations enqueued per purge batch'),
    purgeMaxBatches: positiveInt.max(DEFINER_LIMIT_MAX).default(10).describe('Max purge batches per cron run'),
    orgMissLimit: positiveInt
      .default(30)
      .describe('Real organization misses (404) per window per principal before it is blocked (429)'),
    orgMissTtlMs: windowMs.default(60_000).describe('Organization miss window and block duration (ms, whole seconds)'),
  }),
);
export type TenancyConfig = ConfigOf<typeof tenancyConfig>;

defineProductionRule('tenancy-org-delete-grace', (c) => {
  const grace = c.tenancy?.orgDeleteGraceSec;
  if (typeof grace !== 'number') return 'tenancy grace rule needs the tenancy namespace';
  return grace >= PRODUCTION_MIN_GRACE_SEC
    ? undefined
    : `TENANCY_ORG_DELETE_GRACE_SEC must be at least ${PRODUCTION_MIN_GRACE_SEC} in production`;
});
/** Cùng kiểu `throttle-pre-auth-not-looser` (S2-R53 N2): so cả số lượng lẫn cửa sổ. */
defineProductionRule('tenancy-org-miss-not-looser', (c) => {
  const t = c.throttle;
  const n = c.tenancy;
  if (
    typeof t?.limit !== 'number' ||
    typeof t.ttlMs !== 'number' ||
    typeof n?.orgMissLimit !== 'number' ||
    typeof n.orgMissTtlMs !== 'number'
  )
    return 'tenancy org-miss rule needs the throttle and tenancy namespaces';
  if (n.orgMissLimit > t.limit) return 'TENANCY_ORG_MISS_RATE_LIMIT must be at most THROTTLE_DEFAULT_LIMIT in production';
  if (n.orgMissTtlMs < t.ttlMs) return 'TENANCY_ORG_MISS_RATE_TTL_MS must be at least THROTTLE_DEFAULT_TTL_MS in production';
  return undefined;
});
```
`src/modules/tenancy/errors.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import { defineErrorCodes } from '../../core/errors/index.js';

/** Mã do tenancy sở hữu (spec SP3 §15, cột "Chủ" = tenancy). Mã của core/identity không định nghĩa lại ở đây. */
export const TenancyErrors = defineErrorCodes({
  ESCALATION_DENIED: { status: HttpStatus.FORBIDDEN, title: 'You cannot grant or manage permissions you do not hold' },
  OWNER_ONLY: { status: HttpStatus.FORBIDDEN, title: 'Only an owner can do this' },
  CANNOT_CHANGE_OWN_ROLE: { status: HttpStatus.FORBIDDEN, title: 'You cannot change your own role' },
  API_KEY_NOT_ORG_SCOPED: { status: HttpStatus.FORBIDDEN, title: 'This API key cannot be used on organization routes' },
  ORG_CREATION_DISABLED: { status: HttpStatus.FORBIDDEN, title: 'Organization creation is disabled' },
  LAST_OWNER: { status: HttpStatus.CONFLICT, title: 'An organization must keep at least one owner' },
  ALREADY_MEMBER: { status: HttpStatus.CONFLICT, title: 'User is already a member of this organization' },
  ALREADY_IN_AN_ORG: { status: HttpStatus.CONFLICT, title: 'User already belongs to an organization' },
  SYSTEM_ROLE_IMMUTABLE: { status: HttpStatus.CONFLICT, title: 'System roles cannot be changed' },
  ORG_NOT_DELETED: { status: HttpStatus.CONFLICT, title: 'Organization is not deleted' },
  ORG_LIMIT_REACHED: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Organization limit reached' },
});

/** Tên constraint/trigger (migration `tenancy_core`) → mã; tên không bao giờ ra client. */
defineConstraintErrors({
  org_members_last_owner_ck: TenancyErrors.LAST_OWNER,
  organizations_restore_owner_ck: TenancyErrors.LAST_OWNER,
  org_members_org_user_uq: TenancyErrors.ALREADY_MEMBER,
  org_roles_system_immutable: TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
});
```
`src/modules/tenancy/events.ts`:
```ts
import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';

/**
 * Event của 3A (spec SP3 §14): chỉ id công khai, không email/token/tên người. `userId` là `tenancy_users.public_id`
 * (INT-I14); org của event là org của context (EventPublisher), không có trong `data` ngoài `orgId` tường minh.
 */
const id = z.uuid();
export const OrgCreatedEvent = defineEvent({ type: 'tenancy.org.created', version: 1, schema: z.object({ orgId: id, createdByUserId: id }) });
export const OrgUpdatedEvent = defineEvent({
  type: 'tenancy.org.updated',
  version: 1,
  schema: z.object({ orgId: id, changed: z.array(z.enum(['name'])).min(1) }),
});
export const OrgDeletedEvent = defineEvent({ type: 'tenancy.org.deleted', version: 1, schema: z.object({ orgId: id, purgeAfter: z.iso.datetime() }) });
export const OrgRestoredEvent = defineEvent({ type: 'tenancy.org.restored', version: 1, schema: z.object({ orgId: id }) });
export const OrgPurgedEvent = defineEvent({ type: 'tenancy.org.purged', version: 1, schema: z.object({ orgId: id }) });
export const MemberAddedEvent = defineEvent({
  type: 'tenancy.member.added',
  version: 1,
  schema: z.object({
    memberId: id,
    userId: id,
    roleId: id,
    source: z.enum(['CREATOR', 'INVITATION', 'INVITE_LINK']),
    invitationId: id.optional(),
    inviteLinkId: id.optional(),
  }),
});
export const MemberRoleChangedEvent = defineEvent({
  type: 'tenancy.member.role_changed',
  version: 1,
  schema: z.object({ memberId: id, userId: id, fromRoleId: id, toRoleId: id, reason: z.enum(['ASSIGNED', 'OWNERSHIP_TRANSFER']) }),
});
export const MemberRemovedEvent = defineEvent({
  type: 'tenancy.member.removed',
  version: 1,
  schema: z.object({ memberId: id, userId: id, roleId: id, reason: z.enum(['REMOVED', 'LEFT', 'ACCOUNT_DELETED']) }),
});
```
`src/modules/tenancy/tenancy-telemetry.ts`:
```ts
import { trace, type Attributes } from '@opentelemetry/api';
import { AppError } from '../../core/errors/index.js';

export const TENANCY_METER = 'tenancy';
export const TENANCY_TRACER = 'tenancy';

/**
 * Span con của span đang active (spec SP3 §16). Attribute chỉ là enum hữu hạn (không org, user, email, token); lỗi chỉ
 * ghi tên class và mã `AppError`, không message/stack (cùng luật S2-R30 của identity).
 */
export async function tenancySpan<T>(name: string, fn: () => Promise<T>, attrsOf?: (result: T) => Attributes): Promise<T> {
  return trace.getTracer(TENANCY_TRACER).startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      if (attrsOf) span.setAttributes(attrsOf(result));
      return result;
    } catch (err) {
      const type = err instanceof Error ? err.constructor.name : typeof err;
      const code = err instanceof AppError ? err.error.code : undefined;
      span.recordException(code ? { name: type, code } : { name: type });
      span.setAttributes(code ? { 'error.type': type, 'tenancy.error_code': code } : { 'error.type': type });
      throw err;
    } finally {
      span.end();
    }
  });
}
```
`src/modules/tenancy/application/tenancy-metrics.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { TENANCY_METER } from '../tenancy-telemetry.js';

export type OrgAccessResult = 'granted' | 'not_found' | 'rate_limited' | 'user_key_rejected' | 'unavailable';
export type LastOwnerPath = 'demote' | 'remove' | 'leave' | 'account_delete' | 'restore';

/** Spec SP3 §16: label là enum hữu hạn; không `orgId`, user, email. */
@Injectable()
export class TenancyMetrics {
  private readonly meter = metrics.getMeter(TENANCY_METER);
  readonly orgAccess = this.meter.createCounter('tenancy_org_access_total', { description: 'Organization context resolutions by access path and result' });
  readonly orgContextDuration = this.meter.createHistogram('tenancy_org_context_duration_seconds', { description: 'Hot-path membership lookup duration', unit: 's' });
  readonly policyDenied = this.meter.createCounter('tenancy_policy_denied_total', { description: 'PoliciesGuard denials by reason' });
  readonly escalationDenied = this.meter.createCounter('tenancy_escalation_denied_total', { description: 'Escalation rule denials by rule' });
  readonly lastOwnerBlocked = this.meter.createCounter('tenancy_last_owner_blocked_total', { description: 'Operations refused to keep an owner, by path' });
  readonly orgPurge = this.meter.createCounter('tenancy_org_purge_total', { description: 'Organization purge job outcomes' });
  readonly orgPurgeFailed = this.meter.createCounter('tenancy_org_purge_failed_total', { description: 'Organization purge attempts that failed (alert)' });
  readonly catalogueMismatch = this.meter.createCounter('tenancy_catalogue_mismatch_total', { description: 'Boots refused because the permission catalogue differs from the database' });
}
```

- [ ] **Step 3: Cổng catalogue, participant, seam test; hai registry; `CatalogueCheck`**

`src/modules/tenancy/ports/catalogue-reader.ts`:
```ts
export type CatalogueRow = {
  key: string;
  resource: string;
  action: string;
  ownerOnly: boolean;
  apiKeyEligible: boolean;
  supportEligible: boolean;
  deprecated: boolean;
  /** Key quyền yêu cầu trực tiếp, đã sắp xếp. */
  requires: string[];
};
export abstract class CatalogueReader {
  abstract readAll(): Promise<CatalogueRow[]>;
}
```
`src/modules/tenancy/infra/sql/sql-catalogue.reader.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Db } from '../../../../core/database/index.js';
import { CatalogueReader, type CatalogueRow } from '../../ports/catalogue-reader.js';

type Raw = {
  key: string;
  resource: string;
  action: string;
  owner_only: boolean;
  api_key_eligible: boolean;
  support_eligible: boolean;
  deprecated: boolean;
  requires: string[];
};

/** Bảng global (không RLS), `app_user` chỉ SELECT (spec SP3 §6.3). Query duy nhất lúc boot. */
@Injectable()
export class SqlCatalogueReader extends CatalogueReader {
  constructor(private readonly db: Db) {
    super();
  }
  async readAll(): Promise<CatalogueRow[]> {
    const rows = await this.db.execute<Raw>(
      `SELECT p.key, p.resource, p.action, p.owner_only, p.api_key_eligible, p.support_eligible,
              p.deprecated_at IS NOT NULL AS deprecated,
              COALESCE(array_agg(q.key ORDER BY q.key) FILTER (WHERE q.key IS NOT NULL), '{}') AS requires
       FROM permissions p
       LEFT JOIN permission_requires r ON r.permission_id = p.id
       LEFT JOIN permissions q ON q.id = r.required_permission_id
       GROUP BY p.id
       ORDER BY p.key`,
    );
    return rows.map((r) => ({
      key: r.key,
      resource: r.resource,
      action: r.action,
      ownerOnly: r.owner_only,
      apiKeyEligible: r.api_key_eligible,
      supportEligible: r.support_eligible,
      deprecated: r.deprecated,
      requires: r.requires,
    }));
  }
}
```
`src/modules/tenancy/ports/org-purge-participant.ts`:
```ts
/**
 * Bên tham gia xoá cứng org (spec SP3 §9.5): chạy TRONG transaction purge (OrgScope của org), chỉ xoá dòng DB của mình.
 * Dọn ngoài DB thuộc job do subscriber của `tenancy.org.purged` enqueue (`onInactiveOrg: 'run'`).
 */
export abstract class OrgPurgeParticipant {
  abstract purge(orgId: string): Promise<void>;
}
export type OrgPurgeParticipantMeta = { key: string; order: number };
```
`src/modules/tenancy/ports/tenancy-test-hooks.ts`:
```ts
/**
 * Seam cho test race có lịch cố định (spec SP3 §18.3: X-4 `afterGuard`, O-18 `beforeRelease`). Production dùng
 * `NoopTenancyTestHooks`; test thay bằng `overrideProvider`. Luật depcruise 19: không import ngoài `modules/tenancy`.
 */
export abstract class TenancyTestHooks {
  /** Sau `PoliciesGuard`, trước transaction của mutation quản trị. */
  abstract afterGuard(): Promise<void>;
  /** Trước khi `release` xử lý org `orgId` của user bị xoá. */
  abstract beforeRelease(authUserId: string, orgId: string): Promise<void>;
}
export class NoopTenancyTestHooks extends TenancyTestHooks {
  afterGuard(): Promise<void> {
    return Promise.resolve();
  }
  beforeRelease(): Promise<void> {
    return Promise.resolve();
  }
}
```
`src/modules/tenancy/application/permission-catalogue.registry.ts`:
```ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { mergeCatalogues, type CatalogueDef, type MergedCatalogue } from '../domain/catalogue.js';

/**
 * Module/feature góp catalogue bằng decorator trên một provider singleton (spec SP3 §8.2; Nest không gom provider cùng
 * token nên không dùng multi-provider). Cùng mẫu `@JobHandler`/`@EventSubscriber` của core.
 */
export const PermissionCatalogueContributor = DiscoveryService.createDecorator<CatalogueDef>();

@Injectable()
export class PermissionCatalogueRegistry implements OnModuleInit {
  private defs: readonly CatalogueDef[] = [];
  private mergedCatalogue: MergedCatalogue | undefined;

  constructor(private readonly discovery: DiscoveryService) {}

  /** `onModuleInit`: đủ trước mọi `onApplicationBootstrap` (`CatalogueCheck`, `OrgRouteInventory`). Vi phạm U1–U5 → ném. */
  onModuleInit(): void {
    const defs: CatalogueDef[] = [];
    for (const wrapper of this.discovery.getProviders({ metadataKey: PermissionCatalogueContributor.KEY })) {
      const def = this.discovery.getMetadataByDecorator(PermissionCatalogueContributor, wrapper);
      if (!def) throw new Error(`@PermissionCatalogueContributor on ${wrapper.name} must be given a catalogue`);
      if (!defs.includes(def)) defs.push(def);
    }
    this.mergedCatalogue = mergeCatalogues(defs);
    this.defs = defs;
  }

  merged(): MergedCatalogue {
    if (!this.mergedCatalogue) throw new Error('PermissionCatalogueRegistry used before onModuleInit');
    return this.mergedCatalogue;
  }

  /** INT3-5a: catalogue trong metadata của route phải là đúng đối tượng đã đăng ký. */
  has(def: CatalogueDef): boolean {
    return this.defs.includes(def);
  }
}
```
`src/modules/tenancy/application/org-purge-participant.registry.ts`:
```ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { OrgPurgeParticipant, type OrgPurgeParticipantMeta } from '../ports/org-purge-participant.js';

export const OrgPurgeParticipantContributor = DiscoveryService.createDecorator<OrgPurgeParticipantMeta>();
export type RegisteredParticipant = { key: string; order: number; participant: OrgPurgeParticipant };
const PARTICIPANT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

@Injectable()
export class OrgPurgeParticipantRegistry implements OnModuleInit {
  private registered: readonly RegisteredParticipant[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const found: RegisteredParticipant[] = [];
    for (const wrapper of this.discovery.getProviders({ metadataKey: OrgPurgeParticipantContributor.KEY })) {
      const meta = this.discovery.getMetadataByDecorator(OrgPurgeParticipantContributor, wrapper);
      if (!meta || !PARTICIPANT_KEY_PATTERN.test(meta.key) || !Number.isInteger(meta.order))
        throw new Error(`@OrgPurgeParticipantContributor on ${wrapper.name} needs { key: ${PARTICIPANT_KEY_PATTERN}, order: integer }`);
      if (!wrapper.isDependencyTreeStatic() || !(wrapper.instance instanceof OrgPurgeParticipant))
        throw new Error(`Org purge participant "${meta.key}" must be a singleton provider extending OrgPurgeParticipant`);
      if (found.some((p) => p.key === meta.key)) throw new Error(`Duplicate org purge participant "${meta.key}"`);
      found.push({ key: meta.key, order: meta.order, participant: wrapper.instance });
    }
    this.registered = found.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }

  participants(): readonly RegisteredParticipant[] {
    return this.registered;
  }
}
```
`src/modules/tenancy/application/catalogue-check.ts`:
```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { MergedCatalogue } from '../domain/catalogue.js';
import { CatalogueReader, type CatalogueRow } from '../ports/catalogue-reader.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';
import { TenancyMetrics } from './tenancy-metrics.js';

const COMPARED = ['resource', 'action', 'ownerOnly', 'apiKeyEligible', 'supportEligible', 'deprecated'] as const;

/** Mọi khác biệt giữa catalogue gộp trong code và dòng DB, sắp theo key (spec SP3 §8.8). Rỗng = khớp. */
export function catalogueDiff(merged: MergedCatalogue, rows: readonly CatalogueRow[]): string[] {
  const out: string[] = [];
  const db = new Map(rows.map((r) => [r.key, r]));
  const keys = [...new Set([...merged.keys(), ...db.keys()])].sort();
  for (const key of keys) {
    const code = merged.get(key);
    const row = db.get(key);
    if (!row) {
      out.push(`${key}: in code, missing in the database`);
      continue;
    }
    if (!code) {
      out.push(`${key}: in the database, missing in code`);
      continue;
    }
    for (const f of COMPARED)
      if (code[f] !== row[f]) out.push(`${key}: ${f} code=${String(code[f])} db=${String(row[f])}`);
    const codeRequires = [...code.requires].sort().join(',');
    const dbRequires = [...row.requires].sort().join(',');
    if (codeRequires !== dbRequires) out.push(`${key}: requires code=[${codeRequires}] db=[${dbRequires}]`);
  }
  return out;
}

/** Api và worker: catalogue lệch DB (thiếu migration, pod lệch version) → app không khởi động (fail loud). */
@Injectable()
export class CatalogueCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogueCheck.name);

  constructor(
    private readonly registry: PermissionCatalogueRegistry,
    private readonly reader: CatalogueReader,
    private readonly metrics: TenancyMetrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const differences = catalogueDiff(this.registry.merged(), await this.reader.readAll());
    if (differences.length === 0) return;
    this.metrics.catalogueMismatch.add(1);
    this.logger.error({ event: 'catalogue_mismatch', differences }, 'permission catalogue in code does not match the database');
    throw new Error(`Permission catalogue does not match the database: ${differences.join('; ')}`);
  }
}
```

- [ ] **Step 4: Module, public API, composition**

`src/modules/tenancy/tenancy.module.ts`:
```ts
import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CatalogueCheck } from './application/catalogue-check.js';
import { OrgPurgeParticipantRegistry } from './application/org-purge-participant.registry.js';
import { PermissionCatalogueContributor, PermissionCatalogueRegistry } from './application/permission-catalogue.registry.js';
import { TenancyMetrics } from './application/tenancy-metrics.js';
import { TENANCY_CATALOGUE } from './domain/tenancy-catalogue.js';
import { SqlCatalogueReader } from './infra/sql/sql-catalogue.reader.js';
import { CatalogueReader } from './ports/catalogue-reader.js';
import { NoopTenancyTestHooks, TenancyTestHooks } from './ports/tenancy-test-hooks.js';
import './events.js';
import './errors.js';
import './tenancy.config.js';

@Injectable()
@PermissionCatalogueContributor(TENANCY_CATALOGUE)
class TenancyCatalogueContributor {}

/**
 * Phần dùng chung api + worker. `@Global` vì `PoliciesGuard` (Task 21) gắn vào controller của `features/` và cần
 * registry + metric ở mọi module; `TenancyTestHooks` cũng vậy (test thay một chỗ).
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    TenancyMetrics,
    PermissionCatalogueRegistry,
    OrgPurgeParticipantRegistry,
    TenancyCatalogueContributor,
    SqlCatalogueReader,
    { provide: CatalogueReader, useExisting: SqlCatalogueReader },
    CatalogueCheck,
    { provide: TenancyTestHooks, useClass: NoopTenancyTestHooks },
  ],
  exports: [TenancyMetrics, PermissionCatalogueRegistry, OrgPurgeParticipantRegistry, TenancyTestHooks],
})
export class TenancyCoreModule {}

/** Task 20 thêm repository, Task 22 thêm HTTP (api), Task 25 thêm purge + gate job (worker). */
@Module({})
export class TenancyModule {
  static forApi(): DynamicModule {
    return { module: TenancyModule, imports: [TenancyCoreModule] };
  }
  static forWorker(): DynamicModule {
    return { module: TenancyModule, imports: [TenancyCoreModule] };
  }
}
```
`src/modules/tenancy/index.ts`:
```ts
export { TenancyModule } from './tenancy.module.js';
export { tenancyConfig, type TenancyConfig } from './tenancy.config.js';
export { TenancyErrors } from './errors.js';
export {
  OrgCreatedEvent,
  OrgUpdatedEvent,
  OrgDeletedEvent,
  OrgRestoredEvent,
  OrgPurgedEvent,
  MemberAddedEvent,
  MemberRoleChangedEvent,
  MemberRemovedEvent,
} from './events.js';
export { PermissionCatalogueContributor } from './application/permission-catalogue.registry.js';
export { OrgPurgeParticipantContributor } from './application/org-purge-participant.registry.js';
export { OrgPurgeParticipant } from './ports/org-purge-participant.js';
```
`src/app.modules.ts` — thêm import và đặt **sau** identity + notifications (tenancy import cổng của identity):
```ts
import { TenancyModule } from './modules/tenancy/index.js';
// …
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [NotificationsModule.forApi(), IdentityModule.forApi(), TenancyModule.forApi()],
  worker: [NotificationsModule.forWorker(), IdentityModule.forWorker(), TenancyModule.forWorker()],
};
```
Sửa chú thích dòng `APP_MODULES` thành "Boilerplate bật sẵn identity + notifications + tenancy (spec SP2 §6, SP3 §5.1)".
`src/scripts/gen-env-example.ts` thêm sau dòng import identity config:
```ts
import '../modules/tenancy/tenancy.config.js';
```

- [ ] **Step 5: Test Discovery hai module + `CatalogueCheck` trên DB thật (fail trước Step 2–4)**

`test/unit/modules/tenancy/registries.spec.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { OrgPurgeParticipantContributor, OrgPurgeParticipantRegistry } from '../../../../src/modules/tenancy/application/org-purge-participant.registry.js';
import { PermissionCatalogueContributor, PermissionCatalogueRegistry } from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { CatalogueError, defineCatalogue } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { OrgPurgeParticipant } from '../../../../src/modules/tenancy/ports/org-purge-participant.js';

const entry = { requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: true, member: false } };
const A = defineCatalogue('a', { 'alpha.read': { resource: 'alpha', action: 'read', ...entry } });
const B = defineCatalogue('b', { 'beta.read': { resource: 'beta', action: 'read', ...entry } });
const B2 = defineCatalogue('b2', { 'beta.read': { resource: 'beta', action: 'read', ...entry } });

@Injectable() @PermissionCatalogueContributor(A) class ContribA {}
@Injectable() @PermissionCatalogueContributor(B) class ContribB {}
@Injectable() @PermissionCatalogueContributor(B2) class ContribB2 {}
@Module({ providers: [ContribA] }) class ModA {}
@Module({ providers: [ContribB] }) class ModB {}
@Module({ providers: [ContribB2] }) class ModB2 {}

@Injectable() @OrgPurgeParticipantContributor({ key: 'second', order: 10 })
class Second extends OrgPurgeParticipant { purge(): Promise<void> { return Promise.resolve(); } }
@Injectable() @OrgPurgeParticipantContributor({ key: 'first', order: 0 })
class First extends OrgPurgeParticipant { purge(): Promise<void> { return Promise.resolve(); } }
@Injectable() @OrgPurgeParticipantContributor({ key: 'first', order: 5 })
class FirstAgain extends OrgPurgeParticipant { purge(): Promise<void> { return Promise.resolve(); } }
@Injectable() @OrgPurgeParticipantContributor({ key: 'broken', order: 1 })
class NotAParticipant {}
@Module({ providers: [Second] }) class ModP1 {}
@Module({ providers: [First] }) class ModP2 {}

const boot = async (imports: Parameters<typeof Test.createTestingModule>[0]['imports']) => {
  const ref = await Test.createTestingModule({ imports: [DiscoveryModule, ...(imports ?? [])], providers: [PermissionCatalogueRegistry, OrgPurgeParticipantRegistry] }).compile();
  await ref.init();
  return ref;
};

describe('Discovery registries across modules (spec SP3 §8.2, §18.3 "cơ chế Discovery hai module")', () => {
  it('merges catalogues contributed by two modules and knows their identity', async () => {
    const ref = await boot([ModA, ModB]);
    const reg = ref.get(PermissionCatalogueRegistry);
    expect([...reg.merged().keys()].sort()).toEqual(['alpha.read', 'beta.read']);
    expect([reg.has(A), reg.has(B), reg.has(B2)]).toEqual([true, true, false]);
    await ref.close();
  });
  it('two catalogues with the same key refuse to boot', async () => {
    await expect(boot([ModB, ModB2])).rejects.toBeInstanceOf(CatalogueError);
  });
  it('participants from two modules run by order then key', async () => {
    const ref = await boot([ModP1, ModP2]);
    expect(ref.get(OrgPurgeParticipantRegistry).participants().map((p) => p.key)).toEqual(['first', 'second']);
    await ref.close();
  });
  it('duplicate participant keys and non-participants refuse to boot', async () => {
    await expect(boot([ModP2, { module: class Dup {}, providers: [FirstAgain] }])).rejects.toThrow(/Duplicate org purge participant "first"/);
    await expect(boot([{ module: class Bad {}, providers: [NotAParticipant] }])).rejects.toThrow(/must be a singleton provider extending OrgPurgeParticipant/);
  });
});
```
`test/support/tenancy-core-app.ts` (app không HTTP dùng chung cho integration test của tenancy; Task 23 cần đủ outbox/event/scheduler cho service vòng đời):
```ts
import { DatabaseModule } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { SchedulerModule } from '../../src/core/scheduler/index.js';
import { TenancyModule } from '../../src/modules/tenancy/index.js';
import type { ModuleImport } from './app-factory.js';

/**
 * Hạ tầng core + `TenancyModule.forWorker()` (không HTTP, không identity HTTP): đủ cho `CatalogueCheck`, repository, gate
 * job và service vòng đời. Route/pipeline test qua `startTenancyApp` (Task 22).
 */
export const tenancyCoreImports = (): ModuleImport[] => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: false }),
  OutboxModule.forRoot({ relay: false }),
  EventsModule.forRoot({ worker: false }),
  SchedulerModule.forRoot({ worker: false }),
  TenancyModule.forWorker(),
];
```
`test/integration/tenancy/catalogue-check.spec.ts`:
```ts
import { Injectable, Module } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionCatalogueContributor } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { defineCatalogue } from '../../../src/modules/tenancy/domain/catalogue.js';
import { buildTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';

const Fixture = defineCatalogue('fixture', {
  'fixture.read': { resource: 'fixture', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: false, member: false } },
});
@Injectable() @PermissionCatalogueContributor(Fixture) class FixtureContributor {}
@Module({ providers: [FixtureContributor] }) class FixtureCatalogueModule {}

describe('CatalogueCheck (spec SP3 §8.8, tiêu chí 14)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  it('the migrated database matches the tenancy catalogue: the app boots (api boot: every tenancy e2e)', async () => {
    const app = await buildTestApp(tenancyCoreImports());
    close = () => app.close();
    await expect(app.init()).resolves.toBe(app);
  });
  it('a registered catalogue the migrations never seeded refuses to boot, naming the key', async () => {
    const app = await buildTestApp([...tenancyCoreImports(), FixtureCatalogueModule]);
    close = () => app.close();
    await expect(app.init()).rejects.toThrow(/fixture\.read: in code, missing in the database/);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy && pnpm vitest run --project integration test/integration/tenancy/catalogue-check.spec.ts`
Expected: PASS.

- [ ] **Step 6: Luật kiến trúc 17–19 kèm fixture phải fail**

`.dependency-cruiser.cjs` — thêm sau luật `http-no-database-barrel`:
```js
    {
      name: 'casl-only-in-tenancy-authz-or-http',
      severity: 'error',
      comment: 'SP3 rule 17: CASL builds abilities in tenancy application/authz and is checked in tenancy http only.',
      from: { pathNot: '(^|/)src/modules/tenancy/(application/authz|http)/' },
      to: { path: 'node_modules/@casl/' },
    },
    {
      name: 'identity-notifications-independent-of-tenancy',
      severity: 'error',
      comment: 'SP3 rule 18: tenancy plugs into identity/notifications through their ports, never the reverse.',
      from: { path: '(^|/)src/modules/(identity|notifications)/' },
      to: { path: '(^|/)src/modules/tenancy/' },
    },
    {
      name: 'tenancy-test-hooks-only-in-tenancy',
      severity: 'error',
      comment: 'SP3 rule 19: the race-test seam is never injected outside modules/tenancy (features use index.ts only).',
      from: { pathNot: '(^|/)src/modules/tenancy/' },
      to: { path: '(^|/)src/modules/tenancy/ports/tenancy-test-hooks\\.ts$' },
    },
```
Fixture (mỗi file một dòng):
- `test/architecture/fixtures/src/modules/billing/infra/uses-casl.ts`: `import '@casl/ability';`
- `test/architecture/fixtures/src/modules/tenancy/index.ts`: `export const tenancyPublicApi = true;`
- `test/architecture/fixtures/src/modules/identity/http/uses-tenancy.ts`: `import '../../tenancy/index.js';`
- `test/architecture/fixtures/src/modules/tenancy/ports/tenancy-test-hooks.ts`: `export const tenancyTestHooks = true;`
- `test/architecture/fixtures/src/features/x/uses-tenancy-test-hooks.ts`: `import '../../modules/tenancy/ports/tenancy-test-hooks.js';`

`test/unit/architecture/rules.spec.ts` — thêm vào bảng `it.each`:
```ts
    ['casl-only-in-tenancy-authz-or-http', 'modules/billing/infra/uses-casl.ts'],
    ['identity-notifications-independent-of-tenancy', 'modules/identity/http/uses-tenancy.ts'],
    ['tenancy-test-hooks-only-in-tenancy', 'features/x/uses-tenancy-test-hooks.ts'],
```
Run: `pnpm vitest run --project unit test/unit/architecture/rules.spec.ts && pnpm arch`
Expected: PASS (ba luật mới bắt fixture; cây `src` thật không vi phạm; `modules-only-index-of-other-modules` vẫn chỉ bắt `tenancy/deep.ts` vì fixture identity đi qua `index.ts`).

- [ ] **Step 7: Sinh lại `.env.example`, kiểm toàn cục, commit**

Run:
```bash
pnpm env:example && git diff --stat .env.example
pnpm typecheck && pnpm lint
pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/core/entrypoints.e2e.spec.ts test/e2e/core/entrypoints-worker.e2e.spec.ts
```
Expected: `.env.example` thêm đúng 10 dòng `TENANCY_*` có mô tả; typecheck/lint/unit xanh; hai entrypoint (api, worker) khởi động với `APP_MODULES` mới (CatalogueCheck đạt trên DB đã migrate).
```bash
git add src/modules/tenancy src/app.modules.ts src/scripts/gen-env-example.ts .dependency-cruiser.cjs .env.example test/support/tenancy-core-app.ts test/unit/modules/tenancy test/integration/tenancy/catalogue-check.spec.ts test/unit/architecture/rules.spec.ts test/architecture/fixtures/src
git commit -m "feat(tenancy): module skeleton with config, errors, events, discovery registries and the boot-time catalogue check"
```

---

### Task 20: Repository SQL của tenancy, upsert + khoá `tenancy_users` (T-25, X-6), `OrgActivityGate` của tenancy

**Files:**
- Create: `src/modules/tenancy/ports/tenancy-user-repository.ts`, `src/modules/tenancy/ports/org-repository.ts`, `src/modules/tenancy/ports/role-repository.ts`, `src/modules/tenancy/ports/member-repository.ts`, `src/modules/tenancy/application/subject-resolver.ts`, `src/modules/tenancy/application/org-activity.gate.ts`, `src/modules/tenancy/infra/sql/rows.ts`, `src/modules/tenancy/infra/sql/sql-tenancy-user.repository.ts`, `src/modules/tenancy/infra/sql/sql-org.repository.ts`, `src/modules/tenancy/infra/sql/sql-role.repository.ts`, `src/modules/tenancy/infra/sql/sql-member.repository.ts`, `src/modules/tenancy/infra/queue/tenancy-queue-ports.module.ts`
- Create (test): `test/unit/modules/tenancy/tenancy-user-repository.spec.ts`, `test/integration/tenancy/repositories.spec.ts`, `test/integration/tenancy/org-activity-gate.spec.ts`
- Modify: `src/modules/tenancy/errors.ts`, `src/modules/tenancy/tenancy.module.ts`

**Interfaces:**
- Consumes: `Db`, `UnitOfWork`, `OrgScope`, `countUpTo`, `OrgActivityGate`/`OrgActivity` (Task 6), `ORG_PURGE_STATEMENTS` (Task 14), 6 hàm definer (Task 15), `identityConfig` (identity `index.ts`), `SystemRoleKey`, `seedOrg`/`seedMember` (Task 14).
- Produces (mọi phương thức "hiện tại" chạy trong OrgScope của org và transaction của caller; RLS lọc, SQL vẫn ghi `org_id = app_current_org()`):
  - `type TenancySubject = { kind: 'AUTH_USER'; authUserId: string } | { kind: 'EXTERNAL'; externalSubject: string }`; `type TenancyUserRef = { id: string; publicId: string }`.
  - `TenancyUserRepository`: `find(s): Promise<TenancyUserRef | undefined>`, `upsertAndLock(s): Promise<TenancyUserRef>` (đòi transaction; `INSERT … ON CONFLICT (<cột theo mode>) DO NOTHING` rồi `SELECT … FOR NO KEY UPDATE`; 0 dòng → `TenancyUserVanishedError`), `deleteById(id): Promise<void>`.
  - `SubjectResolver.of(p: Principal): TenancySubject` (`AUTH_MODE=external` → `EXTERNAL`, còn lại `AUTH_USER`; principal không phải `user` → ném).
  - `type OrgRow = { id; name; version: number; deletedAt: Date | null; purgeAfter: Date | null; createdByUserId: string | null; createdAt: Date; updatedAt: Date }`; `OrgRepository`: `insertCurrent({ name, createdByUserId })`, `readCurrent()`, `lockCurrent()` (`FOR NO KEY UPDATE`), `clockNow(): Promise<Date>` (`clock_timestamp()`, gọi **sau** khi khoá), `rename(name)`, `softDelete(graceSec)`, `restore()`, `detachCreator(userId): Promise<boolean>`, `purgeCurrent()`, và lời gọi hàm definer `listForUser(userId, includeDeleted, limit, offset): Promise<UserOrgRow[]>`, `countForUser(userId, includeDeleted)`, `countCreatedBy(userId)`, `soleOwnerOrgs(userId)`, `relatedOrgIds(userId)`, `dueForPurge(after, limit)`.
  - `type RoleRow = { id; publicId; systemKey: SystemRoleKey | null; name: string | null; description: string | null; version: number; createdAt: Date; updatedAt: Date }`; `RoleRepository`: `insertSystemRoles(): Promise<Record<SystemRoleKey, RoleRow>>`, `list()`, `findByPublicId(publicId)`, `findBySystemKey(key)`.
  - `type MemberRow = { id; publicId; userId; userPublicId; authUserId: string | null; externalSubject: string | null; roleId; rolePublicId; systemKey: SystemRoleKey | null; roleName: string | null; version: number; createdAt: Date; updatedAt: Date }`; `MemberRepository`: `insert({ userId, roleId })`, `findByPublicId(publicId)`, `findByUserId(userId)`, `lockForShare(ids: readonly string[])` (`FOR SHARE`, `ORDER BY id`), `changeRole(id, roleId)`, `deleteById(id)`, `list({ roleId?, limit, offset })`, `countUpTo(roleId, cap)`.
  - `TenancyUserVanishedError` (errors.ts).
  - `TenancyOrgActivityGate extends OrgActivityGate` + `@Global() TenancyQueuePortsModule` (chỉ ở `forWorker()`).

- [ ] **Step 1: Unit test nhánh "dòng biến mất" (fail)**

`test/unit/modules/tenancy/tenancy-user-repository.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Db, UnitOfWork } from '../../../../src/core/database/index.js';
import { TenancyUserVanishedError } from '../../../../src/modules/tenancy/errors.js';
import { SqlTenancyUserRepository } from '../../../../src/modules/tenancy/infra/sql/sql-tenancy-user.repository.js';

/** Db giả trả lần lượt kết quả cho từng câu; ghi lại SQL đã chạy. */
const fakeDb = (results: object[][]) => {
  const seen: string[] = [];
  const db = { execute: (sql: string) => { seen.push(sql); return Promise.resolve(results.shift() ?? []); } } as Pick<Db, 'execute'>;
  return { db: db as Db, seen };
};
const inTx = { inTransaction: () => true } as Pick<UnitOfWork, 'inTransaction'> as UnitOfWork;
const noTx = { inTransaction: () => false } as Pick<UnitOfWork, 'inTransaction'> as UnitOfWork;

describe('SqlTenancyUserRepository.upsertAndLock (spec SP3 §6.2, DB2-M10)', () => {
  it('targets the conflict column of the subject kind, never a bare ON CONFLICT', async () => {
    const { db, seen } = fakeDb([[], [{ id: '7', public_id: '0198c000-0000-7000-8000-000000000001' }]]);
    await new SqlTenancyUserRepository(db, inTx).upsertAndLock({ kind: 'EXTERNAL', externalSubject: 'sub-1' });
    expect(seen[0]).toMatch(/ON CONFLICT \(external_subject\) DO NOTHING/);
    expect(seen[1]).toMatch(/FOR NO KEY UPDATE/);
  });
  it('a row deleted between the upsert and the lock is a named error, never a retry', async () => {
    const { db, seen } = fakeDb([[], []]);
    await expect(
      new SqlTenancyUserRepository(db, inTx).upsertAndLock({ kind: 'AUTH_USER', authUserId: '0198c000-0000-7000-8000-000000000002' }),
    ).rejects.toBeInstanceOf(TenancyUserVanishedError);
    expect(seen).toHaveLength(2);
  });
  it('refuses to run outside a transaction (the lock would be released at once)', async () => {
    const { db } = fakeDb([]);
    await expect(new SqlTenancyUserRepository(db, noTx).upsertAndLock({ kind: 'EXTERNAL', externalSubject: 's' })).rejects.toThrow(/inside UnitOfWork\.run/);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/tenancy-user-repository.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 2: Port và lỗi có tên**

`src/modules/tenancy/errors.ts` thêm cuối file:
```ts
/**
 * Dòng `tenancy_users` bị bước `release` của xoá tài khoản xoá giữa upsert và khoá (spec SP3 §6.2, DB2-M10). Service đổi
 * thành `409 conflict`; không tự thử lại (thử lại sẽ tạo lại dòng cho một user đang bị xoá).
 */
export class TenancyUserVanishedError extends Error {
  constructor() {
    super('tenancy_users row vanished between upsert and lock (account deletion in progress)');
    this.name = 'TenancyUserVanishedError';
  }
}
```
`src/modules/tenancy/ports/tenancy-user-repository.ts`:
```ts
export type TenancySubject = { kind: 'AUTH_USER'; authUserId: string } | { kind: 'EXTERNAL'; externalSubject: string };
export type TenancyUserRef = { id: string; publicId: string };

export abstract class TenancyUserRepository {
  /** Không khoá, không tạo: đường nóng và `GET /v1/orgs` không bao giờ tạo dòng (Review Focus 2). */
  abstract find(s: TenancySubject): Promise<TenancyUserRef | undefined>;
  /** Tạo lười + khoá `FOR NO KEY UPDATE` trong transaction của caller (T-25, T-6, T-7). */
  abstract upsertAndLock(s: TenancySubject): Promise<TenancyUserRef>;
  abstract deleteById(id: string): Promise<void>;
}
```
`src/modules/tenancy/ports/org-repository.ts`:
```ts
export type OrgRow = {
  id: string;
  name: string;
  version: number;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
/** Một dòng của `tenancy_list_user_orgs` (spec SP3 §6.14). */
export type UserOrgRow = {
  orgId: string;
  orgName: string;
  orgDeletedAt: Date | null;
  orgPurgeAfter: Date | null;
  memberPublicId: string;
  rolePublicId: string;
  roleSystemKey: string | null;
  roleName: string | null;
  joinedAt: Date;
};

/** Phương thức "Current" chạy trong OrgScope của org (RLS); hàm definer chạy ở mọi context. */
export abstract class OrgRepository {
  abstract insertCurrent(o: { name: string; createdByUserId: string }): Promise<OrgRow>;
  abstract readCurrent(): Promise<OrgRow | undefined>;
  abstract lockCurrent(): Promise<OrgRow | undefined>;
  /** `clock_timestamp()` — gọi SAU khi có khoá (spec SP3 §3.15; `now()` là giờ bắt đầu transaction). */
  abstract clockNow(): Promise<Date>;
  abstract rename(name: string): Promise<OrgRow>;
  abstract softDelete(graceSec: number): Promise<OrgRow>;
  abstract restore(): Promise<OrgRow>;
  /** `created_by_user_id = NULL` khi đang trỏ tới user; `true` nếu có dòng đổi (version tăng). */
  abstract detachCreator(userId: string): Promise<boolean>;
  abstract purgeCurrent(): Promise<void>;
  abstract listForUser(userId: string, includeDeleted: boolean, limit: number, offset: number): Promise<UserOrgRow[]>;
  abstract countForUser(userId: string, includeDeleted: boolean): Promise<number>;
  abstract countCreatedBy(userId: string): Promise<number>;
  abstract soleOwnerOrgs(userId: string): Promise<string[]>;
  abstract relatedOrgIds(userId: string): Promise<string[]>;
  abstract dueForPurge(after: string, limit: number): Promise<string[]>;
}
```
`src/modules/tenancy/ports/role-repository.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';

export type RoleRow = {
  id: string;
  publicId: string;
  systemKey: SystemRoleKey | null;
  name: string | null;
  description: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export abstract class RoleRepository {
  abstract insertSystemRoles(): Promise<Record<SystemRoleKey, RoleRow>>;
  abstract list(): Promise<RoleRow[]>;
  abstract findByPublicId(publicId: string): Promise<RoleRow | undefined>;
  abstract findBySystemKey(key: SystemRoleKey): Promise<RoleRow | undefined>;
}
```
`src/modules/tenancy/ports/member-repository.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';

export type MemberRow = {
  id: string;
  publicId: string;
  userId: string;
  userPublicId: string;
  authUserId: string | null;
  externalSubject: string | null;
  roleId: string;
  rolePublicId: string;
  systemKey: SystemRoleKey | null;
  roleName: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export abstract class MemberRepository {
  abstract insert(m: { userId: string; roleId: string }): Promise<MemberRow>;
  abstract findByPublicId(publicId: string): Promise<MemberRow | undefined>;
  abstract findByUserId(userId: string): Promise<MemberRow | undefined>;
  /** Đọc lại actor/target dưới khoá org, `FOR SHARE` theo `id` tăng dần (spec SP3 §8.6 bước 4). */
  abstract lockForShare(ids: readonly string[]): Promise<MemberRow[]>;
  abstract changeRole(id: string, roleId: string): Promise<MemberRow>;
  abstract deleteById(id: string): Promise<void>;
  abstract list(q: { roleId?: string; limit: number; offset: number }): Promise<MemberRow[]>;
  abstract countUpTo(roleId: string | undefined, cap: number): Promise<number>;
}
```
`src/modules/tenancy/application/subject-resolver.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import type { Principal } from '../../../core/context/index.js';
import { identityConfig } from '../../identity/index.js';
import type { TenancySubject } from '../ports/tenancy-user-repository.js';

/** Spec SP3 §6.2, §11: `local`/`hybrid` → `auth."user".id`; `external` → `sub`. Đổi mode trên dữ liệu có sẵn: runbook. */
@Injectable()
export class SubjectResolver {
  constructor(@Inject(identityConfig.KEY) private readonly identity: ConfigOf<typeof identityConfig>) {}

  of(p: Principal): TenancySubject {
    if (p.type !== 'user') throw new Error(`tenancy subjects are users; got principal type ${p.type}`);
    return this.identity.mode === 'external'
      ? { kind: 'EXTERNAL', externalSubject: p.id }
      : { kind: 'AUTH_USER', authUserId: p.id };
  }
}
```

- [ ] **Step 3: Cài đặt SQL**

`src/modules/tenancy/infra/sql/rows.ts`:
```ts
import { z } from 'zod';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';

/** Kiểm dòng DB ở ranh giới (bigint đọc dạng text; không bao giờ `Number` hoá id). */
const text = z.string();
const nullableText = z.string().nullable();
const date = z.coerce.date();
const nullableDate = z.coerce.date().nullable();
const systemKey = z.enum(SYSTEM_ROLE_KEYS).nullable();

export const OrgRowSchema = z
  .object({
    id: text,
    name: text,
    version: z.coerce.number().int(),
    deleted_at: nullableDate,
    purge_after: nullableDate,
    created_by_user_id: nullableText,
    created_at: date,
    updated_at: date,
  })
  .transform((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    deletedAt: r.deleted_at,
    purgeAfter: r.purge_after,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export const ORG_COLUMNS = 'id::text AS id, name, version, deleted_at, purge_after, created_by_user_id::text AS created_by_user_id, created_at, updated_at';

export const RoleRowSchema = z
  .object({
    id: text,
    public_id: text,
    system_key: systemKey,
    name: nullableText,
    description: nullableText,
    version: z.coerce.number().int(),
    created_at: date,
    updated_at: date,
  })
  .transform((r) => ({
    id: r.id,
    publicId: r.public_id,
    systemKey: r.system_key,
    name: r.name,
    description: r.description,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export const ROLE_COLUMNS = 'id::text AS id, public_id::text AS public_id, system_key, name, description, version, created_at, updated_at';

export const MemberRowSchema = z
  .object({
    id: text,
    public_id: text,
    user_id: text,
    user_public_id: text,
    auth_user_id: nullableText,
    external_subject: nullableText,
    role_id: text,
    role_public_id: text,
    system_key: systemKey,
    role_name: nullableText,
    version: z.coerce.number().int(),
    created_at: date,
    updated_at: date,
  })
  .transform((r) => ({
    id: r.id,
    publicId: r.public_id,
    userId: r.user_id,
    userPublicId: r.user_public_id,
    authUserId: r.auth_user_id,
    externalSubject: r.external_subject,
    roleId: r.role_id,
    rolePublicId: r.role_public_id,
    systemKey: r.system_key,
    roleName: r.role_name,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
/** Member + user + role; `org_roles` join theo FK kép `(org_id, role_id)`. */
export const MEMBER_SELECT = `SELECT m.id::text AS id, m.public_id::text AS public_id, m.user_id::text AS user_id,
    u.public_id::text AS user_public_id, u.auth_user_id::text AS auth_user_id, u.external_subject,
    m.role_id::text AS role_id, r.public_id::text AS role_public_id, r.system_key, r.name AS role_name,
    m.version, m.created_at, m.updated_at
  FROM org_members m
  JOIN tenancy_users u ON u.id = m.user_id
  JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id`;

export function single<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (!row || rows.length !== 1) throw new Error(`${what}: expected exactly one row, got ${rows.length}`);
  return row;
}
```
`src/modules/tenancy/infra/sql/sql-tenancy-user.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, UnitOfWork } from '../../../../core/database/index.js';
import { TenancyUserVanishedError } from '../../errors.js';
import { TenancyUserRepository, type TenancySubject, type TenancyUserRef } from '../../ports/tenancy-user-repository.js';

const Ref = z.object({ id: z.string(), public_id: z.string() }).transform((r) => ({ id: r.id, publicId: r.public_id }));
/** Cột đích theo loại subject (spec SP3 §6.2): không bao giờ `ON CONFLICT` không cột. */
const columnOf = (s: TenancySubject): { column: 'auth_user_id' | 'external_subject'; value: string } =>
  s.kind === 'AUTH_USER' ? { column: 'auth_user_id', value: s.authUserId } : { column: 'external_subject', value: s.externalSubject };

@Injectable()
export class SqlTenancyUserRepository extends TenancyUserRepository {
  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {
    super();
  }

  async find(s: TenancySubject): Promise<TenancyUserRef | undefined> {
    const { column, value } = columnOf(s);
    const rows = await this.db.execute(`SELECT id::text AS id, public_id::text AS public_id FROM tenancy_users WHERE ${column} = ?`, [value]);
    return rows[0] ? Ref.parse(rows[0]) : undefined;
  }

  async upsertAndLock(s: TenancySubject): Promise<TenancyUserRef> {
    if (!this.uow.inTransaction()) throw new Error('TenancyUserRepository.upsertAndLock must run inside UnitOfWork.run');
    const { column, value } = columnOf(s);
    await this.db.execute(`INSERT INTO tenancy_users (${column}) VALUES (?) ON CONFLICT (${column}) DO NOTHING`, [value]);
    const rows = await this.db.execute(
      `SELECT id::text AS id, public_id::text AS public_id FROM tenancy_users WHERE ${column} = ? FOR NO KEY UPDATE`,
      [value],
    );
    if (!rows[0]) throw new TenancyUserVanishedError();
    return Ref.parse(rows[0]);
  }

  async deleteById(id: string): Promise<void> {
    await this.db.execute('DELETE FROM tenancy_users WHERE id = ?', [id]);
  }
}
```
`src/modules/tenancy/infra/sql/sql-org.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { OrgRepository, type OrgRow, type UserOrgRow } from '../../ports/org-repository.js';
import { ORG_PURGE_STATEMENTS } from './org-purge.sql.js';
import { ORG_COLUMNS, OrgRowSchema, single } from './rows.js';

const Count = z.object({ n: z.coerce.number().int() });
const OrgIdRow = z.object({ org_id: z.string() });
const Now = z.object({ now: z.coerce.date() });
const UserOrg = z
  .object({
    org_id: z.string(),
    org_name: z.string(),
    org_deleted_at: z.coerce.date().nullable(),
    org_purge_after: z.coerce.date().nullable(),
    member_public_id: z.string(),
    role_public_id: z.string(),
    role_system_key: z.string().nullable(),
    role_name: z.string().nullable(),
    joined_at: z.coerce.date(),
  })
  .transform(
    (r): UserOrgRow => ({
      orgId: r.org_id,
      orgName: r.org_name,
      orgDeletedAt: r.org_deleted_at,
      orgPurgeAfter: r.org_purge_after,
      memberPublicId: r.member_public_id,
      rolePublicId: r.role_public_id,
      roleSystemKey: r.role_system_key,
      roleName: r.role_name,
      joinedAt: r.joined_at,
    }),
  );
const CURRENT = 'id = app_current_org()';

@Injectable()
export class SqlOrgRepository extends OrgRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(sql: string, params: unknown[], what: string): Promise<OrgRow> {
    return OrgRowSchema.parse(single(await this.db.execute(sql, params), what));
  }
  private async maybe(sql: string): Promise<OrgRow | undefined> {
    const [row] = await this.db.execute(sql);
    return row ? OrgRowSchema.parse(row) : undefined;
  }

  insertCurrent(o: { name: string; createdByUserId: string }): Promise<OrgRow> {
    return this.one(
      `INSERT INTO organizations (id, name, created_by_user_id) VALUES (app_current_org(), ?, ?) RETURNING ${ORG_COLUMNS}`,
      [o.name, o.createdByUserId],
      'insert organization',
    );
  }
  readCurrent(): Promise<OrgRow | undefined> {
    return this.maybe(`SELECT ${ORG_COLUMNS} FROM organizations WHERE ${CURRENT}`);
  }
  /** Điểm tuần tự hoá mọi mutation quản trị (spec SP3 §8.6 bước 1); không bao giờ `FOR UPDATE` (DB-I3). */
  lockCurrent(): Promise<OrgRow | undefined> {
    return this.maybe(`SELECT ${ORG_COLUMNS} FROM organizations WHERE ${CURRENT} FOR NO KEY UPDATE`);
  }
  async clockNow(): Promise<Date> {
    return Now.parse(single(await this.db.execute('SELECT clock_timestamp() AS now'), 'clock_timestamp')).now;
  }
  rename(name: string): Promise<OrgRow> {
    return this.one(
      `UPDATE organizations SET name = ?, version = version + 1, updated_at = now() WHERE ${CURRENT} RETURNING ${ORG_COLUMNS}`,
      [name],
      'rename organization',
    );
  }
  softDelete(graceSec: number): Promise<OrgRow> {
    return this.one(
      `UPDATE organizations SET deleted_at = clock_timestamp(), purge_after = clock_timestamp() + make_interval(secs => ?),
         version = version + 1, updated_at = now()
       WHERE ${CURRENT} AND deleted_at IS NULL RETURNING ${ORG_COLUMNS}`,
      [graceSec],
      'soft delete organization',
    );
  }
  restore(): Promise<OrgRow> {
    return this.one(
      `UPDATE organizations SET deleted_at = NULL, purge_after = NULL, version = version + 1, updated_at = now()
       WHERE ${CURRENT} AND deleted_at IS NOT NULL RETURNING ${ORG_COLUMNS}`,
      [],
      'restore organization',
    );
  }
  async detachCreator(userId: string): Promise<boolean> {
    const rows = await this.db.execute(
      `UPDATE organizations SET created_by_user_id = NULL, version = version + 1, updated_at = now()
       WHERE ${CURRENT} AND created_by_user_id = ? RETURNING id`,
      [userId],
    );
    return rows.length === 1;
  }
  async purgeCurrent(): Promise<void> {
    for (const sql of ORG_PURGE_STATEMENTS) await this.db.execute(sql);
  }
  async listForUser(userId: string, includeDeleted: boolean, limit: number, offset: number): Promise<UserOrgRow[]> {
    const rows = await this.db.execute('SELECT * FROM tenancy_list_user_orgs(?, ?, ?, ?)', [userId, includeDeleted, limit, offset]);
    return rows.map((r) => UserOrg.parse(r));
  }
  async countForUser(userId: string, includeDeleted: boolean): Promise<number> {
    return Count.parse(single(await this.db.execute('SELECT tenancy_count_user_orgs(?, ?) AS n', [userId, includeDeleted]), 'count user orgs')).n;
  }
  async countCreatedBy(userId: string): Promise<number> {
    return Count.parse(single(await this.db.execute('SELECT tenancy_count_orgs_created_by(?) AS n', [userId]), 'count created orgs')).n;
  }
  async soleOwnerOrgs(userId: string): Promise<string[]> {
    return (await this.db.execute('SELECT org_id::text AS org_id FROM tenancy_user_sole_owner_orgs(?)', [userId])).map((r) => OrgIdRow.parse(r).org_id);
  }
  async relatedOrgIds(userId: string): Promise<string[]> {
    return (await this.db.execute('SELECT org_id::text AS org_id FROM tenancy_user_related_org_ids(?)', [userId])).map((r) => OrgIdRow.parse(r).org_id);
  }
  async dueForPurge(after: string, limit: number): Promise<string[]> {
    return (await this.db.execute('SELECT org_id::text AS org_id FROM tenancy_orgs_due_for_purge(?, ?)', [after, limit])).map((r) => OrgIdRow.parse(r).org_id);
  }
}
```
`src/modules/tenancy/infra/sql/sql-role.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Db } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS, type SystemRoleKey } from '../../constants.js';
import { RoleRepository, type RoleRow } from '../../ports/role-repository.js';
import { ROLE_COLUMNS, RoleRowSchema } from './rows.js';

@Injectable()
export class SqlRoleRepository extends RoleRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async insertSystemRoles(): Promise<Record<SystemRoleKey, RoleRow>> {
    const rows = (
      await this.db.execute(
        `INSERT INTO org_roles (org_id, system_key) SELECT app_current_org(), k FROM unnest(?::text[]) AS k RETURNING ${ROLE_COLUMNS}`,
        [SYSTEM_ROLE_KEYS],
      )
    ).map((r) => RoleRowSchema.parse(r));
    const of = (k: SystemRoleKey): RoleRow => {
      const row = rows.find((r) => r.systemKey === k);
      if (!row) throw new Error(`system role ${k} was not inserted`);
      return row;
    };
    return { OWNER: of('OWNER'), ADMIN: of('ADMIN'), MEMBER: of('MEMBER') };
  }
  async list(): Promise<RoleRow[]> {
    const rows = await this.db.execute(`SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() ORDER BY id`);
    return rows.map((r) => RoleRowSchema.parse(r));
  }
  async findByPublicId(publicId: string): Promise<RoleRow | undefined> {
    const [row] = await this.db.execute(`SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() AND public_id = ?`, [publicId]);
    return row ? RoleRowSchema.parse(row) : undefined;
  }
  async findBySystemKey(key: SystemRoleKey): Promise<RoleRow | undefined> {
    const [row] = await this.db.execute(`SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() AND system_key = ?`, [key]);
    return row ? RoleRowSchema.parse(row) : undefined;
  }
}
```
`src/modules/tenancy/infra/sql/sql-member.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { MemberRepository, type MemberRow } from '../../ports/member-repository.js';
import { MEMBER_SELECT, MemberRowSchema, single } from './rows.js';

const IN_ORG = 'm.org_id = app_current_org()';

@Injectable()
export class SqlMemberRepository extends MemberRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async byId(id: string): Promise<MemberRow> {
    return MemberRowSchema.parse(single(await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} AND m.id = ?`, [id]), 'member by id'));
  }

  async insert(m: { userId: string; roleId: string }): Promise<MemberRow> {
    const [row] = await this.db.execute<{ id: string }>(
      'INSERT INTO org_members (org_id, user_id, role_id) VALUES (app_current_org(), ?, ?) RETURNING id::text AS id',
      [m.userId, m.roleId],
    );
    if (!row) throw new Error('insert member returned no row');
    return this.byId(row.id);
  }
  async findByPublicId(publicId: string): Promise<MemberRow | undefined> {
    const [row] = await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} AND m.public_id = ?`, [publicId]);
    return row ? MemberRowSchema.parse(row) : undefined;
  }
  async findByUserId(userId: string): Promise<MemberRow | undefined> {
    const [row] = await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} AND m.user_id = ?`, [userId]);
    return row ? MemberRowSchema.parse(row) : undefined;
  }
  async lockForShare(ids: readonly string[]): Promise<MemberRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} AND m.id = ANY(?::bigint[]) ORDER BY m.id FOR SHARE OF m`, [ids]);
    return rows.map((r) => MemberRowSchema.parse(r));
  }
  async changeRole(id: string, roleId: string): Promise<MemberRow> {
    single(
      await this.db.execute(
        'UPDATE org_members SET role_id = ?, version = version + 1, updated_at = now() WHERE org_id = app_current_org() AND id = ? RETURNING id',
        [roleId, id],
      ),
      'change member role',
    );
    return this.byId(id);
  }
  async deleteById(id: string): Promise<void> {
    single(await this.db.execute('DELETE FROM org_members WHERE org_id = app_current_org() AND id = ? RETURNING id', [id]), 'delete member');
  }
  async list(q: { roleId?: string; limit: number; offset: number }): Promise<MemberRow[]> {
    const rows =
      q.roleId === undefined
        ? await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} ORDER BY m.created_at, m.id LIMIT ? OFFSET ?`, [q.limit, q.offset])
        : await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} AND m.role_id = ? ORDER BY m.created_at, m.id LIMIT ? OFFSET ?`, [q.roleId, q.limit, q.offset]);
    return rows.map((r) => MemberRowSchema.parse(r));
  }
  countUpTo(roleId: string | undefined, cap: number): Promise<number> {
    return roleId === undefined
      ? countUpTo(this.db, 'SELECT 1 FROM org_members WHERE org_id = app_current_org()', [], cap)
      : countUpTo(this.db, 'SELECT 1 FROM org_members WHERE org_id = app_current_org() AND role_id = ?', [roleId], cap);
  }
}
```
`src/modules/tenancy/application/org-activity.gate.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../core/database/index.js';
import { OrgActivityGate, type OrgActivity } from '../../../core/queue/index.js';

const Row = z.object({ deleted_at: z.coerce.date().nullable() });

/** Một câu đọc ngắn trong OrgScope của job (spec SP3 §9.4, CDX-6). Lỗi DB ném ra: job lỗi, BullMQ thử lại. */
@Injectable()
export class TenancyOrgActivityGate extends OrgActivityGate {
  constructor(private readonly db: Db) {
    super();
  }
  async check(): Promise<OrgActivity> {
    const [row] = await this.db.execute('SELECT deleted_at FROM organizations WHERE id = app_current_org()');
    if (!row) return { kind: 'GONE' };
    const { deleted_at } = Row.parse(row);
    return deleted_at === null ? { kind: 'ACTIVE' } : { kind: 'DELETED', deletedAt: deleted_at };
  }
}
```
`src/modules/tenancy/infra/queue/tenancy-queue-ports.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { OrgActivityGate } from '../../../../core/queue/index.js';
import { TenancyOrgActivityGate } from '../../application/org-activity.gate.js';

/** `@Global`: `WorkerHost` (core) inject `@Optional() OrgActivityGate` (spec SP3 §5.2). Chỉ nạp ở `forWorker()`. */
@Global()
@Module({ providers: [TenancyOrgActivityGate, { provide: OrgActivityGate, useExisting: TenancyOrgActivityGate }], exports: [OrgActivityGate] })
export class TenancyQueuePortsModule {}
```
`src/modules/tenancy/tenancy.module.ts` — thêm vào `providers` của `TenancyCoreModule` (và `exports` các token cổng):
```ts
    SubjectResolver,
    SqlTenancyUserRepository,
    { provide: TenancyUserRepository, useExisting: SqlTenancyUserRepository },
    SqlOrgRepository,
    { provide: OrgRepository, useExisting: SqlOrgRepository },
    SqlRoleRepository,
    { provide: RoleRepository, useExisting: SqlRoleRepository },
    SqlMemberRepository,
    { provide: MemberRepository, useExisting: SqlMemberRepository },
```
`exports` thêm `SubjectResolver, TenancyUserRepository, OrgRepository, RoleRepository, MemberRepository`. `forWorker()` đổi thành `imports: [TenancyCoreModule, TenancyQueuePortsModule]`.

- [ ] **Step 4: Integration test repository và gate (fail trước Step 3)**

`test/integration/tenancy/repositories.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { MemberRepository } from '../../../src/modules/tenancy/ports/member-repository.js';
import { OrgRepository } from '../../../src/modules/tenancy/ports/org-repository.js';
import { RoleRepository } from '../../../src/modules/tenancy/ports/role-repository.js';
import { TenancyUserRepository } from '../../../src/modules/tenancy/ports/tenancy-user-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const ROUNDS = 20;

describe('tenancy SQL repositories (spec SP3 §6, §8.6)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const createdUserIds: string[] = [];
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await withAppClient(async (c) => {
      for (const id of createdUserIds) await c.query('DELETE FROM tenancy_users WHERE id = $1', [id]);
    });
    await app?.close();
  });
  const uow = () => app.get(UnitOfWork);
  const users = () => app.get(TenancyUserRepository);

  it(`X-6 / T-25: ${ROUNDS} rounds of two first requests of the same subject lock the same single row`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = { kind: 'EXTERNAL' as const, externalSubject: `x6:${randomUUID()}` };
      const [a, b] = await Promise.all([uow().run(() => users().upsertAndLock(s)), uow().run(() => users().upsertAndLock(s))]);
      expect(a).toEqual(b);
      createdUserIds.push(a.id);
    }
  });
  it('find never creates a row', async () => {
    expect(await users().find({ kind: 'EXTERNAL', externalSubject: `ghost:${randomUUID()}` })).toBeUndefined();
  });
  it('the vanish window is real: a row deleted between INSERT … DO NOTHING and the lock reads as no row (DB2-M10)', async () => {
    const subject = `vanish:${randomUUID()}`;
    await withAppClient((c) => c.query('INSERT INTO tenancy_users (external_subject) VALUES ($1)', [subject]));
    await withAppClient(async (b) =>
      withAppClient(async (a) => {
        await b.query('BEGIN');
        await b.query('INSERT INTO tenancy_users (external_subject) VALUES ($1) ON CONFLICT (external_subject) DO NOTHING', [subject]);
        await a.query('DELETE FROM tenancy_users WHERE external_subject = $1', [subject]);
        const { rowCount } = await b.query('SELECT id FROM tenancy_users WHERE external_subject = $1 FOR NO KEY UPDATE', [subject]);
        await b.query('ROLLBACK');
        expect(rowCount).toBe(0);
      }),
    );
  });
  it('org, roles and members round-trip inside OrgScope; lockCurrent does not block a child INSERT (DB-I3)', async () => {
    const org = await seedOrg();
    orgs.push(org);
    const m = await seedMember(org, 'MEMBER');
    await app.get(OrgScope).run(org.orgId, () =>
      uow().run(async () => {
        const locked = await app.get(OrgRepository).lockCurrent();
        expect(locked?.id).toBe(org.orgId);
        expect((await app.get(OrgRepository).clockNow()).getTime()).toBeGreaterThan(0);
        expect((await app.get(RoleRepository).list()).map((r) => r.systemKey)).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
        const row = await app.get(MemberRepository).findByPublicId(m.memberPublicId);
        expect(row).toMatchObject({ userPublicId: m.userPublicId, systemKey: 'MEMBER' });
        expect(await app.get(MemberRepository).countUpTo(undefined, 100)).toBe(2);
        // Một kết nối khác chèn dòng con có FK tới org trong lúc khoá đang giữ: không bị chặn.
        await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('INSERT INTO fixture_org_items (org_id) VALUES ($1)', [org.orgId])));
        await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [org.orgId])));
      }),
    );
  });
  it('definer calls: listForUser hides soft-deleted orgs from non-owners; dueForPurge honours the cursor', async () => {
    const org = await seedOrg();
    orgs.push(org);
    const m = await seedMember(org, 'MEMBER');
    const repo = app.get(OrgRepository);
    expect((await repo.listForUser(m.userId, false, 10, 0)).map((r) => r.orgId)).toEqual([org.orgId]);
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [org.orgId])));
    expect(await repo.listForUser(m.userId, true, 10, 0)).toEqual([]);
    expect((await repo.listForUser(org.owner.userId, true, 10, 0)).map((r) => r.orgId)).toEqual([org.orgId]);
    expect(await repo.dueForPurge(org.orgId, 10)).not.toContain(org.orgId);
    expect(await repo.dueForPurge('00000000-0000-0000-0000-000000000000', 1000)).toContain(org.orgId);
    expect(await repo.countCreatedBy(org.owner.userId)).toBe(1);
    expect(await repo.soleOwnerOrgs(org.owner.userId)).toEqual([]);
  });
  it('a v7 id that is not an organization reads as undefined, not an error', async () => {
    await app.get(OrgScope).run(v7(), async () => expect(await app.get(OrgRepository).readCurrent()).toBeUndefined());
  });
});
```
`test/integration/tenancy/org-activity-gate.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope } from '../../../src/core/database/index.js';
import { OrgActivityGate } from '../../../src/core/queue/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

describe('TenancyOrgActivityGate (spec SP3 §9.4, T-34)', () => {
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
  const check = (orgId: string) => app.get(OrgScope).run(orgId, () => app.get(OrgActivityGate).check());

  it('ACTIVE, then DELETED with deleted_at, and GONE for an org without a row', async () => {
    expect(await check(org.orgId)).toEqual({ kind: 'ACTIVE' });
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`, [org.orgId])));
    const deleted = await check(org.orgId);
    expect(deleted.kind).toBe('DELETED');
    expect(await check(v7())).toEqual({ kind: 'GONE' });
  });
});
```
Run:
```bash
pnpm vitest run --project unit test/unit/modules/tenancy/tenancy-user-repository.spec.ts
pnpm vitest run --project integration test/integration/tenancy/repositories.spec.ts test/integration/tenancy/org-activity-gate.spec.ts
```
Expected: PASS (X-6 20 vòng cùng một `id`; bằng chứng khe "biến mất"; khoá org không chặn INSERT con; gate ba trạng thái).

- [ ] **Step 5: Kiểm toàn cục, commit**

Run: `pnpm typecheck && pnpm lint && pnpm arch`
Expected: xanh (`@mikro-orm` không bị import; SQL chỉ qua `Db` trong `infra/` và gate).
```bash
git add src/modules/tenancy test/unit/modules/tenancy/tenancy-user-repository.spec.ts test/integration/tenancy/repositories.spec.ts test/integration/tenancy/org-activity-gate.spec.ts
git commit -m "feat(tenancy): SQL repositories, lazy tenancy_users upsert-and-lock and the worker org activity gate"
```

---

### Task 21: Matcher route tenant, decorator phân quyền + hai marker, `PoliciesGuard`, `OrgRouteInventory` (G-1, G-2, G-4, G-5, G-8, U14, INT3-5a, R4A-N5)

**Files:**
- Create: `src/modules/tenancy/http/org-route.ts`, `src/modules/tenancy/http/policy-metadata.ts`, `src/modules/tenancy/http/decorators.ts`, `src/modules/tenancy/http/policies.guard.ts`, `src/modules/tenancy/application/org-route-inventory.ts`, `src/modules/tenancy/permissions.ts`
- Create (test): `test/unit/modules/tenancy/org-route.spec.ts`, `test/unit/modules/tenancy/decorators.spec.ts`, `test/unit/modules/tenancy/policies-guard.spec.ts`, `test/unit/modules/tenancy/org-route-inventory.spec.ts`
- Modify: `src/modules/tenancy/tenancy.module.ts` (contributor dùng `TenancyPermissions`), `src/modules/tenancy/index.ts`

**Interfaces:**
- Consumes: `OrgAccess`, `RequestContext.orgAccess()` (Task 5), `SessionOnly`, `RequireFreshSession`, `RequireVerifiedEmail` (identity `index.ts`, Task 10), `PUBLIC_ROUTE` (core/http), `buildAbility`, `UnknownPermissionError`, `defineCatalogue`, `CatalogueDef`, `CatalogueEntryDef` (Task 17), `PermissionCatalogueRegistry`, `TenancyMetrics` (Task 19).
- Produces:
  - `org-route.ts`: `ORG_ROUTE_PATTERN = 'v1/orgs/:orgId{/*path}'`, `ORG_RESTORE_TEMPLATE = 'v1/orgs/:orgId/restore'`, `type OrgRouteKind = 'TENANT' | 'INVALID' | 'OTHER'`, `normalizeTemplate(path: string): string`, `routeTemplateOf(controller: Function, handler: Function): string[]`, `classifyOrgRoute(template: string): OrgRouteKind`, `isOrgRestoreRequest(req: { method?: string; params?: Record<string, unknown> }): boolean`, `type OrgRouteRequest`.
  - `decorators.ts`: `TENANCY_POLICY`, `type TenancyPolicy = { kind: 'PERMISSIONS'; catalogue: CatalogueDef; keys: readonly string[] } | { kind: 'MEMBER_ONLY' }`, `type PermissionCatalogue<K extends string> = CatalogueDef<K> & { require(...keys: [K, ...K[]]): ClassDecorator & MethodDecorator }`, `definePermissionCatalogue(name, entries)`, `OrgMemberOnly()`, `TENANCY_SENSITIVE`, `TENANCY_NARROWING`, `SensitiveTenancyAction()`, `NarrowingTenancyAction()`, `NARROWING_ROUTES: readonly string[]` (dạng `'<METHOD> <template>'`; 3A: `'DELETE v1/orgs/:orgId/members/me'`), `MARKER_EXEMPT_ROUTES` (hai route preview của 3C).
  - `PoliciesGuard` (route-scoped; `@Injectable`, deps toàn cục; span `tenancy.policy.check` với `tenancy.policy.result` = `allowed | denied | error`, review M4).
  - `TENANCY_CONTROLLER_MODULES` (injection token: danh sách module có controller của tenancy, G-8), `OrgRouteInventory.check(): string[]` + `onApplicationBootstrap()` (ném khi có vi phạm; Task 23 mới nạp vào `forApi()` khi route khôi phục đã có).
  - `TenancyPermissions` (`permissions.ts`) = catalogue tenancy có `require(...)`; là đối tượng được đăng ký vào registry.

- [ ] **Step 1: Test matcher (fail)**

`test/unit/modules/tenancy/org-route.spec.ts`:
```ts
import { Controller, Get, Post } from '@nestjs/common';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ORG_RESTORE_TEMPLATE,
  ORG_ROUTE_PATTERN,
  classifyOrgRoute,
  isOrgRestoreRequest,
  routeTemplateOf,
} from '../../../../src/modules/tenancy/http/org-route.js';

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

describe('shared tenant route matcher (spec SP3 §7.4, INT-I5)', () => {
  it('routeTemplateOf joins class + method paths, trims slashes and lower-cases static segments', () => {
    expect(routeTemplateOf(SplitCtl, SplitCtl.prototype.x)).toEqual(['v1/orgs/:orgId/x']);
    expect(routeTemplateOf(SplitCtl, SplitCtl.prototype.create)).toEqual(['v1/orgs']);
    expect(routeTemplateOf(SlashCtl, SlashCtl.prototype.get)).toEqual(['v1/orgs/:orgId']);
    expect(routeTemplateOf(UpperCtl, UpperCtl.prototype.restore)).toEqual([ORG_RESTORE_TEMPLATE]);
    expect(routeTemplateOf(MultiCtl, MultiCtl.prototype.list)).toEqual(['v1/orgs/:id/x', 'v1/other']);
  });
  it.each([
    ['v1/orgs/:orgId', 'TENANT'],
    ['v1/orgs/:orgId/members/:memberId', 'TENANT'],
    ['v1/orgs/:id/x', 'INVALID'],
    ['v1/orgs/me', 'INVALID'],
    ['v1/orgs', 'OTHER'],
    ['v1/orgsx/:orgId', 'OTHER'],
    ['v1/me', 'OTHER'],
  ] as const)('classifyOrgRoute(%s) = %s', (t, kind) => {
    expect(classifyOrgRoute(t)).toBe(kind);
  });
  it.each([
    [{ method: 'POST', params: { path: ['restore'] } }, true],
    [{ method: 'POST', params: { path: ['Restore', ''] } }, true],
    [{ method: 'post', params: { path: ['RESTORE'] } }, true],
    [{ method: 'GET', params: { path: ['restore'] } }, false],
    [{ method: 'POST', params: {} }, false],
    [{ method: 'POST', params: { path: ['members', 'restore'] } }, false],
    [{ method: 'POST' }, false],
  ])('isOrgRestoreRequest(%j) = %s', (req, expected) => {
    expect(isOrgRestoreRequest(req)).toBe(expected);
  });
  it('the Express router agrees with the pattern: one match per URL, params as the middleware reads them (G-7, INT3-2)', async () => {
    const app = express();
    const hits: unknown[] = [];
    app.all(`/${ORG_ROUTE_PATTERN}`, (req, res) => {
      hits.push({ orgId: req.params.orgId, path: req.params.path ?? null });
      res.sendStatus(204);
    });
    for (const url of ['/v1/orgs/X', '/v1/orgs/X/', '/v1/orgs/X/members', '/V1/ORGS/X/Restore/']) await request(app).get(url).expect(204);
    await request(app).get('/v1/orgsX').expect(404);
    expect(hits).toEqual([
      { orgId: 'X', path: null },
      { orgId: 'X', path: null },
      { orgId: 'X', path: ['members'] },
      { orgId: 'X', path: ['Restore', ''] },
    ]);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/org-route.spec.ts`
Expected: FAIL (module chưa có). Nếu dòng `/v1/orgs/X/` cho `path: ['']` thay vì `null` trên Express 5.2.1 thật, sửa **kỳ vọng của test** theo hành vi đo được, và `isOrgRestoreRequest` vẫn đúng vì nó bỏ segment rỗng; ghi hành vi đo được vào chú thích của `ORG_ROUTE_PATTERN`.

- [ ] **Step 2: Cài matcher**

`src/modules/tenancy/http/org-route.ts`:
```ts
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';

/**
 * Đối số DUY NHẤT của `forRoutes` cho `OrgContextMiddleware` (spec SP3 §7.4, INT3-2): một pattern nên middleware chạy
 * đúng một lần mỗi request. Express 5.2.1 (đã chạy thử): `/v1/orgs/X`, `/v1/orgs/X/`, `/v1/orgs/X/members`,
 * `/V1/ORGS/X/Restore/` khớp một lần; `req.params.path` là `undefined` khi không có phần sau.
 */
export const ORG_ROUTE_PATTERN = 'v1/orgs/:orgId{/*path}';
/** Route khôi phục (method `POST`): đường duy nhất một org xoá mềm được đi tiếp tới guard (spec SP3 §7.1 bước 3.7). */
export const ORG_RESTORE_TEMPLATE = 'v1/orgs/:orgId/restore';
export type OrgRouteKind = 'TENANT' | 'INVALID' | 'OTHER';
/** Phần request mà matcher đọc (không dùng type của Express: luật `http-platform-only-in-core-http`). */
export type OrgRouteRequest = { method?: string; params?: Record<string, unknown> };

const reflector = new Reflector();
const TENANT = /^v1\/orgs\/:orgId(\/|$)/;
const UNDER_ORGS = /^v1\/orgs\/[^/]+/;

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
export const routeTemplateOf = (controller: Function, handler: Function): string[] =>
  pathsOf(controller).flatMap((c) => pathsOf(handler).map((h) => normalizeTemplate(`${c}/${h}`)));

export const classifyOrgRoute = (template: string): OrgRouteKind =>
  TENANT.test(template) ? 'TENANT' : UNDER_ORGS.test(template) ? 'INVALID' : 'OTHER';

/**
 * `POST` và `req.params.path` (segment Express điền cho `{/*path}`), bỏ segment rỗng, chữ thường, đúng `['restore']`.
 * Không đọc `req.path` thô (lệch router về hoa thường và `/` cuối, INT2-N-15); thiếu `path` → `false`.
 */
export function isOrgRestoreRequest(req: OrgRouteRequest): boolean {
  if (req.method?.toUpperCase() !== 'POST') return false;
  const path = req.params?.['path'];
  if (!Array.isArray(path)) return false;
  const segments = path.filter((s): s is string => typeof s === 'string' && s !== '').map((s) => s.toLowerCase());
  return segments.length === 1 && segments[0] === 'restore';
}
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/org-route.spec.ts`
Expected: PASS.

- [ ] **Step 3: Test decorator, guard, inventory (fail)**

`test/unit/modules/tenancy/decorators.spec.ts`:
```ts
import { Controller, Delete, Post } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { REQUIRE_FRESH_SESSION, REQUIRE_VERIFIED_EMAIL } from '../../../../src/modules/identity/http/fresh-session.decorator.js';
import { SESSION_ONLY } from '../../../../src/modules/identity/http/session-only.decorator.js';
import {
  NarrowingTenancyAction,
  SensitiveTenancyAction,
  TENANCY_NARROWING,
  TENANCY_POLICY,
  TENANCY_SENSITIVE,
  definePermissionCatalogue,
} from '../../../../src/modules/tenancy/http/decorators.js';
import { PoliciesGuard } from '../../../../src/modules/tenancy/http/policies.guard.js';

const Cat = definePermissionCatalogue('dec', {
  'dec.read': { resource: 'dec', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: true, member: true } },
});
@Controller('v1/orgs/:orgId/dec')
class Ctl {
  @Post() @Cat.require('dec.read') @SensitiveTenancyAction() create() {}
  @Delete() @Cat.require('dec.read') @NarrowingTenancyAction() revoke() {}
}
const r = new Reflector();

describe('tenancy decorators (spec SP3 §12, tiêu chí 18)', () => {
  it('require() records the catalogue object and keys and attaches PoliciesGuard', () => {
    expect(r.get(TENANCY_POLICY, Ctl.prototype.create)).toEqual({ kind: 'PERMISSIONS', catalogue: Cat, keys: ['dec.read'] });
    expect(r.get(GUARDS_METADATA, Ctl.prototype.create)).toContain(PoliciesGuard);
  });
  it('SensitiveTenancyAction = SessionOnly + RequireFreshSession + RequireVerifiedEmail + marker', () => {
    const h = Ctl.prototype.create;
    expect([r.get(TENANCY_SENSITIVE, h), r.get(SESSION_ONLY, h), r.get(REQUIRE_FRESH_SESSION, h), r.get(REQUIRE_VERIFIED_EMAIL, h)]).toEqual([true, true, true, true]);
  });
  it('NarrowingTenancyAction = SessionOnly + marker only (revocation must stay possible with an old session, SEC3-2)', () => {
    const h = Ctl.prototype.revoke;
    expect([r.get(TENANCY_NARROWING, h), r.get(SESSION_ONLY, h), r.get(REQUIRE_FRESH_SESSION, h) ?? false]).toEqual([true, true, false]);
  });
  it('an unknown key is a compile error (type-level check)', () => {
    // @ts-expect-error 'dec.write' is not in the catalogue
    expect(() => Cat.require('dec.write')).not.toThrow();
  });
});
```
`test/unit/modules/tenancy/policies-guard.spec.ts`:
```ts
import { Controller, Get, Post, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { OrgAccess, RequestContext } from '../../../../src/core/context/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { PermissionCatalogueRegistry } from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import { UnknownPermissionError, mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { OrgMemberOnly } from '../../../../src/modules/tenancy/http/decorators.js';
import { PoliciesGuard } from '../../../../src/modules/tenancy/http/policies.guard.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';

@Controller('v1/orgs/:orgId')
class Ctl {
  @Get() @TenancyPermissions.require('org.read') read() {}
  @Post('restore') @TenancyPermissions.require('org.restore') restore() {}
  @Get('members/me') @OrgMemberOnly() me() {}
  @Get('bare') bare() {}
}
const merged = mergeCatalogues([TenancyPermissions]);
const registry = { merged: () => merged } as Pick<PermissionCatalogueRegistry, 'merged'> as PermissionCatalogueRegistry;
const guardWith = (access: OrgAccess | undefined) =>
  new PoliciesGuard(new Reflector(), { orgAccess: () => access } as Pick<RequestContext, 'orgAccess'> as RequestContext, registry, new TenancyMetrics());
const ctxOf = (handler: Function): ExecutionContext =>
  ({ getHandler: () => handler, getClass: () => Ctl }) as Pick<ExecutionContext, 'getHandler' | 'getClass'> as ExecutionContext;
const access = (permissions: string[], over: Partial<OrgAccess> = {}): OrgAccess => ({ via: 'MEMBERSHIP', ref: 'm1', permissions, orgDeleted: false, ...over });

describe('PoliciesGuard (spec SP3 §7.1 bước 5)', () => {
  it('grants when every required key is held', () => {
    expect(guardWith(access(['org.read'])).canActivate(ctxOf(Ctl.prototype.read))).toBe(true);
  });
  it('G-4 / U14: a missing key is 403 forbidden and the body never carries the CASL message', () => {
    let caught: unknown;
    try {
      guardWith(access(['members.read'])).canActivate(ctxOf(Ctl.prototype.read));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const e = caught as AppError;
    expect([e.error.code, e.error.status]).toEqual(['forbidden', 403]);
    const exposed = JSON.stringify({ message: e.message, detail: e.opts.detail ?? null });
    expect(exposed).not.toMatch(/Cannot execute/);
    expect(exposed).not.toContain('org.read');
  });
  it('G-2: a handler without policy metadata is a 500-class assembly error, never allowed', () => {
    expect(() => guardWith(access(['org.read'])).canActivate(ctxOf(Ctl.prototype.bare))).toThrow(/without tenancy policy metadata/);
  });
  it('no orgAccess on a tenant route is an assembly error', () => {
    expect(() => guardWith(undefined).canActivate(ctxOf(Ctl.prototype.read))).toThrow(/no orgAccess/);
  });
  it('a soft-deleted org may reach the restore handler only', () => {
    expect(guardWith(access(['org.restore', 'org.read'], { orgDeleted: true })).canActivate(ctxOf(Ctl.prototype.restore))).toBe(true);
    expect(() => guardWith(access(['org.read'], { orgDeleted: true })).canActivate(ctxOf(Ctl.prototype.read))).toThrow(/soft-deleted organization/);
  });
  it('OrgMemberOnly admits MEMBERSHIP only', () => {
    expect(guardWith(access([])).canActivate(ctxOf(Ctl.prototype.me))).toBe(true);
    expect(() => guardWith(access([], { via: 'SUPPORT_GRANT' })).canActivate(ctxOf(Ctl.prototype.me))).toThrow(AppError);
  });
  it('G-5: only CASL ForbiddenError becomes 403; any other error propagates unchanged (instanceof, not constructor.name)', () => {
    expect(() => guardWith(access(['ghost.read'])).canActivate(ctxOf(Ctl.prototype.read))).toThrow(UnknownPermissionError);
  });
});
```
`test/unit/modules/tenancy/org-route-inventory.spec.ts`:
```ts
import { All, Controller, Delete, Get, Global, Injectable, Module, Patch, Post, Search, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ContextModule } from '../../../../src/core/context/index.js';
import { PublicRoute } from '../../../../src/core/http/index.js';
import { OrgRouteInventory, TENANCY_CONTROLLER_MODULES } from '../../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueContributor, PermissionCatalogueRegistry } from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import { NarrowingTenancyAction, OrgMemberOnly, SensitiveTenancyAction, definePermissionCatalogue } from '../../../../src/modules/tenancy/http/decorators.js';

const entry = { requires: [], ownerOnly: false, apiKeyEligible: false, supportEligible: false, grantTo: { admin: true, member: true } };
const Fx = definePermissionCatalogue('fx', { 'fx.read': { resource: 'fx', action: 'read', ...entry } });
const Unregistered = definePermissionCatalogue('unreg', { 'unreg.read': { resource: 'unreg', action: 'read', ...entry } });
@Injectable() @PermissionCatalogueContributor(Fx) class FxContributor {}

@Controller('v1/orgs/:orgId')
class RestoreCtl {
  @Post('restore') @Fx.require('fx.read') @SensitiveTenancyAction() restore() {}
  @Delete('members/me') @OrgMemberOnly() @NarrowingTenancyAction() leave() {}
}
@Controller('v1/orgs/:orgId/things')
class GoodCtl {
  @Get() @Fx.require('fx.read') list() {}
  @Patch(':id') @Fx.require('fx.read') @SensitiveTenancyAction() edit() {}
}
@Controller('v1/orgs/:orgId/bad') class MissingPolicy { @Get() list() {} }
@Controller('v1/orgs/:id/bad') class WrongParam { @Get() @Fx.require('fx.read') list() {} }
@Controller('v1/orgs/me') class StaticSegment { @Get() @OrgMemberOnly() list() {} }
@Controller('v1/orgs/:orgId/pub') class PublicTenant { @Get() @PublicRoute() @Fx.require('fx.read') list() {} }
@Controller('v1/elsewhere') class PolicyOutside { @Get() @Fx.require('fx.read') list() {} }
@Controller('v1/orgs/:orgId/w') class NoMarker { @Post() @Fx.require('fx.read') create() {} }
@Controller('v1/orgs/:orgId/w2') class BothMarkers { @Post() @Fx.require('fx.read') @SensitiveTenancyAction() @NarrowingTenancyAction() create() {} }
@Controller('v1/orgs/:orgId/w3') class AllMethod { @All() @Fx.require('fx.read') @SensitiveTenancyAction() any() {} }
@Controller('v1/orgs/:orgId/w4') class SearchMethod { @Search() @Fx.require('fx.read') @SensitiveTenancyAction() find() {} }
@Controller('v1/orgs/:orgId/w5') class UndeclaredNarrowing { @Delete() @Fx.require('fx.read') @NarrowingTenancyAction() revoke() {} }
@Controller('v1/orgs/:orgId/u') class UnregisteredCatalogue { @Get() @Unregistered.require('unreg.read') list() {} }
@Controller('v1/orgs/:orgId') class SecondRestore { @Post('restore/') @Fx.require('fx.read') @SensitiveTenancyAction() again() {} }

/** Deps của `PoliciesGuard` (Nest tạo guard của `UseGuards` như injectable của module chứa controller): toàn cục như `TenancyCoreModule`. */
@Global()
@Module({ imports: [DiscoveryModule], providers: [PermissionCatalogueRegistry, TenancyMetrics, FxContributor], exports: [PermissionCatalogueRegistry, TenancyMetrics] })
class GuardDeps {}

/** Dựng app không HTTP với các controller fixture; `tenancy` = controller nằm trong module thuộc luật G-8. */
async function inventoryOf(tenancy: Type[], others: Type[] = []): Promise<string[]> {
  @Module({ controllers: tenancy }) class TenancyFixtureHttp {}
  @Module({ controllers: others }) class FeatureFixtureHttp {}
  const ref = await Test.createTestingModule({
    imports: [ContextModule, DiscoveryModule, GuardDeps, TenancyFixtureHttp, FeatureFixtureHttp],
    providers: [OrgRouteInventory, { provide: TENANCY_CONTROLLER_MODULES, useValue: [TenancyFixtureHttp] }],
  }).compile();
  // Chỉ onModuleInit (registry); inventory gọi tay để đọc vi phạm thay vì bắt lỗi boot.
  await ref.get(PermissionCatalogueRegistry).onModuleInit();
  const problems = ref.get(OrgRouteInventory).check();
  await ref.close();
  return problems;
}

describe('OrgRouteInventory (spec SP3 §7.1 kiểm lúc khởi động, G-1, G-8)', () => {
  it('a well-formed route table has no problem', async () => {
    expect(await inventoryOf([RestoreCtl, GoodCtl])).toEqual([]);
  });
  it.each([
    [[MissingPolicy], /GET v1\/orgs\/:orgId\/bad: tenant route without a permission decorator or @OrgMemberOnly/],
    [[WrongParam], /v1\/orgs\/:id\/bad: routes under v1\/orgs\/ must name the org parameter :orgId/],
    [[StaticSegment], /v1\/orgs\/me: routes under v1\/orgs\/ must name the org parameter :orgId/],
    [[PublicTenant], /tenant route must not be @PublicRoute/],
    [[NoMarker], /POST v1\/orgs\/:orgId\/w: a tenancy write route needs exactly one of @SensitiveTenancyAction\/@NarrowingTenancyAction/],
    [[BothMarkers], /POST v1\/orgs\/:orgId\/w2: a tenancy write route needs exactly one/],
    [[AllMethod], /v1\/orgs\/:orgId\/w3: tenancy controllers may only declare GET, POST, PUT, PATCH, DELETE/],
    [[SearchMethod], /v1\/orgs\/:orgId\/w4: tenancy controllers may only declare GET, POST, PUT, PATCH, DELETE/],
    [[UndeclaredNarrowing], /narrowing routes differ from NARROWING_ROUTES: \+DELETE v1\/orgs\/:orgId\/w5/],
    [[UnregisteredCatalogue], /catalogue "unreg" is not registered/],
    [[SecondRestore], /exactly one POST v1\/orgs\/:orgId\/restore handler, found 2/],
  ])('G-1/G-8 fixture %# refuses to boot', async (extra, message) => {
    const problems = await inventoryOf([RestoreCtl, ...extra]);
    expect(problems.join('\n')).toMatch(message);
  });
  it('a policy decorator outside a tenant route is misplaced', async () => {
    expect((await inventoryOf([RestoreCtl], [PolicyOutside])).join('\n')).toMatch(/v1\/elsewhere: permission decorator on a non-tenant route/);
  });
  it('without the restore route the app does not boot (the constant would silently drift)', async () => {
    expect((await inventoryOf([GoodCtl])).join('\n')).toMatch(/exactly one POST v1\/orgs\/:orgId\/restore handler, found 0/);
  });
  it('G-8 does not apply to feature controllers (business mutations need no fresh session)', async () => {
    @Controller('v1/orgs/:orgId/feature') class FeatureWrite { @Post() @Fx.require('fx.read') create() {} }
    expect(await inventoryOf([RestoreCtl], [FeatureWrite])).toEqual([]);
  });
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/decorators.spec.ts test/unit/modules/tenancy/policies-guard.spec.ts test/unit/modules/tenancy/org-route-inventory.spec.ts`
Expected: FAIL (module chưa có).

- [ ] **Step 4: Cài decorator, guard, inventory, `TenancyPermissions`**

`src/modules/tenancy/http/policy-metadata.ts` (tách riêng để `decorators.ts` → `policies.guard.ts` không thành vòng import, luật `no-circular`):
```ts
import type { CatalogueDef } from '../domain/catalogue.js';

export const TENANCY_POLICY = 'tenancy:policy';
export const TENANCY_SENSITIVE = 'tenancy:sensitiveAction';
export const TENANCY_NARROWING = 'tenancy:narrowingAction';
export type TenancyPolicy = { kind: 'PERMISSIONS'; catalogue: CatalogueDef; keys: readonly string[] } | { kind: 'MEMBER_ONLY' };
/** Tập route "thu hẹp" (spec SP3 §12): thêm một route là thay đổi review được. 3C, 3D thêm route của mình. */
export const NARROWING_ROUTES: readonly string[] = ['DELETE v1/orgs/:orgId/members/me'];
/** Hai route ghi không mang marker nào (public, chỉ đọc; body POST chỉ để token không vào URL; route có ở 3C). */
export const MARKER_EXEMPT_ROUTES: readonly string[] = ['POST v1/invitations/preview', 'POST v1/invite-links/preview'];
```
`src/modules/tenancy/http/decorators.ts`:
```ts
import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { RequireFreshSession, RequireVerifiedEmail, SessionOnly } from '../../identity/index.js';
import { defineCatalogue, type CatalogueDef, type CatalogueEntryDef } from '../domain/catalogue.js';
import { PoliciesGuard } from './policies.guard.js';
import { TENANCY_NARROWING, TENANCY_POLICY, TENANCY_SENSITIVE, type TenancyPolicy } from './policy-metadata.js';

export {
  MARKER_EXEMPT_ROUTES,
  NARROWING_ROUTES,
  TENANCY_NARROWING,
  TENANCY_POLICY,
  TENANCY_SENSITIVE,
  type TenancyPolicy,
} from './policy-metadata.js';
export type PermissionCatalogue<K extends string> = CatalogueDef<K> & {
  require(...keys: [K, ...K[]]): ClassDecorator & MethodDecorator;
};

/**
 * Catalogue quyền có decorator `require(...keys)` (spec SP3 §8.2): mọi key phải đạt; sai key là lỗi compile. Metadata
 * mang chính đối tượng catalogue để `OrgRouteInventory` kiểm nó đã được đăng ký (INT3-5a). Đặt ở `http/` vì cần
 * `PoliciesGuard` (luật `domain-pure`); phần thuần nằm ở `domain/catalogue.ts`.
 */
export function definePermissionCatalogue<const D extends Record<string, CatalogueEntryDef>>(
  name: string,
  entries: D,
): PermissionCatalogue<Extract<keyof D, string>> {
  const def = defineCatalogue(name, entries);
  const catalogue: PermissionCatalogue<Extract<keyof D, string>> = {
    ...def,
    require: (...keys) =>
      applyDecorators(SetMetadata(TENANCY_POLICY, { kind: 'PERMISSIONS', catalogue, keys } satisfies TenancyPolicy), UseGuards(PoliciesGuard)),
  };
  return catalogue;
}

/** Mọi principal `via = MEMBERSHIP` (support grant, org key bị từ chối). */
export const OrgMemberOnly = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(TENANCY_POLICY, { kind: 'MEMBER_ONLY' } satisfies TenancyPolicy), UseGuards(PoliciesGuard));

/** Mutation cấp/đổi quyền: session mới + email đã xác thực + chỉ session, bất kể `AUTH_REQUIRE_EMAIL_VERIFICATION`. */
export const SensitiveTenancyAction = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(TENANCY_SENSITIVE, true), SessionOnly(), RequireFreshSession(), RequireVerifiedEmail());
/** Route chỉ thu hồi/thu hẹp (SEC3-2): chỉ session; phải có trong `NARROWING_ROUTES`. */
export const NarrowingTenancyAction = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(TENANCY_NARROWING, true), SessionOnly());
```
`src/modules/tenancy/http/policies.guard.ts`:
```ts
import { ForbiddenError } from '@casl/ability';
import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { buildAbility } from '../application/authz/ability.factory.js';
import { PermissionCatalogueRegistry } from '../application/permission-catalogue.registry.js';
import { TenancyMetrics } from '../application/tenancy-metrics.js';
import { UnknownPermissionError } from '../domain/catalogue.js';
import { TENANCY_TRACER } from '../tenancy-telemetry.js';
import { ORG_RESTORE_TEMPLATE, RequestMethodName, routeTemplateOf } from './org-route.js';
import { TENANCY_POLICY, type TenancyPolicy } from './policy-metadata.js';

/** So method bằng tên (`RequestMethodName`), không phụ thuộc giá trị số của enum `RequestMethod`. */
const POST = 'POST';

/**
 * Route-scoped (spec SP3 §7.1 bước 5): luôn chạy sau mọi APP_GUARD. Quyết định chỉ là tư vấn cho mutation quản trị
 * (service kiểm lại dưới khoá org, §8.6). `ForbiddenError.message` (action/subject) chỉ vào log, không vào body (SEC-M10).
 */
@Injectable()
export class PoliciesGuard implements CanActivate {
  private readonly logger = new Logger(PoliciesGuard.name);
  private readonly restoreHandlers = new WeakMap<Function, boolean>();

  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContext,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
  ) {}

  /**
   * Span `tenancy.policy.check` (spec SP3 §16, review M4) với `tenancy.policy.result` ∈ `allowed | denied | error` (enum
   * hữu hạn, không key quyền, không org/user). Span mở đồng bộ (`startActiveSpan` trả nguyên giá trị của callback), nên
   * `canActivate` vẫn đồng bộ như test đơn vị của guard đòi.
   */
  canActivate(context: ExecutionContext): boolean {
    return trace.getTracer(TENANCY_TRACER).startActiveSpan('tenancy.policy.check', (span) => {
      try {
        const allowed = this.decide(context);
        span.setAttribute('tenancy.policy.result', 'allowed');
        return allowed;
      } catch (err) {
        const denied = err instanceof AppError && err.error === CoreErrors.FORBIDDEN;
        span.setAttributes({ 'tenancy.policy.result': denied ? 'denied' : 'error', 'error.type': err instanceof Error ? err.constructor.name : typeof err });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private decide(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const policy = this.reflector.getAllAndOverride<TenancyPolicy | undefined>(TENANCY_POLICY, [handler, context.getClass()]);
    if (!policy) throw new Error('PoliciesGuard reached a handler without tenancy policy metadata');
    const access = this.ctx.orgAccess();
    if (!access) throw new Error('PoliciesGuard found no orgAccess on a tenant route (OrgContextMiddleware did not run)');
    if (access.orgDeleted && !this.isRestoreHandler(context.getClass(), handler))
      throw new Error('PoliciesGuard: a soft-deleted organization reached a handler other than restore');
    switch (policy.kind) {
      case 'MEMBER_ONLY':
        if (access.via !== 'MEMBERSHIP') this.deny('member_only', undefined);
        return true;
      case 'PERMISSIONS':
        this.requireAll(policy.keys, access.permissions);
        return true;
      default: {
        const unknown: never = policy;
        throw new Error(`unknown tenancy policy ${JSON.stringify(unknown)}`);
      }
    }
  }

  private requireAll(keys: readonly string[], permissions: readonly string[]): void {
    const merged = this.registry.merged();
    const ability = buildAbility(permissions, merged);
    for (const key of keys) {
      const entry = merged.get(key);
      if (!entry) throw new UnknownPermissionError(key);
      try {
        ForbiddenError.from(ability).throwUnlessCan(entry.action, entry.resource);
      } catch (err) {
        // G-5: chỉ lỗi của CASL thành 403; so bằng instanceof, không bằng tên class.
        if (err instanceof ForbiddenError) this.deny('permission', key);
        throw err;
      }
    }
  }

  private deny(reason: 'permission' | 'member_only', missing: string | undefined): never {
    this.metrics.policyDenied.add(1, { reason });
    this.logger.warn({ event: 'policy_denied', reason, ...(missing ? { missing } : {}) }, 'tenancy policy denied the request');
    throw new AppError(CoreErrors.FORBIDDEN, { expected: true });
  }

  private isRestoreHandler(controller: Function, handler: Function): boolean {
    const cached = this.restoreHandlers.get(handler);
    if (cached !== undefined) return cached;
    const method: unknown = this.reflector.get(METHOD_METADATA, handler);
    const isPost = typeof method === 'number' && RequestMethodName[method] === POST;
    const value = isPost && routeTemplateOf(controller, handler).includes(ORG_RESTORE_TEMPLATE);
    this.restoreHandlers.set(handler, value);
    return value;
  }
}
```
`src/modules/tenancy/http/org-route.ts` — bổ sung bảng tên method dùng chung cho guard và inventory:
```ts
import { RequestMethod } from '@nestjs/common';
/** Tên HTTP của `RequestMethod` (enum số của Nest 12.1). */
export const RequestMethodName: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(RequestMethod).filter((e): e is [string, number] => typeof e[1] === 'number').map(([name, n]) => [n, name]),
);
```

`src/modules/tenancy/application/org-route-inventory.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from '../../../core/http/index.js';
import {
  MARKER_EXEMPT_ROUTES,
  NARROWING_ROUTES,
  TENANCY_NARROWING,
  TENANCY_POLICY,
  TENANCY_SENSITIVE,
  type TenancyPolicy,
} from '../http/policy-metadata.js';
import { ORG_RESTORE_TEMPLATE, RequestMethodName, classifyOrgRoute, routeTemplateOf } from '../http/org-route.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

/** Module có controller của tenancy (G-8): tenancy cung cấp giá trị ở `forApi()`; unit test so với cây import. */
export const TENANCY_CONTROLLER_MODULES = Symbol('TENANCY_CONTROLLER_MODULES');
const DECLARABLE = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

type Route = { id: string; method: string; template: string; controller: Function; handler: Function; tenancy: boolean };

/**
 * Kiểm lúc khởi động của api (spec SP3 §7.1, PR22, G-1, G-8, R4A-N5, INT3-5a): vi phạm → log ERROR + app không khởi
 * động. Chạy sau `PermissionCatalogueRegistry.onModuleInit`. Đo thời gian (tiêu chí 17: kiểm route + catalogue < 200 ms).
 */
@Injectable()
export class OrgRouteInventory implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrgRouteInventory.name);
  private readonly scanner = new MetadataScanner();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly registry: PermissionCatalogueRegistry,
    @Inject(TENANCY_CONTROLLER_MODULES) private readonly tenancyModules: readonly Type[],
  ) {}

  onApplicationBootstrap(): void {
    const started = performance.now();
    const problems = this.check();
    const durationMs = Math.round(performance.now() - started);
    if (problems.length === 0) {
      this.logger.log({ event: 'org_route_inventory', durationMs }, 'tenant route inventory passed');
      return;
    }
    this.logger.error({ event: 'org_route_inventory_failed', problems }, 'tenant route inventory failed');
    throw new Error(`Tenant route inventory failed: ${problems.join('; ')}`);
  }

  check(): string[] {
    const routes = this.routes();
    const problems: string[] = [];
    for (const r of routes) problems.push(...this.checkRoute(r));
    const restores = routes.filter((r) => r.method === 'POST' && r.template === ORG_RESTORE_TEMPLATE);
    if (restores.length !== 1) problems.push(`exactly one POST ${ORG_RESTORE_TEMPLATE} handler, found ${restores.length}`);
    const narrowing = routes.filter((r) => r.tenancy && this.flag(TENANCY_NARROWING, r)).map((r) => r.id);
    const added = narrowing.filter((id) => !NARROWING_ROUTES.includes(id)).map((id) => `+${id}`);
    const missing = NARROWING_ROUTES.filter((id) => !narrowing.includes(id) && routes.some((r) => r.id === id)).map((id) => `-${id}`);
    if (added.length || missing.length) problems.push(`narrowing routes differ from NARROWING_ROUTES: ${[...added, ...missing].join(', ')}`);
    return problems;
  }

  private checkRoute(r: Route): string[] {
    const out: string[] = [];
    const policy = this.reflector.getAllAndOverride<TenancyPolicy | undefined>(TENANCY_POLICY, [r.handler, r.controller]);
    const kind = classifyOrgRoute(r.template);
    if (kind === 'INVALID') out.push(`${r.id}: routes under v1/orgs/ must name the org parameter :orgId`);
    if (kind === 'TENANT' && !policy) out.push(`${r.id}: tenant route without a permission decorator or @OrgMemberOnly`);
    if (kind === 'TENANT' && this.flag(PUBLIC_ROUTE, r)) out.push(`${r.id}: tenant route must not be @PublicRoute`);
    if (kind === 'OTHER' && policy) out.push(`${r.id}: permission decorator on a non-tenant route`);
    if (policy?.kind === 'PERMISSIONS') {
      if (!this.registry.has(policy.catalogue)) out.push(`${r.id}: catalogue "${policy.catalogue.name}" is not registered (@PermissionCatalogueContributor missing)`);
      else for (const k of policy.keys) if (!this.registry.merged().has(k)) out.push(`${r.id}: key "${k}" is not in the merged catalogue`);
    }
    if (r.tenancy) {
      if (!DECLARABLE.has(r.method)) out.push(`${r.id}: tenancy controllers may only declare GET, POST, PUT, PATCH, DELETE`);
      else if (r.method !== 'GET' && !MARKER_EXEMPT_ROUTES.includes(r.id)) {
        const markers = [this.flag(TENANCY_SENSITIVE, r), this.flag(TENANCY_NARROWING, r)].filter(Boolean).length;
        if (markers !== 1) out.push(`${r.id}: a tenancy write route needs exactly one of @SensitiveTenancyAction/@NarrowingTenancyAction`);
      }
    }
    return out;
  }

  private flag(key: string, r: Route): boolean {
    return this.reflector.getAllAndOverride<boolean | undefined>(key, [r.handler, r.controller]) === true;
  }

  private routes(): Route[] {
    const tenancyControllers = new Set(
      this.discovery.getControllers({ include: [...this.tenancyModules] }).map((w) => w.metatype),
    );
    const out: Route[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const proto: object = controller.prototype;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler: unknown = Reflect.get(proto, name);
        if (typeof handler !== 'function' || this.reflector.get(PATH_METADATA, handler) === undefined) continue;
        const methodNo: unknown = this.reflector.get(METHOD_METADATA, handler);
        const method = typeof methodNo === 'number' ? (RequestMethodName[methodNo] ?? String(methodNo)) : 'GET';
        for (const template of routeTemplateOf(controller, handler))
          out.push({ id: `${method} ${template}`, method, template, controller, handler, tenancy: tenancyControllers.has(controller) });
      }
    }
    return out;
  }
}
```
`src/modules/tenancy/permissions.ts`:
```ts
import { TENANCY_CATALOGUE } from './domain/tenancy-catalogue.js';
import { definePermissionCatalogue } from './http/decorators.js';

/** Catalogue tenancy có `require(...)`; đây là đối tượng đăng ký vào registry (INT3-5a so danh tính đối tượng). */
export const TenancyPermissions = definePermissionCatalogue(TENANCY_CATALOGUE.name, TENANCY_CATALOGUE.entries);
```
`src/modules/tenancy/tenancy.module.ts`: đổi `@PermissionCatalogueContributor(TENANCY_CATALOGUE)` thành `@PermissionCatalogueContributor(TenancyPermissions)` (import từ `./permissions.js`, bỏ import `TENANCY_CATALOGUE`).
`src/modules/tenancy/index.ts` thêm:
```ts
export { definePermissionCatalogue, OrgMemberOnly, type PermissionCatalogue } from './http/decorators.js';
```

- [ ] **Step 5: Chạy, kiểm kiến trúc, commit**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/tenancy
pnpm typecheck && pnpm lint && pnpm arch
```
Expected: PASS; `@casl/ability` chỉ xuất hiện trong `application/authz/**` và `http/**` (luật 17 xanh trên cây thật).
```bash
git add src/modules/tenancy test/unit/modules/tenancy
git commit -m "feat(tenancy): tenant route matcher, permission decorators, PoliciesGuard and the boot-time route inventory"
```

---

### Task 22: `OrgContextMiddleware` (đường nóng, 404 thống nhất, limiter org-miss), quyền hiệu lực, `OrgScopeInterceptor` — e2e pipeline, T6, G-3, G-7, EXPLAIN

**Files:**
- Create: `src/modules/tenancy/ports/access-reader.ts`, `src/modules/tenancy/infra/sql/sql-access.reader.ts`, `src/modules/tenancy/application/authz/effective-permissions.ts`, `src/modules/tenancy/http/org-context.middleware.ts`, `src/modules/tenancy/http/org-scope.interceptor.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`
- Create (test): `test/support/tenancy-app.ts`, `test/e2e/tenancy/fixtures/probe.module.ts`, `test/e2e/tenancy/org-context.e2e.spec.ts`, `test/e2e/tenancy/tenancy-http-boot.e2e.spec.ts`, `test/e2e/tenancy/org-miss-limiter.e2e.spec.ts`, `test/e2e/tenancy/org-scoped-throttle.e2e.spec.ts`, `test/e2e/tenancy/middleware-order.ts`, `test/e2e/tenancy/middleware-order-identity-first.e2e.spec.ts`, `test/e2e/tenancy/middleware-order-tenancy-first.e2e.spec.ts`, `test/integration/tenancy/hot-path-explain.spec.ts`, `test/unit/modules/tenancy/effective-permissions.spec.ts`
- Modify: `src/modules/tenancy/tenancy.module.ts`, `test/support/app-factory.ts` (`configure`, `nestedIn`), `test/support/identity-app.ts` (`identityDepth`, `configure`)

**Interfaces:**
- Consumes: `PrincipalResolver.ensure` (Task 9), `RateLimitBuckets` (Task 5), `RequestContext.setOrgId/setOrgAccess` (Task 5), `OrgScope`, `UnitOfWork`, `isDbInfraError` (SP1), `SubjectResolver` (Task 20), `PermissionCatalogueRegistry`, `TenancyMetrics`, `tenancySpan`, `tenancyConfig` (Task 19), `ORG_ROUTE_PATTERN`, `isOrgRestoreRequest`, `routeTemplateOf`, `classifyOrgRoute`, `TENANCY_POLICY` (Task 21), `systemRolePermissions` (Task 17), `identityGuardConfig.unavailableRetryAfterSec` (SP2), `seedOrg`/`seedMember` (Task 14), `seedUserPrincipal` (Task 10), `createScratchDb` (Task 2).
- Produces:
  - `type MembershipLookup = { org: 'MISSING' } | { org: 'PRESENT'; deletedAt: Date | null; member: { id: string; publicId: string; roleId: string; systemKey: SystemRoleKey | null } | null }`; `AccessReader.lookup(s: TenancySubject): Promise<MembershipLookup>` (trong OrgScope; một câu, spec §7.3); `HOT_PATH_SQL: Record<TenancySubject['kind'], string>` (export cho test EXPLAIN).
  - `effectivePermissions(role: { systemKey: SystemRoleKey | null }, merged): string[]` (role tuỳ biến → ném: 3B mới có).
  - `ORG_MISS_BUCKET` + `orgMissBucketProvider` (provider singleton đăng ký bucket `tenancy.org-miss` đúng một lần mỗi app, review C1); `OrgContextMiddleware` (inject handle bucket, constructor không side effect; span `tenancy.org_context.resolve`, metric `tenancy_org_access_total`, `tenancy_org_context_duration_seconds`); `OrgScopeInterceptor` (`APP_INTERCEPTOR`); `TenancyHttpModule` (`forRoutes(ORG_ROUTE_PATTERN)`), nạp ở `TenancyModule.forApi()`.
  - Test support: `buildTestApp/createTestApp(…, { configure })`, `nestedIn(mod, depth)`; `startIdentityApp({ identityDepth, configure })`; `startTenancyApp(opts: { env?; extraImports?; configure?; identityDepth?; tenancyDepth? })`, `authed(app, p: SeededPrincipal)` (supertest agent có bearer).

- [ ] **Step 1: Quyền hiệu lực (unit, fail → pass)**

`test/unit/modules/tenancy/effective-permissions.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { effectivePermissions } from '../../../../src/modules/tenancy/application/authz/effective-permissions.js';
import { mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';

const merged = mergeCatalogues([TenancyPermissions]);

describe('effectivePermissions (spec SP3 §7.1 bước 3.9, §8.3)', () => {
  it.each(['OWNER', 'ADMIN', 'MEMBER'] as const)('%s = the system role set, sorted', (k) => {
    expect(effectivePermissions({ systemKey: k }, merged)).toEqual([...systemRolePermissions(k, merged)].sort());
  });
  it('a custom role row on the 3A hot path fails loud (custom roles arrive with plan 3B)', () => {
    expect(() => effectivePermissions({ systemKey: null }, merged)).toThrow(/custom roles/);
  });
});
```
`src/modules/tenancy/application/authz/effective-permissions.ts`:
```ts
import type { SystemRoleKey } from '../../constants.js';
import type { MergedCatalogue } from '../../domain/catalogue.js';
import { systemRolePermissions } from '../../domain/system-roles.js';

/**
 * Quyền hiệu lực của principal member (spec SP3 §7.1 bước 3.9): role hệ thống tính trong code từ catalogue gộp, không
 * cache (PR18). Role tuỳ biến (3B thêm câu thứ hai của đường nóng) chưa tồn tại ở 3A: một dòng như vậy chỉ có thể do SQL
 * tay tạo ra → lỗi 500 có log, không bao giờ âm thầm cấp tập rỗng. Plan 3B thay nhánh này (Bảng 5 của spec).
 */
export function effectivePermissions(role: { systemKey: SystemRoleKey | null }, merged: MergedCatalogue): string[] {
  if (role.systemKey === null) throw new Error('custom roles are introduced by plan 3B; a custom role reached the 3A hot path');
  return [...systemRolePermissions(role.systemKey, merged)].sort();
}
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/effective-permissions.spec.ts`
Expected: PASS.

- [ ] **Step 2: Câu đường nóng**

`src/modules/tenancy/ports/access-reader.ts`:
```ts
import type { SystemRoleKey } from '../constants.js';
import type { TenancySubject } from './tenancy-user-repository.js';

export type MembershipLookup =
  | { org: 'MISSING' }
  | {
      org: 'PRESENT';
      deletedAt: Date | null;
      member: { id: string; publicId: string; roleId: string; systemKey: SystemRoleKey | null } | null;
    };
/** Đường nóng (spec SP3 §7.3): một câu trong OrgScope của org trên path. Không tạo `tenancy_users` (Review Focus 2). */
export abstract class AccessReader {
  abstract lookup(s: TenancySubject): Promise<MembershipLookup>;
}
```
`src/modules/tenancy/infra/sql/sql-access.reader.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import { AccessReader, type MembershipLookup } from '../../ports/access-reader.js';
import type { TenancySubject } from '../../ports/tenancy-user-repository.js';

const hotPath = (subjectFilter: string): string =>
  `WITH u AS (SELECT id FROM tenancy_users WHERE ${subjectFilter})
SELECT o.deleted_at, m.id::text AS member_id, m.public_id::text AS member_public_id, r.id::text AS role_id, r.system_key
FROM organizations o
LEFT JOIN org_members m ON m.org_id = o.id AND m.user_id = (SELECT id FROM u)
LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
WHERE o.id = app_current_org()`;
/**
 * Index dùng (spec SP3 §7.3): `tenancy_users_auth_user_uq`/`tenancy_users_external_subject_uq`, PK `organizations`,
 * `org_members_org_user_uq`, `org_roles_org_id_uq`. Principal chưa từng chạm tenancy: `u` rỗng → member NULL → trượt.
 */
export const HOT_PATH_SQL: Record<TenancySubject['kind'], string> = {
  AUTH_USER: hotPath('auth_user_id = ?::uuid'),
  EXTERNAL: hotPath('external_subject = ?'),
};
const Row = z.object({
  deleted_at: z.coerce.date().nullable(),
  member_id: z.string().nullable(),
  member_public_id: z.string().nullable(),
  role_id: z.string().nullable(),
  system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
});

@Injectable()
export class SqlAccessReader extends AccessReader {
  constructor(private readonly db: Db) {
    super();
  }
  async lookup(s: TenancySubject): Promise<MembershipLookup> {
    const value = s.kind === 'AUTH_USER' ? s.authUserId : s.externalSubject;
    const rows = await this.db.execute(HOT_PATH_SQL[s.kind], [value]);
    if (rows.length === 0) return { org: 'MISSING' };
    if (rows.length > 1) throw new Error(`membership lookup returned ${rows.length} rows (expected at most one)`);
    const r = Row.parse(rows[0]);
    if (r.member_id === null) return { org: 'PRESENT', deletedAt: r.deleted_at, member: null };
    if (r.member_public_id === null || r.role_id === null)
      throw new Error('membership lookup returned a member without its role (composite FK violated?)');
    return {
      org: 'PRESENT',
      deletedAt: r.deleted_at,
      member: { id: r.member_id, publicId: r.member_public_id, roleId: r.role_id, systemKey: r.system_key },
    };
  }
}
```

- [ ] **Step 3: Middleware, interceptor, module HTTP**

`src/modules/tenancy/http/org-context.middleware.ts`:
```ts
import { type FactoryProvider, Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext, type Principal } from '../../../core/context/index.js';
import { OrgScope, UnitOfWork, isDbInfraError } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { RateLimitBuckets, type RateLimitBucket } from '../../../core/http/index.js';
import { PrincipalResolver, identityGuardConfig } from '../../identity/index.js';
import { effectivePermissions } from '../application/authz/effective-permissions.js';
import { PermissionCatalogueRegistry } from '../application/permission-catalogue.registry.js';
import { SubjectResolver } from '../application/subject-resolver.js';
import { TenancyMetrics, type OrgAccessResult } from '../application/tenancy-metrics.js';
import { TenancyErrors } from '../errors.js';
import { AccessReader, type MembershipLookup } from '../ports/access-reader.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { isOrgRestoreRequest } from './org-route.js';

type OrgRequest = IncomingMessage & { ip?: string; params?: Record<string, unknown> };
const OrgIdParam = z.uuid();
const MS_PER_SEC = 1000;

/** Token của handle bucket `tenancy.org-miss` (một instance mỗi app). */
export const ORG_MISS_BUCKET = Symbol('tenancy.org-miss');
/**
 * Review C1: Nest dựng middleware qua `MiddlewareContainer` riêng (`Injector.loadMiddleware`), KHÔNG dùng lại instance
 * provider, nên constructor của một middleware có thể chạy nhiều lần. Việc đăng ký bucket (ném khi trùng tên) vì vậy
 * nằm ở provider singleton này, không ở constructor của middleware.
 */
export const orgMissBucketProvider: FactoryProvider<RateLimitBucket> = {
  provide: ORG_MISS_BUCKET,
  inject: [RateLimitBuckets, tenancyConfig.KEY],
  useFactory: (buckets: RateLimitBuckets, cfg: ConfigOf<typeof tenancyConfig>): RateLimitBucket =>
    buckets.register({ owner: 'tenancy', name: 'org-miss', ttlMs: cfg.orgMissTtlMs, limit: cfg.orgMissLimit, refundable: false }),
};

/**
 * Spec SP3 §7.1 bước 3 (đăng ký `forRoutes(ORG_ROUTE_PATTERN)`, chạy trước throttler và idempotency). Mọi nhánh trượt
 * trả `404` từ MỘT chỗ; chỉ lần trượt thật ghi vào bucket `tenancy.org-miss` (peek trước, consume ngay trước `throw`).
 * Lỗi hạ tầng khi tra → `503` + `Retry-After`, không consume (SEC2-N6). Race T-33 (peek ∥ consume) được chấp nhận.
 * Constructor không có side effect (review C1): Nest được phép dựng lớp này nhiều lần.
 */
@Injectable()
export class OrgContextMiddleware implements NestMiddleware {
  constructor(
    private readonly principals: PrincipalResolver,
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly reader: AccessReader,
    private readonly subjects: SubjectResolver,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
    @Inject(ORG_MISS_BUCKET) private readonly orgMiss: RateLimitBucket,
    @Inject(identityGuardConfig.KEY) private readonly guard: ConfigOf<typeof identityGuardConfig>,
  ) {}

  async use(req: OrgRequest, res: ServerResponse, next: () => void): Promise<void> {
    await this.principals.ensure(req, res);
    const principal = this.ctx.principal();
    if (!principal) {
      next();
      return;
    }
    const raw = req.params?.['orgId'];
    if (typeof raw !== 'string') throw new Error('OrgContextMiddleware is mounted on a route without :orgId');
    const parsed = OrgIdParam.safeParse(raw);
    if (!parsed.success) throw new AppError(CoreErrors.ORG_CONTEXT_INVALID, { detail: 'orgId must be a UUID' });
    const orgId = parsed.data.toLowerCase();
    await tenancySpan(
      'tenancy.org_context.resolve',
      () => this.resolve(req, principal, orgId),
      (result) => ({ 'tenancy.access.via': 'MEMBERSHIP', 'tenancy.access.result': result }),
    );
    next();
  }

  private async resolve(req: OrgRequest, principal: Principal, orgId: string): Promise<OrgAccessResult> {
    if (this.ctx.credential()?.kind === 'API_KEY') {
      this.count('user_key_rejected');
      throw new AppError(TenancyErrors.API_KEY_NOT_ORG_SCOPED);
    }
    const limiterKey = `principal:${principal.type}:${principal.id}`;
    const peek = await this.orgMiss.peek(limiterKey);
    if (peek.blocked) {
      this.count('rate_limited');
      throw new AppError(CoreErrors.RATE_LIMITED, { headers: { 'Retry-After': String(peek.retryAfterSec) }, expected: true });
    }
    const lookup = await this.lookup(principal, orgId);
    const member = this.admitted(req, lookup);
    if (!member) {
      // Chỗ DUY NHẤT ghi vào limiter; lần consume làm vượt ngưỡng vẫn trả 404 (bị khoá từ request sau).
      await this.orgMiss.consume(limiterKey);
      this.count('not_found');
      throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    }
    const permissions = effectivePermissions(member, this.registry.merged());
    // OrgScope.run chỉ đặt org trong CLS con: đặt tường minh ở context của request (bước 3.9).
    this.ctx.setOrgId(orgId);
    this.ctx.setOrgAccess({ via: 'MEMBERSHIP', ref: member.publicId, permissions, orgDeleted: lookup.org === 'PRESENT' && lookup.deletedAt !== null });
    this.count('granted');
    return 'granted';
  }

  /** Trúng = org có dòng + là member + (org hoạt động, hoặc route khôi phục trên org xoá mềm). */
  private admitted(req: OrgRequest, lookup: MembershipLookup) {
    if (lookup.org === 'MISSING' || lookup.member === null) return undefined;
    if (lookup.deletedAt !== null && !isOrgRestoreRequest(req)) return undefined;
    return lookup.member;
  }

  private async lookup(principal: Principal, orgId: string): Promise<MembershipLookup> {
    const started = performance.now();
    try {
      return await this.scope.run(orgId, () => this.uow.run(() => this.reader.lookup(this.subjects.of(principal))));
    } catch (err) {
      if (!isDbInfraError(err)) throw err;
      this.count('unavailable');
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        headers: { 'Retry-After': String(this.guard.unavailableRetryAfterSec) },
        // Không gắn `cause`: với `expected: true` filter log `cause` nguyên văn, mà lỗi pg có thể mang giá trị khoá.
        expected: true,
      });
    } finally {
      this.metrics.orgContextDuration.record((performance.now() - started) / MS_PER_SEC);
    }
  }

  private count(result: OrgAccessResult): void {
    this.metrics.orgAccess.add(1, { via: 'MEMBERSHIP', result });
  }
}
```

`src/modules/tenancy/http/org-scope.interceptor.ts`:
```ts
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { RequestContext } from '../../../core/context/index.js';
import { OrgScope } from '../../../core/database/index.js';
import { classifyOrgRoute, routeTemplateOf } from './org-route.js';
import { TENANCY_POLICY } from './policy-metadata.js';

/**
 * `APP_INTERCEPTOR` (spec SP3 §7.1 bước 7): route tenant chạy handler (và `IdempotencyInterceptor` của route, vốn nằm
 * trong interceptor toàn cục) trong `OrgScope(ctx.orgId())`. Thiếu metadata phân quyền hoặc `orgAccess` → ném (lớp
 * fail-closed thứ hai sau `OrgRouteInventory`). Phân loại cache theo handler, cùng matcher với inventory.
 */
@Injectable()
export class OrgScopeInterceptor implements NestInterceptor {
  private readonly tenantHandlers = new WeakMap<Function, boolean>();

  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !this.isTenant(context.getClass(), context.getHandler())) return next.handle();
    if (!this.reflector.getAllAndOverride(TENANCY_POLICY, [context.getHandler(), context.getClass()]))
      throw new Error('OrgScopeInterceptor: tenant route without tenancy policy metadata');
    const orgId = this.ctx.orgId();
    if (!this.ctx.orgAccess() || orgId === undefined) throw new Error('OrgScopeInterceptor: tenant route without orgAccess');
    return from(this.scope.run(orgId, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }

  private isTenant(controller: Function, handler: Function): boolean {
    const cached = this.tenantHandlers.get(handler);
    if (cached !== undefined) return cached;
    const value = routeTemplateOf(controller, handler).some((t) => classifyOrgRoute(t) === 'TENANT');
    this.tenantHandlers.set(handler, value);
    return value;
  }
}
```
`src/modules/tenancy/http/tenancy-http.module.ts`:
```ts
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SqlAccessReader } from '../infra/sql/sql-access.reader.js';
import { AccessReader } from '../ports/access-reader.js';
import { OrgContextMiddleware, orgMissBucketProvider } from './org-context.middleware.js';
import { ORG_ROUTE_PATTERN } from './org-route.js';
import { OrgScopeInterceptor } from './org-scope.interceptor.js';

/**
 * Chỉ ở api. Controller của tenancy (Task 23, 24) khai ở đây; `TENANCY_CONTROLLER_MODULES` liệt kê module này.
 * `OrgContextMiddleware` KHÔNG nằm trong `providers` (review C1): Nest resolve middleware qua `consumer.apply` với DI của
 * chính module này; khai thêm ở `providers` chỉ dựng một instance thừa.
 */
@Module({
  providers: [SqlAccessReader, { provide: AccessReader, useExisting: SqlAccessReader }, orgMissBucketProvider, { provide: APP_INTERCEPTOR, useClass: OrgScopeInterceptor }],
})
export class TenancyHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // MỘT pattern: middleware chạy đúng một lần mỗi request (spec SP3 §7.4, INT3-2).
    consumer.apply(OrgContextMiddleware).forRoutes(ORG_ROUTE_PATTERN);
  }
}
```
`src/modules/tenancy/tenancy.module.ts`: `forApi()` đổi thành `imports: [TenancyCoreModule, TenancyHttpModule]`.

- [ ] **Step 4: Harness test**

`test/support/app-factory.ts`:
1. Import thêm `Module` từ `@nestjs/common` và `type TestingModuleBuilder` từ `@nestjs/testing`.
2. `buildTestApp(imports, opts: { bodyParser?: boolean; configure?: (b: TestingModuleBuilder) => TestingModuleBuilder } = {})`: thay `await Test.createTestingModule({...}).compile()` bằng
```ts
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: configFactories() }),
      ContextModule,
      ...imports,
    ],
    providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
  });
  const moduleRef = await (opts.configure ? opts.configure(builder) : builder).compile();
```
3. `createTestApp` nhận thêm `configure` trong `opts` (cùng kiểu) và truyền nguyên `opts` cho `buildTestApp`.
4. Thêm cuối file:
```ts
/**
 * Bọc `mod` trong `depth` module rỗng. Nest sắp middleware theo `distance` (độ sâu lớn nhất trong cây import), nên đây
 * là cách test dựng được cả hai thứ tự `PrincipalMiddleware`/`OrgContextMiddleware` (spec SP3 §7.1 bước 2, T6).
 */
export function nestedIn(mod: ModuleImport, depth: number): ModuleImport {
  let current = mod;
  for (let i = 0; i < depth; i++) {
    const inner = current;
    @Module({ imports: [inner] })
    class NestingModule {}
    current = NestingModule;
  }
  return current;
}
```
`test/support/identity-app.ts`: `IdentityAppOpts` thêm `identityDepth?: number; configure?: (b: TestingModuleBuilder) => TestingModuleBuilder`; trong `identityImports` thay `IdentityModule.forApi()` bằng `nestedIn(IdentityModule.forApi(), opts.identityDepth ?? 0)`; `buildIdentityApp` gọi `buildTestApp(identityImports(opts), { bodyParser: false, configure: opts.configure })`, `startIdentityApp` gọi `createTestApp(identityImports(opts), { beforeInit: applyHttpDefaults, bodyParser: false, configure: opts.configure })`.

`test/support/tenancy-app.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { SchedulerModule } from '../../src/core/scheduler/index.js';
import { TenancyModule } from '../../src/modules/tenancy/index.js';
import { nestedIn, type ModuleImport } from './app-factory.js';
import { startIdentityApp } from './identity-app.js';
import type { SeededPrincipal } from './tenancy-principals.js';

export type TenancyAppOpts = {
  env?: Record<string, string>;
  extraImports?: ModuleImport[];
  configure?: (b: TestingModuleBuilder) => TestingModuleBuilder;
  identityDepth?: number;
  tenancyDepth?: number;
};

/**
 * App e2e của identity (api + worker events/notifications, relay chạy) cộng `SchedulerModule` (không worker: service vòng
 * đời org treo/khôi phục lịch, như `AppApiModule`) và `TenancyModule.forApi()`.
 */
export function startTenancyApp(opts: TenancyAppOpts = {}): Promise<INestApplication> {
  return startIdentityApp({
    env: opts.env,
    configure: opts.configure,
    identityDepth: opts.identityDepth,
    extraImports: [
      SchedulerModule.forRoot({ worker: false }),
      nestedIn(TenancyModule.forApi(), opts.tenancyDepth ?? 0),
      ...(opts.extraImports ?? []),
    ],
  });
}

/** Request với bearer của principal seed (plugin `bearer`). */
export const authed = (app: INestApplication, p: SeededPrincipal) => {
  const agent = request(app.getHttpServer());
  const auth = `Bearer ${p.bearer}`;
  return {
    get: (url: string) => agent.get(url).set('authorization', auth),
    post: (url: string) => agent.post(url).set('authorization', auth),
    patch: (url: string) => agent.patch(url).set('authorization', auth),
    delete: (url: string) => agent.delete(url).set('authorization', auth),
  };
};
```
`test/e2e/tenancy/fixtures/probe.module.ts`:
```ts
import { Controller, Get, Module, Post } from '@nestjs/common';
import { RequestContext } from '../../../../src/core/context/index.js';
import { Idempotent } from '../../../../src/core/http/index.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';

/** Route tenant giả của `features/` (không thuộc module tenancy nên không vào luật G-8): quan sát context của request. */
@Controller('v1/orgs/:orgId/probe')
class ProbeController {
  private created = 0;
  constructor(private readonly ctx: RequestContext) {}

  @Get()
  @TenancyPermissions.require('org.read')
  read() {
    const a = this.ctx.orgAccess();
    return { orgId: this.ctx.orgId(), via: a?.via, ref: a?.ref, permissions: a?.permissions };
  }

  @Get('owner-only')
  @TenancyPermissions.require('org.delete')
  ownerOnly() {
    return { ok: true };
  }

  @Post('idem')
  @Idempotent()
  @TenancyPermissions.require('org.read')
  idem() {
    this.created += 1;
    return { n: this.created, orgId: this.ctx.orgId() };
  }
}
@Module({ controllers: [ProbeController] })
export class TenancyProbeModule {}
```

- [ ] **Step 5: E2E pipeline (fail trước Step 2–3)**

`test/e2e/tenancy/org-context.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v4, v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PoliciesGuard } from '../../../src/modules/tenancy/http/policies.guard.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';
import { TenancyProbeModule } from './fixtures/probe.module.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const VOLATILE_HEADERS = new Set(['date', 'x-request-id']);
/** Spec SP3 §18.2: mọi header trừ Date/X-Request-Id, body trừ instance/requestId/timestamp. */
const shape = (r: request.Response) => ({
  status: r.status,
  headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !VOLATILE_HEADERS.has(k))),
  body: Object.fromEntries(Object.entries(r.body as Record<string, unknown>).filter(([k]) => !['instance', 'requestId', 'timestamp'].includes(k))),
});

describe('tenant pipeline (spec SP3 §7, §18.2)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  let owner: SeededPrincipal;
  let outsider: SeededPrincipal;
  let org: SeededOrg;
  let deletedOrg: SeededOrg;
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [TenancyProbeModule] });
    owner = await seedP();
    outsider = await seedP();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    deletedOrg = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org, deletedOrg);
    await withAppClient((c) => inOrgTx(c, deletedOrg.orgId, () => c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`, [deletedOrg.orgId])));
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a member reaches the handler with org + access set from the path', async () => {
    const r = await authed(app, owner).get(`/v1/orgs/${org.orgId}/probe`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ orgId: org.orgId, via: 'MEMBERSHIP', ref: org.owner.memberPublicId });
    expect(r.body.permissions).toContain('org.delete');
  });
  it('a member without the key gets 403 forbidden; the body names no permission (G-4, U14)', async () => {
    const m = await seedP();
    await seedMember(org, 'MEMBER', { authUserId: m.authUserId });
    const r = await authed(app, m).get(`/v1/orgs/${org.orgId}/probe/owner-only`);
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(JSON.stringify(r.body)).not.toMatch(/org\.delete|Cannot execute/);
  });
  it('404 is identical for a missing org, a non-member, a soft-deleted org, nil and v4 ids — and never reaches CASL (G-3, Review Focus 5)', async () => {
    const guard = vi.spyOn(PoliciesGuard.prototype, 'canActivate');
    const responses = await Promise.all([
      authed(app, owner).get(`/v1/orgs/${v7()}/probe`),
      authed(app, outsider).get(`/v1/orgs/${org.orgId}/probe`),
      authed(app, owner).get(`/v1/orgs/${deletedOrg.orgId}/probe`),
      authed(app, owner).get(`/v1/orgs/${NIL}/probe`),
      authed(app, owner).get(`/v1/orgs/${v4()}/probe`),
    ]);
    const shapes = responses.map(shape);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]?.status).toBe(404);
    for (const r of responses) expect(Object.keys(r.headers).some((h) => h.startsWith('x-ratelimit'))).toBe(false);
    expect(guard).not.toHaveBeenCalled();
  });
  it('a principal that never touched tenancy gets the uniform 404 and no tenancy_users row (Review Focus 2)', async () => {
    const fresh = await seedP();
    const r = await authed(app, fresh).get(`/v1/orgs/${org.orgId}/probe`);
    expect(r.status).toBe(404);
    expect(await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [fresh.authUserId])).toEqual([]);
  });
  it('GET /v1/orgs/<soft-deleted org> without a sub-path is the uniform 404, not a 500 (G-7)', async () => {
    expect((await authed(app, owner).get(`/v1/orgs/${deletedOrg.orgId}`)).status).toBe(404);
  });
  it('a malformed org id is 400 org_context_invalid; an upper-case path runs the same pipeline and the org is lower-cased', async () => {
    const bad = await authed(app, owner).get('/v1/orgs/not-a-uuid/probe');
    expect([bad.status, bad.body.code]).toEqual([400, 'org_context_invalid']);
    const upper = await authed(app, owner).get(`/V1/ORGS/${org.orgId.toUpperCase()}/PROBE`);
    expect([upper.status, upper.body.orgId]).toEqual([200, org.orgId]);
  });
  it('anonymous requests fall through to AuthGuard (401), not to a tenancy 404', async () => {
    const r = await request(app.getHttpServer()).get(`/v1/orgs/${org.orgId}/probe`);
    expect([r.status, r.body.code]).toEqual([401, 'unauthenticated']);
  });
  it('a Better Auth user API key on a tenant route is 403 api_key_not_org_scoped', async () => {
    const created = await authed(app, owner).post('/api/auth/api-key/create').send({ name: 'tenancy-e2e' });
    expect(created.status).toBe(200);
    const key: unknown = created.body.key;
    if (typeof key !== 'string') throw new Error('api-key/create returned no key');
    const r = await request(app.getHttpServer()).get(`/v1/orgs/${org.orgId}/probe`).set('x-api-key', key);
    expect([r.status, r.body.code]).toEqual([403, 'api_key_not_org_scoped']);
  });
});
```
`test/e2e/tenancy/tenancy-http-boot.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RateLimitBuckets, type RateLimitBucket } from '../../../src/core/http/index.js';
import { ORG_MISS_BUCKET } from '../../../src/modules/tenancy/http/org-context.middleware.js';
import { startTenancyApp } from '../../support/tenancy-app.js';

/**
 * Review C1: Nest dựng middleware bằng `Injector.loadMiddleware` (container riêng), không dùng lại instance provider. Nếu
 * việc đăng ký bucket nằm trong constructor của middleware, app ném `Rate limit bucket "tenancy.org-miss" is already
 * registered` lúc boot. Ca này đỏ đúng ở lỗi đó, thay vì để mọi e2e tenancy đỏ hàng loạt ở `beforeAll`.
 */
describe('TenancyHttpModule boots (review C1)', () => {
  let app: INestApplication | undefined;
  // Gắn TRƯỚC khi app được dựng: thấy mọi lần đăng ký lúc khởi tạo provider. `spyOn` không mock, gọi hàm gốc.
  const register = vi.spyOn(RateLimitBuckets.prototype, 'register');
  afterAll(async () => {
    await app?.close();
    register.mockRestore();
    vi.unstubAllEnvs();
  });

  it('an app with TenancyModule.forApi() boots and registers tenancy.org-miss exactly once', async () => {
    app = await startTenancyApp();
    const orgMiss = register.mock.calls.filter(([def]) => def.owner === 'tenancy' && def.name === 'org-miss');
    expect(orgMiss).toHaveLength(1);
    expect(app.get<RateLimitBucket>(ORG_MISS_BUCKET, { strict: false }).name).toBe('tenancy.org-miss');
  });
});
```
`test/e2e/tenancy/org-miss-limiter.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { TenancyProbeModule } from './fixtures/probe.module.js';

const LIMIT = 5;

describe('org-miss limiter counts real misses only (spec SP3 §7.1 bước 3.5, SEC2-N3, INT2-N-4, T-33)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [TenancyProbeModule], env: { TENANCY_ORG_MISS_RATE_LIMIT: String(LIMIT) } });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('LIMIT + 1 sequential misses answer 404 (the one that crosses the limit included); from then on 429 with Retry-After', async () => {
    const p = await seedP();
    // Hợp đồng của `RateLimitBucket` (Task 5, review I4): peek khoá khi đã tiêu > LIMIT, nên lần LIMIT + 1 vẫn qua peek,
    // tiêu điểm thứ LIMIT + 1 và trả 404; lần LIMIT + 2 mới bị chặn ở peek.
    for (let i = 0; i < LIMIT + 1; i++) expect((await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status, `miss ${i + 1}`).toBe(404);
    const blocked = await authed(app, p).get(`/v1/orgs/${v7()}/probe`);
    expect([blocked.status, blocked.body.code]).toEqual([429, 'rate_limited']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('2×LIMIT parallel hits of a member on its own org never 429 and never count as misses', async () => {
    const p = await seedP();
    const org = await seedOrg({ owner: { authUserId: p.authUserId } });
    orgs.push(org);
    const hits = await Promise.all(Array.from({ length: 2 * LIMIT }, () => authed(app, p).get(`/v1/orgs/${org.orgId}/probe`)));
    expect(hits.map((r) => r.status)).toEqual(Array(2 * LIMIT).fill(200));
    // Bộ đếm vẫn là 0: đúng LIMIT + 1 lần trượt tiếp theo vẫn là 404 (hợp đồng peek của Task 5), lần sau đó 429.
    for (let i = 0; i < LIMIT + 1; i++) expect((await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status, `miss ${i + 1}`).toBe(404);
    expect((await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status).toBe(429);
  });
  it('T-33: concurrent misses may slip past peek by at most the concurrency, then the principal is blocked', async () => {
    const p = await seedP();
    const burst = await Promise.all(Array.from({ length: 3 * LIMIT }, () => authed(app, p).get(`/v1/orgs/${v7()}/probe`)));
    const statuses = burst.map((r) => r.status);
    expect(statuses.every((s) => s === 404 || s === 429)).toBe(true);
    expect(statuses.filter((s) => s === 404).length).toBeGreaterThanOrEqual(LIMIT);
    expect((await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status).toBe(429);
  });
});
```
`test/e2e/tenancy/org-scoped-throttle.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { TenancyProbeModule } from './fixtures/probe.module.js';

const THROTTLE = 3;

describe('throttle and idempotency see the real org (spec SP3 §7.1 bước 3, §18.2)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  let a: SeededOrg;
  let b: SeededOrg;
  let c: SeededOrg;
  beforeAll(async () => {
    app = await startTenancyApp({
      extraImports: [TenancyProbeModule],
      env: { THROTTLE_DEFAULT_LIMIT: String(THROTTLE), THROTTLE_PRE_AUTH_LIMIT: '1000' },
    });
    p = await seedUserPrincipal();
    a = await seedOrg({ owner: { authUserId: p.authUserId } });
    b = await seedOrg({ owner: { authUserId: p.authUserId } });
    c = await seedOrg({ owner: { authUserId: p.authUserId } });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await c?.dispose();
    await app?.close();
    await deleteSeededPrincipals([p]);
    vi.unstubAllEnvs();
  });

  it('exhausting the throttle on org A leaves org B untouched (tracker principal:<type>:<id>:<orgId>)', async () => {
    for (let i = 0; i < THROTTLE; i++) expect((await authed(app, p).get(`/v1/orgs/${a.orgId}/probe`)).status).toBe(200);
    expect((await authed(app, p).get(`/v1/orgs/${a.orgId}/probe`)).status).toBe(429);
    expect((await authed(app, p).get(`/v1/orgs/${b.orgId}/probe`)).status).toBe(200);
  });
  it('the same Idempotency-Key replays on the same org and runs again on another org', async () => {
    const key = `idem-${Date.now()}`;
    const onB = await authed(app, p).post(`/v1/orgs/${b.orgId}/probe/idem`).set('idempotency-key', key).send({});
    const replay = await authed(app, p).post(`/v1/orgs/${b.orgId}/probe/idem`).set('idempotency-key', key).send({});
    const onC = await authed(app, p).post(`/v1/orgs/${c.orgId}/probe/idem`).set('idempotency-key', key).send({});
    expect([onB.status, replay.status, onC.status]).toEqual([201, 201, 201]);
    expect(replay.body).toEqual(onB.body);
    expect(onC.body).toEqual({ n: onB.body.n + 1, orgId: c.orgId });
  });
});
```
Ghi chú: org A đã bị throttle ở test đầu nên phần idempotency dùng B và C. Scope khoá idempotency của SP1 gồm principal + org của context (ADR 0007); nếu `onC` bị replay thì org không vào scope: dừng và báo (spec §7.1 dựa vào điều này).

`test/e2e/tenancy/middleware-order.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PrincipalMiddleware } from '../../../src/modules/identity/http/principal.middleware.js';
import { OrgContextMiddleware } from '../../../src/modules/tenancy/http/org-context.middleware.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { TenancyProbeModule } from './fixtures/probe.module.js';

/** Độ sâu làm module kia chạy trước (Nest sắp middleware theo `distance` tăng dần; lấy độ sâu lớn nhất). */
const DEEPER = 3;

/**
 * T6 (spec SP3 §7.1 bước 2, INT-I1) + G-7 (INT3-2): ở thứ tự đã chọn, mỗi request tenant có đúng một span
 * `identity.authenticate`, một span `tenancy.org_context.resolve`, không `Set-Cookie` nhân đôi.
 */
export function describeMiddlewareOrder(first: 'identity' | 'tenancy'): void {
  describe(`principal resolution is idempotent with ${first} middleware first`, () => {
    const otel = installOtelCapture();
    let app: INestApplication;
    let p: SeededPrincipal;
    let org: SeededOrg;
    let principalUse: MockInstance<PrincipalMiddleware['use']>;
    let orgUse: MockInstance<OrgContextMiddleware['use']>;
    beforeAll(async () => {
      // Review I5: gắn spy TRƯỚC khi dựng app. Lúc init, Nest bind `instance.use.bind(instance)` một lần
      // (`@nestjs/core/middleware/middleware-module.js`), nên spy gắn sau init không bao giờ thấy lời gọi.
      // spyOn không mock: gọi hàm gốc, chỉ ghi thứ tự gọi.
      principalUse = vi.spyOn(PrincipalMiddleware.prototype, 'use');
      orgUse = vi.spyOn(OrgContextMiddleware.prototype, 'use');
      app = await startTenancyApp({
        extraImports: [TenancyProbeModule],
        identityDepth: first === 'tenancy' ? DEEPER : 0,
        tenancyDepth: first === 'identity' ? DEEPER : 0,
      });
      p = await seedUserPrincipal();
      org = await seedOrg({ owner: { authUserId: p.authUserId } });
    });
    afterAll(async () => {
      await org?.dispose();
      await app?.close();
      await deleteSeededPrincipals([p]);
      principalUse?.mockRestore();
      orgUse?.mockRestore();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    it('the chosen order really happened', async () => {
      principalUse.mockClear();
      orgUse.mockClear();
      await authed(app, p).get(`/v1/orgs/${org.orgId}/probe`);
      const [pOrder] = principalUse.mock.invocationCallOrder;
      const [oOrder] = orgUse.mock.invocationCallOrder;
      if (pOrder === undefined || oOrder === undefined) throw new Error('both middlewares must run');
      expect(first === 'identity' ? pOrder < oOrder : oOrder < pOrder).toBe(true);
    });
    it.each(['', '/', '/probe', '/probe/'])('GET /v1/orgs/<id>%s: one authentication, one org resolution', async (suffix) => {
      otel.reset();
      const r = await authed(app, p).get(`/v1/orgs/${org.orgId}${suffix}`);
      expect([200, 404]).toContain(r.status);
      expect(otel.spans('identity.authenticate')).toHaveLength(1);
      expect(otel.spans('tenancy.org_context.resolve')).toHaveLength(1);
      expect(r.headers['set-cookie'] ?? []).toHaveLength(0);
    });
  });
}
```
Nếu `invocationCallOrder` cho thấy thứ tự không đổi khi đổi `DEEPER`, tăng `DEEPER` và ghi số đo được vào chú thích hằng (giả định cần kiểm, xem cuối plan).

`test/e2e/tenancy/middleware-order-identity-first.e2e.spec.ts`:
```ts
import { describeMiddlewareOrder } from './middleware-order.js';

describeMiddlewareOrder('identity');
```
`test/e2e/tenancy/middleware-order-tenancy-first.e2e.spec.ts`:
```ts
import { describeMiddlewareOrder } from './middleware-order.js';

describeMiddlewareOrder('tenancy');
```
Run:
```bash
pnpm vitest run --project integration test/e2e/tenancy
```
Expected: PASS (hai file thứ tự mỗi file một process nên `installOtelCapture` đặt provider một lần).

- [ ] **Step 6: EXPLAIN đường nóng trên 10.000 org × 20 member (DB riêng)**

`test/integration/tenancy/hot-path-explain.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { HOT_PATH_SQL } from '../../../src/modules/tenancy/infra/sql/sql-access.reader.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

const ORGS = 10_000;
const MEMBERS_PER_ORG = 20;
const USERS = 50_000;
const TENANT_TABLES = ['organizations', 'org_roles', 'org_members'] as const;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];

describe('hot-path membership query plan on realistic volume (spec SP3 §7.3)', () => {
  let scratch: ScratchDb;
  let owner: pg.Client;
  let app: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    scratch = await createScratchDb('hotpath');
    vi.stubEnv('DB_NAME', scratch.name);
    await runMigrations('up', { source: { kind: 'list', list: coreMigrationList() } });
    owner = await scratch.client('owner');
    app = await scratch.client('app');
    // Seed hàng loạt bằng app_owner: tạm NO FORCE trong MỘT transaction (mẫu mục 8.8), rồi FORCE lại.
    await owner.query('BEGIN');
    for (const t of TENANT_TABLES) await owner.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await owner.query(`INSERT INTO tenancy_users (external_subject) SELECT 'load:' || g FROM generate_series(1, ${USERS}) g`);
    await owner.query(`INSERT INTO organizations (id, name) SELECT uuidv7(), 'Load ' || g FROM generate_series(1, ${ORGS}) g`);
    await owner.query(`INSERT INTO org_roles (org_id, system_key) SELECT o.id, k FROM organizations o CROSS JOIN unnest(ARRAY['OWNER','ADMIN','MEMBER']) k`);
    await owner.query(`INSERT INTO org_members (org_id, user_id, role_id)
      SELECT o.id, ((o.rn * ${MEMBERS_PER_ORG} + s) % ${USERS}) + 1, r.id
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM organizations) o
      CROSS JOIN generate_series(0, ${MEMBERS_PER_ORG - 1}) s
      JOIN org_roles r ON r.org_id = o.id AND r.system_key = CASE WHEN s = 0 THEN 'OWNER' ELSE 'MEMBER' END`);
    for (const t of TENANT_TABLES) await owner.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await owner.query('COMMIT');
    await owner.query('ANALYZE');
  }, 300_000);
  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await scratch?.drop();
    vi.unstubAllEnvs();
  });

  it('uses the unique indexes, no sequential scan on tenant tables, and prints EXPLAIN (ANALYZE, BUFFERS)', async () => {
    const { rows: pick } = await owner.query<{ org_id: string; subject: string }>(
      `SELECT m.org_id::text AS org_id, u.external_subject AS subject FROM org_members m JOIN tenancy_users u ON u.id = m.user_id OFFSET 123457 LIMIT 1`,
    );
    const target = pick[0];
    if (!target) throw new Error('seed produced no member');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.org_id', $1, true)`, [target.org_id]);
    const sql = HOT_PATH_SQL.EXTERNAL.replace('?', '$1');
    const { rows } = await app.query<{ 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }] }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [target.subject]);
    const text = await app.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [target.subject]);
    await app.query('ROLLBACK');
    const plan = rows[0]?.['QUERY PLAN'][0];
    if (!plan) throw new Error('no plan');
    console.info(`hot path plan (${ORGS} orgs × ${MEMBERS_PER_ORG} members):\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}`);
    const all = nodes(plan.Plan);
    const seqScans = all.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name']);
    expect(seqScans).toEqual([]);
    const indexes = all.map((n) => n['Index Name']).filter(Boolean);
    expect(indexes).toEqual(expect.arrayContaining(['organizations_pkey', 'org_members_org_user_uq', 'tenancy_users_external_subject_uq']));
  });
});
```
In plan ra log của CI là bằng chứng "kèm EXPLAIN" của spec; copy bản in vào mô tả PR ở Task 31.

Run: `pnpm vitest run --project integration test/integration/tenancy/hot-path-explain.spec.ts`
Expected: PASS; log có plan với `Index Scan using organizations_pkey`, `org_members_org_user_uq`, `tenancy_users_external_subject_uq`.

- [ ] **Step 7: Kiểm toàn cục, commit**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm arch
pnpm vitest run --project unit
pnpm vitest run --project integration test/e2e/identity test/e2e/tenancy test/integration/tenancy
```
Expected: xanh; e2e identity không đổi hành vi (middleware tenancy chỉ gắn `v1/orgs/:orgId{/*path}`).
```bash
git add src/modules/tenancy test/support test/e2e/tenancy test/integration/tenancy/hot-path-explain.spec.ts test/unit/modules/tenancy/effective-permissions.spec.ts
git commit -m "feat(tenancy): org context middleware with uniform 404 and org-miss limiter, OrgScope interceptor, hot-path plan check"
```

---

### Task 23: Vòng đời org — tạo (`MemberAdmission` nguồn `CREATOR`), đọc, đổi tên, xoá mềm, khôi phục; `GET /v1/orgs`, `GET /v1/permissions`; nạp `OrgRouteInventory` (T-6, T-7, T-12, Review Focus 1–5)

**Files:**
- Create: `src/modules/tenancy/application/actor-reauthorizer.ts`, `src/modules/tenancy/application/member-admission.ts`, `src/modules/tenancy/application/org-lifecycle.service.ts`, `src/modules/tenancy/application/org.service.ts`, `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/orgs.controller.ts`, `src/modules/tenancy/http/org.controller.ts`, `src/modules/tenancy/http/permissions.controller.ts`
- Create (test): `test/unit/modules/tenancy/tenancy-http-modules.spec.ts`, `test/e2e/tenancy/orgs.e2e.spec.ts`, `test/e2e/tenancy/org-lifecycle.e2e.spec.ts`, `test/e2e/tenancy/orgs-single-mode.e2e.spec.ts`
- Modify: `src/core/database/index.ts` (export `pgFields`), `src/modules/tenancy/tenancy.module.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `test/support/tenancy-seed.ts` (`purgeOrgs`, `deleteTenancyUsersOf`), `openapi.json` (sinh lại)

**Interfaces:**
- Consumes: repository + `SubjectResolver` + `TenancyUserVanishedError` (Task 20), `orgName`, `orgStateOf`, `transitionOrg` (Task 18), `effectivePermissions` (Task 22), `TenancyPermissions`, decorator + marker, `OrgRouteInventory`, `TENANCY_CONTROLLER_MODULES` (Task 21), event (Task 19), `ScheduledTaskService.suspendAllForCurrentOrg/resumeAllForCurrentOrg/syncCurrentOrg` (Task 7), `AuthFacts` (Task 10), `TenancyTestHooks` (Task 19), `EventPublisher`, `Paginator`, `offsetPageQuery`, `assertIfMatch`, `etagOf`, `setLocation`, `serialize`, `Idempotent`, `mergePatchSchema` (SP1).
- Produces:
  - `userActor(ctx: RequestContext): EventActor`; `ActorReauthorizer.require(keys: readonly string[], lockAlso?: readonly string[]): Promise<{ actor: MemberRow; permissions: ReadonlySet<string>; locked: readonly MemberRow[] }>` (trong transaction đã khoá org; actor không còn → 404; thiếu key → 403 `forbidden`).
  - `MemberAdmission.admit(i: { user: TenancyUserRef; role: RoleRow; source: 'CREATOR' | 'INVITATION' | 'INVITE_LINK'; actor: EventActor }): Promise<MemberRow>` (đòi transaction trong OrgScope; `tenancy_users` của user đã khoá; span `tenancy.member.admit` với attribute `tenancy.member.source`, review M4).
  - `type LifecycleActor = { kind: 'MEMBER' } | { kind: 'SYSTEM'; id: string }`; `OrgLifecycleService.softDelete(by)`, `.restore(by)` → `OrgRow` (khoá org, `clock_timestamp()` sau khoá, lịch treo/khôi phục trong transaction, `syncCurrentOrg()` sau commit, event cùng transaction). Ở core module (api + worker).
  - `OrgService.create({ name })`, `.list({ includeDeleted, page, pageSize })`, `.get()`, `.rename(ifMatch, name)` (api).
  - Route: `POST /v1/orgs`, `GET /v1/orgs`, `GET /v1/orgs/:orgId`, `PATCH /v1/orgs/:orgId`, `DELETE /v1/orgs/:orgId`, `POST /v1/orgs/:orgId/restore`, `GET /v1/permissions`; schema `OrganizationResponse`, `OrgListItem`, `PermissionResponse`.
  - `tenancyControllerModules(): Type[]` (module có controller của tenancy) + `OrgRouteInventory` nạp ở `TenancyHttpModule` (module này import `DiscoveryModule`, review I6).

- [ ] **Step 1: Export `pgFields`, actor, admission**

`src/core/database/index.ts`: đổi khối export của `db-error.mapper.js` thành
```ts
export {
  PG,
  dbErrorMapper,
  defineConstraintErrors,
  isRetryableTxError,
  pgFields,
} from './db-error.mapper.js';
```
`src/modules/tenancy/application/actor-reauthorizer.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import type { EventActor } from '../../../core/events/index.js';
import { MemberRepository, type MemberRow } from '../ports/member-repository.js';
import { effectivePermissions } from './authz/effective-permissions.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';
import { TenancyMetrics } from './tenancy-metrics.js';

/** Actor của event cho thao tác trực tiếp của user (spec SP3 §14): `principal.id`. */
export function userActor(ctx: RequestContext): EventActor {
  const p = ctx.principal();
  if (!p) throw new Error('a user-initiated tenancy mutation ran without a principal');
  return { type: 'user', id: p.id };
}

export type Reauthorized = { actor: MemberRow; permissions: ReadonlySet<string>; locked: readonly MemberRow[] };

/**
 * Spec SP3 §8.6 bước 4–5 (TOCTOU, T-10): trong transaction ĐÃ khoá org, đọc lại actor (và các member bị chạm) `FOR SHARE`
 * theo id tăng dần, tính lại quyền, kiểm lại cửa. Quyết định của `PoliciesGuard` chỉ là tư vấn.
 */
@Injectable()
export class ActorReauthorizer {
  private readonly logger = new Logger(ActorReauthorizer.name);

  constructor(
    private readonly ctx: RequestContext,
    private readonly members: MemberRepository,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
  ) {}

  async require(keys: readonly string[], lockAlso: readonly string[] = []): Promise<Reauthorized> {
    const access = this.ctx.orgAccess();
    if (access?.via !== 'MEMBERSHIP') throw new Error('an admin mutation ran without a MEMBERSHIP orgAccess');
    const self = await this.members.findByPublicId(access.ref);
    if (!self) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    const ids = [...new Set([self.id, ...lockAlso])].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const locked = await this.members.lockForShare(ids);
    const actor = locked.find((m) => m.id === self.id);
    if (!actor) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    const permissions = new Set(effectivePermissions(actor, this.registry.merged()));
    const missing = keys.filter((k) => !permissions.has(k));
    if (missing.length > 0) {
      this.metrics.policyDenied.add(1, { reason: 'permission' });
      this.logger.warn({ event: 'policy_denied', reason: 'permission', missing, stage: 'transaction' }, 'actor lost the permission before the transaction');
      throw new AppError(CoreErrors.FORBIDDEN, { expected: true });
    }
    return { actor, permissions, locked };
  }
}
```
`src/modules/tenancy/application/member-admission.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { TenancyErrors } from '../errors.js';
import { MemberAddedEvent } from '../events.js';
import { MemberRepository, type MemberRow } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import type { RoleRow } from '../ports/role-repository.js';
import type { TenancyUserRef } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';

export type AdmissionSource = 'CREATOR' | 'INVITATION' | 'INVITE_LINK';

/**
 * Mọi đường thêm membership (spec SP3 §9 đầu mục): tạo org (3A), chấp nhận lời mời / join link (3C thêm nguồn), domain
 * join sau này. Caller đã khoá org (trừ org mới tạo) và `tenancy_users` của user (T-25) trong CÙNG transaction.
 */
@Injectable()
export class MemberAdmission {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly events: EventPublisher,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async admit(i: { user: TenancyUserRef; role: RoleRow; source: AdmissionSource; actor: EventActor }): Promise<MemberRow> {
    if (!this.uow.inTransaction()) throw new Error('MemberAdmission.admit must run inside UnitOfWork.run');
    // Span `tenancy.member.admit` (spec SP3 §16, review M4): chỉ nguồn (enum hữu hạn) làm attribute.
    return tenancySpan(
      'tenancy.member.admit',
      async () => {
        // T-7: đếm SAU khi đã khoá tenancy_users của user, nên hai lần join song song thấy nhau.
        if (this.cfg.membershipMode === 'single' && (await this.orgs.countForUser(i.user.id, true)) > 0)
          throw new AppError(TenancyErrors.ALREADY_IN_AN_ORG);
        // 3D (SEC-M5): thu hồi support grant chưa thu hồi của chính user trong org, trước INSERT (spec Bảng 5).
        // Extension point (S3-Q4 C): verified-domain auto-join — spec §19; dùng lại hàm này với nguồn `DOMAIN`.
        const member = await this.members.insert({ userId: i.user.id, roleId: i.role.id });
        await this.events.publish(MemberAddedEvent, {
          data: { memberId: member.publicId, userId: i.user.publicId, roleId: i.role.publicId, source: i.source },
          aggregate: { type: 'member', id: member.publicId, version: member.version },
          actor: i.actor,
        });
        return member;
      },
      () => ({ 'tenancy.member.source': i.source }),
    );
  }
}
```
`ALREADY_MEMBER` không cần kiểm trước: `org_members_org_user_uq` map qua `defineConstraintErrors` (Task 19).

- [ ] **Step 2: Service vòng đời (core) và service org (api)**

`src/modules/tenancy/application/org-lifecycle.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { ScheduledTaskService } from '../../../core/scheduler/index.js';
import { orgStateOf, transitionOrg } from '../domain/organization.js';
import { TenancyErrors } from '../errors.js';
import { OrgDeletedEvent, OrgRestoredEvent } from '../events.js';
import { OrgRepository, type OrgRow } from '../ports/org-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { TenancyMetrics } from './tenancy-metrics.js';

/** `MEMBER`: request của user (đọc lại actor + kiểm lại cửa dưới khoá). `SYSTEM`: cron/test/migration có tên. */
export type LifecycleActor = { kind: 'MEMBER' } | { kind: 'SYSTEM'; id: string };

/**
 * Xoá mềm / khôi phục (spec SP3 §9.4). Chạy trong OrgScope của org (interceptor hoặc caller). Mọi ghi DB (org, lịch,
 * outbox) trong MỘT transaction đã khoá org `FOR NO KEY UPDATE`; hết hạn so bằng `clock_timestamp()` sau khoá (§3.15,
 * X-11). Gỡ scheduler Redis chỉ SAU commit (DB-I10); lỗi ở đó chỉ WARN — reconciler (`SCHEDULER_RECONCILE_CRON`) dọn.
 */
@Injectable()
export class OrgLifecycleService {
  private readonly logger = new Logger(OrgLifecycleService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly orgs: OrgRepository,
    private readonly schedules: ScheduledTaskService,
    private readonly events: EventPublisher,
    private readonly reauth: ActorReauthorizer,
    private readonly hooks: TenancyTestHooks,
    private readonly metrics: TenancyMetrics,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async softDelete(by: LifecycleActor): Promise<OrgRow> {
    await this.hooks.afterGuard();
    const deleted = await this.uow.run(async () => {
      const org = await this.orgs.lockCurrent();
      if (!org) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
      const actor = await this.actorFor(by, 'org.delete');
      const t = transitionOrg(orgStateOf(org), 'SOFT_DELETE', { now: await this.orgs.clockNow(), purgeAfter: org.purgeAfter });
      if (!t.ok) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12: đã xoá mềm bởi request trước
      // 3C thu hồi link, lời mời PENDING → REVOKED, huỷ chuyển quyền; 3D thu hồi key, grant (spec Bảng 5).
      await this.schedules.suspendAllForCurrentOrg();
      const row = await this.orgs.softDelete(this.cfg.orgDeleteGraceSec);
      if (!row.purgeAfter) throw new Error('soft delete returned no purge_after (organizations_deleted_pair_ck)');
      await this.events.publish(OrgDeletedEvent, {
        data: { orgId: row.id, purgeAfter: row.purgeAfter.toISOString() },
        aggregate: { type: 'organization', id: row.id, version: row.version },
        actor,
      });
      return row;
    });
    await this.syncSchedules('soft_delete');
    return deleted;
  }

  async restore(by: LifecycleActor): Promise<OrgRow> {
    await this.hooks.afterGuard();
    let restored: OrgRow;
    try {
      restored = await this.uow.run(async () => {
        const org = await this.orgs.lockCurrent();
        if (!org) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const actor = await this.actorFor(by, 'org.restore');
        const t = transitionOrg(orgStateOf(org), 'RESTORE', { now: await this.orgs.clockNow(), purgeAfter: org.purgeAfter });
        if (!t.ok) {
          switch (t.reason) {
            case 'NOT_DELETED':
              throw new AppError(TenancyErrors.ORG_NOT_DELETED);
            case 'GRACE_EXPIRED':
            case 'NOT_ACTIVE':
            case 'NOT_DUE':
              throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
            default: {
              const unknown: never = t.reason;
              throw new Error(`unknown restore refusal ${String(unknown)}`);
            }
          }
        }
        await this.schedules.resumeAllForCurrentOrg();
        const row = await this.orgs.restore();
        await this.events.publish(OrgRestoredEvent, {
          data: { orgId: row.id },
          aggregate: { type: 'organization', id: row.id, version: row.version },
          actor,
        });
        return row;
      });
    } catch (err) {
      // Trigger hoãn `organizations_restore_owner_ck` bắn lúc COMMIT (O-14): 409 last_owner qua constraint map.
      if (pgFields(err)?.constraint === 'organizations_restore_owner_ck') this.metrics.lastOwnerBlocked.add(1, { path: 'restore' });
      throw err;
    }
    await this.syncSchedules('restore');
    return restored;
  }

  private async actorFor(by: LifecycleActor, key: string): Promise<EventActor> {
    switch (by.kind) {
      case 'MEMBER':
        await this.reauth.require([key]);
        return userActor(this.ctx);
      case 'SYSTEM':
        return { type: 'system', id: by.id };
      default: {
        const unknown: never = by;
        throw new Error(`unknown lifecycle actor ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async syncSchedules(after: 'soft_delete' | 'restore'): Promise<void> {
    try {
      await this.schedules.syncCurrentOrg();
    } catch (err) {
      this.logger.warn(
        { event: 'org_schedule_sync_failed', after, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        'scheduler sync after an org lifecycle change failed; the schedule reconciler will converge it',
      );
    }
  }
}
```
`src/modules/tenancy/application/org.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { AuthFacts } from '../../identity/index.js';
import { TenancyErrors, TenancyUserVanishedError } from '../errors.js';
import { OrgCreatedEvent, OrgUpdatedEvent } from '../events.js';
import { OrgRepository, type OrgRow, type UserOrgRow } from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { MemberAdmission } from './member-admission.js';
import { SubjectResolver } from './subject-resolver.js';

@Injectable()
export class OrgService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly facts: AuthFacts,
    private readonly subjects: SubjectResolver,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly admission: MemberAdmission,
    private readonly events: EventPublisher,
    private readonly reauth: ActorReauthorizer,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  /**
   * Spec SP3 §9.4 "Tạo": id v7 sinh ở app (S3-A1), OrgScope(id) để `WITH CHECK` đạt; khoá `tenancy_users` của người tạo
   * TRƯỚC khi đếm (T-6); đếm cả org xoá mềm chưa purge (S3-A22). Trigger hoãn `organizations_bootstrap_ck` kiểm lúc COMMIT.
   */
  async create(input: { name: string }): Promise<OrgRow> {
    if (this.cfg.orgCreation === 'platform_admin' && !this.facts.isPlatformAdmin()) throw new AppError(TenancyErrors.ORG_CREATION_DISABLED);
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    const subject = this.subjects.of(principal);
    const actor = userActor(this.ctx);
    const id = v7();
    return this.scope.run(id, () =>
      this.uow.run(async () => {
        const user = await this.lockUser(() => this.users.upsertAndLock(subject));
        if ((await this.orgs.countCreatedBy(user.id)) >= this.cfg.maxOrgsCreatedPerUser) throw new AppError(TenancyErrors.ORG_LIMIT_REACHED);
        const org = await this.orgs.insertCurrent({ name: input.name, createdByUserId: user.id });
        const roles = await this.roles.insertSystemRoles();
        await this.admission.admit({ user, role: roles.OWNER, source: 'CREATOR', actor });
        await this.events.publish(OrgCreatedEvent, {
          data: { orgId: org.id, createdByUserId: user.publicId },
          aggregate: { type: 'organization', id: org.id, version: org.version },
          actor,
        });
        return org;
      }),
    );
  }

  /** Không tạo `tenancy_users` (Review Focus 2); đếm bằng cùng điều kiện với danh sách (Review Focus 3). */
  async list(q: { includeDeleted: boolean; page: number; pageSize: number }): Promise<{ rows: UserOrgRow[]; total: number }> {
    const principal = this.ctx.principal();
    if (!principal) throw new AppError(CoreErrors.UNAUTHENTICATED);
    const user = await this.users.find(this.subjects.of(principal));
    if (!user) return { rows: [], total: 0 };
    const [rows, total] = await Promise.all([
      this.orgs.listForUser(user.id, q.includeDeleted, q.pageSize, (q.page - 1) * q.pageSize),
      this.orgs.countForUser(user.id, q.includeDeleted),
    ]);
    return { rows, total };
  }

  async get(): Promise<OrgRow> {
    const org = await this.orgs.readCurrent();
    if (!org) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return org;
  }

  /** Khoá org rồi so version DƯỚI khoá: hai request cùng ETag → một 200, một 412 (Review Focus 4). */
  async rename(ifMatch: string | undefined, name: string | undefined): Promise<OrgRow> {
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      const org = await this.orgs.lockCurrent();
      if (!org || org.deletedAt) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
      await this.reauth.require(['org.update']);
      assertIfMatch(ifMatch, org.version, { required: true });
      if (name === undefined || name === org.name) return org;
      const updated = await this.orgs.rename(name);
      await this.events.publish(OrgUpdatedEvent, {
        data: { orgId: updated.id, changed: ['name'] },
        aggregate: { type: 'organization', id: updated.id, version: updated.version },
        actor: userActor(this.ctx),
      });
      return updated;
    });
  }

  private async lockUser<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TenancyUserVanishedError)
        throw new AppError(CoreErrors.CONFLICT, { detail: 'This account is being deleted.', expected: true });
      throw err;
    }
  }
}
```

- [ ] **Step 3: Schema và controller**

`src/modules/tenancy/http/schemas.ts`:
```ts
import { z } from 'zod';
import { mergePatchSchema, offsetPageQuery } from '../../../core/http/index.js';
import { SYSTEM_ROLE_KEYS } from '../constants.js';
import { orgName } from '../domain/organization.js';
import type { OrgRow, UserOrgRow } from '../ports/org-repository.js';

const iso = z.iso.datetime();
/** Resource `Organization` (spec SP3 §12): camelCase, nullable luôn có mặt. */
export const OrganizationResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  deletedAt: iso.nullable(),
  purgeAfter: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type OrganizationResponse = z.infer<typeof OrganizationResponse>;
export const organizationOf = (o: OrgRow): OrganizationResponse => ({
  id: o.id,
  name: o.name,
  deletedAt: o.deletedAt?.toISOString() ?? null,
  purgeAfter: o.purgeAfter?.toISOString() ?? null,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
});

/**
 * Một dòng của `GET /v1/orgs`: đúng các cột mà hàm definer `tenancy_list_user_orgs` trả (spec SP3 §6.14 cố định chữ ký,
 * không có `createdAt` của org), cộng membership của chính principal.
 */
export const OrgListItem = z.object({
  id: z.uuid(),
  name: z.string(),
  deletedAt: iso.nullable(),
  purgeAfter: iso.nullable(),
  membership: z.object({
    memberId: z.uuid(),
    role: z.object({ id: z.uuid(), systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(), name: z.string().nullable() }),
    joinedAt: iso,
  }),
});
export const orgListItemOf = (r: UserOrgRow): z.infer<typeof OrgListItem> => ({
  id: r.orgId,
  name: r.orgName,
  deletedAt: r.orgDeletedAt?.toISOString() ?? null,
  purgeAfter: r.orgPurgeAfter?.toISOString() ?? null,
  membership: {
    memberId: r.memberPublicId,
    role: { id: r.rolePublicId, systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable().parse(r.roleSystemKey), name: r.roleName },
    joinedAt: r.joinedAt.toISOString(),
  },
});

/** `z.object` bỏ khoá lạ: `id` do client gửi bị bỏ qua (Review Focus 5). */
export const CreateOrgBody = z.object({ name: orgName });
export const PatchOrgBody = mergePatchSchema(z.object({ name: orgName }));
export const ListOrgsPage = offsetPageQuery({ sortable: ['joinedAt'] as const });
export const IncludeDeletedQuery = z.object({ includeDeleted: z.stringbool().default(false) });

export const PermissionResponse = z.object({
  key: z.string(),
  resource: z.string(),
  action: z.string(),
  requires: z.array(z.string()),
  ownerOnly: z.boolean(),
  apiKeyEligible: z.boolean(),
  supportEligible: z.boolean(),
});
export const PermissionListResponse = z.object({ data: z.array(PermissionResponse) });
```
`src/modules/tenancy/http/orgs.controller.ts`:
```ts
import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, Paginator, etagOf, serialize, setLocation, type HeaderWriter } from '../../../core/http/index.js';
import { OrgService } from '../application/org.service.js';
import { TenancyErrors } from '../errors.js';
import { SensitiveTenancyAction } from './decorators.js';
import { CreateOrgBody, IncludeDeletedQuery, ListOrgsPage, OrgListItem, OrganizationResponse, organizationOf, orgListItemOf } from './schemas.js';

/** Route ngoài path org (spec SP3 §7.2): không qua `OrgContextMiddleware`; service tự vào OrgScope. */
@Controller('v1/orgs')
export class OrgsController {
  constructor(
    private readonly orgs: OrgService,
    private readonly pages: Paginator,
  ) {}

  @Post()
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OrganizationResponse)
  @ApiProblems(TenancyErrors.ORG_CREATION_DISABLED, TenancyErrors.ORG_LIMIT_REACHED, TenancyErrors.ALREADY_IN_AN_ORG, CoreErrors.VALIDATION_FAILED)
  async create(@Body({ schema: CreateOrgBody }) body: z.infer<typeof CreateOrgBody>, @Res({ passthrough: true }) res: HeaderWriter) {
    const org = await this.orgs.create(body);
    setLocation(res, `/v1/orgs/${org.id}`);
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }

  @Get()
  @ApiOk(OrgListItem)
  async list(@Query({ schema: ListOrgsPage }) page: z.infer<typeof ListOrgsPage>, @Query({ schema: IncludeDeletedQuery }) flags: z.infer<typeof IncludeDeletedQuery>) {
    // Hàm definer sắp theo thời điểm tham gia (m.created_at, m.id); chiều giảm không hỗ trợ.
    if (page.sort?.direction === 'desc') throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=joinedAt (ascending) is supported.' });
    const { rows, total } = await this.orgs.list({ includeDeleted: flags.includeDeleted, page: page.page, pageSize: page.pageSize });
    return this.pages.offset(rows.map((r) => serialize(OrgListItem, orgListItemOf(r))), page, total);
  }
}
```
`src/modules/tenancy/http/org.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Patch, Post, Res } from '@nestjs/common';
import type { z } from 'zod';
import { CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Idempotent, etagOf, serialize, type HeaderWriter } from '../../../core/http/index.js';
import { OrgLifecycleService } from '../application/org-lifecycle.service.js';
import { OrgService } from '../application/org.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { SensitiveTenancyAction } from './decorators.js';
import { OrganizationResponse, PatchOrgBody, organizationOf } from './schemas.js';

/** Org lấy từ `ctx.orgId()` (middleware), không từ `@Param('orgId')` (spec SP3 §7.1 bước 3.3). */
@Controller('v1/orgs/:orgId')
export class OrgController {
  constructor(
    private readonly orgs: OrgService,
    private readonly lifecycle: OrgLifecycleService,
  ) {}

  @Get()
  @TenancyPermissions.require('org.read')
  @ApiOk(OrganizationResponse)
  async get(@Res({ passthrough: true }) res: HeaderWriter) {
    const org = await this.orgs.get();
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }

  @Patch()
  @TenancyPermissions.require('org.update')
  @SensitiveTenancyAction()
  @ApiOk(OrganizationResponse)
  @ApiProblems(CoreErrors.PRECONDITION_REQUIRED, CoreErrors.PRECONDITION_FAILED, CoreErrors.VALIDATION_FAILED)
  async rename(
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchOrgBody }) body: z.infer<typeof PatchOrgBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    // Merge-patch (SP1): `null` chỉ hợp lệ ở member nullable, nên `name: null` đã bị schema từ chối (422); vắng = giữ nguyên.
    const org = await this.orgs.rename(ifMatch, body.name);
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('org.delete')
  @SensitiveTenancyAction()
  async softDelete(): Promise<void> {
    await this.lifecycle.softDelete({ kind: 'MEMBER' });
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @TenancyPermissions.require('org.restore')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OrganizationResponse)
  @ApiProblems(TenancyErrors.ORG_NOT_DELETED, TenancyErrors.LAST_OWNER)
  async restore(@Res({ passthrough: true }) res: HeaderWriter) {
    const org = await this.lifecycle.restore({ kind: 'MEMBER' });
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }
}
```

`src/modules/tenancy/http/permissions.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { ApiOk, serialize } from '../../../core/http/index.js';
import { PermissionCatalogueRegistry } from '../application/permission-catalogue.registry.js';
import { PermissionListResponse } from './schemas.js';

/** Catalogue gộp, bỏ deprecated, cho UI dựng màn role (spec SP3 §7.2). Cần principal (AuthGuard), không cần org. */
@Controller('v1/permissions')
export class PermissionsController {
  constructor(private readonly registry: PermissionCatalogueRegistry) {}

  @Get()
  @ApiOk(PermissionListResponse)
  list() {
    const data = [...this.registry.merged().values()]
      .filter((e) => !e.deprecated)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => ({ key: e.key, resource: e.resource, action: e.action, requires: [...e.requires], ownerOnly: e.ownerOnly, apiKeyEligible: e.apiKeyEligible, supportEligible: e.supportEligible }));
    return serialize(PermissionListResponse, { data });
  }
}
```
`src/modules/tenancy/http/tenancy-http.module.ts` (thay nội dung `@Module`):
```ts
@Module({
  // `DiscoveryModule` không `@Global` và `TenancyCoreModule` không export `DiscoveryService`: `OrgRouteInventory` cần nó
  // ở chính module này (review I6).
  imports: [DiscoveryModule],
  controllers: [OrgsController, OrgController, PermissionsController],
  providers: [
    SqlAccessReader,
    { provide: AccessReader, useExisting: SqlAccessReader },
    orgMissBucketProvider,
    { provide: APP_INTERCEPTOR, useClass: OrgScopeInterceptor },
    OrgService,
    OrgRouteInventory,
    // Hàm (không phải hằng) vì module tự tham chiếu chính nó: đọc lúc DI, sau khi class đã định nghĩa.
    { provide: TENANCY_CONTROLLER_MODULES, useFactory: tenancyControllerModules },
  ],
})
export class TenancyHttpModule implements NestModule { /* configure giữ nguyên */ }

/** Mọi module có controller của tenancy (luật G-8); unit test so với cây import của `TenancyModule.forApi()`. */
export function tenancyControllerModules(): Type[] {
  return [TenancyHttpModule];
}
```
(thêm import `type Type` từ `@nestjs/common`, `DiscoveryModule` từ `@nestjs/core` (cạnh `APP_INTERCEPTOR`), ba controller, `OrgService`, `OrgRouteInventory`, `TENANCY_CONTROLLER_MODULES`; `OrgContextMiddleware` vẫn import cho `configure`, `orgMissBucketProvider` từ Task 22.)
`src/modules/tenancy/tenancy.module.ts`: thêm vào `providers` của `TenancyCoreModule`: `ActorReauthorizer`, `MemberAdmission`, `OrgLifecycleService`; `exports` thêm ba provider đó.

- [ ] **Step 4: Unit test danh sách module G-8 + e2e (fail trước Step 1–3)**

`test/support/tenancy-seed.ts` thêm (dọn org do API tạo, cùng thứ tự với job purge):
```ts
/** Xoá cứng các org (không do `seedOrg` tạo) theo đúng `ORG_PURGE_STATEMENTS`; mỗi org một transaction trong OrgScope. */
export async function purgeOrgs(orgIds: readonly string[], database?: string): Promise<void> {
  await withAppClient(async (c) => {
    for (const orgId of orgIds)
      await inOrgTx(c, orgId, async () => {
        await c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 second' WHERE id = app_current_org() AND deleted_at IS NULL`);
        await c.query('DELETE FROM scheduled_tasks WHERE org_id = app_current_org()');
        for (const sql of ORG_PURGE_STATEMENTS) await c.query(sql);
      });
  }, database);
}

/**
 * Dòng `tenancy_users` của các auth user (trước khi xoá `auth."user"`, FK RESTRICT). Gọi SAU `purgeOrgs`/`dispose()`:
 * không đọc `org_members` (RLS, ngoài OrgScope là lỗi), mà để FK `org_members_user_fk` quyết định — `23001` nghĩa là
 * user còn membership ở org khác chưa dọn: ném, test đỏ (không bao giờ để dòng mồ côi âm thầm).
 */
export async function deleteTenancyUsersOf(authUserIds: readonly string[]): Promise<void> {
  await withAppClient((c) => c.query('DELETE FROM tenancy_users WHERE auth_user_id = ANY($1::uuid[])', [authUserIds]));
}
```


`test/unit/modules/tenancy/tenancy-http-modules.spec.ts`:
```ts
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import type { DynamicModule, Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { tenancyControllerModules } from '../../../../src/modules/tenancy/http/tenancy-http.module.js';
import { TenancyModule } from '../../../../src/modules/tenancy/index.js';

type Imp = Type | DynamicModule | Promise<DynamicModule>;
const isDynamic = (m: Imp): m is DynamicModule => typeof m === 'object' && 'module' in m;

/** Duyệt cây import của `TenancyModule.forApi()`; gom module (tenancy) có controller. */
function modulesWithControllers(root: DynamicModule): Type[] {
  const found = new Set<Type>();
  const seen = new Set<unknown>();
  const visit = (m: Imp): void => {
    if (m instanceof Promise || seen.has(m)) return;
    seen.add(m);
    const type = isDynamic(m) ? m.module : m;
    const controllers: unknown[] = [...(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, type) ?? []), ...(isDynamic(m) ? (m.controllers ?? []) : [])];
    if (controllers.length > 0) found.add(type);
    const imports: Imp[] = [...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, type) ?? []), ...(isDynamic(m) ? (m.imports ?? []) : [])];
    for (const i of imports) visit(i);
  };
  visit(root);
  return [...found];
}

describe('TENANCY_CONTROLLER_MODULES (spec SP3 §7.1, G-8)', () => {
  it('lists exactly the tenancy modules that declare controllers', () => {
    expect(new Set(tenancyControllerModules())).toEqual(new Set(modulesWithControllers(TenancyModule.forApi())));
  });
});
```
`test/e2e/tenancy/orgs.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CatalogueCheck } from '../../../src/modules/tenancy/application/catalogue-check.js';
import { OrgRouteInventory } from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs, seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const MAX_ORGS = 3;
const RACE_ROUNDS = 10;
const idem = () => `k-${v7()}`;

describe('organizations API (spec SP3 §9.4, §12)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const seeded: SeededOrg[] = [];
  const createdOrgIds: string[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  const create = (p: SeededPrincipal, body: unknown) => authed(app, p).post('/v1/orgs').set('idempotency-key', idem()).send(body);
  beforeAll(async () => {
    app = await startTenancyApp({ env: { TENANCY_MAX_ORGS_CREATED_PER_USER: String(MAX_ORGS) } });
  });
  afterAll(async () => {
    for (const o of seeded) await o.dispose();
    await purgeOrgs(createdOrgIds);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('POST /v1/orgs → 201 + Location + ETag; creator is OWNER; member.added and org.created share the transaction', async () => {
    const p = await seedP();
    const r = await create(p, { name: 'Acme', id: '00000000-0000-7000-8000-000000000000' });
    expect(r.status).toBe(201);
    createdOrgIds.push(r.body.id);
    expect(r.body.id).not.toBe('00000000-0000-7000-8000-000000000000'); // Review Focus 5: id của client bị bỏ qua
    expect(r.headers['location']).toBe(`/v1/orgs/${r.body.id}`);
    expect(r.headers['etag']).toBe('W/"1"');
    const list = await authed(app, p).get('/v1/orgs');
    expect(list.body.data[0]).toMatchObject({ id: r.body.id, membership: { role: { systemKey: 'OWNER' } } });
    const events = await ownerQuery<{ type: string }>('SELECT type FROM outbox_events WHERE org_id = $1 ORDER BY id', [r.body.id]);
    expect(events.map((e) => e.type)).toEqual(['tenancy.member.added', 'tenancy.org.created']);
  });
  it.each([
    ['😀'.repeat(100), 201],
    ['😀'.repeat(101), 422],
    [' Acme', 422],
    ['Acme ', 422],
    ['\tAcme', 422],
    ['', 422],
  ])('org names are measured in code points like the DB CHECK: %j → %i (Review Focus 1)', async (name, status) => {
    const p = await seedP();
    const r = await create(p, { name });
    if (r.status === 201) createdOrgIds.push(r.body.id);
    expect(r.status).toBe(status);
    if (status === 422) expect(r.body.code).toBe('validation_failed');
  });
  it(`T-6: ${RACE_ROUNDS} rounds of two parallel creates at limit − 1 → exactly one 201 and one 422 org_limit_reached`, async () => {
    for (let i = 0; i < RACE_ROUNDS; i++) {
      const p = await seedP();
      for (let k = 0; k < MAX_ORGS - 1; k++) createdOrgIds.push((await create(p, { name: `Pre ${k}` })).body.id);
      const [a, b] = await Promise.all([create(p, { name: 'A' }), create(p, { name: 'B' })]);
      for (const r of [a, b]) if (r.status === 201) createdOrgIds.push(r.body.id);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      expect([a, b].find((r) => r.status === 422)?.body.code).toBe('org_limit_reached');
    }
  });
  it('creating needs a fresh session and a verified email (sensitive action)', async () => {
    const stale = await seedP({ sessionAgeSec: 3600 });
    expect((await create(stale, { name: 'Old' })).body.code).toBe('reauthentication_required');
    const unverified = await seedP({ emailVerified: false });
    expect((await create(unverified, { name: 'Unv' })).body.code).toBe('email_not_verified');
  });
  it('GET /v1/orgs is an empty page for a new principal and creates no tenancy_users row (Review Focus 2)', async () => {
    const p = await seedP();
    const r = await authed(app, p).get('/v1/orgs');
    expect([r.status, r.body.data, r.body.totalCount]).toEqual([200, [], 0]);
    expect(await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [p.authUserId])).toEqual([]);
  });
  it('includeDeleted lists soft-deleted orgs to owners only and the count matches (Review Focus 3)', async () => {
    const owner = await seedP();
    const member = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}`).expect(204);
    const asOwner = await authed(app, owner).get('/v1/orgs?includeDeleted=true');
    const asMember = await authed(app, member).get('/v1/orgs?includeDeleted=true');
    const ownerIds = asOwner.body.data.map((o: { id: string }) => o.id);
    expect(ownerIds).toContain(org.orgId);
    expect(asOwner.body.data.find((o: { id: string }) => o.id === org.orgId).deletedAt).not.toBeNull();
    expect(asOwner.body.totalCount).toBe(asOwner.body.data.length);
    expect(asMember.body.data.map((o: { id: string }) => o.id)).not.toContain(org.orgId);
    expect(asMember.body.totalCount).toBe(asMember.body.data.length);
    expect((await authed(app, owner).get('/v1/orgs')).body.data.map((o: { id: string }) => o.id)).not.toContain(org.orgId);
  });
  it('If-Match on PATCH: missing 428, W/"n", "n" and * accepted, stale 412 (Review Focus 4)', async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    const url = `/v1/orgs/${org.orgId}`;
    expect((await authed(app, owner).patch(url).send({ name: 'x' })).status).toBe(428);
    expect((await authed(app, owner).patch(url).set('if-match', 'W/"1"').send({ name: 'N2' })).status).toBe(200);
    expect((await authed(app, owner).patch(url).set('if-match', '"2"').send({ name: 'N3' })).status).toBe(200);
    expect((await authed(app, owner).patch(url).set('if-match', '*').send({ name: 'N4' })).status).toBe(200);
    expect((await authed(app, owner).patch(url).set('if-match', 'W/"1"').send({ name: 'N5' })).status).toBe(412);
    const got = await authed(app, owner).get(url);
    expect([got.body.name, got.headers['etag']]).toEqual(['N4', 'W/"4"']);
  });
  it('concurrent renames with the same ETag: one 200, one 412 (Review Focus 4)', async () => {
    const owner = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    const url = `/v1/orgs/${org.orgId}`;
    const [a, b] = await Promise.all([
      authed(app, owner).patch(url).set('if-match', 'W/"1"').send({ name: 'Left' }),
      authed(app, owner).patch(url).set('if-match', 'W/"1"').send({ name: 'Right' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 412]);
  });
  it('members read but cannot rename; admins cannot delete (ownerOnly)', async () => {
    const owner = await seedP();
    const admin = await seedP();
    const member = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    seeded.push(org);
    await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    expect((await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
    expect((await authed(app, member).patch(`/v1/orgs/${org.orgId}`).set('if-match', '*').send({ name: 'no' })).status).toBe(403);
    expect((await authed(app, admin).delete(`/v1/orgs/${org.orgId}`)).status).toBe(403);
  });
  it('GET /v1/permissions lists the merged, non-deprecated catalogue', async () => {
    const p = await seedP();
    const r = await authed(app, p).get('/v1/permissions');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(19);
    expect(r.body.data.find((x: { key: string }) => x.key === 'org.delete')).toMatchObject({ ownerOnly: true, requires: ['org.read'] });
    expect((await request(app.getHttpServer()).get('/v1/permissions')).status).toBe(401);
  });
  it('route inventory + catalogue check stay under 200 ms (tiêu chí 17)', async () => {
    const started = performance.now();
    expect(app.get(OrgRouteInventory).check()).toEqual([]);
    await app.get(CatalogueCheck).onApplicationBootstrap();
    expect(performance.now() - started).toBeLessThan(200);
  });
});
```
`test/e2e/tenancy/org-lifecycle.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const ROUNDS = 10;
const idem = () => `k-${Date.now()}-${Math.random()}`;

describe('org lifecycle (spec SP3 §9.4, tiêu chí 8)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgWith = async () => {
    const owner = await seedP();
    const member = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(`INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'lifecycle.probe', 'fixture.noop', '0 * * * *', 'UTC', '{}', true)`, [org.orgId]),
      ),
    );
    return { owner, member, org };
  };
  const suspendedAt = (orgId: string) =>
    withAppClient((c) => inOrgTx(c, orgId, async () => (await c.query<{ suspended_at: Date | null }>('SELECT suspended_at FROM scheduled_tasks WHERE org_id = $1', [orgId])).rows[0]?.suspended_at));
  beforeAll(async () => {
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('soft delete → 204; members get 404 at once; schedules are suspended; org.deleted carries purgeAfter', async () => {
    const { owner, member, org } = await orgWith();
    expect((await authed(app, owner).delete(`/v1/orgs/${org.orgId}`)).status).toBe(204);
    expect((await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status).toBe(404);
    expect((await authed(app, owner).get(`/v1/orgs/${org.orgId}`)).status).toBe(404);
    expect(await suspendedAt(org.orgId)).not.toBeNull();
    const [evt] = await ownerQuery<{ payload: { purgeAfter: string } }>(`SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.deleted'`, [org.orgId]);
    expect(Date.parse(evt?.payload.purgeAfter ?? '')).toBeGreaterThan(Date.now());
  });
  it('POST /V1/ORGS/<id>/Restore/ reaches the restore handler (G-7); schedules resume; members are back', async () => {
    const { owner, member, org } = await orgWith();
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}`).expect(204);
    const r = await authed(app, owner).post(`/V1/ORGS/${org.orgId.toUpperCase()}/Restore/`).set('idempotency-key', idem()).send({});
    expect([r.status, r.body.deletedAt, r.body.purgeAfter]).toEqual([200, null, null]);
    expect(await suspendedAt(org.orgId)).toBeNull();
    expect((await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
  });
  it('restore of an active org → 409 org_not_deleted; a MEMBER of a deleted org → 403 at the guard', async () => {
    const { owner, member, org } = await orgWith();
    const active = await authed(app, owner).post(`/v1/orgs/${org.orgId}/restore`).set('idempotency-key', idem()).send({});
    expect([active.status, active.body.code]).toEqual([409, 'org_not_deleted']);
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}`).expect(204);
    // Middleware cho member của org xoá mềm đi tiếp ở route khôi phục; guard từ chối vì MEMBER không có org.restore.
    expect((await authed(app, member).post(`/v1/orgs/${org.orgId}/restore`).set('idempotency-key', idem()).send({})).status).toBe(403);
  });
  it('restore after purge_after → 404 (grace expired, compared with clock_timestamp after the lock)', async () => {
    const { owner, org } = await orgWith();
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [org.orgId])));
    expect((await authed(app, owner).post(`/v1/orgs/${org.orgId}/restore`).set('idempotency-key', idem()).send({})).status).toBe(404);
  });
  it(`T-12: ${ROUNDS} rounds of soft delete racing a rename never apply the rename after the delete`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { owner, org } = await orgWith();
      const [del, patch] = await Promise.all([
        authed(app, owner).delete(`/v1/orgs/${org.orgId}`),
        authed(app, owner).patch(`/v1/orgs/${org.orgId}`).set('if-match', '*').send({ name: `Renamed ${i}` }),
      ]);
      expect(del.status).toBe(204);
      expect([200, 404]).toContain(patch.status);
      const row = await withAppClient((c) => inOrgTx(c, org.orgId, async () => (await c.query<{ name: string; version: number }>('SELECT name, version FROM organizations WHERE id = $1', [org.orgId])).rows[0]));
      // Rename thắng thì xảy ra TRƯỚC delete (version 2 → 3); thua thì tên giữ nguyên (version 2).
      expect(row).toEqual(patch.status === 200 ? { name: `Renamed ${i}`, version: 3 } : { name: expect.any(String), version: 2 });
    }
  });
});
```

`test/e2e/tenancy/orgs-single-mode.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const ROUNDS = 10;

describe('TENANCY_MEMBERSHIP_MODE=single + TENANCY_ORG_CREATION=platform_admin (spec SP3 §13, T-7)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const created: string[] = [];
  const create = (p: SeededPrincipal) => authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name: 'Solo' });
  beforeAll(async () => {
    app = await startTenancyApp({ env: { TENANCY_MEMBERSHIP_MODE: 'single', TENANCY_ORG_CREATION: 'platform_admin' } });
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a non-admin cannot create organizations → 403 org_creation_disabled', async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    const r = await create(p);
    expect([r.status, r.body.code]).toEqual([403, 'org_creation_disabled']);
  });
  it(`T-7: ${ROUNDS} rounds of two parallel creates by one admin → one 201, one 409 already_in_an_org`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const admin = await seedUserPrincipal({ role: 'admin' });
      principals.push(admin);
      const [a, b] = await Promise.all([create(admin), create(admin)]);
      for (const r of [a, b]) if (r.status === 201) created.push(r.body.id);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)?.body.code).toBe('already_in_an_org');
    }
  });
});
```
Run:
```bash
pnpm vitest run --project unit test/unit/modules/tenancy/tenancy-http-modules.spec.ts
pnpm vitest run --project integration test/e2e/tenancy test/integration/tenancy
```
Expected: PASS. Tất cả test e2e của Task 22 vẫn xanh sau khi `OrgRouteInventory` được nạp (route khôi phục đã có; probe controller không thuộc module tenancy).

- [ ] **Step 5: OpenAPI, kiểm toàn cục, commit**

Run:
```bash
pnpm build && pnpm openapi:export && git diff --stat openapi.json
pnpm typecheck && pnpm lint && pnpm arch
```
Expected: `openapi.json` thêm 7 operation (`/v1/orgs` GET/POST, `/v1/orgs/{orgId}` GET/PATCH/DELETE, `/v1/orgs/{orgId}/restore` POST, `/v1/permissions` GET), không đổi operation cũ (oasdiff chỉ thêm).
```bash
git add src/core/database/index.ts src/modules/tenancy openapi.json test/support/tenancy-seed.ts test/unit/modules/tenancy/tenancy-http-modules.spec.ts test/e2e/tenancy
git commit -m "feat(tenancy): organization create/list/read/rename, soft delete and restore with member admission and route inventory"
```

---

### Task 24: Member và role — `members/me`, danh sách, đổi role (luật 2, 2a, 3, 4, 5), gỡ, rời org, đọc role (O-1, O-4, O-5, O-9, O-10, O-15, X-4, X-5, B-4/5/6/8/9/18 E2E)

**Files:**
- Create: `src/modules/tenancy/application/member.service.ts`, `src/modules/tenancy/application/escalation-guard.ts`, `src/modules/tenancy/http/members.controller.ts`, `src/modules/tenancy/http/roles.controller.ts`
- Create (test): `test/unit/modules/tenancy/escalation-guard.spec.ts`, `test/e2e/tenancy/members.e2e.spec.ts`, `test/e2e/tenancy/member-races.e2e.spec.ts`, `test/e2e/tenancy/member-toctou.e2e.spec.ts`
- Modify: `src/modules/tenancy/http/schemas.ts`, `src/modules/tenancy/http/tenancy-http.module.ts`, `src/modules/tenancy/tenancy.module.ts`, `openapi.json`

**Interfaces:**
- Consumes: `assertCanBind`, `assertCanManage`, `assertNotSelf`, `type EscalationDecision` (Task 18), `ActorReauthorizer`, `userActor` (Task 23), `MemberRepository`, `RoleRepository` (Task 20), `effectivePermissions` (Task 22), `IdentityDirectory.findUsers` (Task 10, `@Optional`: vắng ở `external`), `TenancyTestHooks` (Task 19), `MemberRoleChangedEvent`, `MemberRemovedEvent` (Task 19), `pgFields` (Task 23), `startTenancyApp({ configure })` (Task 22).
- Produces:
  - `EscalationGuard.enforce(d: EscalationDecision): void` — `ok: false` → metric `tenancy_escalation_denied_total{rule}`, log WARN `{ event: 'escalation_denied', rule }` (không kèm tập quyền), ném `AppError(TenancyErrors[reason])`. 3B/3C/3D dùng lại.
  - `MemberService`: `me()`, `list({ roleId?, page, pageSize })`, `get(memberId)`, `changeRole(memberId, ifMatch, roleId)`, `remove(memberId)`, `leave()`; `RoleService`-đọc tối thiểu trong `RolesController` (3B thay bằng `RoleService`).
  - `MemberResponse { id, userId, role: { id, systemKey, name }, email, name, joinedAt, updatedAt }` (`email`/`name` `null` ở `external`), `RoleResponse { id, systemKey, name, description, permissions, createdAt, updatedAt }`.
  - Route: `GET …/members/me`, `GET …/members`, `GET …/members/:memberId`, `PATCH …/members/:memberId`, `DELETE …/members/me` (`@NarrowingTenancyAction()`, khớp `NARROWING_ROUTES`), `DELETE …/members/:memberId`, `GET …/roles`, `GET …/roles/:roleId`.

- [ ] **Step 1: `EscalationGuard` (unit, fail → pass)**

`test/unit/modules/tenancy/escalation-guard.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/core/errors/index.js';
import { EscalationGuard } from '../../../../src/modules/tenancy/application/escalation-guard.js';
import { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import { TenancyErrors } from '../../../../src/modules/tenancy/errors.js';

describe('EscalationGuard (spec SP3 §8.4, §15, §16)', () => {
  const guard = new EscalationGuard(new TenancyMetrics());
  it('passes an allowed decision', () => {
    expect(() => guard.enforce({ ok: true })).not.toThrow();
  });
  it.each([
    [{ ok: false, rule: '5', reason: 'OWNER_ONLY' } as const, TenancyErrors.OWNER_ONLY],
    [{ ok: false, rule: '2a', reason: 'OWNER_ONLY' } as const, TenancyErrors.OWNER_ONLY],
    [{ ok: false, rule: '2', reason: 'ESCALATION_DENIED' } as const, TenancyErrors.ESCALATION_DENIED],
    [{ ok: false, rule: '3', reason: 'CANNOT_CHANGE_OWN_ROLE' } as const, TenancyErrors.CANNOT_CHANGE_OWN_ROLE],
  ])('%j → %j', (decision, code) => {
    let caught: unknown;
    try {
      guard.enforce(decision);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).error).toBe(code);
  });
});
```
`src/modules/tenancy/application/escalation-guard.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../core/errors/index.js';
import type { EscalationDecision } from '../domain/escalation.js';
import { TenancyErrors } from '../errors.js';
import { TenancyMetrics } from './tenancy-metrics.js';

/** Đổi quyết định của domain (spec SP3 §8.4) thành lỗi HTTP + metric + log WARN có `rule`, không kèm tập quyền. */
@Injectable()
export class EscalationGuard {
  private readonly logger = new Logger(EscalationGuard.name);

  constructor(private readonly metrics: TenancyMetrics) {}

  enforce(d: EscalationDecision): void {
    if (d.ok) return;
    this.metrics.escalationDenied.add(1, { rule: d.rule });
    this.logger.warn({ event: 'escalation_denied', rule: d.rule }, 'escalation rule denied the request');
    switch (d.reason) {
      case 'OWNER_ONLY':
        throw new AppError(TenancyErrors.OWNER_ONLY);
      case 'ESCALATION_DENIED':
        throw new AppError(TenancyErrors.ESCALATION_DENIED);
      case 'CANNOT_CHANGE_OWN_ROLE':
        throw new AppError(TenancyErrors.CANNOT_CHANGE_OWN_ROLE);
      default: {
        const unknown: never = d.reason;
        throw new Error(`unknown escalation reason ${String(unknown)}`);
      }
    }
  }
}
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/escalation-guard.spec.ts`
Expected: FAIL rồi PASS sau khi tạo file.

- [ ] **Step 2: `MemberService`**

`src/modules/tenancy/application/member.service.ts`:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { IdentityDirectory, identityConfig, type DirectoryUser } from '../../identity/index.js';
import { assertCanBind, assertCanManage, assertNotSelf, type Actor } from '../domain/escalation.js';
import { MemberRemovedEvent, MemberRoleChangedEvent } from '../events.js';
import { MemberRepository, type MemberRow } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { effectivePermissions } from './authz/effective-permissions.js';
import { EscalationGuard } from './escalation-guard.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';
import { TenancyMetrics, type LastOwnerPath } from './tenancy-metrics.js';

export type MemberView = MemberRow & { email: string | null; name: string | null };
const LAST_OWNER_CONSTRAINT = 'org_members_last_owner_ck';

/**
 * Mutation member (spec SP3 §8.4, §8.6): khoá org → đọc target → đọc lại actor + target `FOR SHARE` (id tăng dần) → kiểm
 * lại cửa → luật 3, 4/2a(v)/5, 2/2a(iv)/5 → ghi → outbox. Trigger hoãn owner cuối là lớp chặn cuối (T-1, T-28).
 */
@Injectable()
export class MemberService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly roles: RoleRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly escalation: EscalationGuard,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    private readonly metrics: TenancyMetrics,
    @Inject(identityConfig.KEY) private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  async me(): Promise<MemberView> {
    const ref = this.ctx.orgAccess()?.ref;
    const row = ref === undefined ? undefined : await this.members.findByPublicId(ref);
    if (!row) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return (await this.withProfiles([row]))[0] ?? this.orphan(row);
  }

  async list(q: { roleId?: string; page: number; pageSize: number; cap: number }): Promise<{ rows: MemberView[]; total: number }> {
    let roleId: string | undefined;
    if (q.roleId !== undefined) {
      const role = await this.roles.findByPublicId(q.roleId);
      if (!role) return { rows: [], total: 0 };
      roleId = role.id;
    }
    const [rows, total] = await Promise.all([
      this.members.list({ roleId, limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      this.members.countUpTo(roleId, q.cap),
    ]);
    return { rows: await this.withProfiles(rows), total };
  }

  async get(memberId: string): Promise<MemberView> {
    const row = await this.members.findByPublicId(memberId);
    if (!row) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return (await this.withProfiles([row]))[0] ?? this.orphan(row);
  }

  async changeRole(memberId: string, ifMatch: string | undefined, rolePublicId: string): Promise<MemberRow> {
    await this.hooks.afterGuard();
    return this.lastOwnerGuarded('demote', () =>
      this.uow.run(async () => {
        await this.lockActiveOrg();
        const target = await this.members.findByPublicId(memberId);
        if (!target) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const { actor, permissions, locked } = await this.reauth.require(['members.role.assign'], [target.id]);
        const current = locked.find((m) => m.id === target.id);
        if (!current) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const role = await this.roles.findByPublicId(rolePublicId);
        if (!role)
          throw new AppError(CoreErrors.VALIDATION_FAILED, { fields: [{ path: 'roleId', code: 'not_found', message: 'roleId is not a role of this organization' }] });
        assertIfMatch(ifMatch, current.version, { required: true });
        const merged = this.registry.merged();
        const me: Actor = { memberRef: actor.publicId, isOwner: actor.systemKey === 'OWNER', permissions };
        this.escalation.enforce(assertNotSelf(me, current.publicId));
        this.escalation.enforce(
          assertCanManage(me, { memberRef: current.publicId, isOwner: current.systemKey === 'OWNER', permissions: new Set(effectivePermissions(current, merged)) }, merged),
        );
        this.escalation.enforce(assertCanBind(me, { systemKey: role.systemKey, permissions: new Set(effectivePermissions(role, merged)) }, merged));
        if (role.id === current.roleId) return current;
        const updated = await this.members.changeRole(current.id, role.id);
        await this.events.publish(MemberRoleChangedEvent, {
          data: { memberId: updated.publicId, userId: updated.userPublicId, fromRoleId: current.rolePublicId, toRoleId: updated.rolePublicId, reason: 'ASSIGNED' },
          aggregate: { type: 'member', id: updated.publicId, version: updated.version },
          actor: userActor(this.ctx),
        });
        return updated;
      }),
    );
  }

  async remove(memberId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.lastOwnerGuarded('remove', () =>
      this.uow.run(async () => {
        await this.lockActiveOrg();
        const target = await this.members.findByPublicId(memberId);
        if (!target) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const { actor, permissions, locked } = await this.reauth.require(['members.remove'], [target.id]);
        const current = locked.find((m) => m.id === target.id);
        if (!current) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const merged = this.registry.merged();
        const me: Actor = { memberRef: actor.publicId, isOwner: actor.systemKey === 'OWNER', permissions };
        this.escalation.enforce(
          assertCanManage(me, { memberRef: current.publicId, isOwner: current.systemKey === 'OWNER', permissions: new Set(effectivePermissions(current, merged)) }, merged),
        );
        await this.deleteWithEvent(current, 'REMOVED');
      }),
    );
  }

  /** Rời org (`@NarrowingTenancyAction()`): không cần session mới; owner cuối → 409 `last_owner` (trigger). */
  async leave(): Promise<void> {
    await this.lastOwnerGuarded('leave', () =>
      this.uow.run(async () => {
        await this.lockActiveOrg();
        const { actor } = await this.reauth.require([]);
        await this.deleteWithEvent(actor, 'LEFT');
      }),
    );
  }

  private async deleteWithEvent(m: MemberRow, reason: 'REMOVED' | 'LEFT'): Promise<void> {
    // 3C: huỷ chuyển quyền PENDING của member trước khi xoá; 3D: phát `api_key.revoked` từng key (spec Bảng 5).
    await this.members.deleteById(m.id);
    await this.events.publish(MemberRemovedEvent, {
      data: { memberId: m.publicId, userId: m.userPublicId, roleId: m.rolePublicId, reason },
      aggregate: { type: 'member', id: m.publicId, version: m.version + 1 },
      actor: userActor(this.ctx),
    });
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12, O-10
  }

  /** Trigger owner cuối bắn lúc COMMIT; 409 do constraint map, ở đây chỉ đếm metric theo đường. */
  private async lastOwnerGuarded<T>(path: LastOwnerPath, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgFields(err)?.constraint === LAST_OWNER_CONSTRAINT) this.metrics.lastOwnerBlocked.add(1, { path });
      throw err;
    }
  }

  /** Email/tên qua `IdentityDirectory.findUsers` một lần mỗi trang (local/hybrid); `external` → `null` (spec §11). */
  private async withProfiles(rows: readonly MemberRow[]): Promise<MemberView[]> {
    const ids = rows.flatMap((r) => (r.authUserId ? [r.authUserId] : []));
    const users: DirectoryUser[] = this.identity.mode === 'external' || !this.directory || ids.length === 0 ? [] : await this.directory.findUsers(ids);
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = r.authUserId ? byId.get(r.authUserId) : undefined;
      return { ...r, email: u?.email ?? null, name: u?.name ?? null };
    });
  }

  private orphan(row: MemberRow): MemberView {
    return { ...row, email: null, name: null };
  }
}
```
Ghi chú version của event xoá: dòng đã mất nên không có `version` sau thay đổi; quy ước "`aggregate.version` = version sau thay đổi" (spec §14) lấy `version + 1` như một lần ghi cuối, nhất quán cho mọi đường xoá (3D dùng lại).

- [ ] **Step 3: Schema, controller, module**

`src/modules/tenancy/http/schemas.ts` thêm:
```ts
import type { MemberView } from '../application/member.service.js';
import type { RoleRow } from '../ports/role-repository.js';

export const MemberResponse = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  role: z.object({ id: z.uuid(), systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(), name: z.string().nullable() }),
  email: z.string().nullable(),
  name: z.string().nullable(),
  joinedAt: iso,
  updatedAt: iso,
});
export const memberOf = (m: MemberView): z.infer<typeof MemberResponse> => ({
  id: m.publicId,
  userId: m.userPublicId,
  role: { id: m.rolePublicId, systemKey: m.systemKey, name: m.roleName },
  email: m.email,
  name: m.name,
  joinedAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});
export const ListMembersPage = offsetPageQuery({ sortable: ['joinedAt'] as const });
export const RoleFilterQuery = z.object({ roleId: z.uuid().optional() });
export const ChangeRoleBody = z.object({ roleId: z.uuid() }).strict();
export const PublicIdParam = z.uuid();

export const RoleResponse = z.object({
  id: z.uuid(),
  systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
  createdAt: iso,
  updatedAt: iso,
});
export const roleOf = (r: RoleRow, permissions: readonly string[]): z.infer<typeof RoleResponse> => ({
  id: r.publicId,
  systemKey: r.systemKey,
  name: r.name,
  description: r.description,
  permissions: [...permissions],
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
export const RoleListResponse = z.object({ data: z.array(RoleResponse) });
```
`src/modules/tenancy/http/members.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Inject, Param, Patch, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, Paginator, etagOf, paginationConfig, serialize, type HeaderWriter } from '../../../core/http/index.js';
import { MemberService } from '../application/member.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { NarrowingTenancyAction, OrgMemberOnly, SensitiveTenancyAction } from './decorators.js';
import { ChangeRoleBody, ListMembersPage, MemberResponse, PublicIdParam, RoleFilterQuery, memberOf } from './schemas.js';

/** Id không phải UUID là "không có resource như vậy" (404), không phải lỗi SQL 22P02 (500). */
const idOrNotFound = (raw: string): string => {
  const r = PublicIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};

/** `me` khai báo TRƯỚC `:memberId` (Express khớp theo thứ tự đăng ký; spec SP3 §12). */
@Controller('v1/orgs/:orgId/members')
export class MembersController {
  constructor(
    private readonly members: MemberService,
    private readonly pages: Paginator,
    // `Paginator` giữ config ở `private readonly cfg` (SP1 `core/http/pagination.ts`): trần đếm đọc thẳng từ config (review I7).
    @Inject(paginationConfig.KEY) private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get('me')
  @OrgMemberOnly()
  @ApiOk(MemberResponse)
  async me(@Res({ passthrough: true }) res: HeaderWriter) {
    const m = await this.members.me();
    res.setHeader('ETag', etagOf(m.version));
    return serialize(MemberResponse, memberOf(m));
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrgMemberOnly()
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.LAST_OWNER)
  async leave(): Promise<void> {
    await this.members.leave();
  }

  @Get()
  @TenancyPermissions.require('members.read')
  @ApiOk(MemberResponse)
  async list(@Query({ schema: ListMembersPage }) page: z.infer<typeof ListMembersPage>, @Query({ schema: RoleFilterQuery }) filter: z.infer<typeof RoleFilterQuery>) {
    if (page.sort?.direction === 'desc') throw new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'Only sort=joinedAt (ascending) is supported.' });
    const { rows, total } = await this.members.list({ roleId: filter.roleId, page: page.page, pageSize: page.pageSize, cap: this.pagination.totalCountCap });
    return this.pages.offset(rows.map((m) => serialize(MemberResponse, memberOf(m))), page, total);
  }

  @Get(':memberId')
  @TenancyPermissions.require('members.read')
  @ApiOk(MemberResponse)
  async get(@Param('memberId') memberId: string, @Res({ passthrough: true }) res: HeaderWriter) {
    const m = await this.members.get(idOrNotFound(memberId));
    res.setHeader('ETag', etagOf(m.version));
    return serialize(MemberResponse, memberOf(m));
  }

  @Patch(':memberId')
  @TenancyPermissions.require('members.role.assign')
  @SensitiveTenancyAction()
  @ApiOk(MemberResponse)
  @ApiProblems(TenancyErrors.OWNER_ONLY, TenancyErrors.ESCALATION_DENIED, TenancyErrors.CANNOT_CHANGE_OWN_ROLE, TenancyErrors.LAST_OWNER, CoreErrors.PRECONDITION_REQUIRED, CoreErrors.PRECONDITION_FAILED)
  async changeRole(
    @Param('memberId') memberId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: ChangeRoleBody }) body: z.infer<typeof ChangeRoleBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const updated = await this.members.changeRole(idOrNotFound(memberId), ifMatch, body.roleId.toLowerCase());
    const view = await this.members.get(updated.publicId);
    res.setHeader('ETag', etagOf(view.version));
    return serialize(MemberResponse, memberOf(view));
  }

  @Delete(':memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('members.remove')
  @SensitiveTenancyAction()
  @ApiProblems(TenancyErrors.OWNER_ONLY, TenancyErrors.ESCALATION_DENIED, TenancyErrors.LAST_OWNER)
  async remove(@Param('memberId') memberId: string): Promise<void> {
    await this.members.remove(idOrNotFound(memberId));
  }
}
```
`src/modules/tenancy/http/roles.controller.ts`:
```ts
import { Controller, Get, Param } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, serialize } from '../../../core/http/index.js';
import { effectivePermissions } from '../application/authz/effective-permissions.js';
import { PermissionCatalogueRegistry } from '../application/permission-catalogue.registry.js';
import { TenancyPermissions } from '../permissions.js';
import { RoleRepository } from '../ports/role-repository.js';
import { PublicIdParam, RoleListResponse, RoleResponse, roleOf } from './schemas.js';

/** 3A: chỉ role hệ thống, tập quyền tính trong code (spec SP3 §8.3). 3B thay bằng `RoleService` + route ghi. */
@Controller('v1/orgs/:orgId/roles')
export class RolesController {
  constructor(
    private readonly roles: RoleRepository,
    private readonly registry: PermissionCatalogueRegistry,
  ) {}

  @Get()
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleListResponse)
  async list() {
    const merged = this.registry.merged();
    const data = (await this.roles.list()).map((r) => roleOf(r, effectivePermissions(r, merged)));
    return serialize(RoleListResponse, { data });
  }

  @Get(':roleId')
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleResponse)
  async get(@Param('roleId') roleId: string) {
    const id = PublicIdParam.safeParse(roleId);
    const role = id.success ? await this.roles.findByPublicId(id.data.toLowerCase()) : undefined;
    if (!role) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return serialize(RoleResponse, roleOf(role, effectivePermissions(role, this.registry.merged())));
  }
}
```
`tenancy-http.module.ts`: `controllers` thêm `MembersController, RolesController`; `providers` thêm `MemberService`. `tenancy.module.ts`: `TenancyCoreModule` thêm `EscalationGuard` vào `providers` + `exports`.

- [ ] **Step 4: E2E member (fail trước Step 2–3)**

`test/e2e/tenancy/members.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, type SeededMember, type SeededOrg } from '../../support/tenancy-seed.js';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

describe('members API (spec SP3 §8.4, §12)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** Org với một người giữ mỗi role hệ thống (owner thứ hai khi cần). */
  const cast = async (extra: Role[] = []) => {
    const o = await seedP();
    const org = await seedOrg({ owner: { authUserId: o.authUserId } });
    orgs.push(org);
    const people: { p: SeededPrincipal; m: SeededMember }[] = [];
    for (const role of ['ADMIN', 'MEMBER', ...extra] as Role[]) {
      const p = await seedP();
      people.push({ p, m: await seedMember(org, role, { authUserId: p.authUserId }) });
    }
    return { org, owner: { p: o, m: org.owner }, admin: people[0]!, member: people[1]!, extra: people.slice(2) };
  };
  const patchRole = (as: SeededPrincipal, org: SeededOrg, target: SeededMember, role: Role, ifMatch = '*') =>
    authed(app, as).patch(`/v1/orgs/${org.orgId}/members/${target.memberPublicId}`).set('if-match', ifMatch).send({ roleId: org.roles[role].publicId });
  beforeAll(async () => {
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('GET members/me returns the caller with userId (tenancy public id), email and name; not swallowed by :memberId', async () => {
    const c = await cast();
    const r = await authed(app, c.member.p).get(`/v1/orgs/${c.org.orgId}/members/me`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: c.member.m.memberPublicId, userId: c.member.m.userPublicId, role: { systemKey: 'MEMBER' }, email: c.member.p.email, name: 'Seeded' });
  });
  it('lists members with offset paging and ?roleId=; a non-UUID member id is 404', async () => {
    const c = await cast();
    const all = await authed(app, c.member.p).get(`/v1/orgs/${c.org.orgId}/members`);
    expect([all.status, all.body.totalCount]).toEqual([200, 3]);
    const admins = await authed(app, c.member.p).get(`/v1/orgs/${c.org.orgId}/members?roleId=${c.org.roles.ADMIN.publicId}`);
    expect(admins.body.data.map((m: { id: string }) => m.id)).toEqual([c.admin.m.memberPublicId]);
    expect((await authed(app, c.member.p).get(`/v1/orgs/${c.org.orgId}/members/not-a-uuid`)).status).toBe(404);
  });
  it('GET roles lists the three system roles with their computed permission sets', async () => {
    const c = await cast();
    const r = await authed(app, c.member.p).get(`/v1/orgs/${c.org.orgId}/roles`);
    expect(r.body.data.map((x: { systemKey: string }) => x.systemKey)).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
    expect(r.body.data[2].permissions).toEqual(['members.read', 'org.read', 'roles.read']);
  });
  it.each([
    ['B-4: ADMIN assigns OWNER', 'admin', 'member', 'OWNER', 403, 'owner_only'],
    ['B-5: OWNER assigns OWNER', 'owner', 'member', 'OWNER', 200, undefined],
    ['B-18: ADMIN assigns ADMIN', 'admin', 'member', 'ADMIN', 403, 'owner_only'],
    ['B-8: ADMIN demotes another ADMIN', 'admin', 'extra', 'MEMBER', 403, 'owner_only'],
    ['B-9: ADMIN demotes an OWNER', 'admin', 'owner', 'MEMBER', 403, 'owner_only'],
    ['ADMIN promotes nobody past MEMBER → MEMBER is a no-op 200', 'admin', 'member', 'MEMBER', 200, undefined],
    ['MEMBER lacks members.role.assign', 'member', 'admin', 'MEMBER', 403, 'forbidden'],
  ] as const)('%s → %i %s', async (_name, as, target, role, status, code) => {
    const c = await cast(['ADMIN']);
    const who = { owner: c.owner, admin: c.admin, member: c.member, extra: c.extra[0]! };
    const r = await patchRole(who[as].p, c.org, who[target].m, role);
    expect(r.status).toBe(status);
    if (code) expect(r.body.code).toBe(code);
  });
  it('B-6: nobody changes their own role, owners included → 403 cannot_change_own_role', async () => {
    const c = await cast();
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const)
      expect((await patchRole(c.owner.p, c.org, c.owner.m, role)).body.code).toBe('cannot_change_own_role');
    expect((await patchRole(c.admin.p, c.org, c.admin.m, 'MEMBER')).body.code).toBe('cannot_change_own_role');
  });
  it('member role change honours If-Match (Review Focus 4): missing 428, stale 412', async () => {
    const c = await cast();
    const url = `/v1/orgs/${c.org.orgId}/members/${c.member.m.memberPublicId}`;
    expect((await authed(app, c.owner.p).patch(url).send({ roleId: c.org.roles.ADMIN.publicId })).status).toBe(428);
    expect((await patchRole(c.owner.p, c.org, c.member.m, 'ADMIN', 'W/"1"')).status).toBe(200);
    expect((await patchRole(c.owner.p, c.org, c.member.m, 'MEMBER', 'W/"1"')).status).toBe(412);
  });
  it('O-1: the sole owner cannot leave or remove themselves (409 last_owner); self-demotion hits rule 3 first', async () => {
    const c = await cast();
    const leave = await authed(app, c.owner.p).delete(`/v1/orgs/${c.org.orgId}/members/me`);
    expect([leave.status, leave.body.code]).toEqual([409, 'last_owner']);
    const self = await authed(app, c.owner.p).delete(`/v1/orgs/${c.org.orgId}/members/${c.owner.m.memberPublicId}`);
    expect([self.status, self.body.code]).toEqual([409, 'last_owner']);
    expect((await patchRole(c.owner.p, c.org, c.owner.m, 'ADMIN')).body.code).toBe('cannot_change_own_role');
  });
  it('a MEMBER leaves with an old session (narrowing route, no fresh session); ADMIN removes a MEMBER', async () => {
    const c = await cast(['MEMBER']);
    const old = await seedP({ sessionAgeSec: 7200 });
    await seedMember(c.org, 'MEMBER', { authUserId: old.authUserId });
    expect((await authed(app, old).delete(`/v1/orgs/${c.org.orgId}/members/me`)).status).toBe(204);
    expect((await authed(app, c.admin.p).delete(`/v1/orgs/${c.org.orgId}/members/${c.extra[0]!.m.memberPublicId}`)).status).toBe(204);
    const events = await ownerQuery<{ type: string; payload: { reason: string } }>(
      `SELECT type, payload FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.removed' ORDER BY id`, [c.org.orgId]);
    expect(events.map((e) => e.payload.reason)).toEqual(['LEFT', 'REMOVED']);
  });
  it('O-10: on a soft-deleted org, changing an owner is the uniform 404 (only restore passes the middleware)', async () => {
    const c = await cast(['OWNER']);
    await authed(app, c.owner.p).delete(`/v1/orgs/${c.org.orgId}`).expect(204);
    expect((await patchRole(c.owner.p, c.org, c.extra[0]!.m, 'MEMBER')).status).toBe(404);
    expect((await authed(app, c.owner.p).delete(`/v1/orgs/${c.org.orgId}/members/${c.extra[0]!.m.memberPublicId}`)).status).toBe(404);
  });
  it('O-9: only a member row can hold OWNER — org_members has no column for keys or grants', async () => {
    const cols = await ownerQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_members' ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(['created_at', 'id', 'org_id', 'public_id', 'role_id', 'updated_at', 'user_id', 'version']);
  });
  it('O-15: promoting to OWNER or demoting/removing an owner with a stale session → 403 reauthentication_required', async () => {
    const c = await cast(['OWNER']);
    const stale = await seedP({ sessionAgeSec: 7200 });
    await seedMember(c.org, 'OWNER', { authUserId: stale.authUserId });
    expect((await patchRole(stale, c.org, c.member.m, 'OWNER')).body.code).toBe('reauthentication_required');
    expect((await patchRole(stale, c.org, c.extra[0]!.m, 'ADMIN')).body.code).toBe('reauthentication_required');
    expect((await authed(app, stale).delete(`/v1/orgs/${c.org.orgId}/members/${c.extra[0]!.m.memberPublicId}`)).body.code).toBe('reauthentication_required');
  });
});
```
`test/e2e/tenancy/member-races.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';
import { prng } from '../../unit/modules/tenancy/prng.js';

const ROUNDS = 50;
const X5_OPS = 20;
const INSERT_BUDGET_MS = 1000;

describe('member races (spec SP3 §17 T-1, T-24; §18.3 O-4, O-5, X-5)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const owners = (orgId: string) =>
    withAppClient((c) => inOrgTx(c, orgId, async () => Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`)).rows[0]?.n)));
  const twoOwners = async () => {
    const a = await seedP();
    const b = await seedP();
    const org = await seedOrg({ owner: { authUserId: a.authUserId } });
    orgs.push(org);
    const bm = await seedMember(org, 'OWNER', { authUserId: b.authUserId });
    return { org, a, b, am: org.owner, bm };
  };
  beforeAll(async () => {
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`O-4: ${ROUNDS} rounds of two owners demoting each other → exactly one succeeds, one owner remains`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { org, a, b, am, bm } = await twoOwners();
      const [x, y] = await Promise.all([
        authed(app, a).patch(`/v1/orgs/${org.orgId}/members/${bm.memberPublicId}`).set('if-match', '*').send({ roleId: org.roles.ADMIN.publicId }),
        authed(app, b).patch(`/v1/orgs/${org.orgId}/members/${am.memberPublicId}`).set('if-match', '*').send({ roleId: org.roles.ADMIN.publicId }),
      ]);
      expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
      expect([x.status, y.status].every((s) => s === 200 || s === 403 || s === 409)).toBe(true);
      expect(await owners(org.orgId)).toBe(1);
    }
  });
  it(`O-5: ${ROUNDS} rounds of two owners leaving together → exactly one 204, the other 409 last_owner`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { org, a, b } = await twoOwners();
      const [x, y] = await Promise.all([
        authed(app, a).delete(`/v1/orgs/${org.orgId}/members/me`),
        authed(app, b).delete(`/v1/orgs/${org.orgId}/members/me`),
      ]);
      expect([x.status, y.status].sort()).toEqual([204, 409]);
      expect(await owners(org.orgId)).toBe(1);
    }
  });
  it(`X-5 (system roles): ${X5_OPS} random admin mutations at once — no deadlock, no 5xx, ≥ 1 owner, feature INSERTs not blocked`, async () => {
    const { org, a, b } = await twoOwners();
    const targets = [];
    for (let i = 0; i < 3; i++) targets.push(await seedMember(org, 'MEMBER', { authUserId: (await seedP()).authUserId }));
    const rnd = prng(20260928);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const ops = Array.from({ length: X5_OPS }, () =>
      authed(app, pick([a, b]))
        .patch(`/v1/orgs/${org.orgId}/members/${pick(targets).memberPublicId}`)
        .set('if-match', '*')
        .send({ roleId: pick([org.roles.ADMIN, org.roles.MEMBER, org.roles.OWNER]).publicId }),
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
    expect(responses.every((r) => r.status < 500)).toBe(true);
    expect(Math.max(...latencies)).toBeLessThan(INSERT_BUDGET_MS);
    expect(await owners(org.orgId)).toBeGreaterThanOrEqual(1);
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [org.orgId])));
  });
});
```
`test/e2e/tenancy/member-toctou.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenancyTestHooks } from '../../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

/** Seam X-4: chạy một lần hành động của test giữa guard và transaction. */
class ScriptedHooks extends TenancyTestHooks {
  next: (() => Promise<void>) | undefined;
  async afterGuard(): Promise<void> {
    const fn = this.next;
    this.next = undefined;
    await fn?.();
  }
  beforeRelease(): Promise<void> {
    return Promise.resolve();
  }
}

describe('X-4 / T-10: the actor is re-read inside the transaction (spec SP3 §8.6)', () => {
  const hooks = new ScriptedHooks();
  let app: INestApplication;
  let org: SeededOrg;
  const principals: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startTenancyApp({ configure: (b) => b.overrideProvider(TenancyTestHooks).useValue(hooks) });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('an ADMIN demoted to MEMBER after the guard is refused with 403 by the in-transaction check', async () => {
    const owner = await seedUserPrincipal();
    const admin = await seedUserPrincipal();
    const target = await seedUserPrincipal();
    principals.push(owner, admin, target);
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const am = await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    const tm = await seedMember(org, 'MEMBER', { authUserId: target.authUserId });
    hooks.next = () =>
      withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('UPDATE org_members SET role_id = $1 WHERE id = $2', [org.roles.MEMBER.id, am.memberId])));
    const r = await authed(app, admin).delete(`/v1/orgs/${org.orgId}/members/${tm.memberPublicId}`);
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect((await authed(app, admin).get(`/v1/orgs/${org.orgId}/members/${tm.memberPublicId}`)).status).toBe(200);
  });
});
```
Run:
```bash
pnpm vitest run --project integration test/e2e/tenancy
```
Expected: PASS (O-4/O-5 50 vòng; X-5 không 5xx, INSERT feature < 1 s; X-4 403 từ kiểm trong transaction).

- [ ] **Step 5: OpenAPI, kiểm toàn cục, commit**

Run:
```bash
pnpm build && pnpm openapi:export && git diff --stat openapi.json
pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run --project unit
```
Expected: 8 operation mới (members ×6, roles ×2); inventory: `DELETE v1/orgs/:orgId/members/me` là route "thu hẹp" duy nhất, khớp `NARROWING_ROUTES`.
```bash
git add src/modules/tenancy openapi.json test/unit/modules/tenancy/escalation-guard.spec.ts test/e2e/tenancy
git commit -m "feat(tenancy): members and system roles API with set-based escalation checks, leave and last-owner protection"
```

---

## Phần G — Vòng đời xuyên module, ma trận, chaos (spec §9.5, §9.6, §11, §18.2–§18.4)

### Task 25: Xoá cứng org — cron `tenancy.orgs.purge` theo con trỏ, job `tenancy.org.purge`, participant `core.scheduled-tasks`; T-13, T-14, X-10, X-11 (khôi phục/purge)

**Files:**
- Create: `src/modules/tenancy/jobs.ts`, `src/modules/tenancy/application/purge-orgs.handler.ts`, `src/modules/tenancy/application/scheduled-tasks.participant.ts`
- Create (test): `test/unit/modules/tenancy/jobs.spec.ts`, `test/integration/tenancy/org-purge.spec.ts`, `test/integration/tenancy/org-lifecycle-jobs.spec.ts`
- Modify: `src/modules/tenancy/tenancy.module.ts`, `test/support/tenancy-seed.ts` (`dueOrgIds`)

**Interfaces:**
- Consumes: `tenancyCoreImports` (Task 19), `AppWorkerModule` + `APP_MODULES.worker` có `TenancyModule.forWorker()` (Task 19), `OrgRepository.dueForPurge/lockCurrent/clockNow/purgeCurrent` (Task 20), `transitionOrg` (Task 18), `OrgPurgeParticipantRegistry`, `OrgPurgeParticipantContributor`, `OrgPurgeParticipant`, `TenancyMetrics`, `tenancySpan`, `tenancyConfig`, `OrgPurgedEvent` (Task 19), `OrgLifecycleService` (Task 23), `ScheduledTaskService.removeAllForCurrentOrg/syncCurrentOrg` (Task 7), `JobDef.onInactiveOrg` + gate (Task 6, Task 20), `PURGE_CURSOR_START` (Task 15), `JobQueue`, `SafeEnqueue`, `MaintenanceQueue`, `defineJob`, `defineCron`, `JobHandler`, `EventSubscriber`, `bootstrapWorker` (SP1).
- Produces:
  - `PurgeOrgsJob` (`tenancy.orgs.purge`, `MaintenanceQueue`, payload `{}`), cron `tenancy.orgs.purge` (`TENANCY_ORG_PURGE_CRON`/`_TZ`); `PurgeOrgJob` (`tenancy.org.purge`, `MaintenanceQueue`, payload `{}` strict, `onInactiveOrg: 'run'`); `purgeJobId(orgId) = 'tenancy-purge-<orgId>'`.
  - `PurgeOrgsHandler.handle(ctx): Promise<number>` (số job đã enqueue; WARN `org_purge_backlog` khi chạm `MAX_BATCHES` mà lô cuối đầy); `PurgeOrgHandler.handle(ctx)` → kết quả `'purged' | 'gone' | 'skipped'` (metric `tenancy_org_purge_total{result}`; lỗi → `tenancy_org_purge_failed_total` + ném lại).
  - `ScheduledTasksPurgeParticipant` (`key = 'core.scheduled-tasks'`, `order = 0`).
  - Test support: `dueOrgIds(): Promise<string[]>` (mọi org đang tới hạn purge, qua hàm definer).

- [ ] **Step 1: Định nghĩa job + unit (fail → pass)**

`test/unit/modules/tenancy/jobs.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assertEnqueueOpts } from '../../../../src/core/queue/job-definition.js';
// `cronRegistry` không có trong `core/scheduler/index.ts`; chỉ `cron-definition.ts` export nó (review M1).
import { cronRegistry } from '../../../../src/core/scheduler/cron-definition.js';
import { PurgeOrgJob, PurgeOrgsJob, purgeJobId } from '../../../../src/modules/tenancy/jobs.js';

describe('tenancy jobs (spec SP3 §9.5, CDX-7)', () => {
  it('the per-org purge job runs on inactive orgs and its jobId passes the core rules (no ":")', () => {
    expect(PurgeOrgJob.onInactiveOrg).toBe('run');
    const id = purgeJobId('0198c000-0000-7000-8000-000000000001');
    expect(id).toBe('tenancy-purge-0198c000-0000-7000-8000-000000000001');
    expect(() => assertEnqueueOpts(PurgeOrgJob, { jobId: id })).not.toThrow();
  });
  it('the cron is registered on the maintenance queue', () => {
    expect(cronRegistry().find((c) => c.key === 'tenancy.orgs.purge')?.job).toBe(PurgeOrgsJob);
    expect(PurgeOrgsJob.onInactiveOrg).toBe('skip');
  });
});
```
`src/modules/tenancy/jobs.ts`:
```ts
import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../../core/queue/index.js';
import { defineCron } from '../../core/scheduler/index.js';
import { tenancyConfig } from './tenancy.config.js';

/** Cron: đi qua org tới hạn theo con trỏ keyset, enqueue một job mỗi org (spec SP3 §9.5, CDX-8). Không org nào trong meta. */
export const PurgeOrgsJob = defineJob({ name: 'tenancy.orgs.purge', queue: MaintenanceQueue, version: 1, schema: z.object({}) });
/**
 * Xoá cứng MỘT org; org ở `meta.orgId` (worker tự mở OrgScope), payload rỗng. `onInactiveOrg: 'run'`: job này CHỈ có
 * nghĩa trên org đã xoá mềm (gate mặc định sẽ bỏ qua nó, spec §5.2).
 */
export const PurgeOrgJob = defineJob({
  name: 'tenancy.org.purge',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}).strict(),
  onInactiveOrg: 'run',
});
/** `-`, không `:` (core cấm `:` trong jobId, CDX-7); BullMQ bỏ qua `add` trùng id khi job cùng id còn được giữ (T-14). */
export const purgeJobId = (orgId: string): string => `tenancy-purge-${orgId}`;

defineCron({
  key: 'tenancy.orgs.purge',
  job: PurgeOrgsJob,
  payload: {},
  schedule: () => {
    const c = tenancyConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
});
```
Run: `pnpm vitest run --project unit test/unit/modules/tenancy/jobs.spec.ts`
Expected: PASS sau khi tạo file.

- [ ] **Step 2: Handler cron + job, participant**

`src/modules/tenancy/application/purge-orgs.handler.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { JobHandler, JobQueue, type JobContext } from '../../../core/queue/index.js';
import { ScheduledTaskService } from '../../../core/scheduler/index.js';
import { PURGE_CURSOR_START } from '../constants.js';
import { orgStateOf, transitionOrg } from '../domain/organization.js';
import { OrgPurgedEvent } from '../events.js';
import { PurgeOrgJob, PurgeOrgsJob, purgeJobId } from '../jobs.js';
import { OrgRepository } from '../ports/org-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { OrgPurgeParticipantRegistry } from './org-purge-participant.registry.js';
import { TenancyMetrics } from './tenancy-metrics.js';

const PURGE_ACTOR = { type: 'system', id: 'tenancy.orgs.purge' } as const;
type PurgeResult = 'purged' | 'gone' | 'skipped';

/**
 * Spec SP3 §9.5: con trỏ keyset tăng dần (lô sau không trả lại lô trước; org purge lỗi lâu dài không chặn org sau).
 * Chạm `MAX_BATCHES` mà lô cuối vẫn đầy → WARN `org_purge_backlog`; lượt sau bắt đầu lại từ đầu (giới hạn đã biết).
 */
@Injectable()
@JobHandler(PurgeOrgsJob)
export class PurgeOrgsHandler {
  private readonly logger = new Logger(PurgeOrgsHandler.name);

  constructor(
    private readonly orgs: OrgRepository,
    private readonly queue: JobQueue,
    @Inject(tenancyConfig.KEY) private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<number> {
    let cursor = PURGE_CURSOR_START;
    let enqueued = 0;
    for (let batch = 0; batch < this.cfg.purgeMaxBatches; batch++) {
      ctx.signal.throwIfAborted();
      const due = await this.orgs.dueForPurge(cursor, this.cfg.purgeBatchSize);
      for (const orgId of due) {
        await this.queue.enqueue(PurgeOrgJob, {}, { jobId: purgeJobId(orgId), meta: { orgId } });
        enqueued += 1;
      }
      const last = due.at(-1);
      if (due.length < this.cfg.purgeBatchSize || last === undefined) return this.done(enqueued);
      cursor = last;
    }
    this.logger.warn({ event: 'org_purge_backlog', batches: this.cfg.purgeMaxBatches, enqueued }, 'organization purge hit TENANCY_ORG_PURGE_MAX_BATCHES with a full last batch');
    return enqueued;
  }

  private done(enqueued: number): number {
    this.logger.log({ event: 'org_purge_scan', enqueued }, 'organization purge scan finished');
    return enqueued;
  }
}

/**
 * MỘT transaction trong OrgScope của job: khoá org, kiểm lại `deleted_at` + `purge_after <= clock_timestamp()` SAU
 * khoá (T-13, X-11), participant theo `order`, bảng tenancy con trước cha, outbox `tenancy.org.purged`. Không còn dòng
 * → no-op (T-14, T-26). Lỗi → metric alert + ném (BullMQ retry). Scheduler Redis gỡ SAU commit.
 */
@Injectable()
@JobHandler(PurgeOrgJob)
export class PurgeOrgHandler {
  private readonly logger = new Logger(PurgeOrgHandler.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly participants: OrgPurgeParticipantRegistry,
    private readonly events: EventPublisher,
    private readonly schedules: ScheduledTaskService,
    private readonly metrics: TenancyMetrics,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<PurgeResult> {
    const orgId = ctx.meta.orgId;
    if (!orgId) throw new Error('tenancy.org.purge requires meta.orgId');
    let result: PurgeResult;
    try {
      result = await tenancySpan('tenancy.org.purge', () => this.purge(orgId), (r) => ({ 'tenancy.purge.result': r }));
    } catch (err) {
      this.metrics.orgPurgeFailed.add(1);
      this.logger.error({ event: 'org_purge_failed', errorClass: err instanceof Error ? err.constructor.name : typeof err }, 'organization purge failed');
      throw err;
    }
    this.metrics.orgPurge.add(1, { result });
    if (result === 'purged') await this.syncSchedules();
    return result;
  }

  private purge(orgId: string): Promise<PurgeResult> {
    return this.uow.run(async () => {
      const org = await this.orgs.lockCurrent();
      if (!org) return 'gone';
      const t = transitionOrg(orgStateOf(org), 'PURGE', { now: await this.orgs.clockNow(), purgeAfter: org.purgeAfter });
      if (!t.ok) return 'skipped';
      for (const p of this.participants.participants()) await p.participant.purge(orgId);
      await this.orgs.purgeCurrent();
      await this.events.publish(OrgPurgedEvent, {
        data: { orgId },
        aggregate: { type: 'organization', id: orgId, version: org.version + 1 },
        actor: PURGE_ACTOR,
      });
      return 'purged';
    });
  }

  private async syncSchedules(): Promise<void> {
    try {
      await this.schedules.syncCurrentOrg();
    } catch (err) {
      this.logger.warn({ event: 'org_schedule_sync_failed', after: 'purge', errorClass: err instanceof Error ? err.constructor.name : typeof err }, 'scheduler cleanup after purge failed; the reconciler removes orphan schedulers');
    }
  }
}
```
`src/modules/tenancy/application/scheduled-tasks.participant.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ScheduledTaskService } from '../../../core/scheduler/index.js';
import { OrgPurgeParticipant } from '../ports/org-purge-participant.js';
import { OrgPurgeParticipantContributor } from './org-purge-participant.registry.js';

/** `scheduled_tasks` (core) có FK RESTRICT tới org (Task 16): xoá dòng trong transaction purge; Redis gỡ sau commit. */
@Injectable()
@OrgPurgeParticipantContributor({ key: 'core.scheduled-tasks', order: 0 })
export class ScheduledTasksPurgeParticipant extends OrgPurgeParticipant {
  constructor(private readonly schedules: ScheduledTaskService) {
    super();
  }
  async purge(): Promise<void> {
    await this.schedules.removeAllForCurrentOrg();
  }
}
```
`src/modules/tenancy/tenancy.module.ts`:
1. Thêm `import './jobs.js';` cạnh `import './events.js';`.
2. `TenancyCoreModule.providers` thêm `ScheduledTasksPurgeParticipant`.
3. `forWorker()` trả `{ module: TenancyModule, imports: [TenancyCoreModule, TenancyQueuePortsModule], providers: [PurgeOrgsHandler, PurgeOrgHandler] }`.
`test/support/tenancy-seed.ts` thêm:
```ts
/** Mọi org đang tới hạn purge (hàm definer, không cần OrgScope): dọn sót của file trước để test đếm lô được. */
export async function dueOrgIds(database?: string): Promise<string[]> {
  return withAppClient(async (c) => {
    const { rows } = await c.query<{ org_id: string }>(`SELECT org_id::text AS org_id FROM tenancy_orgs_due_for_purge($1, 1000)`, [
      '00000000-0000-0000-0000-000000000000',
    ]);
    return rows.map((r) => r.org_id);
  }, database);
}
```

- [ ] **Step 3: Integration purge qua `JobQueue` thật (fail trước Step 2)**

`test/integration/tenancy/org-purge.spec.ts`:
```ts
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerModule } from '../../../src/app-worker.module.js';
import { OrgScope, pgFields } from '../../../src/core/database/index.js';
import { JobQueue, type JobContext } from '../../../src/core/queue/index.js';
import { bootstrapWorker } from '../../../src/main.worker.js';
import { OrgLifecycleService } from '../../../src/modules/tenancy/application/org-lifecycle.service.js';
import { PurgeOrgHandler, PurgeOrgsHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { PurgeOrgsJob } from '../../../src/modules/tenancy/jobs.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { dueOrgIds, inOrgTx, purgeOrgs, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const until = async (pred: () => Promise<boolean>, ms = 20_000): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const exists = (orgId: string) =>
  withAppClient((c) => inOrgTx(c, orgId, async () => ((await c.query('SELECT 1 FROM organizations WHERE id = $1', [orgId])).rowCount ?? 0) === 1));
const makeDue = (orgId: string) =>
  withAppClient((c) => inOrgTx(c, orgId, () => c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [orgId])));
const softDeleteUntil = (orgId: string, inMs: number) =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(`UPDATE organizations SET deleted_at = now() - interval '1 day', purge_after = clock_timestamp() + make_interval(secs => $2::float8 / 1000) WHERE id = $1`, [orgId, inMs]),
    ),
  );
const jobCtx = (orgId?: string): JobContext<unknown> => ({
  payload: {},
  meta: orgId ? { orgId } : {},
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
/**
 * Producer = `tenancyCoreImports()` (Task 19: core + `TenancyModule.forWorker()`, `runWorkers: false`): đủ cho
 * `PurgeOrgsHandler` enqueue qua `JobQueue`; không worker nào chạy nên `WorkerHost` không kiểm handler.
 *
 * Consumer = composition worker THẬT (review I8). Với `runWorkers: true`, `WorkerHost.assertHandlersFor` đòi handler cho
 * MỌI job đăng ký trên queue được consume; trên `maintenance` có `core.outbox.cleanup` (cần `OutboxModule` relay),
 * `core.scheduler.reconcile` (cần `SchedulerModule` worker), job maintenance của identity và notifications (kéo vào qua
 * `tenancy/index.ts` → identity). Chỉ `AppWorkerModule` (có `TenancyModule.forWorker()` từ `APP_MODULES`, Task 19) có đủ.
 * `bootstrapWorker` ghi thẳng `process.env.APP_ROLE = 'worker'`; caller đã `vi.stubEnv('APP_ROLE', 'worker')` nên
 * `vi.unstubAllEnvs()` trả lại giá trị cũ.
 */
const startConsumer = (): Promise<INestApplicationContext> => bootstrapWorker(AppWorkerModule);
/** Cron `tenancy.orgs.purge` của worker thật không được tự chạy giữa test (đếm lô, org "chưa tới lượt"): 00:00 ngày 1/1. */
const NEVER_DURING_TEST_CRON = '0 0 1 1 *';

describe('organization purge (spec SP3 §9.5)', () => {
  const orgs: SeededOrg[] = [];
  afterAll(async () => {
    for (const o of orgs) if (await exists(o.orgId)) await o.dispose();
    vi.unstubAllEnvs();
  });

  describe('through the real queue (worker consumes maintenance)', () => {
    let app: INestApplicationContext;
    beforeAll(async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'maintenance');
      vi.stubEnv('TENANCY_ORG_PURGE_CRON', NEVER_DURING_TEST_CRON);
      await purgeOrgs(await dueOrgIds());
      app = await startConsumer();
    });
    afterAll(async () => {
      await app?.close();
    });
    const scoped = <T>(orgId: string, fn: () => Promise<T>) => app.get(OrgScope).run(orgId, fn);

    it('purges a due org end to end (cron job → per-org job → handler), leaves others, emits org.purged, removes schedules', async () => {
      const due = await seedOrg();
      const active = await seedOrg();
      const notYet = await seedOrg();
      orgs.push(due, active, notYet);
      await withAppClient((c) =>
        inOrgTx(c, due.orgId, () => c.query(`INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'purge.probe', 'fixture.noop', '0 * * * *', 'UTC', '{}', true)`, [due.orgId])),
      );
      await makeDue(due.orgId);
      await softDeleteUntil(notYet.orgId, 3_600_000);
      await app.get(JobQueue).enqueue(PurgeOrgsJob, {});
      await until(async () => !(await exists(due.orgId)));
      expect([await exists(active.orgId), await exists(notYet.orgId)]).toEqual([true, true]);
      const events = await ownerQuery<{ type: string }>(`SELECT type FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`, [due.orgId]);
      expect(events).toHaveLength(1);
      // Chạy lại trên org đã mất: no-op, không ném (T-14, T-26).
      expect(await scoped(due.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(due.orgId)))).toBe('gone');
    });
    it('a forgotten participant (fixture table with RESTRICT FK) fails the job loud and keeps the org', async () => {
      const org = await seedOrg();
      orgs.push(org);
      await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('INSERT INTO fixture_org_items (org_id) VALUES ($1)', [org.orgId])));
      await makeDue(org.orgId);
      const err = await scoped(org.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(org.orgId))).catch((e: unknown) => e);
      expect(pgFields(err)?.sqlState).toBe('23001');
      expect(await exists(org.orgId)).toBe(true);
      await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [org.orgId])));
    });
    it('T-13: restore racing purge — a due org is purged and restore answers 404; a not-yet-due org is restored and purge is skipped', async () => {
      for (let i = 0; i < 10; i++) {
        const dueOrg = await seedOrg();
        const laterOrg = await seedOrg();
        orgs.push(dueOrg, laterOrg);
        await makeDue(dueOrg.orgId);
        await softDeleteUntil(laterOrg.orgId, 3_600_000);
        for (const [org, expected] of [[dueOrg, 'purged'], [laterOrg, 'skipped']] as const) {
          const [restore, purge] = await Promise.allSettled([
            scoped(org.orgId, () => app.get(OrgLifecycleService).restore({ kind: 'SYSTEM', id: 'test.t13' })),
            scoped(org.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(org.orgId))),
          ]);
          expect(purge).toEqual({ status: 'fulfilled', value: expected });
          expect(restore.status).toBe(expected === 'purged' ? 'rejected' : 'fulfilled');
        }
      }
    });
    it('X-11: waiting on the org lock across purge_after — restore then answers 404, purge then purges', async () => {
      for (const action of ['restore', 'purge'] as const) {
        const org = await seedOrg();
        orgs.push(org);
        await softDeleteUntil(org.orgId, 1_000);
        await withAppClient(async (holder) => {
          await holder.query('BEGIN');
          await holder.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
          await holder.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [org.orgId]);
          const pending =
            action === 'restore'
              ? scoped(org.orgId, () => app.get(OrgLifecycleService).restore({ kind: 'SYSTEM', id: 'test.x11' })).then(() => 'restored', (e: unknown) => e)
              : scoped(org.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(org.orgId)));
          await new Promise((r) => setTimeout(r, 1_500));
          await holder.query('COMMIT');
          const outcome = await pending;
          if (action === 'restore') expect(outcome).toMatchObject({ error: { code: 'not_found' } });
          else expect(outcome).toBe('purged');
        });
      }
    });
  });

  describe('many batches with the worker stopped, then consumed (T-14)', () => {
    const batchOrgs: SeededOrg[] = [];
    it('the cron walks batches by cursor, warns on backlog, and a second run adds no duplicate jobs', async () => {
      vi.stubEnv('APP_ROLE', 'worker');
      vi.stubEnv('WORKER_QUEUES', 'maintenance');
      vi.stubEnv('TENANCY_ORG_PURGE_BATCH_SIZE', '2');
      vi.stubEnv('TENANCY_ORG_PURGE_MAX_BATCHES', '2');
      vi.stubEnv('TENANCY_ORG_PURGE_CRON', NEVER_DURING_TEST_CRON);
      await purgeOrgs(await dueOrgIds());
      for (let i = 0; i < 5; i++) batchOrgs.push(await seedOrg());
      orgs.push(...batchOrgs);
      for (const o of batchOrgs) await makeDue(o.orgId);
      const producer = await createTestApp(tenancyCoreImports());
      const warn = vi.spyOn(Logger.prototype, 'warn');
      try {
        const waiting = async () => (await producer.get(JobQueue).stats()).find((s) => s.queue === 'maintenance')?.waiting ?? 0;
        const before = await waiting();
        expect(await producer.get(PurgeOrgsHandler).handle(jobCtx())).toBe(4);
        expect(warn.mock.calls.some(([o]) => typeof o === 'object' && o !== null && 'event' in o && o.event === 'org_purge_backlog')).toBe(true);
        expect(await producer.get(PurgeOrgsHandler).handle(jobCtx())).toBe(4);
        expect((await waiting()) - before).toBe(4);
      } finally {
        warn.mockRestore();
        await producer.close();
      }
      const consumer = await startConsumer();
      try {
        await until(async () => (await Promise.all(batchOrgs.slice(0, 4).map((o) => exists(o.orgId)))).every((e) => !e));
        expect(await exists(batchOrgs[4]!.orgId)).toBe(true);
        await consumer.get(JobQueue).enqueue(PurgeOrgsJob, {});
        await until(async () => !(await exists(batchOrgs[4]!.orgId)));
      } finally {
        await consumer.close();
      }
    });
  });
});
```

Run: `pnpm vitest run --project integration test/integration/tenancy/org-purge.spec.ts`
Expected: PASS.

- [ ] **Step 4: X-10 trên composition `AppWorkerModule` thật (T-34, R4A-N4)**

`test/integration/tenancy/org-lifecycle-jobs.spec.ts`:
```ts
import { Injectable, Logger, Module, type INestApplicationContext } from '@nestjs/common';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerModule } from '../../../src/app-worker.module.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { EventSubscriber, type EventEnvelope } from '../../../src/core/events/index.js';
import { SafeEnqueue } from '../../../src/core/outbox/index.js';
import { JobHandler, JobQueue, defineJob, defineQueue, type JobContext } from '../../../src/core/queue/index.js';
import { bootstrapWorker } from '../../../src/main.worker.js';
import { OrgLifecycleService } from '../../../src/modules/tenancy/application/org-lifecycle.service.js';
import { OrgDeletedEvent, OrgPurgedEvent } from '../../../src/modules/tenancy/index.js';
import { PurgeOrgJob, purgeJobId } from '../../../src/modules/tenancy/jobs.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const seen = { ran: [] as string[], deleted: [] as string[], purged: [] as string[] };
/**
 * Queue riêng của file (review I9): `FixtureQueue` của `test/fixtures/fixture.jobs.ts` kéo theo 7 job fixture khác mà
 * `X10WorkerModule` không có handler, và `WorkerHost.assertHandlersFor` từ chối boot khi queue được consume thiếu handler.
 */
const X10Queue = defineQueue('x10-fixture', { kind: 'io' });
const SkipJob = defineJob({ name: 'fixture.tenant-skip', queue: X10Queue, version: 1, schema: z.object({ key: z.string() }) });
const RunJob = defineJob({ name: 'fixture.tenant-run', queue: X10Queue, version: 1, schema: z.object({ key: z.string() }), onInactiveOrg: 'run' });

@Injectable() @JobHandler(SkipJob) class SkipHandler {
  async handle(ctx: JobContext<{ key: string }>) { seen.ran.push(`skip:${ctx.payload.key}`); }
}
@Injectable() @JobHandler(RunJob) class RunHandler {
  async handle(ctx: JobContext<{ key: string }>) { seen.ran.push(`run:${ctx.payload.key}`); }
}
@Injectable() @EventSubscriber({ consumer: 'fixture.x10-deleted', event: OrgDeletedEvent }) class OnDeleted {
  async handle(e: EventEnvelope<{ orgId: string }>) { seen.deleted.push(e.data.orgId); }
}
/** Subscriber của `purged` enqueue hai job trong OrgScope của event: org đã mất dòng (R4A-N4). */
@Injectable() @EventSubscriber({ consumer: 'fixture.x10-purged', event: OrgPurgedEvent }) class OnPurged {
  constructor(private readonly jobs: SafeEnqueue) {}
  async handle(e: EventEnvelope<{ orgId: string }>) {
    seen.purged.push(e.data.orgId);
    await this.jobs.enqueue(RunJob, { key: 'after-purge' });
    await this.jobs.enqueue(SkipJob, { key: 'after-purge' });
  }
}
@Module({ providers: [SkipHandler, RunHandler, OnDeleted, OnPurged] }) class X10Fixtures {}
@Module({ imports: [AppWorkerModule, X10Fixtures] }) class X10WorkerModule {}

const until = async (pred: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const loggedEvents = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.flatMap(([o]) => (typeof o === 'object' && o !== null && 'event' in o && typeof o.event === 'string' ? [o.event] : []));

describe('X-10: tenant jobs of a soft-deleted org on the real worker composition (spec SP3 §9.4, T-34)', () => {
  let org: SeededOrg;
  let worker: INestApplicationContext | undefined;
  // `bootstrapWorker` ghi thẳng `process.env.APP_ROLE`; trả lại sau file để không rò sang file khác cùng process.
  const previousRole = process.env.APP_ROLE;
  beforeAll(async () => {
    vi.stubEnv('WORKER_QUEUES', 'events,maintenance,x10-fixture');
    org = await seedOrg();
    // Pha 1 — không worker nào chạy: một job 'skip' nằm sẵn trong queue, một job 'skip' hoãn qua outbox, rồi xoá mềm.
    const producer = await createTestApp(tenancyCoreImports());
    try {
      await producer.get(OrgScope).run(org.orgId, async () => {
        await producer.get(JobQueue).enqueue(SkipJob, { key: 'queued-before-delete' });
        await producer.get(UnitOfWork).run(() => producer.get(SafeEnqueue).enqueue(SkipJob, { key: 'deferred-before-delete' }));
        await producer.get(OrgLifecycleService).softDelete({ kind: 'SYSTEM', id: 'test.x10' });
      });
    } finally {
      await producer.close();
    }
  });
  afterAll(async () => {
    await worker?.close();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (await withAppClient((c) => inOrgTx(c, org.orgId, async () => ((await c.query('SELECT 1 FROM organizations WHERE id = $1', [org.orgId])).rowCount ?? 0) === 1)))
      await org.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips queued and deferred tenant jobs, delivers org.deleted, then purge → org.purged → run job runs, skip job is skipped with a WARN', async () => {
    const info = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    // Pha 2 — worker thật (bootstrapWorker + AppWorkerModule): relay → dispatch → deliver chạy thật.
    worker = await bootstrapWorker(X10WorkerModule);
    await until(() => seen.deleted.includes(org.orgId));
    await until(() => loggedEvents(info).filter((e) => e === 'job_skipped_org_inactive').length + loggedEvents(warn).filter((e) => e === 'job_skipped_org_inactive_after_delete').length >= 2);
    expect(seen.ran.filter((r) => r.startsWith('skip:'))).toEqual([]);
    expect(loggedEvents(info)).toContain('job_skipped_org_inactive');
    // Purge: đưa org tới hạn rồi enqueue đúng job của cron.
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`UPDATE organizations SET purge_after = deleted_at + interval '1 millisecond' WHERE id = $1`, [org.orgId])));
    await worker.get(JobQueue).enqueue(PurgeOrgJob, {}, { jobId: purgeJobId(org.orgId), meta: { orgId: org.orgId } });
    await until(() => seen.purged.includes(org.orgId));
    await until(() => seen.ran.includes('run:after-purge'));
    await until(() => loggedEvents(warn).includes('job_skipped_org_inactive_after_delete'));
    expect(seen.ran).not.toContain('skip:after-purge');
  });
});
```
Run: `pnpm vitest run --project integration test/integration/tenancy/org-lifecycle-jobs.spec.ts`
Expected: PASS (`baseTestEnv` đã có `SMTP_HOST`/`MAIL_FROM` của Mailpit cho worker).

- [ ] **Step 5: Kiểm toàn cục, commit**

Run: `pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run --project unit`
Expected: xanh.
```bash
git add src/modules/tenancy test/support/tenancy-seed.ts test/unit/modules/tenancy/jobs.spec.ts test/integration/tenancy/org-purge.spec.ts test/integration/tenancy/org-lifecycle-jobs.spec.ts
git commit -m "feat(tenancy): cursor-based organization purge with participants, per-org purge job and inactive-org job skipping"
```

---

### Task 26: Tenancy cài `UserDeletionGuard` — bất biến owner khi xoá tài khoản (O-2, O-2b, O-11, O-17, O-18, O-19, O-20, X-7, T-24)

**Files:**
- Create: `src/modules/tenancy/application/user-deletion.service.ts`, `src/modules/tenancy/infra/identity/tenancy-identity-ports.module.ts`
- Create (test): `test/e2e/tenancy/account-deletion.e2e.spec.ts`, `test/e2e/tenancy/account-deletion-races.e2e.spec.ts`, `test/e2e/identity/user-deletion-without-tenancy.e2e.spec.ts`
- Modify: `src/modules/tenancy/tenancy.module.ts`, `test/smoke/tenancy.smoke.spec.ts`

**Interfaces:**
- Consumes: `UserDeletionGuard`, `type UserDeletionCheck`, `type UserDeletionRelease` (identity `index.ts`, Task 11), hook `hooks.before`/`databaseHooks.user.delete.before`/`onError` 23001 (Task 11–12), `TenancyUserRepository.find/deleteById`, `OrgRepository.soleOwnerOrgs/relatedOrgIds/lockCurrent/detachCreator`, `MemberRepository.findByUserId/deleteById` (Task 20), `MemberRemovedEvent` (Task 19), `TenancyTestHooks.beforeRelease` (Task 19), `pgFields` (Task 23), `startTenancyApp({ configure })` (Task 22), `AuthClient`, `mailpitFromInfra` (SP2), `Device`, `verifiedDevice`, `psql`, `mail` (smoke, Task 8 và 12).
- Produces:
  - `UserDeletionService extends UserDeletionGuard`: `check(authUserId)` → `ALLOWED | BLOCKED_LAST_OWNER { orgCount }`; `release(authUserId)` → `RELEASED | BLOCKED_RACE { reason: 'LAST_OWNER' | 'MEMBERSHIP_CREATED' }`; chỉ ném với lỗi hạ tầng pool `app_user` hoặc lỗi lập trình (spec §15 "Lỗi trong hook Better Auth").
  - `@Global() TenancyIdentityPortsModule` (nạp ở `forApi()`): cung cấp token `UserDeletionGuard` cho `BetterAuthCoreModule` (`optional: true`).
  - Event `tenancy.member.removed { reason: 'ACCOUNT_DELETED' }`, actor `{ type: 'system', id: 'identity.user-deletion' }`; span `tenancy.user_deletion.check`, `tenancy.user_deletion.release`; metric `tenancy_last_owner_blocked_total{path="account_delete"}`.

- [ ] **Step 1: Cài port**

`src/modules/tenancy/application/user-deletion.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { OrgScope, UnitOfWork, pgFields } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { UserDeletionGuard, type UserDeletionCheck, type UserDeletionRelease } from '../../identity/index.js';
import { MemberRemovedEvent } from '../events.js';
import { MemberRepository } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { TenancyMetrics } from './tenancy-metrics.js';

const DELETION_ACTOR = { type: 'system', id: 'identity.user-deletion' } as const;
const LAST_OWNER_CONSTRAINT = 'org_members_last_owner_ck';
const MEMBERSHIP_FK = 'org_members_user_fk';
const RESTRICT_VIOLATION = '23001';

/**
 * Spec SP3 §9.6 (chỉ `local`/`hybrid`; `external` không có hook). `check` chạy ở `hooks.before` (chưa xoá gì); `release`
 * ở `databaseHooks.user.delete.before` (session/account đã bị Better Auth xoá). Cả hai trả kết quả có tên, không ném
 * `AppError` (hook đổi lỗi lạ thành 500). Mỗi org một transaction (OrgScope không đổi org giữa transaction), theo
 * `org_id` tăng dần; dừng ở kết quả khác `RELEASED` đầu tiên (runbook §9.6).
 */
@Injectable()
export class UserDeletionService extends UserDeletionGuard {
  private readonly logger = new Logger(UserDeletionService.name);

  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    private readonly metrics: TenancyMetrics,
  ) {
    super();
  }

  check(authUserId: string): Promise<UserDeletionCheck> {
    return tenancySpan(
      'tenancy.user_deletion.check',
      async (): Promise<UserDeletionCheck> => {
        const user = await this.users.find({ kind: 'AUTH_USER', authUserId });
        if (!user) return { kind: 'ALLOWED' };
        const sole = await this.orgs.soleOwnerOrgs(user.id);
        if (sole.length === 0) return { kind: 'ALLOWED' };
        this.metrics.lastOwnerBlocked.add(1, { path: 'account_delete' });
        return { kind: 'BLOCKED_LAST_OWNER', orgCount: sole.length };
      },
      (r) => ({ 'tenancy.user_deletion.result': r.kind }),
    );
  }

  release(authUserId: string): Promise<UserDeletionRelease> {
    return tenancySpan('tenancy.user_deletion.release', () => this.releaseAll(authUserId), (r) => ({ 'tenancy.user_deletion.result': r.kind }));
  }

  private async releaseAll(authUserId: string): Promise<UserDeletionRelease> {
    const user = await this.users.find({ kind: 'AUTH_USER', authUserId });
    if (!user) return { kind: 'RELEASED' };
    for (const orgId of await this.orgs.relatedOrgIds(user.id)) {
      await this.hooks.beforeRelease(authUserId, orgId);
      const blocked = await this.releaseOrg(orgId, user.id);
      if (blocked) return blocked;
    }
    try {
      // Bảng global, không OrgScope. `created_by_user_id` đã NULL ở từng org nên SET NULL của FK không khoá org nào (T-24).
      await this.uow.run(() => this.users.deleteById(user.id));
    } catch (err) {
      const pg = pgFields(err);
      if (pg?.sqlState === RESTRICT_VIOLATION && pg.constraint === MEMBERSHIP_FK) {
        this.logger.warn({ event: 'user_deletion_blocked_race', reason: 'MEMBERSHIP_CREATED' }, 'a membership was created while the account was being deleted');
        return { kind: 'BLOCKED_RACE', reason: 'MEMBERSHIP_CREATED' };
      }
      throw err;
    }
    return { kind: 'RELEASED' };
  }

  /** Một org: khoá org → gỡ tham chiếu người tạo DƯỚI khoá → xoá membership + event. Org đã mất (purge, T-26) → bỏ qua. */
  private async releaseOrg(orgId: string, userId: string): Promise<UserDeletionRelease | undefined> {
    try {
      await this.scope.run(orgId, () =>
        this.uow.run(async () => {
          if (!(await this.orgs.lockCurrent())) return;
          await this.orgs.detachCreator(userId);
          const member = await this.members.findByUserId(userId);
          if (!member) return;
          // 3C: huỷ chuyển quyền PENDING của member; 3D: đọc key của member để phát `api_key.revoked` (spec Bảng 5).
          await this.members.deleteById(member.id);
          await this.events.publish(MemberRemovedEvent, {
            data: { memberId: member.publicId, userId: member.userPublicId, roleId: member.rolePublicId, reason: 'ACCOUNT_DELETED' },
            aggregate: { type: 'member', id: member.publicId, version: member.version + 1 },
            actor: DELETION_ACTOR,
          });
        }),
      );
      return undefined;
    } catch (err) {
      if (pgFields(err)?.constraint !== LAST_OWNER_CONSTRAINT) throw err;
      this.metrics.lastOwnerBlocked.add(1, { path: 'account_delete' });
      this.logger.warn({ event: 'user_deletion_blocked_race', reason: 'LAST_OWNER' }, 'the account became the last owner of an organization during deletion');
      return { kind: 'BLOCKED_RACE', reason: 'LAST_OWNER' };
    }
  }
}
```
`src/modules/tenancy/infra/identity/tenancy-identity-ports.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { UserDeletionGuard } from '../../../identity/index.js';
import { UserDeletionService } from '../../application/user-deletion.service.js';

/**
 * `@Global`: `BetterAuthCoreModule` (identity) inject `{ token: UserDeletionGuard, optional: true }` (spec SP3 §5.2);
 * identity không import tenancy (luật 18). Vắng module này (app không bật tenancy) → hook dựa vào FK `RESTRICT` + `onError`.
 */
@Global()
@Module({ providers: [UserDeletionService, { provide: UserDeletionGuard, useExisting: UserDeletionService }], exports: [UserDeletionGuard] })
export class TenancyIdentityPortsModule {}
```
`src/modules/tenancy/tenancy.module.ts`: `forApi()` → `imports: [TenancyCoreModule, TenancyHttpModule, TenancyIdentityPortsModule]`.

Run: `pnpm typecheck && pnpm arch`
Expected: xanh; luật 18 không bị vi phạm (hướng phụ thuộc tenancy → identity qua `index.ts`).

- [ ] **Step 2: E2E xoá tài khoản (fail trước Step 1 ở các ca cần guard)**

`test/e2e/tenancy/account-deletion.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenancyTestHooks } from '../../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, inOrgTx, seedMember, seedOrg, withAppClient, type SeededOrg } from '../../support/tenancy-seed.js';

const PASSWORD = 'correct horse battery staple';

/** Seam O-18/O-20/X-7: một hành động của test chạy trước khi `release` xử lý org kế tiếp. */
class ScriptedHooks extends TenancyTestHooks {
  onRelease: ((authUserId: string, orgId: string) => Promise<void>) | undefined;
  afterGuard(): Promise<void> {
    return Promise.resolve();
  }
  async beforeRelease(authUserId: string, orgId: string): Promise<void> {
    const fn = this.onRelease;
    this.onRelease = undefined;
    await fn?.(authUserId, orgId);
  }
}

describe('account deletion keeps every active organization owned (spec SP3 §9.6)', () => {
  const hooks = new ScriptedHooks();
  const mail = mailpitFromInfra();
  let app: INestApplication;
  let admin: SeededPrincipal;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const registeredIds: string[] = [];
  const client = () => new AuthClient(app.getHttpServer());
  const removeUser = (userId: unknown, as: SeededPrincipal = admin) =>
    authed(app, as).post('/api/auth/admin/remove-user').set('origin', 'http://localhost:3000').send({ userId });
  const authRows = async (id: string) => ({
    user: (await ownerQuery('SELECT 1 FROM auth."user" WHERE id = $1', [id])).length,
    accounts: (await ownerQuery('SELECT 1 FROM auth.account WHERE user_id = $1', [id])).length,
    sessions: (await ownerQuery('SELECT 1 FROM auth.session WHERE user_id = $1', [id])).length,
  });
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** User thật có mật khẩu (O-18 cần đăng nhập/đặt lại mật khẩu). */
  const registered = async () => {
    const email = `del-${randomUUID()}@example.test`;
    const c = client();
    const after = await mail.now();
    expect((await c.signUp(email, PASSWORD)).status).toBeLessThan(300);
    await c.verifyEmailFromMailpit(mail, email, after);
    const [row] = await ownerQuery<{ id: string }>('SELECT id FROM auth."user" WHERE email = $1', [email]);
    if (!row) throw new Error('registered user not found');
    registeredIds.push(row.id);
    return { email, id: row.id };
  };
  beforeAll(async () => {
    app = await startTenancyApp({ configure: (b) => b.overrideProvider(TenancyTestHooks).useValue(hooks) });
    admin = await seedP({ role: 'admin' });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await deleteTenancyUsersOf([...principals.map((p) => p.authUserId), ...registeredIds]);
    await app?.close();
    await deleteSeededPrincipals(principals);
    await ownerQuery('DELETE FROM auth."user" WHERE id = ANY($1::uuid[])', [registeredIds]);
    vi.unstubAllEnvs();
  });

  it('O-2: deleting the sole owner of an active org → 409 user_deletion_blocked; user, account and session intact', async () => {
    const u = await seedP();
    orgs.push(await seedOrg({ owner: { authUserId: u.authUserId } }));
    const before = await authRows(u.authUserId);
    const r = await removeUser(u.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/only owner of 1 active organization/);
    expect(await authRows(u.authUserId)).toEqual(before);
  });
  it.each([
    ['as an array', (id: string) => [id], 409, 'user_deletion_blocked'],
    ['upper-case', (id: string) => id.toUpperCase(), 422, 'validation_failed'],
    ['braced', (id: string) => `{${id}}`, 422, 'validation_failed'],
    ['without hyphens', (id: string) => id.replaceAll('-', ''), 422, 'validation_failed'],
  ])('O-2b: the target id %s → %i %s, credentials intact', async (_n, shape, status, code) => {
    const u = await seedP();
    orgs.push(await seedOrg({ owner: { authUserId: u.authUserId } }));
    const before = await authRows(u.authUserId);
    const r = await removeUser(shape(u.authUserId));
    expect([r.status, r.body.code]).toEqual([status, code]);
    expect(await authRows(u.authUserId)).toEqual(before);
  });
  it("O-2b: the admin's own id in upper case → 422; the admin keeps its session and account", async () => {
    const a = await seedP({ role: 'admin' });
    const before = await authRows(a.authUserId);
    const r = await removeUser(a.authUserId.toUpperCase(), a);
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
    expect(await authRows(a.authUserId)).toEqual(before);
  });
  it('O-17: a non-admin calling /admin/remove-user for a last owner gets the Better Auth permission error, not 409', async () => {
    const u = await seedP();
    const outsider = await seedP();
    orgs.push(await seedOrg({ owner: { authUserId: u.authUserId } }));
    const r = await removeUser(u.authUserId, outsider);
    expect(r.status).toBe(403);
    expect(r.body.code).not.toBe('user_deletion_blocked');
  });
  it('O-11: the sole owner of a soft-deleted org may be deleted; the membership is removed with an ACCOUNT_DELETED event', async () => {
    const u = await seedP();
    const org = await seedOrg({ owner: { authUserId: u.authUserId } });
    orgs.push(org);
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`, [org.orgId])));
    expect((await removeUser(u.authUserId)).status).toBe(200);
    expect(await ownerQuery('SELECT 1 FROM auth."user" WHERE id = $1', [u.authUserId])).toEqual([]);
    expect(await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [u.authUserId])).toEqual([]);
    const [evt] = await ownerQuery<{ payload: { reason: string }; headers: { actorType: string; actorId: string } }>(
      `SELECT payload, headers FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.member.removed'`, [org.orgId]);
    expect([evt?.payload.reason, evt?.headers.actorType, evt?.headers.actorId]).toEqual(['ACCOUNT_DELETED', 'system', 'identity.user-deletion']);
  });
  it('a member (not an owner) is deleted cleanly; organizations it created lose created_by_user_id', async () => {
    const owner = await seedP();
    const creator = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const m = await seedMember(org, 'MEMBER', { authUserId: creator.authUserId });
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query('UPDATE organizations SET created_by_user_id = $1 WHERE id = $2', [m.userId, org.orgId])));
    expect((await removeUser(creator.authUserId)).status).toBe(200);
    const row = await withAppClient((c) => inOrgTx(c, org.orgId, async () => (await c.query<{ created_by_user_id: string | null }>('SELECT created_by_user_id FROM organizations WHERE id = $1', [org.orgId])).rows[0]));
    expect(row?.created_by_user_id).toBeNull();
  });
  it('O-20: a membership created during release (23001 org_members_user_fk) → 409, not 500', async () => {
    const u = await seedP();
    const owner = await seedP();
    const a = await seedOrg({ owner: { authUserId: owner.authUserId } });
    const b = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(a, b);
    await seedMember(a, 'MEMBER', { authUserId: u.authUserId });
    hooks.onRelease = async () => {
      await seedMember(b, 'MEMBER', { authUserId: u.authUserId });
    };
    const r = await removeUser(u.authUserId);
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    expect(r.body.detail).toMatch(/runbook/i);
  });
  it('O-18: owners A, B; A passes the preflight; B leaves before release → 409; A cannot sign in; reset-password restores A; A promotes M; deleting A then succeeds', async () => {
    const a = await registered();
    const b = await seedP();
    const m = await seedP();
    const org = await seedOrg({ owner: { authUserId: a.id } });
    orgs.push(org);
    const bm = await seedMember(org, 'OWNER', { authUserId: b.authUserId });
    const mm = await seedMember(org, 'MEMBER', { authUserId: m.authUserId });
    hooks.onRelease = () => withAppClient((c) => inOrgTx(c, org.orgId, async () => void (await c.query('DELETE FROM org_members WHERE id = $1', [bm.memberId]))));
    const first = await removeUser(a.id);
    expect([first.status, first.body.code]).toEqual([409, 'user_deletion_blocked']);
    const owners = await withAppClient((c) => inOrgTx(c, org.orgId, async () => (await c.query<{ id: string }>(`SELECT m.id::text AS id FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`)).rows));
    expect(owners.map((o) => o.id)).toEqual([org.owner.memberId]);
    expect((await client().signIn(a.email, PASSWORD)).status).toBe(401);
    // Runbook: quên mật khẩu tạo lại account credential (Better Auth 1.7.6).
    const started = await mail.now();
    await client().request('post', '/api/auth/request-password-reset', { body: { email: a.email }, cookie: false });
    const msg = await mail.waitFor(a.email, { subject: /Reset your password/, after: started });
    const token = /\/reset-password\/([^?\s"<>]+)/.exec(msg.Text)?.[1];
    expect((await client().request('post', '/api/auth/reset-password', { body: { token, newPassword: 'a brand new passphrase' }, cookie: false })).status).toBe(200);
    const aClient = client();
    expect((await aClient.signIn(a.email, 'a brand new passphrase')).status).toBe(200);
    const promote = await aClient.request('patch', `/v1/orgs/${org.orgId}/members/${mm.memberPublicId}`, {
      body: { roleId: org.roles.OWNER.publicId },
      headers: { 'if-match': '*' },
    });
    expect(promote.status).toBe(200);
    expect((await removeUser(a.id)).status).toBe(200);
  });
  it('X-7 / T-26: the org is purged while release walks it → the walk skips it and the deletion completes', async () => {
    const u = await seedP();
    const org = await seedOrg({ owner: { authUserId: (await seedP()).authUserId } });
    await seedMember(org, 'MEMBER', { authUserId: u.authUserId });
    hooks.onRelease = async (_id, orgId) => {
      if (orgId === org.orgId) await org.dispose();
    };
    expect((await removeUser(u.authUserId)).status).toBe(200);
    expect(await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [u.authUserId])).toEqual([]);
  });
});
```
Ghi chú: `seedOrg().dispose()` trong X-7 xoá luôn dòng `tenancy_users` mà helper tạo cho owner seed; user `u` không do `seedOrg` tạo nên còn lại cho `release`. Org trong X-7 không nằm trong mảng `orgs` (đã dispose trong seam).

`test/e2e/tenancy/account-deletion-races.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const ROUNDS = 10;

describe('T-24 / T-18 (creation path): account deletion racing organization creation by the same user', () => {
  let app: INestApplication;
  let admin: SeededPrincipal;
  const principals: SeededPrincipal[] = [];
  const created: string[] = [];
  beforeAll(async () => {
    app = await startTenancyApp();
    admin = await seedUserPrincipal({ role: 'admin' });
    principals.push(admin);
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`${ROUNDS} rounds: never a 5xx, never a deleted account that still owns an active organization`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const u = await seedUserPrincipal();
      principals.push(u);
      const [create, del] = await Promise.all([
        authed(app, u).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name: `Race ${i}` }),
        authed(app, admin).post('/api/auth/admin/remove-user').set('origin', 'http://localhost:3000').send({ userId: u.authUserId }),
      ]);
      if (create.status === 201) created.push(create.body.id);
      expect(create.status).toBeLessThan(500);
      expect(del.status).toBeLessThan(500);
      expect(create.status === 201 && del.status === 200).toBe(false);
      if (del.status === 200) expect(await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [u.authUserId])).toEqual([]);
    }
  });
});
```
`test/e2e/identity/user-deletion-without-tenancy.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { withAppClient } from '../../support/tenancy-seed.js';

describe('O-19 / T8: identity without tenancy — the RESTRICT FK is the last line (spec SP3 §9.6 bước 4)', () => {
  const otel = installOtelCapture();
  let app: INestApplication;
  let admin: SeededPrincipal;
  let u: SeededPrincipal;
  beforeAll(async () => {
    app = await startIdentityApp();
    admin = await seedUserPrincipal({ role: 'admin' });
    u = await seedUserPrincipal();
    await withAppClient((c) => c.query('INSERT INTO tenancy_users (auth_user_id) VALUES ($1)', [u.authUserId]));
  });
  afterAll(async () => {
    await withAppClient((c) => c.query('DELETE FROM tenancy_users WHERE auth_user_id = $1', [u.authUserId]));
    await app?.close();
    await deleteSeededPrincipals([admin, u]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('/admin/remove-user → 409 user_deletion_blocked, no ERROR better_auth_unhandled_error, no 5xx counted', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const r = await request(app.getHttpServer())
      .post('/api/auth/admin/remove-user')
      .set('authorization', `Bearer ${admin.bearer}`)
      .set('origin', 'http://localhost:3000')
      .send({ userId: u.authUserId });
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    const events = error.mock.calls.flatMap(([o]) => (typeof o === 'object' && o !== null && 'event' in o ? [o.event] : []));
    expect(events).not.toContain('better_auth_unhandled_error');
    expect((await otel.metric('identity_auth_endpoint_error_total')) ?? 0).toBe(0);
    expect(await ownerQuery('SELECT 1 FROM auth."user" WHERE id = $1', [u.authUserId])).toHaveLength(1);
  });
});
```
Ghi chú: nhánh âm của O-19 (`23001` trên path Better Auth khác vẫn là 500 có log) đã có ở integration test của Task 12 (bảng fixture `fixture_user_refs`), vì trên app thật không có path nào khác của Better Auth gây `23001`.

Run:
```bash
pnpm vitest run --project integration test/e2e/tenancy/account-deletion.e2e.spec.ts test/e2e/tenancy/account-deletion-races.e2e.spec.ts test/e2e/identity/user-deletion-without-tenancy.e2e.spec.ts
```
Expected: PASS.

- [ ] **Step 3: Kiểm toàn cục**

Run: `pnpm typecheck && pnpm lint && pnpm arch && pnpm vitest run --project unit && pnpm vitest run --project integration test/e2e/identity`
Expected: xanh; e2e identity SP2 (xoá user không liên quan tenancy) giữ hành vi.

- [ ] **Step 4: Smoke prod-like của xoá tài khoản có guard (review I10)**

`UserDeletionGuard` lần đầu được nối vào instance Better Auth của image production ở task này. `test/smoke/tenancy.smoke.spec.ts`: import thêm `z` từ `zod`; trong `describe`, sau ca identity của Task 12 và trước ca log sạch:
```ts
  it('account deletion on the production image: the sole owner of an active org is 409, an uppercase id is 422, after a soft delete the account is deleted', async () => {
    const { device: owner, email: ownerEmail } = await verifiedDevice(apiUrl, mail);
    const { device: admin, email: adminEmail } = await verifiedDevice(apiUrl, mail);
    psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${adminEmail}'`);
    const ownerId = psql(`SELECT id FROM auth."user" WHERE email = '${ownerEmail}'`);
    const created = await owner.call('POST', '/v1/orgs', { body: { name: 'Smoke Deletion Org' }, headers: { 'idempotency-key': `smoke-${randomUUID()}` } });
    expect(created.status).toBe(201);
    const { id: orgId } = z.object({ id: z.uuid() }).parse(await created.json());
    const Problem = z.object({ code: z.string() });

    const blocked = await admin.call('POST', '/api/auth/admin/remove-user', { body: { userId: ownerId } });
    expect(blocked.status).toBe(409);
    expect(Problem.parse(await blocked.json()).code).toBe('user_deletion_blocked');
    expect(psql(`SELECT count(*) FROM auth.session WHERE user_id = '${ownerId}'`)).not.toBe('0');
    expect(psql(`SELECT count(*) FROM auth.account WHERE user_id = '${ownerId}'`)).toBe('1');

    const upper = await admin.call('POST', '/api/auth/admin/remove-user', { body: { userId: ownerId.toUpperCase() } });
    expect(upper.status).toBe(422);
    expect(Problem.parse(await upper.json()).code).toBe('validation_failed');

    expect((await owner.call('DELETE', `/v1/orgs/${orgId}`)).status).toBe(204);
    expect((await admin.call('POST', '/api/auth/admin/remove-user', { body: { userId: ownerId } })).status).toBe(200);
    expect(psql(`SELECT count(*) FROM auth."user" WHERE id = '${ownerId}'`)).toBe('0');
    expect(psql(`SELECT count(*) FROM tenancy_users WHERE auth_user_id = '${ownerId}'`)).toBe('0');
    expect(psql(`SELECT count(*) FROM outbox_events WHERE org_id = '${orgId}' AND type = 'tenancy.member.removed'`)).toBe('1');
  });
```
(`ownerId` do Postgres sinh, `orgId` đã qua `z.uuid()`, email do smoke sinh bằng `randomUUID`: nối vào SQL của superuser smoke là an toàn. Ca log sạch ở cuối file kiểm luôn rằng nhánh `409` chỉ ghi WARN `user_deletion_blocked`, không `error`.)

- [ ] **Step 5: Kiểm chứng prod-like — identity ↔ tenancy khi xoá tài khoản**

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, rate limit bật), mọi file smoke PASS gồm ca xoá tài khoản mới (`409 user_deletion_blocked` cho owner duy nhất, `422` cho id viết hoa, `200` sau khi xoá mềm org); log api/worker là JSON, không `error`, không chứa mật khẩu smoke; `/health/ready` 200; teardown `down -v` sạch.

- [ ] **Step 6: Commit**

```bash
git add src/modules/tenancy test/e2e/tenancy/account-deletion.e2e.spec.ts test/e2e/tenancy/account-deletion-races.e2e.spec.ts test/e2e/identity/user-deletion-without-tenancy.e2e.spec.ts test/smoke/tenancy.smoke.spec.ts
git commit -m "feat(tenancy): implement the identity user-deletion guard so no active organization loses its last owner; prod-like smoke of account deletion"
```

---

### Task 27: Ma trận role × route sinh từ metadata (G-6), bảng route nhạy cảm/thu hẹp (tiêu chí 18), ba `AUTH_MODE` (tiêu chí 13)

**Files:**
- Modify: `src/modules/tenancy/application/org-route-inventory.ts` (thêm `tenantRoutes()` công khai)
- Create (test): `test/e2e/tenancy/role-route-matrix.e2e.spec.ts`, `test/e2e/tenancy/auth-modes.e2e.spec.ts`

**Interfaces:**
- Consumes: `OrgRouteInventory` (Task 21), `systemRolePermissions` (Task 17), `PermissionCatalogueRegistry` (Task 19), `startTenancyApp`, `authed` (Task 22), `seedOrg`/`seedMember` (Task 14), `seedUserPrincipal` (Task 10), `startFakeJwks`, `startFakeIdp` (SP2), `ResilienceModule` (SP1).
- Produces: `OrgRouteInventory.tenantRoutes(): TenantRoute[]` với `type TenantRoute = { id: string; method: string; template: string; policy: TenancyPolicy; sensitive: boolean; narrowing: boolean }` (route `TENANT` có metadata; test ma trận và 3B/3C/3D dùng để mở rộng G-6).

- [ ] **Step 1: Mở danh sách route tenant cho test (fail → pass)**

`src/modules/tenancy/application/org-route-inventory.ts` — thêm type và phương thức (dùng lại `routes()` riêng tư):
```ts
export type TenantRoute = { id: string; method: string; template: string; policy: TenancyPolicy; sensitive: boolean; narrowing: boolean };

  /** Route `TENANT` có metadata phân quyền, theo thứ tự khai báo: nguồn của ma trận G-6 (không viết tay từng ô). */
  tenantRoutes(): TenantRoute[] {
    return this.routes().flatMap((r) => {
      const policy = this.reflector.getAllAndOverride<TenancyPolicy | undefined>(TENANCY_POLICY, [r.handler, r.controller]);
      if (classifyOrgRoute(r.template) !== 'TENANT' || !policy) return [];
      return [{ id: r.id, method: r.method, template: r.template, policy, sensitive: this.flag(TENANCY_SENSITIVE, r), narrowing: this.flag(TENANCY_NARROWING, r) }];
    });
  }
```

- [ ] **Step 2: Ma trận G-6 + bảng nhạy cảm/thu hẹp**

`test/e2e/tenancy/role-route-matrix.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgRouteInventory, type TenantRoute } from '../../../src/modules/tenancy/application/org-route-inventory.js';
import { PermissionCatalogueRegistry } from '../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { systemRolePermissions } from '../../../src/modules/tenancy/domain/system-roles.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { seedMember, seedOrg, type SeededOrg, type SystemRoleKey } from '../../support/tenancy-seed.js';

/** Bảng route tenant của 3A (spec §12); 3B/3C/3D thêm dòng khi thêm route. */
const ROUTES_3A = [
  'DELETE v1/orgs/:orgId',
  'DELETE v1/orgs/:orgId/members/:memberId',
  'DELETE v1/orgs/:orgId/members/me',
  'GET v1/orgs/:orgId',
  'GET v1/orgs/:orgId/members',
  'GET v1/orgs/:orgId/members/:memberId',
  'GET v1/orgs/:orgId/members/me',
  'GET v1/orgs/:orgId/roles',
  'GET v1/orgs/:orgId/roles/:roleId',
  'PATCH v1/orgs/:orgId',
  'PATCH v1/orgs/:orgId/members/:memberId',
  'POST v1/orgs/:orgId/restore',
];
const ROLES: readonly SystemRoleKey[] = ['OWNER', 'ADMIN', 'MEMBER'];
const STALE_SEC = 3600;

type Cast = { org: SeededOrg; as: Record<SystemRoleKey, SeededPrincipal>; target: string };

describe('role × route matrix and fresh-session table, generated from route metadata (spec SP3 §18.2, §18.3 G-6)', () => {
  let app: INestApplication;
  let routes: TenantRoute[];
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  /** Mỗi ô một org mới: route ghi (xoá org, gỡ member) không làm bẩn ô sau. */
  const cast = async (opts: { sessionAgeSec?: number; emailVerified?: boolean } = {}): Promise<Cast> => {
    const owner = await seedP(opts);
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    const admin = await seedP(opts);
    const member = await seedP(opts);
    await seedMember(org, 'ADMIN', { authUserId: admin.authUserId });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await seedMember(org, 'OWNER', { authUserId: (await seedP()).authUserId });
    const target = await seedMember(org, 'MEMBER', { authUserId: (await seedP()).authUserId });
    return { org, as: { OWNER: owner, ADMIN: admin, MEMBER: member }, target: target.memberPublicId };
  };
  const call = (route: TenantRoute, c: Cast, p: SeededPrincipal) => {
    const url = `/${route.template}`
      .replace(':orgId', c.org.orgId)
      .replace(':memberId', c.target)
      .replace(':roleId', c.org.roles.MEMBER.publicId);
    const agent = request(app.getHttpServer());
    const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
    const body = route.id === 'PATCH v1/orgs/:orgId' ? { name: 'Matrix' } : route.id === 'PATCH v1/orgs/:orgId/members/:memberId' ? { roleId: c.org.roles.MEMBER.publicId } : {};
    const req = agent[method](url).set('authorization', `Bearer ${p.bearer}`).set('if-match', '*').set('idempotency-key', `k-${v7()}`);
    return method === 'get' ? req : req.send(body);
  };
  beforeAll(async () => {
    app = await startTenancyApp({ env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' } });
    routes = app.get(OrgRouteInventory).tenantRoutes();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('the tenant route table of 3A is exactly the one in the spec', () => {
    expect(routes.map((r) => r.id).sort()).toEqual([...ROUTES_3A].sort());
  });
  it('G-6: every (OWNER|ADMIN|MEMBER × route) cell passes the guard iff the catalogue grants every required key', async () => {
    const merged = app.get(PermissionCatalogueRegistry).merged();
    const failures: string[] = [];
    for (const role of ROLES) {
      const perms = systemRolePermissions(role, merged);
      for (const route of routes) {
        const allowed = route.policy.kind === 'MEMBER_ONLY' || route.policy.keys.every((k) => perms.has(k));
        const c = await cast();
        const r = await call(route, c, c.as[role]);
        const deniedByGuard = r.status === 403 && r.body.code === 'forbidden';
        if (r.status >= 500 || deniedByGuard === allowed) failures.push(`${role} ${route.id}: ${r.status} ${r.body.code ?? ''} (expected ${allowed ? 'past the guard' : '403 forbidden'})`);
      }
    }
    expect(failures).toEqual([]);
  });
  it('every sensitive route: a stale session → 403 reauthentication_required; an unverified email (flag off) → 403 email_not_verified', async () => {
    const failures: string[] = [];
    for (const route of routes.filter((r) => r.sensitive)) {
      const stale = await cast({ sessionAgeSec: STALE_SEC });
      const s = await call(route, stale, stale.as.OWNER);
      if (s.status !== 403 || s.body.code !== 'reauthentication_required') failures.push(`stale ${route.id}: ${s.status} ${s.body.code}`);
      const unverified = await cast({ emailVerified: false });
      const u = await call(route, unverified, unverified.as.OWNER);
      if (u.status !== 403 || u.body.code !== 'email_not_verified') failures.push(`unverified ${route.id}: ${u.status} ${u.body.code}`);
    }
    expect(failures).toEqual([]);
    const stale = await seedP({ sessionAgeSec: STALE_SEC });
    const create = await request(app.getHttpServer()).post('/v1/orgs').set('authorization', `Bearer ${stale.bearer}`).set('idempotency-key', `k-${v7()}`).send({ name: 'Stale' });
    expect(create.body.code).toBe('reauthentication_required');
  });
  it('every narrowing route succeeds with a stale session (revocation must stay possible, SEC3-2)', async () => {
    const narrowing = routes.filter((r) => r.narrowing);
    expect(narrowing.map((r) => r.id)).toEqual(['DELETE v1/orgs/:orgId/members/me']);
    for (const route of narrowing) {
      const c = await cast({ sessionAgeSec: STALE_SEC });
      expect((await call(route, c, c.as.MEMBER)).status).toBe(204);
    }
  });
});
```

- [ ] **Step 3: Ba `AUTH_MODE`**

`test/e2e/tenancy/auth-modes.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { TEST_ORIGIN } from '../../support/auth-client.js';
import { FAKE_IDP_CLIENT_ID, FAKE_IDP_CLIENT_SECRET, startFakeIdp, type FakeIdp } from '../../support/fake-idp.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs, seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const nowSec = () => Math.floor(Date.now() / 1000);

describe('AUTH_MODE=external (spec SP3 §11, tiêu chí 13)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  const created: string[] = [];
  const seeded: SeededOrg[] = [];
  const token = (sub: string, extra: Record<string, unknown> = {}) =>
    jwks.sign({ iss: ISS, aud: AUD, sub, iat: nowSec(), exp: nowSec() + 300, idtyp: 'user', ...extra });
  const http = () => request(app.getHttpServer());
  beforeAll(async () => {
    jwks = await startFakeJwks();
    // Chỉ env của external đã có từ SP2: tenancy không đòi thêm biến nào (INT-I12).
    app = await startTenancyApp({
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
    for (const o of seeded) await o.dispose();
    await purgeOrgs(created);
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('a fresh token (auth_time now) creates an org; the subject is stored as external_subject; email/name are null', async () => {
    const sub = `ext-${v7()}`;
    const t = await token(sub, { auth_time: nowSec() });
    const r = await http().post('/v1/orgs').set('authorization', `Bearer ${t}`).set('idempotency-key', `k-${v7()}`).send({ name: 'External' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    expect(await ownerQuery('SELECT 1 FROM tenancy_users WHERE external_subject = $1', [sub])).toHaveLength(1);
    const me = await http().get(`/v1/orgs/${r.body.id}/members/me`).set('authorization', `Bearer ${t}`);
    expect(me.body).toMatchObject({ role: { systemKey: 'OWNER' }, email: null, name: null });
  });
  it('without auth_time: sensitive routes → 403 reauthentication_required (no iat fallback); narrowing leave still works', async () => {
    const org = await seedOrg({ owner: { externalSubject: `ext-${v7()}` } });
    seeded.push(org);
    const memberSub = `ext-${v7()}`;
    await seedMember(org, 'ADMIN', { externalSubject: memberSub });
    const t = await token(memberSub);
    const patch = await http().patch(`/v1/orgs/${org.orgId}`).set('authorization', `Bearer ${t}`).set('if-match', '*').send({ name: 'x' });
    expect([patch.status, patch.body.code]).toEqual([403, 'reauthentication_required']);
    expect((await http().delete(`/v1/orgs/${org.orgId}/members/me`).set('authorization', `Bearer ${t}`)).status).toBe(204);
  });
});

describe('AUTH_MODE=hybrid (spec SP3 §11, tiêu chí 13)', () => {
  let app: INestApplication;
  let idp: FakeIdp;
  const principals: SeededPrincipal[] = [];
  const created: string[] = [];
  beforeAll(async () => {
    idp = await startFakeIdp({ redirectUri: `${TEST_ORIGIN}/api/auth/callback/corp` });
    app = await startTenancyApp({
      env: {
        AUTH_MODE: 'hybrid',
        AUTH_OIDC_PROVIDER_ID: 'corp',
        AUTH_OIDC_DISCOVERY_URL: idp.discoveryUrl,
        AUTH_OIDC_CLIENT_ID: FAKE_IDP_CLIENT_ID,
        AUTH_OIDC_CLIENT_SECRET: FAKE_IDP_CLIENT_SECRET,
        AUTH_TRUSTED_PROVIDERS: 'corp',
      },
    });
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await idp?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a Better Auth session creates and reads an org; the subject is the auth user id', async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    const r = await authed(app, p).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name: 'Hybrid' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    expect((await authed(app, p).get(`/v1/orgs/${r.body.id}`)).status).toBe(200);
    expect(await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [p.authUserId])).toHaveLength(1);
  });
});
```
Ghi chú: `local` là mode mặc định của mọi e2e tenancy khác (Task 22–26), nên file này chỉ thêm `external` và `hybrid`. Dòng `tenancy_users` của external do API tạo được `purgeOrgs` để lại (không có `auth."user"` để FK chặn); test không dọn chúng vì subject ngẫu nhiên, không đụng test khác.

Run: `pnpm vitest run --project integration test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts`
Expected: PASS (ma trận không có ô lệch; mọi route ✓ trả 403 đúng mã với session cũ/email chưa xác thực; route thu hẹp 204; external boot không cần env mới).

- [ ] **Step 4: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/modules/tenancy/application/org-route-inventory.ts test/e2e/tenancy/role-route-matrix.e2e.spec.ts test/e2e/tenancy/auth-modes.e2e.spec.ts
git commit -m "test(tenancy): metadata-driven role x route matrix, fresh-session table and the three auth modes"
```

---

### Task 28: Chaos (DB mất giữa tra membership và giữa mutation, Redis sập, giết worker giữa purge, giết api giữa mutation) và PII của các đường lỗi 3A

**Files:**
- Create (test): `test/chaos/tenancy-outages.spec.ts`, `test/chaos/tenancy-purge-kill.spec.ts`, `test/chaos/tenancy-api-kill.spec.ts`, `test/e2e/tenancy/pii-logs.e2e.spec.ts`, `test/e2e/tenancy/telemetry-pii.e2e.spec.ts`

**Interfaces:**
- Consumes: `startTcpProxy` (SP1/SP2), Toxiproxy + `readImages` (SP1 `redis-outage.spec.ts`), `startWorker`/`exitCode`/`killIfAlive`/`sendSigterm` (SP1), `startAppProcess`/`stopAppProcess` (SP2), `installOtelCapture` (SP1), `startTenancyApp`, `authed` (Task 22), `seedOrg`/`seedMember` (Task 14), `seedUserPrincipal` (Task 10), `PurgeOrgJob`, `purgeJobId` (Task 25), `tenancyCoreImports`, `TenancyTestHooks.afterGuard` (Task 19), `tenancy_count_user_orgs` (Task 15), `purgeOrgs` (Task 23), `test/support/api-entry.ts` (SP2).
- Produces: không có API mới — bằng chứng tiêu chí 11 (api bị giết giữa handler và commit: không event mồ côi, không thay đổi thiếu event), tiêu chí 12 (DB lỗi → 503 ở tra membership, ở transaction của mutation trên path org và ở `POST /v1/orgs`), SEC2-N6 (lỗi hạ tầng không bị đếm là lần trượt), CDX-13 (Redis sập → insurance), purge chạy lại nhất quán, tiêu chí 16 (không PII), span `tenancy.policy.check`/`tenancy.member.admit` (review M4).

- [ ] **Step 1: DB app bị blackhole giữa tra membership; Redis sập**

`test/chaos/tenancy-outages.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { ToxiProxyContainer, type CreatedProxy, type StartedToxiProxyContainer } from '@testcontainers/toxiproxy';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenancyTestHooks } from '../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { readImages } from '../support/images.js';
import { authed, startTenancyApp } from '../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../support/tenancy-principals.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../support/tenancy-seed.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';

/** Tham số của bộ test (không phải config của app). */
const MISS_LIMIT = 3;
/** Cận trên của một request trong blackhole: chờ connection + query quá hạn + ROLLBACK quá hạn (mặc định của app) + dư. */
const OUTAGE_BOUND_MS = 20_000;
const REDIS_PORT = 6379;
const RECOVERY = { timeout: 30_000, interval: 250 };

/**
 * Seam `afterGuard` (Task 19; gọi sau `PoliciesGuard`, trước transaction của mutation quản trị): bật blackhole đúng một
 * lần, để lỗi DB rơi vào transaction của mutation chứ không vào câu tra membership của middleware (tiêu chí 12, review M5).
 */
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

describe('app DB blackholed during the membership lookup (spec SP3 §7.1 bước 3.11, tiêu chí 12, SEC2-N6)', () => {
  const hooks = new BlackholeAfterGuard();
  let proxy: TcpProxy;
  let app: INestApplication;
  let member: SeededPrincipal;
  let outsider: SeededPrincipal;
  let org: SeededOrg;
  const orgName = () =>
    withAppClient((c) => inOrgTx(c, org.orgId, async () => (await c.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [org.orgId])).rows[0]?.name));
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    // Chỉ pool `app` đi qua proxy; pool `auth_user` (DB_AUTH_HOST) đi thẳng PgBouncer nên xác thực vẫn chạy.
    app = await startTenancyApp({
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port), TENANCY_ORG_MISS_RATE_LIMIT: String(MISS_LIMIT), THROTTLE_DEFAULT_LIMIT: '100000' },
      configure: (b) => b.overrideProvider(TenancyTestHooks).useValue(hooks),
    });
    member = await seedUserPrincipal();
    outsider = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: member.authUserId } });
  });
  afterAll(async () => {
    proxy.state.blackhole = false;
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await deleteSeededPrincipals([member, outsider]);
    vi.unstubAllEnvs();
  });

  it('member and non-member both get 503 + Retry-After within the bound; the miss limiter is not charged', async () => {
    proxy.state.blackhole = true;
    const started = performance.now();
    const [m, o] = await Promise.all([
      authed(app, member).get(`/v1/orgs/${org.orgId}`),
      authed(app, outsider).get(`/v1/orgs/${org.orgId}`),
    ]);
    expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
    for (const r of [m, o]) {
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
    proxy.state.blackhole = false;
    await vi.waitFor(async () => expect((await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status).toBe(200), { timeout: 30_000, interval: 250 });
    // Lần 503 lúc sập không bị đếm: vẫn còn đủ MISS_LIMIT + 1 lần 404 (hợp đồng peek của Task 5) trước khi 429.
    for (let i = 0; i < MISS_LIMIT + 1; i++) expect((await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status, `miss ${i + 1}`).toBe(404);
    expect((await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status).toBe(429);
  });
  it('criterion 12 on a mutation: DB lost after the guard, inside the rename transaction → 503 within the bound; no rename, no event', async () => {
    const before = await orgName();
    hooks.armed = proxy;
    try {
      const started = performance.now();
      const r = await authed(app, member).patch(`/v1/orgs/${org.orgId}`).set('if-match', '*').send({ name: 'Renamed during outage' });
      expect(performance.now() - started).toBeLessThan(OUTAGE_BOUND_MS);
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      hooks.armed = undefined;
      proxy.state.blackhole = false;
    }
    await vi.waitFor(async () => expect((await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status).toBe(200), RECOVERY);
    expect(await orgName()).toBe(before);
    expect(await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.updated'`, [org.orgId])).toEqual([]);
  });
  it('criterion 12 outside an org path: POST /v1/orgs while the DB is blackholed → 503, no org row for the name', async () => {
    const name = `During DB outage ${v7()}`;
    proxy.state.blackhole = true;
    try {
      const r = await authed(app, member).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name });
      expect([r.status, r.body.code]).toEqual([503, 'service_unavailable']);
    } finally {
      proxy.state.blackhole = false;
    }
    await vi.waitFor(async () => expect((await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status).toBe(200), RECOVERY);
    // `organizations` là FORCE RLS; đếm qua hàm definer `tenancy_count_user_orgs(bigint, boolean)` (Task 15, không cần
    // OrgScope): member vẫn chỉ thuộc đúng org seed, request lúc sập không tạo org nào.
    const [mine] = await withAppClient(async (c) =>
      (await c.query<{ n: number }>(`SELECT tenancy_count_user_orgs((SELECT id FROM tenancy_users WHERE auth_user_id = $1), false)::int AS n`, [member.authUserId])).rows,
    );
    expect(mine?.n).toBe(1);
  });
});

describe('Redis down: tenant routes keep working and the miss limiter falls back to the per-pod insurance (CDX-13)', () => {
  let network: StartedNetwork | undefined;
  let redis: StartedTestContainer | undefined;
  let toxi: StartedToxiProxyContainer | undefined;
  let proxy: CreatedProxy | undefined;
  let app: INestApplication | undefined;
  let member: SeededPrincipal;
  let outsider: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const images = readImages();
    if (!images.IMAGE_REDIS || !images.IMAGE_TOXIPROXY) throw new Error('IMAGE_REDIS and IMAGE_TOXIPROXY must be pinned in docker/images.env');
    network = await new Network().start();
    redis = await new GenericContainer(images.IMAGE_REDIS).withNetwork(network).withNetworkAliases('redis').withExposedPorts(REDIS_PORT).start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY).withNetwork(network).start();
    proxy = await toxi.createProxy({ name: 'redis', upstream: `redis:${REDIS_PORT}` });
    app = await startTenancyApp({
      env: { REDIS_URL: `redis://${proxy.host}:${proxy.port}`, TENANCY_ORG_MISS_RATE_LIMIT: String(MISS_LIMIT), THROTTLE_DEFAULT_LIMIT: '100000' },
    });
    member = await seedUserPrincipal();
    outsider = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: member.authUserId } });
  });
  afterAll(async () => {
    await proxy?.setEnabled(true);
    await org?.dispose();
    await app?.close();
    await toxi?.stop();
    await redis?.stop();
    await network?.stop();
    await deleteSeededPrincipals([member, outsider]);
    vi.unstubAllEnvs();
  });

  it('member reads succeed, misses are still limited per pod, idempotent creates answer 503', async () => {
    if (!app || !proxy) throw new Error('not started');
    await proxy.setEnabled(false);
    expect((await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status).toBe(200);
    // Insurance theo pod dùng cùng `limit`: MISS_LIMIT + 1 lần 404 (lần làm vượt ngưỡng vẫn là 404), rồi 429.
    for (let i = 0; i < MISS_LIMIT + 1; i++) expect((await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status, `miss ${i + 1}`).toBe(404);
    expect((await authed(app, outsider).get(`/v1/orgs/${v7()}`)).status).toBe(429);
    const create = await request(app.getHttpServer())
      .post('/v1/orgs')
      .set('authorization', `Bearer ${member.bearer}`)
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'During outage' });
    expect(create.status).toBe(503);
    await proxy.setEnabled(true);
  });
});
```

- [ ] **Step 2: Giết worker giữa job purge**

`test/chaos/tenancy-purge-kill.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import type { ChildProcess } from 'node:child_process';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope } from '../../src/core/database/index.js';
import { JobQueue } from '../../src/core/queue/index.js';
import { PurgeOrgJob, purgeJobId } from '../../src/modules/tenancy/jobs.js';
import { createTestApp } from '../support/app-factory.js';
import { baseTestEnv } from '../support/env.js';
import { ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { exitCode, killIfAlive, sendSigterm, startWorker } from '../support/spawn-worker.js';
import { tenancyCoreImports } from '../support/tenancy-core-app.js';
import { inOrgTx, seedOrg, withAppClient, type SeededOrg } from '../support/tenancy-seed.js';

const STALLED_MS = 1_000;
const WAIT_MS = 60_000;

const until = async (pred: () => Promise<boolean>, ms = WAIT_MS): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};

/**
 * Spec SP3 §18.4: worker bị SIGKILL khi job purge đang giữ transaction (đứng chờ khoá org mà test giữ). Postgres
 * rollback phần của nó; worker thứ hai nhận lại job stalled và purge đúng một lần (một event `tenancy.org.purged`).
 */
describe('worker killed in the middle of an organization purge', () => {
  let producer: INestApplication | undefined;
  const children: ChildProcess[] = [];
  let org: SeededOrg;
  const env = () => ({
    ...baseTestEnv(),
    WORKER_QUEUES: 'maintenance',
    WORKER_HEALTH_PORT: '0',
    HEALTH_DRAIN_DELAY_MS: '0',
    QUEUE_STALLED_INTERVAL_MS: String(STALLED_MS),
    QUEUE_LOCK_DURATION_MS: String(STALLED_MS),
  });
  const exists = () => withAppClient((c) => inOrgTx(c, org.orgId, async () => ((await c.query('SELECT 1 FROM organizations WHERE id = $1', [org.orgId])).rowCount ?? 0) === 1));
  beforeAll(async () => {
    producer = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
    await withAppClient((c) => inOrgTx(c, org.orgId, () => c.query(`UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`, [org.orgId])));
  });
  afterEach(() => {
    for (const child of children.splice(0)) killIfAlive(child);
  });
  afterAll(async () => {
    if (await exists()) await org.dispose();
    await producer?.close();
  });

  it('the purge is redelivered and committed exactly once', async () => {
    if (!producer) throw new Error('producer not started');
    const { pg: p } = getInfra();
    const holder = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      await holder.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [org.orgId]);
      const first = await startWorker(env());
      children.push(first.child);
      await producer.get(OrgScope).run(org.orgId, () => producer!.get(JobQueue).enqueue(PurgeOrgJob, {}, { jobId: purgeJobId(org.orgId), meta: { orgId: org.orgId } }));
      // Job đã vào transaction và đang chờ khoá org của test.
      await until(async () => (await ownerQuery(`SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`)).length > 0);
      const firstExit = exitCode(first.child);
      first.child.kill('SIGKILL');
      await firstExit;
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    expect(await exists()).toBe(true);
    const second = await startWorker(env());
    children.push(second.child);
    await until(async () => !(await exists()));
    const secondExit = exitCode(second.child);
    sendSigterm(second.child);
    expect(await secondExit).toBe(0);
    expect(await ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`, [org.orgId])).toHaveLength(1);
  });
});
```

Run: `pnpm test:chaos -- test/chaos/tenancy-outages.spec.ts test/chaos/tenancy-purge-kill.spec.ts`
Expected: PASS.

- [ ] **Step 3: Giết process api giữa handler và commit của một mutation tenancy (tiêu chí 11, review M5)**

`test/chaos/tenancy-api-kill.spec.ts`:
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
const BEFORE = 'Before api kill';
const AFTER = 'After api kill';
const PROCESS_ENV: Record<string, string> = { HTTP_PORT: '0', HTTP_HOST: '127.0.0.1', HTTP_TRUST_PROXY: 'loopback' };

const until = async (pred: () => Promise<boolean>, ms = WAIT_MS): Promise<void> => {
  const started = Date.now();
  while (!(await pred())) {
    if (Date.now() - started > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};
/** `organizations` là FORCE RLS: đọc bằng `app_user` trong OrgScope của org. */
const orgName = (orgId: string) =>
  withAppClient((c) => inOrgTx(c, orgId, async () => (await c.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId])).rows[0]?.name));
const updatedEvents = (orgId: string) =>
  ownerQuery(`SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.updated'`, [orgId]);
const rename = (port: number, p: SeededPrincipal, orgId: string, name: string) =>
  fetch(`http://127.0.0.1:${port}/v1/orgs/${orgId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${p.bearer}`, 'content-type': 'application/json', 'if-match': '*' },
    body: JSON.stringify({ name }),
  });
const startApi = async (): Promise<AppProcess & { port: number }> => {
  const api = await startAppProcess(API_ENTRY, { ...baseTestEnv(), ...PROCESS_ENV });
  if (api.port === undefined) {
    await stopAppProcess(api);
    throw new Error('api-entry reported no port');
  }
  return { ...api, port: api.port };
};

/**
 * Spec SP3 §1 tiêu chí 11 (không event mồ côi, không thay đổi thiếu event): process api bị SIGKILL khi `PATCH
 * /v1/orgs/{id}` đã qua middleware + guard và đang ở TRONG transaction của mutation (đứng chờ khoá org mà test giữ).
 * Postgres rollback phần của nó (PgBouncer đóng connection server của client đã chết); thay đổi và event outbox cùng
 * transaction nên cùng mất. Một api mới làm lại đúng mutation đó: đúng một thay đổi, đúng một event.
 */
describe('api killed between the handler and the commit of a tenancy mutation (spec SP3 §1 criterion 11)', () => {
  const apis: AppProcess[] = [];
  let owner: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  beforeAll(async () => {
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId }, name: BEFORE });
  });
  afterAll(async () => {
    for (const a of apis.splice(0)) await stopAppProcess(a);
    await org?.dispose();
    if (owner) await deleteSeededPrincipals([owner]);
  });

  it('SIGKILL while the rename waits on the org lock: no rename, no orphan event; a fresh api then renames with exactly one event', async () => {
    if (!owner || !org) throw new Error('not seeded');
    const first = await startApi();
    apis.push(first);
    const { pg: p } = getInfra();
    const holder = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.org_id', $1, true)`, [org.orgId]);
      await holder.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [org.orgId]);
      // Không bao giờ có response: process chết khi request còn trong transaction (fetch reject khi socket đóng).
      const pending = rename(first.port, owner, org.orgId, AFTER).then((r) => r.status, (err: unknown) => err);
      // `OrgService.rename` đã mở transaction và đứng ở `lockCurrent()` (FOR NO KEY UPDATE) chờ khoá của test.
      await until(async () => (await ownerQuery(`SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`)).length > 0);
      const exited = exitCode(first.child);
      first.child.kill('SIGKILL');
      await exited;
      expect(await pending).toBeInstanceOf(Error);
      await holder.query('COMMIT');
    } finally {
      await holder.end();
    }
    expect(await orgName(org.orgId)).toBe(BEFORE);
    expect(await updatedEvents(org.orgId)).toEqual([]);

    const second = await startApi();
    apis.push(second);
    expect((await rename(second.port, owner, org.orgId, AFTER)).status).toBe(200);
    expect(await orgName(org.orgId)).toBe(AFTER);
    expect(await updatedEvents(org.orgId)).toHaveLength(1);
  });
});
```

Run: `pnpm test:chaos -- test/chaos/tenancy-api-kill.spec.ts`
Expected: PASS (process api con thật qua `test/support/api-entry.ts`, `AppApiModule` có `TenancyModule.forApi()` từ Task 19).

- [ ] **Step 4: PII trên stack log production (api + worker process thật)**

`test/e2e/tenancy/pii-logs.e2e.spec.ts`:
```ts
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppProcess, stopAppProcess, type AppProcess } from '../../support/app-process.js';
import { AuthClient } from '../../support/auth-client.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const mail = mailpitFromInfra();
const PASSWORD = 'correct horse battery';
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi;
const SYSTEM_SENDER = 'noreply@example.test';
const PROCESS_ENV: Record<string, string> = {
  LOG_LEVEL: 'debug',
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
  WORKER_QUEUES: 'events,notifications,maintenance',
  AUTH_RATE_LIMIT_MAX: '10000',
  AUTH_SIGNIN_RATE_MAX: '1000',
  AUTH_EMAIL_RATE_MAX: '1000',
  AUTH_ENUMERATION_MIN_RESPONSE_MS: '0',
};

describe('no PII in logs of the 3A error paths (spec SP3 §16, §18.4, tiêu chí 16)', () => {
  let api: AppProcess | undefined;
  let worker: AppProcess | undefined;
  let base = '';
  const secrets = new Set<string>([PASSWORD]);
  const seeded: SeededPrincipal[] = [];
  const created: string[] = [];
  beforeAll(async () => {
    const env = { ...baseTestEnv(), ...PROCESS_ENV };
    const [a, w] = await Promise.allSettled([startAppProcess('test/support/api-entry.ts', env), startAppProcess('test/support/worker-entry.ts', env)]);
    if (a.status === 'fulfilled') api = a.value;
    if (w.status === 'fulfilled') worker = w.value;
    if (a.status === 'rejected' || w.status === 'rejected') {
      await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
      throw new Error('app process failed to start');
    }
    base = `http://127.0.0.1:${api?.port}`;
  });
  afterAll(async () => {
    await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
    await purgeOrgs(created);
    await deleteTenancyUsersOf(seeded.map((p) => p.authUserId));
    await deleteSeededPrincipals(seeded);
  });

  it('create/rename/delete/restore, 404 misses, 403, escalation, last-owner and blocked account deletion write no address or token', async () => {
    const started = await mail.now();
    const email = `pii-tenancy-${v7()}@example.test`;
    secrets.add(email);
    const c = new AuthClient(base);
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    await c.verifyEmailFromMailpit(mail, email, started);
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    for (const [, v] of c.cookies) secrets.add(decodeURIComponent(v));
    if (c.bearer) secrets.add(c.bearer);

    const org = await c.request('post', '/v1/orgs', { body: { name: 'Pii Org' }, headers: { 'idempotency-key': `k-${v7()}` } });
    expect(org.status).toBe(201);
    created.push(org.body.id);
    const orgUrl = `/v1/orgs/${org.body.id}`;
    expect((await c.request('patch', orgUrl, { body: { name: 'Renamed' }, headers: { 'if-match': '*' } })).status).toBe(200);
    expect((await c.request('get', `/v1/orgs/${v7()}`)).status).toBe(404);
    expect((await c.request('get', '/v1/orgs/not-a-uuid')).status).toBe(400);
    expect((await c.request('delete', `${orgUrl}/members/me`)).status).toBe(409);
    const me = await c.request('get', `${orgUrl}/members/me`);
    expect((await c.request('patch', `${orgUrl}/members/${me.body.id}`, { body: { roleId: me.body.role.id }, headers: { 'if-match': '*' } })).status).toBe(403);
    const admin = await seedUserPrincipal({ role: 'admin' });
    seeded.push(admin);
    secrets.add(admin.bearer);
    const [row] = await ownerQuery<{ id: string }>('SELECT id FROM auth."user" WHERE email = $1', [email]);
    const blocked = await new AuthClient(base).request('post', '/api/auth/admin/remove-user', { bearer: admin.bearer, cookie: false, body: { userId: row?.id } });
    expect(blocked.status).toBe(409);
    expect((await c.request('delete', orgUrl)).status).toBe(204);
    expect((await c.request('post', `${orgUrl}/restore`, { headers: { 'idempotency-key': `k-${v7()}` } })).status).toBe(200);

    await new Promise((r) => setTimeout(r, 1_000));
    const output = `${api?.output() ?? ''}\n${worker?.output() ?? ''}`;
    const addresses = [...output.matchAll(EMAIL_ADDRESS)].map((m) => m[0].toLowerCase()).filter((a) => a !== SYSTEM_SENDER);
    expect(addresses).toEqual([]);
    for (const s of secrets) expect(output.includes(s)).toBe(false);
  });
});
```

`test/e2e/tenancy/telemetry-pii.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import { deleteSeededPrincipals, seedUserPrincipal, type SeededPrincipal } from '../../support/tenancy-principals.js';
import { purgeOrgs, seedMember, seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** Label/attribute của tenancy chỉ là enum hữu hạn (spec SP3 §16): không org, user, email, token. */
describe('tenancy spans and metrics carry no identifiers', () => {
  const otel = installOtelCapture();
  let app: INestApplication;
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  let org: SeededOrg;
  const created: string[] = [];
  beforeAll(async () => {
    app = await startTenancyApp();
    owner = await seedUserPrincipal();
    member = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
  });
  afterAll(async () => {
    // Org do API tạo tham chiếu `tenancy_users` của owner: purge trước, để `org.dispose()` xoá được dòng user.
    await purgeOrgs(created);
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals([owner, member]);
    vi.unstubAllEnvs();
  });

  it('after a create, grants, misses, denials and a last-owner refusal, no attribute value contains an id, email or token', async () => {
    otel.reset();
    const made = await authed(app, owner).post('/v1/orgs').set('idempotency-key', `k-${v7()}`).send({ name: 'Telemetry Org' });
    expect(made.status).toBe(201);
    created.push(made.body.id);
    await authed(app, owner).get(`/v1/orgs/${org.orgId}`);
    await authed(app, member).get(`/v1/orgs/${v7()}`);
    await authed(app, member).patch(`/v1/orgs/${org.orgId}`).set('if-match', '*').send({ name: 'x' });
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}/members/me`);
    // Review M4: hai span của spec §16 mà 3A sở hữu có mặt, với attribute là enum.
    const policyResults = otel.spans('tenancy.policy.check').map((s) => s.attributes['tenancy.policy.result']);
    expect(policyResults).toEqual(expect.arrayContaining(['allowed', 'denied']));
    for (const r of policyResults) expect(['allowed', 'denied', 'error']).toContain(r);
    const admits = otel.spans('tenancy.member.admit');
    expect(admits).toHaveLength(1);
    expect(admits[0]?.attributes['tenancy.member.source']).toBe('CREATOR');
    const forbidden = [org.orgId, made.body.id, owner.authUserId, member.authUserId, owner.email, member.email, owner.bearer, member.bearer];
    const values = [
      ...otel.spanNames().flatMap((n) => otel.spans(n).flatMap((s) => Object.values(s.attributes).map(String))),
      ...(await otel.dataPoints('tenancy_')).flatMap((d) => Object.values(d.attributes).map(String)),
    ];
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) for (const f of forbidden) expect(v.includes(f)).toBe(false);
  });
});
```
Run:
```bash
pnpm vitest run --project integration test/e2e/tenancy/pii-logs.e2e.spec.ts test/e2e/tenancy/telemetry-pii.e2e.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/chaos/tenancy-outages.spec.ts test/chaos/tenancy-purge-kill.spec.ts test/chaos/tenancy-api-kill.spec.ts test/e2e/tenancy/pii-logs.e2e.spec.ts test/e2e/tenancy/telemetry-pii.e2e.spec.ts
git commit -m "test(tenancy): chaos for membership lookup, redis and purge worker kill; PII checks of the 3A error paths"
```

---

## Phần H — Prod-like, tài liệu, bàn giao (spec §18.4, §22)

### Task 29: Prod-like #3 — luồng tenancy trên image production; đo kích thước image, ghi dòng "SP3 (3A)" vào ADR 0013

**Files:**
- Modify: `test/smoke/tenancy.smoke.spec.ts`, `docs/adr/0013-build-toolchain.md`

**Interfaces:**
- Consumes: `Device`, `verifiedDevice`, `PASSWORD` (Task 12 trong cùng file smoke), import `z` (Task 26 trong cùng file smoke), `psql`, `logsSince`, `assertCleanLogs`, `workerHealth` (SP2 smoke support), image `nestjs-saas-boilerplate:nsb-smoke` do `smoke.global-setup.ts` build (tag `${APP_IMAGE_REPO}:${project}`).
- Produces: smoke 3A đầy đủ (spec §18.4: đăng ký → xác thực → tạo org → đổi tên → xoá mềm → `404` → khôi phục, rồi xoá tài khoản: `409 user_deletion_blocked` khi còn là owner duy nhất, `200` sau khi xoá mềm org — review I10); số đo image chưa nén/nén/chênh so với SP2/phần `@casl/ability` trong ADR 0013.

- [ ] **Step 1: Thêm luồng tenancy vào smoke (fail trên image cũ, pass trên image của nhánh)**

`test/smoke/tenancy.smoke.spec.ts` (`z` đã được import ở Task 26) — trong `describe`, trước ca log sạch:
```ts
  it('tenancy on the production image: sign up → verify → create org → rename → soft delete → 404 → restore → account deletion blocked, then allowed after a soft delete', async () => {
    const { device, email } = await verifiedDevice(apiUrl, mail);
    const created = await device.call('POST', '/v1/orgs', { body: { name: 'Smoke Org' }, headers: { 'idempotency-key': `smoke-${randomUUID()}` } });
    expect(created.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(await created.json());
    const url = `/v1/orgs/${id}`;
    expect(created.headers.get('location')).toBe(url);
    const list = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await (await device.call('GET', '/v1/orgs')).json());
    expect(list.data.map((o) => o.id)).toContain(id);
    const got = await device.call('GET', url);
    expect(got.status).toBe(200);
    const renamed = await device.call('PATCH', url, { body: { name: 'Smoke Org Renamed' }, headers: { 'if-match': got.headers.get('etag') ?? '' } });
    expect(renamed.status).toBe(200);
    expect((await device.call('DELETE', url)).status).toBe(204);
    expect((await device.call('GET', url)).status).toBe(404);
    const restored = await device.call('POST', `${url}/restore`, { headers: { 'idempotency-key': `smoke-${randomUUID()}` } });
    expect(restored.status).toBe(200);
    expect((await device.call('GET', url)).status).toBe(200);
    // member.added, org.created, org.updated, org.deleted, org.restored — cùng transaction với từng thay đổi.
    expect(psql(`SELECT count(*) FROM outbox_events WHERE org_id = '${id}' AND type LIKE 'tenancy.%'`)).toBe('5');
    expect(psql(`SELECT relforcerowsecurity::text FROM pg_class WHERE relname = 'org_members'`)).toBe('true');

    // Xoá tài khoản (spec §9.6, review I10): org đã khôi phục nên người dùng lại là owner duy nhất của một org hoạt động.
    const userId = psql(`SELECT id FROM auth."user" WHERE email = '${email}'`);
    const { device: admin, email: adminEmail } = await verifiedDevice(apiUrl, mail);
    psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${adminEmail}'`);
    const blocked = await admin.call('POST', '/api/auth/admin/remove-user', { body: { userId } });
    expect(blocked.status).toBe(409);
    expect(z.object({ code: z.string() }).parse(await blocked.json()).code).toBe('user_deletion_blocked');
    expect((await device.call('GET', url)).status).toBe(200);
    expect((await device.call('DELETE', url)).status).toBe(204);
    expect((await admin.call('POST', '/api/auth/admin/remove-user', { body: { userId } })).status).toBe(200);
    expect(psql(`SELECT count(*) FROM auth."user" WHERE id = '${userId}'`)).toBe('0');
    expect(psql(`SELECT count(*) FROM tenancy_users WHERE auth_user_id = '${userId}'`)).toBe('0');
    // Thêm org.deleted (lần hai) và member.removed { reason: ACCOUNT_DELETED }.
    expect(psql(`SELECT count(*) FROM outbox_events WHERE org_id = '${id}' AND type LIKE 'tenancy.%'`)).toBe('7');
    expect(psql(`SELECT payload->>'reason' FROM outbox_events WHERE org_id = '${id}' AND type = 'tenancy.member.removed'`)).toBe('ACCOUNT_DELETED');
  });
```
(`id` do API trả và đã qua `z.uuid()`, `userId` do Postgres sinh, email do smoke sinh bằng `randomUUID`; nối vào SQL của superuser smoke là an toàn.)

Run: `pnpm test:smoke`
Expected: build image production thật, `compose --profile app` (`NODE_ENV=production`, TLS, PgBouncer, rate limit bật), migrate mọi migration 3A trên image, mọi file smoke PASS (`core`, `auth-email`, `dashboard`, `tenancy`), log api/worker là JSON, không `error`, không chứa mật khẩu smoke; `/health/ready` 200; teardown `down -v` sạch (`docker compose -p nsb-smoke ps -a` rỗng). Image `nestjs-saas-boilerplate:nsb-smoke` còn lại để đo ở Step 2.

- [ ] **Step 2: Đo image đúng cách ADR 0013 đang dùng**

Run (Git Bash; cùng máy Docker Desktop/WSL2/amd64 như số SP2):
```bash
IMG=nestjs-saas-boilerplate:nsb-smoke
docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' "$IMG" > "$TMPDIR/sp3a-history.txt"
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
  const casl = fs.readdirSync(pnpm).filter((d) => d.startsWith('@casl+') || d.startsWith('@ucast+'));
  const bytes = casl.reduce((n, d) => n + size(path.join(pnpm, d)), 0);
  console.log(JSON.stringify({ dirs: casl, mb: (bytes / 1e6).toFixed(2) }));
"
```
Expected: tổng layer chưa nén ≤ 400 MB (vượt → dừng, pipeline coi là đỏ theo spec §18.4); con số nén (containerd snapshotter trả content size nén, như ghi chú của dòng SP2); `@casl/ability` + `@ucast/*` (dependency duy nhất của nó) cỡ vài trăm KB. `docker run "$IMG" -e …` chạy được vì ENTRYPOINT của distroless là `/nodejs/bin/node` và tham số thay cho `CMD` (`Dockerfile:43-44`), `WORKDIR /app` nên đường `node_modules/.pnpm` là tương đối.

- [ ] **Step 3: Ghi ADR 0013**

`docs/adr/0013-build-toolchain.md` — thêm mục mới ngay sau bảng "Số đo SP2 (2026-09-27)":
```markdown
### Số đo SP3 (3A) (<ngày đo>)

Đo sau `pnpm test:smoke` xanh của Task 29 trên HEAD nhánh `sp3-tenancy`, cùng máy và phương pháp với dòng SP2 (tổng layer `docker history`; nén = `docker image inspect --format '{{.Size}}'` với containerd snapshotter). 3A là plan duy nhất của SP3 thêm dependency (`@casl/ability` 7.0.1, kéo `@ucast/mongo2js` và `@ucast/*`); 3B/3C/3D chỉ ghi lại khi chênh > 1 MB, plan merge sau cùng ghi dòng "SP3 (cuối)" (spec SP3 §18.4).

| Chỉ số | SP2 | SP3 (3A) | Chênh |
|---|---|---|---|
| Image chưa nén (tổng layer) | 352 MB | <số đo> MB | <+x> MB |
| Image nén | 81,2 MB | <số đo> MB | <+x> MB |
| `@casl/ability` + `@ucast/*` trong `node_modules/.pnpm` | — | <số đo> MB | — |
| Mốc ≤ 400 MB chưa nén (§13.3) | ĐẠT, dư 48 MB | <ĐẠT/KHÔNG ĐẠT>, dư <n> MB | |
```
Thay mọi `<…>` bằng số đo thật của Step 2 (định dạng số theo văn bản ADR: dấu phẩy thập phân). Đây là dữ liệu đo, không phải chỗ trống của plan: dòng này chỉ được commit sau khi có số.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/tenancy.smoke.spec.ts docs/adr/0013-build-toolchain.md
git commit -m "test(smoke): tenancy lifecycle on the production image; record the SP3 (3A) image size in ADR 0013"
```

---

### Task 30: Tài liệu — áp dòng 3A/3A+ của amendments vào spec cha, cập nhật ADR 0005/0006/0007/0009/0010/0017, README tenancy

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/adr/0005-multi-tenant-rls.md`, `docs/adr/0006-queue-outbox.md`, `docs/adr/0007-http-conventions.md`, `docs/adr/0009-id-strategy.md`, `docs/adr/0010-better-auth-and-auth-modes.md`, `docs/adr/0017-tenancy-own-module.md`, `README.md`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-09-28-sp3-parent-spec-amendments.md` (nguyên văn cột "Hiện tại"/"Sửa thành"), spec SP3 §22.1 (danh sách cập nhật ADR, README), mọi task 1–29 (tên thật của code để trích).
- Produces: tài liệu khớp với cái 3A ship; tính năng của 3B/3C/3D trong spec cha mang nhãn `(3B)`/`(3C)`/`(3D)`.

- [ ] **Step 1: Áp amendments vào spec cha (chỉ dòng Plan = `3A` hoặc `3A+`)**

Áp theo mục "Cách áp" của file amendments, **theo đúng thứ tự dòng trong file amendments** (từ trên xuống, bỏ A7: Plan = 3D). Thứ tự đó hiện là A1, A2, A3, A4, A5, A6, A8, A9, A10, B1–B16, B19, B20, B21, B17, B18 (B19–B21 đứng TRƯỚC B17, B18 trong file; không sắp lại theo số):
1. Với mỗi dòng: tìm nguyên văn cột "Hiện tại" trong `2026-09-24-saas-core-architecture-design.md` (tìm theo nội dung, không theo số dòng). Không thấy nguyên văn → **dừng**, đối chiếu lại với `origin/main` và báo (file amendments ghi mốc `5950409`).
2. Dòng "thay" → thay đúng đoạn đó bằng cột "Sửa thành". Dòng "thêm: `…`" → chèn đoạn trong backtick ngay sau đoạn "Hiện tại". Trong A8, A9, B11 bỏ dấu `\` trước `|`.
3. Dòng `3A+`: giữ nguyên các nhãn `(3B)`, `(3C)`, `(3D)` có trong cột "Sửa thành" (mục "Cách áp": nghĩa là "chưa có, đến ở plan đó").
4. Thêm vào mục "Trạng thái" đầu file đúng một dòng: `- Cập nhật ngày <ngày áp, YYYY-MM-DD> theo spec SP3 và ADR 0017 (plan 3A).`

Run:
```bash
git diff --stat docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
grep -c "(3B)\|(3C)\|(3D)" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
grep -n "plugin organization\|X-Org-Id\|app_admin có BYPASSRLS\|tenancy.role.changed\|Cache quyền truy cập tối đa 60 giây" docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md
```
Expected: diff chỉ ở các chỗ của A1–A6, A8–A10, B1–B21 + dòng trạng thái; lệnh `grep -n` cuối không còn kết quả nào (các câu cũ đã bị thay); có nhãn plan sau (số > 0).

- [ ] **Step 2: ADR — mỗi ADR một mục "Cập nhật SP3 (3A)"**

Thêm ngay trước mục "## Phương án đã loại" (hoặc "## Giới hạn đã biết" ở 0010) của từng ADR:

`docs/adr/0005-multi-tenant-rls.md`:
```markdown
## Cập nhật SP3 (3A) (<ngày>)

- **Role `tenancy_definer`** (`NOLOGIN NOSUPERUSER NOBYPASSRLS`, script `docker/postgres/init/01-roles.sh`): chủ sở hữu duy nhất của 6 hàm `SECURITY DEFINER` chỉ đọc của tenancy (`tenancy_list_user_orgs`, `tenancy_count_user_orgs`, `tenancy_count_orgs_created_by`, `tenancy_user_sole_owner_orgs`, `tenancy_user_related_org_ids`, `tenancy_orgs_due_for_purge`; `SET search_path = ''`, tham số `NULL`/ngoài biên → `RAISE`, `EXECUTE` chỉ cho `app_user`). Có `USAGE, CREATE` trên `public` vì hàm được tạo DƯỚI role này; `app_owner` là member `INHERIT FALSE, SET TRUE`, nên từ PG 16 mọi DDL trên hàm definer phải nằm giữa `SET LOCAL ROLE tenancy_definer` và `RESET ROLE` (test quét migration ép). Không có `app_admin`: cron quét nhiều org gọi hàm definer rồi làm việc từng org trong `OrgScope` bằng `app_user`.
- **Policy `TO app_user`** trên mọi bảng tenant của SP3; policy `FOR SELECT TO tenancy_definer USING (true)` chỉ trên `organizations`, `org_roles`, `org_members` (đúng các bảng hàm definer đọc; hằng `DEFINER_READ_TABLES_3A` của test catalog). `organizations` là bảng gốc tenant (`id = app_current_org()`, không có cột `org_id`). FK kép `(org_id, id)` cho role của member; bảng tenant neo org trực tiếp bằng FK `RESTRICT` tới `organizations` (quy ước B5; `scheduled_tasks_org_fk` của core).
- **Migration đọc/ghi dữ liệu trên bảng FORCE** theo mẫu 7 bước (spec SP3 §8.8): `NO FORCE` từng bảng theo thứ tự cố định → DML + tăng version + event → `SET CONSTRAINTS <schema>.<tên> IMMEDIATE` theo tên (không bao giờ `ALL`) → trả chế độ khai báo → `FORCE` lại → khối `DO` khẳng định không bảng tenant nào mất FORCE (chạy ở mọi môi trường). Tên constraint deferrable duy nhất theo schema và không trùng constraint nào khác (khối bước 4 `RAISE`; `rls-catalog.spec.ts` kiểm ở CI). Không migration nào `isTransactional()`.
- **Down đối xứng** xoá cả hàm trigger và hàm definer (test quét `CREATE`/`DROP FUNCTION`); migration chia theo plan (3A: `core/…_scheduled_tasks_suspended_at`, `notifications/…_email_templates_lookup`, `tenancy/…_tenancy_core`, `tenancy/…_scheduled_tasks_org_link`), timestamp sau migration mới nhất trên `main` (`migration-order.spec.ts`).
- **`migrations.spec.ts` chạy trên database riêng** (`test/support/scratch-db.ts`): tạo bằng superuser bootstrap không `OWNER`, rồi chạy chính `01-roles.sh` cho database đó; test khẳng định owner/`pg_database_owner` như production.
- **Rủi ro còn lại:** SQL injection dưới `app_user` vẫn bị RLS giới hạn trong org của session, nhưng đọc được mọi bảng global mà `app_user` có `SELECT` (`tenancy_users`, `permissions`); không có dữ liệu bí mật ở đó.
```
`docs/adr/0006-queue-outbox.md`:
```markdown
## Cập nhật SP3 (3A) (<ngày>)

- `JobDef.onInactiveOrg: 'skip' | 'run'` (mặc định `'skip'`) và port `OrgActivityGate` của core (`src/core/queue/org-activity-gate.ts`). `WorkerHost` gọi gate khi job có `meta.orgId` BẮT ĐẦU, bên trong `OrgScope`; gate trả `ACTIVE` / `DELETED { deletedAt }` / `GONE`. Khác `ACTIVE` → handler không chạy, job `completed`, metric `queue_jobs_skipped_total{reason="org_inactive"}`, log INFO `job_skipped_org_inactive`, hoặc WARN `job_skipped_org_inactive_after_delete` khi org đã mất dòng hay job được enqueue sau `deleted_at` (gần như chắc chắn khai sai `'skip'` cho job phản ứng vòng đời org).
- Gate do `TenancyQueuePortsModule` (`@Global`, chỉ trong `TenancyModule.forWorker()`) cung cấp: một câu `SELECT deleted_at FROM organizations WHERE id = app_current_org()`. Không có tenancy → không gate → hành vi SP2.
- `'run'`: `core.event.dispatch` (chỉ chuyển tiếp; job con/job hoãn tự chịu gate của mình), `core.event.deliver`, `notifications.send-email`, `tenancy.org.purge`. Job do subscriber của `tenancy.org.deleted`/`.purged` enqueue (dọn dữ liệu ngoài DB) phải khai `'run'`.
- Cron `tenancy.orgs.purge` (maintenance queue) đi qua org tới hạn bằng con trỏ keyset và enqueue `tenancy.org.purge` với `jobId = tenancy-purge-<orgId>` (không `:`; BullMQ bỏ qua `add` trùng id khi job cùng id còn được giữ). Job purge là MỘT transaction (participant theo `order`, bảng tenancy con trước cha, outbox `tenancy.org.purged`); lỗi → retry + `tenancy_org_purge_failed_total`.
```
`docs/adr/0007-http-conventions.md`:
```markdown
## Cập nhật SP3 (3A) (<ngày>)

- Org lấy từ path `/v1/orgs/{orgId}` (không header). `OrgContextMiddleware` (tenancy) đăng ký `forRoutes('v1/orgs/:orgId{/*path}')` — MỘT pattern nên chạy đúng một lần mỗi request — và chạy trước `AppThrottlerGuard`/`IdempotencyInterceptor`, nên tracker throttle và scope idempotency có org thật. Matcher dùng chung `src/modules/tenancy/http/org-route.ts` (`routeTemplateOf`, `classifyOrgRoute`, `isOrgRestoreRequest`) cho middleware, inventory lúc boot và interceptor.
- Mọi lần trượt (org không tồn tại, không phải member, org xoá mềm ngoài route khôi phục, id nil/v4) trả `404 not_found` từ một chỗ, giống hệt nhau trừ `Date`/`X-Request-Id`, không có `X-RateLimit-*`. Limiter "org miss" là bucket `tenancy.org-miss` của `RateLimitBuckets` (core, có chủ tên bucket `<owner>.<name>`, handle không thao tác bucket khác): `peek` trước khi tra, `consume` CHỈ khi trượt thật; lần trúng không bao giờ ghi; lỗi hạ tầng (`503` + `Retry-After`) không bị đếm. Race T-33 (peek ∥ consume) được chấp nhận.
- `PoliciesGuard` route-scoped (gắn bởi `<Catalogue>.require(...)`/`@OrgMemberOnly()`), CASL `Ability` trần; `OrgScopeInterceptor` (`APP_INTERCEPTOR`) chạy handler trong `OrgScope`. Route tenant thiếu metadata, sai tên tham số org, route ghi của tenancy không mang đúng một marker → app không khởi động (`OrgRouteInventory`).
- Mutation tenancy cấp/mở rộng quyền hoặc phá huỷ: `@SensitiveTenancyAction()` = `@SessionOnly()` + `@RequireFreshSession()` + `@RequireVerifiedEmail()`; mutation chỉ thu hồi/thu hẹp: `@NarrowingTenancyAction()` (chỉ `@SessionOnly()`), tập route là hằng `NARROWING_ROUTES` (3A: rời org).
- `PreAuthRateLimiter` viết lại trên bucket `core.pre-auth` (refundable) của `RateLimitBuckets`, hành vi S2-R51/R53 giữ nguyên.
```
`docs/adr/0009-id-strategy.md`:
```markdown
## Cập nhật SP3 (3A) (<ngày>)

- `organizations.id` là **PK UUID v7 sinh ở app** (ngoại lệ có tên với PK `BIGINT`; `CHECK (uuid_extract_version(id) = 7)`): org id là khoá tenant của RLS (`app_current_org()` trả `uuid` từ SP1) và của mọi FK kép. Client không chọn được id (khoá `id` trong body bị bỏ).
- Mọi bảng khác của tenancy: `id BIGINT` nội bộ + `public_id UUID DEFAULT uuidv7()` công khai.
- Một người có hai id: `principal.id` (id `auth."user"` ở local/hybrid, `sub` ở external) chỉ ở API identity, `actor.id` của envelope và log của identity; `tenancy_users.public_id` là `userId` ở MỌI API và `data` của event tenancy (spec SP3 §14).
```
`docs/adr/0010-better-auth-and-auth-modes.md` (trước "## Giới hạn đã biết"):
```markdown
## Cập nhật SP3 (3A) (<ngày>)

- CASL chuyển sang ADR 0017 (không còn "bổ sung SP3" ở đây).
- `PrincipalResolver.ensure(req, res)` idempotent theo request (khoá CLS `identity:principalResolved`): `PrincipalMiddleware` và `OrgContextMiddleware` cùng gọi, xác thực đúng một lần bất kể thứ tự middleware.
- Port identity mở cho tenancy (luật depcruise 18: identity không import tenancy): `OrgCredentialAuthenticator` (API key có tiền tố `oak_`, không phân biệt hoa thường, không bao giờ tới Better Auth; vắng → `REJECTED`), `UserDeletionGuard` (`check` → `ALLOWED | BLOCKED_LAST_OWNER`, `release` → `RELEASED | BLOCKED_RACE`), cả hai `@Global` + `@Optional`.
- `AUTHENTICATED` thêm `authenticatedAt` (session: `createdAt`; external: claim `auth_time`, thiếu → `undefined`, không fallback `iat`), `emailVerified`, `verifiedEmail`. `AuthFacts` (đọc đồng bộ), `@RequireFreshSession()` (`AUTH_SESSION_FRESH_AGE_SEC`), `@RequireVerifiedEmail()` (bất kể `AUTH_REQUIRE_EMAIL_VERIFICATION`). `IdentityDirectory.findUsers` (một query, tối đa `AUTH_DIRECTORY_BATCH_MAX`).
- Xoá user: hook `hooks.before` trên `/admin/remove-user`, `/delete-user`, `/delete-user/callback` (từ chối TRƯỚC khi Better Auth xoá session/account); id đích đọc bằng `adminTargetUserId` (ép kiểu như plugin, UUID chữ thường chuẩn, không đạt → `422`); `databaseHooks.user.delete.before` gọi `release`; `onError` đổi `23001` trên path xoá user (path đọc từ scope của mount) thành `409 user_deletion_blocked` TRƯỚC khi log/đếm 5xx. Mã `user_deletion_blocked` thuộc identity.
- `/api-key/create` với `prefix` bắt đầu bằng `oak_` → `422 validation_failed` (không cho key Better Auth giả dạng org key).
```
`docs/adr/0017-tenancy-own-module.md` — sau mục "Kết quả spike (plan 3A)" (Task 1–3 đã ghi), thêm:
```markdown
## Trạng thái triển khai

- **3A (<ngày merge>):** module `tenancy` (org, member, role hệ thống, catalogue 19 key, pipeline middleware → guard → interceptor, vòng đời org xoá mềm/khôi phục/xoá cứng, bảo vệ owner cuối kể cả khi xoá tài khoản), thay đổi core/identity/notifications của 3A. Giả định yếu nhất (khoá dòng org tuần tự hoá mutation quản trị) được đo ở X-5: 20 mutation đồng thời không deadlock, INSERT của bảng feature có FK tới org không bị chặn.
- 3B, 3C, 3D: chưa.
```

- [ ] **Step 3: README**

`README.md`:
1. Dòng mô tả đầu file: đổi "(core, identity và thông báo email)" thành "(core, identity, thông báo email và tenancy)"; câu "SP2 bổ sung Identity, Notifications và Bull Board;" thêm sau nó: "SP3 (plan 3A) bổ sung Tenancy: org, member, role hệ thống, phân quyền CASL theo catalogue và vòng đời org;".
2. Trong "## Cách thêm", sau mục "### Bảng có RLS", thêm:
````markdown
### Quyền nghiệp vụ và route tenant

Route của một org luôn nằm dưới `/v1/orgs/:orgId/…` (tham số phải tên `orgId`; handler đọc org bằng `RequestContext.orgId()`). Mỗi module khai catalogue quyền của mình, đăng ký bằng marker Discovery, và seed dòng `permissions` bằng migration (app không khởi động nếu catalogue lệch DB):

```ts
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { definePermissionCatalogue, PermissionCatalogueContributor } from '../../modules/tenancy/index.js';

export const BillingPermissions = definePermissionCatalogue('billing-feature', {
  'invoices.read': { resource: 'invoices', action: 'read', requires: [], ownerOnly: false, apiKeyEligible: true, supportEligible: true, grantTo: { admin: true, member: true } },
});
@Injectable() @PermissionCatalogueContributor(BillingPermissions) class BillingCatalogue {}

@Controller('v1/orgs/:orgId/invoices')
class InvoicesController {
  @Get() @BillingPermissions.require('invoices.read') list() { /* chạy trong OrgScope của org trên path */ }
}
@Module({ providers: [BillingCatalogue], controllers: [InvoicesController] })
export class InvoicesModule {}
```
- `grantTo` bắt buộc: quyền mới không tự vào ADMIN/MEMBER; OWNER nhận mọi quyền không deprecated. `ownerOnly` không được cấp cho admin/member.
- Route tenant thiếu `require(...)`/`@OrgMemberOnly()`, hoặc catalogue chưa đăng ký → app không khởi động. Mutation quản trị của tenancy mang `@SensitiveTenancyAction()` (session mới + email đã xác thực) hoặc `@NarrowingTenancyAction()`; mutation nghiệp vụ của `features/` không cần.
- Vòng đời quyền chỉ thu hẹp: deprecate ở bản N (`deprecated: true` + migration đặt `deprecated_at`), xoá ở bản N+1 theo mẫu 7 bước `NO FORCE … FORCE` (ADR 0005); không bao giờ `UPDATE` key tại chỗ.
- Tên constraint theo `<bảng>_<luật>` (tên constraint deferrable phải duy nhất trong schema).

### Bảng tenant và xoá cứng org

Bảng có `org_id` thêm FK `org_id → organizations(id) ON DELETE RESTRICT` và đăng ký một participant xoá dòng của mình khi org bị xoá cứng (quên đăng ký → job purge lỗi `23001`, có alert `tenancy_org_purge_failed_total`, không để dòng mồ côi):

```ts
import { Injectable } from '@nestjs/common';
import { Db } from '../../core/database/index.js';
import { OrgPurgeParticipant, OrgPurgeParticipantContributor } from '../../modules/tenancy/index.js';

@Injectable()
@OrgPurgeParticipantContributor({ key: 'invoices', order: 10 })
export class InvoicesPurge extends OrgPurgeParticipant {
  constructor(private readonly db: Db) { super(); }
  async purge(): Promise<void> {
    await this.db.execute('DELETE FROM invoices WHERE org_id = app_current_org()');
  }
}
```
Participant chạy TRONG transaction purge và chỉ xoá dòng DB; mọi xoá của một org nằm trong một transaction (giới hạn `DB_QUERY_TIMEOUT_MS`). Dọn ngoài DB (object storage…) là job do subscriber của `tenancy.org.purged` enqueue, và job đó phải khai `onInactiveOrg: 'run'` — mặc định `'skip'` bỏ qua mọi job tenant khi org đã xoá mềm hoặc đã mất.
````
3. Trong "### CLI và runbook", thêm các dòng runbook của 3A:
```markdown
- **Org bị bỏ rơi** (owner duy nhất bị ban/mất email): platform admin, có ticket, báo trước 3 ngày, nâng một member lên OWNER bằng SQL trong `OrgScope` của org rồi ghi lại vào ticket.
- **Xoá tài khoản dở dang** (`409 user_deletion_blocked` sau khi Better Auth đã gỡ session/mật khẩu): lý do `MEMBERSHIP_CREATED` → chạy lại `/admin/remove-user`; lý do `LAST_OWNER` → user dùng "quên mật khẩu" để lấy lại đăng nhập, chuyển/nâng owner khác, rồi admin chạy lại.
- **Dòng `scheduled_tasks` mồ côi** không xảy ra (FK `RESTRICT` tới `organizations` + participant `core.scheduled-tasks`); scheduler Redis mồ côi được `SCHEDULER_RECONCILE_CRON` dọn.
- **Đổi `AUTH_MODE`** trên DB đã có `tenancy_users` không được hỗ trợ tự động (subject khác loại: `auth_user_id` ↔ `external_subject`).
- **External:** IdP phải phát claim `auth_time` (OIDC Core §2; client gửi `max_age`), thiếu thì mọi mutation nhạy cảm của tenancy trả `403 reauthentication_required`.
- **Lô migration SP3** giữ khoá tới hết lô (`allOrNothing`): chạy trong cửa sổ ít ghi, có `lock_timeout`.
- **Org purge thất bại lâu dài** chỉ được enqueue lại khi BullMQ đã dọn job `failed` cũ (`QUEUE_KEEP_*`) hoặc retry trên Bull Board; nếu ≥ `TENANCY_ORG_PURGE_BATCH_SIZE × _MAX_BATCHES` org lỗi đứng đầu thứ tự, org sau bị bỏ đói giữa các lượt (log WARN `org_purge_backlog`).
```
4. "## Quy tắc", gạch "Ranh giới import": thêm vào cuối câu: "; `@casl/ability` chỉ trong `modules/tenancy/application/authz` và `modules/tenancy/http`; `modules/identity` và `modules/notifications` không import `modules/tenancy`".
5. Bảng "## ADR": thêm dòng `| [0017](docs/adr/0017-tenancy-own-module.md)      | Module tenancy tự xây + CASL                     |` sau dòng 0016, rồi `pnpm exec prettier --write README.md` (README nằm trong `prettier --check .` của `pnpm lint`; `docs/` bị `.prettierignore` bỏ qua).

- [ ] **Step 4: Kiểm và commit**

Run:
```bash
pnpm lint
git diff --stat
```
Expected: chỉ file tài liệu đổi; lint (gồm markdown nếu có) xanh.
```bash
git add docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md docs/adr README.md
git commit -m "docs: apply the SP3 plan 3A parent-spec amendments; ADR 0005/0006/0007/0009/0010/0017 and README for tenancy"
```

---

### Task 31: Kiểm chứng toàn nhánh, push, một PR cho 3A, CI xanh hoàn toàn

**Files:**
- Không file mới. Sửa bất kỳ file nào cần để pipeline xanh (mỗi sửa là commit riêng có lý do).

**Interfaces:**
- Consumes: mọi task 1–30.
- Produces: nhánh `sp3-tenancy` trên `origin`, một PR `sp3-tenancy → main` với mọi check CI xanh.

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
- `pnpm test:int` gồm `migrations.spec.ts` (up → down → up và sweep từng bước S2-R57 trên database riêng, gồm 4 migration của 3A), `rls-catalog.spec.ts`, `normalization-inventory.spec.ts`, mọi e2e tenancy, `hot-path-explain.spec.ts` (copy khối plan in ra log vào mô tả PR).
- `pnpm test:smoke`: image production thật, `compose --profile app`, `NODE_ENV=production`, log JSON sạch, `/health/ready` 200, teardown sạch.
- Hai lệnh `git diff --exit-code` không có diff (env và OpenAPI đã commit khớp code).
- `pnpm arch`: 3 luật mới (17–19) bắt fixture, cây `src` thật sạch.
Lệnh nào đỏ: tìm nguyên nhân gốc (skill `superpowers:systematic-debugging`), sửa, commit, chạy lại **toàn bộ** Step 1 (không chỉ lệnh vừa đỏ).

- [ ] **Step 2: Kiểm tay trước khi push**

Run:
```bash
git log --oneline origin/main..HEAD
git status --short
git diff --stat origin/main...HEAD
```
Expected: `git status` sạch; commit theo task, message conventional tiếng Anh; không có file spike (`test/integration/spike-sp3a/` không tồn tại), không file tạm, không secret. Kiểm lại timestamp migration SP3 vẫn lớn hơn migration mới nhất trên `origin/main` (`git fetch origin main` trước, `migration-order.spec.ts` đã chạy trong `pnpm test`; `main` đổi trong lúc làm thì rebase, đổi timestamp migration của 3A bằng cách tạo lại file qua CLI, chạy lại Step 1).

- [ ] **Step 3: Push và mở PR**

Run:
```bash
git push -u origin sp3-tenancy
gh pr create --base main --head sp3-tenancy --title "SP3 plan 3A: tenancy foundation" --body-file "$TMPDIR/sp3a-pr.md"
```
Nội dung `$TMPDIR/sp3a-pr.md` (viết file trong scratchpad, không commit):
```markdown
## SP3 plan 3A — tenancy foundation

Spec: docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md (r8, §22.3 Bảng 1–5, dòng 3A)
Plan: docs/superpowers/plans/2026-09-28-sp3a-tenancy-foundation.md
ADR: 0017 (mới, kết quả spike T1–T6, T8), 0005, 0006, 0007, 0009, 0010, 0013 (dòng "SP3 (3A)")

### Nội dung
- core: `orgAccess`, `RateLimitBuckets` (+ `core.pre-auth`, `tenancy.org-miss`), `JobDef.onInactiveOrg` + `OrgActivityGate`, `scheduled_tasks.suspended_at` + API scheduler
- identity: `PrincipalResolver` idempotent, `AuthFacts`, `@RequireFreshSession`/`@RequireVerifiedEmail`, `UserDeletionGuard` + hook trên mọi đường xoá user, `onError` 23001, chặn prefix `oak_`, `findUsers`, `AUTH_DIRECTORY_BATCH_MAX`
- notifications: bảng tra cứu `email_templates`
- tenancy: 6 bảng, RLS FORCE, trigger owner cuối/bootstrap/khôi phục/role hệ thống, 6 hàm definer của `tenancy_definer`, catalogue 19 key, CASL `Ability` trần, pipeline middleware → guard → interceptor, route org/member/role/permission, xoá mềm/khôi phục/xoá cứng theo con trỏ

### Kiểm chứng (lệnh và kết quả thật)
<dán output tóm tắt của từng lệnh Step 1: số test pass theo project, thời gian>

### EXPLAIN (ANALYZE, BUFFERS) đường nóng — 10 000 org × 20 member
<dán khối plan do hot-path-explain.spec.ts in ra>

### Image (ADR 0013)
<chưa nén / nén / chênh so với SP2 / phần @casl/ability — đúng số đã ghi ở Task 29>

### Rủi ro còn lại
- Race T-33 (peek ∥ consume của limiter org-miss) được chấp nhận: lọt tối đa bằng độ đồng thời của principal, vẫn chỉ trả 404.
- Xoá tài khoản có thể dừng giữa chừng với 409 sau khi Better Auth đã gỡ credential (runbook trong README).
- Xoá cứng một org là một transaction (giới hạn `DB_QUERY_TIMEOUT_MS`).
```
Thay ba khối `<…>` bằng output thật của Step 1 và số của Task 29 trước khi chạy `gh pr create` (đây là dữ liệu của lần chạy, không phải chỗ trống của plan).

- [ ] **Step 4: Chờ CI, sửa tới khi xanh**

Run: `gh pr checks --watch`
Expected: mọi check xanh (checks gồm lint/arch/typecheck/unit, integration, env drift, openapi + oasdiff chỉ thêm, migration order với `fetch-depth: 0`, build image). Check đỏ: `gh run view <id> --log-failed`, tìm nguyên nhân gốc, sửa, commit, push, chờ lại. Không `--no-verify`, không tắt check, không đánh dấu flaky để qua.

- [ ] **Step 5: Báo cáo**

Báo Sếp: link PR, danh sách check xanh (`gh pr checks`), số test theo project, số đo image, rủi ro còn lại, việc chuyển sang 3B. Không merge (merge là quyết định của Sếp).

---

## Self-review

### 1. Độ phủ spec (Bảng 1 và Bảng 3 của spec §22.3, dòng 3A)

| Hạng mục 3A của spec | Task |
|---|---|
| Spike T1–T6, T8 (kết quả vào ADR 0017) | 1, 2, 3 |
| §5.2 core: `orgAccess` + log | 5 |
| §5.2 core: `RateLimitBuckets` (`core.pre-auth`, `tenancy.org-miss`) | 5, 22 |
| §5.2 core: `JobDef.onInactiveOrg`, `OrgActivityGate` (lý do, WARN), gate của tenancy ở `forWorker()` | 6, 20, 25 |
| §5.2 core: `scheduled_tasks.suspended_at` + API scheduler | 7, 16, 23 |
| §5.2 identity: `PrincipalResolver` (+ `oak_` → port, vắng → `REJECTED`), field `AUTHENTICATED` | 9 |
| §5.2 identity: `AuthFacts` + hai decorator, `findUsers`, `AUTH_DIRECTORY_BATCH_MAX` | 10 |
| §5.2 identity: `UserDeletionGuard` + hook mọi đường xoá (`adminTargetUserId`, UUID chữ thường), `user_deletion_blocked`, `onError` 23001 (path từ scope của mount), prefix `oak_` | 11, 12, 26 |
| §5.2 notifications: bảng `email_templates` | 8 |
| §5.3 (trừ 3D): `migrations.spec.ts` DB riêng, `tenancy-seed.ts`, `tenancy-principals.ts`, test SP1/SP2 phải sửa | 4, 10, 14, 16 |
| §6.2–6.6 bảng, trigger bootstrap/restore/role hệ thống/owner cuối, seed 19 key | 13, 14 |
| FK + trigger T-32 trên `scheduled_tasks` | 16 |
| 6 hàm definer | 15 |
| §6.12 chuẩn hoá, §6.13 phần 3A (thứ tự, down, sweep, quét tĩnh) | 4, 7, 8, 13, 16 |
| §7 pipeline (middleware, 404 thống nhất, limiter, guard, interceptor, inventory boot) | 21, 22, 23 |
| §8.1–8.3, §8.7 catalogue, role hệ thống, CASL trần | 17 |
| §8.4 luật 2, 2a (theo tập), 3, 4, 5 | 18, 24 |
| §8.6 khoá, đọc lại actor | 23 (`ActorReauthorizer`), 24 |
| §8.8 đồng bộ catalogue + kiểm boot + Discovery (catalogue, participant) | 19 |
| §9 `MemberAdmission` (`CREATOR`), §9.4, §9.5, §9.6 (không chuyển quyền/key) | 23, 25, 26 |
| §11 ba mode | 27 |
| §12 route 3A, hai marker, `NARROWING_ROUTES`, G-8 | 21, 23, 24, 27 |
| §13 config 3A | 19 |
| §14 event org/member, §15 lỗi, §16 metric/span/log (gồm `tenancy.policy.check`, `tenancy.member.admit`) | 19, 21, 22–26, 28 |
| §18.6 luật 17–19 | 19 |
| §18.1: catalog, isolation 4 bảng, definer, ràng buộc DB, `FOR NO KEY UPDATE` không chặn INSERT con, lịch org xoá mềm, X-9, X-10, tên deferrable duy nhất | 4, 13, 14, 15, 16, 20, 25 |
| §18.2: 404 thống nhất, limiter, `org_context_invalid` + chữ hoa, throttle/idempotency có org, key user `403`, `oak_x` `422`, T6, G-1/G-8 boot fail, catalogue lệch/trùng, `GET /v1/orgs`, `members/me`, session mới + email, ba mode | 11, 19, 21, 22, 23, 24, 27 |
| §18.3: U1–U14, U16, U18 | 17 (U1–U10, U12, U13, U16), 18 (U11), 21 (U14), 9 (U18) |
| §18.3: B-4, B-5, B-6, B-8, B-9, B-18 | 18 (unit), 24 (E2E) |
| §18.3: O-1–O-5 (O-2b), O-9, O-10, O-11, O-13, O-14, O-15, O-17–O-20 | 14 (O-3, O-13, O-14), 24 (O-1, O-4, O-5, O-9, O-10, O-15), 26 (O-2, O-2b, O-11, O-17, O-18, O-19, O-20) |
| §18.3: X-4, X-5 (role hệ thống), X-6, X-7, X-11 (khôi phục/purge) | 24, 20, 26, 25 |
| §18.3: G-1–G-8 | 21, 22, 23, 27 |
| §18.3 "vòng đời": xoá mềm → 404, lịch treo/khôi phục, khôi phục, purge qua `JobQueue` thật (nhiều lô, participant quên) | 23, 25 |
| §18.4: chaos (tra membership, timeout, Redis, giết worker giữa purge), PII, smoke 3A, số đo image ADR 0013 | 28, 29 (smoke từng nhóm: 8, 12, 16, 26, 29) |
| Tiêu chí 11 (giết api giữa handler và commit: không event mồ côi, không thay đổi thiếu event) | 28 (`tenancy-api-kill.spec.ts`) |
| Tiêu chí 12 (DB lỗi → 503 trên mọi thao tác tenancy: tra membership, mutation trên path org, `POST /v1/orgs`) | 28 (`tenancy-outages.spec.ts`) |
| §18.5: chuẩn hoá, quét migration, Discovery hai module | 4, 13, 19 |
| §22.1 ADR 0005/0006/0007/0009/0010/0013/0017, README; §22.2 amendments dòng 3A/3A+ | 29, 30 |
| Tiêu chí 17: pipeline xanh, kiểm route + catalogue < 200 ms, push + PR + CI xanh | 23 (đo), 31 |

Chạy sớm hơn spec yêu cầu (không hại, ghi để 3B không viết lại): U15 và biến thể B-22 trên role hệ thống ở Task 18 (spec đặt U15 ở 3B); 3B mở rộng cùng generator với role tuỳ biến.

### 2. Race của 3A (spec Bảng 2) → cơ chế → test

| Race | Cơ chế | Test (task) |
|---|---|---|
| T-1 hai owner hạ/xoá/rời nhau | khoá org `FOR NO KEY UPDATE` mọi mutation quản trị + trigger hoãn `org_members_last_owner_ck` tự khoá org | O-4, O-5 (24), O-13 (14) |
| T-6 tạo org vượt giới hạn | khoá `tenancy_users` của người tạo trước khi đếm (`tenancy_count_orgs_created_by`) | T-6 ×10 (23) |
| T-7 single-org, hai lần join song song | khoá `tenancy_users` rồi `tenancy_count_user_orgs` trong `MemberAdmission` | T-7 ×10 (23) |
| T-10 actor bị hạ giữa guard và handler | `ActorReauthorizer` đọc lại actor `FOR SHARE` dưới khoá org, kiểm lại cửa | X-4 (24) |
| T-12 xoá mềm đua mutation quản trị | cả hai khoá org; mutation kiểm `deleted_at` sau khoá | T-12 ×10 (23), O-10 (24) |
| T-13 khôi phục đua xoá cứng | cả hai khoá org; `clock_timestamp()` so `purge_after` sau khoá | T-13 ×10 (25) |
| T-14 hai job purge cùng org | `jobId = tenancy-purge-<orgId>` + khoá org + no-op khi org mất | T-14 (25) |
| T-18 (tất định) xoá tài khoản đua membership mới | `hooks.before` + `release` + FK `RESTRICT` (`org_members_user_fk`, `tenancy_users_auth_user_fk`) + `onError` 23001 | O-19, O-20 (26), race tạo org (26) |
| T-22 xoá quyền khi pod cũ còn chạy | deprecate (N) → xoá (N+1); `CatalogueCheck` chặn boot; `UnknownPermissionError` fail loud | U13 (17), `CatalogueCheck` (19) |
| T-23 org thiếu role/owner | một transaction + trigger hoãn `organizations_bootstrap_ck` | (14) |
| T-24 deadlock mutation quản trị / `DELETE tenancy_users` | thứ tự khoá cố định; gỡ `created_by_user_id` dưới khoá org; `UnitOfWork` retry `40P01` | X-5 (24), race xoá tài khoản ∥ tạo org (26) |
| T-25 hai request đầu cùng subject | `INSERT … ON CONFLICT (<cột>) DO NOTHING` + `SELECT … FOR NO KEY UPDATE`; `TenancyUserVanishedError` | X-6 ×20 (20) |
| T-26 xoá tài khoản đua purge | `release` khoá org, org mất → bỏ qua | X-7 (26) |
| T-28 SQL trực tiếp không khoá org | trigger owner cuối tự khoá org | O-13 ×50 (14) |
| T-32 lịch tạo trong/sau xoá mềm | trigger `scheduled_tasks_suspend_if_org_deleted` (`FOR SHARE` dòng org) | X-9 (16) |
| T-33 nhiều lần trượt lọt `peek` | chấp nhận (có tên): lọt ≤ độ đồng thời, sau đó bị khoá | (22) |
| T-34 job tenant đã trong queue sau xoá mềm | `OrgActivityGate` khi job bắt đầu; `'run'` cho job vòng đời | X-10 (25), (6) |
| T-36 xoá owner A đua owner B rời | `release` trả `BLOCKED_RACE { LAST_OWNER }` (trigger lúc commit) | O-18 (26) |

### 3. Quét chỗ trống

`<ts>` trong tên migration là quy ước của plan (tên do CLI sinh, Global Constraints). Các `<…>` còn lại là **dữ liệu của lần chạy**, không phải thiết kế còn thiếu: số đo image (Task 29 Step 3, chỉ commit sau khi đo), ngày áp/merge (Task 30), output kiểm chứng và plan EXPLAIN trong mô tả PR (Task 31). Không còn "TBD", "tương tự Task N", hay bước mô tả mà không có code.

### 4. Nhất quán tên và kiểu

- Port/lớp dùng xuyên task: `OrgRepository` (`lockCurrent`, `clockNow`, `softDelete`, `restore`, `detachCreator`, `purgeCurrent`, 6 lời gọi definer), `MemberRepository` (`lockForShare`, `findByUserId`), `TenancyUserRepository.upsertAndLock`, `SubjectResolver.of`, `ActorReauthorizer.require`, `MemberAdmission.admit`, `OrgLifecycleService.softDelete/restore({ kind })`, `PurgeOrgHandler`/`PurgeOrgsHandler`, `UserDeletionService` — định nghĩa ở task nêu trong "Produces" và dùng đúng chữ ký ở task sau.
- `TenancyPermissions` (Task 21) là đối tượng đăng ký vào registry; `TENANCY_CATALOGUE` (Task 17) chỉ là dữ liệu thuần dùng cho test domain và để dựng `TenancyPermissions`.
- Hằng: `ORG_ROUTE_PATTERN`, `ORG_RESTORE_TEMPLATE`, `NARROWING_ROUTES`, `MARKER_EXEMPT_ROUTES` (`http/policy-metadata.ts` + `org-route.ts`), `PURGE_CURSOR_START`, `DEFINER_LIMIT_MAX`, `ORG_NAME_MAX_LENGTH` (`constants.ts`), `ORG_API_KEY_PREFIX` (identity).

### 5. Lệch có chủ đích so với tên trong spec

- Spec gọi thứ tự xoá cứng dùng chung là `sql-org-purge.repository.ts`; plan dùng `infra/sql/org-purge.sql.ts` (`ORG_PURGE_STATEMENTS`) cộng `SqlOrgRepository.purgeCurrent()`: cùng một nguồn cho job purge và `seedOrg().dispose()`/`purgeOrgs()` như spec đòi.
- `definePermissionCatalogue` ở `http/decorators.ts` thay vì `domain/catalogue.ts` (lý do ở File Structure: luật `domain-pure`); public API không đổi.
- `GET /v1/orgs` trả `OrgListItem` (đúng các cột của `tenancy_list_user_orgs`, chữ ký cố định ở spec §6.14, không có `createdAt` của org) cộng membership của chính người gọi; chỉ sắp theo thời điểm tham gia tăng dần.
- Id resource không phải UUID ở path con (`:memberId`, `:roleId`) trả `404` (không `400`), cùng tinh thần 404 thống nhất.
- Event xoá member mang `aggregate.version = version + 1` (dòng đã mất, quy ước "version sau thay đổi").

### 6. Hạng mục 3A chưa đặt được

Không có. Các ca §18 gắn nhãn 3D (org key trên `/v1/me`, key hợp lệ của org khác, `api-keys/mine`) và 3C (preview/accept/link) không thuộc 3A; allowlist hai route preview đã có sẵn ở `MARKER_EXEMPT_ROUTES` để 3C không phải sửa luật G-8.

### 7. Giả định còn phải kiểm khi thực thi (yếu nhất trước)

1. **Thứ tự middleware theo độ sâu module** (`nestedIn`, T6): test `the chosen order really happened` khẳng định bằng `invocationCallOrder` của spy gắn lên prototype TRƯỚC khi dựng app (Nest bind `use` một lần lúc init, review I5); nếu `DEEPER = 3` chưa đảo được thứ tự, tăng độ sâu (Task 22).
2. **Scope idempotency của SP1 gồm org của context** (ADR 0007, spec §7.1): test B/C của `org-scoped-throttle.e2e.spec.ts`; đỏ thì dừng và báo, không sửa core ngoài phạm vi.
3. **Better Auth 1.7.6 tạo lại account `credential` khi reset mật khẩu cho user đã mất account** (O-18, spec §9.6 dẫn `password.mjs:161`).
4. **Express 5.2.1 điền `req.params.path`** đúng như spec §7.4 đo (unit `org-route.spec.ts` chạy router thật; lệch ở `/` cuối thì sửa kỳ vọng, `isOrgRestoreRequest` vẫn đúng vì bỏ segment rỗng).
5. **Guard của `UseGuards` được Nest khởi tạo như injectable của module chứa controller** (lý do `TenancyCoreModule` là `@Global`; test inventory dựng `GuardDeps` toàn cục cho đúng điều này).
6. **Phát hiện job purge / mutation của api đang chờ khoá qua `pg_locks`** (chaos Task 28, `tenancy-purge-kill.spec.ts` và `tenancy-api-kill.spec.ts`): điều kiện `NOT granted` trên `transactionid`/`tuple`; chờ tối đa 60 s. Với api bị SIGKILL, giả định thêm: PgBouncer (transaction mode) đóng connection server của client đã chết khi transaction còn mở, nên Postgres rollback (nếu không, ca đỏ ở `orgName = BEFORE` hoặc `updatedEvents = []`, không xanh giả).
7. API đã đối chiếu với code/tarball trong lúc viết plan (không còn là giả định): `DiscoveryService.createDecorator`/`getControllers({ include })` (`@nestjs/core` 12.1 `.d.ts`), `assertEnqueueOpts`, `QueueStats { queue, waiting }`, `SafeEnqueue.enqueue`, `EventSubscriber({ consumer, event })`, `JobContext.meta`, `mergePatchSchema` từ chối `null` ở member không nullable, `z.uuid()` nhận UUID nil, ENTRYPOINT distroless `/nodejs/bin/node`, `DB_AUTH_HOST` tách khỏi `DB_HOST`, `docs/` trong `.prettierignore`, `WORKER_QUEUES` rỗng = mọi queue đã đăng ký (worker production tiêu thụ `maintenance`, nơi có `tenancy.org.purge`). Đối chiếu thêm khi sửa theo review (2026-09-29): `Injector.loadMiddleware` dựng middleware trong container riêng và `middleware-module.js` bind `instance.use` một lần lúc init (`@nestjs/core` 12.1); `DiscoveryModule` không `@Global`; `Paginator` chỉ có `private readonly cfg`; `cronRegistry` chỉ export ở `core/scheduler/cron-definition.ts`; `WorkerHost.assertHandlersFor` đòi handler cho mọi job của queue được consume; `defineQueue` export từ `core/queue/index.ts`; `NestApplicationContext.get` mặc định `strict: false`; `new PgIdentityDirectory(pool)` ở `auth-hooks.spec.ts:182`, `:1487`; `buildAuthOptions({...})` ở `test/integration/identity/auth-options.spec.ts:31`.

### 8. Sửa theo review plan 3A (2026-09-29)

Review trước khi thực thi tìm 1 Critical, 10 Important, 7 Minor; đã sửa hết trong plan. Task 1–3 đã commit và Task 4 đang làm nên không đổi yêu cầu của Task 1–4; ở Task 4 chỉ sửa chữ của Produces cho khớp (M6).

| Mã | Chỗ sửa | Sửa gì |
|---|---|---|
| C1 | Task 22 (`org-context.middleware.ts`, `tenancy-http.module.ts`), Task 23 (module) | Đăng ký bucket `tenancy.org-miss` chuyển sang provider singleton `orgMissBucketProvider` (token `ORG_MISS_BUCKET`); middleware inject handle, constructor không side effect; bỏ `OrgContextMiddleware` khỏi `providers`. Thêm `tenancy-http-boot.e2e.spec.ts`: app boot và bucket đăng ký đúng một lần. |
| I1 | Task 11 (`deletionPrecheck`, e2e), Task 12 (chú thích smoke) | Kiểm dạng `userId` của `/admin/remove-user` → `422` không phụ thuộc guard; chỉ `check()` cần guard. Thêm `describe` không guard vào `user-deletion-precheck.e2e.spec.ts`. Smoke Task 12 giữ nguyên kỳ vọng `422`. |
| I2 | Task 10 | Thêm `test/integration/identity/auth-hooks.spec.ts` vào Files; hai lời gọi `new PgIdentityDirectory(…, identityConfig())`; chạy `pnpm typecheck` ở Step 5. |
| I3 | Task 12 | Thêm `test/integration/identity/auth-options.spec.ts` vào Files; `onUserDeletionBlocked: () => undefined`. |
| I4 | Task 5 (JSDoc `RateLimitBucket`), Task 22, Task 28 | Giữ ngữ nghĩa `peek` (`> limit`); ghi hợp đồng vào JSDoc; test đổi thành `LIMIT + 1` lần `404` rồi `429` (limiter e2e, cả hai describe chaos). |
| I5 | Task 22 (`middleware-order.ts`) | Spy `use` gắn trong `beforeAll` trước `startTenancyApp`, `mockClear` trước request, `mockRestore` ở `afterAll`. |
| I6 | Task 23 (`TenancyHttpModule`) | `imports: [DiscoveryModule]`. |
| I7 | Task 24 (`MembersController`) | Inject `paginationConfig.KEY`, dùng `cfg.totalCountCap` thay `this.pages.totalCountCap`. |
| I8 | Task 25 (`org-purge.spec.ts`) | Consumer là `bootstrapWorker(AppWorkerModule)` (đủ handler cho `maintenance`); producer dùng `tenancyCoreImports()`; cron purge đặt `0 0 1 1 *` trong test để không tự chạy. |
| I9 | Task 25 X-10 | Queue riêng `x10-fixture` (`defineQueue`), `WORKER_QUEUES=events,maintenance,x10-fixture`; bỏ import `FixtureQueue`. |
| I10 | Global Constraints, Task 8 (chú thích), Task 16, Task 26, Task 29 | Smoke prod-like ở cuối Task 16 (schema tenancy + hàm definer chạy từ `dist`) và Task 26 (xoá tài khoản có guard: `409`, `422`, `200` sau xoá mềm); luồng smoke của Task 29 kết thúc bằng xoá tài khoản bị chặn rồi được phép. |
| M1 | Task 25 (`jobs.spec.ts`) | Import `cronRegistry` từ `core/scheduler/cron-definition.js`. |
| M2 | Task 14 (`seed-helper.spec.ts`) | Seed ở `a` trước `b` để `a.dispose()` đi nhánh `23001`; dọn dòng user dùng chung cuối ca. |
| M3 | Task 18 (U15), Task 9 (e2e `oak_`) | U15 bỏ vế tautology, thêm khẳng định "tập chứa A thì tương đương admin"; e2e `oak_` khẳng định một điểm pre-auth, không hoàn điểm, không gọi `AuthProvider.authenticate`. |
| M4 | Task 21 (`PoliciesGuard`), Task 23 (`MemberAdmission`), Task 28 (`telemetry-pii`) | Span `tenancy.policy.check` (`tenancy.policy.result`), `tenancy.member.admit` (`tenancy.member.source`); e2e khẳng định có span và attribute là enum. |
| M5 | Task 28 | Tiêu chí 11: `tenancy-api-kill.spec.ts` (SIGKILL api khi rename chờ khoá org trong transaction). Tiêu chí 12: hai ca mới trong `tenancy-outages.spec.ts` (DB mất sau guard, trong transaction rename → `503`; `POST /v1/orgs` lúc DB mất → `503`). |
| M6 | File Structure, Task 4 Produces | Bỏ dòng sửa `composition.config.ts`; Produces của Task 4 nói ca "down bị chặn" ở `suspended-at-down.spec.ts` của Task 7. |
| M7 | Task 30 Step 1 | Áp amendments theo thứ tự dòng trong file (B19–B21 trước B17, B18). |

Không có finding nào bị bỏ qua.
