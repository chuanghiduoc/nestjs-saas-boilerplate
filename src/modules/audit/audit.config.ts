import { z } from 'zod';
import { type ConfigOf, defineConfig } from '../../core/config/index.js';
import {
  AUDIT_PREMAKE_MAX_MONTHS,
  AUDIT_RETENTION_MAX_MONTHS,
  AUDIT_RETENTION_MIN_MONTHS,
} from './constants.js';

const months = z.coerce.number().int();

/** Spec SP6 §11.3: sàn và trần cũng viết cứng trong `audit_partitions_maintain` (SQLi không hạ được sàn). */
export const auditConfig = defineConfig(
  'audit',
  {
    retentionMonths: 'AUDIT_RETENTION_MONTHS',
    partitionPremakeMonths: 'AUDIT_PARTITION_PREMAKE_MONTHS',
  },
  z.object({
    retentionMonths: months
      .min(AUDIT_RETENTION_MIN_MONTHS)
      .max(AUDIT_RETENTION_MAX_MONTHS)
      .default(13)
      .describe(
        `Months of audit kept (${AUDIT_RETENTION_MIN_MONTHS}-${AUDIT_RETENTION_MAX_MONTHS}); a month partition is dropped once all of it is older, so N to N+1 months are kept`,
      ),
    partitionPremakeMonths: months
      .min(1)
      .max(AUDIT_PREMAKE_MAX_MONTHS)
      .default(3)
      .describe('Future month partitions kept ready for both audit tables'),
  }),
);
export type AuditConfig = ConfigOf<typeof auditConfig>;
