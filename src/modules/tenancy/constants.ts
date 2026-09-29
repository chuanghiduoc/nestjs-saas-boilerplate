/** Spec SP3 §13 "Hằng số có tên": định dạng, dùng chung giữa zod và CHECK/hàm SQL (migration viết cứng cùng giá trị). */
export const ORG_NAME_MAX_LENGTH = 100;
/** Trần `p_limit` của hàm definer (`RAISE` khi vượt, DB-M3). */
export const DEFINER_LIMIT_MAX = 1000;
/** Con trỏ keyset lượt đầu của cron xoá cứng (UUID nil, nhỏ hơn mọi UUID v7; CDX-8). */
export const PURGE_CURSOR_START = '00000000-0000-0000-0000-000000000000';
/**
 * Registry `order` của participant xoá cứng (R-X5, addendum 3D §A4): 1000 là bước xoá bảng tenancy core, luôn chạy SAU
 * mọi participant và không phải participant; participant nhận `order` trong `[0, TENANCY_CORE_PURGE_ORDER)`.
 */
export const TENANCY_CORE_PURGE_ORDER = 1000;
/** `core.scheduled-tasks` (R-X5): `scheduled_tasks` trỏ tới org bằng FK RESTRICT, xoá đầu tiên. */
export const SCHEDULED_TASKS_PURGE_ORDER = 0;
export const SYSTEM_ROLE_KEYS = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];
/** Khớp `org_roles_name_ck` / `org_roles_description_ck` của migration `tenancy_core` (đếm code point như `char_length`). */
export const ROLE_NAME_MAX_LENGTH = 64;
export const ROLE_DESCRIPTION_MAX_LENGTH = 500;
/** Biên đầu vào của `permissions` trong body tạo/sửa role (lớn hơn hẳn catalogue gộp; chặn body khổng lồ). */
export const ROLE_PERMISSIONS_MAX = 256;
