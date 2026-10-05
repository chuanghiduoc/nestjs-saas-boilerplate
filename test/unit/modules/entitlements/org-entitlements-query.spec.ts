import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../../src/core/database/index.js';
import { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { OrgEntitlementsQuery } from '../../../../src/modules/entitlements/application/org-entitlements.query.js';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';
import { UsageCounterRepository } from '../../../../src/modules/entitlements/ports/usage-counter.repository.js';

describe('OrgEntitlementsQuery (spec SP4 §12.1: one read transaction; unit with fakes)', () => {
  it('reads the snapshot and the usage inside one UnitOfWork.run callback, with the configured timezone', async () => {
    let depth = 0;
    let runs = 0;
    const calls: string[] = [];
    const m = await Test.createTestingModule({
      providers: [
        OrgEntitlementsQuery,
        {
          provide: UnitOfWork,
          useValue: {
            run: async <T>(fn: () => Promise<T>): Promise<T> => {
              runs += 1;
              depth += 1;
              try {
                return await fn();
              } finally {
                depth -= 1;
              }
            },
          },
        },
        {
          provide: Entitlements,
          useValue: {
            snapshot: () => {
              calls.push(`snapshot in=${String(depth > 0)}`);
              return Promise.resolve({ snapshot: true });
            },
          },
        },
        {
          provide: UsageCounterRepository,
          useValue: {
            currentUsage: (tz: string) => {
              calls.push(`usage(${tz}) in=${String(depth > 0)}`);
              return Promise.resolve({ usage: true });
            },
          },
        },
        {
          provide: entitlementsConfig.KEY,
          useValue: {
            quotaTimezone: 'Asia/Ho_Chi_Minh',
            rowMissingRetryAfterSec: 5,
          },
        },
      ],
    }).compile();
    const r = await m.get(OrgEntitlementsQuery).read();
    expect(r).toEqual({ snapshot: { snapshot: true }, usage: { usage: true } });
    expect(runs).toBe(1);
    expect(calls).toEqual([
      'snapshot in=true',
      'usage(Asia/Ho_Chi_Minh) in=true',
    ]);
  });
});
