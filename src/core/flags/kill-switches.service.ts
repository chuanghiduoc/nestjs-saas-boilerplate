import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  NOOP_PROVIDER,
  OpenFeature,
  ProviderStatus,
  type Client,
  type Logger as OpenFeatureLogger,
} from '@openfeature/server-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Db, UnitOfWork } from '../database/index.js';
import { DbKillSwitchProvider } from './db-kill-switch.provider.js';
import {
  findKillSwitch,
  killSwitchRegistry,
  type KillSwitchDef,
} from './kill-switch.js';

/** `expectedVersion` cho switch chưa có dòng: `kill_switches.version` luôn ≥ 1 (CHECK), nên 0 không va chạm. */
export const NO_ROW_VERSION = 0;

export type KillSwitchChange = {
  key: string;
  killed: boolean;
  /** Bắt buộc khi `killed` (CHECK của DB); đã trim, 1..500 ký tự. */
  reason: string | null;
  /** `principal.id` của người đổi (snapshot `changed_by`). */
  actor: string;
  /** Version đang thấy (`If-Match` của 6D); `NO_ROW_VERSION` khi chưa có dòng. */
  expectedVersion: number;
};
export type KillSwitchSetResult =
  { kind: 'APPLIED'; version: number } | { kind: 'VERSION_MISMATCH' };
export type KillSwitchState = {
  key: string;
  description: string;
  killed: boolean;
  reason: string | null;
  changedBy: string | null;
  version: number;
  updatedAt: Date | null;
};

const StateRows = z.array(
  z.object({
    key: z.string(),
    killed: z.boolean(),
    reason: z.string().nullable(),
    changed_by: z.string(),
    version: z.number().int(),
    updated_at: z.coerce.date(),
  }),
);
const VersionRows = z.array(z.object({ version: z.number().int() }));

const sdkLog = new Logger('OpenFeature');
/** Log của SDK đi qua pino (không `console`): smoke đòi mọi dòng log là JSON. */
const openFeatureLogger: OpenFeatureLogger = {
  error: (...args: unknown[]) =>
    sdkLog.error({
      event: 'openfeature_error',
      detail: args.map(String).join(' '),
    }),
  warn: (...args: unknown[]) =>
    sdkLog.warn({
      event: 'openfeature_warn',
      detail: args.map(String).join(' '),
    }),
  info: (...args: unknown[]) =>
    sdkLog.log({
      event: 'openfeature_info',
      detail: args.map(String).join(' '),
    }),
  debug: (...args: unknown[]) =>
    sdkLog.debug({
      event: 'openfeature_debug',
      detail: args.map(String).join(' '),
    }),
};

/**
 * Cửa duy nhất tới kill switch (luật kiến trúc 22: module không import OpenFeature). Mỗi instance một domain OpenFeature
 * (API OpenFeature là singleton; test dựng nhiều app nối tiếp và instance thứ hai bằng tay trong một process). Provider sẵn sàng trong `onModuleInit`, trước
 * mọi `onApplicationBootstrap` (WorkerHost bắt đầu nhận job ở đó).
 */
