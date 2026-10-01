import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import {
  acceptInvitation,
  joinInviteLink,
} from '../../support/tenancy-acquisition.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  hashToken,
  purgeOrgs,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Label/attribute của tenancy chỉ là enum hữu hạn (spec SP3 §16): không org, user, email, token. */
describe('tenancy spans and metrics carry no identifiers', () => {
  const otel = installOtelCapture();
  let app: INestApplication;
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  let org: SeededOrg;
  let invitee: SeededPrincipal | undefined;
  let joiner: SeededPrincipal | undefined;
  const created: string[] = [];
  beforeAll(async () => {
    app = await startTenancyApp();
    owner = await seedUserPrincipal();
    member = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMember(org, 'MEMBER', { authUserId: member.authUserId });
  });
  afterAll(async () => {
    // Org do API tạo tham chiếu `tenancy_users` của owner: purge trước, để `org.dispose()` xoá được dòng user.
    await purgeOrgs(created);
    await org?.dispose();
    await app?.close();
    await deleteSeededPrincipals(
      [owner, member, invitee, joiner].filter(
        (p): p is SeededPrincipal => p !== undefined,
      ),
    );
    vi.unstubAllEnvs();
  });

  it('after a create, grants, misses, denials and a last-owner refusal, no attribute value contains an id, email or token', async () => {
    otel.reset();
    const made = await authed(app, owner)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${v7()}`)
      .send({ name: 'Telemetry Org' });
    expect(made.status).toBe(201);
    created.push(made.body.id);
    await authed(app, owner).get(`/v1/orgs/${org.orgId}`);
    await authed(app, member).get(`/v1/orgs/${v7()}`);
    await authed(app, member)
      .patch(`/v1/orgs/${org.orgId}`)
      .set('if-match', '*')
      .send({ name: 'x' });
    await authed(app, owner).delete(`/v1/orgs/${org.orgId}/members/me`);
    // 3C: chấp nhận (thành công + email sai), join; span §16 của 3C có mặt, attribute chỉ là enum.
    invitee = await seedUserPrincipal();
    const inv = await seedInvitation(org, {
      email: invitee.email,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    expect(
      (await acceptInvitation(app, invitee, { token: inv.token })).status,
    ).toBe(201);
    const wrong = await seedInvitation(org, {
      email: `nobody-${v7()}@example.test`,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    expect(
      (await acceptInvitation(app, member, { token: wrong.token })).status,
    ).toBe(403);
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
    });
    joiner = await seedUserPrincipal();
    expect(
      (await joinInviteLink(app, joiner, { token: link.token })).status,
    ).toBe(201);
    expect(otel.spanNames()).toEqual(
      expect.arrayContaining([
        'tenancy.invitation.accept',
        'tenancy.invite_link.join',
      ]),
    );
    expect(
      await otel.metric('tenancy_invitations_total', {
        result: 'email_mismatch',
      }),
    ).toBe(1);
    // Review M4: hai span của spec §16 mà 3A sở hữu có mặt, với attribute là enum.
    const policyResults = otel
      .spans('tenancy.policy.check')
      .map((s) => s.attributes['tenancy.policy.result']);
    expect(policyResults).toEqual(
      expect.arrayContaining(['allowed', 'denied']),
    );
    for (const r of policyResults)
      expect(['allowed', 'denied', 'error']).toContain(r);
    const admits = otel.spans('tenancy.member.admit');
    expect(admits).toHaveLength(3);
    expect(
      admits.map((a) => a.attributes['tenancy.member.source']).sort(),
    ).toEqual(['CREATOR', 'INVITATION', 'INVITE_LINK']);
    const forbidden = [
      org.orgId,
      made.body.id,
      owner.authUserId,
      member.authUserId,
      owner.email,
      member.email,
      owner.bearer,
      member.bearer,
      invitee.email,
      invitee.bearer,
      joiner.bearer,
      inv.token,
      wrong.token,
      link.token,
      hashToken(inv.token),
    ];
    const values = [
      ...otel
        .spanNames()
        .flatMap((n) =>
          otel.spans(n).flatMap((s) => Object.values(s.attributes).map(String)),
        ),
      ...(await otel.dataPoints('tenancy_')).flatMap((d) =>
        Object.values(d.attributes).map(String),
      ),
    ];
    expect(values.length).toBeGreaterThan(0);
    for (const v of values)
      for (const f of forbidden) expect(v.includes(f)).toBe(false);
  });
});
