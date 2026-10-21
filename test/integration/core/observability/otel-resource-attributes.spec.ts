import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Spike T7-4 (spec SP7 §5), giữ thành test hợp đồng: chart đặt `OTEL_RESOURCE_ATTRIBUTES` từ downward API (spec §12.2);
 * span phải mang các thuộc tính đó mà `telemetry-lifecycle.ts` không khai detector nào. Chạy trong process con vì
 * `NodeSDK` đăng ký provider toàn cục.
 */
const CHILD_TIMEOUT_MS = 30_000;
const ATTRS =
  'k8s.pod.name=pod-7b,k8s.namespace.name=ns-7b,k8s.pod.uid=uid-7b,deployment.environment.name=staging,app.role=worker,app.worker.group=scheduler';
const Attr = z.object({
  key: z.string(),
  value: z.object({ stringValue: z.string().optional() }).passthrough(),
});
const Export = z.object({
  resourceSpans: z.array(
    z.object({ resource: z.object({ attributes: z.array(Attr) }) }),
  ),
});
const CHILD = [
  "import { trace } from '@opentelemetry/api';",
  "import { startTelemetry, shutdownTelemetry } from './src/core/observability/telemetry-lifecycle.ts';",
  "startTelemetry({ enabled: true, endpoint: process.env.PROBE_ENDPOINT, serviceName: 'probe', sampleRatio: 1, metricsIntervalMs: 60000, exportTimeoutMs: 5000 });",
  "trace.getTracer('probe').startSpan('probe-span').end();",
  'await shutdownTelemetry();',
].join(' ');

describe('OTEL_RESOURCE_ATTRIBUTES reaches exported spans (spike T7-4, chart downward API contract)', () => {
  const bodies: string[] = [];
  let server: Server;
  let endpoint = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/v1/traces')
          bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('every attribute of OTEL_RESOURCE_ATTRIBUTES is on the span resource', async () => {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          '@swc-node/register/esm-register',
          '--input-type=module',
          '-e',
          CHILD,
        ],
        {
          env: {
            ...process.env,
            PROBE_ENDPOINT: endpoint,
            OTEL_RESOURCE_ATTRIBUTES: ATTRS,
          },
          stdio: 'inherit',
        },
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('telemetry child did not exit in time'));
      }, CHILD_TIMEOUT_MS);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      child.on('error', reject);
    });
    expect(code).toBe(0);
    const attrs = new Map(
      bodies
        .flatMap((b) => Export.parse(JSON.parse(b)).resourceSpans)
        .flatMap((s) => s.resource.attributes)
        .map((a) => [a.key, a.value.stringValue]),
    );
    for (const pair of ATTRS.split(',')) {
      const [k, v] = pair.split('=');
      expect(attrs.get(k ?? ''), k).toBe(v);
    }
  });
});
