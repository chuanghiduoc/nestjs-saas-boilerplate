import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import type { Limit } from '../domain/effective-value.js';
import { isCount, type FeatureEntry } from '../domain/feature-catalogue.js';
import {
  periodOf,
  reachedLimit,
  type ConsumeResult,
  type QuotaPeriod,
  type QuotaReceipt,
} from '../domain/quota.js';
import { entitlementsConfig } from '../entitlements.config.js';
import { entitlementsSpan } from '../entitlements-telemetry.js';
import {
  EntitlementsContextError,
  FeatureKindMismatchError,
  QuotaReleaseUnderflowError,
  quotaExceeded,
} from '../errors.js';
import { QuotaReachedEvent, USAGE_COUNTER_AGGREGATE } from '../events.js';
import { UsageCounterRepository } from '../ports/usage-counter.repository.js';
import { EntitlementCatalogueCheck } from './catalogue-check.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import { Entitlements } from './entitlements.service.js';
import {
  EntitlementsMetrics,
  type QuotaConsumeResult,
} from './entitlements-metrics.js';

type QuotaEntry = Extract<FeatureEntry, { kind: 'QUOTA' }>;
const MS_PER_SEC = 1000;
/**
 * Trigger của migration 4B: chỉ bắn khi code/catalogue lệch DB (Quotas đã kiểm loại và deprecated trước SQL). Một trường
 * hợp lệ có chủ đích: trong rollout, DB đã deprecate tính năng (migration của bản mới chạy trước) mà pod này còn coi là
 * active (R-X30 cho boot với WARN `entitlement_feature_deprecated_in_db`); consume trên pod cũ khi đó nhận 422
 * `validation_failed` kèm ERROR `entitlements_counter_refused`, đúng chiều fail closed, hết khi rollout xong.
 */
const COUNTER_TRIGGER = 'usage_counters_period_ck';
/** Actor khi không có principal (job có `meta.orgId`, subscriber): spec §13.1. */
const QUOTAS_SYSTEM_ACTOR: EventActor = {
  type: 'system',
  id: 'entitlements.quotas',
};

const resultOf = (r: ConsumeResult): QuotaConsumeResult => {
  switch (r.kind) {
    case 'CONSUMED':
      return 'consumed';
    case 'EXCEEDED':
      return 'exceeded';
    default: {
      const unknown: never = r;
      throw new Error(`unknown consume result ${JSON.stringify(unknown)}`);
    }
  }
};
const maxOf = (limit: Limit): number | null => {
  switch (limit.kind) {
    case 'UNLIMITED':
      return null;
    case 'MAX':
      return limit.max;
    default: {
      const unknown: never = limit;
      throw new Error(`unknown limit ${JSON.stringify(unknown)}`);
    }
  }
};
/** Số nguyên an toàn ≥ 1 (spec §9.2 tiền điều kiện): sai là lỗi lập trình của caller, trước mọi câu SQL. */
function requireAmount(op: string, key: string, amount: number): void {
  if (!isCount(amount, 1))
    throw new RangeError(
      `Quotas.${op}("${key}") needs an integer amount in [1, ${Number.MAX_SAFE_INTEGER}], got ${String(amount)}`,
    );
}

/** Kỳ của receipt phải khớp `resetPeriod` của tính năng (receipt dựng tay hoặc lưu sai kiểu là lỗi lập trình). */
function receiptPeriod(f: QuotaEntry, r: QuotaReceipt): string | null {
  switch (f.resetPeriod) {
    case 'NONE':
      if (r.periodStart !== null)
        throw new RangeError(
          `the receipt of "${f.key}" carries a period, but the feature has resetPeriod NONE`,
        );
      return null;
    case 'MONTH':
      if (r.periodStart === null || Number.isNaN(Date.parse(r.periodStart)))
        throw new RangeError(
          `the receipt of "${f.key}" needs the ISO period start of its MONTH counter`,
        );
      return r.periodStart;
    default: {
      const unknown: never = f.resetPeriod;
      throw new Error(`unknown reset period ${String(unknown)}`);
    }
  }
}

