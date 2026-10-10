import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import {
  deliveryRow,
  runDeliver,
  seedPendingDelivery,
  type SeededDelivery,
} from '../../support/integrations-delivery.js';
import { orgQuery } from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../../support/webhook-receiver.js';

const MAX_INFLIGHT = 4;
/** Bulkhead của process vừa trên trần in-flight: không có trần, endpoint chết lấp đầy bulkhead và endpoint khoẻ nhận `bulkhead_full`. */
const BULKHEAD = MAX_INFLIGHT + 1;
const PENDING = 10;
const SETTLE_DEADLINE_MS = 10_000;
const POLL_MS = 20;
const TEST_TIMEOUT_MS = 30_000;

describe(
  'a hanging endpoint cannot take the shared webhooks-out bulkhead (R-X35 in-flight cap, R6C-4)',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let app: INestApplication;
    let dead: WebhookReceiver;
    let healthy: WebhookReceiver;
    let orgA: SeededOrg;
    let orgB: SeededOrg;
    beforeAll(async () => {
      dead = await startWebhookReceiver();
      healthy = await startWebhookReceiver();
      app = await startIntegrationsApp({
        env: {
          RESILIENCE_ALLOWED_SCHEMES: 'http,https',
          RESILIENCE_ALLOWED_PORTS: `80,443,${dead.port},${healthy.port}`,
          RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
          INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT: String(MAX_INFLIGHT),
          INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT: String(BULKHEAD),
          INTEGRATIONS_WEBHOOK_BULKHEAD_QUEUE: '0',
          // Luật `webhooks-bulkhead-covers-concurrency`: bulkhead ≥ concurrency của queue io.
          QUEUE_IO_CONCURRENCY: String(BULKHEAD),
          // Request bị giữ phải sống qua cả ca (timeout dưới lease 60 s, trên thời gian ca).
          INTEGRATIONS_WEBHOOK_TIMEOUT_MS: '20000',
          // 10 claim cùng lúc xếp hàng trên dòng endpoint, mỗi cái giữ một kết nối tới khi tới lượt: trên DB_POOL_MAX mặc định (10).
          DB_POOL_MAX: String(2 * PENDING + 2),
          // 4C: claim tuần tự hoá trên khoá dòng endpoint, không có deadlock; UnitOfWork chạy lại nạn nhân 40P01 một cách im lặng
          // nên test sẽ mù nếu để retry. Tắt retry: một deadlock thật làm ca đỏ.
          DB_TX_RETRY_ATTEMPTS: '0',
        },
      });
      orgA = await seedOrg();
      orgB = await seedOrg();
    });
    afterAll(async () => {
      dead?.release();
      await orgA?.dispose();
      await orgB?.dispose();
      await app?.close();
      await dead?.close();
      await healthy?.close();
    });

    it(`${PENDING} deliveries to a hanging endpoint hold exactly ${MAX_INFLIGHT} slots, the rest are deferred uncounted; a healthy endpoint of another org is delivered meanwhile`, async () => {
      const first = await seedPendingDelivery(app, orgA.orgId, {
        url: dead.url(),
      });
      const all: SeededDelivery[] = [first];
      for (let i = 1; i < PENDING; i++)
        all.push(
          await seedPendingDelivery(app, orgA.orgId, {
            url: dead.url(),
            endpoint: first.endpoint,
          }),
        );
      dead.hold();
      let settled = 0;
      const runs = all.map((d) =>
        runDeliver(app, orgA.orgId, d.deliveryId).finally(() => {
          settled++;
        }),
      );
      // Xen kẽ bị ép: đúng MAX_INFLIGHT request đang bị receiver giữ (in-flight thật), các handler còn lại đã trả về vì claim
      // bị từ chối. Thứ tự claim không quan trọng: khoá dòng endpoint tuần tự hoá "đếm rồi claim".
      await dead.waitFor(MAX_INFLIGHT);
      const until = Date.now() + SETTLE_DEADLINE_MS;
      while (settled < PENDING - MAX_INFLIGHT) {
        if (Date.now() > until)
          throw new Error(
            `${settled} of ${PENDING - MAX_INFLIGHT} refused claims returned`,
          );
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      const rows = await orgQuery<{
        status: string;
        attempts_total: number;
        local_failures: number;
        later: boolean | null;
      }>(
        orgA.orgId,
        `SELECT status, attempts_total, local_failures, next_attempt_at > now() AS later FROM webhook_deliveries WHERE endpoint_id = $1`,
        [first.endpoint.id],
      );
      expect(rows.filter((r) => r.status === 'SENDING')).toHaveLength(
        MAX_INFLIGHT,
      );
      const deferred = rows.filter((r) => r.status === 'PENDING');
      expect(deferred).toHaveLength(PENDING - MAX_INFLIGHT);
      for (const r of deferred)
        expect(r).toMatchObject({
          attempts_total: 0,
          local_failures: 0,
          later: true,
        });
      const busy = await ownerQuery<{ payload: { jobId: string } }>(
        `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->>'job' = 'integrations.deliver-webhook'`,
        [orgA.orgId],
      );
      expect(
        busy.map((j) => j.payload.jobId).filter((id) => /-a1-b\d+$/.test(id)),
      ).toHaveLength(PENDING - MAX_INFLIGHT);
      // Endpoint khoẻ của org khác vẫn có slot bulkhead trong khi endpoint chết giữ đúng MAX_INFLIGHT.
      const ok = await seedPendingDelivery(app, orgB.orgId, {
        url: healthy.url(),
      });
      await runDeliver(app, orgB.orgId, ok.deliveryId);
      expect((await deliveryRow(orgB.orgId, ok.deliveryId)).status).toBe(
        'SUCCEEDED',
      );
      expect(dead.requests).toHaveLength(MAX_INFLIGHT);
      dead.release();
      await Promise.all(runs);
      const done = await orgQuery<{ n: number }>(
        orgA.orgId,
        `SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'SUCCEEDED'`,
        [first.endpoint.id],
      );
      expect(done[0]?.n).toBe(MAX_INFLIGHT);
    });
  },
);
