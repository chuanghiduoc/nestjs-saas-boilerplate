# Sub-project 2 — Identity + thông báo email: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm `src/modules/identity` (Better Auth 1.7.6 sau port `AuthProvider`: email/password, xác thực email, quên mật khẩu, cookie session, bearer, 2FA, API key, JWT/JWKS, platform admin, `AUTH_MODE` `local`/`hybrid`/`external`), `src/modules/notifications` (email giao dịch qua queue, state machine có lease và fencing) và Bull Board read-only trong worker, cùng các thay đổi tối thiểu ở `core/`. Mọi tiêu chí phải được chứng minh bằng test trên Postgres 18 + PgBouncer + Redis + Mailpit thật, và bằng smoke test chạy image production thật qua `docker compose` với `NODE_ENV=production`.

**Architecture:** Identity là module nền theo ports & adapters: Better Auth, Kysely, `pg` chỉ nằm trong `identity/infra/better-auth/**` (Better Auth được tự mount bằng một middleware Nest, không dùng `@thallesp/nestjs-better-auth` — quyết định ở Task 1), `jose` chỉ trong `identity/infra/jwks/**`. Credential được nhận diện và kiểm CSRF **trước** handler (middleware), principal nằm trong CLS trước guard rate limit của SP1. Dữ liệu identity nằm ở schema `auth` với role `auth_user` và pool `pg` riêng; token OAuth được mã hoá bằng `FieldCipher` qua một DBAdapter bọc. Notifications chỉ ghi DB + enqueue ở api; renderer, SMTP và handler chỉ có ở worker. Event `identity.user.registered` dùng marker bền trên dòng user cộng cron đối soát; email dùng generation bền trong DB cho đối soát.

**Tech Stack:** NestJS 12 (ESM, Express 5), better-auth 1.7.6 (+ `@better-auth/api-key`, `@better-auth/kysely-adapter` 1.7.6, CLI `auth` 1.7.6), raw-body 3.0.2 (parser JSON giới hạn theo stream), kysely 0.29.6, pg 8.23.0, jose 6.2.12, nodemailer 10.0.10, mjml 5.4.1, handlebars 4.7.9, `@bull-board/api` + `@bull-board/express` 9.10.1, rate-limiter-flexible 11.2.1 (`RateLimiterPostgres`), uuid 14.0.2 (`v5`, `v7`), Mailpit v1.31.2, Vitest + Testcontainers, smtp-server (SMTP giả cho test), otpauth (TOTP trong test).

**Spec:** `docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md` (đã duyệt; ràng buộc). Spec cha: `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md` (luật chuẩn hoá bắt buộc ở §4). Nguồn version và API: `.superpowers/sp2-research.md` và Phụ lục A của spec. Mẫu định dạng: `docs/superpowers/plans/2026-09-25-sp1-core-job-infrastructure.md`.

## Global Constraints

Giữ nguyên mọi ràng buộc của plan SP1, cộng các luật của SP2:

- **Cấm hard code:** giá trị tuỳ chỉnh (timeout, TTL, giới hạn, batch, cron, retention, URL, origin, port, tên header/cookie) chỉ khai báo trong config schema zod của module sở hữu (`defineConfig`), mỗi giá trị có env var và `.describe()`. Secret không có default. Định danh (tên queue, job, event, mã lỗi, tên template, tên cột) là hằng số có tên. `test/unit/architecture/hardcode-scan.spec.ts` phải xanh.
- **Cài package:** trước mỗi lần cài chạy `pnpm view <tên> dist-tags peerDependencies`, rồi `pnpm add <tên>` **không ghi version** (save-exact và `minimumReleaseAge` 1440 phút của SP1 vẫn áp dụng). Version mong đợi ở spec §5.2; lệnh cài ra version khác thì dừng, đọc changelog, cập nhật spec và báo Sếp. Ngoại lệ có tên, lấy đúng từ output của `pnpm view`: `better-call`, `@better-auth/utils`, `@better-auth/core` cài đúng version mà `peerDependencies` của `@better-auth/api-key@1.7.6` ghi; `pg@8.23.0` và `kysely@0.29.6` là bản đang có trong cây (chuyển thành dependency trực tiếp). `better-auth`, `auth`, `@better-auth/*` (trừ `utils`) luôn cùng version.
- **Không cài:** `@bull-board/nestjs`, `@better-auth/redis-storage`, `@better-auth/sso`, `@better-auth/cli`, `@types/nodemailer`.
- **Generator/CLI có sẵn:** `nest g module|service|controller|guard|middleware --no-spec` cho khung Nest; `pnpm exec mikro-orm migration:create --blank --path src/migrations/<module> --name <tên>` cho migration; `pnpm exec auth generate` (CLI `auth` 1.7.6) cho schema Better Auth; `pnpm exec auth generate-secret` cho secret dev; `docker buildx imagetools inspect` cho digest image. Không đoán flag: chạy `--help` trước.
- **Ưu tiên có sẵn:** tính năng của framework/thư viện → package được bảo trì tốt → chỉ tự viết khi không có lựa chọn đạt, kèm lý do trong ADR.
- **Truy cập SQL:** chỉ qua `Db.execute` (connection `app`, `app_user`), `RelayDb` (connection `relay`, `app_relay`) hoặc **pool `auth_user`** (`AuthPool`, chỉ trong `identity/infra/better-auth/**`). Không bao giờ `getConnection().execute`. Không gọi I/O ngoài (SMTP, HTTP, Redis) bên trong `UnitOfWork.run`.
- **Kiểu:** không `any`, không `as never`, không cast mù, không tắt lint (`// oxlint-disable`, `@ts-expect-error`, `@ts-ignore`). Thu hẹp kiểu bằng type guard hoặc zod. Chỗ thư viện buộc phải có một assertion thì chỉ đặt ở đúng một hàm biên, có chú thích lý do (mẫu `RequestContext.read`).
- **TDD:** mỗi task: test fail trước → code tối thiểu → test xanh → commit. Integration/e2e chạy trên hạ tầng thật (`pnpm test:int`), không mock Postgres/Redis/Mailpit.
- **Luật kiến trúc** (`.dependency-cruiser.cjs`, mỗi luật có fixture phải fail): giữ 9 luật SP1 và thêm luật 10–16 của spec §7: better-auth/`@better-auth/*`/`kysely` chỉ trong `src/modules/identity/infra/better-auth/**`; `pg` chỉ trong đó và `src/core/database/**`; `jose` chỉ trong `src/modules/identity/infra/jwks/**`; `nodemailer`/`mjml`/`handlebars` chỉ trong `src/modules/notifications/infra/**`; `@bull-board/*` chỉ trong `src/core/queue/dashboard/**`; `express` thêm ngoại lệ `src/core/queue/dashboard/**`; `rate-limiter-flexible` thêm ngoại lệ `src/modules/identity/infra/better-auth/**`; `modules/notifications/**` không import `modules/identity/**`; `auth.cli-config.ts` thuộc ngoại lệ `no-orphans`.
- **DB:** PK `BIGINT GENERATED ALWAYS AS IDENTITY` (bảng của mình), thời gian `TIMESTAMPTZ`, enum là `TEXT + CHECK`, mọi index có query dùng nó, grant theo từng bảng trong migration. Migration tạo bằng CLI, viết SQL bằng `addSql`, luôn có `down`; `test/integration/core/database/migrations.spec.ts` (up → down 0 → up) phủ mọi migration mới.
- **Chuẩn hoá (3NF/BCNF, luật bắt buộc của spec cha §4):** task nào tạo hoặc sửa bảng phải chép **bảng chuẩn hoá** (khoá ứng viên, phụ thuộc hàm không tầm thường, dạng chuẩn, ngoại lệ + cơ chế giữ nhất quán) của spec §5.16 vào chú thích đầu file migration, cập nhật nó trước khi viết SQL nếu có cột mới, và thêm ràng buộc ở DB (`CHECK`, `FOREIGN KEY`, `UNIQUE`, `NOT NULL`, grant theo cột). Test catalog so cột thật với danh sách đã phân tích (`test/integration/core/database/normalization-inventory.spec.ts`).
- **Cookie là đường chính của web**, không phải JWT. Request mang hơn một credential → `400 ambiguous_credentials`. Mọi request thay đổi trạng thái xác thực bằng cookie phải qua kiểm CSRF (`Origin` khớp chính xác, hoặc `Sec-Fetch-Site: same-origin`).
- **Không lộ PII/secret:** không log email, token, cookie, mật khẩu, địa chỉ SMTP; lỗi SMTP chuẩn hoá thành `MailSendError` trước khi log/ném; `message` của Better Auth không bao giờ vào `detail`.
- **Kiểm chứng prod-like (Sếp yêu cầu, bắt buộc):** ở cuối mỗi nhóm tính năng (Task 17 nền core, Task 43 auth + email, Task 46 Bull Board, Task 50 cuối) phải build **image production thật** bằng `docker build` với build-arg từ `docker/images.env`, chạy `docker compose --profile app` với hạ tầng đầy đủ và `NODE_ENV=production`, migrate, chạy smoke test HTTP thật trong `test/smoke/` (`pnpm test:smoke`), kiểm log container (không PII, không lỗi) và `/health/ready`, rồi `docker compose --profile app down -v`. Env của smoke sinh từ `.env.example`/`.env.infra.example` (`pnpm env:example`) cộng ghi đè của smoke, và preflight fail sớm với tên biến thiếu (Task 17).
- **Nới lỏng cho localhost (chốt, không có cờ bỏ qua luật trong code):** không có luật production nào bị tắt trong code. Smoke thoả mọi luật production bằng hạ tầng TLS cục bộ: (1) chứng chỉ do một CA tạm sinh trong container (`openssl` của image Postgres), tin cậy qua `NODE_EXTRA_CA_CERTS` và `DB_SSL_CA_PATH` thay vì CA công khai; (2) không có ingress TLS: smoke client gọi thẳng cổng HTTP của container api (đóng vai ingress đã terminate TLS), `AUTH_BASE_URL=https://localhost` vẫn là `https`, link trong email được smoke đổi sang `http://127.0.0.1:<cổng>` trước khi gọi; client Node không áp thuộc tính `Secure` của cookie nên cookie `__Secure-` vẫn gửi được qua HTTP nội bộ; (3) Redis dùng user ACL `+@all` duy nhất; (4) `QUEUE_DASHBOARD_IP_ALLOWLIST` là subnet của mạng compose smoke (`SMOKE_SUBNET`, override được, preflight báo trùng mạng); (5) smoke dùng superuser Postgres (`docker compose exec postgres psql`) chỉ để nâng user thành admin và để thu hồi/cấp lại grant khi thử `503`. Mọi thứ khác (Secure cookie, rate limit bật, DB `verify-full`, `rediss://` + ACL, SMTP STARTTLS bắt buộc + `rejectUnauthorized`) chạy đúng như production.
- **Spike:** code spike là code bỏ đi (thư mục `test/integration/spike-sp2/`, không commit), trừ phần task ghi rõ "được giữ". Mỗi spike kết thúc bằng mục kết quả trong `docs/adr/0010-better-auth-and-auth-modes.md` (số đo vào ADR 0013) và được commit.
- **Commit:** mỗi task một commit trở lên, conventional message. Không push, không mở PR khi chưa có lệnh của Sếp.

## Review Focus

Năm điều kiện spec ngầm đòi hỏi nhưng không có test nào ở spec phủ, dễ gây lỗi cho người dùng nhất:

1. **Email khác hoa thường hoặc có khoảng trắng** (`User@Example.com `, `user@example.com`): đăng ký lần hai phải được coi là "email đã có" (202 giống hệt, không tạo dòng thứ hai), đăng nhập và khoá tài khoản dùng chung một khoá, nên kẻ tấn công không lách lockout bằng cách đổi hoa thường. Test: Task 31 (`same lockout key for case and whitespace variants`), Task 34 (`emails are normalized before Better Auth validates them`, chuẩn hoá ở `hooks.before` cho sign-up/sign-in/quên mật khẩu/gửi lại xác thực/đổi email), Task 38 (`re-registering with a differently cased email is indistinguishable and creates no row`).
2. **Header credential rỗng hoặc chỉ có khoảng trắng** (`Authorization: Bearer `, `x-api-key: `, cookie session rỗng): phải bị coi là credential có mặt nhưng sai (`400`/`401`), không bao giờ âm thầm thành ẩn danh rồi lọt vào route `@PublicRoute()` như người lạ, và không làm lệch luật đa credential. Test: Task 30 (`empty or blank credentials are present-but-invalid, never anonymous`), Task 37 (`a present-but-invalid credential is 401 even on a @PublicRoute`).
3. **`callbackURL`/`redirectTo` không tin cậy** trong đăng ký, gửi lại email xác thực, quên mật khẩu, đăng nhập social: phải bị từ chối bằng problem+json 4xx, không bao giờ thành open redirect trong link email hay trong `Location`. Test: Task 40 (`untrusted callbackURL is rejected on every public flow`).
4. **Chuỗi do người dùng nhập đi vào email** (`name` chứa `<script>`, `{{`, CRLF): HTML phải được escape, subject không chứa CRLF, template không bao giờ bị biên dịch từ input. Test: Task 21 (`escapes user-provided params and rejects CRLF in subject params`).
5. **Dòng email mà template hoặc locale không còn tồn tại khi gửi** (deploy đổi `NOTIFICATIONS_DEFAULT_LOCALE` hoặc bỏ template sau khi dòng đã được tạo, hoặc params không còn khớp schema): job phải kết thúc `FAILED` vĩnh viễn kèm event, không retry vô hạn và không làm worker crash lặp. Test: Task 23 (`unknown locale or invalid params fails the delivery permanently`).

---

## File Structure

```
src/
  main.api.ts                                  bodyParser: false, rawBody: true
  app.modules.ts                               bật IdentityModule + NotificationsModule (api/worker)
  core/
    context/      principal.ts (+ Credential, CredentialKind) · request-context.ts (+ setCredential/credential) · context.keys.ts
    errors/       problem-body.ts (mới, dùng chung filter + writeProblem) · problem-details.filter.ts
    http/         public-route.decorator.ts · body-parser-policy.ts · problem-writer.ts · auth-route-body-parser.ts
                  content-type.ts (helper dùng chung) · http-bootstrap.ts · http.module.ts · index.ts
    health/       readiness-contributor.ts · readiness.ts · health.module.ts · health.controller.ts (@PublicRoute)
    outbox/       outbox.writer.ts (append ifAbsent)
    events/       event-publisher.ts (eventId + ifAbsent)
    resilience/   http-client.ts (signal) · web-fetch.ts (toWebFetch)
    security/     field-cipher.ts (isCiphertext)
    logging/      redaction.ts · logging.module.ts (contextLogFields)
    database/     index.ts (export tlsOptions)
    queue/dashboard/  queue-dashboard.config.ts · queue-dashboard.authorizer.ts · queue-dashboard.server.ts
  modules/identity/
    index.ts · identity.module.ts · identity.config.ts · errors.ts · events.ts · jobs.ts
    ports/        auth-provider.ts · identity-directory.ts · registration-ledger.ts · auth-housekeeping.ts
    application/  registered-event.service.ts · reconcile-registered.handler.ts · purge-expired.handler.ts · auth-emails.ts
    http/         credential-detector.ts · origin-check.ts · web-headers.ts · auth-state.ts · principal.middleware.ts
                  auth.guard.ts · session-only.decorator.ts · me.controller.ts · schemas.ts
    infra/better-auth/  auth-schema.ts · auth.cli-config.ts · auth-pool.ts · auth-pool.provider.ts · auth-options.ts
                        auth-hooks.ts · auth-request-state.ts · auth-instance.ts · account-cipher.adapter.ts
                        auth-error.mapper.ts · login-lockout.ts · email-normalize.ts · profile-mapper.ts
                        pg-identity-directory.ts · pg-registration-ledger.ts · pg-auth-housekeeping.ts · auth-readiness.ts
                        better-auth.provider.ts · better-auth-core.module.ts · auth-mount.middleware.ts · sign-out.ts
                        identity-metrics.ts · better-auth-api.module.ts
    infra/jwks/         jwks.provider.ts · external-auth.module.ts
    infra/dashboard/    platform-admin.authorizer.ts · dashboard-authorizer.module.ts
  modules/notifications/
    index.ts · notifications.module.ts · notifications.config.ts · errors.ts · events.ts · jobs.ts · templates.ts
    domain/       email-delivery.ts
    ports/        email-notifications.ts · mail-transport.ts · template-renderer.ts · delivery-repository.ts
    application/  request-email.service.ts · send-email.handler.ts · reconcile-deliveries.handler.ts · purge-deliveries.handler.ts
    infra/        nodemailer.transport.ts · smtp-error.ts · mjml-handlebars.renderer.ts · sql-delivery.repository.ts
    templates/<template>/<locale>/  subject.hbs · body.mjml · text.hbs
  migrations/identity/   Migration<ts>_better_auth_schema.ts
  migrations/notifications/  Migration<ts>_email_deliveries.ts
  migrations/core/       Migration<ts>_scheduled_tasks_job_name_check.ts
  scripts/gen-env-example.ts                   thêm config của module
docker/
  images.env (IMAGE_MAILPIT) · postgres/init/01-roles.sh (auth_user, schema auth, siết PUBLIC)
  pgbouncer/entrypoint.sh (thêm auth_user vào userlist)
compose.yaml                                   mailpit, auth_user, pgbouncer, SMTP/dashboard của worker, env_file tham số hoá
test/
  support/  infra.global-setup.ts · infra.ts · db.ts · env.ts · app-factory.ts · mailpit.ts · fake-smtp.ts · auth-client.ts
            identity-app.ts · fake-idp.ts · fake-jwks.ts
  smoke/    compose.smoke.yaml · gen-certs.sh · smoke-env.ts · smoke-app-env.ts · smoke.global-setup.ts · smoke-support.ts
            core.smoke.spec.ts · auth-email.smoke.spec.ts · dashboard.smoke.spec.ts
  unit/ …  integration/ …  e2e/identity/ …  chaos/ …
docs/adr/  0010-better-auth-and-auth-modes.md (mới) · 0005 · 0006 · 0007 · 0009 · 0013 · 0016 (cập nhật)
.github/workflows/ ci.yml (env example) · nightly.yml (smoke); kiểm lệch schema Better Auth là test integration
```

---

## Phần A — Spike (bắt buộc làm trước mọi task khác)

Mỗi spike trả lời đúng một câu hỏi ở spec §4. Code spike nằm ở `test/integration/spike-sp2/` (chạy bằng project `integration` để có Postgres/PgBouncer/Redis thật), **không commit**, xoá ở bước cuối của task. Chỉ package đã cài (Task 1) và mục kết quả trong ADR 0010 được commit.

### Task 1: Cài package SP2, khung ADR 0010, Spike S1 (tự mount + Nest 12 ESM + giới hạn body + guard + CLS trong hook + map lỗi)

**Quyết định sau review trước thực thi (B2):** spec §5.5 chọn thallesp và để "tự mount `auth.handler(Request) → Response`" làm fallback. Review đọc mã nguồn thallesp 2.8.0 (`index.mjs:892-896`: `next = () => handler(...)`, promise bị bỏ) và better-call (`router.mjs:100-102`: lỗi ở `onRequest` — storage rate limit, `checkSchema` — nằm ngoài try/catch nên `auth.handler` reject; 429 của rate limit IP trả thẳng `Response` không qua hook). Với thallesp, các lỗi đó thành unhandled rejection làm sập api, và không map được sang problem+json. Vì vậy plan dùng **nhánh tự mount làm cơ chế chính** (ruling R36 của controller; spec §4/§5.5 đã sửa theo): không cài `@thallesp/nestjs-better-auth`; S1 kiểm cơ chế tự mount. Mount gọi `auth.handler(Request)` chứ không `toNodeHandler`, vì `toNodeHandler` của better-call không truyền `bodySizeLimit` (spec A.8, `better-call/dist/node.mjs:3-9`) và tự ghi response nên không map lỗi được. **Fallback nếu S1 không đạt** (vd. CLS không vào hook, dựng `Request` làm sai body/redirect/cookie): thallesp 2.8.0 + patch upstream (await handler, chuyển reject cho `next(err)`) — **dừng, báo Sếp quyết định**, không tự chọn. Ghi vào ADR 0010 ở Step 7.

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `renovate.json`
- Create: `docs/adr/0010-better-auth-and-auth-modes.md` (khung + mục "Kết quả spike")
- Throwaway: `test/integration/spike-sp2/s1-mount.spec.ts`

**Interfaces:**
- Consumes: `ContextModule`, `RequestContext.requestId()`, `ProblemDetailsFilter`, `HttpModule`, `RedisModule`, `configFactories()`, `applyTestEnv()` (SP1).
- Produces: dependency đã cài cho mọi task sau; kết quả S1a–S1i trong ADR 0010: (a) thứ tự middleware Nest (CLS → `ContentTypeMiddleware` → middleware mount `/api/auth/*`) và middleware `{*path}` khác có chạy trên `/api/auth/*` không (quyết định `exclude` ở Task 37); (b) CLS có trong hook/`databaseHooks`/callback mail; (c) hình dạng lỗi ngoài endpoint: 429 của rate limit IP (`Response` + `X-Retry-After`) và `auth.handler` **reject** khi storage lỗi (quyết định Task 36); (d) `ConditionalModule.registerWhen` bỏ mount ở `external`; (e) tên cookie session thật (Task 30); (f) cách lấy `Set-Cookie` của `auth.api.signOut` (Task 36); (g) `raw-body` dừng body chunked vô hạn bằng 413 trong thời gian giới hạn (Task 9/36); (h) `APP_GUARD` không chạy trên `/api/auth/*` (mount kết thúc response, nên không cần tương đương `disableGlobalAuthGuard`), vẫn chạy trên route Nest; (i) lớp bọc bắt lỗi: reject → 503 problem+json, `Response` 429 → problem+json + `Retry-After`, không unhandled rejection (Task 36).

- [ ] **Step 1: Kiểm version và peer trước khi cài**

Run:
```bash
for p in better-auth @better-auth/api-key @better-auth/kysely-adapter @better-auth/core auth jose nodemailer mjml @types/mjml handlebars @bull-board/api @bull-board/express smtp-server @types/smtp-server otpauth express raw-body; do echo "== $p"; pnpm view "$p" dist-tags peerDependencies; done
pnpm view @better-auth/api-key@1.7.6 peerDependencies
pnpm list pg kysely uuid rate-limiter-flexible express raw-body
```
Expected: `latest` khớp spec §5.2 (better-auth/auth/`@better-auth/*` 1.7.6, jose 6.2.12, nodemailer 10.0.10, mjml 5.4.1, `@types/mjml` 5.0.0, handlebars 4.7.9, `@bull-board/*` 9.10.1, express 5.2.1). `raw-body` (parser giới hạn theo stream của Task 9) đang có trong cây qua body-parser (3.0.2). Peer của `@better-auth/api-key@1.7.6` ghi `better-call` `1.4.0` và `@better-auth/utils` `0.4.2`. Khác thì **dừng**, ghi output vào ADR 0010 và báo Sếp.

- [ ] **Step 2: Cài dependency**

Run:
```bash
pnpm add better-auth @better-auth/api-key @better-auth/kysely-adapter jose nodemailer mjml handlebars @bull-board/api @bull-board/express express raw-body
# Peer bị nhóm Better Auth pin cứng: lấy đúng version in ở Step 1 (không tự chọn).
pnpm add better-call@<peer của api-key> @better-auth/utils@<peer của api-key> @better-auth/core@1.7.6
# Bản đang có trong cây, chuyển thành dependency trực tiếp (spec §5.2).
pnpm add pg@8.23.0 kysely@0.29.6
pnpm add -D auth @types/mjml smtp-server @types/smtp-server otpauth
pnpm list better-auth @better-auth/api-key @better-auth/kysely-adapter @better-auth/core better-call auth kysely pg express raw-body
```
(Test đọc metric/span (Task 27 `otel-capture.ts`) dùng `@opentelemetry/sdk-node` (`metrics`), `sdk-trace-base`, `sdk-trace-node`, `context-async-hooks` — đều đã là dependency trực tiếp của SP1, không cài thêm.)
Expected: đúng version ở Step 1; `pg`, `kysely`, `raw-body` nằm trong `dependencies`; không unmet peer cho nhóm Better Auth; không có `@types/nodemailer`, `@bull-board/nestjs`, `@better-auth/redis-storage`, `@better-auth/sso`, `@better-auth/cli`, `@thallesp/nestjs-better-auth`.

- [ ] **Step 3: Nhóm Renovate**

Sửa `renovate.json`, thêm vào `packageRules` (giữ rule đang có; `excludePackageNames` đã bị Renovate bỏ nên dùng mẫu phủ định):
```json
{
  "groupName": "better-auth",
  "matchPackageNames": ["better-auth", "auth", "@better-auth/{/,}**", "!@better-auth/utils"]
},
{
  "groupName": "better-auth peers",
  "matchPackageNames": ["better-call", "@better-auth/utils"],
  "enabled": false,
  "description": "Pinned by the peerDependencies of @better-auth/api-key; bumped by hand together with the better-auth group"
},
{ "groupName": "bull-board", "matchPackageNames": ["@bull-board/{/,}**"] },
{ "groupName": "mailpit image", "matchPackageNames": ["axllent/mailpit"], "pinDigests": true }
```
Run: `pnpm dlx --package renovate renovate-config-validator renovate.json`
Expected: `Config validated successfully`.

- [ ] **Step 4: Khung ADR 0010**

Tạo `docs/adr/0010-better-auth-and-auth-modes.md`:
```markdown
# 0010 — Better Auth và các chế độ xác thực

- Trạng thái: Đang soạn (hoàn tất ở Task 49)
- Ngày: 2026-09-27

## Bối cảnh

(Task 49 điền: spec SP2 §1, §5.4–§5.8, D1–D10.)

## Quyết định

(Task 49 điền.)

## Kết quả spike

Mỗi mục: câu hỏi, cách đo, kết quả (đạt/không đạt kèm bằng chứng), nhánh đã chọn, task bị ảnh hưởng.

### Version đã cài (Task 1)

(Dán output `pnpm list` ở Task 1 Step 2.)
```

- [ ] **Step 5: Viết spike S1**

`test/integration/spike-sp2/s1-mount.spec.ts` (THROWAWAY):
```ts
import { Controller, Get, Injectable, Module, type MiddlewareConsumer, type NestMiddleware, type NestModule, type INestApplication } from '@nestjs/common';
import { ConditionalModule, ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthMiddleware } from 'better-auth/api';
import getRawBody from 'raw-body';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../../../src/core/config/all-configs.js';
import { configFactories, validateAllConfigs } from '../../../src/core/config/index.js';
import { ContextModule, RequestContext } from '../../../src/core/context/index.js';
import { ProblemDetailsFilter } from '../../../src/core/errors/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { applyTestEnv } from '../../support/app-factory.js';

const seen: { step: string; requestId: string }[] = [];
const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] };
let storageFails = false;
const windows = new Map<string, { start: number; count: number }>();
const SPIKE_IP = '203.0.113.9';
const unhandled: unknown[] = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
const SPIKE_LIMIT_BYTES = 2048;
const MAX_413_MS = 2000;

function makeAuth(ctx: RequestContext, prefix: string, secure: boolean) {
  return betterAuth({
    secret: 'spike-secret-spike-secret-spike-secret-0123',
    baseURL: 'http://localhost:3000',
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, autoSignIn: true },
    // IP tin cậy cho rate limit: test gửi `x-forwarded-for` cố định (không có IP thì Better Auth có thể bỏ qua limit).
    advanced: { cookiePrefix: prefix, useSecureCookies: secure, ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    rateLimit: {
      enabled: true, window: 60, max: 1000,
      customRules: { '/sign-in/*': { window: 60, max: 2 } },
      // Review NI2: với `customStorage`, Better Auth giao TOÀN BỘ quyết định cho `consume` (bỏ qua max của rule
      // nếu storage không tự áp). Storage của spike đếm thật theo `key` + `rule` để 429 thật sự xảy ra.
      customStorage: {
        consume: async (key: string, rule: { window: number; max: number }) => {
          if (storageFails) throw new Error('storage down');
          const now = Date.now();
          const w = windows.get(key);
          if (!w || now - w.start >= rule.window * 1000) {
            windows.set(key, { start: now, count: 1 });
            return { allowed: true, retryAfter: null };
          }
          if (w.count >= rule.max) return { allowed: false, retryAfter: Math.ceil((w.start + rule.window * 1000 - now) / 1000) };
          w.count += 1;
          return { allowed: true, retryAfter: null };
        },
      },
    },
    hooks: { before: createAuthMiddleware(async () => { seen.push({ step: 'hooks.before', requestId: ctx.requestId() }); }) },
    databaseHooks: { user: { create: { after: async () => { seen.push({ step: 'databaseHooks.user.create.after', requestId: ctx.requestId() }); } } } },
  });
}

@Injectable()
class SeenMiddleware implements NestMiddleware {
  constructor(private readonly ctx: RequestContext) {}
  use(_req: unknown, _res: unknown, next: () => void) { seen.push({ step: 'nest.{*path}', requestId: this.ctx.requestId() }); next(); }
}
let auth: ReturnType<typeof makeAuth>;
@Injectable()
class MountMiddleware implements NestMiddleware {
  constructor(private readonly ctx: RequestContext) {}
  use(req: IncomingMessage, res: ServerResponse) {
    seen.push({ step: 'mount', requestId: this.ctx.requestId() });
    // Parser JSON của SP1 (`applyHttpDefaults`) đã đọc stream: dựng lại body từ `req.body`.
    const body = req.method === 'GET' || req.method === 'HEAD' || !('body' in req) ? undefined : JSON.stringify(req.body);
    auth.handler(new Request(`http://localhost:3000${req.url}`, { method: req.method, headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])), body }))
      .then(async (r) => {
        // Lớp bọc map lỗi tối thiểu (Task 36 làm đầy đủ): `Response` ≥ 400 không phải problem+json → problem+json,
        // `X-Retry-After` → `Retry-After`, giữ `Set-Cookie`.
        const isProblem = (r.headers.get('content-type') ?? '').includes('application/problem+json');
        if (r.status < 400 || isProblem) {
          res.statusCode = r.status; r.headers.forEach((v, k) => res.appendHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer()));
          return;
        }
        res.statusCode = r.status;
        res.setHeader('content-type', 'application/problem+json');
        for (const c of r.headers.getSetCookie()) res.appendHeader('set-cookie', c);
        const retry = r.headers.get('x-retry-after');
        if (retry) res.setHeader('retry-after', retry);
        res.end(JSON.stringify({ status: r.status, title: 'spike' }));
      })
      .catch((err: unknown) => {
        seen.push({ step: `rejected:${String(err)}`, requestId: this.ctx.requestId() });
        res.statusCode = 503;
        res.setHeader('content-type', 'application/problem+json');
        res.end(JSON.stringify({ status: 503, title: 'Service Unavailable' }));
      });
  }
}
@Injectable()
class DenyAllGuard {
  canActivate() { seen.push({ step: 'guard', requestId: '' }); return false; }
}
@Controller('probe')
class ProbeController { @Get() get() { return { ok: true }; } }
@Module({ controllers: [ProbeController], providers: [SeenMiddleware, MountMiddleware] })
class ProbeModule implements NestModule {
  configure(c: MiddlewareConsumer) {
    c.apply(SeenMiddleware).forRoutes('{*path}');
    c.apply(MountMiddleware).forRoutes('/api/auth/{*path}');
  }
}

describe('S1: self-mounted Better Auth on Nest 12 ESM', () => {
  let app: INestApplication;
  beforeAll(async () => {
    applyTestEnv();
    validateAllConfigs();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: configFactories() }),
        ContextModule, RedisModule, HttpModule,
        ConditionalModule.registerWhen(ProbeModule, (env) => env.SPIKE_AUTH_MODE !== 'external'),
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }, { provide: APP_GUARD, useClass: DenyAllGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    applyHttpDefaults(app);
    await app.init();
    auth = makeAuth(app.get(RequestContext), 'spike', false);
  });
  afterAll(async () => app?.close());

  it('(a)+(b) order of Nest middlewares vs the mount; CLS in hooks and databaseHooks', async () => {
    seen.length = 0;
    await request(app.getHttpServer()).post('/api/auth/sign-up/email').send({ email: 'a@example.com', password: 'passw0rd-long', name: 'A' });
    console.log('S1a/b', JSON.stringify(seen));
    expect(new Set(seen.map((s) => s.requestId)).size).toBe(1);
  });
  it('(c) IP rate limit answers 429 Response with X-Retry-After; storage failure REJECTS auth.handler', async () => {
    const signIn = (password: string) =>
      request(app.getHttpServer()).post('/api/auth/sign-in/email').set('x-forwarded-for', SPIKE_IP).send({ email: 'n@example.com', password });
    const r1 = await signIn('wrong-password');
    await signIn('wrong-password');
    const r3 = await signIn('wrong-password');
    expect(r1.status).toBe(401);
    console.log('S1c 429', r1.status, r3.status, r3.headers['x-retry-after'], r3.text);
    storageFails = true;
    seen.length = 0;
    const r4 = await signIn('x');
    storageFails = false;
    console.log('S1c reject', r4.status, JSON.stringify(seen));
    expect(seen.some((s) => s.step.startsWith('rejected:'))).toBe(true);
    // (i) lớp bọc: reject → 503 problem+json; 429 → problem+json + Retry-After; process không có unhandled rejection.
    expect([r4.status, r4.headers['content-type']]).toEqual([503, expect.stringContaining('application/problem+json')]);
    expect([r3.status, r3.headers['content-type']]).toEqual([429, expect.stringContaining('application/problem+json')]);
    expect(Number(r3.headers['retry-after'])).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });
  it('(g) raw-body stops an unbounded chunked body with 413 in bounded time', async () => {
    const server = createServer((req, res) => {
      getRawBody(req, { limit: SPIKE_LIMIT_BYTES }, (err) => {
        res.statusCode = err ? 413 : 200;
        res.setHeader('connection', 'close');
        res.end();
        res.once('finish', () => { req.socket.end(); setTimeout(() => req.socket.destroy(), 1000).unref(); });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const started = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
      let code = 0;
      req.on('response', (res) => { code = res.statusCode ?? 0; res.resume(); });
      req.on('error', () => undefined);
      const timer = setInterval(() => { if (!req.destroyed) req.write('x'.repeat(512)); }, 5);
      req.on('close', () => { clearInterval(timer); resolve(code); });
      setTimeout(() => reject(new Error('no 413')), MAX_413_MS * 2);
    });
    await new Promise<void>((r) => server.close(() => r()));
    console.log('S1g', status, Date.now() - started);
    expect(status).toBe(413);
    expect(Date.now() - started).toBeLessThan(MAX_413_MS);
  });
  it('(h) the global guard never runs on /api/auth/* (the mount ends the response) but runs on Nest routes', async () => {
    seen.length = 0;
    await request(app.getHttpServer()).get('/api/auth/get-session');
    expect(seen.some((s) => s.step === 'guard')).toBe(false);
    await request(app.getHttpServer()).get('/probe').expect(403);
    expect(seen.some((s) => s.step === 'guard')).toBe(true);
  });
  it('(d) ConditionalModule drops the mount in external mode', () => {
    console.log('S1d', 'rerun with SPIKE_AUTH_MODE=external: POST /api/auth/sign-in/email must be 404');
  });
  it('(e) session cookie names with cookiePrefix and useSecureCookies', async () => {
    const plain = await auth.api.signInEmail({ body: { email: 'a@example.com', password: 'passw0rd-long' }, asResponse: true });
    const secure = await makeAuth(app.get(RequestContext), 'spike', true).api.signInEmail({ body: { email: 'a@example.com', password: 'passw0rd-long' }, asResponse: true });
    console.log('S1e', plain.headers.getSetCookie(), secure.headers.getSetCookie());
  });
  it('(f) Set-Cookie of a server-side auth.api.signOut call', async () => {
    const signIn = await auth.api.signInEmail({ body: { email: 'a@example.com', password: 'passw0rd-long' }, asResponse: true });
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const out = await auth.api.signOut({ headers: new Headers({ cookie }), returnHeaders: true });
    console.log('S1f', out.headers.getSetCookie());
    expect(out.headers.getSetCookie().length).toBeGreaterThan(0);
  });
  it('SP1 conventions on Nest routes still hold (415 is decided before the guard)', async () => {
    await request(app.getHttpServer()).post('/probe').set('content-type', 'text/plain').send('x').expect(415);
  });
});
```
(`BetterAuthRateLimitStorage` của 1.7.6 chỉ có `consume(key, rule) → { allowed, retryAfter }` — `@better-auth/core/dist/types/init-options.d.mts:142-167`, đã đọc tarball; Better Auth không còn nhận `get`/`set`.)

- [ ] **Step 6: Chạy spike**

Run:
```bash
pnpm vitest run --project integration test/integration/spike-sp2/s1-mount.spec.ts
SPIKE_AUTH_MODE=external pnpm vitest run --project integration test/integration/spike-sp2/s1-mount.spec.ts -t "(d)"
pnpm vitest run --project integration test/e2e/core
```
Ghi lại: thứ tự `seen` (a) — đặc biệt `nest.{*path}` có chạy trước `mount` trên `/api/auth/*` không (Task 37 luôn `exclude` basePath khỏi `PrincipalMiddleware`; ghi lại để biết `exclude` là bắt buộc hay phòng thủ); requestId trong hook và `databaseHooks` (b); status/header của 429 và việc `auth.handler` reject khi storage lỗi (c); 404 ở (d); tên cookie thật (e); `Set-Cookie` ở (f) — nếu `returnHeaders` không có trong kiểu của `signOut`, đọc `node_modules/better-call/dist/*.d.mts` để tìm option đúng (`asResponse: true` → `Response.headers.getSetCookie()`).

Tiêu chí đạt: mọi test e2e của SP1 xanh; hook và `databaseHooks` thấy cùng `requestId` (b); (c) ghi đúng hình dạng để Task 36 xử lý; (g) 413 trong `MAX_413_MS`; (h) guard không chạy trên `/api/auth/*`; (i) 503/429 là problem+json và `unhandled` rỗng. **Không đạt (b), (g), (h) hoặc (i) bằng tự mount:** fallback là thallesp 2.8.0 + patch upstream — dừng và báo Sếp quyết định (không tự áp).

- [ ] **Step 7: Ghi kết quả S1 vào ADR 0010**

```markdown
### S1 — Tự mount + Nest 12 ESM + giới hạn body + guard + CLS trong hook + map lỗi

**Quyết định:** không dùng `@thallesp/nestjs-better-auth` (review B2: handler bị gọi bằng `next()` không await nên lỗi ở `onRequest` thành unhandled rejection; 429 của rate limit IP và lỗi storage không đi qua hook nên không map được). Dùng middleware Nest tự mount gọi `auth.handler(Request)` (không `toNodeHandler`: không có `bodySizeLimit`, A.8) — ruling R36; spec §4 S1/§5.5 đã sửa. Fallback nếu không đạt: thallesp + patch upstream, cần Sếp quyết định.

| Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|
| (a) thứ tự CLS → ContentType → mount; middleware `{*path}` khác có chạy trên `/api/auth/*` | <…> | <output `seen`> |
| (b) CLS trong `hooks`/`databaseHooks` | <đạt/không> | <requestId> |
| (c) 429 IP: `Response` + `X-Retry-After`; storage lỗi: `auth.handler` reject | <…> | <status, header, `rejected:`> |
| (d) `ConditionalModule.registerWhen` bỏ mount ở `external` | <đạt/không> | <404> |
| (e) tên cookie session | `<prefix>.session_token`, `__Secure-<prefix>.session_token` | <Set-Cookie> |
| (f) lấy `Set-Cookie` của `auth.api.signOut` | option `<returnHeaders|asResponse>` | <Set-Cookie> |
| (g) `raw-body` 413 với chunked vô hạn | <đạt/không> | <status, ms> |
| (h) `APP_GUARD` không chạy trên `/api/auth/*` | <đạt/không> | <seen> |
| (i) lớp bọc: reject → 503, 429 → problem+json + `Retry-After`, không unhandled rejection | <đạt/không> | <status, header> |

**Task bị ảnh hưởng:** Task 36 (mount, map mọi `Response` ≥ 400 và mọi reject), Task 37 (luôn `exclude` basePath khỏi `PrincipalMiddleware` — review I9; (a) xác nhận `exclude` thật sự chặn middleware `{*path}` trên `/api/auth/*`, test e2e ở Task 37 giữ điều đó). Nếu (b) không đạt: problem+json của hook dùng requestId `none`; `AuthRequestState` (Task 34) không phụ thuộc CLS. Nếu (f) không đạt: Task 36 tự phát `Set-Cookie` hết hạn theo tên ở (e), `Path=/`, `Domain` từ `AUTH_COOKIE_DOMAIN`.
```

- [ ] **Step 8: Dọn spike và commit**

Run:
```bash
rm -rf test/integration/spike-sp2
pnpm typecheck && pnpm lint && pnpm test
git add package.json pnpm-lock.yaml renovate.json docs/adr/0010-better-auth-and-auth-modes.md
git commit -m "chore(deps): add sp2 identity/notification packages; record spike S1 (self-mounted better auth on nest 12 esm)"
```

---

### Task 2: Spike S2 (adapter Kysely bọc, `auth_user`, PgBouncer transaction mode)

**Files:**
- Throwaway: `test/integration/spike-sp2/s2-kysely-pgbouncer.spec.ts`
- Modify: `docs/adr/0010-better-auth-and-auth-modes.md` (mục S2)

**Interfaces:**
- Consumes: package ở Task 1; `readImages()` (test/support/images.ts).
- Produces: kết quả S2a (adapter bọc dạng `(opts) => DBAdapter` + `CamelCasePlugin` + `transaction: true` + `search_path` của role) và S2b (`RateLimiterPostgres` named prepared statement qua PgBouncer 1.25 với `MAX_PREPARED_STATEMENTS`). S2b quyết định pool `auth_user` đi qua PgBouncer (Task 15, 27) hay đi thẳng Postgres.

- [ ] **Step 1: Viết spike S2**

`test/integration/spike-sp2/s2-kysely-pgbouncer.spec.ts` (THROWAWAY; tự dựng Postgres + PgBouncer riêng để có role `auth_user` trước Task 15):
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { betterAuth, type DBAdapter } from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { RateLimiterPostgres } from 'rate-limiter-flexible';
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readImages } from '../../support/images.js';

const PW = 'spike-auth-pw';
let net: StartedNetwork; let pgC: StartedPostgreSqlContainer; let bouncer: StartedTestContainer;

beforeAll(async () => {
  const images = readImages();
  net = await new Network().start();
  pgC = await new PostgreSqlContainer(images.IMAGE_POSTGRES!).withNetwork(net).withNetworkAliases('pg').start();
  const su = new pg.Client({ connectionString: pgC.getConnectionUri() });
  await su.connect();
  await su.query(`CREATE ROLE auth_user LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`);
  await su.query(`CREATE SCHEMA auth AUTHORIZATION ${pgC.getUsername()}`);
  await su.query(`GRANT USAGE ON SCHEMA auth TO auth_user`);
  await su.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await su.query(`ALTER ROLE auth_user SET search_path = auth`);
  await su.query(`CREATE TABLE auth."user" (id uuid PRIMARY KEY DEFAULT uuidv7(), name text NOT NULL, email text NOT NULL UNIQUE, email_verified boolean NOT NULL, image text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await su.query(`CREATE TABLE auth.account (id uuid PRIMARY KEY DEFAULT uuidv7(), account_id text NOT NULL, provider_id text NOT NULL, user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE, access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await su.query(`CREATE TABLE auth.session (id uuid PRIMARY KEY DEFAULT uuidv7(), expires_at timestamptz NOT NULL, token text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), ip_address text, user_agent text, user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE)`);
  await su.query(`CREATE TABLE auth.verification (id uuid PRIMARY KEY DEFAULT uuidv7(), identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await su.query(`CREATE TABLE auth.login_attempts (key varchar(255) PRIMARY KEY, points integer NOT NULL DEFAULT 0, expire bigint)`);
  await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_user`);
  await su.end();
  bouncer = await new GenericContainer(images.IMAGE_PGBOUNCER!).withNetwork(net)
    .withEnvironment({
      DB_HOST: 'pg', DB_PORT: '5432', DB_NAME: pgC.getDatabase(), DB_USER: 'auth_user', DB_PASSWORD: PW,
      POOL_MODE: 'transaction', AUTH_TYPE: 'scram-sha-256', MAX_PREPARED_STATEMENTS: '200',
    })
    .withExposedPorts(5432).withWaitStrategy(Wait.forListeningPorts()).start();
});
afterAll(async () => { await bouncer?.stop(); await pgC?.stop(); await net?.stop(); });

const poolVia = (via: 'pg' | 'bouncer') => new pg.Pool({
  host: via === 'pg' ? pgC.getHost() : bouncer.getHost(),
  port: via === 'pg' ? pgC.getPort() : bouncer.getMappedPort(5432),
  database: pgC.getDatabase(), user: 'auth_user', password: PW, max: 4,
});

describe('S2a: wrapped Kysely adapter as auth_user', () => {
  it('sign-up runs in one transaction; snake_case columns; public untouched', async () => {
    const pool = poolVia('bouncer');
    const db = new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] });
    const calls: string[] = [];
    const wrap = (inner: DBAdapter): DBAdapter => ({
      ...inner,
      create: (d) => { calls.push(`create:${d.model}`); return inner.create(d); },
      transaction: (cb) => inner.transaction((trx) => { calls.push('transaction'); return cb(trx); }),
    });
    const auth = betterAuth({
      secret: 'spike-secret-spike-secret-spike-secret-0123', baseURL: 'http://localhost:3000',
      database: (opts) => wrap(kyselyAdapter(db, { type: 'postgres', transaction: true })(opts)),
      advanced: { database: { generateId: 'uuid' } },
      emailAndPassword: { enabled: true },
      // Ném ở account.create.before: user ĐÃ được insert trong cùng transaction, nên rollback mới có ý nghĩa.
      databaseHooks: { account: { create: { before: async () => { if (calls.includes('fail')) throw new Error('boom'); } } } },
    });
    await auth.api.signUpEmail({ body: { email: 'a@example.com', password: 'passw0rd-long', name: 'A' } });
    const { rows } = await pool.query(`SELECT email, email_verified, uuid_extract_version(id) AS v FROM "user"`);
    console.log('S2a', calls, rows);
    expect(rows).toEqual([{ email: 'a@example.com', email_verified: false, v: 7 }]);
    calls.push('fail');
    await expect(auth.api.signUpEmail({ body: { email: 'b@example.com', password: 'passw0rd-long', name: 'B' } })).rejects.toThrow();
    const after = await pool.query(`SELECT count(*)::int AS n FROM "user" WHERE email = 'b@example.com'`);
    const acct = await pool.query(`SELECT count(*)::int AS n FROM account a JOIN "user" u ON u.id = a.user_id WHERE u.email = 'b@example.com'`);
    expect([after.rows[0].n, acct.rows[0].n]).toEqual([0, 0]);
    await expect(pool.query('SELECT 1 FROM public.anything LIMIT 0')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('CREATE TABLE public.x (id int)')).rejects.toThrow(/permission denied/);
    await db.destroy();
  });
});

describe('S2b: RateLimiterPostgres named prepared statements through PgBouncer', () => {
  it.each(['pg', 'bouncer'] as const)('consume/reward/block via %s', async (via) => {
    const pool = poolVia(via);
    const limiter = new RateLimiterPostgres({
      storeClient: pool, storeType: 'pool', schemaName: 'auth', tableName: 'login_attempts',
      tableCreated: true, keyPrefix: `s2${via}`, points: 3, duration: 60,
    });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => limiter.consume('k')));
    const rejected = results.filter((r) => r.status === 'rejected').length;
    console.log('S2b', via, { rejected });
    expect(rejected).toBe(7);
    await limiter.reward('k', 1);
    await pool.end();
  });
});
```

- [ ] **Step 2: Chạy spike**

Run: `pnpm vitest run --project integration test/integration/spike-sp2/s2-kysely-pgbouncer.spec.ts`
Ghi lại: lời gọi adapter có `transaction` hay không, dòng user có `v = 7`, rollback khi hook lỗi, quyền trên `public`; S2b qua `pg` và qua `bouncer` (có lỗi `prepared statement "rlflx-upsert" already exists`/`does not exist` hay không). Nếu S2b qua `bouncer` lỗi: thử lại với `MAX_PREPARED_STATEMENTS` lớn hơn, rồi mới kết luận.

- [ ] **Step 3: Ghi kết quả S2 vào ADR 0010**

```markdown
### S2 — Adapter Kysely bọc, `auth_user`, PgBouncer

| Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|
| (a) `database: (opts) => wrap(kyselyAdapter(db, { type: 'postgres', transaction: true })(opts))`, `CamelCasePlugin`, schema qua `search_path` | <đạt/không> | <calls, rows, rollback> |
| (b) named prepared statement `rlflx-upsert` qua PgBouncer 1.25 transaction mode, `MAX_PREPARED_STATEMENTS=<n>` | <đạt/không> | <rejected=7 qua cả hai> |

**Nhánh:** (a) <adapter bọc | fallback `{ db, type, schemaName: 'auth', transaction: true }` + plugin Kysely `transformQuery/transformResult` mã hoá token>. (b) <qua PgBouncer với `MAX_PREPARED_STATEMENTS=<n>` | pool `auth_user` đi thẳng Postgres>.
**Task bị ảnh hưởng nếu fallback:** (a) Task 28 thay `withAccountCipher` bằng `AccountCipherPlugin` (KyselyPlugin), Task 34 đổi `database`. (b) Task 15 bỏ user `auth_user` khỏi PgBouncer và `docker/pgbouncer/entrypoint.sh`; `DB_AUTH_HOST/PORT` mặc định trỏ Postgres (compose: `postgres:5432`, test: `dbEnvFor` dùng `pg.host/port`); Task 49 ghi công thức connection `api × (DB_POOL_MAX qua PgBouncer) + api × DB_AUTH_POOL_MAX (thẳng)` vào README.
```

- [ ] **Step 4: Dọn spike và commit**

```bash
rm -rf test/integration/spike-sp2
git add docs/adr/0010-better-auth-and-auth-modes.md
git commit -m "docs(adr): record spike S2 (wrapped kysely adapter, auth_user, pgbouncer prepared statements)"
```

---

### Task 3: Spike S3 (`auth generate` trên PG 18.6, `validateSchema`, kiểm lệch, `create-admin`)

**Files:**
- Throwaway: `test/integration/spike-sp2/s3-generate/auth.spike-config.ts`, `test/integration/spike-sp2/s3-generate.spec.ts`
- Modify: `docs/adr/0010-better-auth-and-auth-modes.md` (mục S3), `docs/adr/0009-id-strategy.md` (chỉ khi fallback B)

**Interfaces:**
- Consumes: package ở Task 1.
- Produces: (a) SQL mà `auth generate` sinh cho bộ plugin của SP2 (lưu vào ADR làm tài liệu đối chiếu cho Task 26); (b) danh sách sửa đổi SQL mà `validateSchema` chấp nhận; (c) output của `auth generate` khi schema đã khớp (điều kiện fail của CI ở Task 48); (d) lệnh `auth create-admin` chạy được với file config CLI (dùng ở README).

- [ ] **Step 1: Đọc flag của CLI**

Run:
```bash
pnpm exec auth --help
pnpm exec auth generate --help
pnpm exec auth create-admin --help
```
Ghi tên flag thật (`--config`, `--output`, `--yes`/`-y`, `--adapter`, `--dialect`, flag của `create-admin`) vào nháp ADR.

- [ ] **Step 2: File config CLI cho spike**

`test/integration/spike-sp2/s3-generate/auth.spike-config.ts` (THROWAWAY):
```ts
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { admin, bearer, jwt, twoFactor } from 'better-auth/plugins';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.SPIKE_AUTH_DB_URL });
export const auth = betterAuth({
  secret: 'spike-secret-spike-secret-spike-secret-0123',
  baseURL: 'http://localhost:3000',
  database: {
    db: new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] }),
    type: 'postgres', schemaName: 'auth', transaction: true,
  },
  advanced: { database: { generateId: 'uuid' } },
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: 'database' },
  plugins: [
    twoFactor({ issuer: 'spike', backupCodeOptions: { storeBackupCodes: 'encrypted' } }),
    bearer(),
    apiKey({ apiKeyHeaders: ['x-api-key'], references: 'user', enableSessionForAPIKeys: false }),
    jwt({ jwks: { rotationInterval: 86400, gracePeriod: 3600 } }),
    admin({ adminRoles: ['admin'], defaultRole: 'user' }),
  ],
});
export default auth;
```

- [ ] **Step 3: Sinh SQL trên Postgres 18.6 trống**

Run:
```bash
IMG=$(grep '^IMAGE_POSTGRES=' docker/images.env | cut -d= -f2-)
docker run -d --rm --name s3-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55499:5432 "$IMG"
sleep 5
docker exec s3-pg psql -U postgres -c "CREATE SCHEMA auth"
SPIKE_AUTH_DB_URL=postgres://postgres:pw@127.0.0.1:55499/postgres pnpm exec auth generate --config test/integration/spike-sp2/s3-generate/auth.spike-config.ts --output test/integration/spike-sp2/s3-generate/out.sql --yes
cat test/integration/spike-sp2/s3-generate/out.sql
```
Expected: file `.sql` tạo các bảng `user`, `session`, `account`, `verification`, `twoFactor`/`two_factor`, `apikey`, `jwks`, `rateLimit`/`rate_limit` trong schema `auth`, cột snake_case (do `CamelCasePlugin`), `id` kiểu `uuid DEFAULT pg_catalog.gen_random_uuid()`. Ghi nguyên văn vào ADR.

- [ ] **Step 4: Áp SQL đã sửa, kiểm `validateSchema` và id v7**

Chép `out.sql` thành `test/integration/spike-sp2/s3-generate/fixed.sql`, áp các sửa đổi của spec §5.3 bước 4 (`DEFAULT uuidv7()`, `timestamptz`, `UNIQUE (provider_id, account_id)`, FK `apikey.reference_id`, cột `registered_event_emitted_at timestamptz NULL`, bảng `login_attempts`, index). Run:
```bash
docker exec -i s3-pg psql -v ON_ERROR_STOP=1 -U postgres < test/integration/spike-sp2/s3-generate/fixed.sql
SPIKE_AUTH_DB_URL=postgres://postgres:pw@127.0.0.1:55499/postgres pnpm exec auth generate --config test/integration/spike-sp2/s3-generate/auth.spike-config.ts --output test/integration/spike-sp2/s3-generate/drift.sql --yes; echo "exit=$?"
ls -la test/integration/spike-sp2/s3-generate/
```
Expected: (c) lệnh lần hai báo schema đã khớp — ghi **chính xác** hành vi (không tạo file, file rỗng, hay thông báo "No changes"/exit code) vì Task 48 dựa vào đó.

`test/integration/spike-sp2/s3-generate.spec.ts` (THROWAWAY):
```ts
import pg from 'pg';
import { describe, expect, it } from 'vitest';

describe('S3b: runtime validateSchema accepts the edited SQL', () => {
  it('sign-up works and ids are uuidv7', async () => {
    process.env.SPIKE_AUTH_DB_URL = 'postgres://postgres:pw@127.0.0.1:55499/postgres';
    const { auth } = await import('./s3-generate/auth.spike-config.js');
    await auth.api.signUpEmail({ body: { email: 's3@example.com', password: 'passw0rd-long', name: 'S3' } });
    const c = new pg.Client({ connectionString: process.env.SPIKE_AUTH_DB_URL });
    await c.connect();
    const { rows } = await c.query(`SELECT uuid_extract_version(id) AS v FROM auth."user" WHERE email = 's3@example.com'`);
    await c.end();
    expect(rows[0]?.v).toBe(7);
  });
});
```
Run: `pnpm vitest run --project integration test/integration/spike-sp2/s3-generate.spec.ts` (spike dùng container `s3-pg` tự dựng; hạ tầng chung của project vẫn khởi động nhưng không được dùng).
Expected: PASS; không có log `validateSchema`/"schema mismatch" chặn request.

- [ ] **Step 5: `create-admin` (S3d)**

Run (tên flag lấy từ Step 1):
```bash
SPIKE_AUTH_DB_URL=postgres://postgres:pw@127.0.0.1:55499/postgres pnpm exec auth create-admin --config test/integration/spike-sp2/s3-generate/auth.spike-config.ts --email admin@example.com --password 'admin-passw0rd-long' --role admin
docker exec s3-pg psql -U postgres -c "SELECT email, role FROM auth.\"user\" WHERE email='admin@example.com'"
docker stop s3-pg
```
Expected: một dòng `role = admin`. Nếu không chạy được với file config: ghi fallback runbook "đăng ký bình thường rồi `UPDATE auth."user" SET role = 'admin'` bằng superuser".

- [ ] **Step 6: Ghi kết quả S3, dọn, commit**

```markdown
### S3 — `auth generate` trên PG 18.6

- (a) SQL sinh ra: <dán nguyên văn>.
- (b) Sửa đổi `validateSchema` chấp nhận: <danh sách>; cột NOT NULL tự thêm phải có `DEFAULT`.
- (c) Khi schema đã khớp: <hành vi chính xác>. CI (Task 48) fail khi <điều kiện>.
- (d) `auth create-admin`: <lệnh chạy được | fallback SQL>.
- Id mới: `uuid_extract_version(id) = 7` <đạt/không>.

**Nhánh:** <(A) `generateId: 'uuid'` + `DEFAULT uuidv7()` | (B) `generateId` là function `() => v7()` + đổi `text` → `uuid`>.
**Task bị ảnh hưởng nếu (B):** Task 26 (SQL giữ id do app sinh, không `DEFAULT`; `schemaOptions` dùng `generateId: () => v7()`), Task 33 (`buildAuthOptions` cùng giá trị), ADR 0009.
```
```bash
rm -rf test/integration/spike-sp2
git add docs/adr/0010-better-auth-and-auth-modes.md docs/adr/0009-id-strategy.md
git commit -m "docs(adr): record spike S3 (auth generate on pg 18.6, validateSchema, drift check, create-admin)"
```

---

### Task 4: Spike S4 (lỗi storage của rate limit; user id của lần đăng nhập chờ 2FA)

**Files:**
- Throwaway: `test/integration/spike-sp2/s4-ratelimit-2fa.spec.ts`
- Modify: `docs/adr/0010-better-auth-and-auth-modes.md` (mục S4)

**Interfaces:**
- Consumes: package ở Task 1; container tự dựng như Task 2.
- Produces: (a) lỗi của `rateLimit.storage: 'database'` có tới được `hooks.after`/`onAPIError` kèm lỗi gốc (SQLSTATE) không → xác nhận nhánh xử lý lỗi của Task 36 (reject hay `Response` ≥ 500); (b) nơi đọc user id của lần đăng nhập chờ 2FA trong hook `/two-factor/verify-*` → quyết định khoá 2FA của Task 34 theo `2fa:<userId>` hay `2fa:<sha256(cookie two_factor)>`.

- [ ] **Step 1: Viết spike S4**

`test/integration/spike-sp2/s4-ratelimit-2fa.spec.ts` (THROWAWAY):
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readImages } from '../../support/images.js';

let pgC: StartedPostgreSqlContainer; let pool: pg.Pool;
const errors: unknown[] = [];
const hookSeen: Record<string, unknown>[] = [];
beforeAll(async () => {
  pgC = await new PostgreSqlContainer(readImages().IMAGE_POSTGRES!).start();
  pool = new pg.Pool({ connectionString: pgC.getConnectionUri() });
});
afterAll(async () => { await pool?.end(); await pgC?.stop(); });

function makeAuth() {
  return betterAuth({
    secret: 'spike-secret-spike-secret-spike-secret-0123', baseURL: 'http://localhost:3000',
    database: { db: new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] }), type: 'postgres', transaction: true },
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100 },
    plugins: [twoFactor({ issuer: 'spike' })],
    onAPIError: { throw: false, onError: (e) => { errors.push(e); } },
    hooks: {
      before: createAuthMiddleware(async (c) => {
        if (c.path.startsWith('/two-factor/verify'))
          hookSeen.push({ path: c.path, cookie: c.headers?.get('cookie'), session: c.context.session });
      }),
    },
  });
}

describe('S4', () => {
  it('(a) storage failure surfaces with its SQLSTATE', async () => {
    const auth = makeAuth();
    const { runMigrations } = await import('better-auth/db/migration').then((m) => m.getMigrations(auth.options));
    await runMigrations();
    await pool.query('ALTER TABLE "rateLimit" RENAME TO rate_limit_gone').catch(() => pool.query('ALTER TABLE rate_limit RENAME TO rate_limit_gone'));
    // Review B2: lỗi storage rate limit ném ở `onRequest`, ngoài try/catch của router → handler REJECT.
    const outcome = await auth.handler(new Request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body: JSON.stringify({ email: 'x@example.com', password: 'whatever-long' }),
    })).then((r) => ({ resolved: r.status }), (err: unknown) => ({ rejected: err instanceof Error ? `${err.name}:${'code' in err ? String(err.code) : ''}` : String(err) }));
    console.log('S4a', JSON.stringify(outcome), 'onError calls:', errors.length);
    expect(outcome).toHaveProperty('rejected');
  });
  it('(b) pending-2FA identity inside the verify hook', async () => {
    console.log('S4b', JSON.stringify(hookSeen));
  });
});
```
Bổ sung cho (b): đăng ký user, bật 2FA bằng `auth.api.enableTwoFactor` (session của user), đăng nhập lại (nhận cookie `two_factor`), gọi `POST /api/auth/two-factor/verify-totp` với cookie đó và mã sai, rồi đọc `hookSeen`: có `session` không, có user id ở đâu (cookie ký chứa gì, `c.context` có trường nào). Đọc `node_modules/better-auth/dist/plugins/two-factor/index.mjs` quanh hàm verify để đối chiếu (ghi số dòng).

- [ ] **Step 2: Chạy, ghi kết quả, dọn, commit**

Run: `pnpm vitest run --project integration test/integration/spike-sp2/s4-ratelimit-2fa.spec.ts`

```markdown
### S4 — Lỗi storage rate limit; user id chờ 2FA

- (a) Lỗi `rate_limit` mất bảng: status <500>, lỗi gốc <tới/không tới> `onAPIError.onError` kèm `code = 42P01`.
- (b) Trong hook `/two-factor/verify-*`: <user id đọc được từ … | không đọc được>.

**Nhánh:** (a) <handler reject khi storage lỗi → Task 36 bắt reject và trả `503` fail-closed (mọi reject của `auth.handler`) | handler trả `Response` ≥ 500 → Task 36 map `Response` đó (probe pool auth)>. `customStorage` không phải fallback: nó cũng chạy trong `onRequest`, lỗi của nó cũng reject. (b) <khoá `2fa:<userId>` | fallback `2fa:<sha256(giá trị cookie two_factor)>`>.
**Task bị ảnh hưởng:** (a) chỉ Task 36 (`AuthMountMiddleware.forward`: nhánh reject và nhánh `Response` ≥ 500 đều đã có; kết quả S4a chỉ xác nhận nhánh nào được test phủ). (b) Task 34: `subject` của khoá 2FA chỉ còn nhánh `cookie:<sha256(giá trị cookie two_factor)>`.
```
```bash
rm -rf test/integration/spike-sp2
git add docs/adr/0010-better-auth-and-auth-modes.md
git commit -m "docs(adr): record spike S4 (rate limit storage failure, pending 2fa identity)"
```

---

### Task 5: Spike S5 (adapter bọc có thấy mọi thao tác trên `account` không)

**Files:**
- Throwaway: `test/integration/spike-sp2/s5-account-ops.spec.ts`
- Modify: `docs/adr/0010-better-auth-and-auth-modes.md` (mục S5)

**Interfaces:**
- Consumes: package ở Task 1; OAuth provider giả (server `node:http` trả discovery/token/userinfo).
- Produces: danh sách thao tác (`create`, `update` theo `id`, `updateMany`, `findOne`, `findMany`, `consumeOne`, `join` từ model khác, bản trong `transaction`) mà Better Auth dùng trên model `account` khi: đăng ký email, liên kết Google (provider giả), refresh token, partial update. Task 28 cài đặt đúng danh sách này.

- [ ] **Step 1: Viết spike S5**

`test/integration/spike-sp2/s5-account-ops.spec.ts` (THROWAWAY):
```ts
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { betterAuth, type DBAdapter, type Where } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { readImages } from '../../support/images.js';

const ops: { op: string; model: string; where?: Where[]; keys?: string[]; inTx: boolean; join?: unknown }[] = [];
function spy(inner: DBAdapter, inTx = false): DBAdapter {
  const rec = (op: string, d: { model: string; where?: Where[]; data?: object; update?: object; join?: unknown }) =>
    ops.push({ op, model: d.model, where: d.where, keys: Object.keys(d.data ?? d.update ?? {}), inTx, join: d.join });
  return {
    ...inner,
    create: (d) => { rec('create', d); return inner.create(d); },
    update: (d) => { rec('update', d); return inner.update(d); },
    updateMany: (d) => { rec('updateMany', d); return inner.updateMany(d); },
    findOne: (d) => { rec('findOne', d); return inner.findOne(d); },
    findMany: (d) => { rec('findMany', d); return inner.findMany(d); },
    consumeOne: (d) => { rec('consumeOne', d); return inner.consumeOne(d); },
    transaction: (cb) => inner.transaction((trx) => cb(spy({ ...trx, transaction: inner.transaction }, true))),
  };
}

let pgC: StartedPostgreSqlContainer; let idp: Server; let idpUrl = '';
beforeAll(async () => {
  pgC = await new PostgreSqlContainer(readImages().IMAGE_POSTGRES!).start();
  let n = 0;
  idp = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/.well-known')) return res.end(JSON.stringify({
      issuer: idpUrl, authorization_endpoint: `${idpUrl}/authorize`, token_endpoint: `${idpUrl}/token`, userinfo_endpoint: `${idpUrl}/userinfo`,
    }));
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: `at-${++n}`, refresh_token: `rt-${n}`, id_token: 'x.y.z', token_type: 'Bearer', expires_in: 1 }));
    if (req.url === '/userinfo') return res.end(JSON.stringify({ sub: 'idp-user-1', email: 's5@example.com', email_verified: true, name: 'S5' }));
    res.statusCode = 404; res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => idp.once('listening', r));
  const addr = idp.address(); idpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { idp?.close(); await pgC?.stop(); });

describe('S5: account operations seen by the wrapped adapter', () => {
  it('records every account call for sign-up, OAuth callback, refresh, partial update', async () => {
    const pool = new pg.Pool({ connectionString: pgC.getConnectionUri() });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] });
    const auth = betterAuth({
      secret: 'spike-secret-spike-secret-spike-secret-0123', baseURL: 'http://localhost:3000',
      database: (o) => spy(kyselyAdapter(db, { type: 'postgres', transaction: true })(o)),
      emailAndPassword: { enabled: true },
      plugins: [genericOAuth({ config: [{ providerId: 'fake', discoveryUrl: `${idpUrl}/.well-known/openid-configuration`, clientId: 'c', clientSecret: 's', scopes: ['openid', 'email'] }] })],
    });
    const { getMigrations } = await import('better-auth/db/migration');
    await (await getMigrations(auth.options)).runMigrations();
    await auth.api.signUpEmail({ body: { email: 's5@example.com', password: 'passw0rd-long', name: 'S5' } });
    const signed = await auth.api.signInEmail({ body: { email: 's5@example.com', password: 'passw0rd-long' }, asResponse: true });
    const cookie = signed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    // OAuth: bắt đầu đăng nhập qua genericOAuth để lấy URL uỷ quyền (có `state` và `redirect_uri`).
    const start = await auth.handler(new Request('http://localhost:3000/api/auth/sign-in/oauth2', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie },
      body: JSON.stringify({ providerId: 'fake', callbackURL: '/' }),
    }));
    const startCookies = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const authUrl = new URL((await start.json()).url);
    const callback = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
    // Callback: IdP giả nhận mọi `code`; Better Auth đổi code → token (lưu account) rồi redirect.
    const cb = await auth.handler(new Request(`${callback.origin}${callback.pathname}?code=c1&state=${authUrl.searchParams.get('state')}`, {
      headers: { cookie: [cookie, startCookies].filter(Boolean).join('; ') },
    }));
    console.log('S5 callback', cb.status, cb.headers.get('location'));
    // Refresh: token giả có expires_in = 1 giây, nên refresh chạy nhánh update token theo id.
    await new Promise((r) => setTimeout(r, 1100));
    const refreshed = await auth.handler(new Request('http://localhost:3000/api/auth/refresh-token', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie },
      body: JSON.stringify({ providerId: 'fake' }),
    }));
    console.log('S5 refresh', refreshed.status, await refreshed.text());
    console.log('S5 ops', JSON.stringify(ops.filter((o) => o.model === 'account' || JSON.stringify(o.join ?? '').includes('account')), null, 1));
    await db.destroy();
  });
});
```
Đường dẫn `/sign-in/oauth2`, `/refresh-token` và tên trường body đối chiếu `node_modules/better-auth/dist/plugins/generic-oauth/index.mjs` và `api/routes/account.mjs` trước khi chạy; ghi tên thật vào ADR. Partial update: thêm `await (await auth.$context).internalAdapter.updateAccount(<id account>, { scope: 'openid email' })` sau refresh và ghi thao tác.

- [ ] **Step 2: Chạy, ghi kết quả, dọn, commit**

Run: `pnpm vitest run --project integration test/integration/spike-sp2/s5-account-ops.spec.ts`

```markdown
### S5 — Thao tác trên `account`

| Luồng | Thao tác (model, where, keys, trong transaction?) |
|---|---|
| Đăng ký email | <…> |
| OAuth callback (liên kết/tạo) | <…> |
| Refresh token | <…> |
| Partial update | <…> |
| Đọc account qua `join` từ model khác | <có/không; hình dạng> |

**Kết luận:** adapter bọc <thấy đủ | thiếu …>. **Nhánh:** <`withAccountCipher` | fallback plugin Kysely (như S2a)>.
**Task bị ảnh hưởng nếu fallback:** Task 28, Task 34.
```
```bash
rm -rf test/integration/spike-sp2
git add docs/adr/0010-better-auth-and-auth-modes.md
git commit -m "docs(adr): record spike S5 (account operations through the wrapped adapter)"
```

---

### Task 6: Spike S6 (mjml 5.4.1 từ ESM, handlebars trong `href`, template vào `dist/` và image)

**Files:**
- Throwaway: `test/unit/spike-sp2/s6-mjml.spec.ts`, `src/modules/notifications/templates/spike/en/body.mjml`
- Modify: `docs/adr/0010-better-auth-and-auth-modes.md` (mục S6), `docs/adr/0013-build-toolchain.md` (số đo image)

**Interfaces:**
- Consumes: `mjml`, `handlebars` ở Task 1.
- Produces: cách import `mjml` từ ESM, xác nhận `validationLevel: 'strict'` ném lỗi với template sai, placeholder `{{url}}` trong `href` còn nguyên sau mjml, cấu hình `assets` của `nest-cli.json` đưa `templates/**` vào `dist/` và image. Task 21 dùng trực tiếp.

- [ ] **Step 1: Viết spike S6**

`src/modules/notifications/templates/spike/en/body.mjml` (THROWAWAY):
```xml
<mjml>
  <mj-body>
    <mj-section><mj-column>
      <mj-text>Hello {{name}}</mj-text>
      <mj-button href="{{url}}">Verify</mj-button>
    </mj-column></mj-section>
  </mj-body>
</mjml>
```
`test/unit/spike-sp2/s6-mjml.spec.ts` (THROWAWAY):
```ts
import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('S6: mjml 5 from ESM + handlebars', () => {
  it('compiles strictly and keeps {{url}} inside href', async () => {
    const src = readFileSync('src/modules/notifications/templates/spike/en/body.mjml', 'utf8');
    const out = await mjml2html(src, { validationLevel: 'strict', ignoreIncludes: true });
    expect(out.errors).toEqual([]);
    expect(out.html).toContain('href="{{url}}"');
    const tpl = Handlebars.create().compile(out.html, { strict: true, knownHelpersOnly: true });
    const html = tpl({ name: '<b>x</b>', url: 'https://app.example/verify?token=a&b=1' });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    // Handlebars escape cả `=` (`&#x3D;`) và `&`; trình duyệt giải mã entity trong thuộc tính, nên so sau khi decode.
    const href = /href="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(href.replaceAll('&#x3D;', '=').replaceAll('&amp;', '&')).toBe('https://app.example/verify?token=a&b=1');
  });
  it('strict validation rejects an invalid template', async () => {
    await expect(mjml2html('<mjml><mj-body><mj-bogus/></mj-body></mjml>', { validationLevel: 'strict' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Chạy spike và kiểm `dist/` + image**

Run:
```bash
pnpm vitest run --project unit test/unit/spike-sp2/s6-mjml.spec.ts
```
Sửa `nest-cli.json` (giữ các key đang có), trong `compilerOptions` thêm:
```json
"assets": [{ "include": "modules/*/templates/**/*", "outDir": "dist", "watchAssets": true }]
```
Run:
```bash
pnpm build && ls dist/modules/notifications/templates/spike/en/
BUILD=$(grep '^IMAGE_NODE_BUILD=' docker/images.env | cut -d= -f2-); RUNTIME=$(grep '^IMAGE_NODE_RUNTIME=' docker/images.env | cut -d= -f2-)
docker build --build-arg BUILD_IMAGE="$BUILD" --build-arg RUNTIME_IMAGE="$RUNTIME" -t nsb-spike-s6 .
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint /nodejs/bin/node nsb-spike-s6 -e "console.log(require('node:fs').readdirSync('/app/dist/modules/notifications/templates/spike/en'))"
docker image inspect nsb-spike-s6 --format '{{.Size}}'
docker image rm nsb-spike-s6
```
Expected: `body.mjml` có trong `dist/` và trong image; ghi kích thước image (so với số đo SP1 ở ADR 0013; vượt 200 MB thì báo Sếp kèm phương án `mjml-core` + `mjml-preset-core`).

- [ ] **Step 3: Ghi kết quả, dọn (giữ `assets` của `nest-cli.json`), commit**

```markdown
### S6 — mjml 5.4.1 + handlebars 4.7.9

- `import mjml2html from 'mjml'` từ ESM: <đạt>. API async, `validationLevel: 'strict'` ném lỗi với tag lạ: <đạt>.
- `{{url}}` trong `href` sau mjml: <còn nguyên | bị encode thành …>.
- Template vào `dist/` (`nest-cli.json` `assets`) và vào image: <đạt>. Kích thước image: <n> MB (SP1: <m> MB).

**Nhánh:** <mjml trước rồi handlebars | fallback handlebars trước rồi mjml cho mỗi email (cache theo template, render mỗi lần gửi)>.
**Task bị ảnh hưởng nếu fallback:** Task 21 (`MjmlHandlebarsRenderer.render` gọi `mjml2html` sau khi handlebars, không cache HTML).
```
```bash
rm -rf test/unit/spike-sp2 src/modules/notifications/templates/spike
git add nest-cli.json docs/adr/0010-better-auth-and-auth-modes.md docs/adr/0013-build-toolchain.md
git commit -m "docs(adr): record spike S6 (mjml esm + handlebars, templates in dist and image)"
```

---

### Task 7: Spike S7 (chống lộ email: `202` giống hệt giữa email mới và email đã có)

**Files:**
- Throwaway: `test/integration/spike-sp2/s7-enumeration.spec.ts`
- Modify: `docs/adr/0010-better-auth-and-auth-modes.md` (mục S7)

**Interfaces:**
- Consumes: package ở Task 1.
- Produces: cơ chế chống lộ email mà Task 33/34 cài đặt: (1) tính năng có sẵn `emailAndPassword.onExistingUserSignUp` của Better Auth 1.7.6 (`@better-auth/core/dist/types/init-options.d.mts:783`, chỉ chạy khi `requireEmailVerification: true` hoặc `autoSignIn: false`) cộng `hooks.after` chuẩn hoá thành `202` body rỗng; hoặc (2) `hooks.before` trả `new Response(null, { status: 202 })` dừng sớm; hoặc (3) fallback `disabledPaths` + route riêng.

- [ ] **Step 1: Viết spike S7**

`test/integration/spike-sp2/s7-enumeration.spec.ts` (THROWAWAY):
```ts
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthMiddleware } from 'better-auth/api';
import { describe, expect, it } from 'vitest';

const notices: string[] = [];
const verifications: string[] = [];
const IGNORED = new Set(['date', 'x-request-id']);
const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] };

const auth = betterAuth({
  secret: 'spike-secret-spike-secret-spike-secret-0123', baseURL: 'http://localhost:3000',
  database: memoryAdapter(db),
  emailAndPassword: {
    enabled: true, requireEmailVerification: true, autoSignIn: false,
    onExistingUserSignUp: async ({ user }) => { notices.push(user.email); },
  },
  emailVerification: { sendOnSignUp: true, sendVerificationEmail: async ({ user }) => { verifications.push(user.email); } },
  hooks: {
    after: createAuthMiddleware(async (c) => {
      if (c.path === '/sign-up/email' && !(c.context.returned instanceof Error))
        return new Response(null, { status: 202 });
    }),
  },
});

const signUp = (email: string) => auth.handler(new Request('http://localhost:3000/api/auth/sign-up/email', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
  body: JSON.stringify({ email, password: 'passw0rd-long', name: 'N' }),
}));
const shape = async (r: Response) => ({
  status: r.status,
  headers: [...r.headers.entries()].filter(([k]) => !IGNORED.has(k)).sort(),
  body: await r.text(),
});

describe('S7: indistinguishable 202', () => {
  it('new and existing email produce byte-identical responses', async () => {
    const first = await shape(await signUp('s7@example.com'));
    const again = await shape(await signUp('s7@example.com'));
    console.log('S7', JSON.stringify({ first, again, notices, verifications }));
    expect(first).toEqual(again);
    expect(first.status).toBe(202);
    expect(first.body).toBe('');
    expect(notices).toEqual(['s7@example.com']);
    expect(verifications).toEqual(['s7@example.com']);
  });
});
```
Nếu `after` không thay được status: thử nhánh (2) — `hooks.before` trên `/sign-up/email` tra email bằng `c.context.internalAdapter.findUserByEmail(email)`, gọi thông báo rồi `return new Response(null, { status: 202 })` — và ghi kết quả của cả hai nhánh. Kiểm thêm `/change-email` (email đích đã có) theo cùng cách với `user.changeEmail.enabled: true`.

- [ ] **Step 2: Chạy, ghi kết quả, dọn, commit**

Run: `pnpm vitest run --project integration test/integration/spike-sp2/s7-enumeration.spec.ts`

```markdown
### S7 — `202` giống hệt nhau

| Nhánh | Đăng ký | Đổi email | Ghi chú |
|---|---|---|---|
| (1) `onExistingUserSignUp` + `hooks.after` → `new Response(null, { status: 202 })` | <đạt/không> | <n/a> | hash giả do Better Auth tự chạy: <có/không> |
| (2) `hooks.before` dừng sớm `202` | <đạt/không> | <đạt/không> | |

**Nhánh đã chọn:** <(1) cho đăng ký + (2) cho đổi email | (2) cho cả hai | fallback `disabledPaths: ['/sign-up/email', '/change-email']` + `POST /v1/auth/sign-up`, `POST /v1/auth/change-email` gọi `auth.api.*`>.
**Task bị ảnh hưởng nếu fallback:** Task 34 (bỏ nhánh chống lộ email ở hook), Task 37 (thêm `AuthFlowsController` với hai route trên, `@PublicRoute()` cho sign-up, `@SessionOnly()` cho change-email), Task 38 và Task 40 (gọi route mới), Task 48 (`oasdiff` thấy hai route mới).
```
```bash
rm -rf test/integration/spike-sp2
git add docs/adr/0010-better-auth-and-auth-modes.md
git commit -m "docs(adr): record spike S7 (indistinguishable 202 for sign-up and change-email)"
```

---
## Phần B — Thay đổi tối thiểu ở `core/` (spec §5.1)

Mỗi dòng của bảng "Thay đổi ở `core/`" trong spec §5.1 là một task nhỏ có test riêng. `core` không bao giờ import `modules`.

### Task 8: `core/context` — credential trong `RequestContext` và trong log

**Files:**
- Modify: `src/core/context/principal.ts`, `src/core/context/context.keys.ts`, `src/core/context/request-context.ts`, `src/core/context/index.ts`, `src/core/logging/logging.module.ts`, `src/core/logging/index.ts`
- Test: `test/unit/core/context/request-context-credential.spec.ts`, `test/unit/core/logging/context-log-fields.spec.ts`

**Interfaces:**
- Consumes: `RequestContext`, `CTX`, `ClsService` (SP1).
- Produces:
  - `type CredentialKind = 'SESSION_COOKIE' | 'BEARER_SESSION' | 'API_KEY' | 'EXTERNAL_COOKIE' | 'EXTERNAL_BEARER'`, `CREDENTIAL_KINDS`, `type Credential = { kind: CredentialKind; id?: string }` (export từ `core/context/index.ts`).
  - `RequestContext.setCredential(c: Credential): void`, `RequestContext.credential(): Credential | undefined`.
  - `contextLogFields(cls: ClsService): Record<string, unknown>` (export từ `core/logging/index.ts`), dùng làm `mixin` của pino, có thêm trường `credential`.

- [ ] **Step 1: Viết test fail**

`test/unit/core/context/request-context-credential.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';

async function makeCtx(): Promise<RequestContext> {
  const mod = await Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true })],
    providers: [RequestContext],
  }).compile();
  return mod.get(RequestContext);
}

describe('RequestContext credential', () => {
  it('keeps the credential next to the principal (API key: principal is the owning user)', async () => {
    const ctx = await makeCtx();
    await ctx.run({}, async () => {
      ctx.setPrincipal({ type: 'user', id: 'u1' });
      ctx.setCredential({ kind: 'API_KEY', id: 'k1' });
      expect(ctx.principal()).toEqual({ type: 'user', id: 'u1' });
      expect(ctx.credential()).toEqual({ kind: 'API_KEY', id: 'k1' });
    });
  });
  it('is undefined outside a request context and in a fresh context', async () => {
    const ctx = await makeCtx();
    expect(ctx.credential()).toBeUndefined();
    await ctx.run({}, async () => expect(ctx.credential()).toBeUndefined());
  });
  it('fails loudly when set outside a CLS context', async () => {
    const ctx = await makeCtx();
    expect(() => ctx.setCredential({ kind: 'SESSION_COOKIE' })).toThrow();
  });
});
```
`test/unit/core/logging/context-log-fields.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';
import { contextLogFields } from '../../../../src/core/logging/index.js';

describe('contextLogFields', () => {
  it('adds the credential kind and id to every log line of the request', async () => {
    const mod = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [RequestContext],
    }).compile();
    const ctx = mod.get(RequestContext);
    const cls = mod.get(ClsService);
    await ctx.run({ requestId: 'r1' }, async () => {
      ctx.setCredential({ kind: 'API_KEY', id: 'key_123' });
      expect(contextLogFields(cls)).toMatchObject({
        requestId: 'r1',
        credential: { kind: 'API_KEY', id: 'key_123' },
      });
    });
    expect(contextLogFields(cls)).toEqual({});
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/core/context/request-context-credential.spec.ts test/unit/core/logging/context-log-fields.spec.ts`
Expected: FAIL — `setCredential is not a function`; `contextLogFields` không được export.

- [ ] **Step 3: Cài đặt**

`src/core/context/principal.ts`:
```ts
export type Principal = { type: 'user' | 'api_key' | 'service'; id: string };

/** Cách request chứng minh danh tính (spec SP2 §5.6.1). Principal luôn là user; kind + id của credential phục vụ log/audit. */
export const CREDENTIAL_KINDS = [
  'SESSION_COOKIE',
  'BEARER_SESSION',
  'API_KEY',
  'EXTERNAL_COOKIE',
  'EXTERNAL_BEARER',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** `id` chỉ có với API key (id của key, không phải bí mật). */
export type Credential = { kind: CredentialKind; id?: string };
```
`src/core/context/context.keys.ts`: thêm vào `CTX` (giữ quy ước khoá phẳng): `credential: 'core:credential',`.

`src/core/context/request-context.ts`: import `type Credential` từ `./principal.js`, thêm:
```ts
  credential(): Credential | undefined {
    return this.read<Credential>(CTX.credential);
  }
  setCredential(c: Credential): void {
    this.cls.set(CTX.credential, c);
  }
```
`src/core/context/index.ts`: thay dòng `export type { Principal } from './principal.js';` bằng:
```ts
export {
  CREDENTIAL_KINDS,
  type Credential,
  type CredentialKind,
  type Principal,
} from './principal.js';
```
`src/core/logging/logging.module.ts`: tách mixin thành hàm export, thêm `credential`:
```ts
/** Trường ngữ cảnh gắn vào mọi dòng log của request/job. Không có email hay token: chỉ id. */
export function contextLogFields(cls: ClsService): Record<string, unknown> {
  if (!cls.isActive()) return {};
  return {
    requestId: cls.get(CTX.requestId),
    traceId: cls.get(CTX.traceId),
    orgId: cls.get(CTX.orgId),
    jobId: cls.get(CTX.jobId),
    credential: cls.get(CTX.credential),
  };
}
```
và trong `pinoHttp` thay mixin cũ bằng `mixin: () => contextLogFields(cls),`.
`src/core/logging/index.ts`: `export { LoggingModule, contextLogFields } from './logging.module.js';`

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/core/context test/unit/core/logging && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/context src/core/logging test/unit/core/context/request-context-credential.spec.ts test/unit/core/logging/context-log-fields.spec.ts
git commit -m "feat(core/context): carry the request credential kind and id in context and logs"
```

---

### Task 9: `core/errors` + `core/http` — `problemBody`, `writeProblem`, parser JSON giới hạn theo stream

**Lý do (review B1):** body-parser 2.3.0 (dùng bởi `express.json` và `app.useBodyParser`) khi vượt `limit` gọi `dump(req)` và **chờ request kết thúc** mới trả 413 (`body-parser/lib/read.js:128-137`); body chunked vô hạn giữ socket mãi. `raw-body` 3.0.2 thì dừng ngay: `onData` cộng byte, vượt `limit` là gọi `done(createError(413, …, { type: 'entity.too.large' }))` → `cleanup()` + `halt(stream)` (unpipe + pause) rồi callback ngay (`raw-body/index.js:213-266`, đã đọc). Vì vậy parser JSON của core và của `/api/auth/*` dùng `raw-body` trực tiếp (package có sẵn, không tự đếm byte), rồi trả 413 và **đóng socket sau khi gửi xong response**, không chờ `end`.

**Files:**
- Create: `src/core/errors/problem-body.ts`, `src/core/http/content-type.ts`, `src/core/http/problem-writer.ts`, `src/core/http/json-body-parser.ts`
- Modify: `src/core/errors/problem-details.filter.ts`, `src/core/errors/index.ts`, `src/core/http/content-type.middleware.ts`, `src/core/http/index.ts`
- Test: `test/unit/core/errors/problem-body.spec.ts`, `test/unit/core/http/json-body-parser.spec.ts`

**Interfaces:**
- Consumes: `AppError`, `CoreErrors`, `httpConfig` (SP1); `raw-body` (Task 1).
- Produces:
  - `PROBLEM_JSON`, `type ProblemMeta = { instance: string; requestId: string; typeBase: string }`, `problemBody(err: AppError, meta: ProblemMeta, exposeDetail: boolean): Record<string, unknown>` (từ `core/errors`).
  - `writeProblem(res: ServerResponse, err: AppError, meta: ProblemMeta): void` (từ `core/http`): problem+json trên response Node thô; `413` kèm `Connection: close`.
  - `type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void`; `jsonBodyParser(cfg: ConfigOf<typeof httpConfig>, opts?: { skipPathPrefix?: string }): NodeMiddleware` (từ `core/http`): bỏ qua GET/HEAD, request không có body và path dưới `skipPathPrefix`; lỗi luôn là `next(AppError)` (`415` type/encoding/charset, `400` JSON hỏng hoặc không phải object/array, `413` vượt giới hạn — với 413 đã đặt `Connection: close` và huỷ socket khi response `finish`); thành công đặt `req.body` và `req.rawBody: Buffer`. Core dùng cho route Nest (Task 10), identity dùng cho `/api/auth/*` (Task 36).
  - `requestHasBody`, `mediaTypeOf`, `isAllowedContentType` (nội bộ `core/http`).

- [ ] **Step 1: Viết test fail**

`test/unit/core/errors/problem-body.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AppError, CoreErrors, problemBody } from '../../../../src/core/errors/index.js';

describe('problemBody', () => {
  const meta = { instance: '/api/auth/sign-in/email', requestId: 'r1', typeBase: '/errors' };
  it('builds the same shape as ProblemDetailsFilter', () => {
    const body = problemBody(new AppError(CoreErrors.PAYLOAD_TOO_LARGE, { detail: 'too big' }), meta, true);
    expect(body).toMatchObject({
      type: '/errors/payload-too-large', title: 'Payload too large', status: 413,
      code: 'payload_too_large', detail: 'too big', instance: '/api/auth/sign-in/email', requestId: 'r1',
    });
    expect(typeof body.timestamp).toBe('string');
  });
  it('hides detail when not exposed and adds field errors', () => {
    const body = problemBody(
      new AppError(CoreErrors.VALIDATION_FAILED, { detail: 'secret', fields: [{ path: 'email', code: 'invalid', message: 'bad' }] }),
      meta,
      false,
    );
    expect(body.detail).toBeUndefined();
    expect(body.errors).toEqual([{ path: 'email', code: 'invalid', message: 'bad' }]);
  });
});
```
`test/unit/core/http/json-body-parser.spec.ts`:
```ts
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, toAppError } from '../../../../src/core/errors/index.js';
import { httpConfig, jsonBodyParser, writeProblem } from '../../../../src/core/http/index.js';

const LIMIT_BYTES = 1024;
/** Giới hạn thời gian cho 413 của body vô hạn: parser phải trả lời khi còn đang nhận, không chờ `end`. */
const MAX_413_MS = 2000;
const CHUNK_INTERVAL_MS = 5;
const parsed = (r: IncomingMessage): { body: unknown; raw: string } | undefined =>
  'rawBody' in r && Buffer.isBuffer(r.rawBody) && 'body' in r ? { body: r.body, raw: r.rawBody.toString('utf8') } : undefined;

describe('jsonBodyParser (stream-limited, raw-body)', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const cfg = httpConfig.schema.parse({ bodyLimit: `${LIMIT_BYTES}b` });
    const mw = jsonBodyParser(cfg, { skipPathPrefix: '/skipped' });
    server = createServer((req, res) =>
      mw(req, res, (err) => {
        if (err) return writeProblem(res, err instanceof AppError ? err : toAppError(err), { instance: req.url ?? '', requestId: 'r-test', typeBase: '/errors' });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(parsed(req) ?? { body: null, raw: null }));
      }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  it('parses JSON and keeps the raw body', async () => {
    const res = await request(server).post('/x').send({ a: 1 }).expect(200);
    expect(res.body).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
  });
  it('skips GET, bodiless requests and the delegated path prefix', async () => {
    expect((await request(server).get('/x').expect(200)).body).toEqual({ body: null, raw: null });
    expect((await request(server).post('/skipped/sign-in').send({ a: 1 }).expect(200)).body).toEqual({ body: null, raw: null });
  });
  it.each([
    ['text/plain', 'text/plain', undefined, 415, 'unsupported_media_type'],
    ['gzip encoding', 'application/json', 'gzip', 415, 'unsupported_media_type'],
    ['latin1 charset', 'application/json; charset=latin1', undefined, 415, 'unsupported_media_type'],
  ])('%s → %s', async (_n, type, encoding, status, code) => {
    let r = request(server).post('/x').set('content-type', type);
    if (encoding) r = r.set('content-encoding', encoding);
    const res = await r.send('{"a":1}');
    expect([res.status, res.body.code]).toEqual([status, code]);
  });
  it.each(['{bad', '"just a string"', '42'])('400 malformed_request for %s (strict: object or array only)', async (body) => {
    const res = await request(server).post('/x').set('content-type', 'application/json').send(body).expect(400);
    expect(res.body.code).toBe('malformed_request');
  });
  it('413 when Content-Length exceeds the limit', async () => {
    const res = await request(server).post('/x').send({ pad: 'x'.repeat(LIMIT_BYTES * 2) }).expect(413);
    expect(res.body.code).toBe('payload_too_large');
  });
  it('413 for an UNBOUNDED chunked body within a bounded time, and the socket is closed', async () => {
    const started = Date.now();
    const result = await new Promise<{ status: number; connection: string | undefined; closed: boolean }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/x', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
      let status = 0; let connection: string | undefined;
      req.on('response', (res) => { status = res.statusCode ?? 0; connection = res.headers.connection; res.resume(); });
      req.on('error', () => undefined);
      req.on('close', () => resolve({ status, connection, closed: true }));
      req.write('{"pad":"');
      // Client không bao giờ kết thúc body: chỉ có server đóng socket mới dừng vòng ghi.
      const timer = setInterval(() => { if (!req.destroyed) req.write('x'.repeat(256)); }, CHUNK_INTERVAL_MS);
      req.on('close', () => clearInterval(timer));
      setTimeout(() => reject(new Error('no 413 / socket still open')), MAX_413_MS * 2);
    });
    expect(result).toEqual({ status: 413, connection: 'close', closed: true });
    expect(Date.now() - started).toBeLessThan(MAX_413_MS);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/core/errors/problem-body.spec.ts test/unit/core/http/json-body-parser.spec.ts`
Expected: FAIL — `problemBody`/`jsonBodyParser` không tồn tại.

- [ ] **Step 3: Cài đặt**

`src/core/errors/problem-body.ts`:
```ts
import type { AppError } from './app-error.js';

export const PROBLEM_JSON = 'application/problem+json';
export type ProblemMeta = { instance: string; requestId: string; typeBase: string };

/**
 * Thân problem+json (RFC 9457) dùng chung cho `ProblemDetailsFilter` (route Nest) và `writeProblem`
 * (middleware Node tự trả response, vd. `/api/auth/*`), để hai đường không lệch hình dạng.
 */
export function problemBody(err: AppError, meta: ProblemMeta, exposeDetail: boolean): Record<string, unknown> {
  const { error, opts } = err;
  return {
    type: `${meta.typeBase}/${error.code.replaceAll('_', '-')}`,
    title: error.title,
    status: error.status,
    code: error.code,
    ...(exposeDetail && opts.detail ? { detail: opts.detail } : {}),
    instance: meta.instance,
    requestId: meta.requestId,
    timestamp: new Date().toISOString(),
    ...(opts.fields?.length ? { errors: opts.fields } : {}),
  };
}
```
`src/core/errors/problem-details.filter.ts`: xoá hằng `PROBLEM_JSON` cục bộ, import `PROBLEM_JSON, problemBody` từ `./problem-body.js`; đổi `const { error, opts } = toAppError(exception);` thành `const appError = toAppError(exception); const { error, opts } = appError;` và thay object literal truyền cho `httpAdapter.reply` bằng:
```ts
      problemBody(
        appError,
        {
          instance: String(httpAdapter.getRequestUrl(req)).split('?')[0] ?? '',
          requestId: this.ctx.requestId(),
          typeBase: this.cfg.problemTypeBase,
        },
        exposeDetail,
      ),
```
`src/core/errors/index.ts`: thêm `export { PROBLEM_JSON, problemBody, type ProblemMeta } from './problem-body.js';`

`src/core/http/content-type.ts`:
```ts
type RawHeaders = Record<string, string | string[] | undefined>;

export const firstHeader = (h: RawHeaders, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Body có mặt khi Content-Length > 0 hoặc có Transfer-Encoding (chunked). */
export const requestHasBody = (h: RawHeaders): boolean =>
  Number(firstHeader(h, 'content-length') ?? 0) > 0 || firstHeader(h, 'transfer-encoding') !== undefined;

/** Media type chữ thường, bỏ tham số (`; charset=…`). */
export const mediaTypeOf = (h: RawHeaders): string =>
  (firstHeader(h, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();

/** Tham số `charset` (chữ thường), `undefined` nếu không có. */
export const charsetOf = (h: RawHeaders): string | undefined =>
  /;\s*charset="?([^";]+)"?/i.exec(firstHeader(h, 'content-type') ?? '')?.[1]?.trim().toLowerCase();

export const isAllowedContentType = (h: RawHeaders, allowed: readonly string[]): boolean =>
  allowed.includes(mediaTypeOf(h));
```
`src/core/http/content-type.middleware.ts`: xoá hàm `header()` cục bộ; `use` dùng helper chung:
```ts
  use(req: RequestLike, _res: unknown, next: (err?: unknown) => void): void {
    if (!METHODS_WITH_BODY.has(req.method) || !requestHasBody(req.headers)) return next();
    if (!isAllowedContentType(req.headers, this.cfg.allowedContentTypes))
      return next(
        new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, {
          detail: `Content-Type must be one of: ${this.cfg.allowedContentTypes.join(', ')}`,
        }),
      );
    next();
  }
```
`src/core/http/problem-writer.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { PROBLEM_JSON, problemBody, type AppError, type ProblemMeta } from '../errors/index.js';

/**
 * Ghi problem+json cho middleware Node tự kết thúc response. `413`: `Connection: close` (client đang stream
 * body quá cỡ không được giữ socket). Header đã gửi thì huỷ socket (không đổi status được nữa).
 */
export function writeProblem(res: ServerResponse, err: AppError, meta: ProblemMeta): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const [k, v] of Object.entries(err.opts.headers ?? {})) res.setHeader(k, v);
  if (err.error.status === HttpStatus.PAYLOAD_TOO_LARGE) res.setHeader('Connection', 'close');
  res.statusCode = err.error.status;
  res.setHeader('Content-Type', PROBLEM_JSON);
  res.end(JSON.stringify(problemBody(err, meta, true)));
}
```
`src/core/http/json-body-parser.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import getRawBody from 'raw-body';
import { type ConfigOf } from '../config/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { charsetOf, firstHeader, isAllowedContentType, requestHasBody } from './content-type.js';
import type { httpConfig } from './http.config.js';

export type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const UTF8 = 'utf-8';
const IDENTITY = 'identity';
/** Như `strict: true` của body-parser: chỉ nhận object hoặc array ở gốc. */
const STRICT_JSON_START = /^[\s]*[{[]/;
/** Thời gian chờ client tự đóng sau FIN của 413 trước khi huỷ socket (review NM3). */
const SOCKET_CLOSE_GRACE_MS = 1000;
const RAW_BODY_TOO_LARGE = 'entity.too.large';

const isRawBodyError = (e: unknown): e is Error & { type?: string } => e instanceof Error;

/**
 * Parser JSON giới hạn theo STREAM (review B1): `raw-body` đếm byte khi dữ liệu còn đang tới và dừng ngay khi
 * vượt `HTTP_BODY_LIMIT` (unpipe + pause), kể cả body chunked không có Content-Length. Khi đó response 413
 * mang `Connection: close` và socket bị huỷ ngay sau khi response gửi xong — không đọc tiếp, không chờ `end`.
 * Chỉ nhận body `identity`, `utf-8`, JSON object/array; lỗi luôn đi qua `next(AppError)`.
 */
export function jsonBodyParser(cfg: ConfigOf<typeof httpConfig>, opts: { skipPathPrefix?: string } = {}): NodeMiddleware {
  const prefix = opts.skipPathPrefix;
  const unsupported = (detail: string) => new AppError(CoreErrors.UNSUPPORTED_MEDIA_TYPE, { detail });
  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) return next();
    if (METHODS_WITHOUT_BODY.has(req.method ?? '') || !requestHasBody(req.headers)) return next();
    if (!isAllowedContentType(req.headers, cfg.allowedContentTypes))
      return next(unsupported(`Content-Type must be one of: ${cfg.allowedContentTypes.join(', ')}`));
    if ((firstHeader(req.headers, 'content-encoding') ?? IDENTITY).toLowerCase() !== IDENTITY)
      return next(unsupported('Content-Encoding must be identity'));
    if ((charsetOf(req.headers) ?? UTF8) !== UTF8) return next(unsupported('charset must be utf-8'));
    getRawBody(req, { limit: cfg.bodyLimit, length: firstHeader(req.headers, 'content-length') }, (err, buf) => {
      if (err) {
        if (isRawBodyError(err) && err.type === RAW_BODY_TOO_LARGE) {
          res.setHeader('Connection', 'close');
          // Review NM3: `destroy()` ngay khi client còn gửi có thể làm kernel gửi RST và client mất 413 đã nhận.
          // `end()` gửi FIN sau response; client đóng theo `Connection: close`. Hạn chót cứng nếu client không đóng.
          res.once('finish', () => {
            req.socket.end();
            setTimeout(() => req.socket.destroy(), SOCKET_CLOSE_GRACE_MS).unref();
          });
          return next(new AppError(CoreErrors.PAYLOAD_TOO_LARGE, { detail: `Body exceeds ${cfg.bodyLimit}` }));
        }
        // Client huỷ giữa chừng, Content-Length sai…: request không đọc được.
        return next(new AppError(CoreErrors.MALFORMED_REQUEST, { detail: 'Request body could not be read' }));
      }
      const text = buf.toString('utf8');
      let body: unknown;
      try {
        if (!STRICT_JSON_START.test(text)) throw new SyntaxError('not an object or array');
        body = JSON.parse(text);
      } catch {
        return next(new AppError(CoreErrors.MALFORMED_REQUEST, { detail: 'Request body must be a JSON object or array' }));
      }
      Object.assign(req, { body, rawBody: buf });
      next();
    });
  };
}
```
(Kiểu của callback `getRawBody` lấy từ `raw-body/index.d.ts` (package tự ship types): `err` là `RawBodyError`; nếu kiểu khác thì giữ type guard `isRawBodyError`, không cast.)

`src/core/http/index.ts`: thêm
```ts
export { writeProblem } from './problem-writer.js';
export { jsonBodyParser, type NodeMiddleware } from './json-body-parser.js';
```

- [ ] **Step 4: Chạy test, xác nhận xanh (kể cả hồi quy SP1)**

Run:
```bash
pnpm vitest run --project unit test/unit/core/errors test/unit/core/http
pnpm vitest run --project integration test/e2e/core/errors-and-context.e2e.spec.ts
pnpm typecheck && pnpm lint && pnpm arch
```
Expected: PASS (test 413 chunked kết thúc dưới `MAX_413_MS`). `http-conventions.e2e` chạy lại ở Task 10 sau khi core chuyển sang parser này.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors src/core/http test/unit/core/errors/problem-body.spec.ts test/unit/core/http/json-body-parser.spec.ts
git commit -m "feat(core/http): stream-limited json body parser (raw-body) with early 413 and shared problem writer"
```

---

### Task 10: `core/http` — `@PublicRoute()`, parser giới hạn theo stream cho route Nest, uỷ quyền prefix, `main.api` `bodyParser: false`

**Files:**
- Create: `src/core/http/public-route.decorator.ts`, `src/core/http/body-parser-policy.ts`
- Modify: `src/core/http/http.module.ts`, `src/core/http/http-bootstrap.ts`, `src/core/http/index.ts`, `src/core/health/health.controller.ts`, `src/main.api.ts`, `test/support/app-factory.ts`
- Test: `test/unit/core/http/public-route.spec.ts`, `test/e2e/core/body-parser-ownership.e2e.spec.ts`

**Interfaces:**
- Consumes: `jsonBodyParser` (Task 9); `applyHttpDefaults`, `HttpModule`, `createTestApp` (SP1).
- Produces:
  - `PUBLIC_ROUTE = 'core:publicRoute'`, `PublicRoute(): ClassDecorator & MethodDecorator` (từ `core/http`). `AuthGuard` (Task 37) đọc metadata này; `HealthController` gắn sẵn.
  - `HTTP_BODY_PARSER_SKIP_PREFIX: symbol` (từ `core/http`): module nào tự đọc body cho một prefix (identity: `AUTH_BASE_PATH`, vì spec §5.5 đòi kiểm đa credential và CSRF TRƯỚC khi đọc body) cung cấp token này (provider global, giá trị là prefix). `BodyParserPolicy.skipPrefix(): string | undefined` (nội bộ `core/http`).
  - `applyHttpDefaults` đăng ký `jsonBodyParser(cfg, { skipPathPrefix })` bằng `app.use` thay cho `app.useBodyParser` (body-parser chờ `end` khi vượt limit — review B1). Route Nest có 413 sớm cho body chunked.
  - `createTestApp(imports, { beforeInit?, bodyParser? })`: `bodyParser: false` tạo app giống `main.api.ts`.

- [ ] **Step 1: Viết test fail**

`test/unit/core/http/public-route.spec.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../../../../src/core/health/health.controller.js';
import { PUBLIC_ROUTE, PublicRoute } from '../../../../src/core/http/index.js';

@Controller('x')
class X {
  @PublicRoute()
  @Get('open')
  open() { return 1; }
  @Get('closed')
  closed() { return 2; }
}

describe('@PublicRoute()', () => {
  const r = new Reflector();
  it('marks methods and classes', () => {
    expect(r.getAllAndOverride(PUBLIC_ROUTE, [X.prototype.open, X])).toBe(true);
    expect(r.getAllAndOverride(PUBLIC_ROUTE, [X.prototype.closed, X])).toBeUndefined();
  });
  it('health probes are public (the default-deny AuthGuard must never touch them)', () => {
    expect(r.get(PUBLIC_ROUTE, HealthController)).toBe(true);
  });
});
```
`test/e2e/core/body-parser-ownership.e2e.spec.ts`:
```ts
import { Body, Controller, Global, Module, Post, Req, type INestApplication } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTP_BODY_PARSER_SKIP_PREFIX, HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const LIMIT_BYTES = 2048;
const MAX_413_MS = 2000;
@Controller()
class EchoController {
  @Post('echo') echo(@Body() body: unknown, @Req() req: { rawBody?: Buffer }) { return { body: body ?? null, raw: req.rawBody?.toString('utf8') ?? null }; }
  @Post('owned/echo') owned(@Body() body: unknown) { return { body: body ?? null }; }
}
@Module({ controllers: [EchoController] })
class EchoModule {}
@Global()
@Module({ providers: [{ provide: HTTP_BODY_PARSER_SKIP_PREFIX, useValue: '/owned' }], exports: [HTTP_BODY_PARSER_SKIP_PREFIX] })
class OwnerModule {}

describe('body parser ownership and stream-level limit on Nest routes', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });
  const make = async (extra: unknown[] = []) => {
    vi.stubEnv('HTTP_BODY_LIMIT', `${LIMIT_BYTES}b`);
    app = await createTestApp([RedisModule, HttpModule, EchoModule, ...extra.filter((m): m is typeof OwnerModule => typeof m === 'function')], { beforeInit: applyHttpDefaults, bodyParser: false });
    return app;
  };

  it('core parses JSON (with rawBody) everywhere when no module owns a prefix', async () => {
    const a = await make();
    expect((await request(a.getHttpServer()).post('/echo').send({ a: 1 }).expect(201)).body).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
  });
  it('core skips the prefix owned by another module', async () => {
    const a = await make([OwnerModule]);
    expect((await request(a.getHttpServer()).post('/owned/echo').send({ a: 1 }).expect(201)).body).toEqual({ body: null });
    expect((await request(a.getHttpServer()).post('/echo').send({ a: 1 }).expect(201)).body.body).toEqual({ a: 1 });
  });
  it('an unbounded chunked body on a Nest route → problem+json 413 within a bounded time, socket closed', async () => {
    const a = await make();
    await a.listen(0, '127.0.0.1');
    const port = (a.getHttpServer().address() as AddressInfo).port;
    const started = Date.now();
    const result = await new Promise<{ status: number; type: string | undefined }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/echo', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
      let status = 0; let type: string | undefined;
      req.on('response', (res) => { status = res.statusCode ?? 0; type = res.headers['content-type']; res.resume(); });
      req.on('error', () => undefined);
      req.on('close', () => resolve({ status, type }));
      req.write('{"pad":"');
      const timer = setInterval(() => { if (!req.destroyed) req.write('x'.repeat(512)); }, 5);
      req.on('close', () => clearInterval(timer));
      setTimeout(() => reject(new Error('no 413 / socket still open')), MAX_413_MS * 2);
    });
    expect(result).toEqual({ status: 413, type: expect.stringContaining('application/problem+json') });
    expect(Date.now() - started).toBeLessThan(MAX_413_MS);
  });
});
```
(`make([OwnerModule])` nhận class module; bộ lọc `typeof m === 'function'` chỉ để giữ kiểu mà không cast.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/core/http/public-route.spec.ts && pnpm vitest run --project integration test/e2e/core/body-parser-ownership.e2e.spec.ts`
Expected: FAIL — `PUBLIC_ROUTE`, `HTTP_BODY_PARSER_SKIP_PREFIX` chưa có; body chunked không có 413 (body-parser chờ `end`).

- [ ] **Step 3: Cài đặt**

`src/core/http/public-route.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'core:publicRoute';

/**
 * Route không cần xác thực. Guard xác thực (identity) chặn mặc định mọi route không gắn decorator này.
 * Request mang credential sai vẫn bị 401 kể cả trên route public (review I7, Task 37).
 */
export const PublicRoute = (): ClassDecorator & MethodDecorator => SetMetadata(PUBLIC_ROUTE, true);
```
`src/core/http/body-parser-policy.ts`:
```ts
import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * Prefix mà một module tự đọc body (identity: `AUTH_BASE_PATH`, vì phải kiểm đa credential và CSRF trước khi
 * đọc body — spec §5.5). Provider global, giá trị là prefix. Core bỏ qua prefix đó.
 */
export const HTTP_BODY_PARSER_SKIP_PREFIX = Symbol('core.http.bodyParserSkipPrefix');

@Injectable()
export class BodyParserPolicy {
  constructor(@Optional() @Inject(HTTP_BODY_PARSER_SKIP_PREFIX) private readonly prefix?: string) {}

  skipPrefix(): string | undefined {
    return this.prefix;
  }
}
```
`src/core/http/http.module.ts`: thêm `BodyParserPolicy` vào `providers` và `exports`.

`src/core/http/http-bootstrap.ts`: import `BodyParserPolicy`, `jsonBodyParser`; thay khối `app.useBodyParser('json', …)` bằng:
```ts
  // Không dùng `useBodyParser` (body-parser chờ hết body khi vượt limit, review B1): parser giới hạn theo stream.
  app.use(jsonBodyParser(cfg, { skipPathPrefix: app.get(BodyParserPolicy).skipPrefix() }));
```
Sửa chú thích đầu hàm: "App tạo với `bodyParser: false` (main.api.ts); parser JSON của core (`jsonBodyParser`, `raw-body`) đăng ký bằng `app.use`, trả lỗi qua `next(AppError)` để `ProblemDetailsFilter` render như mọi lỗi khác."

`src/core/http/index.ts`:
```ts
export { PUBLIC_ROUTE, PublicRoute } from './public-route.decorator.js';
export { HTTP_BODY_PARSER_SKIP_PREFIX } from './body-parser-policy.js';
```
`src/core/health/health.controller.ts`: import `PublicRoute` từ `../http/index.js`, gắn `@PublicRoute()` lên class (cạnh `@SkipRateLimit()`).

`src/main.api.ts`: `NestFactory.create(AppApiModule, { bufferLogs: true, bodyParser: false })`, chú thích: "`bodyParser: false`: parser JSON do `applyHttpDefaults` đăng ký (giới hạn theo stream); `/api/auth/*` do identity tự đọc (spec §5.5)." (Bỏ `rawBody: true`: `req.rawBody` do `jsonBodyParser` đặt.)

`test/support/app-factory.ts`:
```ts
export async function createTestApp(
  imports: ModuleImport[],
  opts: { beforeInit?: (app: INestApplication) => void; bodyParser?: boolean } = {},
): Promise<INestApplication> {
  // … như cũ …
  const app = moduleRef.createNestApplication({
    rawBody: true,
    ...(opts.bodyParser === false ? { bodyParser: false } : {}),
  });
```

- [ ] **Step 4: Chạy test, xác nhận xanh (kể cả hồi quy SP1)**

Run:
```bash
pnpm vitest run --project unit test/unit/core/http
pnpm vitest run --project integration test/e2e/core
pnpm typecheck && pnpm lint && pnpm arch
```
Expected: PASS; mọi e2e SP1 (413/415/400/rawBody/merge-patch/CORS) vẫn xanh với parser mới.

- [ ] **Step 5: Commit**

```bash
git add src/core/http src/core/health/health.controller.ts src/main.api.ts test/support/app-factory.ts test/unit/core/http/public-route.spec.ts test/e2e/core/body-parser-ownership.e2e.spec.ts
git commit -m "feat(core/http): @PublicRoute, stream-limited parser for Nest routes, prefix ownership for self-read bodies"
```

---

### Task 11: `core/health` — readiness contributor của module

**Files:**
- Create: `src/core/health/readiness-contributor.ts`
- Modify: `src/core/health/readiness.ts`, `src/core/health/health.module.ts`, `src/core/health/index.ts`
- Test: `test/e2e/core/health-contributors.e2e.spec.ts`

**Interfaces:**
- Consumes: `Readiness`, `HealthModule`, `DiscoveryService` (Nest).
- Produces: `interface ReadinessProbe { probe(): Promise<void> }`, decorator `@ReadinessContributor(key: string)` (từ `core/health`). Nest không có multi-provider nên dùng cùng mẫu Discovery như `@JobHandler` — đây là cách hiện thực "multi-provider `READINESS_CONTRIBUTORS`" của spec §5.1. Key khớp `^[a-z][a-z0-9_]*$`, không trùng nhau, không trùng `database`/`redis`. Identity dùng key `auth_database` (Task 27).

- [ ] **Step 1: Viết test fail**

`test/e2e/core/health-contributors.e2e.spec.ts`:
```ts
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { HealthModule, ReadinessContributor, type ReadinessProbe } from '../../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const state = { up: true };
@Injectable()
@ReadinessContributor('fake_dependency')
class FakeProbe implements ReadinessProbe {
  async probe(): Promise<void> {
    if (!state.up) throw new Error('fake dependency down');
  }
}
@Module({ providers: [FakeProbe] })
class FakeModule {}

@Injectable()
@ReadinessContributor('database')
class Clashing implements ReadinessProbe {
  async probe(): Promise<void> {}
}
@Module({ providers: [Clashing] })
class ClashingModule {}

const base = () => [DatabaseModule.forRoot({ relay: false }), RedisModule, HttpModule, HealthModule.forRoot({ http: true })];

describe('readiness contributors', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp([...base(), FakeModule], { beforeInit: applyHttpDefaults }); });
  afterAll(async () => app?.close());

  it('ready includes the contributor and turns 503 when it fails, without leaking its error', async () => {
    state.up = true;
    const ok = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(ok.body.info).toHaveProperty('fake_dependency');
    state.up = false;
    const down = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(down.body.code).toBe('service_unavailable');
    expect(JSON.stringify(down.body)).not.toContain('fake dependency down');
    state.up = true;
  });
  it('rejects a contributor key that shadows a core check', async () => {
    await expect(createTestApp([...base(), ClashingModule], { beforeInit: applyHttpDefaults }))
      .rejects.toThrow(/readiness contributor key "database"/);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/e2e/core/health-contributors.e2e.spec.ts`
Expected: FAIL — `ReadinessContributor` chưa được export.

- [ ] **Step 3: Cài đặt**

`src/core/health/readiness-contributor.ts`:
```ts
import { DiscoveryService } from '@nestjs/core';

/** Phụ thuộc do module sở hữu (vd. pool `auth_user` của identity); `core` không import module. */
export interface ReadinessProbe {
  probe(): Promise<void>;
}

export const ReadinessContributorMarker = DiscoveryService.createDecorator<string>();

/** Gắn lên provider singleton cài `ReadinessProbe`; `key` là tên indicator trong kết quả ready. */
export const ReadinessContributor = (key: string): ClassDecorator => ReadinessContributorMarker(key);

export const isReadinessProbe = (v: unknown): v is ReadinessProbe =>
  typeof v === 'object' && v !== null && 'probe' in v && typeof v.probe === 'function';
```
`src/core/health/readiness.ts` (giữ phần kiểm tra của core, thêm contributor):
```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { type ConfigOf } from '../config/index.js';
import { Db } from '../database/index.js';
import { REDIS, type RedisClient } from '../redis/index.js';
import { healthConfig } from './health.config.js';
import { ReadinessContributorMarker, isReadinessProbe, type ReadinessProbe } from './readiness-contributor.js';

export type ReadinessCheck = 'database' | 'redis';
export const READINESS_CHECKS = Symbol('core.health.readinessChecks');
const CORE_CHECKS: readonly string[] = ['database', 'redis'];
const CONTRIBUTOR_KEY = /^[a-z][a-z0-9_]*$/;

export const readinessChecksFor = (opts: { http: boolean }): readonly ReadinessCheck[] =>
  opts.http ? ['database'] : ['database', 'redis'];

@Injectable()
export class Readiness implements OnModuleInit {
  private readonly contributors = new Map<string, ReadinessProbe>();

  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly db: Db,
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(healthConfig.KEY) private readonly cfg: ConfigOf<typeof healthConfig>,
    @Inject(READINESS_CHECKS) private readonly checks: readonly ReadinessCheck[],
    private readonly discovery: DiscoveryService,
  ) {}

  /** Validate một lần lúc boot: key sai hoặc trùng là lỗi cấu hình. */
  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({ metadataKey: ReadinessContributorMarker.KEY })) {
      const key = this.discovery.getMetadataByDecorator(ReadinessContributorMarker, wrapper);
      if (!key) continue;
      if (!CONTRIBUTOR_KEY.test(key) || CORE_CHECKS.includes(key) || this.contributors.has(key))
        throw new Error(`Invalid or duplicate readiness contributor key "${key}": it must match ${CONTRIBUTOR_KEY}, be unique and not shadow a core check`);
      if (!wrapper.isDependencyTreeStatic() || !isReadinessProbe(wrapper.instance))
        throw new Error(`@ReadinessContributor(${key}) must be a singleton provider implementing probe()`);
      this.contributors.set(key, wrapper.instance);
    }
  }

  indicators(): (() => Promise<HealthIndicatorResult>)[] {
    return [
      ...this.checks.map((check) => () => this.core(check)),
      ...[...this.contributors].map(([key, p]) => () => this.attempt(key, () => p.probe())),
    ];
  }

  private core(check: ReadinessCheck): Promise<HealthIndicatorResult> {
    const run = async (): Promise<void> => {
      switch (check) {
        case 'database':
          await this.db.execute('SELECT 1');
          return;
        case 'redis':
          await this.redis.ping();
          return;
        default: {
          const unknown: never = check;
          throw new Error(`unknown readiness check "${String(unknown)}"`);
        }
      }
    };
    return this.attempt(check, run);
  }

  private attempt(key: string, run: () => Promise<void>): Promise<HealthIndicatorResult> {
    return Promise.resolve(this.indicator.check(key).attempt(run).withTimeout(this.cfg.checkTimeoutMs));
  }
}
```
(giữ nguyên chú thích R21 của SP1 phía trên `readinessChecksFor`.)

`src/core/health/health.module.ts`: `imports: [TerminusModule.forRoot({ logger: false }), DiscoveryModule]` (import `DiscoveryModule` từ `@nestjs/core`).
`src/core/health/index.ts`: thêm `export { ReadinessContributor, type ReadinessProbe } from './readiness-contributor.js';`

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/e2e/core/health-contributors.e2e.spec.ts test/e2e/core/health.e2e.spec.ts test/integration/core/health && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/health test/e2e/core/health-contributors.e2e.spec.ts
git commit -m "feat(core/health): module-owned readiness contributors discovered by decorator"
```

---

### Task 12: `core/outbox` + `core/events` — ghi event có id xác định trước, idempotent (`ifAbsent`)

**Files:**
- Modify: `src/core/outbox/outbox.writer.ts`, `src/core/events/event-publisher.ts`
- Test: `test/integration/core/outbox/outbox-if-absent.spec.ts`

**Interfaces:**
- Consumes: `OutboxWriter`, `EventPublisher`, `UnitOfWork` (SP1).
- Produces:
  - `OutboxWriter.append(e: NewOutboxEvent, opts?: { ifAbsent?: boolean }): Promise<void>` — `ifAbsent: true` sinh `INSERT … ON CONFLICT DO NOTHING` (không có conflict target nên `app_user` chỉ cần `INSERT`).
  - `EventPublisher.publish(def, input: { data; aggregate; actor; causationId?; eventId?: string }, opts?: { ifAbsent?: boolean }): Promise<string>` — `eventId` cho phép id xác định trước (D10: v5), vẫn qua đúng validate envelope và dựng header như mọi event khác. Task 32 dùng cho `identity.user.registered`. (Spec §5.1 chỉ ghi `OutboxWriter`; thêm tham số ở `EventPublisher` để identity không phải tự dựng header của envelope — lệch nhỏ, ghi vào ADR 0006 ở Task 49.)

- [ ] **Step 1: Viết test fail**

`test/integration/core/outbox/outbox-if-absent.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v5, v7 } from 'uuid';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule, UnitOfWork } from '../../../../src/core/database/index.js';
import { EventPublisher, EventsModule, defineEvent } from '../../../../src/core/events/index.js';
import { OutboxModule, OutboxWriter, type NewOutboxEvent } from '../../../../src/core/outbox/index.js';
import { QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';

const FixtureHappened = defineEvent({ type: 'test.fixture.registered', version: 1, schema: z.object({ id: z.string() }) });
const event = (eventId: string): NewOutboxEvent => ({
  eventId, type: 'test.fixture.happened', version: 1, orgId: null,
  aggregate: { type: 'fixture', id: 'a1', version: 1 }, payload: {}, headers: {},
});

describe('idempotent event writes (as app_user)', () => {
  let app: INestApplication;
  let owner: pg.Client;
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }),
    ]);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); });

  const count = async (id: string) =>
    (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox_events WHERE event_id = $1', [id])).rows[0]!.n;

  it('OutboxWriter: a second append with the same event id is a no-op', async () => {
    const id = v7();
    const uow = app.get(UnitOfWork);
    const outbox = app.get(OutboxWriter);
    await uow.run(() => outbox.append(event(id), { ifAbsent: true }));
    await uow.run(() => outbox.append(event(id), { ifAbsent: true }));
    expect(await count(id)).toBe(1);
  });
  it('OutboxWriter: without ifAbsent a duplicate still fails loudly (23505)', async () => {
    const id = v7();
    const uow = app.get(UnitOfWork);
    const outbox = app.get(OutboxWriter);
    await uow.run(() => outbox.append(event(id)));
    await expect(uow.run(() => outbox.append(event(id)))).rejects.toThrow(/duplicate key|unique/i);
    expect(await count(id)).toBe(1);
  });
  it('EventPublisher: a predetermined (v5) event id is kept and deduplicated with ifAbsent', async () => {
    const id = v5(`test.fixture.registered:${v7()}`, v5.URL);
    const uow = app.get(UnitOfWork);
    const pub = app.get(EventPublisher);
    const input = { eventId: id, data: { id: 'x' }, aggregate: { type: 'fixture', id: 'x', version: 1 }, actor: { type: 'system' as const, id: 'test' } };
    expect(await uow.run(() => pub.publish(FixtureHappened, input, { ifAbsent: true }))).toBe(id);
    await uow.run(() => pub.publish(FixtureHappened, input, { ifAbsent: true }));
    expect(await count(id)).toBe(1);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/core/outbox/outbox-if-absent.spec.ts`
Expected: FAIL — lần append thứ hai ném `duplicate key`; `publish` không nhận `eventId`.

- [ ] **Step 3: Cài đặt**

`src/core/outbox/outbox.writer.ts`:
```ts
  /**
   * `ifAbsent`: event id xác định trước (vd. v5 theo aggregate, D10 của SP2) có thể được ghi lại bởi
   * after-hook và cron đối soát; bản ghi sau là no-op. Không có conflict target nên `app_user` chỉ cần
   * INSERT (không cần SELECT); UNIQUE(event_id) là cơ chế chống trùng.
   */
  async append(e: NewOutboxEvent, opts: { ifAbsent?: boolean } = {}): Promise<void> {
    // … kiểm tra transaction, RelayedFields và org giữ nguyên …
    await this.db.execute(
      `INSERT INTO outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)${opts.ifAbsent ? ' ON CONFLICT DO NOTHING' : ''}`,
      [
        e.eventId,
        e.type,
        e.version,
        e.orgId,
        e.aggregate.type,
        e.aggregate.id,
        e.aggregate.version,
        JSON.stringify(e.payload),
        JSON.stringify(e.headers),
      ],
    );
  }
```
`src/core/events/event-publisher.ts`: chữ ký và hai dòng thay đổi (phần còn lại giữ nguyên):
```ts
  /**
   * `input.eventId`: id xác định trước (vd. v5 theo aggregate) cho event có thể được phát lại bởi nhiều
   * đường (after-hook + cron đối soát); kết hợp `opts.ifAbsent` để lần ghi sau là no-op. Mặc định v7.
   */
  async publish<S extends z.ZodType>(
    def: EventDef<S>,
    input: {
      data: z.infer<S>;
      aggregate: { type: string; id: string; version: number };
      actor: EventActor;
      causationId?: string;
      eventId?: string;
    },
    opts: { ifAbsent?: boolean } = {},
  ): Promise<string> {
```
trong `this.validated(def, { … })`: `id: input.eventId ?? v7(),`; và lời gọi ghi: `await this.outbox.append({ … }, { ifAbsent: opts.ifAbsent });`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/core/outbox test/e2e/core/events.e2e.spec.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/outbox/outbox.writer.ts src/core/events/event-publisher.ts test/integration/core/outbox/outbox-if-absent.spec.ts
git commit -m "feat(core/outbox): idempotent writes for events with predetermined ids"
```

---

### Task 13: `core/resilience` — `signal` của caller và `toWebFetch`

**Files:**
- Create: `src/core/resilience/web-fetch.ts`
- Modify: `src/core/resilience/http-client.ts`, `src/core/resilience/index.ts`
- Test: `test/integration/core/resilience/web-fetch.spec.ts`

**Interfaces:**
- Consumes: `HttpClient`, `SsrfBlockedError`, `ResilienceModule` (SP1).
- Produces:
  - `HttpRequestInit.signal?: AbortSignal`: kết hợp với timeout của policy bằng `AbortSignal.any`; caller huỷ thì request bị huỷ thật và lỗi ném ra là `signal.reason` của caller (không bọc thành `UpstreamError`), để `jose` nhận ra timeout của nó.
  - `type WebFetchInit = { method?: string; headers?: Headers; redirect?: 'manual' | 'follow' | 'error'; signal?: AbortSignal }`, `type WebFetch = (url: string, init?: WebFetchInit) => Promise<Response>`, `toWebFetch(client: HttpClient, provider: string): WebFetch` (từ `core/resilience`). Tương thích cấu trúc với `FetchImplementation` của `jose` (Task 41). `redirect` khác `manual` → `SsrfBlockedError`.

- [ ] **Step 1: Viết test fail**

`test/integration/core/resilience/web-fetch.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpClient, ResilienceModule, SsrfBlockedError, toWebFetch } from '../../../../src/core/resilience/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const CALLER_TIMEOUT_MS = 100;
let server: Server;
let port = 0;
let slowClosed = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-a': '1' });
      res.end('{"keys":[]}');
      return;
    }
    if (req.url === '/slow') { res.on('close', () => slowClosed++); return; }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('toWebFetch', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Fixture chạy http trên loopback: test bật http, cổng và dải loopback (production chỉ https, không loopback).
    vi.stubEnv('RESILIENCE_ALLOWED_SCHEMES', 'http,https');
    vi.stubEnv('RESILIENCE_ALLOWED_PORTS', String(port));
    vi.stubEnv('RESILIENCE_SSRF_ALLOW_CIDRS', '127.0.0.1/32');
    app = await createTestApp([ResilienceModule]);
  });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('returns a Web Response with status, headers and body', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    const r = await f(`http://127.0.0.1:${port}/jwks`, { method: 'GET', headers: new Headers({ accept: 'application/json' }), redirect: 'manual' });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-a')).toBe('1');
    expect(await r.json()).toEqual({ keys: [] });
  });
  it('caller abort really cancels the request and rethrows the caller reason', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks-slow');
    const signal = AbortSignal.timeout(CALLER_TIMEOUT_MS);
    await expect(f(`http://127.0.0.1:${port}/slow`, { signal, redirect: 'manual' })).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(slowClosed).toBeGreaterThan(0));
  });
  it('refuses to follow redirects', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    await expect(f(`http://127.0.0.1:${port}/jwks`, { redirect: 'follow' })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('still blocks private addresses outside the allow list', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    await expect(f('http://10.0.0.1/jwks', { redirect: 'manual' })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/core/resilience/web-fetch.spec.ts`
Expected: FAIL — `toWebFetch` không tồn tại.

- [ ] **Step 3: Cài đặt**

`src/core/resilience/http-client.ts`:
- `HttpRequestInit` thêm `/** Huỷ từ phía caller (vd. timeout của jose); kết hợp với timeout của policy. */ signal?: AbortSignal;`
- Trong `request`:
```ts
    try {
      return await policy.execute(({ signal }) =>
        this.attempt(provider, url, method, init, init.signal ? AbortSignal.any([signal, init.signal]) : signal),
      );
    } catch (err) {
      // Caller tự huỷ: trả đúng lý do của caller để nó phân biệt timeout của mình với lỗi upstream.
      if (init.signal?.aborted) throw init.signal.reason;
      throw this.normalize(provider, method, err);
    }
```
- Dòng đầu `attempt`: `signal.throwIfAborted();` (không mở connection khi đã bị huỷ, kể cả ở lần retry).

`src/core/resilience/web-fetch.ts`:
```ts
import type { HttpClient } from './http-client.js';
import { SsrfBlockedError } from './ssrf-guard.js';

export type WebFetchInit = {
  method?: string;
  headers?: Headers;
  redirect?: 'manual' | 'follow' | 'error';
  signal?: AbortSignal;
};
export type WebFetch = (url: string, init?: WebFetchInit) => Promise<Response>;

/** Status không được có body theo Fetch (`new Response(body, …)` ném lỗi nếu có). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Hàm có chữ ký `fetch` cho thư viện nhận fetch tuỳ biến (vd. `customFetch` của `jose`), đi qua
 * `HttpClient` (chống SSRF, breaker, bulkhead, giới hạn body). Không bao giờ follow redirect.
 */
export function toWebFetch(client: HttpClient, provider: string): WebFetch {
  return async (url, init = {}) => {
    if (init.redirect !== undefined && init.redirect !== 'manual')
      throw new SsrfBlockedError(`redirect mode "${init.redirect}" is not allowed; outbound calls never follow redirects`);
    const headers: Record<string, string> = {};
    init.headers?.forEach((value, key) => {
      headers[key] = value;
    });
    const res = await client.request(provider, url, { method: init.method ?? 'GET', headers, signal: init.signal });
    const out = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) out.append(key, one);
    }
    return new Response(NULL_BODY_STATUSES.has(res.status) ? null : res.body, { status: res.status, headers: out });
  };
}
```
`src/core/resilience/index.ts`: thêm `export { toWebFetch, type WebFetch, type WebFetchInit } from './web-fetch.js';`

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/core/resilience && pnpm vitest run --project unit test/unit/core/resilience && pnpm typecheck && pnpm lint`
Expected: PASS (test SSRF/redirect của SP1 không đổi).

- [ ] **Step 5: Commit**

```bash
git add src/core/resilience test/integration/core/resilience/web-fetch.spec.ts
git commit -m "feat(core/resilience): caller abort signal and a fetch-compatible adapter over HttpClient"
```

---

### Task 14: `core/security` + `core/logging` — chống mã hoá kép, redact header auth, bỏ field lỗi SMTP, che token trong path

**Files:**
- Modify: `src/core/security/field-cipher.ts`, `src/core/logging/redaction.ts`
- Test: `test/unit/core/security/field-cipher.spec.ts`, `test/unit/core/logging/redaction.spec.ts` (thêm case)

**Interfaces:**
- Consumes: `FieldCipher`, `BASE_REDACT_PATHS`, `errSerializer` (SP1).
- Produces: `FieldCipher.isCiphertext(value: string): boolean` (static, regex chặt `v1.<kid>.<iv 16>.<ct>.<tag 22>`), dùng ở Task 28. `BASE_REDACT_PATHS` thêm `res.headers["set-auth-token"]`, `*.headers["set-auth-token"]`, `*.headers.cookie`, `*.*.headers.cookie`. `errSerializer` bỏ `response`, `rejected`, `rejectedErrors`, `envelope`. `reqSerializer` thay segment path dạng token mờ (≥ 20 ký tự base64url, không phải UUID) bằng `[redacted]` — vd. `/api/auth/reset-password/<token>` (review M9).

- [ ] **Step 1: Viết test fail**

Thêm vào `test/unit/core/security/field-cipher.spec.ts` (import `randomBytes` từ `node:crypto` nếu chưa có):
```ts
describe('FieldCipher.isCiphertext', () => {
  const cipher = new FieldCipher({ k1: randomBytes(32).toString('base64') }, 'k1');
  it('recognises its own output, including an empty plaintext', () => {
    expect(FieldCipher.isCiphertext(cipher.encrypt('ya29.token', 'auth.account:access_token:-:google/1'))).toBe(true);
    expect(FieldCipher.isCiphertext(cipher.encrypt('', 'aad'))).toBe(true);
  });
  it.each([
    'ya29.a0AfH6SMBx',
    'v1.k1.short.ct.tag',
    'v2.k1.AAAAAAAAAAAAAAAA.YQ.AAAAAAAAAAAAAAAAAAAAAA',
    'v1.K1.AAAAAAAAAAAAAAAA.YQ.AAAAAAAAAAAAAAAAAAAAAA',
    'v1.k1.AAAAAAAAAAAAAAAA.Y+Q.AAAAAAAAAAAAAAAAAAAAAA',
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
  ])('rejects %s', (v) => expect(FieldCipher.isCiphertext(v)).toBe(false));
});
```
Thêm vào `test/unit/core/logging/redaction.spec.ts`:
```ts
describe('SP2 redaction additions', () => {
  it('redacts the mobile bearer header and cookies of nested request objects', () => {
    for (const p of ['res.headers["set-auth-token"]', '*.headers["set-auth-token"]', '*.headers.cookie', '*.*.headers.cookie'])
      expect(BASE_REDACT_PATHS).toContain(p);
  });
  it('drops nodemailer fields that carry e-mail addresses', () => {
    const err = Object.assign(new Error('Message failed'), {
      response: '550 5.1.1 <victim@example.com>: Recipient address rejected',
      rejected: ['victim@example.com'],
      rejectedErrors: [new Error('victim@example.com')],
      envelope: { from: 'noreply@example.com', to: ['victim@example.com'] },
      responseCode: 550,
    });
    const out = JSON.stringify(errSerializer(err));
    expect(out).not.toContain('victim@example.com');
    expect(out).toContain('"responseCode":550');
  });
  it('masks opaque token segments in the logged path (reset-password links), keeps UUIDs and short segments', () => {
    expect(reqSerializer({ method: 'GET', url: '/api/auth/reset-password/AbCdEfGhIjKlMnOpQrStUvWx?callbackURL=https://a.test', headers: {} }))
      .toMatchObject({ url: '/api/auth/reset-password/[redacted]' });
    expect(reqSerializer({ method: 'GET', url: '/v1/orders/0199a7c2-5b1e-7d2a-9c3f-2b1a0e9d8c7b/items', headers: {} }))
      .toMatchObject({ url: '/v1/orders/0199a7c2-5b1e-7d2a-9c3f-2b1a0e9d8c7b/items' });
    expect(reqSerializer({ method: 'GET', url: '/api/auth/verify-email', headers: {} })).toMatchObject({ url: '/api/auth/verify-email' });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/core/security/field-cipher.spec.ts test/unit/core/logging/redaction.spec.ts`
Expected: FAIL — `isCiphertext` không tồn tại; output chứa `victim@example.com`.

- [ ] **Step 3: Cài đặt**

`src/core/security/field-cipher.ts`:
```ts
/** `v1.<kid>.<iv 12 byte = 16 ký tự>.<ct>.<tag 16 byte = 22 ký tự>`, base64url không padding. */
const CIPHERTEXT_PATTERN = /^v1\.[a-z0-9]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$/;
```
và trong class:
```ts
  /**
   * Nhận diện định dạng token của chính lớp này, để lớp bọc không mã hoá hai lần (spec SP2 §5.9).
   * Chỉ kiểm định dạng; tính toàn vẹn do `decrypt` kiểm.
   */
  static isCiphertext(value: string): boolean {
    return CIPHERTEXT_PATTERN.test(value);
  }
```
`src/core/logging/redaction.ts`: thêm vào `BASE_REDACT_PATHS` sau `'res.headers["set-cookie"]'`:
```ts
  // Bearer của mobile: plugin `bearer` của Better Auth trả token session qua header này.
  'res.headers["set-auth-token"]',
  '*.headers["set-auth-token"]',
  // Cookie trong header của request/response lồng (log của thư viện, lời gọi server của Better Auth).
  '*.headers.cookie',
  '*.*.headers.cookie',
```
`reqSerializer` (trong cùng file):
```ts
/** Segment path mờ đủ dài để là token (Better Auth: token đặt lại mật khẩu nằm trong path). */
const OPAQUE_TOKEN_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDACTED_SEGMENT = '[redacted]';
const maskPath = (path: string): string =>
  path.split('/').map((seg) => (OPAQUE_TOKEN_SEGMENT.test(seg) && !UUID_SEGMENT.test(seg) ? REDACTED_SEGMENT : seg)).join('/');

export function reqSerializer(req: { method?: string; url?: string; headers?: Record<string, unknown> }): Record<string, unknown> {
  return {
    method: req.method,
    url: req.url === undefined ? undefined : maskPath(req.url.split('?')[0] ?? ''),
    headers: req.headers,
  };
}
```
(Test hiện có của SP1 `url: '/reset'` vẫn đúng. Id do app sinh là UUID nên không bị che; slug dài hơn 20 ký tự chỉ gồm `[A-Za-z0-9_-]` bị che trong log — đánh đổi chấp nhận được, ghi ở ADR 0007.)

thêm vào `ERROR_PAYLOAD_DROP` (bổ sung dòng chú thích "- lỗi SMTP của nodemailer: `response`, `rejected`, `rejectedErrors`, `envelope` chứa địa chỉ email"):
```ts
  'response',
  'rejected',
  'rejectedErrors',
  'envelope',
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/core && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/security/field-cipher.ts src/core/logging/redaction.ts test/unit/core/security/field-cipher.spec.ts test/unit/core/logging/redaction.spec.ts
git commit -m "feat(core): detect FieldCipher tokens; redact bearer/cookie headers and nodemailer address fields"
```

---
## Phần C — Hạ tầng DB, luật kiến trúc, bộ smoke prod-like

### Task 15: Role `auth_user`, schema `auth`, siết quyền `PUBLIC`; Mailpit; PgBouncer có `auth_user`

**Files:**
- Modify: `docker/postgres/init/01-roles.sh`, `docker/images.env`, `compose.yaml`, `src/core/config/dev-infra.config.ts`, `.env.infra.example` (sinh lại), `test/support/infra.global-setup.ts`, `test/support/infra.ts`, `test/support/db.ts`, `test/integration/infra/roles.spec.ts`, `test/integration/core/database/rls-catalog.spec.ts`
- Create: `docker/pgbouncer/entrypoint.sh`, `test/support/mailpit.ts`, `test/integration/infra/mailpit.spec.ts`

**Interfaces:**
- Consumes: kết quả S2b (Task 2): `MAX_PREPARED_STATEMENTS` hoặc pool auth đi thẳng Postgres.
- Produces:
  - Role `auth_user` (LOGIN, NOBYPASSRLS, `search_path = auth`, timeout theo role), schema `auth` (owner `app_owner`, chỉ `auth_user` có `USAGE`); `PUBLIC` không có quyền trên schema `public`, không có `CONNECT`/`TEMPORARY` trên database.
  - `Infra.pg.auth: Creds`, `Infra.mailpit: { smtpHost: string; smtpPort: number; apiUrl: string }` (test/support/infra.ts).
  - `dbEnvFor(infra)` thêm `DB_AUTH_HOST`, `DB_AUTH_PORT`, `DB_AUTH_USER`, `DB_AUTH_PASSWORD` (config của Task 25 đọc các biến này).
  - `class Mailpit` (test/support/mailpit.ts): `clear()`, `messages(to)`, `message(id)`, `waitFor(to, { subject?, timeoutMs?, after? })`; `mailpitFromInfra(): Mailpit`; kiểu `MailpitMessage` có `Subject`, `To`, `HTML`, `Text`.
  - Compose: service `mailpit` (SMTP 1025, UI/API 8025, chỉ bind `127.0.0.1`); `x-app.env_file: [${APP_ENV_FILE:-.env}]` (Task 17 dùng).

- [ ] **Step 1: Viết test fail**

Thêm vào cuối `test/integration/core/database/rls-catalog.spec.ts` (giữ các test cũ):
```ts
type Priv = { role: string; public_usage: boolean; public_create: boolean; auth_usage: boolean; auth_create: boolean; db_connect: boolean; db_temp: boolean };
const EXPECTED_PRIVS: Priv[] = [
  { role: 'public', public_usage: false, public_create: false, auth_usage: false, auth_create: false, db_connect: false, db_temp: false },
  { role: 'app_user', public_usage: true, public_create: false, auth_usage: false, auth_create: false, db_connect: true, db_temp: false },
  { role: 'app_relay', public_usage: true, public_create: false, auth_usage: false, auth_create: false, db_connect: true, db_temp: false },
  { role: 'auth_user', public_usage: false, public_create: false, auth_usage: true, auth_create: false, db_connect: true, db_temp: false },
  { role: 'app_owner', public_usage: true, public_create: true, auth_usage: true, auth_create: true, db_connect: true, db_temp: true },
];

describe('schema and database privileges (R20)', () => {
  let client: Client;
  beforeAll(async () => {
    const { pg } = getInfra();
    client = new Client({ host: pg.host, port: pg.port, database: pg.database, ...pg.owner });
    await client.connect();
  });
  afterAll(async () => client?.end());

  it('matches the expected matrix for PUBLIC and every application role', async () => {
    const rows: Priv[] = [];
    for (const { role } of EXPECTED_PRIVS) {
      const r = await client.query<Priv>(
        `SELECT $1::text AS role,
           has_schema_privilege($1, 'public', 'USAGE') AS public_usage,
           has_schema_privilege($1, 'public', 'CREATE') AS public_create,
           has_schema_privilege($1, 'auth', 'USAGE') AS auth_usage,
           has_schema_privilege($1, 'auth', 'CREATE') AS auth_create,
           has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
           has_database_privilege($1, current_database(), 'TEMPORARY') AS db_temp`,
        [role],
      );
      rows.push(r.rows[0]!);
    }
    expect(rows).toEqual(EXPECTED_PRIVS);
  });
  it('auth_user is NOBYPASSRLS, not superuser, with search_path = auth', async () => {
    const { rows } = await client.query(
      `SELECT r.rolbypassrls, r.rolsuper,
         (SELECT array_agg(c) FROM unnest(s.setconfig) c WHERE c LIKE 'search_path=%') AS sp
       FROM pg_roles r LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
       WHERE r.rolname = 'auth_user'`,
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false, sp: ['search_path=auth'] });
  });
});
```
Thêm vào `test/integration/infra/roles.spec.ts`:
```ts
describe('auth_user isolation', () => {
  it('cannot read or call anything in public (42501), directly and through PgBouncer', async () => {
    for (const via of ['postgres', 'pgbouncer'] as const) {
      const c = await connect(getInfra().pg.auth, via);
      try {
        await expect(c.query('SELECT 1 FROM public.outbox_events LIMIT 1')).rejects.toMatchObject({ code: '42501' });
        await expect(c.query('SELECT public.app_current_org()')).rejects.toMatchObject({ code: '42501' });
        const { rows } = await c.query<{ search_path: string }>('SHOW search_path');
        expect(rows[0]!.search_path).toBe('auth');
      } finally {
        await c.end();
      }
    }
  });
  it('app_user cannot use schema auth (42501)', async () => {
    const c = await connect(getInfra().pg.app);
    try {
      await expect(c.query('SELECT 1 FROM auth.anything')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });
});
```
(Nếu S2b chọn fallback thì vòng `for` chỉ chạy `'postgres'`.)

`test/integration/infra/mailpit.spec.ts`:
```ts
import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { getInfra } from '../../support/infra.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

describe('mailpit test harness', () => {
  it('receives SMTP mail and exposes it through the API', async () => {
    const { mailpit } = getInfra();
    const to = `harness-${Date.now()}@example.test`;
    const t = createTransport({ host: mailpit.smtpHost, port: mailpit.smtpPort, secure: false });
    await t.sendMail({ from: 'noreply@example.test', to, subject: 'harness', text: 'hello', html: '<p>hello</p>' });
    t.close();
    const msg = await mailpitFromInfra().waitFor(to, { subject: /harness/ });
    expect(msg.Text.trim()).toBe('hello');
  });
});
```
(`test/` không chịu luật kiến trúc của `src/`.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/core/database/rls-catalog.spec.ts test/integration/infra`
Expected: FAIL — `getInfra().pg.auth` không có, schema `auth` không tồn tại, `PUBLIC` còn `USAGE`.

- [ ] **Step 3: Script init Postgres**

`docker/postgres/init/01-roles.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${APP_OWNER_PASSWORD:?required}" "${APP_USER_PASSWORD:?required}" "${APP_RELAY_PASSWORD:?required}" "${APP_AUTH_PASSWORD:?required}"
: "${APP_USER_STATEMENT_TIMEOUT_MS:?required}" "${APP_RELAY_STATEMENT_TIMEOUT_MS:?required}" "${AUTH_USER_STATEMENT_TIMEOUT_MS:?required}" "${IDLE_IN_TX_TIMEOUT_MS:?required}"
# DBA production chạy đúng script này (spec SP2 §5.3). Không dựa vào quyền mặc định của PUBLIC:
# PG 15+ chỉ bỏ CREATE trên schema public, vẫn để USAGE, CONNECT và TEMPORARY cho mọi role.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$APP_OWNER_PASSWORD" -v user_pw="$APP_USER_PASSWORD" -v relay_pw="$APP_RELAY_PASSWORD" -v auth_pw="$APP_AUTH_PASSWORD" \
  -v user_stmt="${APP_USER_STATEMENT_TIMEOUT_MS}ms" -v relay_stmt="${APP_RELAY_STATEMENT_TIMEOUT_MS}ms" -v auth_stmt="${AUTH_USER_STATEMENT_TIMEOUT_MS}ms" \
  -v idle_tx="${IDLE_IN_TX_TIMEOUT_MS}ms" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE;
CREATE ROLE app_user  LOGIN PASSWORD :'user_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE app_relay LOGIN PASSWORD :'relay_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE auth_user LOGIN PASSWORD :'auth_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;

REVOKE CONNECT, TEMPORARY ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO app_owner, app_user, app_relay, auth_user;
-- Chỉ owner có bảng tạm (test catalog dùng bảng tạm để thử luật RLS).
GRANT TEMPORARY ON DATABASE :"db" TO app_owner;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
GRANT USAGE ON SCHEMA public TO app_user, app_relay;

-- Schema của Better Auth: tạo ở đây để app_owner không cần CREATE trên cả database; migration chỉ tạo/xoá bảng.
CREATE SCHEMA auth AUTHORIZATION app_owner;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO auth_user;
-- Cơ chế chọn schema của adapter bọc (spec §5.9): query không ghi schema không bao giờ rơi vào public.
ALTER ROLE auth_user SET search_path = auth;

ALTER ROLE app_user  SET statement_timeout = :'user_stmt';
ALTER ROLE app_relay SET statement_timeout = :'relay_stmt';
ALTER ROLE auth_user SET statement_timeout = :'auth_stmt';
ALTER ROLE app_user  SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE app_relay SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER ROLE auth_user SET idle_in_transaction_session_timeout = :'idle_tx';
ALTER DATABASE :"db" SET lc_messages TO 'C';
SQL
```
Ghi chú README (Task 49): volume dev của SP1 phải tạo lại (`docker compose down -v`) vì script init chỉ chạy trên volume trống; DB production chạy phần SQL này bằng tay theo runbook.

- [ ] **Step 4: PgBouncer có `auth_user` (nhánh S2b đạt)**

`docker/pgbouncer/entrypoint.sh`:
```sh
#!/bin/sh
# Entrypoint của edoburu/pgbouncer chỉ ghi DB_USER vào userlist. Thêm auth_user (mật khẩu thô; PgBouncer
# dùng nó để đăng nhập SCRAM tới Postgres) rồi chuyển cho entrypoint gốc (đã kiểm: /entrypoint.sh có
# hỗ trợ MAX_PREPARED_STATEMENTS và CLIENT_TLS_*/SERVER_TLS_*).
set -eu
: "${AUTH_DB_PASSWORD:?required}"
printf '"auth_user" "%s"\n' "$AUTH_DB_PASSWORD" >> /etc/pgbouncer/userlist.txt
exec /entrypoint.sh "$@"
```
Nhánh S2b fallback: không tạo file này; `DB_AUTH_HOST/PORT` luôn trỏ Postgres ở Step 6 và Step 7.

- [ ] **Step 5: Image Mailpit và config hạ tầng**

Run: `docker buildx imagetools inspect axllent/mailpit:v1.31.2 --format '{{json .Manifest.Digest}}'`
Thêm vào `docker/images.env`: `IMAGE_MAILPIT=axllent/mailpit:v1.31.2@sha256:<digest từ lệnh trên>`.

`src/core/config/dev-infra.config.ts`: thêm env map
```ts
    authStatementTimeoutMs: 'DB_AUTH_STATEMENT_TIMEOUT_MS',
    pgbouncerMaxPreparedStatements: 'PGBOUNCER_MAX_PREPARED_STATEMENTS',
    mailpitSmtpPortHost: 'MAILPIT_SMTP_PORT_HOST',
    mailpitUiPortHost: 'MAILPIT_UI_PORT_HOST',
```
và schema:
```ts
    authStatementTimeoutMs: z.coerce.number().int().positive().default(5000)
      .describe('statement_timeout set on role auth_user'),
    pgbouncerMaxPreparedStatements: z.coerce.number().int().min(0).default(200)
      .describe('PgBouncer max_prepared_statements (RateLimiterPostgres uses named prepared statements through transaction pooling; value from spike S2b)'),
    mailpitSmtpPortHost: z.coerce.number().int().positive().default(1025)
      .describe('Host port for Mailpit SMTP (bound to 127.0.0.1)'),
    mailpitUiPortHost: z.coerce.number().int().positive().default(8025)
      .describe('Host port for Mailpit UI/API (bound to 127.0.0.1)'),
```
(`200` thay bằng giá trị đã chốt ở S2b nếu khác.) Run: `pnpm env:example`.

- [ ] **Step 6: Compose**

`compose.yaml`:
- `x-app`: `env_file: ['${APP_ENV_FILE:-.env}']` và chú thích "smoke (Task 17) trỏ file env riêng; dev dùng `.env`".
- `postgres.environment` thêm `APP_AUTH_PASSWORD: ${DB_AUTH_PASSWORD}` và `AUTH_USER_STATEMENT_TIMEOUT_MS: ${DB_AUTH_STATEMENT_TIMEOUT_MS}`.
- `pgbouncer` (nhánh S2b đạt):
```yaml
  pgbouncer:
    image: ${IMAGE_PGBOUNCER}
    entrypoint: ['/bin/sh', '/sp2-entrypoint.sh']
    command: ['/usr/bin/pgbouncer', '/etc/pgbouncer/pgbouncer.ini']
    volumes: ['./docker/pgbouncer/entrypoint.sh:/sp2-entrypoint.sh:ro']
    depends_on: { postgres: { condition: service_healthy } }
    ports: ['127.0.0.1:${PGBOUNCER_PORT_HOST}:5432']
    environment:
      DB_HOST: postgres
      DB_PORT: '5432'
      DB_NAME: ${DB_NAME}
      DB_USER: app_user
      DB_PASSWORD: ${DB_APP_PASSWORD}
      POOL_MODE: transaction
      AUTH_TYPE: scram-sha-256
      AUTH_DB_PASSWORD: ${DB_AUTH_PASSWORD}
      MAX_PREPARED_STATEMENTS: ${PGBOUNCER_MAX_PREPARED_STATEMENTS}
```
- Service mới:
```yaml
  mailpit:
    image: ${IMAGE_MAILPIT}
    ports:
      - '127.0.0.1:${MAILPIT_SMTP_PORT_HOST}:1025'
      - '127.0.0.1:${MAILPIT_UI_PORT_HOST}:8025'
```
- `migrate.environment`: `DB_AUTH_PASSWORD: ''` (migrate không mở pool auth).
- `api.environment` và `worker.environment`: `DB_AUTH_HOST: pgbouncer` (fallback S2b: `postgres`), `DB_AUTH_PORT: '5432'`.

Run: `docker compose --env-file docker/images.env --env-file .env.infra --env-file .env config -q`
Expected: không lỗi. (`.env` cục bộ cần `DB_AUTH_PASSWORD`; Task 25 đưa biến này vào `.env.example`.)

- [ ] **Step 7: Hạ tầng test**

`test/support/infra.ts`: `Infra.pg` thêm `auth: Creds`; `Infra` thêm `mailpit: { smtpHost: string; smtpPort: number; apiUrl: string }`.

`test/support/infra.global-setup.ts`:
```ts
const TEST_DB_TIMEOUTS = { userStatementMs: '5000', relayStatementMs: '60000', authStatementMs: '5000', idleInTxMs: '10000' };
/** Giá trị đã chốt ở spike S2b (tham số của bộ test). */
const TEST_PGBOUNCER_MAX_PREPARED = '200';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_API_PORT = 8025;
let mailpitC: StartedTestContainer | undefined;
```
- `const auth = { user: 'auth_user', password: secret() };`, Postgres `.withEnvironment` thêm `APP_AUTH_PASSWORD: auth.password`, `AUTH_USER_STATEMENT_TIMEOUT_MS: TEST_DB_TIMEOUTS.authStatementMs`.
- PgBouncer:
```ts
  bouncer = await new GenericContainer(images.IMAGE_PGBOUNCER!)
    .withNetwork(network)
    .withCopyFilesToContainer([{ source: resolve('docker/pgbouncer/entrypoint.sh'), target: '/sp2-entrypoint.sh', mode: INIT_SCRIPT_MODE }])
    .withEntrypoint(['/bin/sh', '/sp2-entrypoint.sh'])
    .withCommand(['/usr/bin/pgbouncer', '/etc/pgbouncer/pgbouncer.ini'])
    .withEnvironment({
      DB_HOST: PG_ALIAS, DB_PORT: '5432', DB_NAME: pgC.getDatabase(), DB_USER: app.user, DB_PASSWORD: app.password,
      POOL_MODE: 'transaction', AUTH_TYPE: 'scram-sha-256',
      AUTH_DB_PASSWORD: auth.password, MAX_PREPARED_STATEMENTS: TEST_PGBOUNCER_MAX_PREPARED,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
```
- Mailpit:
```ts
  mailpitC = await new GenericContainer(images.IMAGE_MAILPIT!)
    .withExposedPorts(MAILPIT_SMTP_PORT, MAILPIT_API_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
```
- `infra.pg.auth = auth`; `infra.mailpit = { smtpHost: mailpitC.getHost(), smtpPort: mailpitC.getMappedPort(MAILPIT_SMTP_PORT), apiUrl: \`http://${mailpitC.getHost()}:${mailpitC.getMappedPort(MAILPIT_API_PORT)}\` }`.
- `teardown`: `await mailpitC?.stop();` trước `redisC`.

`test/support/db.ts` (`dbEnvFor`) thêm:
```ts
    // Pool auth_user (identity): qua PgBouncer như connection app (S2b). Fallback S2b: pg.host/pg.port.
    DB_AUTH_HOST: pgbouncer.host,
    DB_AUTH_PORT: String(pgbouncer.port),
    DB_AUTH_USER: pg.auth.user,
    DB_AUTH_PASSWORD: pg.auth.password,
```
`test/support/mailpit.ts`:
```ts
import { z } from 'zod';
import { getInfra } from './infra.js';

const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const Address = z.object({ Address: z.string(), Name: z.string() });
const Summary = z.object({ ID: z.string(), Subject: z.string(), To: z.array(Address), Created: z.string() });
const SearchResult = z.object({ messages: z.array(Summary) });
const Message = Summary.extend({ HTML: z.string(), Text: z.string() });
export type MailpitSummary = z.infer<typeof Summary>;
export type MailpitMessage = z.infer<typeof Message>;

/** Client Mailpit API v1 (`/api/v1/search`, `/api/v1/message/{id}`, `DELETE /api/v1/messages`). */
export class Mailpit {
  constructor(private readonly apiUrl: string) {}

  async clear(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/v1/messages`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`mailpit clear failed: ${res.status}`);
  }
  async messages(to: string): Promise<MailpitSummary[]> {
    const res = await fetch(`${this.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
    return SearchResult.parse(await res.json()).messages;
  }
  async message(id: string): Promise<MailpitMessage> {
    const res = await fetch(`${this.apiUrl}/api/v1/message/${id}`);
    if (!res.ok) throw new Error(`mailpit message failed: ${res.status}`);
    return Message.parse(await res.json());
  }
  /** Chờ thư tới `to`, lọc theo subject và chỉ thư tạo từ mốc `after` (ms epoch) nếu có. */
  async waitFor(to: string, opts: { subject?: RegExp; timeoutMs?: number; after?: number } = {}): Promise<MailpitMessage> {
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    for (;;) {
      const hit = (await this.messages(to)).find(
        (m) => (!opts.subject || opts.subject.test(m.Subject)) && (opts.after === undefined || Date.parse(m.Created) >= opts.after),
      );
      if (hit) return this.message(hit.ID);
      if (Date.now() > deadline) throw new Error(`no mail to ${to} within timeout`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

export const mailpitFromInfra = (): Mailpit => new Mailpit(getInfra().mailpit.apiUrl);
```
Trước khi dùng, đối chiếu đường dẫn và tên trường với tài liệu `https://mailpit.axllent.org/docs/api-v1/` bằng `curl <apiUrl>/api/v1/messages` trên container đang chạy; tên khác thì sửa schema zod.

- [ ] **Step 8: Chạy test, xác nhận xanh**

Run: `pnpm test:int`
Expected: PASS toàn bộ, kể cả test SP1 (`app_user`/`app_relay` vẫn có `USAGE` trên `public`, migration chạy bằng `app_owner`).

- [ ] **Step 9: Commit**

```bash
git add docker compose.yaml src/core/config/dev-infra.config.ts .env.infra.example test/support test/integration/infra test/integration/core/database/rls-catalog.spec.ts
git commit -m "feat(infra): auth_user role and auth schema, tightened PUBLIC privileges, mailpit, pgbouncer auth user"
```

---

### Task 16: Luật kiến trúc 10–16 (dependency-cruiser)

**Files:**
- Modify: `.dependency-cruiser.cjs`, `test/unit/architecture/rules.spec.ts`
- Create (fixture phải fail): `test/architecture/fixtures/src/modules/billing/infra/uses-better-auth.ts`, `…/modules/identity/http/uses-kysely.ts`, `…/modules/billing/infra/uses-pg.ts`, `…/modules/identity/infra/better-auth/uses-jose.ts`, `…/modules/identity/infra/better-auth/uses-nodemailer.ts`, `…/core/queue/uses-bull-board.ts`, `…/modules/billing/infra/uses-rate-limiter.ts`, `…/modules/notifications/application/uses-identity.ts`, `…/modules/identity/index.ts`
- Create (fixture hợp lệ): `…/modules/identity/infra/better-auth/ok.ts`, `…/modules/identity/infra/jwks/ok.ts`, `…/modules/notifications/infra/ok.ts`, `…/core/queue/dashboard/ok.ts`

**Interfaces:**
- Consumes: package ở Task 1.
- Produces: luật `auth-libs-only-in-identity-better-auth`, `pg-only-in-identity-better-auth-or-core-database`, `jose-only-in-identity-jwks`, `mail-libs-only-in-notifications-infra`, `bull-board-only-in-core-queue-dashboard`, `rate-limiter-only-in-core-http-or-identity-better-auth`, `notifications-independent-of-identity`; `http-platform-only-in-core-http` cho phép thêm `src/core/queue/dashboard/`; `no-orphans` bỏ qua `auth.cli-config.ts`.

- [ ] **Step 1: Viết fixture và test fail**

Fixture phải fail (mỗi file đúng một dòng):
- `modules/billing/infra/uses-better-auth.ts`: `import 'better-auth';`
- `modules/identity/http/uses-kysely.ts`: `import 'kysely';`
- `modules/billing/infra/uses-pg.ts`: `import 'pg';`
- `modules/identity/infra/better-auth/uses-jose.ts`: `import 'jose';`
- `modules/identity/infra/better-auth/uses-nodemailer.ts`: `import 'nodemailer';`
- `core/queue/uses-bull-board.ts`: `import '@bull-board/api';`
- `modules/billing/infra/uses-rate-limiter.ts`: `import 'rate-limiter-flexible';`
- `modules/notifications/application/uses-identity.ts`: `import '../../identity/index.js';`
- `modules/identity/index.ts`: `export {};`

Fixture hợp lệ:
- `modules/identity/infra/better-auth/ok.ts`: `import 'better-auth'; import 'kysely'; import 'pg'; import 'rate-limiter-flexible';`
- `modules/identity/infra/jwks/ok.ts`: `import 'jose';`
- `modules/notifications/infra/ok.ts`: `import 'nodemailer'; import 'mjml'; import 'handlebars';`
- `core/queue/dashboard/ok.ts`: `import '@bull-board/api'; import '@bull-board/express'; import 'express';`

Thêm vào mảng `it.each` của `test/unit/architecture/rules.spec.ts`:
```ts
    ['auth-libs-only-in-identity-better-auth', 'modules/billing/infra/uses-better-auth.ts'],
    ['auth-libs-only-in-identity-better-auth', 'modules/identity/http/uses-kysely.ts'],
    ['pg-only-in-identity-better-auth-or-core-database', 'modules/billing/infra/uses-pg.ts'],
    ['jose-only-in-identity-jwks', 'modules/identity/infra/better-auth/uses-jose.ts'],
    ['mail-libs-only-in-notifications-infra', 'modules/identity/infra/better-auth/uses-nodemailer.ts'],
    ['bull-board-only-in-core-queue-dashboard', 'core/queue/uses-bull-board.ts'],
    ['rate-limiter-only-in-core-http-or-identity-better-auth', 'modules/billing/infra/uses-rate-limiter.ts'],
    ['notifications-independent-of-identity', 'modules/notifications/application/uses-identity.ts'],
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/architecture/rules.spec.ts`
Expected: FAIL — luật mới chưa có; `core/queue/dashboard/ok.ts` vi phạm `http-platform-only-in-core-http`.

- [ ] **Step 3: Cài đặt luật**

`.dependency-cruiser.cjs`, trong `forbidden`:
- `http-platform-only-in-core-http`: `from: { pathNot: '(^|/)src/core/(http|queue/dashboard)/' }`, chú thích "Bull Board mount trên express() riêng trong worker (SP2 luật 13)".
- `http-libs-only-in-core-http`: `to.path` bỏ `rate-limiter-flexible` → `'node_modules/(@nestjs/throttler|@node-idempotency|tiny-merge-patch)/'`.
- Thêm:
```js
    {
      name: 'auth-libs-only-in-identity-better-auth',
      severity: 'error',
      comment: 'SP2 rule 10: Better Auth, its adapters, the Nest integration and Kysely stay behind the AuthProvider port.',
      from: { pathNot: '(^|/)src/modules/identity/infra/better-auth/' },
      to: { path: 'node_modules/(better-auth|@better-auth|kysely)/' },
    },
    {
      name: 'pg-only-in-identity-better-auth-or-core-database',
      severity: 'error',
      comment: 'SP2 rule 10: raw pg pools exist only for the auth_user pool and core/database.',
      from: { pathNot: '(^|/)src/(modules/identity/infra/better-auth|core/database)/' },
      to: { path: 'node_modules/pg/' },
    },
    {
      name: 'jose-only-in-identity-jwks',
      severity: 'error',
      comment: 'SP2 rule 11: token verification for AUTH_MODE=external lives in one adapter.',
      from: { pathNot: '(^|/)src/modules/identity/infra/jwks/' },
      to: { path: 'node_modules/jose/' },
    },
    {
      name: 'mail-libs-only-in-notifications-infra',
      severity: 'error',
      comment: 'SP2 rule 12: SMTP transport and template engines stay in notifications infra.',
      from: { pathNot: '(^|/)src/modules/notifications/infra/' },
      to: { path: 'node_modules/(nodemailer|mjml|handlebars)/' },
    },
    {
      name: 'bull-board-only-in-core-queue-dashboard',
      severity: 'error',
      comment: 'SP2 rule 13: the queue dashboard is the only Bull Board user.',
      from: { pathNot: '(^|/)src/core/queue/dashboard/' },
      to: { path: 'node_modules/@bull-board/' },
    },
    {
      name: 'rate-limiter-only-in-core-http-or-identity-better-auth',
      severity: 'error',
      comment: 'SP1 rule 9 + SP2 rule 14: RateLimiterPostgres backs the account lockout of identity.',
      from: { pathNot: '(^|/)src/(core/http|modules/identity/infra/better-auth)/' },
      to: { path: 'node_modules/rate-limiter-flexible/' },
    },
    {
      name: 'notifications-independent-of-identity',
      severity: 'error',
      comment: 'SP2 rule 15: identity calls notifications, never the reverse.',
      from: { path: '(^|/)src/modules/notifications/' },
      to: { path: '(^|/)src/modules/identity/' },
    },
```
- `no-orphans` → `from.pathNot` thêm phần tử: `'(^|/)src/modules/identity/infra/better-auth/auth[.]cli-config[.]ts$', // SP2 rule 16: loaded only by the auth CLI`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/architecture && pnpm arch`
Expected: PASS; cây `src` thật không vi phạm.

- [ ] **Step 5: Commit**

```bash
git add .dependency-cruiser.cjs test/unit/architecture/rules.spec.ts test/architecture/fixtures
git commit -m "test(arch): enforce sp2 library boundaries (rules 10-16) with must-fail fixtures"
```

---

### Task 17: Bộ smoke prod-like (image production + compose + TLS cục bộ) — kiểm chứng prod-like #0 cho core

**Files:**
- Create: `test/smoke/compose.smoke.yaml`, `test/smoke/gen-certs.sh`, `test/smoke/smoke-env.ts`, `test/smoke/smoke-preflight.ts`, `test/smoke/smoke-app-env.ts`, `test/smoke/smoke.global-setup.ts`, `test/smoke/smoke-support.ts`, `test/smoke/core.smoke.spec.ts`
- Modify: `vitest.config.ts` (project `smoke`), `package.json` (script `test:smoke`)
- Test: `test/unit/smoke/smoke-env.spec.ts`, `test/smoke/core.smoke.spec.ts`

**Interfaces:**
- Consumes: `compose.yaml` (Task 15: `env_file: [${APP_ENV_FILE:-.env}]`, service `mailpit`), `docker/images.env`, `readImages()`, `.env.example` + `.env.infra.example` do `pnpm env:example` sinh (SP1 `src/scripts/gen-env-example.ts`; CI Task 48 giữ khớp schema).
- Produces:
  - `pnpm test:smoke`: `docker build` image production với build-arg từ `docker/images.env`; `docker compose -p nsb-smoke` (compose.yaml + `test/smoke/compose.smoke.yaml`) với TLS cục bộ, `NODE_ENV=production`; migrate bằng `docker compose run --rm migrate`; chạy `test/smoke/**/*.smoke.spec.ts`; in log container; `docker compose --profile app down -v`.
  - `readEnvExample(path): { values; required }`, `buildSmokeEnv(extra): SmokeEnv` (`{ dir, infraFile, appFile, app, infra, requiredApp, requiredInfra }`), `smokeSubnet()` (biến môi trường `SMOKE_SUBNET` ghi đè mặc định `172.31.250.0/24`).
  - `assertSmokePreflight(env, composeArgs)` (`test/smoke/smoke-preflight.ts`): chạy trước `docker build`; ném `SmokePreflightError` liệt kê từng biến thiếu (`KEY (compose interpolation|.env.infra|service api)`) và subnet trùng. Hàm thuần `missingSmokeVariables`, `overlappingSubnets`.
  - `smokeAppEnv(s: { secret }): Record<string, string>` (`test/smoke/smoke-app-env.ts`): điểm duy nhất để Task 43 và 46 thêm config production của module.
  - Context `inject('smoke')`: `{ apiUrl: string; mailpitApiUrl: string; dashboardUrl: string; composeArgs: string[]; dbName: string; superuser: string }`.
  - `smoke-support.ts`: `compose(args)`, `psql(sql)`, `logsSince(sinceIso)`, `assertCleanLogs(logs, forbidden)`, `workerHealth()`, `class CookieJar { absorb(res: Response): void; get(name): string | undefined; header(): string; clear(): void }`.

- [ ] **Step 1: Viết smoke test fail**

`test/smoke/core.smoke.spec.ts`:
```ts
import { describe, expect, inject, it } from 'vitest';
import { assertCleanLogs, compose, logsSince, psql, workerHealth } from './smoke-support.js';

describe('prod-like smoke: core', () => {
  const since = new Date().toISOString();
  const { apiUrl } = inject('smoke');

  it('api is live and ready; worker container is healthy', async () => {
    expect((await fetch(`${apiUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
  });
  it('migrations are applied (status lists nothing pending)', () => {
    expect(compose(['run', '--rm', '--no-deps', 'migrate', 'dist/main.migrate.js', 'status'])).toContain('"migrations":[]');
  });
  it('production rules are enforced: a DB TLS mode other than verify-full refuses to start', () => {
    expect(() => compose(['run', '--rm', '--no-deps', '-e', 'DB_SSL_MODE=require', 'migrate', 'dist/main.migrate.js', 'status']))
      .toThrow(/DB_SSL_MODE must be verify-full in production/);
  });
  it('app connections to Postgres use TLS', () => {
    const n = Number(psql(`SELECT count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename IN ('app_relay', 'app_user') AND s.ssl`));
    expect(n).toBeGreaterThan(0);
  });
  it('container logs have no error lines', () => {
    assertCleanLogs(logsSince(since), []);
  });
});
```

`test/unit/smoke/smoke-env.spec.ts` (không cần Docker; chạy trong `pnpm test`):
```ts
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_EXAMPLE, INFRA_EXAMPLE, buildSmokeEnv, readEnvExample, smokeSubnet, type SmokeEnv } from '../../smoke/smoke-env.js';
import { missingSmokeVariables, overlappingSubnets, type RenderedCompose } from '../../smoke/smoke-preflight.js';

const renderedWith = (environment: Record<string, string>): RenderedCompose => ({
  services: { api: { environment }, worker: { environment }, migrate: { environment } },
});

describe('smoke env is derived from the generated env examples (review B3)', () => {
  let env: SmokeEnv | undefined;
  afterEach(() => { if (env) rmSync(env.dir, { recursive: true, force: true }); env = undefined; vi.unstubAllEnvs(); });

  it('every key of .env.infra.example reaches the compose interpolation file, required ones non-empty', () => {
    env = buildSmokeEnv(() => ({}));
    const example = readEnvExample(INFRA_EXAMPLE);
    for (const k of Object.keys(example.values)) expect(env.infra[k], k).toBeDefined();
    expect(example.values.DB_APP_STATEMENT_TIMEOUT_MS).toBeDefined();
    expect(env.requiredInfra).toContain('POSTGRES_SUPERUSER_PASSWORD');
    for (const k of env.requiredInfra) expect(env.infra[k], k).not.toBe('');
  });
  it('required app keys are known and the app file is written with forward slashes (review M9)', () => {
    env = buildSmokeEnv(() => ({}));
    expect(readEnvExample(APP_EXAMPLE).required).toEqual(expect.arrayContaining(['DB_APP_PASSWORD', 'FIELD_ENCRYPTION_KEYS']));
    expect(env.infra.APP_ENV_FILE).not.toContain('\\');
  });
  it('preflight lists every missing variable by name and source', () => {
    env = buildSmokeEnv(() => ({}));
    const complete = renderedWith({ DB_HOST: 'pgbouncer', REDIS_URL: 'rediss://x', ...env.app });
    expect(missingSmokeVariables(env, complete, '')).toEqual([]);
    const withoutPassword = Object.fromEntries(Object.entries(env.app).filter(([k]) => k !== 'DB_APP_PASSWORD'));
    const infraWithout = { ...env.infra, POSTGRES_SUPERUSER_PASSWORD: '' };
    const stderr = 'WARN[0000] The "DB_AUTH_STATEMENT_TIMEOUT_MS" variable is not set. Defaulting to a blank string.';
    expect(missingSmokeVariables({ ...env, infra: infraWithout }, renderedWith({ DB_HOST: 'pgbouncer', REDIS_URL: 'rediss://x', ...withoutPassword }), stderr)).toEqual([
      'DB_APP_PASSWORD (service api)',
      'DB_APP_PASSWORD (service migrate)',
      'DB_APP_PASSWORD (service worker)',
      'DB_AUTH_STATEMENT_TIMEOUT_MS (compose interpolation)',
      'POSTGRES_SUPERUSER_PASSWORD (.env.infra)',
    ]);
  });
  it('SMOKE_SUBNET is overridable, validated, and checked for overlaps', () => {
    vi.stubEnv('SMOKE_SUBNET', '10.99.0.0/24');
    expect(smokeSubnet()).toBe('10.99.0.0/24');
    vi.stubEnv('SMOKE_SUBNET', '10.999.0.0/24');
    expect(() => smokeSubnet()).toThrow(/IPv4 CIDR/);
    expect(overlappingSubnets('172.31.250.0/24', ['172.16.0.0/12', '10.0.0.0/8'])).toEqual(['172.16.0.0/12']);
    expect(overlappingSubnets('172.31.250.0/24', ['172.31.251.0/24'])).toEqual([]);
  });
});
```
(`test/unit/**` thuộc project `unit`; import từ `test/smoke` được vì cả hai là code test.)

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/smoke && pnpm vitest run --project smoke`
Expected: FAIL — `test/smoke/smoke-env.ts` chưa có; project `smoke` chưa tồn tại.

- [ ] **Step 3: Chứng chỉ và override compose**

`test/smoke/gen-certs.sh`:
```bash
#!/usr/bin/env bash
# Chạy trong image Postgres (có openssl) lúc `compose up` của smoke: CA tạm + một chứng chỉ server cho
# mọi service hạ tầng. Idempotent: volume đã có CA thì giữ nguyên.
set -euo pipefail
: "${REDIS_APP_USER:?required}" "${REDIS_PASSWORD:?required}"
cd /certs
if [ -f ca.crt ]; then exit 0; fi
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=nsb-smoke-ca" -keyout ca.key -out ca.crt
openssl req -newkey rsa:2048 -nodes -subj "/CN=nsb-smoke" -keyout server.key -out server.csr
printf 'subjectAltName=DNS:postgres,DNS:pgbouncer,DNS:redis,DNS:mailpit,DNS:localhost,IP:127.0.0.1\n' > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out server.crt
# Postgres chỉ nhận key thuộc chính nó và không cho group/other đọc.
install -o postgres -g postgres -m 0600 server.key pg-server.key
chmod 0644 ca.crt server.crt server.key
printf 'user default off\nuser %s on >%s ~* &* +@all\n' "$REDIS_APP_USER" "$REDIS_PASSWORD" > users.acl
chmod 0644 users.acl
rm -f ca.key ca.srl server.csr san.ext
```
Xác nhận tên biến TLS của Mailpit: `docker run --rm $(grep '^IMAGE_MAILPIT=' docker/images.env | cut -d= -f2-) --help | grep -i -E 'tls|starttls'` (mong đợi `--smtp-tls-cert`/`MP_SMTP_TLS_CERT`, `--smtp-tls-key`/`MP_SMTP_TLS_KEY`, `--smtp-require-starttls`/`MP_SMTP_REQUIRE_STARTTLS`; khác thì dùng tên thật).

`test/smoke/compose.smoke.yaml`:
```yaml
# Override CHỈ dùng cho `pnpm test:smoke` (plan SP2 Task 17): hạ tầng TLS cục bộ để app chạy
# NODE_ENV=production với mọi luật production bật (DB verify-full, rediss + ACL, SMTP STARTTLS).
services:
  smoke-certs:
    image: ${IMAGE_POSTGRES}
    user: root
    entrypoint: ['bash', '/gen-certs.sh']
    environment:
      REDIS_APP_USER: ${REDIS_APP_USER}
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    volumes: ['./test/smoke/gen-certs.sh:/gen-certs.sh:ro', 'smoke-certs:/certs']
  postgres:
    depends_on: { smoke-certs: { condition: service_completed_successfully } }
    command: ['postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/certs/server.crt', '-c', 'ssl_key_file=/certs/pg-server.key']
    volumes: ['smoke-certs:/certs:ro']
  pgbouncer:
    depends_on:
      smoke-certs: { condition: service_completed_successfully }
      postgres: { condition: service_healthy }
    environment:
      CLIENT_TLS_SSLMODE: require
      CLIENT_TLS_CERT_FILE: /certs/server.crt
      CLIENT_TLS_KEY_FILE: /certs/server.key
      SERVER_TLS_SSLMODE: verify-full
      SERVER_TLS_CA_FILE: /certs/ca.crt
    volumes: ['smoke-certs:/certs:ro']
  redis:
    depends_on: { smoke-certs: { condition: service_completed_successfully } }
    command: ['redis-server', '--port', '0', '--tls-port', '6379', '--tls-cert-file', '/certs/server.crt', '--tls-key-file', '/certs/server.key', '--tls-ca-cert-file', '/certs/ca.crt', '--tls-auth-clients', 'no', '--aclfile', '/certs/users.acl', '--maxmemory-policy', 'noeviction']
    environment:
      REDIS_APP_USER: ${REDIS_APP_USER}
    healthcheck:
      test: ['CMD-SHELL', 'redis-cli --tls --cacert /certs/ca.crt --user "$${REDIS_APP_USER}" --pass "$${REDIS_PASSWORD}" ping']
    volumes: ['smoke-certs:/certs:ro']
  mailpit:
    depends_on: { smoke-certs: { condition: service_completed_successfully } }
    environment:
      MP_SMTP_TLS_CERT: /certs/server.crt
      MP_SMTP_TLS_KEY: /certs/server.key
      MP_SMTP_REQUIRE_STARTTLS: 'true'
    volumes: ['smoke-certs:/certs:ro']
  migrate:
    environment: { NODE_EXTRA_CA_CERTS: /certs/ca.crt }
    volumes: ['smoke-certs:/certs:ro']
  api:
    environment: { NODE_EXTRA_CA_CERTS: /certs/ca.crt }
    volumes: ['smoke-certs:/certs:ro']
  worker:
    environment: { NODE_EXTRA_CA_CERTS: /certs/ca.crt }
    volumes: ['smoke-certs:/certs:ro']
networks:
  default:
    ipam:
      config: [{ subnet: '${SMOKE_SUBNET}' }]
volumes:
  smoke-certs: {}
```

- [ ] **Step 4: Env, global setup, helper, project Vitest**

`test/smoke/smoke-env.ts` (review B3: KHÔNG liệt kê tay biến; lấy từ `.env.example`/`.env.infra.example` do `pnpm env:example` sinh từ schema config — CI Task 48 bảo đảm hai file khớp schema — rồi chỉ ghi đè secret, cổng, TLS và giá trị riêng của smoke):
```ts
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Tham số của bộ smoke (không phải config của app). Cổng cao, chỉ bind 127.0.0.1, không đụng cổng dev. */
export const SMOKE_PROJECT = 'nsb-smoke';
/** Mặc định; đặt biến môi trường `SMOKE_SUBNET` khi trùng mạng có sẵn (WSL2/Docker Desktop, review M9). */
export const DEFAULT_SMOKE_SUBNET = '172.31.250.0/24';
export const SMOKE_PORTS = { http: 39300, db: 39301, redis: 39302, pgbouncer: 39303, mailpitUi: 39304, mailpitSmtp: 39305, dashboard: 39306, otel: 39307 } as const;
export const SMOKE_DB = 'app';
export const SMOKE_SUPERUSER = 'postgres';
export const SMOKE_REDIS_USER = 'app';
export const APP_EXAMPLE = '.env.example';
export const INFRA_EXAMPLE = '.env.infra.example';
/** Dấu mà `renderEnvExample` (SP1) gắn cuối dòng mô tả của khoá bắt buộc. */
const REQUIRED_MARK = '(required)';
const CIDR_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export const smokeSecret = (bytes = 24): string => randomBytes(bytes).toString('base64url');

export type EnvExample = { values: Record<string, string>; required: string[] };
export type SmokeEnv = { dir: string; infraFile: string; appFile: string; app: Record<string, string>; infra: Record<string, string>; requiredApp: string[]; requiredInfra: string[] };

/** Đọc file example: giá trị mặc định (bỏ khoá rỗng) và danh sách khoá đánh dấu `(required)`. */
export function readEnvExample(path: string): EnvExample {
  const text = readFileSync(resolve(path), 'utf8');
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseEnv(text))) if (typeof v === 'string' && v !== '') values[k] = v;
  const required: string[] = [];
  let pendingRequired = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) pendingRequired = line.trimEnd().endsWith(REQUIRED_MARK);
    else if (line.includes('=')) {
      if (pendingRequired) required.push(line.slice(0, line.indexOf('=')).trim());
      pendingRequired = false;
    }
  }
  return { values, required };
}

export function smokeSubnet(): string {
  const v = process.env.SMOKE_SUBNET ?? DEFAULT_SMOKE_SUBNET;
  const m = CIDR_V4.exec(v);
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) throw new Error(`SMOKE_SUBNET must be an IPv4 CIDR such as ${DEFAULT_SMOKE_SUBNET}, got "${v}"`);
  return v;
}

/**
 * Config production của container app + biến nội suy của compose = giá trị của hai file example + ghi đè
 * của smoke. Không có khoá nào tắt luật production. Thiếu khoá do schema thêm sau này → preflight báo tên.
 */
export function buildSmokeEnv(extra: (s: { secret: typeof smokeSecret }) => Record<string, string>): SmokeEnv {
  const appExample = readEnvExample(APP_EXAMPLE);
  const infraExample = readEnvExample(INFRA_EXAMPLE);
  const dir = mkdtempSync(join(tmpdir(), 'nsb-smoke-'));
  const redisPassword = smokeSecret();
  const app: Record<string, string> = {
    ...appExample.values,
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    DB_NAME: SMOKE_DB,
    DB_APP_PASSWORD: smokeSecret(),
    DB_RELAY_PASSWORD: smokeSecret(),
    DB_OWNER_PASSWORD: smokeSecret(),
    DB_AUTH_PASSWORD: smokeSecret(),
    DB_SSL_MODE: 'verify-full',
    DB_SSL_CA_PATH: '/certs/ca.crt',
    FIELD_ENCRYPTION_KEYS: JSON.stringify({ s1: randomBytes(32).toString('base64') }),
    FIELD_ENCRYPTION_ACTIVE_KID: 's1',
    ...extra({ secret: smokeSecret }),
  };
  const appFile = join(dir, 'app.env');
  const infraFile = join(dir, 'infra.env');
  const infra: Record<string, string> = {
    ...infraExample.values,
    POSTGRES_SUPERUSER: SMOKE_SUPERUSER,
    POSTGRES_SUPERUSER_PASSWORD: smokeSecret(),
    REDIS_PASSWORD: redisPassword,
    REDIS_APP_USER: SMOKE_REDIS_USER,
    COMPOSE_REDIS_URL: `rediss://${SMOKE_REDIS_USER}:${redisPassword}@redis:6379`,
    DB_PORT_HOST: String(SMOKE_PORTS.db),
    REDIS_PORT_HOST: String(SMOKE_PORTS.redis),
    PGBOUNCER_PORT_HOST: String(SMOKE_PORTS.pgbouncer),
    HTTP_PORT_HOST: String(SMOKE_PORTS.http),
    MAILPIT_UI_PORT_HOST: String(SMOKE_PORTS.mailpitUi),
    MAILPIT_SMTP_PORT_HOST: String(SMOKE_PORTS.mailpitSmtp),
    QUEUE_DASHBOARD_PORT_HOST: String(SMOKE_PORTS.dashboard),
    OTEL_PORT_HOST: String(SMOKE_PORTS.otel),
    SMOKE_SUBNET: smokeSubnet(),
    // Compose trên Windows nhận `/`; `\` trong file dotenv là ký tự escape (review M9).
    APP_ENV_FILE: appFile.replaceAll('\\', '/'),
  };
  const render = (o: Record<string, string>) => `${Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
  writeFileSync(appFile, render(app));
  writeFileSync(infraFile, render(infra));
  return { dir, infraFile, appFile, app, infra, requiredApp: appExample.required, requiredInfra: infraExample.required };
}
```
`test/smoke/smoke-preflight.ts` (fail sớm, trước `docker build`, với danh sách tên biến thiếu):
```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { SMOKE_PROJECT, type SmokeEnv } from './smoke-env.js';

/** Service app nhận config qua `env_file`; mọi khoá `(required)` của `.env.example` phải có giá trị ở đây. */
const APP_SERVICES = ['api', 'worker', 'migrate'] as const;
/** Đặt bởi chính process (`main.api.ts`, `main.worker.ts`, `main.migrate.ts`), không đến từ env. */
const SET_BY_PROCESS = new Set(['APP_ROLE']);
const UNSET_WARNING = /The "(\w+)" variable is not set/g;
const CIDR = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/;

export class SmokePreflightError extends Error {}

export type RenderedCompose = { services: Record<string, { environment?: Record<string, string | null> }> };

/** Hàm thuần (unit test được): tên biến thiếu theo từng nguồn. Rỗng = đủ. */
export function missingSmokeVariables(env: Pick<SmokeEnv, 'infra' | 'requiredApp' | 'requiredInfra'>, rendered: RenderedCompose, composeStderr: string): string[] {
  const missing = new Set<string>();
  for (const m of composeStderr.matchAll(UNSET_WARNING)) missing.add(`${m[1]} (compose interpolation)`);
  for (const k of env.requiredInfra) if (!env.infra[k]) missing.add(`${k} (.env.infra)`);
  for (const svc of APP_SERVICES) {
    const e = rendered.services[svc]?.environment ?? {};
    for (const k of env.requiredApp) if (!SET_BY_PROCESS.has(k) && !e[k]) missing.add(`${k} (service ${svc})`);
  }
  return [...missing].sort();
}

const toRange = (cidr: string): [number, number] | undefined => {
  const m = CIDR.exec(cidr);
  if (!m) return undefined;
  const base = m.slice(1, 5).reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(m[5]));
  const start = base - (base % size);
  return [start, start + size - 1];
};
/** Subnet của smoke không được chồng subnet của network Docker khác (compose báo "Pool overlaps" rất khó đọc). */
export function overlappingSubnets(subnet: string, existing: readonly string[]): string[] {
  const mine = toRange(subnet);
  if (!mine) return [];
  return existing.filter((c) => {
    const r = toRange(c);
    return r !== undefined && r[0] <= mine[1] && mine[0] <= r[1];
  });
}

/** Thu hẹp output JSON của `docker compose config` mà không cast. */
function toRendered(v: unknown): RenderedCompose {
  if (typeof v !== 'object' || v === null || !('services' in v) || typeof v.services !== 'object' || v.services === null)
    throw new SmokePreflightError('smoke preflight: unexpected `docker compose config` output');
  const services: RenderedCompose['services'] = {};
  for (const [name, svc] of Object.entries(v.services)) {
    const env: Record<string, string | null> = {};
    if (typeof svc === 'object' && svc !== null && 'environment' in svc && typeof svc.environment === 'object' && svc.environment !== null)
      for (const [k, val] of Object.entries(svc.environment)) env[k] = typeof val === 'string' ? val : null;
    services[name] = { environment: env };
  }
  return { services };
}

export function assertSmokePreflight(env: SmokeEnv, composeArgs: string[]): void {
  // `config` nội suy y như `up` nhưng không tạo gì; cảnh báo "variable is not set" nằm ở stderr.
  const r = spawnSync('docker', [...composeArgs, '--profile', 'app', 'config', '--format', 'json'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new SmokePreflightError(`smoke preflight: docker compose config failed:\n${r.error?.message ?? r.stderr}`);
  const missing = missingSmokeVariables(env, toRendered(JSON.parse(r.stdout)), r.stderr);
  if (missing.length)
    throw new SmokePreflightError(`smoke preflight: required variables missing or empty:\n  - ${missing.join('\n  - ')}\nFix: add the key to the config schema and run \`pnpm env:example\`, or give it a smoke value in test/smoke/smoke-env.ts / smoke-app-env.ts.`);
  // Network của chính project smoke (lần chạy trước bị ngắt) không tính là trùng.
  const ids = execFileSync('docker', ['network', 'ls', '--format', '{{.ID}} {{.Name}}'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([, name]) => !name?.startsWith(`${SMOKE_PROJECT}_`)).map(([id]) => id ?? '');
  const subnets = ids.length ? execFileSync('docker', ['network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', ...ids], { encoding: 'utf8' }).split(/\s+/).filter(Boolean) : [];
  const subnet = env.infra.SMOKE_SUBNET ?? '';
  const clash = overlappingSubnets(subnet, subnets);
  if (clash.length)
    throw new SmokePreflightError(`smoke preflight: SMOKE_SUBNET ${subnet} overlaps existing Docker networks (${clash.join(', ')}). Set a free /24, e.g. SMOKE_SUBNET=172.31.251.0/24 pnpm test:smoke`);
}
```
`test/smoke/smoke-app-env.ts`:
```ts
/**
 * Config production bổ sung của module cho container app (plan SP2: Task 43 thêm identity + notifications,
 * Task 46 thêm dashboard). Giá trị test, không phải default của app.
 */
export const smokeAppEnv = (_s: { secret: (bytes?: number) => string }): Record<string, string> => ({});
```
`test/smoke/smoke.global-setup.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
import { readImages } from '../support/images.js';
import { smokeAppEnv } from './smoke-app-env.js';
import { SMOKE_DB, SMOKE_PORTS, SMOKE_PROJECT, SMOKE_SUPERUSER, buildSmokeEnv, type SmokeEnv } from './smoke-env.js';
import { assertSmokePreflight } from './smoke-preflight.js';

export type SmokeContext = { apiUrl: string; mailpitApiUrl: string; dashboardUrl: string; composeArgs: string[]; dbName: string; superuser: string };
declare module 'vitest' {
  export interface ProvidedContext {
    smoke: SmokeContext;
  }
}

/** Trùng `image:` của `x-app` trong compose.yaml: compose dùng lại image vừa build. */
const APP_IMAGE = 'nestjs-saas-boilerplate:local';
let env: SmokeEnv | undefined;
let composeArgs: string[] = [];
const docker = (args: string[]) => execFileSync('docker', args, { stdio: 'inherit' });

export async function setup(project: TestProject): Promise<void> {
  const images = readImages();
  env = buildSmokeEnv(smokeAppEnv);
  composeArgs = [
    'compose', '-p', SMOKE_PROJECT,
    '--env-file', 'docker/images.env', '--env-file', env.infraFile, '--env-file', env.appFile,
    '-f', 'compose.yaml', '-f', 'test/smoke/compose.smoke.yaml',
  ];
  // Fail sớm, trước khi build image vài phút, với tên biến thiếu (review B3).
  try {
    assertSmokePreflight(env, composeArgs);
  } catch (err) {
    rmSync(env.dir, { recursive: true, force: true });
    env = undefined;
    composeArgs = [];
    throw err;
  }
  try {
    docker(['build', '--build-arg', `BUILD_IMAGE=${images.IMAGE_NODE_BUILD}`, '--build-arg', `RUNTIME_IMAGE=${images.IMAGE_NODE_RUNTIME}`, '-t', APP_IMAGE, '.']);
    // Dịch vụ một lần (sinh chứng chỉ) chạy riêng: `up --wait` có thể coi container đã thoát là lỗi.
    docker([...composeArgs, 'run', '--rm', 'smoke-certs']);
    docker([...composeArgs, 'up', '-d', '--wait', '--no-deps', 'postgres', 'redis', 'mailpit']);
    docker([...composeArgs, 'up', '-d', '--wait', '--no-deps', 'pgbouncer']);
    docker([...composeArgs, '--profile', 'app', 'run', '--rm', '--no-deps', 'migrate']);
    docker([...composeArgs, '--profile', 'app', 'up', '-d', '--wait', '--no-deps', '--no-build', 'api', 'worker']);
  } catch (err) {
    await teardown();
    throw err;
  }
  project.provide('smoke', {
    apiUrl: `http://127.0.0.1:${SMOKE_PORTS.http}`,
    mailpitApiUrl: `http://127.0.0.1:${SMOKE_PORTS.mailpitUi}`,
    dashboardUrl: `http://127.0.0.1:${SMOKE_PORTS.dashboard}`,
    composeArgs,
    dbName: SMOKE_DB,
    superuser: SMOKE_SUPERUSER,
  });
}

export async function teardown(): Promise<void> {
  if (composeArgs.length) {
    try {
      docker([...composeArgs, '--profile', 'app', 'logs', '--no-color', 'api', 'worker']);
    } finally {
      docker([...composeArgs, '--profile', 'app', 'down', '-v']);
    }
  }
  if (env) rmSync(env.dir, { recursive: true, force: true });
}
```
`test/smoke/smoke-support.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { expect, inject } from 'vitest';

/** Mức pino: 50 = error, 60 = fatal. */
const PINO_ERROR = 50;

export function compose(args: string[]): string {
  try {
    return execFileSync('docker', [...inject('smoke').composeArgs, '--profile', 'app', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const out = typeof err === 'object' && err !== null && 'stdout' in err && 'stderr' in err ? `${String(err.stdout)}${String(err.stderr)}` : String(err);
    throw new Error(`docker compose ${args.join(' ')} failed:\n${out}`);
  }
}
export function psql(sql: string): string {
  const { superuser, dbName } = inject('smoke');
  return compose(['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-At', '-U', superuser, '-d', dbName, '-c', sql]).trim();
}
export function logsSince(sinceIso: string): string {
  return compose(['logs', '--no-color', '--no-log-prefix', '--since', sinceIso, 'api', 'worker']);
}
export function workerHealth(): string {
  const id = compose(['ps', '-q', 'worker']).trim();
  return execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', id], { encoding: 'utf8' }).trim();
}
/** Không dòng log nào mức error/fatal, và không dòng nào chứa chuỗi cấm (email, token, mật khẩu của smoke). */
export function assertCleanLogs(logs: string, forbidden: readonly string[]): void {
  const lines = logs.split('\n').filter(Boolean);
  const errors = lines.filter((l) => {
    if (!l.startsWith('{')) return false;
    const parsed: unknown = JSON.parse(l);
    return typeof parsed === 'object' && parsed !== null && 'level' in parsed && typeof parsed.level === 'number' && parsed.level >= PINO_ERROR;
  });
  expect(errors, 'error/fatal log lines').toEqual([]);
  for (const f of forbidden) expect(lines.filter((l) => l.includes(f)), `logs must not contain ${f}`).toEqual([]);
}

/** Cookie jar tối thiểu (không áp `Secure`: smoke gọi thẳng cổng HTTP của api, đóng vai ingress đã terminate TLS). */
export class CookieJar {
  private readonly jar = new Map<string, string>();
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=thu, 01 jan 1970/i.test(a));
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  get(name: string): string | undefined {
    return this.jar.get(name);
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear(): void {
    this.jar.clear();
  }
}
```
`vitest.config.ts`, thêm project:
```ts
      {
        extends: true,
        test: {
          name: 'smoke',
          include: ['test/smoke/**/*.smoke.spec.ts'],
          globalSetup: ['test/smoke/smoke.global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
```
`package.json` scripts: `"test:smoke": "vitest run --project smoke"`.

- [ ] **Step 5: Chạy smoke, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/smoke && pnpm test:smoke`
Expected: unit PASS; preflight không báo thiếu; image build thành công; compose lên với TLS; 5 test PASS; teardown in log rồi `down -v`. Xác nhận dọn sạch: `docker compose -p nsb-smoke ps -a` rỗng, `docker volume ls --filter name=nsb-smoke` rỗng.
Nếu `up --wait` fail: `docker compose -p nsb-smoke logs <service>` để tìm nguyên nhân (quyền key TLS, tên biến Mailpit, ACL Redis) và sửa `gen-certs.sh`/override; không bao giờ nới luật production trong code.
Kiểm preflight thật một lần: `SMOKE_SUBNET=bad pnpm test:smoke` → fail ngay với `SMOKE_SUBNET must be an IPv4 CIDR`; tạm xoá dòng `DB_APP_STATEMENT_TIMEOUT_MS` khỏi `.env.infra.example` → fail trước `docker build` với `DB_APP_STATEMENT_TIMEOUT_MS (compose interpolation)`; khôi phục bằng `pnpm env:example`.

- [ ] **Step 6: Commit**

```bash
git add test/smoke test/unit/smoke vitest.config.ts package.json
git commit -m "test(smoke): prod-like smoke harness (production image, compose, local TLS, NODE_ENV=production)"
```

---
## Phần D — Notifications (kênh email)

Notifications không import identity (luật 15). `forApi()` chỉ ghi DB + enqueue; renderer, SMTP và handler chỉ có trong `forWorker()`.

### Task 18: Config notifications/SMTP và migration `email_deliveries` (bảng chuẩn hoá)

**Files:**
- Create: `src/modules/notifications/notifications.config.ts`, `src/modules/notifications/templates.ts`, `src/migrations/notifications/Migration<timestamp>_email_deliveries.ts` (tạo bằng CLI), `test/unit/modules/notifications/notifications-config.spec.ts`, `test/integration/notifications/email-deliveries-schema.spec.ts`, `test/integration/core/database/normalization-inventory.spec.ts`
- Modify: `test/support/env.ts`, `test/integration/core/database/rls-catalog.spec.ts` (`GLOBAL_TABLES`), `src/scripts/gen-env-example.ts`, `src/core/scheduler/index.ts` (export `isValidCron`, `normalizeTimezone`), `.env.example` (sinh lại)

**Interfaces:**
- Consumes: `defineConfig`, `defineConfigRule`, `defineProductionRule`, `queueConfig` (SP1).
- Produces:
  - `notificationsConfig` (namespace `notifications`): `defaultLocale`, `claimLeaseMs`, `reenqueueCooldownSec`, `maxTotalAttempts`, `retentionDays`, `reconcileCron`, `reconcileTz`, `reconcileBatchSize`, `purgeCron`, `purgeTz`, `purgeBatchSize`, `purgeMaxBatches`.
  - `smtpConfig` (namespace `smtp`): `host?`, `port`, `secure`, `requireTls`, `user?`, `password?`, `tlsRejectUnauthorized`, `connectionTimeoutMs`, `greetingTimeoutMs`, `socketTimeoutMs`, `sendDeadlineMs` (mặc định 8000 < `RESILIENCE_DEFAULT_TIMEOUT_MS` 10000), `mailFrom?`; `SMTP_RESILIENCE_PROVIDER = 'smtp'`; luật `smtp-deadline-below-resilience-timeout` (review I2).
  - `TEMPLATE_KEYS`, `type TemplateKey`, `TEMPLATE_PARAMS: { [K in TemplateKey]: z.ZodObject }`, `type TemplateParams<K>`, `LOCALE_PATTERN` (từ `notifications/templates.ts`).
  - Bảng `public.email_deliveries` đúng spec §5.11 với mọi `CHECK` của §5.16c, grant `UPDATE` theo cột cho `app_user`.
  - `ANALYSED_COLUMNS` trong `normalization-inventory.spec.ts` (Task 26 bổ sung bảng `auth`).

- [ ] **Step 1: Viết test fail**

`test/unit/modules/notifications/notifications-config.spec.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import '../../../../src/modules/notifications/notifications.config.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';

const base = {
  APP_ROLE: 'worker', NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379',
  DB_HOST: 'h', DB_NAME: 'n', DB_APP_PASSWORD: 'p', DB_RELAY_PASSWORD: 'p',
  FIELD_ENCRYPTION_KEYS: JSON.stringify({ k1: Buffer.alloc(32).toString('base64') }), FIELD_ENCRYPTION_ACTIVE_KID: 'k1',
  SMTP_HOST: 'mail.example.test', MAIL_FROM: 'App <noreply@example.test>',
};
const stub = (env: Record<string, string>) => { for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v); };

describe('notifications/smtp config rules', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts the defaults on a worker', () => { stub({}); expect(() => validateAllConfigs()).not.toThrow(); });
  it('a worker needs SMTP_HOST and MAIL_FROM; the api does not', () => {
    stub({ SMTP_HOST: '' });
    expect(() => validateAllConfigs()).toThrow(/SMTP_HOST and MAIL_FROM are required on the worker/);
    stub({ APP_ROLE: 'api', SMTP_HOST: '', MAIL_FROM: '' });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('the send deadline must be shorter than the claim lease', () => {
    stub({ SMTP_SEND_DEADLINE_MS: '30000', NOTIFICATIONS_CLAIM_LEASE_MS: '20000' });
    expect(() => validateAllConfigs()).toThrow(/SMTP_SEND_DEADLINE_MS .* must be less than NOTIFICATIONS_CLAIM_LEASE_MS/);
  });
  it('the send deadline must be shorter than the resilience timeout of provider smtp (default and override)', () => {
    stub({ SMTP_SEND_DEADLINE_MS: '12000', RESILIENCE_DEFAULT_TIMEOUT_MS: '10000' });
    expect(() => validateAllConfigs()).toThrow(/SMTP_SEND_DEADLINE_MS \(12000\) must be less than the resilience timeout of provider "smtp" \(10000/);
    stub({ SMTP_SEND_DEADLINE_MS: '8000', RESILIENCE_OVERRIDES: JSON.stringify({ smtp: { timeoutMs: 5000 } }) });
    expect(() => validateAllConfigs()).toThrow(/resilience timeout of provider "smtp" \(5000/);
    stub({ SMTP_SEND_DEADLINE_MS: '8000', RESILIENCE_OVERRIDES: JSON.stringify({ smtp: { timeoutMs: 9000 } }) });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('the total job backoff must exceed the claim lease', () => {
    stub({ QUEUE_DEFAULT_ATTEMPTS: '2', QUEUE_DEFAULT_BACKOFF_MS: '1000', NOTIFICATIONS_CLAIM_LEASE_MS: '20000' });
    expect(() => validateAllConfigs()).toThrow(/total retry backoff/);
  });
  it.each(['EN', 'en_US', 'english', 'e'])('rejects locale %s', (loc) => {
    stub({ NOTIFICATIONS_DEFAULT_LOCALE: loc });
    expect(() => validateAllConfigs()).toThrow(/NOTIFICATIONS_DEFAULT_LOCALE/);
  });
  it('production requires TLS to SMTP with certificate verification', () => {
    stub({ NODE_ENV: 'production', SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false' });
    expect(() => validateAllConfigs()).toThrow(/SMTP_SECURE or SMTP_REQUIRE_TLS/);
    stub({ NODE_ENV: 'production', SMTP_REQUIRE_TLS: 'true', SMTP_TLS_REJECT_UNAUTHORIZED: 'false' });
    expect(() => validateAllConfigs()).toThrow(/SMTP_TLS_REJECT_UNAUTHORIZED/);
  });
});
```
(Ở production, các luật production của SP1 — DB TLS, rediss — cũng báo lỗi; test chỉ khớp message của luật SMTP bằng regex, `ConfigValidationError` gom mọi lỗi vào một message.)

`test/integration/notifications/email-deliveries-schema.spec.ts`:
```ts
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../support/infra.js';

let app: pg.Client;
const insert = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    public_id: v7(), template: 'verify-email', locale: 'en', recipient_enc: 'x', params_enc: 'y',
    state: 'PENDING', idempotency_key: `verify-email:${v7()}`, ...over,
  };
  const cols = Object.keys(row);
  return app.query(`INSERT INTO email_deliveries (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING public_id`, Object.values(row));
};

describe('email_deliveries constraints (spec §5.11, §5.16c) as app_user', () => {
  beforeAll(async () => {
    const { pg: p } = getInfra();
    app = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app });
    await app.connect();
  });
  afterAll(async () => app?.end());

  it('accepts a valid PENDING row', async () => { await expect(insert()).resolves.toBeDefined(); });
  it.each([
    ['PENDING with lease_until', { lease_until: new Date() }],
    ['SENDING without owner', { state: 'SENDING', lease_until: new Date() }],
    ['SENT without completed_at', { state: 'SENT', params_enc: null }],
    ['PENDING with completed_at', { completed_at: new Date() }],
    ['FAILED still holding params', { state: 'FAILED', completed_at: new Date() }],
    ['unknown last_error_code', { last_error_code: 'SMTP_EXPLODED' }],
    ['malformed locale', { locale: 'EN_us' }],
    ['idempotency key of another template', { idempotency_key: `reset-password:${v7()}` }],
    ['unknown template', { template: 'newsletter', idempotency_key: `newsletter:${v7()}` }],
    ['negative attempts', { attempts: -1 }],
  ])('rejects %s (23514)', async (_name, over) => {
    await expect(insert(over)).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects a duplicate idempotency key (23505)', async () => {
    const key = `verify-email:${v7()}`;
    await insert({ idempotency_key: key });
    await expect(insert({ idempotency_key: key })).rejects.toMatchObject({ code: '23505' });
  });
  it.each(['recipient_enc', 'template', 'locale', 'idempotency_key', 'public_id', 'created_at'])(
    'app_user cannot UPDATE snapshot column %s (42501)',
    async (col) => {
      const { rows } = await insert();
      await expect(app.query(`UPDATE email_deliveries SET ${col} = ${col} WHERE public_id = $1`, [rows[0].public_id])).rejects.toMatchObject({ code: '42501' });
    },
  );
  it('app_user can UPDATE the state columns', async () => {
    const { rows } = await insert();
    await app.query(`UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL, updated_at = now() WHERE public_id = $1`, [rows[0].public_id]);
  });
});
```
`test/integration/core/database/normalization-inventory.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';

/**
 * Cột của mọi bảng SP2 đã được phân tích ở bảng chuẩn hoá của spec §5.16. Có cột mới mà chưa phân tích
 * thì test fail: cập nhật §5.16 (và chú thích migration) trước, rồi mới thêm cột vào đây.
 */
const ANALYSED_COLUMNS: Record<string, readonly string[]> = {
  'public.email_deliveries': [
    'id', 'public_id', 'template', 'locale', 'recipient_enc', 'params_enc', 'state', 'lease_owner', 'lease_until',
    'idempotency_key', 'attempts', 'enqueue_generation', 'last_enqueued_at', 'last_error_code', 'completed_at',
    'created_at', 'updated_at',
  ],
};

describe('normalization inventory (spec §5.16)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => owner?.end());

  it.each(Object.entries(ANALYSED_COLUMNS))('%s has exactly the analysed columns', async (qualified, expected) => {
    const [schema, table] = qualified.split('.');
    const { rows } = await owner.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, table],
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([...expected].sort());
  });
});
```
`test/integration/core/database/rls-catalog.spec.ts`: thêm `'email_deliveries'` vào `GLOBAL_TABLES` với chú thích "global: email giao dịch của auth, không thuộc org (spec SP2 §5.11)".

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/notifications/notifications-config.spec.ts; pnpm vitest run --project integration test/integration/notifications test/integration/core/database`
Expected: FAIL — config chưa có; bảng `email_deliveries` chưa tồn tại.

- [ ] **Step 3: Config và template registry**

`src/modules/notifications/templates.ts`:
```ts
import { z } from 'zod';

/** Key template: trùng `CHECK (template IN (…))` của `email_deliveries` và tên thư mục `templates/<key>/`. */
export const TEMPLATE_KEYS = ['verify-email', 'reset-password', 'two-factor-changed', 'existing-account'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
/** Cùng regex với `CHECK (locale ~ …)` của `email_deliveries` (spec §5.16c thay đổi 3). */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const DISPLAY_NAME_MAX = 200;
/** Chuỗi hiển thị một dòng: không CR/LF (subject, text) — Review Focus 4. */
const displayName = z.string().max(DISPLAY_NAME_MAX).regex(/^[^\r\n]*$/, 'must be a single line');

/**
 * Params theo template. Không template nào chứa địa chỉ người nhận (người nhận chỉ nằm ở `recipient_enc`,
 * spec §5.16c). `.strict()`: key lạ là lỗi của caller.
 */
export const TEMPLATE_PARAMS = {
  'verify-email': z.object({ name: displayName, url: z.url() }).strict(),
  'reset-password': z.object({ name: displayName, url: z.url() }).strict(),
  'two-factor-changed': z.object({ name: displayName, enabled: z.boolean(), occurredAt: z.iso.datetime() }).strict(),
  // Không có link: thư chỉ báo tài khoản đã tồn tại (không cần thêm config URL của frontend).
  'existing-account': z.object({ name: displayName }).strict(),
} as const satisfies Record<TemplateKey, z.ZodObject>;
export type TemplateParams<K extends TemplateKey> = z.infer<(typeof TEMPLATE_PARAMS)[K]>;

export const isTemplateKey = (v: string): v is TemplateKey => (TEMPLATE_KEYS as readonly string[]).includes(v);
```
`src/modules/notifications/notifications.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig, defineConfigRule, defineProductionRule } from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';
import { LOCALE_PATTERN } from './templates.js';

const positiveInt = z.coerce.number().int().positive();
const cron = z.string().min(1).refine(isValidCron, 'must be a valid cron expression');
const timezone = z.string().min(1).refine((tz) => normalizeTimezone(tz) !== undefined, 'must be an IANA timezone name');

export const notificationsConfig = defineConfig(
  'notifications',
  {
    defaultLocale: 'NOTIFICATIONS_DEFAULT_LOCALE',
    claimLeaseMs: 'NOTIFICATIONS_CLAIM_LEASE_MS',
    reenqueueCooldownSec: 'NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC',
    maxTotalAttempts: 'NOTIFICATIONS_MAX_TOTAL_ATTEMPTS',
    retentionDays: 'NOTIFICATIONS_RETENTION_DAYS',
    reconcileCron: 'NOTIFICATIONS_RECONCILE_CRON',
    reconcileTz: 'NOTIFICATIONS_RECONCILE_TZ',
    reconcileBatchSize: 'NOTIFICATIONS_RECONCILE_BATCH_SIZE',
    purgeCron: 'NOTIFICATIONS_PURGE_CRON',
    purgeTz: 'NOTIFICATIONS_PURGE_TZ',
    purgeBatchSize: 'NOTIFICATIONS_PURGE_BATCH_SIZE',
    purgeMaxBatches: 'NOTIFICATIONS_PURGE_MAX_BATCHES',
  },
  z.object({
    defaultLocale: z.string().regex(LOCALE_PATTERN).default('en')
      .describe('Locale of transactional emails; the worker refuses to start unless every template has files for it'),
    claimLeaseMs: positiveInt.default(20000)
      .describe('How long a worker owns a delivery it claimed (fencing lease); must exceed SMTP_SEND_DEADLINE_MS and be below the total job retry backoff'),
    reenqueueCooldownSec: positiveInt.default(300)
      .describe('Minimum time between two re-enqueues of the same stuck delivery by the reconcile cron'),
    maxTotalAttempts: positiveInt.default(10)
      .describe('Claims after which the reconcile cron gives a stuck delivery up (FAILED + event)'),
    retentionDays: positiveInt.default(30).describe('Delete SENT/FAILED deliveries older than this'),
    reconcileCron: cron.default('*/5 * * * *').describe('Cron of notifications.reconcile-deliveries'),
    reconcileTz: timezone.default('UTC').describe('Timezone of the reconcile cron'),
    reconcileBatchSize: positiveInt.default(200).describe('Stuck deliveries examined per reconcile run'),
    purgeCron: cron.default('30 4 * * *').describe('Cron of notifications.purge-deliveries'),
    purgeTz: timezone.default('UTC').describe('Timezone of the purge cron'),
    purgeBatchSize: positiveInt.default(5000).describe('Rows deleted per purge statement'),
    purgeMaxBatches: positiveInt.default(100).describe('Max purge statements per run'),
  }),
);

export const smtpConfig = defineConfig(
  'smtp',
  {
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    secure: 'SMTP_SECURE',
    requireTls: 'SMTP_REQUIRE_TLS',
    user: 'SMTP_USER',
    password: 'SMTP_PASSWORD',
    tlsRejectUnauthorized: 'SMTP_TLS_REJECT_UNAUTHORIZED',
    connectionTimeoutMs: 'SMTP_CONNECTION_TIMEOUT_MS',
    greetingTimeoutMs: 'SMTP_GREETING_TIMEOUT_MS',
    socketTimeoutMs: 'SMTP_SOCKET_TIMEOUT_MS',
    sendDeadlineMs: 'SMTP_SEND_DEADLINE_MS',
    mailFrom: 'MAIL_FROM',
  },
  z.object({
    host: z.string().optional().describe('SMTP host (required on the worker)'),
    port: positiveInt.default(587).describe('SMTP port'),
    secure: z.stringbool().default(false).describe('Implicit TLS (port 465)'),
    requireTls: z.stringbool().default(true).describe('Require STARTTLS on a plain connection'),
    user: z.string().optional().describe('SMTP username (empty = no AUTH)'),
    password: z.string().optional().describe('SMTP password (secret)'),
    tlsRejectUnauthorized: z.stringbool().default(true).describe('Verify the SMTP server certificate'),
    connectionTimeoutMs: positiveInt.default(5000).describe('Connect timeout'),
    greetingTimeoutMs: positiveInt.default(5000).describe('Timeout waiting for the SMTP greeting'),
    socketTimeoutMs: positiveInt.default(10000).describe('Socket inactivity timeout'),
    sendDeadlineMs: positiveInt.default(8000)
      .describe('Hard deadline for one send; on expiry the pooled connection is closed and the attempt counts as SMTP_TIMEOUT. Must be below NOTIFICATIONS_CLAIM_LEASE_MS and below the resilience timeout of the "smtp" provider'),
    mailFrom: z.string().optional().describe('From header, e.g. "App <noreply@example.com>" (required on the worker)'),
  }),
);

defineConfigRule('smtp-required-on-worker', (c) =>
  c.app?.role === 'worker' && (!c.smtp?.host || !c.smtp?.mailFrom)
    ? 'SMTP_HOST and MAIL_FROM are required on the worker (it sends the emails)'
    : undefined,
);
/** Tên provider của breaker/bulkhead cho SMTP (hằng số, không phải host); transport (Task 22) dùng lại. */
export const SMTP_RESILIENCE_PROVIDER = 'smtp';
const numberAt = (v: unknown, ...path: string[]): number | undefined => {
  let cur: unknown = v;
  for (const k of path) cur = typeof cur === 'object' && cur !== null && k in cur ? Reflect.get(cur, k) : undefined;
  return typeof cur === 'number' ? cur : undefined;
};
/**
 * Review I2: transport chạy trong `ResiliencePolicies.single` có timeout Aggressive. Nếu timeout đó tới trước
 * hạn chót của transport, lỗi là `TaskCancelledError` → `SMTP_TRANSIENT` thay vì `SMTP_TIMEOUT` và socket
 * không được đóng bởi nhánh deadline. Hạn chót phải tới trước (tính cả `RESILIENCE_OVERRIDES.smtp.timeoutMs`).
 */
defineConfigRule('smtp-deadline-below-resilience-timeout', (c) => {
  const deadline = c.smtp?.sendDeadlineMs;
  const timeoutMs = numberAt(c.resilience?.overrides, SMTP_RESILIENCE_PROVIDER, 'timeoutMs') ?? c.resilience?.timeoutMs;
  if (typeof deadline !== 'number' || typeof timeoutMs !== 'number') return 'smtp deadline rule needs the smtp and resilience namespaces';
  return deadline < timeoutMs ? undefined : `SMTP_SEND_DEADLINE_MS (${deadline}) must be less than the resilience timeout of provider "${SMTP_RESILIENCE_PROVIDER}" (${timeoutMs}; RESILIENCE_OVERRIDES.smtp.timeoutMs or RESILIENCE_DEFAULT_TIMEOUT_MS)`;
});
defineConfigRule('notifications-deadline-below-lease', (c) => {
  const deadline = c.smtp?.sendDeadlineMs;
  const lease = c.notifications?.claimLeaseMs;
  if (typeof deadline !== 'number' || typeof lease !== 'number') return 'notifications rules need the smtp and notifications namespaces';
  return deadline < lease ? undefined : `SMTP_SEND_DEADLINE_MS (${deadline}) must be less than NOTIFICATIONS_CLAIM_LEASE_MS (${lease})`;
});
/**
 * Backoff mũ của BullMQ: lần thử thứ n chờ backoff × 2^(n−1), nên tổng trước lần thử cuối là
 * backoff × (2^(attempts−1) − 1). Tổng đó phải vượt lease, để một job thấy `SENDING` còn lease (vd. do
 * worker chết) còn lượt thử sau khi lease hết hạn; phần sót lại do cron đối soát bắt (spec §5.11).
 */
defineConfigRule('notifications-backoff-exceeds-lease', (c) => {
  const attempts = c.queue?.attempts;
  const backoff = c.queue?.backoffMs;
  const lease = c.notifications?.claimLeaseMs;
  if (typeof attempts !== 'number' || typeof backoff !== 'number' || typeof lease !== 'number')
    return 'notifications rules need the queue and notifications namespaces';
  const total = backoff * (2 ** (attempts - 1) - 1);
  return total > lease ? undefined : `total retry backoff of QUEUE_DEFAULT_ATTEMPTS/QUEUE_DEFAULT_BACKOFF_MS (${total} ms) must exceed NOTIFICATIONS_CLAIM_LEASE_MS (${lease} ms)`;
});
defineProductionRule('smtp-tls', (c) => {
  if (!c.smtp?.secure && !c.smtp?.requireTls) return 'SMTP_SECURE or SMTP_REQUIRE_TLS must be true in production';
  if (c.smtp?.tlsRejectUnauthorized !== true) return 'SMTP_TLS_REJECT_UNAUTHORIZED must be true in production';
  return undefined;
});
```
`src/core/scheduler/index.ts`: thêm `export { isValidCron, normalizeTimezone } from './schedule-validation.js';` (module không được import file nội bộ của core; `outboxConfig` đang dùng chính hai hàm này).

`test/support/env.ts` (`baseTestEnv`), thêm:
```ts
    SMTP_HOST: getInfra().mailpit.smtpHost,
    SMTP_PORT: String(getInfra().mailpit.smtpPort),
    SMTP_SECURE: 'false',
    // Mailpit của test không bật STARTTLS; smoke (Task 43) chạy STARTTLS bắt buộc như production.
    SMTP_REQUIRE_TLS: 'false',
    MAIL_FROM: 'Boilerplate <noreply@example.test>',
```
`src/scripts/gen-env-example.ts`: thêm import config của module (quyết định của SP2 cho khoảng trống "chưa quyết" ở README SP1: script nạp config của module nền mà boilerplate bật sẵn):
```ts
import '../modules/notifications/notifications.config.js';
```
Run: `pnpm env:example`.

- [ ] **Step 4: Migration bằng CLI**

Run:
```bash
pnpm exec mikro-orm migration:create --help
pnpm exec mikro-orm migration:create --blank --path src/migrations/notifications --name email_deliveries
```
Sửa file vừa sinh (`src/migrations/notifications/Migration<timestamp>_email_deliveries.ts`, giữ tên lớp CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * `public.email_deliveries` (spec SP2 §5.11). Bảng global (không org_id): email giao dịch của auth.
 *
 * Bảng chuẩn hoá (spec §5.16a, §5.16c):
 * | Khoá ứng viên | {id}, {public_id}, {idempotency_key} |
 * | Phụ thuộc hàm không tầm thường | mỗi khoá → mọi cột; idempotency_key → template (tiền tố); lease_owner (≠ NULL) là v7 duy nhất mỗi lần claim |
 * | Dạng chuẩn | BCNF: mọi vế trái là siêu khoá |
 * | Ngoại lệ có lý do | recipient_enc là snapshot bất biến (không phải bản sao auth."user".email); cơ chế: grant UPDATE theo cột |
 * | Tài liệu mờ | params_enc (JSON đã mã hoá, chỉ renderer đọc, xoá ở trạng thái cuối) |
 * | Enum | template, state, last_error_code: TEXT + CHECK; locale: CHECK định dạng, tập hợp do file template quyết định |
 * Thay đổi do chuẩn hoá: completed_at thay sent_at/failed_at; CHECK last_error_code; CHECK locale; CHECK tiền tố
 * idempotency_key; CHECK trạng thái cuối không còn params; UPDATE theo cột.
 *
 * Index: (created_at) WHERE cuối → cron dọn; (last_enqueued_at) WHERE PENDING/SENDING → cron đối soát + metric tồn đọng.
 */
export class Migration20260927000000_email_deliveries extends Migration {
  override name = 'Migration20260927000000_email_deliveries';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE email_deliveries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id UUID NOT NULL UNIQUE,
    template TEXT NOT NULL CHECK (template IN ('verify-email', 'reset-password', 'two-factor-changed', 'existing-account')),
    locale TEXT NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
    recipient_enc TEXT NOT NULL,
    params_enc TEXT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
    lease_owner UUID NULL,
    lease_until TIMESTAMPTZ NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    enqueue_generation INT NOT NULL DEFAULT 0 CHECK (enqueue_generation >= 0),
    last_enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error_code TEXT NULL CHECK (last_error_code IN ('SMTP_TRANSIENT', 'SMTP_PERMANENT', 'SMTP_TIMEOUT', 'SMTP_CONNECTION')),
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT email_deliveries_idempotency_prefix_ck CHECK (starts_with(idempotency_key, template || ':')),
    CONSTRAINT email_deliveries_lease_ck CHECK (
      (state = 'SENDING' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'SENDING' AND lease_owner IS NULL AND lease_until IS NULL)),
    CONSTRAINT email_deliveries_completed_ck CHECK ((state IN ('SENT', 'FAILED')) = (completed_at IS NOT NULL)),
    CONSTRAINT email_deliveries_final_params_ck CHECK (state NOT IN ('SENT', 'FAILED') OR params_enc IS NULL));`);
    this.addSql(`CREATE INDEX email_deliveries_purge_idx ON email_deliveries (created_at) WHERE state IN ('SENT', 'FAILED');`);
    this.addSql(`CREATE INDEX email_deliveries_reconcile_idx ON email_deliveries (last_enqueued_at) WHERE state IN ('PENDING', 'SENDING');`);
    this.addSql(`GRANT SELECT, INSERT, DELETE ON email_deliveries TO app_user;`);
    // Snapshot bất biến (public_id, template, locale, recipient_enc, idempotency_key, created_at): không ai sửa được.
    this.addSql(`GRANT UPDATE (params_enc, state, lease_owner, lease_until, attempts, enqueue_generation, last_enqueued_at, last_error_code, completed_at, updated_at) ON email_deliveries TO app_user;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE email_deliveries;`);
  }
}
```

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run:
```bash
pnpm vitest run --project unit test/unit/modules/notifications
pnpm vitest run --project integration test/integration/notifications test/integration/core/database
pnpm typecheck && pnpm lint && pnpm arch
```
Expected: PASS (kể cả `migrations.spec.ts` up → down 0 → up).

- [ ] **Step 6: Commit**

```bash
git add src/modules/notifications src/migrations/notifications src/scripts/gen-env-example.ts src/core/scheduler/index.ts .env.example test/support/env.ts test/unit/modules/notifications test/integration/notifications test/integration/core/database
git commit -m "feat(notifications): config, template registry and email_deliveries table with normalization constraints"
```

---

### Task 19: Domain — state machine `EmailDelivery`

**Files:**
- Create: `src/modules/notifications/domain/email-delivery.ts`
- Test: `test/unit/modules/notifications/email-delivery.spec.ts`

**Interfaces:**
- Consumes: không.
- Produces: `DELIVERY_STATES`, `type DeliveryState = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED'`, `type DeliveryEvent = { type: 'CLAIM'; leaseExpired: boolean } | { type: 'SEND_OK' } | { type: 'TRANSIENT_FAILURE'; finalAttempt: boolean } | { type: 'PERMANENT_FAILURE' } | { type: 'ATTEMPTS_EXHAUSTED' }`, `transition(state, event): DeliveryState` (ném `InvalidDeliveryTransition`), `isFinal(state): boolean`, `deliveryAad(column: 'recipient_enc' | 'params_enc', publicId: string): string`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/notifications/email-delivery.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATES, InvalidDeliveryTransition, deliveryAad, isFinal, transition,
  type DeliveryEvent, type DeliveryState,
} from '../../../../src/modules/notifications/domain/email-delivery.js';

const EVENTS: DeliveryEvent[] = [
  { type: 'CLAIM', leaseExpired: false }, { type: 'CLAIM', leaseExpired: true }, { type: 'SEND_OK' },
  { type: 'TRANSIENT_FAILURE', finalAttempt: false }, { type: 'TRANSIENT_FAILURE', finalAttempt: true },
  { type: 'PERMANENT_FAILURE' }, { type: 'ATTEMPTS_EXHAUSTED' },
];
/** Bảng đầy đủ (spec §5.11): mọi cặp trạng thái × sự kiện; `null` = không hợp lệ. */
const EXPECTED: Record<DeliveryState, (DeliveryState | null)[]> = {
  PENDING: ['SENDING', 'SENDING', null, null, null, null, 'FAILED'],
  SENDING: [null, 'SENDING', 'SENT', 'PENDING', 'FAILED', 'FAILED', 'FAILED'],
  SENT: [null, null, null, null, null, null, null],
  FAILED: [null, null, null, null, null, null, null],
};

describe('EmailDelivery state machine', () => {
  for (const state of DELIVERY_STATES)
    EVENTS.forEach((event, i) => {
      const want = EXPECTED[state][i];
      it(`${state} + ${JSON.stringify(event)} → ${want ?? 'invalid'}`, () => {
        if (want === null) expect(() => transition(state, event)).toThrow(InvalidDeliveryTransition);
        else expect(transition(state, event)).toBe(want);
      });
    });
  it('SENT and FAILED are final', () => {
    expect(DELIVERY_STATES.filter(isFinal)).toEqual(['SENT', 'FAILED']);
  });
  it('AAD binds the column and the public id', () => {
    expect(deliveryAad('recipient_enc', 'p1')).toBe('email_deliveries:recipient_enc:-:p1');
    expect(deliveryAad('params_enc', 'p1')).toBe('email_deliveries:params_enc:-:p1');
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/notifications/email-delivery.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/notifications/domain/email-delivery.ts`:
```ts
export const DELIVERY_STATES = ['PENDING', 'SENDING', 'SENT', 'FAILED'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export type DeliveryEvent =
  | { type: 'CLAIM'; leaseExpired: boolean }
  | { type: 'SEND_OK' }
  | { type: 'TRANSIENT_FAILURE'; finalAttempt: boolean }
  | { type: 'PERMANENT_FAILURE' }
  | { type: 'ATTEMPTS_EXHAUSTED' };

export class InvalidDeliveryTransition extends Error {
  constructor(state: DeliveryState, event: DeliveryEvent) {
    super(`Invalid email delivery transition: ${state} + ${event.type}`);
    this.name = 'InvalidDeliveryTransition';
  }
}

export const isFinal = (s: DeliveryState): boolean => s === 'SENT' || s === 'FAILED';

/**
 * PENDING --claim--> SENDING --send ok--> SENT; SENDING (lease hết hạn) --claim--> SENDING (owner mới);
 * SENDING --lỗi tạm thời--> PENDING; SENDING --lỗi vĩnh viễn | lần thử cuối--> FAILED;
 * PENDING/SENDING hết lease --vượt NOTIFICATIONS_MAX_TOTAL_ATTEMPTS--> FAILED. SENT, FAILED là cuối.
 */
export function transition(state: DeliveryState, event: DeliveryEvent): DeliveryState {
  const invalid = (): never => {
    throw new InvalidDeliveryTransition(state, event);
  };
  switch (event.type) {
    case 'CLAIM':
      if (state === 'PENDING') return 'SENDING';
      return state === 'SENDING' && event.leaseExpired ? 'SENDING' : invalid();
    case 'SEND_OK':
      return state === 'SENDING' ? 'SENT' : invalid();
    case 'TRANSIENT_FAILURE':
      if (state !== 'SENDING') return invalid();
      return event.finalAttempt ? 'FAILED' : 'PENDING';
    case 'PERMANENT_FAILURE':
      return state === 'SENDING' ? 'FAILED' : invalid();
    case 'ATTEMPTS_EXHAUSTED':
      return state === 'PENDING' || state === 'SENDING' ? 'FAILED' : invalid();
    default: {
      const unknown: never = event;
      throw new Error(`unknown delivery event ${JSON.stringify(unknown)}`);
    }
  }
}

/** AAD của `FieldCipher` cho cột mã hoá của `email_deliveries` (spec §5.11): bảng global nên phần org là `-`. */
export const deliveryAad = (column: 'recipient_enc' | 'params_enc', publicId: string): string =>
  `email_deliveries:${column}:-:${publicId}`;
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/notifications && pnpm arch`
Expected: PASS (domain không import infra/http/thư viện, luật `domain-pure`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications/domain test/unit/modules/notifications/email-delivery.spec.ts
git commit -m "feat(notifications): explicit email delivery state machine"
```

---

### Task 20: `EmailNotifications.request` — repository SQL, job `notifications.send-email`, `NotificationsModule.forApi()`

**Files:**
- Create: `src/modules/notifications/ports/email-notifications.ts`, `src/modules/notifications/ports/delivery-repository.ts`, `src/modules/notifications/infra/sql-delivery.repository.ts`, `src/modules/notifications/application/request-email.service.ts`, `src/modules/notifications/jobs.ts`, `src/modules/notifications/events.ts`, `src/modules/notifications/errors.ts`, `src/modules/notifications/notifications.module.ts`, `src/modules/notifications/index.ts`
- Test: `test/unit/modules/notifications/jobs.spec.ts`, `test/integration/notifications/request-email.spec.ts`

**Interfaces:**
- Consumes: `Db`, `UnitOfWork`, `SafeEnqueue`, `FieldCipher`, `SecurityModule`, `defineQueue`, `defineJob`, `defineEvent`, `MaintenanceQueue` (SP1); `TEMPLATE_PARAMS`, `notificationsConfig` (Task 18); `deliveryAad` (Task 19).
- Produces:
  - `abstract class EmailNotifications { request<K extends TemplateKey>(req: EmailRequest<K>): Promise<{ created: boolean }> }`, `type EmailRequest<K> = { template: K; to: string; params: TemplateParams<K>; idempotencyKey: string }` (export từ `notifications/index.ts`).
  - `abstract class DeliveryRepository` với `insert`, `claim`, `status`, `complete`, `release`, `fail`, `findStale`, `failExhausted`, `bumpGeneration`, `purge` (chữ ký ở Step 3), cài bằng `SqlDeliveryRepository` (Db, `app_user`).
  - `NotificationsQueue` (`notifications`, io), `SendEmailJob` (`notifications.send-email`, payload `{ deliveryId: uuid }` strict), `ReconcileDeliveriesJob`, `PurgeDeliveriesJob` (maintenance) và hai cron (`notifications/jobs.ts`).
  - `DeliveryFailedEvent` = `notifications.delivery.failed@1` `{ deliveryId, template, errorCode }`, `DELIVERY_FAILURE_CODES` (`notifications/events.ts`).
  - `NotificationsModule.forApi(): DynamicModule` (global, export `EmailNotifications`).

- [ ] **Step 1: Viết test fail**

`test/unit/modules/notifications/jobs.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SendEmailJob } from '../../../../src/modules/notifications/jobs.js';

describe('notifications jobs', () => {
  it('send-email payload carries only the delivery id (no PII in Redis/Bull Board)', () => {
    expect(Object.keys(SendEmailJob.schema.shape)).toEqual(['deliveryId']);
    expect(SendEmailJob.schema.safeParse({ deliveryId: '019dd1a5-9235-70db-8d57-54ef901d8185', to: 'a@b.c' }).success).toBe(false);
  });
});
```
`test/integration/notifications/request-email.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { SecurityModule } from '../../../src/core/security/index.js';
import { EmailNotifications, NotificationsModule } from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

describe('EmailNotifications.request', () => {
  let app: INestApplication; let owner: pg.Client;
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), SecurityModule, NotificationsModule.forApi(),
    ]);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); });

  it('stores an encrypted row and defers the send job with jobId <public_id>-g0 through the outbox', async () => {
    const key = `verify-email:${v7()}`;
    const res = await app.get(EmailNotifications).request({
      template: 'verify-email', to: 'Alice@Example.test', idempotencyKey: key,
      params: { name: 'Alice', url: 'https://app.example.test/verify?token=abc' },
    });
    expect(res).toEqual({ created: true });
    const { rows } = await owner.query('SELECT public_id, state, locale, recipient_enc, params_enc, attempts, enqueue_generation FROM email_deliveries WHERE idempotency_key = $1', [key]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'PENDING', locale: 'en', attempts: 0, enqueue_generation: 0 });
    expect(rows[0].recipient_enc).not.toContain('Alice');
    expect(rows[0].params_enc).not.toContain('token=abc');
    const job = await owner.query(
      `SELECT payload->>'jobId' AS job_id, payload->'payload' AS p FROM outbox_events WHERE type = 'core.job.deferred' AND payload->>'job' = 'notifications.send-email' AND payload->'payload'->>'deliveryId' = $1`,
      [rows[0].public_id],
    );
    expect(job.rows).toEqual([{ job_id: `${rows[0].public_id}-g0`, p: { deliveryId: rows[0].public_id } }]);
  });
  it('the same idempotency key creates nothing the second time', async () => {
    const key = `reset-password:${v7()}`;
    const req = { template: 'reset-password' as const, to: 'b@example.test', idempotencyKey: key, params: { name: 'B', url: 'https://app.example.test/reset?t=1' } };
    await app.get(EmailNotifications).request(req);
    expect(await app.get(EmailNotifications).request(req)).toEqual({ created: false });
    const { rows } = await owner.query('SELECT count(*)::int AS n FROM email_deliveries WHERE idempotency_key = $1', [key]);
    expect(rows[0].n).toBe(1);
  });
  it('rejects params outside the template schema and a key of another template, without writing', async () => {
    const svc = app.get(EmailNotifications);
    await expect(svc.request({ template: 'verify-email', to: 'c@example.test', idempotencyKey: `verify-email:${v7()}`,
      params: { name: 'C\r\nBcc: x@y', url: 'https://a.test' } })).rejects.toThrow(/invalid params for template verify-email/);
    await expect(svc.request({ template: 'verify-email', to: 'c@example.test', idempotencyKey: `reset-password:${v7()}`,
      params: { name: 'C', url: 'https://a.test' } })).rejects.toThrow(/idempotency key must start with "verify-email:"/);
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM email_deliveries WHERE idempotency_key LIKE 'x%'`);
    expect(rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/notifications/jobs.spec.ts; pnpm vitest run --project integration test/integration/notifications/request-email.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/notifications/errors.ts`:
```ts
/** SMTP chuẩn hoá (spec §5.14): trùng `CHECK (last_error_code IN (…))` của `email_deliveries`. */
export const MAIL_ERROR_CODES = ['SMTP_TRANSIENT', 'SMTP_PERMANENT', 'SMTP_TIMEOUT', 'SMTP_CONNECTION'] as const;
export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

/**
 * Lỗi SMTP đã bỏ mọi dữ liệu người dùng: message cố định, không `cause`. Đây là thứ duy nhất vào log,
 * `last_error_code` và failed reason của BullMQ.
 */
export class MailSendError extends Error {
  constructor(
    readonly code: MailErrorCode,
    readonly responseCode?: number,
    readonly command?: string,
  ) {
    super(`SMTP send failed (${code})`);
    this.name = 'MailSendError';
  }
}
export const isTransientMailError = (code: MailErrorCode): boolean => code !== 'SMTP_PERMANENT';

/** Delivery đang được worker khác giữ lease còn hạn: lỗi thường, BullMQ lùi lịch theo backoff. */
export class DeliveryLeaseBusyError extends Error {
  constructor() {
    super('Email delivery is being sent by another worker (lease still active)');
    this.name = 'DeliveryLeaseBusyError';
  }
}
```
`src/modules/notifications/events.ts`:
```ts
import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { TEMPLATE_KEYS } from './templates.js';

/** Lý do thư bị bỏ: 4 mã SMTP, cộng hai lý do không phải SMTP (không vào `last_error_code`). */
export const DELIVERY_FAILURE_CODES = ['SMTP_TRANSIENT', 'SMTP_PERMANENT', 'SMTP_TIMEOUT', 'SMTP_CONNECTION', 'RENDER_FAILED', 'ATTEMPTS_EXHAUSTED'] as const;
export type DeliveryFailureCode = (typeof DELIVERY_FAILURE_CODES)[number];

export const DeliveryFailedEvent = defineEvent({
  type: 'notifications.delivery.failed',
  version: 1,
  schema: z.object({ deliveryId: z.uuid(), template: z.enum(TEMPLATE_KEYS), errorCode: z.enum(DELIVERY_FAILURE_CODES) }),
});
```
`src/modules/notifications/jobs.ts`:
```ts
import { z } from 'zod';
import { MaintenanceQueue, defineJob, defineQueue } from '../../core/queue/index.js';
import { defineCron } from '../../core/scheduler/index.js';
import { notificationsConfig } from './notifications.config.js';

export const NotificationsQueue = defineQueue('notifications', { kind: 'io' });
/** Payload chỉ có id: không PII trong Redis, failed reason hay Bull Board (spec §5.12). */
export const SendEmailJob = defineJob({
  name: 'notifications.send-email',
  queue: NotificationsQueue,
  version: 1,
  schema: z.object({ deliveryId: z.uuid() }).strict(),
});
export const ReconcileDeliveriesJob = defineJob({ name: 'notifications.reconcile-deliveries', queue: MaintenanceQueue, version: 1, schema: z.object({}) });
export const PurgeDeliveriesJob = defineJob({ name: 'notifications.purge-deliveries', queue: MaintenanceQueue, version: 1, schema: z.object({}) });

defineCron({
  key: 'notifications.reconcile-deliveries',
  job: ReconcileDeliveriesJob,
  payload: {},
  schedule: () => {
    const c = notificationsConfig();
    return { cron: c.reconcileCron, tz: c.reconcileTz };
  },
});
defineCron({
  key: 'notifications.purge-deliveries',
  job: PurgeDeliveriesJob,
  payload: {},
  schedule: () => {
    const c = notificationsConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
});

/** jobId của lần enqueue thứ `generation` (0 = lúc tạo; tăng mỗi lần cron đối soát enqueue lại). */
export const sendEmailJobId = (publicId: string, generation: number): string => `${publicId}-g${generation}`;
```
`src/modules/notifications/ports/email-notifications.ts`:
```ts
import type { TemplateKey, TemplateParams } from '../templates.js';

export type EmailRequest<K extends TemplateKey> = {
  template: K;
  to: string;
  params: TemplateParams<K>;
  /** Luôn bắt đầu bằng `<template>:` (DB ép bằng CHECK); trùng key thì không tạo thư mới. */
  idempotencyKey: string;
};

/** Port gửi email giao dịch; identity gọi, notifications cài đặt. Chỉ ghi DB + enqueue, không gọi SMTP. */
export abstract class EmailNotifications {
  abstract request<K extends TemplateKey>(req: EmailRequest<K>): Promise<{ created: boolean }>;
}
```
`src/modules/notifications/ports/delivery-repository.ts`:
```ts
import type { DeliveryState } from '../domain/email-delivery.js';
import type { MailErrorCode } from '../errors.js';
import type { TemplateKey } from '../templates.js';

export type NewDelivery = { publicId: string; template: TemplateKey; locale: string; recipientEnc: string; paramsEnc: string; idempotencyKey: string };
export type ClaimedDelivery = { publicId: string; template: TemplateKey; locale: string; recipientEnc: string; paramsEnc: string; attempts: number };
export type StaleDelivery = { publicId: string; attempts: number };

/** Mọi thao tác ghi trạng thái có fencing theo `lease_owner` (spec §5.11). */
export abstract class DeliveryRepository {
  /** `false` khi idempotency key đã tồn tại (`ON CONFLICT DO NOTHING`). */
  abstract insert(d: NewDelivery): Promise<boolean>;
  /** PENDING, hoặc SENDING hết lease → SENDING với owner mới, `attempts + 1`. */
  abstract claim(publicId: string, owner: string, leaseMs: number): Promise<ClaimedDelivery | undefined>;
  abstract status(publicId: string): Promise<{ state: DeliveryState; leaseActive: boolean } | undefined>;
  abstract complete(publicId: string, owner: string): Promise<boolean>;
  abstract release(publicId: string, owner: string, code: MailErrorCode): Promise<boolean>;
  /** FAILED có fencing; trả template nếu đổi được trạng thái. */
  abstract fail(publicId: string, owner: string, code: MailErrorCode | null): Promise<TemplateKey | undefined>;
  abstract findStale(cooldownSec: number, limit: number): Promise<StaleDelivery[]>;
  /** FAILED khi `attempts >= maxAttempts` và vẫn kẹt (cùng điều kiện với đối soát). */
  abstract failExhausted(publicId: string, maxAttempts: number): Promise<TemplateKey | undefined>;
  /** Tăng generation nếu vẫn kẹt và đã qua thời gian chờ (atomic dưới row lock); `undefined` = bỏ qua. */
  abstract bumpGeneration(publicId: string, cooldownSec: number): Promise<number | undefined>;
  abstract purge(retentionDays: number, limit: number): Promise<number>;
}
```
`src/modules/notifications/infra/sql-delivery.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../core/database/index.js';
import type { DeliveryState } from '../domain/email-delivery.js';
import { DELIVERY_STATES } from '../domain/email-delivery.js';
import type { MailErrorCode } from '../errors.js';
import { DeliveryRepository, type ClaimedDelivery, type NewDelivery, type StaleDelivery } from '../ports/delivery-repository.js';
import { TEMPLATE_KEYS, type TemplateKey } from '../templates.js';

const STUCK = `(state = 'PENDING' OR (state = 'SENDING' AND lease_until < now()))`;
const ClaimRow = z.object({ public_id: z.string(), template: z.enum(TEMPLATE_KEYS), locale: z.string(), recipient_enc: z.string(), params_enc: z.string(), attempts: z.number().int() });
const StatusRow = z.object({ state: z.enum(DELIVERY_STATES), lease_active: z.boolean().nullable() });
const TemplateRow = z.object({ template: z.enum(TEMPLATE_KEYS) });
const StaleRow = z.object({ public_id: z.string(), attempts: z.number().int() });
const GenRow = z.object({ enqueue_generation: z.number().int() });
const CountRow = z.object({ n: z.number().int() });

/** SQL trên connection `app` (`app_user`, grant UPDATE theo cột). Không RLS: bảng global. */
@Injectable()
export class SqlDeliveryRepository extends DeliveryRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async insert(d: NewDelivery): Promise<boolean> {
    const rows = await this.db.execute(
      `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?) ON CONFLICT (idempotency_key) DO NOTHING RETURNING public_id`,
      [d.publicId, d.template, d.locale, d.recipientEnc, d.paramsEnc, d.idempotencyKey],
    );
    return rows.length === 1;
  }

  async claim(publicId: string, owner: string, leaseMs: number): Promise<ClaimedDelivery | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries
          SET state = 'SENDING', lease_owner = ?, lease_until = now() + make_interval(secs => ?::double precision / 1000),
              attempts = attempts + 1, updated_at = now()
        WHERE public_id = ? AND ${STUCK} AND params_enc IS NOT NULL
        RETURNING public_id, template, locale, recipient_enc, params_enc, attempts`,
      [owner, leaseMs, publicId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const r = ClaimRow.parse(row);
    return { publicId: r.public_id, template: r.template, locale: r.locale, recipientEnc: r.recipient_enc, paramsEnc: r.params_enc, attempts: r.attempts };
  }

  async status(publicId: string): Promise<{ state: DeliveryState; leaseActive: boolean } | undefined> {
    const rows = await this.db.execute(`SELECT state, lease_until > now() AS lease_active FROM email_deliveries WHERE public_id = ?`, [publicId]);
    if (!rows[0]) return undefined;
    const r = StatusRow.parse(rows[0]);
    return { state: r.state, leaseActive: r.lease_active === true };
  }

  async complete(publicId: string, owner: string): Promise<boolean> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE public_id = ? AND state = 'SENDING' AND lease_owner = ? RETURNING 1 AS ok`,
      [publicId, owner],
    );
    return rows.length === 1;
  }

  async release(publicId: string, owner: string, code: MailErrorCode): Promise<boolean> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'PENDING', lease_owner = NULL, lease_until = NULL, last_error_code = ?, updated_at = now()
        WHERE public_id = ? AND state = 'SENDING' AND lease_owner = ? RETURNING 1 AS ok`,
      [code, publicId, owner],
    );
    return rows.length === 1;
  }

  async fail(publicId: string, owner: string, code: MailErrorCode | null): Promise<TemplateKey | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'FAILED', lease_owner = NULL, lease_until = NULL, completed_at = now(), params_enc = NULL,
              last_error_code = COALESCE(?, last_error_code), updated_at = now()
        WHERE public_id = ? AND state = 'SENDING' AND lease_owner = ? RETURNING template`,
      [code, publicId, owner],
    );
    return rows[0] ? TemplateRow.parse(rows[0]).template : undefined;
  }

  async findStale(cooldownSec: number, limit: number): Promise<StaleDelivery[]> {
    const rows = await this.db.execute(
      `SELECT public_id, attempts FROM email_deliveries
        WHERE state IN ('PENDING', 'SENDING') AND last_enqueued_at < now() - make_interval(secs => ?) AND ${STUCK}
        ORDER BY last_enqueued_at LIMIT ?`,
      [cooldownSec, limit],
    );
    return rows.map((r) => StaleRow.parse(r)).map((r) => ({ publicId: r.public_id, attempts: r.attempts }));
  }

  async failExhausted(publicId: string, maxAttempts: number): Promise<TemplateKey | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'FAILED', lease_owner = NULL, lease_until = NULL, completed_at = now(), params_enc = NULL, updated_at = now()
        WHERE public_id = ? AND attempts >= ? AND ${STUCK} RETURNING template`,
      [publicId, maxAttempts],
    );
    return rows[0] ? TemplateRow.parse(rows[0]).template : undefined;
  }

  async bumpGeneration(publicId: string, cooldownSec: number): Promise<number | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET enqueue_generation = enqueue_generation + 1, last_enqueued_at = now(), updated_at = now()
        WHERE public_id = ? AND last_enqueued_at < now() - make_interval(secs => ?) AND ${STUCK}
        RETURNING enqueue_generation`,
      [publicId, cooldownSec],
    );
    return rows[0] ? GenRow.parse(rows[0]).enqueue_generation : undefined;
  }

  async purge(retentionDays: number, limit: number): Promise<number> {
    const rows = await this.db.execute(
      `WITH victim AS (SELECT id FROM email_deliveries WHERE state IN ('SENT', 'FAILED') AND created_at < now() - make_interval(days => ?) ORDER BY created_at LIMIT ?)
       , d AS (DELETE FROM email_deliveries e USING victim v WHERE e.id = v.id RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
      [retentionDays, limit],
    );
    return CountRow.parse(rows[0]).n;
  }
}
```
`src/modules/notifications/application/request-email.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import { type ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { FieldCipher } from '../../../core/security/index.js';
import { deliveryAad } from '../domain/email-delivery.js';
import { SendEmailJob, sendEmailJobId } from '../jobs.js';
import { notificationsConfig } from '../notifications.config.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';
import { EmailNotifications, type EmailRequest } from '../ports/email-notifications.js';
import { TEMPLATE_PARAMS, type TemplateKey } from '../templates.js';

@Injectable()
export class RequestEmailService extends EmailNotifications {
  constructor(
    private readonly repo: DeliveryRepository,
    private readonly uow: UnitOfWork,
    private readonly enqueue: SafeEnqueue,
    private readonly cipher: FieldCipher,
    @Inject(notificationsConfig.KEY) private readonly cfg: ConfigOf<typeof notificationsConfig>,
  ) {
    super();
  }

  /**
   * INSERT … ON CONFLICT DO NOTHING rồi SafeEnqueue trong cùng transaction (job đi qua outbox, chỉ tồn tại
   * khi dòng đã commit). Lỗi của caller (params, key) nổ trước khi ghi; message không chứa giá trị.
   */
  async request<K extends TemplateKey>(req: EmailRequest<K>): Promise<{ created: boolean }> {
    const parsed = TEMPLATE_PARAMS[req.template].safeParse(req.params);
    if (!parsed.success)
      throw new Error(`invalid params for template ${req.template}: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    if (!req.idempotencyKey.startsWith(`${req.template}:`))
      throw new Error(`idempotency key must start with "${req.template}:"`);
    const publicId = v7();
    return this.uow.run(async () => {
      const created = await this.repo.insert({
        publicId,
        template: req.template,
        locale: this.cfg.defaultLocale,
        recipientEnc: this.cipher.encrypt(req.to, deliveryAad('recipient_enc', publicId)),
        paramsEnc: this.cipher.encrypt(JSON.stringify(parsed.data), deliveryAad('params_enc', publicId)),
        idempotencyKey: req.idempotencyKey,
      });
      if (created) await this.enqueue.enqueue(SendEmailJob, { deliveryId: publicId }, { jobId: sendEmailJobId(publicId, 0) });
      return { created };
    });
  }
}
```
`src/modules/notifications/notifications.module.ts`:
```ts
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { SecurityModule } from '../../core/security/index.js';
import { RequestEmailService } from './application/request-email.service.js';
import { SqlDeliveryRepository } from './infra/sql-delivery.repository.js';
import { DeliveryRepository } from './ports/delivery-repository.js';
import { EmailNotifications } from './ports/email-notifications.js';
import './jobs.js';
import './events.js';

const shared: Provider[] = [
  SqlDeliveryRepository,
  { provide: DeliveryRepository, useExisting: SqlDeliveryRepository },
  RequestEmailService,
  { provide: EmailNotifications, useExisting: RequestEmailService },
];

/** `forApi`: chỉ ghi DB + enqueue. `forWorker` (Task 24): thêm renderer, SMTP, handler và cron. */
@Module({})
export class NotificationsModule {
  static forApi(): DynamicModule {
    return { module: NotificationsModule, global: true, imports: [SecurityModule], providers: shared, exports: [EmailNotifications] };
  }
}
```
`src/modules/notifications/index.ts`:
```ts
export { NotificationsModule } from './notifications.module.js';
export { EmailNotifications, type EmailRequest } from './ports/email-notifications.js';
export { TEMPLATE_KEYS, type TemplateKey, type TemplateParams } from './templates.js';
export { notificationsConfig, smtpConfig } from './notifications.config.js';
export { DeliveryFailedEvent } from './events.js';
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/notifications && pnpm vitest run --project integration test/integration/notifications && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications test/unit/modules/notifications/jobs.spec.ts test/integration/notifications/request-email.spec.ts
git commit -m "feat(notifications): request transactional email (encrypted row + outbox-deferred send job)"
```

---

### Task 21: Renderer mjml + handlebars và 4 template

**Files:**
- Create: `src/modules/notifications/ports/template-renderer.ts`, `src/modules/notifications/infra/mjml-handlebars.renderer.ts`, `src/modules/notifications/templates/{verify-email,reset-password,two-factor-changed,existing-account}/en/{subject.hbs,body.mjml,text.hbs}`
- Test: `test/unit/modules/notifications/renderer.spec.ts`

**Interfaces:**
- Consumes: `TEMPLATE_KEYS`, `TemplateParams`, `notificationsConfig` (Task 18); kết quả S6 (Task 6) và `assets` của `nest-cli.json`.
- Produces: `type RenderedEmail = { subject: string; html: string; text: string }`, `abstract class TemplateRenderer { render<K extends TemplateKey>(template: K, locale: string, params: TemplateParams<K>): RenderedEmail }`, `class TemplateNotFoundError`, `MjmlHandlebarsRenderer` (compile mọi template lúc `onModuleInit`, fail boot nếu template lỗi hoặc thiếu locale mặc định), token `NOTIFICATION_TEMPLATES_DIR`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/notifications/renderer.spec.ts`:
```ts
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MjmlHandlebarsRenderer, TemplateNotFoundError } from '../../../../src/modules/notifications/infra/mjml-handlebars.renderer.js';
import { TEMPLATE_KEYS, TEMPLATE_PARAMS } from '../../../../src/modules/notifications/templates.js';

const REPO_TEMPLATES = 'src/modules/notifications/templates';
const make = async (dir = REPO_TEMPLATES, locale = 'en') => {
  const r = new MjmlHandlebarsRenderer(dir, { defaultLocale: locale });
  await r.onModuleInit();
  return r;
};
const tmp: string[] = [];
/** Handlebars escape cả `=` (`&#x3D;`), `'`, `` ` `` trong attribute; so sánh URL SAU khi decode HTML (review I1). */
const decodeHtml = (v: string) =>
  v.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => decodeHtml(m[1] ?? ''));
const withTemplateCopy = (file: string, content: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  tmp.push(dir);
  cpSync(REPO_TEMPLATES, dir, { recursive: true });
  writeFileSync(join(dir, file), content);
  return dir;
};
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('MjmlHandlebarsRenderer', () => {
  it('renders every shipped template for the default locale', async () => {
    const r = await make();
    const samples = {
      'verify-email': { name: 'Ann', url: 'https://app.example.test/v?token=a&x=1' },
      'reset-password': { name: 'Ann', url: 'https://app.example.test/r?token=b' },
      'two-factor-changed': { name: 'Ann', enabled: true, occurredAt: '2026-09-27T10:00:00.000Z' },
      'existing-account': { name: 'Ann' },
    } as const;
    for (const key of TEMPLATE_KEYS) {
      const out = r.render(key, 'en', samples[key]);
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.subject).not.toMatch(/[\r\n]/);
      expect(out.html).toContain('<html');
      expect(out.text).toContain('Ann');
    }
    const html = r.render('verify-email', 'en', samples['verify-email']).html;
    expect(hrefs(html)).toContain('https://app.example.test/v?token=a&x=1');
    expect(html).not.toContain('href="https://app.example.test/v?token=a&x=1"'); // vẫn escape trong HTML thô
  });
  it('escapes user-provided params and rejects CRLF in subject params', async () => {
    const r = await make();
    const out = r.render('verify-email', 'en', { name: '<script>alert(1)</script>{{x}}', url: 'https://a.test/v' });
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;{{x}}');
    expect(out.html).not.toContain('<script>alert(1)');
    expect(TEMPLATE_PARAMS['verify-email'].safeParse({ name: 'x\r\nBcc: evil@x', url: 'https://a.test' }).success).toBe(false);
  });
  it('unknown locale at render time is a TemplateNotFoundError (permanent)', async () => {
    const r = await make();
    expect(() => r.render('verify-email', 'fr', { name: 'A', url: 'https://a.test' })).toThrow(TemplateNotFoundError);
  });
  it('refuses to boot when the default locale is missing for a template', async () => {
    await expect(make(REPO_TEMPLATES, 'vi')).rejects.toThrow(/missing templates for locale "vi"/);
  });
  it('refuses to boot on an invalid MJML template (strict validation)', async () => {
    const dir = withTemplateCopy('verify-email/en/body.mjml', '<mjml><mj-body><mj-bogus/></mj-body></mjml>');
    await expect(make(dir)).rejects.toThrow(/verify-email\/en\/body\.mjml/);
  });
  it('refuses to boot on a handlebars syntax error (compile is lazy; boot precompiles — review M8)', async () => {
    const dir = withTemplateCopy('two-factor-changed/en/subject.hbs', '{{#if enabled}}Turned on');
    await expect(make(dir)).rejects.toThrow(/two-factor-changed\/en\/subject\.hbs/);
  });
  it('refuses to boot on an unknown helper (knownHelpersOnly)', async () => {
    const dir = withTemplateCopy('existing-account/en/text.hbs', 'Hi {{shout name}}');
    await expect(make(dir)).rejects.toThrow(/existing-account\/en\/text\.hbs/);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/notifications/renderer.spec.ts`
Expected: FAIL — renderer chưa tồn tại.

- [ ] **Step 3: Template**

`templates/verify-email/en/subject.hbs`:
```
Verify your email address
```
`templates/verify-email/en/body.mjml`:
```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hi {{name}},</mj-text>
        <mj-text>Confirm your email address to finish setting up your account.</mj-text>
        <mj-button href="{{url}}">Verify email</mj-button>
        <mj-text>If you did not ask for this, you can ignore this email.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
`templates/verify-email/en/text.hbs`:
```
Hi {{name}},

Confirm your email address to finish setting up your account:
{{url}}

If you did not ask for this, you can ignore this email.
```
`templates/reset-password/en/subject.hbs`:
```
Reset your password
```
`templates/reset-password/en/body.mjml`:
```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hi {{name}},</mj-text>
        <mj-text>We received a request to reset your password. The link expires soon and works once.</mj-text>
        <mj-button href="{{url}}">Reset password</mj-button>
        <mj-text>If you did not ask for this, ignore this email; your password stays the same.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
`templates/reset-password/en/text.hbs`:
```
Hi {{name}},

We received a request to reset your password. The link expires soon and works once:
{{url}}

If you did not ask for this, ignore this email; your password stays the same.
```
`templates/two-factor-changed/en/subject.hbs`:
```
{{#if enabled}}Two-factor authentication turned on{{else}}Two-factor authentication turned off{{/if}}
```
`templates/two-factor-changed/en/body.mjml`:
```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hi {{name}},</mj-text>
        <mj-text>{{#if enabled}}Two-factor authentication was turned on{{else}}Two-factor authentication was turned off{{/if}} for your account at {{occurredAt}} (UTC).</mj-text>
        <mj-text>If this was not you, reset your password and contact support immediately.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
`templates/two-factor-changed/en/text.hbs`:
```
Hi {{name}},

{{#if enabled}}Two-factor authentication was turned on{{else}}Two-factor authentication was turned off{{/if}} for your account at {{occurredAt}} (UTC).

If this was not you, reset your password and contact support immediately.
```
`templates/existing-account/en/subject.hbs`:
```
You already have an account
```
`templates/existing-account/en/body.mjml`:
```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hi {{name}},</mj-text>
        <mj-text>Someone tried to create an account with this email address, but an account already exists.</mj-text>
        <mj-text>If this was you, sign in instead, or use "Forgot password" in the app to reset your password. If not, you can ignore this email.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```
`templates/existing-account/en/text.hbs`:
```
Hi {{name}},

Someone tried to create an account with this email address, but an account already exists.
If this was you, sign in instead, or use "Forgot password" in the app to reset your password. If not, you can ignore this email.
```

- [ ] **Step 4: Renderer**

`src/modules/notifications/ports/template-renderer.ts`:
```ts
import type { TemplateKey, TemplateParams } from '../templates.js';

export type RenderedEmail = { subject: string; html: string; text: string };

export class TemplateNotFoundError extends Error {
  constructor(template: string, locale: string) {
    super(`No compiled template ${template}/${locale}`);
    this.name = 'TemplateNotFoundError';
  }
}

export abstract class TemplateRenderer {
  abstract render<K extends TemplateKey>(template: K, locale: string, params: TemplateParams<K>): RenderedEmail;
}
```
`src/modules/notifications/infra/mjml-handlebars.renderer.ts`:
```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TemplateNotFoundError, TemplateRenderer, type RenderedEmail } from '../ports/template-renderer.js';
import { LOCALE_PATTERN, TEMPLATE_KEYS, type TemplateKey, type TemplateParams } from '../templates.js';

export const NOTIFICATION_TEMPLATES_DIR = Symbol('notifications.templatesDir');
export const NOTIFICATION_RENDER_OPTIONS = Symbol('notifications.renderOptions');
/** `src/…/templates` khi chạy TS, `dist/…/templates` sau build (assets của nest-cli, spike S6). */
export const defaultTemplatesDir = (): string => fileURLToPath(new URL('../templates/', import.meta.url));

type Compiled = { subject: HandlebarsTemplateDelegate; html: HandlebarsTemplateDelegate; text: HandlebarsTemplateDelegate };
type HandlebarsTemplateDelegate = ReturnType<typeof Handlebars.compile>;
type CompileOptions = NonNullable<Parameters<typeof Handlebars.compile>[1]>;

/**
 * Chỉ compile file trong repo, lúc boot (spec §5.11, research 4): mjml `validationLevel: 'strict'`, không
 * include; handlebars `strict` + `knownHelpersOnly`, instance riêng, không helper, không bật prototype access.
 * HTML escape tham số; subject/text dùng `noEscape` (không phải HTML; CR/LF đã bị chặn ở schema params).
 */
@Injectable()
export class MjmlHandlebarsRenderer extends TemplateRenderer implements OnModuleInit {
  private readonly compiled = new Map<string, Compiled>();
  private readonly hbs = Handlebars.create();

  constructor(
    @Inject(NOTIFICATION_TEMPLATES_DIR) private readonly dir: string,
    @Inject(NOTIFICATION_RENDER_OPTIONS) private readonly opts: { defaultLocale: string },
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    for (const template of TEMPLATE_KEYS) {
      const locales = readdirSync(join(this.dir, template)).filter((l) => LOCALE_PATTERN.test(l));
      for (const locale of locales) this.compiled.set(`${template}/${locale}`, await this.compile(template, locale));
    }
    const missing = TEMPLATE_KEYS.filter((t) => !this.compiled.has(`${t}/${this.opts.defaultLocale}`));
    if (missing.length)
      throw new Error(`missing templates for locale "${this.opts.defaultLocale}": ${missing.join(', ')}`);
  }

  render<K extends TemplateKey>(template: K, locale: string, params: TemplateParams<K>): RenderedEmail {
    const c = this.compiled.get(`${template}/${locale}`);
    if (!c) throw new TemplateNotFoundError(template, locale);
    return { subject: c.subject(params).trim(), html: c.html(params), text: c.text(params) };
  }

  private async compile(template: string, locale: string): Promise<Compiled> {
    const base = join(this.dir, template, locale);
    const read = (f: string) => readFileSync(join(base, f), 'utf8');
    let html: string;
    try {
      const out = await mjml2html(read('body.mjml'), { validationLevel: 'strict', ignoreIncludes: true });
      html = out.html;
    } catch (err) {
      throw new Error(`invalid template ${template}/${locale}/body.mjml`, { cause: err });
    }
    const strict = { strict: true, knownHelpersOnly: true } as const;
    return {
      subject: this.compileHbs(`${template}/${locale}/subject.hbs`, read('subject.hbs'), { ...strict, noEscape: true }),
      html: this.compileHbs(`${template}/${locale}/body.mjml`, html, strict),
      text: this.compileHbs(`${template}/${locale}/text.hbs`, read('text.hbs'), { ...strict, noEscape: true }),
    };
  }

  /**
   * `compile` của handlebars là lazy (lỗi cú pháp chỉ lộ ở lần render đầu, trong job). `precompile` parse và
   * biên dịch ngay, kể cả kiểm `knownHelpersOnly`: template hỏng làm boot fail, có tên file (review M8).
   */
  private compileHbs(file: string, source: string, options: CompileOptions): HandlebarsTemplateDelegate {
    try {
      this.hbs.precompile(source, options);
    } catch (err) {
      throw new Error(`invalid template ${file}`, { cause: err });
    }
    return this.hbs.compile(source, options);
  }
}
```
(Nếu S6 chọn fallback "handlebars trước rồi mjml": `compile` chỉ lưu nguồn MJML đã handlebars-compile, còn `render` gọi `mjml2html` sau handlebars và trở thành `async`; khi đó `TemplateRenderer.render` trả `Promise<RenderedEmail>` và Task 23 `await` nó.)

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/notifications && pnpm typecheck && pnpm lint && pnpm arch && pnpm build && ls dist/modules/notifications/templates/verify-email/en`
Expected: PASS; template có trong `dist/`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/notifications test/unit/modules/notifications/renderer.spec.ts
git commit -m "feat(notifications): strict mjml+handlebars renderer compiled at boot, four auth email templates"
```

---

### Task 22: Transport nodemailer và chuẩn hoá lỗi SMTP (không PII)

**Files:**
- Create: `src/modules/notifications/ports/mail-transport.ts`, `src/modules/notifications/infra/smtp-error.ts`, `src/modules/notifications/infra/nodemailer.transport.ts`, `test/support/fake-smtp.ts`
- Test: `test/unit/modules/notifications/smtp-error.spec.ts`, `test/integration/notifications/nodemailer-transport.spec.ts`

**Interfaces:**
- Consumes: `smtpConfig` (Task 18), `MailSendError` (Task 20), `ResiliencePolicies` (SP1).
- Produces:
  - `type OutgoingMail = { to: string; subject: string; html: string; text: string; messageId: string }`, `abstract class MailTransport { send(mail: OutgoingMail, signal: AbortSignal): Promise<void> }`.
  - `toMailSendError(err: unknown): MailSendError` (`infra/smtp-error.ts`).
  - `NodemailerTransport`: transporter pool riêng cho mỗi lần gửi (`pool: true, maxConnections: 1, maxMessages: 1`), `disableFileAccess`/`disableUrlAccess`, hạn chót tổng `SMTP_SEND_DEADLINE_MS` (đóng pool), đi qua `ResiliencePolicies.for(SMTP_RESILIENCE_PROVIDER).single`. Lỗi vĩnh viễn (`SMTP_PERMANENT`, 5xx do người nhận) được TRẢ VỀ như kết quả từ bên trong policy nên breaker không đếm (review I2: vài địa chỉ sai không được mở breaker cho mọi email); lỗi tạm thời/timeout/kết nối được ném bên trong policy nên breaker vẫn đếm.
  - `startFakeSmtp(mode: 'accept' | 'reject550' | 'reject451' | 'hang'): Promise<FakeSmtp>` (test/support/fake-smtp.ts), `FakeSmtp = { port: number; closedConnections(): number; close(): Promise<void> }`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/notifications/smtp-error.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { errSerializer } from '../../../../src/core/logging/index.js';
import { toMailSendError } from '../../../../src/modules/notifications/infra/smtp-error.js';

const smtpErr = (props: Record<string, unknown>) => Object.assign(new Error('Can\'t send mail - all recipients were rejected: 550 <victim@example.com>'), props);

describe('toMailSendError', () => {
  it.each([
    [{ responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 <victim@example.com> rejected', rejected: ['victim@example.com'] }, 'SMTP_PERMANENT'],
    [{ responseCode: 451, command: 'DATA', response: '451 try later <victim@example.com>' }, 'SMTP_TRANSIENT'],
    [{ code: 'ETIMEDOUT' }, 'SMTP_TIMEOUT'],
    [{ code: 'ECONNECTION' }, 'SMTP_CONNECTION'],
    [{ code: 'ESOCKET' }, 'SMTP_CONNECTION'],
    [{}, 'SMTP_TRANSIENT'],
  ])('%j → %s, with no address anywhere', (props, code) => {
    const e = toMailSendError(smtpErr(props));
    expect(e.code).toBe(code);
    expect(e.cause).toBeUndefined();
    const serialized = JSON.stringify(errSerializer(e));
    expect(serialized).not.toContain('victim@example.com');
    expect(e.message).not.toContain('victim');
  });
  it('keeps only the SMTP verb of the command', () => {
    expect(toMailSendError(smtpErr({ responseCode: 550, command: 'RCPT TO:<victim@example.com>' })).command).toBe('RCPT TO');
  });
});
```
`test/support/fake-smtp.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerAddress } from 'smtp-server';

export type FakeSmtpMode = 'accept' | 'reject550' | 'reject451' | 'hang';
export type FakeSmtp = { port: number; closedConnections(): number; close(): Promise<void> };

const rejection = (code: number, address: SMTPServerAddress) =>
  Object.assign(new Error(`<${address.address}>: Recipient address rejected`), { responseCode: code });

/** SMTP giả cho đường lỗi (Mailpit chỉ nhận). `hang`: nhận RCPT rồi không bao giờ trả lời DATA. */
export async function startFakeSmtp(mode: FakeSmtpMode): Promise<FakeSmtp> {
  let closed = 0;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onRcptTo(address, _session, cb) {
      if (mode === 'reject550') return cb(rejection(550, address));
      if (mode === 'reject451') return cb(rejection(451, address));
      cb();
    },
    onData(stream, _session, cb) {
      stream.resume();
      if (mode === 'hang') return;
      stream.on('end', () => cb());
    },
    onClose() {
      closed++;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.server.address() as AddressInfo;
  return { port, closedConnections: () => closed, close: () => new Promise<void>((r) => server.close(() => r())) };
}
```
(Đọc `node_modules/@types/smtp-server/index.d.ts` để xác nhận tên `SMTPServerAddress`, `onClose`, `server.server`; khác thì dùng tên thật.)

`test/integration/notifications/nodemailer-transport.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResilienceModule, ResiliencePolicies } from '../../../src/core/resilience/index.js';
import { MailSendError } from '../../../src/modules/notifications/errors.js';
import { NodemailerTransport } from '../../../src/modules/notifications/infra/nodemailer.transport.js';
import { smtpConfig } from '../../../src/modules/notifications/notifications.config.js';
import { createTestApp } from '../../support/app-factory.js';
import { startFakeSmtp, type FakeSmtp } from '../../support/fake-smtp.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const DEADLINE_MS = 500;
const BREAKER_THRESHOLD = 2;
const mail = (to: string) => ({ to, subject: 's', html: '<p>h</p>', text: 't', messageId: `<${v7()}@example.test>` });

describe('NodemailerTransport', () => {
  let app: INestApplication | undefined; let fake: FakeSmtp | undefined;
  afterEach(async () => { await app?.close(); await fake?.close(); vi.unstubAllEnvs(); app = undefined; fake = undefined; });
  const transportFor = async (port?: number) => {
    if (port !== undefined) { vi.stubEnv('SMTP_HOST', '127.0.0.1'); vi.stubEnv('SMTP_PORT', String(port)); }
    vi.stubEnv('SMTP_SEND_DEADLINE_MS', String(DEADLINE_MS));
    vi.stubEnv('RESILIENCE_OVERRIDES', JSON.stringify({ smtp: { breakerThreshold: BREAKER_THRESHOLD } }));
    app = await createTestApp([ResilienceModule]);
    return new NodemailerTransport(app.get(smtpConfig.KEY), app.get(ResiliencePolicies));
  };

  it('delivers to Mailpit with the fixed Message-ID', async () => {
    const t = await transportFor();
    const to = `t-${v7()}@example.test`; const m = mail(to);
    await t.send(m, new AbortController().signal);
    const got = await mailpitFromInfra().waitFor(to);
    expect(got.Subject).toBe('s');
  });
  it('550 with the address in the reply → SMTP_PERMANENT without the address', async () => {
    fake = await startFakeSmtp('reject550');
    const t = await transportFor(fake.port);
    const err = await t.send(mail('victim@example.com'), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect(err).toMatchObject({ code: 'SMTP_PERMANENT', responseCode: 550 });
    expect(JSON.stringify(err)).not.toContain('victim@example.com');
  });
  it('451 → SMTP_TRANSIENT', async () => {
    fake = await startFakeSmtp('reject451');
    const t = await transportFor(fake.port);
    await expect(t.send(mail('x@example.com'), new AbortController().signal)).rejects.toMatchObject({ code: 'SMTP_TRANSIENT' });
  });
  it('consecutive 550s never open the breaker (permanent errors are results, not failures)', async () => {
    fake = await startFakeSmtp('reject550');
    const t = await transportFor(fake.port);
    for (let i = 0; i < BREAKER_THRESHOLD * 2; i++)
      await expect(t.send(mail(`bad-${i}@example.com`), new AbortController().signal)).rejects.toMatchObject({ code: 'SMTP_PERMANENT', responseCode: 550 });
  });
  it('consecutive transient failures DO open the breaker: the next send fails fast without talking SMTP', async () => {
    fake = await startFakeSmtp('reject451');
    const t = await transportFor(fake.port);
    for (let i = 0; i < BREAKER_THRESHOLD; i++)
      await expect(t.send(mail('x@example.com'), new AbortController().signal)).rejects.toMatchObject({ code: 'SMTP_TRANSIENT', responseCode: 451 });
    const open = await t.send(mail('x@example.com'), new AbortController().signal).catch((e: unknown) => e);
    expect(open).toMatchObject({ code: 'SMTP_TRANSIENT' });
    expect(open).not.toHaveProperty('responseCode', 451);
  });
  it('a hanging server hits the total deadline, and the pooled connection is closed', async () => {
    fake = await startFakeSmtp('hang');
    const t = await transportFor(fake.port);
    const started = Date.now();
    await expect(t.send(mail('x@example.com'), new AbortController().signal)).rejects.toMatchObject({ code: 'SMTP_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS * 4);
    await vi.waitFor(() => expect(fake!.closedConnections()).toBeGreaterThan(0));
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/notifications/smtp-error.spec.ts; pnpm vitest run --project integration test/integration/notifications/nodemailer-transport.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/notifications/ports/mail-transport.ts`:
```ts
export type OutgoingMail = { to: string; subject: string; html: string; text: string; messageId: string };

/** Gửi một thư; lỗi luôn là `MailSendError` đã chuẩn hoá (không PII). */
export abstract class MailTransport {
  abstract send(mail: OutgoingMail, signal: AbortSignal): Promise<void>;
}
```
`src/modules/notifications/infra/smtp-error.ts`:
```ts
import { MailSendError, type MailErrorCode } from '../errors.js';

const SMTP_PERMANENT_FROM = 500;
const SMTP_TRANSIENT_FROM = 400;
const TIMEOUT_CODES = new Set(['ETIMEDOUT']);
const CONNECTION_CODES = new Set(['ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET', 'EDNS', 'ETLS']);
/** Chỉ giữ động từ SMTP (vd. `RCPT TO`); phần sau có thể chứa địa chỉ. */
const SMTP_VERB = /^[A-Z]+(?: [A-Z]+)?/;

const prop = (err: unknown, key: string): unknown =>
  typeof err === 'object' && err !== null && key in err ? Reflect.get(err, key) : undefined;

/**
 * Lỗi của nodemailer mang `response`, `responseCode`, `command`, `rejected`, `rejectedErrors`, `envelope`
 * (spec A.11), nhiều field chứa địa chỉ email. Chỉ giữ mã phân loại, mã phản hồi số và động từ SMTP;
 * không giữ lỗi gốc làm `cause`.
 */
export function toMailSendError(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err;
  const responseCode = prop(err, 'responseCode');
  const code = prop(err, 'code');
  const rawCommand = prop(err, 'command');
  const command = typeof rawCommand === 'string' ? SMTP_VERB.exec(rawCommand)?.[0] : undefined;
  let kind: MailErrorCode = 'SMTP_TRANSIENT';
  if (typeof responseCode === 'number' && responseCode >= SMTP_PERMANENT_FROM) kind = 'SMTP_PERMANENT';
  else if (typeof responseCode === 'number' && responseCode >= SMTP_TRANSIENT_FROM) kind = 'SMTP_TRANSIENT';
  else if (typeof code === 'string' && TIMEOUT_CODES.has(code)) kind = 'SMTP_TIMEOUT';
  else if (typeof code === 'string' && CONNECTION_CODES.has(code)) kind = 'SMTP_CONNECTION';
  return new MailSendError(kind, typeof responseCode === 'number' ? responseCode : undefined, command);
}
```
`src/modules/notifications/infra/nodemailer.transport.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { type ConfigOf } from '../../../core/config/index.js';
import { ResiliencePolicies } from '../../../core/resilience/index.js';
import { MailSendError } from '../errors.js';
import { SMTP_RESILIENCE_PROVIDER, smtpConfig } from '../notifications.config.js';
import { MailTransport, type OutgoingMail } from '../ports/mail-transport.js';
import { toMailSendError } from './smtp-error.js';

/** Kết quả bên trong policy: lỗi vĩnh viễn là "kết quả", không phải lỗi của provider (breaker không đếm). */
type Attempt = { ok: true } | { ok: false; error: MailSendError };

@Injectable()
export class NodemailerTransport extends MailTransport {
  constructor(
    @Inject(smtpConfig.KEY) private readonly cfg: ConfigOf<typeof smtpConfig>,
    private readonly policies: ResiliencePolicies,
  ) {
    super();
  }

  /**
   * Pool riêng cho mỗi lần gửi (`maxConnections: 1, maxMessages: 1`): `SMTPPool.close()` đóng cả connection
   * đang gửi (A.11), nên hạn chót tổng thật sự giải phóng socket. Luôn đóng ở `finally`.
   */
  async send(mail: OutgoingMail, signal: AbortSignal): Promise<void> {
    const { host, mailFrom } = this.cfg;
    if (!host || !mailFrom) throw new Error('SMTP_HOST and MAIL_FROM must be set to send email');
    const transporter = createTransport({
      host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      requireTLS: this.cfg.requireTls,
      auth: this.cfg.user ? { user: this.cfg.user, pass: this.cfg.password ?? '' } : undefined,
      connectionTimeout: this.cfg.connectionTimeoutMs,
      greetingTimeout: this.cfg.greetingTimeoutMs,
      socketTimeout: this.cfg.socketTimeoutMs,
      tls: { rejectUnauthorized: this.cfg.tlsRejectUnauthorized },
      disableFileAccess: true,
      disableUrlAccess: true,
      pool: true,
      maxConnections: 1,
      maxMessages: 1,
    });
    const stop = AbortSignal.any([signal, AbortSignal.timeout(this.cfg.sendDeadlineMs)]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        transporter.close();
        reject(new MailSendError('SMTP_TIMEOUT'));
      };
      stop.addEventListener('abort', onAbort, { once: true });
    });
    let attempt: Attempt;
    try {
      if (stop.aborted) throw new MailSendError('SMTP_TIMEOUT');
      // Không retry ở đây (`single`): retry là việc của job. Deadline < timeout của policy (luật config Task 18).
      attempt = await this.policies.for(SMTP_RESILIENCE_PROVIDER).single.execute(async (): Promise<Attempt> => {
        try {
          await Promise.race([
            transporter.sendMail({ from: mailFrom, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, messageId: mail.messageId }),
            aborted,
          ]);
          return { ok: true };
        } catch (err) {
          const e = toMailSendError(err);
          if (e.code === 'SMTP_PERMANENT') return { ok: false, error: e };
          throw e;
        }
      });
    } catch (err) {
      // Lỗi tạm thời đã chuẩn hoá, hoặc lỗi của policy (breaker mở, bulkhead đầy) → SMTP_TRANSIENT.
      throw toMailSendError(err);
    } finally {
      if (onAbort) stop.removeEventListener('abort', onAbort);
      aborted.catch(() => undefined);
      transporter.close();
    }
    if (!attempt.ok) throw attempt.error;
  }
}
```
Kiểm kiểu `createTransport` của nodemailer 10 (`node_modules/nodemailer/dist/esm/nodemailer.d.ts`: overload `SMTPPoolOptions & { pool: true }`) — nếu option nào không có trong `.d.ts` thì bỏ và ghi lý do. `MailSendError` có `code` kiểu `MailErrorCode` (Task 20) nên so sánh `e.code === 'SMTP_PERMANENT'` được typecheck; `isTransient` của SP1 coi mọi `Error` không phải `UpstreamError`/SSRF/breaker/bulkhead là tạm thời, nên `MailSendError` tạm thời được breaker đếm như mong muốn.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/notifications && pnpm vitest run --project integration test/integration/notifications && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications test/support/fake-smtp.ts test/unit/modules/notifications/smtp-error.spec.ts test/integration/notifications/nodemailer-transport.spec.ts
git commit -m "feat(notifications): nodemailer transport with per-send pool, total deadline and PII-free SMTP errors"
```

---

### Task 23: Job `notifications.send-email` — claim, fencing, lỗi tạm thời/vĩnh viễn

**Files:**
- Create: `src/modules/notifications/application/send-email.handler.ts`
- Modify: `src/modules/notifications/notifications.module.ts` (thêm `forWorker()` tối thiểu: repository, renderer, transport, handler)
- Test: `test/integration/notifications/send-email.handler.spec.ts`

**Interfaces:**
- Consumes: `DeliveryRepository`, `SendEmailJob`, `DeliveryFailedEvent`, `MailSendError`, `DeliveryLeaseBusyError`, `isTransientMailError` (Task 20); `TemplateRenderer`, `TemplateNotFoundError` (Task 21); `MailTransport` (Task 22); `transition`, `deliveryAad` (Task 19); `EventPublisher`, `UnitOfWork`, `FieldCipher`, `JobPayloadError`, `JobHandler`, `JobContext` (SP1).
- Produces: `SendEmailHandler` (`@JobHandler(SendEmailJob)`), `NotificationsModule.forWorker(): DynamicModule`, token `NOTIFICATIONS_CLOCK` không cần (dùng `now()` của DB). Metric `notifications_email_total{template,result}`, `notifications_email_lease_lost_total`; span `notifications.email.claim|render|send`.

- [ ] **Step 1: Viết test fail**

`test/integration/notifications/send-email.handler.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { JobPayloadError, QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { EmailNotifications, NotificationsModule } from '../../../src/modules/notifications/index.js';
import { SendEmailHandler } from '../../../src/modules/notifications/application/send-email.handler.js';
import { DeliveryLeaseBusyError } from '../../../src/modules/notifications/errors.js';
import { createTestApp } from '../../support/app-factory.js';
import { startFakeSmtp, type FakeSmtp } from '../../support/fake-smtp.js';
import { getInfra } from '../../support/infra.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const LEASE_MS = 1500;
const DEADLINE_MS = 1000;
const MAX_ATTEMPTS = 3;
let owner: pg.Client;
const row = async (key: string) => (await owner.query(
  'SELECT public_id, state, lease_owner, lease_until, attempts, last_error_code, completed_at, params_enc FROM email_deliveries WHERE idempotency_key = $1', [key])).rows[0];
const failedEvents = async (id: string) => (await owner.query(
  `SELECT payload FROM outbox_events WHERE type = 'notifications.delivery.failed' AND payload->>'deliveryId' = $1`, [id])).rows;
const ctx = (deliveryId: string, attempt = 1) => ({
  payload: { deliveryId }, meta: {}, jobId: `${deliveryId}-g0`, attempt, maxAttempts: MAX_ATTEMPTS,
  signal: new AbortController().signal, log: new Logger('test'),
});

async function makeApp(smtpPort?: number): Promise<INestApplication> {
  vi.stubEnv('APP_ROLE', 'worker');
  vi.stubEnv('NOTIFICATIONS_CLAIM_LEASE_MS', String(LEASE_MS));
  vi.stubEnv('SMTP_SEND_DEADLINE_MS', String(DEADLINE_MS));
  vi.stubEnv('QUEUE_DEFAULT_ATTEMPTS', String(MAX_ATTEMPTS));
  if (smtpPort !== undefined) { vi.stubEnv('SMTP_HOST', '127.0.0.1'); vi.stubEnv('SMTP_PORT', String(smtpPort)); }
  return createTestApp([
    DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }),
    OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), ResilienceModule, NotificationsModule.forWorker(),
  ]);
}
async function requestOne(app: INestApplication, to = `u-${v7()}@example.test`) {
  const key = `verify-email:${v7()}`;
  await app.get(EmailNotifications).request({ template: 'verify-email', to, idempotencyKey: key, params: { name: 'U', url: 'https://app.example.test/v?t=1' } });
  return { key, to, id: (await row(key)).public_id as string };
}

beforeAll(async () => {
  const { pg: p } = getInfra();
  owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
  await owner.connect();
});
afterAll(async () => owner?.end());

describe('SendEmailHandler', () => {
  let app: INestApplication | undefined; let fake: FakeSmtp | undefined;
  afterEach(async () => { await app?.close(); await fake?.close(); vi.unstubAllEnvs(); app = undefined; fake = undefined; });

  it('claims, sends to Mailpit, and completes: SENT, params dropped, lease cleared', async () => {
    app = await makeApp();
    const { key, to, id } = await requestOne(app);
    await app.get(SendEmailHandler).handle(ctx(id));
    await mailpitFromInfra().waitFor(to, { subject: /Verify your email/ });
    expect(await row(key)).toMatchObject({ state: 'SENT', lease_owner: null, lease_until: null, params_enc: null, attempts: 1 });
    await app.get(SendEmailHandler).handle(ctx(id));
  });
  it('two concurrent jobs on one delivery: exactly one sends, the other gets DeliveryLeaseBusyError', async () => {
    fake = await startFakeSmtp('hang');
    app = await makeApp(fake.port);
    const { id } = await requestOne(app);
    const h = app.get(SendEmailHandler);
    const results = await Promise.allSettled([h.handle(ctx(id)), h.handle(ctx(id))]);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof DeliveryLeaseBusyError)).toHaveLength(1);
  });
  it('a retry before the lease expires never reports success', async () => {
    fake = await startFakeSmtp('hang');
    app = await makeApp(fake.port);
    const { id } = await requestOne(app);
    const h = app.get(SendEmailHandler);
    const first = h.handle(ctx(id)).catch((e: unknown) => e);
    await vi.waitFor(async () => expect((await owner.query('SELECT state FROM email_deliveries WHERE public_id = $1', [id])).rows[0].state).toBe('SENDING'));
    await expect(h.handle(ctx(id, 2))).rejects.toBeInstanceOf(DeliveryLeaseBusyError);
    await first;
  });
  it('lease lost while SMTP is slow: the old owner is fenced out and does not flip the row', async () => {
    fake = await startFakeSmtp('hang');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app);
    const h = app.get(SendEmailHandler);
    const slow = h.handle(ctx(id)).catch((e: unknown) => e);
    await vi.waitFor(async () => expect((await row(key)).state).toBe('SENDING'));
    await owner.query(`UPDATE email_deliveries SET lease_owner = $2, lease_until = now() + interval '1 hour' WHERE public_id = $1`, [id, v7()]);
    await slow;
    expect((await row(key)).state).toBe('SENDING');
  });
  it('transient failure: back to PENDING with both lease columns NULL and the error code', async () => {
    fake = await startFakeSmtp('reject451');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app);
    await expect(app.get(SendEmailHandler).handle(ctx(id))).rejects.toMatchObject({ code: 'SMTP_TRANSIENT' });
    expect(await row(key)).toMatchObject({ state: 'PENDING', lease_owner: null, lease_until: null, last_error_code: 'SMTP_TRANSIENT' });
  });
  it('permanent failure: FAILED + event committed before the job fails (unrecoverable), no address anywhere', async () => {
    fake = await startFakeSmtp('reject550');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app, 'victim@example.com');
    const err = await app.get(SendEmailHandler).handle(ctx(id)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobPayloadError);
    expect(String(err)).not.toContain('victim@example.com');
    expect(await row(key)).toMatchObject({ state: 'FAILED', last_error_code: 'SMTP_PERMANENT', params_enc: null });
    expect((await failedEvents(id)).map((r) => r.payload)).toEqual([{ deliveryId: id, template: 'verify-email', errorCode: 'SMTP_PERMANENT' }]);
  });
  it('transient failure on the last attempt: FAILED + event, and a normal error so BullMQ marks the job failed', async () => {
    fake = await startFakeSmtp('reject451');
    app = await makeApp(fake.port);
    const { key, id } = await requestOne(app);
    const err = await app.get(SendEmailHandler).handle(ctx(id, MAX_ATTEMPTS)).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(JobPayloadError);
    expect(await row(key)).toMatchObject({ state: 'FAILED', last_error_code: 'SMTP_TRANSIENT' });
    expect(await failedEvents(id)).toHaveLength(1);
  });
  it('unknown locale or invalid params fails the delivery permanently', async () => {
    app = await makeApp();
    const { key, id } = await requestOne(app);
    await owner.query(`UPDATE email_deliveries SET locale = 'fr' WHERE public_id = $1`, [id]);
    await expect(app.get(SendEmailHandler).handle(ctx(id))).rejects.toBeInstanceOf(JobPayloadError);
    expect(await row(key)).toMatchObject({ state: 'FAILED', last_error_code: null, params_enc: null });
    expect((await failedEvents(id))[0].payload.errorCode).toBe('RENDER_FAILED');
  });
  it('a missing delivery is a permanent payload error', async () => {
    app = await makeApp();
    await expect(app.get(SendEmailHandler).handle(ctx(v7()))).rejects.toBeInstanceOf(JobPayloadError);
  });
});
```
(Chỉ `app_owner` sửa được cột snapshot `locale`; test dùng owner để mô phỏng dòng tạo trước một lần deploy đổi locale.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/notifications/send-email.handler.spec.ts`
Expected: FAIL — `SendEmailHandler`/`forWorker` chưa có.

- [ ] **Step 3: Cài đặt**

`src/modules/notifications/application/send-email.handler.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { v7 } from 'uuid';
import { type ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { JobHandler, JobPayloadError, type JobContext } from '../../../core/queue/index.js';
import { FieldCipher } from '../../../core/security/index.js';
import { deliveryAad, isFinal } from '../domain/email-delivery.js';
import { DeliveryLeaseBusyError, MailSendError, isTransientMailError, type MailErrorCode } from '../errors.js';
import { DeliveryFailedEvent, type DeliveryFailureCode } from '../events.js';
import { SendEmailJob } from '../jobs.js';
import { notificationsConfig, smtpConfig } from '../notifications.config.js';
import { DeliveryRepository, type ClaimedDelivery } from '../ports/delivery-repository.js';
import { MailTransport } from '../ports/mail-transport.js';
import { TemplateRenderer } from '../ports/template-renderer.js';
import { TEMPLATE_PARAMS } from '../templates.js';

const TELEMETRY = 'notifications';
const SYSTEM_ACTOR = { type: 'system', id: 'notifications' } as const;

/**
 * Gửi một email theo state machine có lease (spec §5.11). At-least-once: crash giữa lúc SMTP nhận thư và
 * bước hoàn tất, hoặc lease bị lấy lại khi SMTP chậm, có thể gửi hai lần (Message-ID cố định để nhận diện).
 * Không bao giờ trả thành công khi thư chưa ở trạng thái cuối.
 */
@Injectable()
@JobHandler(SendEmailJob)
export class SendEmailHandler {
  private readonly logger = new Logger(SendEmailHandler.name);
  private readonly tracer = trace.getTracer(TELEMETRY);
  private readonly meter = metrics.getMeter(TELEMETRY);
  private readonly sent = this.meter.createCounter('notifications_email_total', { description: 'Email send outcomes by template and result' });
  private readonly leaseLost = this.meter.createCounter('notifications_email_lease_lost_total', { description: 'Sends whose completion was fenced out by a newer lease owner' });

  constructor(
    private readonly repo: DeliveryRepository,
    private readonly renderer: TemplateRenderer,
    private readonly transport: MailTransport,
    private readonly cipher: FieldCipher,
    private readonly uow: UnitOfWork,
    private readonly events: EventPublisher,
    @Inject(notificationsConfig.KEY) private readonly cfg: ConfigOf<typeof notificationsConfig>,
    @Inject(smtpConfig.KEY) private readonly smtp: ConfigOf<typeof smtpConfig>,
  ) {}

  async handle(ctx: JobContext<{ deliveryId: string }>): Promise<void> {
    const id = ctx.payload.deliveryId;
    const owner = v7();
    const claimed = await this.spanAsync('notifications.email.claim', () => this.uow.run(() => this.repo.claim(id, owner, this.cfg.claimLeaseMs)));
    if (!claimed) return this.notClaimed(id);

    let mail: { to: string; subject: string; html: string; text: string; messageId: string };
    try {
      mail = this.spanSync('notifications.email.render', () => this.render(claimed));
    } catch {
      await this.failPermanently(claimed, owner, null, 'RENDER_FAILED');
      throw new JobPayloadError(SendEmailJob.name, 'delivery cannot be rendered (template, locale or params)');
    }

    try {
      await this.spanAsync('notifications.email.send', () => this.transport.send(mail, ctx.signal));
    } catch (err) {
      const e = err instanceof MailSendError ? err : new MailSendError('SMTP_TRANSIENT');
      if (!isTransientMailError(e.code)) {
        await this.failPermanently(claimed, owner, e.code, e.code);
        throw new JobPayloadError(SendEmailJob.name, `permanent SMTP failure (${e.code})`);
      }
      if (ctx.attempt >= ctx.maxAttempts) {
        await this.failPermanently(claimed, owner, e.code, e.code);
        throw new MailSendError(e.code, e.responseCode, e.command);
      }
      await this.uow.run(() => this.repo.release(id, owner, e.code));
      this.sent.add(1, { template: claimed.template, result: 'retry' });
      throw e;
    }

    const done = await this.uow.run(() => this.repo.complete(id, owner));
    if (!done) {
      this.leaseLost.add(1);
      this.logger.warn({ deliveryId: id, event: 'delivery_lease_lost' }, 'delivery_lease_lost');
      return;
    }
    this.sent.add(1, { template: claimed.template, result: 'sent' });
  }

  /** Không claim được: không có dòng → vĩnh viễn; đã cuối → idempotent; lease còn → retry (không bao giờ thành công). */
  private async notClaimed(id: string): Promise<void> {
    const s = await this.repo.status(id);
    if (!s) throw new JobPayloadError(SendEmailJob.name, 'delivery not found');
    if (isFinal(s.state)) return;
    throw new DeliveryLeaseBusyError();
  }

  private render(c: ClaimedDelivery) {
    const to = this.cipher.decrypt(c.recipientEnc, deliveryAad('recipient_enc', c.publicId));
    const raw: unknown = JSON.parse(this.cipher.decrypt(c.paramsEnc, deliveryAad('params_enc', c.publicId)));
    const params = TEMPLATE_PARAMS[c.template].parse(raw);
    const rendered = this.renderer.render(c.template, c.locale, params);
    return { to, ...rendered, messageId: `<${c.publicId}@${this.messageIdDomain()}>` };
  }

  private messageIdDomain(): string {
    const from = this.smtp.mailFrom ?? '';
    const at = from.lastIndexOf('@');
    return at >= 0 ? from.slice(at + 1).replace(/[>\s]/g, '') : 'localhost';
  }

  /** FAILED + event trong CÙNG transaction, có fencing theo owner; commit xong mới ném lỗi cho BullMQ. */
  private async failPermanently(c: ClaimedDelivery, owner: string, code: MailErrorCode | null, reason: DeliveryFailureCode): Promise<void> {
    await this.uow.run(async () => {
      const template = await this.repo.fail(c.publicId, owner, code);
      if (!template) return;
      await this.events.publish(DeliveryFailedEvent, {
        data: { deliveryId: c.publicId, template, errorCode: reason },
        aggregate: { type: 'email_delivery', id: c.publicId, version: 1 },
        actor: SYSTEM_ACTOR,
      });
    });
    this.sent.add(1, { template: c.template, result: 'failed' });
  }

  private spanSync<T>(name: string, fn: () => T): T {
    return this.tracer.startActiveSpan(name, (s) => {
      try {
        return fn();
      } finally {
        s.end();
      }
    });
  }

  private spanAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (s) => {
      try {
        return await fn();
      } finally {
        s.end();
      }
    });
  }
}
```

`src/modules/notifications/notifications.module.ts`: thêm
```ts
import { ResilienceModule } from '../../core/resilience/index.js';
import { SendEmailHandler } from './application/send-email.handler.js';
import { MjmlHandlebarsRenderer, NOTIFICATION_RENDER_OPTIONS, NOTIFICATION_TEMPLATES_DIR, defaultTemplatesDir } from './infra/mjml-handlebars.renderer.js';
import { NodemailerTransport } from './infra/nodemailer.transport.js';
import { MailTransport } from './ports/mail-transport.js';
import { TemplateRenderer } from './ports/template-renderer.js';
import { notificationsConfig } from './notifications.config.js';
import { type ConfigOf } from '../../core/config/index.js';

  static forWorker(): DynamicModule {
    return {
      module: NotificationsModule,
      global: true,
      imports: [SecurityModule, ResilienceModule],
      providers: [
        ...shared,
        { provide: NOTIFICATION_TEMPLATES_DIR, useFactory: defaultTemplatesDir },
        {
          provide: NOTIFICATION_RENDER_OPTIONS,
          inject: [notificationsConfig.KEY],
          useFactory: (c: ConfigOf<typeof notificationsConfig>) => ({ defaultLocale: c.defaultLocale }),
        },
        MjmlHandlebarsRenderer,
        { provide: TemplateRenderer, useExisting: MjmlHandlebarsRenderer },
        NodemailerTransport,
        { provide: MailTransport, useExisting: NodemailerTransport },
        SendEmailHandler,
      ],
      exports: [EmailNotifications],
    };
  }
```
(Task 24 thêm hai handler cron vào `forWorker`.)

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/notifications && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications test/integration/notifications/send-email.handler.spec.ts
git commit -m "feat(notifications): lease-fenced send-email job with transient/permanent failure handling and failure events"
```

---

### Task 24: Cron đối soát và dọn `email_deliveries`; `NotificationsModule.forWorker()` đầy đủ

**Files:**
- Create: `src/modules/notifications/application/reconcile-deliveries.handler.ts`, `src/modules/notifications/application/purge-deliveries.handler.ts`
- Modify: `src/modules/notifications/notifications.module.ts`
- Test: `test/integration/notifications/reconcile-purge.spec.ts`

**Interfaces:**
- Consumes: `DeliveryRepository` (`findStale`, `failExhausted`, `bumpGeneration`, `purge`), `SendEmailJob`, `sendEmailJobId`, `ReconcileDeliveriesJob`, `PurgeDeliveriesJob`, `DeliveryFailedEvent` (Task 20); `SafeEnqueue`, `EventPublisher`, `UnitOfWork` (SP1).
- Produces: `ReconcileDeliveriesHandler`, `PurgeDeliveriesHandler` (đăng ký trong `NotificationsModule.forWorker()`), metric `notifications_email_stuck_total`.

- [ ] **Step 1: Viết test fail**

`test/integration/notifications/reconcile-purge.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { EmailNotifications, NotificationsModule } from '../../../src/modules/notifications/index.js';
import { PurgeDeliveriesHandler } from '../../../src/modules/notifications/application/purge-deliveries.handler.js';
import { ReconcileDeliveriesHandler } from '../../../src/modules/notifications/application/reconcile-deliveries.handler.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const COOLDOWN_SEC = 60;
const MAX_TOTAL = 3;
const cronCtx = () => ({ payload: {}, meta: {}, jobId: v7(), attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log: new Logger('t') });
let app: INestApplication; let owner: pg.Client;
const jobIds = async (id: string) => (await owner.query(
  `SELECT payload->>'jobId' AS j FROM outbox_events WHERE type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $1 ORDER BY id`, [id])).rows.map((r) => r.j);
async function stuck(state: 'PENDING' | 'SENDING', attempts = 0) {
  const key = `verify-email:${v7()}`;
  await app.get(EmailNotifications).request({ template: 'verify-email', to: 's@example.test', idempotencyKey: key, params: { name: 'S', url: 'https://a.test/v' } });
  const { rows } = await owner.query(
    `UPDATE email_deliveries SET last_enqueued_at = now() - make_interval(secs => $2 * 2), attempts = $3,
       state = $4, lease_owner = CASE WHEN $4 = 'SENDING' THEN gen_random_uuid() END,
       lease_until = CASE WHEN $4 = 'SENDING' THEN now() - interval '1 minute' END
     WHERE idempotency_key = $1 RETURNING public_id`, [key, COOLDOWN_SEC, attempts, state]);
  return rows[0].public_id as string;
}

beforeAll(async () => {
  vi.stubEnv('APP_ROLE', 'worker');
  vi.stubEnv('NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC', String(COOLDOWN_SEC));
  vi.stubEnv('NOTIFICATIONS_MAX_TOTAL_ATTEMPTS', String(MAX_TOTAL));
  app = await createTestApp([
    DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }),
    OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), ResilienceModule, NotificationsModule.forWorker(),
  ]);
  const { pg: p } = getInfra();
  owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
  await owner.connect();
});
afterAll(async () => { await owner?.end(); await app?.close(); vi.unstubAllEnvs(); });

describe('notifications.reconcile-deliveries', () => {
  it.each(['PENDING', 'SENDING'] as const)('re-enqueues a stuck %s row with a new generation', async (state) => {
    const id = await stuck(state);
    await app.get(ReconcileDeliveriesHandler).handle(cronCtx());
    expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`]);
  });
  it('two reconcilers in parallel on the same stuck rows: one new job each, generation +1 only', async () => {
    const a = await stuck('PENDING'); const b = await stuck('SENDING');
    const h = app.get(ReconcileDeliveriesHandler);
    await Promise.all([h.handle(cronCtx()), h.handle(cronCtx())]);
    for (const id of [a, b]) {
      expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`]);
      expect((await owner.query('SELECT enqueue_generation FROM email_deliveries WHERE public_id = $1', [id])).rows[0].enqueue_generation).toBe(1);
    }
  });
  it('running again inside the cooldown enqueues nothing new', async () => {
    const id = await stuck('PENDING');
    const h = app.get(ReconcileDeliveriesHandler);
    await h.handle(cronCtx());
    await h.handle(cronCtx());
    expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`]);
  });
  it('a -g<n> job that failed before claiming does not block -g<n+1> later', async () => {
    const id = await stuck('PENDING');
    const h = app.get(ReconcileDeliveriesHandler);
    await h.handle(cronCtx());
    await owner.query(`UPDATE email_deliveries SET last_enqueued_at = now() - make_interval(secs => $2 * 2) WHERE public_id = $1`, [id, COOLDOWN_SEC]);
    await h.handle(cronCtx());
    expect(await jobIds(id)).toEqual([`${id}-g0`, `${id}-g1`, `${id}-g2`]);
  });
  it('gives up after NOTIFICATIONS_MAX_TOTAL_ATTEMPTS: FAILED + event in the same transaction', async () => {
    const id = await stuck('SENDING', MAX_TOTAL);
    await app.get(ReconcileDeliveriesHandler).handle(cronCtx());
    const { rows } = await owner.query('SELECT state, lease_owner, lease_until, completed_at IS NOT NULL AS done, params_enc FROM email_deliveries WHERE public_id = $1', [id]);
    expect(rows[0]).toEqual({ state: 'FAILED', lease_owner: null, lease_until: null, done: true, params_enc: null });
    const ev = await owner.query(`SELECT payload FROM outbox_events WHERE type = 'notifications.delivery.failed' AND payload->>'deliveryId' = $1`, [id]);
    expect(ev.rows[0].payload.errorCode).toBe('ATTEMPTS_EXHAUSTED');
  });
});

describe('notifications.purge-deliveries', () => {
  it('deletes only final rows older than the retention; never pending ones', async () => {
    const oldSent = await stuck('PENDING'); const young = await stuck('PENDING'); const oldPending = await stuck('PENDING');
    await owner.query(`UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL, created_at = now() - interval '400 days' WHERE public_id = $1`, [oldSent]);
    await owner.query(`UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL WHERE public_id = $1`, [young]);
    await owner.query(`UPDATE email_deliveries SET created_at = now() - interval '400 days' WHERE public_id = $1`, [oldPending]);
    await app.get(PurgeDeliveriesHandler).handle(cronCtx());
    const { rows } = await owner.query('SELECT public_id FROM email_deliveries WHERE public_id = ANY($1)', [[oldSent, young, oldPending]]);
    expect(rows.map((r) => r.public_id).sort()).toEqual([young, oldPending].sort());
  });
});

describe('worker boot', () => {
  it('refuses to start when a template lacks the configured default locale', async () => {
    vi.stubEnv('NOTIFICATIONS_DEFAULT_LOCALE', 'vi');
    await expect(createTestApp([
      DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), ResilienceModule, NotificationsModule.forWorker(),
    ])).rejects.toThrow(/missing templates for locale "vi"/);
    vi.stubEnv('NOTIFICATIONS_DEFAULT_LOCALE', 'en');
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/notifications/reconcile-purge.spec.ts`
Expected: FAIL — handler chưa có.

- [ ] **Step 3: Cài đặt**

`src/modules/notifications/application/reconcile-deliveries.handler.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { type ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { DeliveryFailedEvent } from '../events.js';
import { ReconcileDeliveriesJob, SendEmailJob, sendEmailJobId } from '../jobs.js';
import { notificationsConfig } from '../notifications.config.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';

/**
 * Đối soát thư kẹt (spec §5.11): PENDING, hoặc SENDING hết lease, và đã qua thời gian chờ kể từ lần enqueue
 * trước. Thời gian chờ nằm trong câu UPDATE atomic (`bumpGeneration`): hai cron song song thì chỉ một cron
 * qua được điều kiện và enqueue; jobId `<public_id>-g<generation>` luôn mới nên BullMQ không bỏ qua.
 */
@Injectable()
@JobHandler(ReconcileDeliveriesJob)
export class ReconcileDeliveriesHandler {
  private readonly logger = new Logger(ReconcileDeliveriesHandler.name);
  private readonly stuck = metrics.getMeter('notifications').createCounter('notifications_email_stuck_total', { description: 'Stuck deliveries found by the reconcile cron' });

  constructor(
    private readonly repo: DeliveryRepository,
    private readonly uow: UnitOfWork,
    private readonly enqueue: SafeEnqueue,
    private readonly events: EventPublisher,
    @Inject(notificationsConfig.KEY) private readonly cfg: ConfigOf<typeof notificationsConfig>,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<{ requeued: number; failed: number }> {
    const rows = await this.repo.findStale(this.cfg.reenqueueCooldownSec, this.cfg.reconcileBatchSize);
    this.stuck.add(rows.length);
    let requeued = 0;
    let failed = 0;
    for (const row of rows) {
      ctx.signal.throwIfAborted();
      await this.uow.run(async () => {
        if (row.attempts >= this.cfg.maxTotalAttempts) {
          const template = await this.repo.failExhausted(row.publicId, this.cfg.maxTotalAttempts);
          if (!template) return;
          await this.events.publish(DeliveryFailedEvent, {
            data: { deliveryId: row.publicId, template, errorCode: 'ATTEMPTS_EXHAUSTED' },
            aggregate: { type: 'email_delivery', id: row.publicId, version: 1 },
            actor: { type: 'system', id: 'notifications' },
          });
          failed++;
          return;
        }
        const generation = await this.repo.bumpGeneration(row.publicId, this.cfg.reenqueueCooldownSec);
        if (generation === undefined) return;
        await this.enqueue.enqueue(SendEmailJob, { deliveryId: row.publicId }, { jobId: sendEmailJobId(row.publicId, generation) });
        requeued++;
      });
    }
    this.logger.log({ requeued, failed }, 'email deliveries reconciled');
    return { requeued, failed };
  }
}
```
`src/modules/notifications/application/purge-deliveries.handler.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf } from '../../../core/config/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { PurgeDeliveriesJob } from '../jobs.js';
import { notificationsConfig } from '../notifications.config.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';

/** Xoá theo lô dòng SENT/FAILED cũ hơn `NOTIFICATIONS_RETENTION_DAYS` (mỗi câu là một transaction ngắn). */
@Injectable()
@JobHandler(PurgeDeliveriesJob)
export class PurgeDeliveriesHandler {
  private readonly logger = new Logger(PurgeDeliveriesHandler.name);

  constructor(
    private readonly repo: DeliveryRepository,
    @Inject(notificationsConfig.KEY) private readonly cfg: ConfigOf<typeof notificationsConfig>,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<number> {
    let total = 0;
    for (let i = 0; i < this.cfg.purgeMaxBatches; i++) {
      ctx.signal.throwIfAborted();
      const n = await this.repo.purge(this.cfg.retentionDays, this.cfg.purgeBatchSize);
      total += n;
      if (n < this.cfg.purgeBatchSize) break;
    }
    this.logger.log({ deleted: total }, 'email deliveries purged');
    return total;
  }
}
```
`notifications.module.ts` → `forWorker().providers` thêm `ReconcileDeliveriesHandler`, `PurgeDeliveriesHandler`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/notifications && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications test/integration/notifications/reconcile-purge.spec.ts
git commit -m "feat(notifications): reconcile stuck deliveries with durable generations; purge final deliveries"
```

---
## Phần E — Identity

Thứ tự: config → schema → pool/port → mã hoá token → lỗi → nhận diện credential + CSRF → lockout → options → hook → provider → mount → middleware/guard → e2e → `external` → event/cron → chaos → smoke #1.

### Task 25: Config identity (mọi luật của spec §5.15)

**Files:**
- Create: `src/modules/identity/identity.config.ts`, `test/unit/modules/identity/identity-config.spec.ts`
- Modify: `test/support/env.ts`, `src/scripts/gen-env-example.ts`, `.env.example` (sinh lại)

**Interfaces:**
- Consumes: `defineConfig`, `defineConfigRule`, `defineProductionRule`, `appConfig`, `httpConfig`, `loggingConfig`, `isValidCron`, `normalizeTimezone` (SP1 + Task 18).
- Produces:
  - `identityConfig` (namespace `identity`, gồm cả khoá `AUTH_EXTERNAL_*`), `type IdentityConfig = ConfigOf<typeof identityConfig>`; trường: `mode`, `secret?`, `baseUrl?`, `basePath`, `secureCookies`, `cookiePrefix?`, `cookieDomain?`, `cookieDomainAllSubdomainsTrusted`, `cookieSameSite`, `sessionExpiresInSec`, `sessionUpdateAgeSec`, `sessionFreshAgeSec`, `passwordMinLength`, `passwordMaxLength`, `requireEmailVerification`, `emailTokenTtlSec`, `resetTokenTtlSec`, `googleClientId?`, `googleClientSecret?`, `trustedProviders: string[]`, `oidcProviderId?`, `oidcDiscoveryUrl?`, `oidcClientId?`, `oidcClientSecret?`, `oidcScopes: string[]`, `twoFactorIssuer?`, `apiKeyHeader`, `apiKeyDefaultExpiresInSec`, `jwtIssuer?`, `jwtAudience?`, `jwtExpiresInSec`, `jwksRotationIntervalSec`, `jwksGracePeriodSec`, `externalJwksUrl?`, `externalIssuer?`, `externalAudience: string[]`, `externalAlgorithms: ExternalAlgorithm[]`, `externalClockToleranceSec`, `externalUserClaim?`, `externalUserClaimValue?`, `externalTokenCookie?`, `externalTyp?`, `externalMaxTokenAgeSec?`, `externalAdminClaim?`, `externalAdminValue?`, `externalJwksTimeoutMs`, `externalJwksCooldownMs`, `externalJwksCacheMaxAgeMs`.
  - `identityGuardConfig` (namespace `identityGuard`): rate limit, lockout, `unavailableRetryAfterSec`, `existingAccountNoticeWindowSec`, cron đối soát/dọn.
  - `authDatabaseConfig` (namespace `authDatabase`): `host?`, `port?`, `user`, `password?`, `poolMax`, `connectionTimeoutMs`.
  - `AUTH_MODES`, `type AuthMode`, `AUTH_MODE_ENV = 'AUTH_MODE'`, `DEFAULT_AUTH_MODE`, `isBetterAuthMode(env: Record<string, string | undefined>): boolean` (dùng cho `ConditionalModule`), `effectiveCookiePrefix(identity, app)`, `effectiveTwoFactorIssuer(identity, app)`, `effectiveJwtIssuer(identity)`, `effectiveJwtAudience(identity)`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/identity-config.spec.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import '../../../../src/modules/notifications/notifications.config.js';
import '../../../../src/modules/identity/identity.config.js';
import { validateAllConfigs } from '../../../../src/core/config/index.js';

const SECRET = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0';
const base: Record<string, string> = {
  APP_ROLE: 'api', NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379',
  DB_HOST: 'h', DB_NAME: 'n', DB_APP_PASSWORD: 'p', DB_AUTH_PASSWORD: 'p',
  FIELD_ENCRYPTION_KEYS: JSON.stringify({ k1: Buffer.alloc(32).toString('base64') }), FIELD_ENCRYPTION_ACTIVE_KID: 'k1',
  BETTER_AUTH_SECRET: SECRET, AUTH_BASE_URL: 'http://localhost:3000', AUTH_SECURE_COOKIES: 'false',
};
const stub = (env: Record<string, string>) => {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
};
const fails = (env: Record<string, string>, msg: RegExp) => {
  stub(env);
  expect(() => validateAllConfigs()).toThrow(msg);
};

describe('identity config rules (spec §5.15)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts the local defaults', () => { stub({}); expect(() => validateAllConfigs()).not.toThrow(); });

  it.each([
    [{ BETTER_AUTH_SECRET: '' }, /BETTER_AUTH_SECRET is required/],
    [{ BETTER_AUTH_SECRET: 'short' }, /BETTER_AUTH_SECRET must be at least 32 characters/],
    [{ AUTH_BASE_URL: '' }, /AUTH_BASE_URL is required/],
    [{ DB_AUTH_PASSWORD: '' }, /DB_AUTH_PASSWORD is required/],
    [{ AUTH_MODE: 'hybrid' }, /AUTH_OIDC_PROVIDER_ID, AUTH_OIDC_DISCOVERY_URL, AUTH_OIDC_CLIENT_ID and AUTH_OIDC_CLIENT_SECRET are required/],
    [{ AUTH_MODE: 'external' }, /AUTH_EXTERNAL_JWKS_URL, AUTH_EXTERNAL_ISSUER, AUTH_EXTERNAL_AUDIENCE, AUTH_EXTERNAL_ALGORITHMS, AUTH_EXTERNAL_USER_CLAIM and AUTH_EXTERNAL_USER_CLAIM_VALUE are required/],
    [{ AUTH_GOOGLE_CLIENT_ID: 'x' }, /AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET must be set together/],
    [{ AUTH_EXTERNAL_ADMIN_CLAIM: 'roles' }, /AUTH_EXTERNAL_ADMIN_CLAIM and AUTH_EXTERNAL_ADMIN_VALUE must be set together/],
    [{ AUTH_PASSWORD_MIN_LENGTH: '64', AUTH_PASSWORD_MAX_LENGTH: '64' }, /AUTH_PASSWORD_MIN_LENGTH must be less than AUTH_PASSWORD_MAX_LENGTH/],
    [{ AUTH_COOKIE_SAMESITE: 'none' }, /AUTH_COOKIE_SAMESITE=none requires AUTH_SECURE_COOKIES=true/],
    [{ AUTH_API_KEY_HEADER: 'Authorization' }, /AUTH_API_KEY_HEADER/],
    [{ AUTH_API_KEY_HEADER: 'cookie' }, /AUTH_API_KEY_HEADER must not be a reserved header/],
    [{ AUTH_API_KEY_HEADER: 'x-machine-key' }, /AUTH_API_KEY_HEADER .* must be redacted/],
    [{ AUTH_COOKIE_PREFIX: 'My App' }, /AUTH_COOKIE_PREFIX/],
    [{ AUTH_EXTERNAL_TOKEN_COOKIE: '__Host-token' }, /AUTH_EXTERNAL_TOKEN_COOKIE/],
    [{ AUTH_COOKIE_PREFIX: 'app', AUTH_EXTERNAL_TOKEN_COOKIE: 'app.session_token' }, /AUTH_EXTERNAL_TOKEN_COOKIE/],
    [{ AUTH_EXTERNAL_ALGORITHMS: 'HS256' }, /AUTH_EXTERNAL_ALGORITHMS/],
    [{ AUTH_EXTERNAL_ALGORITHMS: 'none' }, /AUTH_EXTERNAL_ALGORITHMS/],
    [{ AUTH_MODE: 'hybrid', AUTH_OIDC_PROVIDER_ID: 'google', AUTH_OIDC_DISCOVERY_URL: 'https://idp.test/.well-known/openid-configuration', AUTH_OIDC_CLIENT_ID: 'c', AUTH_OIDC_CLIENT_SECRET: 's' }, /AUTH_OIDC_PROVIDER_ID must not be "google"/],
    [{ AUTH_TRUSTED_PROVIDERS: 'google' }, /AUTH_TRUSTED_PROVIDERS contains a provider that is not enabled: google/],
    [{ AUTH_BASE_URL: 'http://app.example.test' }, /AUTH_SECURE_COOKIES=false is only allowed/],
    [{ NODE_ENV: 'production' }, /AUTH_SECURE_COOKIES=false is only allowed/],
    [{ AUTH_COOKIE_DOMAIN: 'example.test' }, /AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED=true/],
    [{ AUTH_COOKIE_DOMAIN: 'example.test', AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true' }, /host of AUTH_BASE_URL and every HTTP_CORS_ORIGINS entry must be under AUTH_COOKIE_DOMAIN/],
    [{ AUTH_COOKIE_DOMAIN: 'localhost', AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true' }, /AUTH_COOKIE_DOMAIN must have at least two labels/],
  ])('%j is rejected', (env, msg) => fails(env, msg));

  it('accepts a parent cookie domain covering the base URL and every CORS origin, with the explicit trust flag', () => {
    stub({
      AUTH_BASE_URL: 'https://api.example.test', AUTH_SECURE_COOKIES: 'true', HTTP_CORS_ORIGINS: 'https://app.example.test',
      AUTH_COOKIE_DOMAIN: 'example.test', AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('external mode needs no Better Auth secret nor auth DB password', () => {
    stub({
      AUTH_MODE: 'external', BETTER_AUTH_SECRET: '', DB_AUTH_PASSWORD: '',
      AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks', AUTH_EXTERNAL_ISSUER: 'https://idp.test', AUTH_EXTERNAL_AUDIENCE: 'api',
      AUTH_EXTERNAL_ALGORITHMS: 'RS256', AUTH_EXTERNAL_USER_CLAIM: 'idtyp', AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
    });
    expect(() => validateAllConfigs()).not.toThrow();
  });
  it('production: https base URL, secure cookies, rate limit on, strong secret, https IdP URLs', () => {
    fails({ NODE_ENV: 'production', AUTH_SECURE_COOKIES: 'true', AUTH_BASE_URL: 'http://api.example.test' }, /AUTH_BASE_URL must be https in production/);
    fails({ NODE_ENV: 'production', AUTH_SECURE_COOKIES: 'true', AUTH_BASE_URL: 'https://api.example.test', AUTH_RATE_LIMIT_ENABLED: 'false' }, /AUTH_RATE_LIMIT_ENABLED must be true in production/);
    fails({ NODE_ENV: 'production', AUTH_SECURE_COOKIES: 'true', AUTH_BASE_URL: 'https://api.example.test', BETTER_AUTH_SECRET: 'a'.repeat(40) }, /BETTER_AUTH_SECRET must contain at least 16 distinct characters/);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/identity/identity-config.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/identity.config.ts`:
```ts
import { z } from 'zod';
import { defineConfig, defineConfigRule, defineProductionRule, type ConfigOf } from '../../core/config/index.js';
import { isValidCron, normalizeTimezone } from '../../core/scheduler/index.js';

export const AUTH_MODES = ['local', 'hybrid', 'external'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export const AUTH_MODE_ENV = 'AUTH_MODE';
export const DEFAULT_AUTH_MODE: AuthMode = 'local';
export const MIN_BETTER_AUTH_SECRET_LENGTH = 32;
export const MIN_SECRET_DISTINCT_CHARS = 16;
/** Chỉ thuật toán bất đối xứng (spec §5.6.3): `none` và `HS*` không bao giờ được nhận. */
export const EXTERNAL_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'] as const;
export type ExternalAlgorithm = (typeof EXTERNAL_ALGORITHMS)[number];
const API_KEY_HEADER_PATTERN = /^[a-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'set-auth-token', 'host', 'origin', 'referer', 'x-app-client-ip',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'content-type', 'content-length', 'transfer-encoding',
]);
const COOKIE_PREFIX_PATTERN = /^[a-z0-9-]{1,32}$/;
const EXTERNAL_COOKIE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_REDACTED_API_KEY_HEADER = 'x-api-key';
const LOCAL_HTTP_ORIGINS = ['http://localhost', 'http://127.0.0.1'];
const GOOGLE_PROVIDER_ID = 'google';
const MIN_COOKIE_DOMAIN_LABELS = 2;

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const positiveInt = z.coerce.number().int().positive();
const optionalText = z.string().optional().transform((s) => (s ? s : undefined));
const cron = z.string().min(1).refine(isValidCron, 'must be a valid cron expression');
const timezone = z.string().min(1).refine((tz) => normalizeTimezone(tz) !== undefined, 'must be an IANA timezone name');

export const identityConfig = defineConfig(
  'identity',
  {
    mode: 'AUTH_MODE',
    secret: 'BETTER_AUTH_SECRET',
    baseUrl: 'AUTH_BASE_URL',
    basePath: 'AUTH_BASE_PATH',
    secureCookies: 'AUTH_SECURE_COOKIES',
    cookiePrefix: 'AUTH_COOKIE_PREFIX',
    cookieDomain: 'AUTH_COOKIE_DOMAIN',
    cookieDomainAllSubdomainsTrusted: 'AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED',
    cookieSameSite: 'AUTH_COOKIE_SAMESITE',
    sessionExpiresInSec: 'AUTH_SESSION_EXPIRES_IN_SEC',
    sessionUpdateAgeSec: 'AUTH_SESSION_UPDATE_AGE_SEC',
    sessionFreshAgeSec: 'AUTH_SESSION_FRESH_AGE_SEC',
    passwordMinLength: 'AUTH_PASSWORD_MIN_LENGTH',
    passwordMaxLength: 'AUTH_PASSWORD_MAX_LENGTH',
    requireEmailVerification: 'AUTH_REQUIRE_EMAIL_VERIFICATION',
    emailTokenTtlSec: 'AUTH_EMAIL_TOKEN_TTL_SEC',
    resetTokenTtlSec: 'AUTH_RESET_TOKEN_TTL_SEC',
    googleClientId: 'AUTH_GOOGLE_CLIENT_ID',
    googleClientSecret: 'AUTH_GOOGLE_CLIENT_SECRET',
    trustedProviders: 'AUTH_TRUSTED_PROVIDERS',
    oidcProviderId: 'AUTH_OIDC_PROVIDER_ID',
    oidcDiscoveryUrl: 'AUTH_OIDC_DISCOVERY_URL',
    oidcClientId: 'AUTH_OIDC_CLIENT_ID',
    oidcClientSecret: 'AUTH_OIDC_CLIENT_SECRET',
    oidcScopes: 'AUTH_OIDC_SCOPES',
    twoFactorIssuer: 'AUTH_TWO_FACTOR_ISSUER',
    apiKeyHeader: 'AUTH_API_KEY_HEADER',
    apiKeyDefaultExpiresInSec: 'AUTH_API_KEY_DEFAULT_EXPIRES_IN_SEC',
    jwtIssuer: 'AUTH_JWT_ISSUER',
    jwtAudience: 'AUTH_JWT_AUDIENCE',
    jwtExpiresInSec: 'AUTH_JWT_EXPIRES_IN_SEC',
    jwksRotationIntervalSec: 'AUTH_JWKS_ROTATION_INTERVAL_SEC',
    jwksGracePeriodSec: 'AUTH_JWKS_GRACE_PERIOD_SEC',
    externalJwksUrl: 'AUTH_EXTERNAL_JWKS_URL',
    externalIssuer: 'AUTH_EXTERNAL_ISSUER',
    externalAudience: 'AUTH_EXTERNAL_AUDIENCE',
    externalAlgorithms: 'AUTH_EXTERNAL_ALGORITHMS',
    externalClockToleranceSec: 'AUTH_EXTERNAL_CLOCK_TOLERANCE_SEC',
    externalUserClaim: 'AUTH_EXTERNAL_USER_CLAIM',
    externalUserClaimValue: 'AUTH_EXTERNAL_USER_CLAIM_VALUE',
    externalTokenCookie: 'AUTH_EXTERNAL_TOKEN_COOKIE',
    externalTyp: 'AUTH_EXTERNAL_TYP',
    externalMaxTokenAgeSec: 'AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC',
    externalAdminClaim: 'AUTH_EXTERNAL_ADMIN_CLAIM',
    externalAdminValue: 'AUTH_EXTERNAL_ADMIN_VALUE',
    externalJwksTimeoutMs: 'AUTH_EXTERNAL_JWKS_TIMEOUT_MS',
    externalJwksCooldownMs: 'AUTH_EXTERNAL_JWKS_COOLDOWN_MS',
    externalJwksCacheMaxAgeMs: 'AUTH_EXTERNAL_JWKS_CACHE_MAX_AGE_MS',
  },
  z
    .object({
      mode: z.enum(AUTH_MODES).default(DEFAULT_AUTH_MODE).describe('local | hybrid | external (spec SP2 §5.6)'),
      secret: optionalText.describe('Better Auth secret, >= 32 chars; required unless AUTH_MODE=external (secret)'),
      baseUrl: z.url().optional().or(z.literal('').transform(() => undefined)).describe('Public base URL of the API (links in emails, cookie scope); required unless external'),
      basePath: z.string().startsWith('/').default('/api/auth').describe('Mount path of Better Auth routes'),
      secureCookies: z.stringbool().default(true).describe('Secure cookies; false only in development/test on http://localhost or http://127.0.0.1'),
      cookiePrefix: optionalText.describe('Better Auth cookie prefix (^[a-z0-9-]{1,32}$); empty = APP_SERVICE_NAME'),
      cookieDomain: optionalText.describe('Parent cookie domain to share cookies across subdomains; empty = host-only cookies'),
      cookieDomainAllSubdomainsTrusted: z.stringbool().default(false).describe('Explicit confirmation that no subdomain is controlled by third parties or user content; required with AUTH_COOKIE_DOMAIN'),
      cookieSameSite: z.enum(['lax', 'strict', 'none']).default('lax').describe('SameSite of Better Auth cookies (none requires secure cookies)'),
      sessionExpiresInSec: positiveInt.default(604800).describe('Session lifetime'),
      sessionUpdateAgeSec: positiveInt.default(86400).describe('Refresh the session expiry when older than this'),
      sessionFreshAgeSec: positiveInt.default(600).describe('Sensitive operations need a session created within this window'),
      passwordMinLength: positiveInt.default(12).describe('Minimum password length'),
      passwordMaxLength: positiveInt.default(128).describe('Maximum password length (rejected before hashing)'),
      requireEmailVerification: z.stringbool().default(true).describe('Sign-in requires a verified email'),
      emailTokenTtlSec: positiveInt.default(86400).describe('Email verification link lifetime'),
      resetTokenTtlSec: positiveInt.default(3600).describe('Password reset link lifetime'),
      googleClientId: optionalText.describe('Google OAuth client id (set together with the secret)'),
      googleClientSecret: optionalText.describe('Google OAuth client secret (secret)'),
      trustedProviders: z.string().default('').transform(csv).describe('Provider ids allowed to link by verified email (spec §5.4)'),
      oidcProviderId: optionalText.describe('Generic OIDC provider id (hybrid mode; not "google")'),
      oidcDiscoveryUrl: z.url().optional().or(z.literal('').transform(() => undefined)).describe('OIDC discovery URL (hybrid mode)'),
      oidcClientId: optionalText.describe('OIDC client id (hybrid mode)'),
      oidcClientSecret: optionalText.describe('OIDC client secret (hybrid mode, secret)'),
      oidcScopes: z.string().default('openid,email,profile').transform(csv).describe('OIDC scopes'),
      twoFactorIssuer: optionalText.describe('TOTP issuer label; empty = APP_SERVICE_NAME'),
      apiKeyHeader: z.string().default(DEFAULT_REDACTED_API_KEY_HEADER).describe('Header carrying API keys (lowercase token, must be redacted in logs)'),
      apiKeyDefaultExpiresInSec: positiveInt.default(7776000).describe('Default API key lifetime'),
      jwtIssuer: optionalText.describe('iss of JWTs issued to other services; empty = origin of AUTH_BASE_URL'),
      jwtAudience: optionalText.describe('aud of JWTs issued to other services; empty = origin of AUTH_BASE_URL'),
      jwtExpiresInSec: positiveInt.default(900).describe('Lifetime of issued JWTs (they stay valid until exp after revocation)'),
      jwksRotationIntervalSec: positiveInt.default(2592000).describe('Rotate the JWT signing key after this long'),
      jwksGracePeriodSec: positiveInt.default(604800).describe('Keep a rotated key in the JWKS for this long'),
      externalJwksUrl: z.url().optional().or(z.literal('').transform(() => undefined)).describe('IdP JWKS URL (external mode)'),
      externalIssuer: optionalText.describe('Expected iss (external mode)'),
      externalAudience: z.string().default('').transform(csv).describe('Expected aud values (external mode)'),
      externalAlgorithms: z.string().default('').transform(csv).pipe(z.array(z.enum(EXTERNAL_ALGORITHMS, { error: 'AUTH_EXTERNAL_ALGORITHMS accepts only RS*/PS*/ES*/EdDSA' }))).describe('Accepted JWS algorithms (asymmetric only)'),
      externalClockToleranceSec: z.coerce.number().int().min(0).default(30).describe('Clock skew tolerance for exp/iat/nbf'),
      externalUserClaim: optionalText.describe('Claim that marks user tokens (e.g. idtyp)'),
      externalUserClaimValue: optionalText.describe('Exact value of the user claim (e.g. user)'),
      externalTokenCookie: optionalText.describe('Cookie carrying the IdP token; empty = header only'),
      externalTyp: optionalText.describe('Expected JWT typ header (optional)'),
      externalMaxTokenAgeSec: z.coerce.number().int().positive().optional().describe('Reject tokens older than this (iat), optional'),
      externalAdminClaim: optionalText.describe('Claim granting platform admin (set together with the value)'),
      externalAdminValue: optionalText.describe('Exact value (or array element) of the admin claim'),
      externalJwksTimeoutMs: positiveInt.default(5000).describe('JWKS fetch timeout'),
      externalJwksCooldownMs: positiveInt.default(30000).describe('Minimum time between JWKS refetches for unknown kids'),
      externalJwksCacheMaxAgeMs: positiveInt.default(600000).describe('JWKS cache max age'),
    })
    .superRefine((c, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (c.mode !== 'external') {
        if (!c.secret) issue('secret', 'BETTER_AUTH_SECRET is required when AUTH_MODE is local or hybrid');
        else if (c.secret.length < MIN_BETTER_AUTH_SECRET_LENGTH) issue('secret', `BETTER_AUTH_SECRET must be at least ${MIN_BETTER_AUTH_SECRET_LENGTH} characters`);
        if (!c.baseUrl) issue('baseUrl', 'AUTH_BASE_URL is required when AUTH_MODE is local or hybrid');
      }
      if (c.mode === 'hybrid' && !(c.oidcProviderId && c.oidcDiscoveryUrl && c.oidcClientId && c.oidcClientSecret))
        issue('oidcProviderId', 'AUTH_OIDC_PROVIDER_ID, AUTH_OIDC_DISCOVERY_URL, AUTH_OIDC_CLIENT_ID and AUTH_OIDC_CLIENT_SECRET are required when AUTH_MODE=hybrid');
      if (c.oidcProviderId === GOOGLE_PROVIDER_ID) issue('oidcProviderId', 'AUTH_OIDC_PROVIDER_ID must not be "google"');
      if (c.mode === 'external' && !(c.externalJwksUrl && c.externalIssuer && c.externalAudience.length && c.externalAlgorithms.length && c.externalUserClaim && c.externalUserClaimValue))
        issue('externalJwksUrl', 'AUTH_EXTERNAL_JWKS_URL, AUTH_EXTERNAL_ISSUER, AUTH_EXTERNAL_AUDIENCE, AUTH_EXTERNAL_ALGORITHMS, AUTH_EXTERNAL_USER_CLAIM and AUTH_EXTERNAL_USER_CLAIM_VALUE are required when AUTH_MODE=external');
      if (!c.googleClientId !== !c.googleClientSecret) issue('googleClientId', 'AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET must be set together');
      if (!c.externalAdminClaim !== !c.externalAdminValue) issue('externalAdminClaim', 'AUTH_EXTERNAL_ADMIN_CLAIM and AUTH_EXTERNAL_ADMIN_VALUE must be set together');
      if (c.passwordMinLength >= c.passwordMaxLength) issue('passwordMinLength', 'AUTH_PASSWORD_MIN_LENGTH must be less than AUTH_PASSWORD_MAX_LENGTH');
      if (c.cookieSameSite === 'none' && !c.secureCookies) issue('cookieSameSite', 'AUTH_COOKIE_SAMESITE=none requires AUTH_SECURE_COOKIES=true');
      if (!API_KEY_HEADER_PATTERN.test(c.apiKeyHeader)) issue('apiKeyHeader', `AUTH_API_KEY_HEADER must match ${API_KEY_HEADER_PATTERN}`);
      if (RESERVED_HEADERS.has(c.apiKeyHeader)) issue('apiKeyHeader', 'AUTH_API_KEY_HEADER must not be a reserved header');
      if (c.cookiePrefix !== undefined && !COOKIE_PREFIX_PATTERN.test(c.cookiePrefix)) issue('cookiePrefix', `AUTH_COOKIE_PREFIX must match ${COOKIE_PREFIX_PATTERN}`);
      if (c.externalTokenCookie !== undefined) {
        if (!EXTERNAL_COOKIE_PATTERN.test(c.externalTokenCookie) || /^__(Secure|Host)-/.test(c.externalTokenCookie))
          issue('externalTokenCookie', `AUTH_EXTERNAL_TOKEN_COOKIE must match ${EXTERNAL_COOKIE_PATTERN} and not start with __Secure- or __Host-`);
        if (c.cookiePrefix !== undefined && c.externalTokenCookie.startsWith(`${c.cookiePrefix}.`))
          issue('externalTokenCookie', 'AUTH_EXTERNAL_TOKEN_COOKIE must not collide with Better Auth cookie names (<AUTH_COOKIE_PREFIX>.*)');
      }
      const enabled = new Set([...(c.googleClientId ? [GOOGLE_PROVIDER_ID] : []), ...(c.mode === 'hybrid' && c.oidcProviderId ? [c.oidcProviderId] : [])]);
      const notEnabled = c.trustedProviders.filter((p) => !enabled.has(p));
      if (notEnabled.length) issue('trustedProviders', `AUTH_TRUSTED_PROVIDERS contains a provider that is not enabled: ${notEnabled.join(', ')}`);
    }),
);
export type IdentityConfig = ConfigOf<typeof identityConfig>;

export const identityGuardConfig = defineConfig(
  'identityGuard',
  {
    rateLimitEnabled: 'AUTH_RATE_LIMIT_ENABLED',
    rateLimitWindowSec: 'AUTH_RATE_LIMIT_WINDOW_SEC',
    rateLimitMax: 'AUTH_RATE_LIMIT_MAX',
    signinRateWindowSec: 'AUTH_SIGNIN_RATE_WINDOW_SEC',
    signinRateMax: 'AUTH_SIGNIN_RATE_MAX',
    twoFactorRateWindowSec: 'AUTH_TWO_FACTOR_RATE_WINDOW_SEC',
    twoFactorRateMax: 'AUTH_TWO_FACTOR_RATE_MAX',
    emailRateWindowSec: 'AUTH_EMAIL_RATE_WINDOW_SEC',
    emailRateMax: 'AUTH_EMAIL_RATE_MAX',
    lockoutMaxFailures: 'AUTH_LOCKOUT_MAX_FAILURES',
    lockoutWindowSec: 'AUTH_LOCKOUT_WINDOW_SEC',
    lockoutBlockSec: 'AUTH_LOCKOUT_BLOCK_SEC',
    unavailableRetryAfterSec: 'AUTH_UNAVAILABLE_RETRY_AFTER_SEC',
    existingAccountNoticeWindowSec: 'AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC',
    registeredReconcileCron: 'AUTH_REGISTERED_RECONCILE_CRON',
    registeredReconcileTz: 'AUTH_REGISTERED_RECONCILE_TZ',
    registeredReconcileGraceSec: 'AUTH_REGISTERED_RECONCILE_GRACE_SEC',
    registeredReconcileBatchSize: 'AUTH_REGISTERED_RECONCILE_BATCH_SIZE',
    registeredReconcileMaxBatches: 'AUTH_REGISTERED_RECONCILE_MAX_BATCHES',
    purgeCron: 'AUTH_PURGE_CRON',
    purgeTz: 'AUTH_PURGE_TZ',
    purgeBatchSize: 'AUTH_PURGE_BATCH_SIZE',
    purgeMaxBatches: 'AUTH_PURGE_MAX_BATCHES',
  },
  z.object({
    rateLimitEnabled: z.stringbool().default(true).describe('Better Auth per-IP rate limit (required in production)'),
    rateLimitWindowSec: positiveInt.default(60).describe('Default per-IP window for /api/auth/*'),
    rateLimitMax: positiveInt.default(100).describe('Default per-IP max requests per window'),
    signinRateWindowSec: positiveInt.default(60).describe('Per-IP window for /sign-in/* and /sign-up/*'),
    signinRateMax: positiveInt.default(10).describe('Per-IP max for /sign-in/* and /sign-up/*'),
    twoFactorRateWindowSec: positiveInt.default(60).describe('Per-IP window for /two-factor/*'),
    twoFactorRateMax: positiveInt.default(10).describe('Per-IP max for /two-factor/*'),
    emailRateWindowSec: positiveInt.default(300).describe('Per-IP window for password reset and verification emails'),
    emailRateMax: positiveInt.default(3).describe('Per-IP max for password reset and verification emails'),
    lockoutMaxFailures: positiveInt.default(10).describe('Failed attempts per account per window before the account is blocked'),
    lockoutWindowSec: positiveInt.default(900).describe('Fixed window of the account lockout counter'),
    lockoutBlockSec: positiveInt.default(900).describe('How long a locked account stays blocked'),
    unavailableRetryAfterSec: positiveInt.default(5).describe('Retry-After on 503 when auth storage is down'),
    existingAccountNoticeWindowSec: positiveInt.default(86400).describe('At most one "account already exists" email per user per window'),
    registeredReconcileCron: cron.default('*/5 * * * *').describe('Cron of identity.reconcile-registered'),
    registeredReconcileTz: timezone.default('UTC').describe('Timezone of the reconcile cron'),
    registeredReconcileGraceSec: positiveInt.default(120).describe('Users younger than this are left to the after-hook'),
    registeredReconcileBatchSize: positiveInt.default(500).describe('Users per reconcile batch'),
    registeredReconcileMaxBatches: positiveInt.default(20).describe('Max batches per reconcile run'),
    purgeCron: cron.default('15 3 * * *').describe('Cron of identity.purge-expired'),
    purgeTz: timezone.default('UTC').describe('Timezone of the purge cron'),
    purgeBatchSize: positiveInt.default(5000).describe('Rows deleted per purge statement'),
    purgeMaxBatches: positiveInt.default(100).describe('Max purge statements per table per run'),
  }),
);
export type IdentityGuardConfig = ConfigOf<typeof identityGuardConfig>;

export const authDatabaseConfig = defineConfig(
  'authDatabase',
  {
    host: 'DB_AUTH_HOST',
    port: 'DB_AUTH_PORT',
    user: 'DB_AUTH_USER',
    password: 'DB_AUTH_PASSWORD',
    poolMax: 'DB_AUTH_POOL_MAX',
    connectionTimeoutMs: 'DB_AUTH_CONNECTION_TIMEOUT_MS',
  },
  z.object({
    host: optionalText.describe('Host of the auth_user pool (defaults to DB_HOST)'),
    port: z.coerce.number().int().positive().optional().describe('Port of the auth_user pool (defaults to DB_PORT)'),
    user: z.string().default('auth_user').describe('Role of the Better Auth pool (schema auth only)'),
    password: optionalText.describe('Password of auth_user; required on api/worker unless AUTH_MODE=external (secret)'),
    poolMax: positiveInt.default(5).describe('Max connections of the auth_user pool per process'),
    connectionTimeoutMs: positiveInt.default(3000).describe('Max wait for an auth pool connection before answering 503'),
  }),
);
export type AuthDatabaseConfig = ConfigOf<typeof authDatabaseConfig>;

const isLocalHttp = (url: unknown): boolean =>
  typeof url === 'string' && URL.canParse(url) && LOCAL_HTTP_ORIGINS.includes(new URL(url).origin.replace(/:\d+$/, ''));
const hostUnder = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const hostOf = (u: unknown): string | undefined => (typeof u === 'string' && URL.canParse(u) ? new URL(u).hostname : undefined);

defineConfigRule('identity-auth-db-password', (c) =>
  c.identity?.mode !== 'external' && c.app?.role !== 'migrate' && !c.authDatabase?.password
    ? 'DB_AUTH_PASSWORD is required on api/worker when AUTH_MODE is local or hybrid'
    : undefined,
);
defineConfigRule('identity-secure-cookies', (c) => {
  if (c.identity?.secureCookies !== false) return undefined;
  const devOrTest = c.app?.nodeEnv === 'development' || c.app?.nodeEnv === 'test';
  return devOrTest && isLocalHttp(c.identity?.baseUrl)
    ? undefined
    : 'AUTH_SECURE_COOKIES=false is only allowed with NODE_ENV development/test and AUTH_BASE_URL on http://localhost or http://127.0.0.1';
});
defineConfigRule('identity-cookie-domain', (c) => {
  const domain = c.identity?.cookieDomain;
  if (typeof domain !== 'string') return undefined;
  if (c.identity?.cookieDomainAllSubdomainsTrusted !== true)
    return 'AUTH_COOKIE_DOMAIN requires AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED=true (every subdomain receives the cookie)';
  if (domain === 'localhost' || domain.split('.').filter(Boolean).length < MIN_COOKIE_DOMAIN_LABELS)
    return 'AUTH_COOKIE_DOMAIN must have at least two labels and not be localhost';
  const origins = Array.isArray(c.http?.corsOrigins) ? c.http.corsOrigins : [];
  const hosts = [hostOf(c.identity?.baseUrl), ...origins.map(hostOf)];
  return hosts.every((h) => h !== undefined && hostUnder(h, domain))
    ? undefined
    : 'host of AUTH_BASE_URL and every HTTP_CORS_ORIGINS entry must be under AUTH_COOKIE_DOMAIN';
});
defineConfigRule('identity-api-key-header-redacted', (c) => {
  const header = c.identity?.apiKeyHeader;
  if (header === DEFAULT_REDACTED_API_KEY_HEADER || typeof header !== 'string') return undefined;
  const extra = Array.isArray(c.logging?.extraRedact) ? c.logging.extraRedact : [];
  return extra.includes(`req.headers["${header}"]`)
    ? undefined
    : `AUTH_API_KEY_HEADER "${header}" must be redacted: add req.headers["${header}"] to LOG_EXTRA_REDACT_PATHS`;
});
defineProductionRule('identity-production', (c) => {
  const id = c.identity;
  if (id?.mode === 'external') {
    const jwks = id.externalJwksUrl;
    return typeof jwks === 'string' && jwks.startsWith('https://') ? undefined : 'AUTH_EXTERNAL_JWKS_URL must be https in production';
  }
  if (typeof id?.baseUrl !== 'string' || !id.baseUrl.startsWith('https://')) return 'AUTH_BASE_URL must be https in production';
  if (id.secureCookies !== true) return 'AUTH_SECURE_COOKIES must be true in production';
  if (c.identityGuard?.rateLimitEnabled !== true) return 'AUTH_RATE_LIMIT_ENABLED must be true in production';
  if (typeof id.secret !== 'string' || new Set(id.secret).size < MIN_SECRET_DISTINCT_CHARS)
    return `BETTER_AUTH_SECRET must contain at least ${MIN_SECRET_DISTINCT_CHARS} distinct characters in production`;
  if (typeof id.oidcDiscoveryUrl === 'string' && !id.oidcDiscoveryUrl.startsWith('https://')) return 'AUTH_OIDC_DISCOVERY_URL must be https in production';
  return undefined;
});

/** Cho `ConditionalModule.registerWhen` (đọc env thô, trước khi Nest resolve config). */
export const isBetterAuthMode = (env: Record<string, string | undefined>): boolean =>
  (env[AUTH_MODE_ENV] || DEFAULT_AUTH_MODE) !== 'external';
export const isExternalMode = (env: Record<string, string | undefined>): boolean => !isBetterAuthMode(env);

type AppLike = { serviceName: string };
export const effectiveCookiePrefix = (id: IdentityConfig, app: AppLike): string => id.cookiePrefix ?? app.serviceName;
export const effectiveTwoFactorIssuer = (id: IdentityConfig, app: AppLike): string => id.twoFactorIssuer ?? app.serviceName;
const baseOrigin = (id: IdentityConfig): string => {
  if (!id.baseUrl) throw new Error('AUTH_BASE_URL is required in local/hybrid mode');
  return new URL(id.baseUrl).origin;
};
export const effectiveJwtIssuer = (id: IdentityConfig): string => id.jwtIssuer ?? baseOrigin(id);
export const effectiveJwtAudience = (id: IdentityConfig): string => id.jwtAudience ?? baseOrigin(id);
```
Ghi chú: luật "`AUTH_SECURE_COOKIES=false` với `NODE_ENV=production`" vừa là luật mọi môi trường (`identity-secure-cookies`) vừa bị luật production chặn lần nữa; test dùng regex của luật đầu.

`test/support/env.ts` (`baseTestEnv`) thêm:
```ts
    BETTER_AUTH_SECRET: randomSecret(36),
    AUTH_BASE_URL: 'http://localhost:3000',
    // Test gọi http nội bộ: dev/test + localhost là trường hợp duy nhất được tắt Secure (spec §5.4).
    AUTH_SECURE_COOKIES: 'false',
    HTTP_CORS_ORIGINS: 'http://localhost:3000',
```
`src/scripts/gen-env-example.ts`: thêm `import '../modules/identity/identity.config.js';` rồi `pnpm env:example`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/identity/identity-config.spec.ts && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity/identity.config.ts src/scripts/gen-env-example.ts .env.example test/support/env.ts test/unit/modules/identity/identity-config.spec.ts
git commit -m "feat(identity): configuration with mode requirements, cookie/header naming and production rules"
```

---

### Task 26: Schema Better Auth (`auth generate`) + marker event + `login_attempts`, pool `auth_user`, catalog

**Files:**
- Create: `src/modules/identity/infra/better-auth/auth-schema.ts`, `src/modules/identity/infra/better-auth/auth-pool.ts`, `src/modules/identity/infra/better-auth/auth.cli-config.ts`, `src/migrations/identity/Migration<timestamp>_better_auth_schema.ts` (bằng CLI), `test/integration/identity/auth-schema.spec.ts`
- Modify: `src/core/database/index.ts` (export `tlsOptions`), `package.json` (script `auth:generate`, `auth:create-admin`), `.gitignore` (`.auth-schema/`), `test/integration/core/database/rls-catalog.spec.ts` (`AUTH_TABLES`), `test/integration/core/database/normalization-inventory.spec.ts`

**Interfaces:**
- Consumes: `identityConfig`, `authDatabaseConfig` (Task 25); `databaseConfig`, `tlsOptions` (SP1); kết quả S2, S3 (Task 2, 3).
- Produces:
  - `AUTH_SCHEMA = 'auth'`, `AUTH_TABLES` (tên bảng thật theo S3), `LOGIN_ATTEMPTS_TABLE = 'login_attempts'`, `corePlugins(identity: IdentityConfig, app: { serviceName: string })` (tuple `[twoFactor, bearer, apiKey, jwt, admin]`), `schemaOptions(identity, app)` (plugins + `rateLimit.storage: 'database'` + `advanced.database.generateId: 'uuid'` + `emailAndPassword.enabled`), `IMPERSONATION_PATHS` (`auth-schema.ts`).
  - `createAuthPool(auth: AuthDatabaseConfig, db: ConfigOf<typeof databaseConfig>): pg.Pool` (`auth-pool.ts`).
  - Migration tạo 8 bảng của Better Auth + `login_attempts` trong schema `auth`, `DEFAULT uuidv7()`, `UNIQUE (provider_id, account_id)`, FK `apikey.reference_id`, cột `"user".registered_event_emitted_at`, index theo spec §5.3, grant `SELECT, INSERT, UPDATE, DELETE` cho `auth_user`.
  - Script `pnpm auth:generate` (in SQL cần áp; CI Task 48 dùng) và `pnpm auth:create-admin`.

- [ ] **Step 1: Viết test fail**

`test/integration/identity/auth-schema.spec.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_TABLES } from '../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { databaseConfig } from '../../../src/core/database/index.js';

describe('auth schema (as auth_user through the auth pool)', () => {
  let pool: pg.Pool; let owner: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await pool?.end(); await owner?.end(); });

  it('connects as auth_user with search_path = auth', async () => {
    const { rows } = await pool.query<{ u: string; sp: string }>('SELECT current_user AS u, current_setting(\'search_path\') AS sp');
    expect(rows[0]).toEqual({ u: 'auth_user', sp: 'auth' });
  });
  it('every table of schema auth is in AUTH_TABLES, none has org_id, and ids default to uuidv7()', async () => {
    const t = await owner.query<{ relname: string }>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'auth' AND c.relkind = 'r' ORDER BY 1`);
    expect(t.rows.map((r) => r.relname)).toEqual([...AUTH_TABLES].sort());
    const org = await owner.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'auth' AND column_name = 'org_id'`);
    expect(org.rows).toEqual([]);
    const ids = await owner.query<{ table_name: string; column_default: string | null; data_type: string }>(
      `SELECT table_name, column_default, data_type FROM information_schema.columns WHERE table_schema = 'auth' AND column_name = 'id'`);
    for (const r of ids.rows) expect(r, r.table_name).toMatchObject({ column_default: 'uuidv7()', data_type: 'uuid' });
  });
  it('auth_user has exactly SELECT/INSERT/UPDATE/DELETE on each auth table', async () => {
    const { rows } = await owner.query<{ table_name: string; privs: string[] }>(
      `SELECT table_name, array_agg(privilege_type ORDER BY privilege_type) AS privs FROM information_schema.role_table_grants
        WHERE grantee = 'auth_user' AND table_schema = 'auth' GROUP BY table_name`);
    for (const t of AUTH_TABLES) expect(rows.find((r) => r.table_name === t)?.privs, t).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
  it('account (provider_id, account_id) and user email are unique; apikey is owned by its user', async () => {
    const { rows } = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'auth'::regnamespace AND contype IN ('u', 'f')`);
    const defs = rows.map((r) => r.def);
    expect(defs).toContain('UNIQUE (provider_id, account_id)');
    expect(defs).toContain('UNIQUE (email)');
    expect(defs.some((d) => /FOREIGN KEY \(reference_id\) REFERENCES auth\."user"\(id\) ON DELETE CASCADE/.test(d))).toBe(true);
  });
  it('registered_event_emitted_at exists, is nullable and has the partial index used by the reconcile cron', async () => {
    const col = await owner.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'user' AND column_name = 'registered_event_emitted_at'`);
    expect(col.rows[0]).toEqual({ is_nullable: 'YES' });
    const idx = await owner.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'auth' AND indexname = 'user_unmarked_registered_idx'`);
    expect(idx.rows[0]?.indexdef).toMatch(/\(created_at\) WHERE \(registered_event_emitted_at IS NULL\)/);
  });
});
```
Cập nhật `test/integration/core/database/normalization-inventory.spec.ts`, thêm vào `ANALYSED_COLUMNS` (danh sách cuối cùng lấy theo output S3 — mỗi cột ở đây phải có trong bảng §5.16b; cột mới chưa có thì cập nhật spec §5.16b trước):
```ts
  'auth.user': ['id', 'name', 'email', 'email_verified', 'image', 'created_at', 'updated_at', 'two_factor_enabled', 'role', 'banned', 'ban_reason', 'ban_expires', 'registered_event_emitted_at'],
  'auth.session': ['id', 'expires_at', 'token', 'created_at', 'updated_at', 'ip_address', 'user_agent', 'user_id', 'impersonated_by'],
  'auth.account': ['id', 'account_id', 'provider_id', 'user_id', 'access_token', 'refresh_token', 'id_token', 'access_token_expires_at', 'refresh_token_expires_at', 'scope', 'password', 'created_at', 'updated_at'],
  'auth.verification': ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
  'auth.two_factor': ['id', 'secret', 'backup_codes', 'user_id', 'verified', 'failed_verification_count', 'locked_until'],
  'auth.apikey': ['id', 'name', 'start', 'prefix', 'key', 'reference_id', 'config_id', 'refill_interval', 'refill_amount', 'last_refill_at', 'enabled', 'rate_limit_enabled', 'rate_limit_time_window', 'rate_limit_max', 'request_count', 'remaining', 'last_request', 'expires_at', 'created_at', 'updated_at', 'permissions', 'metadata'],
  'auth.jwks': ['id', 'public_key', 'private_key', 'created_at', 'expires_at'],
  'auth.rate_limit': ['id', 'key', 'count', 'last_request'],
  'auth.login_attempts': ['key', 'points', 'expire'],
```
`test/integration/core/database/rls-catalog.spec.ts`: thêm test:
```ts
  it('schema auth holds only the Better Auth allowlist, without org_id and without RLS policies', async () => {
    const rows = await tables(client, 'auth');
    expect(rows.map((r) => r.name).sort()).toEqual([...AUTH_TABLES].sort());
    expect(rows.filter((r) => r.has_org || r.org_policy)).toEqual([]);
  });
```
(import `AUTH_TABLES` từ `src/modules/identity/infra/better-auth/auth-schema.js`.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/identity/auth-schema.spec.ts test/integration/core/database`
Expected: FAIL — module và bảng chưa tồn tại.

- [ ] **Step 3: Plugin dùng chung cho CLI và runtime, pool `auth_user`**

`src/core/database/index.ts`: thêm `export { tlsOptions } from './tls.js';` (pool `auth_user` dùng cùng `DB_SSL_MODE`, spec §5.15).

`src/modules/identity/infra/better-auth/auth-pool.ts`:
```ts
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { type ConfigOf } from '../../../../core/config/index.js';
import { tlsOptions, type databaseConfig } from '../../../../core/database/index.js';
import type { AuthDatabaseConfig } from '../../identity.config.js';

const logger = new Logger('AuthPool');

/**
 * Pool `pg` riêng của Better Auth, đăng nhập `auth_user` (schema `auth` qua `search_path` của role). Không
 * đặt `statement_timeout` qua startup parameter (PgBouncer transaction mode bỏ đi); timeout nằm trên role.
 * `connectionTimeoutMillis`: hết chờ connection thì lỗi, được map thành 503 (spec §5.5 quy tắc 4).
 */
export function createAuthPool(auth: AuthDatabaseConfig, db: ConfigOf<typeof databaseConfig>): pg.Pool {
  if (!auth.password) throw new Error('DB_AUTH_PASSWORD is required to open the auth_user pool');
  const pool = new pg.Pool({
    host: auth.host ?? db.host,
    port: auth.port ?? db.port,
    database: db.name,
    user: auth.user,
    password: auth.password,
    max: auth.poolMax,
    connectionTimeoutMillis: auth.connectionTimeoutMs,
    ssl: tlsOptions(db),
  });
  // Review NB1: client RẢNH bị đứt (PgBouncer restart, pg_terminate_backend, mạng) làm pool phát 'error';
  // không có listener là uncaught exception → sập process. Cùng mẫu listener 'error' của SP1 (redis.module.ts).
  // Chỉ log mã lỗi (không message/host/user); pool tự bỏ client hỏng, request sau mở connection mới hoặc
  // lỗi → 503 ở mount (fail-closed). Không ném lại.
  pool.on('error', (err: Error & { code?: string }) =>
    logger.warn({ event: 'auth_pool_idle_error', code: err.code, name: err.name }, 'idle auth_user connection failed; dropped from the pool'),
  );
  return pool;
}
```
`src/modules/identity/infra/better-auth/auth-schema.ts`:
```ts
import { apiKey } from '@better-auth/api-key';
import { admin, bearer, jwt, twoFactor } from 'better-auth/plugins';
import {
  effectiveJwtAudience, effectiveJwtIssuer, effectiveTwoFactorIssuer, type IdentityConfig,
} from '../../identity.config.js';

export const AUTH_SCHEMA = 'auth';
export const LOGIN_ATTEMPTS_TABLE = 'login_attempts';
/** Tên bảng thật theo output `auth generate` (spike S3) + bảng lockout của mình. */
export const AUTH_TABLES = ['user', 'session', 'account', 'verification', 'two_factor', 'apikey', 'jwks', 'rate_limit', LOGIN_ATTEMPTS_TABLE] as const;
export const ADMIN_ROLE = 'admin';
export const DEFAULT_ROLE = 'user';
/** D7: impersonation tắt. */
export const IMPERSONATION_PATHS = ['/admin/impersonate-user', '/admin/stop-impersonating'] as const;

/**
 * Plugin có ảnh hưởng tới schema. Dùng chung cho CLI (`auth generate`, kiểm lệch ở CI) và runtime, để hai
 * nơi không lệch. `genericOAuth` không có bảng riêng nên chỉ thêm ở runtime (Task 33).
 */
export function corePlugins(id: IdentityConfig, app: { serviceName: string }) {
  return [
    twoFactor({ issuer: effectiveTwoFactorIssuer(id, app), backupCodeOptions: { storeBackupCodes: 'encrypted' } }),
    bearer(),
    apiKey({
      apiKeyHeaders: [id.apiKeyHeader],
      references: 'user',
      enableSessionForAPIKeys: false,
      // Đơn vị GIÂY: plugin tính `getDate(defaultExpiresIn, "sec")` (dist/index.mjs, review I3).
      keyExpiration: { defaultExpiresIn: id.apiKeyDefaultExpiresInSec },
      // Mặc định plugin bật 10 request/ngày/key (lưu đếm trong bảng apikey, mỗi request một UPDATE): API key
      // máy gần như không dùng được. Tắt; giới hạn tốc độ theo principal do throttler Nest của SP1 đảm nhận
      // (`AppThrottlerGuard` đếm theo principal khi có). Test: Task 39 (> 10 request liên tiếp đều 200).
      rateLimit: { enabled: false },
    }),
    jwt({
      jwt: { issuer: effectiveJwtIssuer(id), audience: effectiveJwtAudience(id), expirationTime: `${id.jwtExpiresInSec}s` },
      jwks: { rotationInterval: id.jwksRotationIntervalSec, gracePeriod: id.jwksGracePeriodSec },
    }),
    admin({ adminRoles: [ADMIN_ROLE], defaultRole: DEFAULT_ROLE }),
  ] as const;
}

export function schemaOptions(id: IdentityConfig, app: { serviceName: string }) {
  return {
    plugins: corePlugins(id, app),
    emailAndPassword: { enabled: true },
    rateLimit: { storage: 'database' as const },
    advanced: { database: { generateId: 'uuid' as const } },
  };
}
```
(Tên option `rateLimit.enabled` và `keyExpiration.defaultExpiresIn` đối chiếu `node_modules/@better-auth/api-key/dist/index.d.mts`; `.env.infra` chứa `DB_PORT_HOST`/`PGBOUNCER_PORT_HOST` nên Step 4 source cả hai file.) (`jwt.expirationTime` là số thì bị hiểu là mốc thời gian tuyệt đối — `plugins/jwt/types.d.mts` — nên truyền chuỗi `"<n>s"`. Nếu S3 chọn nhánh (B) thì `generateId: () => v7()`.)

`src/modules/identity/infra/better-auth/auth.cli-config.ts`:
```ts
import { betterAuth } from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import '../../../../core/config/all-configs.js';
import { appConfig } from '../../../../core/config/index.js';
import { databaseConfig } from '../../../../core/database/index.js';
import { authDatabaseConfig, identityConfig } from '../../identity.config.js';
import { createAuthPool } from './auth-pool.js';
import { AUTH_SCHEMA, schemaOptions } from './auth-schema.js';

/**
 * CHỈ cho CLI `auth` (spec §5.3 bước 1): dạng `{ db, type, schemaName, transaction }` vì CLI cần dialect,
 * không cần lớp mã hoá của runtime. Plugin lấy từ `schemaOptions`, cùng nguồn với runtime.
 * Chạy từ `dist/` (script `auth:generate`) để import `.js` resolve bằng Node, không phụ thuộc jiti.
 */
const identity = identityConfig();
const pool = createAuthPool(authDatabaseConfig(), databaseConfig());
export const auth = betterAuth({
  secret: identity.secret,
  baseURL: identity.baseUrl,
  database: {
    db: new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] }),
    type: 'postgres',
    schemaName: AUTH_SCHEMA,
    transaction: true,
  },
  ...schemaOptions(identity, appConfig()),
});
export default auth;
```
`package.json` scripts (flag theo output Task 3 Step 1):
```json
"auth:generate": "pnpm build && auth generate --config dist/modules/identity/infra/better-auth/auth.cli-config.js --output .auth-schema/pending.sql --yes",
"auth:create-admin": "pnpm build && auth create-admin --config dist/modules/identity/infra/better-auth/auth.cli-config.js"
```
`.gitignore`: thêm `.auth-schema/`.

- [ ] **Step 4: Sinh SQL và tạo migration bằng CLI**

Run (Postgres dev trống, env từ `.env`):
```bash
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env down -v
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env up -d --wait postgres pgbouncer
set -a; . ./.env; . ./.env.infra; set +a; export APP_ROLE=api DB_HOST=127.0.0.1 DB_PORT=$DB_PORT_HOST DB_AUTH_HOST=127.0.0.1 DB_AUTH_PORT=$PGBOUNCER_PORT_HOST
pnpm auth:generate && cat .auth-schema/pending.sql
pnpm exec mikro-orm migration:create --blank --path src/migrations/identity --name better_auth_schema
```
Đối chiếu `.auth-schema/pending.sql` với `ANALYSED_COLUMNS` ở Step 1 và bảng §5.16b: cột nào khác thì sửa spec §5.16b + `ANALYSED_COLUMNS` trước, rồi mới viết SQL.

Sửa migration vừa sinh (giữ tên lớp CLI sinh). **SQL dưới đây chỉ là mẫu, không có hiệu lực** (review M4): nguồn sự thật là `.auth-schema/pending.sql` của Better Auth 1.7.6 đã áp các sửa đổi của spec §5.3 bước 4. Ví dụ `two_factor` của 1.7.6 có thêm `verified`, `failed_verification_count`, `locked_until` (đã thêm dưới đây); kiểu/null/default của mọi cột lấy theo `pending.sql`, và mỗi cột mới phải có dòng trong bảng spec §5.16b (cập nhật spec cùng commit). Test kiểm lệch (Task 48) bắt mọi sai khác còn sót:
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Schema `auth` của Better Auth 1.7.6 (SQL gốc từ `pnpm auth:generate`, spec §5.3) + cột/bảng của mình.
 * Sửa so với SQL gốc (mỗi dòng một lý do):
 * - `id`/FK kiểu uuid, `DEFAULT uuidv7()` (D3, ADR 0009: id do DB sinh, v7); thời gian timestamptz.
 * - UNIQUE (provider_id, account_id) (spec cha §11: UNIQUE(issuer, subject)); UNIQUE (email) trên "user".
 * - apikey.reference_id → "user"(id) ON DELETE CASCADE (key thuộc hẳn user, A.7).
 * - FK session/account/two_factor → "user" ON DELETE CASCADE: dòng con hoàn toàn thuộc user.
 * - "user".registered_event_emitted_at NULL: marker bền của event identity.user.registered (spec §5.10).
 * - login_attempts: DDL đúng của RateLimiterPostgres (A.9: INSERT … VALUES theo vị trí 3 cột, nên không có
 *   created_at/updated_at), dùng tableCreated: true.
 * - Mỗi index gắn với một query (bên dưới).
 *
 * Bảng chuẩn hoá (spec §5.16a/b):
 * | "user" | khoá {id}, {email} | lệch: two_factor_enabled dẫn xuất từ two_factor; role chuỗi (có thể đa trị); banned/ban_* là cờ rời |
 * |        | ngoại lệ "schema do thư viện sở hữu": chỉ plugin ghi các cột đó; app đọc role qua IdentityDirectory, chỉ so 'admin' |
 * |        | registered_event_emitted_at: id → marker; một người ghi (UPDATE … WHERE … IS NULL), không bản sao |
 * | session | {id}, {token} | không lệch 3NF |
 * | account | {id}, {provider_id, account_id} | scope đa trị (tài liệu mờ); password chỉ nghĩa với provider credential |
 * | verification | {id} | identifier ghép loại + giá trị (tài liệu mờ; chỉ cron dọn đọc expires_at) |
 * | two_factor | {id} | backup_codes một khối mã hoá (tài liệu mờ thật sự) |
 * | apikey | {id} | permissions/metadata JSON (SP2 không đọc); start/prefix snapshot (key chỉ lưu dạng băm) |
 * | jwks | {id} | không lệch 3NF |
 * | rate_limit | {id}, {key} | key ghép IP + path; last_request bigint epoch ms (thư viện sở hữu) |
 * | login_attempts | {key} | key ghép loại + hash + số cửa sổ; expire bigint ms; points âm được khi refund; BCNF về phụ thuộc hàm |
 * Cơ chế nhất quán: kiểm lệch schema ở CI (`pnpm auth:generate` phải rỗng), validateSchema lúc chạy.
 */
export class Migration20260927000100_better_auth_schema extends Migration {
  override name = 'Migration20260927000100_better_auth_schema';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE auth."user" (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL,
    image TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    two_factor_enabled BOOLEAN DEFAULT false,
    role TEXT,
    banned BOOLEAN DEFAULT false,
    ban_reason TEXT,
    ban_expires TIMESTAMPTZ,
    registered_event_emitted_at TIMESTAMPTZ NULL,
    CONSTRAINT user_email_uq UNIQUE (email));`);
    this.addSql(`CREATE TABLE auth.session (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    expires_at TIMESTAMPTZ NOT NULL,
    token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    user_id UUID NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    impersonated_by TEXT,
    CONSTRAINT session_token_uq UNIQUE (token));`);
    this.addSql(`CREATE TABLE auth.account (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT account_provider_account_uq UNIQUE (provider_id, account_id));`);
    this.addSql(`CREATE TABLE auth.verification (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    this.addSql(`CREATE TABLE auth.two_factor (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    secret TEXT NOT NULL,
    backup_codes TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    verified BOOLEAN DEFAULT true,
    failed_verification_count INTEGER DEFAULT 0 CHECK (failed_verification_count >= 0),
    locked_until TIMESTAMPTZ);`);
    this.addSql(`CREATE TABLE auth.apikey (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    config_id TEXT NOT NULL DEFAULT 'default',
    name TEXT,
    start TEXT,
    prefix TEXT,
    key TEXT NOT NULL,
    reference_id UUID NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    refill_interval INTEGER,
    refill_amount INTEGER,
    last_refill_at TIMESTAMPTZ,
    enabled BOOLEAN DEFAULT true,
    rate_limit_enabled BOOLEAN DEFAULT true,
    rate_limit_time_window INTEGER,
    rate_limit_max INTEGER,
    request_count INTEGER DEFAULT 0,
    remaining INTEGER,
    last_request TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL,
    permissions TEXT,
    metadata TEXT);`);
    this.addSql(`CREATE TABLE auth.jwks (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ);`);
    this.addSql(`CREATE TABLE auth.rate_limit (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    key TEXT NOT NULL,
    count INTEGER NOT NULL,
    last_request BIGINT NOT NULL,
    CONSTRAINT rate_limit_key_uq UNIQUE (key));`);
    this.addSql(`CREATE TABLE auth.login_attempts (
    key VARCHAR(255) PRIMARY KEY,
    points INTEGER NOT NULL DEFAULT 0,
    expire BIGINT);`);
    // Thu hồi mọi session của user (đổi mật khẩu, ban) + FK.
    this.addSql(`CREATE INDEX session_user_id_idx ON auth.session (user_id);`);
    // Cron identity.purge-expired.
    this.addSql(`CREATE INDEX session_expires_at_idx ON auth.session (expires_at);`);
    this.addSql(`CREATE INDEX verification_expires_at_idx ON auth.verification (expires_at);`);
    this.addSql(`CREATE INDEX login_attempts_expire_idx ON auth.login_attempts (expire);`);
    // FK + liệt kê account của user; tra token xác thực theo identifier; liệt kê/xoá key của user.
    this.addSql(`CREATE INDEX account_user_id_idx ON auth.account (user_id);`);
    this.addSql(`CREATE INDEX verification_identifier_idx ON auth.verification (identifier);`);
    this.addSql(`CREATE INDEX apikey_reference_id_idx ON auth.apikey (reference_id);`);
    this.addSql(`CREATE INDEX two_factor_user_id_idx ON auth.two_factor (user_id);`);
    // Verify API key: tra theo key đã băm.
    this.addSql(`CREATE INDEX apikey_key_idx ON auth.apikey (key);`);
    // Cron identity.reconcile-registered: chỉ user chưa có marker (index nhỏ).
    this.addSql(`CREATE INDEX user_unmarked_registered_idx ON auth."user" (created_at) WHERE registered_event_emitted_at IS NULL;`);
    for (const t of ['"user"', 'session', 'account', 'verification', 'two_factor', 'apikey', 'jwks', 'rate_limit', 'login_attempts'])
      this.addSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON auth.${t} TO auth_user;`);
  }

  override down(): void | Promise<void> {
    // Thứ tự FK ngược; DROP TABLE xoá luôn index và grant.
    for (const t of ['login_attempts', 'rate_limit', 'jwks', 'apikey', 'two_factor', 'verification', 'account', 'session', '"user"'])
      this.addSql(`DROP TABLE auth.${t};`);
  }
}
```

- [ ] **Step 5: Kiểm schema khớp và test xanh**

Run:
```bash
pnpm build && node dist/main.migrate.js up
pnpm auth:generate; cat .auth-schema/pending.sql 2>/dev/null
pnpm vitest run --project integration test/integration/identity/auth-schema.spec.ts test/integration/core/database
pnpm typecheck && pnpm lint && pnpm arch
```
Expected: `auth:generate` báo schema đã khớp theo đúng hành vi đã ghi ở S3c (không có SQL cần áp); mọi test PASS (kể cả up → down 0 → up).

- [ ] **Step 6: Commit**

```bash
git add src/modules/identity/infra/better-auth src/migrations/identity src/core/database/index.ts package.json .gitignore test/integration/identity/auth-schema.spec.ts test/integration/core/database
git commit -m "feat(identity): better auth schema in schema auth (uuidv7, constraints, event marker, lockout table) with cli config"
```

---

### Task 27: Pool `auth_user` trong DI, `IdentityDirectory`, `RegistrationLedger`, readiness `auth_database`

**Files:**
- Create: `src/modules/identity/ports/identity-directory.ts`, `src/modules/identity/ports/registration-ledger.ts`, `src/modules/identity/infra/better-auth/pg-identity-directory.ts`, `src/modules/identity/infra/better-auth/pg-registration-ledger.ts`, `src/modules/identity/infra/better-auth/auth-readiness.ts`, `src/modules/identity/infra/better-auth/auth-pool.provider.ts`, `src/modules/identity/identity-telemetry.ts`, `test/support/otel-capture.ts`
- Modify: `src/modules/identity/infra/better-auth/auth-pool.ts` (listener `'error'` — review NB1; code ở Task 26 đã có listener, task này sở hữu test runtime)
- Test: `test/integration/identity/directory-ledger.spec.ts`, `test/e2e/identity/auth-readiness.e2e.spec.ts`, `test/integration/identity/identity-telemetry.spec.ts`, `test/integration/identity/auth-pool-idle-error.spec.ts`

**Interfaces:**
- Consumes: `createAuthPool` (Task 26); `ReadinessContributor` (Task 11).
- Produces:
  - `AUTH_POOL: symbol`, `authPoolProviders: Provider[]` (pool + `AuthPoolLifecycle` đóng pool ở `onApplicationShutdown` + `AuthPoolMetrics`: gauge `identity_auth_pool_connections{state=total|idle|waiting}`, review I8).
  - `identity-telemetry.ts`: `IDENTITY_METER = 'identity'`, `IDENTITY_TRACER = 'identity'`, `identitySpan<T>(name, fn, attrsOf?)` — span con của span đang active, ghi lỗi rồi ném lại (mẫu `withRemoteParent` của SP1). Task 31/32/36/37/41 dùng.
  - `test/support/otel-capture.ts`: `installOtelCapture(): OtelCapture` (`metric(name, attrs?)`, `spanNames()`, `spans(name)`, `reset()`), gọi TRƯỚC khi tạo app vì meter được lấy lúc dựng instance (API metrics của OTel không có proxy).
  - `type DirectoryUser = { id: string; email: string; name: string; emailVerified: boolean; role: string | null; banned: boolean; banExpires: Date | null; twoFactorEnabled: boolean; createdAt: Date; updatedAt: Date }`, `abstract class IdentityDirectory { findUser(id: string): Promise<DirectoryUser | undefined>; findUserByEmail(normalizedEmail: string): Promise<DirectoryUser | undefined> }`, `isBanned(u: DirectoryUser, now: Date): boolean`, `hasAdminRole(role: string | null | undefined): boolean`.
  - `abstract class RegistrationLedger { unmarked(graceSec: number, limit: number): Promise<string[]>; mark(userIds: readonly string[]): Promise<number>; oldestUnmarkedAgeSec(): Promise<number | null> }`.
  - `AuthDatabaseReadiness` (`@ReadinessContributor('auth_database')`).

- [ ] **Step 1: Viết test fail**

`test/integration/identity/directory-ledger.spec.ts`:
```ts
import { Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authPoolProviders, AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgIdentityDirectory } from '../../../src/modules/identity/infra/better-auth/pg-identity-directory.js';
import { PgRegistrationLedger } from '../../../src/modules/identity/infra/better-auth/pg-registration-ledger.js';
import { hasAdminRole, isBanned } from '../../../src/modules/identity/ports/identity-directory.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

@Module({ providers: [...authPoolProviders, PgIdentityDirectory, PgRegistrationLedger] })
class M {}

describe('IdentityDirectory + RegistrationLedger over the auth_user pool', () => {
  let app: INestApplication; let owner: pg.Client;
  const insertUser = async (email: string, createdAgoSec = 0, role: string | null = null) =>
    (await owner.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at) VALUES ('N', $1, true, $2, now() - make_interval(secs => $3), now()) RETURNING id`,
      [email, role, createdAgoSec])).rows[0]!.id;
  beforeAll(async () => {
    app = await createTestApp([M]);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); });

  it('finds a user by id and by normalized email', async () => {
    const email = `d-${v7()}@example.test`;
    const id = await insertUser(email, 0, 'user,admin');
    const dir = app.get(PgIdentityDirectory);
    expect(await dir.findUser(id)).toMatchObject({ id, email, emailVerified: true, banned: false, twoFactorEnabled: false });
    expect((await dir.findUserByEmail(email))?.id).toBe(id);
    expect(await dir.findUser(v7())).toBeUndefined();
    expect(hasAdminRole('user,admin')).toBe(true);
    expect(hasAdminRole('administrator')).toBe(false);
    expect(hasAdminRole(null)).toBe(false);
  });
  it('isBanned honours banExpires', () => {
    const now = new Date('2026-09-27T00:00:00Z');
    const u = { id: 'x', email: 'e', name: 'n', emailVerified: true, role: null, twoFactorEnabled: false, createdAt: now, updatedAt: now };
    expect(isBanned({ ...u, banned: true, banExpires: null }, now)).toBe(true);
    expect(isBanned({ ...u, banned: true, banExpires: new Date('2026-09-28T00:00:00Z') }, now)).toBe(true);
    expect(isBanned({ ...u, banned: true, banExpires: new Date('2026-09-26T00:00:00Z') }, now)).toBe(false);
    expect(isBanned({ ...u, banned: false, banExpires: null }, now)).toBe(false);
  });
  it('ledger lists unmarked users older than the grace, marks them once, and reports the oldest age', async () => {
    const old = await insertUser(`o-${v7()}@example.test`, 600);
    const young = await insertUser(`y-${v7()}@example.test`, 0);
    const ledger = app.get(PgRegistrationLedger);
    const ids = await ledger.unmarked(300, 1000);
    expect(ids).toContain(old);
    expect(ids).not.toContain(young);
    expect(await ledger.oldestUnmarkedAgeSec()).toBeGreaterThanOrEqual(600);
    expect(await ledger.mark([old])).toBe(1);
    expect(await ledger.mark([old])).toBe(0);
    expect(await ledger.unmarked(300, 1000)).not.toContain(old);
    expect(app.get(AUTH_POOL)).toBeDefined();
  });
});
```
`test/e2e/identity/auth-readiness.e2e.spec.ts`:
```ts
import { Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { HealthModule } from '../../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { AuthDatabaseReadiness } from '../../../src/modules/identity/infra/better-auth/auth-readiness.js';
import { authPoolProviders } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { createTestApp } from '../../support/app-factory.js';

@Module({ providers: [...authPoolProviders, AuthDatabaseReadiness] })
class M {}
const make = () => createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, HttpModule, HealthModule.forRoot({ http: true }), M], { beforeInit: applyHttpDefaults });

describe('auth_database readiness', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });
  it('ready reports auth_database up', async () => {
    app = await make();
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.info).toHaveProperty('auth_database');
  });
  it('an unreachable auth pool makes the api not ready (503)', async () => {
    vi.stubEnv('DB_AUTH_PORT', '1');
    vi.stubEnv('DB_AUTH_CONNECTION_TIMEOUT_MS', '200');
    app = await make();
    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });
});
```

`test/integration/identity/auth-pool-idle-error.spec.ts` (review NB1):
```ts
import { Logger, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH_POOL, authPoolProviders } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgIdentityDirectory } from '../../../src/modules/identity/infra/better-auth/pg-identity-directory.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

@Module({ providers: [...authPoolProviders, PgIdentityDirectory] })
class M {}

describe('auth_user pool: an idle connection killed by the server never crashes the process', () => {
  let app: INestApplication; let owner: pg.Client;
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    app = await createTestApp([M]);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { process.off('uncaughtException', onUncaught); await owner?.end(); await app?.close(); });

  it('pg_terminate_backend on idle auth_user backends → logged warning, no uncaught exception, next query recovers', async () => {
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 1')]);
    expect(pool.idleCount).toBeGreaterThan(0);
    const killed = await owner.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'auth_user' AND datname = current_database() AND pid <> pg_backend_pid()`);
    expect(killed.rowCount).toBeGreaterThan(0);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'auth_pool_idle_error' }), expect.any(String)));
    expect(uncaught).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('auth_user');
    await expect(app.get(PgIdentityDirectory).findUser(v7())).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
```
(Test đi thẳng Postgres như mọi test integration của identity; khi DB auth không lên lại được, mount trả 503 — đã có test ở Task 36 `auth DB down → 503 … process stays alive`.)

`test/support/otel-capture.ts` (mẫu reader thủ công của SP1 `test/integration/core/observability/pipeline.spec.ts`):
```ts
import { metrics } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

class TestReader extends sdkMetrics.MetricReader {
  protected onShutdown(): Promise<void> { return Promise.resolve(); }
  protected onForceFlush(): Promise<void> { return Promise.resolve(); }
}
export type OtelCapture = {
  /** Tổng value của mọi datapoint khớp tên + attribute (counter/gauge); không có thì undefined. */
  metric(name: string, attrs?: Record<string, string>): Promise<number | undefined>;
  spanNames(): string[];
  spans(name: string): ReadableSpan[];
  reset(): void;
};

/** Một lần mỗi file test (global provider chỉ đặt được một lần mỗi process; Vitest cô lập theo file). */
export function installOtelCapture(): OtelCapture {
  const exporter = new InMemorySpanExporter();
  const reader = new TestReader();
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register({ contextManager: new AsyncLocalStorageContextManager().enable() });
  metrics.setGlobalMeterProvider(new sdkMetrics.MeterProvider({ readers: [reader] }));
  return {
    async metric(name, attrs = {}) {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length) throw new Error(`metric collection failed: ${errors.map(String).join('; ')}`);
      let total: number | undefined;
      for (const scope of resourceMetrics.scopeMetrics)
        for (const m of scope.metrics) {
          if (m.descriptor.name !== name) continue;
          if (m.dataPointType !== sdkMetrics.DataPointType.GAUGE && m.dataPointType !== sdkMetrics.DataPointType.SUM) throw new Error(`${name} is not a gauge or sum`);
          for (const dp of m.dataPoints)
            if (Object.entries(attrs).every(([k, v]) => dp.attributes[k] === v)) total = (total ?? 0) + dp.value;
        }
      return total;
    },
    spanNames: () => exporter.getFinishedSpans().map((s) => s.name),
    spans: (name) => exporter.getFinishedSpans().filter((s) => s.name === name),
    reset: () => exporter.reset(),
  };
}
```
`test/integration/identity/identity-telemetry.spec.ts`:
```ts
import { Module, type INestApplication } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identitySpan } from '../../../src/modules/identity/identity-telemetry.js';
import { AUTH_POOL, authPoolProviders } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
@Module({ providers: [...authPoolProviders] })
class M {}

describe('identity telemetry (review I8)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp([M]); });
  afterAll(async () => app?.close());

  it('auth pool gauges report total/idle/waiting connections', async () => {
    await app.get<pg.Pool>(AUTH_POOL).query('SELECT 1');
    expect(await otel.metric('identity_auth_pool_connections', { state: 'total' })).toBeGreaterThanOrEqual(1);
    expect(await otel.metric('identity_auth_pool_connections', { state: 'waiting' })).toBe(0);
  });
  it('identitySpan records the result attributes, and errors with ERROR status before rethrowing', async () => {
    otel.reset();
    expect(await identitySpan('identity.test', async () => 'x', (r) => ({ 'identity.result': r }))).toBe('x');
    await expect(identitySpan('identity.test', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const [ok, failed] = otel.spans('identity.test');
    expect(ok?.attributes['identity.result']).toBe('x');
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
```
(`@opentelemetry/sdk-node`, `sdk-trace-base`, `sdk-trace-node`, `context-async-hooks` đã là dependency trực tiếp của SP1.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/identity/directory-ledger.spec.ts test/e2e/identity/auth-readiness.e2e.spec.ts test/integration/identity/identity-telemetry.spec.ts test/integration/identity/auth-pool-idle-error.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/infra/better-auth/auth-pool.provider.ts`:
```ts
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleDestroy, type OnModuleInit, type Provider } from '@nestjs/common';
import { metrics, type ObservableGauge, type ObservableResult } from '@opentelemetry/api';
import type pg from 'pg';
import { IDENTITY_METER } from '../../identity-telemetry.js';
import { type ConfigOf } from '../../../../core/config/index.js';
import { databaseConfig } from '../../../../core/database/index.js';
import { authDatabaseConfig, type AuthDatabaseConfig } from '../../identity.config.js';
import { createAuthPool } from './auth-pool.js';

export const AUTH_POOL = Symbol('identity.authPool');

@Injectable()
export class AuthPoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {}
  /** Đóng sau khi HTTP/job đã dừng (onApplicationShutdown chạy sau beforeApplicationShutdown). */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

const POOL_STATES = ['total', 'idle', 'waiting'] as const;

/** Gauge của pool `auth_user` (spec §5.14): callback chỉ đọc bộ đếm trong RAM của `pg.Pool`, không I/O. */
@Injectable()
export class AuthPoolMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly gauge: ObservableGauge = metrics.getMeter(IDENTITY_METER).createObservableGauge('identity_auth_pool_connections', {
    description: 'Connections of the auth_user pool by state (waiting = callers queued for a connection)',
  });
  private readonly observe = (r: ObservableResult): void => {
    const counts = { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount } satisfies Record<(typeof POOL_STATES)[number], number>;
    for (const state of POOL_STATES) r.observe(counts[state], { state });
  };
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {}
  onModuleInit(): void {
    this.gauge.addCallback(this.observe);
  }
  onModuleDestroy(): void {
    this.gauge.removeCallback(this.observe);
  }
}

export const authPoolProviders: Provider[] = [
  {
    provide: AUTH_POOL,
    inject: [authDatabaseConfig.KEY, databaseConfig.KEY],
    useFactory: (auth: AuthDatabaseConfig, db: ConfigOf<typeof databaseConfig>) => createAuthPool(auth, db),
  },
  AuthPoolLifecycle,
  AuthPoolMetrics,
];
```
`src/modules/identity/identity-telemetry.ts`:
```ts
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

export const IDENTITY_METER = 'identity';
export const IDENTITY_TRACER = 'identity';

/**
 * Chạy `fn` trong span con của span đang active (request HTTP, job). Attribute chỉ gồm phân loại
 * (kind/result), không email/user id/token (spec §5.14). Lỗi ghi vào span rồi ném lại nguyên vẹn.
 */
export async function identitySpan<T>(name: string, fn: () => Promise<T>, attrsOf?: (result: T) => Attributes): Promise<T> {
  return trace.getTracer(IDENTITY_TRACER).startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      if (attrsOf) span.setAttributes(attrsOf(result));
      return result;
    } catch (err) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
```
`src/modules/identity/ports/identity-directory.ts`:
```ts
export type DirectoryUser = {
  id: string; email: string; name: string; emailVerified: boolean; role: string | null;
  banned: boolean; banExpires: Date | null; twoFactorEnabled: boolean; createdAt: Date; updatedAt: Date;
};

/** Cổng đọc dữ liệu identity duy nhất của app (spec §5.3): chạy trên pool `auth_user`. */
export abstract class IdentityDirectory {
  abstract findUser(id: string): Promise<DirectoryUser | undefined>;
  abstract findUserByEmail(normalizedEmail: string): Promise<DirectoryUser | undefined>;
}

/** Plugin `admin` lưu role là chuỗi, có thể nhiều role nối dấu phẩy (spec §5.16b): so khớp đúng phần tử `admin`. */
export const hasAdminRole = (role: string | null | undefined): boolean =>
  (role ?? '').split(',').map((r) => r.trim()).includes('admin');

/** `banned` và (`banExpires` NULL hoặc còn trong tương lai) — plugin api-key không tự kiểm (A.7). */
export const isBanned = (u: DirectoryUser, now: Date): boolean =>
  u.banned && (u.banExpires === null || u.banExpires.getTime() > now.getTime());
```
`src/modules/identity/ports/registration-ledger.ts`:
```ts
/** Sổ "đã phát event identity.user.registered chưa" trên chính dòng user (marker bền, spec §5.10). */
export abstract class RegistrationLedger {
  abstract unmarked(graceSec: number, limit: number): Promise<string[]>;
  abstract mark(userIds: readonly string[]): Promise<number>;
  abstract oldestUnmarkedAgeSec(): Promise<number | null>;
}
```
`src/modules/identity/infra/better-auth/pg-identity-directory.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import { IdentityDirectory, type DirectoryUser } from '../../ports/identity-directory.js';
import { AUTH_POOL } from './auth-pool.provider.js';

const Row = z.object({
  id: z.string(), email: z.string(), name: z.string(), email_verified: z.boolean(), role: z.string().nullable(),
  banned: z.boolean().nullable(), ban_expires: z.date().nullable(), two_factor_enabled: z.boolean().nullable(),
  created_at: z.date(), updated_at: z.date(),
});
const COLUMNS = 'id, email, name, email_verified, role, banned, ban_expires, two_factor_enabled, created_at, updated_at';
const toUser = (r: z.infer<typeof Row>): DirectoryUser => ({
  id: r.id, email: r.email, name: r.name, emailVerified: r.email_verified, role: r.role, banned: r.banned === true,
  banExpires: r.ban_expires, twoFactorEnabled: r.two_factor_enabled === true, createdAt: r.created_at, updatedAt: r.updated_at,
});

@Injectable()
export class PgIdentityDirectory extends IdentityDirectory {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {
    super();
  }
  async findUser(id: string): Promise<DirectoryUser | undefined> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM "user" WHERE id = $1`, [id]);
    return rows[0] ? toUser(Row.parse(rows[0])) : undefined;
  }
  async findUserByEmail(normalizedEmail: string): Promise<DirectoryUser | undefined> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM "user" WHERE email = $1`, [normalizedEmail]);
    return rows[0] ? toUser(Row.parse(rows[0])) : undefined;
  }
}
```
(`id` UUID truyền dạng chuỗi không hợp lệ → Postgres `22P02`; `findUser` chỉ được gọi với id lấy từ session/key đã xác thực.)

`src/modules/identity/infra/better-auth/pg-registration-ledger.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import { RegistrationLedger } from '../../ports/registration-ledger.js';
import { AUTH_POOL } from './auth-pool.provider.js';

const IdRow = z.object({ id: z.string() });
const AgeRow = z.object({ age: z.number().nullable() });

@Injectable()
export class PgRegistrationLedger extends RegistrationLedger {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {
    super();
  }
  /** Dùng partial index `user_unmarked_registered_idx`; không có giới hạn cửa sổ thời gian (spec §5.10). */
  async unmarked(graceSec: number, limit: number): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT id FROM "user" WHERE registered_event_emitted_at IS NULL AND created_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT $2`,
      [graceSec, limit],
    );
    return rows.map((r) => IdRow.parse(r).id);
  }
  async mark(userIds: readonly string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const res = await this.pool.query(
      `UPDATE "user" SET registered_event_emitted_at = now() WHERE id = ANY($1::uuid[]) AND registered_event_emitted_at IS NULL`,
      [userIds],
    );
    return res.rowCount ?? 0;
  }
  async oldestUnmarkedAgeSec(): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT extract(epoch FROM now() - min(created_at))::float8 AS age FROM "user" WHERE registered_event_emitted_at IS NULL`,
    );
    return AgeRow.parse(rows[0]).age;
  }
}
```
`src/modules/identity/infra/better-auth/auth-readiness.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ReadinessContributor, type ReadinessProbe } from '../../../../core/health/index.js';
import { AUTH_POOL } from './auth-pool.provider.js';

/** Pool auth chết thì mọi request cần xác thực đều hỏng (spec §5.13). Không có ở `external`. */
@Injectable()
@ReadinessContributor('auth_database')
export class AuthDatabaseReadiness implements ReadinessProbe {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {}
  async probe(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/identity test/e2e/identity && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity test/support/otel-capture.ts test/integration/identity/directory-ledger.spec.ts test/integration/identity/identity-telemetry.spec.ts test/integration/identity/auth-pool-idle-error.spec.ts test/e2e/identity/auth-readiness.e2e.spec.ts
git commit -m "feat(identity): auth_user pool, identity directory, registration ledger and auth_database readiness"
```

---

### Task 28: Mã hoá token OAuth trong `auth.account` — `withAccountCipher`

**Files:**
- Create: `src/modules/identity/infra/better-auth/account-cipher.adapter.ts`
- Test: `test/unit/modules/identity/account-cipher.spec.ts`, `test/integration/identity/account-cipher.spec.ts`

**Interfaces:**
- Consumes: `FieldCipher`, `FieldCipher.isCiphertext`, `FieldCipherError` (SP1 + Task 14); `kyselyAdapter` (Task 1); kết quả S2a, S5.
- Produces: `withAccountCipher(inner: DBAdapter, cipher: FieldCipher): DBAdapter`, `accountAad(field: AccountTokenField, providerId: string, accountId: string): string`, `ACCOUNT_TOKEN_FIELDS`, `class AccountCipherError`. Dùng ở Task 34: `database: (opts) => withAccountCipher(kyselyAdapter(db, { type: 'postgres', transaction: true })(opts), cipher)`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/account-cipher.spec.ts` (review I4: inner là `memoryAdapter` thật của better-auth — đúng kiểu `DBAdapter` generic, không adapter giả viết tay, không cast; đếm lời gọi bằng `vi.spyOn`):
```ts
import type { Where } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FieldCipher, FieldCipherError } from '../../../../src/core/security/index.js';
import { AccountCipherError, accountAad, withAccountCipher } from '../../../../src/modules/identity/infra/better-auth/account-cipher.adapter.js';

type Row = Record<string, unknown>;
const cipher = new FieldCipher({ k1: randomBytes(32).toString('base64') }, 'k1');
const setup = () => {
  const store: Record<string, Row[]> = { user: [], account: [], session: [], verification: [] };
  const inner = memoryAdapter(store)({});
  const findOne = vi.spyOn(inner, 'findOne');
  const update = vi.spyOn(inner, 'update');
  const raw = (id: unknown): Row => {
    const r = store.account?.find((x) => x.id === id);
    if (!r) throw new Error(`no account row ${String(id)}`);
    return r;
  };
  return { store, raw, findOne, update, a: withAccountCipher(inner, cipher) };
};
const byId = (id: unknown): Where[] => [{ field: 'id', value: String(id) }];
const account = (extra: Row = {}): Row => ({ providerId: 'google', accountId: 'g1', userId: 'u1', ...extra });

describe('withAccountCipher', () => {
  it('create encrypts tokens bound to providerId/accountId; reads decrypt them', async () => {
    const { raw, a } = setup();
    const created = await a.create<Row>({ model: 'account', data: account({ accessToken: 'at', refreshToken: 'rt', idToken: null }) });
    const row = raw(created.id);
    expect(FieldCipher.isCiphertext(String(row.accessToken))).toBe(true);
    expect(cipher.decrypt(String(row.refreshToken), accountAad('refreshToken', 'google', 'g1'))).toBe('rt');
    expect(row.idToken ?? null).toBeNull();
    expect(created).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(await a.findOne<Row>({ model: 'account', where: byId(created.id) })).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect((await a.findMany<Row>({ model: 'account', where: [{ field: 'userId', value: 'u1' }] }))[0]).toMatchObject({ accessToken: 'at' });
  });
  it('refresh-token rotation (update with only the token + where id) reads the row identifiers first', async () => {
    const { raw, findOne, update, a } = setup();
    const c = await a.create<Row>({ model: 'account', data: account({ refreshToken: 'rt1' }) });
    findOne.mockClear();
    update.mockClear();
    await a.update({ model: 'account', where: byId(c.id), update: { refreshToken: 'rt2' } });
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(findOne.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0] ?? 0);
    expect(cipher.decrypt(String(raw(c.id).refreshToken), accountAad('refreshToken', 'google', 'g1'))).toBe('rt2');
  });
  it('a partial update without tokens reads nothing extra', async () => {
    const { findOne, a } = setup();
    const c = await a.create<Row>({ model: 'account', data: account() });
    findOne.mockClear();
    await a.update({ model: 'account', where: byId(c.id), update: { scope: 'openid' } });
    expect(findOne).not.toHaveBeenCalled();
  });
  it('changing providerId/accountId or updating tokens by another where fails loudly', async () => {
    const { a } = setup();
    const c = await a.create<Row>({ model: 'account', data: account() });
    await expect(a.update({ model: 'account', where: byId(c.id), update: { accountId: 'b' } })).rejects.toThrow(AccountCipherError);
    await expect(a.update({ model: 'account', where: [{ field: 'userId', value: 'u1' }], update: { accessToken: 'x' } })).rejects.toThrow(AccountCipherError);
  });
  it('ciphertext copied to another row does not decrypt; plaintext in the DB fails loudly', async () => {
    const { raw, a } = setup();
    const one = await a.create<Row>({ model: 'account', data: account({ accountId: 'a1', accessToken: 'secret' }) });
    const two = await a.create<Row>({ model: 'account', data: account({ accountId: 'a2' }) });
    raw(two.id).accessToken = raw(one.id).accessToken;
    await expect(a.findOne({ model: 'account', where: byId(two.id) })).rejects.toThrow(FieldCipherError);
    raw(two.id).accessToken = 'plain';
    await expect(a.findOne({ model: 'account', where: byId(two.id) })).rejects.toThrow(FieldCipherError);
  });
  it('two consecutive updates never double-encrypt', async () => {
    const { raw, a } = setup();
    const c = await a.create<Row>({ model: 'account', data: account({ accessToken: 't1' }) });
    const enc = String(raw(c.id).accessToken);
    await a.update({ model: 'account', where: byId(c.id), update: { accessToken: enc } });
    expect(raw(c.id).accessToken).toBe(enc);
  });
  it('the adapter handed to a transaction callback is wrapped too; other models pass through', async () => {
    const { store, a } = setup();
    await a.transaction(async (trx) => {
      await trx.create({ model: 'account', data: account({ accountId: 'tx', accessToken: 'in-tx' }) });
      await trx.create({ model: 'user', data: { email: 'e@example.test', name: 'plain-name', emailVerified: false } });
    });
    expect(FieldCipher.isCiphertext(String(store.account?.find((r) => r.accountId === 'tx')?.accessToken))).toBe(true);
    expect(store.user?.find((r) => r.email === 'e@example.test')?.name).toBe('plain-name');
  });
});
```
(`memoryAdapter(db)(options)` trả `DBAdapter` đã qua factory — đối chiếu `node_modules/@better-auth/memory-adapter/dist/*.d.mts`. Factory bỏ field không có trong schema, nên test "model khác" dùng field thật của `user`.)

`test/integration/identity/account-cipher.spec.ts`

**Interfaces:**
- Consumes: `FieldCipher`, `FieldCipher.isCiphertext`, `FieldCipherError` (SP1 + Task 14); `kyselyAdapter` (Task 1); kết quả S2a, S5.
- Produces: `withAccountCipher(inner: DBAdapter, cipher: FieldCipher): DBAdapter`, `accountAad(field: AccountTokenField, providerId: string, accountId: string): string`, `ACCOUNT_TOKEN_FIELDS`, `class AccountCipherError`. Dùng ở Task 34: `database: (opts) => withAccountCipher(kyselyAdapter(db, { type: 'postgres', transaction: true })(opts), cipher)`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/account-cipher.spec.ts`:
```ts
import type { DBAdapter, DBTransactionAdapter, Where } from 'better-auth';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCipher, FieldCipherError } from '../../../../src/core/security/index.js';
import { AccountCipherError, accountAad, withAccountCipher } from '../../../../src/modules/identity/infra/better-auth/account-cipher.adapter.js';

type Row = Record<string, unknown>;
/** Adapter giả trong bộ nhớ: chỉ những gì lớp bọc dùng; mọi thao tác ghi lại để kiểm đọc thêm. */
function fakeAdapter(store: Map<string, Row>, calls: string[]): DBAdapter {
  const match = (row: Row, where: Where[] = []) => where.every((w) => row[w.field] === w.value);
  const ops: DBTransactionAdapter = {
    id: 'fake',
    create: async ({ model, data }) => { calls.push(`create:${model}`); const id = `id${store.size + 1}`; const row = { id, ...data }; store.set(id, row); return { ...row }; },
    findOne: async ({ model, where }) => { calls.push(`findOne:${model}`); const r = [...store.values()].find((x) => match(x, where)); return r ? { ...r } : null; },
    findMany: async ({ model, where }) => { calls.push(`findMany:${model}`); return [...store.values()].filter((x) => match(x, where)).map((r) => ({ ...r })); },
    update: async ({ model, where, update }) => { calls.push(`update:${model}`); const r = [...store.values()].find((x) => match(x, where)); if (!r) return null; Object.assign(r, update); return { ...r }; },
    updateMany: async ({ model, where, update }) => { calls.push(`updateMany:${model}`); const rs = [...store.values()].filter((x) => match(x, where)); rs.forEach((r) => Object.assign(r, update)); return rs.length; },
    count: async () => store.size,
    delete: async () => undefined,
    deleteMany: async () => 0,
    consumeOne: async ({ where }) => { const r = [...store.values()].find((x) => match(x, where)); if (r) store.delete(String(r.id)); return r ? { ...r } : null; },
    incrementOne: async () => null,
  };
  return { ...ops, transaction: async (cb) => { calls.push('transaction'); return cb(ops); } };
}

const cipher = new FieldCipher({ k1: randomBytes(32).toString('base64') }, 'k1');
const setup = () => {
  const store = new Map<string, Row>(); const calls: string[] = [];
  return { store, calls, a: withAccountCipher(fakeAdapter(store, calls), cipher) };
};
const byId = (id: string): Where[] => [{ field: 'id', value: id }];

describe('withAccountCipher', () => {
  it('create encrypts tokens bound to providerId/accountId; reads decrypt them', async () => {
    const { store, a } = setup();
    const created = await a.create<Row>({ model: 'account', data: { providerId: 'google', accountId: 'g1', userId: 'u1', accessToken: 'at', refreshToken: 'rt', idToken: null } });
    const raw = store.get(String(created.id))!;
    expect(FieldCipher.isCiphertext(String(raw.accessToken))).toBe(true);
    expect(cipher.decrypt(String(raw.refreshToken), accountAad('refreshToken', 'google', 'g1'))).toBe('rt');
    expect(raw.idToken).toBeNull();
    expect(await a.findOne<Row>({ model: 'account', where: byId(String(created.id)) })).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect((await a.findMany<Row>({ model: 'account', where: [{ field: 'userId', value: 'u1' }] }))[0]).toMatchObject({ accessToken: 'at' });
  });
  it('refresh-token rotation (update with only the token + where id) reads the row identifiers first', async () => {
    const { store, calls, a } = setup();
    const c = await a.create<Row>({ model: 'account', data: { providerId: 'google', accountId: 'g1', userId: 'u1', refreshToken: 'rt1' } });
    calls.length = 0;
    await a.update({ model: 'account', where: byId(String(c.id)), update: { refreshToken: 'rt2' } });
    expect(calls).toEqual(['findOne:account', 'update:account']);
    expect(cipher.decrypt(String(store.get(String(c.id))!.refreshToken), accountAad('refreshToken', 'google', 'g1'))).toBe('rt2');
  });
  it('a partial update without tokens reads nothing extra', async () => {
    const { calls, a } = setup();
    const c = await a.create<Row>({ model: 'account', data: { providerId: 'p', accountId: 'a', userId: 'u' } });
    calls.length = 0;
    await a.update({ model: 'account', where: byId(String(c.id)), update: { scope: 'openid' } });
    expect(calls).toEqual(['update:account']);
  });
  it('changing providerId/accountId or updating tokens by another where fails loudly', async () => {
    const { a } = setup();
    const c = await a.create<Row>({ model: 'account', data: { providerId: 'p', accountId: 'a', userId: 'u' } });
    await expect(a.update({ model: 'account', where: byId(String(c.id)), update: { accountId: 'b' } })).rejects.toThrow(AccountCipherError);
    await expect(a.update({ model: 'account', where: [{ field: 'userId', value: 'u' }], update: { accessToken: 'x' } })).rejects.toThrow(AccountCipherError);
  });
  it('ciphertext copied to another row does not decrypt; plaintext in the DB fails loudly', async () => {
    const { store, a } = setup();
    const one = await a.create<Row>({ model: 'account', data: { providerId: 'p', accountId: 'a1', userId: 'u', accessToken: 'secret' } });
    const two = await a.create<Row>({ model: 'account', data: { providerId: 'p', accountId: 'a2', userId: 'u' } });
    store.get(String(two.id))!.accessToken = store.get(String(one.id))!.accessToken;
    await expect(a.findOne({ model: 'account', where: byId(String(two.id)) })).rejects.toThrow(FieldCipherError);
    store.get(String(two.id))!.accessToken = 'plain';
    await expect(a.findOne({ model: 'account', where: byId(String(two.id)) })).rejects.toThrow(FieldCipherError);
  });
  it('two consecutive updates never double-encrypt', async () => {
    const { store, a } = setup();
    const c = await a.create<Row>({ model: 'account', data: { providerId: 'p', accountId: 'a', userId: 'u', accessToken: 't1' } });
    const enc = String(store.get(String(c.id))!.accessToken);
    await a.update({ model: 'account', where: byId(String(c.id)), update: { accessToken: enc } });
    expect(store.get(String(c.id))!.accessToken).toBe(enc);
  });
  it('the adapter handed to a transaction callback is wrapped too; other models pass through', async () => {
    const { store, a } = setup();
    await a.transaction(async (trx) => {
      await trx.create({ model: 'account', data: { providerId: 'p', accountId: 'tx', userId: 'u', accessToken: 'in-tx' } });
      await trx.create({ model: 'user', data: { email: 'e', accessToken: 'not-a-token-column-here' } });
    });
    const rows = [...store.values()];
    expect(FieldCipher.isCiphertext(String(rows.find((r) => r.accountId === 'tx')!.accessToken))).toBe(true);
    expect(rows.find((r) => r.email === 'e')!.accessToken).toBe('not-a-token-column-here');
  });
});
```
`test/integration/identity/account-cipher.spec.ts` (kiểm với adapter Kysely thật trên schema `auth`, bằng `auth_user`):
```ts
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { betterAuth } from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { FieldCipher } from '../../../src/core/security/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { withAccountCipher } from '../../../src/modules/identity/infra/better-auth/account-cipher.adapter.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { applyTestEnv } from '../../support/app-factory.js';

describe('withAccountCipher over the real Kysely adapter (auth_user, schema auth)', () => {
  let pool: pg.Pool; let db: Kysely<Record<string, never>>;
  const cipher = new FieldCipher({ k1: randomBytes(32).toString('base64') }, 'k1');
  beforeAll(() => {
    applyTestEnv();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    db = new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] });
  });
  afterAll(async () => { await db?.destroy(); });

  it('stores only ciphertext and returns plaintext to Better Auth', async () => {
    const auth = betterAuth({ secret: 'x'.repeat(40), baseURL: 'http://localhost:3000', advanced: { database: { generateId: 'uuid' } },
      database: (o) => withAccountCipher(kyselyAdapter(db, { type: 'postgres', transaction: true })(o), cipher) });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: `c-${v7()}@example.test`, name: 'C', emailVerified: true });
    const acct = await ctx.internalAdapter.createAccount({ userId: user.id, providerId: 'google', accountId: v7(), accessToken: 'ya29.plain', refreshToken: 'rt-plain' });
    const raw = await pool.query('SELECT access_token, refresh_token FROM account WHERE id = $1', [acct.id]);
    expect(FieldCipher.isCiphertext(raw.rows[0].access_token)).toBe(true);
    expect(JSON.stringify(raw.rows[0])).not.toContain('plain');
    await ctx.internalAdapter.updateAccount(acct.id, { refreshToken: 'rt-rotated' });
    const read = await ctx.internalAdapter.findAccounts(user.id);
    expect(read[0]).toMatchObject({ accessToken: 'ya29.plain', refreshToken: 'rt-rotated' });
  });
});
```
(Tên method của `internalAdapter` — `createUser`, `createAccount`, `updateAccount`, `findAccounts` — đối chiếu `node_modules/better-auth/dist/db/internal-adapter.d.mts`; A.6 xác nhận `updateAccount(id, data)`.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/identity/account-cipher.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/infra/better-auth/account-cipher.adapter.ts`:
```ts
import type { DBAdapter, DBTransactionAdapter, Where } from 'better-auth';
import { FieldCipher, FieldCipherError } from '../../../../core/security/index.js';

const ACCOUNT_MODEL = 'account';
export const ACCOUNT_TOKEN_FIELDS = ['accessToken', 'refreshToken', 'idToken'] as const;
export type AccountTokenField = (typeof ACCOUNT_TOKEN_FIELDS)[number];
const TOKEN_COLUMN: Record<AccountTokenField, string> = { accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token' };
const IDENTITY_FIELDS = ['providerId', 'accountId'] as const;

export class AccountCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountCipherError';
  }
}

/** AAD `auth.account:<cột>:-:<providerId>/<accountId>` (spec §5.9): định danh tự nhiên bất biến, `-` vì không thuộc org. */
export const accountAad = (field: AccountTokenField, providerId: string, accountId: string): string =>
  `auth.account:${TOKEN_COLUMN[field]}:-:${providerId}/${accountId}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === 'string' ? o[k] : undefined);
const hasToken = (o: Record<string, unknown>): boolean => ACCOUNT_TOKEN_FIELDS.some((f) => f in o);

/** Chỉ nhận `where` đúng một điều kiện `id = <chuỗi>` (A.6: `updateAccount(id, data)`); dạng khác là lỗi to. */
function idOf(where: Where[]): string {
  const [w] = where;
  if (where.length !== 1 || !w || w.field !== 'id' || (w.operator !== undefined && w.operator !== 'eq') || typeof w.value !== 'string')
    throw new AccountCipherError('auth.account token writes must target a single row by id');
  return w.value;
}

function encryptFields(cipher: FieldCipher, data: Record<string, unknown>, providerId: string, accountId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ACCOUNT_TOKEN_FIELDS) {
    const v = data[f];
    if (typeof v === 'string' && v !== '' && !FieldCipher.isCiphertext(v)) out[f] = cipher.encrypt(v, accountAad(f, providerId, accountId));
  }
  return out;
}

/** Giải mã tại chỗ (dòng mới do adapter trả, không chia sẻ); giá trị không phải bản mã thì ném lỗi, không trả plaintext lẫn lộn. */
function decryptInPlace(cipher: FieldCipher, row: unknown): void {
  if (!isRecord(row) || !hasToken(row)) return;
  const providerId = str(row, 'providerId');
  const accountId = str(row, 'accountId');
  for (const f of ACCOUNT_TOKEN_FIELDS) {
    const v = row[f];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' || !FieldCipher.isCiphertext(v)) throw new FieldCipherError(`auth.account.${TOKEN_COLUMN[f]} is not encrypted`);
    if (!providerId || !accountId) throw new AccountCipherError('reading auth.account tokens requires providerId and accountId in the selection');
    row[f] = cipher.decrypt(v, accountAad(f, providerId, accountId));
  }
}

/** Dòng của model khác có thể mang account qua `join` (S5): giải mã luôn phần đó. */
function decryptResult(cipher: FieldCipher, model: string, row: unknown): void {
  if (model === ACCOUNT_MODEL) return decryptInPlace(cipher, row);
  if (!isRecord(row)) return;
  const joined = row[ACCOUNT_MODEL];
  for (const r of Array.isArray(joined) ? joined : [joined]) decryptInPlace(cipher, r);
}

/**
 * Tham số của các method generic của `DBAdapter` (review I4). Kiểu tham số không phụ thuộc type parameter
 * (trừ `create`) nên lấy bằng `Parameters<>`; `create` viết tay vì `data: Omit<T, 'id'>`.
 */
type CreateArgs<T> = { model: string; data: Omit<T, 'id'>; select?: string[] | undefined; forceAllowId?: boolean | undefined };
type FindOneArgs = Parameters<DBTransactionAdapter['findOne']>[0];
type FindManyArgs = Parameters<DBTransactionAdapter['findMany']>[0];
type UpdateArgs = Parameters<DBTransactionAdapter['update']>[0];
type UpdateManyArgs = Parameters<DBTransactionAdapter['updateMany']>[0];
type ConsumeOneArgs = Parameters<DBTransactionAdapter['consumeOne']>[0];

function wrapOps(inner: DBTransactionAdapter, cipher: FieldCipher): DBTransactionAdapter {
  const withIds = async (where: Where[], update: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (IDENTITY_FIELDS.some((f) => f in update)) throw new AccountCipherError('providerId/accountId of auth.account are immutable');
    if (!hasToken(update)) return update;
    const id = idOf(where);
    const current = await inner.findOne<Record<string, unknown>>({ model: ACCOUNT_MODEL, where: [{ field: 'id', value: id }] });
    const providerId = current ? str(current, 'providerId') : undefined;
    const accountId = current ? str(current, 'accountId') : undefined;
    if (!providerId || !accountId) throw new AccountCipherError('auth.account row to update was not found');
    return { ...update, ...encryptFields(cipher, update, providerId, accountId) };
  };
  // Pass-through generic tường minh: lambda không generic không gán được vào `DBAdapter` (review I4).
  return {
    ...inner,
    create: async <T extends Record<string, unknown>, R = T>(d: CreateArgs<T>): Promise<R> => {
      if (d.model !== ACCOUNT_MODEL) return inner.create<T, R>(d);
      const data: Record<string, unknown> = { ...d.data };
      const providerId = str(data, 'providerId');
      const accountId = str(data, 'accountId');
      if (hasToken(data) && (!providerId || !accountId)) throw new AccountCipherError('auth.account create needs providerId and accountId');
      const encrypted = providerId && accountId ? encryptFields(cipher, data, providerId, accountId) : {};
      const created = await inner.create<T, R>({ ...d, data: { ...d.data, ...encrypted } });
      decryptInPlace(cipher, created);
      return created;
    },
    update: async <T>(d: UpdateArgs): Promise<T | null> => {
      if (d.model !== ACCOUNT_MODEL) return inner.update<T>(d);
      const updated = await inner.update<T>({ ...d, update: await withIds(d.where, d.update) });
      decryptInPlace(cipher, updated);
      return updated;
    },
    updateMany: async (d: UpdateManyArgs): Promise<number> =>
      d.model !== ACCOUNT_MODEL ? inner.updateMany(d) : inner.updateMany({ ...d, update: await withIds(d.where, d.update) }),
    findOne: async <T>(d: FindOneArgs): Promise<T | null> => {
      const row = await inner.findOne<T>(d);
      decryptResult(cipher, d.model, row);
      return row;
    },
    findMany: async <T>(d: FindManyArgs): Promise<T[]> => {
      const rows = await inner.findMany<T>(d);
      for (const r of rows) decryptResult(cipher, d.model, r);
      return rows;
    },
    consumeOne: async <T>(d: ConsumeOneArgs): Promise<T | null> => {
      const row = await inner.consumeOne<T>(d);
      decryptResult(cipher, d.model, row);
      return row;
    },
  };
}

/**
 * Bọc DBAdapter của Better Auth (spec §5.9, D4): chỉ can thiệp model `account`, bọc cả adapter trong
 * `transaction(cb)`. Không dùng `databaseHooks` vì `account.update.before` không có `where`/id (A.6).
 */
export function withAccountCipher(inner: DBAdapter, cipher: FieldCipher): DBAdapter {
  return {
    ...wrapOps(inner, cipher),
    transaction: <R>(cb: (trx: DBTransactionAdapter) => Promise<R>): Promise<R> => inner.transaction<R>((trx) => cb(wrapOps(trx, cipher))),
  };
}
```
`decryptInPlace` sửa object do adapter vừa trả (kiểu `T`/`R` của caller) qua tham số `unknown` + type guard, không cast. Nếu S5 cho thấy Better Auth gọi thêm thao tác khác trên `account` (vd. `incrementOne`) thì bọc thêm theo cùng mẫu; nếu S2a/S5 chọn fallback plugin Kysely thì file này thay bằng `AccountCipherPlugin implements KyselyPlugin` với cùng hàm `accountAad`/`encryptFields`/`decryptInPlace` và cùng bộ test (đổi phần dựng adapter).

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/identity/account-cipher.spec.ts && pnpm vitest run --project integration test/integration/identity/account-cipher.spec.ts && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity/infra/better-auth/account-cipher.adapter.ts test/unit/modules/identity/account-cipher.spec.ts test/integration/identity/account-cipher.spec.ts
git commit -m "feat(identity): encrypt OAuth tokens in auth.account through a wrapped DB adapter"
```

---

### Task 29: Mã lỗi identity và map lỗi của Better Auth

**Files:**
- Create: `src/modules/identity/errors.ts`, `src/modules/identity/infra/better-auth/auth-error.mapper.ts`
- Test: `test/unit/modules/identity/auth-error.mapper.spec.ts`

**Interfaces:**
- Consumes: `defineErrorCodes`, `AppError`, `CoreErrors`, `PG` (SP1); `BASE_ERROR_CODES` (`better-auth`), `TWO_FACTOR_ERROR_CODES` (`better-auth/plugins`), `API_KEY_ERROR_CODES` (`@better-auth/api-key`), `admin().$ERROR_CODES`, `genericOAuth(...).$ERROR_CODES`.
- Produces:
  - `IdentityErrors` (`INVALID_CREDENTIALS` 401, `INVALID_TWO_FACTOR_CODE` 401, `EMAIL_NOT_VERIFIED` 403, `ACCOUNT_DISABLED` 403, `REAUTHENTICATION_REQUIRED` 403, `ORIGIN_NOT_ALLOWED` 403, `AMBIGUOUS_CREDENTIALS` 400, `INVALID_OR_EXPIRED_TOKEN` 400, `EMAIL_TAKEN` 409) (`identity/errors.ts`).
  - `AUTH_CODE_MAP: Readonly<Record<string, ErrorCode>>`, `AUTH_CODES_BY_STATUS: readonly string[]`, `mapAuthError(input: { status: number; code?: string; retryAfter?: string | null }, opts: { unavailableRetryAfterSec: number }): AppError`, `isAuthInfraError(err: unknown): boolean`, `authUnavailable(retryAfterSec: number): AppError`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/auth-error.mapper.spec.ts`:
```ts
import { API_KEY_ERROR_CODES } from '@better-auth/api-key';
import { BASE_ERROR_CODES } from 'better-auth';
import { TWO_FACTOR_ERROR_CODES, admin, genericOAuth } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';
import { AUTH_CODES_BY_STATUS, AUTH_CODE_MAP, isAuthInfraError, mapAuthError } from '../../../../src/modules/identity/infra/better-auth/auth-error.mapper.js';

const allCodes = [
  ...Object.keys(BASE_ERROR_CODES), ...Object.keys(TWO_FACTOR_ERROR_CODES), ...Object.keys(API_KEY_ERROR_CODES),
  ...Object.keys(admin().$ERROR_CODES), ...Object.keys(genericOAuth({ config: [] }).$ERROR_CODES),
];
const opts = { unavailableRetryAfterSec: 7 };

describe('mapAuthError', () => {
  it('every Better Auth code of every enabled plugin has an explicit decision', () => {
    const decided = new Set([...Object.keys(AUTH_CODE_MAP), ...AUTH_CODES_BY_STATUS]);
    expect([...new Set(allCodes)].filter((c) => !decided.has(c))).toEqual([]);
    expect(Object.keys(AUTH_CODE_MAP).filter((c) => AUTH_CODES_BY_STATUS.includes(c))).toEqual([]);
  });
  it.each([
    ['INVALID_EMAIL_OR_PASSWORD', 401, 'invalid_credentials'],
    ['USER_NOT_FOUND', 401, 'invalid_credentials'],
    ['EMAIL_NOT_VERIFIED', 403, 'email_not_verified'],
    ['BANNED_USER', 403, 'account_disabled'],
    ['SESSION_NOT_FRESH', 403, 'reauthentication_required'],
    ['INVALID_ORIGIN', 403, 'origin_not_allowed'],
    ['INVALID_TOKEN', 400, 'invalid_or_expired_token'],
    ['TOKEN_EXPIRED', 400, 'invalid_or_expired_token'],
    ['INVALID_CODE', 401, 'invalid_two_factor_code'],
    ['INVALID_BACKUP_CODE', 401, 'invalid_two_factor_code'],
    ['USER_ALREADY_EXISTS', 409, 'email_taken'],
    ['INVALID_CALLBACK_URL', 422, 'validation_failed'],
    ['PASSWORD_TOO_SHORT', 422, 'validation_failed'],
  ])('%s → %s %s', (code, status, ours) => {
    const e = mapAuthError({ status: 400, code }, opts);
    expect({ status: e.error.status, code: e.error.code }).toEqual({ status, code: ours });
  });
  it('validation errors carry the field path, never Better Auth messages', () => {
    const e = mapAuthError({ status: 400, code: 'PASSWORD_TOO_SHORT' }, opts);
    expect(e.opts.fields).toEqual([{ path: 'password', code: 'password_too_short', message: 'Password is too short' }]);
    expect(e.opts.detail).toBeUndefined();
  });
  it('429 keeps Retry-After from X-Retry-After', () => {
    const e = mapAuthError({ status: 429, code: undefined, retryAfter: '42' }, opts);
    expect(e.error.code).toBe('rate_limited');
    expect(e.opts.headers).toEqual({ 'Retry-After': '42' });
  });
  it('status fallback for codes without a specific mapping, and for unknown codes', () => {
    expect(mapAuthError({ status: 403, code: 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS' }, opts).error.code).toBe('forbidden');
    expect(mapAuthError({ status: 404, code: 'SOMETHING_NEW' }, opts).error.code).toBe('not_found');
    expect(mapAuthError({ status: 500, code: undefined }, opts).error.code).toBe('internal_error');
  });
  it.each([
    [{ code: '08006' }, true], [{ code: '53300' }, true], [{ code: '57P01' }, true], [{ code: '57014' }, true],
    [{ code: '40001' }, true], [new Error('timeout exceeded when trying to connect'), true],
    [{ code: '23505' }, false], [new Error('boom'), false],
  ])('isAuthInfraError(%j) → %s', (err, want) => expect(isAuthInfraError(err)).toBe(want));
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/identity/auth-error.mapper.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/errors.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import { defineErrorCodes } from '../../core/errors/index.js';

export const IdentityErrors = defineErrorCodes({
  INVALID_CREDENTIALS: { status: HttpStatus.UNAUTHORIZED, title: 'Invalid email or password' },
  INVALID_TWO_FACTOR_CODE: { status: HttpStatus.UNAUTHORIZED, title: 'Invalid two-factor code' },
  EMAIL_NOT_VERIFIED: { status: HttpStatus.FORBIDDEN, title: 'Email address is not verified' },
  ACCOUNT_DISABLED: { status: HttpStatus.FORBIDDEN, title: 'Account is disabled' },
  REAUTHENTICATION_REQUIRED: { status: HttpStatus.FORBIDDEN, title: 'Sign in again to continue' },
  ORIGIN_NOT_ALLOWED: { status: HttpStatus.FORBIDDEN, title: 'Request origin is not allowed' },
  AMBIGUOUS_CREDENTIALS: { status: HttpStatus.BAD_REQUEST, title: 'Request carries more than one credential' },
  INVALID_OR_EXPIRED_TOKEN: { status: HttpStatus.BAD_REQUEST, title: 'Link is invalid, expired or already used' },
  EMAIL_TAKEN: { status: HttpStatus.CONFLICT, title: 'Email address is already in use' },
});
```
`src/modules/identity/infra/better-auth/auth-error.mapper.ts`:
```ts
import { HttpStatus } from '@nestjs/common';
import { AppError, CoreErrors, type ErrorCode, type FieldError } from '../../../../core/errors/index.js';
import { IdentityErrors } from '../../errors.js';

/** Mã của Better Auth + plugin đang bật → mã của mình (spec §5.5 quy tắc 1). */
export const AUTH_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  INVALID_EMAIL_OR_PASSWORD: IdentityErrors.INVALID_CREDENTIALS,
  INVALID_PASSWORD: IdentityErrors.INVALID_CREDENTIALS,
  USER_NOT_FOUND: IdentityErrors.INVALID_CREDENTIALS,
  CREDENTIAL_ACCOUNT_NOT_FOUND: IdentityErrors.INVALID_CREDENTIALS,
  INVALID_USER: IdentityErrors.INVALID_CREDENTIALS,
  EMAIL_NOT_VERIFIED: IdentityErrors.EMAIL_NOT_VERIFIED,
  BANNED_USER: IdentityErrors.ACCOUNT_DISABLED,
  USER_BANNED: IdentityErrors.ACCOUNT_DISABLED,
  SESSION_NOT_FRESH: IdentityErrors.REAUTHENTICATION_REQUIRED,
  INVALID_ORIGIN: IdentityErrors.ORIGIN_NOT_ALLOWED,
  MISSING_OR_NULL_ORIGIN: IdentityErrors.ORIGIN_NOT_ALLOWED,
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: IdentityErrors.ORIGIN_NOT_ALLOWED,
  INVALID_TOKEN: IdentityErrors.INVALID_OR_EXPIRED_TOKEN,
  TOKEN_EXPIRED: IdentityErrors.INVALID_OR_EXPIRED_TOKEN,
  INVALID_CODE: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  INVALID_BACKUP_CODE: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  OTP_HAS_EXPIRED: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  INVALID_TWO_FACTOR_COOKIE: IdentityErrors.INVALID_TWO_FACTOR_CODE,
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: CoreErrors.RATE_LIMITED,
  ACCOUNT_TEMPORARILY_LOCKED: CoreErrors.RATE_LIMITED,
  RATE_LIMIT_EXCEEDED: CoreErrors.RATE_LIMITED,
  USAGE_EXCEEDED: CoreErrors.RATE_LIMITED,
  USER_ALREADY_EXISTS: IdentityErrors.EMAIL_TAKEN,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: IdentityErrors.EMAIL_TAKEN,
  SESSION_EXPIRED: CoreErrors.UNAUTHENTICATED,
  KEY_NOT_FOUND: CoreErrors.UNAUTHENTICATED,
  KEY_DISABLED: CoreErrors.UNAUTHENTICATED,
  KEY_EXPIRED: CoreErrors.UNAUTHENTICATED,
  INVALID_API_KEY: CoreErrors.UNAUTHENTICATED,
  UNAUTHORIZED_SESSION: CoreErrors.UNAUTHENTICATED,
  PASSWORD_TOO_SHORT: CoreErrors.VALIDATION_FAILED,
  PASSWORD_TOO_LONG: CoreErrors.VALIDATION_FAILED,
  INVALID_EMAIL: CoreErrors.VALIDATION_FAILED,
  VALIDATION_ERROR: CoreErrors.VALIDATION_FAILED,
  MISSING_FIELD: CoreErrors.VALIDATION_FAILED,
  FIELD_NOT_ALLOWED: CoreErrors.VALIDATION_FAILED,
  BODY_MUST_BE_AN_OBJECT: CoreErrors.VALIDATION_FAILED,
  INVALID_CALLBACK_URL: CoreErrors.VALIDATION_FAILED,
  INVALID_REDIRECT_URL: CoreErrors.VALIDATION_FAILED,
  INVALID_ERROR_CALLBACK_URL: CoreErrors.VALIDATION_FAILED,
  INVALID_NEW_USER_CALLBACK_URL: CoreErrors.VALIDATION_FAILED,
  CALLBACK_URL_REQUIRED: CoreErrors.VALIDATION_FAILED,
  INVALID_METADATA_TYPE: CoreErrors.VALIDATION_FAILED,
  EXPIRES_IN_IS_TOO_SMALL: CoreErrors.VALIDATION_FAILED,
  EXPIRES_IN_IS_TOO_LARGE: CoreErrors.VALIDATION_FAILED,
  INVALID_PREFIX_LENGTH: CoreErrors.VALIDATION_FAILED,
  INVALID_NAME_LENGTH: CoreErrors.VALIDATION_FAILED,
  NAME_REQUIRED: CoreErrors.VALIDATION_FAILED,
  INVALID_ROLE_TYPE: CoreErrors.VALIDATION_FAILED,
};

/** Quyết định tường minh: map theo status của Better Auth (spec §5.5 quy tắc 5). */
export const AUTH_CODES_BY_STATUS: readonly string[] = [
  'FAILED_TO_CREATE_USER', 'FAILED_TO_CREATE_SESSION', 'FAILED_TO_UPDATE_USER', 'FAILED_TO_GET_SESSION',
  'SOCIAL_ACCOUNT_ALREADY_LINKED', 'PROVIDER_NOT_FOUND', 'ID_TOKEN_NOT_SUPPORTED', 'FAILED_TO_GET_USER_INFO',
  'USER_EMAIL_NOT_FOUND', 'EMAIL_CAN_NOT_BE_UPDATED', 'CHANGE_EMAIL_DISABLED', 'ACCOUNT_NOT_FOUND',
  'FAILED_TO_UNLINK_LAST_ACCOUNT', 'USER_ALREADY_HAS_PASSWORD', 'VERIFICATION_EMAIL_NOT_ENABLED', 'EMAIL_ALREADY_VERIFIED',
  'EMAIL_MISMATCH', 'LINKED_ACCOUNT_ALREADY_EXISTS', 'FAILED_TO_CREATE_VERIFICATION', 'ASYNC_VALIDATION_NOT_SUPPORTED',
  'METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED', 'PASSWORD_ALREADY_SET',
  'OTP_NOT_ENABLED', 'OTP_NOT_CONFIGURED', 'TOTP_NOT_ENABLED', 'TOTP_ALREADY_ENABLED', 'TOTP_NOT_CONFIGURED',
  'TWO_FACTOR_NOT_ENABLED', 'BACKUP_CODES_NOT_ENABLED',
  'REFILL_AMOUNT_AND_INTERVAL_REQUIRED', 'REFILL_INTERVAL_AND_AMOUNT_REQUIRED', 'KEY_NOT_RECOVERABLE', 'INVALID_REMAINING',
  'METADATA_DISABLED', 'NO_VALUES_TO_UPDATE', 'KEY_DISABLED_EXPIRATION', 'INVALID_USER_ID_FROM_API_KEY',
  'INVALID_REFERENCE_ID_FROM_API_KEY', 'INVALID_API_KEY_GETTER_RETURN_TYPE', 'SERVER_ONLY_PROPERTY', 'FAILED_TO_UPDATE_API_KEY',
  'ORGANIZATION_ID_REQUIRED', 'USER_NOT_MEMBER_OF_ORGANIZATION', 'INSUFFICIENT_API_KEY_PERMISSIONS',
  'NO_DEFAULT_API_KEY_CONFIGURATION_FOUND', 'ORGANIZATION_PLUGIN_REQUIRED',
  'YOU_CANNOT_BAN_YOURSELF', 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE', 'YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS', 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS_SESSIONS', 'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS', 'YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS', 'YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS',
  'YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD', 'YOU_ARE_NOT_ALLOWED_TO_GET_USER', 'NO_DATA_TO_UPDATE',
  'YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS', 'YOU_CANNOT_REMOVE_YOURSELF', 'YOU_ARE_NOT_ALLOWED_TO_SET_NON_EXISTENT_VALUE',
  'YOU_CANNOT_IMPERSONATE_ADMINS', 'YOU_ARE_NOT_ALLOWED_TO_SET_USERS_EMAIL', 'PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER',
  'INVALID_OAUTH_CONFIGURATION', 'TOKEN_URL_NOT_FOUND',
];

const BY_STATUS: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: CoreErrors.MALFORMED_REQUEST,
  [HttpStatus.UNAUTHORIZED]: CoreErrors.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: CoreErrors.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: CoreErrors.NOT_FOUND,
  [HttpStatus.CONFLICT]: CoreErrors.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: CoreErrors.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: CoreErrors.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: CoreErrors.SERVICE_UNAVAILABLE,
};
/** Trường bị lỗi (spec §5.5 quy tắc 2); message cố định của mình, không chép message của Better Auth (quy tắc 6). */
const FIELD_OF: Readonly<Record<string, { path: string; message: string }>> = {
  PASSWORD_TOO_SHORT: { path: 'password', message: 'Password is too short' },
  PASSWORD_TOO_LONG: { path: 'password', message: 'Password is too long' },
  INVALID_EMAIL: { path: 'email', message: 'Email address is invalid' },
  INVALID_CALLBACK_URL: { path: 'callbackURL', message: 'URL is not a trusted origin' },
  INVALID_ERROR_CALLBACK_URL: { path: 'errorCallbackURL', message: 'URL is not a trusted origin' },
  INVALID_NEW_USER_CALLBACK_URL: { path: 'newUserCallbackURL', message: 'URL is not a trusted origin' },
  INVALID_REDIRECT_URL: { path: 'redirectTo', message: 'URL is not a trusted origin' },
  CALLBACK_URL_REQUIRED: { path: 'callbackURL', message: 'Required' },
};

export const authUnavailable = (retryAfterSec: number): AppError =>
  new AppError(CoreErrors.SERVICE_UNAVAILABLE, { headers: { 'Retry-After': String(retryAfterSec) }, expected: true });

export function mapAuthError(input: { status: number; code?: string; retryAfter?: string | null }, opts: { unavailableRetryAfterSec: number }): AppError {
  if (input.status === HttpStatus.TOO_MANY_REQUESTS)
    return new AppError(CoreErrors.RATE_LIMITED, input.retryAfter ? { headers: { 'Retry-After': input.retryAfter } } : {});
  if (input.status === HttpStatus.SERVICE_UNAVAILABLE) return authUnavailable(opts.unavailableRetryAfterSec);
  const mapped = input.code ? AUTH_CODE_MAP[input.code] : undefined;
  if (mapped) {
    const field = input.code ? FIELD_OF[input.code] : undefined;
    const fields: FieldError[] | undefined = field && input.code ? [{ path: field.path, code: input.code.toLowerCase(), message: field.message }] : undefined;
    return new AppError(mapped, fields ? { fields } : {});
  }
  return new AppError(BY_STATUS[input.status] ?? CoreErrors.INTERNAL_ERROR);
}

/** Lỗi hạ tầng của pool auth (spec §5.5 quy tắc 4) → 503, không bao giờ 500. */
const INFRA_SQLSTATE = /^(08|53)|^57P0[123]$|^57014$|^40001$|^40P01$/;
const POOL_TIMEOUT = 'timeout exceeded when trying to connect';
export function isAuthInfraError(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    const code = typeof cur === 'object' && cur !== null && 'code' in cur ? cur.code : undefined;
    if (typeof code === 'string' && INFRA_SQLSTATE.test(code)) return true;
    if (cur instanceof Error && cur.message.includes(POOL_TIMEOUT)) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/identity && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS. Nếu test "every code has an explicit decision" liệt kê mã mới (plugin đổi ở bản vá), phân loại mã đó theo spec §5.5 và thêm vào một trong hai danh sách.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity/errors.ts src/modules/identity/infra/better-auth/auth-error.mapper.ts test/unit/modules/identity/auth-error.mapper.spec.ts
git commit -m "feat(identity): error codes and exhaustive better auth error mapping (no upstream messages)"
```

---

### Task 30: Nhận diện credential, luật đa nguồn/trùng lặp, kiểm CSRF (hàm thuần)

**Files:**
- Create: `src/modules/identity/http/credential-detector.ts`, `src/modules/identity/http/origin-check.ts`
- Test: `test/unit/modules/identity/credential-detector.spec.ts`, `test/unit/modules/identity/origin-check.spec.ts`

**Interfaces:**
- Consumes: `CredentialKind` (Task 8); `AuthMode`, `effectiveCookiePrefix` (Task 25); tên cookie thật ở S1e.
- Produces:
  - `type DetectedCredential = { kind: CredentialKind; value: string; cookieName?: string }`.
  - `type DetectionConfig = { mode: AuthMode; cookiePrefix: string; apiKeyHeader: string; externalTokenCookie?: string }`, `detectionConfigOf(identity: IdentityConfig, app: { serviceName: string }): DetectionConfig`.
  - `type Detection = { ok: true; credentials: DetectedCredential[]; hasAuthCookie: boolean } | { ok: false; reason: string }`, `detectCredentials(rawHeaders: readonly string[], cfg: DetectionConfig, opts?: { allowCookieWithBearer?: boolean }): Detection`.
  - `sessionCookieNames(prefix): [string, string]` (`<prefix>.session_token`, `__Secure-<prefix>.session_token`), `twoFactorCookieNames(prefix)`.
  - `UNSAFE_METHODS`, `trustedOriginList(corsOrigins: readonly string[], baseUrl: string | undefined): string[]`, `csrfAllows(input: { method: string; origin?: string; secFetchSite?: string }, trusted: ReadonlySet<string>): boolean`, `isCookieCredential(kind: CredentialKind): boolean`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/credential-detector.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { detectCredentials, type DetectionConfig } from '../../../../src/modules/identity/http/credential-detector.js';

const local: DetectionConfig = { mode: 'local', cookiePrefix: 'app', apiKeyHeader: 'x-api-key' };
const external: DetectionConfig = { mode: 'external', cookiePrefix: 'app', apiKeyHeader: 'x-api-key', externalTokenCookie: 'idp_token' };
const raw = (...pairs: [string, string][]) => pairs.flat();

describe('detectCredentials', () => {
  it('no credential → anonymous; unrelated cookies are ignored', () => {
    expect(detectCredentials(raw(['Cookie', 'theme=dark; app.state=x']), local)).toEqual({ ok: true, credentials: [], hasAuthCookie: true });
    expect(detectCredentials(raw(['Accept', '*/*']), local)).toEqual({ ok: true, credentials: [], hasAuthCookie: false });
  });
  it.each([
    ['session cookie', raw(['Cookie', 'app.session_token=s1']), 'SESSION_COOKIE', 's1'],
    ['secure session cookie', raw(['Cookie', '__Secure-app.session_token=s2']), 'SESSION_COOKIE', 's2'],
    ['bearer', raw(['Authorization', 'Bearer t1']), 'BEARER_SESSION', 't1'],
    ['api key', raw(['X-Api-Key', 'k1']), 'API_KEY', 'k1'],
  ])('%s', (_n, headers, kind, value) => {
    const d = detectCredentials(headers, local);
    expect(d).toMatchObject({ ok: true, credentials: [{ kind, value }] });
  });
  it.each([
    ['two Authorization headers', raw(['Authorization', 'Bearer a'], ['authorization', 'Bearer b'])],
    ['two API key headers', raw(['x-api-key', 'a'], ['X-API-KEY', 'b'])],
    ['an API key list', raw(['x-api-key', 'a, b'])],
    ['two Cookie headers carrying counted cookies', raw(['Cookie', 'app.session_token=a'], ['Cookie', 'app.two_factor=b'])],
    ['the same session cookie twice', raw(['Cookie', 'app.session_token=a; app.session_token=b'])],
    ['__Secure- and plain session cookie together', raw(['Cookie', '__Secure-app.session_token=a; app.session_token=b'])],
    ['two_factor cookie twice', raw(['Cookie', 'app.two_factor=a; app.two_factor=b'])],
    ['malformed Authorization', raw(['Authorization', 'Basic dXNlcjpw'])],
    ['empty bearer token', raw(['Authorization', 'Bearer '])],
    ['cookie + bearer', raw(['Cookie', 'app.session_token=a'], ['Authorization', 'Bearer b'])],
    ['bearer + api key', raw(['Authorization', 'Bearer b'], ['x-api-key', 'k'])],
  ])('%s → ambiguous', (_n, headers) => {
    expect(detectCredentials(headers, local).ok).toBe(false);
  });
  it('sign-out may carry cookie + bearer (and nothing else)', () => {
    const d = detectCredentials(raw(['Cookie', 'app.session_token=a'], ['Authorization', 'Bearer b']), local, { allowCookieWithBearer: true });
    expect(d).toMatchObject({ ok: true, credentials: [{ kind: 'SESSION_COOKIE' }, { kind: 'BEARER_SESSION' }] });
    expect(detectCredentials(raw(['Cookie', 'app.session_token=a'], ['x-api-key', 'k']), local, { allowCookieWithBearer: true }).ok).toBe(false);
  });
  it('external: header + cookie together → ambiguous; cookie alone → EXTERNAL_COOKIE', () => {
    expect(detectCredentials(raw(['Cookie', 'idp_token=j'], ['Authorization', 'Bearer j']), external).ok).toBe(false);
    expect(detectCredentials(raw(['Cookie', 'idp_token=j']), external)).toMatchObject({ ok: true, credentials: [{ kind: 'EXTERNAL_COOKIE', value: 'j' }], hasAuthCookie: true });
    expect(detectCredentials(raw(['Authorization', 'Bearer j']), external)).toMatchObject({ ok: true, credentials: [{ kind: 'EXTERNAL_BEARER' }] });
  });
  it('empty or blank credentials are present-but-invalid, never anonymous', () => {
    expect(detectCredentials(raw(['x-api-key', '']), local)).toMatchObject({ ok: true, credentials: [{ kind: 'API_KEY', value: '' }] });
    expect(detectCredentials(raw(['x-api-key', '   ']), local)).toMatchObject({ ok: true, credentials: [{ kind: 'API_KEY', value: '' }] });
    expect(detectCredentials(raw(['Cookie', 'app.session_token=']), local)).toMatchObject({ ok: true, credentials: [{ kind: 'SESSION_COOKIE', value: '' }] });
    expect(detectCredentials(raw(['Authorization', 'Bearer    ']), local).ok).toBe(false);
  });
});
```
`test/unit/modules/identity/origin-check.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { csrfAllows, trustedOriginList } from '../../../../src/modules/identity/http/origin-check.js';

const trusted = new Set(trustedOriginList(['https://app.example.test'], 'https://api.example.test'));

describe('CSRF for cookie-authenticated requests (spec §5.6.2)', () => {
  it('trusts CORS origins plus the base URL origin', () => {
    expect([...trusted].sort()).toEqual(['https://api.example.test', 'https://app.example.test']);
  });
  it.each([
    [{ method: 'POST', origin: 'https://app.example.test' }, true],
    [{ method: 'POST', secFetchSite: 'same-origin' }, true],
    [{ method: 'POST' }, false],
    [{ method: 'POST', origin: 'https://evil.test' }, false],
    [{ method: 'POST', origin: 'https://other.example.test' }, false],
    [{ method: 'POST', secFetchSite: 'same-site' }, false],
    [{ method: 'POST', origin: 'null', secFetchSite: 'same-origin' }, false],
    [{ method: 'DELETE', origin: 'https://evil.test' }, false],
    [{ method: 'GET', origin: 'https://evil.test' }, true],
    [{ method: 'HEAD' }, true],
  ])('%j → %s', (input, allowed) => expect(csrfAllows(input, trusted)).toBe(allowed));
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/identity/credential-detector.spec.ts test/unit/modules/identity/origin-check.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/http/credential-detector.ts`:
```ts
import type { CredentialKind } from '../../../core/context/index.js';
import { effectiveCookiePrefix, type AuthMode, type IdentityConfig } from '../identity.config.js';

export type DetectedCredential = { kind: CredentialKind; value: string; cookieName?: string };
export type DetectionConfig = { mode: AuthMode; cookiePrefix: string; apiKeyHeader: string; externalTokenCookie?: string };
export type Detection =
  | { ok: true; credentials: DetectedCredential[]; hasAuthCookie: boolean }
  | { ok: false; reason: string };

const SECURE_PREFIX = '__Secure-';
/** Tên cookie thật của Better Auth (chốt ở spike S1e). */
export const sessionCookieNames = (prefix: string): [string, string] => [`${prefix}.session_token`, `${SECURE_PREFIX}${prefix}.session_token`];
export const twoFactorCookieNames = (prefix: string): [string, string] => [`${prefix}.two_factor`, `${SECURE_PREFIX}${prefix}.two_factor`];
const BEARER = /^Bearer ([^\s]+)$/;

export const detectionConfigOf = (id: IdentityConfig, app: { serviceName: string }): DetectionConfig => ({
  mode: id.mode, cookiePrefix: effectiveCookiePrefix(id, app), apiKeyHeader: id.apiKeyHeader, externalTokenCookie: id.externalTokenCookie,
});

type Cookie = { name: string; value: string };
const parseCookieHeader = (v: string): Cookie[] =>
  v.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? { name: p, value: '' } : { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
  });

/**
 * Nhận diện credential trên `rawHeaders` (A.18: `req.headers` bỏ bản trùng của `authorization` và nối
 * `cookie`), trước mọi chuẩn hoá. Có nhiều hơn một credential hoặc dữ liệu trùng → từ chối, không chọn
 * cái đầu tiên (spec §5.6.1: confused deputy, thứ tự ngầm của plugin bearer và `getSessionCookie`).
 */
export function detectCredentials(rawHeaders: readonly string[], cfg: DetectionConfig, opts: { allowCookieWithBearer?: boolean } = {}): Detection {
  const authz: string[] = [];
  const apiKeys: string[] = [];
  const cookieHeaders: Cookie[][] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    const value = rawHeaders[i + 1]!;
    if (name === 'authorization') authz.push(value);
    else if (name === cfg.apiKeyHeader) apiKeys.push(value);
    else if (name === 'cookie') cookieHeaders.push(parseCookieHeader(value));
  }
  const [session, secureSession] = sessionCookieNames(cfg.cookiePrefix);
  const twoFactor = twoFactorCookieNames(cfg.cookiePrefix);
  const counted = new Set(cfg.mode === 'external'
    ? (cfg.externalTokenCookie ? [cfg.externalTokenCookie] : [])
    : [session, secureSession, ...twoFactor]);
  const authPrefixes = [`${cfg.cookiePrefix}.`, `${SECURE_PREFIX}${cfg.cookiePrefix}.`];

  if (authz.length > 1) return { ok: false, reason: 'multiple Authorization headers' };
  if (apiKeys.length > 1 || apiKeys.some((k) => k.includes(','))) return { ok: false, reason: 'multiple API keys' };
  if (cookieHeaders.filter((cs) => cs.some((c) => counted.has(c.name))).length > 1) return { ok: false, reason: 'multiple Cookie headers with credentials' };
  const cookies = cookieHeaders.flat();
  const seen = new Set<string>();
  for (const c of cookies.filter((c) => counted.has(c.name))) {
    if (seen.has(c.name)) return { ok: false, reason: `duplicate cookie ${c.name}` };
    seen.add(c.name);
  }
  if (seen.has(session) && seen.has(secureSession)) return { ok: false, reason: 'both __Secure- and plain session cookies' };

  const credentials: DetectedCredential[] = [];
  const bearerHeader = authz[0];
  if (bearerHeader !== undefined) {
    const m = BEARER.exec(bearerHeader);
    if (!m?.[1]) return { ok: false, reason: 'Authorization must be "Bearer <token>"' };
    credentials.push({ kind: cfg.mode === 'external' ? 'EXTERNAL_BEARER' : 'BEARER_SESSION', value: m[1] });
  }
  if (cfg.mode === 'external') {
    const token = cfg.externalTokenCookie ? cookies.find((c) => c.name === cfg.externalTokenCookie) : undefined;
    if (token) credentials.unshift({ kind: 'EXTERNAL_COOKIE', value: token.value, cookieName: token.name });
  } else {
    const s = cookies.find((c) => c.name === session || c.name === secureSession);
    if (s) credentials.unshift({ kind: 'SESSION_COOKIE', value: s.value, cookieName: s.name });
  }
  const apiKey = apiKeys[0];
  if (apiKey !== undefined) credentials.push({ kind: 'API_KEY', value: apiKey.trim() });

  const cookieWithBearer = credentials.length === 2 && credentials[0]!.kind === 'SESSION_COOKIE' && credentials[1]!.kind === 'BEARER_SESSION';
  if (credentials.length > 1 && !(opts.allowCookieWithBearer && cookieWithBearer)) return { ok: false, reason: 'more than one credential' };
  const hasAuthCookie = cfg.mode === 'external'
    ? cookies.some((c) => counted.has(c.name))
    : cookies.some((c) => authPrefixes.some((p) => c.name.startsWith(p)));
  return { ok: true, credentials, hasAuthCookie };
}
```
`src/modules/identity/http/origin-check.ts`:
```ts
import type { CredentialKind } from '../../../core/context/index.js';

export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAME_ORIGIN = 'same-origin';

/** Cùng danh sách với `trustedOrigins` của Better Auth (spec §5.4): CORS origins + origin của AUTH_BASE_URL. */
export const trustedOriginList = (corsOrigins: readonly string[], baseUrl: string | undefined): string[] =>
  [...new Set([...corsOrigins, ...(baseUrl ? [new URL(baseUrl).origin] : [])])];

export const isCookieCredential = (kind: CredentialKind): boolean => kind === 'SESSION_COOKIE' || kind === 'EXTERNAL_COOKIE';

/**
 * Chỉ áp cho method không an toàn của request xác thực bằng cookie (caller quyết định điều kiện cookie).
 * `Origin` phải khớp chính xác một origin tin cậy (không wildcard, không so cùng site); thiếu `Origin` thì
 * chỉ nhận `Sec-Fetch-Site: same-origin`; không bao giờ nhận `Referer` (khác Better Auth, A.13).
 */
export function csrfAllows(input: { method: string; origin?: string; secFetchSite?: string }, trusted: ReadonlySet<string>): boolean {
  if (!UNSAFE_METHODS.has(input.method.toUpperCase())) return true;
  if (input.origin !== undefined) return trusted.has(input.origin);
  return input.secFetchSite === SAME_ORIGIN;
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/identity && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity/http test/unit/modules/identity/credential-detector.spec.ts test/unit/modules/identity/origin-check.spec.ts
git commit -m "feat(identity): raw-header credential detection with multi-source rejection, and exact-origin CSRF check"
```

---

### Task 31: Khoá tài khoản atomic (`RateLimiterPostgres`, cửa sổ đánh số, refund)

**Files:**
- Create: `src/modules/identity/infra/better-auth/login-lockout.ts`, `src/modules/identity/infra/better-auth/email-normalize.ts`
- Test: `test/unit/modules/identity/email-normalize.spec.ts`, `test/integration/identity/login-lockout.spec.ts`

**Interfaces:**
- Consumes: `AUTH_SCHEMA`, `LOGIN_ATTEMPTS_TABLE`, `createAuthPool` (Task 26); `identityGuardConfig` (Task 25); `IDENTITY_METER`, `identitySpan`, `installOtelCapture` (Task 27); kết quả S2b, S4b.
- Produces:
  - `normalizeEmail(email: string): string` (`trim` + `toLowerCase` + NFC), `emailHash(email: string): string` (sha256 hex của email chuẩn hoá).
  - `type LockoutScope = { kind: 'signin'; email: string } | { kind: '2fa'; subject: string }`, `type LockoutTicket = { attemptKey: string }`, `class LockoutBlockedError { retryAfterSec: number }`, `class LockoutUnavailableError`.
  - `class LoginLockout { constructor(pool: pg.Pool, cfg: { maxFailures: number; windowSec: number; blockSec: number }, now?: () => number); guard(scope): Promise<LockoutTicket>; refund(ticket): Promise<void> }`, `LOGIN_LOCKOUT` token (Task 35 đăng ký). Telemetry (review I8): counter `identity_lockout_blocked_total{scope=signin|2fa}`, span `identity.lockout.consume` (attribute `identity.lockout.scope`).

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/email-normalize.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emailHash, normalizeEmail } from '../../../../src/modules/identity/infra/better-auth/email-normalize.js';

describe('normalizeEmail', () => {
  it('same lockout key for case and whitespace variants', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
    expect(emailHash('User@Example.com ')).toBe(emailHash('user@example.com'));
  });
  it('NFC-normalizes composed and decomposed forms', () => {
    expect(normalizeEmail('é@example.com')).toBe(normalizeEmail('é@example.com'));
  });
});
```
`test/integration/identity/login-lockout.spec.ts`:
```ts
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { LockoutBlockedError, LockoutUnavailableError, LoginLockout } from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const MAX = 5; const WINDOW_SEC = 60; const BLOCK_SEC = 120;
const cfg = { maxFailures: MAX, windowSec: WINDOW_SEC, blockSec: BLOCK_SEC };

describe('LoginLockout (RateLimiterPostgres on auth.login_attempts)', () => {
  let a: pg.Pool; let b: pg.Pool; let owner: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    a = createAuthPool(authDatabaseConfig(), databaseConfig());
    b = createAuthPool(authDatabaseConfig(), databaseConfig());
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await a?.end(); await b?.end(); await owner?.end(); });

  it('MAX + k concurrent failures from two instances: exactly k are refused before verification, account blocked', async () => {
    const email = `l-${v7()}@example.test`; const k = 3;
    const one = new LoginLockout(a, cfg); const two = new LoginLockout(b, cfg);
    const results = await Promise.allSettled(Array.from({ length: MAX + k }, (_, i) => (i % 2 ? one : two).guard({ kind: 'signin', email })));
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof LockoutBlockedError)).toHaveLength(k);
    await expect(one.guard({ kind: 'signin', email })).rejects.toMatchObject({ retryAfterSec: expect.any(Number) });
    expect(await otel.metric('identity_lockout_blocked_total', { scope: 'signin' })).toBeGreaterThanOrEqual(k + 1);
    expect(otel.spans('identity.lockout.consume').some((sp) => sp.attributes['identity.lockout.scope'] === 'signin')).toBe(true);
    expect(otel.spanNames()).toContain('identity.lockout.consume');
  });
  it('a successful sign-in refunds only its own attempt, never other concurrent failures', async () => {
    const email = `r-${v7()}@example.test`; const lock = new LoginLockout(a, cfg);
    for (let i = 0; i < MAX - 1; i++) await lock.guard({ kind: 'signin', email });
    const ok = await lock.guard({ kind: 'signin', email });
    await lock.refund(ok);
    await expect(lock.guard({ kind: 'signin', email })).resolves.toBeDefined();
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(LockoutBlockedError);
  });
  it('a late refund after the window rolled over does not touch the new window', async () => {
    const email = `w-${v7()}@example.test`;
    let now = Date.UTC(2026, 8, 27, 10, 0, 0);
    const lock = new LoginLockout(a, cfg, () => now);
    const ticket = await lock.guard({ kind: 'signin', email });
    now += WINDOW_SEC * 1000;
    for (let i = 0; i < MAX; i++) await lock.guard({ kind: 'signin', email });
    await lock.refund(ticket);
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(LockoutBlockedError);
  });
  it('an unknown email is locked exactly like a known one; case variants share the key', async () => {
    const lock = new LoginLockout(a, cfg);
    const email = `Nobody-${v7()}@Example.test`;
    for (let i = 0; i < MAX; i++) await lock.guard({ kind: 'signin', email: i % 2 ? email.toLowerCase() : ` ${email} ` });
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(LockoutBlockedError);
    const { rows } = await owner.query(`SELECT key FROM auth.login_attempts WHERE key LIKE '%' || $1 || '%'`, [email]);
    expect(rows).toEqual([]);
  });
  it('storage failure is LockoutUnavailableError (fail-closed, never allowed through)', async () => {
    const lock = new LoginLockout(a, cfg);
    await owner.query('REVOKE INSERT, UPDATE ON auth.login_attempts FROM auth_user');
    try {
      await expect(lock.guard({ kind: 'signin', email: `f-${v7()}@example.test` })).rejects.toBeInstanceOf(LockoutUnavailableError);
    } finally {
      await owner.query('GRANT INSERT, UPDATE ON auth.login_attempts TO auth_user');
    }
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/identity/email-normalize.spec.ts; pnpm vitest run --project integration test/integration/identity/login-lockout.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/infra/better-auth/email-normalize.ts`:
```ts
import { createHash } from 'node:crypto';

/** Một khoá cho mọi biến thể hoa thường/khoảng trắng/Unicode của cùng email (Review Focus 1). */
export const normalizeEmail = (email: string): string => email.normalize('NFC').trim().toLowerCase();
/** Khoá lockout không bao giờ chứa email thật (không PII trong DB/log). */
export const emailHash = (email: string): string => createHash('sha256').update(normalizeEmail(email)).digest('hex');
```
`src/modules/identity/infra/better-auth/login-lockout.ts`:
```ts
import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type pg from 'pg';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { IDENTITY_METER, identitySpan } from '../../identity-telemetry.js';
import { AUTH_SCHEMA, LOGIN_ATTEMPTS_TABLE } from './auth-schema.js';
import { emailHash } from './email-normalize.js';

export const LOGIN_LOCKOUT = Symbol('identity.loginLockout');
const MS_PER_SECOND = 1000;
const ATTEMPTS_PREFIX = 'attempts';
const BLOCKS_PREFIX = 'blocks';
const BLOCK_POINTS = 1;

export type LockoutScope = { kind: 'signin'; email: string } | { kind: '2fa'; subject: string };
export type LockoutTicket = { attemptKey: string };
export type LockoutConfig = { maxFailures: number; windowSec: number; blockSec: number };

export class LockoutBlockedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super('Account temporarily locked');
    this.name = 'LockoutBlockedError';
  }
}
export class LockoutUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Lockout storage unavailable', options);
    this.name = 'LockoutUnavailableError';
  }
}

/**
 * Khoá theo tài khoản (spec §5.7): trạng thái chỉ ở Postgres (không chặn trong bộ nhớ pod), `consume`
 * TRƯỚC khi xác minh là một câu upsert atomic dưới row lock, nên N request song song ở mọi pod được đếm đủ.
 * Khoá lần thử mang số hiệu cửa sổ `w`, nên refund chỉ đụng được dòng của cửa sổ đã consume.
 */
export class LoginLockout {
  private readonly logger = new Logger(LoginLockout.name);
  private readonly attempts: RateLimiterPostgres;
  private readonly blocks: RateLimiterPostgres;
  /** Label chỉ là loại scope (không email/hash/user id, spec §5.14). */
  private readonly blockedTotal = metrics.getMeter(IDENTITY_METER).createCounter('identity_lockout_blocked_total', {
    description: 'Sign-in/2FA attempts refused by the per-account lockout before verification',
  });

  constructor(pool: pg.Pool, private readonly cfg: LockoutConfig, private readonly now: () => number = Date.now) {
    const base = { storeClient: pool, storeType: 'pool', schemaName: AUTH_SCHEMA, tableName: LOGIN_ATTEMPTS_TABLE, tableCreated: true };
    this.attempts = new RateLimiterPostgres({ ...base, keyPrefix: ATTEMPTS_PREFIX, points: cfg.maxFailures, duration: cfg.windowSec });
    this.blocks = new RateLimiterPostgres({ ...base, keyPrefix: BLOCKS_PREFIX, points: BLOCK_POINTS, duration: cfg.blockSec });
  }

  private accountKey(scope: LockoutScope): string {
    switch (scope.kind) {
      case 'signin':
        return `signin:${emailHash(scope.email)}`;
      case '2fa':
        return `2fa:${scope.subject}`;
      default: {
        const unknown: never = scope;
        throw new Error(`unknown lockout scope ${JSON.stringify(unknown)}`);
      }
    }
  }

  async guard(scope: LockoutScope): Promise<LockoutTicket> {
    try {
      return await identitySpan('identity.lockout.consume', () => this.consume(scope), () => ({ 'identity.lockout.scope': scope.kind }));
    } catch (err) {
      if (err instanceof LockoutBlockedError) this.blockedTotal.add(1, { scope: scope.kind });
      throw err;
    }
  }

  private async consume(scope: LockoutScope): Promise<LockoutTicket> {
    const accountKey = this.accountKey(scope);
    const w = Math.floor(this.now() / (this.cfg.windowSec * MS_PER_SECOND));
    const attemptKey = `${accountKey}:w${w}`;
    try {
      const blocked = await this.blocks.get(accountKey);
      if (blocked && blocked.consumedPoints > BLOCK_POINTS) throw new LockoutBlockedError(Math.ceil(blocked.msBeforeNext / MS_PER_SECOND));
      await this.attempts.consume(attemptKey);
      return { attemptKey };
    } catch (err) {
      if (err instanceof LockoutBlockedError) throw err;
      if (err instanceof RateLimiterRes) {
        await this.block(accountKey);
        throw new LockoutBlockedError(this.cfg.blockSec);
      }
      throw new LockoutUnavailableError({ cause: err });
    }
  }

  /**
   * Hoàn đúng điểm đã consume khi xác minh thành công (không dùng `delete`: xoá luôn các lần thất bại song
   * song). Lỗi storage ở đây chỉ làm lockout chặt hơn một lần thử, không đổi đăng nhập đúng thành lỗi:
   * log ở mức error (có tên sự kiện, không PII) rồi tiếp tục.
   */
  async refund(ticket: LockoutTicket): Promise<void> {
    try {
      await this.attempts.reward(ticket.attemptKey, 1);
    } catch (err) {
      this.logger.error({ err, event: 'lockout_refund_failed' }, 'lockout refund failed');
    }
  }

  private async block(accountKey: string): Promise<void> {
    try {
      await this.blocks.block(accountKey, this.cfg.blockSec);
    } catch (err) {
      throw new LockoutUnavailableError({ cause: err });
    }
  }
}
```
(Kiểu `storeType: 'pool'` và `get`/`block`/`reward` đối chiếu `node_modules/rate-limiter-flexible/types.d.ts`. `storeClient` của thư viện có kiểu `any` nên truyền `pg.Pool` không cần cast.)

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/identity && pnpm vitest run --project integration test/integration/identity/login-lockout.spec.ts && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity/infra/better-auth/login-lockout.ts src/modules/identity/infra/better-auth/email-normalize.ts test/unit/modules/identity/email-normalize.spec.ts test/integration/identity/login-lockout.spec.ts
git commit -m "feat(identity): atomic per-account lockout with window-numbered keys and exact refunds"
```

---
### Task 32: Event `identity.user.registered` (v5 + marker bền), cron đối soát và cron dọn

**Files:**
- Create: `src/modules/identity/events.ts`, `src/modules/identity/jobs.ts`, `src/modules/identity/ports/auth-housekeeping.ts`, `src/modules/identity/infra/better-auth/pg-auth-housekeeping.ts`, `src/modules/identity/application/registered-event.service.ts`, `src/modules/identity/application/reconcile-registered.handler.ts`, `src/modules/identity/application/purge-expired.handler.ts`
- Test: `test/unit/modules/identity/registered-event-id.spec.ts`, `test/integration/identity/registered-event.spec.ts`, `test/integration/identity/purge-expired.spec.ts`

**Interfaces:**
- Consumes: `EventPublisher.publish(def, { eventId, … }, { ifAbsent })` (Task 12), `defineEvent`, `defineJob`, `defineCron`, `MaintenanceQueue`, `UnitOfWork` (SP1); `RegistrationLedger`, `authPoolProviders` (Task 27); `identityGuardConfig` (Task 25); `IDENTITY_METER`, `identitySpan`, `installOtelCapture` (Task 27).
- Produces:
  - `IDENTITY_EVENT_NAMESPACE = '87857401-f233-5789-839c-2dc5fb919229'`, `UserRegisteredEvent` (`identity.user.registered@1`, `{ userId: uuid }`), `registeredEventId(userId: string): string` (`identity/events.ts`).
  - `ReconcileRegisteredJob` (`identity.reconcile-registered`), `PurgeExpiredJob` (`identity.purge-expired`) + hai cron (`identity/jobs.ts`).
  - `RegisteredEventService.onUserCreated(userId: string): Promise<void>` (after-hook, lỗi thì log + để cron bù), `RegisteredEventService.publish(userId: string): Promise<void>` (trong transaction của caller).
  - `ReconcileRegisteredHandler`, `PurgeExpiredHandler` (bỏ qua an toàn khi không có pool auth — `AUTH_MODE=external`).
  - `AUTH_PURGE_TARGETS`, `abstract class AuthHousekeeping { purgeExpired(target: AuthPurgeTarget, limit: number): Promise<number> }`, `PgAuthHousekeeping`.
  - Metric `identity_registered_unmarked_oldest_seconds`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/registered-event-id.spec.ts`:
```ts
import { v5 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { IDENTITY_EVENT_NAMESPACE, registeredEventId } from '../../../../src/modules/identity/events.js';

describe('identity.user.registered event id (D10, spec §5.10)', () => {
  it('namespace is v5("nestjs-saas-boilerplate/identity-events", v5.URL)', () => {
    expect(v5('nestjs-saas-boilerplate/identity-events', v5.URL)).toBe(IDENTITY_EVENT_NAMESPACE);
  });
  it('matches the fixed test vector', () => {
    expect(registeredEventId('019dd1a5-9235-70db-8d57-54ef901d8185')).toBe('59f229d2-931e-5ad8-8c7c-5ee7dbfd34e4');
  });
});
```
`test/integration/identity/registered-event.spec.ts`:
```ts
import { Logger, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventPublisher, EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { RegisteredEventService } from '../../../src/modules/identity/application/registered-event.service.js';
import { ReconcileRegisteredHandler } from '../../../src/modules/identity/application/reconcile-registered.handler.js';
import { registeredEventId } from '../../../src/modules/identity/events.js';
import { authPoolProviders, AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgRegistrationLedger } from '../../../src/modules/identity/infra/better-auth/pg-registration-ledger.js';
import { RegistrationLedger } from '../../../src/modules/identity/ports/registration-ledger.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const GRACE_SEC = 1;
@Module({
  providers: [...authPoolProviders, PgRegistrationLedger, { provide: RegistrationLedger, useExisting: PgRegistrationLedger }, RegisteredEventService, ReconcileRegisteredHandler],
})
class M {}
const ctx = () => ({ payload: {}, meta: {}, jobId: v7(), attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log: new Logger('t') });

describe('identity.user.registered: after-hook + reconcile (spec §5.10)', () => {
  let app: INestApplication; let owner: pg.Client;
  const newUser = async (agoSec = 0) => (await owner.query<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at) VALUES ('N', $1, false, now() - make_interval(secs => $2), now()) RETURNING id`,
    [`r-${v7()}@example.test`, agoSec])).rows[0]!.id;
  const events = async (userId: string) => (await owner.query(`SELECT event_id FROM outbox_events WHERE event_id = $1`, [registeredEventId(userId)])).rows.length;
  const marked = async (userId: string) => (await owner.query(`SELECT registered_event_emitted_at IS NOT NULL AS m FROM auth."user" WHERE id = $1`, [userId])).rows[0].m;
  beforeAll(async () => {
    vi.stubEnv('AUTH_REGISTERED_RECONCILE_GRACE_SEC', String(GRACE_SEC));
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), M]);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); vi.unstubAllEnvs(); });

  it('happy path: one event with the v5 id, marker set', async () => {
    const id = await newUser();
    await app.get(RegisteredEventService).onUserCreated(id);
    expect([await events(id), await marked(id)]).toEqual([1, true]);
  });
  it('after-hook fails at the outbox step → the cron emits exactly one event', async () => {
    const id = await newUser(GRACE_SEC * 5);
    vi.spyOn(app.get(EventPublisher), 'publish').mockRejectedValueOnce(new Error('outbox down'));
    await app.get(RegisteredEventService).onUserCreated(id);
    expect([await events(id), await marked(id)]).toEqual([0, false]);
    await app.get(ReconcileRegisteredHandler).handle(ctx());
    expect([await events(id), await marked(id)]).toEqual([1, true]);
    expect(otel.spans('identity.registered.reconcile').at(-1)?.attributes['identity.reconcile.published']).toBeGreaterThanOrEqual(1);
  });
  it('after-hook fails at the marker step → the cron re-appends the same id (no duplicate) and marks', async () => {
    const id = await newUser(GRACE_SEC * 5);
    vi.spyOn(app.get(PgRegistrationLedger), 'mark').mockRejectedValueOnce(new Error('auth pool down'));
    await app.get(RegisteredEventService).onUserCreated(id);
    expect([await events(id), await marked(id)]).toEqual([1, false]);
    await app.get(ReconcileRegisteredHandler).handle(ctx());
    expect([await events(id), await marked(id)]).toEqual([1, true]);
  });
  it('a user transaction committed later than GRACE is still found (no time window)', async () => {
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(`INSERT INTO "user" (name, email, email_verified, created_at, updated_at) VALUES ('L', $1, false, now(), now()) RETURNING id`, [`late-${v7()}@example.test`]);
      await new Promise((r) => setTimeout(r, (GRACE_SEC + 1) * 1000));
      await app.get(ReconcileRegisteredHandler).handle(ctx());
      await client.query('COMMIT');
      await app.get(ReconcileRegisteredHandler).handle(ctx());
      expect(await events(rows[0]!.id)).toBe(1);
    } finally {
      client.release();
    }
  });
  it('two reconcilers in parallel emit one event; a user unmarked for 30 days is still reconciled', async () => {
    const id = await newUser(30 * 86400);
    const h = app.get(ReconcileRegisteredHandler);
    await Promise.all([h.handle(ctx()), h.handle(ctx())]);
    expect([await events(id), await marked(id)]).toEqual([1, true]);
  });
});
```
`test/integration/identity/purge-expired.spec.ts`:
```ts
import { Logger, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PurgeExpiredHandler } from '../../../src/modules/identity/application/purge-expired.handler.js';
import { authPoolProviders } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgAuthHousekeeping } from '../../../src/modules/identity/infra/better-auth/pg-auth-housekeeping.js';
import { AuthHousekeeping } from '../../../src/modules/identity/ports/auth-housekeeping.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

@Module({ providers: [...authPoolProviders, PgAuthHousekeeping, { provide: AuthHousekeeping, useExisting: PgAuthHousekeeping }, PurgeExpiredHandler] })
class M {}

describe('identity.purge-expired', () => {
  let app: INestApplication; let owner: pg.Client;
  beforeAll(async () => {
    app = await createTestApp([M]);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); });

  it('deletes expired sessions, verifications, rate limit and lockout rows; keeps live ones', async () => {
    const user = (await owner.query<{ id: string }>(`INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at) VALUES ('P', $1, true, now(), now()) RETURNING id`, [`p-${v7()}@example.test`])).rows[0]!.id;
    const live = v7(); const dead = v7();
    await owner.query(`INSERT INTO auth.session (id, token, user_id, expires_at, updated_at) VALUES ($1::uuid, $1::uuid::text, $3::uuid, now() + interval '1 day', now()), ($2::uuid, $2::uuid::text, $3::uuid, now() - interval '1 day', now())`, [live, dead, user]);
    await owner.query(`INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('x', 'v', now() - interval '1 hour'), ('y', 'v', now() + interval '1 hour')`);
    await owner.query(`INSERT INTO auth.login_attempts (key, points, expire) VALUES ($1, 1, 1), ($2, 1, $3)`, [`old-${v7()}`, `new-${v7()}`, Date.now() + 3_600_000]);
    await owner.query(`INSERT INTO auth.rate_limit (key, count, last_request) VALUES ($1, 1, 1)`, [`rl-${v7()}`]);
    await app.get(PurgeExpiredHandler).handle({ payload: {}, meta: {}, jobId: v7(), attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log: new Logger('t') });
    const count = async (sql: string) => (await owner.query<{ n: number }>(sql)).rows[0]!.n;
    expect(await count(`SELECT count(*)::int AS n FROM auth.session WHERE id = '${dead}'`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM auth.session WHERE id = '${live}'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM auth.verification WHERE expires_at < now()`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM auth.login_attempts WHERE expire < ${Date.now()}`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM auth.rate_limit WHERE last_request = 1`)).toBe(0);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/identity/registered-event-id.spec.ts; pnpm vitest run --project integration test/integration/identity/registered-event.spec.ts test/integration/identity/purge-expired.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/events.ts`:
```ts
import { v5 } from 'uuid';
import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';

/** `v5('nestjs-saas-boilerplate/identity-events', v5.URL)` (A.1). Hằng số: đổi là mất dedupe với event cũ. */
export const IDENTITY_EVENT_NAMESPACE = '87857401-f233-5789-839c-2dc5fb919229';

/** Payload không có email (PII); subscriber đọc thêm qua IdentityDirectory nếu cần. */
export const UserRegisteredEvent = defineEvent({ type: 'identity.user.registered', version: 1, schema: z.object({ userId: z.uuid() }) });

/** Id xác định trước (D10): after-hook và cron đối soát ghi cùng id, outbox + inbox chặn trùng. Ngoại lệ của "event id là v7" (ADR 0009). */
export const registeredEventId = (userId: string): string => v5(`${UserRegisteredEvent.type}:${userId}`, IDENTITY_EVENT_NAMESPACE);
```
`src/modules/identity/jobs.ts`:
```ts
import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../../core/queue/index.js';
import { defineCron } from '../../core/scheduler/index.js';
import { identityGuardConfig } from './identity.config.js';

export const ReconcileRegisteredJob = defineJob({ name: 'identity.reconcile-registered', queue: MaintenanceQueue, version: 1, schema: z.object({}) });
export const PurgeExpiredJob = defineJob({ name: 'identity.purge-expired', queue: MaintenanceQueue, version: 1, schema: z.object({}) });

defineCron({
  key: 'identity.reconcile-registered',
  job: ReconcileRegisteredJob,
  payload: {},
  schedule: () => {
    const c = identityGuardConfig();
    return { cron: c.registeredReconcileCron, tz: c.registeredReconcileTz };
  },
});
defineCron({
  key: 'identity.purge-expired',
  job: PurgeExpiredJob,
  payload: {},
  schedule: () => {
    const c = identityGuardConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
});
```
`src/modules/identity/ports/auth-housekeeping.ts`:
```ts
export const AUTH_PURGE_TARGETS = ['session', 'verification', 'rate_limit', 'login_attempts'] as const;
export type AuthPurgeTarget = (typeof AUTH_PURGE_TARGETS)[number];

/** Dọn dữ liệu hết hạn của schema auth theo lô (spec cha §6). */
export abstract class AuthHousekeeping {
  abstract purgeExpired(target: AuthPurgeTarget, limit: number): Promise<number>;
}
```
`src/modules/identity/infra/better-auth/pg-auth-housekeeping.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import { type ConfigOf } from '../../../../core/config/index.js';
import { identityGuardConfig } from '../../identity.config.js';
import { AuthHousekeeping, type AuthPurgeTarget } from '../../ports/auth-housekeeping.js';
import { AUTH_POOL } from './auth-pool.provider.js';

const MS_PER_SECOND = 1000;
const CountRow = z.object({ n: z.number().int() });
const batchDelete = (table: string, key: string, where: string, order: string) =>
  `WITH victim AS (SELECT ${key} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT $1)
   , d AS (DELETE FROM ${table} t USING victim v WHERE t.${key} = v.${key} RETURNING 1)
   SELECT count(*)::int AS n FROM d`;
/** Câu SQL cố định theo bảng (không nối input); index: session/verification(expires_at), login_attempts(expire). */
const SQL: Record<AuthPurgeTarget, string> = {
  session: batchDelete('session', 'id', 'expires_at < now()', 'expires_at'),
  verification: batchDelete('verification', 'id', 'expires_at < now()', 'expires_at'),
  // rate_limit.last_request và login_attempts.expire là epoch ms (schema của thư viện, spec §5.16b).
  rate_limit: batchDelete('rate_limit', 'id', 'last_request < $2', 'last_request'),
  login_attempts: batchDelete('login_attempts', 'key', 'expire < $2', 'expire'),
};

@Injectable()
export class PgAuthHousekeeping extends AuthHousekeeping {
  constructor(
    @Inject(AUTH_POOL) private readonly pool: pg.Pool,
    @Inject(identityGuardConfig.KEY) private readonly guard: ConfigOf<typeof identityGuardConfig>,
  ) {
    super();
  }

  async purgeExpired(target: AuthPurgeTarget, limit: number): Promise<number> {
    const nowMs = Date.now();
    // Một dòng rate_limit chỉ còn tác dụng trong cửa sổ dài nhất đang cấu hình.
    const longestWindowMs = Math.max(this.guard.rateLimitWindowSec, this.guard.signinRateWindowSec, this.guard.twoFactorRateWindowSec, this.guard.emailRateWindowSec) * MS_PER_SECOND;
    const params: unknown[] = target === 'rate_limit' ? [limit, nowMs - longestWindowMs] : target === 'login_attempts' ? [limit, nowMs] : [limit];
    const { rows } = await this.pool.query(SQL[target], params);
    return CountRow.parse(rows[0]).n;
  }
}
```
`src/modules/identity/application/registered-event.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { UserRegisteredEvent, registeredEventId } from '../events.js';
import { RegistrationLedger } from '../ports/registration-ledger.js';

/**
 * Hai pool khác nhau (outbox trên `app_user`, marker trên `auth_user`) nên không gộp được một transaction
 * (D10). Thứ tự luôn là ghi outbox (commit) RỒI đặt marker; crash giữa hai bước chỉ dẫn tới ghi lại cùng id.
 */
@Injectable()
export class RegisteredEventService {
  private readonly logger = new Logger(RegisteredEventService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly events: EventPublisher,
    private readonly ledger: RegistrationLedger,
  ) {}

  /** Trong transaction của caller (cron gom cả batch vào một `uow.run`). */
  async publish(userId: string): Promise<void> {
    await this.events.publish(
      UserRegisteredEvent,
      { eventId: registeredEventId(userId), data: { userId }, aggregate: { type: 'user', id: userId, version: 1 }, actor: { type: 'user', id: userId } },
      { ifAbsent: true },
    );
  }

  /** `databaseHooks.user.create.after` (chạy sau commit của auth). Lỗi: log không PII rồi để cron bù (spec §5.10). */
  async onUserCreated(userId: string): Promise<void> {
    try {
      await this.uow.run(() => this.publish(userId));
      await this.ledger.mark([userId]);
    } catch (err) {
      this.logger.warn({ err, userId, event: 'registered_event_deferred' }, 'identity.user.registered deferred to the reconcile cron');
    }
  }
}
```
`src/modules/identity/application/reconcile-registered.handler.ts`:
```ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { type ConfigOf } from '../../../core/config/index.js';
import { IDENTITY_METER, identitySpan } from '../identity-telemetry.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { identityGuardConfig } from '../identity.config.js';
import { ReconcileRegisteredJob } from '../jobs.js';
import { RegistrationLedger } from '../ports/registration-ledger.js';
import { RegisteredEventService } from './registered-event.service.js';

/**
 * Bù event cho user chưa có marker (spec §5.10): không có giới hạn cửa sổ thời gian, nên user commit muộn
 * hay worker dừng lâu vẫn được tìm thấy. `GRACE` chỉ để after-hook chạy trước. Ở `AUTH_MODE=external` không
 * có pool auth: handler vẫn được đăng ký (cron tĩnh của maintenance queue cần handler) và không làm gì.
 */
@Injectable()
@JobHandler(ReconcileRegisteredJob)
export class ReconcileRegisteredHandler {
  private readonly logger = new Logger(ReconcileRegisteredHandler.name);
  private oldestSec: number | null = null;

  constructor(
    private readonly uow: UnitOfWork,
    @Inject(identityGuardConfig.KEY) private readonly cfg: ConfigOf<typeof identityGuardConfig>,
    @Optional() private readonly ledger?: RegistrationLedger,
    @Optional() private readonly service?: RegisteredEventService,
  ) {
    metrics.getMeter(IDENTITY_METER).createObservableGauge('identity_registered_unmarked_oldest_seconds', {
      description: 'Age of the oldest user whose registered event is not marked yet', unit: 's',
    }).addCallback((r) => { if (this.oldestSec !== null) r.observe(this.oldestSec); });
  }

  /** Span `identity.registered.reconcile` (review I8), con của span job của SP1; attribute chỉ là số đếm. */
  async handle(ctx: JobContext<unknown>): Promise<{ published: number }> {
    return identitySpan('identity.registered.reconcile', () => this.reconcile(ctx), (r) => ({ 'identity.reconcile.published': r.published }));
  }

  private async reconcile(ctx: JobContext<unknown>): Promise<{ published: number }> {
    const { ledger, service } = this;
    if (!ledger || !service) return { published: 0 };
    let published = 0;
    for (let i = 0; i < this.cfg.registeredReconcileMaxBatches; i++) {
      ctx.signal.throwIfAborted();
      const ids = await ledger.unmarked(this.cfg.registeredReconcileGraceSec, this.cfg.registeredReconcileBatchSize);
      if (ids.length === 0) break;
      await this.uow.run(async () => {
        for (const id of ids) await service.publish(id);
      });
      await ledger.mark(ids);
      published += ids.length;
      if (ids.length < this.cfg.registeredReconcileBatchSize) break;
    }
    this.oldestSec = await ledger.oldestUnmarkedAgeSec();
    this.logger.log({ published, oldestUnmarkedSec: this.oldestSec }, 'registered events reconciled');
    return { published };
  }
}
```
`src/modules/identity/application/purge-expired.handler.ts`:
```ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type ConfigOf } from '../../../core/config/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { identityGuardConfig } from '../identity.config.js';
import { PurgeExpiredJob } from '../jobs.js';
import { AUTH_PURGE_TARGETS, AuthHousekeeping } from '../ports/auth-housekeeping.js';

@Injectable()
@JobHandler(PurgeExpiredJob)
export class PurgeExpiredHandler {
  private readonly logger = new Logger(PurgeExpiredHandler.name);

  constructor(
    @Inject(identityGuardConfig.KEY) private readonly cfg: ConfigOf<typeof identityGuardConfig>,
    @Optional() private readonly housekeeping?: AuthHousekeeping,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    if (!this.housekeeping) return deleted;
    for (const target of AUTH_PURGE_TARGETS) {
      deleted[target] = 0;
      for (let i = 0; i < this.cfg.purgeMaxBatches; i++) {
        ctx.signal.throwIfAborted();
        const n = await this.housekeeping.purgeExpired(target, this.cfg.purgeBatchSize);
        deleted[target] += n;
        if (n < this.cfg.purgeBatchSize) break;
      }
    }
    this.logger.log(deleted, 'expired auth data purged');
    return deleted;
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/identity && pnpm vitest run --project integration test/integration/identity && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity test/unit/modules/identity/registered-event-id.spec.ts test/integration/identity/registered-event.spec.ts test/integration/identity/purge-expired.spec.ts
git commit -m "feat(identity): durable-marker user registered event with reconcile cron; purge expired auth data"
```

---

### Task 33: `buildAuthOptions`, mapper hồ sơ OAuth, email của auth

**Files:**
- Create: `src/modules/identity/infra/better-auth/auth-options.ts`, `src/modules/identity/infra/better-auth/profile-mapper.ts`, `src/modules/identity/application/auth-emails.ts`
- Test: `test/unit/modules/identity/auth-options.spec.ts`, `test/unit/modules/identity/profile-mapper.spec.ts`, `test/integration/identity/auth-emails.spec.ts`

**Interfaces:**
- Consumes: `corePlugins`, `IMPERSONATION_PATHS` (Task 26); `trustedOriginList` (Task 30); `identityConfig`, `identityGuardConfig` (Task 25); `EmailNotifications` (Task 20).
- Produces:
  - `CLIENT_IP_HEADER = 'x-app-client-ip'`, `type AuthOptionsInput = { identity; guard; app: { serviceName }; corsOrigins: readonly string[]; database: DBAdapterInstance; hooks: { before: AuthMiddleware; after: AuthMiddleware }; emails: AuthEmailCallbacks; onUserCreated(userId: string): Promise<void>; onApiError(err: unknown): void; log(level: string, message: string): void }`, `buildAuthOptions(input)`.
  - `emailVerifiedFromProvider(providerId: string, trusted: readonly string[], profile: Record<string, unknown>): boolean`, `googleProfileMapper(trusted)`, `oidcProfileMapper(providerId, trusted)`.
  - `AuthEmails` với `verification({ user, url, token })`, `reset({ user, url, token })`, `existingAccount({ user })`, `twoFactorChanged(user, sessionId, enabled)`; `type AuthEmailCallbacks = Pick<AuthEmails, 'verification' | 'reset' | 'existingAccount'>`.

- [ ] **Step 1: Viết test fail**

`test/unit/modules/identity/profile-mapper.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { emailVerifiedFromProvider } from '../../../../src/modules/identity/infra/better-auth/profile-mapper.js';

describe('account linking inputs (spec §5.4, fail-closed)', () => {
  it.each([
    ['untrusted provider + email_verified=true', 'acme', [], { email_verified: true }, false],
    ['trusted provider + missing claim', 'google', ['google'], {}, false],
    ['trusted provider + false', 'google', ['google'], { email_verified: false }, false],
    ['trusted provider + string "true"', 'google', ['google'], { email_verified: 'true' }, false],
    ['trusted provider + true', 'google', ['google'], { email_verified: true }, true],
  ])('%s → %s', (_n, provider, trusted, profile, want) => {
    expect(emailVerifiedFromProvider(provider, trusted, profile)).toBe(want);
  });
});
```
`test/unit/modules/identity/auth-options.spec.ts`:
```ts
import { createAuthMiddleware } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'vitest';
import { identityConfig, identityGuardConfig } from '../../../../src/modules/identity/identity.config.js';
import { CLIENT_IP_HEADER, buildAuthOptions } from '../../../../src/modules/identity/infra/better-auth/auth-options.js';

const noop = createAuthMiddleware(async () => undefined);
const input = (env: Record<string, string>) => {
  const identity = identityConfig.schema.parse({ secret: 's'.repeat(40), baseUrl: 'https://api.example.test', ...env });
  return buildAuthOptions({
    identity, guard: identityGuardConfig.schema.parse({}), app: { serviceName: 'svc' }, corsOrigins: ['https://app.example.test'],
    database: memoryAdapter({}), hooks: { before: noop, after: noop },
    emails: { verification: async () => undefined, reset: async () => undefined, existingAccount: async () => undefined },
    onUserCreated: async () => undefined, onApiError: () => undefined, log: () => undefined,
  });
};

describe('buildAuthOptions', () => {
  it('local: plugins, impersonation disabled, no session cache, fail-closed linking, IP from our header only', () => {
    const o = input({ mode: 'local' });
    expect(o.plugins.map((p) => p.id)).toEqual(['two-factor', 'bearer', 'api-key', 'jwt', 'admin']);
    expect(o.disabledPaths).toEqual(['/admin/impersonate-user', '/admin/stop-impersonating']);
    expect(o.session.cookieCache.enabled).toBe(false);
    expect(o.account.accountLinking).toMatchObject({ trustedProviders: [], disableImplicitLinking: true, allowDifferentEmails: false, requireLocalEmailVerified: true });
    expect(o.advanced.ipAddress.ipAddressHeaders).toEqual([CLIENT_IP_HEADER]);
    expect(o.advanced).toMatchObject({ useSecureCookies: true, cookiePrefix: 'svc', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' } });
    expect(o.advanced).not.toHaveProperty('crossSubDomainCookies');
    expect(o.trustedOrigins).toEqual(['https://app.example.test', 'https://api.example.test']);
    expect(o.rateLimit).toMatchObject({ enabled: true, storage: 'database' });
    expect(o.emailAndPassword).toMatchObject({ requireEmailVerification: true, autoSignIn: false, revokeSessionsOnPasswordReset: true });
  });
  it('trusted providers enable implicit linking; a parent cookie domain turns on cross-subdomain cookies', () => {
    const o = input({ googleClientId: 'g', googleClientSecret: 's', trustedProviders: 'google', cookieDomain: 'example.test', cookieDomainAllSubdomainsTrusted: 'true' });
    expect(o.account.accountLinking.disableImplicitLinking).toBe(false);
    expect(o.advanced).toMatchObject({ crossSubDomainCookies: { enabled: true, domain: 'example.test' } });
    expect(Object.keys(o.socialProviders)).toEqual(['google']);
  });
  it('hybrid adds generic OIDC', () => {
    const o = input({ mode: 'hybrid', oidcProviderId: 'corp', oidcDiscoveryUrl: 'https://idp.test/.well-known/openid-configuration', oidcClientId: 'c', oidcClientSecret: 's' });
    expect(o.plugins.map((p) => p.id)).toContain('generic-oauth');
  });
});
```
(Id của plugin — `two-factor`, `bearer`, `api-key`, `jwt`, `admin`, `generic-oauth` — đối chiếu thuộc tính `id` trong `node_modules/better-auth/dist/plugins/*/index.mjs` và `@better-auth/api-key`; khác thì dùng id thật.)

`test/integration/identity/auth-emails.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { AuthEmails } from '../../../src/modules/identity/application/auth-emails.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { Module } from '@nestjs/common';

@Module({ providers: [AuthEmails] })
class M {}
const user = () => ({ id: v7(), email: `e-${v7()}@example.test`, name: 'E', emailVerified: false, createdAt: new Date(), updatedAt: new Date() });

describe('AuthEmails idempotency keys (spec §5.8, §5.11)', () => {
  let app: INestApplication; let owner: pg.Client;
  const keys = async (like: string) => (await owner.query(`SELECT idempotency_key FROM email_deliveries WHERE idempotency_key LIKE $1`, [like])).rows.map((r) => r.idempotency_key);
  beforeAll(async () => {
    vi.stubEnv('AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC', '3600');
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), NotificationsModule.forApi(), M]);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); vi.unstubAllEnvs(); });

  it('verification and reset keys hash the token; the same token never sends twice', async () => {
    const e = app.get(AuthEmails); const u = user();
    await e.verification({ user: u, url: 'http://localhost:3000/api/auth/verify-email?token=t1', token: 't1' });
    await e.verification({ user: u, url: 'http://localhost:3000/api/auth/verify-email?token=t1', token: 't1' });
    const k = await keys('verify-email:%');
    expect(k.filter((x) => x.includes('t1'))).toEqual([]);
    expect(new Set(k).size).toBe(k.length);
  });
  it('at most one "account exists" notice per user per window', async () => {
    const e = app.get(AuthEmails); const u = user();
    await e.existingAccount({ user: u });
    await e.existingAccount({ user: u });
    expect(await keys(`existing-account:${u.id}:%`)).toHaveLength(1);
  });
  it('2FA change notice is keyed by user, session and direction', async () => {
    const e = app.get(AuthEmails); const u = user();
    await e.twoFactorChanged(u, 's1', true);
    await e.twoFactorChanged(u, 's1', true);
    await e.twoFactorChanged(u, 's1', false);
    expect((await keys(`two-factor-changed:${u.id}:%`)).sort()).toEqual([`two-factor-changed:${u.id}:s1:disabled`, `two-factor-changed:${u.id}:s1:enabled`]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/modules/identity/auth-options.spec.ts test/unit/modules/identity/profile-mapper.spec.ts; pnpm vitest run --project integration test/integration/identity/auth-emails.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/infra/better-auth/profile-mapper.ts`:
```ts
/**
 * Better Auth liên kết khi provider "tin cậy" HOẶC gửi email_verified=true (A.3), nên không dùng
 * `trustedProviders` của nó; thay vào đó `mapProfileToUser` ghi đè `emailVerified` (A.3 xác nhận giá trị
 * của mapper thắng). Chỉ đúng `true` kiểu boolean từ provider nằm trong AUTH_TRUSTED_PROVIDERS mới tính.
 */
export const emailVerifiedFromProvider = (providerId: string, trusted: readonly string[], profile: Record<string, unknown>): boolean =>
  trusted.includes(providerId) && profile.email_verified === true;

export const GOOGLE_PROVIDER_ID = 'google';
export const googleProfileMapper = (trusted: readonly string[]) => (profile: Record<string, unknown>) => ({
  emailVerified: emailVerifiedFromProvider(GOOGLE_PROVIDER_ID, trusted, profile),
});
export const oidcProfileMapper = (providerId: string, trusted: readonly string[]) => (profile: Record<string, unknown>) => ({
  emailVerified: emailVerifiedFromProvider(providerId, trusted, profile),
});
```
(Nếu kiểu tham số `profile` của `socialProviders.google.mapProfileToUser` là `GoogleProfile` thì hàm nhận `Record<string, unknown>` vẫn gán được vì `GoogleProfile` là object; nếu TypeScript báo lỗi do chữ ký khác, khai báo tham số là kiểu thật của Better Auth và đọc `email_verified` qua `Reflect.get` — không cast.)

`src/modules/identity/application/auth-emails.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type ConfigOf } from '../../../core/config/index.js';
import { EmailNotifications } from '../../notifications/index.js';
import { identityGuardConfig } from '../identity.config.js';

const MS_PER_SECOND = 1000;
type MailUser = { id: string; email: string; name: string };
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Callback email của Better Auth → yêu cầu email có idempotency key (spec §5.11). Không bao giờ gửi SMTP ở api. */
@Injectable()
export class AuthEmails {
  constructor(
    private readonly emails: EmailNotifications,
    @Inject(identityGuardConfig.KEY) private readonly guard: ConfigOf<typeof identityGuardConfig>,
  ) {}

  readonly verification = async (d: { user: MailUser; url: string; token: string }): Promise<void> => {
    await this.emails.request({ template: 'verify-email', to: d.user.email, params: { name: d.user.name, url: d.url }, idempotencyKey: `verify-email:${sha256(d.token)}` });
  };

  readonly reset = async (d: { user: MailUser; url: string; token: string }): Promise<void> => {
    await this.emails.request({ template: 'reset-password', to: d.user.email, params: { name: d.user.name, url: d.url }, idempotencyKey: `reset-password:${sha256(d.token)}` });
  };

  /** Tối đa một thư mỗi `AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC` (UNIQUE của idempotency key chặn spam). */
  readonly existingAccount = async (d: { user: MailUser }): Promise<void> => {
    const window = Math.floor(Date.now() / MS_PER_SECOND / this.guard.existingAccountNoticeWindowSec);
    await this.emails.request({ template: 'existing-account', to: d.user.email, params: { name: d.user.name }, idempotencyKey: `existing-account:${d.user.id}:${window}` });
  };

  async twoFactorChanged(user: MailUser, sessionId: string, enabled: boolean): Promise<void> {
    await this.emails.request({
      template: 'two-factor-changed', to: user.email,
      params: { name: user.name, enabled, occurredAt: new Date().toISOString() },
      idempotencyKey: `two-factor-changed:${user.id}:${sessionId}:${enabled ? 'enabled' : 'disabled'}`,
    });
  }
}
export type AuthEmailCallbacks = Pick<AuthEmails, 'verification' | 'reset' | 'existingAccount'>;
```
`src/modules/identity/infra/better-auth/auth-options.ts`:
```ts
import type { DBAdapterInstance } from 'better-auth';
import type { AuthMiddleware } from 'better-auth/api';
import { genericOAuth } from 'better-auth/plugins';
import type { AuthEmailCallbacks } from '../../application/auth-emails.js';
import { trustedOriginList } from '../../http/origin-check.js';
import { effectiveCookiePrefix, type IdentityConfig, type IdentityGuardConfig } from '../../identity.config.js';
import { IMPERSONATION_PATHS, corePlugins } from './auth-schema.js';
import { GOOGLE_PROVIDER_ID, googleProfileMapper, oidcProfileMapper } from './profile-mapper.js';

/** Header IP do `authMountMiddleware` ghi từ `req.ip` sau khi xoá bản client gửi (spec §5.4, A.5). */
export const CLIENT_IP_HEADER = 'x-app-client-ip';

export type AuthOptionsInput = {
  identity: IdentityConfig;
  guard: IdentityGuardConfig;
  app: { serviceName: string };
  corsOrigins: readonly string[];
  database: DBAdapterInstance;
  hooks: { before: AuthMiddleware; after: AuthMiddleware };
  emails: AuthEmailCallbacks;
  onUserCreated(userId: string): Promise<void>;
  onApiError(err: unknown): void;
  log(level: string, message: string): void;
};

/** Hàm thuần (spec §5.4): mọi giá trị từ config; test đơn vị theo mode. */
export function buildAuthOptions(input: AuthOptionsInput) {
  const { identity: id, guard, app } = input;
  const signinRule = { window: guard.signinRateWindowSec, max: guard.signinRateMax };
  const emailRule = { window: guard.emailRateWindowSec, max: guard.emailRateMax };
  return {
    appName: app.serviceName,
    secret: id.secret,
    baseURL: id.baseUrl,
    basePath: id.basePath,
    trustedOrigins: trustedOriginList(input.corsOrigins, id.baseUrl),
    database: input.database,
    advanced: {
      database: { generateId: 'uuid' as const },
      useSecureCookies: id.secureCookies,
      cookiePrefix: effectiveCookiePrefix(id, app),
      defaultCookieAttributes: { httpOnly: true, sameSite: id.cookieSameSite, path: '/' },
      ...(id.cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: id.cookieDomain } } : {}),
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    session: {
      expiresIn: id.sessionExpiresInSec,
      updateAge: id.sessionUpdateAgeSec,
      freshAge: id.sessionFreshAgeSec,
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: id.requireEmailVerification,
      autoSignIn: false,
      minPasswordLength: id.passwordMinLength,
      maxPasswordLength: id.passwordMaxLength,
      resetPasswordTokenExpiresIn: id.resetTokenTtlSec,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: input.emails.reset,
      onExistingUserSignUp: input.emails.existingAccount,
    },
    emailVerification: { sendOnSignUp: true, expiresIn: id.emailTokenTtlSec, sendVerificationEmail: input.emails.verification },
    user: { changeEmail: { enabled: true } },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        disableImplicitLinking: id.trustedProviders.length === 0,
        allowDifferentEmails: false,
        requireLocalEmailVerified: true,
      },
    },
    socialProviders: id.googleClientId && id.googleClientSecret
      ? { [GOOGLE_PROVIDER_ID]: { clientId: id.googleClientId, clientSecret: id.googleClientSecret, mapProfileToUser: googleProfileMapper(id.trustedProviders) } }
      : {},
    rateLimit: {
      enabled: guard.rateLimitEnabled,
      window: guard.rateLimitWindowSec,
      max: guard.rateLimitMax,
      storage: 'database' as const,
      customRules: {
        '/sign-in/*': signinRule,
        '/sign-up/*': signinRule,
        '/two-factor/*': { window: guard.twoFactorRateWindowSec, max: guard.twoFactorRateMax },
        '/request-password-reset': emailRule,
        '/send-verification-email': emailRule,
      },
    },
    plugins: [
      ...corePlugins(id, app),
      ...(id.mode === 'hybrid' && id.oidcProviderId && id.oidcDiscoveryUrl && id.oidcClientId && id.oidcClientSecret
        ? [genericOAuth({ config: [{
            providerId: id.oidcProviderId, discoveryUrl: id.oidcDiscoveryUrl, clientId: id.oidcClientId, clientSecret: id.oidcClientSecret,
            scopes: id.oidcScopes, mapProfileToUser: oidcProfileMapper(id.oidcProviderId, id.trustedProviders),
          }] })]
        : []),
    ],
    disabledPaths: [...IMPERSONATION_PATHS],
    hooks: input.hooks,
    databaseHooks: { user: { create: { after: async (user: { id: string }) => input.onUserCreated(user.id) } } },
    onAPIError: { throw: false, onError: (err: unknown) => input.onApiError(err) },
    logger: { log: (level: string, message: string) => input.log(level, message) },
    telemetry: { enabled: false },
  };
}
```
(Nếu S4a chọn fallback: thêm `rateLimit.customStorage` là một `RateLimiterPostgres` (bảng `login_attempts`, `keyPrefix: 'ip'`) bọc try/catch, ném `APIError('SERVICE_UNAVAILABLE')`; ghi lệch D2 vào ADR 0010.)

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/modules/identity && pnpm vitest run --project integration test/integration/identity/auth-emails.spec.ts && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS (`betterAuth(buildAuthOptions(...))` sẽ được kiểm kiểu ở Task 34; lỗi kiểu option phát hiện ở đó thì sửa ở đây).

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity test/unit/modules/identity/auth-options.spec.ts test/unit/modules/identity/profile-mapper.spec.ts test/integration/identity/auth-emails.spec.ts
git commit -m "feat(identity): better auth options per mode, fail-closed OAuth linking, idempotent auth emails"
```

---

### Task 34: Hook của Better Auth (chuẩn hoá email, độ mới session, ép thu hồi, lockout, chống lộ email, thông báo 2FA) và dựng instance

**Ghi chú sau review:** map lỗi sang problem+json KHÔNG nằm ở hook nữa mà ở `AuthMountMiddleware` (Task 36, review B2). Hook chỉ làm việc nghiệp vụ; response do hook tự tạo (lockout 429/503, 403 reauth) đã là problem+json và được mount giữ nguyên. Ba sửa của review: B4 (nhánh email đã có ở `/change-email` chỉ chạy khi đã có session), I5 (đăng ký song song: Better Auth đổi 23505 thành `FAILED_TO_CREATE_USER` không kèm cause → tra `IdentityDirectory`), I6 (chuẩn hoá email trong `hooks.before` trước khi Better Auth validate), M8 (thông báo "2FA bật" chỉ gửi khi lần xác minh TOTP đầu tiên thật sự bật 2FA).

**Files:**
- Create: `src/modules/identity/infra/better-auth/auth-request-state.ts`, `src/modules/identity/infra/better-auth/auth-hooks.ts`, `src/modules/identity/infra/better-auth/auth-instance.ts`
- Test: `test/integration/identity/auth-hooks.spec.ts`

**Interfaces:**
- Consumes: `buildAuthOptions`, `CLIENT_IP_HEADER` (Task 33); `withAccountCipher` (Task 28); `LoginLockout`, `LockoutBlockedError`, `LockoutUnavailableError`, `normalizeEmail` (Task 31); `mapAuthError`, `authUnavailable` (Task 29); `IdentityDirectory` (Task 27); `AuthEmails` (Task 33); `problemBody`, `PROBLEM_JSON` (Task 9); kết quả S1b, S4b, S7.
- Produces:
  - `AuthRequestState` (AsyncLocalStorage riêng của identity; `AuthMountMiddleware` mở quanh lời gọi handler): `run<T>(fn: () => T): T`, `addTicket(t: LockoutTicket)`, `takeTickets(): LockoutTicket[]`, `setTwoFactorBefore(v: { userId: string; sessionId: string; enabled: boolean })`, `twoFactorBefore(): { userId: string; sessionId: string; enabled: boolean } | undefined`.
  - `createAuthHooks(deps: AuthHookDeps): { before: AuthMiddleware; after: AuthMiddleware }`, `EMAIL_FIELDS_BY_PATH`.
  - `createAuthInstance(deps: AuthInstanceDeps)`, `type AuthInstance = ReturnType<typeof createAuthInstance>`, `BETTER_AUTH: symbol`, `maskEmails(message: string): string`.

- [ ] **Step 1: Viết test fail**

`test/integration/identity/auth-hooks.spec.ts`:
```ts
import { Logger, type INestApplication, Module } from '@nestjs/common';
import { URI } from 'otpauth';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule, databaseConfig } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { FieldCipher } from '../../../src/core/security/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { AuthEmails } from '../../../src/modules/identity/application/auth-emails.js';
import { authDatabaseConfig, identityConfig, identityGuardConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { AuthRequestState } from '../../../src/modules/identity/infra/better-auth/auth-request-state.js';
import { createAuthInstance, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { LoginLockout } from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import { PgIdentityDirectory } from '../../../src/modules/identity/infra/better-auth/pg-identity-directory.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const MAX_FAILURES = 3;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
@Module({ providers: [AuthEmails] })
class M {}

describe('Better Auth hooks against the real auth schema', () => {
  let app: INestApplication; let pool: pg.Pool; let owner: pg.Client; let auth: AuthInstance; const state = new AuthRequestState();
  /** Mô phỏng đúng cách `AuthMountMiddleware` gọi handler: trong `AuthRequestState.run`, IP do mình đặt. */
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
    state.run(() => auth.handler(new Request(`${ORIGIN}/api/auth${path}`, {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-app-client-ip': `203.0.113.${Math.floor(Math.random() * 250) + 1}`, ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
    })));
  const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const notices = async (like: string) => (await owner.query(`SELECT idempotency_key FROM email_deliveries WHERE idempotency_key LIKE $1`, [like])).rows.length;
  const idOf = async (email: string) => (await owner.query<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email])).rows[0]!.id;
  const verifiedUser = async () => {
    const email = `h-${v7()}@example.test`;
    await call('/sign-up/email', { body: { email, password: PASSWORD, name: 'H' } });
    await owner.query(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
    return email;
  };

  beforeAll(async () => {
    vi.stubEnv('AUTH_LOCKOUT_MAX_FAILURES', String(MAX_FAILURES));
    vi.stubEnv('AUTH_SESSION_FRESH_AGE_SEC', '60');
    vi.stubEnv('AUTH_SIGNIN_RATE_MAX', '1000');
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), NotificationsModule.forApi(), M]);
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    const guard = identityGuardConfig();
    auth = createAuthInstance({
      identity: identityConfig(), guard, app: { serviceName: 'svc' }, corsOrigins: [ORIGIN], pool,
      cipher: new FieldCipher({ k1: randomBytes(32).toString('base64') }, 'k1'),
      lockout: new LoginLockout(pool, { maxFailures: guard.lockoutMaxFailures, windowSec: guard.lockoutWindowSec, blockSec: guard.lockoutBlockSec }),
      emails: app.get(AuthEmails), directory: new PgIdentityDirectory(pool), state,
      onUserCreated: async () => undefined, requestId: () => 'r-hooks', problemTypeBase: '/errors', logger: new Logger('better-auth'),
    });
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await pool?.end(); await app?.close(); vi.unstubAllEnvs(); });

  it('sign-up: new and existing email get byte-identical 202 responses; the owner gets one notice', async () => {
    const email = `s-${v7()}@example.test`;
    const shape = async (r: Response) => ({ status: r.status, body: await r.text(), cookies: r.headers.getSetCookie() });
    const first = await shape(await call('/sign-up/email', { body: { email, password: PASSWORD, name: 'S' } }));
    const again = await shape(await call('/sign-up/email', { body: { email, password: PASSWORD, name: 'S' } }));
    expect(first).toEqual({ status: 202, body: '', cookies: [] });
    expect(again).toEqual(first);
    expect(await notices(`existing-account:${await idOf(email)}:%`)).toBe(1);
  });
  it('emails are normalized before Better Auth validates them (case + surrounding spaces)', async () => {
    const email = `n-${v7()}@example.test`;
    expect((await call('/sign-up/email', { body: { email: `  ${email.toUpperCase()} `, password: PASSWORD, name: 'N' } })).status).toBe(202);
    expect((await owner.query(`SELECT email FROM auth."user" WHERE email = $1`, [email])).rows).toHaveLength(1);
    await owner.query(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
    expect((await call('/sign-in/email', { body: { email: ` ${email.toUpperCase()}`, password: PASSWORD } })).status).toBe(200);
  });
  it('concurrent sign-ups with the same email all answer 202 and create exactly one user (FAILED_TO_CREATE_USER is treated as "exists")', async () => {
    const email = `race-${v7()}@example.test`;
    const results = await Promise.all(Array.from({ length: 5 }, () => call('/sign-up/email', { body: { email, password: PASSWORD, name: 'R' } })));
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect((await owner.query(`SELECT count(*)::int AS n FROM auth."user" WHERE email = $1`, [email])).rows[0].n).toBe(1);
  });
  it('a malformed sign-up (no name, bad email) stays an error, never the generic 202 (isAPIError covers better-call errors)', async () => {
    const r = await call('/sign-up/email', { body: { email: 'not-an-email', password: PASSWORD } });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('wrong password → 401 with the Better Auth code (mapping to problem+json happens in the mount, Task 36)', async () => {
    const email = await verifiedUser();
    const r = await call('/sign-in/email', { body: { email, password: 'wrong-password-123' } });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  });
  it('lockout: after MAX failures the account answers problem+json 429 with Retry-After without verifying; a success refunds', async () => {
    const email = await verifiedUser();
    for (let i = 0; i < MAX_FAILURES - 1; i++) await call('/sign-in/email', { body: { email, password: 'nope-nope-nope' } });
    expect((await call('/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(200);
    await call('/sign-in/email', { body: { email, password: 'nope-nope-nope' } });
    await call('/sign-in/email', { body: { email, password: 'nope-nope-nope' } });
    const blocked = await call('/sign-in/email', { body: { email, password: PASSWORD } });
    expect([blocked.status, blocked.headers.get('content-type')]).toEqual([429, expect.stringContaining('application/problem+json')]);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
  it('lockout storage failure → 503 problem+json with Retry-After, never 500', async () => {
    const email = await verifiedUser();
    await owner.query('REVOKE INSERT, UPDATE ON auth.login_attempts FROM auth_user');
    try {
      const r = await call('/sign-in/email', { body: { email, password: PASSWORD } });
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBe(String(identityGuardConfig().unavailableRetryAfterSec));
    } finally {
      await owner.query('GRANT INSERT, UPDATE ON auth.login_attempts TO auth_user');
    }
  });
  it('change-password always revokes other sessions, even if the client asks not to', async () => {
    const email = await verifiedUser();
    const a = cookieOf(await call('/sign-in/email', { body: { email, password: PASSWORD } }));
    const b = cookieOf(await call('/sign-in/email', { body: { email, password: PASSWORD } }));
    const r = await call('/change-password', { cookie: a, body: { currentPassword: PASSWORD, newPassword: 'a brand new passphrase', revokeOtherSessions: false } });
    expect(r.status).toBe(200);
    expect(await (await call('/get-session', { method: 'GET', cookie: b })).json()).toBeNull();
  });
  it('a stale session gets 403 reauthentication_required on sensitive operations', async () => {
    const email = await verifiedUser();
    const c = cookieOf(await call('/sign-in/email', { body: { email, password: PASSWORD } }));
    await owner.query(`UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`, [email]);
    const r = await call('/change-password', { cookie: c, body: { currentPassword: PASSWORD, newPassword: 'another passphrase ok' } });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'reauthentication_required' });
  });
  it('change-email ANONYMOUS: taken and free targets give the same 401, and nobody is notified (no oracle)', async () => {
    const taken = await verifiedUser();
    const before = await notices(`existing-account:${await idOf(taken)}:%`);
    const shape = async (r: Response) => ({ status: r.status, body: (await r.text()).replace(/"requestId":"[^"]*"|"timestamp":"[^"]*"/g, '') });
    const a = await shape(await call('/change-email', { body: { newEmail: taken } }));
    const b = await shape(await call('/change-email', { body: { newEmail: `free-${v7()}@example.test` } }));
    expect(a.status).toBe(401);
    expect(b).toEqual(a);
    expect(await notices(`existing-account:${await idOf(taken)}:%`)).toBe(before);
  });
  it('change-email AUTHENTICATED to a taken address: generic 202, notice to the target owner, no change', async () => {
    const taken = await verifiedUser();
    const email = await verifiedUser();
    const c = cookieOf(await call('/sign-in/email', { body: { email, password: PASSWORD } }));
    const r = await call('/change-email', { cookie: c, body: { newEmail: ` ${taken.toUpperCase()}` } });
    expect([r.status, await r.text()]).toEqual([202, '']);
    expect(await notices(`existing-account:${await idOf(taken)}:%`)).toBe(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM auth."user" WHERE email = $1`, [email])).rows[0].n).toBe(1);
  });
  it('2FA notice: none on /two-factor/enable, one "enabled" notice once the first TOTP verification turns it on', async () => {
    const email = await verifiedUser();
    const id = await idOf(email);
    const c = cookieOf(await call('/sign-in/email', { body: { email, password: PASSWORD } }));
    const en = await call('/two-factor/enable', { cookie: c, body: { password: PASSWORD } });
    expect(en.status).toBe(200);
    expect(await notices(`two-factor-changed:${id}:%`)).toBe(0);
    const totp = URI.parse((await en.json()).totpURI);
    expect((await call('/two-factor/verify-totp', { cookie: c, body: { code: totp.generate() } })).status).toBe(200);
    expect(await notices(`two-factor-changed:${id}:%:enabled`)).toBe(1);
  });
});
```
(`/get-session`, `/change-password`, `/change-email`, `/two-factor/enable|verify-totp` và tên trường body lấy theo `better-auth/dist/api/routes/*.mjs` và `plugins/two-factor/index.mjs`.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/identity/auth-hooks.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/infra/better-auth/auth-request-state.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LockoutTicket } from './login-lockout.js';

type TwoFactorBefore = { userId: string; sessionId: string; enabled: boolean };
type State = { tickets: LockoutTicket[]; twoFactorBefore?: TwoFactorBefore };

/**
 * Trạng thái theo request giữa hook `before` và `after` (khoá lockout đã consume, trạng thái 2FA trước khi
 * xác minh). AsyncLocalStorage riêng, mở bởi `AuthMountMiddleware` quanh `auth.handler`, nên không phụ thuộc
 * CLS của Nest (S1b). Lời gọi `auth.api.*` từ server (không qua mount) không có state: hook bỏ qua bookkeeping.
 */
export class AuthRequestState {
  private readonly als = new AsyncLocalStorage<State>();

  run<T>(fn: () => T): T {
    return this.als.run({ tickets: [] }, fn);
  }
  addTicket(t: LockoutTicket): void {
    this.als.getStore()?.tickets.push(t);
  }
  takeTickets(): LockoutTicket[] {
    const s = this.als.getStore();
    return s ? s.tickets.splice(0) : [];
  }
  setTwoFactorBefore(v: TwoFactorBefore): void {
    const s = this.als.getStore();
    if (s) s.twoFactorBefore = v;
  }
  twoFactorBefore(): TwoFactorBefore | undefined {
    return this.als.getStore()?.twoFactorBefore;
  }
}
```
`src/modules/identity/infra/better-auth/auth-hooks.ts`:
```ts
import { createAuthMiddleware, getSessionFromCtx, isAPIError, type AuthMiddleware } from 'better-auth/api';
import { createHash } from 'node:crypto';
import { AppError, PROBLEM_JSON, problemBody } from '../../../../core/errors/index.js';
import type { AuthEmails } from '../../application/auth-emails.js';
import { IdentityErrors } from '../../errors.js';
import type { IdentityDirectory } from '../../ports/identity-directory.js';
import { authUnavailable, mapAuthError } from './auth-error.mapper.js';
import type { AuthRequestState } from './auth-request-state.js';
import { normalizeEmail } from './email-normalize.js';
import { LockoutBlockedError, LockoutUnavailableError, type LockoutScope, type LoginLockout } from './login-lockout.js';

const MS_PER_SECOND = 1000;
const ACCEPTED = 202;
const FIRST_ERROR_STATUS = 400;
const SIGN_IN = '/sign-in/email';
const SIGN_UP = '/sign-up/email';
const CHANGE_EMAIL = '/change-email';
const CHANGE_PASSWORD = '/change-password';
const VERIFY_TOTP = '/two-factor/verify-totp';
const DISABLE_2FA = '/two-factor/disable';
const TWO_FACTOR_VERIFY = new Set([VERIFY_TOTP, '/two-factor/verify-backup-code', '/two-factor/verify-otp']);
/** Thao tác nhạy cảm cần session mới (spec §5.6.4); `sensitiveSessionMiddleware` không kiểm độ mới (A.5). */
const SENSITIVE = new Set([CHANGE_PASSWORD, CHANGE_EMAIL, '/two-factor/enable', DISABLE_2FA, '/api-key/create']);
const TWO_FACTOR_COOKIE = 'two_factor';
const FAILED_TO_CREATE_USER = 'FAILED_TO_CREATE_USER';
/** Trường email được chuẩn hoá trước khi Better Auth validate (review I6, Review Focus 1). */
export const EMAIL_FIELDS_BY_PATH: Readonly<Record<string, string>> = {
  [SIGN_UP]: 'email',
  [SIGN_IN]: 'email',
  '/request-password-reset': 'email',
  '/send-verification-email': 'email',
  [CHANGE_EMAIL]: 'newEmail',
};

export type AuthHookDeps = {
  freshAgeSec: number;
  unavailableRetryAfterSec: number;
  lockout: LoginLockout;
  state: AuthRequestState;
  emails: AuthEmails;
  directory: IdentityDirectory;
  requestId(): string;
  problemTypeBase: string;
};

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {});
const stringField = (v: unknown, key: string): string | undefined => {
  const r = asRecord(v)[key];
  return typeof r === 'string' ? r : undefined;
};
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function createAuthHooks(d: AuthHookDeps): { before: AuthMiddleware; after: AuthMiddleware } {
  const problem = (path: string, err: AppError) =>
    new Response(JSON.stringify(problemBody(err, { instance: path, requestId: d.requestId(), typeBase: d.problemTypeBase }, true)), {
      status: err.error.status,
      headers: { 'content-type': PROBLEM_JSON, ...(err.opts.headers ?? {}) },
    });

  /** consume TRƯỚC khi xác minh (spec §5.7); bị khoá → 429, storage lỗi → 503, không bao giờ cho qua. */
  const guard = async (path: string, scope: LockoutScope): Promise<Response | undefined> => {
    try {
      d.state.addTicket(await d.lockout.guard(scope));
      return undefined;
    } catch (err) {
      if (err instanceof LockoutBlockedError) return problem(path, mapAuthError({ status: 429, retryAfter: String(err.retryAfterSec) }, { unavailableRetryAfterSec: d.unavailableRetryAfterSec }));
      if (err instanceof LockoutUnavailableError) return problem(path, authUnavailable(d.unavailableRetryAfterSec));
      throw err;
    }
  };
  const noticeIfExists = async (email: string | undefined): Promise<boolean> => {
    const existing = email ? await d.directory.findUserByEmail(normalizeEmail(email)) : undefined;
    if (existing) await d.emails.existingAccount({ user: existing });
    return existing !== undefined;
  };

  const before = createAuthMiddleware(async (ctx) => {
    const body = asRecord(ctx.body);
    let changed = false;
    const emailField = EMAIL_FIELDS_BY_PATH[ctx.path];
    const rawEmail = emailField ? stringField(body, emailField) : undefined;
    if (emailField && rawEmail !== undefined) {
      body[emailField] = normalizeEmail(rawEmail);
      changed = true;
    }
    const session = SENSITIVE.has(ctx.path) || ctx.path === VERIFY_TOTP ? await getSessionFromCtx(ctx) : null;
    if (SENSITIVE.has(ctx.path) && session && Date.now() - new Date(session.session.createdAt).getTime() > d.freshAgeSec * MS_PER_SECOND)
      return problem(ctx.path, new AppError(IdentityErrors.REAUTHENTICATION_REQUIRED));
    if (ctx.path === SIGN_IN) {
      const blocked = await guard(ctx.path, { kind: 'signin', email: stringField(body, 'email') ?? '' });
      if (blocked) return blocked;
    }
    if (TWO_FACTOR_VERIFY.has(ctx.path)) {
      // Khoá 2FA theo user (S4b): cookie `two_factor` đã ký trỏ tới bản ghi verification mà `value` là user id.
      // Không đọc được thì khoá theo băm của cookie: vẫn chặn brute force trên lần đăng nhập đó.
      const name = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name;
      const identifier = await ctx.getSignedCookie(name, ctx.context.secret);
      const pending = identifier ? await ctx.context.internalAdapter.findVerificationValue(identifier) : null;
      const subject = pending?.value ? `user:${pending.value}` : session ? `user:${session.user.id}` : `cookie:${sha256(ctx.getCookie(name) ?? '')}`;
      const blocked = await guard(ctx.path, { kind: '2fa', subject });
      if (blocked) return blocked;
    }
    if (ctx.path === VERIFY_TOTP && session)
      d.state.setTwoFactorBefore({ userId: session.user.id, sessionId: session.session.id, enabled: session.user.twoFactorEnabled === true });
    // B4: tra email đích CHỈ khi đã có session hợp lệ và mới; ẩn danh đi tiếp để endpoint trả 401 (không oracle).
    if (ctx.path === CHANGE_EMAIL && session && (await noticeIfExists(stringField(body, 'newEmail'))))
      return new Response(null, { status: ACCEPTED });
    if (ctx.path === CHANGE_PASSWORD) {
      body.revokeOtherSessions = true;
      changed = true;
    }
    return changed ? { context: { body } } : undefined;
  });

  const after = createAuthMiddleware(async (ctx) => {
    const returned = ctx.context.returned;
    // Review NI1: lỗi validate body là `APIError` của better-call (lớp CHA), không phải lớp con của
    // `better-auth/api`, nên `instanceof` bỏ sót. `isAPIError` (better-auth/api, 1.7.6: kiểm cả hai lớp + name)
    // bắt cả hai; nếu bỏ sót, sign-up sai định dạng bị trả 202 rỗng.
    const failed = isAPIError(returned) && returned.statusCode >= FIRST_ERROR_STATUS;
    if (!failed && (ctx.path === SIGN_IN || TWO_FACTOR_VERIFY.has(ctx.path)))
      for (const t of d.state.takeTickets()) await d.lockout.refund(t);
    const prior = d.state.twoFactorBefore();
    if (!failed && ctx.path === VERIFY_TOTP && prior && !prior.enabled) {
      const user = await d.directory.findUser(prior.userId);
      if (user?.twoFactorEnabled) await d.emails.twoFactorChanged(user, prior.sessionId, true);
    }
    if (!failed && ctx.path === DISABLE_2FA && ctx.context.session)
      await d.emails.twoFactorChanged(ctx.context.session.user, ctx.context.session.session.id, false);
    if (ctx.path === SIGN_UP) {
      if (!failed) return new Response(null, { status: ACCEPTED });
      // I5: hai đăng ký song song → UNIQUE(email) → Better Auth trả FAILED_TO_CREATE_USER (không cause). Tra lại:
      // có user thì đây là "email đã có" → thông báo + cùng 202 (spec §5.8).
      const code = isAPIError(returned) ? stringField(returned.body, 'code') : undefined;
      if (code === FAILED_TO_CREATE_USER && (await noticeIfExists(stringField(ctx.body, 'email')))) return new Response(null, { status: ACCEPTED });
      return undefined;
    }
    if (!failed && ctx.path === CHANGE_EMAIL) return new Response(null, { status: ACCEPTED });
    return undefined;
  });

  return { before, after };
}
```
(`createAuthCookie`, `getSignedCookie`, `getCookie`, `internalAdapter.findVerificationValue` đối chiếu `.d.mts` và kết quả S4b; `new Response(null, { status: 202 })` theo S7. Nếu S7 cho thấy `ctx.body` ở after-hook là body gốc (chưa chuẩn hoá) thì `noticeIfExists` vẫn đúng vì tự chuẩn hoá.)

`src/modules/identity/infra/better-auth/auth-instance.ts`:
```ts
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import type { Logger } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import type { FieldCipher } from '../../../../core/security/index.js';
import type { AuthEmails } from '../../application/auth-emails.js';
import type { IdentityConfig, IdentityGuardConfig } from '../../identity.config.js';
import type { IdentityDirectory } from '../../ports/identity-directory.js';
import { withAccountCipher } from './account-cipher.adapter.js';
import { createAuthHooks } from './auth-hooks.js';
import { buildAuthOptions } from './auth-options.js';
import type { AuthRequestState } from './auth-request-state.js';
import type { LoginLockout } from './login-lockout.js';

export const BETTER_AUTH = Symbol('identity.betterAuth');
const EMAIL_LIKE = /[^\s@<>"']+@[^\s@<>"']+/g;
/** Message của Better Auth có thể chứa email: thay trước khi log (spec §5.14). */
export const maskEmails = (message: string): string => message.replace(EMAIL_LIKE, '[email]');

export type AuthInstanceDeps = {
  identity: IdentityConfig;
  guard: IdentityGuardConfig;
  app: { serviceName: string };
  corsOrigins: readonly string[];
  pool: pg.Pool;
  cipher: FieldCipher;
  lockout: LoginLockout;
  emails: AuthEmails;
  directory: IdentityDirectory;
  state: AuthRequestState;
  onUserCreated(userId: string): Promise<void>;
  requestId(): string;
  problemTypeBase: string;
  logger: Logger;
};

export function createAuthInstance(d: AuthInstanceDeps) {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: d.pool }), plugins: [new CamelCasePlugin()] });
  return betterAuth(
    buildAuthOptions({
      identity: d.identity,
      guard: d.guard,
      app: d.app,
      corsOrigins: d.corsOrigins,
      database: (opts) => withAccountCipher(kyselyAdapter(db, { type: 'postgres', transaction: true })(opts), d.cipher),
      hooks: createAuthHooks({
        freshAgeSec: d.identity.sessionFreshAgeSec,
        unavailableRetryAfterSec: d.guard.unavailableRetryAfterSec,
        lockout: d.lockout,
        state: d.state,
        emails: d.emails,
        directory: d.directory,
        requestId: d.requestId,
        problemTypeBase: d.problemTypeBase,
      }),
      emails: d.emails,
      onUserCreated: d.onUserCreated,
      // Chỉ quan sát (A.5): log mã lỗi, không bao giờ message/body (spec §5.14). Map lỗi ở Task 36.
      onApiError: (err) => {
        const body = typeof err === 'object' && err !== null && 'body' in err ? err.body : undefined;
        const code = typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : undefined;
        d.logger.warn({ source: 'better-auth', code, event: 'better_auth_api_error' });
      },
      log: (level, message) => d.logger.warn({ source: 'better-auth', level, message: maskEmails(message) }),
    }),
  );
}
export type AuthInstance = ReturnType<typeof createAuthInstance>;
```
(Không `db.destroy()`: pool thuộc `AuthPoolLifecycle`, đóng hai lần sẽ lỗi.)

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/identity/auth-hooks.spec.ts && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS. Lỗi kiểu ở `betterAuth(buildAuthOptions(...))` → sửa `auth-options.ts` (Task 33) theo `.d.mts`, không cast.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity/infra/better-auth test/integration/identity/auth-hooks.spec.ts
git commit -m "feat(identity): better auth hooks (email normalization, freshness, forced revocation, lockout, session-gated anti-enumeration, 2fa notices) and instance factory"
```

---

### Task 35: Port `AuthProvider`, `BetterAuthProvider`, module lõi của Better Auth

**Files:**
- Create: `src/modules/identity/ports/auth-provider.ts`, `src/modules/identity/infra/better-auth/better-auth.provider.ts`, `src/modules/identity/infra/better-auth/better-auth-core.module.ts`
- Test: `test/integration/identity/better-auth-provider.spec.ts`

**Interfaces:**
- Consumes: `createAuthInstance`, `BETTER_AUTH`, `AuthRequestState` (Task 34); `authPoolProviders`, `PgIdentityDirectory`, `PgRegistrationLedger`, `AuthDatabaseReadiness` (Task 27); `PgAuthHousekeeping`, `RegisteredEventService` (Task 32); `AuthEmails` (Task 33); `LoginLockout`, `LOGIN_LOCKOUT` (Task 31); `isAuthInfraError` (Task 29); `hasAdminRole`, `isBanned` (Task 27); `DetectedCredential` (Task 30).
- Produces:
  - `type AuthResult = { kind: 'ANONYMOUS' } | { kind: 'AUTHENTICATED'; principal: Principal; credential: Credential; isPlatformAdmin: boolean } | { kind: 'REJECTED' } | { kind: 'UNAVAILABLE' }`, `abstract class AuthProvider { authenticate(input: { headers: Headers; credential: DetectedCredential }): Promise<AuthResult> }` (`identity/ports/auth-provider.ts`).
  - `BetterAuthProvider` (cookie/bearer → `getSession`; API key → `verifyApiKey` + kiểm ban qua `IdentityDirectory`; lỗi hạ tầng → `UNAVAILABLE`).
  - `BetterAuthCoreModule` (`@Global`): export `AUTH_POOL`, `BETTER_AUTH`, `AuthProvider`, `IdentityDirectory`, `RegistrationLedger`, `AuthHousekeeping`, `AuthRequestState`, `LOGIN_LOCKOUT`, `AuthEmails`, `RegisteredEventService`; đăng ký `AuthDatabaseReadiness`.

- [ ] **Step 1: Viết test fail**

`test/integration/identity/better-auth-provider.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { BetterAuthCoreModule } from '../../../src/modules/identity/infra/better-auth/better-auth-core.module.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const PASSWORD = 'correct horse battery';
describe('BetterAuthProvider', () => {
  let app: INestApplication; let owner: pg.Client; let auth: AuthInstance; let provider: AuthProvider;
  const user = async (role?: string) => {
    const email = `p-${v7()}@example.test`;
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'P' } });
    await owner.query(`UPDATE auth."user" SET email_verified = true, role = coalesce($2, role) WHERE email = $1`, [email, role ?? null]);
    const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
    return { email, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), bearer: res.headers.get('set-auth-token') ?? '' };
  };
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), NotificationsModule.forApi(), BetterAuthCoreModule]);
    auth = app.get(BETTER_AUTH); provider = app.get(AuthProvider);
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); });

  it('session cookie and bearer authenticate the same user; admin role flag', async () => {
    const u = await user('admin');
    const viaCookie = await provider.authenticate({ headers: new Headers({ cookie: u.cookie }), credential: { kind: 'SESSION_COOKIE', value: 'x' } });
    const viaBearer = await provider.authenticate({ headers: new Headers({ authorization: `Bearer ${u.bearer}` }), credential: { kind: 'BEARER_SESSION', value: u.bearer } });
    expect(viaCookie).toMatchObject({ kind: 'AUTHENTICATED', principal: { type: 'user' }, credential: { kind: 'SESSION_COOKIE' }, isPlatformAdmin: true });
    expect(viaBearer).toMatchObject({ kind: 'AUTHENTICATED', credential: { kind: 'BEARER_SESSION' } });
  });
  it('API key authenticates as its owning user, carries the key id, never admin; banned owner → REJECTED', async () => {
    const u = await user('admin');
    const created = await auth.api.createApiKey({ body: { name: 'ci' }, headers: new Headers({ cookie: u.cookie }) });
    const r = await provider.authenticate({ headers: new Headers(), credential: { kind: 'API_KEY', value: created.key } });
    expect(r).toMatchObject({ kind: 'AUTHENTICATED', credential: { kind: 'API_KEY', id: created.id }, isPlatformAdmin: false });
    await owner.query(`UPDATE auth."user" SET banned = true, ban_expires = NULL WHERE email = $1`, [u.email]);
    expect(await provider.authenticate({ headers: new Headers(), credential: { kind: 'API_KEY', value: created.key } })).toEqual({ kind: 'REJECTED' });
  });
  it('garbage and empty credentials are REJECTED, external kinds are REJECTED in local mode', async () => {
    for (const credential of [{ kind: 'API_KEY' as const, value: '' }, { kind: 'API_KEY' as const, value: 'nope' }, { kind: 'EXTERNAL_BEARER' as const, value: 'x' }])
      expect(await provider.authenticate({ headers: new Headers(), credential })).toEqual({ kind: 'REJECTED' });
    expect(await provider.authenticate({ headers: new Headers({ cookie: 'svc.session_token=bogus' }), credential: { kind: 'SESSION_COOKIE', value: 'bogus' } })).toEqual({ kind: 'REJECTED' });
  });
});
```
(`createApiKey` trả `{ id, key, … }` — đối chiếu kiểu của `@better-auth/api-key`.)

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/identity/better-auth-provider.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/ports/auth-provider.ts`:
```ts
import type { Credential, Principal } from '../../../core/context/index.js';
import type { DetectedCredential } from '../http/credential-detector.js';

/** Spec §5.6.3: `switch` vét cạn ở mọi nơi dùng. */
export type AuthResult =
  | { kind: 'ANONYMOUS' }
  | { kind: 'AUTHENTICATED'; principal: Principal; credential: Credential; isPlatformAdmin: boolean }
  | { kind: 'REJECTED' }
  | { kind: 'UNAVAILABLE' };

export abstract class AuthProvider {
  abstract authenticate(input: { headers: Headers; credential: DetectedCredential }): Promise<AuthResult>;
}
```
`src/modules/identity/infra/better-auth/better-auth.provider.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { hasAdminRole, isBanned, IdentityDirectory } from '../../ports/identity-directory.js';
import { AuthProvider, type AuthResult } from '../../ports/auth-provider.js';
import type { DetectedCredential } from '../../http/credential-detector.js';
import { BETTER_AUTH, type AuthInstance } from './auth-instance.js';
import { isAuthInfraError } from './auth-error.mapper.js';

const REJECTED: AuthResult = { kind: 'REJECTED' };
const UNAVAILABLE: AuthResult = { kind: 'UNAVAILABLE' };

/** Không cache session (D1): mỗi request một lookup theo khoá unique, nên thu hồi có hiệu lực ngay. */
@Injectable()
export class BetterAuthProvider extends AuthProvider {
  constructor(
    @Inject(BETTER_AUTH) private readonly auth: AuthInstance,
    private readonly directory: IdentityDirectory,
  ) {
    super();
  }

  async authenticate(input: { headers: Headers; credential: DetectedCredential }): Promise<AuthResult> {
    const { credential } = input;
    try {
      switch (credential.kind) {
        case 'SESSION_COOKIE':
        case 'BEARER_SESSION':
          return await this.session(input.headers, credential.kind);
        case 'API_KEY':
          return await this.apiKey(credential.value);
        case 'EXTERNAL_COOKIE':
        case 'EXTERNAL_BEARER':
          return REJECTED;
        default: {
          const unknown: never = credential.kind;
          throw new Error(`unknown credential kind ${String(unknown)}`);
        }
      }
    } catch (err) {
      if (isAuthInfraError(err)) return UNAVAILABLE;
      throw err;
    }
  }

  private async session(headers: Headers, kind: 'SESSION_COOKIE' | 'BEARER_SESSION'): Promise<AuthResult> {
    const s = await this.auth.api.getSession({ headers });
    if (!s) return REJECTED;
    return { kind: 'AUTHENTICATED', principal: { type: 'user', id: s.user.id }, credential: { kind }, isPlatformAdmin: hasAdminRole(s.user.role) };
  }

  /** Plugin api-key không kiểm ban (A.7): nạp chủ key và từ chối nếu không còn hoặc đang bị ban. */
  private async apiKey(key: string): Promise<AuthResult> {
    if (!key) return REJECTED;
    const r = await this.auth.api.verifyApiKey({ body: { key } });
    if (!r.valid || !r.key) return REJECTED;
    const owner = await this.directory.findUser(r.key.referenceId);
    if (!owner || isBanned(owner, new Date())) return REJECTED;
    return { kind: 'AUTHENTICATED', principal: { type: 'user', id: owner.id }, credential: { kind: 'API_KEY', id: r.key.id }, isPlatformAdmin: false };
  }
}
```
`src/modules/identity/infra/better-auth/better-auth-core.module.ts`:
```ts
import { Global, Logger, Module } from '@nestjs/common';
import type pg from 'pg';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { RequestContext } from '../../../../core/context/index.js';
import { errorsConfig } from '../../../../core/errors/index.js';
import { httpConfig } from '../../../../core/http/index.js';
import { FieldCipher, SecurityModule } from '../../../../core/security/index.js';
import { AuthEmails } from '../../application/auth-emails.js';
import { RegisteredEventService } from '../../application/registered-event.service.js';
import { identityConfig, identityGuardConfig, type IdentityConfig, type IdentityGuardConfig } from '../../identity.config.js';
import { AuthHousekeeping } from '../../ports/auth-housekeeping.js';
import { AuthProvider } from '../../ports/auth-provider.js';
import { IdentityDirectory } from '../../ports/identity-directory.js';
import { RegistrationLedger } from '../../ports/registration-ledger.js';
import { BETTER_AUTH, createAuthInstance } from './auth-instance.js';
import { AUTH_POOL, authPoolProviders } from './auth-pool.provider.js';
import { AuthDatabaseReadiness } from './auth-readiness.js';
import { AuthRequestState } from './auth-request-state.js';
import { BetterAuthProvider } from './better-auth.provider.js';
import { LOGIN_LOCKOUT, LoginLockout } from './login-lockout.js';
import { PgAuthHousekeeping } from './pg-auth-housekeeping.js';
import { PgIdentityDirectory } from './pg-identity-directory.js';
import { PgRegistrationLedger } from './pg-registration-ledger.js';

/** Pool `auth_user`, instance Better Auth và các adapter; dùng ở api (kèm mount HTTP) và worker (không mount). */
@Global()
@Module({
  imports: [SecurityModule],
  providers: [
    ...authPoolProviders,
    PgIdentityDirectory,
    { provide: IdentityDirectory, useExisting: PgIdentityDirectory },
    PgRegistrationLedger,
    { provide: RegistrationLedger, useExisting: PgRegistrationLedger },
    PgAuthHousekeeping,
    { provide: AuthHousekeeping, useExisting: PgAuthHousekeeping },
    { provide: AuthRequestState, useValue: new AuthRequestState() },
    {
      provide: LOGIN_LOCKOUT,
      inject: [AUTH_POOL, identityGuardConfig.KEY],
      useFactory: (pool: pg.Pool, g: IdentityGuardConfig) => new LoginLockout(pool, { maxFailures: g.lockoutMaxFailures, windowSec: g.lockoutWindowSec, blockSec: g.lockoutBlockSec }),
    },
    AuthEmails,
    RegisteredEventService,
    {
      provide: BETTER_AUTH,
      inject: [identityConfig.KEY, identityGuardConfig.KEY, appConfig.KEY, httpConfig.KEY, errorsConfig.KEY, AUTH_POOL, FieldCipher, LOGIN_LOCKOUT, AuthEmails, IdentityDirectory, AuthRequestState, RegisteredEventService, RequestContext],
      useFactory: (
        identity: IdentityConfig, guard: IdentityGuardConfig, app: ConfigOf<typeof appConfig>, http: ConfigOf<typeof httpConfig>,
        errors: ConfigOf<typeof errorsConfig>, pool: pg.Pool, cipher: FieldCipher, lockout: LoginLockout, emails: AuthEmails,
        directory: IdentityDirectory, state: AuthRequestState, registered: RegisteredEventService, ctx: RequestContext,
      ) => createAuthInstance({
        identity, guard, app, corsOrigins: http.corsOrigins, pool, cipher, lockout, emails, directory, state,
        onUserCreated: (userId) => registered.onUserCreated(userId),
        requestId: () => ctx.requestId(),
        problemTypeBase: errors.problemTypeBase,
        logger: new Logger('better-auth'),
      }),
    },
    BetterAuthProvider,
    { provide: AuthProvider, useExisting: BetterAuthProvider },
    AuthDatabaseReadiness,
  ],
  exports: [AUTH_POOL, BETTER_AUTH, AuthProvider, IdentityDirectory, RegistrationLedger, AuthHousekeeping, AuthRequestState, LOGIN_LOCKOUT, AuthEmails, RegisteredEventService],
})
export class BetterAuthCoreModule {}
```
(`errorsConfig` là export của `core/errors/index.ts`; `httpConfig` của `core/http/index.ts`.)

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/identity && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity test/integration/identity/better-auth-provider.spec.ts
git commit -m "feat(identity): AuthProvider port with better auth adapter (cookie, bearer, api key with ban check)"
```

---

### Task 36: Tự mount `/api/auth/*` (`AuthMountMiddleware`), map mọi lỗi sang problem+json, đăng xuất của mình

**Lý do (review B2):** lỗi của Better Auth có ba đường không qua `hooks.after`: 429 của rate limit IP trả thẳng `Response` ở `onRequest`; lỗi storage rate limit / `checkSchema` ném ở `onRequest` ngoài try/catch của router nên `auth.handler` **reject**; lỗi không phải `APIError` trong endpoint thành `Response` 500. Vì vậy map lỗi đặt ở **một chỗ duy nhất quanh `auth.handler`**: bắt mọi reject (→ `503` fail-closed), hậu xử lý mọi `Response` ≥ 400 chưa phải problem+json (đọc `code`, `X-Retry-After` → `Retry-After`, giữ `Set-Cookie`), `Response` ≥ 500 thì thử pool auth để phân biệt `503` (DB auth không dùng được) với `500`. Middleware không bao giờ trả promise treo hay gọi `next()` cho `/api/auth/*`: không thể có unhandled rejection, không có đường rơi về handler gốc.

**Files:**
- Create: `src/modules/identity/infra/better-auth/auth-mount.middleware.ts`, `src/modules/identity/infra/better-auth/sign-out.ts`, `src/modules/identity/infra/better-auth/better-auth-api.module.ts`, `src/modules/identity/identity-metrics.ts`, `src/modules/identity/http/web-headers.ts`, `test/support/auth-client.ts`
- Test: `test/e2e/identity/auth-mount.e2e.spec.ts`

**Interfaces:**
- Consumes: `jsonBodyParser`, `writeProblem`, `HTTP_BODY_PARSER_SKIP_PREFIX`, `httpConfig` (Task 9, 10); `PROBLEM_JSON`, `AppError`, `CoreErrors`, `toAppError`, `errorsConfig` (SP1 + Task 9); `detectCredentials`, `detectionConfigOf`, `csrfAllows`, `trustedOriginList`, `UNSAFE_METHODS` (Task 30); `BetterAuthCoreModule`, `BETTER_AUTH`, `AUTH_POOL`, `AuthRequestState` (Task 27, 34, 35); `CLIENT_IP_HEADER` (Task 33); `mapAuthError`, `authUnavailable` (Task 29); `IdentityErrors` (Task 29); kết quả S1 (a, e, f).
- Produces:
  - `AuthMountMiddleware implements NestMiddleware`: `use(req, res): void` — 6 bước của spec §5.5 (đa credential/trùng → CSRF → parser → IP → sign-out → handler) trong `AuthRequestState.run`; mọi lỗi → problem+json.
  - `SignOutHandler.handle(res: ServerResponse, credentials: DetectedCredential[], ctx: { origin?: string; meta: ProblemMeta; retryAfterSec: number }): Promise<void>` — thu hồi từng credential, kiểm lại bằng `getSession`; bất kỳ lỗi nào hoặc còn session → `503`, không bao giờ báo thành công.
  - `toWebHeaders(req: IncomingMessage): Headers` (`identity/http/web-headers.ts`; Task 37, 45 dùng lại).
  - `IdentityMetrics` (`identity_sign_in_total{result}`, `identity_auth_unavailable_total`, `identity_ambiguous_credentials_total`, `identity_csrf_rejected_total`) và `IdentityMetricsModule` (`@Global`) trong `identity/identity-metrics.ts`.
  - `BetterAuthApiModule` (`@Global`): `configure()` mount `AuthMountMiddleware` cho `${AUTH_BASE_PATH}/{*path}`, cung cấp `HTTP_BODY_PARSER_SKIP_PREFIX = AUTH_BASE_PATH`.
  - `test/support/auth-client.ts`: `class AuthClient { constructor(server: Server, origin?: string, opts?: { ip?: string }); cookies; bearer; request(method, path, opts?); signUp; signIn; verifyEmailFromMailpit }` — mỗi client có IP riêng qua `X-Forwarded-For` (app test chạy `HTTP_TRUST_PROXY=loopback`) để bucket rate limit IP không dính giữa test.

- [ ] **Step 1: Viết test fail**

`test/support/auth-client.ts`:
```ts
import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import type { Mailpit } from './mailpit.js';

export const TEST_ORIGIN = 'http://localhost:3000';
/** Dải 198.18.0.0/15 (benchmark, RFC 2544): mỗi client một IP, để rate limit IP của Better Auth không dính giữa test. */
const randomTestIp = () => `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
type Opts = { body?: unknown; origin?: string | null; bearer?: string; apiKey?: string; cookie?: string | false; headers?: Record<string, string> };

/** Client e2e: cookie jar tường minh (thấy mọi `Set-Cookie`), Origin tin cậy mặc định, IP riêng. */
export class AuthClient {
  readonly cookies = new Map<string, string>();
  bearer: string | undefined;
  readonly ip: string;
  constructor(private readonly server: Server, private readonly origin = TEST_ORIGIN, opts: { ip?: string } = {}) {
    this.ip = opts.ip ?? randomTestIp();
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res: Response): void {
    const raw = res.headers['set-cookie'];
    for (const c of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const [pair = ''] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === '' || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const token = res.headers['set-auth-token'];
    if (typeof token === 'string') this.bearer = token;
  }
  async request(method: 'get' | 'post' | 'patch' | 'delete', path: string, o: Opts = {}): Promise<Response> {
    let r = request(this.server)[method](path).set('x-forwarded-for', this.ip);
    if (o.origin !== null) r = r.set('origin', o.origin ?? this.origin);
    const cookie = o.cookie === undefined ? this.cookieHeader() : o.cookie;
    if (cookie) r = r.set('cookie', cookie);
    if (o.bearer) r = r.set('authorization', `Bearer ${o.bearer}`);
    if (o.apiKey !== undefined) r = r.set('x-api-key', o.apiKey);
    for (const [k, v] of Object.entries(o.headers ?? {})) r = r.set(k, v);
    const res = o.body === undefined ? await r : await r.send(o.body as object);
    this.absorb(res);
    return res;
  }
  signUp(email: string, password: string, name = 'Test User') {
    return this.request('post', '/api/auth/sign-up/email', { body: { email, password, name }, cookie: false });
  }
  signIn(email: string, password: string) {
    return this.request('post', '/api/auth/sign-in/email', { body: { email, password }, cookie: false });
  }
  /** Mở link xác thực trong thư (host trong link là AUTH_BASE_URL; gọi đúng path + query trên server test). */
  async verifyEmailFromMailpit(mailpit: Mailpit, email: string, after?: number): Promise<Response> {
    const msg = await mailpit.waitFor(email, { subject: /Verify your email/, after });
    const link = /https?:\/\/[^\s"<>]+\/api\/auth\/verify-email\?[^\s"<>]+/.exec(msg.Text)?.[0];
    if (!link) throw new Error('no verification link in the email');
    const u = new URL(link.replaceAll('&amp;', '&'));
    return this.request('get', `${u.pathname}${u.search}`, { cookie: false });
  }
}
```
(`o.body as object`: supertest `send` nhận `string | object`; test chỉ truyền object — dòng này là assertion ở biên của helper test, cùng loại với `as AddressInfo` đang có trong test SP1.)

`test/e2e/identity/auth-mount.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { BetterAuthApiModule } from '../../../src/modules/identity/infra/better-auth/better-auth-api.module.js';
import { createTestApp } from '../../support/app-factory.js';
import { AuthClient, TEST_ORIGIN } from '../../support/auth-client.js';
import { getInfra } from '../../support/infra.js';

const PASSWORD = 'correct horse battery';
const LIMIT = 2048;
const MAX_413_MS = 2000;
const BASE_ENV = { HTTP_BODY_LIMIT: `${LIMIT}b`, AUTH_COOKIE_PREFIX: 'svc', HTTP_TRUST_PROXY: 'loopback', AUTH_SIGNIN_RATE_MAX: '1000' };
const imports = () => [DatabaseModule.forRoot({ relay: false }), RedisModule, QueueModule.forRoot({ runWorkers: false }), OutboxModule.forRoot({ relay: false }), EventsModule.forRoot({ worker: false }), HttpModule, NotificationsModule.forApi(), BetterAuthApiModule];
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) vi.stubEnv(k, v); }
}

describe('/api/auth/* self-mount (spec §5.5, §5.6.1, §5.6.2, §5.6.4)', () => {
  let app: INestApplication; let owner: pg.Client;
  const server = () => app.getHttpServer();
  const sessions = async (email: string) => (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`, [email])).rows[0]!.n;
  const verified = async (srv = server()) => {
    const email = `m-${v7()}@example.test`; const c = new AuthClient(srv);
    await c.signUp(email, PASSWORD);
    await owner.query(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
    await c.signIn(email, PASSWORD);
    return { email, c };
  };
  beforeAll(async () => {
    for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
    app = await createTestApp(imports(), { beforeInit: applyHttpDefaults, bodyParser: false });
    await app.listen(0, '127.0.0.1');
    const { pg: p } = getInfra();
    owner = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner?.end(); await app?.close(); vi.unstubAllEnvs(); });

  it('an UNBOUNDED chunked body → 413 problem+json within a bounded time, socket closed', async () => {
    const port = (server().address() as AddressInfo).port;
    const started = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/sign-in/email', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', origin: 'http://localhost:3000' } });
      let s = 0;
      req.on('response', (res) => { s = res.statusCode ?? 0; res.resume(); });
      req.on('error', () => undefined);
      req.on('close', () => resolve(s));
      req.write('{"email":"');
      const t = setInterval(() => { if (!req.destroyed) req.write('x'.repeat(512)); }, 5);
      req.on('close', () => clearInterval(t));
      setTimeout(() => reject(new Error('no 413 / socket still open')), MAX_413_MS * 2);
    });
    expect(status).toBe(413);
    expect(Date.now() - started).toBeLessThan(MAX_413_MS);
  });
  it('415 on a non-allowlisted content type and 400 on broken JSON, as problem+json', async () => {
    const a = await request(server()).post('/api/auth/sign-up/email').set('content-type', 'text/plain').send('x');
    expect([a.status, a.body.code]).toEqual([415, 'unsupported_media_type']);
    const b = await request(server()).post('/api/auth/sign-up/email').set('content-type', 'application/json').send('{bad');
    expect([b.status, b.body.code]).toEqual([400, 'malformed_request']);
  });
  it('a malformed sign-up → 422 validation_failed problem+json through the mount, not an empty 202 (review NI1)', async () => {
    const r = await request(server()).post('/api/auth/sign-up/email').set('origin', TEST_ORIGIN).send({ email: 'not-an-email', password: 'correct horse battery' });
    expect([r.status, r.headers['content-type'], r.body.code]).toEqual([422, expect.stringContaining('application/problem+json'), 'validation_failed']);
  });
  it('CORS on /api/auth/* comes from core/http (no library CORS): trusted origin allowed with credentials, others not', async () => {
    const ok = await request(server()).options('/api/auth/sign-in/email').set('origin', TEST_ORIGIN).set('access-control-request-method', 'POST');
    expect([ok.headers['access-control-allow-origin'], ok.headers['access-control-allow-credentials']]).toEqual([TEST_ORIGIN, 'true']);
    const evil = await request(server()).options('/api/auth/sign-in/email').set('origin', 'https://evil.test').set('access-control-request-method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('duplicate Authorization headers → 400 ambiguous_credentials, even on GET', async () => {
    const port = (server().address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/auth/get-session', headers: [['authorization', 'Bearer a'], ['authorization', 'Bearer b']].flat() });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(400);
  });
  it('CSRF runs before the handler: cookie + cross-site Origin → 403; the two_factor cookie alone also counts', async () => {
    const { c } = await verified();
    const r = await c.request('post', '/api/auth/sign-out', { origin: 'https://evil.test' });
    expect([r.status, r.body.code]).toEqual([403, 'origin_not_allowed']);
    const t = await new AuthClient(server()).request('post', '/api/auth/two-factor/verify-totp', { origin: 'https://evil.test', cookie: 'svc.two_factor=abc', body: { code: '000000' } });
    expect(t.status).toBe(403);
  });
  it('a spoofed x-app-client-ip is overwritten with req.ip', async () => {
    const { email } = await verified();
    const c = new AuthClient(server());
    await c.request('post', '/api/auth/sign-in/email', { body: { email, password: PASSWORD }, cookie: false, headers: { 'x-app-client-ip': '6.6.6.6' } });
    const { rows } = await owner.query(`SELECT ip_address FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`, [email]);
    expect(rows.map((r) => r.ip_address)).toContain(c.ip);
    expect(rows.map((r) => r.ip_address)).not.toContain('6.6.6.6');
  });
  it('sign-out with cookie only: session deleted and the cookie expired with the same Path', async () => {
    const { email, c } = await verified();
    const r = await c.request('post', '/api/auth/sign-out');
    expect(r.status).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/session_token=;.*Path=\//i);
    expect(await sessions(email)).toBe(0);
  });
  it('sign-out with cookie + bearer of two different sessions revokes both', async () => {
    const { email, c } = await verified();
    const other = new AuthClient(server()); await other.signIn(email, PASSWORD);
    expect((await c.request('post', '/api/auth/sign-out', { bearer: other.bearer })).status).toBe(200);
    expect(await sessions(email)).toBe(0);
  });
  it('sign-out never reports success when the DB delete fails (503), and never falls through to the native handler', async () => {
    const { email, c } = await verified();
    await owner.query('REVOKE DELETE ON auth.session FROM auth_user');
    try {
      const r = await c.request('post', '/api/auth/sign-out');
      expect([r.status, r.body.code, r.headers['retry-after'] !== undefined]).toEqual([503, 'service_unavailable', true]);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(await sessions(email)).toBe(1);
    } finally {
      await owner.query('GRANT DELETE ON auth.session TO auth_user');
    }
  });
  it('with a parent cookie domain, sign-in sets Domain and sign-out expires the cookie with the same Domain and Path', async () => {
    const DOMAIN_ORIGIN = 'http://app.lvh.test';
    await withEnv({ AUTH_BASE_URL: 'http://api.lvh.test', AUTH_SECURE_COOKIES: 'true', HTTP_CORS_ORIGINS: DOMAIN_ORIGIN, AUTH_COOKIE_DOMAIN: 'lvh.test', AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED: 'true' }, async () => {
      const scoped = await createTestApp(imports(), { beforeInit: applyHttpDefaults, bodyParser: false });
      try {
        const email = `dom-${v7()}@example.test`; const c = new AuthClient(scoped.getHttpServer(), DOMAIN_ORIGIN);
        await c.signUp(email, PASSWORD);
        await owner.query(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
        const signIn = await c.signIn(email, PASSWORD);
        expect(String(signIn.headers['set-cookie'])).toMatch(/__Secure-svc\.session_token=[^;]+;.*Domain=lvh\.test/i);
        const out = await c.request('post', '/api/auth/sign-out');
        expect(String(out.headers['set-cookie'])).toMatch(/__Secure-svc\.session_token=;.*Domain=lvh\.test/i);
        expect(String(out.headers['set-cookie'])).toMatch(/Path=\//);
      } finally {
        await scoped.close();
      }
    });
  });
  it('errors of Better Auth leave as problem+json; impersonation routes do not exist', async () => {
    const r = await new AuthClient(server()).signIn(`nobody-${v7()}@example.test`, 'whatever-long-password');
    expect([r.status, r.headers['content-type'], r.body.code]).toEqual([401, expect.stringContaining('application/problem+json'), 'invalid_credentials']);
    const imp = await new AuthClient(server()).request('post', '/api/auth/admin/impersonate-user', { body: { userId: v7() } });
    expect([imp.status, imp.headers['content-type']]).toEqual([404, expect.stringContaining('application/problem+json')]);
  });
  it('a burst over the per-IP rate limit → problem+json 429 with Retry-After (from X-Retry-After)', async () => {
    await withEnv({ AUTH_SIGNIN_RATE_MAX: '2' }, async () => {
      const limited = await createTestApp(imports(), { beforeInit: applyHttpDefaults, bodyParser: false });
      try {
        const c = new AuthClient(limited.getHttpServer());
        const codes: number[] = []; let last: request.Response | undefined;
        for (let i = 0; i < 4; i++) { last = await c.signIn(`b-${v7()}@example.test`, 'wrong-password-123'); codes.push(last.status); }
        expect(codes.at(-1)).toBe(429);
        expect(last!.headers['content-type']).toContain('application/problem+json');
        expect(last!.body.code).toBe('rate_limited');
        expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        await limited.close();
      }
    });
  });
  it('auth DB down → 503 problem+json with Retry-After on sign-in and get-session, and the process stays alive (no unhandled rejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    await withEnv({ DB_AUTH_PORT: '1', DB_AUTH_CONNECTION_TIMEOUT_MS: '200' }, async () => {
      const down = await createTestApp(imports(), { beforeInit: applyHttpDefaults, bodyParser: false });
      try {
        const c = new AuthClient(down.getHttpServer());
        for (const r of [await c.signIn(`d-${v7()}@example.test`, 'whatever-long-password'), await c.request('get', '/api/auth/get-session', { cookie: 'svc.session_token=x' })])
          expect([r.status, r.body.code, r.headers['retry-after'] !== undefined]).toEqual([503, 'service_unavailable', true]);
        await new Promise((r) => setTimeout(r, 200));
        expect(unhandled).toEqual([]);
      } finally {
        await down.close();
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/e2e/identity/auth-mount.e2e.spec.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/http/web-headers.ts`:
```ts
import type { IncomingMessage } from 'node:http';

/** Header Node → `Headers` của Web (Better Auth/jose nhận `Headers`). */
export function toWebHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  return h;
}
```
`src/modules/identity/identity-metrics.ts`:
```ts
import { Global, Injectable, Module } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { IDENTITY_METER } from './identity-telemetry.js';

export const SIGN_IN_RESULTS = ['success', 'invalid', 'forbidden', 'limited', 'unavailable', 'error'] as const;
export type SignInResult = (typeof SIGN_IN_RESULTS)[number];

/** Không label theo email/user/org (spec §5.14). */
@Injectable()
export class IdentityMetrics {
  private readonly meter = metrics.getMeter(IDENTITY_METER);
  readonly signIn = this.meter.createCounter('identity_sign_in_total', { description: 'Email/password sign-in outcomes' });
  readonly unavailable = this.meter.createCounter('identity_auth_unavailable_total', { description: 'Requests answered 503 because auth storage was unavailable' });
  readonly ambiguous = this.meter.createCounter('identity_ambiguous_credentials_total', { description: 'Requests rejected for carrying more than one credential' });
  readonly csrfRejected = this.meter.createCounter('identity_csrf_rejected_total', { description: 'Cookie-authenticated requests rejected by the origin check' });

  /** Phân loại theo status cuối cùng của `/sign-in/email`. */
  recordSignIn(status: number): void {
    const result: SignInResult =
      status < 300 ? 'success' : status === 401 ? 'invalid' : status === 403 ? 'forbidden' : status === 429 ? 'limited' : status === 503 ? 'unavailable' : 'error';
    this.signIn.add(1, { result });
  }
}

@Global()
@Module({ providers: [IdentityMetrics], exports: [IdentityMetrics] })
export class IdentityMetricsModule {}
```
`src/modules/identity/infra/better-auth/sign-out.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { ProblemMeta } from '../../../../core/errors/index.js';
import { writeProblem } from '../../../../core/http/index.js';
import type { DetectedCredential } from '../../http/credential-detector.js';
import { authUnavailable } from './auth-error.mapper.js';
import { BETTER_AUTH, type AuthInstance } from './auth-instance.js';

const OK = 200;

/**
 * `POST {basePath}/sign-out` do mình xử lý (spec §5.6.4): plugin bearer ghi đè cookie bằng bearer (A.14) nên
 * handler gốc chỉ xoá một session, và nó nuốt lỗi xoá DB (A.15). Thu hồi TỪNG credential với bộ header chỉ chứa
 * credential đó rồi kiểm lại. Bất kỳ lỗi nào (ném, hoặc còn session sống) → 503; không bao giờ rơi về handler gốc.
 */
@Injectable()
export class SignOutHandler {
  private readonly logger = new Logger(SignOutHandler.name);
  constructor(@Inject(BETTER_AUTH) private readonly auth: AuthInstance) {}

  async handle(res: ServerResponse, credentials: DetectedCredential[], ctx: { origin?: string; meta: ProblemMeta; retryAfterSec: number }): Promise<void> {
    const setCookies: string[] = [];
    try {
      for (const c of credentials) {
        const headers = new Headers(ctx.origin ? { origin: ctx.origin } : {});
        if (c.kind === 'SESSION_COOKIE' && c.cookieName) headers.set('cookie', `${c.cookieName}=${c.value}`);
        else if (c.kind === 'BEARER_SESSION') headers.set('authorization', `Bearer ${c.value}`);
        else continue;
        const out = await this.auth.api.signOut({ headers, returnHeaders: true });
        if (c.kind === 'SESSION_COOKIE') setCookies.push(...out.headers.getSetCookie());
        if (await this.auth.api.getSession({ headers })) throw new Error('session still alive after sign-out');
      }
    } catch (err) {
      this.logger.error({ err, event: 'sign_out_failed' }, 'sign-out could not revoke every session');
      return writeProblem(res, authUnavailable(ctx.retryAfterSec), ctx.meta);
    }
    res.statusCode = OK;
    for (const sc of setCookies) res.appendHeader('Set-Cookie', sc);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
  }
}
```
(`returnHeaders: true` → `{ headers, response }` theo S1f; nếu S1f chọn `asResponse: true` thì đọc `Response.headers.getSetCookie()`. Nếu S1f không lấy được `Set-Cookie`: tự phát cookie hết hạn theo `sessionCookieNames(prefix)`, `Path=/`, `Domain` từ `AUTH_COOKIE_DOMAIN`.)

`src/modules/identity/infra/better-auth/auth-mount.middleware.ts`:
```ts
import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { RequestContext } from '../../../../core/context/index.js';
import { AppError, CoreErrors, PROBLEM_JSON, errorsConfig, toAppError, type ProblemMeta } from '../../../../core/errors/index.js';
import { httpConfig, jsonBodyParser, writeProblem, type NodeMiddleware } from '../../../../core/http/index.js';
import { IdentityErrors } from '../../errors.js';
import { detectCredentials, detectionConfigOf, type DetectionConfig } from '../../http/credential-detector.js';
import { UNSAFE_METHODS, csrfAllows, trustedOriginList } from '../../http/origin-check.js';
import { toWebHeaders } from '../../http/web-headers.js';
import { IdentityMetrics } from '../../identity-metrics.js';
import { identityConfig, identityGuardConfig, type IdentityConfig, type IdentityGuardConfig } from '../../identity.config.js';
import { authUnavailable, mapAuthError } from './auth-error.mapper.js';
import { BETTER_AUTH, type AuthInstance } from './auth-instance.js';
import { AUTH_POOL } from './auth-pool.provider.js';
import { CLIENT_IP_HEADER } from './auth-options.js';
import { AuthRequestState } from './auth-request-state.js';
import { SignOutHandler } from './sign-out.js';

type MountRequest = IncomingMessage & { ip?: string; originalUrl?: string };
const FIRST_ERROR_STATUS = 400;
const FIRST_SERVER_ERROR = 500;
const SERVICE_UNAVAILABLE = 503;
const SIGN_IN_PATH = '/sign-in/email';
const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};
const codeOf = (text: string): string | undefined => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && 'code' in v && typeof v.code === 'string' ? v.code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Mount `/api/auth/*` (spec §5.5, 6 bước). Không bao giờ gọi `next()`: request auth kết thúc ở đây, nên không
 * có handler gốc nào chạy sau khi mình đã quyết định (vd. đăng xuất lỗi). `use` bắt mọi lỗi của promise.
 */
@Injectable()
export class AuthMountMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMountMiddleware.name);
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;
  private readonly parse: NodeMiddleware;
  private readonly baseOrigin: string;

  constructor(
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
    @Inject(identityGuardConfig.KEY) private readonly guard: IdentityGuardConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
    @Inject(errorsConfig.KEY) private readonly errors: ConfigOf<typeof errorsConfig>,
    @Inject(BETTER_AUTH) private readonly auth: AuthInstance,
    @Inject(AUTH_POOL) private readonly pool: pg.Pool,
    private readonly ctx: RequestContext,
    private readonly state: AuthRequestState,
    private readonly signOut: SignOutHandler,
    private readonly metrics: IdentityMetrics,
  ) {
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(trustedOriginList(http.corsOrigins, identity.baseUrl));
    this.parse = jsonBodyParser(http);
    if (!identity.baseUrl) throw new Error('AUTH_BASE_URL is required to mount Better Auth');
    this.baseOrigin = new URL(identity.baseUrl).origin;
  }

  use(req: MountRequest, res: ServerResponse): void {
    this.state.run(() => this.handle(req, res)).catch((err: unknown) => {
      this.logger.error({ err, event: 'auth_mount_failed' }, 'auth mount failed');
      writeProblem(res, new AppError(CoreErrors.INTERNAL_ERROR), this.meta(req));
    });
  }

  private meta(req: MountRequest): ProblemMeta {
    return { instance: (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '', requestId: this.ctx.requestId(), typeBase: this.errors.problemTypeBase };
  }

  private async handle(req: MountRequest, res: ServerResponse): Promise<void> {
    const meta = this.meta(req);
    const method = (req.method ?? 'GET').toUpperCase();
    const path = meta.instance.slice(this.identity.basePath.length);
    const isSignOut = method === 'POST' && path === '/sign-out';
    const d = detectCredentials(req.rawHeaders, this.detection, { allowCookieWithBearer: isSignOut });
    if (!d.ok) {
      this.metrics.ambiguous.add(1);
      return writeProblem(res, new AppError(IdentityErrors.AMBIGUOUS_CREDENTIALS), meta);
    }
    if (UNSAFE_METHODS.has(method) && d.hasAuthCookie && !csrfAllows({ method, origin: header(req, 'origin'), secFetchSite: header(req, 'sec-fetch-site') }, this.trusted)) {
      this.metrics.csrfRejected.add(1);
      return writeProblem(res, new AppError(IdentityErrors.ORIGIN_NOT_ALLOWED), meta);
    }
    const parseError = await new Promise<unknown>((resolve) => this.parse(req, res, resolve));
    if (parseError !== undefined) return writeProblem(res, toAppError(parseError), meta);
    // Header IP do mình ghi: xoá mọi bản client gửi rồi đặt từ req.ip (Express tính theo HTTP_TRUST_PROXY).
    delete req.headers[CLIENT_IP_HEADER];
    req.headers[CLIENT_IP_HEADER] = req.ip ?? req.socket.remoteAddress ?? '';
    if (isSignOut) return this.signOut.handle(res, d.credentials, { origin: header(req, 'origin'), meta, retryAfterSec: this.guard.unavailableRetryAfterSec });
    await this.forward(req, res, meta, path);
  }

  private async forward(req: MountRequest, res: ServerResponse, meta: ProblemMeta, path: string): Promise<void> {
    const body = 'rawBody' in req && Buffer.isBuffer(req.rawBody) ? req.rawBody : undefined;
    let response: Response;
    try {
      response = await this.auth.handler(new Request(`${this.baseOrigin}${req.originalUrl ?? req.url ?? '/'}`, { method: req.method, headers: toWebHeaders(req), body }));
    } catch (err) {
      // Lỗi ở `onRequest` (storage rate limit, checkSchema…) nằm ngoài try/catch của router: fail-closed 503.
      this.logger.error({ err, event: 'auth_handler_rejected' }, 'better auth handler rejected; answering 503');
      return this.unavailable(res, meta, path);
    }
    if (response.status < FIRST_ERROR_STATUS || (response.headers.get('content-type') ?? '').includes(PROBLEM_JSON))
      return this.copy(res, response, path);
    const setCookies = response.headers.getSetCookie();
    const code = codeOf(await response.text());
    let err = mapAuthError({ status: response.status, code, retryAfter: response.headers.get('X-Retry-After') }, { unavailableRetryAfterSec: this.guard.unavailableRetryAfterSec });
    if (response.status >= FIRST_SERVER_ERROR) {
      const dbUp = await this.pool.query('SELECT 1').then(() => true, () => false);
      this.logger.error({ status: response.status, code, dbUp, event: 'auth_endpoint_error' }, 'better auth endpoint failed');
      if (!dbUp) return this.unavailable(res, meta, path, setCookies);
      err = new AppError(CoreErrors.INTERNAL_ERROR);
    }
    if (path === SIGN_IN_PATH) this.metrics.recordSignIn(err.error.status);
    for (const c of setCookies) res.appendHeader('Set-Cookie', c);
    writeProblem(res, err, meta);
  }

  private unavailable(res: ServerResponse, meta: ProblemMeta, path: string, setCookies: string[] = []): void {
    this.metrics.unavailable.add(1);
    if (path === SIGN_IN_PATH) this.metrics.recordSignIn(503);
    for (const c of setCookies) res.appendHeader('Set-Cookie', c);
    writeProblem(res, authUnavailable(this.guard.unavailableRetryAfterSec), meta);
  }

  /** 2xx/3xx và problem+json do hook của mình tạo: giữ nguyên status, `Location`, mọi `Set-Cookie`, body. */
  private async copy(res: ServerResponse, response: Response, path: string): Promise<void> {
    if (path === SIGN_IN_PATH) this.metrics.recordSignIn(response.status);
    // 503 do hook tự tạo (lockout storage lỗi, Task 34) cũng là "auth storage unavailable" (review NM2).
    if (response.status === SERVICE_UNAVAILABLE) this.metrics.unavailable.add(1);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') res.setHeader(key, value);
    });
    for (const c of response.headers.getSetCookie()) res.appendHeader('Set-Cookie', c);
    res.end(Buffer.from(await response.arrayBuffer()));
  }
}
```
`src/modules/identity/infra/better-auth/better-auth-api.module.ts`:
```ts
import { Global, Inject, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { HTTP_BODY_PARSER_SKIP_PREFIX } from '../../../../core/http/index.js';
import { IdentityMetricsModule } from '../../identity-metrics.js';
import { identityConfig, type IdentityConfig } from '../../identity.config.js';
import { AuthMountMiddleware } from './auth-mount.middleware.js';
import { BetterAuthCoreModule } from './better-auth-core.module.js';
import { SignOutHandler } from './sign-out.js';

/**
 * `local`/`hybrid` ở api: tự mount Better Auth sau port `AuthProvider` (quyết định ở Task 1: không dùng thallesp).
 * Core bỏ qua `AUTH_BASE_PATH` khi đọc body: `AuthMountMiddleware` kiểm đa credential + CSRF rồi mới đọc (spec §5.5).
 */
@Global()
@Module({
  imports: [BetterAuthCoreModule, IdentityMetricsModule],
  providers: [
    SignOutHandler,
    AuthMountMiddleware,
    { provide: HTTP_BODY_PARSER_SKIP_PREFIX, inject: [identityConfig.KEY], useFactory: (id: IdentityConfig) => id.basePath },
  ],
  exports: [HTTP_BODY_PARSER_SKIP_PREFIX],
})
export class BetterAuthApiModule implements NestModule {
  constructor(@Inject(identityConfig.KEY) private readonly identity: IdentityConfig) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMountMiddleware).forRoutes({ path: `${this.identity.basePath}/{*path}`, method: RequestMethod.ALL });
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/e2e/identity/auth-mount.e2e.spec.ts && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS, không có unhandled rejection trong output của Vitest.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity test/support/auth-client.ts test/e2e/identity/auth-mount.e2e.spec.ts
git commit -m "feat(identity): self-mounted /api/auth with pre-handler checks, stream body limit, total error mapping and a fail-closed sign-out"
```

---

### Task 37: `PrincipalMiddleware`, `AuthGuard`, `GET /v1/me`, `IdentityModule` và bật module trong `app.modules.ts`

**Files:**
- Create: `src/modules/identity/http/auth-state.ts`, `src/modules/identity/http/principal.middleware.ts`, `src/modules/identity/http/auth.guard.ts`, `src/modules/identity/http/session-only.decorator.ts`, `src/modules/identity/http/schemas.ts`, `src/modules/identity/http/me.controller.ts`, `src/modules/identity/identity.module.ts`, `src/modules/identity/index.ts`, `test/support/identity-app.ts`
- Modify: `src/app.modules.ts`, `openapi.json` (sinh lại)
- Test: `test/e2e/identity/principal-guard.e2e.spec.ts`

**Interfaces:**
- Consumes: `AuthProvider`, `AuthResult` (Task 35); `detectCredentials`, `csrfAllows`, `isCookieCredential` (Task 30); `PUBLIC_ROUTE` (Task 10); `RequestContext.setCredential` (Task 8); `IdentityDirectory` (Task 27); `BetterAuthApiModule`, `IdentityMetrics`, `IdentityMetricsModule`, `toWebHeaders`, `AuthClient` (Task 36); `identitySpan` (Task 27); `ReconcileRegisteredHandler`, `PurgeExpiredHandler` (Task 32); `isBetterAuthMode` (Task 25).
- Produces:
  - `AuthState` (CLS key `identity:authResult`): `set(r: AuthResult)`, `get(): AuthResult`.
  - `PrincipalMiddleware` (mọi route Nest TRỪ `${AUTH_BASE_PATH}/{*path}` — review I9: route auth do `AuthMountMiddleware` tự nhận diện, không tra session hai lần), span `identity.authenticate` + counter `unavailable`/`ambiguous`/`csrfRejected` (review I8). `AuthGuard` (`APP_GUARD`, mặc định chặn; `REJECTED` → 401 và `UNAVAILABLE` → 503 KỂ CẢ trên `@PublicRoute()` — review I7: credential có mặt mà sai không bao giờ bị hạ thành ẩn danh), `SESSION_ONLY`, `SessionOnly()`.
  - `GET /v1/me` → `MeResponse = { id, email, name, emailVerified, role: 'USER' | 'ADMIN', twoFactorEnabled, createdAt, updatedAt }`.
  - `IdentityModule.forApi(): DynamicModule`, `IdentityModule.forWorker(): DynamicModule` (Task 41 thêm nhánh `external`, Task 45 thêm authorizer dashboard).
  - `APP_MODULES = { api: [NotificationsModule.forApi(), IdentityModule.forApi()], worker: [NotificationsModule.forWorker(), IdentityModule.forWorker()] }`.
  - `test/support/identity-app.ts`: `startIdentityApp(opts?: { extraImports?: ModuleImport[]; env?: Record<string, string> }): Promise<INestApplication>` (api + worker trong cùng process: relay outbox, worker queue `events,notifications`, gửi mail tới Mailpit; env mặc định `HTTP_TRUST_PROXY=loopback` + ngưỡng rate limit của Better Auth cao, `opts.env` ghi đè), `promoteToAdmin(email)`, `verifyEmailDirect(email)`.

- [ ] **Step 1: Viết test fail**

`test/support/identity-app.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { vi } from 'vitest';
import { DatabaseModule } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { HealthModule } from '../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../src/core/http/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { IdentityModule } from '../../src/modules/identity/index.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import { createTestApp, type ModuleImport } from './app-factory.js';
import { getInfra } from './infra.js';

/**
 * App e2e "api + worker" trong một process: route HTTP thật + relay outbox + worker của queue `events` và
 * `notifications`, để thư thật sự tới Mailpit. Queue `maintenance` không được consume (cron test riêng).
 */
/**
 * `AuthClient` (Task 36) gửi `x-forwarded-for` ngẫu nhiên theo client; `loopback` cho app tin header đó, nên
 * rate limit IP của Better Auth tính theo client chứ không gộp mọi test vào 127.0.0.1. Ngưỡng cao để các file
 * e2e không giẫm nhau; test về rate limit tự đặt ngưỡng thấp qua `opts.env`.
 */
const IDENTITY_E2E_ENV: Record<string, string> = {
  WORKER_QUEUES: 'events,notifications',
  HTTP_TRUST_PROXY: 'loopback',
  AUTH_RATE_LIMIT_MAX: '10000',
  AUTH_SIGNIN_RATE_MAX: '1000',
  AUTH_EMAIL_RATE_MAX: '1000',
  AUTH_TWO_FACTOR_RATE_MAX: '1000',
};

export async function startIdentityApp(opts: { extraImports?: ModuleImport[]; env?: Record<string, string> } = {}): Promise<INestApplication> {
  for (const [k, v] of Object.entries({ ...IDENTITY_E2E_ENV, ...opts.env })) vi.stubEnv(k, v);
  return createTestApp(
    [
      DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }), EventsModule.forRoot({ worker: true }), HttpModule, HealthModule.forRoot({ http: true }),
      NotificationsModule.forWorker(), IdentityModule.forApi(), ...(opts.extraImports ?? []),
    ],
    { beforeInit: applyHttpDefaults, bodyParser: false },
  );
}

export async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { pg: p } = getInfra();
  const c = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.owner });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}
export const promoteToAdmin = (email: string) => ownerQuery(`UPDATE auth."user" SET role = 'admin' WHERE email = $1`, [email]);
export const verifyEmailDirect = (email: string) => ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
```
`test/e2e/identity/principal-guard.e2e.spec.ts`:
```ts
import { Body, Controller, Get, Headers, Module, Patch, Post, Req, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { PublicRoute } from '../../../src/core/http/index.js';
import { SessionOnly } from '../../../src/modules/identity/index.js';
import { AuthClient } from '../../support/auth-client.js';
import { startIdentityApp, verifyEmailDirect } from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
@Controller('probe')
class ProbeController {
  constructor(private readonly ctx: RequestContext) {}
  @PublicRoute() @Get('public') open() { return { ok: true }; }
  @Get('who') who() { return { principal: this.ctx.principal(), credential: this.ctx.credential() }; }
  @SessionOnly() @Post('sensitive') sensitive() { return { ok: true }; }
  @Post('echo') echo(@Body() body: unknown, @Req() req: { rawBody?: Buffer }) { return { body, raw: req.rawBody?.toString('utf8') ?? null }; }
  @Patch('merge') merge(@Body() body: unknown, @Headers('content-type') ct: string) { return { body, ct }; }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('PrincipalMiddleware + AuthGuard on Nest routes', () => {
  let app: INestApplication; let c: AuthClient; let apiKey = '';
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [ProbeModule], env: { THROTTLE_DEFAULT_LIMIT: '5' } });
    c = new AuthClient(app.getHttpServer());
    const email = `g-${v7()}@example.test`;
    await c.signUp(email, PASSWORD);
    await verifyEmailDirect(email);
    await c.signIn(email, PASSWORD);
    apiKey = (await c.request('post', '/api/auth/api-key/create', { body: { name: 'probe' } })).body.key;
  });
  afterAll(async () => app?.close());

  it('default deny: anonymous → 401 problem+json; @PublicRoute and health stay open', async () => {
    const r = await request(app.getHttpServer()).get('/probe/who');
    expect([r.status, r.body.code]).toEqual([401, 'unauthenticated']);
    await request(app.getHttpServer()).get('/probe/public').expect(200);
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
  it('a present-but-invalid credential is 401 even on a @PublicRoute (never downgraded to anonymous)', async () => {
    for (const [name, value] of [['x-api-key', ''], ['authorization', 'Bearer not-a-real-token']] as const) {
      const r = await request(app.getHttpServer()).get('/probe/public').set(name, value);
      expect([r.status, r.body.code], `${name}`).toEqual([401, 'unauthenticated']);
    }
  });
  it('PrincipalMiddleware never runs on /api/auth/* (the mount identifies credentials itself)', async () => {
    const spy = vi.spyOn(app.get(AuthProvider), 'authenticate');
    try {
      expect((await c.request('get', '/api/auth/get-session')).status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      await c.request('get', '/probe/who');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('cookie, bearer and API key all resolve the same user; the key id is in context', async () => {
    const viaCookie = await c.request('get', '/probe/who');
    const viaBearer = await c.request('get', '/probe/who', { cookie: false, bearer: c.bearer });
    const viaKey = await c.request('get', '/probe/who', { cookie: false, apiKey });
    expect(viaCookie.body.credential).toEqual({ kind: 'SESSION_COOKIE' });
    expect(viaBearer.body.credential).toEqual({ kind: 'BEARER_SESSION' });
    expect(viaKey.body.credential).toMatchObject({ kind: 'API_KEY', id: expect.any(String) });
    expect(new Set([viaCookie.body.principal.id, viaBearer.body.principal.id, viaKey.body.principal.id]).size).toBe(1);
  });
  it('GET /v1/me by cookie and by API key returns the owning user', async () => {
    const me = await c.request('get', '/v1/me');
    expect(me.status).toBe(200);
    expect(Object.keys(me.body).sort()).toEqual(['createdAt', 'email', 'emailVerified', 'id', 'name', 'role', 'twoFactorEnabled', 'updatedAt']);
    expect((await c.request('get', '/v1/me', { cookie: false, apiKey })).body.id).toBe(me.body.id);
  });
  it('@SessionOnly rejects API keys (403) and accepts sessions', async () => {
    expect((await c.request('post', '/probe/sensitive', { cookie: false, apiKey })).status).toBe(403);
    expect((await c.request('post', '/probe/sensitive')).status).toBe(201);
  });
  it('cookie + bearer on a Nest route → 400 ambiguous_credentials; cookie POST cross-site → 403; bearer cross-site passes', async () => {
    const amb = await c.request('get', '/probe/who', { bearer: c.bearer });
    expect([amb.status, amb.body.code]).toEqual([400, 'ambiguous_credentials']);
    const csrf = await c.request('post', '/probe/echo', { origin: 'https://evil.test', body: { a: 1 } });
    expect([csrf.status, csrf.body.code]).toEqual([403, 'origin_not_allowed']);
    expect((await c.request('post', '/probe/echo', { origin: 'https://evil.test', cookie: false, bearer: c.bearer, body: { a: 1 } })).status).toBe(201);
  });
  it('SP1 conventions still hold with identity mounted: JSON + rawBody, merge-patch, 415, 413', async () => {
    const e = await c.request('post', '/probe/echo', { body: { a: 1 } });
    expect(e.body).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
    const m = await request(app.getHttpServer()).patch('/probe/merge').set('authorization', `Bearer ${c.bearer}`).set('content-type', 'application/merge-patch+json').send('{"a":null}');
    expect(m.body).toEqual({ body: { a: null }, ct: 'application/merge-patch+json' });
    expect((await request(app.getHttpServer()).post('/probe/echo').set('authorization', `Bearer ${c.bearer}`).set('content-type', 'text/plain').send('x')).status).toBe(415);
    expect((await request(app.getHttpServer()).post('/probe/echo').set('authorization', `Bearer ${c.bearer}`).send({ pad: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413);
  });
  it('the throttler counts per authenticated principal, not per IP', async () => {
    const other = new AuthClient(app.getHttpServer());
    const email = `t-${v7()}@example.test`;
    await other.signUp(email, PASSWORD); await verifyEmailDirect(email); await other.signIn(email, PASSWORD);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await c.request('get', '/probe/who', { cookie: false, bearer: c.bearer })).status);
    expect(codes).toContain(429);
    expect((await other.request('get', '/probe/who', { cookie: false, bearer: other.bearer })).status).toBe(200);
  });
});

describe('auth storage down: public routes', () => {
  it('a credential on a @PublicRoute → 503 with Retry-After; anonymous stays 200 without touching the auth DB', async () => {
    const down = await startIdentityApp({ extraImports: [ProbeModule], env: { DB_AUTH_PORT: '1', DB_AUTH_CONNECTION_TIMEOUT_MS: '200' } });
    try {
      const r = await request(down.getHttpServer()).get('/probe/public').set('authorization', 'Bearer some-session-token');
      expect([r.status, r.headers['content-type']]).toEqual([503, expect.stringContaining('application/problem+json')]);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      await request(down.getHttpServer()).get('/probe/public').expect(200);
    } finally {
      await down.close();
    }
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/e2e/identity/principal-guard.e2e.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/http/auth-state.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AuthResult } from '../ports/auth-provider.js';

const AUTH_RESULT_KEY = 'identity:authResult';
const ANONYMOUS: AuthResult = { kind: 'ANONYMOUS' };

/** Kết quả xác thực của request, giữ trong CLS giữa middleware và guard (spec §5.6.4). */
@Injectable()
export class AuthState {
  constructor(private readonly cls: ClsService) {}
  set(r: AuthResult): void {
    this.cls.set(AUTH_RESULT_KEY, r);
  }
  /** Chỉ module này ghi khoá đó, nên một assertion ở biên (mẫu `RequestContext.read`) là an toàn. */
  get(): AuthResult {
    return this.cls.isActive() ? ((this.cls.get(AUTH_RESULT_KEY) as AuthResult | undefined) ?? ANONYMOUS) : ANONYMOUS;
  }
}
```
`src/modules/identity/http/principal.middleware.ts`:
```ts
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { IdentityMetrics } from '../identity-metrics.js';
import { identitySpan } from '../identity-telemetry.js';
import { type ConfigOf, appConfig } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError } from '../../../core/errors/index.js';
import { httpConfig } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import { identityConfig, type IdentityConfig } from '../identity.config.js';
import { AuthProvider } from '../ports/auth-provider.js';
import { detectCredentials, detectionConfigOf, type DetectionConfig } from './credential-detector.js';
import { UNSAFE_METHODS, csrfAllows, isCookieCredential, trustedOriginList } from './origin-check.js';
import { AuthState } from './auth-state.js';
import { toWebHeaders } from './web-headers.js';

const single = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Principal xác định ở middleware, trước mọi guard (ADR 0007: thứ tự APP_GUARD giữa module không được bảo
 * đảm, mà `AppThrottlerGuard` cần principal). Không có credential → ANONYMOUS, không chạm DB auth.
 */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly provider: AuthProvider,
    private readonly ctx: RequestContext,
    private readonly state: AuthState,
    private readonly metrics: IdentityMetrics,
    @Inject(identityConfig.KEY) identity: IdentityConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
  ) {
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(trustedOriginList(http.corsOrigins, identity.baseUrl));
  }

  async use(req: IncomingMessage, _res: unknown, next: (err?: unknown) => void): Promise<void> {
    try {
      const d = detectCredentials(req.rawHeaders, this.detection);
      if (!d.ok) {
        this.metrics.ambiguous.add(1);
        return next(new AppError(IdentityErrors.AMBIGUOUS_CREDENTIALS));
      }
      const credential = d.credentials[0];
      if (!credential) {
        this.state.set({ kind: 'ANONYMOUS' });
        return next();
      }
      const method = (req.method ?? 'GET').toUpperCase();
      if (UNSAFE_METHODS.has(method) && isCookieCredential(credential.kind) && !csrfAllows({ method, origin: single(req, 'origin'), secFetchSite: single(req, 'sec-fetch-site') }, this.trusted)) {
        this.metrics.csrfRejected.add(1);
        return next(new AppError(IdentityErrors.ORIGIN_NOT_ALLOWED));
      }
      // Span không mang token/user id: chỉ loại credential và kết quả (spec §5.14).
      const result = await identitySpan(
        'identity.authenticate',
        () => this.provider.authenticate({ headers: toWebHeaders(req), credential }),
        (r) => ({ 'identity.credential.kind': credential.kind, 'identity.auth.result': r.kind }),
      );
      if (result.kind === 'UNAVAILABLE') this.metrics.unavailable.add(1);
      this.state.set(result);
      if (result.kind === 'AUTHENTICATED') {
        this.ctx.setPrincipal(result.principal);
        this.ctx.setCredential(result.credential);
      }
      next();
    } catch (err) {
      next(err);
    }
  }
}
```
`src/modules/identity/http/session-only.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const SESSION_ONLY = 'identity:sessionOnly';
/** Thao tác nhạy cảm: chỉ session (cookie/bearer), không nhận API key (spec §5.6.3). */
export const SessionOnly = (): ClassDecorator & MethodDecorator => SetMetadata(SESSION_ONLY, true);
```
`src/modules/identity/http/auth.guard.ts`:
```ts
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { PUBLIC_ROUTE } from '../../../core/http/index.js';
import { identityGuardConfig, type IdentityGuardConfig } from '../identity.config.js';
import { AuthState } from './auth-state.js';
import { SESSION_ONLY } from './session-only.decorator.js';

/**
 * APP_GUARD mặc định chặn. `@PublicRoute()` chỉ miễn cho request KHÔNG mang credential (review I7): credential
 * có mặt mà sai (`REJECTED`) là 401 và storage auth lỗi (`UNAVAILABLE`) là 503 ở mọi route, để client không
 * lặng lẽ bị coi là ẩn danh (vd. `x-api-key` rỗng do lỗi cấu hình).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly state: AuthState,
    @Inject(identityGuardConfig.KEY) private readonly guard: IdentityGuardConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true;
    const r = this.state.get();
    switch (r.kind) {
      case 'AUTHENTICATED':
        if (isPublic) return true;
        if (r.credential.kind === 'API_KEY' && this.reflector.getAllAndOverride<boolean>(SESSION_ONLY, targets))
          throw new AppError(CoreErrors.FORBIDDEN, { detail: 'This operation requires a signed-in session' });
        return true;
      case 'ANONYMOUS':
        if (isPublic) return true;
        throw new AppError(CoreErrors.UNAUTHENTICATED);
      case 'REJECTED':
        throw new AppError(CoreErrors.UNAUTHENTICATED);
      case 'UNAVAILABLE':
        throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, { headers: { 'Retry-After': String(this.guard.unavailableRetryAfterSec) }, expected: true });
      default: {
        const unknown: never = r;
        throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
      }
    }
  }
}
```
`src/modules/identity/http/schemas.ts`:
```ts
import { z } from 'zod';

export const MeResponse = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  emailVerified: z.boolean(),
  role: z.enum(['USER', 'ADMIN']),
  twoFactorEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MeResponse = z.infer<typeof MeResponse>;
```
`src/modules/identity/http/me.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiProblems, serialize } from '../../../core/http/index.js';
import { IdentityDirectory, hasAdminRole } from '../ports/identity-directory.js';
import { MeResponse } from './schemas.js';

@Controller('v1/me')
export class MeController {
  constructor(private readonly ctx: RequestContext, private readonly directory: IdentityDirectory) {}

  /** Gọi bằng API key thì trả user sở hữu key (spec §5.6.4). */
  @Get()
  @ApiProblems(CoreErrors.UNAUTHENTICATED, CoreErrors.SERVICE_UNAVAILABLE)
  async me(): Promise<MeResponse> {
    const p = this.ctx.principal();
    const user = p ? await this.directory.findUser(p.id) : undefined;
    if (!user) throw new AppError(CoreErrors.UNAUTHENTICATED);
    return serialize(MeResponse, {
      id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified,
      role: hasAdminRole(user.role) ? 'ADMIN' : 'USER', twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString(),
    });
  }
}
```
(Chữ ký `serialize` và `ApiProblems` là của `core/http` SP1 — đối chiếu `src/core/http/response.ts`, `api-problems.decorator.ts`.)

`src/modules/identity/identity.module.ts`:
```ts
import { type DynamicModule, Inject, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PurgeExpiredHandler } from './application/purge-expired.handler.js';
import { ReconcileRegisteredHandler } from './application/reconcile-registered.handler.js';
import { AuthGuard } from './http/auth.guard.js';
import { AuthState } from './http/auth-state.js';
import { MeController } from './http/me.controller.js';
import { PrincipalMiddleware } from './http/principal.middleware.js';
import { IdentityMetricsModule } from './identity-metrics.js';
import { identityConfig, isBetterAuthMode, type IdentityConfig } from './identity.config.js';
import { BetterAuthApiModule } from './infra/better-auth/better-auth-api.module.js';
import { BetterAuthCoreModule } from './infra/better-auth/better-auth-core.module.js';
import './events.js';
import './jobs.js';

/** Route wildcard toàn cục theo cú pháp path-to-regexp 8 (giống HttpModule). */
const ALL_ROUTES = '{*path}';

@Module({ controllers: [MeController] })
class LocalHttpModule {}

/**
 * Chỉ ở api: middleware xác định principal cho mọi route Nest + guard mặc định chặn. Loại trừ prefix auth
 * (review I9): ở đó `AuthMountMiddleware` tự kiểm đa credential/CSRF và không bao giờ gọi `next()`.
 * `IdentityMetricsModule` import trực tiếp vì ở `AUTH_MODE=external` không có `BetterAuthApiModule`.
 */
@Module({ imports: [IdentityMetricsModule], providers: [AuthState, PrincipalMiddleware, { provide: APP_GUARD, useClass: AuthGuard }] })
class IdentityHttpModule implements NestModule {
  constructor(@Inject(identityConfig.KEY) private readonly identity: IdentityConfig) {}
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PrincipalMiddleware)
      .exclude({ path: `${this.identity.basePath}/${ALL_ROUTES}`, method: RequestMethod.ALL })
      .forRoutes(ALL_ROUTES);
  }
}

@Module({})
export class IdentityModule {
  /** api: mount theo `AUTH_MODE` bằng `ConditionalModule` (đọc env sau khi ConfigModule nạp, spec §5.5). */
  static forApi(): DynamicModule {
    return {
      module: IdentityModule,
      imports: [
        ConditionalModule.registerWhen(BetterAuthApiModule, isBetterAuthMode),
        ConditionalModule.registerWhen(LocalHttpModule, isBetterAuthMode),
        IdentityHttpModule,
      ],
    };
  }

  /** worker: pool + instance + cron, không mount HTTP. Handler cron luôn có (maintenance queue), tự bỏ qua ở `external`. */
  static forWorker(): DynamicModule {
    return {
      module: IdentityModule,
      imports: [ConditionalModule.registerWhen(BetterAuthCoreModule, isBetterAuthMode)],
      providers: [ReconcileRegisteredHandler, PurgeExpiredHandler],
    };
  }
}
```
`src/modules/identity/index.ts`:
```ts
export { IdentityModule } from './identity.module.js';
export { SessionOnly } from './http/session-only.decorator.js';
export { IdentityErrors } from './errors.js';
export { UserRegisteredEvent } from './events.js';
export { IdentityDirectory, type DirectoryUser } from './ports/identity-directory.js';
export { identityConfig, identityGuardConfig, authDatabaseConfig } from './identity.config.js';
```
`src/app.modules.ts`:
```ts
import type { DynamicModule, Type } from '@nestjs/common';
import { IdentityModule } from './modules/identity/index.js';
import { NotificationsModule } from './modules/notifications/index.js';

type ModuleImport = Type<unknown> | DynamicModule;

/** Module nền và feature mà dự án bật. Boilerplate bật sẵn identity + notifications (spec SP2 §6). */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [NotificationsModule.forApi(), IdentityModule.forApi()],
  worker: [NotificationsModule.forWorker(), IdentityModule.forWorker()],
};
```
Run: `pnpm build && pnpm openapi:export` (openapi.json có thêm `/v1/me`).

- [ ] **Step 4: Chạy test, xác nhận xanh (kể cả toàn bộ hồi quy)**

Run:
```bash
pnpm vitest run --project integration test/e2e/identity/principal-guard.e2e.spec.ts
pnpm test && pnpm test:int
pnpm typecheck && pnpm lint && pnpm arch
```
Expected: PASS toàn bộ (test entrypoint SP1 giờ nạp identity/notifications: `baseTestEnv` đã có env cần thiết từ Task 18, 25).

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity src/app.modules.ts openapi.json test/support/identity-app.ts test/e2e/identity/principal-guard.e2e.spec.ts
git commit -m "feat(identity): principal middleware, default-deny guard, GET /v1/me; enable identity and notifications"
```

---
### Task 38: E2E web (cookie) và mobile (bearer): đăng ký → email → xác thực → đăng nhập, thu hồi, ban, đặt lại/đổi mật khẩu

**Files:**
- Test: `test/e2e/identity/web-mobile.e2e.spec.ts`

**Interfaces:**
- Consumes: `startIdentityApp`, `promoteToAdmin`, `verifyEmailDirect`, `ownerQuery` (Task 37); `AuthClient` (Task 36); `mailpitFromInfra` (Task 15).
- Produces: bằng chứng cho tiêu chí 1, 2, 6, 9 của spec §1 (không có code sản phẩm mới; lỗi phát hiện ở đây sửa trong task sở hữu code và ghi vào commit này).

- [ ] **Step 1: Viết test**

`test/e2e/identity/web-mobile.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, promoteToAdmin, startIdentityApp } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const PASSWORD = 'correct horse battery';
const mail = mailpitFromInfra();

describe('web (cookie) and mobile (bearer) flows over real HTTP + Mailpit', () => {
  let app: INestApplication;
  const client = () => new AuthClient(app.getHttpServer());
  /** Đăng ký, mở link trong thư, đăng nhập: trả client đã có cookie + bearer. */
  const registered = async () => {
    const email = `w-${v7()}@example.test`; const c = client();
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    expect((await c.verifyEmailFromMailpit(mail, email)).status).toBeLessThan(400);
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    return { email, c };
  };
  const adminClient = async () => {
    const { email, c } = await registered();
    await promoteToAdmin(email);
    await c.signIn(email, PASSWORD);
    return c;
  };
  beforeAll(async () => { app = await startIdentityApp(); });
  afterAll(async () => app?.close());

  it('sign-up → verification email → the link works once → sign-in sets an HttpOnly, host-only, Lax cookie', async () => {
    const email = `v-${v7()}@example.test`; const c = client();
    await c.signUp(email, PASSWORD);
    expect((await c.signIn(email, PASSWORD)).body.code).toBe('email_not_verified');
    const started = Date.now();
    expect((await c.verifyEmailFromMailpit(mail, email, started)).status).toBeLessThan(400);
    expect((await c.verifyEmailFromMailpit(mail, email, started)).status).toBeGreaterThanOrEqual(400);
    const res = await c.signIn(email, PASSWORD);
    const cookie = [res.headers['set-cookie']].flat().find((x) => String(x).includes('session_token'));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
  });
  it('mobile: the bearer from set-auth-token authenticates /v1/me without cookies', async () => {
    const { c } = await registered();
    expect(c.bearer).toBeTruthy();
    expect((await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer })).status).toBe(200);
  });
  it('logout deletes the session and expires the cookie; the old cookie is then rejected', async () => {
    const { c } = await registered();
    const oldCookie = c.cookieHeader();
    expect((await c.request('post', '/api/auth/sign-out')).status).toBe(200);
    expect((await c.request('get', '/v1/me', { cookie: oldCookie })).status).toBe(401);
  });
  it('admin ban: cookie, bearer and API key of the victim are all 401 at the next request', async () => {
    const { email, c } = await registered();
    const key = (await c.request('post', '/api/auth/api-key/create', { body: { name: 'k' } })).body.key;
    const admin = await adminClient();
    const [{ id }] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    expect((await admin.request('post', '/api/auth/admin/ban-user', { body: { userId: id } })).status).toBe(200);
    expect((await c.request('get', '/v1/me')).status).toBe(401);
    expect((await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer })).status).toBe(401);
    expect((await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status).toBe(401);
  });
  it('admin remove-user: API keys disappear with the user (FK cascade)', async () => {
    const { email, c } = await registered();
    await c.request('post', '/api/auth/api-key/create', { body: { name: 'k' } });
    const [{ id }] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    await (await adminClient()).request('post', '/api/auth/admin/remove-user', { body: { userId: id } });
    expect(await ownerQuery(`SELECT 1 FROM auth.apikey WHERE reference_id = $1`, [id])).toEqual([]);
  });
  it('forgot password → email → reset → old cookie and old bearer are 401', async () => {
    const { email, c } = await registered();
    const oldCookie = c.cookieHeader(); const oldBearer = c.bearer;
    const started = Date.now();
    await client().request('post', '/api/auth/request-password-reset', { body: { email }, cookie: false });
    const msg = await mail.waitFor(email, { subject: /Reset your password/, after: started });
    const token = /\/reset-password\/([^?\s"<>]+)/.exec(msg.Text)?.[1];
    expect(token).toBeTruthy();
    expect((await client().request('post', '/api/auth/reset-password', { body: { token, newPassword: 'a whole new passphrase' }, cookie: false })).status).toBe(200);
    expect((await c.request('get', '/v1/me', { cookie: oldCookie })).status).toBe(401);
    expect((await c.request('get', '/v1/me', { cookie: false, bearer: oldBearer })).status).toBe(401);
  });
  it('change-password (client asks revokeOtherSessions=false): other cookie and bearer sessions are 401; the current one is replaced', async () => {
    const { email, c } = await registered();
    const other = client(); await other.signIn(email, PASSWORD);
    const r = await c.request('post', '/api/auth/change-password', { body: { currentPassword: PASSWORD, newPassword: 'changed passphrase ok', revokeOtherSessions: false } });
    expect(r.status).toBe(200);
    expect((await other.request('get', '/v1/me')).status).toBe(401);
    expect((await other.request('get', '/v1/me', { cookie: false, bearer: other.bearer })).status).toBe(401);
    expect((await c.request('get', '/v1/me')).status).toBe(200);
    expect((await other.request('get', '/api/auth/token')).status).toBe(401);
  });
  it('re-registering with a differently cased email is indistinguishable and creates no row', async () => {
    const { email } = await registered();
    const a = await client().signUp(`other-${v7()}@example.test`, PASSWORD);
    const b = await client().signUp(`  ${email.toUpperCase()} `, PASSWORD);
    expect([b.status, b.text, b.headers['set-cookie']]).toEqual([a.status, a.text, a.headers['set-cookie']]);
    expect(await ownerQuery(`SELECT 1 FROM auth."user" WHERE lower(email) = lower($1)`, [email])).toHaveLength(1);
  });
  it('a password longer than AUTH_PASSWORD_MAX_LENGTH is rejected with 422 before hashing', async () => {
    const r = await client().signUp(`long-${v7()}@example.test`, 'x'.repeat(10_000));
    expect([r.status, r.body.code]).toEqual([422, 'validation_failed']);
  });
});
```
(Tên endpoint admin `ban-user`, `remove-user`, `request-password-reset`, `reset-password` theo research 3 và `better-auth/dist/api/routes`; link đặt lại mật khẩu có dạng `${baseURL}/reset-password/<token>?callbackURL=…` — nếu S3/S7 cho thấy dạng khác thì sửa regex.)

- [ ] **Step 2: Chạy test**

Run: `pnpm vitest run --project integration test/e2e/identity/web-mobile.e2e.spec.ts`
Expected: PASS. Test nào fail là lỗi của task sở hữu code (Task 33/34/35/36): sửa ở file đó, chạy lại cả test của task đó.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/identity/web-mobile.e2e.spec.ts
git commit -m "test(identity): e2e web cookie and mobile bearer flows with mailpit, revocation, ban, reset and change password"
```

---

### Task 39: E2E 2FA, API key, JWT/JWKS (có xoay khoá), ma trận liên kết OIDC

**Files:**
- Create: `test/support/fake-idp.ts`
- Test: `test/e2e/identity/two-factor-apikey-jwt.e2e.spec.ts`, `test/e2e/identity/oidc-linking.e2e.spec.ts`

**Interfaces:**
- Consumes: như Task 38; `otpauth` (Task 1); `jose` (chỉ trong test).
- Produces: `startFakeIdp(): Promise<FakeIdp>` với `FakeIdp = { url: string; setClaims(c: Record<string, unknown>): void; close(): Promise<void> }` (discovery, token, userinfo). Bằng chứng cho tiêu chí 2 (JWT cho dịch vụ khác), 6, 11 và ma trận liên kết §5.4.

- [ ] **Step 1: Viết test**

`test/support/fake-idp.ts`:
```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeIdp = { url: string; setClaims(c: Record<string, unknown>): void; close(): Promise<void> };

/** IdP OIDC giả tối thiểu cho `genericOAuth`: discovery, token (mọi code hợp lệ), userinfo (claim cấu hình được). */
export async function startFakeIdp(): Promise<FakeIdp> {
  let claims: Record<string, unknown> = {};
  let base = '';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const path = (req.url ?? '').split('?')[0];
    if (path === '/.well-known/openid-configuration')
      return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo`, response_types_supported: ['code'] }));
    if (path === '/token') return res.end(JSON.stringify({ access_token: `at-${Date.now()}`, token_type: 'Bearer', expires_in: 3600 }));
    if (path === '/userinfo') return res.end(JSON.stringify(claims));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, setClaims: (c) => { claims = c; }, close: () => new Promise<void>((r) => server.close(() => r())) };
}
```
`test/e2e/identity/two-factor-apikey-jwt.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { URI } from 'otpauth';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp, verifyEmailDirect } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const PASSWORD = 'correct horse battery';
const ROTATION_SEC = 3600;
/** Hạn mặc định của API key (giây) cho test; plugin nhận GIÂY (review I3). */
const API_KEY_TTL_SEC = 86_400;
const EXPIRY_TOLERANCE_MS = 60_000;
/** Vượt mặc định 10 request/ngày của plugin (đã tắt ở Task 26). */
const API_KEY_CALLS = 15;
describe('2FA, API keys and JWT/JWKS', () => {
  let app: INestApplication;
  const signedIn = async () => {
    const email = `t-${v7()}@example.test`; const c = new AuthClient(app.getHttpServer());
    await c.signUp(email, PASSWORD); await verifyEmailDirect(email); await c.signIn(email, PASSWORD);
    return { email, c };
  };
  beforeAll(async () => { app = await startIdentityApp({ env: { AUTH_JWKS_ROTATION_INTERVAL_SEC: String(ROTATION_SEC), AUTH_API_KEY_DEFAULT_EXPIRES_IN_SEC: String(API_KEY_TTL_SEC), THROTTLE_DEFAULT_LIMIT: '1000' } }); });
  afterAll(async () => app?.close());

  it('TOTP: enable (fresh session) → pending sign-in cannot mint bearer/JWT/API key → TOTP → backup code → notice email', async () => {
    const { email, c } = await signedIn();
    const en = await c.request('post', '/api/auth/two-factor/enable', { body: { password: PASSWORD } });
    expect(en.status).toBe(200);
    const totp = URI.parse(en.body.totpURI);
    expect((await c.request('post', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } })).status).toBe(200);
    await mailpitFromInfra().waitFor(email, { subject: /Two-factor authentication turned on/ });
    const stored = await ownerQuery<{ backup_codes: string }>(`SELECT backup_codes FROM auth.two_factor t JOIN auth."user" u ON u.id = t.user_id WHERE u.email = $1`, [email]);
    expect(() => JSON.parse(stored[0]!.backup_codes)).toThrow();

    const p = new AuthClient(app.getHttpServer());
    const start = await p.signIn(email, PASSWORD);
    expect(start.body.twoFactorRedirect).toBe(true);
    expect(start.headers['set-auth-token']).toBeUndefined();
    expect((await p.request('get', '/api/auth/get-session')).body).toBeNull();
    expect((await p.request('get', '/api/auth/token')).status).toBe(401);
    expect((await p.request('post', '/api/auth/api-key/create', { body: { name: 'x' } })).status).toBe(401);
    expect((await p.request('post', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } })).status).toBe(200);
    expect((await p.request('get', '/v1/me')).status).toBe(200);

    const q = new AuthClient(app.getHttpServer());
    await q.signIn(email, PASSWORD);
    expect((await q.request('post', '/api/auth/two-factor/verify-backup-code', { body: { code: en.body.backupCodes[0] } })).status).toBe(200);
  });
  it('sensitive operations with a stale session → 403 reauthentication_required', async () => {
    const { email, c } = await signedIn();
    await ownerQuery(`UPDATE auth.session SET created_at = now() - interval '1 day' WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`, [email]);
    for (const [path, body] of [['/api/auth/api-key/create', { name: 'x' }], ['/api/auth/two-factor/enable', { password: PASSWORD }]] as const) {
      const r = await c.request('post', path, { body });
      expect([r.status, r.body.code]).toEqual([403, 'reauthentication_required']);
    }
  });
  it('API key: works on Nest routes, never acts as a session on /api/auth/*, and dies with deletion', async () => {
    const { c } = await signedIn();
    const created = await c.request('post', '/api/auth/api-key/create', { body: { name: 'ci' } });
    const key: string = created.body.key;
    expect((await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status).toBe(200);
    expect((await c.request('get', '/api/auth/get-session', { cookie: false, apiKey: key })).body).toBeNull();
    expect((await c.request('get', '/api/auth/token', { cookie: false, apiKey: key })).status).toBe(401);
    await c.request('post', '/api/auth/api-key/delete', { body: { keyId: created.body.id } });
    expect((await c.request('get', '/v1/me', { cookie: false, apiKey: key })).status).toBe(401);
  });
  it('API key: default expiry is AUTH_API_KEY_DEFAULT_EXPIRES_IN_SEC seconds, and more than 10 calls a day are allowed', async () => {
    const { c } = await signedIn();
    const created = await c.request('post', '/api/auth/api-key/create', { body: { name: 'machine' } });
    expect(created.status).toBe(200);
    const expiresInMs = new Date(created.body.expiresAt).getTime() - Date.now();
    expect(Math.abs(expiresInMs - API_KEY_TTL_SEC * 1000)).toBeLessThan(EXPIRY_TOLERANCE_MS);
    for (let i = 0; i < API_KEY_CALLS; i++)
      expect((await c.request('get', '/v1/me', { cookie: false, apiKey: created.body.key })).status, `call ${i + 1}`).toBe(200);
  });
  it('JWT for other services: verified with jose against the public JWKS; rotation keeps the old key in the grace period', async () => {
    const { email, c } = await signedIn();
    const first: string = (await c.request('get', '/api/auth/token')).body.token;
    const jwks = createLocalJWKSet((await c.request('get', '/api/auth/jwks', { cookie: false })).body);
    const { payload, protectedHeader } = await jwtVerify(first, jwks, { issuer: 'http://localhost:3000', audience: 'http://localhost:3000' });
    const [{ id }] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    expect(payload.sub).toBe(id);
    await ownerQuery(`UPDATE auth.jwks SET created_at = now() - make_interval(secs => $1 * 2)`, [ROTATION_SEC]);
    const second: string = (await c.request('get', '/api/auth/token')).body.token;
    const rotated = createLocalJWKSet((await c.request('get', '/api/auth/jwks', { cookie: false })).body);
    const v2 = await jwtVerify(second, rotated, { issuer: 'http://localhost:3000', audience: 'http://localhost:3000' });
    expect(v2.protectedHeader.kid).not.toBe(protectedHeader.kid);
    await expect(jwtVerify(first, rotated, { issuer: 'http://localhost:3000', audience: 'http://localhost:3000' })).resolves.toBeDefined();
    const priv = await ownerQuery<{ private_key: string }>(`SELECT private_key FROM auth.jwks LIMIT 1`);
    expect(priv[0]!.private_key).not.toMatch(/"d"\s*:/);
  });
});
```
`test/e2e/identity/oidc-linking.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { startFakeIdp, type FakeIdp } from '../../support/fake-idp.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';

const PROVIDER = 'corp';
const PASSWORD = 'correct horse battery';
let idp: FakeIdp;
beforeAll(async () => { idp = await startFakeIdp(); });
afterAll(async () => idp?.close());

/** Ma trận spec §5.4: chỉ provider tin cậy + email_verified === true + user local đã xác thực mới được liên kết. */
async function linkAttempt(app: INestApplication, localVerified: boolean, claims: Record<string, unknown>): Promise<boolean> {
  const email = `o-${v7()}@example.test`;
  const local = new AuthClient(app.getHttpServer());
  await local.signUp(email, PASSWORD);
  if (localVerified) await ownerQuery(`UPDATE auth."user" SET email_verified = true WHERE email = $1`, [email]);
  idp.setClaims({ sub: `idp-${v7()}`, email, name: 'O', ...claims });
  const c = new AuthClient(app.getHttpServer());
  const start = await c.request('post', '/api/auth/sign-in/oauth2', { body: { providerId: PROVIDER, callbackURL: '/' }, cookie: false });
  const authUrl = new URL(start.body.url);
  const callback = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
  await c.request('get', `${callback.pathname}?code=c1&state=${authUrl.searchParams.get('state')}`);
  const rows = await ownerQuery(`SELECT 1 FROM auth.account a JOIN auth."user" u ON u.id = a.user_id WHERE u.email = $1 AND a.provider_id = $2`, [email, PROVIDER]);
  return rows.length === 1;
}
const oidcEnv = (trusted: string) => ({
  AUTH_MODE: 'hybrid', AUTH_OIDC_PROVIDER_ID: PROVIDER, AUTH_OIDC_DISCOVERY_URL: `${idp.url}/.well-known/openid-configuration`,
  AUTH_OIDC_CLIENT_ID: 'client', AUTH_OIDC_CLIENT_SECRET: 'secret', AUTH_TRUSTED_PROVIDERS: trusted,
});

describe('OIDC account linking matrix (hybrid mode)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });

  it('untrusted provider + email_verified=true → not linked', async () => {
    app = await startIdentityApp({ env: oidcEnv('') });
    expect(await linkAttempt(app, true, { email_verified: true })).toBe(false);
  });
  it.each([
    ['claim missing', true, {}],
    ['email_verified=false', true, { email_verified: false }],
    ['email_verified="true" (string)', true, { email_verified: 'true' }],
    ['local user not verified', false, { email_verified: true }],
  ])('trusted provider + %s → not linked', async (_n, localVerified, claims) => {
    app = await startIdentityApp({ env: oidcEnv(PROVIDER) });
    expect(await linkAttempt(app, localVerified, claims)).toBe(false);
  });
  it('trusted provider + email_verified=true + verified local user → linked', async () => {
    app = await startIdentityApp({ env: oidcEnv(PROVIDER) });
    expect(await linkAttempt(app, true, { email_verified: true })).toBe(true);
  });
});
```
(Google dùng cùng `accountLinking` và mapper đã có test đơn vị ở Task 33; endpoint của Google không giả lập được nên ma trận chạy qua `genericOAuth`. Endpoint bắt đầu `/sign-in/oauth2` và tham số theo `better-auth/dist/plugins/generic-oauth/index.mjs` — kết quả S5.)

- [ ] **Step 2: Chạy test**

Run: `pnpm vitest run --project integration test/e2e/identity/two-factor-apikey-jwt.e2e.spec.ts test/e2e/identity/oidc-linking.e2e.spec.ts`
Expected: PASS (lỗi → sửa ở task sở hữu code).

- [ ] **Step 3: Commit**

```bash
git add test/support/fake-idp.ts test/e2e/identity/two-factor-apikey-jwt.e2e.spec.ts test/e2e/identity/oidc-linking.e2e.spec.ts
git commit -m "test(identity): e2e two-factor, api keys, jwt/jwks rotation and fail-closed oidc linking matrix"
```

---

### Task 40: E2E CSRF, đa credential, chống lộ email, rate limit fail-closed, `callbackURL`, PII của log Better Auth

**Files:**
- Test: `test/e2e/identity/csrf-duplicates.e2e.spec.ts`, `test/e2e/identity/enumeration-ratelimit.e2e.spec.ts`, `test/e2e/identity/telemetry.e2e.spec.ts`, `test/unit/modules/identity/mask-emails.spec.ts`

**Interfaces:**
- Consumes: như Task 38; `maskEmails` (Task 34); `installOtelCapture` (Task 27); `IdentityMetrics` (Task 36).
- Produces: không có code sản phẩm. Bằng chứng cho metric/span của spec §5.14 (review I8) và cho tiêu chí 3, 4, 8, 9, 16 và dòng CSRF/Đa credential/Chống lộ email/Rate limit của spec §8.

- [ ] **Step 1: Viết test**

`test/unit/modules/identity/mask-emails.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { maskEmails } from '../../../../src/modules/identity/infra/better-auth/auth-instance.js';

describe('Better Auth log messages never carry e-mail addresses', () => {
  it('masks every address', () => {
    expect(maskEmails('User with email Ann.B+x@Example.test not found; cc <c@d.io>')).toBe('User with email [email] not found; cc <[email]>');
  });
});
```

`test/e2e/identity/csrf-duplicates.e2e.spec.ts`:
```ts
import { Controller, Module, Post, type INestApplication } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { startIdentityApp, verifyEmailDirect } from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
@Controller('probe')
class ProbeController { @Post('write') write() { return { ok: true }; } }
@Module({ controllers: [ProbeController] })
class ProbeModule {}

/** Gửi raw header (giữ bản trùng) để kiểm luật trên `rawHeaders`. */
function rawRequest(app: INestApplication, method: string, path: string, headers: string[]): Promise<{ status: number; code?: string }> {
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, code: body.startsWith('{') ? JSON.parse(body).code : undefined }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('CSRF matrix (spec §5.6.2) and duplicate credentials (spec §5.6.1)', () => {
  let app: INestApplication; let c: AuthClient; let cookie = '';
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [ProbeModule], env: { AUTH_COOKIE_PREFIX: 'svc' } });
    await app.listen(0, '127.0.0.1');
    c = new AuthClient(app.getHttpServer());
    const email = `c-${v7()}@example.test`;
    await c.signUp(email, PASSWORD); await verifyEmailDirect(email); await c.signIn(email, PASSWORD);
    cookie = c.cookieHeader();
  });
  afterAll(async () => app?.close());

  const TRUSTED = 'http://localhost:3000';
  it.each([
    ['cookie + trusted Origin', { origin: TRUSTED }, 'pass'],
    ['cookie, no Origin, Sec-Fetch-Site same-origin', { origin: null, headers: { 'sec-fetch-site': 'same-origin' } }, 'pass'],
    ['cookie, only a trusted Referer', { origin: null, headers: { referer: `${TRUSTED}/page` } }, 403],
    ['cookie + cross-site Origin', { origin: 'https://evil.test' }, 403],
    ['cookie + same-site other-origin', { origin: 'http://other.localhost:3000' }, 403],
    ['cookie + Sec-Fetch-Site same-site', { origin: null, headers: { 'sec-fetch-site': 'same-site' } }, 403],
  ] as const)('%s on a Nest route and on /api/auth/update-user', async (_n, opts, want) => {
    for (const [path, body] of [['/probe/write', {}], ['/api/auth/update-user', { name: 'N' }]] as const) {
      const r = await c.request('post', path, { ...opts, cookie, body });
      if (want === 'pass') expect(r.status, path).toBeLessThan(400);
      else expect([r.status, r.body.code], path).toEqual([403, 'origin_not_allowed']);
    }
  });
  it('bearer only with a cross-site Origin is exempt from CSRF', async () => {
    expect((await c.request('post', '/probe/write', { origin: 'https://evil.test', cookie: false, bearer: c.bearer })).status).toBe(201);
  });
  it('a GET OAuth callback from a cross-site context is not CSRF-checked (a bad state is Better Auth\'s error)', async () => {
    const r = await c.request('get', '/api/auth/callback/google?state=bogus&code=x', { origin: 'https://evil.test', cookie: false });
    expect(r.status).not.toBe(403);
  });
  it.each([
    ['two Authorization headers', ['authorization', 'Bearer a', 'authorization', 'Bearer b']],
    ['two API key headers', ['x-api-key', 'a', 'x-api-key', 'b']],
    ['an API key list', ['x-api-key', 'a, b']],
    ['two Cookie headers with session cookies', ['cookie', 'svc.session_token=a', 'cookie', 'svc.session_token=b']],
    ['the same session cookie twice', ['cookie', 'svc.session_token=a; svc.session_token=b']],
    ['__Secure- and plain session cookie', ['cookie', '__Secure-svc.session_token=a; svc.session_token=b']],
    ['two_factor cookie twice', ['cookie', 'svc.two_factor=a; svc.two_factor=b']],
    ['malformed Authorization', ['authorization', 'Token abc']],
    ['cookie + bearer', ['cookie', 'svc.session_token=a', 'authorization', 'Bearer b']],
  ])('%s → 400 ambiguous_credentials on Nest routes and /api/auth/*', async (_n, headers) => {
    for (const path of ['/v1/me', '/api/auth/get-session'])
      expect(await rawRequest(app, 'GET', path, [...headers])).toEqual({ status: 400, code: 'ambiguous_credentials' });
  });
});
```
`test/e2e/identity/enumeration-ratelimit.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { ownerQuery, startIdentityApp, verifyEmailDirect } from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
const SIGNIN_RATE_MAX = 4;
const IGNORED_HEADERS = new Set(['date', 'x-request-id', 'etag', 'content-length']);
const shape = (r: { status: number; headers: Record<string, unknown>; text: string }) => ({
  status: r.status,
  headers: Object.keys(r.headers).filter((h) => !IGNORED_HEADERS.has(h)).sort(),
  body: r.text,
});

describe('no email enumeration; fail-closed rate limits; untrusted redirect targets', () => {
  let app: INestApplication;
  const client = () => new AuthClient(app.getHttpServer());
  const existing = async () => {
    const email = `e-${v7()}@example.test`;
    await client().signUp(email, PASSWORD); await verifyEmailDirect(email);
    return email;
  };
  beforeAll(async () => { app = await startIdentityApp({ env: { AUTH_SIGNIN_RATE_MAX: String(SIGNIN_RATE_MAX), AUTH_SIGNIN_RATE_WINDOW_SEC: '60' } }); });
  afterAll(async () => app?.close());

  it('sign-up: new vs existing email are identical (status, headers, body); at most one notice per window', async () => {
    const email = await existing();
    const fresh = shape(await client().signUp(`n-${v7()}@example.test`, PASSWORD));
    const again = shape(await client().signUp(email, PASSWORD));
    const third = shape(await client().signUp(email, PASSWORD));
    expect(again).toEqual(fresh);
    expect(third).toEqual(fresh);
    const [{ id }] = await ownerQuery<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [email]);
    expect(await ownerQuery(`SELECT 1 FROM email_deliveries WHERE idempotency_key LIKE $1`, [`existing-account:${id}:%`])).toHaveLength(1);
  });
  it('concurrent sign-ups with the same email all answer 202 and create exactly one user', async () => {
    const email = `race-${v7()}@example.test`;
    const results = await Promise.all(Array.from({ length: 5 }, () => client().signUp(email, PASSWORD)));
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(await ownerQuery(`SELECT 1 FROM auth."user" WHERE email = $1`, [email])).toHaveLength(1);
  });
  it('change-email: to a new address vs to a taken address → identical 202', async () => {
    const taken = await existing(); const me = await existing();
    const c = client(); await c.signIn(me, PASSWORD);
    const a = shape(await c.request('post', '/api/auth/change-email', { body: { newEmail: `x-${v7()}@example.test` } }));
    const b = shape(await c.request('post', '/api/auth/change-email', { body: { newEmail: taken } }));
    expect(b).toEqual(a);
  });
  it('forgot password: existing vs unknown email → identical responses', async () => {
    const email = await existing();
    const a = shape(await client().request('post', '/api/auth/request-password-reset', { body: { email }, cookie: false }));
    const b = shape(await client().request('post', '/api/auth/request-password-reset', { body: { email: `u-${v7()}@example.test` }, cookie: false }));
    expect(b).toEqual(a);
  });
  it('sign-in: wrong email vs wrong password → the same 401 invalid_credentials', async () => {
    const email = await existing();
    const a = await client().signIn(email, 'wrong-password-123');
    const b = await client().signIn(`u-${v7()}@example.test`, 'wrong-password-123');
    expect([a.status, a.body.code]).toEqual([401, 'invalid_credentials']);
    expect([b.status, b.body.code]).toEqual([a.status, a.body.code]);
  });
  it('per-IP limit → 429 problem+json with Retry-After (one client = one IP; other clients unaffected)', async () => {
    const codes: number[] = []; let retryAfter: string | undefined; let type: string | undefined;
    // `AuthClient` giữ một `x-forwarded-for` cố định cho cả vòng đời, nên cùng một client = cùng một IP.
    const sameIp = client();
    for (let i = 0; i < SIGNIN_RATE_MAX + 2; i++) {
      const r = await sameIp.signIn(`ip-${v7()}@example.test`, 'wrong-password-123');
      codes.push(r.status);
      if (r.status === 429) { retryAfter = r.headers['retry-after']; type = r.headers['content-type']; }
    }
    expect(codes).toContain(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(type).toContain('application/problem+json');
    expect((await client().signIn(`ip-${v7()}@example.test`, 'wrong-password-123')).status).toBe(401);
  });
  it.each(['rate_limit', 'login_attempts'])('storage failure on auth.%s → 503 with Retry-After on sign-in and 2FA verify, never 500', async (table) => {
    await ownerQuery(`REVOKE INSERT, UPDATE ON auth.${table} FROM auth_user`);
    try {
      const a = await client().signIn(`s-${v7()}@example.test`, 'whatever-password');
      const b = await client().request('post', '/api/auth/two-factor/verify-totp', { body: { code: '000000' }, cookie: false });
      for (const r of [a, b]) expect([r.status, r.headers['retry-after'] !== undefined]).toEqual([503, true]);
    } finally {
      await ownerQuery(`GRANT INSERT, UPDATE ON auth.${table} TO auth_user`);
    }
  });
  it('untrusted callbackURL is rejected on every public flow', async () => {
    const evil = 'https://evil.test/steal';
    const email = await existing();
    const flows = [
      client().request('post', '/api/auth/sign-up/email', { body: { email: `cb-${v7()}@example.test`, password: PASSWORD, name: 'C', callbackURL: evil }, cookie: false }),
      client().request('post', '/api/auth/send-verification-email', { body: { email, callbackURL: evil }, cookie: false }),
      client().request('post', '/api/auth/request-password-reset', { body: { email, redirectTo: evil }, cookie: false }),
      client().request('post', '/api/auth/sign-in/email', { body: { email, password: PASSWORD, callbackURL: evil }, cookie: false }),
    ];
    for (const r of await Promise.all(flows)) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.headers['content-type']).toContain('application/problem+json');
      expect(String(r.headers.location ?? '')).not.toContain('evil.test');
    }
  });
});
```
(Test "per-IP limit" dùng cổng rate limit của Better Auth (`/sign-in/*`); `/two-factor/verify-totp` không có cookie vẫn phải đi qua storage rate limit trước, nên thu hồi quyền trả `503`.)

`test/e2e/identity/telemetry.e2e.spec.ts` (review I8: mọi metric/span của spec §5.14 đều được đọc lại, không chỉ khai báo):
```ts
import { Controller, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../support/auth-client.js';
import { startIdentityApp, verifyEmailDirect } from '../../support/identity-app.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const PASSWORD = 'correct horse battery';
const LOCKOUT_MAX = 2;
@Controller('probe')
class ProbeController { @Post('write') write() { return { ok: true }; } }
@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('identity metrics and spans (spec §5.14)', () => {
  let app: INestApplication; let c: AuthClient; let email = '';
  beforeAll(async () => {
    app = await startIdentityApp({ extraImports: [ProbeModule], env: { AUTH_LOCKOUT_MAX_FAILURES: String(LOCKOUT_MAX) } });
    c = new AuthClient(app.getHttpServer());
    email = `m-${v7()}@example.test`;
    await c.signUp(email, PASSWORD); await verifyEmailDirect(email);
  });
  afterAll(async () => app?.close());

  it('identity_sign_in_total{result} counts success, invalid and limited', async () => {
    await c.signIn(email, PASSWORD);
    const other = new AuthClient(app.getHttpServer());
    const victim = `v-${v7()}@example.test`;
    for (let i = 0; i < LOCKOUT_MAX + 1; i++) await other.signIn(victim, 'wrong-password-123');
    expect(await otel.metric('identity_sign_in_total', { result: 'success' })).toBeGreaterThanOrEqual(1);
    expect(await otel.metric('identity_sign_in_total', { result: 'invalid' })).toBeGreaterThanOrEqual(LOCKOUT_MAX);
    expect(await otel.metric('identity_sign_in_total', { result: 'limited' })).toBeGreaterThanOrEqual(1);
    expect(await otel.metric('identity_lockout_blocked_total', { scope: 'signin' })).toBeGreaterThanOrEqual(1);
    expect(otel.spanNames()).toContain('identity.lockout.consume');
  });
  it('identity.authenticate span carries only the credential kind and result', async () => {
    otel.reset();
    expect((await c.request('get', '/v1/me', { cookie: false, bearer: c.bearer })).status).toBe(200);
    const [span] = otel.spans('identity.authenticate');
    expect(span?.attributes).toEqual({ 'identity.credential.kind': 'BEARER_SESSION', 'identity.auth.result': 'AUTHENTICATED' });
  });
  it('ambiguous credentials and CSRF rejections are counted', async () => {
    await request(app.getHttpServer()).get('/v1/me').set('authorization', `Bearer ${c.bearer}`).set('cookie', c.cookieHeader());
    await c.request('post', '/probe/write', { origin: 'https://evil.test', body: {} });
    expect(await otel.metric('identity_ambiguous_credentials_total')).toBeGreaterThanOrEqual(1);
    expect(await otel.metric('identity_csrf_rejected_total')).toBeGreaterThanOrEqual(1);
  });
  it('auth pool gauge is exported', async () => {
    expect(await otel.metric('identity_auth_pool_connections', { state: 'total' })).toBeGreaterThanOrEqual(1);
  });
  it('identity_auth_unavailable_total increases when the auth DB is unreachable (mount and principal middleware)', async () => {
    const before = (await otel.metric('identity_auth_unavailable_total')) ?? 0;
    const down = await startIdentityApp({ env: { DB_AUTH_PORT: '1', DB_AUTH_CONNECTION_TIMEOUT_MS: '200' } });
    try {
      const d = new AuthClient(down.getHttpServer());
      expect((await d.signIn(`d-${v7()}@example.test`, PASSWORD)).status).toBe(503);
      expect((await request(down.getHttpServer()).get('/v1/me').set('authorization', 'Bearer x')).status).toBe(503);
    } finally {
      await down.close();
    }
    expect(await otel.metric('identity_auth_unavailable_total')).toBeGreaterThanOrEqual(before + 2);
  });
});
```
(`c.cookieHeader()`, `c.bearer` là API của `AuthClient` ở Task 36. Không assert giá trị tuyệt đối của counter: global meter dùng chung cho cả file.)

- [ ] **Step 2: Chạy test**

Run: `pnpm vitest run --project unit test/unit/modules/identity/mask-emails.spec.ts && pnpm vitest run --project integration test/e2e/identity/csrf-duplicates.e2e.spec.ts test/e2e/identity/enumeration-ratelimit.e2e.spec.ts test/e2e/identity/telemetry.e2e.spec.ts`
Expected: PASS (lỗi → sửa ở task sở hữu code).

- [ ] **Step 3: Commit**

```bash
git add test/unit/modules/identity/mask-emails.spec.ts test/e2e/identity/csrf-duplicates.e2e.spec.ts test/e2e/identity/enumeration-ratelimit.e2e.spec.ts test/e2e/identity/telemetry.e2e.spec.ts
git commit -m "test(identity): csrf and duplicate-credential matrices, no email enumeration, fail-closed limits, untrusted redirects, telemetry"
```

---

### Task 41: `AUTH_MODE=external` — `JwksAuthProvider` (jose + `toWebFetch`)

**Files:**
- Create: `src/modules/identity/infra/jwks/jwks.provider.ts`, `src/modules/identity/infra/jwks/external-auth.module.ts`, `test/support/fake-jwks.ts`
- Modify: `src/modules/identity/identity.module.ts`
- Test: `test/integration/identity/jwks-provider.spec.ts`, `test/e2e/identity/external-mode.e2e.spec.ts`

**Interfaces:**
- Consumes: `toWebFetch`, `HttpClient`, `ResilienceModule` (Task 13); `AuthProvider`, `AuthResult` (Task 35); `identityConfig` (Task 25); `isExternalMode`; `identitySpan`, `installOtelCapture` (Task 27).
- Produces: `IDP_JWKS_PROVIDER = 'idp-jwks'`, `JwksAuthProvider` (verify `issuer`, `audience`, `algorithms`, `clockTolerance`, `requiredClaims: ['exp','iat','sub']`, `typ?`, `maxTokenAge?`; hợp đồng claim user/admin; lỗi JWKS/mạng → `UNAVAILABLE`, lỗi JOSE → `REJECTED`; span `identity.jwt.verify` với attribute `identity.auth.result`, review I8), `ExternalAuthModule` (`@Global`, export `AuthProvider`). `startFakeJwks(): Promise<FakeJwks>` với `FakeJwks = { url: string; sign(claims, opts?: { alg?; kid?; header? }): Promise<string>; slow(ms: number): void; closedConnections(): number; close() }`.

- [ ] **Step 1: Viết test fail**

`test/support/fake-jwks.ts`:
```ts
import { SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeJwks = {
  url: string;
  sign(claims: JWTPayload, opts?: { alg?: string; kid?: string; header?: Record<string, unknown>; foreign?: boolean }): Promise<string>;
  slow(ms: number): void;
  closedConnections(): number;
  close(): Promise<void>;
};
const ALG = 'RS256';
const KID = 'k1';

/** JWKS giả trên loopback: ký token bằng khoá thật; `foreign` ký bằng khoá không có trong JWKS. */
export async function startFakeJwks(): Promise<FakeJwks> {
  const own = await generateKeyPair(ALG);
  const foreign = await generateKeyPair(ALG);
  const pub: JWK = { ...(await exportJWK(own.publicKey)), kid: KID, alg: ALG, use: 'sig' };
  let delay = 0; let closed = 0;
  const server = createServer((req, res) => {
    res.on('close', () => { closed++; });
    const send = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [pub] })); };
    if (delay > 0) setTimeout(send, delay); else send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
  return {
    url,
    sign: (claims, o = {}) => new SignJWT(claims).setProtectedHeader({ alg: o.alg ?? ALG, kid: o.kid ?? KID, ...o.header }).sign((o.foreign ? foreign : own).privateKey),
    slow: (ms) => { delay = ms; },
    closedConnections: () => closed,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
```
`test/integration/identity/jwks-provider.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { ExternalAuthModule } from '../../../src/modules/identity/infra/jwks/external-auth.module.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const ISS = 'https://idp.example.test'; const AUD = 'api://boilerplate';
const TIMEOUT_MS = 300;
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: ISS, aud: AUD, sub: 'user-1', iat: now(), exp: now() + 300, idtyp: 'user', roles: ['reader'] });

describe('JwksAuthProvider (external mode)', () => {
  let jwks: FakeJwks; let app: INestApplication; let p: AuthProvider;
  const bearer = async (token: string) => p.authenticate({ headers: new Headers(), credential: { kind: 'EXTERNAL_BEARER', value: token } });
  beforeAll(async () => {
    jwks = await startFakeJwks();
    const port = new URL(jwks.url).port;
    for (const [k, v] of Object.entries({
      AUTH_MODE: 'external', AUTH_EXTERNAL_JWKS_URL: jwks.url, AUTH_EXTERNAL_ISSUER: ISS, AUTH_EXTERNAL_AUDIENCE: AUD,
      AUTH_EXTERNAL_ALGORITHMS: 'RS256,ES256', AUTH_EXTERNAL_USER_CLAIM: 'idtyp', AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
      AUTH_EXTERNAL_ADMIN_CLAIM: 'roles', AUTH_EXTERNAL_ADMIN_VALUE: 'admin', AUTH_EXTERNAL_JWKS_TIMEOUT_MS: String(TIMEOUT_MS),
      RESILIENCE_ALLOWED_SCHEMES: 'http,https', RESILIENCE_ALLOWED_PORTS: port, RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
    })) vi.stubEnv(k, v);
    app = await createTestApp([ResilienceModule, ExternalAuthModule]);
    p = app.get(AuthProvider);
  });
  afterAll(async () => { await app?.close(); await jwks?.close(); vi.unstubAllEnvs(); });
  beforeEach(() => jwks.slow(0));

  it('a valid user token authenticates; admin needs the exact array element', async () => {
    expect(await bearer(await jwks.sign(good()))).toMatchObject({ kind: 'AUTHENTICATED', principal: { type: 'user', id: 'user-1' }, credential: { kind: 'EXTERNAL_BEARER' }, isPlatformAdmin: false });
    expect(await bearer(await jwks.sign({ ...good(), roles: ['admin'] }))).toMatchObject({ isPlatformAdmin: true });
    expect(await bearer(await jwks.sign({ ...good(), roles: ['admins'] }))).toMatchObject({ isPlatformAdmin: false });
    expect(await bearer(await jwks.sign({ ...good(), roles: 'Admin' }))).toMatchObject({ isPlatformAdmin: false });
    expect(otel.spans('identity.jwt.verify').map((sp) => sp.attributes['identity.auth.result'])).toContain('AUTHENTICATED');
    expect(JSON.stringify(otel.spans('identity.jwt.verify').map((sp) => sp.attributes))).not.toContain('user-1');
  });
  it.each([
    ['missing exp', () => { const { exp: _e, ...c } = good(); return c; }],
    ['missing iat', () => { const { iat: _i, ...c } = good(); return c; }],
    ['missing sub', () => { const { sub: _s, ...c } = good(); return c; }],
    ['empty sub', () => ({ ...good(), sub: '' })],
    ['sub over 255 chars', () => ({ ...good(), sub: 'x'.repeat(256) })],
    ['wrong iss', () => ({ ...good(), iss: 'https://evil.test' })],
    ['wrong aud', () => ({ ...good(), aud: 'other' })],
    ['machine token', () => ({ ...good(), idtyp: 'app' })],
    ['user claim missing', () => { const { idtyp: _t, ...c } = good(); return c; }],
    ['expired', () => ({ ...good(), exp: now() - 3600 })],
  ])('%s → REJECTED', async (_n, claims) => {
    expect(await bearer(await jwks.sign(claims()))).toEqual({ kind: 'REJECTED' });
  });
  it('alg outside the list, unknown kid, foreign key and a jku pointing elsewhere are REJECTED', async () => {
    expect(await bearer(await jwks.sign(good(), { alg: 'RS512' }))).toEqual({ kind: 'REJECTED' });
    expect(await bearer(await jwks.sign(good(), { kid: 'nope' }))).toEqual({ kind: 'REJECTED' });
    expect(await bearer(await jwks.sign(good(), { foreign: true, header: { jku: 'https://evil.test/jwks' } }))).toEqual({ kind: 'REJECTED' });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(good())).toString('base64url')}.`;
    expect(await bearer(unsigned)).toEqual({ kind: 'REJECTED' });
  });
  it('a slow JWKS beyond the timeout → UNAVAILABLE and the request is really aborted', async () => {
    const fresh = await createTestApp([ResilienceModule, ExternalAuthModule]);
    try {
      jwks.slow(TIMEOUT_MS * 5);
      const before = jwks.closedConnections();
      expect(await fresh.get(AuthProvider).authenticate({ headers: new Headers(), credential: { kind: 'EXTERNAL_BEARER', value: await jwks.sign(good()) } })).toEqual({ kind: 'UNAVAILABLE' });
      await vi.waitFor(() => expect(jwks.closedConnections()).toBeGreaterThan(before));
    } finally {
      await fresh.close();
    }
  });
  it('session and API key credentials are REJECTED in external mode', async () => {
    for (const kind of ['SESSION_COOKIE', 'BEARER_SESSION', 'API_KEY'] as const)
      expect(await p.authenticate({ headers: new Headers(), credential: { kind, value: 'x' } })).toEqual({ kind: 'REJECTED' });
  });
});
```
`test/e2e/identity/external-mode.e2e.spec.ts`:
```ts
import { Controller, Get, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { startIdentityApp } from '../../support/identity-app.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';

@Controller('probe')
class Probe {
  constructor(private readonly ctx: RequestContext) {}
  @Get('who') who() { return { principal: this.ctx.principal(), credential: this.ctx.credential() }; }
  @Post('write') write() { return { ok: true }; }
}
@Module({ controllers: [Probe] })
class ProbeModule {}
const ISS = 'https://idp.example.test'; const AUD = 'api://boilerplate'; const COOKIE = 'idp_token';
const now = () => Math.floor(Date.now() / 1000);

describe('AUTH_MODE=external end to end', () => {
  let app: INestApplication; let jwks: FakeJwks; let token = '';
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startIdentityApp({
      extraImports: [ResilienceModule, ProbeModule],
      env: {
        AUTH_MODE: 'external', BETTER_AUTH_SECRET: '', DB_AUTH_PASSWORD: '', AUTH_EXTERNAL_JWKS_URL: jwks.url, AUTH_EXTERNAL_ISSUER: ISS,
        AUTH_EXTERNAL_AUDIENCE: AUD, AUTH_EXTERNAL_ALGORITHMS: 'RS256', AUTH_EXTERNAL_USER_CLAIM: 'idtyp', AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
        AUTH_EXTERNAL_TOKEN_COOKIE: COOKIE, RESILIENCE_ALLOWED_SCHEMES: 'http,https', RESILIENCE_ALLOWED_PORTS: new URL(jwks.url).port,
        RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
      },
    });
    token = await jwks.sign({ iss: ISS, aud: AUD, sub: 'ext-1', iat: now(), exp: now() + 300, idtyp: 'user' });
  });
  afterAll(async () => { await app?.close(); await jwks?.close(); vi.unstubAllEnvs(); });
  const http = () => request(app.getHttpServer());

  it('token via header and via cookie authenticate the same principal', async () => {
    const a = await http().get('/probe/who').set('authorization', `Bearer ${token}`);
    const b = await http().get('/probe/who').set('cookie', `${COOKIE}=${token}`);
    expect(a.body).toEqual({ principal: { type: 'user', id: 'ext-1' }, credential: { kind: 'EXTERNAL_BEARER' } });
    expect(b.body.credential).toEqual({ kind: 'EXTERNAL_COOKIE' });
  });
  it('header + cookie together → 400 ambiguous_credentials; a machine token → 401', async () => {
    expect((await http().get('/probe/who').set('authorization', `Bearer ${token}`).set('cookie', `${COOKIE}=${token}`)).status).toBe(400);
    const machine = await jwks.sign({ iss: ISS, aud: AUD, sub: 'svc', iat: now(), exp: now() + 300, idtyp: 'app' });
    expect((await http().get('/probe/who').set('authorization', `Bearer ${machine}`)).status).toBe(401);
  });
  it('cookie token POST from a cross-site Origin → 403', async () => {
    const r = await http().post('/probe/write').set('cookie', `${COOKIE}=${token}`).set('origin', 'https://evil.test');
    expect([r.status, r.body.code]).toEqual([403, 'origin_not_allowed']);
  });
  it('Better Auth is not mounted: /api/auth/* and /v1/me do not exist; readiness has no auth_database', async () => {
    expect((await http().post('/api/auth/sign-in/email').set('authorization', `Bearer ${token}`).send({})).status).toBe(404);
    expect((await http().get('/v1/me').set('authorization', `Bearer ${token}`)).status).toBe(404);
    const ready = await http().get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.info).not.toHaveProperty('auth_database');
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/identity/jwks-provider.spec.ts test/e2e/identity/external-mode.e2e.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/modules/identity/infra/jwks/jwks.provider.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from 'jose';
import { HttpClient, toWebFetch } from '../../../../core/resilience/index.js';
import { identitySpan } from '../../identity-telemetry.js';
import { identityConfig, type IdentityConfig } from '../../identity.config.js';
import { AuthProvider, type AuthResult } from '../../ports/auth-provider.js';
import type { DetectedCredential } from '../../http/credential-detector.js';

/** Tên provider của breaker/bulkhead trong `HttpClient` (hằng số, không phải host). */
export const IDP_JWKS_PROVIDER = 'idp-jwks';
const MAX_SUB_LENGTH = 255;
const REQUIRED_CLAIMS = ['exp', 'iat', 'sub'];
const REJECTED: AuthResult = { kind: 'REJECTED' };

/**
 * `AUTH_MODE=external` (spec §5.6.3): một resolver JWKS cho cả process, fetch đi qua `HttpClient` chặn SSRF
 * (`toWebFetch`: timeout của jose thật sự huỷ request). Không đi theo `jku`/`x5u`. Chỉ nhận token của user.
 */
@Injectable()
export class JwksAuthProvider extends AuthProvider {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(identityConfig.KEY) private readonly cfg: IdentityConfig, http: HttpClient) {
    super();
    if (!cfg.externalJwksUrl) throw new Error('AUTH_EXTERNAL_JWKS_URL is required in external mode');
    this.jwks = createRemoteJWKSet(new URL(cfg.externalJwksUrl), {
      timeoutDuration: cfg.externalJwksTimeoutMs,
      cooldownDuration: cfg.externalJwksCooldownMs,
      cacheMaxAge: cfg.externalJwksCacheMaxAgeMs,
      [customFetch]: toWebFetch(http, IDP_JWKS_PROVIDER),
    });
  }

  async authenticate(input: { headers: Headers; credential: DetectedCredential }): Promise<AuthResult> {
    const { kind, value } = input.credential;
    switch (kind) {
      case 'EXTERNAL_COOKIE':
      case 'EXTERNAL_BEARER':
        // Không đưa token/sub vào span (spec §5.14): chỉ kết quả phân loại.
        return identitySpan('identity.jwt.verify', () => this.verify(value, kind), (r) => ({ 'identity.auth.result': r.kind }));
      case 'SESSION_COOKIE':
      case 'BEARER_SESSION':
      case 'API_KEY':
        return REJECTED;
      default: {
        const unknown: never = kind;
        throw new Error(`unknown credential kind ${String(unknown)}`);
      }
    }
  }

  private async verify(token: string, kind: 'EXTERNAL_COOKIE' | 'EXTERNAL_BEARER'): Promise<AuthResult> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.cfg.externalIssuer,
        audience: this.cfg.externalAudience,
        algorithms: this.cfg.externalAlgorithms,
        clockTolerance: this.cfg.externalClockToleranceSec,
        requiredClaims: REQUIRED_CLAIMS,
        ...(this.cfg.externalTyp ? { typ: this.cfg.externalTyp } : {}),
        ...(this.cfg.externalMaxTokenAgeSec ? { maxTokenAge: `${this.cfg.externalMaxTokenAgeSec}s` } : {}),
      }));
    } catch (err) {
      if (err instanceof errors.JWKSTimeout) return { kind: 'UNAVAILABLE' };
      if (err instanceof errors.JOSEError) return REJECTED;
      // Lỗi mạng/upstream khi lấy JWKS (UpstreamError, SsrfBlockedError…): IdP không dùng được.
      return { kind: 'UNAVAILABLE' };
    }
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUB_LENGTH) return REJECTED;
    const userClaim = this.cfg.externalUserClaim;
    if (!userClaim || payload[userClaim] !== this.cfg.externalUserClaimValue) return REJECTED;
    return { kind: 'AUTHENTICATED', principal: { type: 'user', id: sub }, credential: { kind }, isPlatformAdmin: this.isAdmin(payload) };
  }

  /** So khớp chính xác (chuỗi bằng nhau, hoặc mảng chứa đúng phần tử); không so chuỗi con, không đổi hoa thường. */
  private isAdmin(payload: JWTPayload): boolean {
    const { externalAdminClaim: claim, externalAdminValue: value } = this.cfg;
    if (!claim || !value) return false;
    const v = payload[claim];
    return v === value || (Array.isArray(v) && v.includes(value));
  }
}
```
`src/modules/identity/infra/jwks/external-auth.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ResilienceModule } from '../../../../core/resilience/index.js';
import { AuthProvider } from '../../ports/auth-provider.js';
import { JwksAuthProvider } from './jwks.provider.js';

/** `external`: không có Better Auth, pool `auth_user` hay `/api/auth/*`; parser body vẫn do core (spec §5.5). */
@Global()
@Module({
  imports: [ResilienceModule],
  providers: [JwksAuthProvider, { provide: AuthProvider, useExisting: JwksAuthProvider }],
  exports: [AuthProvider],
})
export class ExternalAuthModule {}
```
`src/modules/identity/identity.module.ts`: import `ExternalAuthModule`, `isExternalMode`; thêm `ConditionalModule.registerWhen(ExternalAuthModule, isExternalMode)` vào `imports` của **cả** `forApi()` và `forWorker()` (worker dùng cho authorizer của dashboard, Task 45).

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/integration/identity/jwks-provider.spec.ts test/e2e/identity && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS (`jose` chỉ import trong `identity/infra/jwks/**`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity test/support/fake-jwks.ts test/integration/identity/jwks-provider.spec.ts test/e2e/identity/external-mode.e2e.spec.ts
git commit -m "feat(identity): external mode with SSRF-safe JWKS verification and a strict user-token claim contract"
```

---

### Task 42: Chaos — Redis sập, SMTP sập, DB auth bị cắt

**Files:**
- Test: `test/chaos/identity-outages.spec.ts`

**Interfaces:**
- Consumes: `startIdentityApp` (Task 37), `ReconcileDeliveriesHandler` (Task 24), `AuthClient`, `Mailpit`, `readImages`, Toxiproxy (SP1).
- Produces: bằng chứng cho tiêu chí 7, 8 của spec §1 và dòng "Chaos" của §8.

- [ ] **Step 1: Viết test**

`test/chaos/identity-outages.spec.ts`:
```ts
import { Logger, type INestApplication } from '@nestjs/common';
import { ToxiProxyContainer, type CreatedProxy, type StartedToxiProxyContainer } from '@testcontainers/toxiproxy';
import request from 'supertest';
import { GenericContainer, Network, TestContainers, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReconcileDeliveriesHandler } from '../../src/modules/notifications/application/reconcile-deliveries.handler.js';
import { AuthClient } from '../support/auth-client.js';
import { startIdentityApp, verifyEmailDirect, ownerQuery } from '../support/identity-app.js';
import { getInfra } from '../support/infra.js';
import { Mailpit } from '../support/mailpit.js';
import { readImages } from '../support/images.js';

const REDIS_PORT = 6379; const SMTP_PORT = 1025; const MAILPIT_API = 8025;
const PASSWORD = 'correct horse battery';

describe('identity and email under dependency outages', () => {
  let net: StartedNetwork; let redis: StartedTestContainer; let mailpitC: StartedTestContainer; let toxi: StartedToxiProxyContainer;
  let redisProxy: CreatedProxy; let smtpProxy: CreatedProxy; let authDbProxy: CreatedProxy; let app: INestApplication; let mailpit: Mailpit;
  beforeAll(async () => {
    const images = readImages();
    const { pg } = getInfra();
    await TestContainers.exposeHostPorts(pg.port);
    net = await new Network().start();
    redis = await new GenericContainer(images.IMAGE_REDIS!).withNetwork(net).withNetworkAliases('redis').withExposedPorts(REDIS_PORT).start();
    mailpitC = await new GenericContainer(images.IMAGE_MAILPIT!).withNetwork(net).withNetworkAliases('mailpit').withExposedPorts(MAILPIT_API).start();
    toxi = await new ToxiProxyContainer(images.IMAGE_TOXIPROXY!).withNetwork(net).start();
    redisProxy = await toxi.createProxy({ name: 'redis', upstream: `redis:${REDIS_PORT}` });
    smtpProxy = await toxi.createProxy({ name: 'smtp', upstream: `mailpit:${SMTP_PORT}` });
    authDbProxy = await toxi.createProxy({ name: 'authdb', upstream: `host.testcontainers.internal:${pg.port}` });
    mailpit = new Mailpit(`http://${mailpitC.getHost()}:${mailpitC.getMappedPort(MAILPIT_API)}`);
    app = await startIdentityApp({
      env: {
        REDIS_URL: `redis://${redisProxy.host}:${redisProxy.port}`,
        SMTP_HOST: smtpProxy.host, SMTP_PORT: String(smtpProxy.port),
        DB_AUTH_HOST: authDbProxy.host, DB_AUTH_PORT: String(authDbProxy.port), DB_AUTH_CONNECTION_TIMEOUT_MS: '500',
        OUTBOX_POLL_INTERVAL_MS: '200', QUEUE_DEFAULT_BACKOFF_MS: '500', QUEUE_DEFAULT_ATTEMPTS: '3',
        NOTIFICATIONS_CLAIM_LEASE_MS: '1500', SMTP_SEND_DEADLINE_MS: '1000', NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC: '1',
      },
    });
  });
  afterAll(async () => { await app?.close(); await toxi?.stop(); await mailpitC?.stop(); await redis?.stop(); await net?.stop(); vi.unstubAllEnvs(); });

  it('Redis down: sign-in, /v1/me and 2FA still work; the verification email waits in the outbox and is sent after recovery', async () => {
    await redisProxy.setEnabled(false);
    try {
      const email = `r-${v7()}@example.test`; const c = new AuthClient(app.getHttpServer());
      expect((await c.signUp(email, PASSWORD)).status).toBe(202);
      await verifyEmailDirect(email);
      expect((await c.signIn(email, PASSWORD)).status).toBe(200);
      expect((await c.request('get', '/v1/me')).status).toBe(200);
      expect((await c.request('post', '/api/auth/two-factor/enable', { body: { password: PASSWORD } })).status).toBe(200);
      await redisProxy.setEnabled(true);
      await mailpit.waitFor(email, { subject: /Verify your email/, timeoutMs: 60_000 });
    } finally {
      await redisProxy.setEnabled(true);
    }
  });
  it('SMTP down: jobs retry, the api stays ready, and the stuck email is reconciled once SMTP is back', async () => {
    await smtpProxy.setEnabled(false);
    const email = `m-${v7()}@example.test`;
    try {
      await new AuthClient(app.getHttpServer()).signUp(email, PASSWORD);
      await vi.waitFor(async () => {
        const [row] = await ownerQuery<{ attempts: number }>(`SELECT attempts FROM email_deliveries WHERE state IN ('PENDING','FAILED') AND idempotency_key LIKE 'verify-email:%' ORDER BY id DESC LIMIT 1`);
        expect(row?.attempts ?? 0).toBeGreaterThan(0);
      }, { timeout: 30_000 });
      expect((await request(app.getHttpServer()).get('/health/ready')).status).toBe(200);
    } finally {
      await smtpProxy.setEnabled(true);
    }
    await ownerQuery(`UPDATE email_deliveries SET last_enqueued_at = now() - interval '1 hour' WHERE state = 'PENDING'`);
    await app.get(ReconcileDeliveriesHandler).handle({ payload: {}, meta: {}, jobId: v7(), attempt: 1, maxAttempts: 1, signal: new AbortController().signal, log: new Logger('t') });
    await mailpit.waitFor(email, { subject: /Verify your email/, timeoutMs: 60_000 });
  });
  it('auth DB cut: sign-in and cookie requests answer 503 with Retry-After, never 500', async () => {
    const email = `d-${v7()}@example.test`; const c = new AuthClient(app.getHttpServer());
    await c.signUp(email, PASSWORD); await verifyEmailDirect(email); await c.signIn(email, PASSWORD);
    await authDbProxy.setEnabled(false);
    try {
      const signIn = await new AuthClient(app.getHttpServer()).signIn(email, PASSWORD);
      const me = await c.request('get', '/v1/me');
      for (const r of [signIn, me]) expect([r.status, r.headers['retry-after'] !== undefined]).toEqual([503, true]);
    } finally {
      await authDbProxy.setEnabled(true);
    }
  });
});
```

- [ ] **Step 2: Chạy test**

Run: `pnpm vitest run --project chaos test/chaos/identity-outages.spec.ts`
Expected: PASS (lỗi → sửa ở task sở hữu code; không nới timeout của assertion để che lỗi).

- [ ] **Step 3: Commit**

```bash
git add test/chaos/identity-outages.spec.ts
git commit -m "test(chaos): auth survives redis loss, email recovers after smtp outage, auth db cut answers 503"
```

---

### Task 43: Kiểm chứng prod-like #1 — auth + email trên image production (`NODE_ENV=production`)

**Files:**
- Modify: `test/smoke/smoke-app-env.ts`, `compose.yaml` (SMTP của worker)
- Create: `test/smoke/auth-email.smoke.spec.ts`

**Interfaces:**
- Consumes: bộ smoke (Task 17), toàn bộ Phần D và E.
- Produces: `smokeAppEnv` có config production của identity + notifications; smoke HTTP thật phủ: đăng ký, thư tới Mailpit (qua API của Mailpit), xác thực, đăng nhập bằng cookie, route bảo vệ, CSRF bị từ chối, request bearer, request API key, 2FA, khoá tài khoản (`429`) và `503` khi storage lỗi, đăng xuất; log container không PII/không lỗi; `/health/ready`.

- [ ] **Step 1: Config production của module cho smoke, SMTP của worker trong compose**

`compose.yaml` → `worker.environment` thêm (chỉ worker gửi mail, spec §9):
```yaml
      SMTP_HOST: mailpit
      SMTP_PORT: '1025'
```
và `api.environment`: `SMTP_HOST: ''` (api không gửi mail).

`test/smoke/smoke-app-env.ts`:
```ts
/**
 * Config production bổ sung của module cho container app (plan SP2 Task 43; Task 46 thêm dashboard).
 * Không khoá nào tắt luật production: https base URL, Secure cookie, rate limit bật, SMTP STARTTLS + verify.
 */
export const SMOKE_BASE_URL = 'https://localhost';
export const SMOKE_LOCKOUT_MAX = 3;
export const smokeAppEnv = (s: { secret: (bytes?: number) => string }): Record<string, string> => ({
  AUTH_MODE: 'local',
  BETTER_AUTH_SECRET: s.secret(36),
  AUTH_BASE_URL: SMOKE_BASE_URL,
  AUTH_SECURE_COOKIES: 'true',
  HTTP_CORS_ORIGINS: SMOKE_BASE_URL,
  AUTH_LOCKOUT_MAX_FAILURES: String(SMOKE_LOCKOUT_MAX),
  SMTP_REQUIRE_TLS: 'true',
  SMTP_TLS_REJECT_UNAUTHORIZED: 'true',
  MAIL_FROM: 'Boilerplate <noreply@example.test>',
});
```
Không liệt kê lại khoá có default: `buildSmokeEnv` đã lấy toàn bộ từ `.env.example` (Task 17). Thiếu khoá `(required)` mới của identity/notifications → `assertSmokePreflight` fail trước `docker build` với tên khoá; thêm giá trị smoke vào đây, không nới schema.

- [ ] **Step 2: Viết smoke test**

`test/smoke/auth-email.smoke.spec.ts`:
```ts
import { URI } from 'otpauth';
import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { Mailpit } from '../support/mailpit.js';
import { SMOKE_BASE_URL, SMOKE_LOCKOUT_MAX } from './smoke-app-env.js';
import { CookieJar, assertCleanLogs, logsSince, psql, workerHealth } from './smoke-support.js';

const PASSWORD = 'smoke correct horse battery';
const EVIL = 'https://evil.example.test';

describe('prod-like smoke: identity + email (NODE_ENV=production, TLS everywhere)', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const mail = new Mailpit(mailpitApiUrl);
  const since = new Date().toISOString();
  const email = `smoke-${randomUUID()}@example.test`;
  const jar = new CookieJar();
  let bearer = '';
  let apiKey = '';
  const call = async (method: string, path: string, o: { body?: unknown; origin?: string | null; cookie?: boolean; auth?: string; apiKey?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (o.origin !== null) headers.origin = o.origin ?? SMOKE_BASE_URL;
    if (o.cookie !== false && jar.header()) headers.cookie = jar.header();
    if (o.auth) headers.authorization = `Bearer ${o.auth}`;
    if (o.apiKey) headers['x-api-key'] = o.apiKey;
    const res = await fetch(`${apiUrl}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: 'manual' });
    if (o.cookie !== false) jar.absorb(res);
    return res;
  };

  it('sign-up answers 202 and the verification email arrives through SMTP STARTTLS', async () => {
    expect((await call('POST', '/api/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'Smoke' }, cookie: false })).status).toBe(202);
    const msg = await mail.waitFor(email, { subject: /Verify your email/, timeoutMs: 60_000 });
    const link = /https:\/\/localhost\/api\/auth\/verify-email\?[^\s"<>]+/.exec(msg.Text)?.[0];
    expect(link).toBeTruthy();
    const u = new URL(link!);
    // Link trỏ AUTH_BASE_URL (https, sau ingress); smoke gọi cùng path trên cổng HTTP nội bộ của api.
    expect((await call('GET', `${u.pathname}${u.search}`, { cookie: false })).status).toBeLessThan(400);
  });
  it('sign-in sets a Secure, HttpOnly __Secure- session cookie and a mobile bearer', async () => {
    const res = await call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
    expect(res.status).toBe(200);
    const session = res.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(session).toMatch(/^__Secure-/);
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/HttpOnly/i);
    bearer = res.headers.get('set-auth-token') ?? '';
    expect(bearer).not.toBe('');
  });
  it('protected route: cookie → 200, anonymous → 401', async () => {
    expect((await call('GET', '/v1/me')).status).toBe(200);
    expect((await call('GET', '/v1/me', { cookie: false })).status).toBe(401);
  });
  it('CSRF: a cookie POST from a cross-site Origin is rejected with 403', async () => {
    const r = await call('POST', '/api/auth/update-user', { body: { name: 'x' }, origin: EVIL });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('origin_not_allowed');
  });
  it('bearer request (mobile) → 200', async () => {
    expect((await call('GET', '/v1/me', { cookie: false, auth: bearer })).status).toBe(200);
  });
  it('API key request (machine) → 200 as the owning user', async () => {
    const created = await call('POST', '/api/auth/api-key/create', { body: { name: 'smoke' } });
    expect(created.status).toBe(200);
    apiKey = (await created.json()).key;
    expect((await call('GET', '/v1/me', { cookie: false, apiKey })).status).toBe(200);
  });
  it('2FA: enable, verify with TOTP, a new sign-in needs the code, and the notice email arrives', async () => {
    const en = await call('POST', '/api/auth/two-factor/enable', { body: { password: PASSWORD } });
    expect(en.status).toBe(200);
    const totp = URI.parse((await en.json()).totpURI);
    expect((await call('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp.generate() } })).status).toBe(200);
    await mail.waitFor(email, { subject: /Two-factor authentication turned on/, timeoutMs: 60_000 });
    const pending = new CookieJar();
    const start = await fetch(`${apiUrl}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SMOKE_BASE_URL }, body: JSON.stringify({ email, password: PASSWORD }) });
    pending.absorb(start);
    expect((await start.json()).twoFactorRedirect).toBe(true);
    const done = await fetch(`${apiUrl}/api/auth/two-factor/verify-totp`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SMOKE_BASE_URL, cookie: pending.header() }, body: JSON.stringify({ code: totp.generate() }) });
    expect(done.status).toBe(200);
  });
  it('lockout: after the failure budget the account answers 429; a storage failure answers 503 (never 500)', async () => {
    const victim = `lock-${randomUUID()}@example.test`;
    const attempt = () => call('POST', '/api/auth/sign-in/email', { body: { email: victim, password: 'wrong-wrong-wrong' }, cookie: false });
    const codes: number[] = [];
    for (let i = 0; i <= SMOKE_LOCKOUT_MAX; i++) codes.push((await attempt()).status);
    expect(codes.at(-1)).toBe(429);
    psql('REVOKE INSERT, UPDATE ON auth.login_attempts FROM auth_user');
    try {
      const r = await call('POST', '/api/auth/sign-in/email', { body: { email: `x-${randomUUID()}@example.test`, password: 'whatever-pass' }, cookie: false });
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBeTruthy();
    } finally {
      psql('GRANT INSERT, UPDATE ON auth.login_attempts TO auth_user');
    }
  });
  it('logout revokes the session; the old cookie is 401', async () => {
    const old = jar.header();
    expect((await call('POST', '/api/auth/sign-out')).status).toBe(200);
    const r = await fetch(`${apiUrl}/v1/me`, { headers: { cookie: old } });
    expect(r.status).toBe(401);
  });
  it('/health/ready is 200 (api), the worker is healthy, and logs carry no PII and no errors', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(logsSince(since), [email, PASSWORD, bearer, apiKey].filter(Boolean));
  });
});
```
(Hai test lockout/503 cố ý tạo lỗi phía client, không phải dòng log mức error: `503` do lockout là `AppError expected` → `warn`. Nếu `assertCleanLogs` bắt được dòng `error` thì đó là lỗi thật cần sửa, không nới điều kiện.)

- [ ] **Step 3: Chạy smoke (build image production thật, compose, migrate, smoke, dọn)**

Run: `pnpm test:smoke`
Expected: `core.smoke.spec.ts` và `auth-email.smoke.spec.ts` PASS; teardown in log và chạy `docker compose --profile app down -v`. Xác nhận `docker compose -p nsb-smoke ps -a` rỗng.

- [ ] **Step 4: Commit**

```bash
git add test/smoke compose.yaml
git commit -m "test(smoke): prod-like identity and email smoke on the production image (tls, secure cookies, csrf, lockout)"
```

---
## Phần F — Bull Board (D9)

### Task 44: `core/queue/dashboard` — server Bull Board read-only trên cổng nội bộ của worker

**Files:**
- Create: `src/core/queue/dashboard/queue-dashboard.config.ts`, `src/core/queue/dashboard/queue-dashboard.authorizer.ts`, `src/core/queue/dashboard/queue-dashboard.server.ts`
- Modify: `src/core/queue/queue.module.ts`, `src/core/queue/index.ts`, `src/core/config/all-configs.ts`, `src/core/config/dev-infra.config.ts` (`QUEUE_DASHBOARD_PORT_HOST`, `COMPOSE_SUBNET`), `.env.example`, `.env.infra.example` (sinh lại)
- Test: `test/integration/core/queue/queue-dashboard.spec.ts`, `test/unit/core/queue/queue-dashboard-config.spec.ts`

**Interfaces:**
- Consumes: `queueRegistry`, `redisConfig`, `redisClientOptions`, `REDIS_NAMESPACE`, `writeProblem`, `AppError`, `CoreErrors`, `errorsConfig` (SP1 + Task 9).
- Produces:
  - `queueDashboardConfig` (namespace `queueDashboard`): `enabled`, `host`, `port`, `basePath`, `ipAllowlist: string[]`; luật production "bật thì allowlist không rỗng".
  - `type QueueDashboardDecision = { allowed: true } | { allowed: false; error: ErrorCode; headers?: Record<string, string> }`, `abstract class QueueDashboardAuthorizer { authorize(req: IncomingMessage): Promise<QueueDashboardDecision> }` (export từ `core/queue/index.ts`; identity cài đặt ở Task 45).
  - `QueueDashboardServer` (provider của `QueueModule.forRoot({ runWorkers: true })`): `express()` riêng, IP allowlist bằng `net.BlockList` của Node → authorizer → router Bull Board; mọi queue `BullMQAdapter(queue, { readOnlyMode: true })`; mở ở `onApplicationBootstrap`, đóng ở `beforeApplicationShutdown` và trên mọi đường lỗi; bật mà thiếu authorizer → worker không khởi động; `address(): AddressInfo`.

- [ ] **Step 1: Viết test fail**

`test/unit/core/queue/queue-dashboard-config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { queueDashboardConfig } from '../../../../src/core/queue/dashboard/queue-dashboard.config.js';

describe('queueDashboardConfig', () => {
  it('defaults: disabled, loopback only, empty allowlist', () => {
    expect(queueDashboardConfig.schema.parse({})).toEqual({ enabled: false, host: '127.0.0.1', port: 3002, basePath: '/queues', ipAllowlist: [] });
  });
  it('accepts IPs and CIDRs, rejects garbage', () => {
    expect(queueDashboardConfig.schema.parse({ ipAllowlist: '10.0.0.0/8, 127.0.0.1' }).ipAllowlist).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(queueDashboardConfig.schema.safeParse({ ipAllowlist: 'not-an-ip' }).success).toBe(false);
  });
});
```
`test/integration/core/queue/queue-dashboard.spec.ts`:
```ts
import { Global, Injectable, Module, type INestApplication } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreErrors } from '../../../../src/core/errors/index.js';
import { QueueDashboardAuthorizer, QueueModule, type QueueDashboardDecision } from '../../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../../src/core/queue/dashboard/queue-dashboard.server.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';

@Injectable()
class HeaderAuthorizer extends QueueDashboardAuthorizer {
  async authorize(req: IncomingMessage): Promise<QueueDashboardDecision> {
    return req.headers['x-test-allow'] === 'yes' ? { allowed: true } : { allowed: false, error: CoreErrors.FORBIDDEN };
  }
}
@Global()
@Module({ providers: [{ provide: QueueDashboardAuthorizer, useClass: HeaderAuthorizer }], exports: [QueueDashboardAuthorizer] })
class AuthorizerModule {}

const env = (allow: string) => {
  vi.stubEnv('APP_ROLE', 'worker');
  vi.stubEnv('WORKER_QUEUES', 'maintenance');
  vi.stubEnv('QUEUE_DASHBOARD_ENABLED', 'true');
  vi.stubEnv('QUEUE_DASHBOARD_PORT', '0');
  vi.stubEnv('QUEUE_DASHBOARD_IP_ALLOWLIST', allow);
};
const base = (app: INestApplication) => `http://127.0.0.1:${app.get(QueueDashboardServer).address().port}/queues`;

describe('QueueDashboardServer', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });

  it('allowlisted + authorized → 200; not authorized → the authorizer error as problem+json', async () => {
    env('127.0.0.1/32');
    app = await createTestApp([RedisModule, QueueModule.forRoot({ runWorkers: true }), AuthorizerModule]);
    expect((await fetch(`${base(app)}/api/queues`, { headers: { 'x-test-allow': 'yes' } })).status).toBe(200);
    const denied = await fetch(`${base(app)}/api/queues`);
    expect([denied.status, denied.headers.get('content-type')]).toEqual([403, expect.stringContaining('application/problem+json')]);
  });
  it('mutations are refused even for an authorized caller (read-only enforced by Bull Board)', async () => {
    env('127.0.0.1/32');
    app = await createTestApp([RedisModule, QueueModule.forRoot({ runWorkers: true }), AuthorizerModule]);
    const r = await fetch(`${base(app)}/api/queues/maintenance/pause`, { method: 'PUT', headers: { 'x-test-allow': 'yes' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  it('a caller outside the IP allowlist → 403 before the authorizer runs', async () => {
    env('10.0.0.0/8');
    app = await createTestApp([RedisModule, QueueModule.forRoot({ runWorkers: true }), AuthorizerModule]);
    expect((await fetch(`${base(app)}/api/queues`, { headers: { 'x-test-allow': 'yes' } })).status).toBe(403);
  });
  it('enabled without an authorizer → the worker refuses to start', async () => {
    env('127.0.0.1/32');
    await expect(createTestApp([RedisModule, QueueModule.forRoot({ runWorkers: true })])).rejects.toThrow(/QueueDashboardAuthorizer/);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project unit test/unit/core/queue/queue-dashboard-config.spec.ts; pnpm vitest run --project integration test/integration/core/queue/queue-dashboard.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`src/core/queue/dashboard/queue-dashboard.config.ts`:
```ts
import { isIP } from 'node:net';
import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../../config/index.js';

const MAX_PREFIX = { 4: 32, 6: 128 } as const;
const validEntry = (s: string): boolean => {
  const [ip = '', prefix] = s.split('/');
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return false;
  if (prefix === undefined) return true;
  const n = Number(prefix);
  return Number.isInteger(n) && n >= 0 && n <= MAX_PREFIX[family];
};

export const queueDashboardConfig = defineConfig(
  'queueDashboard',
  {
    enabled: 'QUEUE_DASHBOARD_ENABLED',
    host: 'QUEUE_DASHBOARD_HOST',
    port: 'QUEUE_DASHBOARD_PORT',
    basePath: 'QUEUE_DASHBOARD_BASE_PATH',
    ipAllowlist: 'QUEUE_DASHBOARD_IP_ALLOWLIST',
  },
  z.object({
    enabled: z.stringbool().default(false).describe('Serve the read-only Bull Board on the worker (enable on exactly one deployment)'),
    host: z.string().default('127.0.0.1').describe('Listen host of the dashboard (internal network only)'),
    port: z.coerce.number().int().min(0).default(3002).describe('Listen port of the dashboard. compose.yaml maps the worker on 3002; change both together'),
    basePath: z.string().startsWith('/').default('/queues').describe('Mount path of the dashboard'),
    ipAllowlist: z
      .string()
      .default('')
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(z.string().refine(validEntry, 'must be an IP or CIDR')))
      .describe('Client IPs/CIDRs allowed to reach the dashboard (required in production when enabled)'),
  }),
);

defineProductionRule('queue-dashboard-allowlist', (c) =>
  c.queueDashboard?.enabled === true && !(Array.isArray(c.queueDashboard.ipAllowlist) && c.queueDashboard.ipAllowlist.length > 0)
    ? 'QUEUE_DASHBOARD_IP_ALLOWLIST must not be empty when QUEUE_DASHBOARD_ENABLED=true in production'
    : undefined,
);
```
`src/core/queue/dashboard/queue-dashboard.authorizer.ts`:
```ts
import type { IncomingMessage } from 'node:http';
import type { ErrorCode } from '../../errors/index.js';

export type QueueDashboardDecision = { allowed: true } | { allowed: false; error: ErrorCode; headers?: Record<string, string> };

/**
 * Ai được xem dashboard (spec §5.12): core không biết identity nên chỉ định nghĩa cổng; identity cài đặt
 * (đa credential, API key bị từ chối, CSRF, platform admin). Chỉ gọi sau khi IP đã qua allowlist.
 */
export abstract class QueueDashboardAuthorizer {
  abstract authorize(req: IncomingMessage): Promise<QueueDashboardDecision>;
}
```
`src/core/queue/dashboard/queue-dashboard.server.ts`:
```ts
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Queue } from 'bullmq';
import express from 'express';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, isIP, type AddressInfo } from 'node:net';
import { type ConfigOf } from '../../config/index.js';
import { AppError, CoreErrors, errorsConfig } from '../../errors/index.js';
import { writeProblem } from '../../http/index.js';
import { REDIS_NAMESPACE, redisClientOptions, redisConfig } from '../../redis/index.js';
import { queueRegistry } from '../job-definition.js';
import { QueueDashboardAuthorizer } from './queue-dashboard.authorizer.js';
import { queueDashboardConfig } from './queue-dashboard.config.js';

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

function buildAllowlist(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const e of entries) {
    const [ip = '', prefix] = e.split('/');
    const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(ip, type);
    else list.addSubnet(ip, Number(prefix), type);
  }
  return list;
}

/**
 * Bull Board read-only trong worker (D9): `express()` riêng trên cổng nội bộ (`@bull-board/nestjs` chỉ mount
 * vào HTTP của chính app, research 5). `readOnlyMode` được Bull Board enforce ở server. Payload job chỉ có id
 * (không PII); failed reason chỉ chứa lỗi đã chuẩn hoá (spec §5.14).
 */
@Injectable()
export class QueueDashboardServer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(QueueDashboardServer.name);
  private server: Server | undefined;
  private queues: Queue[] = [];

  constructor(
    @Inject(queueDashboardConfig.KEY) private readonly cfg: ConfigOf<typeof queueDashboardConfig>,
    @Inject(redisConfig.KEY) private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
    @Inject(errorsConfig.KEY) private readonly errors: ConfigOf<typeof errorsConfig>,
    @Optional() private readonly authorizer?: QueueDashboardAuthorizer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.enabled) return;
    const authorizer = this.authorizer;
    if (!authorizer) throw new Error('QUEUE_DASHBOARD_ENABLED=true requires a QueueDashboardAuthorizer provider (the identity module provides one)');
    const allow = buildAllowlist(this.cfg.ipAllowlist);
    try {
      this.queues = queueRegistry().map((q) => new Queue(q.name, { connection: { url: this.redis.url, ...redisClientOptions(this.redis, false) }, prefix: this.namespace }));
      const adapter = new ExpressAdapter();
      adapter.setBasePath(this.cfg.basePath);
      createBullBoard({ queues: this.queues.map((q) => new BullMQAdapter(q, { readOnlyMode: true })), serverAdapter: adapter });
      const app = express();
      app.disable('x-powered-by');
      app.use(this.cfg.basePath, (req: IncomingMessage, res: ServerResponse, next: () => void) => this.guard(req, res, next, allow, authorizer));
      app.use(this.cfg.basePath, adapter.getRouter());
      const server = createServer(app);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.cfg.port, this.cfg.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err: Error) => this.logger.error({ err }, 'queue dashboard server error'));
      this.server = server;
      this.logger.log(this.address(), 'queue dashboard listening');
    } catch (err) {
      await this.closeQueues();
      throw err;
    }
  }

  address(): AddressInfo {
    const a = this.server?.address();
    if (!a || typeof a === 'string') throw new Error('queue dashboard is not listening on a TCP port');
    return a;
  }

  private guard(req: IncomingMessage, res: ServerResponse, next: () => void, allow: BlockList, authorizer: QueueDashboardAuthorizer): void {
    const meta = { instance: (req.url ?? '').split('?')[0] ?? '', requestId: 'dashboard', typeBase: this.errors.problemTypeBase };
    const raw = req.socket.remoteAddress ?? '';
    const ip = IPV4_MAPPED.exec(raw)?.[1] ?? raw;
    if (!allow.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')) {
      this.logger.warn({ event: 'dashboard_ip_denied', ip }, 'queue dashboard: client IP not in allowlist');
      return writeProblem(res, new AppError(CoreErrors.FORBIDDEN), meta);
    }
    authorizer
      .authorize(req)
      .then((d) => (d.allowed ? next() : writeProblem(res, new AppError(d.error, d.headers ? { headers: d.headers } : {}), meta)))
      .catch((err: unknown) => {
        this.logger.error({ err }, 'queue dashboard authorization failed');
        writeProblem(res, new AppError(CoreErrors.INTERNAL_ERROR), meta);
      });
  }

  async beforeApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    await this.closeQueues();
  }

  private async closeQueues(): Promise<void> {
    const qs = this.queues.splice(0);
    await Promise.all(qs.map((q) => q.close()));
  }
}
```
(Import `@bull-board/api/bullMQAdapter` theo `exports` của package (research 5); nếu Node ESM không resolve được subpath không đuôi thì dùng đúng subpath mà `exports` khai báo — đã kiểm: `./bullMQAdapter`.)

`src/core/queue/queue.module.ts`: thêm `QueueDashboardServer` vào `providers` khi `opts.runWorkers` (worker), kèm chú thích "một deployment bật QUEUE_DASHBOARD_ENABLED".
`src/core/queue/index.ts`: thêm
```ts
export { QueueDashboardAuthorizer, type QueueDashboardDecision } from './dashboard/queue-dashboard.authorizer.js';
export { queueDashboardConfig } from './dashboard/queue-dashboard.config.js';
```
`src/core/config/all-configs.ts`: thêm `import '../queue/dashboard/queue-dashboard.config.js';`.
`src/core/config/dev-infra.config.ts`: thêm `queueDashboardPortHost: 'QUEUE_DASHBOARD_PORT_HOST'` (default 3002, "Host port for the worker queue dashboard (bound to 127.0.0.1)") và `composeSubnet: 'COMPOSE_SUBNET'` (default `172.30.99.0/24`, "Subnet of the compose network; the dashboard IP allowlist of the worker"). Run: `pnpm env:example`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project unit test/unit/core/queue && pnpm vitest run --project integration test/integration/core/queue && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS (`@bull-board/*` và `express` chỉ ở `core/queue/dashboard`, luật 13).

- [ ] **Step 5: Commit**

```bash
git add src/core/queue src/core/config .env.example .env.infra.example test/unit/core/queue/queue-dashboard-config.spec.ts test/integration/core/queue/queue-dashboard.spec.ts
git commit -m "feat(core/queue): read-only bull board on an internal worker port behind an IP allowlist and an authorizer port"
```

---

### Task 45: `PlatformAdminAuthorizer` của identity cho Bull Board

**Files:**
- Create: `src/modules/identity/infra/dashboard/platform-admin.authorizer.ts`, `src/modules/identity/infra/dashboard/dashboard-authorizer.module.ts`
- Modify: `src/modules/identity/identity.module.ts` (`forWorker` import `DashboardAuthorizerModule`)
- Test: `test/e2e/identity/queue-dashboard-access.e2e.spec.ts`

**Interfaces:**
- Consumes: `QueueDashboardAuthorizer`, `QueueDashboardDecision`, `QueueDashboardServer` (Task 44); `AuthProvider` (Task 35/41); `detectCredentials`, `csrfAllows`, `isCookieCredential` (Task 30); `IdentityErrors` (Task 29).
- Produces: `PlatformAdminAuthorizer` (dùng `toWebHeaders` của Task 36) (đa credential → 400; không credential → 401; API key → 403; CSRF cho method không an toàn; `isPlatformAdmin` → cho qua, không → 403; `UNAVAILABLE` → 503 + `Retry-After`); `DashboardAuthorizerModule` (`@Global`, cung cấp `QueueDashboardAuthorizer`).

- [ ] **Step 1: Viết test fail**

`test/e2e/identity/queue-dashboard-access.e2e.spec.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../src/core/queue/dashboard/queue-dashboard.server.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { IdentityModule } from '../../../src/modules/identity/index.js';
import { BETTER_AUTH, type AuthInstance } from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
describe('Bull Board access (spec §5.12)', () => {
  let app: INestApplication; let auth: AuthInstance; let url = '';
  const session = async (role?: string) => {
    const email = `q-${v7()}@example.test`;
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Q' } });
    await ownerQuery(`UPDATE auth."user" SET email_verified = true, role = coalesce($2, role) WHERE email = $1`, [email, role ?? null]);
    const r = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
    return { cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), bearer: r.headers.get('set-auth-token') ?? '' };
  };
  const get = (headers: Record<string, string>) => fetch(`${url}/api/queues`, { headers });
  beforeAll(async () => {
    for (const [k, v] of Object.entries({ APP_ROLE: 'worker', WORKER_QUEUES: 'events,notifications', QUEUE_DASHBOARD_ENABLED: 'true', QUEUE_DASHBOARD_PORT: '0', QUEUE_DASHBOARD_IP_ALLOWLIST: '127.0.0.1/32', AUTH_COOKIE_PREFIX: 'svc' })) vi.stubEnv(k, v);
    app = await createTestApp([DatabaseModule.forRoot({ relay: true }), RedisModule, QueueModule.forRoot({ runWorkers: true }), OutboxModule.forRoot({ relay: true }), EventsModule.forRoot({ worker: true }), NotificationsModule.forWorker(), IdentityModule.forWorker()]);
    auth = app.get(BETTER_AUTH);
    url = `http://127.0.0.1:${app.get(QueueDashboardServer).address().port}/queues`;
  });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('no credential → 401; ordinary user → 403; platform admin (cookie) → 200', async () => {
    expect((await get({})).status).toBe(401);
    expect((await get({ cookie: (await session()).cookie })).status).toBe(403);
    expect((await get({ cookie: (await session('admin')).cookie })).status).toBe(200);
  });
  it('an API key, even of an admin, → 403', async () => {
    const admin = await session('admin');
    const key = await auth.api.createApiKey({ body: { name: 'k' }, headers: new Headers({ cookie: admin.cookie }) });
    expect((await get({ 'x-api-key': key.key })).status).toBe(403);
  });
  it('duplicate credentials → 400; a cross-site mutation with the admin cookie → 403 origin_not_allowed', async () => {
    const admin = await session('admin');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${url}/api/queues`);
      const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: ['cookie', admin.cookie, 'authorization', `Bearer ${admin.bearer}`] });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(400);
    const m = await fetch(`${url}/api/queues/notifications/pause`, { method: 'PUT', headers: { cookie: admin.cookie, origin: 'https://evil.test' } });
    expect(m.status).toBe(403);
  });
  it('a pending 2FA sign-in (two_factor cookie only) cannot open the dashboard', async () => {
    expect((await get({ cookie: 'svc.two_factor=forged' })).status).toBe(401);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/e2e/identity/queue-dashboard-access.e2e.spec.ts`
Expected: FAIL — worker không khởi động (chưa có authorizer).

- [ ] **Step 3: Cài đặt**

`src/modules/identity/infra/dashboard/platform-admin.authorizer.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { CoreErrors, type ErrorCode } from '../../../../core/errors/index.js';
import { httpConfig } from '../../../../core/http/index.js';
import { QueueDashboardAuthorizer, type QueueDashboardDecision } from '../../../../core/queue/index.js';
import { IdentityErrors } from '../../errors.js';
import { detectCredentials, detectionConfigOf, type DetectionConfig } from '../../http/credential-detector.js';
import { UNSAFE_METHODS, csrfAllows, isCookieCredential, trustedOriginList } from '../../http/origin-check.js';
import { toWebHeaders } from '../../http/web-headers.js';
import { identityConfig, identityGuardConfig, type IdentityConfig, type IdentityGuardConfig } from '../../identity.config.js';
import { AuthProvider } from '../../ports/auth-provider.js';

const deny = (error: ErrorCode, headers?: Record<string, string>): QueueDashboardDecision => ({ allowed: false, error, ...(headers ? { headers } : {}) });
const single = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Chỉ platform admin đăng nhập bằng session (cookie/bearer hoặc token IdP ở `external`); API key luôn bị từ chối. */
@Injectable()
export class PlatformAdminAuthorizer extends QueueDashboardAuthorizer {
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;

  constructor(
    private readonly provider: AuthProvider,
    @Inject(identityConfig.KEY) identity: IdentityConfig,
    @Inject(identityGuardConfig.KEY) private readonly guard: IdentityGuardConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
  ) {
    super();
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(trustedOriginList(http.corsOrigins, identity.baseUrl));
  }

  async authorize(req: IncomingMessage): Promise<QueueDashboardDecision> {
    const d = detectCredentials(req.rawHeaders, this.detection);
    if (!d.ok) return deny(IdentityErrors.AMBIGUOUS_CREDENTIALS);
    const credential = d.credentials[0];
    if (!credential) return deny(CoreErrors.UNAUTHENTICATED);
    if (credential.kind === 'API_KEY') return deny(CoreErrors.FORBIDDEN);
    const method = (req.method ?? 'GET').toUpperCase();
    if (UNSAFE_METHODS.has(method) && isCookieCredential(credential.kind) && !csrfAllows({ method, origin: single(req, 'origin'), secFetchSite: single(req, 'sec-fetch-site') }, this.trusted))
      return deny(IdentityErrors.ORIGIN_NOT_ALLOWED);
    const r = await this.provider.authenticate({ headers: toWebHeaders(req), credential });
    switch (r.kind) {
      case 'AUTHENTICATED':
        return r.isPlatformAdmin ? { allowed: true } : deny(CoreErrors.FORBIDDEN);
      case 'ANONYMOUS':
      case 'REJECTED':
        return deny(CoreErrors.UNAUTHENTICATED);
      case 'UNAVAILABLE':
        return deny(CoreErrors.SERVICE_UNAVAILABLE, { 'Retry-After': String(this.guard.unavailableRetryAfterSec) });
      default: {
        const unknown: never = r;
        throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
      }
    }
  }
}
```
`src/modules/identity/infra/dashboard/dashboard-authorizer.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { QueueDashboardAuthorizer } from '../../../../core/queue/index.js';
import { PlatformAdminAuthorizer } from './platform-admin.authorizer.js';

@Global()
@Module({
  providers: [PlatformAdminAuthorizer, { provide: QueueDashboardAuthorizer, useExisting: PlatformAdminAuthorizer }],
  exports: [QueueDashboardAuthorizer],
})
export class DashboardAuthorizerModule {}
```
`identity.module.ts` → `forWorker().imports` thêm `DashboardAuthorizerModule`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `pnpm vitest run --project integration test/e2e/identity/queue-dashboard-access.e2e.spec.ts test/integration/core/queue && pnpm typecheck && pnpm lint && pnpm arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity test/e2e/identity/queue-dashboard-access.e2e.spec.ts
git commit -m "feat(identity): platform-admin authorizer for the queue dashboard (sessions only, csrf, no api keys)"
```

---

### Task 46: Kiểm chứng prod-like #2 — Bull Board trên image production

**Files:**
- Modify: `compose.yaml` (dashboard của worker, subnet cố định), `test/smoke/compose.smoke.yaml` (bỏ khối `networks` — đã chuyển sang compose.yaml), `test/smoke/smoke-env.ts` + `test/smoke/smoke-preflight.ts` (`COMPOSE_SUBNET` thay `SMOKE_SUBNET`), `test/smoke/smoke-app-env.ts`
- Create: `test/smoke/dashboard.smoke.spec.ts`

**Interfaces:**
- Consumes: bộ smoke (Task 17, 43), Task 44, 45.
- Produces: compose dev + smoke bật dashboard ở worker (`127.0.0.1:${QUEUE_DASHBOARD_PORT_HOST}:3002`, allowlist `${COMPOSE_SUBNET}`); smoke kiểm: không credential `401`, user thường `403`, admin `200`, mutate bị từ chối, log không lỗi.

- [ ] **Step 1: Compose**

`compose.yaml`:
- thêm ở cuối file:
```yaml
networks:
  default:
    ipam:
      # Subnet cố định: allowlist IP của Bull Board trong worker (spec §9).
      config: [{ subnet: '${COMPOSE_SUBNET}' }]
```
- `worker.environment` thêm:
```yaml
      QUEUE_DASHBOARD_ENABLED: 'true'
      QUEUE_DASHBOARD_HOST: 0.0.0.0
      QUEUE_DASHBOARD_PORT: '3002'
      QUEUE_DASHBOARD_IP_ALLOWLIST: ${COMPOSE_SUBNET}
```
- `worker.ports: ['127.0.0.1:${QUEUE_DASHBOARD_PORT_HOST}:3002']`.

`test/smoke/compose.smoke.yaml`: xoá khối `networks:` ở cuối. `test/smoke/smoke-env.ts`: đổi `SMOKE_SUBNET: smokeSubnet()` trong `infra` thành `COMPOSE_SUBNET: smokeSubnet()` (ghi đè giá trị dev `172.30.99.0/24` lấy từ `.env.infra.example`; biến môi trường `SMOKE_SUBNET` vẫn là cách đổi subnet của smoke). `test/smoke/smoke-preflight.ts`: `const subnet = env.infra.COMPOSE_SUBNET ?? '';`. Dev trùng mạng thì đặt `COMPOSE_SUBNET` trong `.env.infra` (review M9). Chạy lại `pnpm vitest run --project unit test/unit/smoke`.

Run: `docker compose --env-file docker/images.env --env-file .env.infra --env-file .env config -q`
Expected: không lỗi.

- [ ] **Step 2: Viết smoke test**

`test/smoke/dashboard.smoke.spec.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { Mailpit } from '../support/mailpit.js';
import { SMOKE_BASE_URL } from './smoke-app-env.js';
import { assertCleanLogs, compose, logsSince, psql } from './smoke-support.js';

const PASSWORD = 'smoke dashboard passphrase';
/**
 * Gọi dashboard TỪ BÊN TRONG mạng compose (container api, có node): IP nguồn chắc chắn thuộc COMPOSE_SUBNET
 * trên mọi nền tảng (port-forward của Docker Desktop có thể đổi IP nguồn). In ra `status`.
 */
function dashboardStatus(path: string, headers: Record<string, string>, method = 'GET'): number {
  const script = `fetch('http://worker:3002/queues${path}',{method:${JSON.stringify(method)},headers:${JSON.stringify(headers)}}).then(r=>console.log(r.status)).catch(e=>{console.error(e.message);process.exit(1)})`;
  return Number(compose(['exec', '-T', 'api', '/nodejs/bin/node', '-e', script]).trim());
}

describe('prod-like smoke: Bull Board', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const since = new Date().toISOString();
  const mail = new Mailpit(mailpitApiUrl);
  const signedIn = async (role?: 'admin') => {
    const email = `dash-${randomUUID()}@example.test`;
    const post = (path: string, body: unknown) => fetch(`${apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SMOKE_BASE_URL }, body: JSON.stringify(body) });
    await post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'Dash' });
    const msg = await mail.waitFor(email, { subject: /Verify your email/, timeoutMs: 60_000 });
    const link = new URL(/https:\/\/localhost\/api\/auth\/verify-email\?[^\s"<>]+/.exec(msg.Text)![0]);
    await fetch(`${apiUrl}${link.pathname}${link.search}`, { redirect: 'manual' });
    if (role) psql(`UPDATE auth."user" SET role = 'admin' WHERE email = '${email.replaceAll("'", "''")}'`);
    const res = await post('/api/auth/sign-in/email', { email, password: PASSWORD });
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };

  it('no credential → 401; ordinary user → 403; platform admin → 200', async () => {
    expect(dashboardStatus('/api/queues', {})).toBe(401);
    expect(dashboardStatus('/api/queues', { cookie: await signedIn() })).toBe(403);
    expect(dashboardStatus('/api/queues', { cookie: await signedIn('admin') })).toBe(200);
  });
  it('the dashboard is read-only even for an admin', async () => {
    const admin = await signedIn('admin');
    expect(dashboardStatus('/api/queues/notifications/pause', { cookie: admin, origin: SMOKE_BASE_URL }, 'PUT')).toBeGreaterThanOrEqual(400);
  });
  it('logs have no error lines', () => {
    assertCleanLogs(logsSince(since), [PASSWORD]);
  });
});
```
`test/smoke/smoke-app-env.ts`: không cần thêm khoá (dashboard bật ở `compose.yaml`, allowlist lấy `COMPOSE_SUBNET`; luật production "allowlist không rỗng" được thoả).

- [ ] **Step 3: Chạy smoke**

Run: `pnpm test:smoke`
Expected: ba file smoke PASS; teardown `down -v` sạch.

- [ ] **Step 4: Commit**

```bash
git add compose.yaml test/smoke
git commit -m "test(smoke): prod-like bull board access (admin only, read-only) on the production image"
```

---

## Phần G — Follow-up SP1, CI, tài liệu, kiểm chứng cuối

### Task 47: Follow-up chuẩn hoá của SP1 (spec §10)

**Files:**
- Create: `src/migrations/core/Migration<timestamp>_scheduled_tasks_job_name_check.ts` (bằng CLI), `test/integration/core/database/sp1-normalization-followups.spec.ts`
- Modify: `docs/adr/0006-queue-outbox.md` (mục "Chuẩn hoá: follow-up SP1")

**Interfaces:**
- Consumes: bảng SP1 `scheduled_tasks`, `outbox_events`, `processed_events`; `NAME_PATTERN` của `defineJob` (`^[a-z][a-z0-9._-]*$`).
- Produces: `CHECK` định dạng `scheduled_tasks.job_name` (thêm và validate trong transaction của migrator — khoá ngắn vì bảng nhỏ, xem chú thích migration), `down` bỏ constraint; quyết định có lý do cho hai follow-up còn lại (ADR 0006).

Quyết định (bảng chuẩn hoá của spec §10):

| Bảng | Follow-up | Quyết định | Lý do |
|---|---|---|---|
| `scheduled_tasks` | `job_name` là chuỗi tự do | **Sửa:** `CHECK (job_name ~ '^[a-z][a-z0-9._-]*$')` (đúng `NAME_PATTERN` của `defineJob`) | Enum/định danh không được là chuỗi tự do; tập job đổi theo code của nhiều module nên chỉ ép định dạng ở DB, tập hợp ở app (`findJob` lúc reconcile) |
| `scheduled_tasks` | `timezone` chỉ validate ở app | **Chấp nhận, ghi lý do** | Tập IANA đổi theo bản tzdata; liệt kê trong `CHECK` thì mỗi lần nâng tzdata phải viết migration; `normalizeTimezone` validate lúc ghi |
| `outbox_events` | `type` → `aggregate_type`? | **Chấp nhận: không có phụ thuộc hàm** | Quy ước `context.aggregate.verb` là quy ước đặt tên, không ràng buộc: `notifications.delivery.failed` có aggregate `email_delivery` (Task 20). Không có FD nên không vi phạm 3NF; dòng outbox là snapshot bất biến |
| `processed_events` | `processed_at` = `created_at` | **Chấp nhận tới lần sửa bảng kế tiếp** | Bỏ cột trên bảng đang chạy cần expand → contract qua hai release (code dọn inbox đang dùng `processed_at` + index của nó); giá trị thấp, không có dị thường cập nhật (bảng chỉ INSERT/DELETE) |

- [ ] **Step 1: Viết test fail**

`test/integration/core/database/sp1-normalization-followups.spec.ts`:
```ts
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';

describe('scheduled_tasks.job_name format CHECK (SP1 follow-up, spec §10)', () => {
  let app: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    app = new pg.Client({ host: p.host, port: p.port, database: p.database, ...p.app });
    await app.connect();
  });
  afterAll(async () => app?.end());

  const insert = async (jobName: string) => {
    const org = v7();
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      await app.query(`INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'k', $2, '0 * * * *', 'UTC', '{}', true)`, [org, jobName]);
    } finally {
      await app.query('ROLLBACK');
    }
  };
  it('accepts a registered-style job name', async () => { await expect(insert('billing.invoice.remind')).resolves.toBeUndefined(); });
  it.each(['Billing.Remind', 'job with space', 'x;drop', ''])('rejects %j (23514)', async (name) => {
    await expect(insert(name)).rejects.toMatchObject({ code: '23514' });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `pnpm vitest run --project integration test/integration/core/database/sp1-normalization-followups.spec.ts`
Expected: FAIL — chuỗi sai định dạng vẫn được ghi.

- [ ] **Step 3: Migration bằng CLI**

Run: `pnpm exec mikro-orm migration:create --blank --path src/migrations/core --name scheduled_tasks_job_name_check`
Sửa file sinh ra (giữ tên lớp CLI sinh):
```ts
import { Migration } from '@mikro-orm/migrations';

/**
 * Follow-up chuẩn hoá SP1 (spec SP2 §10): `job_name` là định danh, không phải chuỗi tự do. Ép ĐỊNH DẠNG (đúng
 * NAME_PATTERN của defineJob); tập job hợp lệ do code quyết định lúc reconcile.
 *
 * Chuẩn hoá (Global Constraints — bảng phân tích của bảng bị sửa):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm / ghi chú | Dạng |
 * |---|---|---|---|
 * | scheduled_tasks | {id}, {org_id, key} | mọi cột phụ thuộc toàn bộ khoá; job_name là định danh (CHECK định dạng ở đây), timezone validate ở app (tập IANA đổi theo tzdata — ADR 0006) | BCNF |
 *
 * Khoá (review M7): migrator của SP1 chạy `transactional: true, allOrNothing: true` (src/core/database/migrator.ts),
 * nên `NOT VALID` + `VALIDATE` trong cùng transaction KHÔNG giảm khoá: ACCESS EXCLUSIVE giữ tới commit. Dùng một
 * `ADD CONSTRAINT … CHECK` (quét bảng dưới ACCESS EXCLUSIVE): `scheduled_tasks` là bảng cấu hình, mỗi lịch một dòng
 * (hàng trăm dòng) nên khoá ở mức mili giây. Bảng lớn thì phải tách: migration chỉ `ADD … NOT VALID`, còn
 * `VALIDATE CONSTRAINT` chạy ngoài migrator (runbook) vì `allOrNothing` gộp mọi migration đang chờ vào một transaction.
 */
export class Migration20260927000200_scheduled_tasks_job_name_check extends Migration {
  override name = 'Migration20260927000200_scheduled_tasks_job_name_check';

  override up(): void | Promise<void> {
    this.addSql(`ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_job_name_ck CHECK (job_name ~ '^[a-z][a-z0-9._-]*$');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_job_name_ck;`);
  }
}
```
Thêm vào `docs/adr/0006-queue-outbox.md` mục `### Chuẩn hoá: follow-up SP1 (SP2 Task 47)` với đúng bảng quyết định ở đầu task.

- [ ] **Step 4: Chạy test, xác nhận xanh (kể cả up → down → up)**

Run: `pnpm vitest run --project integration test/integration/core/database && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/migrations/core test/integration/core/database/sp1-normalization-followups.spec.ts docs/adr/0006-queue-outbox.md
git commit -m "feat(db): enforce scheduled_tasks.job_name format; record decisions on the other sp1 normalization follow-ups"
```

---

### Task 48: CI — kiểm lệch schema Better Auth, `.env.example` cập nhật, smoke nightly

**Files:**
- Create: `test/integration/identity/auth-schema-drift.spec.ts`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`

**Interfaces:**
- Consumes: `pnpm auth:generate` (Task 26), kết quả S3c; `pnpm test:smoke` (Task 17).
- Produces: test integration fail khi schema DB lệch với `auth generate` (chạy trong job `test:int` đã có `pnpm build`); job CI kiểm `.env.example`/`.env.infra.example` khớp config; job nightly `smoke`.

- [ ] **Step 1: Viết test**

`test/integration/identity/auth-schema-drift.spec.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseTestEnv } from '../../support/env.js';

const CLI_CONFIG = 'dist/modules/identity/infra/better-auth/auth.cli-config.js';

/** CI (spec §9): sau migrate, `auth generate` không được còn SQL cần áp. Cần `pnpm build` trước (job test:int đã build). */
describe('Better Auth schema drift', () => {
  it('auth generate finds nothing to apply on the migrated database', () => {
    expect(existsSync(CLI_CONFIG), 'run pnpm build first').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'auth-drift-'));
    const out = join(dir, 'pending.sql');
    try {
      execFileSync('pnpm', ['exec', 'auth', 'generate', '--config', CLI_CONFIG, '--output', out, '--yes'], { env: { ...process.env, ...baseTestEnv() }, stdio: 'pipe', shell: process.platform === 'win32' });
      const sql = existsSync(out) ? readFileSync(out, 'utf8').replace(/--.*$/gm, '').trim() : '';
      expect(sql).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```
(Điều kiện "không còn SQL" viết theo đúng hành vi đã ghi ở S3c: nếu CLI báo "đã khớp" bằng exit code/thông báo thay vì không tạo file thì kiểm đúng tín hiệu đó.)

- [ ] **Step 2: Workflow**

`.github/workflows/ci.yml`, thêm job:
```yaml
  env-example:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile && pnpm env:example
      - name: committed env examples match the config schemas
        run: git diff --exit-code .env.example .env.infra.example
```
`.github/workflows/nightly.yml`, thêm job:
```yaml
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # Build image production thật, compose với TLS cục bộ, NODE_ENV=production, down -v ở teardown.
      - run: pnpm test:smoke
```
(Smoke không chạy ở mỗi PR: build image + compose mất vài phút; nightly và `workflow_dispatch` đủ. Job `image` của CI vẫn build + Trivy mỗi PR; `osv-scanner` quét lockfile có package mới; `oasdiff` thấy `/v1/me`.)

- [ ] **Step 3: Chạy**

Run:
```bash
pnpm build && pnpm vitest run --project integration test/integration/identity/auth-schema-drift.spec.ts
pnpm env:example && git diff --exit-code .env.example .env.infra.example
```
Expected: PASS; không có diff. Hai job workflow mới chỉ kiểm được khi chạy trên GitHub (sau khi Sếp cho push): báo là chưa kiểm chứng ở bước này.

- [ ] **Step 4: Commit**

```bash
git add test/integration/identity/auth-schema-drift.spec.ts .github/workflows
git commit -m "ci: fail on better auth schema drift and stale env examples; nightly prod-like smoke"
```

---

### Task 49: ADR 0010, cập nhật ADR 0005/0006/0007/0009/0016, sửa spec cha (spec §11.2), README

**Files:**
- Modify: `docs/adr/0010-better-auth-and-auth-modes.md`, `docs/adr/0005-multi-tenant-rls.md`, `docs/adr/0006-queue-outbox.md`, `docs/adr/0007-http-conventions.md`, `docs/adr/0009-id-strategy.md`, `docs/adr/0016-outbound-http-ssrf.md`, `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, `docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md` (ghi chú lệch đã duyệt), `README.md`

**Interfaces:**
- Consumes: kết quả spike (Task 1–7), mọi task trước.
- Produces: tài liệu đầy đủ của SP2 (spec §11.1, §11.2).

- [ ] **Step 1: ADR 0010**

Viết lại phần đầu `docs/adr/0010-better-auth-and-auth-modes.md` (giữ nguyên mục "Kết quả spike"):
```markdown
# 0010 — Better Auth và các chế độ xác thực

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-27

## Bối cảnh

Boilerplate cần đăng ký/đăng nhập/xác thực email/quên mật khẩu/2FA cho web (cookie), mobile (bearer),
máy (API key) và phát JWT cho dịch vụ khác; một số dự án dùng IdP ngoài (Keycloak, Entra ID) qua gateway.

## Quyết định

- **Thư viện:** Better Auth 1.7.6, sau port `AuthProvider` (thư viện chỉ trong `identity/infra/better-auth/**`).
  **Tự mount** `auth.handler(Request)` bằng `AuthMountMiddleware` (Nest middleware cho `${AUTH_BASE_PATH}/{*path}`)
  thay cho `@thallesp/nestjs-better-auth` mà spec §5.5 chọn ban đầu — đây là nhánh fallback spec đã duyệt. Lý do
  (đọc mã nguồn, review trước thực thi B2): thallesp 2.8.0 gọi handler bằng `next()` không await (`index.mjs:892-896`)
  nên lỗi ném ở `onRequest` của better-call (storage rate limit, `checkSchema` — ngoài try/catch, `router.mjs:100-102`)
  thành unhandled rejection làm sập api; 429 của rate limit IP trả thẳng `Response` không qua hook nên không map
  được. Middleware của mình: đọc body bằng parser giới hạn theo stream (413 sớm, đóng socket), `await` handler trong
  try/catch (reject → 503 fail-closed), map mọi `Response` ≥ 400 không phải problem+json (giữ `Set-Cookie`,
  `X-Retry-After` → `Retry-After`), ≥ 500 thì thăm dò pool auth để chọn 503/500; đăng xuất do mình xử lý, không
  bao giờ rơi về handler gốc.
- **Credential theo client:** web = cookie session (`HttpOnly`, `Secure` ngoài dev/test localhost, `SameSite`
  từ config, host-only trừ khi mọi subdomain tin cậy); mobile = `Authorization: Bearer <session token>`;
  máy = header API key (principal là user sở hữu, id của key trong context); dịch vụ khác = JWT của plugin `jwt`
  verify qua JWKS công khai (API không nhận JWT này).
- **Đa nguồn:** request mang hơn một credential, header/cookie trùng, hoặc `Authorization` sai dạng →
  `400 ambiguous_credentials`, kiểm trên `rawHeaders` trước mọi chuẩn hoá. Ngoại lệ duy nhất: `POST /sign-out`
  nhận cookie + bearer và thu hồi cả hai.
- **CSRF:** mọi request thay đổi trạng thái xác thực bằng cookie (route Nest, `/api/auth/*`, Bull Board, cookie
  token ở `external`) phải có `Origin` khớp chính xác danh sách tin cậy, hoặc `Sec-Fetch-Site: same-origin`.
  Kiểm của mình chạy trước handler; kiểm của Better Auth vẫn bật phía sau.
- **`AUTH_MODE`:** `local` (Better Auth), `hybrid` (+ một OIDC qua `genericOAuth`), `external` (không Better Auth;
  token IdP verify bằng `jose` qua `HttpClient` chống SSRF; chỉ nhận token user theo claim cấu hình; admin theo
  claim khớp chính xác).
- **D1–D10:** không cache session (Postgres là nguồn duy nhất; Redis sập không ảnh hưởng auth); rate limit Better
  Auth `storage: 'database'` + khoá theo tài khoản `RateLimiterPostgres` atomic, cửa sổ đánh số, refund đúng khoá;
  id `uuidv7()` do DB sinh; schema `auth` + role `auth_user`; token OAuth mã hoá bằng `FieldCipher` qua DBAdapter
  bọc; body của `/api/auth/*` giới hạn ở tầng stream; impersonation tắt; `auth generate` sinh schema; Bull Board
  trong worker; event `identity.user.registered` với id v5 + marker bền trên dòng user.
- **Liên kết tài khoản fail-closed:** chỉ provider trong `AUTH_TRUSTED_PROVIDERS` + `email_verified === true`
  + user local đã xác thực.

## Giới hạn đã biết

- Token session lưu dạng gốc trong `auth.session` (chỉ `auth_user` đọc được, TLS, backup mã hoá, TTL).
- JWT đã phát còn hiệu lực tới `exp` (tối đa `AUTH_JWT_EXPIRES_IN_SEC`); token IdP ở `external` tương tự.
- Lệch đồng hồ giữa pod dịch ranh giới cửa sổ lockout tương ứng (NTP, dưới 1 giây).
- Email gửi at-least-once (ADR 0006).
- Xoay `BETTER_AUTH_SECRET` làm mất session hiện có (runbook; không downtime ở SP7).

## Hệ quả

- `AuthGuard` mặc định chặn; route công khai phải gắn `@PublicRoute()`.
- Principal có trước guard rate limit (middleware), nên throttler/idempotency/log thấy principal thật.
```

- [ ] **Step 2: Cập nhật các ADR khác**

Thêm một mục "Cập nhật SP2 (2026-09-27)" vào mỗi ADR, nội dung:
- **0005:** schema `auth` + role `auth_user` (không quyền trên `public`), siết `PUBLIC` (không `USAGE` trên `public`, không `CONNECT`/`TEMPORARY` trên database), test ma trận quyền; bảng `auth.*` ngoài RLS vì không có `org_id` và chỉ `auth_user` truy cập.
- **0006:** state machine `email_deliveries` (PENDING → SENDING → SENT/FAILED) với lease + fencing theo `lease_owner`, generation bền cho đối soát (`<public_id>-g<n>`), at-least-once và `Message-ID` cố định; `OutboxWriter.append(ifAbsent)` + `EventPublisher.publish({ eventId }, { ifAbsent })` cho id xác định trước; marker bền `registered_event_emitted_at`; ràng buộc chuẩn hoá của `email_deliveries` (bảng §5.16c); mục follow-up SP1 (Task 47).
- **0007:** chủ sở hữu body parser (`bodyParser: false`; core đăng ký `jsonBodyParser` — `raw-body`, giới hạn theo stream, 413 + đóng socket không chờ hết body — và bỏ qua prefix mà module khác khai báo qua `HTTP_BODY_PARSER_SKIP_PREFIX`; identity khai báo `AUTH_BASE_PATH` và tự đọc body bằng cùng hàm sau khi kiểm đa credential/CSRF), `@PublicRoute()` + `AuthGuard` mặc định chặn (credential sai là 401 kể cả trên route public), map lỗi Better Auth sang problem+json (3xx và `Set-Cookie` giữ nguyên), CSRF cho request xác thực bằng cookie, `writeProblem` dùng chung.
- **0009:** `generateId: 'uuid'` + `DEFAULT uuidv7()` cho bảng `auth.*` (hoặc nhánh (B) nếu S3 chọn); event id `v5` cho `identity.user.registered` là ngoại lệ có tên của "event id là v7".
- **0016:** `toWebFetch(client, provider)` cho thư viện nhận fetch tuỳ biến (`jose`); ngoại lệ có tên: request ra ngoài của Better Auth (Google OAuth, discovery/token/userinfo của `genericOAuth`) dùng fetch của thư viện, URL chỉ từ config, production `https`.

- [ ] **Step 3: Sửa spec cha theo spec §11.2**

Trong `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`, áp từng dòng của bảng §11.2 (mỗi dòng một sửa đổi tại đúng mục, không viết lại mục khác):
1. §11 Better Auth: `@better-auth/cli generate` → `auth generate` (package `auth` 1.7.6).
2. §11 "Thu hồi": bỏ Redis secondary storage → "Session chỉ ở Postgres, `cookieCache` tắt; lý do R21; cache chỉ khi có số đo".
3. §11 rate limit đăng nhập + Phụ lục C mục 2: "Redis hoặc DB" → "`storage: 'database'` + lockout `RateLimiterPostgres` atomic".
4. §9 Redis sập: "Đăng nhập, 2FA fail-closed" → "Không phụ thuộc Redis; fail-closed khi storage Postgres lỗi".
5. §17 Job: `@bull-board/nestjs` → `@bull-board/api` + `@bull-board/express` 9.10.1, trong worker.
6. §17 Auth: thêm `@better-auth/api-key`, `@better-auth/kysely-adapter` trực tiếp; `sso` chỉ khi SAML; `express` trực tiếp; nhóm version cùng nhịp trừ `@better-auth/utils` (0.4.2).
7. §0.4 ID: "Better Auth sinh qua `generateId`" → "`generateId: 'uuid'` + `DEFAULT uuidv7()`".
8. §4.1 đoạn cuối: bảng Better Auth "trong allowlist RLS" → "schema `auth` riêng, chỉ `auth_user`; `PUBLIC` không có quyền trên `public`".
9. §4.1/§11 `FieldCipher`: AAD của `auth.account` = `auth.account:<cột>:-:<providerId>/<accountId>`; `email_deliveries` dùng `public_id` sinh ở app.
10. §11 `FieldCipher` "có job mã hoá lại": "Hoãn sang SP7 (runbook + job); SP2 chỉ dùng keyring nhiều `kid`".
11. §11 xoay khoá: JWKS thiết kế trong SP2 (`jwks.rotationInterval`/`gracePeriod`); API key: user tạo mới rồi xoá cũ, có hạn mặc định; secret webhook: SP6.
12. §11 `AUTH_MODE`/Principal: "`external` chỉ nhận token user theo claim cấu hình; API key cho principal là user sở hữu (id của key ở context); service principal và API key theo org: SP3".
13. §11 (thêm) SSRF/ADR 0016: ngoại lệ request ra ngoài của Better Auth; JWKS ở `external` qua `HttpClient` (`toWebFetch`).
14. §3.5: raw body → "`core/http` đọc body bằng `jsonBodyParser` (giới hạn theo stream, đặt `req.rawBody`) cho mọi route trừ prefix mà module khai báo qua `HTTP_BODY_PARSER_SKIP_PREFIX`; `/api/auth/*` do `AuthMountMiddleware` của identity đọc sau khi kiểm credential/CSRF; ở `external` không có prefix nào bị bỏ qua".
15. §3.1 `202`: ngoại lệ "`202` chung của đăng ký/đổi email không có body".
16. §11 "Session: cookie … + `trustedOrigins`": thêm "CSRF cho mọi request xác thực bằng cookie (route Nest, Bull Board, cookie token ở `external`) cùng danh sách origin".
17. §11 "cookie `HttpOnly; Secure; SameSite=Lax`": → "`HttpOnly` và `Path=/` cố định; `Secure` bắt buộc ngoài dev/test localhost; `SameSite` từ config (mặc định `Lax`); `Domain` chỉ khi mọi subdomain tin cậy (cờ xác nhận); cookie ở `external` do gateway/IdP phát".
18. §15 ADR 0010: "Better Auth + CASL" → "Better Auth + chế độ xác thực; CASL bổ sung ở SP3".

Trong spec SP2 `docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md`, thêm ghi chú "Lệch khi thực thi (xem ADR 0010)" ở đúng mục, không viết lại mục:
- §2/§4 S1/§5.1/§5.2/§5.5/§7/§11.2: đã sửa theo ruling R36 trước khi thực thi (tự mount thay thallesp); ở đây chỉ đối chiếu lại với code đã làm và bổ sung số đo spike.
- §5.5/§1.15: body `/api/auth/*` đọc bằng `jsonBodyParser` (raw-body) — 413 sớm và đóng socket, không `express.json`.
- §5.14: metric/span đã thêm (`identity_lockout_blocked_total`, `identity_auth_pool_connections`, span `identity.authenticate`/`identity.jwt.verify`/`identity.lockout.consume`/`identity.registered.reconcile`).
- §5.15: `SMTP_SEND_DEADLINE_MS` mặc định 8000 và luật "nhỏ hơn timeout resilience của provider `smtp`"; API key: plugin `rateLimit` tắt (throttler Nest theo principal thay thế), `keyExpiration.defaultExpiresIn` tính bằng giây.

- [ ] **Step 4: README**

Thêm vào `README.md` các mục (tiếng Việt, ngắn, có lệnh cụ thể):
- **Xác thực theo loại client** (bảng web/mobile/máy/dịch vụ khác của spec §1 tiêu chí 2), **quy tắc một credential** (`400 ambiguous_credentials`), **CSRF** (Origin/`Sec-Fetch-Site`).
- **`AUTH_MODE`** và biến bắt buộc từng mode; hợp đồng cookie ở `external` (gateway/IdP phát và xoá; API chỉ đọc).
- **Route `/api/auth/*`** chính: `sign-up/email`, `sign-in/email`, `sign-out`, `verify-email`, `request-password-reset`, `reset-password`, `change-password`, `change-email`, `two-factor/*`, `api-key/create|delete|list`, `token`, `jwks`, `admin/*` (không có `impersonate-user`); `GET /v1/me`.
- **Runbook:**
  - Admin đầu tiên: `pnpm auth:create-admin --email … --password … --role admin` (hoặc fallback SQL đã ghi ở S3d).
  - Xoay `BETTER_AUTH_SECRET`: đổi secret → mọi session/2FA secret/JWKS private key hiện có mất hiệu lực (có downtime session); không xoay song song ở SP2.
  - Xoay API key: tạo key mới → cập nhật client → `api-key/delete` key cũ.
  - Bull Board: chỉ một deployment bật `QUEUE_DASHBOARD_ENABLED`, truy cập qua mạng nội bộ/port-forward, allowlist IP.
  - User chưa có marker event: metric `identity_registered_unmarked_oldest_seconds` > nửa `min(OUTBOX_RETENTION_DAYS, INBOX_RETENTION_DAYS)` → kiểm pool auth, chạy tay job `identity.reconcile-registered`.
  - Email kẹt: `notifications_email_stuck_total` tăng → kiểm SMTP; cron đối soát tự enqueue lại; quá `NOTIFICATIONS_MAX_TOTAL_ATTEMPTS` thì `FAILED` + event.
  - Đăng xuất ở `external`: xoá cookie ở gateway/IdP (đúng tên, `Path`, `Domain`) và thu hồi refresh token ở IdP; access token còn hiệu lực tới `exp`.
- **Dev:** volume Postgres của SP1 phải tạo lại (`docker compose … down -v`) vì script init có role/schema mới; Mailpit UI ở `http://127.0.0.1:${MAILPIT_UI_PORT_HOST}`.
- **Công thức connection:** `api_pods × (DB_POOL_MAX + DB_AUTH_POOL_MAX) + worker_pods × (DB_POOL_MAX + DB_RELAY_POOL_MAX + DB_AUTH_POOL_MAX)` qua PgBouncer (relay luôn thẳng Postgres; pool auth theo S2b).
- **`pnpm test:smoke`:** smoke prod-like (image production, compose, TLS cục bộ, `NODE_ENV=production`) và danh sách nới lỏng cho localhost (Global Constraints của plan).

- [ ] **Step 5: Kiểm và commit**

Run: `pnpm lint` (prettier kiểm markdown) và đọc lại từng ADR một lượt.
```bash
git add docs README.md
git commit -m "docs: adr 0010 better auth and auth modes; sp2 updates to adr 0005/0006/0007/0009/0016; parent spec amendments; readme runbooks"
```

---

### Task 50: Kiểm chứng prod-like cuối (#3), số đo image/khởi động, toàn bộ pipeline

**Files:**
- Modify: `test/smoke/smoke.global-setup.ts` (in thời gian khởi động api + worker), `docs/adr/0013-build-toolchain.md` (bảng số đo SP2)

**Interfaces:**
- Consumes: mọi task.
- Produces: bằng chứng hoàn thành (spec §1 tiêu chí 17); số đo trong ADR 0013; dòng log `smoke_startup_ms` ở mỗi lần chạy smoke.

- [ ] **Step 1: Pipeline đầy đủ trên máy**

Run:
```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm arch
pnpm test
pnpm build && pnpm test:int
pnpm test:chaos
pnpm env:example && git diff --exit-code .env.example .env.infra.example
pnpm openapi:export && git diff --exit-code openapi.json
```
Expected: tất cả PASS, không diff. Ghi số test mỗi project.

- [ ] **Step 2: Smoke prod-like cuối và số đo**

`test/smoke/smoke.global-setup.ts`: bao lệnh `up … api worker` bằng đo thời gian (tham số đo của bộ test, không phải config của app):
```ts
    const startedAt = performance.now();
    docker([...composeArgs, '--profile', 'app', 'up', '-d', '--wait', '--no-deps', '--no-build', 'api', 'worker']);
    process.stdout.write(`${JSON.stringify({ event: 'smoke_startup_ms', ms: Math.round(performance.now() - startedAt) })}
`);
```
Run:
```bash
pnpm test:smoke 2>&1 | tee smoke.log
grep smoke_startup_ms smoke.log
docker image inspect nestjs-saas-boilerplate:local --format '{{.Size}}'
rm smoke.log
```
Expected: ba file smoke (`core`, `auth-email`, `dashboard`) PASS trên image production vừa build, teardown `down -v` sạch; có số `smoke_startup_ms`; image ≤ 200 MB (vượt thì dừng, báo Sếp kèm phương án `mjml-core` + `mjml-preset-core`).

- [ ] **Step 3: Ghi số đo**

Thêm vào `docs/adr/0013-build-toolchain.md`:
```markdown
### Số đo SP2 (2026-09-27)

| Chỉ số | SP1 | SP2 | Ghi chú |
|---|---|---|---|
| Kích thước image | <SP1 MB> | <n MB> | better-auth, mjml, nodemailer, bull-board |
| api + worker tới healthy (compose, TLS, production) | <SP1 ms> | <n ms> | |
| Số test (unit / integration / chaos / smoke) | <…> | <…> | |
```

- [ ] **Step 4: Commit**

```bash
git add test/smoke/smoke.global-setup.ts docs/adr/0013-build-toolchain.md
git commit -m "docs(adr): sp2 measurements (image size, startup, test counts)"
```

---

## Self-review

**1. Phủ spec** (mục → task):

| Spec | Task |
|---|---|
| §1 tiêu chí 1 (đăng ký → email → xác thực → đăng nhập, link một lần) | 38, 43 |
| §1.2 cookie là đường chính; bearer; API key; JWT | 33, 35, 38, 39, 43 |
| §1.3 principal trước throttler; đa credential | 30, 36, 37, 40 |
| §1.4 CSRF | 30, 36, 37, 40, 45, 43 |
| §1.5 `AUTH_MODE` 3 mode | 25, 37, 39 (hybrid), 41 (external) |
| §1.6 thu hồi theo mode/credential | 34, 36, 38, 39, 41 (giới hạn ghi ADR 49) |
| §1.7 Redis sập, auth vẫn chạy | 42 |
| §1.8 rate limit fail-closed, lockout atomic | 31, 34, 40, 42, 43 |
| §1.9 không lộ email | 33, 34 (đổi email chỉ tra khi có session; đăng ký song song), 38, 40 |
| §1.10 cô lập schema `auth` | 15, 26 |
| §1.11 mã hoá token OAuth, mã dự phòng, JWKS | 28, 39 |
| §1.12 event `identity.user.registered` | 12, 32 |
| §1.13 email state machine, fencing, at-least-once | 19, 20, 23, 24 |
| §1.14 Bull Board | 44, 45, 46 |
| §1.15 hồi quy HTTP SP1 | 9, 10, 36, 37 |
| §1.16 không PII | 14, 22, 23, 40, 43 |
| §1.17 pipeline, kiểm lệch schema, số đo | 48, 50 |
| §3 quy trình, chuẩn hoá | Global Constraints, 18, 26, 47 |
| §4 spike S1–S7 | 1–7 |
| §5.1 thay đổi core | 8–14, 26 (`tlsOptions`), 44 |
| §5.2 package | 1 |
| §5.3 schema/role/quyền/migration | 15, 26 |
| §5.4 instance, cookie, liên kết, plugin, IP, hook | 25, 33, 34 |
| §5.5 mount, body, map lỗi | 9, 10 (raw-body, 413 sớm), 29, 36 (tự mount, map mọi `Response`/reject) |
| §5.6 credential, CSRF, port, guard, đăng xuất, `/v1/me` | 30, 35, 36, 37, 41 |
| §5.7 lockout | 31, 34 |
| §5.8 chống lộ email | 7, 34, 40 |
| §5.9 `withAccountCipher` | 5, 28 |
| §5.10 event + cron | 32 |
| §5.11 notifications | 18–24 |
| §5.12 Bull Board | 44, 45 |
| §5.13 health | 11, 27, 41 |
| §5.14 PII, span, metric | 14 (token trong path), 22, 23, 24, 27 (gauge pool, `identitySpan`), 31, 32, 36, 37, 40 (test đọc metric/span), 41 |
| §5.15 config | 18, 25, 44 |
| §5.16 chuẩn hoá | 18, 26, 47 (inventory test ở 18/26) |
| §6 entrypoint | 10, 37 |
| §7 luật kiến trúc 10–16 | 16 |
| §8 testing | 8–45 (mỗi dòng của bảng §8 có test tương ứng) |
| §9 Docker/Compose/CI | 6, 15, 17 (env từ example + preflight), 43, 46, 48, 50 |
| §10 follow-up SP1 | 47 |
| §11.1 ADR/README | 1, 49, 50 |
| §11.2 sửa spec cha | 49 |

**2. Quét placeholder:** không có "TBD/TODO/implement later". Các chỗ `<…>` chỉ nằm trong mẫu ghi **kết quả đo/spike** (điền số thật khi chạy) và trong digest image lấy bằng lệnh — không phải code. Chỗ phụ thuộc kết quả spike có nhánh fallback viết cụ thể và task bị ảnh hưởng.

**3. Nhất quán kiểu/tên:** `AuthProvider.authenticate({ headers, credential })` và `AuthResult` (Task 35) dùng giống nhau ở 37, 41, 45; `DetectedCredential`/`detectCredentials`/`detectionConfigOf` (Task 30) dùng ở 36, 37, 45; `LoginLockout.guard/refund` + `LockoutBlockedError`/`LockoutUnavailableError` (Task 31) dùng ở 34, 35; `EmailNotifications.request` + `TEMPLATE_PARAMS` (Task 18/20) dùng ở 23, 33; `DeliveryRepository` (Task 20) dùng ở 23, 24; `writeProblem`/`problemBody`/`ProblemMeta` (Task 9) dùng ở 34, 36, 44; `QueueDashboardAuthorizer`/`QueueDashboardDecision` (Task 44) dùng ở 45; `RegisteredEventService.onUserCreated` (Task 32) dùng ở 35; `BETTER_AUTH`/`AuthInstance`/`createAuthInstance` (Task 34) dùng ở 35, 36, 45; `startIdentityApp`/`AuthClient` (Task 36/37) dùng ở 38–42; `identitySpan`/`IDENTITY_METER`/`installOtelCapture` (Task 27) dùng ở 31, 32, 36, 37, 40, 41; `toWebHeaders` (Task 36) dùng ở 37, 45; `SMTP_RESILIENCE_PROVIDER` (Task 18) dùng ở 22; `buildSmokeEnv`/`assertSmokePreflight`/`smokeSubnet` (Task 17) dùng ở 43, 46; `SignOutHandler.handle(res, credentials, ctx: { origin?, meta, retryAfterSec })` một chữ ký ở Interfaces và code (Task 36); `AuthRequestState` chỉ còn tickets + trạng thái 2FA (không `recordError`/`lastError`). `grep` không còn `HTTP_BODY_PARSER_DELEGATED`, `authRouteBodyParser`, `recordError`, `lastError`, `SMTP_PROVIDER`, và `@thallesp` chỉ còn trong đoạn giải thích quyết định.

**4. Review Focus:** năm điều kiện ở đầu plan đều có test trong task sở hữu: Task 31 + 34 + 38 (email khác hoa thường), Task 30 + 37 (credential rỗng), Task 40 (`callbackURL` không tin cậy), Task 21 (escape/CRLF trong email), Task 23 (template/locale/params hỏng → `FAILED` vĩnh viễn).

**5. Review trước thực thi (`.superpowers/sp2-plan-review.md`) → task sửa:**

| Mục | Sửa ở | Test chứng minh |
|---|---|---|
| B1 body vô hạn | 9, 10, 36 (`raw-body`, 413 + `Connection: close` + đóng socket) | chunked vô hạn → 413 trong `MAX_413_MS`, socket đóng (Task 9 unit, Task 10 route Nest, Task 36 `/api/auth/*`) |
| B2 lỗi ngoài endpoint | 1 (S1 tự mount), 4 (S4a đo reject), 34 (bỏ map lỗi ở hook), 36 (try/await, map mọi `Response` ≥ 400, probe pool, đăng xuất của mình) | Task 36: DB auth sập → 503 + process sống + không `unhandledRejection`; burst → 429 problem+json + `Retry-After`; sign-out lỗi DB → 503, không `Set-Cookie`, session còn |
| B3 env smoke | 17 (`buildSmokeEnv` từ example + `assertSmokePreflight`), 43, 46 | Task 17 unit `smoke-env.spec.ts`; preflight thật ở Step 5 |
| B4 oracle `/change-email` | 34 | ẩn danh: 401 giống hệt với email có/không, không thư; có session + email đã có: 202 + thư |
| I1 | 6, 21 | href so sau khi decode HTML |
| I2 | 18 (mặc định 8000, luật deadline < timeout `smtp`), 22 (lỗi vĩnh viễn là kết quả trong policy) | 550 liên tiếp không mở breaker; 451 liên tiếp có mở |
| I3 | 26 (giây; `rateLimit.enabled: false`), 39 | hạn mặc định ±60 s; 15 request đều 200 |
| I4 | 28 | pass-through generic, `memoryAdapter` + `vi.spyOn`, không cast |
| I5 | 34 | 5 đăng ký song song → 5 × 202, 1 user |
| I6 | 34 | `"  X@Y "` đăng ký + đăng nhập được |
| I7 | 37 | `x-api-key: ` / bearer rác trên route public → 401; DB sập + credential trên route public → 503 |
| I8 | 27, 31, 32, 36, 37, 41 | Task 40 `telemetry.e2e.spec.ts` + assert span ở 27/31/32/41 |
| I9 | 1 (S1 có Nest middleware ghi `seen`), 37 (`exclude`) | spy `AuthProvider.authenticate` không bị gọi trên `/api/auth/*` |
| M1–M9 | 1; 6/26/42; 2/4/5; 26; 32; 36; 47; 21/34; 14/17/46 | theo từng task |
| NB1 (re-review) pool `auth_user` không có listener `'error'` | 26 (`createAuthPool` gắn listener, log mã lỗi), 27 | `auth-pool-idle-error.spec.ts`: `pg_terminate_backend` → warn, không uncaught exception, query sau chạy lại; DB không lên → 503 (Task 36) |
| NI1 `instanceof APIError` bỏ sót lỗi better-call | 34 (`isAPIError`, đối chiếu tarball 1.7.6 `@better-auth/core/utils/is-api-error`) | Task 34: sign-up sai → 400 `VALIDATION_ERROR`, không 202; Task 36: qua mount → 422 `validation_failed` problem+json |
| NI2 spike storage luôn cho qua | 1 (`consume` đếm thật theo `key`/`rule`, IP cố định) | S1 (c)/(i): 401 → 429 problem+json |
| NM1 `$1::uuid, $1::text` → 42P08 | 32 (`$1::uuid::text`) | purge test |
| NM2 503 của hook không đếm | 36 (`copy()` tăng `unavailable` khi 503) | `telemetry.e2e.spec.ts` |
| NM3 `destroy()` gây RST | 9 (`socket.end()` + hạn `SOCKET_CLOSE_GRACE_MS`), spike S1g | test 413 chunked Task 9/10/36 |

**Không áp nguyên văn đề xuất của review (có lý do):** (a) B2 đề xuất giữ thallesp và vá quanh nó — plan bỏ hẳn thallesp và tự mount (nhánh fallback spec đã duyệt), vì không có cách await promise mà thallesp bỏ đi; (b) B2 đề xuất `isAuthInfraError(e) ? 503 : 500` cho reject của `auth.handler` — plan trả 503 cho mọi reject, vì reject ở `onRequest` là lỗi storage/schema (42501, mất kết nối) mà spec §1.8 đòi fail-closed, và `Response` ≥ 500 thì chọn 503/500 bằng probe pool auth; (c) I3 đề xuất lấy `rateLimit` của API key từ config — plan tắt hẳn và dựa throttler Nest theo principal (một cơ chế, không hai bộ đếm lệch nhau); (d) B3 đề xuất thêm tay các khoá thiếu — theo chỉ đạo, env sinh từ file example nên không còn danh sách tay.

**Khoảng trống spec đã xử lý trong plan:** tên biến thật là `LOG_EXTRA_REDACT_PATHS` (spec ghi `LOG_REDACT_PATHS`); Nest không có multi-provider → readiness contributor bằng decorator Discovery; Better Auth 1.7.6 có sẵn `onExistingUserSignUp` (ưu tiên framework ở S7); `jwt.expirationTime` là số thì là mốc tuyệt đối (truyền `"<n>s"`); thêm `DB_AUTH_CONNECTION_TIMEOUT_MS` (hết chờ connection → 503 không hard code); `EventPublisher.publish` nhận `eventId` + `ifAbsent` (identity không tự dựng header envelope); lỗi render/locale/params khi gửi không thuộc 4 mã SMTP của `last_error_code` → `FAILED` với `last_error_code NULL`, event mang `RENDER_FAILED`/`ATTEMPTS_EXHAUSTED`; config SMTP bắt buộc theo vai trò worker; `login_attempts` không có `created_at`/`updated_at` (thư viện `INSERT … VALUES` theo vị trí); config của module được đưa vào `pnpm env:example` (README SP1 để "chưa quyết"); luật production (DB `verify-full`, `rediss` + ACL, SMTP TLS) buộc smoke dùng CA cục bộ thay vì cờ bỏ qua luật.
