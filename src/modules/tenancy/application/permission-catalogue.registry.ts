import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  mergeCatalogues,
  type CatalogueDef,
  type MergedCatalogue,
} from '../domain/catalogue.js';

/**
 * Module/feature góp catalogue bằng decorator trên một provider singleton (spec SP3 §8.2; Nest không gom provider cùng
 * token nên không dùng multi-provider). Cùng mẫu `@JobHandler`/`@EventSubscriber` của core.
 */
export const PermissionCatalogueContributor =
  DiscoveryService.createDecorator<CatalogueDef>();

@Injectable()
export class PermissionCatalogueRegistry implements OnModuleInit {
  private defs: readonly CatalogueDef[] = [];
  private mergedCatalogue: MergedCatalogue | undefined;

  constructor(private readonly discovery: DiscoveryService) {}

  /** `onModuleInit`: đủ trước mọi `onApplicationBootstrap` (`CatalogueCheck`, `OrgRouteInventory`). Vi phạm U1–U5 → ném. */
  onModuleInit(): void {
    const defs: CatalogueDef[] = [];
    for (const wrapper of this.discovery.getProviders({
      metadataKey: PermissionCatalogueContributor.KEY,
    })) {
      const def = this.discovery.getMetadataByDecorator(
        PermissionCatalogueContributor,
        wrapper,
      );
      if (!def)
        throw new Error(
          `@PermissionCatalogueContributor on ${wrapper.name} must be given a catalogue`,
        );
      if (!defs.includes(def)) defs.push(def);
    }
    this.mergedCatalogue = mergeCatalogues(defs);
    this.defs = defs;
  }

  merged(): MergedCatalogue {
    if (!this.mergedCatalogue)
      throw new Error('PermissionCatalogueRegistry used before onModuleInit');
    return this.mergedCatalogue;
  }

  /** INT3-5a: catalogue trong metadata của route phải là đúng đối tượng đã đăng ký. */
  has(def: CatalogueDef): boolean {
    return this.defs.includes(def);
  }
}
