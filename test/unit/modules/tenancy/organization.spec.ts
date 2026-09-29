import { describe, expect, it } from 'vitest';
import { ORG_NAME_MAX_LENGTH } from '../../../../src/modules/tenancy/constants.js';
import {
  orgName,
  orgStateOf,
  transitionOrg,
} from '../../../../src/modules/tenancy/domain/organization.js';

const now = new Date('2026-10-01T00:00:00Z');
const past = new Date('2026-09-30T00:00:00Z');
const future = new Date('2026-10-02T00:00:00Z');

describe('organization lifecycle (spec SP3 §9.4): every (state × event) pair', () => {
  it.each([
    ['ACTIVE', 'SOFT_DELETE', null, { ok: true, to: 'DELETED' }],
    ['ACTIVE', 'RESTORE', null, { ok: false, reason: 'NOT_DELETED' }],
    ['ACTIVE', 'PURGE', null, { ok: false, reason: 'NOT_DELETED' }],
    ['DELETED', 'SOFT_DELETE', future, { ok: false, reason: 'NOT_ACTIVE' }],
    ['DELETED', 'RESTORE', future, { ok: true, to: 'ACTIVE' }],
    ['DELETED', 'RESTORE', past, { ok: false, reason: 'GRACE_EXPIRED' }],
    ['DELETED', 'RESTORE', now, { ok: false, reason: 'GRACE_EXPIRED' }],
    ['DELETED', 'PURGE', past, { ok: true, to: 'PURGED' }],
    ['DELETED', 'PURGE', now, { ok: true, to: 'PURGED' }],
    ['DELETED', 'PURGE', future, { ok: false, reason: 'NOT_DUE' }],
  ] as const)(
    '%s + %s (purgeAfter %s)',
    (state, event, purgeAfter, expected) => {
      expect(transitionOrg(state, event, { now, purgeAfter })).toEqual(
        expected,
      );
    },
  );
  it('a DELETED org without purgeAfter is a data error (CHECK makes it impossible), never a silent answer', () => {
    expect(() =>
      transitionOrg('DELETED', 'RESTORE', { now, purgeAfter: null }),
    ).toThrow(/purge_after/);
  });
  it('orgStateOf reads deleted_at', () => {
    expect([
      orgStateOf({ deletedAt: null }),
      orgStateOf({ deletedAt: past }),
    ]).toEqual(['ACTIVE', 'DELETED']);
  });
});

describe('orgName (Review Focus 1: counted in code points like char_length)', () => {
  it.each([
    ['Acme', true],
    ['😀'.repeat(ORG_NAME_MAX_LENGTH), true],
    ['😀'.repeat(ORG_NAME_MAX_LENGTH + 1), false],
    ['', false],
    [' Acme', false],
    ['Acme ', false],
    ['\tAcme', false],
  ])('%j → %s', (name, ok) => {
    expect(orgName.safeParse(name).success).toBe(ok);
  });
});
