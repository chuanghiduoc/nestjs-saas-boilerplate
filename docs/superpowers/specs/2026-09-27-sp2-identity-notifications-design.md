# Sub-project 2 — Identity + thông báo email

- **Ngày:** 2026-09-27.
  - Sửa lần 1 cùng ngày theo review `.superpowers/sp2-spec-review.md` (3 Critical, 16 Important, 1 Minor) và phần bổ sung của Sếp về cookie.
  - Sửa lần 2 theo `.superpowers/sp2-spec-rereview.md`: refund lockout theo cửa sổ, marker bền của event, generation cho đối soát email, hợp đồng cookie, CSRF trước handler, cứng hoá quy tắc đa credential, đăng xuất hai credential, CHECK của lease, phạm vi thu hồi.
  - Sửa lần 3 theo luật chuẩn hoá dữ liệu mới của Sếp (spec cha §4): mục 3, mục 5.16 (bảng chuẩn hoá), `email_deliveries` đổi `sent_at`/`failed_at` thành `completed_at` và thêm các `CHECK`, grant `UPDATE` theo cột, test ở mục 8, rủi ro và follow-up SP1 ở mục 10.
- **Trạng thái:** Bản thiết kế chờ duyệt. Các quyết định D1–D10 đã được Sếp chốt và không bàn lại ở đây.
- **Spec cha:** `2026-09-24-saas-core-architecture-design.md`. Spec này chỉ đi sâu phần Identity, Notifications (kênh email) và Bull Board. Chỗ nào lệch spec cha thì ghi ở mục 11.2.
- **Nguồn version và API:**
  - `.superpowers/sp2-research.md` (2026-09-27).
  - Những điều research chưa có thì em đọc trực tiếp tarball hoặc `node_modules`, ghi bằng chứng ở **Phụ lục A** (trích theo mã `A.n`).
  - Chỉ những gì phải chạy code mới biết được mới nằm ở mục 4 (spike), và spike nào cũng có fallback.
- **Nền tảng:** code SP1 (`src/core/*`), ADR 0001–0007, 0009, 0011–0016, `.dependency-cruiser.cjs`.

---

## 1. Mục tiêu và tiêu chí hoàn thành

Sau sub-project này, dự án clone từ boilerplate có sẵn:
- đăng ký, đăng nhập, xác thực email, quên mật khẩu;
- 2FA;
- session cookie cho web, token cho mobile, API key cho máy, JWT cho dịch vụ khác;
- email giao dịch gửi qua queue.

Mọi tiêu chí dưới đây phải được chứng minh bằng test chạy trên hạ tầng thật (Postgres 18 + PgBouncer + Redis + Mailpit qua Testcontainers).

1. **Đăng ký → xác thực email → đăng nhập** chạy trọn qua HTTP. Email xác thực tới Mailpit, link có hiệu lực đúng một lần (S2-R52): click lại không đặt cookie, không tạo session, không đổi state và không reclaim. Token verification stateless có thể vẫn trả thành công để chịu mail scanner; confirmation đổi email replay được trong TTL, gửi thư dedupe theo S2-R68 (§5.8).
2. **Cookie là đường chính của web, không phải JWT.** Mỗi loại client dùng một cách truyền credential:

   | Client | `local` / `hybrid` | `external` |
   |---|---|---|
   | Web (trình duyệt) | Cookie session của Better Auth (`HttpOnly`, `Secure`, `SameSite` lấy từ config) | Cookie chứa token của IdP (do gateway/CRM đặt trên domain cha), hoặc `Authorization: Bearer` |
   | Mobile | `Authorization: Bearer <session token>` (plugin `bearer`) | `Authorization: Bearer <token IdP>` |
   | Máy (script, tích hợp) | Header API key (`@better-auth/api-key`) | Không hỗ trợ trong SP2 (service principal thuộc SP3) |
   | Dịch vụ khác cần verify danh tính | JWT do plugin `jwt` phát, verify qua JWKS công khai. API của mình **không** nhận JWT này | — |

3. **Principal được xác định trước guard rate limit của SP1.** Thứ tự kiểm tra là cookie session → bearer → API key. Request mang **nhiều hơn một** credential bị từ chối (`400 ambiguous_credentials`, mục 5.6). Throttler, idempotency và log đều thấy principal.
4. **CSRF:** mọi request thay đổi trạng thái được xác thực **bằng cookie**, ở mọi mode, mà `Origin` (hoặc `Sec-Fetch-Site` khi thiếu `Origin`) không thuộc danh sách origin tin cậy thì bị từ chối (`403 origin_not_allowed`). Request dùng bearer hoặc API key được miễn.
5. **`AUTH_MODE`** `local`, `hybrid`, `external` đều có test e2e.
   - Ở `external`, Better Auth không được khởi tạo.
   - Token (từ header hoặc cookie) được verify bằng `jose`: pin `issuer`, `audience`, `algorithms`; bắt buộc có `exp`, `iat`, `sub`; chỉ nhận token của user.
6. **Thu hồi, theo từng mode và loại credential** (không có cache session, D1):

   | Credential | Sự kiện | Hiệu lực |
   |---|---|---|
   | Cookie session, bearer session (`local`/`hybrid`) | Đăng xuất (kể cả khi gửi cả hai), đổi/đặt lại mật khẩu, admin ban hoặc xoá user | **Ngay** ở request kế tiếp |
   | API key | Xoá key, ban hoặc xoá user | **Ngay** |
   | API key | Đổi mật khẩu | Không thu hồi (credential máy do user quản lý) |
   | JWT do plugin `jwt` phát cho dịch vụ khác | Mọi sự kiện trên | Không lấy được JWT mới ngay. JWT đã phát còn hiệu lực tới `exp`, tối đa `AUTH_JWT_EXPIRES_IN_SEC` |
   | Token của IdP (`external`, cookie hoặc bearer) | Thu hồi ở IdP | API không thu hồi được. Còn hiệu lực tới `exp`, và bị chặn thêm bởi `AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC` nếu cấu hình |

7. **Redis sập thì auth vẫn chạy, với điều kiện Postgres hoạt động** (pool `auth_user`, bảng rate limit và lockout) (D1, D2, R21). Chỉ việc gửi email bị hoãn. Postgres lỗi thì đăng nhập trả `503` (tiêu chí 8).
8. **Rate limit đăng nhập fail-closed:** storage lỗi thì `/sign-in*` và `/two-factor*` trả `503` problem+json kèm `Retry-After`, không bao giờ `500`. Khoá theo tài khoản là **atomic** giữa các pod và không lộ email tồn tại.
9. **Không lộ email tồn tại** ở đăng ký, đổi email, quên mật khẩu, đăng nhập.
10. **Cô lập schema `auth`** (`auth_user`). Không role nào có quyền trên schema `public` qua `PUBLIC`. Test catalog RLS kiểm cả quyền trên schema.
11. **Token OAuth trong `auth.account`** được mã hoá bằng `FieldCipher`, với AAD dựng từ định danh bất biến. Mã dự phòng 2FA và private key JWKS cũng được mã hoá.
12. **Event `identity.user.registered`** không bao giờ mất và không bao giờ tới subscriber hai lần trong thời gian giữ lại của inbox. Cơ chế: marker bền nằm ngay trên dòng user, commit cùng lúc tạo user, nên không phụ thuộc thời điểm commit.
13. **Email** gửi theo state machine có lease sở hữu (fencing). At-least-once được bảo đảm **từ lúc dòng `email_deliveries` commit**. Job không bao giờ báo thành công khi email chưa ở trạng thái cuối. Trước mốc đó (S2-R75): thông báo bảo mật (2FA bật/tắt, và mọi thông báo đổi bảo mật sau này) có marker bền commit cùng thay đổi và cron gửi bù, nên không mất; thư người dùng tự yêu cầu lại được (xác thực, đặt lại mật khẩu, xác nhận đổi email) và thông báo chống dò email "tài khoản đã tồn tại" (lần đăng ký kế tiếp gửi lại, không phải thay đổi bảo mật) có thể mất trong cửa sổ giữa commit của auth và dòng `email_deliveries` (process chết, DB app lỗi). Rủi ro đó được chấp nhận, có log ERROR và metric `identity_auth_email_request_failed_total` (nên đặt alert khi > 0).
14. **Bull Board** trong worker: port nội bộ, read-only, chỉ platform admin (session, không nhận API key), không có PII.
15. **Quy ước HTTP của SP1 không hồi quy:** 413 (kể cả body chunked trên `/api/auth/*`), 415, 400, `rawBody`, merge-patch, CORS. Lỗi (4xx/5xx) của Better Auth ra ngoài dạng problem+json; redirect 3xx, `Location` và `Set-Cookie` giữ nguyên.
16. **Không lộ PII hay secret** trong log, lỗi job hay failed reason của BullMQ. Có test trên các đường lỗi.
17. Pipeline xanh như SP1, cộng kiểm tra lệch schema của Better Auth. Đo lại kích thước image và thời gian khởi động.

## 2. Phạm vi

**Đối chiếu thực thi Task 49:** giữ nhánh tự mount đã duyệt ở R36 của review trước thực thi (khác S2-R36 về map lỗi). Spike S1 xác nhận; xem ADR 0010.

**Trong phạm vi:**
- `src/modules/identity`:
  - Better Auth 1.7.6, **tự mount** bằng middleware Nest gọi `auth.handler(Request)` trong lớp bọc bắt lỗi, sau port `AuthProvider` (mục 5.5). Không dùng `@thallesp/nestjs-better-auth`: nó gọi handler bằng `next()` không await nên lỗi ở `onRequest` không fail-closed được (A.8b, ruling R36).
  - Tính năng: email/password, Google, xác thực email, quên mật khẩu, cookie session, bearer, 2FA (TOTP + mã dự phòng), API key, JWT/JWKS (có xoay khoá), `admin` (platform admin).
  - `AUTH_MODE`.
  - Middleware xác định principal, kiểm tra CSRF, guard, route `GET /v1/me`.
  - Rate limit và khoá tài khoản; map lỗi.
  - Event `identity.user.registered` kèm marker bền và cron đối soát; cron dọn dữ liệu hết hạn.
- `src/modules/notifications`, phần tối thiểu cho email của auth:
  - Bảng `email_deliveries`, queue `notifications`, job gửi email.
  - Cron đối soát email bị kẹt, cron dọn dữ liệu.
  - Transport nodemailer 10, renderer mjml 5 + handlebars 4.7.9.
  - 5 template (S2-R42): xác thực email (dùng cho cả đăng ký và đổi email), đặt lại mật khẩu, thông báo 2FA thay đổi, thông báo "email này đã có tài khoản", xác nhận đổi email gửi tới địa chỉ cũ (`change-email-confirmation`).
- Bull Board (`@bull-board/api` + `@bull-board/express` 9.10.1) trong `core/queue/dashboard`, chạy ở worker.
- Thay đổi tối thiểu ở `core/` (bảng ở mục 5.1).
- Role `auth_user`, schema `auth`, migration, Mailpit trong compose.
- ADR 0010; cập nhật ADR 0005, 0006, 0007, 0009, 0013, 0016; danh sách sửa spec cha.

**Ngoài phạm vi:**
- Organization, member, invitation, CASL, view membership có RLS; gắn API key hoặc service principal với danh sách org (SP3).
- Token máy (service principal) ở `external`. SP2 từ chối rõ ràng (mục 5.6.3).
- SAML và `@better-auth/sso`; entitlements; billing.
- Impersonation (D7: tắt).
- Đăng xuất phía IdP ở `external`. Đây là trách nhiệm của IdP; API không giữ session nên không có gì để thu hồi (README ghi rõ).

**Hoãn lại, có chủ sở hữu:**

| Việc | Chủ sở hữu | Lý do |
|---|---|---|
| Thông báo in-app, bảng `notifications` partition theo tháng (spec cha §4) | SP có use case in-app đầu tiên (dự kiến SP6) | SP2 chỉ cần email |
| `Preference` (tắt/bật loại thông báo) | như trên | Email của auth là giao dịch, không cho tắt |
| Template do tenant sửa (phải đổi sang engine có sandbox, research gợi ý `liquidjs`) | SP6 | Handlebars chỉ compile file trong repo |
| Locale theo user | SP6 | SP2 dùng locale mặc định từ config |
| SMS, push, webhook bounce | SP6 | |
| Khoá lockout tăng dần | Làm khi có số liệu tấn công thật | SP2 khoá cố định, có refund khi thành công |
| Job mã hoá lại `FieldCipher` khi xoay khoá (spec cha §11) | SP7 (runbook + job) | SP2 chỉ dùng keyring nhiều `kid`, giải mã được khoá cũ |
| Xoay `BETTER_AUTH_SECRET` không downtime | SP7 | Chưa có bằng chứng Better Auth hỗ trợ nhiều secret song song; SP2 ghi runbook xoay có downtime session |
| OpenAPI cho `/api/auth/*` | SP7 | README liệt kê route |

---

## 3. Quy trình bắt buộc

Giữ nguyên mục 3 của spec SP1. Riêng sub-project này:

- **Cài package:** `pnpm view <tên> dist-tags peerDependencies`, rồi `pnpm add <tên>` không ghi version. Version mong đợi ở mục 5.2. Lệnh cài ra version khác thì dừng lại, đọc changelog, cập nhật spec và báo Sếp.
- **Nhóm version:** `better-auth`, `auth`, `@better-auth/api-key` (và mọi `@better-auth/*` được phát hành theo nhịp của `better-auth`, như `core`, `kysely-adapter`) luôn cùng version.
  - **Ngoại lệ:** `@better-auth/utils` có nhịp phát hành riêng; `@better-auth/api-key@1.7.6` pin peer đúng `0.4.2` (research 1.2).
  - Pin `better-call` đúng `1.4.0` theo peer của nhóm.
  - Renovate gom `better-auth`, `auth`, `@better-auth/*` (trừ `utils`) vào một PR; `utils` và `better-call` đi theo peer.
- **Generator:**
  - `nest g …` cho module, service, controller, guard, middleware.
  - `mikro-orm migration:create --blank` cho migration.
  - `auth generate` cho schema Better Auth (D8).
  - `auth generate-secret` cho secret dev.
- **Không đoán API:** option nào chưa có trong research hay Phụ lục A thì đọc `.d.ts` trước khi dùng. TDD, không `any`, không tắt lint.
- **Chuẩn hoá dữ liệu (luật bắt buộc, spec cha §4):**
  - Mọi bảng tối thiểu 3NF, ưu tiên BCNF, để không có dị thường cập nhật và đổi yêu cầu thì sửa ít chỗ nhất.
  - Phi chuẩn hoá chỉ khi có lý do dựa trên bằng chứng (đường đọc nóng đã đo, snapshot audit/lịch sử bất biến, schema do thư viện sở hữu), và phải ghi cơ chế giữ nhất quán (trigger, outbox, constraint).
  - Enum là bảng lookup hoặc `TEXT` + `CHECK`, không phải chuỗi tự do. Thuộc tính đa trị nằm ở bảng con, trừ khi là tài liệu mờ.
  - Bảng chuẩn hoá của SP2 ở mục 5.16. Plan triển khai và mọi migration thêm cột hay bảng phải cập nhật bảng đó trước khi viết SQL.

---

## 4. Spike (bước đầu tiên, bắt buộc)

**Đối chiếu thực thi Task 49:** giữ nhánh tự mount đã duyệt ở R36 của review trước thực thi (khác S2-R36 về map lỗi). Spike S1 xác nhận; xem ADR 0010.

Chỉ gồm các câu hỏi phải chạy code mới trả lời được. Những gì đọc được từ source đã đưa vào Phụ lục A và thiết kế ở mục 5. Kết quả ghi vào ADR 0010, số đo vào ADR 0013.

| # | Câu hỏi | Tiêu chí đạt | Fallback |
|---|---|---|---|
| S1 | Tự mount + Nest 12 ESM (SWC, `nodenext`) + giới hạn body + guard + CLS trong hook + map lỗi: (a) thứ tự thật giữa middleware CLS của `ContextModule`, `ContentTypeMiddleware`, middleware mount `/api/auth/*` và `PrincipalMiddleware`; (b) CLS (`requestId`, `UnitOfWork`) có trong `hooks`, `databaseHooks` và callback gửi mail; (c) hình dạng lỗi ngoài endpoint: 429 của rate limit IP (`Response` + `X-Retry-After`) và `auth.handler` **reject** khi storage lỗi; (d) `ConditionalModule.registerWhen` của `@nestjs/config` 12.0.1 bỏ mount ở `external`; (e) tên cookie session thật khi có `cookiePrefix` và `useSecureCookies`; (f) cách lấy `Set-Cookie` từ `auth.api.signOut` (mục 5.6.4); (g) `raw-body` dừng body chunked vô hạn bằng `413` trong thời gian giới hạn; (h) `APP_GUARD` không chạy trên `/api/auth/*`, vẫn chạy trên route Nest; (i) lớp bọc: reject → `503` problem+json, `Response` lỗi → problem+json (giữ `Set-Cookie`, `Retry-After`), không unhandled rejection | Mọi test hồi quy HTTP của SP1 xanh. Hook thấy `requestId`. `413` sớm với body chunked. Mọi phản hồi lỗi của `/api/auth/*` là problem+json, còn 3xx và `Set-Cookie` giữ nguyên. Process không có unhandled rejection khi storage lỗi | Tự mount không đạt (b), (g), (h) hoặc (i): `@thallesp/nestjs-better-auth` 2.8.0 **kèm patch upstream** (await handler, chuyển reject cho `next(err)`) — cần Sếp quyết định, không tự áp. Ghi ADR 0010 |
| S2 | (a) Adapter Kysely chạy bằng `auth_user` trên schema `auth` với `CamelCasePlugin` và `transaction: true`, **dưới dạng DBAdapter được bọc** (mục 5.9, A.6), với schema chọn bằng `search_path` của role; (b) đi qua PgBouncer transaction mode, gồm cả **named prepared statement** mà `RateLimiterPostgres` dùng (A.9) với `max_prepared_statements` của PgBouncer 1.25 | Sign-up chạy trong transaction (lỗi giữa chừng không để lại dòng nào). Cột là snake_case. `auth_user` không chạm `public`. Lockout chạy qua PgBouncer | (a) Không bọc được adapter: dùng dạng `{ db, type, schemaName, transaction }` (research 1.3) và mã hoá token bằng plugin Kysely (`transformQuery`/`transformResult`) trên bảng `account`. (b) PgBouncer không chạy được prepared statement: pool `auth_user` đi thẳng Postgres (giống pool relay của SP1), ghi ADR và công thức connection |
| S3 | `auth generate` trên PG 18.6: (a) SQL sinh ra; (b) runtime `validateSchema` có chấp nhận các sửa đổi ở mục 5.3 không; (c) output khi schema đã khớp (cho kiểm tra lệch ở CI); (d) `auth create-admin` chạy với file config CLI | Migration up/down/up xanh. App không bị `validateSchema` chặn. Id mới là v7 (`uuid_extract_version(id) = 7`) | Phương án (B) của research 1.8 (`generateId` là function sinh v7, sửa `text` → `uuid`); ghi ADR 0009 |
| S4 | (a) Lỗi storage `database` của rate limit Better Auth (A.10: `consume` không có try/catch) đi tới lớp map lỗi kèm lỗi gốc (SQLSTATE, lỗi pool) không; (b) user id của lần đăng nhập đang chờ 2FA đọc được ở đâu trong hook `/two-factor/verify-*` (A.4: plugin xoá session và đặt cookie `two_factor`) | Thu hồi quyền ghi của `auth_user` trên bảng rate limit → `/sign-in/email` trả `503` problem+json kèm `Retry-After`. Khoá 2FA theo user | (a) `rateLimit.customStorage.consume` trên `RateLimiterPostgres` bọc try/catch, ném `APIError` 503; ghi ADR 0010 (lệch D2 ở điểm storage). (b) Khoá 2FA theo `sha256(giá trị cookie two_factor)`, cộng rule IP của Better Auth |
| S5 | Adapter bọc (A.6) có thấy **mọi** thao tác đọc/ghi bảng `account` mà Better Auth dùng (`create`, `update` theo `id`, `findOne`, `findMany`, và bản adapter trong `transaction`) không | Test refresh token, liên kết Google (provider giả lập), partial update: DB chỉ có bản mã, Better Auth đọc ra bản gốc | Plugin Kysely như fallback của S2a |
| S6 | mjml 5.4.1 (CJS) import từ ESM với API async và `validationLevel: 'strict'`; placeholder handlebars trong `href` còn nguyên sau khi compile; template vào `dist/` và image | Render đúng link; template lỗi làm worker không khởi động; có file trong image | Chạy handlebars trước rồi mjml cho mỗi email |
| S7 | Chống lộ email: A.5 xác nhận `hooks.before` trả được response để dừng sớm và sửa được `body`. Câu hỏi còn lại: đặt được status `202` cho response dừng sớm và cho response của nhánh email mới không | Status, header, body giống hệt nhau giữa email mới và email đã có | `disabledPaths: ['/sign-up/email', '/change-email']` (A.5) và route riêng `POST /v1/auth/sign-up`, `POST /v1/auth/change-email` gọi `auth.api.*` ở server |

---

## 5. Thiết kế thành phần

### 5.1 Vị trí module và thay đổi ở `core/`

**Đối chiếu thực thi Task 49:** giữ nhánh tự mount đã duyệt ở R36 của review trước thực thi (khác S2-R36 về map lỗi). Spike S1 xác nhận; xem ADR 0010.

```
src/modules/identity/
  index.ts · identity.module.ts · identity.config.ts · errors.ts · events.ts · jobs.ts
  ports/        auth-provider.ts · identity-directory.ts
  application/  registered-event.service.ts · reconcile-registered.handler.ts · purge-expired.handler.ts
                security-notice.service.ts · reconcile-security-notices.handler.ts (S2-R75)
  http/         principal.middleware.ts · origin-check.ts · auth.guard.ts · me.controller.ts · schemas.ts
  infra/better-auth/  auth-options.ts · auth-pool.ts · better-auth.provider.ts · auth-error.mapper.ts
                      auth-mount.middleware.ts · login-lockout.ts · account-cipher.adapter.ts
                      profile-mapper.ts · auth.cli-config.ts
  infra/jwks/         jwks.provider.ts
  infra/dashboard/    platform-admin.authorizer.ts
src/modules/notifications/
  index.ts · notifications.module.ts · notifications.config.ts · errors.ts · events.ts · jobs.ts
  domain/       email-delivery.ts                (state machine)
  ports/        email-notifications.ts · mail-transport.ts · template-renderer.ts · delivery-repository.ts
  application/  request-email.service.ts · send-email.handler.ts · reconcile-deliveries.handler.ts
                purge-deliveries.handler.ts
  infra/        nodemailer.transport.ts · smtp-error.ts · mjml-handlebars.renderer.ts · sql-delivery.repository.ts
  templates/<template-key>/<locale>/  subject.hbs · body.mjml · text.hbs
src/migrations/identity/ · src/migrations/notifications/
src/core/queue/dashboard/   queue-dashboard.server.ts · queue-dashboard.config.ts
```

