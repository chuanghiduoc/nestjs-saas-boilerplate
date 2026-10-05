import type { Logger } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../../core/errors/index.js';
import { IdentityErrors } from '../../errors.js';
import type { IdentityMetrics } from '../../identity-metrics.js';
import { errorClass } from '../../identity-telemetry.js';
import { hasAdminRole } from '../../ports/identity-directory.js';
import type { PlatformRoleChangeListener } from '../../ports/platform-role-change-listener.js';
import { adminTargetUserId, asRecord, stringField } from './admin-target.js';
import type { AuthRequestState } from './auth-request-state.js';
import {
  LockoutBlockedError,
  LockoutUnavailableError,
  type LoginLockout,
} from './login-lockout.js';
import {
  STEP_UP_METHOD_BY_PATH,
  STEP_UP_PATHS,
  type StaffStepUp,
} from './staff-step-up.js';

export type StaffHookCtx = {
  path: string;
  request?: Request | undefined;
  query?: unknown;
};
export type StaffHookSession = {
  user: { id: string; role?: string | null };
  session: { id: string };
};
export type StaffResponder = {
  problem(ctx: StaffHookCtx, err: AppError): Response;
  rateLimited(ctx: StaffHookCtx, retryAfterSec: number): Response;
  unavailable(ctx: StaffHookCtx): Response;
  invalidField(
    ctx: StaffHookCtx,
    path: string,
    code: string,
    message: string,
  ): Response;
};
export type StaffHookDeps = {
  stepUp: Pick<
    StaffStepUp,
    | 'totpMarkFresh'
    | 'currentFactorId'
    | 'writeMark'
    | 'staffLacksFactor'
    | 'otherAdminExists'
  >;
  lockout: Pick<LoginLockout, 'guard'>;
  state: AuthRequestState;
  /** `AUTH_SESSION_FRESH_AGE_SEC`: độ mới của dấu TOTP ở gate (3). */
  freshAgeSec: number;
  metrics: Pick<IdentityMetrics, 'stepUp' | 'staffStepUpRequired'>;
  logger: Pick<Logger, 'error' | 'log' | 'warn'>;
  /** Port của tenancy (§9.7 (6)); vắng → không làm gì. */
  roleChange: PlatformRoleChangeListener | undefined;
};
/** Mã của Better Auth 1.7.6 cho mã sai ở nhánh có session (spike T7c). */
const INVALID_CODES: ReadonlySet<string> = new Set([
  'INVALID_CODE',
  'INVALID_BACKUP_CODE',
]);

export const ADMIN_PREFIX = '/admin/';
/** Gate (3) (r5 N5-1, r6 N6-7): đọc factor, sinh bộ mã mới, mint JWT mang `role`, cộng MỌI path tiền tố `/admin/`. */
export const STAFF_TOTP_GATED_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/token',
]);
const DISABLE_2FA = '/two-factor/disable';
const RESET_PASSWORD = '/reset-password';
const CHANGE_PASSWORD = '/change-password';
const SET_USER_PASSWORD = '/admin/set-user-password';
/** Mọi đường HTTP ghi mật khẩu của một user đã có (spec §9.7 (7); `setPassword` là serverOnly, `/admin/update-user` chặn `password`). */
export const PASSWORD_WRITE_PATHS: ReadonlySet<string> = new Set([
  RESET_PASSWORD,
  CHANGE_PASSWORD,
  SET_USER_PASSWORD,
]);
const RESET_IDENTIFIER_PREFIX = 'reset-password:';
const SET_ROLE = '/admin/set-role';
const UPDATE_USER = '/admin/update-user';
type Surface = 'factor' | 'admin' | 'token';
const surfaceOf = (path: string): Surface =>
  path.startsWith(ADMIN_PREFIX)
    ? 'admin'
    : path === '/token'
      ? 'token'
      : 'factor';
