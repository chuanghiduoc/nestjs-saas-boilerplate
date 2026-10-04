import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import {
  SupportGrantRepository,
  type OpenGrantAccess,
  type SupportGrantRow,
} from '../../ports/support-grant-repository.js';
import { single } from './rows.js';

const keyList = z.array(z.string());
const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    grantee_user_id: z.string().nullable(),
    grantee_user_public_id: z.string().nullable(),
    granted_by_member_id: z.string().nullable(),
    granted_by_member_public_id: z.string().nullable(),
    reason: z.string(),
    permissions: keyList,
    expires_at: z.coerce.date(),
    revoked_at: z.coerce.date().nullable(),
    first_used_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform((r): SupportGrantRow => ({
    id: r.id,
    publicId: r.public_id,
    granteeUserId: r.grantee_user_id,
    granteeUserPublicId: r.grantee_user_public_id,
    grantedByMemberId: r.granted_by_member_id,
    grantedByMemberPublicId: r.granted_by_member_public_id,
    reason: r.reason,
    permissions: r.permissions,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    firstUsedAt: r.first_used_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
const Access = z
  .object({
    grant_id: z.string(),
    grant_public_id: z.string(),
    first_used_at: z.coerce.date().nullable(),
    granter_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    scope: keyList,
  })
  .transform((r): OpenGrantAccess => ({
    grantId: r.grant_id,
    grantPublicId: r.grant_public_id,
    firstUsedAt: r.first_used_at,
    granterSystemKey: r.granter_system_key,
    scope: r.scope,
  }));
const OrgIdRow = z.object({ org_id: z.string() });
/** Phạm vi không deprecated, đã sắp (PK bảng nối). */
const SCOPE = `COALESCE((SELECT array_agg(p.key ORDER BY p.key) FROM org_support_grant_permissions gp JOIN permissions p ON p.id = gp.permission_id
  WHERE gp.org_id = g.org_id AND gp.grant_id = g.id AND p.deprecated_at IS NULL), '{}'::text[])`;
const SELECT = `SELECT g.id::text AS id, g.public_id::text AS public_id, g.grantee_user_id::text AS grantee_user_id,
    u.public_id::text AS grantee_user_public_id, g.granted_by_member_id::text AS granted_by_member_id,
    m.public_id::text AS granted_by_member_public_id, g.reason, ${SCOPE} AS permissions, g.expires_at, g.revoked_at,
    g.first_used_at, g.version, g.created_at, g.updated_at
  FROM org_support_grants g
  LEFT JOIN tenancy_users u ON u.id = g.grantee_user_id
  LEFT JOIN org_members m ON m.org_id = g.org_id AND m.id = g.granted_by_member_id`;
const IN_ORG = 'g.org_id = app_current_org()';

/** Mốc thu hồi/lần dùng đầu dùng `clock_timestamp()` (ghi SAU khoá org; bài học final review 3C M-1). */
@Injectable()
export class SqlSupportGrantRepository extends SupportGrantRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(
    where: string,
    params: unknown[],
    lock: boolean,
  ): Promise<SupportGrantRow | undefined> {
    const [row] = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF g' : ''}`,
      params,
    );
    return row ? Row.parse(row) : undefined;
  }

  private async reread(
    rows: readonly { id: string }[],
  ): Promise<SupportGrantRow[]> {
    const out: SupportGrantRow[] = [];
    for (const r of rows) {
      const row = await this.one('g.id = ?', [r.id], false);
      if (!row) throw new Error('updated support grant vanished');
      out.push(row);
    }
    return out;
  }

  async insert(g: {
    granteeUserId: string;
    grantedByMemberId: string;
    reason: string;
    expiresInSec: number;
    permissions: readonly string[];
  }): Promise<SupportGrantRow> {
    const keys = [...new Set(g.permissions)];
    // Phạm vi rỗng không bao giờ tới đây (schema đòi ít nhất một quyền); tới được là lỗi lập trình, không phải 500 mơ hồ của SQL.
    if (keys.length === 0) throw new Error('insert support grant: empty scope');
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_support_grants (org_id, grantee_user_id, granted_by_member_id, reason, expires_at)
         VALUES (app_current_org(), ?, ?, ?, now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [g.granteeUserId, g.grantedByMemberId, g.reason, g.expiresInSec],
      ),
      'insert support grant',
    );
    const inserted = await this.db.execute(
      `INSERT INTO org_support_grant_permissions (org_id, grant_id, permission_id)
       SELECT app_current_org(), ?, p.id FROM permissions p WHERE p.key = ANY(ARRAY[?]::text[]) RETURNING permission_id`,
      [created.id, keys],
    );
    if (inserted.length !== keys.length)
      throw new Error(
        'insert support grant: a preset key has no permissions row',
      );
    const row = await this.one('g.id = ?', [created.id], false);
    if (!row) throw new Error('insert support grant: row vanished');
    return row;
  }

  async revokeOpenForGrantee(
    granteeUserId: string,
  ): Promise<SupportGrantRow[]> {
    return this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_support_grants SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND grantee_user_id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
        [granteeUserId],
      ),
    );
  }

  findByPublicId(publicId: string): Promise<SupportGrantRow | undefined> {
    return this.one('g.public_id = ?', [publicId], false);
  }

  lockByPublicId(publicId: string): Promise<SupportGrantRow | undefined> {
    return this.one('g.public_id = ?', [publicId], true);
  }

  async revoke(id: string): Promise<SupportGrantRow | undefined> {
    const [row] = await this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_support_grants SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
        [id],
      ),
    );
    return row;
  }

  async revokeAll(): Promise<void> {
    await this.db.execute(
      `UPDATE org_support_grants SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND revoked_at IS NULL`,
    );
  }

  async list(q: { limit: number; offset: number }): Promise<SupportGrantRow[]> {
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} ORDER BY g.created_at, g.id LIMIT ? OFFSET ?`,
      [q.limit, q.offset],
    );
    return rows.map((r) => Row.parse(r));
  }

  countUpTo(cap: number): Promise<number> {
    return countUpTo(
      this.db,
      'SELECT 1 FROM org_support_grants WHERE org_id = app_current_org()',
      [],
      cap,
    );
  }

  async findOpenForAccess(
    authUserId: string,
  ): Promise<OpenGrantAccess | undefined> {
    const [row] = await this.db.execute(
      `WITH u AS (SELECT id FROM tenancy_users WHERE auth_user_id = ?::uuid)
       SELECT g.id::text AS grant_id, g.public_id::text AS grant_public_id, g.first_used_at, r.system_key AS granter_system_key,
         ${SCOPE} AS scope
       FROM org_support_grants g
       LEFT JOIN org_members m ON m.org_id = g.org_id AND m.id = g.granted_by_member_id
       LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE ${IN_ORG} AND g.grantee_user_id = (SELECT id FROM u) AND g.revoked_at IS NULL AND g.expires_at > now()`,
      [authUserId],
    );
    return row ? Access.parse(row) : undefined;
  }

  async markFirstUse(id: string): Promise<SupportGrantRow | undefined> {
    const [row] = await this.reread(
      await this.db.execute<{ id: string }>(
        `UPDATE org_support_grants SET first_used_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE org_id = app_current_org() AND id = ? AND first_used_at IS NULL RETURNING id::text AS id`,
        [id],
      ),
    );
    return row;
  }

  async granteeOpenGrantOrgs(userId: string): Promise<string[]> {
    const rows = await this.db.execute(
      `SELECT org_id::text AS org_id FROM tenancy_grantee_open_grant_orgs(?)`,
      [userId],
    );
    return rows.map((r) => OrgIdRow.parse(r).org_id);
  }
}
