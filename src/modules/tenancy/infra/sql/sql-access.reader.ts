import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../../core/database/index.js';
import { SYSTEM_ROLE_KEYS } from '../../constants.js';
import {
  AccessReader,
  type MembershipLookup,
} from '../../ports/access-reader.js';
import type { TenancySubject } from '../../ports/tenancy-user-repository.js';

const hotPath = (subjectFilter: string): string =>
  `WITH u AS (SELECT id FROM tenancy_users WHERE ${subjectFilter})
SELECT o.deleted_at, m.id::text AS member_id, m.public_id::text AS member_public_id, r.id::text AS role_id, r.system_key
FROM organizations o
LEFT JOIN org_members m ON m.org_id = o.id AND m.user_id = (SELECT id FROM u)
LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.role_id
WHERE o.id = app_current_org()`;
/**
 * Index dùng (spec SP3 §7.3): `tenancy_users_auth_user_uq`/`tenancy_users_external_subject_uq`, PK `organizations`,
 * `org_members_org_user_uq`, `org_roles_org_id_uq`. Principal chưa từng chạm tenancy: `u` rỗng → member NULL → trượt.
 */
export const HOT_PATH_SQL: Record<TenancySubject['kind'], string> = {
  AUTH_USER: hotPath('auth_user_id = ?::uuid'),
  EXTERNAL: hotPath('external_subject = ?'),
};
const Row = z.object({
  deleted_at: z.coerce.date().nullable(),
  member_id: z.string().nullable(),
  member_public_id: z.string().nullable(),
  role_id: z.string().nullable(),
  system_key: z.enum(SYSTEM_ROLE_KEYS).nullable(),
});

@Injectable()
export class SqlAccessReader extends AccessReader {
  constructor(private readonly db: Db) {
    super();
  }
  async lookup(s: TenancySubject): Promise<MembershipLookup> {
    const value = s.kind === 'AUTH_USER' ? s.authUserId : s.externalSubject;
    const rows = await this.db.execute(HOT_PATH_SQL[s.kind], [value]);
    if (rows.length === 0) return { org: 'MISSING' };
    if (rows.length > 1)
      throw new Error(
        `membership lookup returned ${rows.length} rows (expected at most one)`,
      );
    const r = Row.parse(rows[0]);
    if (r.member_id === null)
      return { org: 'PRESENT', deletedAt: r.deleted_at, member: null };
    if (r.member_public_id === null || r.role_id === null)
      throw new Error(
        'membership lookup returned a member without its role (composite FK violated?)',
      );
    return {
      org: 'PRESENT',
      deletedAt: r.deleted_at,
      member: {
        id: r.member_id,
        publicId: r.member_public_id,
        roleId: r.role_id,
        systemKey: r.system_key,
      },
    };
  }
}
