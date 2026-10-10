import { definePermissionCatalogue } from '../tenancy/index.js';

/**
 * Spec SP6 §9.1. `webhooks.write` không `apiKeyEligible`: một key bị lộ không mở được kênh xuất dữ liệu (S6-A35); không
 * `supportEligible`. Thêm quyền có `grantTo.admin` làm `perms(ADMIN)` lớn lên (spec SP3 §8.2; README ghi hệ quả).
 */
export const WebhookPermissions = definePermissionCatalogue('integrations', {
  'webhooks.read': {
    resource: 'webhooks',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: true,
    supportEligible: true,
    grantTo: { admin: true, member: false },
  },
  'webhooks.write': {
    resource: 'webhooks',
    action: 'write',
    requires: ['webhooks.read'],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: true, member: false },
  },
});
