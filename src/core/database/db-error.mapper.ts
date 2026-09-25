import { Logger } from '@nestjs/common';
import {
  AppError,
  CoreErrors,
  type ErrorCode,
  type ErrorMapper,
} from '../errors/index.js';

/** SQLSTATE chuẩn của Postgres. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  /** FK `ON DELETE/UPDATE RESTRICT` bị vi phạm (Postgres 18 báo 23001, không phải 23503). */
  RESTRICT_VIOLATION: '23001',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  QUERY_CANCELED: '57014',
} as const;
/**
 * 42501 dùng chung cho thiếu GRANT và RLS chặn ghi; chỉ RLS mới được map thành 404.
 * Nhận diện theo thông báo chuẩn (database đặt lc_messages = C trong 01-roles.sh) hoặc
 * theo `routine` của Postgres (không phụ thuộc ngôn ngữ), giống PostgreSqlExceptionConverter.
 */
const RLS_MESSAGE = 'row-level security';
const RLS_ROUTINE = 'ExecWithCheckOptions';
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

const constraintErrors = new Map<string, ErrorCode>();

/** Map tên constraint → mã lỗi cụ thể (thay cho conflict/validation_failed chung). Tên trùng thì ném lỗi. */
export function defineConstraintErrors(map: Record<string, ErrorCode>): void {
  for (const [name, code] of Object.entries(map)) {
    if (constraintErrors.has(name))
      throw new Error(`Constraint "${name}" already mapped`);
    constraintErrors.set(name, code);
  }
}

type PgFields = {
  sqlState: string;
  constraint?: string;
  routine?: string;
  message: string;
};

const hasKey = <K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> =>
  typeof obj === 'object' && obj !== null && key in obj;
const field = (obj: unknown, key: string): unknown =>
  hasKey(obj, key) ? obj[key] : undefined;
const firstString = (values: unknown[]): string | undefined =>
  values.find((v): v is string => typeof v === 'string');

/**
 * Lấy SQLSTATE/constraint từ lỗi DB. Lỗi trong câu lệnh là `DriverException` của MikroORM
 * (copy mọi thuộc tính của lỗi pg: `code` = SQLSTATE, `constraint`, `routine`); lỗi lúc
 * COMMIT (vd. 40001 ở serializable) là lỗi pg thô vì MikroORM không convert lỗi commit.
 * `cause` dự phòng cho lỗi được bọc lại.
 */
export function pgFields(err: unknown): PgFields | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = field(err, 'cause');
  const sqlState = [
    field(err, 'sqlState'),
    field(err, 'code'),
    field(cause, 'code'),
  ].find((c): c is string => typeof c === 'string' && SQLSTATE_PATTERN.test(c));
  if (!sqlState) return undefined;
  return {
    sqlState,
    constraint: firstString([
      field(err, 'constraint'),
      field(cause, 'constraint'),
    ]),
    routine: firstString([field(err, 'routine'), field(cause, 'routine')]),
    message: err.message,
  };
}

/** Lỗi mà transaction ngoài cùng được chạy lại từ đầu. */
export const isRetryableTxError = (err: unknown): boolean => {
  const s = pgFields(err)?.sqlState;
  return s === PG.SERIALIZATION_FAILURE || s === PG.DEADLOCK_DETECTED;
};

const isRlsViolation = (pg: PgFields): boolean =>
  pg.message.includes(RLS_MESSAGE) || pg.routine === RLS_ROUTINE;

const logger = new Logger('DbErrorMapper');
const byConstraint = (pg: PgFields, fallback: ErrorCode): ErrorCode =>
  (pg.constraint && constraintErrors.get(pg.constraint)) || fallback;

/**
 * Map lỗi DB đã biết thành AppError. Không đặt `detail` nên tên constraint/SQL không lộ ra
 * client. SQLSTATE khác (gồm lỗi `org context is not set` = P0001 và thiếu GRANT) trả về
 * undefined để rơi xuống 500 internal_error (lỗi lập trình, được log đầy đủ ở server).
 */
export const dbErrorMapper: ErrorMapper = (err) => {
  const pg = pgFields(err);
  if (!pg) return undefined;
  switch (pg.sqlState) {
    case PG.UNIQUE_VIOLATION:
    case PG.FOREIGN_KEY_VIOLATION:
    case PG.RESTRICT_VIOLATION:
      return new AppError(byConstraint(pg, CoreErrors.CONFLICT), {
        cause: err,
      });
    case PG.CHECK_VIOLATION:
    case PG.NOT_NULL_VIOLATION:
      return new AppError(byConstraint(pg, CoreErrors.VALIDATION_FAILED), {
        cause: err,
      });
    case PG.INSUFFICIENT_PRIVILEGE:
      if (!isRlsViolation(pg)) return undefined;
      logger.warn(
        { securityEvent: 'rls_violation', sqlState: pg.sqlState },
        'row level security blocked a write; an application-level check is missing',
      );
      return new AppError(CoreErrors.NOT_FOUND, { cause: err });
    case PG.SERIALIZATION_FAILURE:
    case PG.DEADLOCK_DETECTED:
    case PG.QUERY_CANCELED:
      return new AppError(CoreErrors.SERVICE_UNAVAILABLE, { cause: err });
    default:
      return undefined;
  }
};
