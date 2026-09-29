import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  mergeFeatureCatalogues,
  type FeatureCatalogueData,
  type FeatureEntry,
  type MergedFeatures,
} from '../domain/feature-catalogue.js';
import {
  PlanCatalogueError,
  fallbackUsage,
  validatePlanCatalogue,
  type PlanCatalogue,
} from '../domain/plan-catalogue.js';
import { UnknownFeatureError } from '../errors.js';

/** Module/feature góp catalogue tính năng bằng decorator trên một provider singleton (cùng mẫu catalogue quyền SP3 §8.2). */
export const FeatureCatalogueContributor =
  DiscoveryService.createDecorator<FeatureCatalogueData>();
/** Catalogue gói của dự án, tới module qua `EntitlementsModule.forApi(plans)`/`forWorker(plans)` (S4-D2, X-7). */
export const ENTITLEMENT_PLANS = Symbol('ENTITLEMENT_PLANS');

type Registered = {
  readonly defs: readonly FeatureCatalogueData[];
  readonly merged: MergedFeatures;
};

@Injectable()
export class EntitlementCatalogueRegistry implements OnModuleInit {
  private readonly logger = new Logger(EntitlementCatalogueRegistry.name);
  private registered: Registered | undefined;

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(ENTITLEMENT_PLANS) private readonly planCatalogue: PlanCatalogue,
  ) {}

  /**
   * Quét và gộp lúc boot để catalogue lỗi làm app không khởi động. `features()`/`has()` cũng tự quét ở lần gọi đầu (cùng mẫu
   * `PermissionCatalogueRegistry.load()` của 3A), nên `EntitlementCatalogueCheck.onModuleInit` không phụ thuộc thứ tự
   * init provider. Catalogue tính năng lỗi → `FeatureCatalogueError`; catalogue gói lỗi → log ERROR + `PlanCatalogueError`.
   */
  onModuleInit(): void {
    this.load();
  }

  features(): MergedFeatures {
    return this.load().merged;
  }

  feature(key: string): FeatureEntry {
    const f = this.features().get(key);
    if (f) return f;
    this.logger.error(
      { event: 'entitlements_unknown_feature', feature: key },
      'a feature key is not in the merged catalogue',
    );
    throw new UnknownFeatureError(key);
  }

  plans(): PlanCatalogue {
    return this.planCatalogue;
  }

  /** Catalogue trong metadata của `requireEnabled` phải là đúng đối tượng đã đăng ký (cùng luật INT3-5a của SP3). */
  has(def: FeatureCatalogueData): boolean {
    return this.load().defs.includes(def);
  }

  private load(): Registered {
    if (this.registered) return this.registered;
    const defs: FeatureCatalogueData[] = [];
    const owners = new Map<FeatureCatalogueData, string>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: FeatureCatalogueContributor.KEY,
    })) {
      const def = this.discovery.getMetadataByDecorator(
        FeatureCatalogueContributor,
        wrapper,
      );
      if (!def)
        throw new Error(
          `@FeatureCatalogueContributor on ${wrapper.name} must be given a catalogue`,
        );
      if (!wrapper.isDependencyTreeStatic())
        throw new Error(
          `@FeatureCatalogueContributor on ${wrapper.name} must be a singleton provider`,
        );
      const owner = owners.get(def);
      // Cùng một catalogue từ hai provider (hai module, hoặc một module dynamic dựng hai lần): fail loud như 3A (0bcabd9).
      if (owner !== undefined)
        throw new Error(
          `Feature catalogue [${def.keys.join(', ')}] is contributed twice (${owner}, ${wrapper.name})`,
        );
      owners.set(def, wrapper.name);
      defs.push(def);
    }
    const merged = mergeFeatureCatalogues(defs);
    const problems = validatePlanCatalogue(this.planCatalogue, merged);
    if (problems.length > 0) {
      this.logger.error(
        { event: 'entitlements_plan_catalogue_invalid', problems },
        'the plan catalogue is invalid',
      );
      throw new PlanCatalogueError(problems);
    }
    this.logger.log(
      {
        event: 'entitlements_plan_fallbacks',
        fallbacks: fallbackUsage(this.planCatalogue, merged),
      },
      'features on their fallback value, per plan',
    );
    this.registered = { defs, merged };
    return this.registered;
  }
}
