/** Giá trị hợp lệ cho Express "trust proxy": boolean, số hop, hoặc danh sách địa chỉ/CIDR/tên preset. */
export function parseTrustProxy(raw: string): boolean | number | string[] {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tên preset mà `proxy-addr` (Express) hiểu. */
export const TRUST_PROXY_PRESETS = [
  'loopback',
  'linklocal',
  'uniquelocal',
] as const;

/** Dải bao trùm mọi địa chỉ: tin dải này tương đương `true` (ai cũng giả được X-Forwarded-For). */
const MATCH_ALL_RANGES = new Set(['0.0.0.0/0', '::/0']);

/** Nhận giá trị đã parse của config (kiểu `unknown` vì luật config đọc bản ghi không định kiểu). */
export const trustsEveryProxy = (v: unknown): boolean =>
  v === true ||
  (Array.isArray(v) &&
    v.some((a) => typeof a === 'string' && MATCH_ALL_RANGES.has(a)));
