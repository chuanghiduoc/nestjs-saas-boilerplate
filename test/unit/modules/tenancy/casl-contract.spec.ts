import * as casl from '@casl/ability';
import { Ability, ForbiddenError } from '@casl/ability';
import { describe, expect, it } from 'vitest';

/** Cùng giá trị với `NO_WILDCARD` của `ability.factory.ts` (Task 17); regex của catalogue bắt đầu bằng [a-z]. */
const SENTINEL = '__no_wildcard__';
const bare = (
  rules: ConstructorParameters<typeof Ability<[string, string]>>[0],
) =>
  new Ability<[string, string]>(rules, {
    anyAction: SENTINEL,
    anySubjectType: SENTINEL,
  });

/**
 * Spike T1 của spec SP3 §4, giữ lại làm test hợp đồng: nâng `@casl/ability` mà đổi bất kỳ điều nào dưới đây thì
 * test đỏ trước khi PoliciesGuard âm thầm đổi nghĩa.
 */
describe('@casl/ability 7.0.1 contract (spike T1)', () => {
  it('loads as ESM under SWC with Ability/ForbiddenError and without the removed PureAbility/rulesToQuery', () => {
    expect(typeof casl.Ability).toBe('function');
    expect(typeof casl.ForbiddenError).toBe('function');
    expect('PureAbility' in casl).toBe(false);
    expect('rulesToQuery' in casl).toBe(false);
  });
  it('the sentinel strips the wildcard meaning of manage/all', () => {
    const a = bare([{ action: 'manage', subject: 'all' }]);
    expect(a.can('read', 'org')).toBe(false);
    expect(a.can('manage', 'all')).toBe(true);
  });
  it('without the sentinel manage/all is a live wildcard (why the catalogue bans them)', () => {
    const a = new Ability<[string, string]>([
      { action: 'manage', subject: 'all' },
    ]);
    expect(a.can('read', 'org')).toBe(true);
  });
  it('a rule whose action equals the sentinel is itself a wildcard (why keys must start with [a-z], U12)', () => {
    expect(
      bare([{ action: SENTINEL, subject: 'org' }]).can('delete', 'org'),
    ).toBe(true);
  });
  it('throwUnlessCan throws an instanceof ForbiddenError whose message names action and subject', () => {
    const a = bare([{ action: 'read', subject: 'org' }]);
    let caught: unknown;
    try {
      ForbiddenError.from(a).throwUnlessCan('delete', 'org');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(caught instanceof Error ? caught.message : '').toBe(
      'Cannot execute "delete" on "org"',
    );
  });
  it('a bare Ability refuses conditions and fields at construction (fail loud)', () => {
    expect(() =>
      bare([{ action: 'read', subject: 'org', conditions: { x: 1 } }]),
    ).toThrow(/conditionsMatcher/);
    expect(() =>
      bare([{ action: 'read', subject: 'org', fields: ['name'] }]),
    ).toThrow(/fieldMatcher/);
  });
  it('an inverted rule wins, matching is exact (no case folding) and dotted actions are whole tokens', () => {
    expect(
      bare([
        { action: 'read', subject: 'org' },
        { action: 'read', subject: 'org', inverted: true },
      ]).can('read', 'org'),
    ).toBe(false);
    const a = bare([
      { action: 'read', subject: 'org' },
      { action: 'role.assign', subject: 'members' },
    ]);
    expect([a.can('Read', 'org'), a.can('read', 'Org')]).toEqual([
      false,
      false,
    ]);
    expect([a.can('role.assign', 'members'), a.can('role', 'members')]).toEqual(
      [true, false],
    );
    expect(bare([]).can('read', 'org')).toBe(false);
  });
});
