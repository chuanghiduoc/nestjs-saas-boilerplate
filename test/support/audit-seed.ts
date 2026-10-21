import pg from 'pg';
import { v7 } from 'uuid';
import { getInfra } from './infra.js';
import { inOrgTx, withAppClient } from './tenancy-seed.js';

const POLL_MS = 100;
const WAIT_FOR_ROW_MS = 15_000;

export type AuditRowSeed = {
  eventId?: string;
  action?: string;
  actorType?: 'user' | 'system' | 'service';
  actorId?: string;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  correlationId?: string;
  data?: Record<string, unknown>;
};

const INSERT_COLUMNS = `event_id, action, action_version, occurred_at, actor_type, actor_id, actor_user_id,
  target_type, target_id, correlation_id, data`;
const seedValues = (r: AuditRowSeed): unknown[] => [
  r.eventId ?? v7(),
  r.action ?? 'test.audit.row',
  r.actorType ?? 'system',
  r.actorId ?? 'test',
  r.actorUserId ?? null,
  r.targetType ?? 'test',
  r.targetId ?? '1',
  r.correlationId ?? v7(),
  JSON.stringify(r.data ?? {}),
];

export type AuditRow = {
  event_id: string;
  action: string;
  action_version: number;
  actor_type: string;
  actor_id: string;
  actor_user_id: string | null;
  target_type: string;
  target_id: string;
  correlation_id: string;
  causation_id: string | null;
  data: Record<string, unknown>;
  recorded_at: string;
};
type RowFilter = { eventId?: string; action?: string; correlationId?: string };

const ROW_COLUMNS = `event_id::text, action, action_version, actor_type, actor_id, actor_user_id::text, target_type,
  target_id, correlation_id, causation_id, data, recorded_at::text`;

/** Điều kiện lọc bằng tham số `$1…`. */
function filterSql(where: RowFilter): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    parts.push(`${column} = $${params.length}`);
  };
  add('event_id', where.eventId);
  add('action', where.action);
  add('correlation_id', where.correlationId);
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/** INSERT một dòng `audit_logs` bằng `app_user` trong OrgScope của `orgId` (FORCE RLS); trả rowCount. */
export async function insertOrgAuditRow(
  c: pg.Client,
  orgId: string,
  r: AuditRowSeed = {},
): Promise<number> {
  const res = await inOrgTx(c, orgId, () =>
    c.query(
      `INSERT INTO audit_logs (org_id, ${INSERT_COLUMNS})
       VALUES (app_current_org(), $1, $2, 1, now(), $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      seedValues(r),
    ),
  );
  return res.rowCount ?? 0;
}

/** Tháng UTC lệch `offset` so với tháng hiện tại: `tag` = YYYYMM, `lo`/`hi` ISO. */
export function monthTag(offset: number): {
  tag: string;
  lo: string;
  hi: string;
} {
  const now = new Date();
  const lo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
  const hi = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1),
  );
  return {
    tag: `${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, '0')}`,
    lo: lo.toISOString(),
    hi: hi.toISOString(),
  };
}

/** BEGIN; SET LOCAL ROLE partition_owner; …; RESET ROLE; COMMIT trên client owner (ROLLBACK khi lỗi). */
export async function asPartitionOwner(
  statements: readonly string[],
  database?: string,
): Promise<void> {
  const { pg: p } = getInfra();
  const c = new pg.Client({
    host: p.host,
    port: p.port,
    database: database ?? p.database,
    ...p.owner,
  });
  await c.connect();
  try {
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE partition_owner');
      for (const s of statements) await c.query(s);
      await c.query('RESET ROLE');
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  } finally {
    await c.end();
  }
}

/** INSERT một dòng `platform_audit_logs` bằng `app_user` (không org). */
export async function insertPlatformAuditRow(
  c: pg.Client,
  r: AuditRowSeed = {},
): Promise<number> {
  const res = await c.query(
    `INSERT INTO platform_audit_logs (${INSERT_COLUMNS})
     VALUES ($1, $2, 1, now(), $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    seedValues(r),
  );
  return res.rowCount ?? 0;
}

/** Dòng `audit_logs` của org đọc bằng `app_user` trong OrgScope (không bao giờ ownerQuery: FORCE RLS). */
export function orgAuditRows(
  orgId: string,
  where: RowFilter = {},
  database?: string,
): Promise<AuditRow[]> {
  const f = filterSql(where);
  return withAppClient(
    (c) =>
      inOrgTx(
        c,
        orgId,
        async () =>
          (
            await c.query<AuditRow>(
              `SELECT ${ROW_COLUMNS} FROM audit_logs ${f.sql} ORDER BY recorded_at DESC, id DESC`,
              f.params,
            )
          ).rows,
      ),
    database,
  );
}

export function platformAuditRows(
  where: RowFilter = {},
  database?: string,
): Promise<AuditRow[]> {
  const f = filterSql(where);
  return withAppClient(
    async (c) =>
      (
        await c.query<AuditRow>(
          `SELECT ${ROW_COLUMNS} FROM platform_audit_logs ${f.sql} ORDER BY recorded_at DESC, id DESC`,
          f.params,
        )
      ).rows,
    database,
  );
}

/** Chờ tới khi đúng một dòng audit của event có mặt (org hoặc nền tảng); quá hạn → ném kèm event id. */
export async function waitForAuditRow(
  eventId: string,
  orgId: string | null,
  timeoutMs: number = WAIT_FOR_ROW_MS,
): Promise<AuditRow> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows =
      orgId === null
        ? await platformAuditRows({ eventId })
        : await orgAuditRows(orgId, { eventId });
    if (rows.length > 1)
      throw new Error(`${rows.length} audit rows for event ${eventId}`);
    const [row] = rows;
    if (row) return row;
    if (Date.now() > until)
      throw new Error(
        `no audit row for event ${eventId} within ${timeoutMs} ms`,
      );
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
