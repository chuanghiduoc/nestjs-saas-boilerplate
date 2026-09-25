import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  BASE_REDACT_PATHS,
  errSerializer,
  reqSerializer,
} from '../../../../src/core/logging/index.js';

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
  it('strips query strings from logged URLs', () => {
    expect(
      reqSerializer({ method: 'GET', url: '/reset?token=secret', headers: {} }),
    ).toMatchObject({ url: '/reset' });
  });
});
