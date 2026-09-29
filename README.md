# NestJS SaaS Boilerplate — lõi SaaS NestJS (core, identity, thông báo email và tenancy)

Modular monolith NestJS 12: một codebase, một image, ba vai trò (`api`, `worker`, `migrate`). Sub-project 1 dựng phần `src/core/`: config, context, database (MikroORM + RLS), outbox/inbox, events, queue (BullMQ), scheduler, http (problem+json, phân trang, ETag, Merge Patch, idempotency, rate limit, OpenAPI), resilience (HTTP ra ngoài chặn SSRF), security (mã hoá field), observability (OpenTelemetry) và health. SP2 bổ sung Identity, Notifications và Bull Board; SP3 (plan 3A) bổ sung Tenancy: org, member, role hệ thống, phân quyền CASL theo catalogue và vòng đời org; các module được đăng ký trong `src/app.modules.ts`.

Thiết kế: [spec kiến trúc](docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md), [spec sub-project 1](docs/superpowers/specs/2026-09-24-sp1-core-job-infrastructure-design.md), các ADR trong [`docs/adr/`](docs/adr/).

## Yêu cầu

- Node 24 LTS. `.nvmrc` ghi đúng bản Node của image (`v24.21.0`).
- pnpm qua corepack: `corepack enable`. Phiên bản pnpm lấy từ trường `packageManager` của `package.json`.
- Docker (Docker Compose v2).

## Chạy dev

```bash
pnpm install
pnpm env:example                                  # sinh lại .env.example và .env.infra.example từ schema
cp .env.example .env && cp .env.infra.example .env.infra   # điền secret, xem ghi chú bên dưới
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env up -d
pnpm build && node --env-file=.env dist/main.migrate.js up
pnpm start:dev --env-file .env
```

Ghi chú:

- App **không tự đọc `.env`** (`ignoreEnvFile: true`), nên lệnh chạy trên host phải nạp env: `node --env-file=.env …` cho `dist/*.js`, và `pnpm start:dev --env-file .env` (option `--env-file` của `nest start`).
- `docker compose … up -d` không có profile chỉ chạy hạ tầng: Postgres, PgBouncer, Redis và Mailpit. Mọi cổng chỉ bind `127.0.0.1`; cổng phía host lấy từ `.env.infra`.
- `.env.infra` là config của hạ tầng compose (superuser Postgres, `REDIS_PASSWORD`, cổng host, `COMPOSE_REDIS_URL`), chỉ dùng để nội suy, không bao giờ vào container app. `.env` là config của app; Postgres cũng lấy mật khẩu của các role app (`DB_APP_PASSWORD`, `DB_RELAY_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_AUTH_PASSWORD`) từ đây.
- Khi chạy app trên host, `.env` cần trỏ về cổng host: ví dụ `DB_HOST=localhost`, `DB_MIGRATION_HOST=localhost`, `DB_MIGRATION_PORT` = cổng Postgres (migration luôn đi thẳng Postgres, không qua PgBouncer), `REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:<cổng Redis>`.
- `FIELD_ENCRYPTION_KEYS` và `FIELD_ENCRYPTION_ACTIVE_KID` bắt buộc ở mọi vai trò. Keyring là JSON `{"<kid>":"<base64 của đúng 32 byte>"}`, kid khớp `[a-z0-9]{1,16}`.
- Worker trên host: `node --env-file=.env --import ./dist/instrumentation.js dist/main.worker.js` (cần `DB_RELAY_PASSWORD`; `WORKER_QUEUES` rỗng = mọi queue đã đăng ký).
- Health: `GET /health/live`, `GET /health/ready`. API ở cổng `HTTP_PORT` (mặc định 3000); worker có server health riêng ở `WORKER_HEALTH_PORT` (mặc định 3001).
- Lệnh migrate: `up` (mặc định), `status`, `down <tên migration | 0>`; `node dist/main.migrate.js --help` không cần env.

### Chạy ba vai trò bằng image

```bash
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env --profile app up -d --build
```

Profile `app` build image từ `Dockerfile` (base image pin theo digest trong `docker/images.env`), chạy `migrate` trước, rồi `api` và `worker`. Mỗi vai trò chỉ nhận mật khẩu DB nó cần. Collector OpenTelemetry nằm ở profile `observability`.

Mailpit trong compose dev mặc định không có STARTTLS. Với profile `app`, cấu hình Mailpit/SMTP relay có TLS qua `SMTP_HOST` và `SMTP_PORT` trong `.env`, hoặc đặt `SMTP_REQUIRE_TLS=false` **chỉ cho local dev**. Để dùng Mailpit của stack, đặt `SMTP_HOST=mailpit`, `SMTP_PORT=1025`; `.env.example` mặc định port 587 nên cần đổi port. Khi các biến trống, compose fallback về `mailpit:1025`. Production không cho SMTP không mã hoá: nếu `SMTP_SECURE=false`, bắt buộc `SMTP_REQUIRE_TLS=true`. Smoke dùng Mailpit STARTTLS và CA riêng, giữ kiểm chứng chứng chỉ.

Profile `app` bật Bull Board trên worker qua cổng host `QUEUE_DASHBOARD_PORT_HOST` trong `.env.infra`. Port chỉ bind `127.0.0.1`, nên máy khác không truy cập trực tiếp; container cùng mạng compose có thể tới cổng 3002 của worker. Allowlist kiểm IP kết nối thuộc `COMPOSE_SUBNET`, không tin X-Forwarded-For; truy cập từ host còn phụ thuộc IP Docker chuyển tiếp. Mọi truy cập vẫn cần xác thực admin; dashboard chỉ đọc.

## Biến môi trường

Danh sách đầy đủ, giá trị mặc định và mô tả nằm trong [`.env.example`](.env.example) (config của app) và [`.env.infra.example`](.env.infra.example) (hạ tầng compose). Cả hai file được **sinh từ schema zod** bằng `pnpm env:example`; không sửa tay, không chép lại ở đây. Thiếu hoặc sai biến thì process dừng lúc khởi động và liệt kê mọi biến lỗi.

## Xác thực theo loại client

| Client       | local / hybrid                                                                         | external                                     |
| ------------ | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| Web          | Cookie session HttpOnly, Secure, SameSite từ config                                    | Cookie token do gateway/IdP phát hoặc bearer |
| Mobile       | `Authorization: Bearer <session token>`; token từ `set-auth-token` khi đăng nhập       | Bearer token user của IdP                    |
| Máy          | `x-api-key: <key>` (tên cấu hình bằng `AUTH_API_KEY_HEADER`); principal là user sở hữu | Chưa hỗ trợ service principal                |
| Dịch vụ khác | JWT lấy qua `/api/auth/token`, verify qua `/api/auth/jwks`; API này không nhận JWT đó  | Theo hợp đồng IdP                            |

