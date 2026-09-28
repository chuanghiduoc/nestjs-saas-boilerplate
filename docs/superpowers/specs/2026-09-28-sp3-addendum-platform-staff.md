# SP3 addendum (3D): `@PlatformStaffAction()`, port `PlatformAccessAudit`, registry order purge

- **Ngày:** 2026-09-28.
- **Chủ:** plan **3D** (identity + tenancy). Addendum này bổ sung spec SP3 r8 đã commit (`docs/superpowers/specs/2026-09-28-sp3-tenancy-access-design.md`, trích "SP3 §n"), không sửa câu nào của r8. Nó phải có trước khi viết plan 3D, 4C, 5B, 6B, 6D (R-X12, R-X17).
- **Phán quyết áp dụng:** R-X2 (một decorator nhân viên, port audit mặc định no-op, boot check), R-X5 (order purge), R-X12 (nội dung addendum), R-X17 (inventory lúc boot ở SP6 6B, không ở 3D).
- **Người dùng hợp đồng:** SP4 4C (route `/v1/admin/orgs/{orgId}/entitlements…`), SP5 5B (`/v1/admin/billing/…`), SP6 6B (bản cài port + `PlatformStaffRouteInventory`), SP6 6D (route của module admin), feature của dự án. Hình dạng dưới đây là bản hợp nhất của những gì ba spec đó (r1) giả định: SP4 §12.2 và AD-1, SP5 §6.7 và BT-E4, SP6 §5.2, §8.4 và §20.2 mục 2.
- **Đã đối chiếu với code** (worktree `sp2-identity`, HEAD `f6ed8d2`):
  - `AuthGuard` là `APP_GUARD` duy nhất của identity; nó xử lý `ANONYMOUS`/`REJECTED` → `401`, `EMAIL_NOT_VERIFIED` → `403`, `UNAVAILABLE` → `503` + `Retry-After` (`identityGuardConfig.unavailableRetryAfterSec`), và `API_KEY` trên route `@SessionOnly()` → `403 forbidden` (`src/modules/identity/http/auth.guard.ts`).
  - `PlatformAdminAuthorizer` của Bull Board là tiền lệ gần nhất: session + `isPlatformAdmin`, `API_KEY` → `403 forbidden`, không phải admin → `403 forbidden` (`infra/dashboard/platform-admin.authorizer.ts`). SP3 §5.2 (hàng `platform-admin.authorizer.ts`, 3D) thêm câu dấu TOTP vào nhánh session của nó.
  - Loại credential: `SESSION_COOKIE`, `BEARER_SESSION`, `API_KEY` ở `local`/`hybrid`; `EXTERNAL_COOKIE`, `EXTERNAL_BEARER` ở `external` (`credential-detector.ts:126,175,181`). Ở `external`, `API_KEY` bị `JwksAuthProvider` trả `REJECTED` (`jwks.provider.ts:100-103`), tức `401` từ `AuthGuard`. 3D thêm `ORG_API_KEY` (SP3 §5.2).
  - `AuthState` là provider của `IdentityHttpModule` (không `@Global`, không export) và chỉ đọc CLS (`http/auth-state.ts`). Guard route-scoped được Nest dựng trong injector của module chứa controller, nên mọi dependency của guard phải nhìn thấy được từ module của SP4/SP5/SP6. Addendum này vì vậy đòi một module `@Global()` (mục A1.4).
  - `EventPublisher.publish` nhận `actor` tường minh từ caller, còn org lấy từ `RequestContext` (`core/events/event-publisher.ts:18-58`). Vì vậy entry của port mang `actor` (mục A3).

---

## A1. Decorator `@PlatformStaffAction()`

### A1.1 Vị trí và export

- File: `src/modules/identity/http/platform-staff-action.decorator.ts` (decorator, khoá metadata, hàm đọc) và `src/modules/identity/http/platform-staff.guard.ts` (`PlatformStaffGuard`).
- Export ở `src/modules/identity/index.ts`: `PlatformStaffAction`, `PLATFORM_STAFF_ACTION`, `hasPlatformStaffAction`, `PlatformAccessAudit`, `NoopPlatformAccessAudit`, `type PlatformAccessEntry`.

