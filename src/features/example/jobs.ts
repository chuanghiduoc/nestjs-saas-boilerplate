import { z } from 'zod';
import { defineJob, defineQueue } from '../../core/queue/index.js';
import { defineOrgSweep } from '../../core/sweep/index.js';
import { exampleConfig } from './example.config.js';

/** Queue của feature (quy ước cron S7-D34): phần tỏa ra ở `maintenance`, việc theo org ở đây. */
export const ExampleQueue = defineQueue('example', { kind: 'io' });
/** Việc theo org (org trong `meta.orgId`). `skip` (mặc định) khi org đã xoá mềm: cron xoá cứng của tenancy lo. */
export const PurgeOrgJob = defineJob({
  name: 'example.projects.purge-org',
  queue: ExampleQueue,
  version: 1,
  schema: z.object({}).strict(),
});
/**
 * Spec §10.2, R-X4, R-X14. Tham số thêm truyền THEO TÊN (R-X14); đổi tên `p_retention_sec` phải đổi cả hàm SQL — EX-I15
 * bắt lệch. Ba tham số là hàm để định nghĩa lúc import không đọc env.
 */
export const PurgeArchivedSweep = defineOrgSweep({
  key: 'example.projects.purge-archived',
  definerFunction: 'example_orgs_with_purgeable_projects',
  extraParams: () => ({
    p_retention_sec: exampleConfig().archivedRetentionSec,
  }),
  orgJob: PurgeOrgJob,
  jobIdPrefix: 'example-purge',
  schedule: () => {
    const c = exampleConfig();
    return { cron: c.purgeCron, tz: c.purgeTz };
  },
  batch: () => {
    const c = exampleConfig();
    return { size: c.purgeOrgBatchSize, maxBatches: c.purgeMaxBatches };
  },
});
