/** Spec SP3 §13 "Hằng số có tên": định dạng, dùng chung giữa zod và CHECK/hàm SQL (migration viết cứng cùng giá trị). */
export const ORG_NAME_MAX_LENGTH = 100;
/**
 * Chuyển vào `core/sweep` ở SP6 6.0. Import file lá `constants.ts` (không phải index của `core/sweep`): `domain/` của tenancy
 * import file này và không được kéo theo runner/queue.
 */
export {
  DEFINER_LIMIT_MAX,
  PURGE_CURSOR_START,
} from '../../core/sweep/constants.js';
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
/** Biên đầu vào của `permissions` trong body tạo key/grant (cùng biên với role). */
export const DELEGATION_PERMISSIONS_MAX = ROLE_PERMISSIONS_MAX;
/** Spec SP3 §13: token lời mời/link 256 bit (`randomBytes`), lưu SHA-256 (32 byte; khớp `*_token_hash_ck`). */
export const INVITE_TOKEN_BYTES = 32;
export const TOKEN_HASH_BYTES = 32;
/** Khớp `org_invitations_email_ck` (`char_length(email) <= 254`). */
export const INVITATION_EMAIL_MAX_LENGTH = 254;
/** Biên đầu vào của `token` trong body preview/accept/join: token thật là 43 ký tự base64url; chặn body khổng lồ. */
export const TOKEN_INPUT_MAX_LENGTH = 128;
/** Role hệ thống người khởi tạo nhận sau khi chuyển quyền (khớp `org_ownership_transfers_step_down_ck`). */
export const STEP_DOWN_ROLES = ['ADMIN', 'MEMBER'] as const;
export type StepDownRole = (typeof STEP_DOWN_ROLES)[number];
/** Tên hiển thị của role hệ thống trong thư (spec §6.5: tên role hệ thống không lưu; thư chỉ có locale mặc định). */
export const SYSTEM_ROLE_LABELS: Readonly<Record<SystemRoleKey, string>> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};
/** Spec SP3 §10, §13: org key = `oak_` + base64url(32 byte); `key_hint` = `oak_` + 6 ký tự đầu phần ngẫu nhiên (`org_api_keys_key_hint_ck`). */
export const ORG_API_KEY_SECRET_BYTES = 32;
export const KEY_HINT_LENGTH = 6;
/** Khớp `org_api_keys_name_ck` / `org_support_grants_reason_ck` của migration `delegation` (đếm code point như `char_length`). */
export const ORG_API_KEY_NAME_MAX_LENGTH = 64;
export const SUPPORT_GRANT_REASON_MAX_LENGTH = 500;
