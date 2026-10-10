/** Dòng gốc đã khoá `FOR NO KEY UPDATE` + `clock_timestamp()` đọc SAU khoá (mốc "expiresAt phải sau lúc này", 4C). */
export type LockedRoot = { version: number; now: Date };
export type OverrideWrite = {
  featureId: string;
  flagValue: boolean | null;
  limitValue: number | null;
  reason: string;
  expiresAt: Date | null;
};
/** Một override của org, kể cả đã hết hạn (view admin, spec §12.2). */
export type OverrideRow = {
  featureKey: string;
  flagValue: boolean | null;
  limitValue: number | null;
  reason: string;
  expiresAt: Date | null;
  updatedAt: Date;
};

/**
 * Ghi override (spec §7.4): mọi phương thức chạy trong UnitOfWork + OrgScope của caller (RLS), SAU `lockRoot()` trong cùng
 * transaction: override là con của aggregate `org_entitlements`, nên mọi ghi tuần tự hoá trên khoá dòng gốc (E-7).
 */
export abstract class OverrideRepository {
  /** Khoá CHỈ dòng `org_entitlements` (không JOIN, bài học C2 của 4A); không có dòng → `undefined`. */
  abstract lockRoot(): Promise<LockedRoot | undefined>;
  /** Dòng hiện tại của một tính năng (kể cả đã hết hạn), đọc dưới khoá gốc: so với trạng thái yêu cầu (PUT idempotent). */
  abstract findOne(featureId: string): Promise<OverrideRow | undefined>;
  /** `INSERT … ON CONFLICT (org_id, feature_id) DO UPDATE`, `updated_at = clock_timestamp()`. */
  abstract upsert(o: OverrideWrite): Promise<void>;
  /** `true` khi có dòng bị xoá. */
  abstract remove(featureId: string): Promise<boolean>;
  /** `version + 1` của dòng gốc đã khoá; trả version mới (ETag, `aggregate.version`). */
  abstract bumpVersion(): Promise<number>;
  abstract listAll(): Promise<OverrideRow[]>;
}
