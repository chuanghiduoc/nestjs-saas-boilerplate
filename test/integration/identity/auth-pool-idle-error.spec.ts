import { Logger, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUTH_POOL,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgIdentityDirectory } from '../../../src/modules/identity/infra/better-auth/pg-identity-directory.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

@Module({ providers: [...authPoolProviders, PgIdentityDirectory] })
class M {}

/**
 * The pool goes straight to Postgres here (not through PgBouncer as in `dbEnv()`): in transaction mode
 * PgBouncer keeps the client socket open when a server backend dies, so only a direct connection lets
 * `pg_terminate_backend` reach an idle pool client. The killer logs in as `auth_user` itself: a role may
 * signal its own backends, while `app_owner` (NOSUPERUSER, no `pg_signal_backend`) may not.
 */
describe('auth_user pool: an idle connection killed by the server never crashes the process', () => {
  let app: INestApplication;
  let killer: pg.Client;
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    const { pg: p } = getInfra();
    vi.stubEnv('DB_AUTH_HOST', p.host);
    vi.stubEnv('DB_AUTH_PORT', String(p.port));
    app = await createTestApp([M]);
    killer = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.auth,
    });
    await killer.connect();
  });
  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    await killer?.end();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('pg_terminate_backend on idle auth_user backends → logged warning, no uncaught exception, next query recovers', async () => {
    const pool = app.get<pg.Pool>(AUTH_POOL);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 1')]);
    expect(pool.idleCount).toBeGreaterThan(0);
    const killed = await killer.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'auth_user' AND datname = current_database() AND pid <> pg_backend_pid()`,
    );
    expect(killed.rowCount).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth_pool_idle_error' }),
        expect.any(String),
      ),
    );
    expect(uncaught).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('auth_user');
    await expect(
      app.get(PgIdentityDirectory).findUser(v7()),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
