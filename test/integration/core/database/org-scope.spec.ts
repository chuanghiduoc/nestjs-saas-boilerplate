import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import {
  DatabaseModule,
  OrgScope,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import { RequestContext } from '../../../../src/core/context/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import {
  FixtureModule,
  FixtureRepo,
} from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const ORG_CONTEXT_MISSING = /org context is not set/;

describe('OrgScope + RLS', () => {
  let app: INestApplication;
  let scope: OrgScope;
  let uow: UnitOfWork;
  let repo: FixtureRepo;
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      FixtureModule,
    ]);
    scope = app.get(OrgScope);
    uow = app.get(UnitOfWork);
    repo = app.get(FixtureRepo);
    await scope.run(orgA, () => uow.run(() => repo.insertOrgNote(orgA, 'a1')));
    await scope.run(orgB, () => uow.run(() => repo.insertOrgNote(orgB, 'b1')));
  });
  afterAll(async () => {
    await app.close();
  });

  it('only sees rows of the current org', async () => {
    const bodies = await scope.run(orgA, () =>
      uow.run(() => repo.listOrgBodies()),
    );
    expect(bodies).toContain('a1');
    expect(bodies).not.toContain('b1');
  });

  it('fails closed without org context', async () => {
    await expect(uow.run(() => repo.listOrgBodies())).rejects.toThrow(
      ORG_CONTEXT_MISSING,
    );
    await expect(repo.listOrgBodies()).rejects.toThrow(ORG_CONTEXT_MISSING);
  });

  it('reused pooled connection still fails closed after a scoped query', async () => {
    for (let i = 0; i < 5; i++) {
      await scope.run(orgA, () => uow.run(() => repo.listOrgBodies()));
      await expect(uow.run(() => repo.listOrgBodies())).rejects.toThrow(
        ORG_CONTEXT_MISSING,
      );
    }
  });

  it('cannot write a row for another org', async () => {
    await expect(
      scope.run(orgA, () => uow.run(() => repo.insertOrgNote(orgB, 'evil'))),
    ).rejects.toThrow(/row-level security/);
  });

  it('rejects empty/invalid orgId before touching the database', async () => {
    await expect(scope.run('', async () => 1)).rejects.toBeInstanceOf(AppError);
    await expect(scope.run('not-a-uuid', async () => 1)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('nested scope with the same org joins the transaction; with a different org is rejected', async () => {
    const body = `nested-${Date.now()}`;
    await expect(
      scope.run(orgA, () =>
        uow.run(async () => {
          await scope.run(orgA, () => repo.insertOrgNote(orgA, body));
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    expect(
      await scope.run(orgA, () => uow.run(() => repo.listOrgBodies())),
    ).not.toContain(body);
    await expect(
      scope.run(orgA, () => uow.run(() => scope.run(orgB, async () => 1))),
    ).rejects.toThrow(/different organization/);
  });

  it('rejects entering a scope inside a transaction opened without org session, even if the context claims that org', async () => {
    // Nguồn sự thật là session của transaction (cái Postgres thấy), không phải RequestContext.orgId.
    await expect(
      app
        .get(RequestContext)
        .run({ orgId: orgA }, () =>
          uow.run(() => scope.run(orgA, () => repo.listOrgBodies())),
        ),
    ).rejects.toThrow(/different organization/);
  });

  it('sets RequestContext.orgId inside the scope only', async () => {
    const ctx = app.get(RequestContext);
    const seen = await ctx.run({}, async () => {
      const inside = await scope.run(orgA, async () => ctx.orgId());
      return { inside, after: ctx.orgId() };
    });
    expect(seen).toEqual({ inside: orgA, after: undefined });
  });
});
