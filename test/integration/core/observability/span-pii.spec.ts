import type { INestApplication } from '@nestjs/common';
import { createRequire } from 'node:module';
import { SpanKind, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { register } from 'import-in-the-middle/register-hooks.mjs';
import request from 'supertest';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PiiScrubbingSpanExporter } from '../../../../src/core/observability/span-pii-policy.js';
import {
  autoInstrumentations,
  moduleNames,
} from '../../../../src/core/observability/telemetry-lifecycle.js';
import {
  installOtelCapture,
  type OtelCapture,
} from '../../../support/otel-capture.js';

/**
 * Spec §15: span không mang PII hay secret. MikroORM 7 chèn giá trị tham số vào chuỗi SQL (`platform.formatQuery`), nên
 * `db.query.text` của instrumentation pg chứa giá trị thật; ioredis ghi tham số lệnh; http/nestjs ghi query và path.
 * Test chạy instrumentation thật (đúng config của `startTelemetry`, nạp qua hook ESM như `instrumentation.ts`) với
 * Postgres/Redis/HTTP thật, và đọc span qua exporter của production.
 */
describe('spans and metrics never carry query values, command args or URL secrets', () => {
  const MARKER = `pii-${v7()}@example.test`;
  let otel: OtelCapture;
  let app: INestApplication;
  let db: import('../../../../src/core/database/index.js').Db;
  let redis: import('../../../../src/core/redis/index.js').RedisClient;

  beforeAll(async () => {
    otel = installOtelCapture((inner) => new PiiScrubbingSpanExporter(inner));
    // Instrumentation và hook ESM phải có trước khi app nạp pg/ioredis/http/express: mọi import của app là động.
    register({ include: moduleNames(autoInstrumentations()) });
    // Vitest nạp `import 'ioredis'` của src bằng URL file đã resolve, nên hook ESM (khớp theo tên module) bỏ qua nó;
    // `node --import instrumentation.js` thì khớp. `require` đi qua require-in-the-middle và patch đúng class mà import
    // sau đó nhận (ESM import một module CJS dùng chung cache của CJS).
    createRequire(import.meta.url)('ioredis');
    const { DatabaseModule, Db } =
      await import('../../../../src/core/database/index.js');
    const { REDIS, RedisModule } =
      await import('../../../../src/core/redis/index.js');
    const { HttpModule, applyHttpDefaults } =
      await import('../../../../src/core/http/index.js');
    const { HealthModule } =
      await import('../../../../src/core/health/index.js');
    const { createTestApp } = await import('../../../support/app-factory.js');
    app = await createTestApp(
      [
        DatabaseModule.forRoot({ relay: false }),
        RedisModule,
        HttpModule,
        HealthModule.forRoot({ http: true }),
      ],
      { beforeInit: applyHttpDefaults },
    );
    db = app.get(Db);
    redis = app.get(REDIS);
  });
  afterAll(async () => {
    await app?.close();
  });

  /** pg/ioredis bật `requireParentSpan`: lệnh chỉ được trace khi nằm trong một span, như trong request/job. */
  const inSpan = (fn: () => Promise<void>) =>
    trace.getTracer('span-pii-test').startActiveSpan('probe', async (span) => {
      try {
        await fn();
      } finally {
        span.end();
      }
    });
  const spansOf = (system: string) =>
    otel.allSpans().filter((s) => s.attributes['db.system.name'] === system);
  /** Mọi nơi trong span có thể mang chuỗi: tên, attribute, status, event, link. */
  const visible = (s: ReadableSpan) =>
    JSON.stringify({
      name: s.name,
      attributes: s.attributes,
      status: s.status,
      events: s.events,
      links: s.links.map((l) => l.attributes),
    });
  const expectNoMarker = async () => {
    for (const s of otel.allSpans()) expect(visible(s)).not.toContain(MARKER);
    expect(JSON.stringify(await otel.dataPoints(''))).not.toContain(MARKER);
  };

  it('a Db.execute with a value, and one failing on that value, leaves no value in pg spans or metrics', async () => {
    otel.reset();
    await inSpan(async () => {
      expect(await db.execute('SELECT ? AS v', [MARKER])).toEqual([
        { v: MARKER },
      ]);
      // 22P02: message của Postgres chứa nguyên giá trị (`invalid input syntax for type uuid: "…"`).
      await expect(db.execute('SELECT ?::uuid AS v', [MARKER])).rejects.toThrow(
        MARKER,
      );
    });
    const pg = spansOf('postgresql');
    expect(pg.map((s) => s.name)).toContain('pg.query:SELECT test');
    expect(pg.some((s) => s.status.code === 2)).toBe(true);
    await expectNoMarker();
  });

  it('Redis commands whose key, value and args carry a value leave it in no span', async () => {
    otel.reset();
    await inSpan(async () => {
      await redis.set(`span-pii:${MARKER}`, MARKER, 'EX', 60);
      expect(await redis.get(`span-pii:${MARKER}`)).toBe(MARKER);
      // Lỗi `unknown command` của Redis lặp lại tham số đầu (`with args beginning with: '…'`).
      await expect(redis.call('NOSUCHCMD', MARKER)).rejects.toThrow(MARKER);
    });
    const ops = spansOf('redis').map((s) => s.attributes['db.operation.name']);
    expect(ops).toEqual(expect.arrayContaining(['set', 'get', 'NOSUCHCMD']));
    await expectNoMarker();
  });

  it('HTTP requests with a value in the query and in the path leave it in no span', async () => {
    otel.reset();
    await request(app.getHttpServer())
      .get(`/health/live?token=${encodeURIComponent(MARKER)}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/no-such-route/${encodeURIComponent(MARKER)}`)
      .expect(404);
    // Span client là của chính supertest (cùng process), không phải request của app: bỏ khỏi phép kiểm.
    const appSpans = otel.allSpans().filter((s) => s.kind !== SpanKind.CLIENT);
    const server = appSpans.filter((s) => s.kind === SpanKind.SERVER);
    expect(
      server.map((s) => s.attributes['http.response.status_code']),
    ).toEqual(expect.arrayContaining([200, 404]));
    expect(server.map((s) => s.attributes['http.route'])).toContain(
      '/health/live',
    );
    for (const s of appSpans) {
      expect(visible(s)).not.toContain(encodeURIComponent(MARKER));
      expect(visible(s)).not.toContain(MARKER);
    }
    expect(JSON.stringify(await otel.dataPoints(''))).not.toContain(
      encodeURIComponent(MARKER),
    );
  });
});
