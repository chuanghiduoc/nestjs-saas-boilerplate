import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
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
 * Client blocking (Worker của BullMQ) bắt buộc `maxRetriesPerRequest: null` và không có commandTimeout.
 * Kiểu trả về hẹp (Pick) để gán được cho cả `RedisOptions` của ioredis lẫn `ConnectionOptions` của BullMQ.
 */
export function redisClientOptions(
  cfg: ConfigOf<typeof redisConfig>,
  blocking: boolean,
): Pick<RedisOptions, 'maxRetriesPerRequest' | 'commandTimeout'> {
  return {
    maxRetriesPerRequest: blocking ? null : cfg.maxRetriesPerRequest,
    commandTimeout: blocking ? undefined : cfg.commandTimeoutMs,
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
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
