import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runMigrations,
  type MigrationObject,
} from '../../../src/core/database/index.js';
import { AUDIT_TABLES } from '../../../src/modules/audit/constants.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  asPartitionOwner,
  insertOrgAuditRow,
  monthTag,
} from '../../support/audit-seed.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import { seedOrg, withAppClient } from '../../support/tenancy-seed.js';

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
const REFUSAL = /audit rows exist/;

type Privileges = Record<string, boolean>;
type Shape = {
  tables: { name: string; kind: string; owner: string }[];
  partitionCounts: Record<string, number>;
  foreignKeys: number;
  appUserOnParent: Record<string, Privileges>;
  appUserOnCurrentPartition: Record<string, Privileges>;
  relayOrAuthOnParent: Record<string, boolean>;
  nonOwnerTruncate: string[];
  partitionGrantees: string[];
  rls: Record<string, [boolean, boolean]>;
  policies: { table: string; name: string; roles: string }[];
  triggers: string[];
  permission: Record<string, boolean> | undefined;
};

/** Mọi khẳng định về hình dạng sau `up`; ca "up lại" so cùng object. */
async function shape(db: ScratchDb): Promise<Shape> {
  const c = await db.client('owner');
  try {
    const q = async <T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> => (await c.query<T>(sql, params)).rows;
    const tables = await q<{ name: string; kind: string; owner: string }>(
      `SELECT c.relname AS name, c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c WHERE c.oid IN (to_regclass('public.audit_logs'), to_regclass('public.platform_audit_logs'))
        ORDER BY 1`,
    );
    const partitionCounts: Record<string, number> = {};
    const appUserOnParent: Record<string, Privileges> = {};
    const appUserOnCurrentPartition: Record<string, Privileges> = {};
    const tag = monthTag(0).tag;
    for (const t of AUDIT_TABLES) {
      const [n] = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = to_regclass($1)`,
        [`public.${t}`],
      );
      partitionCounts[t] = n?.n ?? -1;
      const privs = async (rel: string, list: string[]) =>
        Object.fromEntries(
          await Promise.all(
            list.map(async (p) => {
              const [r] = await q<{ ok: boolean }>(
                `SELECT has_table_privilege('app_user', $1, $2) AS ok`,
                [rel, p],
              );
              return [p, r?.ok ?? false] as const;
            }),
          ),
        );
      appUserOnParent[t] = await privs(`public.${t}`, PRIVILEGES);
      appUserOnCurrentPartition[t] = await privs(`public.${t}_p${tag}`, [
        'SELECT',
        'INSERT',
      ]);
    }
    const [fk] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint k
        WHERE k.contype = 'f' AND (k.conrelid IN (to_regclass('public.audit_logs'), to_regclass('public.platform_audit_logs'))
           OR k.conrelid IN (SELECT inhrelid FROM pg_inherits
                              WHERE inhparent IN (to_regclass('public.audit_logs'), to_regclass('public.platform_audit_logs'))))`,
    );
    const relayOrAuthOnParent: Record<string, boolean> = {};
    for (const role of ['app_relay', 'auth_user']) {
      const [r] = await q<{ any: boolean }>(
        `SELECT bool_or(has_table_privilege($1, t, p)) AS any
           FROM unnest(ARRAY['public.audit_logs', 'public.platform_audit_logs']) t,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p`,
        [role],
      );
      relayOrAuthOnParent[role] = r?.any ?? true;
    }
    const nonOwnerTruncate = (
      await q<{ grantee: string }>(
        `SELECT DISTINCT pg_get_userbyid(a.grantee) AS grantee
           FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.oid IN (to_regclass('public.audit_logs'), to_regclass('public.platform_audit_logs'))
            AND a.privilege_type = 'TRUNCATE' AND a.grantee <> c.relowner ORDER BY 1`,
      )
    ).map((r) => r.grantee);
    const partitionGrantees = (
      await q<{ grantee: string }>(
        `SELECT DISTINCT pg_get_userbyid(a.grantee) AS grantee
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid, aclexplode(c.relacl) a
          WHERE i.inhparent IN (to_regclass('public.audit_logs'), to_regclass('public.platform_audit_logs'))
            AND a.grantee <> c.relowner ORDER BY 1`,
      )
    ).map((r) => r.grantee);
    const rls: Record<string, [boolean, boolean]> = {};
    for (const r of await q<{ name: string; on: boolean; force: boolean }>(
      `SELECT relname AS name, relrowsecurity AS on, relforcerowsecurity AS force FROM pg_class
        WHERE oid IN (to_regclass('public.audit_logs'), to_regclass('public.platform_audit_logs'))`,
    ))
      rls[r.name] = [r.on, r.force];
    const policies = await q<{ table: string; name: string; roles: string }>(
      `SELECT tablename AS table, policyname AS name, roles::text AS roles FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('audit_logs', 'platform_audit_logs') ORDER BY 1, 2`,
    );
    const triggers = (
      await q<{ name: string }>(
        `SELECT tgname AS name FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid IN (to_regclass('public.audit_logs'), to_regclass('public.platform_audit_logs'))
          ORDER BY 1`,
      )
    ).map((r) => r.name);
    const [permission] = await q<Record<string, boolean>>(
      `SELECT owner_only, api_key_eligible, support_eligible FROM permissions WHERE key = 'audit.read'`,
    );
    return {
      tables,
      partitionCounts,
      foreignKeys: fk?.n ?? -1,
      appUserOnParent,
      appUserOnCurrentPartition,
      relayOrAuthOnParent,
      nonOwnerTruncate,
      partitionGrantees,
      rls,
      policies,
      triggers,
      permission,
    };
  } finally {
    await c.end();
  }
}

