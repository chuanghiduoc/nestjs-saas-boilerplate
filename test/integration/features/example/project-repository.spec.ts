import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgScope, UnitOfWork } from '../../../../src/core/database/index.js';
import { ProjectRepository } from '../../../../src/features/example/infra/sql-project.repository.js';
import { holdInOrg } from '../../../support/entitlements-races.js';
import {
  inOrgTx,
  seedOrg,
  withAppClient,
  type SeededOrg,
} from '../../../support/tenancy-seed.js';
import {
  disposeExampleOrg,
  seedExamplePlans,
  startExampleApp,
} from './example-support.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ProjectRepository SQL (spec §7.4, §8.1)', () => {
  let app: INestApplication;
  let org: SeededOrg;
  let disposePlans: () => Promise<void>;
  let repo: ProjectRepository;
  const inOrg = <T>(fn: () => Promise<T>): Promise<T> =>
    app.get(OrgScope).run(org.orgId, () => app.get(UnitOfWork).run(fn));
  /** Đặt trạng thái/mốc thời gian trực tiếp (app_user trong OrgScope): test không chờ retention thật. */
  const ageArchived = (publicId: string, days: number) =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, () =>
        c.query(
          `UPDATE example_projects SET status = 'ARCHIVED', status_changed_at = now() - make_interval(days => $2)
           WHERE public_id = $1`,
          [publicId, days],
        ),
      ),
    );
  const clear = () =>
    withAppClient((c) =>
      inOrgTx(c, org.orgId, () => c.query('DELETE FROM example_projects')),
    );

  beforeAll(async () => {
    disposePlans = await seedExamplePlans();
    app = await startExampleApp();
    org = await seedOrg();
    repo = app.get(ProjectRepository);
  });
  afterAll(async () => {
    if (org) await disposeExampleOrg(org);
    await app?.close();
    await disposePlans?.();
  });

  it('insert defaults: ACTIVE, version 1, uuidv7 public id, org from app_current_org()', async () => {
    await clear();
    const row = await inOrg(() =>
      repo.insert({ name: 'Website', description: null }),
    );
    expect(row).toMatchObject({
      orgId: org.orgId,
      name: 'Website',
      description: null,
      status: 'ACTIVE',
      version: 1,
    });
    expect(row.publicId).toMatch(UUID_V7);
    expect(row.statusChangedAt).toBeInstanceOf(Date);
    expect(await inOrg(() => repo.find(row.publicId, 'NONE'))).toEqual(row);
  });
  it('list: public_id DESC, limit + 1 rows, after excludes the cursor row, status filter', async () => {
    await clear();
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c', 'd'])
      ids.push(
        (await inOrg(() => repo.insert({ name, description: null }))).publicId,
      );
    const desc = [...ids].reverse();
    const first = await inOrg(() => repo.list({ limit: 2 }));
    expect(first.map((r) => r.publicId)).toEqual(desc.slice(0, 3));
    const next = await inOrg(() => repo.list({ limit: 2, after: desc[1] }));
    expect(next.map((r) => r.publicId)).toEqual(desc.slice(2));
    await ageArchived(ids[1]!, 1);
    const archived = await inOrg(() =>
      repo.list({ limit: 10, status: 'ARCHIVED' }),
    );
    expect(archived.map((r) => r.publicId)).toEqual([ids[1]]);
    const active = await inOrg(() =>
      repo.list({ limit: 10, status: 'ACTIVE', after: desc[0] }),
    );
    expect(active.map((r) => r.publicId)).toEqual([ids[2], ids[0]]);
  });
  it('setStatus bumps version and status_changed_at; updateFields bumps version only', async () => {
    await clear();
    const row = await inOrg(() => repo.insert({ name: 'x', description: 'd' }));
    const archived = await inOrg(() => repo.setStatus(row.id, 'ARCHIVED'));
    expect(archived).toMatchObject({ status: 'ARCHIVED', version: 2 });
    expect(archived.statusChangedAt.getTime()).toBeGreaterThan(
      row.statusChangedAt.getTime(),
    );
    const renamed = await inOrg(() =>
      repo.updateFields(row.id, { name: 'y', description: null }),
    );
    expect(renamed).toMatchObject({
      name: 'y',
      description: null,
      status: 'ARCHIVED',
      version: 3,
    });
    expect(renamed.statusChangedAt).toEqual(archived.statusChangedAt);
    expect(renamed.updatedAt.getTime()).toBeGreaterThan(
      archived.updatedAt.getTime(),
    );
    expect(await inOrg(() => repo.deleteOne(row.publicId))).toEqual({
      publicId: row.publicId,
      version: 3,
    });
    expect(await inOrg(() => repo.deleteOne(row.publicId))).toBeUndefined();
  });
  it('deleteDue takes only ARCHIVED rows older than the retention, oldest first, at most limit, and skips a row locked by another transaction', async () => {
    await clear();
    const mk = async (name: string) =>
      (await inOrg(() => repo.insert({ name, description: null }))).publicId;
    const [oldest, older, old, locked, fresh, active] = [
      await mk('oldest'),
      await mk('older'),
      await mk('old'),
      await mk('locked'),
      await mk('fresh'),
      await mk('active'),
    ];
    await ageArchived(oldest!, 40);
    await ageArchived(older!, 35);
    await ageArchived(old!, 31);
    await ageArchived(locked!, 50);
    await ageArchived(fresh!, 0);
    const holder = await holdInOrg(
      org.orgId,
      'SELECT 1 FROM example_projects WHERE public_id = $1 FOR NO KEY UPDATE',
      [locked],
      1,
    );
    try {
      const firstTwo = await inOrg(() =>
        repo.deleteDue(org.orgId, 30 * 86_400, 2),
      );
      expect(firstTwo.map((d) => d.publicId)).toEqual([oldest, older]);
      const rest = await inOrg(() =>
        repo.deleteDue(org.orgId, 30 * 86_400, 10),
      );
      expect(rest).toEqual([{ publicId: old, version: 1 }]);
    } finally {
      await holder.release();
    }
    const left = await inOrg(() => repo.list({ limit: 10 }));
    expect(left.map((r) => r.publicId).sort()).toEqual(
      [locked!, fresh!, active!].sort(),
    );
  });
});
