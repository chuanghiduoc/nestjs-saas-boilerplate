import { Logger, type INestApplication } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { HealthModule, Readiness } from '../../../src/core/health/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import {
  AuthProviderRegistrationError,
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import { AUTH_POOL } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { AuthDatabaseReadiness } from '../../../src/modules/identity/infra/better-auth/auth-readiness.js';
import { BetterAuthCoreModule } from '../../../src/modules/identity/infra/better-auth/better-auth-core.module.js';
import { AuthProvider } from '../../../src/modules/identity/ports/auth-provider.js';
import { buildTestApp, createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../support/tcp-proxy.js';

const PASSWORD = 'correct horse battery';
const modules = () => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: false }),
  OutboxModule.forRoot({ relay: false }),
  EventsModule.forRoot({ worker: false }),
  NotificationsModule.forApi(),
  BetterAuthCoreModule,
];

const connectOwner = async () => {
  const { pg: p } = getInfra();
  const owner = new pg.Client({
    host: p.host,
    port: p.port,
    database: p.database,
    ...p.owner,
  });
  await owner.connect();
  return owner;
};
const signedInUser = async (
  auth: AuthInstance,
  owner: pg.Client,
  role?: string,
) => {
  const email = `p-${v7()}@example.test`;
  await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: 'P' },
  });
  const {
    rows: [row],
  } = await owner.query<{ id: string }>(
    `UPDATE auth."user" SET email_verified = true, role = coalesce($2, role) WHERE email = $1 RETURNING id`,
    [email, role ?? null],
  );
  if (!row) throw new Error('signed-up user row not found');
  const res = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  return {
    id: row.id,
    email,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
    bearer: res.headers.get('set-auth-token') ?? '',
  };
};

