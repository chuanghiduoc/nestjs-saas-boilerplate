import { definePermissionCatalogue } from '../../modules/tenancy/index.js';

/**
 * Spec SP7 §7.2 (bảng 7.2). Dòng `permissions` cùng migration; `CatalogueCheck` của tenancy dừng boot khi lệch cờ.
 * `delete` không `apiKeyEligible`: key bị lộ không xoá được dữ liệu; support grant chỉ đọc.
 */
export const ExamplePermissions = definePermissionCatalogue('example', {
  'example_projects.read': {
    resource: 'example_projects',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: true,
    supportEligible: true,
    grantTo: { admin: true, member: true },
  },
  'example_projects.write': {
    resource: 'example_projects',
    action: 'write',
    requires: ['example_projects.read'],
    ownerOnly: false,
    apiKeyEligible: true,
    supportEligible: false,
    grantTo: { admin: true, member: true },
  },
  'example_projects.delete': {
    resource: 'example_projects',
    action: 'delete',
    requires: ['example_projects.read'],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: true, member: false },
  },
});