Mỗi request chỉ một credential. Cookie + bearer, header trùng, cookie trùng hoặc Authorization sai dạng trả `400 ambiguous_credentials`; riêng `POST /api/auth/sign-out` nhận cookie + bearer và thu hồi cả hai. API key không được gọi bất kỳ path nào của auth mount (`400 api_key_not_accepted`), phải dùng session để tạo/xoá key. Credential sai vẫn 401 trên route public. User chưa xác thực email (vd. đăng ký qua IdP không tin cậy): với `AUTH_REQUIRE_EMAIL_VERIFICATION=true` (mặc định) session của họ nhận `403 email_not_verified` trên route Nest và API key của họ bị 401; bất kể cờ, họ không tạo được API key, JWT (`/token`), 2FA hay đổi email/mật khẩu (`403 email_not_verified`) cho tới khi xác thực email (ADR 0010, S2-R76).

Request thay đổi trạng thái dùng cookie phải có Origin tin cậy (`HTTP_CORS_ORIGINS` và origin của `AUTH_BASE_URL` khi có); thiếu Origin thì cần `Sec-Fetch-Site: same-origin`. Luật áp cho Nest, auth mount, Bull Board và external. Bearer/API key không cần CSRF. Cookie local mặc định host-only, `Path=/`, HttpOnly; Domain cha cần xác nhận mọi subdomain tin cậy. External: API chỉ đọc cookie `AUTH_EXTERNAL_TOKEN_COOKIE`, gateway/IdP phải phát và xoá đúng tên/Path/Domain.

### AUTH_MODE và env cần có

Ngoài env core/DB/security trong `.env.example`, cấu hình theo mode:

| Mode               | Env xác thực bắt buộc                                                                                                                                                | Hành vi                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `local` (mặc định) | `BETTER_AUTH_SECRET` (ít nhất 32 ký tự), `AUTH_BASE_URL`, `DB_AUTH_PASSWORD` trên api/worker                                                                         | Better Auth email/password, 2FA, API key, JWT; Google tuỳ chọn với cả `AUTH_GOOGLE_CLIENT_ID` và `AUTH_GOOGLE_CLIENT_SECRET` |
| `hybrid`           | Toàn bộ local + `AUTH_OIDC_PROVIDER_ID`, `AUTH_OIDC_DISCOVERY_URL`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`                                                 | Một OIDC; scopes mặc định openid,email,profile; provider không đăng ký được thì boot thất bại                                |
| `external`         | `AUTH_EXTERNAL_JWKS_URL`, `AUTH_EXTERNAL_ISSUER`, `AUTH_EXTERNAL_AUDIENCE`, `AUTH_EXTERNAL_ALGORITHMS`, `AUTH_EXTERNAL_USER_CLAIM`, `AUTH_EXTERNAL_USER_CLAIM_VALUE` | Không Better Auth, auth pool hoặc `/api/auth/*`; verify token user, pin issuer/audience/algorithm, không theo jku/x5u        |

External không cần secret/pool auth; DB của core và keyring `FIELD_ENCRYPTION_KEYS`/`FIELD_ENCRYPTION_ACTIVE_KID` vẫn bắt buộc theo vai trò. Worker cần `DB_RELAY_PASSWORD`, `SMTP_HOST`, `MAIL_FROM`; `SMTP_USER`/`SMTP_PASSWORD` cùng có hoặc cùng trống. Dashboard external cần cặp `AUTH_EXTERNAL_ADMIN_CLAIM`/`AUTH_EXTERNAL_ADMIN_VALUE` để nhận diện admin. `GET /v1/me` chỉ có local/hybrid.

S2-R56: external boot được với env bắt buộc, không cần `RESILIENCE_OVERRIDES`. Mặc định `AUTH_EXTERNAL_JWKS_TIMEOUT_MS=5000`, `AUTH_EXTERNAL_JWKS_COOLDOWN_MS=30000`, `AUTH_EXTERNAL_JWKS_CACHE_MAX_AGE_MS=600000`. Timeout mỗi attempt của idp-jwks = max(1, floor(hạn jose / (retries + 2))), mặc định 1250 ms với hai retries. Override timeout phải nhỏ hơn hạn jose; thứ tự ưu tiên general < provider default < override.

Production cần HTTPS cho auth/IdP, Secure cookie, auth rate limit bật, DB TLS, Redis TLS/ACL, SMTP TLS và kiểm chứng chỉ. Localhost HTTP chỉ dùng `AUTH_SECURE_COOKIES=false` ở development/test. S2-R58/S2-R68: floor `AUTH_ENUMERATION_MIN_RESPONSE_MS` mặc định 300 ms, tối đa 5000 ms, phải > 0 ở local/hybrid production; không đặt `BETTER_AUTH_SECRETS`, `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_TELEMETRY`, `BETTER_AUTH_TELEMETRY_ENDPOINT` vì chúng có thể đè cấu hình bảo mật của app.

### Route chính (base path mặc định /api/auth)

- Email/session: `sign-up/email`, `sign-in/email`, `sign-out`, `verify-email`, `request-password-reset`, `reset-password`, `change-password`, `change-email`.
- Social: `sign-in/social`, `callback/:id`, `link-social`. User có mật khẩu liên kết IdP tường minh từ session; không auto-link.
- 2FA: nhóm `two-factor/*`; key: `api-key/create`, `api-key/delete`, `api-key/list`; JWT: `token`, `jwks`.
- Admin: nhóm `admin/*`, tắt `admin/impersonate-user` và `admin/stop-impersonating`.
- `GET /v1/me` trả profile user sở hữu session hoặc API key. `AUTH_BASE_PATH` thay đổi prefix mount.

S2-R42/S2-R66/S2-R68: user đã xác thực, session mới → luôn gửi `change-email-confirmation` tới địa chỉ cũ → bấm link mới kiểm địa chỉ đích. Đích trống nhận verification, đích đã có chỉ nhận thông báo `existing-account`; response click giống nhau. Mỗi token dedupe một email mỗi nhánh; có thể hai thư nếu trạng thái đích đổi giữa các click. GET `/verify-email` cũng có floor và dùng `AUTH_EMAIL_RATE_MAX=3` / `AUTH_EMAIL_RATE_WINDOW_SEC=300` theo IP, cùng `/change-email`; người dùng chung NAT có thể gặp 429.

### CLI và runbook

CLI không tự nạp `.env`. Export env trong shell trước khi chạy: `APP_ROLE=api`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_APP_PASSWORD`, `DB_AUTH_PASSWORD`, `BETTER_AUTH_SECRET`, `AUTH_BASE_URL`; thêm `DB_AUTH_HOST`/`DB_AUTH_PORT` nếu khác pool chung và env hybrid/production tương ứng. Cấu hình chung theo `.env.example`; lỗi thiếu env in tên biến, không in secret.

```bash
pnpm auth:generate
pnpm auth:check
pnpm auth:create-admin --email admin@example.com --password '<secret>' --role admin
```

Các script build rồi dùng CLI `auth` 1.7.6 với config trong dist. `auth:generate` chỉ sinh SQL ở `.auth-schema/pending.sql` để review/đưa vào migration; `auth:check` gọi `auth check schema` để phát hiện drift. Script create-admin đã có `--yes`; thiếu cờ khi gọi CLI trực tiếp có thể thoát 0 mà không tạo user. Dùng secret tạm phù hợp quy trình vận hành, không lưu mật khẩu thật vào tài liệu/lịch sử shell.

- Xoay `BETTER_AUTH_SECRET`: chuẩn bị mất hiệu lực session và mất khả năng giải mã secret 2FA/private key JWKS cũ; có downtime xác thực, phải có kế hoạch phục hồi/re-enrolment. SP2 không hỗ trợ xoay song song secret này.
- Xoay FieldCipher: thêm kid → đổi `FIELD_ENCRYPTION_ACTIVE_KID` → re-encrypt mọi token/dữ liệu còn cần đọc → mới bỏ kid cũ. Job/runbook tự động thuộc SP7; bỏ kid sớm có thể làm get-access-token trả 400.
- Xoay API key: tạo mới → cập nhật client → gọi api-key/delete key cũ. Đổi mật khẩu không thu hồi API key.
- Bull Board: chỉ một deployment bật `QUEUE_DASHBOARD_ENABLED`; truy cập nội bộ/port-forward và đặt `QUEUE_DASHBOARD_IP_ALLOWLIST`. Dashboard không gia hạn cookie session cho trình duyệt.
- `identity_registered_unmarked_oldest_seconds` vượt nửa min(`OUTBOX_RETENTION_DAYS`, `INBOX_RETENTION_DAYS`): kiểm auth pool và worker, yêu cầu chạy job đã đăng ký `identity.reconcile-registered` qua công cụ queue nội bộ. Không có CLI chạy job riêng được cung cấp.
- `identity_auth_email_request_failed_total` > 0 (nên đặt alert): một thư của auth không được yêu cầu sau commit (pool app/PgBouncer lỗi, process chết). Thư xác thực/đặt lại mật khẩu/xác nhận đổi email: người dùng yêu cầu lại; không có cơ chế tự gửi bù (S2-R75). Xem log `auth_email_request_failed` theo template và SQLSTATE.
- `identity_security_notice_pending_oldest_seconds` vượt vài chu kỳ `AUTH_SECURITY_NOTICE_RECONCILE_CRON`: thông báo bảo mật (2FA) chưa gửi được; kiểm worker, auth pool, pool app. Cron `identity.reconcile-security-notices` tự gửi bù khi hạ tầng hồi phục (S2-R75) — **chỉ** cho lỗi tạm thời. Gauge này KHÔNG tính marker đã `abandoned` (M1, S2-R75 review): nếu tăng không giới hạn dù hạ tầng khoẻ, đó là backlog THẬT, không phải marker bị kẹt vĩnh viễn.
- `identity_security_notice_abandoned_total` > 0 (M1, S2-R75 review): một thông báo bảo mật (2FA bật/tắt) không bao giờ gửi được — thường là IdP tin cậy gán địa chỉ không hợp lệ (`InvalidEmailRequestError`, vd. `a@corp`). Cron KHÔNG thử lại marker này (đã đánh dấu `abandoned`, loại khỏi cả cron lẫn gauge ở trên). Xem log `security_notice_abandoned` (an toàn, không có địa chỉ) để biết `noticeId`/`userId`; xử lý thủ công nếu người dùng cần được báo (đổi địa chỉ liên hệ ở IdP, hoặc gửi tay).
- `notifications_email_stuck_total` tăng: kiểm SMTP/worker; cron enqueue lại dòng chưa terminal. Hết `NOTIFICATIONS_MAX_TOTAL_ATTEMPTS` → FAILED + event; FAILED không tự gửi lại (S2-R61), người dùng yêu cầu thư mới.
- External sign-out: gateway/IdP xoá cookie đúng scope và thu hồi refresh token/session tại IdP; access token còn hiệu lực tới exp, có thể giới hạn thêm bằng `AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC`.
- **Org bị bỏ rơi** (owner duy nhất bị ban/mất email): platform admin, có ticket, báo trước 3 ngày, nâng một member lên OWNER bằng SQL trong `OrgScope` của org rồi ghi lại vào ticket.
- **Xoá tài khoản dở dang** (`409 user_deletion_blocked` sau khi Better Auth đã gỡ session/mật khẩu): lý do `MEMBERSHIP_CREATED` → chạy lại `/admin/remove-user`; lý do `LAST_OWNER` → user dùng "quên mật khẩu" để lấy lại đăng nhập, chuyển/nâng owner khác, rồi admin chạy lại.
- **Dòng `scheduled_tasks` mồ côi ở lần deploy đầu tiên** (`src/migrations/tenancy/Migration20260928232100_scheduled_tasks_org_link.ts`): migration này thêm FK `scheduled_tasks_org_fk RESTRICT` tới `organizations`. Ở lần deploy đầu, bảng `organizations` còn rỗng (tenancy vừa được bật), nên **mọi** dòng `scheduled_tasks` có sẵn từ SP1/SP2 (`org_id IS NOT NULL`, tạo trước khi tenancy tồn tại) đều mồ côi và migration sẽ fail to ngay ở câu `ALTER TABLE … ADD CONSTRAINT` (`23503`/`23514` khi validate FK trên dữ liệu hiện có). Trước khi chạy migration này ở một DB đã có dữ liệu: liệt kê `SELECT id, org_id FROM scheduled_tasks WHERE org_id IS NOT NULL`, rồi với mỗi dòng — tạo org tương ứng (nếu lịch đó vẫn cần chạy tiếp) hoặc xoá lịch mồ côi (nếu không còn org nào dùng) — TRƯỚC khi migrate; migration không âm thầm bỏ dòng nào. Sau khi migration đã chạy sạch, dòng mồ côi mới không xảy ra được nữa (FK `RESTRICT` chặn INSERT, participant `core.scheduled-tasks` xoá theo org khi org bị xoá cứng); scheduler Redis mồ côi (job còn trong BullMQ nhưng dòng DB đã mất) được `SCHEDULER_RECONCILE_CRON` dọn.
- **Đổi `AUTH_MODE`** trên DB đã có `tenancy_users` không được hỗ trợ tự động (subject khác loại: `auth_user_id` ↔ `external_subject`).
- **External:** IdP phải phát claim `auth_time` (OIDC Core §2; client gửi `max_age`), thiếu thì mọi mutation nhạy cảm của tenancy trả `403 reauthentication_required`.
- **Lô migration SP3** giữ khoá tới hết lô (`allOrNothing`): chạy trong cửa sổ ít ghi, có `lock_timeout`.
- **Org purge thất bại lâu dài** chỉ được enqueue lại khi BullMQ đã dọn job `failed` cũ (`QUEUE_KEEP_*`) hoặc retry trên Bull Board; nếu ≥ `TENANCY_ORG_PURGE_BATCH_SIZE × _MAX_BATCHES` org lỗi đứng đầu thứ tự, org sau bị bỏ đói giữa các lượt (log WARN `org_purge_backlog`).

### Dev và ngân sách connection

Volume Postgres cũ của SP1 chưa có role/schema mới; dev DB SP2 đã chạy migration trước S2-R42 cũng phải reset vì CHECK template được sửa tại chỗ để nhận `change-email-confirmation`: với dữ liệu dev có thể bỏ, tạo lại volume rồi migrate. **Lệnh dưới xoá dữ liệu dev trong compose**; không dùng trên dữ liệu cần giữ (môi trường đó cần DBA áp script role/schema).

N3 (final-fixes rereview): cùng lý do, `Migration20260927163904_better_auth_schema.ts` bị sửa tại chỗ ở DB final review M4 (52fd544/728cc8b) để thêm `CHECK user_email_canonical_ck` trên `auth."user".email`. Sửa migration đã ship/áp dụng tại chỗ chỉ chấp nhận được vì nhánh SP2 này CHƯA merge (implementer contract, HARD RULE không xoá/sửa ngoài phạm vi worktree không áp dụng ở đây vì migration vẫn trong worktree đang phát triển). Bất kỳ dev/staging DB nào đã migrate nhánh này TRƯỚC 728cc8b sẽ không có `user_email_canonical_ck` và phải reset bằng đúng quy trình trên (down -v, up, migrate lại) trước khi tiếp tục — không `ALTER TABLE` tay để vá lệch.

M1 (S2-R75 review, cleanup batch): cùng lý do, `Migration20260928082958_security_notice.ts` bị sửa tại chỗ để thêm cột `abandoned_at` + CHECK/index/grant đi kèm (marker "bỏ vĩnh viễn", xem mục backlog/abandoned ở trên). DB nào đã migrate `auth.security_notice` TRƯỚC lần sửa này thiếu cột đó và phải reset bằng đúng quy trình trên.

```bash
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env down -v
docker compose --env-file docker/images.env --env-file .env.infra --env-file .env up -d
pnpm build
node --env-file=.env dist/main.migrate.js up
```

Mailpit UI: `http://127.0.0.1:<MAILPIT_UI_PORT_HOST>` (cổng trong `.env.infra`). Pool auth mặc định theo `DB_HOST`/`DB_PORT`, có thể qua PgBouncer transaction mode; cần hỗ trợ prepared statements theo cấu hình infra. Relay luôn thẳng Postgres. Ngân sách connection phía app:

```text
api_pods × (DB_POOL_MAX + DB_AUTH_POOL_MAX)
+ worker_pods × (DB_POOL_MAX + DB_RELAY_POOL_MAX + DB_AUTH_POOL_MAX)
```

Đây là tổng pool của process, không phải toàn bộ backend connection qua PgBouncer; tính thêm giới hạn PgBouncer/DB và bỏ phần auth pool ở external.

### Deadline DB và readiness

Auth: `DB_AUTH_CONNECTION_TIMEOUT_MS=3000`, `DB_AUTH_QUERY_TIMEOUT_MS=6000`. Core API: `DB_CONNECTION_TIMEOUT_MS=3000`, `DB_QUERY_TIMEOUT_MS=6000`. `HTTP_REQUEST_BUDGET_MS=30000` phải khớp proxy/LB; là ngân sách kiểm config và hạn checkout core API, không phải timeout cưỡng chế mọi handler. Production kiểm core connect + 2 × query < budget; auth kiểm max(2 × (connect + query) + `HEALTH_CHECK_TIMEOUT_MS`, floor) < budget.

Worker app/relay: `DB_WORKER_CONNECTION_TIMEOUT_MS=65000`, `DB_WORKER_QUERY_TIMEOUT_MS=65000`, `DB_WORKER_STATEMENT_TIMEOUT_MS=60000`, `DB_WORKER_CHECKOUT_MAX_MS=300000`. Luật mọi môi trường: connect ≥ query > statement; checkout > 2 × query. Job transaction phải xong trước checkout max; job registry không có timeout riêng. Chi tiết thu hồi slot và Kysely ở [ADR 0007](docs/adr/0007-http-conventions.md).

Readiness production yêu cầu `statement_timeout` thực tế của mỗi pool > 0 và nhỏ hơn query deadline tương ứng. Drift role/PgBouncer có thể làm toàn cụm mất readiness (N5). Kiểm setting qua connection runtime, sửa role/PgBouncer và recycle connection cũ có kiểm soát; kiểm readiness trước rollout rộng. Ngoài production chỉ log lỗi cấu hình. `503 commit_outcome_unknown` nghĩa COMMIT có thể đã ghi, không coi là rollback chắc chắn: thử lại với cùng Idempotency-Key (không được lưu làm response cuối) trên route ghi idempotent trong DB theo key, hoặc đối soát trước khi thử lại (ADR 0007). Auth 401 có infra failure ghi trong cùng request được đổi thành 503, không xoá cookie như logout.

### Smoke prod-like

```bash
pnpm test:smoke
```

Cần Docker. Harness build image production thật từ digest trong `docker/images.env`, chạy compose profile app, migrate và HTTP smoke với `NODE_ENV=production`; kiểm TLS, readiness và log. Không dùng kết quả unit test thay cho smoke.

Ngoại lệ localhost của harness: CA tạm cho TLS (tin qua `NODE_EXTRA_CA_CERTS`/`DB_SSL_CA_PATH`); client gọi HTTP nội bộ như ingress đã terminate TLS, vẫn cấu hình `AUTH_BASE_URL=https://localhost` và cookie Secure; link email được đổi sang cổng HTTP nội bộ. Redis dùng một user ACL +@all; dashboard allowlist subnet compose (`COMPOSE_SUBNET`, không phải tên cũ trong plan). Superuser Postgres chỉ dùng để tạo tình huống admin/thu hồi-cấp lại grant trong test. Không có cờ bỏ kiểm tra production trong code.

### Giới hạn đã biết

Session token còn lưu dạng gốc trong auth.session. JWT/IdP access token đã phát không thu hồi ngay trước exp. Cooldown JWKS 30 s có thể trì hoãn nhận kid mới. Email at-least-once có thể trùng; SMTP outage vượt retry budget để lại FAILED. Junk-key flood có thể làm key hợp lệ chung IP/NAT nhận 429. Latency floor S2-R58 không xoá timing channel khi xử lý vượt floor. S2-R60–S2-R72 đã có deadline DB, huỷ client không dùng lại được và thu hồi slot. Link confirmation chứa địa chỉ mới trong JWT đọc được từ hộp thư cũ; token gắn email, không gắn user id, nên tái sử dụng địa chỉ cũ trong TTL còn rủi ro. API key hợp lệ dưới Redis blackhole tốn khoảng 3 × `REDIS_COMMAND_TIMEOUT_MS`. Các quyết định và residual đầy đủ ở [ADR 0010](docs/adr/0010-better-auth-and-auth-modes.md), [spec SP2](docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md).

## Cách thêm

Mọi ví dụ dưới đây lấy từ `src/` hoặc `test/fixtures/` (rút gọn bằng `// …`). Import từ `index.ts` của từng module core, ví dụ `src/core/queue/index.ts`. Module của dự án được bật trong `src/app.modules.ts` (`APP_MODULES.api` / `APP_MODULES.worker`).

### Config

Mỗi module khai báo schema zod của mình bằng `defineConfig(namespace, envMap, schema)`; mỗi giá trị có một biến env, mặc định chỉ nằm trong schema kèm `.describe()`. Trích `src/core/health/health.config.ts`:

```ts
import { z } from 'zod';
import { defineConfig } from '../config/index.js';

export const healthConfig = defineConfig(
  'health',
  {
    checkTimeoutMs: 'HEALTH_CHECK_TIMEOUT_MS',
    // …
  },
  z.object({
    checkTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(500)
      .describe('Timeout of each readiness check; …'),
    // …
  }),
);
```

Đọc config bằng injection `@Inject(healthConfig.KEY)` với kiểu `ConfigOf<typeof healthConfig>`. Luật liên quan nhiều namespace dùng `defineConfigRule(name, fn)`; luật chỉ áp ở production dùng `defineProductionRule(name, fn)`. Config của core được import trong `src/core/config/all-configs.ts`; script `src/scripts/gen-env-example.ts` nạp thêm config Identity/Notifications để xuất env SP2. Module mới phải được đăng ký trong script này.

### Queue và job

`defineQueue` khai báo queue, `defineJob` khai báo job có version và schema payload, `@JobHandler` gắn handler. Handler nhận `JobContext` (payload đã validate, `attempt`, `meta`, `signal`), không import BullMQ. Job có `meta.orgId` luôn chạy trong `OrgScope`. Enqueue (`JobQueue`, `SafeEnqueue`) hay ghi outbox trong một org thì job/event luôn thuộc org của context; `meta.orgId` khác org đó bị từ chối (spec §5.4), chỉ code hệ thống (ngoài org) mới chọn org qua `meta.orgId`. Trích `test/fixtures/fixture.jobs.ts`:

```ts
import {
  defineJob,
  defineQueue,
  JobHandler,
  type JobContext,
} from '../../src/core/queue/index.js';

export const FixtureQueue = defineQueue('fixture', { kind: 'io' });
export const RecordJob = defineJob({
  name: 'fixture.record',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string() }),
});
export const OrgJob = defineJob({
  name: 'fixture.org',
  queue: FixtureQueue,
  version: 1,
  schema: z.object({ key: z.string() }),
  tenantSchedulable: true,
});

@Injectable()
@JobHandler(RecordJob)
export class RecordHandler {
  async handle(ctx: JobContext<{ key: string }>) {
    // …
  }
}
```

Handler phải là provider trong một module của `APP_MODULES.worker`; worker không khởi động nếu một job của queue nó consume thiếu handler. Enqueue qua `SafeEnqueue.enqueue(job, payload, opts?)` (`src/core/outbox/safe-enqueue.ts`): trong `UnitOfWork.run` job đi qua outbox và chỉ được gửi sau commit; ngoài transaction thì gửi thẳng Redis, lỗi thì ghi outbox với cùng `jobId`. Chỉ job có cờ `tenantSchedulable` (như `OrgJob` ở trên) mới được tenant đặt lịch. Lịch của tenant tạo bằng `ScheduledTaskService.upsert({ key, job, cron, timezone, payload, enabled })`; org lấy từ `RequestContext`, không nhận từ input.

### Cron tĩnh

`defineCron` với lịch đọc từ config (không hardcode biểu thức cron). Trích `src/core/outbox/outbox.jobs.ts`:

```ts
defineCron({
  key: 'core.outbox.cleanup',
  job: OutboxCleanupJob,
  payload: {},
  schedule: () => {
    const c = outboxConfig();
    return { cron: c.cleanupCron, tz: c.cleanupTz };
  },
});
```

Bỏ một cron: xoá `defineCron` rồi gọi `retireCron(key)`. Đây là cách duy nhất xoá cron tĩnh; worker không bao giờ xoá cron chỉ vì bản đang chạy không khai báo nó (rolling deploy).

### Event

`defineEvent` khai báo loại event có version và schema. Phát event bằng `EventPublisher.publish` bên trong `UnitOfWork.run`, để event ghi vào outbox cùng transaction với dữ liệu. Trích `test/fixtures/fixture.events.ts` và `test/fixtures/fixture.controller.ts`:

```ts
export const NoteCreated = defineEvent({
  type: 'fixture.note.created',
  version: 1,
  schema: z.object({ body: z.string() }),
});

await this.uow.run(async () => {
  await this.repo.insertSystemNote(body.body);
  await this.events.publish(NoteCreated, {
    data: { body: body.body },
    aggregate: { type: 'note', id: body.body, version: 1 },
    actor: { type: 'system', id: 'fixture' },
  });
});
```

Nhận event bằng `@EventSubscriber`; mỗi subscriber có tên `consumer` duy nhất và chạy trong `UnitOfWork` + inbox (xử lý đúng một lần phần ghi DB):

```ts
@Injectable()
@EventSubscriber({ consumer: 'fixture.audit', event: NoteCreated })
export class AuditSubscriber implements EventHandler<typeof NoteCreated> {
  async handle(e: EventEnvelope<{ body: string }>) {
    // …
  }
}
```

`handle()` chỉ làm việc với DB. Gọi HTTP, Redis hay gửi mail thì `SafeEnqueue` một job trong `handle()`; job đó chạy ngoài transaction và phải idempotent ([ADR 0006](docs/adr/0006-queue-outbox.md)).

### Bảng có RLS

Tạo migration bằng CLI của MikroORM (cần một Postgres đang chạy, kể cả với `--blank`), rồi viết SQL vào thân:

```bash
MIKRO_ORM_CLIENT_URL=postgresql://<superuser>:<password>@localhost:<cổng>/<db> \
  pnpm mikro-orm migration:create --blank --path src/migrations/app --name <tên>
```

Bảng có `org_id` bật RLS + FORCE, policy dùng `app_current_org()`, và cấp quyền theo từng bảng ngay trong migration. Trích `test/fixtures/migrations/Migration20260925023638_fixture_org_notes.ts`:

```ts
this.addSql(`ALTER TABLE fixture_org_notes ENABLE ROW LEVEL SECURITY;`);
this.addSql(`ALTER TABLE fixture_org_notes FORCE ROW LEVEL SECURITY;`);
this.addSql(`CREATE POLICY fixture_org_notes_isolation ON fixture_org_notes
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
this.addSql(
  `GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_org_notes TO app_user;`,
);
```

Truy vấn bảng tenant phải chạy trong `OrgScope.run(orgId, fn)`; thiếu org thì Postgres báo lỗi thay vì trả dữ liệu. Job có `meta.orgId` được `WorkerHost` bọc sẵn (`src/core/queue/worker-host.ts`):

```ts
() => (meta.orgId ? this.orgScope.run(meta.orgId, run) : run()),
```

`OrgScope.run` không được gọi bên trong một transaction đang mở với org khác. Bảng mới được `test/integration/core/database/rls-catalog.spec.ts` kiểm tra tự động ([ADR 0005](docs/adr/0005-multi-tenant-rls.md)).

Ba trigger bất biến của tenancy giữ owner (`organizations_bootstrap_ck`, `organizations_restore_owner_ck`, `org_members_last_owner_ck`) là `SECURITY DEFINER` thuộc role `tenancy_definer`, tự tuần tự hoá bằng `pg_advisory_xact_lock` theo org id thay vì khoá dòng, và đòi chạy dưới `READ COMMITTED` (ném lỗi ở isolation khác): dưới FORCE RLS, một trigger chạy quyền caller không đọc lại được trạng thái mà một connection khác vừa giữ, nên không tự khoá-rồi-đọc-lại dòng org như transaction quản trị bình thường được ([ADR 0017](docs/adr/0017-tenancy-own-module.md)).

### Quyền nghiệp vụ và route tenant

Route của một org luôn nằm dưới `/v1/orgs/:orgId/…` (tham số phải tên `orgId`; handler đọc org bằng `RequestContext.orgId()`). Mỗi module khai catalogue quyền của mình, đăng ký bằng marker Discovery, và seed dòng `permissions` bằng migration (app không khởi động nếu catalogue lệch DB):

```ts
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import {
  definePermissionCatalogue,
  PermissionCatalogueContributor,
} from '../../modules/tenancy/index.js';

export const BillingPermissions = definePermissionCatalogue('billing-feature', {
  'invoices.read': {
    resource: 'invoices',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: true,
    supportEligible: true,
    grantTo: { admin: true, member: true },
  },
});
@Injectable()
@PermissionCatalogueContributor(BillingPermissions)
class BillingCatalogue {}

@Controller('v1/orgs/:orgId/invoices')
class InvoicesController {
  @Get() @BillingPermissions.require('invoices.read') list() {
    /* chạy trong OrgScope của org trên path */
  }
}
@Module({ providers: [BillingCatalogue], controllers: [InvoicesController] })
export class InvoicesModule {}
```

- `grantTo` bắt buộc: quyền mới không tự vào ADMIN/MEMBER; OWNER nhận mọi quyền không deprecated. `ownerOnly` không được cấp cho admin/member.
- Route tenant thiếu `require(...)`/`@OrgMemberOnly()`, hoặc catalogue chưa đăng ký → app không khởi động. Mutation quản trị của tenancy mang `@SensitiveTenancyAction()` (session mới + email đã xác thực) hoặc `@NarrowingTenancyAction()`; mutation nghiệp vụ của `features/` không cần.
- Vòng đời quyền chỉ thu hẹp: deprecate ở bản N (`deprecated: true` + migration đặt `deprecated_at`), xoá ở bản N+1 theo mẫu 7 bước `NO FORCE … FORCE` (ADR 0005); không bao giờ `UPDATE` key tại chỗ.
- Tên constraint theo `<bảng>_<luật>` (tên constraint deferrable phải duy nhất trong schema).
- `CatalogueCheck` (`onModuleInit`, không phải `onApplicationBootstrap`): app không khởi động nếu catalogue trong code lệch DB (thiếu migration, pod lệch version); key chỉ có ở DB mà không catalogue nào nạp (org đã purge một phần, DB seed của plan khác) chỉ WARN + metric `tenancy_catalogue_orphan_keys`, vẫn khởi động — vì route/kiểm role chỉ dùng catalogue đã nạp nên key đó trơ, không phải lỗi cần crash-loop (R-X21). Chạy ở `onModuleInit` để đứng trước `onApplicationBootstrap` của `WorkerHost`/`OutboxRelay`: kiểm muộn hơn để worker kịp tiêu thụ job trước khi lệch bị phát hiện.
- Matcher route tenant (`classifyOrgRoute`) từ chối mọi route mà một trong hai segment đầu không phải literal (`v1/orgs{/:orgId}`, `v1/:k/:id`, `{*path}`) bằng cách xếp `INVALID` (app không khởi động), không xếp `OTHER` (bỏ qua): Express vẫn phục vụ `/v1/orgs/X` qua một route như vậy, nên coi là route tenant "mở cửa" (không guard/policy/scope) mà không bị bắt sẽ fail-open.

### Role tuỳ biến

Ngoài ba role hệ thống, mỗi org tạo role của riêng mình (`roles.write`, mọi route là `@SensitiveTenancyAction()`):

- `POST /v1/orgs/{orgId}/roles` (`Idempotency-Key`; `201` + `Location` + `ETag`), `PATCH /v1/orgs/{orgId}/roles/{roleId}` (Merge Patch; `If-Match` bắt buộc: thiếu → `428`, cũ → `412`; `permissions` thay nguyên mảng), `DELETE /v1/orgs/{orgId}/roles/{roleId}` (`204`). Role hệ thống chỉ đọc (`409 system_role_immutable`).
- Tên 1–64 ký tự (đếm code point), không khoảng trắng đầu/cuối, duy nhất trong org không phân biệt hoa/thường (`409 role_name_taken`).
- Non-owner chỉ tạo/sửa/xoá/gán thứ nhỏ hơn hẳn mình (`403 escalation_denied`); sửa role đang có người giữ đòi actor trội hẳn CẢ tập cũ lẫn tập mới. Tập chứa toàn bộ quyền của ADMIN chỉ owner được chạm (`403 owner_only`). Không ai sửa được role mình đang giữ (`403 cannot_edit_own_role`).
- Tập quyền phải đóng theo `requires` (`422 missing_dependencies`, `errors[]` liệt kê key thiếu; API không tự thêm), key phải có trong catalogue đã nạp và không deprecated (`422 unknown_permission`), quyền `ownerOnly` không giao được (`422 permission_not_delegable`). Role rỗng `[]` hợp lệ: người giữ vẫn là member nhưng không có quyền nào.
- Xoá role còn member → `409 role_in_use`: chuyển member sang role khác trước.
- `PATCH` không đổi gì (cùng tập, khác thứ tự, cùng tên) giữ `version`/`ETag` và không phát event. Mỗi thay đổi phát `tenancy.role.created|updated|deleted` cùng transaction.
- Tắt một module khi role tuỳ biến còn giữ quyền của nó: key đó thành **orphan** — không cấp gì, không làm request lỗi, log WARN `orphan_permission_ignored` một lần mỗi key mỗi process và cộng `tenancy_catalogue_orphan_keys`. Owner dọn bằng `PATCH …/roles/{roleId}` gửi lại `permissions` (danh sách `GET` trả về đã không có key orphan); thêm lại key đó → `422 unknown_permission`.
- Rollback plan 3B: `down` của migration `…_custom_role_permissions` từ chối khi còn role tuỳ biến. Chuyển member về role hệ thống, xoá role tuỳ biến, rồi chạy lại.

### Vòng đời quyền

Vòng đời chỉ thu hẹp hoặc giữ nguyên quyền, không bao giờ mở rộng. Migration dữ liệu chạm tập đã lưu phát `tenancy.role.updated` với actor `system`, id `catalogue-migration:<tên migration>`.

| Thay đổi                   | Cách làm                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thêm                       | Một migration chèn dòng `permissions`. Owner nhận tự động; admin/member theo `grantTo`; role tuỳ biến không bao giờ tự nhận.                                                                         |
| Deprecate (bản N)          | Code đặt `deprecated: true`, migration đặt `deprecated_at`. Quyền mất khỏi mọi phạm vi ngay và không vào role mới (trigger); quyền nào còn `requires` nó phải deprecate cùng lúc hoặc bỏ cạnh trước. |
| Xoá (bản N+1)              | Mẫu 7 bước dưới đây: gỡ key khỏi mọi tập, thu hẹp tới điểm bất động, tăng `version` + event, rồi xoá `permission_requires`, rồi `permissions`.                                                       |
| Thêm cạnh `requires` P → Q | Chèn cạnh trước, rồi thu hẹp mọi tập tới điểm bất động (không bù Q).                                                                                                                                 |
| Bỏ cạnh `requires`         | Chỉ xoá cạnh; tập đã lưu vẫn đóng.                                                                                                                                                                   |
| Đổi tên                    | Thêm key mới → `INSERT … SELECT` ánh xạ cũ → mới → deprecate cũ → xoá cũ. Không bao giờ `UPDATE` key tại chỗ.                                                                                        |
| Tách một thành hai         | Như đổi tên, cấp cả hai key mới ở mọi nơi đang giữ key cũ.                                                                                                                                           |

### Mẫu migration dữ liệu catalogue (7 bước)

Migration chạy bằng `app_owner`, không có policy trên bảng FORCE nên thấy 0 dòng mà không báo gì. Mọi migration đọc/ghi dữ liệu trên bảng tenant theo đúng bảy bước, trong transaction của lô:

1. Không giả định chế độ constraint do migration trước để lại (bước 4 và 5 của mọi migration trước đã trả về chế độ khai báo).
2. `NO FORCE` từng bảng, theo thứ tự cố định `org_roles`, `org_role_permissions`, `org_api_keys`, `org_api_key_permissions`, `org_support_grants`, `org_support_grant_permissions` (bảng chưa có được bỏ qua).
3. DML, tăng `version` của mọi role bị chạm, một event mỗi role dựng từ giá trị sau khi tăng.
4. Xả trigger hoãn theo TÊN khi còn thấy dòng; không bao giờ `SET CONSTRAINTS ALL`. Tên constraint deferrable phải duy nhất theo schema (quy ước `<bảng>_<luật>`), khối này `RAISE` nếu trùng.
5. Trả từng constraint deferrable về chế độ khai báo (không rò `IMMEDIATE` sang migration sau).
6. `FORCE` lại, cùng tập và thứ tự.
7. Khối khẳng định: còn bảng tenant nào mất FORCE thì cả lô rollback.

SQL nguyên văn do `test/support/catalogue-migration.ts` sinh (`sevenStep(removePermissionDml(…, 'billing.export'))`, ví dụ xoá key giả định `billing.export`), mỗi khối một `this.addSql(…)`:

```sql
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['org_roles', 'org_role_permissions', 'org_api_keys', 'org_api_key_permissions', 'org_support_grants', 'org_support_grant_permissions'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE v_removed bigint;
BEGIN
  DROP TABLE IF EXISTS pg_temp.catalogue_touched_roles;
  CREATE TEMP TABLE catalogue_touched_roles (org_id uuid NOT NULL, role_id bigint NOT NULL, PRIMARY KEY (org_id, role_id)) ON COMMIT DROP;
  WITH d AS (DELETE FROM public.org_role_permissions rp USING public.permissions p WHERE p.id = rp.permission_id AND p.key = 'billing.export' RETURNING rp.org_id, rp.role_id)
  INSERT INTO catalogue_touched_roles SELECT DISTINCT org_id, role_id FROM d ON CONFLICT DO NOTHING;
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
    jsonb_build_object('actorType', 'system', 'actorId', 'catalogue-migration:Migration20270101000000_remove_billing_export', 'correlationId', 'catalogue-migration:Migration20270101000000_remove_billing_export')
  FROM u;
END $$;

DELETE FROM public.permission_requires WHERE permission_id = (SELECT id FROM public.permissions WHERE key = 'billing.export') OR required_permission_id = (SELECT id FROM public.permissions WHERE key = 'billing.export');

DELETE FROM public.permissions WHERE key = 'billing.export';

DO $$ DECLARE r record; BEGIN
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
END $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.conname, c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I %s', r.nspname, r.conname, CASE WHEN r.condeferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END);
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['org_roles', 'org_role_permissions', 'org_api_keys', 'org_api_key_permissions', 'org_support_grants', 'org_support_grant_permissions'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
```

Vận hành: bước 2 lấy `ACCESS EXCLUSIVE` trên `org_roles`/`org_role_permissions` tới hết lô, chặn câu đường nóng của mọi request tenant. Chạy trong cửa sổ ít tải với `lock_timeout` 5 s.

### Bảng tenant và xoá cứng org

Bảng có `org_id` thêm FK `org_id → organizations(id) ON DELETE RESTRICT` và đăng ký một participant xoá dòng của mình khi org bị xoá cứng (quên đăng ký → job purge lỗi `23001`, có alert `tenancy_org_purge_failed_total`, không để dòng mồ côi):

```ts
import { Injectable } from '@nestjs/common';
import { Db } from '../../core/database/index.js';
import {
  OrgPurgeParticipant,
  OrgPurgeParticipantContributor,
} from '../../modules/tenancy/index.js';

@Injectable()
@OrgPurgeParticipantContributor({ key: 'invoices', order: 10 })
export class InvoicesPurge extends OrgPurgeParticipant {
  constructor(private readonly db: Db) {
    super();
  }
  async purge(): Promise<void> {
    await this.db.execute(
      'DELETE FROM invoices WHERE org_id = app_current_org()',
    );
  }
}
```

Participant chạy TRONG transaction purge và chỉ xoá dòng DB; mọi xoá của một org nằm trong một transaction (giới hạn `DB_QUERY_TIMEOUT_MS`). Dọn ngoài DB (object storage…) là job do subscriber của `tenancy.org.purged` enqueue, và job đó phải khai `onInactiveOrg: 'run'` — mặc định `'skip'` bỏ qua mọi job tenant khi org đã xoá mềm hoặc đã mất.

Nếu bảng của `features/` ghi `scheduled_tasks` (lịch riêng của org) trong cùng transaction với thay đổi khác, **khoá dòng org trước** (`SELECT … FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE`, cùng thứ tự khoá cố định ở trên) rồi mới `INSERT`/`UPDATE` `scheduled_tasks`. Bỏ qua bước này có thể đụng trigger `scheduled_tasks_suspend_if_org_deleted` (tự khoá dòng org khi có `INSERT`, xem runbook "Dòng `scheduled_tasks` mồ côi" dưới) theo thứ tự khoá ngược với transaction xoá mềm org đang chạy song song: Postgres phát hiện deadlock (`40P01`) và `UnitOfWork` tự retry, không cần code xử lý thêm, nhưng khoá org trước tránh phải trả giá một lượt retry.

### Route idempotent

`@Idempotent()` (`src/core/http/idempotency.decorator.ts`) bắt buộc header `Idempotency-Key` và principal đã xác thực trong `RequestContext`:

```ts
export const Idempotent = (opts: IdempotentOptions = {}) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_META, opts),
    UseInterceptors(IdempotencyInterceptor),
    // …
  );
