import pg from 'pg';
import type { PlanSource } from '../../src/modules/entitlements/constants.js';
import type {
  FeatureCatalogueData,
  FeatureKind,
  ResetPeriod,
} from '../../src/modules/entitlements/domain/feature-catalogue.js';
import { getInfra } from './infra.js';
import { inOrgTx, withAppClient } from './tenancy-seed.js';

export type FeatureRow = {
  key: string;
  kind: FeatureKind;
  resetPeriod: ResetPeriod | null;
  deprecated: boolean;
};
export type OrgEntitlementRow = {
  planKey: string;
  source: PlanSource;
  sourceRef: string | null;
  reason: string | null;
  lastBillingSeq: string | null;
  version: number;
};

/** `app_owner` thẳng Postgres: bảng global của SP4 chỉ ghi bằng migration ở production, test seed bằng đúng role đó. */
export async function withOwner<T>(
  fn: (c: pg.Client) => Promise<T>,
  database?: string,
): Promise<T> {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: database ?? p.database,
    ...p.owner,
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Dòng `entitlement_features` mà một catalogue trong code đòi (cùng phép so của `EntitlementCatalogueCheck`). */
export const featureRowsOf = (c: FeatureCatalogueData): FeatureRow[] =>
  Object.entries(c.features).map(([key, f]) => ({
    key,
    kind: f.kind,
    resetPeriod: f.kind === 'QUOTA' ? f.resetPeriod : null,
    deprecated: f.deprecated === true,
  }));

/** Chèn tính năng fixture; trả hàm dọn (gọi SAU khi mọi org dùng chúng đã dispose). */
export async function seedFeatures(
  rows: readonly FeatureRow[],
  database?: string,
): Promise<() => Promise<void>> {
  const keys = rows.map((r) => r.key);
  await withOwner(
    (c) =>
      c.query(
        `INSERT INTO entitlement_features (key, kind, reset_period, deprecated_at)
         SELECT k, kd, rp, CASE WHEN d THEN now() END FROM unnest($1::text[], $2::text[], $3::text[], $4::bool[]) AS t(k, kd, rp, d)`,
        [
          keys,
          rows.map((r) => r.kind),
          rows.map((r) => r.resetPeriod),
          rows.map((r) => r.deprecated),
        ],
      ),
    database,
  );
  return () =>
    withOwner(
      async (c) =>
        void (await c.query(
          'DELETE FROM entitlement_features WHERE key = ANY($1::text[])',
          [keys],
        )),
      database,
    );
}

/** Chèn gói (bỏ qua key đã có, vd. `free`/`pro` của migration mẫu); hàm dọn chỉ xoá dòng chính lần gọi này chèn. */
export async function seedPlans(
  plans: readonly { key: string; retired?: boolean }[],
  database?: string,
): Promise<() => Promise<void>> {
  const inserted = await withOwner(async (c) => {
    const { rows } = await c.query<{ key: string }>(
      `INSERT INTO plans (key, retired_at) SELECT k, CASE WHEN r THEN now() END FROM unnest($1::text[], $2::bool[]) AS t(k, r)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [plans.map((p) => p.key), plans.map((p) => p.retired === true)],
    );
    return rows.map((r) => r.key);
  }, database);
  return () =>
    withOwner(
      async (c) =>
        void (await c.query('DELETE FROM plans WHERE key = ANY($1::text[])', [
          inserted,
        ])),
      database,
    );
}

/** Một dòng `org_entitlements` bằng `app_user` trong OrgScope của org (đúng đường của participant); ném nếu gói không có. */
export async function seedOrgEntitlement(
  orgId: string,
  planKey: string,
  opts: {
    source?: PlanSource;
    sourceRef?: string | null;
    reason?: string | null;
    lastBillingSeq?: bigint | null;
  } = {},
  database?: string,
): Promise<void> {
  const n = await withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const r = await c.query(
          `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_source_ref, plan_reason, last_billing_seq, plan_assigned_at)
           SELECT $1, id, $3, $4, $5, $6::bigint, now() FROM plans WHERE key = $2`,
          [
            orgId,
            planKey,
            opts.source ?? 'DEFAULT',
            opts.sourceRef ?? null,
            opts.reason ?? null,
            opts.lastBillingSeq?.toString() ?? null,
          ],
        );
        return r.rowCount ?? 0;
      }),
    database,
  );
  if (n !== 1)
    throw new Error(`seedOrgEntitlement: plan "${planKey}" does not exist`);
}

export const setOrgPlan = (orgId: string, planKey: string): Promise<unknown> =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(
        `UPDATE org_entitlements SET plan_id = (SELECT id FROM plans WHERE key = $1), updated_at = now() WHERE org_id = app_current_org()`,
        [planKey],
      ),
    ),
  );

export const deleteOrgEntitlement = (orgId: string): Promise<unknown> =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query('DELETE FROM org_entitlements WHERE org_id = app_current_org()'),
    ),
  );

export async function readOrgEntitlement(
  orgId: string,
  database?: string,
): Promise<OrgEntitlementRow | undefined> {
  return withAppClient(
    (c) =>
      inOrgTx(c, orgId, async () => {
        const { rows } = await c.query<OrgEntitlementRow>(
          `SELECT p.key AS "planKey", e.plan_source AS source, e.plan_source_ref AS "sourceRef", e.plan_reason AS reason,
                  e.last_billing_seq::text AS "lastBillingSeq", e.version
           FROM org_entitlements e JOIN plans p ON p.id = e.plan_id WHERE e.org_id = app_current_org()`,
        );
        return rows[0];
      }),
    database,
  );
}