/**
 * Quota atomic (spec §9, S4-D6): mọi hàm chạy TRONG `UnitOfWork` + org context của caller, cùng transaction với side
 * effect: quota có đúng bảo đảm của side effect (rollback của caller trả lại quota; Inbox cùng transaction là exactly-once;
 * `@Idempotent()` lưu response ở Redis sau commit nên chỉ là best-effort qua crash giữa commit và lưu: exactly-once qua
 * HTTP cần khoá UNIQUE/tự nhiên trên side effect). Không bao giờ
 * vượt trần: một câu `INSERT … ON CONFLICT … DO UPDATE … WHERE used + n <= max` khoá dòng và kiểm trên bản mới nhất (E-1,
 * E-2). Trần đọc trong transaction (snapshot, không cache, S4-D8): đổi gói commit sau được xếp "sau" lần này (E-4).
 * Thứ tự khoá (spec §3.6): mọi khoá của caller trước; consume không khoá `org_entitlements`, khoá dòng bộ đếm sau cùng;
 * nhiều key trong một transaction: tiêu thụ theo thứ tự key tăng dần (I2). Nhánh `EXCEEDED` vẫn giữ khoá dòng bộ đếm tới khi
 * caller kết thúc (`ON CONFLICT DO UPDATE` khoá dòng kể cả khi `WHERE` sai, M7): caller nhận `EXCEEDED` nên kết thúc sớm.
 */
