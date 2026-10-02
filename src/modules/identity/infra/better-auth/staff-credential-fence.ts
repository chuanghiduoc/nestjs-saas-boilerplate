import type { Logger } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type pg from 'pg';
import { errorClass } from '../../identity-telemetry.js';
import { hasAdminRole } from '../../ports/identity-directory.js';
import {
  PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE,
  SECOND_FACTOR_REQUIRED_CODE,
  STAFF_PASSWORD_WRITE_FORBIDDEN_CODE,
  STAFF_SESSION_FENCED_CODE,
} from './auth-error.mapper.js';
import type { AuthRequestState } from './auth-request-state.js';
import { PASSWORD_WRITE_PATHS } from './staff-hooks.js';
import {
  STAFF_RESET_TX_ATTEMPTS,
  revokeUserCredentials,
  staffLacksFactorOf,
  type StaffStepUp,
} from './staff-step-up.js';

const SIGN_IN = '/sign-in/email';
const CREDENTIAL = 'credential';
const PG_DEADLOCK = '40P01';
const PG_SERIALIZATION = '40001';
type FenceKind = 'session' | 'idp_link' | 'api_key';
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  typeof err.code === 'string'
    ? err.code
    : undefined;

/** Endpoint context mà `databaseHooks.*` nhận (spike T7g/h): chỉ đọc các trường dưới. */
export type FenceCtx = {
  path?: string;
  body?: unknown;
  context?: {
    session?: { session: { id: string; userId: string } } | null;
    password?: {
      verify(i: { hash: string; password: string }): Promise<boolean>;
    };
  };
} | null;
export type StaffCredentialFenceDeps = {
  pool: pg.Pool;
  stepUp: StaffStepUp;
  state: AuthRequestState;
  logger: Pick<Logger, 'error' | 'warn'>;
};

