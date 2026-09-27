import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Res,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  HttpModule,
  Paginator,
  applyHttpDefaults,
  mergePatchInto,
  assertIfMatch,
  etagOf,
  mergePatchSchema,
  offsetPageQuery,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../src/core/http/index.js';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const User = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string().min(1),
  role: z.enum(['USER', 'ADMIN']),
  nickname: z.string().nullable(),
  bio: z.string().nullish(),
  title: z.string().optional(),
  addr: z.object({ city: z.string(), zip: z.string() }),
});
const CreateUser = User.pick({ email: true, name: true });
const EditableUser = User.pick({
  name: true,
  nickname: true,
  bio: true,
  title: true,
  addr: true,
});
const PatchUser = mergePatchSchema(EditableUser);
type Stored = z.output<typeof User> & {
  passwordHash: string;
  version: number;
};
const store = new Map<string, Stored>();
const ListQ = offsetPageQuery({ sortable: ['name'] as const });

@Controller('api/v1/users')
class UsersController {
  constructor(private readonly pages: Paginator) {}
  @Get()
  list(@Query({ schema: ListQ }) q: z.infer<typeof ListQ>) {
    const all = [...store.values()];
    return this.pages.offset(
      all
        .slice((q.page - 1) * q.pageSize, q.page * q.pageSize)
        .map((u) => serialize(User, u)),
      q,
      all.length,
    );
  }
  @Post()
  create(
    @Body({ schema: CreateUser }) b: z.infer<typeof CreateUser>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const id = String(store.size + 1);
    store.set(id, {
      id,
      ...b,
      role: 'USER',
      nickname: null,
      addr: { city: 'Hanoi', zip: '100000' },
      passwordHash: 'secret-hash',
      version: 1,
    });
    setLocation(res, `/api/v1/users/${id}`);
    return serialize(User, store.get(id));
  }
  @Get(':id')
  get(@Param('id') id: string, @Res({ passthrough: true }) res: HeaderWriter) {
    const u = store.get(id);
    if (!u) throw new AppError(CoreErrors.NOT_FOUND);
    res.setHeader('ETag', etagOf(u.version));
    return serialize(User, u);
  }
  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchUser }) b: z.infer<typeof PatchUser>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const u = store.get(id);
    if (!u) throw new AppError(CoreErrors.NOT_FOUND);
    assertIfMatch(ifMatch, u.version, { required: true });
    // Dựng lại bản ghi từ kết quả: member bị patch xoá (bio) phải biến mất, không spread đè bản cũ.
    const next: Stored = {
      id: u.id,
      email: u.email,
      role: u.role,
      passwordHash: u.passwordHash,
      version: u.version + 1,
      ...mergePatchInto(EditableUser, u, b),
    };
    store.set(id, next);
    res.setHeader('ETag', etagOf(next.version));
    return serialize(User, next);
  }
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    store.delete(id);
  }
}
@Module({ controllers: [UsersController] })
class M {}

