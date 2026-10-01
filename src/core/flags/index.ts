export { FlagsModule } from './flags.module.js';
export { flagsConfig } from './flags.config.js';
export {
  KILL_SWITCH_KEY,
  KILL_SWITCH_KEY_MAX_LENGTH,
  defineKillSwitch,
  findKillSwitch,
  killSwitchRegistry,
  type KillSwitchDef,
} from './kill-switch.js';
export { DbKillSwitchProvider } from './db-kill-switch.provider.js';
export {
  KillSwitches,
  NO_ROW_VERSION,
  type KillSwitchChange,
  type KillSwitchSetResult,
  type KillSwitchState,
} from './kill-switches.service.js';
