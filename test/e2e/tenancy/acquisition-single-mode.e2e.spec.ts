import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installOtelCapture } from '../../support/otel-capture.js';
import {
  acceptInvitation,
  joinInviteLink,
} from '../../support/tenancy-acquisition.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Một lần mỗi file, trước khi app tạo meter (TenancyMetrics lấy meter từ provider toàn cục lúc khởi tạo). */
const otel = installOtelCapture();
const ALREADY_IN_ORG = { result: 'already_in_org' };

/**
 * TENANCY_MEMBERSHIP_MODE=single: chấp nhận/join của user đã ở org khác → `409 already_in_an_org`, và lần từ chối đó được
 * đếm ở `tenancy_invitations_total` / `tenancy_invite_link_joins_total` (spec §16; final review 3C M-5).
 */
describe('acquisition in single-membership mode counts already_in_org (spec SP3 §13, §16)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  /** u đã là member của org A; org B mời/có link cho u. */
  const cast = async () => {
    const owners = [await seedUserPrincipal(), await seedUserPrincipal()];
    const u = await seedUserPrincipal();
    principals.push(...owners, u);
    const a = await seedOrg({ owner: { authUserId: owners[0]!.authUserId } });
    const b = await seedOrg({ owner: { authUserId: owners[1]!.authUserId } });
    orgs.push(a, b);
    await seedMember(a, 'MEMBER', { authUserId: u.authUserId });
    return { u, b };
  };
  beforeAll(async () => {
    app = await startTenancyApp({
      env: { TENANCY_MEMBERSHIP_MODE: 'single' },
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('accept → 409 already_in_an_org, counted as tenancy_invitations_total{result="already_in_org"}', async () => {
    const { u, b } = await cast();
    const inv = await seedInvitation(b, {
      email: u.email,
      roleId: b.roles.MEMBER.id,
      inviterMemberId: b.owner.memberId,
    });
    const before =
      (await otel.metric('tenancy_invitations_total', ALREADY_IN_ORG)) ?? 0;
    const r = await acceptInvitation(app, u, { token: inv.token });
    expect([r.status, r.body.code]).toEqual([409, 'already_in_an_org']);
    expect(await otel.metric('tenancy_invitations_total', ALREADY_IN_ORG)).toBe(
      before + 1,
    );
  });
  it('join → 409 already_in_an_org, counted as tenancy_invite_link_joins_total{result="already_in_org"}', async () => {
    const { u, b } = await cast();
    const link = await seedInviteLink(b, {
      roleId: b.roles.MEMBER.id,
      createdByMemberId: b.owner.memberId,
    });
    const before =
      (await otel.metric('tenancy_invite_link_joins_total', ALREADY_IN_ORG)) ??
      0;
    const r = await joinInviteLink(app, u, { token: link.token });
    expect([r.status, r.body.code]).toEqual([409, 'already_in_an_org']);
    expect(
      await otel.metric('tenancy_invite_link_joins_total', ALREADY_IN_ORG),
    ).toBe(before + 1);
  });
});
