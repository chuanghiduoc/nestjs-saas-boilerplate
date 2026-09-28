# 0010 — Better Auth và các chế độ xác thực

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-27; đối chiếu thực thi 2026-09-28

## Bối cảnh

Boilerplate cần đăng ký, đăng nhập, xác thực email, quên mật khẩu và 2FA cho web/mobile; API key cho máy và JWT cho dịch vụ khác. Một số dự án dùng IdP ngoài qua gateway. Quyết định dưới đây đối chiếu code đã commit và ledger S2-R1–S2-R74 (final fix wave). Kết quả spike bên dưới giữ nguyên như bằng chứng lịch sử, không thay cho các quyết định thực thi này.

## Quyết định

### Nền tảng và hợp đồng client

Better Auth 1.7.6 nằm sau port `AuthProvider`; import thư viện chỉ trong `identity/infra/better-auth/**`. Tự mount bằng `AuthMountMiddleware`, gọi `await auth.handler(Request)` trong try/catch. Không dùng thallesp 2.8.0 vì nhánh không await handler làm lỗi storage ở `onRequest` thành unhandled rejection; không dùng `toNodeHandler` vì cần giữ quyền đọc body và map response. Chi phí là lớp nối HTTP của mình và test hồi quy khi nâng thư viện. Spike S1 đo 413 sau 73–81 ms; đây là phép đo spike, không phải SLO production.

- Web dùng cookie session; mobile dùng `Authorization: Bearer <session token>`; máy dùng header từ `AUTH_API_KEY_HEADER` (mặc định `x-api-key`). Principal của API key là user sở hữu; id key nằm trong credential context. JWT phát cho dịch vụ khác, API này không nhận JWT đó.
- Cookie cố định `HttpOnly`, `Path=/`; `Secure` bắt buộc ngoài dev/test localhost; `SameSite` từ config. Host-only là mặc định; `Domain` cần xác nhận mọi subdomain tin cậy và kiểm Public Suffix List (S2-R23).
- Kiểm `rawHeaders`: đa credential, header/cookie trùng hoặc Authorization sai dạng → `400 ambiguous_credentials`. Ngoại lệ duy nhất là sign-out cookie + bearer, phải thu hồi cả hai. Credential sai vẫn trả 401 trên route public.
- CSRF áp cho mọi thao tác thay đổi trạng thái xác thực bằng cookie: route Nest, auth mount, dashboard và cookie IdP ở external. `Origin` phải thuộc danh sách tin cậy; chỉ khi thiếu Origin mới dùng `Sec-Fetch-Site: same-origin`. Better Auth vẫn bật lớp kiểm riêng, kể cả môi trường test.
- `local`: Better Auth; `hybrid`: thêm một OIDC qua `genericOAuth`; `external`: không instance Better Auth, auth pool hay auth mount, chỉ verify token user của IdP qua `jose`/JWKS cố định và `HttpClient`. Gateway/IdP sở hữu việc phát/xoá cookie external.
- Liên kết theo email chỉ khi provider thuộc `AUTH_TRUSTED_PROVIDERS`, claim `email_verified === true` và user local đã xác thực; S2-R49 còn chặn implicit linking khi user có credential.
- D1–D10: session chỉ ở Postgres, tắt cookie cache; rate limit IP của Better Auth dùng database, lockout mật khẩu dùng `RateLimiterPostgres` atomic theo cửa sổ và refund đúng cửa sổ. 2FA dùng đúng một `accountLockout` có sẵn, DB-backed và cấu hình được (S2-R6/S2-R44). Không phụ thuộc Redis cho session/đăng nhập. Schema `auth`, role `auth_user`; `generateId: 'uuid'` trên Kysely/Postgres tắt sinh id phía app, để `DEFAULT uuidv7()` sinh v7 (S2-R41, đã kiểm integration). Impersonation tắt. Event đăng ký dùng UUIDv5 xác định và marker bền `registered_event_emitted_at`.

### Các quyết định sau spike

| Ruling | Quyết định và lý do | Chi phí / giới hạn còn lại |
| --- | --- | --- |
| S2-R7 | Không bật `account.encryptOAuthTokens`: không có keyring, AAD theo dòng, và không mã hoá `idToken`. Bọc DBAdapter bằng `FieldCipher`, kể cả transaction và account đọc qua join. AAD: `auth.account:<cột>:-:<providerId>/<accountId>`. | Phải duy trì adapter bọc; nâng Better Auth cần kiểm lại mọi đường đọc/ghi. |
| S2-R32 | `pool.on('connect')` gắn listener `error` thường trực cho từng client vật lý, log tên/mã lỗi và không ném lại. Kysely checkout client không tự giữ listener của pool; socket đứt có thể làm process sập trước khi bắt query rejection. | Thêm listener suốt đời client; query vẫn reject và caller phải xử lý. MikroORM core đã có cùng cơ chế. |
| S2-R37 | `requireIdTokenVerification: true`; boot kiểm provider OIDC đã đăng ký, nếu không thì dừng. Better Auth có thể chỉ log rồi bỏ provider khi discovery không đủ thông tin verify. | Boot phụ thuộc cấu hình/discovery hợp lệ; không chấp nhận id_token chưa kiểm chữ ký. |
| S2-R38/S2-R42/S2-R66 | User đã xác thực, session mới: luôn gửi `change-email-confirmation` tới địa chỉ cũ, kể cả đích đã có tài khoản. Bấm link mới kiểm đích: trống thì gửi verification tới địa chỉ mới; đã có thì chỉ gửi `existing-account` tới chủ đích, response giống nhau. Không bật `updateEmailWithoutVerification`. | Hai bước thư; residual M1/M5/M6/M7 bên dưới. User chưa xác thực giữ nhánh verification của Better Auth. |
| S2-R40 | Khi luồng của mình chứng minh quyền sở hữu email (verification/reset), reclaim user còn chưa xác thực: xoá session và liên kết OAuth chưa được chứng minh. | Cần transaction riêng; lỗi DB phải dừng luồng. Mật khẩu được giữ để không phá đăng ký bình thường. |
| S2-R44 | Reclaim cả chuyển trạng thái xác thực do change-email; khoá user `FOR UPDATE` trước, rồi DELETE bằng snapshot mới. Session OAuth tạo muộn dùng fence `FOR SHARE`, kiểm liên kết và tính còn sống; bị thu hồi thì ném `OAUTH_SESSION_REVOKED` trước khi đặt cookie. | Một transaction ngắn cho fence mỗi OAuth login. CTE một câu bị loại vì snapshot trước lúc chờ lock bỏ sót session; không chỉ kiểm số dòng vừa xoá. |
| S2-R48 | Reclaim chỉ giữ account `credential`, xoá cả liên kết từ trusted provider khi user còn chưa xác thực. Với `requireLocalEmailVerified`, các liên kết này chỉ có thể đến từ đăng ký với claim email chưa được chứng minh. | User phải liên kết lại IdP; user đã xác thực không bị reclaim. |
| S2-R49 | Từ chối liên kết NGẦM IdP vào user đã có credential; dùng `internalAdapter.findCredentialAccount` trong transaction hiện tại, không checkout pool lần hai. User mật khẩu phải dùng `/link-social` tường minh. | Mất auto-link cho user mật khẩu, implicit idToken thất bại với 401 chung. Đóng bước ghép tài khoản của b′; không biến việc bấm link thành đổi mật khẩu (xem dưới). |
| S2-R45 | Kết quả Better Auth mơ hồ (`getSession` 500 không cause, `verifyApiKey` trả `INVALID_API_KEY`) phải probe auth pool bằng `SELECT 1`: probe lỗi → 503; DB tốt → giữ nghĩa gốc, 500 không giải thích được phải ném lỗi. Dùng probe có deadline và huỷ client lỗi. | Thêm một query. M2: một connection hỏng nhưng probe trên connection khác tốt có thể phân loại sai. M4: junk API key tốn probe và log trước throttler; S2-R51/S2-R53 giới hạn, không xoá hết chi phí các request còn trong quota. Pool cạn có thể chờ khoảng **2 × `DB_AUTH_CONNECTION_TIMEOUT_MS`** (Better Auth rồi probe). |
| S2-R46 | `disableSettingJwtHeader: true`: JWT chỉ phát qua `/token`, không ký JWT và đọc JWKS cho mỗi lần kiểm session. | Client không nhận `set-auth-jwt` tự động; phải gọi `/token`. |
| S2-R47 | Kiểm session/độ mới qua public API `auth.api.getSession`; bỏ bản sao quy tắc bearer của thư viện vì dễ fail-open khi thư viện đổi. S2-R46 đã bỏ chi phí ký JWT. | Vẫn có lookup session; phụ thuộc hợp đồng public API. |
| S2-R51/S2-R53 | Limiter nhỏ trong `core/http` chạy theo IP trước xác thực API key; dùng storage/package của SP1, hash IP cùng helper, kiểm TTL trong production. Consume trước, chỉ `reward()` khi AUTHENTICATED. Không chuyển auth thành guard sau throttler vì principal phải có trước guard. | Một round-trip refund cho key hợp lệ; giảm phạt user chung NAT nhưng flood junk key vẫn làm key hợp lệ cùng IP nhận 429 tới hết window. Cookie/bearer không có limiter mới này; giữ throttler route. |
| S2-R52 | Verification link có **hiệu lực một lần**: click lại không cookie, không session mới, không đổi state, không reclaim. Không bắt buộc token stateless phải bị từ chối ở click thứ hai, để chịu mail scanner/SafeLinks. | Link còn có thể trả thành công; confirmation đổi email replay được trong TTL, dedupe theo S2-R68. Không được dựa vào status replay để suy ra có side effect. |
| S2-R54 | Nếu token response thiếu `id_token`, chấp nhận fallback userinfo được server lấy từ IdP bằng access token qua TLS. Nguồn tin cậy vẫn là IdP. | Phụ thuộc IdP/userinfo; jose có cooldown tải lại JWKS **30 s**, nên kid mới có thể bị từ chối trong cửa sổ rotation. IdP nên công bố key mới trước khi dùng. |
| S2-R55 | External: lỗi token JOSE → 401; lỗi hạ tầng JWKS đã phân loại, `UpstreamError`, `SsrfBlockedError` → 503. SSRF log ERROR; lỗi không phân loại ném lại → 500 và error log. | Không che bug thành sự cố IdP; key IdP không import được có thể làm 500 và cần vận hành sửa. |
| S2-R56 | Default timeout mỗi attempt của `idp-jwks` là `max(1, floor(joseTimeout / (retries + 2)))`: mặc định 5000 ms / (2 + 2) = 1250 ms. Thứ tự general < provider default < `RESILIENCE_OVERRIDES`; override phải nhỏ hơn hạn jose. | External boot chỉ cần env bắt buộc, không cần override workaround. Hạn tổng vẫn do jose giữ; cấu hình retry/backoff quá lớn có thể tiêu hết hạn. |
| S2-R58/S2-R68 | Floor `AUTH_ENUMERATION_MIN_RESPONSE_MS` mặc định 300 ms, từ 0 đến 5000, local/hybrid production phải > 0. Áp POST `/sign-up/email`, `/request-password-reset`, `/change-email` và GET `/verify-email`, gồm redirect/lỗi từ handler sau các bước kiểm đầu vào; chờ phần còn lại từ lúc vào mount. | Xử lý vượt floor tăng `identity_enumeration_floor_exceeded_total` và WARN; timing channel dưới tải vẫn còn. Không bảo đảm constant-time. |
| S2-R59/S2-R62/S2-R63 | Hạ WARN đúng lỗi input allowlist, bỏ giá trị; thêm `Blocked cross-site navigation`, còn `Failed to parse state` phân loại theo code. API-key log chỉ hạ khi `isAPIError` và status < 500. Suppress dump `SERVER_ERROR` stderr bằng APIError 500 rỗng; `better_auth_unhandled_error` giữ `safeErrorFields`, gồm SQLSTATE. 5xx sign-in/2FA ra 503, vẫn ERROR + metric. | Tránh dump vượt pino redaction; cần drift test khi nâng Better Auth. Lỗi server khác không bị hạ mức. Cấm env override riêng của Better Auth nới origin/secret/telemetry. |
| S2-R60/S2-R65/S2-R69/S2-R71 | `DB_AUTH_CONNECTION_TIMEOUT_MS=3000`, `DB_AUTH_QUERY_TIMEOUT_MS=6000`: hạn checkout/connect và query phía client. Ghi lỗi query/checkout trong scope riêng từng request; mount/provider đổi 500 mơ hồ và mọi 401 có infra failure đã ghi thành 503, không Set-Cookie. Dùng chung `isDbInfraError`, cộng 40001/40P01 và cause walk của identity. | Probe S2-R45 vẫn dùng khi chưa có bằng chứng; bug không giải thích được giữ 500, API key gặp lỗi DB không phải hạ tầng cũng 500 rõ ràng. Deadline và guard xem bên dưới. |
| S2-R61 | SMTP ngừng lâu hơn retry budget → email `FAILED`; reconcile không gửi lại dòng FAILED. Người dùng yêu cầu lại verification/reset. | Bảo đảm hồi phục tự động chỉ trong budget, không phải gửi vô hạn sau mọi outage. At-least-once vẫn có thể lặp thư khi SMTP đã nhận nhưng worker chưa ghi SENT. |
| S2-R73 | Listener cấp pool của `auth-pool.ts` log qua `logPoolEvent` chung với core (`core/logging/pool-log.ts`), chạy trong `ClsServiceManager.getClsService().exit()`: dòng log không mixin trường request, chỉ mang trường pool-scoped. | Sự kiện pool xảy ra sau khi request đã tạo/mượn connection xong không còn gắn nhầm requestId/url của request đó (task 43 F1); cơ chế đầy đủ ở ADR 0007. |
| S2-R74 | `main.migrate.ts` chỉ import `core/config/all-configs.js` (không import config identity); `validateAllConfigs()` chỉ duyệt config đã đăng ký trong process, nên vai trò migrate không bắt buộc env `AUTH_*`. | Vai trò migrate không phụ thuộc identity dù cùng schema DB; bắt buộc env identity cho migration sẽ ghép role không liên quan. CLI `auth:*` (khác lệnh, chạy như `APP_ROLE=api`) vẫn cần đủ env identity như ghi ở carry-forward bên dưới. |