- Identity gọi `EmailNotifications` export từ `notifications/index.ts`. Notifications không import identity.
- Mâu thuẫn `features/`/MikroORM (ADR 0004) không đụng tới ở đây.
- `app.modules.ts` của boilerplate bật sẵn cả hai module.

**Thay đổi ở `core/`.** Chỉ những gì module không tự làm được, vì `core` không import `modules`. Mỗi dòng có test riêng.

| Chỗ sửa | Thay đổi | Lý do |
|---|---|---|
| `core/context` | `Principal` giữ `{ type, id }`. Thêm `RequestContext.setCredential({ kind: 'SESSION_COOKIE' \| 'BEARER_SESSION' \| 'API_KEY' \| 'EXTERNAL_COOKIE' \| 'EXTERNAL_BEARER'; id?: string })` và `credential()`. Log `mixin()` ghi `credential.kind` và `credential.id` | API key: principal là user sở hữu, id của key nằm ở context cho log và audit |
| `core/http` | (1) `@PublicRoute()`. (2) Token `HTTP_BODY_PARSER_SKIP_PREFIX`: module khai báo prefix tự đọc body; `applyHttpDefaults` đăng ký parser của core cho mọi route trừ prefix đó. (3) `jsonBodyParser()`: parser JSON dùng `raw-body` với `limit` từ `httpConfig` (đếm byte thật, kể cả chunked; vượt thì `413` và đóng socket, không chờ hết body — body-parser/`express.json` chờ `end`), kiểm `Content-Type` (`415`), đặt `req.rawBody`, lỗi trả problem+json (`413`, `400`, `415`). (4) `writeProblem(res, appError)`: serialize problem+json dùng chung với `ProblemDetailsFilter` | Chỉ `core/http` được import `express`. Body của `/api/auth/*` phải có giới hạn ở tầng stream (mục 5.5) |
| `main.api.ts` | `NestFactory.create(…, { bodyParser: false })` | Parser của Nest (body-parser) chờ hết body khi vượt limit; core tự đăng ký `jsonBodyParser` |
| `core/health` | `@ReadinessContributor(key)` trên provider singleton có `probe()` (đối chiếu Task 49) | Pool `auth_user` thuộc identity |
| `core/outbox` | `OutboxWriter.append(e, { ifAbsent: true })` → `INSERT … ON CONFLICT DO NOTHING` (không có conflict target, nên `app_user` chỉ cần INSERT; có test grant) | Event id xác định trước (D10) |
| `core/resilience` | `HttpRequestInit.signal?: AbortSignal`, truyền xuống `undici.request` và kết hợp với timeout tổng. Export `toWebFetch(client, provider)`: hàm có chữ ký của `fetch` (`(url, { method, headers, signal, redirect })`) trả `Response` của Web (`new Response(body, { status, headers })`). `redirect` khác `manual` thì bị từ chối | Làm `customFetch` cho `jose` (mục 5.6.3). Timeout và huỷ của `jose` phải thật sự dừng request |
| `core/security` | `FieldCipher.isCiphertext(value)`: kiểm định dạng `v1.<kid>.<iv>.<ct>.<tag>` bằng regex chặt | Chống mã hoá hai lần (mục 5.9) |
| `core/logging` | `BASE_REDACT_PATHS` thêm `res.headers["set-auth-token"]`, `*.headers["set-auth-token"]`, `*.headers.cookie`, `*.*.headers.cookie`. `ERROR_PAYLOAD_DROP` thêm `response`, `rejected`, `rejectedErrors`, `envelope` (field lỗi của nodemailer, A.11) | Bearer của mobile nằm trong header `set-auth-token`; lỗi SMTP chứa địa chỉ email |
| `core/queue/dashboard` | Server Bull Board cùng port `QueueDashboardAuthorizer` (lớp trừu tượng, identity cài đặt) | `bullmq` chỉ dùng được trong `core/queue` |
| `test/.../rls-catalog.spec.ts` | Kiểm schema `auth`, `auth_user`, quyền trên schema và database (mục 5.3) | R20 |
| `.dependency-cruiser.cjs` | Luật ở mục 7 | |

### 5.2 Package

**Lệch khi thực thi (S2-R1/S2-R2, xem ADR 0010):** version là mức tối thiểu đã kiểm; nhận patch/minor mới qua minimumReleaseAge và kiểm changelog, major cần bằng chứng API. Các pin pg/kysely/peer Better Auth giữ nguyên. S1 xác nhận tự mount, 413 sau 73–81 ms; không dùng thallesp. Đây là số đo spike, không phải SLO.

| Package | Version | Vị trí dùng |
|---|---|---|
| `better-auth` | 1.7.6 | `identity/infra/better-auth` |
| `@better-auth/api-key` | 1.7.6 | như trên |
| `@better-auth/kysely-adapter` (dependency trực tiếp) | 1.7.6 | như trên (import `kyselyAdapter` để bọc, A.6) |
| `raw-body` (dependency trực tiếp) | 4.0.0 (S2-R1: ESM, Node ≥22, API đã kiểm ở spike S1) | `core/http` (`jsonBodyParser`) |
| `auth` (CLI, dev) | 1.7.6 | script `auth:generate`, `auth:create-admin` |
| `jose` | 6.2.12 | `identity/infra/jwks` |
| `kysely` (trực tiếp) | 0.29.6 (bản đang có trong cây) | `identity/infra/better-auth` |
| `pg` (chuyển từ dev sang dependency) | 8.23.0 (bản đang có) | pool `auth_user` |
| `express` (trực tiếp) | 5.2.1 | `core/http`, `core/queue/dashboard` |
| `nodemailer` | 10.0.10 (tự ship `.d.ts`) | `notifications/infra` |
| `mjml` / `@types/mjml` (dev) | 5.4.1 / 5.0.0 | như trên |
| `handlebars` | 4.7.9 | như trên |
| `@bull-board/api`, `@bull-board/express` | 9.10.1 | `core/queue/dashboard` |
| `uuid` | 14.0.2 (**đã là dependency**) | `v5` cho event id (A.1) |
| `rate-limiter-flexible` | 11.2.1 (đã có) | `RateLimiterPostgres` cho lockout (A.9) |
| Docker `axllent/mailpit` | v1.31.2 (pin theo digest) | compose, Testcontainers |

**Ghi chú thực thi (S2-R1/S2-R2, Task 1):** `@types/nodemailer` chỉ hiện diện bắc cầu qua `@types/smtp-server`. **Không cài trực tiếp:** `@bull-board/nestjs`, `@better-auth/redis-storage` (D1), `@better-auth/sso`, `@better-auth/cli` (deprecated), `@types/nodemailer`.

### 5.3 Postgres: schema `auth`, role `auth_user`, quyền, migration

**Script `docker/postgres/init/01-roles.sh`.** DBA production chạy cùng script này.

- **Siết quyền mặc định của `PUBLIC`:** `REVOKE ALL ON SCHEMA public FROM PUBLIC` (gồm cả `USAGE`, vì PG 15+ mặc định chỉ bỏ `CREATE`), rồi grant lại tường minh:
  - `GRANT USAGE, CREATE ON SCHEMA public TO app_owner`;
  - `GRANT USAGE ON SCHEMA public TO app_user, app_relay`.
- **Database:** `REVOKE CONNECT, TEMPORARY ON DATABASE :"db" FROM PUBLIC`.
  - `GRANT CONNECT` cho `app_owner`, `app_user`, `app_relay`, `auth_user`.
  - `GRANT TEMPORARY` chỉ cho `app_owner` (test catalog dùng bảng tạm).
- **Role mới:** `CREATE ROLE auth_user LOGIN PASSWORD :'auth_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`. Không có quyền gì trên `public`.
- **Schema `auth`:**
  - `CREATE SCHEMA auth AUTHORIZATION app_owner`. Tạo ở script init để `app_owner` không cần `CREATE` trên cả database; migration chỉ tạo và xoá bảng.
  - `REVOKE ALL ON SCHEMA auth FROM PUBLIC`.
  - `GRANT USAGE ON SCHEMA auth TO auth_user`.
- **Thiết lập cho `auth_user`:**
  - `ALTER ROLE auth_user SET search_path = auth`. Đây là **cơ chế chọn schema** của adapter bọc (mục 5.9), và cũng bảo đảm query không ghi schema (introspection của `validateSchema`, SQL của `RateLimiterPostgres`) không rơi vào `public`.
  - `ALTER ROLE auth_user SET statement_timeout`, `idle_in_transaction_session_timeout`, lấy từ env.

**Sinh schema (D8):**
1. `auth.cli-config.ts` export `betterAuth(buildAuthOptions(...))` với dependency giả, dạng database `{ db, type: 'postgres', schemaName: 'auth', transaction: true }` (research 1.3), vì CLI cần dialect chứ không cần lớp mã hoá.
2. `pnpm auth:generate` chạy `auth generate` trên Postgres dev mà schema `auth` còn trống.
3. `mikro-orm migration:create --blank --path src/migrations/identity --name better_auth_schema`, rồi dán SQL.
4. Sửa SQL. Mỗi sửa đổi có chú thích lý do:
   - `id` và FK kiểu `uuid DEFAULT uuidv7()` (D3); thời gian `timestamptz`.
   - `UNIQUE (provider_id, account_id)` trên `account`, đây là `UNIQUE(issuer, subject)` của spec cha §11. `UNIQUE (email)` trên `"user"`.
   - `apikey.reference_id` có FK tới `"user"(id) ON DELETE CASCADE`. Key thuộc hẳn về user (`references: 'user'`, A.7), nên xoá user thì key mất theo.
   - Index, mỗi index gắn với một query:
     - `session(user_id)`: thu hồi theo user;
     - `session(expires_at)`, `verification(expires_at)`: cron dọn;
     - `account(user_id)`, `verification(identifier)`, `apikey(reference_id)`;
     - `"user"(created_at) WHERE registered_event_emitted_at IS NULL`: cron đối soát event (mục 5.10).
   - Cột `"user".registered_event_emitted_at timestamptz NULL`. Better Auth không biết cột này; `validateSchema` chỉ chặn cột NOT NULL không có default (research 1.6), nên cột nullable không ảnh hưởng. Cột được insert là `NULL` cùng dòng user, trong transaction tạo user.   - Bảng `auth.login_attempts (key varchar(255) PRIMARY KEY, points integer NOT NULL DEFAULT 0, expire bigint)`, khớp DDL của `RateLimiterPostgres` (A.9), dùng `tableCreated: true`. Cộng index `(expire)` cho cron dọn.
   - Cột NOT NULL tự thêm đều có `DEFAULT`.
   - Đối chiếu output của S3 với bảng chuẩn hoá ở mục 5.16b; cột mới chưa có trong bảng thì bổ sung phân tích trước khi dán SQL.
   - Grant theo bảng: `SELECT, INSERT, UPDATE, DELETE` cho `auth_user`.
5. `down` xoá bảng theo thứ tự FK ngược. CI chạy up → down → up.

**Test catalog (R20)** mở rộng `rls-catalog.spec.ts`:
- Bảng trong `auth` nằm trong allowlist `AUTH_TABLES` (tên theo kết quả S3) và không có `org_id`.
- Với mỗi role `PUBLIC`, `app_user`, `app_relay`, `auth_user`, `app_owner`: kiểm `has_schema_privilege(role, 'public'|'auth', 'USAGE'|'CREATE')` và `has_database_privilege(role, db, 'TEMPORARY')` khớp đúng một bảng mong đợi.
- `auth_user` không có quyền trên bất kỳ bảng hay hàm nào ở `public`.
- `auth_user` NOBYPASSRLS.
- `GLOBAL_TABLES` thêm `email_deliveries`, kèm lý do.

**App đọc dữ liệu identity** chỉ qua port `IdentityDirectory` (`findUser(id)` → `{ id, email, name, emailVerified, role, banned, banExpires }`), chạy trên pool `auth_user`.

### 5.4 Instance Better Auth (`local`, `hybrid`)

`buildAuthOptions(cfg, deps)` là hàm thuần, có unit test theo từng mode.

**Nền:**
- `secret`, `baseURL` (tĩnh), `basePath`.
- `trustedOrigins`: mảng từ `HTTP_CORS_ORIGINS` cộng origin của `AUTH_BASE_URL`. Đây là **cùng danh sách** mà kiểm tra CSRF của route Nest dùng (mục 5.6.2).
- Không bật `advanced.trustedProxyHeaders`, `disableCSRFCheck`, `disableOriginCheck` (A.5).

**Database:** DBAdapter bọc (mục 5.9) trên pool `pg` riêng, `CamelCasePlugin`, `transaction: true`, `advanced.database.generateId: 'uuid'`. `validateSchema` giữ mặc định bật.

**Session và cookie** (cookie là cơ chế chính của web):
- Không `secondaryStorage`; `session.cookieCache` tắt (D1). `expiresIn`, `updateAge`, `freshAge` từ config.
- `advanced.useSecureCookies: AUTH_SECURE_COOKIES`, `advanced.cookiePrefix: AUTH_COOKIE_PREFIX`.
- `advanced.defaultCookieAttributes: { httpOnly: true, sameSite: AUTH_COOKIE_SAMESITE, path: '/' }`.
- `AUTH_COOKIE_DOMAIN` có giá trị thì `advanced.crossSubDomainCookies: { enabled: true, domain }` (A.2). Trống thì cookie chỉ gắn với host (không có thuộc tính `Domain`).

**Hợp đồng cookie của Better Auth, theo môi trường.** `NODE_ENV` chỉ có `development`, `test`, `production` (A.19), nên staging chạy `production` và chịu cùng luật production.

| Thuộc tính | `development` / `test` | `production` (gồm staging) |
|---|---|---|
| `HttpOnly` | luôn bật (code đặt cứng, không có config tắt) | luôn bật |
| `Secure` | `AUTH_SECURE_COOKIES`, mặc định `true`. Chỉ được `false` khi `AUTH_BASE_URL` là `http://localhost` hoặc `http://127.0.0.1` (luật mọi môi trường) | bắt buộc `true` (luật production); tên cookie có tiền tố `__Secure-` |
| `SameSite` | `AUTH_COOKIE_SAMESITE`, mặc định `lax` | như dev; `none` bắt buộc Secure |
| `Path` | `/` | `/` |
| `Domain` | không đặt (host-only) | không đặt, trừ khi đủ điều kiện chia sẻ domain cha bên dưới |

**Điều kiện chia sẻ domain cha** (`AUTH_COOKIE_DOMAIN` có giá trị). Cookie gắn domain cha được gửi tới **mọi** subdomain, nên chỉ được dùng khi mọi subdomain đều tin cậy. Config phải thoả cả ba điều kiện, nếu không app không khởi động:
1. `AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED=true`. Đây là xác nhận tường minh của người vận hành rằng không có subdomain nào do bên thứ ba hay nội dung người dùng kiểm soát.
2. Host của `AUTH_BASE_URL` và mọi origin trong `HTTP_CORS_ORIGINS` nằm dưới `AUTH_COOKIE_DOMAIN`.
3. `AUTH_COOKIE_DOMAIN` không phải public suffix hay một nhãn đơn (phải có ít nhất hai nhãn, không được là `localhost`).

**Cookie của `external`:** do gateway hoặc IdP đặt và xoá. **Bên phát cookie sở hữu các cờ của nó.** Hợp đồng ghi trong README và ADR 0010:
- `HttpOnly`, `Secure`, `SameSite=Lax` hoặc `Strict`, `Path=/`.
- `Domain` chỉ là domain cha mà mọi subdomain đều tin cậy (cùng điều kiện như trên).
- Giá trị là JWT nguyên văn; tên cookie khớp `AUTH_EXTERNAL_TOKEN_COOKIE`.
- API chỉ đọc cookie này, không bao giờ đặt hay xoá nó. Vì API không thấy cờ của cookie nhận vào, API không kiểm được chúng; phòng thủ phía API là kiểm CSRF (5.6.2) và verify token (5.6.3).

**Email/password:**
- `requireEmailVerification` từ config (mặc định `true`), `autoSignIn: false`.
- `minPasswordLength`, `maxPasswordLength` từ config.
- `sendResetPassword` gọi `EmailNotifications`; `revokeSessionsOnPasswordReset: true` (A.5).

**Xác thực email:** `emailVerification.sendVerificationEmail`, `sendOnSignUp: true`.

**Google và liên kết tài khoản** (fail-closed, A.3). Better Auth mặc định liên kết khi provider **được tin cậy HOẶC** gửi `email_verified=true`. Như vậy provider tin cậy vẫn được liên kết dù email chưa xác thực, nên mình không dùng `trustedProviders` của Better Auth:
- `account.accountLinking`:
  - `trustedProviders: []`;
  - `disableImplicitLinking` = `AUTH_TRUSTED_PROVIDERS` rỗng;
  - `allowDifferentEmails: false`;
  - `requireLocalEmailVerified` giữ mặc định `true`.
- `mapProfileToUser` của `socialProviders.google` và của `genericOAuth` (A.3 xác nhận `emailVerified` trả từ mapper ghi đè giá trị của provider) trả `emailVerified: AUTH_TRUSTED_PROVIDERS.includes(providerId) && profile.email_verified === true`. Thiếu claim, `false`, hay chuỗi `"true"` đều thành `false`.
- **Kết quả:**
  - Better Auth chỉ liên kết (cả ngầm lẫn qua `/link-social`) khi provider nằm trong danh sách **và** IdP gửi `email_verified === true` **và** user local đã xác thực email.
  - Provider không tin cậy vẫn đăng nhập được với user mới của nó, nhưng user đó `emailVerified=false` nên phải xác thực email trước khi dùng (S2-R76): với `AUTH_REQUIRE_EMAIL_VERIFICATION=true` (mặc định, production) session của nó bị `403 email_not_verified` ở mọi route Nest, và bất kể cờ, nó không mint được credential hay đổi danh tính trên auth mount (mục 5.6.4).
  - **Provider không tin cậy không bao giờ thành một cách đăng nhập dùng được** (S2-R48 + S2-R76). Cách duy nhất để user đó dùng được là chứng minh email qua luồng của mình (link xác thực, đặt lại mật khẩu); chính lần chứng minh đó reclaim (S2-R40/S2-R48): gỡ liên kết của provider cùng mọi session và API key. Sau đó provider không tin cậy không liên kết lại được (chỉ provider tin cậy có `email_verified === true` mới liên kết vào user đã xác thực), nên mọi lần đăng nhập qua nó trả `account_not_linked`. Muốn dùng một IdP để đăng nhập thì đưa nó vào `AUTH_TRUSTED_PROVIDERS` và IdP phải khẳng định `email_verified`.
- **Test:** provider không tin cậy + `email_verified=true`; provider tin cậy + claim thiếu; provider tin cậy + `false`; provider tin cậy + `true` + user local chưa xác thực. Chỉ trường hợp đủ điều kiện mới liên kết.

**Plugin:**
- `twoFactor`: `issuer` từ config; `backupCodeOptions.storeBackupCodes: 'encrypted'` (mặc định là `plain`, A.4). Secret TOTP luôn được plugin mã hoá bằng `secret` (A.4).
- `bearer`.
- `apiKey` (`@better-auth/api-key`):
  - `apiKeyHeaders: [AUTH_API_KEY_HEADER]`, `references: 'user'`;
  - `enableSessionForAPIKeys: false` (A.7), nên API key **không bao giờ** đóng vai session ở `/api/auth/*` (không vào admin, không tạo token);
  - hạn mặc định của key lấy từ config.
- `jwt`:
  - `issuer`, `audience`, thời hạn token (ngắn, từ config).
  - `jwks.rotationInterval: AUTH_JWKS_ROTATION_INTERVAL_SEC`, `jwks.gracePeriod: AUTH_JWKS_GRACE_PERIOD_SEC` (A.4: xoay khoá có sẵn), nên xoay JWKS được thiết kế ngay trong SP2.
  - `disablePrivateKeyEncryption` giữ mặc định `false`, tức private key được mã hoá.
- `admin`: `adminRoles: ['admin']`, `defaultRole: 'user'`. Impersonation tắt bằng `disabledPaths: ['/admin/impersonate-user', '/admin/stop-impersonating']` (D7, A.5).
- `genericOAuth`: chỉ ở `hybrid`, một provider từ config.

**IP:** `advanced.ipAddress.ipAddressHeaders: ['x-app-client-ip']` (A.5). Header do `auth-mount.middleware.ts` ghi từ `req.ip` (Express tính theo `HTTP_TRUST_PROXY`), sau khi xoá giá trị client gửi. Test: header giả bị ghi đè.

**Hook:**
- `hooks.before`:
  - kiểm độ mới của session (mục 5.6.4);
  - ép thu hồi khi đổi mật khẩu (mục 5.6.4);
  - lockout (mục 5.7);
  - chống lộ email (mục 5.8).
- `hooks.after`: hoàn điểm lockout khi thành công; thông báo 2FA.
- `databaseHooks.user.create.after`: event (mục 5.10).
- `databaseHooks.user.create.before`/`update.before`: chuẩn hoá email (`normalizeEmail`: trim, lower, NFC) và làm sạch tên (S2-R39) trên mọi đường ghi user, kể cả IdP/admin, để thoả `CHECK (email = lower(btrim(email)) AND email IS NFC NORMALIZED)` (DB final review M4); `update.before` của `/verify-email` còn chạy reclaim S2-R40.

**Logger:** logger của Better Auth trỏ về pino. Message đi qua bộ chuẩn hoá lỗi (mục 5.14), không log email hay token.

**Admin đầu tiên:** runbook `auth create-admin --email --password --role admin` (S3d).

### 5.5 Mount HTTP, body parser, CORS, map lỗi

**Mount (api):** `ConditionalModule.registerWhen(BetterAuthApiModule, AUTH_MODE !== 'external')`. Module này đăng ký `AuthMountMiddleware` (middleware Nest) cho `${AUTH_BASE_PATH}/{*path}`, mọi method. Middleware không bao giờ gọi `next()`: nó tự trả response, nên guard/interceptor của Nest không chạy trên `/api/auth/*` (không cần tương đương `disableGlobalAuthGuard`). CORS của `/api/auth/*` do `core/http` (`enableCors`) xử lý như mọi route.

**Lý do không dùng thallesp (một dòng):** thallesp 2.8.0 gọi handler bằng `next()` không await, nên lỗi ném ở `onRequest` của better-call (storage rate limit, `checkSchema`, nằm ngoài try/catch của router) thành unhandled rejection và không fail-closed được (A.8b).

