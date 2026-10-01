import type { PlanSource } from '../constants.js';

/** Một dòng `org_entitlements` + key gói + `now()` của DB (mốc hết hạn override của 4C, spec §8.4). */
export type SnapshotRow = {
  version: number;
  planKey: string;
  planSource: PlanSource;
  planAssignedAt: Date;
  now: Date;
};

/** Kết quả của lưới dự phòng: chèn, đã có dòng, hoặc org đã mất (purge trước khi event tới). */
export type ProvisionResult =
  | { kind: 'INSERTED'; version: number }
  | { kind: 'ALREADY_PROVISIONED' }
  | { kind: 'ORG_GONE' };

/** Mọi phương thức chạy trong org context của caller (RLS); SQL vẫn ghi `org_id = app_current_org()`. */
export abstract class OrgEntitlementRepository {
  /** Một câu theo PK; không có dòng → `undefined` (service ném `EntitlementsRowMissingError`). */
  abstract readSnapshot(): Promise<SnapshotRow | undefined>;
  /** Participant tạo org: chèn `DEFAULT`; không `ON CONFLICT` (org vừa tạo không thể có dòng). Gói thiếu → ném. */
  abstract insertDefault(planKey: string): Promise<{ version: number }>;
  /** Subscriber dự phòng: `ON CONFLICT (org_id) DO NOTHING`, chỉ chèn khi org còn (join `organizations`, không bắt 23503). */
  abstract insertDefaultIfAbsent(planKey: string): Promise<ProvisionResult>;
}
