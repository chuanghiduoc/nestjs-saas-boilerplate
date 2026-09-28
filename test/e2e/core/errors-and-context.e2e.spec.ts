import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { RequestContext } from '../../../src/core/context/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

@Controller('probe')
class ProbeController {
  constructor(private readonly ctx: RequestContext) {}
  @Get('id') id() {
    return {
      requestId: this.ctx.requestId(),
      clientRequestId: this.ctx.clientRequestId() ?? null,
    };
  }
  @Get('app-error') appError() {
    throw new AppError(CoreErrors.INVALID_CURSOR, { detail: 'nope' });
  }
  @Get('boom') boom() {
    throw new Error('secret internals');
  }
  @Post('echo') echo(@Body() body: unknown) {
    return body;
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('errors + context (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp([RedisModule, HttpModule, ProbeModule], {
      beforeInit: applyHttpDefaults,
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('server generates the request id; client value is kept separately', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/id')
      .set('x-request-id', 'abc-123');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.requestId).not.toBe('abc-123');
    expect(res.body.clientRequestId).toBe('abc-123');
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });
  it('ignores unsafe client request ids', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/id')
      .set('x-request-id', 'a'.repeat(200));
    expect(res.body.clientRequestId).toBeNull();
  });
  it('returns problem+json for AppError with requestId and timestamp', async () => {
    const res = await request(app.getHttpServer()).get(
      '/probe/app-error?secret=1',
    );
    expect(res.status).toBe(400);
    // Chính xác, không chỉ `toContain`: `writeProblem` (core/http) phải trả đúng header này (S2 Task 9 fix round 1).
    expect(res.headers['content-type']).toBe(
      'application/problem+json; charset=utf-8',
    );
    expect(res.body).toMatchObject({
      type: '/errors/invalid-cursor',
      code: 'invalid_cursor',
      detail: 'nope',
      instance: '/probe/app-error',
    });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(Date.parse(res.body.timestamp)).not.toBeNaN();
  });
  it('unknown route → 404 not_found; malformed JSON → 400 malformed_request', async () => {
    expect((await request(app.getHttpServer()).get('/nope')).body.code).toBe(
      'not_found',
    );
    const bad = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('malformed_request');
    // SP2 Task 17 fix: `jsonBodyParser` chạy trước Nest router; requestId phải là id thật của CLS, không phải
    // "none" (RequestContext.requestId() không có context) và phải khớp header X-Request-Id đã gửi.
    expect(bad.body.requestId).toBe(bad.headers['x-request-id']);
    expect(bad.body.requestId).not.toBe('none');
  });
  it('body over the limit → 413 payload_too_large with a real requestId (SP2 Task 17 fix)', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/echo')
      .send({ pad: 'x'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.requestId).not.toBe('none');
  });
  it('unsupported Content-Type → 415 unsupported_media_type with a real requestId (SP2 Task 17 fix)', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('content-type', 'text/plain')
      .send('hello');
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('unsupported_media_type');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.requestId).not.toBe('none');
  });
  it('hides internal error details', async () => {
    const res = await request(app.getHttpServer()).get('/probe/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
  });
});
