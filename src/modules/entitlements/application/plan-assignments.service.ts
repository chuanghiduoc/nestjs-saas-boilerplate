import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import {
  AppError,
  CoreErrors,
  zodIssuesToFields,
} from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { REASON_MAX_LENGTH, SOURCE_REF_MAX_LENGTH } from '../constants.js';
import {
  decideAssignment,
  type AssignPlanCommand,
} from '../domain/plan-assignment.js';
import { entitlementsConfig } from '../entitlements.config.js';
import { entitlementsSpan } from '../entitlements-telemetry.js';
import {
  EntitlementsContextError,
  EntitlementsRowMissingError,
  UnknownPlanError,
} from '../errors.js';
import { ORG_ENTITLEMENT_AGGREGATE, PlanChangedEvent } from '../events.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import {
  EntitlementsMetrics,
  type AssignmentMetricResult,
} from './entitlements-metrics.js';

export type AssignmentResult =
  | {
      readonly kind: 'APPLIED';
      readonly fromPlan: string;
      readonly toPlan: string;
      readonly version: number;
    }
  | { readonly kind: 'UNCHANGED'; readonly version: number }
  | { readonly kind: 'STALE'; readonly lastBillingSeq: bigint }
  | { readonly kind: 'REJECTED_RETIRED'; readonly planKey: string };

/** Code point như `char_length` của `CHECK` (một emoji là 1, không phải 2 đơn vị UTF-16). */
const codePoints = (s: string): number => Array.from(s).length;
const Command = z.object({
  planKey: z.string().min(1),
  cause: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('BILLING'),
      ref: z
        .string()
        .refine(
          (r) => codePoints(r) >= 1 && codePoints(r) <= SOURCE_REF_MAX_LENGTH,
        ),
      sequence: z.bigint().min(1n),
    }),
    z.object({
      kind: z.literal('PLATFORM_ADMIN'),
      reason: z
        .string()
        .refine(
          (r) =>
            r === r.trim() &&
            codePoints(r) >= 1 &&
            codePoints(r) <= REASON_MAX_LENGTH,
        ),
      expectedVersion: z.int().min(1),
    }),
  ]),
});
/** Actor của lệnh BILLING không có principal (job billing của SP5 chạy ở worker, spec §13.1). */
const BILLING_SYSTEM_ACTOR: EventActor = { type: 'system', id: 'billing' };

/**
 * Điểm nối SP5 (spec §10, R-X1): chạy TRONG UoW + OrgScope của caller, SAU khoá của caller (thứ tự §3.6), có hiệu lực lúc
 * commit. Kết quả nghiệp vụ không bao giờ là exception; lỗi có tên luôn ném trước câu ghi đầu tiên (C-2), nên transaction tiền
 * của SP5 vẫn commit được. Không đọc giá trị gói hiện tại trong catalogue của pod: không bao giờ `EntitlementsVersionSkewError`.
 * Race (spec §17): hai lệnh cùng org xếp hàng ở `FOR NO KEY UPDATE` trên dòng `org_entitlements`; quyết định (so `sequence`
 * với `last_billing_seq`, so `expectedVersion` với `version`) đọc dưới khoá đó, nên lệnh cũ hơn là STALE/412, không ghi đè.
 */
