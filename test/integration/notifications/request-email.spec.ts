import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { AppError } from '../../../src/core/errors/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import {
  FieldCipher,
  FieldCipherError,
  SecurityModule,
} from '../../../src/core/security/index.js';
import { deliveryAad } from '../../../src/modules/notifications/domain/email-delivery.js';
import { InvalidEmailRequestError } from '../../../src/modules/notifications/errors.js';
import {
  EmailNotifications,
  NotificationsModule,
} from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';

describe('EmailNotifications.request', () => {
  let app: INestApplication;
  let owner: pg.Client;
  beforeAll(async () => {
    app = await createTestApp([
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      QueueModule.forRoot({ runWorkers: false }),
      OutboxModule.forRoot({ relay: false }),
      EventsModule.forRoot({ worker: false }),
      SecurityModule,
      NotificationsModule.forApi(),
    ]);
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
    await app?.close();
  });

  it('stores an encrypted row and defers the send job with jobId <public_id>-g0 through the outbox', async () => {
    const key = `verify-email:${v7()}`;
    const res = await app.get(EmailNotifications).request({
      template: 'verify-email',
      to: 'Alice@Example.test',
      idempotencyKey: key,
      params: {
        name: 'Alice',
        url: 'https://app.example.test/verify?token=abc',
      },
    });
    expect(res).toEqual({ created: true });
    const { rows } = await owner.query(
      'SELECT public_id, state, locale, recipient_enc, params_enc, attempts, enqueue_generation FROM email_deliveries WHERE idempotency_key = $1',
      [key],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'PENDING',
      locale: 'en',
      attempts: 0,
      enqueue_generation: 0,
    });
    expect(rows[0].recipient_enc).not.toContain('Alice');
    expect(rows[0].params_enc).not.toContain('token=abc');
    // Review FB2-1: mỗi cột giải mã được bằng đúng AAD của nó (cột + public_id), và KHÔNG bằng AAD của cột kia.
    const cipher = app.get(FieldCipher);
    const id: string = rows[0].public_id;
    expect(
      cipher.decrypt(rows[0].recipient_enc, deliveryAad('recipient_enc', id)),
    ).toBe('Alice@Example.test');
    expect(
      JSON.parse(
        cipher.decrypt(rows[0].params_enc, deliveryAad('params_enc', id)),
      ),
    ).toEqual({
      name: 'Alice',
      url: 'https://app.example.test/verify?token=abc',
    });
    expect(() =>
      cipher.decrypt(rows[0].recipient_enc, deliveryAad('params_enc', id)),
    ).toThrow(FieldCipherError);
    expect(() =>
      cipher.decrypt(rows[0].params_enc, deliveryAad('recipient_enc', id)),
    ).toThrow(FieldCipherError);
    const job = await owner.query(
      `SELECT payload->>'jobId' AS job_id, payload->'payload' AS p FROM outbox_events WHERE type = 'core.job.deferred' AND payload->>'job' = 'notifications.send-email' AND payload->'payload'->>'deliveryId' = $1`,
      [rows[0].public_id],
    );
    expect(job.rows).toEqual([
      {
        job_id: `${rows[0].public_id}-g0`,
        p: { deliveryId: rows[0].public_id },
      },
    ]);
  });
  it('the same idempotency key creates nothing the second time', async () => {
    const key = `reset-password:${v7()}`;
    const req = {
      template: 'reset-password' as const,
      to: 'b@example.test',
      idempotencyKey: key,
      params: { name: 'B', url: 'https://app.example.test/reset?t=1' },
    };
    await app.get(EmailNotifications).request(req);
    expect(await app.get(EmailNotifications).request(req)).toEqual({
      created: false,
    });
    const { rows } = await owner.query(
      'SELECT count(*)::int AS n FROM email_deliveries WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0].n).toBe(1);
    // Review FB2-5: lần gọi thứ hai không ghi thêm job hoãn nào vào outbox.
    const jobs = await owner.query(
      `SELECT count(*)::int AS n FROM outbox_events o JOIN email_deliveries d ON d.public_id::text = o.payload->'payload'->>'deliveryId'
        WHERE o.type = 'core.job.deferred' AND d.idempotency_key = $1`,
      [key],
    );
    expect(jobs.rows[0].n).toBe(1);
  });
  it('rejects params outside the template schema and a key of another template, without writing', async () => {
    const svc = app.get(EmailNotifications);
    const badParamsKey = `verify-email:${v7()}`;
    const foreignKey = `reset-password:${v7()}`;
    const badParams = await svc
      .request({
        template: 'verify-email',
        to: 'c@example.test',
        idempotencyKey: badParamsKey,
        params: { name: 'C\r\nBcc: x@y', url: 'https://a.test' },
      })
      .catch((e: unknown) => e);
    // Review FB2-3: lỗi dùng sai của caller có tên riêng, không phải AppError (không thành 4xx).
    expect(badParams).toBeInstanceOf(InvalidEmailRequestError);
    expect(badParams).not.toBeInstanceOf(AppError);
    expect(String(badParams)).toMatch(
      /invalid params for template verify-email/,
    );
    await expect(
      svc.request({
        template: 'verify-email',
        to: 'c@example.test',
        idempotencyKey: foreignKey,
        params: { name: 'C', url: 'https://a.test' },
      }),
    ).rejects.toThrow(InvalidEmailRequestError);
    // Review FB2-2: `to` được kiểm bằng z.email() ở biên; message không chứa giá trị (PII).
    const badToKey = `verify-email:${v7()}`;
    const badTo = await svc
      .request({
        template: 'verify-email',
        to: 'not-an-email\r\nBcc: evil@example.test',
        idempotencyKey: badToKey,
        params: { name: 'C', url: 'https://a.test' },
      })
      .catch((e: unknown) => e);
    expect(badTo).toBeInstanceOf(InvalidEmailRequestError);
    expect(String(badTo)).toMatch(/invalid recipient address/);
    expect(String(badTo)).not.toContain('evil@example.test');
    const written = await owner.query(
      'SELECT count(*)::int AS n FROM email_deliveries WHERE idempotency_key = ANY($1)',
      [[badParamsKey, foreignKey, badToKey]],
    );
    expect(written.rows[0].n).toBe(0);
  });
});
