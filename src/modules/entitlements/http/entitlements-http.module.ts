import { Module } from '@nestjs/common';
import { OrgEntitlementsController } from './org-entitlements.controller.js';

/** Chỉ ở api (spec §6.2). Task 10 thêm `EntitlementRouteInventory`. Deps của controller đến từ `EntitlementsCoreModule` (`@Global`). */
@Module({ controllers: [OrgEntitlementsController] })
export class EntitlementsHttpModule {}
