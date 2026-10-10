import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HttpClient,
  UpstreamError,
} from '../../../src/core/resilience/index.js';
import { ownerQuery } from '../../support/identity-app.js';
import {
  deliveryRow,
  makeDue,
  runDeliver,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import {
  FAKE_SECRET_ENC,
  inOrg,
  orgQuery,
} from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** `INTEGRATIONS_MAX_LOCAL_FAILURES` của app test (bằng mặc định, ghi tường minh để test không lệ thuộc mặc định). */
const MAX = 5;
const exhaustedEvents = (orgId: string, deliveryId: string) =>
  ownerQuery(
    `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'integrations.delivery.exhausted' AND payload->>'deliveryId' = $2`,
    [orgId, deliveryId],
  );
const deferredJobIds = async (orgId: string, deliveryId: string) =>
  (
    await ownerQuery<{ payload: { jobId: string } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2 ORDER BY id`,
      [orgId, deliveryId],
    )
  ).map((j) => j.payload.jobId);

describe('faults on our side never burn the schedule nor disable a healthy endpoint, and are capped (spec SP6 §7.2, S6-A49, W-34, R6-28, R-X35)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let calls = 0;
  beforeAll(async () => {
    const fake = {
      request: async () => {
        calls++;
        throw new UpstreamError(
          'webhooks-out',
          'bulkhead_full',
          'Upstream webhooks-out bulkhead is full',
        );
      },
    };
    app = await startIntegrationsApp({
      // DISABLE_AFTER nhỏ nhất hợp lệ với lịch 1 bước (1 s): sau đó endpoint "lỗi lâu" sẽ bị tắt nếu lỗi của ta bị tính nhầm.
      env: {
        INTEGRATIONS_RETRY_SCHEDULE_SEC: '1',
        INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '1',
        INTEGRATIONS_LOCAL_FAULT_RETRY_SEC: '1',
        INTEGRATIONS_MAX_LOCAL_FAILURES: String(MAX),
      },
      configure: (b) => b.overrideProvider(HttpClient).useValue(fake),
    });
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it(`W-34 + R-X35: ${MAX - 1} bulkhead_full keep the schedule and the endpoint; the ${MAX}th exhausts the delivery (recoverable); the endpoint stays ACTIVE and healthy past DISABLE_AFTER`, async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: 'https://hooks.example.test/x',
    });
    for (let i = 1; i < MAX; i++) {
      await runDeliver(app, org.orgId, d.deliveryId);
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row).toMatchObject({
        status: 'RETRY_SCHEDULED',
        last_error: 'BULKHEAD_FULL',
        attempts_total: i,
        local_failures: i,
      });
      // Không bước lịch nào bị tiêu: mỗi lỗi của ta tăng `cycle_base` cùng `attempts_total`.
      expect(row.attempts_total - row.cycle_base).toBe(0);
      await makeDue(org.orgId, d.deliveryId);
    }
    // Đưa đồng hồ qua mốc DISABLE_AFTER = 1 s: nếu lỗi của ta bị tính nhầm là lỗi của endpoint, lần cuối sẽ tự tắt endpoint.
    await new Promise((r) => setTimeout(r, 1100));
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'EXHAUSTED',
      last_error: 'BULKHEAD_FULL',
      attempts_total: MAX,
      local_failures: MAX,
      lease_until: null,
    });
    expect(await exhaustedEvents(org.orgId, d.deliveryId)).toHaveLength(1);
    expect(await deferredJobIds(org.orgId, d.deliveryId)).toEqual(
      Array.from(
        { length: MAX - 1 },
        (_, i) => `webhook-${d.deliveryId}-a${i + 2}`,
      ),
    );
    const [ep] = await orgQuery<{ status: string; failing_since: Date | null }>(
      org.orgId,
      `SELECT status, failing_since FROM webhook_endpoints WHERE id = $1`,
      [d.endpoint.id],
    );
    expect(ep).toEqual({ status: 'ACTIVE', failing_since: null });
  });
  it(`R-X35: an undecryptable signing secret is a counted local failure (SECRET_UNAVAILABLE) recorded at claim, nothing is sent, the ${MAX}th exhausts — no endless re-enqueue`, async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: 'https://hooks.example.test/y',
    });
    // app_user không có UPDATE trên `secret_enc`: thay secret bằng một token đúng định dạng mà keyring không giải mã được.
    await inOrg(org.orgId, async (c) => {
      await c.query(
        `DELETE FROM webhook_endpoint_secrets WHERE endpoint_id = $1`,
        [d.endpoint.id],
      );
      await c.query(
        `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`,
        [org.orgId, d.endpoint.id, FAKE_SECRET_ENC],
      );
    });
    const before = calls;
    for (let i = 1; i <= MAX; i++) {
      await runDeliver(app, org.orgId, d.deliveryId);
      expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
        status: i < MAX ? 'RETRY_SCHEDULED' : 'EXHAUSTED',
        last_error: 'SECRET_UNAVAILABLE',
        attempts_total: i,
        local_failures: i,
        lease_until: null,
      });
      await makeDue(org.orgId, d.deliveryId);
    }
    expect(calls).toBe(before);
    expect(await deferredJobIds(org.orgId, d.deliveryId)).toEqual(
      Array.from(
        { length: MAX - 1 },
        (_, i) => `webhook-${d.deliveryId}-a${i + 2}`,
      ),
    );
    expect(await exhaustedEvents(org.orgId, d.deliveryId)).toHaveLength(1);
  });
});
