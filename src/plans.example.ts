import {
  UNLIMITED,
  definePlanCatalogue,
} from './modules/entitlements/index.js';

/**
 * Vùng TEMPLATE (spec SP4 S4-D22, SP7 §6.1): catalogue gói mẫu của upstream. `upstream:init` chép nguyên văn thành
 * `src/app.plans.ts` (vùng dự án; tên export giữ `examplePlans`, R-X20); dự án đặt gói thật ở bản chép, upstream không sửa bản chép. Khớp migration mẫu
 * `src/migrations/example/…_starter_plans` (hai dòng `plans`, Task 8). `free` để `tenancy.seats` ở `fallback` (không giới
 * hạn) nên hành vi SP3 (test link `N + k`, O-12…) giữ nguyên cho tới khi dự án đặt số thật.
 */
export const examplePlans = definePlanCatalogue({
  defaultPlan: 'free',
  plans: {
    free: { values: {} },
    pro: { values: { 'tenancy.seats': UNLIMITED } },
  },
});
