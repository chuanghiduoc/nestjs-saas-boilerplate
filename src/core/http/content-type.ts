type RawHeaders = Record<string, string | string[] | undefined>;

export const firstHeader = (
  h: RawHeaders,
  name: string,
): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Body có mặt khi Content-Length > 0 hoặc có Transfer-Encoding (chunked). */
export const requestHasBody = (h: RawHeaders): boolean =>
  Number(firstHeader(h, 'content-length') ?? 0) > 0 ||
  firstHeader(h, 'transfer-encoding') !== undefined;

/** Media type chữ thường, bỏ tham số (`; charset=…`). */
export const mediaTypeOf = (h: RawHeaders): string =>
  (firstHeader(h, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();

/** Tham số `charset` (chữ thường), `undefined` nếu không có. */
export const charsetOf = (h: RawHeaders): string | undefined =>
  /;\s*charset="?([^";]+)"?/i
    .exec(firstHeader(h, 'content-type') ?? '')?.[1]
    ?.trim()
    .toLowerCase();

export const isAllowedContentType = (
  h: RawHeaders,
  allowed: readonly string[],
): boolean => allowed.includes(mediaTypeOf(h));
