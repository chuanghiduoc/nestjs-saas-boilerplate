import { Injectable } from '@nestjs/common';
import { OrgScope, UnitOfWork } from '../../../../core/database/index.js';
import { PlatformRoleChangeListener } from '../../../identity/index.js';
import { DelegationRevocations } from '../../application/delegation-revocations.js';
import { TenancyMetrics } from '../../application/tenancy-metrics.js';
import { OrgRepository } from '../../ports/org-repository.js';
import { SupportGrantRepository } from '../../ports/support-grant-repository.js';
import { TenancyUserRepository } from '../../ports/tenancy-user-repository.js';

const ROLE_CHANGE_ACTOR = {
  type: 'system',
  id: 'identity.platform-role-change',
} as const;

/**
 * Spec SP3 §9.7 (6) (N5-1, T-40): mọi lần ghi role nền tảng của một user qua `/admin/*` thu hồi mọi grant chưa thu hồi của
 * user đó, mỗi org một transaction (khoá org → UPDATE … RETURNING → event), kể cả nâng quyền/ghi lại cùng role (không đọc
 * role cũ). Lỗi giữa chừng: org đã commit giữ kết quả, hook trả 503, gọi lại cùng request là idempotent.
 */
@Injectable()
export class TenancyPlatformRoleChangeListener extends PlatformRoleChangeListener {
  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly grants: SupportGrantRepository,
    private readonly revocations: DelegationRevocations,
    private readonly metrics: TenancyMetrics,
  ) {
    super();
  }

  async onPlatformRoleChanged(authUserId: string): Promise<void> {
    const user = await this.users.find({ kind: 'AUTH_USER', authUserId });
    if (!user) return;
    for (const orgId of await this.grants.granteeOpenGrantOrgs(user.id)) {
      const revoked = await this.scope.run(orgId, () =>
        this.uow.run(async () => {
          if (!(await this.orgs.lockCurrent())) return 0; // org vừa purge
          return this.revocations.revokeGrantsOfGrantee(
            user.id,
            'GRANTEE_ROLE_CHANGED',
            ROLE_CHANGE_ACTOR,
          );
        }),
      );
      if (revoked > 0)
        this.metrics.supportGrantsRevokedOnRoleChange.add(revoked);
    }
  }
}
