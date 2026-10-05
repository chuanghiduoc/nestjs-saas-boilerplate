import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { withAppClient } from '../../support/tenancy-seed.js';

describe('O-19 / T8: identity without tenancy — the RESTRICT FK is the last line (spec SP3 §9.6 bước 4)', () => {
  const otel = installOtelCapture();
  let app: INestApplication;
  let admin: SeededPrincipal;
  let u: SeededPrincipal;
  beforeAll(async () => {
    app = await startIdentityApp();
    // Spec SP3 §5.3 (3D, N5-1): admin gọi `/admin/*` là nhân viên có factor và dấu TOTP tươi.
    admin = await seedStaffPrincipal();
    u = await seedUserPrincipal();
    await withAppClient((c) =>
      c.query('INSERT INTO tenancy_users (auth_user_id) VALUES ($1)', [
        u.authUserId,
      ]),
    );
  });
  afterAll(async () => {
    await withAppClient((c) =>
      c.query('DELETE FROM tenancy_users WHERE auth_user_id = $1', [
        u.authUserId,
      ]),
    );
    await app?.close();
    await deleteSeededPrincipals([admin, u]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('/admin/remove-user → 409 user_deletion_blocked, no ERROR better_auth_unhandled_error, no 5xx counted', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const r = await request(app.getHttpServer())
      .post('/api/auth/admin/remove-user')
      .set('authorization', `Bearer ${admin.bearer}`)
      .set('origin', 'http://localhost:3000')
      .send({ userId: u.authUserId });
    expect([r.status, r.body.code]).toEqual([409, 'user_deletion_blocked']);
    const events = error.mock.calls.flatMap(([o]) =>
      typeof o === 'object' && o !== null && 'event' in o ? [o.event] : [],
    );
    expect(events).not.toContain('better_auth_unhandled_error');
    expect((await otel.metric('identity_auth_endpoint_error_total')) ?? 0).toBe(
      0,
    );
    expect(
      await ownerQuery('SELECT 1 FROM auth."user" WHERE id = $1', [
        u.authUserId,
      ]),
    ).toHaveLength(1);
  });
});
