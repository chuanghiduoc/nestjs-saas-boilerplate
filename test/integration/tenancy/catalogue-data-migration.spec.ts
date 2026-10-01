import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { toEnvelope } from '../../../src/core/events/event-dispatch.handlers.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import { RoleUpdatedEvent } from '../../../src/modules/tenancy/events.js';
import { ROLE_PERMISSIONS_SQL } from '../../../src/modules/tenancy/infra/sql/sql-role.repository.js';
import { applyTestEnv } from '../../support/app-factory.js';
import {
  addRequiresEdgesDml,
  catalogueMigration,
  removePermissionDml,
  sevenStep,
} from '../../support/catalogue-migration.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import {
  inOrgTx,
  seedCustomRole,
  seedOrg,
  withAppClient,
  type SeededOrg,
  type SeededRole,
} from '../../support/tenancy-seed.js';

const TABLE = 'mikro_orm_migrations_catalogue_fixtures';
/** Catalogue fixture (chỉ ở DB riêng của test): chuỗi, hình thoi, và một nhánh cho K-9b. */
const FIXTURE_KEYS = [
  ['payroll', 'read'],
  ['payroll', 'export'],
  ['payroll', 'approve'],
  ['ledger', 'close'],
  ['ledger', 'post'],
  ['ledger', 'read'],
  ['audit', 'top'],
  ['audit', 'left'],
  ['audit', 'right'],
  ['audit', 'base'],
  ['stock', 'count'],
  ['stock', 'view'],
] as const;
const FIXTURE_EDGES = [
  ['payroll.export', 'payroll.read'],
  ['payroll.approve', 'payroll.export'],
  ['ledger.close', 'ledger.post'],
  ['audit.top', 'audit.left'],
  ['audit.top', 'audit.right'],
  ['stock.count', 'stock.view'],
] as const;

