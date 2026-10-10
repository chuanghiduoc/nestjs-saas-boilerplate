import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EntitlementRouteInventory } from '../application/entitlement-route-inventory.js';
import { OrgEntitlementsQuery } from '../application/org-entitlements.query.js';
import { AdminEntitlementsController } from './admin-entitlements.controller.js';
import { OrgEntitlementsController } from './org-entitlements.controller.js';

/**
 * Chỉ ở api (spec §6.2). `DiscoveryModule` không `@Global`: inventory cần nó ở chính module này (cùng lý do review I6 của 3A).
 * Deps của controller đến từ `EntitlementsCoreModule` (`@Global`). Controller admin dùng @PlatformStaffAction(): PlatformStaffGuard
 * đến từ PlatformStaffGuardModule (@Global, IdentityModule.forApi()), không import module nội bộ của identity (addendum 3D
 * §A1.4, PSA-5).
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [OrgEntitlementsController, AdminEntitlementsController],
  providers: [EntitlementRouteInventory, OrgEntitlementsQuery],
})
export class EntitlementsHttpModule {}
