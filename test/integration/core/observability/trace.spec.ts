import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  currentTraceparent,
  withRemoteParent,
} from '../../../../src/core/observability/index.js';

const exporter = new InMemorySpanExporter();
describe('trace propagation', () => {
  beforeAll(() => {
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register({
      contextManager: new AsyncLocalStorageContextManager().enable(),
      propagator: new W3CTraceContextPropagator(),
    });
  });
  afterAll(() => {
    propagation.disable();
    context.disable();
    trace.disable();
  });

  it('continues the same trace across an async boundary', async () => {
    const tracer = trace.getTracer('test');
    let parentTraceId = '';
    let carried: string | undefined;
    await tracer.startActiveSpan('http request', async (span) => {
      parentTraceId = span.spanContext().traceId;
      carried = currentTraceparent();
      span.end();
    });
    expect(carried).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    await withRemoteParent(carried, 'job process', async () => {});
    const job = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'job process');
    expect(job?.spanContext().traceId).toBe(parentTraceId);
  });

  it('starts a new root when no traceparent is carried', async () => {
    await withRemoteParent(undefined, 'orphan job', async () => {});
    expect(
      exporter.getFinishedSpans().some((s) => s.name === 'orphan job'),
    ).toBe(true);
  });

  it('records the error class only (no message, no stack) and rethrows', async () => {
    const secret = 'user@example.test';
    await expect(
      withRemoteParent(undefined, 'failing job', async () => {
        throw Object.assign(new TypeError(`boom for ${secret}`), {
          code: '42501',
        });
      }),
    ).rejects.toThrow('boom');
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'failing job');
    expect(span?.status.code).toBe(2);
    expect(span?.attributes).toEqual({
      'error.type': 'TypeError',
      'error.code': '42501',
    });
    expect(span?.events.map((e) => e.attributes)).toEqual([
      { 'exception.type': 'TypeError' },
    ]);
    expect(JSON.stringify(span?.events)).not.toContain(secret);
  });
});
