import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../core/database/index.js';
import {
  OrgActivityGate,
  type OrgActivity,
} from '../../../core/queue/index.js';

const Row = z.object({ deleted_at: z.coerce.date().nullable() });

/** Một câu đọc ngắn trong OrgScope của job (spec SP3 §9.4, CDX-6). Lỗi DB ném ra: job lỗi, BullMQ thử lại. */
@Injectable()
export class TenancyOrgActivityGate extends OrgActivityGate {
  constructor(private readonly db: Db) {
    super();
  }
  async check(): Promise<OrgActivity> {
    const [row] = await this.db.execute(
      'SELECT deleted_at FROM organizations WHERE id = app_current_org()',
    );
    if (!row) return { kind: 'GONE' };
    const { deleted_at } = Row.parse(row);
    return deleted_at === null
      ? { kind: 'ACTIVE' }
      : { kind: 'DELETED', deletedAt: deleted_at };
  }
}
