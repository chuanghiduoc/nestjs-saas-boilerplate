import { describe, expect, it } from 'vitest';
import { auditConfig } from '../../../../src/modules/audit/audit.config.js';

const parse = (raw: Record<string, string>) =>
  auditConfig.schema.safeParse(raw);

describe('audit config (spec SP6 §11.3, rulings C1)', () => {
  it('defaults are 13 months retention and 3 months premake', () => {
    expect(auditConfig.schema.parse({})).toEqual({
      retentionMonths: 13,
      partitionPremakeMonths: 3,
    });
  });
  it.each([
    [{ retentionMonths: '5' }, 'retentionMonths'],
    [{ retentionMonths: '121' }, 'retentionMonths'],
    [{ partitionPremakeMonths: '0' }, 'partitionPremakeMonths'],
    [{ partitionPremakeMonths: '13' }, 'partitionPremakeMonths'],
    [{ retentionMonths: '6.5' }, 'retentionMonths'],
  ])('%o is refused at %s', (raw, path) => {
    const r = parse(raw);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain(path);
  });
  it('the floor 6 and the ceiling 120 are accepted', () => {
    expect(parse({ retentionMonths: '6' }).success).toBe(true);
    expect(parse({ retentionMonths: '120' }).success).toBe(true);
  });
});