describe('BetterAuthProvider', () => {
  let app: INestApplication;
  let owner: pg.Client;
  let auth: AuthInstance;
  let provider: AuthProvider;
  const user = (role?: string) => signedInUser(auth, owner, role);
  beforeAll(async () => {
    app = await createTestApp([
      ...modules(),
      HealthModule.forRoot({ http: true }),
    ]);
    auth = app.get(BETTER_AUTH);
    provider = app.get(AuthProvider);
    owner = await connectOwner();
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
  });

  it('session cookie and bearer authenticate the same user; admin role flag', async () => {
    const u = await user('admin');
    const viaCookie = await provider.authenticate({
      headers: new Headers({ cookie: u.cookie }),
      credential: { kind: 'SESSION_COOKIE', value: 'x' },
    });
    const viaBearer = await provider.authenticate({
      headers: new Headers({ authorization: `Bearer ${u.bearer}` }),
      credential: { kind: 'BEARER_SESSION', value: u.bearer },
    });
    expect(viaCookie).toEqual({
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: u.id },
      credential: { kind: 'SESSION_COOKIE' },
      isPlatformAdmin: true,
    });
    expect(viaBearer).toEqual({
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: u.id },
      credential: { kind: 'BEARER_SESSION' },
      isPlatformAdmin: true,
    });
    const plain = await user();
    expect(
      await provider.authenticate({
        headers: new Headers({ cookie: plain.cookie }),
        credential: { kind: 'SESSION_COOKIE', value: 'x' },
      }),
    ).toEqual({
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: plain.id },
      credential: { kind: 'SESSION_COOKIE' },
      isPlatformAdmin: false,
    });
  });

  it('a user banned after the session was created is REJECTED on cookie and bearer (the session lookup already carries the ban); an elapsed ban is not', async () => {
    const u = await user();
    const cookie = {
      headers: new Headers({ cookie: u.cookie }),
      credential: { kind: 'SESSION_COOKIE' as const, value: 'x' },
    };
    const bearer = {
      headers: new Headers({ authorization: `Bearer ${u.bearer}` }),
      credential: { kind: 'BEARER_SESSION' as const, value: u.bearer },
    };
    await owner.query(
      `UPDATE auth."user" SET banned = true, ban_expires = NULL WHERE id = $1`,
      [u.id],
    );
    expect(await provider.authenticate(cookie)).toEqual({ kind: 'REJECTED' });
    expect(await provider.authenticate(bearer)).toEqual({ kind: 'REJECTED' });
    await owner.query(
      `UPDATE auth."user" SET ban_expires = now() + interval '1 hour' WHERE id = $1`,
      [u.id],
    );
    expect(await provider.authenticate(cookie)).toEqual({ kind: 'REJECTED' });
    await owner.query(
      `UPDATE auth."user" SET ban_expires = now() - interval '1 minute' WHERE id = $1`,
      [u.id],
    );
    expect(await provider.authenticate(bearer)).toMatchObject({
      kind: 'AUTHENTICATED',
      principal: { id: u.id },
    });
  });

  it('API key authenticates as its owning user, carries the key id, never admin; banned owner → REJECTED', async () => {
    const u = await user('admin');
    const created = await auth.api.createApiKey({
      body: { name: 'ci' },
      headers: new Headers({ cookie: u.cookie }),
    });
    const r = await provider.authenticate({
      headers: new Headers(),
      credential: { kind: 'API_KEY', value: created.key },
    });
    expect(r).toEqual({
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: u.id },
      credential: { kind: 'API_KEY', id: created.id },
      isPlatformAdmin: false,
    });
    await owner.query(
      `UPDATE auth."user" SET banned = true, ban_expires = NULL WHERE email = $1`,
      [u.email],
    );
    expect(
      await provider.authenticate({
        headers: new Headers(),
        credential: { kind: 'API_KEY', value: created.key },
      }),
    ).toEqual({ kind: 'REJECTED' });
  });

  it('S2-R76: AUTH_REQUIRE_EMAIL_VERIFICATION=true (default): an unverified session owner is EMAIL_NOT_VERIFIED on cookie and bearer (no cookie forwarded); an API key of an unverified owner is REJECTED', async () => {
    const u = await user();
    const created = await auth.api.createApiKey({
      body: { name: 'uv' },
      headers: new Headers({ cookie: u.cookie }),
    });
    await owner.query(
      `UPDATE auth."user" SET email_verified = false WHERE id = $1`,
      [u.id],
    );
    expect(
      await provider.authenticate({
        headers: new Headers({ cookie: u.cookie }),
        credential: { kind: 'SESSION_COOKIE', value: 'x' },
      }),
    ).toEqual({ kind: 'EMAIL_NOT_VERIFIED' });
    expect(
      await provider.authenticate({
        headers: new Headers({ authorization: `Bearer ${u.bearer}` }),
        credential: { kind: 'BEARER_SESSION', value: u.bearer },
      }),
    ).toEqual({ kind: 'EMAIL_NOT_VERIFIED' });
    expect(
      await provider.authenticate({
        headers: new Headers(),
        credential: { kind: 'API_KEY', value: created.key },
      }),
    ).toEqual({ kind: 'REJECTED' });
    await owner.query(
      `UPDATE auth."user" SET email_verified = true WHERE id = $1`,
      [u.id],
    );
    expect(
      await provider.authenticate({
        headers: new Headers(),
        credential: { kind: 'API_KEY', value: created.key },
      }),
    ).toMatchObject({ kind: 'AUTHENTICATED', principal: { id: u.id } });
  });

  it('disabled and expired API keys are REJECTED without a storage probe (KEY_DISABLED / KEY_EXPIRED are not ambiguous)', async () => {
    const u = await user();
    const headers = new Headers({ cookie: u.cookie });
    const disabled = await auth.api.createApiKey({
      body: { name: 'disabled' },
      headers,
    });
    const expired = await auth.api.createApiKey({
      body: { name: 'expired' },
      headers,
    });
    await owner.query(`UPDATE auth.apikey SET enabled = false WHERE id = $1`, [
      disabled.id,
    ]);
    await owner.query(
      `UPDATE auth.apikey SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expired.id],
    );
    const readiness = vi.spyOn(app.get(AuthDatabaseReadiness), 'probe');
    try {
      for (const key of [disabled.key, expired.key])
        expect(
          await provider.authenticate({
            headers: new Headers(),
            credential: { kind: 'API_KEY', value: key },
          }),
        ).toEqual({ kind: 'REJECTED' });
      expect(readiness).not.toHaveBeenCalled();
    } finally {
      readiness.mockRestore();
    }
  });

  it('garbage and empty credentials are REJECTED, external kinds are REJECTED in local mode', async () => {
    for (const credential of [
      { kind: 'API_KEY' as const, value: '' },
      { kind: 'API_KEY' as const, value: 'nope' },
      { kind: 'EXTERNAL_BEARER' as const, value: 'x' },
      { kind: 'EXTERNAL_COOKIE' as const, value: 'x' },
    ])
      expect(
        await provider.authenticate({ headers: new Headers(), credential }),
      ).toEqual({ kind: 'REJECTED' });
    expect(
      await provider.authenticate({
        headers: new Headers({ cookie: 'svc.session_token=bogus' }),
        credential: { kind: 'SESSION_COOKIE', value: 'bogus' },
      }),
    ).toEqual({ kind: 'REJECTED' });
  });

  it('getSession 401 (session deleted concurrently) → REJECTED; a 500 while the auth DB is healthy is a bug and is rethrown', async () => {
    const spy = vi.spyOn(auth.api, 'getSession');
    try {
      spy.mockRejectedValueOnce(
        new APIError('UNAUTHORIZED', { code: 'FAILED_TO_GET_SESSION' }),
      );
      expect(
        await provider.authenticate({
          headers: new Headers({ authorization: 'Bearer t' }),
          credential: { kind: 'BEARER_SESSION', value: 't' },
        }),
      ).toEqual({ kind: 'REJECTED' });
      const bug = new APIError('INTERNAL_SERVER_ERROR', {
        code: 'FAILED_TO_GET_SESSION',
      });
      spy.mockRejectedValueOnce(bug);
      await expect(
        provider.authenticate({
          headers: new Headers({ authorization: 'Bearer t' }),
          credential: { kind: 'BEARER_SESSION', value: 't' },
        }),
      ).rejects.toBe(bug);
    } finally {
      spy.mockRestore();
    }
  });

  it('a session lookup does not sign a JWT (JWT only via /token, spec §5.6.4): no JWKS work per authenticated request', async () => {
    const u = await user();
    const r = await auth.api.getSession({
      headers: new Headers({ cookie: u.cookie }),
      returnHeaders: true,
    });
    expect(r.response?.user.email).toBe(u.email);
    expect(r.headers.get('set-auth-jwt')).toBeNull();
  });

  it('auth_database is registered as a contributor of the core readiness registry and reports up', async () => {
    const results = await Promise.all(
      app
        .get(Readiness)
        .indicators()
        .map((check) => check()),
    );
    expect(results).toContainEqual({
      auth_database: expect.objectContaining({ status: 'up' }),
    });
  });
});

describe('BetterAuthProvider with AUTH_REQUIRE_EMAIL_VERIFICATION=false (S2-R76)', () => {
  let app: INestApplication;
  let owner: pg.Client;
  let auth: AuthInstance;
  let provider: AuthProvider;
  beforeAll(async () => {
    vi.stubEnv('AUTH_REQUIRE_EMAIL_VERIFICATION', 'false');
    app = await createTestApp(modules());
    auth = app.get(BETTER_AUTH);
    provider = app.get(AuthProvider);
    owner = await connectOwner();
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('an unverified owner stays a principal on session and API key (only the credential-minting endpoints are gated)', async () => {
    const u = await signedInUser(auth, owner);
    const created = await auth.api.createApiKey({
      body: { name: 'uv-off' },
      headers: new Headers({ cookie: u.cookie }),
    });
    await owner.query(
      `UPDATE auth."user" SET email_verified = false WHERE id = $1`,
      [u.id],
    );
    expect(
      await provider.authenticate({
        headers: new Headers({ cookie: u.cookie }),
        credential: { kind: 'SESSION_COOKIE', value: 'x' },
      }),
    ).toMatchObject({ kind: 'AUTHENTICATED', principal: { id: u.id } });
    expect(
      await provider.authenticate({
        headers: new Headers(),
        credential: { kind: 'API_KEY', value: created.key },
      }),
    ).toMatchObject({ kind: 'AUTHENTICATED', principal: { id: u.id } });
  });
});

describe('BetterAuthCoreModule boot and outage', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it('auth DB unreachable: boot still succeeds (degraded) and every local kind is UNAVAILABLE, never REJECTED', async () => {
    vi.stubEnv('DB_AUTH_PORT', '1');
    vi.stubEnv('DB_AUTH_CONNECTION_TIMEOUT_MS', '200');
    const quiet = [
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    ];
    try {
      app = await createTestApp(modules());
      const provider = app.get(AuthProvider);
      for (const [headers, credential] of [
        [
          new Headers({ cookie: 'svc.session_token=t' }),
          { kind: 'SESSION_COOKIE' as const, value: 't' },
        ],
        [
          new Headers({ authorization: 'Bearer t' }),
          { kind: 'BEARER_SESSION' as const, value: 't' },
        ],
        [new Headers(), { kind: 'API_KEY' as const, value: 'k' }],
      ] as const)
        expect(await provider.authenticate({ headers, credential })).toEqual({
          kind: 'UNAVAILABLE',
        });
    } finally {
      for (const s of quiet) s.mockRestore();
    }
  });

  it('auth pool exhausted mid-flight: errors Better Auth swallows (getSession 500, verifyApiKey INVALID_API_KEY) become UNAVAILABLE', async () => {
    vi.stubEnv('DB_AUTH_CONNECTION_TIMEOUT_MS', '300');
    app = await createTestApp(modules());
    const auth = app.get<AuthInstance>(BETTER_AUTH);
    const provider = app.get(AuthProvider);
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const owner = await connectOwner();
    const held: pg.PoolClient[] = [];
    const quiet = [
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    ];
    try {
      // Chạy thật trước khi làm cạn pool: schema check của Better Auth được cache, nên lỗi sau đó xảy ra BÊN
      // TRONG endpoint (nơi Better Auth nuốt lỗi gốc) chứ không ở `checkSchema` phía trước.
      const u = await signedInUser(auth, owner);
      const { key } = await auth.api.createApiKey({
        body: { name: 'ci' },
        headers: new Headers({ cookie: u.cookie }),
      });
      await expect(
        auth.api.verifyApiKey({ body: { key: 'nope' } }),
      ).resolves.toMatchObject({ valid: false });
      const max = app.get<{ poolMax: number }>(authDatabaseConfig.KEY).poolMax;
      for (let i = 0; i < max; i++) held.push(await pool.connect());
      for (const [headers, credential] of [
        [
          new Headers({ cookie: u.cookie }),
          { kind: 'SESSION_COOKIE' as const, value: 'x' },
        ],
        [
          new Headers({ authorization: `Bearer ${u.bearer}` }),
          { kind: 'BEARER_SESSION' as const, value: u.bearer },
        ],
        [new Headers(), { kind: 'API_KEY' as const, value: key }],
        [new Headers(), { kind: 'API_KEY' as const, value: 'nope' }],
      ] as const)
        expect(await provider.authenticate({ headers, credential })).toEqual({
          kind: 'UNAVAILABLE',
        });
      for (const c of held.splice(0)) c.release();
      expect(
        await provider.authenticate({
          headers: new Headers(),
          credential: { kind: 'API_KEY', value: key },
        }),
      ).toMatchObject({ kind: 'AUTHENTICATED' });
    } finally {
      for (const c of held) c.release();
      for (const s of quiet) s.mockRestore();
      await owner.end();
    }
  });

  describe('storage probe is bounded (review M3)', () => {
    const CHECK_TIMEOUT_MS = 300;
    /** Rộng hơn nhiều `CHECK_TIMEOUT_MS`, hẹp hơn nhiều TCP timeout của kernel (phút). */
    const MAX_AUTHENTICATE_MS = 3000;
    let proxy: TcpProxy;
    beforeAll(async () => {
      const { pg: p } = getInfra();
      proxy = await startTcpProxy(p.host, p.port);
    });
    afterAll(async () => {
      await proxy?.close();
    });

    it('a blackholed idle connection: the probe fails at HEALTH_CHECK_TIMEOUT_MS, the result is UNAVAILABLE and the stuck client is destroyed', async () => {
      vi.stubEnv('DB_AUTH_HOST', '127.0.0.1');
      vi.stubEnv('DB_AUTH_PORT', String(proxy.port));
      vi.stubEnv('HEALTH_CHECK_TIMEOUT_MS', String(CHECK_TIMEOUT_MS));
      app = await createTestApp(modules());
      const auth = app.get<AuthInstance>(BETTER_AUTH);
      const provider = app.get(AuthProvider);
      const pool = app.get<pg.Pool>(AUTH_POOL);
      // Một lời gọi thật chờ schema check của Better Auth xong (nó giữ một client lúc boot), rồi mọi client đều
      // rảnh: probe chắc chắn nhận một socket bị blackhole.
      await auth.api.getSession({ headers: new Headers() });
      await app.get(AuthDatabaseReadiness).probe();
      const before = pool.totalCount;
      expect(pool.idleCount).toBe(before);
      // Better Auth đã nuốt một lỗi storage (500 không cause); probe nhận đúng client rảnh đang bị blackhole.
      const getSession = vi.spyOn(auth.api, 'getSession').mockRejectedValueOnce(
        new APIError('INTERNAL_SERVER_ERROR', {
          code: 'FAILED_TO_GET_SESSION',
        }),
      );
      const quiet = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      proxy.state.blackhole = true;
      try {
        const started = performance.now();
        expect(
          await provider.authenticate({
            headers: new Headers({ authorization: 'Bearer t' }),
            credential: { kind: 'BEARER_SESSION', value: 't' },
          }),
        ).toEqual({ kind: 'UNAVAILABLE' });
        expect(performance.now() - started).toBeLessThan(MAX_AUTHENTICATE_MS);
        expect(pool.totalCount).toBe(before - 1);
      } finally {
        proxy.state.blackhole = false;
        getSession.mockRestore();
        quiet.mockRestore();
      }
    });
  });

  describe('S2-R37: a configured OIDC provider that did not register stops startup', () => {
    let idp: Server;
    let base: string;
    beforeAll(async () => {
      idp = createServer((req, res) => {
        const doc = {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(req.url?.startsWith('/good') ? { jwks_uri: `${base}/jwks` } : {}),
        };
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(doc));
      });
      await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        idp.close((e) => (e ? reject(e) : resolve())),
      );
    });
    const hybrid = (discovery: string) => {
      vi.stubEnv('AUTH_MODE', 'hybrid');
      vi.stubEnv('AUTH_OIDC_PROVIDER_ID', 'corp');
      vi.stubEnv(
        'AUTH_OIDC_DISCOVERY_URL',
        `${base}${discovery}/.well-known/openid-configuration`,
      );
      vi.stubEnv('AUTH_OIDC_CLIENT_ID', 'client');
      vi.stubEnv('AUTH_OIDC_CLIENT_SECRET', 'secret');
    };

    it('discovery without jwks_uri: init fails with AuthProviderRegistrationError naming the provider; close() still ends the pool', async () => {
      hybrid('/bad');
      const errors = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        app = await buildTestApp(modules());
        const init = app.init();
        await expect(init).rejects.toBeInstanceOf(
          AuthProviderRegistrationError,
        );
        await expect(init).rejects.toThrow(
          /OIDC provider "corp" did not register/,
        );
        const pool = app.get<pg.Pool>(AUTH_POOL);
        await app.close();
        app = undefined;
        expect(pool.ended).toBe(true);
      } finally {
        errors.mockRestore();
      }
    });

    it('discovery with issuer + jwks_uri: the app boots', async () => {
      hybrid('/good');
      app = await createTestApp(modules());
      expect(app.get(AuthProvider)).toBeDefined();
    });
  });

  it('AUTH_MODE=external: the module refuses to build (no auth pool consumer, no Better Auth instance)', async () => {
    vi.stubEnv('AUTH_MODE', 'external');
    vi.stubEnv('AUTH_EXTERNAL_JWKS_URL', 'https://idp.example.test/jwks');
    vi.stubEnv('AUTH_EXTERNAL_ISSUER', 'https://idp.example.test');
    vi.stubEnv('AUTH_EXTERNAL_AUDIENCE', 'api');
    vi.stubEnv('AUTH_EXTERNAL_ALGORITHMS', 'RS256');
    vi.stubEnv('AUTH_EXTERNAL_USER_CLAIM', 'idtyp');
    vi.stubEnv('AUTH_EXTERNAL_USER_CLAIM_VALUE', 'user');
    await expect(buildTestApp(modules())).rejects.toThrow(
      /BetterAuthCoreModule must not be loaded when AUTH_MODE=external/,
    );
  });
});
