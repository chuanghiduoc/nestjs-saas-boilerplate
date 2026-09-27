import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type ConfigOf } from '../../../core/config/index.js';
import { EmailNotifications } from '../../notifications/index.js';
import { identityGuardConfig } from '../identity.config.js';

const MS_PER_SECOND = 1000;
type MailUser = { id: string; email: string; name: string };
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

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

  readonly verification = async (d: {
    user: MailUser;
    url: string;
    token: string;
  }): Promise<void> => {
    await this.emails.request({
      template: 'verify-email',
      to: d.user.email,
      params: { name: d.user.name, url: d.url },
      idempotencyKey: `verify-email:${sha256(d.token)}`,
    });
  };

  readonly reset = async (d: {
    user: MailUser;
    url: string;
    token: string;
  }): Promise<void> => {
    await this.emails.request({
      template: 'reset-password',
      to: d.user.email,
      params: { name: d.user.name, url: d.url },
      idempotencyKey: `reset-password:${sha256(d.token)}`,
    });
  };

  /** Chống dò email (spec §5.8). Tối đa một thư mỗi `AUTH_EXISTING_ACCOUNT_NOTICE_WINDOW_SEC` (UNIQUE của idempotency key chặn spam). */
  readonly existingAccount = async (d: { user: MailUser }): Promise<void> => {
    const window = Math.floor(
      Date.now() / MS_PER_SECOND / this.guard.existingAccountNoticeWindowSec,
    );
    await this.emails.request({
      template: 'existing-account',
      to: d.user.email,
      params: { name: d.user.name },
      idempotencyKey: `existing-account:${d.user.id}:${window}`,
    });
  };

  async twoFactorChanged(
    user: MailUser,
    sessionId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.emails.request({
      template: 'two-factor-changed',
      to: user.email,
      params: {
        name: user.name,
        enabled,
        occurredAt: new Date().toISOString(),
      },
      idempotencyKey: `two-factor-changed:${user.id}:${sessionId}:${enabled ? 'enabled' : 'disabled'}`,
    });
  }
}
export type AuthEmailCallbacks = Pick<
  AuthEmails,
  'verification' | 'reset' | 'existingAccount'
>;
