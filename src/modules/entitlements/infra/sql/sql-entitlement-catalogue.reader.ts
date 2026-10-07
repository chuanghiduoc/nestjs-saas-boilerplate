import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import {
  FEATURE_KINDS,
  RESET_PERIODS,
} from '../../domain/feature-catalogue.js';
import {
  EntitlementCatalogueReader,
  type FeatureRow,
  type PlanRow,
} from '../../ports/catalogue.reader.js';

const FeatureRaw = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(FEATURE_KINDS),
  reset_period: z.enum(RESET_PERIODS).nullable(),
  deprecated: z.boolean(),
});
const PlanRaw = z.object({ key: z.string(), retired: z.boolean() });

@Injectable()
export class SqlEntitlementCatalogueReader extends EntitlementCatalogueReader {
  constructor(private readonly db: Db) {
    super();
  }
  async features(): Promise<FeatureRow[]> {
    const rows = await this.db.execute(
      `SELECT id::text AS id, key, kind, reset_period, deprecated_at IS NOT NULL AS deprecated FROM entitlement_features ORDER BY key`,
    );
    return rows.map((r) => {
      const f = FeatureRaw.parse(r);
      return {
        id: f.id,
        key: f.key,
        kind: f.kind,
        resetPeriod: f.reset_period,
        deprecated: f.deprecated,
      };
    });
  }
  async plans(): Promise<PlanRow[]> {
    const rows = await this.db.execute(
      `SELECT key, retired_at IS NOT NULL AS retired FROM plans ORDER BY key`,
    );
    return rows.map((r) => PlanRaw.parse(r));
  }
  async probeTimezone(timezone: string): Promise<void> {
    await this.db.execute(`SELECT date_trunc('month', now(), ?) AS start`, [
      timezone,
    ]);
  }
}
