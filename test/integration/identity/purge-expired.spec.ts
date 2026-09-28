import { Logger, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PurgeExpiredHandler } from '../../../src/modules/identity/application/purge-expired.handler.js';
import { authPoolProviders } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { PgAuthHousekeeping } from '../../../src/modules/identity/infra/better-auth/pg-auth-housekeeping.js';
import { AuthHousekeeping } from '../../../src/modules/identity/ports/auth-housekeeping.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

@Module({
  providers: [
    ...authPoolProviders,
    PgAuthHousekeeping,
    { provide: AuthHousekeeping, useExisting: PgAuthHousekeeping },
    PurgeExpiredHandler,
  ],
})
class M {}

describe('identity.purge-expired', () => {
  let app: INestApplication;
  let owner: pg.Client;
  beforeAll(async () => {
    app = await createTestApp([M]);
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
  });

  it('deletes expired sessions, verifications, rate limit and lockout rows; keeps live ones', async () => {
    const user = (
      await owner.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, created_at, updated_at) VALUES ('P', $1, true, now(), now()) RETURNING id`,
        [`p-${v7()}@example.test`],
      )
    ).rows[0]!.id;
    const live = v7();
    const dead = v7();
    await owner.query(
      `INSERT INTO auth.session (id, token, user_id, expires_at, updated_at) VALUES ($1::uuid, $1::uuid::text, $3::uuid, now() + interval '1 day', now()), ($2::uuid, $2::uuid::text, $3::uuid, now() - interval '1 day', now())`,
      [live, dead, user],
    );
    // review M3: id/key riêng cho từng dòng chèn, để assertion không đọc lẫn dòng còn sót của các test/file
    // khác đang chạy trên cùng Postgres (DB dùng chung giữa các file integration, xem test/support/infra.ts).
    const verDead = v7();
    const verLive = v7();
    await owner.query(
      `INSERT INTO auth.verification (id, identifier, value, expires_at) VALUES ($1, 'x', 'v', now() - interval '1 hour'), ($2, 'y', 'v', now() + interval '1 hour')`,
      [verDead, verLive],
    );
    const oldKey = `old-${v7()}`;
    const newKey = `new-${v7()}`;
    await owner.query(
      `INSERT INTO auth.login_attempts (key, points, expire) VALUES ($1, 1, 1), ($2, 1, $3)`,
      [oldKey, newKey, Date.now() + 3_600_000],
    );
    const rlKey = `rl-${v7()}`;
    await owner.query(
      `INSERT INTO auth.rate_limit (key, count, last_request) VALUES ($1, 1, 1)`,
      [rlKey],
    );
    await app.get(PurgeExpiredHandler).handle({
      payload: {},
      meta: {},
      jobId: v7(),
      attempt: 1,
      maxAttempts: 1,
      signal: new AbortController().signal,
      log: new Logger('t'),
    });
    const exists = async (table: string, column: string, value: string) =>
      (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
          [value],
        )
      ).rows[0]!.n;
    expect(await exists('auth.session', 'id', dead)).toBe(0);
    expect(await exists('auth.session', 'id', live)).toBe(1);
    expect(await exists('auth.verification', 'id', verDead)).toBe(0);
    expect(await exists('auth.verification', 'id', verLive)).toBe(1);
    expect(await exists('auth.login_attempts', 'key', oldKey)).toBe(0);
    expect(await exists('auth.login_attempts', 'key', newKey)).toBe(1);
    expect(await exists('auth.rate_limit', 'key', rlKey)).toBe(0);
  });
  it('bounds each statement and preserves live rate limits and non-expiring lockouts', async () => {
    const housekeeping = app.get(AuthHousekeeping);
    const expired = [v7(), v7()];
    const live = v7();
    const permanent = v7();
    await owner.query(
      `INSERT INTO auth.verification (id, identifier, value, expires_at)
      VALUES ($1, 'bounded', 'v', now() - interval '1 day'),
             ($2, 'bounded', 'v', now() - interval '1 day'),
             ($3, 'live', 'v', now() + interval '1 day')`,
      [...expired, live],
    );
    expect(await housekeeping.purgeExpired('verification', 1)).toBe(1);
    const remaining = await owner.query<{ id: string }>(
      `SELECT id FROM auth.verification WHERE id = ANY($1::uuid[])`,
      [[...expired, live]],
    );
    expect(remaining.rows).toHaveLength(2);
    expect(remaining.rows).toContainEqual({ id: live });
    await owner.query(
      `INSERT INTO auth.rate_limit (id, key, count, last_request) VALUES ($1::uuid, $1::uuid::text, 1, $2)`,
      [live, Date.now()],
    );
    await owner.query(
      `INSERT INTO auth.login_attempts (key, points, expire) VALUES ($1, 1, NULL), ($2, 1, $3)`,
      [permanent, live, Date.now() + 3_600_000],
    );
    await housekeeping.purgeExpired('rate_limit', 1);
    await housekeeping.purgeExpired('login_attempts', 1);
    expect(
      (
        await owner.query(`SELECT id FROM auth.rate_limit WHERE id = $1`, [
          live,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await owner.query(
          `SELECT key FROM auth.login_attempts WHERE key = ANY($1::text[])`,
          [[permanent, live]],
        )
      ).rowCount,
    ).toBe(2);
  });

  it('skips a verification being renewed and preserves it after renewal commits', async () => {
    // review I2: dòng renewal phải là dòng expired DUY NHẤT trong bảng lúc purge chạy trong transaction,
    // nếu không LIMIT 1 của victim CTE có thể chọn một dòng leftover khác (của test trước, hay của file
    // integration khác trên cùng Postgres) và "pass" mà không hề chạm tới dòng đang bị khoá — test không
    // còn chứng minh được gì về SKIP LOCKED hay điều kiện re-check trong DELETE.
    let purged = 100;
    while (purged >= 100) {
      purged = await app
        .get(AuthHousekeeping)
        .purgeExpired('verification', 100);
    }
    const id = v7();
    await owner.query(
      `INSERT INTO auth.verification (id, identifier, value, expires_at) VALUES ($1, 'renewal', 'v', now() - interval '1 day')`,
      [id],
    );
    await owner.query('BEGIN');
    let committed = false;
    let skippedWhileLocked = -1;
    try {
      await owner.query(
        `UPDATE auth.verification SET expires_at = now() + interval '1 day' WHERE id = $1`,
        [id],
      );
      // `owner` giữ khoá dòng chưa commit; PurgeExpiredHandler dùng pool AUTH_POOL (kết nối khác), nên
      // đây là race thật: victim CTE thấy dòng còn khớp `expires_at < now()` (snapshot read committed
      // trước UPDATE) nhưng bị khoá → SKIP LOCKED phải bỏ qua, không chờ và không xoá.
      skippedWhileLocked = await app
        .get(AuthHousekeeping)
        .purgeExpired('verification', 1);
      await owner.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await owner.query('ROLLBACK');
    }
    // Dòng đang bị khoá là dòng expired duy nhất còn lại lúc gọi; skip đúng nghĩa thì trả về 0 dòng xoá.
    expect(skippedWhileLocked).toBe(0);
    await app.get(AuthHousekeeping).purgeExpired('verification', 1);
    expect(
      (
        await owner.query(`SELECT id FROM auth.verification WHERE id = $1`, [
          id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('purge cutoff also covers window Better Auth applies by default, not just our four configured windows (Task 33 review M10)', async () => {
    // Better Auth 1.7.6 áp cửa sổ này cho path chưa có customRule dù mọi cửa sổ tự cấu hình ngắn hơn
    // (node_modules/better-auth/dist/api/rate-limiter/index.mjs:302-315: window 60 cho
    // /request-password-reset, /send-verification-email, /forget-password*, /email-otp/*).
    vi.stubEnv('AUTH_RATE_LIMIT_WINDOW_SEC', '5');
    vi.stubEnv('AUTH_SIGNIN_RATE_WINDOW_SEC', '5');
    vi.stubEnv('AUTH_TWO_FACTOR_RATE_WINDOW_SEC', '5');
    vi.stubEnv('AUTH_EMAIL_RATE_WINDOW_SEC', '5');
    let lowWindowApp: INestApplication | undefined;
    try {
      lowWindowApp = await createTestApp([M]);
      const housekeeping = lowWindowApp.get(AuthHousekeeping);
      // 40s cũ: quá cửa sổ tự cấu hình (5s) nhưng còn trong cửa sổ mặc định 60s của Better Auth. Code cũ
      // (cutoff = max(4 cửa sổ tự cấu hình), không có mặc định lẫn biên an toàn) sẽ xoá nhầm dòng này.
      const insideDefaultWindow = v7();
      // 10 phút cũ: vượt cả cửa sổ mặc định (60s) cộng biên an toàn (60s) → vẫn phải bị xoá như thường.
      const outsideEverything = v7();
      await owner.query(
        `INSERT INTO auth.rate_limit (id, key, count, last_request)
         VALUES ($1::uuid, $1::uuid::text, 1, $3), ($2::uuid, $2::uuid::text, 1, $4)`,
        [
          insideDefaultWindow,
          outsideEverything,
          Date.now() - 40_000,
          Date.now() - 10 * 60_000,
        ],
      );
      await housekeeping.purgeExpired('rate_limit', 10);
      expect(
        (
          await owner.query(`SELECT id FROM auth.rate_limit WHERE id = $1`, [
            insideDefaultWindow,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await owner.query(`SELECT id FROM auth.rate_limit WHERE id = $1`, [
            outsideEverything,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await lowWindowApp?.close();
      vi.unstubAllEnvs();
    }
  });

  it('purge cutoff covers the /verify-email window (AUTH_VERIFY_EMAIL_RATE_WINDOW_SEC), so an active limiter row is never purged', async () => {
    const shortWindowSec = '5';
    const verifyWindowMinutes = 30;
    vi.stubEnv('AUTH_RATE_LIMIT_WINDOW_SEC', shortWindowSec);
    vi.stubEnv('AUTH_SIGNIN_RATE_WINDOW_SEC', shortWindowSec);
    vi.stubEnv('AUTH_TWO_FACTOR_RATE_WINDOW_SEC', shortWindowSec);
    vi.stubEnv('AUTH_EMAIL_RATE_WINDOW_SEC', shortWindowSec);
    vi.stubEnv(
      'AUTH_VERIFY_EMAIL_RATE_WINDOW_SEC',
      String(verifyWindowMinutes * 60),
    );
    let longVerifyApp: INestApplication | undefined;
    try {
      longVerifyApp = await createTestApp([M]);
      const housekeeping = longVerifyApp.get(AuthHousekeeping);
      // 20 min old: past every other window (and Better Auth's 60s defaults + margin), still inside the
      // 30 min /verify-email window → must survive.
      const insideVerifyWindow = v7();
      // 40 min old: past the /verify-email window plus the safety margin → purged.
      const outsideVerifyWindow = v7();
      await owner.query(
        `INSERT INTO auth.rate_limit (id, key, count, last_request)
         VALUES ($1::uuid, $1::uuid::text, 1, $3), ($2::uuid, $2::uuid::text, 1, $4)`,
        [
          insideVerifyWindow,
          outsideVerifyWindow,
          Date.now() - 20 * 60_000,
          Date.now() - 40 * 60_000,
        ],
      );
      await housekeeping.purgeExpired('rate_limit', 10);
      const exists = async (id: string) =>
        (
          await owner.query(`SELECT id FROM auth.rate_limit WHERE id = $1`, [
            id,
          ])
        ).rowCount;
      expect(await exists(insideVerifyWindow)).toBe(1);
      expect(await exists(outsideVerifyWindow)).toBe(0);
    } finally {
      await longVerifyApp?.close();
      vi.unstubAllEnvs();
    }
  });
});
