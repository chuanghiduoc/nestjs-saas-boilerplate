import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type ConfigOf } from '../../../core/config/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { identityGuardConfig } from '../identity.config.js';
import { PurgeExpiredJob } from '../jobs.js';
import {
  AUTH_PURGE_TARGETS,
  AuthHousekeeping,
} from '../ports/auth-housekeeping.js';

@Injectable()
@JobHandler(PurgeExpiredJob)
export class PurgeExpiredHandler {
  private readonly logger = new Logger(PurgeExpiredHandler.name);

  constructor(
    @Inject(identityGuardConfig.KEY)
    private readonly cfg: ConfigOf<typeof identityGuardConfig>,
    @Optional() private readonly housekeeping?: AuthHousekeeping,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    if (!this.housekeeping) {
      this.logger.debug(
        'Expired auth purge skipped: auth providers unavailable',
      );
      return deleted;
    }
    for (const target of AUTH_PURGE_TARGETS) {
      deleted[target] = 0;
      for (let i = 0; i < this.cfg.purgeMaxBatches; i++) {
        ctx.signal.throwIfAborted();
        const n = await this.housekeeping.purgeExpired(
          target,
          this.cfg.purgeBatchSize,
        );
        deleted[target] += n;
        if (n < this.cfg.purgeBatchSize) break;
      }
    }
    this.logger.log(deleted, 'expired auth data purged');
    return deleted;
  }
}
