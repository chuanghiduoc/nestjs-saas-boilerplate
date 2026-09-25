import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseModule,
  Db,
  UnitOfWork,
  countUpTo,
  escapeLike,
} from '../../../../src/core/database/index.js';
import {
  FixtureModule,
  FixtureRepo,
} from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const PREFIX = `count_${Date.now()}_%`;
const ROWS = 7;
const INNER = 'SELECT 1 FROM fixture_notes WHERE body LIKE ?';

describe('countUpTo', () => {
  let app: INestApplication;
  let db: Db;
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      FixtureModule,
    ]);
    db = app.get(Db);
    const repo = app.get(FixtureRepo);
    await app.get(UnitOfWork).run(async () => {
      for (let i = 0; i < ROWS; i++)
        await repo.insertSystemNote(`${PREFIX}${i}`);
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const pattern = `${escapeLike(PREFIX)}%`;

  it('returns the exact count when at or below the cap', async () => {
    expect(await countUpTo(db, INNER, [pattern], ROWS)).toBe(ROWS);
    expect(await countUpTo(db, INNER, [pattern], 100)).toBe(ROWS);
  });

  it('stops at cap+1 so callers can tell the count is not exact', async () => {
    expect(await countUpTo(db, INNER, [pattern], 3)).toBe(4);
  });

  it('treats LIKE wildcards in user input literally', async () => {
    expect(
      await countUpTo(db, INNER, [`${escapeLike('count_')}%`], 1_000_000),
    ).toBeGreaterThanOrEqual(ROWS);
    expect(await countUpTo(db, INNER, [`${escapeLike('count\\_')}%`], 10)).toBe(
      0,
    );
  });

  it('rejects a non-positive or fractional cap', async () => {
    await expect(countUpTo(db, INNER, [pattern], 0)).rejects.toThrow(/cap/);
    await expect(countUpTo(db, INNER, [pattern], 1.5)).rejects.toThrow(/cap/);
  });
});
