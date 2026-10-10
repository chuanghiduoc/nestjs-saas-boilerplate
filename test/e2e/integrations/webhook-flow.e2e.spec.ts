import type { INestApplication } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../../../src/core/queue/index.js';
import { IntegrationsSweepOrgJob } from '../../../src/modules/integrations/jobs.js';
import {
  endpointsUrl,
  startIntegrationsApp,
} from '../../support/integrations-app.js';
import {
  deliveryRow,
  receiverEnv,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import { orgQuery } from '../../support/integrations-seed.js';
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

const FLOW_TIMEOUT_MS = 30_000;

describe(
  'end-to-end webhook flow on real jobs (spec SP6 §8.3, W-1, W-40)',
  { timeout: FLOW_TIMEOUT_MS },
  () => {
    let app: INestApplication;
    let receiver: WebhookReceiver;
    let owner: SeededPrincipal;
    let org: SeededOrg;
    let secret: string;
    beforeAll(async () => {
      receiver = await startWebhookReceiver();
      app = await startIntegrationsApp({
        env: receiverEnv(receiver),
        consumeWebhooks: true,
      });
      owner = await seedUserPrincipal();
      org = await seedOrg({ owner: { authUserId: owner.authUserId } });
      const res = await authed(app, owner)
        .post(endpointsUrl(org.orgId))
        .send({
          url: receiver.url('/flow'),
          eventTypes: ['tenancy.org.updated', 'tenancy.org.deleted'],
        });
      expect(res.status).toBe(201);
      secret = String(res.body.secret);
    });
    afterAll(async () => {
      await org?.dispose();
      await app?.close();
      await receiver?.close();
      await deleteSeededPrincipals([owner]);
    });

    it('renaming the org reaches the receiver signed, with the tenancy.org.updated payload', async () => {
      const get = await authed(app, owner).get(`/v1/orgs/${org.orgId}`);
      const patch = await authed(app, owner)
        .patch(`/v1/orgs/${org.orgId}`)
        .set('if-match', String(get.headers.etag))
        .send({ name: 'Renamed Org' });
      expect(patch.status).toBe(200);
      const [req] = await receiver.waitFor(1, FLOW_TIMEOUT_MS - 5000);
      const payload = new Webhook(secret).verify(req?.body ?? '', {
        'webhook-id': String(req?.headers['webhook-id']),
        'webhook-timestamp': String(req?.headers['webhook-timestamp']),
        'webhook-signature': String(req?.headers['webhook-signature']),
      });
      expect(payload).toMatchObject({
        type: 'tenancy.org.updated',
        version: 1,
        data: { orgId: org.orgId, changed: ['name'] },
      });
    });
    it('W-40: soft-deleting the org still delivers tenancy.org.deleted (deliver job runs for an inactive org)', async () => {
      expect(
        (await authed(app, owner).delete(`/v1/orgs/${org.orgId}`)).status,
      ).toBe(204);
      const reqs = await receiver.waitFor(2, FLOW_TIMEOUT_MS - 5000);
      expect(JSON.parse(reqs[1]?.body ?? '{}')).toMatchObject({
        type: 'tenancy.org.deleted',
      });
    });
    it('W-40 + I4: in the soft-deleted org an expired lease is still rescheduled by integrations.sweep-org through the real WorkerHost (onInactiveOrg run)', async () => {
      const d = await seedPendingDelivery(app, org.orgId, {
        url: receiver.url('/flow'),
      });
      await orgQuery(
        org.orgId,
        `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = 1, lease_until = now() - interval '1 hour' WHERE public_id = $1`,
        [d.deliveryId],
      );
      await app
        .get(JobQueue)
        .enqueue(
          IntegrationsSweepOrgJob,
          {},
          { jobId: `w40-sweep-${d.deliveryId}`, meta: { orgId: org.orgId } },
        );
      // Chờ worker của app chạy job (có hạn chót). `onInactiveOrg: 'skip'` sẽ để dòng ở SENDING tới hết hạn chót → đỏ.
      const until = Date.now() + FLOW_TIMEOUT_MS - 5000;
      while (
        (await deliveryRow(org.orgId, d.deliveryId)).status === 'SENDING' &&
        Date.now() < until
      )
        await new Promise((r) => setTimeout(r, 100));
      expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
        status: 'RETRY_SCHEDULED',
        last_error: 'LEASE_EXPIRED',
        local_failures: 1,
      });
    });
  },
);
