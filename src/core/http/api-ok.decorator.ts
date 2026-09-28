import { ApiOkResponse } from '@nestjs/swagger';
import type { z } from 'zod';

/**
 * Schema của response 200 trong OpenAPI từ chính schema zod mà handler `serialize` (Standard Schema của
 * `@nestjs/swagger`, chuyển sang JSON Schema 2020-12 bằng converter của `buildOpenApi`).
 */
export const ApiOk = (schema: z.ZodType): MethodDecorator & ClassDecorator =>
  ApiOkResponse({ description: 'OK', standardSchema: schema });
