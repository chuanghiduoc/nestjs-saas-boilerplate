import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { Db, UnitOfWork } from '../database/index.js';
import { METER } from '../observability/queue-metrics.js';
import { JobQueue } from '../queue/index.js';
import { minGapSec } from '../scheduler/schedule-validation.js';
import { PURGE_CURSOR_START } from './constants.js';
import {
  OrgSweepDefinitionError,
  checkedBatch,
  checkedParams,
  findOrgSweep,
  orgSweepRegistry,
  sweepJobId,
  sweepSql,
  type OrgSweepDef,
} from './org-sweep.js';

const Rows = z.array(z.object({ org_id: z.uuid() }));
const MS_PER_SECOND = 1000;

export type OrgSweepResult = {
  batches: number;
  enqueued: number;
  backlog: boolean;
  slot: number;
};

/**
 * Chạy một lượt quét (spec SP6 §5.3): tối đa `maxBatches` lô trên pool `app_user`, ngoài transaction và `OrgScope` (`app_user`
 * chỉ có `EXECUTE` trên hàm definer), con trỏ từ `PURGE_CURSOR_START`, dừng khi lô ngắn hơn `size`. Enqueue sau khi đọc, không
 * trong transaction (spec §3.2 luật 3). `jobId = <prefix>-<orgId>-<slot>`, `slot = floor(epochSec / minGapSec(cron, tz))`:
 * hai lượt cron hay một lần retry trong cùng slot không tạo job trùng; job theo org `failed` chỉ chặn org đó tới slot sau.
 */
@Injectable()
export class OrgSweepRunner implements OnModuleInit {
  private readonly logger = new Logger(OrgSweepRunner.name);
  private readonly slotSec = new Map<string, number>();
  private readonly meter = metrics.getMeter(METER);
  private readonly enqueuedTotal = this.meter.createCounter(
    'org_sweep_orgs_enqueued_total',
    {
      description:
        'Per-org jobs enqueued by org sweeps (duplicates in the same slot are ignored by BullMQ)',
    },
  );
  private readonly backlogTotal = this.meter.createCounter(
    'org_sweep_backlog_total',
    {
      description:
        'Org sweep runs that stopped at maxBatches with a full last batch',
    },
  );
  private readonly duration = this.meter.createHistogram(
    'org_sweep_duration_seconds',
    {
      description: 'Duration of one org sweep run',
      unit: 's',
    },
  );

  constructor(
    private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly queue: JobQueue,
  ) {}

  /** Slot của mọi sweep đã đăng ký tính một lần lúc boot: cron không tính được → worker không khởi động. */
  onModuleInit(): void {
    for (const def of orgSweepRegistry()) this.slotSecOf(def);
  }

  async run(def: OrgSweepDef, at: Date = new Date()): Promise<OrgSweepResult> {
    if (findOrgSweep(def.key) !== def)
      throw new Error(
        `Org sweep "${def.key}" was not created by defineOrgSweep`,
      );
    if (this.uow.inTransaction() || this.ctx.orgId() !== undefined)
      throw new Error(
        `Org sweep "${def.key}" must run outside any transaction and OrgScope`,
      );
    const { size, maxBatches } = checkedBatch(def);
    const params = checkedParams(def);
    const sql = sweepSql(def, params);
    const values = params.map(([, v]) => v);
    const slot = Math.floor(at.getTime() / MS_PER_SECOND / this.slotSecOf(def));
    const attrs = { key: def.key };
    const started = performance.now();
    let after = PURGE_CURSOR_START;
    let batches = 0;
    let enqueued = 0;
    let full = false;
    try {
      while (batches < maxBatches) {
        const ids = this.orgIdsOf(
          def,
          await this.db.execute(sql, [after, size, ...values]),
          after,
          size,
        );
        batches++;
        if (ids.length > 0) {
          await this.queue.enqueueMany(
            ids.map((orgId) => ({
              job: def.orgJob,
              payload: {},
              opts: { jobId: sweepJobId(def, orgId, slot), meta: { orgId } },
            })),
          );
          enqueued += ids.length;
          this.enqueuedTotal.add(ids.length, attrs);
          after = ids[ids.length - 1] ?? after;
        }
        full = ids.length === size;
        if (!full) break;
      }
    } finally {
      this.duration.record(
        (performance.now() - started) / MS_PER_SECOND,
        attrs,
      );
    }
    if (full) {
      this.backlogTotal.add(1, attrs);
      this.logger.warn(
        { event: 'org_sweep_backlog', key: def.key, batches, enqueued },
        'org sweep stopped at maxBatches with a full last batch; the rest waits for the next run',
      );
    }
    return { batches, enqueued, backlog: full, slot };
  }

  private slotSecOf(def: OrgSweepDef): number {
    let sec = this.slotSec.get(def.key);
    if (sec === undefined) {
      const { cron, tz } = def.schedule();
      sec = minGapSec(cron, tz);
      this.slotSec.set(def.key, sec);
    }
    return sec;
  }

  /** Review Focus 2: hàm quét sai `ORDER BY`/`DISTINCT`/`LIMIT` làm keyset bỏ sót hoặc lặp org — dừng to thay vì tiếp tục. */
  private orgIdsOf(
    def: OrgSweepDef,
    rows: object[],
    after: string,
    size: number,
  ): string[] {
    const ids = Rows.parse(rows).map((r) => r.org_id);
    if (ids.length > size)
      throw new OrgSweepDefinitionError(
        def.key,
        `${def.definerFunction} returned ${ids.length} rows for p_limit ${size}`,
      );
    let prev = after;
    for (const id of ids) {
      if (id <= prev)
        throw new OrgSweepDefinitionError(
          def.key,
          `${def.definerFunction} must return org ids strictly ascending after p_after (got ${id} after ${prev})`,
        );
      prev = id;
    }
    return ids;
  }
}
