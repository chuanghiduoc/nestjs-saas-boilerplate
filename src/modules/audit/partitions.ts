import { definePartitionedTable } from '../../core/partitions/index.js';
import { auditConfig } from './audit.config.js';
import { AUDIT_PARTITIONS_LOCK_KEY, AUDIT_TABLES } from './constants.js';

/** Spec §6.7: một hàm bảo trì lo cả hai bảng audit; cron `core.partitions.maintain` gọi. */
export const AuditPartitions = definePartitionedTable({
  tables: [...AUDIT_TABLES],
  maintainFunction: 'audit_partitions_maintain',
  lockKey: AUDIT_PARTITIONS_LOCK_KEY,
  retentionMonths: () => auditConfig().retentionMonths,
  premakeMonths: () => auditConfig().partitionPremakeMonths,
});
