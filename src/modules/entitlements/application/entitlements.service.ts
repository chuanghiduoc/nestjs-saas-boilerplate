import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import type { PlanSource } from '../constants.js';
import { isCount, type FeatureKind } from '../domain/feature-catalogue.js';
import {
  resolveEffective,
  type EffectiveValue,
  type Limit,
} from '../domain/effective-value.js';
import { entitlementsConfig } from '../entitlements.config.js';
import { entitlementsSpan } from '../entitlements-telemetry.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  EntitlementsVersionSkewError,
  FeatureKindMismatchError,
  featureNotInPlan,
  quotaExceeded,
} from '../errors.js';
import {
  OrgEntitlementRepository,
  type SnapshotOverride,
} from '../ports/org-entitlement.repository.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { EntitlementsMetrics } from './entitlements-metrics.js';

const MS_PER_SEC = 1000;

export type EntitlementSnapshot = {
  readonly version: number;
  readonly plan: {
    readonly key: string;
    readonly source: PlanSource;
    readonly assignedAt: Date;
  };
  readonly features: ReadonlyMap<string, EffectiveValue>;
  /** Override còn hạn đang thắng (`source: 'OVERRIDE'`), theo key (4C); `expiresAt: null` = vĩnh viễn. */
  readonly overrides: ReadonlyMap<string, { readonly expiresAt: Date | null }>;
};

const flagOf = (snapshot: EntitlementSnapshot, key: string): boolean => {
  const v = snapshot.features.get(key);
  if (v?.kind !== 'FLAG')
    throw new FeatureKindMismatchError(key, 'FLAG', v?.kind ?? 'missing');
  return v.enabled;
};

/**
 * Đọc/kiểm entitlement (spec §6.4, S4-D8): không cache, mỗi lần một câu snapshot theo PK trong org context của caller.
 * Mọi hàm đòi org context (OrgScope của request hoặc job có `meta.orgId`); key sai → lỗi lập trình có tên, fail loud.
 */
@Injectable()
export class Entitlements {
  private readonly logger = new Logger(Entitlements.name);
  /** R-X30 + luật R-X26: key override pod này không biết được báo MỘT lần mỗi process, không mỗi request. */
  private readonly warnedOverrideKeys = new Set<string>();

