import { ownerQuery } from './identity-app.js';

/**
 * Dựng ĐÚNG trạng thái mà production có sau `enable` + `verify-totp` + step-up (spec SP3 §5.3, r6 N6-6): không câu SQL nào
 * của `src` được nới cho test xanh. Luật depcruise `not-to-test` chặn `src` import file này.
 */
export async function seedStaffFactor(authUserId: string): Promise<string> {
  const [f] = await ownerQuery<{ id: string }>(
    `INSERT INTO auth.two_factor (secret, backup_codes, user_id, verified) VALUES ('seeded-unused', 'seeded-unused', $1, true)
     ON CONFLICT (user_id) DO UPDATE SET verified = true RETURNING id`,
    [authUserId],
  );
  if (!f) throw new Error('seedStaffFactor: no two_factor row');
  const flipped = await ownerQuery(
    `UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1 AND NOT two_factor_enabled RETURNING id`,
    [authUserId],
  );
  // Trigger `user_two_factor_notice_trg` vừa ghi marker: đánh dấu đã gửi để cron không gửi thư thật trong test.
  if (flipped.length > 0)
    await ownerQuery(
      `UPDATE auth.security_notice SET notified_at = GREATEST(clock_timestamp(), created_at)
       WHERE user_id = $1 AND notified_at IS NULL AND abandoned_at IS NULL`,
      [authUserId],
    );
  return f.id;
}

export async function seedStepUpMark(o: {
  sessionId: string;
  factorId: string;
  method?: 'totp' | 'backup_code';
  ageSec?: number;
}): Promise<void> {
  await ownerQuery(
    `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at)
     VALUES ($1, $2, $3, now() - make_interval(secs => $4))
     ON CONFLICT (session_id) DO UPDATE SET two_factor_id = EXCLUDED.two_factor_id, method = EXCLUDED.method,
       verified_at = EXCLUDED.verified_at, updated_at = now()`,
    [o.sessionId, o.factorId, o.method ?? 'totp', o.ageSec ?? 0],
  );
}

/** Factor + dấu cho MỌI session hiện có của user (gọi SAU khi đăng nhập). */
export async function seedStaffStepUp(
  who: { authUserId: string } | { email: string },
  o: { method?: 'totp' | 'backup_code'; ageSec?: number } = {},
): Promise<void> {
  const id =
    'authUserId' in who
      ? who.authUserId
      : (
          await ownerQuery<{ id: string }>(
            `SELECT id FROM auth."user" WHERE email = $1`,
            [who.email],
          )
        )[0]?.id;
  if (!id) throw new Error('seedStaffStepUp: user not found');
  const factorId = await seedStaffFactor(id);
  const sessions = await ownerQuery<{ id: string }>(
    `SELECT id FROM auth.session WHERE user_id = $1`,
    [id],
  );
  if (sessions.length === 0)
    throw new Error(
      'seedStaffStepUp: the user has no session yet (sign in first)',
    );
  for (const s of sessions)
    await seedStepUpMark({ sessionId: s.id, factorId, ...o });
}
