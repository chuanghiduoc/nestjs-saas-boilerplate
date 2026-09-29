import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { PLAN_SOURCES } from '../../constants.js';
import {
  OrgEntitlementRepository,
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
}
