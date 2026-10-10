import type { ChildProcess } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../../../src/core/queue/index.js';
import { PurgeOrgJob, purgeJobId } from '../../../src/modules/tenancy/jobs.js';
import { createTestApp } from '../../support/app-factory.js';
import { baseTestEnv } from '../../support/env.js';
import { ownerQuery } from '../../support/identity-app.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import {
  FAKE_SECRET_ENC,
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
  orgQuery,
} from '../../support/integrations-seed.js';
import { killIfAlive, startWorker } from '../../support/spawn-worker.js';
import { seedOrg } from '../../support/tenancy-seed.js';

const E2E_TIMEOUT_MS = 90_000;

describe(
  'org purge end to end on a real worker (spec SP6 X-3, 6C part)',
  { timeout: E2E_TIMEOUT_MS },
  () => {
    let app: INestApplication;
    let worker: ChildProcess | undefined;
    beforeAll(async () => {
      app = await createTestApp(integrationsCoreImports());
      worker = (
        await startWorker({
          ...baseTestEnv(),
          APP_ROLE: 'worker',
          WORKER_QUEUES: 'maintenance',
        })
      ).child;
    });
    afterAll(async () => {
      if (worker) killIfAlive(worker);
      await app?.close();
    });

    it('an org with endpoints, secrets, messages and deliveries leaves no webhook row; tenancy.org.purged is in the outbox', async () => {
      const org = await seedOrg();
      await inOrg(org.orgId, async (c) => {
        const endpoint = await insertEndpoint(c, org.orgId);
        await c.query(
          `INSERT INTO webhook_endpoint_secrets (org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3)`,
          [org.orgId, endpoint.id, FAKE_SECRET_ENC],
        );
        await insertDelivery(c, org.orgId, {
          endpoint,
          message: await insertMessage(c, org.orgId),
        });
        await c.query(
          `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
          [org.orgId],
        );
      });
      await app
        .get(JobQueue)
        .enqueue(
          PurgeOrgJob,
          {},
          { jobId: purgeJobId(org.orgId), meta: { orgId: org.orgId } },
        );
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        const [row] = await ownerQuery<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`,
          [org.orgId],
        );
        if ((row?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      for (const t of [
        'webhook_deliveries',
        'webhook_messages',
        'webhook_endpoint_event_types',
        'webhook_endpoint_secrets',
        'webhook_endpoints',
      ])
        expect(await orgQuery(org.orgId, `SELECT 1 FROM ${t}`)).toEqual([]);
      expect(
        (
          await ownerQuery(
            `SELECT 1 FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.purged'`,
            [org.orgId],
          )
        ).length,
      ).toBe(1);
    });
  },
);
