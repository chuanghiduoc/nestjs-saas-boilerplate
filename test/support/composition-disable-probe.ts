/**
 * X-9 (spec SP6 §16, UP-12b của SP7 với module thật): composition của ứng dụng với `disable: [<m>]`, rồi validate config và
 * in một dòng JSON về registry. Chạy: `node --import @swc-node/register/esm-register test/support/composition-disable-probe.ts <m>`.
 */
// Namespace config của core (app, queue, outbox, otel…) như mọi entry thật: luật chéo (shutdown-budget…) đòi chúng.
import '../../src/core/config/all-configs.js';
import {
  BOILERPLATE_MODULES,
  composeAppModules,
  type BoilerplateModuleKey,
} from '../../src/boilerplate.modules.js';
import {
  configRegistry,
  loadedModules,
  validateAllConfigs,
} from '../../src/core/config/index.js';
import { jobRegistry, queueRegistry } from '../../src/core/queue/index.js';
import { cronRegistry } from '../../src/core/scheduler/cron-definition.js';
import { examplePlans } from '../../src/plans.example.js';

const isKey = (k: string): k is BoilerplateModuleKey =>
  Object.hasOwn(BOILERPLATE_MODULES, k);
const key = process.argv[2] ?? '';
if (!isKey(key))
  throw new Error(`composition-disable-probe: unknown module "${key}"`);
await composeAppModules({
  disable: [key],
  features: { api: [], worker: [] },
  plans: examplePlans,
});
let validation = 'ok';
try {
  validateAllConfigs();
} catch (err) {
  validation = err instanceof Error ? err.message : String(err);
}
const result = {
  loaded: [...loadedModules()],
  namespaces: configRegistry().map((e) => e.namespace),
  queues: queueRegistry().map((q) => q.name),
  jobs: jobRegistry().map((j) => j.name),
  crons: cronRegistry().map((c) => c.key),
  validation,
};
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
