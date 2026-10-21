import { afterEach, describe, expect, it, vi } from 'vitest';
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
  // Mỗi ca dựng một app: đóng app của ca trước, kể cả khi boot lỗi giữa chừng.
  afterEach(async () => {
    await app?.close();
    app = undefined;
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
  it('fails loud when both WORKER_QUEUES and WORKER_QUEUES_EXCLUDE are set', async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('WORKER_QUEUES', 'fixture');
    vi.stubEnv('WORKER_QUEUES_EXCLUDE', 'maintenance');
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
    ).rejects.toThrow(
      'WORKER_QUEUES and WORKER_QUEUES_EXCLUDE are mutually exclusive',
    );
  });
});
