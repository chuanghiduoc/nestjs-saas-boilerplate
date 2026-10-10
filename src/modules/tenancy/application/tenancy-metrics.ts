import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { TENANCY_METER } from '../tenancy-telemetry.js';

export type OrgAccessResult =
  | 'granted'
  | 'not_found'
  | 'rate_limited'
  | 'user_key_rejected'
  | 'second_factor_required'
  | 'unavailable';
export type LastOwnerPath =
  'demote' | 'remove' | 'leave' | 'account_delete' | 'restore' | 'transfer';
export type AcquisitionResult =
  | 'accepted'
  | 'not_found'
  | 'invalidated'
  | 'email_mismatch'
  | 'already_member'
  | 'already_in_org'
  | 'seat_limit';
export type OrgApiKeyAuthResult =
  'ok' | 'invalid' | 'creator_banned' | 'creator_unverified' | 'unavailable';
export type SupportAccessResult =
  | 'granted'
  | 'no_grant'
  | 'no_second_factor'
  | 'second_factor_stale'
  | 'granter_not_owner';

/** Spec SP3 §16: label là enum hữu hạn; không `orgId`, user, email. */
@Injectable()
export class TenancyMetrics {
  private readonly meter = metrics.getMeter(TENANCY_METER);
  readonly invitations = this.meter.createCounter('tenancy_invitations_total', {
    description: 'Invitation accept attempts by result',
  });
  readonly seatLimitDenied = this.meter.createCounter(
    'tenancy_seat_limit_denied_total',
    {
      description:
        'Admissions refused because the organization has no free seat (spec SP4 §9.6), by admission source',
    },
  );
  readonly inviteLinkJoins = this.meter.createCounter(
    'tenancy_invite_link_joins_total',
    {
      description: 'Invite link join attempts by result',
    },
  );
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
        'Permission keys that no loaded catalogue declares (inert; warning only). source=boot: rows in permissions at boot; source=custom_role / source=delegation: first time a custom role / an API key or support grant holding the key is read in this process',
    },
  );
  readonly orgApiKeyAuth = this.meter.createCounter(
    'tenancy_org_api_key_auth_total',
    { description: 'Organization API key authentications by result' },
  );
  readonly supportAccess = this.meter.createCounter(
    'tenancy_support_access_requests_total',
    {
      description:
        'Requests of platform staff without a membership that looked for a support grant, by result',
    },
  );
  readonly supportGrantsRevokedOnRoleChange = this.meter.createCounter(
    'tenancy_support_grants_revoked_on_role_change_total',
    {
      description:
        'Support grants revoked because the platform role of their grantee was written',
    },
  );
}
