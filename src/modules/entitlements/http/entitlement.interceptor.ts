import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, type Observable } from 'rxjs';
import { RequestContext } from '../../../core/context/index.js';
import { Entitlements } from '../application/entitlements.service.js';
import { EntitlementsContextError } from '../errors.js';
import {
  FEATURE_REQUIREMENTS,
  type FeatureRequirement,
} from './feature-metadata.js';

/**
 * Route-scoped, gắn bởi `requireEnabled` (S4-D7): Nest chạy mọi guard trước mọi interceptor, nên kiểm entitlement luôn sau
 * `PoliciesGuard` (member thiếu quyền không học được gì về gói); chạy bên trong `OrgScopeInterceptor` (global) nên đọc
 * snapshot dưới RLS mà không tự mở scope (spike S4-T1). Thiếu org context → lỗi lắp ráp (inventory Task 10 đã chặn lúc boot).
 */
@Injectable()
export class EntitlementInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContext,
    private readonly entitlements: Entitlements,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requirements = this.reflector.getAllAndMerge<FeatureRequirement[]>(
      FEATURE_REQUIREMENTS,
      [context.getHandler(), context.getClass()],
    );
    const [first, ...rest] = [...new Set(requirements.flatMap((r) => r.keys))];
    if (first === undefined)
      throw new EntitlementsContextError(
        'EntitlementInterceptor reached a handler without requireEnabled metadata',
      );
    if (this.ctx.orgId() === undefined || this.ctx.orgAccess() === undefined)
      throw new EntitlementsContextError(
        'requireEnabled on a route without organization context (tenant routes only)',
      );
    return from(this.entitlements.assertEnabled(first, ...rest)).pipe(
      mergeMap(() => next.handle()),
    );
  }
}
