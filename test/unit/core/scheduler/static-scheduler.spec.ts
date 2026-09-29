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
  setDisabledModuleKeys,
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

/** Redis giả đã có sẵn các scheduler `ids` (từ lần chạy trước); ghi lại id được upsert và id bị gỡ. */
class ListingScheduler extends JobScheduler {
  readonly upserted: string[] = [];
  readonly removed: string[] = [];
  constructor(private readonly ids: string[]) {
    super();
  }
  async upsert(
    id: string,
    _job: JobDef,
    _payload: unknown,
    _pattern: SchedulePattern,
  ): Promise<void> {
    this.upserted.push(id);
  }
  async remove(id: string): Promise<void> {
    this.removed.push(id);
  }
  async listIds(): Promise<string[]> {
    return this.ids;
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

  describe('disabled modules (spec SP7 §6.2, C1, R7-17)', () => {
    afterEach(() => setDisabledModuleKeys([]));

    it('removes static-<m>.* of a disabled module and nothing else', async () => {
      schedule = { cron: '0 3 * * *', tz: 'UTC' };
      setDisabledModuleKeys(['fixturemod']);
      const s = new ListingScheduler([
        'static-fixturemod.tick',
        'static-fixturemodx.other',
        'static-identity.purge-expired',
        'static-core.outbox.cleanup',
      ]);
      const r = await new StaticScheduler(s, appConfig()).sync();
      expect(s.removed).toEqual(['static-fixturemod.tick']);
      expect(r.removed).toEqual(['static-fixturemod.tick']);
    });

    it('keeps every existing scheduler when no module is disabled', async () => {
      schedule = { cron: '0 3 * * *', tz: 'UTC' };
      const s = new ListingScheduler(['static-fixturemod.tick']);
      await new StaticScheduler(s, appConfig()).sync();
      expect(s.removed).toEqual([]);
    });

    it('fails before upserting anything when a disabled module still defines a cron', async () => {
      schedule = { cron: '0 3 * * *', tz: 'UTC' };
      // Mọi cron của file này có khoá `test.static.*`, tức thuộc "module" `test`.
      setDisabledModuleKeys(['test']);
      const s = new ListingScheduler([]);
      await expect(new StaticScheduler(s, appConfig()).sync()).rejects.toThrow(
        /"test\.static\.a-healthy".*belong to a disabled module/,
      );
      expect(s.upserted).toEqual([]);
    });
  });
});
