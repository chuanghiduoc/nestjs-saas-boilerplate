import type { Logger } from '@nestjs/common';
import type { AppError } from '../../../../core/errors/index.js';
import type { IdentityMetrics } from '../../identity-metrics.js';
import { errorClass } from '../../identity-telemetry.js';
import { hasAdminRole } from '../../ports/identity-directory.js';
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
};
/** Mã của Better Auth 1.7.6 cho mã sai ở nhánh có session (spike T7c). */
const INVALID_CODES: ReadonlySet<string> = new Set([
  'INVALID_CODE',
  'INVALID_BACKUP_CODE',
]);

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

  return {
    /** Sau kiểm email S2-R76, trước kiểm độ mới (spec §5.2). Task 7, 8 thêm luật (3)–(8). */
    async beforeWithSession(
      ctx: StaffHookCtx,
      session: StaffHookSession | null,
      _body: Record<string, unknown>,
    ): Promise<Response | undefined> {
      if (!session || !hasAdminRole(session.user.role)) return undefined;
      if (STEP_UP_PATHS.has(ctx.path)) return stepUpBefore(ctx, session);
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
      return undefined;
    },
  };
}
