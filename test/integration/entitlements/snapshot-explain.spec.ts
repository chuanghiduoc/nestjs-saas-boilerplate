import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { SNAPSHOT_SQL } from '../../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { coreMigrationList } from '../../support/migrate-test-db.js';
import { createScratchDb, type ScratchDb } from '../../support/scratch-db.js';

const ORGS = 10_000;
/** Lô nhỏ: mỗi org mới qua trigger hoãn `organizations_bootstrap_ck` lúc COMMIT; lô 1 000 giữ bảng khoá của một transaction nhỏ. */
const BATCH = 1_000;
const OVERRIDES_PER_ORG = 5;
const FORCED = [
  'organizations',
  'org_roles',
  'org_members',
  'org_entitlements',
  'org_entitlement_overrides',
] as const;

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

describe('entitlement snapshot query plan on realistic volume × 5 overrides (spec SP4 §8.4)', () => {
  let scratch: ScratchDb;
  let owner: pg.Client;
  let app: pg.Client;
  /** Org được EXPLAIN: chọn trước khi bật lại FORCE (sau đó owner không thấy dòng nào). */
  let orgId: string;
  beforeAll(async () => {
    applyTestEnv();
    scratch = await createScratchDb('snapexplain');
    vi.stubEnv('DB_NAME', scratch.name);
    await runMigrations('up', {
      source: { kind: 'list', list: coreMigrationList() },
    });
    owner = await scratch.client('owner');
    app = await scratch.client('app');
    // Database riêng của file (không ai khác đọc): bỏ FORCE một lần cho cả lượt seed. Không đặt ALTER trong transaction
    // của lô: trigger hoãn `organizations_bootstrap_ck` còn chờ tới COMMIT thì Postgres từ chối `ALTER TABLE … FORCE`.
    for (const t of FORCED)
      await owner.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await owner.query(
      `INSERT INTO entitlement_features (key, kind) SELECT 'load.f' || g, 'LIMIT' FROM generate_series(1, ${OVERRIDES_PER_ORG}) g`,
    );
    for (let from = 1; from <= ORGS; from += BATCH) {
      const to = from + BATCH - 1;
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO tenancy_users (external_subject) SELECT 'load:' || g FROM generate_series(${from}, ${to}) g`,
      );
      await owner.query(
        `INSERT INTO organizations (id, name, created_by_user_id)
         SELECT uuidv7(), 'Load ' || g, u.id FROM generate_series(${from}, ${to}) g JOIN tenancy_users u ON u.external_subject = 'load:' || g`,
      );
      await owner.query(
        `INSERT INTO org_roles (org_id, system_key) SELECT o.id, k FROM organizations o CROSS JOIN unnest(ARRAY['OWNER', 'ADMIN', 'MEMBER']) k
         WHERE NOT EXISTS (SELECT 1 FROM org_roles r WHERE r.org_id = o.id)`,
      );
      await owner.query(
        `INSERT INTO org_members (org_id, user_id, role_id)
         SELECT o.id, o.created_by_user_id, r.id FROM organizations o JOIN org_roles r ON r.org_id = o.id AND r.system_key = 'OWNER'
         WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id)`,
      );
      await owner.query(
        `INSERT INTO org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
         SELECT o.id, p.id, 'DEFAULT', now() FROM organizations o CROSS JOIN plans p WHERE p.key = 'free' ON CONFLICT (org_id) DO NOTHING`,
      );
      await owner.query(
        `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason)
         SELECT o.id, f.id, 1, 'load' FROM organizations o CROSS JOIN entitlement_features f
         WHERE f.key LIKE 'load.f%' AND NOT EXISTS (SELECT 1 FROM org_entitlement_overrides x WHERE x.org_id = o.id)`,
      );
      await owner.query('COMMIT');
    }
    const { rows: pick } = await owner.query<{ id: string }>(
      `SELECT id::text AS id FROM organizations ORDER BY id OFFSET 4321 LIMIT 1`,
    );
    const picked = pick[0]?.id;
    if (!picked) throw new Error('seed produced no organization');
    orgId = picked;
    for (const t of FORCED)
      await owner.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await owner.query('ANALYZE');
  }, 300_000);
  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await scratch?.drop();
    vi.unstubAllEnvs();
  });

  it('reads one org × 5 overrides by the org_entitlements and org_entitlement_overrides primary keys (no sequential scan of either) and prints EXPLAIN (ANALYZE, BUFFERS)', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    const { rows } = await app.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SNAPSHOT_SQL}`,
    );
    const text = await app.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${SNAPSHOT_SQL}`,
    );
    expect((await app.query(SNAPSHOT_SQL)).rowCount).toBe(OVERRIDES_PER_ORG);
    await app.query('ROLLBACK');
    const plan = rows[0]?.['QUERY PLAN'][0];
    if (!plan) throw new Error('no plan');
    console.info(
      `entitlement snapshot plan (${ORGS} orgs):\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}`,
    );
    const all = nodes(plan.Plan);
    expect(
      all.filter(
        (n) =>
          n['Node Type'] === 'Seq Scan' &&
          n['Relation Name'] === 'org_entitlement_overrides',
      ),
    ).toEqual([]);
    expect(all.map((n) => n['Index Name'])).toContain(
      'org_entitlement_overrides_pkey',
    );
    expect(
      all.filter(
        (n) =>
          n['Node Type'] === 'Seq Scan' &&
          n['Relation Name'] === 'org_entitlements',
      ),
    ).toEqual([]);
    expect(all.map((n) => n['Index Name'])).toContain('org_entitlements_pkey');
  });
});
