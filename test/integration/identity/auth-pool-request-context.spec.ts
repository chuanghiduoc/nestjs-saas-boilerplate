import { Module, type INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Logger as PinoNestLogger, LoggerModule } from 'nestjs-pino';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import {
  BASE_REDACT_PATHS,
  contextLogFields,
  errSerializer,
  reqSerializer,
} from '../../../src/core/logging/index.js';
import {
  AUTH_POOL,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

/**
 * S2-R73 (task-43 F1): reproduces the exact shape of the bug on a REAL rendered pino line — a spy on
 * `Logger.prototype.warn` never shows this, because `requestId`/`traceId`/... are injected by pino's `mixin`
 * (`contextLogFields`), which runs INSIDE the real pino write, downstream of any spy on the Nest `Logger` class.
 * So this test wires up a real `LoggerModule` (same `mixin`/redact/serializers as `src/core/logging/logging.module.ts`)
 * pointed at an in-memory sink instead of fd 1, and drives the auth pool through `RequestContext#run` directly
 * (no HTTP layer needed): request A's scope creates the ONE physical connection (`DB_AUTH_POOL_MAX=1`); after A's
 * scope has closed and the connection is idle, request B's scope is what makes the server kill that same backend
 * (`pg_terminate_backend`), which fires pg-pool's own idle-connection listener (`auth_pool_idle_error`,
 * `auth-pool.ts`). Node's `AsyncLocalStorage` propagates by continuation (the resource's creation chain), not by
 * "whichever request is logically current", so — before the S2-R73 fix — this WARN line carries request A's
 * `requestId`, not B's and not none, even though B is the request whose action produced it.
 */
@Module({ providers: [...authPoolProviders] })
class AuthPoolTestModule {}

type LogLine = Record<string, unknown>;
const isRecord = (v: unknown): v is LogLine =>
  typeof v === 'object' && v !== null;

describe('S2-R73: the auth pool idle-error listener logs outside any request context', () => {
  let app: INestApplication;
  let killer: pg.Client;
  const lines: LogLine[] = [];
  const sink = {
    write: (chunk: string): void => {
      for (const l of chunk.split('\n')) {
        if (!l.startsWith('{')) continue;
        const parsed: unknown = JSON.parse(l);
        if (isRecord(parsed)) lines.push(parsed);
      }
    },
  };

  beforeAll(async () => {
    const { pg: p } = getInfra();
    // Đi thẳng Postgres (không qua PgBouncer): PgBouncer transaction mode giữ socket client mở khi backend chết,
    // nên `pg_terminate_backend` chỉ chạm tới một pool idle qua kết nối trực tiếp (như auth-pool-idle-error.spec.ts).
    vi.stubEnv('DB_AUTH_HOST', p.host);
    vi.stubEnv('DB_AUTH_PORT', String(p.port));
    vi.stubEnv('DB_AUTH_POOL_MAX', '1');

    app = await createTestApp([
      LoggerModule.forRootAsync({
        inject: [ClsService],
        useFactory: (cls: ClsService) => ({
          pinoHttp: [
            {
              level: 'debug',
              redact: { paths: [...BASE_REDACT_PATHS], censor: '[REDACTED]' },
              serializers: { err: errSerializer, req: reqSerializer },
              mixin: () => contextLogFields(cls),
            },
            sink,
          ],
        }),
      }),
      AuthPoolTestModule,
    ]);
    app.useLogger(app.get(PinoNestLogger));

    killer = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.auth,
    });
    await killer.connect();
  });

  afterAll(async () => {
    await killer?.end();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('a backend killed while idle logs auth_pool_idle_error without requestId/traceId/orgId of the request that created the connection or the one that triggered the kill', async () => {
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const ctx = app.get(RequestContext);

    // Request A: cold pool (DB_AUTH_POOL_MAX=1) — this query opens the one physical connection.
    await ctx.run({ requestId: 'req-A-creates-connection' }, async () => {
      await pool.query('select 1');
    });
    expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({
      total: 1,
      idle: 1,
    });

    // Request B, a later, separate scope: what actually triggers the pool event (the server-side kill).
    await ctx.run({ requestId: 'req-B-triggers-kill' }, async () => {
      const killed = await killer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'auth_user' AND datname = current_database() AND pid <> pg_backend_pid()`,
      );
      expect(killed.rowCount).toBeGreaterThan(0);
      await vi.waitFor(() =>
        expect(lines.some((l) => l.event === 'auth_pool_idle_error')).toBe(
          true,
        ),
      );
    });

    const warnLine = lines.find((l) => l.event === 'auth_pool_idle_error');
    expect(warnLine).toBeDefined();
    // Sanity: this is really the pool-scoped payload of auth-pool.ts, not a fluke match.
    expect(warnLine).toMatchObject({
      level: 40,
      event: 'auth_pool_idle_error',
    });
    expect(typeof warnLine?.name).toBe('string');
    // S2-R73: no request field of EITHER request — not A's (stale, the actual pre-fix bug), not B's either.
    expect(warnLine).not.toHaveProperty('requestId');
    expect(warnLine).not.toHaveProperty('traceId');
    expect(warnLine).not.toHaveProperty('orgId');

    await vi.waitFor(() => expect(pool.totalCount).toBe(0));
  });
});
