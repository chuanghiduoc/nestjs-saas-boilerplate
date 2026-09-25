import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { type ConfigOf, appConfig } from '../config/index.js';
import { redisConfig } from './redis.config.js';

/** Client ioredis dùng chung cho lệnh thường (rate limit, idempotency...). BullMQ tự tạo connection riêng. */
export const REDIS = Symbol('core.redis');
export const REDIS_NAMESPACE = Symbol('core.redisNamespace');
/** Kiểu của client `REDIS`, để module ngoài core/redis inject mà không import thẳng `ioredis`. */
export type RedisClient = Redis;

/** Dùng `-` (không dùng `:`) vì BullMQ không cho `:` trong prefix/jobId. Mọi consumer Redis thêm namespace này làm prefix. */
export const redisNamespace = (
  cfg: ConfigOf<typeof redisConfig>,
  app: ConfigOf<typeof appConfig>,
): string => `${cfg.keyPrefix}-${app.nodeEnv}`;

/**
 * Option theo loại client (cố định, không phải tunable):
 * - Blocking (Worker của BullMQ): bắt buộc `maxRetriesPerRequest: null`, không commandTimeout, giữ
 *   offline queue và resend mặc định của ioredis để lệnh chờ job sống qua lúc kết nối lại.
 * - Không blocking (client `REDIS` dùng chung, `Queue` producer của BullMQ): fail fast khi mất kết nối.
 *   ioredis giữ lệnh trong offline queue (và lệnh đang bay trong `prevCommandQueue`) kể cả khi
 *   `commandTimeout` đã reject promise, rồi vẫn gửi lên Redis sau khi kết nối lại. Caller đã nhận lỗi
 *   nhưng lệnh vẫn chạy: khoá idempotency mồ côi (retry cùng key bị 409 tới hết
 *   IDEMPOTENCY_LOCK_TTL_SEC), đếm rate limit thừa. Nên tắt `enableOfflineQueue` và
 *   `autoResendUnfulfilledCommands` (ADR 0007).
 * Kiểu trả về hẹp (Pick) để gán được cho cả `RedisOptions` của ioredis lẫn `ConnectionOptions` của BullMQ.
 */
export function redisClientOptions(
  cfg: ConfigOf<typeof redisConfig>,
  blocking: boolean,
): Pick<
  RedisOptions,
  | 'maxRetriesPerRequest'
  | 'commandTimeout'
  | 'enableOfflineQueue'
  | 'autoResendUnfulfilledCommands'
> {
  return {
    maxRetriesPerRequest: blocking ? null : cfg.maxRetriesPerRequest,
    commandTimeout: blocking ? undefined : cfg.commandTimeoutMs,
    enableOfflineQueue: blocking,
    autoResendUnfulfilledCommands: blocking,
  };
}

const logger = new Logger('Redis');

function createRedis(cfg: ConfigOf<typeof redisConfig>): Redis {
  const client = new Redis(cfg.url, redisClientOptions(cfg, false));
  // Không có listener thì ioredis in "Unhandled error event" ra console, ngoài pino.
  client.on('error', (err: Error) =>
    logger.error({ err }, 'redis connection error'),
  );
  return client;
}

@Global()
@Module({
  providers: [
    { provide: REDIS, inject: [redisConfig.KEY], useFactory: createRedis },
    {
      provide: REDIS_NAMESPACE,
      inject: [redisConfig.KEY, appConfig.KEY],
      useFactory: redisNamespace,
    },
  ],
  exports: [REDIS, REDIS_NAMESPACE],
})
export class RedisModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(redisConfig.KEY)
    private readonly cfg: ConfigOf<typeof redisConfig>,
  ) {}

  /**
   * Client không có offline queue nên lệnh gửi trước lần `ready` đầu tiên bị từ chối ngay. Chờ kết nối
   * đầu tiên, tối đa REDIS_COMMAND_TIMEOUT_MS (đúng thời gian một lệnh xếp hàng từng được chờ), để
   * request đầu tiên sau khi app listen không rơi vào 503/insurance vô cớ. Hết hạn thì chỉ cảnh báo và
   * khởi động tiếp ở chế độ suy giảm: api không phụ thuộc Redis để chạy (ruling R21).
   */
  async onModuleInit(): Promise<void> {
    if (this.redis.status === 'ready') return;
    const ready = await new Promise<boolean>((resolve) => {
      const onReady = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.redis.off('ready', onReady);
        resolve(false);
      }, this.cfg.commandTimeoutMs);
      this.redis.once('ready', onReady);
    });
    if (!ready)
      logger.warn(
        { waitedMs: this.cfg.commandTimeoutMs, status: this.redis.status },
        'redis not ready at startup; continuing degraded until it connects',
      );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