**Không dùng `toNodeHandler`:** `toNodeHandler` của better-call không truyền `bodySizeLimit` (A.8) và tự ghi response, nên không giới hạn được body chunked và không map lỗi được. Middleware gọi `auth.handler(new Request(...))` trong `try { await … } catch` (lớp bọc bắt lỗi), sau port `AuthProvider`.

Identity cung cấp `HTTP_BODY_PARSER_SKIP_PREFIX = AUTH_BASE_PATH`. Worker dùng `IdentityModule.forWorker()` (pool, instance `betterAuth()`, cron), không mount HTTP.

**Giới hạn body của `/api/auth/*`:**
- Body phải được đọc **sau** khi kiểm credential và CSRF, nên core bỏ qua prefix auth và `AuthMountMiddleware` gọi lần lượt:
  1. Kiểm credential đa nguồn và dữ liệu vào trùng lặp (mục 5.6.1), trên header thô.
  2. Kiểm CSRF của mình (mục 5.6.2, phần `/api/auth/*`).
  3. Đọc body bằng cùng `jsonBodyParser` của `core/http` (`raw-body`): đếm byte thật, kể cả `Transfer-Encoding: chunked`; vượt giới hạn thì trả `413` problem+json sớm, dùng bounded linger thay vì đóng ngay (S2-R12/S2-R13/S2-R16/S2-R50, xem ghi chú dưới). Kiểm `Content-Type` theo allowlist (`415`), đặt `req.rawBody`, trả `400` khi JSON hỏng.
  4. Ghi header `x-app-client-ip`.
  5. `POST {basePath}/sign-out` do mình xử lý (mục 5.6.4), không chuyển cho handler.
  6. Còn lại: `try { response = await auth.handler(request) } catch { 503 problem+json + Retry-After }` (fail-closed, không unhandled rejection). `Response` ≥ 400 chưa phải problem+json thì map (mục dưới); ≥ 500 thì thăm dò pool auth để chọn `503` (DB không dùng được) hay `500` (S2-R45). **S2-R59/S2-R62/S2-R63:** riêng `/sign-in/*` và `/two-factor/*`, mọi 5xx đều ra 503 fail-closed, đồng thời log ERROR và tăng `identity_auth_endpoint_error_total`.
- Middleware dựng `Request` từ bytes đã đọc (`req.rawBody`), nên Better Auth nhận đúng body gốc.
- Bước 1 (đa credential và header trùng) và bước 2 (CSRF, vốn chỉ áp dụng cho method không an toàn) chạy với **mọi** method, kể cả GET và HEAD. Chỉ bước 3 (parse body) được bỏ qua với GET và HEAD.
- **Test:** body chunked vượt `HTTP_BODY_LIMIT` gửi tới `/api/auth/sign-in/email` → `413`, và kết nối không bị giữ.

**Lệch khi thực thi (S2-R12/S2-R13/S2-R16/S2-R50, xem ADR 0010):** `lingerIfBodyUnread` dùng chung trong core/http cho 413 và mọi phản hồi khi body chưa đọc (415, 400/403 sớm, GET/HEAD có body). Drain giới hạn bởi `HTTP_BODY_LIMIT_LINGER_MS` và `HTTP_BODY_LIMIT_LINGER_BYTES`; chạm cap thì dừng đọc, flush response rồi FIN, destroy tại deadline. Drain xong giữ keep-alive nếu được phép; client-close/server-draining thì đóng. Content-Length bảo đảm vượt cap được quyết định đóng trước header; giant chunked upload vượt cap sau header vẫn có residual FIN/reuse → RST. Không dùng express.json hay chờ hết upload mới trả 413.

**Map lỗi:**
- **Chỉ phản hồi 4xx/5xx** của `/api/auth/*` được đổi sang problem+json, trong lớp bọc của `AuthMountMiddleware` (gồm cả `Response` 429 của rate limit IP, vốn không đi qua hook; `X-Retry-After` → `Retry-After`).
- Phản hồi 2xx và **3xx** (redirect của OAuth) giữ nguyên status, `Location` và mọi `Set-Cookie`.
- Phản hồi lỗi vẫn giữ `Set-Cookie` mà Better Auth đặt (ví dụ xoá cookie).

**Mã lỗi mới** (`identity/errors.ts`):

| Key | Status | Dùng khi |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Sai email hoặc mật khẩu ở luồng đăng nhập công khai (một mã chung cho cả hai). Không dùng trên route đã xác thực: sai mật khẩu hiện tại (`/change-password`, xác minh lại mật khẩu) là `422 validation_failed` kèm `errors[].path` (`currentPassword` hoặc `password`); user đích không tồn tại ở route admin là `404 not_found`. Mapper nhận path endpoint từ lớp bọc mount |
| `INVALID_TWO_FACTOR_CODE` | 401 | Sai TOTP hoặc mã dự phòng |
| `EMAIL_NOT_VERIFIED` | 403 | Đúng mật khẩu, email chưa xác thực; session của user chưa xác thực trên route Nest khi `AUTH_REQUIRE_EMAIL_VERIFICATION=true`, và trên endpoint mint credential/đổi danh tính của auth mount bất kể cờ (S2-R76, mục 5.6.4) |
| `ACCOUNT_DISABLED` | 403 | User bị ban |
| `REAUTHENTICATION_REQUIRED` | 403 | Session quá `AUTH_SESSION_FRESH_AGE_SEC` cho thao tác nhạy cảm (gồm `SESSION_NOT_FRESH` và `SESSION_EXPIRED` của Better Auth) |
| `ORIGIN_NOT_ALLOWED` | 403 | Kiểm CSRF thất bại |
| `AMBIGUOUS_CREDENTIALS` | 400 | Request mang nhiều hơn một credential |
| `INVALID_OR_EXPIRED_TOKEN` | 400 | Token xác thực email hoặc đặt lại mật khẩu sai, hết hạn, đã dùng; token đổi email phát trước lần reclaim gần nhất của user (S2-R76) |
| `EMAIL_TAKEN` | 409 | Chỉ ở endpoint admin đã xác thực, không bao giờ ở luồng công khai |
| `API_KEY_NOT_ACCEPTED` → `api_key_not_accepted` | 400 | API key trên MỌI path của auth mount, gồm sign-out (S2-R50); từ chối ở bước 1, trước CSRF và trước khi đọc body (final review M1) |
| `OAUTH_SESSION_REVOKED` → `unauthenticated` | 401 | Fence phát hiện session OAuth bị reclaim; không đặt cookie (S2-R44, fix Task 34/39) |
| `validation_failed` | 422 | Input sai hoặc currentPassword sai trên route đã xác thực (S2-R36 đã hiệu chỉnh) |
| `commit_outcome_unknown` | 503 | COMMIT lỗi mà lỗi không chứng minh được rollback (chỉ SQLSTATE lớp 40/23/25 chứng minh; PgBouncer 08P01, mất kết nối, hết hạn đều là "không biết"); transaction có thể đã ghi. Không tự retry transaction. Idempotency-Key không lưu lỗi này: client thử lại với cùng key, và route phải ghi idempotent trong DB theo key đó; không có key thì kiểm tra trạng thái trước (S2-R70, final review I1/M3, ADR 0007) |

**Quy tắc map:**
1. Mã của Better Auth: lấy từ `BASE_ERROR_CODES` (export của `better-auth`) cộng `$ERROR_CODES` của từng plugin đang bật (`twoFactor`, `admin`, `genericOAuth`, `apiKey`; A.5). Unit test duyệt toàn bộ và fail nếu có mã chưa map.
2. Lỗi input (password, email) → `422 validation_failed` kèm `errors[].path`.
3. `429` → `rate_limited`, `Retry-After` lấy từ `X-Retry-After`.
4. Lỗi hạ tầng của pool auth (SQLSTATE lớp `08`, `53`, `57P01`–`57P03`, `57014`, `40001`/`40P01` hết lượt retry, timeout khi lấy connection) → `503 service_unavailable` + `Retry-After: AUTH_UNAVAILABLE_RETRY_AFTER_SEC`.
5. **S2-R36 (đã hiệu chỉnh 422):** mapper nhận pathname đã bỏ `AUTH_BASE_PATH` và query. Credential sai ở sign-in hoặc path chưa biết → `401 invalid_credentials`; sai mật khẩu hiện tại ở `/change-password` → `422 validation_failed`, field `currentPassword`; route xác minh lại mật khẩu dùng field `password`; admin `USER_NOT_FOUND` → `404 not_found`; `SESSION_EXPIRED` trên thao tác cần session mới → `403 reauthentication_required`. Sau quyết định theo route/mã mới fallback theo status core: 400 `malformed_request`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 422 `validation_failed`, khác thì `internal_error` (giữ cả mapping 405/413/415 của core).
6. `message` của Better Auth không bao giờ được chép sang `detail`, vì có thể chứa email.

**S2-R60/S2-R65/S2-R69/S2-R71:** lỗi auth DB query và checkout được ghi theo request, không lẫn request song song. Mount/provider đổi 500 mơ hồ hoặc mọi 4xx chưa phải problem+json (không chỉ 401, final review I2) kèm infra failure đã ghi thành 503 không Set-Cookie; 503 fail-closed của `/sign-in/*`, `/two-factor/*` cũng không mang Set-Cookie của response lỗi (final review M2); probe S2-R45 chỉ là fallback. Sign-up mà `createUser` lỗi và không có user (Better Auth trả 422 `FAILED_TO_CREATE_USER`): hook after trả 503 nếu lỗi hạ tầng đã ghi, còn lại 500, không bao giờ 422. Lỗi lập trình không giải thích được và DB không phải hạ tầng vẫn 500 rõ ràng. Core `isDbInfraError` dùng chung; identity thêm 40001/40P01 và cause walk. S2-R62/S2-R63 suppress SERVER_ERROR stderr dump, giữ safeErrorFields/SQLSTATE; client-input allowlist xuống WARN, API-key log chỉ hạ khi APIError status < 500.

### 5.6 Xác thực: `AuthProvider`, credential, CSRF, guard

#### 5.6.1 Credential và quy tắc đa nguồn

**Nhận diện credential** (chỉ những thứ sau mới tính):

| Kind | Mode | Nhận diện |
|---|---|---|
| `SESSION_COOKIE` | local, hybrid | Cookie session của Better Auth (tên theo `AUTH_COOKIE_PREFIX`, có hoặc không có tiền tố `__Secure-`; tên chính xác chốt ở S1e) |
| `BEARER_SESSION` | local, hybrid | `Authorization: Bearer …` |
| `API_KEY` | local, hybrid | Header `AUTH_API_KEY_HEADER` |
| `EXTERNAL_COOKIE` | external | Cookie `AUTH_EXTERNAL_TOKEN_COOKIE` (trống thì không nhận cookie) |
| `EXTERNAL_BEARER` | external | `Authorization: Bearer …` |

Cookie khác (cookie state của OAuth, cookie của ứng dụng) không được tính là credential. Cookie `two_factor` không phải credential, nhưng vẫn bị kiểm trùng lặp và CSRF.

**Thứ tự kiểm tra** là cookie session → bearer → API key. **Có nhiều hơn một** credential thì từ chối `400 ambiguous_credentials`, không chọn cái đầu tiên. Lý do:
- Trình duyệt tự gắn cookie. Một client định gọi bằng bearer của user B nhưng có cookie của user A sẽ bị âm thầm chạy dưới danh tính A nếu chọn theo thứ tự (confused deputy).
- Thư viện cũng chọn ngầm: plugin `bearer` ghi đè cookie session trong header bằng token bearer (A.14), còn `getSessionCookie` ưu tiên `__Secure-<tên>` hơn `<tên>` (A.16). Từ chối làm lỗi lộ ra ngay khi tích hợp và bỏ mọi thứ tự ngầm mà kẻ tấn công có thể khai thác.

**Dữ liệu vào trùng lặp bị từ chối trước mọi chuẩn hoá** (`400 ambiguous_credentials`). Kiểm trên `req.rawHeaders` chứ không trên `req.headers`, vì Node bỏ bản trùng của `authorization` và nối bản trùng của header khác (A.18):
- Nhiều hơn một header `Authorization`.
- Nhiều hơn một header `AUTH_API_KEY_HEADER`, hoặc một header có nhiều giá trị nối bằng dấu phẩy.
- Nhiều hơn một header `Cookie` chứa cookie được tính (Node nối các header `Cookie` bằng `; `).
- Cùng một tên cookie được tính xuất hiện hơn một lần (ví dụ hai cookie cùng tên ở hai scope `Path`/`Domain` khác nhau).
- Cả `__Secure-<tên>` lẫn `<tên>` của cookie session cùng có mặt.
- `Authorization` không đúng dạng `Bearer <token>` với token không rỗng.

Quy tắc áp dụng cho route Nest, cho `/api/auth/*` (bước 1 của `AuthMountMiddleware`) và cho Bull Board. Ở `external`, header và cookie cùng có mặt cũng bị từ chối như vậy.

**Ngoại lệ duy nhất:** `POST {basePath}/sign-out` nhận cùng lúc cookie session và bearer, và thu hồi **cả hai** (mục 5.6.4). Luật trùng lặp vẫn áp dụng cho nó.

**Validate tên cấu hình** (luật config, mọi môi trường; vi phạm thì app không khởi động):
- `AUTH_API_KEY_HEADER` khớp `^[a-z0-9-]{1,64}$` (chữ thường, là token hợp lệ của RFC 9110) và không thuộc tập dành riêng `{authorization, cookie, set-cookie, set-auth-token, host, origin, referer, x-app-client-ip, x-forwarded-for, x-forwarded-proto, x-forwarded-host, content-type, content-length, transfer-encoding}`.
- `AUTH_COOKIE_PREFIX` khớp `^[a-z0-9-]{1,32}$`. `AUTH_EXTERNAL_TOKEN_COOKIE` khớp `^[A-Za-z0-9_-]{1,64}$` và không bắt đầu bằng `__Secure-`/`__Host-`.
- `AUTH_EXTERNAL_TOKEN_COOKIE` không được trùng tên cookie mà Better Auth sinh ra từ `AUTH_COOKIE_PREFIX` (`<prefix>.session_token`, `<prefix>.two_factor`, …), phòng khi đổi mode mà giữ cookie cũ.

#### 5.6.2 CSRF cho mọi request xác thực bằng cookie

- **Áp dụng khi:** method không an toàn (`POST`, `PUT`, `PATCH`, `DELETE`) **và** credential là `SESSION_COOKIE` hoặc `EXTERNAL_COOKIE`, trên route Nest và Bull Board.
- **Luật:**
  - Có `Origin` → phải khớp **chính xác** một origin trong danh sách tin cậy (mục 5.4). Cùng site nhưng khác origin (subdomain khác) vẫn bị từ chối.
  - Không có `Origin` → `Sec-Fetch-Site` phải là `same-origin`.
  - Không có cả hai → từ chối.
  - Vi phạm → `403 origin_not_allowed`, không xác thực và không chạy handler.
- **Miễn:** bearer và API key, vì trình duyệt không tự gắn chúng.
- **`/api/auth/*`: kiểm của mình chạy trước handler** (bước 2 của `AuthMountMiddleware`), không chỉ dựa vào Better Auth. Lý do: kiểm tra có sẵn của Better Auth khác luật của mình ở ba điểm (A.13):
  - nó chấp nhận `Referer` khi thiếu `Origin`;
  - nó chấp nhận mẫu wildcard trong `trustedOrigins`;
  - nó chỉ chạy khi request có header `Cookie`, bất kể cookie gì.

  Luật của mình trên `/api/auth/*`:
  - Áp dụng cho method không an toàn khi request **thật sự mang** cookie session, cookie `two_factor` hoặc bất kỳ cookie nào có tiền tố `AUTH_COOKIE_PREFIX` (đọc từ header thô).
  - Cùng luật `Origin` chính xác / `Sec-Fetch-Site: same-origin` như trên.
  - Kiểm tra của Better Auth vẫn bật phía sau như lớp thứ hai, không tắt (`disableCSRFCheck`, `disableOriginCheck` giữ mặc định, A.2).
- **Luồng OAuth vẫn chạy:**
  - Google và `genericOAuth` đều dùng endpoint lõi `{basePath}/callback/:id` (A.13). Callback dạng GET không thuộc phạm vi kiểm.
  - Callback được bảo vệ bằng tham số `state`, lưu trong DB (`storeStateStrategy` mặc định là `database` khi có database, A.3) và so khớp ở callback.
  - Endpoint này cũng nhận POST `application/x-www-form-urlencoded` (`response_mode=form_post`) rồi redirect sang GET (A.13). SP2 không bật provider nào dùng `form_post`, và content-type đó đã bị allowlist chặn (`415`). Nếu sau này bật thì `POST {basePath}/callback/:id` được đưa vào danh sách miễn CSRF có tên, vẫn dựa vào `state`, và cần mở allowlist cho đúng route đó.
  - Bắt đầu đăng nhập OAuth (`POST /sign-in/social`) vẫn bị kiểm như mọi POST khác.
- **Ma trận test** (mục 8, dòng CSRF):

  | Request | Kết quả mong đợi |
  |---|---|
  | POST kèm cookie session, `Origin` tin cậy | qua |
  | POST kèm cookie session, không `Origin`, `Sec-Fetch-Site: same-origin` | qua |
  | POST kèm cookie session, không `Origin`, không `Sec-Fetch-Site` (chỉ có `Referer` tin cậy) | `403` (khác Better Auth, vốn chấp nhận `Referer`) |
  | POST kèm cookie session, `Origin` cross-site | `403` |
  | POST kèm cookie session, `Origin` cùng site khác origin (subdomain khác) | `403` |
  | POST kèm cookie session, `Sec-Fetch-Site: same-site` | `403` |
  | POST `/two-factor/verify-totp` chỉ kèm cookie `two_factor`, `Origin` cross-site | `403` |
  | POST kèm cookie session + bearer | `400 ambiguous_credentials` (trừ `/sign-out`: vẫn kiểm CSRF vì có cookie) |
  | POST chỉ bearer, `Origin` cross-site | qua CSRF (xác thực bình thường) |
  | `GET /callback/google?state=…&code=…` cross-site | qua CSRF; `state` sai → lỗi của Better Auth |
  | `external`: POST kèm cookie token, `Origin` cross-site | `403` |

  Mỗi dòng chạy trên cả route Nest và `/api/auth/*` nếu áp dụng được.

#### 5.6.3 Port và adapter

```ts
export type AuthResult =
  | { kind: 'ANONYMOUS' }
  | { kind: 'AUTHENTICATED'; principal: Principal; credential: Credential; isPlatformAdmin: boolean }
  | { kind: 'REJECTED' }       // credential sai, hết hạn, bị thu hồi, user bị ban/xoá, token máy
  | { kind: 'EMAIL_NOT_VERIFIED' } // S2-R76: session hợp lệ của user chưa xác thực email
  | { kind: 'UNAVAILABLE' };   // DB auth hoặc JWKS lỗi
export abstract class AuthProvider {
  abstract authenticate(input: { headers: Headers; credential: DetectedCredential }): Promise<AuthResult>;
}
```

`switch` vét cạn có kiểm tra `never`.

**`BetterAuthProvider`** (`local`, `hybrid`):
- **Cookie hoặc bearer** → `auth.api.getSession({ headers })` → `principal = { type: 'user', id: user.id }`. `isPlatformAdmin` là `user.role` (tách theo dấu phẩy) có đúng phần tử `admin`.
  - **S2-R76:** `AUTH_REQUIRE_EMAIL_VERIFICATION=true` (mặc định) và `user.emailVerified !== true` → `EMAIL_NOT_VERIFIED` (không principal, không chuyển cookie gia hạn).
  - Lần đăng nhập đang chờ 2FA **không có session**: plugin xoá session và chỉ đặt cookie `two_factor` (A.4). Credential đó vì vậy không qua được `getSession`: không lấy được bearer (`set-auth-token`), không gọi được `/token` (JWT), không tạo được API key, không qua được kiểm tra admin.
- **API key** → `auth.api.verifyApiKey` → `referenceId` là **user sở hữu** (A.7):
  - Nạp user qua `IdentityDirectory`. Không còn user, hoặc `banned` và (`banExpires` NULL hoặc còn trong tương lai) → `REJECTED`. Plugin api-key không tự kiểm ban (A.7).
  - **S2-R76:** `AUTH_REQUIRE_EMAIL_VERIFICATION=true` và chủ key chưa xác thực email → `REJECTED` (401).
  - Hợp lệ → `principal = { type: 'user', id: referenceId }`, `credential = { kind: 'API_KEY', id: <key id> }` (vào log và audit).
  - `isPlatformAdmin` luôn `false`.
- **Chính sách endpoint của API key:** API key được nhận ở mọi route Nest cho user (mặc định), **không** được ở Bull Board, `/api/auth/*` (`enableSessionForAPIKeys: false`) và route gắn `@SessionOnly()` (decorator của identity cho thao tác nhạy cảm, SP sau dùng).
- **Xoay API key:** user tạo key mới rồi xoá key cũ qua endpoint của plugin; key có hạn mặc định từ config. README ghi cách làm.
- **Đổi mật khẩu không thu hồi API key.** Đây là credential máy do user quản lý. Ban hoặc xoá user thì mọi key bị từ chối (kiểm tra runtime ở trên, cộng FK cascade).

**`JwksAuthProvider`** (`external`):
- **Resolver dùng chung:** một instance `createRemoteJWKSet(new URL(AUTH_EXTERNAL_JWKS_URL), { timeoutDuration, cooldownDuration, cacheMaxAge, [customFetch]: toWebFetch(httpClient, 'idp-jwks') })` cho cả process. `customFetch` đi qua `HttpClient` chặn SSRF. `signal` mà `jose` truyền vào được chuyển tiếp nên timeout thật sự huỷ request (thay đổi core ở mục 5.1). IdP nội bộ thì thêm dải vào `RESILIENCE_SSRF_ALLOW_CIDRS`.
- **Verify:**

  ```
  jwtVerify(token, jwks, {
    issuer, audience, algorithms, clockTolerance,
    requiredClaims: ['exp', 'iat', 'sub'],
    typ?, maxTokenAge?
  })
  ```

  `typ` và `maxTokenAge` là tuỳ chọn, lấy từ config. Token từ cookie hay từ header đều verify giống hệt nhau.
