import type { FeatureKind, ResetPeriod } from '../domain/feature-catalogue.js';

export type FeatureRow = {
  id: string;
  key: string;
  kind: FeatureKind;
  resetPeriod: ResetPeriod | null;
  deprecated: boolean;
};
export type PlanRow = { key: string; retired: boolean };
/** Hai bảng tra cứu global (không RLS), `app_user` chỉ SELECT; đọc lúc boot. */
export abstract class EntitlementCatalogueReader {
  abstract features(): Promise<FeatureRow[]>;
  abstract plans(): Promise<PlanRow[]>;
  /** Một câu `date_trunc('month', now(), tz)`: Postgres nhận múi giờ hay không (tzdata của DB khác Intl của Node, M6). */
  abstract probeTimezone(timezone: string): Promise<void>;
  /** `to_regclass('public.org_entitlement_overrides') IS NOT NULL`: migration 4C đã chạy chưa (chỉ đọc catalog, không chạm RLS). */
  abstract probeOverrides(): Promise<boolean>;
}
