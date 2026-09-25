import { describe, expect, it } from 'vitest';
import {
  ScheduleComputationError,
  isValidCron,
  minGapSec,
  normalizeTimezone,
} from '../../../../src/core/scheduler/schedule-validation.js';

/** Cố định mốc bắt đầu để năm quét chứa cả spring-forward (2026-03-08) lẫn fall-back (2026-11-01) của New York. */
const FROM = Date.UTC(2026, 0, 1);
const MIN_SEC = 300;
/** Ngân sách thời gian rộng cho CI; quét cả năm `*\/5` mất ~1s (review Task 11). */
const BUDGET_MS = 100;

describe('minGapSec', () => {
  it('catches runs squeezed together by a DST spring-forward', () => {
    // 01:59 EST (06:59Z) → 03:00 EDT (07:00Z) ngày 2026-03-08: cách 60s, lưới giờ×phút thấy 3540s.
    expect(minGapSec('0,59 1,3 * * *', 'America/New_York', FROM)).toBe(60);
  });

  it('keeps a normal hourly cron in a DST zone acceptable', () => {
    expect(
      minGapSec('0 * * * *', 'America/New_York', FROM),
    ).toBeGreaterThanOrEqual(MIN_SEC);
  });

  it('handles the repeated hour of a DST fall-back', () => {
    // 2026-11-01: 01:00–01:59 lặp lại; khoảng thật vẫn ≥ 30 phút.
    expect(
      minGapSec('0,30 1 * * *', 'America/New_York', FROM),
    ).toBeGreaterThanOrEqual(MIN_SEC);
  });

  it('fails closed when cron-parser cannot compute runs around an offset change', () => {
    // cron-parser 5.10.1 ném "loop limit exceeded" quanh DST của các zone này.
    for (const [cron, tz] of [
      ['0 * * * *', 'Pacific/Chatham'],
      ['0 2 * * *', 'Australia/Lord_Howe'],
    ] as const)
      expect(() => minGapSec(cron, tz, FROM)).toThrow(ScheduleComputationError);
  });

  it('is unaffected by DST in UTC', () => {
    expect(minGapSec('0,59 1,3 * * *', 'UTC', FROM)).toBe(3540);
  });

  it('catches clustered minutes that sampling a few runs would miss', () => {
    expect(minGapSec('0,1,20,40 8 * * 1', 'UTC', FROM)).toBe(60);
  });

  it('stays cheap for a dense cron in a DST zone', () => {
    const t = performance.now();
    expect(minGapSec('*/5 * * * *', 'America/New_York', FROM)).toBe(300);
    expect(performance.now() - t).toBeLessThan(BUDGET_MS);
  });
});

describe('normalizeTimezone', () => {
  it('keeps the name the user gave, fixing only letter case', () => {
    // ICU chuẩn hoá thành tên cũ `Asia/Saigon`; phải giữ nguyên tên người dùng nhập.
    expect(normalizeTimezone('Asia/Ho_Chi_Minh')).toBe('Asia/Ho_Chi_Minh');
    expect(normalizeTimezone('america/new_york')).toBe('America/New_York');
    expect(normalizeTimezone('utc')).toBe('UTC');
  });

  it('rejects offsets and unknown zones', () => {
    expect(normalizeTimezone('+07:00')).toBeUndefined();
    expect(normalizeTimezone('Mars/Base')).toBeUndefined();
  });
});

describe('isValidCron', () => {
  it('accepts what cron-parser accepts', () => {
    expect(isValidCron('*/10 * * * *')).toBe(true);
    expect(isValidCron('*/10 * * *')).toBe(false);
    expect(isValidCron('61 * * * *')).toBe(false);
  });
});