```ts
export const PLATFORM_STAFF_ACTION = 'identity:platformStaffAction';

/** Route quyền nền tảng của nhân viên. Không có tham số. */
export const PlatformStaffAction = (): ClassDecorator & MethodDecorator =>
  applyDecorators(
    SetMetadata(PLATFORM_STAFF_ACTION, true),
    SessionOnly(),                       // AuthGuard từ chối API_KEY của Better Auth bằng 403 forbidden (code hiện có)
    UseGuards(PlatformStaffGuard),
  );

/** Đọc metadata cho inventory lúc boot (SP6 6B) và cho test của module khác. Handler trước, class sau. */
export function hasPlatformStaffAction(controller: Function, handler: Function): boolean;
```

- Đặt được ở method hoặc class. `hasPlatformStaffAction` trả `true` khi handler **hoặc** class mang metadata (cùng ngữ nghĩa `getAllAndOverride` mà `AuthGuard` dùng cho `SESSION_ONLY`).
- Không có tham số (không "mức nhân viên", không danh sách role). Không spec nào trong SP4, SP5, SP6 cần tham số; thêm tham số sau là thay đổi thêm, không phá.
- `@PlatformStaffAction()` phải là guard route-scoped **đầu tiên** của handler. `@RequiresApproval()` của SP6 6D đặt sau nó (SP6 §8.4); inventory của 6B kiểm hai decorator đi cùng nhau.

### A1.2 Ngữ nghĩa: dùng lại đúng gate step-up của SP3

Gate (3) của SP3 §9.7 và nhánh session của `PlatformAdminAuthorizer` (SP3 §5.2) đã định nghĩa "session nhân viên được dùng quyền nền tảng". `PlatformStaffGuard` áp **đúng** định nghĩa đó cho route Nest, không có câu SQL hay ngưỡng mới:

1. **Nhân viên** = `AuthState` là `AUTHENTICATED` và `isPlatformAdmin === true` (ở `local`/`hybrid` là `hasAdminRole(user.role)`, ở `external` là claim `AUTH_EXTERNAL_ADMIN_*` của SP2).
2. **Chỉ credential phiên:** `SESSION_COOKIE`, `BEARER_SESSION`, `EXTERNAL_COOKIE`, `EXTERNAL_BEARER`. `API_KEY` bị `AuthGuard` chặn nhờ `@SessionOnly()`; `ORG_API_KEY` bị `OrgApiKeyConfinementGuard` (SP3 3D, `APP_GUARD`) chặn trước vì route admin không phải route tenant. Guard vẫn `switch` vét cạn trên `CredentialKind` và từ chối hai loại này (lớp chặn thứ hai, không bao giờ là đường chính).
3. **`local` và `hybrid`** (credential `SESSION_COOKIE`/`BEARER_SESSION`): chạy **hàm kiểm dấu TOTP của `staff-step-up.ts`**, tức đúng câu "dấu TOTP" của SP3 §5.2 (hàng `auth-hooks.ts`, `method = 'totp'` trên factor hiện tại, pool `auth_user`, theo `session.id` nội bộ và user của session) và đúng ngưỡng `AUTH_SESSION_FRESH_AGE_SEC`. Cùng một hàm được gate (3) của hook và `PlatformAdminAuthorizer` gọi; 3D đặt tên hàm khi viết module đó (SP3 r8 chỉ định nội dung câu, không định tên), và guard này là lời gọi thứ ba của chính hàm đó. Dấu bằng backup code, dấu cũ, không có factor, session vừa bị thu hồi → từ chối, như SP3 §9.7 (3). Session tạo qua IdP ở `hybrid` là session Better Auth, nên đi đúng nhánh này (SP3 §9.7 (1): step-up trong session với mọi loại session).
4. **`external`** (credential `EXTERNAL_*`): không có Better Auth, MFA của nhân viên do IdP chịu, như Bull Board (SP3 §5.2 hàng `platform-admin.authorizer.ts`, SP3 §9.7 ranh giới (v)). Guard thêm đúng một điều kiện đã có ở SP3: **độ mới theo `auth_time`**, cùng luật với `@RequireFreshSession()` ở `external` (SP3 §11, SEC-I6): `AuthFacts.authenticatedAt()` thiếu hoặc cũ hơn `AUTH_SESSION_FRESH_AGE_SEC` → từ chối; không fallback `iat`. Lý do ở A6 (A-D3).
5. **Audit truy cập** (mục A3): chỉ khi 1–4 cho qua, guard gọi `PlatformAccessAudit.record(entry)` và `await`. Port ném → `503`, handler không chạy. Port chạy **trước** mọi interceptor route-scoped (Nest chạy mọi guard trước mọi interceptor), nên cũng trước `IdempotencyInterceptor`.
6. Guard không mở `OrgScope`. Service của route admin tự mở `OrgScope.run(orgId, …)` sau khi guard đã cho qua (ngoại lệ có tên S6-A39 của SP6, S4-D19 của SP4, và SP5 §4.2).

