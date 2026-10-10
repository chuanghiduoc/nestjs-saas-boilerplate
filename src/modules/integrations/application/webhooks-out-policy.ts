import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { ResiliencePolicies } from '../../../core/resilience/index.js';
import { WEBHOOKS_OUT, WEBHOOK_BREAKER_NEVER } from '../constants.js';
import { integrationsConfig } from '../integrations.config.js';

/**
 * Spec SP6 §5.3 hàng `core/resilience`, S6-A30: breaker theo provider sẽ gộp endpoint của mọi khách, nên tắt hẳn (ngưỡng không
 * bao giờ đạt); sức khoẻ theo endpoint nằm ở DB. Retry do lịch của delivery đảm nhận (POST vốn không được `HttpClient`
 * retry). Gọi lúc DI (`onModuleInit`), trước lời gọi đầu tiên tới provider (hợp đồng `setProviderDefaults`). Chỉ worker.
 */
@Injectable()
export class WebhooksOutPolicy implements OnModuleInit {
  constructor(
    private readonly policies: ResiliencePolicies,
    @Inject(integrationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}
  onModuleInit(): void {
    this.policies.setProviderDefaults(WEBHOOKS_OUT, {
      retries: 0,
      timeoutMs: this.cfg.webhookTimeoutMs,
      breakerThreshold: WEBHOOK_BREAKER_NEVER,
      bulkheadLimit: this.cfg.bulkheadLimit,
      bulkheadQueue: this.cfg.bulkheadQueue,
    });
  }
}
