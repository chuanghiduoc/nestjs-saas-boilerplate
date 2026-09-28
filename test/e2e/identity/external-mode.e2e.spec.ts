import {
  Controller,
  Get,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { PublicRoute } from '../../../src/core/http/index.js';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { QueueDashboardServer } from '../../../src/core/queue/dashboard/queue-dashboard.server.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { IdentityModule } from '../../../src/modules/identity/index.js';
import { JwksAuthProvider } from '../../../src/modules/identity/infra/jwks/jwks.provider.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { startFakeJwks, type FakeJwks } from '../../support/fake-jwks.js';
import { startIdentityApp } from '../../support/identity-app.js';

@Controller('probe')
class Probe {
  constructor(private readonly ctx: RequestContext) {}
  @Get('who') who() {
    return {
      principal: this.ctx.principal(),
      credential: this.ctx.credential(),
    };
  }
  @PublicRoute()
  @Get('public')
  open() {
    return { principal: this.ctx.principal() ?? null };
  }
  @Post('write') write() {
    return { ok: true };
  }
}
@Module({ controllers: [Probe] })
class ProbeModule {}
const ISS = 'https://idp.example.test';
const AUD = 'api://boilerplate';
const COOKIE = 'idp_token';
/** Tên cookie session Better Auth sẽ dùng với `AUTH_COOKIE_PREFIX=svc` ở local/hybrid. */
const BA_SESSION_COOKIE = 'svc.session_token';
const now = () => Math.floor(Date.now() / 1000);
const externalEnv = (jwks: FakeJwks): Record<string, string> => ({
  AUTH_MODE: 'external',
  BETTER_AUTH_SECRET: '',
  DB_AUTH_PASSWORD: '',
  AUTH_EXTERNAL_JWKS_URL: jwks.url,
  AUTH_EXTERNAL_ISSUER: ISS,
  AUTH_EXTERNAL_AUDIENCE: AUD,
  AUTH_EXTERNAL_ALGORITHMS: 'RS256',
  AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
  AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
  AUTH_EXTERNAL_ADMIN_CLAIM: 'roles',
  AUTH_EXTERNAL_ADMIN_VALUE: 'admin',
  AUTH_EXTERNAL_TOKEN_COOKIE: COOKIE,
  AUTH_COOKIE_PREFIX: 'svc',
  RESILIENCE_ALLOWED_SCHEMES: 'http,https',
  RESILIENCE_ALLOWED_PORTS: new URL(jwks.url).port,
  RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
});
const userClaims = (sub: string, extra: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: AUD,
  sub,
  iat: now(),
  exp: now() + 300,
  idtyp: 'user',
  ...extra,
});

describe('AUTH_MODE=external end to end', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  let token = '';
  beforeAll(async () => {
    jwks = await startFakeJwks();
    app = await startIdentityApp({
      extraImports: [ResilienceModule, ProbeModule],
      env: externalEnv(jwks),
    });
    token = await jwks.sign(userClaims('ext-1'));
  });
  afterAll(async () => {
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });
  const http = () => request(app.getHttpServer());

  it('token via header and via cookie authenticate the same principal', async () => {
    const a = await http()
      .get('/probe/who')
      .set('authorization', `Bearer ${token}`);
    const b = await http()
      .get('/probe/who')
      .set('cookie', `${COOKIE}=${token}`);
    expect(a.body).toEqual({
      principal: { type: 'user', id: 'ext-1' },
      credential: { kind: 'EXTERNAL_BEARER' },
    });
    expect(b.body).toEqual({
      principal: { type: 'user', id: 'ext-1' },
      credential: { kind: 'EXTERNAL_COOKIE' },
    });
  });
  it('header + cookie together → 400 ambiguous_credentials; a machine token → 401', async () => {
    const both = await http()
      .get('/probe/who')
      .set('authorization', `Bearer ${token}`)
      .set('cookie', `${COOKIE}=${token}`);
    expect([both.status, both.body.code]).toEqual([
      400,
      'ambiguous_credentials',
    ]);
    const machine = await jwks.sign(userClaims('svc', { idtyp: 'app' }));
    expect(
      (await http().get('/probe/who').set('authorization', `Bearer ${machine}`))
        .status,
    ).toBe(401);
  });
  it('an API key is REJECTED (401), even on a public route: never downgraded to anonymous', async () => {
    const key = await http().get('/probe/who').set('x-api-key', 'some-key');
    expect([key.status, key.body.code]).toEqual([401, 'unauthenticated']);
    const pub = await http().get('/probe/public').set('x-api-key', 'some-key');
    expect([pub.status, pub.body.code]).toEqual([401, 'unauthenticated']);
  });
  it('a Better Auth session cookie is not a credential here (§5.6.1): anonymous, not REJECTED', async () => {
    const cookie = `${BA_SESSION_COOKIE}=abc`;
    // Authed route: 401 only because the request is anonymous (default guard).
    expect((await http().get('/probe/who').set('cookie', cookie)).status).toBe(
      401,
    );
    // Public route: anonymous passes (a REJECTED credential would be 401 here, see the API key case).
    const pub = await http().get('/probe/public').set('cookie', cookie);
    expect([pub.status, pub.body]).toEqual([200, { principal: null }]);
    // Not counted: together with a bearer it is not ambiguous (400); the bearer authenticates.
    const withBearer = await http()
      .get('/probe/who')
      .set('cookie', cookie)
      .set('authorization', `Bearer ${token}`);
    expect([withBearer.status, withBearer.body.credential]).toEqual([
      200,
      { kind: 'EXTERNAL_BEARER' },
    ]);
  });
  it('an unclassified provider error (IdP key jose refuses) → 500 internal_error, not a masked 503 (S2-R55)', async () => {
    const r = await http()
      .get('/probe/who')
      .set(
        'authorization',
        `Bearer ${jwks.signWithWeakKey(userClaims('w-1'))}`,
      );
    expect([r.status, r.body.code]).toEqual([500, 'internal_error']);
  });
  it('cookie token POST from a cross-site Origin → 403; a bearer POST from the same Origin passes', async () => {
    const r = await http()
      .post('/probe/write')
      .set('cookie', `${COOKIE}=${token}`)
      .set('origin', 'https://evil.test');
    expect([r.status, r.body.code]).toEqual([403, 'origin_not_allowed']);
    const b = await http()
      .post('/probe/write')
      .set('authorization', `Bearer ${token}`)
      .set('origin', 'https://evil.test');
    expect(b.status).toBe(201);
  });
  it('Better Auth is not mounted: /api/auth/* and /v1/me do not exist; readiness has no auth_database', async () => {
    expect(
      (
        await http()
          .post('/api/auth/sign-in/email')
          .set('authorization', `Bearer ${token}`)
          .send({})
      ).status,
    ).toBe(404);
    expect(
      (await http().get('/v1/me').set('authorization', `Bearer ${token}`))
        .status,
    ).toBe(404);
    const ready = await http().get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.info).not.toHaveProperty('auth_database');
  });
  it('a route under AUTH_BASE_PATH still goes through the credential check (no mount exclusion)', async () => {
    const r = await http()
      .get('/api/auth/anything')
      .set('authorization', `Bearer ${token}`)
      .set('cookie', `${COOKIE}=${token}`);
    expect([r.status, r.body.code]).toEqual([400, 'ambiguous_credentials']);
  });
});

