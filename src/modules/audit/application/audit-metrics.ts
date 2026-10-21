import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { AUDIT_METER } from '../audit-telemetry.js';

/** Label `reason` của `audit_record_failures_total` (R-X37: cảnh báo giao lỗi của `audit.recorder`). */
export const AUDIT_RECORD_FAILURE_REASONS = [
  'unrecordable',
  'database',
  'other',
] as const;

/** Spec SP6 §15: label là enum hữu hạn (`scope` ∈ `org` | `platform`); không `orgId`, actor, `type` của event. */
@Injectable()
export class AuditMetrics {
  private readonly meter = metrics.getMeter(AUDIT_METER);
  readonly records = this.meter.createCounter('audit_records_total', {
    description: 'Audit rows written, by scope',
  });
  readonly recordFailures = this.meter.createCounter(
    'audit_record_failures_total',
    { description: 'Failed deliveries to audit.recorder, by reason' },
  );
  readonly staffAccess = this.meter.createCounter('audit_staff_access_total', {
    description:
      'Platform staff accesses recorded before the handler, by scope',
  });
}
