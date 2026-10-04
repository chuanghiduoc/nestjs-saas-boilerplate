import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { DelegatedPermissions } from '../../../src/modules/tenancy/application/authz/delegated-permissions.js';
import { OrgApiKeyRepository } from '../../../src/modules/tenancy/ports/org-api-key-repository.js';
import { SupportGrantRepository } from '../../../src/modules/tenancy/ports/support-grant-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  TENANCY_ONLY_CATALOGUE,
  apiKeyEligibleKeys,
  hashToken,
  inOrgTx,
  newOrgApiKeyToken,
  orgApiKeyHint,
  seedMember,
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  supportPresetKeys,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

describe('delegation SQL repositories and effective permissions (spec SP3 §6.10–6.11, §7.1 bước 3.7, §8.5)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  const inOrg = <T>(fn: () => Promise<T>) =>
    app.get(OrgScope).run(org.orgId, () => app.get(UnitOfWork).run(fn));
  const keys = () => app.get(OrgApiKeyRepository);
  const grants = () => app.get(SupportGrantRepository);
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it('key: insert (deduplicated scope) → token lookup without an org context → access row → revoke once; listing per member', async () => {
    const admin = await seedMember(org, 'ADMIN');
    const token = newOrgApiKeyToken();
    const k = await inOrg(() =>
      keys().insert({
        createdByMemberId: admin.memberId,
        name: 'ci',
        tokenHashHex: hashToken(token),
        keyHint: orgApiKeyHint(token),
        expiresInSec: 3600,
        permissions: ['roles.read', 'org.read', 'roles.read'],
      }),
    );
    expect(k).toMatchObject({
      name: 'ci',
      keyHint: orgApiKeyHint(token),
      createdByMemberPublicId: admin.memberPublicId,
      permissions: ['org.read', 'roles.read'],
      revokedAt: null,
      version: 1,
    });
    expect(await keys().findByTokenHash(hashToken(token))).toEqual({
      orgId: org.orgId,
      id: k.id,
      publicId: k.publicId,
    });
    expect(
      await inOrg(() => keys().findActiveForAccess(k.publicId)),
    ).toMatchObject({
      keyPublicId: k.publicId,
      creatorMemberId: admin.memberId,
      creatorSystemKey: 'ADMIN',
      scope: ['org.read', 'roles.read'],
    });
    expect(await inOrg(() => keys().countActiveForMember(admin.memberId))).toBe(
      1,
    );
    expect(
      (
        await inOrg(() =>
          keys().list({ memberId: admin.memberId, limit: 10, offset: 0 }),
        )
      ).map((r) => r.publicId),
    ).toEqual([k.publicId]);
    const revoked = await inOrg(async () => {
      const locked = await keys().lockByPublicId(k.publicId);
      return locked ? keys().revoke(locked.id) : undefined;
    });
    expect(revoked).toMatchObject({ version: 2, revokedAt: expect.any(Date) });
    expect(await inOrg(() => keys().revoke(k.id))).toBeUndefined();
    expect(await keys().findByTokenHash(hashToken(token))).toBeUndefined();
    expect(
      await inOrg(() => keys().findActiveForAccess(k.publicId)),
    ).toBeUndefined();
  });
  it('key: unrevokedOfMember lists what the member removal must announce; revokeAll revokes the rest of the org', async () => {
    const m = await seedMember(org, 'ADMIN');
    const a = await seedOrgApiKey(org, {
      createdByMemberId: m.memberId,
      permissions: ['org.read'],
    });
    await seedOrgApiKey(org, {
      createdByMemberId: m.memberId,
      permissions: ['org.read'],
      revoked: true,
    });
    expect(await inOrg(() => keys().unrevokedOfMember(m.memberId))).toEqual([
      { publicId: a.publicId, version: 1 },
    ]);
    await inOrg(() => keys().revokeAll());
    expect(await inOrg(() => keys().unrevokedOfMember(m.memberId))).toEqual([]);
  });
  it('grant: insert → open access for the grantee auth user → first use once (T-15) → revokeOpenForGrantee', async () => {
    const authUserId = (
      await ownerQuery<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at) VALUES ('S', $1, true, 'admin', now(), now(), now()) RETURNING id`,
        [`staff-${v7()}@example.test`],
      )
    )[0]!.id;
    const user = (
      await ownerQuery<{ id: string }>(
        `INSERT INTO tenancy_users (auth_user_id) VALUES ($1) RETURNING id::text`,
        [authUserId],
      )
    )[0]!.id;
    try {
      const preset = supportPresetKeys(TENANCY_ONLY_CATALOGUE);
      const g = await inOrg(() =>
        grants().insert({
          granteeUserId: user,
          grantedByMemberId: org.owner.memberId,
          reason: 'SUP-1',
          expiresInSec: 3600,
          permissions: preset,
        }),
      );
      expect(g).toMatchObject({
        granteeUserId: user,
        grantedByMemberPublicId: org.owner.memberPublicId,
        reason: 'SUP-1',
        permissions: preset,
        firstUsedAt: null,
      });
      expect(
        await inOrg(() => grants().findOpenForAccess(authUserId)),
      ).toMatchObject({
        grantPublicId: g.publicId,
        granterSystemKey: 'OWNER',
        scope: preset,
        firstUsedAt: null,
      });
      expect(await inOrg(() => grants().markFirstUse(g.id))).toMatchObject({
        firstUsedAt: expect.any(Date),
        version: 2,
      });
      expect(await inOrg(() => grants().markFirstUse(g.id))).toBeUndefined();
      expect(await grants().granteeOpenGrantOrgs(user)).toEqual([org.orgId]);
      const revoked = await inOrg(() => grants().revokeOpenForGrantee(user));
      expect(revoked.map((r) => r.publicId)).toEqual([g.publicId]);
      expect(
        await inOrg(() => grants().findOpenForAccess(authUserId)),
      ).toBeUndefined();
    } finally {
      await ownerQuery(`DELETE FROM tenancy_users WHERE id = $1`, [user]);
      await ownerQuery(`DELETE FROM auth."user" WHERE id = $1`, [authUserId]);
    }
  });
  it('DelegatedPermissions: a key follows the CURRENT role of its creator (K-4/K-5); a grant is its eligible scope', async () => {
    const m = await seedMember(org, 'ADMIN');
    const full = apiKeyEligibleKeys(TENANCY_ONLY_CATALOGUE);
    const k = await seedOrgApiKey(org, {
      createdByMemberId: m.memberId,
      permissions: full,
    });
    const effective = () =>
      inOrg(async () => {
        const access = await keys().findActiveForAccess(k.publicId);
        if (!access) throw new Error('seeded key is not active');
        return app.get(DelegatedPermissions).forApiKey(access);
      });
    expect(await effective()).toEqual(full);
    // org_members là FORCE RLS: app_owner không có org context không thấy dòng nào, nên đổi role bằng app_user trong OrgScope.
    const demoted = await withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(`UPDATE org_members SET role_id = $1 WHERE id = $2`, [
          org.roles.MEMBER.id,
          m.memberId,
        ]),
      ),
    );
    expect(demoted.rowCount).toBe(1);
    const asMember = await effective();
    expect(asMember).not.toContain('billing.read');
    expect(asMember).toContain('org.read');
    const preset = supportPresetKeys(TENANCY_ONLY_CATALOGUE);
    await seedSupportGrant(org, {
      grantee: { externalSubject: `test:${v7()}` },
      grantedByMemberId: org.owner.memberId,
      permissions: preset,
    });
    expect(app.get(DelegatedPermissions).forSupportGrant(preset)).toEqual(
      preset,
    );
    expect(
      app
        .get(DelegatedPermissions)
        .forSupportGrant([...preset, 'billing.read', 'gone.read']),
    ).toEqual(preset);
  });
});
