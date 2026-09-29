import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const ROUNDS = 10;

describe('TENANCY_MEMBERSHIP_MODE=single + TENANCY_ORG_CREATION=platform_admin (spec SP3 §13, T-7)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const created: string[] = [];
  const create = (p: SeededPrincipal) =>
    authed(app, p)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'Solo' });
  beforeAll(async () => {
    app = await startTenancyApp({
      env: {
        TENANCY_MEMBERSHIP_MODE: 'single',
        TENANCY_ORG_CREATION: 'platform_admin',
      },
    });
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('a non-admin cannot create organizations → 403 org_creation_disabled', async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    const r = await create(p);
    expect([r.status, r.body.code]).toEqual([403, 'org_creation_disabled']);
  });
  it(`T-7: ${ROUNDS} rounds of two parallel creates by one admin → one 201, one 409 already_in_an_org`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const admin = await seedUserPrincipal({ role: 'admin' });
      principals.push(admin);
      const [a, b] = await Promise.all([create(admin), create(admin)]);
      for (const r of [a, b]) if (r.status === 201) created.push(r.body.id);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)?.body.code).toBe(
        'already_in_an_org',
      );
    }
  });
});
