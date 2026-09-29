import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestContext } from '../../../src/core/context/index.js';
import { Db, UnitOfWork } from '../../../src/core/database/index.js';
import type { EventActor } from '../../../src/core/events/index.js';
import {
  OrgCreationParticipant,
  OrgCreationParticipantContributor,
} from '../../../src/modules/tenancy/index.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import {
  deleteTenancyUsersOf,
  inOrgTx,
  purgeOrgs,
  withAppClient,
} from '../../support/tenancy-seed.js';

type Call = {
  orgId: string;
  actor: EventActor;
  inTx: boolean;
  ctxOrg: string | undefined;
  members: number;
};
const calls: Call[] = [];
let throwNext = false;

/** Participant fixture (vai của entitlements): ghi một dòng có FK tới org, cùng transaction. */
@Injectable()
@OrgCreationParticipantContributor({ key: 'fixture.items', order: 0 })
class FixtureItemsParticipant extends OrgCreationParticipant {
  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
  ) {
    super();
  }
  async onOrgCreated(orgId: string, actor: EventActor): Promise<void> {
    const [m] = await this.db.execute<{ n: number }>(
      'SELECT count(*)::int AS n FROM org_members WHERE org_id = app_current_org()',
    );
    calls.push({
      orgId,
      actor,
      inTx: this.uow.inTransaction(),
      ctxOrg: this.ctx.orgId(),
      members: m?.n ?? -1,
    });
    await this.db.execute(
      `INSERT INTO fixture_org_items (org_id, body) VALUES (app_current_org(), 'participant')`,
    );
    if (throwNext) throw new Error('fixture participant failure');
  }
}
@Module({ providers: [FixtureItemsParticipant] })
class FixtureParticipantModule {}

describe('org creation participants (spec SP4 §22.2 T1, S4-T3 kept as a test)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  const created: string[] = [];
  const itemsOf = (orgId: string) =>
    withAppClient((c) =>
      inOrgTx(
        c,
        orgId,
        async () =>
          (
            await c.query<{ body: string }>(
              'SELECT body FROM fixture_org_items',
            )
          ).rows,
      ),
    );
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [FixtureParticipantModule] });
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    for (const id of created)
      await withAppClient((c) =>
        inOrgTx(c, id, () =>
          c.query(
            'DELETE FROM fixture_org_items WHERE org_id = app_current_org()',
          ),
        ),
      );
    await purgeOrgs(created);
    await deleteTenancyUsersOf([p.authUserId]);
    await app?.close();
    await deleteSeededPrincipals([p]);
  });

  it('runs once, inside the transaction and OrgScope of the new org, before the creator is admitted, with the creator as actor', async () => {
    const r = await authed(app, p)
      .post('/v1/orgs')
      .set('idempotency-key', `k-${randomUUID()}`)
      .send({ name: 'Participant' });
    expect(r.status).toBe(201);
    created.push(r.body.id);
    expect(calls).toEqual([
      {
        orgId: r.body.id,
        actor: { type: 'user', id: p.authUserId },
        inTx: true,
        ctxOrg: r.body.id,
        members: 0,
      },
    ]);
    expect(await itemsOf(r.body.id)).toEqual([{ body: 'participant' }]);
  });
  it('a throwing participant rolls the whole creation back: 500, no organization, no participant row', async () => {
    throwNext = true;
    try {
      const r = await authed(app, p)
        .post('/v1/orgs')
        .set('idempotency-key', `k-${randomUUID()}`)
        .send({ name: 'Participant fails' });
      expect(r.status).toBe(500);
    } finally {
      throwNext = false;
    }
    const id = calls.at(-1)?.orgId;
    if (!id) throw new Error('participant did not run');
    const n = await withAppClient((c) =>
      inOrgTx(
        c,
        id,
        async () =>
          (
            await c.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM organizations',
            )
          ).rows[0]?.n,
      ),
    );
    expect(n).toBe(0);
    expect(await itemsOf(id)).toEqual([]);
  });
});
