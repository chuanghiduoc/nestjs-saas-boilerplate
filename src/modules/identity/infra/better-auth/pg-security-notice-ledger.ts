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
  /** Index `security_notice_user_id_idx`. M1: bỏ marker đã `abandon` (không bao giờ gửi được, không phải lỗi tạm). */
  async pendingForUser(userId: string): Promise<PendingSecurityNotice[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth.security_notice WHERE user_id = $1 AND notified_at IS NULL AND abandoned_at IS NULL ORDER BY created_at, id`,
      [userId],
    );
    return rows.map(toNotice);
  }
  /**
   * Partial index `security_notice_pending_idx`; không có cận dưới thời gian (marker commit muộn vẫn được tìm thấy).
   * M1: bỏ marker đã `abandon` — cron không đọc lại chúng nữa (đã log ERROR + tăng metric một lần lúc bỏ).
   */
  async pending(
    graceSec: number,
    limit: number,
  ): Promise<PendingSecurityNotice[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM auth.security_notice WHERE notified_at IS NULL AND abandoned_at IS NULL AND created_at < now() - make_interval(secs => $1) ORDER BY created_at, id LIMIT $2`,
      [graceSec, limit],
    );
    return rows.map(toNotice);
  }
  /**
   * M3 (S2-R75 review): `clock_timestamp()` (thời điểm THỰC THI câu lệnh) + `GREATEST(..., created_at)`, không phải
   * `now()` (thời điểm bắt đầu transaction) trần — cùng lý do và cùng cơ chế với N2 (`unverified-links.ts`): một DB
   * lùi đồng hồ hoặc failover sang node lệch giờ có thể cho `now() < created_at`, vi phạm `CHECK (notified_at >=
   * created_at)` (23514), khiến đường gửi nhanh log "deferred" và cron lỗi tới khi đồng hồ khớp lại.
   */
  async markNotified(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.security_notice SET notified_at = GREATEST(clock_timestamp(), created_at) WHERE id = $1 AND notified_at IS NULL`,
      [id],
    );
  }
  /**
   * M1: marker không bao giờ gửi được (vd. `InvalidEmailRequestError` — địa chỉ IdP không hợp lệ). Trạng thái CUỐI,
   * loại trừ với `notified_at` (`security_notice_terminal_check`); idempotent như `markNotified`.
   */
  async abandon(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth.security_notice SET abandoned_at = GREATEST(clock_timestamp(), created_at)
       WHERE id = $1 AND notified_at IS NULL AND abandoned_at IS NULL`,
      [id],
    );
  }
  /** M1: marker đã bỏ không tính vào tuổi backlog — chúng không bao giờ tự gửi, gauge chỉ đo cái CÒN chờ gửi. */
  async oldestPendingAgeSec(): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT extract(epoch FROM now() - min(created_at))::float8 AS age FROM auth.security_notice WHERE notified_at IS NULL AND abandoned_at IS NULL`,
    );
    return AgeRow.parse(rows[0]).age;
  }
}
