import { describe, expect, it } from 'vitest';
import {
  RETRY_JITTER_RATIO,
  jitteredMs,
  retryDelayMs,
  scheduledDelaySec,
} from '../../../../src/modules/integrations/domain/retry-schedule.js';

const SCHEDULE = [5, 300, 1800];
const low = () => 0;
const mid = () => 0.5;
const high = () => 0.999_999;

describe('retry schedule (spec SP6 §7.2, §11.4)', () => {
  it('attempt n of the cycle waits schedule[n-1]; a schedule of k steps allows k+1 attempts', () => {
    expect(scheduledDelaySec(SCHEDULE, 1)).toBe(5);
    expect(scheduledDelaySec(SCHEDULE, 3)).toBe(1800);
    expect(scheduledDelaySec(SCHEDULE, 4)).toBeUndefined();
  });
  it.each([0, -1, 1.5])('refuses attempt %d', (n) => {
    expect(() => scheduledDelaySec(SCHEDULE, n)).toThrow(/attemptInCycle/);
  });
  it('jitter stays within ±10% and is integer milliseconds', () => {
    expect(jitteredMs(100, mid)).toBe(100_000);
    expect(jitteredMs(100, low)).toBe(100_000 * (1 - RETRY_JITTER_RATIO));
    expect(jitteredMs(100, high)).toBeLessThanOrEqual(
      100_000 * (1 + RETRY_JITTER_RATIO),
    );
    expect(Number.isInteger(jitteredMs(7, high))).toBe(true);
  });
  it.each([-0.1, 1, Number.NaN])(
    'refuses a random value %d outside [0, 1)',
    (r) => {
      expect(() => jitteredMs(5, () => r)).toThrow(/random/);
    },
  );
  it('Review Focus 3: Retry-After is a floor over the jittered schedule; absent or zero leaves the schedule', () => {
    expect(
      retryDelayMs({ scheduleSec: 5, retryAfterSec: 30, random: mid }),
    ).toBe(30_000);
    expect(
      retryDelayMs({ scheduleSec: 60, retryAfterSec: 30, random: mid }),
    ).toBe(60_000);
    expect(
      retryDelayMs({ scheduleSec: 5, retryAfterSec: null, random: mid }),
    ).toBe(5_000);
    expect(
      retryDelayMs({ scheduleSec: 5, retryAfterSec: 0, random: mid }),
    ).toBe(5_000);
  });
});
