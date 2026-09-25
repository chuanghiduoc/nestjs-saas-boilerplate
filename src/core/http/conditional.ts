import { z } from 'zod';
import { AppError, CoreErrors } from '../errors/index.js';

const WEAK_PREFIX = 'W/';

/** ETag yếu lấy từ version của resource (ADR 0007). */
export const etagOf = (version: number | string): string =>
  `${WEAK_PREFIX}"${version}"`;

/** Các opaque-tag trong header (bỏ `W/`): ETag là version nên so sánh yếu là đủ. */
const opaqueTags = (header: string): string[] =>
  header
    .split(',')
    .map((t) => t.trim())
    .map((t) => (t.startsWith(WEAK_PREFIX) ? t.slice(WEAK_PREFIX.length) : t))
    .filter(Boolean);

export function assertIfMatch(
  ifMatch: string | undefined,
  version: number | string,
  opts: { required: boolean },
): void {
  if (!ifMatch?.trim()) {
    if (opts.required)
      throw new AppError(CoreErrors.PRECONDITION_REQUIRED, {
        detail: 'Send If-Match with the ETag from your last GET.',
      });
    return;
  }
  if (ifMatch.trim() === '*') return;
  if (!opaqueTags(ifMatch).includes(`"${version}"`)) {
    throw new AppError(CoreErrors.PRECONDITION_FAILED, {
      detail:
        'The resource was modified since you last read it. Fetch it again and retry.',
    });
  }
}

/** Schema nhận một JSON object (sẽ phải merge đệ quy theo RFC 7396), nhìn xuyên qua các lớp bọc. */
function acceptsJsonObject(t: unknown): boolean {
  if (t instanceof z.ZodObject || t instanceof z.ZodRecord) return true;
  if (
    t instanceof z.ZodOptional ||
    t instanceof z.ZodNullable ||
    t instanceof z.ZodDefault ||
    t instanceof z.ZodPrefault ||
    t instanceof z.ZodReadonly
  )
    return acceptsJsonObject(t.unwrap());
  if (t instanceof z.ZodPipe) return acceptsJsonObject(t.in);
  if (t instanceof z.ZodUnion) return t.options.some(acceptsJsonObject);
  if (t instanceof z.ZodIntersection)
    return acceptsJsonObject(t.def.left) || acceptsJsonObject(t.def.right);
  return false;
}

/**
 * JSON Merge Patch (RFC 7396): mọi field optional; `null` chỉ hợp lệ khi field gốc nullable
 * (xoá giá trị); field lạ bị từ chối.
 *
 * Bị từ chối lúc dựng schema (ADR 0007), vì cả hai đều âm thầm ghi đè dữ liệu client không gửi:
 * - field có `.default()`/`.prefault()`: trong zod 4 default vẫn chạy khi field vắng mặt;
 * - field là object/record lồng nhau: RFC 7396 đòi merge đệ quy, SP1 không làm, thay nguyên khối
 *   sẽ xoá các khoá con client không gửi (và `.strict()` chỉ áp ở cấp đầu).
 */
export function mergePatchSchema<S extends z.ZodObject>(schema: S) {
  for (const [key, field] of Object.entries(schema.shape)) {
    if (acceptsJsonObject(field))
      throw new Error(
        `mergePatchSchema: field "${key}" is a nested object; merge patch does not merge recursively. ` +
          'Model it as a sub-resource with its own endpoint, or replace it as a whole value using a ' +
          'different schema type (see ADR 0007)',
      );
  }
  const patch = schema.partial().strict();
  for (const [key, field] of Object.entries(patch.shape)) {
    const absent = z.safeParse(field, undefined);
    if (!absent.success || absent.data !== undefined)
      throw new Error(
        `mergePatchSchema: field "${key}" must not have a default (absent fields mean "unchanged")`,
      );
  }
  return patch;
}
