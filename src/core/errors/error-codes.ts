import { HttpStatus } from '@nestjs/common';

export type ErrorCode = {
  readonly code: string;
  readonly status: number;
  readonly title: string;
};

const KEY_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const MIN_ERROR_STATUS = 400;
const MAX_ERROR_STATUS = 599;
const registry = new Map<string, ErrorCode>();

export function defineErrorCodes<K extends string>(
  codes: Record<K, { status: HttpStatus; title: string }>,
): Record<K, ErrorCode> {
  const out = {} as Record<K, ErrorCode>;
  for (const key of Object.keys(codes) as K[]) {
    const def = codes[key];
    if (!KEY_PATTERN.test(key))
      throw new Error(`Error key "${key}" must be UPPER_SNAKE`);
    if (def.status < MIN_ERROR_STATUS || def.status > MAX_ERROR_STATUS)
      throw new Error(`Error "${key}" must use a 4xx or 5xx status`);
    const code = key.toLowerCase();
    if (registry.has(code))
      throw new Error(`Error code "${code}" is already defined`);
    const entry: ErrorCode = Object.freeze({
      code,
      status: def.status,
      title: def.title,
    });
    registry.set(code, entry);
    out[key] = entry;
  }
  return out;
}

export const allErrorCodes = (): readonly ErrorCode[] => [...registry.values()];
export const findErrorCode = (code: string): ErrorCode | undefined =>
  registry.get(code);

export const CoreErrors = defineErrorCodes({
  MALFORMED_REQUEST: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Malformed request',
  },
  INVALID_CURSOR: { status: HttpStatus.BAD_REQUEST, title: 'Invalid cursor' },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    title: 'A valid Idempotency-Key header is required',
  },
  ORG_CONTEXT_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Organization context is missing or invalid',
  },
  UNAUTHENTICATED: {
    status: HttpStatus.UNAUTHORIZED,
    title: 'Authentication required',
  },
  FORBIDDEN: { status: HttpStatus.FORBIDDEN, title: 'Forbidden' },
  FEATURE_NOT_IN_PLAN: {
    status: HttpStatus.FORBIDDEN,
    title: 'Feature is not included in your plan',
  },
  NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'Not found' },
  METHOD_NOT_ALLOWED: {
    status: HttpStatus.METHOD_NOT_ALLOWED,
    title: 'Method not allowed',
  },
  CONFLICT: { status: HttpStatus.CONFLICT, title: 'Conflict' },
  IDEMPOTENCY_CONFLICT: {
    status: HttpStatus.CONFLICT,
    title: 'A request with this Idempotency-Key is still in progress',
  },
  PRECONDITION_FAILED: {
    status: HttpStatus.PRECONDITION_FAILED,
    title: 'Resource has been modified',
  },
  PAYLOAD_TOO_LARGE: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    title: 'Payload too large',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    title: 'Unsupported media type',
  },
  VALIDATION_FAILED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Validation failed',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Idempotency-Key was reused with a different request',
  },
  QUOTA_EXCEEDED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Quota exceeded',
  },
  PRECONDITION_REQUIRED: {
    status: HttpStatus.PRECONDITION_REQUIRED,
    title: 'If-Match header is required',
  },
  RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Too many requests',
  },
  INTERNAL_ERROR: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    title: 'Internal error',
  },
  UPSTREAM_ERROR: {
    status: HttpStatus.BAD_GATEWAY,
    title: 'Upstream service error',
  },
  SERVICE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service unavailable',
  },
  UPSTREAM_TIMEOUT: {
    status: HttpStatus.GATEWAY_TIMEOUT,
    title: 'Upstream service timed out',
  },
});
