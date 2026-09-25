import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { JobScheduler } from '../queue/index.js';
import { cronRegistry, retiredCrons } from './cron-definition.js';

export const STATIC_PREFIX = 'static-';
export const staticCronId = (key: string) => `${STATIC_PREFIX}${key}`;

/**
 * Đồng bộ cron tĩnh (`defineCron`) lên BullMQ Job Schedulers lúc worker khởi động. Nhiều worker
 * sync song song an toàn: `upsert` idempotent theo id, và BullMQ sinh jobId cố định theo mốc
 * (`repeat:<id>:<millis>`) nên mỗi mốc chỉ có một job. Chỉ xoá cron đã `retireCron`.
 */
@Injectable()
export class StaticScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(StaticScheduler.name);

  constructor(
    private readonly scheduler: JobScheduler,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.app.role !== 'worker') return;
    this.logger.log(await this.sync(), 'static crons synced');
  }

  async sync(): Promise<{ upserted: string[]; removed: string[] }> {
    const upserted: string[] = [];
    for (const c of cronRegistry()) {
      const id = staticCronId(c.key);
      await this.scheduler.upsert(id, c.job, c.payload, c.schedule());
      upserted.push(id);
    }
    const existing = new Set(await this.scheduler.listIds(STATIC_PREFIX));
    const removed: string[] = [];
    for (const key of retiredCrons()) {
      const id = staticCronId(key);
      if (!existing.has(id)) continue;
      await this.scheduler.remove(id);
      removed.push(id);
    }
    return { upserted, removed };
  }
}
