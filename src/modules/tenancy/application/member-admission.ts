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

export type AdmissionSource = 'CREATOR' | 'INVITATION' | 'INVITE_LINK';

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
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async admit(i: {
    user: TenancyUserRef;
    role: RoleRow;
    source: AdmissionSource;
    actor: EventActor;
  }): Promise<MemberRow> {
    if (!this.uow.inTransaction())
      throw new Error('MemberAdmission.admit must run inside UnitOfWork.run');
    // Span `tenancy.member.admit` (spec SP3 §16, review M4): chỉ nguồn (enum hữu hạn) làm attribute.
    return tenancySpan(
      'tenancy.member.admit',
      async () => {
        // T-7: đếm SAU khi đã khoá tenancy_users của user, nên hai lần join song song thấy nhau.
        if (
          this.cfg.membershipMode === 'single' &&
          (await this.orgs.countForUser(i.user.id, true)) > 0
        )
          throw new AppError(TenancyErrors.ALREADY_IN_AN_ORG);
        // 3D (SEC-M5): thu hồi support grant chưa thu hồi của chính user trong org, trước INSERT (spec Bảng 5).
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
            source: i.source,
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
      () => ({ 'tenancy.member.source': i.source }),
    );
  }
}
