import { describe, expect, it } from 'vitest';
import { CoreErrors } from '../../../../src/core/errors/index.js';
import {
  SsrfBlockedError,
  UpstreamError,
  parseRetryAfterSec,
  upstreamErrorMapper,
} from '../../../../src/core/resilience/index.js';

const NOW = Date.parse('2026-09-25T10:00:00Z');
const MAX_SEC = 300;

describe('parseRetryAfterSec', () => {
  it.each([
    ['30', 30],
    [' 0 ', 0],
    ['Fri, 25 Sep 2026 10:01:30 GMT', 90],
    // Hai dạng HTTP-date cũ mà RFC 9110 §5.6.7 bắt bên nhận phải chấp nhận (asctime là GMT).
    ['Friday, 25-Sep-26 10:01:30 GMT', 90],
    ['Fri Sep 25 10:01:30 2026', 90],
    // Mốc đã qua: thử lại ngay.
    ['Fri, 25 Sep 2026 09:59:00 GMT', 0],
    // Upstream đòi lâu hơn trần config: chặn ở trần.
    ['86400', MAX_SEC],
    ['Sat, 26 Sep 2026 10:00:00 GMT', MAX_SEC],
  ])('parses %j to %d seconds', (value, sec) => {
    expect(parseRetryAfterSec(value, MAX_SEC, NOW)).toBe(sec);
  });
  it.each([undefined, '', 'soon', '-5', '1.5', '30s'])(
    'treats %j as unknown',
    (value) => {
      expect(parseRetryAfterSec(value, MAX_SEC, NOW)).toBeUndefined();
    },
  );
});

describe('upstreamErrorMapper', () => {
  it.each([
    ['bad_status', CoreErrors.UPSTREAM_ERROR],
    ['too_large', CoreErrors.UPSTREAM_ERROR],
    ['network', CoreErrors.UPSTREAM_ERROR],
    ['timeout', CoreErrors.UPSTREAM_TIMEOUT],
    ['circuit_open', CoreErrors.SERVICE_UNAVAILABLE],
    ['bulkhead_full', CoreErrors.SERVICE_UNAVAILABLE],
    ['rate_limited', CoreErrors.SERVICE_UNAVAILABLE],
  ] as const)('maps %s to %s without exposing detail', (reason, code) => {
    const mapped = upstreamErrorMapper(
      new UpstreamError('sepay', reason, 'Upstream sepay http://10.0.0.7/x'),
    );
    expect(mapped?.error).toBe(code);
    expect(mapped?.opts.detail).toBeUndefined();
  });
  it('passes a known Retry-After of a rate-limited upstream to the client, and none when unknown', () => {
    const known = upstreamErrorMapper(
      new UpstreamError('sepay', 'rate_limited', 'limited', { retryAfter: 30 }),
    );
    expect(known?.opts.headers).toEqual({ 'Retry-After': '30' });
    const unknown = upstreamErrorMapper(
      new UpstreamError('sepay', 'rate_limited', 'limited'),
    );
    expect(unknown?.opts.headers).toBeUndefined();
  });
  it('maps an SSRF block to upstream_error without the destination', () => {
    const mapped = upstreamErrorMapper(
      new SsrfBlockedError('Destination 10.0.0.7 is not allowed'),
    );
    expect(mapped?.error).toBe(CoreErrors.UPSTREAM_ERROR);
    expect(mapped?.opts.detail).toBeUndefined();
  });
  it('ignores unrelated errors', () => {
    expect(upstreamErrorMapper(new Error('x'))).toBeUndefined();
  });
});
