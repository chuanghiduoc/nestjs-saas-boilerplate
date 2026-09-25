import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from 'rate-limiter-flexible';

const MS_PER_SEC = 1000;

/** Package không re-export interface `ThrottlerStorageRecord` ở entry chính; lấy từ chữ ký `increment`. */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/** rate-limiter-flexible nhận `duration`/`blockDuration` theo giây nguyên (nó `Math.floor` phần lẻ). */
function wholeSeconds(ms: number, what: string): number {
  if (!Number.isInteger(ms) || ms <= 0 || ms % MS_PER_SEC !== 0)
    throw new Error(
      `Rate limit ${what} must be a positive number of whole seconds in ms, got ${ms}`,
    );
  return ms / MS_PER_SEC;
}
/** ThrottlerStorageRecord tính thời gian theo giây (giống storage mặc định của @nestjs/throttler). */
const toSec = (ms: number): number => Math.max(1, Math.ceil(ms / MS_PER_SEC));

/**
 * Limiter trong bộ nhớ mà rate-limiter-flexible chỉ gọi khi store (Redis) lỗi, nên mỗi lần `consume`
 * ở đây nghĩa là một request đã rơi sang insurance. Chỉ thêm hook báo hiệu, không đổi hành vi.
 */
class InsuranceLimiter extends RateLimiterMemory {
  constructor(
    opts: ConstructorParameters<typeof RateLimiterMemory>[0],
    private readonly onUse: () => void,
  ) {
    super(opts);
  }
  override consume(
    ...args: Parameters<RateLimiterMemory['consume']>
  ): Promise<RateLimiterRes> {
    this.onUse();
    return super.consume(...args);
  }
}

/**
 * ThrottlerStorage (extension point chính thức của @nestjs/throttler) trên rate-limiter-flexible.
 * Redis lỗi → `insuranceLimiter` trong bộ nhớ từng pod tiếp quản (giới hạn vẫn áp, chỉ không chia sẻ
 * giữa các pod); log `warn` một lần khi bắt đầu một đợt sự cố và `log` một lần khi Redis đếm lại được.
 */
export class RateLimiterThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RateLimiterThrottlerStorage.name);
  private readonly limiters = new Map<string, RateLimiterRedis>();
  private fallbacks = 0;
  private degraded = false;

  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
  ) {}

  private onFallback(): void {
    this.fallbacks++;
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      { namespace: this.namespace },
      'redis unavailable for rate limiting; per-process insurance limiter in use (limits not shared across pods)',
    );
  }

  private limiter(
    name: string,
    ttlMs: number,
    limit: number,
    blockMs: number,
  ): RateLimiterRedis {
    const id = `${name}-${limit}-${ttlMs}-${blockMs}`;
    let l = this.limiters.get(id);
    if (!l) {
      const duration = wholeSeconds(ttlMs, 'window');
      const blockDuration = wholeSeconds(blockMs, 'block duration');
      l = new RateLimiterRedis({
        storeClient: this.redis,
        useRedisPackage: false,
        // Không bật `rejectIfRedisNotReady`: lúc pod vừa khởi động client còn đang kết nối, request sẽ
        // rơi sang insurance vô cớ. Khi Redis sập, lệnh nằm trong offline queue của ioredis và bị huỷ
        // sau REDIS_COMMAND_TIMEOUT_MS (ioredis gắn commandTimeout trước khi xếp hàng) → insurance.
        keyPrefix: `${this.namespace}-rl-${id}`,
        points: limit,
        duration,
        blockDuration,
        insuranceLimiter: new InsuranceLimiter(
          { keyPrefix: `rl-${id}`, points: limit, duration, blockDuration },
          () => this.onFallback(),
        ),
      });
      this.limiters.set(id, l);
    }
    return l;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const l = this.limiter(throttlerName, ttl, limit, blockDuration);
    const fallbacksBefore = this.fallbacks;
    let record: ThrottlerStorageRecord;
    try {
      const res = await l.consume(key);
      record = {
        totalHits: res.consumedPoints,
        timeToExpire: toSec(res.msBeforeNext),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (rejection) {
      // Lỗi không phải RateLimiterRes chỉ xảy ra khi cả Redis lẫn insurance đều lỗi → ném tiếp (500).
      if (!(rejection instanceof RateLimiterRes)) throw rejection;
      const wait = toSec(rejection.msBeforeNext);
      record = {
        totalHits: rejection.consumedPoints,
        timeToExpire: wait,
        isBlocked: true,
        timeToBlockExpire: wait,
      };
    }
    // Request này không rơi sang insurance → Redis đã đếm được → kết thúc đợt sự cố.
    if (this.degraded && this.fallbacks === fallbacksBefore) {
      this.degraded = false;
      this.logger.log(
        { namespace: this.namespace },
        'redis recovered for rate limiting; shared limits restored',
      );
    }
    return record;
  }
}
