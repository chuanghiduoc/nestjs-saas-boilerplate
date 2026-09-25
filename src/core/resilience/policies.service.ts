import { Inject, Injectable } from '@nestjs/common';
import type { IPolicy } from 'cockatiel';
import { type ConfigOf } from '../config/index.js';
import { buildPolicies, type PolicyConfig } from './policies.js';
import { resilienceConfig } from './resilience.config.js';

type ProviderPolicies = { retrying: IPolicy; single: IPolicy };

/**
 * Một bộ policy cho mỗi provider, tạo một lần rồi cache, để breaker và bulkhead giữ trạng thái
 * và dùng chung giữa mọi lời gọi tới cùng provider.
 */
@Injectable()
export class ResiliencePolicies {
  private readonly byProvider = new Map<string, ProviderPolicies>();

  constructor(
    @Inject(resilienceConfig.KEY)
    private readonly cfg: ConfigOf<typeof resilienceConfig>,
  ) {}

  for(provider: string): ProviderPolicies {
    const cached = this.byProvider.get(provider);
    if (cached) return cached;
    const defaults: PolicyConfig = {
      timeoutMs: this.cfg.timeoutMs,
      retries: this.cfg.retries,
      retryBaseMs: this.cfg.retryBaseMs,
      breakerThreshold: this.cfg.breakerThreshold,
      breakerHalfOpenMs: this.cfg.breakerHalfOpenMs,
      bulkheadLimit: this.cfg.bulkheadLimit,
      bulkheadQueue: this.cfg.bulkheadQueue,
    };
    const built = buildPolicies({
      ...defaults,
      ...this.cfg.overrides[provider],
    });
    this.byProvider.set(provider, built);
    return built;
  }
}
