import { afterEach, describe, expect, it, vi } from 'vitest';
import { undiciInstrumentationConfig } from '../../../../src/core/observability/outbound-span-policy.js';
import {
  otelConfig,
  shutdownTelemetry,
  startTelemetry,
} from '../../../../src/core/observability/index.js';

const autoInstrumentations = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@opentelemetry/auto-instrumentations-node', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('@opentelemetry/auto-instrumentations-node')
    >();
  return {
    ...original,
    getNodeAutoInstrumentations: (
      config: Parameters<typeof original.getNodeAutoInstrumentations>[0],
    ) => {
      autoInstrumentations.calls.push(config);
      return original.getNodeAutoInstrumentations(config);
    },
  };
});

const req = (headers: string | string[], path = '/a/b?token=t') => ({
  origin: 'https://api.example.test',
  method: 'POST',
  path,
  headers,
  addHeader: () => undefined,
  throwOnError: false,
  completed: false,
  aborted: false,
  idempotent: false,
  contentLength: null,
  contentType: null,
  body: null,
});
const ignore = (h: string | string[]) =>
  undiciInstrumentationConfig.ignoreRequestHook?.(req(h));

describe('outbound span policy (review 6C I-A, spec SP6 §15)', () => {
  afterEach(() => shutdownTelemetry());

  it('startTelemetry hands the policy to the undici instrumentation', () => {
    startTelemetry(
      otelConfig.schema.parse({
        enabled: 'true',
        endpoint: 'http://127.0.0.1:9',
        exportTimeoutMs: '200',
      }),
    );
    expect(autoInstrumentations.calls.at(-1)).toMatchObject({
      '@opentelemetry/instrumentation-undici': undiciInstrumentationConfig,
    });
  });
  it('a request carrying the Standard Webhooks signature is never traced, whatever the header shape or case', () => {
    expect(
      ignore([
        'content-type',
        'application/json',
        'Webhook-Signature',
        'v1,abc',
      ]),
    ).toBe(true);
    expect(
      ignore('content-type: application/json\r\nwebhook-signature: v1,abc\r\n'),
    ).toBe(true);
    expect(
      ignore([
        'content-type',
        'application/json',
        'x-webhook-signature-note',
        'v1',
      ]),
    ).toBe(false);
    expect(ignore('authorization: Bearer x\r\n')).toBe(false);
  });
  it('every other request keeps its span with url.full stripped of the query and no url.query', () => {
    expect(undiciInstrumentationConfig.startSpanHook?.(req([]))).toEqual({
      'url.full': 'https://api.example.test/a/b',
      'url.query': undefined,
    });
  });
});
