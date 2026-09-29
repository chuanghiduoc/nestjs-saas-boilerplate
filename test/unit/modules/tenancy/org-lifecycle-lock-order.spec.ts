import { describe, expect, it } from 'vitest';
import type { ConfigOf } from '../../../../src/core/config/index.js';
import type { RequestContext } from '../../../../src/core/context/index.js';
import type { UnitOfWork } from '../../../../src/core/database/index.js';
import type { EventPublisher } from '../../../../src/core/events/index.js';
import type { ScheduledTaskService } from '../../../../src/core/scheduler/index.js';
import type {
  ActorReauthorizer,
  Reauthorized,
} from '../../../../src/modules/tenancy/application/actor-reauthorizer.js';
import { OrgLifecycleService } from '../../../../src/modules/tenancy/application/org-lifecycle.service.js';
import { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import type {
  OrgRepository,
  OrgRow,
} from '../../../../src/modules/tenancy/ports/org-repository.js';
import type { MemberRow } from '../../../../src/modules/tenancy/ports/member-repository.js';
import { NoopTenancyTestHooks } from '../../../../src/modules/tenancy/ports/tenancy-test-hooks.js';
import type { tenancyConfig } from '../../../../src/modules/tenancy/tenancy.config.js';

type TenancyConfig = ConfigOf<typeof tenancyConfig>;

const ORG_ID = '01999999-0000-7000-8000-000000000001';
const NOW = new Date('2026-09-29T00:00:00Z');
const GRACE_SEC = 3600;
const MS_PER_SEC = 1000;
const row = (over: Partial<OrgRow> = {}): OrgRow => ({
  id: ORG_ID,
  name: 'Acme',
  version: 1,
  deletedAt: null,
  purgeAfter: null,
  createdByUserId: '1',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const actorRow: MemberRow = {
  id: '1',
  publicId: '01999999-0000-7000-8000-00000000000a',
  userId: '1',
  userPublicId: '01999999-0000-7000-8000-00000000000b',
  authUserId: null,
  externalSubject: 'test:owner',
  roleId: '1',
  rolePublicId: '01999999-0000-7000-8000-00000000000c',
  systemKey: 'OWNER',
  roleName: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};
const reauthorized: Reauthorized = {
  actor: actorRow,
  permissions: new Set(['org.delete', 'org.restore']),
  locked: [actorRow],
};

/**
 * Carry của Task 16 (spec §17 thứ tự khoá): xoá mềm khoá dòng org (`lockCurrent`, `FOR NO KEY UPDATE`) TRƯỚC mọi ghi
 * `scheduled_tasks`; khôi phục cũng vậy và là đường duy nhất gỡ treo lịch. Fake ghi thứ tự lời gọi trong transaction.
 */
function serviceRecording(initial: OrgRow) {
  const calls: string[] = [];
  const orgs = {
    lockCurrent: () => (calls.push('org.lock'), Promise.resolve(initial)),
    clockNow: () => (calls.push('org.clock'), Promise.resolve(NOW)),
    softDelete: (grace: number) => (
      calls.push('org.softDelete'),
      Promise.resolve(
        row({
          version: 2,
          deletedAt: NOW,
          purgeAfter: new Date(NOW.getTime() + grace * MS_PER_SEC),
        }),
      )
    ),
    restore: () => (
      calls.push('org.restore'),
      Promise.resolve(row({ version: 3 }))
    ),
  } as Pick<
    OrgRepository,
    'lockCurrent' | 'clockNow' | 'softDelete' | 'restore'
  > as OrgRepository;
  const schedules = {
    suspendAllForCurrentOrg: () => (
      calls.push('schedules.suspend'),
      Promise.resolve(1)
    ),
    resumeAllForCurrentOrg: () => (
      calls.push('schedules.resume'),
      Promise.resolve(1)
    ),
    syncCurrentOrg: () => (
      calls.push('schedules.sync'),
      Promise.resolve({ upserted: 0, removed: 0 })
    ),
  } as Pick<
    ScheduledTaskService,
    'suspendAllForCurrentOrg' | 'resumeAllForCurrentOrg' | 'syncCurrentOrg'
  > as ScheduledTaskService;
  const uow = {
    run: <T>(fn: () => Promise<T>) => {
      calls.push('tx.begin');
      return fn().then((v) => (calls.push('tx.commit'), v));
    },
  } as Pick<UnitOfWork, 'run'> as UnitOfWork;
  const events = {
    publish: () => (calls.push('outbox'), Promise.resolve('evt-1')),
  } as Pick<EventPublisher, 'publish'> as EventPublisher;
  const reauth = {
    require: () => (calls.push('actor.reauth'), Promise.resolve(reauthorized)),
  } as Pick<ActorReauthorizer, 'require'> as ActorReauthorizer;
  const ctx = {
    principal: () => ({ type: 'user', id: 'u1' }),
  } as Pick<RequestContext, 'principal'> as RequestContext;
  const service = new OrgLifecycleService(
    uow,
    ctx,
    orgs,
    schedules,
    events,
    reauth,
    new NoopTenancyTestHooks(),
    new TenancyMetrics(),
    { orgDeleteGraceSec: GRACE_SEC } as Pick<
      TenancyConfig,
      'orgDeleteGraceSec'
    > as TenancyConfig,
  );
  return { service, calls };
}

describe('OrgLifecycleService lock order (spec SP3 §9.4, §17)', () => {
  it('soft delete locks the org row before it suspends any schedule, and syncs Redis only after commit', async () => {
    const { service, calls } = serviceRecording(row());
    await service.softDelete({ kind: 'MEMBER' });
    expect(calls).toEqual([
      'tx.begin',
      'org.lock',
      'actor.reauth',
      'org.clock',
      'schedules.suspend',
      'org.softDelete',
      'outbox',
      'tx.commit',
      'schedules.sync',
    ]);
  });
  it('restore locks the org row before it resumes schedules', async () => {
    const { service, calls } = serviceRecording(
      row({
        deletedAt: NOW,
        purgeAfter: new Date(NOW.getTime() + GRACE_SEC * MS_PER_SEC),
      }),
    );
    await service.restore({ kind: 'MEMBER' });
    expect(calls.indexOf('org.lock')).toBeLessThan(
      calls.indexOf('schedules.resume'),
    );
    expect(calls.indexOf('schedules.sync')).toBeGreaterThan(
      calls.indexOf('tx.commit'),
    );
  });
  it('a second soft delete of a deleted org never touches schedules (T-12; restore is the only resume path)', async () => {
    const { service, calls } = serviceRecording(
      row({
        deletedAt: NOW,
        purgeAfter: new Date(NOW.getTime() + GRACE_SEC * MS_PER_SEC),
      }),
    );
    await expect(service.softDelete({ kind: 'MEMBER' })).rejects.toMatchObject({
      error: { status: 404 },
    });
    expect(calls.filter((c) => c.startsWith('schedules.'))).toEqual([]);
  });
});
