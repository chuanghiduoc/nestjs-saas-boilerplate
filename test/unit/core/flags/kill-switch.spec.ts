import { describe, expect, it } from 'vitest';
import {
  KILL_SWITCH_KEY,
  KILL_SWITCH_KEY_MAX_LENGTH,
  defineKillSwitch,
  findKillSwitch,
  killSwitchRegistry,
} from '../../../../src/core/flags/index.js';

describe('defineKillSwitch registry (spec SP6 §5.3 core/flags)', () => {
  it('registers dotted lower-case keys with a description', () => {
    const def = defineKillSwitch({ key: 'unit.reg_ok', description: 'probe' });
    expect(findKillSwitch('unit.reg_ok')).toBe(def);
    expect(killSwitchRegistry()).toContain(def);
  });
  it.each([
    'nodot',
    'Upper.case',
    'a..b',
    '1a.b',
    'a.b-c',
    `a.${'b'.repeat(KILL_SWITCH_KEY_MAX_LENGTH - 1)}`,
  ])('refuses key %j', (key) => {
    expect(() => defineKillSwitch({ key, description: 'x' })).toThrow(
      /Kill switch key/,
    );
  });
  it('refuses a duplicate key and a blank description', () => {
    defineKillSwitch({ key: 'unit.reg_dup', description: 'first' });
    expect(() =>
      defineKillSwitch({ key: 'unit.reg_dup', description: 'again' }),
    ).toThrow(/already defined/);
    expect(() =>
      defineKillSwitch({ key: 'unit.reg_blank', description: '  ' }),
    ).toThrow(/description/);
  });
  it('the key rule is exactly the kill_switches CHECK of the migration (spec §6.2)', () => {
    expect(KILL_SWITCH_KEY.source).toBe(
      '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$',
    );
    expect(KILL_SWITCH_KEY_MAX_LENGTH).toBe(100);
  });
});
