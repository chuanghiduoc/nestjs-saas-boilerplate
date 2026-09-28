import { Logger } from '@nestjs/common';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../../src/core/config/index.js';
import { databaseConfig } from '../../../src/core/database/index.js';
import { healthConfig } from '../../../src/core/health/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import { AuthDatabaseReadiness } from '../../../src/modules/identity/infra/better-auth/auth-readiness.js';
import { applyTestEnv } from '../../support/app-factory.js';

/** `statement_timeout` của role `auth_user` trên DB test (`TEST_DB_TIMEOUTS.authStatementMs`). */
const TEST_ROLE_STATEMENT_TIMEOUT_MS = 5000;

/**
 * S2-R60 review M4: probe `auth_database` đọc `statement_timeout` THẬT qua pool auth và đòi nó nhỏ hơn
 * `DB_AUTH_QUERY_TIMEOUT_MS`. Production: vi phạm làm probe thất bại (readiness down, S2-R45 → 503) và log error.
 * Ngoài production: log error một lần, probe vẫn qua.
 */
describe('auth_database probe checks the real auth_user statement_timeout (S2-R60 review M4)', () => {
  let pool: pg.Pool | undefined;
  const spyError = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  let errors: ReturnType<typeof spyError> | undefined;

  const probeWith = (env: Record<string, string>) => {
    applyTestEnv();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    errors = spyError();
    pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    return new AuthDatabaseReadiness(
      pool,
      healthConfig(),
      authDatabaseConfig(),
      appConfig(),
    );
  };
  const misconfigLogs = () =>
    (errors?.mock.calls ?? []).flatMap(([fields]) =>
      typeof fields === 'object' &&
      fields !== null &&
      'event' in fields &&
      fields.event === 'auth_statement_timeout_misconfigured'
        ? [fields]
        : [],
    );

  afterEach(async () => {
    await pool?.end();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    pool = undefined;
  });

  it('passes when the role value (5000 ms) is below DB_AUTH_QUERY_TIMEOUT_MS (6000 ms default), in production too', async () => {
    const probe = probeWith({ NODE_ENV: 'production' });
    await expect(probe.probe()).resolves.toBeUndefined();
    expect(misconfigLogs()).toEqual([]);
  });

  it('production: DB_AUTH_QUERY_TIMEOUT_MS at or below the role value fails the probe loudly, on every probe', async () => {
    const probe = probeWith({
      NODE_ENV: 'production',
      DB_AUTH_QUERY_TIMEOUT_MS: String(TEST_ROLE_STATEMENT_TIMEOUT_MS),
    });
    const message = `auth_user statement_timeout (${TEST_ROLE_STATEMENT_TIMEOUT_MS} ms) must be below DB_AUTH_QUERY_TIMEOUT_MS (${TEST_ROLE_STATEMENT_TIMEOUT_MS} ms)`;
    await expect(probe.probe()).rejects.toThrow(message);
    await expect(probe.probe()).rejects.toThrow(message);
    expect(misconfigLogs()).toEqual([
      {
        event: 'auth_statement_timeout_misconfigured',
        settingMs: TEST_ROLE_STATEMENT_TIMEOUT_MS,
        enforced: true,
      },
      {
        event: 'auth_statement_timeout_misconfigured',
        settingMs: TEST_ROLE_STATEMENT_TIMEOUT_MS,
        enforced: true,
      },
    ]);
    // Client của probe vẫn về pool: lỗi là cấu hình, connection vẫn tốt.
    expect(pool?.idleCount).toBe(1);
  });

  it('outside production: the same misconfiguration is logged as an error once per process and the probe still passes', async () => {
    const probe = probeWith({ DB_AUTH_QUERY_TIMEOUT_MS: '1000' });
    await expect(probe.probe()).resolves.toBeUndefined();
    await expect(probe.probe()).resolves.toBeUndefined();
    expect(misconfigLogs()).toEqual([
      {
        event: 'auth_statement_timeout_misconfigured',
        settingMs: TEST_ROLE_STATEMENT_TIMEOUT_MS,
        enforced: false,
      },
    ]);
  });
});
