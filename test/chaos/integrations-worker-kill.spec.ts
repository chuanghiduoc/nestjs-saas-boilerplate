import type { ChildProcess } from 'node:child_process';
import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope } from '../../src/core/database/index.js';
import { JobQueue } from '../../src/core/queue/index.js';
import { IntegrationsSweepOrgHandler } from '../../src/modules/integrations/application/sweep.handlers.js';
import {
  DeliverWebhookJob,
  deliveryJobId,
} from '../../src/modules/integrations/jobs.js';
import { createTestApp } from '../support/app-factory.js';
import { baseTestEnv } from '../support/env.js';
import { integrationsCoreImports } from '../support/integrations-app.js';
import {
  deliveryRow,
  receiverEnv,
  seedPendingDelivery,
} from '../support/integrations-delivery.js';
import { orgQuery } from '../support/integrations-seed.js';
import { killIfAlive, startWorker } from '../support/spawn-worker.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../support/webhook-receiver.js';

const CHAOS_TIMEOUT_MS = 90_000;

describe(
  'a worker killed mid-send loses nothing and never writes twice (spec SP6 W-30, W-31)',
  { timeout: CHAOS_TIMEOUT_MS },
  () => {
    let receiver: WebhookReceiver;
    let app: INestApplication;
    let org: SeededOrg;
    const children: ChildProcess[] = [];
    beforeAll(async () => {
      receiver = await startWebhookReceiver();
      app = await createTestApp(integrationsCoreImports(), {});
      org = await seedOrg();
    });
    afterAll(async () => {
      for (const c of children.splice(0)) killIfAlive(c);
      receiver?.release();
      await org?.dispose();
      await app?.close();
      await receiver?.close();
    });

    it('SIGKILL after the request left: lease expires, the sweep reschedules as LEASE_EXPIRED, a new worker resends the same webhook-id', async () => {
      const env = {
        ...baseTestEnv(),
        ...receiverEnv(receiver),
        APP_ROLE: 'worker',
        WORKER_QUEUES: 'webhooks-out',
        INTEGRATIONS_DELIVERY_LEASE_MS: '60000',
      };
      const d = await seedPendingDelivery(app, org.orgId, {
        url: receiver.url(),
      });
      receiver.hold();
      const first = await startWorker(env);
      children.push(first.child);
      await app
        .get(JobQueue)
        .enqueue(
          DeliverWebhookJob,
          { deliveryId: d.deliveryId },
          { jobId: deliveryJobId(d.deliveryId, 1), meta: { orgId: org.orgId } },
        );
      const [sent] = await receiver.waitFor(1, 30_000);
      first.child.kill('SIGKILL');
      receiver.release();
      expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe(
        'SENDING',
      );
      // Đưa lease về quá hạn + grace thay vì chờ 60 s (mốc thời gian, không phải may rủi).
      await orgQuery(
        org.orgId,
        `UPDATE webhook_deliveries SET lease_until = now() - interval '1 hour' WHERE public_id = $1`,
        [d.deliveryId],
      );
      const ctx = {
        payload: {},
        meta: { orgId: org.orgId },
        jobId: 'sweep',
        attempt: 1,
        maxAttempts: 1,
        signal: new AbortController().signal,
        log: new Logger('t'),
      };
      expect(
        (
          await app
            .get(OrgScope)
            .run(org.orgId, () =>
              app.get(IntegrationsSweepOrgHandler).handle(ctx),
            )
        ).leases,
      ).toBe(1);
      expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
        status: 'RETRY_SCHEDULED',
        last_error: 'LEASE_EXPIRED',
        attempts_total: 1,
      });
      await orgQuery(
        org.orgId,
        `UPDATE webhook_deliveries SET next_attempt_at = now() WHERE public_id = $1`,
        [d.deliveryId],
      );
      const second = await startWorker(env);
      children.push(second.child);
      await app
        .get(JobQueue)
        .enqueue(
          DeliverWebhookJob,
          { deliveryId: d.deliveryId },
          { jobId: deliveryJobId(d.deliveryId, 2), meta: { orgId: org.orgId } },
        );
      const reqs = await receiver.waitFor(2, 30_000);
      expect(reqs[1]?.headers['webhook-id']).toBe(sent?.headers['webhook-id']);
      const until = Date.now() + 20_000;
      while (
        (await deliveryRow(org.orgId, d.deliveryId)).status !== 'SUCCEEDED' &&
        Date.now() < until
      )
        await new Promise((r) => setTimeout(r, 100));
      expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
        status: 'SUCCEEDED',
        attempts_total: 2,
      });
    });
  },
);
