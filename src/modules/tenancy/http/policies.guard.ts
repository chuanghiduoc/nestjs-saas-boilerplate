import { ForbiddenError } from '@casl/ability';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { buildAbility } from '../application/authz/ability.factory.js';
import { PermissionCatalogueRegistry } from '../application/permission-catalogue.registry.js';
import { TenancyMetrics } from '../application/tenancy-metrics.js';
import { UnknownPermissionError } from '../domain/catalogue.js';
import { TENANCY_TRACER } from '../tenancy-telemetry.js';
import {
  ORG_RESTORE_TEMPLATE,
  RequestMethodName,
  routeTemplateOf,
} from './org-route.js';
import { TENANCY_POLICY, type TenancyPolicy } from './policy-metadata.js';

/** So method bằng tên (`RequestMethodName`), không phụ thuộc giá trị số của enum `RequestMethod`. */
const POST = 'POST';

/**
 * Route-scoped (spec SP3 §7.1 bước 5): luôn chạy sau mọi APP_GUARD. Quyết định chỉ là tư vấn cho mutation quản trị
 * (service kiểm lại dưới khoá org, §8.6). `ForbiddenError.message` (action/subject) chỉ vào log, không vào body (SEC-M10).
 */
@Injectable()
export class PoliciesGuard implements CanActivate {
  private readonly logger = new Logger(PoliciesGuard.name);
  private readonly restoreHandlers = new WeakMap<Function, boolean>();

  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContext,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
  ) {}

  /**
   * Span `tenancy.policy.check` (spec SP3 §16, review M4) với `tenancy.policy.result` ∈ `allowed | denied | error` (enum
   * hữu hạn, không key quyền, không org/user). Span mở đồng bộ (`startActiveSpan` trả nguyên giá trị của callback), nên
   * `canActivate` vẫn đồng bộ như test đơn vị của guard đòi.
   */
  canActivate(context: ExecutionContext): boolean {
    return trace
      .getTracer(TENANCY_TRACER)
      .startActiveSpan('tenancy.policy.check', (span) => {
        try {
          const allowed = this.decide(context);
          span.setAttribute('tenancy.policy.result', 'allowed');
          return allowed;
        } catch (err) {
          const denied =
            err instanceof AppError && err.error === CoreErrors.FORBIDDEN;
          span.setAttributes({
            'tenancy.policy.result': denied ? 'denied' : 'error',
            'error.type':
              err instanceof Error ? err.constructor.name : typeof err,
          });
          throw err;
        } finally {
          span.end();
        }
      });
  }

  private decide(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const policy = this.reflector.getAllAndOverride<TenancyPolicy | undefined>(
      TENANCY_POLICY,
      [handler, context.getClass()],
    );
    if (!policy)
      throw new Error(
        'PoliciesGuard reached a handler without tenancy policy metadata',
      );
    const access = this.ctx.orgAccess();
    if (!access)
      throw new Error(
        'PoliciesGuard found no orgAccess on a tenant route (OrgContextMiddleware did not run)',
      );
    if (
      access.orgDeleted &&
      !this.isRestoreHandler(context.getClass(), handler)
    )
      throw new Error(
        'PoliciesGuard: a soft-deleted organization reached a handler other than restore',
      );
    switch (policy.kind) {
      case 'MEMBER_ONLY':
        if (access.via !== 'MEMBERSHIP') this.deny('member_only', undefined);
        return true;
      case 'PERMISSIONS':
        this.requireAll(policy.keys, access.permissions);
        return true;
      default: {
        const unknown: never = policy;
        throw new Error(`unknown tenancy policy ${JSON.stringify(unknown)}`);
      }
    }
  }

  private requireAll(
    keys: readonly string[],
    permissions: readonly string[],
  ): void {
    const merged = this.registry.merged();
    const ability = buildAbility(permissions, merged);
    for (const key of keys) {
      const entry = merged.get(key);
      if (!entry) throw new UnknownPermissionError(key);
      try {
        ForbiddenError.from(ability).throwUnlessCan(
          entry.action,
          entry.resource,
        );
      } catch (err) {
        // G-5: chỉ lỗi của CASL thành 403; so bằng instanceof, không bằng tên class.
        if (err instanceof ForbiddenError) this.deny('permission', key);
        throw err;
      }
    }
  }

  private deny(
    reason: 'permission' | 'member_only',
    missing: string | undefined,
  ): never {
    this.metrics.policyDenied.add(1, { reason });
    this.logger.warn(
      { event: 'policy_denied', reason, ...(missing ? { missing } : {}) },
      'tenancy policy denied the request',
    );
    throw new AppError(CoreErrors.FORBIDDEN, { expected: true });
  }

  private isRestoreHandler(controller: Function, handler: Function): boolean {
    const cached = this.restoreHandlers.get(handler);
    if (cached !== undefined) return cached;
    const method: unknown = this.reflector.get(METHOD_METADATA, handler);
    const isPost =
      typeof method === 'number' && RequestMethodName[method] === POST;
    const value =
      isPost &&
      routeTemplateOf(controller, handler).includes(ORG_RESTORE_TEMPLATE);
    this.restoreHandlers.set(handler, value);
    return value;
  }
}
