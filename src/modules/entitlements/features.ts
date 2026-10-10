import { FILES_STORAGE_FALLBACK_BYTES } from './constants.js';
import { UNLIMITED } from './domain/feature-catalogue.js';
import { defineFeatureCatalogue } from './http/decorators.js';

/**
 * Catalogue tính năng của boilerplate (spec §8.1). `tenancy.seats` giữ hành vi SP3 bằng `fallback: UNLIMITED` (S4-D3);
 * `minimum: 1` để org luôn chứa được người tạo; nối vào tenancy qua `MemberSeatLimit` (4B). `files.storage_bytes` (byte)
 * khai báo luôn, kể cả khi dự án tắt files: dòng DB do migration 4B chèn vô điều kiện; adapter `FileStorageLimit` là của
 * 6A (R-X29).
 */
export const BoilerplateFeatures = defineFeatureCatalogue({
  'tenancy.seats': {
    kind: 'LIMIT',
    fallback: UNLIMITED,
    minimum: 1,
    description: 'Members an organization may have (one seat per member)',
  },
  'files.storage_bytes': {
    kind: 'LIMIT',
    fallback: { max: FILES_STORAGE_FALLBACK_BYTES },
    minimum: 0,
    description: 'Bytes of stored files an organization may keep',
  },
});
