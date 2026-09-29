import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseModule,
  Db,
  UnitOfWork,
} from '../../../../src/core/database/index.js';
import {
  DbKillSwitchProvider,
  FlagsModule,
  KillSwitches,
  NO_ROW_VERSION,
  defineKillSwitch,
  flagsConfig,
  type KillSwitchChange,
} from '../../../../src/core/flags/index.js';
import { createTestApp } from '../../../support/app-factory.js';
import { getInfra } from '../../../support/infra.js';

const PROBE = defineKillSwitch({
  key: 'fixture.flag_probe',
  description: 'integration probe',
});
const RACE = defineKillSwitch({
  key: 'fixture.flag_race',
  description: 'concurrent set probe',
});
const LISTED = defineKillSwitch({
  key: 'fixture.flag_listed',
  description: 'no row yet',
});
/** Khoảng làm mới nhỏ nhất hợp lệ, để ca lan truyền chạy nhanh. */
const INTERVAL_MS = 1000;
/** Tiêu chí 11 của spec: có hiệu lực trong `FLAGS_REFRESH_INTERVAL_MS + 1 s`. */
const PROPAGATION_SLACK_MS = 1000;
const RACERS = 20;
const ACTOR = 'test-actor';
/**
 * Một app Nest có `DatabaseModule` mỗi process tại một thời điểm (Global Constraints): `@mikro-orm/nestjs` ném
 * `ContextName 'app' already registered` với app thứ hai đang mở. Mỗi `describe` dưới đây mở đúng một app và đóng nó trong
 * `afterAll` trước khi `describe` sau bắt đầu (Vitest chạy các `describe` của một file nối tiếp, hook theo phạm vi).
 */
const imports = () => [DatabaseModule.forRoot({ relay: false }), FlagsModule];

