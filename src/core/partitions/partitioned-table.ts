export type PartitionedTableDef = {
  /** Bảng partitioned mà hàm bảo trì lo (một hàm có thể lo nhiều bảng, spec §6.7). */
  readonly tables: readonly string[];
  /** Hàm `public.<tên>(p_retention_months integer, p_premake_months integer) RETURNS TABLE (action text, partition_name text)`. */
  readonly maintainFunction: string;
  /** Khoá `pg_try_advisory_xact_lock` viết cứng trong hàm (R6-17); duy nhất trong registry. */
  readonly lockKey: bigint;
  readonly retentionMonths: () => number;
  readonly premakeMonths: () => number;
};

const NAME = /^[a-z][a-z0-9_]*$/;
const MONTH_SUFFIX = /^(\d{4})(\d{2})$/;
/** Gauge khi bảng chưa có partition nào: dưới mọi ngưỡng cảnh báo (`< 2`). */
export const NO_PARTITIONS = -1;
const defs: PartitionedTableDef[] = [];

/** Registry lúc import (spec SP6 §5.3): 6B khai `audit_logs` + `platform_audit_logs`, 6C khai hai bảng webhook. */
export function definePartitionedTable(
  def: PartitionedTableDef,
): PartitionedTableDef {
  if (def.tables.length === 0)
    throw new Error(`${def.maintainFunction}: at least one table is required`);
  for (const t of def.tables)
    if (!NAME.test(t))
      throw new Error(`Partitioned table name "${t}" must match ${NAME}`);
  if (!NAME.test(def.maintainFunction))
    throw new Error(
      `maintainFunction "${def.maintainFunction}" must match ${NAME} (a function of schema public)`,
    );
  for (const d of defs) {
    if (d.maintainFunction === def.maintainFunction)
      throw new Error(
        `maintainFunction "${def.maintainFunction}" is already registered`,
      );
    if (d.lockKey === def.lockKey)
      throw new Error(
        `lockKey ${def.lockKey} is already used by ${d.maintainFunction}`,
      );
    const shared = d.tables.find((t) => def.tables.includes(t));
    if (shared)
      throw new Error(
        `Table "${shared}" is already maintained by ${d.maintainFunction}`,
      );
  }
  defs.push(def);
  return def;
}

export const partitionedTableRegistry = (): PartitionedTableDef[] => [...defs];

/** Bảng của partition `<bảng>_pYYYYMM` trong mục `def`; tên lạ → ném (hàm SQL đã `RAISE` với tên lạ, đây là lớp thứ hai). */
export function tableOfPartition(
  def: PartitionedTableDef,
  partition: string,
): string {
  const table = def.tables.find(
    (t) =>
      partition.startsWith(`${t}_p`) &&
      MONTH_SUFFIX.test(partition.slice(t.length + 2)),
  );
  if (!table)
    throw new Error(
      `Partition "${partition}" does not belong to ${def.tables.join(', ')}`,
    );
  return table;
}

/** Số tháng partition mới nhất (`YYYYMM`) đi trước tháng UTC hiện tại. */
export function monthsAhead(newest: string | null, now: Date): number {
  if (newest === null) return NO_PARTITIONS;
  const m = MONTH_SUFFIX.exec(newest);
  if (!m?.[1] || !m[2])
    throw new Error(`Partition suffix "${newest}" is not YYYYMM`);
  return (
    Number(m[1]) * 12 +
    (Number(m[2]) - 1) -
    (now.getUTCFullYear() * 12 + now.getUTCMonth())
  );
}
