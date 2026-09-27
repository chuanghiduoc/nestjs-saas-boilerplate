import { Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { HealthModule } from '../../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { AuthDatabaseReadiness } from '../../../src/modules/identity/infra/better-auth/auth-readiness.js';
import { authPoolProviders } from '../../../src/modules/identity/infra/better-auth/auth-pool.provider.js';
import { createTestApp } from '../../support/app-factory.js';

@Module({ providers: [...authPoolProviders, AuthDatabaseReadiness] })
class M {}
const make = () =>
  createTestApp(
    [
      DatabaseModule.forRoot({ relay: false }),
      RedisModule,
      HttpModule,
      HealthModule.forRoot({ http: true }),
      M,
    ],
    { beforeInit: applyHttpDefaults },
  );

describe('auth_database readiness', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });
  it('ready reports auth_database up', async () => {
    app = await make();
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(res.body.info).toHaveProperty('auth_database');
  });
  it('an unreachable auth pool makes the api not ready (503)', async () => {
    vi.stubEnv('DB_AUTH_PORT', '1');
    vi.stubEnv('DB_AUTH_CONNECTION_TIMEOUT_MS', '200');
    app = await make();
    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });
});
