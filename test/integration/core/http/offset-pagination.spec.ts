import {
  Controller,
  Get,
  Module,
  Query,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  DatabaseModule,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  HttpModule,
  Paginator,
  applyHttpDefaults,
  offsetPageQuery,
} from '../../../../src/core/http/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  FixtureModule,
  FixtureRepo,
  NOTE_SORTABLE,
} from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

// Trần nhỏ để thấy cả nhánh đếm không chính xác; phải set trước khi dựng schema query.
const CAP = 5;
vi.stubEnv('PAGINATION_TOTAL_COUNT_CAP', String(CAP));
vi.stubEnv('PAGINATION_MAX_OFFSET_ROWS', String(CAP));

const Q = offsetPageQuery({ sortable: NOTE_SORTABLE });
const PREFIX = `offset_${Date.now()}_`;
const ROWS = 7;

@Controller('notes-offset')
class NotesController {
  constructor(
    private readonly repo: FixtureRepo,
    private readonly pages: Paginator,
  ) {}
  @Get() async list(@Query({ schema: Q }) q: z.infer<typeof Q>) {
    const { items, counted } = await this.repo.listOffsetPage(
      PREFIX,
      q,
      this.pages.totalCountCap,
    );
    return this.pages.offset(items, q, counted);
  }
}
@Module({ imports: [FixtureModule], controllers: [NotesController] })
class M {}

describe('offset pagination (Postgres)', () => {
  let app: INestApplication;
  const get = (qs: string) =>
    request(app.getHttpServer()).get(`/notes-offset?${qs}`);
  beforeAll(async () => {
    app = await createTestApp(
      [DatabaseModule.forRoot({ relay: false }), RedisModule, HttpModule, M],
      { beforeInit: applyHttpDefaults },
    );
    const repo = app.get(FixtureRepo);
    await app.get(UnitOfWork).run(async () => {
      for (let i = 0; i < ROWS; i++)
        await repo.insertSystemNote(`${PREFIX}${i}`);
    });
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('first page: count capped, inexact, more pages', async () => {
    const res = await get('page=1&pageSize=2').expect(200);
    expect(res.body).toEqual({
      url: '/notes-offset',
      data: [{ body: `${PREFIX}0` }, { body: `${PREFIX}1` }],
      page: 1,
      pageSize: 2,
      totalCount: CAP,
      totalCountExact: false,
      hasMore: true,
    });
  });

  it('last reachable page reports hasMore=false; deeper pages are 422', async () => {
    const res = await get('page=2&pageSize=2&sort=-body').expect(200);
    expect(res.body.data).toEqual([
      { body: `${PREFIX}4` },
      { body: `${PREFIX}3` },
    ]);
    expect(res.body.hasMore).toBe(false);
    expect((await get('page=3&pageSize=2').expect(422)).body.code).toBe(
      'validation_failed',
    );
  });

  it('sort outside the allowlist → 422', async () => {
    await get('sort=id').expect(422);
    await get(`sort=${encodeURIComponent('body; DROP TABLE x')}`).expect(422);
  });
});
