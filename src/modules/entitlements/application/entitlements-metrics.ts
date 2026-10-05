import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { ENTITLEMENTS_METER } from '../entitlements-telemetry.js';

/**
 * Tập kết quả hữu hạn của `entitlements_plan_assignments_total{cause, result}` (spec §19). `precondition_failed` (412 của
 * nhân viên, E-7) thêm vào tập của spec §19 để mọi nhánh của `assign` đều được đếm (Task 14 sửa spec).
 */
export type AssignmentMetricResult =
  | 'applied'
  | 'unchanged'
  | 'stale'
  | 'rejected_retired'
  | 'unknown_plan'
  | 'row_missing'
  | 'precondition_failed';

/** Spec §19: không label `orgId`; `feature` là key của catalogue hữu hạn. Metric quota/ghế thuộc 4B. */
@Injectable()
export class EntitlementsMetrics {
  private readonly meter = metrics.getMeter(ENTITLEMENTS_METER);
  readonly featureDenied = this.meter.createCounter(
    'entitlements_feature_denied_total',
    {
      description:
        'Requests refused because a feature is off for the organization',
    },
  );
  readonly snapshotReadDuration = this.meter.createHistogram(
    'entitlements_snapshot_read_duration_seconds',
    {
      description:
        'Duration of one entitlement snapshot read (the cache trigger of ADR 0018)',
      unit: 's',
    },
  );
  readonly planAssignments = this.meter.createCounter(
    'entitlements_plan_assignments_total',
    { description: 'PlanAssignments.assign outcomes by cause and result' },
  );
  readonly rowMissing = this.meter.createCounter(
    'entitlements_row_missing_total',
    {
      description:
        'Reads of an organization without an org_entitlements row (alert)',
    },
  );
  readonly catalogueMismatch = this.meter.createCounter(
    'entitlements_catalogue_mismatch_total',
    {
      description:
        'Boots refused because the catalogues differ from the database',
    },
  );
  readonly catalogueUnknownFeatures = this.meter.createCounter(
    'entitlements_catalogue_unknown_features_total',
    {
      description:
        'Feature rows found only in the database at boot (a newer release migrated first; R-X30)',
    },
  );
  readonly catalogueUnknownPlans = this.meter.createCounter(
    'entitlements_catalogue_unknown_plans_total',
    {
      description:
        'Plan rows found only in the database at boot (a newer release migrated first; R-X30)',
    },
  );
}
