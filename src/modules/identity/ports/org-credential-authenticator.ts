import type { AuthResult } from './auth-provider.js';

/**
 * Tiền tố của org API key (spec SP3 §10, S3-A8). Hằng của IDENTITY (identity không import tenancy, luật 18): identity
 * định tuyến key mang tiền tố này và cấm Better Auth tạo key mang nó (`/api-key/create`).
 */
export const ORG_API_KEY_PREFIX = 'oak_';
export const isOrgApiKey = (value: string): boolean =>
  value.toLowerCase().startsWith(ORG_API_KEY_PREFIX);

/**
 * Port cho org API key (spec SP3 §5.2): tenancy cài ở plan 3D (`TenancyIdentityPortsModule`, `@Global`). Identity inject
 * `@Optional()`: vắng thì mọi `oak_…` là `REJECTED` (401). Mọi lỗi của chính credential → `REJECTED`; lỗi hạ tầng →
 * `UNAVAILABLE` (không ném).
 */
export abstract class OrgCredentialAuthenticator {
  abstract authenticate(rawKey: string): Promise<AuthResult>;
}
