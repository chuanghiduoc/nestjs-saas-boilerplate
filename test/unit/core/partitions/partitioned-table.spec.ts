import { describe, expect, it } from 'vitest';
import {
  NO_PARTITIONS,
  definePartitionedTable,
  monthsAhead,
  partitionedTableRegistry,
  tableOfPartition,
} from '../../../../src/core/partitions/index.js';

const one = () => 1;
describe('definePartitionedTable (spec SP6 §5.3 core/partitions)', () => {
  it('registers an entry that may maintain several tables with one function', () => {
    const def = definePartitionedTable({
      tables: ['unit_a', 'unit_b'],
      maintainFunction: 'unit_ab_maintain',
      lockKey: 7001n,
      retentionMonths: one,
      premakeMonths: one,
    });
    expect(partitionedTableRegistry()).toContain(def);
    expect(tableOfPartition(def, 'unit_b_p202609')).toBe('unit_b');
    expect(() => tableOfPartition(def, 'unit_c_p202609')).toThrow(
      /does not belong/,
    );
    expect(() => tableOfPartition(def, 'unit_a_p2026')).toThrow(
      /does not belong/,
    );
  });
  // Tiêu đề không dùng `%j`: `JSON.stringify` ném trên `bigint` (`lockKey`) và Vitest 5.0.1 chỉ nuốt lỗi "circular"
  // (`vitest/dist/chunks/display.*.js`), nên cả file không collect được. `%#` là chỉ số của dòng trong bảng.
  it.each([
    [
      { tables: [], maintainFunction: 'x_maintain', lockKey: 7002n },
      /at least one table/,
    ],
    [
      { tables: ['Bad'], maintainFunction: 'x_maintain', lockKey: 7003n },
      /table name/,
    ],
    [
      { tables: ['x_t'], maintainFunction: 'public.x', lockKey: 7004n },
      /maintainFunction/,
    ],
    [
      { tables: ['unit_a'], maintainFunction: 'y_maintain', lockKey: 7005n },
      /already maintained/,
    ],
    [
      { tables: ['z_t'], maintainFunction: 'unit_ab_maintain', lockKey: 7006n },
      /already registered/,
    ],
    [
      { tables: ['w_t'], maintainFunction: 'w_maintain', lockKey: 7001n },
      /lockKey 7001 is already used/,
    ],
  ] as const)('refuses entry %#', (partial, re) => {
    expect(() =>
      definePartitionedTable({
        ...partial,
        retentionMonths: one,
        premakeMonths: one,
      }),
    ).toThrow(re);
  });
});
describe('monthsAhead (gauge db_partition_months_ahead)', () => {
  const now = new Date('2026-09-29T23:59:00Z');
  it.each([
    ['202609', 0],
    ['202612', 3],
    ['202701', 4],
    ['202608', -1],
  ] as const)('newest %s → %i months ahead of the UTC month', (newest, n) => {
    expect(monthsAhead(newest, now)).toBe(n);
  });
  it('no partition at all is NO_PARTITIONS', () => {
    expect(monthsAhead(null, now)).toBe(NO_PARTITIONS);
  });
});
