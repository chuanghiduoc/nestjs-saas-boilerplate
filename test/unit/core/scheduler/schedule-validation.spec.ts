import { describe, expect, it } from 'vitest';
import {
  canonicalTimezone,
  isValidCron,
  minGapSec,
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

describe('canonicalTimezone', () => {
  it('canonicalizes IANA names and rejects offsets and unknown zones', () => {
    expect(canonicalTimezone('utc')).toBe('UTC');
    // ICU có thể trả tên canonical cũ (`Asia/Saigon`): vẫn là tên IANA hợp lệ.
    expect(canonicalTimezone('Asia/Ho_Chi_Minh')).toMatch(/^Asia\//);
    expect(canonicalTimezone('+07:00')).toBeUndefined();
    expect(canonicalTimezone('Mars/Base')).toBeUndefined();
  });
});

describe('isValidCron', () => {
  it('accepts what cron-parser accepts', () => {
    expect(isValidCron('*/10 * * * *')).toBe(true);
    expect(isValidCron('*/10 * * *')).toBe(false);
    expect(isValidCron('61 * * * *')).toBe(false);
  });
});
