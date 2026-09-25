import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { ErrorCode } from '../errors/index.js';

export const PROBLEM_SCHEMA_NAME = 'Problem';
const PROBLEM_JSON = 'application/problem+json';

/**
 * Khai báo trong OpenAPI các lỗi route có thể trả. Nhiều mã cùng status được gộp vào một response
 * (OpenAPI chỉ có một response mỗi status), mô tả liệt kê từng `code`.
 */
export const ApiProblems = (...errors: ErrorCode[]) => {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const e of errors)
    byStatus.set(e.status, [...(byStatus.get(e.status) ?? []), e]);
  return applyDecorators(
    ...[...byStatus].map(([status, codes]) =>
      ApiResponse({
        status,
        description: codes.map((e) => `${e.code}: ${e.title}`).join('; '),
        content: {
          [PROBLEM_JSON]: {
            schema: { $ref: `#/components/schemas/${PROBLEM_SCHEMA_NAME}` },
          },
        },
      }),
    ),
  );
};
