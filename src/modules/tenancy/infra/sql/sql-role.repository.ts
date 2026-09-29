import { Injectable } from '@nestjs/common';
import { Db } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS, type SystemRoleKey } from '../../constants.js';
import { RoleRepository, type RoleRow } from '../../ports/role-repository.js';
import { ROLE_COLUMNS, RoleRowSchema } from './rows.js';

@Injectable()
export class SqlRoleRepository extends RoleRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async insertSystemRoles(): Promise<Record<SystemRoleKey, RoleRow>> {
    const rows = (
      await this.db.execute(
        `INSERT INTO org_roles (org_id, system_key) SELECT app_current_org(), k FROM unnest(?::text[]) AS k RETURNING ${ROLE_COLUMNS}`,
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
  async findBySystemKey(key: SystemRoleKey): Promise<RoleRow | undefined> {
    const [row] = await this.db.execute(
      `SELECT ${ROLE_COLUMNS} FROM org_roles WHERE org_id = app_current_org() AND system_key = ?`,
      [key],
    );
    return row ? RoleRowSchema.parse(row) : undefined;
  }
}
