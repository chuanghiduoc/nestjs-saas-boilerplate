import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_ERRORS,
  DELIVERY_STATUSES,
  LAST_ERRORS,
  TERMINAL_DELIVERY_STATUSES,
  classifyAttempt,
  isTerminalDelivery,
  localRetryLeft,
  transitionDelivery,
  type DeliveryEvent,
  type DeliveryStatus,
} from '../../../../src/modules/integrations/domain/webhook-delivery.js';

const EVENTS: readonly DeliveryEvent[] = [
  { kind: 'CLAIM', endpointAvailable: true },
  { kind: 'CLAIM', endpointAvailable: false },
  { kind: 'DEFER' },
  { kind: 'DELIVERED' },
  { kind: 'FAILED', blame: 'ENDPOINT', retryLeft: true },
  { kind: 'FAILED', blame: 'ENDPOINT', retryLeft: false },
  { kind: 'FAILED', blame: 'LOCAL', retryLeft: true },
  { kind: 'FAILED', blame: 'LOCAL', retryLeft: false },
  { kind: 'REQUEUE' },
  { kind: 'UNCLAIM' },
];
/**
 * Bảng chuyển của spec §7.2 + R-X35: `from|event → to,attemptsTotal,cycleBase,localFailures`; ô không có là bị từ chối.
 * `retryLeft` của ENDPOINT = còn bước lịch; của LOCAL = `localRetryLeft(local_failures, INTEGRATIONS_MAX_LOCAL_FAILURES)`.
 */
const ALLOWED: Record<string, string> = {
  'PENDING|CLAIM:true': 'SENDING,INCREMENT,KEEP,KEEP',
  'RETRY_SCHEDULED|CLAIM:true': 'SENDING,INCREMENT,KEEP,KEEP',
  'PENDING|CLAIM:false': 'CANCELLED,INCREMENT,KEEP,KEEP',
  'RETRY_SCHEDULED|CLAIM:false': 'CANCELLED,INCREMENT,KEEP,KEEP',
  'PENDING|DEFER': 'PENDING,KEEP,KEEP,KEEP',
  'RETRY_SCHEDULED|DEFER': 'RETRY_SCHEDULED,KEEP,KEEP,KEEP',
  'SENDING|DELIVERED': 'SUCCEEDED,KEEP,KEEP,KEEP',
  // M1: kill switch bật giữa claim và gửi — trả claim lại, không tiêu bước lịch, không đếm lỗi của ta.
  'SENDING|UNCLAIM': 'RETRY_SCHEDULED,KEEP,INCREMENT,KEEP',
  'SENDING|FAILED:ENDPOINT:true': 'RETRY_SCHEDULED,KEEP,KEEP,KEEP',
  'SENDING|FAILED:ENDPOINT:false': 'EXHAUSTED,KEEP,KEEP,KEEP',
  'SENDING|FAILED:LOCAL:true': 'RETRY_SCHEDULED,KEEP,INCREMENT,INCREMENT',
  'SENDING|FAILED:LOCAL:false': 'EXHAUSTED,KEEP,INCREMENT,INCREMENT',
  'SUCCEEDED|REQUEUE': 'PENDING,KEEP,RESET_TO_ATTEMPTS,RESET',
  'EXHAUSTED|REQUEUE': 'PENDING,KEEP,RESET_TO_ATTEMPTS,RESET',
  'CANCELLED|REQUEUE': 'PENDING,KEEP,RESET_TO_ATTEMPTS,RESET',
};
const label = (e: DeliveryEvent): string => {
  switch (e.kind) {
    case 'CLAIM':
      return `CLAIM:${e.endpointAvailable}`;
    case 'FAILED':
      return `FAILED:${e.blame}:${e.retryLeft}`;
    case 'DEFER':
    case 'DELIVERED':
    case 'REQUEUE':
    case 'UNCLAIM':
      return e.kind;
  }
};
const CELLS = DELIVERY_STATUSES.flatMap((s) =>
  EVENTS.map((e) => [s, e] as const),
);

describe('webhook delivery state machine (spec SP6 §7.2)', () => {
  it.each(CELLS)('%s × %j', (from: DeliveryStatus, e: DeliveryEvent) => {
    const t = transitionDelivery(from, e);
    const want = ALLOWED[`${from}|${label(e)}`];
    if (want === undefined) expect(t).toEqual({ ok: false });
    else
      expect(
        t.ok
          ? `${t.effect.to},${t.effect.attemptsTotal},${t.effect.cycleBase},${t.effect.localFailures}`
          : 'refused',
      ).toBe(want);
  });
  it.each([
    [0, 5, true],
    [3, 5, true],
    [4, 5, false],
    [0, 1, false],
  ])(
    'R-X35: localRetryLeft(%i failures before, max %i) = %s (the max-th local failure exhausts)',
    (before, max, want) => {
      expect(localRetryLeft(before, max)).toBe(want);
    },
  );
  it.each([
    [-1, 5],
    [0, 0],
    [1.5, 5],
  ])('localRetryLeft refuses (%d, %d)', (before, max) => {
    expect(() => localRetryLeft(before, max)).toThrow(/localRetryLeft/);
  });
  it('terminal statuses are exactly SUCCEEDED, EXHAUSTED and CANCELLED', () => {
    expect(DELIVERY_STATUSES.filter(isTerminalDelivery)).toEqual([
      ...TERMINAL_DELIVERY_STATUSES,
    ]);
    expect(TERMINAL_DELIVERY_STATUSES).toEqual([
      'SUCCEEDED',
      'EXHAUSTED',
      'CANCELLED',
    ]);
  });
});

describe('classifyAttempt (spec SP6 §7.2, S6-A49, W-34)', () => {
  it('covers every last_error except ENDPOINT_UNAVAILABLE, which is a claim branch, never an attempt', () => {
    expect([...ATTEMPT_ERRORS].sort()).toEqual(
      LAST_ERRORS.filter((e) => e !== 'ENDPOINT_UNAVAILABLE').sort(),
    );
  });
  it.each([
    ['TIMEOUT', 'ENDPOINT'],
    ['NETWORK', 'ENDPOINT'],
    ['SERVER_ERROR', 'ENDPOINT'],
    ['CLIENT_ERROR', 'ENDPOINT'],
    ['REDIRECT', 'ENDPOINT'],
    ['RATE_LIMITED', 'ENDPOINT'],
    ['SSRF_BLOCKED', 'ENDPOINT'],
    ['TOO_LARGE', 'ENDPOINT'],
    ['BULKHEAD_FULL', 'LOCAL'],
    ['CIRCUIT_OPEN', 'LOCAL'],
    ['LEASE_EXPIRED', 'LOCAL'],
    ['SECRET_UNAVAILABLE', 'LOCAL'],
    ['DNS_UNAVAILABLE', 'LOCAL'],
  ] as const)('%s is the fault of the %s', (error, blame) => {
    expect(classifyAttempt(error)).toBe(blame);
  });
  it('the table above covers every attempt error (a missing value in the source is a compile error)', () => {
    expect(ATTEMPT_ERRORS).toHaveLength(13);
  });
});
