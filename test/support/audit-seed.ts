import pg from 'pg';
import { v7 } from 'uuid';
import { getInfra } from './infra.js';
import { inOrgTx } from './tenancy-seed.js';

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
