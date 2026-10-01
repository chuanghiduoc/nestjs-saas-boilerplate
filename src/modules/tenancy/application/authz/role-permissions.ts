import { Injectable, Logger } from '@nestjs/common';
import type { SystemRoleKey } from '../../constants.js';
import { RoleRepository } from '../../ports/role-repository.js';
import { PermissionCatalogueRegistry } from '../permission-catalogue.registry.js';
import { TenancyMetrics } from '../tenancy-metrics.js';
import {
  customRolePermissions,
  effectivePermissions,
  type CustomRolePermissions,
} from './effective-permissions.js';

export type RoleRef = { id: string; systemKey: SystemRoleKey | null };

/**
 * Nguồn DUY NHẤT của quyền hiệu lực của một role (middleware, `ActorReauthorizer`, `MemberService`, `RoleService`,
 * `GET …/roles`): role hệ thống tính trong code, role tuỳ biến đọc bằng MỘT câu cho cả lô. Chạy trong OrgScope +
 * transaction của caller (sau khoá org ở các mutation, nên thấy tập đã commit mới nhất, T-8). Key orphan (R-X23) bị bỏ
 * qua; mỗi key WARN + cộng metric MỘT lần mỗi process (đường nóng không làm ngập log; tập nhớ bị chặn bởi số key có dòng
 * `permissions` mà không catalogue nào nạp, tức vài key của module đã tắt).
 */
@Injectable()
export class RolePermissions {
  private readonly logger = new Logger(RolePermissions.name);
  private readonly reportedOrphans = new Set<string>();

  constructor(
    private readonly roles: RoleRepository,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly metrics: TenancyMetrics,
  ) {}

  async of(role: RoleRef): Promise<string[]> {
    return (await this.detailOf(role)).granted;
  }

  async ofMany(roles: readonly RoleRef[]): Promise<Map<string, string[]>> {
    const detail = await this.detailMany(roles);
    return new Map([...detail].map(([id, d]) => [id, d.granted]));
  }

  /** Tập đã cấp + key orphan còn lưu (role hệ thống: không có orphan). */
  async detailOf(role: RoleRef): Promise<CustomRolePermissions> {
    const out = (await this.detailMany([role])).get(role.id);
    if (!out) throw new Error(`RolePermissions lost role ${role.id}`);
    return out;
  }

  private async detailMany(
    roles: readonly RoleRef[],
  ): Promise<Map<string, CustomRolePermissions>> {
    const merged = this.registry.merged();
    const custom = roles.filter((r) => r.systemKey === null).map((r) => r.id);
    const stored =
      custom.length > 0
        ? await this.roles.permissionKeys(custom)
        : new Map<string, string[]>();
    const out = new Map<string, CustomRolePermissions>();
    for (const r of roles) {
      if (r.systemKey !== null) {
        out.set(r.id, {
          granted: effectivePermissions(r, merged),
          orphans: [],
        });
        continue;
      }
      const keys = stored.get(r.id);
      if (keys === undefined)
        throw new Error(`permissionKeys did not return role ${r.id}`);
      const set = customRolePermissions(keys, merged);
      for (const key of set.orphans) this.reportOrphan(key);
      out.set(r.id, set);
    }
    return out;
  }

  private reportOrphan(key: string): void {
    if (this.reportedOrphans.has(key)) return;
    this.reportedOrphans.add(key);
    this.metrics.catalogueOrphanKeys.add(1, { source: 'custom_role' });
    // Key catalogue không phải PII; không log role, org hay user.
    this.logger.warn(
      { event: 'orphan_permission_ignored', key },
      'a custom role holds a permission that no loaded catalogue declares; it grants nothing',
    );
  }
}