  constructor(
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  async snapshot(): Promise<EntitlementSnapshot> {
    this.requireOrg('snapshot');
    const started = performance.now();
    try {
      return await entitlementsSpan('entitlements.snapshot.read', () =>
        this.read(),
      );
    } finally {
      this.metrics.snapshotReadDuration.record(
        (performance.now() - started) / MS_PER_SEC,
      );
    }
  }

  /** Chỉ FLAG. */
  async isEnabled(key: string): Promise<boolean> {
    this.requireOrg('isEnabled');
    this.requireKind(key, ['FLAG']);
    return flagOf(await this.snapshot(), key);
  }

  /** Mọi key phải bật (một snapshot cho cả tập); key tắt đầu tiên → `403 feature_not_in_plan` với key ở `errors[0]`. */
  async assertEnabled(...keys: [string, ...string[]]): Promise<void> {
    this.requireOrg('assertEnabled');
    for (const key of keys) this.requireKind(key, ['FLAG']);
    await entitlementsSpan(
      'entitlements.feature.check',
      async (span) => {
        const snapshot = await this.snapshot();
        const denied = keys.find((k) => !flagOf(snapshot, k));
        if (denied === undefined) return 'allowed' as const;
        this.metrics.featureDenied.add(1, { feature: denied });
        // Spec §19: `entitlements.result` có trên cả nhánh từ chối, không chỉ khi cho qua.
        span.setAttribute('entitlements.result', 'denied');
        throw featureNotInPlan(denied);
      },
      (result) => ({ 'entitlements.result': result }),
    );
  }

  /** LIMIT hoặc QUOTA. */
  async limitOf(key: string): Promise<Limit> {
    this.requireOrg('limitOf');
    this.requireKind(key, ['LIMIT', 'QUOTA']);
    const v = (await this.snapshot()).features.get(key);
    if (!v || v.kind === 'FLAG')
      throw new FeatureKindMismatchError(
        key,
        'LIMIT or QUOTA',
        v?.kind ?? 'missing',
      );
    return v.limit;
  }

  /**
   * LIMIT do module chủ tự đếm (S4-D4, spec §9.5): caller PHẢI đếm dưới khoá tuần tự hoá mọi đường thêm (README);
   * `currentCount + adding > max` → `422 quota_exceeded` với key ở `errors[0]`.
   */
  async assertWithinLimit(
    key: string,
    currentCount: number,
    adding = 1,
  ): Promise<void> {
    this.requireOrg('assertWithinLimit');
    this.requireKind(key, ['LIMIT']);
    if (!isCount(currentCount) || !isCount(adding, 1))
      throw new RangeError(
        `assertWithinLimit("${key}") needs integer counts: currentCount >= 0, adding >= 1`,
      );
    const limit = await this.limitOf(key);
    switch (limit.kind) {
      case 'UNLIMITED':
        return;
      case 'MAX':
        if (currentCount + adding > limit.max) throw quotaExceeded(key);
        return;
      default: {
        const unknownKind: never = limit;
        throw new Error(
          `unknown limit kind ${String(Reflect.get(unknownKind, 'kind'))}`,
        );
      }
    }
  }

  private requireOrg(op: string): void {
    if (this.ctx.orgId() === undefined)
      throw new EntitlementsContextError(
        `Entitlements.${op} needs an organization context (OrgScope, or a job with meta.orgId)`,
      );
  }

  private requireKind(key: string, kinds: readonly FeatureKind[]): void {
    const f = this.registry.feature(key);
    if (!kinds.includes(f.kind))
      throw new FeatureKindMismatchError(key, kinds.join(' or '), f.kind);
  }

  private async read(): Promise<EntitlementSnapshot> {
    const row = await this.repo.readSnapshot();
    if (!row) {
      this.metrics.rowMissing.add(1);
      this.logger.error(
        { event: 'entitlements_row_missing' },
        'the organization has no org_entitlements row',
      );
      throw new EntitlementsRowMissingError(this.cfg.rowMissingRetryAfterSec);
    }
    const plan = this.registry.plans().plans.get(row.planKey);
    if (!plan) {
      this.logger.error(
        { event: 'entitlements_unknown_plan', planKey: row.planKey },
        'the organization is on a plan this pod does not know',
      );
      throw new EntitlementsVersionSkewError(row.planKey);
    }
    const known = this.registry.features();
    const byKey = new Map<string, SnapshotOverride>();
    for (const o of row.overrides) {
      if (known.has(o.featureKey)) byKey.set(o.featureKey, o);
      else this.warnUnknownOverride(o.featureKey);
    }
    const features = new Map<string, EffectiveValue>();
    const overrides = new Map<string, { readonly expiresAt: Date | null }>();
    for (const f of known.values()) {
      const o = byKey.get(f.key);
      const v = resolveEffective(f, plan.values.get(f.key), o, row.now);
      features.set(f.key, v);
      if (o && v.source === 'OVERRIDE')
        overrides.set(f.key, { expiresAt: o.expiresAt });
    }
    return {
      version: row.version,
      plan: {
        key: plan.key,
        source: row.planSource,
        assignedAt: row.planAssignedAt,
      },
      features,
      overrides,
    };
  }

  /** Override cho key không có trong catalogue gộp (DB mới hơn code, R-X30): pod không kiểm tính năng đó nên bỏ qua là đúng. */
  private warnUnknownOverride(key: string): void {
    if (this.warnedOverrideKeys.has(key)) return;
    this.warnedOverrideKeys.add(key);
    this.logger.warn(
      { event: 'entitlements_unknown_override_feature', feature: key },
      'an override names a feature this pod does not know; it is ignored',
    );
  }
}
