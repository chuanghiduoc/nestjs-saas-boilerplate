import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  EventPublisher,
  principalActor,
  type EventActor,
} from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { Quotas } from '../../../modules/entitlements/index.js';
import { EXAMPLE_PROJECT_AGGREGATE } from '../constants.js';
import {
  transition,
  type ProjectCommand,
  type ProjectStatus,
} from '../domain/project.js';
import { ExampleFeatures } from '../entitlements.js';
import {
  ProjectArchivedEvent,
  ProjectCreatedEvent,
  ProjectDeletedEvent,
  ProjectUnarchivedEvent,
  ProjectUpdatedEvent,
} from '../events.js';
import {
  ProjectRepository,
  type ProjectRow,
} from '../infra/sql-project.repository.js';

const PROJECT_COUNT = ExampleFeatures.key('example.project_count');
const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });
const aggregateOf = (publicId: string, version: number) => ({
  type: EXAMPLE_PROJECT_AGGREGATE,
  id: publicId,
  version,
});

/**
 * Spec SP7 §6.3.2, §7.4, §8.1. Chạy trong OrgScope của route tenant. Thứ tự khoá ở mọi đường (S7-D35, review M6): dòng
 * `organizations` `FOR KEY SHARE` (qua FK khi INSERT) → dòng project → dòng bộ đếm `usage_counters` (consume/release gọi
 * SAU câu ghi project). Không đường nào khoá bộ đếm rồi quay lại khoá project hay org.
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly projects: ProjectRepository,
    private readonly quotas: Quotas,
    private readonly events: EventPublisher,
  ) {}

  create(i: { name: string; description: string | null }): Promise<ProjectRow> {
    return this.uow.run(async () => {
      const row = await this.projects.insert(i);
      // Nhiều quota trong một transaction: gọi theo thứ tự key tăng dần (hợp đồng Quotas, 4B I2). Mẫu chỉ có một quota.
      await this.quotas.consumeOrThrow(PROJECT_COUNT, 1);
      await this.events.publish(ProjectCreatedEvent, {
        data: { projectId: row.publicId },
        aggregate: aggregateOf(row.publicId, row.version),
        actor: this.actor(),
      });
      return row;
    });
  }

  async get(publicId: string): Promise<ProjectRow> {
    const row = await this.uow.run(() => this.projects.find(publicId, 'NONE'));
    if (!row) throw notFound();
    return row;
  }

  /** `after` đã giải mã (controller giữ codec cursor); `lastPublicId` là khoá của dòng cuối trang. */
  async list(q: {
    limit: number;
    after?: string;
    status?: ProjectStatus;
  }): Promise<{
    rows: ProjectRow[];
    hasMore: boolean;
    lastPublicId: string | null;
  }> {
    const all = await this.uow.run(() => this.projects.list(q));
    const hasMore = all.length > q.limit;
    const rows = hasMore ? all.slice(0, q.limit) : all;
    return { rows, hasMore, lastPublicId: rows.at(-1)?.publicId ?? null };
  }

  update(
    publicId: string,
    ifMatch: string | undefined,
    patch: { name?: string; description?: string | null },
  ): Promise<ProjectRow> {
    return this.uow.run(async () => {
      const cur = await this.locked(publicId);
      assertIfMatch(ifMatch, cur.version, { required: true });
      this.allow(cur.status, 'UPDATE');
      const name = patch.name ?? cur.name;
      const description =
        patch.description === undefined ? cur.description : patch.description;
      // So chính xác chuỗi cũ: đổi hoa thường của tên là một thay đổi thật.
      const changed = [
        ...(name !== cur.name ? (['name'] as const) : []),
        ...(description !== cur.description ? (['description'] as const) : []),
      ];
      // Không đổi gì → không tăng version, không event.
      if (changed.length === 0) return cur;
      const row = await this.projects.updateFields(cur.id, {
        name,
        description,
      });
      await this.events.publish(ProjectUpdatedEvent, {
        data: { projectId: row.publicId, changed },
        aggregate: aggregateOf(row.publicId, row.version),
        actor: this.actor(),
      });
      return row;
    });
  }

  archive(publicId: string): Promise<ProjectRow> {
    return this.uow.run(async () => {
      const cur = await this.locked(publicId);
      this.allow(cur.status, 'ARCHIVE');
      const row = await this.projects.setStatus(cur.id, 'ARCHIVED');
      await this.events.publish(ProjectArchivedEvent, {
        data: { projectId: row.publicId },
        aggregate: aggregateOf(row.publicId, row.version),
        actor: this.actor(),
      });
      return row;
    });
  }

  unarchive(publicId: string): Promise<ProjectRow> {
    return this.uow.run(async () => {
      const cur = await this.locked(publicId);
      this.allow(cur.status, 'UNARCHIVE');
      const row = await this.projects.setStatus(cur.id, 'ACTIVE');
      await this.events.publish(ProjectUnarchivedEvent, {
        data: { projectId: row.publicId },
        aggregate: aggregateOf(row.publicId, row.version),
        actor: this.actor(),
      });
      return row;
    });
  }

  /** Xoá từ mọi trạng thái (bảng 8.1): `DELETE … RETURNING` (0 dòng → 404), rồi trả quota, rồi event (spec §7.4). */
  remove(publicId: string): Promise<void> {
    return this.uow.run(async () => {
      const deleted = await this.projects.deleteOne(publicId);
      if (!deleted) throw notFound();
      await this.quotas.releaseAllocation(PROJECT_COUNT, 1);
      await this.events.publish(ProjectDeletedEvent, {
        data: { projectId: deleted.publicId, reason: 'REMOVED' },
        aggregate: aggregateOf(deleted.publicId, deleted.version + 1),
        actor: this.actor(),
      });
    });
  }

  private async locked(publicId: string): Promise<ProjectRow> {
    const cur = await this.projects.find(publicId, 'NO_KEY_UPDATE');
    if (!cur) throw notFound();
    return cur;
  }

  private allow(status: ProjectStatus, command: ProjectCommand): void {
    const t = transition(status, command);
    if (t.kind === 'REJECTED') throw new AppError(t.code, { expected: true });
  }

  /** Route của mẫu luôn có principal (user hoặc org API key); không có là lỗi lắp ráp. */
  private actor(): EventActor {
    const actor = principalActor(this.ctx);
    if (!actor) throw new Error('an example mutation ran without a principal');
    return actor;
  }
}
