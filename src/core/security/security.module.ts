import { Global, Module } from '@nestjs/common';
import { type ConfigOf } from '../config/index.js';
import { FieldCipher } from './field-cipher.js';
import { securityConfig } from './security.config.js';

/** Keyring đã được validate ở config; constructor kiểm tra lại độ dài key nên sai key là lỗi lúc boot. */
@Global()
@Module({
  providers: [
    {
      provide: FieldCipher,
      inject: [securityConfig.KEY],
      useFactory: (cfg: ConfigOf<typeof securityConfig>) =>
        new FieldCipher(cfg.keys, cfg.activeKid),
    },
  ],
  exports: [FieldCipher],
})
export class SecurityModule {}