### Đổi email: dedupe và residual (S2-R42/S2-R66/S2-R68)

Mỗi confirmation token chỉ tạo một email cho mỗi nhánh, idempotency key dẫn xuất từ token gốc, không từ verification JWT mới sinh. Nếu trạng thái đăng ký đích đổi giữa các click có thể có hai email, mỗi nhánh một. `/verify-email` có luật riêng `AUTH_VERIFY_EMAIL_RATE_MAX=20` / `AUTH_VERIFY_EMAIL_RATE_WINDOW_SEC=300` theo IP (S2-R68 follow-up, `identityGuard` config), rộng hơn `AUTH_EMAIL_RATE_MAX=3`/`AUTH_EMAIL_RATE_WINDOW_SEC=300` của `/sign-up/email`, `/request-password-reset` và `/change-email` vì dedupe bảo đảm mỗi token chỉ gửi tối đa một thư; production bắt buộc không rộng hơn mức chung `AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_SEC` (rule `identity-verify-email-rate`, so bằng nhân chéo). Vẫn có thể 429 người dùng chung NAT. Luật `AUTH_SESSION_UPDATE_AGE_SEC` ≥ `AUTH_SESSION_FRESH_AGE_SEC` chặn oracle cookie renewal.

- M1: template không in địa chỉ mới nhưng JWT chứa `updateTo` đọc được bằng base64url; người đọc hộp thư cũ biết địa chỉ mới.
- M5: CHECK template sửa trong migration chưa phát hành. Dev DB đã chạy bản cũ phải reset volume rồi migrate; giữ schema cũ làm insert confirmation thất bại. Không reset dữ liệu cần giữ.
- M6: token gắn email cũ/đích, không gắn user id; `AUTH_EMAIL_TOKEN_TTL_SEC` mặc định 86400. Địa chỉ cũ bị tái đăng ký trong TTL có thể khiến link cũ tác động user mới. Giảm TTL chỉ giảm cửa sổ rủi ro.
- M7: địa chỉ mới vẫn nhận template `verify-email` chung; người bấm có thể gắn email mình vào tài khoản người khác khởi tạo. Reclaim giữ credential, xem b′. Process chết sau commit trước callback gửi thư vẫn có thể làm mất thư; yêu cầu lại hoặc bấm lại khi chưa có delivery bền.

### Deadline DB và suy giảm (S2-R60–S2-R72)

Production local/hybrid kiểm `max(2 × (DB_AUTH_CONNECTION_TIMEOUT_MS + DB_AUTH_QUERY_TIMEOUT_MS) + HEALTH_CHECK_TIMEOUT_MS, AUTH_ENUMERATION_MIN_RESPONSE_MS) < HTTP_REQUEST_BUDGET_MS`. HTTP budget mặc định 30000 ms thuộc core; khớp timeout proxy, không phải bộ huỷ mọi handler. Core pool, hook `onPoolCreated`, worker deadline và `commit_outcome_unknown` ở ADR 0007.

Auth dùng chung `watchPoolCheckouts` và `destroyUnusableClients`: trả slot khi connection đang mượn phát end/error; huỷ client trả về còn query treo hoặc transaction mở. Release kèm lỗi do pg-pool huỷ. Giữ client lành vừa nhận lỗi SQL đang chờ ReadyForQuery nếu không còn query và transaction idle. Listener thường trực S2-R32 vẫn bắt buộc vì pg-pool bỏ idle listener sau lỗi đầu. Auth không gắn checkout timer của core API/worker. Listener S2-R32 và mọi listener cấp pool khác của `auth-pool.ts` log qua `logPoolEvent` chung với core (S2-R73, ADR 0007), không gọi `logger.warn` trực tiếp.

Readiness kiểm `statement_timeout` thực tế auth_user > 0 và < `DB_AUTH_QUERY_TIMEOUT_MS`. Production vi phạm làm readiness down; ngoài production log lỗi cấu hình. N5: role/PgBouncer drift dùng chung có thể làm toàn cụm mất readiness. Đối chiếu setting qua connection runtime, sửa timeout role/PgBouncer, recycle connection cũ có kiểm soát và xác nhận readiness trước khi mở rộng rollout. Huỷ socket không bảo đảm backend dừng query/lock.

S2-R64: API key hợp lệ gặp Redis blackhole tốn khoảng **3 × `REDIS_COMMAND_TIMEOUT_MS`** (consume, refund, throttler route). Insurance limiter vẫn giới hạn theo pod; storage breaker chưa triển khai. S2-R65 giảm residual M2 của probe bằng bằng chứng lỗi trong request, không coi probe tốt là query trước đã thành công.

### Reclaim: giới hạn b′ và phương án đã loại

b′ bắt đầu khi kẻ tấn công đăng ký mật khẩu bằng email nạn nhân và nạn nhân bấm link xác thực. Reclaim giữ `credential` nên mật khẩu đó vẫn tồn tại. S2-R49 ngăn bước tiếp theo là tự ghép trusted IdP vào tài khoản mật khẩu này, nhưng **không** chứng minh mật khẩu thuộc người bấm link. Đặt lại mật khẩu thay credential và thu hồi session là đường khôi phục; không diễn đạt reclaim như đã loại mọi dạng pre-registration.

Không dùng `revokeUnprovenAccountAccess` của `better-auth/db`: helper chỉ được magic-link/email-OTP gọi, không tự chạy ở verification/reset/OAuth; xoá cả credential sẽ xoá mật khẩu hợp lệ mỗi lần đăng ký, tự đặt `emailVerified=true` là sai cho reset, và chuỗi xoá/cập nhật không nguyên tử (lease 5 s, chờ tối đa 2 s). Chi phí của phương án chọn là transaction khoá user và fence của mình, cần test interleaving khi nâng dependency.

### Vận hành, CLI và carry-forward