Hàm quyết định thuần `decideStaffAccess(input): StaffAccessDecision` (unit test mọi nhánh, `switch` vét cạn có kiểm `never`) nhận `{ auth: AuthResult; mode: AuthMode; totpMarkFresh?: boolean; authTimeFresh?: boolean }` và trả `ALLOW | UNAUTHENTICATED | FORBIDDEN | SECOND_FACTOR_REQUIRED | REAUTHENTICATION_REQUIRED`. Guard chỉ chạy câu dấu TOTP khi nhánh 3 cần nó (nhân viên, credential phiên, `local`/`hybrid`), nên request của người không phải nhân viên không bao giờ chạm pool `auth_user`.

### A1.3 Status theo `AUTH_MODE`

Mã lỗi đều đã có: `second_factor_required` và `reauthentication_required` thuộc identity (SP3 §15), còn lại thuộc core hoặc tenancy. Addendum không thêm mã nào.

| # | Trường hợp | `local` | `hybrid` | `external` | Nơi trả |
|---|---|---|---|---|---|
| S1 | Không credential; credential sai, hết hạn | `401 unauthenticated` | `401 unauthenticated` | `401 unauthenticated` | `AuthGuard` (có sẵn) |
| S2 | Nhiều credential, CSRF sai trên cookie | như SP2 | như SP2 | như SP2 | `PrincipalMiddleware` (có sẵn) |
| S3 | User chưa xác thực email (`EMAIL_NOT_VERIFIED`) | `403 email_not_verified` | `403 email_not_verified` | không xảy ra | `AuthGuard` (có sẵn) |
| S4 | API key của Better Auth (`x-api-key`) | `403 forbidden` | `403 forbidden` | `401 unauthenticated` (credential không thuộc mode) | `AuthGuard` + `@SessionOnly()` |
| S5 | Org API key `oak_` | `403 api_key_not_allowed_here` | `403 api_key_not_allowed_here` | `403 api_key_not_allowed_here` | `OrgApiKeyConfinementGuard` (3D) |
| S6 | Session hợp lệ, không phải nhân viên | `403 forbidden` | `403 forbidden` | `403 forbidden` | `PlatformStaffGuard` |
| S7 | Nhân viên chưa step-up, step-up bằng backup code, dấu cũ hơn `AUTH_SESSION_FRESH_AGE_SEC`, factor đã bị thay | `403 second_factor_required` | `403 second_factor_required` | không áp dụng | `PlatformStaffGuard` |
| S8 | Nhân viên, JWT thiếu `auth_time` hoặc `auth_time` cũ hơn `AUTH_SESSION_FRESH_AGE_SEC` | không áp dụng | không áp dụng | `403 reauthentication_required` | `PlatformStaffGuard` |
| S9 | Câu dấu TOTP lỗi hạ tầng (`isDbInfraError`) | `503 service_unavailable` + `Retry-After` | `503` + `Retry-After` | không có câu DB trong gate | `PlatformStaffGuard` |
| S10 | Kho xác thực lỗi (`UNAVAILABLE`) | `503` + `Retry-After` | `503` + `Retry-After` | `503` + `Retry-After` | `AuthGuard` (có sẵn) |
| S11 | Gate cho qua, `PlatformAccessAudit.record` ném | `503 service_unavailable` + `Retry-After` | như trái | như trái | `PlatformStaffGuard` |
| S12 | Gate cho qua, audit ghi xong | handler chạy | handler chạy | handler chạy | — |

