import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  endpointsUrl,
  startIntegrationsApp,
} from '../../support/integrations-app.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedMember,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

type Row = {
  url: string;
  description: string | null;
  status: string;
  version: number;
  deleted: boolean;
  secrets: number;
  types: string[];
};

/**
 * M6 (review bảo mật 6C): admin của org B dùng id endpoint của org A — qua org B trong path (RLS, 404) và qua org A trong path
 * (không là thành viên). Không thao tác nào chạm dòng của org A.
 */
describe('an admin of another org cannot read or change an endpoint by its id (M6)', () => {
  let app: INestApplication;
  let ownerA: SeededPrincipal;
  let adminB: SeededPrincipal;
  let a: SeededOrg;
  let b: SeededOrg;
  let id = '';
  const rowOfA = async (): Promise<Row | undefined> =>
    (
      await orgQuery<Row>(
        a.orgId,
        `SELECT e.url, e.description, e.status, e.version, e.deleted_at IS NOT NULL AS deleted,
           (SELECT count(*)::int FROM webhook_endpoint_secrets s WHERE s.endpoint_id = e.id) AS secrets,
           (SELECT array_agg(t.event_type ORDER BY t.event_type) FROM webhook_endpoint_event_types t WHERE t.endpoint_id = e.id) AS types
         FROM webhook_endpoints e WHERE e.public_id = $1`,
        [id],
      )
    )[0];
  beforeAll(async () => {
    app = await startIntegrationsApp();
    ownerA = await seedUserPrincipal();
    adminB = await seedUserPrincipal();
    a = await seedOrg({ owner: { authUserId: ownerA.authUserId } });
    b = await seedOrg();
    await seedMember(b, 'ADMIN', { authUserId: adminB.authUserId });
    const res = await authed(app, ownerA)
      .post(endpointsUrl(a.orgId))
      .send({
        url: 'https://hooks.example.test/a',
        eventTypes: ['tenancy.org.updated'],
      });
    expect(res.status).toBe(201);
    id = String(res.body.id);
  });
  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await app?.close();
    await deleteSeededPrincipals([ownerA, adminB]);
  });

  it('through org B in the path every route is 404 and the row of org A is unchanged', async () => {
    const before = await rowOfA();
    expect(before).toMatchObject({ version: 1, deleted: false, secrets: 1 });
    const one = `${endpointsUrl(b.orgId)}/${id}`;
    const as = authed(app, adminB);
    const calls = [
      as.get(one),
      as.patch(one).set('if-match', 'W/"1"').send({ description: 'pwned' }),
      as
        .patch(`${one}/destination`)
        .set('if-match', 'W/"1"')
        .send({ url: 'https://evil.example.test/x' }),
      as.post(`${one}/rotate-secret`).send(),
      as.delete(one),
    ];
    for (const r of await Promise.all(calls))
      expect([r.status, r.body.code]).toEqual([404, 'not_found']);
    expect(await rowOfA()).toEqual(before);
    // Kiểm chứng ngược: cùng id qua org A với owner của A thì thấy được — 404 ở trên không phải vì id sai.
    expect(
      (await authed(app, ownerA).get(`${endpointsUrl(a.orgId)}/${id}`)).status,
    ).toBe(200);
  });
  it('through org A in the path the admin of org B is refused before any handler runs, and the row is unchanged', async () => {
    const before = await rowOfA();
    const one = `${endpointsUrl(a.orgId)}/${id}`;
    const as = authed(app, adminB);
    const calls = [
      as.get(one),
      as.patch(one).set('if-match', 'W/"1"').send({ description: 'pwned' }),
      as
        .patch(`${one}/destination`)
        .set('if-match', 'W/"1"')
        .send({ url: 'https://evil.example.test/x' }),
      as.post(`${one}/rotate-secret`).send(),
      as.delete(one),
    ];
    for (const r of await Promise.all(calls)) {
      expect([403, 404]).toContain(r.status);
      expect(r.body).not.toHaveProperty('secret');
    }
    expect(await rowOfA()).toEqual(before);
  });
});
