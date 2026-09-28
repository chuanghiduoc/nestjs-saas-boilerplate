import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { RelayDb } from '../database/index.js';
import { JobPayloadError, JobScheduler, findJob } from '../queue/index.js';
import { TENANT_TASK_PREFIX, tenantTaskId } from './scheduled-task.service.js';

const Row = z.object({
  org_id: z.string(),
  key: z.string(),
  job_name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  payload: z.unknown(),
  enabled: z.boolean(),
});

/**
 * Đưa BullMQ về khớp `scheduled_tasks` (nguồn sự thật), chạy trong worker bằng `RelayDb`
 * (policy `scheduled_tasks_relay_read`: app_relay chỉ SELECT, đọc mọi org).
 *
 * - Upsert lại mọi task đang bật: idempotent, sửa cả scheduler bị mất lẫn cron/tz/payload lệch.
 * - Chỉ xoá id dưới `task-` không có dòng đang bật; không bao giờ đụng cron tĩnh (`static-`).
 * - Lịch treo (`suspended_at`, org xoá mềm, spec SP3 §5.2) bị bỏ như lịch tắt: scheduler của nó bị gỡ ở vòng dọn.
 * - Chụp danh sách scheduler TRƯỚC khi đọc bảng: scheduler nào có trong ảnh chụp đều được tạo
 *   sau khi dòng của nó đã commit (service ghi DB trước), nên một task vừa tạo song song không
 *   bao giờ bị xoá nhầm. Hai reconciler song song chỉ upsert cùng giá trị và xoá cùng tập.
 * - Dòng trỏ tới job mà process này không biết (bản mới hơn khi rolling deploy): log error và
 *   GIỮ scheduler hiện có, không xoá dựa trên thông tin thiếu. Job đã biết nhưng không còn
 *   `tenantSchedulable` thì bị gỡ.
 * - Upsert một dòng lỗi: log, giữ scheduler hiện có, xử lý tiếp các dòng khác. Dữ liệu hỏng
 *   vĩnh viễn (`JobPayloadError`, ruling R13) chỉ log error theo org/key, không làm job thất bại
 *   (retry không tự lành, và sẽ làm lỗi Redis thật lẫn vào). Lỗi tạm thời (Redis) thì ném cuối
 *   lần chạy để job thất bại rõ ràng (retry idempotent).
 * - Còn một cửa sổ lệch có giới hạn: tenant sửa/tắt task giữa lúc reconcile đọc bảng và lúc nó
 *   upsert thì scheduler mang giá trị cũ tới lần reconcile sau (`SCHEDULER_RECONCILE_CRON`).
 */
@Injectable()
export class ScheduleReconciler {
  private readonly logger = new Logger(ScheduleReconciler.name);

  constructor(
    private readonly relayDb: RelayDb,
    private readonly scheduler: JobScheduler,
  ) {}

  async reconcile(): Promise<{ upserted: number; removed: number }> {
    const existing = await this.scheduler.listIds(TENANT_TASK_PREFIX);
    const rows = z
      .array(Row)
      .parse(
        await this.relayDb.execute(
          'SELECT org_id::text AS org_id, key, job_name, cron, timezone, payload, enabled FROM scheduled_tasks WHERE enabled AND suspended_at IS NULL',
        ),
      );
    const keep = new Set<string>();
    let upserted = 0;
    let failed = 0;
    let invalid = 0;
    for (const r of rows) {
      const id = tenantTaskId(r.org_id, r.key);
      const job = findJob(r.job_name);
      if (!job) {
        keep.add(id);
        this.logger.error(
          { orgId: r.org_id, key: r.key, job: r.job_name },
          'scheduled task references a job unknown to this process; leaving its scheduler untouched',
        );
        continue;
      }
      if (!job.tenantSchedulable) {
        this.logger.error(
          { orgId: r.org_id, key: r.key, job: r.job_name },
          'scheduled task references a job that is not tenant-schedulable; removing its scheduler',
        );
        continue;
      }
      keep.add(id);
      try {
        await this.scheduler.upsert(
          id,
          job,
          r.payload,
          { cron: r.cron, tz: r.timezone },
          { orgId: r.org_id },
        );
        upserted++;
      } catch (err) {
        // Một dòng lỗi không được chặn các org khác.
        const fields = { err, orgId: r.org_id, key: r.key, job: r.job_name };
        if (err instanceof JobPayloadError) {
          invalid++;
          this.logger.error(
            fields,
            'scheduled task payload is invalid for its job; leaving its scheduler untouched until the task is fixed',
          );
        } else {
          failed++;
          this.logger.error(
            fields,
            'failed to reconcile scheduled task; leaving its scheduler untouched',
          );
        }
      }
    }
    let removed = 0;
    for (const id of existing) {
      if (keep.has(id)) continue;
      await this.scheduler.remove(id);
      removed++;
    }
    if (failed)
      throw new Error(
        `${failed} scheduled task(s) failed to reconcile (upserted ${upserted}, removed ${removed}, invalid ${invalid})`,
      );
    return { upserted, removed };
  }
}
