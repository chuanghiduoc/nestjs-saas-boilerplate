import { z } from 'zod';

/**
 * Đọc body của Better Auth (chuyển từ `auth-hooks.ts`, plan 3D Task 7): `staff-hooks.ts` cần cùng các hàm mà không tạo
 * vòng import `auth-hooks.ts` ↔ `staff-hooks.ts`.
 */
export const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {};
export const stringField = (v: unknown, key: string): string | undefined => {
  const r = asRecord(v)[key];
  return typeof r === 'string' ? r : undefined;
};

/** Cùng `z.coerce.string()` của schema plugin admin (`plugins/admin/routes.mjs`), rồi đòi UUID. */
const PluginUserId = z.coerce.string().pipe(z.uuid());
/**
 * Id đích của `/admin/*` đúng như plugin đọc (spec SP3 §5.2, r7 N7-3, r8 R8-S2): `["<id>"]` thành `"<id>"`. Chỉ nhận dạng
 * chữ thường chuẩn, KHÔNG chuẩn hoá: Postgres so `uuid` không phân biệt hoa thường còn plugin so "chính mình" bằng chuỗi
 * thô, nên chỉ dạng chữ thường làm chuỗi hook đọc, chuỗi plugin so và user Postgres tìm là một. `undefined` → 422.
 */
export const adminTargetUserId = (body: unknown): string | undefined => {
  const parsed = PluginUserId.safeParse(asRecord(body).userId);
  if (!parsed.success) return undefined;
  return parsed.data === parsed.data.toLowerCase() ? parsed.data : undefined;
};
