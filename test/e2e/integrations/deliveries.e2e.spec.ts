import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import {
  endpointsUrl,
  startIntegrationsApp,
} from '../../support/integrations-app.js';
import {
  deliveryRow,
  receiverEnv,
  runDeliver,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import { raceOnRowLock } from '../../support/integrations-races.js';
import {
  inOrg,
  insertDelivery,
  insertMessage,
  orgQuery,
} from '../../support/integrations-seed.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../../support/webhook-receiver.js';

const PAGE = 2;
const idem = () => `k-${v7()}`;

describe('deliveries API (spec SP6 §8.3 "Dead-letter", "Gửi thử", §9.2)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  const deliveriesUrl = (id: string) =>
    `/v1/orgs/${org.orgId}/webhook-deliveries/${id}`;
  const jobIdsOf = async (deliveryId: string) =>
    (
      await ownerQuery<{ payload: { jobId: string } }>(
        `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2 ORDER BY id`,
        [org.orgId, deliveryId],
      )
    ).map((j) => j.payload.jobId);
  const terminal = async (
    status: 'EXHAUSTED' | 'CANCELLED' | 'SUCCEEDED',
    attempts = 3,
  ) => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET status = $2, next_attempt_at = NULL, attempts_total = $3, completed_at = now(),
         last_error = CASE WHEN $2 = 'SUCCEEDED' THEN NULL ELSE 'SERVER_ERROR' END WHERE public_id = $1`,
      [d.deliveryId, status, attempts],
    );
    return d;
  };
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({
      env: {
        ...receiverEnv(receiver),
        INTEGRATIONS_RECOVER_BATCH_MAX: String(PAGE),
        // 4C: R6-14 khẳng định retry ∥ recover không deadlock; tắt retry của UnitOfWork để một 40P01 thật làm ca đỏ.
        DB_TX_RETRY_ATTEMPTS: '0',
      },
    });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  beforeEach(() => {
    receiver.requests.length = 0;
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it('GET a delivery: resource fields; attempts and errors; 404 for a malformed or unknown id', async () => {
    const d = await terminal('EXHAUSTED', 8);
    const res = await authed(app, owner).get(deliveriesUrl(d.deliveryId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: d.deliveryId,
      endpointId: d.endpoint.publicId,
      eventType: 'tenancy.org.updated',
      status: 'EXHAUSTED',
      attempts: 8,
      lastError: 'SERVER_ERROR',
      nextAttemptAt: null,
    });
    expect(res.body.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await authed(app, owner).get(deliveriesUrl('nope'))).status).toBe(
      404,
    );
    expect((await authed(app, owner).get(deliveriesUrl(v7()))).status).toBe(
      404,
    );
  });
  it('list: newest first, cursor pages without gaps or repeats, ?status filters; Review Focus 5: a tampered cursor is 400 invalid_cursor, never 500', async () => {
    const first = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    await inOrg(org.orgId, async (c) => {
      for (let i = 0; i < 4; i++)
        await insertDelivery(c, org.orgId, {
          endpoint: first.endpoint,
          message: await insertMessage(c, org.orgId),
        });
    });
    const base = `${endpointsUrl(org.orgId)}/${first.endpoint.publicId}/deliveries`;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await authed(app, owner).get(
        `${base}?limit=${PAGE}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((x: { id: string }) => x.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const all = await orgQuery<{ public_id: string }>(
      org.orgId,
      `SELECT public_id::text FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC, public_id DESC`,
      [first.endpoint.id],
    );
    expect(seen).toEqual(all.map((r) => r.public_id));
    const pending = await authed(app, owner).get(`${base}?status=PENDING`);
    expect(pending.body.data).toHaveLength(5);
    expect(
      (await authed(app, owner).get(`${base}?status=SUCCEEDED`)).body.data,
    ).toEqual([]);
    for (const bad of [
      '%%%',
      Buffer.from('[1,2]').toString('base64url'),
      Buffer.from('["2026-10-07T00:00:00.000000Z","x"]').toString('base64url'),
      // m-1: năm 0000 tới Postgres là 22008 (500) nếu không chặn trước.
      Buffer.from(
        JSON.stringify([
          '0000-01-01T00:00:00.000000Z',
          '0199a000-0000-7000-8000-000000000001',
        ]),
      ).toString('base64url'),
    ]) {
      const res = await authed(app, owner).get(
        `${base}?cursor=${encodeURIComponent(bad)}`,
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
    }
  });
  it('W-12 + R-X35: retry of an EXHAUSTED delivery starts a new cycle (cycle_base = attempts_total, local_failures = 0) and queues a<n+1>; it then succeeds', async () => {
    const d = await terminal('EXHAUSTED', 8);
    // Như một delivery hết vì lỗi của ta (R-X35): phát lại phải trả lại đủ INTEGRATIONS_MAX_LOCAL_FAILURES lần.
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET local_failures = 5, last_error = 'BULKHEAD_FULL' WHERE public_id = $1`,
      [d.deliveryId],
    );
    const res = await authed(app, owner)
      .post(`${deliveriesUrl(d.deliveryId)}/retry`)
      .set('idempotency-key', idem())
      .send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'PENDING',
      attempts_total: 8,
      cycle_base: 8,
      local_failures: 0,
      completed_at: null,
    });
    expect(await jobIdsOf(d.deliveryId)).toEqual([
      `webhook-${d.deliveryId}-a9`,
    ]);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'SUCCEEDED',
      attempts_total: 9,
    });
  });
  it('R6-13: retry of a PENDING or SENDING delivery is 409 webhook_delivery_not_retryable; of a disabled endpoint 409 webhook_endpoint_disabled', async () => {
    const pending = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    const r1 = await authed(app, owner)
      .post(`${deliveriesUrl(pending.deliveryId)}/retry`)
      .set('idempotency-key', idem())
      .send();
    expect([r1.status, r1.body.code]).toEqual([
      409,
      'webhook_delivery_not_retryable',
    ]);
    const dead = await terminal('CANCELLED');
    await orgQuery(
      org.orgId,
      `UPDATE webhook_endpoints SET status = 'DISABLED', disabled_reason = 'MANUAL' WHERE id = $1`,
      [dead.endpoint.id],
    );
    const r2 = await authed(app, owner)
      .post(`${deliveriesUrl(dead.deliveryId)}/retry`)
      .set('idempotency-key', idem())
      .send();
    expect([r2.status, r2.body.code]).toEqual([
      409,
      'webhook_endpoint_disabled',
    ]);
  });
  it('W-13: recover requeues EXHAUSTED/CANCELLED since a date in batches of INTEGRATIONS_RECOVER_BATCH_MAX with hasMore; SUCCEEDED and older ones stay', async () => {
    const a = await terminal('EXHAUSTED');
    const endpoint = a.endpoint;
    const extra = await inOrg(org.orgId, async (c) => {
      const ids: string[] = [];
      for (const status of ['CANCELLED', 'EXHAUSTED', 'SUCCEEDED']) {
        const { publicId } = await insertDelivery(c, org.orgId, {
          endpoint,
          message: await insertMessage(c, org.orgId),
        });
        await c.query(
          `UPDATE webhook_deliveries SET status = $2, next_attempt_at = NULL, attempts_total = 1, completed_at = now(),
             last_error = CASE WHEN $2 = 'SUCCEEDED' THEN NULL ELSE 'SERVER_ERROR' END WHERE public_id = $1`,
          [publicId, status],
        );
        ids.push(publicId);
      }
      return ids;
    });
    const url = `${endpointsUrl(org.orgId)}/${endpoint.publicId}/recover`;
    const since = new Date(Date.now() - 3600_000).toISOString();
    const p1 = await authed(app, owner)
      .post(url)
      .set('idempotency-key', idem())
      .send({ since });
    expect(p1.status).toBe(200);
    expect(p1.body).toEqual({ requeued: PAGE, hasMore: true });
    const p2 = await authed(app, owner)
      .post(url)
      .set('idempotency-key', idem())
      .send({ since });
    expect(p2.body).toEqual({ requeued: 1, hasMore: false });
    expect((await deliveryRow(org.orgId, extra[2] ?? '')).status).toBe(
      'SUCCEEDED',
    );
    const future = await authed(app, owner)
      .post(url)
      .set('idempotency-key', idem())
      .send({ since: new Date(Date.now() + 3600_000).toISOString() });
    expect(future.body).toEqual({ requeued: 0, hasMore: false });
    // m-2 (review cuối 6C): năm 0000 hợp lệ với z.iso.datetime nhưng Postgres từ chối (22008): phải là 422, không 500.
    const year0 = await authed(app, owner)
      .post(url)
      .set('idempotency-key', idem())
      .send({ since: '0000-01-01T00:00:00Z' });
    expect([year0.status, year0.body.code]).toEqual([422, 'validation_failed']);
  });
  it('R6-14: a retry queued on the delivery row and a recover running meanwhile move it exactly once', async () => {
    const d = await terminal('EXHAUSTED');
    const since = new Date(Date.now() - 3600_000).toISOString();
    // Một người chờ: `retry` xếp hàng trên CAS của dòng; `recover` gặp `SKIP LOCKED` nên chạy xong ngay, bỏ qua dòng đang bị khoá.
    const [retry, recover] = await raceOnRowLock(
      org.orgId,
      `SELECT 1 FROM webhook_deliveries WHERE public_id = $1 FOR UPDATE`,
      [d.deliveryId],
      1,
      () =>
        Promise.all([
          authed(app, owner)
            .post(`${deliveriesUrl(d.deliveryId)}/retry`)
            .set('idempotency-key', idem())
            .send(),
          authed(app, owner)
            .post(`${endpointsUrl(org.orgId)}/${d.endpoint.publicId}/recover`)
            .set('idempotency-key', idem())
            .send({ since }),
        ]),
    );
    const moved = (retry.status === 200 ? 1 : 0) + (recover.body.requeued ?? 0);
    expect(moved).toBe(1);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'PENDING',
      cycle_base: 3,
    });
    expect(await jobIdsOf(d.deliveryId)).toEqual([
      `webhook-${d.deliveryId}-a4`,
    ]);
  });
  it('W-16: POST …/test creates a webhook.test message and delivery (201 + Location), the receiver gets data.endpointId', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    const res = await authed(app, owner)
      .post(`${endpointsUrl(org.orgId)}/${d.endpoint.publicId}/test`)
      .set('idempotency-key', idem())
      .send();
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(deliveriesUrl(res.body.id));
    expect(res.body).toMatchObject({
      eventType: 'webhook.test',
      status: 'PENDING',
      endpointId: d.endpoint.publicId,
    });
    await runDeliver(app, org.orgId, res.body.id);
    const [req] = await receiver.waitFor(1);
    expect(JSON.parse(req?.body ?? '{}')).toMatchObject({
      type: 'webhook.test',
      version: 1,
      data: { endpointId: d.endpoint.publicId },
    });
  });
  it('W-33: a disabled endpoint refuses test and recover (409); after enabling, recover sends the cancelled deliveries', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_endpoints SET status = 'DISABLED', disabled_reason = 'MANUAL' WHERE id = $1`,
      [d.endpoint.id],
    );
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe(
      'CANCELLED',
    );
    const base = `${endpointsUrl(org.orgId)}/${d.endpoint.publicId}`;
    const since = new Date(Date.now() - 3600_000).toISOString();
    expect(
      (
        await authed(app, owner)
          .post(`${base}/test`)
          .set('idempotency-key', idem())
          .send()
      ).status,
    ).toBe(409);
    expect(
      (
        await authed(app, owner)
          .post(`${base}/recover`)
          .set('idempotency-key', idem())
          .send({ since })
      ).status,
    ).toBe(409);
    await orgQuery(
      org.orgId,
      `UPDATE webhook_endpoints SET status = 'ACTIVE', disabled_reason = NULL WHERE id = $1`,
      [d.endpoint.id],
    );
    expect(
      (
        await authed(app, owner)
          .post(`${base}/recover`)
          .set('idempotency-key', idem())
          .send({ since })
      ).body.requeued,
    ).toBe(1);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe(
      'SUCCEEDED',
    );
  });
});