describe('HTTP conventions (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  beforeAll(async () => {
    app = await createTestApp([RedisModule, HttpModule, M], {
      beforeInit: applyHttpDefaults,
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('POST → 201, Location, body without internal fields', async () => {
    const res = await http()
      .post('/api/v1/users')
      .send({ email: 'me@example.com', name: 'Me' })
      .expect(201);
    expect(res.headers.location).toBe('/api/v1/users/1');
    expect(res.body).toEqual({
      id: '1',
      email: 'me@example.com',
      name: 'Me',
      role: 'USER',
      nickname: null,
      addr: { city: 'Hanoi', zip: '100000' },
    });
  });
  it('invalid body → 422 validation_failed with dot paths and codes', async () => {
    const res = await http()
      .post('/api/v1/users')
      .send({ email: 'nope', name: '' })
      .expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email', code: 'invalid_email' }),
        expect.objectContaining({ path: 'name', code: 'too_small' }),
      ]),
    );
  });
  it('unparseable JSON → 400 malformed_request (json and merge-patch)', async () => {
    for (const [method, url, type] of [
      ['post', '/api/v1/users', 'application/json'],
      ['patch', '/api/v1/users/1', 'application/merge-patch+json'],
    ] as const) {
      const res = await http()
        [method](url)
        .set('content-type', type)
        .send('{bad')
        .expect(400);
      expect(res.body.code).toBe('malformed_request');
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
  });
  it('unsupported Content-Type → 415; body over limit → 413', async () => {
    expect(
      (
        await http()
          .post('/api/v1/users')
          .set('content-type', 'text/plain')
          .send('email=x')
          .expect(415)
      ).body.code,
    ).toBe('unsupported_media_type');
    expect(
      (
        await http()
          .post('/api/v1/users')
          .send({ email: 'a@b.co', name: 'x'.repeat(2 * 1024 * 1024) })
          .expect(413)
      ).body.code,
    ).toBe('payload_too_large');
  });
  it('form-encoded bodies are refused too (only JSON types are accepted)', async () => {
    expect(
      (
        await http()
          .post('/api/v1/users')
          .type('form')
          .send({ email: 'a@b.co', name: 'x' })
          .expect(415)
      ).body.code,
    ).toBe('unsupported_media_type');
  });
  it('GET list → flat offset page; oversize/too deep → 422', async () => {
    expect(
      (await http().get('/api/v1/users?page=1&pageSize=20').expect(200)).body,
    ).toMatchObject({
      url: '/api/v1/users',
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalCountExact: true,
      hasMore: false,
    });
    expect(
      (await http().get('/api/v1/users?pageSize=100000').expect(422)).body.code,
    ).toBe('validation_failed');
    expect(
      (await http().get('/api/v1/users?page=100000&pageSize=100').expect(422))
        .body.code,
    ).toBe('validation_failed');
  });
  it('sort outside the allowlist → 422 with the sort path', async () => {
    const res = await http()
      .get(`/api/v1/users?sort=${encodeURIComponent('name;DROP TABLE x')}`)
      .expect(422);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ path: 'sort' }),
    ]);
  });
  it('GET resource → ETag; If-None-Match → 304', async () => {
    const res = await http().get('/api/v1/users/1').expect(200);
    expect(res.headers.etag).toBe('W/"1"');
    await http()
      .get('/api/v1/users/1')
      .set('If-None-Match', res.headers.etag ?? '')
      .expect(304);
  });
  it('merge-patch with an unknown field → 422', async () => {
    const res = await http()
      .patch('/api/v1/users/1')
      .set('content-type', 'application/merge-patch+json')
      .set('If-Match', 'W/"1"')
      .send({ role: 'ADMIN' })
      .expect(422);
    expect(res.body.code).toBe('validation_failed');
  });
  it('PATCH merge-patch: 428 without If-Match, 412 stale, 200 current', async () => {
    const patch = () =>
      http()
        .patch('/api/v1/users/1')
        .set('content-type', 'application/merge-patch+json');
    expect((await patch().send({ name: 'New' }).expect(428)).body.code).toBe(
      'precondition_required',
    );
    expect(
      (await patch().set('If-Match', 'W/"0"').send({ name: 'New' }).expect(412))
        .body.code,
    ).toBe('precondition_failed');
    const ok = await patch()
      .set('If-Match', 'W/"1"')
      .send({ name: 'New' })
      .expect(200);
    expect(ok.body.name).toBe('New');
    expect(ok.headers.etag).toBe('W/"2"');
  });
  it('PATCH merges nested objects (RFC 7396): omitted members kept, null clears/removes', async () => {
    const patch = (version: number) =>
      http()
        .patch('/api/v1/users/1')
        .set('content-type', 'application/merge-patch+json')
        .set('If-Match', etagOf(version));
    const set = await patch(2)
      .send({ addr: { city: 'Hue' }, nickname: 'me', bio: 'hi' })
      .expect(200);
    expect(set.body).toMatchObject({
      name: 'New',
      nickname: 'me',
      bio: 'hi',
      addr: { city: 'Hue', zip: '100000' },
    });
    const cleared = await patch(3)
      .send({ nickname: null, bio: null })
      .expect(200);
    expect(cleared.body.nickname).toBeNull();
    expect(cleared.body).not.toHaveProperty('bio');
    expect(cleared.body.addr).toEqual({ city: 'Hue', zip: '100000' });
    // Optional nhưng không nullable → null bị từ chối (R35); zip bắt buộc, không nullable.
    const bad = await patch(4)
      .send({ title: null, addr: { zip: null, extra: 1 } })
      .expect(422);
    expect(bad.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'title' }),
        expect.objectContaining({ path: 'addr.zip' }),
        expect.objectContaining({ path: 'addr', code: 'unrecognized_keys' }),
      ]),
    );
  });
  it('404 not_found; DELETE → 204 empty', async () => {
    expect((await http().get('/api/v1/users/999').expect(404)).body.code).toBe(
      'not_found',
    );
    expect((await http().delete('/api/v1/users/1').expect(204)).text).toBe('');
  });
  it('security headers are set; docs are not served unless enabled', async () => {
    const res = await http().get('/api/v1/users').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    await http().get('/docs').expect(404);
  });
});
