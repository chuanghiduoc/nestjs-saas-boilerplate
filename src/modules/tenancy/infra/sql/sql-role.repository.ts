import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS, type SystemRoleKey } from '../../constants.js';
import { RoleRepository, type RoleRow } from '../../ports/role-repository.js';
import { ROLE_COLUMNS, RoleRowSchema } from './rows.js';

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
}
