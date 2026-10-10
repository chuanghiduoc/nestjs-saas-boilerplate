import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { Mailpit } from '../support/mailpit.js';
import {
  PARTITIONED_TABLES_6C,
  PARTITION_OWNER_FUNCTIONS_6C,
  SWEEP_DEFINER_FUNCTIONS_6C,
} from '../support/core-catalog.js';
import { PASSWORD, verifiedDevice } from './smoke-devices.js';
import {
  assertCleanLogs,
  compose,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

const Received = z.array(
  z.object({
    path: z.string(),
    headers: z.record(z.string(), z.unknown()),
    body: z.string(),
  }),
);
const DELIVERY_WAIT_MS = 60_000;
const received = () =>
  Received.parse(
    JSON.parse(
      compose([
        'exec',
        '-T',
        'webhook-receiver',
        '/nodejs/bin/node',
        '-e',
        "fetch('https://localhost/received').then(r=>r.text()).then(t=>process.stdout.write(t))",
      ]),
    ),
  );

/** Plan 6C trên image production (`NODE_ENV=production`, TLS mọi nơi, PgBouncer, migrate từ `dist`). */
describe('prod-like smoke: plan 6C (integrations)', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const since = new Date().toISOString();
  const mail = new Mailpit(mailpitApiUrl);
  const forbidden: string[] = [PASSWORD];

  it('the webhook schema migrated from dist: partitioned tables owned by partition_owner, definer functions with their owners, catalogue rows', () => {
    for (const t of PARTITIONED_TABLES_6C) {
      expect(
        psql(
          `SELECT pg_get_userbyid(relowner) || ':' || relkind::text FROM pg_class WHERE relname = '${t}'`,
        ),
      ).toBe('partition_owner:p');
      expect(
        Number(
          psql(
            `SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.${t}'::regclass`,
          ),
        ),
      ).toBeGreaterThanOrEqual(4);
    }
    for (const f of PARTITION_OWNER_FUNCTIONS_6C)
      expect(
        psql(
          `SELECT pg_get_userbyid(proowner) || ':' || prosecdef::text || ':' || array_to_string(proconfig, ',') FROM pg_proc WHERE proname = '${f}'`,
        ),
      ).toBe('partition_owner:true:search_path="",lock_timeout=5s');
    for (const f of SWEEP_DEFINER_FUNCTIONS_6C)
      expect(
        psql(
          `SELECT pg_get_userbyid(proowner) || ':' || prosecdef::text FROM pg_proc WHERE proname = '${f}'`,
        ),
      ).toBe('sweep_definer:true');
    expect(
      psql(
        `SELECT count(*) FROM webhook_event_types WHERE type LIKE 'tenancy.%'`,
      ),
    ).toBe('6');
    expect(
      psql(
        `SELECT string_agg(key, ',' ORDER BY key) FROM permissions WHERE key LIKE 'webhooks.%'`,
      ),
    ).toBe('webhooks.read,webhooks.write');
  });

  it('X-4: changing a member role reaches the HTTPS receiver in the compose network, signed; the delivery is SUCCEEDED', async () => {
    compose(['up', '-d', '--wait', '--no-deps', 'webhook-receiver'], {
      timeoutMs: 120_000,
    });
    const { device } = await verifiedDevice(apiUrl, mail, forbidden);
    const org = await device.call('POST', '/v1/orgs', {
      body: { name: 'Smoke 6C' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(org.status).toBe(201);
    const { id: orgId } = z.object({ id: z.uuid() }).parse(await org.json());
    // Member seed bằng superuser (mẫu smoke 3B): một user đã xác thực khác, role MEMBER.
    const { email: memberEmail } = await verifiedDevice(
      apiUrl,
      mail,
      forbidden,
    );
    const authId = psql(
      `SELECT id FROM auth."user" WHERE email = '${memberEmail}'`,
    );
    psql(
      `INSERT INTO tenancy_users (auth_user_id) VALUES ('${authId}') ON CONFLICT (auth_user_id) DO NOTHING`,
    );
    psql(
      `INSERT INTO org_members (org_id, user_id, role_id) SELECT '${orgId}', u.id, r.id FROM tenancy_users u, org_roles r
       WHERE u.auth_user_id = '${authId}' AND r.org_id = '${orgId}' AND r.system_key = 'MEMBER'`,
    );
    const memberId = psql(
      `SELECT m.public_id FROM org_members m JOIN tenancy_users u ON u.id = m.user_id WHERE m.org_id = '${orgId}' AND u.auth_user_id = '${authId}'`,
    );
    const adminRole = psql(
      `SELECT public_id FROM org_roles WHERE org_id = '${orgId}' AND system_key = 'ADMIN'`,
    );
    const created = await device.call(
      'POST',
      `/v1/orgs/${orgId}/webhook-endpoints`,
      {
        body: {
          url: 'https://webhook-receiver/hook',
          eventTypes: ['tenancy.member.role_changed'],
        },
      },
    );
    expect(created.status).toBe(201);
    const endpoint = z
      .object({ id: z.uuid(), secret: z.string() })
      .parse(await created.json());
    forbidden.push(endpoint.secret, endpoint.secret.slice('whsec_'.length));
    const changed = await device.call(
      'PATCH',
      `/v1/orgs/${orgId}/members/${memberId}`,
      { body: { roleId: adminRole }, headers: { 'if-match': '*' } },
    );
    expect(changed.status).toBe(200);
    const until = Date.now() + DELIVERY_WAIT_MS;
    let got = received();
    while (got.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      got = received();
    }
    const [req] = got;
    expect(req?.path).toBe('/hook');
    const header = (k: string) => String(req?.headers[k] ?? '');
    const payload = new Webhook(endpoint.secret).verify(req?.body ?? '', {
      'webhook-id': header('webhook-id'),
      'webhook-timestamp': header('webhook-timestamp'),
      'webhook-signature': header('webhook-signature'),
    });
    expect(payload).toMatchObject({
      type: 'tenancy.member.role_changed',
      version: 1,
      data: { memberId },
    });
    forbidden.push(header('webhook-signature').split(',')[1] ?? '');
    const list = await device.call(
      'GET',
      `/v1/orgs/${orgId}/webhook-endpoints/${endpoint.id}/deliveries`,
    );
    expect(
      z
        .object({ data: z.array(z.object({ status: z.string() })) })
        .parse(await list.json())
        .data.map((d) => d.status),
    ).toEqual(['SUCCEEDED']);
  });

  it('/health/ready is 200, the worker is healthy, and api/worker logs are clean JSON without the secret or the signature', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(
      logsSince(since),
      forbidden.filter((v) => v.length > 0),
    );
  });
});
