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
}
