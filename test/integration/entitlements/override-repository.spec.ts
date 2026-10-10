import { Module, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  OrgScope,
  UnitOfWork,
} from '../../../src/core/database/index.js';
import { SqlOrgEntitlementRepository } from '../../../src/modules/entitlements/infra/sql/sql-org-entitlement.repository.js';
import { SqlOverrideRepository } from '../../../src/modules/entitlements/infra/sql/sql-override.repository.js';
import { createTestApp } from '../../support/app-factory.js';
import {
  readOrgEntitlement,
  seedFeatures,
  seedOrgEntitlement,
  seedOverride,
  seedPlans,
  withOwner,
} from '../../support/entitlements-seed.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

const LOCK_NOT_AVAILABLE = '55P03';
const HOUR_MS = 3_600_000;

@Module({ providers: [SqlOverrideRepository, SqlOrgEntitlementRepository] })
class RepoModule {}

describe('SqlOverrideRepository and readAdminRoot (spec SP4 §7.4, §12.2)', () => {
  let app: INestApplication;
  let a: SeededOrg;
  let bare: SeededOrg;
  let cap: string;
  const disposers: (() => Promise<void>)[] = [];
  const repo = () => app.get(SqlOverrideRepository);
  const inTx = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
  const write = (
    limitValue: number | null,
    reason: string,
    expiresAt: Date | null,
  ) =>
    inTx(a.orgId, () =>
      repo().upsert({
        featureId: cap,
        flagValue: null,
        limitValue,
        reason,
        expiresAt,
      }),
    );
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RepoModule,
    ]);
    disposers.push(
      await seedFeatures([
        {
          key: 'ovrepo.cap',
          kind: 'LIMIT',
          resetPeriod: null,
          deprecated: false,
        },
        {
          key: 'ovrepo.flag',
          kind: 'FLAG',
          resetPeriod: null,
          deprecated: false,
        },
      ]),
    );
    disposers.push(await seedPlans([{ key: 'ovrepo_plan' }]));
    const [row] = (
      await withOwner((c) =>
        c.query<{ id: string }>(
          `SELECT id::text AS id FROM entitlement_features WHERE key = 'ovrepo.cap'`,
        ),
      )
    ).rows;
    if (!row) throw new Error('ovrepo.cap not seeded');
    cap = row.id;
    a = await seedOrg();
    bare = await seedOrg();
    await seedOrgEntitlement(a.orgId, 'ovrepo_plan', {
      source: 'BILLING',
      sourceRef: 'sub_7',
      lastBillingSeq: 4n,
    });
  });
  afterAll(async () => {
    for (const o of [a, bare]) await o?.dispose();
    for (const d of disposers.reverse()) await d();
    await app?.close();
  });

  it('lockRoot returns the version and the clock after the lock, and holds FOR NO KEY UPDATE until the transaction ends; no row → undefined', async () => {
    await inTx(a.orgId, async () => {
      const root = await repo().lockRoot();
      expect(root?.version).toBe(1);
      expect(root?.now).toBeInstanceOf(Date);
      const other = await withAppClient((c) =>
        inOrgTx(c, a.orgId, () =>
          c.query(
            'SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR NO KEY UPDATE NOWAIT',
          ),
        ),
      ).then(
        () => 'acquired',
        (e: unknown) => Reflect.get(Object(e), 'code'),
      );
      expect(other).toBe(LOCK_NOT_AVAILABLE);
    });
    expect(await inTx(bare.orgId, () => repo().lockRoot())).toBeUndefined();
  });
  it('upsert inserts, then replaces every value of the same feature (created_at kept, updated_at moves)', async () => {
    await write(5, 'first', null);
    const until = new Date(Date.now() + HOUR_MS);
    await write(9, 'second', until);
    const [row] = await inTx(a.orgId, () => repo().listAll());
    expect(row).toMatchObject({
      featureKey: 'ovrepo.cap',
      flagValue: null,
      limitValue: 9,
      reason: 'second',
      expiresAt: until,
    });
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });
  it('findOne returns the current row of a feature under the lock (expired rows included); an absent feature → undefined', async () => {
    expect(await inTx(a.orgId, () => repo().findOne(cap))).toMatchObject({
      featureKey: 'ovrepo.cap',
      limitValue: 9,
      reason: 'second',
    });
    expect(await inTx(bare.orgId, () => repo().findOne(cap))).toBeUndefined();
  });
  it('a past expiry through the repository is refused on the PROPOSED row (the CHECK runs before conflict handling): 23514 expiry_ck', async () => {
    const err: unknown = await write(
      1,
      'late',
      new Date(Date.now() - HOUR_MS),
    ).catch((e: unknown) => e);
    expect([
      Reflect.get(Object(err), 'code'),
      Reflect.get(Object(err), 'constraint'),
    ]).toEqual(['23514', 'org_entitlement_overrides_expiry_ck']);
  });
  it('the expiry CHECK also guards the DO UPDATE branch: valid VALUES, only the SET makes expires_at not later than updated_at → 23514 (review 4C, I1)', async () => {
    const err: unknown = await withAppClient((c) =>
      inOrgTx(c, a.orgId, () =>
        c.query(
          `INSERT INTO org_entitlement_overrides (org_id, feature_id, limit_value, reason, expires_at, updated_at)
           VALUES (app_current_org(), $1::bigint, 9, 'valid', now() + interval '1 day', clock_timestamp())
           ON CONFLICT (org_id, feature_id) DO UPDATE SET expires_at = now(), updated_at = clock_timestamp()`,
          [cap],
        ),
      ),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect([
      Reflect.get(Object(err), 'code'),
      Reflect.get(Object(err), 'constraint'),
    ]).toEqual(['23514', 'org_entitlement_overrides_expiry_ck']);
  });
  it('listAll includes expired overrides, sorted by feature key', async () => {
    await seedOverride(a.orgId, 'ovrepo.flag', {
      value: { enabled: true },
      expiresInSec: -60,
    });
    const rows = await inTx(a.orgId, () => repo().listAll());
    expect(rows.map((r) => [r.featureKey, r.flagValue, r.limitValue])).toEqual([
      ['ovrepo.cap', null, 9],
      ['ovrepo.flag', true, null],
    ]);
  });
  it('remove deletes the row of the feature (true), then finds nothing (false)', async () => {
    expect(await inTx(a.orgId, () => repo().remove(cap))).toBe(true);
    expect(await inTx(a.orgId, () => repo().remove(cap))).toBe(false);
  });
  it('bumpVersion increments org_entitlements.version and returns the new value', async () => {
    const before = (await readOrgEntitlement(a.orgId))?.version ?? 0;
    expect(await inTx(a.orgId, () => repo().bumpVersion())).toBe(before + 1);
    expect((await readOrgEntitlement(a.orgId))?.version).toBe(before + 1);
  });
  it('readAdminRoot returns the source ref, reason, last billing sequence and the DB clock; no row → undefined', async () => {
    const root = await inTx(a.orgId, () =>
      app.get(SqlOrgEntitlementRepository).readAdminRoot(),
    );
    expect(root).toMatchObject({
      sourceRef: 'sub_7',
      reason: null,
      lastBillingSeq: 4n,
    });
    expect(root?.version).toBeGreaterThanOrEqual(1);
    expect(root?.now).toBeInstanceOf(Date);
    expect(
      await inTx(bare.orgId, () =>
        app.get(SqlOrgEntitlementRepository).readAdminRoot(),
      ),
    ).toBeUndefined();
  });
});
