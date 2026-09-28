import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFINER_LIMIT_MAX,
  PURGE_CURSOR_START,
} from '../../../src/modules/tenancy/constants.js';
import { getInfra } from '../../support/infra.js';
import {
  inOrgTx,
  seedMember,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const subject = `test:definer-${v7()}`;
const orgs: SeededOrg[] = [];
let userId = '';
let owned: SeededOrg;
let memberOf: SeededOrg;
let deletedOwned: SeededOrg;
let deletedMemberOf: SeededOrg;
let createdThenLeft: SeededOrg;

const call = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
  withAppClient(async (c) => (await c.query<T>(sql, params)).rows);
const softDelete = (o: SeededOrg, purgeAfter: string) =>
  withAppClient((c) =>
    inOrgTx(c, o.orgId, () =>
      c.query(
        `UPDATE organizations SET deleted_at = now() - interval '2 days', purge_after = ${purgeAfter}`,
      ),
    ),
  );

beforeAll(async () => {
  owned = await seedOrg({ owner: { externalSubject: subject } });
  userId = owned.owner.userId;
  memberOf = await seedOrg();
  await seedMember(memberOf, 'MEMBER', { externalSubject: subject });
  deletedOwned = await seedOrg({ owner: { externalSubject: subject } });
  deletedMemberOf = await seedOrg();
  await seedMember(deletedMemberOf, 'ADMIN', { externalSubject: subject });
  createdThenLeft = await seedOrg({ owner: { externalSubject: subject } });
  // "Tạo org rồi rời": thêm một owner khác rồi xoá membership của user (hợp lệ vì org còn owner).
  await seedMember(createdThenLeft, 'OWNER');
  await withAppClient((c) =>
    inOrgTx(c, createdThenLeft.orgId, () =>
      c.query(`DELETE FROM org_members WHERE id = $1`, [
        createdThenLeft.owner.memberId,
      ]),
    ),
  );
  await softDelete(deletedOwned, `now() - interval '1 day'`);
  await softDelete(deletedMemberOf, `now() + interval '1 day'`);
  orgs.push(owned, memberOf, deletedOwned, deletedMemberOf, createdThenLeft);
});
afterAll(async () => {
  for (const o of orgs) await o.dispose();
});

describe('definer functions called by app_user without an org context (spec SP3 §6.14)', () => {
  it('tenancy_list_user_orgs lists memberships in join order; soft-deleted orgs only for owners and only when asked', async () => {
    const active = await call<{ org_id: string; role_system_key: string }>(
      `SELECT org_id::text, role_system_key FROM tenancy_list_user_orgs($1, false, 100, 0)`,
      [userId],
    );
    expect(active.map((r) => r.org_id)).toEqual([owned.orgId, memberOf.orgId]);
    const withDeleted = await call<{
      org_id: string;
      org_deleted_at: Date | null;
    }>(
      `SELECT org_id::text, org_deleted_at FROM tenancy_list_user_orgs($1, true, 100, 0)`,
      [userId],
    );
    expect(withDeleted.map((r) => r.org_id)).toEqual([
      owned.orgId,
      memberOf.orgId,
      deletedOwned.orgId,
    ]);
    expect(withDeleted.at(-1)?.org_deleted_at).toBeInstanceOf(Date);
    const [count] = await call<{ n: string }>(
      `SELECT tenancy_count_user_orgs($1, true) AS n`,
      [userId],
    );
    expect(Number(count?.n)).toBe(withDeleted.length);
    const page = await call(
      `SELECT * FROM tenancy_list_user_orgs($1, false, 1, 1)`,
      [userId],
    );
    expect(page).toHaveLength(1);
  });
  it('tenancy_count_orgs_created_by counts orgs the user created, soft-deleted included (S3-A22)', async () => {
    const [r] = await call<{ n: string }>(
      `SELECT tenancy_count_orgs_created_by($1) AS n`,
      [userId],
    );
    expect(Number(r?.n)).toBe(3);
  });
  it('tenancy_user_sole_owner_orgs returns active orgs where the user is the only owner', async () => {
    const rows = await call<{ org_id: string }>(
      `SELECT org_id::text FROM tenancy_user_sole_owner_orgs($1)`,
      [userId],
    );
    expect(rows.map((r) => r.org_id)).toEqual([owned.orgId]);
  });
  it('tenancy_user_related_org_ids covers memberships and created orgs the user left, ordered by org id', async () => {
    const rows = await call<{ org_id: string }>(
      `SELECT org_id::text FROM tenancy_user_related_org_ids($1)`,
      [userId],
    );
    expect(rows.map((r) => r.org_id)).toEqual(
      [owned, memberOf, deletedOwned, deletedMemberOf, createdThenLeft]
        .map((o) => o.orgId)
        .sort(),
    );
  });
  it('tenancy_orgs_due_for_purge walks soft-deleted orgs past purge_after by keyset', async () => {
    const first = await call<{ org_id: string }>(
      `SELECT org_id::text FROM tenancy_orgs_due_for_purge($1, $2)`,
      [PURGE_CURSOR_START, DEFINER_LIMIT_MAX],
    );
    expect(first.map((r) => r.org_id)).toContain(deletedOwned.orgId);
    expect(first.map((r) => r.org_id)).not.toContain(deletedMemberOf.orgId);
    const after = await call(
      `SELECT org_id FROM tenancy_orgs_due_for_purge($1, $2)`,
      [deletedOwned.orgId, DEFINER_LIMIT_MAX],
    );
    expect(after.map((r) => String(r.org_id))).not.toContain(
      deletedOwned.orgId,
    );
  });
  it.each([
    ['NULL user', `SELECT * FROM tenancy_list_user_orgs(NULL, false, 1, 0)`],
    ['NULL flag', `SELECT * FROM tenancy_count_user_orgs(1, NULL)`],
    ['limit 0', `SELECT * FROM tenancy_list_user_orgs(1, false, 0, 0)`],
    [
      `limit ${DEFINER_LIMIT_MAX + 1}`,
      `SELECT * FROM tenancy_list_user_orgs(1, false, ${DEFINER_LIMIT_MAX + 1}, 0)`,
    ],
    [
      'negative offset',
      `SELECT * FROM tenancy_list_user_orgs(1, false, 1, -1)`,
    ],
    ['NULL cursor', `SELECT * FROM tenancy_orgs_due_for_purge(NULL, 1)`],
    [
      'NULL user (sole owner)',
      `SELECT * FROM tenancy_user_sole_owner_orgs(NULL)`,
    ],
    ['NULL user (related)', `SELECT * FROM tenancy_user_related_org_ids(NULL)`],
    ['NULL user (created)', `SELECT tenancy_count_orgs_created_by(NULL)`],
  ])(
    '%s → raises (DB-M3: never an empty answer that would allow a deletion)',
    async (_n, sql) => {
      await expect(call(sql, [])).rejects.toMatchObject({ code: 'P0001' });
    },
  );
});

describe('the definer role cannot write, and only SET LOCAL ROLE can drop its functions (T2, S3-A31)', () => {
  const { pg: p } = getInfra();
  let owner: pg.Client;
  beforeAll(async () => {
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE tenancy_definer');
    await owner.query(
      `CREATE FUNCTION public.tenancy_probe_write() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN UPDATE public.organizations SET name = name; END $$`,
    );
    await owner.query(
      `REVOKE ALL ON FUNCTION public.tenancy_probe_write() FROM PUBLIC`,
    );
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.tenancy_probe_write() TO app_user`,
    );
    await owner.query('RESET ROLE');
    await owner.query('COMMIT');
  });
  afterAll(async () => {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE tenancy_definer');
    await owner.query('DROP FUNCTION IF EXISTS public.tenancy_probe_write()');
    await owner.query('RESET ROLE');
    await owner.query('COMMIT');
    await owner.end();
  });
  it('a definer function that tries to UPDATE fails with 42501', async () => {
    await expect(
      call(`SELECT public.tenancy_probe_write()`, []),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('bare app_owner cannot DROP it (42501); under SET LOCAL ROLE tenancy_definer it can', async () => {
    await expect(
      owner.query('DROP FUNCTION public.tenancy_probe_write()'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
