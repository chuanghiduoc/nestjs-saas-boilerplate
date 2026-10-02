import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startIdentityApp } from '../../support/identity-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';

/** Spec SP3 §5.2 hàng `identity-directory.ts` (N7-2): `/v1/me` dùng `hasAdminRole` như plugin, không `trim`. */
describe('GET /v1/me role follows the admin plugin predicate', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startIdentityApp();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });
  it.each([
    ['admin', 'ADMIN'],
    ['user,admin', 'ADMIN'],
    ['user, admin', 'USER'],
    [' admin', 'USER'],
    ['Admin', 'USER'],
  ])('role %j → %s', async (role, expected) => {
    const p = await seedUserPrincipal({ role });
    principals.push(p);
    const r = await request(app.getHttpServer())
      .get('/v1/me')
      .set('authorization', `Bearer ${p.bearer}`);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe(expected);
  });
});
