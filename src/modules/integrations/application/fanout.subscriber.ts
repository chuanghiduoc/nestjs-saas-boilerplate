import { Injectable, Logger } from '@nestjs/common';
import {
  EventSubscriber,
  WEBHOOK_EVENTS,
  type EventEnvelope,
} from '../../../core/events/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { buildWebhookBody } from '../domain/webhook-payload.js';
import { integrationsSpan } from '../integrations-telemetry.js';
import { DeliverWebhookJob, deliveryJobId } from '../jobs.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';

/**
 * Spec SP6 §8.3 "Fan-out": chạy trong `UnitOfWork` + `Inbox.once` của `DeliverEventHandler` (R6-15) và OrgScope của event.
 * Chỉ DB + `SafeEnqueue` (ghi outbox, gửi sau commit): không I/O ngoài trong transaction.
 */
@Injectable()
@EventSubscriber({
  consumer: 'integrations.webhook-fanout',
  events: WEBHOOK_EVENTS,
})
export class WebhookFanoutSubscriber {
  private readonly logger = new Logger(WebhookFanoutSubscriber.name);
  constructor(
    private readonly endpoints: EndpointRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly enqueue: SafeEnqueue,
  ) {}

  async handle(e: EventEnvelope<unknown>): Promise<void> {
    await integrationsSpan(
      'integrations.fanout',
      () => this.fanOut(e),
      (n) => ({ 'webhook.deliveries': n }),
    );
  }

  private async fanOut(e: EventEnvelope<unknown>): Promise<number> {
    // `EventPublisher` đã từ chối phát event `webhook: true` ngoài org; tới đây là dòng outbox lạ: bỏ qua, có log.
    if (e.orgId === null) {
      this.logger.warn(
        { event: 'webhook_event_without_org', type: e.type },
        'webhook event without an organization skipped',
      );
      return 0;
    }
    const endpointIds = await this.endpoints.activeSubscribers(e.type);
    if (endpointIds.length === 0) return 0;
    const built = buildWebhookBody({
      type: e.type,
      version: e.version,
      timestamp: e.occurredAt,
      data: e.data,
    });
    if (built.kind === 'TOO_LARGE') {
      this.logger.error(
        {
          event: 'webhook_body_too_large',
          eventType: e.type,
          bytes: built.bytes,
        },
        'webhook body exceeds the format limit; not sent',
      );
      return 0;
    }
    const message = await this.deliveries.insertMessage({
      eventId: e.id,
      eventType: e.type,
      eventVersion: e.version,
      body: built.body,
    });
    const ids = await this.deliveries.insertDeliveries(message, endpointIds);
    for (const deliveryId of ids)
      await this.enqueue.enqueue(
        DeliverWebhookJob,
        { deliveryId },
        { jobId: deliveryJobId(deliveryId, 1) },
      );
    return ids.length;
  }
}
