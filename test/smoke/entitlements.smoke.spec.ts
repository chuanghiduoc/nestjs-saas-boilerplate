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
 * chạy từ `dist`; Task 13 thêm luồng HTTP (đăng ký → tạo org → GET entitlements → xoá mềm).
 */
describe('prod-like smoke: plan 4A', () => {
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
