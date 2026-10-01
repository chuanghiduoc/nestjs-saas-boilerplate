import { Injectable } from '@nestjs/common';
import { Db } from '../../../core/database/index.js';
import {
  OrgPurgeParticipant,
  OrgPurgeParticipantContributor,
} from '../../tenancy/index.js';
import { ENTITLEMENTS_PURGE_ORDER } from '../constants.js';
import { ENTITLEMENTS_PURGE_STATEMENTS } from '../infra/sql/entitlements-purge.sql.js';

/**
 * Xoá cứng (spec §13.2, R-X5, addendum 3D §A4): `order = 100`, trước tenancy core (1000) vì bảng SP4 trỏ tới
 * `organizations`. Chạy TRONG transaction purge (OrgScope của org), con trước cha; quên bảng nào thì purge fail to (23001).
 * Billing và audit không phải participant, nên transaction purge không khoá `billing_accounts` (E-16).
 */
@Injectable()
@OrgPurgeParticipantContributor({
  key: 'entitlements',
  order: ENTITLEMENTS_PURGE_ORDER,
})
export class EntitlementsPurgeParticipant extends OrgPurgeParticipant {
  constructor(private readonly db: Db) {
    super();
  }

  async purge(): Promise<void> {
    for (const sql of ENTITLEMENTS_PURGE_STATEMENTS) await this.db.execute(sql);
  }
}
