import type { INestApplication } from '@nestjs/common';
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

  it('verification and reset keys hash the token; the same token never sends twice', async () => {
    const e = app.get(AuthEmails);
    const u = user();
    await e.verification({
      user: u,
      url: 'http://localhost:3000/api/auth/verify-email?token=t1',
      token: 't1',
    });
    await e.verification({
      user: u,
      url: 'http://localhost:3000/api/auth/verify-email?token=t1',
      token: 't1',
    });
    const k = await keys('verify-email:%');
    expect(k.filter((x) => x.includes('t1'))).toEqual([]);
    expect(new Set(k).size).toBe(k.length);
  });
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