- **Xoay FieldCipher:** thêm kid mới, chuyển active kid, **mã hoá lại toàn bộ token account và dữ liệu còn cần đọc trước khi bỏ kid cũ**. SP2 chỉ có keyring nhiều kid; job/runbook re-encrypt thuộc SP7. Bỏ sớm có thể làm `/get-access-token` thành 400 do thư viện che lỗi giải mã, dù list account vẫn hoạt động.
- **S3, CLI:** `pnpm auth:generate`, `pnpm auth:check`, `pnpm auth:create-admin --email <email> --password <password> --role admin`. Script admin đã có `--yes` vì CLI không TTY có thể exit 0 mà không tạo user nếu thiếu cờ. Drift dùng `auth check schema`, không diff SQL generate. Export env trước khi gọi: `APP_ROLE=api`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_APP_PASSWORD`, `DB_AUTH_PASSWORD`, `BETTER_AUTH_SECRET`, `AUTH_BASE_URL`; thêm `DB_AUTH_HOST`/`DB_AUTH_PORT` nếu khác DB chung, và env mode/production tương ứng. CLI không tự đọc `.env`; lỗi config thật được in trước thông báo chung của CLI.
- **Dashboard:** chỉ worker, read-only, platform admin và IP allowlist; không forward cookie renewal. Dùng dashboard liên tục không gia hạn cookie trình duyệt, cần đăng nhập lại hoặc qua API có renewal.
- **S2-R43, SP3:** `identity.user.registered` phải có `orgId=null`. Publisher lấy org từ CLS, hiện không có override; tạo user trong OrgScope bị throw rõ ràng. Invite-accept/admin-in-org ở SP3 phải publish ngoài org scope hoặc bổ sung override tường minh; không bỏ guard để phát sai org.
- `@types/nodemailer` không cài trực tiếp; còn dependency bắc cầu qua `@types/smtp-server` của test. Quyết định package không đồng nghĩa cấm sự hiện diện bắc cầu này.

## Giới hạn đã biết

Token session lưu dạng gốc trong `auth.session`: bảo vệ bằng role, TLS, backup mã hoá và TTL. JWT đã phát còn tới `exp` (tối đa `AUTH_JWT_EXPIRES_IN_SEC`); token external tương tự. Clock skew giữa pod dịch ranh giới cửa sổ lockout; vận hành NTP. Đổi `BETTER_AUTH_SECRET` làm mất hiệu lực session và mất khả năng giải mã secret 2FA/private key JWKS cũ; cần kế hoạch khôi phục, SP2 không xoay song song. API key không bị xoá khi đổi mật khẩu; user tự tạo mới rồi xoá cũ.

## Hệ quả

`AuthGuard` mặc định chặn; route public phải có `@PublicRoute()`. Principal có trước throttler/idempotency/log. Chi phí bảo trì tập trung vào biên adapter, mount, mapping và transaction reclaim; các ngoại lệ phải được kiểm lại khi nâng Better Auth. Các giới hạn thời gian, rotation, SMTP và NAT ở trên là hợp đồng vận hành, không phải bảo đảm đã được xoá bởi test xanh.

## Kết quả spike

Mỗi mục: câu hỏi, cách đo, kết quả (đạt/không đạt kèm bằng chứng), nhánh đã chọn, task bị ảnh hưởng.

### Version đã cài (Task 1)

Output `pnpm list` sau Step 2 (2026-09-27):

```text
dependencies:
@better-auth/api-key@1.7.6
@better-auth/core@1.7.6
@better-auth/kysely-adapter@1.7.6
@better-auth/utils@0.4.2
@bull-board/api@9.10.1
@bull-board/express@9.10.1
better-auth@1.7.6
better-call@1.4.0
express@5.2.1
handlebars@4.7.9
jose@6.2.12
kysely@0.29.6
mjml@5.4.1
nodemailer@10.0.10
pg@8.23.0
raw-body@4.0.0
devDependencies:
@types/mjml@5.0.0
@types/smtp-server@3.5.13
auth@1.7.6
otpauth@9.5.2
smtp-server@3.19.13
```

`pg` chuyển từ `devDependencies` sang `dependencies` (`pnpm add --save-prod pg@8.23.0`; `pnpm add pg@8.23.0` báo "Already up to date" và không chuyển). Peer của `@better-auth/api-key@1.7.6` (`better-call 1.4.0`, `@better-auth/utils 0.4.2`) đã cài đúng. `pnpm peers check` không còn lỗi peer nào của nhóm Better Auth. Còn hai lỗi peer không thuộc nhóm này: `htmlnano@3.3.1` (qua `mjml-core@5.4.1`) muốn `cssnano ^8`, trong cây có 7.1.9; `tsconfck@3.1.6` (qua `vite-tsconfig-paths`, có từ SP1) muốn `typescript ^5`.

`nodemailer`: `latest` là 10.0.11, phát hành 2026-09-27T07:50Z, nên chưa qua `minimumReleaseAge: 1440`. `pnpm add` chọn 10.0.10, khớp spec §5.2.

#### Sửa spec §5.2 (Task 49 cập nhật văn bản spec)

- `raw-body`: **4.0.0** thay cho 3.0.2 (ruling S2-R1). `body-parser@2.3.0` vẫn dùng 3.0.2 bên trong. Mã của mình import thẳng 4.x, nên cây có hai bản.
- Chính sách version (ruling S2-R2): version ở spec §5.2 là mức tối thiểu đã kiểm. Bản patch hoặc minor cao hơn được nhận nếu changelog không có breaking change. Bản major cao hơn phải kiểm API đang dùng còn tương thích. `pg`, `kysely` và các peer mà nhóm Better Auth pin cứng vẫn pin.

#### Bằng chứng API `raw-body` dùng đến không đổi ở 4.x

- Chữ ký hàm: `raw-body@3.0.2/index.d.ts` có `getRawBody(stream, options, callback: (err, body: Buffer) => void)` và dạng Promise `getRawBody(stream, options?)`. `raw-body@4.0.0/dist/index.d.ts` giữ đúng hai overload đó (`Callback<Buffer>` và `Promise<Buffer>`) và vẫn export default `getRawBody`. `limit?: number | string | null` giữ nguyên. Lỗi vượt giới hạn vẫn có `type: 'entity.too.large'` và `status`/`statusCode` 413.
- Changelog: release notes v4.0.0 (https://github.com/stream-utils/raw-body/releases/tag/v4.0.0, 2026-07-12). Các breaking change gồm: bỏ Node < 22, chuyển sang TypeScript và ESM thuần, giải mã bằng `TextDecoder` thay `iconv-lite` (chỉ còn encoding WHATWG), bỏ streams1, và `limit` không parse được thì ném `TypeError` thay vì đọc không giới hạn. Không mục nào đổi đường gọi `getRawBody(req, { limit }, cb)`. Repo chạy Node 24.21.0 và ESM. `limit` lấy từ config đã validate, nên thay đổi cuối chỉ làm việc kiểm chặt hơn.
- Chạy thật: `pnpm typecheck` (tsc 7, có file spike) xanh với `import getRawBody from 'raw-body'` và `getRawBody(req, { limit: 2048 }, (err) => …)`. S1g ra 413 sau 73–81 ms (xem bảng S1).

### S1 — Tự mount + Nest 12 ESM + giới hạn body + guard + CLS trong hook + map lỗi

**Quyết định:** không dùng `@thallesp/nestjs-better-auth`. Review B2 chỉ ra: thư viện gọi handler bằng `next()` mà không await, nên lỗi ở `onRequest` thành unhandled rejection; 429 của rate limit IP và lỗi storage không đi qua hook, nên không map được. Thay vào đó dùng middleware Nest tự mount, gọi `auth.handler(Request)`. Không dùng `toNodeHandler` vì không có `bodySizeLimit` (A.8). Đây là ruling R36; spec §4 S1/§5.5 đã sửa theo. Fallback nếu không đạt: thallesp + patch upstream, cần Sếp quyết định.

**Kết quả: ĐẠT mọi tiêu chí (b), (g), (h), (i); không cần fallback.**

**Cách đo:** file `test/integration/spike-sp2/s1-mount.spec.ts`. Mã giống brief Task 1 Step 5, cộng thêm ghi log ra file (vitest không in `console.log` ở project integration), phép đo (a2), và (d) có gọi HTTP thật. Chạy trên Redis thật qua `infra.global-setup`, dùng Better Auth 1.7.6 với `memoryAdapter`. Kết quả chạy:

- `pnpm vitest run --project integration test/integration/spike-sp2/s1-mount.spec.ts` → 9/9 xanh.
- `SPIKE_AUTH_MODE=external … -t "\(d\)"` → 1 xanh, 8 bỏ qua.
- `pnpm vitest run --project integration test/e2e/core` → 9 file, 64/64 xanh.

**Phát hiện bắt buộc cho Task 36:** middleware Nest gắn bằng `forRoutes('/api/auth/{*path}')` được Express mount theo path, nên trong middleware `req.url` là `/`. Phải dựng `Request` từ `req.originalUrl`, ví dụ `/api/auth/sign-up/email`. Bằng chứng: log `mount url {"url":"/","originalUrl":"/api/auth/sign-up/email"}`. Chạy lần đầu với `req.url` như code brief thì mọi route `/api/auth/*` trả 404 từ Better Auth. Sau khi đổi sang `originalUrl`, mọi phép đo dưới đây đều đạt.

| Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|
| (a) thứ tự CLS → ContentType → mount; middleware `{*path}` khác có chạy trên `/api/auth/*` | Đạt. Thứ tự là CLS → `ContentTypeMiddleware` (HttpModule) → middleware `{*path}` của module khác → mount. Middleware `{*path}` khác **có** chạy trên `/api/auth/*` trước mount, nên `exclude` basePath khỏi `PrincipalMiddleware` là **bắt buộc**, không chỉ để phòng thủ. | `seen` = `nest.{*path}` → `mount` → `hooks.before` → `databaseHooks.user.create.after`. (a2): POST `/api/auth/sign-in/email` với `text/plain` → 415 problem+json, `seen=[]` (cả `{*path}` và mount đều không chạy, nên ContentType chạy trước). Giữa các module, thứ tự đi theo thứ tự đăng ký module/middleware. |
| (b) CLS trong `hooks`/`databaseHooks` | Đạt | Cả 4 bước có cùng `requestId` `01a0e225-7c17-7647-944b-4c1c0a4cade2`, trùng header `X-Request-Id`. Chưa đo callback gửi mail (spike không bật mail): Task 34/35 phải có test giữ điều này. |
| (c) 429 IP: `Response` + `X-Retry-After`; storage lỗi: `auth.handler` reject | Đạt đúng hình dạng | Sign-in sai lần 1 và 2 → `Response` 401 `application/json`. Lần 3 → `Response` 429 `text/plain;charset=UTF-8`, header `x-retry-after: 60` (không phải problem+json, không có `Retry-After`). Khi `customStorage.consume` ném lỗi: `auth.handler` reject với `Error: storage down` (`seen` có `rejected:Error: storage down`, cùng requestId). |
| (d) `ConditionalModule.registerWhen` bỏ mount ở `external` | Đạt | `SPIKE_AUTH_MODE=external`: POST `/api/auth/sign-in/email` → 404 problem+json, `seen=[]`. Không đặt biến: 200, `seen` có `mount`. |
| (e) tên cookie session | `spike.session_token`, `__Secure-spike.session_token` | `spike.session_token=…; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax` và `__Secure-spike.session_token=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax` |
| (f) lấy `Set-Cookie` của `auth.api.signOut` | option `returnHeaders: true` (có trong kiểu: `pnpm typecheck` xanh) | `out.headers.getSetCookie()` = `spike.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`, `spike.session_data=; Max-Age=0; …`, `spike.dont_remember=; Max-Age=0; …` |
| (g) `raw-body` 413 với chunked vô hạn | Đạt (raw-body 4.0.0) | 413 sau 73–81 ms (ngưỡng `MAX_413_MS` = 2000), giới hạn 2048 B, client ghi 512 B mỗi 5 ms |
| (h) `APP_GUARD` không chạy trên `/api/auth/*` | Đạt | GET `/api/auth/get-session`: `seen` không có `guard`. GET `/probe`: 403, `seen` có `guard`. |
| (i) lớp bọc: reject → 503, 429 → problem+json + `Retry-After`, không unhandled rejection | Đạt | reject → 503 `application/problem+json`. 429 → 429 `application/problem+json`, `retry-after: 60`. Mảng `unhandled` = `[]`. |

**Giới hạn của phép đo:**

- Spike đọc body bằng parser JSON của SP1 (`applyHttpDefaults`) rồi dựng lại bằng `JSON.stringify(req.body)`, chưa đo đường `raw-body` đọc thẳng trong mount; phần này thuộc Task 9/36.
- Chưa đo redirect 3xx đi qua lớp bọc.
- Chưa đo CLS trong callback mail (xem (b)).

**Task bị ảnh hưởng:**

- Task 36: mount dựng URL từ `req.originalUrl`, không từ `req.url`. Mount map mọi `Response` ≥ 400 và mọi reject. 429 của Better Auth là `text/plain` + `X-Retry-After`, phải đổi thành `Retry-After`.
- Task 37: luôn `exclude` basePath khỏi `PrincipalMiddleware` (review I9). (a) cho thấy middleware `{*path}` có chạy trên `/api/auth/*`, nên `exclude` là bắt buộc. Test e2e ở Task 37 giữ điều đó.
- Task 30: tên cookie theo (e).
- Task 36 (sign-out phía server): dùng `returnHeaders: true`.

### S2 — Adapter Kysely bọc, `auth_user`, PgBouncer

**Kết quả: ĐẠT (a) và (b); không cần fallback.** Nhánh (a) là adapter bọc. Nhánh (b) là pool `auth_user` đi qua PgBouncer với `MAX_PREPARED_STATEMENTS=200`.

**Cách đo:** file `test/integration/spike-sp2/s2-kysely-pgbouncer.spec.ts`. Mã giống brief Task 2 Step 1, cộng thêm ba điểm. Thứ nhất, ghi log ra file (vitest không in `console.log` ở project integration). Thứ hai, test phụ (a'): lớp bọc bọc cả adapter trong `transaction`, lấy id của user bị rollback từ `account.userId` trong hook. Thứ ba, test phụ (b'): đối chứng PgBouncer với `MAX_PREPARED_STATEMENTS=0` và `200`, mỗi mức 5 vòng × 10 `consume` song song, đếm riêng lỗi (`Error`) và bị chặn (`RateLimiterRes`). Test dựng Postgres 18.6 và PgBouncer `edoburu/pgbouncer:v1.25.2-p0` riêng trên một network Testcontainers. Role `auth_user` có `NOSUPERUSER NOBYPASSRLS NOCREATEROLE` và `search_path = auth`; `REVOKE ALL ON SCHEMA public FROM PUBLIC`. Kết quả chạy:

- `pnpm vitest run --project integration test/integration/spike-sp2/s2-kysely-pgbouncer.spec.ts` → 6/6 xanh (3 test của brief, 3 test phụ). Lần chạy đầu, chỉ có mã brief, 3/3 xanh.
- `pnpm typecheck` (có file spike) xanh, sau khi sửa kiểu như mục "Phát hiện về kiểu" bên dưới.
- Sau khi chạy, `docker ps -a` chỉ còn `testcontainers/ryuk` (container này tự thoát); không sót container Postgres hay PgBouncer.

| Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|
| (a) `database: (opts) => wrap(kyselyAdapter(db, { type: 'postgres', transaction: true })(opts))`, `CamelCasePlugin`, schema qua `search_path` | Đạt | Sign-up qua PgBouncer bằng `auth_user`: `calls` = `["transaction"]`; dòng `{"email":"a@example.com","email_verified":false,"v":7}` (cột snake_case, id UUIDv7). `SHOW search_path` = `auth`; Kysely không cần `withSchema`. Rollback: hook `account.create.before` ném `boom` sau khi `trx.create:user` đã chạy (user id `01a0e231-fea0-7002-9d05-b470b7d952ac`), nên `signUpEmail` reject. Sau đó `SELECT … WHERE id = <id đó>` = 0 dòng, và `user` + `account` của `b@example.com` = `[0, 0]`. Quyền: `SELECT 1 FROM public.anything` → `42501`; `CREATE TABLE public.x` → `permission denied`. |
| (b) named prepared statement `rlflx-upsert` qua PgBouncer 1.25 transaction mode, `MAX_PREPARED_STATEMENTS=200` | Đạt | 10 `consume('k')` song song, `points: 3`: qua `pg` thì `rejected=7, errorCount=0`; qua `bouncer` thì `rejected=7, errorCount=0`. Cả 7 lý do đều là `RateLimiterRes` (`consumedPoints` 4…10). `reward` chạy xong. (b'): `max_prepared_statements = 200` (đọc từ `/etc/pgbouncer/pgbouncer.ini` trong container) cho 5/5 vòng `rejected=7, errorCount=0`. |

**Phát hiện bắt buộc cho Task 28 (lớp bọc `withAccountCipher`):** với `transaction: true`, Better Auth ghi user, account và session qua adapter `trx` mà `transaction(cb)` truyền vào `cb`, **không** qua `create` của adapter ngoài. Lớp bọc của brief chỉ bọc adapter ngoài, nên `calls` không có `create:*` nào. Test (a') bọc cả `trx` và ghi được `calls` = `transaction → trx.create:user → hook:account.before → trx.create:account → trx.create:session`. Spec §5.9 đã yêu cầu "bọc cả adapter trả về từ `transaction(cb)`"; spike xác nhận đó là yêu cầu bắt buộc, không chỉ để phòng thủ: bọc thiếu thì token của `account` được ghi dạng bản rõ. Unit test của Task 28 phải có trường hợp "bản adapter trong transaction", như bảng test của spec đã ghi.

**Phát hiện về kiểu (Task 28, Task 34):**

- `database: (opts) => …` không typecheck: `TS7006: Parameter 'opts' implicitly has an 'any' type`. Lý do là `BetterAuthOptions['database']` là union có nhiều kiểu (`PostgresPool | … | DBAdapterInstance | …`), nên TypeScript không suy được kiểu tham số. Phải ghi rõ `(opts: BetterAuthOptions) => …`; `BetterAuthOptions` được export từ `better-auth`.
- Adapter truyền vào `transaction(cb)` có kiểu `DBTransactionAdapter` = `Omit<DBAdapter, 'transaction'>`, không phải `DBAdapter` (lỗi `TS2741: Property 'transaction' is missing`). Lớp bọc cần một hàm `DBTransactionAdapter → DBTransactionAdapter` cho `trx` và một hàm `DBAdapter → DBAdapter` cho adapter ngoài, trong đó hàm ngoài dùng lại hàm `trx`. Cả hai kiểu được export từ `better-auth`.
- `create` có chữ ký generic `<T, R = T>(…) => Promise<R>`. `return inner.create(d)` typecheck được. Nhưng `async (d) => { const r = await inner.create(d); …; return r; }` hay `.then(r => r)` báo `TS2322: 'R' could be instantiated with an arbitrary type`. Task 28 cần giải mã kết quả `create`/`findOne`, nên phải khai báo tham số generic tường minh cho hàm bọc, không ép kiểu mù.

**Phát hiện cho Task 15/27 (PgBouncer):**

- Đối chứng (b') với `max_prepared_statements = 0`: cả 5 vòng đều có lỗi thật, `errorCount` = 5, 2, 1, 1, 2 trên 10 lời gọi. Thông báo lỗi là `prepared statement "login_attempts:rlflx-upsert" already exists`, ở một lần chạy khác có thêm `… does not exist`. Tên statement thật có tiền tố tên bảng: `login_attempts:rlflx-upsert`. Vậy `MAX_PREPARED_STATEMENTS` > 0 là **bắt buộc** cho user `auth_user` trên PgBouncer (spec dòng 1019).
- Tiêu chí `rejected === 7` của brief **không phân biệt** chặn đúng với lỗi: với `max_prepared_statements = 0`, mọi vòng vẫn cho `rejected=7`. Lý do là tối đa 3 lời gọi thành công, còn lại hoặc bị chặn hoặc lỗi. Test lockout ở Task 15/27 phải kiểm thêm rằng mọi lý do reject là `RateLimiterRes`, không phải `Error`.

**Nhánh:** (a) adapter bọc (không dùng fallback `{ db, type, schemaName: 'auth', transaction: true }` + plugin Kysely). (b) pool `auth_user` qua PgBouncer với `MAX_PREPARED_STATEMENTS=200`.

**Task bị ảnh hưởng:** không task nào đổi nhánh. Các ràng buộc bổ sung ở trên áp cho Task 28 (bọc `trx`, kiểu `DBTransactionAdapter`, generic của `create`), Task 34 (`opts: BetterAuthOptions`), Task 15/27 (`MAX_PREPARED_STATEMENTS` bắt buộc; test lockout kiểm loại lý do reject).

**Giới hạn của phép đo:**

- Chỉ đo `create` trong sign-up email/password. Chưa đo `update`/`findOne` của `account` trong transaction (liên kết OAuth, xoay refresh token); Task 28 phải có test cho các đường đó.
- PgBouncer trong spike chỉ có một user (`auth_user`). Chưa đo cấu hình nhiều user chung một instance như Task 15 dự định.
- `MAX_PREPARED_STATEMENTS=200` là giá trị brief đưa ra. Chỉ đo thêm mức 0; chưa tìm giá trị nhỏ nhất đủ dùng.

### S3 — `auth generate` trên PG 18.6

**Kết quả: ĐẠT (a), (b), (d) và id v7. (c) KHÔNG ĐẠT theo cách brief dự kiến; dùng lệnh có sẵn `auth check schema` làm kiểm lệch.** Nhánh (A): `generateId: 'uuid'` + `DEFAULT uuidv7()`. ADR 0009 không đổi.

**Cách đo:** container `postgres:18.6` (digest trong `docker/images.env`) tên `s3-pg` ở `127.0.0.1:55499`, `CREATE SCHEMA auth`. File config CLI `test/integration/spike-sp2/s3-generate/auth.spike-config.ts` đúng như brief: Kysely + `CamelCasePlugin`, `schemaName: 'auth'`, `generateId: 'uuid'`, plugin `twoFactor`, `bearer`, `apiKey`, `jwt`, `admin`, `rateLimit.storage: 'database'`. CLI `auth` 1.7.6.

**Flag thật của CLI** (`pnpm exec auth --help`, `generate --help`, `create-admin --help`, `check --help`, `check schema --help`):

- `generate`: `-c, --cwd`, `--config`, `--output`, `--adapter`, `--dialect`, `-y, --yes` (`--y` deprecated).
- `create-admin`: `--config`, `--email`, `--password`, `--name` (mặc định `Admin`), `--role` (mặc định `admin`), `--data <json>`, `--no-email-verified`, `--force`, `-y, --yes`.
- `check schema`: `--config`, `-c, --cwd`. Mô tả: "Check that the configured schema can hold what Better Auth writes".

**(a) SQL sinh ra.** Lệnh `auth generate … --output out.sql --yes` trên schema `auth` trống: exit 0. CLI in kèm `ERROR [Better Auth]: Database schema mismatch … Missing tables user, session, account, verification, two_factor, apikey, jwks, rate_limit`; đó là kiểm schema runtime của instance vừa dựng, không phải lỗi của lệnh. Nội dung `out.sql`:

```sql
create schema if not exists "auth";

create table "auth"."user" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "email_verified" boolean not null, "image" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null, "two_factor_enabled" boolean, "role" text, "banned" boolean, "ban_reason" text, "ban_expires" timestamptz);

create table "auth"."session" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expires_at" timestamptz not null, "token" text not null unique, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null, "ip_address" text, "user_agent" text, "user_id" uuid not null references "auth"."user" ("id") on delete cascade, "impersonated_by" text);

create table "auth"."account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" uuid not null references "auth"."user" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" timestamptz, "refresh_token_expires_at" timestamptz, "scope" text, "password" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null);

create table "auth"."verification" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expires_at" timestamptz not null, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth"."two_factor" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "secret" text not null, "backup_codes" text not null, "user_id" uuid not null references "auth"."user" ("id") on delete cascade, "verified" boolean, "failed_verification_count" integer, "locked_until" timestamptz);

create table "auth"."apikey" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "config_id" text not null, "name" text, "start" text, "reference_id" text not null, "prefix" text, "key" text not null, "refill_interval" integer, "refill_amount" integer, "last_refill_at" timestamptz, "enabled" boolean, "rate_limit_enabled" boolean, "rate_limit_time_window" integer, "rate_limit_max" integer, "request_count" integer, "remaining" integer, "last_request" timestamptz, "expires_at" timestamptz, "created_at" timestamptz not null, "updated_at" timestamptz not null, "permissions" text, "metadata" text);

create table "auth"."jwks" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "public_key" text not null, "private_key" text not null, "created_at" timestamptz not null, "expires_at" timestamptz, "alg" text, "crv" text);

create table "auth"."rate_limit" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "key" text not null unique, "count" integer not null, "last_request" bigint not null);

create index "session_user_id_idx" on "auth"."session" ("user_id");

create index "account_user_id_idx" on "auth"."account" ("user_id");

create index "verification_identifier_idx" on "auth"."verification" ("identifier");

create index "two_factor_secret_idx" on "auth"."two_factor" ("secret");

create index "two_factor_user_id_idx" on "auth"."two_factor" ("user_id");

create index "apikey_config_id_idx" on "auth"."apikey" ("config_id");

create index "apikey_reference_id_idx" on "auth"."apikey" ("reference_id");

create index "apikey_key_idx" on "auth"."apikey" ("key");
```

Tên bảng thật: `user`, `session`, `account`, `verification`, `two_factor`, `apikey`, `jwks`, `rate_limit`. Cột là snake_case, thời gian đã là `timestamptz`, `"user".email` đã có `unique`. Khác dự kiến: `apikey.reference_id` sinh ra kiểu **`text`**, không phải `uuid`, và không có FK. `session.impersonated_by` cũng là `text`.

Hai điểm bảng chuẩn hoá §5.16 để "xác minh ở S3": `apikey.key` chỉ có index thường `apikey_key_idx`, **không** `UNIQUE`, nên khoá ứng viên của `apikey` chỉ là `{id}`. `"user".role` đúng là đa trị nối dấu phẩy: plugin `admin` tách bằng `split(",")` ở `better-auth/dist/plugins/admin/has-permission.mjs:6` và `routes.mjs:588`.

**(b) Sửa đổi `validateSchema` chấp nhận.** Áp bằng `psql -v ON_ERROR_STOP=1` trong một transaction: exit 0. Sau đó `auth check schema` → `Schema check passed against the live database.`, exit 0, và test runtime xanh. Danh sách:

1. Mọi `id`: `DEFAULT pg_catalog.gen_random_uuid()` → `DEFAULT uuidv7()`.
2. `account`: `CONSTRAINT account_provider_id_account_id_unique UNIQUE (provider_id, account_id)`.
3. `apikey.reference_id`: đổi kiểu `text` → **`uuid`**, thêm `REFERENCES auth."user"(id) ON DELETE CASCADE`. Kiểm schema runtime không so kiểu: `diffSchema` (`@better-auth/core/dist/db/schema-diff.mjs`) chỉ có ba loại lỗi `missing-table`, `missing-column`, `unexpected-required-column`.
4. `"user".registered_event_emitted_at timestamptz NULL`.
5. Bảng `auth.login_attempts (key varchar(255) PRIMARY KEY, points integer NOT NULL DEFAULT 0, expire bigint)` + index `(expire)`. Bảng không thuộc Better Auth nên không bị kiểm.
6. Index thêm: `session(expires_at)`, `verification(expires_at)`, `"user"(created_at) WHERE registered_event_emitted_at IS NULL`.

Đối chứng cột NOT NULL tự thêm, đo bằng `auth check schema`: `ALTER TABLE auth.session ADD COLUMN extra_req text NOT NULL` → exit 1, `Required columns Better Auth never writes: session.extra_req … Inserts into session will fail.` Cùng cột có `DEFAULT 'x'` → exit 0. Vậy cột NOT NULL tự thêm phải có `DEFAULT`, đúng research 1.6.

Runtime: `pnpm vitest run --project integration test/integration/spike-sp2/s3-generate.spec.ts` → 1/1 xanh. `signUpEmail` và `createApiKey` đều đi qua kiểm schema: cả `onRequest` của router và `auth.api.*` đều `await ctx.checkSchema()` (`better-auth/dist/api/index.mjs:169`, `api/to-auth-endpoints.mjs:41`). `SchemaMismatchError` làm request reject, nên kiểm này chặn thật. Log: `{"user":[{"v":7,"registered_event_emitted_at":null}],"apikey":[{"v":7,"t":"uuid","same":true}],"session":[{"v":7}],"account":[{"v":7}]}`.

**(c) Khi schema đã khớp: `auth generate` KHÔNG dùng được để kiểm lệch khi có `CamelCasePlugin`.** Chạy lại `auth generate … --output drift.sql --yes` trên schema đã áp (b): exit 0, in `🚀 Schema was generated successfully!`, và **tạo `drift.sql` 4332 byte** chứa lệnh sai cho mọi bảng/cột có tên nhiều từ, ví dụ `alter table "auth"."user" add column "email_verified" …`, `alter table "auth"."apikey" add column "reference_id" text not null`, `create table "auth"."two_factor" …`, `create table "auth"."rate_limit" …`.

Nguyên nhân (đọc mã): `better-auth/dist/db/get-migration.mjs:362` lấy bảng bằng `db.introspection.getTables()`. Kysely 0.29.6 chạy introspection **không qua plugin** (`kysely/dist/kysely.js:103`: `createIntrospector(this.withoutPlugins())`), nên trả tên vật lý snake_case. Sau đó dòng 413 (`table.name === key`) và 471 (`c.name === fieldName`) so với tên logic camelCase. Chỉ `diffSchema(toPhysicalSchema(db, …))` ở dòng 406 có ánh xạ tên. Hệ quả: `auth generate` chỉ đúng trên schema **trống**, và không bao giờ dùng `auth migrate` với cấu hình này.

**Fallback có sẵn:** `auth check schema --config <file>`, dùng đúng `diffSchema(toPhysicalSchema(…))` của runtime.

| Trạng thái DB | Output | exit |
|---|---|---|
| Khớp (sau (b)) | `Schema check passed against the live database.` | 0 |
| Đổi tên `"user".two_factor_enabled` + thêm `session.extra_req text NOT NULL` | `Database schema mismatch` / `Missing columns user.two_factor_enabled` / `Required columns Better Auth never writes session.extra_req` | 1 |

CI (Task 48) fail khi `auth check schema` trả exit ≠ 0. Giới hạn: lệnh này không so kiểu cột và không so index (runtime cũng vậy), nên không bắt được lệch kiểu hay thiếu index của Better Auth. Test catalog của Task 26 (cột, kiểu, index) bù phần đó.

**(d) `auth create-admin`:** `auth create-admin --config <file> --email admin@example.com --password '…' --role admin --yes` → `Admin user created successfully. User ID: 01a0e23b-cc16-782b-8c3e-dd4581252b57 … Role: admin`, exit 0. DB: `admin@example.com | admin | email_verified = t | v = 7`. **Bẫy:** thiếu `--yes` mà DB đã có user thì CLI hỏi `Found 1 existing user. Create an admin user anyway? (y/N)`; không có TTY thì nó thoát **exit 0 mà không tạo user** (DB 0 dòng). Runbook và script `auth:create-admin` phải luôn có `--yes`.

- Id mới: `uuid_extract_version(id) = 7` **đạt** cho `user`, `session`, `account`, `apikey`.

**Nhánh:** (A) `generateId: 'uuid'` + `DEFAULT uuidv7()`.

**Task bị ảnh hưởng:**

- Task 26: chỉ chạy `auth generate` trên schema `auth` trống. Thêm script `auth:check` = `auth check schema --config dist/modules/identity/infra/better-auth/auth.cli-config.js`. Bước kiểm cuối đổi từ "`auth:generate` báo khớp" sang "`auth:check` exit 0". `apikey.reference_id` đổi `text` → `uuid` + FK (mục (b)3). Bảng chuẩn hoá §5.16 bổ sung các cột thật theo (a): `apikey.config_id`, `two_factor.verified`, `failed_verification_count`, `locked_until`, `jwks.alg`, `crv`, `session.impersonated_by`. `auth:create-admin` luôn có `--yes`.
- Task 48: test kiểm lệch gọi `auth check schema` và kiểm exit 0, không đọc output `auth generate`. Spec §9 (dòng "Kiểm tra lệch schema Better Auth") và §5.16 sửa theo ở Task 49.

**Giới hạn của phép đo:** chưa chạy up → down → up bằng MikroORM (thuộc Task 26). `create-admin` chỉ đo khi DB đã có user.

**Bổ sung Task 26 (review M2), cho runbook và CI Task 48:** CLI `auth` 1.7.6 nuốt mọi lỗi khi nạp file config (`catch {}` trong `auth/dist/index.mjs`, chỉ in `Could not load the Better Auth configuration.`, exit 2). `auth.cli-config.ts` in lỗi thật ra stderr trước khi ném lại (dòng `auth.cli-config: cannot load <phần>: ConfigValidationError: … <TÊN_ENV>: …`, chỉ có tên biến, không có giá trị; CLI thử nhiều cách nạp nên dòng này có thể lặp lại). `pnpm auth:generate`, `auth:check`, `auth:create-admin` cần đủ env của app như khi chạy api: tối thiểu `APP_ROLE=api`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_APP_PASSWORD`, `DB_AUTH_PASSWORD` (cộng `DB_AUTH_HOST`/`DB_AUTH_PORT` nếu khác `DB_*`), `BETTER_AUTH_SECRET`, `AUTH_BASE_URL`, và mọi biến mà luật của config identity đòi theo `AUTH_MODE`/`NODE_ENV`.

### S4 — Lỗi storage rate limit; user id chờ 2FA

**Kết quả: ĐẠT (a) và (b); không cần fallback.**

**Cách đo:** file `test/integration/spike-sp2/s4-ratelimit-2fa.spec.ts`, mã brief cộng ba điểm: ghi log ra file; biến thể (a) theo đúng tiêu chí spec (role thường bị thu hồi quyền ghi); và (b) viết đủ luồng. Postgres 18.6 dựng bằng Testcontainers, Better Auth 1.7.6, Kysely + `CamelCasePlugin`, bảng tạo bằng `getMigrations(…).runMigrations()` (schema `public` trống nên diff đúng, xem S3c). `pnpm vitest run --project integration test/integration/spike-sp2/s4-ratelimit-2fa.spec.ts` → 2/2 xanh.

- (a) Lỗi `rate_limit` mất bảng: đối chứng trước khi đổi tên là `Response` 401 `application/json` (`INVALID_EMAIL_OR_PASSWORD`). Sau `ALTER TABLE rate_limit RENAME TO rate_limit_gone`, `auth.handler` **reject** với `error:42P01:relation "rate_limit" does not exist` (lỗi `pg` gốc, `code = 42P01`), không trả `Response`. Biến thể thu hồi quyền: role `spike_user` có `SELECT, INSERT, UPDATE, DELETE` trên mọi bảng rồi `REVOKE INSERT, UPDATE ON rate_limit` → reject với `error:42501:permission denied for table rate_limit`. Trong cả hai trường hợp, lỗi gốc **không tới** `onAPIError.onError` (0 lần gọi). Lý do: `onRequestRateLimit` chạy trong `onRequest` của router (`better-auth/dist/api/index.mjs:172`), ngoài phạm vi `onError` (dòng 195–199).
- (b) Trong hook `before` của `/two-factor/verify-totp`, `c.context.session` là `null`. User id **đọc được** bằng `const id = await c.getSignedCookie(c.context.createAuthCookie('two_factor').name, c.context.secret)` rồi `(await c.context.internalAdapter.findVerificationValue(id))?.value`. Log: `signedCookieValue = "2fa-2pOc8_RkMog_klIWxCPQ"`, `verificationValue` = id của user (trùng `SELECT id FROM "user"`). Tên cookie thật là `better-auth.two_factor` (tên tạo qua `createAuthCookie`, nên theo `cookiePrefix`). Mã đối chiếu: plugin tạo verification `{ identifier: '2fa-<20 ký tự ngẫu nhiên>', value: user.id }` và ký giá trị `identifier` vào cookie (`plugins/two-factor/index.mjs:291-304`); `verifyTwoFactor` đọc lại đúng như vậy (`plugins/two-factor/verify-two-factor.mjs:14-22`). Mã sai → 401 `INVALID_CODE`. Hook chạy trước khi Better Auth tiêu thụ verification, nên đọc được. Cookie thiếu hoặc sai chữ ký thì `getSignedCookie` trả `null`, hook không có user id.

**Phát hiện thêm cho Task 34 (cần controller quyết, không đổi nhánh ở đây):** Better Auth 1.7.6 đã có sẵn hai lớp chống dò mã 2FA khi đăng nhập:

- Mỗi challenge tối đa 5 lần (`beginAttempt(5)`, `plugins/two-factor/totp/index.mjs:185`, `backup-codes/index.mjs:199`); vượt thì huỷ challenge, `400 TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE`.
- Khoá theo tài khoản `twoFactor({ accountLockout: { enabled, maxFailedAttempts, durationSeconds } })`, mặc định bật, 10 lần, 900 giây (`verify-two-factor.mjs:117-123`). Đếm bằng `incrementOne` nguyên tử trên cột `two_factor.failed_verification_count`, khoá bằng `locked_until` (hai cột có trong SQL của S3a); đang khoá thì `429 ACCOUNT_TEMPORARILY_LOCKED`.

Theo luật "ưu tiên có sẵn", khoá 2FA theo user của Task 34 có thể dùng `accountLockout` (cấu hình qua `defineConfig`) thay vì khoá `2fa:<userId>` tự viết. Spike chưa đo `accountLockout` chạy thật.

**Nhánh:** (a) handler reject khi storage lỗi → Task 36 bắt reject và trả `503` fail-closed (mọi reject của `auth.handler`). `customStorage` không phải fallback: nó cũng chạy trong `onRequest`, lỗi của nó cũng reject. (b) khoá `2fa:<userId>`, userId đọc từ cookie `two_factor` đã ký + `internalAdapter.findVerificationValue`. Khi cookie không đọc được (thiếu, sai chữ ký, verification hết hạn) thì không có user id; khi đó Better Auth cũng trả 401 `INVALID_TWO_FACTOR_COOKIE` mà không thử mã, nên chỉ cần rule IP.

**Task bị ảnh hưởng:** (a) chỉ Task 36 (`AuthMountMiddleware.forward`: nhánh reject và nhánh `Response` ≥ 500 đều đã có; S4a xác nhận test phải phủ nhánh **reject**; không dựa vào `onAPIError` để log lỗi storage). Lỗi reject là lỗi `pg` thô (`code` SQLSTATE, `message` có tên bảng), nên Task 36 chỉ log `code`/tên lỗi, không đưa `message` ra ngoài. (b) Task 34: `subject` của khoá 2FA dùng user id như trên (không cần nhánh `cookie:<sha256>`); hook tốn thêm một lần đọc `verification`. Controller cân nhắc thay bằng `accountLockout` có sẵn.

**Giới hạn của phép đo:** chưa đo qua pool `auth_user` + PgBouncer và chưa đo ánh xạ `503` + `Retry-After` của lớp bọc (S1 đã đo lớp bọc với reject `storage down`). Chỉ đo `verify-totp`, chưa đo `verify-backup-code`/`verify-otp` (dùng cùng `verifyTwoFactor`).

### S5 — Thao tác trên `account`

**Kết quả: ĐẠT. Adapter bọc thấy mọi thao tác trên `account`; không cần fallback plugin Kysely.** Nhưng bảng hành vi ở spec §5.9 phải sửa ba điểm (xem "Ràng buộc cho Task 28"), nếu không lớp bọc sẽ làm hỏng đổi/đặt lại mật khẩu và đăng nhập OAuth, hoặc bỏ sót giải mã.

**Cách đo:** file `test/integration/spike-sp2/s5-account-ops.spec.ts`. Lớp spy bọc cả adapter ngoài và adapter `trx` (kiểu `DBTransactionAdapter`, như S2), ghi **mọi** method (`create`, `update`, `updateMany`, `findOne`, `findMany`, `count`, `delete`, `deleteMany`, `consumeOne`, `incrementOne`) kèm `where`, tên khoá dữ liệu, `join` và cờ trong transaction. Postgres 18.6 (Testcontainers), `kyselyAdapter(db, { type: 'postgres', transaction: true })` + `CamelCasePlugin`, IdP giả bằng `node:http` (discovery/token/userinfo, `expires_in: 1`). `pnpm vitest run --project integration test/integration/spike-sp2/s5-account-ops.spec.ts` → 1/1 xanh.

Khác brief (đối chiếu mã 1.7.6):

- `genericOAuth` 1.7.6 không còn endpoint riêng `/sign-in/oauth2`. Plugin đăng ký provider thành social provider ("Providers are used through the standard `signIn.social` and `callback/:id` core endpoints", `plugins/generic-oauth/index.mjs:61-67`). Đường thật: `POST /sign-in/social` `{ provider: 'fake', callbackURL }`, `POST /link-social` `{ provider: 'fake', callbackURL }` (cần session), callback `GET /api/auth/callback/fake`.
- `POST /refresh-token` và `/get-access-token` nhận `{ accountId: <id account của Better Auth> }` hoặc `{ useAccountCookie: true }`, **không** nhận `providerId` (`api/routes/account.mjs:309-315`, `strictObject`).
- `getMigrations` không chạy với adapter bọc (`Only kysely adapter is supported for migrations`, `process.exit(1)`); spike tạo bảng bằng dạng `{ db, type: 'postgres' }` cùng plugin.
- IdP giả phải trả `id` trong userinfo: `fetchUserInfo` chỉ đổi `sub` → `id` khi đọc từ `id_token` (`plugins/generic-oauth/index.mjs:37-59`). Thiếu `id` thì callback redirect `…/error?error=unable_to_get_user_info`.

Kết quả (mọi luồng trả thành công: callback 302 `location: /`, refresh 200, get-access-token 200, unlink 200, change-password 200):

| Luồng | Thao tác trên `account` (where, keys, trong transaction?) |
|---|---|
| Đăng ký email | `create` [tx], keys `createdAt, updatedAt, userId, providerId, accountId, password` |
| Đăng nhập email | không gọi model `account`; đọc qua `join` (dòng cuối) |
| Liên kết (`/link-social` → callback) | `findMany` where `providerId, accountId` (không tx); `create` **không tx**, keys `createdAt, updatedAt, userId, providerId, accountId, tokenType, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, scopes, idToken, raw, scope` |
| OAuth callback, user mới | `findMany` where `providerId, accountId` + `join: { user: true }`; `create` [tx], keys `createdAt, updatedAt, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, providerId, accountId, userId` |
| OAuth callback, account đã có | `findMany` + `join: { user: true }`; `update` where `id`, keys **`providerId`**, `idToken, accessToken, refreshToken, accessTokenExpiresAt` (không tx) |
| Refresh token (`/refresh-token`) | `findMany` where `userId`; `update` where `id`, keys `accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, idToken` |
| `/get-access-token` khi token hết hạn | `findMany` where `userId`; `update` where `id`, cùng bộ keys như refresh |
| Partial update (`internalAdapter.updateAccount(id, { scope })`) | `update` where `id`, keys `scope` |
| `/list-accounts` | `findMany` where `userId` |
| `/unlink-account` | `findMany` where `userId`; `findMany` where `id`; `delete` where `id` |
| `/change-password` | `findOne` where `userId, providerId='credential', accountId`; `update` where `id`, keys `password` |
| `internalAdapter.updatePassword` (đặt lại/đặt mật khẩu, `routes/password.mjs:167`) | **`updateMany`** where `userId, providerId='credential', accountId`, keys `password` |
| `findCredentialAccount` / `findAccountByUserId` | `findOne` where `userId, providerId, accountId` / `findMany` where `userId` |
| `deleteAccounts` (xoá user) | `findMany` where `userId`; `deleteMany` where `userId` |
| Đọc account qua `join` từ model khác | **Có.** `user.findOne` where `email` + `join: { account: true }` (sign-in email, `findUserByEmail(…, { includeAccounts: true })`, `db/internal-adapter.mjs:566-580`); kết quả là user có mảng `account` (log `resultKeys` = `…, id, account`). Ngược lại, `account.findMany` + `join: { user: true }` (`findAccountOwnerByKey`, dòng 542-565) là model `account`, trả account kèm `user` |

Không có `consumeOne`, `incrementOne` hay `count` nào trên `account`. `session.findOne` + `join` chỉ kèm `user`.

**Kết luận:** adapter bọc thấy đủ. **Nhánh:** `withAccountCipher` (không dùng fallback plugin Kysely).

**Ràng buộc cho Task 28 (sửa bảng hành vi của spec §5.9):**

1. `updateMany` **không có cột token** thì cho qua nguyên vẹn. `updatePassword` gọi `updateMany` where `userId + providerId + accountId` với keys chỉ có `password`; luật "bắt buộc `where` theo `id`, dạng khác ném lỗi" nếu áp cho mọi `update`/`updateMany` sẽ làm hỏng đặt lại mật khẩu. Chỉ ném lỗi khi dữ liệu cập nhật có `accessToken`/`refreshToken`/`idToken` mà `where` không phải đúng một điều kiện `id`.
2. Dữ liệu `update` **có thể chứa `providerId`** (callback của account đã có, và nhánh liên kết lại account, `oauth2/link-account.mjs:53`, `:209`). Không ném lỗi chỉ vì có khoá này. Lớp bọc vẫn đọc dòng theo `id` (vì thiếu `accountId`), rồi chỉ ném lỗi khi `providerId`/`accountId` khác giá trị đang lưu.
3. Giải mã cả **kết quả `join`**: `findOne`/`findMany` của model `user` có `join.account` trả mảng `account` bên trong kết quả, cần giải mã từng phần tử. Lớp bọc chỉ nhìn `model === 'account'` sẽ trả bản mã cho `findUserByEmail(…, { includeAccounts: true })`. Tương tự, `account.findMany` có `join.user` thì phần `user` giữ nguyên.
4. `create` của nhánh liên kết chạy **ngoài transaction** và mang khoá lạ `tokenType`, `scopes`, `raw` (`raw` là response token thô của IdP, có token dạng rõ). Factory adapter bỏ các khoá không có trong schema (DB không có cột `raw`), nên không lộ ra DB, nhưng lớp bọc không được log `data`.
5. Unit test của Task 28 thêm: `updateMany` chỉ có `password` → cho qua; `update` có `providerId` trùng → được, khác → lỗi; `user.findOne` + `join.account` → token đã giải mã.

**Phát hiện cần controller xem (không đổi nhánh):** Better Auth 1.7.6 có sẵn `account.encryptOAuthTokens` (`oauth2/utils.mjs:10-27`, `setTokenUtil`/`decryptOAuthToken`, mã hoá bằng `BETTER_AUTH_SECRET`, bỏ qua giá trị không giống bản mã). Spec §5.9 chọn `FieldCipher` riêng (keyring nhiều `kid`, AAD theo dòng), mà tuỳ chọn có sẵn không có hai thứ đó. ADR nên ghi rõ lý do không dùng tuỳ chọn này, theo luật "ưu tiên có sẵn". Lưu ý thêm: `idToken` **không** đi qua `setTokenUtil` ở nhánh liên kết/đăng nhập (`link-account.mjs:56`, `:210`), nên tuỳ chọn có sẵn cũng không mã hoá `id_token`.

**Task bị ảnh hưởng:** không task nào đổi nhánh. Task 28 nhận các ràng buộc 1–5 ở trên. Task 49 sửa bảng §5.9 theo đó.

**Giới hạn của phép đo:** không bật `experimental.joins`; join ở đây do factory adapter giả lập, lớp bọc vẫn thấy `join` trong tham số. Chưa đo với `account.storeAccountCookie` và `updateAccountOnSignIn: false`. Id trong spike do Better Auth sinh (không `generateId: 'uuid'`).

### S6 — mjml 5.4.1 + handlebars 4.7.9

**Kết quả: ĐẠT mọi tiêu chí; không cần fallback.** Kích thước image vượt 200 MB, đã báo trong ADR 0013 (mục "Số đo image sau khi thêm package SP2").

**Cách đo:** `test/unit/spike-sp2/s6-mjml.spec.ts` + template `src/modules/notifications/templates/spike/en/body.mjml` như brief, thêm ghi log ra file và một test `minify: true` cho câu hỏi peer `cssnano`. `pnpm vitest run --project unit test/unit/spike-sp2/s6-mjml.spec.ts` → 3/3 xanh. `pnpm typecheck` (có file spike, `@types/mjml` 5.0.0) → exit 0.

- `import mjml2html from 'mjml'` từ ESM: **đạt**, cả trong vitest và trong image production (`node --input-type=module`, `(await import('mjml')).default` là `function`). API async: `mjml2html(src)` trả `Promise`. `validationLevel: 'strict'` ném lỗi với tag lạ: **đạt**, `Error: ValidationError: … (mj-bogus) — Element mj-bogus doesn't exist or is not registered`.
- `{{url}}` trong `href` sau mjml: **còn nguyên** (`out.html` chứa `href="{{url}}"`, `errors = []`). Sau `Handlebars.create().compile(html, { strict: true, knownHelpersOnly: true })`: `href` = `https://app.example/verify?token&#x3D;a&amp;b&#x3D;1`, giải mã entity ra đúng `https://app.example/verify?token=a&b=1`; `{{name}}` = `<b>x</b>` ra `&lt;b&gt;x&lt;/b&gt;`.
- Sửa test của brief: regex `/href="([^"]+)"/` bắt nhầm `href` đầu tiên của HTML, là `<link href="https://fonts.googleapis.com/css?family=Ubuntu:300,400,500,700">` mà `mj-text` tự chèn. Phải lấy `href` của thẻ `<a>`: `/<a\b[^>]*\bhref="([^"]+)"/`. Task 21 (test renderer) dùng regex theo thẻ `<a>`. Nếu không muốn tải font Google trong email, Task 21 khai `mj-font`/`mj-attributes` riêng; đây là quyết định nội dung, S6 không đổi.
- Template vào `dist/` (`nest-cli.json` `compilerOptions.assets` = `[{ "include": "modules/*/templates/**/*", "outDir": "dist", "watchAssets": true }]`): `pnpm build` → `dist/modules/notifications/templates/spike/en/body.mjml` **có**. Trong image (`docker build` với build-arg từ `docker/images.env`, rồi `readdirSync('/app/dist/modules/notifications/templates/spike/en')`) → `[ 'body.mjml' ]` **có**. Trong image, `mjml` render `<mj-button href="{{url}}">` với `strict` → `errors = 0`, giữ `href="{{url}}"`; `handlebars` import được.
- Kích thước image: **~390 MB** chưa nén (layer `node_modules` 229 MB), nén 94,7 MB. SP1 dựng lại cùng lượt: ~284 MB (`node_modules` 123 MB), nén 71,5 MB. Phần tăng lớn nhất (~38 MB byte file) **không phải mjml** mà là chuỗi `vitest`/`vite`/`rolldown`/`lightningcss`, do `better-auth` khai `vitest` là peer tuỳ chọn. Chuỗi mjml khoảng 22 MB. Chi tiết và phương án `mjml-core` + `mjml-preset-core` (không giảm đáng kể) ở ADR 0013.

