import { ConfigValidationError } from './define-config.js';
import {
  configRegistry,
  configRuleRegistry,
  productionRuleRegistry,
} from './config.registry.js';

export function validateAllConfigs(): void {
  const issues: { env: string; message: string }[] = [];
  const values: Record<string, Record<string, unknown>> = {};
  for (const entry of configRegistry()) {
    if (!entry.factory) continue;
    try {
      values[entry.namespace] = entry.factory() as Record<string, unknown>;
    } catch (e) {
      if (e instanceof ConfigValidationError) issues.push(...e.issues);
      else throw e;
    }
  }
  if (issues.length === 0) {
    for (const r of configRuleRegistry()) {
      const msg = r.rule(values);
      if (msg) issues.push({ env: r.name, message: msg });
    }
  }
  if (issues.length === 0 && values.app?.nodeEnv === 'production') {
    for (const r of productionRuleRegistry()) {
      const msg = r.rule(values);
      if (msg) issues.push({ env: r.name, message: msg });
    }
  }
  if (issues.length) throw new ConfigValidationError('all', issues);
}