describe('KillSwitches on two instances (spec SP6 §5.3, criterion 11, C-20, R6-20)', () => {
  let a: INestApplication;
  /**
   * Instance B mô hình pod thứ hai: `KillSwitches` riêng với `DbKillSwitchProvider` riêng — snapshot, timer làm mới và domain
   * OpenFeature riêng — chỉ dùng chung pool DB của A. Đúng phần tiêu chí 11 đòi: đổi ở A đi qua bảng `kill_switches` và tới
   * B ở lượt làm mới kế tiếp của chính B.
   */
  let b: KillSwitches;
  let owner: pg.Client;
  beforeAll(async () => {
    vi.stubEnv('FLAGS_REFRESH_INTERVAL_MS', String(INTERVAL_MS));
    a = await createTestApp(imports());
    b = new KillSwitches(
      new DbKillSwitchProvider(
        a.get(Db),
        flagsConfig.schema.parse({ refreshIntervalMs: INTERVAL_MS }),
      ),
      a.get(Db),
      a.get(UnitOfWork),
    );
    await b.onModuleInit();
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.query(
      `DELETE FROM kill_switches WHERE key LIKE 'fixture.flag_%'`,
    );
    await owner?.end();
    // B tắt như Nest tắt một app (hai pha, đúng thứ tự), trước khi pool của A đóng.
    await b?.beforeApplicationShutdown();
    await b?.onApplicationShutdown();
    await a?.close();
    vi.unstubAllEnvs();
  });
  const set = (change: KillSwitchChange) =>
    a.get(UnitOfWork).run(() => a.get(KillSwitches).set(change));
  const change = (
    key: string,
    killed: boolean,
    expectedVersion: number,
  ): KillSwitchChange => ({
    key,
    killed,
    reason: killed ? 'integration probe' : null,
    actor: ACTOR,
    expectedVersion,
  });

  it('a change on instance A is seen by instance B within FLAGS_REFRESH_INTERVAL_MS + 1 s', async () => {
    expect(await b.isKilled(PROBE.key)).toBe(false);
    expect(await set(change(PROBE.key, true, NO_ROW_VERSION))).toEqual({
      kind: 'APPLIED',
      version: 1,
    });
    const t = performance.now();
    await vi.waitFor(
      async () => expect(await b.isKilled(PROBE.key)).toBe(true),
      {
        timeout: INTERVAL_MS + PROPAGATION_SLACK_MS,
        interval: 50,
      },
    );
    expect(performance.now() - t).toBeLessThanOrEqual(
      INTERVAL_MS + PROPAGATION_SLACK_MS,
    );
  });
  it('an unregistered key is refused by isKilled and set', async () => {
    await expect(
      a.get(KillSwitches).isKilled('fixture.not_registered'),
    ).rejects.toThrow(/not a registered kill switch/);
    await expect(
      set(change('fixture.not_registered', false, NO_ROW_VERSION)),
    ).rejects.toThrow(/not a registered kill switch/);
  });
  it('set is a compare-and-set on version; it needs a transaction; the DB refuses a killed switch without reason', async () => {
    expect(await set(change(PROBE.key, false, 1))).toEqual({
      kind: 'APPLIED',
      version: 2,
    });
    expect(await set(change(PROBE.key, true, 1))).toEqual({
      kind: 'VERSION_MISMATCH',
    });
    expect(await set(change(PROBE.key, true, NO_ROW_VERSION))).toEqual({
      kind: 'VERSION_MISMATCH',
    });
    await expect(
      a.get(KillSwitches).set(change(PROBE.key, false, 2)),
    ).rejects.toThrow(/inside UnitOfWork\.run/);
    // Lỗi đi qua driver của MikroORM: khẳng định bằng tên constraint trong thông điệp của Postgres.
    await expect(
      set({ ...change(PROBE.key, true, 2), reason: null }),
    ).rejects.toThrow(/kill_switches_reason_required_ck/);
  });
  it('concurrent sets with the same expected version: exactly one applies (R6-20)', async () => {
    const race = (v: number) =>
      Promise.all(
        Array.from({ length: RACERS }, (_, i) =>
          set(change(RACE.key, i % 2 === 0, v)),
        ),
      );
    for (const v of [NO_ROW_VERSION, 1]) {
      const results = await race(v);
      expect(
        results.filter((r) => r.kind === 'APPLIED'),
        `expectedVersion ${v}`,
      ).toEqual([{ kind: 'APPLIED', version: v + 1 }]);
    }
  });
  it('list shows every registered switch; a switch without a row is not killed at version 0', async () => {
    const listed = await a.get(KillSwitches).list();
    expect(listed.find((s) => s.key === LISTED.key)).toEqual({
      key: LISTED.key,
      description: 'no row yet',
      killed: false,
      reason: null,
      changedBy: null,
      version: NO_ROW_VERSION,
      updatedAt: null,
    });
    expect(listed.find((s) => s.key === PROBE.key)).toMatchObject({
      changedBy: ACTOR,
      version: 2,
    });
    expect(listed.find((s) => s.key === PROBE.key)?.updatedAt).toBeInstanceOf(
      Date,
    );
  });
});

describe('KillSwitches across the shutdown hooks (R60-5, R60-6, Review Focus 5)', () => {
  beforeAll(() => {
    vi.stubEnv('FLAGS_REFRESH_INTERVAL_MS', String(INTERVAL_MS));
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('answers after its own beforeApplicationShutdown (other hooks may run later) and throws once the app is closed instead of answering false', async () => {
    // App của describe trước đã đóng ở `afterAll` của nó: đây là app `DatabaseModule` duy nhất đang mở.
    const c = await createTestApp(imports());
    const switches = c.get(KillSwitches);
    try {
      // Như một provider khác (WorkerHost, drain của api) chạy `beforeApplicationShutdown` SAU hook của FlagsModule: không
      // dựa vào thứ tự hook giữa module, nên gọi thẳng hook của KillSwitches trước rồi hỏi.
      await switches.beforeApplicationShutdown();
      expect(await switches.isKilled(PROBE.key)).toBe(false);
    } finally {
      await c.close();
    }
    await expect(switches.isKilled(PROBE.key)).rejects.toThrow(/not ready/);
  });
});
