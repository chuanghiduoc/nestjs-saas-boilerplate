/** Danh sách gốc, cố định trong code. Env chỉ được thêm vào, không thay thế. */
export const BASE_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'req.headers["x-sepay-signature"]',
  'res.headers["set-cookie"]',
  // Header của lời gọi ra ngoài (HttpClient) nếu bị log kèm init/options.
  '*.headers.authorization',
  '*.*.headers.authorization',
  '*.headers["proxy-authorization"]',
  '*.*.headers["proxy-authorization"]',
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
 * - body: `body` của body-parser (request thô khi parse lỗi) và của undici `ResponseError` (body upstream).
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
]);

/** ioredis gắn `command = { name, args }` vào ReplyError và AbortError: chỉ giữ tên lệnh. */
function commandName(v: unknown): { name: string } | undefined {
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

export function reqSerializer(req: {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    method: req.method,
    url: req.url?.split('?')[0],
    headers: req.headers,
  };
}
