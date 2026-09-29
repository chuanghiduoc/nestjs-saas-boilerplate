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

type Registered = { defs: readonly CatalogueDef[]; merged: MergedCatalogue };

@Injectable()
export class PermissionCatalogueRegistry implements OnModuleInit {
  private registered: Registered | undefined;

  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Quét và gộp lúc boot để vi phạm U1–U5 (hoặc một catalogue góp hai lần) làm app không khởi động. `merged()`/`has()`
   * cũng tự quét ở lần gọi đầu, nên `CatalogueCheck.onModuleInit` (cùng module) không phụ thuộc thứ tự init provider.
   */
  onModuleInit(): void {
    this.load();
  }

  merged(): MergedCatalogue {
    return this.load().merged;
  }

  /** INT3-5a: catalogue trong metadata của route phải là đúng đối tượng đã đăng ký. */
  has(def: CatalogueDef): boolean {
    return this.load().defs.includes(def);
  }

  private load(): Registered {
    if (this.registered) return this.registered;
    const defs: CatalogueDef[] = [];
    const owners = new Map<CatalogueDef, string>();
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
      const owner = owners.get(def);
      // Cùng một catalogue từ hai provider (hai module, hoặc một module dynamic dựng hai lần): chỉ một chỗ sở hữu.
      if (owner !== undefined)
        throw new Error(
          `Permission catalogue "${def.name}" is contributed twice (${owner}, ${wrapper.name})`,
        );
      owners.set(def, wrapper.name);
      defs.push(def);
    }
    this.registered = { defs, merged: mergeCatalogues(defs) };
    return this.registered;
  }
}
