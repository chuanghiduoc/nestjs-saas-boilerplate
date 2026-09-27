import { describe, expect, inject, it } from 'vitest';
import {
  assertCleanLogs,
  compose,
  logsSince,
  pgbouncerShow,
  psql,
  workerHealth,
} from './smoke-support.js';

describe('prod-like smoke: core', () => {
  const { apiUrl, startedAt } = inject('smoke');

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
  it('every connection to Postgres from an app role uses TLS (none plaintext)', () => {
    // Gồm cả kết nối trực tiếp của app (relay của worker → postgres) và chặng PgBouncer → postgres.
    const [total, plain, relay] = psql(
      `SELECT count(*), count(*) FILTER (WHERE NOT s.ssl), count(*) FILTER (WHERE a.usename = 'app_relay')
         FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid)
        WHERE a.usename IN ('app_user', 'app_relay', 'auth_user', 'app_owner')`,
    )
      .split('|')
      .map(Number);
    expect(plain).toBe(0);
    expect(relay).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(0);
  });
  it('every app connection to PgBouncer uses TLS (none plaintext)', () => {
    // Kết nối của chính api/worker tới PgBouncer (chặng mà pg_stat_ssl của Postgres không thấy); bỏ qua
    // phiên console `pgbouncer` của chính lệnh kiểm tra này.
    const clients = pgbouncerShow('CLIENTS').filter(
      (c) => c.database !== 'pgbouncer',
    );
    expect(clients.filter((c) => c.user === 'app_user').length).toBeGreaterThan(
      0,
    );
    expect(clients.filter((c) => !c.tls)).toEqual([]);
  });
  it('container logs since before boot have no error or non-JSON lines', () => {
    assertCleanLogs(logsSince(startedAt), []);
  });
});
