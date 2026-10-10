import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { PLAN_SOURCES } from '../../constants.js';
import {
  OrgEntitlementRepository,
  type AdminRootRow,
  type AppliedAssignment,
  type AssignmentRow,
  type ProvisionResult,
  type SnapshotOverride,
  type SnapshotRow,
} from '../../ports/org-entitlement.repository.js';

/**
 * Câu snapshot (spec §8.4): một dòng mỗi override còn hạn, hoặc một dòng với cột override NULL khi không có. Plan thật
 * (`snapshot-explain.spec.ts`, 10 000 org × 5 override): Index Scan `org_entitlements_pkey`, Index Scan
 * `org_entitlement_overrides_pkey` theo `org_id`; `plans` và `entitlement_features` là bảng tra cứu vài dòng nên Postgres
 * quét tuần tự rồi hash/nested loop — đúng, không cần index thêm. `now()` là giờ bắt đầu transaction: mọi câu của một
 * transaction thấy cùng trạng thái hết hạn (E-12).
 * `expires_at` ra JS làm tròn LÊN tới ms (Postgres giữ µs, `Date` của JS cắt xuống ms cả `now` lẫn `expires_at`): trên
 * dòng đã lọc `expires_at > now()`, `ceil_ms(expires_at) > floor_ms(now)` luôn đúng, nên `overrideStatus` của
 * `resolveEffective` đồng ý với SQL; không làm tròn thì override còn hạn dưới 1 ms bị coi là hết hạn (Review Focus 1).
 */
export const SNAPSHOT_SQL = `SELECT e.version, p.key AS plan_key, e.plan_source, e.plan_assigned_at, now() AS now,
       f.key AS override_feature, o.flag_value, o.limit_value::text AS limit_value,
       date_trunc('milliseconds', o.expires_at + interval '999 microseconds') AS expires_at
FROM org_entitlements e
JOIN plans p ON p.id = e.plan_id
LEFT JOIN org_entitlement_overrides o
       ON o.org_id = e.org_id AND (o.expires_at IS NULL OR o.expires_at > now())
LEFT JOIN entitlement_features f ON f.id = o.feature_id
WHERE e.org_id = app_current_org()
ORDER BY f.key`;
/** `Db.execute` trả TIMESTAMPTZ dạng chuỗi (bài học 3A): `z.coerce.date()`; BIGINT qua `::text`. */
const SnapshotRaw = z.object({
  version: z.coerce.number().int().min(1),
  plan_key: z.string(),
  plan_source: z.enum(PLAN_SOURCES),
  plan_assigned_at: z.coerce.date(),
  now: z.coerce.date(),
  override_feature: z.string().nullable(),
  flag_value: z.boolean().nullable(),
  limit_value: z.string().nullable(),
  expires_at: z.coerce.date().nullable(),
});

const Version = z.object({ version: z.coerce.number().int().min(1) });
const Presence = z.object({
  org_present: z.coerce.number().int(),
  row_present: z.coerce.number().int(),
});
const LockRaw = z.object({
  plan_id: z.string(),
  plan_source: z.enum(PLAN_SOURCES),
  plan_source_ref: z.string().nullable(),
  last_billing_seq: z.string().nullable(),
  version: z.coerce.number().int().min(1),
});
const AdminRootRaw = z.object({
  version: z.coerce.number().int().min(1),
  plan_source_ref: z.string().nullable(),
  plan_reason: z.string().nullable(),
  last_billing_seq: z.string().nullable(),
  now: z.coerce.date(),
});
const PlanRaw = z.object({
  id: z.string(),
  key: z.string(),
  retired: z.boolean(),
});
const missingDefaultPlan = (planKey: string): Error =>
  new Error(
    `default plan "${planKey}" is not in the plans table (the catalogue check should have refused to boot)`,
  );

@Injectable()
export class SqlOrgEntitlementRepository extends OrgEntitlementRepository {
  constructor(protected readonly db: Db) {
    super();
  }

  async readSnapshot(): Promise<SnapshotRow | undefined> {
    const rows = (await this.db.execute(SNAPSHOT_SQL)).map((r) =>
      SnapshotRaw.parse(r),
    );
    const [first] = rows;
    if (!first) return undefined;
    const overrides: SnapshotOverride[] = [];
    for (const r of rows) {
      if (r.version !== first.version || r.plan_key !== first.plan_key)
        throw new Error(
          'entitlement snapshot rows disagree on the org_entitlements row (org_entitlements PK violated?)',
        );
      if (r.override_feature === null) {
        if (rows.length > 1)
          throw new Error(
            'entitlement snapshot returned an override without a feature (FK org_entitlement_overrides.feature_id violated?)',
          );
        continue;
      }
      overrides.push({
        featureKey: r.override_feature,
        flagValue: r.flag_value,
        limitValue: r.limit_value === null ? null : Number(r.limit_value),
        expiresAt: r.expires_at,
      });
    }
    return {
      version: first.version,
      planKey: first.plan_key,
      planSource: first.plan_source,
      planAssignedAt: first.plan_assigned_at,
      now: first.now,
      overrides,
    };
  }

  async insertDefault(planKey: string): Promise<{ version: number }> {
    const rows = await this.db.execute(
      `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
       SELECT app_current_org(), id, 'DEFAULT', now() FROM plans WHERE key = ? RETURNING version`,
      [planKey],
    );
    if (!rows[0]) throw missingDefaultPlan(planKey);
    return Version.parse(rows[0]);
  }