describe('audit_logs migration: up, guarded down, up again (spec SP6 §6.10 dòng 6B)', () => {
  let db: ScratchDb;
  let list: MigrationObject[];
  let before: string;
  let afterUp: Shape;
  const up = () => runMigrations('up', { source: { kind: 'list', list } });
  const down = () =>
    runMigrations('down', { source: { kind: 'list', list }, to: before });
  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('sp6b_mig');
    vi.stubEnv('DB_NAME', db.name);
    const all = coreMigrationList();
    const at = all.findIndex((m) => m.name.endsWith('_audit_logs'));
    if (at < 1) throw new Error('audit_logs migration not found');
    list = all.slice(0, at + 1);
    before = all[at - 1]!.name;
    await up();
    afterUp = await shape(db);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('up: both tables partitioned, owned by partition_owner, current month + 3 partitions each, no FK, no grant on partitions', () => {
    expect(afterUp.tables).toEqual([
      { name: 'audit_logs', kind: 'p', owner: 'partition_owner' },
      { name: 'platform_audit_logs', kind: 'p', owner: 'partition_owner' },
    ]);
    expect(afterUp.partitionCounts).toEqual({
      audit_logs: 4,
      platform_audit_logs: 4,
    });
    expect(afterUp.foreignKeys).toBe(0);
    const appendOnly = {
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    };
    expect(afterUp.appUserOnParent).toEqual({
      audit_logs: appendOnly,
      platform_audit_logs: appendOnly,
    });
    expect(afterUp.appUserOnCurrentPartition).toEqual({
      audit_logs: { SELECT: false, INSERT: false },
      platform_audit_logs: { SELECT: false, INSERT: false },
    });
    expect(afterUp.relayOrAuthOnParent).toEqual({
      app_relay: false,
      auth_user: false,
    });
    expect(afterUp.nonOwnerTruncate).toEqual([]);
    expect(afterUp.partitionGrantees).toEqual([]);
  });
  it('up: RLS FORCE and the tenant policy on audit_logs only; append-only triggers on both parents; audit.read seeded', () => {
    expect(afterUp.rls).toEqual({
      audit_logs: [true, true],
      platform_audit_logs: [false, false],
    });
    expect(afterUp.policies).toEqual([
      { table: 'audit_logs', name: 'audit_logs_tenant', roles: '{app_user}' },
    ]);
    expect(afterUp.triggers).toEqual([
      'audit_logs_append_only',
      'audit_logs_no_truncate',
      'platform_audit_logs_append_only',
      'platform_audit_logs_no_truncate',
    ]);
    expect(afterUp.permission).toEqual({
      owner_only: false,
      api_key_eligible: true,
      support_eligible: false,
    });
  });
  it('down refuses while any audit row exists, atomically (FORCE stays on, tables stay)', async () => {
    const org = await seedOrg({ database: db.name });
    const tag = monthTag(0).tag;
    try {
      expect(
        await withAppClient((c) => insertOrgAuditRow(c, org.orgId), db.name),
      ).toBe(1);
      await expect(down()).rejects.toThrow(REFUSAL);
      const s = await shape(db);
      expect(s.rls.audit_logs).toEqual([true, true]);
      expect(s.tables).toHaveLength(2);
      expect(s.permission).toEqual(afterUp.permission);
    } finally {
      // Cách hợp lệ duy nhất để bỏ dòng: DETACH + DROP partition tháng này dưới partition_owner, rồi tạo lại bằng maintain.
      await asPartitionOwner(
        [
          `ALTER TABLE public.audit_logs DETACH PARTITION public.audit_logs_p${tag}`,
          `DROP TABLE public.audit_logs_p${tag}`,
        ],
        db.name,
      );
      await withAppClient(
        (c) => c.query('SELECT * FROM public.audit_partitions_maintain(13, 3)'),
        db.name,
      );
      await org.dispose();
    }
  });
  it('down on an empty audit drops tables, all five functions and the permission; up again restores the same shape', async () => {
    await expect(down()).resolves.toEqual([list.at(-1)!.name]);
    const c = await db.client('owner');
    try {
      const gone = await c.query(
        `SELECT to_regclass('public.audit_logs') AS t, to_regclass('public.platform_audit_logs') AS pt,
                to_regprocedure('public.audit_partitions_maintain(integer,integer)') AS f,
                (SELECT count(*)::int FROM pg_proc WHERE proname IN ('audit_logs_append_only', 'audit_logs_no_truncate',
                   'platform_audit_logs_append_only', 'platform_audit_logs_no_truncate')) AS tf,
                (SELECT count(*)::int FROM permissions WHERE key = 'audit.read') AS p`,
      );
      expect(gone.rows[0]).toEqual({ t: null, pt: null, f: null, tf: 0, p: 0 });
    } finally {
      await c.end();
    }
    await up();
    expect(await shape(db)).toEqual(afterUp);
  });
});