/** (5): khoá `twoFactorEnabled` so không phân biệt hoa thường, bỏ `_` (R4A-N2(b)). */
const flipsTwoFactor = (data: Record<string, unknown>): boolean =>
  Object.keys(data).some(
    (k) => k.toLowerCase().replaceAll('_', '') === 'twofactorenabled',
  );
/** Role mới của (8) như `parseRoles` của plugin: mảng nối bằng `,`; kiểu khác → plugin tự từ chối trước khi ghi. */
const newRoleOf = (
  path: string,
  body: Record<string, unknown>,
): string | undefined => {
  const raw = path === SET_ROLE ? body.role : asRecord(body.data).role;
  if (typeof raw === 'string') return raw;
  if (
    Array.isArray(raw) &&
    raw.every((x): x is string => typeof x === 'string')
  )
    return raw.join(',');
  return undefined;
};
const writesRole = (path: string, body: Record<string, unknown>): boolean =>
  path === SET_ROLE ||
  (path === UPDATE_USER && Object.hasOwn(asRecord(body.data), 'role'));

/**
 * Luật của nhân viên nền tảng trong hook Better Auth (spec SP3 §5.2 hàng `auth-hooks.ts`, §9.7). "Nhân viên" =
 * `hasAdminRole(session.user.role)`; session là `d.session(headers)` mà `createAuthHooks` đã đọc (thấy cả bearer, R4C-N4-1)
 * — chỉ trên tập path có tên của nó (spike T7b: `getSession` trong hook chạy lại hook, không gọi ở mọi path).
 * User không phải nhân viên giữ hành vi SP2.
 */
