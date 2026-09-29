/** Nguồn cấp quyền trong một org (spec SP3 §5.2). `SUPPORT_GRANT`, `ORG_API_KEY` có từ plan 3D. */
export const ORG_ACCESS_VIAS = [
  'MEMBERSHIP',
  'SUPPORT_GRANT',
  'ORG_API_KEY',
] as const;
export type OrgAccessVia = (typeof ORG_ACCESS_VIAS)[number];
/**
 * Quyết định của `OrgContextMiddleware` cho request tenant, tính một lần và đọc lại ở guard. `ref` là public id của
 * member/grant/key (không phải PII), vào mọi dòng log. `permissions` không bao giờ vào log.
 */
export type OrgAccess = {
  via: OrgAccessVia;
  ref: string;
  permissions: readonly string[];
  orgDeleted: boolean;
};
export const isOrgAccessVia = (v: string): v is OrgAccessVia =>
  (ORG_ACCESS_VIAS as readonly string[]).includes(v);
