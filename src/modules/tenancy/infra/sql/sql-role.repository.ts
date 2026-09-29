import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS, type SystemRoleKey } from '../../constants.js';
import { RoleRepository, type RoleRow } from '../../ports/role-repository.js';
import { ROLE_COLUMNS, RoleRowSchema, single } from './rows.js';

/**
 * Câu thứ hai của đường nóng (spec SP3 §7.3) và mọi lần đọc tập quyền role tuỳ biến. Index: PK
 * `org_role_permissions_pk (org_id, role_id, permission_id)`; `permissions` nhỏ (catalogue) nên join theo PK của nó.
 */
export const ROLE_PERMISSIONS_SQL = `SELECT rp.role_id::text AS role_id, p.key
FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id
WHERE rp.org_id = app_current_org() AND rp.role_id = ANY(ARRAY[?]::bigint[]) AND p.deprecated_at IS NULL
ORDER BY rp.role_id, p.key`;
const RoleKeyRow = z.object({ role_id: z.string(), key: z.string() });

@Injectable()
export class SqlRoleRepository extends RoleRepository {
  constructor(private readonly db: Db) {
    super();
  }

  /** `ARRAY[?]`: `Db.execute` (MikroORM `formatQuery`) nội suy mảng thành danh sách `'a', 'b'`, không thành literal mảng. */
  async insertSystemRoles(): Promise<Record<SystemRoleKey, RoleRow>> {
    const rows = (
      await this.db.execute(
        `INSERT INTO org_roles (org_id, system_key) SELECT app_current_org(), k FROM unnest(ARRAY[?]::text[]) AS k RETURNING ${ROLE_COLUMNS}`,
        [SYSTEM_ROLE_KEYS],
      )
    ).map((r) => RoleRowSchema.parse(r));
    const of = (k: SystemRoleKey): RoleRow => {
      const row = rows.find((r) => r.systemKey === k);
      if (!row) throw new Error(`system role ${k} was not inserted`);
      return row;
    };
    return { OWNER: of('OWNER'), ADMIN: of('ADMIN'), MEMBER: of('MEMBER') };
  }
  async list(): Promise<RoleRow[]> {
    const rows = await this.db.execute(
      `SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() ORDER BY id`,
    );
    return rows.map((r) => RoleRowSchema.parse(r));
  }
  async findByPublicId(publicId: string): Promise<RoleRow | undefined> {
    const [row] = await this.db.execute(
      `SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() AND public_id = ?`,
      [publicId],
    );
    return row ? RoleRowSchema.parse(row) : undefined;
  }
  async permissionKeys(
    roleIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(roleIds.map((id) => [id, []]));
    if (roleIds.length === 0) return out;
    for (const raw of await this.db.execute(ROLE_PERMISSIONS_SQL, [roleIds])) {
      const row = RoleKeyRow.parse(raw);
      const keys = out.get(row.role_id);
      if (!keys)
        throw new Error(
          `permissionKeys returned role ${row.role_id} that was not asked for`,
        );
      keys.push(row.key);
    }
    return out;
  }
  async insertCustom(r: {
    name: string;
    description: string | null;
  }): Promise<RoleRow> {
    return RoleRowSchema.parse(
      single(
        await this.db.execute(
          `INSERT INTO org_roles (org_id, name, description) VALUES (app_current_org(), ?, ?) RETURNING ${ROLE_COLUMNS}`,
          [r.name, r.description],
        ),
        'insert custom role',
      ),
    );
  }
  async lockByPublicId(publicId: string): Promise<RoleRow | undefined> {
    const [row] = await this.db.execute(
      `SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() AND public_id = ? FOR NO KEY UPDATE`,
      [publicId],
    );
    return row ? RoleRowSchema.parse(row) : undefined;
  }
  async update(
    id: string,
    r: { name: string; description: string | null },
  ): Promise<RoleRow> {
    return RoleRowSchema.parse(
      single(
        await this.db.execute(
          `UPDATE org_roles SET name = ?, description = ?, version = version + 1, updated_at = now() WHERE org_id = app_current_org() AND id = ? RETURNING ${ROLE_COLUMNS}`,
          [r.name, r.description, id],
        ),
        'update custom role',
      ),
    );
  }
  async replacePermissions(
    roleId: string,
    keys: ReadonlySet<string>,
  ): Promise<void> {
    const wanted = [...keys];
    await this.db.execute(
      `DELETE FROM org_role_permissions rp USING permissions p
       WHERE rp.org_id = app_current_org() AND rp.role_id = ? AND p.id = rp.permission_id AND NOT (p.key = ANY(ARRAY[?]::text[]))`,
      [roleId, wanted],
    );
    await this.db.execute(
      `INSERT INTO org_role_permissions (org_id, role_id, permission_id)
       SELECT app_current_org(), ?, p.id FROM permissions p
       WHERE p.key = ANY(ARRAY[?]::text[])
         AND NOT EXISTS (SELECT 1 FROM org_role_permissions x WHERE x.org_id = app_current_org() AND x.role_id = ? AND x.permission_id = p.id)`,
      [roleId, wanted, roleId],
    );
    const [count] = await this.db.execute<{ n: string }>(
      `SELECT count(*)::text AS n FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.org_id = app_current_org() AND rp.role_id = ? AND p.key = ANY(ARRAY[?]::text[])`,
      [roleId, wanted],
    );
    // Key hợp lệ theo catalogue trong code nhưng thiếu dòng `permissions` là lệch catalogue mà CatalogueCheck đã phải chặn
    // lúc boot: fail loud, không lưu âm thầm một tập nhỏ hơn yêu cầu.
    if (Number(count?.n) !== wanted.length)
      throw new Error(
        `role ${roleId}: stored permissions drifted from the catalogue`,
      );
  }
  async deleteById(id: string): Promise<void> {
    single(
      await this.db.execute(
        'DELETE FROM org_roles WHERE org_id = app_current_org() AND id = ? RETURNING id',
        [id],
      ),
      'delete custom role',
    );
  }
}
