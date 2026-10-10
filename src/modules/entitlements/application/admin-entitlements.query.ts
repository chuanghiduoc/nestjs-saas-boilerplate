import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { entitlementsConfig } from '../entitlements.config.js';
import {
  OrgEntitlementRepository,
  type AdminRootRow,
} from '../ports/org-entitlement.repository.js';
import {
  OverrideRepository,
  type OverrideRow,
} from '../ports/override.repository.js';
import {
  UsageCounterRepository,
  type CurrentUsage,
} from '../ports/usage-counter.repository.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import {
  Entitlements,
  type EntitlementSnapshot,
} from './entitlements.service.js';

export type AdminView = {
  readonly snapshot: EntitlementSnapshot;
  readonly usage: CurrentUsage;
  readonly root: AdminRootRow;
  readonly overrides: readonly OverrideRow[];
};

/**
 * View admin (spec §12.2, review 4C Spec-I2): gói + phần nội bộ của dòng gốc + giá trị hiệu lực + usage kỳ hiện tại như
 * tenant (nhân viên thấy `OVER_LIMIT`) + mọi override (kể cả hết hạn, `status` suy ra ở HTTP bằng `root.now`). Chạy trong
 * UoW + OrgScope của caller. Org không có dòng gốc → 404 (route admin nhận org từ path). Override của key code không biết
 * (R-X30) bị lọc: pod này không có code nào kiểm tính năng đó.
 */
@Injectable()
export class AdminEntitlementsQuery {
  constructor(
    private readonly entitlements: Entitlements,
    private readonly roots: OrgEntitlementRepository,
    private readonly overrides: OverrideRepository,
    private readonly usage: UsageCounterRepository,
    private readonly registry: EntitlementCatalogueRegistry,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  async read(): Promise<AdminView> {
    const root = await this.roots.readAdminRoot();
    if (!root) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    const snapshot = await this.entitlements.snapshot();
    const usage = await this.usage.currentUsage(this.cfg.quotaTimezone);
    const known = this.registry.features();
    const overrides = (await this.overrides.listAll()).filter((o) =>
      known.has(o.featureKey),
    );
    return { snapshot, usage, root, overrides };
  }
}
