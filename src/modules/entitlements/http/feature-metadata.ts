import type { FeatureCatalogueData } from '../domain/feature-catalogue.js';

export const FEATURE_REQUIREMENTS = 'entitlements:requirements';
/** Một lần `requireEnabled` trên class hoặc method; interceptor và inventory đọc bằng `getAllAndMerge` (class + method). */
export type FeatureRequirement = {
  readonly catalogue: FeatureCatalogueData;
  readonly keys: readonly string[];
};
