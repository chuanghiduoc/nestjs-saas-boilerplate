import type { PlanSource } from '../constants.js';
import type { CurrentAssignment } from '../domain/plan-assignment.js';

/** Override còn hạn của org trong câu snapshot (spec §8.4, 4C): hết hạn đã lọc ở SQL bằng `expires_at > now()`. */
export type SnapshotOverride = {
  featureKey: string;
  flagValue: boolean | null;
  limitValue: number | null;
  expiresAt: Date | null;
};
/** Một dòng `org_entitlements` + key gói + `now()` của DB (mốc hết hạn override) + override còn hạn, sắp theo key. */
export type SnapshotRow = {
  version: number;
  planKey: string;
  planSource: PlanSource;
  planAssignedAt: Date;
  now: Date;
  overrides: readonly SnapshotOverride[];
};

/** Kết quả của lưới dự phòng: chèn, đã có dòng, hoặc org đã mất (purge trước khi event tới). */
export type ProvisionResult =
  | { kind: 'INSERTED'; version: number }
  | { kind: 'ALREADY_PROVISIONED' }
  | { kind: 'ORG_GONE' };

/** Dòng đã khoá + gói đích (`null` khi key không có trong bảng `plans`). */
export type AssignmentRow = {
  current: CurrentAssignment;
  target: { id: string; key: string; retired: boolean } | null;
};
export type AppliedAssignment = {
  planId: string;
  source: 'BILLING' | 'PLATFORM_ADMIN';
  sourceRef: string | null;
  reason: string | null;
  billingSequence: bigint | null;
};

/** Phần nội bộ của dòng gốc cho view admin (spec §12.2): không bao giờ ra API tenant. `now` = `now()` của transaction. */
export type AdminRootRow = {
  version: number;
  sourceRef: string | null;
  reason: string | null;
  lastBillingSeq: bigint | null;
  now: Date;
};

/** Mọi phương thức chạy trong org context của caller (RLS); SQL vẫn ghi `org_id = app_current_org()`. */
export abstract class OrgEntitlementRepository {
  /** Một câu theo PK; không có dòng → `undefined` (service ném `EntitlementsRowMissingError`). */
  abstract readSnapshot(): Promise<SnapshotRow | undefined>;
  /** Participant tạo org: chèn `DEFAULT`; không `ON CONFLICT` (org vừa tạo không thể có dòng). Gói thiếu → ném. */
  abstract insertDefault(planKey: string): Promise<{ version: number }>;
  /** Subscriber dự phòng: `ON CONFLICT (org_id) DO NOTHING`, chỉ chèn khi org còn (join `organizations`, không bắt 23503). */
  abstract insertDefaultIfAbsent(planKey: string): Promise<ProvisionResult>;
  /**
   * Khoá `FOR NO KEY UPDATE` chỉ trên dòng `org_entitlements` rồi tra `plans` (spec §10.2 bước 2), cả hai trước câu ghi đầu
   * tiên; không có dòng → `undefined`; gói đích lạ → `target: null`.
   */
  abstract lockForAssignment(
    targetPlanKey: string,
  ): Promise<AssignmentRow | undefined>;
  /** Câu APPLIED: đổi gói/nguồn, `last_billing_seq = COALESCE(seq, last_billing_seq)`, `version + 1`; trả version mới. */
  abstract applyAssignment(a: AppliedAssignment): Promise<number>;
  /** UNCHANGED/REJECTED_RETIRED của BILLING: chỉ ghi nhận `last_billing_seq` (không version, không event). */
  abstract recordBillingSequence(sequence: bigint): Promise<void>;
  /** Một câu theo PK, không khoá; không có dòng → `undefined` (route admin trả 404). */
  abstract readAdminRoot(): Promise<AdminRootRow | undefined>;
}
