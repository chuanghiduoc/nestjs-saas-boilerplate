import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Module,
  Query,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import {
  DatabaseModule,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  HttpModule,
  Paginator,
  applyHttpDefaults,
  cursorPageQuery,
} from '../../../../src/core/http/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import {
  FixtureModule,
  FixtureRepo,
} from '../../../fixtures/fixture.module.js';
import { createTestApp } from '../../../support/app-factory.js';

const Q = cursorPageQuery();
const STAMP = Date.now();
const PREFIX = `cursor_${STAMP}%`;
const TOTAL = 25;
const cursorOf = (values: unknown) =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

@Controller('notes')
class NotesController {
  constructor(
    private readonly repo: FixtureRepo,
    private readonly pages: Paginator,
  ) {}
  @Get() async list(
    @Query({ schema: Q }) q: { limit: number; cursor?: string },
  ) {
    const page = await this.repo.listPage(PREFIX, q);
    return this.pages.cursor(page.items, page);
  }
}
@Module({ imports: [FixtureModule], controllers: [NotesController] })
class M {}

describe('cursor pagination (MikroORM)', () => {
  let app: INestApplication;
  const get = (qs: string) => request(app.getHttpServer()).get(`/notes?${qs}`);
  beforeAll(async () => {
    app = await createTestApp(
      [DatabaseModule.forRoot({ relay: false }), RedisModule, HttpModule, M],
      { beforeInit: applyHttpDefaults },
    );
    const repo = app.get(FixtureRepo);
    await app.get(UnitOfWork).run(async () => {
      for (let i = 0; i < TOTAL; i++)
        await repo.insertSystemNote(`${PREFIX}-${String(i).padStart(2, '0')}`);
    });
    // Không có dấu % ở đúng vị trí: chỉ khớp nếu "%" trong prefix bị hiểu là wildcard.
    await app
      .get(UnitOfWork)
      .run(() => repo.insertSystemNote(`cursor_${STAMP}X-decoy`));
    await app
      .get(UnitOfWork)
      .run(() => repo.insertSystemNote('cursor_decoy-not-matching'));
  });
  afterAll(async () => {
    await app.close();
  });

  it('walks every row once, in order; LIKE wildcards in the prefix are treated literally', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await get(
        `limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ).expect(200);
      expect(res.body.url).toBe('/notes');
      seen.push(...res.body.data.map((d: { body: string }) => d.body));
      cursor = res.body.nextCursor;
      expect(res.body.hasMore).toBe(cursor !== null);
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(seen).toEqual([...seen].sort());
  });

  it('an exact final page reports hasMore=false (limit+1 overfetch)', async () => {
    const res = await get(`limit=${TOTAL}`).expect(200);
    expect(res.body.data).toHaveLength(TOTAL);
    expect(res.body).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('malformed and forged cursors → 400 invalid_cursor, never 500', async () => {
    for (const c of [
      'not-a-real-cursor',
      cursorOf(['cursor_x', 'not-a-number']),
      cursorOf(['only-one-value']),
      cursorOf({ body: 'x', id: '1' }),
      cursorOf(['a', 'b', 'c']),
      cursorOf([true, 1]),
      cursorOf([{ $ne: null }, '1']),
      cursorOf([['a'], '1']),
    ]) {
      const res = await get(`limit=10&cursor=${encodeURIComponent(c)}`);
      expect({ c, status: res.status, code: res.body.code }).toEqual({
        c,
        status: 400,
        code: 'invalid_cursor',
      });
    }
  });
});
