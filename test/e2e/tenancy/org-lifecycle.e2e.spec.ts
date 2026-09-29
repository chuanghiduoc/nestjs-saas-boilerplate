import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ROUNDS = 10;
const idem = () => `k-${Date.now()}-${Math.random()}`;

describe('org lifecycle (spec SP3 §9.4, tiêu chí 8)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const orgWith = async () => {
    const owner = await seedP();
    const member = await seedP();
    const org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org);
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES ($1, 'lifecycle.probe', 'fixture.noop', '0 * * * *', 'UTC', '{}', true)`,
          [org.orgId],
        ),
      ),
    );
    return { owner, member, org };
  };
  const suspendedAt = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(
        c,
        orgId,
        async () =>
          (
            await c.query<{ suspended_at: Date | null }>(
              'SELECT suspended_at FROM scheduled_tasks WHERE org_id = $1',
              [orgId],
            )
          ).rows[0]?.suspended_at,
      ),
    );
  beforeAll(async () => {
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('soft delete → 204; members get 404 at once; schedules are suspended; org.deleted carries purgeAfter', async () => {
    const { owner, member, org } = await orgWith();
    expect(
      (await authed(app, owner).delete(`/v1/orgs/${org.orgId}`)).status,
    ).toBe(204);
    expect(
      (await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status,
    ).toBe(404);
    expect((await authed(app, owner).get(`/v1/orgs/${org.orgId}`)).status).toBe(
      404,
    );
    expect(await suspendedAt(org.orgId)).not.toBeNull();
    const [evt] = await ownerQuery<{ payload: { purgeAfter: string } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.deleted'`,
      [org.orgId],
    );
    expect(Date.parse(evt?.payload.purgeAfter ?? '')).toBeGreaterThan(
      Date.now(),
    );
  });
  it('POST /V1/ORGS/<id>/Restore/ reaches the restore handler (G-7); schedules resume; members are back', async () => {
    const { owner, member, org } = await orgWith();
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}`).expect(204);
    const r = await authed(app, owner)
      .post(`/V1/ORGS/${org.orgId.toUpperCase()}/Restore/`)
      .set('idempotency-key', idem())
      .send({});
    expect([r.status, r.body.deletedAt, r.body.purgeAfter]).toEqual([
      200,
      null,
      null,
    ]);
    expect(await suspendedAt(org.orgId)).toBeNull();
    expect(
      (await authed(app, member).get(`/v1/orgs/${org.orgId}`)).status,
    ).toBe(200);
  });
  it('restore of an active org → 409 org_not_deleted; a MEMBER of a deleted org → 403 at the guard', async () => {
    const { owner, member, org } = await orgWith();
    const active = await authed(app, owner)
      .post(`/v1/orgs/${org.orgId}/restore`)
      .set('idempotency-key', idem())
      .send({});
    expect([active.status, active.body.code]).toEqual([409, 'org_not_deleted']);
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}`).expect(204);
    // Middleware cho member của org xoá mềm đi tiếp ở route khôi phục; guard từ chối vì MEMBER không có org.restore.
    expect(
      (
        await authed(app, member)
          .post(`/v1/orgs/${org.orgId}/restore`)
          .set('idempotency-key', idem())
          .send({})
      ).status,
    ).toBe(403);
  });
  it('restore after purge_after → 404 (grace expired, compared with clock_timestamp after the lock)', async () => {
    const { owner, org } = await orgWith();
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
    expect(
      (
        await authed(app, owner)
          .post(`/v1/orgs/${org.orgId}/restore`)
          .set('idempotency-key', idem())
          .send({})
      ).status,
    ).toBe(404);
  });
  it(`T-12: ${ROUNDS} rounds of soft delete racing a rename never apply the rename after the delete`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { owner, org } = await orgWith();
      const [del, patch] = await Promise.all([
        authed(app, owner).delete(`/v1/orgs/${org.orgId}`),
        authed(app, owner)
          .patch(`/v1/orgs/${org.orgId}`)
          .set('if-match', '*')
          .send({ name: `Renamed ${i}` }),
      ]);
      expect(del.status).toBe(204);
      expect([200, 404]).toContain(patch.status);
      const row = await withAppClient((c) =>
        inOrgTx(
          c,
          org.orgId,
          async () =>
            (
              await c.query<{ name: string; version: number }>(
                'SELECT name, version FROM organizations WHERE id = $1',
                [org.orgId],
              )
            ).rows[0],
        ),
      );
      // Rename thắng thì xảy ra TRƯỚC delete (version 2 → 3); thua thì tên giữ nguyên (version 2).
      expect(row).toEqual(
        patch.status === 200
          ? { name: `Renamed ${i}`, version: 3 }
          : { name: expect.any(String), version: 2 },
      );
    }
  });
});
