import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server as NetServer } from 'node:net';
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
 *
 * Keep-alive: client giữ connection (service khác, gateway, sidecar) không đi qua readiness và
 * vẫn gửi trên socket cũ. `server.close()` chỉ đóng socket đang rảnh ngay lúc gọi (Node >= 19 tự
 * gọi `closeIdleConnections()`); socket đang có request thì phục vụ tiếp và được giữ tới
 * keepAliveTimeout, client bận thì không bao giờ rảnh → treo tới hạn chót cứng. Vì vậy từ lúc
 * draining mọi response mang `Connection: close`: client mở connection mới (tới pod khác) và
 * `close()` xong ngay khi request cuối trả về.
 */
@Injectable()
export class ShutdownCoordinator
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(ShutdownCoordinator.name);
  private server: NetServer | undefined;
  private readonly closeWhileDraining = (
    _req: IncomingMessage,
    res: ServerResponse,
  ): void => {
    if (this.draining.isDraining()) res.setHeader('Connection', 'close');
  };

  constructor(
    private readonly draining: Draining,
    private readonly adapterHost: HttpAdapterHost,
    @Inject(healthConfig.KEY)
    private readonly cfg: ConfigOf<typeof healthConfig>,
  ) {}

  onApplicationBootstrap(): void {
    // `getHttpServer()` trả `any`; http.Server và https.Server đều là net.Server phát 'request'.
    const server: unknown = this.adapterHost.httpAdapter.getHttpServer();
    if (!(server instanceof NetServer))
      throw new Error(
        'ShutdownCoordinator needs the Node HTTP server of the api (HealthModule.forRoot({ http: true }))',
      );
    // prepend: đặt header trước khi router của framework kịp gửi response.
    server.prependListener('request', this.closeWhileDraining);
    this.server = server;
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining.start();
    this.logger.log(
      { signal, drainDelayMs: this.cfg.drainDelayMs },
      'draining before shutdown',
    );
    await sleep(this.cfg.drainDelayMs);
  }

  onApplicationShutdown(): void {
    this.server?.removeListener('request', this.closeWhileDraining);
    this.server = undefined;
  }
}
