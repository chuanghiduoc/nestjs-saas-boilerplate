import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import type { SupportGrantRevokeReason } from '../domain/support-grant.js';
import { ApiKeyRevokedEvent, SupportAccessRevokedEvent } from '../events.js';
import { OrgApiKeyRepository } from '../ports/org-api-key-repository.js';
import {
  SupportGrantRepository,
  type SupportGrantRow,
} from '../ports/support-grant-repository.js';

/**
 * Mọi đường thu hồi ủy quyền NGẦM (spec SP3 §9.7 state machine, §14.1): cấp lại (T-20), người nhận thành member (SEC-M5),
 * role nền tảng của người nhận được ghi (N5-1); Task 24 thêm key của member bị gỡ và xoá mềm org. Gọi trong transaction đã
 * khoá org; mỗi dòng thu hồi một event (actor do caller truyền).
 */
@Injectable()
export class DelegationRevocations {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly grants: SupportGrantRepository,
    private readonly keys: OrgApiKeyRepository,
    private readonly events: EventPublisher,
  ) {}

  /**
   * Spec §14.1: key của member bị gỡ (xoá khỏi org, rời org, xoá tài khoản) mất theo FK CASCADE trong câu xoá member; event
   * `api_key.revoked { CREATOR_REMOVED }` phát TRƯỚC câu xoá, từ chính dòng còn đọc được, version + 1 (chuyển trạng thái cuối).
   */
  async announceKeysOfRemovedMember(
    memberId: string,
    actor: EventActor,
  ): Promise<void> {
    this.assertInTransaction();
    for (const k of await this.keys.unrevokedOfMember(memberId))
      await this.events.publish(ApiKeyRevokedEvent, {
        data: { apiKeyId: k.publicId, reason: 'CREATOR_REMOVED' },
        aggregate: { type: 'api_key', id: k.publicId, version: k.version + 1 },
        actor,
      });
  }

  /** Xoá mềm org (spec §9.4, Bảng 5): mọi key và grant chưa thu hồi; không event riêng (`tenancy.org.deleted` hàm ý). */
  async revokeAllOfOrg(): Promise<void> {
    this.assertInTransaction();
    await this.keys.revokeAll();
    await this.grants.revokeAll();
  }

  async revokeGrantsOfGrantee(
    granteeUserId: string,
    reason: SupportGrantRevokeReason,
    actor: EventActor,
  ): Promise<number> {
    this.assertInTransaction();
    const revoked = await this.grants.revokeOpenForGrantee(granteeUserId);
    for (const g of revoked) await this.publishGrantRevoked(g, reason, actor);
    return revoked.length;
  }

  async publishGrantRevoked(
    g: SupportGrantRow,
    reason: SupportGrantRevokeReason,
    actor: EventActor,
  ): Promise<void> {
    await this.events.publish(SupportAccessRevokedEvent, {
      data: {
        grantId: g.publicId,
        granteeUserId: g.granteeUserPublicId,
        grantedByMemberId: g.grantedByMemberPublicId,
        permissions: g.permissions,
        expiresAt: g.expiresAt.toISOString(),
        reason,
      },
      aggregate: { type: 'support_grant', id: g.publicId, version: g.version },
      actor,
    });
  }

  private assertInTransaction(): void {
    if (!this.uow.inTransaction())
      throw new Error('DelegationRevocations must run inside UnitOfWork.run');
  }
}
