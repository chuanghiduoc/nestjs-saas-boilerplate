import { Injectable } from '@nestjs/common';
import { Db } from '../../../core/database/index.js';
import {
  OrgPurgeParticipant,
  OrgPurgeParticipantContributor,
} from '../../tenancy/index.js';
import { INTEGRATIONS_PURGE_ORDER } from '../constants.js';
import { INTEGRATIONS_PURGE_STATEMENTS } from '../infra/sql/integrations-purge.sql.js';

/**
 * Xoá cứng (spec SP6 §8.3, R-X5, addendum 3D §A4): `order = 120`, trước tenancy core (1000) vì `webhook_endpoints` trỏ tới
 * `organizations`. Chạy TRONG transaction purge (OrgScope của org), chỉ DB, con trước cha; quên bảng nào thì purge fail to
 * (23001). Bảng partitioned không FK tới `organizations` (R-X27): participant này là thứ dọn chúng.
 */
@Injectable()
@OrgPurgeParticipantContributor({
  key: 'integrations',
  order: INTEGRATIONS_PURGE_ORDER,
})
export class IntegrationsPurgeParticipant extends OrgPurgeParticipant {
  constructor(private readonly db: Db) {
    super();
  }
  async purge(): Promise<void> {
    for (const sql of INTEGRATIONS_PURGE_STATEMENTS) await this.db.execute(sql);
  }
}
