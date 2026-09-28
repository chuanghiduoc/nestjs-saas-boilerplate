/** Spec SP3 §13 "Hằng số có tên": định dạng, dùng chung giữa zod và CHECK/hàm SQL (migration viết cứng cùng giá trị). */
export const ORG_NAME_MAX_LENGTH = 100;
/** Trần `p_limit` của hàm definer (`RAISE` khi vượt, DB-M3). */
export const DEFINER_LIMIT_MAX = 1000;
/** Con trỏ keyset lượt đầu của cron xoá cứng (UUID nil, nhỏ hơn mọi UUID v7; CDX-8). */
export const PURGE_CURSOR_START = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_ROLE_KEYS = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];
