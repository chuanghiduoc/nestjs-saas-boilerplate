import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { z } from 'zod';
import { Db } from '../database/index.js';
import { METER } from '../observability/queue-metrics.js';
import { monthsAhead, partitionedTableRegistry } from './partitioned-table.js';

const Newest = z.array(z.object({ newest: z.string().nullable() }));

/** Worker: đếm tạo/drop và gauge "partition đi trước bao nhiêu tháng" (cảnh báo `< 2`, spec §15). */
@Injectable()
export class PartitionMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PartitionMetrics.name);
  private readonly meter = metrics.getMeter(METER);
  private readonly maintainedTotal = this.meter.createCounter(
    'db_partition_maintain_total',
    {
      description:
        'Monthly partitions created or dropped by core.partitions.maintain',
    },
  );
  private readonly ahead = this.meter.createObservableGauge(
    'db_partition_months_ahead',
    {
      description:
        'Months between the current UTC month and the newest partition of the table',
    },
  );

  constructor(private readonly db: Db) {}

  maintained(table: string, action: 'created' | 'dropped'): void {
    this.maintainedTotal.add(1, { table, action });
  }

  private readonly observe = async (
    result: ObservableResult,
  ): Promise<void> => {
    try {
      for (const def of partitionedTableRegistry())
        for (const table of def.tables) {
          const [row] = Newest.parse(
            await this.db.execute(
              `SELECT max(substring(c.relname FROM '_p([0-9]{6})$')) AS newest
               FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
               WHERE i.inhparent = to_regclass(?)`,
              [`public.${table}`],
            ),
          );
          result.observe(monthsAhead(row?.newest ?? null, new Date()), {
            table,
          });
        }
    } catch (err) {
      this.logger.warn({ err }, 'partition metrics skipped');
    }
  };

  onModuleInit(): void {
    this.ahead.addCallback(this.observe);
  }

  /** Gỡ trước khi pool DB đóng: lần export cuối lúc tắt không chạm connection đã đóng. */
  onModuleDestroy(): void {
    this.ahead.removeCallback(this.observe);
  }
}
