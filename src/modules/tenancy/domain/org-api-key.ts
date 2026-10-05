import { randomBytes } from 'node:crypto';
import { KEY_HINT_LENGTH, ORG_API_KEY_SECRET_BYTES } from '../constants.js';
import { tokenHashHex } from './acquisition-token.js';

/** Spec §14: lý do thu hồi org key (chuyển trạng thái ngầm khi người tạo bị gỡ: §14.1). */
export const API_KEY_REVOKE_REASONS = ['REVOKED', 'CREATOR_REMOVED'] as const;
export type ApiKeyRevokeReason = (typeof API_KEY_REVOKE_REASONS)[number];

export type OrgApiKeySecret = { token: string; hashHex: string; hint: string };
/**
 * SHA-256 của toàn bộ key (secret 256 bit ngẫu nhiên, không cần băm chậm; spec §10), cùng phép băm với token thu nhận.
 * Hex để đi qua `decode(?, 'hex')`.
 */
export const orgApiKeyHashHex = (token: string): string => tokenHashHex(token);
/** `prefix` = `ORG_API_KEY_PREFIX` của identity (application truyền vào: domain không import module khác). */
export function newOrgApiKeySecret(prefix: string): OrgApiKeySecret {
  const random = randomBytes(ORG_API_KEY_SECRET_BYTES).toString('base64url');
  const token = `${prefix}${random}`;
  return {
    token,
    hashHex: orgApiKeyHashHex(token),
    hint: `${prefix}${random.slice(0, KEY_HINT_LENGTH)}`,
  };
}
export const ORG_API_KEY_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type OrgApiKeyStatus = (typeof ORG_API_KEY_STATUSES)[number];
/** Trạng thái suy ra (không lưu, không cron; S3-A36). */
export const orgApiKeyStatusOf = (
  k: { revokedAt: Date | null; expiresAt: Date },
  now: Date,
): OrgApiKeyStatus =>
  k.revokedAt !== null
    ? 'REVOKED'
    : k.expiresAt.getTime() <= now.getTime()
      ? 'EXPIRED'
      : 'ACTIVE';
