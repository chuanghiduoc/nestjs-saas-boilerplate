import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { TenancyErrors } from '../errors.js';
import { MemberAddedEvent } from '../events.js';
import {
  MemberRepository,
  type MemberRow,
} from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import type { RoleRow } from '../ports/role-repository.js';
import type { TenancyUserRef } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { DelegationRevocations } from './delegation-revocations.js';

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
        // 4B (spec SP4 §9.6): kiểm ghế `tenancy.seats` qua port `MemberSeatLimit` (@Optional) đặt ở ĐÂY — sau khoá
        // tenancy_users, trước INSERT — nên phủ mọi nguồn (CREATOR, INVITATION, INVITE_LINK) mà 3C không gọi entitlements.
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
}
