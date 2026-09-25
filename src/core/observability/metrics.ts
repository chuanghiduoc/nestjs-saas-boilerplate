import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  metrics,
  type BatchObservableCallback,
  type ObservableGauge,
} from '@opentelemetry/api';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RelayDb } from '../database/index.js';
import { outboxConfig } from '../outbox/index.js';
import { JobQueue } from '../queue/index.js';
import { METER } from './queue-metrics.js';

const MS_PER_SECOND = 1000;
const OutboxRow = z.object({ lag: z.number(), parked: z.number().int() });

/**
 * Gauge đo định kỳ trong worker. Callback chỉ chạy khi MetricReader thu thập (mỗi
 * `OTEL_METRICS_INTERVAL_MS`), nên tải lên Redis/DB bị chặn theo chu kỳ đó; OTel tắt thì
 * không bao giờ chạy. Callback lỗi: log `warn` và bỏ lần đo đó. Attribute chỉ có tên queue.
 *
 * `outbox_lag_seconds` bỏ qua dòng đã bị park (chưa publish và
 * `publish_attempts >= OUTBOX_MAX_PUBLISH_ATTEMPTS`, đúng điều kiện relay ngừng claim): relay không
 * bao giờ gửi lại chúng, nên tính vào thì một dòng hỏng ghim gauge tăng mãi và che mất độ trễ thật
 * của relay. Chúng được đếm riêng ở `outbox_parked_events` (event sẽ không bao giờ được giao, cần
 * người xử lý), trong cùng một câu query.
 */
@Injectable()
export class CoreMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreMetrics.name);
  private readonly meter = metrics.getMeter(METER);
  private readonly outboxLag = this.meter.createObservableGauge(
    'outbox_lag_seconds',
    {
      description: 'Age of the oldest unpublished outbox event',
      unit: 's',
    },
  );
  private readonly outboxParked = this.meter.createObservableGauge(
    'outbox_parked_events',
    {
      description:
        'Unpublished outbox events parked after max publish attempts (never delivered without intervention)',
    },
  );
  private readonly outboxGauges: ObservableGauge[] = [
    this.outboxLag,
    this.outboxParked,
  ];
  private readonly queueDepth = this.meter.createObservableGauge(
    'queue_depth',
    { description: 'Jobs waiting in the queue' },
  );
  private readonly oldestJobAge = this.meter.createObservableGauge(
    'queue_oldest_job_age_seconds',
    {
      description: 'How long the oldest waiting job has been eligible to run',
      unit: 's',
    },
  );
  private readonly queueGauges: ObservableGauge[] = [
    this.queueDepth,
    this.oldestJobAge,
  ];

  constructor(
    private readonly relayDb: RelayDb,
    private readonly queue: JobQueue,
    @Inject(outboxConfig.KEY)
    private readonly outbox: ConfigOf<typeof outboxConfig>,
  ) {}

  private readonly observeOutbox: BatchObservableCallback = async (result) => {
    try {
      const max = this.outbox.maxPublishAttempts;
      const [row] = await this.relayDb.execute(
        `SELECT COALESCE(extract(epoch FROM now() - min(occurred_at) FILTER (WHERE publish_attempts < ?)), 0)::float8 AS lag,
                count(*) FILTER (WHERE publish_attempts >= ?)::int AS parked
         FROM outbox_events WHERE published_at IS NULL`,
        [max, max],
      );
      const { lag, parked } = OutboxRow.parse(row);
      result.observe(this.outboxLag, lag);
      result.observe(this.outboxParked, parked);
    } catch (err) {
      this.logger.warn({ err }, 'outbox metrics skipped');
    }
  };

  private readonly observeQueues: BatchObservableCallback = async (result) => {
    try {
      for (const s of await this.queue.stats()) {
        const attrs = { queue: s.queue };
        result.observe(this.queueDepth, s.waiting, attrs);
        if (s.oldestWaitingAgeMs !== null)
          result.observe(
            this.oldestJobAge,
            s.oldestWaitingAgeMs / MS_PER_SECOND,
            attrs,
          );
      }
    } catch (err) {
      this.logger.warn({ err }, 'queue metrics skipped');
    }
  };

  onModuleInit(): void {
    this.meter.addBatchObservableCallback(
      this.observeOutbox,
      this.outboxGauges,
    );
    this.meter.addBatchObservableCallback(this.observeQueues, this.queueGauges);
  }

  /** Gỡ callback trước khi DB/Redis đóng: lần export cuối (flush lúc tắt) không chạm connection đã đóng. */
  onModuleDestroy(): void {
    this.meter.removeBatchObservableCallback(
      this.observeOutbox,
      this.outboxGauges,
    );
    this.meter.removeBatchObservableCallback(
      this.observeQueues,
      this.queueGauges,
    );
  }
}