describe('AUTH_MODE=external worker: Bull Board authorizes with the IdP token (spec §5.12)', () => {
  let app: INestApplication;
  let jwks: FakeJwks;
  let url = '';
  const get = (headers: Record<string, string>) =>
    fetch(`${url}/api/queues`, { headers });
  beforeAll(async () => {
    jwks = await startFakeJwks();
    for (const [k, v] of Object.entries({
      ...externalEnv(jwks),
      APP_ROLE: 'worker',
      WORKER_QUEUES: 'events,notifications',
      QUEUE_DASHBOARD_ENABLED: 'true',
      QUEUE_DASHBOARD_PORT: '0',
      QUEUE_DASHBOARD_IP_ALLOWLIST: '127.0.0.1/32',
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
    url = `http://127.0.0.1:${app.get(QueueDashboardServer).address().port}/queues`;
  });
  afterAll(async () => {
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('no credential → 401; user token → 403; admin token (cookie or bearer) → 200; API key → 403', async () => {
    expect((await get({})).status).toBe(401);
    const user = await jwks.sign(userClaims('u-1'));
    expect((await get({ authorization: `Bearer ${user}` })).status).toBe(403);
    const admin = await jwks.sign(userClaims('a-1', { roles: ['admin'] }));
    expect((await get({ cookie: `${COOKIE}=${admin}` })).status).toBe(200);
    expect((await get({ authorization: `Bearer ${admin}` })).status).toBe(200);
    expect((await get({ 'x-api-key': 'k' })).status).toBe(403);
  });
  it('a cross-site PUT with the admin external cookie → 403 origin_not_allowed', async () => {
    const admin = await jwks.sign(userClaims('a-2', { roles: ['admin'] }));
    const r = await fetch(`${url}/api/queues/events/pause`, {
      method: 'PUT',
      headers: { cookie: `${COOKIE}=${admin}`, origin: 'https://evil.test' },
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code?: unknown }).code).toBe(
      'origin_not_allowed',
    );
  });
});

describe('AUTH_MODE=external worker with the dashboard disabled', () => {
  let app: INestApplication | undefined;
  let jwks: FakeJwks;
  beforeAll(async () => {
    jwks = await startFakeJwks();
  });
  afterAll(async () => {
    await app?.close();
    await jwks?.close();
    vi.unstubAllEnvs();
  });

  it('boots (no Better Auth, no dashboard) with the JWKS provider as its AuthProvider', async () => {
    for (const [k, v] of Object.entries({
      ...externalEnv(jwks),
      APP_ROLE: 'worker',
      WORKER_QUEUES: 'events,notifications',
      QUEUE_DASHBOARD_ENABLED: 'false',
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
    expect(app.get(AuthProvider)).toBeInstanceOf(JwksAuthProvider);
  });
});
