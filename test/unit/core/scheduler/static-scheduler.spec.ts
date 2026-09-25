import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { appConfig } from '../../../../src/core/config/index.js';
import {
  JobScheduler,
  defineJob,
  defineQueue,
  type JobDef,
  type SchedulePattern,
} from '../../../../src/core/queue/index.js';
import {
  StaticScheduler,
  defineCron,
} from '../../../../src/core/scheduler/index.js';

class RecordingScheduler extends JobScheduler {
  readonly upserted: string[] = [];
  async upsert(
    id: string,
    _job: JobDef,
    _payload: unknown,
    _pattern: SchedulePattern,
  ): Promise<void> {
    this.upserted.push(id);
  }
  async remove(): Promise<void> {}
  async listIds(): Promise<string[]> {
    return [];
  }
  async get(): Promise<undefined> {
    return undefined;
  }
}

const Q = defineQueue('test-static-cron', { kind: 'io' });
const Tick = defineJob({
  name: 'test.static.tick',
  queue: Q,
  version: 1,
  schema: z.object({}),
});
let schedule: SchedulePattern = { cron: '0 3 * * *', tz: 'UTC' };
defineCron({
  key: 'test.static.a-healthy',
  job: Tick,
  payload: {},
  schedule: () => ({ cron: '0 3 * * *', tz: 'UTC' }),
});
defineCron({
  key: 'test.static.b-configurable',
  job: Tick,
  payload: {},
  schedule: () => schedule,
});

describe('StaticScheduler.sync', () => {
  beforeEach(() => vi.stubEnv('APP_ROLE', 'worker'));
  afterEach(() => vi.unstubAllEnvs());

  it('upserts crons whose runs cron-parser can compute', async () => {
    schedule = { cron: '0 3 * * *', tz: 'Asia/Ho_Chi_Minh' };
    const s = new RecordingScheduler();
    await new StaticScheduler(s, appConfig()).sync();
    expect(s.upserted).toEqual(
      expect.arrayContaining([
        'static-test.static.a-healthy',
        'static-test.static.b-configurable',
      ]),
    );
  });

  it('fails boot, before upserting anything, on a cron BullMQ would silently never fire around DST', async () => {
    // cron-parser (và BullMQ, nuốt lỗi) không tính được lần chạy quanh DST của Pacific/Chatham.
    schedule = { cron: '0 * * * *', tz: 'Pacific/Chatham' };
    const s = new RecordingScheduler();
    await expect(new StaticScheduler(s, appConfig()).sync()).rejects.toThrow(
      /Static cron "test\.static\.b-configurable" \(0 \* \* \* \* in Pacific\/Chatham\)/,
    );
    expect(s.upserted).toEqual([]);
  });
});
