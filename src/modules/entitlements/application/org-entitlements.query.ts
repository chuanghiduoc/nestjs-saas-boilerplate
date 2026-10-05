import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { entitlementsConfig } from '../entitlements.config.js';
import {
  UsageCounterRepository,
  type CurrentUsage,
} from '../ports/usage-counter.repository.js';
import {
  Entitlements,
  type EntitlementSnapshot,
} from './entitlements.service.js';

/**
 * Đọc của API tenant (spec §12.1): snapshot + usage trong MỘT transaction đọc ngắn, nên hai câu thấy cùng `now()` (kỳ của
 * usage khớp `periodStart` trả về). READ COMMITTED: mỗi câu một snapshot, nên một lần đổi gói commit giữa hai câu vẫn được
 * câu sau thấy (chấp nhận: response chỉ để hiển thị, M4). Không ghi gì (S4-D18).
 */
@Injectable()
export class OrgEntitlementsQuery {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly entitlements: Entitlements,
    private readonly usage: UsageCounterRepository,
    @Inject(entitlementsConfig.KEY)
    private readonly cfg: ConfigOf<typeof entitlementsConfig>,
  ) {}

  read(): Promise<{ snapshot: EntitlementSnapshot; usage: CurrentUsage }> {
    return this.uow.run(async () => ({
      snapshot: await this.entitlements.snapshot(),
      usage: await this.usage.currentUsage(this.cfg.quotaTimezone),
    }));
  }
}
