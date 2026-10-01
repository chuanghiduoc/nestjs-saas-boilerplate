import type { JobDef } from '../queue/index.js';

/** Thành phần của scheduler id BullMQ (`static-<key>`): không có `:`. */
const CRON_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export type CronDef = {
  key: string;
  job: JobDef;
  payload: unknown;
  schedule: () => { cron: string; tz: string };
};
const crons = new Map<string, CronDef>();
const retired = new Set<string>();

export function defineCron(def: CronDef): CronDef {
  if (!CRON_KEY_PATTERN.test(def.key))
    throw new Error(`Cron key "${def.key}" must match ${CRON_KEY_PATTERN}`);
  if (crons.has(def.key)) throw new Error(`Cron "${def.key}" already defined`);
  crons.set(def.key, def);
  return def;
}

/**
 * Đánh dấu một cron tĩnh đã bỏ để `StaticScheduler` xoá nó. Đây là cách DUY NHẤT xoá cron tĩnh:
 * không bao giờ xoá cron chỉ vì process hiện tại không khai báo (rolling deploy: bản mới có thể
 * đã khai báo cron mà bản cũ chưa biết).
 */
export function retireCron(key: string): void {
  if (crons.has(key))
    throw new Error(`Cron "${key}" is still defined; cannot retire it`);
  retired.add(key);
}

export const cronRegistry = (): CronDef[] => [...crons.values()];
export const retiredCrons = (): string[] => [...retired];
let disabledModules: ReadonlySet<string> = new Set();

/**
 * Composition ghi tập module bị tắt (spec SP7 §6.2 bước 5); `StaticScheduler.sync()` gỡ `static-<m>.*` của chúng
 * khỏi Redis. Thay toàn bộ tập mỗi lần gọi.
 */
export function setDisabledModuleKeys(keys: readonly string[]): void {
  disabledModules = new Set(keys);
}
export const disabledModuleKeys = (): ReadonlySet<string> => disabledModules;

/** Module chủ của khoá cron: phần trước dấu `.` đầu tiên (quy ước `<module>.<tên>`, giữ bằng test UP-12c). */
export const cronKeyModule = (key: string): string => {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
};
