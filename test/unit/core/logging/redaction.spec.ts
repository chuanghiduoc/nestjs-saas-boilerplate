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
