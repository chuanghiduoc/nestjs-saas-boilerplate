import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v4, v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PoliciesGuard } from '../../../src/modules/tenancy/http/policies.guard.js';
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
import { TenancyProbeModule } from './fixtures/probe.module.js';

const NIL = '00000000-0000-0000-0000-000000000000';
/**
 * `etag` là digest yếu của Express trên body, mà body mang `requestId` ngẫu nhiên và `instance`: hai request giống hệt
 * nhau vào cùng một org thiếu cũng khác ETag, nên header này bay theo các trường body đã loại và không phải oracle.
 */
const VOLATILE_HEADERS = new Set(['date', 'x-request-id', 'etag']);
/** Spec SP3 §18.2: mọi header trừ Date/X-Request-Id, body trừ instance/requestId/timestamp. */
const shape = (r: request.Response) => ({
  status: r.status,
  headers: Object.fromEntries(
    Object.entries(r.headers).filter(([k]) => !VOLATILE_HEADERS.has(k)),
  ),
  body: Object.fromEntries(
    Object.entries(r.body as Record<string, unknown>).filter(
      ([k]) => !['instance', 'requestId', 'timestamp'].includes(k),
    ),
  ),
});

describe('tenant pipeline (spec SP3 §7, §18.2)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  let owner: SeededPrincipal;
  let outsider: SeededPrincipal;
  let org: SeededOrg;
  let deletedOrg: SeededOrg;
  const seedP = async (o?: Parameters<typeof seedUserPrincipal>[0]) => {
    const p = await seedUserPrincipal(o);
    principals.push(p);
    return p;
  };
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [TenancyProbeModule] });
    owner = await seedP();
    outsider = await seedP();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    deletedOrg = await seedOrg({ owner: { authUserId: owner.authUserId } });
    orgs.push(org, deletedOrg);
    await withAppClient((c) =>
      inOrgTx(c, deletedOrg.orgId, () =>
        c.query(
          `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`,
          [deletedOrg.orgId],
        ),
      ),
    );
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a member reaches the handler with org + access set from the path', async () => {
    const r = await authed(app, owner).get(`/v1/orgs/${org.orgId}/probe`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      orgId: org.orgId,
      via: 'MEMBERSHIP',
      ref: org.owner.memberPublicId,
    });
    expect(r.body.permissions).toContain('org.delete');
  });
  it('a member without the key gets 403 forbidden; the body names no permission (G-4, U14)', async () => {
    const m = await seedP();
    await seedMember(org, 'MEMBER', { authUserId: m.authUserId });
    const r = await authed(app, m).get(
      `/v1/orgs/${org.orgId}/probe/owner-only`,
    );
    expect([r.status, r.body.code]).toEqual([403, 'forbidden']);
    expect(JSON.stringify(r.body)).not.toMatch(/org\.delete|Cannot execute/);
  });
  it('404 is identical for a missing org, a non-member, a soft-deleted org, nil and v4 ids — and never reaches CASL (G-3, Review Focus 5)', async () => {
    const guard = vi.spyOn(PoliciesGuard.prototype, 'canActivate');
    const responses = await Promise.all([
      authed(app, owner).get(`/v1/orgs/${v7()}/probe`),
      authed(app, outsider).get(`/v1/orgs/${org.orgId}/probe`),
      authed(app, owner).get(`/v1/orgs/${deletedOrg.orgId}/probe`),
      authed(app, owner).get(`/v1/orgs/${NIL}/probe`),
      authed(app, owner).get(`/v1/orgs/${v4()}/probe`),
    ]);
    const shapes = responses.map(shape);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]?.status).toBe(404);
    for (const r of responses)
      expect(
        Object.keys(r.headers).some((h) => h.startsWith('x-ratelimit')),
      ).toBe(false);
    expect(guard).not.toHaveBeenCalled();
  });
  it('a principal that never touched tenancy gets the uniform 404 and no tenancy_users row (Review Focus 2)', async () => {
    const fresh = await seedP();
    const r = await authed(app, fresh).get(`/v1/orgs/${org.orgId}/probe`);
    expect(r.status).toBe(404);
    expect(
      await ownerQuery('SELECT 1 FROM tenancy_users WHERE auth_user_id = $1', [
        fresh.authUserId,
      ]),
    ).toEqual([]);
  });
  it('GET /v1/orgs/<soft-deleted org> without a sub-path is the uniform 404, not a 500 (G-7)', async () => {
    expect(
      (await authed(app, owner).get(`/v1/orgs/${deletedOrg.orgId}`)).status,
    ).toBe(404);
  });
  it('a malformed org id is 400 org_context_invalid; an upper-case path runs the same pipeline and the org is lower-cased', async () => {
    const bad = await authed(app, owner).get('/v1/orgs/not-a-uuid/probe');
    expect([bad.status, bad.body.code]).toEqual([400, 'org_context_invalid']);
    const upper = await authed(app, owner).get(
      `/V1/ORGS/${org.orgId.toUpperCase()}/PROBE`,
    );
    expect([upper.status, upper.body.orgId]).toEqual([200, org.orgId]);
  });
  it('anonymous requests fall through to AuthGuard (401), not to a tenancy 404', async () => {
    const r = await request(app.getHttpServer()).get(
      `/v1/orgs/${org.orgId}/probe`,
    );
    expect([r.status, r.body.code]).toEqual([401, 'unauthenticated']);
  });
  it('a Better Auth user API key on a tenant route is 403 api_key_not_org_scoped', async () => {
    const created = await authed(app, owner)
      .post('/api/auth/api-key/create')
      .send({ name: 'tenancy-e2e' });
    expect(created.status).toBe(200);
    const key: unknown = created.body.key;
    if (typeof key !== 'string')
      throw new Error('api-key/create returned no key');
    const r = await request(app.getHttpServer())
      .get(`/v1/orgs/${org.orgId}/probe`)
      .set('x-api-key', key);
    expect([r.status, r.body.code]).toEqual([403, 'api_key_not_org_scoped']);
  });
});
