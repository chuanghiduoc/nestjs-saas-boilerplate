import { HttpException, HttpStatus } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  CoreErrors,
  exposesDetail,
  registerErrorMapper,
  toAppError,
} from '../../../../src/core/errors/index.js';
import { writeProblem } from '../../../../src/core/http/index.js';

/** Chuỗi "bí mật" trong lỗi nội bộ: không bao giờ được xuất hiện trong response 5xx. */
const INTERNAL_SECRET = 'db host 10.0.0.7 refused';
const CLIENT_DETAIL = 'Body exceeds 1kb';
/** Đúng header mà `ProblemDetailsFilter` trả qua Express (`res.json` thêm charset). */
const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** Lỗi hạ tầng giả, được mapper (như mapper DB/Redis thật) chuyển thành 503 kèm detail nội bộ. */
class FakeInfraError extends Error {}
registerErrorMapper((e) =>
  e instanceof FakeInfraError
    ? new AppError(CoreErrors.SERVICE_UNAVAILABLE, { detail: INTERNAL_SECRET })
    : undefined,
);

describe('exposesDetail (single rule for ProblemDetailsFilter and writeProblem)', () => {
  it.each<[string, unknown, boolean]>([
    ['4xx AppError', new AppError(CoreErrors.PAYLOAD_TOO_LARGE), true],
    [
      '5xx AppError thrown on purpose',
      new AppError(CoreErrors.INTERNAL_ERROR),
      true,
    ],
    ['unknown error mapped to 500', new Error(INTERNAL_SECRET), false],
    ['mapped infra error (503 with detail)', new FakeInfraError(), false],
    [
      'HttpException 503',
      new HttpException('x', HttpStatus.SERVICE_UNAVAILABLE),
      false,
    ],
    ['HttpException 404', new HttpException('x', HttpStatus.NOT_FOUND), true],
  ])('%s → %s', (_n, exception, expected) => {
    expect(exposesDetail(exception, toAppError(exception))).toBe(expected);
  });
});

describe('writeProblem', () => {
  let server: Server;
  let next: unknown;
  beforeAll(() => {
    server = createServer((req, res) =>
      writeProblem(res, next, {
        instance: req.url ?? '',
        requestId: 'r-test',
        typeBase: '/errors',
      }),
    );
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );

  it.each<[string, unknown, number, string]>([
    ['mapped infra error', new FakeInfraError(), 503, 'service_unavailable'],
    ['unknown error', new Error(INTERNAL_SECRET), 500, 'internal_error'],
  ])('hides detail on a 5xx from a %s', async (_n, err, status, code) => {
    next = err;
    const res = await request(server).post('/x').expect(status);
    expect(res.headers['content-type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.body.code).toBe(code);
    expect(res.body.detail).toBeUndefined();
    expect(res.text).not.toContain(INTERNAL_SECRET);
  });
  it('keeps detail on a 4xx AppError and does not force Connection: close on 413 (ruling S2-R12)', async () => {
    next = new AppError(CoreErrors.PAYLOAD_TOO_LARGE, {
      detail: CLIENT_DETAIL,
    });
    // Client xin keep-alive: header `connection` của response chỉ còn là do writeProblem quyết định.
    const res = await request(server)
      .post('/x')
      .set('Connection', 'keep-alive')
      .expect(413);
    expect(res.body).toMatchObject({
      code: 'payload_too_large',
      detail: CLIENT_DETAIL,
      requestId: 'r-test',
    });
    expect(res.headers['content-type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.connection).not.toBe('close');
  });
});
