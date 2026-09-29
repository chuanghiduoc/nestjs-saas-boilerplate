import type { SystemRoleKey } from '../constants.js';
import type { TenancySubject } from './tenancy-user-repository.js';

export type MembershipLookup =
  | { org: 'MISSING' }
  | {
      org: 'PRESENT';
      deletedAt: Date | null;
      member: {
        id: string;
        publicId: string;
        roleId: string;
        systemKey: SystemRoleKey | null;
      } | null;
    };
/** Đường nóng (spec SP3 §7.3): một câu trong OrgScope của org trên path. Không tạo `tenancy_users` (Review Focus 2). */
export abstract class AccessReader {
  abstract lookup(s: TenancySubject): Promise<MembershipLookup>;
}
