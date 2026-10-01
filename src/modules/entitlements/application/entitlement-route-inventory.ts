import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { classifyTenantHandler } from '../../tenancy/index.js';
import {
  FEATURE_REQUIREMENTS,
  type FeatureRequirement,
} from '../http/feature-metadata.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';

/**
 * Kiểm lúc khởi động của api (spec §8.3): mọi handler có `requireEnabled` phải là route tenant theo CÙNG matcher của tenancy
 * (`classifyTenantHandler`), catalogue của decorator đã đăng ký, key có trong catalogue gộp, là FLAG và chưa deprecated.
 * Vi phạm → log ERROR + app không khởi động. Log thời gian (tiêu chí đo "kiểm lúc boot < 50 ms thêm", spec §20.4).
 */
@Injectable()
export class EntitlementRouteInventory implements OnApplicationBootstrap {
  private readonly logger = new Logger(EntitlementRouteInventory.name);
  private readonly scanner = new MetadataScanner();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly registry: EntitlementCatalogueRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const started = performance.now();
    const problems = this.check();
    const durationMs = Math.round(performance.now() - started);
    if (problems.length === 0) {
      this.logger.log(
        { event: 'entitlements_route_inventory', durationMs },
        'entitlement route inventory passed',
      );
      return;
    }
    this.logger.error(
      { event: 'entitlements_route_inventory_failed', problems },
      'entitlement route inventory failed',
    );
    throw new Error(
      `Entitlement route inventory failed: ${problems.join('; ')}`,
    );
  }

  check(): string[] {
    const out: string[] = [];
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
        const requirements = this.reflector.getAllAndMerge<
          FeatureRequirement[]
        >(FEATURE_REQUIREMENTS, [handler, controller]);
        if (requirements.length === 0) continue;
        out.push(
          ...this.problemsOf(
            `${controller.name}.${name}`,
            controller,
            handler,
            requirements,
          ),
        );
      }
    }
    return out;
  }

  private problemsOf(
    id: string,
    controller: Function,
    handler: Function,
    requirements: readonly FeatureRequirement[],
  ): string[] {
    const out: string[] = [];
    if (classifyTenantHandler(controller, handler) !== 'TENANT')
      out.push(
        `${id}: requireEnabled needs a tenant route under v1/orgs/:orgId`,
      );
    for (const r of requirements) {
      if (!this.registry.has(r.catalogue)) {
        out.push(
          `${id}: its feature catalogue is not registered (@FeatureCatalogueContributor missing)`,
        );
        continue;
      }
      for (const key of r.keys) {
        const f = this.registry.features().get(key);
        if (!f)
          out.push(`${id}: "${key}" is not in the merged feature catalogue`);
        else if (f.kind !== 'FLAG')
          out.push(
            `${id}: "${key}" is a ${f.kind}, requireEnabled takes FLAG keys only`,
          );
        else if (f.deprecated) out.push(`${id}: "${key}" is deprecated`);
      }
    }
    return out;
  }
}
