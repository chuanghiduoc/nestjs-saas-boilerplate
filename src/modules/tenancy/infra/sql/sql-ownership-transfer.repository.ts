import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { STEP_DOWN_ROLES } from '../../constants.js';
import { TRANSFER_STATUSES } from '../../domain/ownership-transfer.js';
import {
  OwnershipTransferRepository,
  type TransferQuery,
  type TransferRow,
} from '../../ports/ownership-transfer-repository.js';
import { single } from './rows.js';

const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    from_member_id: z.string().nullable(),
    from_member_public_id: z.string().nullable(),
    to_member_id: z.string().nullable(),
    to_member_public_id: z.string().nullable(),
    step_down_to: z.enum(STEP_DOWN_ROLES).nullable(),
    status: z.enum(TRANSFER_STATUSES),
    expires_at: z.coerce.date(),
    resolved_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform((r): TransferRow => ({
    id: r.id,
    publicId: r.public_id,
    fromMemberId: r.from_member_id,
    fromMemberPublicId: r.from_member_public_id,
    toMemberId: r.to_member_id,
    toMemberPublicId: r.to_member_public_id,
    stepDownTo: r.step_down_to,
    status: r.status,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
const SELECT = `SELECT t.id::text AS id, t.public_id::text AS public_id,
    t.from_member_id::text AS from_member_id, f.public_id::text AS from_member_public_id,
    t.to_member_id::text AS to_member_id, o.public_id::text AS to_member_public_id,
    t.step_down_to, t.status, t.expires_at, t.resolved_at, t.version, t.created_at, t.updated_at
  FROM org_ownership_transfers t
  LEFT JOIN org_members f ON f.org_id = t.org_id AND f.id = t.from_member_id
  LEFT JOIN org_members o ON o.org_id = t.org_id AND o.id = t.to_member_id`;
const IN_ORG = 't.org_id = app_current_org()';
const RESOLVE = `UPDATE org_ownership_transfers SET status = ?, resolved_at = clock_timestamp(), version = version + 1, updated_at = now()
  WHERE org_id = app_current_org() AND id = ? AND status = 'PENDING' RETURNING id::text AS id`;

/** Bộ lọc theo trạng thái HIỆU LỰC (spec §9.3: PENDING quá hạn là EXPIRED với người đọc) và theo bên tham gia. */
function filterOf(q: TransferQuery): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (q.participantMemberId !== undefined) {
    parts.push('(t.from_member_id = ? OR t.to_member_id = ?)');
    params.push(q.participantMemberId, q.participantMemberId);
  }
  switch (q.status) {
    case undefined:
      break;
    case 'PENDING':
      parts.push(`t.status = 'PENDING' AND t.expires_at > now()`);
      break;
    case 'EXPIRED':
      parts.push(
        `(t.status = 'EXPIRED' OR (t.status = 'PENDING' AND t.expires_at <= now()))`,
      );
      break;
    case 'ACCEPTED':
    case 'DECLINED':
    case 'CANCELLED':
      parts.push('t.status = ?');
      params.push(q.status);
      break;
    default: {
      const unknown: never = q.status;
      throw new Error(`unknown transfer status filter ${String(unknown)}`);
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

/**
 * Mốc kết thúc (`resolved_at`/`revoked_at`) dùng `clock_timestamp()`, không `now()`: mọi câu ghi này chạy SAU khoá org,
 * còn `now()` là giờ BEGIN — transaction bắt đầu trước rồi chờ khoá sau một lần tạo đã commit sẽ ghi mốc sớm hơn
 * `created_at` và vi phạm `*_resolved_ck`/`*_revoked_ck` (final review 3C M-1).
 */
@Injectable()
export class SqlOwnershipTransferRepository extends OwnershipTransferRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(
    where: string,
    params: unknown[],
    lock: boolean,
  ): Promise<TransferRow | undefined> {
    const [row] = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF t' : ''}`,
      params,
    );
    return row ? Row.parse(row) : undefined;
  }

  async insert(t: {
    fromMemberId: string;
    toMemberId: string;
    stepDownTo: 'ADMIN' | 'MEMBER' | null;
    ttlSec: number;
  }): Promise<TransferRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_ownership_transfers (org_id, from_member_id, to_member_id, step_down_to, status, expires_at)
         VALUES (app_current_org(), ?, ?, ?, 'PENDING', now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [t.fromMemberId, t.toMemberId, t.stepDownTo, t.ttlSec],
      ),
      'insert ownership transfer',
    );
    const row = await this.one('t.id = ?', [created.id], false);
    if (!row) throw new Error('insert ownership transfer: row vanished');
    return row;
  }
  findByPublicId(publicId: string): Promise<TransferRow | undefined> {
    return this.one('t.public_id = ?', [publicId], false);
  }
  lockByPublicId(publicId: string): Promise<TransferRow | undefined> {
    return this.one('t.public_id = ?', [publicId], true);
  }
  async expireLapsed(): Promise<void> {
    await this.db.execute(
      `UPDATE org_ownership_transfers SET status = 'EXPIRED', resolved_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND status = 'PENDING' AND expires_at <= clock_timestamp()`,
    );
  }
  async resolve(
    id: string,
    to: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED',
  ): Promise<TransferRow | undefined> {
    const [r] = await this.db.execute<{ id: string }>(RESOLVE, [to, id]);
    if (!r) return undefined;
    const row = await this.one('t.id = ?', [r.id], false);
    if (!row) throw new Error('resolve ownership transfer: row vanished');
    return row;
  }
  async lockPendingForMember(memberId: string): Promise<TransferRow[]> {
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND t.status = 'PENDING' AND (t.from_member_id = ? OR t.to_member_id = ?) ORDER BY t.id FOR NO KEY UPDATE OF t`,
      [memberId, memberId],
    );
    return rows.map((r) => Row.parse(r));
  }
  async cancelAllPending(): Promise<void> {
    await this.db.execute(
      `UPDATE org_ownership_transfers SET status = 'CANCELLED', resolved_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND status = 'PENDING'`,
    );
  }
  async list(
    q: TransferQuery & { limit: number; offset: number },
  ): Promise<TransferRow[]> {
    const f = filterOf(q);
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG}${f.sql} ORDER BY t.created_at, t.id LIMIT ? OFFSET ?`,
      [...f.params, q.limit, q.offset],
    );
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(q: TransferQuery, cap: number): Promise<number> {
    const f = filterOf(q);
    return countUpTo(
      this.db,
      `SELECT 1 FROM org_ownership_transfers t WHERE ${IN_ORG}${f.sql}`,
      f.params,
      cap,
    );
  }
}
