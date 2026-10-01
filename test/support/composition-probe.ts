/**
 * UP-12c (spec SP7 §19): nạp riêng một mục của BOILERPLATE_MODULES trong process này (sau khi đã nạp các module nó
 * cần theo MODULE_REQUIRES) rồi in một dòng JSON: module nào đã được đánh dấu và cron nào mới được đăng ký.
 * Chạy: `node --import @swc-node/register/esm-register test/support/composition-probe.ts <module>`.
 */
import {
  BOILERPLATE_MODULES,
  MODULE_REQUIRES,
  type BoilerplateModuleKey,
  type Composition,
} from '../../src/boilerplate.modules.js';
import { loadedModules } from '../../src/core/config/index.js';
import { cronRegistry } from '../../src/core/scheduler/cron-definition.js';

const modules: Composition<BoilerplateModuleKey>['modules'] =
  BOILERPLATE_MODULES;
const isKey = (k: string): k is BoilerplateModuleKey =>
  Object.hasOwn(BOILERPLATE_MODULES, k);
const key = process.argv[2] ?? '';
if (!isKey(key)) throw new Error(`composition-probe: unknown module "${key}"`);

const requires = new Set<BoilerplateModuleKey>();
const visit = (k: BoilerplateModuleKey): void => {
  for (const r of MODULE_REQUIRES[k])
    if (!requires.has(r)) {
      requires.add(r);
      visit(r);
    }
};
visit(key);
const noFeatures = { features: { api: [], worker: [] } };
for (const k of Object.keys(BOILERPLATE_MODULES).filter(isKey))
  if (requires.has(k)) await modules[k].load(noFeatures);
const before = new Set(cronRegistry().map((c) => c.key));
const loadedBefore = [...loadedModules()];
await modules[key].load(noFeatures);
const result = {
  key,
  requires: [...requires],
  loadedBefore,
  loaded: [...loadedModules()],
  newCrons: cronRegistry()
    .map((c) => c.key)
    .filter((k) => !before.has(k)),
};
// Thoát tường minh sau khi stdout xả xong: module có thể giữ handle (không cần cho probe).
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
