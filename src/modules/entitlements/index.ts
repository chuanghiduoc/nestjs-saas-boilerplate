import { markModuleLoaded } from '../../core/config/index.js';

// Composition (spec SP7 §6.2 bước 4): import module này là đăng ký config, queue, job, cron của nó.
markModuleLoaded('entitlements');

export { EntitlementsModule } from './entitlements.module.js';
export {
  entitlementsConfig,
  type EntitlementsConfig,
} from './entitlements.config.js';
export {
  EntitlementsErrors,
  EntitlementsContextError,
  UnknownPlanError,
  EntitlementsRowMissingError,
  EntitlementsVersionSkewError,
  UnknownFeatureError,
  FeatureKindMismatchError,
  QuotaReleaseUnderflowError,
} from './errors.js';
export { PlanChangedEvent } from './events.js';
export { EntitlementPermissions } from './permissions.js';
export { BoilerplateFeatures } from './features.js';
export {
  defineFeatureCatalogue,
  type FeatureCatalogue,
} from './http/decorators.js';
export { FeatureCatalogueContributor } from './application/entitlement-catalogue.registry.js';
export {
  UNLIMITED,
  type FeatureCatalogueDef,
} from './domain/feature-catalogue.js';
export {
  definePlanCatalogue,
  type PlanCatalogue,
  type PlanCatalogueDef,
} from './domain/plan-catalogue.js';
export {
  Entitlements,
  type EntitlementSnapshot,
} from './application/entitlements.service.js';
export type { EffectiveValue, Limit } from './domain/effective-value.js';
export { PLAN_SOURCES, type PlanSource } from './constants.js';
export {
  PlanAssignments,
  type AssignmentResult,
} from './application/plan-assignments.service.js';
export type {
  AssignPlanCommand,
  AssignmentCause,
} from './domain/plan-assignment.js';
