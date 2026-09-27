import {
  Body,
  Controller,
  Global,
  Module,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HTTP_BODY_PARSER_SKIP_PREFIX,
  HttpModule,
  applyHttpDefaults,
} from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const LIMIT_BYTES = 2048;
const MAX_413_MS = 2000;
@Controller()
class EchoController {
  @Post('echo') echo(@Body() body: unknown, @Req() req: { rawBody?: Buffer }) {
    return { body: body ?? null, raw: req.rawBody?.toString('utf8') ?? null };
  }
  @Post('owned/echo') owned(@Body() body: unknown) {
    return { body: body ?? null };
  }
}
@Module({ controllers: [EchoController] })
class EchoModule {}
@Global()
@Module({
  providers: [{ provide: HTTP_BODY_PARSER_SKIP_PREFIX, useValue: '/owned' }],
  exports: [HTTP_BODY_PARSER_SKIP_PREFIX],
})
class OwnerModule {}

describe('body parser ownership and stream-level limit on Nest routes', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });
  const make = async (extra: unknown[] = []) => {
    vi.stubEnv('HTTP_BODY_LIMIT', `${LIMIT_BYTES}b`);
    app = await createTestApp(
      [
        RedisModule,
        HttpModule,
        EchoModule,
        ...extra.filter(
          (m): m is typeof OwnerModule => typeof m === 'function',
        ),
      ],
      { beforeInit: applyHttpDefaults, bodyParser: false },
    );
    return app;
  };

  it('core parses JSON (with rawBody) everywhere when no module owns a prefix', async () => {
    const a = await make();
    expect(
      (
        await request(a.getHttpServer())
          .post('/echo')
          .send({ a: 1 })
          .expect(201)
      ).body,
    ).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
  });
  it('core skips the prefix owned by another module', async () => {
    const a = await make([OwnerModule]);
    expect(
      (
        await request(a.getHttpServer())
          .post('/owned/echo')
          .send({ a: 1 })
          .expect(201)
      ).body,
    ).toEqual({ body: null });
    expect(
      (
        await request(a.getHttpServer())
          .post('/echo')
          .send({ a: 1 })
          .expect(201)
      ).body.body,
    ).toEqual({ a: 1 });
  });
  it('an unbounded chunked body on a Nest route → problem+json 413 within a bounded time, socket closed', async () => {
    const a = await make();
    await a.listen(0, '127.0.0.1');
    const port = (a.getHttpServer().address() as AddressInfo).port;
    const started = Date.now();
    const result = await new Promise<{
      status: number;
      type: string | undefined;
    }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/echo',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      });
      let status = 0;
      let type: string | undefined;
      req.on('response', (res) => {
        status = res.statusCode ?? 0;
        type = res.headers['content-type'];
        res.resume();
      });
      req.on('error', () => undefined);
      req.on('close', () => resolve({ status, type }));
      req.write('{"pad":"');
      const timer = setInterval(() => {
        if (!req.destroyed) req.write('x'.repeat(512));
      }, 5);
      req.on('close', () => clearInterval(timer));
      setTimeout(
        () => reject(new Error('no 413 / socket still open')),
        MAX_413_MS * 2,
      );
    });
    expect(result).toEqual({
      status: 413,
      type: expect.stringContaining('application/problem+json'),
    });
    expect(Date.now() - started).toBeLessThan(MAX_413_MS);
  });
});
