import { definePartitionedTable } from '../../core/partitions/index.js';
import { WEBHOOK_PARTITIONS_LOCK_KEY } from './constants.js';
import { integrationsConfig } from './integrations.config.js';

/** Spec §6.7: một hàm bảo trì lo cả hai bảng (drop deliveries trước messages, spike P2); cron `core.partitions.maintain` gọi. */
export const WebhookPartitions = definePartitionedTable({
  tables: ['webhook_messages', 'webhook_deliveries'],
  maintainFunction: 'webhook_partitions_maintain',
  lockKey: WEBHOOK_PARTITIONS_LOCK_KEY,
  retentionMonths: () => integrationsConfig().deliveryRetentionMonths,
  premakeMonths: () => integrationsConfig().partitionPremakeMonths,
});
