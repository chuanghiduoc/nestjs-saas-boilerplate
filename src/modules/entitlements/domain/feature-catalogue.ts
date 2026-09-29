import { ENTITLEMENT_VALUE_MAX, FEATURE_KEY_PATTERN } from '../constants.js';

export const FEATURE_KINDS = ['FLAG', 'LIMIT', 'QUOTA'] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];
export const RESET_PERIODS = ['NONE', 'MONTH'] as const;
export type ResetPeriod = (typeof RESET_PERIODS)[number];

/** Giá trị "không giới hạn" của LIMIT/QUOTA trong catalogue (không phải số, nên không lẫn với một trần thật). */
export const UNLIMITED: unique symbol = Symbol('entitlements.unlimited');
export type NumericValue = { readonly max: number } | typeof UNLIMITED;

type Common = { readonly description?: string; readonly deprecated?: boolean };
export type FlagFeatureDef = Common & {
  readonly kind: 'FLAG';
  readonly fallback: boolean;
};
export type LimitFeatureDef = Common & {
  readonly kind: 'LIMIT';
  readonly fallback: NumericValue;
  readonly minimum?: number;
};
export type QuotaFeatureDef = Common & {
  readonly kind: 'QUOTA';
  readonly resetPeriod: ResetPeriod;
  readonly fallback: NumericValue;
  readonly minimum?: number;
};
export type FeatureDef = FlagFeatureDef | LimitFeatureDef | QuotaFeatureDef;
export type FeatureCatalogueDef = Readonly<Record<string, FeatureDef>>;
/**
 * `K` là tham số riêng (mặc định = key của D) thay vì `Extract<keyof D, string>` viết thẳng trong `keys`: `keyof D` làm D
 * bất biến, nên `FeatureCatalogueData<D>` cụ thể không gán được cho `FeatureCatalogueData` (mặc định) mà registry và
 * `mergeFeatureCatalogues` nhận. Tách K ra, cả D lẫn K đều hiệp biến.
 */
export type FeatureCatalogueData<
  D extends FeatureCatalogueDef = FeatureCatalogueDef,
  K extends string = Extract<keyof D, string>,
> = {
  readonly features: D;
  readonly keys: readonly K[];
};
/** Mục đã chuẩn hoá của catalogue gộp: `minimum` luôn có với LIMIT/QUOTA (mặc định 0), `deprecated` luôn là boolean. */
export type FeatureEntry =
  | {
      readonly key: string;
      readonly kind: 'FLAG';
      readonly fallback: boolean;
      readonly deprecated: boolean;
    }
  | {
      readonly key: string;
      readonly kind: 'LIMIT';
      readonly fallback: NumericValue;
      readonly minimum: number;
      readonly deprecated: boolean;
    }
  | {
      readonly key: string;
      readonly kind: 'QUOTA';
      readonly resetPeriod: ResetPeriod;
      readonly fallback: NumericValue;
      readonly minimum: number;
      readonly deprecated: boolean;
    };
export type MergedFeatures = ReadonlyMap<string, FeatureEntry>;

