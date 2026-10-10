/** ±10% quanh bước lịch (spec SP6 §7.2): các delivery cùng lỗi không dồn về cùng một giây. */
export const RETRY_JITTER_RATIO = 0.1;
const MS_PER_SEC = 1000;

/** Bước lịch sau khi lần thử thứ `attemptInCycle` (tính từ 1) thất bại; `undefined` = hết lịch (k bước → k + 1 lần thử). */
export function scheduledDelaySec(
  schedule: readonly number[],
  attemptInCycle: number,
): number | undefined {
  if (!Number.isInteger(attemptInCycle) || attemptInCycle < 1)
    throw new Error(
      `attemptInCycle must be a positive integer, got ${attemptInCycle}`,
    );
  return schedule[attemptInCycle - 1];
}

/** `sec` giây ± `RETRY_JITTER_RATIO`, ra mili giây nguyên ≥ 0; `random()` phải trong [0, 1) như `Math.random`. */
export function jitteredMs(sec: number, random: () => number): number {
  const r = random();
  if (!(r >= 0 && r < 1))
    throw new Error(`random() must return a value in [0, 1), got ${r}`);
  return Math.max(
    0,
    Math.round(sec * MS_PER_SEC * (1 + (r * 2 - 1) * RETRY_JITTER_RATIO)),
  );
}

/**
 * Trễ của lần hẹn sau lỗi của endpoint: `max(lịch có jitter, Retry-After)`. `retryAfterSec` đã được `HttpClient` chặn trần
 * `RESILIENCE_RETRY_AFTER_MAX_SEC` (`parseRetryAfterSec`), là 0 với HTTP-date đã qua; `null` khi không có header.
 */
export function retryDelayMs(o: {
  scheduleSec: number;
  retryAfterSec: number | null;
  random: () => number;
}): number {
  const scheduled = jitteredMs(o.scheduleSec, o.random);
  return o.retryAfterSec === null
    ? scheduled
    : Math.max(scheduled, o.retryAfterSec * MS_PER_SEC);
}
