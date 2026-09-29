import { Injectable } from '@nestjs/common';
import { Db } from '../../../../core/database/index.js';
import {
  CatalogueReader,
  type CatalogueRow,
} from '../../ports/catalogue-reader.js';

type Raw = {
  key: string;
  resource: string;
  action: string;
  owner_only: boolean;
  api_key_eligible: boolean;
  support_eligible: boolean;
  deprecated: boolean;
  requires: string[];
};

/** Bảng global (không RLS), `app_user` chỉ SELECT (spec SP3 §6.3). Query duy nhất lúc boot. */
@Injectable()
export class SqlCatalogueReader extends CatalogueReader {
  constructor(private readonly db: Db) {
    super();
  }
  async readAll(): Promise<CatalogueRow[]> {
    const rows = await this.db.execute<Raw>(
      `SELECT p.key, p.resource, p.action, p.owner_only, p.api_key_eligible, p.support_eligible,
              p.deprecated_at IS NOT NULL AS deprecated,
              COALESCE(array_agg(q.key ORDER BY q.key) FILTER (WHERE q.key IS NOT NULL), '{}') AS requires
       FROM permissions p
       LEFT JOIN permission_requires r ON r.permission_id = p.id
       LEFT JOIN permissions q ON q.id = r.required_permission_id
       GROUP BY p.id
       ORDER BY p.key`,
    );
    return rows.map((r) => ({
      key: r.key,
      resource: r.resource,
      action: r.action,
      ownerOnly: r.owner_only,
      apiKeyEligible: r.api_key_eligible,
      supportEligible: r.support_eligible,
      deprecated: r.deprecated,
      requires: r.requires,
    }));
  }
}
