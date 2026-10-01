import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  hashToken,
  newToken,
  seedInvitation,
  seedInviteLink,
  seedOrg,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const PROCESS_ENV: Record<string, string> = {
  LOG_LEVEL: 'debug',
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
};
/** Cổng không có SMTP: mọi lần gửi thư mời thất bại `SMTP_CONNECTION` (spec §18.4 "SMTP lỗi khi gửi thư mời"). */
const DEAD_SMTP = { SMTP_HOST: '127.0.0.1', SMTP_PORT: '9' };

/** Spec SP3 §16, §18.4, tiêu chí 16: email được mời, token, `token_hash` không vào log api/worker hay failed reason. */
describe('no invited email, token or token hash in the logs and failure records of the 3C error paths', () => {
  let api: AppProcess | undefined;
  let worker: AppProcess | undefined;
  let owner: SeededPrincipal;
  let stranger: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    api = await startAppProcess('test/support/api-entry.ts', {
      ...baseTestEnv(),
      ...PROCESS_ENV,
      ...DEAD_SMTP,
    });
    worker = await startAppProcess('test/support/worker-entry.ts', {
      ...baseTestEnv(),
      APP_ROLE: 'worker',
      LOG_LEVEL: 'debug',
      ...DEAD_SMTP,
    });
    owner = await seedUserPrincipal();
    stranger = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await stopAppProcess(worker);
    await org?.dispose();
    await deleteSeededPrincipals([owner, stranger]);
  });

  it('a mail that cannot be sent, an email mismatch, unknown tokens and previews leave no email, token or hash anywhere', async () => {
    const base = `http://127.0.0.1:${api?.port}`;
    const call = (
      p: SeededPrincipal | undefined,
      method: string,
      path: string,
      body?: object,
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          ...(p ? { authorization: `Bearer ${p.bearer}` } : {}),
          'content-type': 'application/json',
          'idempotency-key': `k-${v7()}`,
          'x-forwarded-for': '198.18.7.7',
        },
        body: body && JSON.stringify(body),
      });
    const invited = `pii-${v7()}@example.test`;
    const created = await call(
      owner,
      'POST',
      `/v1/orgs/${org.orgId}/invitations`,
      { email: invited, roleId: org.roles.MEMBER.publicId },
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const mismatch = await seedInvitation(org, {
      email: `other-${v7()}@example.test`,
      roleId: org.roles.MEMBER.id,
      inviterMemberId: org.owner.memberId,
    });
    expect(
      (
        await call(stranger, 'POST', '/v1/invitations/accept', {
          token: mismatch.token,
        })
      ).status,
    ).toBe(403);
    const unknown = newToken();
    expect(
      (
        await call(stranger, 'POST', '/v1/invitations/accept', {
          token: unknown,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(undefined, 'POST', '/v1/invitations/preview', {
          token: unknown,
        })
      ).status,
    ).toBe(404);
    const link = await seedInviteLink(org, {
      roleId: org.roles.MEMBER.id,
      createdByMemberId: org.owner.memberId,
    });
    expect(
      (
        await call(undefined, 'POST', '/v1/invite-links/preview', {
          token: link.token,
        })
      ).status,
    ).toBe(200);
    // Worker đã thử gửi và thất bại (failed reason chỉ là mã enum của SP2).
    const failed = async () =>
      ownerQuery<{ code: string | null }>(
        `SELECT last_error_code AS code FROM email_deliveries WHERE idempotency_key = $1`,
        [`org-invitation:${id}`],
      );
    for (let i = 0; i < 300 && (await failed())[0]?.code == null; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect((await failed())[0]?.code).toBe('SMTP_CONNECTION');
    await new Promise((r) => setTimeout(r, 1_000));
    const output = `${api?.output() ?? ''}${worker?.output() ?? ''}`;
    for (const secret of [
      invited,
      mismatch.token,
      hashToken(mismatch.token),
      unknown,
      hashToken(unknown),
      link.token,
      hashToken(link.token),
      owner.bearer,
      stranger.bearer,
    ])
      expect(output.includes(secret)).toBe(false);
    expect(output).not.toContain('#token=');
    // Đường lỗi có dấu vết (mã lỗi), chỉ là không mang dữ liệu: đúng một dòng metric/log mang mã enum.
    expect(output).toContain('invitation_email_mismatch');
  });
});
