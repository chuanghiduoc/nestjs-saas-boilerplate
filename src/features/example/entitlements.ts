import {
  UNLIMITED,
  defineFeatureCatalogue,
} from '../../modules/entitlements/index.js';

/**
 * Spec SP7 §7.2, §10.4. Dòng `entitlement_features` cùng migration. Fallback rộng: dự án không đặt gì trong catalogue gói
 * thì mẫu chạy như không có gói; `UNLIMITED` vẫn ghi bộ đếm nên "bộ đếm = số dòng" đúng cả khi không giới hạn.
 */
export const ExampleFeatures = defineFeatureCatalogue({
  'example.projects': {
    kind: 'FLAG',
    fallback: true,
    description: 'Projects (sample feature)',
  },
  'example.project_count': {
    kind: 'QUOTA',
    resetPeriod: 'NONE',
    fallback: UNLIMITED,
    description: 'Number of projects',
  },
});
