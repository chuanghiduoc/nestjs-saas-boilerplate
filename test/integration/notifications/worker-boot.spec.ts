import { type INestApplication } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DatabaseModule } from '../../../src/core/database/index.js';
import { EventsModule } from '../../../src/core/events/index.js';
import { OutboxModule } from '../../../src/core/outbox/index.js';
import { QueueModule } from '../../../src/core/queue/index.js';
import { RedisModule } from '../../../src/core/redis/index.js';
import { ResilienceModule } from '../../../src/core/resilience/index.js';
import { NotificationsModule } from '../../../src/modules/notifications/index.js';
import { createTestApp } from '../../support/app-factory.js';

/**
 * Tách khỏi reconcile-purge.spec.ts: `@mikro-orm/nestjs` đăng ký `contextName` vào một registry cấp
 * process (`CONTEXT_NAMES`) ngay khi gọi `DatabaseModule.forRoot(...)`, trước cả `app.init()`. Gọi lần
 * hai với cùng contextName ('app') trong khi app khác của cùng file còn mở sẽ ném "ContextName 'app'
 * already registered", chứ không phải lỗi locale muốn kiểm. Cùng cách cô lập với
 * test/integration/core/queue/worker-boot.spec.ts.
 */
describe('notifications worker boot', () => {
  let app: INestApplication | undefined;
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('refuses to start when a template lacks the configured default locale', async () => {
    vi.stubEnv('APP_ROLE', 'worker');
    vi.stubEnv('NOTIFICATIONS_DEFAULT_LOCALE', 'vi');
    await expect(
      createTestApp(
        [
          DatabaseModule.forRoot({ relay: false }),
          RedisModule,
          QueueModule.forRoot({ runWorkers: false }),
          OutboxModule.forRoot({ relay: false }),
          EventsModule.forRoot({ worker: false }),
          ResilienceModule,
          NotificationsModule.forWorker(),
        ],
        {
          beforeInit: (a) => {
            app = a;
          },
        },
      ),
    ).rejects.toThrow(/missing templates for locale "vi"/);
  });
});
