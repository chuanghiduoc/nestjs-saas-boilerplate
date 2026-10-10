import type { AttemptError } from '../domain/webhook-delivery.js';

/** `id` BIGINT nội bộ (text); `createdAt` là chuỗi ISO micro giây (`CREATED_AT_KEY_SQL`): cùng tạo thành khoá dòng. */
export type DeliveryRef = { id: string; publicId: string; createdAt: string };
export type ClaimedDelivery = DeliveryRef & {
  endpointId: string;
  messageId: string;
  attemptsTotal: number;
  cycleBase: number;
  /** `local_failures` lúc claim (R-X35), trước lần thử này. */
  localFailures: number;
  createdAtMs: number;
};
/** `localBump: 1` ở mọi lỗi của ta (R-X35), `0` ở lỗi của endpoint. */
export type DeliveryResult =
  | { kind: 'SUCCEEDED'; statusCode: number }
  | {
      kind: 'RETRY';
      statusCode: number | null;
      error: AttemptError;
      delayMs: number;
      cycleBump: 0 | 1;
      localBump: 0 | 1;
    }
  | {
      kind: 'EXHAUSTED';
      statusCode: number | null;
      error: AttemptError;
      localBump: 0 | 1;
    };

/** Mọi phương thức chạy trong OrgScope + `UnitOfWork.run` của caller. */
export abstract class DeliveryRepository {
  abstract insertMessage(m: {
    eventId: string;
    eventType: string;
    eventVersion: number;
    body: string;
  }): Promise<{ id: string; createdAt: string }>;
  /** Một delivery `PENDING` mỗi endpoint, cùng `created_at` với message; trả public id theo thứ tự `endpointIds`. */
  abstract insertDeliveries(
    message: { id: string; createdAt: string },
    endpointIds: readonly string[],
  ): Promise<string[]>;

  /** Endpoint của delivery còn claim được và đã đến hạn (± `skewMs`); không khoá — claim khoá endpoint trước (R-X35). */
  abstract dueEndpointOf(
    publicId: string,
    skewMs: number,
  ): Promise<string | undefined>;
  /** CAS `PENDING | RETRY_SCHEDULED → SENDING` khi đã đến hạn (± `skewMs`); `undefined` = không claim được (R6-9, R6C-1). */
  abstract claim(
    publicId: string,
    leaseMs: number,
    skewMs: number,
  ): Promise<ClaimedDelivery | undefined>;
  /** `SENDING → CANCELLED(ENDPOINT_UNAVAILABLE)` trong cùng transaction claim. */
  abstract cancelClaimed(ref: DeliveryRef, attempts: number): Promise<boolean>;
  abstract messageOf(
    ref: DeliveryRef & { messageId: string },
  ): Promise<{ eventId: string; eventType: string; body: string }>;
  /** Id công khai của endpoint và event của message (event `exhausted` khi không có `Send` trong tay: sweep, secret hỏng). */
  abstract describe(
    ref: DeliveryRef & { endpointId: string; messageId: string },
  ): Promise<{ endpointPublicId: string; eventType: string; eventId: string }>;
  /** CAS có fencing: `status = 'SENDING' AND attempts_total = attempts`; `false` = một lần claim khác đã thắng (R6-9). */
  abstract finish(
    ref: DeliveryRef,
    attempts: number,
    result: DeliveryResult,
  ): Promise<boolean>;
  /**
   * `DEFER` (kill switch, endpoint đủ in-flight): `next_attempt_at = GREATEST(next_attempt_at, now + delay)`, chỉ khi đã đến
   * hạn (± `skewMs`) — M1: job trùng/tới sớm không kéo lần hẹn muộn về sớm, không đẩy lùi thêm. Không claim, không đếm;
   * trả `attempts_total` khi đã dời, `undefined` khi không (khi đó không enqueue gì: job đúng hạn của lần hẹn đó vẫn còn).
   */
  abstract defer(
    publicId: string,
    delayMs: number,
    skewMs: number,
  ): Promise<number | undefined>;
  /**
   * Tối đa `limit` delivery `PENDING | RETRY_SCHEDULED` quá hạn hơn `graceSec` (job bị mất), khoá `FOR UPDATE SKIP LOCKED`, và
   * "chạm" `next_attempt_at = now` (M5): lượt sau trong cửa sổ grace lấy phần còn lại thay vì lấy lại đúng các dòng này.
   */
  abstract takeOverdue(
    graceSec: number,
    limit: number,
  ): Promise<{ publicId: string; attemptsTotal: number }[]>;
  /** `SENDING` có `lease_until` quá `graceSec`; khoá `FOR UPDATE SKIP LOCKED`. */
  abstract expiredLeases(
    graceSec: number,
    limit: number,
  ): Promise<ClaimedDelivery[]>;
}
