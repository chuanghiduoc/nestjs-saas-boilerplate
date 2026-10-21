import { z } from 'zod';

/** Một bảng đã phân tích chuẩn hoá: `schema.bảng` và đúng tập cột (spec SP2 §5.16, SP3 §6.12). */
export type NormalizationEntry = { table: string; columns: readonly string[] };
/**
 * Khai báo của một feature dự án ở `test/integration/features/<f>/<f>.inventory.ts` (spec SP7 S7-D28): test của
 * boilerplate gộp khai báo này vào hằng của mình, nên dự án thêm bảng mà không sửa file test của boilerplate.
 */
export type FeatureInventory = {
  tables?: readonly NormalizationEntry[];
  globalTables?: readonly string[];
  definerFunctions?: readonly string[];
  definerReadTables?: readonly string[];
};

const QUALIFIED_TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const Inventory = z
  .object({
    tables: z
      .array(
        z.object({
          table: z
            .string()
            .regex(QUALIFIED_TABLE, 'table must be schema.table'),
          columns: z
            .array(z.string().min(1))
            .min(1)
            .refine((c) => new Set(c).size === c.length, 'duplicate column'),
        }),
      )
      .optional(),
    globalTables: z.array(z.string().min(1)).optional(),
    definerFunctions: z.array(z.string().min(1)).optional(),
    definerReadTables: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function parseFeatureInventory(
  file: string,
  mod: unknown,
): FeatureInventory {
  const r = Inventory.safeParse(mod);
  if (!r.success)
    throw new Error(
      `${file}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
    );
  return r.data;
}

export function mergeAnalysedColumns(
  base: Readonly<Record<string, readonly string[]>>,
  inventories: Readonly<Record<string, unknown>>,
): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = { ...base };
  for (const [file, mod] of Object.entries(inventories))
    for (const t of parseFeatureInventory(file, mod).tables ?? []) {
      if (Object.hasOwn(merged, t.table))
        throw new Error(
          `${file}: table ${t.table} is already in the normalization inventory`,
        );
      merged[t.table] = t.columns;
    }
  return merged;
}

/**
 * Mọi `test/<loại>/features/<f>/<f>.inventory.ts` (spec SP7 S7-D28): một chỗ glob cho mọi test của boilerplate. Ở upstream
 * sau `upstream:init` (vùng template đã xoá) tập này rỗng.
 */
export const FEATURE_INVENTORIES: Readonly<Record<string, unknown>> =
  import.meta.glob<unknown>('../**/features/**/*.inventory.ts', {
    eager: true,
  });

/**
 * Nối danh sách tên của các inventory vào hằng của boilerplate (D7-8: `definerFunctions`/`definerReadTables` là của
 * `sweep_definer`, R-X4). Trùng với hằng gốc hoặc giữa hai file thì ném: một tên chỉ có một chủ.
 */
export function mergeFeatureList(
  base: readonly string[],
  field: 'globalTables' | 'definerFunctions' | 'definerReadTables',
  inventories: Readonly<Record<string, unknown>>,
): string[] {
  const merged = [...base];
  for (const [file, mod] of Object.entries(inventories))
    for (const entry of parseFeatureInventory(file, mod)[field] ?? []) {
      if (merged.includes(entry))
        throw new Error(`${file}: ${field} entry ${entry} is already declared`);
      merged.push(entry);
    }
  return merged;
}
