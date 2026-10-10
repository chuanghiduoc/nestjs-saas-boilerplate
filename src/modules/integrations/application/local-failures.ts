import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { DELIVERY_AGGREGATE, INTEGRATIONS_SYSTEM_ACTOR } from '../constants.js';
import { jitteredMs } from '../domain/retry-schedule.js';
import {
  classifyAttempt,
  localRetryLeft,
  type AttemptError,
} from '../domain/webhook-delivery.js';
import { DeliveryExhaustedEvent } from '../events.js';
import { integrationsConfig } from '../integrations.config.js';
import { DeliverWebhookJob, deliveryJobId } from '../jobs.js';
import {
  DeliveryRepository,
  type ClaimedDelivery,
} from '../ports/delivery-repository.js';

export type LocalFailureResult = 'local_fault' | 'exhausted' | 'fenced';

/**
 * Lỗi của ta (spec SP6 §7.2, R6-28, R-X35): không tiêu lịch (`cycle_base + 1`), không chạm endpoint, nhưng có đếm
 * (`local_failures + 1`); lần thứ `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED` + event, phát lại được bằng `retry`/`recover`.
 * Ba nơi gọi (handler gửi: lỗi của `HttpClient` và secret không giải mã được; sweep: lease hết hạn) nên luật nằm một chỗ.
 * Chạy trong transaction của caller: CAS có fencing, job kế qua outbox cùng transaction.
 */
@Injectable()
export class LocalFailures {
  constructor(
    private readonly deliveries: DeliveryRepository,
    private readonly enqueue: SafeEnqueue,
    private readonly events: EventPublisher,
    @Inject(integrationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  async record(
    c: ClaimedDelivery,
    error: AttemptError,
    statusCode: number | null,
  ): Promise<LocalFailureResult> {
    if (classifyAttempt(error) !== 'LOCAL')
      throw new Error(`${error} is not a fault on our side`);
    if (localRetryLeft(c.localFailures, this.cfg.maxLocalFailures)) {
      const delayMs = jitteredMs(this.cfg.localFaultRetrySec, Math.random);
      if (
        !(await this.deliveries.finish(c, c.attemptsTotal, {
          kind: 'RETRY',
          statusCode,
          error,
          delayMs,
          cycleBump: 1,
          localBump: 1,
        }))
      )
        return 'fenced';
      await this.enqueue.enqueue(
        DeliverWebhookJob,
        { deliveryId: c.publicId },
        { jobId: deliveryJobId(c.publicId, c.attemptsTotal + 1), delayMs },
      );
      return 'local_fault';
    }
    if (
      !(await this.deliveries.finish(c, c.attemptsTotal, {
        kind: 'EXHAUSTED',
        statusCode,
        error,
        localBump: 1,
      }))
    )
      return 'fenced';
    const info = await this.deliveries.describe(c);
    await this.events.publish(DeliveryExhaustedEvent, {
      data: {
        deliveryId: c.publicId,
        endpointId: info.endpointPublicId,
        eventType: info.eventType,
        eventId: info.eventId,
      },
      aggregate: {
        type: DELIVERY_AGGREGATE,
        id: c.publicId,
        version: c.attemptsTotal,
      },
      actor: INTEGRATIONS_SYSTEM_ACTOR,
    });
    return 'exhausted';
  }
}
