import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { AuthEmails } from '../../../src/modules/identity/application/auth-emails.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { Module } from '@nestjs/common';

@Module({ providers: [AuthEmails] })
class M {}
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const user = () => ({
  id: v7(),
  email: `e-${v7()}@example.test`,
  name: 'E',
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('AuthEmails idempotency keys (spec §5.8, §5.11)', () => {
  let app: INestApplication;
  let owner: pg.Client;
  const keys = async (like: string) =>
    (
      await owner.query(
        `SELECT idempotency_key FROM email_deliveries WHERE idempotency_key LIKE $1`,
        [like],
      )
    ).rows.map((r) => r.idempotency_key);
  beforeAll(async () => {
    vi.stubEnv('AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC', '3600');
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }),
      EventsModule.forRoot({ worker: false }),
      NotificationsModule.forApi(),
      M,
    ]);
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
    vi.unstubAllEnvs();
  });

  /** Số dòng + số job hoãn trong outbox của đúng một key (review I1: UNIQUE thôi không chứng minh dedupe). */
  const deliveriesAndJobs = async (key: string) => {
    const rows = await owner.query(
      'SELECT count(*)::int AS n FROM email_deliveries WHERE idempotency_key = $1',
      [key],
    );
    const jobs = await owner.query(
      `SELECT count(*)::int AS n FROM outbox_events o JOIN email_deliveries d ON d.public_id::text = o.payload->'payload'->>'deliveryId'
        WHERE o.type = 'core.job.deferred' AND d.idempotency_key = $1`,
      [key],
    );
    return { deliveries: rows.rows[0].n, jobs: jobs.rows[0].n };
  };

  it.each([
    ['verification', 'verify-email'],
    ['reset', 'reset-password'],
  ] as const)(
    '%s: key is <template>:sha256(token); the same token yields one delivery and one job, a new token another',
    async (method, template) => {
      const e = app.get(AuthEmails);
      const u = user();
      const token = `tok-${v7()}`;
      const other = `tok-${v7()}`;
      const url = (t: string) =>
        `http://localhost:3000/api/auth/${template}?token=${t}`;
      await e[method]({ user: u, url: url(token), token });
      await e[method]({ user: u, url: url(token), token });
      await e[method]({ user: u, url: url(other), token: other });
      expect(await deliveriesAndJobs(`${template}:${sha256(token)}`)).toEqual({
        deliveries: 1,
        jobs: 1,
      });
      expect(await deliveriesAndJobs(`${template}:${sha256(other)}`)).toEqual({
        deliveries: 1,
        jobs: 1,
      });
      const all = await owner.query(
        'SELECT idempotency_key FROM email_deliveries WHERE idempotency_key LIKE $1 AND idempotency_key LIKE $2',
        [`${template}:%`, `%${token}%`],
      );
      expect(all.rows).toEqual([]);
    },
  );
  it('at most one "account exists" notice per user per window', async () => {
    const e = app.get(AuthEmails);
    const u = user();
    await e.existingAccount({ user: u });
    await e.existingAccount({ user: u });
    expect(await keys(`existing-account:${u.id}:%`)).toHaveLength(1);
  });
  it('2FA change notice is keyed by user, session and direction', async () => {
    const e = app.get(AuthEmails);
    const u = user();
    await e.twoFactorChanged(u, 's1', true);
    await e.twoFactorChanged(u, 's1', true);
    await e.twoFactorChanged(u, 's1', false);
    expect(
      (await keys(`two-factor-changed:${u.id}:%`)).sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual([
      `two-factor-changed:${u.id}:s1:disabled`,
      `two-factor-changed:${u.id}:s1:enabled`,
    ]);
  });
});
