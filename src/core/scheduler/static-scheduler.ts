import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { JobScheduler } from '../queue/index.js';
import { cronRegistry, retiredCrons, type CronDef } from './cron-definition.js';
import { ScheduleComputationError, minGapSec } from './schedule-validation.js';

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

  /**
   * Kiểm tra mọi cron TRƯỚC khi upsert cái nào (không để lại trạng thái nửa vời), bằng cùng helper
   * với lịch của tenant (`minGapSec`, xem `ScheduledTaskService`): BullMQ tính lần chạy kế bằng
   * cron-parser và NUỐT lỗi, nên cron không tính được quanh DST sẽ lặng lẽ không bao giờ chạy.
   */
  async sync(): Promise<{ upserted: string[]; removed: string[] }> {
    const planned = cronRegistry().map((c) => ({
      c,
      schedule: this.checked(c),
    }));
    const upserted: string[] = [];
    for (const { c, schedule } of planned) {
      const id = staticCronId(c.key);
      await this.scheduler.upsert(id, c.job, c.payload, schedule);
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

  private checked(c: CronDef): { cron: string; tz: string } {
    const schedule = c.schedule();
    try {
      minGapSec(schedule.cron, schedule.tz);
    } catch (err) {
      if (err instanceof ScheduleComputationError)
        throw new Error(
          `Static cron "${c.key}" (${schedule.cron} in ${schedule.tz}) cannot be computed around a daylight-saving change; BullMQ would silently never fire it. Change its cron or timezone config`,
          { cause: err },
        );
      throw err;
    }
    return schedule;
  }
}
