import { z } from 'zod';
import { defineConfig } from '../config/index.js';

/** Không có trường bắt buộc: schema query được dựng lúc import controller. */
export const paginationConfig = defineConfig(
  'pagination',
  {
    maxPageSize: 'PAGINATION_MAX_PAGE_SIZE',
    defaultPageSize: 'PAGINATION_DEFAULT_PAGE_SIZE',
    maxOffsetRows: 'PAGINATION_MAX_OFFSET_ROWS',
    totalCountCap: 'PAGINATION_TOTAL_COUNT_CAP',
  },
  z
    .object({
      maxPageSize: z.coerce
        .number()
        .int()
        .positive()
        .default(100)
        .describe('Upper bound for pageSize/limit'),
      defaultPageSize: z.coerce
        .number()
        .int()
        .positive()
        .default(20)
        .describe('Default pageSize/limit'),
      maxOffsetRows: z.coerce
        .number()
        .int()
        .positive()
        .default(10000)
        .describe('Max page*pageSize for offset pagination'),
      totalCountCap: z.coerce
        .number()
        .int()
        .positive()
        .default(10000)
        .describe(
          'totalCount is exact up to this cap; above it totalCountExact=false',
        ),
    })
    .refine((c) => c.defaultPageSize <= c.maxPageSize, {
      message:
        'PAGINATION_DEFAULT_PAGE_SIZE must be <= PAGINATION_MAX_PAGE_SIZE',
      path: ['defaultPageSize'],
    })
    // Đếm không chính xác (vượt trần) phải kéo theo "trang kế vượt maxOffsetRows", nếu không
    // Paginator.offset không biết đâu là trang cuối và báo hasMore=true mãi.
    .refine((c) => c.totalCountCap >= c.maxOffsetRows, {
      message:
        'PAGINATION_TOTAL_COUNT_CAP must be >= PAGINATION_MAX_OFFSET_ROWS',
      path: ['totalCountCap'],
    }),
);
