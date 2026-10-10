import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SqlDeliveryRepository } from '../../src/modules/integrations/infra/sql/sql-delivery.repository.js';
import { SqlEndpointRepository } from '../../src/modules/integrations/infra/sql/sql-endpoint.repository.js';
import { getInfra } from '../support/infra.js';
import {
  endpointsUrl,
  startIntegrationsApp,
} from '../support/integrations-app.js';
import {
  deliveryRow,
  receiverEnv,
  runDeliver,
  seedPendingDelivery,
} from '../support/integrations-delivery.js';
import { orgQuery } from '../support/integrations-seed.js';
import { authed } from '../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../support/tenancy-seed.js';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../support/webhook-receiver.js';

const RECOVERY = { timeout: 30_000, interval: 250 };

describe('the database lost under the integrations paths (spec SP6 criterion 13)', () => {
  let proxy: TcpProxy;
  let receiver: WebhookReceiver;
  let app: INestApplication;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  beforeAll(async () => {
    const { pgbouncer } = getInfra();
    proxy = await startTcpProxy(pgbouncer.host, pgbouncer.port);
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({
      env: {
        ...receiverEnv(receiver),
        DB_HOST: '127.0.0.1',
        DB_PORT: String(proxy.port),
        THROTTLE_DEFAULT_LIMIT: '100000',
      },
    });
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    if (proxy) proxy.state.blackhole = false;
    vi.restoreAllMocks();
    await org?.dispose();
    await app?.close();
    await proxy?.close();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it('creating an endpoint while the DB disappears under the count answers 503, not 500, and leaves no endpoint row', async () => {
    const repo = app.get(SqlEndpointRepository);
    const original = repo.countLive.bind(repo);
    vi.spyOn(repo, 'countLive').mockImplementationOnce(() => {
      proxy.state.blackhole = true;
      return original();
    });
    const res = await authed(app, owner)
      .post(endpointsUrl(org.orgId))
      .send({
        url: 'https://hooks.example.test/chaos',
        eventTypes: ['tenancy.org.updated'],
      });
    proxy.state.blackhole = false;
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('service_unavailable');
    await vi.waitFor(async () => {
      expect(
        await orgQuery(
          org.orgId,
          `SELECT 1 FROM webhook_endpoints WHERE url = 'https://hooks.example.test/chaos'`,
        ),
      ).toEqual([]);
    }, RECOVERY);
  });
  it('losing the DB while recording a sent result leaves the delivery SENDING with its lease (the sweep recovers it), the job fails loud', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(),
    });
    const repo = app.get(SqlDeliveryRepository);
    const original = repo.finish.bind(repo);
    vi.spyOn(repo, 'finish').mockImplementationOnce(
      (...args: Parameters<SqlDeliveryRepository['finish']>) => {
        proxy.state.blackhole = true;
        return original(...args);
      },
    );
    await expect(runDeliver(app, org.orgId, d.deliveryId)).rejects.toThrow();
    proxy.state.blackhole = false;
    await vi.waitFor(async () => {
      const row = await deliveryRow(org.orgId, d.deliveryId);
      expect(row).toMatchObject({ status: 'SENDING', attempts_total: 1 });
      expect(row.lease_until).not.toBeNull();
    }, RECOVERY);
    expect(receiver.requests).toHaveLength(1);
  });
});
