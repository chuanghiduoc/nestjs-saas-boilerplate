import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { Mailpit } from '../support/mailpit.js';
import { PASSWORD, verifiedDevice } from './smoke-devices.js';
import {
  assertCleanLogs,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

/**
 * Plan 4A trên image production (`NODE_ENV=production`, `docker compose --profile app`). Task 8: schema + catalogue check
 * chạy từ `dist`; Task 13 thêm luồng HTTP (đăng ký → tạo org → GET entitlements → xoá mềm). Plan 4B (Task 14): schema
 * `usage_counters` từ `dist` và đường ghế (adapter thật trong `MemberAdmission`).
 */
describe('prod-like smoke: plans 4A and 4B', () => {
  const { apiUrl, mailpitApiUrl } = inject('smoke');
  const bootEpoch = new Date(0).toISOString();
  const mail = new Mailpit(mailpitApiUrl);
  /** Không dòng log nào của api/worker được chứa các giá trị này. */
  const forbidden: string[] = [PASSWORD];

  it('the 4A migrations ran from dist: two starter plans, tenancy.seats, FORCE RLS on org_entitlements, entitlements.read → org.read, four triggers', () => {
    expect(
      psql(
        `SELECT string_agg(key || ':' || (retired_at IS NULL)::text, ',' ORDER BY key) FROM plans`,
      ),
    ).toBe('free:true,pro:true');
    expect(
      psql(
        `SELECT string_agg(key || ':' || kind, ',' ORDER BY key) FROM entitlement_features`,
      ),
    ).toBe('files.storage_bytes:LIMIT,tenancy.seats:LIMIT');
    expect(
      psql(
        `SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_class WHERE relname = 'org_entitlements'`,
      ),
    ).toBe('true:true');
    expect(
      psql(
        `SELECT count(*) FROM permissions p JOIN permission_requires r ON r.permission_id = p.id JOIN permissions q ON q.id = r.required_permission_id
         WHERE p.key = 'entitlements.read' AND q.key = 'org.read'`,
      ),
    ).toBe('1');
    expect(
      psql(
        `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal
         AND tgrelid IN ('entitlement_features'::regclass, 'plans'::regclass, 'org_entitlements'::regclass)`,
      ),
    ).toBe(
      'entitlement_features_immutable,org_entitlements_billing_seq_monotonic,org_entitlements_plan_not_retired,plans_key_immutable',
    );
  });
  it('entitlements on the production image: sign up → verify → create org → default plan in GET …/entitlements → one plan.changed → soft delete → 404', async () => {
    const { device } = await verifiedDevice(apiUrl, mail, forbidden);
    const created = await device.call('POST', '/v1/orgs', {
      body: { name: 'Smoke 4A' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(await created.json());
    const ent = await device.call('GET', `/v1/orgs/${id}/entitlements`);
    expect(ent.status).toBe(200);
    expect(await ent.json()).toEqual({
      plan: { key: 'free', source: 'DEFAULT', assignedAt: expect.any(String) },
      features: [
        {
          key: 'files.storage_bytes',
          kind: 'LIMIT',
          unlimited: false,
          limit: 1_073_741_824,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
        {
          key: 'tenancy.seats',
          kind: 'LIMIT',
          unlimited: true,
          limit: null,
          source: 'FALLBACK',
          overrideExpiresAt: null,
        },
      ],
    });
    // Dòng tạo trong transaction tạo org (participant), đúng một event (subscriber dự phòng không thêm).
    expect(
      psql(
        `SELECT plan_source || ':' || version FROM org_entitlements WHERE org_id = '${id}'`,
      ),
    ).toBe('DEFAULT:1');
    expect(
      psql(
        `SELECT count(*) FROM outbox_events WHERE org_id = '${id}' AND type = 'entitlements.plan.changed'`,
      ),
    ).toBe('1');
    expect((await device.call('DELETE', `/v1/orgs/${id}`)).status).toBe(204);
    expect(
      (await device.call('GET', `/v1/orgs/${id}/entitlements`)).status,
    ).toBe(404);
  });
  it('the 4B migration ran from dist: usage_counters with FORCE RLS, the NULLS NOT DISTINCT arbiter, an INVOKER period trigger, UPDATE on three columns only', () => {
    expect(
      psql(
        `SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_class WHERE relname = 'usage_counters'`,
      ),
    ).toBe('true:true');
    expect(
      psql(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'usage_counters_period_uq'`,
      ),
    ).toBe('UNIQUE NULLS NOT DISTINCT (org_id, feature_id, period_start)');
    expect(
      psql(
        `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'usage_counters'::regclass`,
      ),
    ).toBe('usage_counters_period_ck');
    expect(
      psql(
        `SELECT prosecdef::text FROM pg_proc WHERE proname = 'entitlements_usage_counter_period_ck'`,
      ),
    ).toBe('false');
    expect(
      psql(
        `SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a
         WHERE a.attrelid = 'usage_counters'::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND has_column_privilege('app_user', a.attrelid, a.attname, 'UPDATE')`,
      ),
    ).toBe('updated_at,used,version');
  });
  it('seats on the production image: creating an org and joining through an invite link go through the seat adapter; the tenant view lists both boilerplate LIMITs', async () => {
    const { device: owner } = await verifiedDevice(apiUrl, mail, forbidden);
    const created = await owner.call('POST', '/v1/orgs', {
      body: { name: 'Smoke 4B' },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(created.status).toBe(201);
    const { id } = z.object({ id: z.uuid() }).parse(await created.json());
    const roleId = psql(
      `SELECT public_id FROM org_roles WHERE org_id = '${id}' AND system_key = 'MEMBER'`,
    );
    const link = await owner.call('POST', `/v1/orgs/${id}/invite-links`, {
      body: {
        roleId,
        maxUses: 2,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(link.status).toBe(201);
    const { url } = z.object({ url: z.string() }).parse(await link.json());
    const token = new URL(url).hash.replace('#token=', '');
    forbidden.push(token); // token một lần không bao giờ vào log
    const { device: joiner } = await verifiedDevice(apiUrl, mail, forbidden);
    const joined = await joiner.call('POST', '/v1/invite-links/join', {
      body: { token },
      headers: { 'idempotency-key': `smoke-${randomUUID()}` },
    });
    expect(joined.status).toBe(201);
    expect(
      psql(`SELECT count(*) FROM org_members WHERE org_id = '${id}'`),
    ).toBe('2');
    const ent = await owner.call('GET', `/v1/orgs/${id}/entitlements`);
    expect(ent.status).toBe(200);
    const { features } = z
      .object({
        features: z.array(z.object({ key: z.string() }).passthrough()),
      })
      .parse(await ent.json());
    expect(features.map((f) => f.key)).toEqual([
      'files.storage_bytes',
      'tenancy.seats',
    ]);
    expect(
      psql(`SELECT count(*) FROM usage_counters WHERE org_id = '${id}'`),
    ).toBe('0');
  });
  it('api and worker booted through both catalogue checks: /health/ready 200, worker healthy, fallback report logged, logs clean', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    const logs = logsSince(bootEpoch);
    expect(logs).toContain('entitlements_plan_fallbacks');
    assertCleanLogs(logs, forbidden);
    const inventory = logs
      .split('\n')
      .filter((l) => l.includes('"entitlements_route_inventory"'))
      .map((l) => z.object({ durationMs: z.number() }).parse(JSON.parse(l)));
    expect(inventory.length).toBeGreaterThan(0);
    for (const i of inventory) expect(i.durationMs).toBeLessThan(50);
  });
});
