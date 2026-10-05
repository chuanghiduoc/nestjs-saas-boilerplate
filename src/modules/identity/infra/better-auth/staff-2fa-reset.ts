import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { z } from 'zod';
import { errorClass } from '../../identity-telemetry.js';
import { hasAdminRole } from '../../ports/identity-directory.js';
import { STAFF_RESET_TICKET_MAX_LENGTH } from '../../ports/security-notice-ledger.js';
import { lockoutRowKeys } from './login-lockout.js';
import {
  STAFF_RESET_TX_ATTEMPTS,
  revokeUserCredentials,
  type Sql,
} from './staff-step-up.js';

export const STAFF_RESET_PASSWORD_BYTES = 18;
export const STAFF_RESET_EXIT_OK = 0;
/** DB KHÔNG đổi (lỗi tham số, terminal, xác nhận; user đổi sau xác nhận; transaction lỗi/hết lượt thử, đã ROLLBACK). */
export const STAFF_RESET_EXIT_NOT_COMMITTED = 1;
/** DB CÓ THỂ đã đổi, mật khẩu tạm CHƯA được giao (kiểm sau commit thất bại, giao lỗi, COMMIT không rõ kết quả). */
export const STAFF_RESET_EXIT_COMMITTED = 2;
export type StaffResetExit =
  | typeof STAFF_RESET_EXIT_OK
  | typeof STAFF_RESET_EXIT_NOT_COMMITTED
  | typeof STAFF_RESET_EXIT_COMMITTED;
type Mode = 'RESET' | 'PROMOTE';

export type StaffResetArgs = {
  userId: string;
  ticket: string;
  forPromotion: boolean;
  passwordFile: string | undefined;
};
export type StaffResetTerminal = {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  confirm(prompt: string): Promise<string>;
  writeSecret(secret: string): Promise<void>;
  /** stderr: hướng dẫn cho vận hành; không bao giờ mang secret. */
  info(line: string): void;
};
/** Seam cho test barrier (spec §18.3 S-22, S-24): production không truyền. */
export type StaffResetSeams = {
  afterLockUser?(c: Sql): Promise<void>;
  afterUpsert?(c: Sql): Promise<void>;
  afterCommit?(): Promise<void>;
};
export type StaffResetDeps = {
  auth: {
    $context: Promise<{
      password: { hash(password: string): Promise<string> };
    }>;
  };
  pool: pg.Pool;
  log(
    level: 'warn' | 'error',
    entry: Record<string, unknown>,
    message: string,
  ): void;
  seams?: StaffResetSeams;
};

/** Cùng luật `adminTargetUserId`: UUID ở dạng chữ thường chuẩn, không chuẩn hoá (marker/log mang đúng id; R8-S2). */
const CanonicalUuid = z.uuid().refine((v) => v === v.toLowerCase());
const PRINTABLE = /^[\x20-\x7E]+$/;
const TICKET_MESSAGE = `--ticket must be 1-${STAFF_RESET_TICKET_MAX_LENGTH} printable characters without line breaks`;

export function parseStaffResetArgs(
  argv: readonly string[],
): { ok: true; args: StaffResetArgs } | { ok: false; message: string } {
  let values: {
    'user-id'?: string;
    ticket?: string;
    'for-promotion'?: boolean;
    'password-file'?: string;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        'user-id': { type: 'string' },
        ticket: { type: 'string' },
        'for-promotion': { type: 'boolean' },
        'password-file': { type: 'string' },
      },
    }));
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const userId = values['user-id'];
  const ticket = values.ticket;
  if (userId === undefined)
    return { ok: false, message: '--user-id is required' };
  if (!CanonicalUuid.safeParse(userId).success)
    return {
      ok: false,
      message: '--user-id must be a canonical lowercase UUID',
    };
  if (ticket === undefined)
    return { ok: false, message: '--ticket is required' };
  if (
    ticket.length < 1 ||
    ticket.length > STAFF_RESET_TICKET_MAX_LENGTH ||
    !PRINTABLE.test(ticket)
  )
    return { ok: false, message: TICKET_MESSAGE };
  return {
    ok: true,
    args: {
      userId,
      ticket,
      forPromotion: values['for-promotion'] === true,
      passwordFile: values['password-file'],
    },
  };
}

