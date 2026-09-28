import { HttpStatus, type Logger } from '@nestjs/common';
import { AppError, defineErrorCodes } from '../errors/index.js';
import { isCommitProvenNotApplied } from './db-infra-error.js';

export const DbErrors = defineErrorCodes({
  /**
   * S2-R70 M2 / final review I1: COMMIT đã gửi nhưng câu trả lời không chứng minh được transaction đã rollback (mất kết
   * nối, hết `query_timeout`, checkout bị thu hồi, lỗi PgBouncer 08P01, 57P01…): transaction CÓ THỂ đã được ghi. Khác
   * `service_unavailable` (chắc chắn chưa ghi gì). Route `@Idempotent()` không lưu lỗi này làm response cuối (ADR 0007):
   * thử lại cùng Idempotency-Key chạy lại handler, và ghi của handler phải idempotent trong DB theo key đó.
   */
  COMMIT_OUTCOME_UNKNOWN: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Commit outcome unknown',
  },
});

/**
 * Lỗi của COMMIT (mọi câu trong transaction đã xong). Chỉ giữ nguyên lỗi (retry/mapper như cũ) khi nó CHỨNG MINH
 * transaction không được áp dụng (`isCommitProvenNotApplied`: SQLSTATE lớp 40/23/25 do server trả, hoặc pg chưa gửi
 * COMMIT). Mọi lỗi khác → `commit_outcome_unknown`, log ERROR; UnitOfWork không retry lỗi này (chỉ 40001/40P01). Dùng
 * chung cho UnitOfWork và `RelayDb.transaction`.
 */
export function commitFailure(err: unknown, logger: Logger): unknown {
  if (isCommitProvenNotApplied(err)) return err;
  logger.error(
    { event: 'commit_outcome_unknown', err },
    'COMMIT failed without proof of a rollback; the transaction may or may not have been committed',
  );
  return new AppError(DbErrors.COMMIT_OUTCOME_UNKNOWN, { cause: err });
}
