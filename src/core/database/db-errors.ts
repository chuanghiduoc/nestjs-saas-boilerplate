import { HttpStatus } from '@nestjs/common';
import { defineErrorCodes } from '../errors/index.js';

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
