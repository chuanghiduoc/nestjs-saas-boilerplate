import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import { INVITATION_STATUSES } from '../../domain/invitation.js';
import {
  InvitationRepository,
  type InvitationRow,
  type TokenMatch,
} from '../../ports/invitation-repository.js';
import { single } from './rows.js';

const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    email: z.string(),
    role_id: z.string().nullable(),
    role_public_id: z.string().nullable(),
    role_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    role_name: z.string().nullable(),
    inviter_member_id: z.string().nullable(),
    status: z.enum(INVITATION_STATUSES),
    expires_at: z.coerce.date(),
    resolved_at: z.coerce.date().nullable(),
    accepted_member_id: z.string().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform((r): InvitationRow => ({
    id: r.id,
    publicId: r.public_id,
    email: r.email,
    roleId: r.role_id,
    rolePublicId: r.role_public_id,
    roleSystemKey: r.role_system_key,
    roleName: r.role_name,
    inviterMemberId: r.inviter_member_id,
    status: r.status,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
    acceptedMemberId: r.accepted_member_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
const Match = z
  .object({ org_id: z.string(), id: z.string() })
  .transform((r): TokenMatch => ({ orgId: r.org_id, id: r.id }));
const Count = z.object({ n: z.coerce.number().int() });
/** Lời mời + role (LEFT JOIN: role của lời mời đã kết thúc có thể đã bị xoá, `role_id` NULL, DB-I2). */
const SELECT = `SELECT i.id::text AS id, i.public_id::text AS public_id, i.email, i.role_id::text AS role_id,
    r.public_id::text AS role_public_id, r.system_key AS role_system_key, r.name AS role_name,
    i.inviter_member_id::text AS inviter_member_id, i.status, i.expires_at, i.resolved_at,
    i.accepted_member_id::text AS accepted_member_id, i.version, i.created_at, i.updated_at
  FROM org_invitations i LEFT JOIN org_roles r ON r.org_id = i.org_id AND r.id = i.role_id`;
const IN_ORG = 'i.org_id = app_current_org()';

/**
 * Mốc kết thúc (`resolved_at`/`revoked_at`) dùng `clock_timestamp()`, không `now()`: mọi câu ghi này chạy SAU khoá org,
 * còn `now()` là giờ BEGIN — transaction bắt đầu trước rồi chờ khoá sau một lần tạo đã commit sẽ ghi mốc sớm hơn
 * `created_at` và vi phạm `*_resolved_ck`/`*_revoked_ck` (final review 3C M-1).
 */
@Injectable()
export class SqlInvitationRepository extends InvitationRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async byId(
    id: string,
    lock = false,
  ): Promise<InvitationRow | undefined> {
    const [row] = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND i.id = ?${lock ? ' FOR NO KEY UPDATE OF i' : ''}`,
      [id],
    );
    return row ? Row.parse(row) : undefined;
  }
  private async byPublicId(
    publicId: string,
    lock = false,
  ): Promise<InvitationRow | undefined> {
    const [row] = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND i.public_id = ?${lock ? ' FOR NO KEY UPDATE OF i' : ''}`,
      [publicId],
    );
    return row ? Row.parse(row) : undefined;
  }
  private async reread(
    rows: readonly { id: string }[],
    what: string,
  ): Promise<InvitationRow | undefined> {
    const [r] = rows;
    if (!r) return undefined;
    const row = await this.byId(r.id);
    if (!row) throw new Error(`${what}: updated invitation vanished`);
    return row;
  }

  async findByTokenHash(hashHex: string): Promise<TokenMatch | undefined> {
    const [row] = await this.db.execute(
      `SELECT org_id::text AS org_id, invitation_id::text AS id FROM tenancy_find_invitation(decode(?, 'hex'))`,
      [hashHex],
    );
    return row ? Match.parse(row) : undefined;
  }
  async insert(i: {
    email: string;
    roleId: string;
    inviterMemberId: string;
    tokenHashHex: string;
    ttlSec: number;
  }): Promise<InvitationRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_invitations (org_id, email, role_id, inviter_member_id, status, token_hash, expires_at)
         VALUES (app_current_org(), ?, ?, ?, 'PENDING', decode(?, 'hex'), now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [i.email, i.roleId, i.inviterMemberId, i.tokenHashHex, i.ttlSec],
      ),
      'insert invitation',
    );
    const row = await this.byId(created.id);
    if (!row) throw new Error('insert invitation: row vanished');
    return row;
  }
  findByPublicId(publicId: string): Promise<InvitationRow | undefined> {
    return this.byPublicId(publicId);
  }
  findById(id: string): Promise<InvitationRow | undefined> {
    return this.byId(id);
  }
  lockById(id: string): Promise<InvitationRow | undefined> {
    return this.byId(id, true);
  }
  lockByPublicId(publicId: string): Promise<InvitationRow | undefined> {
    return this.byPublicId(publicId, true);
  }
  async countOpen(): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute(
          `SELECT count(*)::int AS n FROM org_invitations WHERE org_id = app_current_org() AND status = 'PENDING' AND expires_at > clock_timestamp()`,
        ),
        'count open invitations',
      ),
    ).n;
  }
  async expireLapsedForEmail(email: string): Promise<void> {
    await this.db.execute(
      `UPDATE org_invitations SET status = 'EXPIRED', token_hash = NULL, resolved_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND email = ? AND status = 'PENDING' AND expires_at <= clock_timestamp()`,
      [email],
    );
  }
  async resolve(
    id: string,
    to: 'REVOKED' | 'EXPIRED' | 'INVALIDATED',
  ): Promise<InvitationRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invitations SET status = ?, token_hash = NULL, resolved_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND status = 'PENDING' RETURNING id::text AS id`,
        [to, id],
      ),
      'resolve invitation',
    );
  }
  async accept(
    id: string,
    acceptedMemberId: string,
  ): Promise<InvitationRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invitations SET status = 'ACCEPTED', token_hash = NULL, resolved_at = clock_timestamp(), accepted_member_id = ?,
           version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND status = 'PENDING' AND expires_at > clock_timestamp() RETURNING id::text AS id`,
        [acceptedMemberId, id],
      ),
      'accept invitation',
    );
  }
  async list(q: { limit: number; offset: number }): Promise<InvitationRow[]> {
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} ORDER BY i.created_at, i.id LIMIT ? OFFSET ?`,
      [q.limit, q.offset],
    );
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(cap: number): Promise<number> {
    return countUpTo(
      this.db,
      'SELECT 1 FROM org_invitations WHERE org_id = app_current_org()',
      [],
      cap,
    );
  }
  async expireLapsedForRole(roleId: string): Promise<void> {
    await this.db.execute(
      `UPDATE org_invitations SET status = 'EXPIRED', token_hash = NULL, resolved_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND role_id = ? AND status = 'PENDING' AND expires_at <= clock_timestamp()`,
      [roleId],
    );
  }
  async revokeAllPending(): Promise<void> {
    await this.db.execute(
      `UPDATE org_invitations SET status = 'REVOKED', token_hash = NULL, resolved_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND status = 'PENDING'`,
    );
  }
}