- `Retry-After` của S9, S11 là `identityGuardConfig.unavailableRetryAfterSec`, cùng giá trị `AuthGuard` dùng cho S10.
- Handler khai `@PublicRoute()` cùng `@PlatformStaffAction()`: request không credential tới được guard ở trạng thái `ANONYMOUS`, guard trả `401 unauthenticated` (fail closed). Không có route admin công khai.
- Metric `identity_platform_staff_decisions_total{result}` với `result` ∈ `allowed`, `forbidden`, `second_factor_required`, `reauthentication_required`, `unavailable`, `audit_failed` (tập hữu hạn, không org, không user). Log DEBUG khi từ chối như `PlatformAdminAuthorizer.deny()`; log ERROR `platform_access_audit_failed` ở S11 (không kèm params).

### A1.4 Module và DI

- 3D thêm `PlatformStaffGuardModule` (`@Global()`, chỉ trong `IdentityModule.forApi()`): provide và export `PlatformStaffGuard`, `AuthState`, `AuthFacts` và dependency của hàm dấu TOTP (pool `auth_user` qua cổng có sẵn của `BetterAuthCoreModule`, vốn đã `@Global()`). `AuthState` chỉ đọc CLS, nên có thêm một instance ngoài `IdentityHttpModule` không đổi hành vi.
- Worker không có route HTTP, nên không có module này.
- Test DI (PSA-5) dựng một module fixture **không** import identity, đặt controller `/v1/admin/__fixture` có `@PlatformStaffAction()`, và khẳng định app khởi động và guard chạy. Đây là điều kiện để 4C, 5B, 6D dùng decorator mà không import module nội bộ của identity.

---

## A2. Metadata cho inventory của SP6 6B

- Inventory `PlatformStaffRouteInventory` (SP6 6B, R-X17) đọc metadata **chỉ** qua `hasPlatformStaffAction(controller, handler)` của identity, không đọc thẳng chuỗi khoá.
- `PLATFORM_STAFF_ACTION` vẫn được export: test của module khác và fixture dùng nó để dựng ca "metadata có mà không có guard" (inventory không tin khoá thô).
- Addendum **không** tự kiểm route lúc boot. Luật (a) thiếu decorator dưới `v1/admin`, (b) decorator ngoài `v1/admin`, (c) port chưa có bản cài thật là của 6B (R-X17, SP6 §8.4). Trước khi 6B merge, route admin nào đã có (4C) chạy với no-op; từ 6B, luật (c) đóng khoảng hở đó.

---

## A3. Port `PlatformAccessAudit`

```ts
export abstract class PlatformAccessAudit {
  /**
   * Ghi một lần truy cập mà gate nhân viên đã cho qua, TRƯỚC handler. Ném (mọi lỗi) → guard trả 503, handler không
   * chạy. Không được trả về trước khi bản ghi đã bền (commit). Không làm I/O ngoài DB.
   */
  abstract record(entry: PlatformAccessEntry): Promise<void>;
}

export type PlatformAccessEntry = {
  readonly method: string;                        // method HTTP chữ hoa của request, vd 'GET'
  readonly routeTemplate: string;                 // routeTemplateOf(controller, handler), vd 'v1/admin/orgs/:orgId/entitlements'
  readonly params: Readonly<Record<string, string>>; // mọi path param của template, giá trị như Express đã tách (req.params)
  readonly actor: { readonly type: 'user'; readonly id: string }; // principal.id của nhân viên
  readonly credentialKind: 'SESSION_COOKIE' | 'BEARER_SESSION' | 'EXTERNAL_COOKIE' | 'EXTERNAL_BEARER';
};

/** Mặc định khi chưa có bản cài (trước SP6 6B, hoặc dự án bỏ module audit). */
export class NoopPlatformAccessAudit extends PlatformAccessAudit {
  async record(): Promise<void> {}
}
```

