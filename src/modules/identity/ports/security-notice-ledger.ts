/** Loại thông báo bảo mật; khớp `CHECK` của `auth.security_notice.kind` (SP2 + 3D `…_security_notice_operator_reset`). */
export const SECURITY_NOTICE_KINDS = [
  'two_factor_enabled',
  'two_factor_disabled',
  /** Spec SP3 §5.2 (3D, r6 N6-3): lệnh vận hành đặt lại mật khẩu + 2FA của user (marker mang ticket). */
  'operator_reset',
] as const;
/** Cận trên của `--ticket` của lệnh reset và của `security_notice_ticket_check` (migration viết cứng 128). */
export const STAFF_RESET_TICKET_MAX_LENGTH = 128;
export type SecurityNoticeKind = (typeof SECURITY_NOTICE_KINDS)[number];

/** Một marker chưa gửi. `occurredAt` = thời điểm thay đổi bảo mật commit (cùng câu lệnh, trigger của DB). */
export type PendingSecurityNotice = {
  id: string;
  userId: string;
  kind: SecurityNoticeKind;
  occurredAt: Date;
};

/**
 * Sổ thông báo bảo mật bền (S2-R75): marker được DB ghi trong CÙNG câu lệnh đổi trạng thái bảo mật (trigger), app chỉ đọc
 * marker chưa gửi và đánh dấu đã gửi.
 */
export abstract class SecurityNoticeLedger {
  /** Marker chưa gửi của một user (đường gửi nhanh sau thao tác), cũ trước. */
  abstract pendingForUser(userId: string): Promise<PendingSecurityNotice[]>;
  /** Marker chưa gửi cũ hơn `graceSec` (cron), cũ trước; không có cận dưới thời gian. */
  abstract pending(
    graceSec: number,
    limit: number,
  ): Promise<PendingSecurityNotice[]>;
  /** Idempotent: chỉ đổi marker còn chưa gửi. */
  abstract markNotified(id: string): Promise<void>;
  /** M1 (S2-R75 review): marker không bao giờ gửi được (lỗi caller, vd. địa chỉ không hợp lệ). Idempotent, loại trừ với `markNotified`. */
  abstract abandon(id: string): Promise<void>;
  abstract oldestPendingAgeSec(): Promise<number | null>;
}
