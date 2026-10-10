import { Writable } from 'node:stream';
import { ReplyError } from 'ioredis';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  BASE_REDACT_PATHS,
  errSerializer,
  reqSerializer,
} from '../../../../src/core/logging/index.js';
import { AppError, CoreErrors } from '../../../../src/core/errors/index.js';

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  return {
    lines,
    stream: new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  };
}

describe('log redaction', () => {
  it('censors secrets at any depth covered by the base list', () => {
    const { lines, stream } = capture();
    const log = pino(
      { redact: { paths: [...BASE_REDACT_PATHS], censor: '[REDACTED]' } },
      stream,
    );
    log.info({
      req: {
        headers: {
          authorization: 'Bearer t',
          cookie: 'c',
          'x-api-key': 'k',
          'x-sepay-signature': 's',
        },
      },
      user: { password: 'p', profile: { password: 'p2' } },
      accessToken: 'a',
    });
    const out = lines.join('');
    for (const secret of [
      'Bearer t',
      '"c"',
      '"k"',
      '"s"',
      '"p"',
      '"p2"',
      '"a"',
    ])
      expect(out).not.toContain(secret);
  });
  it('censors webhook signing secrets and their ciphertext at any depth up to two (spec SP6 §5.3 core/logging)', () => {
    const { lines, stream } = capture();
    const log = pino(
      { redact: { paths: [...BASE_REDACT_PATHS], censor: '[REDACTED]' } },
      stream,
    );
    log.info({
      webhookSecret: 'ws-1',
      secretEnc: 'se-1',
      endpoint: {
        webhookSecret: 'ws-2',
        secretEnc: 'se-2',
        row: { secretEnc: 'se-3' },
      },
    });
    const out = lines.join('');
    for (const secret of ['ws-1', 'se-1', 'ws-2', 'se-2', 'se-3'])
      expect(out).not.toContain(secret);
  });
  it('censors outbound Authorization headers and the field encryption keyring', () => {
    const { lines, stream } = capture();
    const log = pino(
      { redact: { paths: [...BASE_REDACT_PATHS], censor: '[REDACTED]' } },
      stream,
    );
    log.info({
      outbound: { headers: { authorization: 'Bearer out' } },
      call: { init: { headers: { authorization: 'Bearer deep' } } },
      env: { FIELD_ENCRYPTION_KEYS: '{"k1":"keymaterial"}' },
      security: { keys: { k1: 'keymaterial2' } },
    });
    const out = lines.join('');
    for (const secret of ['Bearer out', 'Bearer deep', 'keymaterial'])
      expect(out).not.toContain(secret);
  });
  it('drops SQL, params and row details from errors', () => {
    const e = Object.assign(new Error('boom'), {
      query: 'select * from users where email = $1',
      params: ['a@b.c'],
      detail: 'Key (email)=(a@b.c)',
      code: '23505',
      constraint: 'users_email_uq',
    });
    const s = errSerializer(e);
    expect(JSON.stringify(s)).not.toContain('a@b.c');
    expect(s).toMatchObject({ code: '23505', constraint: 'users_email_uq' });
  });
  it('never logs Redis command args, request/response bodies or SQL from errors at any depth', () => {
    const SECRET = 'tok_live_s3cr3t';
    // ioredis gắn `command` vào ReplyError (DataHandler) và AbortError khi mất kết nối (event_handler).
    const redisErr = (message: string, name: string) =>
      Object.assign(new ReplyError(message), {
        command: { name, args: ['idem:k', `{"body":{"token":"${SECRET}"}}`] },
      });
    const reply = redisErr('OOM command not allowed', 'set');
    // MULTI/EXEC: ioredis gom lỗi của từng lệnh vào `previousErrors`.
    const exec = Object.assign(new ReplyError('EXECABORT'), {
      previousErrors: [redisErr('WRONGTYPE', 'evalsha')],
    });
    const cluster = Object.assign(new Error('Failed to refresh slots cache'), {
      lastNodeError: redisErr('NOPERM', 'hset'),
    });
    const wrapped = new AppError(CoreErrors.INTERNAL_ERROR, {
      cause: redisErr('Command aborted due to connection close', 'xadd'),
    });
    const bodyParser = Object.assign(new SyntaxError('Unexpected token'), {
      body: `{"password":"${SECRET}"`,
      type: 'entity.parse.failed',
    });
    const undiciResponse = Object.assign(new Error('Response error'), {
      body: { token: SECRET },
      statusCode: 502,
    });
    const pg = Object.assign(new Error('division by zero'), {
      internalQuery: `SELECT 1/0 WHERE secret = '${SECRET}'`,
      argv: [SECRET],
      args: [SECRET],
    });
    const { lines, stream } = capture();
    const log = pino({ serializers: { err: errSerializer } }, stream);
    for (const err of [
      reply,
      exec,
      cluster,
      wrapped,
      bodyParser,
      undiciResponse,
      pg,
    ])
      log.error({ err }, 'failed');
    const out = lines.join('');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('idem:k');
    for (const name of ['set', 'evalsha', 'hset', 'xadd'])
      expect(out).toContain(`"command":{"name":"${name}"}`);
    expect(errSerializer(bodyParser)).toMatchObject({
      type: 'entity.parse.failed',
      message: 'Unexpected token',
    });
    expect(errSerializer(undiciResponse)).toMatchObject({ statusCode: 502 });
    // Cùng một cause ở hai nhánh (opts.cause và cause) không bị coi là chu trình.
    expect(errSerializer(wrapped)).toMatchObject({
      cause: { command: { name: 'xadd' } },
      opts: { cause: { command: { name: 'xadd' } } },
    });
  });
  it('serializes a self-referencing error without recursing forever', () => {
    const e: Error & { self?: unknown } = new Error('loop');
    e.self = e;
    expect(() => JSON.stringify(errSerializer(e))).not.toThrow();
  });
  it('strips query strings from logged URLs', () => {
    expect(
      reqSerializer({ method: 'GET', url: '/reset?token=secret', headers: {} }),
    ).toMatchObject({ url: '/reset' });
  });
});

