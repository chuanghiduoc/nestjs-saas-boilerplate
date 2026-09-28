import { defaultRoles } from 'better-auth/plugins/admin/access';
import { describe, expect, it } from 'vitest';
import {
  identityConfig,
  identityGuardConfig,
} from '../../../../src/modules/identity/identity.config.js';
import { corePlugins } from '../../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { hasAdminRole } from '../../../../src/modules/identity/ports/identity-directory.js';

const plugins = corePlugins(
  identityConfig.schema.parse({
    secret: 's'.repeat(40),
    baseUrl: 'https://api.example.test',
  }),
  { serviceName: 'svc' },
  identityGuardConfig.schema.parse({}),
);
const adminPlugin = plugins.find((p) => p.id === 'admin');
const DEFAULT_ROLES = new Map(Object.entries(defaultRoles));

/**
 * Spec SP3 §5.2 (r7/r8): the user-deletion pre-check in `hooks.before` decides "is this caller a platform admin" with
 * `hasAdminRole`, while `/admin/remove-user` authorizes with the plugin's `hasPermission` (`adminUserIds`, then
 * `options.roles ?? defaultRoles`). The two agree only while the plugin keeps its default access control. An
 * `adminUserIds` entry or a `roles` override would let the plugin delete for a caller the hook does not treat as an
 * admin, so the pre-check would be skipped (fail open).
 */
describe('admin plugin config that the deletion pre-check relies on', () => {
  it('has no adminUserIds and no roles override: exactly adminRoles [admin] and defaultRole user', () => {
    expect(adminPlugin?.options).toEqual({
      adminRoles: ['admin'],
      defaultRole: 'user',
    });
    expect(adminPlugin?.options).not.toHaveProperty('adminUserIds');
    expect(adminPlugin?.options).not.toHaveProperty('roles');
  });
  it.each(['admin', 'user', 'admin,user', 'user,admin', 'Admin', 'ADMIN', ''])(
    'role %j: hasAdminRole grants exactly when the default plugin roles grant user:delete',
    (role) => {
      // Same walk as the plugin's `hasPermission` (`plugins/admin/has-permission.mjs`) over the default roles.
      const pluginGrants = (role || 'user')
        .split(',')
        .some(
          (r) =>
            DEFAULT_ROLES.get(r)?.authorize({ user: ['delete'] }).success ===
            true,
        );
      expect(hasAdminRole(role)).toBe(pluginGrants);
    },
  );
});
