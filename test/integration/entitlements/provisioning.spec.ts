import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  OrgScope,
  UnitOfWork,
  pgFields,
} from '../../../src/core/database/index.js';
import type { EventEnvelope } from '../../../src/core/events/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { ProvisionOrgSubscriber } from '../../../src/modules/entitlements/application/provision-org.subscriber.js';
import { PurgeOrgHandler } from '../../../src/modules/tenancy/application/purge-orgs.handler.js';
import { OrgPurgeParticipantRegistry } from '../../../src/modules/tenancy/application/org-purge-participant.registry.js';
import { examplePlans } from '../../../src/plans.example.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  readOrgEntitlement,
  seedOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const createdEvent = (
  orgId: string,
): EventEnvelope<{ orgId: string; createdByUserId: string }> => ({
  id: v7(),
  type: 'tenancy.org.created',
  version: 1,
  occurredAt: new Date().toISOString(),
  orgId,
  actor: { type: 'user', id: v7() },
  aggregate: { type: 'organization', id: orgId, version: 1 },
  correlationId: 'test',
  causationId: null,
  data: { orgId, createdByUserId: v7() },
});
const jobCtx = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});
const makeDue = (orgId: string) =>
  withAppClient((c) =>
    inOrgTx(c, orgId, () =>
      c.query(
        `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
        [orgId],
      ),
    ),
  );
const planEvents = (orgId: string) =>
  ownerQuery<{ payload: { cause: string }; headers: { actorId: string } }>(
    `SELECT payload, headers FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed' ORDER BY id`,
    [orgId],
  );

describe('provisioning safety net and purge participant on the worker composition (spec SP4 §10.4, §13.2)', () => {
  let app: INestApplication;
  const orgs: SeededOrg[] = [];
  const handle = (orgId: string, e = createdEvent(orgId)) =>
    app
      .get(OrgScope)
      .run(orgId, () =>
        app
          .get(UnitOfWork)
          .run(() => app.get(ProvisionOrgSubscriber).handle(e)),
      );
  beforeAll(async () => {
    app = await createTestApp(entitlementsCoreImports(examplePlans));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
  });

  it('E-9: an org without a row is provisioned once with free/DEFAULT and one event; a replay is a no-op without event', async () => {
    const o = await seedOrg();
    orgs.push(o);
    await handle(o.orgId);
    await handle(o.orgId);
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'free',
      source: 'DEFAULT',
      version: 1,
    });
    const events = await planEvents(o.orgId);
    expect(events.map((e) => [e.payload.cause, e.headers.actorId])).toEqual([
      ['DEFAULT', 'entitlements.provision-org'],
    ]);
  });
  it('PA-12: an organization already purged is done: INFO log, no row, no retry', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const gone = v7();
    await expect(handle(gone)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      { event: 'entitlements_provision_skipped_org_gone' },
      expect.any(String),
    );
    expect(await readOrgEntitlement(gone)).toBeUndefined();
  });
  it('R-1: the participant is registered at order 100 after core.scheduled-tasks; a purge removes the row of that org only', async () => {
    const order = app
      .get(OrgPurgeParticipantRegistry)
      .participants()
      .map((p) => [p.key, p.order] as const);
    expect(order).toContainEqual(['entitlements', 100]);
    // Plan sau (SP6, SP7) thêm participant của mình; chỉ khẳng định vị trí tương đối và `order < 1000` (addendum 3D §A4).
    expect(order.findIndex(([k]) => k === 'core.scheduled-tasks')).toBeLessThan(
      order.findIndex(([k]) => k === 'entitlements'),
    );
    const a = await seedOrg();
    const b = await seedOrg();
    orgs.push(a, b);
    await seedOrgEntitlement(a.orgId, 'free');
    await seedOrgEntitlement(b.orgId, 'pro');
    await makeDue(a.orgId);
    expect(
      await app
        .get(OrgScope)
        .run(a.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(a.orgId))),
    ).toBe('purged');
    expect(await readOrgEntitlement(a.orgId)).toBeUndefined();
    expect(await readOrgEntitlement(b.orgId)).toMatchObject({ planKey: 'pro' });
  });
});

describe('without the entitlements participant a purge fails loud (spec SP4 criterion 10, R-1)', () => {
  let app: INestApplication;
  let o: SeededOrg;
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    o = await seedOrg();
    await seedOrgEntitlement(o.orgId, 'free');
    await makeDue(o.orgId);
  });
  afterAll(async () => {
    await o?.dispose();
    await app?.close();
  });
  it('the organization delete hits FK RESTRICT (23001) and nothing is removed', async () => {
    const err: unknown = await app
      .get(OrgScope)
      .run(o.orgId, () => app.get(PurgeOrgHandler).handle(jobCtx(o.orgId)))
      .catch((e: unknown) => e);
    expect(pgFields(err)?.sqlState).toBe('23001');
    expect(await readOrgEntitlement(o.orgId)).toMatchObject({
      planKey: 'free',
    });
  });
});
