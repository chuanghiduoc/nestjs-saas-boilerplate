import { describe, expect, it } from 'vitest';
import { configRuleRegistry } from '../../../src/core/config/config.registry.js';
import { registerCompositionRules } from '../../../src/composition.config.js';

const RULE = 'notifications-retention-outlives-token-ttl';

describe('cross-module config rules follow the enabled set (spec SP7 §6.2, C1)', () => {
  it('registers nothing when only one side of a rule is enabled', () => {
    registerCompositionRules(new Set(['identity']));
    registerCompositionRules(new Set(['notifications']));
    expect(configRuleRegistry().map((r) => r.name)).not.toContain(RULE);
  });
  it('registers the retention rule once both identity and notifications are enabled', () => {
    registerCompositionRules(new Set(['notifications', 'identity', 'tenancy']));
    expect(configRuleRegistry().map((r) => r.name)).toContain(RULE);
  });
});
