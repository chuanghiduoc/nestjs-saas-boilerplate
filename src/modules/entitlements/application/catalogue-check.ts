import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { pgFields } from '../../../core/database/index.js';
import type { MergedFeatures } from '../domain/feature-catalogue.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import { entitlementsConfig } from '../entitlements.config.js';
import {
  EntitlementCatalogueReader,
  type FeatureRow,
  type PlanRow,
} from '../ports/catalogue.reader.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from './entitlements-metrics.js';

/** `invalid_parameter_value`: Postgres không biết múi giờ (`time zone "…" not recognized`). */
const PG_UNKNOWN_TIMEZONE = '22023';

/** DB mới hơn code (R-X30): trơ với pod này, không chặn boot. Mỗi loại một event log có tên. */
export type CatalogueWarning = {
  readonly event:
    | 'entitlement_feature_unknown_to_code'
    | 'entitlement_feature_deprecated_in_db'
    | 'entitlement_plan_unknown_to_code'
    | 'entitlement_plan_retired_in_db';
  readonly key: string;
};
/** `errors` khác rỗng = thiếu migration hoặc lệch thật → không khởi động. `warnings` chỉ log + metric. */
export type CatalogueDiff = {
  readonly errors: string[];
  readonly warnings: CatalogueWarning[];
};

const sortedUnion = (a: Iterable<string>, b: Iterable<string>): string[] =>
  [...new Set([...a, ...b])].sort();

/**
 * Mọi khác biệt giữa catalogue trong code và hai bảng tra cứu (spec §8.3), tính năng rồi gói, sắp theo key. Code có mà DB
 * thiếu, khác `kind`/`reset_period`, code đã deprecate/retire mà DB chưa → lỗi (thiếu migration). Dòng chỉ có ở DB, DB đã
 * deprecate/retire mà code chưa → cảnh báo (R-X30): pod chạy code cũ trên DB đã migrate bởi bản mới không được crash-loop.
 */
export function entitlementsCatalogueDiff(
  features: MergedFeatures,
  featureRows: readonly FeatureRow[],
  plans: PlanCatalogue,
  planRows: readonly PlanRow[],
): CatalogueDiff {
  const errors: string[] = [];
  const warnings: CatalogueWarning[] = [];
  const fdb = new Map(featureRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(features.keys(), fdb.keys())) {
    const code = features.get(key);
    const row = fdb.get(key);
    if (!row) errors.push(`feature ${key}: in code, missing in the database`);
    else if (!code)
      warnings.push({ event: 'entitlement_feature_unknown_to_code', key });
    else {
      const resetPeriod = code.kind === 'QUOTA' ? code.resetPeriod : null;
      if (code.kind !== row.kind)
        errors.push(`feature ${key}: kind code=${code.kind} db=${row.kind}`);
      if (resetPeriod !== row.resetPeriod)
        errors.push(
          `feature ${key}: resetPeriod code=${String(resetPeriod)} db=${String(row.resetPeriod)}`,
        );
      if (code.deprecated && !row.deprecated)
        errors.push(`feature ${key}: deprecated code=true db=false`);
      else if (!code.deprecated && row.deprecated)
        warnings.push({ event: 'entitlement_feature_deprecated_in_db', key });
    }
  }
  const pdb = new Map(planRows.map((r) => [r.key, r]));
  for (const key of sortedUnion(plans.plans.keys(), pdb.keys())) {
    const code = plans.plans.get(key);
    const row = pdb.get(key);
    if (!row) errors.push(`plan ${key}: in code, missing in the database`);
    else if (!code)
      warnings.push({ event: 'entitlement_plan_unknown_to_code', key });
    else if (code.retired && !row.retired)
      errors.push(`plan ${key}: retired code=true db=false`);
    else if (!code.retired && row.retired)
      warnings.push({ event: 'entitlement_plan_retired_in_db', key });
  }
  return { errors, warnings };
}

