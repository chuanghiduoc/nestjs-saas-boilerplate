export type DirectoryUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: string | null;
  banned: boolean;
  banExpires: Date | null;
  twoFactorEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** Cổng đọc dữ liệu identity duy nhất của app (spec §5.3): chạy trên pool `auth_user`. */
export abstract class IdentityDirectory {
  abstract findUser(id: string): Promise<DirectoryUser | undefined>;
  abstract findUserByEmail(
    normalizedEmail: string,
  ): Promise<DirectoryUser | undefined>;
  /**
   * Spec SP3 §5.2: một query cho cả trang (không N+1); id không tồn tại bị bỏ qua. Ném (trước khi query) khi quá
   * `AUTH_DIRECTORY_BATCH_MAX` id hoặc có id không phải UUID (lỗi nêu đúng các id sai).
   */
  abstract findUsers(ids: readonly string[]): Promise<DirectoryUser[]>;
}

/**
 * "Admin" của plugin `admin` Better Auth 1.7.6 (`plugins/admin/has-permission.mjs`: tách theo `,`, KHÔNG trim, so khớp
 * đúng phần tử, phân biệt hoa thường; `null`/`''` rơi về `defaultRole = 'user'`) với cấu hình của SP2 (`adminRoles:
 * ['admin']`, không `roles`, không `adminUserIds`). Spec SP3 §5.2 (r7 N7-2): bỏ `trim` — `trim` làm vị từ rộng hơn plugin
 * (role `user, admin` được coi là admin mà không dùng được `/admin/*`). Dùng ở `isPlatformAdmin`, `/v1/me`, gate nhân viên,
 * luật (8), `--for-promotion`, điều kiện grantee. Test tương đương: `admin-role-equivalence.spec.ts`.
 */
export const hasAdminRole = (role: string | null | undefined): boolean =>
  (role ?? '').split(',').includes('admin');

/**
 * `banned` và (`banExpires` NULL hoặc còn trong tương lai) — plugin api-key không tự kiểm (A.7). Nhận cả `DirectoryUser`
 * lẫn user của session Better Auth (hai trường này tuỳ chọn trong kiểu của plugin admin).
 */
export const isBanned = (
  u: { banned?: boolean | null; banExpires?: Date | null },
  now: Date,
): boolean =>
  u.banned === true &&
  (u.banExpires == null || u.banExpires.getTime() > now.getTime());
