import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/core/database/index.js';
import { toEnvelope } from '../../../src/core/events/event-dispatch.handlers.js';
import { parseEnvelope } from '../../../src/core/events/index.js';
import {
  ApiKeyScopeNarrowedEvent,
  SupportAccessScopeNarrowedEvent,
} from '../../../src/modules/tenancy/events.js';
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
  seedOrg,
  seedOrgApiKey,
  seedSupportGrant,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const TABLE = 'mikro_orm_migrations_delegation_catalogue';
/** Fixture eligible cho cả key lẫn grant (read): chuỗi R → P → Q dựng bằng cạnh mới; hình thoi top → left/right → base. */
const KEYS = [
  ['chain', 'read'],
  ['chainp', 'read'],
  ['chainq', 'read'],
  ['gone', 'read'],
  ['top', 'read'],
  ['left', 'read'],
  ['right', 'read'],
  ['base', 'read'],
] as const;
const JOINS = [
  { join: 'org_api_key_permissions', parent: 'org_api_keys', fk: 'api_key_id' },
  {
    join: 'org_support_grant_permissions',
    parent: 'org_support_grants',
    fk: 'grant_id',
  },
] as const;

describe('catalogue migrations narrow org key and support grant scopes (spec SP3 §8.8; §18.3 K-9, K-17 key/grant)', () => {
  let db: ScratchDb;
  let owner: pg.Client;
  let org: SeededOrg;
  let key: { publicId: string };
  let grant: { publicId: string };
  const run = (...m: ReturnType<typeof catalogueMigration>[]) =>
    runMigrations('up', {
      source: { kind: 'list', list: m },
      tableName: TABLE,
    });
  /** Bảng 3D là FORCE RLS: đọc bằng app_user trong OrgScope (client owner không có org context thì không thấy dòng nào). */
  const inOrg = <T>(fn: (c: pg.Client) => Promise<T>) =>
    withAppClient((c) => inOrgTx(c, org.orgId, () => fn(c)), db.name);
  const scopeOf = (j: (typeof JOINS)[number], publicId: string) =>
    inOrg(async (c) =>
      (
        await c.query<{ key: string }>(
          `SELECT p.key FROM ${j.join} s JOIN permissions p ON p.id = s.permission_id
           JOIN ${j.parent} x ON x.org_id = s.org_id AND x.id = s.${j.fk}
           WHERE x.public_id = $1 ORDER BY p.key`,
          [publicId],
        )
      ).rows.map((r) => r.key),
    );
  const scopes = async () => ({
    key: await scopeOf(JOINS[0], key.publicId),
    grant: await scopeOf(JOINS[1], grant.publicId),
  });
  const events = async (migration: string) =>
    (
      await owner.query(
        `SELECT id::text AS id, event_id::text AS event_id, type, version, org_id::text AS org_id, aggregate_type, aggregate_id,
                aggregate_version::text AS aggregate_version, payload, headers, occurred_at
         FROM outbox_events WHERE headers->>'actorId' = $1 AND type <> 'tenancy.role.updated' ORDER BY id`,
        [`catalogue-migration:${migration}`],
      )
    ).rows.map((row) =>
      row.type === 'tenancy.api_key.scope_narrowed'
        ? parseEnvelope(ApiKeyScopeNarrowedEvent, toEnvelope(row))
        : parseEnvelope(SupportAccessScopeNarrowedEvent, toEnvelope(row)),
    );

  beforeAll(async () => {
    applyTestEnv();
    db = await createScratchDb('delcat');
    vi.stubEnv('DB_NAME', db.name);
    await runMigrations('up', {
      source: { kind: 'list', list: coreMigrationList() },
    });
    owner = await db.client('owner');
    await owner.query(
      `INSERT INTO permissions (resource, action, owner_only, api_key_eligible, support_eligible) SELECT r, a, false, true, true FROM unnest($1::text[], $2::text[]) AS k (r, a)`,
      [KEYS.map(([r]) => r), KEYS.map(([, a]) => a)],
    );
    await owner.query(
      `INSERT INTO permission_requires (permission_id, required_permission_id) SELECT p.id, q.id FROM (VALUES ('top.read','left.read'),('top.read','right.read')) e (k, req) JOIN permissions p ON p.key = e.k JOIN permissions q ON q.key = e.req`,
    );
    org = await seedOrg({ database: db.name });
    const scope = [
      'chain.read',
      'chainp.read',
      'gone.read',
      'top.read',
      'left.read',
      'right.read',
    ];
    key = await seedOrgApiKey(org, {
      createdByMemberId: org.owner.memberId,
      permissions: scope,
    });
    grant = await seedSupportGrant(org, {
      grantee: { externalSubject: 'test:delcat' },
      grantedByMemberId: org.owner.memberId,
      permissions: scope,
    });
    await owner.query(
      `UPDATE permissions SET deprecated_at = now() WHERE key = 'gone.read'`,
    );
  }, 180_000);
  afterAll(async () => {
    await owner?.end();
    vi.unstubAllEnvs();
    await db?.drop();
  });

  it('K-9 (key/grant): removing a permission deletes its rows from both scopes, bumps version, emits one scope_narrowed per touched delegation', async () => {
    const name = 'Migration29990201000001_remove_gone';
    await run(
      catalogueMigration(
        name,
        sevenStep(removePermissionDml(name, 'gone.read')),
      ),
    );
    const after = await scopes();
    expect(after.key).not.toContain('gone.read');
    expect(after.grant).not.toContain('gone.read');
    const evs = await events(name);
    expect(evs.map((e) => [e.type, e.aggregate.id])).toEqual([
      ['tenancy.api_key.scope_narrowed', key.publicId],
      ['tenancy.support_access.scope_narrowed', grant.publicId],
    ]);
    expect(evs.map((e) => e.data.permissions)).toEqual([
      after.key,
      after.grant,
    ]);
  });
  it('K-17 (key/grant): a new requires edge on R → P → Q and the diamond leaves every scope closed, never larger, each touched one with an event', async () => {
    const before = await scopes();
    const name = 'Migration29990201000002_edges';
    await run(
      catalogueMigration(
        name,
        sevenStep(
          addRequiresEdgesDml(name, [
            ['chain.read', 'chainp.read'],
            ['chainp.read', 'chainq.read'],
            ['left.read', 'base.read'],
          ]),
        ),
      ),
    );
    const after = await scopes();
    for (const k of ['key', 'grant'] as const) {
      expect(
        after[k].every((p) => before[k].includes(p)),
        k,
      ).toBe(true);
      expect(after[k], k).not.toContain('chain.read'); // chainp thiếu chainq → bị gỡ → chain thiếu chainp → bị gỡ (bắc cầu)
      expect(after[k], k).not.toContain('top.read'); // left thiếu base → bị gỡ → top thiếu left → bị gỡ
      expect(after[k], k).toContain('right.read');
    }
    for (const j of JOINS) {
      const open = await inOrg((c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${j.join} s JOIN permission_requires r ON r.permission_id = s.permission_id
           WHERE NOT EXISTS (SELECT 1 FROM ${j.join} t WHERE t.org_id = s.org_id AND t.${j.fk} = s.${j.fk} AND t.permission_id = r.required_permission_id)`,
        ),
      );
      expect(open.rows[0]?.n, j.join).toBe(0);
    }
    expect((await events(name)).map((e) => e.type).sort()).toEqual([
      'tenancy.api_key.scope_narrowed',
      'tenancy.support_access.scope_narrowed',
    ]);
    const v = await inOrg((c) =>
      c.query<{ k: number; g: number }>(
        `SELECT (SELECT version FROM org_api_keys WHERE public_id = $1) AS k, (SELECT version FROM org_support_grants WHERE public_id = $2) AS g`,
        [key.publicId, grant.publicId],
      ),
    );
    expect(v.rows[0]).toEqual({ k: 3, g: 3 });
  });
});
