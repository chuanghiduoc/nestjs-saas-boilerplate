import { describe, expect, it } from 'vitest';
import { findEvent } from '../../../../src/core/events/index.js';
import { partitionedTableRegistry } from '../../../../src/core/partitions/index.js';
import type { PlatformAccessEntry } from '../../../../src/modules/identity/index.js';
import { AUDIT_PARTITIONS_LOCK_KEY } from '../../../../src/modules/audit/constants.js';
import {
  STAFF_CREDENTIAL_KINDS,
  StaffAccessRecordedEvent,
} from '../../../../src/modules/audit/events.js';
import '../../../../src/modules/audit/partitions.js';
import { AuditPermissions } from '../../../../src/modules/audit/permissions.js';

describe('audit definitions (spec SP6 §6.7, §9.1, §10)', () => {
  it('one maintenance entry covers both tables with lock key 6001', () => {
    expect(
      partitionedTableRegistry().filter(
        (d) => d.maintainFunction === 'audit_partitions_maintain',
      ),
    ).toEqual([
      expect.objectContaining({
        tables: ['audit_logs', 'platform_audit_logs'],
        lockKey: AUDIT_PARTITIONS_LOCK_KEY,
      }),
    ]);
  });
  it('audit.read: api-key eligible, not support eligible, granted to ADMIN only', () => {
    expect(AuditPermissions.entries['audit.read']).toMatchObject({
      apiKeyEligible: true,
      supportEligible: false,
      ownerOnly: false,
      grantTo: { admin: true, member: false },
      requires: [],
    });
  });
  it('audit.staff_access.recorded is audited, never a webhook, and registered', () => {
    expect(findEvent('audit.staff_access.recorded', 1)).toBe(
      StaffAccessRecordedEvent,
    );
    expect(StaffAccessRecordedEvent).toMatchObject({
      audit: true,
      webhook: false,
    });
  });
  it('params: key pattern, value cap and count cap are enforced by the schema (a violation is a 503 at the guard)', () => {
    const base = {
      method: 'GET',
      route: 'v1/admin/orgs/:orgId',
      credentialKind: 'BEARER_SESSION',
    } as const;
    const ok = StaffAccessRecordedEvent.schema.safeParse({
      ...base,
      params: { orgId: 'x'.repeat(256) },
    });
    expect(ok.success).toBe(true);
    for (const params of [
      { orgId: 'x'.repeat(257) },
      { 'org-id': '1' },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, '1'])),
    ])
      expect(
        StaffAccessRecordedEvent.schema.safeParse({ ...base, params }).success,
      ).toBe(false);
  });
  it('the credential kinds are exactly the session kinds of PlatformAccessEntry', () => {
    const kinds: readonly PlatformAccessEntry['credentialKind'][] =
      STAFF_CREDENTIAL_KINDS;
    expect([...kinds].sort()).toEqual([
      'BEARER_SESSION',
      'EXTERNAL_BEARER',
      'EXTERNAL_COOKIE',
      'SESSION_COOKIE',
    ]);
  });
});
