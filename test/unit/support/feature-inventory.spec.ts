import { describe, expect, it } from 'vitest';
import {
  mergeAnalysedColumns,
  mergeFeatureList,
  parseFeatureInventory,
} from '../../support/feature-inventory.js';

const BASE = { 'public.organizations': ['id', 'name'] } as const;

describe('feature inventories (spec SP7 S7-D28)', () => {
  it('without inventories the boilerplate constant is unchanged', () => {
    expect(mergeAnalysedColumns(BASE, {})).toEqual(BASE);
  });
  it('adds the tables a project inventory declares', () => {
    const merged = mergeAnalysedColumns(BASE, {
      'test/integration/features/crm/crm.inventory.ts': {
        tables: [{ table: 'public.crm_leads', columns: ['id', 'org_id'] }],
      },
    });
    expect(merged['public.crm_leads']).toEqual(['id', 'org_id']);
    expect(merged['public.organizations']).toEqual(['id', 'name']);
  });
  it('refuses a table declared twice (boilerplate or another inventory)', () => {
    expect(() =>
      mergeAnalysedColumns(BASE, {
        'a.inventory.ts': {
          tables: [{ table: 'public.organizations', columns: ['id'] }],
        },
      }),
    ).toThrow(
      'a.inventory.ts: table public.organizations is already in the normalization inventory',
    );
  });
  it.each([
    ['a misspelled export', { table: [] }],
    [
      'an unqualified table name',
      { tables: [{ table: 'crm_leads', columns: ['id'] }] },
    ],
    ['no column', { tables: [{ table: 'public.crm_leads', columns: [] }] }],
    [
      'a duplicate column',
      { tables: [{ table: 'public.crm_leads', columns: ['id', 'id'] }] },
    ],
  ])('refuses %s', (_name, mod) => {
    expect(() => parseFeatureInventory('x.inventory.ts', mod)).toThrow(
      /^x\.inventory\.ts: /,
    );
  });
});

describe('feature inventories (spec SP7 S7-D28, D7-8)', () => {
  it('merges definer functions and refuses duplicates against the base and across files', () => {
    expect(
      mergeFeatureList(['a'], 'definerFunctions', {
        f1: { definerFunctions: ['b'] },
      }),
    ).toEqual(['a', 'b']);
    expect(() =>
      mergeFeatureList(['a'], 'definerFunctions', {
        f1: { definerFunctions: ['a'] },
      }),
    ).toThrow('f1: definerFunctions entry a is already declared');
    expect(() =>
      mergeFeatureList([], 'globalTables', {
        f1: { globalTables: ['t'] },
        f2: { globalTables: ['t'] },
      }),
    ).toThrow('f2: globalTables entry t is already declared');
  });
});
