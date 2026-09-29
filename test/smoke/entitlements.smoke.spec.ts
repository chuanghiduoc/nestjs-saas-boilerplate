import { describe, expect, inject, it } from 'vitest';
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
  const { apiUrl } = inject('smoke');
  const bootEpoch = new Date(0).toISOString();

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
    ).toBe('tenancy.seats:LIMIT');
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
  it('api and worker booted through both catalogue checks: /health/ready 200, worker healthy, fallback report logged, logs clean', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    const logs = logsSince(bootEpoch);
    expect(logs).toContain('entitlements_plan_fallbacks');
    assertCleanLogs(logs, []);
  });
});
