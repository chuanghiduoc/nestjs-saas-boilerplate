/** Danh sách gốc, cố định trong code. Env chỉ được thêm vào, không thay thế. */
export const BASE_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'req.headers["x-sepay-signature"]',
  'res.headers["set-cookie"]',
  // Bearer của mobile: plugin `bearer` của Better Auth trả token session qua header này.
  'res.headers["set-auth-token"]',
  '*.headers["set-auth-token"]',
  '*.*.headers["set-auth-token"]',
  // Cookie trong header của request/response lồng (log của thư viện, lời gọi server của Better Auth).
  '*.headers.cookie',
  '*.*.headers.cookie',
  // Header của lời gọi ra ngoài (HttpClient) nếu bị log kèm init/options.
  '*.headers.authorization',
  '*.*.headers.authorization',
  '*.headers["proxy-authorization"]',
  '*.*.headers["proxy-authorization"]',
  /*
   * fast-redact (nền của pino) khớp đúng tên thuộc tính, phân biệt hoa/thường. `req`/`res.headers` của
   * Node (và Express/Fastify chạy trên nó) luôn viết thường nên không cần biến thể; nhưng object header
   * do ứng dụng tự dựng để gọi ra ngoài (`init.headers` của HttpClient, ví dụ literal 'Retry-After' đã
   * có trong upstream-error.ts) hoặc bị thư viện thứ ba log lại có thể giữ cách viết hoa theo quy ước
   * (`Authorization`, `Cookie`) — không đi qua tầng http của Node nên không được chuẩn hoá. Thêm biến
   * thể Title-Case cho các đường lồng này; `req`/`res.headers["x-api-key"]`, `x-sepay-signature` chỉ có ở
   * request/response Node thật, luôn viết thường (an toàn), nhưng vẫn thêm biến thể của header API key
   * để không phụ thuộc riêng vào đảm bảo đó khi object test/log không thật sự đi qua Node http.
   */
  '*.headers.Authorization',
  '*.*.headers.Authorization',
  '*.headers.Cookie',
  '*.*.headers.Cookie',
  '*.headers["Set-Auth-Token"]',
  '*.*.headers["Set-Auth-Token"]',
  'req.headers["X-Api-Key"]',
  // Keyring FieldCipher (env thô hoặc config đã parse).
  'FIELD_ENCRYPTION_KEYS',
  '*.FIELD_ENCRYPTION_KEYS',
  'security.keys',
  '*.security.keys',
  '*.password',
  '*.*.password',
  '*.token',
  '*.*.token',
  '*.secret',
  '*.*.secret',
  '*.apiKey',
  '*.*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.otp',
  '*.backupCodes',
  '*.clientSecret',
  '*.privateKey',
  'accessToken',
  'refreshToken',
  'password',
  'token',
  'secret',
] as const;

/**
 * Thuộc tính của error mang dữ liệu người dùng, không bao giờ được log (redact path của pino không
 * với tới vì giá trị thường nằm trong một chuỗi JSON):
 * - SQL/tham số/giá trị dòng của driver DB (pg, MikroORM `DriverException` chép nguyên các field của pg):
 *   `query`, `sql`, `params`, `parameters`, `detail`, `where`, `bindings`, `internalQuery`;
 * - tham số lệnh (`args`, `argv`): gồm body response idempotency đã lưu và payload job BullMQ;
 * - body: `body` của body-parser (request thô khi parse lỗi) và của undici `ResponseError` (body upstream);
 * - lỗi SMTP của nodemailer: `response`, `rejected`, `rejectedErrors`, `envelope`, `accepted`,
 *   `recipient` đều mang địa chỉ email (nodemailer `NodemailerError`/`SMTPSentMessageInfo`:
 *   `accepted`/`rejected` là người nhận đã gửi/bị từ chối, `recipient` là địa chỉ đơn của lỗi
 *   RCPT/DATA — không có field nào khác mang địa chỉ ở bản 10.0.10 đang dùng, đã soát mã nguồn).
 */
