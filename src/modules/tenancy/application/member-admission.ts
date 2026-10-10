import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { TenancyErrors } from '../errors.js';
import { MemberAddedEvent } from '../events.js';
import {
  MemberRepository,
  type MemberRow,
} from '../ports/member-repository.js';
import { MemberSeatLimit } from '../ports/member-seat-limit.js';
import { OrgRepository } from '../ports/org-repository.js';
import type { RoleRow } from '../ports/role-repository.js';
import type { TenancyUserRef } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { DelegationRevocations } from './delegation-revocations.js';
import { TenancyMetrics } from './tenancy-metrics.js';

/** Nguồn membership (spec §14 `tenancy.member.added.source`); lời mời/link mang id công khai của chính nó vào event. */
export type Admission =
  | { source: 'CREATOR' }
  | { source: 'INVITATION'; invitationId: string }
  | { source: 'INVITE_LINK'; inviteLinkId: string };

const refOf = (
  a: Admission,
): { invitationId?: string; inviteLinkId?: string } => {
  switch (a.source) {
    case 'CREATOR':
      return {};
    case 'INVITATION':
      return { invitationId: a.invitationId };
    case 'INVITE_LINK':
      return { inviteLinkId: a.inviteLinkId };
    default: {
      const unknown: never = a;
      throw new Error(`unknown admission ${JSON.stringify(unknown)}`);
    }
  }
};

/**
 * Mọi đường thêm membership (spec SP3 §9 đầu mục): tạo org (3A), chấp nhận lời mời / join link (3C thêm nguồn), domain
 * join sau này. Caller đã khoá org (trừ org mới tạo) và `tenancy_users` của user (T-25) trong CÙNG transaction.
 */
@Injectable()
export class MemberAdmission {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly events: EventPublisher,
    private readonly revocations: DelegationRevocations,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
    private readonly metrics: TenancyMetrics,
    /** Spec SP4 §9.6: vắng (entitlements không cài) → không giới hạn. */
    @Optional() private readonly seats?: MemberSeatLimit,
  ) {}

  async admit(i: {
    user: TenancyUserRef;
    role: RoleRow;
    actor: EventActor;
    admission: Admission;
  }): Promise<MemberRow> {
    if (!this.uow.inTransaction())
      throw new Error('MemberAdmission.admit must run inside UnitOfWork.run');
    // Span `tenancy.member.admit` (spec SP3 §16, review M4): chỉ nguồn (enum hữu hạn) làm attribute.
    return tenancySpan(
      'tenancy.member.admit',
      async () => {
        // T-7: đếm SAU khi đã khoá tenancy_users của user, nên hai lần join song song thấy nhau. M7: đếm MỌI membership,
        // kể cả ở org xoá mềm — khôi phục org đó không được để user ở hai org (một MEMBER không tự rời được org xoá mềm;
        // họ vào được org khác sau khi org cũ bị purge hoặc sau khi được gỡ khỏi nó lúc đã khôi phục).
        if (
          this.cfg.membershipMode === 'single' &&
          (await this.orgs.countMembershipsForUser(i.user.id)) > 0
        )
          throw new AppError(TenancyErrors.ALREADY_IN_AN_ORG);
        // 3D (SEC-M5, T-19): thu hồi support grant chưa thu hồi của chính user trong org, TRƯỚC INSERT; trigger hoãn
        // `org_members_no_active_support_grant` là lớp chặn cuối khi code quên hoặc SQL tay.
        await this.revocations.revokeGrantsOfGrantee(
          i.user.id,
          'GRANTEE_BECAME_MEMBER',
          i.actor,
        );
        // Extension point (S3-Q4 C): verified-domain auto-join — spec §19; dùng lại hàm này với nguồn `DOMAIN`.
        const member = await this.members.insert({
          userId: i.user.id,
          roleId: i.role.id,
        });
        // Spec SP4 §9.6 (review 4B, I1): SAU INSERT, vẫn dưới khoá org, trước event: vi phạm unique (đã là member) bắn
        // trước nên `409 already_member` giữ nguyên; phủ mọi nguồn (CREATOR, INVITATION, INVITE_LINK) mà 3C không gọi
        // entitlements; ném → cả transaction của caller rollback (member, thu hồi grant, lượt dùng link).
        await this.assertSeat(i.admission.source);
        await this.events.publish(MemberAddedEvent, {
          data: {
            memberId: member.publicId,
            userId: i.user.publicId,
            roleId: i.role.publicId,
            source: i.admission.source,
            ...refOf(i.admission),
          },
          aggregate: {
            type: 'member',
            id: member.publicId,
            version: member.version,
          },
          actor: i.actor,
        });
        return member;
      },
      () => ({ 'tenancy.member.source': i.admission.source }),
    );
  }
  /**
   * Ghế = một dòng `org_members` (spec SP4 §9.6, E-6). Gọi SAU INSERT (dòng vừa chèn được đếm, nên đầy là `count > max`) và
   * sau khoá org của caller (mọi đường thêm member khoá org trước; org vừa tạo chưa ai thấy được) dưới READ COMMITTED (mỗi
   * câu một snapshot mới), nên thấy mọi member đã commit; đếm có trần (`countUpTo`, cap = max, trả tối đa max + 1) nên không
   * quét cả org. `max = 0`: không ai vào được (`countUpTo` đòi cap ≥ 1). Lời mời PENDING, org key, support grant không
   * chiếm ghế.
   */
  private async assertSeat(source: Admission['source']): Promise<void> {
    if (!this.seats) return;
    const limit = await this.seats.current();
    switch (limit.kind) {
      case 'UNLIMITED':
        return;
      case 'MAX': {
        const full =
          limit.max === 0 ||
          (await this.members.countUpTo(undefined, limit.max)) > limit.max;
        if (!full) return;
        this.metrics.seatLimitDenied.add(1, { source });
        throw new AppError(CoreErrors.QUOTA_EXCEEDED, {
          fields: [
            {
              path: 'feature',
              code: limit.featureKey,
              message: CoreErrors.QUOTA_EXCEEDED.title,
            },
          ],
          expected: true,
        });
      }
      default: {
        const unknown: never = limit;
        throw new Error(`unknown seat limit ${JSON.stringify(unknown)}`);
      }
    }
  }
}
