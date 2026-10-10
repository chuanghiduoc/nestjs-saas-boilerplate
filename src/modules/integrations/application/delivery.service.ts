import { Inject, Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import type { DeliveryStatus } from '../domain/webhook-delivery.js';
import {
  WEBHOOK_TEST_EVENT_TYPE,
  WEBHOOK_TEST_EVENT_VERSION,
  buildWebhookBody,
} from '../domain/webhook-payload.js';
import { IntegrationsErrors } from '../errors.js';
import { integrationsConfig } from '../integrations.config.js';
import { DeliverWebhookJob, deliveryJobId } from '../jobs.js';
import {
  DeliveryRepository,
  type DeliveryView,
} from '../ports/delivery-repository.js';
import {
  EndpointRepository,
  type EndpointRow,
} from '../ports/endpoint-repository.js';

const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });
const disabled = () =>
  new AppError(IntegrationsErrors.WEBHOOK_ENDPOINT_DISABLED, {
    expected: true,
  });

/** Spec SP6 §8.3 "Dead-letter" (S6-A33: tập `EXHAUSTED`/`CANCELLED` trong DB), "Gửi thử". */
@Injectable()
export class DeliveryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly deliveries: DeliveryRepository,
    private readonly endpoints: EndpointRepository,
    private readonly enqueue: SafeEnqueue,
    @Inject(integrationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  async list(
    endpointPublicId: string,
    q: {
      status?: DeliveryStatus;
      limit: number;
      after?: { createdAt: string; publicId: string };
    },
  ): Promise<{ rows: DeliveryView[]; hasMore: boolean }> {
    return this.uow.run(async () => {
      const ep = await this.endpoints.find(endpointPublicId, 'NONE');
      if (!ep) throw notFound();
      const rows = await this.deliveries.listByEndpoint(ep.id, {
        ...q,
        limit: q.limit + 1,
      });
      return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
    });
  }

  async get(publicId: string): Promise<DeliveryView> {
    const v = await this.uow.run(() => this.deliveries.view(publicId));
    if (!v) throw notFound();
    return v;
  }

  async retry(publicId: string): Promise<DeliveryView> {
    return this.uow.run(async () => {
      const v = await this.deliveries.view(publicId);
      if (!v) throw notFound();
      // Thứ tự khoá của đường API: endpoint (`FOR SHARE`: chặn tắt endpoint giữa chừng) rồi delivery (CAS).
      await this.activeEndpoint(v.endpointPublicId);
      const r = await this.deliveries.requeue(publicId);
      if (!r)
        throw new AppError(IntegrationsErrors.WEBHOOK_DELIVERY_NOT_RETRYABLE, {
          expected: true,
        });
      await this.enqueue.enqueue(
        DeliverWebhookJob,
        { deliveryId: publicId },
        { jobId: deliveryJobId(publicId, r.attemptsTotal + 1) },
      );
      const after = await this.deliveries.view(publicId);
      if (!after)
        throw new Error(
          `delivery ${publicId} vanished inside its retry transaction`,
        );
      return after;
    });
  }

  async recover(
    endpointPublicId: string,
    since: Date,
  ): Promise<{ requeued: number; hasMore: boolean }> {
    return this.uow.run(async () => {
      const ep = await this.activeEndpoint(endpointPublicId);
      const sinceIso = since.toISOString();
      const rows = await this.deliveries.recover(
        ep.id,
        sinceIso,
        this.cfg.recoverBatchMax,
      );
      for (const r of rows)
        await this.enqueue.enqueue(
          DeliverWebhookJob,
          { deliveryId: r.publicId },
          { jobId: deliveryJobId(r.publicId, r.attemptsTotal + 1) },
        );
      return {
        requeued: rows.length,
        hasMore: await this.deliveries.hasRecoverable(ep.id, sinceIso),
      };
    });
  }

  async sendTest(endpointPublicId: string): Promise<DeliveryView> {
    return this.uow.run(async () => {
      const ep = await this.activeEndpoint(endpointPublicId);
      const built = buildWebhookBody({
        type: WEBHOOK_TEST_EVENT_TYPE,
        version: WEBHOOK_TEST_EVENT_VERSION,
        timestamp: new Date().toISOString(),
        data: { endpointId: ep.publicId },
      });
      if (built.kind === 'TOO_LARGE')
        throw new Error(
          'the webhook.test body can never exceed the format limit',
        );
      const message = await this.deliveries.insertMessage({
        eventId: v7(),
        eventType: WEBHOOK_TEST_EVENT_TYPE,
        eventVersion: WEBHOOK_TEST_EVENT_VERSION,
        body: built.body,
      });
      const [deliveryId] = await this.deliveries.insertDeliveries(message, [
        ep.id,
      ]);
      if (!deliveryId)
        throw new Error('webhook.test delivery insert returned no id');
      await this.enqueue.enqueue(
        DeliverWebhookJob,
        { deliveryId },
        { jobId: deliveryJobId(deliveryId, 1) },
      );
      const v = await this.deliveries.view(deliveryId);
      if (!v)
        throw new Error(
          `webhook.test delivery ${deliveryId} vanished inside its transaction`,
        );
      return v;
    });
  }

  /** Endpoint chưa xoá (404 nếu không) và `ACTIVE` (409 nếu không), khoá `FOR SHARE` tới hết transaction. */
  private async activeEndpoint(publicId: string): Promise<EndpointRow> {
    const ep = await this.endpoints.find(publicId, 'SHARE');
    if (!ep) throw notFound();
    if (ep.status !== 'ACTIVE') throw disabled();
    return ep;
  }
}
