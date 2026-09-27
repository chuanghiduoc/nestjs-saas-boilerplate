import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../../../src/core/database/index.js';
import { EventPublisher } from '../../../src/core/events/index.js';
import { errSerializer } from '../../../src/core/logging/index.js';
import { JobPayloadError } from '../../../src/core/queue/index.js';
import { FieldCipher } from '../../../src/core/security/index.js';
import { SendEmailHandler } from '../../../src/modules/notifications/application/send-email.handler.js';
import { deliveryAad } from '../../../src/modules/notifications/domain/email-delivery.js';
import { MailSendError } from '../../../src/modules/notifications/errors.js';
import {
  notificationsConfig,
  smtpConfig,
} from '../../../src/modules/notifications/notifications.config.js';
import {
  DeliveryRepository,
  type ClaimedDelivery,
} from '../../../src/modules/notifications/ports/delivery-repository.js';
import { MailTransport } from '../../../src/modules/notifications/ports/mail-transport.js';
import { TemplateRenderer } from '../../../src/modules/notifications/ports/template-renderer.js';

const id = '0199aaaa-0000-7000-8000-000000000001';
const cipher = new FieldCipher(
  { k1: randomBytes(32).toString('base64') },
  'k1',
);
async function fixture(
  mailFrom: string | undefined = 'App <sender@example.test>',
) {
  const claimed: ClaimedDelivery = {
    publicId: id,
    template: 'verify-email',
    locale: 'en',
    attempts: 1,
    recipientEnc: cipher.encrypt(
      'recipient@example.test',
      deliveryAad('recipient_enc', id),
    ),
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
        useValue: { ...smtpConfig.schema.parse({}), mailFrom },
      },
    ],
  }).compile();
  const controller = new AbortController();
  const ctx = {
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
    claimed,
    repo,
    transport,
    events,
    ctx,
    controller,
  };
}

afterEach(() => vi.restoreAllMocks());
describe('SendEmailHandler failure classification', () => {
  it('reports success and logs lease loss when completion is fenced out', async () => {
    const f = await fixture();
    try {
      f.repo.complete.mockResolvedValue(false);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      await expect(f.handler.handle(f.ctx)).resolves.toBeUndefined();
      expect(f.transport.send).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { deliveryId: id, event: 'delivery_lease_lost' },
        'delivery_lease_lost',
      );
      expect(f.repo.fail).not.toHaveBeenCalled();
      expect(f.repo.release).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
  it.each(['render', 'fenced-release'] as const)(
    'does not leak the recipient through %s logging or serialized errors',
    async (path) => {
      const f = await fixture();
      try {
        const address = 'recipient@example.test';
        const lines: string[] = [];
        for (const level of [
          'log',
          'warn',
          'error',
          'debug',
          'verbose',
          'fatal',
        ] as const)
          vi.spyOn(Logger.prototype, level).mockImplementation(
            (...args: unknown[]) => {
              lines.push(
                JSON.stringify(args, (_key, value: unknown) =>
                  value instanceof Error ? errSerializer(value) : value,
                ),
              );
            },
          );
        if (path === 'render') {
          f.claimed.paramsEnc = cipher.encrypt(
            JSON.stringify({ name: address, url: address }),
            deliveryAad('params_enc', id),
          );
        } else {
          f.repo.release.mockResolvedValue(false);
          f.transport.send.mockRejectedValue(
            new MailSendError('SMTP_TRANSIENT'),
          );
        }
        const error: unknown = await f.handler
          .handle(f.ctx)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(errSerializer(error))).not.toContain(address);
        expect(JSON.stringify(lines)).not.toContain(address);
        expect(JSON.stringify(lines)).toContain(
          path === 'render' ? 'delivery_render_failed' : 'delivery_lease_lost',
        );
      } finally {
        await f.module.close();
      }
    },
  );
  it('releases an unknown key even on the last attempt without failing or sending', async () => {
    const f = await fixture();
    try {
      const rotated = new FieldCipher(
        { k2: randomBytes(32).toString('base64') },
        'k2',
      );
      f.claimed.paramsEnc = rotated.encrypt(
        '{}',
        deliveryAad('params_enc', id),
      );
      const error: unknown = await f.handler
        .handle({ ...f.ctx, attempt: 3 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(JobPayloadError);
      expect(error).toMatchObject({ name: 'DeliveryKeyUnavailableError' });
      expect(f.repo.release).toHaveBeenCalledWith(id, expect.any(String), null);
      expect(f.repo.fail).not.toHaveBeenCalled();
      expect(f.events.publish).not.toHaveBeenCalled();
      expect(f.transport.send).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
  it('fails AEAD authentication permanently', async () => {
    const f = await fixture();
    try {
      f.claimed.paramsEnc = cipher.encrypt('{}', 'wrong-aad');
      await expect(f.handler.handle(f.ctx)).rejects.toBeInstanceOf(
        JobPayloadError,
      );
      expect(f.repo.fail).toHaveBeenCalledWith(id, expect.any(String), null);
      expect(f.repo.release).not.toHaveBeenCalled();
      expect(f.events.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          data: {
            deliveryId: id,
            template: 'verify-email',
            errorCode: 'RENDER_FAILED',
          },
        }),
      );
    } finally {
      await f.module.close();
    }
  });
  it('a permanent SMTP rejection wins over shutdown', async () => {
    const f = await fixture();
    try {
      f.transport.send.mockImplementation(async () => {
        f.controller.abort();
        throw new MailSendError('SMTP_PERMANENT', 550, 'RCPT TO');
      });
      await expect(f.handler.handle(f.ctx)).rejects.toBeInstanceOf(
        JobPayloadError,
      );
      expect(f.repo.fail).toHaveBeenCalledWith(
        id,
        expect.any(String),
        'SMTP_PERMANENT',
      );
      expect(f.repo.release).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });
  it.each(['', 'invalid', 'sender@', 'sender@>'])(
    'fails loudly for an unavailable Message-ID domain: %s',
    async (from) => {
      const f = await fixture(from);
      try {
        const warn = vi
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => {});
        await expect(f.handler.handle(f.ctx)).rejects.toBeInstanceOf(
          JobPayloadError,
        );
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ errName: 'MessageIdDomainError' }),
          'delivery_render_failed',
        );
        expect(f.transport.send).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );
});
