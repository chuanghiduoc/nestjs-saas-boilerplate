import type { DeliveryState } from '../domain/email-delivery.js';
import type { MailErrorCode } from '../errors.js';
import type { TemplateKey } from '../templates.js';

export type NewDelivery = {
  publicId: string;
  template: TemplateKey;
  locale: string;
  recipientEnc: string;
  paramsEnc: string;
  idempotencyKey: string;
};
export type ClaimedDelivery = {
  publicId: string;
  template: TemplateKey;
  locale: string;
  recipientEnc: string;
  paramsEnc: string;
  attempts: number;
};
export type StaleDelivery = { publicId: string; attempts: number };

/** Mọi thao tác ghi trạng thái có fencing theo `lease_owner` (spec §5.11). */
export abstract class DeliveryRepository {
  /** `false` khi idempotency key đã tồn tại (`ON CONFLICT DO NOTHING`). */
  abstract insert(d: NewDelivery): Promise<boolean>;
  /** PENDING, hoặc SENDING hết lease → SENDING với owner mới, `attempts + 1`. */
  abstract claim(
    publicId: string,
    owner: string,
    leaseMs: number,
  ): Promise<ClaimedDelivery | undefined>;
  abstract status(
    publicId: string,
  ): Promise<{ state: DeliveryState; leaseActive: boolean } | undefined>;
  abstract complete(publicId: string, owner: string): Promise<boolean>;
  abstract release(
    publicId: string,
    owner: string,
    code: MailErrorCode | null,
  ): Promise<boolean>;
  /** FAILED có fencing; trả template nếu đổi được trạng thái. */
  abstract fail(
    publicId: string,
    owner: string,
    code: MailErrorCode | null,
  ): Promise<TemplateKey | undefined>;
  abstract findStale(
    cooldownSec: number,
    limit: number,
  ): Promise<StaleDelivery[]>;
  /**
   * FAILED khi `attempts >= maxAttempts` và vẫn kẹt (PENDING, hoặc SENDING có lease đã hết hạn). Không có điều
   * kiện thời gian chờ: cooldown chỉ áp cho `findStale`/`bumpGeneration`.
   */
  abstract failExhausted(
    publicId: string,
    maxAttempts: number,
  ): Promise<TemplateKey | undefined>;
  /**
   * Tăng generation nếu vẫn kẹt, đã qua thời gian chờ, VÀ `attempts < maxAttempts` (atomic dưới row lock, cùng
   * câu UPDATE); `undefined` = bỏ qua. Điều kiện `attempts` chặn race: một job cũ claim/nhả lease giữa lúc
   * `findStale` chụp snapshot và câu UPDATE này chạy có thể đã đẩy `attempts` tới hoặc quá `maxAttempts` — không
   * có điều kiện này thì reconcile vẫn enqueue thêm một lần dù caller đã quyết định (từ snapshot) là chưa hết
   * lượt. Caller phải coi `undefined` là "không làm gì được ở đây" và tự thử `failExhausted` (FB: bounded overshoot).
   */
  abstract bumpGeneration(
    publicId: string,
    cooldownSec: number,
    maxAttempts: number,
  ): Promise<number | undefined>;
  abstract purge(retentionDays: number, limit: number): Promise<number>;
}
