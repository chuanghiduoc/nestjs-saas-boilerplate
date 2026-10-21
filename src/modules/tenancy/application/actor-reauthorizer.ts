import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  MemberRepository,
  type MemberRow,
} from '../ports/member-repository.js';
import { RolePermissions } from './authz/role-permissions.js';
import { TenancyMetrics } from './tenancy-metrics.js';

export type Reauthorized = {
  actor: MemberRow;
  permissions: ReadonlySet<string>;
  locked: readonly MemberRow[];
};

/**
 * Spec SP3 §8.6 bước 4–5 (TOCTOU, T-10): trong transaction ĐÃ khoá org, đọc lại actor (và các member bị chạm) `FOR SHARE`
 * theo id tăng dần, tính lại quyền, kiểm lại cửa. Quyết định của `PoliciesGuard` chỉ là tư vấn.
 */
@Injectable()
export class ActorReauthorizer {
  private readonly logger = new Logger(ActorReauthorizer.name);

  constructor(
    private readonly ctx: RequestContext,
    private readonly members: MemberRepository,
    private readonly rolePermissions: RolePermissions,
    private readonly metrics: TenancyMetrics,
  ) {}

  async require(
    keys: readonly string[],
    lockAlso: readonly string[] = [],
  ): Promise<Reauthorized> {
    const access = this.ctx.orgAccess();
    if (access?.via !== 'MEMBERSHIP')
      throw new Error('an admin mutation ran without a MEMBERSHIP orgAccess');
    const self = await this.members.findByPublicId(access.ref);
    if (!self) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    const ids = [...new Set([self.id, ...lockAlso])].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    );
    const locked = await this.members.lockForShare(ids);
    const actor = locked.find((m) => m.id === self.id);
    if (!actor) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    const permissions = new Set(
      await this.rolePermissions.of({
        id: actor.roleId,
        systemKey: actor.systemKey,
      }),
    );
    const missing = keys.filter((k) => !permissions.has(k));
    if (missing.length > 0) {
      this.metrics.policyDenied.add(1, { reason: 'permission' });
      this.logger.warn(
        {
          event: 'policy_denied',
          reason: 'permission',
          missing,
          stage: 'transaction',
        },
        'actor lost the permission before the transaction',
      );
      throw new AppError(CoreErrors.FORBIDDEN, { expected: true });
    }
    return { actor, permissions, locked };
  }
}
