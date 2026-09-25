import { describe, expect, it } from 'vitest';
import { CoreErrors } from '../../../../src/core/errors/index.js';
import {
  SsrfBlockedError,
  UpstreamError,
  upstreamErrorMapper,
} from '../../../../src/core/resilience/index.js';

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