export function createStaffHooks(d: StaffHookDeps, r: StaffResponder) {
  /** (1): lockout theo user, consume TRƯỚC verify (mọi lần thử đều đếm, không refund, N5-2), rồi chụp factor hiện tại. */
  const stepUpBefore = async (
    ctx: StaffHookCtx,
    session: StaffHookSession,
  ): Promise<Response | undefined> => {
    const method = STEP_UP_METHOD_BY_PATH[ctx.path];
    if (method === undefined)
      throw new Error(`stepUpBefore on a non step-up path ${ctx.path}`);
    try {
      await d.lockout.guard({ kind: 'step-up', userId: session.user.id });
    } catch (err) {
      if (err instanceof LockoutBlockedError) {
        d.metrics.stepUp.add(1, { result: 'rate_limited', method });
        return r.rateLimited(ctx, err.retryAfterSec);
      }
      if (err instanceof LockoutUnavailableError) return r.unavailable(ctx);
      throw err;
    }
    const factorId = await d.stepUp.currentFactorId(session.user.id);
    // Không có factor hiện tại (chưa bật, đang chờ verify ở nhánh bật): handler tự quyết, không bao giờ có dấu.
    await d.state.setStepUp(
      factorId ? { sessionId: session.session.id, factorId, method } : null,
    );
    return undefined;
  };

  /** (2): thành công + đã chụp factor → ghi dấu; 0 dòng/23503/40P01 → không dấu (INFO); lỗi khác → ERROR, response giữ nguyên. */
  const stepUpAfter = async (
    failed: boolean,
    code: string | undefined,
  ): Promise<void> => {
    const mark = await d.state.stepUp();
    if (!mark) return;
    if (failed) {
      if (code !== undefined && INVALID_CODES.has(code))
        d.metrics.stepUp.add(1, {
          result: 'invalid_code',
          method: mark.method,
        });
      return;
    }
    try {
      const out = await d.stepUp.writeMark(mark);
      d.metrics.stepUp.add(1, {
        result: out === 'MARKED' ? 'marked' : 'skipped',
        method: mark.method,
      });
      if (out === 'SKIPPED')
        d.logger.log(
          { event: 'second_factor_mark_skipped', method: mark.method },
          'step-up verified but its session or factor is gone; no mark',
        );
    } catch (err) {
      d.metrics.stepUp.add(1, { result: 'mark_failed', method: mark.method });
      d.logger.error(
        {
          event: 'second_factor_mark_failed',
          method: mark.method,
          errorClass: errorClass(err),
        },
        'step-up mark write failed; the session stays without a mark (fail closed)',
      );
    }
  };

  /** (3): dấu TOTP tươi trên factor hiện tại; thiếu/backup code/cũ/0 dòng → 403. */
  const totpGate = async (
    ctx: StaffHookCtx,
    session: StaffHookSession,
  ): Promise<Response | undefined> => {
    if (
      await d.stepUp.totpMarkFresh(
        session.user.id,
        session.session.id,
        d.freshAgeSec,
      )
    )
      return undefined;
    d.metrics.staffStepUpRequired.add(1, { surface: surfaceOf(ctx.path) });
    return r.problem(ctx, new AppError(IdentityErrors.SECOND_FACTOR_REQUIRED));
  };
  /** (8): tự bỏ role admin khi không còn admin nào khác chưa bị ban → 409 (không khoá, T-41 có tên). */
  const lastAdmin = async (
    ctx: StaffHookCtx,
    session: StaffHookSession,
    body: Record<string, unknown>,
  ): Promise<Response | undefined> => {
    if (
      !writesRole(ctx.path, body) ||
      adminTargetUserId(body) !== session.user.id
    )
      return undefined;
    const next = newRoleOf(ctx.path, body);
    if (
      next === undefined ||
      hasAdminRole(next) ||
      (await d.stepUp.otherAdminExists(session.user.id))
    )
      return undefined;
    d.logger.log(
      { event: 'last_platform_admin_refused', userId: session.user.id },
      'the last platform admin tried to drop their own admin role',
    );
    return r.problem(ctx, new AppError(IdentityErrors.LAST_PLATFORM_ADMIN));
  };

  /** (7): câu ghi mật khẩu cho nhân viên chưa có factor bị từ chối ở hook (WARN có `stage: 'hook'`). */
  const refuseWrite = (
    ctx: StaffHookCtx,
    userId: string,
    err: AppError,
  ): Response => {
    d.logger.warn(
      {
        event: 'staff_password_change_refused',
        path: ctx.path,
        userId,
        stage: 'hook',
      },
      'a password write for staff without a second factor was refused',
    );
    return r.problem(ctx, err);
  };

  return {
    /** Sau kiểm email S2-R76, trước kiểm độ mới (spec §5.2). */
    async beforeWithSession(
      ctx: StaffHookCtx,
      session: StaffHookSession | null,
      body: Record<string, unknown>,
    ): Promise<Response | undefined> {
      // (5) mọi session (người không phải admin bị plugin từ chối sau đó).
      if (ctx.path === UPDATE_USER && flipsTwoFactor(asRecord(body.data)))
        return r.invalidField(
          ctx,
          'data.twoFactorEnabled',
          'not_allowed',
          'twoFactorEnabled cannot be changed here; staff factors are reset by the operator command',
        );
      // (7) mọi session (subject là chính người gọi; "nhân viên chưa có factor" đọc từ DB, không từ role của session).
      if (ctx.path === CHANGE_PASSWORD && session) {
        await d.state.setPasswordWriteSubjects([session.user.id]);
        if (await d.stepUp.staffLacksFactor(session.user.id))
          return refuseWrite(
            ctx,
            session.user.id,
            new AppError(IdentityErrors.SECOND_FACTOR_REQUIRED),
          );
      }
      if (!session || !hasAdminRole(session.user.role)) return undefined;
      if (
        ctx.path.startsWith(ADMIN_PREFIX) ||
        STAFF_TOTP_GATED_PATHS.has(ctx.path)
      ) {
        const refused = await totpGate(ctx, session);
        if (refused) return refused;
      }
      // Quy tắc chung (r8 R8-S2): mọi `/admin/*` có khoá `userId` phải là UUID chữ thường chuẩn sau ép kiểu như plugin.
      if (
        ctx.path.startsWith(ADMIN_PREFIX) &&
        Object.hasOwn(body, 'userId') &&
        adminTargetUserId(body) === undefined
      )
        return r.invalidField(
          ctx,
          'userId',
          'invalid_user_id',
          'userId must be a canonical lowercase UUID',
        );
      if (ctx.path === DISABLE_2FA)
        return r.problem(
          ctx,
          new AppError(CoreErrors.FORBIDDEN, {
            detail:
              'Staff factors are replaced only by the operator reset command (pnpm identity:staff-2fa-reset)',
          }),
        );
      const lastAdminRefusal = await lastAdmin(ctx, session, body);
      if (lastAdminRefusal) return lastAdminRefusal;
      // (7) đích của admin (đã qua gate (3) và luật id chuẩn).
      if (ctx.path === SET_USER_PASSWORD) {
        const target = adminTargetUserId(body);
        if (target === undefined)
          throw new Error(
            'set-user-password passed the canonical id rule without a target',
          );
        await d.state.setPasswordWriteSubjects([target]);
        if (await d.stepUp.staffLacksFactor(target))
          return refuseWrite(
            ctx,
            target,
            new AppError(CoreErrors.FORBIDDEN, {
              detail:
                'Use the operator reset command (pnpm identity:staff-2fa-reset) for staff without a second factor',
            }),
          );
      }
      if (STEP_UP_PATHS.has(ctx.path)) return stepUpBefore(ctx, session);
      return undefined;
    },
    /**
     * `/reset-password` (không session): phân giải MỌI token khác rỗng ở body và query (tối đa hai; query lặp khoá thành
     * mảng thì bỏ — zod của handler từ chối trước khi handler chạy), đọc dòng `verification` BẤT KỂ hạn, ghi tập subject
     * vào request state; bất kỳ subject nào là nhân viên chưa có factor → 400 như token sai (không oracle; token không bị
     * tiêu thụ). Chạy TRƯỚC reclaim S2-R40.
     */
    async beforeResetPassword(
      ctx: StaffHookCtx,
      body: Record<string, unknown>,
      query: unknown,
      find: (identifier: string) => Promise<{ value: string } | null>,
    ): Promise<Response | undefined> {
      const tokens = [
        ...new Set([stringField(body, 'token'), stringField(query, 'token')]),
      ].filter((t): t is string => t !== undefined && t !== '');
      const subjects: string[] = [];
      for (const t of tokens) {
        const v = await find(`${RESET_IDENTIFIER_PREFIX}${t}`);
        if (v && !subjects.includes(v.value)) subjects.push(v.value);
      }
      await d.state.setPasswordWriteSubjects(subjects);
      for (const s of subjects)
        if (await d.stepUp.staffLacksFactor(s))
          return refuseWrite(
            ctx,
            s,
            new AppError(IdentityErrors.INVALID_OR_EXPIRED_TOKEN),
          );
      return undefined;
    },
    async after(
      ctx: StaffHookCtx,
      o: {
        failed: boolean;
        code: string | undefined;
        body: Record<string, unknown>;
      },
    ): Promise<Response | undefined> {
      if (STEP_UP_PATHS.has(ctx.path)) await stepUpAfter(o.failed, o.code);
      if (!o.failed && d.roleChange && writesRole(ctx.path, o.body)) {
        const target = adminTargetUserId(o.body);
        if (target === undefined)
          throw new Error(
            'a role write reached the after-hook without a canonical target id',
          );
        try {
          await d.roleChange.onPlatformRoleChanged(target);
        } catch (err) {
          d.logger.error(
            {
              event: 'platform_role_change_listener_failed',
              userId: target,
              errorClass: errorClass(err),
            },
            'the role was written but revoking the support grants failed; the same request can be retried',
          );
          return r.unavailable(ctx);
        }
      }
      return undefined;
    },
  };
}
