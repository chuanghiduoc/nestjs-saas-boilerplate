import type { INestApplication } from '@nestjs/common';
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
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const TABLES = [
  'org_invitations',
  'org_invite_links',
  'org_ownership_transfers',
] as const;

describe('tenant isolation of the 3C tables through the app (spec SP3 §1 criterion 1, §18.1)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let b: SeededOrg;
  const inA = <T>(fn: () => Promise<T>) =>
    app.get(OrgScope).run(a.orgId, () => app.get(UnitOfWork).run(fn));
  const sql = <T extends object>(q: string, p: unknown[] = []) =>
    app.get(Db).execute<T>(q, p);
  const rowsOfB = () =>
    withAppClient((c) =>
      inOrgTx(c, b.orgId, async () => {
        const out: Record<string, number> = {};
        for (const t of TABLES)
          out[t] =
            (
              await c.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM ${t}`,
              )
            ).rows[0]?.n ?? -1;
        return out;
      }),
    );
  beforeAll(async () => {
    app = await createTestApp([DatabaseModule.forRoot({ relay: false })]);
    a = await seedOrg();
    b = await seedOrg();
    const bm = await seedMember(b, 'MEMBER');
    await seedInvitation(b, {
      email: 'iso@example.test',
      roleId: b.roles.MEMBER.id,
      inviterMemberId: b.owner.memberId,
    });
    await seedInviteLink(b, {
      roleId: b.roles.MEMBER.id,
      createdByMemberId: b.owner.memberId,
    });
    await seedTransfer(b, {
      fromMemberId: b.owner.memberId,
      toMemberId: bm.memberId,
    });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await app?.close();
  });

  it.each(TABLES)(
    '%s: read/update/delete of org B from OrgScope(A) touch 0 rows',
    async (table) => {
      const before = await rowsOfB();
      expect(before[table]).toBe(1);
      expect(
        await inA(() =>
          sql(`SELECT 1 FROM ${table} WHERE org_id = ?`, [b.orgId]),
        ),
      ).toEqual([]);
      expect(
        await inA(() =>
          sql(
            `UPDATE ${table} SET updated_at = now() WHERE org_id = ? RETURNING 1`,
            [b.orgId],
          ),
        ),
      ).toEqual([]);
      expect(
        await inA(() =>
          sql(`DELETE FROM ${table} WHERE org_id = ? RETURNING 1`, [b.orgId]),
        ),
      ).toEqual([]);
      expect(await rowsOfB()).toEqual(before);
    },
  );
  it('INSERT with org_id = B is refused by RLS (42501), not by a trigger', async () => {
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_invitations (org_id, email, role_id, status, token_hash, expires_at) VALUES (?, 'x@example.test', ?, 'PENDING', decode(repeat('aa', 32), 'hex'), now() + interval '1 day')`,
          [b.orgId, b.roles.MEMBER.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_invite_links (org_id, role_id, token_hash, max_uses, expires_at) VALUES (?, ?, decode(repeat('ab', 32), 'hex'), 1, now() + interval '1 day')`,
          [b.orgId, b.roles.MEMBER.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it('a child row in A pointing at a parent of B is 23503 (double FK)', async () => {
    await expect(
      inA(() =>
        sql(
          `INSERT INTO org_invitations (org_id, email, role_id, status, token_hash, expires_at) VALUES (?, 'y@example.test', ?, 'PENDING', decode(repeat('ac', 32), 'hex'), now() + interval '1 day')`,
          [a.orgId, b.roles.MEMBER.id],
        ),
      ),
    ).rejects.toThrow(/org_invitations_role_fk/);
  });
  it('without an org context every 3C table fails closed (P0001)', async () => {
    for (const t of TABLES)
      await expect(
        app.get(UnitOfWork).run(() => sql(`SELECT 1 FROM ${t}`)),
      ).rejects.toThrow(/org context is not set/);
  });
});
