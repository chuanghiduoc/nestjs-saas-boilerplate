import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EntitlementRouteInventory } from '../application/entitlement-route-inventory.js';
import { OrgEntitlementsController } from './org-entitlements.controller.js';

/**
 * Chỉ ở api (spec §6.2). `DiscoveryModule` không `@Global`: inventory cần nó ở chính module này (cùng lý do review I6 của 3A).
 * Deps của controller đến từ `EntitlementsCoreModule` (`@Global`).
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [OrgEntitlementsController],
  providers: [EntitlementRouteInventory],
})
export class EntitlementsHttpModule {}
