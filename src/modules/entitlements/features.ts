import { UNLIMITED } from './domain/feature-catalogue.js';
import { defineFeatureCatalogue } from './http/decorators.js';

/**
 * Catalogue tính năng của boilerplate (spec §8.1). `tenancy.seats` giữ hành vi SP3 bằng `fallback: UNLIMITED` (S4-D3);
 * `minimum: 1` để org luôn chứa được người tạo. Nối vào tenancy (`MemberSeatLimit`) ở 4B; `files.storage_bytes` thêm ở 4B.
 */
export const BoilerplateFeatures = defineFeatureCatalogue({
  'tenancy.seats': {
    kind: 'LIMIT',
    fallback: UNLIMITED,
    minimum: 1,
    description: 'Members an organization may have (one seat per member)',
  },
});
