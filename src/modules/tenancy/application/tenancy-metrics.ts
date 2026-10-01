import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { TENANCY_METER } from '../tenancy-telemetry.js';

export type OrgAccessResult =
  | 'granted'
  | 'not_found'
  | 'rate_limited'
  | 'user_key_rejected'
  | 'unavailable';
export type LastOwnerPath =
  'demote' | 'remove' | 'leave' | 'account_delete' | 'restore';

/** Spec SP3 §16: label là enum hữu hạn; không `orgId`, user, email. */
@Injectable()
export class TenancyMetrics {
  private readonly meter = metrics.getMeter(TENANCY_METER);
  readonly orgAccess = this.meter.createCounter('tenancy_org_access_total', {
    description: 'Organization context resolutions by access path and result',
  });
  readonly orgContextDuration = this.meter.createHistogram(
    'tenancy_org_context_duration_seconds',
    { description: 'Hot-path membership lookup duration', unit: 's' },
  );
  readonly policyDenied = this.meter.createCounter(
    'tenancy_policy_denied_total',
    { description: 'PoliciesGuard denials by reason' },
  );
  readonly escalationDenied = this.meter.createCounter(
    'tenancy_escalation_denied_total',
    { description: 'Escalation rule denials by rule' },
  );
  readonly lastOwnerBlocked = this.meter.createCounter(
    'tenancy_last_owner_blocked_total',
    { description: 'Operations refused to keep an owner, by path' },
  );
  readonly orgPurge = this.meter.createCounter('tenancy_org_purge_total', {
    description: 'Organization purge job outcomes',
  });
  readonly orgPurgeFailed = this.meter.createCounter(
    'tenancy_org_purge_failed_total',
    { description: 'Organization purge attempts that failed (alert)' },
  );
  readonly catalogueMismatch = this.meter.createCounter(
    'tenancy_catalogue_mismatch_total',
    {
      description:
        'Boots refused because the permission catalogue differs from the database',
    },
  );
  readonly catalogueOrphanKeys = this.meter.createCounter(
    'tenancy_catalogue_orphan_keys',
    {
      description:
        'Permission keys that no loaded catalogue declares (inert; warning only). source=boot: rows in permissions at boot; source=custom_role: first time a custom role holding the key is read in this process',
    },
  );
}
