/**
 * Spec SP3 §5.2 (3D, r5 N5-1), §9.7 (6): mọi lần ghi role nền tảng qua `/admin/set-role` hoặc `/admin/update-user` có
 * `data.role` (thành công) thu hồi mọi support grant chưa thu hồi của user đó ở mọi org. Tenancy cài trong
 * `TenancyIdentityPortsModule` (`@Global`, chỉ api); identity inject `@Optional()` (identity không import tenancy). Chỉ
 * ném với lỗi hạ tầng hoặc lỗi lập trình; gọi lại cùng id là idempotent.
 */
export abstract class PlatformRoleChangeListener {
  abstract onPlatformRoleChanged(authUserId: string): Promise<void>;
}
