import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import { RegistrationLedger } from '../../ports/registration-ledger.js';
import { AUTH_POOL } from './auth-pool.provider.js';

const IdRow = z.object({ id: z.string() });
const AgeRow = z.object({ age: z.number().nullable() });

@Injectable()
export class PgRegistrationLedger extends RegistrationLedger {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {
    super();
  }
  /** Dùng partial index `user_unmarked_registered_idx`; không có giới hạn cửa sổ thời gian (spec §5.10). */
  async unmarked(graceSec: number, limit: number): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT id FROM "user" WHERE registered_event_emitted_at IS NULL AND created_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT $2`,
      [graceSec, limit],
    );
    return rows.map((r) => IdRow.parse(r).id);
  }
  async mark(userIds: readonly string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const res = await this.pool.query(
      `UPDATE "user" SET registered_event_emitted_at = now() WHERE id = ANY($1::uuid[]) AND registered_event_emitted_at IS NULL`,
      [userIds],
    );
    return res.rowCount ?? 0;
  }
  async oldestUnmarkedAgeSec(): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT extract(epoch FROM now() - min(created_at))::float8 AS age FROM "user" WHERE registered_event_emitted_at IS NULL`,
    );
    return AgeRow.parse(rows[0]).age;
  }
}
