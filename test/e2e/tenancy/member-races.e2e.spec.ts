import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  type SeededMember,
  type SeededOrg,
} from '../../support/tenancy-seed.js';
import { prng } from '../../unit/modules/tenancy/prng.js';

const ROUNDS = 50;
const X5_OPS = 20;
const X5_INSERTS = 5;
const X5_TARGETS = 3;
const X5_SEED = 20260928;
const INSERT_BUDGET_MS = 1000;

describe('member races (spec SP3 §17 T-1, T-24; §18.3 O-4, O-5, X-5)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  const owners = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(c, orgId, async () =>
        Number(
          (
            await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM org_members m JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id WHERE r.system_key = 'OWNER'`,
            )
          ).rows[0]?.n,
        ),
      ),
    );
  const twoOwners = async () => {
    const a = await seedP();
    const b = await seedP();
    const org = await seedOrg({ owner: { authUserId: a.authUserId } });
    orgs.push(org);
    const bm = await seedMember(org, 'OWNER', { authUserId: b.authUserId });
    return { org, a, b, am: org.owner, bm };
  };
  beforeAll(async () => {
    app = await startTenancyApp();
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`O-4: ${ROUNDS} rounds of two owners demoting each other → exactly one succeeds, one owner remains`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { org, a, b, am, bm } = await twoOwners();
      const [x, y] = await Promise.all([
        authed(app, a)
          .patch(`/v1/orgs/${org.orgId}/members/${bm.memberPublicId}`)
          .set('if-match', '*')
          .send({ roleId: org.roles.ADMIN.publicId }),
        authed(app, b)
          .patch(`/v1/orgs/${org.orgId}/members/${am.memberPublicId}`)
          .set('if-match', '*')
          .send({ roleId: org.roles.ADMIN.publicId }),
      ]);
      expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
      expect(
        [x.status, y.status].every((s) => s === 200 || s === 403 || s === 409),
      ).toBe(true);
      expect(await owners(org.orgId)).toBe(1);
    }
  });
  it(`O-5: ${ROUNDS} rounds of two owners leaving together → exactly one 204, the other 409 last_owner`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { org, a, b } = await twoOwners();
      const [x, y] = await Promise.all([
        authed(app, a).delete(`/v1/orgs/${org.orgId}/members/me`),
        authed(app, b).delete(`/v1/orgs/${org.orgId}/members/me`),
      ]);
      expect([x.status, y.status].sort((p, q) => p - q)).toEqual([204, 409]);
      expect(await owners(org.orgId)).toBe(1);
    }
  });
  it(`X-5 (system roles): ${X5_OPS} random admin mutations at once — no deadlock, no 5xx, ≥ 1 owner, feature INSERTs not blocked`, async () => {
    const { org, a, b } = await twoOwners();
    const targets: SeededMember[] = [];
    for (let i = 0; i < X5_TARGETS; i++)
      targets.push(
        await seedMember(org, 'MEMBER', {
          authUserId: (await seedP()).authUserId,
        }),
      );
    const rnd = prng(X5_SEED);
    const pick = <T>(xs: readonly T[]): T => {
      const x = xs[Math.floor(rnd() * xs.length)];
      if (x === undefined) throw new Error('pick from an empty list');
      return x;
    };
    const ops = Array.from({ length: X5_OPS }, () =>
      authed(app, pick([a, b]))
        .patch(`/v1/orgs/${org.orgId}/members/${pick(targets).memberPublicId}`)
        .set('if-match', '*')
        .send({
          roleId: pick([org.roles.ADMIN, org.roles.MEMBER, org.roles.OWNER])
            .publicId,
        }),
    );
    const inserts = Array.from({ length: X5_INSERTS }, () =>
      withAppClient((c) =>
        inOrgTx(c, org.orgId, async () => {
          const started = performance.now();
          await c.query('INSERT INTO fixture_org_items (org_id) VALUES ($1)', [
            org.orgId,
          ]);
          return performance.now() - started;
        }),
      ),
    );
    const [responses, latencies] = await Promise.all([
      Promise.all(ops),
      Promise.all(inserts),
    ]);
    expect(responses.every((r) => r.status < 500)).toBe(true);
    expect(Math.max(...latencies)).toBeLessThan(INSERT_BUDGET_MS);
    expect(await owners(org.orgId)).toBeGreaterThanOrEqual(1);
    await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query('DELETE FROM fixture_org_items WHERE org_id = $1', [org.orgId]),
      ),
    );
  });
});
