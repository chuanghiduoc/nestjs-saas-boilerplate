import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';

/**
 * Event của feature mẫu (spec SP7 §10.1, R-X3): `audit: true` (mọi thao tác trên dữ liệu tenant để lại dấu vết),
 * `webhook: false` (webhook là hợp đồng công khai với khách; mẫu không tự mở). Payload chỉ id công khai: tên và mô tả do
 * user nhập có thể là PII.
 */
const projectId = z.uuid();
export const ProjectCreatedEvent = defineEvent({
  type: 'example.project.created',
  version: 1,
  schema: z.object({ projectId }).strict(),
  audit: true,
  webhook: false,
});
export const ProjectUpdatedEvent = defineEvent({
  type: 'example.project.updated',
  version: 1,
  schema: z
    .object({
      projectId,
      changed: z.array(z.enum(['name', 'description'])).min(1),
    })
    .strict(),
  audit: true,
  webhook: false,
});
export const ProjectArchivedEvent = defineEvent({
  type: 'example.project.archived',
  version: 1,
  schema: z.object({ projectId }).strict(),
  audit: true,
  webhook: false,
});
export const ProjectUnarchivedEvent = defineEvent({
  type: 'example.project.unarchived',
  version: 1,
  schema: z.object({ projectId }).strict(),
  audit: true,
  webhook: false,
});
/** `aggregate.version` = version của dòng cuối cùng + 1: consumer biết event xoá là mới nhất. */
export const ProjectDeletedEvent = defineEvent({
  type: 'example.project.deleted',
  version: 1,
  schema: z
    .object({ projectId, reason: z.enum(['REMOVED', 'RETENTION']) })
    .strict(),
  audit: true,
  webhook: false,
});

export const ExampleEvents = {
  ProjectCreatedEvent,
  ProjectUpdatedEvent,
  ProjectArchivedEvent,
  ProjectUnarchivedEvent,
  ProjectDeletedEvent,
} as const;
