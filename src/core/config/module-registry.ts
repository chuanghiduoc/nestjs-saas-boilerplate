/** Khoá module: cùng dạng tiền tố khoá cron (`<module>.<tên>`), không có `.`. */
const MODULE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const loaded = new Set<string>();

/**
 * Ghi rằng module nền `key` đã được import trong process này (spec SP7 §6.2 bước 4, C1). Dòng đầu của mỗi
 * `src/modules/<m>/index.ts` gọi hàm này: import một module là đăng ký config, luật config, queue, job, cron của nó,
 * nên composition so tập này với tập module đang bật để bắt module bị tắt mà vẫn bị import.
 */
export function markModuleLoaded(key: string): void {
  if (!MODULE_KEY_PATTERN.test(key))
    throw new Error(`Module key "${key}" must match ${MODULE_KEY_PATTERN}`);
  loaded.add(key);
}

/**
 * Tập module đã import (bản sao). Sau `composeAppModules`, bằng đúng tập module đang bật: module khác dùng nó để biết
 * một module có bật hay không mà KHÔNG import module đó (R-X13, SP6 `FileStorageLimitCheck`).
 */
export const loadedModules = (): ReadonlySet<string> => new Set(loaded);
