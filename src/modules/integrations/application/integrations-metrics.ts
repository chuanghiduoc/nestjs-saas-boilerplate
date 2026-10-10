import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { INTEGRATIONS_METER } from '../integrations-telemetry.js';

/** Spec SP6 §15: label là enum hữu hạn; không `orgId`, endpoint, URL. */
@Injectable()
export class IntegrationsMetrics {
  private readonly meter = metrics.getMeter(INTEGRATIONS_METER);
  readonly deliveries = this.meter.createCounter('webhook_deliveries_total', {
    description: 'Webhook attempts and claims by result',
  });
  readonly attemptDuration = this.meter.createHistogram(
    'webhook_delivery_attempt_duration_seconds',
    {
      description: 'Duration of one webhook request',
      unit: 's',
    },
  );
  readonly exhausted = this.meter.createCounter(
    'webhook_deliveries_exhausted_total',
    { description: 'Deliveries that used up their retry schedule' },
  );
  readonly autoDisabled = this.meter.createCounter(
    'webhook_endpoints_auto_disabled_total',
    { description: 'Endpoints disabled after failing too long' },
  );
  readonly lag = this.meter.createHistogram('webhook_delivery_lag_seconds', {
    description: 'From delivery creation to its success',
    unit: 's',
  });
  readonly localFaults = this.meter.createCounter(
    'webhook_local_faults_total',
    { description: 'Attempts that failed on our side, by reason' },
  );
  readonly catalogueUnknownTypes = this.meter.createCounter(
    'webhook_event_types_unknown_to_code_total',
    {
      description:
        'Rows of webhook_event_types that this code does not define (R-X30), counted at boot',
    },
  );
}
