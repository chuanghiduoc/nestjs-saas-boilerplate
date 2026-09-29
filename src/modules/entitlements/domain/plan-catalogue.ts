import { ENTITLEMENT_VALUE_MAX, PLAN_KEY_PATTERN } from '../constants.js';
import {
  UNLIMITED,
  isCount,
  isNumericValue,
  type FeatureEntry,
  type MergedFeatures,
  type NumericValue,
} from './feature-catalogue.js';

export type PlanValue = boolean | NumericValue;
export type PlanDef = {
  readonly retired?: boolean;
  readonly values: Readonly<Record<string, PlanValue>>;
};
export type PlanCatalogueDef = {
  readonly defaultPlan: string;
  readonly plans: Readonly<Record<string, PlanDef>>;
};
export type PlanEntry = {
  readonly key: string;
  readonly retired: boolean;
  readonly values: ReadonlyMap<string, PlanValue>;
};
export type PlanCatalogue = {
  readonly defaultPlan: string;
  readonly plans: ReadonlyMap<string, PlanEntry>;
};

export class PlanCatalogueError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid plan catalogue: ${problems.join('; ')}`);
    this.name = 'PlanCatalogueError';
  }
}

/**
 * Catalogue gói của dự án (spec §8.2, S4-D2): giá trị gói chỉ ở code, DB chỉ có bảng tra cứu `plans`. Hàm chỉ chuẩn hoá;
 * mọi kiểm cần catalogue tính năng gộp chạy lúc boot (`validatePlanCatalogue`, registry) để lỗi được liệt kê một lần.
 */
export function definePlanCatalogue(def: PlanCatalogueDef): PlanCatalogue {
  return {
    defaultPlan: def.defaultPlan,
    plans: new Map(
      Object.entries(def.plans).map(([key, p]) => [
        key,
        {
          key,
          retired: p.retired === true,
          values: new Map(Object.entries(p.values)),
        },
      ]),
    ),
  };
}

function planValueProblems(
  plan: string,
  f: FeatureEntry,
  value: unknown,
): string[] {
  switch (f.kind) {
    case 'FLAG':
      return typeof value === 'boolean'
        ? []
        : [`plan "${plan}": "${f.key}" is a FLAG and needs true or false`];
    case 'LIMIT':
    case 'QUOTA':
      if (value === UNLIMITED) return [];
      if (!isNumericValue(value) || value === UNLIMITED || !isCount(value.max))
        return [
          `plan "${plan}": "${f.key}" needs UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`,
        ];
      return value.max < f.minimum
        ? [
            `plan "${plan}": "${f.key}" max ${value.max} is below minimum ${f.minimum}`,
          ]
        : [];
    default: {
      const unknownKind: never = f;
      return [
        `plan "${plan}": feature of unknown kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      ];
    }
  }
}

/** EC-7 (spec §8.2 "Luật kiểm lúc boot"). Rỗng = hợp lệ. */
export function validatePlanCatalogue(
  catalogue: PlanCatalogue,
  features: MergedFeatures,
): string[] {
  const problems: string[] = [];
  const def = catalogue.plans.get(catalogue.defaultPlan);
  if (!def)
    problems.push(
      `defaultPlan "${catalogue.defaultPlan}" is not a declared plan`,
    );
  else if (def.retired)
    problems.push(`defaultPlan "${catalogue.defaultPlan}" is retired`);
  for (const plan of catalogue.plans.values()) {
    if (!PLAN_KEY_PATTERN.test(plan.key))
      problems.push(
        `plan "${plan.key}": key must match ${PLAN_KEY_PATTERN.source}`,
      );
    for (const [key, value] of plan.values) {
      const f = features.get(key);
      if (!f) problems.push(`plan "${plan.key}": unknown feature "${key}"`);
      else if (f.deprecated)
        problems.push(`plan "${plan.key}": feature "${key}" is deprecated`);
      else problems.push(...planValueProblems(plan.key, f, value));
    }
  }
  return problems;
}

/** EC-8: với mỗi gói, key của tính năng (không deprecated) mà gói không nhắc tới, tức đang dùng `fallback` (log INFO lúc boot). */
export function fallbackUsage(
  catalogue: PlanCatalogue,
  features: MergedFeatures,
): Record<string, string[]> {
  const active = [...features.values()]
    .filter((f) => !f.deprecated)
    .map((f) => f.key)
    .sort();
  return Object.fromEntries(
    [...catalogue.plans.values()].map((p) => [
      p.key,
      active.filter((k) => !p.values.has(k)),
    ]),
  );
}
