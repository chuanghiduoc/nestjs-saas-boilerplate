import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db, OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { MemberRepository } from '../../../src/modules/tenancy/ports/member-repository.js';
import { OrgRepository } from '../../../src/modules/tenancy/ports/org-repository.js';
import { RoleRepository } from '../../../src/modules/tenancy/ports/role-repository.js';
import { TenancyUserRepository } from '../../../src/modules/tenancy/ports/tenancy-user-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ROUNDS = 20;

describe('tenancy SQL repositories (spec SP3 §6, §8.6)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const createdUserIds: string[] = [];
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await withAppClient(async (c) => {
      for (const id of createdUserIds)
        await c.query('DELETE FROM tenancy_users WHERE id = $1', [id]);
    });
    await app?.close();
  });
  const uow = () => app.get(UnitOfWork);
  const users = () => app.get(TenancyUserRepository);

  it(`X-6 / T-25: ${ROUNDS} rounds of two first requests of the same subject lock the same single row`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = {
        kind: 'EXTERNAL' as const,
        externalSubject: `x6:${randomUUID()}`,
      };
      const [a, b] = await Promise.all([
        uow().run(() => users().upsertAndLock(s)),
        uow().run(() => users().upsertAndLock(s)),
      ]);
      expect(a).toEqual(b);
      createdUserIds.push(a.id);
    }
  });
  it('find never creates a row', async () => {
    expect(
      await users().find({
        kind: 'EXTERNAL',
        externalSubject: `ghost:${randomUUID()}`,
      }),
    ).toBeUndefined();
  });
  it('the vanish window is real: a row deleted between INSERT … DO NOTHING and the lock reads as no row (DB2-M10)', async () => {
    const subject = `vanish:${randomUUID()}`;
    await withAppClient((c) =>
      c.query('INSERT INTO tenancy_users (external_subject) VALUES ($1)', [
        subject,
      ]),
    );
    await withAppClient(async (b) =>
      withAppClient(async (a) => {
        await b.query('BEGIN');
        await b.query(
          'INSERT INTO tenancy_users (external_subject) VALUES ($1) ON CONFLICT (external_subject) DO NOTHING',
          [subject],
        );
        await a.query('DELETE FROM tenancy_users WHERE external_subject = $1', [
          subject,
        ]);
        const { rowCount } = await b.query(
          'SELECT id FROM tenancy_users WHERE external_subject = $1 FOR NO KEY UPDATE',
          [subject],
        );
        await b.query('ROLLBACK');
        expect(rowCount).toBe(0);
      }),
    );
  });
  it('list orders roles by the numeric id, not by the text id alias, across a digit boundary', async () => {
    // `ROLE_COLUMNS` selects `id::text AS id`; a bare `ORDER BY id` binds to that output alias and sorts
    // "10" < "11" < "9". Park the sequence so the three system roles get ids 10^k−1, 10^k, 10^k+1.
    const [seq] = await ownerQuery<{ last: string }>(
      `SELECT last_value::text AS last FROM org_roles_id_seq`,
    );
    if (!seq) throw new Error('org_roles_id_seq has no row');
    const nextPowerOfTen = 10n ** BigInt(String(BigInt(seq.last) + 2n).length);
    await ownerQuery(`SELECT setval('org_roles_id_seq', $1::bigint)`, [
      String(nextPowerOfTen - 2n),
    ]);
    const org = await seedOrg();
    orgs.push(org);
    await app.get(OrgScope).run(org.orgId, () =>
      uow().run(async () => {
        expect(
          (await app.get(RoleRepository).list()).map((r) => r.systemKey),
        ).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
      }),
    );
  });
  it('org, roles and members round-trip inside OrgScope; lockCurrent does not block a child INSERT (DB-I3)', async () => {
    const org = await seedOrg();
    orgs.push(org);
    const m = await seedMember(org, 'MEMBER');
    await app.get(OrgScope).run(org.orgId, () =>
      uow().run(async () => {
        const locked = await app.get(OrgRepository).lockCurrent();
        expect(locked?.id).toBe(org.orgId);
        expect(
          (await app.get(OrgRepository).clockNow()).getTime(),
        ).toBeGreaterThan(0);
        expect(
          (await app.get(RoleRepository).list()).map((r) => r.systemKey),
        ).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
        const row = await app
          .get(MemberRepository)
          .findByPublicId(m.memberPublicId);
        expect(row).toMatchObject({
          userPublicId: m.userPublicId,
          systemKey: 'MEMBER',
        });
        expect(await app.get(MemberRepository).countUpTo(undefined, 100)).toBe(
          2,
        );
        // Một kết nối khác chèn dòng con có FK tới org trong lúc khoá đang giữ: không bị chặn.
        await withAppClient((c) =>
          inOrgTx(c, org.orgId, () =>
            c.query('INSERT INTO fixture_org_items (org_id) VALUES ($1)', [
              org.orgId,
            ]),
          ),
        );
        await withAppClient((c) =>
          inOrgTx(c, org.orgId, () =>
            c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [
              org.orgId,
            ]),
          ),
        );
      }),
    );
  });
  it('definer calls: listForUser hides soft-deleted orgs from non-owners; dueForPurge honours the cursor', async () => {
    const org = await seedOrg();
    orgs.push(org);
    const m = await seedMember(org, 'MEMBER');
    const repo = app.get(OrgRepository);
    expect(
      (await repo.listForUser(m.userId, false, 10, 0)).map((r) => r.orgId),
    ).toEqual([org.orgId]);
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
    expect(await repo.listForUser(m.userId, true, 10, 0)).toEqual([]);
    expect(
      (await repo.listForUser(org.owner.userId, true, 10, 0)).map(
        (r) => r.orgId,
      ),
    ).toEqual([org.orgId]);
    expect(await repo.dueForPurge(org.orgId, 10)).not.toContain(org.orgId);
    expect(
      await repo.dueForPurge('00000000-0000-0000-0000-000000000000', 1000),
    ).toContain(org.orgId);
    expect(await repo.countCreatedBy(org.owner.userId)).toBe(1);
    expect(await repo.soleOwnerOrgs(org.owner.userId)).toEqual([]);
  });
  it('M9 / §3.15: softDelete writes deleted_at and purge_after from now() (transaction time), not clock_timestamp()', async () => {
    const org = await seedOrg();
    orgs.push(org);
    const graceSec = 86_400;
    const row = await app.get(OrgScope).run(org.orgId, () =>
      uow().run(async () => {
        await app.get(OrgRepository).lockCurrent();
        // Giờ thật trôi xa khỏi now(): clock_timestamp() sẽ lệch updated_at thấy được ở độ phân giải ms.
        await app.get(Db).execute('SELECT pg_sleep(0.05)');
        return app.get(OrgRepository).softDelete(graceSec);
      }),
    );
    expect(row.deletedAt?.getTime()).toBe(row.updatedAt.getTime());
    expect(
      (row.purgeAfter?.getTime() ?? 0) - (row.deletedAt?.getTime() ?? 0),
    ).toBe(graceSec * 1000);
  });
  it('a v7 id that is not an organization reads as undefined, not an error', async () => {
    await app
      .get(OrgScope)
      .run(v7(), async () =>
        expect(await app.get(OrgRepository).readCurrent()).toBeUndefined(),
      );
  });
});
