import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { MemberAdmission } from '../../../src/modules/tenancy/application/member-admission.js';
import { OrgRepository } from '../../../src/modules/tenancy/ports/org-repository.js';
import { RoleRepository } from '../../../src/modules/tenancy/ports/role-repository.js';
import { TenancyUserRepository } from '../../../src/modules/tenancy/ports/tenancy-user-repository.js';
import { applyTestEnv, createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const ACTOR = { type: 'system', id: 'test.single-org' } as const;

/**
 * M7 (3A final review, carry sang 3C): chế độ single-org đếm bằng `tenancy_count_user_orgs(user, true)`, hàm chỉ tính org
 * xoá mềm khi user là OWNER. Một MEMBER của org A đã xoá mềm vì vậy vào được org B; khôi phục A để lại user ở HAI org.
 * 3C đếm mọi membership (kể cả org xoá mềm) ở `MemberAdmission`, chỗ duy nhất mọi đường join đi qua.
 */
describe('single-org admission counts memberships of soft-deleted orgs (M7)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const setDeleted = (org: SeededOrg, deleted: boolean) =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          deleted
            ? `UPDATE organizations SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`
            : `UPDATE organizations SET deleted_at = NULL, purge_after = NULL WHERE id = $1`,
          [org.orgId],
        ),
      ),
    );
  const admitInto = (org: SeededOrg, subject: string) =>
    app.get(OrgScope).run(org.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        await app.get(OrgRepository).lockCurrent();
        const user = await app
          .get(TenancyUserRepository)
          .upsertAndLock({ kind: 'EXTERNAL', externalSubject: subject });
        const role = await app
          .get(RoleRepository)
          .findByPublicId(org.roles.MEMBER.publicId);
        if (!role) throw new Error('member role missing');
        return app.get(MemberAdmission).admit({
          user,
          role,
          actor: ACTOR,
          admission: { source: 'INVITATION', invitationId: v7() },
        });
      }),
    );
  beforeAll(async () => {
    applyTestEnv();
    vi.stubEnv('TENANCY_MEMBERSHIP_MODE', 'single');
    app = await createTestApp(tenancyCoreImports());
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('a MEMBER of a soft-deleted org cannot join another org; after the restore they still belong to exactly one', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    orgs.push(a, b);
    const subject = `m7:${v7()}`;
    const m = await seedMember(a, 'MEMBER', { externalSubject: subject });
    await setDeleted(a, true);
    await expect(admitInto(b, subject)).rejects.toMatchObject({
      error: { code: 'already_in_an_org' },
    });
    await setDeleted(a, false);
    expect(await app.get(OrgRepository).countMembershipsForUser(m.userId)).toBe(
      1,
    );
  });
  it('a user with no membership anywhere joins normally in single mode', async () => {
    const c = await seedOrg();
    orgs.push(c);
    const member = await admitInto(c, `m7-free:${v7()}`);
    expect(member.systemKey).toBe('MEMBER');
  });
});
