export type Principal = { type: 'user' | 'api_key' | 'service'; id: string };

/** Cách request chứng minh danh tính (spec SP2 §5.6.1). Principal luôn là user; kind + id của credential phục vụ log/audit. */
export const CREDENTIAL_KINDS = [
  'SESSION_COOKIE',
  'BEARER_SESSION',
  'API_KEY',
  'EXTERNAL_COOKIE',
  'EXTERNAL_BEARER',
  /** Spec SP3 §5.2 (3D): org API key `oak_…`, principal `{ type: 'api_key' }`, gắn cứng một org. */
  'ORG_API_KEY',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** `id` chỉ có với API key (id của key, không phải bí mật); `orgId` chỉ có với `ORG_API_KEY`. */
export type Credential = { kind: CredentialKind; id?: string; orgId?: string };
