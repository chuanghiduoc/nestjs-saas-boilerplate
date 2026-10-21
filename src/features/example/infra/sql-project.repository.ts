import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../core/database/index.js';
import { PROJECT_STATUSES, type ProjectStatus } from '../domain/project.js';

export type ProjectRow = {
  id: string;
  publicId: string;
  orgId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  statusChangedAt: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/** Dòng vừa xoá: id công khai và version cuối (event xoá mang `version + 1`, spec §10.1). */
export type DeletedProject = { publicId: string; version: number };
export type ProjectLock = 'NONE' | 'NO_KEY_UPDATE';

const COLUMNS = `id::text AS id, public_id::text AS public_id, org_id::text AS org_id, name, description, status,
  status_changed_at, version, created_at, updated_at`;
const Row = z.object({
  id: z.string(),
  public_id: z.uuid(),
  org_id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  status_changed_at: z.coerce.date(),
  version: z.number().int(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
const toRow = (raw: unknown): ProjectRow => {
  const r = Row.parse(raw);
  return {
    id: r.id,
    publicId: r.public_id,
    orgId: r.org_id,
    name: r.name,
    description: r.description,
    status: r.status,
    statusChangedAt: r.status_changed_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};
const DeletedRow = z.object({ public_id: z.uuid(), version: z.number().int() });
const toDeleted = (raw: unknown): DeletedProject => {
  const r = DeletedRow.parse(raw);
  return { publicId: r.public_id, version: r.version };
};
const lockClause = (lock: ProjectLock): string => {
  switch (lock) {
    case 'NONE':
      return '';
    case 'NO_KEY_UPDATE':
      return ' FOR NO KEY UPDATE';
    default: {
      const unreachable: never = lock;
      throw new Error(`Unhandled project lock ${String(unreachable)}`);
    }
  }
};
const one = (rows: unknown[], what: string): ProjectRow => {
  const [r] = rows;
  if (r === undefined) throw new Error(`${what} returned no row`);
  return toRow(r);
};

/**
 * SQL thô qua `Db.execute` (spec SP7 §7.4, §8.1), chạy bằng `app_user` trong `OrgScope` + `UnitOfWork` của caller. Org lấy
 * từ `app_current_org()` (RLS là lớp chặn cuối); câu theo org của job/participant nhận `orgId` tường minh để dùng index.
 */
@Injectable()
export class ProjectRepository {
  constructor(private readonly db: Db) {}

  async insert(i: {
    name: string;
    description: string | null;
  }): Promise<ProjectRow> {
    return one(
      await this.db.execute(
        `INSERT INTO example_projects (org_id, name, description) VALUES (app_current_org(), ?, ?) RETURNING ${COLUMNS}`,
        [i.name, i.description],
      ),
      'example project insert',
    );
  }

  async find(
    publicId: string,
    lock: ProjectLock,
  ): Promise<ProjectRow | undefined> {
    const [r] = await this.db.execute(
      `SELECT ${COLUMNS} FROM example_projects WHERE org_id = app_current_org() AND public_id = ?::uuid${lockClause(lock)}`,
      [publicId],
    );
    return r === undefined ? undefined : toRow(r);
  }

  /** Keyset `public_id DESC` (D7-1) trên `example_projects_org_public_uq`; trả tối đa `limit + 1` dòng để biết còn trang sau. */
  async list(q: {
    limit: number;
    after?: string;
    status?: ProjectStatus;
  }): Promise<ProjectRow[]> {
    const where = ['org_id = app_current_org()'];
    const params: unknown[] = [];
    if (q.after !== undefined) {
      where.push('public_id < ?::uuid');
      params.push(q.after);
    }
    if (q.status !== undefined) {
      where.push('status = ?');
      params.push(q.status);
    }
    params.push(q.limit + 1);
    return (
      await this.db.execute(
        `SELECT ${COLUMNS} FROM example_projects WHERE ${where.join(' AND ')} ORDER BY public_id DESC LIMIT ?`,
        params,
      )
    ).map(toRow);
  }

  async updateFields(
    id: string,
    f: { name: string; description: string | null },
  ): Promise<ProjectRow> {
    return one(
      await this.db.execute(
        `UPDATE example_projects SET name = ?, description = ?, version = version + 1, updated_at = now()
         WHERE id = ?::bigint RETURNING ${COLUMNS}`,
        [f.name, f.description, id],
      ),
      'example project update',
    );
  }

  async setStatus(id: string, status: ProjectStatus): Promise<ProjectRow> {
    return one(
      await this.db.execute(
        `UPDATE example_projects SET status = ?, status_changed_at = now(), version = version + 1, updated_at = now()
         WHERE id = ?::bigint RETURNING ${COLUMNS}`,
        [status, id],
      ),
      'example project status update',
    );
  }

  async deleteOne(publicId: string): Promise<DeletedProject | undefined> {
    const [r] = await this.db.execute(
      `DELETE FROM example_projects WHERE org_id = app_current_org() AND public_id = ?::uuid RETURNING public_id::text AS public_id, version`,
      [publicId],
    );
    return r === undefined ? undefined : toDeleted(r);
  }

  /**
   * Câu 7.4 nguyên văn: `clock_timestamp()` vì so sau khi lấy khoá (SP3 §3.15); `SKIP LOCKED` để dòng đang bị
   * unarchive/PATCH giữ cho lượt sau (R7-5).
   */
  async deleteDue(
    orgId: string,
    retentionSec: number,
    limit: number,
  ): Promise<DeletedProject[]> {
    return (
      await this.db.execute(
        `WITH due AS (
  SELECT id FROM example_projects
  WHERE org_id = ?::uuid AND status = 'ARCHIVED'
    AND status_changed_at <= clock_timestamp() - make_interval(secs => ?::integer)
  ORDER BY status_changed_at, id
  LIMIT ?
  FOR NO KEY UPDATE SKIP LOCKED
)
DELETE FROM example_projects p USING due WHERE p.id = due.id
RETURNING p.public_id::text AS public_id, p.version`,
        [orgId, retentionSec, limit],
      )
    ).map(toDeleted);
  }

  /** Participant xoá cứng org (spec §10.3): trong transaction purge của tenancy, không event, không trả quota. */
  async deleteAllOfOrg(orgId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM example_projects WHERE org_id = ?::uuid',
      [orgId],
    );
  }
}
