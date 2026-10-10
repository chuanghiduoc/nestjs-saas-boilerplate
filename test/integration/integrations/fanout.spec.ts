import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookStatsReader } from '../../../src/core/contracts/admin-readers.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import type { EventEnvelope } from '../../../src/core/events/index.js';
import { Inbox } from '../../../src/core/outbox/index.js';
import { WebhookFanoutSubscriber } from '../../../src/modules/integrations/application/fanout.subscriber.js';
import { IntegrationsReadersModule } from '../../../src/modules/integrations/integrations.module.js';
import { EndpointRepository } from '../../../src/modules/integrations/ports/endpoint-repository.js';
import { createTestApp } from '../../support/app-factory.js';
import { ownerQuery } from '../../support/identity-app.js';
import { integrationsCoreImports } from '../../support/integrations-app.js';
import {
  inOrg,
  insertEndpoint,
  orgQuery,
} from '../../support/integrations-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

const CONSUMER = 'integrations.webhook-fanout';
const updated = (
  orgId: string | null,
  data: unknown = { orgId, changed: ['name'] },
): EventEnvelope<unknown> => ({
  id: v7(),
  type: 'tenancy.org.updated',
  version: 1,
  occurredAt: '2026-10-07T01:02:03.456Z',
  orgId,
  actor: { type: 'user', id: v7() },
  aggregate: { type: 'organization', id: orgId ?? v7(), version: 2 },
  correlationId: 'test',
  causationId: null,
  data,
});

describe('webhook fan-out (spec SP6 §8.3 "Fan-out", W-40, R6-15)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let active: { id: string; publicId: string };
  const deliver = (e: EventEnvelope<unknown>) =>
    app
      .get(OrgScope)
      .run(org.orgId, () =>
        app
          .get(UnitOfWork)
          .run(() =>
            app
              .get(Inbox)
              .once(CONSUMER, e.id, () =>
                app.get(WebhookFanoutSubscriber).handle(e),
              ),
          ),
      );
  beforeAll(async () => {
    // Worker (subscriber) + module reader của api; không nạp `forApi()` (controller cần `HttpModule`, test này không có HTTP).
    app = await createTestApp(
      integrationsCoreImports([IntegrationsReadersModule]),
    );
    org = await seedOrg();
    await inOrg(org.orgId, async (c) => {
      active = await insertEndpoint(c, org.orgId, {
        eventTypes: ['tenancy.org.updated'],
      });
      await insertEndpoint(c, org.orgId, {
        eventTypes: ['tenancy.org.updated'],
        status: 'DISABLED',
      });
      await insertEndpoint(c, org.orgId, {
        eventTypes: ['tenancy.member.added'],
      });
      const deleted = await insertEndpoint(c, org.orgId, {
        eventTypes: ['tenancy.org.updated'],
      });
      await c.query(
        `UPDATE webhook_endpoints SET deleted_at = now(), purge_after = now() + interval '1 day' WHERE id = $1`,
        [deleted.id],
      );
    });
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });

  it('one message serialised once, one PENDING delivery per ACTIVE subscribed endpoint, and its first job (webhook-<id>-a1) via the outbox', async () => {
    const e = updated(org.orgId);
    expect(await deliver(e)).toBe('processed');
    const messages = await orgQuery<{
      id: string;
      event_type: string;
      body: string;
    }>(
      org.orgId,
      `SELECT id::text, event_type, body FROM webhook_messages WHERE event_id = $1`,
      [e.id],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe(
      `{"type":"tenancy.org.updated","version":1,"timestamp":"2026-10-07T01:02:03.456Z","data":{"orgId":"${org.orgId}","changed":["name"]}}`,
    );
    const deliveries = await orgQuery<{
      public_id: string;
      endpoint_id: string;
      status: string;
      attempts_total: number;
    }>(
      org.orgId,
      `SELECT public_id::text, endpoint_id::text, status, attempts_total FROM webhook_deliveries WHERE message_id = $1`,
      [messages[0]?.id],
    );
    expect(deliveries).toEqual([
      {
        public_id: expect.any(String),
        endpoint_id: active.id,
        status: 'PENDING',
        attempts_total: 0,
      },
    ]);
    const jobs = await ownerQuery<{
      payload: { job: string; jobId: string; payload: { deliveryId: string } };
    }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND type = 'core.job.deferred' AND payload->'payload'->>'deliveryId' = $2`,
      [org.orgId, deliveries[0]?.public_id],
    );
    expect(jobs.map((j) => j.payload.jobId)).toEqual([
      `webhook-${deliveries[0]?.public_id}-a1`,
    ]);
    expect(jobs[0]?.payload.job).toBe('integrations.deliver-webhook');
  });
  it('R6-15: delivering the same event twice is a no-op the second time (inbox of integrations.webhook-fanout)', async () => {
    const e = updated(org.orgId);
    expect(await deliver(e)).toBe('processed');
    expect(await deliver(e)).toBe('duplicate');
    expect(
      await orgQuery(
        org.orgId,
        `SELECT 1 FROM webhook_messages WHERE event_id = $1`,
        [e.id],
      ),
    ).toHaveLength(1);
  });
  it('an event nobody subscribed to writes nothing', async () => {
    const e = {
      ...updated(org.orgId),
      type: 'tenancy.org.restored',
      data: { orgId: org.orgId },
    };
    await deliver(e);
    expect(
      await orgQuery(
        org.orgId,
        `SELECT 1 FROM webhook_messages WHERE event_id = $1`,
        [e.id],
      ),
    ).toEqual([]);
  });
  it('a body over WEBHOOK_BODY_MAX_BYTES is skipped (design error, logged), nothing written', async () => {
    const e = updated(org.orgId, {
      orgId: org.orgId,
      changed: ['name'],
      pad: 'x'.repeat(262_144),
    });
    await deliver(e);
    expect(
      await orgQuery(
        org.orgId,
        `SELECT 1 FROM webhook_messages WHERE event_id = $1`,
        [e.id],
      ),
    ).toEqual([]);
  });
  it('WebhookStatsReader counts the live endpoints of the org in scope (deleted ones do not count)', async () => {
    const n = await app
      .get(OrgScope)
      .run(org.orgId, () => app.get(WebhookStatsReader).endpointCount());
    expect(n).toBe(3);
  });
  it('R-X33: the fan-out holds FOR KEY SHARE on the endpoints it picked until commit — FOR UPDATE (hard delete) waits, FOR NO KEY UPDATE (claim, PATCH) does not', async () => {
    const probe = (lock: 'FOR UPDATE' | 'FOR NO KEY UPDATE') =>
      inOrg(org.orgId, (c) =>
        c.query(
          `SELECT 1 FROM webhook_endpoints WHERE id = $1 ${lock} NOWAIT`,
          [active.id],
        ),
      ).then(
        () => 'free',
        (err: unknown) =>
          err instanceof Error && 'code' in err ? String(err.code) : 'unknown',
      );
    const seen = await app.get(OrgScope).run(org.orgId, () =>
      app.get(UnitOfWork).run(async () => {
        expect(
          await app
            .get(EndpointRepository)
            .activeSubscribers('tenancy.org.updated'),
        ).toEqual([active.id]);
        return {
          update: await probe('FOR UPDATE'),
          noKeyUpdate: await probe('FOR NO KEY UPDATE'),
        };
      }),
    );
    expect(seen).toEqual({ update: '55P03', noKeyUpdate: 'free' });
    expect(await probe('FOR UPDATE')).toBe('free');
  });
});
