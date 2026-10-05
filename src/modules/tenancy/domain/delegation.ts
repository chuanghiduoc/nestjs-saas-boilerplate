import type { CatalogueEntry, MergedCatalogue } from './catalogue.js';

export type DelegationKind = 'API_KEY' | 'SUPPORT_GRANT';
export type ScopeRefusalReason =
  | 'UNKNOWN_PERMISSION'
  | 'NOT_ELIGIBLE'
  | 'MISSING_DEPENDENCIES'
  | 'EXCEEDS_GRANTOR';
export type ScopeCheck =
  | { ok: true; scope: string[] }
  | { ok: false; reason: ScopeRefusalReason; keys: string[] };

const READ = 'read';
/** Cùng luật với hai trigger guard của migration `delegation` (DB là lớp cuối; đây chỉ để trả lỗi đẹp). */
const eligible = (kind: DelegationKind, e: CatalogueEntry): boolean => {
  if (e.deprecated || e.ownerOnly) return false;
  switch (kind) {
    case 'API_KEY':
      return e.apiKeyEligible;
    case 'SUPPORT_GRANT':
      return e.supportEligible && e.action === READ;
    default: {
      const unknown: never = kind;
      throw new Error(`unknown delegation kind ${String(unknown)}`);
    }
  }
};

export function delegableKeys(
  kind: DelegationKind,
  merged: MergedCatalogue,
): ReadonlySet<string> {
  return new Set(
    [...merged.values()].filter((e) => eligible(kind, e)).map((e) => e.key),
  );
}
/** Spec §9.7 (P-2): preset chỉ đọc = mọi quyền `supportEligible` có `action = 'read'` của catalogue GỘP (R-X24). */
export const supportPreset = (merged: MergedCatalogue): string[] =>
  [...delegableKeys('SUPPORT_GRANT', merged)].sort();

/**
 * Luật ủy quyền lúc tạo (spec SP3 §8.5, §10): phạm vi TƯỜNG MINH (không wildcard, không "mọi quyền của tôi"), mọi key có
 * trong catalogue gộp và không deprecated, eligible với loại ủy quyền, đóng theo `requires` (SEC-M4; thiếu → danh sách),
 * và ⊆ quyền HIỆN TẠI của người ủy quyền (`⊆`, không `⊊`: key không bao giờ vượt người tạo lúc dùng). Mảng lặp/khác thứ tự
 * cho cùng một tập đã sắp (Review Focus 2).
 */
export function checkDelegatedScope(
  kind: DelegationKind,
  requested: readonly string[],
  grantor: ReadonlySet<string>,
  merged: MergedCatalogue,
): ScopeCheck {
  const scope = [...new Set(requested)].sort();
  // "Không có" và "deprecated" gom thành UNKNOWN_PERMISSION như role của 3B.
  const unknown = scope.filter((k) => merged.get(k)?.deprecated !== false);
  if (unknown.length > 0)
    return { ok: false, reason: 'UNKNOWN_PERMISSION', keys: unknown };
  const entryOf = (k: string): CatalogueEntry => {
    const e = merged.get(k);
    if (!e) throw new Error(`checkDelegatedScope lost ${k}`);
    return e;
  };
  const notEligible = scope.filter((k) => !eligible(kind, entryOf(k)));
  if (notEligible.length > 0)
    return { ok: false, reason: 'NOT_ELIGIBLE', keys: notEligible };
  const set = new Set(scope);
  const missing = [
    ...new Set(
      scope.flatMap((k) => entryOf(k).requires.filter((r) => !set.has(r))),
    ),
  ].sort();
  if (missing.length > 0)
    return { ok: false, reason: 'MISSING_DEPENDENCIES', keys: missing };
  const exceeds = scope.filter((k) => !grantor.has(k));
  if (exceeds.length > 0)
    return { ok: false, reason: 'EXCEEDS_GRANTOR', keys: exceeds };
  return { ok: true, scope };
}

/**
 * Quyền hiệu lực lúc dùng (spec §8.5): phạm vi đã lưu ∩ quyền hiện tại của người ủy quyền ∩ eligible, KHÔNG `closure`
 * (closure lúc dùng sẽ tự thêm quyền, trái PR5); phép giao có thể không đóng nên cắt tới điểm bất động. Key không có trong
 * catalogue đã nạp là orphan (module bị tắt, R-X21/R-X23): không cấp gì, không ném; trả về để caller báo.
 */
export function effectiveDelegation(
  kind: DelegationKind,
  stored: readonly string[],
  grantor: ReadonlySet<string>,
  merged: MergedCatalogue,
): { granted: string[]; orphans: string[] } {
  const orphans = [...new Set(stored.filter((k) => !merged.has(k)))].sort();
  const set = new Set(
    stored.filter((k) => {
      const e = merged.get(k);
      return e !== undefined && eligible(kind, e) && grantor.has(k);
    }),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const k of set) {
      const e = merged.get(k);
      if (e && e.requires.some((r) => !set.has(r))) {
        set.delete(k);
        changed = true;
      }
    }
  }
  return { granted: [...set].sort(), orphans };
}
