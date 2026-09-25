import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import {
  IDEMPOTENT_META,
  IdempotencyInterceptor,
  type IdempotentOptions,
} from './idempotency.interceptor.js';

/**
 * Bắt buộc Idempotency-Key (IETF draft-ietf-httpapi-idempotency-key-header-07). Route phải có principal
 * đã xác thực. Khi trả lại response đã lưu, status lấy từ `@HttpCode` của route: không đổi status
 * động trong handler. `ttlSec` chỉ nên ngắn hơn IDEMPOTENCY_TTL_SEC (vd. route tiền).
 */
export const Idempotent = (opts: IdempotentOptions = {}) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_META, opts),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'Unique key per logical operation (a UUID is recommended). Same key + same body replays the stored response.',
    }),
  );
