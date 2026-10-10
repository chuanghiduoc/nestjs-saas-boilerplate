import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../support/identity-app.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
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

const FAILURES = 20;

describe('delivery races (spec SP6 §13 R6-9, R6-11, R6-12; W-31, W-32)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({
      env: {
        ...receiverEnv(receiver),
        INTEGRATIONS_RETRY_SCHEDULE_SEC: '1',
        INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '1',
        INTEGRATIONS_WEBHOOK_TIMEOUT_MS: '10000',
        INTEGRATIONS_DELIVERY_LEASE_MS: '60000',
        // R6-12 cần FAILURES request cùng in-flight trên một endpoint: nâng trần in-flight (R-X35) trên FAILURES; luật config
        // đòi trần < bulkhead và bulkhead ≥ concurrency của queue io.
        INTEGRATIONS_MAX_INFLIGHT_PER_ENDPOINT: String(FAILURES),
        INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT: String(2 * FAILURES),
        // I3: FAILURES transaction ghi kết quả cùng chờ khoá dòng endpoint, mỗi cái giữ một kết nối của pool; claim của chính các
        // lần gửi đó cũng xếp hàng trên dòng endpoint lúc bắt đầu. DB_POOL_MAX mặc định 10 (`database.config.ts`) sẽ để phần
        // còn lại chờ kết nối thay vì chờ khoá — barrier không bao giờ thấy đủ FAILURES. 2 × FAILURES + 2: cả hai đợt + dư cho
        // relay/worker của app.
        DB_POOL_MAX: String(2 * FAILURES + 2),
        // 4C: mọi ca ở đây khẳng định không có deadlock (thứ tự khoá ở Global Constraints); UnitOfWork chạy lại nạn nhân 40P01
        // im lặng nên test sẽ mù nếu để retry. Tắt retry: một deadlock thật làm ca đỏ.
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
    receiver?.release();
    await org?.dispose();
    await app?.close();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it(`R6-12 / W-32: ${FAILURES} failures past the threshold, all queued on the endpoint row, disable it exactly once`, async () => {
    const first = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    const ids = [first.deliveryId];
    await inOrg(org.orgId, async (c) => {
      for (let i = 1; i < FAILURES; i++)
        ids.push(
          (
            await insertDelivery(c, org.orgId, {
              endpoint: first.endpoint,
              message: await insertMessage(c, org.orgId),
            })
          ).publicId,
        );
      await c.query(
        `UPDATE webhook_endpoints SET failing_since = now() - interval '1 hour' WHERE id = $1`,
        [first.endpoint.id],
      );
    });
    receiver.respondWith(
      ...Array.from({ length: FAILURES }, () => ({ status: 500 })),
    );
    // Claim nay khoá dòng endpoint (R-X35), nên barrier phải đặt SAU claim: giữ mọi request ở receiver tới khi đủ FAILURES đã
    // claim và đang bay, rồi mới khoá dòng endpoint và thả receiver — mọi lần ghi kết quả (CAS tự tắt) xếp hàng sau khoá đó và
    // được thả cùng lúc.
    receiver.hold();
    const all = Promise.all(ids.map((id) => runDeliver(app, org.orgId, id)));
    all.catch(() => undefined);
    await receiver.waitFor(FAILURES);
    await raceOnRowLock(
      org.orgId,
      `SELECT 1 FROM webhook_endpoints WHERE id = $1 FOR UPDATE`,
      [first.endpoint.id],
      FAILURES,
      async () => {
        receiver.release();
        return all;
      },
    );
    const disabled = await ownerQuery(
      `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'integrations.endpoint.disabled' AND payload->>'endpointId' = $2`,
      [org.orgId, first.endpoint.publicId],
    );
    expect(disabled).toHaveLength(1);
    const [ep] = await orgQuery<{ status: string; disabled_reason: string }>(
      org.orgId,
      `SELECT status, disabled_reason FROM webhook_endpoints WHERE id = $1`,
      [first.endpoint.id],
    );
    expect(ep).toEqual({ status: 'DISABLED', disabled_reason: 'AUTO_FAILING' });
  });
  it('R6-9 / W-31: a worker whose lease was taken over writes 0 rows; the new claim owns the delivery', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    receiver.hold();
    const stale = runDeliver(app, org.orgId, d.deliveryId);
    await receiver.waitFor(1);
    // Lease hết hạn khi worker A còn treo; sweep (Task 11 Step 5) làm CAS LEASE_EXPIRED, mô phỏng đúng câu đó ở đây.
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET status = 'RETRY_SCHEDULED', lease_until = NULL, next_attempt_at = now(), cycle_base = cycle_base + 1, last_error = 'LEASE_EXPIRED'
       WHERE public_id = $1 AND status = 'SENDING'`,
      [d.deliveryId],
    );
    receiver.release();
    await stale;
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      last_error: 'LEASE_EXPIRED',
      attempts_total: 1,
    });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'SUCCEEDED',
      attempts_total: 2,
    });
  });
  it('R6-11: a rotation while a request is in flight; that request carries the old secret, the next carries both', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    receiver.respondWith({ status: 500 });
    receiver.hold();
    const inflight = runDeliver(app, org.orgId, d.deliveryId);
    await receiver.waitFor(1);
    const res = await authed(app, owner)
      .post(
        `/v1/orgs/${org.orgId}/webhook-endpoints/${d.endpoint.publicId}/rotate-secret`,
      )
      .send();
    expect(res.status).toBe(200);
    const rotated = String(res.body.secret);
    receiver.release();
    await inflight;
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET next_attempt_at = now() WHERE public_id = $1`,
      [d.deliveryId],
    );
    await runDeliver(app, org.orgId, d.deliveryId);
    const [firstReq, secondReq] = await receiver.waitFor(2);
    const verify = (s: string, r: typeof firstReq) =>
      new Webhook(s).verify(r?.body ?? '', {
        'webhook-id': String(r?.headers['webhook-id']),
        'webhook-timestamp': String(r?.headers['webhook-timestamp']),
        'webhook-signature': String(r?.headers['webhook-signature']),
      });
    expect(() => verify(d.secret, firstReq)).not.toThrow();
    expect(() => verify(rotated, firstReq)).toThrow();
    expect(
      String(secondReq?.headers['webhook-signature']).split(' '),
    ).toHaveLength(2);
    for (const s of [d.secret, rotated])
      expect(() => verify(s, secondReq)).not.toThrow();
  });
});
