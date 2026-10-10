import { describe, expect, it } from 'vitest';
import { defineConstraintErrors } from '../../../../src/core/database/index.js';
import { eventRegistry } from '../../../../src/core/events/index.js';
import { findKillSwitch } from '../../../../src/core/flags/index.js';
import { partitionedTableRegistry } from '../../../../src/core/partitions/index.js';
import { findJob } from '../../../../src/core/queue/index.js';
import { findOrgSweep } from '../../../../src/core/sweep/index.js';
import { WEBHOOK_PARTITIONS_LOCK_KEY } from '../../../../src/modules/integrations/constants.js';
import { IntegrationsErrors } from '../../../../src/modules/integrations/errors.js';
import '../../../../src/modules/integrations/events.js';
import {
  DeliverWebhookJob,
  IntegrationsSweep,
  IntegrationsSweepOrgJob,
  busyJobId,
  deliveryJobId,
  killedJobId,
  sweptJobId,
} from '../../../../src/modules/integrations/jobs.js';
import '../../../../src/modules/integrations/kill-switches.js';
import '../../../../src/modules/integrations/partitions.js';
import { WebhookPermissions } from '../../../../src/modules/integrations/permissions.js';

const ID = '0199a000-0000-7000-8000-000000000001';

describe('integrations definitions (spec SP6 §10, §9.1, §6.7)', () => {
  it('deliver and sweep-org both run for an inactive org (tenancy.org.deleted reaches the customer; its expired leases are rescheduled)', () => {
    expect(findJob('integrations.deliver-webhook')).toBe(DeliverWebhookJob);
    expect(DeliverWebhookJob).toMatchObject({
      onInactiveOrg: 'run',
      queue: { name: 'webhooks-out', kind: 'io' },
    });
    expect(IntegrationsSweepOrgJob).toMatchObject({
      onInactiveOrg: 'run',
      queue: { name: 'webhooks-out' },
    });
  });
  it('the sweep uses integrations_orgs_due with p_grace_sec by name (R-X14); its cron job runs on maintenance', () => {
    expect(findOrgSweep('integrations.sweep-orgs')).toBe(IntegrationsSweep);
    expect(IntegrationsSweep.definerFunction).toBe('integrations_orgs_due');
    expect(IntegrationsSweep.jobIdPrefix).toBe('integrations-sweep');
    expect(Object.keys(IntegrationsSweep.extraParams())).toEqual([
      'p_grace_sec',
    ]);
    expect(IntegrationsSweep.job.queue.name).toBe('maintenance');
  });
  it('job ids never contain ":" and never collide across the attempt, kill-switch, busy and sweep variants', () => {
    const ids = [
      deliveryJobId(ID, 3),
      killedJobId(ID, 3, 1_700_000_000_000),
      busyJobId(ID, 3, 1_700_000_000_000),
      sweptJobId(ID, 3, 42),
    ];
    expect(ids).toEqual([
      `webhook-${ID}-a3`,
      `webhook-${ID}-a3-k1700000000000`,
      `webhook-${ID}-a3-b1700000000000`,
      `webhook-${ID}-a3-s42`,
    ]);
    for (const id of ids) expect(id).not.toContain(':');
  });
  it('kill switch, partition entry and permission catalogue are registered', () => {
    expect(findKillSwitch('integrations.webhook_delivery')).toBeDefined();
    expect(
      partitionedTableRegistry().find(
        (d) => d.maintainFunction === 'webhook_partitions_maintain',
      ),
    ).toMatchObject({
      tables: ['webhook_messages', 'webhook_deliveries'],
      lockKey: WEBHOOK_PARTITIONS_LOCK_KEY,
    });
    expect(WebhookPermissions.entries['webhooks.write']).toMatchObject({
      apiKeyEligible: false,
      supportEligible: false,
      requires: ['webhooks.read'],
    });
    expect(WebhookPermissions.entries['webhooks.read']).toMatchObject({
      apiKeyEligible: true,
      supportEligible: true,
      requires: [],
    });
  });
  it('every integrations event is audited and never a webhook itself (R-X3)', () => {
    const mine = eventRegistry().filter((d) =>
      d.type.startsWith('integrations.'),
    );
    expect(mine.map((d) => d.type).sort()).toEqual([
      'integrations.delivery.exhausted',
      'integrations.endpoint.created',
      'integrations.endpoint.deleted',
      'integrations.endpoint.disabled',
      'integrations.endpoint.enabled',
      'integrations.endpoint.secret_rotated',
      'integrations.endpoint.updated',
    ]);
    for (const d of mine)
      expect({ audit: d.audit, webhook: d.webhook }).toEqual({
        audit: true,
        webhook: false,
      });
  });
  it('the catalogue FK is registered as webhook_event_type_unknown (a second registration throws)', () => {
    expect(() =>
      defineConstraintErrors({
        webhook_endpoint_event_types_type_fk:
          IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN,
      }),
    ).toThrow(
      'Constraint "webhook_endpoint_event_types_type_fk" already mapped',
    );
  });
});
