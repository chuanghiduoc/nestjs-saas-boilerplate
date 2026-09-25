import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ConfigOf } from '../config/index.js';
import { Draining } from './draining.js';
import { healthConfig } from './health.config.js';

/**
 * api: báo not-ready rồi chờ load balancer ngừng gửi request, trước khi Nest đóng HTTP server.
 * Nest chạy `onModuleDestroy` → `beforeApplicationShutdown` (hook này) → đóng HTTP server →
 * `onApplicationShutdown` (Redis, MikroORM, BullMQ queue đóng ở đây), nên trong lúc chờ HTTP, DB
 * và Redis vẫn phục vụ. Chỉ đăng ký ở api (`HealthModule.forRoot({ http: true })`): worker không có
 * load balancer, không trả khoản chờ này.
 */
@Injectable()
export class ShutdownCoordinator implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownCoordinator.name);
  constructor(
    private readonly draining: Draining,
    @Inject(healthConfig.KEY)
    private readonly cfg: ConfigOf<typeof healthConfig>,
  ) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining.start();
    this.logger.log(
      { signal, drainDelayMs: this.cfg.drainDelayMs },
      'draining before shutdown',
    );
    await sleep(this.cfg.drainDelayMs);
  }
}
