import { describe, expect, it } from 'vitest';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';

const parse = (env: Record<string, unknown>) =>
  entitlementsConfig.schema.safeParse(env);

describe('entitlements config (spec SP4 §14, R-X10)', () => {
  it('boots with no env at all', () => {
    expect(parse({}).data).toEqual({
      quotaTimezone: 'Asia/Ho_Chi_Minh',
      rowMissingRetryAfterSec: 5,
    });
  });
  it.each([
    [{ quotaTimezone: 'Mars/Olympus' }],
    [{ quotaTimezone: '+07:00' }],
    [{ rowMissingRetryAfterSec: '0' }],
    [{ rowMissingRetryAfterSec: '61' }],
    [{ rowMissingRetryAfterSec: '1.5' }],
  ])('rejects %j', (env) => {
    expect(parse(env).success).toBe(false);
  });
  it('accepts UTC and another IANA zone', () => {
    expect(
      parse({ quotaTimezone: 'UTC', rowMissingRetryAfterSec: '60' }).data,
    ).toEqual({ quotaTimezone: 'UTC', rowMissingRetryAfterSec: 60 });
  });
});
