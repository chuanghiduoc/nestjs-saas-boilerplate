import { TENANCY_CATALOGUE } from './domain/tenancy-catalogue.js';
import { definePermissionCatalogue } from './http/decorators.js';

/** Catalogue tenancy có `require(...)`; đây là đối tượng đăng ký vào registry (INT3-5a so danh tính đối tượng). */
export const TenancyPermissions = definePermissionCatalogue(
  TENANCY_CATALOGUE.name,
  TENANCY_CATALOGUE.entries,
);
