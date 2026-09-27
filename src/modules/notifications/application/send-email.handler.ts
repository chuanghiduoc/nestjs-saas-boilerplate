import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { v7 } from 'uuid';
import { type ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import {
  JobHandler,
  JobPayloadError,
  type JobContext,
} from '../../../core/queue/index.js';
import { FieldCipher } from '../../../core/security/index.js';
import { deliveryAad, isFinal } from '../domain/email-delivery.js';
import {
  DeliveryLeaseBusyError,
  MailSendError,
  isTransientMailError,
  type MailErrorCode,
} from '../errors.js';
import { DeliveryFailedEvent, type DeliveryFailureCode } from '../events.js';
import { SendEmailJob } from '../jobs.js';
import { notificationsConfig, smtpConfig } from '../notifications.config.js';
import {
  DeliveryRepository,
  type ClaimedDelivery,
} from '../ports/delivery-repository.js';
import { MailTransport, type OutgoingMail } from '../ports/mail-transport.js';
import { TemplateRenderer } from '../ports/template-renderer.js';
import { TEMPLATE_PARAMS } from '../templates.js';

const TELEMETRY = 'notifications';
const SYSTEM_ACTOR = { type: 'system', id: 'notifications' } as const;
/** Chỉ khi MAIL_FROM không tách được domain; luật `smtp-required-on-worker` bắt buộc MAIL_FROM trên worker. */
const FALLBACK_MESSAGE_ID_DOMAIN = 'localhost';

/**
 * Gửi một email theo state machine có lease (spec §5.11). At-least-once: crash giữa lúc SMTP nhận thư và
 * bước hoàn tất, hoặc lease bị lấy lại khi SMTP chậm, có thể gửi hai lần (Message-ID cố định để nhận diện).
 * Không bao giờ trả thành công khi thư chưa ở trạng thái cuối.
 *
 * Mỗi lần claim dùng owner token v7 mới (`lease_owner` UNIQUE); mọi bước ghi sau claim có fencing theo token đó.
 * SMTP không retry trong policy của cockatiel (transport dùng `single`): retry là việc của BullMQ.
 */
@Injectable()
@JobHandler(SendEmailJob)
export class SendEmailHandler {
  private readonly logger = new Logger(SendEmailHandler.name);
  private readonly tracer = trace.getTracer(TELEMETRY);
  private readonly meter = metrics.getMeter(TELEMETRY);
  private readonly sent = this.meter.createCounter(
    'notifications_email_total',
    {
      description: 'Email send outcomes by template and result',
    },
  );
  private readonly leaseLost = this.meter.createCounter(
    'notifications_email_lease_lost_total',
    {
      description:
        'Sends whose completion was fenced out by a newer lease owner',
    },
  );

  constructor(
    private readonly repo: DeliveryRepository,
    private readonly renderer: TemplateRenderer,
    private readonly transport: MailTransport,
    private readonly cipher: FieldCipher,
    private readonly uow: UnitOfWork,
    private readonly events: EventPublisher,
    @Inject(notificationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof notificationsConfig>,
    @Inject(smtpConfig.KEY)
    private readonly smtp: ConfigOf<typeof smtpConfig>,
  ) {}

  async handle(ctx: JobContext<{ deliveryId: string }>): Promise<void> {
    // Hợp đồng SP1: đã abort thì ném, không claim (claim tăng `attempts` mà không gửi).
    ctx.signal.throwIfAborted();
    const id = ctx.payload.deliveryId;
    const owner = v7();
    const claimed = await this.spanAsync('notifications.email.claim', () =>
      this.uow.run(() => this.repo.claim(id, owner, this.cfg.claimLeaseMs)),
    );
    if (!claimed) return this.notClaimed(id);

    let mail: OutgoingMail;
    try {
      mail = this.spanSync('notifications.email.render', () =>
        this.render(claimed),
      );
    } catch (err) {
      // Chỉ tên lớp lỗi: message của zod/cipher có thể mang giá trị params.
      this.logger.warn(
        {
          deliveryId: id,
          errName: errName(err),
          event: 'delivery_render_failed',
        },
        'delivery_render_failed',
      );
      await this.failPermanently(claimed, owner, null, 'RENDER_FAILED');
      throw new JobPayloadError(
        SendEmailJob.name,
        'delivery cannot be rendered (template, locale or params)',
      );
    }

    try {
      await this.spanAsync('notifications.email.send', () =>
        this.transport.send(mail, ctx.signal),
      );
    } catch (err) {
      await this.onSendFailure(ctx, claimed, owner, err);
    }

    const done = await this.uow.run(() => this.repo.complete(id, owner));
    if (!done) {
      // Thư đã đi; owner mới (lease hết hạn khi SMTP chậm) chịu trách nhiệm trạng thái cuối.
      this.leaseLost.add(1);
      this.logger.warn(
        { deliveryId: id, event: 'delivery_lease_lost' },
        'delivery_lease_lost',
      );
      return;
    }
    this.sent.add(1, { template: claimed.template, result: 'sent' });
  }

  /** Luôn ném: vĩnh viễn → FAILED + event rồi `JobPayloadError`; tạm thời → trả lease hoặc FAILED ở lần cuối. */
  private async onSendFailure(
    ctx: JobContext<{ deliveryId: string }>,
    claimed: ClaimedDelivery,
    owner: string,
    err: unknown,
  ): Promise<never> {
    // Transport cam kết chỉ ném MailSendError đã chuẩn hoá; lỗi khác là bug, không mang nó ra ngoài (có thể có PII).
    const e =
      err instanceof MailSendError ? err : new MailSendError('SMTP_TRANSIENT');
    if (!(err instanceof MailSendError))
      this.logger.error(
        {
          deliveryId: claimed.publicId,
          errName: errName(err),
          event: 'delivery_unexpected_send_error',
        },
        'delivery_unexpected_send_error',
      );
    // Worker tắt giữa chừng: không phải lỗi của thư, không tiêu lần thử cuối (cron đối soát enqueue lại).
    if (ctx.signal.aborted) {
      await this.release(claimed, owner, e.code);
      throw e;
    }
    if (!isTransientMailError(e.code)) {
      await this.failPermanently(claimed, owner, e.code, e.code);
      throw new JobPayloadError(
        SendEmailJob.name,
        `permanent SMTP failure (${e.code})`,
      );
    }
    if (ctx.attempt >= ctx.maxAttempts) {
      await this.failPermanently(claimed, owner, e.code, e.code);
      // Lỗi thường: đây là lần cuối nên BullMQ ghi failed; không Unrecoverable vì lỗi vốn tạm thời.
      throw new MailSendError(e.code, e.responseCode, e.command);
    }
    await this.release(claimed, owner, e.code);
    this.sent.add(1, { template: claimed.template, result: 'retry' });
    throw e;
  }

  private async release(
    c: ClaimedDelivery,
    owner: string,
    code: MailErrorCode,
  ): Promise<void> {
    const released = await this.uow.run(() =>
      this.repo.release(c.publicId, owner, code),
    );
    if (!released) this.fencedOut(c.publicId);
  }

  /**
   * Không claim được: không có dòng → vĩnh viễn; đã cuối → idempotent; còn lại (lease còn hạn, hoặc đúng mốc
   * `lease_until = now()` khi dòng vừa không claim được vừa không còn "active") → lỗi retry được, không bao
   * giờ thành công.
   */
  private async notClaimed(id: string): Promise<void> {
    const s = await this.repo.status(id);
    if (!s) throw new JobPayloadError(SendEmailJob.name, 'delivery not found');
    if (isFinal(s.state)) return;
    throw new DeliveryLeaseBusyError();
  }

  private render(c: ClaimedDelivery): OutgoingMail {
    const to = this.cipher.decrypt(
      c.recipientEnc,
      deliveryAad('recipient_enc', c.publicId),
    );
    const raw: unknown = JSON.parse(
      this.cipher.decrypt(c.paramsEnc, deliveryAad('params_enc', c.publicId)),
    );
    const params = TEMPLATE_PARAMS[c.template].parse(raw);
    const rendered = this.renderer.render(c.template, c.locale, params);
    return {
      to,
      ...rendered,
      messageId: `<${c.publicId}@${this.messageIdDomain()}>`,
    };
  }

  private messageIdDomain(): string {
    const from = this.smtp.mailFrom ?? '';
    const at = from.lastIndexOf('@');
    return at >= 0
      ? from.slice(at + 1).replace(/[>\s]/g, '')
      : FALLBACK_MESSAGE_ID_DOMAIN;
  }

  /** FAILED + event trong CÙNG transaction, có fencing theo owner; commit xong mới ném lỗi cho BullMQ. */
  private async failPermanently(
    c: ClaimedDelivery,
    owner: string,
    code: MailErrorCode | null,
    reason: DeliveryFailureCode,
  ): Promise<void> {
    const template = await this.uow.run(async () => {
      const t = await this.repo.fail(c.publicId, owner, code);
      if (!t) return undefined;
      await this.events.publish(DeliveryFailedEvent, {
        data: { deliveryId: c.publicId, template: t, errorCode: reason },
        aggregate: { type: 'email_delivery', id: c.publicId, version: 1 },
        actor: SYSTEM_ACTOR,
      });
      return t;
    });
    if (!template) return this.fencedOut(c.publicId);
    this.sent.add(1, { template, result: 'failed' });
  }

  private fencedOut(deliveryId: string): void {
    this.leaseLost.add(1);
    this.logger.warn(
      { deliveryId, event: 'delivery_lease_lost' },
      'delivery_lease_lost',
    );
  }

  private spanSync<T>(name: string, fn: () => T): T {
    return this.tracer.startActiveSpan(name, (s) => {
      try {
        return fn();
      } finally {
        s.end();
      }
    });
  }

  private spanAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (s) => {
      try {
        return await fn();
      } finally {
        s.end();
      }
    });
  }
}

const errName = (err: unknown): string =>
  err instanceof Error ? err.name : typeof err;
