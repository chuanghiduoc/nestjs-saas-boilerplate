import type {
  DisabledReason,
  EndpointStatus,
} from '../domain/webhook-endpoint.js';

export type EndpointRow = {
  /** id BIGINT nội bộ (text), không bao giờ ra API. */
  id: string;
  publicId: string;
  url: string;
  description: string | null;
  status: EndpointStatus;
  disabledReason: DisabledReason | null;
  failingSince: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  eventTypes: string[];
};
/** `NO_KEY_UPDATE`: sửa/xoá/xoay; `SHARE`: retry/recover/test (chặn tắt endpoint giữa lúc đưa delivery về PENDING). */
export type EndpointLock = 'NONE' | 'NO_KEY_UPDATE' | 'SHARE';

/** Mọi phương thức chạy trong OrgScope của caller (RLS); phương thức ghi chạy trong `UnitOfWork.run` của caller. */
export abstract class EndpointRepository {
  abstract countLive(): Promise<number>;
  abstract countLiveUpTo(cap: number): Promise<number>;
  abstract insert(i: {
    url: string;
    description: string | null;
  }): Promise<{ id: string; publicId: string }>;
  abstract setEventTypes(
    endpointId: string,
    types: readonly string[],
  ): Promise<void>;
  abstract insertSecret(i: {
    endpointId: string;
    publicId: string;
    secretEnc: string;
  }): Promise<void>;
  abstract list(page: {
    limit: number;
    offset: number;
  }): Promise<EndpointRow[]>;
  /** Chỉ endpoint chưa xoá mềm. */
  abstract find(
    publicId: string,
    lock: EndpointLock,
  ): Promise<EndpointRow | undefined>;

  /** Ghi đủ giá trị mới (service tính từ dòng đã khoá), `version + 1`. */
  abstract update(
    id: string,
    next: {
      url: string;
      description: string | null;
      status: EndpointStatus;
      disabledReason: DisabledReason | null;
      clearFailing: boolean;
    },
  ): Promise<EndpointRow>;
  /** `version + 1` (M3: xoay secret), trả version mới. */
  abstract bumpVersion(id: string): Promise<number>;
  abstract softDelete(id: string, purgeDelaySec: number): Promise<void>;
  /** Xoá secret đã hết hạn; secret cũ còn hạn → hết hạn ngay; secret hiện hành → hết hạn sau `overlapSec`. */
  abstract rotateSecrets(
    endpointId: string,
    overlapSec: number,
  ): Promise<{ previousExpiresAt: Date | null }>;
  /** Secret còn ký (tối đa hai), hiện hành trước. */
  abstract signingSecrets(
    endpointId: string,
  ): Promise<{ publicId: string; secretEnc: string }[]>;

  /**
   * Id nội bộ của endpoint `ACTIVE`, chưa xoá, có đăng ký `eventType`, tăng dần (fan-out). Khoá `FOR KEY SHARE` tới hết
   * transaction của caller (R-X33): không FK delivery → endpoint, nên người ghi delivery tự giữ dòng cha.
   */
  abstract activeSubscribers(eventType: string): Promise<string[]>;

  /**
   * R-X35, R6C-4: khoá dòng endpoint `FOR NO KEY UPDATE` (tuần tự hoá "đếm rồi claim" của mọi claim cùng endpoint), rồi đếm
   * delivery `SENDING` còn lease. `undefined` = không có dòng endpoint (claim sẽ huỷ delivery).
   */
  abstract lockForClaim(endpointId: string): Promise<number | undefined>;
  abstract forSend(endpointId: string): Promise<
    | {
        publicId: string;
        url: string;
        status: EndpointStatus;
        deleted: boolean;
      }
    | undefined
  >;
  /** Thành công: `failing_since = NULL` (không tăng version: ETag của khách không đổi vì sức khoẻ). */
  abstract clearFailing(endpointId: string): Promise<void>;
  /** Lỗi của endpoint: `failing_since = COALESCE(failing_since, now)` (R6-12). */
  abstract markFailing(endpointId: string): Promise<void>;
  /** CAS `ACTIVE → DISABLED(AUTO_FAILING)` khi `failing_since <= now - afterSec`; đúng một người thắng (R6-12). */
  abstract autoDisable(
    endpointId: string,
    afterSec: number,
  ): Promise<{ publicId: string; version: number } | undefined>;
  /**
   * Xoá cứng endpoint đã xoá mềm tới hạn `purge_after` mà không còn delivery (secret, đăng ký đi theo `CASCADE`); còn
   * delivery (partition chưa hết retention) → dời `purge_after` thêm `postponeSec` (spec §7.3). Không có FK delivery →
   * endpoint (R-X33): khoá `FOR UPDATE` dòng endpoint (xung đột với `FOR KEY SHARE` của fan-out) rồi kiểm `NOT EXISTS`.
   */
  /**
   * M5 (review bảo mật 6C): xoá tối đa `limit` secret đã quá `expires_at` của org (ciphertext cũ không nằm lại mãi).
   * `SKIP LOCKED`: dòng đang bị lần xoay giữ thì để lượt sau; secret hết hạn không bao giờ còn ký nên không ai cần nó.
   */
  abstract purgeExpiredSecrets(limit: number): Promise<number>;
  abstract purgeDue(
    limit: number,
    postponeSec: number,
  ): Promise<{ deleted: number; postponed: number }>;
}