/** Lỗi của từng path khi subject là nhân viên chưa có factor (cùng lỗi với hook `before`, spec §9.7 (7)). */
export const passwordRefusalFor = (path: string): APIError => {
  switch (path) {
    case '/reset-password':
      return APIError.from('BAD_REQUEST', {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    case '/change-password':
      return APIError.from('FORBIDDEN', {
        code: SECOND_FACTOR_REQUIRED_CODE,
        message: 'Enrol and verify a second factor first',
      });
    case '/admin/set-user-password':
      return APIError.from('FORBIDDEN', {
        code: STAFF_PASSWORD_WRITE_FORBIDDEN_CODE,
        message: 'Use the operator reset command',
      });
    default:
      throw new Error(`no password refusal for path ${path}`);
  }
};

/**
 * (9)(iv): gỡ MỌI credential của subject trong một transaction mở đầu bằng khoá dòng user `FOR NO KEY UPDATE`: cờ 2FA tắt,
 * mật khẩu `NULL`, rồi đúng các câu xoá của bước 2 lệnh reset (`revokeUserCredentials`, `apiKeys: true`). Không ghi `role`,
 * không marker. `40P01`/`40001` (đua câu ghi dấu, như T-37) → chạy lại, tối đa `STAFF_RESET_TX_ATTEMPTS` lần.
 *
 * Spike T7h: `account.update.after` chạy khi mật khẩu MỚI đã ghi xong (thấy được từ connection khác) và lỗi ném ở đó
 * không rollback câu ghi đó — nên hàm này tự vô hiệu mọi credential, không bao giờ trông vào rollback.
 */
export async function neutralizeStaffCredentials(
  pool: pg.Pool,
  userId: string,
  path: string,
  logger: Pick<Logger, 'error'>,
): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= STAFF_RESET_TX_ATTEMPTS; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT 1 FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`,
        [userId],
      );
      await c.query(
        `UPDATE auth."user" SET two_factor_enabled = false, updated_at = now() WHERE id = $1`,
        [userId],
      );
      await c.query(
        `UPDATE auth.account SET password = NULL, updated_at = now() WHERE user_id = $1 AND provider_id = 'credential'`,
        [userId],
      );
      await revokeUserCredentials(c, userId, { apiKeys: true });
      await c.query('COMMIT');
      logger.error(
        { event: 'staff_password_write_neutralized', path, userId },
        'a password write slipped past the staff pre-write guard; every credential of the user was removed',
      );
      return;
    } catch (err) {
      await c.query('ROLLBACK').catch((rollbackErr: unknown) => {
        // Lỗi gốc vẫn được ném bên dưới; ROLLBACK hỏng chỉ ghi lớp lỗi (connection sẽ bị huỷ khi release).
        logger.error(
          {
            event: 'staff_password_write_neutralize_rollback_failed',
            path,
            userId,
            errorClass: errorClass(rollbackErr),
          },
          'rollback after a failed neutralization failed',
        );
      });
      last = err;
      const code = codeOf(err);
      if (code !== PG_DEADLOCK && code !== PG_SERIALIZATION) break;
    } finally {
      c.release();
    }
  }
  logger.error(
    {
      event: 'staff_password_write_neutralize_failed',
      path,
      userId,
      errorClass: errorClass(last),
    },
    'could not neutralize a raced staff password write; run the operator reset for this user now',
  );
  throw last;
}

/**
 * Lớp chặn trước câu ghi mật khẩu và hàng rào sau ghi cho credential của nhân viên chưa có factor (spec SP3 §5.2 hàng
 * `auth-hooks.ts` (7), (9); §9.7). Mọi câu đầu là `factorState` (`FOR SHARE OF u`): transaction của lệnh reset đang mở
 * thì chờ nó commit rồi thấy bản đã commit, nên quyết định dựa trên trạng thái đã commit, không trên thời điểm. Lỗi DB
 * được log rồi ném NGUYÊN (mount đổi lỗi hạ tầng của pool auth thành 503; lỗi lập trình là 500 — fail loud).
 */
export function createStaffCredentialFence(d: StaffCredentialFenceDeps) {
  const fenceFailed = (
    kind: FenceKind,
    path: string,
    userId: string,
    err: unknown,
  ): never => {
    d.logger.error(
      {
        event: 'staff_credential_fence_failed',
        kind,
        path,
        userId,
        errorClass: errorClass(err),
      },
      'the staff credential fence could not reach the auth database',
    );
    throw err;
  };
  const fenced = (kind: FenceKind, path: string, userId: string) =>
    d.logger.warn(
      { event: 'staff_credential_fenced', kind, path, userId },
      'a new credential of staff without a second factor was removed',
    );
  /**
   * (9)(iv) `account.update.after`/`create.after` (`credential`) trên `PASSWORD_WRITE_PATHS`: subject là nhân viên và
   * (chưa có factor, hoặc `factor_id` khác lúc lớp chặn trước kiểm) → câu ghi đã lọt (T-42) hoặc ai đó vừa đăng ký
   * factor bằng chính mật khẩu vừa ghi → vô hiệu mọi credential, ném lỗi của path. Factor giữ nguyên → không làm gì.
   */
  const accountUpdated = async (ctx: FenceCtx): Promise<void> => {
    const path = ctx?.path;
    if (path === undefined || !PASSWORD_WRITE_PATHS.has(path)) return;
    const subjects = (await d.state.passwordWriteSubjects()) ?? [];
    const before = await d.state.writeFactors();
    for (const s of subjects) {
      const st = await d.stepUp.factorState(s);
      if (!st.exists || !hasAdminRole(st.role)) continue;
      if (st.factorId !== null && st.factorId === (before.get(s) ?? null))
        continue;
      await neutralizeStaffCredentials(d.pool, s, path, d.logger);
      throw passwordRefusalFor(path);
    }
  };
  return {
    accountUpdated,
    /**
     * (9)(i) `session.create.after` (ghép SAU `createSessionFence`): nhân viên chưa có factor chỉ giữ session (a) đăng nhập
     * `/sign-in/email` bằng mật khẩu HIỆN TẠI (hash đọc trong cùng transaction với câu khoá), hoặc (b) xoay từ một session
     * còn sống của chính user. Không đạt → xoá session, 401 (ở sign-in: đúng lỗi sai mật khẩu, không oracle).
     */
    async sessionCreated(
      session: { id: string; userId: string },
      ctx: FenceCtx,
    ): Promise<void> {
      const path = ctx?.path ?? 'server';
      const c = await d.pool.connect();
      let lacks = false;
      let hash: string | null = null;
      try {
        await c.query('BEGIN');
        lacks = staffLacksFactorOf(
          await d.stepUp.factorState(session.userId, c),
        );
        if (lacks && path === SIGN_IN)
          hash =
            (
              await c.query<{ password: string | null }>(
                `SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'`,
                [session.userId],
              )
            ).rows[0]?.password ?? null;
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        fenceFailed('session', path, session.userId, err);
      } finally {
        c.release();
      }
      if (!lacks) return;
      const body: unknown = ctx?.body;
      const password =
        typeof body === 'object' &&
        body !== null &&
        'password' in body &&
        typeof body.password === 'string'
          ? body.password
          : undefined;
      const verifier = ctx?.context?.password;
      const viaCurrentPassword =
        path === SIGN_IN &&
        hash !== null &&
        password !== undefined &&
        verifier !== undefined
          ? await verifier.verify({ hash, password })
          : false;
      const parent = ctx?.context?.session?.session;
      let rotatedFromLive = false;
      if (
        parent !== undefined &&
        parent.userId === session.userId &&
        parent.id !== session.id
      ) {
        try {
          rotatedFromLive =
            ((
              await d.pool.query(
                `SELECT 1 FROM auth.session WHERE id = $1 AND user_id = $2`,
                [parent.id, session.userId],
              )
            ).rowCount ?? 0) === 1;
        } catch (err) {
          fenceFailed('session', path, session.userId, err);
        }
      }
      if (viaCurrentPassword || rotatedFromLive) return;
      try {
        await d.pool.query(`DELETE FROM auth.session WHERE id = $1`, [
          session.id,
        ]);
      } catch (err) {
        fenceFailed('session', path, session.userId, err);
      }
      fenced('session', path, session.userId);
      throw path === SIGN_IN
        ? APIError.from('UNAUTHORIZED', {
            code: 'INVALID_EMAIL_OR_PASSWORD',
            message: 'Invalid email or password',
          })
        : APIError.from('UNAUTHORIZED', {
            code: STAFF_SESSION_FENCED_CODE,
            message: 'Sign in again with your password',
          });
    },
    /** (9)(ii) liên kết IdP mới (`providerId <> 'credential'`) → xoá, 403; (9)(iv) account `credential` tạo trên `PASSWORD_WRITE_PATHS`. */
    async accountCreated(
      account: { id: string; userId: string; providerId: string },
      ctx: FenceCtx,
    ): Promise<void> {
      const path = ctx?.path ?? 'server';
      if (account.providerId === CREDENTIAL) {
        if (PASSWORD_WRITE_PATHS.has(path)) await accountUpdated(ctx);
        return;
      }
      let lacks = false;
      try {
        lacks = await d.stepUp.staffLacksFactor(account.userId);
        if (lacks)
          await d.pool.query(`DELETE FROM auth.account WHERE id = $1`, [
            account.id,
          ]);
      } catch (err) {
        fenceFailed('idp_link', path, account.userId, err);
      }
      if (!lacks) return;
      fenced('idp_link', path, account.userId);
      throw APIError.from('FORBIDDEN', {
        code: SECOND_FACTOR_REQUIRED_CODE,
        message: 'Link identity providers after enrolling a second factor',
      });
    },
    /** (9)(iii) `hooks.after` của `/api-key/create` thành công: key của nhân viên chưa có factor bị xoá theo `id`. */
    async apiKeyCreated(
      key: { id: string; referenceId: string },
      path: string,
    ): Promise<boolean> {
      try {
        if (!(await d.stepUp.staffLacksFactor(key.referenceId))) return false;
        await d.pool.query(`DELETE FROM auth.apikey WHERE id = $1`, [key.id]);
      } catch (err) {
        return fenceFailed('api_key', path, key.referenceId, err);
      }
      fenced('api_key', path, key.referenceId);
      return true;
    },
    /**
     * `databaseHooks.account.update.before` / `account.create.before` (`credential`) trên `PASSWORD_WRITE_PATHS` khi `data`
     * có `password` (spike T7g: `data = { password }`, không `userId`). Tập subject lấy từ request state; rỗng, hoặc
     * `create.before` có `userId` ngoài tập → 500 (handler ghi cho subject hook không thấy: fail closed).
     */
    async passwordWriteBefore(
      data: Record<string, unknown>,
      ctx: FenceCtx,
    ): Promise<void> {
      const path = ctx?.path;
      if (
        path === undefined ||
        !PASSWORD_WRITE_PATHS.has(path) ||
        !Object.hasOwn(data, 'password')
      )
        return;
      const subjects = await d.state.passwordWriteSubjects();
      const createUserId =
        typeof data.userId === 'string' ? data.userId : undefined;
      if (
        !subjects ||
        subjects.length === 0 ||
        (createUserId !== undefined && !subjects.includes(createUserId))
      ) {
        d.logger.error(
          { event: 'password_write_subject_unresolved', path },
          'a password write reached the database for a subject the before-hook did not resolve',
        );
        throw APIError.from('INTERNAL_SERVER_ERROR', {
          code: PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE,
          message: 'Password write refused',
        });
      }
      const factors = new Map<string, string | null>();
      for (const s of subjects) {
        const st = await d.stepUp.factorState(s);
        factors.set(s, st.factorId);
        if (staffLacksFactorOf(st)) {
          d.logger.warn(
            {
              event: 'staff_password_change_refused',
              path,
              userId: s,
              stage: 'write',
            },
            'a password write for staff without a second factor was refused at write time',
          );
          throw passwordRefusalFor(path);
        }
      }
      await d.state.setWriteFactors(factors);
    },
  };
}
