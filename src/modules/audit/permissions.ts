import { definePermissionCatalogue } from '../tenancy/index.js';

/**
 * Spec SP6 §9.1. `apiKeyEligible`: SIEM của khách đọc audit bằng org key; không `supportEligible` (nhân viên đọc qua route
 * admin của 6D, có audit truy cập riêng). Thêm quyền có `grantTo.admin` làm `perms(ADMIN)` lớn lên (spec SP3 §8.2).
 */
export const AuditPermissions = definePermissionCatalogue('audit', {
  'audit.read': {
    resource: 'audit',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: true,
    supportEligible: false,
    grantTo: { admin: true, member: false },
  },
});