- **Mẫu `@Global()` + `@Optional()` của SP3 §5.2** (`UserDeletionGuard`, `PlatformRoleChangeListener`): identity **không** đăng ký provider cho `PlatformAccessAudit`. Guard inject `@Optional() audit?: PlatformAccessAudit` và dùng `audit ?? NOOP_PLATFORM_ACCESS_AUDIT` (một instance `NoopPlatformAccessAudit` cấp module). Bản cài thật đến từ module `@Global()` của module khác, chỉ ở api: SP6 6B `AuditIdentityPortsModule` (SP6 §5.3).
- **Nhận biết no-op** (luật (c) của inventory 6B): port "chưa cài" nghĩa là tra `PlatformAccessAudit` không ra provider **hoặc** ra instance `instanceof NoopPlatformAccessAudit`. Vế thứ hai phủ trường hợp ai đó đăng ký no-op tường minh.
- **Guard truyền gì:**
  - `method`: `req.method` chữ hoa.
  - `routeTemplate`: `routeTemplateOf` của `core/http` (SP6 6.0 chuyển hàm này từ tenancy vào core; identity không được import tenancy). Template là thứ đã được route khớp, không phải URL thô, nên không mang query string.
  - `params`: mọi path param của template (route admin chỉ có id trong path: `orgId`, `userId`, `id`, `featureKey`…). Guard không lọc; bên cài quyết lưu gì. Query string và body **không** bao giờ vào entry (có thể chứa `reason`, mật khẩu).
  - `actor`: `{ type: 'user', id: principal.id }`, cùng dạng actor mà SP4/SP5/SP6 dùng cho thao tác của nhân viên.
  - `credentialKind`: loại credential đã qua gate, để audit phân biệt session Better Auth và JWT của IdP.
- **Không gọi port** cho request bị từ chối (S1–S10): từ chối đã có metric và log; audit ghi thao tác đã được phép chạy. Đây cũng là lý do `record` nằm sau quyết định chứ không trước.
- Bản cài đọc `RequestContext` như mọi code khác (correlation id của request đi vào envelope event). Bản cài chọn phạm vi org hay nền tảng theo `params.orgId` (SP6 §8.4).

---

## A4. Registry order của participant xoá cứng (R-X5, R-X12)

`OrgPurgeParticipant` và `@OrgPurgeParticipantContributor({ key, order })` giữ nguyên SP3 §9.5. Job purge gọi participant theo `order` tăng dần rồi tự xoá bảng tenancy (SP3 §9.5). Registry dưới đây cấp phát `order` cho boilerplate và mẫu:

| `order` | Participant (`key`) | Chủ (plan) | Xoá gì | Ghi chú |
|---|---|---|---|---|
| 0 | `core.scheduled-tasks` | SP3 3A | `scheduled_tasks` của org | Đã có ở SP3 §9.5; ghi lại để registry đầy đủ |
| 100 | `entitlements` | SP4 4A | `usage_counters`, `org_entitlement_overrides`, `org_entitlements` (con trước cha) | SP4 §13.2 |
| 110 | `files` | SP6 6A | dòng `files` (object storage dọn sau commit bằng job của subscriber `tenancy.org.purged`) | SP6 §8.1 |
| 120 | `integrations` | SP6 6C | năm bảng webhook, đúng thứ tự FK | Thêm theo R-X12 |
| 200 | `example.projects` | SP7 7D (vùng template) | `example_projects` | SP7 §10.3 |
| 1000 | tenancy core | SP3 3A | bảng tenancy theo thứ tự của SP3 §9.5, cuối cùng `organizations` | **Không phải participant.** Là bước xoá cố định của job, luôn chạy sau mọi participant; 1000 là giá trị dành riêng |

**Không phải participant (và vì sao):**
- **audit** (SP6 6B): audit của org đã xoá cứng được giữ tới hết retention (rulings SP6 C2, R-X5). `audit_logs` không có FK tới `organizations` (ngoại lệ có tên của SP6).
- **billing** (SP5): tiền được giữ, chỉ expire/void (rulings Q1, R-X5); account sống qua purge. Hệ quả cho khoá: transaction purge không bao giờ khoá `billing_accounts` (SP4 E-16).

