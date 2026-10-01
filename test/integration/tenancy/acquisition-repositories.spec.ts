import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { InvitationRepository } from '../../../src/modules/tenancy/ports/invitation-repository.js';
import { InviteLinkRepository } from '../../../src/modules/tenancy/ports/invite-link-repository.js';
import { OrgRepository } from '../../../src/modules/tenancy/ports/org-repository.js';
import { OwnershipTransferRepository } from '../../../src/modules/tenancy/ports/ownership-transfer-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  ROLE_SET_C0,
  hashToken,
  seedCustomRole,
  seedInvitation,
  seedInviteLink,
  seedMember,
  seedOrg,
  seedTransfer,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const TOKEN_HEX = 'a1'.repeat(32);

describe('acquisition SQL repositories (spec SP3 §6.7–6.9, §9)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  const inOrg = <T>(fn: () => Promise<T>) =>
    app.get(OrgScope).run(org.orgId, () => app.get(UnitOfWork).run(fn));
  const invitations = () => app.get(InvitationRepository);
  const links = () => app.get(InviteLinkRepository);
  const transfers = () => app.get(OwnershipTransferRepository);
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it('invitation: insert → token lookup without an org context → lock → CAS accept once (T-2)', async () => {
    const m = await seedMember(org, 'MEMBER');
    const inv = await inOrg(() =>
      invitations().insert({
        email: 'repo@example.test',
        roleId: org.roles.MEMBER.id,
        inviterMemberId: org.owner.memberId,
        tokenHashHex: TOKEN_HEX,
        ttlSec: 3600,
      }),
    );
    expect(inv).toMatchObject({
      email: 'repo@example.test',
      status: 'PENDING',
      rolePublicId: org.roles.MEMBER.publicId,
      roleSystemKey: 'MEMBER',
      version: 1,
    });
    expect(await invitations().findByTokenHash(TOKEN_HEX)).toEqual({
      orgId: org.orgId,
      id: inv.id,
    });
    const first = await inOrg(async () => {
      await invitations().lockById(inv.id);
      return invitations().accept(inv.id, m.memberId);
    });
    expect(first).toMatchObject({
      status: 'ACCEPTED',
      acceptedMemberId: m.memberId,
      version: 2,
    });
    expect(
      await inOrg(() => invitations().accept(inv.id, m.memberId)),
    ).toBeUndefined();
    expect(await invitations().findByTokenHash(TOKEN_HEX)).toBeUndefined();
  });
  it('invitation: countOpen ignores lapsed and finished rows; expireLapsedForEmail frees the pending slot', async () => {
    const before = await inOrg(() => invitations().countOpen());
    await seedInvitation(org, {
      email: 'lapsed@example.test',
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
      expiresInSec: -60,
    });
    await seedInvitation(org, {
      email: 'done@example.test',
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
      status: 'REVOKED',
    });
    await seedInvitation(org, {
      email: 'open@example.test',
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    expect(await inOrg(() => invitations().countOpen())).toBe(before + 1);
    await inOrg(() =>
      invitations().expireLapsedForEmail('lapsed@example.test'),
    );
    const again = await inOrg(() =>
      invitations().insert({
        email: 'lapsed@example.test',
        roleId: org.roles.MEMBER.id,
        inviterMemberId: org.owner.memberId,
        tokenHashHex: 'b2'.repeat(32),
        ttlSec: 3600,
      }),
    );
    expect(again.status).toBe('PENDING');
  });
  it('invitation: expireLapsedForRole touches only lapsed PENDING rows of that role; revokeAllPending revokes every PENDING row', async () => {
    const role = await seedCustomRole(org, {
      permissions: ROLE_SET_C0,
      name: 'Repo role',
    });
    const lapsed = await seedInvitation(org, {
      email: 'r1@example.test',
      roleId: role.id,
      inviterMemberId: org.owner.memberId,
      expiresInSec: -60,
    });
    const live = await seedInvitation(org, {
      email: 'r2@example.test',
      roleId: role.id,
      inviterMemberId: org.owner.memberId,
    });
    await inOrg(() => invitations().expireLapsedForRole(role.id));
    expect((await inOrg(() => invitations().findById(lapsed.id)))?.status).toBe(
      'EXPIRED',
    );
    expect((await inOrg(() => invitations().findById(live.id)))?.status).toBe(
      'PENDING',
    );
    await inOrg(() => invitations().revokeAllPending());
    expect((await inOrg(() => invitations().findById(live.id)))?.status).toBe(
      'REVOKED',
    );
    expect(
      await invitations().findByTokenHash(hashToken(live.token)),
    ).toBeUndefined();
  });
  it('link: consumeUse stops at max_uses (T-5); revoke is once; revokeClosedForRole spares open links', async () => {
    const link = await inOrg(() =>
      links().insert({
        roleId: org.roles.MEMBER.id,
        createdByMemberId: org.owner.memberId,
        tokenHashHex: 'c3'.repeat(32),
        maxUses: 2,
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    expect(await links().findByTokenHash('c3'.repeat(32))).toEqual({
      orgId: org.orgId,
      id: link.id,
    });
    expect((await inOrg(() => links().consumeUse(link.id)))?.useCount).toBe(1);
    expect((await inOrg(() => links().consumeUse(link.id)))?.useCount).toBe(2);
    expect(await inOrg(() => links().consumeUse(link.id))).toBeUndefined();
    const role = await seedCustomRole(org, {
      permissions: ROLE_SET_C0,
      name: 'Link role',
    });
    const expired = await seedInviteLink(org, {
      roleId: role.id,
      createdByMemberId: org.owner.memberId,
      expiresInSec: -60,
    });
    const open = await seedInviteLink(org, {
      roleId: role.id,
      createdByMemberId: org.owner.memberId,
    });
    expect(await inOrg(() => links().revokeClosedForRole(role.id))).toEqual([
      { publicId: expired.publicId, version: 2 },
    ]);
    expect(
      (await inOrg(() => links().findByPublicId(open.publicId)))?.revokedAt,
    ).toBeNull();
    expect(
      (await inOrg(() => links().revoke(open.id)))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(await inOrg(() => links().revoke(open.id))).toBeUndefined();
  });
  it('transfer: one PENDING per org; lockPendingForMember sees both sides; effective status filter treats lapsed PENDING as EXPIRED', async () => {
    const a = await seedMember(org, 'ADMIN');
    const t = await inOrg(() =>
      transfers().insert({
        fromMemberId: org.owner.memberId,
        toMemberId: a.memberId,
        stepDownTo: 'ADMIN',
        ttlSec: 3600,
      }),
    );
    expect(t).toMatchObject({
      status: 'PENDING',
      fromMemberPublicId: org.owner.memberPublicId,
      toMemberPublicId: a.memberPublicId,
      stepDownTo: 'ADMIN',
    });
    expect(
      (await inOrg(() => transfers().lockPendingForMember(a.memberId))).map(
        (x) => x.id,
      ),
    ).toEqual([t.id]);
    expect(
      (
        await inOrg(() => transfers().lockPendingForMember(org.owner.memberId))
      ).map((x) => x.id),
    ).toEqual([t.id]);
    expect(
      (await inOrg(() => transfers().resolve(t.id, 'DECLINED')))?.status,
    ).toBe('DECLINED');
    expect(
      await inOrg(() => transfers().resolve(t.id, 'CANCELLED')),
    ).toBeUndefined();
    const lapsed = await seedTransfer(org, {
      fromMemberId: org.owner.memberId,
      toMemberId: a.memberId,
      expiresInSec: -60,
    });
    const expiredList = await inOrg(() =>
      transfers().list({ status: 'EXPIRED', limit: 50, offset: 0 }),
    );
    expect(expiredList.map((x) => x.publicId)).toContain(lapsed.publicId);
    expect(
      await inOrg(() => transfers().countUpTo({ status: 'PENDING' }, 100)),
    ).toBe(0);
    await inOrg(() => transfers().expireLapsed());
    expect(
      (await inOrg(() => transfers().findByPublicId(lapsed.publicId)))?.status,
    ).toBe('EXPIRED');
  });
  it('countMembershipsForUser counts memberships of soft-deleted orgs too (M7)', async () => {
    const other = await seedOrg();
    const u = await seedMember(other, 'MEMBER');
    expect(await app.get(OrgRepository).countMembershipsForUser(u.userId)).toBe(
      1,
    );
    await app
      .get(OrgScope)
      .run(other.orgId, () =>
        app
          .get(UnitOfWork)
          .run(() => app.get(OrgRepository).softDelete(86_400)),
      );
    expect(await app.get(OrgRepository).countMembershipsForUser(u.userId)).toBe(
      1,
    );
    await other.dispose();
  });
});
