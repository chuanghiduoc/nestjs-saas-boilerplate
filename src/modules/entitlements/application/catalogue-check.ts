import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MergedFeatures } from '../domain/feature-catalogue.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import {
  EntitlementCatalogueReader,
  type FeatureRow,
  type PlanRow,
} from '../ports/catalogue.reader.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from './entitlements-metrics.js';

const sortedUnion = (a: Iterable<string>, b: Iterable<string>): string[] =>
  [...new Set([...a, ...b])].sort();

/** Mọi khác biệt giữa catalogue trong code và hai bảng tra cứu (spec §8.3), tính năng rồi gói, sắp theo key. Rỗng = khớp. */
export function entitlementsCatalogueDiff(
  features: MergedFeatures,
  featureRows: readonly FeatureRow[],
  plans: PlanCatalogue,
  planRows: readonly PlanRow[],
): string[] {
  const out: string[] = [];
  const fdb = new Map(featureRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(features.keys(), fdb.keys())) {
    const code = features.get(key);
    const row = fdb.get(key);
    if (!row) out.push(`feature ${key}: in code, missing in the database`);
    else if (!code)
      out.push(`feature ${key}: in the database, missing in code`);
    else {
      const resetPeriod = code.kind === 'QUOTA' ? code.resetPeriod : null;
      if (code.kind !== row.kind)
        out.push(`feature ${key}: kind code=${code.kind} db=${row.kind}`);
      if (resetPeriod !== row.resetPeriod)
        out.push(
          `feature ${key}: resetPeriod code=${String(resetPeriod)} db=${String(row.resetPeriod)}`,
        );
      if (code.deprecated !== row.deprecated)
        out.push(
          `feature ${key}: deprecated code=${String(code.deprecated)} db=${String(row.deprecated)}`,
        );
    }
  }
  const pdb = new Map(planRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(plans.plans.keys(), pdb.keys())) {
    const code = plans.plans.get(key);
    const row = pdb.get(key);
    if (!row) out.push(`plan ${key}: in code, missing in the database`);
    else if (!code) out.push(`plan ${key}: in the database, missing in code`);
    else if (code.retired !== row.retired)
      out.push(
        `plan ${key}: retired code=${String(code.retired)} db=${String(row.retired)}`,
      );
  }
  return out;
}

/**
 * Api và worker (spec §8.3, F-3): catalogue lệch DB (thiếu migration, pod lệch version) → app không khởi động (fail loud).
 * `onModuleInit`, không phải `onApplicationBootstrap` (lệch có chủ đích so với spec §8.3, Task 14 sửa spec): Nest chạy xong
 * mọi `onModuleInit` trước mọi `onApplicationBootstrap`, còn `WorkerHost` và `OutboxRelay` bắt đầu consume ở
 * `onApplicationBootstrap`; kiểm ở đó thì worker lệch đã chạy `entitlements.provision-org` trước khi chết (bài học 3A
 * Task 19, 0bcabd9). Registry tự nạp ở lần dùng đầu nên thứ tự init provider không quan trọng.
 */
@Injectable()
export class EntitlementCatalogueCheck implements OnModuleInit {
  private readonly logger = new Logger(EntitlementCatalogueCheck.name);

  constructor(
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly reader: EntitlementCatalogueReader,
    private readonly metrics: EntitlementsMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    const [featureRows, planRows] = await Promise.all([
      this.reader.features(),
      this.reader.plans(),
    ]);
    const differences = entitlementsCatalogueDiff(
      this.registry.features(),
      featureRows,
      this.registry.plans(),
      planRows,
    );
    if (differences.length === 0) return;
    this.metrics.catalogueMismatch.add(1);
    this.logger.error(
      { event: 'entitlements_catalogue_mismatch', differences },
      'feature or plan catalogue in code does not match the database',
    );
    throw new Error(
      `Entitlement catalogues do not match the database: ${differences.join('; ')}`,
    );
  }
}
