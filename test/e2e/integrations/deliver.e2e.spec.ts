import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../src/core/database/index.js';
import {
  DbKillSwitchProvider,
  KillSwitches,
  NO_ROW_VERSION,
} from '../../../src/core/flags/index.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  deliveryRow,
  makeDue,
  receiverEnv,
  runDeliver,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../../support/webhook-receiver.js';

/** Lịch ngắn (W-10): 3 bước → 4 lần thử. */
const SCHEDULE = [1, 2, 3];
const deferredJobs = (orgId: string, deliveryId: string) =>
  ownerQuery<{ payload: { jobId: string; delayMs?: number } }>(
    `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2 ORDER BY id`,
    [orgId, deliveryId],
  );

describe('sending a webhook (spec SP6 §8.3 "Gửi", §7.2)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let org: SeededOrg;
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({
      env: {
        ...receiverEnv(receiver),
        INTEGRATIONS_RETRY_SCHEDULE_SEC: SCHEDULE.join(','),
        INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '86400',
      },
    });
    org = await seedOrg();
  });
  beforeEach(() => {
    receiver.requests.length = 0;
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await receiver?.close();
  });

  it('2xx → SUCCEEDED; Standard Webhooks headers verify with the secret (W-1); webhook-id is the event id; timestamp is unix seconds at send (W-4); user-agent', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    const before = Math.floor(Date.now() / 1000);
    await runDeliver(app, org.orgId, d.deliveryId);
    const [req] = await receiver.waitFor(1);
    const [msg] = await orgQuery<{ event_id: string; body: string }>(
      org.orgId,
      `SELECT event_id::text, body FROM webhook_messages WHERE id = $1`,
      [d.message.id],
    );
    expect(req?.body).toBe(msg?.body);
    expect(req?.headers['webhook-id']).toBe(msg?.event_id);
    expect(Number(req?.headers['webhook-timestamp'])).toBeGreaterThanOrEqual(
      before,
    );
    expect(req?.headers['content-type']).toBe('application/json');
    expect(String(req?.headers['user-agent'])).toMatch(/-webhooks\/1$/);
    expect(() =>
      new Webhook(d.secret).verify(req?.body ?? '', {
        'webhook-id': String(req?.headers['webhook-id']),
        'webhook-timestamp': String(req?.headers['webhook-timestamp']),
        'webhook-signature': String(req?.headers['webhook-signature']),
      }),
    ).not.toThrow();
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'SUCCEEDED',
      attempts_total: 1,
      last_status_code: 204,
      lease_until: null,
    });
  });
  it('W-10/W-11: 500 every time → RETRY_SCHEDULED per schedule (jobs a2..a4 with the scheduled delay ±10%), then EXHAUSTED after 4 attempts + exhausted event', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    for (let attempt = 1; attempt <= SCHEDULE.length + 1; attempt++) {
      receiver.respondWith({ status: 500 });
      await runDeliver(app, org.orgId, d.deliveryId);
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row.attempts_total).toBe(attempt);
      if (attempt <= SCHEDULE.length) {
        expect(row).toMatchObject({
          status: 'RETRY_SCHEDULED',
          last_error: 'SERVER_ERROR',
          last_status_code: 500,
        });
        const step = (SCHEDULE[attempt - 1] ?? 0) * 1000;
        expect(row.next_in_ms).toBeGreaterThan(step * 0.9 - 500);
        expect(row.next_in_ms).toBeLessThanOrEqual(step * 1.1);
        await makeDue(org.orgId, d.deliveryId);
      } else
        expect(row).toMatchObject({
          status: 'EXHAUSTED',
          last_error: 'SERVER_ERROR',
        });
    }
    expect(
      (await deferredJobs(org.orgId, d.deliveryId)).map((j) => j.payload.jobId),
    ).toEqual([
      `webhook-${d.deliveryId}-a2`,
      `webhook-${d.deliveryId}-a3`,
      `webhook-${d.deliveryId}-a4`,
    ]);
    const exhausted = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'integrations.delivery.exhausted' AND payload->>'deliveryId' = $2`,
      [org.orgId, d.deliveryId],
    );
    expect(exhausted.map((e) => e.payload)).toEqual([
      {
        deliveryId: d.deliveryId,
        endpointId: d.endpoint.publicId,
        eventType: 'tenancy.org.updated',
        eventId: expect.any(String),
      },
    ]);
  });
  it('W-14 + Review Focus 3: 429 with Retry-After larger than the step is a floor; without it the schedule applies', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    receiver.respondWith({ status: 429, headers: { 'retry-after': '120' } });
    await runDeliver(app, org.orgId, d.deliveryId);
    const row = await deliveryRow(org.orgId, d.deliveryId);
    expect(row).toMatchObject({
      status: 'RETRY_SCHEDULED',
      last_error: 'RATE_LIMITED',
      last_status_code: 429,
    });
    expect(row.next_in_ms).toBeGreaterThan(119_000);
    expect(row.next_in_ms).toBeLessThanOrEqual(120_000);
    await makeDue(org.orgId, d.deliveryId);
    receiver.respondWith({ status: 429 });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(
      (await deliveryRow(org.orgId, d.deliveryId)).next_in_ms,
    ).toBeLessThanOrEqual((SCHEDULE[1] ?? 0) * 1100);
  });
  it('W-15: a 302 is not followed and is a REDIRECT failure; a 410 is CLIENT_ERROR', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    receiver.respondWith({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      last_error: 'REDIRECT',
      last_status_code: 302,
    });
    expect(receiver.requests).toHaveLength(1);
    await makeDue(org.orgId, d.deliveryId);
    receiver.respondWith({ status: 410 });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      last_error: 'CLIENT_ERROR',
      last_status_code: 410,
    });
  });
  it('W-24: a response over RESILIENCE_MAX_RESPONSE_BYTES is TOO_LARGE', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    receiver.respondWith({ status: 200, body: 'x'.repeat(11 * 1024 * 1024) });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      last_error: 'TOO_LARGE',
    });
  });
  it('R6-10 / R6-25 / W-33: a delivery whose endpoint was disabled or deleted is CANCELLED at claim (ENDPOINT_UNAVAILABLE), nothing is sent', async () => {
    const disabled = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_endpoints SET status = 'DISABLED', disabled_reason = 'MANUAL' WHERE id = $1`,
      [disabled.endpoint.id],
    );
    const deleted = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_endpoints SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`,
      [deleted.endpoint.id],
    );
    for (const d of [disabled, deleted]) {
      await runDeliver(app, org.orgId, d.deliveryId);
      expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
        status: 'CANCELLED',
        last_error: 'ENDPOINT_UNAVAILABLE',
        attempts_total: 1,
      });
    }
    expect(receiver.requests).toHaveLength(0);
  });
  it('R6C-1: a job that runs before next_attempt_at (duplicate or early) does nothing', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE public_id = $1`,
      [d.deliveryId],
    );
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'PENDING',
      attempts_total: 0,
    });
    expect(receiver.requests).toHaveLength(0);
  });
  it('W-45: with integrations.webhook_delivery killed nothing goes out, the attempt is not counted, a recheck job is deferred; turning it off sends', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    const switches = app.get(KillSwitches);
    const set = (killed: boolean, expectedVersion: number) =>
      app.get(UnitOfWork).run(() =>
        switches.set({
          key: 'integrations.webhook_delivery',
          killed,
          reason: killed ? 'incident' : null,
          actor: 'test',
          expectedVersion,
        }),
      );
    const states = await switches.list();
    const current =
      states.find((s) => s.key === 'integrations.webhook_delivery')?.version ??
      NO_ROW_VERSION;
    const on = await set(true, current);
    expect(on.kind).toBe('APPLIED');
    await app.get(DbKillSwitchProvider).refreshOnce();
    try {
      await runDeliver(app, org.orgId, d.deliveryId);
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row).toMatchObject({ status: 'PENDING', attempts_total: 0 });
      expect(row.next_in_ms).toBeGreaterThan(50_000);
      expect(receiver.requests).toHaveLength(0);
      expect(
        (await deferredJobs(org.orgId, d.deliveryId)).map(
          (j) => j.payload.jobId,
        ),
      ).toEqual([
        expect.stringMatching(new RegExp(`^webhook-${d.deliveryId}-a1-k\\d+$`)),
      ]);
      // M1: một job trùng/tới sớm khi đang bị kill không kéo lần hẹn muộn hơn về sớm, không đẩy lùi thêm, không sinh job mới.
      const later = await seedPendingDelivery(app, org.orgId, {
        url: receiver.url(),
      });
      await orgQuery(
        org.orgId,
        `UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE public_id = $1`,
        [later.deliveryId],
      );
      await runDeliver(app, org.orgId, later.deliveryId);
      const untouched = await deliveryRow(org.orgId, later.deliveryId);
      expect(untouched.next_in_ms).toBeGreaterThan(3_500_000);
      expect(untouched.next_in_ms).toBeLessThanOrEqual(3_600_000);
      expect(await deferredJobs(org.orgId, later.deliveryId)).toEqual([]);
    } finally {
      await set(false, on.kind === 'APPLIED' ? on.version : current);
      await app.get(DbKillSwitchProvider).refreshOnce();
    }
    await makeDue(org.orgId, d.deliveryId);
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe(
      'SUCCEEDED',
    );
  });
  it('a success clears failing_since on the endpoint without bumping its version (ETag of the customer stays valid)', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    await orgQuery(
      org.orgId,
      `UPDATE webhook_endpoints SET failing_since = now() - interval '1 hour' WHERE id = $1`,
      [d.endpoint.id],
    );
    await runDeliver(app, org.orgId, d.deliveryId);
    const [ep] = await orgQuery<{
      failing_since: Date | null;
      version: number;
    }>(
      org.orgId,
      `SELECT failing_since, version FROM webhook_endpoints WHERE id = $1`,
      [d.endpoint.id],
    );
    expect(ep).toEqual({ failing_since: null, version: 1 });
  });
});
