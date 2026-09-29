import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { TenancyProbeModule } from './fixtures/probe.module.js';

const THROTTLE = 3;

describe('throttle and idempotency see the real org (spec SP3 §7.1 bước 3, §18.2)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  let a: SeededOrg;
  let b: SeededOrg;
  let c: SeededOrg;
  beforeAll(async () => {
    app = await startTenancyApp({
      extraImports: [TenancyProbeModule],
      env: {
        THROTTLE_DEFAULT_LIMIT: String(THROTTLE),
        THROTTLE_PRE_AUTH_LIMIT: '1000',
      },
    });
    p = await seedUserPrincipal();
    a = await seedOrg({ owner: { authUserId: p.authUserId } });
    b = await seedOrg({ owner: { authUserId: p.authUserId } });
    c = await seedOrg({ owner: { authUserId: p.authUserId } });
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await c?.dispose();
    await app?.close();
    if (p) await deleteSeededPrincipals([p]);
    vi.unstubAllEnvs();
  });

  it('exhausting the throttle on org A leaves org B untouched (tracker principal:<type>:<id>:<orgId>)', async () => {
    for (let i = 0; i < THROTTLE; i++)
      expect(
        (await authed(app, p).get(`/v1/orgs/${a.orgId}/probe`)).status,
      ).toBe(200);
    expect((await authed(app, p).get(`/v1/orgs/${a.orgId}/probe`)).status).toBe(
      429,
    );
    expect((await authed(app, p).get(`/v1/orgs/${b.orgId}/probe`)).status).toBe(
      200,
    );
  });
  it('the same Idempotency-Key replays on the same org and runs again on another org', async () => {
    const key = `idem-${Date.now()}`;
    const onB = await authed(app, p)
      .post(`/v1/orgs/${b.orgId}/probe/idem`)
      .set('idempotency-key', key)
      .send({});
    const replay = await authed(app, p)
      .post(`/v1/orgs/${b.orgId}/probe/idem`)
      .set('idempotency-key', key)
      .send({});
    const onC = await authed(app, p)
      .post(`/v1/orgs/${c.orgId}/probe/idem`)
      .set('idempotency-key', key)
      .send({});
    expect([onB.status, replay.status, onC.status]).toEqual([201, 201, 201]);
    expect(replay.body).toEqual(onB.body);
    expect(onC.body).toEqual({ n: onB.body.n + 1, orgId: c.orgId });
  });
});
