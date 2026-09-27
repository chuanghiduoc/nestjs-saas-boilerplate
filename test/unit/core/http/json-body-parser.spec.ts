import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/core/errors/index.js';
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
          return writeProblem(res, err, {
            instance: req.url ?? '',
            requestId: 'r-test',
            typeBase: '/errors',
          });
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
  it('matches the skip prefix case-insensitively, like Express routing', async () => {
    expect(
      (
        await request(server)
          .post(`${SKIP_PREFIX.toUpperCase()}/SIGN-IN`)
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

/** Sự kiện `raw-body` gắn lên request; sau khi parser trả lời, số listener phải về đúng như trước. */
const READ_EVENTS = ['data', 'end', 'aborted', 'close', 'error'] as const;
const CONSUMED_PATH = '/consumed';
const TIMEOUT = 'Timeout';
const listenerCounts = (req: IncomingMessage): number[] =>
  READ_EVENTS.map((e) => req.listenerCount(e));
const activeTimers = (): number =>
  process.getActiveResourcesInfo().filter((r) => r === TIMEOUT).length;
type Seen = {
  err: unknown;
  headersSent: boolean;
  listenersBefore: number[];
  listenersAfter: number[];
  timersBefore: number;
  timersAfter: number;
};
const CRLF = '\r\n';

describe('jsonBodyParser teardown paths (real sockets)', () => {
  let server: Server;
  let port = 0;
  let onEnter: (() => void) | undefined;
  let onNext: ((s: Seen) => void) | undefined;
  beforeAll(async () => {
    const cfg = httpConfig.schema.parse({ bodyLimit: `${LIMIT_BYTES}b` });
    const mw = jsonBodyParser(cfg);
    server = createServer((req, res) => {
      const run = () => {
        const listenersBefore = listenerCounts(req);
        const timersBefore = activeTimers();
        onEnter?.();
        mw(req, res, (err) => {
          onNext?.({
            err,
            headersSent: res.headersSent,
            listenersBefore,
            listenersAfter: listenerCounts(req),
            timersBefore,
            timersAfter: activeTimers(),
          });
          if (err)
            return writeProblem(res, err, {
              instance: req.url ?? '',
              requestId: 'r-teardown',
              typeBase: '/errors',
            });
          res.end();
        });
      };
      // Body đã bị middleware trước đọc hết (lỗi lập trình): parser nhận stream không còn đọc được.
      if (req.url === CONSUMED_PATH) {
        req.resume();
        req.once('end', run);
      } else run();
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

  it('client abort mid-body → 400 malformed_request (request.aborted), nothing written, no leaked listeners or timers', async () => {
    const entered = new Promise<void>((r) => (onEnter = r));
    const seen = new Promise<Seen>((r) => (onNext = r));
    const sock = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    sock.on('data', (c: Buffer) => received.push(c));
    sock.on('error', () => undefined);
    await once(sock, 'connect');
    sock.write(
      `POST /x HTTP/1.1${CRLF}Host: t${CRLF}Content-Type: application/json${CRLF}Content-Length: ${LIMIT_BYTES / 2}${CRLF}${CRLF}{"a":`,
    );
    await entered;
    sock.destroy();
    const s = await seen;
    expect(s.err).toBeInstanceOf(AppError);
    expect(s.err instanceof AppError && s.err.error.code).toBe(
      'malformed_request',
    );
    expect(s.headersSent).toBe(false);
    expect(s.listenersAfter).toEqual(s.listenersBefore);
    expect(s.timersAfter).toBeLessThanOrEqual(s.timersBefore);
    expect(Buffer.concat(received).length).toBe(0);
  });

  it('body already consumed (stream.not.readable) is a server bug → 500 internal_error', async () => {
    const res = await request(server)
      .post(CONSUMED_PATH)
      .send({ a: 1 })
      .expect(500);
    expect(res.body.code).toBe('internal_error');
  });

  it('413 over a raw socket: the full problem+json body arrives, then the server closes the socket', async () => {
    const sock = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    sock.on('data', (c: Buffer) => received.push(c));
    sock.on('error', () => undefined);
    await once(sock, 'connect');
    sock.write(
      `POST /x HTTP/1.1${CRLF}Host: t${CRLF}Content-Type: application/json${CRLF}Transfer-Encoding: chunked${CRLF}${CRLF}`,
    );
    const chunk = 'x'.repeat(256);
    const frame = `${chunk.length.toString(16)}${CRLF}${chunk}${CRLF}`;
    const timer = setInterval(() => {
      if (!sock.destroyed && sock.writable) sock.write(frame);
    }, CHUNK_INTERVAL_MS);
    const deadline = setTimeout(() => sock.destroy(), MAX_413_MS * 2);
    const started = Date.now();
    await once(sock, 'close');
    clearInterval(timer);
    clearTimeout(deadline);
    expect(Date.now() - started).toBeLessThan(MAX_413_MS);
    const raw = Buffer.concat(received).toString('utf8');
    const [head = '', body = ''] = raw.split(`${CRLF}${CRLF}`);
    const lines = head.toLowerCase().split(CRLF);
    expect(lines[0]).toBe('http/1.1 413 payload too large');
    expect(lines).toContain('connection: close');
    expect(lines).toContain(
      'content-type: application/problem+json; charset=utf-8',
    );
    expect(lines).toContain(`content-length: ${Buffer.byteLength(body)}`);
    expect(JSON.parse(body)).toMatchObject({
      status: 413,
      code: 'payload_too_large',
      requestId: 'r-teardown',
    });
  });
});
