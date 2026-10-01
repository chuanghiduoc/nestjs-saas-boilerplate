import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { PLAN_SOURCES } from '../../constants.js';
import {
  OrgEntitlementRepository,
  type ProvisionResult,
  type SnapshotRow,
} from '../../ports/org-entitlement.repository.js';

/** Câu snapshot (spec §8.4; 4C thêm LEFT JOIN override). Index: PK `org_entitlements`, PK `plans`. */
export const SNAPSHOT_SQL = `SELECT e.version, p.key AS plan_key, e.plan_source, e.plan_assigned_at, now() AS now
FROM org_entitlements e JOIN plans p ON p.id = e.plan_id
WHERE e.org_id = app_current_org()`;
/** `Db.execute` trả TIMESTAMPTZ dạng chuỗi (bài học 3A): `z.coerce.date()`. */
const SnapshotRaw = z.object({
  version: z.coerce.number().int().min(1),
  plan_key: z.string(),
  plan_source: z.enum(PLAN_SOURCES),
  plan_assigned_at: z.coerce.date(),
  now: z.coerce.date(),
});

const Version = z.object({ version: z.coerce.number().int().min(1) });
const Presence = z.object({
  org_present: z.coerce.number().int(),
  row_present: z.coerce.number().int(),
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
    const rows = await this.db.execute(SNAPSHOT_SQL);
    if (rows.length > 1)
      throw new Error(
        `entitlement snapshot returned ${rows.length} rows (org_entitlements PK violated?)`,
      );
    if (rows.length === 0) return undefined;
    const r = SnapshotRaw.parse(rows[0]);
    return {
      version: r.version,
      planKey: r.plan_key,
      planSource: r.plan_source,
      planAssignedAt: r.plan_assigned_at,
      now: r.now,
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
}
