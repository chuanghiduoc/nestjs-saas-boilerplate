import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import {
  SECURITY_NOTICE_KINDS,
  SecurityNoticeLedger,
  type PendingSecurityNotice,
} from '../../ports/security-notice-ledger.js';
import { AUTH_POOL } from './auth-pool.provider.js';

const Row = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.enum(SECURITY_NOTICE_KINDS),
  created_at: z.date(),
});
const AgeRow = z.object({ age: z.number().nullable() });
const COLUMNS = 'id, user_id, kind, created_at';
const toNotice = (r: unknown): PendingSecurityNotice => {
  const row = Row.parse(r);
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    occurredAt: row.created_at,
  };
};

/** Marker do trigger `user_two_factor_notice_trg` ghi (`Migration20260928082958_security_notice`); pool `auth_user`. */
@Injectable()
export class PgSecurityNoticeLedger extends SecurityNoticeLedger {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {
    super();
  }
  /** Index `security_notice_user_id_idx`. */
  async pendingForUser(userId: string): Promise<PendingSecurityNotice[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth.security_notice WHERE user_id = $1 AND notified_at IS NULL ORDER BY created_at, id`,
      [userId],
    );
    return rows.map(toNotice);
  }
  /** Partial index `security_notice_pending_idx`; không có cận dưới thời gian (marker commit muộn vẫn được tìm thấy). */
  async pending(
    graceSec: number,
    limit: number,
  ): Promise<PendingSecurityNotice[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth.security_notice WHERE notified_at IS NULL AND created_at < now() - make_interval(secs => $1) ORDER BY created_at, id LIMIT $2`,
      [graceSec, limit],
    );
    return rows.map(toNotice);
  }
  async markNotified(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.security_notice SET notified_at = now() WHERE id = $1 AND notified_at IS NULL`,
      [id],
    );
  }
  async oldestPendingAgeSec(): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT extract(epoch FROM now() - min(created_at))::float8 AS age FROM auth.security_notice WHERE notified_at IS NULL`,
    );
    return AgeRow.parse(rows[0]).age;
  }
}
