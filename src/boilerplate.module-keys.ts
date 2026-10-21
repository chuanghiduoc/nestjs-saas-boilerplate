/**
 * Khoá của module nền (spec SP7 §6.2). Tách riêng để `src/composition.config.ts` dùng được kiểu này mà không import
 * `src/boilerplate.modules.ts` (file đó import `composition.config.ts`; dependency-cruiser tính cả import kiểu vào
 * `no-circular`). `BOILERPLATE_MODULES` và `MODULE_REQUIRES` `satisfies Record<BoilerplateModuleKey, …>`, nên thiếu
 * hay thừa khoá ở một trong hai nơi là lỗi biên dịch. Module nền mới thêm khoá ở đây (R-X16).
 */
export type BoilerplateModuleKey =
  | 'notifications'
  | 'identity'
  | 'tenancy'
  | 'entitlements'
  | 'integrations'
  | 'audit';
