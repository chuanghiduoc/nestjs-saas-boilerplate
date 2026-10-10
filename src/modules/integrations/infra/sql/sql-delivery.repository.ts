import { Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { DeliveryRepository } from '../../ports/delivery-repository.js';
import { CREATED_AT_KEY_SQL } from './created-at-key.js';

const MessageRow = z.array(
  z.object({ id: z.string(), created_at: z.string() }),
);

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
}
