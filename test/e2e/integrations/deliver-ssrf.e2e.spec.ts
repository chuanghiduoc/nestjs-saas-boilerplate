import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deliveryRow,
  runDeliver,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../../support/webhook-receiver.js';

describe('SSRF at send time (spec SP6 §8.3, W-22, W-23)', () => {
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let org: SeededOrg;
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    // http + cổng của receiver được phép, nhưng KHÔNG allowlist 127.0.0.1: chỉ lookup lúc connect còn đứng giữa.
    app = await startIntegrationsApp({
      env: {
        RESILIENCE_ALLOWED_SCHEMES: 'http,https',
        RESILIENCE_ALLOWED_PORTS: `80,443,${receiver.port}`,
      },
    });
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
    await receiver?.close();
  });

  it('W-22 (DNS rebinding): a name that looked public at registration and resolves to loopback at send is SSRF_BLOCKED, with no connection', async () => {
    // Đăng ký đã qua `UrlGuard` với resolver giả (`PUBLIC_IP`); lúc gửi, DNS thật của máy phân giải `localhost` ra 127.0.0.1.
    const d = await seedPendingDelivery(app, org.orgId, {
      url: `http://localhost:${receiver.port}/hook`,
    });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      last_error: 'SSRF_BLOCKED',
    });
    expect(receiver.connections()).toBe(0);
  });
  it('an IP literal stored by direct SQL (bypassing the API guard) is still refused before any connection', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: `http://127.0.0.1:${receiver.port}/hook`,
    });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      last_error: 'SSRF_BLOCKED',
    });
    expect(receiver.connections()).toBe(0);
  });
});
