import { Inject, Injectable } from '@nestjs/common';
import { CronExpressionParser, type CronExpression } from 'cron-parser';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { Db, UnitOfWork } from '../database/index.js';
import { AppError, CoreErrors, zodIssuesToFields } from '../errors/index.js';
import { JobScheduler, type JobDef } from '../queue/index.js';
import { schedulerConfig } from './scheduler.config.js';

/** Khớp CHECK của cột `scheduled_tasks.key`; không có `:` nên dùng được trong scheduler id BullMQ. */
const KEY_PATTERN = /^[a-z0-9._]{1,64}$/;
/** phút giờ ngày tháng thứ — không có trường giây. */
const CRON_FIELDS = 5;
/** Tên IANA (`Area/Location`, `UTC`, `Etc/GMT+7`); chặn dạng offset `+07:00` mà Intl vẫn nhận. */
const IANA_TZ_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const SECONDS_PER_MINUTE = 60;

export const TENANT_TASK_PREFIX = 'task-';
export const tenantTaskId = (orgId: string, key: string) =>
  `${TENANT_TASK_PREFIX}${orgId}-${key}`;

export type ScheduledTaskInput = {
  key: string;
  job: JobDef;
  cron: string;
  timezone: string;
  payload: unknown;
  enabled: boolean;
};

/**
 * Khoảng cách nhỏ nhất giữa hai lần chạy, tính trên lưới giờ×phút trong ngày, kể cả qua nửa đêm
 * (giả định hai ngày liên tiếp đều chạy — bảo thủ). Lấy mẫu vài lần chạy kế tiếp sẽ bỏ sót kiểu
 * `0,1,20,40 * * * *`. Lịch chạy mỗi ngày một lần cho kết quả 1 ngày.
 */
function minGapSec(expr: CronExpression): number {
  const { hour, minute } = expr.fields;
  const times = hour.values
    .flatMap((h) => minute.values.map((m) => h * MINUTES_PER_HOUR + m))
    .sort((a, b) => a - b);
  const first = times[0];
  const last = times.at(-1);
  if (first === undefined || last === undefined)
    throw new Error('cron expression has no hour/minute values');
  let gap = MINUTES_PER_DAY - last + first;
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    if (prev !== undefined && cur !== undefined)
      gap = Math.min(gap, cur - prev);
  }
  return gap * SECONDS_PER_MINUTE;
}

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

  private assertSchedule(cron: string, tz: string): void {
    if (!IANA_TZ_SHAPE.test(tz))
      throw this.invalid('timezone', `"${tz}" is not an IANA timezone name`);
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      throw this.invalid('timezone', `Unknown timezone "${tz}"`);
    }
    if (cron.trim().split(/\s+/).length !== CRON_FIELDS)
      throw this.invalid(
        'cron',
        'Use a 5-field cron expression (minute hour day month weekday, no seconds)',
      );
    let expr: CronExpression;
    try {
      expr = CronExpressionParser.parse(cron, { tz });
    } catch (err) {
      throw this.invalid(
        'cron',
        `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (minGapSec(expr) < this.cfg.tenantMinIntervalSec)
      throw this.invalid(
        'cron',
        `Runs must be at least ${this.cfg.tenantMinIntervalSec}s apart`,
      );
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
    this.assertSchedule(i.cron, i.timezone);
    const parsed = i.job.schema.safeParse(i.payload);
    if (!parsed.success)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: zodIssuesToFields(parsed.error.issues).map((f) => ({
          ...f,
          path: f.path ? `payload.${f.path}` : 'payload',
        })),
      });
    await this.uow.run(() =>
      this.db.execute(
        `INSERT INTO scheduled_tasks (org_id, key, job_name, cron, timezone, payload, enabled) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
         ON CONFLICT ON CONSTRAINT scheduled_tasks_org_key_uq DO UPDATE SET job_name = EXCLUDED.job_name, cron = EXCLUDED.cron,
         timezone = EXCLUDED.timezone, payload = EXCLUDED.payload, enabled = EXCLUDED.enabled, updated_at = now()`,
        [
          org,
          i.key,
          i.job.name,
          i.cron,
          i.timezone,
          JSON.stringify(parsed.data),
          i.enabled,
        ],
      ),
    );
    const id = tenantTaskId(org, i.key);
    if (i.enabled)
      await this.scheduler.upsert(
        id,
        i.job,
        parsed.data,
        { cron: i.cron, tz: i.timezone },
        { orgId: org },
      );
    else await this.scheduler.remove(id);
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
