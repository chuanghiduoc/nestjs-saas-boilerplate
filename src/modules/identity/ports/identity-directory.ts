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
}

/** Plugin `admin` lưu role là chuỗi, có thể nhiều role nối dấu phẩy (spec §5.16b): so khớp đúng phần tử `admin`. */
export const hasAdminRole = (role: string | null | undefined): boolean =>
  (role ?? '')
    .split(',')
    .map((r) => r.trim())
    .includes('admin');

/** `banned` và (`banExpires` NULL hoặc còn trong tương lai) — plugin api-key không tự kiểm (A.7). */
export const isBanned = (u: DirectoryUser, now: Date): boolean =>
  u.banned && (u.banExpires === null || u.banExpires.getTime() > now.getTime());