- **Hợp đồng claim** (kiểm sau khi verify chữ ký):
  - `sub` là chuỗi không rỗng, dài tối đa 255.
  - **Chỉ nhận token của user:** claim `AUTH_EXTERNAL_USER_CLAIM` phải **bằng chính xác** `AUTH_EXTERNAL_USER_CLAIM_VALUE` (ví dụ `idtyp=user` của Entra ID, hoặc một mapper `principal_type=user` của Keycloak). Cả hai biến bắt buộc ở `external`. Thiếu claim hoặc sai giá trị → `REJECTED`. Token máy bị từ chối tới khi SP3 định nghĩa service principal.
  - `algorithms` chỉ nhận RS/PS/ES/EdDSA; `none` và `HS*` bị config từ chối. Không đi theo `jku`/`x5u` (research 6).
- **Admin:** claim `AUTH_EXTERNAL_ADMIN_CLAIM` là chuỗi bằng chính xác `AUTH_EXTERNAL_ADMIN_VALUE`, hoặc là mảng chuỗi chứa đúng phần tử đó. Không so chuỗi con, không đổi hoa thường. Không cấu hình thì không ai là admin.
- **Principal:** `{ type: 'user', id: sub }`, credential `EXTERNAL_COOKIE` hoặc `EXTERNAL_BEARER`.
- **Test:** thiếu `exp`, thiếu `iat`, thiếu `sub`, `sub` rỗng, sai `iss`, sai `aud`, `alg` ngoài danh sách, `alg: none`, token máy, admin khớp một phần (`admins` so với `admin`), `kid` lạ, `jku` bị bỏ qua, JWKS chậm vượt timeout thì request bị huỷ.

#### 5.6.4 Middleware, guard, thao tác nhạy cảm, thu hồi

**`PrincipalMiddleware`** (mọi route Nest):
1. Nhận diện credential (5.6.1). Không có → `ANONYMOUS`, không chạm DB (health không đụng pool auth).
2. Kiểm CSRF (5.6.2).
3. Gọi `authenticate`.
4. `AUTHENTICATED` → `ctx.setPrincipal`, `ctx.setCredential`.

Kết quả giữ trong CLS. Đặt ở middleware vì ADR 0007 yêu cầu principal có trước `AppThrottlerGuard`, mà thứ tự giữa các `APP_GUARD` của các module khác nhau không được bảo đảm.

**`AuthGuard`** (`APP_GUARD`, mặc định chặn):
- `@PublicRoute()` → qua.
- `AUTHENTICATED` → qua.
- `ANONYMOUS`/`REJECTED` → `401 unauthenticated`.
- `EMAIL_NOT_VERIFIED` → `403 email_not_verified` (mọi route, kể cả `@PublicRoute()`, như `REJECTED`).
- `UNAVAILABLE` → `503` + `Retry-After`.

**User chưa xác thực email (S2-R76), bất kể `AUTH_REQUIRE_EMAIL_VERIFICATION`:** `hooks.before` trả `403 email_not_verified`, trước kiểm độ mới, cho session chưa xác thực trên mọi endpoint mint credential hoặc đổi danh tính: `/update-user`, `/change-password`, `/delete-user`, `/change-email`, `/link-social`, `/unlink-account`, `/get-access-token`, `/refresh-token`, `/token`, `/api-key/create`, `/api-key/update`, `/two-factor/*`, `/admin/*`. Vẫn mở: `/send-verification-email`, `/verify-email`, `/sign-out`, `/get-session`, các luồng công khai và endpoint chỉ đọc hoặc thu hẹp quyền. Danh sách đầy đủ và dòng dist 1.7.6 ở `auth-hooks.ts`; test drift duyệt `auth.api`. Nhánh đổi email một bước của Better Auth cho user chưa xác thực vì vậy không còn. Reclaim (S2-R40) xoá thêm mọi API key của user chưa xác thực và ghi marker `auth.user_reclaim`; `/verify-email` từ chối (`400 invalid_or_expired_token`) token có `updateTo` với `iat` trước giây của lần reclaim gần nhất.

**Thao tác nhạy cảm cần session mới:** `hooks.before` của `/change-password`, `/change-email`, `/two-factor/enable`, `/two-factor/disable`, `/api-key/create` kiểm `session.createdAt` không cũ hơn `AUTH_SESSION_FRESH_AGE_SEC`, nếu không trả `403 reauthentication_required`. Tự kiểm vì `sensitiveSessionMiddleware` của Better Auth không kiểm độ mới (A.5).

**Thu hồi:**
- **Đổi mật khẩu:** `hooks.before` của `/change-password` trả `{ context: { body: { ...body, revokeOtherSessions: true } } }` (A.5: hook trước sửa được context). Nhờ vậy client không tắt được việc thu hồi. Better Auth xoá mọi session rồi tạo session mới cho request hiện tại (A.5).
- **Đặt lại mật khẩu:** `revokeSessionsOnPasswordReset: true`.
- **Bearer của mobile** là token session, nên bị thu hồi cùng lúc.
- **JWT của plugin `jwt`** chỉ lấy được bằng session hợp lệ (`/token`), nên session bị thu hồi thì không lấy được JWT mới. JWT đã phát còn hiệu lực tới `exp` (tối đa `AUTH_JWT_EXPIRES_IN_SEC`, mặc định ngắn). Đây là giới hạn đã biết của JWT không trạng thái, ghi vào ADR 0010.
- **Phạm vi thu hồi** theo mode và loại credential: bảng ở tiêu chí 6, mục 1.
- **Đăng xuất (`POST {basePath}/sign-out`)** do `AuthMountMiddleware` xử lý, không chuyển nguyên cho handler. Lý do:
  - Khi có cả cookie lẫn bearer, plugin `bearer` ghi đè cookie trong header bằng token bearer (A.14), nên handler gốc chỉ xoá session của bearer, session của cookie vẫn sống.
  - Handler gốc nuốt lỗi khi xoá session ở DB: chỉ log rồi vẫn trả thành công (A.15).

  Các bước:
  1. Luật trùng lặp (5.6.1). Có cookie thì kiểm CSRF (5.6.2), kể cả khi cũng có bearer.
  2. Với **mỗi** credential có mặt (cookie session và/hoặc bearer), gọi `auth.api.signOut` với bộ header **chỉ chứa credential đó**.
  3. Kiểm lại: `auth.api.getSession` với từng bộ header phải trả `null`. Còn session nào sống (xoá ở DB lỗi) thì trả `503 service_unavailable` + `Retry-After`, không bao giờ báo thành công.
  4. **S2-R50:** response `200` sau khi kiểm thu hồi thành công. Cookie được chuyển về tên đang cấu hình khi gọi signOut/getSession; trả Set-Cookie hết hạn cùng Path/Domain. Nếu request dùng biến thể tên còn lại (`__Secure-` hoặc không), hết hạn cả hai biến thể. Bearer-only không trả cookie; không credential vẫn gọi signOut để xoá cookie phụ và trả 200 idempotent, nên vẫn có thể có Set-Cookie. API-key-only trả `400 api_key_not_accepted`; session còn sống hoặc lỗi storage → 503.
  5. Cách lấy header trả về của `auth.api.signOut` chốt ở S1f. Fallback: tự phát `Set-Cookie` hết hạn với tên, `Path=/` và `Domain` lấy từ config (mục 5.4).
- **Đăng xuất ở `external`:** API không giữ session và không đặt cookie, nên không có endpoint đăng xuất. Hợp đồng với gateway/IdP (README, ADR 0010):
  - Bên đã phát cookie xoá nó bằng đúng tên, `Path` và `Domain`.
  - IdP thu hồi refresh token hoặc session của nó.
  - Access token đã phát còn hiệu lực tới `exp`, nên IdP nên đặt TTL ngắn. API có thể chặn thêm bằng `AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC`.

**`GET /v1/me`:** trả `{ id, email, name, emailVerified, role: 'USER' | 'ADMIN', twoFactorEnabled, createdAt, updatedAt }`. Có ở `local` và `hybrid`; gọi bằng API key thì trả thông tin của user sở hữu key.

**Bảng chế độ:**

| | `local` | `hybrid` | `external` |
|---|---|---|---|
| Better Auth, `/api/auth/*`, pool `auth_user` | có | có | không |
| Web | cookie session | cookie session | cookie token IdP hoặc bearer |
| Mobile / máy | bearer session / API key | như `local` | bearer token IdP / không |
| CSRF cho cookie | có | có | có |
| Readiness DB auth | có | có | không |

### 5.7 Rate limit và khoá tài khoản (D2)

**Lớp 1, Better Auth `rateLimit` theo IP + path:**
- `enabled: AUTH_RATE_LIMIT_ENABLED` (production bắt buộc `true`).
- `storage: 'database'`.
- `customRules` cho `/sign-in/*`, `/sign-up/*`, `/two-factor/*`, `/request-password-reset`, `/send-verification-email`, mỗi nhóm có window/max lấy từ config.

**Lớp 2, khoá theo tài khoản, atomic:**
- Hai `RateLimiterPostgres` trên pool `auth_user`, cùng bảng `auth.login_attempts` (`schemaName: 'auth'`, `tableCreated: true`), khác `keyPrefix`:
  - `attempts`: `points: AUTH_LOCKOUT_MAX_FAILURES`, `duration: AUTH_LOCKOUT_WINDOW_SEC`, không `blockDuration`.
  - `blocks`: dùng `block(key, AUTH_LOCKOUT_BLOCK_SEC)` và `get(key)` (A.17).
  - **Không** bật chặn trong bộ nhớ của pod.
- **Khoá có số hiệu cửa sổ** (đây là cơ chế làm cho refund **không thể** chạm sang cửa sổ khác):
  - `w = floor(Date.now() / (AUTH_LOCKOUT_WINDOW_SEC × 1000))`, tính **một lần** cho mỗi request.
  - Khoá lần thử: `signin:<sha256(email chuẩn hoá)>:w<w>`; với 2FA là `2fa:<user id>:w<w>` (hoặc fallback của S4b). Khoá khoá tài khoản không có `w`: `signin:<hash>`, `2fa:<user id>`.
  - Email được băm bất kể có tồn tại hay không.
- **Luồng:**
  1. `hooks.before`: `blocks.get(accountKey)` đang bị chặn → `429 rate_limited` + `Retry-After` (từ `msBeforeNext`), không xác minh.
  2. **`attempts.consume(attemptKey)` trước khi xác minh.** Đây là một câu `INSERT … ON CONFLICT (key) DO UPDATE SET points = points + 1 … RETURNING` (A.9): atomic dưới row lock của Postgres, nên N request song song ở mọi pod đều được đếm đủ N.
  3. Vượt ngân sách → `blocks.block(accountKey, AUTH_LOCKOUT_BLOCK_SEC)` rồi `429`, không xác minh.
  4. `hooks.after` khi **thành công**: `attempts.reward(attemptKey, 1)` với **đúng khoá đã consume** (giữ trong context của request, không tính lại `w`). Thất bại thì giữ nguyên điểm.
- **Vì sao refund không tràn sang cửa sổ khác:**
  - Khoá mang số hiệu `w`, nên refund chỉ đụng được dòng của cửa sổ đã consume.
  - Dòng đó được tạo trong cửa sổ `[w·W, (w+1)·W)` với `expire = lúc tạo + W ≥ (w+1)·W`, nên không bị đặt lại giữa chừng trong chính cửa sổ của nó.
  - Refund tới muộn sau khi dòng hết hạn thì nhánh "hết hạn" của upsert ghi `points = -1` vào dòng của cửa sổ **cũ** (A.9, A.17). Dòng đó không bao giờ được consume lại vì cửa sổ mới có khoá khác, và cron `identity.purge-expired` sẽ xoá nó.
  - Không dùng `delete`, vì nó xoá cả các lần thất bại song song.
- **Cái giá của cửa sổ cố định:** ở ranh giới hai cửa sổ, kẻ tấn công có tối đa `2 × AUTH_LOCKOUT_MAX_FAILURES` lần thử trước khi bị khoá. Chấp nhận, đã tính khi chọn giá trị mặc định; lớp 1 theo IP vẫn áp dụng.
- **Nhiều pod:** trạng thái chỉ nằm trong Postgres. `w` và `expire` tính bằng `Date.now()` của pod (A.9), nên lệch đồng hồ giữa pod (NTP, dưới 1 giây) chỉ làm ranh giới cửa sổ lệch tương ứng. Ghi ADR 0010.
- **Test:**
  - `MAX + k` request sai song song từ 2 instance → đúng `k` bị `429` mà không xác minh, và tài khoản bị khoá `AUTH_LOCKOUT_BLOCK_SEC`.
  - Đăng nhập đúng xen giữa các lần sai không xoá các lần sai khác.
  - **Refund muộn:** giữ request thành công qua ranh giới cửa sổ (đồng hồ giả), rồi `reward` → số điểm của cửa sổ mới không đổi.
  - Email không tồn tại bị khoá giống email tồn tại.

**Fail-closed:** lỗi storage ở lớp 1 (S4a) hoặc lớp 2 → `503 service_unavailable` + `Retry-After`, không bao giờ cho qua.

**Không phụ thuộc Redis, nhưng phụ thuộc Postgres:** cả hai lớp nằm trên pool `auth_user`, nên Postgres lỗi thì đăng nhập trả `503` (fail-closed). `rate-limiter-flexible` được phép import trong `identity/infra/better-auth/**` (luật 14).

### 5.8 Luồng công khai không lộ email tồn tại

| Luồng | Email mới hoặc hợp lệ | Email đã có hoặc không tồn tại | Bảo đảm |
|---|---|---|---|
| Đăng ký | Tạo user, gửi email xác thực, `202` body rỗng | Không tạo user; gửi thông báo "đã có tài khoản"; chạy một lần hash giả; `202` body rỗng | Status, header, body giống hệt nhau, không `Set-Cookie`. Cơ chế: `hooks.before` dừng sớm (A.5) cộng S7 |
| Đăng ký song song cùng email | — | `UNIQUE(email)` → `23505` → xử lý như email đã có | Constraint, không check-then-insert |
| Đổi email, user đã xác thực (S2-R42/S2-R66) | Confirmation tới địa chỉ cũ, `202`; click gửi verification tới địa chỉ mới | Cùng confirmation tới địa chỉ cũ, `202`; click chỉ gửi existing-account tới chủ đích | Quyết định gửi thư tới đích ở click, response giống nhau |
| Quên mật khẩu / gửi lại email xác thực | Gửi | Không gửi | Cùng phản hồi |
| Đăng nhập | — | Sai email hay sai mật khẩu đều `401 invalid_credentials` | Test so sánh; `hooks.before` chạy hash giả khi không có user nếu Better Auth không tự làm |

**S2-R42/S2-R66/S2-R68:** user đã xác thực phải có session mới; luôn gửi template `change-email-confirmation` tới địa chỉ cũ, sau click mới phân nhánh theo địa chỉ đích. User chưa xác thực không đổi được email (S2-R76, `403 email_not_verified`). GET `/verify-email` cùng bốn POST `/sign-up/email`, `/request-password-reset`, `/change-email`, `/send-verification-email` (final review M3) được đệm từ lúc vào mount tới floor cho phản hồi handler, cả redirect/lỗi; quá floor ghi metric/WARN. `/sign-up/email`, `/request-password-reset` và `/change-email` dùng `AUTH_EMAIL_RATE_MAX=3` / `AUTH_EMAIL_RATE_WINDOW_SEC=300` theo IP. `/verify-email` có luật riêng, `AUTH_VERIFY_EMAIL_RATE_MAX=20` / `AUTH_VERIFY_EMAIL_RATE_WINDOW_SEC=300` (S2-R68 follow-up): rộng hơn vì mỗi token chỉ gửi tối đa một thư (dedupe), nhưng production không cho rộng hơn mức chung `/api/auth/*` (`AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_SEC`, rule `identity-verify-email-rate`, so bằng phép nhân chéo). Vẫn còn rủi ro NAT: user chung IP có thể 429 lẫn nhau.

Idempotency key của email sau confirmation click dẫn xuất từ token gốc, mỗi nhánh một email; trạng thái đăng ký đích đổi có thể tạo hai thư. `AUTH_SESSION_UPDATE_AGE_SEC` ≥ `AUTH_SESSION_FRESH_AGE_SEC` là luật config để không lộ nhánh qua Set-Cookie. M1: JWT lộ `updateTo` cho người đọc hộp thư cũ; M6: token gắn email, không user id, tái đăng ký địa chỉ cũ trong `AUTH_EMAIL_TOKEN_TTL_SEC` (86400 mặc định) còn rủi ro. M5: dev DB chạy CHECK template cũ phải reset/migrate vì sửa migration tại chỗ. M7: thư địa chỉ mới vẫn là `verify-email` chung, reclaim giữ credential; xem residual b′ ở ADR 0010.

**Chống spam thông báo:** idempotency key `existing-account:<user id>:<floor(now / AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC)>` có `UNIQUE`, nên tối đa một thư mỗi cửa sổ.

`202` của các luồng này không có resource operation (sửa spec cha, mục 11.2).

### 5.9 Mã hoá token trong `auth.account` (D4)

**Cơ chế: bọc DBAdapter.**
- `database: (opts) => withAccountCipher(kyselyAdapter(db, { type: 'postgres', transaction: true })(opts), cipher)`.
- Better Auth nhận một `DBAdapterInstance` (A.6). `db` là `new Kysely({ dialect: new PostgresDialect({ pool: authPool }), plugins: [new CamelCasePlugin()] })`.
- **Không dùng `databaseHooks` để mã hoá:** `account.update.before` chỉ nhận phần dữ liệu cập nhật, không có `where` hay `id` của dòng (A.6), nên không dựng được AAD theo dòng.
- **Lệch khi thực thi (S5/S2-R7, xem ADR 0010):** lớp bọc can thiệp model `account` và account đọc qua join của user; bọc cả adapter trả về từ `transaction(cb)`:

| Thao tác | Hành vi |
|---|---|
| `create` | Dữ liệu có `providerId`, `accountId` → mã hoá `accessToken`, `refreshToken`, `idToken` |
| `update` / `updateMany` | S5/S2-R7: không chạm token hay định danh thì cho qua (kể cả updateMany mật khẩu); chạm token hoặc providerId/accountId bắt buộc đúng một `where id`, đọc dòng cùng transaction để dựng AAD. `providerId`/`accountId` trùng được giữ, thay giá trị thì ném lỗi. Không checkout thêm connection trong transaction |
| `findOne` / `findMany` | S5/S2-R7: giải mã token theo định danh của dòng, cả account lồng trong join user. Getter lỗi không enumerable để list-accounts không đọc token; đường thực sự cần token vẫn lỗi |

- **AAD** là `auth.account:<cột>:-:<providerId>/<accountId>`. Hai định danh này bất biến và có `UNIQUE`; `-` vì bảng không thuộc org. Không dùng PK vì `id` do DB sinh (`uuidv7()`) nên chưa có lúc `create`. Đây là sửa spec cha, mục 11.2.
- **Chống mã hoá hai lần:** giá trị đã thoả `FieldCipher.isCiphertext` thì không mã hoá lại. Token OAuth thật không có dạng `v1.<kid>.<b64url>.<b64url>.<b64url>`. Giá trị trong DB không phải bản mã thì lúc đọc ném `FieldCipherError` (fail loud, không trả plaintext lẫn lộn).
- **Test:**
  - `create` → DB có bản mã;
  - xoay refresh token (update chỉ có `refreshToken` + `where id`) → đọc dòng và mã hoá đúng AAD;
  - partial update không có token → không đọc thêm;
  - update đổi `accountId` → lỗi;
  - chép bản mã sang dòng khác → giải mã lỗi;
  - update hai lần liên tiếp → không bị mã hoá kép.
- **Secret khác do Better Auth giữ:** secret TOTP (plugin luôn mã hoá), mã dự phòng (`storeBackupCodes: 'encrypted'`) và private key JWKS (mặc định mã hoá), đều bằng `BETTER_AUTH_SECRET` (A.4). Token session lưu dạng gốc (rủi ro, mục 10).
- **Xoay khoá `FieldCipher` (carry-forward Task 28/49, S2-R7):** keyring nhiều `kid` giải mã khoá cũ; bắt buộc re-encrypt mọi row còn cần đọc trước khi retire kid. Job mã hoá lại hoãn SP7; `/get-access-token` có thể che missing kid thành 400.

### 5.10 Event `identity.user.registered` (D10)

- **Định nghĩa:** `defineEvent({ type: 'identity.user.registered', version: 1, schema: z.object({ userId: z.uuid() }) })`. Payload không có email. `orgId: null`, actor `user`.
- **Event id xác định trước:** `v5(name, namespace)` của package `uuid` 14.0.2 (đã là dependency). Chữ ký thật là `v5(value, namespace)` (A.1). Node không có hàm sinh UUIDv5 (A.1).
  - `IDENTITY_EVENT_NAMESPACE = '87857401-f233-5789-839c-2dc5fb919229'`, tức `v5('nestjs-saas-boilerplate/identity-events', v5.URL)`, được ghi thành hằng số.
  - `eventId = v5('identity.user.registered:' + userId, IDENTITY_EVENT_NAMESPACE)`.
  - **Test vector cố định:** userId `019dd1a5-9235-70db-8d57-54ef901d8185` → `59f229d2-931e-5ad8-8c7c-5ee7dbfd34e4`.
  - Đây là ngoại lệ của "event id là v7" (ADR 0009).
- **Marker bền trên dòng user.** Đây là cơ chế chính, thay cho checkpoint theo thời gian của bản trước. Checkpoint theo `created_at` luôn có thể bỏ sót dòng commit muộn, vì tuổi transaction không bị giới hạn thật: `statement_timeout` giới hạn từng câu, `idle_in_transaction_session_timeout` giới hạn từng khoảng rảnh, nhưng tổng của một transaction gồm nhiều câu thì không bị chặn.
  - Cột `auth."user".registered_event_emitted_at` (nullable, mục 5.3) nằm **trong chính dòng user**. Nó mang giá trị `NULL` ngay trong transaction Better Auth tạo user, nên ngay khi user tồn tại (đã commit), sổ "chưa phát event" cũng tồn tại. Không phụ thuộc thời điểm commit hay lệch đồng hồ.
  - Ghi event nằm trên pool app, còn marker nằm trên pool auth. Hai pool riêng nên không gộp được vào một transaction (D10). Thứ tự luôn là: ghi outbox (commit) **rồi** đặt marker. Crash giữa hai bước chỉ dẫn tới ghi lại cùng event id, và `ifAbsent` chặn trùng.
- **After-hook** (`databaseHooks.user.create.after`, chạy sau commit của auth):
  1. `uow.run(() => outbox.append(event, { ifAbsent: true }))`.
  2. `UPDATE auth."user" SET registered_event_emitted_at = now() WHERE id = $1 AND registered_event_emitted_at IS NULL` qua pool auth.

  Lỗi ở bất kỳ bước nào thì log (không PII) và để cron bù.
