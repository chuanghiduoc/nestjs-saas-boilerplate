import { Inject, Injectable } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { Db, UnitOfWork } from '../database/index.js';
import { AppError, CoreErrors, zodIssuesToFields } from '../errors/index.js';
import { JobScheduler, findJob, type JobDef } from '../queue/index.js';
import {
  ScheduleComputationError,
  minGapSec,
  normalizeTimezone,
} from './schedule-validation.js';
import { schedulerConfig } from './scheduler.config.js';

/** Khớp CHECK của cột `scheduled_tasks.key`; không có `:` nên dùng được trong scheduler id BullMQ. */
const KEY_PATTERN = /^[a-z0-9._]{1,64}$/;
/** phút giờ ngày tháng thứ — không có trường giây. */
const CRON_FIELDS = 5;
export const TENANT_TASK_PREFIX = 'task-';
export const tenantTaskId = (orgId: string, key: string) =>
  `${TENANT_TASK_PREFIX}${orgId}-${key}`;

// `Db.execute` (MikroORM pg driver) trả TIMESTAMPTZ dạng chuỗi, nên coerce như `OutboxRow.occurred_at`.
const SuspendedRow = z.object({ suspended_at: z.coerce.date().nullable() });
const SyncRow = z.object({
  key: z.string(),
  job_name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  payload: z.unknown(),
});

export type ScheduledTaskInput = {
  key: string;
  job: JobDef;
  cron: string;
  timezone: string;
  payload: unknown;
  enabled: boolean;
};

/**
 * Lịch do tenant tạo. Org lấy từ `RequestContext` (bắt buộc chạy trong `OrgScope`), dòng được
 * RLS bảo vệ. Ghi DB trước (nguồn sự thật) rồi mới cập nhật BullMQ: nếu bước Redis lỗi, lỗi
 * được ném ra cho caller và `ScheduleReconciler` sửa lại ở lần chạy sau.
 */
