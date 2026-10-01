import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, inject, it, vi } from 'vitest';
import {
  assertCleanLogs,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

/** Mặc định `FLAGS_REFRESH_INTERVAL_MS` của `.env.example` (smoke không ghi đè). */
const FLAGS_REFRESH_DEFAULT_MS = 5000;
const REFRESH_WAIT_MS = FLAGS_REFRESH_DEFAULT_MS * 3;
/** Một api + một worker trong compose smoke: mỗi process WARN đúng một lần. */
const PROCESSES = 2;
const UNKNOWN_KEY = 'smoke.unknown_switch';
const unknownWarns = (logs: string) =>
  logs
    .split(/\r?\n/)
    .filter(
      (l) =>
        l.includes('"event":"kill_switch_unknown_key"') &&
        l.includes(UNKNOWN_KEY),
    ).length;

describe('prod-like smoke: SP6 6.0 shared core', () => {
  const { startedAt } = inject('smoke');

  it('partition_owner and sweep_definer are NOLOGIN roles app_owner may SET but not inherit', () => {
    expect(
      psql(
        `SELECT string_agg(r.rolname || ':' || r.rolcanlogin::text || ':' || r.rolbypassrls::text || ':' || m.inherit_option::text || ':' || m.set_option::text, ',' ORDER BY r.rolname)
         FROM pg_roles r JOIN pg_auth_members m ON m.roleid = r.oid AND m.member = 'app_owner'::regrole
         WHERE r.rolname IN ('partition_owner', 'sweep_definer')`,
      ),
    ).toBe(
      'partition_owner:false:false:false:true,sweep_definer:false:false:false:true',
    );
  });
  it('kill_switches is migrated from dist with the grants of spec §6.2', () => {
    expect(
      psql(
        `SELECT has_table_privilege('app_user', 'kill_switches', 'SELECT')::text || ':' || has_table_privilege('app_user', 'kill_switches', 'INSERT')::text || ':' || has_table_privilege('app_user', 'kill_switches', 'DELETE')::text || ':' || has_column_privilege('app_user', 'kill_switches', 'key', 'UPDATE')::text || ':' || has_column_privilege('app_user', 'kill_switches', 'killed', 'UPDATE')::text`,
      ),
    ).toBe('true:true:false:false:true');
  });
  it('api and worker reload kill switches from the DB; a row for a switch not in code is ignored with one WARN per process', async () => {
    const since = new Date().toISOString();
    psql(
      `INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES ('${UNKNOWN_KEY}', true, 'smoke', 'smoke')`,
    );
    try {
      await vi.waitFor(
        () => expect(unknownWarns(logsSince(since))).toBe(PROCESSES),
        {
          timeout: REFRESH_WAIT_MS,
          interval: 500,
        },
      );
      await sleep(FLAGS_REFRESH_DEFAULT_MS * 2);
      expect(unknownWarns(logsSince(since))).toBe(PROCESSES);
    } finally {
      psql(`DELETE FROM kill_switches WHERE key = '${UNKNOWN_KEY}'`);
    }
  });
  it('the worker synced the core.partitions.maintain cron and boots with the sweep and partition modules', () => {
    expect(logsSince(startedAt)).toContain('static-core.partitions.maintain');
    expect(workerHealth()).toBe('healthy');
  });
  it('container logs since boot have no error or non-JSON lines', () => {
    assertCleanLogs(logsSince(startedAt), []);
  });
});
