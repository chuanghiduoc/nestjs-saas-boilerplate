import type { INestApplication } from '@nestjs/common';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { request } from 'undici';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { undiciInstrumentationConfig } from '../../../src/core/observability/outbound-span-policy.js';
import { startIntegrationsApp } from '../../support/integrations-app.js';
import {
  deliveryRow,
  receiverEnv,
  runDeliver,
  seedPendingDelivery,
} from '../../support/integrations-delivery.js';
import {
  installOtelCapture,
  type OtelCapture,
} from '../../support/otel-capture.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../../support/webhook-receiver.js';

const CLIENT_DURATION = 'http.client.request.duration';

/**
 * I-A (review cuối 6C, spec SP6 §15): instrumentation undici của OTel (bật bởi `getNodeAutoInstrumentations`) không được ghi
 * URL của khách (path/query có thể chứa token) vào span, và không được gắn host của khách làm label metric (cardinality vô
 * hạn). Lần gửi webhook không có span client nào; provider khác giữ span nhưng mất query.
 */
describe('outbound telemetry never carries customer webhook URLs (I-A)', () => {
  let otel: OtelCapture;
  let instrumentation: UndiciInstrumentation;
  let app: INestApplication;
  let receiver: WebhookReceiver;
  let org: SeededOrg;
  const PATH_TOKEN = `ptok-${v7()}`;
  const QUERY_TOKEN = `qtok-${v7()}`;
  /** Mọi giá trị attribute của mọi span đã kết thúc, dạng chuỗi. */
  const spanValues = () =>
    otel
      .spanNames()
      .flatMap((n) => otel.spans(n))
      .flatMap((s) => Object.values(s.attributes).map(String));

  beforeAll(async () => {
    otel = installOtelCapture();
    instrumentation = new UndiciInstrumentation(undiciInstrumentationConfig);
    instrumentation.enable();
    receiver = await startWebhookReceiver();
    app = await startIntegrationsApp({ env: receiverEnv(receiver) });
    org = await seedOrg();
  });
  afterAll(async () => {
    instrumentation?.disable();
    await org?.dispose();
    await app?.close();
    await receiver?.close();
  });

  it('a webhook delivery to a URL with a path and a query token leaves no client span and no client metric point', async () => {
    otel.reset();
    const d = await seedPendingDelivery(app, org.orgId, {
      url: receiver.url(`/${PATH_TOKEN}?token=${QUERY_TOKEN}`),
    });
    await runDeliver(app, org.orgId, d.deliveryId);
    expect((await deliveryRow(org.orgId, d.deliveryId)).status).toBe(
      'SUCCEEDED',
    );
    expect(otel.spanNames()).toContain('integrations.deliver');
    for (const v of spanValues()) {
      expect(v).not.toContain(PATH_TOKEN);
      expect(v).not.toContain(QUERY_TOKEN);
    }
    expect(otel.spans('POST')).toEqual([]);
    const points = await otel.dataPoints(CLIENT_DURATION);
    expect(
      points.filter((p) => p.attributes['server.port'] === receiver.port),
    ).toEqual([]);
  });
  it('another outbound request keeps its client span and metric, without the query', async () => {
    otel.reset();
    const res = await request(receiver.url(`/other?token=${QUERY_TOKEN}`));
    await res.body.arrayBuffer();
    const [span] = otel.spans('GET');
    expect(span).toBeDefined();
    expect(span?.attributes['url.full']).toBe(receiver.url('/other'));
    expect(span?.attributes).not.toHaveProperty('url.query');
    for (const v of spanValues()) expect(v).not.toContain(QUERY_TOKEN);
    const points = await otel.dataPoints(CLIENT_DURATION);
    expect(
      points.some((p) => p.attributes['server.port'] === receiver.port),
    ).toBe(true);
  });
});