**Peer `htmlnano@3.3.1` muốn `cssnano ^8`, trong cây có 7.1.9 (Task 1):** không ảnh hưởng render.

- Nguồn: chính `mjml-core@5.4.1` khai `cssnano: ^7.1.9` và `htmlnano: 3.3.1` trong `dependencies`. Peer `cssnano` của `htmlnano` là **tuỳ chọn** (`peerDependenciesMeta.cssnano.optional = true`).
- `htmlnano` chỉ được gọi khi `minify: true` (`mjml-core/lib/index.js:848`, nhánh `if (minify)`); mặc định `minify = false` (dòng 578). Task 21 không bật `minify`.
- Kể cả khi bật: `minify: true` với cssnano 7.1.9 chạy được, `errors = []`, HTML 5029 → 3813 byte, vẫn giữ `href="{{url}}"`.
- Vì vậy **không cần override**. Ép `cssnano@8` là bump major ngoài phạm vi mjml hỗ trợ, trái chính sách S2-R2 khi không có bằng chứng tương thích. Muốn `pnpm peers check` sạch thì có thể thêm `pnpm.peerDependencyRules.allowedVersions` `{ "htmlnano>cssnano": "7" }` kèm bằng chứng trên; S6 không thêm vì không cần cho chức năng.

**Nhánh:** mjml trước rồi handlebars (compile mjml một lần, cache template handlebars).

