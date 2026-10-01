import { Logger } from '@nestjs/common';
import { TypeMismatchError } from '@openfeature/server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../../src/core/database/index.js';
import {
  DbKillSwitchProvider,
  defineKillSwitch,
  flagsConfig,
} from '../../../../src/core/flags/index.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

/** Trước khi provider nào được tạo: counter gắn với MeterProvider đặt lúc tạo. */
const otel = installOtelCapture();
const A = defineKillSwitch({ key: 'unit.flag_a', description: 'probe A' });
const INTERVAL_MS = 1000;
/** Số lượt làm mới đợi thêm sau khi đóng để chắc không còn truy vấn nào. */
const AFTER_CLOSE_INTERVALS = 5;
type Row = { key: string; killed: boolean };

function fakeDb() {
  const state: { rows: Row[]; fail: boolean; gate?: Promise<void> } = {
    rows: [],
    fail: false,
  };
  const execute = vi.fn(async () => {
    if (state.gate) await state.gate;
    if (state.fail) throw new Error('db down');
    return state.rows;
  });
  return { db: { execute } as Pick<Db, 'execute'> as Db, execute, state };
}
const make = (db: Db) =>
  new DbKillSwitchProvider(
    db,
    flagsConfig.schema.parse({ refreshIntervalMs: INTERVAL_MS }),
  );
const valueOf = async (p: DbKillSwitchProvider, key: string) =>
  (await p.resolveBooleanEvaluation(key)).value;
const unknownWarns = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    ([o]) =>
      typeof o === 'object' &&
      o !== null &&
      'event' in o &&
      o.event === 'kill_switch_unknown_key',
  );

describe('DbKillSwitchProvider (spec SP6 §5.3 core/flags, C-20)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('initialize fails loud when the first load fails, and schedules nothing (Review Focus 5)', async () => {
    vi.useFakeTimers();
    const f = fakeDb();
    f.state.fail = true;
    await expect(make(f.db).initialize()).rejects.toThrow('db down');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a registered switch reads its row; a registered switch without a row is false', async () => {
    const f = fakeDb();
    f.state.rows = [{ key: A.key, killed: true }];
    const p = make(f.db);
    await p.initialize();
    expect(await valueOf(p, A.key)).toBe(true);
    f.state.rows = [];
    expect(await p.refreshOnce()).toBe('ok');
    expect(await valueOf(p, A.key)).toBe(false);
    await p.onClose();
  });
  it('a failed refresh keeps the last snapshot (fail-static) and counts the failure', async () => {
    const f = fakeDb();
    f.state.rows = [{ key: A.key, killed: true }];
    const p = make(f.db);
    await p.initialize();
    const before = (await otel.metric('flags_refresh_failures_total')) ?? 0;
    f.state.fail = true;
    expect(await p.refreshOnce()).toBe('failed');
    expect(await valueOf(p, A.key)).toBe(true);
    expect(await otel.metric('flags_refresh_failures_total')).toBe(before + 1);
    await p.onClose();
  });
  it('rows of switches no longer in code are ignored with one WARN per key per process', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const f = fakeDb();
    f.state.rows = [{ key: 'unit.gone_switch', killed: true }];
    const p = make(f.db);
    await p.initialize();
    await p.refreshOnce();
    await p.refreshOnce();
    expect(await valueOf(p, 'unit.gone_switch')).toBe(false);
    expect(unknownWarns(warn)).toHaveLength(1);
    await p.onClose();
  });
  it('refreshes on its interval and stops for good on close: no timer, no query after close', async () => {
    vi.useFakeTimers();
    const f = fakeDb();
    const p = make(f.db);
    await p.initialize();
    expect(f.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(f.execute).toHaveBeenCalledTimes(2);
    await p.onClose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * AFTER_CLOSE_INTERVALS);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it('stopRefreshing stops the timer and keeps answering from the snapshot (shutdown hooks of other modules may still ask, R60-5)', async () => {
    vi.useFakeTimers();
    const f = fakeDb();
    f.state.rows = [{ key: A.key, killed: true }];
    const p = make(f.db);
    await p.initialize();
    await p.stopRefreshing();
    await p.stopRefreshing();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * AFTER_CLOSE_INTERVALS);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await valueOf(p, A.key)).toBe(true);
    await p.onClose();
  });
  it('close waits for the refresh in flight (the pool closes after it)', async () => {
    const f = fakeDb();
    const p = make(f.db);
    await p.initialize();
    let open!: () => void;
    f.state.gate = new Promise<void>((r) => (open = r));
    const refreshing = p.refreshOnce();
    let closed = false;
    const closing = p.onClose().then(() => {
      closed = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(false);
    open();
    await refreshing;
    await closing;
    expect(closed).toBe(true);
  });
  it('non-boolean evaluations are a type mismatch', async () => {
    const p = make(fakeDb().db);
    await expect(p.resolveStringEvaluation()).rejects.toBeInstanceOf(
      TypeMismatchError,
    );
    await expect(p.resolveNumberEvaluation()).rejects.toBeInstanceOf(
      TypeMismatchError,
    );
    await expect(p.resolveObjectEvaluation()).rejects.toBeInstanceOf(
      TypeMismatchError,
    );
  });
});
