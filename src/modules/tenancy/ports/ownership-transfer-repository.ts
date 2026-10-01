import type { StepDownRole } from '../constants.js';
import type { TransferStatus } from '../domain/ownership-transfer.js';

export type TransferRow = {
  id: string;
  publicId: string;
  fromMemberId: string | null;
  fromMemberPublicId: string | null;
  toMemberId: string | null;
  toMemberPublicId: string | null;
  stepDownTo: StepDownRole | null;
  status: TransferStatus;
  expiresAt: Date;
  resolvedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export type TransferQuery = {
  participantMemberId?: string;
  status?: TransferStatus;
};

export abstract class OwnershipTransferRepository {
  abstract insert(t: {
    fromMemberId: string;
    toMemberId: string;
    stepDownTo: StepDownRole | null;
    ttlSec: number;
  }): Promise<TransferRow>;
  abstract findByPublicId(publicId: string): Promise<TransferRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<TransferRow | undefined>;
  /** PENDING đã hết hạn của org → EXPIRED (chạm sau hạn, §9.3): giải phóng `pending_uq` trước khi tạo yêu cầu mới. */
  abstract expireLapsed(): Promise<void>;
  /** CAS PENDING → `to` (T-16); `undefined` khi không còn PENDING. */
  abstract resolve(
    id: string,
    to: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED',
  ): Promise<TransferRow | undefined>;
  /** Yêu cầu PENDING mà member là bên gửi hoặc nhận, khoá `FOR NO KEY UPDATE` (gỡ member, §9.3). */
  abstract lockPendingForMember(memberId: string): Promise<TransferRow[]>;
  /** Xoá mềm org: mọi PENDING → CANCELLED (không event riêng, §14.1). */
  abstract cancelAllPending(): Promise<void>;
  /** `status` là trạng thái HIỆU LỰC (PENDING quá hạn tính là EXPIRED, theo `now()` của transaction đọc). */
  abstract list(
    q: TransferQuery & { limit: number; offset: number },
  ): Promise<TransferRow[]>;
  abstract countUpTo(q: TransferQuery, cap: number): Promise<number>;
}
