import { Socket } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { type ConfigOf } from '../../../core/config/index.js';
import { ResiliencePolicies } from '../../../core/resilience/index.js';
import { MailSendError } from '../errors.js';
import {
  SMTP_RESILIENCE_PROVIDER,
  smtpConfig,
} from '../notifications.config.js';
import { MailTransport, type OutgoingMail } from '../ports/mail-transport.js';
import { toMailSendError } from './smtp-error.js';

type Attempt = { ok: true } | { ok: false; error: MailSendError };

/** Permanent recipient failures are results so they do not trip the provider breaker. */
async function attemptSend(send: () => Promise<unknown>): Promise<Attempt> {
  try {
    await send();
    return { ok: true };
  } catch (err) {
    const error = toMailSendError(err);
    if (error.code === 'SMTP_PERMANENT') return { ok: false, error };
    throw error;
  }
}

@Injectable()
export class NodemailerTransport extends MailTransport {
  constructor(
    @Inject(smtpConfig.KEY) private readonly cfg: ConfigOf<typeof smtpConfig>,
    private readonly policies: ResiliencePolicies,
  ) {
    super();
  }

  private createPool(socket: Socket) {
    return createTransport({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      requireTLS: this.cfg.requireTls,
      auth: this.cfg.user
        ? { user: this.cfg.user, pass: this.cfg.password ?? '' }
        : undefined,
      connectionTimeout: this.cfg.connectionTimeoutMs,
      greetingTimeout: this.cfg.greetingTimeoutMs,
      socketTimeout: this.cfg.socketTimeoutMs,
      tls: { rejectUnauthorized: this.cfg.tlsRejectUnauthorized },
      disableFileAccess: true,
      disableUrlAccess: true,
      pool: true,
      maxConnections: 1,
      maxMessages: 1,
      maxRequeues: 0,
      // pool.close() defers closing busy connections. Own the underlying socket
      // so cancellation also destroys a connection blocked in DATA or TLS.
      socket,
    });
  }

  async send(mail: OutgoingMail, signal: AbortSignal): Promise<void> {
    if (!this.cfg.host || !this.cfg.mailFrom)
      throw new MailSendError('SMTP_CONNECTION');
    if (signal.aborted) throw new MailSendError('SMTP_TIMEOUT');
    const socket = new Socket();
    const transporter = this.createPool(socket);
    const deadline = new AbortController();
    const stop = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.cfg.sendDeadlineMs);
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(new MailSendError('SMTP_TIMEOUT'));
        transporter.close();
        socket.destroy();
      };
      stop.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const sending = this.policies
        .for(SMTP_RESILIENCE_PROVIDER)
        .single.execute(
          () =>
            attemptSend(() => {
              if (stop.aborted) throw new MailSendError('SMTP_TIMEOUT');
              return Promise.race([
                transporter.sendMail({
                  from: this.cfg.mailFrom,
                  to: mail.to,
                  subject: mail.subject,
                  html: mail.html,
                  text: mail.text,
                  messageId: mail.messageId,
                }),
                aborted,
              ]);
            }),
          stop,
        );
      // The total deadline includes time spent waiting in the bulkhead queue.
      const attempt = await Promise.race([sending, aborted]);
      if (!attempt.ok) throw attempt.error;
    } catch (err) {
      throw toMailSendError(err);
    } finally {
      clearTimeout(timer);
      stop.removeEventListener('abort', onAbort);
      transporter.close();
      socket.destroy();
    }
  }
}
