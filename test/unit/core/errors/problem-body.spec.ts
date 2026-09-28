import { describe, expect, it } from 'vitest';
import {
  AppError,
  CoreErrors,
  problemBody,
} from '../../../../src/core/errors/index.js';

describe('problemBody', () => {
  const meta = {
    instance: '/api/auth/sign-in/email',
    requestId: 'r1',
    typeBase: '/errors',
  };
  it('builds the same shape as ProblemDetailsFilter', () => {
    const body = problemBody(
      new AppError(CoreErrors.PAYLOAD_TOO_LARGE, { detail: 'too big' }),
      meta,
      true,
    );
    expect(body).toMatchObject({
      type: '/errors/payload-too-large',
      title: 'Payload too large',
      status: 413,
      code: 'payload_too_large',
      detail: 'too big',
      instance: '/api/auth/sign-in/email',
      requestId: 'r1',
    });
    expect(typeof body.timestamp).toBe('string');
  });
  it('hides detail when not exposed and adds field errors', () => {
    const body = problemBody(
      new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'secret',
        fields: [{ path: 'email', code: 'invalid', message: 'bad' }],
      }),
      meta,
      false,
    );
    expect(body.detail).toBeUndefined();
    expect(body.errors).toEqual([
      { path: 'email', code: 'invalid', message: 'bad' },
    ]);
  });
});
