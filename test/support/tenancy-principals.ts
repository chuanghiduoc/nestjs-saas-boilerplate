import { randomBytes, randomUUID } from 'node:crypto';
import { ownerQuery } from './identity-app.js';

export type SeededPrincipal = {
  authUserId: string;
  email: string;
  bearer: string;
  sessionId: string;
};
/** Mặc định `AUTH_SESSION_EXPIRES_IN_SEC`: session seed không tới ngưỡng gia hạn trong một lần chạy test. */
const SESSION_TTL_SEC = 604_800;
const TOKEN_BYTES = 32;

/**
 * Principal local/hybrid cho e2e (spec SP3 §5.3, §18.0): chèn thẳng `auth."user"` KÈM `registered_event_emitted_at =
 * now()` (chèn thẳng bỏ qua `databaseHooks.user.create.after`; để NULL thì cron đối soát phát `identity.user.registered`
 * thừa, INT2-N-14) và một `auth.session`, rồi dùng token làm bearer (plugin `bearer` nhận token trần). `sessionAgeSec`
 * lùi `created_at` để thử `@RequireFreshSession`. Không có account `credential`: không đăng nhập bằng mật khẩu được.
 */
export async function seedUserPrincipal(
  opts: { role?: string; emailVerified?: boolean; sessionAgeSec?: number } = {},
): Promise<SeededPrincipal> {
  const email = `seed-${randomUUID()}@example.test`;
  const [user] = await ownerQuery<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_verified, role, created_at, updated_at, registered_event_emitted_at)
     VALUES ('Seeded', $1, $2, $3, now(), now(), now()) RETURNING id`,
    [email, opts.emailVerified ?? true, opts.role ?? null],
  );
  if (!user) throw new Error('seedUserPrincipal: user insert returned no row');
  const bearer = randomBytes(TOKEN_BYTES).toString('base64url');
  const [session] = await ownerQuery<{ id: string }>(
    `INSERT INTO auth.session (token, user_id, expires_at, created_at, updated_at)
     VALUES ($1, $2, now() + make_interval(secs => $3), now() - make_interval(secs => $4), now() - make_interval(secs => $4))
     RETURNING id`,
    [bearer, user.id, SESSION_TTL_SEC, opts.sessionAgeSec ?? 0],
  );
  if (!session)
    throw new Error('seedUserPrincipal: session insert returned no row');
  return { authUserId: user.id, email, bearer, sessionId: session.id };
}

/**
 * Xoá user seed (session/account `CASCADE`) cùng dòng `tenancy_users` của họ (FK RESTRICT): dòng đó có thể do API tạo
 * lười (tạo org) hoặc do một `seedOrg` khác giữ lại khi user còn là member ở org chưa dispose. Gọi SAU khi mọi org đã
 * dispose; user còn là member ở đâu đó → `23001` (fail loud, không rò dữ liệu âm thầm).
 */
export async function deleteSeededPrincipals(
  ps: readonly SeededPrincipal[],
): Promise<void> {
  if (ps.length === 0) return;
  await ownerQuery(
    `DELETE FROM tenancy_users WHERE auth_user_id = ANY($1::uuid[])`,
    [ps.map((p) => p.authUserId)],
  );
  await ownerQuery(`DELETE FROM auth."user" WHERE id = ANY($1::uuid[])`, [
    ps.map((p) => p.authUserId),
  ]);
}
