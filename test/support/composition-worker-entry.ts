/**
 * UP-12b: worker thật (`bootstrapWorker` + `AppWorkerModule`) cộng module fixture `fixturemod` nạp qua `composeFrom`.
 * `COMPOSITION_FIXTURE_DISABLE=fixturemod` tắt nó. Sau khi boot (StaticScheduler đã sync), in một dòng
 * `COMPOSITION_PROBE <json>` rồi báo `{ ready: true }` qua IPC (test/support/app-process.ts).
 */
import { Module } from '@nestjs/common';
import { AppWorkerModule } from '../../src/app-worker.module.js';
import { composeFrom } from '../../src/boilerplate.modules.js';
import { configRuleRegistry } from '../../src/core/config/config.registry.js';
import {
  configRegistry,
  defineConfigRule,
  renderEnvExample,
} from '../../src/core/config/index.js';
import { JobScheduler, queueRegistry } from '../../src/core/queue/index.js';
import { cronRegistry } from '../../src/core/scheduler/cron-definition.js';
import { bootstrapWorker } from '../../src/main.worker.js';
import { installShutdown } from '../../src/shutdown.js';
import { isSignalRelay } from './spawn-worker.js';

const disable: 'fixturemod'[] =
  process.env.COMPOSITION_FIXTURE_DISABLE === 'fixturemod'
    ? ['fixturemod']
    : [];
const fixture = await composeFrom<'fixturemod'>(
  {
    modules: {
      fixturemod: {
        load: async () => {
          const m = await import('../fixtures/composition/fixturemod/index.js');
          return { api: m.FixturemodModule, worker: m.FixturemodModule };
        },
      },
    },
    requires: { fixturemod: [] },
    bridges: [],
    registerRules: (enabled) => {
      if (enabled.has('fixturemod'))
        defineConfigRule('fixturemod-rule', () => undefined);
    },
  },
  { disable, features: { api: [], worker: [] } },
);

@Module({ imports: [AppWorkerModule, ...fixture.worker] })
class CompositionWorkerModule {}

const ctx = await bootstrapWorker(CompositionWorkerModule);
installShutdown(ctx);
process.on('message', (m: unknown) => {
  if (isSignalRelay(m)) process.emit(m.signal, m.signal);
});
const probe = {
  queues: queueRegistry().map((q) => q.name),
  crons: cronRegistry().map((c) => c.key),
  namespaces: configRegistry().map((e) => e.namespace),
  rules: configRuleRegistry().map((r) => r.name),
  envExampleHasFixture:
    renderEnvExample(configRegistry()).includes('FIXTUREMOD_'),
  schedulers: await ctx.get(JobScheduler).listIds('static-'),
};
process.stdout.write(`COMPOSITION_PROBE ${JSON.stringify(probe)}\n`);
process.send?.({ ready: true });
