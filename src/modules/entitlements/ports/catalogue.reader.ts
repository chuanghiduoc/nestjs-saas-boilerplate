import type { FeatureKind, ResetPeriod } from '../domain/feature-catalogue.js';

export type FeatureRow = {
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
}
