import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../core/database/index.js';
import type { DeliveryState } from '../domain/email-delivery.js';
import { DELIVERY_STATES } from '../domain/email-delivery.js';
import type { MailErrorCode } from '../errors.js';
import {
  DeliveryRepository,
  type ClaimedDelivery,
  type NewDelivery,
  type StaleDelivery,
} from '../ports/delivery-repository.js';
import { TEMPLATE_KEYS, type TemplateKey } from '../templates.js';

const STUCK = `(state = 'PENDING' OR (state = 'SENDING' AND lease_until < now()))`;
const ClaimRow = z.object({
  public_id: z.string(),
  template: z.enum(TEMPLATE_KEYS),
  locale: z.string(),
  recipient_enc: z.string(),
  params_enc: z.string(),
  attempts: z.number().int(),
});
const StatusRow = z.object({
  state: z.enum(DELIVERY_STATES),
  lease_active: z.boolean().nullable(),
});
const TemplateRow = z.object({ template: z.enum(TEMPLATE_KEYS) });
const StaleRow = z.object({
  public_id: z.string(),
  attempts: z.number().int(),
});
const GenRow = z.object({ enqueue_generation: z.number().int() });
const CountRow = z.object({ n: z.number().int() });

/** SQL trên connection `app` (`app_user`, grant UPDATE theo cột). Không RLS: bảng global. */
@Injectable()
export class SqlDeliveryRepository extends DeliveryRepository {
  constructor(private readonly db: Db) {
    super();
  }

  async insert(d: NewDelivery): Promise<boolean> {
    const rows = await this.db.execute(
      `INSERT INTO email_deliveries (public_id, template, locale, recipient_enc, params_enc, state, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?) ON CONFLICT (idempotency_key) DO NOTHING RETURNING public_id`,
      [
        d.publicId,
        d.template,
        d.locale,
        d.recipientEnc,
        d.paramsEnc,
        d.idempotencyKey,
      ],
    );
    return rows.length === 1;
  }

  async claim(
    publicId: string,
    owner: string,
    leaseMs: number,
  ): Promise<ClaimedDelivery | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries
          SET state = 'SENDING', lease_owner = ?, lease_until = now() + make_interval(secs => ?::double precision / 1000),
              attempts = attempts + 1, updated_at = now()
        WHERE public_id = ? AND ${STUCK} AND params_enc IS NOT NULL
        RETURNING public_id, template, locale, recipient_enc, params_enc, attempts`,
      [owner, leaseMs, publicId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const r = ClaimRow.parse(row);
    return {
      publicId: r.public_id,
      template: r.template,
      locale: r.locale,
      recipientEnc: r.recipient_enc,
      paramsEnc: r.params_enc,
      attempts: r.attempts,
    };
  }

  async status(
    publicId: string,
  ): Promise<{ state: DeliveryState; leaseActive: boolean } | undefined> {
    const rows = await this.db.execute(
      `SELECT state, lease_until > now() AS lease_active FROM email_deliveries WHERE public_id = ?`,
      [publicId],
    );
    if (!rows[0]) return undefined;
    const r = StatusRow.parse(rows[0]);
    return { state: r.state, leaseActive: r.lease_active === true };
  }

  async complete(publicId: string, owner: string): Promise<boolean> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'SENT', completed_at = now(), params_enc = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE public_id = ? AND state = 'SENDING' AND lease_owner = ? RETURNING 1 AS ok`,
      [publicId, owner],
    );
    return rows.length === 1;
  }

  async release(
    publicId: string,
    owner: string,
    code: MailErrorCode | null,
  ): Promise<boolean> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'PENDING', lease_owner = NULL, lease_until = NULL, last_error_code = ?, updated_at = now()
        WHERE public_id = ? AND state = 'SENDING' AND lease_owner = ? RETURNING 1 AS ok`,
      [code, publicId, owner],
    );
    return rows.length === 1;
  }

  async fail(
    publicId: string,
    owner: string,
    code: MailErrorCode | null,
  ): Promise<TemplateKey | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'FAILED', lease_owner = NULL, lease_until = NULL, completed_at = now(), params_enc = NULL,
              last_error_code = COALESCE(?, last_error_code), updated_at = now()
        WHERE public_id = ? AND state = 'SENDING' AND lease_owner = ? RETURNING template`,
      [code, publicId, owner],
    );
    return rows[0] ? TemplateRow.parse(rows[0]).template : undefined;
  }

  async findStale(
    cooldownSec: number,
    limit: number,
  ): Promise<StaleDelivery[]> {
    const rows = await this.db.execute(
      `SELECT public_id, attempts FROM email_deliveries
        WHERE state IN ('PENDING', 'SENDING') AND last_enqueued_at < now() - make_interval(secs => ?) AND ${STUCK}
        ORDER BY last_enqueued_at LIMIT ?`,
      [cooldownSec, limit],
    );
    return rows
      .map((r) => StaleRow.parse(r))
      .map((r) => ({ publicId: r.public_id, attempts: r.attempts }));
  }

  async failExhausted(
    publicId: string,
    maxAttempts: number,
  ): Promise<TemplateKey | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET state = 'FAILED', lease_owner = NULL, lease_until = NULL, completed_at = now(), params_enc = NULL, updated_at = now()
        WHERE public_id = ? AND attempts >= ? AND ${STUCK} RETURNING template`,
      [publicId, maxAttempts],
    );
    return rows[0] ? TemplateRow.parse(rows[0]).template : undefined;
  }

  async bumpGeneration(
    publicId: string,
    cooldownSec: number,
    maxAttempts: number,
  ): Promise<number | undefined> {
    const rows = await this.db.execute(
      `UPDATE email_deliveries SET enqueue_generation = enqueue_generation + 1, last_enqueued_at = now(), updated_at = now()
        WHERE public_id = ? AND attempts < ? AND last_enqueued_at < now() - make_interval(secs => ?) AND ${STUCK}
        RETURNING enqueue_generation`,
      [publicId, maxAttempts, cooldownSec],
    );
    return rows[0] ? GenRow.parse(rows[0]).enqueue_generation : undefined;
  }

  async purge(retentionDays: number, limit: number): Promise<number> {
    // `e.state IN (...)` lặp lại điều kiện đã chọn `victim`: phòng hờ (review FB5), không đổi hành vi hôm nay vì
    // không có UPDATE nào đưa SENT/FAILED trở lại PENDING/SENDING, nhưng khiến câu DELETE tự đứng vững một mình.
    const rows = await this.db.execute(
      `WITH victim AS (SELECT id FROM email_deliveries WHERE state IN ('SENT', 'FAILED') AND created_at < now() - make_interval(days => ?) ORDER BY created_at LIMIT ?)
       , d AS (DELETE FROM email_deliveries e USING victim v WHERE e.id = v.id AND e.state IN ('SENT', 'FAILED') RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
      [retentionDays, limit],
    );
    return CountRow.parse(rows[0]).n;
  }
}
