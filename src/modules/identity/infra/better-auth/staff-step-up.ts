import type pg from 'pg';
import { hasAdminRole } from '../../ports/identity-directory.js';

/** Phương thức của một lần step-up (cột `method`, `session_second_factor_method_ck`). */
export type StepUpMethod = 'totp' | 'backup_code';
/** Spec SP3 §5.2 hàng `auth-hooks.ts` (1): path → phương thức ghi vào dấu. */
export const STEP_UP_METHOD_BY_PATH: Readonly<Record<string, StepUpMethod>> = {
  '/two-factor/verify-totp': 'totp',
  '/two-factor/verify-backup-code': 'backup_code',
};
export const STEP_UP_PATHS: ReadonlySet<string> = new Set(
  Object.keys(STEP_UP_METHOD_BY_PATH),
);
/** Lần chạy lại transaction khi `40P01`/`40001` (lệnh reset, hàng rào (9)(iv); spec §9.7 (5), N5-5). */
export const STAFF_RESET_TX_ATTEMPTS = 3;

export type StepUpMark = {
  sessionId: string;
  factorId: string;
  method: StepUpMethod;
};
export type StaffFactorState = {
  exists: boolean;
  role: string | null;
  factorId: string | null;
};
/** Pool hoặc client đang ở trong transaction: mọi câu dưới chạy được trên cả hai. */
export type Sql = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
};
/** Spec §9.7 (7): "nhân viên chưa có factor" = có dòng user, `hasAdminRole(role)`, không factor hiện tại. */
export const staffLacksFactorOf = (s: StaffFactorState): boolean =>
  s.exists && hasAdminRole(s.role) && s.factorId === null;

const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_DEADLOCK = '40P01';
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  typeof err.code === 'string'
    ? err.code
    : undefined;

/**
 * "Factor hiện tại" (spec §5.2, r6 N6-6): dòng `two_factor` đã verify của user VÀ cờ `two_factor_enabled` bật. Mọi câu dưới
 * dùng đúng định nghĩa này, nên helper test không bao giờ phải nới câu nào của `src`.
 */
const TOTP_MARK_FRESH = `SELECT 1 FROM auth.two_factor tf
JOIN auth."user" u ON u.id = tf.user_id
JOIN auth.session_second_factor ssf ON ssf.two_factor_id = tf.id AND ssf.session_id = $2
WHERE tf.user_id = $1 AND tf.verified AND u.two_factor_enabled AND ssf.method = 'totp'
  AND ssf.verified_at >= now() - make_interval(secs => $3)`;
const ANY_MARK = `SELECT ssf.verified_at FROM auth.session_second_factor ssf
JOIN auth.two_factor tf ON tf.id = ssf.two_factor_id
JOIN auth."user" u ON u.id = tf.user_id
WHERE ssf.session_id = $1 AND u.id = $2 AND tf.verified AND u.two_factor_enabled`;
const CURRENT_FACTOR = `SELECT tf.id FROM auth.two_factor tf JOIN auth."user" u ON u.id = tf.user_id
WHERE tf.user_id = $1 AND tf.verified AND u.two_factor_enabled`;
/**
 * Khoá ĐỌC (r7 N7-4): transaction của lệnh reset đang giữ dòng user thì câu này chờ lệnh commit rồi thấy bản đã commit.
 * Subquery đọc snapshot của câu lệnh, nên quyết định phải đi qua cờ `u.two_factor_enabled` của dòng đã khoá (lệnh luôn
 * ghi cờ `false`; không được bỏ cờ khỏi câu này). `two_factor_user_id_unique` bảo đảm ≤ 1 factor.
 */
const FACTOR_STATE = `SELECT u.role, CASE WHEN u.two_factor_enabled THEN (
    SELECT tf.id FROM auth.two_factor tf WHERE tf.user_id = u.id AND tf.verified) END AS factor_id
FROM auth."user" u WHERE u.id = $1 FOR SHARE OF u`;
/** Cùng vị từ `hasAdminRole` (tách theo `,`, không `btrim`) và cùng điều kiện `isBanned` (spec §5.2, r7 N7-2). */
const OTHER_ADMIN = `SELECT EXISTS (SELECT 1 FROM auth."user" u WHERE u.id <> $1
  AND 'admin' = ANY (string_to_array(u.role, ','))
  AND NOT (u.banned IS TRUE AND (u.ban_expires IS NULL OR u.ban_expires > now()))) AS present`;
