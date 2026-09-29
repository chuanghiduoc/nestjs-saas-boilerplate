import { definePermissionCatalogue } from '../tenancy/index.js';

/**
 * Quyền đọc entitlement (S4-D17): tách khỏi `billing.read` (tiền, SP5). `grantTo.admin = true` làm `A = perms(ADMIN)` lớn
 * lên (SP3 §8.2): role tuỳ biến từng ⊇ A cũ thôi "tương đương admin" sau khi deploy 4A (README "nâng cấp lên SP4", X-12).
 */
export const EntitlementPermissions = definePermissionCatalogue(
  'entitlements',
  {
    'entitlements.read': {
      resource: 'entitlements',
      action: 'read',
      requires: ['org.read'],
      ownerOnly: false,
      apiKeyEligible: true,
      supportEligible: true,
      grantTo: { admin: true, member: true },
    },
  },
);
