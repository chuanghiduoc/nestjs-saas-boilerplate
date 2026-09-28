import { Injectable, Logger } from '@nestjs/common';
import { safeErrorFields } from '../identity-telemetry.js';
import { IdentityDirectory } from '../ports/identity-directory.js';
import {
  SecurityNoticeLedger,
  type PendingSecurityNotice,
} from '../ports/security-notice-ledger.js';
import { AuthEmails } from './auth-emails.js';

/**
 * Gửi thông báo bảo mật từ marker bền (S2-R75). Marker do DB ghi cùng câu lệnh đổi trạng thái (trigger), nên thứ tự luôn
 * là: yêu cầu thư (key theo marker, `ON CONFLICT DO NOTHING`) RỒI đánh dấu marker. Crash giữa hai bước chỉ dẫn tới yêu cầu
 * lại cùng key (không thư thứ hai); lỗi trước khi yêu cầu thư để marker chưa gửi cho cron.
 */
@Injectable()
export class SecurityNoticeService {
  private readonly logger = new Logger(SecurityNoticeService.name);

  constructor(
    private readonly ledger: SecurityNoticeLedger,
    private readonly directory: IdentityDirectory,
    private readonly emails: AuthEmails,
  ) {}

  /** Ném lỗi cho caller (cron). */
  async deliver(notice: PendingSecurityNotice): Promise<void> {
    const user = await this.directory.findUser(notice.userId);
    if (!user) {
      // FK `ON DELETE CASCADE`: user bị xoá thì marker cũng đã bị xoá cùng transaction, không còn gì để gửi hay đánh dấu.
      this.logger.warn(
        {
          event: 'security_notice_user_missing',
          noticeId: notice.id,
          userId: notice.userId,
        },
        'security notice skipped: its user was deleted',
      );
      return;
    }
    await this.emails.twoFactorChanged(user, notice);
    await this.ledger.markNotified(notice.id);
  }

  /**
   * Đường gửi nhanh, sau khi thao tác bảo mật của `userId` đã commit (hook `after` của Better Auth). Không bao giờ ném:
   * thao tác đã thành công, còn marker chưa gửi được cron `identity.reconcile-security-notices` gửi bù.
   */
  async afterChange(userId: string): Promise<void> {
    try {
      for (const notice of await this.ledger.pendingForUser(userId))
        await this.deliver(notice);
    } catch (err) {
      this.logger.error(
        {
          event: 'security_notice_deferred',
          userId,
          ...safeErrorFields(err),
        },
        'security notice deferred to the reconcile cron',
      );
    }
  }
}
