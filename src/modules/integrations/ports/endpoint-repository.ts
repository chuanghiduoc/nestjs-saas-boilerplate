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
}
