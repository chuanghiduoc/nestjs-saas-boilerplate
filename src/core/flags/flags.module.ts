import { Global, Module } from '@nestjs/common';
import { DbKillSwitchProvider } from './db-kill-switch.provider.js';
import './flags.config.js';
import { KillSwitches } from './kill-switches.service.js';

/** api + worker (spec SP6 §5.3): mọi module đọc kill switch qua `KillSwitches`. */
@Global()
@Module({
  providers: [DbKillSwitchProvider, KillSwitches],
  exports: [KillSwitches],
})
export class FlagsModule {}
