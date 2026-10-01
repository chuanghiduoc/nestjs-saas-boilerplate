import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import {
  defineConfig,
  markModuleLoaded,
} from '../../../../src/core/config/index.js';
import {
  JobHandler,
  MaintenanceQueue,
  defineJob,
  defineQueue,
} from '../../../../src/core/queue/index.js';
import { defineCron } from '../../../../src/core/scheduler/index.js';

/**
 * Module nền giả cho UP-12b (spec SP7 §19): có đủ mọi thứ mà "tắt module" phải gỡ — config bắt buộc, queue riêng có job,
 * cron tĩnh (job ở `maintenance` theo quy ước S7-D34) và một luật chéo module (đăng ký bởi composition fixture).
 */
markModuleLoaded('fixturemod');

export const fixturemodConfig = defineConfig(
  'fixturemod',
  { required: 'FIXTUREMOD_REQUIRED' },
  z.object({
    required: z
      .string()
      .min(1)
      .describe('Required env of the composition fixture module'),
  }),
);
export const FixturemodQueue = defineQueue('fixturemod', { kind: 'io' });
export const FixturemodWorkJob = defineJob({
  name: 'fixturemod.work',
  queue: FixturemodQueue,
  version: 1,
  schema: z.object({}),
});
export const FixturemodTickJob = defineJob({
  name: 'fixturemod.tick',
  queue: MaintenanceQueue,
  version: 1,
  schema: z.object({}),
});
defineCron({
  key: 'fixturemod.tick',
  job: FixturemodTickJob,
  payload: {},
  schedule: () => ({ cron: '0 0 1 1 *', tz: 'UTC' }),
});

@Injectable()
@JobHandler(FixturemodWorkJob)
class WorkHandler {
  handle(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@JobHandler(FixturemodTickJob)
class TickHandler {
  handle(): Promise<void> {
    return Promise.resolve();
  }
}

@Module({ providers: [WorkHandler, TickHandler] })
export class FixturemodModule {}
