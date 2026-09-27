import { describe, expect, inject, it } from 'vitest';
import {
  assertCleanLogs,
  compose,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

describe('prod-like smoke: core', () => {
  const since = new Date().toISOString();
  const { apiUrl } = inject('smoke');

  it('api is live and ready; worker container is healthy', async () => {
    expect((await fetch(`${apiUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
  });
  it('migrations are applied (status lists nothing pending)', () => {
    expect(
      compose([
        'run',
        '--rm',
        '--no-deps',
        'migrate',
        'dist/main.migrate.js',
        'status',
      ]),
    ).toContain('"migrations":[]');
  });
  it('production rules are enforced: a DB TLS mode other than verify-full refuses to start', () => {
    expect(() =>
      compose([
        'run',
        '--rm',
        '--no-deps',
        '-e',
        'DB_SSL_MODE=require',
        'migrate',
        'dist/main.migrate.js',
        'status',
      ]),
    ).toThrow(/DB_SSL_MODE must be verify-full in production/);
  });
  it('app connections to Postgres use TLS', () => {
    const n = Number(
      psql(
        `SELECT count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename IN ('app_relay', 'app_user') AND s.ssl`,
      ),
    );
    expect(n).toBeGreaterThan(0);
  });
  it('container logs have no error lines', () => {
    assertCleanLogs(logsSince(since), []);
  });
});
