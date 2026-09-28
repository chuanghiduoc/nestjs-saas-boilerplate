import { Inject, Injectable } from '@nestjs/common';
import type { IPolicy } from 'cockatiel';
import { type ConfigOf } from '../config/index.js';
import { buildPolicies, type PolicyConfig } from './policies.js';
import { resilienceConfig } from './resilience.config.js';

type ProviderPolicies = { retrying: IPolicy; single: IPolicy };

/**
 * Một bộ policy cho mỗi provider, tạo một lần rồi cache, để breaker và bulkhead giữ trạng thái
 * và dùng chung giữa mọi lời gọi tới cùng provider.
 *
 * Tên provider PHẢI là hằng số có tên trong code (vd `'sepay'`, `'user-webhooks'`), không bao giờ là
 * URL, host hay id của tenant: cache không có eviction (~4 KB mỗi provider), nên tên động làm bộ nhớ
 * tăng không giới hạn và tách breaker/bulkhead theo tenant, mất tác dụng bảo vệ theo provider.
 */
@Injectable()
export class ResiliencePolicies {
  private readonly byProvider = new Map<string, ProviderPolicies>();
  private readonly providerDefaults = new Map<string, Partial<PolicyConfig>>();

  constructor(
    @Inject(resilienceConfig.KEY)
    private readonly cfg: ConfigOf<typeof resilienceConfig>,
  ) {}

  /**
   * Default riêng của một provider, nằm giữa default chung (`RESILIENCE_DEFAULT_*`) và `RESILIENCE_OVERRIDES`
   * (override của người vận hành luôn thắng). Dùng khi giá trị đúng phụ thuộc vào caller (vd. timeout từng lần thử
   * của `idp-jwks` phải nhỏ hơn hạn của jose). Phải gọi trước lời gọi đầu tiên tới provider đó (lúc DI), và chỉ một
   * lần: policy đã dựng thì không đổi được, nên gọi muộn hoặc gọi lại là lỗi nối dây, ném ngay.
   */
  setProviderDefaults(provider: string, defaults: Partial<PolicyConfig>): void {
    if (this.byProvider.has(provider) || this.providerDefaults.has(provider))
      throw new Error(
        `resilience defaults for provider "${provider}" must be set once, before its first call`,
      );
    this.providerDefaults.set(provider, defaults);
  }

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
      ...this.providerDefaults.get(provider),
      ...this.cfg.overrides[provider],
    });
    this.byProvider.set(provider, built);
    return built;
  }
}