**Task bị ảnh hưởng:** Task 21 giữ nhánh chính, dùng `assets` của `nest-cli.json` đã commit ở S6, và dùng regex theo thẻ `<a>` trong test. Kích thước image là quyết định riêng của Sếp (ADR 0013), không chặn task nào.

**Giới hạn của phép đo:** chưa đo template có `{{#if}}`/`{{#each}}` bên trong thuộc tính hoặc giữa các thẻ mjml (mjml có thể đổi vị trí hoặc escape). Task 21 chỉ nên dùng placeholder đơn trong nội dung và thuộc tính. Chưa đo `watchAssets` khi chạy `nest start --watch`.

### S7 — `202` giống hệt nhau

**Kết quả: ĐẠT; không cần fallback `disabledPaths`.** `hooks.after` trả `new Response(null, { status: 202 })` thay được cả status lẫn body. Nhánh đã chọn: (1) cho đăng ký, (2) + `hooks.after` cho đổi email. Có hai ràng buộc cho Task 34: đăng ký song song, và log PII của Better Auth.

**Cách đo:** `test/integration/spike-sp2/s7-enumeration.spec.ts`, mã brief (`memoryAdapter`, `requireEmailVerification: true`, `autoSignIn: false`, `onExistingUserSignUp`, `sendOnSignUp`) chạy ở ba chế độ: `none` (không hook), `after` (nhánh 1), `before` (nhánh 2: `hooks.before` tra `internalAdapter.findUserByEmail`, gửi thông báo rồi trả `202`; `hooks.after` vẫn chuẩn hoá nhánh còn lại). Đổi email: `user.changeEmail.enabled: true` + `sendChangeEmailConfirmation`, user nguồn đã xác thực email, email đích là `taken@example.com` (đã có) và `free@example.com` (mới). Thêm một test đăng ký song song trên Postgres 18.6 (Testcontainers, `UNIQUE(email)`): 5 vòng × 3 request cùng email mới. So sánh bỏ header `date`, `x-request-id`. `pnpm vitest run --project integration test/integration/spike-sp2/s7-enumeration.spec.ts` → 7/7 xanh.

