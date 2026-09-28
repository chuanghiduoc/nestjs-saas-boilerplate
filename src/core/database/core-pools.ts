import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import type { PoolCheckouts } from './pool-checkouts.js';

/** Các pool core (app, relay) của MỘT app Nest, để tắt máy và test đọc được checkout đang mượn. */
export class CorePools {
  private readonly watched: PoolCheckouts[] = [];

  add(checkouts: PoolCheckouts): void {
    this.watched.push(checkouts);
  }

  /** Số client đang được mượn trên mọi pool core. */
  checkedOut(): number {
    return this.watched.reduce((n, c) => n + c.size, 0);
  }

  releaseAll(reason: string): number {
    return this.watched.reduce((n, c) => n + c.releaseAll(reason), 0);
  }
}

/**
 * Mốc (tính từ `onModuleDestroy`) mà một checkout còn được mượn là đã bị bỏ rơi: sau phần drain xấu nhất, trước phần dự
 * trữ `APP_SHUTDOWN_RESERVE_MS` (xem `CorePoolShutdown`). Dùng chung với pool `auth_user` của identity.
 */
export function abandonedCheckoutDelayMs(
  app: ConfigOf<typeof appConfig>,
): number {
  return Math.max(0, app.shutdownTimeoutMs - app.shutdownReserveMs);
}

/**
 * S2-R70 M3: `pool.end()` (MikroORM `close()` ở `onApplicationShutdown`) chờ MỌI client đang được mượn được trả. Một
 * checkout bị bỏ rơi (kysely không trả slot khi BEGIN/ROLLBACK quá hạn trên mạng blackhole; bộ thu hồi của api chỉ chạy
 * sau `HTTP_REQUEST_BUDGET_MS`, còn worker không có) làm tắt máy vượt `APP_SHUTDOWN_TIMEOUT_MS` và thoát 1.
 *
 * Luật cấu hình `APP_SHUTDOWN_TIMEOUT_MS` đã chừa `APP_SHUTDOWN_RESERVE_MS` SAU phần drain xấu nhất (relay, queue ở worker;
 * drain delay ở api) cho việc đóng HTTP, DB, Redis và flush telemetry. Nên từ lúc tắt máy bắt đầu (`onModuleDestroy`, hook
 * đầu tiên Nest gọi, trước mọi drain), hết `APP_SHUTDOWN_TIMEOUT_MS - APP_SHUTDOWN_RESERVE_MS` mà client nào còn được mượn
 * thì nó đã bị bỏ rơi: trả về pool kèm lỗi (pg-pool huỷ client), để `pool.end()` xong trong phần dự trữ.
 */
@Injectable()
export class CorePoolShutdown implements OnModuleDestroy {
  private readonly logger = new Logger(CorePoolShutdown.name);

  constructor(
    private readonly pools: CorePools,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
  ) {}

  onModuleDestroy(): void {
    const afterMs = abandonedCheckoutDelayMs(this.app);
    const timer = setTimeout(() => {
      const released = this.pools.releaseAll(
        `still checked out ${afterMs} ms into shutdown`,
      );
      if (released > 0)
        this.logger.warn(
          {
            event: 'db_pool_checkouts_released_at_shutdown',
            released,
            afterMs,
          },
          'core pool connections still checked out after the shutdown drain; destroyed so the pools can close',
        );
    }, afterMs);
    // Không giữ process sống: nếu mọi thứ đã đóng thì không còn gì để trả.
    timer.unref();
  }
}
