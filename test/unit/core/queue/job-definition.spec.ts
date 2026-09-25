import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  decodeJobData,
  defineJob,
  defineQueue,
  encodeJobData,
  JobPayloadError,
  queueConfig,
} from '../../../../src/core/queue/index.js';
import { ConfigValidationError } from '../../../../src/core/config/index.js';

const q = defineQueue('unit-q', { kind: 'io' });
const job = defineJob({
  name: 'unit.echo',
  queue: q,
  version: 2,
  schema: z.object({ n: z.number().int() }),
});

describe('job data codec', () => {
  it('round-trips payload with version and meta', () => {
    const data = encodeJobData(job, { n: 1 }, { requestId: 'r1' });
    expect(data).toEqual({ v: 2, p: { n: 1 }, meta: { requestId: 'r1' } });
    expect(decodeJobData(job, data).payload).toEqual({ n: 1 });
  });
  it('rejects unknown version and invalid shape', () => {
    expect(() => decodeJobData(job, { v: 3, p: { n: 1 }, meta: {} })).toThrow(
      JobPayloadError,
    );
    expect(() => decodeJobData(job, { v: 2, p: { n: 'x' }, meta: {} })).toThrow(
      JobPayloadError,
    );
  });
  it('rejects a non-object envelope and a non-uuid orgId in meta', () => {
    expect(() => decodeJobData(job, 'garbage')).toThrow(JobPayloadError);
    expect(() =>
      decodeJobData(job, { v: 2, p: { n: 1 }, meta: { orgId: 'nope' } }),
    ).toThrow(JobPayloadError);
    expect(() => encodeJobData(job, { n: 1 }, { orgId: 'nope' })).toThrow(
      JobPayloadError,
    );
  });
  it('rejects duplicate queue and job names, and ":" in names', () => {
    expect(() => defineQueue('unit-q', { kind: 'io' })).toThrow(
      /already defined/,
    );
    expect(() =>
      defineJob({
        name: 'unit.echo',
        queue: q,
        version: 1,
        schema: z.object({}),
      }),
    ).toThrow(/already defined/);
    expect(() => defineQueue('bad:q', { kind: 'io' })).toThrow(/name/);
  });
});

describe('queue config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('parses WORKER_QUEUES and QUEUE_CONCURRENCY_OVERRIDES', () => {
    vi.stubEnv('WORKER_QUEUES', ' a, b ,,');
    vi.stubEnv('QUEUE_CONCURRENCY_OVERRIDES', 'a=2, b=50');
    const cfg = queueConfig();
    expect(cfg.workerQueues).toEqual(['a', 'b']);
    expect(cfg.concurrencyOverrides).toEqual({ a: 2, b: 50 });
  });
  it('rejects a malformed concurrency override', () => {
    vi.stubEnv('QUEUE_CONCURRENCY_OVERRIDES', 'a=0');
    expect(() => queueConfig()).toThrow(ConfigValidationError);
  });
});
