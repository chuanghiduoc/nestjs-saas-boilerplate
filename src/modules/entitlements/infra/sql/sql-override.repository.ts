import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import {
  OverrideRepository,
  type LockedRoot,
  type OverrideRow,
  type OverrideWrite,
} from '../../ports/override.repository.js';

const Version = z.object({ version: z.coerce.number().int().min(1) });
const Clock = z.object({ now: z.coerce.date() });
const Row = z.object({
  feature: z.string(),
  flag_value: z.boolean().nullable(),
  limit_value: z.string().nullable(),
  reason: z.string(),
  expires_at: z.coerce.date().nullable(),
  updated_at: z.coerce.date(),
});
/** Cùng câu đọc cho `findOne` và `listAll` (PK `(org_id, feature_id)`). */
const SELECT_ROWS = `SELECT f.key AS feature, o.flag_value, o.limit_value::text AS limit_value, o.reason, o.expires_at, o.updated_at
FROM org_entitlement_overrides o JOIN entitlement_features f ON f.id = o.feature_id
WHERE o.org_id = app_current_org()`;
const rowOf = (raw: unknown): OverrideRow => {
  const r = Row.parse(raw);
  return {
    featureKey: r.feature,
    flagValue: r.flag_value,
    limitValue: r.limit_value === null ? null : Number(r.limit_value),
    reason: r.reason,
    expiresAt: r.expires_at,
    updatedAt: r.updated_at,
  };
};

@Injectable()
export class SqlOverrideRepository extends OverrideRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async lockRoot(): Promise<LockedRoot | undefined> {
    const locked = await this.db.execute(
      `SELECT version FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE`,
    );
    if (locked.length > 1)
      throw new Error(
        `org_entitlements lock returned ${locked.length} rows (org_entitlements PK violated?)`,
      );
    if (!locked[0]) return undefined;
    const { version } = Version.parse(locked[0]);
    // Câu riêng SAU khoá: đồng hồ trong danh sách cột của câu khoá có thể được tính trước khi chờ khoá.
    const [clock] = await this.db.execute(`SELECT clock_timestamp() AS now`);
    return { version, now: Clock.parse(clock).now };
  }

  async upsert(o: OverrideWrite): Promise<void> {
    const rows = await this.db.execute(
      `INSERT INTO org_entitlement_overrides (org_id, feature_id, flag_value, limit_value, reason, expires_at, updated_at)
       VALUES (app_current_org(), ?::bigint, ?::boolean, ?::bigint, ?, ?::timestamptz, clock_timestamp())
       ON CONFLICT (org_id, feature_id) DO UPDATE SET flag_value = EXCLUDED.flag_value, limit_value = EXCLUDED.limit_value,
         reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
       RETURNING 1 AS ok`,
      [
        o.featureId,
        o.flagValue,
        o.limitValue === null ? null : String(o.limitValue),
        o.reason,
        o.expiresAt?.toISOString() ?? null,
      ],
    );
    if (rows.length !== 1)
      throw new Error(`override upsert touched ${rows.length} rows`);
  }

  async remove(featureId: string): Promise<boolean> {
    const rows = await this.db.execute(
      `DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org() AND feature_id = ?::bigint RETURNING 1 AS ok`,
      [featureId],
    );
    return rows.length === 1;
  }

  async bumpVersion(): Promise<number> {
    const rows = await this.db.execute(
      `UPDATE org_entitlements SET version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() RETURNING version`,
    );
    if (!rows[0])
      throw new Error(
        'bumpVersion touched no row although the row was locked in this transaction',
      );
    return Version.parse(rows[0]).version;
  }

  async findOne(featureId: string): Promise<OverrideRow | undefined> {
    const rows = await this.db.execute(
      `${SELECT_ROWS} AND o.feature_id = ?::bigint`,
      [featureId],
    );
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  async listAll(): Promise<OverrideRow[]> {
    const rows = await this.db.execute(`${SELECT_ROWS} ORDER BY f.key`);
    return rows.map(rowOf);
  }
}