/** Chạy TRƯỚC khi nạp config (lỗi cách dùng không phụ thuộc env). Không `--yes`: thao tác phá kính luôn hỏi lại. */
export function terminalProblem(
  args: StaffResetArgs,
  t: Pick<StaffResetTerminal, 'stdinIsTTY' | 'stdoutIsTTY'>,
): string | undefined {
  if (!t.stdinIsTTY)
    return 'this command needs an interactive terminal (docker compose run --rm, kubectl exec -it)';
  if (!t.stdoutIsTTY && args.passwordFile === undefined)
    return 'stdout is not a terminal: pass --password-file <path> so the temporary password does not reach a log';
  return undefined;
}

const PG_DEADLOCK = '40P01';
const PG_SERIALIZATION = '40001';
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  typeof err.code === 'string'
    ? err.code
    : undefined;

type Subject = {
  email: string;
  role: string | null;
  hasFactor: boolean;
  apiKeys: number;
};
const READ_SUBJECT = `SELECT u.email, u.role,
    (u.two_factor_enabled OR EXISTS (SELECT 1 FROM auth.two_factor tf WHERE tf.user_id = u.id AND tf.verified)) AS has_factor,
    (SELECT count(*)::int FROM auth.apikey k WHERE k.reference_id = u.id) AS api_keys
  FROM auth."user" u WHERE u.id = $1`;
/** Bước 2, câu ĐẦU: khoá dòng user trước mọi câu ghi (thứ tự là bất biến, R7-C3). */
const LOCK_USER = `SELECT email, role FROM auth."user" WHERE id = $1 FOR NO KEY UPDATE`;
const UPSERT_CREDENTIAL = `INSERT INTO auth.account (account_id, provider_id, user_id, password, created_at, updated_at)
  VALUES ($1::uuid::text, 'credential', $1::uuid, $2, now(), now())
  ON CONFLICT (provider_id, account_id) DO UPDATE SET password = EXCLUDED.password, updated_at = EXCLUDED.updated_at
  WHERE auth.account.user_id = EXCLUDED.user_id RETURNING id`;
const DELETE_LOCKOUT = `DELETE FROM auth.login_attempts WHERE key = ANY($1::text[])
  OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS p(prefix) WHERE starts_with(key, p.prefix))`;
/** Bước 3 (r8): chỉ đọc hash và factor, chờ một câu ghi mật khẩu đang chạy trên dòng account (`FOR SHARE OF a`). */
const POST_COMMIT = `SELECT a.password,
    (u.two_factor_enabled OR EXISTS (SELECT 1 FROM auth.two_factor tf WHERE tf.user_id = u.id AND tf.verified)) AS has_factor
  FROM auth."user" u JOIN auth.account a ON a.user_id = u.id AND a.provider_id = 'credential' AND a.account_id = u.id::text
  WHERE u.id = $1 FOR SHARE OF a`;

class Refused extends Error {}
/** Lỗi trên chính câu COMMIT: không biết đã commit hay chưa (mất kết nối giữa chừng) → exit 2. */
class CommitOutcomeUnknown extends Error {}

/**
 * Lệnh vận hành reset 2FA nhân viên và nâng quyền (spec SP3 §9.7 (5), §5.2 hàng CLI; r8). Không đường HTTP; chạy được cả
 * khi không còn admin nào đăng nhập được. Mọi câu ghi nằm trong MỘT transaction (exit 1 = DB không đổi). Chế độ quyết
 * định ở bước 0 theo trạng thái nhân viên LÚC NÀY (R8-C1): nhân viên → RESET (xoá API key), user thường + `--for-promotion`
 * → PROMOTE (ghi role admin, giữ API key), user thường thiếu cờ → exit 1.
 */
