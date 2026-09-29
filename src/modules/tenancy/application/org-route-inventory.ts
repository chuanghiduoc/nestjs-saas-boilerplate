import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from '../../../core/http/index.js';
import {
  MARKER_EXEMPT_ROUTES,
  NARROWING_ROUTES,
  TENANCY_NARROWING,
  TENANCY_POLICY,
  TENANCY_SENSITIVE,
  type TenancyPolicy,
} from '../http/policy-metadata.js';
import {
  ORG_RESTORE_TEMPLATE,
  RequestMethodName,
  classifyOrgRoute,
  routeTemplateOf,
} from '../http/org-route.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

/** Module có controller của tenancy (G-8): tenancy cung cấp giá trị ở `forApi()`; unit test so với cây import. */
export const TENANCY_CONTROLLER_MODULES = Symbol('TENANCY_CONTROLLER_MODULES');
const DECLARABLE = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Route `TENANT` có metadata phân quyền (nguồn của ma trận G-6; 3B/3C/3D mở rộng bằng cách thêm route). */
export type TenantRoute = {
  id: string;
  method: string;
  template: string;
  policy: TenancyPolicy;
  sensitive: boolean;
  narrowing: boolean;
};

type Route = {
  id: string;
  method: string;
  template: string;
  controller: Function;
  handler: Function;
  tenancy: boolean;
};

/**
 * Kiểm lúc khởi động của api (spec SP3 §7.1, PR22, G-1, G-8, R4A-N5, INT3-5a): vi phạm → log ERROR + app không khởi
 * động. Chạy sau `PermissionCatalogueRegistry.onModuleInit`. Đo thời gian (tiêu chí 17: kiểm route + catalogue < 200 ms).
 */
