import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { OrgScope, UnitOfWork } from '../../../src/core/database/index.js';
import { OrgMutationLock } from '../../../src/modules/tenancy/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { tenancyCoreImports } from '../../support/tenancy-core-app.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../support/tenancy-seed.js';

/** Đủ ngắn để ca "bị chặn" kết thúc nhanh, đủ dài để không flake vì tải: lock_timeout của phiên đối chứng. */
const PROBE_LOCK_TIMEOUT = '300ms';

describe('OrgMutationLock (spec SP6 §5.3, SP3 §8.6 step 1)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  beforeAll(async () => {
    app = await createTestApp(tenancyCoreImports());
    org = await seedOrg();
  });
  afterAll(async () => {
    await org?.dispose();
    await app?.close();
  });
  const inScope = <T>(orgId: string, fn: () => Promise<T>) =>
    app.get(RequestContext).run({}, () => app.get(OrgScope).run(orgId, fn));
  const lockThen = <T>(orgId: string, fn: (locked: boolean) => Promise<T>) =>
    inScope(orgId, () =>
      app
        .get(UnitOfWork)
        .run(async () => fn(await app.get(OrgMutationLock).lock())),
    );

  it('locks the row of the current org inside the caller transaction', async () => {
    expect(await lockThen(org.orgId, async (locked) => locked)).toBe(true);
  });
  it('is false when the org row does not exist (purged)', async () => {
    expect(await lockThen(v7(), async (locked) => locked)).toBe(false);
  });
  it('refuses to run outside a transaction or outside OrgScope', async () => {
    await expect(
      inScope(org.orgId, () => app.get(OrgMutationLock).lock()),
    ).rejects.toThrow(/inside UnitOfWork\.run/);
    await expect(
      app
        .get(RequestContext)
        .run({}, () =>
          app.get(UnitOfWork).run(() => app.get(OrgMutationLock).lock()),
        ),
    ).rejects.toThrow(/inside OrgScope/);
  });
  it('holds a second locker of the same org until commit, and does not block an INSERT into a table with an FK to the org', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = lockThen(org.orgId, async () => {
      locked();
      await held;
    });
    await isLocked;
    try {
      await withAppClient(async (c) => {
        await expect(
          inOrgTx(c, org.orgId, async () => {
            await c.query(`SET LOCAL lock_timeout = '${PROBE_LOCK_TIMEOUT}'`);
            await c.query(
              'SELECT 1 FROM organizations WHERE id = app_current_org() FOR NO KEY UPDATE',
            );
          }),
        ).rejects.toMatchObject({ code: '55P03' });
        const inserted = await inOrgTx(c, org.orgId, async () => {
          await c.query(`SET LOCAL lock_timeout = '${PROBE_LOCK_TIMEOUT}'`);
          return c.query<{ id: string }>(
            `INSERT INTO fixture_org_items (org_id, body) VALUES ($1, 'lock-probe') RETURNING id::text AS id`,
            [org.orgId],
          );
        });
        await inOrgTx(c, org.orgId, () =>
          c.query('DELETE FROM fixture_org_items WHERE id = $1::bigint', [
            inserted.rows[0]?.id,
          ]),
        );
      });
    } finally {
      release();
      await holder;
    }
    expect(await lockThen(org.orgId, async (l) => l)).toBe(true);
  });
});
