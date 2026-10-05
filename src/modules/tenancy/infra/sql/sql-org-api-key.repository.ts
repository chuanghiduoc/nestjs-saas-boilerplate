import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import {
  OrgApiKeyRepository,
  type ActiveKeyAccess,
  type OrgApiKeyMatch,
  type OrgApiKeyRow,
} from '../../ports/org-api-key-repository.js';
import { single } from './rows.js';

const keyList = z.array(z.string());
const Row = z
  .object({
    id: z.string(),
    public_id: z.string(),
    name: z.string(),
    key_hint: z.string(),
    created_by_member_id: z.string(),
    created_by_member_public_id: z.string(),
    permissions: keyList,
    expires_at: z.coerce.date(),
    revoked_at: z.coerce.date().nullable(),
    version: z.coerce.number().int(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .transform((r): OrgApiKeyRow => ({
    id: r.id,
    publicId: r.public_id,
    name: r.name,
    keyHint: r.key_hint,
    createdByMemberId: r.created_by_member_id,
    createdByMemberPublicId: r.created_by_member_public_id,
    permissions: r.permissions,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
const Access = z
  .object({
    key_id: z.string(),
    key_public_id: z.string(),
    creator_member_id: z.string(),
    creator_auth_user_id: z.string().nullable(),
    creator_role_id: z.string(),
    creator_system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
    scope: keyList,
  })
  .transform((r): ActiveKeyAccess => ({
    keyId: r.key_id,
    keyPublicId: r.key_public_id,
    creatorMemberId: r.creator_member_id,
    creatorAuthUserId: r.creator_auth_user_id,
    creatorRoleId: r.creator_role_id,
    creatorSystemKey: r.creator_system_key,
    scope: r.scope,
  }));
const Match = z
  .object({ org_id: z.string(), id: z.string(), public_id: z.string() })
  .transform((r): OrgApiKeyMatch => ({
    orgId: r.org_id,
    id: r.id,
    publicId: r.public_id,
  }));
const Count = z.object({ n: z.coerce.number().int() });
const Revoked = z
  .object({ public_id: z.string(), version: z.coerce.number().int() })
  .transform((r) => ({ publicId: r.public_id, version: r.version }));
/** Phạm vi không deprecated, đã sắp (PK bảng nối). */
const SCOPE = `COALESCE((SELECT array_agg(p.key ORDER BY p.key) FROM org_api_key_permissions kp JOIN permissions p ON p.id = kp.permission_id
  WHERE kp.org_id = k.org_id AND kp.api_key_id = k.id AND p.deprecated_at IS NULL), '{}'::text[])`;
const SELECT = `SELECT k.id::text AS id, k.public_id::text AS public_id, k.name, k.key_hint,
    k.created_by_member_id::text AS created_by_member_id, m.public_id::text AS created_by_member_public_id,
    ${SCOPE} AS permissions, k.expires_at, k.revoked_at, k.version, k.created_at, k.updated_at
  FROM org_api_keys k JOIN org_members m ON m.org_id = k.org_id AND m.id = k.created_by_member_id`;
const IN_ORG = 'k.org_id = app_current_org()';

/** Mốc thu hồi dùng `clock_timestamp()` (ghi SAU khoá org; bài học final review 3C M-1). */
@Injectable()
export class SqlOrgApiKeyRepository extends OrgApiKeyRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(
    where: string,
    params: unknown[],
    lock: boolean,
  ): Promise<OrgApiKeyRow | undefined> {
    const [row] = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG} AND ${where}${lock ? ' FOR NO KEY UPDATE OF k' : ''}`,
      params,
    );
    return row ? Row.parse(row) : undefined;
  }

  async findByTokenHash(hashHex: string): Promise<OrgApiKeyMatch | undefined> {
    const [row] = await this.db.execute(
      `SELECT org_id::text AS org_id, api_key_id::text AS id, api_key_public_id::text AS public_id FROM tenancy_find_org_api_key(decode(?, 'hex'))`,
      [hashHex],
    );
    return row ? Match.parse(row) : undefined;
  }

  async findActiveForAccess(
    publicId: string,
  ): Promise<ActiveKeyAccess | undefined> {
    const [row] = await this.db.execute(
      `SELECT k.id::text AS key_id, k.public_id::text AS key_public_id, m.id::text AS creator_member_id,
         u.auth_user_id::text AS creator_auth_user_id, r.id::text AS creator_role_id, r.system_key AS creator_system_key,
         ${SCOPE} AS scope
       FROM org_api_keys k
       JOIN organizations o ON o.id = k.org_id
       JOIN org_members m ON m.org_id = k.org_id AND m.id = k.created_by_member_id
       JOIN tenancy_users u ON u.id = m.user_id
       JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE ${IN_ORG} AND k.public_id = ? AND k.revoked_at IS NULL AND k.expires_at > now() AND o.deleted_at IS NULL`,
      [publicId],
    );
    return row ? Access.parse(row) : undefined;
  }

  async insert(k: {
    createdByMemberId: string;
    name: string;
    tokenHashHex: string;
    keyHint: string;
    expiresInSec: number;
    permissions: readonly string[];
  }): Promise<OrgApiKeyRow> {
    const keys = [...new Set(k.permissions)];
    // Phạm vi rỗng không bao giờ tới đây (schema đòi ít nhất một quyền); tới được là lỗi lập trình, không phải 500 mơ hồ của SQL.
    if (keys.length === 0) throw new Error('insert org api key: empty scope');
    const created = single(
      await this.db.execute<{ id: string }>(
        `INSERT INTO org_api_keys (org_id, created_by_member_id, name, token_hash, key_hint, expires_at)
         VALUES (app_current_org(), ?, ?, decode(?, 'hex'), ?, now() + make_interval(secs => ?)) RETURNING id::text AS id`,
        [
          k.createdByMemberId,
          k.name,
          k.tokenHashHex,
          k.keyHint,
          k.expiresInSec,
        ],
      ),
      'insert org api key',
    );
    const inserted = await this.db.execute(
      `INSERT INTO org_api_key_permissions (org_id, api_key_id, permission_id)
       SELECT app_current_org(), ?, p.id FROM permissions p WHERE p.key = ANY(ARRAY[?]::text[]) RETURNING permission_id`,
      [created.id, keys],
    );
    if (inserted.length !== keys.length)
      throw new Error('insert org api key: a scope key has no permissions row');
    const row = await this.one('k.id = ?', [created.id], false);
    if (!row) throw new Error('insert org api key: row vanished');
    return row;
  }

  async countActiveForMember(memberId: string): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute(
          `SELECT count(*)::int AS n FROM org_api_keys WHERE org_id = app_current_org() AND created_by_member_id = ?
             AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
          [memberId],
        ),
        'count active keys',
      ),
    ).n;
  }

  findByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined> {
    return this.one('k.public_id = ?', [publicId], false);
  }

  lockByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined> {
    return this.one('k.public_id = ?', [publicId], true);
  }

  async revoke(id: string): Promise<OrgApiKeyRow | undefined> {
    const [r] = await this.db.execute<{ id: string }>(
      `UPDATE org_api_keys SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND id = ? AND revoked_at IS NULL RETURNING id::text AS id`,
      [id],
    );
    return r ? this.one('k.id = ?', [r.id], false) : undefined;
  }

  async revokeAll(): Promise<void> {
    await this.db.execute(
      `UPDATE org_api_keys SET revoked_at = clock_timestamp(), version = version + 1, updated_at = now()
       WHERE org_id = app_current_org() AND revoked_at IS NULL`,
    );
  }

  async unrevokedOfMember(
    memberId: string,
  ): Promise<{ publicId: string; version: number }[]> {
    const rows = await this.db.execute(
      `SELECT public_id::text AS public_id, version FROM org_api_keys
       WHERE org_id = app_current_org() AND created_by_member_id = ? AND revoked_at IS NULL ORDER BY id`,
      [memberId],
    );
    return rows.map((r) => Revoked.parse(r));
  }

  async list(q: {
    memberId?: string;
    limit: number;
    offset: number;
  }): Promise<OrgApiKeyRow[]> {
    const rows = await this.db.execute(
      `${SELECT} WHERE ${IN_ORG}${q.memberId === undefined ? '' : ' AND k.created_by_member_id = ?'} ORDER BY k.created_at, k.id LIMIT ? OFFSET ?`,
      q.memberId === undefined
        ? [q.limit, q.offset]
        : [q.memberId, q.limit, q.offset],
    );
    return rows.map((r) => Row.parse(r));
  }

  countUpTo(memberId: string | undefined, cap: number): Promise<number> {
    return memberId === undefined
      ? countUpTo(
          this.db,
          'SELECT 1 FROM org_api_keys WHERE org_id = app_current_org()',
          [],
          cap,
        )
      : countUpTo(
          this.db,
          'SELECT 1 FROM org_api_keys WHERE org_id = app_current_org() AND created_by_member_id = ?',
          [memberId],
          cap,
        );
  }
}
