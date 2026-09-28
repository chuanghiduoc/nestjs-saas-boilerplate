import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../../../../src/core/database/index.js';
import { EventPublisher } from '../../../../src/core/events/index.js';
import { JobContext } from '../../../../src/core/queue/index.js';
import { FieldCipher } from '../../../../src/core/security/index.js';
import { SendEmailHandler } from '../../../../src/modules/notifications/application/send-email.handler.js';
import { deliveryAad } from '../../../../src/modules/notifications/domain/email-delivery.js';
import { MailSendError } from '../../../../src/modules/notifications/errors.js';
import {
  notificationsConfig,
  smtpConfig,
} from '../../../../src/modules/notifications/notifications.config.js';
import {
  DeliveryRepository,
  type ClaimedDelivery,
} from '../../../../src/modules/notifications/ports/delivery-repository.js';
import { MailTransport } from '../../../../src/modules/notifications/ports/mail-transport.js';
import { TemplateRenderer } from '../../../../src/modules/notifications/ports/template-renderer.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

const otel = installOtelCapture();
const id = '0199aaaa-0000-7000-8000-000000000002';
const PII_EMAIL = 'leak-me@example.test';
const cipher = new FieldCipher(
  { k1: randomBytes(32).toString('base64') },
  'k1',
);

async function fixture() {
  const claimed: ClaimedDelivery = {
    publicId: id,
    template: 'verify-email',
    locale: 'en',
    attempts: 1,
    recipientEnc: cipher.encrypt(PII_EMAIL, deliveryAad('recipient_enc', id)),
    paramsEnc: cipher.encrypt(
      JSON.stringify({ name: 'U', url: 'https://example.test/verify' }),
      deliveryAad('params_enc', id),
    ),
  };
  const repo = {
    claim: vi.fn().mockResolvedValue(claimed),
    release: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('verify-email'),
    complete: vi.fn().mockResolvedValue(true),
  };
  const transport = { send: vi.fn().mockResolvedValue(undefined) };
  const events = { publish: vi.fn().mockResolvedValue(id) };
  const module = await Test.createTestingModule({
    providers: [
      SendEmailHandler,
      { provide: DeliveryRepository, useValue: repo },
      {
        provide: TemplateRenderer,
        useValue: {
          render: vi.fn().mockReturnValue({
            subject: 'Verify',
            html: '<p>Verify</p>',
            text: 'Verify',
          }),
        },
      },
      { provide: MailTransport, useValue: transport },
      { provide: FieldCipher, useValue: cipher },
      {
        provide: UnitOfWork,
        useValue: { run: <T>(fn: () => Promise<T>) => fn() },
      },
      { provide: EventPublisher, useValue: events },
      {
        provide: notificationsConfig.KEY,
        useValue: notificationsConfig.schema.parse({}),
      },
      {
        provide: smtpConfig.KEY,
        useValue: {
          ...smtpConfig.schema.parse({}),
          mailFrom: 'App <sender@example.test>',
        },
      },
    ],
  }).compile();
  const controller = new AbortController();
  const ctx: JobContext<{ deliveryId: string }> = {
    payload: { deliveryId: id },
    meta: {},
    jobId: id,
    attempt: 1,
    maxAttempts: 3,
    signal: controller.signal,
    log: new Logger('test'),
  };
  return {
    module,
    handler: module.get(SendEmailHandler),
    repo,
    transport,
    ctx,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  otel.reset();
});

describe('SendEmailHandler spans record failure (final review M3)', () => {
  it('a successful send leaves every notifications.email.* span UNSET, never ERROR', async () => {
    const f = await fixture();
    try {
      await expect(f.handler.handle(f.ctx)).resolves.toBeUndefined();
      for (const name of [
        'notifications.email.claim',
        'notifications.email.render',
        'notifications.email.send',
      ]) {
        const [span] = otel.spans(name);
        expect(span?.status.code).toBe(SpanStatusCode.UNSET);
      }
    } finally {
      await f.module.close();
    }
  });

  it('an SMTP send failure marks notifications.email.send ERROR with error.type and the MailErrorCode, no message/PII', async () => {
    const f = await fixture();
    try {
      f.transport.send.mockRejectedValue(
        new MailSendError('SMTP_PERMANENT', 550, 'RCPT TO'),
      );
      await expect(f.handler.handle(f.ctx)).rejects.toBeInstanceOf(Error);
      const [span] = otel.spans('notifications.email.send');
      expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span?.attributes).toEqual({
        'error.type': 'MailSendError',
        'notifications.error_code': 'SMTP_PERMANENT',
      });
      // OTel's recordException prefers `.code` over `.name` for exception.type (same as identitySpan/S2-R30:
      // see identity-telemetry.spec.ts "an AppError is recorded by its code, not its detail").
      expect(span?.events.map((e) => [e.name, e.attributes])).toEqual([
        ['exception', { 'exception.type': 'SMTP_PERMANENT' }],
      ]);
      const serialized = JSON.stringify([
        span?.attributes,
        span?.events,
        span?.status,
      ]);
      expect(serialized).not.toContain('SMTP send failed');
      expect(serialized).not.toContain('RCPT TO');
      expect(serialized).not.toContain(PII_EMAIL);
    } finally {
      await f.module.close();
    }
  });

  it('a render failure marks notifications.email.render ERROR by class name only, no message/PII', async () => {
    const f = await fixture();
    try {
      f.repo.claim.mockResolvedValue({
        publicId: id,
        template: 'verify-email',
        locale: 'en',
        attempts: 1,
        recipientEnc: cipher.encrypt(
          PII_EMAIL,
          deliveryAad('recipient_enc', id),
        ),
        // Params fail TEMPLATE_PARAMS zod parsing -> ZodError inside render().
        paramsEnc: cipher.encrypt(
          JSON.stringify({ name: PII_EMAIL }),
          deliveryAad('params_enc', id),
        ),
      } satisfies ClaimedDelivery);
      await expect(f.handler.handle(f.ctx)).rejects.toBeInstanceOf(Error);
      const [span] = otel.spans('notifications.email.render');
      expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span?.attributes).toEqual({ 'error.type': 'ZodError' });
      const serialized = JSON.stringify([
        span?.attributes,
        span?.events,
        span?.status,
      ]);
      expect(serialized).not.toContain(PII_EMAIL);
    } finally {
      await f.module.close();
    }
  });
});
