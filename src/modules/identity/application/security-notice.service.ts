import { Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { InvalidEmailRequestError } from '../../notifications/index.js';
import { IDENTITY_METER, safeErrorFields } from '../identity-telemetry.js';
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
  /** M1 (S2-R75 review): marker vĩnh viễn không gửi được — không phải backlog, để alert riêng khỏi số liệu tạm thời. */
  private readonly abandonedTotal = metrics
    .getMeter(IDENTITY_METER)
    .createCounter('identity_security_notice_abandoned_total', {
      description:
        'Security notices that can never be requested (e.g. an IdP-issued recipient address notifications rejects) and were marked terminal instead of retried',
    });

  constructor(
    private readonly ledger: SecurityNoticeLedger,
    private readonly directory: IdentityDirectory,
    private readonly emails: AuthEmails,
  ) {}

  /**
   * Ném lỗi cho caller (cron) khi lỗi có thể tự khỏi (hạ tầng, SMTP tạm thời). M1: `InvalidEmailRequestError` là lỗi
   * VĨNH VIỄN của caller (vd. IdP gán địa chỉ không hợp `z.email()`, `a@corp`) — thử lại mỗi phút không bao giờ thành
   * công, nên đánh dấu `abandoned` thay vì để cron lỗi vô hạn và gauge backlog tăng không giới hạn.
   * `AuthEmails.send` đã log ERROR + tăng `identity_auth_email_request_failed_total` cho MỌI lỗi (kể cả lỗi này)
   * trước khi ném lại; ở đây chỉ cần log riêng sự kiện "bỏ" + tăng metric riêng cho alert đúng loại.
   */
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
    try {
      await this.emails.twoFactorChanged(user, notice);
    } catch (err) {
      if (!(err instanceof InvalidEmailRequestError)) throw err;
      this.abandonedTotal.add(1, { kind: notice.kind });
      this.logger.error(
        {
          event: 'security_notice_abandoned',
          noticeId: notice.id,
          userId: notice.userId,
          ...safeErrorFields(err),
        },
        'security notice abandoned: the recipient address can never be requested (permanent, not retried)',
      );
      await this.ledger.abandon(notice.id);
      return;
    }
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