describe('catalogue data migrations through the real runner (spec SP3 §8.8; §18.3 K-9, K-9b, K-9c, K-17 role part)', () => {
  let db: ScratchDb;
  let owner: pg.Client;
  let org: SeededOrg;
  const role: Record<string, SeededRole> = {};
  const run = (...migrations: ReturnType<typeof catalogueMigration>[]) =>
    runMigrations('up', {
      source: { kind: 'list', list: migrations },
      tableName: TABLE,
    });
  /** Tập đã lưu của mọi role tuỳ biến, gồm cả key deprecated (đọc bằng app_user trong OrgScope). */
  const sets = () =>
    withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, async () => {
          const { rows } = await c.query<{ role_id: string; key: string }>(
            `SELECT rp.role_id::text AS role_id, p.key FROM org_role_permissions rp JOIN permissions p ON p.id = rp.permission_id`,
          );
          const out = new Map<string, Set<string>>(
            Object.values(role).map((r) => [r.id, new Set<string>()]),
          );
          for (const r of rows) out.get(r.role_id)?.add(r.key);
          return out;
        }),
      db.name,
    );
  const versions = () =>
    withAppClient(
      (c) =>
        inOrgTx(
          c,
          org.orgId,
          async () =>
            new Map(
              (
                await c.query<{ id: string; version: number }>(
                  `SELECT id::text AS id, version FROM org_roles`,
                )
              ).rows.map((r) => [r.id, r.version]),
            ),
        ),
      db.name,
    );
  const openSets = () =>
    withAppClient(
      (c) =>
        inOrgTx(
          c,
          org.orgId,
          async () =>
            (
              await c.query<{
                n: number;
              }>(`SELECT count(*)::int AS n FROM org_role_permissions s JOIN permission_requires r ON r.permission_id = s.permission_id
            WHERE NOT EXISTS (SELECT 1 FROM org_role_permissions t WHERE t.org_id = s.org_id AND t.role_id = s.role_id AND t.permission_id = r.required_permission_id)`)
            ).rows[0]?.n,
        ),
      db.name,
    );
  const events = async (migration: string) =>
    (
      await owner.query<{
        id: string;
        event_id: string;
        type: string;
        version: number;
        org_id: string | null;
        aggregate_type: string;
        aggregate_id: string;
        aggregate_version: string;
        payload: unknown;
        headers: Record<string, string>;
        occurred_at: Date;
      }>(
        `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
                aggregate_version::text AS aggregate_version, payload, headers, occurred_at
         FROM outbox_events WHERE headers->>'actorId' = $1 ORDER BY id`,
        [`catalogue-migration:${migration}`],
      )
    ).rows.map((row) => parseEnvelope(RoleUpdatedEvent, toEnvelope(row)));
  const forced = async () =>
    (
      await owner.query<{ relname: string; f: boolean }>(
        `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('org_roles', 'org_role_permissions') ORDER BY relname`,
      )
    ).rows;
  /** Vòng đời chỉ thu hẹp hoặc giữ nguyên (spec §8.8): mỗi tập sau ⊆ tập trước. */
  const expectNarrowedOnly = (
    before: Map<string, Set<string>>,
    after: Map<string, Set<string>>,
  ) => {
    for (const [id, b] of before)
      expect(
        [...(after.get(id) ?? [])].every((k) => b.has(k)),
        `role ${id} grew`,
      ).toBe(true);
  };

  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('catmig');
    vi.stubEnv('DB_NAME', db.name);
    await runMigrations('up', {
      source: { kind: 'list', list: coreMigrationList() },
    });
    owner = await db.client('owner');
    await owner.query(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) SELECT r, a, false, false, false FROM unnest($1::text[], $2::text[]) AS k (r, a)`,
      [FIXTURE_KEYS.map(([r]) => r), FIXTURE_KEYS.map(([, a]) => a)],
    );
    await owner.query(
      `INSERT INTO permission_requires (permission_id, required_permission_id) SELECT p.id, q.id FROM unnest($1::text[], $2::text[]) AS e (k, req) JOIN permissions p ON p.key = e.k JOIN permissions q ON q.key = e.req`,
      [FIXTURE_EDGES.map(([k]) => k), FIXTURE_EDGES.map(([, r]) => r)],
    );
    org = await seedOrg({ database: db.name });
    const seed = async (name: string, permissions: string[]) => {
      role[name] = await seedCustomRole(org, { name, permissions });
    };
    await seed('pay3', ['payroll.read', 'payroll.export', 'payroll.approve']);
    await seed('pay2', ['payroll.read', 'payroll.export']);
    await seed('untouched', ['org.read']);
    await seed('chain', ['ledger.close', 'ledger.post']);
    await seed('chainFull', ['ledger.close', 'ledger.post', 'ledger.read']);
    await seed('diamond', ['audit.top', 'audit.left', 'audit.right']);
    await seed('diamondFull', [
      'audit.top',
      'audit.left',
      'audit.right',
      'audit.base',
    ]);
    await seed('replaced', ['org.read']);
    // Bản N của dòng "Xoá": payroll.export và quyền phụ thuộc nó (approve) được deprecate cùng lúc (U2).
    await owner.query(
      `UPDATE permissions SET deprecated_at = now() WHERE key IN ('payroll.export', 'payroll.approve')`,
    );
  }, 180_000);
  afterAll(async () => {
    await owner?.end();
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('K-9c: a catalogue migration that forgets step 6 is rolled back by step 7; data and FORCE unchanged', async () => {
    const before = await sets();
    const name = 'Migration29990101000001_k9c_forgot_force';
    await expect(
      run(
        catalogueMigration(
          name,
          sevenStep(removePermissionDml(name, 'payroll.export'), {
            skipForceRestore: true,
          }),
        ),
      ),
    ).rejects.toThrow(/a tenant table lost FORCE ROW LEVEL SECURITY/);
    expect(await sets()).toEqual(before);
    expect(await forced()).toEqual([
      { relname: 'org_role_permissions', f: true },
      { relname: 'org_roles', f: true },
    ]);
    expect(await events(name)).toEqual([]);
  });

  it('K-9: removing a deprecated permission narrows every holding role to its fixpoint, bumps each touched role once and emits one event each', async () => {
    const before = await sets();
    const v0 = await versions();
    const name = 'Migration29990101000002_k9_remove_payroll_export';
    await run(
      catalogueMigration(
        name,
        sevenStep(removePermissionDml(name, 'payroll.export')),
      ),
    );
    const after = await sets();
    expect([...(after.get(role.pay3!.id) ?? [])]).toEqual(['payroll.read']);
    expect([...(after.get(role.pay2!.id) ?? [])]).toEqual(['payroll.read']);
    expect(after.get(role.untouched!.id)).toEqual(
      before.get(role.untouched!.id),
    );
    expectNarrowedOnly(before, after);
    const v1 = await versions();
    for (const r of [role.pay3!, role.pay2!])
      expect(v1.get(r.id)).toBe((v0.get(r.id) ?? 0) + 1);
    expect(v1.get(role.untouched!.id)).toBe(v0.get(role.untouched!.id));
    const evs = (await events(name)).sort((a, b) =>
      a.aggregate.id.localeCompare(b.aggregate.id),
    );
    expect(
      evs.map((e) => [
        e.aggregate.id,
        e.aggregate.version,
        e.data.permissions,
        e.actor,
      ]),
    ).toEqual(
      [role.pay3!, role.pay2!]
        .sort((a, b) => a.publicId.localeCompare(b.publicId))
        .map((r) => [
          r.publicId,
          v1.get(r.id),
          ['payroll.read'],
          { type: 'system', id: `catalogue-migration:${name}` },
        ]),
    );
    expect(
      (
        await owner.query(
          `SELECT 1 FROM permissions WHERE key = 'payroll.export'`,
        )
      ).rows,
    ).toEqual([]);
    expect(await openSets()).toBe(0);
    expect(await forced()).toEqual([
      { relname: 'org_role_permissions', f: true },
      { relname: 'org_roles', f: true },
    ]);
    // "gọi → 403": câu thứ hai của đường nóng (Task 5) không còn trả key đã xoá.
    const hot = await withAppClient(
      (c) =>
        inOrgTx(c, org.orgId, async () =>
          (
            await c.query<{ key: string }>(
              ROLE_PERMISSIONS_SQL.replace('ARRAY[?]', '$1'),
              [[role.pay3!.id]],
            )
          ).rows.map((r) => r.key),
        ),
      db.name,
    );
    expect(hot).toEqual(['payroll.read']);
  });

  it('K-9b (a): two data migrations in one batch; the second replaces a set with DELETE then several INSERTs valid only at the end → green (step 5 leaks no IMMEDIATE)', async () => {
    const first = 'Migration29990101000003_k9b_remove_payroll_approve';
    const second = 'Migration29990101000004_k9b_replace_set';
    const r = role.replaced!;
    await run(
      catalogueMigration(
        first,
        sevenStep(removePermissionDml(first, 'payroll.approve')),
      ),
      catalogueMigration(
        second,
        sevenStep([
          `DELETE FROM public.org_role_permissions WHERE role_id = ${r.id};`,
          `INSERT INTO public.org_role_permissions (org_id, role_id, permission_id) SELECT org_id, id, (SELECT id FROM public.permissions WHERE key = 'stock.count') FROM public.org_roles WHERE id = ${r.id};`,
          `INSERT INTO public.org_role_permissions (org_id, role_id, permission_id) SELECT org_id, id, (SELECT id FROM public.permissions WHERE key = 'stock.view') FROM public.org_roles WHERE id = ${r.id};`,
        ]),
      ),
    );
    expect([...((await sets()).get(r.id) ?? [])].sort()).toEqual([
      'stock.count',
      'stock.view',
    ]);
  });

  it('K-9b (b): a catalogue migration, then a migration creating a NEW deferred constraint trigger and multi-step DML valid only at the end → green', async () => {
    const first = 'Migration29990101000005_k9b_noop_catalogue';
    const second = 'Migration29990101000006_k9b_new_deferred_trigger';
    await run(
      catalogueMigration(first, sevenStep([])),
      catalogueMigration(second, [
        `CREATE TABLE k9b_pairs (n int NOT NULL);`,
        `CREATE FUNCTION k9b_pairs_even() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           IF (SELECT count(*) FROM public.k9b_pairs) % 2 <> 0 THEN RAISE EXCEPTION 'odd' USING ERRCODE = 'check_violation', CONSTRAINT = 'k9b_pairs_even_ck'; END IF;
           RETURN NULL; END $$;`,
        `CREATE CONSTRAINT TRIGGER k9b_pairs_even_ck AFTER INSERT ON k9b_pairs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION k9b_pairs_even();`,
        `INSERT INTO k9b_pairs (n) VALUES (1);`,
        `INSERT INTO k9b_pairs (n) VALUES (2);`,
      ]),
    );
    expect(
      (await owner.query(`SELECT count(*)::int AS n FROM k9b_pairs`)).rows,
    ).toEqual([{ n: 2 }]);
  });

  it.each([
    [
      'two deferrable triggers with the same name (DEFERRED and IMMEDIATE)',
      'trigger',
      [
        `CREATE CONSTRAINT TRIGGER k9c_dup_ck AFTER INSERT ON k9c_b DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION k9c_noop();`,
      ],
    ],
    [
      'a deferrable trigger named like a CHECK of another table',
      'check',
      [`ALTER TABLE k9c_b ADD CONSTRAINT k9c_dup_ck CHECK (n >= 0);`],
    ],
    // Spec §8.8/§18.3 (R5-C1): FK KHÔNG deferrable cùng tên với một trigger deferrable — `SET CONSTRAINTS <tên>` theo tên
    // sẽ chạm cả hai; bước 4 phải từ chối (nhóm theo tên có `bool_or(condeferrable)` dù FK tự nó không deferrable).
    [
      'a NOT DEFERRABLE foreign key named like a deferrable trigger of another table',
      'fk',
      [
        `ALTER TABLE k9c_a ADD CONSTRAINT k9c_a_pk PRIMARY KEY (n);`,
        `ALTER TABLE k9c_b ADD CONSTRAINT k9c_dup_ck FOREIGN KEY (n) REFERENCES k9c_a (n) NOT DEFERRABLE;`,
      ],
    ],
  ] as const)(
    'K-9b (c): %s → step 4 raises and the whole batch rolls back',
    async (_n, suffix, clash) => {
      const fixture = `Migration29990101000007_k9c_dup_names_${suffix}`;
      const catalogue = `Migration29990101000008_k9c_catalogue_${suffix}`;
      await expect(
        run(
          catalogueMigration(fixture, [
            `CREATE TABLE k9c_a (n int);`,
            `CREATE TABLE k9c_b (n int);`,
            `CREATE FUNCTION k9c_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;`,
            `CREATE CONSTRAINT TRIGGER k9c_dup_ck AFTER INSERT ON k9c_a DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION k9c_noop();`,
            ...clash,
          ]),
          catalogueMigration(catalogue, sevenStep([])),
        ),
      ).rejects.toThrow(
        /a deferrable constraint name must be unique per schema/,
      );
      expect(
        (
          await owner.query(
            `SELECT to_regclass('public.k9c_a') IS NULL AS gone`,
          )
        ).rows,
      ).toEqual([{ gone: true }]);
    },
  );

  it('K-17 (role): adding requires edges on a chain R → P (+ P → Q) and a diamond (L → B, R → B) narrows to the fixpoint; full sets and other roles unchanged; no set grows', async () => {
    const before = await sets();
    const v0 = await versions();
    const name = 'Migration29990101000009_k17_add_requires';
    await run(
      catalogueMigration(
        name,
        sevenStep(
          addRequiresEdgesDml(name, [
            ['ledger.post', 'ledger.read'],
            ['audit.left', 'audit.base'],
            ['audit.right', 'audit.base'],
          ]),
        ),
      ),
    );
    const after = await sets();
    expect([...(after.get(role.chain!.id) ?? [])]).toEqual([]);
    expect([...(after.get(role.diamond!.id) ?? [])]).toEqual([]);
    expect(after.get(role.chainFull!.id)).toEqual(
      before.get(role.chainFull!.id),
    );
    expect(after.get(role.diamondFull!.id)).toEqual(
      before.get(role.diamondFull!.id),
    );
    expectNarrowedOnly(before, after);
    expect(await openSets()).toBe(0);
    const v1 = await versions();
    const touched = [role.chain!, role.diamond!];
    for (const r of touched) expect(v1.get(r.id)).toBe((v0.get(r.id) ?? 0) + 1);
    for (const r of [role.chainFull!, role.diamondFull!])
      expect(v1.get(r.id)).toBe(v0.get(r.id));
    expect((await events(name)).map((e) => e.aggregate.id).sort()).toEqual(
      touched.map((r) => r.publicId).sort(),
    );
  });
});
