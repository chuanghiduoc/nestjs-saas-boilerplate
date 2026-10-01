import { describe, expect, it } from 'vitest';
import {
  BOILERPLATE_MODULES,
  type BoilerplateModuleKey,
  type Composition,
} from '../../../src/boilerplate.modules.js';
import { MaintenanceQueue } from '../../../src/core/queue/index.js';
import { cronRegistry } from '../../../src/core/scheduler/cron-definition.js';

/** Import lạnh cây module của mọi module nền (better-auth, BullMQ, …) qua swc: rộng hơn nhiều so với thực tế. */
const IMPORT_ALL_MODULES_TIMEOUT_MS = 60_000;
const modules: Composition<BoilerplateModuleKey>['modules'] =
  BOILERPLATE_MODULES;
const isKey = (k: string): k is BoilerplateModuleKey =>
  Object.hasOwn(BOILERPLATE_MODULES, k);

/**
 * Review L4 (spec SP7 §6.2, quy ước cron trong docs/boilerplate/README.md): worker chỉ liệt kê scheduler trên queue đã
 * đăng ký, nên `static-<m>.*` của module bị tắt chỉ được gỡ khi job của cron nằm ở queue vẫn còn đăng ký. Mọi cron tĩnh
 * của boilerplate (core và mọi module nền) phải chạy ở `maintenance`; module của SP sau (R-X16) cũng vậy.
 */
describe(
  'every boilerplate static cron runs on the maintenance queue (review L4)',
  { timeout: IMPORT_ALL_MODULES_TIMEOUT_MS },
  () => {
    it('loads every boilerplate module and finds no cron on another queue', async () => {
      for (const k of Object.keys(BOILERPLATE_MODULES).filter(isKey))
        await modules[k].load({ features: { api: [], worker: [] } });
      const crons = cronRegistry();
      expect(crons.length).toBeGreaterThan(0);
      expect(
        crons
          .filter((c) => c.job.queue.name !== MaintenanceQueue.name)
          .map((c) => `${c.key} -> ${c.job.queue.name}`),
      ).toEqual([]);
    });
  },
);
