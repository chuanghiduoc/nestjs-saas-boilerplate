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

/**
 * JSON Merge Patch (RFC 7396): mọi field optional; `null` chỉ hợp lệ khi field gốc nullable
 * (xoá giá trị); field lạ bị từ chối. Object lồng nhau bị thay nguyên khối (chưa merge đệ quy, ADR 0007).
 *
 * Field có `.default()`/`.prefault()` bị từ chối lúc dựng schema: trong zod 4 default vẫn chạy khi
 * field vắng mặt, nên PATCH sẽ âm thầm ghi đè field client không gửi.
 */
export function mergePatchSchema<S extends z.ZodObject>(schema: S) {
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