```

Cùng key và cùng request thì trả lại response đã lưu; request trùng đang chạy nhận `409`; Redis lỗi nhận `503`. Status khi trả lại lấy từ `@HttpCode` của route, nên handler không được đổi status động. `ttlSec` chỉ dùng để rút ngắn thời gian giữ (ví dụ route tiền). Principal được middleware Identity xác định trước guard ([ADR 0007](docs/adr/0007-http-conventions.md)).

### Route PATCH (Merge Patch)

Body `application/merge-patch+json` (RFC 7396) validate bằng `mergePatchSchema`, áp vào resource bằng `mergePatchInto` (cả hai từ `core/http`):

```ts
const Editable = User.pick({ name: true, nickname: true, addr: true });
const PatchUser = mergePatchSchema(Editable);

@Patch(':id')
patch(@Body({ schema: PatchUser }) b: z.infer<typeof PatchUser>) {
  // …đọc `current`, assertIfMatch(ifMatch, current.version, { required: true })
  const next = mergePatchInto(Editable, current, b); // 422 nếu kết quả sai schema
}
```

Patch đệ quy: `{"addr":{"city":"Hue"}}` giữ nguyên `addr.zip`. `null` chỉ được gửi cho member nullable (`.nullable()`, `.nullish()`, `z.union([X, z.null()])`): member nullable bắt buộc thành `null`, member nullish bị xoá khỏi kết quả (handler phải ghi là xoá). Member optional nhưng không nullable từ chối `null`; field cần xoá được thì khai báo nullable. Key lạ bị từ chối ở mọi cấp. Mảng thay nguyên; record merge từng entry. Schema có `.default()`/`.prefault()`/`.catch()` ở bất kỳ đâu, union/intersection/pipe/lazy chứa object hoặc record key không phải string bị từ chối ngay lúc dựng. `applyMergePatch(target, patch)` là thuật toán RFC 7396 §2 thuần, không biết schema ([ADR 0007](docs/adr/0007-http-conventions.md)).

### Gọi HTTP ra ngoài

Dùng `HttpClient` (`src/core/resilience/http-client.ts`); ngoại lệ có tên là fetch của Better Auth cho OAuth/OIDC (ADR 0016):

```ts
async request(provider: string, rawUrl: string, init: HttpRequestInit = {}): Promise<HttpResult>
```

`provider` phải là hằng số có tên (ví dụ `'sepay'`), không bao giờ là URL hay host do tenant nhập. Client chặn SSRF lúc kết nối, không theo redirect, giới hạn kích thước response, chỉ retry method idempotent, và không được gọi bên trong transaction DB. `ResilienceModule` (và `SecurityModule` cho `FieldCipher`) chưa được import trong module gốc: module nào dùng thì import nó ([ADR 0016](docs/adr/0016-outbound-http-ssrf.md)).

## Quy tắc

- **Cấm hard code:** timeout, TTL, giới hạn, batch, cron, retention, URL, origin, port chỉ nằm trong config schema zod của module sở hữu, mỗi giá trị có biến env. Secret không có giá trị mặc định. Định danh (tên queue, event, job, mã lỗi) là hằng số có tên trong registry của module.
- **Cài package:** `pnpm add <tên>` không ghi version, lấy bản latest đã publish ít nhất 1 ngày (`minimumReleaseAge: 1440` trong `pnpm-workspace.yaml`), `saveExact` bật sẵn. Trước khi cài chạy `pnpm view <tên> dist-tags peerDependencies`. Docker image và GitHub Action pin theo digest/SHA lấy bằng lệnh. Renovate chờ 3 ngày.
- **Ưu tiên có sẵn:** tính năng của framework/thư viện đang dùng → package được bảo trì tốt → chỉ tự viết khi không có lựa chọn đạt, kèm ADR liệt kê ứng viên đã loại.
- **Dùng CLI:** `nest g module|service|controller|…`, `mikro-orm migration:create`, `pnpm add`. Chỉ viết tay file không có generator. Không đoán flag: đọc `--help` hoặc tài liệu trước.
- **SQL chỉ qua `Db.execute`** (connection `app`, tự gắn transaction và session RLS hiện tại) **hoặc `RelayDb`** (connection `relay`, chỉ worker), hoặc pool `auth_user` trong `identity/infra/better-auth/**`. Không bao giờ dùng `getConnection().execute`.
- **Không gọi I/O bên ngoài trong transaction DB:** ghi ý định bằng `SafeEnqueue`/`EventPublisher` trong transaction, gọi hệ thống ngoài trong job.
- **Ranh giới import** được `pnpm arch` (dependency-cruiser) kiểm tra: `@mikro-orm/*` chỉ trong `core/database`, `**/infra/**` và `src/migrations`; `bullmq` chỉ trong `core/queue`; Express chỉ trong `core/http` và `core/queue/dashboard`; `tiny-merge-patch` chỉ trong `core/http`; `undici`, `ipaddr.js`, `cockatiel` chỉ trong `core/resilience`; `@casl/ability` chỉ trong `modules/tenancy/application/authz` và `modules/tenancy/http`; `modules/identity` và `modules/notifications` không import `modules/tenancy`.
- **Lỗi:** không nuốt lỗi, không trả giá trị sai trong im lặng. Lỗi không lường trước được log đầy đủ ở server, client nhận problem+json `500 internal_error`. Không `any`, không `as never`; thu hẹp kiểu bằng type guard hoặc zod.

## Kiểm tra

```bash
pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm test:int
```

`pnpm test:int` và `pnpm test:chaos` cần Docker (Testcontainers). Kiểm tra đầy đủ trước khi merge:

```bash
pnpm lint && pnpm arch && pnpm typecheck && pnpm test && pnpm build && pnpm test:int && pnpm test:chaos && pnpm openapi:export && git diff --exit-code openapi.json
```

`openapi.json` được commit; sau khi đổi API chạy `pnpm build && pnpm openapi:export`.

## ADR

| ADR                                            | Nội dung                                         |
| ---------------------------------------------- | ------------------------------------------------ |
| [0001](docs/adr/0001-modular-monolith.md)      | Modular monolith                                 |
| [0002](docs/adr/0002-clone-and-upstream.md)    | Clone dự án và nhận cập nhật upstream            |
| [0003](docs/adr/0003-orm-mikro-orm.md)         | MikroORM, hai connection, migration có kiểm soát |
| [0004](docs/adr/0004-ports-and-adapters.md)    | Ports & adapters                                 |
| [0005](docs/adr/0005-multi-tenant-rls.md)      | Cô lập tenant bằng RLS fail-closed               |
| [0006](docs/adr/0006-queue-outbox.md)          | BullMQ, outbox giao dịch, inbox                  |
| [0007](docs/adr/0007-http-conventions.md)      | Quy ước HTTP, idempotency, rate limit            |
| [0009](docs/adr/0009-id-strategy.md)           | BIGINT nội bộ, UUIDv7 công khai                  |
| [0011](docs/adr/0011-cqrs-without-eventbus.md) | CQRS nhẹ, không dùng EventBus                    |
| [0012](docs/adr/0012-two-pagination-modes.md)  | Hai chế độ phân trang                            |
| [0013](docs/adr/0013-build-toolchain.md)       | Build toolchain, image và bảng số đo             |
| [0014](docs/adr/0014-observability.md)         | Observability, health, tắt êm                    |
| [0015](docs/adr/0015-cache-deferred.md)        | Cache: hoãn khỏi SP1                             |
| [0016](docs/adr/0016-outbound-http-ssrf.md)    | HTTP ra ngoài, chặn SSRF, mã hoá field           |
| [0017](docs/adr/0017-tenancy-own-module.md)    | Module tenancy tự xây + CASL                     |

[ADR 0010](docs/adr/0010-better-auth-and-auth-modes.md) ghi quyết định xác thực SP2; ADR 0008 (SePay) thuộc sub-project sau. Mục "Nguồn" của ADR có nhắc tới báo cáo task và ruling (R1–R25); các tài liệu này nằm ở workspace điều phối, không nằm trong repo.
