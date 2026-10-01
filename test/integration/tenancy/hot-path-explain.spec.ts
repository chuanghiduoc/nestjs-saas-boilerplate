import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { HOT_PATH_SQL } from '../../../src/modules/tenancy/infra/sql/sql-access.reader.js';
import { ROLE_PERMISSIONS_SQL } from '../../../src/modules/tenancy/infra/sql/sql-role.repository.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';
import {
  TENANCY_ONLY_CATALOGUE,
  roleSetC1,
} from '../../support/tenancy-seed.js';

const ORGS = 10_000;
const MEMBERS_PER_ORG = 20;
const USERS = 50_000;
const TENANT_TABLES = [
  'organizations',
  'org_roles',
  'org_members',
  'org_role_permissions',
] as const;
/** Test DB không có app: một tập đóng có thật trong DB (R-X24). */
const C1 = roleSetC1(TENANCY_ONLY_CATALOGUE);

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};
const nodes = (n: PlanNode): PlanNode[] => [
  n,
  ...(n.Plans ?? []).flatMap(nodes),
];

describe('hot-path membership query plan on realistic volume (spec SP3 §7.3)', () => {
  let scratch: ScratchDb;
  let owner: pg.Client;
  let app: pg.Client;
  let target: { org_id: string; subject: string } | undefined;
  let customTarget: { org_id: string; role_id: string } | undefined;
  beforeAll(async () => {
    applyTestEnv();
    scratch = await createScratchDb('hotpath');
    vi.stubEnv('DB_NAME', scratch.name);
    await runMigrations('up', {
      source: { kind: 'list', list: coreMigrationList() },
    });
    owner = await scratch.client('owner');
    app = await scratch.client('app');
    // Seed hàng loạt bằng app_owner: tạm NO FORCE (mẫu mục 8.8), rồi FORCE lại.
    await owner.query('BEGIN');
    for (const t of TENANT_TABLES)
      await owner.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await owner.query(
      `INSERT INTO tenancy_users (external_subject) SELECT 'load:' || g FROM generate_series(1, ${USERS}) g`,
    );
    await owner.query(
      `INSERT INTO organizations (id, name) SELECT uuidv7(), 'Load ' || g FROM generate_series(1, ${ORGS}) g`,
    );
    await owner.query(
      `INSERT INTO org_roles (org_id, system_key) SELECT o.id, k FROM organizations o CROSS JOIN unnest(ARRAY['OWNER','ADMIN','MEMBER']) k`,
    );
    await owner.query(`INSERT INTO org_members (org_id, user_id, role_id)
      SELECT o.id, ((o.rn * ${MEMBERS_PER_ORG} + s) % ${USERS}) + 1, r.id
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM organizations) o
      CROSS JOIN generate_series(0, ${MEMBERS_PER_ORG - 1}) s
      JOIN org_roles r ON r.org_id = o.id AND r.system_key = CASE WHEN s = 0 THEN 'OWNER' ELSE 'MEMBER' END`);
    await owner.query(
      `INSERT INTO org_roles (org_id, name) SELECT id, 'Custom' FROM organizations`,
    );
    // Seed hàng loạt: tắt trigger closure trong chính transaction seed (tập C1 đã đóng; 40 000 lần kiểm lúc COMMIT không
    // chứng minh thêm gì cho EXPLAIN), bật lại trước COMMIT. Chỉ ở DB riêng của test này.
    await owner.query(
      'ALTER TABLE org_role_permissions DISABLE TRIGGER org_role_permissions_closed_ck',
    );
    await owner.query(
      `INSERT INTO org_role_permissions (org_id, role_id, permission_id)
       SELECT r.org_id, r.id, p.id FROM org_roles r CROSS JOIN permissions p
       WHERE r.system_key IS NULL AND p.key = ANY($1::text[])`,
      [C1],
    );
    await owner.query(
      'ALTER TABLE org_role_permissions ENABLE TRIGGER org_role_permissions_closed_ck',
    );
    // COMMIT trước khi bật lại FORCE: trigger hoãn (bootstrap, owner cuối) chạy ở COMMIT khi app_owner còn thấy dòng;
    // `ALTER TABLE` trong cùng transaction bị Postgres từ chối vì còn "pending trigger events". DB riêng, nên khoảng
    // hở giữa hai bước không lộ gì.
    await owner.query('COMMIT');
    // Chọn member đích khi app_owner còn thấy dòng (sau FORCE thì 0 dòng).
    const { rows: pick } = await owner.query<{
      org_id: string;
      subject: string;
    }>(
      `SELECT m.org_id::text AS org_id, u.external_subject AS subject FROM org_members m JOIN tenancy_users u ON u.id = m.user_id OFFSET 123457 LIMIT 1`,
    );
    target = pick[0];
    // Role tuỳ biến đích, cũng chọn khi app_owner còn thấy dòng.
    const { rows: pickRole } = await owner.query<{
      org_id: string;
      role_id: string;
    }>(
      `SELECT org_id::text AS org_id, id::text AS role_id FROM org_roles WHERE system_key IS NULL OFFSET 4321 LIMIT 1`,
    );
    customTarget = pickRole[0];
    for (const t of TENANT_TABLES)
      await owner.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await owner.query('ANALYZE');
  }, 300_000);
  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await scratch?.drop();
    vi.unstubAllEnvs();
  });

  it('uses the unique indexes, no sequential scan on tenant tables, and prints EXPLAIN (ANALYZE, BUFFERS)', async () => {
    if (!target) throw new Error('seed produced no member');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.org_id', $1, true)`, [
      target.org_id,
    ]);
    const sql = HOT_PATH_SQL.EXTERNAL.replace('?', '$1');
    const { rows } = await app.query<{
      'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }];
    }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [target.subject]);
    const text = await app.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      [target.subject],
    );
    await app.query('ROLLBACK');
    const plan = rows[0]?.['QUERY PLAN'][0];
    if (!plan) throw new Error('no plan');
    console.info(
      `hot path plan (${ORGS} orgs × ${MEMBERS_PER_ORG} members):\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}`,
    );
    const all = nodes(plan.Plan);
    const seqScans = all
      .filter((n) => n['Node Type'] === 'Seq Scan')
      .map((n) => n['Relation Name']);
    expect(seqScans).toEqual([]);
    const indexes = all.map((n) => n['Index Name']).filter(Boolean);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'organizations_pkey',
        'org_members_org_user_uq',
        'tenancy_users_external_subject_uq',
      ]),
    );
  });
  it('the custom-role query (second statement of spec §7.3) uses the PK of org_role_permissions and filters deprecated keys', async () => {
    const target = customTarget;
    if (!target) throw new Error('seed produced no custom role');
    // `Db.execute` trải mảng vào `ARRAY[?]`; ở pg thẳng, `$1` là cả mảng bigint[].
    const sql = ROLE_PERMISSIONS_SQL.replace('ARRAY[?]', '$1');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.org_id', $1, true)`, [
      target.org_id,
    ]);
    const { rows } = await app.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      [[target.role_id]],
    );
    const text = await app.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      [[target.role_id]],
    );
    const keys = await app.query<{ key: string }>(sql, [[target.role_id]]);
    await app.query('ROLLBACK');
    console.info(
      `custom role query plan (${ORGS} orgs):\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}`,
    );
    const all = nodes(rows[0]!['QUERY PLAN'][0].Plan);
    expect(
      all.filter(
        (n) =>
          n['Node Type'] === 'Seq Scan' &&
          n['Relation Name'] === 'org_role_permissions',
      ),
    ).toEqual([]);
    expect(all.map((n) => n['Index Name']).filter(Boolean)).toContain(
      'org_role_permissions_pk',
    );
    expect(keys.rows.map((r) => r.key)).toEqual(C1);
    // deprecated_at lọc ở SQL: đánh dấu một key trong transaction owner rồi ROLLBACK (DB riêng; không đổi catalogue thật).
    await owner.query('BEGIN');
    await owner.query(
      `UPDATE permissions SET deprecated_at = now() WHERE key = 'roles.read'`,
    );
    await owner.query(
      `ALTER TABLE org_role_permissions NO FORCE ROW LEVEL SECURITY`,
    );
    await owner.query(`SELECT set_config('app.org_id', $1, true)`, [
      target.org_id,
    ]);
    const filtered = await owner.query<{ key: string }>(sql, [
      [target.role_id],
    ]);
    await owner.query('ROLLBACK');
    expect(filtered.rows.map((r) => r.key)).not.toContain('roles.read');
  });
});
