import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv } from '../../support/app-factory.js';
import { bootstrapApi } from '../../../src/main.api.js';

// Worker boot is covered in entrypoints-worker.e2e.spec.ts, in its own file/process.
// `@mikro-orm/nestjs` tracks registered MikroORM context names in a single
// process-wide array; DatabaseModule.forRoot() registers the 'app' context as
// a side effect of evaluating the @Module({ imports: [...] }) decorator, i.e.
// at import time, before any test runs. Importing both app-api.module.ts and
// app-worker.module.ts into the same file/process therefore always throws
// "ContextName 'app' already registered", regardless of test ordering. In
// production api and worker are always separate OS processes (dist/main.api.js
// vs dist/main.worker.js), so this collision never happens there — it is
// purely a same-process-test artifact, which is why the two entrypoints must
// stay in separate spec files here (vitest gives each spec file its own
// isolated module registry).
describe('entrypoints', () => {
  applyTestEnv();
  afterAll(() => vi.unstubAllEnvs());

  it('api boots with core modules and serves 404 as problem+json', async () => {
    const app = await bootstrapApi({ listen: false });
    const res = await request(app.getHttpServer()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    await app.close();
  });

  it('fails fast listing every missing required variable', async () => {
    vi.stubEnv('DB_APP_PASSWORD', '');
    vi.stubEnv('DB_NAME', '');
    await expect(bootstrapApi({ listen: false })).rejects.toThrow(
      /DB_APP_PASSWORD[\s\S]*DB_NAME|DB_NAME[\s\S]*DB_APP_PASSWORD/,
    );
    applyTestEnv();
  });
});