/** Luật (2): chỉ ghi khi session và factor ĐÃ CHỤP còn tồn tại và cùng user (T-37: factor bị thay → 0 dòng). */
const WRITE_MARK = `INSERT INTO auth.session_second_factor (session_id, two_factor_id, method, verified_at, created_at, updated_at)
SELECT s.id, tf.id, $3, now(), now(), now() FROM auth.session s JOIN auth.two_factor tf ON tf.user_id = s.user_id
WHERE s.id = $1 AND tf.id = $2
ON CONFLICT (session_id) DO UPDATE SET two_factor_id = EXCLUDED.two_factor_id, method = EXCLUDED.method,
  verified_at = EXCLUDED.verified_at, updated_at = EXCLUDED.updated_at`;

/**
 * Mọi câu SQL về factor và dấu step-up của nhân viên (spec SP3 §5.2 hàng `auth-hooks.ts`, §9.7): một chỗ cho hook Better
 * Auth, Bull Board, `PlatformStaffGuard`, `AuthFacts`, hàng rào sau ghi và lệnh reset, nên các nơi không lệch nhau.
 * Pool `auth_user`; lỗi hạ tầng ném lên (caller trả 503).
 */
export class StaffStepUp {
  constructor(private readonly pool: pg.Pool) {}

  async totpMarkFresh(
    userId: string,
    sessionId: string,
    maxAgeSec: number,
  ): Promise<boolean> {
    return (
      (await this.pool.query(TOTP_MARK_FRESH, [userId, sessionId, maxAgeSec]))
        .rowCount === 1
    );
  }
  async anyMarkVerifiedAt(
    sessionId: string,
    userId: string,
  ): Promise<Date | undefined> {
    const { rows } = await this.pool.query<{ verified_at: Date }>(ANY_MARK, [
      sessionId,
      userId,
    ]);
    return rows[0]?.verified_at;
  }
  async currentFactorId(userId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ id: string }>(CURRENT_FACTOR, [
      userId,
    ]);
    return rows[0]?.id;
  }
  async factorState(
    userId: string,
    q: Sql = this.pool,
  ): Promise<StaffFactorState> {
    const { rows } = await q.query<{
      role: string | null;
      factor_id: string | null;
    }>(FACTOR_STATE, [userId]);
    const r = rows[0];
    return r
      ? { exists: true, role: r.role, factorId: r.factor_id }
      : { exists: false, role: null, factorId: null };
  }
  async staffLacksFactor(userId: string, q: Sql = this.pool): Promise<boolean> {
    return staffLacksFactorOf(await this.factorState(userId, q));
  }
  async otherAdminExists(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ present: boolean }>(OTHER_ADMIN, [
      userId,
    ]);
    return rows[0]?.present === true;
  }
  /** `SKIPPED`: session hoặc factor vừa mất (0 dòng, `23503`) hoặc đua với transaction của lệnh reset (`40P01`, T-37). */
  async writeMark(m: StepUpMark): Promise<'MARKED' | 'SKIPPED'> {
    try {
      const r = await this.pool.query(WRITE_MARK, [
        m.sessionId,
        m.factorId,
        m.method,
      ]);
      return r.rowCount === 1 ? 'MARKED' : 'SKIPPED';
    } catch (err) {
      const code = codeOf(err);
      if (code === PG_FOREIGN_KEY_VIOLATION || code === PG_DEADLOCK)
        return 'SKIPPED';
      throw err;
    }
  }
}

/**
 * Năm câu xoá credential của spec §9.7 (5) bước 2, ĐÚNG thứ tự (r7 R7-C3): dùng chung cho lệnh reset và hàng rào
 * (9)(iv) (r8), chạy trong transaction của caller đã khoá dòng user. Factor xoá trước (dấu `CASCADE`); session là câu cuối.
 */
export async function revokeUserCredentials(
  client: Sql,
  userId: string,
  opts: { apiKeys: boolean },
): Promise<{ apiKeysDeleted: number }> {
  await client.query(`DELETE FROM auth.two_factor WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(
    `DELETE FROM auth.verification WHERE value = $1 AND (identifier LIKE 'trust-device-%' OR identifier LIKE 'reset-password:%')`,
    [userId],
  );
  await client.query(
    `DELETE FROM auth.account WHERE user_id = $1 AND provider_id <> 'credential'`,
    [userId],
  );
  const apiKeysDeleted = opts.apiKeys
    ? ((
        await client.query(`DELETE FROM auth.apikey WHERE reference_id = $1`, [
          userId,
        ])
      ).rowCount ?? 0)
    : 0;
  await client.query(`DELETE FROM auth.session WHERE user_id = $1`, [userId]);
  return { apiKeysDeleted };
}
