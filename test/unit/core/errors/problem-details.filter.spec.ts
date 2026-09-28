import {
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  CoreErrors,
  ProblemDetailsFilter,
  registerErrorMapper,
} from '../../../../src/core/errors/index.js';
import type { RequestContext } from '../../../../src/core/context/index.js';

type Reply = {
  body: Record<string, unknown>;
  status: number;
  headers: Record<string, string>;
};
function setup() {
  const reply: Reply = { body: {}, status: 0, headers: {} };
  const adapter = {
    reply: (_res: unknown, body: Record<string, unknown>, status: number) => {
      reply.body = body;
      reply.status = status;
    },
    setHeader: (_res: unknown, k: string, v: string) => {
      reply.headers[k.toLowerCase()] = v;
    },
    getRequestUrl: () => '/api/v1/users?x=1',
  };
  const adapterHost = { httpAdapter: adapter } as unknown as HttpAdapterHost;
  const ctx = {
    requestId: () => '019dd1a5-9235-70db-8d57-54ef901d8185',
  } as unknown as RequestContext;
  const filter = new ProblemDetailsFilter(adapterHost, ctx, {
    problemTypeBase: '/errors',
  });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({}), getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { reply, filter, host };
}

describe('ProblemDetailsFilter', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the agreed RFC 9457 shape for AppError', () => {
    const { reply, filter, host } = setup();
    filter.catch(
      new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'One or more fields did not pass validation.',
        fields: [
          {
            path: 'email',
            code: 'invalid_email',
            message: 'email must be an email',
          },
        ],
      }),
      host,
    );
    expect(reply.status).toBe(422);
    expect(reply.headers['content-type']).toBe('application/problem+json');
    expect(reply.body).toMatchObject({
      type: '/errors/validation-failed',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      instance: '/api/v1/users',
      requestId: '019dd1a5-9235-70db-8d57-54ef901d8185',
      errors: [
        {
          path: 'email',
          code: 'invalid_email',
          message: 'email must be an email',
        },
      ],
    });
    expect(new Date(reply.body.timestamp as string).toISOString()).toBe(
      reply.body.timestamp,
    );
  });

  it('omits errors when empty and sets headers carried by AppError', () => {
    const { reply, filter, host } = setup();
    filter.catch(
      new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        headers: { 'Retry-After': '5' },
      }),
      host,
    );
    expect(reply.body).not.toHaveProperty('errors');
    expect(reply.headers['retry-after']).toBe('5');
  });

  it('maps Nest HttpExceptions and body-parser errors to core codes', () => {
    const cases: [unknown, string][] = [
      [new NotFoundException(), 'not_found'],
      [new PayloadTooLargeException(), 'payload_too_large'],
      [new HttpException('x', HttpStatus.TOO_MANY_REQUESTS), 'rate_limited'],
      [new HttpException('x', HttpStatus.UNAUTHORIZED), 'unauthenticated'],
      [new HttpException('x', HttpStatus.BAD_REQUEST), 'malformed_request'],
      [
        new HttpException('x', HttpStatus.UNPROCESSABLE_ENTITY),
        'validation_failed',
      ],
      [
        Object.assign(new SyntaxError('Unexpected token'), {
          type: 'entity.parse.failed',
          status: 400,
        }),
        'malformed_request',
      ],
      [
        Object.assign(new Error('too large'), {
          type: 'entity.too.large',
          status: 413,
        }),
        'payload_too_large',
      ],
    ];
    for (const [ex, code] of cases) {
      const { reply, filter, host } = setup();
      filter.catch(ex, host);
      expect(reply.body.code).toBe(code);
    }
  });

  it('uses registered mappers and never leaks driver details', () => {
    class DriverError extends Error {}
    registerErrorMapper((e) =>
      e instanceof DriverError ? new AppError(CoreErrors.CONFLICT) : undefined,
    );
    const { reply, filter, host } = setup();
    filter.catch(
      new DriverError(
        'duplicate key value violates unique constraint "users_email_uq"',
      ),
      host,
    );
    expect(reply.body).toMatchObject({ status: 409, code: 'conflict' });
    expect(JSON.stringify(reply.body)).not.toContain('users_email_uq');
  });

  it('hides unknown errors, logs them, returns internal_error', () => {
    const { reply, filter, host } = setup();
    filter.catch(new Error('db password leaked in message'), host);
    expect(reply.status).toBe(500);
    expect(reply.body).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(reply.body)).not.toContain('password');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('logs an expected AppError once at warn, without err or stack; unexpected 5xx stay at error', () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { reply, filter, host } = setup();
    const indicators = { database: { status: 'down', message: 'timeout' } };
    filter.catch(
      new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        detail: 'Instance is draining',
        expected: true,
        cause: indicators,
      }),
      host,
    );
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({
      code: 'service_unavailable',
      detail: 'Instance is draining',
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields] = warnSpy.mock.calls[0] ?? [];
    expect(fields).toEqual({
      code: 'service_unavailable',
      requestId: '019dd1a5-9235-70db-8d57-54ef901d8185',
      detail: 'Instance is draining',
      cause: indicators,
    });

    filter.catch(new AppError(CoreErrors.SERVICE_UNAVAILABLE), host);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
