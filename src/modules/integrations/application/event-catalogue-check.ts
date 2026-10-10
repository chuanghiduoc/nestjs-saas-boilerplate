import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../../core/database/index.js';
import { eventRegistry, type EventDef } from '../../../core/events/index.js';
import { IntegrationsMetrics } from './integrations-metrics.js';

const Rows = z.array(z.object({ type: z.string() }));

/**
 * Spec SP6 §6.5 + R-X30: type có `webhook: true` trong code phải có dòng ở `webhook_event_types` (đăng ký cần FK), thiếu →
 * không khởi động (một migration chưa chạy). Dòng chỉ có ở DB (DB mới hơn code lúc rolling deploy, hoặc module phát event bị
 * tắt) là trơ: WARN một lần + metric, vẫn khởi động; API không nhận type đó (`known()` chỉ có type code biết).
 * `onModuleInit` (không phải `onApplicationBootstrap`): worker chưa nhận job nào khi kiểm (bài học `CatalogueCheck` của 3A).
 */
@Injectable()
export class WebhookEventCatalogueCheck implements OnModuleInit {
  private readonly logger = new Logger(WebhookEventCatalogueCheck.name);
  private codeTypes: ReadonlySet<string> | undefined;
  constructor(
    private readonly db: Db,
    private readonly metrics: IntegrationsMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    const code = new Set(this.webhookDefs().map((d) => d.type));
    const db = new Set(
      Rows.parse(
        await this.db.execute('SELECT type FROM webhook_event_types'),
      ).map((r) => r.type),
    );
    const missing = [...code].filter((t) => !db.has(t)).sort();
    const unknown = [...db].filter((t) => !code.has(t)).sort();
    if (unknown.length > 0) {
      this.metrics.catalogueUnknownTypes.add(unknown.length);
      this.logger.warn(
        { event: 'webhook_event_types_unknown_to_code', types: unknown },
        'webhook event types this code does not define are inert',
      );
    }
    if (missing.length > 0) {
      this.logger.error(
        { event: 'webhook_event_catalogue_mismatch', missing },
        'webhook events are missing from webhook_event_types',
      );
      throw new Error(
        `Webhook event catalogue mismatch: missing in webhook_event_types: ${missing.join(', ')}`,
      );
    }
    this.codeTypes = code;
  }

  /** Type đăng ký được (code biết, DB có). Gọi trước khi kiểm xong là lỗi lắp ráp. */
  known(): ReadonlySet<string> {
    if (!this.codeTypes)
      throw new Error(
        'WebhookEventCatalogueCheck.known() called before onModuleInit',
      );
    return this.codeTypes;
  }

  /** Def `webhook: true` (mọi version), sắp theo `type@version`: nguồn của `GET /v1/webhook-event-types`. */
  definitions(): readonly EventDef[] {
    return this.webhookDefs();
  }

  private webhookDefs(): EventDef[] {
    return eventRegistry()
      .filter((d) => d.webhook)
      .sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version);
  }
}
