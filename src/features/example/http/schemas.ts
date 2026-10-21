import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  cursorPageQuery,
  cursorPageSchema,
  mergePatchSchema,
} from '../../../core/http/index.js';
import {
  EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH,
  EXAMPLE_PROJECT_NAME_MAX_LENGTH,
} from '../constants.js';
import { PROJECT_STATUSES } from '../domain/project.js';

const iso = z.iso.datetime();
// Cùng luật với `example_projects_name_ck` (`btrim`, 1–100).
export const ProjectName = z
  .string()
  .trim()
  .min(1)
  .max(EXAMPLE_PROJECT_NAME_MAX_LENGTH);
/** `""` (sau trim) là "không có mô tả" = `null`: DB không nhận chuỗi rỗng, chỉ một cách biểu diễn (spec §7.1). */
export const ProjectDescription = z
  .string()
  .trim()
  .max(EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH)
  .transform((s) => (s === '' ? null : s))
  .nullable();

export const CreateProjectBody = z
  .object({
    name: ProjectName,
    description: ProjectDescription.optional().default(null),
  })
  .strict();
/** Strict (`mergePatchSchema` dựng `z.strictObject`): `status` chỉ đổi qua action archive/unarchive → 422. */
export const PatchProjectBody = mergePatchSchema(
  z.object({ name: ProjectName, description: ProjectDescription }),
);
export const ProjectListQuery = cursorPageQuery()
  .extend({ status: z.enum(PROJECT_STATUSES).optional() })
  .strict();

export const ProjectResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  statusChangedAt: iso,
  createdAt: iso,
  updatedAt: iso,
});
export const ProjectPage = cursorPageSchema(ProjectResponse);

const PublicId = z.uuid();
/** Id không phải UUID là "không có resource như vậy" (404, D7-3), không phải lỗi SQL 22P02 (500). */
export const projectIdOrNotFound = (raw: string): string => {
  const r = PublicId.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};