const warningMessage = (w: CatalogueWarning): string => {
  switch (w.event) {
    case 'entitlement_feature_unknown_to_code':
      return 'a feature row exists only in the database; this pod ignores it (a newer release migrated first)';
    case 'entitlement_feature_deprecated_in_db':
      return 'the database deprecated a feature this pod still declares active (a newer release migrated first)';
    case 'entitlement_plan_unknown_to_code':
      return 'a plan row exists only in the database; organizations on it get 503 from this pod (F-6)';
    case 'entitlement_plan_retired_in_db':
      return 'the database retired a plan this pod still declares active (a newer release migrated first)';
    default: {
      const unknown: never = w.event;
      throw new Error(`unknown catalogue warning ${String(unknown)}`);
    }
  }
};

/**
 * Api và worker (spec §8.3, F-3): lỗi catalogue (thiếu migration) → app không khởi động; DB mới hơn code → WARN + metric,
 * vẫn khởi động (R-X30, cùng luật R-X21 của quyền). `onModuleInit`, không phải `onApplicationBootstrap`: Nest chạy xong mọi
 * `onModuleInit` trước mọi `onApplicationBootstrap`, còn `WorkerHost` và `OutboxRelay` bắt đầu consume ở
 * `onApplicationBootstrap` (bài học 3A Task 19, 0bcabd9). Registry tự nạp ở lần dùng đầu nên thứ tự init provider không
 * quan trọng. Kiểm thêm múi giờ quota ở Postgres (M6): zod config kiểm bằng Intl của Node, câu SQL dùng tzdata của DB.
 */
@Injectable()
export class EntitlementCatalogueCheck implements OnModuleInit {
  private readonly logger = new Logger(EntitlementCatalogueCheck.name);

  constructor(
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly reader: EntitlementCatalogueReader,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.assertTimezone();
    const [featureRows, planRows] = await Promise.all([
      this.reader.features(),
      this.reader.plans(),
    ]);
    const { errors, warnings } = entitlementsCatalogueDiff(
      this.registry.features(),
      featureRows,
      this.registry.plans(),
      planRows,
    );
    for (const w of warnings)
      this.logger.warn({ event: w.event, key: w.key }, warningMessage(w));
    const count = (event: CatalogueWarning['event']) =>
      warnings.filter((w) => w.event === event).length;
    const unknownFeatures = count('entitlement_feature_unknown_to_code');
    const unknownPlans = count('entitlement_plan_unknown_to_code');
    if (unknownFeatures > 0)
      this.metrics.catalogueUnknownFeatures.add(unknownFeatures);
    if (unknownPlans > 0) this.metrics.catalogueUnknownPlans.add(unknownPlans);
    if (errors.length === 0) return;
    this.metrics.catalogueMismatch.add(1);
    this.logger.error(
      { event: 'entitlements_catalogue_mismatch', differences: errors },
      'feature or plan catalogue in code does not match the database',
    );
    throw new Error(
      `Entitlement catalogues do not match the database: ${errors.join('; ')}`,
    );
  }

  /** 22023 → lỗi cấu hình có tên, dừng boot; lỗi khác (DB mất) ném nguyên để readiness/khởi động báo đúng nguyên nhân. */
  private async assertTimezone(): Promise<void> {
    const tz = this.cfg.quotaTimezone;
    try {
      await this.reader.probeTimezone(tz);
    } catch (err) {
      if (pgFields(err)?.sqlState !== PG_UNKNOWN_TIMEZONE) throw err;
      this.logger.error(
        { event: 'entitlements_quota_timezone_unknown' },
        'ENTITLEMENTS_QUOTA_TIMEZONE is not a time zone the database knows',
      );
      throw new Error(
        `ENTITLEMENTS_QUOTA_TIMEZONE "${tz}" is not a time zone the database knows (PostgreSQL tzdata); pick a zone listed in pg_timezone_names`,
      );
    }
  }
}
