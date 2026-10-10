import { Logger, type INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import type { JobContext } from '../../../src/core/queue/index.js';
import { IntegrationsSweepOrgHandler } from '../../../src/modules/integrations/application/sweep.handlers.js';
import { DeliveryRepository } from '../../../src/modules/integrations/ports/delivery-repository.js';
import { EndpointRepository } from '../../../src/modules/integrations/ports/endpoint-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import { deliveryRow } from '../../support/integrations-delivery.js';
import {
  inOrg,
  insertDelivery,
  insertEndpoint,
  insertMessage,
  orgQuery,
  orphanDeliveries,
} from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const GRACE_SEC = 60;
/** `INTEGRATIONS_MAX_LOCAL_FAILURES` mặc định (app test không đặt env này). */
const MAX_LOCAL = 5;
const ctxOf = (orgId: string): JobContext<unknown> => ({
  payload: {},
  meta: { orgId },
  jobId: 'test',
  attempt: 1,
  maxAttempts: 1,
  signal: new AbortController().signal,
  log: new Logger('test'),
});

describe('integrations.sweep-org (spec SP6 §8.3 "Sweep", §7.2, §7.3)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  const extra: SeededOrg[] = [];
  const sweepOf = (o: SeededOrg) =>
    app
      .get(OrgScope)
      .run(o.orgId, () =>
        app.get(IntegrationsSweepOrgHandler).handle(ctxOf(o.orgId)),
      );
  const sweep = () => sweepOf(org);
  const seedDeliveryIn = (o: SeededOrg) =>
    inOrg(o.orgId, async (c) => {
      const endpoint = await insertEndpoint(c, o.orgId);
      const d = await insertDelivery(c, o.orgId, {
        endpoint,
        message: await insertMessage(c, o.orgId),
      });
      return { endpoint, publicId: d.publicId };
    });
  const seedDelivery = () => seedDeliveryIn(org);
  const freshOrg = async () => {
    const o = await seedOrg();
    extra.push(o);
    return o;
  };
  beforeAll(async () => {
    app = await createTestApp(integrationsCoreImports(), {});
    org = await seedOrg();
  });
  afterAll(async () => {
    for (const o of extra) await o.dispose();
    await org?.dispose();
    await app?.close();
  });

  it('a PENDING delivery overdue by more than the grace gets a new job (lost job); a fresh one does not', async () => {
    const overdue = await seedDelivery();
    const fresh = await seedDelivery();
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET next_attempt_at = now() - make_interval(secs => $2) WHERE public_id = $1`,
      [overdue.publicId, GRACE_SEC * 2],
    );
    expect((await sweep()).requeued).toBeGreaterThanOrEqual(1);
    const jobs = await ownerQuery<{
      payload: { jobId: string; payload: { deliveryId: string } };
    }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->>'job' = 'integrations.deliver-webhook'`,
      [org.orgId],
    );
    const forIds = jobs.map((j) => j.payload.payload.deliveryId);
    expect(forIds).toContain(overdue.publicId);
    expect(forIds).not.toContain(fresh.publicId);
    expect(
      jobs.find((j) => j.payload.payload.deliveryId === overdue.publicId)
        ?.payload.jobId,
    ).toMatch(new RegExp(`^webhook-${overdue.publicId}-a1-s\\d+$`));
  });
  it('M5: takeOverdue caps one pass and touches what it took, so the next pass takes the rest — no starvation, no duplicate jobs', async () => {
    const o = await freshOrg();
    const ids = [
      (await seedDeliveryIn(o)).publicId,
      (await seedDeliveryIn(o)).publicId,
      (await seedDeliveryIn(o)).publicId,
    ];
    await orgQuery(
      o.orgId,
      `UPDATE webhook_deliveries SET next_attempt_at = now() - make_interval(secs => $1)`,
      [GRACE_SEC * 2],
    );
    const take = () =>
      app
        .get(OrgScope)
        .run(o.orgId, () =>
          app
            .get(UnitOfWork)
            .run(() => app.get(DeliveryRepository).takeOverdue(GRACE_SEC, 2)),
        );
    const first = await take();
    const second = await take();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((d) => d.publicId))).toEqual(
      new Set(ids),
    );
    expect(await take()).toEqual([]);
  });
  it('W-34 (lease part): an expired lease is our fault — RETRY_SCHEDULED with LEASE_EXPIRED, cycle_base + 1, local_failures + 1, endpoint untouched, job a<n+1>', async () => {
    const d = await seedDelivery();
    await orgQuery(
      org.orgId,
      `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = 3, cycle_base = 1,
         lease_until = now() - make_interval(secs => $2) WHERE public_id = $1`,
      [d.publicId, GRACE_SEC * 2],
    );
    expect((await sweep()).leases).toBe(1);
    expect(await deliveryRow(org.orgId, d.publicId)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      last_error: 'LEASE_EXPIRED',
      attempts_total: 3,
      cycle_base: 2,
      local_failures: 1,
    });
    const [ep] = await orgQuery<{ failing_since: Date | null; status: string }>(
      org.orgId,
      `SELECT failing_since, status FROM webhook_endpoints WHERE id = $1`,
      [d.endpoint.id],
    );
    expect(ep).toEqual({ failing_since: null, status: 'ACTIVE' });
    const [job] = await ownerQuery<{ payload: { jobId: string } }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2`,
      [org.orgId, d.publicId],
    );
    expect(job?.payload.jobId).toBe(`webhook-${d.publicId}-a4`);
  });
  it(`R-X35: a lease that expires ${MAX_LOCAL} times exhausts the delivery (recoverable) with one exhausted event; the endpoint stays healthy`, async () => {
    const o = await freshOrg();
    const d = await seedDeliveryIn(o);
    for (let i = 1; i <= MAX_LOCAL; i++) {
      // Mô phỏng một claim nữa rồi worker chết: attempts_total + 1, SENDING, lease đã quá hạn + grace.
      await orgQuery(
        o.orgId,
        `UPDATE webhook_deliveries SET status = 'SENDING', next_attempt_at = NULL, attempts_total = attempts_total + 1,
           lease_until = now() - make_interval(secs => $2) WHERE public_id = $1`,
        [d.publicId, GRACE_SEC * 2],
      );
      const r = await sweepOf(o);
      expect(r).toMatchObject({ leases: 1, exhausted: i < MAX_LOCAL ? 0 : 1 });
      expect(await deliveryRow(o.orgId, d.publicId)).toMatchObject({
        status: i < MAX_LOCAL ? 'RETRY_SCHEDULED' : 'EXHAUSTED',
        last_error: 'LEASE_EXPIRED',
        local_failures: i,
        lease_until: null,
      });
    }
    const exhausted = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'integrations.delivery.exhausted' AND payload->>'deliveryId' = $2`,
      [o.orgId, d.publicId],
    );
    expect(exhausted.map((e) => e.payload)).toEqual([
      {
        deliveryId: d.publicId,
        endpointId: d.endpoint.publicId,
        eventType: 'tenancy.org.updated',
        eventId: expect.any(String),
      },
    ]);
    const [ep] = await orgQuery<{ failing_since: Date | null; status: string }>(
      o.orgId,
      `SELECT failing_since, status FROM webhook_endpoints WHERE id = $1`,
      [d.endpoint.id],
    );
    expect(ep).toEqual({ failing_since: null, status: 'ACTIVE' });
  });
  it('§7.3: a soft-deleted endpoint due for purge is hard-deleted with its secrets and subscriptions; one with deliveries is postponed; no orphan delivery (R6C-3, R-X33)', async () => {
    const empty = await inOrg(org.orgId, (c) => insertEndpoint(c, org.orgId));
    const busy = await seedDelivery();
    for (const id of [empty.id, busy.endpoint.id])
      await orgQuery(
        org.orgId,
        `UPDATE webhook_endpoints SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
        [id],
      );
    expect(await sweep()).toMatchObject({ purged: 1, postponed: 1 });
    expect(
      await orgQuery(
        org.orgId,
        `SELECT 1 FROM webhook_endpoints WHERE id = $1`,
        [empty.id],
      ),
    ).toEqual([]);
    expect(
      await orgQuery(
        org.orgId,
        `SELECT 1 FROM webhook_endpoint_event_types WHERE endpoint_id = $1`,
        [empty.id],
      ),
    ).toEqual([]);
    const [kept] = await orgQuery<{ later: boolean }>(
      org.orgId,
      `SELECT purge_after > now() + interval '61 days' AS later FROM webhook_endpoints WHERE id = $1`,
      [busy.endpoint.id],
    );
    expect(kept?.later).toBe(true);
    expect(await orphanDeliveries(org.orgId)).toBe(0);
  });
  it('R-X33 / R6C-3: while a fan-out holds FOR KEY SHARE on an endpoint the sweep skips it; after the fan-out commits the endpoint is postponed, never deleted under its delivery', async () => {
    const o = await freshOrg();
    const e = await inOrg(o.orgId, (c) => insertEndpoint(c, o.orgId));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let holding!: () => void;
    const held = new Promise<void>((r) => {
      holding = r;
    });
    // Đúng các bước ghi của fan-out (Task 10) trong một transaction, dừng trước commit.
    const fanout = app.get(OrgScope).run(o.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        const ids = await app
          .get(EndpointRepository)
          .activeSubscribers('tenancy.org.updated');
        expect(ids).toEqual([e.id]);
        const message = await app.get(DeliveryRepository).insertMessage({
          eventId: v7(),
          eventType: 'tenancy.org.updated',
          eventVersion: 1,
          body: '{}',
        });
        await app.get(DeliveryRepository).insertDeliveries(message, ids);
        holding();
        await gate;
      }),
    );
    await held;
    // Xoá mềm đến hạn purge (UPDATE không đổi khoá: FOR NO KEY UPDATE, không xung đột với FOR KEY SHARE của fan-out).
    await orgQuery(
      o.orgId,
      `UPDATE webhook_endpoints SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 day' WHERE id = $1`,
      [e.id],
    );
    expect(await sweepOf(o)).toMatchObject({ purged: 0, postponed: 0 });
    release();
    await fanout;
    expect(await sweepOf(o)).toMatchObject({ purged: 0, postponed: 1 });
    expect(await orphanDeliveries(o.orgId)).toBe(0);
  });
  it('running the sweep twice in a row is idempotent (claims are SKIP LOCKED CAS; a second pass finds nothing new to fix)', async () => {
    const r = await sweep();
    expect(r.leases).toBe(0);
    expect(r.purged).toBe(0);
  });
});