**Luật (3D thêm vào registry participant của 3A):**
1. `key` duy nhất và `order` duy nhất (đã có ở 3A, SP3 §8.2).
2. **Mới:** `0 ≤ order < 1000` và `order` là số nguyên. Vi phạm → registry ném lúc boot, log ERROR liệt kê participant. 1000 trở lên dành cho tenancy core.
3. Dải gợi ý: boilerplate dùng 1–199; feature của dự án chọn một số chưa dùng trong 201–999 (checklist chép mẫu của SP7 §6.3.3). Chỉ luật 1 và 2 được kiểm bằng máy; dải gợi ý là quy ước README.
4. `order` chỉ có nghĩa với FK giữa bảng của các participant. Hôm nay không có FK nào giữa bảng của entitlements, files, integrations và mẫu, nên thứ tự tương đối giữa chúng không ảnh hưởng đúng sai; điều kiện duy nhất là chạy trước tenancy core. Module thêm FK tới bảng của module khác phải có `order` lớn hơn chủ bảng đích.

Mỗi plan chủ khẳng định `order` của mình bằng test (SP4 R-1, SP6 F-50/W-41, SP7 EX-I6). Addendum không có hằng code dùng chung cho các số này: mỗi module khai số của nó tại chỗ, registry là bảng này cộng luật 1–2.

---

## A5. Bộ ca test export cho module khác

3D export `test/support/platform-staff-action.conformance.ts`:

```ts
export type PlatformStaffConformanceTarget = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;                    // path thật, vd `/v1/admin/orgs/${orgId}/entitlements`
  readonly body?: unknown;                  // body hợp lệ tối thiểu, để ca "cho qua" đi tới handler
  readonly headers?: Readonly<Record<string, string>>; // vd If-Match, Idempotency-Key
  readonly expectAllowedStatus: number;     // status của handler khi cho qua (200, 201, 204…)
};
export function describePlatformStaffActionConformance(
  name: string,
  target: (ctx: ConformanceContext) => PlatformStaffConformanceTarget,
): void;
```

- Hàm chạy trên app thật (supertest, harness SP3 §18.0) ở cả ba `AUTH_MODE`, dùng principal nhân viên của `test/support/tenancy-principals.ts` và `seed-staff-step-up.ts` (SP3 §22.3 bảng 5, 3D).
- Ca chuẩn (mã khớp bảng A1.3): **C1** không credential → `401`; **C2** session không phải nhân viên → `403 forbidden`; **C3** API key Better Auth → `403 forbidden` (`local`/`hybrid`), `401` (`external`); **C4** org API key → `403 api_key_not_allowed_here`; **C5** nhân viên chưa step-up → `403 second_factor_required`; **C6** step-up bằng backup code → `403 second_factor_required`; **C7** dấu TOTP cũ hơn `AUTH_SESSION_FRESH_AGE_SEC` → `403 second_factor_required`; **C8** `external` thiếu `auth_time` → `403 reauthentication_required`, `auth_time` cũ → như vậy; **C9** nhân viên hợp lệ → `expectAllowedStatus`, port fixture nhận **đúng một** entry với `routeTemplate`, `params`, `actor`, `credentialKind` đúng, và bản ghi có trước khi handler chạy (seam trong handler fixture không áp được cho route thật, nên ca này kiểm thứ tự bằng port fixture ghi dấu thời gian và handler spy); **C10** port fixture ném → `503`, handler không chạy, DB của route không đổi.
- Ca **C11** (câu dấu TOTP lỗi hạ tầng → `503`) chỉ chạy trong test của 3D (cần Toxiproxy trên pool `auth_user`), không lặp ở module khác.
- Module khác gọi hàm này cho **mỗi** route admin của mình. Nó không định nghĩa lại mã lỗi nào và không test lại gate.

---

## A6. Quyết định và phương án đã loại

