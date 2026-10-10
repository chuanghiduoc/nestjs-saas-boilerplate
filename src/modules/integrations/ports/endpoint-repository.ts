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
}