export async function runStaffTwoFactorReset(
  args: StaffResetArgs,
  t: StaffResetTerminal,
  d: StaffResetDeps,
): Promise<StaffResetExit> {
  const usage = terminalProblem(args, t);
  if (usage) {
    t.info(`identity:staff-2fa-reset: ${usage}`);
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  const { rows } = await d.pool.query<{
    email: string;
    role: string | null;
    has_factor: boolean;
    api_keys: number;
  }>(READ_SUBJECT, [args.userId]);
  const row = rows[0];
  if (!row) {
    t.info('identity:staff-2fa-reset: no user with this id');
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  const subject: Subject = {
    email: row.email,
    role: row.role,
    hasFactor: row.has_factor,
    apiKeys: row.api_keys,
  };
  const staff = hasAdminRole(subject.role);
  if (!staff && !args.forPromotion) {
    t.info(
      'identity:staff-2fa-reset: the user is not platform staff; pass --for-promotion to promote them (the only supported promotion path)',
    );
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  const mode: Mode = staff ? 'RESET' : 'PROMOTE';
  t.info(
    `user ${args.userId}: email ${subject.email}, role ${subject.role ?? '(none)'}, second factor ${subject.hasFactor ? 'present' : 'none'}`,
  );
  t.info(
    `ticket ${args.ticket}, mode ${mode}, Better Auth API keys ${mode === 'RESET' ? 'to delete' : 'kept'}: ${subject.apiKeys}`,
  );
  if (
    (await t.confirm('Type the user email to confirm: ')).trim() !==
    subject.email
  ) {
    t.info(
      'identity:staff-2fa-reset: the email does not match; nothing changed',
    );
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  if (args.passwordFile !== undefined) {
    try {
      file = await open(args.passwordFile, 'wx', 0o600);
    } catch (err) {
      t.info(
        `identity:staff-2fa-reset: cannot create ${args.passwordFile} (${codeOf(err) ?? errorClass(err)}); it must not exist`,
      );
      return STAFF_RESET_EXIT_NOT_COMMITTED;
    }
  }
  /** Dọn file chưa ghi secret ở mọi đường lỗi; dọn hỏng thì báo vận hành (không nuốt im). */
  const dropFile = async () => {
    if (!file || args.passwordFile === undefined) return;
    const path = args.passwordFile;
    await file.close().catch(() => undefined);
    file = undefined;
    await unlink(path).catch((err: unknown) => {
      t.info(
        `identity:staff-2fa-reset: could not remove ${path} (${codeOf(err) ?? errorClass(err)}); it holds no password, delete it by hand`,
      );
    });
  };
  const password = randomBytes(STAFF_RESET_PASSWORD_BYTES).toString(
    'base64url',
  );
  const hash = await (await d.auth.$context).password.hash(password);
  let apiKeysDeleted: number;
  try {
    apiKeysDeleted = await commitReset(args, subject, mode, hash, d);
  } catch (err) {
    await dropFile();
    if (err instanceof CommitOutcomeUnknown) {
      t.info(
        'identity:staff-2fa-reset: the connection was lost while COMMIT was in flight; run the same command again',
      );
      return STAFF_RESET_EXIT_COMMITTED;
    }
    t.info(
      `identity:staff-2fa-reset: ${err instanceof Refused ? err.message : `transaction failed (${codeOf(err) ?? errorClass(err)})`}; nothing changed`,
    );
    return STAFF_RESET_EXIT_NOT_COMMITTED;
  }
  // Review I-1: COMMIT đã thành công — mọi lỗi từ đây là exit 2 (DB đã đổi), không bao giờ thoát như "DB không đổi".
  let raced:
    | 'password_changed'
    | 'factor_present'
    | 'post_commit_check_failed'
    | undefined;
  try {
    await d.seams?.afterCommit?.();
    raced = await postCommitCheck(args.userId, hash, d.pool);
  } catch (err) {
    raced = 'post_commit_check_failed';
    t.info(
      `identity:staff-2fa-reset: committed, but the post-commit check failed (${codeOf(err) ?? errorClass(err)})`,
    );
  }
  if (raced) {
    await dropFile();
    d.log(
      'warn',
      {
        event: 'identity_staff_2fa_reset_raced',
        userId: args.userId,
        ticket: args.ticket,
        reason: raced,
      },
      'staff 2FA reset committed but something changed right after; the temporary password was not delivered',
    );
    t.info(
      'identity:staff-2fa-reset: committed, but the password or a second factor changed right after; treat it as an incident and run the same command again',
    );
    return STAFF_RESET_EXIT_COMMITTED;
  }
  try {
    if (file) {
      await file.writeFile(`${password}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
    } else await t.writeSecret(password);
  } catch (err) {
    await dropFile();
    t.info(
      `identity:staff-2fa-reset: committed, but the temporary password could not be delivered (${errorClass(err)}); run the same command again`,
    );
    return STAFF_RESET_EXIT_COMMITTED;
  }
  d.log(
    'warn',
    {
      event: 'identity_staff_2fa_reset',
      userId: args.userId,
      ticket: args.ticket,
      mode,
      apiKeysDeleted,
    },
    'staff 2FA reset committed',
  );
  t.info(`done: ${apiKeysDeleted} Better Auth API key(s) deleted`);
  return STAFF_RESET_EXIT_OK;
}

/** Bước 2: MỘT transaction, các câu theo đúng thứ tự spec §9.7 (5); `40P01`/`40001` → chạy lại (T-37, N5-5). */
async function commitReset(
  args: StaffResetArgs,
  subject: Subject,
  mode: Mode,
  hash: string,
  d: StaffResetDeps,
): Promise<number> {
  let last: unknown;
  for (let attempt = 1; attempt <= STAFF_RESET_TX_ATTEMPTS; attempt++) {
    const c = await d.pool.connect();
    let committing = false;
    /** Lỗi của lượt này: client trả về pool kèm lỗi thì pg-pool huỷ nó (connection có thể đã chết). */
    let failure: Error | undefined;
    try {
      await c.query('BEGIN');
      const locked = (
        await c.query<{ email: string; role: string | null }>(LOCK_USER, [
          args.userId,
        ])
      ).rows[0];
      if (
        !locked ||
        locked.email !== subject.email ||
        hasAdminRole(locked.role) !== (mode === 'RESET')
      )
        throw new Refused(
          'the user changed after you confirmed; run the command again to confirm the new state',
        );
      await d.seams?.afterLockUser?.(c);
      await c.query(
        mode === 'PROMOTE'
          ? `UPDATE auth."user" SET two_factor_enabled = false, role = 'admin', updated_at = now() WHERE id = $1`
          : `UPDATE auth."user" SET two_factor_enabled = false, updated_at = now() WHERE id = $1`,
        [args.userId],
      );
      if (
        (await c.query(UPSERT_CREDENTIAL, [args.userId, hash])).rowCount !== 1
      )
        throw new Refused('the credential account row belongs to another user');
      await d.seams?.afterUpsert?.(c);
      const step = lockoutRowKeys({ kind: 'step-up', userId: args.userId });
      const signin = lockoutRowKeys({ kind: 'signin', email: subject.email });
      await c.query(DELETE_LOCKOUT, [
        [...step.exact, ...signin.exact],
        [...step.prefixes, ...signin.prefixes],
      ]);
      const { apiKeysDeleted } = await revokeUserCredentials(c, args.userId, {
        apiKeys: mode === 'RESET',
      });
      await c.query(
        `INSERT INTO auth.security_notice (user_id, kind, ticket) VALUES ($1, 'operator_reset', $2)`,
        [args.userId, args.ticket],
      );
      committing = true;
      await c.query('COMMIT');
      return apiKeysDeleted;
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      if (committing)
        throw new CommitOutcomeUnknown('COMMIT outcome unknown', {
          cause: err,
        });
      // Lỗi gốc được xử lý bên dưới; ROLLBACK hỏng nghĩa là connection đã chết (huỷ khi release kèm lỗi).
      await c.query('ROLLBACK').catch(() => undefined);
      last = err;
      const code = codeOf(err);
      if (code !== PG_DEADLOCK && code !== PG_SERIALIZATION) throw err;
    } finally {
      c.release(failure);
    }
  }
  throw last;
}

/** Bước 3 (r7 N7-4, r8 R8-C4): hàm của trạng thái đã commit; không đếm session/API key (hàng rào (9) gỡ tại nguồn). */
async function postCommitCheck(
  userId: string,
  hash: string,
  pool: pg.Pool,
): Promise<'password_changed' | 'factor_present' | undefined> {
  const r = (
    await pool.query<{ password: string | null; has_factor: boolean }>(
      POST_COMMIT,
      [userId],
    )
  ).rows[0];
  if (!r || r.password !== hash) return 'password_changed';
  if (r.has_factor) return 'factor_present';
  return undefined;
}
