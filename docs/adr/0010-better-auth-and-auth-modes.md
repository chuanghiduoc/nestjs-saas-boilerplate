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
