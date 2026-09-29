import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { type ConfigOf } from '../config/index.js';
import { REDIS, REDIS_NAMESPACE, RedisModule } from '../redis/index.js';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { BodyParserPolicy } from './body-parser-policy.js';
import { ContentTypeMiddleware } from './content-type.middleware.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { Paginator } from './pagination.js';
import { PreAuthRateLimiter } from './pre-auth-rate-limiter.js';
import { RateLimitBuckets } from './rate-limit-buckets.js';
import { RateLimiterThrottlerStorage } from './rate-limiter.storage.js';
import { throttleConfig } from './throttle.config.js';

/** Route wildcard toàn cục theo cú pháp path-to-regexp 8 (Nest 11+). */
const ALL_ROUTES = '{*path}';

/** Rate limit và idempotency dùng client `REDIS` dùng chung của RedisModule (global). */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [throttleConfig.KEY, REDIS, REDIS_NAMESPACE],
      useFactory: (
        cfg: ConfigOf<typeof throttleConfig>,
        redis: Redis,
        namespace: string,
      ) => ({
        throttlers: [{ limit: cfg.limit, ttl: cfg.ttlMs }],
        storage: new RateLimiterThrottlerStorage(redis, namespace),
      }),
    }),
  ],
  providers: [
    BodyParserPolicy,
    Paginator,
    ContentTypeMiddleware,
    IdempotencyInterceptor,
    RateLimitBuckets,
    PreAuthRateLimiter,
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
  exports: [
    BodyParserPolicy,
    Paginator,
    IdempotencyInterceptor,
    RateLimitBuckets,
    PreAuthRateLimiter,
  ],
})
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContentTypeMiddleware).forRoutes(ALL_ROUTES);
  }
}
