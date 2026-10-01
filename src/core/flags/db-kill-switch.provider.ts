import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  StandardResolutionReasons,
  TypeMismatchError,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { Db } from '../database/index.js';
import { METER } from '../observability/queue-metrics.js';
import { flagsConfig } from './flags.config.js';
import { findKillSwitch } from './kill-switch.js';

const Rows = z.array(z.object({ key: z.string(), killed: z.boolean() }));
const MS_PER_SECOND = 1000;
const BOOLEAN_ONLY = 'kill switches are boolean flags';

/**
 * Provider OpenFeature đọc bảng `kill_switches` (spec SP6 §5.3, S6-A44): snapshot trong bộ nhớ, làm mới mỗi
 * `FLAGS_REFRESH_INTERVAL_MS` (timer `unref`, một lượt mỗi lúc). Đánh giá không I/O. Lần nạp đầu (`initialize`) phải thành
 * công: không có snapshot để giữ, nên app không khởi động thay vì coi mọi switch là "không tắt". Lỗi khi làm mới → giữ
 * snapshot cũ (fail-static) + `flags_refresh_failures_total`. Không có dòng cho key → `false`.
 */
@Injectable()
export class DbKillSwitchProvider implements Provider {
  readonly metadata = { name: 'core.db-kill-switches' };
  readonly runsOn = 'server';
  private readonly logger = new Logger(DbKillSwitchProvider.name);
  private readonly meter = metrics.getMeter(METER);
  private readonly refreshFailures = this.meter.createCounter(
    'flags_refresh_failures_total',
    {
      description:
        'Kill switch refreshes that failed; the last snapshot was kept (fail-static)',
    },
  );
  private readonly snapshotAge = this.meter.createObservableGauge(
    'flags_snapshot_age_seconds',
    {
      description: 'Age of the kill switch snapshot served by this process',
      unit: 's',
    },
  );
  private snapshot: ReadonlyMap<string, boolean> = new Map();
  private refreshedAt?: number;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<unknown>;
  private closed = false;
  private readonly unknownWarned = new Set<string>();

  constructor(
    private readonly db: Db,
    @Inject(flagsConfig.KEY)
    private readonly cfg: ConfigOf<typeof flagsConfig>,
  ) {}

  async initialize(): Promise<void> {
    await this.load();
    this.snapshotAge.addCallback(this.observeAge);
    this.schedule();
  }

  /**
   * Dừng làm mới: không lên lịch lượt mới, chờ lượt đang chạy (pool DB đóng sau đó). Snapshot giữ nguyên nên đánh giá vẫn trả
   * lời trạng thái cuối. Gọi lại được. `KillSwitches.beforeApplicationShutdown` gọi hàm này, không gọi `onClose`.
   */
  async stopRefreshing(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.inflight;
  }

  /** SDK gọi khi domain đổi sang provider khác (`KillSwitches.onApplicationShutdown`) hoặc `OpenFeature.close()`. */
  async onClose(): Promise<void> {
    await this.stopRefreshing();
    this.snapshotAge.removeCallback(this.observeAge);
  }

  /** Một lượt làm mới; lỗi giữ snapshot cũ. Trả kết quả để test không phải dựa vào timer. */
  refreshOnce(): Promise<'ok' | 'failed'> {
    const run = this.load().then(
      () => 'ok' as const,
      (err: unknown) => {
        this.refreshFailures.add(1);
        this.logger.warn(
          { event: 'kill_switch_refresh_failed', err },
          'kill switch refresh failed; keeping the last snapshot',
        );
        return 'failed' as const;
      },
    );
    this.inflight = run;
    return run;
  }

  resolveBooleanEvaluation(
    flagKey: string,
  ): Promise<ResolutionDetails<boolean>> {
    const killed = this.snapshot.get(flagKey);
    return Promise.resolve(
      killed === undefined
        ? { value: false, reason: StandardResolutionReasons.DEFAULT }
        : { value: killed, reason: StandardResolutionReasons.CACHED },
    );
  }
  resolveStringEvaluation(): Promise<ResolutionDetails<string>> {
    return Promise.reject(new TypeMismatchError(BOOLEAN_ONLY));
  }
  resolveNumberEvaluation(): Promise<ResolutionDetails<number>> {
    return Promise.reject(new TypeMismatchError(BOOLEAN_ONLY));
  }
  resolveObjectEvaluation<T extends JsonValue>(): Promise<
    ResolutionDetails<T>
  > {
    return Promise.reject(new TypeMismatchError(BOOLEAN_ONLY));
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.refreshOnce().finally(() => this.schedule());
    }, this.cfg.refreshIntervalMs);
    this.timer.unref();
  }

  private async load(): Promise<void> {
    const rows = Rows.parse(
      await this.db.execute('SELECT key, killed FROM kill_switches'),
    );
    const next = new Map<string, boolean>();
    for (const r of rows) {
      if (!findKillSwitch(r.key)) {
        this.warnUnknown(r.key);
        continue;
      }
      next.set(r.key, r.killed);
    }
    this.snapshot = next;
    this.refreshedAt = Date.now();
  }

  private warnUnknown(key: string): void {
    if (this.unknownWarned.has(key)) return;
    this.unknownWarned.add(key);
    this.logger.warn(
      { event: 'kill_switch_unknown_key', key },
      'kill_switches has a row for a switch this build does not define; ignored',
    );
  }

  private readonly observeAge = (result: ObservableResult): void => {
    if (this.refreshedAt !== undefined)
      result.observe((Date.now() - this.refreshedAt) / MS_PER_SECOND);
  };
}
