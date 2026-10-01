import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import type { TokenMatch } from '../../ports/invitation-repository.js';
import {
  InviteLinkRepository,
  type InviteLinkRow,
} from '../../ports/invite-link-repository.js';
import { single } from './rows.js';

const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    role_id: z.string().nullable(),
    role_public_id: z.string().nullable(),
    role_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    role_name: z.string().nullable(),
    created_by_member_id: z.string().nullable(),
    max_uses: z.coerce.number().int(),
    use_count: z.coerce.number().int(),
    expires_at: z.coerce.date(),
    revoked_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform((r): InviteLinkRow => ({
    id: r.id,
    publicId: r.public_id,
    roleId: r.role_id,
    rolePublicId: r.role_public_id,
    roleSystemKey: r.role_system_key,
    roleName: r.role_name,
    createdByMemberId: r.created_by_member_id,
    maxUses: r.max_uses,
    useCount: r.use_count,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
const Match = z
  .object({ org_id: z.string(), id: z.string() })
  .transform((r): TokenMatch => ({ orgId: r.org_id, id: r.id }));
const Count = z.object({ n: z.coerce.number().int() });
const Revoked = z
  .object({ public_id: z.string(), version: z.coerce.number().int() })
  .transform((r) => ({ publicId: r.public_id, version: r.version }));
const SELECT = `SELECT l.id::text AS id, l.public_id::text AS public_id, l.role_id::text AS role_id,
    r.public_id::text AS role_public_id, r.system_key AS role_system_key, r.name AS role_name,
    l.created_by_member_id::text AS created_by_member_id, l.max_uses, l.use_count, l.expires_at, l.revoked_at,
    l.version, l.created_at, l.updated_at
  FROM org_invite_links l LEFT JOIN org_roles r ON r.org_id = l.org_id AND r.id = l.role_id`;
const IN_ORG = 'l.org_id = app_current_org()';
/** "Đang mở" (spec §6.8 DB-M2), đo SAU khoá org nên dùng `clock_timestamp()` (§3.15). */
const OPEN =
  'revoked_at IS NULL AND expires_at > clock_timestamp() AND use_count < max_uses';

@Injectable()
export class SqlInviteLinkRepository extends InviteLinkRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(
    where: string,
    params: unknown[],
    lock: boolean,
  ): Promise<InviteLinkRow | undefined> {
    const [row] = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF l' : ''}`,
      params,
    );
    return row ? Row.parse(row) : undefined;
  }
  private async reread(
    rows: readonly { id: string }[],
  ): Promise<InviteLinkRow | undefined> {
    const [r] = rows;
    if (!r) return undefined;
    const row = await this.one('l.id = ?', [r.id], false);
    if (!row) throw new Error('updated invite link vanished');
    return row;
  }

  async findByTokenHash(hashHex: string): Promise<TokenMatch | undefined> {
    const [row] = await this.db.execute(
      `SELECT org_id::text AS org_id, invite_link_id::text AS id FROM tenancy_find_invite_link(decode(?, 'hex'))`,
      [hashHex],
    );
    return row ? Match.parse(row) : undefined;
  }
  async insert(l: {
    roleId: string;
    createdByMemberId: string;
    tokenHashHex: string;
    maxUses: number;
    expiresAt: Date;
  }): Promise<InviteLinkRow> {
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_invite_links (org_id, role_id, created_by_member_id, token_hash, max_uses, expires_at)
         VALUES (app_current_org(), ?, ?, decode(?, 'hex'), ?, ?::timestamptz) RETURNING id::text AS id`,
        [
          l.roleId,
          l.createdByMemberId,
          l.tokenHashHex,
          l.maxUses,
          l.expiresAt.toISOString(),
        ],
      ),
      'insert invite link',
    );
    const row = await this.one('l.id = ?', [created.id], false);
    if (!row) throw new Error('insert invite link: row vanished');
    return row;
  }
  findByPublicId(publicId: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.public_id = ?', [publicId], false);
  }
  findById(id: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.id = ?', [id], false);
  }
  lockById(id: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.id = ?', [id], true);
  }
  lockByPublicId(publicId: string): Promise<InviteLinkRow | undefined> {
    return this.one('l.public_id = ?', [publicId], true);
  }
  async countOpen(): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute(
          `SELECT count(*)::int AS n FROM org_invite_links WHERE org_id = app_current_org() AND ${OPEN}`,
        ),
        'count open links',
      ),
    ).n;
  }
  async consumeUse(id: string): Promise<InviteLinkRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invite_links SET use_count = use_count + 1, version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND ${OPEN} RETURNING id::text AS id`,
        [id],
      ),
    );
  }
  async revoke(id: string): Promise<InviteLinkRow | undefined> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_invite_links SET revoked_at = now(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
        [id],
      ),
    );
  }
  async revokeClosedForRole(
    roleId: string,
  ): Promise<{ publicId: string; version: number }[]> {
    const rows = await this.db.execute(
      `UPDATE org_invite_links SET revoked_at = now(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND role_id = ? AND revoked_at IS NULL
         AND (expires_at <= clock_timestamp() OR use_count >= max_uses)
       RETURNING public_id::text AS public_id, version`,
      [roleId],
    );
    return rows.map((r) => Revoked.parse(r));
  }
  async revokeAll(): Promise<void> {
    await this.db.execute(
      `UPDATE org_invite_links SET revoked_at = now(), version = version + 1, updated_at = now() WHERE org_id = app_current_org() AND revoked_at IS NULL`,
    );
  }
  async list(q: { limit: number; offset: number }): Promise<InviteLinkRow[]> {
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} ORDER BY l.created_at, l.id LIMIT ? OFFSET ?`,
      [q.limit, q.offset],
    );
    return rows.map((r) => Row.parse(r));
  }
  countUpTo(cap: number): Promise<number> {
    return countUpTo(
      this.db,
      'SELECT 1 FROM org_invite_links WHERE org_id = app_current_org()',
      [],
      cap,
    );
  }
}
