import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  TENANCY_ONLY_CATALOGUE,
  roleSetC1,
  seedCustomRole,
  seedMemberInRole,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const PROCESS_ENV: Record<string, string> = {
  LOG_LEVEL: 'debug',
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
};
/** App chạy ở process con (không có registry trong process này): chỉ cần một tập đóng thiếu `invitations.read`. */
const C1 = roleSetC1(TENANCY_ONLY_CATALOGUE);

/** Spec SP3 §16, tiêu chí 16: log từ chối leo quyền chỉ có `rule`; tên/mô tả role (nội dung của org) và credential không vào log. */
describe('no role names, descriptions or credentials in logs of the 3B error paths', () => {
  let api: AppProcess | undefined;
  let owner: SeededPrincipal;
  let holder: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    api = await startAppProcess('test/support/api-entry.ts', {
      ...baseTestEnv(),
      ...PROCESS_ENV,
    });
    owner = await seedUserPrincipal();
    holder = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
    await seedMemberInRole(
      org,
      await seedCustomRole(org, { permissions: [...C1, 'roles.write'] }),
      { authUserId: holder.authUserId },
    );
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await org?.dispose();
    await deleteSeededPrincipals([owner, holder]);
  });

  it('422, 403 escalation, 409 name taken and 409 role_in_use write no role name, description or bearer', async () => {
    const base = `http://127.0.0.1:${api?.port}/v1/orgs/${org.orgId}/roles`;
    const marker = `pii-${v7()}`;
    const call = (
      p: SeededPrincipal,
      method: string,
      url: string,
      body?: object,
    ) =>
      fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${p.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': `k-${v7()}`,
          'if-match': '*',
        },
        body: body && JSON.stringify(body),
      });
    expect(
      (
        await call(owner, 'POST', base, {
          name: `${marker}-a`,
          description: `${marker}-d`,
          permissions: ['members.role.assign'],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(holder, 'POST', base, {
          name: `${marker}-b`,
          description: `${marker}-d`,
          permissions: ['org.read', 'roles.read', 'invitations.read'],
        })
      ).status,
    ).toBe(403);
    const created = await call(owner, 'POST', base, {
      name: `${marker}-c`,
      description: `${marker}-d`,
      permissions: ['org.read'],
    });
    expect(created.status).toBe(201);
    expect(
      (
        await call(owner, 'POST', base, {
          name: `${marker}-c`,
          permissions: ['org.read'],
        })
      ).status,
    ).toBe(409);
    const holderRole = (await (
      await call(
        owner,
        'GET',
        `http://127.0.0.1:${api?.port}/v1/orgs/${org.orgId}/members`,
      )
    ).json()) as { data: { role: { id: string; systemKey: string | null } }[] };
    const custom = holderRole.data.find((m) => m.role.systemKey === null)?.role
      .id;
    expect((await call(owner, 'DELETE', `${base}/${custom}`)).status).toBe(409);
    await new Promise((r) => setTimeout(r, 1_000));
    const output = api?.output() ?? '';
    expect(output.includes(marker)).toBe(false);
    for (const secret of [owner.bearer, holder.bearer])
      expect(output.includes(secret)).toBe(false);
    // Đường từ chối có log (WARN `escalation_denied` với `rule`), chỉ là không mang nội dung.
    expect(output).toContain('escalation_denied');
  });
});
