# Sub-project 6 — Files, Audit, Integrations, Admin

- **Ngày:** 2026-09-28.
- **Trạng thái:** Bản thiết kế **r2, đã chốt 2026-09-29** (controller chốt theo uỷ quyền "tự chốt, tự làm hết"; các giả định chưa chạy được kiểm bằng spike ở đầu plan tương ứng). r1 sửa theo review vòng 1 và các phán quyết R-X1…R-X11 (nhật ký ở mục 22); r2 sửa theo review hội tụ vòng 2 `sp4-7-review-r2.md` và các phán quyết R-X12…R-X19 trong `.superpowers/autonomous/rulings.md` (nhật ký ở mục 23). Hợp đồng của `@PlatformStaffAction()`, port `PlatformAccessAudit` và registry order purge nay có văn bản ở addendum SP3 của plan 3D, `2026-09-28-sp3-addendum-platform-staff.md` (trích "addendum 3D §An"). Sếp đã giao toàn quyền quyết định kỹ thuật và sản phẩm ("tự chốt, tự làm hết"). Mọi quyết định em tự chốt nằm ở mục 19.1 (mã `S6-A*`). Mục 19.2 chỉ giữ những lựa chọn có hệ quả pháp lý hoặc tiền mà không có nguồn để dựa vào.
- **Chia plan** (mục 17, theo sóng W1…W8 của R-X7): **6.0** nền dùng chung (core) chỉ cần **3A** (sóng W2); **6A Files ∥ 6C Integrations** chỉ cần 6.0 (W3); **6B Audit** cần 6.0 + **3D** (W4); **6D Admin** cần 6B (W5). Việc chung của bốn phần được gom vào 6.0 để các plan sau không sửa chung một đối tượng nào.
- **Spec cha:** `docs/superpowers/specs/2026-09-24-saas-core-architecture-design.md`. Phụ lục B (file) là ràng buộc. Chỗ nào spec này lệch spec cha thì ghi ở mục 18.1.
- **Spec đi trước:**
  - SP2: `docs/superpowers/specs/2026-09-27-sp2-identity-notifications-design.md`.
  - SP3 r8 (đã commit, per R-X11): `docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`. Giao diện SP3 được dùng đúng nguyên văn; trích dẫn ghi dạng "SP3 §x". r8 không đổi giao diện nào SP6 dùng; r8 thêm điều kiện dừng 3D (SP3 §4 T7(h)), nên plan nào chờ 3D (6B, 6D) mang rủi ro đó (mục 20.1).
- **Nền tảng code:** worktree `sp2-identity` ở commit `f6ed8d2` (SP1 + SP2 và spec SP3 r8). SP3 mới có spec, chưa có code. Vì vậy mọi giao diện của tenancy và của identity-3D (`OrgScope` đi cùng `orgAccess`, `OrgPurgeParticipantContributor`, `OrgActivityGate`/`onInactiveOrg`, `definePermissionCatalogue`, `routeTemplateOf`, `staff-step-up.ts`, `AuthFacts`, `tenancy_definer`, và decorator `@PlatformStaffAction()` của 3D theo R-X2) được trích theo SP3 r8, addendum 3D và rulings. Danh sách giả định chưa kiểm chứng ở mục 20.2. **r2 kiểm lại với code:** `defineConfig` đăng ký namespace lúc import (`define-config.ts:47`), nên admin import `modules/files/index.ts` là kéo config của files vào boot (lý do của token ở `core/contracts`, S6-A52); zod trong `node_modules` là 4.6.5 (`.meta()` dùng được cho metadata secret của SP7); `src/` chưa có `markModuleLoaded`/`loadedModules` (SP7 7A thêm, R-X16).
- **Nguồn version** (kiểm trên npm registry ngày 2026-09-28): mục 3.1. Kích thước dependency được đo bằng cách cài thật vào thư mục tạm (`npm install --omit=dev --os=linux --cpu=x64`), rồi xoá `*.map`/`*.d.ts` đúng như dòng `find` của `Dockerfile:26`.

**Ký hiệu:**

| Mã | Ý nghĩa |
|---|---|
| `S6-A*` | Quyết định kỹ thuật em tự chốt |
| `R6-*` | Race đã gọi tên |
| `P*`, `F*`, `W*`, `B*`, `D*` | Spike |
| `C-*` | Test của core (plan 6.0) |
| `F-*` | Test của files |
| `A-*` | Test của audit |
| `W-*` | Test của webhook |
| `D-*` | Test của admin |
| `X-*` | Test xuyên module |

---

## 1. Mục tiêu và tiêu chí hoàn thành

Sau sub-project này, một dự án clone từ boilerplate có sẵn năm thứ:
- **Lưu file theo org** trên S3-compatible (S3, R2, MinIO) hoặc đĩa local (chỉ dev/test):
  - upload bằng presigned POST, presigned multipart, hoặc stream qua API;
  - pipeline kiểm tra gồm magic bytes, ClamAV tuỳ chọn, và port `ImageSanitizer` (bỏ EXIF, tạo thumbnail) với mặc định **no-op**; boilerplate không cài `sharp` (per R-X9), dự án tự thêm adapter;
  - quota dung lượng là một `LIMIT` của SP4 đi qua port (per R-X8): files đếm byte đang lưu **dưới khoá org**, không có bộ đếm riêng;
  - vòng đời có dọn dẹp;
  - dọn sạch object khi org bị xoá cứng.
- **Audit log** chỉ thêm, bền, có hai phạm vi (theo org và nền tảng), có retention bằng partition theo tháng. Audit là nơi nhận mọi việc SP3 hoãn sang SP6 (mục 2.3).
- **Webhook ra ngoài** cho khách hàng theo Standard Webhooks:
  - ký bằng secret xoay được;
  - retry theo lịch;
  - dead-letter có thể replay;
  - chặn SSRF bằng `HttpClient` của core.
- **API vận hành cho platform admin:** đọc org, member, audit; bật/tắt kill switch; phê duyệt hai người **mặc định từ chối** cho mọi `/api/auth/admin/*` (trừ danh sách miễn chỉ-đọc/chỉ-thu-hẹp) và cho route Nest gắn `@RequiresApproval()`. Mọi route `/v1/admin/**` dùng `@PlatformStaffAction()` do 3D sở hữu (per R-X2, addendum 3D); SP6 cài port `PlatformAccessAudit` mà decorator gọi, và kiểm lúc boot rằng mọi route `/v1/admin/**` có decorator đó (per R-X17). SP6 cung cấp `@RequiresApproval()`; module chủ route gắn nó (per R-X15).
- **Kill switch vận hành** lưu trong DB, đọc qua OpenFeature (spec cha §13.1, việc SP1 đã giao cho SP6).

Mọi tiêu chí dưới đây phải được chứng minh trên hạ tầng thật: Postgres 18 + PgBouncer + Redis + MinIO + Mailpit qua Testcontainers, cộng một lượt prod-like trên image thật bằng `docker compose --profile app` với `NODE_ENV=production` và gọi HTTP end-to-end.

1. **RLS cho mọi bảng tenant mới**, đo được như tiêu chí 1 của SP3. Các bảng là `files`, `audit_logs`, `webhook_endpoints`, `webhook_endpoint_secrets`, `webhook_endpoint_event_types`, `webhook_messages`, `webhook_deliveries`. Chạy bằng `app_user`:
   - đọc, sửa, xoá chéo org trả 0 dòng;
   - `INSERT` chéo org bị `42501`;
   - không có org context thì `P0001`;
   - FK kép chéo org bị `23503`.

   Riêng với bảng partitioned, mọi partition là con: `app_user`, `app_relay` và `auth_user` không có quyền gì trên partition, chỉ có quyền trên bảng cha (C-5).
2. **Kích thước bị chặn ở tầng lưu trữ, không chỉ ở app:**
   - presigned POST gửi body khác `sizeBytes` đã khai báo bị storage từ chối (MinIO trả 403, không có object);
   - multipart hoàn tất với tổng khác `sizeBytes` thì bị `HeadObject` phát hiện, object bị xoá, file thành `REJECTED SIZE_MISMATCH`;
   - stream qua API vượt `sizeBytes` bị ngắt ở byte đầu tiên vượt, trả `413`, không để lại object.
3. **Pipeline chặn nội dung nguy hiểm** (F-10 đến F-19):
   - MIME dò bằng magic bytes không nằm trong allowlist của purpose → `REJECTED TYPE_NOT_ALLOWED`;
   - SVG, HTML và XML luôn bị từ chối;
   - khi `FILES_SCAN=clamd`, chuỗi EICAR → `REJECTED INFECTED`, và file không bao giờ tới `READY` mà chưa được quét (fail closed);
   - **ảnh với `ImageSanitizer` mặc định (no-op):** object được phục vụ là bản gốc, `sanitized = false` hiện trong API, boot log WARN một lần `image_sanitizer_noop` khi có purpose `imagePolicy = SANITIZE`;
   - **ảnh với adapter fixture** (test hợp đồng của port): bản `clean` và thumbnail được ghi đúng một lần (`If-None-Match: *`), kích thước của chúng được tính vào quota; adapter trả `REJECTED` → file `REJECTED` với đúng lý do (`IMAGE_INVALID`, `IMAGE_TOO_LARGE`);
   - file gây crash lặp lại (poison) → `REJECTED PROCESSING_FAILED` sau `FILES_PROCESSING_MAX_ATTEMPTS` lần, không lặp vô hạn.
4. **Chỉ tải được sau khi kiểm quyền**, qua presigned GET hạn `FILES_DOWNLOAD_URL_TTL_SEC`. Response của storage có:
   - `Content-Type` bằng MIME đã dò;
   - `Content-Disposition: attachment` với tên gốc mã hoá theo RFC 6266/5987.

   Ở production, host của URL khác host API và không thuộc `AUTH_COOKIE_DOMAIN` (luật config). File `PUBLIC` chỉ có bản sao dưới prefix `public/` **sau khi** đã qua quét (bước P4) và chỉ khi dòng còn `PROCESSING` với đúng attempt đã ghi ý định; file rời `READY`/`PROCESSING` (xoá, từ chối) thì bản public bị gỡ chậm nhất sau `FILES_PUBLIC_RECHECK_SEC` + một chu kỳ sweep, kể cả khi bản sao tới muộn (R6-5, F-42).
5. **Quota dung lượng đúng dưới đua:** `N + k` lần khởi tạo upload song song, với tổng vượt hạn mức đúng `k` file, cho đúng `N` file và đúng `k` lỗi `422 quota_exceeded`. Dung lượng đang dùng là `Σ stored_bytes` của các dòng `files` còn object (gốc + `clean` + thumbnail + bản public, mục 6.3), tính lại dưới khoá org ở mỗi lần kiểm; sau một chuỗi thao tác ngẫu nhiên và sweep, tổng đó bằng đúng tổng byte mà `ListObjectsV2` thấy dưới hai prefix của org (F-30). Hạn mức lấy từ port `FileStorageLimit` (SP6 sở hữu; SP4 cài adapter ở entry `modules/entitlements/integrations/files.ts`, composition của SP7 nạp entry đó; per R-X8, R-X13; vắng SP4 thì theo config). `entitlements` bật mà không có adapter → api và worker **không khởi động** (F-34), để trần theo gói không bao giờ bị thay âm thầm bằng mặc định của config.
6. **Vòng đời không để lại object mồ côi:**
   - `PENDING` quá `FILES_PENDING_TTL_SEC` → `EXPIRED`, object và upload multipart dở dang bị xoá;
   - `DELETED` khôi phục được trong `FILES_DELETED_RETENTION_SEC`; quá hạn thì object và dòng đều bị xoá;
   - sau mỗi kịch bản test, `ListObjectsV2` theo prefix của org test chỉ còn object của file đang sống (F-40…F-45).
7. **Xoá cứng org dọn sạch file** (SP3 §9.5):
   - participant `files` xoá mọi dòng trong transaction purge;
   - subscriber của `tenancy.org.purged` enqueue job `files.purge-org-objects` (`onInactiveOrg: 'run'`); job xoá mọi object dưới `{orgId}/` và `public/{orgId}/`, huỷ mọi multipart dở dang, rồi chạy lại một lần sau `FILES_ORG_PURGE_RECHECK_SEC`;
   - sau đó list cả hai prefix đều rỗng; chạy lại nhiều lần là no-op (F-50, X-3).
8. **Audit chỉ thêm và đủ:**
   - mỗi event có cờ `audit: true` cho **đúng một** dòng audit, kể cả khi deliver bị lặp và kể cả event của org vừa purge;
   - `app_user` không `UPDATE`/`DELETE`/`TRUNCATE` được bảng audit (grant, và trigger chặn);
   - partition hết hạn bị job drop; hàm drop từ chối retention dưới sàn `AUDIT_RETENTION_MIN_MONTHS` kể cả khi bị gọi trực tiếp (A-1…A-12).
9. **Mọi việc SP3 hoãn sang SP6 có đầu ra kiểm được** (mục 2.3):
   - **Endpoint `/api/auth/admin/*` của nhân viên:**
     - mọi request đã qua gate để lại một cặp `identity.auth_action.attempted` và `identity.auth_action.completed`;
     - không ghi được `attempted` → `503`, handler của Better Auth không chạy (A-20).
   - **Lệnh `identity:staff-2fa-reset`:** mỗi lần commit có một dòng audit `identity.security_notice.recorded` mang `kind = operator_reset` và ticket. Dòng này vẫn còn sau khi housekeeping của SP2 xoá marker (A-23).
   - **Đăng nhập:** tạo session → `identity.session.created`.
   - **API key của user:** tạo, sửa, xoá → cặp `attempted`/`completed`.
   - **Phê duyệt hai người** (khi bật `ADMIN_DUAL_CONTROL=on`): **mọi** path `/admin/*` của Better Auth, kể cả `/admin/impersonate-user` và path plugin thêm sau này, bị chặn nếu thiếu phê duyệt hợp lệ, trừ danh sách miễn tường minh (chỉ đọc, chỉ thu hẹp); route Nest gắn `@RequiresApproval()` cũng vậy. Phê duyệt gắn với đúng `(method, path, query, body)` của request, và chỉ dùng được đúng một lần (D-20…D-27).
   - **Thao tác của platform admin trên org** (xoá tài khoản owner, thu hồi grant do đổi role) nối được với event hệ thống của tenancy qua `correlationId` (X-5).
10. **Webhook đúng hợp đồng Standard Webhooks:**
    - chữ ký verify được bằng `new Webhook(secret).verify` của package `standardwebhooks` với **mỗi** secret còn hiệu lực trong thời gian chồng lấn khi xoay (W-1…W-4);
    - retry theo `INTEGRATIONS_RETRY_SCHEDULE_SEC`; hết lịch thì `EXHAUSTED` và phát event `integrations.delivery.exhausted`; replay và recover đi qua API (W-10…W-16);
    - URL trỏ tới loopback, RFC1918, link-local, metadata cloud hay IPv4-mapped bị từ chối cả lúc đăng ký (`422`) lẫn lúc gửi (DNS rebinding; W-20…W-24); redirect không được theo;
    - endpoint lỗi liên tục quá `INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC` tự tắt đúng một lần;
    - giết worker giữa lúc gửi không làm mất delivery (lease + sweep) và không có hai lần ghi kết quả cho cùng một lần thử (fencing theo `attempts_total`; W-30…W-33).
11. **Kill switch có hiệu lực trên mọi pod** trong `FLAGS_REFRESH_INTERVAL_MS + 1 s` (C-20…C-24):
    - `files.uploads` bị tắt → khởi tạo upload và `PUT` upload trả `503`;
    - `integrations.webhook_delivery` bị tắt → không có request ra ngoài, delivery giữ nguyên và chạy lại khi bật;
    - DB lỗi → giữ snapshot cuối (fail-static), không đổi hành vi.
12. **Route admin** (ở mọi module, không chỉ `admin`):
    - app **không khởi động** nếu có handler dưới `/v1/admin/**` thiếu `@PlatformStaffAction()` của 3D, nếu handler mang decorator đó nằm ngoài `/v1/admin/**`, nếu có route admin mà port `PlatformAccessAudit` chưa được cài (không có provider, hoặc provider là `NoopPlatformAccessAudit`; addendum 3D §A3), hoặc nếu handler mang `@RequiresApproval()` mà thiếu `@PlatformStaffAction()` (A-26);
    - mỗi request tới route đó, kể cả `GET`, ghi `audit.staff_access.recorded` **trước** khi handler chạy, qua port `PlatformAccessAudit` mà 6B cài; ghi lỗi thì `503`, handler không chạy (A-27). Guard (step-up, mã lỗi theo `AUTH_MODE`, `external`) là của 3D (per R-X2, bảng status ở addendum 3D §A1.3) và được test ở 3D.
13. **DB lỗi → `503`**; lỗi S3 → `502 upstream_error` hoặc `504 upstream_timeout`; clamd lỗi → job retry, file giữ `PROCESSING` (chaos C-30…C-33).
14. **Không PII** trong log, metric, span hay failed reason:
    - không tên file gốc;
    - không URL webhook;
    - không nội dung body;
    - không `reason` của phê duyệt;
    - không ticket trong log (ticket chỉ có trong audit).
15. **Pipeline xanh ở từng plan:** lint, type-check, unit, integration, migration up → down → up **và** sweep S2-R57, `oasdiff` chỉ thêm, luật kiến trúc mục 5.4 kèm fixture phải fail, smoke prod-like. Kích thước image đo và ghi vào ADR 0013, và không vượt 400 MB chưa nén (ước lượng ~365–370 MB sau SP3 + SP6, mục 3.1).
16. **Chuẩn hoá:** bảng chuẩn hoá mục 6.9 phủ mọi cột của mọi bảng SP6; `normalization-inventory.spec.ts` fail khi có cột chưa phân tích.

---

## 2. Phạm vi

### 2.1 Trong phạm vi

- **`src/core`** (plan 6.0):
  - cờ `audit`/`webhook` **bắt buộc** trên `defineEvent` (per R-X3), và subscriber theo bộ chọn (một subscriber nhận nhiều event);
  - hạ tầng partition theo tháng: registry, cron, role `partition_owner`;
  - `BodyParserPolicy` nhiều chủ;
  - kill switch qua OpenFeature (`core/flags`, bảng `kill_switches`);
  - role `sweep_definer` dùng chung cho mọi SP và helper `defineOrgSweep` + `OrgSweepRunner` (per R-X4, R-X14: nhận **tên hàm SQL** có chữ ký cố định `(p_after, p_limit)` cộng tham số thêm **theo tên**; SP5, SP7 dùng lại);
  - `routeTemplateOf` chuyển từ tenancy vào `core/http` (người dùng thật: `OrgRouteInventory` của tenancy, `PlatformStaffGuard` của identity ở 3D (addendum 3D §A3) và `PlatformStaffRouteInventory` của identity ở 6B);
  - file hợp đồng nhỏ `src/core/contracts/admin-readers.ts` (per R-X16): token trừu tượng `FileUsageReader`, `WebhookStatsReader` mà files và integrations cài, admin inject `@Optional()`, không ai import `index.ts` của module kia; `DEFINER_LIMIT_MAX` và `PURGE_CURSOR_START` chuyển vào `core/sweep` (người dùng: tenancy và `OrgSweepRunner`);
  - tenancy export `OrgMutationLock` (6A và 6C cùng dùng).
- **`src/modules/files`** (6A): mọi thứ ở phụ lục B, cộng `file_purposes`, kiểm hạn mức dung lượng qua port `FileStorageLimit` (SP6 sở hữu, per R-X13), port `ImageSanitizer` (no-op), purge participant, dọn object sau purge, bản cài token `FileUsageReader` của `core/contracts`.
- **`src/modules/audit`** (6B):
  - `audit_logs` (tenant) và `platform_audit_logs` (nền tảng), partitioned;
  - subscriber `audit.recorder`;
  - API đọc theo org;
  - các thay đổi identity để có audit bền cho các việc SP3 hoãn (mục 2.3);
  - bản cài port `PlatformAccessAudit` của `@PlatformStaffAction()` (addendum 3D §A3; thay `NoopPlatformAccessAudit` của 3D, per R-X2) và kiểm lúc boot `PlatformStaffRouteInventory` (per R-X12, R-X17).
- **`src/modules/integrations`** (6C): webhook endpoint, secret xoay được, catalog event type, fan-out, gửi, retry, dead-letter, recover, purge participant, bản cài token `WebhookStatsReader` của `core/contracts`.
- **`src/modules/admin`** (6D):
  - route `/v1/admin/*` (org, member, org của một user, audit, kill switch, phê duyệt), tất cả mang `@PlatformStaffAction()` của 3D;
  - phê duyệt hai người: `admin_approvals`, port `AdminActionApprovals` của identity, bước mặc định-từ-chối trong hook `/admin/*`, decorator `@RequiresApproval()` cho route Nest. SP6 **cung cấp** decorator (và hàm đọc `requiresApprovalOf`); module chủ route **gắn** nó lên route của mình. SP6 không gắn decorator lên route của module khác: SP5 sở hữu việc gắn nó lên ba route tiền tay (per R-X15);
  - `PlatformOrgDirectory` export từ tenancy.
- **Compose:** `minio` + `minio-init` (tạo bucket, CORS dev), profile `scan` cho `clamav`. Hiện tại compose **chưa có** MinIO (spec cha §13.1 ghi có, nhưng SP1 hoãn tới "SP có dùng tới"), nên brief ghi "MinIO có sẵn" là chưa đúng với code; plan 6A thêm vào.
- **ADR:**
  - mới: **0020** "Files, audit bền và webhook ra ngoài" (một ADR, ba phần; per R-X6: 0018 là SP4, 0019 là SP5, 0021 là SP7);
  - cập nhật: 0005, 0006, 0007, 0013, 0016;
  - danh sách sửa spec cha và spec trước (mục 18).

### 2.2 Ngoài phạm vi

| Việc | Lý do | Điểm mở rộng |
|---|---|---|
| tus resumable | Phụ lục B ghi "tuỳ chọn, tắt mặc định". Spec cha §17 ghi `@tus/server` "chỉ cài khi bật" vì kéo thêm client Redis. Boilerplate không cài (S6-A9) | README công thức: driver `FileStorage` đã có, dự án cài `@tus/server` + `@tus/s3-store`, rồi gọi `FileIngest.acceptUploaded(orgId, fileId)` khi tus xong |
| Webhook cấp nền tảng (gửi tới CRM/admin nội bộ) | Spec cha §2 định nghĩa Integrations là `WebhookEndpoint`, `Delivery` của khách. Việc "dùng CRM/admin sẵn có" (§0.2) đã được `AUTH_MODE=external` + API admin phục vụ (mục 9.4) | Thêm cột `scope` cho `webhook_endpoints` bằng migration khi có dự án cần |
| Tìm audit xuyên org theo actor | YAGNI: admin đọc theo org (OrgScope) và đọc bảng nền tảng; chưa có use case | Hàm definer đọc `audit_logs` theo `actor_id`, owner `partition_owner` |
| Stream audit ra SIEM | Chưa có yêu cầu | Subscriber thứ hai với bộ chọn `audit`, job gửi qua `HttpClient` |
| Xoá cứng file theo lô nhiều transaction trong purge org | Cùng giới hạn DB-M13 của SP3 §9.5 | Như SP3 §19 |
| Adapter `ImageSanitizer` thật (ví dụ `sharp`, LGPL-3.0) | Per R-X9: pháp chế chưa trả lời về LGPL, và `sharp` tốn 20 MB image. Boilerplate chỉ ship port + no-op + test hợp đồng bằng adapter fixture (S6-A13) | Dự án cài `sharp`, viết adapter trong `files/infra/image/` (luật kiến trúc 20 đã cho phép), đặt `QUEUE_CONCURRENCY_OVERRIDES=files=<n>` theo bộ nhớ; không đổi schema (cột `clean_size_bytes`, `thumbnail_size_bytes`, lý do `IMAGE_*` đã có) |
| Thông báo in-app, preference, template do tenant sửa, locale theo user, SMS/push, email bounce | SP2 ghi "dự kiến SP6". Phụ lục C của spec cha **không** đưa chúng vào SP6 (chỉ Files, Audit, Integrations, Admin), và chưa có use case | Chuyển chủ sở hữu sang "SP đầu tiên có use case" (mục 2.3, 18.2) |

### 2.3 Sổ việc được giao cho SP6 (đủ, có nguồn, có cách xử lý)

Quét mọi chỗ ghi "SP6" trong spec cha, SP1, SP2 và SP3 (r7 lúc viết r0; r1 đối chiếu lại với r8 đã commit, không có việc mới; kể cả ADR 0017 và `2026-09-28-sp3-parent-spec-amendments.md`):

| # | Nguồn | Việc hoãn | Cách xử lý ở SP6 | Plan |
|---|---|---|---|---|
| L1 | SP3 §6.6, §14, §19; ADR 0017 hệ quả | Audit tiêu thụ **mọi** `tenancy.*` (lịch sử member đã xoá nằm ở đây) | Mọi event tenancy có cờ `audit: true`. Subscriber `audit.recorder` ghi `audit_logs` với `actor_user_id` (ánh xạ `principal.id` → `tenancy_users.public_id`, SP3 §14) | 6B |
| L2 | SP3 §9.6, §14.1 (4 chỗ: "admin thực hiện được audit ở phía identity (SP6)") | Actor thật của thao tác admin làm tenancy phát event với actor `system` (xoá tài khoản, thu hồi grant khi ghi role) | Hook identity ghi cặp `identity.auth_action.attempted`/`completed` với actor là nhân viên. Event hệ thống của tenancy cùng `correlationId` (request id của mount). API audit lọc được theo `correlationId` (mục 8.2) | 6B |
| L3 | SP3 §9.7 (5), ranh giới (vi), §21; ADR 0017 phương án loại "bảng audit riêng cho lệnh reset" | Marker `operator_reset` không phải audit lâu dài: bị xoá sau `AUTH_SECURITY_NOTICE_RETENTION_DAYS` và bị `CASCADE` theo user | `SecurityNoticeService.deliver` phát `identity.security_notice.recorded` (id v5 theo marker, `ifAbsent`) **trước** khi đưa marker về trạng thái cuối. Marker chỉ bị housekeeping xoá sau khi đã gửi, nên dòng audit luôn có trước khi marker mất. Ngoại lệ: user bị xoá trước lần chạy cron (R6-22) | 6B |
| L4 | SP3 §9.7 phương án loại "phê duyệt hai người", §19, §21, ranh giới (i); ADR 0017 hệ quả (3); SP5 §11.3 ("phê duyệt hai người là SP6") | Phê duyệt hai người cho `/admin/*` với người đang giữ factor, và cho thao tác tiền tay của SP5 | `admin_approvals` + port `AdminActionApprovals`: bước mặc định-từ-chối trong hook `before` của mọi `/admin/*` (trừ `ADMIN_APPROVAL_EXEMPT_PATHS`), và `@RequiresApproval()` cho route Nest. Phê duyệt gắn với `(method, path, query, body)`, không theo danh sách action (S6-A41). Tuỳ chọn `ADMIN_DUAL_CONTROL`, mặc định `off` (S6-A40) | 6D |
| L5 | SP3 §9.7 SEC-M13 ("SP6 thêm audit và cảnh báo") | Audit và cảnh báo khi dùng `/admin/*` | L2 + metric `identity_auth_actions_total{path_group, outcome}` + luật cảnh báo trong runbook cho nhóm `privilege` (mục 15) | 6B |
| L6 | SP3 §19 "hộp thư lời mời, SCIM, dọn lời mời/link đã kết thúc: SP6/SP sau" | Dọn lời mời cũ | **Không làm ở SP6:** dữ liệu của tenancy (module khác không được ghi); khối lượng có trần (SP3 ước ≤ 10.000 org × 100). Sửa SP3 §19: chủ sở hữu "SP sau" | — |
| L7 | SP3 §23.2 câu 2 ("SP6 thông báo in-app") | Thư hoặc thông báo khi bị xoá khỏi org / đổi role | **Không làm:** in-app không thuộc SP6 (L9). Khách nhận được qua webhook `tenancy.member.removed`/`role_changed` (6C), và qua audit | 6C (webhook) |
| L8 | SP2 §11.2, spec cha §11 ("Secret ký webhook thuộc SP6") | Secret ký và xoay | `webhook_endpoint_secrets` (mã hoá bằng `FieldCipher`), xoay có chồng lấn, ký nhiều chữ ký (mục 8.3) | 6C |
| L9 | SP2 §2 bảng hoãn (in-app, preference, template tenant, locale theo user, SMS/push, bounce: "dự kiến SP6") | Mở rộng notifications | **Không làm:** ngoài phụ lục C mục 6. Sửa bảng hoãn của SP2: chủ sở hữu "SP đầu tiên có use case" | — |
| L10 | SP1 §2 ("OpenFeature và kill switch (sub-project 6)"), spec cha §13.1 | Kill switch trong DB qua OpenFeature | `core/flags` (6.0) + route admin (6D). Hai switch đầu tiên: `files.uploads`, `integrations.webhook_delivery` | 6.0, 6D |
| L11 | SP2 §5.16 (`email_deliveries` có thể thêm `BOUNCED` "ở SP6") | Trạng thái bounce | Như L9 | — |
| L12 | Spec cha §11 "Audit log: đăng nhập, đổi role, API key, thao tác billing của admin, xuất dữ liệu" | Danh sách tối thiểu cho audit | Đăng nhập: `identity.session.created`. Đổi role: `tenancy.member.role_changed` + `/admin/set-role`. API key: user (hook) + org (`tenancy.api_key.*`). Billing: SP5 phải khai `audit` tường minh trên mọi event (cờ bắt buộc, per R-X3; mục 18.4). Thao tác đọc của nhân viên trên route admin của SP4/SP5: `audit.staff_access.recorded` qua port của `@PlatformStaffAction()`. Xuất dữ liệu: feature khai cờ trên event export của mình | 6.0 (cờ), 6B |

---

## 3. Ràng buộc toàn cục

Giữ nguyên mục 3 của SP2 và SP3, gồm mọi quy tắc migration của SP3 §3.8 và §6.13:
- `down` đối xứng;
- `SET LOCAL ROLE … RESET ROLE` cho hàm và bảng của role NOLOGIN;
- mẫu `NO FORCE … FORCE` cho mọi DML trên bảng FORCE trong migration;
- không `isTransactional() = false`;
- không rò `SET CONSTRAINTS`;
- timestamp mới nhất khi rebase.

### 3.1 Package (npm registry, 2026-09-28)

| Package | Version kỳ vọng | Kích thước cài thật | Dùng ở | Lý do |
|---|---|---|---|---|
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/s3-presigned-post`, `@aws-sdk/lib-storage` | 3.1141.0 (cùng nhịp) | phần lớn của tổng dưới (39 package) | `files/infra/s3` | Spec cha §17; client S3-compatible chính thức; có presigned POST (`content-length-range`); `PutObject` có `IfNoneMatch` (đã đọc `dist-cjs/index.js` của 3.1141.0: header `If-None-Match` trong `PutObjectRequest`) |
| `file-type` | 22.1.1 | 0,14 MB | `files/infra/detect` | Magic bytes (spec cha §11); ESM, `node >= 22` |
| `clamscan` + `@types/clamscan` (dev) | 2.4.0 / 2.4.1 | 0,3 MB | `files/infra/scan` | Client clamd phổ biến nhất (~400 nghìn lượt/tuần), không dependency. Bản cuối 2024-10 nên spike F2 kiểm, có fallback (S6-A12) |
| `standardwebhooks` | 1.1.1 | ~40 KB cùng dependency | `integrations/infra` | Thư viện tham chiếu của Standard Webhooks: `sign(msgId, timestamp, payload)` trả `v1,<base64>`, `verify` nhận nhiều chữ ký (đã đọc `.d.ts`) |
| `@openfeature/server-sdk` | 1.23.0 | ~0,6 MB cùng `@openfeature/core` | `core/flags` | Spec cha §13.1, §17. Không dùng `@openfeature/nestjs-sdk` (chưa hỗ trợ Nest 12) |
| `@testcontainers/minio` (dev) | 12.1.0 | — | test | Cùng nhịp `testcontainers` 12.1.0 đang dùng |

- **Kích thước (r1, đo lại không có `sharp`, per R-X9).** Cài đúng tám package runtime ở trên (`npm install --omit=dev --os=linux --cpu=x64`, 54 package kể cả phụ thuộc, 2026-09-28): **18 MB** trước khi xoá, **9 MB** sau khi xoá `*.map`/`*.d.ts`/`*.d.mts`/`*.d.cts` như `Dockerfile:26`. Số của review ops (bộ SP3 + SP6, có `@casl/ability`) là khoảng 10 MB, khớp. Ước lượng: 352 MB (SP2, ADR 0013) + ~10 MB (SP3 + SP6 runtime) + 3–6 MB `dist/` của SP3…SP7 ≈ **365–370 MB**, còn khoảng 30 MB dưới mốc 400 MB. SP4, SP5, SP7 không thêm package runtime. Số thật đo ở X-6 (`docker image inspect`) và ghi ADR 0013 ở mỗi plan có package mới (6A, 6C, 6.0).
- **Không cài:**
  - `sharp` (per R-X9, mục 2.2; port `ImageSanitizer` + no-op);
  - `@tus/server` (§2.2);
  - `pg_partman`: extension không có trong image Postgres chính thức, và managed provider hỗ trợ khác nhau (S6-A20);
  - `minio`, `aws4fetch`: spec cha chọn AWS SDK. `aws4fetch` không có presigned POST, tự viết client S3 trái luật package-first;
  - `svix`: SDK của một dịch vụ trả phí; `standardwebhooks` là phần mở của nó;
  - `canonicalize`: so sánh `jsonb` của Postgres đã không phân biệt thứ tự khoá (S6-A43).
- Lệnh cài: `pnpm add <pkg>`, không ghi version. Version khác bảng thì dừng, đọc changelog, cập nhật spec, báo Sếp (quy ước SP3 §3.1).

### 3.2 Quy tắc riêng của SP6

1. **Hai role NOLOGIN mới**, tạo trong `docker/postgres/init/01-roles.sh` (plan 6.0), cùng mẫu với `tenancy_definer` của SP3:
   - `partition_owner` sở hữu mọi bảng partitioned và hàm bảo trì partition;
   - `sweep_definer` sở hữu **mọi** hàm `SECURITY DEFINER` "quét xuyên org, trả `org_id` đến hạn" của mọi module và feature (per R-X4): `files_orgs_due`, `integrations_orgs_due` (SP6), hàm quét của SP4/SP5/SP7. `tenancy_definer` giữ nguyên, chỉ cho tenancy (SP3 r8). Policy đọc cho role này đặt tên thống nhất `<bảng>_definer_read … TO sweep_definer`, và migration nào dùng role thì `RAISE` nếu role chưa có (mẫu SP3).

   Cả hai là `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`, có `GRANT USAGE, CREATE ON SCHEMA public`, và `GRANT <role> TO app_owner WITH INHERIT FALSE, SET TRUE`. Mọi DDL trên đối tượng của hai role này trong migration nằm giữa `SET LOCAL ROLE <role>` và `RESET ROLE` (cùng lý do S3-A31). Test quét migration mở rộng hằng `NOLOGIN_OWNER_ROLES`.
2. **Hàm của `partition_owner` và `sweep_definer` luôn là `SECURITY DEFINER SET search_path = ''`**, gọi bảng bằng tên đủ `public.`, `REVOKE ALL … FROM PUBLIC` rồi `GRANT EXECUTE … TO app_user`. Tham số ngoài biên hoặc `NULL` thì `RAISE`. Mặc định của `01-roles.sh` chỉ thu `EXECUTE` của hàm do `app_owner` tạo, nên mọi hàm của hai role này phải `REVOKE` tường minh.
3. **Không I/O ngoài trong transaction DB**, gồm S3, clamd, HTTP webhook. Mẫu chung:
   - ghi ý định trong transaction (CAS trạng thái, lease);
   - làm I/O sau commit;
   - ghi kết quả bằng CAS có fencing token.
4. **Mọi object key sinh ở app từ UUID v7 và `org_id`**, không bao giờ từ input client. Tên file gốc chỉ là dữ liệu, không bao giờ vào key hay đường dẫn (chặn path traversal).
5. **Mọi đường I/O tới storage có deadline** lấy từ config (`FILES_S3_TIMEOUT_MS`, `FILES_CLAMD_TIMEOUT_MS`). Mọi stream được huỷ trên mọi đường thoát (`finally`: `destroy()` stream, `abort()` upload của `lib-storage`, đóng socket clamd).

---

## 4. Spike (bước đầu của plan tương ứng)

Chỉ gồm câu hỏi phải chạy code mới trả lời được. Kết quả ghi vào ADR của plan.

| # | Plan | Câu hỏi | Tiêu chí đạt | Fallback |
|---|---|---|---|---|
| P1 | 6.0 | Trên PG 18, hàm `SECURITY DEFINER` do `partition_owner` (NOLOGIN, INHERIT FALSE) sở hữu tạo được partition bằng `CREATE TABLE … (LIKE parent INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` + `ALTER TABLE parent ATTACH PARTITION` không? Mức khoá (`pg_locks`) là gì? `DETACH` + `DROP` giữ `ACCESS EXCLUSIVE` bao lâu? Trigger dòng khai trên cha có tự nhân bản sang partition mới không? `app_user` đọc thẳng partition có bị `42501` không (không có grant)? Index của cha có tự tạo trên partition khi `ATTACH` không? | ATTACH chỉ giữ `SHARE UPDATE EXCLUSIVE` trên cha. Trigger append-only bắn trên partition. Đọc thẳng partition bị `42501`. `DETACH`/`DROP` xong dưới `lock_timeout` 5 s khi có ghi song song | Nếu ATTACH giữ khoá mạnh hơn: tạo trước `AUDIT_PARTITION_PREMAKE_MONTHS` tháng ở cửa sổ ít tải (cron 03:00) và chấp nhận chặn ghi ngắn, ghi ADR 0019 |
| P2 | 6.0 | Với FK giữa hai bảng partitioned (`webhook_deliveries` → `webhook_messages`, khoá gồm cột partition), thứ tự `DETACH`/`DROP` nào chạy được? | Drop partition con (deliveries) của tháng M rồi mới tới cha (messages) tháng M: xanh. Thứ tự ngược: lỗi FK rõ ràng | Bỏ FK, giữ nhất quán bằng cùng tháng (tạo cùng transaction, cùng `created_at`) + test bất biến |
| P3 | 6.0 | `@openfeature/server-sdk` 1.23.0 import ESM dưới SWC/`nodenext`? `OpenFeature.setProviderAndWait(provider)` chạy được? Provider tự viết cài `resolveBooleanEvaluation` đồng bộ được không? `OpenFeature.close()` lúc tắt có gọi `onClose` của provider không? | Probe trong repo xanh | Không có fallback package: nếu SDK không import được, `core/flags` đọc snapshot trực tiếp, ghi ADR, báo Sếp (spec cha bắt buộc OpenFeature) |
| F1 | 6A | Presigned POST (`@aws-sdk/s3-presigned-post`) với `["content-length-range", n, n]` và `["eq", "$key", k]` trên MinIO: body `n ± 1` byte bị từ chối, không tạo object? Presign có gọi mạng không (API chạy được khi S3 sập)? | Cả hai đúng | Nếu MinIO không ép `content-length-range`: dev dùng multipart và kiểm bằng `HeadObject` như R2; ghi ADR 0018 |
| F2 | 6A | `clamscan` 2.4.0 ở chế độ chỉ clamd TCP (`preference: 'clamdscan'`, `clamscan.active = false`, `clamdscan.localFallback = false`) có `scanStream(readable)` trả `{ isInfected, viruses }` không, có tôn trọng timeout không, và **không bao giờ** spawn binary? Chạy với (a) clamd giả (server TCP trả `stream: OK` / `stream: Eicar-Signature FOUND` / đóng socket / treo) và (b) image `clamav/clamav` thật | Đủ bốn nhánh; không `child_process` nào được gọi (spy); treo → lỗi timeout sau `FILES_CLAMD_TIMEOUT_MS` | Tự viết client `INSTREAM` (khoảng 60 dòng trên `node:net`), ghi ADR 0018 với lý do loại `clamscan` (S6-A12) |
| F3 | 6A | `PutObject` với `IfNoneMatch: '*'` trên MinIO (image trong `docker/images.env`): key đã có → `412 PreconditionFailed` và object giữ nguyên byte; key chưa có → ghi được. Hai lời gọi song song cùng key → đúng một thành công | Cả ba đúng | Key của bản sinh ra mang attempt (`{key}.a{n}.clean`, `{key}.a{n}.thumb.webp`), thêm cột `variant_attempt INT NULL` ghi attempt thắng ở P7, sweep xoá theo prefix `{object_key}`; ghi ADR 0020 |
| F5 | 6A | `CopyObject` với `CopySourceIfMatch` trên MinIO: ETag sai → `412 PreconditionFailed`, object đích không đổi. Sao được object 5 GiB (cận trên của `FILES_MULTIPART_MAX_BYTES`) bằng một lời gọi không? | Cả hai đúng | Object lớn hơn giới hạn của một lời gọi: sao bằng `UploadPartCopy` (multipart copy), vẫn có `CopySourceIfMatch` |
| F4 | 6A | `lib-storage` `Upload` từ `Readable` có độ dài biết trước lên MinIO: `abort()` giữa chừng có huỷ multipart không (không còn upload dở ở `ListMultipartUploads`)? | Đúng | Sau `abort()` gọi `AbortMultipartUpload` tường minh bằng `UploadId` |
| W1 | 6C | `standardwebhooks` 1.1.1 (CommonJS) import được từ ESM? `sign()` với hai secret nối bằng dấu cách → `verify()` nhận khi chỉ có một trong hai secret? Có nhận secret có tiền tố `whsec_` không? | Đúng cả ba | Không cần: chữ ký là HMAC-SHA256 chuẩn, nhưng vẫn dùng package cho `verify` trong test contract |
| B1 | 6B | Better Auth 1.7.6: `databaseHooks.session.create.after` có chạy cho mọi đường tạo session (email/password, social callback, `genericOAuth` callback, `two-factor/verify-*` lúc đăng nhập) không? Nó nhận `session.id`, `session.userId` và `context.path` (`tryGetCurrentAuthEndpointContext`) không? Có chạy **sau** commit không? | Đúng ở mọi đường đã bật trong SP2 | Tìm path thiếu, thêm hook `after` theo path, ghi ADR 0010 |
| D1 | 6D | Trong `hooks.before` của Better Auth 1.7.6, `ctx.body` và `ctx.query` có **đúng là** đối tượng mà handler của `/admin/*` đọc (cùng tham chiếu sau khi schema của endpoint đã parse), và `ctx.path` có là path của endpoint (không có `basePath`)? Danh sách endpoint của instance runtime lấy được từ thuộc tính `path` của endpoint (`better-call` 1.4.0 `endpoint.mjs:55`: `internalHandler.path = path`)? | Đúng cả ba | Nếu body của hook khác body của handler: bước phê duyệt so trên body **đã parse bằng chính schema của endpoint** (`endpoint.options.body.parse`) trước khi băm, ghi ADR 0020 |

---
## 5. Kiến trúc và ranh giới module

### 5.1 Vị trí code

```
src/core/
  flags/          flags.module.ts · kill-switch.ts (defineKillSwitch, registry) · db-kill-switch.provider.ts (OpenFeature Provider)
                  kill-switches.service.ts (isKilled, set) · flags.config.ts                                   (6.0)
  partitions/     partitioned-table.ts (definePartitionedTable, registry) · partitions.jobs.ts (cron core.partitions.maintain)
                  maintain-partitions.handler.ts · partitions.config.ts                                        (6.0)
  events/         event-definition.ts (+ audit, webhook: bắt buộc) · subscriber.decorator.ts (+ EventSelector) · event-dispatch.handlers.ts
  http/           body-parser-policy.ts (nhiều chủ, marker @BodyParserOwner) · content-type.middleware.ts · json-body-parser.ts
                  route-template.ts (routeTemplateOf, chuyển từ tenancy/http/org-route.ts)
  sweep/          org-sweep.ts (defineOrgSweep, registry) · org-sweep.runner.ts (OrgSweepRunner) · constants.ts
                  (DEFINER_LIMIT_MAX, PURGE_CURSOR_START, chuyển từ tenancy)                                     (6.0)
  contracts/      admin-readers.ts (FileUsageReader, WebhookStatsReader: abstract class làm token, R-X16)        (6.0)
src/modules/files/                                                                                             (6A)
  index.ts (dòng đầu: markModuleLoaded('files'), R-X16) · files.module.ts · files.config.ts · errors.ts · events.ts · jobs.ts
  permissions.ts · purposes.ts
  domain/        file.ts (state machine) · file-purpose.ts (defineFilePurpose) · object-keys.ts · upload-plan.ts
  application/   upload.service.ts · complete-upload.service.ts · download.service.ts · file-lifecycle.service.ts
                 process-file.handler.ts · sweep.handlers.ts · purge-org-objects.handler.ts · org-purged.subscriber.ts
                 file-purpose-check.ts (boot: code ↔ file_purposes) · files-purge.participant.ts · file-store.ts (API cho feature)
                 file-usage.reader.ts (cài token FileUsageReader của core/contracts, cho admin)
                 file-storage-limit.check.ts (kiểm lúc boot của port FileStorageLimit, R-X13; 4B thêm, §8.1)
  ports/         file-storage.ts · malware-scanner.ts · image-sanitizer.ts · content-sniffer.ts · file-storage-limit.ts
                 file-repository.ts
  http/          files.controller.ts · file-transfer.controller.ts (/v1/file-uploads, /v1/file-downloads) · schemas.ts
  infra/         s3/s3-file-storage.ts · local/local-file-storage.ts · scan/clamd-scanner.ts · scan/noop-scanner.ts
                 image/noop-image-sanitizer.ts · detect/file-type-sniffer.ts · sql/sql-file.repository.ts
                 transfer-token.ts (FieldCipher)
src/modules/audit/                                                                                             (6B)
  index.ts (dòng đầu: markModuleLoaded('audit')) · audit.module.ts · audit.config.ts · permissions.ts · partitions.ts
  application/   audit-recorder.subscriber.ts · audit-reader.ts (export) · actor-mapper.ts
                 platform-access-audit.adapter.ts (cài PlatformAccessAudit của 3D, addendum 3D §A3)
  ports/         audit-repository.ts
  http/          org-audit.controller.ts · schemas.ts
  infra/mikro-orm/ audit-log.entity.ts · platform-audit-log.entity.ts · mikro-orm-audit.repository.ts
src/modules/integrations/                                                                                      (6C)
  index.ts (dòng đầu: markModuleLoaded('integrations')) · integrations.module.ts · integrations.config.ts · errors.ts · events.ts
  jobs.ts · permissions.ts · partitions.ts
  domain/        webhook-endpoint.ts · webhook-delivery.ts (state machine) · retry-schedule.ts · webhook-payload.ts
  application/   endpoint.service.ts · fanout.subscriber.ts · deliver-webhook.handler.ts · sweep.handlers.ts
                 event-catalogue-check.ts (boot: webhook_event_types ↔ cờ webhook) · integrations-purge.participant.ts
                 webhook-stats.reader.ts (cài token WebhookStatsReader của core/contracts, cho admin)
  ports/         endpoint-repository.ts · delivery-repository.ts · webhook-signer.ts · url-guard.ts
  http/          webhook-endpoints.controller.ts · webhook-deliveries.controller.ts · event-types.controller.ts · schemas.ts
  infra/         standard-webhooks.signer.ts · dns-url-guard.ts · sql/*.repository.ts
src/modules/admin/                                                                                             (6D)
  index.ts (dòng đầu: markModuleLoaded('admin')) · admin.module.ts · admin.config.ts · errors.ts · events.ts
  application/   approvals.service.ts · admin-action-approvals.adapter.ts (cài port của identity) · kill-switch-admin.service.ts
                 org-admin.service.ts
  http/          admin-orgs.controller.ts · admin-users.controller.ts · admin-audit.controller.ts
                 admin-kill-switches.controller.ts · admin-approvals.controller.ts · schemas.ts
  infra/sql/     sql-approval.repository.ts
src/modules/identity/ (SP6 thêm, không đổi code của 3D)
  http/          platform-staff-route-inventory.ts (6B) · requires-approval.decorator.ts (+ requiresApprovalOf) + approval.guard.ts (6D)
  infra/better-auth/ admin-approval-step.ts (6D, bước phê duyệt trong hooks.before) · auth-action-audit.ts (6B)
src/migrations/{core,files,audit,integrations,admin,tenancy}/ · docker/postgres/init/01-roles.sh (+ 2 role)
```

Controller mỏng: parse → service → `serialize`, như SP3. Repository dùng `Db.execute` trên EM đang gắn (SQL thuần), theo mẫu SP3. Riêng audit đọc bằng MikroORM `findByCursor` qua `withClientCursor` của core, vì spec cha §3 chốt cursor pagination là cursor của MikroORM.

### 5.2 Hướng phụ thuộc

```
features → files | audit | integrations (index)            (feature dùng API công khai)
admin    → identity, tenancy, audit (index); core/contracts (token FileUsageReader, WebhookStatsReader, @Optional)
admin    → KHÔNG import files/integrations (per R-X16)
audit    → tenancy (index: TenancyUserIds)                    (conformist, spec cha §2)
files, integrations → tenancy (index: participant, catalogue, OrgMutationLock), identity (index: decorator), core (gồm core/contracts)
audit    → identity (index: PlatformAccessAudit của 3D, để cài)
entitlements (SP4), chỉ entry integrations/files.ts → files (index: FileStorageLimit, để cài adapter; per R-X8, R-X13)
identity, tenancy, notifications → KHÔNG import files/audit/integrations/admin
```

**`MODULE_REQUIRES` của SP6** (hằng của SP7 §6.2, per R-X16; mỗi plan thêm dòng của module nó tạo): `files → tenancy` (6A), `integrations → tenancy` (6C), `audit → identity, tenancy` (6B), `admin → audit, identity, tenancy` (6D). Admin **không** có dòng tới `files` hay `integrations`: hai trường đó là tuỳ chọn (dưới).

- Audit **không** import files, integrations hay billing. Nó nhận event qua bộ chọn `audit` của core (mục 5.3, hàng `core/events`), nên dự án bỏ module nào thì audit vẫn chạy (spec cha §1.1 coi "bỏ module" là một cách tuỳ biến).
- Identity cần gọi phê duyệt của admin. Identity khai báo và export port `AdminActionApprovals`; admin cài nó bằng module `@Global()` chỉ có trong process api, theo mẫu `@Global()` + `@Optional()` của SP3 §5.2 (`UserDeletionGuard`, `PlatformRoleChangeListener`).
- Decorator `@PlatformStaffAction()` (3D, per R-X2) ghi audit truy cập qua port `PlatformAccessAudit` của identity; khi chưa có bản cài, guard dùng `NoopPlatformAccessAudit` (addendum 3D §A3). Audit (6B) cài port đó bằng module `@Global()` chỉ có trong process api, cùng mẫu. Chữ ký chốt ở addendum 3D §A3: `record(entry: PlatformAccessEntry): Promise<void>`, `PlatformAccessEntry = { method, routeTemplate, params, actor, credentialKind }`; `params` là mọi path param của template (không query, không body).
- **Admin đọc dung lượng lưu trữ và số endpoint qua token ở `core/contracts`** (r2, per R-X16, S6-A52): `src/core/contracts/admin-readers.ts` (6.0) khai `abstract class FileUsageReader { abstract storageUsedBytes(): Promise<number> }` và `abstract class WebhookStatsReader { abstract endpointCount(): Promise<number> }`, cả hai chạy trong `OrgScope` của caller. Files (6A) và integrations (6C) cài token bằng module `@Global()` của mình trong `forApi()`; admin inject `@Optional()` và không import `index.ts` của hai module đó. Tắt `files` (hoặc `integrations`) thì module không được import, token không có provider, trường tương ứng của `AdminOrg` là `null`, và bước 4 của `composeAppModules` (SP7) không báo gì vì không ai import module bị tắt. r1 dùng token ở `index.ts` của từng module: `disable: ['files']` khi admin bật làm composition ném "`files` is disabled but was imported" (review X2-4).

### 5.3 Thay đổi ở `core/` và các module đã có

Mỗi dòng có test riêng. Cột "Plan" chỉ plan mang thay đổi.

| Chỗ sửa | Thay đổi | Lý do | Plan |
|---|---|---|---|
| `core/events/event-definition.ts` | `defineEvent({ type, version, schema, audit: boolean, webhook: boolean })`: hai cờ **bắt buộc**, không có mặc định (per R-X3), lưu trên `EventDef`. Thiếu cờ là lỗi compile; giá trị không phải boolean (gọi từ JS, `as any`) → ném lúc import | Audit và webhook cần biết event nào thuộc hợp đồng của mình mà không import module phát event (§5.2). Cờ bắt buộc làm mọi event phải chọn tường minh; mặc định `false` từng làm event của SP4/SP5/SP7 rơi khỏi audit mà không ai biết. `webhook: true` là cam kết hợp đồng công khai (mục 8.3) | 6.0 |
| Mọi lời gọi `defineEvent` đang có trên `main` lúc 6.0 merge | Thêm hai cờ với **giá trị cuối cùng**: `identity.user.registered` (`audit: true, webhook: false`); `notifications.delivery.failed` (`audit: false, webhook: false`: sự kiện vận hành, không phải thao tác của người, đã có metric); mọi `tenancy.*` của 3A/3B (`audit: true`), trong đó sáu event ở §8.3 có `webhook: true`, còn lại `false`; event fixture trong `test/` (6 file). SP nào merge sau 6.0 tự khai cờ theo spec của mình (compile bắt) | Đặt giá trị cuối ngay ở 6.0 để 6B và 6C không phải sửa `tenancy/events.ts` (bớt một điểm xung đột merge). Cờ `webhook: true` chỉ có hiệu lực khi 6C có subscriber và catalog; trước đó nó không làm gì | 6.0 |
| `core/events/subscriber.decorator.ts`, `event-dispatch.handlers.ts` | Subscriber có thể khai bằng bộ chọn thay vì một event cụ thể. Chi tiết: bảng ngay dưới | Hiện mỗi subscriber là một class cho đúng một `type@version` (`subscriber.decorator.ts`). Audit sẽ cần hơn 40 class rỗng, và mỗi event mới phải nhớ thêm một class | 6.0 |
| `core/sweep/*` (mới) | `defineOrgSweep` + `OrgSweepRunner`: một cơ chế quét xuyên org dùng chung (per R-X4). Hợp đồng chốt theo R-X14: nhận tên hàm SQL chữ ký cố định `(p_after uuid, p_limit integer, …)` cộng tham số thêm **theo tên**; không nhận callback TS. Chi tiết: bảng ngay dưới | Bốn SP có cùng vòng lặp "cron → hàm definer keyset → enqueue job theo org"; review đếm được bốn bản sao với hai kiểu chống trùng `jobId` | 6.0 |
| `core/http/route-template.ts` (chuyển từ `tenancy/http/org-route.ts`), `core/sweep/constants.ts` | `routeTemplateOf` (không đổi hành vi), `DEFINER_LIMIT_MAX = 1000`, `PURGE_CURSOR_START` (UUID nil). Tenancy import lại từ core; `tenancy/index.ts` giữ re-export để code đã viết theo SP3 không vỡ | Identity (guard `@PlatformStaffAction()` ở 3D, addendum 3D §A3; inventory route admin ở 6B) và core (runner) cần chúng, mà không được import tenancy | 6.0 |
| `core/partitions/*` (mới) | Registry `definePartitionedTable({ tables, maintainFunction, lockKey, retentionMonths: () => number, premakeMonths: () => number })` (một mục cho mỗi hàm bảo trì; một hàm có thể lo nhiều bảng, §6.7) và cron `core.partitions.maintain`. Chi tiết: bảng ngay dưới | Spec cha §4: bảng lớn partition theo tháng, hết hạn thì drop. Một cron chung cho mọi bảng (hai bảng audit, hai bảng webhook) | 6.0 |
| `core/http/body-parser-policy.ts`, `json-body-parser.ts`, `content-type.middleware.ts`, `http-bootstrap.ts` | Token đơn chủ `HTTP_BODY_PARSER_SKIP_PREFIX` được thay bằng marker Discovery `@BodyParserOwner({ owner, prefix, contentTypes })` đặt trên một provider singleton. Chi tiết: bảng ngay dưới | Upload qua API cần một prefix thứ hai tự đọc body `application/octet-stream`. Comment ở `body-parser-policy.ts` đã nói: cần nhiều prefix thì đổi hợp đồng trước | 6.0 |
| `core/contracts/admin-readers.ts` (mới) | `abstract class FileUsageReader { abstract storageUsedBytes(): Promise<number> }`, `abstract class WebhookStatsReader { abstract endpointCount(): Promise<number> }`; không import gì ngoài kiểu TS; không provider nào ở core | Per R-X16: admin tới được hai số liệu mà không import `index.ts` của files/integrations, nên tắt từng module vẫn đúng (§5.2, S6-A52). Đặt ở 6.0 để 6A và 6C (song song W3) không cùng tạo file | 6.0 |
| `core/flags/*` (mới) + migration `core/…_kill_switches` | Bảng `kill_switches` (§6.2), registry `defineKillSwitch`, service `KillSwitches` và provider OpenFeature đọc từ DB. Chi tiết: bảng ngay dưới | Spec cha §13.1: kill switch lưu trong DB, đọc qua OpenFeature, bọc trong module riêng; SP1 đã giao việc này cho SP6. Đặt ở core vì mọi module đều cần đọc | 6.0 |
| `core/resilience` | **Không đổi code.** Integrations gọi `ResiliencePolicies.setProviderDefaults('webhooks-out', { retries: 0, timeoutMs: INTEGRATIONS_WEBHOOK_TIMEOUT_MS, breakerThreshold: WEBHOOK_BREAKER_NEVER, bulkheadLimit, bulkheadQueue })`, với `WEBHOOK_BREAKER_NEVER = Number.MAX_SAFE_INTEGER` | Breaker theo provider sẽ gộp endpoint của mọi khách, nên một khách lỗi làm mở breaker cho tất cả. Sức khoẻ theo endpoint nằm ở DB (§7.3). Retry do lịch của delivery đảm nhận, không do `HttpClient` (POST vốn không được retry) | 6C |
| `core/logging/redaction.ts` | Thêm `secretAccessKey`, `accessKeyId`, `sessionToken`, `webhookSecret`, `secretEnc` vào danh sách redact gốc | Secret của S3 và webhook có thể lọt vào object lỗi của SDK | 6A (S3), 6C (webhook) |
| `docker/postgres/init/01-roles.sh` | Tạo `partition_owner`, `sweep_definer` (mục 3.2). Cùng với role `billing_ledger_writer` của SP5 plan 5A, đây là các lần sửa `01-roles.sh` của SP4…SP7: runbook deploy ghi "chạy lại `01-roles.sh`" cho 3A, 6.0 và 5A | Mục 3.2 | 6.0 |
| `test/integration/core/database/rls-catalog.spec.ts` | Năm thay đổi (a)–(e), chi tiết ở bảng dưới | Tiêu chí 1 | 6.0 (a, b, e); plan có bảng (c, d) |
| `modules/identity/infra/better-auth/better-auth-api.module.ts` | Provider gắn marker `@BodyParserOwner` thay cho token `HTTP_BODY_PARSER_SKIP_PREFIX` | Xem hàng `core/http` | 6.0 |
| `modules/identity/events.ts` | Bốn event mới, tất cả `audit: true, webhook: false` và `orgId = null`: `identity.auth_action.attempted@1`, `identity.auth_action.completed@1`, `identity.session.created@1`, `identity.security_notice.recorded@1` (cờ của `UserRegisteredEvent` đã đặt ở 6.0) | L2, L3, L12 | 6B |
| `modules/identity/infra/better-auth/auth-hooks.ts` | Ghi cặp audit `attempted`/`completed` quanh mọi path thuộc `AUDITED_AUTH_PATHS` (§8.2). Chi tiết: bảng dưới | L2, L5, L12 | 6B |
| `modules/identity/infra/better-auth/auth-options.ts` | `databaseHooks.session.create.after` → `input.onSessionCreated(session)` → `SessionAuditService.publish`. Hàm này không ném: lỗi thì log và tăng metric (S6-A31) | L12 | 6B |
| `modules/identity/application/security-notice.service.ts` | `deliver(notice)` phát `identity.security_notice.recorded` (id `v5('identity.security_notice.recorded:' + notice.id)`, `ifAbsent`) trong `uow.run`, **trước** khi yêu cầu thư và trước `markNotified`/`abandon`. Lỗi thì ném cho cron retry, marker vẫn chờ | L3 | 6B |
| `modules/identity/ports/security-notice-ledger.ts` | `PendingSecurityNotice` thêm `ticket: string \| null` (cột SP3 3D đã thêm) | Payload audit mang ticket | 6B |
| `modules/identity/http/platform-staff-route-inventory.ts` (mới) | Kiểm lúc boot (`onApplicationBootstrap`, chỉ process api), duyệt mọi handler bằng `DiscoveryService` + `Reflector` + `routeTemplateOf` như `OrgRouteInventory` của SP3 §7.1. Metadata đọc bằng `hasPlatformStaffAction(controller, handler)` export từ identity (addendum 3D §A2). App **không khởi động** khi: (a) template khớp `^v1/admin(/\|$)` mà handler thiếu metadata của `@PlatformStaffAction()`; (b) handler có metadata đó mà template không khớp `^v1/admin(/\|$)`; (c) có ít nhất một route admin mà port `PlatformAccessAudit` không có bản cài thật (không có provider, hoặc provider `instanceof NoopPlatformAccessAudit`, addendum 3D §A3); (d) (6D thêm) handler có `@RequiresApproval()` (đọc bằng `requiresApprovalOf`) mà thiếu `@PlatformStaffAction()`. Chi tiết §8.4 | Per R-X2: guard và audit của mọi route admin (SP4, SP5, SP6, feature) nằm ở một decorator; kiểm lúc boot bắt route quên decorator, thay vì tin vào review | 6B |
| `modules/audit` (cài port của identity) | `PlatformAccessAuditAdapter extends PlatformAccessAudit` (addendum 3D §A3) trong `AuditIdentityPortsModule` (`@Global()`, chỉ `forApi()`). Ghi event `audit.staff_access.recorded` **trước** handler, trong `UnitOfWork` riêng, commit rồi mới trả; lỗi → ném, guard trả `503` | Thay `NoopPlatformAccessAudit` của 3D (per R-X2) | 6B |
| `modules/identity` (port mới, export) | `abstract class AdminActionApprovals { consume(input: { approvalId, requestedBy, method, path, spec }): Promise<ApprovalConsumeResult> }`, `@Global()` + `@Optional()`. Decorator `@RequiresApproval()` (export) + `ApprovalGuard` cho route Nest; hàm đọc `requiresApprovalOf(controller, handler): boolean` (export, cho inventory luật (d) và cho test của module chủ route); bước phê duyệt trong `hooks.before` cho `/admin/*`. `ADMIN_DUAL_CONTROL=on` mà không có provider → không khởi động | L4; một cơ chế cho cả Better Auth lẫn route Nest (S6-A41). SP6 cung cấp, module chủ route gắn (per R-X15) | 6D |
| `modules/identity/errors.ts` | `ADMIN_APPROVAL_REQUIRED` (403, `admin_approval_required`), `ADMIN_APPROVAL_INVALID` (403, `admin_approval_invalid`) | Hook và `ApprovalGuard` của identity trả hai mã này; identity không import admin (SP3 INT-I7) | 6D |
| `modules/tenancy` (mới, export) | `TenancyUserIds.publicIdsBySubjects(subjects: readonly string[]): Promise<ReadonlyMap<string, string>>`: đọc `tenancy_users` (bảng global) theo `auth_user_id` hoặc `external_subject` tuỳ mode, tối đa `AUTH_DIRECTORY_BATCH_MAX` subject mỗi lần | Audit nối `actor.id` với `userId` của tenancy (SP3 §14) | 6B |
| `modules/tenancy` (mới, export) | `OrgMutationLock.lock(): Promise<boolean>`: `SELECT 1 FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE` trong transaction của caller (cùng câu SP3 §8.6 bước 1); `false` khi dòng org không còn | 6A (quota dung lượng) và 6C (giới hạn endpoint) cùng cần; đặt ở 6.0 để hai plan song song không cùng sửa `tenancy/index.ts` | 6.0 |
| `modules/tenancy` (mới, export) + migration `tenancy/…_admin_directory` | `PlatformOrgDirectory` gồm `list`, `get`, `members`, `orgsOfUser` (§9.4); hai hàm definer `tenancy_admin_list_orgs`, `tenancy_admin_count_orgs` (§6.8); index `organizations_name_prefix_idx` | Admin không đọc thẳng bảng của tenancy (spec cha §2, context map) | 6D |
| `modules/notifications` | Không đổi | — | — |
| `modules/{files,audit,integrations,admin}/index.ts`, `src/boilerplate.modules.ts` | Nghĩa vụ của SP7 (per R-X16): dòng đầu mỗi `index.ts` gọi `markModuleLoaded('<m>')` của `core/config`; mỗi plan thêm mục của module mình vào `BOILERPLATE_MODULES` và dòng của mình vào `MODULE_REQUIRES` (§5.2) | Tắt module thật sự tắt nó, và import nhầm module bị tắt làm boot fail có tên (SP7 §6.2 bước 4) | 6A, 6B, 6C, 6D (mỗi plan một module) |
| `modules/files/files.config.ts` | `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` mang `.meta({ secret: { roles: ['api', 'worker'] } })` (per R-X16); chạy `pnpm chart:secrets` khi SP7 7B đã merge (7B ở W3, cùng sóng với 6A: plan merge sau trong cặp chạy lệnh và commit file sinh ra) | Allowlist secret của chart và tên cấm trong ConfigMap sinh từ metadata này (SP7 S7-D33); danh sách redact của log không phải nguồn của chart | 6A |
| `modules/files` (kiểm lúc boot của port) | `FileStorageLimitCheck` (`onApplicationBootstrap`, api và worker): `loadedModules().has('entitlements')` và không có provider `FileStorageLimit` → log ERROR `file_storage_limit_adapter_missing`, ném | Per R-X13: port `@Optional()` + mặc định config làm việc thiếu adapter thành im lặng (X2-1). Code do **4B** thêm (plan merge sau trong cặp 6A/4B theo R-X7), cùng PR với adapter, vì từ lúc 6A merge (W3) tới 4B (W4) chưa có adapter nào | 4B (sửa code 6A) |

**Chi tiết thay đổi ở `core/events`** (plan 6.0):
- `SubscriberMeta = { consumer; event: EventDef } | { consumer; events: EventSelector }`, với `EventSelector = { name: 'audit' | 'webhook'; matches(def): boolean }`. Core export hai hằng `AUDITED_EVENTS` và `WEBHOOK_EVENTS`.
- `SubscriberRegistry.onModuleInit` duyệt `eventRegistry()` và đăng ký subscriber bộ chọn cho mọi def khớp. Mọi `defineEvent` chạy lúc import, tức trước `onModuleInit`; test C-2 khẳng định thứ tự này.
- `DeliverEventHandler` lấy def bằng `findEvent(row.type, row.version)`, rồi kiểm def có thuộc tập của subscriber không (thay cho so với một def duy nhất).
- Handler của subscriber bộ chọn nhận `EventEnvelope<unknown>`, đã parse theo schema của đúng def.
- `defineEvent` kiểm `typeof audit === 'boolean' && typeof webhook === 'boolean'`, sai thì ném (lớp thứ hai sau compiler).

**Chi tiết `core/sweep`** (plan 6.0, per R-X4; SP4, SP5, SP7 dùng lại, SP3 chuyển sang ở lần dọn sau):
- **Hợp đồng (r2, per R-X14, chữ ký của SP6 là chuẩn):**

  ```ts
  defineOrgSweep({
    key,                    // khoá cron + tên job quét, vd 'files.sweep-orgs'
    definerFunction,        // tên hàm SQL trong schema public, chữ ký cố định (p_after uuid, p_limit integer, <tham số thêm>)
    extraParams?: () => Readonly<Record<string, number | boolean | string>>,  // tham số thêm, THEO TÊN, đọc mỗi lượt
    orgJob, jobIdPrefix,
    schedule: () => ({ cron, tz }),
    batch: () => ({ size, maxBatches }),
  })
  ```

  Không có dạng callback TS `(after, limit) => …`: runner là nơi duy nhất gọi hàm definer, luôn trên pool `app_user`, nên luật "hàm quét xuyên org chỉ chạy qua `EXECUTE` của `app_user`" nằm ở một chỗ.
- `defineOrgSweep` là registry lúc import. Nó tự `defineJob` job quét (tên = `key`, queue `maintenance`, payload `{}`) và `defineCron` (key = `key`), nên mọi cron quét nằm ở `maintenance` (nhóm worker `scheduler` của SP7 nhận), còn việc theo org nằm ở queue của module (`orgJob.queue`).
- Kiểm lúc định nghĩa: `definerFunction` khớp `^[a-z][a-z0-9_]*$`; `jobIdPrefix` khớp `^[a-z][a-z0-9-]*$`; `size` trong `[1, DEFINER_LIMIT_MAX]`. Kiểm mỗi lượt, trước câu SQL: mỗi tên trong `extraParams()` khớp `^p_[a-z][a-z0-9_]*$` và khác `p_after`, `p_limit`; mỗi giá trị `number` là `Number.isSafeInteger`; sai → job quét ném lỗi có tên `OrgSweepDefinitionError` (fail loud, không enqueue gì).
- **Câu SQL của runner** dùng ký hiệu tham số theo tên của Postgres và ép kiểu tường minh theo kiểu JS của giá trị, nên không dựa vào ép kiểu ngầm của literal không kiểu:

  ```sql
  SELECT org_id FROM public.<definerFunction>(p_after => $1::uuid, p_limit => $2::integer, p_x => $3::integer, p_flag => $4::boolean, …)
  ```

  `number` → `::integer`, `boolean` → `::boolean`, `string` → `::text`. Tham số kiểu khác (`interval`, `timestamptz`) truyền dưới dạng số nguyên giây và hàm tự dựng giá trị (`make_interval(secs => p_x_sec)`), như mẫu của SP7 (`p_retention_sec`) và `integrations_orgs_due` (`p_grace_sec`). Mỗi tên hàm có **đúng một** overload trong schema `public` (C-8b kiểm), nên Postgres chọn hàm không mơ hồ.
- `OrgSweepRunner.run(def)`: module khai một handler mỏng `@JobHandler(def.job) class … { handle() { return this.runner.run(def) } }` (core giữ luật "một handler một job" của `WorkerHost`). Runner lặp tối đa `maxBatches` lô trên pool `app_user` (ngoài OrgScope; `app_user` chỉ có `EXECUTE`), con trỏ bắt đầu từ `PURGE_CURSOR_START`, lô sau bắt đầu từ org id cuối của lô trước; dừng khi lô ngắn hơn `size`. Lô cuối vẫn đầy ở lần thứ `maxBatches` → WARN `{ event: 'org_sweep_backlog', key }` + `org_sweep_backlog_total{key}`.
- **Chống trùng `jobId` duy nhất: theo slot.** `jobId = <jobIdPrefix>-<orgId>-<slot>`, `slot = floor(epochSec / slotSec)`, `slotSec = minGapSec(cron, tz)` (hàm có sẵn ở `schedule-validation.ts:180`), tính một lần lúc boot. Enqueue bằng `JobQueue` (không trong transaction), `meta.orgId = orgId`. Hệ quả: hai lượt cron hay một lần retry của job quét trong cùng slot không tạo job trùng; một job theo org bị `failed` chỉ chặn org đó tới slot sau, không tới khi BullMQ dọn job failed (`QUEUE_KEEP_FAILED_AGE_SEC`, 7 ngày), khác kiểu `jobId` cố định của SP3 §9.5. Job theo org phải idempotent (mọi job quét của SP6 claim bằng `FOR UPDATE SKIP LOCKED`).
- Redis lỗi giữa chừng → runner ném, BullMQ retry job quét; job theo org đã enqueue trong slot đó bị bỏ qua nhờ `jobId`.
- Metric `org_sweep_orgs_enqueued_total{key}`, `org_sweep_duration_seconds{key}`.

**Chi tiết `core/partitions`** (plan 6.0):
- `definePartitionedTable` là registry lúc import. Tên bảng và tên hàm được kiểm bằng regex; `lockKey` là `bigint` duy nhất trong registry.
- Cron `core.partitions.maintain` (`PARTITIONS_MAINTAIN_CRON`/`_TZ`, queue `maintenance`) chạy `SELECT action, partition_name FROM public.<fn>($1, $2)` cho từng mục của registry, mỗi mục trong một `UnitOfWork` riêng. Một mục lỗi không chặn mục khác (log ERROR, job ném ở cuối để BullMQ retry).
- Gauge `db_partition_months_ahead{table}` đọc `pg_inherits` (catalog, `app_user` đọc được).

**Chi tiết `core/http`** (plan 6.0):
- `BodyParserPolicy.rules()` quét provider có marker `@BodyParserOwner` một lần, lúc `applyHttpDefaults`. `DiscoveryService` dùng được ở thời điểm này vì container đã dựng xong trong `NestFactory.create`.
- Hai prefix trùng nhau hoặc lồng nhau → ném lúc boot.
- `jsonBodyParser` bỏ qua mọi prefix đã đăng ký.
- `ContentTypeMiddleware` dùng `contentTypes` của prefix khớp, thay cho allowlist chung.
- Identity chuyển sang marker với `owner: 'identity'`, `prefix: AUTH_BASE_PATH`, `contentTypes: httpConfig().allowedContentTypes`. Hành vi không đổi.

**Chi tiết `core/flags`** (plan 6.0):
- `defineKillSwitch({ key, description })` là registry lúc import.
- `KillSwitches.isKilled(key): Promise<boolean>` trả `client.getBooleanValue(key, false)` của OpenFeature. Key không có trong registry → ném.
- `KillSwitches.set(key, killed, reason, actor, expectedVersion)` ghi DB trong transaction của caller.
- `DbKillSwitchProvider` (một `Provider` của OpenFeature) giữ snapshot trong bộ nhớ và làm mới mỗi `FLAGS_REFRESH_INTERVAL_MS`. Không có dòng cho một key → `false`.
- DB lỗi khi làm mới → giữ snapshot cũ (fail-static) và tăng metric `flags_refresh_failures_total`.
- `onClose` dừng timer.

**Chi tiết `auth-hooks.ts`** (plan 6B):
1. **`before`:** chạy **sau mọi gate và luật** của SP3 §5.2 (1)–(8), và sau bước phê duyệt của 6D. Với path thuộc `AUDITED_AUTH_PATHS` (§8.2), gọi `AuthActionAudit.attempted(...)`. Hàm này ghi outbox trong một `UnitOfWork` riêng trên pool `app_user`. Lỗi → `503 service_unavailable`, handler không chạy. `attemptId` được lưu vào request state (`AuthRequestState.setAuthAttempt`).
2. **`after`:** với cùng path, gọi `completed` với `outcome` và `status` đọc từ `ctx.context.returned`. Lỗi → log ERROR và tăng metric; response giữ nguyên.

**Chi tiết `rls-catalog.spec.ts`:**
- (a) Bảng partitioned (`relkind = 'p'`) có cột `org_id`: bảng cha phải có RLS + FORCE + policy `TO app_user`.
- (b) Partition (`relispartition`): bỏ qua luật RLS; khẳng định owner là `partition_owner` và không có grant nào cho `app_user`, `app_relay`, `auth_user`.
- (c) `GLOBAL_TABLES` thêm `kill_switches`, `file_purposes`, `webhook_event_types`, `platform_audit_logs`, `admin_approvals`, mỗi bảng kèm lý do.
- (d) Hằng `DEFINER_FUNCTIONS_6A`, `DEFINER_FUNCTIONS_6C`, `DEFINER_FUNCTIONS_6D` so theo tập tên (như SP3 INT3-3).
- (e) Ma trận role thêm `partition_owner`, `sweep_definer`.

### 5.4 Luật kiến trúc (thêm vào dependency-cruiser; số tiếp theo SP3 §18.6)

20. `@aws-sdk/*`, `file-type`, `clamscan` (và `sharp` nếu dự án thêm adapter) chỉ được import trong `src/modules/files/infra/**`.
21. `standardwebhooks` chỉ được import trong `src/modules/integrations/infra/**`.
22. `@openfeature/*` chỉ được import trong `src/core/flags/**`.
23. `modules/{identity,tenancy,notifications}/**` không import `modules/{files,audit,integrations,admin}/**`.
24. `modules/audit/**` không import `modules/{files,integrations,admin}/**`.
25. `features/**` chỉ dùng files, audit, integrations qua `index.ts`.
26. (r2, per R-X16) `modules/admin/**` không import `modules/{files,integrations}/**`; hai số liệu tuỳ chọn đi qua `src/core/contracts/**`.
27. (r2) `src/core/contracts/**` chỉ chứa kiểu và `abstract class`, không import `modules/**` hay `features/**` (luật "core không import module" hiện có phủ; fixture riêng cho thư mục này).

Mỗi luật có fixture phải fail.

---

## 6. Mô hình dữ liệu

### 6.1 Quy ước (bổ sung SP3 §6.1)

**Bảng tenant theo đúng SP3 §6.1:**
- `org_id UUID NOT NULL`;
- FK kép `(org_id, x_id)`;
- `ENABLE` + `FORCE ROW LEVEL SECURITY`;
- policy `<bảng>_tenant TO app_user USING/WITH CHECK (org_id = app_current_org())`;
- có `created_at`/`updated_at`, và `version` nếu là aggregate sửa được;
- không grant `UPDATE` trên `org_id`, `id`, `public_id`, `created_at` hay cột snapshot.

**Neo org** (amendment B5 của SP3):
- `files`, `webhook_endpoints`, `webhook_messages` có FK `org_id → organizations(id) ON DELETE RESTRICT`;
- bảng con của chúng được neo bắc cầu qua FK kép;
- **ngoại lệ có tên:** `audit_logs` **không** có FK tới `organizations`. Lịch sử phải sống lâu hơn org: xoá cứng org không được xoá audit (S6-A22). Giống ngoại lệ `outbox_events` của SP3 §6.1.

**Bảng partitioned** (theo `RANGE` tháng, owner `partition_owner`):
- PK gồm cột partition;
- policy, grant và index khai trên **bảng cha**;
- partition không có grant nào;
- trigger dòng khai trên cha được PG tự nhân bản sang partition (spike P1);
- tên partition là `<bảng>_pYYYYMM`.

**Public id sinh ở app** (UUID v7 của core) cho:
- `files`, vì object key cần id trước `INSERT`;
- hai bảng partitioned của webhook, vì jobId cần id.

Các bảng khác dùng `DEFAULT uuidv7()`.

**Enum:**
- tập đóng: `TEXT` + `CHECK`;
- tập mở do code khai báo (purpose, event type): **bảng tra cứu + FK**, đồng bộ bằng migration và kiểm lúc boot (mẫu `email_templates` và catalogue của SP3).

### 6.2 `kill_switches` (core, global, plan 6.0)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `key` | `TEXT` | PK; `CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length(key) <= 100)` |
| `killed` | `BOOLEAN NOT NULL` | |
| `reason` | `TEXT NULL` | `CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)`; `CHECK (NOT killed OR reason IS NOT NULL)` |
| `changed_by` | `TEXT NOT NULL` | `CHECK (char_length(changed_by) BETWEEN 1 AND 255)`: `principal.id` của người đổi gần nhất (snapshot) |
| `version`, `created_at`, `updated_at` | | `version INT NOT NULL DEFAULT 1 CHECK (version >= 1)` |

- Không RLS vì không có dữ liệu tenant. Bảng thuộc `GLOBAL_TABLES`.
- Grant `app_user`: `SELECT, INSERT, UPDATE (killed, reason, changed_by, version, updated_at)`. Chỉ admin (process api) ghi, qua `KillSwitches.set`.
- Dòng có `key` không nằm trong registry (switch đã bị bỏ khỏi code) bị provider bỏ qua, log WARN một lần.
- Không có index ngoài PK: provider đọc cả bảng (vài chục dòng).

### 6.3 Files (plan 6A)

#### `file_purposes` (global, bảng tra cứu)

- Cột: `key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')`, `created_at`, `updated_at`.
- Segment đầu của key là tên module, và đi vào object key.
- Migration của module sở hữu purpose chèn dòng: files chèn `files.attachment`; `features/` chèn purpose của mình trong `src/migrations/app/`.
- `FilePurposeCheck` chạy lúc boot ở cả api và worker, so tập key của `defineFilePurpose` với bảng. Lệch → không khởi động (mẫu `CatalogueCheck` của SP3 §8.8).
- Grant `app_user`: `SELECT`.

#### Định nghĩa purpose (code, `domain/file-purpose.ts`)

Ví dụ cho purpose có sẵn:

```ts
defineFilePurpose({
  key: 'files.attachment',
  visibility: 'PRIVATE',                 // 'PRIVATE' | 'PUBLIC'
  maxBytes: () => filesConfig().attachmentMaxBytes,
  allowedTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
                 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  textTypes: ['text/plain', 'text/csv'], // không có magic bytes: kiểm UTF-8 và không có byte NUL (§8.1 bước P3)
  imagePolicy: 'SANITIZE',               // 'SANITIZE' (bỏ metadata + tạo thumbnail) | 'NONE'
  clientUploadable: true,                // false: chỉ upload qua FileStore từ code của feature
});
```

Kiểm lúc định nghĩa:
- `image/svg+xml`, `text/html`, `application/xhtml+xml`, `application/xml`, `text/xml`, `application/javascript` không bao giờ được nằm trong `allowedTypes` hay `textTypes` (ném);
- `maxBytes()` ≤ `FILES_MULTIPART_MAX_BYTES`;
- purpose `PUBLIC` đòi `FILES_PUBLIC_BASE_URL` (luật config).

#### `files` (tenant)

| Cột | Kiểu | Ràng buộc / ghi chú |
|---|---|---|
| `id` | `BIGINT` identity | PK |
| `public_id` | `UUID NOT NULL` | Sinh ở app (v7); `UNIQUE (org_id, public_id)`; `CHECK (uuid_extract_version(public_id) = 7)` |
| `org_id` | `UUID NOT NULL` | `files_org_fk REFERENCES organizations(id) ON DELETE RESTRICT` |
| `purpose` | `TEXT NOT NULL` | `files_purpose_fk REFERENCES file_purposes(key) ON DELETE RESTRICT` |
| `visibility` | `TEXT NOT NULL` | `CHECK IN ('PRIVATE','PUBLIC')`. **Snapshot** của purpose lúc tạo: quyết định chỗ object nằm, nên không được đổi theo code (S6-A6) |
| `object_key` | `TEXT NOT NULL` | `UNIQUE`; `CHECK (object_key ~ '^[0-9a-f-]{36}/[a-z][a-z0-9_]*/[0-9a-f-]{36}$')`; `CHECK (split_part(object_key, '/', 1) = org_id::text AND split_part(object_key, '/', 3) = public_id::text)`. **Snapshot** `{orgId}/{module}/{publicId}`: đổi tên purpose trong code không làm mồ côi object (S6-A6) |
| `original_name` | `TEXT NOT NULL` | `CHECK (original_name = btrim(original_name) AND char_length(original_name) BETWEEN 1 AND 255 AND original_name IS NFC NORMALIZED AND original_name !~ '[\x00-\x1f\x7f/\\]')` |
| `declared_type` | `TEXT NOT NULL` | `CHECK (declared_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$')` (media type chữ thường, không tham số) |
| `detected_type` | `TEXT NULL` | cùng regex; có từ bước P2 (§8.1) |
| `size_bytes` | `BIGINT NOT NULL` | `CHECK (size_bytes > 0)`. Khai báo lúc tạo và được kiểm đúng lúc upload. Không có grant `UPDATE` |
| `sha256` | `BYTEA NULL` | `CHECK (octet_length(sha256) = 32)`; băm của object gốc, tính lúc xử lý |
| `upload_mode` | `TEXT NOT NULL` | `CHECK IN ('DIRECT_POST','MULTIPART','API','GENERATED')` |
| `multipart_upload_id` | `TEXT NULL` | `CHECK (char_length(multipart_upload_id) BETWEEN 1 AND 1024)`; `CHECK (multipart_upload_id IS NULL OR upload_mode = 'MULTIPART')` |
| `status` | `TEXT NOT NULL` | `CHECK IN ('PENDING','PROCESSING','READY','REJECTED','EXPIRED','DELETED')` |
| `rejection_reason` | `TEXT NULL` | `CHECK IN ('TYPE_NOT_ALLOWED','SIZE_MISMATCH','OBJECT_MISSING','INFECTED','SCAN_SIZE_EXCEEDED','IMAGE_INVALID','IMAGE_TOO_LARGE','PROCESSING_FAILED')`; `CHECK ((status = 'REJECTED') = (rejection_reason IS NOT NULL))` |
| `scan_result` | `TEXT NULL` | `CHECK IN ('CLEAN','NOT_SCANNED')` |
| `clean_size_bytes` | `BIGINT NULL` | `CHECK (clean_size_bytes > 0)`; khác `NULL` nghĩa là adapter `ImageSanitizer` đã ghi `{object_key}.clean` và đó là object được phục vụ. `sanitized` của API suy ra từ cột này (r1 bỏ cột boolean `sanitized`: nó phụ thuộc hàm vào `clean_size_bytes`) |
| `thumbnail_size_bytes` | `BIGINT NULL` | `CHECK (thumbnail_size_bytes > 0)`; khác `NULL` nghĩa là có `{object_key}.thumb.webp` |
| `upload_expires_at` | `TIMESTAMPTZ NOT NULL` | Hạn của URL/token upload đã cấp; `CHECK (upload_expires_at > created_at)` |
| `processing_lease_until` | `TIMESTAMPTZ NULL` | `CHECK (processing_lease_until IS NULL OR status = 'PROCESSING')` |
| `processing_attempts` | `INT NOT NULL DEFAULT 0` | `CHECK (processing_attempts >= 0)`; là fencing token của lần xử lý |
| `ready_at` | `TIMESTAMPTZ NULL` | lần gần nhất tới `READY` |
| `published_at` | `TIMESTAMPTZ NULL` | bản sao `public/…` tồn tại từ lúc này; `CHECK (published_at IS NULL OR visibility = 'PUBLIC')` |
| `deleted_at` | `TIMESTAMPTZ NULL` | `CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))` |
| `object_removed_at` | `TIMESTAMPTZ NULL` | mọi object của file (gốc, `clean`, thumbnail, bản public) đã bị xoá; `CHECK (object_removed_at IS NULL OR (status IN ('REJECTED','EXPIRED','DELETED') AND published_at IS NULL))` |
| `next_sweep_at` | `TIMESTAMPTZ NULL` | Lúc sweep phải xem lại dòng này (§7.1). Ghi ở mỗi lần chuyển trạng thái. Đây là lời hứa lúc chuyển, không suy lại được từ config hiện tại (cùng lý do với `purge_after` ở SP3 §6.4) |
| `version`, `created_at`, `updated_at` | | |

Ràng buộc mức bảng:
- `CHECK (status <> 'READY' OR (detected_type IS NOT NULL AND scan_result IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL))`;
- `CHECK (status <> 'READY' OR visibility = 'PRIVATE' OR published_at IS NOT NULL)`;
- `CHECK (status <> 'PENDING' OR (detected_type IS NULL AND sha256 IS NULL))`;
- `CHECK (upload_mode <> 'GENERATED' OR status <> 'PROCESSING')` (file do worker tạo đi `PENDING → READY`, không qua pipeline, §8.1);
- `UNIQUE (org_id, id)`.

**Object của một file.** Key suy ra từ `object_key` và các cờ, không lưu:
- vùng nhận: `{object_key}.upload`. Đây là key **duy nhất** mà URL presign, multipart và token upload ghi vào. Không bao giờ được quét hay phục vụ, và bị xoá ngay sau khi server đã sao sang key gốc (bước P1, §8.1). Client cầm URL còn hạn vẫn ghi đè được vùng nhận sau khi file đã `READY`, nhưng không ghi được thứ đang được phục vụ (R6-27);
- gốc: `{object_key}`. Chỉ server ghi, bằng `CopyObject` có `CopySourceIfMatch` từ vùng nhận, hoặc do worker ghi thẳng khi file do worker tạo;
- bản đã làm sạch: `{object_key}.clean`, khi `clean_size_bytes` khác `NULL`;
- thumbnail: `{object_key}.thumb.webp`, khi `thumbnail_size_bytes` khác `NULL`;
- bản public: `public/{object_key}` và `public/{object_key}.thumb.webp`, khi `published_at` khác `NULL`. Bản public là bản sao của object được phục vụ: `.clean` nếu có, không thì bản gốc.

`.clean` và thumbnail chỉ được ghi bằng `PutObject` có `IfNoneMatch: '*'` (spike F3): lần ghi đầu thắng; lần ghi sau (attempt khác, worker bị treo tỉnh lại) nhận `412`, rồi đọc `HeadObject` để lấy kích thước và dùng lại object đã có. Mọi bản đã có đều do adapter sinh từ đúng bản gốc đã kiểm, nên dùng lại là đúng (R6-4).

Hằng: `UPLOAD_SUFFIX = '.upload'`, `CLEAN_SUFFIX = '.clean'`, `THUMBNAIL_SUFFIX = '.thumb.webp'`, `PUBLIC_PREFIX = 'public/'`.

**Trigger:**
- `files_immutable_cols` (`BEFORE UPDATE`): chặn đổi `visibility`, `object_key`, `purpose`, `size_bytes`, `upload_mode`, `original_name` → `check_violation`. Grant theo cột đã chặn `app_user`; trigger chặn cả `app_owner` trong migration.
- r1 **bỏ** trigger `files_storage_usage_sync` và bảng `file_storage_usage` (per R-X8, mục "Quota dung lượng" dưới). Bản r0 khai một trigger `AFTER INSERT OR UPDATE OR DELETE` có transition table; Postgres từ chối dạng đó (`transition tables cannot be specified for triggers with more than one event`, review đã chạy trên PG 18.6).

**Index** (mỗi index một query):

| Index | Phục vụ |
|---|---|
| `UNIQUE (org_id, public_id)` | API và job |
| `UNIQUE (object_key)` | bất biến "key duy nhất" |
| `(org_id, created_at DESC, id DESC)` | `GET …/files` |
| `(org_id, purpose, created_at DESC, id DESC)` | lọc theo purpose |
| `files_pending_idx (org_id) WHERE status = 'PENDING'` | đếm upload đang chờ dưới khoá |
| `files_live_bytes_idx (org_id) INCLUDE (size_bytes, clean_size_bytes, thumbnail_size_bytes, published_at) WHERE object_removed_at IS NULL` | `SUM(stored_bytes)` dưới khoá org khi khởi tạo upload, và `FileUsageReader` (index-only scan khi visibility map sạch; F-32 đo) |
| `files_sweep_idx (next_sweep_at) WHERE next_sweep_at IS NOT NULL` | hàm definer quét xuyên org. Không bắt đầu bằng `org_id`, cùng ngoại lệ với SP3 §3.7 |
| `files_org_sweep_idx (org_id, next_sweep_at) WHERE next_sweep_at IS NOT NULL` | job sweep theo org |
| `(purpose)` | FK `RESTRICT` khi xoá dòng `file_purposes` |

**Grant:**
- `app_user`: `SELECT, INSERT, DELETE, UPDATE (detected_type, sha256, multipart_upload_id, status, rejection_reason, scan_result, clean_size_bytes, thumbnail_size_bytes, processing_lease_until, processing_attempts, ready_at, published_at, deleted_at, object_removed_at, next_sweep_at, version, updated_at)`.
- `sweep_definer`: `SELECT (org_id, next_sweep_at)` + policy `files_definer_read FOR SELECT TO sweep_definer USING (true)` (tên theo quy ước chung `<bảng>_definer_read`, mục 3.2).

#### Quota dung lượng: `LIMIT` của SP4, đếm dưới khoá org, không bộ đếm (r1, per R-X8)

- **Dung lượng đang dùng** của một org là `Σ stored_bytes(f)` trên các dòng `files` của org có `object_removed_at IS NULL`, với

  ```
  stored_bytes(f) = size_bytes + COALESCE(clean_size_bytes, 0) + COALESCE(thumbnail_size_bytes, 0)
                  + CASE WHEN published_at IS NOT NULL
                         THEN COALESCE(clean_size_bytes, size_bytes) + COALESCE(thumbnail_size_bytes, 0)
                         ELSE 0 END
  ```

  Tức là **mọi** biến thể đang lưu: gốc, `clean`, thumbnail, và bản sao `public/…` của object được phục vụ và thumbnail. Dòng `PENDING` được tính theo `size_bytes` khai báo: đó là phần giữ chỗ cho vùng nhận `.upload` (kích thước bị ép ở storage, tiêu chí 2).
- **Không có bảng đếm, không trigger.** Giá trị được tính lại bằng một câu `SUM` dưới khoá org ở mỗi lần kiểm (mục 8.1 bước 4), đúng mẫu `tenancy.seats` của SP4 (đếm dưới khoá, không bộ đếm). Biểu thức nằm ở một chỗ (`sql-file.repository.ts`, hằng `STORED_BYTES_SQL`) và được `FileUsageReader` dùng lại.
- **Hạn mức** đến từ port `FileStorageLimit` (mục 8.1; SP6 sở hữu, per R-X13). SP4 khai tính năng `files.storage_bytes` kiểu `LIMIT` và cài adapter ở entry riêng của nó, composition của SP7 nạp entry đó khi cả hai module bật (per R-X8, R-X13); vắng SP4 thì files dùng `FILES_ORG_STORAGE_LIMIT_BYTES`. `entitlements` bật mà không có adapter → không khởi động (§8.1 bước 4).
- **Hai phần không tính, có lý do:**
  - vùng nhận `.upload` và bản gốc cùng tồn tại trong khoảng giữa `CopyObject` và `DeleteObject` của bước P1 (vài giây): gấp đôi tạm thời, tự hết;
  - part multipart đã tải lên nhưng chưa `complete`: storage chưa có object, S3 tính tiền part cho tới khi upload bị huỷ (sweep hết hạn + lifecycle `AbortIncompleteMultipartUpload`, mục 12.3). Chặn bởi `FILES_MAX_PENDING_PER_ORG × FILES_MULTIPART_MAX_BYTES`.
- **Vượt hạn mức có giới hạn:** kích thước `clean`/thumbnail chỉ biết sau bước P5, và bản public được sao ở P6, cả hai sau lần kiểm lúc khởi tạo. Org có thể vượt hạn mức đúng bằng tổng biến thể và bản public của các file đang `PROCESSING`. Lần khởi tạo sau thấy tổng thật và từ chối. Với cấu hình mặc định (sanitizer no-op, purpose có sẵn là `PRIVATE`) phần vượt này bằng 0.
- **Chi phí của `SUM`:** một index-only scan trên `files_live_bytes_idx` theo `org_id`. F-32 đo `EXPLAIN (ANALYZE, BUFFERS)` với 100.000 file sống trong một org; số đo ghi vào plan 6A. Nếu p95 của câu đó vượt 50 ms (ngân sách đề xuất cho phần giữ khoá org của khởi tạo upload) thì dừng và báo Sếp. Phương án thay thế là một bảng đếm giữ bằng **ba** trigger mức câu lệnh, mỗi trigger một event; nó trái R-X8 nên không tự chốt.

### 6.4 Audit (plan 6B)

Hai bảng cùng dạng:
- **`audit_logs`**: tenant, `PARTITION BY RANGE (recorded_at)`, owner `partition_owner`;
- **`platform_audit_logs`**: global, như trên nhưng không có `org_id`.

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | `BIGINT GENERATED ALWAYS AS IDENTITY` | `PRIMARY KEY (recorded_at, id)` |
| `org_id` | `UUID NOT NULL` | Chỉ `audit_logs`. **Không có FK** (ngoại lệ có tên, §6.1) |
| `event_id` | `UUID NOT NULL` | id của envelope; là id công khai của dòng audit trong API |
| `action` | `TEXT NOT NULL` | `CHECK (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')` (bằng `type` của event) |
| `action_version` | `INT NOT NULL` | `CHECK (action_version > 0)` |
| `occurred_at` | `TIMESTAMPTZ NOT NULL` | `occurredAt` của envelope |
| `recorded_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Khoá partition. Là lúc ghi nên luôn rơi vào partition hiện hành đã tạo sẵn. Không dùng `occurred_at`, vì khi xử lý lại nó có thể là quá khứ xa (S6-A21) |
| `actor_type` | `TEXT NOT NULL` | `CHECK IN ('user','system','service')` (`ACTOR_TYPES` của core) |
| `actor_id` | `TEXT NOT NULL` | `CHECK (char_length(actor_id) BETWEEN 1 AND 255)` |
| `actor_user_id` | `UUID NULL` | `tenancy_users.public_id` của actor lúc ghi. Snapshot, ngoại lệ E-A1 ở §6.9. `CHECK (actor_user_id IS NULL OR actor_type = 'user')` |
| `target_type`, `target_id` | `TEXT NOT NULL` | `aggregate.type` và `aggregate.id` của envelope; `CHECK (char_length BETWEEN 1 AND 255)` |
| `correlation_id` | `TEXT NOT NULL` | `CHECK (char_length(correlation_id) BETWEEN 1 AND 255)` |
| `causation_id` | `TEXT NULL` | |
| `data` | `JSONB NOT NULL` | `data` của event: tài liệu mờ, đã validate bằng schema của đúng `type@version` lúc deliver, không query theo phần tử. `CHECK (jsonb_typeof(data) = 'object')` |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Theo quy ước "mọi bảng có". Trigger chặn `UPDATE`, nên hai cột luôn bằng nhau |

**Chỉ thêm (append-only):**
- grant `app_user`: chỉ `SELECT, INSERT`;
- trigger `audit_logs_append_only` và `platform_audit_logs_append_only` (`BEFORE UPDATE OR DELETE … FOR EACH ROW`) → `RAISE … ERRCODE = 'insufficient_privilege'` (spec cha §4, §11). Trigger chặn cả owner khi đi qua bảng cha;
- không role nào ngoài owner có `TRUNCATE`;
- dữ liệu **chỉ** bị xoá bằng cách drop partition hết hạn (§6.7).

**RLS:**
- `audit_logs`: policy `audit_logs_tenant TO app_user` (SELECT và INSERT với `WITH CHECK`).
- `platform_audit_logs`: không RLS, thuộc `GLOBAL_TABLES`, lý do "chỉ chứa sự kiện cấp nền tảng, không có `org_id`; chỉ route admin đọc".

**Chống trùng:**
- `Inbox.once('audit.recorder', eventId)` chạy trong cùng transaction với `INSERT`.
- Không có `UNIQUE (event_id)`: khoá unique của bảng partitioned phải chứa `recorded_at`, mà `recorded_at` khác nhau ở mỗi lần giao lại, nên ràng buộc đó không chặn được gì.
- Cửa sổ giao lại bị chặn bởi retention của outbox. Luật config `outbox-retention` sẵn có của core (`INBOX_RETENTION_DAYS > OUTBOX_RETENTION_DAYS + QUEUE_KEEP_FAILED_AGE_SEC`) đã bảo đảm bản ghi inbox sống lâu hơn mọi lần giao lại có thể xảy ra, nên không cần luật mới.

**Index** (khai trên bảng cha):

| Index | Phục vụ |
|---|---|
| `(org_id, recorded_at DESC, id DESC)` | danh sách mặc định + cursor |
| `(org_id, action, recorded_at DESC, id DESC)` | `?action=` |
| `(org_id, actor_id, recorded_at DESC, id DESC)` | `?actorId=` |
| `(org_id, target_type, target_id, recorded_at DESC, id DESC)` | `?targetType=&targetId=` |
| `(org_id, correlation_id)` | `?correlationId=` (L2) |

- `platform_audit_logs` có cùng bộ index, bỏ `org_id`.
- Không index `event_id`: ngoài inbox, không query nào tra theo cột này.

### 6.5 Integrations (plan 6C)

#### `webhook_event_types` (global, bảng tra cứu)

- Cột: `type TEXT PRIMARY KEY CHECK (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')`, `created_at`, `updated_at`.
- Migration chèn một dòng cho mỗi event có `webhook: true`.
- `WebhookEventCatalogueCheck` chạy lúc boot, so tập `type` của các def có `webhook: true` với bảng. Lệch → không khởi động.
- Grant `app_user`: `SELECT`.

#### `webhook_endpoints` (tenant)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id`, `public_id` (`DEFAULT uuidv7()`), `org_id` | | `UNIQUE (org_id, public_id)`, `UNIQUE (org_id, id)`; `webhook_endpoints_org_fk REFERENCES organizations(id) ON DELETE RESTRICT` |
| `url` | `TEXT NOT NULL` | `CHECK (char_length(url) BETWEEN 10 AND 2048 AND url ~ '^https?://')`; kiểm đầy đủ ở app (§8.3) |
| `description` | `TEXT NULL` | `CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 500)` |
| `status` | `TEXT NOT NULL` | `CHECK IN ('ACTIVE','DISABLED')` |
| `disabled_reason` | `TEXT NULL` | `CHECK IN ('MANUAL','AUTO_FAILING')`; `CHECK ((status = 'DISABLED') = (disabled_reason IS NOT NULL))` |
| `failing_since` | `TIMESTAMPTZ NULL` | lần thất bại đầu tiên sau lần thành công gần nhất |
| `deleted_at`, `purge_after` | `TIMESTAMPTZ NULL` | `CHECK ((deleted_at IS NULL) = (purge_after IS NULL))`, `CHECK (purge_after > deleted_at)` |
| `version`, `created_at`, `updated_at` | | |

Index:

| Index | Phục vụ |
|---|---|
| `UNIQUE (org_id, public_id)` | API |
| `UNIQUE (org_id, id)` | đích của FK kép |
| `webhook_endpoints_live_idx (org_id) WHERE deleted_at IS NULL` | đếm giới hạn mỗi org, và fan-out |
| `webhook_endpoints_purge_idx (purge_after) WHERE deleted_at IS NOT NULL` | hàm definer quét xuyên org |

Grant:
- `app_user`: `SELECT, INSERT, DELETE, UPDATE (url, description, status, disabled_reason, failing_since, deleted_at, purge_after, version, updated_at)`;
- `sweep_definer`: `SELECT (org_id, purge_after, deleted_at)` + policy `webhook_endpoints_definer_read`.

#### `webhook_endpoint_secrets` (tenant, thuộc hẳn endpoint)

| Cột | Ràng buộc / ghi chú |
|---|---|
| `id`, `public_id DEFAULT uuidv7()`, `org_id`, `endpoint_id` | FK `(org_id, endpoint_id) → webhook_endpoints(org_id, id) ON DELETE CASCADE` |
| `secret_enc TEXT NOT NULL` | token của `FieldCipher`, AAD `webhook_endpoint_secrets:secret_enc:<orgId>:<publicId>` |
| `expires_at TIMESTAMPTZ NULL` | `NULL` = secret hiện hành |
| `created_at`, `updated_at` | |

- `webhook_endpoint_secrets_current_uq UNIQUE (org_id, endpoint_id) WHERE expires_at IS NULL`: mỗi endpoint có tối đa một secret hiện hành.
- Mỗi lần xoay, service xoá secret đã hết hạn, và nếu còn một secret cũ khác chưa hết hạn thì cho nó hết hạn ngay. Vì vậy mỗi endpoint giữ tối đa hai secret dùng để ký.
- Index: partial unique ở trên, cộng `(org_id, endpoint_id)` cho câu đọc mọi secret còn hạn.
- Grant `app_user`: `SELECT, INSERT, DELETE, UPDATE (expires_at, updated_at)`.

#### `webhook_endpoint_event_types` (tenant, bảng nối)

- Cột: `org_id`, `endpoint_id`, `event_type`, `created_at`, `updated_at`.
- PK `(org_id, endpoint_id, event_type)`.
- FK `(org_id, endpoint_id) → webhook_endpoints(org_id, id) ON DELETE CASCADE`; `event_type → webhook_event_types(type) ON DELETE RESTRICT`.
- Index:
  - PK: đọc các event type của một endpoint;
  - `(org_id, event_type)`: fan-out tìm endpoint theo event (`WHERE org_id = $1 AND event_type = $2`);
  - `(event_type)`: FK `RESTRICT`.
- Grant `app_user`: `SELECT, INSERT, DELETE`.

#### `webhook_messages` (tenant, `PARTITION BY RANGE (created_at)`, owner `partition_owner`)

| Cột | Ràng buộc |
|---|---|
| `id BIGINT` identity, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` | `PRIMARY KEY (created_at, id)`; `UNIQUE (org_id, id, created_at)` (đích FK của deliveries) |
| `org_id UUID NOT NULL` | `REFERENCES organizations(id) ON DELETE RESTRICT` |
| `event_id UUID NOT NULL`, `event_type TEXT NOT NULL`, `event_version INT NOT NULL` | `event_type` theo regex của `webhook_event_types`, cộng `'webhook.test'` cho message thử; `CHECK (event_version > 0)` |
| `body TEXT NOT NULL` | JSON tuần tự hoá **một lần**; byte được ký nguyên văn. `CHECK (octet_length(body) <= 262144)` (`WEBHOOK_BODY_MAX_BYTES`, hằng định dạng) |
| `updated_at` | |

- Không có `public_id`: message không lộ ra API; `webhook-id` gửi đi là `event_id` (§8.3).
- Index `(org_id, created_at)`: participant purge (`DELETE … WHERE org_id = $1` trên mọi partition).

#### `webhook_deliveries` (tenant, `PARTITION BY RANGE (created_at)`, owner `partition_owner`)

| Cột | Ràng buộc |
|---|---|
| `id BIGINT` identity, `created_at TIMESTAMPTZ NOT NULL` | `PRIMARY KEY (created_at, id)`. `created_at` bằng `created_at` của message (FK ép) |
| `public_id UUID NOT NULL` | Sinh ở app (v7); `UNIQUE (public_id, created_at)` |
| `org_id`, `endpoint_id BIGINT NOT NULL`, `message_id BIGINT NOT NULL` | FK `(org_id, message_id, created_at) → webhook_messages(org_id, id, created_at) ON DELETE RESTRICT`. **Không FK tới `webhook_endpoints`** (R-X33, sửa theo review plan 6C): `DETACH` + `DROP` partition của bảng partitioned mang FK tới một bảng thường lấy `AccessExclusiveLock` trên bảng được tham chiếu (spike W3: `SELECT` song song bị chặn), `ATTACH` lấy `ShareRowExclusiveLock` (ghi bị chặn). Bất biến "mọi delivery có endpoint" do người ghi giữ dòng cha (`FOR KEY SHARE` ở fan-out; `FOR SHARE` ở retry/recover/test) và người xoá cứng kiểm `NOT EXISTS` dưới `FOR UPDATE` của dòng endpoint (§7.3), có test bất biến |
| `status TEXT NOT NULL` | `CHECK IN ('PENDING','SENDING','RETRY_SCHEDULED','SUCCEEDED','EXHAUSTED','CANCELLED')` |
| `attempts_total INT NOT NULL DEFAULT 0`, `cycle_base INT NOT NULL DEFAULT 0` | `CHECK (0 <= cycle_base AND cycle_base <= attempts_total)`. `attempts_total` tăng đơn điệu và là fencing token; lần thử trong chu kỳ hiện tại là `attempts_total - cycle_base` |
| `local_failures INT NOT NULL DEFAULT 0` | `CHECK (local_failures >= 0)`. Số lỗi của ta trong chu kỳ hiện tại (R-X35, §7.2); `retry`/`recover` đặt lại `0` |
| `next_attempt_at TIMESTAMPTZ NULL` | `CHECK ((status IN ('PENDING','RETRY_SCHEDULED')) = (next_attempt_at IS NOT NULL))` |
| `lease_until TIMESTAMPTZ NULL` | `CHECK ((status = 'SENDING') = (lease_until IS NOT NULL))` |
| `last_attempt_at TIMESTAMPTZ NULL`, `last_status_code INT NULL`, `last_error TEXT NULL` | `CHECK (last_status_code BETWEEN 100 AND 599)`; `last_error CHECK IN ('TIMEOUT','NETWORK','SERVER_ERROR','CLIENT_ERROR','REDIRECT','RATE_LIMITED','SSRF_BLOCKED','TOO_LARGE','BULKHEAD_FULL','CIRCUIT_OPEN','LEASE_EXPIRED','SECRET_UNAVAILABLE','ENDPOINT_UNAVAILABLE')` |
| `completed_at TIMESTAMPTZ NULL` | `CHECK ((status IN ('SUCCEEDED','EXHAUSTED','CANCELLED')) = (completed_at IS NOT NULL))` |
| `version INT`, `updated_at` | |

Index (khai trên bảng cha):

| Index | Phục vụ |
|---|---|
| `UNIQUE (public_id, created_at)` | Tra theo id (job, API). Câu tra không có `created_at`, nên dò index của từng partition; số partition ≤ retention + premake, khoảng 5 (S6-A26) |
| `(org_id, endpoint_id, created_at DESC, id DESC)` | danh sách delivery của một endpoint |
| `webhook_deliveries_due_idx (next_attempt_at) WHERE status IN ('PENDING','RETRY_SCHEDULED')` | hàm definer và sweep |
| `webhook_deliveries_lease_idx (lease_until) WHERE status = 'SENDING'` | sweep lease hết hạn |
| `(org_id, endpoint_id, status, created_at)` | `recover`, `?status=`, đếm `SENDING` của endpoint lúc claim (bulkhead in-flight, R-X35); `NOT EXISTS` của sweep xoá cứng endpoint |

Grant:
- `app_user`: `SELECT, INSERT, DELETE, UPDATE (status, attempts_total, cycle_base, local_failures, next_attempt_at, lease_until, last_attempt_at, last_status_code, last_error, completed_at, version, updated_at)`;
- `sweep_definer`: `SELECT (org_id, status, next_attempt_at, lease_until)` + policy `webhook_deliveries_definer_read` (trên bảng cha).

### 6.6 Admin (plan 6D)

#### `admin_approvals` (global, nền tảng)

r1 bỏ danh sách `action` đóng (sáu path) và hàm chuẩn hoá theo từng path. Một phê duyệt gắn với **chính request** sẽ được gửi: method, path cụ thể, query và body (trừ trường bí mật). Cơ chế vì vậy không phụ thuộc path: path mới của plugin, `/admin/impersonate-user`, hay route Nest của SP5 đều dùng được mà không đổi schema (S6-A41).

| Cột | Ràng buộc |
|---|---|
| `id BIGINT` identity, `public_id UUID NOT NULL DEFAULT uuidv7()` | `UNIQUE (public_id)` |
| `method TEXT NOT NULL` | `CHECK IN ('POST','PUT','PATCH','DELETE')` (phê duyệt không áp cho `GET`) |
| `path TEXT NOT NULL` | Path cụ thể đã chuẩn hoá của request (chữ thường, không `/` cuối, không query), ví dụ `/api/auth/admin/set-role` hay `/v1/admin/billing/transactions/<id>/assign`. `CHECK (char_length(path) BETWEEN 2 AND 512 AND path ~ '^(/[a-z0-9._~:-]+)+$')` |
| `request_spec JSONB NOT NULL` | Tài liệu mờ `{ "query": {…}, "body": … }`: query và body của request **sau khi** bỏ các khoá thuộc `ADMIN_APPROVAL_SECRET_FIELDS` (`password`, `newPassword`) ở mọi độ sâu. So cả khối bằng `=` của `jsonb` (không phân biệt thứ tự khoá, S6-A43), không query theo phần tử. `CHECK (jsonb_typeof(request_spec) = 'object' AND request_spec ?& ARRAY['query','body'] AND octet_length(request_spec::text) <= 16384)` |
| `reason TEXT NOT NULL` | `CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)` (ticket hoặc lý do) |
| `requested_by TEXT NOT NULL` | `principal.id` của người xin |
| `status TEXT NOT NULL` | `CHECK IN ('PENDING','APPROVED','REJECTED','CANCELLED','CONSUMED')` |
| `decided_by TEXT NULL`, `decided_at TIMESTAMPTZ NULL` | `CHECK ((status IN ('APPROVED','REJECTED','CONSUMED')) = (decided_by IS NOT NULL))`; `CHECK ((decided_by IS NULL) = (decided_at IS NULL))`; `admin_approvals_four_eyes_ck CHECK (decided_by IS NULL OR decided_by <> requested_by)` |
| `consumed_at TIMESTAMPTZ NULL` | `CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL))` |
| `expires_at TIMESTAMPTZ NOT NULL` | `CHECK (expires_at > created_at)`. "Hết hạn" suy ra ở mỗi lần đọc, không lưu (như SP3 S3-A24) |
| `version`, `created_at`, `updated_at` | |

- Trigger `admin_approvals_transition` (`BEFORE UPDATE OF status`) chỉ cho `PENDING → APPROVED | REJECTED | CANCELLED` và `APPROVED → CONSUMED | CANCELLED`; mọi chuyển khác → `check_violation`. Trigger `admin_approvals_immutable_cols` chặn đổi `method`, `path`, `request_spec`, `requested_by`, `reason`, `expires_at`. Máy trạng thái nằm ở DB (§7.5).
- Index:

  | Index | Phục vụ |
  |---|---|
  | `UNIQUE (public_id)` | API và CAS consume |
  | `admin_approvals_open_idx (created_at) WHERE status IN ('PENDING','APPROVED')` | danh sách chờ duyệt |
  | `(requested_by, created_at)` | "yêu cầu của tôi" |
  | `admin_approvals_purge_idx (updated_at) WHERE status IN ('REJECTED','CANCELLED','CONSUMED')` | cron dọn |

- Grant `app_user`: `SELECT, INSERT, DELETE, UPDATE (status, decided_by, decided_at, consumed_at, version, updated_at)`.
- Không RLS. Thuộc `GLOBAL_TABLES` với lý do "phê duyệt thao tác nền tảng, không thuộc org nào".
- `request_spec` có thể chứa dữ liệu cá nhân của user đích (email khi `create-user`). Chỉ route admin đọc; không bao giờ vào log, metric, span hay event (event chỉ mang `approvalId`, `method`, `path`).

### 6.7 Partition và hàm bảo trì

Có bốn bảng partitioned. Migration tạo bảng tạo luôn **hàm bảo trì riêng** của bảng đó. SQL viết thẳng trong migration, không sinh từ helper, vì migration đã merge là bất biến (quy tắc SP3 §6.13).

| Bảng | Hàm (owner `partition_owner`) | Retention | Sàn trong hàm | `lockKey` |
|---|---|---|---|---|
| `audit_logs`, `platform_audit_logs` | `public.audit_partitions_maintain(p_retention_months int, p_premake_months int)`, làm cả hai bảng | `AUDIT_RETENTION_MONTHS` (13) | 6 (`AUDIT_RETENTION_MIN_MONTHS`) | `6001` |
| `webhook_messages`, `webhook_deliveries` | `public.webhook_partitions_maintain(p_retention_months int, p_premake_months int)`. Drop `deliveries` tháng M **trước** `messages` tháng M (spike P2) | `INTEGRATIONS_DELIVERY_RETENTION_MONTHS` (1) | 1 | `6002` |

Thân hàm (mẫu; plan viết cụ thể cho từng bảng):

```sql
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
-- 1. Tham số: NULL hoặc ngoài [sàn, 120] / [1, 12] → RAISE (SQLi bằng app_user không hạ retention dưới sàn được).
-- 2. IF NOT pg_try_advisory_xact_lock(<lockKey>) THEN RETURN; END IF;       -- R6-17: một lượt chạy mỗi lúc
-- 3. PERFORM set_config('lock_timeout', '5s', true);
-- 4. Với i = 0..p_premake_months: lo = date_trunc('month', now()) + i tháng; tên = <bảng>_p || to_char(lo,'YYYYMM');
--    chưa có → CREATE TABLE public.<tên> (LIKE public.<bảng> INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
--              ALTER TABLE public.<bảng> ATTACH PARTITION public.<tên> FOR VALUES FROM (lo) TO (lo + 1 tháng);
--              RETURN NEXT ('created', tên)
-- 5. Mọi partition con (pg_inherits): tên phải khớp '^<bảng>_p[0-9]{6}$' (không khớp → RAISE, fail loud);
--    cận trên (lo + 1 tháng) <= date_trunc('month', now()) - p_retention_months tháng →
--    ALTER TABLE public.<bảng> DETACH PARTITION public.<tên>; DROP TABLE public.<tên>; RETURN NEXT ('dropped', tên)
```
- (Plan 6.0, spike P1) Bước 3 KHÔNG viết `PERFORM set_config('lock_timeout', '5s', true)` trong thân: giá trị đó sống tới hết transaction của caller (lô migration `allOrNothing` gọi hàm để tạo partition đầu). Khai `lock_timeout` là thuộc tính hàm: `LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' SET lock_timeout = '5s'` — Postgres khôi phục khi hàm thoát. Mẫu đầy đủ: `test/fixtures/migrations/…_fixture_core_shared.ts`; `rls-catalog.spec.ts` khoá `proconfig`. Ngân sách một lời gọi là `statement_timeout` của phiên gọi (ADR 0020 P1).

- Mỗi hàm có `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO app_user`, và được tạo, xoá dưới `SET LOCAL ROLE partition_owner`.
- Migration tạo partition cho tháng hiện tại và `premake` tháng tới bằng chính hàm này, gọi dưới `SET LOCAL ROLE partition_owner`.
- Test A-10 so hai hằng sàn viết trong SQL với hằng trong code (mẫu "migration viết cứng, test so với code" của SP3).
- **Retention thực tế:** một partition chỉ bị drop khi **toàn bộ** tháng của nó cũ hơn N tháng tính từ đầu tháng hiện tại, nên dữ liệu được giữ từ N tới N+1 tháng. README ghi rõ.

### 6.8 Hàm `SECURITY DEFINER` mới

Quy tắc chung (SP3 §6.14):
- `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''`;
- tham số `NULL` hoặc ngoài biên → `RAISE`;
- `p_limit` trong `[1, DEFINER_LIMIT_MAX = 1000]`;
- chỉ trả id tối thiểu.

```sql
-- owner sweep_definer (6A)
public.files_orgs_due(p_after uuid, p_limit integer) RETURNS TABLE (org_id uuid)
  -- SELECT DISTINCT org_id FROM public.files WHERE next_sweep_at <= now() AND org_id > p_after ORDER BY org_id LIMIT p_limit
-- owner sweep_definer (6C)
public.integrations_orgs_due(p_after uuid, p_limit integer, p_grace_sec integer) RETURNS TABLE (org_id uuid)
  -- hợp của: deliveries PENDING/RETRY_SCHEDULED có next_attempt_at <= now() - grace;
  --          deliveries SENDING có lease_until <= now() - grace; endpoints có purge_after <= now()
  -- p_grace_sec ngoài [1, 86400] → RAISE
  -- r2 (R-X14): runner gọi integrations_orgs_due(p_after => $1::uuid, p_limit => $2::integer, p_grace_sec => $3::integer),
  --   defineOrgSweep khai extraParams: () => ({ p_grace_sec: INTEGRATIONS_SWEEP_GRACE_SEC }) (§8.3 Sweep)
-- owner tenancy_definer (6D, migration trong thư mục tenancy)
public.tenancy_admin_list_orgs(p_name_prefix text, p_include_deleted boolean, p_limit integer, p_offset integer)
  RETURNS TABLE (org_id uuid, org_name text, org_deleted_at timestamptz, org_purge_after timestamptz, created_at timestamptz)
  -- lower(name) LIKE lower(p_name_prefix) || '%' (ký tự đặc biệt của LIKE được escape trong hàm) ORDER BY lower(name), id
public.tenancy_admin_count_orgs(p_name_prefix text, p_include_deleted boolean, p_cap integer) RETURNS bigint
```

- `tenancy_definer` được grant thêm `SELECT (created_at)` trên `organizations` cho hàm `tenancy_admin_list_orgs`. Index `organizations_name_prefix_idx ON organizations (lower(name) text_pattern_ops, id)` phục vụ lọc tiền tố và sắp xếp.
- `p_name_prefix` rỗng nghĩa là mọi org; độ dài ≤ `ORG_NAME_MAX_LENGTH`.
- **Rủi ro dưới giả định SQLi bằng `app_user`** (cùng loại SP3 DB-M5): `tenancy_admin_list_orgs` liệt kê được tên của mọi org. Chấp nhận có ghi: SQLi dưới `app_user` vốn đã là sự cố nghiêm trọng, và hàm chỉ trả tên và mốc thời gian. Ghi vào phần hệ quả của ADR 0005. Hai hàm `*_orgs_due` chỉ trả id org.

### 6.9 Chuẩn hoá dữ liệu

Áp dụng luật spec cha §4. Ký hiệu như SP3 §6.12.

| Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng chuẩn | Ghi chú |
|---|---|---|---|---|
| `kill_switches` | `{key}` | — | **BCNF** | `changed_by` là snapshot người đổi gần nhất (một sự kiện), không phải bản sao của bảng user |
| `file_purposes` | `{key}` | — | **BCNF** (toàn khoá + timestamp) | Bảng tra cứu |
| `files` | `{id}`, `{org_id, public_id}`, `{object_key}` | `object_key → org_id, public_id` (qua `CHECK` tách chuỗi); `purpose → segment module của object_key` **lúc tạo** | **3NF** (`org_id`, `public_id` là thuộc tính khoá); **ngoại lệ E-F1** | E-F1: `object_key` và `visibility` là snapshot bất biến (không grant `UPDATE`, trigger `files_immutable_cols`), vì chỗ object nằm không được phụ thuộc registry purpose trong code, vốn đổi được. `CHECK` tách chuỗi giữ `object_key` khớp `org_id` và `public_id`. Key của bản `clean`, thumbnail và bản public suy ra từ `object_key` + cột kích thước/`published_at`, không lưu. r1 bỏ cột `sanitized` (phụ thuộc hàm vào `clean_size_bytes`). Dung lượng đang dùng là tổng tính lúc đọc, không lưu (r1 bỏ bảng `file_storage_usage`, per R-X8) |
| `audit_logs`, `platform_audit_logs` | `{recorded_at, id}` (PK); `{event_id}` về ngữ nghĩa (inbox ép) | `actor_id → actor_user_id` | **2NF** hình thức (vi phạm 3NF vì phụ thuộc bắc cầu); **ngoại lệ E-A1** | E-A1: `actor_user_id` là snapshot ánh xạ `principal.id → tenancy_users.public_id` tại lúc ghi. Nguồn thuộc module khác và bị xoá khi xoá tài khoản; spec cha cho phép "snapshot audit không thay đổi theo nguồn". Cơ chế giữ nhất quán: chỉ thêm (grant + trigger), không có đường nào cập nhật. `data` là tài liệu mờ của event |
| `webhook_event_types` | `{type}` | — | **BCNF** | |
| `webhook_endpoints` | `{id}`, `{org_id, public_id}` | — | **BCNF** | `disabled_reason` gắn với trạng thái bằng `CHECK` hai chiều |
| `webhook_endpoint_secrets` | `{id}`, `{org_id, public_id}`, `{org_id, endpoint_id}` (khi `expires_at IS NULL`) | `endpoint_id → org_id` | **3NF**; ngoại lệ E1 của SP3 | `org_id` lặp lại cho RLS và FK kép |
| `webhook_endpoint_event_types` | `{endpoint_id, event_type}` | `endpoint_id → org_id` | **1NF hình thức** (vi phạm 2NF); E1 của SP3 | Như bảng nối quyền của SP3 |
| `webhook_messages` | `{created_at, id}`; `{id}` về ngữ nghĩa | — | **BCNF** | `body` thuộc message (một bản cho N endpoint), nên không lặp ở deliveries. Tách thành bảng riêng chính là vì 3NF |
| `webhook_deliveries` | `{created_at, id}`, `{public_id, created_at}` | `endpoint_id → org_id`; `message_id → created_at, org_id` | **3NF** (`created_at` là thuộc tính khoá); E1 | `created_at` bằng của message, ép bằng FK có chứa `created_at` |
| `admin_approvals` | `{id}`, `{public_id}` | — | **BCNF** | `request_spec` là tài liệu mờ (so cả khối). Không có cột `target_user_id`: giá trị đó đã nằm trong `path` hoặc `request_spec`, tách ra sẽ thành phụ thuộc bắc cầu |

### 6.10 Migration theo plan

Mọi migration theo luật SP3 §6.13: down đối xứng, sweep S2-R57, timestamp tăng dần, plan merge sau đổi timestamp khi rebase.

| Plan | Migration | Nội dung | Khoá | Down |
|---|---|---|---|---|
| 6.0 | `docker/postgres/init/01-roles.sh` | 2 role mới (§3.2) | — | — |
| 6.0 | `core/…_kill_switches` | Bảng §6.2 + grant | bảng mới | `DROP TABLE` |
| 6A | `files/…_files` | Bảng `file_purposes` (+ dòng `files.attachment`), `files`; trigger `files_immutable_cols` và hàm của nó; index `files_live_bytes_idx`; RLS, policy (gồm `files_definer_read`), grant. Hàm `files_orgs_due` tạo trong `SET LOCAL ROLE sweep_definer; CREATE FUNCTION …; REVOKE/GRANT; RESET ROLE`. Seed quyền `files.*` vào `permissions`/`permission_requires` (bảng global, không cần `NO FORCE`) | `SHARE ROW EXCLUSIVE` trên `organizations` (FK) | Ngược thứ tự. `DELETE FROM permissions WHERE key IN (…)` bị FK `RESTRICT` chặn nếu role tuỳ biến còn giữ quyền: lỗi to, có runbook |
| 6B | `audit/…_audit_logs` | Dưới `SET LOCAL ROLE partition_owner`: hai bảng cha, trigger append-only, policy, grant, index, hàm `audit_partitions_maintain`, gọi hàm để tạo partition đầu; `RESET ROLE`. Seed quyền `audit.read` | bảng mới | `SET LOCAL ROLE partition_owner; DROP TABLE` (kéo theo partition) + `DROP FUNCTION`; `RESET ROLE`; xoá quyền |
| 6C | `integrations/…_webhooks` | `webhook_event_types` (+ 6 dòng tenancy), `webhook_endpoints`, `…_secrets`, `…_event_types`. Dưới `partition_owner`: `webhook_messages`, `webhook_deliveries`, hàm `webhook_partitions_maintain`, partition đầu. Dưới `sweep_definer`: `integrations_orgs_due`. Seed quyền `webhooks.*` | `SHARE ROW EXCLUSIVE` trên `organizations` | Ngược thứ tự |
| 6D | `admin/…_admin_approvals` | Bảng §6.6 + hai trigger + hàm trigger | bảng mới | `DROP TABLE`, `DROP FUNCTION` |
| 6D | `tenancy/…_admin_directory` | `CREATE INDEX organizations_name_prefix_idx` trong lô, không `CONCURRENTLY` (runner chạy mọi migration trong một transaction, SP3 §6.13; `organizations` ≤ 10.000 dòng; `lock_timeout` 5 s). Grant cột `created_at` cho `tenancy_definer`. Hai hàm definer tạo dưới `SET LOCAL ROLE tenancy_definer` | `SHARE` trên `organizations` trong lúc dựng index (ngắn) | `DROP FUNCTION` (dưới role), `REVOKE`, `DROP INDEX` |
| 6A∥6C (plan merge sau) | `integrations/…_webhook_file_events` | `INSERT INTO webhook_event_types` cho `files.file.ready`, `files.file.deleted` | `ROW EXCLUSIVE` | `DELETE` (FK `RESTRICT` chặn khi còn subscription; có runbook) |

---
## 7. State machine

Mọi máy trạng thái là enum + một hàm chuyển `switch` vét cạn có kiểm `never` (spec cha §2). Unit test chạy mọi cặp (trạng thái × sự kiện). Ở DB, mỗi chuyển là một CAS `UPDATE … WHERE status = <trạng thái nguồn> AND <điều kiện> RETURNING`; CAS nhận 0 dòng thì service đọc lại và trả kết quả có tên, không bao giờ ghi đè.

### 7.1 File

```
(tạo)          ──────────────────────────────────────────────▶ PENDING
PENDING    ──complete: object có, đúng size──────────────────▶ PROCESSING
PENDING    ──complete: size sai──────────────────────────────▶ REJECTED(SIZE_MISMATCH)
PENDING    ──quá FILES_PENDING_TTL_SEC (sweep)────────────────▶ EXPIRED
PENDING | PROCESSING | READY ──DELETE────────────────────────▶ DELETED
PROCESSING ──pipeline đạt (CAS có fencing processing_attempts)▶ READY
PROCESSING ──pipeline không đạt───────────────────────────────▶ REJECTED(reason)
PROCESSING ──claim lần thứ FILES_PROCESSING_MAX_ATTEMPTS + 1──▶ REJECTED(PROCESSING_FAILED)
DELETED    ──restore (object còn, trước hạn giữ)──────────────▶ PROCESSING   (pipeline chạy lại, kể cả quét virus)
(GENERATED) PENDING ──worker ghi xong──────────────────────────▶ READY        (không qua pipeline, S6-A10)
REJECTED | EXPIRED ──sweep xoá object─▶ (object_removed_at) ──sweep sau FILES_TERMINAL_ROW_RETENTION_SEC─▶ (xoá dòng)
DELETED    ──sweep sau FILES_DELETED_RETENTION_SEC: xoá object, rồi xoá dòng trong cùng bước────────────────▶ (xoá dòng)
```

| Chuyển | `next_sweep_at` ghi thành | Event | Ghi chú |
|---|---|---|---|
| → `PENDING` | `created_at + FILES_PENDING_TTL_SEC` | — | Chưa có gì để audit; dòng `PENDING` được tính vào dung lượng theo `size_bytes` (giữ chỗ, §6.3) |
| `PENDING` → `PROCESSING` | `now() + FILES_PROCESSING_STUCK_SEC` | — | Enqueue `files.process` trong transaction (`SafeEnqueue` ghi outbox) |
| → `READY` | `NULL` | `files.file.ready` (`cause`: `UPLOADED` \| `RESTORED` \| `GENERATED`) | |
| → `REJECTED` | `now()` (xoá object ngay) | `files.file.rejected` | |
| `PENDING` → `EXPIRED` | `now()` | — | Suy ra từ thời gian, như lời mời `EXPIRED` của SP3 §14.1 |
| → `DELETED` | `now()` nếu `published_at` khác `NULL` (gỡ bản public ngay, hai lượt theo R6-5, §8.1 "Sweep"), không thì `deleted_at + FILES_DELETED_RETENTION_SEC` | `files.file.deleted` | Xoá `processing_lease_until` (CHECK). Thao tác trên file đã `DELETED`, `REJECTED` hay `EXPIRED` là no-op, trả `204` |
| `DELETED` → `PROCESSING` | như `PENDING → PROCESSING` | `files.file.restored` | CAS: `status = 'DELETED' AND object_removed_at IS NULL AND deleted_at > clock_timestamp() - FILES_DELETED_RETENTION_SEC` (SP3 §3.15). Không đạt → `409 file_not_restorable` |

### 7.2 Webhook delivery

```
(fan-out/test/recover) ─────────────────────────────▶ PENDING(next_attempt_at = now())
PENDING | RETRY_SCHEDULED ──claim, endpoint ACTIVE──▶ SENDING(lease_until, attempts_total + 1)
PENDING | RETRY_SCHEDULED ──claim, endpoint DISABLED hoặc đã xoá──▶ CANCELLED(ENDPOINT_UNAVAILABLE)
SENDING ──2xx (CAS fencing attempts_total)───────────▶ SUCCEEDED
SENDING ──lỗi của endpoint, attempts_total - cycle_base ≤ len(lịch)──▶ RETRY_SCHEDULED(next_attempt_at = now() + lịch[n] ± 10%)
SENDING ──lỗi của endpoint, hết lịch──────────────────▶ EXHAUSTED            (+ integrations.delivery.exhausted)
SENDING ──lỗi của ta (BULKHEAD_FULL, CIRCUIT_OPEN, SECRET_UNAVAILABLE), local_failures + 1 < MAX──▶ RETRY_SCHEDULED(now() + INTEGRATIONS_LOCAL_FAULT_RETRY_SEC ± 10%, cycle_base + 1, local_failures + 1)
SENDING ──lease hết hạn (sweep; lỗi của ta), local_failures + 1 < MAX──▶ RETRY_SCHEDULED(như dòng trên, last_error = LEASE_EXPIRED)
SENDING ──lỗi của ta thứ MAX = INTEGRATIONS_MAX_LOCAL_FAILURES──▶ EXHAUSTED(local_failures = MAX)   (+ integrations.delivery.exhausted)
PENDING | RETRY_SCHEDULED ──kill switch bật, hoặc endpoint đủ in-flight (R-X35)──▶ (giữ trạng thái; next_attempt_at = GREATEST(next_attempt_at, now() + trễ); không đếm)
SUCCEEDED | EXHAUSTED | CANCELLED ──retry/recover, endpoint ACTIVE──▶ PENDING(cycle_base = attempts_total, local_failures = 0)
```

- **Phân loại lỗi (r1, S6-A49).** Hàm thuần `classifyAttempt(outcome): 'ENDPOINT' | 'LOCAL'`, `switch` vét cạn trên `last_error` có kiểm `never`:
  - `ENDPOINT`: `TIMEOUT`, `NETWORK`, `SERVER_ERROR`, `CLIENT_ERROR`, `REDIRECT`, `RATE_LIMITED`, `SSRF_BLOCKED`, `TOO_LARGE`. Tiêu một bước lịch, đặt `failing_since`, có thể dẫn tới tự tắt (§7.3).
  - `LOCAL`: `BULKHEAD_FULL`, `CIRCUIT_OPEN`, `LEASE_EXPIRED`, `SECRET_UNAVAILABLE` (secret không giải mã được lúc claim: kid bị retire sai, ciphertext hỏng). **Không** đổi `failing_since`, **không** tiêu lịch: `cycle_base + 1` giữ nguyên `attempts_total - cycle_base` trong khi `attempts_total` vẫn tăng đơn điệu (fencing không đổi); hẹn lại sau `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC`; **có đếm** (`local_failures + 1`, R-X35). Metric `webhook_local_faults_total{reason}` + cảnh báo.
  - `ENDPOINT_UNAVAILABLE` không phải kết quả của một lần gửi (nó là nhánh `CANCELLED` lúc claim), nên không vào hàm.
  - `TIMEOUT` là lỗi của endpoint vì timeout của `HttpClient` chỉ đo lần gửi: thứ tự policy là bulkhead → breaker → timeout (`policies.ts:42, 64`: `single: wrap(bulkheadP, breakerP, timeoutP)`), thời gian chờ trong hàng bulkhead không tính vào timeout.
  - Lỗi mạng do **egress của ta** (DNS nội bộ sập, NetworkPolicy) cũng ra `NETWORK` và không phân biệt được với endpoint chết. Chấp nhận có tên: mọi endpoint cùng bị ảnh hưởng như nhau, ngưỡng tự tắt 5 ngày dài hơn mọi sự cố hạ tầng chấp nhận được, và delivery `EXHAUSTED` phát lại được bằng `recover` (runbook).
- **Trần lỗi của ta (R-X35, sửa theo review plan 6C; thay câu "không có trần" của r2).** Lỗi thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` (mặc định 5) của một delivery → `EXHAUSTED` + event `integrations.delivery.exhausted`, phát lại được bằng `retry`/`recover` (đặt lại `local_failures = 0`). Không có trần thì một lỗi lặp không tự lành (khoá `FieldCipher` bị retire sai, worker chết lặp lại giữa lúc gửi) giữ delivery xoay vòng mãi. `SECRET_UNAVAILABLE` được ghi ngay trong transaction claim (không ném: ném làm claim rollback và job retry rồi bỏ, delivery kẹt). Cảnh báo `webhook_local_faults_total` vẫn báo sớm; luật config ở §11.4 (`bulkheadLimit ≥` concurrency của `webhooks-out`) làm `BULKHEAD_FULL` không xảy ra trong một process đúng cấu hình.
- **Bulkhead in-flight theo endpoint (R-X35).** Claim khoá dòng endpoint `FOR NO KEY UPDATE` rồi đếm delivery `SENDING` còn lease của endpoint bằng **câu riêng** (snapshot mới của READ COMMITTED thấy claim vừa commit; gộp vào câu khoá thì hai claim cùng thấy N−1). Đủ `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` (mặc định 4, phải < `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT`) → từ chối claim: `next_attempt_at` dời sau `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC` ± 10%, không tăng `attempts_total`, không đếm vào `local_failures`, job mới `webhook-<id>-a<n>-b<ms>`. Một endpoint chậm/chết không giữ quá N slot của bulkhead `webhooks-out` chung. Rủi ro còn lại có tên: trần theo endpoint, không theo org — một org có nhiều endpoint chết (≤ `INTEGRATIONS_MAX_ENDPOINTS_PER_ORG`) hoặc nhiều org cùng lúc vẫn chiếm `N × số endpoint` slot; giảm nhẹ bằng trần endpoint mỗi org và tự tắt; trần theo org là việc sau. Vòng BUSY (rủi ro có tên): endpoint chết có K delivery chờ sinh lại K − N job mỗi `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC`, mỗi job lấy khoá dòng endpoint một lần (transaction ngắn); giảm nhẹ bằng tự tắt endpoint sau `INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC` (5 ngày) và trần in-flight theo endpoint; trần theo org là việc sau.

- `429` có `Retry-After` thì dùng `max(lịch[n], retryAfter)`, với trần `RESILIENCE_RETRY_AFTER_MAX_SEC` (đã có ở `parseRetryAfterSec`).
- **Fencing:** CAS ghi kết quả có điều kiện `status = 'SENDING' AND attempts_total = <số đã claim>`. Một worker bị treo quá lease (lease đã bị sweep lấy lại) sẽ ghi 0 dòng và bỏ kết quả (R6-9).

### 7.3 Webhook endpoint

```
ACTIVE   ──PATCH status=DISABLED──────────────────────────────▶ DISABLED(MANUAL)
ACTIVE   ──lỗi của endpoint khi failing_since ≤ now() - DISABLE_AFTER──▶ DISABLED(AUTO_FAILING)   (+ integrations.endpoint.disabled)
DISABLED ──PATCH status=ACTIVE (failing_since = NULL)─────────▶ ACTIVE                     (+ integrations.endpoint.enabled)
* ──DELETE──▶ đã xoá (deleted_at, purge_after = now() + INTEGRATIONS_ENDPOINT_PURGE_DELAY_SEC) ──sweep: không còn delivery──▶ (xoá dòng)
```

- Sweep xoá cứng endpoint (R-X33, sửa theo review plan 6C): khoá dòng endpoint `FOR UPDATE … SKIP LOCKED` (xung đột với `FOR KEY SHARE` của fan-out đang chèn delivery, nên dòng đang được ghi thì để lượt sau), rồi bằng **câu riêng** sau khi có khoá xoá những dòng `NOT EXISTS` delivery; còn delivery (partition chưa hết retention) → dời `purge_after` thêm `INTEGRATIONS_ENDPOINT_PURGE_DELAY_SEC`, không ném. Không có FK `webhook_deliveries → webhook_endpoints` nên không có lỗi FK nào để bắt (r2 ghi `23503`; FK `RESTRICT` khi xoá dòng cha thật ra báo `23001` — cả hai không còn liên quan). Bất biến "mọi delivery có endpoint" có test.
- Luật config: `PURGE_DELAY_SEC ≥ (INTEGRATIONS_DELIVERY_RETENTION_MONTHS + 1) × 31 ngày`, nên bình thường một lần là đủ.

### 7.4 Secret ký

- `CURRENT` (`expires_at IS NULL`) → `ROTATED` (`expires_at = now() + INTEGRATIONS_SECRET_ROTATION_OVERLAP_SEC`) → hết hạn (suy ra).
- Dòng hết hạn bị xoá ở lần xoay kế tiếp, hoặc theo `CASCADE` khi xoá endpoint.
- Ký bằng mọi secret có `expires_at IS NULL OR expires_at > now()`, tối đa hai.

### 7.5 Phê duyệt admin

```
PENDING  ──approve (người khác người xin, chưa hết hạn)──▶ APPROVED
PENDING  ──reject (người khác)──────────────────────────▶ REJECTED
PENDING | APPROVED ──cancel (người xin)─────────────────▶ CANCELLED
APPROVED ──identity consume (khớp method + path + request_spec + người xin, chưa hết hạn)──▶ CONSUMED
PENDING | APPROVED + expires_at ≤ now() ──▶ "EXPIRED" (suy ra, không ghi)
```

DB ép bằng trigger `admin_approvals_transition`, trigger cột bất biến và `CHECK` bốn mắt (§6.6).

---

## 8. Luồng nghiệp vụ

### 8.1 Files

**Khởi tạo upload.** `POST /v1/orgs/{orgId}/files`, body `{ purpose, filename, contentType, sizeBytes, uploadMode? }`.

1. **Validate bằng zod.**
   - `filename`: `trim` → NFC → 1–255 ký tự, không có ký tự điều khiển, `/` hay `\`.
   - `contentType`: chữ thường, bỏ tham số, khớp regex của `declared_type`.
   - `sizeBytes`: số nguyên dương.
2. **Kiểm theo code, trước transaction.**
   - Kill switch `files.uploads` bật → `503 service_unavailable`.
   - Purpose không có, hoặc `clientUploadable = false` → `422 unknown_file_purpose`.
   - `contentType` không thuộc `allowedTypes ∪ textTypes` → `422 file_type_not_allowed`.
   - `sizeBytes > purpose.maxBytes()` → `422 file_too_large`.
3. **Chọn chế độ upload** (hàm thuần `planUpload`, unit test đủ nhánh):

   | Điều kiện | Chế độ |
   |---|---|
   | Driver `local` | `API` (`sizeBytes ≤ FILES_API_UPLOAD_MAX_BYTES`, không thì `422 file_too_large`) |
   | Driver `s3`, client xin `uploadMode` | Theo yêu cầu, nếu hợp lệ với kích thước |
   | Driver `s3`, `sizeBytes ≤ FILES_DIRECT_MAX_BYTES` và `FILES_PRESIGNED_POST = true` | `DIRECT_POST` |
   | Driver `s3`, còn lại, `sizeBytes ≤ FILES_MULTIPART_MAX_BYTES` | `MULTIPART` |
   | Còn lại | `422 file_too_large` |

4. **Transaction trong OrgScope** (race R6-1, R6-2):
   - `OrgMutationLock.lock()` (khoá dòng org `FOR NO KEY UPDATE`, cùng điểm tuần tự hoá và thứ tự khoá "org trước" của SP3 §8.6); `false` (org vừa bị purge) → `404 not_found`;
   - đếm `status = 'PENDING'` (partial index) phải nhỏ hơn `FILES_MAX_PENDING_PER_ORG`, không thì `422 pending_uploads_limit`;
   - `limit = await FileStorageLimit.current()`: port export từ `files/index.ts`, `abstract class FileStorageLimit { abstract current(): Promise<StorageLimit> }`, `StorageLimit = { kind: 'UNLIMITED' } | { kind: 'MAX'; max: number; featureKey: string }` (cùng dạng `SeatLimit` của SP4). **Một tên, SP6 sở hữu** (per R-X13); SP4 import đúng class này, không khai class riêng. Inject `@Optional()`; vắng provider thì files dùng `FILES_ORG_STORAGE_LIMIT_BYTES` (`0` → `UNLIMITED`, còn lại `MAX` với `featureKey = 'files.storage_bytes'`). SP4 cài port bằng `EntitlementsFilesPortsModule` ở entry riêng `modules/entitlements/integrations/files.ts`, và composition của SP7 nạp entry đó qua dòng `entitlements-files` của `OPTIONAL_BRIDGES` khi cả `entitlements` lẫn `files` bật (per R-X13, SP4 §9.7, mục 18.4); adapter chỉ đọc DB trong transaction của caller, không I/O ngoài;
   - **kiểm lúc boot** (`FileStorageLimitCheck`, api và worker, `onApplicationBootstrap`; per R-X13): `loadedModules().has('entitlements')` (hàm của `core/config`, SP7 7A; module bị tắt không bao giờ được import nên không có trong tập này) mà `FileStorageLimit` không có provider → log ERROR `{ event: 'file_storage_limit_adapter_missing' }` và ném: app không khởi động. Thiếu adapter không bao giờ âm thầm thay trần theo gói bằng 1 GiB. Code của kiểm này do **4B** thêm (sửa code của 6A), cùng PR với adapter: 6A merge ở W3 khi chưa có adapter, nên nếu 6A mang kiểm thì `main` không khởi động được từ W3 tới W4;
   - `MAX`: `used = SELECT COALESCE(SUM(<STORED_BYTES_SQL>), 0) FROM files WHERE org_id = app_current_org() AND object_removed_at IS NULL` (§6.3, `files_live_bytes_idx`); `used + sizeBytes > max` → `422 quota_exceeded` với `errors[{ path: 'feature', code: featureKey }]` (cùng dạng lỗi `assertWithinLimit` của SP4). `UNLIMITED`: không đếm;
   - sinh `public_id` (v7) và `object_key`; `INSERT files … status = 'PENDING'` (từ đây dòng được tính vào dung lượng);
   - `upload_expires_at` = `now() + FILES_UPLOAD_URL_TTL_SEC` với `DIRECT_POST`/`API`, hoặc `created_at + FILES_PENDING_TTL_SEC` với `MULTIPART` (URL từng part xin theo lô).
5. **Sau commit, không nằm trong transaction:**

   | Chế độ | Việc |
   |---|---|
   | `DIRECT_POST` | `createPresignedPost({ Bucket, Key: stagingKey, Conditions: [['content-length-range', size, size], ['eq', '$key', stagingKey]], Expires: FILES_UPLOAD_URL_TTL_SEC })`, với `stagingKey = object_key + UPLOAD_SUFFIX`. Tính cục bộ, không gọi mạng (spike F1) |
   | `MULTIPART` | `CreateMultipartUpload(Key: stagingKey)` → transaction thứ hai `UPDATE files SET multipart_upload_id = $1 WHERE … AND status = 'PENDING'`. Crash giữa hai bước: dòng `PENDING` không có `UploadId`; sweep huỷ mọi multipart theo prefix `object_key` lúc hết hạn (`ListMultipartUploads(Prefix)`), nên không mồ côi |
   | `API` | Token `FieldCipher.encrypt(JSON {v:1,k:'U',o,f,e}, 'files:transfer-token')`, `url = /v1/file-uploads/{token}` (đường dẫn tương đối với base của API) |

6. **Trả `201`**, `Location: /v1/orgs/{orgId}/files/{id}`, body `FileUpload`.
   - Route **không** `@Idempotent()`: response chứa capability upload có hạn, không lưu vào Redis (cùng lý do S3-A8 của SP3; mục 18.1).
   - Client retry chỉ sinh thêm một file `PENDING`; file đó tự hết hạn, và sau khi sweep xoá object thì không còn được tính vào dung lượng.

**Xin URL cho part multipart.** `POST …/files/{fileId}/parts { partNumbers: int[] }`:
- mỗi phần tử trong 1–10000, không trùng, số phần tử ≤ `FILES_MULTIPART_PRESIGN_BATCH_MAX`;
- file phải là `PENDING` + `MULTIPART` và có `multipart_upload_id`, không thì `409 file_not_pending`;
- presign `UploadPart` cho từng số, hạn `FILES_UPLOAD_URL_TTL_SEC`;
- trả `200 { parts: [{ partNumber, url }], expiresAt }`.

**Hoàn tất.** `POST …/files/{fileId}/complete`, `@Idempotent()`, body rỗng:
1. Đọc file.
   - `PROCESSING`, `READY`, `REJECTED` → `200` với trạng thái hiện tại (idempotent theo trạng thái).
   - `EXPIRED`, `DELETED` → `409 file_not_pending`.
2. **I/O ngoài transaction.**
   - `DIRECT_POST`/`API`: `HeadObject(stagingKey)`. Không có → `409 file_upload_incomplete`; file giữ `PENDING`, client làm lại được trước khi hết hạn.
   - `MULTIPART`: `ListParts` trên `stagingKey` (phân trang). Không part nào → `409 file_upload_incomplete`. Có part → `CompleteMultipartUpload` với mọi part theo thứ tự (server tự liệt kê, không tin ETag của client). `NoSuchUpload` → `HeadObject`; có object thì coi như đã hoàn tất ở lần trước.
3. **So kích thước.** `ContentLength ≠ size_bytes` → CAS `PENDING → REJECTED(SIZE_MISMATCH)` + event → `200` với file `REJECTED`. Sweep xoá object.
4. **CAS** `PENDING → PROCESSING` (xoá `multipart_upload_id`), cộng `SafeEnqueue(files.process, { fileId }, { jobId: 'files-process-<publicId>-v<version>' })` trong cùng transaction. CAS 0 dòng → đọc lại, trả như bước 1.

**Upload qua API.** `PUT /v1/file-uploads/{token}`:
- `@PublicRoute()`; capability nằm trong token. Prefix `/v1/file-uploads` đăng ký bằng `@BodyParserOwner({ owner: 'files', contentTypes: ['application/octet-stream'] })`.
- Giải mã token bằng `FieldCipher`. Sai định dạng, hết hạn, file không còn `PENDING` hay org sai → `404 not_found` giống hệt nhau (không lộ trạng thái).
- Bắt buộc `Content-Length` bằng `size_bytes`, không thì `400 malformed_request`.
- Stream vào `FileStorage.putStream(stagingKey, readable, size, abortSignal)` (S3: `lib-storage Upload`; local: file tạm rồi `rename`), với bộ đếm byte. Vượt `size_bytes` → huỷ upload (`abort()`, spike F4), `413 payload_too_large`, lingering close theo `lingerIfBodyUnread` của core.
- Xong → chạy đúng bước 3–4 của "Hoàn tất" trong cùng request → `204`.
- Request chạy trong `OrgScope(o)` của token. Không có principal org nào, nên đây không phải route tenant theo matcher của SP3 §7.4 (`OTHER`).

**Pipeline.** Job `files.process { fileId }`, queue `files`, `onInactiveOrg: 'skip'`:

| Bước | Việc | Kết quả không đạt |
|---|---|---|
| P0 claim | Transaction: `UPDATE files SET processing_lease_until = now() + FILES_PROCESSING_LEASE_SEC, processing_attempts = processing_attempts + 1 WHERE public_id = $1 AND status = 'PROCESSING' AND (processing_lease_until IS NULL OR processing_lease_until < now()) RETURNING processing_attempts` | 0 dòng → no-op, job `completed`. `processing_attempts > FILES_PROCESSING_MAX_ATTEMPTS` → `REJECTED(PROCESSING_FAILED)` (chặn poison pill: ảnh làm libvips crash cả process thì chỉ chạy được tối đa N lần) |
| P1 nhận vào | Key gốc đã có và đúng `size_bytes` (lần thử trước đã sao) → bỏ qua bước sao. Không thì `HeadObject(stagingKey)` → lấy `ETag`, kiểm size → `CopyObject(stagingKey → object_key, CopySourceIfMatch: ETag)` → `HeadObject(object_key)` kiểm lại size → `DeleteObject(stagingKey)`. Từ đây **mọi** bước chỉ đọc key gốc, key mà không URL nào của client ghi được (chặn TOCTOU: ghi đè vùng nhận giữa lúc quét, R6-27) | Không có → `OBJECT_MISSING`; size sai → `SIZE_MISMATCH`; `412` của `CopySourceIfMatch` (vùng nhận bị ghi đè giữa hai bước) → ném, lần thử sau đọc lại |
| P2 dò kiểu | `GetObject Range: bytes=0-4099` → `fileTypeFromBuffer`. Có kiểu → phải thuộc `allowedTypes` và không thuộc danh sách cấm (SVG, HTML, XML, JS) | `TYPE_NOT_ALLOWED` |
| P3 văn bản | Không dò được kiểu và `declared_type ∈ textTypes`: đọc `FILES_TEXT_SAMPLE_BYTES` đầu, phải là UTF-8 hợp lệ (`TextDecoder` với `fatal: true`) và không có byte `0x00` → `detected_type = declared_type` | `TYPE_NOT_ALLOWED` |
| P4 băm + quét | Một lần `GetObject` toàn bộ, `tee` sang SHA-256 và (khi `FILES_SCAN = clamd`) `MalwareScanner.scan(stream)`. `size_bytes > FILES_SCAN_MAX_BYTES` với quét bật → từ chối trước khi đọc. Lỗi hoặc timeout của clamd → **ném** (job retry, lease hết hạn); không bao giờ đi tiếp khi chưa quét (fail closed) | `SCAN_SIZE_EXCEEDED`, `INFECTED` (log WARN `file_infected { fileId, signature }`) |
| P5 ảnh | `imagePolicy = SANITIZE` và `ImageSanitizer.accepts(detected_type)`: gọi `ImageSanitizer.sanitize({ open: () => storage.getStream(object_key), contentType, sizeBytes, signal })` → `SanitizeResult = { kind: 'UNCHANGED' } \| { kind: 'SANITIZED'; clean: Blob; thumbnail: Blob \| null } \| { kind: 'REJECTED'; reason: 'IMAGE_INVALID' \| 'IMAGE_TOO_LARGE' }` (`Blob = { body: Readable; sizeBytes: number }`, thumbnail luôn `image/webp`). **Mặc định `NoopImageSanitizer`**: `accepts` trả `false`, nên bước này bỏ qua và object phục vụ là bản gốc (per R-X9). `SANITIZED` → `PutObject {key}.clean` và `{key}.thumb.webp` với `IfNoneMatch: '*'`; `412` → `HeadObject` lấy kích thước của bản đã có (R6-4). Không bao giờ ghi đè object gốc. Adapter chịu giới hạn pixel/bộ nhớ của mình (hợp đồng port, README) | `REJECTED` → lý do adapter trả; adapter ném → job retry, tới `FILES_PROCESSING_MAX_ATTEMPTS` thì `PROCESSING_FAILED` |
| P6 public | `visibility = PUBLIC`, ba bước (R6-5): **(a)** transaction `UPDATE files SET published_at = now() WHERE public_id = $1 AND status = 'PROCESSING' AND processing_attempts = $n` (ghi ý định **trước** khi sao; 0 dòng → dừng). **(b)** `CopyObject` object phục vụ và thumbnail sang `public/…` với `ContentType`, `ContentDisposition` và `CacheControl: public, max-age=FILES_PUBLIC_CACHE_MAX_AGE_SEC`. **(c)** đọc lại dòng (câu `SELECT` thường, sau khi (b) đã xong): không còn `status = 'PROCESSING' AND processing_attempts = $n` → `DeleteObjects` hai bản public vừa sao rồi dừng (file đã bị xoá/từ chối giữa chừng) | — |
| P7 commit | CAS `status = 'PROCESSING' AND processing_attempts = $n` → `READY` (điền `detected_type`, `sha256`, `scan_result`, `clean_size_bytes`, `thumbnail_size_bytes`, `ready_at`; xoá lease; `next_sweep_at = NULL`) + event `files.file.ready` | 0 dòng (file vừa bị xoá): object đã ghi được sweep của `DELETED` dọn |

- Mỗi lần `REJECTED`: CAS có fencing + event + `next_sweep_at = now()`.
- Mọi stream đã mở được huỷ trong `finally`.
- **Concurrency (đối chiếu code):** `files` và `webhooks-out` là queue `io`, nên concurrency mặc định là `QUEUE_IO_CONCURRENCY` = **20** (`queue.config.ts`; `QUEUE_CONCURRENCY_OVERRIDES` mặc định rỗng, `.env.example:230`). SP6 **không** đặt override: không có `sharp`, mỗi job `files.process` chỉ giữ vài chục KB trong bộ nhớ (mẫu magic bytes 4100 byte, mẫu văn bản `FILES_TEXT_SAMPLE_BYTES`) và stream phần còn lại. clamd mặc định `MaxThreads 10`, `MaxQueue 100`, nên 20 luồng quét chờ ở clamd chứ không lỗi. Dự án thêm adapter ảnh thì đặt `QUEUE_CONCURRENCY_OVERRIDES=files=<n>` theo bộ nhớ (README). r0 ghi "mặc định 2" là sai với code.

**Tải về.** `GET …/files/{fileId}/download?variant=original|thumbnail` (`files.read`):
- File không `READY` → `409 file_not_ready`. Xin thumbnail khi không có → `404 not_found`.
- `PRIVATE`: presigned `GetObject` trên client **public endpoint** (`FILES_S3_PUBLIC_ENDPOINT`) với:
  - `ResponseContentType = detected_type` (thumbnail: `image/webp`);
  - `ResponseContentDisposition = attachment; filename="<ASCII thay thế>"; filename*=UTF-8''<percent-encoded>`;
  - `Expires = FILES_DOWNLOAD_URL_TTL_SEC`;
  - trả `200 { url, expiresAt }`.
- `PUBLIC`: `200 { url: FILES_PUBLIC_BASE_URL + '/' + object phục vụ, expiresAt: null }`.
- Driver `local`: `url = /v1/file-downloads/{token}` (token loại `D`, hạn như trên). Route này stream file với `Content-Type`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`. Local chỉ dành cho dev/test (luật production cấm), nên việc phục vụ từ domain của API là ngoại lệ có tên (S6-A5).

**Xoá và khôi phục.**
- `DELETE …/files/{fileId}` (`files.delete`): theo §7.1, trả `204`.
- `POST …/files/{fileId}/restore` (`files.delete`, `@Idempotent()`): theo §7.1, trả `200` với file đang `PROCESSING`.

**Sweep.**
- `defineOrgSweep({ key: 'files.sweep-orgs', definerFunction: 'files_orgs_due', orgJob: FilesSweepOrgJob, jobIdPrefix: 'files-sweep', … })` (§5.3 `core/sweep`): cron `FILES_SWEEP_CRON` (mặc định mỗi 15 phút) trên `maintenance`, lô `FILES_SWEEP_BATCH_SIZE`, tối đa `FILES_SWEEP_MAX_BATCHES` lô.
- Mỗi org được một job `files.sweep-org`, queue `files`, `jobId = files-sweep-<orgId>-<slot>` (luật slot chung của `core/sweep`), `onInactiveOrg: 'skip'`: org đã xoá mềm thì chờ purge.
- Job claim một lô bằng `UPDATE files SET next_sweep_at = now() + FILES_SWEEP_RETRY_SEC WHERE id IN (SELECT id FROM files WHERE next_sweep_at <= now() ORDER BY next_sweep_at LIMIT n FOR UPDATE SKIP LOCKED) RETURNING *`, rồi xử lý từng dòng theo bảng dưới. Mỗi bước I/O idempotent, rồi CAS kết thúc.

| Trạng thái đến hạn | Việc |
|---|---|
| `PENDING` | CAS → `EXPIRED`, `next_sweep_at = now()`. Không I/O. Sau CAS, client không `complete` được nữa |
| `PROCESSING` | Enqueue lại `files.process` (jobId theo `version`), `next_sweep_at = now() + FILES_PROCESSING_STUCK_SEC` |
| `REJECTED` / `EXPIRED`, `object_removed_at IS NULL` | Huỷ multipart theo prefix; `DeleteObjects` gồm `.upload`, gốc, `.clean`, `.thumb.webp`, và bản `public/…` nếu `PUBLIC`. Nếu `published_at` khác `NULL` và `now() < published_at + FILES_PUBLIC_RECHECK_SEC` → CAS `next_sweep_at = published_at + FILES_PUBLIC_RECHECK_SEC` (lượt hai, R6-5); không thì CAS `object_removed_at = now()`, `published_at = NULL`, `next_sweep_at = now() + FILES_TERMINAL_ROW_RETENTION_SEC` (từ đây dòng không còn được tính vào dung lượng) |
| `REJECTED` / `EXPIRED`, `object_removed_at` có | `DELETE` dòng |
| `DELETED`, `published_at` có | `DeleteObjects` hai bản `public/…`. Rồi (R6-5): `now() < published_at + FILES_PUBLIC_RECHECK_SEC` (một bản sao của bước P6 có thể còn đang bay) → CAS giữ `published_at`, `next_sweep_at = published_at + FILES_PUBLIC_RECHECK_SEC` (lượt hai xoá lần nữa); không thì CAS `published_at = NULL`, `next_sweep_at = deleted_at + FILES_DELETED_RETENTION_SEC` |
| `DELETED`, quá hạn giữ | `DeleteObjects` toàn bộ (kể cả `public/…` bất kể `published_at`) → `DELETE` dòng với điều kiện `status = 'DELETED' AND deleted_at <= clock_timestamp() - FILES_DELETED_RETENTION_SEC` |

**Xoá cứng org.**
- Participant `files` (`@OrgPurgeParticipantContributor({ key: 'files', order: 110 })`, order theo registry của R-X5; có trong `forWorker()`) chạy trong transaction purge: `DELETE FROM files`. Chỉ đụng DB (SP3 §9.5).
- Subscriber `files.org-purged` (`tenancy.org.purged@1`), trong inbox:
  - `SafeEnqueue(files.purge-org-objects, { pass: 'INITIAL' }, { jobId: 'files-purge-org-<orgId>-initial' })`;
  - `SafeEnqueue(files.purge-org-objects, { pass: 'RECHECK' }, { jobId: '…-recheck', delayMs: FILES_ORG_PURGE_RECHECK_SEC × 1000 })`.
- Job `files.purge-org-objects`, `onInactiveOrg: 'run'`:
  - lặp `ListObjectsV2(Prefix = '<orgId>/')` và `Prefix = 'public/<orgId>/'`, mỗi trang ≤ 1000 → `DeleteObjects`;
  - rồi `ListMultipartUploads(Prefix)` → `AbortMultipartUpload`;
  - log INFO số object đã xoá, metric `files_org_objects_purged_total`.
- Lần `RECHECK` bắt object do job xử lý đang chạy dở ghi vào sau lần đầu (R6-7).

**File do worker tạo** (`FileStore.saveGenerated({ purpose, filename, contentType, body: Readable, sizeBytes })`, chỉ trong OrgScope):
1. Transaction như bước 4 của khởi tạo (khoá org, kiểm hạn mức): `upload_mode = 'GENERATED'`, `status = 'PENDING'`.
2. `putStream` (băm SHA-256 và dò kiểu trên luồng).
3. CAS `PENDING → READY` với `scan_result = 'NOT_SCANNED'` + event `files.file.ready { cause: 'GENERATED' }`.

Lỗi giữa chừng: dòng `PENDING` hết hạn qua sweep. Nội dung do chính hệ thống sinh nên không quét (S6-A10).

### 8.2 Audit

**Ghi.** Subscriber `audit.recorder` (bộ chọn `AUDITED_EVENTS`) chạy trong `UnitOfWork` + `Inbox.once` của `DeliverEventHandler`:
1. Envelope có `orgId` → WorkerHost đã mở `OrgScope(orgId)`, kể cả org đã xoá mềm hay đã purge (`core.event.deliver` là `'run'`, SP3 §5.2) → `INSERT INTO audit_logs`.
2. Không có `orgId` → `INSERT INTO platform_audit_logs`.
3. `actor.type = 'user'` → `TenancyUserIds.publicIdsBySubjects([actor.id])` → `actor_user_id`. Không có dòng (user chưa chạm tenancy, hoặc đã bị xoá tài khoản) → `NULL`.
4. `data` = `e.data` đã parse; `target` = `e.aggregate`.
5. Lỗi DB → ném (deliver retry). Partition thiếu (hàm bảo trì không chạy) → `23514`/`no partition` → ném, cảnh báo `db_partition_months_ahead < 1` (mục 15).

**Path của Better Auth được audit** (`AUDITED_AUTH_PATHS`, hằng của identity):

| Path | Khi nào audit | `data` của `attempted` | `data` của `completed` |
|---|---|---|---|
| Mọi path có tiền tố `/admin/`, trừ `/admin/has-permission` | Session là nhân viên (`hasAdminRole`), sau khi đã qua mọi gate của SP3 §5.2 (3)–(8) và bước phê duyệt | `{ attemptId, path, targetUserId, approvalId, fields, role }`: `targetUserId` qua `adminTargetUserId(body)` khi body có `userId`; `fields` là danh sách **tên** khoá của `body.data` hoặc body, bỏ `password`/`newPassword`; `role` chỉ khi path ghi role. Không có giá trị nào khác | `{ attemptId, path, outcome: 'SUCCEEDED' \| 'FAILED', status, resultId }`: `resultId` là id user vừa tạo, nếu có |
| `/api-key/create`, `/api-key/update`, `/api-key/delete` | Mọi user | `{ attemptId, path, keyId, fields }` | như trên (`resultId` = id key vừa tạo) |

- Actor là `{ type: 'user', id: session.user.id }`; aggregate `{ type: 'auth_action', id: attemptId, version: 1 | 2 }`.
- `correlationId` là request id của mount, cũng là correlation của mọi event tenancy mà hook identity gây ra (xoá tài khoản, thu hồi grant). Đây là chỗ nối của L2 (X-5).

**Đăng nhập.** `identity.session.created { userId, sessionId, via }`:
- `via ∈ { PASSWORD, SOCIAL, OIDC, TWO_FACTOR, OTHER }`, suy ra từ `context.path` (spike B1);
- actor là user.

Không ghi IP (mục 19.2 C3).

**Thông báo bảo mật.** `identity.security_notice.recorded { noticeId, userId, kind, ticket, noticeOccurredAt }`, actor `{ type: 'system', id: 'identity.security-notice' }`. Với `operator_reset`, ticket định danh thao tác của vận hành.

**Đọc.** `GET /v1/orgs/{orgId}/audit-logs` (`AuditPermissions.require('audit.read')`):
- phân trang cursor `?limit&cursor`, thứ tự `recordedAt desc, id desc`;
- lọc: **tối đa một** trong `action`, `actorId`, `targetType+targetId`, `correlationId`. Nhiều hơn → `422 validation_failed` (bảo đảm mỗi query dùng đúng một index);
- cộng `from`/`to` trên `recorded_at`.

Resource:

```
AuditLog {
  id,                                   // event_id
  action, actionVersion, occurredAt, recordedAt,
  actor: { type, id, userId },
  target: { type, id },
  correlationId, causationId, data
}
```

### 8.3 Webhook

**Đăng ký endpoint.** `POST /v1/orgs/{orgId}/webhook-endpoints`:
- Phân quyền: `webhooks.write` + `@SessionOnly()` + `@RequireFreshSession()` + `@RequireVerifiedEmail()` (tạo một kênh xuất dữ liệu của org, S6-A35). Không `@Idempotent()`: body trả secret.
- Body `{ url, description?, eventTypes: string[1..WEBHOOK_EVENT_TYPES_MAX] }`. `WEBHOOK_EVENT_TYPES_MAX = 50` là hằng định dạng (schema, `maxItems` của OpenAPI — không phụ thuộc env của máy export); `INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT` (≤ hằng) chỉ hạ trần lúc chạy → `422 validation_failed` trên `eventTypes` (sửa theo review plan 6C).

1. **`UrlGuard.check(url)`:**
   - `new URL`; scheme thuộc `RESILIENCE_ALLOWED_SCHEMES` (production chỉ `https`); không có userinfo; không có fragment; port thuộc `RESILIENCE_ALLOWED_PORTS`; `assertUrlAllowed` của core;
   - `dns.promises.lookup(host, { all: true })`: **mọi** địa chỉ phải qua `isPublicAddress(ip, parseCidrs(RESILIENCE_SSRF_ALLOW_CIDRS))`;
   - lỗi → `422 webhook_url_not_allowed`, detail chung, không nêu IP đã phân giải.
   - Kiểm lúc đăng ký chỉ để phản hồi sớm. Lớp chặn thật là `ssrfLookup` lúc connect của `HttpClient` (DNS rebinding, W-22).
2. `eventTypes` phải thuộc `webhook_event_types` (không thì `422 webhook_event_type_unknown`); bỏ trùng.
3. **Transaction:**
   - `OrgMutationLock.lock()` (port tenancy export: `SELECT … FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE`, SP3 §8.6 bước 1);
   - đếm endpoint chưa xoá < `INTEGRATIONS_MAX_ENDPOINTS_PER_ORG`, không thì `422 webhook_endpoints_limit`;
   - `INSERT` endpoint, các event type, và secret: `whsec_` + base64(`randomBytes(WEBHOOK_SECRET_BYTES = 32)`), mã hoá bằng `FieldCipher`;
   - event `integrations.endpoint.created { endpointId, eventTypes, urlHost }` (chỉ host; path/query có thể chứa token của khách).
4. Trả `201` + `Location`, body `WebhookEndpoint` + `secret` (chỉ lần này).

**Các thao tác khác trên endpoint:**
- **Sửa (R-X34, sửa theo review plan 6C: đổi đích = tạo mới):**
  - `PATCH …/{endpointId}` (merge-patch, `If-Match` bắt buộc, quyền `webhooks.write`): `description`, `status`. `url`/`eventTypes` ở route này → `422 validation_failed`.
  - `PATCH …/{endpointId}/destination` (merge-patch, `If-Match` bắt buộc): `url` (kiểm lại bước 1), `eventTypes` (thay cả tập). Cùng bộ guard với tạo: `webhooks.write` + `@SessionOnly()` + `@RequireFreshSession()` + `@RequireVerifiedEmail()`. Route riêng vì ba yêu cầu này là metadata route mà `AuthGuard` đọc; identity không có API theo request để service tự kiểm "session mới".
- **Xoá:** `DELETE` là xoá mềm (§7.3).
- **Xoay secret:** `POST …/{endpointId}/rotate-secret`: khoá endpoint `FOR NO KEY UPDATE`; xoá secret đã hết hạn; secret cũ còn hạn → `expires_at = now()`; secret hiện hành → `expires_at = now() + OVERLAP`; chèn secret mới → `200 { secret, previousExpiresAt }` + event `integrations.endpoint.secret_rotated`. Không `@Idempotent()` (trả secret).

**Fan-out.** Subscriber `integrations.webhook-fanout` (bộ chọn `WEBHOOK_EVENTS`), chạy trong inbox và OrgScope của event:
1. `e.orgId = null` → WARN `webhook_event_without_org`, bỏ qua. Cờ `webhook` chỉ hợp lệ với event theo org; test C-3 khẳng định mọi def có cờ này đều mang org.
2. Tìm endpoint `ACTIVE`, chưa xoá, có đăng ký `e.type`. Không có → return.
3. `body = JSON.stringify({ type: e.type, version: e.version, timestamp: e.occurredAt, data: e.data })`. Vượt `WEBHOOK_BODY_MAX_BYTES` → ERROR `webhook_body_too_large` và bỏ qua: đây là lỗi thiết kế event, có test contract chặn.
4. `INSERT webhook_messages` → `INSERT webhook_deliveries` (một dòng mỗi endpoint, `PENDING`) → `SafeEnqueue(integrations.deliver-webhook, { deliveryId }, { jobId: 'webhook-<deliveryId>-a1' })` cho từng dòng.

**Gửi.** Job `integrations.deliver-webhook { deliveryId }`, queue `webhooks-out`, `onInactiveOrg: 'run'`. Delivery đã sinh trước khi org bị xoá mềm vẫn được gửi, nên `tenancy.org.deleted` tới được khách; org đã purge thì không còn dòng nào.
1. Kill switch `integrations.webhook_delivery` bật → CAS `next_attempt_at = GREATEST(next_attempt_at, now() + INTEGRATIONS_KILLED_RECHECK_SEC)`, chỉ khi delivery đã đến hạn (job trùng/tới sớm không kéo lần hẹn muộn về sớm), + enqueue trễ; không đếm lần thử.
2. **Claim** (một transaction):
   - delivery còn claim được và đã đến hạn → khoá dòng endpoint `FOR NO KEY UPDATE`, đếm `SENDING` còn lease bằng câu riêng; đủ `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` → dời như bước 1 (trễ `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC` ± 10%), không đếm (R-X35, §7.2);
   - CAS `PENDING | RETRY_SCHEDULED → SENDING` (`lease_until = now() + INTEGRATIONS_DELIVERY_LEASE_MS`, `attempts_total + 1`);
   - đọc endpoint; không `ACTIVE` hoặc đã xoá → `CANCELLED`;
   - đọc message và các secret còn hạn; giải mã secret (CPU, trong transaction): `FieldCipherError` → ghi lỗi của ta `SECRET_UNAVAILABLE` ngay trong transaction này (§7.2, R-X35), log ERROR `webhook_secret_unreadable`, không gửi.
3. **Ngoài transaction:**
   - `ts = now()`; `signature = secrets.map((s) => new Webhook(s).sign(event_id, ts, body)).join(' ')`;
   - `HttpClient.request('webhooks-out', url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'user-agent': WEBHOOK_USER_AGENT, 'webhook-id': event_id, 'webhook-timestamp': String(unix(ts)), 'webhook-signature': signature } })`.
4. **Phân loại kết quả** (đối chiếu `http-client.ts`: 3xx và 4xx khác 429 trả về bình thường kèm `status`; 429 và 5xx ném `UpstreamError`):
   - 2xx → thành công;
   - 3xx → `REDIRECT` (không theo redirect);
   - 4xx khác 429 → `CLIENT_ERROR`;
   - `UpstreamError`, `switch` vét cạn trên `reason` (`UpstreamFailure`, `upstream-error.ts:10-17`): `bad_status` → `SERVER_ERROR`, `rate_limited` → `RATE_LIMITED` (dùng `retryAfter`), `timeout` → `TIMEOUT`, `network` → `NETWORK`, `too_large` → `TOO_LARGE`, `bulkhead_full` → `BULKHEAD_FULL`, `circuit_open` → `CIRCUIT_OPEN` (breaker đã tắt nên không xảy ra, nhưng `switch` phải phủ);
   - `SsrfBlockedError` → `SSRF_BLOCKED`.
   Sau đó `classifyAttempt` (§7.2) chia thành lỗi của endpoint hay lỗi của ta.
5. **Ghi kết quả** (CAS có fencing, §7.2):
   - thành công → `endpoint.failing_since = NULL`;
   - lỗi của endpoint → `failing_since = COALESCE(failing_since, now())`, rồi CAS tự tắt endpoint (R6-12); còn lịch → `RETRY_SCHEDULED`; hết lịch → `EXHAUSTED` + event `integrations.delivery.exhausted { deliveryId, endpointId, eventType, eventId }`;
   - lỗi của ta → không chạm endpoint; `RETRY_SCHEDULED` với `cycle_base = cycle_base + 1`, `local_failures + 1`, trễ `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC` (R6-28); lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED` + event `integrations.delivery.exhausted` (R-X35);
   - mỗi lần hẹn lại: `SafeEnqueue` job kế tiếp, trễ `delayMs`, `jobId = webhook-<id>-a<attempts_total + 1>`.

**Sweep.** `defineOrgSweep({ key: 'integrations.sweep-orgs', definerFunction: 'integrations_orgs_due', orgJob: IntegrationsSweepOrgJob, jobIdPrefix: 'integrations-sweep', extraParams: () => ({ p_grace_sec: INTEGRATIONS_SWEEP_GRACE_SEC }), … })` (r2, per R-X14: tham số thêm theo tên). Job theo org `integrations.sweep-org` (queue `webhooks-out`, `onInactiveOrg: 'run'` — sửa theo review plan 6C: delivery của org đã xoá mềm vẫn được gửi (`deliver-webhook` là `run`), nên lease hết hạn và job bị mất của nó cũng phải được lấy lại; `skip` để delivery `SENDING` kẹt tới khi purge) claim lô bằng `FOR UPDATE SKIP LOCKED`, mỗi loại tối đa `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG` dòng mỗi lượt:
- delivery `PENDING`/`RETRY_SCHEDULED` quá hạn hơn grace (job bị mất) → "chạm" `next_attempt_at = now()` (lượt sau lấy phần còn lại, không lấy lại cùng dòng) + enqueue lại `webhook-<id>-a<attempts_total + 1>-s<slot>`. Backlog lớn (mất Redis) cần nhiều lượt: rủi ro có tên, README ghi;
- delivery `SENDING` có `lease_until` quá grace → CAS lỗi của ta `LEASE_EXPIRED` (§7.2, có đếm, có trần) + enqueue;
- endpoint có `purge_after <= now()` → xoá cứng, hoặc dời `purge_after` khi còn delivery (§7.3).

**Xoá cứng org.** Participant `integrations` (`@OrgPurgeParticipantContributor({ key: 'integrations', order: 120 })`, có trong `forWorker()`) xoá trong transaction purge, con trước cha: `webhook_deliveries`, `webhook_messages`, `webhook_endpoint_event_types`, `webhook_endpoint_secrets`, `webhook_endpoints`. Chỉ DB. Order `120` là đề xuất của SP6: registry R-X5 chưa có dòng cho integrations (mục 18.3); hai participant của SP6 không có FK với nhau nên mọi số duy nhất trong `(100, 1000)` đều đúng.

**Dead-letter.** Hàng đợi chết là tập delivery `EXHAUSTED`/`CANCELLED` trong DB: bền, xem được qua API, phát lại được, giữ theo partition. Tập failed của BullMQ chỉ còn cho lỗi lập trình (spec cha §6; S6-A33).
- `POST …/webhook-deliveries/{deliveryId}/retry` (`@Idempotent()`) → CAS từ `SUCCEEDED | EXHAUSTED | CANCELLED` về `PENDING` với chu kỳ mới (`cycle_base = attempts_total`, `local_failures = 0`); endpoint phải `ACTIVE`, không thì `409 webhook_endpoint_disabled`.
- `POST …/webhook-endpoints/{endpointId}/recover { since }` (`@Idempotent()`) làm như trên cho tối đa `INTEGRATIONS_RECOVER_BATCH_MAX` delivery `EXHAUSTED | CANCELLED` có `created_at >= since`, trả `200 { requeued, hasMore }` (không cần module operations).

**Gửi thử.** `POST …/webhook-endpoints/{endpointId}/test` (`@Idempotent()`) → message `webhook.test` (`data: { endpointId }`, `event_id` v7) + delivery + job → `201` + `Location` của delivery.

**Hợp đồng công khai:**
- Sáu event tenancy mang `webhook: true`: `tenancy.member.added`, `.member.removed`, `.member.role_changed`, `tenancy.org.updated`, `.org.deleted`, `.org.restored`. Cộng `files.file.ready`, `files.file.deleted`: plan merge sau trong cặp 6A/6C thêm cờ và dòng catalog.
- `GET /v1/webhook-event-types` trả catalog kèm JSON Schema (`z.toJSONSchema`).
- `buildOpenApi` thêm mục `webhooks` của OpenAPI 3.1 cho mọi event `webhook: true`, nên `oasdiff` của CI chặn thay đổi phá vỡ payload webhook như với API (spec cha §14 "Contract: schema webhook ra ngoài"; S6-A36).

### 8.4 Admin

**Guard: `@PlatformStaffAction()` của 3D** (per R-X2). SP6 không định nghĩa guard nào cho nhân viên. Mọi route `/v1/admin/**` của SP6 (6D) mang decorator đó; hành vi (credential, step-up TOTP qua câu SQL của `staff-step-up.ts`, `auth_time` tươi ở `external`, mã lỗi theo `AUTH_MODE`, DB lỗi → `503`) là của 3D, viết ở addendum 3D §A1 và được test ở 3D (PSA-*). Route của SP6 chạy bộ ca `describePlatformStaffActionConformance` của addendum 3D §A5 (D-1). r0 định nghĩa `@PlatformAdminOnly()` + `authorizeStaffRequest`; r1 bỏ cả hai.

**Audit truy cập: port `PlatformAccessAudit` của 3D, bản cài của 6B** (per R-X2; chữ ký ở addendum 3D §A3):
- Guard của decorator gọi `record(entry)` **trước** handler, chỉ khi gate đã cho qua. 6B cài port bằng `PlatformAccessAuditAdapter`: trong `UnitOfWork` riêng, phát `audit.staff_access.recorded { method, route, params, credentialKind }` với actor `entry.actor`, commit, rồi mới trả để handler chạy. `route` = `entry.routeTemplate`; `params` = `entry.params`, tức **mọi** path param của template (r2 theo addendum 3D §A3 A-D5; r1 chỉ giữ `orgId`, `userId`, làm mất id giao dịch mà SP5 cần khi thay log `billing_txn_viewed`). Schema event giới hạn khoá theo `^[A-Za-z][A-Za-z0-9]*$` và mỗi giá trị ≤ 256 ký tự; vi phạm → port ném → `503` (fail closed; path của route admin chỉ chứa id). Query string và body không bao giờ tới port.
- Template có `:orgId` và giá trị là UUID → phát trong `OrgScope(orgId)`, nên entry nằm trong audit của chính org đó và owner **thấy được nhân viên đã đọc dữ liệu của họ**. Không có `:orgId` (hoặc không phải UUID) → audit nền tảng. Áp cho route admin của **mọi** module: `/v1/admin/orgs/{orgId}/entitlements…` (SP4), `/v1/admin/billing/*` (SP5, thay log `billing_txn_viewed`), route của SP6 và của feature.
- Ghi lỗi → port ném, decorator trả `503`, handler không chạy (R6-21).
- `OrgScope` ở đây do SP6 mở tường minh cho một org id từ path; RLS vẫn áp dụng. Đây là ngoại lệ có tên với "org chỉ được tin sau kiểm membership" của spec cha §4.1: platform admin không phải member, và quyền đọc đến từ guard nền tảng + audit (ADR 0005, S6-A39). SP4 và SP5 trích ngoại lệ này cho route admin của mình.

**Kiểm lúc boot: `PlatformStaffRouteInventory`** (identity, thêm ở 6B; chỉ process api; `onApplicationBootstrap`):
- Duyệt mọi handler bằng `DiscoveryService` + `Reflector`, lấy template bằng `routeTemplateOf` (chuyển vào `core/http` ở 6.0), metadata của `@PlatformStaffAction()` đọc bằng `hasPlatformStaffAction(controller, handler)` của identity (addendum 3D §A2), metadata của `@RequiresApproval()` đọc bằng `requiresApprovalOf` (6D).
- App **không khởi động** (log ERROR liệt kê handler) khi:
  - (a) template khớp `^v1/admin(/|$)` mà handler không có metadata của `@PlatformStaffAction()`;
  - (b) handler có metadata đó mà template không khớp `^v1/admin(/|$)` (giữ `/v1/admin` là ranh giới duy nhất của quyền nền tảng trên HTTP, để proxy/NetworkPolicy chặn được theo prefix);
  - (c) có ít nhất một route `v1/admin` mà port `PlatformAccessAudit` không có bản cài thật: tra token không ra provider (`moduleRef.get(PlatformAccessAudit, { strict: false })` ném), **hoặc** ra instance `instanceof NoopPlatformAccessAudit` (addendum 3D §A3; r2 thay phần "nếu 3D cài no-op bằng một class mặc định" của r1 bằng hợp đồng đã chốt);
  - (d) (6D thêm luật này cùng `@RequiresApproval()`) handler có `@RequiresApproval()` mà không có `@PlatformStaffAction()`: phê duyệt hai người chỉ có nghĩa sau gate nhân viên.
- Cùng mẫu với `OrgRouteInventory` của SP3 §7.1. Vì kiểm ở boot, route admin mới của SP4, SP5 hay feature quên decorator sẽ làm CI đỏ ngay ở smoke, không đợi review.
- Route admin merge **trước** 6B (4C nếu 4C merge trước trong cặp cùng sóng W4; 3D không có route `/v1/admin`) chạy với `NoopPlatformAccessAudit` cho tới khi 6B merge; từ 6B trở đi luật (c) bảo đảm không còn khoảng hở. Ca inventory trên route SP4 chạy ở plan merge sau trong cặp 4C/6B (SP4 AD-1): 6B merge sau thì A-26 chạy trên tập route thật có route SP4. Tắt module audit mà vẫn có route admin → không khởi động (fail loud, S6-A45).

**Phê duyệt hai người** (`ADMIN_DUAL_CONTROL=on`; mặc định `off`, S6-A40). Một cơ chế, không phụ thuộc path (S6-A41):

1. **Phạm vi.**
   - **Better Auth:** mọi path tiền tố `/admin/` **đòi** phê duyệt, trừ hằng `ADMIN_APPROVAL_EXEMPT_PATHS` của identity (mỗi mục kèm lý do): chỉ đọc (`/admin/get-user`, `/admin/list-users`, `/admin/list-user-sessions`, `/admin/has-permission`) và chỉ thu hẹp (`/admin/ban-user`, `/admin/revoke-user-session`, `/admin/revoke-user-sessions`, `/admin/stop-impersonating`). Ở 1.7.6 (đã đọc `plugins/admin/routes.mjs`), path còn lại đòi phê duyệt: `set-role`, `create-user`, `update-user`, `unban-user`, **`impersonate-user`**, `remove-user`, `set-user-password`. Path plugin thêm ở bản sau **tự động** bị đòi phê duyệt (mặc định từ chối, cùng cách gate (3) của SP3 đi theo tiền tố).
   - **Route Nest:** handler gắn `@RequiresApproval()` (identity export; luôn đi cùng `@PlatformStaffAction()`, inventory luật (d) kiểm). **SP6 cung cấp decorator, không gắn nó lên route của module khác** (per R-X15). Module chủ route gắn: SP5 sở hữu việc gắn nó lên ba route tiền tay `POST /v1/admin/billing/payment-transactions/{id}/assign`, `…/refunded`, `…/ignore` (nên 5B phụ thuộc 6D; W6 > W5). Lớp chặn máy: `requiresApprovalOf(controller, handler)` export để module chủ viết test liệt kê route của mình phải mang decorator (SP5 BT-E4); SP6 không giữ danh sách "route tiền" của module khác (S6-A53).
   - Ngoài phạm vi: thao tác chỉ thu hẹp phải chạy được ngay khi có sự cố (cùng nguyên tắc `@NarrowingTenancyAction()` của SP3); `PUT` kill switch (công cụ khẩn cấp, có audit); lệnh CLI `identity:staff-2fa-reset` (ranh giới tin cậy của vận hành).
2. **Xin.** Nhân viên A gọi `POST /v1/admin/approvals { method, path, query, body, reason }` (route có `@PlatformStaffAction()`).
   - `path` được chuẩn hoá (chữ thường, bỏ `/` cuối, bỏ query) và phải nằm trong phạm vi ở bước 1: path Better Auth là `AUTH_BASE_PATH` + path của endpoint; path Nest phải khớp template của một handler có `@RequiresApproval()`. Không khớp → `422 validation_failed`.
   - `query`, `body` chứa khoá thuộc `ADMIN_APPROVAL_SECRET_FIELDS` ở bất kỳ độ sâu nào → `422` (không bao giờ lưu mật khẩu; người duyệt không cần thấy nó).
   - `request_spec = { query: query ?? {}, body: body ?? null }`; trả `201` + event `admin.approval.requested`.
3. **Duyệt.** Nhân viên B **khác A** gọi `POST /v1/admin/approvals/{id}/approve`, sau khi đọc `GET …/{id}` (thấy đúng method, path, query, body sẽ chạy). CAS `status = 'PENDING' AND expires_at > clock_timestamp() AND requested_by <> $B` → `APPROVED` + event.
   - B là người xin → `403 cannot_approve_own_request`; `CHECK` bốn mắt là lớp chặn cuối.
   - Không còn chờ hoặc đã hết hạn → `409 approval_not_pending`.
   - `/reject` tương tự.
4. **Dùng.** A gửi đúng request đó kèm header `x-admin-approval-id: <id>`.
   - Better Auth: trong `hooks.before`, sau gate SP3 (3)–(8) và sau `adminTargetUserId` (SP3 r8: id phải là UUID chữ thường chuẩn), trước audit `attempted`. Spec tính từ `ctx.query`, `ctx.body` (spike D1: đúng đối tượng handler đọc).
   - Nest: `ApprovalGuard` của `@RequiresApproval()`, chạy sau guard của `@PlatformStaffAction()`. Spec tính từ `req.query`, `req.body` đã parse.
   - Thiếu header → `403 admin_approval_required`. Có header → `AdminActionApprovals.consume({ approvalId, requestedBy: principal.id, method, path, spec })` với `spec` là query/body của request sau khi bỏ khoá bí mật: **một** câu `UPDATE admin_approvals SET status = 'CONSUMED', consumed_at = now(), version = version + 1 WHERE public_id = $1 AND status = 'APPROVED' AND requested_by = $2 AND method = $3 AND path = $4 AND request_spec = $5::jsonb AND expires_at > clock_timestamp() RETURNING public_id`, cộng event `admin.approval.consumed`, trong `UnitOfWork` riêng, commit trước khi handler chạy.
   - 0 dòng → `403 admin_approval_invalid` (sai id, sai người, sai path, sai query/body, hết hạn, đã dùng: một mã, chỉ nhân viên đã qua step-up mới tới được đây).
   - Handler lỗi sau khi đã tiêu thụ → phê duyệt vẫn `CONSUMED`, cần xin lại (S6-A42). Route Nest có `@Idempotent()`: guard chạy trước `IdempotencyInterceptor`, nên lần gửi lại sau khi đã thành công nhận `403 admin_approval_invalid` thay vì response đã lưu. Hành vi này fail closed và được ghi trong README; client đọc lại trạng thái.
5. **Vì sao gắn với toàn bộ request:** thứ handler dùng để quyết định thao tác nằm trong path, query và body. Gắn phê duyệt vào cả ba (trừ khoá bí mật, vốn không quyết định **thao tác nào** được làm) thì không cần hàm chuẩn hoá riêng cho từng path, nên không có chỗ để hook và handler đọc hai giá trị khác nhau (lỗ của r0 D1). Cái giá: request lúc dùng phải trùng từng byte ngữ nghĩa với request đã duyệt (thứ tự khoá không quan trọng); lệch là `403`, tức là fail closed.

**Kill switch.**
- `GET /v1/admin/kill-switches`: registry + trạng thái DB + `ETag` theo từng dòng.
- `PUT /v1/admin/kill-switches/{key} { killed, reason }`: `If-Match` bắt buộc (`428`). Chưa có dòng thì version là 0, ETag `W/"0"`. Key không có trong registry → `404`.
- Trong transaction: `KillSwitches.set(…)` + event `admin.kill_switch.changed { key, killed }`.
- Không đòi phê duyệt hai người: đây là công cụ khẩn cấp, thấy được qua audit.

**Đọc tổ chức** (`PlatformOrgDirectory` của tenancy):
- `GET /v1/admin/orgs?namePrefix=&includeDeleted=&page=&pageSize=`;
- `GET /v1/admin/orgs/{orgId}`: org, số member, owner (`userId` tenancy), trạng thái xoá, `storageUsedBytes` (port files, `@Optional`), `webhookEndpoints` (port integrations, `@Optional`);
- `GET /v1/admin/orgs/{orgId}/members` (offset, kèm email qua `IdentityDirectory.findUsers` ở local/hybrid);
- `GET /v1/admin/users/{userId}/orgs`: `userId` là id `auth."user"`, hoặc `sub` ở external; dùng `tenancy_list_user_orgs` có sẵn.

**Đọc audit:**
- `GET /v1/admin/audit-logs` (bảng nền tảng);
- `GET /v1/admin/orgs/{orgId}/audit-logs` (`AuditReader.forOrg(orgId)`, mở `OrgScope`, đọc được cả org đã purge);
- cùng bộ lọc với §8.2.

---

## 9. API

Mọi route tuân §3 spec cha:
- lỗi dạng `problem+json`;
- `201` + `Location`, `204` cho DELETE;
- `ETag` + `If-Match` cho PATCH/PUT, merge-patch;
- offset hoặc cursor pagination;
- `@ApiProblems` liệt kê lỗi của route.

Route tenant nằm dưới `/v1/orgs/{orgId}` và đi qua pipeline của SP3 §7. Bảng G-6 role × route của SP3 được sinh từ metadata, nên tự phủ route mới.

### 9.1 Catalogue quyền mới (`definePermissionCatalogue`, SP3 §8.2)

| Key | requires | ownerOnly | apiKey | support | ADMIN | MEMBER | Plan |
|---|---|---|---|---|---|---|---|
| `files.read` | — | | ✓ | ✓ | ✓ | ✓ | 6A |
| `files.write` | `files.read` | | ✓ | | ✓ | ✓ | 6A |
| `files.delete` | `files.read` | | ✓ | | ✓ | | 6A |
| `audit.read` | — | | ✓ | | ✓ | | 6B |
| `webhooks.read` | — | | ✓ | ✓ | ✓ | | 6C |
| `webhooks.write` | `webhooks.read` | | | | ✓ | | 6C |

- Provider catalogue nằm ở cả `forApi()` và `forWorker()` (SP3 INT3-5). Migration seed dòng `permissions` và `permission_requires`.
- Thêm quyền có `grantTo.admin` làm `A = perms(ADMIN)` lớn lên. Theo SP3 §8.2, role tuỳ biến từng tương đương ADMIN có thể không còn tương đương; README ghi hệ quả này.
- `webhooks.write` không `apiKeyEligible`: một key bị lộ không được mở kênh xuất dữ liệu (S6-A35).

### 9.2 Bảng route

| Method + path | Phân quyền | Status | Idempotent | Plan |
|---|---|---|---|---|
| `POST /v1/orgs/{orgId}/files` | `files.write` | `201` | không (capability) | 6A |
| `POST …/files/{fileId}/parts` | `files.write` | `200` | không (chỉ ký URL) | 6A |
| `POST …/files/{fileId}/complete` | `files.write` | `200` | ✓ | 6A |
| `GET …/files` (`?purpose&status&page&pageSize&sort=-createdAt`) | `files.read` | `200` offset | — | 6A |
| `GET …/files/{fileId}` | `files.read` | `200` + ETag | — | 6A |
| `GET …/files/{fileId}/download?variant=` | `files.read` | `200` | — | 6A |
| `DELETE …/files/{fileId}` | `files.delete` | `204` | — | 6A |
| `POST …/files/{fileId}/restore` | `files.delete` | `200` | ✓ | 6A |
| `PUT /v1/file-uploads/{token}` | `@PublicRoute()` + token | `204`, `413`, `404` | — | 6A |
| `GET /v1/file-downloads/{token}` | `@PublicRoute()` + token (chỉ driver local) | `200` stream | — | 6A |
| `GET /v1/orgs/{orgId}/audit-logs` | `audit.read` | `200` cursor | — | 6B |
| `GET /v1/webhook-event-types` | user đã xác thực | `200` | — | 6C |
| `GET/POST /v1/orgs/{orgId}/webhook-endpoints` | `webhooks.read` / `webhooks.write` + session mới | `200` offset / `201` | POST không (secret) | 6C |
| `GET/PATCH/DELETE …/webhook-endpoints/{endpointId}` | read / write | `200` / `200` (`If-Match`) / `204` | — | 6C |
| `POST …/{endpointId}/rotate-secret` | `webhooks.write` + session mới | `200` | không (secret) | 6C |
| `POST …/{endpointId}/test` | `webhooks.write` | `201` | ✓ | 6C |
| `POST …/{endpointId}/recover` | `webhooks.write` | `200` | ✓ | 6C |
| `GET …/{endpointId}/deliveries` (`?status&limit&cursor`) | `webhooks.read` | `200` cursor | — | 6C |
| `GET /v1/orgs/{orgId}/webhook-deliveries/{deliveryId}` | `webhooks.read` | `200` | — | 6C |
| `POST …/webhook-deliveries/{deliveryId}/retry` | `webhooks.write` | `200` | ✓ | 6C |
| `GET /v1/admin/orgs`, `GET /v1/admin/orgs/{orgId}`, `…/members`, `…/audit-logs` | `@PlatformStaffAction()` (3D) | `200` | — | 6D |
| `GET /v1/admin/users/{userId}/orgs` | `@PlatformStaffAction()` | `200` offset | — | 6D |
| `GET /v1/admin/audit-logs` | `@PlatformStaffAction()` | `200` cursor | — | 6D |
| `GET /v1/admin/kill-switches`, `PUT /v1/admin/kill-switches/{key}` | `@PlatformStaffAction()` | `200` / `200` | PUT có `If-Match` | 6D |
| `GET/POST /v1/admin/approvals`, `GET …/{id}`, `POST …/{id}/approve`, `…/reject`, `DELETE …/{id}` (huỷ) | `@PlatformStaffAction()` | `200` / `201` / `200` / `204` | `POST /approvals` không (người xin gửi lại chỉ tạo thêm một phê duyệt `PENDING`, tự hết hạn); approve/reject là CAS, gửi lại → `409` | 6D |

### 9.3 Resource

```
File          { id, purpose, filename, contentType, sizeBytes, status, rejectionReason, scanResult, sanitized, hasThumbnail,
                visibility, publicUrl, sha256, createdAt, updatedAt, readyAt, deletedAt }     // contentType = detected ?? declared
                                                                                              // sanitized = clean_size_bytes khác NULL
FileUpload    { file: File, upload: { mode: 'DIRECT_POST'|'MULTIPART'|'API', method: 'POST'|'PUT', url, fields,
                partSizeBytes, partCount, expiresAt } }                                        // field không dùng = null
WebhookEndpoint { id, url, description, eventTypes, status, disabledReason, failingSince, createdAt, updatedAt }
                  (+ secret chỉ trong 201 và rotate-secret)
WebhookDelivery { id, endpointId, eventType, eventId, status, attempts, nextAttemptAt, lastAttemptAt,
                  lastStatusCode, lastError, completedAt, createdAt }
AuditLog      (§8.2) · KillSwitch { key, description, killed, reason, changedBy, updatedAt }
AdminApproval { id, method, path, query, body, reason, requestedBy, status, decidedBy, decidedAt, consumedAt, expiresAt, expired, createdAt }
AdminOrg      { id, name, deletedAt, purgeAfter, createdAt, memberCount, ownerUserIds, storageUsedBytes, webhookEndpoints }
```

`sha256` là hex. `publicUrl` chỉ có khi `PUBLIC` + `READY`. Không resource nào trả tên hay đường dẫn object key.

### 9.4 Bảng lỗi mới

Chủ sở hữu mã theo SP3 INT-I7.

| Status | `code` | Khi nào | Chủ |
|---|---|---|---|
| 400 | `malformed_request` | `PUT` upload thiếu `Content-Length` hoặc khác `sizeBytes` | core |
| 403 | `admin_approval_required`, `admin_approval_invalid` | bước phê duyệt của hook `/admin/*` và `ApprovalGuard` (§8.4) | identity |
| 403 | `cannot_approve_own_request` | tự duyệt | admin |
| 404 | `not_found` | token upload/download sai hoặc hết hạn; thumbnail không có; kill switch lạ | core |
| 409 | `file_not_pending`, `file_upload_incomplete`, `file_not_ready`, `file_not_restorable` | §8.1 | files |
| 409 | `webhook_endpoint_disabled`, `webhook_delivery_not_retryable` | retry/recover/test khi endpoint không `ACTIVE`; delivery đang `PENDING`/`SENDING` | integrations |
| 409 | `approval_not_pending` | duyệt/từ chối/huỷ phê duyệt không còn chờ hoặc đã hết hạn | admin |
| 412 / 428 | `precondition_failed` / `precondition_required` | PATCH endpoint, PUT kill switch | core |
| 413 | `payload_too_large` | body upload vượt `sizeBytes` | core |
| 415 | `unsupported_media_type` | upload không phải `application/octet-stream` | core |
| 422 | `unknown_file_purpose`, `file_type_not_allowed`, `file_too_large`, `pending_uploads_limit` | §8.1 | files |
| 422 | `quota_exceeded` | quota dung lượng (mã của core, dành cho quota theo gói; S6-A8) | core |
| 422 | `webhook_url_not_allowed`, `webhook_event_type_unknown`, `webhook_endpoints_limit` | §8.3 | integrations |
| 502 / 504 | `upstream_error` / `upstream_timeout` | lỗi S3 trên đường request (`complete`, `parts`); lỗi SDK được map qua `upstreamErrorMapper` của core | core |
| 503 | `service_unavailable` | kill switch; không ghi được audit trước thao tác (hook `attempted`, port audit truy cập); DB lỗi | core |

Mã lỗi của guard nhân viên (`forbidden` cho người không phải nhân viên, `api_key_not_allowed_here` cho org key, `second_factor_required` ở `local`/`hybrid`, `reauthentication_required` ở `external`, `503` khi DB lỗi hoặc port audit ném) thuộc `@PlatformStaffAction()` của 3D, không thuộc SP6 (per R-X2; bảng đầy đủ theo `AUTH_MODE` ở addendum 3D §A1.3).

---

## 10. Async: queue, job, cron, event

**Queue mới:** `files` (`io`) và `webhooks-out` (`io`, tên theo spec cha §6). Audit dùng queue `events` sẵn có (deliver).

| Job | Queue | Payload | `onInactiveOrg` | jobId |
|---|---|---|---|---|
| `files.process` | `files` | `{ fileId }` | `skip` | `files-process-<fileId>-v<version>` |
| `files.sweep-orgs` | `maintenance` | `{}` | — (không org) | cron |
| `files.sweep-org` | `files` | `{}` + `meta.orgId` | `skip` | `files-sweep-<orgId>-<slot>` (luật slot của `core/sweep`) |
| `files.purge-org-objects` | `files` | `{ pass: 'INITIAL' \| 'RECHECK' }` + `meta.orgId` | **`run`** | `files-purge-org-<orgId>-<pass>` |
| `integrations.deliver-webhook` | `webhooks-out` | `{ deliveryId }` | **`run`** | `webhook-<deliveryId>-a<n>` |
| `integrations.sweep-orgs` | `maintenance` | `{}` | — | cron |
| `integrations.sweep-org` | `webhooks-out` | `{}` + `meta.orgId` | `run` (sửa theo review plan 6C, §8.3 "Sweep") | `integrations-sweep-<orgId>-<slot>` |
| `core.partitions.maintain` | `maintenance` | `{}` | — | cron |
| `admin.approvals.purge` | `maintenance` | `{}` | — | cron |

- Mọi jobId không chứa `:` (`assertEnqueueOpts`).
- Hai cron quét là `defineOrgSweep` của core (§5.3), nên cron nằm ở `maintenance` và việc theo org nằm ở queue của module; cùng quy ước với SP3 và SP7 (review ops I8c).
- Payload chỉ có id: không PII, không tên file, không URL.

| Cron | Mặc định | Ghi chú |
|---|---|---|
| `core.partitions.maintain` | `30 0 * * *` UTC | tạo trước `premake` tháng, drop partition hết hạn |
| `files.sweep-orgs` | `*/15 * * * *` UTC | thay `files.cleanup-orphans` 04:00 của spec cha (mục 18.1) |
| `integrations.sweep-orgs` | `*/5 * * * *` UTC | job bị mất, lease hết hạn, endpoint đến hạn xoá cứng |
| `admin.approvals.purge` | `15 4 * * *` UTC | xoá phê duyệt đã kết thúc quá `ADMIN_APPROVAL_RETENTION_DAYS` |

| Subscriber (consumer) | Nhận | Plan |
|---|---|---|
| `audit.recorder` | `AUDITED_EVENTS` | 6B |
| `integrations.webhook-fanout` | `WEBHOOK_EVENTS` | 6C |
| `files.org-purged` | `tenancy.org.purged@1` | 6A |

**Event mới.** Payload version 1, chỉ id công khai.

| Type | Aggregate | `data` | audit | webhook |
|---|---|---|---|---|
| `files.file.ready` | file | `{ fileId, purpose, sizeBytes, contentType, cause }` | ✓ | ✓ (6A khai; dòng catalog do plan merge sau trong cặp 6A/6C thêm, bảng 4 mục 17) |
| `files.file.rejected` | file | `{ fileId, purpose, reason }` | ✓ | ✗ |
| `files.file.deleted` | file | `{ fileId, purpose }` | ✓ | ✓ (như trên) |
| `files.file.restored` | file | `{ fileId, purpose }` | ✓ | ✗ |
| `integrations.endpoint.created` / `.updated` / `.deleted` / `.enabled` / `.disabled` / `.secret_rotated` | webhook_endpoint | `{ endpointId, urlHost?, eventTypes?, reason? }` | ✓ | ✗ |
| `integrations.delivery.exhausted` | webhook_delivery | `{ deliveryId, endpointId, eventType, eventId }` | ✓ | ✗ |
| `identity.auth_action.attempted` / `.completed` | auth_action | §8.2 | ✓ | ✗ |
| `identity.session.created` | session | `{ userId, sessionId, via }` | ✓ | ✗ |
| `identity.security_notice.recorded` | security_notice | `{ noticeId, userId, kind, ticket, noticeOccurredAt }` | ✓ | ✗ |
| `audit.staff_access.recorded` (6B; r0 là `admin.access.recorded` của 6D) | staff_access | `{ method, route, params, credentialKind }` (r2: `params` là mọi path param, addendum 3D §A3) | ✓ | ✗ |
| `admin.kill_switch.changed` | kill_switch | `{ key, killed }` | ✓ | ✗ |
| `admin.approval.requested` / `.approved` / `.rejected` / `.cancelled` / `.consumed` | admin_approval | `{ approvalId, method, path }` | ✓ | ✗ |

Cột "audit" và "webhook" là giá trị của hai cờ **bắt buộc** (per R-X3): ✗ nghĩa là khai `false` tường minh.

Không có event cho `EXPIRED` của file (suy ra từ thời gian, như SP3 §14.1). Không có event cho việc dọn object sau purge: `tenancy.org.purged` đã hàm ý việc đó, và metric và log ghi kết quả.

---

## 11. Config

Tất cả qua `defineConfig` + zod, `.env.example` sinh lại bằng `pnpm env:example`. Mọi mặc định khởi động được ở cả ba `AUTH_MODE` với env hiện có (nguyên tắc INT-I12 của SP3). Riêng `FILES_S3_BUCKET` bắt buộc khi module files được bật với driver `s3`; compose, test env và smoke env đặt giá trị này.

### 11.1 `flags` và `partitions` (core)

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `FLAGS_REFRESH_INTERVAL_MS` | `5000` | 1000–60000 |
| `PARTITIONS_MAINTAIN_CRON`, `_TZ` | `30 0 * * *`, `UTC` | cron/tz hợp lệ |

### 11.2 `files`

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `FILES_DRIVER` | `s3` | `s3` \| `local`; **production:** chỉ `s3` |
| `FILES_S3_ENDPOINT` | trống (AWS) | URL; **production:** `https` |
| `FILES_S3_PUBLIC_ENDPOINT` | = endpoint | URL dùng để presign cho client; **production:** `https`, host khác host của `AUTH_BASE_URL` và không thuộc `AUTH_COOKIE_DOMAIN` |
| `FILES_S3_REGION` | `us-east-1` | |
| `FILES_S3_BUCKET` | — | bắt buộc khi `s3` |
| `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` | trống | **secret**, `.meta({ secret: { roles: ['api', 'worker'] } })` (per R-X16; api presign và nhận upload qua API, worker xử lý và dọn). Trống thì dùng credential chain mặc định (IAM role), nên không luật nào đòi chúng; migrate không nạp namespace `files` (SP7 S7-D25) |
| `FILES_S3_FORCE_PATH_STYLE` | `false` | MinIO: `true` |
| `FILES_S3_TIMEOUT_MS`, `FILES_S3_MAX_ATTEMPTS` | `10000`, `3` | |
| `FILES_PRESIGNED_POST` | `true` | `false` với provider không có POST policy (R2): upload trực tiếp đi multipart |
| `FILES_PUBLIC_BASE_URL` | trống | bắt buộc khi có purpose `PUBLIC`; **production:** `https` |
| `FILES_PUBLIC_CACHE_MAX_AGE_SEC` | `86400` | |
| `FILES_LOCAL_ROOT` | trống | bắt buộc khi `local`; đường dẫn tuyệt đối |
| `FILES_UPLOAD_URL_TTL_SEC` | `600` | 60–3600 (phụ lục B: 10 phút) |
| `FILES_DOWNLOAD_URL_TTL_SEC` | `300` | 30–3600 (phụ lục B: 5 phút) |
| `FILES_PENDING_TTL_SEC` | `86400` | ≥ `FILES_UPLOAD_URL_TTL_SEC` (phụ lục B: 24 giờ) |
| `FILES_DIRECT_MAX_BYTES` | `104857600` | ≤ 5 GiB (phụ lục B: 100 MB) |
| `FILES_MULTIPART_MAX_BYTES` | `5368709120` | ≤ 5 TiB; ≥ direct (phụ lục B: 5 GB) |
| `FILES_API_UPLOAD_MAX_BYTES` | `20971520` | (phụ lục B: 20 MB) |
| `FILES_MULTIPART_PART_SIZE_BYTES` | `16777216` | 5 MiB–5 GiB, và `MAX_BYTES / PART_SIZE ≤ 10000` |
| `FILES_MULTIPART_PRESIGN_BATCH_MAX` | `100` | 1–1000 |
| `FILES_ATTACHMENT_MAX_BYTES` | `104857600` | giới hạn của purpose `files.attachment` |
| `FILES_MAX_PENDING_PER_ORG` | `100` | 1–10000 |
| `FILES_ORG_STORAGE_LIMIT_BYTES` | `1073741824` (1 GiB, rulings C4; hằng `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES`, export ở `files/index.ts`) | `0` = không giới hạn. Chỉ dùng khi **không** có provider `FileStorageLimit` (SP4 tắt). Có provider mà env được đặt tường minh → boot WARN `files_storage_limit_env_ignored` (hạn mức lấy từ gói). SP4 test ST-3 so `FILES_STORAGE_FALLBACK_BYTES` của SP4 với hằng này |
| `FILES_SCAN` | `off` | `off` \| `clamd` |
| `FILES_CLAMD_HOST`, `FILES_CLAMD_PORT`, `FILES_CLAMD_TIMEOUT_MS` | trống, `3310`, `60000` | bắt buộc khi `clamd` |
| `FILES_SCAN_MAX_BYTES` | `26214400` | phải ≤ `StreamMaxLength` của clamd (README) |
| `FILES_TEXT_SAMPLE_BYTES` | `65536` | |
| `FILES_PUBLIC_RECHECK_SEC` | `300` | 60–3600; luật `FILES_PUBLIC_RECHECK_SEC × 1000 > 2 × FILES_S3_TIMEOUT_MS × FILES_S3_MAX_ATTEMPTS` (hai lần `CopyObject` của P6 luôn xong trước lượt hai của sweep, R6-5) |
| `FILES_PROCESSING_LEASE_SEC`, `FILES_PROCESSING_STUCK_SEC`, `FILES_PROCESSING_MAX_ATTEMPTS` | `300`, `900`, `5` | `STUCK > LEASE` |
| `FILES_DELETED_RETENTION_SEC`, `FILES_TERMINAL_ROW_RETENTION_SEC` | `2592000`, `604800` | |
| `FILES_ORG_PURGE_RECHECK_SEC` | `3600` | > `FILES_PROCESSING_LEASE_SEC` |
| `FILES_SWEEP_CRON`, `_TZ`, `_BATCH_SIZE`, `_MAX_BATCHES`, `FILES_SWEEP_RETRY_SEC` | `*/15 * * * *`, `UTC`, `100`, `20`, `600` | |

### 11.3 `audit`

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `AUDIT_RETENTION_MONTHS` | `13` | 6–120 (sàn = hằng `AUDIT_RETENTION_MIN_MONTHS` trong hàm SQL, test A-10). Mặc định theo rulings C1 |
| `AUDIT_PARTITION_PREMAKE_MONTHS` | `3` | 1–12 |

Chống ghi trùng khi giao lại dựa vào luật `outbox-retention` sẵn có của core (§6.4); audit không thêm luật riêng.

### 11.4 `integrations`

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `INTEGRATIONS_MAX_ENDPOINTS_PER_ORG` | `10` | 1–100 |
| `INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT` | `50` | 1–`WEBHOOK_EVENT_TYPES_MAX` (50, hằng định dạng của schema/OpenAPI); chỉ hạ trần lúc chạy |
| `INTEGRATIONS_WEBHOOK_TIMEOUT_MS` | `5000` | 1000–30000; < `INTEGRATIONS_DELIVERY_LEASE_MS` |
| `INTEGRATIONS_DELIVERY_LEASE_MS` | `60000` | |
| `INTEGRATIONS_RETRY_SCHEDULE_SEC` | `5,300,1800,7200,18000,36000,36000` | 1–20 phần tử, mỗi phần tử 1–86400 (8 lần thử, khoảng 27,5 giờ, theo lịch tham khảo của Standard Webhooks/Svix) |
| `INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC` | `432000` (5 ngày) | ≥ tổng lịch retry |
| `INTEGRATIONS_SECRET_ROTATION_OVERLAP_SEC` | `86400` | 0–604800 |
| `INTEGRATIONS_DELIVERY_RETENTION_MONTHS` | `1` | 1–24 |
| `INTEGRATIONS_ENDPOINT_PURGE_DELAY_SEC` | `5356800` (62 ngày) | ≥ `(RETENTION_MONTHS + 1) × 31` ngày |
| `INTEGRATIONS_RECOVER_BATCH_MAX` | `1000` | |
| `INTEGRATIONS_KILLED_RECHECK_SEC` | `60` | |
| `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC` | `30` | 1–3600; hẹn lại sau lỗi của ta và sau claim bị từ chối vì endpoint đủ in-flight (§7.2) |
| `INTEGRATIONS_MAX_LOCAL_FAILURES` | `5` | 1–100; lỗi của ta thứ N → `EXHAUSTED` (R-X35, §7.2) |
| `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` | `4` | ≥ 1; **luật config** `< INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT` (bằng hoặc hơn thì một endpoint chết vẫn chiếm hết bulkhead) (R-X35, §7.2). Claim chờ khoá dòng endpoint vẫn giữ một kết nối pool: với mặc định `QUEUE_IO_CONCURRENCY` 20 và `DB_POOL_MAX` 10, đặt `DB_POOL_MAX` ≥ concurrency của `webhooks-out` + dư cho relay. Không có rủi ro deadlock, chỉ áp lực pool ngắn |
| `INTEGRATIONS_PARTITION_PREMAKE_MONTHS` | `3` | 1–12; số partition tháng tới của hai bảng webhook (`definePartitionedTable` đòi `premakeMonths`) |
| `INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT`, `INTEGRATIONS_WEBHOOK_BULKHEAD_QUEUE` | `20`, `100` | `bulkheadLimit`/`bulkheadQueue` của provider `webhooks-out`. **Luật config** `webhooks-bulkhead-covers-concurrency`: `bulkheadLimit ≥ QUEUE_CONCURRENCY_OVERRIDES['webhooks-out'] ?? QUEUE_IO_CONCURRENCY` (mặc định 20 ≥ 20, đối chiếu `queue.config.ts`). Mỗi job gửi đúng một request, nên với luật này một process không bao giờ nhận `bulkhead_full` |
| `INTEGRATIONS_SWEEP_CRON`, `_TZ`, `_BATCH_SIZE`, `_MAX_BATCHES`, `_GRACE_SEC` | `*/5 * * * *`, `UTC`, `100`, `20`, `120` | |
| `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG` | `100` | 1–1000; delivery mất job, lease hết hạn, endpoint đến hạn xoá cứng xử lý mỗi org mỗi lượt (§8.3 "Sweep") |

### 11.5 `admin`

| Env | Mặc định | Ràng buộc |
|---|---|---|
| `ADMIN_DUAL_CONTROL` | `off` | `off` \| `on`. Ở `AUTH_MODE=external` chỉ phần route Nest (`@RequiresApproval()`) có tác dụng, vì không có `/admin/*` của Better Auth; r0 cấm `on` ở external, r1 bỏ luật đó |
| `ADMIN_APPROVAL_TTL_SEC` | `3600` | 300–86400 |
| `ADMIN_APPROVAL_RETENTION_DAYS` | `90` | |
| `ADMIN_APPROVALS_PURGE_CRON`, `_TZ` | `15 4 * * *`, `UTC` | |

**Luật production:**
- driver `s3`;
- mọi URL `https`;
- `FILES_S3_PUBLIC_ENDPOINT` không cùng host hay cookie domain với API;
- `RESILIENCE_ALLOWED_SCHEMES` chỉ `https` (đã có).

**Hằng định dạng (không phải config):**
- `WEBHOOK_SECRET_BYTES = 32`, `WEBHOOK_BODY_MAX_BYTES = 262144`, `WEBHOOK_USER_AGENT = '<APP_SERVICE_NAME>-webhooks/1'`;
- `CLEAN_SUFFIX`, `THUMBNAIL_SUFFIX`, `PUBLIC_PREFIX`;
- `FILE_TYPE_SAMPLE_BYTES = 4100`;
- `AUDIT_RETENTION_MIN_MONTHS = 6`;
- `DEFINER_LIMIT_MAX = 1000`, `PURGE_CURSOR_START` (core, chuyển từ tenancy);
- `ADMIN_APPROVAL_SECRET_FIELDS = ['password', 'newPassword']`, `ADMIN_APPROVAL_EXEMPT_PATHS` (identity, §8.4);
- `STORED_BYTES_SQL` (files, §6.3);
- `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES = 1073741824` (files, mặc định của env cùng tên gốc; export cho ST-3 của SP4).

---
## 12. Bảo mật và mô hình đe doạ

### 12.1 Kẻ tấn công trong phạm vi

| # | Kẻ tấn công | Mục tiêu | Chặn bằng |
|---|---|---|---|
| T1 | Member hoặc org key có `files.write` | XSS qua file tải lên: HTML/SVG, polyglot, MIME giả | Kiểu dò bằng magic bytes theo allowlist của purpose; SVG/HTML/XML/JS bị cấm cứng; tải về luôn `attachment` + `Content-Type` đã dò; phục vụ từ domain storage (khác API, không có cookie; luật production); driver local thêm `nosniff` + CSP `sandbox` |
| T2 | Như T1 | Ảnh bom giải nén, file làm crash thư viện giải mã | Boilerplate không giải mã ảnh (sanitizer mặc định no-op, per R-X9), nên v1 không có bề mặt này. Adapter do dự án thêm phải tự giới hạn pixel và byte trước khi giải mã (hợp đồng port, README). Chung cho mọi trường hợp: tối đa `FILES_PROCESSING_MAX_ATTEMPTS` lần xử lý (poison pill); không bao giờ phục vụ file chưa `READY` |
| T3 | Như T1 | Phát tán malware cho user khác | ClamAV khi bật: fail closed, file không `READY` nếu chưa quét; quét lại khi khôi phục. Khi tắt: `scan_result = NOT_SCANNED` hiện trong API để client quyết định |
| T4 | Như T1 | Vượt quota, làm đầy storage (tốn tiền) | Dòng `PENDING` được tính theo `sizeBytes` khai báo ngay lúc tạo, dưới khoá org; dung lượng tính mọi biến thể đang lưu (§6.3); storage ép kích thước (POST policy) hoặc kiểm bằng `HeadObject`; giới hạn số upload `PENDING`; sweep xoá object hết hạn |
| T5 | User của org khác | Đọc hoặc ghi file, audit, webhook của org khác (IDOR) | Org lấy từ path + RLS + `404` thống nhất (SP3); token upload/download mã hoá bằng AES-GCM, AAD cố định, gắn cả `orgId` và `fileId`; object key chỉ sinh ở server |
| T6 | Kẻ lấy được URL presigned (log proxy, lịch sử trình duyệt), hoặc chính người upload | Tải file; ghi đè nội dung đã quét bằng nội dung độc (TOCTOU) | Hạn ngắn (5 và 10 phút). URL upload chỉ ghi được **vùng nhận** `.upload` với đúng kích thước; server sao sang key gốc bằng `CopySourceIfMatch` rồi mới quét và phục vụ key gốc. Ghi đè vùng nhận sau đó không đổi được gì đang được phục vụ (R6-27) |
| T7 | Admin của org khách (đăng ký endpoint) | SSRF vào mạng nội bộ, metadata cloud | `UrlGuard` lúc đăng ký + `ssrfLookup` lúc connect (chặn DNS rebinding); không theo redirect; allowlist port; production chỉ `https`; giới hạn kích thước response; route đòi session mới, key không dùng được (`webhooks.write` không `apiKeyEligible`) |
| T8 | Kẻ giả mạo bên gửi webhook | Gửi webhook giả tới khách | HMAC-SHA256 theo Standard Webhooks, kèm timestamp; secret 256 bit, mã hoá ở DB, chỉ hiện một lần; xoay có chồng lấn |
| T9 | Kẻ giữ session nhân viên chưa step-up TOTP (cookie bị đánh cắp, IdP, backup code) | Dùng route admin, đọc dữ liệu xuyên tenant | `@PlatformStaffAction()` của 3D (dấu TOTP tươi; per R-X2); inventory lúc boot bảo đảm **mọi** route `/v1/admin/**` mang decorator đó (A-26) |
| T10 | Platform admin đang giữ factor, lạm quyền có chủ đích (SP3 SEC-M13) | Chiếm tài khoản owner, nâng quyền, mạo danh user, đọc dữ liệu | Audit **trước** khi thao tác (fail closed) cho mọi `/admin/*` và mọi route `/v1/admin/**` ở mọi module; truy cập vào org nằm trong audit của chính org (owner thấy được); phê duyệt hai người mặc định-từ-chối cho mọi `/admin/*` không nằm trong danh sách miễn, gồm `impersonate-user`, và cho route Nest có `@RequiresApproval()` (khi bật); metric + cảnh báo |
| T11 | SQLi dưới `app_user` | Xoá dấu vết, drop audit, tăng retention | Không có quyền `UPDATE/DELETE/TRUNCATE` trên audit; trigger chặn; hàm partition có sàn retention cứng; hàm definer chỉ trả id org và tên org |
| T12 | Tên file độc | Chèn header qua `Content-Disposition`, path traversal | `CHECK` không có ký tự điều khiển và không có `/`, `\`; mã hoá RFC 5987; tên không bao giờ vào key hay đường dẫn |

### 12.2 Ngoài phạm vi (ghi rõ)

- Người có credential S3/CDN, credential DB `app_owner` hoặc superuser: họ sửa được mọi thứ, gồm audit. Audit **không** chống giả mạo bằng mật mã (không có chuỗi băm). Kẻ có SQLi dưới `app_user` vẫn **chèn** được dòng audit giả, dù không xoá hay sửa được dòng thật (mục 20.1).
- Lỗ hổng zero-day của clamd, hoặc của thư viện ảnh trong adapter do dự án thêm. Chỉ được giảm bằng giới hạn kích thước; chưa có sandbox.
- Malware mà signature của ClamAV không nhận ra.
- Bảo mật phía người nhận webhook (khách phải tự verify chữ ký).
- Cấu hình sai bucket (ACL public) hoặc CDN. README có policy mẫu và IAM theo prefix.

### 12.3 IAM S3 theo quyền tối thiểu (README)

| Process | Quyền trên bucket |
|---|---|
| api | `s3:PutObject` (để URL presign có hiệu lực), `s3:GetObject`, `s3:CreateMultipartUpload`, `s3:ListMultipartUploadParts`, `s3:CompleteMultipartUpload`, `s3:AbortMultipartUpload` trên `*/*`. Không có quyền xoá hay liệt kê |
| worker | Toàn bộ quyền của api, cộng `s3:DeleteObject`, `s3:ListBucket` (liệt kê theo prefix), `s3:ListBucketMultipartUploads`, và `CopyObject` (vùng nhận → key gốc; object phục vụ → `public/*`) |
| CDN origin | Chỉ `s3:GetObject` trên `public/*` |

- Bucket nên có lifecycle `AbortIncompleteMultipartUpload` (1 ngày), là lưới an toàn thứ hai.
- SDK S3 gọi endpoint lấy từ config bằng HTTP handler của chính nó, không qua `HttpClient`. Đây là **ngoại lệ SSRF có tên** thứ hai, như Better Auth (ADR 0016): URL chỉ đến từ config, production bắt buộc `https`, không bao giờ nhận URL từ tenant.

---

## 13. Race condition đã gọi tên

| # | Tình huống | Cơ chế chặn |
|---|---|---|
| R6-1 | `N + k` lần khởi tạo upload song song vượt quota | `OrgMutationLock` khoá dòng org `FOR NO KEY UPDATE`, rồi `SUM(stored_bytes)`, so hạn mức, `INSERT`, tất cả dưới cùng khoá và cùng transaction. Không phải check-then-insert trần: mọi đường **thêm** dung lượng lúc tạo (khởi tạo upload, `saveGenerated`) đi qua cùng khoá, và `READ COMMITTED` chụp snapshot mới cho câu `SUM` chạy sau khi đã có khoá, nên thấy dòng của transaction vừa commit trước. Đường **giảm** (sweep, purge) không cần khoá. Phần vượt có giới hạn: biến thể ghi ở P5 và bản public ghi ở P6 sau lần kiểm (§6.3), bằng 0 với cấu hình mặc định (sanitizer no-op, purpose có sẵn `files.attachment` là `PRIVATE`) |
| R6-2 | Số upload `PENDING` vượt giới hạn | Đếm dưới cùng khoá của R6-1 |
| R6-3 | Hai lần `complete` song song | CAS `PENDING → PROCESSING`; bên thua đọc lại, trả `200` với trạng thái hiện tại |
| R6-4 | Hai worker xử lý cùng một file (job bị treo rồi được giao lại) | Lease `processing_lease_until` + fencing `processing_attempts` trong CAS commit. Biến thể (`clean`, thumbnail) ghi bằng `IfNoneMatch: '*'` (spike F3): lần ghi đầu thắng, lần sau nhận `412` và dùng lại object đã có, nên ghi muộn không đổi nội dung đã commit. Không còn dựa vào output tất định của thư viện ảnh (r0 dựa vào `sharp`) |
| R6-5 | Xoá (hoặc từ chối) file đua với bước P6 (sao sang public), kể cả khi bản sao tới **sau** lượt sweep đầu | Ba lớp. (1) Ghi ý định `published_at` bằng CAS **trước** khi sao: xoá trước (a) thì không sao. (2) P6 đọc lại dòng **sau** khi sao xong, dòng không còn `PROCESSING` cùng attempt thì tự xoá bản public. (3) Sweep gỡ bản public hai lượt: lượt hai chạy ở `published_at + FILES_PUBLIC_RECHECK_SEC`, mốc mà mọi lần sao của ý định đó đã xong (luật config §11.2), và chỉ lượt hai mới xoá `published_at`. Thứ tự lọt của review (P6 ghi ý định → xoá → sweep gỡ khi chưa có gì → bản sao tới) bị lớp (2) bắt, và lớp (3) bắt nếu worker chết giữa sao và đọc lại. Còn lại có tên: worker bị **đóng băng** (không chết) giữa (a) và (b) lâu hơn `FILES_PUBLIC_RECHECK_SEC` rồi chết đúng sau khi sao, trước khi đọc lại. Khi đó bản public sống tới lượt xoá hẳn (`FILES_DELETED_RETENTION_SEC`, luôn gỡ `public/…` bất kể cờ). Nội dung đó đã qua quét |
| R6-6 | Khôi phục đua với sweep xoá hẳn | Hai vị từ bù nhau trên `deleted_at` so với `clock_timestamp() - retention`; thời gian đơn điệu, nên đã qua mốc thì khôi phục không bao giờ thắng |
| R6-7 | Purge org đua với job files đang chạy | Job `'skip'` bị gate bỏ qua sau purge (`GONE`); job đang chạy dở ghi object sau khi lần xoá đầu đã liệt kê → lần `RECHECK` (trễ > lease) xoá nốt |
| R6-8 | Trùng object key | UUID v7 sinh ở server + `UNIQUE (object_key)` |
| R6-9 | Claim delivery đua với sweep lấy lại lease | CAS claim trên trạng thái + lease; CAS kết quả có fencing `attempts_total` |
| R6-10 | Tắt hoặc xoá endpoint trong lúc đang gửi | Claim kiểm trạng thái endpoint; lần gửi đang chạy vẫn hoàn tất (trễ tối đa một lần gửi, như SP3 T-17) |
| R6-11 | Xoay secret đúng lúc đang ký | Secret được đọc lúc claim; secret cũ còn hạn trong thời gian chồng lấn |
| R6-12 | Nhiều lần thất bại song song cùng tự tắt một endpoint | `COALESCE(failing_since, now())` nguyên tử; CAS `WHERE status = 'ACTIVE'` nên chỉ một event |
| R6-13 | Retry thủ công đua với lần thử đang chạy | Chỉ CAS từ `SUCCEEDED/EXHAUSTED/CANCELLED`; đang `SENDING` → `409 webhook_delivery_not_retryable` |
| R6-14 | Recover đua với retry | Cùng CAS; mỗi dòng tăng chu kỳ đúng một lần |
| R6-15 | Fan-out chạy hai lần cho cùng một event | Inbox `(integrations.webhook-fanout, event_id)` trong cùng transaction |
| R6-16 | Audit ghi hai lần | Inbox `(audit.recorder, event_id)` |
| R6-17 | Hai lượt bảo trì partition chạy cùng lúc | `pg_try_advisory_xact_lock(lockKey)` trong hàm; lượt thứ hai là no-op (spec cha §5: việc chỉ một instance làm) |
| R6-18 | Hai request cùng tiêu thụ một phê duyệt | Một câu `UPDATE … WHERE status = 'APPROVED' … RETURNING`: đúng một request thắng (D-21 lặp 50 lần) |
| R6-19 | Người xin tự duyệt | `WHERE requested_by <> $approver` + `CHECK` bốn mắt |
| R6-20 | Hai `PUT` kill switch đồng thời | `If-Match` theo version (`412`) |
| R6-21 | Thao tác admin chạy khi ghi audit lỗi | Ghi `attempted` (hook) / `audit.staff_access.recorded` (port của `@PlatformStaffAction()`) **trước** thao tác, commit riêng; lỗi → `503`, thao tác không chạy |
| R6-22 | Marker `operator_reset` bị `CASCADE` (user bị xoá) trước khi cron phát audit | **Chấp nhận có tên:** cửa sổ bằng `AUTH_SECURITY_NOTICE_RECONCILE_GRACE_SEC` + chu kỳ cron; log WARN `identity_staff_2fa_reset` của lệnh vẫn mang ticket (SP3 ranh giới vi) |
| R6-23 | Session tạo xong nhưng phát audit đăng nhập lỗi hoặc process chết | **Chấp nhận có tên** (S6-A31): metric `identity_audit_publish_failed_total{kind="session"}`; đăng nhập không phải thao tác đặc quyền |
| R6-24 | (r0) SQL trực tiếp làm lệch bộ đếm quota | **Không còn áp dụng ở r1:** không có bộ đếm; dung lượng luôn tính từ chính dòng `files` (per R-X8) |
| R6-25 | Xoá endpoint đua với fan-out | Delivery tạo cho endpoint vừa bị xoá mềm sẽ bị `CANCELLED` lúc claim. Xoá cứng đua fan-out (R-X33, không FK): fan-out giữ dòng endpoint `FOR KEY SHARE`; sweep `FOR UPDATE SKIP LOCKED` rồi `NOT EXISTS` bằng câu riêng, nên không bao giờ xoá endpoint dưới delivery vừa chèn; test bất biến "mọi delivery có endpoint" |
| R6-26 | Tạo endpoint vượt giới hạn song song | `OrgMutationLock` (khoá dòng org, cùng thứ tự khoá của SP3 §3.14) + đếm dưới khoá |
| R6-28 | Lỗi của ta (bulkhead, breaker, worker chết, secret không giải mã được) đua với lịch retry và tự tắt endpoint | `classifyAttempt` (§7.2): lỗi của ta không chạm `failing_since` và dời `cycle_base` cùng lúc với `attempts_total` trong cùng CAS có fencing, nên số bước lịch đã tiêu không đổi và endpoint khoẻ không bao giờ bị tự tắt vì tải của khách khác (W-34); `local_failures + 1` cùng CAS, trần `INTEGRATIONS_MAX_LOCAL_FAILURES` (R-X35). Hai claim cùng endpoint vượt trần in-flight: khoá dòng endpoint rồi đếm bằng câu riêng (§7.2) |
| R6-29 | Hai phê duyệt cùng request, hoặc route admin mới quên decorator | Mỗi phê duyệt tiêu thụ độc lập bằng CAS (R6-18); route quên `@PlatformStaffAction()` làm app không khởi động (A-26), nên không có cửa sổ runtime |
| R6-27 | Client (còn URL upload hợp lệ) ghi đè object trong lúc hoặc sau khi server đã quét (TOCTOU) | Client chỉ ghi được vùng nhận `.upload`. Server sao sang key gốc bằng `CopyObject` với `CopySourceIfMatch` = ETag đã kiểm, nên bản sao đúng là bản đã kiểm size. Mọi bước sau chỉ đọc và phục vụ key gốc. Test F-24: ghi đè vùng nhận giữa P1 và P4 (seam), và ghi đè sau `READY` → nội dung phục vụ không đổi |

---

## 14. Chế độ lỗi

| Lỗi | Hành vi | Tự phục hồi |
|---|---|---|
| S3 sập hoặc chậm | Khởi tạo upload vẫn chạy (presign tính cục bộ, trừ `CreateMultipartUpload` → `502`/`504`); `complete` → `502`/`504`, file giữ `PENDING`; job xử lý retry | Client gọi lại `complete`; sweep enqueue lại job bị kẹt |
| clamd sập | Job ném, file giữ `PROCESSING`, không bao giờ `READY` khi chưa quét | Retry theo backoff và sweep; alert `files_processing_oldest_seconds` |
| Adapter ảnh (của dự án) làm chết process | BullMQ phát hiện job stalled và giao lại | Claim lần thứ `MAX + 1` → `REJECTED(PROCESSING_FAILED)` |
| Sanitizer no-op khi có purpose `imagePolicy = SANITIZE` | Ảnh được phục vụ nguyên bản, `sanitized = false`; boot WARN `image_sanitizer_noop` một lần | Dự án thêm adapter (mục 2.2) |
| Redis sập | Enqueue đi qua outbox (`SafeEnqueue`) | Relay đẩy lại khi Redis lên |
| DB sập | `503` | — |
| Partition tháng sau chưa được tạo (cron bảo trì hỏng) | Chèn audit/webhook lỗi, deliver retry | Premake 3 tháng cho ra 2–3 tháng dự phòng; alert khi `db_partition_months_ahead < 2` |
| Endpoint webhook chậm | Timeout 5 s mỗi lần gửi; mỗi job chiếm một slot của queue `webhooks-out` (concurrency 20 mặc định) trong tối đa 5 s | Lịch retry; endpoint tự tắt sau 5 ngày; W-46 đo độ trễ gây ra cho endpoint khác |
| Lỗi của ta khi gửi (bulkhead đầy, worker chết giữa lần gửi, secret không giải mã được) | Không tiêu lịch, không đặt `failing_since`; hẹn lại sau `INTEGRATIONS_LOCAL_FAULT_RETRY_SEC`; lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED` | Sửa nguyên nhân rồi `retry`/`recover`; cảnh báo `webhook_local_faults_total` |
| `FieldCipher` không có `kid` của secret (khoá bị retire sai) | Lỗi của ta `SECRET_UNAVAILABLE` (R-X35), có đếm, ghi ngay trong transaction claim, log ERROR `webhook_secret_unreadable`, không gửi; lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED` (sửa theo review plan 6C) | Sửa keyring (thêm lại kid hoặc mã hoá lại secret theo runbook xoay khoá của SP7), rồi `recover`; cảnh báo `webhook_local_faults_total{reason="secret_unavailable"}` |
| Không giải mã được token upload/download | `404 not_found` | — |
| Endpoint trả body khổng lồ | `TOO_LARGE`, socket bị huỷ ở `maxResponseBytes` | Tính như lần thử thất bại |
| Hook `after` ghi `completed` lỗi | Response giữ nguyên; dòng `attempted` không có cặp | Metric `identity_audit_publish_failed_total{kind="completed"}`; truy vấn audit ghép cặp theo `attemptId` tìm được lần thiếu |

---

## 15. Observability (không PII)

**Span:** `files.upload.initiate`, `files.upload.complete`, `files.process` (thuộc tính: `files.result`, `files.mode`), `files.sweep.org`, `files.purge_org_objects`, `audit.record`, `integrations.fanout`, `integrations.deliver` (`webhook.result`, `webhook.error`), `admin.approval.consume`, `core.partitions.maintain`. Không có org, user, URL hay tên file.

**Metric** (label là enum hữu hạn, không `orgId`):
- **Files:**
  - `files_uploads_initiated_total{mode}`, `files_processed_total{result}` (`ready` hoặc lý do `REJECTED`), `files_processing_duration_seconds`, `files_processing_oldest_seconds` (gauge);
  - `files_scan_total{result}` (`clean`, `infected`, `error`, `skipped`), `files_sweep_actions_total{action}`, `files_org_objects_purged_total`, `files_storage_quota_exceeded_total`, `files_storage_used_query_seconds` (thời gian câu `SUM` dưới khoá, để thấy sớm khi F-32 không còn đúng với dữ liệu thật).
- **Audit:** `audit_records_total{scope}` (`org`, `platform`), `db_partition_months_ahead{table}`, `db_partition_maintain_total{table, action}`.
- **Identity** (6B):
  - `identity_auth_actions_total{path_group, outcome}`, với `path_group` ∈ `privilege` (set-role, set-user-password, create-user, update-user, remove-user, unban-user), `admin_read`, `admin_other`, `api_key`;
  - `identity_audit_publish_failed_total{kind}`.
- **Webhook:** `webhook_deliveries_total{result}`, `webhook_delivery_attempt_duration_seconds`, `webhook_deliveries_exhausted_total`, `webhook_endpoints_auto_disabled_total`, `webhook_delivery_lag_seconds` (từ lúc tạo tới lần thành công), `webhook_local_faults_total{reason}` (`bulkhead_full`, `circuit_open`, `lease_expired`).
- **Admin:** `admin_requests_total{route_group}`, `admin_approvals_total{transition}`, `admin_approval_consume_total{result}`, `audit_staff_access_total{scope}` (`org`, `platform`).
- **Core:** `flags_refresh_failures_total`, `flags_snapshot_age_seconds`, `org_sweep_orgs_enqueued_total{key}`, `org_sweep_backlog_total{key}`, `org_sweep_duration_seconds{key}`.

**Cảnh báo** (runbook ở README, spec cha §12):
- `identity_auth_actions_total{path_group="privilege"}` tăng: mức info, có trang runbook "thao tác quyền nền tảng", đối chiếu với ticket;
- `db_partition_months_ahead < 2`: page;
- `files_processing_oldest_seconds > 3600`;
- tỉ lệ `webhook_deliveries_exhausted_total` tăng vọt;
- `webhook_local_faults_total > 0` kéo dài (lỗi của ta, không phải của khách);
- `org_sweep_backlog_total` tăng;
- `identity_audit_publish_failed_total > 0`;
- `flags_snapshot_age_seconds > 10 × FLAGS_REFRESH_INTERVAL_MS`.

**Log:**
- WARN `file_infected { fileId, signature }`, `webhook_ssrf_blocked { endpointId }`, `admin_approval_invalid { approvalId? }`;
- ERROR `webhook_body_too_large { eventType }`;
- INFO `partition_created`/`partition_dropped { table, partition }`;
- không bao giờ log tên file gốc, URL endpoint, body webhook, `reason` của phê duyệt, ticket, `request_spec`.

---

## 16. Chiến lược test

Tầng test theo SP3 §18.0: kiểm mỗi bất biến ở tầng rẻ nhất chứng minh được nó. Integration dùng Postgres + Redis + MinIO thật (`@testcontainers/minio`). ClamAV trong CI dùng **clamd giả** (server TCP trả đúng giao thức `INSTREAM`); clamd thật (`clamav/clamav`) chạy ở job hằng đêm, vì image nặng và phải tải signature.

**Core (6.0):**
- C-1: cờ `audit`/`webhook` được lưu trên def; thiếu cờ là lỗi compile (test type-level bằng `// @ts-expect-error`); giá trị không phải boolean → ném lúc định nghĩa; mọi `defineEvent` đang có trong `src/` và `test/` khai đủ hai cờ (quét registry sau khi import mọi module).
- C-2: subscriber bộ chọn nhận **mọi** def khớp. Một module fixture định nghĩa event sau các module khác trong cây import mà vẫn được nhận, vì mọi `defineEvent` chạy lúc import, trước `onModuleInit`.
- C-3: deliver với row có type không thuộc tập của subscriber → lỗi; payload sai schema → `JobPayloadError`. Mọi def `webhook: true` phải là event theo org (unit, quét registry).
- C-4: subscriber một-event cũ vẫn chạy (không hồi quy).
- C-5: bảng partitioned fixture:
  - `maintain` tạo đủ số partition premake;
  - drop đúng partition hết hạn, **không** drop partition ở mốc N−1;
  - `p_retention_months` dưới sàn → `RAISE`;
  - hai lời gọi song song → một lời gọi no-op;
  - `app_user` đọc thẳng partition → `42501`;
  - trigger append-only bắn trên partition;
  - tên partition lạ → `RAISE`;
  - mức khoá đúng như spike P1.
- C-6: luật catalog cho bảng partitioned và partition; ma trận role mới.
- C-7: hai chủ body parser: prefix trùng hoặc lồng → không khởi động; byte của prefix đã đăng ký không bị core đọc; `ContentTypeMiddleware` chỉ nhận `contentTypes` của prefix; mọi test mount của SP2 vẫn xanh.
- C-8 (`core/sweep`, R-X4): hàm definer fixture trả `3 × size + 1` org → runner đi đủ bốn lô theo keyset, enqueue đúng một job mỗi org; chạy lại trong cùng slot → không có job mới (`jobId` trùng); slot sau → job mới; một job theo org `failed` không chặn org đó ở slot sau; chạm `maxBatches` với lô đầy → WARN `org_sweep_backlog`; `definerFunction`/`jobIdPrefix` sai dạng → ném lúc định nghĩa; tên trong `extraParams` sai dạng, trùng `p_after`/`p_limit`, hoặc số không nguyên → `OrgSweepDefinitionError`, không enqueue gì; Redis lỗi giữa lô → job quét ném và lần retry không tạo job trùng. Đi qua `JobQueue` và worker thật.
- C-8b (r2, R-X14, review X2-2: test hợp đồng không mock): hàm definer **thật** trong migration fixture (owner `sweep_definer`, `SECURITY DEFINER`) chữ ký `(p_after uuid, p_limit integer, p_min_age_sec integer)` với thân kiểm biên như mẫu SP7 (`p_limit > DEFINER_LIMIT_MAX` → `RAISE`); runner với `extraParams: () => ({ p_min_age_sec: 3600 })` trên DB thật → lô đầu trả đúng org đến hạn và không `RAISE`; đảo thứ tự tham số trong khai báo hàm fixture vẫn chạy đúng (ký hiệu theo tên). Cùng plan có test `org-sweep-signatures.spec.ts`: duyệt registry `defineOrgSweep` của app đã nạp mọi module, với mỗi `definerFunction` đọc `pg_proc` và khẳng định đúng **một** overload, có tham số `p_after uuid` và `p_limit integer`, và mỗi tên của `extraParams()` là một tham số của hàm với kiểu khớp kiểu JS (`integer`/`boolean`/`text`); thêm overload thứ hai, đổi tên hay kiểu một tham số → đỏ. Test này chạy lại ở mọi plan thêm một sweep (6A, 6C, SP5, SP7 7D), nên lỗi chữ ký kiểu X2-2 bị bắt ở CI của chính plan đó.
- C-9: `routeTemplateOf` sau khi chuyển vào core cho đúng kết quả của bộ template mẫu SP3 §7.4 (test cũ của tenancy chạy lại nguyên văn); `DEFINER_LIMIT_MAX`/`PURGE_CURSOR_START` re-export từ tenancy bằng đúng giá trị của core.
- C-20: kill switch:
  - key lạ → ném;
  - đổi ở instance A → instance B thấy trong `FLAGS_REFRESH_INTERVAL_MS + 1 s`;
  - DB lỗi → giữ snapshot cũ;
  - không có dòng → `false`;
  - `OpenFeature.close()` dừng timer (không còn handle mở);
  - version và `If-Match`.
- C-30 (chaos): Toxiproxy cắt DB lúc làm mới flag; chạy bảo trì partition dưới tải chèn (`lock_timeout`, không deadlock).

**Files (6A):**
- F-1: `planUpload` đủ nhánh.
- F-2: định nghĩa purpose chứa kiểu bị cấm → ném; lệch `file_purposes` → không khởi động.
- F-3: máy trạng thái, mọi cặp.
- F-10 (magic bytes): PNG khai báo là PDF → kiểu dò là PNG, nhận nếu có trong allowlist; HTML đổi đuôi `.pdf` → `REJECTED`; SVG luôn `REJECTED`; CSV UTF-8 → `READY`; CSV có byte NUL → `REJECTED`; DOCX/XLSX được `file-type` nhận đúng.
- F-11 (quét):
  - EICAR qua clamd giả → `INFECTED`;
  - clamd giả treo → timeout, file giữ `PROCESSING`, job retry;
  - clamd giả đóng socket → retry;
  - vượt `FILES_SCAN_MAX_BYTES` → `SCAN_SIZE_EXCEEDED`;
  - hằng đêm: EICAR qua clamd thật.
- F-12 (sanitizer no-op, mặc định): JPEG có EXIF → `READY`, `sanitized = false`, object phục vụ là bản gốc giữ nguyên byte, không có thumbnail; boot WARN `image_sanitizer_noop` đúng một lần khi có purpose `SANITIZE`.
- F-13 (hợp đồng port, adapter fixture không phụ thuộc thư viện ảnh): `SANITIZED` → `.clean` và `.thumb.webp` được ghi, `clean_size_bytes`/`thumbnail_size_bytes` đúng, download trả `.clean`; `REJECTED(IMAGE_TOO_LARGE)` và `REJECTED(IMAGE_INVALID)` → file `REJECTED` đúng lý do; object gốc không bao giờ bị ghi đè.
- F-14 (poison): adapter fixture luôn ném → `REJECTED(PROCESSING_FAILED)` sau `MAX` lần.
- F-15 (R6-4, spike F3 giữ lại làm test): hai attempt cùng ghi `.clean` với nội dung khác nhau → object giữ nội dung của lần ghi đầu; attempt sau nhận `412`, đọc `HeadObject` và commit đúng kích thước của object đã có.
- F-16 (R6-4): worker A claim rồi bị treo qua lease; worker B hoàn tất; CAS của A trả 0 dòng.
- F-20 (presigned POST, MinIO): đúng kích thước → được; +1 byte hoặc −1 byte → MinIO từ chối, không có object; key khác → từ chối.
- F-21 (multipart): upload hai part → `complete` → `READY`; tổng khác khai báo → `REJECTED(SIZE_MISMATCH)`, object bị xoá; `complete` khi chưa có part → `409`.
- F-22 (upload qua API):
  - đúng kích thước → `204` → `READY`;
  - body dài hơn → `413`, không có object, không còn multipart dở;
  - `Content-Length` khác khai báo → `400`;
  - token sai, hết hạn, khác org hoặc file không còn `PENDING` → `404` giống hệt nhau;
  - `Content-Type` khác → `415`.
- F-23 (R6-3): `complete` song song ×50 → một lần chuyển, mọi request `200`.
- F-24 (R6-27): ghi đè vùng nhận bằng URL còn hạn, giữa P1 và P4 (seam) và sau `READY` → nội dung được quét và phục vụ vẫn là bản đã sao; `CopySourceIfMatch` sai ETag → lần thử được làm lại.
- F-30 (R6-1, ground truth là storage):
  - chuỗi 500 thao tác ngẫu nhiên (tạo, hoàn tất, từ chối, xoá, khôi phục, publish với purpose `PUBLIC` fixture, adapter fixture sinh biến thể, sweep, purge), rồi chờ pipeline xong và chạy sweep tới khi không còn việc → `Σ stored_bytes` của các dòng còn object **bằng** tổng `Size` mà `ListObjectsV2` trả về dưới `{orgId}/` và `public/{orgId}/`;
  - `N + k` khởi tạo song song với hạn mức vừa đủ `N` → đúng `N` thành công và `k` lỗi `422 quota_exceeded` có `errors[0].code = 'files.storage_bytes'`;
  - `saveGenerated` song song với khởi tạo upload → tổng không vượt hạn mức.
- F-31 (R6-2): số upload `PENDING` không vượt giới hạn khi gửi song song.
- F-32: `EXPLAIN (ANALYZE, BUFFERS)` câu `SUM(stored_bytes)` trên một org có 100.000 file sống (bảng có 10 org như vậy): phải dùng `files_live_bytes_idx`; thời gian ghi vào plan 6A (mục 6.3 "Chi phí của `SUM`").
- F-33 (port `FileStorageLimit`): vắng provider → theo `FILES_ORG_STORAGE_LIMIT_BYTES` (`0` = không giới hạn); provider fixture trả `UNLIMITED` → không chạy câu `SUM`; trả `MAX` → dùng `max` và `featureKey` của provider; có provider mà env được đặt → WARN.
- F-34 (r2, R-X13; test đi cùng code, **4B** thêm): child process, `loadedModules()` có `entitlements` mà không có provider `FileStorageLimit` → api và worker không khởi động, log ERROR `file_storage_limit_adapter_missing`; `entitlements` không nạp → khởi động với mặc định config; có provider (adapter thật của SP4) → khởi động.
- F-40: `PENDING` hết hạn → `EXPIRED` → object và multipart bị xoá → sau `TERMINAL_ROW_RETENTION` dòng bị xoá (đồng hồ điều khiển bằng config nhỏ).
- F-41 (R6-6): xoá → khôi phục trong hạn → `READY`; sau hạn → `409`; biên giới hạn giữ được thử bằng một kết nối giữ khoá qua mốc (mẫu SP3 X-11).
- F-42 (public, R6-5; seam `TestHooks` quanh ba bước của P6):
  - `publicUrl` chỉ có sau `READY`; GET qua MinIO trước khi quét xong → `403`/`404`;
  - xoá file `READY` cũ → bản public biến mất sau một lượt sweep (`published_at` cũ hơn `FILES_PUBLIC_RECHECK_SEC`);
  - khôi phục → có lại;
  - xoá chen giữa (a) và (b) → sweep lượt một gỡ khi chưa có gì, bản sao tới sau; bước (c) thấy `DELETED` và tự gỡ → không còn `public/…`;
  - như trên nhưng giết worker giữa (b) và (c) → lượt hai của sweep ở `published_at + FILES_PUBLIC_RECHECK_SEC` gỡ → không còn `public/…`, rồi `published_at = NULL`;
  - xoá sau (c) → sweep gỡ bình thường;
  - file `REJECTED` sau P6 (claim vượt `MAX` trong lúc worker cũ đang sao) → cùng hai lượt, `object_removed_at` chỉ được đặt sau lượt hai.
- F-43: URL tải về từ MinIO có `Content-Type` đã dò, `Content-Disposition` RFC 5987 với tên Unicode; hết hạn sau TTL; biến thể thumbnail.
- F-44: driver local chạy **cùng** bộ contract test của port `FileStorage` với S3 (spec cha §4.2); key có `..` không bao giờ được tạo (key sinh ở server; `resolve` kiểm nằm trong root).
- F-45: sau mỗi kịch bản, liệt kê prefix của org test → chỉ còn object của file đang sống.
- F-50 (R6-7):
  - purge org → participant xoá dòng;
  - job xoá mọi object dưới `{orgId}/` và `public/{orgId}/`, huỷ multipart;
  - lần `RECHECK` xoá object do job xử lý dở ghi thêm (seam);
  - chạy lại → no-op;
  - chạy trên org `GONE` (`'run'`).
- F-51: org xoá mềm → job xử lý bị bỏ qua; khôi phục org → sweep enqueue lại.
- F-60: isolation RLS cho `files`.
- F-61: G-6 sinh từ metadata có route files.
- F-62: kill switch `files.uploads` → khởi tạo và `PUT` → `503`.
- F-63: không PII: log của mọi đường lỗi không chứa tên file gốc hay token.
- F-80 (smoke prod-like): `docker compose --profile app` + MinIO, `NODE_ENV=production`, từ host: tạo org → khởi tạo upload `DIRECT_POST` → POST thẳng vào MinIO → `complete` → chờ `READY` → tải qua URL presign (host `FILES_S3_PUBLIC_ENDPOINT`) → xoá → khôi phục.

**Audit (6B):**
- A-1: mỗi event `audit: true` của tenancy, identity và fixture → đúng một dòng; deliver lặp → vẫn một dòng.
- A-2: event theo org → `audit_logs` trong org đó; event nền tảng → `platform_audit_logs`; isolation RLS.
- A-3: `UPDATE`/`DELETE`/`TRUNCATE` bằng `app_user` → lỗi; `UPDATE` qua bảng cha bằng owner → trigger chặn.
- A-4: `actor_user_id` đúng ở local và external; user không có `tenancy_users` → `NULL`.
- A-5: event `tenancy.org.purged` của org đã mất được ghi.
- A-6: bộ lọc, cursor, cursor hỏng → `400 invalid_cursor`; nhiều hơn một bộ lọc chính → `422`; `from`/`to`.
- A-7: `EXPLAIN (ANALYZE, BUFFERS)` bốn truy vấn đọc trên dữ liệu seed 5 triệu dòng, 10.000 org, 13 partition; kết quả ghi vào plan.
- A-10: hằng sàn trong SQL = `AUDIT_RETENTION_MIN_MONTHS`; drop ở biên tháng.
- A-11: xoá partition tương lai (fixture) → chèn lỗi, deliver retry, gauge `< 1`.
- A-20 (L2, L5):
  - mỗi path `/admin/*` với session nhân viên đã step-up → cặp `attempted`/`completed` cùng `attemptId`, actor là nhân viên, `data` không có mật khẩu hay email;
  - Toxiproxy cắt pool app trước hook → `503` và **user đích không đổi** (handler không chạy);
  - user không phải nhân viên gọi `/admin/has-permission` → không có dòng.
- A-21: `/api-key/create`, `update`, `delete` → cặp dòng; `data` không có key.
- A-22 (spike B1 giữ làm test): đăng nhập bằng mật khẩu, bằng Google (mock), qua 2FA → mỗi đường đúng một `identity.session.created` với `via` đúng.
- A-23 (L3):
  - lệnh reset (hàm `runStaffTwoFactorReset` với terminal giả, SP3 S-22) → cron → dòng audit `operator_reset` có ticket;
  - housekeeping xoá marker → dòng audit còn;
  - xoá user trước cron → không có dòng, có log (R6-22, ghi nhận).
- A-24 (X-5): `/admin/remove-user` owner không cuối → `identity.auth_action.*` và `tenancy.member.removed { ACCOUNT_DELETED }` cùng `correlationId`; lọc `?correlationId=` trả cả hai.
- A-25: G-6 có route audit.
- A-26 (`PlatformStaffRouteInventory`, tiêu chí 12): fixture controller `/v1/admin/x` thiếu `@PlatformStaffAction()` → app không khởi động, log liệt kê handler; decorator trên `/v1/other` → không khởi động; có route admin mà `PlatformAccessAudit` không có provider → không khởi động; có route admin mà provider là `NoopPlatformAccessAudit` đăng ký tường minh → không khởi động; fixture chỉ có `SetMetadata(PLATFORM_STAFF_ACTION)` được đọc qua `hasPlatformStaffAction` như có decorator (inventory không đọc khoá thô); boilerplate đủ module → khởi động. Chạy trên tập route **thật** của app (khi SP4 4C, SP5 5B đã merge thì route admin của chúng nằm trong tập này).
- A-27 (port audit truy cập, R6-21): route admin có `:orgId` → một dòng `audit.staff_access.recorded` trong audit của **org đó**, có **trước** khi handler chạy (seam trong handler đọc thấy outbox đã commit), owner đọc được qua `GET /v1/orgs/{orgId}/audit-logs`; route không có `:orgId` → audit nền tảng; Toxiproxy cắt DB trước khi ghi → `503`, handler không chạy; `GET` cũng được ghi.

**Webhook (6C):**
- W-1: `new Webhook(secret).verify(body, headers)` của `standardwebhooks` nhận chữ ký.
- W-2: trong thời gian chồng lấn, header có hai chữ ký và verify đạt với **từng** secret.
- W-3: hết chồng lấn → chỉ còn secret mới.
- W-4: `webhook-timestamp` là giây Unix lúc gửi.
- W-10: receiver fixture trả 500 → retry theo lịch (config lịch ngắn); đúng số lần.
- W-11: hết lịch → `EXHAUSTED` + event.
- W-12: `retry` thủ công → chu kỳ mới.
- W-13: `recover` theo lô, `hasMore`.
- W-14: 429 kèm `Retry-After` được tôn trọng.
- W-15: 302 không được theo, ghi lỗi `REDIRECT`.
- W-16: gửi thử.
- W-20: URL bị từ chối: `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `[::ffff:127.0.0.1]`, `http://user:pw@…`, port `8080`, `http` ở production → `422`.
- W-21: hostname phân giải ra IP private lúc đăng ký → `422`.
- W-22 (DNS rebinding): DNS resolver fixture trả IP public lúc đăng ký, IP private lúc gửi → `SSRF_BLOCKED`, không có kết nối nào tới IP private.
- W-23: redirect về địa chỉ nội bộ không được theo.
- W-24: response vượt `maxResponseBytes` → `TOO_LARGE`.
- W-30: giết worker ngay sau claim → lease hết hạn → sweep → gửi lại; receiver nhận cùng `webhook-id`.
- W-31 (R6-9): worker cũ ghi kết quả sau khi lease đã bị lấy lại → 0 dòng.
- W-32 (R6-12): 20 lần thất bại song song sau ngưỡng → đúng một event `disabled`.
- W-34 (R6-28, phân loại lỗi): unit bảng `classifyAttempt` phủ mọi giá trị `last_error` (thiếu một giá trị là lỗi compile); integration: `HttpClient` giả trả `bulkhead_full` `INTEGRATIONS_MAX_LOCAL_FAILURES − 1` lần liên tiếp cho endpoint khoẻ → `failing_since` vẫn `NULL`, `attempts_total - cycle_base` không đổi, endpoint không bị tự tắt kể cả sau `DISABLE_AFTER` (đồng hồ điều khiển bằng config nhỏ); lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED` (R-X35), endpoint vẫn `ACTIVE`; secret không giải mã được → `SECRET_UNAVAILABLE` có đếm, không gửi; lease hết hạn (giết worker) → `RETRY_SCHEDULED` với `LEASE_EXPIRED`, không tiêu lịch, lần thứ N → `EXHAUSTED`; endpoint treo với nhiều delivery chờ giữ đúng `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` slot, endpoint khoẻ của org khác vẫn gửi được; luật config `webhooks-bulkhead-covers-concurrency` từ chối `bulkheadLimit` nhỏ hơn concurrency.
- W-33: tắt endpoint khi còn delivery chờ → `CANCELLED`; bật lại + `recover` → gửi.
- W-40: fan-out chỉ tới endpoint `ACTIVE` có đăng ký; inbox chặn trùng; org xoá mềm → `tenancy.org.deleted` vẫn tới.
- W-41: participant purge xoá mọi dòng webhook (hai bảng partitioned), đúng thứ tự FK.
- W-42: isolation RLS cho năm bảng.
- W-43: lệch catalog → không khởi động; OpenAPI có mục `webhooks`; fixture đổi phá vỡ schema → `oasdiff` đỏ.
- W-44: bảo trì drop `deliveries` trước `messages` (spike P2).
- W-45: kill switch → không có request ra ngoài; tắt switch → delivery chạy lại.
- W-46: một endpoint chậm (timeout) với 1000 delivery chờ không làm endpoint khác trễ quá `timeout × (chờ / concurrency)` đã tính, với concurrency là giá trị thật của code (`QUEUE_IO_CONCURRENCY` = 20); số đo ghi vào plan.

**Admin (6D):**
- D-1: mọi route của module admin mang `@PlatformStaffAction()` (A-26 chạy trên chúng) và chạy bộ ca `describePlatformStaffActionConformance` của addendum 3D §A5 (C1–C10) cho từng route. Ca DB lỗi của câu dấu TOTP (C11) là test của 3D (PSA-4), không lặp ở đây.
- D-2: `GET /v1/admin/orgs/{orgId}/members` tạo dòng `audit.staff_access.recorded` trong audit của **org đó**, owner đọc được qua API audit của org (dùng port của 6B, như A-27).
- D-3: tìm org theo tiền tố (có `%`/`_` được escape), `includeDeleted`, phân trang; `EXPLAIN` trên 10.000 org.
- D-4 (r2, per R-X16): chi tiết org với composition thật `disable: ['files']` (và riêng `disable: ['integrations']`) trong khi `admin` bật → app khởi động (composition bước 4 của SP7 không báo import module bị tắt), `storageUsedBytes`/`webhookEndpoints` là `null`; hai module bật → số liệu đúng qua token `FileUsageReader`/`WebhookStatsReader` của `core/contracts`.
- D-5: org của một user, ở local và external.
- D-6: kill switch: thiếu `If-Match` → `428`; lệch → `412`; key lạ → `404`; có event.
- D-20: vòng đời phê duyệt: tạo, duyệt, từ chối, huỷ; tự duyệt → `403` (và `CHECK` bằng SQL trực tiếp → `23514`); hết hạn → `409`.
- D-21 (R6-18):
  - tiêu thụ đúng → thao tác chạy;
  - request lệch (role khác, `data` thêm khoá) → `403 admin_approval_invalid`, thao tác không chạy; id viết hoa → `422` của SP3 r8 trước bước phê duyệt;
  - dùng lại → `403`;
  - người khác dùng → `403`;
  - hết hạn → `403`;
  - tiêu thụ song song ×50 → một lần thành công.
- D-22 (phạm vi mặc định-từ-chối): với `on`, **mọi** endpoint `/admin/*` của instance runtime không thuộc `ADMIN_APPROVAL_EXEMPT_PATHS` trả `403 admin_approval_required` khi thiếu header, gồm `/admin/impersonate-user`; mọi path miễn chạy không cần header; route Nest fixture có `@RequiresApproval()` cũng đòi header; `PUT /v1/admin/kill-switches/{key}` không đòi.
- D-23: `off` → không cần header; `on` mà thiếu provider `AdminActionApprovals` → không khởi động; `on` ở `external` → khởi động, route Nest có `@RequiresApproval()` vẫn đòi phê duyệt.
- D-24 (spike D1, drift): liệt kê endpoint của instance runtime (thuộc tính `path`) có tiền tố `/admin/`; mọi mục của `ADMIN_APPROVAL_EXEMPT_PATHS` phải tồn tại (bắt path bị đổi tên); tập path đòi phê duyệt được so với snapshot có review, nên path mới của plugin hiện ra trong diff (dù đã bị chặn mặc định). Thêm: body của hook và body handler nhận là cùng một đối tượng (D1).
- D-26 (gắn với request): tạo phê duyệt cho `/admin/set-role { userId: U, role: 'user' }` → gửi `role: 'admin'`, `userId` khác, query thêm khoá, hoặc path khác → `403 admin_approval_invalid`, role không đổi; gửi đúng body với thứ tự khoá khác → chạy (so `jsonb`); phê duyệt chứa `password`/`newPassword` ở bất kỳ độ sâu → `422` lúc tạo; `set-user-password` với phê duyệt `{ userId }` + `newPassword` bất kỳ lúc dùng → chạy (khoá bí mật bị bỏ trước khi so).
- D-27 (route Nest): `@RequiresApproval()` + `@Idempotent()`: lần đầu chạy và tiêu thụ; gửi lại cùng `Idempotency-Key` → `403 admin_approval_invalid` (hành vi đã ghi ở §8.4).
- D-25: đã tiêu thụ rồi handler lỗi → phê duyệt vẫn `CONSUMED` (hành vi đã ghi).
- D-28 (r2, R-X15): `requiresApprovalOf` trả `true` với decorator trên method, trên class; inventory luật (d): fixture route `@RequiresApproval()` thiếu `@PlatformStaffAction()` → app không khởi động.

**Xuyên module:**
- X-1: luật kiến trúc 20–25 với fixture phải fail.
- X-8 (SP4 ↔ files, khi 4B đã merge): adapter `FileStorageLimitAdapter` của SP4 (nạp qua `OPTIONAL_BRIDGES` của SP7) trả hạn mức theo gói; đổi gói → lần khởi tạo sau dùng hạn mức mới; không có dòng `usage_counters` nào cho `files.storage_bytes` (không bộ đếm thứ hai, per R-X8).
- X-9 (r2, R-X16): UP-12b của SP7 chạy với module thật của SP6: `disable: ['files']`, `disable: ['integrations']`, `disable: ['admin']` lần lượt → env bắt buộc của module bị tắt vắng mà validate xanh; queue, job, cron, config của nó không đăng ký; `markModuleLoaded` của nó không được gọi. `disable: ['audit']` khi `admin` bật → `composeAppModules` ném lỗi `MODULE_REQUIRES` (`admin → audit`).
- X-10 (r2, R-X16): `pnpm chart:secrets --check` xanh và `files/secret-env.json` có `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` với vai trò `api`, `worker`; CO-4 của SP7 chạy với module files bật: api và worker validate xanh với đúng tập secret đó.
- X-2: `normalization-inventory.spec.ts` phủ mọi cột mới.
- X-3: purge org end-to-end qua `JobQueue` thật: org có file, endpoint, delivery → sau purge không còn dòng nào ngoài audit; object rỗng; audit có `tenancy.org.purged`.
- X-4: smoke prod-like có webhook. Receiver HTTPS trong network của compose, CA sinh lúc chạy test và gắn vào worker bằng `NODE_EXTRA_CA_CERTS`; `RESILIENCE_SSRF_ALLOW_CIDRS` = subnet của compose **chỉ trong env smoke**. Luồng: đổi role member → receiver nhận `tenancy.member.role_changed` có chữ ký hợp lệ.
- X-5: như A-24.
- X-6: đo kích thước image (chưa nén và nén) và thời gian khởi động, ghi ADR 0013.
- X-7: quét PII trên log của các đường lỗi của e2e và chaos.

---

## 17. Chia plan

Theo thứ tự toàn cục W1…W8 của R-X7. Mỗi plan ghi phụ thuộc **thật** (thứ nó dùng), không ghi "cần cả SP3".

```
W1  3A ─────────────┐
W2                  ├──▶ 6.0 Nền (core)          (song song 3B, 4A, 7A)
W3                  │      ├──▶ 6A Files          (song song 3C, 3D, 6C, 7B)
                    │      └──▶ 6C Integrations
W4  3D ─────────────┴──────┴──▶ 6B Audit          (cần 6.0 + 3D; song song 4B, 4C, 7C)
W5                              └──▶ 6D Admin     (cần 6B; dùng 6A/6C qua port @Optional)
```

**Bảng 0: Phụ thuộc thật của từng plan.**

| Plan | Phụ thuộc cứng | Vì sao | Không cần (và vì sao) |
|---|---|---|---|
| **6.0** | **3A** | Sửa `01-roles.sh`, `rls-catalog.spec.ts` sau 3A; chuyển `routeTemplateOf`, `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` ra khỏi tenancy (3A tạo); đặt cờ cho event `tenancy.*` của 3A; `OrgMutationLock` đọc `organizations` (3A) | 3B–3D: không dùng role tuỳ biến, lời mời, org key hay step-up. Event của 3B (merge cùng W2) do plan merge sau trong cặp 3B/6.0 khai cờ (compile bắt) |
| **6A** | **6.0** | `defineEvent` có cờ, `@BodyParserOwner`, `sweep_definer` + `defineOrgSweep`, `OrgMutationLock`, `core/contracts`; participant và catalogue quyền của 3A (qua 6.0) | 3B–3D; SP4 (port `FileStorageLimit` có mặc định config; SP4 4B cài adapter và thêm kiểm lúc boot **sau**, per R-X8, R-X13). Ca G-6 với org key/support grant chạy khi 3D đã có (3D sinh lại G-6 cho mọi route) |
| **6C** | **6.0** | Như 6A, cộng sáu event tenancy mang `webhook: true` (đã có từ 3A, cờ đặt ở 6.0) | 3B–3D. Ca "org key không tạo được endpoint" (`webhooks.write` không `apiKeyEligible`) cần 3D: plan nào trong cặp 6C/3D merge sau thêm ca đó |
| **6B** | **6.0, 3D** | Hook hai pha chạy sau gate (3)–(8) của 3D; cột `ticket` (3D); `PlatformAccessAudit`, `NoopPlatformAccessAudit`, `hasPlatformStaffAction` (addendum 3D §A2–A3, per R-X2, R-X12) | 3C: `TenancyUserIds` đọc `tenancy_users` (3A); event của 3C có cờ `audit: true` từ lúc 3C định nghĩa, A-1 tự phủ khi 3C đã merge |
| **6D** | **6B** (và 3D qua 6B) | Audit truy cập của route admin cần bản cài của 6B; `AuditReader` (6B); decorator (3D) | 4C (r0 của review ghi 4C vì decorator; per R-X2 decorator ở 3D); 6A, 6C (token `FileUsageReader`/`WebhookStatsReader` ở `core/contracts` do 6.0 tạo, `@Optional`, trường `null` khi vắng; per R-X16) |

- **Rủi ro 3D:** SP3 r8 §4 T7(h) có thể dừng 3D. Khi đó 6B và 6D dừng theo; 6.0, 6A, 6C không phụ thuộc 3D và vẫn chạy.
- **Song song trong một sóng:** các plan không sửa chung đối tượng schema nào. Mỗi plan có thư mục migration và bảng riêng; `permissions` là **dòng** riêng của từng plan; quyền trên `organizations` chỉ là FK. Chỗ đụng code chung có ở bảng 5 dưới.
- **Quy tắc merge của SP3 §6.13:** plan merge sau rebase, đổi timestamp migration của mình lớn hơn mọi migration trên `main`, rồi chạy lại **toàn bộ** pipeline.

**Bảng 1: Nội dung mỗi plan.**

| Plan | Phụ thuộc | Nội dung |
|---|---|---|
| **6.0 Nền** | 3A | Spike P1–P3. §5.3 hàng `core/events` (cờ bắt buộc + cờ cho mọi event đang có), `core/sweep` (`defineOrgSweep`, `OrgSweepRunner`), `core/http` (body parser nhiều chủ, `routeTemplateOf`), `core/partitions`, `core/flags`, `01-roles.sh` (`partition_owner`, `sweep_definer`), `rls-catalog` (a, b, e), marker body parser của identity, `OrgMutationLock` của tenancy, `core/contracts/admin-readers.ts` (R-X16). Migration `core/…_kill_switches`. Config §11.1. Test C-1…C-9 (gồm C-8b), C-20, C-30. ADR 0005 (hai role, `sweep_definer` dùng chung), 0006 (subscriber bộ chọn, cờ bắt buộc, `core/sweep` và luật `jobId` theo slot), 0007 (body parser nhiều chủ). Chưa có kill switch nào được khai (registry rỗng; test dùng fixture). Đo image (ADR 0013) |
| **6A Files** | 6.0 | Spike F1–F5. Module files trọn vẹn (§5.1, §6.3, §7.1, §8.1): route và token route, pipeline, port `ImageSanitizer` + no-op, port `FileStorageLimit` (mặc định config), sweep qua `defineOrgSweep`, participant (order 110, addendum 3D §A4) + subscriber + job dọn object, `FileStore`, bản cài `FileUsageReader` của `core/contracts`; `markModuleLoaded('files')`, mục `files` của `BOILERPLATE_MODULES`, `MODULE_REQUIRES files → tenancy`, `.meta({ secret })` của `FILES_S3_*` (R-X16). Kill switch `files.uploads`. Catalogue `files.*`. Event `files.*` (`audit: true`; `webhook: true` cho `ready`, `deleted`). Compose: `minio`, `minio-init`, profile `scan` cho clamd. Redact S3. ADR 0020 phần Files, 0016 (ngoại lệ SDK S3), 0013 (kích thước). Test F-*. Config §11.2 |
| **6B Audit** | 6.0, 3D | Spike B1. Module audit trọn vẹn (§6.4, §8.2): subscriber, API đọc theo org, `AuditReader` (export cho 6D), partition + hàm bảo trì. Bản cài `PlatformAccessAudit` (addendum 3D §A3) + event `audit.staff_access.recorded`; `PlatformStaffRouteInventory` (identity, luật (a)–(c)); `markModuleLoaded('audit')`, mục `audit`, `MODULE_REQUIRES audit → identity, tenancy` (R-X16). Identity: event mới, hook hai pha, hook session, audit của thông báo bảo mật, `ticket` trong ledger. Tenancy: `TenancyUserIds`. Catalogue `audit.read`. ADR 0020 phần Audit. Test A-*. Config §11.3 |
| **6C Integrations** | 6.0 | Spike W1. Module integrations trọn vẹn (§6.5, §7.2–7.4, §8.3), gồm `classifyAttempt` và luật config bulkhead. Sweep qua `defineOrgSweep` (`extraParams` `p_grace_sec`); participant (order 120, addendum 3D §A4); bản cài `WebhookStatsReader` của `core/contracts`; `markModuleLoaded('integrations')`, mục `integrations`, `MODULE_REQUIRES integrations → tenancy` (R-X16). `setProviderDefaults('webhooks-out')`. Kill switch `integrations.webhook_delivery`. Catalogue `webhooks.*`. Mục `webhooks` của OpenAPI. Redact webhook. ADR 0020 phần Webhooks. Test W-*. Config §11.4 |
| **6D Admin** | 6B | Spike D1. Module admin (§6.6, §7.5, §8.4), mọi route mang `@PlatformStaffAction()`. Identity: port `AdminActionApprovals`, `@RequiresApproval()` + `ApprovalGuard` + `requiresApprovalOf`, luật (d) của inventory, `ADMIN_APPROVAL_EXEMPT_PATHS`, `ADMIN_APPROVAL_SECRET_FIELDS`, hai mã lỗi, bước phê duyệt trong hook. `markModuleLoaded('admin')`, mục `admin`, `MODULE_REQUIRES admin → audit, identity, tenancy` (R-X16); admin đọc số liệu files/integrations qua token `core/contracts`. Tenancy: `PlatformOrgDirectory` + migration `…_admin_directory`. Test D-*. Config §11.5 |

**Bảng 2: Race → plan chủ** (plan viết test lần đầu).

| Plan | Race |
|---|---|
| 6.0 | R6-17 |
| 6A | R6-1…R6-8, R6-27 (R6-24 bỏ ở r1) |
| 6B | R6-16, R6-21 (hook identity và port audit truy cập), R6-22, R6-23, R6-29 (phần inventory) |
| 6C | R6-9…R6-15, R6-25, R6-26, R6-28 |
| 6D | R6-18…R6-20, R6-29 (phần phê duyệt) |

**Bảng 3: Tiêu chí mục 1 → plan đóng.**
- 1: mỗi plan cho bảng của nó.
- 2–7: 6A.
- 8: 6B.
- 9: 6B (L2, L3, L5, L12) và 6D (L4).
- 10: 6C.
- 11: 6.0, và 6A/6C cho switch của từng module.
- 12: 6B (inventory luật (a)–(c), audit truy cập cho mọi module); 6D thêm luật (d) và chạy lại trên route của mình.
- 13–16: mọi plan.

**Bảng 4: Thứ tự merge của cặp 6A/6C.** 6A luôn khai `webhook: true` cho `files.file.ready`, `files.file.deleted` (cờ bắt buộc, giá trị cuối). Plan nào merge **sau** thêm task "Webhook cho event files":
- migration `integrations/…_webhook_file_events` (dòng catalog cho hai event);
- cập nhật W-43, snapshot OpenAPI.

Nếu 6A merge trước, `WebhookEventCatalogueCheck` chưa tồn tại nên cờ chưa có tác dụng; nếu 6C merge trước, 6A mang migration đó cùng lúc với event. Không plan nào sửa migration đã merge.

**Bảng 5: Sửa code của plan khác.**

| Chỗ | 6.0 | 6A | 6B | 6C | 6D |
|---|---|---|---|---|---|
| `core/events/event-definition.ts` + mọi lời gọi `defineEvent` trên `main` (`identity/events.ts`, `notifications/events.ts`, `tenancy/events.ts` của 3A/3B, `entitlements` của 4A nếu đã merge, 6 file trong `test/`) | cờ bắt buộc + giá trị cuối | — | — | — | — |
| `modules/tenancy/http/org-route.ts`, `tenancy/index.ts` | `routeTemplateOf` và hai hằng chuyển vào core (re-export); `OrgMutationLock` | — | `TenancyUserIds` | — | `PlatformOrgDirectory` |
| `modules/identity/infra/better-auth/auth-hooks.ts` | — | — | hook hai pha | — | bước phê duyệt (chèn **trước** hook `attempted` của 6B) |
| `modules/identity/index.ts` | marker body parser | — | — | — | `AdminActionApprovals`, `RequiresApproval`, hằng phê duyệt |
| `modules/identity/http/` | — | — | `PlatformStaffRouteInventory` | — | `ApprovalGuard` |
| `rls-catalog.spec.ts` | (a), (b), (e) | `GLOBAL_TABLES` + hằng `DEFINER_FUNCTIONS_6A` | `platform_audit_logs` | + `DEFINER_FUNCTIONS_6C` | `admin_approvals` + `DEFINER_FUNCTIONS_6D` |
| `normalization-inventory.spec.ts` | `kill_switches` | 2 bảng (`file_purposes`, `files`) | 2 bảng | 6 bảng | 1 bảng |
| `core/logging/redaction.ts` | — | khoá S3 | — | khoá webhook | — |
| `compose.yaml`, `docker/images.env` | — | MinIO, clamd | — | — | — |
| `src/boilerplate.modules.ts` (7A: `BOILERPLATE_MODULES`, `MODULE_REQUIRES`) | — | mục `files` + dòng | mục `audit` + dòng | mục `integrations` + dòng | mục `admin` + dòng |
| `src/core/contracts/` (6.0) | tạo `admin-readers.ts` | cài `FileUsageReader` | — | cài `WebhookStatsReader` | inject `@Optional()` |
| `modules/files` (6A), sửa bởi 4B | — | — (4B thêm `FileStorageLimitCheck` + F-34, R-X13) | — | — | — |

---

## 18. Sửa spec cha và spec trước

### 18.1 Spec cha

| Chỗ | Sửa |
|---|---|
| §2 bảng context | Event tiêu biểu của Files: `files.file.uploaded` → `files.file.ready` (một event cho cả upload, khôi phục và file do worker tạo, có `cause`) |
| §3.3/§12 idempotency | Thêm ngoại lệ: route trả capability có hạn (`POST …/files`, `rotate-secret`, tạo endpoint) không `@Idempotent()` (cùng loại B9 của SP3) |
| §4 "Bảng lớn … partition theo tháng" | Ghi cơ chế: role NOLOGIN `partition_owner`, hàm bảo trì `SECURITY DEFINER` riêng mỗi bảng, sàn retention cứng trong hàm, cron `core.partitions.maintain` |
| §4 quy ước FK | Ngoại lệ có tên: `audit_logs` không FK tới `organizations` |
| §4.1 danh sách DB role | Thêm `partition_owner`, `sweep_definer` (NOLOGIN, NOBYPASSRLS). `sweep_definer` là role duy nhất cho mọi hàm quét xuyên org của module và feature (per R-X4) |
| §6 queue | Thêm `files`; dùng `webhooks-out` |
| §6 cron | `files.cleanup-orphans` (04:00) → `files.sweep-orgs` (mỗi 15 phút, làm đủ vòng đời); thêm `core.partitions.maintain`, `integrations.sweep-orgs`, `admin.approvals.purge`. Mọi cron quét xuyên org dùng `defineOrgSweep` của core: cron ở `maintenance`, việc theo org ở queue của module, `jobId` theo slot |
| §6 dead-letter | Webhook: dead-letter là delivery `EXHAUSTED`/`CANCELLED` trong DB (có API replay); tập failed của BullMQ cho lỗi lập trình |
| §11 SSRF | Ngoại lệ có tên thứ hai: SDK S3 (endpoint lấy từ config) |
| §11 Audit log | Ghi cơ chế: mọi event khai cờ `audit` bắt buộc, hai pha cho `/admin/*` và API key, audit của thông báo bảo mật, `audit.staff_access.recorded` cho mọi route `/v1/admin/**` (port của `@PlatformStaffAction()`) |
| §13.1 kill switch | Vị trí `core/flags`; hai switch đầu tiên |
| §14 Contract | Schema webhook ra ngoài nằm trong mục `webhooks` của OpenAPI 3.1 và được `oasdiff` kiểm |
| §17 package | Thêm `@aws-sdk/s3-presigned-post`, `clamscan` (+ `@types/clamscan`), `@testcontainers/minio`. `@tus/server` và `sharp` không cài ở boilerplate (`sharp` per R-X9: adapter tuỳ chọn của dự án sau port `ImageSanitizer`) |
| Phụ lục B | (1) tus: công thức trong README, không ship. (2) "Stream qua API" đi qua URL token `PUT /v1/file-uploads/{token}`. (3) Key: `{orgId}/{module}/{uuidv7}` + hậu tố `.upload` (vùng nhận, chỉ client ghi), `.clean` và `.thumb.webp`; public là `public/` + key, được sao **sau** khi quét xong và gỡ trong hai lượt khi file rời trạng thái sống. (4) Quota dung lượng là `LIMIT` của SP4 (per R-X8): đếm mọi biến thể đang lưu dưới khoá org, không bộ đếm; dòng `PENDING` giữ chỗ theo kích thước khai báo, kích thước khai báo được ép chính xác. (7) Bỏ EXIF/thumbnail qua port `ImageSanitizer`, mặc định no-op. (5) R2 không có POST policy: `FILES_PRESIGNED_POST=false` → multipart. (6) Xoá mềm: khôi phục chạy lại pipeline |
| Phụ lục C mục 6 | Ghi rõ SP6 không gồm thông báo in-app, template tenant, locale theo user, SMS/push |

### 18.2 SP2

- Bảng "Hoãn lại, có chủ sở hữu": các dòng in-app, `Preference`, template tenant, locale theo user, SMS/push/bounce chuyển chủ sở hữu từ "SP6" sang "SP đầu tiên có use case" (L9).
- §5.5: `HTTP_BODY_PARSER_SKIP_PREFIX` được thay bằng marker `@BodyParserOwner` (hành vi không đổi).
- §5.10: thêm audit đăng nhập và audit hai pha (bổ sung, không đổi hành vi thành công).

### 18.3 SP3 (r8) và registry của amendments

- §14: mọi event khai hai cờ bắt buộc (6.0 đặt giá trị cho event của 3A/3B; 3C, 3D tự khai khi định nghĩa): `audit: true` cho mọi `tenancy.*`; `webhook: true` cho sáu event ở §8.3 (hợp đồng công khai; đổi schema phải lên version), `false` cho phần còn lại.
- §19:
  - dòng "Audit log" → đã làm (SP6);
  - dòng "Phê duyệt hai người" → đã làm, tuỳ chọn `ADMIN_DUAL_CONTROL`, mặc định-từ-chối trên `/admin/*`;
  - dòng "dọn lời mời/link" → chủ sở hữu "SP sau" (L6).
- §23.2 câu 2: thông báo khi bị xoá khỏi org được phục vụ bằng webhook và audit, không làm in-app (L7).
- **Registry order của participant (R-X5, R-X12):** registry nay ở addendum 3D §A4: `files` = **110**, `integrations` = **120** (đã thêm), tenancy core 1000 (không phải participant, dành riêng); registry từ chối `order ≥ 1000` lúc boot. Audit không phải participant (giữ lại, R-X5).
- §6.1/B5: ngoại lệ `audit_logs`.
- §18.1 catalog: luật cho partition, hai role mới; policy của `sweep_definer` đặt tên `<bảng>_definer_read`.
- §7.4: `routeTemplateOf` chuyển vào `core/http` (6.0), tenancy import lại; §6.14/§13: `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` chuyển vào `core/sweep` (6.0), tenancy re-export. §9.5 (`tenancy.orgs.purge`) chuyển sang `defineOrgSweep` ở lần dọn sau (per R-X4), không trong SP6.
- Tenancy export thêm `OrgMutationLock` (6.0), `TenancyUserIds` (6B), `PlatformOrgDirectory` (6D); hai hàm definer mới cùng index của 6D (`DEFINER_FUNCTIONS_6D`). Đề nghị ghi các export này vào sổ export tenancy/identity trong amendments của SP3 (review T-1).
- Identity (3D, per R-X2, R-X12): SP6 **không** thêm guard nào. SP6 dựa vào 3D export theo addendum 3D: `@PlatformStaffAction()` (§A1), `hasPlatformStaffAction` và `PLATFORM_STAFF_ACTION` (§A2), `PlatformAccessAudit` + `NoopPlatformAccessAudit` + `PlatformAccessEntry` (§A3, `@Global()` + `@Optional()`), bộ ca `describePlatformStaffActionConformance` (§A5). SP6 thêm vào identity: `PlatformStaffRouteInventory` (6B, per R-X17), `AdminActionApprovals`, `@RequiresApproval()`, `requiresApprovalOf`, `ApprovalGuard`, bước phê duyệt trong hook (6D).

### 18.4 SP4, SP5, SP7 (spec đang sửa song song)

- **SP4** (per R-X8, R-X13):
  - khai `files.storage_bytes` trong catalogue của boilerplate, kiểu **`LIMIT`**, `minimum: 0`, `fallback: { max: FILES_STORAGE_FALLBACK_BYTES }` (tên hằng của SP4, một tên ở mọi spec; = 1 GiB, rulings C4), không phải `QUOTA`; SP4 ST-3 so hằng đó với `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES` do files export;
  - cài port `FileStorageLimit` của files (một tên, SP6 sở hữu; SP4 không khai class riêng) bằng `EntitlementsFilesPortsModule` (`@Global()`) ở **entry riêng** `modules/entitlements/integrations/files.ts` (SP4 S4-D21), **không** trong `forApi()`/`forWorker()` của entitlements (r1 ghi sai: import `files/index.ts` từ module entitlements kéo config của files vào boot cả khi files tắt). Cùng module cho api và worker (worker cần cho `FileStore.saveGenerated`); map `Entitlements.limitOf('files.storage_bytes')` sang `StorageLimit` với `featureKey = 'files.storage_bytes'`; hướng phụ thuộc: chỉ entry đó → `files (index)`;
  - composition của SP7 nạp entry khi cả hai module bật, qua dòng `entitlements-files` của `OPTIONAL_BRIDGES` do 4B thêm; 4B cũng thêm kiểm lúc boot `FileStorageLimitCheck` vào files (§8.1 bước 4, F-34), vì 4B là plan merge sau trong cặp 4B/6A (R-X7);
  - **không** có bộ đếm dung lượng nào ở SP4 (không dòng `usage_counters` cho khoá này); files đếm dưới khoá org;
  - route admin của SP4 được audit truy cập qua `@PlatformStaffAction()` và trích ngoại lệ S6-A39 khi mở `OrgScope` không qua membership; ca inventory trên route SP4 chạy ở plan merge sau trong cặp 4C/6B;
  - event `entitlements.*` khai `audit: true` (cờ bắt buộc);
  - nghĩa vụ R-X16 của SP4 (`markModuleLoaded('entitlements')`, `MODULE_REQUIRES entitlements → tenancy`, không trường secret) do SP4 tự mang.
- **SP5:**
  - mọi event `billing.*` khai hai cờ tường minh; khuyến nghị `audit: true` cho tất cả (ba thao tác xử lý tay của admin là bắt buộc theo spec cha §A.1); `billing.payment.*` không có `orgId` nên vào `platform_audit_logs`; `webhook: true` cho `billing.invoice.paid` nếu muốn (event mang org);
  - route admin billing dùng `@PlatformStaffAction()` (3D) và được audit truy cập bởi port của 6B, nên log `billing_txn_viewed` được thay bằng `audit.staff_access.recorded`;
  - **phê duyệt hai người cho thao tác tiền tay** (review SP5-M4, per R-X15): SP6 **cung cấp** `@RequiresApproval()` và `requiresApprovalOf`; **SP5 sở hữu** việc gắn decorator lên ba route `POST /v1/admin/billing/payment-transactions/{id}/assign|refunded|ignore` (sau `@PlatformStaffAction()`), nên 5B phụ thuộc 6D (W6 > W5). SP6 không gắn decorator lên route của SP5. Với `ADMIN_DUAL_CONTROL=off` (mặc định) hành vi không đổi; với `on`, thiếu header → `403 admin_approval_required`; gửi lại sau khi đã thành công với cùng `Idempotency-Key` → `403 admin_approval_invalid`, không nhận response đã lưu (§8.4 bước 4, D-27): runbook review tiền của SP5 phải ghi điều này;
  - hàm quét của SP5 thuộc `sweep_definer` và dùng `defineOrgSweep` (per R-X4) theo hợp đồng R-X14: chữ ký `(p_after uuid, p_limit integer, …)`, tham số thêm theo tên và kiểu `integer`/`boolean`/`text` (khoảng thời gian truyền bằng số nguyên giây, hàm tự `make_interval`); không callback TS;
  - nghĩa vụ R-X16 của SP5 (`markModuleLoaded('billing')`, dòng `MODULE_REQUIRES`, `.meta({ secret })` cho secret webhook) do SP5 tự mang.
- **SP7:**
  - sample dùng `defineOrgSweep` + `sweep_definer` + policy `<bảng>_definer_read`, cron ở `maintenance` (per R-X4); hàm definer của mẫu đổi chữ ký thành `(p_after uuid, p_limit integer, p_retention_sec integer)` và khai `extraParams: () => ({ p_retention_sec: … })` (per R-X14; chữ ký r1 `(p_after, p_retention_sec, p_limit)` bị runner gọi sai thứ tự và `RAISE` ở mọi lượt); event mẫu khai hai cờ;
  - composition (7A): hằng `OPTIONAL_BRIDGES` (4B thêm dòng `entitlements-files`) và `loadedModules()` ở `core/config` mà `FileStorageLimitCheck` đọc (per R-X13, R-X16);
  - runbook: retention audit, cảnh báo partition, IAM/CORS/lifecycle của bucket, `StreamMaxLength` của clamd, xoay khoá `FieldCipher` (secret webhook), phê duyệt hai người (cách tạo, duyệt, dùng; request phải trùng), cảnh báo `webhook_local_faults_total`;
  - **Helm, secret theo role (amendment D2, per R-X16):** `FILES_S3_SECRET_ACCESS_KEY` và `FILES_S3_ACCESS_KEY_ID` mang `.meta({ secret: { roles: ['api', 'worker'] } })` trong `files.config.ts` (6A; §5.3, §11.2), nên `pnpm chart:secrets` đưa chúng vào `files/secret-env.json` và vào danh sách tên cấm trong ConfigMap (r1 dựa vào danh sách redact của log, vốn không phải nguồn của chart; review X2-4). Api presign và nhận upload qua API; worker xử lý và dọn. Secret ký webhook nằm trong DB, mã hoá bằng khoá `FieldCipher` sẵn có, không thêm env bí mật. Env không bí mật của SP6 (`FILES_S3_BUCKET`, `FILES_CLAMD_HOST`…) đi qua config chung;
  - **Helm, egress (amendment D2, review ops SP7-I4):** `objectStorage` (host/port của `FILES_S3_ENDPOINT`; api + worker; có thể là IP private khi dùng MinIO trong cluster hoặc VPC endpoint), `clamd` (`FILES_CLAMD_HOST:FILES_CLAMD_PORT`; worker), webhook ra ngoài (worker; cổng phải là tập con của `internet.ports`, template `fail` khi `RESILIENCE_ALLOWED_PORTS` rộng hơn);
  - **Helm, nhóm worker:** tách queue `files` hoặc `webhooks-out` ra nhóm riêng thì phải thêm queue đó vào `default.queuesExclude`, nếu không cả hai nhóm cùng tiêu thụ và không còn bulkhead (review ops SP7-I8b). Concurrency mặc định của hai queue là `QUEUE_IO_CONCURRENCY` = 20; không có override trong chart;
  - volume `emptyDir` cho `/tmp` giữ như SP7 đã có; SP6 không buffer ảnh (không có `sharp`).

### 18.5 ADR

Per R-X6: SP6 có **một** số ADR mới, 0020 (0018 là SP4, 0019 là SP5, 0021 là SP7). r0 dùng 0018–0020 cho ba ADR; r1 gộp thành ba phần của 0020.

| ADR | Nội dung |
|---|---|
| **0020 Files, audit bền và webhook ra ngoài** (mới) | Phần Files (6A): S6-A4…A16, spike F1–F5, port `ImageSanitizer` no-op (R-X9), quota `LIMIT` không bộ đếm (R-X8). Phần Audit (6B): S6-A3, A20…A25, A31, A32, A45, spike P1/P2/B1, port audit truy cập + inventory (R-X2). Phần Webhooks (6C): S6-A26…A30, A33…A37, A49, spike W1. Mỗi plan viết phần của mình; plan đầu tiên tạo file |
| 0005 | Hai role mới (`sweep_definer` dùng chung, R-X4), ngoại lệ `OrgScope` của admin và audit truy cập (S6-A39), rủi ro SQLi của hàm definer mới |
| 0006 | Subscriber bộ chọn, cờ event bắt buộc (R-X3), `core/sweep` và luật `jobId` theo slot (R-X4), dead-letter của webhook |
| 0007 | Body parser nhiều chủ, route token |
| 0013 | Kích thước image sau SP6 (đo lại không có `sharp`) |
| 0016 | Ngoại lệ SDK S3; provider `webhooks-out` tắt breaker |

---

## 19. Quyết định

### 19.1 Em tự chốt (Sếp bác cái nào em sửa)

| # | Quyết định | Lý do | Phương án đã loại |
|---|---|---|---|
| S6-A1 | Chia 6.0 + 6A ∥ 6C + 6B + 6D, phụ thuộc thật theo R-X7 (6.0 sau 3A; 6A, 6C sau 6.0; 6B sau 6.0 + 3D; 6D sau 6B) | Việc core chung được gom trước; chỉ plan thật sự dùng 3D mới chờ 3D | Bốn plan song song ngay từ đầu: cả bốn cùng sửa `core/events`, `01-roles.sh`, test catalog; mọi plan chờ 3D (r0): dồn cả SP6 sau điều kiện dừng T7(h) |
| S6-A2 | Cờ `audit`/`webhook` trên `defineEvent` + subscriber theo bộ chọn | Bỏ module không làm vỡ audit; thêm event không quên đăng ký | Một class cho mỗi event; audit import mọi module (không bỏ được module); module đăng ký vào audit (module phụ thuộc audit) |
| S6-A3 | Role `partition_owner` + hàm bảo trì riêng mỗi bảng | Drop partition cần quyền owner, mà runtime không có `app_owner` | Hàm definer do `app_owner` sở hữu (quá rộng); `DELETE` theo lô (trái append-only) |
| S6-A4 | Upload qua API bằng URL token dưới prefix riêng | Prefix tĩnh làm được với core; token là capability như presign | Route tenant nhận body raw (phải khớp route trước router, lệch matcher như SP3 INT3-2); base64 trong JSON (+33%, vượt giới hạn body) |
| S6-A5 | Driver local chỉ dev/test; tải qua route token trên domain API | Phụ lục B yêu cầu local; production cấm | Bỏ hẳn local (trái phụ lục B) |
| S6-A6 | `object_key` và `visibility` là snapshot | Chỗ object nằm không được phụ thuộc registry trong code | Suy ra từ purpose (đổi code làm mồ côi object) |
| S6-A7 | (r1, per R-X8) Không bộ đếm: dung lượng = `SUM(stored_bytes)` dưới khoá org, mọi biến thể đang lưu được tính | `LIMIT` của SP4: module chủ đếm dưới khoá của mình, như `tenancy.seats`; không có gì để lệch; bỏ trigger mà Postgres từ chối | r0: bảng đếm + trigger mức câu lệnh (trigger nhiều event có transition table không tạo được; là bộ đếm thứ hai mà R-X8 cấm); ba trigger một event (giữ làm phương án dự phòng nếu F-32 không đạt, cần Sếp duyệt vì trái R-X8); `QUOTA` của SP4 (bộ đếm tách khỏi trạng thái file) |
| S6-A8 | Quota dung lượng dùng `422 quota_exceeded` của core | Đây là quota theo gói (SP4) | Mã riêng (SP3 chỉ tách giới hạn config khỏi quota) |
| S6-A9 | Không ship tus | Spec cha §17: chỉ cài khi bật, kéo client Redis | Ship tắt (thêm phụ thuộc và kích thước image) |
| S6-A10 | File do worker tạo không qua quét | Nội dung do hệ thống sinh; `NOT_SCANNED` hiện rõ | Quét mọi file (tốn tài nguyên, không có mối đe doạ) |
| S6-A11 | Client chỉ ghi vùng nhận `.upload`; server sao sang key gốc bằng `CopySourceIfMatch`; không ghi đè key gốc; bản `clean`/thumbnail có key tất định | Chặn TOCTOU (R6-27); worker bị treo ghi muộn không làm lệch nội dung đã commit | Để client ghi thẳng key được phục vụ (URL còn hạn ghi đè được sau khi quét); ghi đè bản gốc khi làm sạch (lệch sha256 sau `READY`) |
| S6-A12 | Dùng `clamscan`, spike F2, fallback tự viết `INSTREAM` | Package-first, phổ biến | Tự viết ngay (trái luật package-first khi chưa chứng minh package hỏng) |
| S6-A13 | (r1, per R-X9) Không `sharp`; port `ImageSanitizer` với no-op mặc định; biến thể ghi bằng `If-None-Match: *` | Pháp chế LGPL chưa trả lời; tiết kiệm 20 MB; ghi có điều kiện làm R6-4 không phụ thuộc thư viện ảnh | Cài `sharp` (r0); bỏ hẳn port (mất điểm mở rộng, phải đổi schema khi thêm lại) |
| S6-A14 | File public: upload vào private, sao sang `public/` sau `READY`, ghi ý định trước khi sao | Không lộ file chưa quét; không để bản sao mồ côi | Upload thẳng vào public; bucket policy theo tag (không chạy được trên mọi provider) |
| S6-A15 | Server chọn chế độ upload; presigned POST mặc định; R2 dùng multipart | Kích thước bị ép ở storage | PUT presigned (không ép được kích thước, phụ lục B) |
| S6-A16 | `complete` tự `ListParts` ở server | Không tin ETag do client gửi | Dùng ETag của client |
| S6-A17 | `next_sweep_at` + definer chỉ trả id org + job theo org | Một index, một hàm; RLS vẫn áp trong job | Definer trả dữ liệu dòng; mỗi loại việc một cron |
| S6-A18 | Role `sweep_definer` riêng, **dùng chung cho mọi SP** (per R-X4), cùng helper `defineOrgSweep` và một luật `jobId` theo slot | Một vai trò cho một việc: quét xuyên org chỉ trả id; mỗi role NOLOGIN mới là một lần DBA sửa `01-roles.sh`; slot giới hạn thời gian một job `failed` chặn org | Dùng lại `tenancy_definer` (gắn role với tenancy); `app_admin` (SP3 S3-A2); mỗi SP một role (`billing_definer`); `jobId` cố định (org bị chặn tới `QUEUE_KEEP_FAILED_AGE_SEC`) |
| S6-A19 | Purpose và event type là bảng tra cứu + kiểm lúc boot | Luật enum; mẫu `email_templates` | `CHECK` danh sách (phải viết lại khi thêm); chuỗi tự do |
| S6-A20 | Không dùng `pg_partman` | Không có trong image Postgres chính thức; managed provider hỗ trợ khác nhau | `pg_partman` |
| S6-A21 | Khoá partition của audit là `recorded_at` | Luôn rơi vào partition đã tạo | `occurred_at` (xử lý lại có thể rơi vào partition đã drop) |
| S6-A22 | `audit_logs` không FK; audit của org đã purge giữ tới hết retention | Lịch sử sống lâu hơn org (chờ Sếp, C2) | Xoá audit theo org (mất dấu vết đúng lúc cần) |
| S6-A23 | Hai bảng audit (tenant, nền tảng) | Policy `WITH CHECK` không ghi được dòng không có org | Một bảng với `org_id NULL` |
| S6-A24 | `actor_user_id` là snapshot lúc ghi | Không đọc chéo bảng; không mất khi xoá tài khoản | Join lúc đọc |
| S6-A25 | Chặn trùng audit bằng inbox, không `UNIQUE (event_id)` | Unique trên bảng partitioned phải chứa cột partition | `UNIQUE (event_id, recorded_at)` (vô dụng) |
| S6-A26 | Tra delivery theo `public_id` mà không prune partition | Khoảng 5 lần dò index là đủ rẻ | Nhúng `created_at` vào id hoặc payload job |
| S6-A27 | Tách `webhook_messages` khỏi `webhook_deliveries` | 3NF: body thuộc message | Lặp body ở mỗi delivery |
| S6-A28 | Standard Webhooks; `webhook-id` = event id; payload `{type, version, timestamp, data}` | Chuẩn mở, có thư viện verify | Định dạng tự chế |
| S6-A29 | Secret mã hoá bằng `FieldCipher`, trả một lần, xoay có chồng lấn | Ký cần secret gốc | Lưu băm (không ký được); cho xem lại secret |
| S6-A30 | Tắt breaker của provider `webhooks-out`; sức khoẻ theo endpoint nằm ở DB | Breaker chung gộp mọi khách | Breaker theo endpoint trong bộ nhớ (`ResiliencePolicies` cấm tên động) |
| S6-A31 | Audit đăng nhập best-effort | Không phải thao tác đặc quyền | Sổ + cron đối soát như D10 của SP2 (thêm cột và cron) |
| S6-A32 | Audit hai pha, fail closed, cho `/admin/*` và API key | Không có thao tác đặc quyền nào không để lại dấu vết | Chỉ ghi ở hook `after` |
| S6-A33 | Dead-letter của webhook nằm trong DB | Bền, khách tự xem và phát lại | Tập failed của BullMQ |
| S6-A34 | Retry bằng job mới có `delay` | Lịch theo config, tôn trọng `Retry-After` | Backoff của BullMQ |
| S6-A35 | `webhooks.write` không dùng được bằng key; đăng ký đòi session mới | Đây là kênh xuất dữ liệu | Cho key quản lý webhook |
| S6-A36 | Payload webhook nằm trong mục `webhooks` của OpenAPI + `oasdiff` | Công cụ có sẵn | Tự so snapshot |
| S6-A37 | Chỉ webhook theo org | Đúng phạm vi spec cha §2 | Webhook nền tảng |
| S6-A38 | (r1) Chuyển cho 3D: hành vi guard nhân viên, kể cả `external`, là của `@PlatformStaffAction()` (per R-X2) | Một decorator cho một bất biến | r0: `@PlatformAdminOnly()` riêng của SP6 |
| S6-A39 | Admin tự mở `OrgScope` cho org id lấy từ path, có audit trước | Cách duy nhất đọc dưới RLS mà không cần `app_admin` | Pool BYPASSRLS |
| S6-A40 | Phê duyệt hai người là tuỳ chọn, mặc định `off` | Dự án chỉ có một admin sẽ bị khoá; admin đầu tiên tạo bằng CLI | Bật mặc định |
| S6-A41 | (r1) Mặc định từ chối trên `/admin/*` trừ danh sách miễn chỉ-đọc/chỉ-thu-hẹp; phê duyệt gắn với `(method, path, query, body)`, không theo danh sách action; cùng cơ chế cho route Nest qua `@RequiresApproval()` | Danh sách cho phép (r0) bỏ sót `impersonate-user` và mọi path plugin thêm sau; gắn với cả request thì không cần hàm chuẩn hoá theo path, nên không có chỗ lệch giữa hook và handler; SP5 dùng lại được | r0: enum sáu action + `adminActionSpec`; chuẩn hoá theo path (mỗi path mới cần code mới, dễ lệch) |
| S6-A42 | Tiêu thụ phê duyệt trước khi ghi audit `attempted` | Không để lại `attempted` treo cho request bị từ chối | Ghi audit trước |
| S6-A43 | So `request_spec` bằng `jsonb =` (không phân biệt thứ tự khoá) | Không cần thư viện canonicalize | Băm JSON đã canonicalize |
| S6-A44 | Kill switch ở `core/flags`: snapshot polling, fail-static | Rẻ, không phụ thuộc Redis | Đọc DB mỗi lần gọi; Redis pub/sub |
| S6-A45 | Audit cả `GET` của admin, và ghi vào audit của org được đọc; (r1) qua port của `@PlatformStaffAction()` nên áp cho route admin của mọi module, và app không khởi động khi có route admin mà thiếu bản cài | Minh bạch với khách (SEC-M13); route admin của SP4/SP5 từng không có audit truy cập | Chỉ audit thao tác ghi; interceptor chỉ gắn controller của module admin (r0) |
| S6-A46 | Thao tác endpoint dùng `OrgMutationLock` của tenancy | Cùng điểm tuần tự hoá và thứ tự khoá của SP3 | Khoá riêng của integrations |
| S6-A47 | Không làm in-app hay mở rộng notifications | Ngoài phụ lục C mục 6 | Làm theo ghi chú "dự kiến" của SP2 |
| S6-A48 | Khởi tạo upload không `@Idempotent()` | Response chứa capability | `@Idempotent()` |
| S6-A49 | (r1) Chia lỗi gửi webhook thành lỗi của endpoint và lỗi của ta; lỗi của ta không tiêu lịch, không đặt `failing_since` | Bulkhead dùng chung và worker chết là việc của hệ thống, không được làm endpoint khoẻ bị tự tắt | Đếm mọi lỗi như nhau (r0); trần số lần lỗi của ta (thêm cột, không có kịch bản cần) |
| S6-A50 | (r1) Gỡ bản public hai lượt, neo theo `published_at`, cộng P6 tự đọc lại sau khi sao | Đóng thứ tự "sao tới sau lượt gỡ đầu" mà không giữ khoá DB trong lúc gọi S3 | Giữ khoá dòng trong lúc `CopyObject` (trái luật "không I/O trong transaction"); chỉ gỡ khi lease hết (lease bị xoá khi `DELETE`, không dùng được làm mốc) |
| S6-A51 | (r1) Event `audit.staff_access.recorded` thuộc audit (6B), thay `admin.access.recorded` của admin (6D) | Bản cài port nằm ở audit; route admin của SP4/SP5 có trước 6D | Giữ ở admin (6D sau 6B, để hở cửa sổ) |
| S6-A52 | (r2, per R-X16) Token `FileUsageReader`/`WebhookStatsReader` ở `src/core/contracts/admin-readers.ts` (6.0); files/integrations cài, admin inject `@Optional()` | Admin không import `index.ts` của module tuỳ chọn, nên tắt từng module không làm composition ném và trường `null` là đúng thật; không thêm dòng `MODULE_REQUIRES` bắt dự án bật files chỉ vì bật admin | Token trong `index.ts` của files/integrations (r1): tắt module làm boot fail hoặc kéo config của module bị tắt vào lại; `MODULE_REQUIRES admin → files, integrations`: admin mất tính tuỳ chọn của hai trường |
| S6-A53 | (r2, per R-X15) SP6 cung cấp `@RequiresApproval()` + `requiresApprovalOf` + luật inventory (d); module chủ route gắn decorator và tự viết test liệt kê route của mình | Chủ route biết route nào là "tiền"; một danh sách route tiền do SP6 giữ cũng dễ quên như chính decorator và làm SP6 phụ thuộc tên route của SP5 | Danh sách/marker "route tiền" trong inventory của SP6 (phương án đầu của review X2-3): thêm cơ chế mà không thêm bảo đảm so với test của chủ route |
| S6-A54 | (r2, per R-X14) Helper sweep nhận tên hàm SQL + `extraParams` theo tên, runner gọi bằng ký hiệu theo tên và ép kiểu tường minh; test chữ ký trên `pg_proc` | Chữ ký của SP6 là chuẩn (R-X14); gọi theo tên loại bỏ lỗi đảo thứ tự tham số (X2-2); ép kiểu tường minh bỏ phụ thuộc vào ép kiểu ngầm của literal không kiểu | `extraArgs` theo vị trí (r1): đúng lỗi của mẫu SP7; callback TS (phương án (b) của review): mỗi module tự gọi hàm definer, luật "chỉ qua `EXECUTE` của `app_user`" rải ra nhiều chỗ |
| S6-A55 | (r2, per R-X13) Kiểm lúc boot `FileStorageLimitCheck` ở files, code do 4B thêm | Files là bên biết mình cần provider; `loadedModules()` cho biết `entitlements` bật mà không cần import nó; 4B mang code cùng adapter nên `main` không có trạng thái kiểm mà thiếu adapter | Kiểm trong composition (SP7): composition không biết port nào của module nào là bắt buộc; 6A mang kiểm: `main` vỡ từ W3 tới W4 |

### 19.2 Cần Sếp quyết (pháp lý hoặc tiền, không có nguồn; đã có mặc định để làm tiếp)

| # | Câu hỏi | Mặc định em đề xuất | Vì sao cần Sếp |
|---|---|---|---|
| C1 | Audit giữ bao lâu? | **13 tháng**, sàn cứng 6 tháng: **đã chốt theo rulings** (Sếp đổi được) | Nghĩa vụ lưu vết và giới hạn giữ dữ liệu cá nhân phụ thuộc pháp lý của từng dự án |
| C2 | Audit của org đã xoá cứng có được giữ tới hết retention không? | **Giữ** (chỉ id): **đã chốt theo rulings** | Liên quan việc xoá dữ liệu khi khách rời |
| C3 | Có lưu IP trong audit đăng nhập không? | **Không**: **đã chốt theo rulings** | IP là dữ liệu cá nhân |
| C4 | Hạn mức dung lượng mặc định mỗi org khi chưa có SP4 | **1 GiB** (config): **đã chốt theo rulings**; khi có SP4 là `fallback` của `files.storage_bytes` | Ảnh hưởng chi phí S3 |
| C5 | `sharp`/libvips (LGPL-3.0) được phân phối trong image | **Không đưa vào v1** (rulings C5, R-X9): port + no-op; dự án tự thêm adapter nếu pháp chế đồng ý | Spec cha §13.3 đã báo pháp chế, chưa có trả lời |

r1 không có câu hỏi pháp lý hoặc tiền mới cần Sếp.

---

## 20. Rủi ro và giả định

### 20.1 Rủi ro mở

| Rủi ro | Xử lý |
|---|---|
| Kích thước image: ước lượng ~365–370 MB sau SP3 + SP6 (đo lại không có `sharp`, §3.1), còn ~30 MB dưới mốc | X-6 đo ở 6.0, 6A, 6C bằng `docker image inspect`. Nếu vượt: (1) auto-instrumentations của OTel (ADR 0013; việc của SP7); (2) báo Sếp. Không tối ưu trước khi có số đo |
| Câu `SUM(stored_bytes)` dưới khoá org chậm khi một org có rất nhiều file | F-32 đo trên 100.000 file/org; metric `files_storage_used_query_seconds`; không đạt thì dừng và báo Sếp (phương án bảng đếm trái R-X8, §6.3) |
| 3D dừng ở T7(h) (SP3 r8) | 6B, 6D chờ 3D; 6.0, 6A, 6C không chờ (mục 17 bảng 0) |
| Bản public sống tới lượt xoá hẳn trong ca worker bị đóng băng lâu rồi chết giữa sao và đọc lại (R6-5 phần còn lại) | Ca hẹp có tên; nội dung đã qua quét; lượt xoá hẳn luôn gỡ `public/…` |
| Cron bảo trì partition hỏng làm ghi audit/webhook lỗi | Tạo trước 3 tháng; cảnh báo khi `< 2`; test A-11 |
| Audit không chống giả mạo trước kẻ có SQLi (chèn dòng giả) hoặc có quyền DB owner | Ghi ranh giới (§12.2). Chuỗi băm hoặc ghi ra kho WORM là điểm mở rộng khi có yêu cầu |
| M10 (review 6C, chấp nhận): `integrations_orgs_due` quét lại mọi dòng quá hạn ở mỗi lô, vì `UNION` không có `LIMIT` theo nhánh và index đến hạn nằm trên `next_attempt_at`, không trên `org_id` | Chi phí mỗi lô tỉ lệ với tổng backlog quá hạn của mọi org (backlog lớn, vd. sau mất Redis: mỗi lô của cron đọc lại toàn bộ dòng quá hạn rồi mới lọc `org_id > p_after`). Chấp nhận cho 6C (backlog bình thường nhỏ). Điểm mở rộng: index đến hạn theo org `(org_id, next_attempt_at)` hoặc cursor thay vì quét lại |
| M11 (review 6C, chấp nhận): `standardwebhooks` ký bằng `fast-sha256` JS thuần trên event loop | Khoảng vài ms mỗi lần gửi cho body 256 KB × 2 secret, nhân concurrency của `webhooks-out`. Chấp nhận cho 6C. Điểm mở rộng: HMAC của `node:crypto` (fallback đã có ở §4) |
| Một endpoint chậm làm trễ endpoint khác | Timeout 5 s, tự tắt sau 5 ngày; lỗi của ta không làm endpoint khoẻ bị tắt (R6-28); giới hạn in-flight theo endpoint `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` (R-X35, sửa theo review plan 6C); W-46 đo. Còn lại: trần theo org (nhiều endpoint chết của một org) là điểm mở rộng |
| MinIO hoặc provider S3 không tôn trọng `If-None-Match: *` trên `PutObject` (F3 không đạt) | Fallback ở spike F3 (key theo attempt + cột `variant_attempt`); chỉ ảnh hưởng khi dự án có adapter ảnh |
| Hook `session.create.after` không phủ mọi đường tạo session (B1) | Thêm hook theo path; ADR 0010 |
| Purge org có hàng trăm nghìn file hoặc delivery vượt timeout (DB-M13) | Như SP3 §9.5: alert + điểm mở rộng xoá theo lô |
| `StreamMaxLength` của clamd nhỏ hơn `FILES_SCAN_MAX_BYTES` | README; file lớn bị clamd đóng kết nối → lỗi quét → retry → sau `MAX` lần thì `PROCESSING_FAILED` (fail closed) |
| URL presign bị lộ trong TTL | TTL ngắn; `attachment`; chấp nhận |
| Plugin admin thêm path mới | Mặc định bị đòi phê duyệt (fail closed); D-24 so snapshot để path mới hiện ra trong review |
| Request lúc dùng phê duyệt lệch từng khoá với request đã duyệt (client serialize khác) | Fail closed (`403`); README hướng dẫn gửi lại đúng body đã duyệt |
| Khối lượng fan-out (event × endpoint) | Tối đa 10 endpoint mỗi org; partition; retention 1 tháng |

### 20.2 Giả định chưa kiểm chứng

1. Giao diện SP3 đúng như r8 (chưa có code):
   - `AuthFacts.authenticatedAt()`, `isPlatformAdmin()`;
   - `@OrgPurgeParticipantContributor`, `OrgActivityGate`/`onInactiveOrg`, `definePermissionCatalogue`, `tenancy_list_user_orgs`, `routeTemplateOf` (tenancy 3A, SP6 6.0 chuyển vào core);
   - cột `auth.security_notice.ticket`; hàm `adminTargetUserId`.

   Nếu SP3 đổi khi code, plan SP6 cập nhật theo.
2. **Hợp đồng của `@PlatformStaffAction()` (3D, per R-X2, R-X12):** (r2) đã có văn bản ở addendum 3D; điều còn giả định là 3D code đúng addendum (chưa có code). Riêng A1.4 của addendum (guard route-scoped thấy provider của module `@Global()` từ module của SP6) được PSA-5 của 3D kiểm.
3. (r2, đóng) Registry order đã có `integrations = 120` (addendum 3D §A4).
4. Kết quả các spike P1–P3, F1–F5, W1, B1, D1. Mỗi spike đều có fallback.
5. MinIO ép `content-length-range` của POST policy (F1) và `If-None-Match: *` của `PutObject` (F3).
6. `file-type` 22 nhận đúng DOCX/XLSX (định dạng dựa trên zip).
7. Số đo kích thước dependency lấy bằng `npm install` cho `linux-x64` (9 MB sau khi xoá map/khai báo kiểu), chưa đo bằng `pnpm` trong image. Số thật đo ở X-6.
8. Có thể `setProviderDefaults('webhooks-out', …)` trước lần gọi đầu tiên (lúc DI của integrations), đúng như hợp đồng hiện tại của `ResiliencePolicies`.
9. `Paginator.offset` dùng được cho catalog event type nhỏ (trả mọi dòng trong một trang).
10. SP4 r2 khai `files.storage_bytes` là `LIMIT` và cài `FileStorageLimit` như mục 18.4 (per R-X8, R-X13); SP7 r2 có `OPTIONAL_BRIDGES` và `loadedModules()` (7A). SP5 r2 (sửa song song) đổi hàm quét sang chữ ký R-X14 và gắn `@RequiresApproval()` (R-X15): SP6 chỉ đọc hai điều đó từ phán quyết.

---

## 21. Tự rà soát

- **Chỗ trống:**
  - Không còn "TBD".
  - Con số chưa đo (thời gian `EXPLAIN`, số đo W-46, kích thước image) được giao cho plan kèm tên test.
  - Tên hàm, bảng, cột, index, env và mã lỗi được ghi cụ thể.
- **Mâu thuẫn đã kiểm:**
  - Trạng thái `EXPIRED` của file không có event (§7.1, §10) và không nằm trong bảng event. Khớp.
  - Upload qua API trả `204`; đường hoàn tất cho `DIRECT_POST`/`MULTIPART` trả `200`. Khớp giữa §8.1 và §9.2.
  - `onInactiveOrg` của từng job khớp giữa §8 và §10: `files.process` là `skip`; `purge-org-objects`, `deliver-webhook`, `integrations.sweep-org` là `run` (sweep-org sửa theo review plan 6C).
  - `files.delete` điều khiển cả xoá lẫn khôi phục (§9.2, §7.1).
  - (r1) Không còn chỗ nào nhắc `file_storage_usage`, `sanitized` (cột), `sharp` như dependency, `@PlatformAdminOnly`, `admin.access.recorded` như event hiện hành, ADR 0018/0019 của SP6; order participant `files` = 110 ở §8.1 và §18.3; phụ thuộc plan khớp giữa đầu spec, §17 bảng 0 và bảng 1; race mới R6-28, R6-29 có test (W-34, A-26/D-22) và plan chủ (bảng 2).
- **Chỗ mơ hồ đã chốt:**
  - Cờ webhook của event files do 6A khai; dòng catalog do plan merge sau trong cặp 6A/6C thêm (bảng 4).
  - Thứ tự trong hook `before`: gate SP3 → `adminTargetUserId` → phê duyệt (6D) → audit `attempted` (6B).
  - Thứ tự trên route Nest: guard `@PlatformStaffAction()` (3D, gọi port audit truy cập của 6B) → `ApprovalGuard` (6D) → `IdempotencyInterceptor` → handler.
  - Admin và audit truy cập mở `OrgScope` theo org id từ path là ngoại lệ có tên (S6-A39).
- **Phạm vi:**
  - Chỉ gồm Files, Audit, Integrations, Admin (phụ lục C mục 6), cộng kill switch mà SP1 đã giao.
  - Việc được giao cho SP6 mà em không làm đều có lý do và được sửa chủ sở hữu ở spec nguồn: L6, L7, L9, L11.
  - YAGNI:
    - không có webhook nền tảng;
    - không tìm audit xuyên org;
    - không stream audit ra SIEM;
    - không tus;
    - không module operations (`recover` chạy đồng bộ theo lô).
- **Rủi ro lớn nhất (r2):** hợp đồng của `@PlatformStaffAction()` nay có văn bản (addendum 3D); rủi ro còn lại là code của 3D lệch addendum. Kiểm bằng A-26 (inventory đọc `hasPlatformStaffAction`, nhận biết `NoopPlatformAccessAudit`) và D-1 (bộ ca của addendum trên route thật).
- **(r2) Mâu thuẫn đã kiểm thêm:** một tên port `FileStorageLimit` và một chỗ cài (entry riêng của SP4) ở §1, §2.1, §5.2, §6.3, §8.1, §18.4; không còn "`forApi()`/`forWorker()`" cho adapter; không còn `FILES_DEFAULT_STORAGE_LIMIT_BYTES`; không còn `extraArgs` theo vị trí; admin không import `index.ts` của files/integrations ở §5.2, §8.4, §17; mọi câu về `@RequiresApproval()` nói "SP6 cung cấp, chủ route gắn".
- **Giả định yếu nhất:** câu `SUM(stored_bytes)` dưới khoá org đủ rẻ ở khối lượng thật (không còn bộ đếm, per R-X8). Kiểm bằng F-32 (`EXPLAIN (ANALYZE, BUFFERS)`, 100.000 file/org) trước khi merge 6A.

---

## 22. Nhật ký sửa r1

Nguồn: ba review vòng 1 (`sp4-7-review-interfaces.md` = **IF**, `sp4-7-review-money-security.md` = **MS**, `sp4-7-review-ops.md` = **OPS**) và rulings R-X1…R-X11. Mỗi dòng: mã, cách sửa, mục đã đổi.

### 22.1 Finding của review

| Mã | Cách sửa | Mục đổi |
|---|---|---|
| IF X-1 | Bỏ `@PlatformAdminOnly()` và `authorizeStaffRequest`; mọi route admin dùng `@PlatformStaffAction()` của 3D (per R-X2) | đầu spec, §1 (12), §2.1, §5.3, §8.4, §9.2, §9.4, §12.1 T9, §16 D-1, §18.3, §19 S6-A38 |
| IF X-2 | Audit truy cập đi qua port của decorator; 6B cài port (event `audit.staff_access.recorded`), áp cho route admin của SP4/SP5; bỏ `AccessAuditInterceptor` của module admin | §1 (12), §2.1, §5.1, §5.3, §8.4, §10, §16 A-27, D-2, §19 S6-A45, S6-A51 |
| IF X-3 | `audit` **và** `webhook` bắt buộc trên `defineEvent` (per R-X3, cả hai bắt buộc, chặt hơn đề xuất của review); 6.0 đặt giá trị cuối cho mọi event đang có | §2.1, §5.3, §10, §16 C-1, §17 bảng 5, §18.3, §18.4 |
| IF X-4 | `sweep_definer` dùng chung mọi SP; policy `<bảng>_definer_read`; `DEFINER_LIMIT_MAX`, `PURGE_CURSOR_START` chuyển vào core (per R-X4) | §2.1, §3.2, §5.1, §5.3, §6.3, §6.5, §18.1, §18.3, §19 S6-A18 |
| IF X-5 | `files` order 110 (per R-X5); `integrations` 120, xin thêm vào registry | §8.1, §8.3, §18.3, §20.2 |
| IF X-8 | Phụ thuộc thật từng plan theo R-X7: 6.0 ← 3A; 6A, 6C ← 6.0; 6B ← 6.0 + 3D; 6D ← 6B | đầu spec, §17 bảng 0, bảng 1, §19 S6-A1, §20.1 |
| IF X-9 | Một ADR 0020 cho SP6 (per R-X6; khác bảng đề xuất của review) | §2.1, §17 bảng 1, §18.5 |
| IF X-10 | `defineOrgSweep` + `OrgSweepRunner` trong 6.0, một luật `jobId` theo slot (per R-X4) | §5.1, §5.3, §8.1, §8.3, §10, §16 C-8, §18.1 |
| IF X-11 | Trích SP3 r8 (per R-X11); thêm rủi ro dừng 3D | đầu spec, §18.3, §20.1, §20.2 |
| IF X-12 | Đã có ở r0 (§9.1); không đổi | — |
| IF Q-1 | Hạn mức qua port `FileStorageLimit` dạng `Limit` của SP4; SP4 khai `LIMIT` và cài adapter (per R-X8) | §2.1, §5.1, §5.2, §6.3, §8.1, §11.2, §16 F-33, X-8, §18.4 |
| IF T-1 | Đề nghị ghi export của SP6 vào sổ export tenancy/identity của SP3 amendments | §18.3 |
| MS SP6-I1 | Trigger bị Postgres từ chối được **bỏ cùng bảng đếm** (per R-X8: không bộ đếm riêng); dung lượng = `SUM(stored_bytes)` dưới khoá org | §1 (1, 5), §6.1, §6.3, §6.9, §6.10, §8.1, §13 R6-1, R6-24, §16 F-30, F-32, F-60, §19 S6-A7 |
| MS SP6-M1 | Đếm **mọi** biến thể đang lưu (gốc, `clean`, thumbnail, bản public); hai phần không đếm (khoảng P1, part multipart dở) có lý do và giới hạn | §6.3 (quota), §16 F-30 |
| MS SP6-I2 | Bỏ `sharp` (per R-X9): port `ImageSanitizer` + no-op, cột `sanitized` thay bằng `clean_size_bytes`, biến thể ghi bằng `If-None-Match: *` nên R6-4 không còn dựa vào output tất định | §1 (3), §2.2, §3.1, §4 F3, §5.1, §5.4, §6.3, §8.1 P5, §11.2, §12.1 T2, §13 R6-4, §14, §16 F-12…F-15, §19 S6-A13, C5 |
| MS SP6-I3 | R6-5 đóng bằng ba lớp: ghi ý định trước, P6 đọc lại sau khi sao, sweep gỡ hai lượt neo theo `published_at` + `FILES_PUBLIC_RECHECK_SEC` (luật config); sửa câu tiêu chí 4 ("sau khi quét", không phải "sau `READY`") | §1 (4), §7.1, §8.1 P6 và Sweep, §11.2, §13 R6-5, §16 F-42, §19 S6-A50 |
| MS SP6-I4 | Phê duyệt mặc định từ chối trên `/admin/*` trừ danh sách miễn; phủ `impersonate-user`; gắn với `(method, path, query, body)`, không phụ thuộc path; dùng được cho route Nest (`@RequiresApproval()`) | §1 (9), §2.3 L4, §4 D1, §6.6, §7.5, §8.4, §9.3, §12.1 T10, §16 D-21…D-27, §19 S6-A41, S6-A43 |
| MS SP6-I5 | `PlatformStaffRouteInventory` lúc boot: route `/v1/admin/**` thiếu decorator, decorator ngoài `/v1/admin`, hoặc thiếu bản cài port → không khởi động | §1 (12), §5.3, §8.4, §16 A-26, §17 |
| MS SP6-I6 | `classifyAttempt` chia lỗi của endpoint và lỗi của ta; lỗi của ta không tiêu lịch (`cycle_base + 1`), không đặt `failing_since`; thêm `CIRCUIT_OPEN`; luật config bulkhead ≥ concurrency | §6.5, §7.2, §7.3, §8.3, §11.4, §13 R6-28, §14, §15, §16 W-34, §19 S6-A49 |
| MS SP5-M4 | SP6 nhận phê duyệt hai người cho thao tác tiền tay: cơ chế `@RequiresApproval()`, SP5 gắn lên route của mình | §2.3 L4, §8.4, §18.4 |
| MS SP4-I2 | Như IF X-5 | §8.1 |
| OPS SP6-I | Amendment D2 cho SP7: secret S3 cho api + worker, `FILES_S3_ACCESS_KEY_ID` xếp là secret, egress `objectStorage`/`clamd`/webhook | §18.4 |
| OPS SP6-M (concurrency) | Đối chiếu code: `files`, `webhooks-out` chạy ở `QUEUE_IO_CONCURRENCY` = 20 (override mặc định rỗng); bỏ câu "mặc định 2"; không ship override | §8.1, §11.4, §14, §16 W-46, §18.4 |
| OPS SP6-M (kích thước) | Đo lại không có `sharp`: 18 MB → 9 MB sau khi xoá map/khai báo kiểu; ước lượng ~365–370 MB; bỏ đòn bẩy "bỏ sharp" | §1 (15), §3.1, §20.1, §20.2 |
| OPS SP6-M (Helm) | Tách queue ra nhóm riêng phải thêm vào `default.queuesExclude` | §18.4 |
| OPS SP7-I8c | Cron quét ở `maintenance`, việc theo org ở queue của module (qua `defineOrgSweep`) | §5.3, §10 |

**Finding bị bác:** không có. Hai chỗ r1 làm khác đề xuất của review, theo rulings: IF X-1 đề xuất `@PlatformAdminOnly()` ship ở 4C (R-X2: `@PlatformStaffAction()` ở 3D); IF X-9 đề xuất 0019–0021 cho SP6 (R-X6: chỉ 0020). IF X-3 đề xuất giữ `webhook` tuỳ chọn; R-X3 bắt buộc cả hai.

### 22.2 Sửa kèm theo (tìm thấy khi đối chiếu code)

- `http-client.ts` ném `UpstreamError('rate_limited')` cho 429 và trả bình thường cho 3xx/4xx khác; `UpstreamFailure` có `circuit_open` mà r0 không map. §8.3 bước 4 viết lại theo đúng code.
- `TIMEOUT` là lỗi của endpoint vì thứ tự policy `bulkhead → breaker → timeout` (`policies.ts:42, 64`): thời gian chờ bulkhead không tính vào timeout.
- `@aws-sdk/client-s3` 3.1141.0 có `IfNoneMatch` trên `PutObject` (đã đọc `dist-cjs`); cơ sở cho F3 mới.
- Better Auth 1.7.6 có 15 endpoint `/admin/*` (đã đọc `plugins/admin/routes.mjs`); danh sách miễn và danh sách đòi phê duyệt ở §8.4 lấy từ đó.
- `ADMIN_DUAL_CONTROL=on` ở `external` không còn bị cấm: phần route Nest vẫn có tác dụng.
- Bỏ các env chỉ dành cho `sharp` (`FILES_IMAGE_*`, `FILES_THUMBNAIL_WIDTH`, `FILES_IMAGE_REENCODE_QUALITY`): chúng thuộc adapter của dự án.

---

## 23. Nhật ký sửa r2

Nguồn: review hội tụ vòng 2 `sp4-7-review-r2.md` (finding cho SP6: X2-1, X2-2, X2-3 phía SP6, X2-4, X2-5) và phán quyết R-X12…R-X19. Chỉ sửa phía SP6 của mỗi hợp đồng; phía SP4, SP7 do spec của chúng mang, SP5 sửa song song theo cùng phán quyết. **Kết quả: 5 finding đã sửa, 0 finding bị từ chối.** Hai chỗ r2 chọn một trong các phương án review đưa ra (ghi ở cột "Sửa"); đó không phải từ chối.

| Finding | Sửa | Mục đổi |
|---|---|---|
| X2-1 (port dung lượng: hai tên, chỗ cài lệch, không ai nạp) | Per R-X13: một port `FileStorageLimit` do SP6 sở hữu; §18.4 bỏ câu "SP4 cài trong `forApi()`/`forWorker()`", trỏ về entry riêng `modules/entitlements/integrations/files.ts` của SP4 và dòng `entitlements-files` của `OPTIONAL_BRIDGES` (SP7); kiểm lúc boot `FileStorageLimitCheck` (`loadedModules().has('entitlements')` mà không có provider → không khởi động), code do 4B thêm cùng adapter (S6-A55); tên hằng thống nhất: SP4 `FILES_STORAGE_FALLBACK_BYTES`, SP6 export `FILES_ORG_STORAGE_LIMIT_DEFAULT_BYTES` cho ST-3 của SP4; bỏ `FILES_DEFAULT_STORAGE_LIMIT_BYTES` | 1 (tiêu chí 5), 2.1, 5.1, 5.2, 5.3, 6.3, 8.1 bước 4, 11.2, 11 (hằng), 16 F-34, X-8, 17 bảng 0, 1, 5, 18.4, 19.1 S6-A55, 20.2 (10) |
| X2-2 (helper sweep: SP5/SP7 viết theo chữ ký SP6 không có) | Per R-X14 (phương án (a) của review, chữ ký SP6 là chuẩn): `extraArgs` theo vị trí đổi thành `extraParams` **theo tên**; runner gọi `public.<fn>(p_after => $1::uuid, p_limit => $2::integer, <tên> => $n::<kiểu>)` với ép kiểu tường minh theo kiểu JS; khoảng thời gian truyền bằng số nguyên giây; không nhận callback TS (luật "chỉ qua `EXECUTE` của `app_user`" giữ ở runner); test hợp đồng C-8b trên hàm definer thật và `org-sweep-signatures.spec.ts` đọc `pg_proc` cho mọi sweep đã đăng ký; `integrations_orgs_due` khai `extraParams` | 2.1, 5.3 (hàng `core/sweep`, chi tiết `core/sweep`), 6.8, 8.3 (Sweep), 16 C-8, C-8b, 17 bảng 1, 18.4 (SP5, SP7), 19.1 S6-A54 |
| X2-3 (phê duyệt hai người cho route tiền không có chủ), phía SP6 | Per R-X15: SP6 cung cấp `@RequiresApproval()`; bỏ mọi câu ngụ ý SP6 gắn nó lên route của SP5; SP5 sở hữu việc gắn lên ba route `assign`/`refunded`/`ignore` (5B phụ thuộc 6D). Lớp chặn máy: export `requiresApprovalOf` để chủ route viết test liệt kê route của mình, cộng luật inventory (d) "`@RequiresApproval()` phải đi cùng `@PlatformStaffAction()`"; không giữ danh sách "route tiền" trong SP6 (S6-A53, chọn phương án "test" của review). Tương tác với `@Idempotent()` (gửi lại → `403 admin_approval_invalid`) ghi vào mục SP5 của §18.4 để runbook của SP5 nhận | 1 (tiêu chí 12), 2.1, 5.3, 8.4 (bước 1, inventory), 16 D-28, 17 bảng 1, 18.3, 18.4, 19.1 S6-A53 |
| X2-4 (nghĩa vụ composition/secret của SP7; admin vỡ khi tắt module) | Per R-X16: mỗi `index.ts` của files, audit, integrations, admin gọi `markModuleLoaded` ở dòng đầu; dòng `MODULE_REQUIRES` (`files`/`integrations → tenancy`, `audit → identity, tenancy`, `admin → audit, identity, tenancy`); `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` mang `.meta({ secret: { roles: ['api', 'worker'] } })` (không còn dựa vào danh sách redact); token `FileUsageReader`/`WebhookStatsReader` chuyển ra `src/core/contracts/admin-readers.ts` (6.0), admin không import `index.ts` của files/integrations nên câu "trường `null` khi vắng module" đúng thật; luật kiến trúc 26, 27; test D-4, X-9, X-10 | Header, 2.1, 5.1, 5.2, 5.3, 5.4, 11.2, 16 D-4, X-9, X-10, 17 bảng 0, 1, 5, 18.4 (SP7), 19.1 S6-A52 |
| X2-5 (hợp đồng 3D chưa có văn bản) | Addendum 3D đã viết (R-X12): §5.2 dùng chữ ký đã chốt của `PlatformAccessAudit` (`record(entry)`, entry gồm `method`, `routeTemplate`, `params` là mọi path param, `actor`, `credentialKind`), bỏ chữ "tạm"; inventory đọc metadata qua `hasPlatformStaffAction` và nhận biết no-op bằng "không có provider **hoặc** `instanceof NoopPlatformAccessAudit`"; D-1 chạy bộ ca của addendum §A5; inventory vẫn ở 6B (R-X17); registry order có `integrations = 120` | Header, 1 (tiêu chí 12), 2.1, 5.2, 5.3, 8.4, 9.4, 10 (event), 16 A-26, D-1, 17 bảng 0, 1, 18.3, 20.2 (2, 3), 21 |

**Không thuộc SP6:** X2-6 (gán gói mỗi kỳ, SP4/SP5), X2-m1 (lớp lỗi SP4), X2-m2 (`_starter_prices` của SP7).