- **Cron `identity.reconcile-registered`** (`MaintenanceQueue`, lịch lấy từ config). Mỗi vòng:
  1. Đọc qua pool auth: `SELECT id FROM auth."user" WHERE registered_event_emitted_at IS NULL AND created_at < now() - $grace ORDER BY created_at LIMIT $batch`. Dùng partial index ở mục 5.3; index nhỏ vì chỉ chứa user chưa được đánh dấu.
  2. `uow.run`: `append(…, { ifAbsent: true })` cho cả batch.
  3. Đặt marker cho cả batch (`WHERE id = ANY($ids) AND registered_event_emitted_at IS NULL`).
  4. Batch đầy thì lặp ngay, tối đa `AUTH_REGISTERED_RECONCILE_MAX_BATCHES` mỗi lần chạy.

  **Không có giới hạn cửa sổ thời gian:** user chưa có marker luôn được tìm thấy, dù worker dừng bao lâu.
- **`GRACE`** (`AUTH_REGISTERED_RECONCILE_GRACE_SEC`) **không** ảnh hưởng tính đúng. Nó chỉ để after-hook kịp chạy trước, tránh cron ghi trùng. Hai worker chạy song song chỉ tạo lần ghi trùng, và `ifAbsent` chặn.
- **Trùng lặp:**
  - After-hook và cron dùng cùng event id; outbox chặn bằng `UNIQUE(event_id)`, subscriber chặn bằng inbox.
  - Lần ghi lại có thể lọt qua dedupe chỉ khi marker không đặt được lâu hơn `OUTBOX_RETENTION_DAYS` (pool auth lỗi kéo dài). Khi đó inbox còn chặn trong `INBOX_RETENTION_DAYS`.
  - Metric `identity_registered_unmarked_oldest_seconds` (tuổi của user chưa có marker lâu nhất) cảnh báo khi vượt nửa thời gian giữ lại nhỏ hơn trong hai cái. Runbook có ghi.
- **Test:**
  - After-hook lỗi ở bước ghi outbox, và ở bước đặt marker → cron bù đúng một event.
  - Một transaction tạo user được giữ mở lâu hơn `GRACE` (transaction thử nghiệm trên `auth_user`) rồi commit → cron vẫn phát event.
  - Hai cron song song → một event.
  - Worker dừng lâu hơn mọi cửa sổ → vẫn bù đủ.
- **Cron `identity.purge-expired`** (spec cha §6): xoá theo batch session, verification, `rate_limit`, `login_attempts` đã hết hạn, và marker `auth.security_notice` ĐÃ gửi cũ hơn `AUTH_SECURITY_NOTICE_RETENTION_DAYS` (S2-R75; marker chưa gửi không bao giờ bị xoá).

**Thông báo bảo mật bền (S2-R75, final review notif I1).** Thông báo 2FA bật/tắt (và mọi thông báo đổi bảo mật sau này) dùng cùng mẫu marker + cron như `identity.user.registered`, vì thao tác bảo mật không làm lại được: bấm lại thì cờ đã đổi, không còn gì để báo, và kẻ tắt 2FA được lợi từ thư bị mất.
- **Marker cùng câu lệnh với thay đổi.** better-auth 1.7.6 không bọc các endpoint 2FA trong transaction: enable (`plugins/two-factor/index.mjs:117,140`), disable (`:217`), verify-totp (`plugins/two-factor/totp/index.mjs:208`) và verify-otp (`plugins/two-factor/otp/index.mjs:226`) gọi thẳng `internalAdapter.updateUser` (`db/internal-adapter.mjs:601`, một câu UPDATE autocommit); `databaseHooks.user.update.before/after` (`db/with-hooks.mjs:44-78`) chạy trước câu đó hoặc sau khi nó đã commit. Vì vậy marker do trigger `user_two_factor_notice_trg` (`AFTER UPDATE OF two_factor_enabled … WHEN (OLD.two_factor_enabled IS DISTINCT FROM NEW.two_factor_enabled)`) ghi vào `auth.security_notice` TRONG chính câu UPDATE: đổi cờ commit thì marker commit, không đổi thật thì không có marker, trên mọi đường ghi.
- **Đường gửi nhanh** (hook `after` của `/two-factor/enable|disable|verify-totp|verify-otp` khi có session): `SecurityNoticeService.afterChange(userId)` yêu cầu thư cho từng marker chưa gửi của user rồi đặt `notified_at`. Lỗi → log `security_notice_deferred` (không PII), không ném.
- **Cron `identity.reconcile-security-notices`** (`MaintenanceQueue`, mặc định mỗi phút): marker chưa gửi cũ hơn `AUTH_SECURITY_NOTICE_RECONCILE_GRACE_SEC`, không có cận dưới thời gian, theo batch. Một marker lỗi không chặn các marker khác; lần chạy vẫn thất bại (job lỗi) và marker đó được thử lại ở lần sau. Gauge `identity_security_notice_pending_oldest_seconds`.
- **Không trùng thư.** Key `two-factor-changed:<user id>:<marker id>`: đường gửi nhanh, cron, và hai cron song song đều ghi cùng key, `UNIQUE(idempotency_key)` giữ đúng một dòng. Thứ tự luôn là yêu cầu thư rồi đặt marker; crash giữa hai bước chỉ dẫn tới yêu cầu lại cùng key. Cron bỏ qua marker đã gửi.
- **Test:** kill window (thay đổi commit, gửi sau commit lỗi → cron gửi đúng một thư, qua Better Auth thật và qua service), lỗi ở bước đặt marker, đường gửi nhanh và cron song song (barrier) → một thư, hai cron song song, marker lỗi không chặn batch.

### 5.11 Notifications (email)

**Bảng `public.email_deliveries`** (global). Grant cho `app_user`: `SELECT, INSERT, DELETE` trên cả bảng, và `UPDATE` **chỉ trên các cột trạng thái** (`params_enc`, `state`, `lease_owner`, `lease_until`, `attempts`, `enqueue_generation`, `last_enqueued_at`, `last_error_code`, `completed_at`, `updated_at`). Các cột snapshot (`public_id`, `template`, `locale`, `recipient_enc`, `idempotency_key`, `created_at`) không ai sửa được sau khi insert (mục 5.16):

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | `BIGINT GENERATED ALWAYS AS IDENTITY` | PK |
| `public_id` | `UUID` | `NOT NULL UNIQUE`, sinh ở app bằng `v7` (cần cho AAD trước khi insert) |
| `template` | `TEXT` | `NOT NULL CHECK (template IN ('verify-email','reset-password','two-factor-changed','existing-account','change-email-confirmation'))` |
| `locale` | `TEXT` | `NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$')`. Tập locale thật do file template trong repo quyết định (mục 5.16) |
| `recipient_enc` | `TEXT` | `NOT NULL`. AAD `email_deliveries:recipient_enc:-:<public_id>` |
| `params_enc` | `TEXT` | NULL **khi và chỉ khi** đã ở trạng thái cuối (mọi template đều có params bắt buộc). AAD **riêng** `email_deliveries:params_enc:-:<public_id>`. Là tài liệu mờ đã mã hoá; schema params của mọi template **không** chứa địa chỉ người nhận |
| `state` | `TEXT` | `NOT NULL CHECK (state IN ('PENDING','SENDING','SENT','FAILED'))` |
| `lease_owner` | `UUID` | `UNIQUE`. NULL trừ khi `SENDING`; v7 mới mỗi lần claim nên không bao giờ trùng giữa hai dòng (NULL không đụng nhau) |
| `lease_until` | `TIMESTAMPTZ` | NULL trừ khi `SENDING` |
| `idempotency_key` | `TEXT` | `NOT NULL UNIQUE CHECK (starts_with(idempotency_key, template \|\| ':'))` |
| `attempts` | `INT` | `NOT NULL DEFAULT 0 CHECK (attempts >= 0)`. Số lần claim |
| `enqueue_generation` | `INT` | `NOT NULL DEFAULT 0 CHECK (enqueue_generation >= 0)`. Tăng mỗi lần cron đối soát enqueue lại |
| `last_enqueued_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()`. Lần enqueue gần nhất (lúc tạo hoặc lúc đối soát); dùng cho thời gian chờ giữa hai lần enqueue lại |
| `last_error_code` | `TEXT` | NULL. `CHECK (last_error_code IN ('SMTP_TRANSIENT','SMTP_PERMANENT','SMTP_TIMEOUT','SMTP_CONNECTION'))`: đúng tập mã của `MailSendError` (mục 5.14), không có PII |
| `completed_at` | `TIMESTAMPTZ` | NULL. Thời điểm vào trạng thái cuối (`SENT` hoặc `FAILED`); thay cho cặp `sent_at`/`failed_at` của bản trước (mục 5.16) |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

- `CHECK ((state = 'SENDING' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR (state <> 'SENDING' AND lease_owner IS NULL AND lease_until IS NULL))`: `SENDING` khi và chỉ khi có đủ cả hai cột lease, mọi trạng thái khác phải có cả hai NULL. Bản trước dùng phép so sánh boolean, để lọt trường hợp không phải `SENDING` mà vẫn còn `lease_until`.
- `CHECK ((state IN ('SENT','FAILED')) = (completed_at IS NOT NULL))`: có `completed_at` khi và chỉ khi ở trạng thái cuối. Trạng thái nào là cuối chỉ đọc từ `state`, `completed_at` chỉ mang thời điểm.
- `CHECK ((state IN ('SENT','FAILED')) = (params_enc IS NULL))`: trạng thái cuối không còn params, và `PENDING`/`SENDING` luôn còn params (dòng thiếu params không gửi được; `SENT` bị đưa ngược về `PENDING` mà không có params cũng bị chặn).
- `CHECK (state = 'PENDING' OR attempts > 0)`: mọi trạng thái khác `PENDING` chỉ tới được qua claim, và claim tăng `attempts`. Đúng với mọi chuyển trạng thái ở dưới: claim (`attempts + 1`), nhả lease về `PENDING`, `SENT`/`FAILED` của job (đều sau claim), và đối soát → `FAILED` (cần `attempts >= NOTIFICATIONS_MAX_TOTAL_ATTEMPTS`, mà giá trị này ≥ 1).
- **Index:**
  - `(created_at) WHERE state IN ('SENT','FAILED')`: cron dọn.
  - `(last_enqueued_at) WHERE state IN ('PENDING','SENDING')`: cron đối soát và metric tồn đọng.

**State machine `EmailDelivery`** (domain, `switch` vét cạn):

```
PENDING --claim--> SENDING --send ok--> SENT
SENDING --lease hết hạn, claim lại--> SENDING (owner mới)
SENDING --lỗi tạm thời--> PENDING (nhả lease)
SENDING --lỗi vĩnh viễn | hết lượt--> FAILED
PENDING --vượt NOTIFICATIONS_MAX_TOTAL_ATTEMPTS (đối soát)--> FAILED
```

`SENT` và `FAILED` là trạng thái cuối.

**Yêu cầu gửi (`EmailNotifications.request`):**
- Validate `params` theo schema của template.
- Trong `uow.run`: `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING public_id`. Có insert thì `SafeEnqueue` job `notifications.send-email` với payload `{ deliveryId }` và `jobId` = `<public_id>-g0`. Vì chạy trong transaction nên job đi qua outbox.
- **Idempotency key** (tiền tố luôn là key của template, DB ép bằng `CHECK starts_with`):
  - `verify-email:<sha256(token)>`
  - `reset-password:<sha256(token)>`
  - `two-factor-changed:<user id>:<marker id>`: một thư cho mỗi marker `auth.security_notice` (S2-R75; thay key theo session của bản trước)
  - `existing-account:…` (mục 5.8); riêng confirmation click dùng `existing-account:once:<sha256(token gốc)>` (S2-R68).
  - `change-email-confirmation:<sha256(token)>`; verification sau confirmation dùng `verify-email:once:<sha256(token gốc)>` (S2-R42/S2-R68).

**Job gửi** (queue `notifications`, `defineQueue('notifications', { kind: 'io' })`):
1. **Claim** (transaction ngắn, `owner = v7()`):

   ```sql
   UPDATE email_deliveries
      SET state = 'SENDING', lease_owner = $owner, lease_until = now() + $lease,
          attempts = attempts + 1, updated_at = now()
    WHERE public_id = $id
      AND (state = 'PENDING' OR (state = 'SENDING' AND lease_until < now()))
   RETURNING …
   ```

2. **Không claim được** → đọc `state`:
   - Không có dòng → `JobPayloadError` (vĩnh viễn).
   - `SENT`/`FAILED` → trả thành công (idempotent).
   - `SENDING` và lease còn hạn → ném `DeliveryLeaseBusyError`. Lỗi này retry được, BullMQ lùi lịch theo backoff. **Không bao giờ** trả thành công trong trường hợp này. Luật config: tổng backoff của `QUEUE_DEFAULT_ATTEMPTS` lần thử phải lớn hơn `NOTIFICATIONS_CLAIM_LEASE_MS`; còn sót thì cron đối soát bắt.
3. **Gửi**, ngoài transaction:
   - Giải mã, render.
   - Transporter **pool riêng cho lần gửi** (`pool: true, maxConnections: 1, maxMessages: 1`), đóng ở `finally`.
   - Timeout kết nối, greeting và socket lấy từ config; nodemailer huỷ socket khi quá thời gian không hoạt động (A.11).
   - Thêm **hạn chót tổng** `SMTP_SEND_DEADLINE_MS`: hết hạn thì gọi `transporter.close()` (pool đóng mọi connection, A.11) và coi là lỗi tạm thời. Luật config: `SMTP_SEND_DEADLINE_MS` < `NOTIFICATIONS_CLAIM_LEASE_MS`.
   - Lời gọi đi qua `ResiliencePolicies.for('smtp').single` (breaker + bulkhead, **không retry**, A.12). Retry là việc của job.
4. **Hoàn tất có fencing:**

   ```sql
   UPDATE … SET state = 'SENT', completed_at = now(), params_enc = NULL,
                lease_owner = NULL, lease_until = NULL
    WHERE public_id = $id AND state = 'SENDING' AND lease_owner = $owner
   ```

   Không có dòng nào (lease đã bị worker khác lấy) → log `delivery_lease_lost` (không PII) và trả thành công mà không gửi lại. Worker kia đang chịu trách nhiệm và có thể gửi thêm một bản; đây là at-least-once.
5. **Lỗi tạm thời** (4xx của SMTP, mạng, timeout, breaker mở) và chưa phải lần thử cuối: nhả lease (`state = 'PENDING'`, `lease_owner = NULL`, `lease_until = NULL`, `last_error_code`, fencing `WHERE state = 'SENDING' AND lease_owner = $owner`), rồi ném lỗi retry được.
6. **Lỗi vĩnh viễn** (5xx của SMTP), hoặc lần thử cuối (`attempt == maxAttempts`):
   - Trong một transaction, fencing theo owner: `state = 'FAILED'`, `lease_owner = NULL`, `lease_until = NULL`, `completed_at = now()`, `params_enc = NULL`, `last_error_code`, và ghi event `notifications.delivery.failed@1` (`{ deliveryId, template, errorCode }`).
   - **Sau khi commit** mới ném `JobPayloadError`. Lần thử cuối thì ném lỗi thường để BullMQ đánh dấu failed.
7. **Bảo đảm là at-least-once:** crash giữa lúc SMTP nhận thư và bước 4, hoặc lease bị lấy lại khi SMTP chậm, đều có thể gửi hai lần. `Message-ID` cố định theo `public_id` giúp nhận diện nhưng **không** bảo đảm khử trùng. Ghi ADR 0006.

**Cron `notifications.reconcile-deliveries`:**
- Chọn dòng thoả **cùng một điều kiện** cho cả hai trạng thái: `last_enqueued_at < now() - NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC AND (state = 'PENDING' OR (state = 'SENDING' AND lease_until < now()))`.
- Vượt `NOTIFICATIONS_MAX_TOTAL_ATTEMPTS` → `FAILED` (cả hai cột lease về NULL, `completed_at = now()`, `params_enc = NULL`) + event, cùng transaction.
- Còn lại → **generation bền trong DB**. Trong một `uow.run`:
  1. `UPDATE email_deliveries SET enqueue_generation = enqueue_generation + 1, last_enqueued_at = now(), updated_at = now() WHERE public_id = $id AND last_enqueued_at < now() - $cooldown AND (state = 'PENDING' OR (state = 'SENDING' AND lease_until < now())) RETURNING enqueue_generation`. Không trả dòng nào thì bỏ qua, không enqueue.
  2. `SafeEnqueue` với `jobId = <public_id>-g<generation>`, cùng transaction, nên đi qua outbox.

  Mỗi lần đối soát tạo một jobId mới, kể cả khi job trước đó fail trước khi kịp claim (khi đó `attempts` không đổi, nên jobId theo `attempts` ở bản trước sẽ bị BullMQ bỏ qua vì trùng). Thời gian chờ nằm **trong chính câu UPDATE atomic**: row lock của Postgres làm hai cron chạy song song chỉ có một cron qua được điều kiện `last_enqueued_at` và enqueue; cron kia nhận 0 dòng. Dòng `SENDING` hết lease cũng chịu cùng thời gian chờ, nên không sinh job mới liên tục khi chưa có worker nào claim. Handler vẫn idempotent nhờ claim.

**Cron `notifications.purge-deliveries`:** xoá theo batch các dòng `SENT`/`FAILED` cũ hơn `NOTIFICATIONS_RETENTION_DAYS`.

**Renderer:**
- Lúc boot worker: `await mjml2html(src, { validationLevel: 'strict', ignoreIncludes: true })`.
- Rồi `Handlebars.create().compile(html, { strict: true, knownHelpersOnly: true })`, không helper, không `allowProtoPropertiesByDefault`. Kết quả cache lại.
- Chỉ compile file trong repo. Template lỗi thì worker không khởi động (S6).
- Locale theo `NOTIFICATIONS_DEFAULT_LOCALE`.

**Transport:**
- `createTransport({ host, port, secure, requireTLS, auth, connectionTimeout, greetingTimeout, socketTimeout, tls: { rejectUnauthorized }, disableFileAccess: true, disableUrlAccess: true, pool: true, maxConnections: 1, maxMessages: 1 })`.
- Không attachment; `from` lấy từ `MAIL_FROM`.
- Lỗi đi qua `smtp-error.ts` (mục 5.14) **trước** khi log hay ném.

**Thông báo 2FA:** `hooks.after` của `/two-factor/enable` và `/two-factor/disable` khi thành công.

### 5.12 Bull Board (D9)

- **Chạy trong worker.** api là process public, còn worker đã có mẫu server nội bộ (`WorkerHealthServer`), và BullMQ chỉ nằm trong `core/queue`. Chỉ một deployment bật `QUEUE_DASHBOARD_ENABLED`; deployment đó tạo `Queue` read-only cho mọi queue trong `queueRegistry()`.
- **Server:** `express()` riêng, `listen(QUEUE_DASHBOARD_PORT, QUEUE_DASHBOARD_HOST)`. Mở ở `onApplicationBootstrap`, đóng ở `beforeApplicationShutdown` và trên mọi đường lỗi. Mọi queue dùng `BullMQAdapter(queue, { readOnlyMode: true })` (research 5).
- **Kiểm tra truy cập,** theo thứ tự:
  1. IP thuộc `QUEUE_DASHBOARD_IP_ALLOWLIST`, nếu không → `403`.
  2. Quy tắc đa credential (5.6.1). API key → `403`.
  3. CSRF (5.6.2) cho method không an toàn (vốn đã bị read-only từ chối).
  4. `QueueDashboardAuthorizer.isAllowed` → `AuthResult.isPlatformAdmin`. Không credential → `401`, không phải admin → `403`. Body là problem+json.
  5. Dashboard bật mà không có authorizer → worker không khởi động.
- **Cookie** không phân biệt port. Production truy cập qua ingress/VPN nội bộ cùng domain cookie; ở `external`, cookie token của IdP trên domain cha dùng được như nhau.
- **Không PII:** payload job chỉ có id (có unit test khoá schema). Failed reason và stack chỉ chứa lỗi đã chuẩn hoá (mục 5.14).

### 5.13 Health

- **api:** readiness thêm `auth_database` (`SELECT 1` trên pool `auth_user`) khi mode khác `external`. Pool auth chết thì mọi request cần xác thực đều hỏng.
- **worker:** thêm `auth_database` khi worker có pool auth.
- **Không đưa SMTP và JWKS vào readiness.** Email gửi bất đồng bộ, có retry và đối soát. SMTP và IdP là dịch vụ ngoài dùng chung cả fleet: gate theo chúng thì một lần chập chờn rút mọi pod, cùng lập luận R21. Lỗi được phát hiện qua metric và cảnh báo.

### 5.14 Observability và không lộ PII

**Chuẩn hoá lỗi trước khi log hay ném:**
- **SMTP** (`smtp-error.ts`): lỗi nodemailer mang `response`, `responseCode`, `command`, `rejected`, `rejectedErrors` (A.11), đều có thể chứa địa chỉ email. Được đổi thành `MailSendError { code: 'SMTP_TRANSIENT' | 'SMTP_PERMANENT' | 'SMTP_TIMEOUT' | 'SMTP_CONNECTION', responseCode?, command? }`.
  - `message` là chuỗi cố định.
  - **Không** gắn lỗi gốc làm `cause`.
  - Đây là thứ duy nhất vào log, `last_error_code` và failed reason của BullMQ.
- **Better Auth:** chỉ log `code`, status và path của lỗi; không log `message` hay body.
- **Phòng thủ nhiều lớp:** `ERROR_PAYLOAD_DROP` của core bỏ `response`, `rejected`, `rejectedErrors`, `envelope`. `BASE_REDACT_PATHS` thêm `set-auth-token` và cookie (mục 5.1).
- **Luật config:** `AUTH_API_KEY_HEADER` phải là `x-api-key` (đã có trong danh sách redact gốc) hoặc thêm đường `req.headers["<tên-header>"]` vào `LOG_EXTRA_REDACT_PATHS` (đối chiếu Task 25/S2-R23).
- **Test đường lỗi:**
  - SMTP từ chối người nhận (Mailpit chaos hoặc SMTP giả trả 550 kèm địa chỉ): log, `last_error_code` và failed reason không chứa địa chỉ.
  - Đăng nhập sai với email bất kỳ: log không chứa email.
  - Response có `set-auth-token`: log bị redact.

**Span** (`@opentelemetry/api`): `identity.authenticate` (`auth.mode`, `auth.result`, `credential.kind`), `identity.jwt.verify`, `identity.lockout.consume`, `identity.registered.reconcile`, `notifications.email.claim`, `notifications.email.render`, `notifications.email.send`.

