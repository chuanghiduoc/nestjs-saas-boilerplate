import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { ProvisionOrgSubscriber } from '../../../src/modules/entitlements/application/provision-org.subscriber.js';
import { examplePlans } from '../../../src/plans.example.js';
import { startEntitlementsApp } from '../../support/entitlements-app.js';
import {
  deleteOrgEntitlement,
  readOrgEntitlement,
} from '../../support/entitlements-seed.js';
import { ownerQuery } from '../../support/identity-app.js';
import { authed } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { deleteTenancyUsersOf, purgeOrgs } from '../../support/tenancy-seed.js';

const planEvents = (orgId: string) =>
  ownerQuery<{
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  }>(
    `SELECT payload, headers FROM outbox_events WHERE org_id = $1 AND type = 'entitlements.plan.changed' ORDER BY id`,
    [orgId],
  );

describe('every organization has exactly one entitlement row (spec SP4 criterion 1, S4-D9, PA-11, HT-3)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  const created: string[] = [];
  const createOrg = async () => {
    const r = await authed(app, p)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${randomUUID()}`)
      .send({ name: 'Entitled' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    return r.body.id as string;
  };
  /** Chờ subscriber dự phòng (worker events chạy trong cùng process) xử lý xong `tenancy.org.created` của org. */
  const waitSafetyNet = async (orgId: string) => {
    const [createdEvent] = await ownerQuery<{ event_id: string }>(
      `SELECT event_id::text AS event_id FROM outbox_events WHERE org_id = $1 AND type = 'tenancy.org.created'`,
      [orgId],
    );
    await vi.waitFor(
      async () =>
        expect(
          await ownerQuery(
            `SELECT 1 FROM processed_events WHERE consumer = 'entitlements.provision-org' AND event_id = $1`,
            [createdEvent?.event_id],
          ),
        ).toHaveLength(1),
      { timeout: 30_000, interval: 250 },
    );
  };
  beforeAll(async () => {
    app = await startEntitlementsApp(examplePlans);
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    await purgeOrgs(created);
    await deleteTenancyUsersOf([p.authUserId]);
    await app?.close();
    await deleteSeededPrincipals([p]);
  });

  it('POST /v1/orgs commits the row with the default plan and one plan.changed by the creator; the safety net then adds nothing', async () => {
    const orgId = await createOrg();
    expect(await readOrgEntitlement(orgId)).toEqual({
      planKey: 'free',
      source: 'DEFAULT',
      sourceRef: null,
      reason: null,
      lastBillingSeq: null,
      version: 1,
    });
    await waitSafetyNet(orgId);
    const events = await planEvents(orgId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      orgId,
      fromPlan: null,
      toPlan: 'free',
      cause: 'DEFAULT',
      causeRef: null,
    });
    expect([events[0]?.headers.actorType, events[0]?.headers.actorId]).toEqual([
      'user',
      p.authUserId,
    ]);
    const r = await authed(app, p).get(`/v1/orgs/${orgId}/entitlements`);
    expect([r.status, r.body.plan.key, r.body.plan.source]).toEqual([
      200,
      'free',
      'DEFAULT',
    ]);
  });
  it('HT-3: a lost row answers 503; the safety-net subscriber restores it and the route answers 200 again', async () => {
    const orgId = await createOrg();
    // Subscriber đã xử lý event tạo org TRƯỚC khi xoá dòng: không có lần giao nào chen vào giữa xoá và GET (không flaky).
    await waitSafetyNet(orgId);
    await deleteOrgEntitlement(orgId);
    expect(
      (await authed(app, p).get(`/v1/orgs/${orgId}/entitlements`)).status,
    ).toBe(503);
    await app.get(OrgScope).run(orgId, () =>
      app.get(UnitOfWork).run(() =>
        app.get(ProvisionOrgSubscriber).handle({
          id: v7(),
          type: 'tenancy.org.created',
          version: 1,
          occurredAt: new Date().toISOString(),
          orgId,
          actor: { type: 'user', id: p.authUserId },
          aggregate: { type: 'organization', id: orgId, version: 1 },
          correlationId: 'ht-3',
          causationId: null,
          data: { orgId, createdByUserId: v7() },
        }),
      ),
    );
    const r = await authed(app, p).get(`/v1/orgs/${orgId}/entitlements`);
    expect([r.status, r.body.plan.key]).toEqual([200, 'free']);
    expect((await planEvents(orgId)).map((e) => e.headers.actorId)).toEqual([
      p.authUserId,
      'entitlements.provision-org',
    ]);
  });
});