@Injectable()
export class PlanAssignments {
  private readonly logger = new Logger(PlanAssignments.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly repo: OrgEntitlementRepository,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly events: EventPublisher,
    private readonly metrics: EntitlementsMetrics,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  /** Gói dự phòng khi subscription hết hạn (thay `BILLING_FALLBACK_PLAN_KEY` của SP5, R-X1). */
  defaultPlanKey(): string {
    return this.registry.plans().defaultPlan;
  }

  async assign(cmd: AssignPlanCommand): Promise<AssignmentResult> {
    const orgId = this.ctx.orgId();
    if (!this.uow.inTransaction() || orgId === undefined)
      throw new EntitlementsContextError(
        'PlanAssignments.assign must run inside the caller UnitOfWork and OrgScope',
      );
    const parsed = Command.safeParse(cmd);
    if (!parsed.success)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: zodIssuesToFields(parsed.error.issues),
      });
    const actor = this.actorOf(cmd);
    return entitlementsSpan(
      'entitlements.plan.assign',
      () => this.run(orgId, cmd, actor),
      (r) => ({
        'entitlements.cause': cmd.cause.kind,
        'entitlements.result': r.kind,
      }),
    );
  }

  private actorOf(cmd: AssignPlanCommand): EventActor {
    const p = this.ctx.principal();
    switch (cmd.cause.kind) {
      case 'BILLING':
        return p ? { type: 'user', id: p.id } : BILLING_SYSTEM_ACTOR;
      case 'PLATFORM_ADMIN':
        if (!p)
          throw new EntitlementsContextError(
            'a PLATFORM_ADMIN assignment needs the staff principal in the request context',
          );
        return { type: 'user', id: p.id };
      default: {
        const unknownCause: never = cmd.cause;
        throw new Error(
          `unknown assignment cause ${String(Reflect.get(unknownCause, 'kind'))}`,
        );
      }
    }
  }

  private async run(
    orgId: string,
    cmd: AssignPlanCommand,
    actor: EventActor,
  ): Promise<AssignmentResult> {
    const cause = cmd.cause;
    if (!this.registry.plans().plans.has(cmd.planKey)) {
      this.count(cause.kind, 'unknown_plan');
      this.logger.error(
        {
          event: 'entitlements_unknown_plan',
          planKey: cmd.planKey,
          cause: cause.kind,
        },
        'assign was given a plan this pod does not know',
      );
      throw new UnknownPlanError(cmd.planKey);
    }
    const row = await this.repo.lockForAssignment(cmd.planKey);
    if (!row) {
      this.count(cause.kind, 'row_missing');
      this.metrics.rowMissing.add(1);
      this.logger.error(
        { event: 'entitlements_row_missing', cause: cause.kind },
        'assign found no org_entitlements row',
      );
      throw new EntitlementsRowMissingError(this.cfg.rowMissingRetryAfterSec);
    }
    if (!row.target) {
      this.count(cause.kind, 'unknown_plan');
      this.logger.error(
        {
          event: 'entitlements_unknown_plan',
          planKey: cmd.planKey,
          cause: cause.kind,
        },
        'the plan is in the catalogue but not in the plans table',
      );
      throw new UnknownPlanError(cmd.planKey);
    }
    const decision = decideAssignment(
      row.current,
      { key: row.target.key, retired: row.target.retired },
      cause,
    );
    const billingSeq = cause.kind === 'BILLING' ? cause.sequence : null;
    switch (decision.kind) {
      case 'VERSION_MISMATCH':
        this.count(cause.kind, 'precondition_failed');
        throw new AppError(CoreErrors.PRECONDITION_FAILED, { expected: true });
      case 'STALE':
        this.count(cause.kind, 'stale');
        this.logger.log(
          { event: 'entitlements_assignment_stale', cause: cause.kind },
          'an older plan command was ignored',
        );
        return { kind: 'STALE', lastBillingSeq: decision.lastBillingSeq };
      case 'REJECTED_RETIRED':
        if (billingSeq !== null)
          await this.repo.recordBillingSequence(billingSeq);
        this.count(cause.kind, 'rejected_retired');
        return { kind: 'REJECTED_RETIRED', planKey: cmd.planKey };
      case 'UNCHANGED':
        if (billingSeq !== null)
          await this.repo.recordBillingSequence(billingSeq);
        this.count(cause.kind, 'unchanged');
        return { kind: 'UNCHANGED', version: row.current.version };
      case 'APPLY': {
        const causeRef = cause.kind === 'BILLING' ? cause.ref : null;
        const version = await this.repo.applyAssignment({
          planId: row.target.id,
          source: cause.kind,
          sourceRef: causeRef,
          reason: cause.kind === 'PLATFORM_ADMIN' ? cause.reason : null,
          billingSequence: billingSeq,
        });
        await this.events.publish(PlanChangedEvent, {
          data: {
            orgId,
            fromPlan: row.current.planKey,
            toPlan: cmd.planKey,
            cause: cause.kind,
            causeRef,
          },
          aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
          actor,
        });
        this.count(cause.kind, 'applied');
        return {
          kind: 'APPLIED',
          fromPlan: row.current.planKey,
          toPlan: cmd.planKey,
          version,
        };
      }
      default: {
        const unknownDecision: never = decision;
        throw new Error(
          `unknown assignment decision ${String(Reflect.get(unknownDecision, 'kind'))}`,
        );
      }
    }
  }

  private count(
    cause: AssignPlanCommand['cause']['kind'],
    result: AssignmentMetricResult,
  ): void {
    this.metrics.planAssignments.add(1, { cause, result });
  }
}
