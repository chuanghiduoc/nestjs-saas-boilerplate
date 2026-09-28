import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import { type ConfigOf } from '../../../core/config/index.js';
import { AppError } from '../../../core/errors/index.js';
import {
  EmailNotifications,
  type EmailRequest,
  type TemplateKey,
} from '../../notifications/index.js';
import { identityGuardConfig } from '../identity.config.js';
import { IDENTITY_METER } from '../identity-telemetry.js';

const MS_PER_SECOND = 1000;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
type MailUser = { id: string; email: string; name: string };
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const hasKey = <K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> =>
  typeof obj === 'object' && obj !== null && key in obj;
const stringProp = (obj: unknown, key: string): string | undefined => {
  const v = hasKey(obj, key) ? obj[key] : undefined;
  return typeof v === 'string' ? v : undefined;
};

/**
 * Chi tiết lỗi không PII (review I2): lớp lỗi, SQLSTATE (lỗi pg, trực tiếp hoặc trong `cause`) và mã ứng dụng
 * (`AppError`, hoặc `code` không phải SQLSTATE như `MailSendError`). Không bao giờ đọc `.message`: message của pg
 * hay của caller có thể chứa địa chỉ, url hoặc token.
 */
function failureDetail(err: unknown): {
  errorClass: string;
  sqlState?: string;
  code?: string;
} {
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  const cause = hasKey(err, 'cause') ? err.cause : undefined;
  const sqlState = [
    stringProp(err, 'sqlState'),
    stringProp(err, 'code'),
    stringProp(cause, 'code'),
  ].find((c) => c !== undefined && SQLSTATE_PATTERN.test(c));
  const own = stringProp(err, 'code');
  const code =
    err instanceof AppError
      ? err.error.code
      : own !== undefined && own !== sqlState
        ? own
        : undefined;
  return {
    errorClass,
    ...(sqlState ? { sqlState } : {}),
    ...(code ? { code } : {}),
  };
}

/**
 * Callback email của Better Auth → yêu cầu email có idempotency key (spec §5.11). Không bao giờ gửi SMTP ở api:
 * `EmailNotifications` chỉ ghi DB (địa chỉ và params được mã hoá) + enqueue qua outbox. Không log url, token
 * hay địa chỉ; key chỉ chứa hash của token hoặc user id.
 */
@Injectable()
export class AuthEmails {
  constructor(
    private readonly emails: EmailNotifications,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: ConfigOf<typeof identityGuardConfig>,
  ) {}

  private readonly logger = new Logger(AuthEmails.name);
  /** Attribute chỉ là phân loại (template, lớp lỗi), không user id/địa chỉ (spec §5.14). */
  private readonly requestFailedTotal = metrics
    .getMeter(IDENTITY_METER)
    .createCounter('identity_auth_email_request_failed_total', {
      description:
        'Auth emails (verification, reset, notices) that could not be requested; Better Auth swallows these failures',
    });

  /**
   * Better Auth nuốt lỗi của callback email (`runInBackgroundOrAwait` chỉ log message, và adapter logger bỏ
   * `...args`), nên lỗi được log có cấu trúc ở đây rồi ném lại cho caller. Log chỉ có template, user id và
   * chi tiết lỗi không PII.
   */
  private async send<K extends TemplateKey>(
    req: EmailRequest<K>,
    userId: string,
  ): Promise<void> {
    try {
      await this.emails.request(req);
    } catch (err) {
      const detail = failureDetail(err);
      this.requestFailedTotal.add(1, {
        template: req.template,
        error_class: detail.errorClass,
      });
      this.logger.error(
        {
          event: 'auth_email_request_failed',
          template: req.template,
          userId,
          ...detail,
        },
        'auth email could not be requested',
      );
      throw err;
    }
  }

  readonly verification = async (d: {
    user: MailUser;
    url: string;
    token: string;
  }): Promise<void> => {
    await this.send(
      {
        template: 'verify-email',
        to: d.user.email,
        params: { name: d.user.name, url: d.url },
        idempotencyKey: `verify-email:${sha256(d.token)}`,
      },
      d.user.id,
    );
  };

  readonly reset = async (d: {
    user: MailUser;
    url: string;
    token: string;
  }): Promise<void> => {
    await this.send(
      {
        template: 'reset-password',
        to: d.user.email,
        params: { name: d.user.name, url: d.url },
        idempotencyKey: `reset-password:${sha256(d.token)}`,
      },
      d.user.id,
    );
  };

  /**
   * S2-R42: bước 1 của đổi email hai bước (`user.changeEmail.sendChangeEmailConfirmation` của Better Auth, chỉ khi user
   * đã xác thực): thư tới địa chỉ CŨ (`user.email`); bấm link thì Better Auth mới gửi thư xác thực tới địa chỉ mới.
   * `newEmail` cố ý không vào thư (params của template không có địa chỉ, spec §5.16c) và không vào log.
   */
  readonly changeEmailConfirmation = async (d: {
    user: MailUser;
    newEmail: string;
    url: string;
    token: string;
  }): Promise<void> => {
    await this.send(
      {
        template: 'change-email-confirmation',
        to: d.user.email,
        params: { displayName: d.user.name, url: d.url },
        idempotencyKey: `change-email-confirmation:${sha256(d.token)}`,
      },
      d.user.id,
    );
  };

  /** Chống dò email (spec §5.8). Tối đa một thư mỗi `AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC` (UNIQUE của idempotency key chặn spam). */
  readonly existingAccount = async (d: { user: MailUser }): Promise<void> => {
    const window = Math.floor(
      Date.now() / MS_PER_SECOND / this.guard.existingAccountNoticeWindowSec,
    );
    await this.send(
      {
        template: 'existing-account',
        to: d.user.email,
        params: { name: d.user.name },
        idempotencyKey: `existing-account:${d.user.id}:${window}`,
      },
      d.user.id,
    );
  };

  /**
   * Key `two-factor-changed:<user>:<session>:<enabled|disabled>` (theo plan, review M8): một thông báo cho mỗi
   * chiều thay đổi trong một session, để retry của cùng một thao tác (hook after chạy lại, request lặp) không gửi
   * trùng. Hệ quả đã chấp nhận: bật → tắt → bật lại trong CÙNG session chỉ báo lần đầu của mỗi chiều; đổi session
   * (đăng nhập lại) thì lại báo.
   */
  async twoFactorChanged(
    user: MailUser,
    sessionId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.send(
      {
        template: 'two-factor-changed',
        to: user.email,
        params: {
          name: user.name,
          enabled,
          occurredAt: new Date().toISOString(),
        },
        idempotencyKey: `two-factor-changed:${user.id}:${sessionId}:${enabled ? 'enabled' : 'disabled'}`,
      },
      user.id,
    );
  }
}
export type AuthEmailCallbacks = Pick<
  AuthEmails,
  'verification' | 'reset' | 'existingAccount' | 'changeEmailConfirmation'
>;
