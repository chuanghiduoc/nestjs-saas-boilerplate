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
import { eventRegistry, type EventDef } from '../events/event-definition.js';
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

type Webhooks = NonNullable<OpenAPIObject['webhooks']>;
/** Header Standard Webhooks (spec SP6 §8.3 bước 3), bắt buộc ở mọi lần gửi. */
const WEBHOOK_HEADERS = [
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
] as const;

/**
 * Mục `webhooks` của OpenAPI 3.1 (S6-A36): mỗi event `webhook: true` (hợp đồng công khai do module phát event khai, R-X3) là
 * một webhook `<type>@<version>`. `oasdiff` của CI so mục này như so `paths`, nên đổi payload phá vỡ hợp đồng bị chặn như
 * đổi API. Đọc registry của core (không import module nào); mục có mặt theo cờ của event, như cờ là hợp đồng của chính module đó.
 */
export function webhookDocs(defs: readonly EventDef[] = eventRegistry()): {
  webhooks: Webhooks;
  schemas: Record<string, SchemaObject>;
} {
  const schemas: Record<string, SchemaObject> = {};
  const webhooks: Webhooks = {};
  for (const d of [...defs]
    .filter((x) => x.webhook)
    .sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version)) {
    const envelope = z.object({
      type: z.literal(d.type),
      version: z.literal(d.version),
      timestamp: z.iso.datetime({ offset: true }),
      data: d.schema,
    });
    const { schema, components } = toOpenApiSchema(envelope, 'output');
    Object.assign(schemas, components);
    webhooks[`${d.type}@${d.version}`] = {
      post: {
        summary: `${d.type} version ${d.version}`,
        parameters: WEBHOOK_HEADERS.map((name) => ({
          name,
          in: 'header' as const,
          required: true,
          schema: { type: 'string' },
        })),
        requestBody: {
          required: true,
          content: { 'application/json': { schema } },
        },
        responses: {
          '2XX': {
            description:
              'Any 2xx acknowledges the delivery; anything else is retried on the schedule',
          },
        },
      },
    };
  }
  return { webhooks, schemas };
}

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
  const { webhooks, schemas } = webhookDocs();
  if (Object.keys(webhooks).length > 0) {
    doc.webhooks = webhooks;
    doc.components = {
      ...doc.components,
      schemas: { ...doc.components?.schemas, ...schemas },
    };
  }
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
