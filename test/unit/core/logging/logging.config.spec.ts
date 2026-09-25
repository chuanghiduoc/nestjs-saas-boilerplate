import { describe, expect, it } from 'vitest';
import { productionRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { loggingConfig } from '../../../../src/core/logging/index.js';

describe('loggingConfig', () => {
  it('has no pretty-print option: pino-pretty is not a dependency, so a transport would crash at boot', () => {
    expect(Object.keys(loggingConfig()).sort()).toEqual([
      'extraRedact',
      'level',
    ]);
    expect(
      productionRuleRegistry().some((r) => r.name === 'logging-no-pretty'),
    ).toBe(false);
  });
});