@Injectable()
export class OrgRouteInventory implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrgRouteInventory.name);
  private readonly scanner = new MetadataScanner();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly registry: PermissionCatalogueRegistry,
    @Inject(TENANCY_CONTROLLER_MODULES)
    private readonly tenancyModules: readonly Type[],
  ) {}

  onApplicationBootstrap(): void {
    const started = performance.now();
    const problems = this.check();
    const durationMs = Math.round(performance.now() - started);
    if (problems.length === 0) {
      this.logger.log(
        { event: 'org_route_inventory', durationMs },
        'tenant route inventory passed',
      );
      return;
    }
    this.logger.error(
      { event: 'org_route_inventory_failed', problems },
      'tenant route inventory failed',
    );
    throw new Error(`Tenant route inventory failed: ${problems.join('; ')}`);
  }

  check(): string[] {
    const routes = this.routes();
    const problems: string[] = [];
    for (const r of routes) problems.push(...this.checkRoute(r));
    const restores = routes.filter(
      (r) => r.method === 'POST' && r.template === ORG_RESTORE_TEMPLATE,
    );
    if (restores.length !== 1)
      problems.push(
        `exactly one POST ${ORG_RESTORE_TEMPLATE} handler, found ${restores.length}`,
      );
    // PoliciesGuard mở cửa org xoá mềm theo handler: template thứ hai của handler khôi phục cũng sẽ được mở.
    for (const r of restores) {
      const templates = routeTemplateOf(r.controller, r.handler).length;
      if (templates !== 1)
        problems.push(
          `${r.id}: the restore handler must have exactly one route template, found ${templates}`,
        );
    }
    const narrowing = routes
      .filter((r) => r.tenancy && this.flag(TENANCY_NARROWING, r))
      .map((r) => r.id);
    const added = narrowing
      .filter((id) => !NARROWING_ROUTES.includes(id))
      .map((id) => `+${id}`);
    const missing = NARROWING_ROUTES.filter(
      (id) => !narrowing.includes(id) && routes.some((r) => r.id === id),
    ).map((id) => `-${id}`);
    if (added.length || missing.length)
      problems.push(
        `narrowing routes differ from NARROWING_ROUTES: ${[...added, ...missing].join(', ')}`,
      );
    return problems;
  }

  /** Route `TENANT` có metadata phân quyền, theo thứ tự khai báo: nguồn của ma trận G-6 (không viết tay từng ô). */
  tenantRoutes(): TenantRoute[] {
    return this.routes().flatMap((r) => {
      const policy = this.reflector.getAllAndOverride<
        TenancyPolicy | undefined
      >(TENANCY_POLICY, [r.handler, r.controller]);
      if (classifyOrgRoute(r.template) !== 'TENANT' || !policy) return [];
      return [
        {
          id: r.id,
          method: r.method,
          template: r.template,
          policy,
          sensitive: this.flag(TENANCY_SENSITIVE, r),
          narrowing: this.flag(TENANCY_NARROWING, r),
        },
      ];
    });
  }

  private checkRoute(r: Route): string[] {
    const out: string[] = [];
    const policy = this.reflector.getAllAndOverride<TenancyPolicy | undefined>(
      TENANCY_POLICY,
      [r.handler, r.controller],
    );
    const kind = classifyOrgRoute(r.template);
    if (kind === 'INVALID')
      out.push(
        `${r.id}: routes under v1/orgs/ must name the org parameter :orgId`,
      );
    if (kind === 'TENANT' && !policy)
      out.push(
        `${r.id}: tenant route without a permission decorator or @OrgMemberOnly`,
      );
    if (kind === 'TENANT' && this.flag(PUBLIC_ROUTE, r))
      out.push(`${r.id}: tenant route must not be @PublicRoute`);
    if (kind === 'OTHER' && policy)
      out.push(`${r.id}: permission decorator on a non-tenant route`);
    if (policy?.kind === 'PERMISSIONS') {
      if (policy.keys.length === 0)
        out.push(`${r.id}: permission decorator with no keys`);
      if (!this.registry.has(policy.catalogue))
        out.push(
          `${r.id}: catalogue "${policy.catalogue.name}" is not registered (@PermissionCatalogueContributor missing)`,
        );
      else
        for (const k of policy.keys)
          if (!this.registry.merged().has(k))
            out.push(`${r.id}: key "${k}" is not in the merged catalogue`);
    }
    if (r.tenancy) {
      if (!DECLARABLE.has(r.method))
        out.push(
          `${r.id}: tenancy controllers may only declare GET, POST, PUT, PATCH, DELETE`,
        );
      else if (r.method !== 'GET' && !MARKER_EXEMPT_ROUTES.includes(r.id)) {
        const markers = [
          this.flag(TENANCY_SENSITIVE, r),
          this.flag(TENANCY_NARROWING, r),
        ].filter(Boolean).length;
        if (markers !== 1)
          out.push(
            `${r.id}: a tenancy write route needs exactly one of @SensitiveTenancyAction/@NarrowingTenancyAction`,
          );
      }
    }
    return out;
  }

  private flag(key: string, r: Route): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(key, [
        r.handler,
        r.controller,
      ]) === true
    );
  }

  private routes(): Route[] {
    const tenancyControllers = new Set(
      this.discovery
        .getControllers({ include: [...this.tenancyModules] })
        .map((w) => w.metatype),
    );
    const out: Route[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const proto: object = controller.prototype;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler: unknown = Reflect.get(proto, name);
        if (
          typeof handler !== 'function' ||
          this.reflector.get(PATH_METADATA, handler) === undefined
        )
          continue;
        const methodNo: unknown = this.reflector.get(METHOD_METADATA, handler);
        const method =
          typeof methodNo === 'number'
            ? (RequestMethodName[methodNo] ?? String(methodNo))
            : 'GET';
        for (const template of routeTemplateOf(controller, handler))
          out.push({
            id: `${method} ${template}`,
            method,
            template,
            controller,
            handler,
            tenancy: tenancyControllers.has(controller),
          });
      }
    }
    return out;
  }
}