| # | Quyết định | Lý do | Phương án đã loại |
|---|---|---|---|
| A-D1 | Guard route-scoped (`UseGuards`), không phải interceptor | Nest chạy mọi guard trước mọi interceptor: request bị từ chối không chạm `IdempotencyInterceptor` (không lưu response lỗi dưới key của nhân viên), và audit ghi trước mọi interceptor route. `@RequiresApproval()` của SP6 là guard đặt sau | Interceptor: chạy sau `IdempotencyInterceptor` tuỳ thứ tự decorator; `APP_GUARD` toàn cục lọc theo path: gate chạy cả ở route không phải admin, inventory mất một khoá rõ ràng để kiểm |
| A-D2 | Không tham số | Không người dùng nào cần; một bất biến cho mọi route admin | Tham số `level`/`permissions`: chưa có mô hình quyền nhân viên chi tiết (SP3 dùng một role `admin`) |
| A-D3 | Ở `external` đòi `auth_time` tươi (luật `@RequireFreshSession()` của SP3 §11) | Route admin của SP4/SP5 đổi gói và gán tiền; ở `local`/`hybrid` chúng đòi TOTP tươi, còn ở `external` không có gì chứng minh nhân viên vừa xác thực lại. `auth_time` là cách SP3 đã chọn cho độ mới ở `external`; SP5 §6.7 giả định đúng điều này. Không thêm mã hay env | Giữ đúng hành vi Bull Board (không kiểm gì thêm ở `external`): Bull Board chỉ đọc, route admin có ghi; token IdP bị lấy cắp dùng được tới hết hạn |
| A-D4 | `@Optional()` + instance `NoopPlatformAccessAudit` cấp module, không đăng ký provider no-op | Cùng mẫu `UserDeletionGuard`/`PlatformRoleChangeListener`; hai module không tranh một token; inventory nhận biết "chưa cài" bằng hai vế | Identity đăng ký no-op làm provider mặc định: SP6 phải ghi đè provider cùng token, và bên thắng giữa hai module `@Global()` cùng token phụ thuộc thứ tự import, không phải một hợp đồng |
| A-D5 | Entry mang mọi path param, không mang query/body | SP5 thay log `billing_txn_viewed` bằng audit truy cập, nên id giao dịch trong path phải được ghi; path của route admin chỉ chứa id. Query/body có thể chứa lý do hay mật khẩu | Chỉ `orgId`/`userId` (SP6 r1): mất id giao dịch của SP5; ghi cả query/body: rò dữ liệu nhạy cảm vào audit |
| A-D6 | Không gọi port cho request bị từ chối | Metric và log đã có; audit là sổ của thao tác được phép | Ghi cả từ chối: một kẻ dò route admin tạo dòng audit không giới hạn |
| A-D7 | Registry order là bảng trong addendum + hai luật máy (duy nhất, `< 1000`), không có hằng code dùng chung | Mỗi module tự khai số tại chỗ như SP3 §9.5; hằng dùng chung sẽ buộc feature mẫu và dự án import số của nhau | Hằng `PURGE_ORDER` trong tenancy: mọi module phụ thuộc một file để lấy một số |

---

## A7. Test do 3D sở hữu

| Mã | Tầng | Nội dung |
|---|---|---|
| PSA-1 | unit | `decideStaffAccess`: mọi tổ hợp `AuthResult.kind` × `CredentialKind` × `AUTH_MODE` × (dấu TOTP tươi/cũ/không có) × (`auth_time` tươi/cũ/thiếu) cho đúng quyết định của bảng A1.3; kiểm `never` biên dịch |
| PSA-2 | unit | `hasPlatformStaffAction`: metadata trên method, trên class, không có; chỉ có `SetMetadata(PLATFORM_STAFF_ACTION)` mà không có guard vẫn trả `true` (hàm chỉ đọc metadata; luật "có guard" không phải việc của nó) |
| PSA-3 | e2e | `describePlatformStaffActionConformance` trên controller fixture `/v1/admin/__fixture` (GET và POST) ở `local`, `hybrid`, `external`: C1–C10 |
| PSA-4 | chaos | C11: Toxiproxy cắt pool `auth_user` trước câu dấu TOTP → `503` + `Retry-After`, handler không chạy, port không được gọi |
| PSA-5 | integration | DI: module fixture không import identity dùng `@PlatformStaffAction()` → app khởi động, C9 xanh (mục A1.4) |
| PSA-6 | e2e | Không có provider (`@Optional` ra `undefined`) → route chạy, dùng no-op; đăng ký fixture `PlatformAccessAudit` → nhận đúng entry; request bị từ chối (C2, C5, C8) → port không được gọi; query string và body của C9 không có trong entry |
| PSA-7 | e2e | Người không phải nhân viên không bao giờ chạm pool `auth_user` ở guard (đếm câu qua log `pg` của test) |
| PSA-8 | integration | Registry participant: `order` âm, không nguyên, `≥ 1000` → boot fail có danh sách; trùng `key`/`order` → fail (đã có ở 3A, chạy lại); `core.scheduled-tasks` giữ `0` |
| PSA-9 | unit | Kiến trúc: `modules/identity/index.ts` export đủ sáu tên của A1.1; file conformance chỉ import `test/support/*` và `index.ts` của module |

