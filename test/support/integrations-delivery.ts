import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { OrgScope } from '../../src/core/database/index.js';
import type { JobContext } from '../../src/core/queue/index.js';
import { DeliverWebhookHandler } from '../../src/modules/integrations/application/deliver-webhook.handler.js';
import { WebhookSecrets } from '../../src/modules/integrations/application/webhook-secrets.js';
import {
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
  orgQuery,
  type SeededEndpoint,
  type SeededMessage,
} from './integrations-seed.js';
import type { WebhookReceiver } from './webhook-receiver.js';

/** Cho phép gửi tới receiver trên 127.0.0.1 (chỉ test; production chỉ https và không allowlist loopback). */
export const receiverEnv = (r: WebhookReceiver): Record<string, string> => ({
  RESILIENCE_ALLOWED_SCHEMES: 'http,https',
  RESILIENCE_ALLOWED_PORTS: `80,443,${r.port}`,
  RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
});
export const jobCtx = (
  deliveryId: string,
  orgId: string,
): JobContext<{ deliveryId: string }> => ({
  payload: { deliveryId },
  meta: { orgId },
  jobId: `test-${v7()}`,
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
/** Một lần chạy handler gửi trong OrgScope của org (WorkerHost làm đúng việc này với `meta.orgId`). */
export const runDeliver = (
  app: INestApplication,
  orgId: string,
  deliveryId: string,
): Promise<void> =>
  app
    .get(OrgScope)
    .run(orgId, () =>
      app.get(DeliverWebhookHandler).handle(jobCtx(deliveryId, orgId)),
    );

export type SeededDelivery = {
  deliveryId: string;
  endpoint: SeededEndpoint;
  message: SeededMessage;
  secret: string;
};
/** Endpoint (URL cho trước) + một secret thật mã hoá bằng `WebhookSecrets` của app + message + delivery `PENDING` đến hạn. */
export async function seedPendingDelivery(
  app: INestApplication,
  orgId: string,
  o: {
    url: string;
    eventType?: string;
    body?: string;
    endpoint?: SeededEndpoint;
  },
): Promise<SeededDelivery> {
  const secrets = app.get(WebhookSecrets);
  const secret = secrets.generate();
  return inOrg(orgId, async (c) => {
    const endpoint =
      o.endpoint ??
      (await insertEndpoint(c, orgId, {
        url: o.url,
        eventTypes: [o.eventType ?? 'tenancy.org.updated'],
      }));
    if (!o.endpoint) {
      const secretPublicId = v7();
      await c.query(
        `INSERT INTO webhook_endpoint_secrets (public_id, org_id, endpoint_id, secret_enc) VALUES ($1, $2, $3, $4)`,
        [
          secretPublicId,
          orgId,
          endpoint.id,
          secrets.seal(secret, { orgId, secretPublicId }),
        ],
      );
    }
    const message = await insertMessage(c, orgId, {
      eventType: o.eventType,
      body: o.body ?? '{"type":"tenancy.org.updated","version":1}',
    });
    const { publicId } = await insertDelivery(c, orgId, { endpoint, message });
    return { deliveryId: publicId, endpoint, message, secret };
  });
}
export type DeliveryDbRow = {
  status: string;
  attempts_total: number;
  cycle_base: number;
  local_failures: number;
  last_error: string | null;
  last_status_code: number | null;
  next_in_ms: number | null;
  lease_until: Date | null;
  completed_at: Date | null;
};
export async function deliveryRow(
  orgId: string,
  deliveryId: string,
): Promise<DeliveryDbRow> {
  const [r] = await orgQuery<DeliveryDbRow>(
    orgId,
    `SELECT status, attempts_total, cycle_base, local_failures, last_error, last_status_code, lease_until, completed_at,
            (extract(epoch FROM next_attempt_at - clock_timestamp()) * 1000)::int AS next_in_ms
     FROM webhook_deliveries WHERE public_id = $1`,
    [deliveryId],
  );
  if (!r) throw new Error(`delivery ${deliveryId} not found`);
  return r;
}
/** Đưa lần hẹn kế về "đến hạn ngay" (thay vì chờ lịch). */
export const makeDue = (orgId: string, deliveryId: string) =>
  orgQuery(
    orgId,
    `UPDATE webhook_deliveries SET next_attempt_at = now() WHERE public_id = $1 AND next_attempt_at IS NOT NULL`,
    [deliveryId],
  );
