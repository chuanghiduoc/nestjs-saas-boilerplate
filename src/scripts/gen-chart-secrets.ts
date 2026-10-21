import { readFileSync, writeFileSync } from 'node:fs';
import '../core/config/all-configs.js';
import {
  BOILERPLATE_MODULES,
  type ComposeOptions,
  type ModuleEntry,
} from '../boilerplate.modules.js';
import { DEV_INFRA_NAMESPACE } from '../core/config/dev-infra.config.js';
import { configRegistry, secretFieldsOf } from '../core/config/index.js';
import {
  SECRET_ENV_FILE,
  VALUES_SCHEMA_FILE,
  chartSecretsDrift,
  renderChartSecrets,
} from './chart-secrets.js';

const CHECK_FLAG = '--check';

/**
 * `pnpm chart:secrets [--check]` (spec SP7 §6.2). Nạp config của core và của MỌI module nền qua loader của
 * `BOILERPLATE_MODULES` — không qua `app.modules.ts` — nên kết quả chỉ phụ thuộc boilerplate, giống nhau ở mọi clone
 * (module bị dự án tắt vẫn có secret trong allowlist; chart chỉ phát secret mà values khai). Không nạp OPTIONAL_BRIDGES
 * (cầu nối không có config). Không dựng Nest.
 */
// Loader của entitlements đòi một catalogue gói (requirePlans). Script không boot Nest: catalogue tối thiểu này không bao
// giờ được validate hay dùng, chỉ để loader import module và config của nó được đăng ký. `definePlanCatalogue` là hàm
// thuần của API công khai entitlements (src/modules/entitlements/domain/plan-catalogue.ts).
const { definePlanCatalogue } =
  await import('../modules/entitlements/index.js');
const opts: ComposeOptions<string> = {
  features: { api: [], worker: [] },
  plans: definePlanCatalogue({
    defaultPlan: 'tooling',
    plans: { tooling: { values: {} } },
  }),
};

const entries: readonly ModuleEntry<string>[] =
  Object.values(BOILERPLATE_MODULES);
for (const entry of entries) await entry.load(opts);

const fields = secretFieldsOf(
  configRegistry().filter((e) => e.namespace !== DEV_INFRA_NAMESPACE),
);
const expected = renderChartSecrets(
  fields,
  readFileSync(VALUES_SCHEMA_FILE, 'utf8'),
);
if (process.argv.includes(CHECK_FLAG)) {
  const drift = chartSecretsDrift(expected, {
    secretEnv: readFileSync(SECRET_ENV_FILE, 'utf8'),
    valuesSchema: readFileSync(VALUES_SCHEMA_FILE, 'utf8'),
  });
  if (drift.length) {
    process.stderr.write(
      `chart secrets are out of date: ${drift.join(', ')}; run pnpm chart:secrets and commit the result\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `chart secrets up to date (${fields.length} secret env names)\n`,
  );
} else {
  writeFileSync(SECRET_ENV_FILE, expected.secretEnv);
  writeFileSync(VALUES_SCHEMA_FILE, expected.valuesSchema);
  process.stdout.write(`wrote ${SECRET_ENV_FILE} and ${VALUES_SCHEMA_FILE}\n`);
}
