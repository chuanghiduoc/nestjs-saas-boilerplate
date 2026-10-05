import type { ResetPeriod } from './feature-catalogue.js';

/**
 * Một lần tiêu thụ (spec §9.1): `orgId` của org đã tiêu thụ (receipt lưu lại rồi trả ở context org khác bị từ chối, không
 * trừ nhầm bộ đếm của org kia); `periodStart` ISO UTC của dòng kỳ (`null` với kỳ NONE); `release` trả đúng dòng đó.
 */
export type QuotaReceipt = {
  readonly orgId: string;
  readonly featureKey: string;
  readonly periodStart: string | null;
  readonly amount: number;
};
/** Kết quả nghiệp vụ, không phải exception: `consumeOrThrow` mới đổi `EXCEEDED` thành `422 quota_exceeded`. */
export type ConsumeResult =
  | { readonly kind: 'CONSUMED'; readonly receipt: QuotaReceipt }
  | {
      readonly kind: 'EXCEEDED';
      readonly limit: number;
      readonly used: number;
    };
/** Kỳ của bộ đếm (spec §11 `periodOf`): mốc thời gian do câu SQL tính từ `now()` của DB, không ở app. */
export type QuotaPeriod =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'MONTH'; readonly timezone: string };

export function periodOf(
  resetPeriod: ResetPeriod,
  timezone: string,
): QuotaPeriod {
  switch (resetPeriod) {
    case 'NONE':
      return { kind: 'NONE' };
    case 'MONTH':
      return { kind: 'MONTH', timezone };
    default: {
      const unknown: never = resetPeriod;
      throw new Error(`unknown reset period ${String(unknown)}`);
    }
  }
}

/**
 * Lần tiêu thụ thành công này đưa `used` chạm trần (S4-D16): `used ≥ max` và trước nó `used − amount < max`. Hai consume
 * song song tuần tự hoá trên khoá dòng, nên mỗi lần chuyển sang "chạm trần" đúng một consume thoả điều kiện (E-10);
 * chạm lại sau một `release` là một lần chuyển mới và phát lại (review M3, không khử trùng theo kỳ).
 */
export const reachedLimit = (
  max: number,
  used: number,
  amount: number,
): boolean => used >= max && used - amount < max;
