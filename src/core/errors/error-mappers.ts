import { HttpException, HttpStatus } from '@nestjs/common';
import { AppError } from './app-error.js';
import { CoreErrors, type ErrorCode } from './error-codes.js';

export type ErrorMapper = (err: unknown) => AppError | undefined;
const mappers: ErrorMapper[] = [];

export function registerErrorMapper(mapper: ErrorMapper): void {
  if (!mappers.includes(mapper)) mappers.push(mapper);
}
export function mapKnownError(err: unknown): AppError | undefined {
  for (const m of mappers) {
    const mapped = m(err);
    if (mapped) return mapped;
  }
  return undefined;
}

const HTTP_STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: CoreErrors.MALFORMED_REQUEST,
  [HttpStatus.UNAUTHORIZED]: CoreErrors.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: CoreErrors.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: CoreErrors.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: CoreErrors.METHOD_NOT_ALLOWED,
  [HttpStatus.CONFLICT]: CoreErrors.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: CoreErrors.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: CoreErrors.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.UNPROCESSABLE_ENTITY]: CoreErrors.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: CoreErrors.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: CoreErrors.SERVICE_UNAVAILABLE,
};
/** Mã core mặc định cho một HTTP status (dùng chung cho HttpException và lỗi của thư viện ngoài, vd. Better Auth). */
export const errorCodeForStatus = (status: number): ErrorCode | undefined =>
  HTTP_STATUS_TO_CODE[status];
const BODY_PARSER_TYPES: Record<string, ErrorCode> = {
  'entity.parse.failed': CoreErrors.MALFORMED_REQUEST,
  'entity.too.large': CoreErrors.PAYLOAD_TOO_LARGE,
  'encoding.unsupported': CoreErrors.UNSUPPORTED_MEDIA_TYPE,
  'charset.unsupported': CoreErrors.UNSUPPORTED_MEDIA_TYPE,
};

/** Chuẩn hoá mọi lỗi thành AppError với mã có trong registry. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const mapped = mapKnownError(err);
  if (mapped) return mapped;
  if (err instanceof HttpException)
    return new AppError(
      errorCodeForStatus(err.getStatus()) ?? CoreErrors.INTERNAL_ERROR,
      { cause: err },
    );
  const type =
    typeof err === 'object' && err !== null && 'type' in err
      ? (err as { type: unknown }).type
      : undefined;
  if (typeof type === 'string' && BODY_PARSER_TYPES[type])
    return new AppError(BODY_PARSER_TYPES[type], { cause: err });
  return new AppError(CoreErrors.INTERNAL_ERROR, { cause: err });
}
