import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { RequestContext } from '../../../core/context/index.js';
import { OrgScope } from '../../../core/database/index.js';
import { classifyOrgRoute, routeTemplateOf } from './org-route.js';
import { TENANCY_POLICY } from './policy-metadata.js';

/**
 * `APP_INTERCEPTOR` (spec SP3 §7.1 bước 7): route tenant chạy handler (và `IdempotencyInterceptor` của route, vốn nằm
 * trong interceptor toàn cục) trong `OrgScope(ctx.orgId())`. Thiếu metadata phân quyền hoặc `orgAccess` → ném (lớp
 * fail-closed thứ hai sau `OrgRouteInventory`). Phân loại cache theo controller rồi handler (handler kế thừa có template
 * khác nhau dưới mỗi controller), cùng matcher với inventory.
 */
@Injectable()
export class OrgScopeInterceptor implements NestInterceptor {
  private readonly tenantHandlers = new WeakMap<
    Function,
    WeakMap<Function, boolean>
  >();

  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContext,
    private readonly scope: OrgScope,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      context.getType() !== 'http' ||
      !this.isTenant(context.getClass(), context.getHandler())
    )
      return next.handle();
    if (
      !this.reflector.getAllAndOverride(TENANCY_POLICY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      throw new Error(
        'OrgScopeInterceptor: tenant route without tenancy policy metadata',
      );
    const orgId = this.ctx.orgId();
    if (!this.ctx.orgAccess() || orgId === undefined)
      throw new Error('OrgScopeInterceptor: tenant route without orgAccess');
    return from(
      this.scope.run(orgId, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }

  private isTenant(controller: Function, handler: Function): boolean {
    let byHandler = this.tenantHandlers.get(controller);
    if (!byHandler) {
      byHandler = new WeakMap();
      this.tenantHandlers.set(controller, byHandler);
    }
    const cached = byHandler.get(handler);
    if (cached !== undefined) return cached;
    const value = routeTemplateOf(controller, handler).some(
      (t) => classifyOrgRoute(t) === 'TENANT',
    );
    byHandler.set(handler, value);
    return value;
  }
}