Tiêu chí SP3 chạy lại ở 3D: 12 (DB lỗi → `503`, thêm câu dấu TOTP của guard), 13 (ba `AUTH_MODE`), 16 (không PII: log từ chối không có params).

---

## A8. Thay đổi ở bảng plan của SP3 (§22.3) do addendum mang vào 3D

- **Bảng 1, hàng 3D:** thêm `@PlatformStaffAction()` + `PlatformStaffGuard` + `PlatformStaffGuardModule` (A1), `PlatformAccessAudit` + `NoopPlatformAccessAudit` (A3), luật `order < 1000` của registry participant (A4), `test/support/platform-staff-action.conformance.ts` (A5), metric `identity_platform_staff_decisions_total`.
- **Phụ thuộc mới của 3D:** `routeTemplateOf` ở `core/http` (SP6 6.0, W2, trước 3D ở W3 theo R-X7). 3D không import tenancy để lấy hàm này.
- **Bảng 3, hàng 3D:** PSA-1…PSA-9.
- **Bảng 5 (sửa code của plan trước):** registry participant của 3A thêm luật 2 (A4); `identity/index.ts` thêm export.

## A9. Nghĩa vụ của module dùng

| Plan | Nghĩa vụ |
|---|---|
| SP4 4C | Mọi route `/v1/admin/**` mang `@PlatformStaffAction()`; AD-1 gọi bộ ca A5 cho mỗi route |
| SP5 5B | Như trên cho `/v1/admin/billing/**`; BT-E4 gọi bộ ca A5; ba route tiền tay thêm `@RequiresApproval()` của SP6 sau `@PlatformStaffAction()` (R-X15) |
| SP6 6B | `PlatformAccessAuditAdapter` cài port theo A3 (ghi trong `UnitOfWork` riêng, commit trước khi trả); `PlatformStaffRouteInventory` đọc metadata qua `hasPlatformStaffAction` và nhận biết no-op theo A3 (R-X17) |
| SP6 6D | Như 4C cho route của module admin; D-1 gọi bộ ca A5 |
| Plan merge sau trong cặp 4C/6B | Chạy ca inventory (A-26 của SP6) trên tập route thật có route của SP4 |

## A10. Giả định chưa kiểm bằng chạy code

1. Guard route-scoped khai bằng class trong `UseGuards` được Nest dựng trong injector của module chứa controller và thấy provider của module `@Global()` (hành vi đã biết của Nest; PSA-5 kiểm).
2. `routeTemplateOf` đã ở `core/http` khi 3D bắt đầu (SP6 6.0 ở W2). Nếu 6.0 trễ, 3D chờ 6.0; không nhân bản hàm.
3. SP3 3D đưa `session.id` nội bộ vào `AUTHENTICATED` (SP3 §5.2) và câu dấu TOTP của `staff-step-up.ts` nhận `(userId, sessionId)` như SP3 §5.2 mô tả. Hai điều này là nội dung của 3D, chưa có code.
4. Rủi ro dừng 3D theo SP3 r8 §4 T7(h) kéo theo 4C, 5B, 6B, 6D.
