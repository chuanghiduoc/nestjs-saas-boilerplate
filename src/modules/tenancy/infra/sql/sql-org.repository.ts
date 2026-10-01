import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import {
  OrgRepository,
  type OrgRow,
  type UserOrgRow,
} from '../../ports/org-repository.js';
import { ORG_PURGE_STATEMENTS } from './org-purge.sql.js';
import { ORG_COLUMNS, OrgRowSchema, single } from './rows.js';

const Count = z.object({ n: z.coerce.number().int() });
const OrgIdRow = z.object({ org_id: z.string() });
const Now = z.object({ now: z.coerce.date() });
const UserOrg = z
  .object({
    org_id: z.string(),
    org_name: z.string(),
    org_deleted_at: z.coerce.date().nullable(),
    org_purge_after: z.coerce.date().nullable(),
    member_public_id: z.string(),
    role_public_id: z.string(),
    role_system_key: z.string().nullable(),
    role_name: z.string().nullable(),
    joined_at: z.coerce.date(),
  })
  .transform((r): UserOrgRow => ({
    orgId: r.org_id,
    orgName: r.org_name,
    orgDeletedAt: r.org_deleted_at,
    orgPurgeAfter: r.org_purge_after,
    memberPublicId: r.member_public_id,
    rolePublicId: r.role_public_id,
    roleSystemKey: r.role_system_key,
    roleName: r.role_name,
    joinedAt: r.joined_at,
  }));
const CURRENT = 'id = app_current_org()';

@Injectable()
export class SqlOrgRepository extends OrgRepository {
  constructor(private readonly db: Db) {
    super();
  }

  private async one(
    sql: string,
    params: unknown[],
    what: string,
  ): Promise<OrgRow> {
    return OrgRowSchema.parse(single(await this.db.execute(sql, params), what));
  }
  private async maybe(sql: string): Promise<OrgRow | undefined> {
    const [row] = await this.db.execute(sql);
    return row ? OrgRowSchema.parse(row) : undefined;
  }

  insertCurrent(o: { name: string; createdByUserId: string }): Promise<OrgRow> {
    return this.one(
      `INSERT INTO organizations (id, name, created_by_user_id) VALUES (app_current_org(), ?, ?) RETURNING ${ORG_COLUMNS}`,
      [o.name, o.createdByUserId],
      'insert organization',
    );
  }
  readCurrent(): Promise<OrgRow | undefined> {
    return this.maybe(
      `SELECT ${ORG_COLUMNS} FROM organizations WHERE ${CURRENT}`,
    );
  }
  /** Điểm tuần tự hoá mọi mutation quản trị (spec SP3 §8.6 bước 1); không bao giờ `FOR UPDATE` (DB-I3). */
  lockCurrent(): Promise<OrgRow | undefined> {
    return this.maybe(
      `SELECT ${ORG_COLUMNS} FROM organizations WHERE ${CURRENT} FOR NO KEY UPDATE`,
    );
  }
  async clockNow(): Promise<Date> {
    return Now.parse(
      single(
        await this.db.execute('SELECT clock_timestamp() AS now'),
        'clock_timestamp',
      ),
    ).now;
  }
  rename(name: string): Promise<OrgRow> {
    return this.one(
      `UPDATE organizations SET name = ?, version = version + 1, updated_at = now() WHERE ${CURRENT} RETURNING ${ORG_COLUMNS}`,
      [name],
      'rename organization',
    );
  }
  softDelete(graceSec: number): Promise<OrgRow> {
    return this.one(
      `UPDATE organizations SET deleted_at = now(), purge_after = now() + make_interval(secs => ?),
         version = version + 1, updated_at = now()
       WHERE ${CURRENT} AND deleted_at IS NULL RETURNING ${ORG_COLUMNS}`,
      [graceSec],
      'soft delete organization',
    );
  }
  restore(): Promise<OrgRow> {
    return this.one(
      `UPDATE organizations SET deleted_at = NULL, purge_after = NULL, version = version + 1, updated_at = now()
       WHERE ${CURRENT} AND deleted_at IS NOT NULL RETURNING ${ORG_COLUMNS}`,
      [],
      'restore organization',
    );
  }
  async detachCreator(userId: string): Promise<boolean> {
    const rows = await this.db.execute(
      `UPDATE organizations SET created_by_user_id = NULL, version = version + 1, updated_at = now()
       WHERE ${CURRENT} AND created_by_user_id = ? RETURNING id`,
      [userId],
    );
    return rows.length === 1;
  }
  async purgeCurrent(): Promise<void> {
    for (const sql of ORG_PURGE_STATEMENTS) await this.db.execute(sql);
  }
  async listForUser(
    userId: string,
    includeDeleted: boolean,
    limit: number,
    offset: number,
  ): Promise<UserOrgRow[]> {
    const rows = await this.db.execute(
      'SELECT * FROM tenancy_list_user_orgs(?, ?, ?, ?)',
      [userId, includeDeleted, limit, offset],
    );
    return rows.map((r) => UserOrg.parse(r));
  }
  async countForUser(userId: string, includeDeleted: boolean): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute('SELECT tenancy_count_user_orgs(?, ?) AS n', [
          userId,
          includeDeleted,
        ]),
        'count user orgs',
      ),
    ).n;
  }
  async countCreatedBy(userId: string): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute('SELECT tenancy_count_orgs_created_by(?) AS n', [
          userId,
        ]),
        'count created orgs',
      ),
    ).n;
  }
  async soleOwnerOrgs(userId: string): Promise<string[]> {
    return (
      await this.db.execute(
        'SELECT org_id::text AS org_id FROM tenancy_user_sole_owner_orgs(?)',
        [userId],
      )
    ).map((r) => OrgIdRow.parse(r).org_id);
  }
  async relatedOrgIds(userId: string): Promise<string[]> {
    return (
      await this.db.execute(
        'SELECT org_id::text AS org_id FROM tenancy_user_related_org_ids(?)',
        [userId],
      )
    ).map((r) => OrgIdRow.parse(r).org_id);
  }
  async dueForPurge(after: string, limit: number): Promise<string[]> {
    return (
      await this.db.execute(
        'SELECT org_id::text AS org_id FROM tenancy_orgs_due_for_purge(?, ?)',
        [after, limit],
      )
    ).map((r) => OrgIdRow.parse(r).org_id);
  }
  async countMembershipsForUser(userId: string): Promise<number> {
    return Count.parse(
      single(
        await this.db.execute(
          'SELECT tenancy_count_user_memberships(?)::int AS n',
          [userId],
        ),
        'tenancy_count_user_memberships',
      ),
    ).n;
  }
}
