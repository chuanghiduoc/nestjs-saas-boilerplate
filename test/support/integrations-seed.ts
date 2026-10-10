import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { v7 } from 'uuid';
import { inOrgTx, withAppClient } from './tenancy-seed.js';

/** Token đúng định dạng `FieldCipher` v1 (CHECK `webhook_endpoint_secrets_enc_ck`), không giải mã được: chỉ cho test DB. */
export const FAKE_SECRET_ENC =
  'v1.t1.AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA';

export type SeededEndpoint = { id: string; publicId: string };
export type SeededMessage = { id: string; createdAt: string };

/** Một transaction `app_user` trong OrgScope của org (bảng `webhook_*` có FORCE RLS: `ownerQuery` thấy 0 dòng). */
export function inOrg<T>(
  orgId: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  return withAppClient((c) => inOrgTx(c, orgId, () => fn(c)));
}
export function orgQuery<T extends pg.QueryResultRow>(
  orgId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return inOrg(orgId, async (c) => (await c.query<T>(sql, params)).rows);
}
/** Endpoint (mặc định `ACTIVE`) với các event type (mặc định `tenancy.org.updated`). Chạy trong `inOrg` của caller. */
export async function insertEndpoint(
  c: pg.Client,
  orgId: string,
  o: {
    url?: string;
    eventTypes?: readonly string[];
    status?: 'ACTIVE' | 'DISABLED';
  } = {},
): Promise<SeededEndpoint> {
  const status = o.status ?? 'ACTIVE';
  const { rows } = await c.query<{ id: string; public_id: string }>(
    `INSERT INTO webhook_endpoints (org_id, url, status, disabled_reason) VALUES ($1, $2, $3, $4) RETURNING id::text, public_id::text`,
    [
      orgId,
      o.url ?? `https://hooks.example.test/${randomUUID()}`,
      status,
      status === 'DISABLED' ? 'MANUAL' : null,
    ],
  );
  const e = rows[0];
  if (!e) throw new Error('seed: endpoint insert returned no row');
  for (const t of o.eventTypes ?? ['tenancy.org.updated'])
    await c.query(
      `INSERT INTO webhook_endpoint_event_types (org_id, endpoint_id, event_type) VALUES ($1, $2, $3)`,
      [orgId, e.id, t],
    );
  return { id: e.id, publicId: e.public_id };
}
/** `createdAt` là chuỗi ISO micro giây (UTC), đúng khoá mà repository dùng cho CAS. */
export async function insertMessage(
  c: pg.Client,
  orgId: string,
  o: { eventType?: string; createdAt?: string; body?: string } = {},
): Promise<SeededMessage> {
  const { rows } = await c.query<{ id: string; created_at: string }>(
    `INSERT INTO webhook_messages (org_id, event_id, event_type, event_version, body, created_at)
     VALUES ($1, $2, $3, 1, $4, COALESCE($5::timestamptz, now()))
     RETURNING id::text, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    [
      orgId,
      v7(),
      o.eventType ?? 'tenancy.org.updated',
      o.body ?? '{}',
      o.createdAt ?? null,
    ],
  );
  const m = rows[0];
  if (!m) throw new Error('seed: message insert returned no row');
  return { id: m.id, createdAt: m.created_at };
}
/** Delivery `PENDING`, đến hạn ngay, cùng `created_at` với message (FK ép). */
export async function insertDelivery(
  c: pg.Client,
  orgId: string,
  o: { endpoint: SeededEndpoint; message: SeededMessage },
): Promise<{ publicId: string }> {
  const publicId = v7();
  await c.query(
    `INSERT INTO webhook_deliveries (public_id, org_id, endpoint_id, message_id, created_at, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 'PENDING', now())`,
    [publicId, orgId, o.endpoint.id, o.message.id, o.message.createdAt],
  );
  return { publicId };
}

/**
 * Bất biến R-X33 "mọi delivery có endpoint": DB không ép (không FK partitioned → bảng thường), nên mọi test chạm đường
 * ghi delivery hoặc xoá cứng endpoint gọi hàm này và đòi `0`.
 */
export async function orphanDeliveries(orgId: string): Promise<number> {
  const [r] = await orgQuery<{ n: number }>(
    orgId,
    `SELECT count(*)::int AS n FROM webhook_deliveries d
     WHERE NOT EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.org_id = d.org_id AND e.id = d.endpoint_id)`,
  );
  if (r === undefined)
    throw new Error('orphanDeliveries: count returned no row');
  return r.n;
}
