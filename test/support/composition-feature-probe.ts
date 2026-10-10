/**
 * UP-12c: feature import tĩnh index của tenancy trong khi tenancy bị tắt → composeAppModules phải ném, nêu tên module.
 * Entitlements và integrations cần tenancy (MODULE_REQUIRES) nên tắt cùng.
 */
import '../fixtures/composition/tenancy-importing-feature.js';
import { composeAppModules } from '../../src/boilerplate.modules.js';

let result: { error: string } | { ok: true };
try {
  await composeAppModules({
    disable: ['tenancy', 'entitlements', 'integrations'],
    features: { api: [], worker: [] },
  });
  result = { ok: true };
} catch (err) {
  result = { error: err instanceof Error ? err.message : String(err) };
}
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
