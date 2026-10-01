import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import {
  EventPublisher,
  EventSubscriber,
  type EventEnvelope,
  type EventHandler,
} from '../../../core/events/index.js';
import { OrgCreatedEvent } from '../../tenancy/index.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import { EntitlementsContextError } from '../errors.js';
import { ORG_ENTITLEMENT_AGGREGATE, PlanChangedEvent } from '../events.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import { ENTITLEMENT_PLANS } from './entitlement-catalogue.registry.js';

const PROVISION_ACTOR = {
  type: 'system',
  id: 'entitlements.provision-org',
} as const;

/**
 * Lưới dự phòng (S4-D9, E-9): phủ cửa sổ rolling deploy (pod cũ tạo org không có participant). Chạy ở worker trong
 * UnitOfWork + Inbox (SP1) và OrgScope của event. Org đã purge trước khi event tới (`core.event.deliver` chạy cả trên org
 * không còn): câu chèn join `organizations` nên không lỗi FK; ghi INFO và coi là xong (không retry).
 * Race với participant tạo org: event chỉ thấy được sau COMMIT của transaction tạo org, và `ON CONFLICT (org_id) DO NOTHING`
 * trên PK chặn dòng thứ hai trong mọi thứ tự (không check-then-insert).
 */
@Injectable()
@EventSubscriber({
  consumer: 'entitlements.provision-org',
  event: OrgCreatedEvent,
})
export class ProvisionOrgSubscriber implements EventHandler<
  typeof OrgCreatedEvent
> {
  private readonly logger = new Logger(ProvisionOrgSubscriber.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly events: EventPublisher,
    @Inject(ENTITLEMENT_PLANS) private readonly plans: PlanCatalogue,
  ) {}

  async handle(
    e: EventEnvelope<z.infer<typeof OrgCreatedEvent.schema>>,
  ): Promise<void> {
    if (!this.uow.inTransaction() || this.ctx.orgId() !== e.data.orgId)
      throw new EntitlementsContextError(
        'entitlements.provision-org must run in the UnitOfWork and OrgScope of the event organization',
      );
    const toPlan = this.plans.defaultPlan;
    const result = await this.repo.insertDefaultIfAbsent(toPlan);
    switch (result.kind) {
      case 'ORG_GONE':
        this.logger.log(
          { event: 'entitlements_provision_skipped_org_gone' },
          'the organization is gone; nothing to provision',
        );
        return;
      case 'ALREADY_PROVISIONED':
        return;
      case 'INSERTED':
        await this.events.publish(PlanChangedEvent, {
          data: {
            orgId: e.data.orgId,
            fromPlan: null,
            toPlan,
            cause: 'DEFAULT',
            causeRef: null,
          },
          aggregate: {
            type: ORG_ENTITLEMENT_AGGREGATE,
            id: e.data.orgId,
            version: result.version,
          },
          actor: PROVISION_ACTOR,
          causationId: e.id,
        });
        return;
      default: {
        const unknownKind: never = result;
        throw new Error(
          `unknown provision result ${String(Reflect.get(unknownKind, 'kind'))}`,
        );
      }
    }
  }
}