| Nhánh | Đăng ký | Đổi email | Ghi chú |
|---|---|---|---|
| Không hook (đối chứng) | **Lộ.** Cả hai 200 `application/json`, nhưng body khác: user giả của Better Auth có thêm `"image":null`, user thật không có khoá `image` | 200 `{"status":true}` cả hai; không thông báo nào cho chủ email đích | `buildGenericDuplicateResponse` (`api/routes/sign-up.mjs:159-189`) không khớp hình dạng user thật |
| (1) `onExistingUserSignUp` + `hooks.after` → `new Response(null, { status: 202 })` | **Đạt.** Cả hai `{ status: 202, headers: [], body: "" }`, không `Set-Cookie`. `notices = ['s7@example.com']`, `verifications = ['s7@example.com']` | **Đạt về phản hồi** (202 rỗng cả hai), nhưng Better Auth không gọi callback nào khi email đích đã có (`update-user.mjs:447-451`), nên không có thông báo tới chủ email đích | Hash giả do Better Auth tự chạy: **có** (`sign-up.mjs:200` gọi `password.hash` trước khi trả). Thời gian: 71 ms (mới) / 60 ms (đã có) |
| (2) `hooks.before` dừng sớm `202` | **Đạt về phản hồi**, nhưng **lộ qua thời gian**: 56 ms (mới) / 1 ms (đã có), vì dừng sớm thì bỏ qua hash giả của Better Auth | **Đạt.** Cả hai 202 rỗng; `before` gửi được thông báo cho email đích (`notices = ['before:taken@example.com']`); email mới vẫn nhận `sendChangeEmailConfirmation` (`changeMails = ['free@example.com']`) | Muốn dùng (2) cho đăng ký thì phải tự chạy hash giả; (1) đã có sẵn nên không cần |

