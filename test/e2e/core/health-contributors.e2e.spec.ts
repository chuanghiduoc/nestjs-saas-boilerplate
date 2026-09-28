import { Injectable, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import {
  HealthModule,
  ReadinessContributor,
  type ReadinessProbe,
} from '../../../src/core/health/index.js';
import { HttpModule, applyHttpDefaults } from '../../../src/core/http/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';

const state = { up: true };
@Injectable()
@ReadinessContributor('fake_dependency')
class FakeProbe implements ReadinessProbe {
  async probe(): Promise<void> {
    if (!state.up) throw new Error('fake dependency down');
  }
}
@Module({ providers: [FakeProbe] })
class FakeModule {}

@Injectable()
@ReadinessContributor('database')
class Clashing implements ReadinessProbe {
  async probe(): Promise<void> {}
}
@Module({ providers: [Clashing] })
class ClashingModule {}

const base = () => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  HttpModule,
  HealthModule.forRoot({ http: true }),
];

// Two describe blocks, not one: MikroOrmCoreModule tracks its `contextName`s in a process-wide
// array cleared only on `onApplicationShutdown` (@mikro-orm/nestjs). A second DatabaseModule-based
// app started while the first is still open collides with "ContextName 'app' already registered",
// unrelated to readiness contributors. Splitting the describes lets the first block's `afterAll`
// close its app before the second block starts, same pattern as test/e2e/core/health.e2e.spec.ts.
describe('readiness contributors', () => {
  describe('contributor probe', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await createTestApp([...base(), FakeModule], {
        beforeInit: applyHttpDefaults,
      });
    });
    afterAll(async () => app?.close());

    it('ready includes the contributor and turns 503 when it fails, without leaking its error', async () => {
      state.up = true;
      const ok = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);
      expect(ok.body.info).toHaveProperty('fake_dependency');
      state.up = false;
      const down = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(down.body.code).toBe('service_unavailable');
      expect(JSON.stringify(down.body)).not.toContain('fake dependency down');
      state.up = true;
    });
  });

  describe('contributor key validation', () => {
    it('rejects a contributor key that shadows a core check', async () => {
      await expect(
        createTestApp([...base(), ClashingModule], {
          beforeInit: applyHttpDefaults,
        }),
      ).rejects.toThrow(/readiness contributor key "database"/);
    });
  });
});
