import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

const EXAMPLE_METER = 'example';

/** Spec SP7 §18: không nhãn (không `orgId`, không tên project). */
@Injectable()
export class ExampleMetrics {
  private readonly meter = metrics.getMeter(EXAMPLE_METER);
  readonly purged = this.meter.createCounter('example_projects_purged_total', {
    description: 'Archived projects deleted after the retention period',
  });
}
