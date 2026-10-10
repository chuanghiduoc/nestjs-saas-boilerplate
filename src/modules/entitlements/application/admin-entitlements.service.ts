import { Injectable } from '@nestjs/common';
import { OrgScope, UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { decideAssignment } from '../domain/plan-assignment.js';
import { EntitlementsErrors, UnknownPlanError } from '../errors.js';
import { OrgEntitlementRepository } from '../ports/org-entitlement.repository.js';
import {
  AdminEntitlementsQuery,
  type AdminView,
} from './admin-entitlements.query.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';
import {
  EntitlementsMetrics,
  type AssignmentMetricResult,
} from './entitlements-metrics.js';
import { Overrides, type SetOverrideCommand } from './overrides.service.js';
import {
  PlanAssignments,
  type AssignmentResult,
} from './plan-assignments.service.js';

export type StaffPlanCommand = {
  readonly planKey: string;
  readonly reason: string;
};

const unknownPlan = (): AppError =>
  new AppError(EntitlementsErrors.UNKNOWN_PLAN, { expected: true });

/**
 * Điều phối route admin (spec §12.2): mở `OrgScope.run(orgId)` KHÔNG qua membership (ngoại lệ có tên S4-D19, chỉ sau khi
 * `@PlatformStaffAction()` đã cho qua; RLS vẫn giới hạn mọi câu vào đúng org) + `UnitOfWork`, khoá dòng gốc và so `If-Match`
 * cụ thể dưới khoá (`*` → 428), rồi gán gói (`PlanAssignments.assign` với `PLATFORM_ADMIN` + `expectedVersion` = version đã
 * khoá, nên nhánh 412 của `assign` là kiểm lại trùng) hoặc ghi override, và đọc lại view trong cùng transaction.
 */
@Injectable()
export class AdminEntitlements {
  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly query: AdminEntitlementsQuery,
    private readonly overrides: Overrides,
    private readonly roots: OrgEntitlementRepository,
    private readonly assignments: PlanAssignments,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly metrics: EntitlementsMetrics,
  ) {}

  /** REPEATABLE READ: gốc, snapshot, usage, override thấy cùng một snapshot, nên `version` (ETag) khớp nội dung trả về. */
  view(orgId: string): Promise<AdminView> {
    return this.scope.run(orgId, () =>
      this.uow.run(() => this.query.read(), { isolation: 'repeatable read' }),
    );
  }

  assignPlan(
    orgId: string,
    ifMatch: string | undefined,
    cmd: StaffPlanCommand,
  ): Promise<AdminView> {
    return this.inOrg(orgId, async () => {
      // Key nhân viên gõ sai là lỗi của người dùng (422), không phải ERROR vận hành của `assign`. Vẫn đếm: alert F-7 lọc
      // `cause="BILLING"` (README).
      if (!this.registry.plans().plans.has(cmd.planKey)) {
        this.count('unknown_plan');
        throw unknownPlan();
      }
      const root = await this.overrides.lockForWrite(ifMatch);
      // Review vòng 2, M-2 (như PUT override, RFC 9110 §13.1.1): trạng thái yêu cầu đã có (cùng gói, cùng nguồn
      // PLATFORM_ADMIN, cùng lý do) → 200 với ETag hiện tại, kể cả If-Match cũ; khác → so version (412). Câu khoá của
      // `assign` chạy lại trong cùng transaction (đã giữ khoá) nên không đổi thứ tự khoá.
      const row = await this.roots.lockForAssignment(cmd.planKey);
      if (row?.target) {
        const decision = decideAssignment(
          row.current,
          { key: row.target.key, retired: row.target.retired },
          {
            kind: 'PLATFORM_ADMIN',
            reason: cmd.reason,
            expectedVersion: row.current.version,
          },
        );
        if (decision.kind === 'UNCHANGED') return this.query.read();
      }
      this.assertVersionCounted(ifMatch, root.version);
      const r = await this.assign(cmd, root.version);
      switch (r.kind) {
        case 'APPLIED':
        case 'UNCHANGED':
          return this.query.read();
        case 'REJECTED_RETIRED':
          throw new AppError(EntitlementsErrors.PLAN_RETIRED, {
            expected: true,
          });
        case 'STALE':
          throw new Error(
            'a PLATFORM_ADMIN assignment returned STALE, which only a BILLING command can',
          );
        default: {
          const unknown: never = r;
          throw new Error(
            `unknown assignment result ${JSON.stringify(unknown)}`,
          );
        }
      }
    });
  }

  setOverride(
    orgId: string,
    featureKey: string,
    ifMatch: string | undefined,
    cmd: SetOverrideCommand,
  ): Promise<AdminView> {
    return this.inOrg(orgId, async () => {
      await this.overrides.set(featureKey, cmd, ifMatch);
      return this.query.read();
    });
  }

  removeOverride(
    orgId: string,
    featureKey: string,
    reason: string,
    ifMatch: string | undefined,
  ): Promise<number> {
    return this.inOrg(orgId, () =>
      this.overrides.remove(featureKey, reason, ifMatch),
    );
  }

  private inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return this.scope.run(orgId, () => this.uow.run(fn));
  }

  /** 412 của nhân viên vào `entitlements_plan_assignments_total{result="precondition_failed"}` (spec §19, E-7). */
  private assertVersionCounted(
    ifMatch: string | undefined,
    version: number,
  ): void {
    try {
      assertIfMatch(ifMatch, version, { required: true });
    } catch (err) {
      if (
        err instanceof AppError &&
        err.error.code === CoreErrors.PRECONDITION_FAILED.code
      )
        this.count('precondition_failed');
      throw err;
    }
  }

  /** Gói có trong catalogue mà thiếu ở bảng `plans` (migration chưa chạy): `assign` đã log ERROR; với nhân viên vẫn là 422. */
  private async assign(
    cmd: StaffPlanCommand,
    expectedVersion: number,
  ): Promise<AssignmentResult> {
    try {
      return await this.assignments.assign({
        planKey: cmd.planKey,
        cause: { kind: 'PLATFORM_ADMIN', reason: cmd.reason, expectedVersion },
      });
    } catch (err) {
      if (err instanceof UnknownPlanError) throw unknownPlan();
      throw err;
    }
  }

  private count(result: AssignmentMetricResult): void {
    this.metrics.planAssignments.add(1, { cause: 'PLATFORM_ADMIN', result });
  }
}
