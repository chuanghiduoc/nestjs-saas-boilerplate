import { describe, expect, it } from 'vitest';
import {
  migrationZone,
  migrationsNotNewerThanZone,
} from '../../support/migration-zones.js';

const M = (dir: string, ts: string) =>
  `src/migrations/${dir}/Migration${ts}_x.ts`;

describe('migration order per zone (spec SP7 S7-D31, amendment B1)', () => {
  it('classifies app/ as the project zone and everything else (example/ included) as boilerplate', () => {
    expect(migrationZone(M('app', '20270101000000'))).toBe('app');
    expect(
      migrationZone('src\\migrations\\app\\Migration20270101000000_x.ts'),
    ).toBe('app');
    expect(migrationZone(M('tenancy', '20260101000000'))).toBe('boilerplate');
    expect(migrationZone(M('example', '20260101000000'))).toBe('boilerplate');
  });
  it('an upstream migration older than project migrations is fine; each zone is compared with itself', () => {
    const onMain = [M('core', '20260101000000'), M('app', '20270601000000')];
    expect(
      migrationsNotNewerThanZone(onMain, [
        M('tenancy', '20260201000000'),
        M('app', '20270701000000'),
      ]),
    ).toEqual([]);
  });
  it('reports an added migration that is not newer than its own zone on main', () => {
    const onMain = [M('core', '20260301000000'), M('app', '20270601000000')];
    expect(
      migrationsNotNewerThanZone(onMain, [
        M('tenancy', '20260201000000'),
        M('app', '20270501000000'),
      ]),
    ).toEqual([M('tenancy', '20260201000000'), M('app', '20270501000000')]);
  });
});
