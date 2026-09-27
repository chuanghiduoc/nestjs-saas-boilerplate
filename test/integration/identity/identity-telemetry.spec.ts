import { Module, type INestApplication } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identitySpan } from '../../../src/modules/identity/identity-telemetry.js';
import {
  AUTH_POOL,
  authPoolProviders,
} from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { createTestApp } from '../../support/app-factory.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
@Module({ providers: [...authPoolProviders] })
class M {}

describe('identity telemetry (review I8)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp([M]);
  });
  afterAll(async () => app?.close());

  it('auth pool gauges report total/idle/waiting connections', async () => {
    await app.get<pg.Pool>(AUTH_POOL).query('SELECT 1');
    expect(
      await otel.metric('identity_auth_pool_connections', { state: 'total' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await otel.metric('identity_auth_pool_connections', { state: 'waiting' }),
    ).toBe(0);
  });
  it('identitySpan records the result attributes, and errors with ERROR status before rethrowing', async () => {
    otel.reset();
    expect(
      await identitySpan(
        'identity.test',
        async () => 'x',
        (r) => ({ 'identity.result': r }),
      ),
    ).toBe('x');
    await expect(
      identitySpan('identity.test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const [ok, failed] = otel.spans('identity.test');
    expect(ok?.attributes['identity.result']).toBe('x');
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
