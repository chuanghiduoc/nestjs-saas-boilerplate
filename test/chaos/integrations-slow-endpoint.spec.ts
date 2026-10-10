import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../../src/core/queue/index.js';
import {
  DeliverWebhookJob,
  deliveryJobId,
} from '../../src/modules/integrations/jobs.js';
import { startIntegrationsApp } from '../support/integrations-app.js';
import {
  deliveryRow,
  receiverEnv,
  seedPendingDelivery,
} from '../support/integrations-delivery.js';
import { inOrg, orgQuery } from '../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../support/webhook-receiver.js';

const WAITING = 1000;
const CONCURRENCY = 20;
const TIMEOUT_MS = 1000;
/** `INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT` mặc định (R-X35). */
const MAX_INFLIGHT = 4;
/** Cận của spec W-46: timeout × (chờ / concurrency), cộng biên khởi động và dispatch. */
const BOUND_MS = TIMEOUT_MS * (WAITING / CONCURRENCY) * 1.5 + 10_000;

describe(
  'one slow endpoint does not starve the others beyond the computed bound (spec SP6 W-46)',
  { timeout: BOUND_MS + 60_000 },
  () => {
    let app: INestApplication;
    let slow: WebhookReceiver;
    let fast: WebhookReceiver;
    let org: SeededOrg;
    beforeAll(async () => {
      slow = await startWebhookReceiver();
      fast = await startWebhookReceiver();
      app = await startIntegrationsApp({
        consumeWebhooks: true,
        env: {
          ...receiverEnv(slow),
          RESILIENCE_ALLOWED_PORTS: `80,443,${slow.port},${fast.port}`,
          INTEGRATIONS_WEBHOOK_TIMEOUT_MS: String(TIMEOUT_MS),
          QUEUE_IO_CONCURRENCY: String(CONCURRENCY),
        },
      });
      org = await seedOrg();
    });
    afterAll(async () => {
      await org?.dispose();
      await app?.close();
      await slow?.close();
      await fast?.close();
    });

    it(`${WAITING} deliveries to a timing-out endpoint, then one to a healthy endpoint: the healthy one succeeds within ${Math.round(BOUND_MS / 1000)} s`, async () => {
      slow.respondWith(
        ...Array.from({ length: WAITING }, () => ({
          status: 204,
          delayMs: TIMEOUT_MS * 3,
        })),
      );
      const first = await seedPendingDelivery(app, org.orgId, {
        url: slow.url(),
      });
      const ids = await inOrg(org.orgId, async (c) => {
        const { rows } = await c.query<{ public_id: string }>(
          `WITH m AS (
           INSERT INTO webhook_messages (org_id, event_id, event_type, event_version, body)
           SELECT $1, gen_random_uuid(), 'tenancy.org.updated', 1, '{}' FROM generate_series(1, $2) RETURNING id, created_at)
         INSERT INTO webhook_deliveries (public_id, org_id, endpoint_id, message_id, created_at, status, next_attempt_at)
         SELECT gen_random_uuid(), $1, $3::bigint, m.id, m.created_at, 'PENDING', now() FROM m RETURNING public_id::text`,
          [org.orgId, WAITING - 1, first.endpoint.id],
        );
        return [first.deliveryId, ...rows.map((r) => r.public_id)];
      });
      const queue = app.get(JobQueue);
      await queue.enqueueMany(
        ids.map((id) => ({
          job: DeliverWebhookJob,
          payload: { deliveryId: id },
          opts: { jobId: deliveryJobId(id, 1), meta: { orgId: org.orgId } },
        })),
      );
      const healthy = await seedPendingDelivery(app, org.orgId, {
        url: fast.url(),
      });
      const t0 = Date.now();
      await queue.enqueue(
        DeliverWebhookJob,
        { deliveryId: healthy.deliveryId },
        {
          jobId: deliveryJobId(healthy.deliveryId, 1),
          meta: { orgId: org.orgId },
        },
      );
      // Lấy mẫu số SENDING của endpoint chậm trong lúc chờ (số đo phụ; chứng minh tất định của trần ở `deliver-inflight.e2e.spec.ts`).
      let maxSending = 0;
      while (
        (await deliveryRow(org.orgId, healthy.deliveryId)).status !==
        'SUCCEEDED'
      ) {
        if (Date.now() - t0 > BOUND_MS)
          throw new Error(`healthy delivery not done after ${BOUND_MS} ms`);
        const [s] = await orgQuery<{ n: number }>(
          org.orgId,
          `SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'SENDING'`,
          [first.endpoint.id],
        );
        maxSending = Math.max(maxSending, s?.n ?? 0);
        await new Promise((r) => setTimeout(r, 200));
      }
      const ms = Date.now() - t0;
      const [{ n } = { n: -1 }] = await orgQuery<{ n: number }>(
        org.orgId,
        `SELECT count(*)::int AS n FROM webhook_deliveries WHERE last_error = 'TIMEOUT'`,
      );
      process.stdout.write(
        `${JSON.stringify({ event: 'webhook_w46', waiting: WAITING, concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS, maxInflight: MAX_INFLIGHT, healthyMs: ms, timeouts: n, maxSending })}\n`,
      );
      expect(ms).toBeLessThanOrEqual(BOUND_MS);
      expect(maxSending).toBeLessThanOrEqual(MAX_INFLIGHT);
    });
  },
);
