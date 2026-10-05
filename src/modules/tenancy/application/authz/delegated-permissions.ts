import { Injectable, Logger } from '@nestjs/common';
import {
  effectiveDelegation,
  type DelegationKind,
} from '../../domain/delegation.js';
import { systemRolePermissions } from '../../domain/system-roles.js';
import type { ActiveKeyAccess } from '../../ports/org-api-key-repository.js';
import { PermissionCatalogueRegistry } from '../permission-catalogue.registry.js';
import { TenancyMetrics } from '../tenancy-metrics.js';
import { RolePermissions } from './role-permissions.js';

/**
 * Quyền hiệu lực của org key / support grant ở MỖI request (spec SP3 §8.5, không cache, PR18). Key: phạm vi ∩ quyền của
 * role HIỆN TẠI của người tạo (`RolePermissions`, gồm role tuỳ biến) ∩ eligible. Grant: người cấp phải đang là OWNER
 * (middleware kiểm), owner giữ mọi quyền nên = phạm vi ∩ eligible. Key orphan: WARN + metric MỘT lần mỗi key mỗi process
 * (R-X23, R-X26), không bao giờ 500.
 */
@Injectable()
export class DelegatedPermissions {
  private readonly logger = new Logger(DelegatedPermissions.name);
  private readonly reportedOrphans = new Set<string>();

  constructor(
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
  ) {}

  async forApiKey(a: ActiveKeyAccess): Promise<string[]> {
    const grantor = new Set(
      await this.rolePermissions.of({
        id: a.creatorRoleId,
        systemKey: a.creatorSystemKey,
      }),
    );
    return this.effective('API_KEY', a.scope, grantor);
  }

  forSupportGrant(scope: readonly string[]): string[] {
    const merged = this.registry.merged();
    return this.effective(
      'SUPPORT_GRANT',
      scope,
      systemRolePermissions('OWNER', merged),
    );
  }

  private effective(
    kind: DelegationKind,
    scope: readonly string[],
    grantor: ReadonlySet<string>,
  ): string[] {
    const { granted, orphans } = effectiveDelegation(
      kind,
      scope,
      grantor,
      this.registry.merged(),
    );
    for (const key of orphans) {
      if (this.reportedOrphans.has(key)) continue;
      this.reportedOrphans.add(key);
      this.metrics.catalogueOrphanKeys.add(1, { source: 'delegation' });
      // Key catalogue không phải PII; không log key/grant, org hay user.
      this.logger.warn(
        { event: 'orphan_permission_ignored', key, source: kind },
        'a delegation scope holds a permission that no loaded catalogue declares; it grants nothing',
      );
    }
    return granted;
  }
}