**Metric:**
- `identity_sign_in_total{result}`, `identity_lockout_blocked_total`, `identity_lockout_refund_failed_total` (S2-R35: refund lỗi log/metric, không ném sau khi session đã tạo).
- `identity_auth_unavailable_total`, `identity_csrf_rejected_total`, `identity_ambiguous_credentials_total`.
- `identity_registered_unmarked_oldest_seconds`, `identity_auth_pool_connections` (Task 27/32).
- `identity_auth_email_request_failed_total` (Task 33), `identity_account_reclaimed_total` (S2-R40/S2-R44/S2-R48). S2-R75: đặt alert khi `identity_auth_email_request_failed_total` > 0; với thư người dùng tự yêu cầu lại được, đây là dấu vết duy nhất của một thư mất trong cửa sổ sau commit của auth.
- `identity_security_notice_pending_oldest_seconds` (S2-R75): tuổi của marker thông báo bảo mật chưa gửi lâu nhất; alert khi vượt vài chu kỳ cron.
- `identity_client_ip_unresolved_total` (S2-R50: IP không xác định là lỗi cấu hình 500).
- `identity_dashboard_denied_total` (Task 45).
- `identity_enumeration_floor_exceeded_total` (S2-R58/S2-R68: xử lý vượt floor).
- `identity_auth_endpoint_error_total` (S2-R59: 5xx sign-in/2FA được trả 503 nhưng lỗi nội bộ vẫn đo/log).
- `notifications_email_total{template,result}`, `notifications_email_stuck_total`, `notifications_email_lease_lost_total`
- Danh sách `identity_*` trên đối chiếu src ở pass Task 49; không thêm metric giả định từ plan. Span `identity.authenticate`, `identity.jwt.verify`, `identity.lockout.consume`, `identity.registered.reconcile` giữ nguyên; thêm `identity.account.reclaim`, `identity.account.fence_late_session` (S2-R40/S2-R44).
- Không label theo email, user id hay org.

### 5.15 Config

Secret không có default. `.env.example` sinh lại bằng `pnpm env:example`.

**Lệch khi thực thi (Task 22/33, S2-R56/S2-R58/S2-R60; xem ADR 0010):** `SMTP_SEND_DEADLINE_MS` mặc định 8000, nhỏ hơn lease và timeout resilience của provider `smtp`. API key tắt plugin `rateLimit` (Nest throttler theo principal thay thế); `keyExpiration.defaultExpiresIn` tính bằng giây. External JWKS mặc định jose 5000 ms, cooldown 30000 ms, cache 600000 ms; attempt timeout = max(1, floor(joseTimeout / (retries + 2))), mặc định 1250 ms với 2 retries. Không cần override để boot; override timeout phải nhỏ hơn jose. S2-R58/S2-R68: `AUTH_ENUMERATION_MIN_RESPONSE_MS=300`, tối đa 5000, local/hybrid production > 0, gồm GET `/verify-email`. S2-R60–S2-R72: deadline và luật config trong bảng bổ sung dưới đây, đối chiếu ADR 0007/0010.

**Deadline bổ sung (S2-R60/S2-R67/S2-R70/S2-R72):**

| Env | Mặc định ms | Luật |
| --- | --- | --- |
| `DB_AUTH_CONNECTION_TIMEOUT_MS`, `DB_AUTH_QUERY_TIMEOUT_MS` | 3000, 6000 | Production local/hybrid: max(2 × (connect + query) + `HEALTH_CHECK_TIMEOUT_MS`, floor) < HTTP budget |
| `DB_CONNECTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | 3000, 6000 | API production: connect + 2 × query < HTTP budget |
| `HTTP_REQUEST_BUDGET_MS` | 30000 | Khớp proxy; không huỷ mọi handler; core API checkout reaper dùng hạn này |
| `DB_WORKER_CONNECTION_TIMEOUT_MS`, `DB_WORKER_QUERY_TIMEOUT_MS` | 65000, 65000 | Connect ≥ query > `DB_WORKER_STATEMENT_TIMEOUT_MS` (60000), mọi môi trường |
| `DB_WORKER_CHECKOUT_MAX_MS` | 300000 | > 2 × worker query timeout; reaper core app/relay, job phải xong trước hạn |

Readiness liên tục kiểm statement_timeout > 0 và < query deadline tương ứng; production vi phạm down, ngoài production log lỗi. N5: drift chung có thể mất readiness toàn cụm. `watchPoolCheckouts`/destroy-on-release giữ slot không bị bỏ rơi; `onPoolCreated` gắn bảo vệ core pool. Kysely 0.29.6 chưa được patch upstream. `UnitOfWork`/`RelayDb.transaction` có `503 commit_outcome_unknown` + ERROR, không tự retry ở UnitOfWork; xem ADR 0007.

**`identity`:**

| Env | Mặc định | Ghi chú |
|---|---|---|
| `AUTH_MODE` | `local` | `local` \| `hybrid` \| `external` |
| `BETTER_AUTH_SECRET` | — (secret) | ≥ 32 ký tự; bắt buộc khi mode khác `external` |
| `AUTH_BASE_URL`, `AUTH_BASE_PATH` | —, `/api/auth` | |
| `AUTH_SECURE_COOKIES` | `true` | |
| `AUTH_COOKIE_PREFIX` | tên dịch vụ | `^[a-z0-9-]{1,32}$` |
| `AUTH_COOKIE_DOMAIN` | trống | Domain cha khi cần chia sẻ cookie (điều kiện ở mục 5.4) |
| `AUTH_COOKIE_DOMAIN_ALL_SUBDOMAINS_TRUSTED` | `false` | Xác nhận tường minh mọi subdomain đều tin cậy; bắt buộc `true` khi có `AUTH_COOKIE_DOMAIN` |
| `AUTH_COOKIE_SAMESITE` | `lax` | `lax` \| `strict` \| `none` (`none` bắt buộc Secure) |
| `AUTH_SESSION_EXPIRES_IN_SEC`, `AUTH_SESSION_UPDATE_AGE_SEC`, `AUTH_SESSION_FRESH_AGE_SEC` | | |
| `AUTH_PASSWORD_MIN_LENGTH`, `AUTH_PASSWORD_MAX_LENGTH` | | min < max |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | `true` | |
| `AUTH_EMAIL_TOKEN_TTL_SEC`, `AUTH_RESET_TOKEN_TTL_SEC` | | |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` (secret) | trống | Có cả hai hoặc không có cả hai |
| `AUTH_TRUSTED_PROVIDERS` | trống | Id provider được liên kết theo email (mục 5.4) |
| `AUTH_OIDC_PROVIDER_ID`, `AUTH_OIDC_DISCOVERY_URL`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET` (secret), `AUTH_OIDC_SCOPES` | scopes: `openid,email,profile` | Bốn biến đầu bắt buộc khi hybrid; scopes có default (Task 25/S2-R37) |
| `AUTH_TWO_FACTOR_ISSUER` | tên dịch vụ | |
| `AUTH_API_KEY_HEADER`, `AUTH_API_KEY_DEFAULT_EXPIRES_IN_SEC` | `x-api-key`, | |
| `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_JWT_EXPIRES_IN_SEC` | | Token phát cho dịch vụ khác |
| `AUTH_JWKS_ROTATION_INTERVAL_SEC`, `AUTH_JWKS_GRACE_PERIOD_SEC` | | Xoay khoá JWKS |
| `AUTH_EXTERNAL_JWKS_URL`, `AUTH_EXTERNAL_ISSUER`, `AUTH_EXTERNAL_AUDIENCE`, `AUTH_EXTERNAL_ALGORITHMS`, `AUTH_EXTERNAL_CLOCK_TOLERANCE_SEC` | clock tolerance: 30 s | Bốn biến đầu bắt buộc external; tolerance có default (S2-R56) |
| `AUTH_EXTERNAL_USER_CLAIM`, `AUTH_EXTERNAL_USER_CLAIM_VALUE` | — | Bắt buộc khi `external` |
| `AUTH_EXTERNAL_TOKEN_COOKIE` | trống | Trống thì chỉ nhận header |
| `AUTH_EXTERNAL_TYP`, `AUTH_EXTERNAL_MAX_TOKEN_AGE_SEC` | trống | Tuỳ chọn |
| `AUTH_EXTERNAL_ADMIN_CLAIM`, `AUTH_EXTERNAL_ADMIN_VALUE` | trống | Có cả hai hoặc không có cả hai |
| `AUTH_EXTERNAL_JWKS_TIMEOUT_MS`, `_COOLDOWN_MS`, `_CACHE_MAX_AGE_MS` | | |
| `AUTH_RATE_LIMIT_ENABLED`, `AUTH_RATE_LIMIT_WINDOW_SEC`, `AUTH_RATE_LIMIT_MAX`, `AUTH_SIGNIN_RATE_WINDOW_SEC`, `AUTH_SIGNIN_RATE_MAX`, `AUTH_TWO_FACTOR_RATE_WINDOW_SEC`, `AUTH_TWO_FACTOR_RATE_MAX`, `AUTH_EMAIL_RATE_WINDOW_SEC`, `AUTH_EMAIL_RATE_MAX` | `true`, … | |
| `AUTH_VERIFY_EMAIL_RATE_WINDOW_SEC`, `AUTH_VERIFY_EMAIL_RATE_MAX` | 300, 20 | Luật riêng của `/verify-email` (S2-R68 follow-up); rộng hơn `AUTH_EMAIL_RATE_MAX` nhưng production không được rộng hơn `AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_SEC` (rule `identity-verify-email-rate`) |
| `AUTH_LOCKOUT_MAX_FAILURES`, `AUTH_LOCKOUT_WINDOW_SEC`, `AUTH_LOCKOUT_BLOCK_SEC` | | |
| `AUTH_UNAVAILABLE_RETRY_AFTER_SEC`, `AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC` | | |
| `AUTH_REGISTERED_RECONCILE_CRON`, `_TZ`, `_GRACE_SEC`, `_BATCH_SIZE`, `_MAX_BATCHES` | | |
| `AUTH_PURGE_CRON`, `_TZ`, `_BATCH_SIZE`, `_MAX_BATCHES` | | |
| `AUTH_SECURITY_NOTICE_RECONCILE_CRON`, `_TZ`, `_GRACE_SEC`, `_BATCH_SIZE`, `_MAX_BATCHES` | `* * * * *`, `UTC`, 60, 100, 10 | S2-R75: cron gửi bù thông báo bảo mật |
| `AUTH_SECURITY_NOTICE_RETENTION_DAYS` | 30 | S2-R75: marker đã gửi cũ hơn thì `identity.purge-expired` xoá |
| `DB_AUTH_HOST`, `DB_AUTH_PORT`, `DB_AUTH_USER`, `DB_AUTH_PASSWORD` (secret), `DB_AUTH_POOL_MAX` | theo `DB_*`, `auth_user`, —, | TLS theo `DB_SSL_MODE` |

**`notifications`:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD` (secret), `SMTP_TLS_REJECT_UNAUTHORIZED` (`true`), `SMTP_CONNECTION_TIMEOUT_MS`, `SMTP_GREETING_TIMEOUT_MS`, `SMTP_SOCKET_TIMEOUT_MS`, `SMTP_SEND_DEADLINE_MS`, `MAIL_FROM`, `NOTIFICATIONS_DEFAULT_LOCALE`, `NOTIFICATIONS_CLAIM_LEASE_MS`, `NOTIFICATIONS_REENQUEUE_COOLDOWN_SEC`, `NOTIFICATIONS_MAX_TOTAL_ATTEMPTS`, `NOTIFICATIONS_RETENTION_DAYS`, cron/tz/batch của hai cron. Ràng buộc: `SMTP_PORT` trong 1–65535; `SMTP_USER` và `SMTP_PASSWORD` cùng có hoặc cùng trống (luật `smtp-auth-pair`); `MAIL_FROM` là `addr` hoặc `Name <addr>` trên một dòng, phần địa chỉ qua `z.email()`.

**`queueDashboard`** (`core/queue`): `QUEUE_DASHBOARD_ENABLED` (`false`), `QUEUE_DASHBOARD_HOST` (`127.0.0.1`), `QUEUE_DASHBOARD_PORT`, `QUEUE_DASHBOARD_BASE_PATH`, `QUEUE_DASHBOARD_IP_ALLOWLIST`.

**Luật production:**
- `BETTER_AUTH_SECRET` có ít nhất `MIN_SECRET_DISTINCT_CHARS` ký tự khác nhau.
- `AUTH_BASE_URL` là `https`; `AUTH_SECURE_COOKIES=true`; `AUTH_RATE_LIMIT_ENABLED=true`.
- `AUTH_EXTERNAL_JWKS_URL`, `AUTH_OIDC_DISCOVERY_URL` là `https`.
- SMTP: `SMTP_SECURE` hoặc `SMTP_REQUIRE_TLS`, và `SMTP_TLS_REJECT_UNAUTHORIZED=true`.
- Dashboard bật thì allowlist không rỗng.

**Luật mọi môi trường:**
- Yêu cầu theo mode.
- `AUTH_COOKIE_SAMESITE=none` thì Secure.
- `AUTH_SECURE_COOKIES=false` chỉ được khi `NODE_ENV` là `development` hoặc `test` **và** `AUTH_BASE_URL` là `http://localhost` hoặc `http://127.0.0.1`. Staging chạy `NODE_ENV=production` (A.19) nên cũng bị luật production bắt `true`.
- `AUTH_COOKIE_DOMAIN` có giá trị thì đủ ba điều kiện ở mục 5.4: cờ xác nhận `true`; host của `AUTH_BASE_URL` và mọi origin của `HTTP_CORS_ORIGINS` nằm dưới domain đó; domain có ít nhất hai nhãn và không phải `localhost`.
- Validate tên header và cookie, cùng các luật cấm trùng tên, ở mục 5.6.1.
- `AUTH_API_KEY_HEADER` được redact.
- `SMTP_SEND_DEADLINE_MS` < `NOTIFICATIONS_CLAIM_LEASE_MS`.
- Tổng backoff của job lớn hơn lease.
- `AUTH_OIDC_PROVIDER_ID` ≠ `google`.
- Mọi phần tử của `AUTH_TRUSTED_PROVIDERS` là provider đang bật.
- `NOTIFICATIONS_DEFAULT_LOCALE` khớp `^[a-z]{2,3}(-[A-Z]{2})?$` (cùng regex với `CHECK` của `email_deliveries.locale`), và worker chỉ khởi động khi mọi template có file cho locale đó.

### 5.16 Chuẩn hoá dữ liệu

Áp dụng luật chuẩn hoá của spec cha §4 (mục 3). SP2 **không** tạo view, bảng template (template là file trong repo), bảng preference hay bảng `notifications` (hoãn sang SP6, mục 2). Các bảng SP2 tạo hoặc sửa được phân tích dưới đây. Ký hiệu: `→` là phụ thuộc hàm; chỉ ghi phụ thuộc không tầm thường ngoài "khoá → mọi cột".

**a) Bảng của mình**

| Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng chuẩn | Ghi chú |
|---|---|---|---|---|
| `public.email_deliveries` | `{id}`, `{public_id}`, `{idempotency_key}` | Mỗi khoá → mọi cột. `idempotency_key → template` (tiền tố của key). `lease_owner` khác NULL là v7 duy nhất mỗi lần claim, nên tự nó cũng xác định dòng; DB ép bằng `UNIQUE (lease_owner)` | **BCNF**: mọi vế trái đều là siêu khoá | Chi tiết và các thay đổi ở phần c |
| `auth."user".registered_event_emitted_at` (cột thêm vào bảng thư viện) | — (thuộc `{id}`, `{email}` của `"user"`) | `id → registered_event_emitted_at` | Giữ nguyên dạng chuẩn của `"user"` | Không trùng với `outbox_events`: dòng outbox bị dọn sau `OUTBOX_RETENTION_DAYS`, và `auth_user` không đọc được `public`, nên marker là nguồn sự thật duy nhất của "đã phát event chưa". Chỉ một người ghi (`UPDATE … WHERE registered_event_emitted_at IS NULL`), không có bản sao |
| `auth.login_attempts` | `{key}` | `key → points, expire` | BCNF về phụ thuộc hàm, tính cả dòng `tickets:` (phần b) | Hình dạng do `rate-limiter-flexible` quy định (A.9) |
| `auth.user_reclaim` (S2-R76) | `{user_id}` | Chỉ `user_id → reclaimed_at, created_at` | **BCNF** | Marker bền của lần reclaim gần nhất. PK `user_id` (1-1 với user, không surrogate), FK → `"user"` `ON DELETE CASCADE` (dữ liệu thuộc hẳn user), `NOT NULL`, `CHECK (reclaimed_at >= created_at)`. `reclaimed_at` là thời điểm cập nhật của dòng nên không có `updated_at` riêng. Grant `SELECT, INSERT, UPDATE (reclaimed_at)`, không `DELETE`. Migration riêng `Migration20260928072715_user_reclaim` |
| `auth.security_notice` (S2-R75) | `{id}` | Chỉ `id → user_id, kind, created_at, notified_at` | **BCNF** | Marker bền của thông báo bảo mật, do trigger ghi cùng câu UPDATE đổi `two_factor_enabled`. `kind` (`CHECK` đóng: `two_factor_enabled`, `two_factor_disabled`) là trạng thái mới tại thời điểm đổi, không dẫn xuất được từ cờ hiện tại. Không lưu email/tên (đọc từ `"user"` lúc gửi). `id uuid DEFAULT uuidv7()` (quy ước schema auth; id vào key idempotency ở bảng khác nên không được lặp lại khi bảng tạo lại). FK → `"user"` `ON DELETE CASCADE`, `NOT NULL` trừ `notified_at`, `CHECK (notified_at >= created_at)`; `notified_at` là cột duy nhất được cập nhật nên không có `updated_at`. Index `(user_id)`, `(created_at) WHERE notified_at IS NULL`, `(notified_at)`, mỗi cái một query. Grant `SELECT, INSERT, DELETE, UPDATE (notified_at)`. Migration `Migration20260928082958_security_notice` |

**b) Ngoại lệ có lý do: schema do thư viện sở hữu**

Bảng Better Auth (`user`, `session`, `account`, `verification`, `two_factor`, `apikey`, `jwks`, `rate_limit`) và `auth.login_attempts` có hình dạng do thư viện quyết định: thư viện đọc ghi đúng các cột đó, `validateSchema` và kiểm lệch schema ở CI (mục 9) so với output của `auth generate`. Đổi hình dạng (tách bảng, đổi kiểu cột) là hỏng thư viện, nên đây là ngoại lệ "schema do thư viện sở hữu" của luật. Danh sách cột chốt theo output của S3; plan phải đối chiếu bảng dưới với output đó và bổ sung cột mới trước khi viết migration.

| Bảng | Khoá ứng viên (dự kiến) | Chỗ lệch luật | Vì sao chấp nhận / cách giữ nhất quán |
|---|---|---|---|
| `"user"` | `{id}`, `{email}` | (1) `two_factor_enabled` là dữ liệu dẫn xuất từ sự tồn tại của dòng `two_factor` (trùng lặp giữa hai bảng). (2) `role` là chuỗi tự do, plugin `admin` có thể lưu nhiều role nối dấu phẩy (đa trị, xác minh ở S3). (3) `banned`, `ban_reason`, `ban_expires` là cờ rời thay vì trạng thái | Thư viện sở hữu. (1) chỉ plugin `twoFactor` ghi cả hai, code của mình không bao giờ ghi trực tiếp; app đọc trạng thái 2FA qua Better Auth. (2) app đọc role qua `IdentityDirectory` và chỉ so với `'admin'`; RBAC thật thuộc SP3 (follow-up ở mục 10). (3) chỉ plugin `admin` ghi |
| `session` | `{id}`, `{token}` | Không thấy lệch 3NF. `impersonated_by` là id user dạng `text`, không FK (S3a) | Thư viện sở hữu; D7 tắt impersonation nên cột luôn `NULL` |
| `account` | `{id}`, `{provider_id, account_id}` | `scope` là danh sách scope nối chuỗi (đa trị); `password` chỉ có nghĩa với provider `credential` | Thư viện sở hữu; `scope` là tài liệu mờ với mình (không query, không ràng buộc theo từng scope) |
| `verification` | `{id}` | `identifier` là chuỗi do thư viện ghép, có thể mang loại và giá trị trong một cột | Tài liệu mờ với mình; chỉ cron dọn đọc `expires_at` |
| `two_factor` | `{id}` | `backup_codes` là một khối mã hoá chứa nhiều mã (đa trị). `verified`, `failed_verification_count`, `locked_until` (S3a) là trạng thái hiện tại của chính dòng (khoá 2FA có sẵn, S4), không lệch 3NF. Một dòng mỗi user: `{user_id}` là khoá ứng viên, DB ép bằng `UNIQUE (user_id)` (review Task 26 I1: plugin enable là findOne rồi create, không khoá, nên hai request song song tạo hai dòng) | Tài liệu mờ thật sự: mã hoá nguyên khối bằng `BETTER_AUTH_SECRET` (A.4), không query được từng mã. Chỉ plugin `twoFactor` ghi bảng này |
| `apikey` | `{id}` (S3a: `key` chỉ có index thường, không `UNIQUE`) | `permissions`, `metadata` là JSON; `start`/`prefix` là snapshot phần đầu của key. `config_id` (S3a) chọn cấu hình plugin, không lệch | SP2 không đọc hai cột JSON; quyền theo key thuộc SP3. `start` không dẫn xuất được vì key chỉ lưu dạng băm |
| `jwks` | `{id}` | `alg`, `crv` (S3a) dẫn xuất được từ cặp khoá | Thư viện sở hữu; chỉ plugin `jwt` ghi cùng lúc với cặp khoá và không bao giờ sửa, nên không lệch được |
| `rate_limit` | `{id}`, `{key}` | `key` ghép IP + path; `last_request` là `bigint` epoch ms, không phải `timestamptz` | Thư viện sở hữu, dùng nguyên kiểu |
| `login_attempts` | `{key}` | `key` ghép loại + hash + số cửa sổ (mục 5.7); `expire` là `bigint` epoch ms; `points` âm được khi refund. **Thêm một loại dòng thứ hai** ngoài dòng tổng hợp `attempts:*`/`blocks:*` của package: mỗi lần `guard` cấp quyền, `login-lockout.ts` còn ghi một dòng biên nhận `tickets:<loại>:<hash>:w<cửa sổ>:t<uuid>`, `points = 1` cố định, `expire` sao chép nguyên từ dòng tổng hợp lúc cấp. `points` của dòng này không phải bộ đếm — nó chỉ tồn tại để `DELETE … RETURNING` xoá đúng một lần khi `refund` claim biên nhận (idempotency qua nhiều pool/pod). Đọc nhầm nó như dòng tổng hợp (vd. cộng `points` của mọi dòng theo prefix) sẽ sai | DDL phải khớp A.9 vì thư viện chạy SQL có sẵn (`tableCreated: true`). DB không bao giờ tách `key`; mọi logic trên key, gồm việc phân biệt hai loại dòng bằng tiền tố `tickets:`, nằm ở `login-lockout.ts`. `key → points, expire` vẫn đúng với dòng `tickets:` (khoá vẫn xác định toàn bộ dòng), nên BCNF không bị phá — chỉ là ngữ nghĩa của `points` khác nhau giữa hai loại dòng, được ghi ở đây để không cần tách bảng. Cron dọn (mục xoá theo `expire`, Task 32) xoá cả hai loại dòng như nhau |

