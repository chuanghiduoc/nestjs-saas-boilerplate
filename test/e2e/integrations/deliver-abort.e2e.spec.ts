import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope } from '../../../src/core/database/index.js';
import {
  HttpClient,
  type HttpRequestInit,
} from '../../../src/core/resilience/index.js';
import { DeliverWebhookHandler } from '../../../src/modules/integrations/application/deliver-webhook.handler.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import {
  deliveryRow,
  jobCtx,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/**
 * M2 (review bảo mật 6C): tắt worker huỷ cả request đang bay. Signal của job phải tới `HttpClient`; request bị huỷ không ghi
 * kết quả (delivery giữ `SENDING` + lease, sweep lấy lại là LEASE_EXPIRED — lỗi của ta).
 */
describe('a worker shutdown aborts the in-flight webhook request (M2)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let seen: AbortSignal | undefined;
  let started!: () => void;
  const inFlight = new Promise<void>((r) => {
    started = r;
  });
  beforeAll(async () => {
    const fake = {
      request: (
        _provider: string,
        _url: string,
        init: HttpRequestInit = {},
      ) => {
        seen = init.signal;
        started();
        // Chỉ trả về khi bị huỷ: không có signal thì treo tới timeout của ca (RED rõ ràng).
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        });
      },
    };
    app = await startIntegrationsApp({
      configure: (b) => b.overrideProvider(HttpClient).useValue(fake),
    });
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it('aborting the job signal rejects the request with its reason; no result is written', async () => {
    const d = await seedPendingDelivery(app, org.orgId, {
      url: 'https://hooks.example.test/abort',
    });
    const controller = new AbortController();
    const ctx = {
      ...jobCtx(d.deliveryId, org.orgId),
      signal: controller.signal,
    };
    const run = app
      .get(OrgScope)
      .run(org.orgId, () => app.get(DeliverWebhookHandler).handle(ctx));
    run.catch(() => undefined);
    await inFlight;
    expect(seen).toBeInstanceOf(AbortSignal);
    const reason = new Error('worker shutting down');
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(await deliveryRow(org.orgId, d.deliveryId)).toMatchObject({
      status: 'SENDING',
      attempts_total: 1,
    });
  }, 15_000);
});
