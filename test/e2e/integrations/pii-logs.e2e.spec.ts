import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startAppProcess,
  stopAppProcess,
  type AppProcess,
} from '../../support/app-process.js';
import { baseTestEnv } from '../../support/env.js';
import { receiverEnv } from '../../support/integrations-delivery.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import {
  startWebhookReceiver,
  type WebhookReceiver,
} from '../../support/webhook-receiver.js';

const FLUSH_MS = 1_000;
const QUERY_TOKEN = `qtok-${v7()}`;
const ORG_NAME_MARK = `PII Org ${v7().slice(-12)}`;

describe('no URL, secret, signature or webhook body in api/worker logs (spec SP6 §15, X-7)', () => {
  let api: AppProcess | undefined;
  let worker: AppProcess | undefined;
  let receiver: WebhookReceiver;
  let owner: SeededPrincipal;
  let org: SeededOrg;
  let base = '';
  const forbidden = new Set<string>([QUERY_TOKEN, ORG_NAME_MARK]);
  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    const env = {
      ...baseTestEnv(),
      ...receiverEnv(receiver),
      LOG_LEVEL: 'debug',
      HTTP_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      WORKER_QUEUES: 'events,notifications,webhooks-out',
      INTEGRATIONS_RETRY_SCHEDULE_SEC: '1',
      INTEGRATIONS_ENDPOINT_DISABLE_AFTER_SEC: '1',
    };
    [api, worker] = await Promise.all([
      startAppProcess('test/support/api-entry.ts', env),
      startAppProcess('test/support/worker-entry.ts', env),
    ]);
    base = `http://127.0.0.1:${api.port}`;
    owner = await seedUserPrincipal();
    org = await seedOrg({ owner: { authUserId: owner.authUserId } });
  });
  afterAll(async () => {
    await Promise.all([stopAppProcess(api), stopAppProcess(worker)]);
    await org?.dispose();
    await receiver?.close();
    await deleteSeededPrincipals([owner]);
  });

  it('create (one refused URL, one accepted with a query token), a failing then a succeeding delivery: no URL, secret, signature, webhook body or receiver response is logged', async () => {
    const call = (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${owner.bearer}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const hookUrl = `${receiver.url('/pii')}?token=${QUERY_TOKEN}`;
    forbidden.add(hookUrl);
    const refused = await call(
      'POST',
      `/v1/orgs/${org.orgId}/webhook-endpoints`,
      {
        url: `https://10.0.0.9/x?token=${QUERY_TOKEN}`,
        eventTypes: ['tenancy.org.updated'],
      },
    );
    expect(refused.status).toBe(422);
    const created = await call(
      'POST',
      `/v1/orgs/${org.orgId}/webhook-endpoints`,
      { url: hookUrl, eventTypes: ['tenancy.org.updated'] },
    );
    expect(created.status).toBe(201);
    const { secret } = (await created.json()) as { secret: string };
    forbidden.add(secret);
    forbidden.add(secret.slice('whsec_'.length));
    // Body của response receiver (có thể chứa dữ liệu của khách) không bao giờ được log (M2).
    const RECEIVER_BODY = `receiver-said-no-${v7()}`;
    forbidden.add(RECEIVER_BODY);
    receiver.respondWith({ status: 500, body: RECEIVER_BODY });
    const got = await call('GET', `/v1/orgs/${org.orgId}`);
    expect(
      (
        await call(
          'PATCH',
          `/v1/orgs/${org.orgId}`,
          { name: ORG_NAME_MARK },
          { 'if-match': got.headers.get('etag') ?? '' },
        )
      ).status,
    ).toBe(200);
    const reqs = await receiver.waitFor(2, 30_000);
    for (const r of reqs) {
      forbidden.add(
        String(r.headers['webhook-signature']).split(' ')[0]?.split(',')[1] ??
          '',
      );
      // Marker của body webhook (M2): chính chuỗi body đã nhận — duy nhất (mang `timestamp` và id của event) và đúng là thứ
      // phải không lọt vào log. Payload `tenancy.org.updated` không mang tên org, nên tên org không phải marker của body.
      forbidden.add(r.body);
    }
    expect(reqs[0]?.body).toBe(reqs[1]?.body);
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    const logs = `${api?.output() ?? ''}\n${worker?.output() ?? ''}`;
    for (const value of forbidden)
      if (value.length > 0)
        expect(logs, `log leaks ${value.slice(0, 12)}…`).not.toContain(value);
    expect(logs).toContain('webhook_url_refused');
  });
});