  async insertDefaultIfAbsent(planKey: string): Promise<ProvisionResult> {
    const rows = await this.db.execute(
      `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
       SELECT o.id, p.id, 'DEFAULT', now() FROM organizations o JOIN plans p ON p.key = ? WHERE o.id = app_current_org()
       ON CONFLICT (org_id) DO NOTHING RETURNING version`,
      [planKey],
    );
    if (rows[0])
      return { kind: 'INSERTED', version: Version.parse(rows[0]).version };
    const [raw] = await this.db.execute(
      `SELECT (SELECT count(*) FROM organizations WHERE id = app_current_org())::int AS org_present,
              (SELECT count(*) FROM org_entitlements WHERE org_id = app_current_org())::int AS row_present`,
    );
    const p = Presence.parse(raw);
    if (p.org_present === 0) return { kind: 'ORG_GONE' };
    if (p.row_present === 1) return { kind: 'ALREADY_PROVISIONED' };
    throw missingDefaultPlan(planKey);
  }

  async lockForAssignment(
    targetPlanKey: string,
  ): Promise<AssignmentRow | undefined> {
    // Câu 1 khoá CHỈ `org_entitlements`, không JOIN (C2 review 4A, spec §10.2 bước 2). Dưới READ COMMITTED, phiên chờ
    // khoá được Postgres kiểm lại (EvalPlanQual) trên phiên bản MỚI của dòng khoá nhưng ghép với dòng `plans` đã đọc TRƯỚC
    // khi chờ; nếu phiên kia vừa đổi `plan_id`, điều kiện JOIN `cur.id = e.plan_id` sai và câu trả 0 dòng → giả
    // `EntitlementsRowMissingError` (503) dù dòng còn — SP5 hiểu là org đã purge và commit tiền mà không áp gói (A10).
    // Không JOIN thì điều kiện duy nhất là `org_id = app_current_org()`, luôn đúng với phiên bản mới.
    const locked = await this.db.execute(
      `SELECT plan_id::text AS plan_id, plan_source, plan_source_ref, last_billing_seq::text AS last_billing_seq, version
       FROM org_entitlements WHERE org_id = app_current_org()
       FOR NO KEY UPDATE`,
    );
    if (locked.length > 1)
      throw new Error(
        `org_entitlements lock returned ${locked.length} rows (org_entitlements PK violated?)`,
      );
    if (!locked[0]) return undefined;
    const e = LockRaw.parse(locked[0]);
    // Câu 2: `plans` là bảng global (không RLS, không khoá); câu mới có snapshot mới nên thấy gói mà phiên trước vừa commit.
    // Vẫn trước câu ghi đầu tiên, nên hợp đồng C-2 giữ nguyên.
    const plans = (
      await this.db.execute(
        `SELECT id::text AS id, key, retired_at IS NOT NULL AS retired FROM plans WHERE id = ?::bigint OR key = ?`,
        [e.plan_id, targetPlanKey],
      )
    ).map((r) => PlanRaw.parse(r));
    const current = plans.find((p) => p.id === e.plan_id);
    if (!current)
      throw new Error(
        `org_entitlements.plan_id ${e.plan_id} has no plans row (FK org_entitlements.plan_id violated?)`,
      );
    const target = plans.find((p) => p.key === targetPlanKey);
    return {
      current: {
        planKey: current.key,
        source: e.plan_source,
        sourceRef: e.plan_source_ref,
        lastBillingSeq:
          e.last_billing_seq === null ? null : BigInt(e.last_billing_seq),
        version: e.version,
      },
      target: target
        ? { id: target.id, key: target.key, retired: target.retired }
        : null,
    };
  }

  async applyAssignment(a: AppliedAssignment): Promise<number> {
    const rows = await this.db.execute(
      `UPDATE org_entitlements SET plan_id = ?::bigint, plan_source = ?, plan_source_ref = ?, plan_reason = ?, plan_assigned_at = now(),
              last_billing_seq = COALESCE(?::bigint, last_billing_seq), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() RETURNING version`,
      [
        a.planId,
        a.source,
        a.sourceRef,
        a.reason,
        a.billingSequence?.toString() ?? null,
      ],
    );
    if (!rows[0])
      throw new Error(
        'applyAssignment touched no row although the row was locked in this transaction',
      );
    return Version.parse(rows[0]).version;
  }

  async recordBillingSequence(sequence: bigint): Promise<void> {
    const rows = await this.db.execute(
      `UPDATE org_entitlements SET last_billing_seq = ?::bigint, updated_at = now() WHERE org_id = app_current_org() RETURNING 1 AS ok`,
      [sequence.toString()],
    );
    if (!rows[0])
      throw new Error(
        'recordBillingSequence touched no row although the row was locked in this transaction',
      );
  }

  async readAdminRoot(): Promise<AdminRootRow | undefined> {
    const rows = await this.db.execute(
      `SELECT version, plan_source_ref, plan_reason, last_billing_seq::text AS last_billing_seq, now() AS now
       FROM org_entitlements WHERE org_id = app_current_org()`,
    );
    if (rows.length > 1)
      throw new Error(
        `admin root read returned ${rows.length} rows (org_entitlements PK violated?)`,
      );
    if (!rows[0]) return undefined;
    const r = AdminRootRaw.parse(rows[0]);
    return {
      version: r.version,
      sourceRef: r.plan_source_ref,
      reason: r.plan_reason,
      lastBillingSeq:
        r.last_billing_seq === null ? null : BigInt(r.last_billing_seq),
      now: r.now,
    };
  }
}
