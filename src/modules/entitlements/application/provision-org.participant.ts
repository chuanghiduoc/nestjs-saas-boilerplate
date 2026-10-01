import { Inject, Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import {
  OrgCreationParticipant,
  OrgCreationParticipantContributor,
} from '../../tenancy/index.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import { EntitlementsContextError } from '../errors.js';
import { ORG_ENTITLEMENT_AGGREGATE, PlanChangedEvent } from '../events.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import { ENTITLEMENT_PLANS } from './entitlement-catalogue.registry.js';

/**
 * S4-D9: org mới có dòng `org_entitlements` NGAY trong transaction tạo org (không có cửa sổ "org chưa có gói"), chạy trước
 * `MemberAdmission` của người tạo (4B đọc ghế lúc đó; `minimum: 1` của `tenancy.seats` bảo đảm người tạo vào được).
 */
@Injectable()
@OrgCreationParticipantContributor({ key: 'entitlements.provision', order: 0 })
export class ProvisionOrgParticipant extends OrgCreationParticipant {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly events: EventPublisher,
    @Inject(ENTITLEMENT_PLANS) private readonly plans: PlanCatalogue,
  ) {
    super();
  }

  async onOrgCreated(orgId: string, actor: EventActor): Promise<void> {
    if (!this.uow.inTransaction() || this.ctx.orgId() !== orgId)
      throw new EntitlementsContextError(
        'the entitlements creation participant must run in the creation transaction and OrgScope of the new org',
      );
    const toPlan = this.plans.defaultPlan;
    const { version } = await this.repo.insertDefault(toPlan);
    await this.events.publish(PlanChangedEvent, {
      data: { orgId, fromPlan: null, toPlan, cause: 'DEFAULT', causeRef: null },
      aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
      actor,
    });
  }
}
