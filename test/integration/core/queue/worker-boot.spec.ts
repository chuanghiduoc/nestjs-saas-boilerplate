import { afterAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../../../src/core/database/index.js';
import { QueueModule } from '../../../../src/core/queue/index.js';
import { RedisModule } from '../../../../src/core/redis/index.js';
import { RecordHandler } from '../../../fixtures/fixture.jobs.js';
import { createTestApp } from '../../../support/app-factory.js';

/** Chỉ một handler trong khi FixtureQueue có nhiều job. */
@Module({ providers: [RecordHandler] })
class PartialHandlers {}

describe('worker boot', () => {
  let app: INestApplication | undefined;
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('fails loud when a consumed queue has a job without @JobHandler', async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'fixture');
    await expect(
      createTestApp(
        [
          DatabaseModule.forRoot({ relay: true }),
          RedisModule,
          QueueModule.forRoot({ runWorkers: true }),
          PartialHandlers,
        ],
        {
          beforeInit: (a) => {
            app = a;
          },
        },
      ),
    ).rejects.toThrow(/no @JobHandler: .*fixture\.slow \(queue fixture\)/);
  });
});
