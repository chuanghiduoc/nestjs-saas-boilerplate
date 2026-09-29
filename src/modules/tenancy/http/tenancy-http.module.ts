import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SqlAccessReader } from '../infra/sql/sql-access.reader.js';
import { AccessReader } from '../ports/access-reader.js';
import {
  OrgContextMiddleware,
  orgMissBucketProvider,
} from './org-context.middleware.js';
import { ORG_ROUTE_PATTERN } from './org-route.js';
import { OrgScopeInterceptor } from './org-scope.interceptor.js';

/**
 * Chỉ ở api. Controller của tenancy (Task 23, 24) khai ở đây; `TENANCY_CONTROLLER_MODULES` liệt kê module này.
 * `OrgContextMiddleware` KHÔNG nằm trong `providers` (review C1): Nest resolve middleware qua `consumer.apply` với DI của
 * chính module này; khai thêm ở `providers` chỉ dựng một instance thừa.
 */
@Module({
  providers: [
    SqlAccessReader,
    { provide: AccessReader, useExisting: SqlAccessReader },
    orgMissBucketProvider,
    { provide: APP_INTERCEPTOR, useClass: OrgScopeInterceptor },
  ],
})
export class TenancyHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // MỘT pattern: middleware chạy đúng một lần mỗi request (spec SP3 §7.4, INT3-2).
    consumer.apply(OrgContextMiddleware).forRoutes(ORG_ROUTE_PATTERN);
  }
}
