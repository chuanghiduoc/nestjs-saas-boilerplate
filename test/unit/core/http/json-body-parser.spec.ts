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
import {
  CRLF,
  chunkFrame,
  chunkedUpload,
  contentLengthUpload,
  expectFull413,
  oversizedUploadMix,
  upload,
} from '../../../support/raw-upload.js';

const LIMIT_BYTES = 1024;
/** Giới hạn thời gian cho 413 của body vô hạn: parser phải trả lời khi còn đang nhận, không chờ `end`. */
const MAX_413_MS = 2000;
const CHUNK_INTERVAL_MS = 5;
/** Grace của lingering close sau 413 (S2-R12) trong test: nhỏ để socket body vô hạn đóng nhanh. */
const LINGER_MS = 300;
/** Dư cho lịch event loop/CI khi đo thời điểm đóng socket so với grace. */
const CLOSE_MARGIN_MS = 1500;
const limitedCfg = () =>
  httpConfig.schema.parse({
    bodyLimit: `${LIMIT_BYTES}b`,
    bodyLimitLingerMs: LINGER_MS,
  });
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
    const mw = jsonBodyParser(limitedCfg(), {
      skipPathPrefixes: [SKIP_PREFIX],
    });
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
  it('413 for an UNBOUNDED chunked body, then the socket is closed within the linger grace', async () => {
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
    // S2-R12: không `Connection: close` (Node sẽ huỷ socket khi client còn gửi → RST mất 413).
    expect(result).toMatchObject({ status: 413, closed: true });
    expect(result.connection).not.toBe('close');
    expect(Date.now() - started).toBeLessThan(LINGER_MS + CLOSE_MARGIN_MS);
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

describe('jsonBodyParser teardown paths (real sockets)', () => {
  let server: Server;
  let port = 0;
  let onEnter: (() => void) | undefined;
  let onNext: ((s: Seen) => void) | undefined;
  beforeAll(async () => {
    const mw = jsonBodyParser(limitedCfg());
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

  it('413 over a raw socket: the full problem+json body arrives, then the server closes the socket after the linger grace', async () => {
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
    // Hết grace thì server huỷ socket khi client còn gửi: RST ở đây là đúng thiết kế (413 đã đọc từ trước).
    await new Promise<void>((r) => sock.once('close', () => r()));
    clearInterval(timer);
    clearTimeout(deadline);
    expect(Date.now() - started).toBeLessThan(LINGER_MS + CLOSE_MARGIN_MS);
    const raw = Buffer.concat(received).toString('utf8');
    const [head = '', body = ''] = raw.split(`${CRLF}${CRLF}`);
    const lines = head.toLowerCase().split(CRLF);
    expect(lines[0]).toBe('http/1.1 413 payload too large');
    expect(lines).not.toContain('connection: close');
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

/** Body quá limit nhưng dưới trần byte của lingering: server đọc hết rồi mới đóng. */
const OVERSIZED_BYTES = 512 * 1024;
const LINGER_BYTES_CAP = 1024 * 1024;
const PARALLEL_CONTENT_LENGTH = 20;
const PARALLEL_CHUNKED = 10;
/** Grace dài khi thử trần byte / client huỷ: socket phải đóng vì lý do khác, trước grace rất xa. */
const LONG_LINGER_MS = 3000;
const SMALL_LINGER_BYTES = 64 * 1024;
const CAP_TEST_CHUNK_BYTES = 16 * 1024;
/** Content-Length rất lớn so với trần: nếu server đọc bỏ hết thay vì cắt, client ghi xong toàn bộ. */
const HUGE_CONTENT_LENGTH = 256 * 1024 * 1024;
const PUMP_CHUNK_BYTES = 64 * 1024;
/** Content-Length mà phần còn lại chắc chắn vượt trần nhỏ (S2-R16), và một cái nằm dưới trần. */
const CAP_CERTAIN_BYTES = 1024 * 1024;
const UNDER_CAP_BYTES = 32 * 1024;
/** Body chunked chỉ nhỉnh hơn limit, gửi trọn một lần: request đã `complete` khi parser trả 413. */
const SLIGHTLY_OVER_LIMIT = LIMIT_BYTES + 100;
/** Client huỷ giữa lúc linger: số byte gửi trước khi huỷ (quá limit, dưới trần). */
const ABORT_AFTER_BYTES = LIMIT_BYTES * 4;
/** Timer của Node có thể nổ sớm vài ms so với đồng hồ Date.now() của client. */
const TIMER_TOLERANCE_MS = 20;
/** Path giả lập ShutdownCoordinator đang draining: `Connection: close` đã có trước khi parser chạy. */
const DRAINING_PATH = '/draining';
const REUSE_DEADLINE_MS = 5000;
/** Chờ qua một vòng event loop: listener `close` của lingering chạy sau listener ghi nhận của test. */
const nextLoop = () => new Promise<void>((r) => setImmediate(r));

type Limited = {
  server: Server;
  port: number;
  /** Số listener `data` còn trên request, đo một vòng event loop sau khi socket đóng. */
  dataListenersAtClose: number[];
};
async function startLimited(
  lingerMs: number,
  lingerBytes: number,
): Promise<Limited> {
  const mw = jsonBodyParser(
    httpConfig.schema.parse({
      bodyLimit: `${LIMIT_BYTES}b`,
      bodyLimitLingerMs: lingerMs,
      bodyLimitLingerBytes: lingerBytes,
    }),
  );
  const dataListenersAtClose: number[] = [];
  const server = createServer((req, res) => {
    if (req.url === DRAINING_PATH) res.setHeader('Connection', 'close');
    req.socket.once('close', () =>
      setImmediate(() => dataListenersAtClose.push(req.listenerCount('data'))),
    );
    mw(req, res, (err) => {
      if (err)
        return writeProblem(res, err, {
          instance: req.url ?? '',
          requestId: 'r-linger',
          typeBase: '/errors',
        });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    dataListenersAtClose,
  };
}
const stop = (server: Server) =>
  new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });

/**
 * Client keep-alive gửi `head` + `body` quá cỡ, đọc 413, rồi gửi tiếp một GET trên CÙNG socket; trả về mọi byte nhận
 * được. Parser của socket phải ở trạng thái sạch thì GET mới được trả 200.
 */
async function reuseAfter413(
  port: number,
  head: string,
  body: Buffer | string,
): Promise<string> {
  const sock = connect(port, '127.0.0.1');
  const received: Buffer[] = [];
  let sentSecond = false;
  const done = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('no second response on the reused socket')),
      REUSE_DEADLINE_MS,
    );
    sock.on('error', (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    sock.on('data', (c: Buffer) => {
      received.push(c);
      const raw = Buffer.concat(received).toString();
      if (!sentSecond && raw.includes('"payload_too_large"')) {
        sentSecond = true;
        sock.write(`GET /x HTTP/1.1${CRLF}Host: t${CRLF}${CRLF}`);
      }
      if (raw.includes('HTTP/1.1 200')) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  await once(sock, 'connect');
  sock.write(
    `POST /x HTTP/1.1${CRLF}Host: t${CRLF}Content-Type: application/json${CRLF}${head}${CRLF}`,
  );
  sock.write(body);
  try {
    await done;
  } finally {
    sock.destroy();
  }
  return Buffer.concat(received).toString();
}
const chunkedBody = (bytes: number, frameBytes: number): string => {
  let out = '';
  for (let sent = 0; sent < bytes; sent += frameBytes)
    out += chunkFrame('x'.repeat(Math.min(frameBytes, bytes - sent)));
  return `${out}0${CRLF}${CRLF}`;
};
const headLines = (raw: string): string[] =>
  (raw.split(`${CRLF}${CRLF}`)[0] ?? '').toLowerCase().split(CRLF);

describe('lingering close after 413 (ruling S2-R12, real sockets)', () => {
  describe('grace-bounded server', () => {
    let s: Limited;
    beforeAll(async () => {
      s = await startLimited(LINGER_MS, LINGER_BYTES_CAP);
    });
    afterAll(() => stop(s.server));

    it('under concurrent load every oversized upload (Content-Length and chunked, keep-alive and Connection: close) gets the full 413, no reset', async () => {
      const results = await Promise.all(
        oversizedUploadMix(s.port, OVERSIZED_BYTES, '/x', {
          contentLength: PARALLEL_CONTENT_LENGTH,
          chunked: PARALLEL_CHUNKED,
        }),
      );
      for (const r of results) expectFull413(r);
    });

    it('a Connection: close client is closed by the server right after the drain, and the 413 does not advertise keep-alive', async () => {
      const r = await contentLengthUpload(
        s.port,
        OVERSIZED_BYTES,
        '/x',
        'close',
      );
      expectFull413(r);
      expect(r.closeAfterResponseMs).toBeLessThan(LINGER_MS);
      const lines = headLines(r.raw);
      expect(lines.some((l) => l.startsWith('connection:'))).toBe(false);
      expect(lines.some((l) => l.startsWith('keep-alive:'))).toBe(false);
    });

    it.each([
      [
        'Content-Length body',
        `Content-Length: ${OVERSIZED_BYTES}${CRLF}`,
        Buffer.alloc(OVERSIZED_BYTES, 'x'),
      ],
      [
        'chunked body',
        `Transfer-Encoding: chunked${CRLF}`,
        chunkedBody(OVERSIZED_BYTES, CAP_TEST_CHUNK_BYTES),
      ],
      [
        'chunked body already complete when the 413 is decided',
        `Transfer-Encoding: chunked${CRLF}`,
        chunkedBody(SLIGHTLY_OVER_LIMIT, SLIGHTLY_OVER_LIMIT),
      ],
    ])(
      'a keep-alive client can reuse the connection after the drain (%s)',
      async (_name, head, body) => {
        const raw = await reuseAfter413(s.port, head, body);
        expect(raw.startsWith('HTTP/1.1 413 Payload Too Large')).toBe(true);
        expect(headLines(raw)).toContain('connection: keep-alive');
        expect(raw).toContain('HTTP/1.1 200 OK');
      },
    );

    it('a client that stops sending mid-body gets the 413, then its socket is destroyed once the grace elapses', async () => {
      const r = await upload(
        s.port,
        `Content-Length: ${OVERSIZED_BYTES}${CRLF}`,
        (sock) => sock.write(Buffer.alloc(LIMIT_BYTES * 2, 'x')),
        '/x',
        'server-closes',
      );
      expect(r.raw.toLowerCase()).toContain('http/1.1 413 payload too large');
      expect(r.closeAfterResponseMs).toBeGreaterThanOrEqual(
        LINGER_MS - TIMER_TOLERANCE_MS,
      );
      expect(r.closeAfterResponseMs).toBeLessThan(LINGER_MS + CLOSE_MARGIN_MS);
    });

    it('a Connection: close set earlier (shutdown draining) does not reset the clients under load, and the server still closes after the drain', async () => {
      const results = await Promise.all([
        ...Array.from({ length: PARALLEL_CONTENT_LENGTH }, () =>
          contentLengthUpload(
            s.port,
            OVERSIZED_BYTES,
            DRAINING_PATH,
            'server-closes',
          ),
        ),
        ...Array.from({ length: PARALLEL_CHUNKED }, () =>
          chunkedUpload(
            s.port,
            OVERSIZED_BYTES,
            DRAINING_PATH,
            'server-closes',
          ),
        ),
      ]);
      for (const r of results) {
        expectFull413(r);
        expect(r.closeAfterResponseMs).toBeLessThan(LINGER_MS);
        const lines = headLines(r.raw);
        expect(lines.some((l) => l.startsWith('connection:'))).toBe(false);
        expect(lines.some((l) => l.startsWith('keep-alive:'))).toBe(false);
      }
    });

    it('left no data listener behind on any path', async () => {
      await nextLoop();
      expect(s.dataListenersAtClose.length).toBeGreaterThan(0);
      expect(new Set(s.dataListenersAtClose)).toEqual(new Set([0]));
    });
  });

  describe('long-grace, byte-capped server', () => {
    let s: Limited;
    beforeAll(async () => {
      s = await startLimited(LONG_LINGER_MS, SMALL_LINGER_BYTES);
    });
    afterAll(() => stop(s.server));

    it('an unbounded chunked upload is cut once the discarded bytes pass the cap, long before the grace', async () => {
      s.dataListenersAtClose.length = 0;
      const started = Date.now();
      const r = await upload(
        s.port,
        `Transfer-Encoding: chunked${CRLF}`,
        (sock) => {
          const frame = chunkFrame('x'.repeat(CAP_TEST_CHUNK_BYTES));
          const timer = setInterval(() => {
            if (!sock.destroyed && sock.writable) sock.write(frame);
          }, CHUNK_INTERVAL_MS);
          sock.once('close', () => clearInterval(timer));
        },
        '/x',
        'server-closes',
      );
      expect(r.raw.toLowerCase()).toContain('http/1.1 413 payload too large');
      expect(Date.now() - started).toBeLessThan(CLOSE_MARGIN_MS);
      // Sau FIN server không còn đọc: socket phía server đóng khi hết grace, listener phải về 0.
      await until(
        () => s.dataListenersAtClose.length === 1,
        LONG_LINGER_MS + CLOSE_MARGIN_MS,
      );
      expect(s.dataListenersAtClose).toEqual([0]);
    });

    it('a keep-alive client whose declared Content-Length is sure to pass the cap gets a 413 without keep-alive headers, then the socket closes (ruling S2-R16)', async () => {
      s.dataListenersAtClose.length = 0;
      const r = await contentLengthUpload(
        s.port,
        CAP_CERTAIN_BYTES,
        '/x',
        'server-closes',
      );
      expectFull413(r);
      const lines = headLines(r.raw);
      expect(lines.some((l) => l.startsWith('connection:'))).toBe(false);
      expect(lines.some((l) => l.startsWith('keep-alive:'))).toBe(false);
      expect(r.closeAfterResponseMs).toBeLessThan(CLOSE_MARGIN_MS);
      // Socket phía server đóng muộn nhất khi hết grace; chờ để không lẫn sang test sau.
      await until(
        () => s.dataListenersAtClose.length === 1,
        LONG_LINGER_MS + CLOSE_MARGIN_MS,
      );
      expect(s.dataListenersAtClose).toEqual([0]);
    });

    it('a keep-alive client whose declared Content-Length fits under the cap still gets keep-alive', async () => {
      s.dataListenersAtClose.length = 0;
      const raw = await reuseAfter413(
        s.port,
        `Content-Length: ${UNDER_CAP_BYTES}${CRLF}`,
        Buffer.alloc(UNDER_CAP_BYTES, 'x'),
      );
      expect(headLines(raw)).toContain('connection: keep-alive');
      expect(raw).toContain('HTTP/1.1 200 OK');
      // Client đã huỷ socket: chờ server ghi nhận đóng (một mục cho mỗi request: POST và GET) để không lẫn sang test sau.
      await until(
        () => s.dataListenersAtClose.length === 2,
        LONG_LINGER_MS + CLOSE_MARGIN_MS,
      );
    });

    it('a Content-Length upload far above the cap is cut once it passes the cap, not drained to the end', async () => {
      s.dataListenersAtClose.length = 0;
      let flushedAll = false;
      const started = Date.now();
      const r = await upload(
        s.port,
        `Content-Length: ${HUGE_CONTENT_LENGTH}${CRLF}`,
        (sock) => {
          const chunk = Buffer.alloc(PUMP_CHUNK_BYTES, 'x');
          let written = 0;
          // Ghi theo backpressure: socket chỉ nhận thêm khi server còn đọc.
          const pump = () => {
            while (!sock.destroyed && written < HUGE_CONTENT_LENGTH) {
              written += PUMP_CHUNK_BYTES;
              const last = written >= HUGE_CONTENT_LENGTH;
              const ok = sock.write(chunk, () => {
                if (last) flushedAll = true;
              });
              if (!ok) return void sock.once('drain', pump);
            }
          };
          pump();
          // Như client HTTP thật: server đã trả lời và gửi FIN thì ngừng upload và đóng. Không dựa vào `end()` tự động
          // (allowHalfOpen: false): nó xếp sau write còn kẹt trong buffer của client, mà write đó chỉ xả được khi
          // kernel còn nhận. Trên Linux buffer gửi đã đầy vì server ngừng đọc, nên client chỉ đóng khi server huỷ lúc
          // hết grace; trên Windows kernel nhận hết write nên client đóng ngay. Thời điểm đóng khi đó đo client chứ
          // không đo server (CI run 36417542233).
          sock.once('end', () => sock.destroy());
        },
        '/x',
        'server-closes',
      );
      expect(r.raw.toLowerCase()).toContain('http/1.1 413 payload too large');
      expect(flushedAll).toBe(false);
      expect(Date.now() - started).toBeLessThan(CLOSE_MARGIN_MS);
      await until(
        () => s.dataListenersAtClose.length === 1,
        LONG_LINGER_MS + CLOSE_MARGIN_MS,
      );
      expect(s.dataListenersAtClose).toEqual([0]);
    });

    it('a client that aborts mid-drain releases the listeners and the grace timer right away', async () => {
      s.dataListenersAtClose.length = 0;
      const timersBefore = activeTimers();
      const sock = connect(s.port, '127.0.0.1');
      sock.on('error', () => undefined);
      await once(sock, 'connect');
      sock.write(
        `POST /x HTTP/1.1${CRLF}Host: t${CRLF}Content-Type: application/json${CRLF}Content-Length: ${OVERSIZED_BYTES}${CRLF}${CRLF}`,
      );
      sock.write(Buffer.alloc(ABORT_AFTER_BYTES, 'x'));
      await once(sock, 'data');
      sock.destroy();
      await until(() => s.dataListenersAtClose.length === 1);
      expect(s.dataListenersAtClose).toEqual([0]);
      expect(activeTimers()).toBeLessThanOrEqual(timersBefore);
    });
  });
});

/** Chờ điều kiện (poll ngắn), không ngủ theo giờ cố định. */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error('condition not met');
    await nextLoop();
  }
}
