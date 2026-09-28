import { Module, type INestApplication } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import { identitySpan } from '../../../src/modules/identity/identity-telemetry.js';
import {
  AUTH_POOL,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const POOL_GAUGE = 'identity_auth_pool_connections';
const PII_EMAIL = 'leak-me@example.test';
@Module({ providers: [...authPoolProviders] })
class M {}

/** Chạy `fn` trong span cha `test.parent` và trả span context của cha. */
const underParent = async (fn: () => Promise<unknown>) =>
  trace.getTracer('test').startActiveSpan('test.parent', async (parent) => {
    try {
      await fn().catch(() => undefined);
      return parent.spanContext();
    } finally {
      parent.end();
    }
  });

// Hai describe: describe sau cần app của describe đầu đã đóng (callback gauge của nó đã gỡ), vì mọi
// `AuthPoolMetrics` dùng chung một instrument theo tên.
describe('identity telemetry (review I8)', () => {
  describe('with a running app', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await createTestApp([M]);
    });
    afterAll(async () => app?.close());

    it('auth pool gauges report total/idle/waiting connections', async () => {
      await app.get<pg.Pool>(AUTH_POOL).query('SELECT 1');
      expect(
        await otel.metric(POOL_GAUGE, { state: 'total' }),
      ).toBeGreaterThanOrEqual(1);
      expect(await otel.metric(POOL_GAUGE, { state: 'waiting' })).toBe(0);
    });
    it('identitySpan is a child of the active span and records the result attributes', async () => {
      otel.reset();
      let result: string | undefined;
      const parent = await underParent(async () => {
        result = await identitySpan(
          'identity.test',
          async () => 'x',
          (r) => ({ 'identity.result': r }),
        );
      });
      expect(result).toBe('x');
      const [ok] = otel.spans('identity.test');
      expect(ok?.attributes['identity.result']).toBe('x');
      expect(ok?.spanContext().traceId).toBe(parent.traceId);
      expect(ok?.parentSpanContext?.spanId).toBe(parent.spanId);
      expect(ok?.status.code).toBe(SpanStatusCode.UNSET);
    });
    it('a failure is recorded as ERROR with class name only, rethrown unchanged, and never exports the message (S2-R30)', async () => {
      otel.reset();
      const err = new TypeError(`invalid credentials for ${PII_EMAIL}`);
      await expect(
        identitySpan('identity.fail', async () => {
          throw err;
        }),
      ).rejects.toBe(err);
      const [failed] = otel.spans('identity.fail');
      expect(failed?.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(failed?.attributes).toEqual({ 'error.type': 'TypeError' });
      expect(failed?.events.map((e) => [e.name, e.attributes])).toEqual([
        ['exception', { 'exception.type': 'TypeError' }],
      ]);
      expect(
        JSON.stringify([failed?.attributes, failed?.events, failed?.status]),
      ).not.toContain(PII_EMAIL);
    });
    it('an AppError is recorded by its code, not its detail', async () => {
      otel.reset();
      const parent = await underParent(() =>
        identitySpan('identity.app-error', async () => {
          throw new AppError(CoreErrors.UNAUTHENTICATED, {
            detail: `no session for ${PII_EMAIL}`,
          });
        }),
      );
      const [failed] = otel.spans('identity.app-error');
      expect(failed?.parentSpanContext?.spanId).toBe(parent.spanId);
      expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
      expect(failed?.attributes).toEqual({
        'error.type': 'AppError',
        'identity.error_code': CoreErrors.UNAUTHENTICATED.code,
      });
      expect(failed?.events.map((e) => e.attributes)).toEqual([
        { 'exception.type': CoreErrors.UNAUTHENTICATED.code },
      ]);
      expect(JSON.stringify(failed?.events)).not.toContain(PII_EMAIL);
    });
  });

  describe('app shutdown', () => {
    it('app.close() ends the auth pool and removes the gauge callback', async () => {
      const app = await createTestApp([M]);
      const pool = app.get<pg.Pool>(AUTH_POOL);
      expect(pool).toBeInstanceOf(pg.Pool);
      await pool.query('SELECT 1');
      expect(
        await otel.metric(POOL_GAUGE, { state: 'total' }),
      ).toBeGreaterThanOrEqual(1);
      await app.close();
      expect(pool.ended).toBe(true);
      expect(pool.totalCount).toBe(0);
      // SDK giữ giá trị cumulative cuối của gauge, nên "không còn datapoint" không đo được; thay vào đó
      // kiểm callback (chỉ đọc bộ đếm của pool) không còn chạy khi thu thập sau khi đóng.
      const reads = vi.spyOn(pool, 'totalCount', 'get');
      await otel.metric(POOL_GAUGE);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
    });
  });
});