**Cột và ràng buộc của mình thêm vào bảng thư viện vẫn tuân luật:** `registered_event_emitted_at` (phần a), `UNIQUE (provider_id, account_id)`, `UNIQUE (email)`, `UNIQUE (two_factor.user_id)`, FK `apikey.reference_id`, các index ở mục 5.3. Cờ bảo mật không được fail-open khi NULL (ruling S2-R26): `two_factor.verified` (`NOT NULL DEFAULT true`), `two_factor.failed_verification_count` (`NOT NULL DEFAULT 0 CHECK (>= 0)`), `apikey.enabled` (`NOT NULL DEFAULT true`), `"user".two_factor_enabled` và `banned` (`NOT NULL DEFAULT false`); default đúng `defaultValue` của plugin 1.7.6, thư viện không bao giờ ghi NULL vào các cột này. Không giữ index của SQL gốc mà không query nào dùng (`two_factor(secret)`, `apikey(config_id)`). Không thêm cột enum hay đa trị nào vào bảng thư viện.

**c) `email_deliveries`: phân tích và thay đổi do chuẩn hoá**

- **Người nhận và params có bị lưu thừa không?**
  - `recipient_enc` là **snapshot có chủ ý**, không phải bản sao của `auth."user".email`: thư đổi email gửi tới địa chỉ **mới** chưa nằm trong `"user"`, thư "đã có tài khoản" gửi tới địa chỉ đích, và user đổi email sau đó thì thư đã yêu cầu vẫn phải đi đúng địa chỉ lúc yêu cầu. Notifications cũng không được đọc identity (luật 15, schema khác). Đây là ngoại lệ "snapshot lịch sử không được thay đổi".
  - **Cơ chế giữ nhất quán:** snapshot không đi theo nguồn nên chỉ cần bất biến. DB ép bằng quyền `UPDATE` theo cột (mục 5.11): `app_user` không sửa được `recipient_enc`, `template`, `locale`, `idempotency_key`, `public_id`, `created_at`. Lý do chọn grant theo cột thay vì trigger: cùng hiệu lực, không có code chạy trong DB.
  - `params_enc` là tài liệu mờ (JSON đã mã hoá, chỉ renderer đọc, không query, bị xoá ở trạng thái cuối). Schema params của từng template không có trường địa chỉ người nhận, nên người nhận chỉ nằm ở một cột.
- **State là chuỗi tự do?** Không: `state`, `template` là `TEXT` + `CHECK`. Bản trước để `locale` và `last_error_code` là chuỗi tự do; nay có `CHECK` (thay đổi 2, 3).
- **Có trộn dữ kiện của từng lần thử với dữ kiện của thư không?** Bảng chỉ giữ trạng thái **hiện tại** của một thư: `lease_owner`, `lease_until` là lần claim đang chạy, `last_error_code` là lỗi gần nhất, `attempts` là bộ đếm. Không có nhóm lặp theo lần thử, nên mọi cột đơn trị theo khoá và bảng vẫn BCNF. **Không tách** thành bảng thư + bảng lần thử: không có yêu cầu nào đọc lịch sử từng lần thử, còn tách thì mỗi claim thành INSERT + UPDATE và fencing chuyển sang id của lần thử. Khi SP6 cần lịch sử (webhook bounce) thì thêm bảng con `email_delivery_attempts`; lúc đó `attempts` thành dữ liệu dẫn xuất và phải bỏ, hoặc giữ kèm cơ chế nhất quán ghi trong spec SP6.
- **Bộ đếm có thừa không?** `attempts` (số lần claim) và `enqueue_generation` (số lần đối soát enqueue lại) không dẫn xuất được từ dữ liệu nào trong DB (job nằm ở Redis), nên không thừa. `last_enqueued_at` trùng giá trị với `created_at` khi generation là 0 nhưng là dữ kiện khác (thay đổi theo đối soát), không phải phụ thuộc hàm.
- **`idempotency_key → template`:** vế trái là khoá ứng viên nên không vi phạm BCNF. Hai cột vẫn mang cùng thông tin, nên ép khớp bằng `CHECK (starts_with(idempotency_key, template || ':'))` và cả hai đều bất biến.

**Thay đổi so với bản trước do chuẩn hoá** (mọi quyết định khác giữ nguyên):

| # | Thay đổi | Lý do |
|---|---|---|
| 1 | `sent_at`, `failed_at` → một cột `completed_at` + `CHECK ((state IN ('SENT','FAILED')) = (completed_at IS NOT NULL))` | Cặp cũ lặp lại thông tin của `state` (cột nào khác NULL cho biết trạng thái) mà không có ràng buộc, nên có thể lệch nhau. Thêm trạng thái cuối mới (ví dụ `BOUNCED` ở SP6) không phải thêm cột |
| 2 | `last_error_code` có `CHECK` theo 4 mã của `MailSendError` | Enum không được là chuỗi tự do |
| 3 | `locale` có `CHECK` định dạng BCP 47 rút gọn, cộng luật config và kiểm lúc boot worker | Tập locale do file template trong repo quyết định; liệt kê trong `CHECK` thì mỗi dự án clone phải viết migration khi thêm ngôn ngữ. Định dạng ở DB, tập hợp ở app lúc boot |
| 4 | `template` liệt kê tường minh 5 key (S2-R42 thêm `change-email-confirmation`); `CHECK` tiền tố của `idempotency_key` | Ép hai cột cùng thông tin khớp nhau |
| 5 | `CHECK ((state IN ('SENT','FAILED')) = (params_enc IS NULL))` (hai chiều) | Bất biến "không giữ params sau khi xong" và "dòng chưa xong luôn có params để gửi" nằm ở DB, không chỉ ở code |
| 6 | Grant `UPDATE` theo cột thay cho `UPDATE` cả bảng | Cơ chế giữ snapshot người nhận bất biến |
| 7 | `UNIQUE (lease_owner)` | Phụ thuộc "`lease_owner` xác định dòng" ở phần a được DB ép, không chỉ là giả định |
| 8 | `CHECK (state = 'PENDING' OR attempts > 0)` | Bộ đếm claim khớp với trạng thái: không dòng nào rời `PENDING` mà chưa từng được claim |

---

## 6. Entrypoint

| File | Thay đổi |
|---|---|
| `main.api.ts` | `bodyParser: false`; `applyHttpDefaults` đăng ký `jsonBodyParser` của core, bỏ qua prefix khai báo qua `HTTP_BODY_PARSER_SKIP_PREFIX` |
| `main.worker.ts` | Không đổi. Dashboard là provider của `QueueModule`, bật bằng config |
| `main.migrate.ts` | Không đổi. `dist/migrations/{identity,notifications}` được nạp theo layout đệ quy của SP1 |
| `app.modules.ts` | `api: [IdentityModule.forApi(), NotificationsModule.forApi()]`, `worker: [IdentityModule.forWorker(), NotificationsModule.forWorker()]` |
| `package.json` scripts | `auth:generate`, `auth:create-admin` |

`NotificationsModule.forApi()` chỉ ghi DB và enqueue. SMTP, renderer và handler chỉ có ở worker.

---

## 7. Luật kiến trúc

**Đối chiếu thực thi Task 49:** giữ nhánh tự mount đã duyệt ở R36 của review trước thực thi (khác S2-R36 về map lỗi). Spike S1 xác nhận; xem ADR 0010.

Giữ 9 luật SP1, thêm:

10. `better-auth`, `@better-auth/*`, `kysely` chỉ trong `src/modules/identity/infra/better-auth/**`. `pg` chỉ trong đó và `src/core/database/**`.
11. `jose` chỉ trong `src/modules/identity/infra/jwks/**`.
12. `nodemailer`, `mjml`, `handlebars` chỉ trong `src/modules/notifications/infra/**`.
13. `@bull-board/*` chỉ trong `src/core/queue/dashboard/**`. Luật 6 (`express`) có thêm ngoại lệ `core/queue/dashboard/**`.
14. Luật 9 (`rate-limiter-flexible`) có thêm ngoại lệ `src/modules/identity/infra/better-auth/**`.
15. `modules/notifications/**` không import `modules/identity/**`.
16. `auth.cli-config.ts` nằm trong ngoại lệ `no-orphans`.

Mỗi luật có fixture "phải fail".

---

## 8. Testing

| Loại | Nội dung |
|---|---|
| Unit | `buildAuthOptions` theo mode (`trustedProviders: []`, `disableImplicitLinking`, `enableSessionForAPIKeys: false`, `disabledPaths`, `storeBackupCodes`); `mapProfileToUser` (bảng 4 trường hợp); nhận diện credential và quy tắc đa nguồn; kiểm origin (khớp chính xác, cùng site khác origin, `Sec-Fetch-Site`, thiếu cả hai); `authErrorMapper` phủ mọi mã, không đụng 3xx, giữ `Set-Cookie`; hợp đồng claim JWT (từng trường hợp ở 5.6.3); `toWebFetch` (status, header, `signal` huỷ, từ chối redirect); `FieldCipher.isCiphertext`; `withAccountCipher` với adapter giả (create, update theo id có hoặc không có định danh, đổi `accountId`, bản adapter trong transaction, đọc giải mã); state machine `EmailDelivery` (mọi cặp trạng thái và sự kiện); test vector `v5`; chuẩn hoá lỗi SMTP (không còn địa chỉ); luật config |
| Integration (Postgres 18.6, PgBouncer, Redis, Mailpit) | Migration up → down → up; catalog và quyền trên schema/database cho mọi role (5.3), gồm `app_user` đọc `auth."user"` bị `42501` và `auth_user` đọc `public.outbox_events` bị `42501`; adapter bọc qua PgBouncer có transaction (S2); `OutboxWriter.append(ifAbsent)` bằng `app_user`; lockout song song từ 2 pool/instance (đúng số bị chặn, `reward` không xoá thất bại khác); marker event: các test ở mục 5.10 (after-hook lỗi ở từng bước, transaction tạo user commit muộn hơn `GRACE`, hai cron song song, worker dừng lâu); email: hai job cùng delivery song song → một bên nhận `DeliveryLeaseBusyError`; lease hết hạn khi SMTP chậm → owner cũ hoàn tất bị fencing chặn; retry trước khi lease hết không trả thành công; cron đối soát enqueue lại dòng kẹt với generation mới; **hai cron đối soát chạy song song** trên cùng dòng kẹt (`PENDING` và `SENDING` hết lease) → đúng một job mới, generation chỉ tăng 1; chạy lại trong thời gian chờ → không có job mới; job `-g<n>` fail trước khi claim → lần đối soát sau vẫn enqueue được `-g<n+1>`; lỗi tạm thời → dòng về `PENDING` với cả hai cột lease NULL; INSERT/UPDATE vi phạm CHECK lease (`PENDING` còn `lease_until`, `SENDING` thiếu owner) bị DB từ chối; ràng buộc chuẩn hoá (5.16) bị DB từ chối: `SENT`/`FAILED` thiếu `completed_at`, `PENDING` có `completed_at`, trạng thái cuối còn `params_enc`, `last_error_code` ngoài 4 mã, `locale` sai định dạng, `idempotency_key` sai tiền tố của `template`; `app_user` `UPDATE` cột snapshot (`recipient_enc`, `template`, `locale`, `idempotency_key`, `public_id`) bị `42501`; vượt `NOTIFICATIONS_MAX_TOTAL_ATTEMPTS` → `FAILED` + event; lỗi vĩnh viễn → `FAILED` + event được commit trước khi job fail; hạn chót tổng đóng connection (SMTP giả treo); token `account` là bản mã; xoay refresh token |
| E2E (supertest + Mailpit) | Web bằng cookie: đăng ký → email → xác thực → đăng nhập (`Set-Cookie` có `HttpOnly`, `Secure` khi bật, `SameSite` theo config, domain theo config) → `/v1/me` bằng cookie → đăng xuất (session bị xoá ở DB, `Set-Cookie` xoá cookie, cookie cũ → `401`); mobile bằng bearer (`set-auth-token`); API key → `/v1/me` trả user sở hữu, log có id của key; ban user → cookie, bearer và API key đều `401`; xoá user → key mất theo; quên mật khẩu → đặt lại → cookie và bearer cũ `401`; **đổi mật khẩu** (client gửi `revokeOtherSessions: false`) → session khác (cookie và bearer) `401`, session hiện tại được thay; `/token` bằng session cũ `401`; 2FA: bật (cần session mới), đăng nhập → chờ 2FA: cookie `two_factor` không lấy được bearer, không gọi được `/token`, `/api-key/create` và Bull Board; TOTP → mã dự phòng → email thông báo; thao tác nhạy cảm với session cũ → `403 reauthentication_required`; JWT/JWKS verify bằng `jose`; xoay JWKS (khoá cũ vẫn verify được trong grace); Google/OIDC giả với ma trận liên kết ở 5.4; `external`: token qua header và qua cookie, cả hai cùng lúc → `400 ambiguous_credentials`, token máy → `401`; cookie session + bearer cùng lúc ở `local` → `400`; route impersonate không tồn tại; health không chạm pool auth |
| CSRF | Toàn bộ ma trận ở mục 5.6.2, chạy trên route Nest và trên `/api/auth/*` (kiểm của mình chạy trước handler): thiếu `Origin` (có hoặc không có `Sec-Fetch-Site`, chỉ có `Referer`), cross-site, cùng site khác origin, `Sec-Fetch-Site: same-site`, chỉ có cookie `two_factor`, cookie + bearer, chỉ bearer, callback OAuth dạng GET cross-site vẫn chạy (và `state` sai bị từ chối), cookie token ở `external` |
| Cookie | Theo từng môi trường: `Set-Cookie` của session có `HttpOnly`, `Path=/`, `SameSite` theo config; `Secure` và tiền tố `__Secure-` ở production; không có `Domain` khi `AUTH_COOKIE_DOMAIN` trống; có `Domain` đúng khi bật. Luật config: `AUTH_SECURE_COOKIES=false` với `NODE_ENV=production` hoặc với base URL không phải localhost → không khởi động; `AUTH_COOKIE_DOMAIN` thiếu cờ xác nhận, không bao host của `AUTH_BASE_URL`/origin CORS, hoặc chỉ một nhãn → không khởi động |
| Đa credential và trùng lặp | Hai header `Authorization`; hai header API key; một header API key chứa danh sách; hai header `Cookie`; cùng tên cookie session hai lần; `__Secure-<tên>` cùng `<tên>`; cookie `two_factor` trùng; `Authorization` sai dạng; cookie + bearer; header + cookie ở `external` → tất cả `400 ambiguous_credentials` trên route Nest, `/api/auth/*` và Bull Board, trước khi chạm DB. Luật config: header API key trùng tên dành riêng, sai định dạng, cookie external trùng cookie của Better Auth → không khởi động |
| Đăng xuất | Chỉ cookie → session bị xoá, `Set-Cookie` hết hạn đúng `Path` và `Domain` (cả khi bật domain cha); chỉ bearer → session bị xoá; **cookie + bearer của hai session khác nhau** → cả hai bị xoá, cookie được xoá; cookie + bearer với `Origin` cross-site → `403`; xoá ở DB lỗi (thu hồi quyền DELETE) → `503`, không báo thành công |
| Chống lộ email | So sánh nguyên văn status, header (trừ `Date` và id request) và body giữa email mới và email đã có (đăng ký, đổi email); tối đa một thông báo mỗi cửa sổ; đăng ký song song cùng email đều `202`; quên mật khẩu; đăng nhập sai email và sai mật khẩu; khoá theo email không tồn tại |
| Rate limit fail-closed | `429` + `Retry-After` theo IP và theo tài khoản; thu hồi quyền trên `rate_limit` hoặc `login_attempts` → `503` ở `/sign-in/email` và `/two-factor/verify-totp`; Toxiproxy cắt DB auth → `503`, không bao giờ `500`; header IP giả bị ghi đè |
| Hồi quy HTTP của SP1 (D6) | `413` với body có `Content-Length` lớn và với **body chunked** vượt giới hạn trên cả route Nest lẫn `/api/auth/*`; `415` trên cả hai; `400 malformed_request`; `rawBody`; merge-patch; CORS `credentials`; idempotency và throttler theo principal thật; redirect OAuth (`302`, `Location`, `Set-Cookie` giữ nguyên) |
| PII | Các test đường lỗi ở 5.14 |
| Chaos | Redis sập: đăng nhập, `/v1/me`, 2FA chạy; email đợi trong outbox rồi được gửi. SMTP dừng: job retry, breaker mở, api vẫn ready; email kẹt được đối soát sau khi SMTP lên lại **trong retry budget**. S2-R61: hết budget → FAILED, reconcile không gửi lại; user yêu cầu verification/reset mới |
| Bull Board | IP ngoài allowlist `403`; không credential `401`; user thường `403`; API key `403`; admin (cookie) `200`; mutate bị từ chối; không có authorizer → worker không khởi động |
| Kiến trúc | Luật 10–16 kèm fixture phải fail |
| Chuẩn hoá | Test catalog so cột của mọi bảng SP2 (kể cả bảng Better Auth sau S3) với danh sách cột đã phân tích ở 5.16: có cột mới chưa phân tích thì fail, buộc cập nhật bảng chuẩn hoá |

---

## 9. Docker, Compose, CI

- **Dockerfile:** không đổi stage. Template vào `dist/` qua `assets` của `nest-cli.json`. Đo kích thước image; vượt 200 MB thì báo Sếp kèm phương án `mjml-core` + `mjml-preset-core`.
- **Compose:**
  - `mailpit` (`axllent/mailpit:v1.31.2`, pin digest bằng `docker buildx imagetools inspect`, `IMAGE_MAILPIT` trong `docker/images.env`), port 1025 và 8025 chỉ bind `127.0.0.1`.
  - `postgres`: thêm env cho `auth_user` vào script init.
  - `pgbouncer`: thêm `auth_user` và `max_prepared_statements` (theo S2b).
  - `api`/`worker`: `DB_AUTH_PASSWORD`; chỉ worker có `SMTP_*`; `migrate` đặt `DB_AUTH_PASSWORD: ''`.
  - `worker`: dashboard bật, port `127.0.0.1:${QUEUE_DASHBOARD_PORT_HOST}:3002`, allowlist là dải mạng của compose; `WORKER_QUEUES` gồm `notifications`.
- **CI:**
  - Integration có container Mailpit.
  - **Kiểm tra lệch schema Better Auth:** migrate rồi chạy `auth generate`; có SQL cần áp dụng thì fail (theo S3c).
  - osv-scanner và Trivy quét dependency mới; `oasdiff` chỉ thấy `/v1/me`.
- **Renovate:** nhóm theo mục 3 (ngoại lệ `@better-auth/utils`), nhóm `@bull-board/*`, digest của Mailpit.

---

## 10. Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Tự mount phải tự giữ hành vi mà thư viện mount thường lo (body, CORS, guard, map lỗi, đăng xuất) | Spike S1 (g)–(i); test e2e của `AuthMountMiddleware` cho 413 chunked, CORS, lỗi storage → 503, burst → 429 problem+json, đăng xuất lỗi → 503; fallback thallesp + patch upstream cần Sếp duyệt |
| Better Auth đổi API/mã lỗi theo minor; lịch sử 22 GHSA | Pin, nâng theo nhóm; test phủ mã lỗi; kiểm lệch schema ở CI; adapter bọc có test contract |
| Adapter bọc phụ thuộc hình dạng `where` mà Better Auth dùng cho `account` | Where lạ thì ném lỗi (fail loud), cộng S5; fallback plugin Kysely |
| JWT đã phát còn hiệu lực tới `exp` sau khi thu hồi | TTL ngắn từ config; ghi ADR 0010 |
| Khoá tài khoản bị lạm dụng để chặn nạn nhân | Thời gian khoá ngắn, đặt lại mật khẩu không bị khoá, rate limit theo IP |
| Lệch đồng hồ giữa pod ảnh hưởng cửa sổ lockout (`Date.now()`) | NTP; sai số dưới 1 giây so với cửa sổ tính bằng phút |
| `RateLimiterPostgres` dùng named prepared statement qua PgBouncer | S2b; fallback pool auth đi thẳng Postgres |
| Token session lưu dạng gốc trong `auth.session` | Schema chỉ `auth_user` đọc được, TLS, backup mã hoá, TTL session; ghi ADR 0010 |
| Không cache session làm thêm một lookup DB mỗi request | Lookup theo khoá unique; đo p95 ở load test (D1) |
| Hai pool DB mỗi process | `DB_AUTH_POOL_MAX` nhỏ, PgBouncer; công thức connection trong README |
| Email gửi at-least-once (crash, lease bị lấy lại) | Fencing giữ đúng trạng thái; `Message-ID` cố định; ghi ADR 0006 |
| Thư người dùng tự yêu cầu lại được (xác thực, đặt lại mật khẩu, xác nhận đổi email) và thông báo "tài khoản đã tồn tại" mất nếu process chết hoặc DB app lỗi giữa commit của auth và dòng `email_deliveries` (S2-R75) | Chấp nhận: người dùng yêu cầu lại; log ERROR + `identity_auth_email_request_failed_total` (alert > 0). Thông báo bảo mật không nằm trong rủi ro này: marker bền + cron. ADR 0006/0010 |
| Email xác thực trỏ tới token của lần đăng ký bị rollback | Link trả `invalid_or_expired_token`; chấp nhận |
| Request ra ngoài của Better Auth (Google, IdP của `genericOAuth`) không đi qua `HttpClient` | URL chỉ lấy từ config, production `https`; ngoại lệ ghi ADR 0016 và mục 11.2 |
| Checkpoint trễ hơn thời gian giữ outbox/inbox | Metric độ trễ + cảnh báo + runbook |
| Quy tắc từ chối đa credential làm hỏng client gửi cả cookie lẫn bearer | Lỗi `400` rõ ràng ngay khi tích hợp; README ghi quy tắc |
| handlebars gần như chỉ còn bảo trì; mjml là CJS và nặng | Compile file trong repo, strict; S6; đo image |
| Bảng Better Auth lệch luật chuẩn hoá (`two_factor_enabled` dẫn xuất, `role` chuỗi tự do có thể đa trị, `scope`/`backup_codes`/`permissions` đa trị; mục 5.16b) | Ngoại lệ "schema do thư viện sở hữu"; code của mình không ghi các cột đó; kiểm lệch schema ở CI. **Follow-up SP3:** RBAC không dựa vào chuỗi `role` đa trị; nếu S3 xác nhận chỉ có một role thì cân nhắc `CHECK (role IN (…))` sau khi thử với plugin `admin` |
| Snapshot người nhận trong `email_deliveries` lệch với email hiện tại của user | Chủ ý (mục 5.16c): thư đi tới địa chỉ lúc yêu cầu; bất biến nhờ grant `UPDATE` theo cột |

