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

const DRIVER_ERROR_DROP = new Set([
  'query',
  'sql',
  'params',
  'parameters',
  'detail',
  'where',
  'bindings',
]);

export function errSerializer(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const out: Record<string, unknown> = {
    type: err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const [k, v] of Object.entries(err))
    if (!DRIVER_ERROR_DROP.has(k)) out[k] = v;
  if (err.cause) out.cause = errSerializer(err.cause);
  return out;
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