@Injectable()
export class ScheduledTaskService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly db: Db,
    private readonly scheduler: JobScheduler,
    private readonly ctx: RequestContext,
    @Inject(schedulerConfig.KEY)
    private readonly cfg: ConfigOf<typeof schedulerConfig>,
  ) {}

  private invalid(path: string, message: string): AppError {
    return new AppError(CoreErrors.VALIDATION_FAILED, {
      fields: [{ path, code: 'invalid', message }],
    });
  }

  private orgOrThrow(): string {
    const org = this.ctx.orgId();
    if (!org)
      throw new AppError(CoreErrors.ORG_CONTEXT_INVALID, {
        detail: 'Scheduled tasks must be managed inside an organization scope',
      });
    return org;
  }

  /** Trả về timezone để lưu và gửi cho BullMQ (tên người dùng nhập, xem `normalizeTimezone`). */
  private assertSchedule(cron: string, tz: string): string {
    const timezone = normalizeTimezone(tz);
    if (!timezone)
      throw this.invalid('timezone', `"${tz}" is not an IANA timezone name`);
    if (cron.trim().split(/\s+/).length !== CRON_FIELDS)
      throw this.invalid(
        'cron',
        'Use a 5-field cron expression (minute hour day month weekday, no seconds)',
      );
    try {
      CronExpressionParser.parse(cron, { tz: timezone });
    } catch (err) {
      throw this.invalid(
        'cron',
        `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let gap: number;
    try {
      gap = minGapSec(cron, timezone);
    } catch (err) {
      // Fail-closed: BullMQ tính lần chạy kế bằng chính cron-parser này và NUỐT lỗi
      // (`defaultRepeatStrategy` trong bullmq/dist/esm/classes/job-scheduler.js: `catch (e) {
      // // Ignore error }`, rồi `upsertJobScheduler` không thêm job khi không có nextMillis), nên
      // lịch như vậy sẽ lặng lẽ ngừng chạy lúc runtime.
      if (err instanceof ScheduleComputationError)
        throw this.invalid(
          'timezone',
          `This schedule cannot be computed reliably in timezone "${tz}" around its daylight-saving changes; choose another cron or timezone`,
        );
      throw err;
    }
    if (gap < this.cfg.tenantMinIntervalSec)
      throw this.invalid(
        'cron',
        `Runs must be at least ${this.cfg.tenantMinIntervalSec}s apart, including across midnight (checked as if consecutive days both run) and across daylight-saving changes`,
      );
    return timezone;
  }

  async upsert(i: ScheduledTaskInput): Promise<void> {
    const org = this.orgOrThrow();
    if (!KEY_PATTERN.test(i.key))
      throw this.invalid('key', `key must match ${KEY_PATTERN}`);
    if (!i.job.tenantSchedulable)
      throw this.invalid(
        'job',
        `Job "${i.job.name}" cannot be scheduled by tenants`,
      );
    const timezone = this.assertSchedule(i.cron, i.timezone);
    const parsed = i.job.schema.safeParse(i.payload);
    if (!parsed.success)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: zodIssuesToFields(parsed.error.issues).map((f) => ({
          ...f,
          path: f.path ? `payload.${f.path}` : 'payload',
        })),
      });
    const [row] = await this.uow.run(() =>
      this.db.execute(
        `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
         ON CONFLICT ON CONSTRAINT scheduled_tasks_org_key_uq DO UPDATE SET job_name = EXCLUDED.job_name, cron = EXCLUDED.cron,
         timezone = EXCLUDED.timezone, payload = EXCLUDED.payload, enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING suspended_at`,
        [
          org,
          i.key,
          i.job.name,
          i.cron,
          timezone,
          JSON.stringify(parsed.data),
          i.enabled,
        ],
      ),
    );
    const { suspended_at: suspendedAt } = SuspendedRow.parse(row);
    const id = tenantTaskId(org, i.key);
    // Spec SP3 §5.2 (T-32): dòng đang treo (org xoá mềm, hoặc trigger của tenancy vừa treo lịch mới) không lên Redis.
    if (i.enabled && suspendedAt === null)
      await this.scheduler.upsert(
        id,
        i.job,
        parsed.data,
        { cron: i.cron, tz: timezone },
        { orgId: org },
      );
    else await this.scheduler.remove(id);
  }

  /** Spec SP3 §5.2: treo mọi lịch của org hiện tại. Chỉ ghi DB, trong transaction của caller (xoá mềm org). */
  async suspendAllForCurrentOrg(): Promise<number> {
    this.assertInCallerTransaction('suspendAllForCurrentOrg');
    const rows = await this.db.execute(
      `UPDATE scheduled_tasks SET suspended_at = now(), updated_at = now()
       WHERE org_id = app_current_org() AND suspended_at IS NULL RETURNING id`,
    );
    return rows.length;
  }

  /** Gỡ treo (khôi phục org): `enabled` của feature giữ nguyên. */
  async resumeAllForCurrentOrg(): Promise<number> {
    this.assertInCallerTransaction('resumeAllForCurrentOrg');
    const rows = await this.db.execute(
      `UPDATE scheduled_tasks SET suspended_at = NULL, updated_at = now()
       WHERE org_id = app_current_org() AND suspended_at IS NOT NULL RETURNING id`,
    );
    return rows.length;
  }

  /** Xoá mọi lịch của org hiện tại (participant xoá cứng của tenancy, spec §9.5). Chỉ DB. */
  async removeAllForCurrentOrg(): Promise<number> {
    this.assertInCallerTransaction('removeAllForCurrentOrg');
    const rows = await this.db.execute(
      `DELETE FROM scheduled_tasks WHERE org_id = app_current_org() RETURNING id`,
    );
    return rows.length;
  }

  /**
   * Gọi SAU commit của caller: đưa scheduler Redis của org hiện tại về khớp DB (upsert lịch `enabled` chưa treo, gỡ
   * mọi id `task-<org>-*` khác). Lỗi Redis ném cho caller; reconciler sửa ở lần chạy sau. Không bao giờ gỡ Redis trong
   * transaction rồi rollback (DB-I10).
   */
  async syncCurrentOrg(): Promise<{ upserted: number; removed: number }> {
    const org = this.orgOrThrow();
    if (this.uow.inTransaction())
      throw new Error(
        'ScheduledTaskService.syncCurrentOrg must run after the caller commits (Redis is never touched inside a transaction)',
      );
    const rows = z
      .array(SyncRow)
      .parse(
        await this.db.execute(
          `SELECT key, job_name, cron, timezone, payload FROM scheduled_tasks WHERE enabled AND suspended_at IS NULL`,
        ),
      );
    const keep = new Set<string>();
    let upserted = 0;
    for (const r of rows) {
      const job = findJob(r.job_name);
      const id = tenantTaskId(org, r.key);
      // Job lạ (bản mới hơn khi rolling deploy): giữ scheduler như reconciler; job không còn tenantSchedulable: gỡ.
      if (!job) {
        keep.add(id);
        continue;
      }
      if (!job.tenantSchedulable) continue;
      keep.add(id);
      await this.scheduler.upsert(
        id,
        job,
        r.payload,
        { cron: r.cron, tz: r.timezone },
        { orgId: org },
      );
      upserted++;
    }
    let removed = 0;
    for (const id of await this.scheduler.listIds(tenantTaskId(org, '')))
      if (!keep.has(id)) {
        await this.scheduler.remove(id);
        removed++;
      }
    return { upserted, removed };
  }

  private assertInCallerTransaction(op: string): void {
    this.orgOrThrow();
    if (!this.uow.inTransaction())
      throw new Error(
        `ScheduledTaskService.${op} must run inside the caller's UnitOfWork transaction (spec SP3 §5.2)`,
      );
  }

  /** Idempotent: key không tồn tại thì không làm gì. */
  async remove(key: string): Promise<void> {
    const org = this.orgOrThrow();
    if (!KEY_PATTERN.test(key))
      throw this.invalid('key', `key must match ${KEY_PATTERN}`);
    await this.uow.run(() =>
      this.db.execute('DELETE FROM scheduled_tasks WHERE key = ?', [key]),
    );
    await this.scheduler.remove(tenantTaskId(org, key));
  }
}
