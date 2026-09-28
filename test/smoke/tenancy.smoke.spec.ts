import { describe, expect, inject, it } from 'vitest';
import { TEMPLATE_KEYS } from '../../src/modules/notifications/templates.js';
import {
  assertCleanLogs,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

/**
 * Plan 3A trên image production (`NODE_ENV=production`, TLS mọi nơi, `docker compose --profile app`). Task 12 thêm
 * kịch bản identity, Task 16 schema tenancy, Task 26 xoá tài khoản có guard, Task 29 luồng tenancy đầy đủ.
 */
describe('prod-like smoke: plan 3A', () => {
  const { apiUrl } = inject('smoke');
  const since = new Date().toISOString();

  it('the 3A migrations and the tenancy_definer role are in place', () => {
    expect(
      psql(`SELECT string_agg(key, ',' ORDER BY key) FROM email_templates`),
    ).toBe([...TEMPLATE_KEYS].sort().join(','));
    expect(
      psql(
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'scheduled_tasks' AND column_name = 'suspended_at'`,
      ),
    ).toBe('1');
    expect(
      psql(
        `SELECT rolcanlogin::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = 'tenancy_definer'`,
      ),
    ).toBe('false,false');
    expect(
      psql(
        `SELECT count(*) FROM pg_constraint WHERE conname = 'email_deliveries_template_fk'`,
      ),
    ).toBe('1');
  });
  it('/health/ready is 200, the worker is healthy, and api/worker logs are clean JSON without errors', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(logsSince(since), []);
  });
});
