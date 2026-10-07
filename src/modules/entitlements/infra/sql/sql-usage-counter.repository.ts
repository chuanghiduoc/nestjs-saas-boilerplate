import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import type { QuotaPeriod } from '../../domain/quota.js';
import {
  UsageCounterRepository,
  type ConsumedCounter,
  type CurrentUsage,
} from '../../ports/usage-counter.repository.js';

/**
 * Đầu tháng của `clock` theo múi giờ tham số (spec §9.2, PG ≥ 16): tham số múi giờ đi SAU tham số (nếu có) của `clock`.
 * App dùng `now()` (giờ bắt đầu transaction: consume, release, đọc usage trong cùng transaction luôn cùng kỳ; E-3 "mỗi
 * transaction rơi vào đúng một kỳ"); test QU-3 dùng một mốc cố định.
 */
export const monthPeriodStartSql = (clock: string): string =>
  `date_trunc('month', ${clock}, ?)`;

/** Biểu thức kỳ + tham số theo `QuotaPeriod`, `switch` vét cạn. NONE là NULL (arbiter NULLS NOT DISTINCT, spike S4-T2). */
function periodSql(p: QuotaPeriod): { sql: string; params: unknown[] } {
  switch (p.kind) {
    case 'NONE':
      return { sql: 'NULL::timestamptz', params: [] };
    case 'MONTH':
      return { sql: monthPeriodStartSql('now()'), params: [p.timezone] };
    default: {
      const unknown: never = p;
      throw new Error(`unknown quota period ${JSON.stringify(unknown)}`);
    }
  }
}
/** Vị từ theo kỳ dùng được index (`IS NOT DISTINCT FROM` không dùng được index btree). */
function periodWhere(p: QuotaPeriod): { sql: string; params: unknown[] } {
  switch (p.kind) {
    case 'NONE':
      return { sql: 'period_start IS NULL', params: [] };
    case 'MONTH':
      return {
        sql: `period_start = ${monthPeriodStartSql('now()')}`,
        params: [p.timezone],
      };
    default: {
      const unknown: never = p;
      throw new Error(`unknown quota period ${JSON.stringify(unknown)}`);
    }
  }
}

/** `Db.execute` trả BIGINT dạng chuỗi (đọc bằng `::text`) và TIMESTAMPTZ dạng chuỗi (bài học 3A): coerce. */
const Consumed = z.object({
  id: z.string(),
  used: z.coerce.number().int().min(0),
  version: z.coerce.number().int().min(0),
  period_start: z.coerce.date().nullable(),
});
const Used = z.object({ used: z.coerce.number().int().min(0) });
const UsageRow = z.object({
  period_start: z.coerce.date(),
  period_end: z.coerce.date(),
  feature: z.string().nullable(),
  used: z.coerce.number().int().min(0).nullable(),
});

@Injectable()
export class SqlUsageCounterRepository extends UsageCounterRepository {
  constructor(private readonly db: Db) {
    super();
  }

  /**
   * Spec §9.2. Nhánh DO UPDATE khoá dòng xung đột rồi mới tính WHERE trên phiên bản mới nhất (E-1); hai INSERT đồng thời:
   * bên sau chờ index unique rồi đi DO UPDATE (E-2). `updated_at = clock_timestamp()`: ghi sau khi có thể đã chờ khoá dòng.
   */
  async consume(i: {
    featureId: string;
    period: QuotaPeriod;
    amount: number;
    max: number | null;
  }): Promise<ConsumedCounter | undefined> {
    const p = periodSql(i.period);
    const guard =
      i.max === null
        ? ''
        : 'WHERE usage_counters.used + EXCLUDED.used <= ?::bigint';
    const rows = await this.db.execute(
      `INSERT INTO usage_counters (org_id, feature_id, period_start, used, version)
       VALUES (app_current_org(), ?::bigint, ${p.sql}, ?::bigint, 1)
       ON CONFLICT (org_id, feature_id, period_start)
       DO UPDATE SET used = usage_counters.used + EXCLUDED.used, version = usage_counters.version + 1,
                     updated_at = clock_timestamp()
       ${guard}
       RETURNING id::text AS id, used::text AS used, version::text AS version, period_start`,
      [
        i.featureId,
        ...p.params,
        String(i.amount),
        ...(i.max === null ? [] : [String(i.max)]),
      ],
    );
    if (rows.length > 1)
      throw new Error(
        `consume returned ${rows.length} rows (usage_counters_period_uq violated?)`,
      );
    if (!rows[0]) return undefined;
    const r = Consumed.parse(rows[0]);
    return {
      id: r.id,
      used: r.used,
      version: r.version,
      periodStart: r.period_start,
    };
  }

  async usedNow(i: {
    featureId: string;
    period: QuotaPeriod;
  }): Promise<number> {
    const w = periodWhere(i.period);
    const rows = await this.db.execute(
      `SELECT used::text AS used FROM usage_counters
       WHERE org_id = app_current_org() AND feature_id = ?::bigint AND ${w.sql}`,
      [i.featureId, ...w.params],
    );
    return rows[0] ? Used.parse(rows[0]).used : 0;
  }

  /** Spec §9.3: hai biến thể theo kỳ (đều dùng `usage_counters_period_uq`); `used >= amount` + `CHECK (used >= 0)` (E-14). */
  async release(i: {
    featureId: string;
    periodStart: string | null;
    amount: number;
  }): Promise<number | undefined> {
    const period =
      i.periodStart === null
        ? { sql: 'period_start IS NULL', params: [] }
        : { sql: 'period_start = ?::timestamptz', params: [i.periodStart] };
    const rows = await this.db.execute(
      `UPDATE usage_counters SET used = used - ?::bigint, version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND feature_id = ?::bigint AND ${period.sql} AND used >= ?::bigint
       RETURNING used::text AS used`,
      [String(i.amount), i.featureId, ...period.params, String(i.amount)],
    );
    return rows[0] ? Used.parse(rows[0]).used : undefined;
  }

  /**
   * Spec §12.1: một câu, luôn ≥ 1 dòng (dòng ranh giới kỳ); `periodEnd = date_add(start, '1 month', tz)`. Bộ đếm của kỳ
   * MONTH cũ không lọt vào (chỉ `period_start IS NULL` hoặc = kỳ hiện tại); index `usage_counters_period_uq` (theo org).
   */
  async currentUsage(timezone: string): Promise<CurrentUsage> {
    const rows = (
      await this.db.execute(
        `SELECT p.start AS period_start, date_add(p.start, interval '1 month', ?) AS period_end,
                f.key AS feature, c.used::text AS used
         FROM (SELECT ${monthPeriodStartSql('now()')} AS start) p
         LEFT JOIN usage_counters c ON c.org_id = app_current_org() AND (c.period_start IS NULL OR c.period_start = p.start)
         LEFT JOIN entitlement_features f ON f.id = c.feature_id`,
        [timezone, timezone],
      )
    ).map((r) => UsageRow.parse(r));
    const [first] = rows;
    if (!first)
      throw new Error(
        'the usage query returned no row (the bounds row is unconditional)',
      );
    const used = new Map<string, number>();
    for (const r of rows)
      if (r.feature !== null && r.used !== null) used.set(r.feature, r.used);
    return {
      periodStart: first.period_start,
      periodEnd: first.period_end,
      used,
    };
  }
}
