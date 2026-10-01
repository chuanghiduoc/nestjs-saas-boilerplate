import { z } from 'zod';

/** Cùng regex với `CHECK` của bảng `permissions` (migration `tenancy_core`); bắt đầu bằng [a-z] nên không key nào trùng sentinel của ability. */
export const PERMISSION_RESOURCE_PATTERN = /^[a-z][a-z_]{0,31}$/;
export const PERMISSION_ACTION_PATTERN =
  /^[a-z][a-z_]{0,31}(\.[a-z][a-z_]{0,31})?$/;
/** Key `resource.action` (hai regex trên nối bằng `.`): đầu vào HTTP; key hợp lệ về dạng nhưng không có trong catalogue vẫn bị từ chối sau. */
export const PERMISSION_KEY_PATTERN =
  /^[a-z][a-z_]{0,31}\.[a-z][a-z_]{0,31}(\.[a-z][a-z_]{0,31})?$/;
/** Wildcard sống của CASL (PR6): cấm ở catalogue và ở DB. */
const CASL_ANY_ACTION = 'manage';
const CASL_ANY_SUBJECT = 'all';

export const catalogueEntrySchema = z
  .object({
    resource: z.string(),
    action: z.string(),
    requires: z.array(z.string()),
    ownerOnly: z.boolean(),
    apiKeyEligible: z.boolean(),
    supportEligible: z.boolean(),
    grantTo: z.object({ admin: z.boolean(), member: z.boolean() }).strict(),
    deprecated: z.boolean().optional(),
  })
  .strict();
export type CatalogueEntryDef = {
  readonly resource: string;
  readonly action: string;
  readonly requires: readonly string[];
  readonly ownerOnly: boolean;
  readonly apiKeyEligible: boolean;
  readonly supportEligible: boolean;
  /** Bắt buộc (PR7): quyền mới không bao giờ tự vào ADMIN/MEMBER. */
  readonly grantTo: { readonly admin: boolean; readonly member: boolean };
  readonly deprecated?: boolean;
};
export type CatalogueDef<K extends string = string> = {
  readonly name: string;
  readonly entries: Readonly<Record<K, CatalogueEntryDef>>;
  readonly keys: readonly K[];
};
export type CatalogueEntry = Omit<CatalogueEntryDef, 'deprecated'> & {
  readonly key: string;
  readonly catalogue: string;
  readonly deprecated: boolean;
};
export type MergedCatalogue = ReadonlyMap<string, CatalogueEntry>;

export class UnknownPermissionError extends Error {
  constructor(readonly key: string) {
    super(`Permission "${key}" is not in any registered catalogue`);
    this.name = 'UnknownPermissionError';
  }
}
export class CatalogueError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid permission catalogue: ${problems.join('; ')}`);
    this.name = 'CatalogueError';
  }
}

/** Khai báo catalogue `as const`: K là union key của CHÍNH catalogue (sai key ở `require(...)` là lỗi compile). */
export function defineCatalogue<
  const D extends Record<string, CatalogueEntryDef>,
>(name: string, entries: D): CatalogueDef<Extract<keyof D, string>> {
  const keys = Object.keys(entries).filter(
    (k): k is Extract<keyof D, string> => k in entries,
  );
  return { name, entries, keys };
}

const entriesOf = (defs: readonly CatalogueDef[]): CatalogueEntry[] =>
  defs.flatMap((d) =>
    Object.entries(d.entries).map(([key, e]: [string, CatalogueEntryDef]) => ({
      ...e,
      key,
      catalogue: d.name,
      deprecated: e.deprecated === true,
    })),
  );

/** Mọi vi phạm U1–U5, U12 trên catalogue gộp (spec §8.2). Rỗng = hợp lệ. */
export function catalogueProblems(defs: readonly CatalogueDef[]): string[] {
  const problems: string[] = [];
  const all = entriesOf(defs);
  const byKey = new Map<string, CatalogueEntry>();
  for (const e of all) {
    const shape = catalogueEntrySchema.safeParse({
      resource: e.resource,
      action: e.action,
      requires: [...e.requires],
      ownerOnly: e.ownerOnly,
      apiKeyEligible: e.apiKeyEligible,
      supportEligible: e.supportEligible,
      grantTo: { ...e.grantTo },
      deprecated: e.deprecated,
    });
    if (!shape.success)
      problems.push(
        `"${e.key}": malformed entry (${shape.error.issues.map((i) => i.path.join('.')).join(', ')})`,
      );
    const prev = byKey.get(e.key);
    if (prev)
      problems.push(
        `duplicate key "${e.key}" (${prev.catalogue}, ${e.catalogue})`,
      );
    else byKey.set(e.key, e);
    if (
      !PERMISSION_RESOURCE_PATTERN.test(e.resource) ||
      e.resource === CASL_ANY_SUBJECT
    )
      problems.push(
        `"${e.key}": resource must match the pattern and not be "${CASL_ANY_SUBJECT}"`,
      );
    if (
      !PERMISSION_ACTION_PATTERN.test(e.action) ||
      e.action === CASL_ANY_ACTION
    )
      problems.push(
        `"${e.key}": action must match the pattern and not be "${CASL_ANY_ACTION}"`,
      );
    if (e.key !== `${e.resource}.${e.action}`)
      problems.push(
        `"${e.key}": key must equal resource.action ("${e.resource}.${e.action}")`,
      );
    if (e.ownerOnly && (e.grantTo.admin || e.grantTo.member))
      problems.push(`"${e.key}" is ownerOnly but granted to admin or member`);
    if (e.ownerOnly && (e.apiKeyEligible || e.supportEligible))
      problems.push(
        `"${e.key}" is ownerOnly but eligible for API keys or support`,
      );
  }
  for (const e of byKey.values())
    for (const r of e.requires) {
      const target = byKey.get(r);
      if (!target) problems.push(`"${e.key}" requires unknown "${r}"`);
      else if (r === e.key) problems.push(`"${e.key}" requires itself`);
      else if (!e.deprecated && target.deprecated)
        problems.push(`"${e.key}" is active but requires deprecated "${r}"`);
    }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (k: string): void => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') {
      problems.push(`requires cycle through "${k}"`);
      return;
    }
    state.set(k, 'visiting');
    for (const r of byKey.get(k)?.requires ?? []) if (byKey.has(r)) visit(r);
    state.set(k, 'done');
  };
  for (const k of byKey.keys()) visit(k);
  for (const role of ['admin', 'member'] as const) {
    const granted = new Set(
      [...byKey.values()]
        .filter((e) => e.grantTo[role] && !e.deprecated)
        .map((e) => e.key),
    );
    for (const k of granted)
      for (const r of byKey.get(k)?.requires ?? [])
        if (!granted.has(r))
          problems.push(
            `grantTo.${role} is not closed: "${k}" requires "${r}"`,
          );
  }
  return problems;
}

/** Catalogue gộp; vi phạm → `CatalogueError` (app không khởi động). */
export function mergeCatalogues(
  defs: readonly CatalogueDef[],
): MergedCatalogue {
  const problems = catalogueProblems(defs);
  if (problems.length) throw new CatalogueError(problems);
  return new Map(entriesOf(defs).map((e) => [e.key, e]));
}
