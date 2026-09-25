import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import { paginationConfig } from './pagination.config.js';

export type OffsetPage<T> = {
  url: string;
  data: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalCountExact: boolean;
  hasMore: boolean;
};
export type CursorPage<T> = {
  url: string;
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

const DESC_PREFIX = '-';

/**
 * Query `?page=&pageSize=&sort=`. `sort` là một trường trong allowlist, tiền tố `-` là giảm dần;
 * đầu ra là `{ field, direction }` đã kiểm tra nên chuỗi của client không bao giờ vào SQL.
 */
export function offsetPageQuery<
  const S extends readonly [string, ...string[]],
>(opts: { sortable: S }) {
  const cfg = paginationConfig();
  const sortField = z.enum(opts.sortable);
  return z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce
        .number()
        .int()
        .min(1)
        .max(cfg.maxPageSize)
        .default(cfg.defaultPageSize),
      sort: z
        .string()
        .transform((s, ctx) => {
          const desc = s.startsWith(DESC_PREFIX);
          const field = sortField.safeParse(
            desc ? s.slice(DESC_PREFIX.length) : s,
          );
          if (!field.success) {
            ctx.addIssue({
              code: 'invalid_value',
              values: [...opts.sortable],
              input: s,
              message: `sort must be one of ${opts.sortable.join(', ')} (prefix ${DESC_PREFIX} for desc)`,
            });
            return z.NEVER;
          }
          return {
            field: field.data,
            direction: desc ? ('desc' as const) : ('asc' as const),
          };
        })
        .optional(),
    })
    .refine((q) => q.page * q.pageSize <= cfg.maxOffsetRows, {
      message: `page*pageSize must be <= ${cfg.maxOffsetRows}`,
      path: ['page'],
    });
}

export function cursorPageQuery() {
  const cfg = paginationConfig();
  return z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(cfg.maxPageSize)
      .default(cfg.defaultPageSize),
    cursor: z.string().min(1).optional(),
  });
}

export const offsetPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    url: z.string(),
    data: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    totalCount: z.number().int(),
    totalCountExact: z.boolean(),
    hasMore: z.boolean(),
  });
export const cursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    url: z.string(),
    data: z.array(item),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  });

@Injectable()
export class Paginator {
  constructor(
    private readonly ctx: RequestContext,
    @Inject(paginationConfig.KEY)
    private readonly cfg: ConfigOf<typeof paginationConfig>,
  ) {}

  /** `countUpToCap` là kết quả của `countUpTo(..., cfg.totalCountCap)`: lớn hơn trần nghĩa là "nhiều hơn trần". */
  offset<T>(
    data: T[],
    q: { page: number; pageSize: number },
    countUpToCap: number,
  ): OffsetPage<T> {
    const exact = countUpToCap <= this.cfg.totalCountCap;
    const totalCount = exact ? countUpToCap : this.cfg.totalCountCap;
    const nextPageAllowed = (q.page + 1) * q.pageSize <= this.cfg.maxOffsetRows;
    const moreRows = !exact || q.page * q.pageSize < totalCount;
    return {
      url: this.url(),
      data,
      page: q.page,
      pageSize: q.pageSize,
      totalCount,
      totalCountExact: exact,
      hasMore: moreRows && nextPageAllowed,
    };
  }

  cursor<T>(
    data: T[],
    next: { hasMore: boolean; nextCursor: string | null },
  ): CursorPage<T> {
    if (next.hasMore && !next.nextCursor)
      throw new Error('Paginator.cursor: hasMore=true requires a nextCursor');
    return {
      url: this.url(),
      data,
      hasMore: next.hasMore,
      nextCursor: next.hasMore ? next.nextCursor : null,
    };
  }

  private url(): string {
    const path = this.ctx.path();
    if (!path)
      throw new Error('Paginator used outside of an HTTP request context');
    return path;
  }
}
