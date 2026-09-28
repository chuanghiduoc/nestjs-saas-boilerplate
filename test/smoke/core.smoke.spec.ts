import { randomInt, randomUUID } from 'node:crypto';
import { describe, expect, inject, it, vi } from 'vitest';
import { SMOKE_BASE_URL } from './smoke-app-env.js';
import {
  assertCleanLogs,
  compose,
  logsSince,
  pgbouncerShow,
  psql,
  workerHealth,
} from './smoke-support.js';

/**
 * Hạn chờ client `app_user` xuất hiện trong `SHOW CLIENTS` sau request tạo traffic: dưới `idleTimeoutMillis` mặc định
 * của pg-pool (10 s, pool core không đặt), vì quá mốc đó client rảnh bị đóng và không còn gì để thấy.
 */
const PGBOUNCER_CLIENT_WAIT_MS = 8_000;

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
  it('every app connection to PgBouncer uses TLS (none plaintext)', async () => {
    // Pool core `app_user` có `min: 0` và `idleTimeoutMillis` mặc định của pg-pool (10 s), còn probe readiness dùng
    // client riêng rồi đóng: không có request thật thì api/worker không giữ client nào ở PgBouncer. Tự tạo traffic
    // `app_user` qua PgBouncer: sign-up ghi event `identity.user.registered` vào outbox bằng `uow.run` của pool core
    // (api), rồi worker gửi thư cũng qua pool đó.
    const signUp = await fetch(`${apiUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: SMOKE_BASE_URL,
        'x-forwarded-for': `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`,
      },
      body: JSON.stringify({
        email: `core-${randomUUID()}@example.test`,
        password: 'smoke correct horse battery',
        name: 'Core smoke',
      }),
    });
    expect(signUp.status).toBe(202);
    // Kết nối của chính api/worker tới PgBouncer (chặng mà pg_stat_ssl của Postgres không thấy); bỏ qua
    // phiên console `pgbouncer` của chính lệnh kiểm tra này. Poll có hạn: client vừa dùng còn rảnh trong pool tới
    // `idleTimeoutMillis`, nên hạn chờ nằm dưới mốc đó.
    const clients = await vi.waitFor(
      () => {
        const snapshot = pgbouncerShow('CLIENTS').filter(
          (c) => c.database !== 'pgbouncer',
        );
        expect(
          snapshot.filter((c) => c.user === 'app_user').length,
        ).toBeGreaterThan(0);
        return snapshot;
      },
      { timeout: PGBOUNCER_CLIENT_WAIT_MS, interval: 0 },
    );
    expect(clients.filter((c) => !c.tls)).toEqual([]);
  });
  it('container logs since before boot have no error or non-JSON lines', () => {
    assertCleanLogs(logsSince(startedAt), []);
  });
});
