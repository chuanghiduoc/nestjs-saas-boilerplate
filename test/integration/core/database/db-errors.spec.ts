import { HttpStatus, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  Db,
  OrgScope,
  UnitOfWork,
  defineConstraintErrors,
} from '../../../../src/core/database/index.js';
import {
  defineErrorCodes,
  toAppError,
} from '../../../../src/core/errors/index.js';
import {
  FixtureModule,
  FixtureRepo,
} from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const FixtureErrors = defineErrorCodes({
  FIXTURE_EMAIL_TAKEN: {
    status: HttpStatus.CONFLICT,
    title: 'Email already used',
  },
});
defineConstraintErrors({
  fixture_children_email_uq: FixtureErrors.FIXTURE_EMAIL_TAKEN,
});

async function mapped(p: Promise<unknown>) {
  try {
    await p;
    throw new Error('expected failure');
  } catch (e) {
    const a = toAppError(e);
    return {
      code: a.error.code,
      status: a.error.status,
      exposed: JSON.stringify({ d: a.opts.detail, f: a.opts.fields }),
    };
  }
}

describe('database error mapping', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let repo: FixtureRepo;
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      FixtureModule,
    ]);
    uow = app.get(UnitOfWork);
    repo = app.get(FixtureRepo);
  });
  afterAll(async () => {
    await app.close();
  });

  it('unique violation on a registered constraint → specific code, constraint name not exposed', async () => {
    const parent = await uow.run(() => repo.insertParent());
    const email = `${randomUUID()}@x.io`;
    await uow.run(() => repo.insertChild(parent, email, 1));
    const r = await mapped(uow.run(() => repo.insertChild(parent, email, 1)));
    expect(r).toMatchObject({ code: 'fixture_email_taken', status: 409 });
    expect(r.exposed).not.toContain('fixture_children_email_uq');
  });

  it('foreign key violations → 409 conflict', async () => {
    expect(
      await mapped(
        uow.run(() => repo.insertChild('999999999', `${randomUUID()}@x.io`, 1)),
      ),
    ).toMatchObject({ code: 'conflict' });
    const parent = await uow.run(() => repo.insertParent());
    await uow.run(() => repo.insertChild(parent, `${randomUUID()}@x.io`, 1));
    expect(
      await mapped(uow.run(() => repo.deleteParent(parent))),
    ).toMatchObject({ code: 'conflict' });
  });

  it('check violation → 422 validation_failed', async () => {
    const parent = await uow.run(() => repo.insertParent());
    expect(
      await mapped(
        uow.run(() => repo.insertChild(parent, `${randomUUID()}@x.io`, 0)),
      ),
    ).toMatchObject({ code: 'validation_failed', status: 422 });
  });

  it('row level security violation → 404 not_found', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    expect(
      await mapped(
        app
          .get(OrgScope)
          .run(orgA, () => uow.run(() => repo.insertOrgNote(orgB, 'x'))),
      ),
    ).toMatchObject({ code: 'not_found' });
  });

  it('missing GRANT (also SQLSTATE 42501) → 500 internal_error, not 404', async () => {
    expect(await mapped(uow.run(() => repo.readNoGrant()))).toMatchObject({
      code: 'internal_error',
      status: 500,
    });
  });

  it('missing org context → 500 internal_error (a bug, not a client error)', async () => {
    expect(await mapped(uow.run(() => repo.listOrgBodies()))).toMatchObject({
      code: 'internal_error',
    });
  });

  it('statement timeout → 503 service_unavailable', async () => {
    const r = await mapped(
      uow.run(async () => {
        await app
          .get(Db)
          .execute(`SELECT set_config('statement_timeout', '50ms', true)`);
        await repo.sleepSeconds(1);
      }),
    );
    expect(r).toMatchObject({ code: 'service_unavailable', status: 503 });
  });

  it('serialization failures are retried transparently', async () => {
    const parent = await uow.run(() => repo.insertParent());
    // Rào chắn không dùng timer: lần đọc thứ hai resolve; các lần retry sau đó đi qua ngay.
    let started = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const increment = () =>
      uow.run(
        async () => {
          const v = await repo.readCounter(parent);
          if (++started === 2) release();
          await bothRead;
          await repo.writeCounter(parent, v + 1);
        },
        { isolation: 'serializable' },
      );
    await Promise.all([increment(), increment()]);
    expect(await uow.run(() => repo.readCounter(parent))).toBe(2);
  });
});
