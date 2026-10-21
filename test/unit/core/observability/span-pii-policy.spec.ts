import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  otelConfig,
  shutdownTelemetry,
  startTelemetry,
} from '../../../../src/core/observability/index.js';
import {
  PiiScrubbingSpanExporter,
  scrubSpan,
} from '../../../../src/core/observability/span-pii-policy.js';
import { autoInstrumentations } from '../../../../src/core/observability/telemetry-lifecycle.js';

const sdkConfigs = vi.hoisted(() => [] as Partial<NodeSDKConfiguration>[]);
vi.mock('@opentelemetry/sdk-node', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@opentelemetry/sdk-node')>();
  class RecordingNodeSDK extends original.NodeSDK {
    constructor(config: Partial<NodeSDKConfiguration>) {
      sdkConfigs.push(config);
      super(config);
    }
  }
  return { ...original, NodeSDK: RecordingNodeSDK };
});

/**
 * Mỗi instrumentation bật ở đây đã được review xem ghi gì vào span (ADR 0014, mục PII trong span). Thêm hay bớt một
 * instrumentation (bản nâng cấp `auto-instrumentations-node` thêm package mới, hoặc config đổi) thì test này đỏ: review
 * attribute/event/status nó ghi, cập nhật `span-pii-policy.ts` nếu cần, rồi mới sửa danh sách.
 * Đang thật sự chạy trong app: http, express, pg, ioredis, undici, pino, runtime-node (chỉ metric); nestjs-core bật
 * nhưng chưa hỗ trợ Nest 12 (`>=4 <12`). Các package còn lại không có trong cây dependency.
 */
const REVIEWED_INSTRUMENTATIONS = [
  '@opentelemetry/instrumentation-amqplib',
  '@opentelemetry/instrumentation-aws-lambda',
  '@opentelemetry/instrumentation-aws-sdk',
  '@opentelemetry/instrumentation-bunyan',
  '@opentelemetry/instrumentation-cassandra-driver',
  '@opentelemetry/instrumentation-connect',
  '@opentelemetry/instrumentation-cucumber',
  '@opentelemetry/instrumentation-dataloader',
  '@opentelemetry/instrumentation-express',
  '@opentelemetry/instrumentation-generic-pool',
  '@opentelemetry/instrumentation-graphql',
  '@opentelemetry/instrumentation-grpc',
  '@opentelemetry/instrumentation-hapi',
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-ioredis',
  '@opentelemetry/instrumentation-kafkajs',
  '@opentelemetry/instrumentation-knex',
  '@opentelemetry/instrumentation-koa',
  '@opentelemetry/instrumentation-lru-memoizer',
  '@opentelemetry/instrumentation-memcached',
  '@opentelemetry/instrumentation-mongodb',
  '@opentelemetry/instrumentation-mongoose',
  '@opentelemetry/instrumentation-mysql2',
  '@opentelemetry/instrumentation-mysql',
  '@opentelemetry/instrumentation-nestjs-core',
  '@opentelemetry/instrumentation-openai',
  '@opentelemetry/instrumentation-oracledb',
  '@opentelemetry/instrumentation-pg',
  '@opentelemetry/instrumentation-pino',
  '@opentelemetry/instrumentation-redis',
  '@opentelemetry/instrumentation-restify',
  '@opentelemetry/instrumentation-runtime-node',
  '@opentelemetry/instrumentation-socket.io',
  '@opentelemetry/instrumentation-tedious',
  '@opentelemetry/instrumentation-undici',
  '@opentelemetry/instrumentation-winston',
];

const span = (over: Partial<ReadableSpan>): ReadableSpan => ({
  name: 'GET',
  kind: SpanKind.INTERNAL,
  spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
  startTime: [0, 0],
  endTime: [0, 1],
  status: { code: SpanStatusCode.UNSET },
  attributes: {},
  links: [],
  events: [],
  duration: [0, 1],
  ended: true,
  resource: undefined as unknown as ReadableSpan['resource'],
  instrumentationScope: { name: 'test' },
  droppedAttributesCount: 0,
  droppedEventsCount: 0,
  droppedLinksCount: 0,
  ...over,
});

describe('span PII policy (spec §15, ADR 0014)', () => {
  afterEach(() => shutdownTelemetry());

  it('startTelemetry exports spans through the scrubbing exporter', () => {
    startTelemetry(
      otelConfig.schema.parse({
        enabled: 'true',
        endpoint: 'http://127.0.0.1:9',
        exportTimeoutMs: '200',
      }),
    );
    expect(sdkConfigs.at(-1)?.traceExporter).toBeInstanceOf(
      PiiScrubbingSpanExporter,
    );
  });

  it('the enabled instrumentations are exactly the reviewed list', () => {
    expect(autoInstrumentations().map((i) => i.instrumentationName)).toEqual(
      REVIEWED_INSTRUMENTATIONS,
    );
  });

  it('url.full loses its query and fragment, absolute or relative; a server span loses url.path', () => {
    expect(
      scrubSpan(
        span({
          kind: SpanKind.CLIENT,
          attributes: {
            'url.full': 'https://api.example.test/a/b?token=t#f',
            'url.path': '/a/b',
          },
        }),
      ).attributes,
    ).toEqual({
      'url.full': 'https://api.example.test/a/b',
      'url.path': '/a/b',
    });
    expect(
      scrubSpan(
        span({
          kind: SpanKind.SERVER,
          attributes: {
            'url.full': '/x?token=t',
            'url.path': '/reset-password/tok',
            'http.route': '/reset-password/:token',
          },
        }),
      ).attributes,
    ).toEqual({ 'url.full': '/x', 'http.route': '/reset-password/:token' });
  });

  it('keeps the error code and the exception class, drops messages; other events pass through', () => {
    const out = scrubSpan(
      span({
        status: { code: SpanStatusCode.ERROR, message: 'bad "a@b.test"' },
        events: [
          {
            name: 'exception',
            time: [0, 0],
            attributes: {
              'exception.type': 'ReplyError',
              'exception.message': 'a@b.test',
              'exception.stacktrace': 'ReplyError: a@b.test',
            },
          },
          { name: 'other', time: [0, 0], attributes: { k: 'v' } },
        ],
      }),
    );
    expect(out.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(out.events.map((e) => e.attributes)).toEqual([
      { 'exception.type': 'ReplyError' },
      { k: 'v' },
    ]);
  });
});
