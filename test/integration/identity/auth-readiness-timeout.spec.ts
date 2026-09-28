import { Module, type INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUTH_POOL,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { AuthDatabaseReadiness } from '../../../src/modules/identity/infra/better-auth/auth-readiness.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { startTcpProxy, type TcpProxy } from '../../support/tcp-proxy.js';

@Module({ providers: [...authPoolProviders, AuthDatabaseReadiness] })
class M {}

const CHECK_TIMEOUT_MS = 300;
/** Rộng hơn nhiều `CHECK_TIMEOUT_MS` nhưng hẹp hơn nhiều TCP timeout của kernel (phút). */
const MAX_PROBE_MS = 3000;

describe('auth_database readiness probe is bounded and never pins a pool client', () => {
  let app: INestApplication;
  let proxy: TcpProxy;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    proxy = await startTcpProxy(p.host, p.port);
    vi.stubEnv('DB_AUTH_HOST', '127.0.0.1');
    vi.stubEnv('DB_AUTH_PORT', String(proxy.port));
    vi.stubEnv('HEALTH_CHECK_TIMEOUT_MS', String(CHECK_TIMEOUT_MS));
    app = await createTestApp([M]);
  });
  afterAll(async () => {
    await app?.close();
    await proxy?.close();
    vi.unstubAllEnvs();
  });

  it('a blackholed connection fails the probe within HEALTH_CHECK_TIMEOUT_MS and the stuck client is destroyed', async () => {
    const probe = app.get(AuthDatabaseReadiness);
    const pool = app.get<pg.Pool>(AUTH_POOL);
    await probe.probe();
    expect({ total: pool.totalCount, idle: pool.idleCount }).toEqual({
      total: 1,
      idle: 1,
    });

    proxy.state.blackhole = true;
    const started = performance.now();
    await expect(probe.probe()).rejects.toThrow(
      `auth_database probe exceeded ${CHECK_TIMEOUT_MS}ms`,
    );
    expect(performance.now() - started).toBeLessThan(MAX_PROBE_MS);
    expect(pool.totalCount).toBe(0);

    proxy.state.blackhole = false;
    await expect(probe.probe()).resolves.toBeUndefined();
    expect(pool.totalCount).toBe(1);
  });
});
