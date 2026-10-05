import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasAdminRole } from '../../../src/modules/identity/ports/identity-directory.js';
import {
  BETTER_AUTH,
  type AuthInstance,
} from '../../../src/modules/identity/infra/better-auth/auth-instance.js';
import {
  ADMIN_ROLE,
  DEFAULT_ROLE,
} from '../../../src/modules/identity/infra/better-auth/auth-schema.js';
import { ownerQuery, startIdentityApp } from '../../support/identity-app.js';

const NON_EMPTY_ROLES = [
  'admin',
  'user',
  'user,admin',
  'admin,user',
  'user, admin',
  ' admin',
  'admin ',
  'Admin',
  'administrator',
  'admin,',
  ',admin',
];

/**
 * Spec SP3 §5.2 hàng `identity-directory.ts` (r8, R8-S3 ≡ R8-C4): "nhân viên" của gate, luật (8), `--for-promotion` và
 * `isPlatformAdmin` phải là "admin" của plugin (người dùng được `/admin/*`). (1) assert cấu hình trên CHÍNH instance
 * runtime; (2) tương đương với `auth.api.userHasPermission` trên role khác rỗng; (3) `''`/`null` ở unit test.
 */
describe('hasAdminRole equals the admin plugin on the runtime instance', () => {
  let app: INestApplication;
  let auth: AuthInstance;
  beforeAll(async () => {
    app = await startIdentityApp();
    auth = app.get<AuthInstance>(BETTER_AUTH);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('the admin plugin options on the runtime instance: no roles, no adminUserIds, adminRoles = [admin], defaultRole = user', () => {
    const admin = auth.options.plugins.find((p) => p.id === 'admin');
    const options: unknown =
      admin && 'options' in admin ? admin.options : undefined;
    // Thông điệp khi đỏ: vị từ nhân viên (`hasAdminRole`, câu "còn admin khác") phải đổi theo cấu hình plugin admin.
    expect(
      options,
      'the staff predicate (hasAdminRole, "another admin" query) must follow the admin plugin config',
    ).toEqual({
      adminRoles: [ADMIN_ROLE],
      defaultRole: DEFAULT_ROLE,
    });
  });
  // `body.role` của `userHasPermission` được khai kiểu hẹp (`'admin' | 'user'`) dù schema runtime là `z.string()`:
  // role lưu trên dòng user, plugin đọc nó qua `userId` (`findUserById`) — đúng đường role của user thật.
  it.each(NON_EMPTY_ROLES)(
    'role %j: hasAdminRole equals userHasPermission(user:set-role)',
    async (role) => {
      const [u] = await ownerQuery<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at)
         VALUES ('Role', $1, true, $2, now(), now(), now()) RETURNING id`,
        [`role-${randomUUID()}@example.test`, role],
      );
      try {
        const r = await auth.api.userHasPermission({
          body: { userId: u!.id, permissions: { user: ['set-role'] } },
        });
        expect(hasAdminRole(role)).toBe(r.success);
      } finally {
        await ownerQuery(`DELETE FROM auth."user" WHERE id = $1`, [u!.id]);
      }
    },
  );
});
