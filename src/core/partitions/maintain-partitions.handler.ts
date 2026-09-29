import { Injectable, type Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';
import { Db, UnitOfWork } from '../database/index.js';
import { JobHandler, type JobContext } from '../queue/index.js';
import {
  partitionedTableRegistry,
  tableOfPartition,
  type PartitionedTableDef,
} from './partitioned-table.js';
import { MaintainPartitionsJob } from './partitions.jobs.js';
import { PartitionMetrics } from './partitions.metrics.js';

const Result = z.array(
  z.object({
    action: z.enum(['created', 'dropped']),
    partition_name: z.string(),
  }),
);
const TRACER = 'core';

/**
 * Cron `core.partitions.maintain` (spec SP6 §5.3): gọi hàm bảo trì của từng mục trong registry qua `EXECUTE` của `app_user`,
 * mỗi mục trong một `UnitOfWork` riêng. Một mục lỗi không chặn mục khác: log ERROR, ném ở cuối để BullMQ retry (hàm bảo trì
 * idempotent; lượt đồng thời là no-op nhờ `pg_try_advisory_xact_lock`, R6-17).
 */
@Injectable()
@JobHandler(MaintainPartitionsJob)
export class MaintainPartitionsHandler {
  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly metrics: PartitionMetrics,
  ) {}

  handle(ctx: JobContext<unknown>): Promise<void> {
    return trace
      .getTracer(TRACER)
      .startActiveSpan('core.partitions.maintain', async (span) => {
        try {
          const failed: string[] = [];
          for (const def of partitionedTableRegistry()) {
            ctx.signal.throwIfAborted();
            try {
              await this.maintain(def, ctx.log);
            } catch (err) {
              failed.push(def.maintainFunction);
              ctx.log.error(
                {
                  event: 'partition_maintain_failed',
                  fn: def.maintainFunction,
                  err,
                },
                'partition maintenance failed',
              );
            }
          }
          if (failed.length > 0)
            throw new Error(
              `Partition maintenance failed for ${failed.join(', ')}; the other entries ran`,
            );
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
  }

  private async maintain(def: PartitionedTableDef, log: Logger): Promise<void> {
    const retention = def.retentionMonths();
    const premake = def.premakeMonths();
    for (const [name, v] of [
      ['retentionMonths', retention],
      ['premakeMonths', premake],
    ] as const)
      if (!Number.isSafeInteger(v) || v < 1)
        throw new Error(
          `${def.maintainFunction}: ${name} must be a positive integer, got ${v}`,
        );
    const rows = Result.parse(
      await this.uow.run(() =>
        this.db.execute(
          `SELECT action, partition_name FROM public.${def.maintainFunction}(?::integer, ?::integer)`,
          [retention, premake],
        ),
      ),
    );
    for (const r of rows) {
      const table = tableOfPartition(def, r.partition_name);
      log.log(
        {
          event:
            r.action === 'created' ? 'partition_created' : 'partition_dropped',
          table,
          partition: r.partition_name,
        },
        `partition ${r.action}`,
      );
      this.metrics.maintained(table, r.action);
    }
  }
}