describe('SP2 redaction additions', () => {
  it('redacts cookie/bearer/set-auth-token/API-key headers in nested log objects, in both Node-lowercase and Title-Case form', () => {
    const { lines, stream } = capture();
    const log = pino(
      { redact: { paths: [...BASE_REDACT_PATHS], censor: '[REDACTED]' } },
      stream,
    );
    const COOKIE = 'sid=deadbeef; Path=/; HttpOnly';
    const OTHER_COOKIE = 'consent=1';
    const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.secret';
    const AUTH_TOKEN = 'session-token-xyz-secret';
    const API_KEY = 'ak_live_super_secret';
    log.info({
      // req/res.headers: object Node http thật, tên header luôn viết thường.
      req: { headers: { cookie: COOKIE, 'x-api-key': API_KEY } },
      res: { headers: { 'set-cookie': [COOKIE, OTHER_COOKIE] } },
      // Object header do ứng dụng tự dựng để gọi ra ngoài / bị log lại: không đi qua tầng http của
      // Node nên có thể giữ cả hai cách viết — kiểm cả biến thể viết thường và Title-Case.
      outbound: {
        headers: {
          cookie: COOKIE,
          authorization: BEARER,
          'set-auth-token': AUTH_TOKEN,
        },
      },
      call: {
        init: {
          headers: {
            Cookie: COOKIE,
            Authorization: BEARER,
            'Set-Auth-Token': AUTH_TOKEN,
          },
        },
      },
    });
    const out = lines.join('');
    for (const secret of [COOKIE, OTHER_COOKIE, BEARER, AUTH_TOKEN, API_KEY])
      expect(out).not.toContain(secret);
  });
  it('drops nodemailer fields that carry e-mail addresses, through a real pino instance', () => {
    const { lines, stream } = capture();
    const log = pino({ serializers: { err: errSerializer } }, stream);
    const err = Object.assign(new Error('Message failed'), {
      command: 'DATA',
      response: '550 5.1.1 <victim@example.com>: Recipient address rejected',
      responseCode: 550,
      accepted: ['delivered@example.com'],
      rejected: ['victim@example.com'],
      rejectedErrors: [
        Object.assign(new Error('victim@example.com'), {
          recipient: 'victim@example.com',
          command: 'RCPT TO',
        }),
      ],
      envelope: { from: 'noreply@example.com', to: ['victim@example.com'] },
      recipient: 'victim@example.com',
    });
    log.error({ err }, 'send failed');
    const out = lines.join('');
    for (const address of [
      'victim@example.com',
      'delivered@example.com',
      'noreply@example.com',
    ])
      expect(out).not.toContain(address);
    expect(out).toContain('"responseCode":550');
    expect(out).toContain('"command":"DATA"');
    // `rejectedErrors` bị bỏ nguyên (ERROR_PAYLOAD_DROP), nên nó không còn trong output để soát field lồng.
    expect(errSerializer(err)).toMatchObject({
      command: 'DATA',
      responseCode: 550,
    });
    expect(errSerializer(err)).not.toHaveProperty('rejectedErrors');
  });
  it('keeps the bare SMTP command verb but drops a command string carrying anything else', () => {
    const clean = Object.assign(new Error('failed'), { command: 'RCPT TO' });
    expect(errSerializer(clean)).toMatchObject({ command: 'RCPT TO' });
    const tampered = Object.assign(new Error('failed'), {
      command: 'RCPT TO <victim@example.com>',
    });
    expect(JSON.stringify(errSerializer(tampered))).not.toContain(
      'victim@example.com',
    );
  });
  it('masks opaque token segments in the logged path (reset-password links), keeps UUIDs and short segments', () => {
    expect(
      reqSerializer({
        method: 'GET',
        url: '/api/auth/reset-password/AbCdEfGhIjKlMnOpQrStUvWx?callbackURL=https://a.test',
        headers: {},
      }),
    ).toMatchObject({ url: '/api/auth/reset-password/[redacted]' });
    expect(
      reqSerializer({
        method: 'GET',
        url: '/v1/orders/0199a7c2-5b1e-7d2a-9c3f-2b1a0e9d8c7b/items',
        headers: {},
      }),
    ).toMatchObject({
      url: '/v1/orders/0199a7c2-5b1e-7d2a-9c3f-2b1a0e9d8c7b/items',
    });
    expect(
      reqSerializer({
        method: 'GET',
        url: '/api/auth/verify-email',
        headers: {},
      }),
    ).toMatchObject({ url: '/api/auth/verify-email' });
  });
});
