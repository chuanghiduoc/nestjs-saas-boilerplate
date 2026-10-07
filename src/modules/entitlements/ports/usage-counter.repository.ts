import type { QuotaPeriod } from '../domain/quota.js';

/** Dòng sau một consume thành công; `periodStart` là `null` với kỳ NONE. */
export type ConsumedCounter = {
  readonly id: string;
  readonly used: number;
  readonly version: number;
  readonly periodStart: Date | null;
};
/** Usage cho API tenant (spec §12.1): ranh giới kỳ MONTH hiện tại và `used` theo key (kỳ hiện tại hoặc NONE). */
export type CurrentUsage = {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly used: ReadonlyMap<string, number>;
};

/** Mọi phương thức chạy trong transaction + org context của caller (RLS); SQL vẫn ghi `org_id = app_current_org()`. */
export abstract class UsageCounterRepository {
  /** Một câu `INSERT … ON CONFLICT … DO UPDATE … WHERE` (spec §9.2); `max: null` = UNLIMITED (không WHERE); 0 dòng → `undefined`. */
  abstract consume(i: {
    featureId: string;
    period: QuotaPeriod;
    amount: number;
    max: number | null;
  }): Promise<ConsumedCounter | undefined>;
  /** `used` của dòng kỳ hiện tại, 0 khi chưa có dòng; chỉ đọc (dùng cho `EXCEEDED`). */
  abstract usedNow(i: {
    featureId: string;
    period: QuotaPeriod;
  }): Promise<number>;
  /** Trả `amount` về đúng dòng kỳ (spec §9.3); 0 dòng (không có dòng hoặc `used < amount`) → `undefined`; trả `used` mới. */
  abstract release(i: {
    featureId: string;
    periodStart: string | null;
    amount: number;
  }): Promise<number | undefined>;
  abstract currentUsage(timezone: string): Promise<CurrentUsage>;
}
