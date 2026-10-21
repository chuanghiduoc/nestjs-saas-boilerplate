import {
  DEFINER_FUNCTIONS,
  DEFINER_INTERNAL_FUNCTIONS,
} from './tenancy-catalog.js';

/** Role NOLOGIN sở hữu đối tượng tạo trong migration dưới `SET LOCAL ROLE <role>` (SP3 §6.13, SP6 §3.2). */
export const NOLOGIN_OWNER_ROLES = [
  'tenancy_definer',
  'sweep_definer',
  'partition_owner',
] as const;
export type NologinOwnerRole = (typeof NOLOGIN_OWNER_ROLES)[number];

/**
 * Tập tên theo plan (như `tenancy-catalog.ts`): test so với HỢP các hằng đang có. Plan 6.0 khai fixture; 6A/6C/SP5/SP7 THÊM
 * hằng `…_6A`, `…_6C`… và nối vào hợp, không sửa hằng có sẵn.
 */
export const SWEEP_DEFINER_FUNCTIONS_FIXTURE = ['fixture_orgs_due'] as const;
export const SWEEP_DEFINER_READ_TABLES_FIXTURE = [
  'fixture_sweep_items',
] as const;
export const PARTITION_OWNER_FUNCTIONS_FIXTURE = [
  'fixture_part_events_maintain',
] as const;
export const PARTITION_OWNER_TRIGGER_FUNCTIONS_FIXTURE = [
  'fixture_part_events_append_only',
] as const;
export const PARTITIONED_TABLES_FIXTURE = ['fixture_part_events'] as const;
/** Plan 6C (spec SP6 §6.5, §6.7, §6.8). */
export const SWEEP_DEFINER_FUNCTIONS_6C = ['integrations_orgs_due'] as const;
export const SWEEP_DEFINER_READ_TABLES_6C = [
  'webhook_endpoints',
  'webhook_endpoint_secrets',
  'webhook_deliveries',
] as const;
export const PARTITION_OWNER_FUNCTIONS_6C = [
  'webhook_partitions_maintain',
] as const;
export const PARTITIONED_TABLES_6C = [
  'webhook_messages',
  'webhook_deliveries',
] as const;
/** Plan 6B (spec SP6 §6.4, §6.7). */
export const PARTITION_OWNER_FUNCTIONS_6B = [
  'audit_partitions_maintain',
] as const;
export const PARTITION_OWNER_TRIGGER_FUNCTIONS_6B = [
  'audit_logs_append_only',
  'audit_logs_no_truncate',
  'platform_audit_logs_append_only',
  'platform_audit_logs_no_truncate',
] as const;
export const PARTITIONED_TABLES_6B = [
  'audit_logs',
  'platform_audit_logs',
] as const;

/** Hàm quét xuyên org (SECURITY DEFINER, STABLE, `app_user` gọi). */
export const SWEEP_DEFINER_FUNCTIONS: readonly string[] = [
  ...SWEEP_DEFINER_FUNCTIONS_FIXTURE,
  ...SWEEP_DEFINER_FUNCTIONS_6C,
];
/** Bảng có policy `<bảng>_definer_read … TO sweep_definer`. */
export const SWEEP_DEFINER_READ_TABLES: readonly string[] = [
  ...SWEEP_DEFINER_READ_TABLES_FIXTURE,
  ...SWEEP_DEFINER_READ_TABLES_6C,
];
/** Hàm bảo trì partition (SECURITY DEFINER, VOLATILE, `app_user` gọi). */
export const PARTITION_OWNER_FUNCTIONS: readonly string[] = [
  ...PARTITION_OWNER_FUNCTIONS_FIXTURE,
  ...PARTITION_OWNER_FUNCTIONS_6C,
  ...PARTITION_OWNER_FUNCTIONS_6B,
];
/** Hàm trigger thuộc `partition_owner` (không SECURITY DEFINER, không ai EXECUTE). */
export const PARTITION_OWNER_TRIGGER_FUNCTIONS: readonly string[] = [
  ...PARTITION_OWNER_TRIGGER_FUNCTIONS_FIXTURE,
  ...PARTITION_OWNER_TRIGGER_FUNCTIONS_6B,
];
export const PARTITIONED_TABLES: readonly string[] = [
  ...PARTITIONED_TABLES_FIXTURE,
  ...PARTITIONED_TABLES_6C,
  ...PARTITIONED_TABLES_6B,
];

/** Hàm → role chủ, cho quét tĩnh migration. */
export const OWNED_FUNCTIONS: Readonly<
  Record<NologinOwnerRole, readonly string[]>
> = {
  tenancy_definer: [...DEFINER_FUNCTIONS, ...DEFINER_INTERNAL_FUNCTIONS],
  sweep_definer: SWEEP_DEFINER_FUNCTIONS,
  partition_owner: [
    ...PARTITION_OWNER_FUNCTIONS,
    ...PARTITION_OWNER_TRIGGER_FUNCTIONS,
  ],
};
