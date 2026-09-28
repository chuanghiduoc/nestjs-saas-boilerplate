import type { INestApplication } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../src/core/queue/dashboard/queue-dashboard.server.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import {
  IdentityModule,
  authDatabaseConfig,
} from '../../../src/modules/identity/index.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';

const PASSWORD = 'correct horse battery';
type Decision = { status: number; code?: string; retryAfter?: string | null };
describe('Bull Board access (spec §5.12)', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  let url = '';
  const session = async (role?: string) => {
    const email = `q-${v7()}@example.test`;
    await auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Q' },
    });
    await ownerQuery(
      `UPDATE auth."user" SET email_verified = true, role = coalesce($2, role) WHERE email = $1`,
      [email, role ?? null],
    );
    const r = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    return {
      email,
      cookie: r.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
      bearer: r.headers.get('set-auth-token') ?? '',
    };
  };
  /** Parses the problem+json `code` too, so a test can assert *why* a request was denied, not only the status. */
  const get = async (headers: Record<string, string>): Promise<Decision> => {
    const res = await fetch(`${url}/api/queues`, { headers });
    const body = (await res.json().catch(() => undefined)) as
      { code?: string } | undefined;
    return {
      status: res.status,
      code: body?.code,
      retryAfter: res.headers.get('retry-after'),
    };
  };
  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      APP_ROLE: 'worker',
      WORKER_QUEUES: 'events,notifications',
      QUEUE_DASHBOARD_ENABLED: 'true',
      QUEUE_DASHBOARD_PORT: '0',
      QUEUE_DASHBOARD_IP_ALLOWLIST: '127.0.0.1/32',
      AUTH_COOKIE_PREFIX: 'svc',
      // Fix round 1 (I1): short so the UNAVAILABLE test (auth pool exhausted) does not wait on the
      // 3s default — same override as `better-auth-provider.spec.ts`'s "auth pool exhausted mid-flight" test.
      DB_AUTH_CONNECTION_TIMEOUT_MS: '300',
    }))
      vi.stubEnv(k, v);
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: true }),
      OutboxModule.forRoot({ relay: true }),
      EventsModule.forRoot({ worker: true }),
      NotificationsModule.forWorker(),
      IdentityModule.forWorker(),
    ]);
    auth = app.get(BETTER_AUTH);
    url = `http://127.0.0.1:${app.get(QueueDashboardServer).address().port}/queues`;
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('no credential → 401 unauthenticated; ordinary user cookie → 403 forbidden; platform admin cookie → 200', async () => {
    const anon = await get({});
    expect([anon.status, anon.code]).toEqual([401, 'unauthenticated']);
    const user = await get({ cookie: (await session()).cookie });
    expect([user.status, user.code]).toEqual([403, 'forbidden']);
    const admin = await get({ cookie: (await session('admin')).cookie });
    expect(admin.status).toBe(200);
  });
  it('platform admin (bearer) → 200', async () => {
    const admin = await session('admin');
    const r = await get({ authorization: `Bearer ${admin.bearer}` });
    expect(r.status).toBe(200);
  });
  it('an API key, even a valid admin one, → 403 forbidden before any storage lookup', async () => {
    const admin = await session('admin');
    const key = await auth.api.createApiKey({
      body: { name: 'k' },
      headers: new Headers({ cookie: admin.cookie }),
    });
    const validKey = await get({ 'x-api-key': key.key });
    expect([validKey.status, validKey.code]).toEqual([403, 'forbidden']);
    // Mutation check: a garbage key that matches no row must ALSO get 403. The authorizer denies every
    // `API_KEY` credential before calling `AuthProvider.authenticate` (spec §5.12: API key never accepted
    // by the dashboard). If that short-circuit (`platform-admin.authorizer.ts`, `credential.kind ===
    // 'API_KEY'`) were ever deleted, this credential would fall through to `authenticate`, which does a
    // real `verifyApiKey` lookup, finds no such key, and returns `REJECTED` → 401 — not 403. A valid key
    // alone cannot catch that mutation: `BetterAuthProvider` hard-codes `isPlatformAdmin: false` for every
    // API key (`better-auth.provider.ts`), so even a real admin's key would still land on 403 by the
    // ordinary "authenticated but not admin" branch if the short-circuit were gone.
    const garbageKey = await get({ 'x-api-key': 'not-a-real-key' });
    expect([garbageKey.status, garbageKey.code]).toEqual([403, 'forbidden']);
  });
  it('duplicate credentials → 400 ambiguous_credentials; a cross-site mutation with the admin cookie → 403 origin_not_allowed', async () => {
    const admin = await session('admin');
    const duplicate = await new Promise<{ status: number; code?: string }>(
      (resolve, reject) => {
        const u = new URL(`${url}/api/queues`);
        const req = httpRequest({
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          // A raw header ARRAY (not an object) skips Node's automatic `Host`; without it the response
          // never carries a `code` (`csrf-duplicates.e2e.spec.ts` documents the same requirement).
          headers: [
            'host',
            `${u.hostname}:${u.port}`,
            'cookie',
            admin.cookie,
            'authorization',
            `Bearer ${admin.bearer}`,
          ],
        });
        req.on('response', (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const code = (JSON.parse(body) as { code?: string }).code;
            resolve({ status: res.statusCode ?? 0, code });
          });
        });
        req.on('error', reject);
        req.end();
      },
    );
    expect([duplicate.status, duplicate.code]).toEqual([
      400,
      'ambiguous_credentials',
    ]);
    const m = await fetch(`${url}/api/queues/notifications/pause`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, origin: 'https://evil.test' },
    });
    const mBody = (await m.json()) as { code?: string };
    // Mutation check: dropping the CSRF gate lets this admin-authenticated request reach Bull Board's
    // own read-only enforcement, which answers unsafe methods with 405 (not 403) — so `status` alone
    // already catches that mutation; asserting `code` also rules out an unrelated 403 (e.g. a bug that
    // stops recognizing this user as admin).
    expect([m.status, mBody.code]).toEqual([403, 'origin_not_allowed']);
  });
  it('a pending 2FA sign-in (two_factor cookie only) cannot open the dashboard', async () => {
    const r = await get({ cookie: 'svc.two_factor=forged' });
    expect([r.status, r.code]).toEqual([401, 'unauthenticated']);
  });
  it('a syntactically valid but garbage session cookie → 401 unauthenticated (REJECTED, not merely absent)', async () => {
    // Unlike the two_factor-only case above (never even detected as a credential), this cookie name
    // matches the session-cookie pattern, so it IS picked up as a `SESSION_COOKIE` credential and reaches
    // `AuthProvider.authenticate`, which resolves no session for it and returns `REJECTED`.
    const r = await get({
      cookie: 'svc.session_token=garbage-value-does-not-exist',
    });
    expect([r.status, r.code]).toEqual([401, 'unauthenticated']);
  });
  it('a banned admin (existing cookie or bearer) → 401, not 403: the ban is read fresh on every request', async () => {
    const admin = await session('admin');
    await ownerQuery(
      `UPDATE auth."user" SET banned = true, ban_expires = NULL WHERE email = $1`,
      [admin.email],
    );
    const viaCookie = await get({ cookie: admin.cookie });
    expect([viaCookie.status, viaCookie.code]).toEqual([
      401,
      'unauthenticated',
    ]);
    const viaBearer = await get({ authorization: `Bearer ${admin.bearer}` });
    expect([viaBearer.status, viaBearer.code]).toEqual([
      401,
      'unauthenticated',
    ]);
  });
  it('an admin session demoted to a plain user mid-session → 403: role is read fresh, never cached', async () => {
    const admin = await session('admin');
    await ownerQuery(`UPDATE auth."user" SET role = 'user' WHERE email = $1`, [
      admin.email,
    ]);
    const r = await get({ cookie: admin.cookie });
    expect([r.status, r.code]).toEqual([403, 'forbidden']);
  });
  it('a static asset with no credential → 401: the guard covers the whole basePath, not only the API', async () => {
    const res = await fetch(`${url}/static/js/main.js`);
    const body = (await res.json().catch(() => undefined)) as
      { code?: string } | undefined;
    expect([res.status, body?.code]).toEqual([401, 'unauthenticated']);
  });
  it('the auth pool exhausted → 503 service_unavailable with a positive Retry-After, never a silent 401', async () => {
    const admin = await session('admin');
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const max = app.get<{ poolMax: number }>(authDatabaseConfig.KEY).poolMax;
    const held: pg.PoolClient[] = [];
    try {
      for (let i = 0; i < max; i++) held.push(await pool.connect());
      const r = await get({ cookie: admin.cookie });
      expect([r.status, r.code]).toEqual([503, 'service_unavailable']);
      expect(Number(r.retryAfter)).toBeGreaterThan(0);
    } finally {
      for (const c of held.splice(0)) c.release();
    }
  });
});
