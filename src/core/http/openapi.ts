import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type SchemaObject,
  type StandardSchemaConverter,
} from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { appConfig } from '../config/index.js';
import { PROBLEM_SCHEMA_NAME } from './api-problems.decorator.js';
import { httpConfig } from './http.config.js';

/** Major version của API công khai (khớp tiền tố /v1). */
export const API_MAJOR_VERSION = '1';
const OPENAPI_VERSION = '3.1.0';
/** JSON Schema dialect của OpenAPI 3.1. */
const JSON_SCHEMA_TARGET = 'draft-2020-12';
/** 128 bit ngẫu nhiên cho nonce CSP (khuyến nghị tối thiểu của CSP3). */
const CSP_NONCE_BYTES = 16;

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string(),
  requestId: z.string(),
  timestamp: z.iso.datetime(),
  errors: z
    .array(
      z.object({ path: z.string(), code: z.string(), message: z.string() }),
    )
    .optional(),
});

/**
 * JSON Schema 2020-12 (zod) và SchemaObject của OpenAPI 3.1 cùng cấu trúc nhưng khác kiểu TS;
 * đây là chỗ chuyển kiểu duy nhất.
 */
function toOpenApiSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
): { schema: SchemaObject; components: Record<string, SchemaObject> } {
  const { $defs, ...rest } = z.toJSONSchema(schema, {
    target: JSON_SCHEMA_TARGET,
    io,
  });
  // `$schema` thuộc về tài liệu, không thuộc schema con; JSON.stringify bỏ giá trị undefined.
  const json: {
    schema: SchemaObject;
    components: Record<string, SchemaObject>;
  } = JSON.parse(
    JSON.stringify({
      schema: { ...rest, $schema: undefined },
      components: $defs ?? {},
    }),
  );
  return json;
}

/**
 * `@nestjs/swagger` mặc định chuyển Standard Schema với target `openapi-3.0` (`nullable: true`),
 * không hợp lệ trong tài liệu 3.1; converter này sinh JSON Schema 2020-12 cho schema zod.
 */
const zodConverter: StandardSchemaConverter = (schema, { schemaType }) =>
  schema instanceof z.ZodType ? toOpenApiSchema(schema, schemaType) : undefined;

export function buildOpenApi(
  app: INestApplication,
  title: string,
): OpenAPIObject {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(title)
      .setVersion(API_MAJOR_VERSION)
      .setOpenAPIVersion(OPENAPI_VERSION)
      .build(),
    { standardSchemaConverter: zodConverter },
  );
  doc.components = {
    ...doc.components,
    schemas: {
      ...doc.components?.schemas,
      [PROBLEM_SCHEMA_NAME]: toOpenApiSchema(problemSchema, 'output').schema,
    },
  };
  return doc;
}

/**
 * Giao diện Scalar tại `HTTP_DOCS_PATH` khi `HTTP_DOCS_ENABLED=true` (production cấm bật).
 * CSP mặc định của helmet (`script-src 'self'`) chặn script CDN và script khởi tạo inline của Scalar,
 * nên route này thay CSP bằng bản cùng mặc định nhưng thêm nonce sinh mới cho mỗi request
 * (không dùng `'unsafe-inline'`). Các route API giữ nguyên CSP chặt.
 */
export function setupApiDocs(app: INestApplication): void {
  const cfg = httpConfig();
  if (!cfg.docsEnabled) return;
  const cdn = cfg.docsCdnUrl;
  if (!cdn)
    throw new Error(
      'HTTP_DOCS_CDN_URL is required when HTTP_DOCS_ENABLED=true',
    );
  const content = buildOpenApi(app, appConfig().serviceName);
  app.use(cfg.docsPath, (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path !== '/')
      return next();
    const nonce = randomBytes(CSP_NONCE_BYTES).toString('base64');
    const csp = helmet.contentSecurityPolicy({
      directives: { scriptSrc: ["'self'", `'nonce-${nonce}'`] },
    });
    csp(req, res, (err?: unknown) => {
      if (err) return next(err);
      apiReference({ content, cdn, nonce })(req, res);
    });
  });
}
