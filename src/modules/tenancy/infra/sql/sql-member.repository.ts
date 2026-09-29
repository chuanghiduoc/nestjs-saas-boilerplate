import { Injectable } from '@nestjs/common';
import { Db, countUpTo } from '../../../../core/database/index.js';
import {
  MemberRepository,
  type MemberRow,
} from '../../ports/member-repository.js';
import { MEMBER_SELECT, MemberRowSchema, single } from './rows.js';

const IN_ORG = 'm.org_id = app_current_org()';

@Injectable()
export class SqlMemberRepository extends MemberRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async byId(id: string): Promise<MemberRow> {
    return MemberRowSchema.parse(
      single(
        await this.db.execute(`${MEMBER_SELECT} WHERE ${IN_ORG} AND m.id = ?`, [
          id,
        ]),
        'member by id',
      ),
    );
  }

  async insert(m: { userId: string; roleId: string }): Promise<MemberRow> {
    const [row] = await this.db.execute<{ id: string }>(
      'INSERT INTO org_members (org_id, user_id, role_id) VALUES (app_current_org(), ?, ?) RETURNING id::text AS id',
      [m.userId, m.roleId],
    );
    if (!row) throw new Error('insert member returned no row');
    return this.byId(row.id);
  }
  async findByPublicId(publicId: string): Promise<MemberRow | undefined> {
    const [row] = await this.db.execute(
      `${MEMBER_SELECT} WHERE ${IN_ORG} AND m.public_id = ?`,
      [publicId],
    );
    return row ? MemberRowSchema.parse(row) : undefined;
  }
  async findByUserId(userId: string): Promise<MemberRow | undefined> {
    const [row] = await this.db.execute(
      `${MEMBER_SELECT} WHERE ${IN_ORG} AND m.user_id = ?`,
      [userId],
    );
    return row ? MemberRowSchema.parse(row) : undefined;
  }
  async lockForShare(ids: readonly string[]): Promise<MemberRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.execute(
      `${MEMBER_SELECT} WHERE ${IN_ORG} AND m.id = ANY(?::bigint[]) ORDER BY m.id FOR SHARE OF m`,
      [ids],
    );
    return rows.map((r) => MemberRowSchema.parse(r));
  }
  async changeRole(id: string, roleId: string): Promise<MemberRow> {
    single(
      await this.db.execute(
        'UPDATE org_members SET role_id = ?, version = version + 1, updated_at = now() WHERE org_id = app_current_org() AND id = ? RETURNING id',
        [roleId, id],
      ),
      'change member role',
    );
    return this.byId(id);
  }
  async deleteById(id: string): Promise<void> {
    single(
      await this.db.execute(
        'DELETE FROM org_members WHERE org_id = app_current_org() AND id = ? RETURNING id',
        [id],
      ),
      'delete member',
    );
  }
  async list(q: {
    roleId?: string;
    limit: number;
    offset: number;
  }): Promise<MemberRow[]> {
    const rows =
      q.roleId === undefined
        ? await this.db.execute(
            `${MEMBER_SELECT} WHERE ${IN_ORG} ORDER BY m.created_at, m.id LIMIT ? OFFSET ?`,
            [q.limit, q.offset],
          )
        : await this.db.execute(
            `${MEMBER_SELECT} WHERE ${IN_ORG} AND m.role_id = ? ORDER BY m.created_at, m.id LIMIT ? OFFSET ?`,
            [q.roleId, q.limit, q.offset],
          );
    return rows.map((r) => MemberRowSchema.parse(r));
  }
  countUpTo(roleId: string | undefined, cap: number): Promise<number> {
    return roleId === undefined
      ? countUpTo(
          this.db,
          'SELECT 1 FROM org_members WHERE org_id = app_current_org()',
          [],
          cap,
        )
      : countUpTo(
          this.db,
          'SELECT 1 FROM org_members WHERE org_id = app_current_org() AND role_id = ?',
          [roleId],
          cap,
        );
  }
}
