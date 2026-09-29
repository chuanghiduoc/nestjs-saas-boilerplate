import { z } from 'zod';
import { MaintenanceQueue, defineJob } from '../../core/queue/index.js';
import { defineCron } from '../../core/scheduler/index.js';
import { tenancyConfig } from './tenancy.config.js';

/** Cron: đi qua org tới hạn theo con trỏ keyset, enqueue một job mỗi org (spec SP3 §9.5, CDX-8). Không org nào trong meta. */
export const PurgeOrgsJob = defineJob({
  name: 'tenancy.orgs.purge',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
/**
 * Xoá cứng MỘT org; org ở `meta.orgId` (worker tự mở OrgScope), payload rỗng. `onInactiveOrg: 'run'`: job này CHỈ có
 * nghĩa trên org đã xoá mềm (gate mặc định sẽ bỏ qua nó, spec §5.2).
 */
export const PurgeOrgJob = defineJob({
  name: 'tenancy.org.purge',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}).strict(),
  onInactiveOrg: 'run',
});
/** `-`, không `:` (core cấm `:` trong jobId, CDX-7); BullMQ bỏ qua `add` trùng id khi job cùng id còn được giữ (T-14). */
export const purgeJobId = (orgId: string): string => `tenancy-purge-${orgId}`;

defineCron({
  key: 'tenancy.orgs.purge',
  job: PurgeOrgsJob,
  payload: {},
  schedule: () => {
    const c = tenancyConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
});
