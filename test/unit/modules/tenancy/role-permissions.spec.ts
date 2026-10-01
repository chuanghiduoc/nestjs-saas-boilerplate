import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RolePermissions } from '../../../../src/modules/tenancy/application/authz/role-permissions.js';
import type { PermissionCatalogueRegistry } from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import type { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import { mergeCatalogues } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { systemRolePermissions } from '../../../../src/modules/tenancy/domain/system-roles.js';
import { TENANCY_CATALOGUE } from '../../../../src/modules/tenancy/domain/tenancy-catalogue.js';
import type { RoleRepository } from '../../../../src/modules/tenancy/ports/role-repository.js';

const merged = mergeCatalogues([TENANCY_CATALOGUE]);
const registry = { merged: () => merged } as Pick<
  PermissionCatalogueRegistry,
  'merged'
> as PermissionCatalogueRegistry;
/** Repository giả: ghi lại mỗi lần gọi để khẳng định số câu SQL. */
const fakeRoles = (stored: Record<string, string[]>) => {
  const calls: string[][] = [];
  const repo = {
    permissionKeys: (ids: readonly string[]) => {
      calls.push([...ids]);
      return Promise.resolve(new Map(ids.map((id) => [id, stored[id] ?? []])));
    },
  } as Pick<RoleRepository, 'permissionKeys'> as RoleRepository;
  return { repo, calls };
};
/** Metric giả: ghi lại mỗi lần cộng `tenancy_catalogue_orphan_keys`. */
const fakeMetrics = () => {
  const adds: [number, Record<string, string> | undefined][] = [];
  const add = (v: number, attrs?: Record<string, string>): void => {
    adds.push([v, attrs]);
  };
  const metrics = { catalogueOrphanKeys: { add } } as Pick<
    TenancyMetrics,
    'catalogueOrphanKeys'
  > as TenancyMetrics;
  return { metrics, adds };
};
const build = (stored: Record<string, string[]>) => {
  const roles = fakeRoles(stored);
  const m = fakeMetrics();
  return {
    ...roles,
    ...m,
    rp: new RolePermissions(roles.repo, registry, m.metrics),
  };
};

describe('RolePermissions (spec SP3 §7.3: one extra query, only for custom roles)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('system roles never query; custom roles are read in one batched call', async () => {
    const { rp, calls } = build({
      '7': ['org.read'],
      '8': ['org.read', 'members.read'],
    });
    const out = await rp.ofMany([
      { id: '1', systemKey: 'ADMIN' },
      { id: '7', systemKey: null },
      { id: '8', systemKey: null },
    ]);
    expect(calls).toEqual([['7', '8']]);
    expect(out.get('1')).toEqual(
      [...systemRolePermissions('ADMIN', merged)].sort(),
    );
    expect(out.get('8')).toEqual(['members.read', 'org.read']);
  });
  it('only system roles → no query at all; a custom role without rows is the empty set', async () => {
    const { rp, calls } = build({});
    await rp.of({ id: '1', systemKey: 'MEMBER' });
    expect(calls).toEqual([]);
    expect(await rp.of({ id: '9', systemKey: null })).toEqual([]);
  });
  it('R-X23: orphan keys grant nothing and never throw; each is logged WARN and counted once per process', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { rp, adds } = build({
      '7': ['org.read', 'payroll.read'],
      '8': ['ghost.read', 'payroll.read'],
    });
    expect(await rp.of({ id: '7', systemKey: null })).toEqual(['org.read']);
    expect(await rp.detailOf({ id: '8', systemKey: null })).toEqual({
      granted: [],
      orphans: ['ghost.read', 'payroll.read'],
    });
    expect(
      await rp.ofMany([
        { id: '7', systemKey: null },
        { id: '8', systemKey: null },
      ]),
    ).toEqual(
      new Map([
        ['7', ['org.read']],
        ['8', []],
      ]),
    );
    expect(warn.mock.calls.map(([payload]) => payload)).toEqual([
      { event: 'orphan_permission_ignored', key: 'payroll.read' },
      { event: 'orphan_permission_ignored', key: 'ghost.read' },
    ]);
    expect(adds).toEqual([
      [1, { source: 'custom_role' }],
      [1, { source: 'custom_role' }],
    ]);
  });
});
