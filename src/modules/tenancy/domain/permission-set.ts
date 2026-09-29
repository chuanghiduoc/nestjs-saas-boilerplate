import { UnknownPermissionError, type MergedCatalogue } from './catalogue.js';

/** Đóng tập theo `requires` (PR5); key lạ → lỗi có tên (fail loud, SEC-M10). */
export function closure(
  keys: Iterable<string>,
  merged: MergedCatalogue,
): Set<string> {
  const out = new Set<string>();
  const stack = [...keys];
  while (stack.length) {
    const k = stack.pop();
    if (k === undefined || out.has(k)) continue;
    const e = merged.get(k);
    if (!e) throw new UnknownPermissionError(k);
    out.add(k);
    stack.push(...e.requires);
  }
  return out;
}
export const isSubset = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean => [...a].every((k) => b.has(k));
/** Tập con THỰC SỰ (S3-A4: non-owner chỉ tạo/gán/quản lý thứ nhỏ hơn hẳn mình). */
export const isStrictSubset = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean => a.size < b.size && isSubset(a, b);
