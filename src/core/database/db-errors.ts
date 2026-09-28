import { HttpStatus, type Logger } from '@nestjs/common';
import { AppError, defineErrorCodes } from '../errors/index.js';
import { isDbNoAnswerError } from './db-infra-error.js';

export const DbErrors = defineErrorCodes({
  /**
   * S2-R70 M2: COMMIT đã gửi nhưng DB không trả lời (mất kết nối, hết `query_timeout`, checkout bị thu hồi): transaction
   * CÓ THỂ đã được ghi. Khác `service_unavailable` (chắc chắn chưa ghi gì): client chỉ nên thử lại khi request idempotent
   * (Idempotency-Key) hoặc sau khi tự kiểm tra trạng thái. Spec core không quy định trường hợp này.
   */
  COMMIT_OUTCOME_UNKNOWN: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Commit outcome unknown',
  },
});

/**
 * Lỗi của COMMIT (mọi câu trong transaction đã xong). Server trả lời bằng lỗi (vd. 40001 ở SERIALIZABLE) thì transaction
 * chắc chắn đã rollback: giữ nguyên lỗi (retry/mapper như cũ). Server KHÔNG trả lời (mất kết nối, `query_timeout`,
 * checkout bị thu hồi) thì transaction có thể đã được ghi: `commit_outcome_unknown`, log ERROR; UnitOfWork không retry
 * lỗi này (chỉ 40001/40P01). Dùng chung cho UnitOfWork và `RelayDb.transaction`.
 */
export function commitFailure(err: unknown, logger: Logger): unknown {
  if (!isDbNoAnswerError(err)) return err;
  logger.error(
    { event: 'commit_outcome_unknown', err },
    'COMMIT got no answer from the database; the transaction may or may not have been committed',
  );
  return new AppError(DbErrors.COMMIT_OUTCOME_UNKNOWN, { cause: err });
}
