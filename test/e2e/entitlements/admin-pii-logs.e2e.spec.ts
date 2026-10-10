import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import {
  outboxOf,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { baseTestEnv } from '../../support/env.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const FLUSH_MS = 1_000;
const PROCESS_ENV: Record<string, string> = {
  LOG_LEVEL: 'debug',
  HTTP_PORT: '0',
  HTTP_HOST: '127.0.0.1',
  HTTP_TRUST_PROXY: 'loopback',
};
const EVENT_TYPES = [
  'entitlements.override.set',
  'entitlements.override.removed',
  'entitlements.plan.changed',
] as const;

/** Spec SP4 §16 A9, §19, §20.4: `reason` của nhân viên không bao giờ vào log (kể cả DEBUG); event chỉ mang lý do của thao tác đã áp (R-X31). */
describe('no staff reason in logs or events of the 4C admin paths (real api process, production logging)', () => {
  let api: AppProcess | undefined;
  let base = '';
  let staff: SeededPrincipal | undefined;
  let org: SeededOrg | undefined;
  beforeAll(async () => {
    api = await startAppProcess('test/support/api-entry.ts', {
      ...baseTestEnv(),
      ...PROCESS_ENV,
    });
    base = `http://127.0.0.1:${api.port}`;
    staff = await seedStaffPrincipal();
    org = await seedOrg();
    await seedOrgEntitlement(org.orgId, 'free');
  });
  afterAll(async () => {
    await stopAppProcess(api);
    await org?.dispose();
    if (staff) await deleteSeededPrincipals([staff]);
  });

  it('200, 422, 412, 404 and 204 on the plan and override routes: no reason in any log line; applied writes publish exactly their own reason (R-X31), refused ones none', async () => {
    if (!staff || !org) throw new Error('fixture not seeded');
    const bearer = staff.bearer;
    const orgId = org.orgId;
    const reasons = ['a', 'b', 'c', 'd', 'e', 'f'].map(
      (n) => `pii-reason-${n}-${v7()}`,
    );
    const call = (
      method: 'PUT' | 'DELETE',
      path: string,
      ifMatch: string,
      body?: object,
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'if-match': ifMatch,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const admin = `/v1/admin/orgs/${orgId}/entitlements`;
    const statuses = [
      (
        await call('PUT', `${admin}/overrides/tenancy.seats`, 'W/"1"', {
          limit: 2,
          reason: reasons[0],
          expiresAt: null,
        })
      ).status,
      (
        await call('PUT', `${admin}/overrides/tenancy.seats`, 'W/"2"', {
          limit: 0,
          reason: reasons[1],
          expiresAt: null,
        })
      ).status,
      (
        await call('PUT', `${admin}/plan`, 'W/"1"', {
          planKey: 'pro',
          reason: reasons[2],
        })
      ).status,
      (
        await call('PUT', `${admin}/overrides/no.such_feature`, 'W/"2"', {
          enabled: true,
          reason: reasons[3],
          expiresAt: null,
        })
      ).status,
      (
        await call('PUT', `${admin}/plan`, 'W/"2"', {
          planKey: 'pro',
          reason: reasons[4],
        })
      ).status,
      (
        await call('DELETE', `${admin}/overrides/tenancy.seats`, 'W/"3"', {
          reason: reasons[5],
        })
      ).status,
    ];
    expect(statuses).toEqual([200, 422, 412, 404, 200, 204]);
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    const output = api?.output() ?? '';
    expect(output.length).toBeGreaterThan(0);
    for (const r of reasons)
      expect(output.includes(r), 'a staff reason reached the logs').toBe(false);
    const byType = await Promise.all(
      EVENT_TYPES.map((t) => outboxOf(orgId, t)),
    );
    // R-X31: override.set mang lý do a, plan.changed của PLATFORM_ADMIN mang e, override.removed mang f.
    expect(byType.map((rows) => rows.map((e) => e.payload.reason))).toEqual([
      [reasons[0]],
      [reasons[5]],
      [reasons[4]],
    ]);
    const serialized = JSON.stringify(byType);
    for (const r of reasons.slice(1, 4))
      expect(
        serialized.includes(r),
        'the reason of a refused request reached an event',
      ).toBe(false);
  });
});
