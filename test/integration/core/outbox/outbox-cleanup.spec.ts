import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import {
  DatabaseModule,
  RelayDb,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  Inbox,
  OutboxCleanupHandler,
  OutboxModule,
  OutboxWriter,
  outboxConfig,
} from '../../../../src/core/outbox/index.js';
import { QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';

const BATCH = 3;
const MAX_BATCHES = 2;

describe('outbox cleanup', () => {
  let app: INestApplication;
  let relayDb: RelayDb;
  /** app_relay không có UPDATE trên processed_events (đúng least privilege); lùi thời gian bằng owner. */
  let owner: pg.Client;
  beforeAll(async () => {
    const infra = getInfra();
    owner = new pg.Client({
      host: infra.pg.host,
      port: infra.pg.port,
      database: infra.pg.database,
      user: infra.pg.owner.user,
      password: infra.pg.owner.password,
    });
    await owner.connect();
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('OUTBOX_AUTOSTART', 'false');
    vi.stubEnv('WORKER_QUEUES', 'maintenance');
    vi.stubEnv('OUTBOX_CLEANUP_BATCH_SIZE', String(BATCH));
    vi.stubEnv('OUTBOX_CLEANUP_MAX_BATCHES', String(MAX_BATCHES));
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: true }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: true }),
    ]);
    relayDb = app.get(RelayDb);
  });
  afterAll(async () => {
    await owner.end();
    await app.close();
    vi.unstubAllEnvs();
  });

  const append = (ids: string[]) =>
    app.get(UnitOfWork).run(async () => {
      for (const id of ids)
        await app.get(OutboxWriter).append({
          eventId: id,
          type: 'test.thing.happened',
          version: 1,
          orgId: null,
          aggregate: { type: 't', id: '1', version: 1 },
          payload: {},
          headers: {},
        });
    });
  const remaining = async (ids: string[]) =>
    (
      await relayDb.execute<{ event_id: string }>(
        'SELECT event_id FROM outbox_events WHERE event_id IN (?) ORDER BY event_id',
        [ids],
      )
    ).map((r) => r.event_id);

  it('deletes only published rows older than retention, in bounded batches; never unpublished or parked rows', async () => {
    const olds = Array.from({ length: 7 }, () => v7());
    const fresh = v7();
    const unpublishedOld = v7();
    const parkedOld = v7();
    await append([...olds, fresh, unpublishedOld, parkedOld]);
    await relayDb.execute(
      `UPDATE outbox_events SET published_at = now() - interval '30 days' WHERE event_id IN (?)`,
      [olds],
    );
    await relayDb.execute(
      `UPDATE outbox_events SET published_at = now() WHERE event_id = ?`,
      [fresh],
    );
    const maxAttempts = app.get<{ maxPublishAttempts: number }>(
      outboxConfig.KEY,
    ).maxPublishAttempts;
    await relayDb.execute(
      `UPDATE outbox_events SET occurred_at = now() - interval '60 days', created_at = now() - interval '60 days' WHERE event_id IN (?)`,
      [[unpublishedOld, parkedOld]],
    );
    await relayDb.execute(
      `UPDATE outbox_events SET publish_attempts = ? WHERE event_id = ?`,
      [maxAttempts, parkedOld],
    );
    const all = [...olds, fresh, unpublishedOld, parkedOld];

    // Một lần chạy xoá tối đa BATCH * MAX_BATCHES dòng; phần còn lại để lần sau.
    const first = await app.get(OutboxCleanupHandler).handle();
    expect(first.outboxDeleted).toBe(BATCH * MAX_BATCHES);
    expect(await remaining(all)).toHaveLength(4);

    const second = await app.get(OutboxCleanupHandler).handle();
    expect(second.outboxDeleted).toBe(1);
    expect(await remaining(all)).toEqual(
      [fresh, unpublishedOld, parkedOld].sort(),
    );
  });

  it('deletes inbox records older than inbox retention only', async () => {
    const oldId = v7();
    const freshId = v7();
    await app.get(UnitOfWork).run(async () => {
      await app.get(Inbox).once('test.cleanup', oldId, async () => {});
      await app.get(Inbox).once('test.cleanup', freshId, async () => {});
    });
    await owner.query(
      `UPDATE processed_events SET processed_at = now() - interval '400 days' WHERE event_id = $1`,
      [oldId],
    );
    const r = await app.get(OutboxCleanupHandler).handle();
    expect(r.inboxDeleted).toBeGreaterThanOrEqual(1);
    const left = await relayDb.execute<{ event_id: string }>(
      `SELECT event_id FROM processed_events WHERE consumer = 'test.cleanup' AND event_id IN (?)`,
      [[oldId, freshId]],
    );
    expect(left.map((x) => x.event_id)).toEqual([freshId]);
  });
});
