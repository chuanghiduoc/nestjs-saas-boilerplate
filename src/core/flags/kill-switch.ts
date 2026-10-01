/** Cùng luật với `kill_switches_key_ck` của migration (spec SP6 §6.2); test khoá hai phía. */
export const KILL_SWITCH_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const KILL_SWITCH_KEY_MAX_LENGTH = 100;

export type KillSwitchDef = {
  readonly key: string;
  readonly description: string;
};

const switches = new Map<string, KillSwitchDef>();

/**
 * Registry lúc import (mẫu `defineJob`): module khai switch của mình (6A `files.uploads`, 6C `integrations.webhook_delivery`).
 * `KillSwitches.isKilled` chỉ nhận key đã khai; dòng DB của key không còn trong code bị provider bỏ qua (WARN một lần).
 */
export function defineKillSwitch(def: {
  key: string;
  description: string;
}): KillSwitchDef {
  if (
    !KILL_SWITCH_KEY.test(def.key) ||
    def.key.length > KILL_SWITCH_KEY_MAX_LENGTH
  )
    throw new Error(
      `Kill switch key "${def.key}" must match ${KILL_SWITCH_KEY} and be at most ${KILL_SWITCH_KEY_MAX_LENGTH} characters`,
    );
  if (def.description.trim() === '')
    throw new Error(`Kill switch "${def.key}" needs a description`);
  if (switches.has(def.key))
    throw new Error(`Kill switch "${def.key}" already defined`);
  const full: KillSwitchDef = { key: def.key, description: def.description };
  switches.set(def.key, full);
  return full;
}

export const killSwitchRegistry = (): KillSwitchDef[] => [...switches.values()];
export const findKillSwitch = (key: string): KillSwitchDef | undefined =>
  switches.get(key);
