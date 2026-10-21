import { describe, expect, it } from 'vitest';
import '../../../../src/core/config/all-configs.js';
import '../../../../src/modules/notifications/notifications.config.js';
import '../../../../src/modules/identity/identity.config.js';
import '../../../../src/modules/tenancy/tenancy.config.js';
import '../../../../src/modules/entitlements/entitlements.config.js';
import '../../../../src/modules/integrations/integrations.config.js';
import {
  configRegistry,
  secretFieldsOf,
} from '../../../../src/core/config/index.js';

/**
 * Bảng allowlist của spec SP7 §12.5. Module sau thêm trường secret (SP5 `BILLING_SEPAY_WEBHOOK_SECRET`, SP6
 * `FILES_S3_*`, `AUTH_SECRETS`) thì import file config của nó ở đây và thêm dòng trong cùng PR, rồi chạy
 * `pnpm chart:secrets`. entitlements và integrations không có trường secret trong config (secret ký webhook
 * nằm ở DB, mã hoá bằng FIELD_ENCRYPTION_KEYS) nhưng được nạp để bảng chứng minh điều đó.
 */
const EXPECTED = [
  { env: 'AUTH_GOOGLE_CLIENT_SECRET', roles: ['api'] },
  { env: 'AUTH_OIDC_CLIENT_SECRET', roles: ['api'] },
  { env: 'BETTER_AUTH_SECRET', roles: ['api', 'worker'] },
  { env: 'DB_APP_PASSWORD', roles: ['api', 'worker'] },
  { env: 'DB_AUTH_PASSWORD', roles: ['api', 'worker'] },
  { env: 'DB_OWNER_PASSWORD', roles: ['migrate'] },
  { env: 'DB_RELAY_PASSWORD', roles: ['worker'] },
  { env: 'FIELD_ENCRYPTION_KEYS', roles: ['api', 'worker'] },
  { env: 'REDIS_URL', roles: ['api', 'worker'] },
  { env: 'SMTP_PASSWORD', roles: ['worker'] },
];

describe('boilerplate secrets are declared in code (spec SP7 §12.5)', () => {
  it('every secret field of core, notifications, identity, tenancy, entitlements and integrations carries secretMeta with its roles', () => {
    expect(secretFieldsOf(configRegistry())).toEqual(EXPECTED);
  });
});
