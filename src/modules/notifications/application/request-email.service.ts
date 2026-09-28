import { Inject, Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import { z } from 'zod';
import { type ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { FieldCipher } from '../../../core/security/index.js';
import { deliveryAad } from '../domain/email-delivery.js';
import { InvalidEmailRequestError } from '../errors.js';
import { SendEmailJob, sendEmailJobId } from '../jobs.js';
import { notificationsConfig } from '../notifications.config.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';
import {
  EmailNotifications,
  type EmailRequest,
} from '../ports/email-notifications.js';
import { TEMPLATE_PARAMS, type TemplateKey } from '../templates.js';

const recipient = z.email();

@Injectable()
export class RequestEmailService extends EmailNotifications {
  constructor(
    private readonly repo: DeliveryRepository,
    private readonly uow: UnitOfWork,
    private readonly enqueue: SafeEnqueue,
    private readonly cipher: FieldCipher,
    @Inject(notificationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof notificationsConfig>,
  ) {
    super();
  }

  /**
   * INSERT … ON CONFLICT DO NOTHING rồi SafeEnqueue trong cùng transaction (job đi qua outbox, chỉ tồn tại
   * khi dòng đã commit). Lỗi của caller (params, key) nổ trước khi ghi; message không chứa giá trị.
   */
  async request<K extends TemplateKey>(
    req: EmailRequest<K>,
  ): Promise<{ created: boolean }> {
    const parsed = TEMPLATE_PARAMS[req.template].safeParse(req.params);
    if (!parsed.success)
      throw new InvalidEmailRequestError(
        `invalid params for template ${req.template}: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    if (!req.idempotencyKey.startsWith(`${req.template}:`))
      throw new InvalidEmailRequestError(
        `idempotency key must start with "${req.template}:"`,
      );
    if (!recipient.safeParse(req.to).success)
      throw new InvalidEmailRequestError('invalid recipient address');
    const publicId = v7();
    return this.uow.run(async () => {
      const created = await this.repo.insert({
        publicId,
        template: req.template,
        locale: this.cfg.defaultLocale,
        recipientEnc: this.cipher.encrypt(
          req.to,
          deliveryAad('recipient_enc', publicId),
        ),
        paramsEnc: this.cipher.encrypt(
          JSON.stringify(parsed.data),
          deliveryAad('params_enc', publicId),
        ),
        idempotencyKey: req.idempotencyKey,
      });
      if (created)
        await this.enqueue.enqueue(
          SendEmailJob,
          { deliveryId: publicId },
          { jobId: sendEmailJobId(publicId, 0) },
        );
      return { created };
    });
  }
}
