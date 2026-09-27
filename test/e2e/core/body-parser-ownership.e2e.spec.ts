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
import { expectFull413, oversizedUploadMix } from '../../support/raw-upload.js';

const LIMIT_BYTES = 2048;
const MAX_413_MS = 2000;
/** Grace của lingering close sau 413 (S2-R12): nhỏ để socket body vô hạn đóng nhanh. */
const LINGER_MS = 300;
/** Quá limit nhưng dưới trần byte mặc định của lingering: server đọc hết rồi mới đóng. */
const OVERSIZED_BYTES = 512 * 1024;
const PARALLEL_CONTENT_LENGTH = 20;
const PARALLEL_CHUNKED = 10;
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
    vi.stubEnv('HTTP_BODY_LIMIT_LINGER_MS', String(LINGER_MS));
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
  it('an unbounded chunked body on a Nest route → problem+json 413, socket closed within the linger grace', async () => {
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
    expect(Date.now() - started).toBeLessThan(LINGER_MS + MAX_413_MS);
  });
  it('under concurrent oversized uploads on a Nest route every client reads the full 413, no reset (ruling S2-R12)', async () => {
    const a = await make();
    await a.listen(0, '127.0.0.1');
    const port = (a.getHttpServer().address() as AddressInfo).port;
    const results = await Promise.all(
      oversizedUploadMix(port, OVERSIZED_BYTES, '/echo', {
        contentLength: PARALLEL_CONTENT_LENGTH,
        chunked: PARALLEL_CHUNKED,
      }),
    );
    for (const r of results) expectFull413(r);
  });
});
