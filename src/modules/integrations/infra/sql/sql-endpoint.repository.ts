import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import {
  DISABLED_REASONS,
  ENDPOINT_STATUSES,
  type DisabledReason,
  type EndpointStatus,
} from '../../domain/webhook-endpoint.js';
import {
  EndpointRepository,
  type EndpointLock,
  type EndpointRow,
} from '../../ports/endpoint-repository.js';

export const ENDPOINT_COLUMNS = `e.id::text AS id, e.public_id::text AS public_id, e.url, e.description, e.status, e.disabled_reason,
  e.failing_since, e.version, e.created_at, e.updated_at,
  COALESCE((SELECT array_agg(t.event_type ORDER BY t.event_type COLLATE "C") FROM webhook_endpoint_event_types t
            WHERE t.org_id = e.org_id AND t.endpoint_id = e.id), '{}') AS event_types`;
const Row = z.object({
  id: z.string(),
  public_id: z.uuid(),
  url: z.string(),
  description: z.string().nullable(),
  status: z.enum(ENDPOINT_STATUSES),
  disabled_reason: z.enum(DISABLED_REASONS).nullable(),
  failing_since: z.coerce.date().nullable(),
  version: z.number().int(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  event_types: z.array(z.string()),
});
export const toEndpointRow = (raw: unknown): EndpointRow => {
  const r = Row.parse(raw);
  return {
    id: r.id,
    publicId: r.public_id,
    url: r.url,
    description: r.description,
    status: r.status,
    disabledReason: r.disabled_reason,
    failingSince: r.failing_since,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    eventTypes: r.event_types,
  };
};
const lockClause = (lock: EndpointLock): string => {
  switch (lock) {
    case 'NONE':
      return '';
    case 'NO_KEY_UPDATE':
      return ' FOR NO KEY UPDATE OF e';
    case 'SHARE':
      return ' FOR SHARE OF e';
    default: {
      const unreachable: never = lock;
      throw new Error(`Unhandled endpoint lock ${String(unreachable)}`);
    }
  }
};
const LIVE = `e.org_id = app_current_org() AND e.deleted_at IS NULL`;
const IdRow = z.array(z.object({ id: z.string(), public_id: z.uuid() }));
const CountRow = z.array(z.object({ n: z.number().int() }));

@Injectable()
export class SqlEndpointRepository extends EndpointRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async countLive(): Promise<number> {
    const [r] = CountRow.parse(
      await this.db.execute(
        `SELECT count(*)::int AS n FROM webhook_endpoints e WHERE ${LIVE}`,
      ),
    );
    if (!r) throw new Error('count of webhook endpoints returned no row');
    return r.n;
  }
  countLiveUpTo(cap: number): Promise<number> {
    return countUpTo(
      this.db,
      `SELECT 1 FROM webhook_endpoints e WHERE ${LIVE}`,
      [],
      cap,
    );
  }
  async insert(i: {
    url: string;
    description: string | null;
  }): Promise<{ id: string; publicId: string }> {
    const [r] = IdRow.parse(
      await this.db.execute(
        `INSERT INTO webhook_endpoints (org_id, url, description) VALUES (app_current_org(), ?, ?) RETURNING id::text AS id, public_id::text AS public_id`,
        [i.url, i.description],
      ),
    );
    if (!r) throw new Error('webhook endpoint insert returned no row');
    return { id: r.id, publicId: r.public_id };
  }
  async setEventTypes(
    endpointId: string,
    types: readonly string[],
  ): Promise<void> {
    // `ARRAY[]::text[]` của tập rỗng là lỗi cú pháp; zod đã đòi `min(1)`, tới đây với tập rỗng là bug.
    if (types.length === 0)
      throw new Error('setEventTypes needs at least one event type');
    await this.db.execute(
      `DELETE FROM webhook_endpoint_event_types WHERE org_id = app_current_org() AND endpoint_id = ?::bigint AND event_type <> ALL(ARRAY[?]::text[])`,
      [endpointId, types],
    );
    await this.db.execute(
      `INSERT INTO webhook_endpoint_event_types (org_id, endpoint_id, event_type)
       SELECT app_current_org(), ?::bigint, t FROM unnest(ARRAY[?]::text[]) AS t ON CONFLICT DO NOTHING`,
      [endpointId, types],
    );
  }
  async insertSecret(i: {
    endpointId: string;
    publicId: string;
    secretEnc: string;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO webhook_endpoint_secrets (public_id, org_id, endpoint_id, secret_enc) VALUES (?::uuid, app_current_org(), ?::bigint, ?)`,
      [i.publicId, i.endpointId, i.secretEnc],
    );
  }
  async list(page: { limit: number; offset: number }): Promise<EndpointRow[]> {
    return (
      await this.db.execute(
        `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE ${LIVE} ORDER BY e.created_at, e.id LIMIT ? OFFSET ?`,
        [page.limit, page.offset],
      )
    ).map(toEndpointRow);
  }
  async find(
    publicId: string,
    lock: EndpointLock,
  ): Promise<EndpointRow | undefined> {
    const [r] = await this.db.execute(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE ${LIVE} AND e.public_id = ?::uuid${lockClause(lock)}`,
      [publicId],
    );
    return r ? toEndpointRow(r) : undefined;
  }

  async update(
    id: string,
    next: {
      url: string;
      description: string | null;
      status: EndpointStatus;
      disabledReason: DisabledReason | null;
      clearFailing: boolean;
    },
  ): Promise<EndpointRow> {
    await this.db.execute(
      `UPDATE webhook_endpoints SET url = ?, description = ?, status = ?, disabled_reason = ?,
         failing_since = CASE WHEN ?::boolean THEN NULL ELSE failing_since END, version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND id = ?::bigint AND deleted_at IS NULL`,
      [
        next.url,
        next.description,
        next.status,
        next.disabledReason,
        next.clearFailing,
        id,
      ],
    );
    const [r] = await this.db.execute(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE e.org_id = app_current_org() AND e.id = ?::bigint`,
      [id],
    );
    if (!r) throw new Error('webhook endpoint vanished after its update');
    return toEndpointRow(r);
  }
  async softDelete(id: string, purgeDelaySec: number): Promise<void> {
    await this.db.execute(
      `UPDATE webhook_endpoints SET deleted_at = clock_timestamp(), purge_after = clock_timestamp() + make_interval(secs => ?::integer),
         version = version + 1, updated_at = clock_timestamp()
       WHERE org_id = app_current_org() AND id = ?::bigint AND deleted_at IS NULL`,
      [purgeDelaySec, id],
    );
  }
  async rotateSecrets(
    endpointId: string,
    overlapSec: number,
  ): Promise<{ previousExpiresAt: Date | null }> {
    const scope = `org_id = app_current_org() AND endpoint_id = ?::bigint`;
    await this.db.execute(
      `DELETE FROM webhook_endpoint_secrets WHERE ${scope} AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()`,
      [endpointId],
    );
    // Thứ tự quan trọng: secret cũ còn hạn hết hạn TRƯỚC, rồi mới tới secret hiện hành (nếu ngược, câu sau sẽ chạm cả nó).
    await this.db.execute(
      `UPDATE webhook_endpoint_secrets SET expires_at = clock_timestamp(), updated_at = clock_timestamp() WHERE ${scope} AND expires_at > clock_timestamp()`,
      [endpointId],
    );
    const rows = z.array(z.object({ expires_at: z.coerce.date() })).parse(
      await this.db.execute(
        `UPDATE webhook_endpoint_secrets SET expires_at = clock_timestamp() + make_interval(secs => ?::integer), updated_at = clock_timestamp()
           WHERE ${scope} AND expires_at IS NULL RETURNING expires_at`,
        [overlapSec, endpointId],
      ),
    );
    return { previousExpiresAt: rows[0]?.expires_at ?? null };
  }
  async signingSecrets(
    endpointId: string,
  ): Promise<{ publicId: string; secretEnc: string }[]> {
    return z
      .array(z.object({ public_id: z.uuid(), secret_enc: z.string() }))
      .parse(
        await this.db.execute(
          `SELECT public_id::text AS public_id, secret_enc FROM webhook_endpoint_secrets
           WHERE org_id = app_current_org() AND endpoint_id = ?::bigint AND (expires_at IS NULL OR expires_at > clock_timestamp())
           ORDER BY expires_at IS NULL DESC, created_at DESC`,
          [endpointId],
        ),
      )
      .map((r) => ({ publicId: r.public_id, secretEnc: r.secret_enc }));
  }
}
