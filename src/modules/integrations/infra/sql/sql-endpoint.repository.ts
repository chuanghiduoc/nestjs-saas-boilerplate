import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, countUpTo } from '../../../../core/database/index.js';
import {
  DISABLED_REASONS,
  ENDPOINT_STATUSES,
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
}