@Injectable()
export class KillSwitches
  implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly domain = `core.flags.${randomUUID()}`;
  private client?: Client;

  constructor(
    private readonly provider: DbKillSwitchProvider,
    private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async onModuleInit(): Promise<void> {
    OpenFeature.setLogger(openFeatureLogger);
    await OpenFeature.setProviderAndWait(this.domain, this.provider);
    this.client = OpenFeature.getClient(this.domain);
  }

  /**
   * Trước `onApplicationShutdown` (pool DB đóng ở đó): chỉ dừng timer và chờ lượt làm mới đang chạy (R60-5). Client và
   * snapshot GIỮ NGUYÊN: `WorkerHost.closeAll()` và độ trễ drain của api cũng chạy ở pha `beforeApplicationShutdown`, và thứ tự
   * giữa các module ở pha này không được dựa vào (hôm nay `FlagsModule` `@Global` chạy sau cùng; composition 7A hay một
   * `FlagsModule` không global sẽ đổi thứ tự) — job/request còn dở vẫn hỏi `isKilled` được và nhận trạng thái cuối.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.provider.stopRefreshing();
  }

  /**
   * Sau mọi `beforeApplicationShutdown` của app: từ đây `isKilled` ném (R60-6). Thay domain bằng `NOOP_PROVIDER`: SDK gọi
   * `onClose` của provider cũ đúng một lần (hợp đồng P3, Task 2); `onClose` không chạm DB nên thứ tự với pool không quan trọng.
   */
  async onApplicationShutdown(): Promise<void> {
    this.client = undefined;
    await OpenFeature.setProviderAndWait(this.domain, NOOP_PROVIDER);
  }

  async isKilled(key: string): Promise<boolean> {
    this.registered(key);
    const client = this.client;
    // Không trả mặc định `false` khi provider chưa/không còn sẵn sàng: đó là "không tắt" âm thầm (Review Focus 5).
    if (!client || client.providerStatus !== ProviderStatus.READY)
      throw new Error(`Kill switch provider is not ready (asked for "${key}")`);
    return client.getBooleanValue(key, false);
  }

  /** Mọi switch đã khai, kèm trạng thái DB (không có dòng → `killed: false`, `version: NO_ROW_VERSION`). */
  async list(): Promise<KillSwitchState[]> {
    const rows = StateRows.parse(
      await this.db.execute(
        'SELECT key, killed, reason, changed_by, version, updated_at FROM kill_switches',
      ),
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return killSwitchRegistry().map((d) => {
      const r = byKey.get(d.key);
      return r
        ? {
            key: d.key,
            description: d.description,
            killed: r.killed,
            reason: r.reason,
            changedBy: r.changed_by,
            version: r.version,
            updatedAt: r.updated_at,
          }
        : {
            key: d.key,
            description: d.description,
            killed: false,
            reason: null,
            changedBy: null,
            version: NO_ROW_VERSION,
            updatedAt: null,
          };
    });
  }

  /**
   * Ghi trong transaction của caller (6D phát event `admin.kill_switch.changed` cùng transaction). CAS theo version (R6-20):
   * hai lần đổi đồng thời cùng `expectedVersion` → đúng một `APPLIED`. Có hiệu lực ở mọi process sau lượt làm mới kế tiếp.
   */
  async set(c: KillSwitchChange): Promise<KillSwitchSetResult> {
    this.registered(c.key);
    if (!this.uow.inTransaction())
      throw new Error('KillSwitches.set must run inside UnitOfWork.run');
    if (
      !Number.isSafeInteger(c.expectedVersion) ||
      c.expectedVersion < NO_ROW_VERSION
    )
      throw new Error(
        `expectedVersion must be a non-negative integer, got ${c.expectedVersion}`,
      );
    const rows =
      c.expectedVersion === NO_ROW_VERSION
        ? await this.db.execute(
            `INSERT INTO kill_switches (key, killed, reason, changed_by) VALUES (?, ?, ?, ?)
             ON CONFLICT (key) DO NOTHING RETURNING version`,
            [c.key, c.killed, c.reason, c.actor],
          )
        : await this.db.execute(
            `UPDATE kill_switches SET killed = ?, reason = ?, changed_by = ?, version = version + 1, updated_at = now()
             WHERE key = ? AND version = ? RETURNING version`,
            [c.killed, c.reason, c.actor, c.key, c.expectedVersion],
          );
    const [row] = VersionRows.parse(rows);
    return row
      ? { kind: 'APPLIED', version: row.version }
      : { kind: 'VERSION_MISMATCH' };
  }

  private registered(key: string): KillSwitchDef {
    const def = findKillSwitch(key);
    if (!def)
      throw new Error(
        `"${key}" is not a registered kill switch (defineKillSwitch)`,
      );
    return def;
  }
}
