import { describe, expect, it } from 'vitest';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
} from '../../support/tenancy-seed.js';

const counts = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(c, orgId, async () => {
      const q = async (sql: string) =>
        Number((await c.query<{ n: string }>(sql)).rows[0]?.n);
      return {
        orgs: await q(`SELECT count(*) AS n FROM organizations`),
        roles: await q(`SELECT count(*) AS n FROM org_roles`),
        members: await q(`SELECT count(*) AS n FROM org_members`),
      };
    }),
  );

describe('seedOrg / dispose (spec SP3 §5.3)', () => {
  it('seeds an org that passes the bootstrap trigger and disposes it completely, users included', async () => {
    const org = await seedOrg();
    const admin = await seedMember(org, 'ADMIN');
    expect(await counts(org.orgId)).toEqual({ orgs: 1, roles: 3, members: 2 });
    await org.dispose();
    expect(await counts(org.orgId)).toEqual({ orgs: 0, roles: 0, members: 0 });
    const users = await withAppClient((c) =>
      c.query(`SELECT 1 FROM tenancy_users WHERE id = ANY($1::bigint[])`, [
        [org.owner.userId, admin.userId],
      ]),
    );
    expect(users.rows).toEqual([]);
  });
  it('keeps a user that is still a member of another org (the 23001 branch of dispose)', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const subject = { externalSubject: `test:shared-${a.orgId}` };
    // Review M2: thứ tự có chủ đích. `a` TẠO dòng `tenancy_users` (nên dòng nằm trong danh sách xoá của `a.dispose()`),
    // `b` chỉ dùng lại dòng đó; `a.dispose()` vì vậy thật sự thử xoá và phải đi nhánh bắt `23001` rồi giữ lại.
    const shared = await seedMember(a, 'MEMBER', subject);
    const again = await seedMember(b, 'MEMBER', subject);
    expect(again.userId).toBe(shared.userId);
    await a.dispose();
    const users = await withAppClient((c) =>
      c.query(`SELECT 1 FROM tenancy_users WHERE id = $1`, [shared.userId]),
    );
    expect(users.rows).toHaveLength(1);
    await b.dispose();
    // `b` không tạo dòng này nên không xoá nó: dọn tay khi không còn membership nào.
    const removed = await withAppClient((c) =>
      c.query(`DELETE FROM tenancy_users WHERE id = $1`, [shared.userId]),
    );
    expect(removed.rowCount).toBe(1);
  });
});
