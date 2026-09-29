import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Type,
} from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { MemberService } from '../application/member.service.js';
import { RoleService } from '../application/role.service.js';
import { OrgService } from '../application/org.service.js';
import {
  OrgRouteInventory,
  TENANCY_CONTROLLER_MODULES,
} from '../application/org-route-inventory.js';
import { SqlAccessReader } from '../infra/sql/sql-access.reader.js';
import { AccessReader } from '../ports/access-reader.js';
import {
  OrgContextMiddleware,
  orgMissBucketProvider,
} from './org-context.middleware.js';
import { ORG_ROUTE_PATTERN } from './org-route.js';
import { MembersController } from './members.controller.js';
import { OrgScopeInterceptor } from './org-scope.interceptor.js';
import { OrgController } from './org.controller.js';
import { OrgsController } from './orgs.controller.js';
import { PermissionsController } from './permissions.controller.js';
import { RolesController } from './roles.controller.js';

/**
 * Chỉ ở api. Controller của tenancy (Task 23, 24) khai ở đây; `TENANCY_CONTROLLER_MODULES` liệt kê module này.
 * `OrgContextMiddleware` KHÔNG nằm trong `providers` (review C1): Nest resolve middleware qua `consumer.apply` với DI của
 * chính module này; khai thêm ở `providers` chỉ dựng một instance thừa.
 */
@Module({
  // `DiscoveryModule` không `@Global` và `TenancyCoreModule` không export `DiscoveryService`: `OrgRouteInventory` cần nó
  // ở chính module này (review I6).
  imports: [DiscoveryModule],
  controllers: [
    OrgsController,
    OrgController,
    PermissionsController,
    MembersController,
    RolesController,
  ],
  providers: [
    SqlAccessReader,
    { provide: AccessReader, useExisting: SqlAccessReader },
    orgMissBucketProvider,
    { provide: APP_INTERCEPTOR, useClass: OrgScopeInterceptor },
    OrgService,
    RoleService,
    MemberService,
    OrgRouteInventory,
    // Hàm (không phải hằng) vì module tự tham chiếu chính nó: đọc lúc DI, sau khi class đã định nghĩa.
    {
      provide: TENANCY_CONTROLLER_MODULES,
      useFactory: tenancyControllerModules,
    },
  ],
})
export class TenancyHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // MỘT pattern: middleware chạy đúng một lần mỗi request (spec SP3 §7.4, INT3-2).
    consumer.apply(OrgContextMiddleware).forRoutes(ORG_ROUTE_PATTERN);
  }
}

/** Mọi module có controller của tenancy (luật G-8); unit test so với cây import của `TenancyModule.forApi()`. */
export function tenancyControllerModules(): Type[] {
  return [TenancyHttpModule];
}
