import type { Logger } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type pg from 'pg';
import {
  PASSWORD_WRITE_SUBJECT_UNRESOLVED_CODE,
  SECOND_FACTOR_REQUIRED_CODE,
  STAFF_PASSWORD_WRITE_FORBIDDEN_CODE,
} from './auth-error.mapper.js';
import type { AuthRequestState } from './auth-request-state.js';
import { PASSWORD_WRITE_PATHS } from './staff-hooks.js';
import { staffLacksFactorOf, type StaffStepUp } from './staff-step-up.js';

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
 * Lớp chặn trước câu ghi mật khẩu và hàng rào sau ghi cho credential của nhân viên chưa có factor (spec SP3 §5.2 hàng
 * `auth-hooks.ts` (7), (9); §9.7). Mọi câu đầu là `factorState` (`FOR SHARE OF u`): transaction của lệnh reset đang mở
 * thì chờ nó commit rồi thấy bản đã commit, nên quyết định dựa trên trạng thái đã commit, không trên thời điểm. Lỗi DB
 * được log rồi ném NGUYÊN (mount đổi lỗi hạ tầng của pool auth thành 503; lỗi lập trình là 500 — fail loud).
 */
export function createStaffCredentialFence(d: StaffCredentialFenceDeps) {
  return {
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
