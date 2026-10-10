import { Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import {
  DELIVERY_STATUSES,
  LAST_ERRORS,
  type DeliveryStatus,
} from '../../domain/webhook-delivery.js';
import {
  DeliveryRepository,
  type ClaimedDelivery,
  type DeliveryRef,
  type DeliveryResult,
  type DeliveryView,
} from '../../ports/delivery-repository.js';
import { CREATED_AT_KEY_SQL } from './created-at-key.js';

const MessageRow = z.array(
  z.object({ id: z.string(), created_at: z.string() }),
);

const ClaimRow = z.array(
  z.object({
    id: z.string(),
    public_id: z.uuid(),
    created_at: z.string(),
    created_at_ms: z.number(),
    endpoint_id: z.string(),
    message_id: z.string(),
    attempts_total: z.number().int(),
    cycle_base: z.number().int(),
    local_failures: z.number().int(),
  }),
);
const toClaimed = (r: z.infer<typeof ClaimRow>[number]): ClaimedDelivery => ({
  id: r.id,
  publicId: r.public_id,
  createdAt: r.created_at,
  createdAtMs: r.created_at_ms,
  endpointId: r.endpoint_id,
  messageId: r.message_id,
  attemptsTotal: r.attempts_total,
  cycleBase: r.cycle_base,
  localFailures: r.local_failures,
});
const OkRows = z.array(z.object({ ok: z.number() }));
const ROW_KEY = `org_id = app_current_org() AND id = ?::bigint AND created_at = ?::timestamptz`;
const FENCE = `status = 'SENDING' AND attempts_total = ?::integer`;

const VIEW_COLUMNS = `d.public_id::text AS public_id, e.public_id::text AS endpoint_public_id, m.event_type, m.event_id::text AS event_id, d.status,
  d.attempts_total, d.next_attempt_at, d.last_attempt_at, d.last_status_code, d.last_error, d.completed_at, d.created_at,
  ${CREATED_AT_KEY_SQL('d')} AS created_at_key`;
const VIEW_FROM = `FROM webhook_deliveries d
  JOIN webhook_endpoints e ON e.org_id = d.org_id AND e.id = d.endpoint_id
  JOIN webhook_messages m ON m.org_id = d.org_id AND m.id = d.message_id AND m.created_at = d.created_at`;
const ViewRow = z.object({
  public_id: z.uuid(),
  endpoint_public_id: z.uuid(),
  event_type: z.string(),
  event_id: z.uuid(),
  status: z.enum(DELIVERY_STATUSES),
  attempts_total: z.number().int(),
  next_attempt_at: z.coerce.date().nullable(),
  last_attempt_at: z.coerce.date().nullable(),
  last_status_code: z.number().int().nullable(),
  last_error: z.enum(LAST_ERRORS).nullable(),
  completed_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  created_at_key: z.string(),
});
const toView = (raw: unknown): DeliveryView => {
  const r = ViewRow.parse(raw);
  return {
    publicId: r.public_id,
    endpointPublicId: r.endpoint_public_id,
    eventType: r.event_type,
    eventId: r.event_id,
    status: r.status,
    attemptsTotal: r.attempts_total,
    nextAttemptAt: r.next_attempt_at,
    lastAttemptAt: r.last_attempt_at,
    lastStatusCode: r.last_status_code,
    lastError: r.last_error,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    createdAtKey: r.created_at_key,
  };
};
/** Phát lại = chu kỳ mới: lịch đầy đủ (`cycle_base = attempts_total`) và trần lỗi của ta đầy đủ (`local_failures = 0`, R-X35). */
const REQUEUE_SET = `status = 'PENDING', cycle_base = d.attempts_total, local_failures = 0, next_attempt_at = clock_timestamp(), completed_at = NULL,
  version = d.version + 1, updated_at = clock_timestamp()`;
const TERMINAL = `d.status IN ('SUCCEEDED', 'EXHAUSTED', 'CANCELLED')`;
const RECOVERABLE = `d.org_id = app_current_org() AND d.endpoint_id = ?::bigint AND d.status IN ('EXHAUSTED', 'CANCELLED') AND d.created_at >= ?::timestamptz`;

@Injectable()
export class SqlDeliveryRepository extends DeliveryRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async insertMessage(m: {
    eventId: string;
    eventType: string;
    eventVersion: number;
    body: string;
  }): Promise<{ id: string; createdAt: string }> {
    const [r] = MessageRow.parse(
      await this.db.execute(
        `INSERT INTO webhook_messages AS m (org_id, event_id, event_type, event_version, body) VALUES (app_current_org(), ?::uuid, ?, ?::integer, ?)
         RETURNING m.id::text AS id, ${CREATED_AT_KEY_SQL('m')} AS created_at`,
        [m.eventId, m.eventType, m.eventVersion, m.body],
      ),
    );
    if (!r) throw new Error('webhook message insert returned no row');
    return { id: r.id, createdAt: r.created_at };
  }

  async insertDeliveries(
    message: { id: string; createdAt: string },
    endpointIds: readonly string[],
  ): Promise<string[]> {
    if (endpointIds.length === 0) return [];
    const publicIds = endpointIds.map(() => v7());
    await this.db.execute(
      `INSERT INTO webhook_deliveries (public_id, org_id, endpoint_id, message_id, created_at, status, next_attempt_at)
       SELECT x.p, app_current_org(), x.e, ?::bigint, ?::timestamptz, 'PENDING', clock_timestamp()
       FROM unnest(ARRAY[?]::uuid[], ARRAY[?]::bigint[]) AS x(p, e)`,
      [message.id, message.createdAt, publicIds, endpointIds],
    );
    return publicIds;
  }

  async dueEndpointOf(
    publicId: string,
    skewMs: number,
  ): Promise<string | undefined> {
    const [r] = z.array(z.object({ endpoint_id: z.string() })).parse(
      await this.db.execute(
        `SELECT endpoint_id::text AS endpoint_id FROM webhook_deliveries
           WHERE org_id = app_current_org() AND public_id = ?::uuid AND status IN ('PENDING', 'RETRY_SCHEDULED')
             AND next_attempt_at <= clock_timestamp() + make_interval(secs => ?::double precision / 1000)`,
        [publicId, skewMs],
      ),
    );
    return r?.endpoint_id;
  }
  async claim(
    publicId: string,
    leaseMs: number,
    skewMs: number,
  ): Promise<ClaimedDelivery | undefined> {
    const [r] = ClaimRow.parse(
      await this.db.execute(
        `UPDATE webhook_deliveries AS d SET status = 'SENDING', attempts_total = d.attempts_total + 1, next_attempt_at = NULL,
           lease_until = clock_timestamp() + make_interval(secs => ?::double precision / 1000), last_attempt_at = clock_timestamp(),
           version = d.version + 1, updated_at = clock_timestamp()
         WHERE d.org_id = app_current_org() AND d.public_id = ?::uuid AND d.status IN ('PENDING', 'RETRY_SCHEDULED')
           AND d.next_attempt_at <= clock_timestamp() + make_interval(secs => ?::double precision / 1000)
         RETURNING d.id::text AS id, d.public_id::text AS public_id, ${CREATED_AT_KEY_SQL('d')} AS created_at,
           (extract(epoch FROM d.created_at) * 1000)::float8 AS created_at_ms, d.endpoint_id::text AS endpoint_id,
           d.message_id::text AS message_id, d.attempts_total, d.cycle_base, d.local_failures`,
        [leaseMs, publicId, skewMs],
      ),
    );
    return r ? toClaimed(r) : undefined;
  }
  async cancelClaimed(ref: DeliveryRef, attempts: number): Promise<boolean> {
    return (
      OkRows.parse(
        await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'CANCELLED', lease_until = NULL, completed_at = clock_timestamp(), last_error = 'ENDPOINT_UNAVAILABLE',
             version = version + 1, updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [ref.id, ref.createdAt, attempts],
        ),
      ).length === 1
    );
  }
  async messageOf(
    ref: DeliveryRef & { messageId: string },
  ): Promise<{ eventId: string; eventType: string; body: string }> {
    const [r] = z
      .array(
        z.object({
          event_id: z.uuid(),
          event_type: z.string(),
          body: z.string(),
        }),
      )
      .parse(
        await this.db.execute(
          `SELECT event_id::text AS event_id, event_type, body FROM webhook_messages
           WHERE org_id = app_current_org() AND id = ?::bigint AND created_at = ?::timestamptz`,
          [ref.messageId, ref.createdAt],
        ),
      );
    if (!r)
      throw new Error(
        `webhook message of delivery ${ref.publicId} is missing (FK should make this impossible)`,
      );
    return { eventId: r.event_id, eventType: r.event_type, body: r.body };
  }
  async describe(
    ref: DeliveryRef & { endpointId: string; messageId: string },
  ): Promise<{ endpointPublicId: string; eventType: string; eventId: string }> {
    const [r] = z
      .array(
        z.object({
          endpoint_public_id: z.uuid(),
          event_type: z.string(),
          event_id: z.uuid(),
        }),
      )
      .parse(
        await this.db.execute(
          `SELECT e.public_id::text AS endpoint_public_id, m.event_type, m.event_id::text AS event_id
           FROM webhook_messages m JOIN webhook_endpoints e ON e.org_id = m.org_id AND e.id = ?::bigint
           WHERE m.org_id = app_current_org() AND m.id = ?::bigint AND m.created_at = ?::timestamptz`,
          [ref.endpointId, ref.messageId, ref.createdAt],
        ),
      );
    // Bất biến R-X33 (mọi delivery có endpoint) bị vỡ là bug: fail to, không đoán.
    if (!r)
      throw new Error(
        `delivery ${ref.publicId} has no message or no endpoint row (R-X33 invariant broken)`,
      );
    return {
      endpointPublicId: r.endpoint_public_id,
      eventType: r.event_type,
      eventId: r.event_id,
    };
  }
  async unclaim(
    ref: DeliveryRef,
    attempts: number,
    delayMs: number,
  ): Promise<boolean> {
    return (
      OkRows.parse(
        await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'RETRY_SCHEDULED', lease_until = NULL,
             next_attempt_at = clock_timestamp() + make_interval(secs => ?::double precision / 1000), cycle_base = cycle_base + 1,
             version = version + 1, updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [delayMs, ref.id, ref.createdAt, attempts],
        ),
      ).length === 1
    );
  }
  async finish(
    ref: DeliveryRef,
    attempts: number,
    result: DeliveryResult,
  ): Promise<boolean> {
    const key = [ref.id, ref.createdAt, attempts];
    let rows: object[];
    switch (result.kind) {
      case 'SUCCEEDED':
        rows = await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'SUCCEEDED', lease_until = NULL, completed_at = clock_timestamp(), last_status_code = ?::integer,
             last_error = NULL, version = version + 1, updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [result.statusCode, ...key],
        );
        break;
      case 'RETRY':
        rows = await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'RETRY_SCHEDULED', lease_until = NULL,
             next_attempt_at = clock_timestamp() + make_interval(secs => ?::double precision / 1000), cycle_base = cycle_base + ?::integer,
             local_failures = local_failures + ?::integer, last_status_code = ?::integer, last_error = ?, version = version + 1,
             updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [
            result.delayMs,
            result.cycleBump,
            result.localBump,
            result.statusCode,
            result.error,
            ...key,
          ],
        );
        break;
      case 'EXHAUSTED':
        rows = await this.db.execute(
          `UPDATE webhook_deliveries SET status = 'EXHAUSTED', lease_until = NULL, completed_at = clock_timestamp(), last_status_code = ?::integer,
             last_error = ?, local_failures = local_failures + ?::integer, version = version + 1, updated_at = clock_timestamp()
           WHERE ${ROW_KEY} AND ${FENCE} RETURNING 1 AS ok`,
          [result.statusCode, result.error, result.localBump, ...key],
        );
        break;
      default: {
        const unreachable: never = result;
        throw new Error(
          `Unhandled delivery result ${JSON.stringify(unreachable)}`,
        );
      }
    }
    return OkRows.parse(rows).length === 1;
  }
  async defer(
    publicId: string,
    delayMs: number,
    skewMs: number,
  ): Promise<number | undefined> {
    const [r] = z.array(z.object({ attempts_total: z.number().int() })).parse(
      await this.db.execute(
        `UPDATE webhook_deliveries
           SET next_attempt_at = GREATEST(next_attempt_at, clock_timestamp() + make_interval(secs => ?::double precision / 1000)),
               updated_at = clock_timestamp()
           WHERE org_id = app_current_org() AND public_id = ?::uuid AND status IN ('PENDING', 'RETRY_SCHEDULED')
             AND next_attempt_at <= clock_timestamp() + make_interval(secs => ?::double precision / 1000)
           RETURNING attempts_total`,
        [delayMs, publicId, skewMs],
      ),
    );
    return r?.attempts_total;
  }
  async takeOverdue(
    graceSec: number,
    limit: number,
  ): Promise<{ publicId: string; attemptsTotal: number }[]> {
    return z
      .array(
        z.object({ public_id: z.uuid(), attempts_total: z.number().int() }),
      )
      .parse(
        await this.db.execute(
          `UPDATE webhook_deliveries AS d SET next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
           FROM (SELECT id, created_at FROM webhook_deliveries
                 WHERE org_id = app_current_org() AND status IN ('PENDING', 'RETRY_SCHEDULED')
                   AND next_attempt_at <= clock_timestamp() - make_interval(secs => ?::integer)
                 ORDER BY next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED) AS o
           WHERE d.org_id = app_current_org() AND d.id = o.id AND d.created_at = o.created_at
           RETURNING d.public_id::text AS public_id, d.attempts_total`,
          [graceSec, limit],
        ),
      )
      .map((r) => ({ publicId: r.public_id, attemptsTotal: r.attempts_total }));
  }
  async expiredLeases(
    graceSec: number,
    limit: number,
  ): Promise<ClaimedDelivery[]> {
    return ClaimRow.parse(
      await this.db.execute(
        `SELECT d.id::text AS id, d.public_id::text AS public_id, ${CREATED_AT_KEY_SQL('d')} AS created_at,
           (extract(epoch FROM d.created_at) * 1000)::float8 AS created_at_ms, d.endpoint_id::text AS endpoint_id,
           d.message_id::text AS message_id, d.attempts_total, d.cycle_base, d.local_failures
         FROM webhook_deliveries d
         WHERE d.org_id = app_current_org() AND d.status = 'SENDING' AND d.lease_until <= clock_timestamp() - make_interval(secs => ?::integer)
         ORDER BY d.lease_until LIMIT ? FOR UPDATE SKIP LOCKED`,
        [graceSec, limit],
      ),
    ).map(toClaimed);
  }

  async view(publicId: string): Promise<DeliveryView | undefined> {
    const [r] = await this.db.execute(
      `SELECT ${VIEW_COLUMNS} ${VIEW_FROM} WHERE d.org_id = app_current_org() AND d.public_id = ?::uuid`,
      [publicId],
    );
    return r ? toView(r) : undefined;
  }
  async listByEndpoint(
    endpointId: string,
    q: {
      status?: DeliveryStatus;
      limit: number;
      after?: { createdAt: string; publicId: string };
    },
  ): Promise<DeliveryView[]> {
    const where = ['d.org_id = app_current_org()', 'd.endpoint_id = ?::bigint'];
    const params: unknown[] = [endpointId];
    if (q.status !== undefined) {
      where.push('d.status = ?');
      params.push(q.status);
    }
    if (q.after !== undefined) {
      where.push('(d.created_at, d.public_id) < (?::timestamptz, ?::uuid)');
      params.push(q.after.createdAt, q.after.publicId);
    }
    params.push(q.limit);
    return (
      await this.db.execute(
        `SELECT ${VIEW_COLUMNS} ${VIEW_FROM} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.public_id DESC LIMIT ?`,
        params,
      )
    ).map(toView);
  }
  async requeue(
    publicId: string,
  ): Promise<{ attemptsTotal: number } | undefined> {
    const [r] = z
      .array(z.object({ attempts_total: z.number().int() }))
      .parse(
        await this.db.execute(
          `UPDATE webhook_deliveries AS d SET ${REQUEUE_SET} WHERE d.org_id = app_current_org() AND d.public_id = ?::uuid AND ${TERMINAL} RETURNING d.attempts_total`,
          [publicId],
        ),
      );
    return r ? { attemptsTotal: r.attempts_total } : undefined;
  }
  async recover(
    endpointId: string,
    since: string,
    max: number,
  ): Promise<{ publicId: string; attemptsTotal: number }[]> {
    return z
      .array(
        z.object({ public_id: z.uuid(), attempts_total: z.number().int() }),
      )
      .parse(
        await this.db.execute(
          `WITH picked AS (
             SELECT d.id, d.created_at FROM webhook_deliveries d WHERE ${RECOVERABLE}
             ORDER BY d.created_at, d.id LIMIT ? FOR UPDATE SKIP LOCKED)
           UPDATE webhook_deliveries AS d SET ${REQUEUE_SET}
           FROM picked WHERE d.id = picked.id AND d.created_at = picked.created_at AND d.org_id = app_current_org() AND ${TERMINAL}
           RETURNING d.public_id::text AS public_id, d.attempts_total`,
          [endpointId, since, max],
        ),
      )
      .map((r) => ({ publicId: r.public_id, attemptsTotal: r.attempts_total }));
  }
  async hasRecoverable(endpointId: string, since: string): Promise<boolean> {
    const [r] = z
      .array(z.object({ more: z.boolean() }))
      .parse(
        await this.db.execute(
          `SELECT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE ${RECOVERABLE}) AS more`,
          [endpointId, since],
        ),
      );
    return r?.more ?? false;
  }
}
