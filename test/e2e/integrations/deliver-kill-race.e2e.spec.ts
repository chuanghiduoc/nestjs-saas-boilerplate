import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../src/core/database/index.js';
import {
  DbKillSwitchProvider,
  KillSwitches,
  NO_ROW_VERSION,
} from '../../../src/core/flags/index.js';
import { ownerQuery } from '../../support/identity-app.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import {
  deliveryRow,
  receiverEnv,
  runDeliver,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../../support/webhook-receiver.js';

const KEY = 'integrations.webhook_delivery';

/**
 * M1 (review bảo mật 6C): kill switch bật SAU claim nhưng TRƯỚC khi gửi không được để request nào ra ngoài. Cửa: lần hỏi
 * `isKilled` đầu (trước claim) trả lời thật rồi bật switch thật trong DB + làm mới snapshot; lần hỏi thứ hai (ngay trước gửi)
 * vì thế thấy switch đã bật. Không dựa vào thời gian.
 */
describe('the kill switch turned on between claim and send stops the request (M1)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let org: SeededOrg;
  let version = NO_ROW_VERSION;
  const set = (killed: boolean) =>
    app.get(UnitOfWork).run(async () => {
      const r = await app.get(KillSwitches).set({
        key: KEY,
        killed,
        reason: killed ? 'incident' : null,
        actor: 'test',
        expectedVersion: version,
      });
      if (r.kind !== 'APPLIED')
        throw new Error(`kill switch set returned ${r.kind}`);
      version = r.version;
    });
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({ env: receiverEnv(receiver) });
    org = await seedOrg();
    version =
      (await app.get(KillSwitches).list()).find((s) => s.key === KEY)
        ?.version ?? NO_ROW_VERSION;
  });
  afterAll(async () => {
    await set(false);
    await app.get(DbKillSwitchProvider).refreshOnce();
    await org?.dispose();
    await app?.close();
    await receiver?.close();
  });

  it('no request leaves; the claim is handed back (RETRY_SCHEDULED, schedule step not spent, no local fault) with a recheck job', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    const switches = app.get(KillSwitches);
    const real = switches.isKilled.bind(switches);
    let calls = 0;
    switches.isKilled = async (key: string) => {
      calls++;
      const answer = await real(key);
      if (calls === 1) {
        await set(true);
        await app.get(DbKillSwitchProvider).refreshOnce();
      }
      return answer;
    };
    try {
      await runDeliver(app, org.orgId, d.deliveryId);
    } finally {
      switches.isKilled = real;
    }
    expect(calls).toBe(2);
    expect(receiver.requests).toHaveLength(0);
    const row = await deliveryRow(org.orgId, d.deliveryId);
    expect(row).toMatchObject({
      status: 'RETRY_SCHEDULED',
      attempts_total: 1,
      cycle_base: 1,
      local_failures: 0,
      lease_until: null,
    });
    expect(row.next_in_ms).toBeGreaterThan(50_000);
    const jobs = await ownerQuery<{ payload: { jobId: string } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2`,
      [org.orgId, d.deliveryId],
    );
    expect(jobs.map((j) => j.payload.jobId)).toEqual([
      expect.stringMatching(new RegExp(`^webhook-${d.deliveryId}-a2-k[0-9]+$`)),
    ]);
  });
});
