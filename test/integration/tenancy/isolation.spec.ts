import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  Db,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import { createTestApp } from '../../support/app-factory.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const TABLES = [
  ['organizations', 'id'],
  ['org_roles', 'org_id'],
  ['org_members', 'org_id'],
  ['scheduled_tasks', 'org_id'],
] as const;

describe('tenant isolation of the 3A tables through the app (spec SP3 §1 criterion 1, §18.1)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  const inA = <T>(fn: () => Promise<T>) =>
    app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) =>
    app.get(Db).execute<T>(q, p);
  /** Số dòng của org B trong từng bảng, đọc trong OrgScope(B): khẳng định scope A không chạm vào chúng. */
  const rowsOfB = () =>
    withAppClient((c) =>
      inOrgTx(c, b.orgId, async () => {
        const out: Record<string, number> = {};
        for (const [table] of TABLES)
          out[table] =
            (
              await c.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM ${table}`,
              )
            ).rows[0]?.n ?? -1;
        return out;
      }),
    );

  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    a = await seedOrg();
    b = await seedOrg();
    // B có một lịch: không có dòng thì ca `scheduled_tasks` đạt mà không chứng minh gì.
    await withAppClient((c) =>
      inOrgTx(c, b.orgId, () =>
        c.query(
          `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled)
           VALUES ($1, 'iso', 'fixture.tenant.report', '0 1 * * *', 'UTC', '{}', true)`,
          [b.orgId],
        ),
      ),
    );
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await app?.close();
  });

  it.each(TABLES)(
    '%s: read/update/delete of org B from OrgScope(A) touch 0 rows',
    async (table, col) => {
      const before = await rowsOfB();
      expect(before[table]).toBeGreaterThan(0);
      expect(
        await inA(() =>
          sql(`SELECT 1 FROM ${table} WHERE ${col} = ?`, [b.orgId]),
        ),
      ).toEqual([]);
      expect(
        await inA(() =>
          sql(
            `UPDATE ${table} SET updated_at = now() WHERE ${col} = ? RETURNING 1`,
            [b.orgId],
          ),
        ),
      ).toEqual([]);
      expect(
        await inA(() =>
          sql(`DELETE FROM ${table} WHERE ${col} = ? RETURNING 1`, [b.orgId]),
        ),
      ).toEqual([]);
      expect(await rowsOfB()).toEqual(before);
    },
  );
  it('INSERT with org_id = B is refused by RLS (42501 → 404 at the mapper)', async () => {
    await expect(
      inA(() =>
        sql(`INSERT INTO org_roles (org_id, name) VALUES (?, 'x')`, [b.orgId]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inA(() =>
        sql(`INSERT INTO organizations (id, name) VALUES (?, 'x')`, [v7()]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inA(() =>
        sql(
          `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES (?, 'k', 'a.b', '0 1 * * *', 'UTC', '{}', true)`,
          [b.orgId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it('without an org context every tenancy table fails closed (P0001)', async () => {
    for (const t of ['organizations', 'org_roles', 'org_members'])
      await expect(
        app.get(UnitOfWork).run(() => sql(`SELECT 1 FROM ${t}`)),
      ).rejects.toThrow(/org context is not set/);
  });
  it('a child row in A pointing at a parent in B violates the composite FK (23503)', async () => {
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_members (org_id, user_id, role_id) VALUES (?, ?, ?)`,
          [a.orgId, b.owner.userId, b.roles.MEMBER.id],
        ),
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'org_members_role_fk',
    });
  });
  it('a reused connection does not keep the org of a committed transaction', async () => {
    await withAppClient(async (c) => {
      await inOrgTx(c, a.orgId, () => c.query('SELECT 1 FROM org_members'));
      await expect(c.query('SELECT 1 FROM org_members')).rejects.toMatchObject({
        code: 'P0001',
      });
    });
  });
});
