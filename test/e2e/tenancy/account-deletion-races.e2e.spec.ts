import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const ROUNDS = 10;

describe('T-24 / T-18 (creation path): account deletion racing organization creation by the same user', () => {
  let app: INestApplication;
  let admin: SeededPrincipal;
  const principals: SeededPrincipal[] = [];
  const created: string[] = [];
  beforeAll(async () => {
    app = await startTenancyApp();
    admin = await seedUserPrincipal({ role: 'admin' });
    principals.push(admin);
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf(principals.map((p) => p.authUserId));
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it(`${ROUNDS} rounds: never a 5xx, never a deleted account that still owns an active organization`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const u = await seedUserPrincipal();
      principals.push(u);
      const [create, del] = await Promise.all([
        authed(app, u)
          .post('/v1/orgs')
          .set('idempotency-key', `k-${v7()}`)
          .send({ name: `Race ${i}` }),
        authed(app, admin)
          .post('/api/auth/admin/remove-user')
          .set('origin', 'http://localhost:3000')
          .send({ userId: u.authUserId }),
      ]);
      if (create.status === 201) created.push(create.body.id);
      expect(create.status).toBeLessThan(500);
      expect(del.status).toBeLessThan(500);
      expect(create.status === 201 && del.status === 200).toBe(false);
      if (del.status === 200)
        expect(
          await ownerQuery(
            'SELECT 1 FROM tenancy_users WHERE auth_user_id = $1',
            [u.authUserId],
          ),
        ).toEqual([]);
    }
  });
});
