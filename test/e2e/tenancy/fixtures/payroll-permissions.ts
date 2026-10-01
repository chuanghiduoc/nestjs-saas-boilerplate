import { Injectable, Module } from '@nestjs/common';
import {
  PermissionCatalogueContributor,
  definePermissionCatalogue,
} from '../../../../src/modules/tenancy/index.js';
import { ownerQuery } from '../../../support/identity-app.js';

/** Spec SP3 §18.3 "X": quyền fixture `grantTo.admin = false`, không ownerOnly. */
export const PayrollPermissions = definePermissionCatalogue('payroll', {
  'payroll.read': {
    resource: 'payroll',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: false, member: false },
  },
});

@Injectable()
@PermissionCatalogueContributor(PayrollPermissions)
export class PayrollCatalogue {}

@Module({ providers: [PayrollCatalogue] })
export class PayrollPermissionsModule {}

export const installPayrollPermission = () =>
  ownerQuery(
    `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) VALUES ('payroll', 'read', false, false, false) ON CONFLICT ON CONSTRAINT permissions_key_uq DO NOTHING`,
  );
/** Gọi SAU khi mọi org có role giữ `payroll.read` đã dispose (FK RESTRICT) và app đã đóng. */
export const removePayrollPermission = () =>
  ownerQuery(`DELETE FROM permissions WHERE key = 'payroll.read'`);
/** Số dòng `permissions` của DB test: đọc trước khi cài fixture, khẳng định lại sau khi gỡ (không ghi số cứng, R-X24). */
export const permissionRowCount = async (): Promise<number> =>
  Number(
    (
      await ownerQuery<{ n: string }>(
        'SELECT count(*)::text AS n FROM permissions',
      )
    )[0]?.n,
  );
