import {
  Body,
  Controller,
  Global,
  Module,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import getRawBody from 'raw-body';
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
  /** Như identity: module chủ prefix tự đọc stream. Core đã đọc mất body thì `getRawBody` không còn gì. */
  @Post('owned/echo') async owned(
    @Body() body: unknown,
    @Req() req: IncomingMessage,
  ) {
    const selfRead = (await getRawBody(req)).toString('utf8');
    return { body: body ?? null, selfRead };
  }
}

const OWNED_JSON = '{"a":1}';

/** Request thô qua socket để gửi request-target dạng absolute-form (supertest/http.request không gửi được). */
const rawPost = (port: number, target: string, body: string) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [head = '', payload = ''] = text.split('\r\n\r\n');
      resolve({
        status: Number(head.split(' ')[1]),
        body: JSON.parse(payload) as unknown,
      });
    });
    socket.write(
      [
        `POST ${target} HTTP/1.1`,
        'Host: evil.example',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
  });
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
      { beforeInit: applyHttpDefaults },
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
    ).toEqual({ body: null, selfRead: OWNED_JSON });
    expect(
      (
        await request(a.getHttpServer())
          .post('/echo')
          .send({ a: 1 })
          .expect(201)
      ).body.body,
    ).toEqual({ a: 1 });
  });
  it('the owned prefix is skipped case-insensitively (Express routes /OWNED/Echo to the same handler)', async () => {
    const a = await make([OwnerModule]);
    expect(
      (
        await request(a.getHttpServer())
          .post('/OWNED/Echo')
          .set('content-type', 'application/json')
          .send(OWNED_JSON)
          .expect(201)
      ).body,
    ).toEqual({ body: null, selfRead: OWNED_JSON });
  });
  it('an absolute-form request-target cannot bypass the owned prefix', async () => {
    const a = await make([OwnerModule]);
    await a.listen(0, '127.0.0.1');
    const port = (a.getHttpServer().address() as AddressInfo).port;
    expect(
      await rawPost(port, 'http://evil.example/owned/echo', OWNED_JSON),
    ).toEqual({ status: 201, body: { body: null, selfRead: OWNED_JSON } });
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