**Đăng ký song song cùng email mới (Postgres, `UNIQUE(email)`):** cả 5 vòng đều 1 request `202` rỗng, 2 request **`422 {"message":"Failed to create user","code":"FAILED_TO_CREATE_USER"}`**. Lỗi `23505` bị Better Auth bọc thành `APIError` 422 (`sign-up.mjs:226-231`: chỉ `APIError` 403 mới đi nhánh generic). `hooks.after` của (1) bỏ qua vì `returned instanceof Error`, nên đây là một cách phân biệt được. Spec §5.8 yêu cầu "`23505` → xử lý như email đã có", nên Task 34 phải thêm: trong `hooks.after` của `/sign-up/email`, khi `returned` là `APIError` với `code = 'FAILED_TO_CREATE_USER'`, tra lại `findUserByEmail(email)`. Có user thì xử lý như email đã có (gửi thông báo qua outbox, trả `202`); không có thì giữ lỗi (lỗi DB thật, fail loud).

**PII trong log của Better Auth (ràng buộc cho Task 34):**

- `sign-up.mjs:194`: `` logger.info(`Sign-up attempt for existing email: ${email}`) ``. Mặc định logger ở mức `warn` (`@better-auth/core/dist/env/logger.mjs:58`) nên không in; Task 34 không được hạ mức log của Better Auth xuống `info`/`debug`.
- `sign-up.mjs:230-231`: `logger.error("Failed to create user", e)` với `e` là lỗi `pg` của `23505`. `detail` của lỗi này chứa `Key (email)=(…) already exists`. Logger adapter của Task 34 không được in tham số lỗi thô; chỉ log `code`/tên lỗi.

**Nhánh đã chọn:** (1) cho đăng ký (`onExistingUserSignUp` + `hooks.after` → `202` rỗng, cộng xử lý `FAILED_TO_CREATE_USER` ở trên). (2) cho đổi email (`hooks.before` tra email đích, gửi thông báo tới chủ email đích, trả `202`; `hooks.after` chuẩn hoá nhánh email mới thành `202`). Thời gian của nhánh đổi email: cả hai đường đều chỉ ghi một dòng outbox, không hash, nên chênh lệch không đáng kể (chưa đo trên outbox thật).

**Task bị ảnh hưởng:** không dùng fallback nên Task 37, 38, 40, 48 giữ nguyên. Task 34 thêm ba ràng buộc: nhánh `FAILED_TO_CREATE_USER` + tra lại email; mức log Better Auth ≥ `warn`, logger adapter không in lỗi thô; đăng ký không dùng dừng sớm ở `before`.

**Giới hạn của phép đo:** chạy với `memoryAdapter` (trừ test song song) và callback gửi mail rỗng, nên số đo thời gian chỉ cho thấy chênh lệch của hash, không đại diện cho production. Chưa đo `/request-password-reset` và `/send-verification-email` (bảng §5.8).
