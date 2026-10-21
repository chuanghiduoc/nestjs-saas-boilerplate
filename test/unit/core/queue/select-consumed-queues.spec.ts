import { describe, expect, it } from 'vitest';
import {
  selectConsumedQueues,
  type QueueDef,
} from '../../../../src/core/queue/index.js';

const q = (name: string): QueueDef => ({ name, kind: 'io' });
const REGISTRY = [q('maintenance'), q('events'), q('notifications')];
const names = (list: QueueDef[]) => list.map((x) => x.name);

describe('selectConsumedQueues (CO-1, spec SP7 §6.5, S7-D12)', () => {
  it('empty include and exclude consume every registered queue', () => {
    expect(names(selectConsumedQueues(REGISTRY, [], []))).toEqual([
      'maintenance',
      'events',
      'notifications',
    ]);
  });
  it('exclude consumes every registered queue except the listed ones, so new queues get a consumer', () => {
    expect(names(selectConsumedQueues(REGISTRY, [], ['maintenance']))).toEqual([
      'events',
      'notifications',
    ]);
  });
  it('include keeps its explicit list', () => {
    expect(names(selectConsumedQueues(REGISTRY, ['maintenance'], []))).toEqual([
      'maintenance',
    ]);
  });
  it('refuses both lists at once', () => {
    expect(() =>
      selectConsumedQueues(REGISTRY, ['events'], ['maintenance']),
    ).toThrow(
      'WORKER_QUEUES and WORKER_QUEUES_EXCLUDE are mutually exclusive; set only one of them',
    );
  });
  it('refuses an unknown queue in either list, naming the variable', () => {
    expect(() => selectConsumedQueues(REGISTRY, [], ['billing'])).toThrow(
      'WORKER_QUEUES_EXCLUDE contains unknown queue "billing"',
    );
    expect(() => selectConsumedQueues(REGISTRY, ['billing'], [])).toThrow(
      'WORKER_QUEUES contains unknown queue "billing"',
    );
  });
  it('refuses an exclude list that leaves nothing to consume', () => {
    expect(() =>
      selectConsumedQueues(
        REGISTRY,
        [],
        ['maintenance', 'events', 'notifications'],
      ),
    ).toThrow(
      'WORKER_QUEUES_EXCLUDE excludes every registered queue; this worker would consume nothing',
    );
  });
});
