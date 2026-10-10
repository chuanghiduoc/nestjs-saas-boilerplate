import { describe, expect, it } from 'vitest';
import {
  SsrfBlockedError,
  UpstreamError,
  type UpstreamFailure,
} from '../../../../src/core/resilience/index.js';
import {
  outcomeOfError,
  outcomeOfStatus,
} from '../../../../src/modules/integrations/domain/attempt-outcome.js';

describe('HTTP result → last_error (spec SP6 §8.3 step 4)', () => {
  it.each([
    [200, { kind: 'DELIVERED', statusCode: 200 }],
    [204, { kind: 'DELIVERED', statusCode: 204 }],
    [
      302,
      {
        kind: 'FAILED',
        error: 'REDIRECT',
        statusCode: 302,
        retryAfterSec: null,
      },
    ],
    [
      404,
      {
        kind: 'FAILED',
        error: 'CLIENT_ERROR',
        statusCode: 404,
        retryAfterSec: null,
      },
    ],
    [
      410,
      {
        kind: 'FAILED',
        error: 'CLIENT_ERROR',
        statusCode: 410,
        retryAfterSec: null,
      },
    ],
  ])('status %i', (status, want) => {
    expect(outcomeOfStatus(status)).toEqual(want);
  });
  it.each([
    [
      'bad_status',
      503,
      undefined,
      {
        kind: 'FAILED',
        error: 'SERVER_ERROR',
        statusCode: 503,
        retryAfterSec: null,
      },
    ],
    [
      'rate_limited',
      429,
      30,
      {
        kind: 'FAILED',
        error: 'RATE_LIMITED',
        statusCode: 429,
        retryAfterSec: 30,
      },
    ],
    [
      'rate_limited',
      429,
      undefined,
      {
        kind: 'FAILED',
        error: 'RATE_LIMITED',
        statusCode: 429,
        retryAfterSec: null,
      },
    ],
    [
      'timeout',
      undefined,
      undefined,
      {
        kind: 'FAILED',
        error: 'TIMEOUT',
        statusCode: null,
        retryAfterSec: null,
      },
    ],
    [
      'network',
      undefined,
      undefined,
      {
        kind: 'FAILED',
        error: 'NETWORK',
        statusCode: null,
        retryAfterSec: null,
      },
    ],
    [
      'too_large',
      undefined,
      undefined,
      {
        kind: 'FAILED',
        error: 'TOO_LARGE',
        statusCode: null,
        retryAfterSec: null,
      },
    ],
    [
      'bulkhead_full',
      undefined,
      undefined,
      {
        kind: 'FAILED',
        error: 'BULKHEAD_FULL',
        statusCode: null,
        retryAfterSec: null,
      },
    ],
    [
      'circuit_open',
      undefined,
      undefined,
      {
        kind: 'FAILED',
        error: 'CIRCUIT_OPEN',
        statusCode: null,
        retryAfterSec: null,
      },
    ],
  ] as const)(
    'UpstreamError %s',
    (reason: UpstreamFailure, status, retryAfter, want) => {
      expect(
        outcomeOfError(
          new UpstreamError('webhooks-out', reason, 'x', {
            status,
            retryAfter,
          }),
        ),
      ).toEqual(want);
    },
  );
  it('SsrfBlockedError (literal or at connect) is SSRF_BLOCKED', () => {
    expect(outcomeOfError(new SsrfBlockedError('blocked'))).toEqual({
      kind: 'FAILED',
      error: 'SSRF_BLOCKED',
      statusCode: null,
      retryAfterSec: null,
    });
  });
  it.each([
    ['EAI_AGAIN', 'DNS_UNAVAILABLE'],
    ['ETIMEOUT', 'DNS_UNAVAILABLE'],
    ['ENOTFOUND', 'NETWORK'],
    ['ECONNREFUSED', 'NETWORK'],
  ] as const)(
    'M7: a network failure caused by %s is %s (our resolver failing is LOCAL; an unknown customer domain stays the fault of the endpoint)',
    (code, error) => {
      // undici wraps the lookup error once more; the code can sit anywhere on the cause chain.
      const dns = Object.assign(
        new Error(`getaddrinfo ${code} hooks.example.test`),
        { code },
      );
      const wrapped = new UpstreamError('webhooks-out', 'network', 'x', {
        cause: new Error('connect failed', { cause: dns }),
      });
      expect(outcomeOfError(wrapped)).toEqual({
        kind: 'FAILED',
        error,
        statusCode: null,
        retryAfterSec: null,
      });
    },
  );
  it('any other error is a bug and is thrown, never recorded as a delivery failure', () => {
    expect(() => outcomeOfError(new TypeError('boom'))).toThrow('boom');
  });
});
