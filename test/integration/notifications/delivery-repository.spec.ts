import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { SecurityModule } from '../../../src/core/security/index.js';
import {
  transition,
  type DeliveryState,
} from '../../../src/modules/notifications/domain/email-delivery.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { DeliveryRepository } from '../../../src/modules/notifications/ports/delivery-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

const LEASE_MS = 20_000;
const COOLDOWN_SEC = 300;

/**
 * SQL của `SqlDeliveryRepository` (chạy bằng `app_user`) đi đúng state machine của domain và giữ mọi CHECK
 * của `email_deliveries` (Task 18): mỗi bước so trạng thái trong DB với `transition()`.
 */
describe('SqlDeliveryRepository', () => {
  let app: INestApplication;
  let owner: pg.Client;
  let repo: DeliveryRepository;

  const newDelivery = async (): Promise<string> => {
    const publicId = v7();
    const created = await repo.insert({
      publicId,
      template: 'verify-email',
      locale: 'en',
      recipientEnc: 'r',
      paramsEnc: 'p',
      idempotencyKey: `verify-email:${v7()}`,
    });
    expect(created).toBe(true);
    return publicId;
  };
  const row = async (publicId: string) => {
    const { rows } = await owner.query<{
      state: DeliveryState;
      attempts: number;
      params_enc: string | null;
      lease_owner: string | null;
      lease_until: Date | null;
      completed_at: Date | null;
      last_error_code: string | null;
      enqueue_generation: number;
    }>(
      'SELECT state, attempts, params_enc, lease_owner, lease_until, completed_at, last_error_code, enqueue_generation FROM email_deliveries WHERE public_id = $1',
      [publicId],
    );
    const r = rows[0];
    if (!r) throw new Error(`no row ${publicId}`);
    return r;
  };
  /** Làm lease hết hạn / lùi thời điểm như thể đã qua thời gian (chỉ owner mới sửa được các cột này trực tiếp). */
  const expireLease = (publicId: string) =>
    owner.query(
      `UPDATE email_deliveries SET lease_until = now() - interval '1 second' WHERE public_id = $1`,
      [publicId],
    );
  const ageEnqueue = (publicId: string) =>
    owner.query(
      `UPDATE email_deliveries SET last_enqueued_at = now() - make_interval(secs => $2 + 1) WHERE public_id = $1`,
      [publicId, COOLDOWN_SEC],
    );

  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }),
      EventsModule.forRoot({ worker: false }),
      SecurityModule,
      NotificationsModule.forApi(),
    ]);
    repo = app.get(DeliveryRepository, { strict: false });
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

  it('claim → complete: SENT with params wiped, completion time and no lease; a wrong owner is fenced out', async () => {
    const id = await newDelivery();
    const lease = v7();
    const claimed = await repo.claim(id, lease, LEASE_MS);
    expect(claimed).toEqual({
      publicId: id,
      template: 'verify-email',
      locale: 'en',
      recipientEnc: 'r',
      paramsEnc: 'p',
      attempts: 1,
    });
    const sending = await row(id);
    expect(sending.state).toBe(
      transition('PENDING', { type: 'CLAIM', leaseExpired: false }),
    );
    expect(sending.lease_owner).toBe(lease);
    expect(sending.lease_until).not.toBeNull();
    expect(await repo.status(id)).toEqual({ state: 'SENDING' });
    // Lease còn hạn: không ai claim được.
    expect(await repo.claim(id, v7(), LEASE_MS)).toBeUndefined();

    expect(await repo.complete(id, v7())).toBe(false);
    expect(await repo.complete(id, lease)).toBe(true);
    const sent = await row(id);
    expect(sent).toMatchObject({
      state: transition('SENDING', { type: 'SEND_OK' }),
      params_enc: null,
      lease_owner: null,
      lease_until: null,
      attempts: 1,
    });
    expect(sent.completed_at).not.toBeNull();
    expect(await repo.status(id)).toEqual({ state: 'SENT' });
    expect(await repo.claim(id, v7(), LEASE_MS)).toBeUndefined();
  });

  it('release → PENDING with both lease columns NULL and the error code; the next claim needs a fresh owner and counts attempt 2', async () => {
    const id = await newDelivery();
    const first = v7();
    await repo.claim(id, first, LEASE_MS);
    expect(await repo.release(id, v7(), 'SMTP_TRANSIENT')).toBe(false);
    expect(await repo.release(id, first, 'SMTP_TRANSIENT')).toBe(true);
    expect(await row(id)).toMatchObject({
      state: transition('SENDING', {
        type: 'TRANSIENT_FAILURE',
        finalAttempt: false,
      }),
      lease_owner: null,
      lease_until: null,
      last_error_code: 'SMTP_TRANSIENT',
      completed_at: null,
      params_enc: 'p',
    });
    const second = v7();
    expect((await repo.claim(id, second, LEASE_MS))?.attempts).toBe(2);
    expect((await row(id)).lease_owner).toBe(second);
  });

  it('an expired lease is re-claimed by a new owner; the stale owner can neither complete nor fail it', async () => {
    const id = await newDelivery();
    const stale = v7();
    await repo.claim(id, stale, LEASE_MS);
    await expireLease(id);
    expect(await repo.status(id)).toEqual({ state: 'SENDING' });
    const fresh = v7();
    expect((await repo.claim(id, fresh, LEASE_MS))?.attempts).toBe(2);
    expect((await row(id)).state).toBe(
      transition('SENDING', { type: 'CLAIM', leaseExpired: true }),
    );
    expect(await repo.complete(id, stale)).toBe(false);
    expect(await repo.fail(id, stale, 'SMTP_PERMANENT')).toBeUndefined();
    expect(await repo.fail(id, fresh, 'SMTP_PERMANENT')).toBe('verify-email');
    const failed = await row(id);
    expect(failed).toMatchObject({
      state: transition('SENDING', { type: 'PERMANENT_FAILURE' }),
      params_enc: null,
      lease_owner: null,
      lease_until: null,
      last_error_code: 'SMTP_PERMANENT',
    });
    expect(failed.completed_at).not.toBeNull();
  });

  it('fail without an SMTP code keeps the last recorded code', async () => {
    const id = await newDelivery();
    const a = v7();
    await repo.claim(id, a, LEASE_MS);
    await repo.release(id, a, 'SMTP_TIMEOUT');
    const b = v7();
    await repo.claim(id, b, LEASE_MS);
    expect(await repo.fail(id, b, null)).toBe('verify-email');
    expect(await row(id)).toMatchObject({
      state: 'FAILED',
      last_error_code: 'SMTP_TIMEOUT',
    });
  });

  it('two concurrent claims of one row: exactly one owner wins', async () => {
    const id = await newDelivery();
    const results = await Promise.all([
      repo.claim(id, v7(), LEASE_MS),
      repo.claim(id, v7(), LEASE_MS),
    ]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect((await row(id)).attempts).toBe(1);
  });

  it('status of an unknown delivery is undefined', async () => {
    expect(await repo.status(v7())).toBeUndefined();
    expect(await repo.claim(v7(), v7(), LEASE_MS)).toBeUndefined();
  });

  it('failExhausted fails a stuck row only once attempts reach the limit (PENDING and expired SENDING)', async () => {
    const pending = await newDelivery();
    const o = v7();
    await repo.claim(pending, o, LEASE_MS);
    await repo.release(pending, o, 'SMTP_CONNECTION');
    expect(await repo.failExhausted(pending, 2)).toBeUndefined();
    expect(await repo.failExhausted(pending, 1)).toBe('verify-email');
    const failed = await row(pending);
    expect(failed).toMatchObject({
      state: transition('PENDING', {
        type: 'ATTEMPTS_EXHAUSTED',
        leaseExpired: false,
      }),
      params_enc: null,
      lease_owner: null,
      attempts: 1,
    });
    expect(failed.completed_at).not.toBeNull();

    const sending = await newDelivery();
    await repo.claim(sending, v7(), LEASE_MS);
    expect(await repo.failExhausted(sending, 1)).toBeUndefined();
    await expireLease(sending);
    expect(await repo.failExhausted(sending, 1)).toBe('verify-email');
    expect((await row(sending)).state).toBe(
      transition('SENDING', { type: 'ATTEMPTS_EXHAUSTED', leaseExpired: true }),
    );
  });

  it('findStale + bumpGeneration: only after the cooldown, once per cooldown, even when two reconcilers race', async () => {
    const id = await newDelivery();
    expect(await repo.bumpGeneration(id, COOLDOWN_SEC, 10)).toBeUndefined();
    await ageEnqueue(id);
    const stale = await repo.findStale(COOLDOWN_SEC, 1000);
    expect(stale).toContainEqual({ publicId: id, attempts: 0 });
    const bumps = await Promise.all([
      repo.bumpGeneration(id, COOLDOWN_SEC, 10),
      repo.bumpGeneration(id, COOLDOWN_SEC, 10),
    ]);
    expect(bumps.filter((g) => g !== undefined)).toEqual([1]);
    expect((await row(id)).enqueue_generation).toBe(1);
    expect(await repo.bumpGeneration(id, COOLDOWN_SEC, 10)).toBeUndefined();
    expect(await repo.findStale(COOLDOWN_SEC, 1000)).not.toContainEqual({
      publicId: id,
      attempts: 0,
    });
  });

  it('bumpGeneration refuses to bump past maxAttempts even when stuck and past cooldown (FB: bounded overshoot)', async () => {
    const id = await newDelivery();
    const o = v7();
    await repo.claim(id, o, LEASE_MS);
    await repo.release(id, o, null); // PENDING lại, attempts = 1
    await ageEnqueue(id);
    expect(await repo.findStale(COOLDOWN_SEC, 1000)).toContainEqual({
      publicId: id,
      attempts: 1,
    });
    // attempts (1) không < maxAttempts (1): dù đang kẹt và đã qua cooldown, không bump — dòng phải rơi vào
    // failExhausted ở caller (ReconcileDeliveriesHandler), không bị bỏ kẹt vô thời hạn.
    expect(await repo.bumpGeneration(id, COOLDOWN_SEC, 1)).toBeUndefined();
    expect((await row(id)).enqueue_generation).toBe(0);
    expect(await repo.bumpGeneration(id, COOLDOWN_SEC, 2)).toBe(1);
  });

  it('purge deletes only terminal rows past retention', async () => {
    const old = await newDelivery();
    const o = v7();
    await repo.claim(old, o, LEASE_MS);
    await repo.complete(old, o);
    const pendingOld = await newDelivery();
    await owner.query(
      `UPDATE email_deliveries SET created_at = now() - interval '31 days' WHERE public_id = ANY($1)`,
      [[old, pendingOld]],
    );
    expect(await repo.purge(30, 1000)).toBeGreaterThanOrEqual(1);
    const { rows } = await owner.query<{ public_id: string }>(
      'SELECT public_id FROM email_deliveries WHERE public_id = ANY($1)',
      [[old, pendingOld]],
    );
    expect(rows.map((r) => r.public_id)).toEqual([pendingOld]);
  });
});