const ERROR_PAYLOAD_DROP = new Set([
  'query',
  'sql',
  'params',
  'parameters',
  'detail',
  'where',
  'bindings',
  'internalQuery',
  'args',
  'argv',
  'body',
  'response',
  'rejected',
  'rejectedErrors',
  'envelope',
  'accepted',
  'recipient',
]);

/**
 * Chỉ chữ hoa và khoảng trắng/gạch nối: đúng dạng động từ SMTP của nodemailer (`RCPT TO`,
 * `MAIL FROM`, `AUTH CRAM-MD5`, `CONN`...) — đã soát mã nguồn `smtp-connection`, động từ này luôn là
 * hằng số, không bao giờ nối thêm địa chỉ hay dữ liệu người dùng. Chuỗi không khớp mẫu (vd. bị nối
 * thêm gì đó ở bản nodemailer khác) bị bỏ, an toàn hơn là log nguyên văn.
 */
const SMTP_COMMAND_VERB = /^[A-Z][A-Z0-9]*(?:[ -][A-Z][A-Z0-9]*)*$/;

/**
 * ioredis gắn `command = { name, args }` vào ReplyError và AbortError: chỉ giữ tên lệnh. nodemailer
 * gắn `command` dạng chuỗi động từ SMTP (`'RCPT TO'`): giữ nguyên nếu khớp `SMTP_COMMAND_VERB`.
 */
function commandName(v: unknown): { name: string } | string | undefined {
  if (typeof v === 'string') return SMTP_COMMAND_VERB.test(v) ? v : undefined;
  return typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    typeof v.name === 'string'
    ? { name: v.name }
    : undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Error lồng trong thuộc tính (ioredis `previousErrors`/`lastNodeError`, `AppError.opts.cause`,
 * `AggregateError.errors`) cũng đi qua cùng luật lọc; nếu để pino tự `JSON.stringify` thì mọi
 * thuộc tính enumerable của nó (vd. `command.args`) lọt ra log.
 */
function sanitize(v: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof v !== 'object' || v === null) return v;
  if (ancestors.has(v)) return '[Circular]';
  if (v instanceof Error) return serializeError(v, ancestors);
  if (!Array.isArray(v) && !isPlainObject(v)) return v;
  ancestors.add(v);
  const out = Array.isArray(v)
    ? v.map((x) => sanitize(x, ancestors))
    : Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, sanitize(x, ancestors)]),
      );
  ancestors.delete(v);
  return out;
}

/**
 * `ancestors` chỉ chứa đường đi từ gốc (thêm trước khi đi xuống, bỏ khi quay lên): chỉ chu trình
 * thật thành '[Circular]'; cùng một error xuất hiện hai nhánh (`AppError.opts.cause` và `cause`)
 * vẫn được serialize đủ ở cả hai.
 */
function serializeError(
  err: Error,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  ancestors.add(err);
  const out: Record<string, unknown> = {
    type: err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const [k, v] of Object.entries(err)) {
    if (ERROR_PAYLOAD_DROP.has(k)) continue;
    out[k] = k === 'command' ? commandName(v) : sanitize(v, ancestors);
  }
  if (err.cause) out.cause = sanitize(err.cause, ancestors);
  ancestors.delete(err);
  return out;
}

export function errSerializer(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  return serializeError(err, new WeakSet());
}

/** Segment path mờ đủ dài để là token (Better Auth: token đặt lại mật khẩu nằm trong path). */
const OPAQUE_TOKEN_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDACTED_SEGMENT = '[redacted]';
const maskPath = (path: string): string =>
  path
    .split('/')
    .map((seg) =>
      OPAQUE_TOKEN_SEGMENT.test(seg) && !UUID_SEGMENT.test(seg)
        ? REDACTED_SEGMENT
        : seg,
    )
    .join('/');

export function reqSerializer(req: {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    method: req.method,
    url:
      req.url === undefined ? undefined : maskPath(req.url.split('?')[0] ?? ''),
    headers: req.headers,
  };
}
