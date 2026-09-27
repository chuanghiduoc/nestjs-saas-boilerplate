import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, toAppError } from '../../../../src/core/errors/index.js';
import {
  httpConfig,
  jsonBodyParser,
  writeProblem,
} from '../../../../src/core/http/index.js';

const LIMIT_BYTES = 1024;
/** Giới hạn thời gian cho 413 của body vô hạn: parser phải trả lời khi còn đang nhận, không chờ `end`. */
const MAX_413_MS = 2000;
const CHUNK_INTERVAL_MS = 5;
const SKIP_PREFIX = '/skipped';
/** Giả lập mount path của Express (spike S1): `req.url` bị cắt, path gốc nằm ở `req.originalUrl`. */
const MOUNTED_PREFIX = '/mounted';
const parsed = (
  r: IncomingMessage,
): { body: unknown; raw: string } | undefined =>
  'rawBody' in r && Buffer.isBuffer(r.rawBody) && 'body' in r
    ? { body: r.body, raw: r.rawBody.toString('utf8') }
    : undefined;

describe('jsonBodyParser (stream-limited, raw-body)', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const cfg = httpConfig.schema.parse({ bodyLimit: `${LIMIT_BYTES}b` });
    const mw = jsonBodyParser(cfg, { skipPathPrefix: SKIP_PREFIX });
    server = createServer((req, res) => {
      if (req.url?.startsWith(MOUNTED_PREFIX))
        Object.assign(req, {
          originalUrl: `${SKIP_PREFIX}${req.url.slice(MOUNTED_PREFIX.length)}`,
          url: '/',
        });
      mw(req, res, (err) => {
        if (err)
          return writeProblem(
            res,
            err instanceof AppError ? err : toAppError(err),
            {
              instance: req.url ?? '',
              requestId: 'r-test',
              typeBase: '/errors',
            },
          );
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(parsed(req) ?? { body: null, raw: null }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );

  it('parses JSON and keeps the raw body', async () => {
    const res = await request(server).post('/x').send({ a: 1 }).expect(200);
    expect(res.body).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
  });
  it('skips GET, bodiless requests and the delegated path prefix', async () => {
    expect((await request(server).get('/x').expect(200)).body).toEqual({
      body: null,
      raw: null,
    });
    expect(
      (
        await request(server)
          .post(`${SKIP_PREFIX}/sign-in`)
          .send({ a: 1 })
          .expect(200)
      ).body,
    ).toEqual({ body: null, raw: null });
  });
  it('matches the skip prefix against originalUrl when Express stripped the mount path', async () => {
    expect(
      (
        await request(server)
          .post(`${MOUNTED_PREFIX}/sign-in`)
          .send({ a: 1 })
          .expect(200)
      ).body,
    ).toEqual({ body: null, raw: null });
  });
  it.each([
    ['text/plain', 'text/plain', undefined, 415, 'unsupported_media_type'],
    [
      'gzip encoding',
      'application/json',
      'gzip',
      415,
      'unsupported_media_type',
    ],
    [
      'latin1 charset',
      'application/json; charset=latin1',
      undefined,
      415,
      'unsupported_media_type',
    ],
  ])('%s → %s', async (_n, type, encoding, status, code) => {
    let r = request(server).post('/x').set('content-type', type);
    if (encoding) r = r.set('content-encoding', encoding);
    const res = await r.send('{"a":1}');
    expect([res.status, res.body.code]).toEqual([status, code]);
  });
  it.each(['{bad', '"just a string"', '42'])(
    '400 malformed_request for %s (strict: object or array only)',
    async (body) => {
      const res = await request(server)
        .post('/x')
        .set('content-type', 'application/json')
        .send(body)
        .expect(400);
      expect(res.body.code).toBe('malformed_request');
    },
  );
  it('413 when Content-Length exceeds the limit', async () => {
    const res = await request(server)
      .post('/x')
      .send({ pad: 'x'.repeat(LIMIT_BYTES * 2) })
      .expect(413);
    expect(res.body.code).toBe('payload_too_large');
  });
  it('413 for an UNBOUNDED chunked body within a bounded time, and the socket is closed', async () => {
    const started = Date.now();
    const result = await new Promise<{
      status: number;
      connection: string | undefined;
      closed: boolean;
    }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/x',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      });
      let status = 0;
      let connection: string | undefined;
      req.on('response', (res) => {
        status = res.statusCode ?? 0;
        connection = res.headers.connection;
        res.resume();
      });
      req.on('error', () => undefined);
      req.on('close', () => resolve({ status, connection, closed: true }));
      req.write('{"pad":"');
      // Client không bao giờ kết thúc body: chỉ có server đóng socket mới dừng vòng ghi.
      const timer = setInterval(() => {
        if (!req.destroyed) req.write('x'.repeat(256));
      }, CHUNK_INTERVAL_MS);
      const deadline = setTimeout(
        () => reject(new Error('no 413 / socket still open')),
        MAX_413_MS * 2,
      );
      req.on('close', () => {
        clearInterval(timer);
        clearTimeout(deadline);
      });
    });
    expect(result).toEqual({ status: 413, connection: 'close', closed: true });
    expect(Date.now() - started).toBeLessThan(MAX_413_MS);
  });
});
