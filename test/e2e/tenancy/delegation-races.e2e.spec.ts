import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { raceOnOrgLock } from '../../support/org-lock-barrier.js';
import { joinInviteLink } from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  inOrgTx,
  seedInviteLink,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ROUNDS = 10;

describe('delegation races through the app (spec SP3 §17; T-19 app path, member removal ∥ key creation)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  /** FORCE RLS: đọc bảng tenant bằng app_user trong OrgScope. */
  const inOrgRows = (org: SeededOrg, sql: string, params: unknown[]) =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, async () => (await c.query(sql, params)).rows),
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

  it(`T-19 (app): granting ∥ the staff joining through a link ×${ROUNDS} → never both a membership and an open grant`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const O = await seedUserPrincipal();
      const staff = await seedStaffPrincipal();
      principals.push(O, staff);
      const org = await seedOrg({ owner: { authUserId: O.authUserId } });
      orgs.push(org);
      const link = await seedInviteLink(org, {
        roleId: org.roles.MEMBER.id,
        createdByMemberId: org.owner.memberId,
      });
      const [grant, join] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          authed(app, O)
            .post(`/v1/orgs/${org.orgId}/support-grants`)
            .set('idempotency-key', `k-${v7()}`)
            .send({
              staffUserId: staff.authUserId,
              expiresInSec: 900,
              reason: 'T-19',
            }),
          joinInviteLink(app, staff, { token: link.token }),
        ]),
      );
      expect(join.status, `round ${i}`).toBe(201);
      expect([201, 422], `round ${i}`).toContain(grant.status);
      expect(
        await inOrgRows(
          org,
          `SELECT 1 FROM org_support_grants g JOIN tenancy_users u ON u.id = g.grantee_user_id WHERE u.auth_user_id = $1 AND g.revoked_at IS NULL`,
          [staff.authUserId],
        ),
        `round ${i}`,
      ).toEqual([]);
    }
  });
  it(`removing a member ∥ that member creating a key ×${ROUNDS} → either the key never exists or it was announced CREATOR_REMOVED; no 500`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const O = await seedUserPrincipal();
      const A = await seedUserPrincipal();
      principals.push(O, A);
      const org = await seedOrg({ owner: { authUserId: O.authUserId } });
      orgs.push(org);
      const a = await seedMember(org, 'ADMIN', { authUserId: A.authUserId });
      const [created, removed] = await raceOnOrgLock(org.orgId, 2, () =>
        Promise.all([
          authed(app, A)
            .post(`/v1/orgs/${org.orgId}/api-keys`)
            .send({
              name: 'race',
              permissions: ['org.read'],
              expiresInSec: 60,
            }),
          authed(app, O).delete(
            `/v1/orgs/${org.orgId}/members/${a.memberPublicId}`,
          ),
        ]),
      );
      expect(removed.status, `round ${i}`).toBe(204);
      expect([201, 404], `round ${i}`).toContain(created.status);
      if (created.status === 201) {
        const ev = await ownerQuery<{ payload: { reason: string } }>(
          `SELECT payload FROM outbox_events WHERE type = 'tenancy.api_key.revoked' AND aggregate_id = $1`,
          [created.body.id],
        );
        expect(
          ev.map((e) => e.payload.reason),
          `round ${i}`,
        ).toEqual(['CREATOR_REMOVED']);
      }
      expect(
        await inOrgRows(org, `SELECT 1 FROM org_api_keys`, []),
        `round ${i}`,
      ).toEqual([]);
    }
  });
});
