import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { AuthClient } from '../../support/auth-client.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import { mailpitFromInfra } from '../../support/mailpit.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const mail = mailpitFromInfra();
const PASSWORD = 'correct horse battery';
const EMAIL_ADDRESS =
  /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi;
const SYSTEM_SENDER = 'noreply@example.test';
const FLUSH_MS = 1_000;
const PROCESS_ENV: Record<string, string> = {
  LOG_LEVEL: 'debug',
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
  WORKER_QUEUES: 'events,notifications,maintenance',
  AUTH_RATE_LIMIT_MAX: '10000',
  AUTH_SIGNIN_RATE_MAX: '1000',
  AUTH_EMAIL_RATE_MAX: '1000',
  AUTH_ENUMERATION_MIN_RESPONSE_MS: '0',
};

describe('no PII in logs of the 3A error paths (spec SP3 §16, §18.4, tiêu chí 16)', () => {
  let api: AppProcess | undefined;
  let worker: AppProcess | undefined;
  let base = '';
  const secrets = new Set<string>([PASSWORD]);
  const seeded: SeededPrincipal[] = [];
  const created: string[] = [];
  const registered: string[] = [];
  beforeAll(async () => {
    const env = { ...baseTestEnv(), ...PROCESS_ENV };
    const [a, w] = await Promise.allSettled([
      startAppProcess('test/support/api-entry.ts', env),
      startAppProcess('test/support/worker-entry.ts', env),
    ]);
    if (a.status === 'fulfilled') api = a.value;
    if (w.status === 'fulfilled') worker = w.value;
    if (a.status === 'rejected' || w.status === 'rejected') {
      await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
      throw new Error('app process failed to start');
    }
    base = `http://127.0.0.1:${api?.port}`;
  });
  afterAll(async () => {
    await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
    await purgeOrgs(created);
    await deleteTenancyUsersOf([
      ...seeded.map((p) => p.authUserId),
      ...registered,
    ]);
    await deleteSeededPrincipals(seeded);
    await ownerQuery('DELETE FROM auth."user" WHERE id = ANY($1::uuid[])', [
      registered,
    ]);
  });

  it('create/rename/delete/restore, 404 misses, 403, escalation, last-owner and blocked account deletion write no address or token', async () => {
    const started = await mail.now();
    const email = `pii-tenancy-${v7()}@example.test`;
    secrets.add(email);
    const c = new AuthClient(base);
    expect((await c.signUp(email, PASSWORD)).status).toBe(202);
    await c.verifyEmailFromMailpit(mail, email, started);
    expect((await c.signIn(email, PASSWORD)).status).toBe(200);
    for (const [, v] of c.cookies) secrets.add(decodeURIComponent(v));
    if (c.bearer) secrets.add(c.bearer);
    const [row] = await ownerQuery<{ id: string }>(
      'SELECT id FROM auth."user" WHERE email = $1',
      [email],
    );
    if (!row) throw new Error('registered user not found');
    registered.push(row.id);

    const org = await c.request('post', '/v1/orgs', {
      body: { name: 'Pii Org' },
      headers: { 'idempotency-key': `k-${v7()}` },
    });
    expect(org.status).toBe(201);
    created.push(org.body.id);
    const orgUrl = `/v1/orgs/${org.body.id}`;
    expect(
      (
        await c.request('patch', orgUrl, {
          body: { name: 'Renamed' },
          headers: { 'if-match': '*' },
        })
      ).status,
    ).toBe(200);
    expect((await c.request('get', `/v1/orgs/${v7()}`)).status).toBe(404);
    expect((await c.request('get', '/v1/orgs/not-a-uuid')).status).toBe(400);
    expect((await c.request('delete', `${orgUrl}/members/me`)).status).toBe(
      409,
    );
    const me = await c.request('get', `${orgUrl}/members/me`);
    expect(
      (
        await c.request('patch', `${orgUrl}/members/${me.body.id}`, {
          body: { roleId: me.body.role.id },
          headers: { 'if-match': '*' },
        })
      ).status,
    ).toBe(403);
    // Spec SP3 §5.3 (3D, N5-1): admin gọi `/admin/*` là nhân viên có factor và dấu TOTP tươi.
    const admin = await seedStaffPrincipal();
    seeded.push(admin);
    secrets.add(admin.bearer);
    const blocked = await new AuthClient(base).request(
      'post',
      '/api/auth/admin/remove-user',
      { bearer: admin.bearer, cookie: false, body: { userId: row.id } },
    );
    expect(blocked.status).toBe(409);
    expect((await c.request('delete', orgUrl)).status).toBe(204);
    expect(
      (
        await c.request('post', `${orgUrl}/restore`, {
          headers: { 'idempotency-key': `k-${v7()}` },
        })
      ).status,
    ).toBe(200);

    await new Promise((r) => setTimeout(r, FLUSH_MS));
    const output = `${api?.output() ?? ''}\n${worker?.output() ?? ''}`;
    const addresses = [...output.matchAll(EMAIL_ADDRESS)]
      .map((m) => m[0].toLowerCase())
      .filter((a) => a !== SYSTEM_SENDER);
    expect(addresses).toEqual([]);
    for (const s of secrets) expect(output.includes(s)).toBe(false);
  });
});
