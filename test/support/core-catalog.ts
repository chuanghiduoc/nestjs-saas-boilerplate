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

/** Hàm quét xuyên org (SECURITY DEFINER, STABLE, `app_user` gọi). */
export const SWEEP_DEFINER_FUNCTIONS: readonly string[] = [
  ...SWEEP_DEFINER_FUNCTIONS_FIXTURE,
];
/** Bảng có policy `<bảng>_definer_read … TO sweep_definer`. */
export const SWEEP_DEFINER_READ_TABLES: readonly string[] = [
  ...SWEEP_DEFINER_READ_TABLES_FIXTURE,
];
/** Hàm bảo trì partition (SECURITY DEFINER, VOLATILE, `app_user` gọi). */
export const PARTITION_OWNER_FUNCTIONS: readonly string[] = [
  ...PARTITION_OWNER_FUNCTIONS_FIXTURE,
];
/** Hàm trigger thuộc `partition_owner` (không SECURITY DEFINER, không ai EXECUTE). */
export const PARTITION_OWNER_TRIGGER_FUNCTIONS: readonly string[] = [
  ...PARTITION_OWNER_TRIGGER_FUNCTIONS_FIXTURE,
];
export const PARTITIONED_TABLES: readonly string[] = [
  ...PARTITIONED_TABLES_FIXTURE,
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