@Injectable()
export class Quotas {
  private readonly logger = new Logger(Quotas.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly entitlements: Entitlements,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly catalogue: EntitlementCatalogueCheck,
    private readonly counters: UsageCounterRepository,
    private readonly events: EventPublisher,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  async consume(key: string, amount: number): Promise<ConsumeResult> {
    const orgId = this.requireTx('consume');
    const feature = this.quota(key);
    if (feature.deprecated)
      throw new FeatureKindMismatchError(
        key,
        'an active QUOTA',
        'a deprecated QUOTA',
      );
    requireAmount('consume', key, amount);
    const started = performance.now();
    try {
      const result = await entitlementsSpan(
        'entitlements.quota.consume',
        () => this.consumeIn(orgId, feature, amount),
        (r) => ({ 'entitlements.result': resultOf(r) }),
      );
      this.metrics.quotaConsume.add(1, {
        feature: key,
        result: resultOf(result),
      });
      return result;
    } finally {
      this.metrics.quotaConsumeDuration.record(
        (performance.now() - started) / MS_PER_SEC,
      );
    }
  }

  /** `EXCEEDED` → `422 quota_exceeded` với key ở `errors[0]` (S4-D14). */
  async consumeOrThrow(key: string, amount: number): Promise<QuotaReceipt> {
    const r = await this.consume(key, amount);
    switch (r.kind) {
      case 'CONSUMED':
        return r.receipt;
      case 'EXCEEDED':
        throw quotaExceeded(key);
      default: {
        const unknown: never = r;
        throw new Error(`unknown consume result ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** Trả đúng lần tiêu thụ về đúng dòng kỳ của receipt (spec §9.3): trả ở tháng sau không chạm kỳ hiện tại. */
  async release(receipt: QuotaReceipt): Promise<void> {
    this.requireTx('release');
    const feature = this.quota(receipt.featureKey);
    requireAmount('release', feature.key, receipt.amount);
    await this.releaseIn(
      feature.key,
      receiptPeriod(feature, receipt),
      receipt.amount,
    );
  }

  /** Chỉ QUOTA kỳ NONE (xoá bản ghi đã tính quota, không còn receipt). Tính năng deprecated vẫn trả được. */
  async releaseAllocation(key: string, amount: number): Promise<void> {
    this.requireTx('releaseAllocation');
    const feature = this.quota(key);
    if (feature.resetPeriod !== 'NONE')
      throw new FeatureKindMismatchError(
        key,
        'a QUOTA with resetPeriod NONE',
        `a QUOTA with resetPeriod ${feature.resetPeriod}`,
      );
    requireAmount('releaseAllocation', key, amount);
    await this.releaseIn(key, null, amount);
  }

  /** 0 dòng = trả nhiều hơn đã dùng (hoặc chưa từng dùng): lỗi lập trình, `CHECK (used >= 0)` là lớp chặn cuối (F-9). */
  private async releaseIn(
    key: string,
    periodStart: string | null,
    amount: number,
  ): Promise<void> {
    const left = await this.counters.release({
      featureId: this.catalogue.featureId(key),
      periodStart,
      amount,
    });
    if (left !== undefined) return;
    this.logger.error(
      { event: 'quota_release_underflow', feature: key },
      'a quota release would make the usage negative',
    );
    throw new QuotaReleaseUnderflowError(key, amount);
  }

  private async consumeIn(
    orgId: string,
    feature: QuotaEntry,
    amount: number,
  ): Promise<ConsumeResult> {
    const max = maxOf(await this.entitlements.limitOf(feature.key));
    const period = periodOf(feature.resetPeriod, this.cfg.quotaTimezone);
    const featureId = this.catalogue.featureId(feature.key);
    // Spec §9.2 bước 2: nhánh INSERT không có WHERE, nên `amount > max` phải dừng TRƯỚC câu consume.
    if (max !== null && amount > max)
      return this.exceeded(featureId, period, max);
    const row = await this.guarded(feature.key, () =>
      this.counters.consume({ featureId, period, amount, max }),
    );
    if (!row) {
      if (max === null)
        throw new Error(
          `an UNLIMITED consume of "${feature.key}" returned no row (the statement has no guard)`,
        );
      return this.exceeded(featureId, period, max);
    }
    const receipt: QuotaReceipt = {
      featureKey: feature.key,
      periodStart: row.periodStart?.toISOString() ?? null,
      amount,
    };
    if (max !== null && reachedLimit(max, row.used, amount))
      await this.events.publish(QuotaReachedEvent, {
        data: {
          orgId,
          feature: feature.key,
          periodStart: receipt.periodStart,
          limit: max,
          used: row.used,
        },
        aggregate: {
          type: USAGE_COUNTER_AGGREGATE,
          id: row.id,
          version: row.version,
        },
        actor: this.actor(),
      });
    return { kind: 'CONSUMED', receipt };
  }

  private async exceeded(
    featureId: string,
    period: QuotaPeriod,
    max: number,
  ): Promise<ConsumeResult> {
    return {
      kind: 'EXCEEDED',
      limit: max,
      used: await this.counters.usedNow({ featureId, period }),
    };
  }

  /** Trigger của DB là lớp chặn cuối: bắn nghĩa là code sai, nên ngoài 422 của mapper còn một dòng ERROR (spec §15). */
  private async guarded<T>(key: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgFields(err)?.constraint === COUNTER_TRIGGER)
        this.logger.error(
          { event: 'entitlements_counter_refused', feature: key },
          'the database refused a usage counter row: code and catalogue disagree with entitlement_features',
        );
      throw err;
    }
  }

  private requireTx(op: string): string {
    const orgId = this.ctx.orgId();
    if (!this.uow.inTransaction() || orgId === undefined)
      throw new EntitlementsContextError(
        `Quotas.${op} must run inside the caller UnitOfWork and an organization context (spec SP4 §9.2)`,
      );
    return orgId;
  }

  private quota(key: string): QuotaEntry {
    const f = this.registry.feature(key);
    if (f.kind !== 'QUOTA')
      throw new FeatureKindMismatchError(key, 'QUOTA', f.kind);
    return f;
  }

  /** Org API key và service principal không phải user: actor `service`, không ném như `userActor` của tenancy. */
  private actor(): EventActor {
    const p = this.ctx.principal();
    if (!p) return QUOTAS_SYSTEM_ACTOR;
    switch (p.type) {
      case 'user':
        return { type: 'user', id: p.id };
      case 'api_key':
        return { type: 'service', id: `api_key:${p.id}` };
      case 'service':
        return { type: 'service', id: p.id };
      default: {
        const unknown: never = p.type;
        throw new Error(`unknown principal type ${String(unknown)}`);
      }
    }
  }
}
