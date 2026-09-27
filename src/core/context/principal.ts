export type Principal = { type: 'user' | 'api_key' | 'service'; id: string };

/** Cách request chứng minh danh tính (spec SP2 §5.6.1). Principal luôn là user; kind + id của credential phục vụ log/audit. */
export const CREDENTIAL_KINDS = [
  'SESSION_COOKIE',
  'BEARER_SESSION',
  'API_KEY',
  'EXTERNAL_COOKIE',
  'EXTERNAL_BEARER',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** `id` chỉ có với API key (id của key, không phải bí mật). */
export type Credential = { kind: CredentialKind; id?: string };
