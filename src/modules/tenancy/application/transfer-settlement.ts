import { Injectable } from '@nestjs/common';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import type { StepDownRole } from '../constants.js';
import { isLapsed } from '../domain/expiry.js';
import { OwnershipTransferCancelledEvent } from '../events.js';
import { OrgRepository } from '../ports/org-repository.js';
import {
  OwnershipTransferRepository,
  type TransferRow,
} from '../ports/ownership-transfer-repository.js';

/** Dữ liệu event của yêu cầu (spec §14): id công khai của hai member; chỉ gọi khi cả hai còn (dòng vừa là PENDING). */
export function transferEventData(t: TransferRow): {
  transferId: string;
  fromMemberId: string;
  toMemberId: string;
  stepDownTo: StepDownRole | null;
} {
  if (t.fromMemberPublicId === null || t.toMemberPublicId === null)
    throw new Error(
      'an ownership transfer event needs both members (org_ownership_transfers_pending_members_ck)',
    );
  return {
    transferId: t.publicId,
    fromMemberId: t.fromMemberPublicId,
    toMemberId: t.toMemberPublicId,
    stepDownTo: t.stepDownTo,
  };
}

/**
 * Spec SP3 §9.3: gỡ một member đang là bên gửi/nhận của yêu cầu PENDING phải huỷ yêu cầu TRƯỚC khi xoá trong cùng
 * transaction (không thì CHECK `…_pending_members_ck` làm transaction fail to). Yêu cầu đã quá hạn chỉ chuyển EXPIRED
 * (trạng thái suy ra từ thời gian, không event, §14.1). Gọi dưới khoá org, trước câu `DELETE org_members`.
 */
@Injectable()
export class TransferSettlement {
  constructor(
    private readonly orgs: OrgRepository,
    private readonly transfers: OwnershipTransferRepository,
    private readonly events: EventPublisher,
  ) {}

  async settleForRemovedMember(
    memberId: string,
    actor: EventActor,
  ): Promise<void> {
    const pending = await this.transfers.lockPendingForMember(memberId);
    if (pending.length === 0) return;
    const now = await this.orgs.clockNow();
    for (const t of pending) {
      if (isLapsed(t.expiresAt, now)) {
        await this.transfers.resolve(t.id, 'EXPIRED');
        continue;
      }
      const data = transferEventData(t);
      const done = await this.transfers.resolve(t.id, 'CANCELLED');
      if (!done)
        throw new Error(
          'a locked PENDING ownership transfer was no longer PENDING',
        );
      await this.events.publish(OwnershipTransferCancelledEvent, {
        data: { ...data, reason: 'MEMBER_REMOVED' },
        aggregate: {
          type: 'ownership_transfer',
          id: done.publicId,
          version: done.version,
        },
        actor,
      });
    }
  }
}
