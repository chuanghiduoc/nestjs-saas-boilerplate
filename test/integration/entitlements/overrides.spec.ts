import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import {
  Overrides,
  type SetOverrideCommand,
} from '../../../src/modules/entitlements/application/overrides.service.js';
import { EntitlementsContextError } from '../../../src/modules/entitlements/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';
import {
  outboxOf,
  readOrgEntitlement,
  readOverrides,
  seedOrgEntitlement,
  seedOverride,
  withOwner,
} from '../../support/entitlements-seed.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';

/** Id của principal nhân viên trong context (chỉ là actor của event; gate là việc của 3D, không chạy ở đây). */
const STAFF = '0198c000-0000-7000-8000-00000000c7a1';
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const v1 = 'W/"1"';
const cmd = (
  value: SetOverrideCommand['value'],
  o: Partial<Omit<SetOverrideCommand, 'value'>> = {},
): SetOverrideCommand => ({
  value,
  reason: o.reason ?? 'goodwill credit',
  expiresAt: o.expiresAt ?? null,
});
const codeOf = (e: unknown) =>
  e instanceof AppError
    ? [e.error.code, e.opts.fields?.[0]?.path]
    : e instanceof Error
      ? e.name
      : e;

describe('Overrides (spec SP4 §7.4, §12.2, §13.1; R-X31)', () => {
  let app: INestApplication;
  let disposeCatalogue: () => Promise<void>;
  const orgs: SeededOrg[] = [];
  /** CLS của một "request" nhân viên: principal rồi OrgScope + UoW, như route admin (S4-D19). */
  const asStaff = <T>(orgId: string, fn: () => Promise<T>, staff = true) =>
    app.get(ClsService).run(() => {
      if (staff)
        app.get(RequestContext).setPrincipal({ type: 'user', id: STAFF });
      return app.get(OrgScope).run(orgId, () => app.get(UnitOfWork).run(fn));
    });
  const set = (
    orgId: string,
    key: string,
    c: SetOverrideCommand,
    ifMatch: string | undefined = v1,
  ) => asStaff(orgId, () => app.get(Overrides).set(key, c, ifMatch));
  const remove = (
    orgId: string,
    key: string,
    ifMatch: string | undefined,
    reason = 'cleanup',
  ) => asStaff(orgId, () => app.get(Overrides).remove(key, reason, ifMatch));
  const failure = (p: Promise<unknown>) => p.then(() => 'resolved', codeOf);
  const orgOn = async (plan: string | undefined) => {
    const o = await seedOrg();
    orgs.push(o);
    if (plan) await seedOrgEntitlement(o.orgId, plan);
    return o;
  };
  beforeAll(async () => {
    disposeCatalogue = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await disposeCatalogue?.();
  });

  it('set writes the override, bumps the aggregate version and publishes override.set with the staff actor and the reason (R-X31)', async () => {
    const o = await orgOn('pro');
    const why = 'goodwill after outage 7731';
    expect(
      await set(o.orgId, 'tenancy.seats', cmd({ limit: 4 }, { reason: why })),
    ).toBe(2);
    expect(await readOverrides(o.orgId)).toEqual([
      {
        feature: 'tenancy.seats',
        flagValue: null,
        limitValue: 4,
        reason: why,
        expiresAt: null,
      },
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(2);
    const events = await outboxOf(o.orgId, 'entitlements.override.set');
    expect(
      events.map((e) => [
        e.payload,
        e.headers.actorType,
        e.headers.actorId,
        e.aggregate_version,
      ]),
    ).toEqual([
      [
        {
          orgId: o.orgId,
          feature: 'tenancy.seats',
          value: { kind: 'LIMIT', limit: 4 },
          expiresAt: null,
          reason: why,
        },
        'user',
        STAFF,
        '2',
      ],
    ]);
  });
  it('a different value replaces the row (one row, version 3); a FLAG takes enabled; the expiry is stored as given', async () => {
    const o = await orgOn('pro');
    const until = new Date(Date.now() + HOUR_MS);
    await set(o.orgId, 'fixture.reports', cmd({ enabled: true }));
    expect(
      await set(
        o.orgId,
        'fixture.reports',
        cmd({ enabled: false }, { expiresAt: until }),
        'W/"2"',
      ),
    ).toBe(3);
    expect(await readOverrides(o.orgId)).toMatchObject([
      {
        feature: 'fixture.reports',
        flagValue: false,
        limitValue: null,
        expiresAt: until,
      },
    ]);
    expect(
      (await outboxOf(o.orgId, 'entitlements.override.set')).map(
        (e) => e.payload.value,
      ),
    ).toEqual([
      { kind: 'FLAG', enabled: true },
      { kind: 'FLAG', enabled: false },
    ]);
  });
  it('Spec-I4: repeating the same state is a no-op (same version, no event), also with a stale ETag; a different state with a stale ETag is 412', async () => {
    const o = await orgOn('pro');
    const until = new Date(Date.now() + HOUR_MS);
    const state = cmd({ limit: 6 }, { reason: 'retry me', expiresAt: until });
    expect(await set(o.orgId, 'tenancy.seats', state)).toBe(2);
    expect(await set(o.orgId, 'tenancy.seats', state, 'W/"2"')).toBe(2);
    expect(await set(o.orgId, 'tenancy.seats', state, v1)).toBe(2);
    expect(
      await failure(
        set(
          o.orgId,
          'tenancy.seats',
          cmd({ limit: 7 }, { reason: 'retry me', expiresAt: until }),
          v1,
        ),
      ),
    ).toEqual(['precondition_failed', undefined]);
    expect(
      await failure(
        set(
          o.orgId,
          'tenancy.seats',
          { ...state, reason: 'another reason' },
          v1,
        ),
      ),
    ).toEqual(['precondition_failed', undefined]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(2);
    expect(await outboxOf(o.orgId, 'entitlements.override.set')).toHaveLength(
      1,
    );
  });
  it('M-3 (accepted, named): replaying an override that already expired, with the same value, reason and past expiresAt, is a 200 no-op (the state is unchanged); a different past expiry is 422', async () => {
    const o = await orgOn('pro');
    await seedOverride(o.orgId, 'tenancy.seats', {
      value: { limit: 3 },
      reason: 'seed override',
      expiresInSec: -60,
    });
    const [stored] = await readOverrides(o.orgId);
    if (!stored?.expiresAt) throw new Error('seeded override has no expiry');
    expect(
      await set(
        o.orgId,
        'tenancy.seats',
        cmd(
          { limit: 3 },
          { reason: 'seed override', expiresAt: stored.expiresAt },
        ),
        'W/"7"',
      ),
    ).toBe(1);
    expect(await outboxOf(o.orgId, 'entitlements.override.set')).toEqual([]);
    expect(
      await failure(
        set(
          o.orgId,
          'tenancy.seats',
          cmd(
            { limit: 3 },
            {
              reason: 'seed override',
              expiresAt: new Date(stored.expiresAt.getTime() - MINUTE_MS),
            },
          ),
        ),
      ),
    ).toEqual(['validation_failed', 'expiresAt']);
  });
  it('validation order: unknown or deprecated feature → 404; wrong kind → 422 on the sent field; below minimum → 422; a bad reason → 422; nothing written', async () => {
    const o = await orgOn('pro');
    expect([
      await failure(set(o.orgId, 'fixture.nope', cmd({ enabled: true }))),
      await failure(set(o.orgId, 'fixture.legacy_pdf', cmd({ enabled: true }))),
      await failure(set(o.orgId, 'fixture.reports', cmd({ limit: 1 }))),
      await failure(set(o.orgId, 'tenancy.seats', cmd({ limit: 0 }))),
      await failure(
        set(o.orgId, 'tenancy.seats', cmd({ limit: 1 }, { reason: ' padded' })),
      ),
    ]).toEqual([
      ['not_found', undefined],
      ['not_found', undefined],
      ['validation_failed', 'limit'],
      ['validation_failed', 'limit'],
      ['validation_failed', 'reason'],
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
    expect(await readOverrides(o.orgId)).toEqual([]);
    expect(await outboxOf(o.orgId, 'entitlements.override.set')).toEqual([]);
  });
  it('If-Match under the lock: missing → 428, * → 428 (Spec-I1), stale → 412; an org without a root row → 404', async () => {
    const o = await orgOn('pro');
    // Gọi thẳng service: tham số mặc định `ifMatch = v1` của `set` biến `undefined` thành `v1` (ca thiếu sẽ rỗng).
    for (const ifMatch of [undefined, '*', ' * '])
      expect(
        await failure(
          asStaff(o.orgId, () =>
            app.get(Overrides).set('tenancy.seats', cmd({ limit: 2 }), ifMatch),
          ),
        ),
        String(ifMatch),
      ).toEqual(['precondition_required', undefined]);
    expect(
      await failure(set(o.orgId, 'tenancy.seats', cmd({ limit: 2 }), 'W/"9"')),
    ).toEqual(['precondition_failed', undefined]);
    expect(
      await failure(
        asStaff(o.orgId, () => app.get(Overrides).lockAggregate('*')),
      ),
    ).toEqual(['precondition_required', undefined]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(1);
    const bare = await orgOn(undefined);
    expect(
      await failure(set(bare.orgId, 'tenancy.seats', cmd({ limit: 2 }))),
    ).toEqual(['not_found', undefined]);
  });
  it('expiresAt not later than the DB clock read after the lock → 422 on expiresAt; nothing written', async () => {
    const o = await orgOn('pro');
    expect(
      await failure(
        set(
          o.orgId,
          'tenancy.seats',
          cmd({ limit: 2 }, { expiresAt: new Date(Date.now() - MINUTE_MS) }),
        ),
      ),
    ).toEqual(['validation_failed', 'expiresAt']);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('remove needs a reason (422 without one), deletes, bumps and publishes override.removed with it; a missing override → 404; a deprecated feature can be cleaned up', async () => {
    const o = await orgOn('pro');
    await set(o.orgId, 'fixture.projects', cmd({ limit: 5 }));
    expect(
      await failure(remove(o.orgId, 'fixture.projects', 'W/"2"', '  ')),
    ).toEqual(['validation_failed', 'reason']);
    expect(
      await remove(o.orgId, 'fixture.projects', 'W/"2"', 'pilot ended'),
    ).toBe(3);
    expect(
      (await outboxOf(o.orgId, 'entitlements.override.removed')).map((e) => [
        e.payload,
        e.aggregate_version,
      ]),
    ).toEqual([
      [
        { orgId: o.orgId, feature: 'fixture.projects', reason: 'pilot ended' },
        '3',
      ],
    ]);
    expect(await failure(remove(o.orgId, 'fixture.projects', 'W/"3"'))).toEqual(
      ['not_found', undefined],
    );
    expect(await failure(remove(o.orgId, 'fixture.projects', '*'))).toEqual([
      'precondition_required',
      undefined,
    ]);
    expect((await readOrgEntitlement(o.orgId))?.version).toBe(3);
    // Override tạo khi tính năng còn active, rồi tính năng bị deprecate (vòng đời spec §8.4): trigger chặn override MỚI,
    // nên seed phải chạy lúc DB chưa deprecate.
    await withOwner((c) =>
      c.query(
        `UPDATE entitlement_features SET deprecated_at = NULL WHERE key = 'fixture.legacy_pdf'`,
      ),
    );
    try {
      await seedOverride(o.orgId, 'fixture.legacy_pdf', {
        value: { enabled: true },
      });
    } finally {
      await withOwner((c) =>
        c.query(
          `UPDATE entitlement_features SET deprecated_at = now() WHERE key = 'fixture.legacy_pdf'`,
        ),
      );
    }
    expect(await remove(o.orgId, 'fixture.legacy_pdf', 'W/"3"')).toBe(4);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
  it('outside a UnitOfWork, or without a staff principal → EntitlementsContextError (an assembly error, never a write)', async () => {
    const o = await orgOn('pro');
    const noTx = await app
      .get(OrgScope)
      .run(o.orgId, () =>
        app.get(Overrides).set('tenancy.seats', cmd({ limit: 2 }), v1),
      )
      .catch((e: unknown) => e);
    expect(noTx).toBeInstanceOf(EntitlementsContextError);
    const noStaff = await asStaff(
      o.orgId,
      () => app.get(Overrides).set('tenancy.seats', cmd({ limit: 2 }), v1),
      false,
    ).catch((e: unknown) => e);
    expect(noStaff).toBeInstanceOf(EntitlementsContextError);
    expect(await readOverrides(o.orgId)).toEqual([]);
  });
});