export class FeatureCatalogueError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid feature catalogue: ${problems.join('; ')}`);
    this.name = 'FeatureCatalogueError';
  }
}

/** Khai báo `as const`: K là union key của CHÍNH catalogue (sai key ở `requireEnabled`/`key()` là lỗi compile). */
export function featureCatalogueData<const D extends FeatureCatalogueDef>(
  features: D,
): FeatureCatalogueData<D> {
  const keys = Object.keys(features).filter(
    (k): k is Extract<keyof D, string> => k in features,
  );
  return { features, keys };
}

/** Số nguyên an toàn trong `[min, ENTITLEMENT_VALUE_MAX]` (loại NaN, Infinity, số thập phân, số âm). */
export const isCount = (n: unknown, min = 0): n is number =>
  typeof n === 'number' &&
  Number.isSafeInteger(n) &&
  n >= min &&
  n <= ENTITLEMENT_VALUE_MAX;
/** `UNLIMITED` hoặc đúng một trường `max` (không nhận thêm trường: lỗi gõ `{ max: 1, min: 0 }` không lọt). */
export const isNumericValue = (v: unknown): v is NumericValue =>
  v === UNLIMITED ||
  (typeof v === 'object' &&
    v !== null &&
    Object.keys(v).length === 1 &&
    'max' in v);

const numericMessage = `must be UNLIMITED or { max: integer in [0, ${ENTITLEMENT_VALUE_MAX}] }`;

function numericProblems(
  key: string,
  fallback: unknown,
  minimum: unknown,
): string[] {
  const out: string[] = [];
  const min = minimum ?? 0;
  if (!isCount(min))
    out.push(
      `"${key}": minimum must be an integer in [0, ${ENTITLEMENT_VALUE_MAX}]`,
    );
  if (fallback === UNLIMITED) return out;
  if (
    !isNumericValue(fallback) ||
    fallback === UNLIMITED ||
    !isCount(fallback.max)
  )
    out.push(`"${key}": fallback ${numericMessage}`);
  else if (isCount(min) && fallback.max < min)
    out.push(`"${key}": fallback ${fallback.max} is below minimum ${min}`);
  return out;
}

/** Kiểm từng mục ở runtime (dự án có thể viết JS hoặc cast): mọi vi phạm được liệt kê, không dừng ở cái đầu. */
function entryProblems(key: string, f: FeatureDef): string[] {
  switch (f.kind) {
    case 'FLAG':
      return [
        ...(typeof f.fallback === 'boolean'
          ? []
          : [`"${key}": a FLAG fallback must be a boolean`]),
        ...('resetPeriod' in f
          ? [`"${key}": only QUOTA declares resetPeriod`]
          : []),
        ...('minimum' in f
          ? [`"${key}": only LIMIT and QUOTA declare minimum`]
          : []),
      ];
    case 'LIMIT':
      return [
        ...numericProblems(key, f.fallback, f.minimum),
        ...('resetPeriod' in f
          ? [`"${key}": only QUOTA declares resetPeriod`]
          : []),
      ];
    case 'QUOTA':
      return [
        ...numericProblems(key, f.fallback, f.minimum),
        ...((RESET_PERIODS as readonly unknown[]).includes(f.resetPeriod)
          ? []
          : [`"${key}": QUOTA needs resetPeriod NONE or MONTH`]),
      ];
    default: {
      const unknownKind: never = f;
      return [
        `"${key}": unknown kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      ];
    }
  }
}

/** Mọi vi phạm EC-1…EC-6 trên tập catalogue (spec §8.1 "Kiểm catalogue"). Rỗng = hợp lệ. */
export function featureCatalogueProblems(
  defs: readonly FeatureCatalogueData[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const def of defs)
    for (const key of Object.keys(def.features)) {
      const f = def.features[key];
      if (!f) continue;
      if (seen.has(key))
        problems.push(`duplicate feature key "${key}" in two catalogues`);
      seen.add(key);
      if (!FEATURE_KEY_PATTERN.test(key))
        problems.push(
          `"${key}": key must match ${FEATURE_KEY_PATTERN.source} (<module>.<name>)`,
        );
      problems.push(...entryProblems(key, f));
    }
  return problems;
}

function normalise(key: string, f: FeatureDef): FeatureEntry {
  const deprecated = f.deprecated === true;
  switch (f.kind) {
    case 'FLAG':
      return { key, kind: 'FLAG', fallback: f.fallback, deprecated };
    case 'LIMIT':
      return {
        key,
        kind: 'LIMIT',
        fallback: f.fallback,
        minimum: f.minimum ?? 0,
        deprecated,
      };
    case 'QUOTA':
      return {
        key,
        kind: 'QUOTA',
        resetPeriod: f.resetPeriod,
        fallback: f.fallback,
        minimum: f.minimum ?? 0,
        deprecated,
      };
    default: {
      const unknownKind: never = f;
      throw new FeatureCatalogueError([
        `"${key}": unknown kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      ]);
    }
  }
}

/** Gộp catalogue của mọi module/feature; vi phạm → `FeatureCatalogueError` liệt kê hết (app không khởi động). */
export function mergeFeatureCatalogues(
  defs: readonly FeatureCatalogueData[],
): MergedFeatures {
  const problems = featureCatalogueProblems(defs);
  if (problems.length > 0) throw new FeatureCatalogueError(problems);
  const merged = new Map<string, FeatureEntry>();
  for (const def of defs)
    for (const [key, f] of Object.entries(def.features))
      merged.set(key, normalise(key, f));
  return merged;
}