**Follow-up chuẩn hoá cho bảng của SP1** (chỉ đánh giá, SP2 không sửa migration SP1; chủ sở hữu quyết định ở plan kế tiếp đụng tới `core`):

| Bảng | Đánh giá | Follow-up |
|---|---|---|
| `outbox_events` | Khoá `{id}`, `{event_id}`. Là nhật ký event bất biến (snapshot) cộng trạng thái relay (`published_at`, `publish_attempts`, `claimed_until`) đơn trị theo khoá. `payload`, `headers` là tài liệu mờ của envelope. Nghi vấn: theo quy ước tên `context.aggregate.verb` (`event-definition.ts`), `type` có thể xác định `aggregate_type` (phụ thuộc bắc cầu `id → type → aggregate_type`), nhưng caller truyền `aggregate.type` riêng và không có ràng buộc nào ép khớp | Xác nhận quy ước. Nếu đúng là phụ thuộc hàm: thêm `CHECK` ép `aggregate_type` khớp đoạn giữa của `type`, hoặc validate ở `EventPublisher` và ghi lý do snapshot. `version`, `publish_attempts` đã có `CHECK` |
| `processed_events` | Khoá `{consumer, event_id}`; BCNF. `processed_at` luôn bằng `created_at` (bảng chỉ INSERT, cả hai `DEFAULT now()`): hai cột cùng một dữ kiện | Mức thấp: bỏ `processed_at` (index cleanup chuyển sang `created_at`) hoặc ghi lý do giữ |
| `scheduled_tasks` | Khoá `{id}`, `{org_id, key}`; BCNF. `key` có `CHECK`. `timezone` (tập IANA, app validate bằng `normalizeTimezone`) và `job_name` (tập job đăng ký trong code của nhiều module) là chuỗi không có `CHECK` ở DB. `payload` là tài liệu mờ | Thêm `CHECK` định dạng cho `job_name` (như `key`); ghi lý do `timezone` chỉ validate ở app (tập IANA đổi theo bản tzdata, không liệt kê được trong `CHECK`) |

---

## 11. Sản phẩm bàn giao

### 11.1 Code, test, tài liệu
- Hai module, các thay đổi ở `core/` (5.1), migration, script init, compose, CI. Mọi test ở mục 8 xanh.
- **ADR 0010 — Better Auth và các chế độ xác thực:**
  - cách truyền credential theo loại client, quy tắc đa nguồn, CSRF;
  - `AUTH_MODE`, hợp đồng claim của `external`;
  - D1–D10, liên kết tài khoản fail-closed, lockout atomic;
  - kết quả spike, fallback tự mount;
  - giới hạn đã biết (token session, JWT tới `exp`, lệch đồng hồ).
- **Cập nhật ADR:**
  - 0005: schema `auth`, `auth_user`, siết quyền `PUBLIC`.
  - 0006: state machine email, lease và fencing, at-least-once, `append(ifAbsent)`, marker event trên dòng user, ràng buộc chuẩn hoá của `email_deliveries` (5.16).
  - 0007: chủ của body parser, giới hạn body của `/api/auth/*`, `@PublicRoute()`, map lỗi, CSRF.
  - 0009: `generateId: 'uuid'` + `uuidv7()`, event id `v5`.
  - 0013: số đo.
  - 0016: `toWebFetch` và ngoại lệ request ra ngoài của Better Auth.
- **README:** cách truyền credential theo client, quy tắc đa nguồn, `AUTH_MODE`, route `/api/auth/*`, runbook (admin đầu tiên, xoay `BETTER_AUTH_SECRET` có downtime, xoay API key, Bull Board, user chưa có marker event, email kẹt, đăng xuất ở `external`).
- Bảng số đo (image, khởi động).

### 11.2 Sửa spec cha

**Đối chiếu thực thi Task 49:** giữ nhánh tự mount đã duyệt ở R36 của review trước thực thi (khác S2-R36 về map lỗi). Spike S1 xác nhận; xem ADR 0010.

| Chỗ | Hiện tại | Sửa thành | Nguồn |
|---|---|---|---|
| §11 Better Auth | `@better-auth/cli generate` | `auth generate` (package `auth` 1.7.6) | D8, research 1.6 |
| §11 tính năng, "Thu hồi" | Session DB kèm Redis secondary storage | Chỉ Postgres, `cookieCache` tắt; lý do R21; cache chỉ khi có số đo | D1 |
| §11 rate limit đăng nhập; phụ lục C mục 2 | Redis hoặc DB | `storage: 'database'` + lockout `RateLimiterPostgres` atomic | D2 |
| §9 Redis sập | Đăng nhập, 2FA fail-closed | Không phụ thuộc Redis; fail-closed khi storage Postgres lỗi | D1, D2 |
| §17 Job | `@bull-board/nestjs` | `@bull-board/api` + `@bull-board/express` 9.10.1, trong worker | D9 |
| §17 Auth | thiếu | `@better-auth/api-key`, `@better-auth/kysely-adapter` trực tiếp; `sso` chỉ khi SAML; `express`, `raw-body` trực tiếp; Better Auth tự mount (không `@thallesp/nestjs-better-auth`, ruling R36). Nhóm version cùng nhịp trừ `@better-auth/utils` (0.4.2) | research 1.2, 2.2 |
| §0.4 ID | Better Auth sinh qua `generateId` | `generateId: 'uuid'` + `DEFAULT uuidv7()` | D3 |
| §4.1 cuối | Bảng Better Auth trong allowlist RLS | Schema `auth` riêng, chỉ `auth_user`; `PUBLIC` không có quyền trên `public` | D4 |
| §4.1 / §11 `FieldCipher` | AAD `table:column:orgId:pk` | Với `auth.account`: `auth.account:<cột>:-:<providerId>/<accountId>` (định danh tự nhiên bất biến, vì PK do DB sinh). Với `email_deliveries`: `public_id` sinh ở app | mục 5.9 |
| §11 `FieldCipher` "có job mã hoá lại" | Chưa có chủ | Hoãn sang SP7 (runbook + job); SP2 chỉ dùng keyring nhiều `kid` | mục 2 |
| §11 xoay khoá | JWKS, API key "làm ở sub-project tương ứng" | JWKS: thiết kế trong SP2 (`jwks.rotationInterval`/`gracePeriod`). API key: user tạo mới và xoá cũ, có hạn mặc định (SP2). Secret webhook: SP6 | mục 5.4, 5.6.3 |
| §11 `AUTH_MODE` "chuỗi `AuthProvider` nhận token máy"; `Principal` api_key/service | Chưa rõ | SP2: `external` chỉ nhận token user theo claim cấu hình; API key cho principal là user sở hữu (id của key ở context). Service principal và API key theo org: SP3 | mục 5.6 |
| §11 (thêm) SSRF, ADR 0016 | Mọi HTTP ra ngoài qua `HttpClient` | Ngoại lệ: request ra ngoài **của Better Auth** (Google OAuth, discovery/token/userinfo của IdP `genericOAuth`) đi bằng fetch của thư viện, không qua `HttpClient`; URL chỉ lấy từ config, production `https`. JWKS ở `external` đi qua `HttpClient` (`toWebFetch`) | mục 5.6.3, 10 |
| §3.5 | Raw body bằng `rawBody: true` | `core/http` đọc body bằng `jsonBodyParser` (`raw-body`, giới hạn theo stream, đặt `req.rawBody`) cho mọi route trừ prefix khai báo qua `HTTP_BODY_PARSER_SKIP_PREFIX`; `/api/auth/*` do `AuthMountMiddleware` của identity đọc sau khi kiểm credential/CSRF; ở `external` không bỏ qua prefix nào | D6 |
| §3.1 `202` | Luôn kèm operation | Ngoại lệ: `202` chung của đăng ký/đổi email không có body | chống lộ email |
| §11 "Session: cookie … + `trustedOrigins`" | Chỉ Better Auth | Thêm: CSRF cho mọi request xác thực bằng cookie (route Nest, Bull Board, cookie token ở `external`) cùng danh sách origin | mục 5.6.2 |
| §11 "Session: cookie `HttpOnly; Secure; SameSite=Lax`" | Cố định | `HttpOnly` và `Path=/` cố định; `Secure` bắt buộc ngoài dev/test localhost; `SameSite` từ config (mặc định `Lax`); `Domain` chỉ khi mọi subdomain tin cậy (cờ xác nhận). Cookie ở `external` do gateway/IdP phát và sở hữu cờ | mục 5.4 |
| §15 ADR 0010 | Better Auth + CASL | Better Auth + chế độ xác thực; CASL bổ sung ở SP3 | |

---

## Phụ lục A — Bằng chứng từ mã nguồn

Tarball tải bằng `npm pack` vào scratchpad; package đã cài đọc trong `node_modules`. Đường dẫn là file trong package.

- **A.1 `uuid` 14.0.2** (`node_modules/uuid/dist/v5.d.ts:3`): `declare function v5(value: string | Uint8Array, namespace: UUIDTypes, …): string`, tức tên trước, namespace sau.
  - `uuid` đã có trong `dependencies` (`package.json`: `"uuid": "14.0.2"`).
  - Node không có hàm v5: `typeof require('crypto').randomUUIDv5` → `undefined`; `node:crypto` chỉ có `randomUUID` (v4).
  - Test vector sinh bằng chính package: `v5('nestjs-saas-boilerplate/identity-events', v5.URL)` = `87857401-f233-5789-839c-2dc5fb919229`; `v5('identity.user.registered:019dd1a5-9235-70db-8d57-54ef901d8185', <ns>)` = `59f229d2-931e-5ad8-8c7c-5ee7dbfd34e4`.
- **A.2 `better-auth` 1.7.6 — `advanced`** (`@better-auth/core/dist/types/init-options.d.mts`):
  - `ipAddressHeaders` (243), `useSecureCookies` (281), `disableCSRFCheck` (295), `disableOriginCheck` (310);
  - `crossSubDomainCookies { enabled, domain }` (314), `defaultCookieAttributes` (337), `cookiePrefix` (347);
  - `session.freshAge` (1055).
- **A.3 Liên kết tài khoản:**
  - `accountLinking { enabled, disableImplicitLinking, requireLocalEmailVerified (mặc định true), trustedProviders, allowDifferentEmails, updateUserInfoOnLink }` (`init-options.d.mts:1068-1150`).
  - Điều kiện chặn liên kết ngầm (`better-auth/dist/oauth2/link-account.mjs:139`): `(!isTrustedProvider && !userInfo.emailVerified) || (requireLocalEmailVerified && !dbUser.user.emailVerified) || enabled === false || disableImplicitLinking === true`. Nghĩa là provider tin cậy được liên kết **dù** `emailVerified` false.
  - Liên kết tường minh (`link-account.mjs:43`) dùng cùng điều kiện tin cậy/`emailVerified`.
  - Kết quả của `mapProfileToUser` ghi đè `emailVerified`: Google `{ …, emailVerified: user.email_verified, ...userMap }` (`@better-auth/core/dist/social-providers/google.mjs:124-131`); genericOAuth `{ …, emailVerified: raw.emailVerified, ...mapped }` (`better-auth/dist/plugins/generic-oauth/index.mjs:229-236`). Kiểu `OAuthMappedUser.emailVerified?: boolean` (`core/dist/oauth2/oauth-provider.d.mts:96-102`).
- **A.4 Plugin:**
  - `two-factor/index.mjs:287-291`: khi cần 2FA, plugin `deleteSessionCookie` + `deleteSession` rồi đặt cookie `two_factor` (`constant.mjs:2`), trả `twoFactorRedirect: true` (326).
  - Secret TOTP được `symmetricEncrypt` (`index.mjs:135`).
  - Mã dự phòng chỉ mã hoá khi `storeBackupCodes === "encrypted"`, mặc định lưu JSON thô (`backup-codes/index.mjs:17-23`); option nằm trong `backupCodeOptions` (`types.d.mts:33`).
  - JWT: `jwks.rotationInterval` (mặc định tắt), `jwks.gracePeriod` (mặc định 30 ngày), `disablePrivateKeyEncryption` (mặc định false) (`plugins/jwt/types.d.mts:18,68-80`).
- **A.5 API chung:**
  - `onAPIError { throw, onError(error, ctx), errorURL }`: `onError` trả `void`, không thay được response (`init-options.d.mts:1450-1470`).
  - `hooks.before/after`, `disabledPaths?: string[]` (1515-1528); `revokeSessionsOnPasswordReset` (775).
  - `runBeforeHooks` (`better-auth/dist/api/dispatch.mjs:64-104`): hook trả `{ context }` thì được trộn vào context của endpoint (sửa được `body`), trả object khác thì trở thành response (dừng sớm).
  - `/change-password` nhận `revokeOtherSessions` tuỳ chọn từ client; khi `true` thì `deleteUserSessions` rồi tạo session mới (`api/routes/update-user.mjs:92,160-185`).
  - `sensitiveSessionMiddleware` chỉ đòi session hợp lệ, không kiểm độ mới; chỉ `freshSessionMiddleware` kiểm `freshAge` (`api/routes/session.mjs:304-345`); `/two-factor/disable` dùng `sensitiveSessionMiddleware` (`two-factor/index.mjs:195`).
  - Mã lỗi: `BASE_ERROR_CODES` export từ `better-auth` (`dist/index.d.mts:26`); plugin có `$ERROR_CODES` (two-factor `index.mjs:345`, admin, generic-oauth, `@better-auth/api-key`).
- **A.6 Adapter:**
  - `database` nhận `DBAdapterInstance` (`init-options.d.mts:536`).
  - `kyselyAdapter(db, { type, transaction, usePlural, debugLogs })` trả `(options) => DBAdapter`, không có `schemaName` (`@better-auth/kysely-adapter/dist/index.d.mts:60-94`).
  - `DBAdapter.transaction(cb)` đưa adapter giao dịch cho `cb` (`core/dist/db/adapter/index.d.mts:484`).
  - `updateWithHooks(data, where, model)` gọi `update.before(data, context)` **không** kèm `where` (`better-auth/dist/db/with-hooks.mjs:44-61`); `updateAccount(id, data)` truyền `where: [{ field: "id", value: id }]` (`db/internal-adapter.mjs:695-699`). Kiểu hook update là `Partial<Account>` (`init-options.d.mts:1382`).
- **A.7 `@better-auth/api-key` 1.7.6** (`dist/types-y22rgFHR.d.mts`):
  - `referenceId` là id của chủ key (42-49); `references?: "user" | "organization"`, mặc định `"user"` (437-441);
  - `enableSessionForAPIKeys` mặc định false (385); `apiKeyHeaders` (217).
  - `dist/index.mjs` không kiểm `banned` của user khi verify.
- **A.8 Mount và body:**
  - `SkipBodyParsingMiddleware` gọi `next()` ngay khi đường dẫn khớp basePath, không parse (`@thallesp/nestjs-better-auth/dist/index.mjs`, hàm `SkipBodyParsingMiddleware`).
  - Handler được mount bằng `this.adapter.httpAdapter.use(...)`, option `middleware(req, res, next)` bọc lời gọi handler (cùng file, khoảng 880-905).
  - **A.8b** (review trước thực thi, 2026-09-27): trong đoạn đó `next = () => handler(...)` và promise trả về bị bỏ, không await (`index.mjs:892-896`); lỗi ném ở `onRequest` của better-call nằm ngoài try/catch của router (`better-call/dist/router.mjs:100-102`), nên `auth.handler` reject → unhandled rejection. 429 của rate limit IP trả thẳng `Response` ở `onRequest` (`better-auth/dist/api/rate-limiter/index.mjs:64-69`), không qua hook.
  - `toNodeHandler` của better-call gọi `getRequest({ base, request })` **không** có `bodySizeLimit` (`better-call/dist/node.mjs:3-9`). Trong `get_raw_body`, khi không có `bodySizeLimit` và `content-length` rỗng (chunked), điều kiện `size > length` với `length = NaN` luôn false, tức không giới hạn (`adapters/node/request.mjs:47-90`).
  - Body đã parse được serialize lại (`request.mjs:108-116`).
- **A.9 `rate-limiter-flexible` 11.2.1** (`node_modules/rate-limiter-flexible/lib/RateLimiterPostgres.js`):
  - option `tableName`, `schemaName`, `tableCreated` (16-31);
  - DDL `key varchar(255) PRIMARY KEY, points integer NOT NULL DEFAULT 0, expire bigint` (184-188);
  - `_upsert` là `INSERT … ON CONFLICT(key) DO UPDATE SET points = points + ($2) … RETURNING`, với `name: 'rlflx-upsert'` (named prepared statement) và `Date.now()` của app (291-313).
  - `_reward` là `_upsert(key, -points)` (`RateLimiterStoreAbstract.js:209-218`).
- **A.10 Rate limit của Better Auth:** `consume` của storage không có try/catch (research 1.5).
- **A.11 `nodemailer` 10.0.10** (`dist/esm/smtp-connection/index.js`):
  - lỗi có `response`, `responseCode`, `command` (785-793), `rejected`, `rejectedErrors` (1574-1576);
  - timeout socket gọi `_onTimeout` → `_onError(ETIMEDOUT)` và `_destroy` (846-853);
  - `SMTPPool.close()` đóng mọi connection (`smtp-pool/index.js:99-114`); `SMTPTransport.close()` không đóng connection đang gửi (`smtp-transport/index.js:332-336`).
- **A.12 `ResiliencePolicies`** (`src/core/resilience/policies.service.ts:7`): mỗi provider có `{ retrying, single }`.
- **A.13 Kiểm origin và callback của Better Auth** (`better-auth/dist/api/middlewares/origin-check.mjs`):
  - `originCheckMiddleware` bỏ qua GET/OPTIONS/HEAD (44).
  - `validateOrigin` chỉ chạy khi `headers.has("cookie")`, bất kể cookie gì (101, 108).
  - Thiếu `Origin` thì lấy `Referer` (100). `Origin: null` chỉ được suy ra khi `sec-fetch-site` là `same-origin` (109).
  - So khớp bằng `matchesOriginPattern`, có hỗ trợ wildcard (112-113).
  - Request không có cookie đi qua `validateFormCsrf` dựa trên Fetch Metadata (123-140).
  - Callback OAuth: `createAuthEndpoint("/callback/:id", { method: ["GET", "POST"] })`. POST nhận `application/x-www-form-urlencoded` rồi redirect sang GET (`api/routes/callback.mjs:24-47`).
  - `genericOAuth` dùng endpoint lõi `callback/:id`, không có endpoint riêng (`plugins/generic-oauth/index.mjs:66`).
- **A.14 Plugin `bearer`** (`plugins/bearer/index.mjs:23-47`):
  - Hook `before` chạy khi có `authorization`, verify HMAC của token, rồi `setRequestCookie(headers, sessionToken.name, token)` và trả `{ context: { headers } }`. Nghĩa là bearer **ghi đè** cookie session có sẵn trong request.
  - Hook `after` đặt header `set-auth-token` (50-66).
- **A.15 Đăng xuất** (`api/routes/sign-out.mjs:36-50`):
  - Chỉ đọc token từ **cookie** đã ký (sau khi plugin `bearer` có thể đã ghi đè).
  - `deleteSession` nằm trong `try/catch` chỉ log lỗi, rồi vẫn gọi `deleteSessionCookie` và trả thành công.
  - `deleteSessionCookie` gọi `expireCookie(ctx, ctx.context.authCookies.sessionToken)`, tức dùng đúng thuộc tính (`Path`, `Domain`) của cookie đã cấu hình (`cookies/index.mjs:241-255`).
- **A.16 Đọc cookie session** (`cookies/index.mjs:261-266`): `parseCookies(...)` rồi `parsedCookie.get("__Secure-" + name) ?? parsedCookie.get(name)`. Bản `__Secure-` được ưu tiên âm thầm, và giá trị trùng tên bị gộp trong `Map`.
- **A.17 `rate-limiter-flexible` 11.2.1:**
  - `block(key, secDuration)` gọi `_block(rlKey, this.points + 1, msDuration)` (`RateLimiterStoreAbstract.js:140-142`).
  - `reward` là `_upsert(key, -points, duration)` (209-218).
  - Trong `_upsert` của Postgres, khi dòng đã hết hạn (`expire <= now`) thì `points` được **đặt** bằng tham số (tức `-1` với reward), không cộng dồn (`RateLimiterPostgres.js:305-312`). Đây là lý do một refund tới muộn, nếu dùng khoá không có số hiệu cửa sổ, sẽ trừ vào cửa sổ mới.
- **A.18 Header trùng trong Node** (tài liệu `http.IncomingMessage.headers` của Node.js):
  - Bản trùng của một số header, trong đó có `authorization`, bị **bỏ**.
  - `set-cookie` luôn là mảng; `cookie` trùng được nối bằng `; `; các header khác được nối bằng `, `.
  - `req.rawHeaders` giữ nguyên mọi dòng header theo thứ tự nhận. Vì vậy kiểm trùng phải làm trên `rawHeaders`.
- **A.19 `NODE_ENV`** (`src/core/config/app.config.ts`): `z.enum(['development', 'test', 'production'])`. Luật production chỉ chạy khi `nodeEnv === 'production'` (`src/core/config/validate-all.ts:26`), nên staging phải chạy `production` và chịu luật production.
- **A.20 Bảng SP1 cho follow-up chuẩn hoá** (mục 10):
  - `src/migrations/core/Migration20260925032035_outbox_inbox.ts`: `outbox_events` có `type`, `aggregate_type` là hai cột `TEXT NOT NULL` độc lập, không có `CHECK` liên hệ; `processed_events` có cả `processed_at` và `created_at` cùng `DEFAULT now()`, bảng chỉ được `INSERT` (grant cho `app_user`) và `SELECT, DELETE` (cho `app_relay`).
  - `src/core/events/event-definition.ts:9,28`: tên event phải theo dạng `context.aggregate.verb`. `src/core/outbox/outbox.writer.ts`: `aggregate_type` lấy từ `e.aggregate.type` do caller truyền, không suy từ `type`.
  - `src/migrations/core/Migration20260925040844_scheduled_tasks.ts`: chỉ `key` có `CHECK`; `job_name`, `cron`, `timezone` là `TEXT NOT NULL`. `timezone` được validate ở `src/core/scheduler/scheduled-task.service.ts` (`normalizeTimezone`).
