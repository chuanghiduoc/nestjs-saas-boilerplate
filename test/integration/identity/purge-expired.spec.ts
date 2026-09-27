import { Logger, Module, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    await owner.query(
      `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('x', 'v', now() - interval '1 hour'), ('y', 'v', now() + interval '1 hour')`,
    );
    await owner.query(
      `INSERT INTO auth.login_attempts (key, points, expire) VALUES ($1, 1, 1), ($2, 1, $3)`,
      [`old-${v7()}`, `new-${v7()}`, Date.now() + 3_600_000],
    );
    await owner.query(
      `INSERT INTO auth.rate_limit (key, count, last_request) VALUES ($1, 1, 1)`,
      [`rl-${v7()}`],
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
    const count = async (sql: string) =>
      (await owner.query<{ n: number }>(sql)).rows[0]!.n;
    expect(
      await count(
        `SELECT count(*)::int AS n FROM auth.session WHERE id = '${dead}'`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM auth.session WHERE id = '${live}'`,
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM auth.verification WHERE expires_at < now()`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM auth.login_attempts WHERE expire < ${Date.now()}`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM auth.rate_limit WHERE last_request = 1`,
      ),
    ).toBe(0);
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
    const id = v7();
    await owner.query(
      `INSERT INTO auth.verification (id, identifier, value, expires_at) VALUES ($1, 'renewal', 'v', now() - interval '1 day')`,
      [id],
    );
    await owner.query('BEGIN');
    try {
      await owner.query(
        `UPDATE auth.verification SET expires_at = now() + interval '1 day' WHERE id = $1`,
        [id],
      );
      await app.get(AuthHousekeeping).purgeExpired('verification', 1);
      await owner.query('COMMIT');
    } finally {
      await owner.query('ROLLBACK');
    }
    await app.get(AuthHousekeeping).purgeExpired('verification', 1);
    expect(
      (
        await owner.query(`SELECT id FROM auth.verification WHERE id = $1`, [
          id,
        ])
      ).rowCount,
    ).toBe(1);
  });
});
