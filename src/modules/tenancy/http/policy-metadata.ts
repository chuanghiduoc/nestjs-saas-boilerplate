import type { CatalogueDef } from '../domain/catalogue.js';

export const TENANCY_POLICY = 'tenancy:policy';
export const TENANCY_SENSITIVE = 'tenancy:sensitiveAction';
export const TENANCY_NARROWING = 'tenancy:narrowingAction';
export type TenancyPolicy =
  | { kind: 'PERMISSIONS'; catalogue: CatalogueDef; keys: readonly string[] }
  | { kind: 'MEMBER_ONLY' };
/** Tập route "thu hẹp" (spec SP3 §12): thêm một route là thay đổi review được. 3C, 3D thêm route của mình. */
export const NARROWING_ROUTES: readonly string[] = [
  'DELETE v1/orgs/:orgId/members/me',
];
/** Hai route ghi không mang marker nào (public, chỉ đọc; body POST chỉ để token không vào URL; route có ở 3C). */
export const MARKER_EXEMPT_ROUTES: readonly string[] = [
  'POST v1/invitations/preview',
  'POST v1/invite-links/preview',
];
