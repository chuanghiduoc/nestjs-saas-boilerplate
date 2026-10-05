import { Logger, type INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  RequestContext,
  type Principal,
} from '../../../../src/core/context/index.js';
import { UnitOfWork } from '../../../../src/core/database/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { EventPublisher } from '../../../../src/core/events/index.js';
import { EntitlementCatalogueCheck } from '../../../../src/modules/entitlements/application/catalogue-check.js';
import { EntitlementCatalogueRegistry } from '../../../../src/modules/entitlements/application/entitlement-catalogue.registry.js';
import { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import { EntitlementsMetrics } from '../../../../src/modules/entitlements/application/entitlements-metrics.js';
import { Quotas } from '../../../../src/modules/entitlements/application/quotas.service.js';
import type { Limit } from '../../../../src/modules/entitlements/domain/effective-value.js';
import {
  featureCatalogueData,
  mergeFeatureCatalogues,
} from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import { entitlementsConfig } from '../../../../src/modules/entitlements/entitlements.config.js';
import {
  EntitlementsContextError,
  FeatureKindMismatchError,
  QuotaReleaseUnderflowError,
  UnknownFeatureError,
} from '../../../../src/modules/entitlements/errors.js';
import {
  UsageCounterRepository,
  type ConsumedCounter,
} from '../../../../src/modules/entitlements/ports/usage-counter.repository.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

const otel = installOtelCapture();

const ORG = '0198c000-0000-7000-8000-00000000000b';
const FEATURES = mergeFeatureCatalogues([
  featureCatalogueData({
    'q.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 3 } },
    'q.saved': { kind: 'QUOTA', resetPeriod: 'NONE', fallback: { max: 2 } },
    'q.old': {
      kind: 'QUOTA',
      resetPeriod: 'NONE',
      fallback: { max: 2 },
      deprecated: true,
    },
    'q.flag': { kind: 'FLAG', fallback: false },
    'q.cap': { kind: 'LIMIT', fallback: { max: 1 } },
  }),
]);
type State = {
  inTx: boolean;
  orgId: string | undefined;
  principal: Principal | undefined;
  limit: Limit;
  row: ConsumedCounter | undefined;
  used: number;
  consumeCalls: number;
  consumeError: Error | undefined;
  releaseLeft: number | undefined;
  published: { data: unknown; aggregate: unknown; actor: unknown }[];
};
const state: State = {
  inTx: true,
  orgId: ORG,
  principal: undefined,
  limit: { kind: 'MAX', max: 3 },
  row: undefined,
  used: 0,
  consumeCalls: 0,
  consumeError: undefined,
  releaseLeft: 0,
  published: [],
};
const counter = (used: number, version = 1): ConsumedCounter => ({
  id: '41',
  used,
  version,
  periodStart: new Date('2026-09-30T17:00:00.000Z'),
});

describe('Quotas (spec SP4 §6.4, §9.2; unit with fakes)', () => {
  let ref: INestApplicationContext;
  let quotas: Quotas;
  beforeAll(async () => {
    const m = await Test.createTestingModule({
      providers: [
        Quotas,
        EntitlementsMetrics,
        { provide: UnitOfWork, useValue: { inTransaction: () => state.inTx } },
        {
          provide: RequestContext,
          useValue: {
            orgId: () => state.orgId,
            principal: () => state.principal,
          },
        },
        {
          provide: Entitlements,
          useValue: { limitOf: () => Promise.resolve(state.limit) },
        },
        {
          provide: EntitlementCatalogueRegistry,
          useValue: {
            feature: (k: string) => {
              const f = FEATURES.get(k);
              if (!f) throw new UnknownFeatureError(k);
              return f;
            },
          },
        },
        {
          provide: EntitlementCatalogueCheck,
          useValue: { featureId: () => '7' },
        },
        {
          provide: UsageCounterRepository,
          useValue: {
            consume: () => {
              state.consumeCalls += 1;
              return state.consumeError
                ? Promise.reject(state.consumeError)
                : Promise.resolve(state.row);
            },
            usedNow: () => Promise.resolve(state.used),
            release: () => Promise.resolve(state.releaseLeft),
          },
        },
        {
          provide: EventPublisher,
          useValue: {
            publish: (_def: unknown, input: State['published'][number]) => {
              state.published.push(input);
              return Promise.resolve();
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
    ref = await m.init();
    quotas = ref.get(Quotas);
  });
  beforeEach(() => {
    Object.assign(state, {
      inTx: true,
      orgId: ORG,
      principal: undefined,
      limit: { kind: 'MAX', max: 3 },
      row: undefined,
      used: 0,
      consumeCalls: 0,
      consumeError: undefined,
      releaseLeft: 0,
      published: [],
    });
  });

  it('QU-9: outside a UnitOfWork or an organization context → EntitlementsContextError, no SQL', async () => {
    state.inTx = false;
    await expect(quotas.consume('q.calls', 1)).rejects.toBeInstanceOf(
      EntitlementsContextError,
    );
    state.inTx = true;
    state.orgId = undefined;
    await expect(quotas.consume('q.calls', 1)).rejects.toBeInstanceOf(
      EntitlementsContextError,
    );
    expect(state.consumeCalls).toBe(0);
  });
  it('a FLAG, a LIMIT or a deprecated QUOTA → FeatureKindMismatchError; an unknown key → UnknownFeatureError', async () => {
    for (const k of ['q.flag', 'q.cap', 'q.old'])
      await expect(quotas.consume(k, 1), k).rejects.toBeInstanceOf(
        FeatureKindMismatchError,
      );
    await expect(quotas.consume('q.nope', 1)).rejects.toBeInstanceOf(
      UnknownFeatureError,
    );
    expect(state.consumeCalls).toBe(0);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'Review Focus 1: amount %s is refused before any SQL (RangeError)',
    async (amount) => {
      await expect(quotas.consume('q.calls', amount)).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(state.consumeCalls).toBe(0);
    },
  );
  it('amount above the limit → EXCEEDED with the current usage, the consume statement never runs (QU-5)', async () => {
    state.used = 1;
    expect(await quotas.consume('q.calls', 4)).toEqual({
      kind: 'EXCEEDED',
      limit: 3,
      used: 1,
    });
    expect(state.consumeCalls).toBe(0);
  });
  it('0 rows from the guarded statement → EXCEEDED; consumeOrThrow → 422 quota_exceeded with the key in errors[0]', async () => {
    state.used = 3;
    expect(await quotas.consume('q.calls', 1)).toEqual({
      kind: 'EXCEEDED',
      limit: 3,
      used: 3,
    });
    const err: unknown = await quotas
      .consumeOrThrow('q.calls', 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    if (err instanceof AppError)
      expect([err.error.code, err.opts.fields]).toEqual([
        'quota_exceeded',
        [{ path: 'feature', code: 'q.calls', message: 'Quota exceeded' }],
      ]);
  });
  it('an UNLIMITED consume that returns no row is a broken repository contract (fail loud)', async () => {
    state.limit = { kind: 'UNLIMITED' };
    await expect(quotas.consume('q.calls', 1)).rejects.toThrow(
      /UNLIMITED consume/,
    );
  });
  it('CONSUMED carries the receipt; quota.reached is published only by the consume that reaches the limit (S4-D16)', async () => {
    state.row = counter(2);
    expect(await quotas.consume('q.calls', 1)).toEqual({
      kind: 'CONSUMED',
      receipt: {
        featureKey: 'q.calls',
        periodStart: '2026-09-30T17:00:00.000Z',
        amount: 1,
      },
    });
    expect(state.published).toEqual([]);
    state.row = counter(3, 3);
    await quotas.consume('q.calls', 1);
    expect(state.published).toEqual([
      {
        data: {
          orgId: ORG,
          feature: 'q.calls',
          periodStart: '2026-09-30T17:00:00.000Z',
          limit: 3,
          used: 3,
        },
        aggregate: { type: 'usage_counter', id: '41', version: 3 },
        actor: { type: 'system', id: 'entitlements.quotas' },
      },
    ]);
  });
  it.each([
    [
      { type: 'user', id: 'u1' },
      { type: 'user', id: 'u1' },
    ],
    [
      { type: 'api_key', id: 'k1' },
      { type: 'service', id: 'api_key:k1' },
    ],
    [
      { type: 'service', id: 's1' },
      { type: 'service', id: 's1' },
    ],
  ] as const)(
    'Review Focus 5 (unit): principal %o → actor %o',
    async (principal, actor) => {
      state.principal = principal;
      state.row = counter(3);
      await quotas.consume('q.calls', 1);
      expect(state.published.at(-1)?.actor).toEqual(actor);
    },
  );
  it('release: a NONE receipt with a period, a MONTH receipt without one or with a bad date → RangeError', async () => {
    await expect(
      quotas.release({
        featureKey: 'q.saved',
        periodStart: '2026-09-30T17:00:00.000Z',
        amount: 1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      quotas.release({ featureKey: 'q.calls', periodStart: null, amount: 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      quotas.release({
        featureKey: 'q.calls',
        periodStart: 'not a date',
        amount: 1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
  it('releaseAllocation: only a QUOTA with resetPeriod NONE (QU-7); a deprecated QUOTA can still be released', async () => {
    await expect(quotas.releaseAllocation('q.calls', 1)).rejects.toBeInstanceOf(
      FeatureKindMismatchError,
    );
    await expect(quotas.releaseAllocation('q.flag', 1)).rejects.toBeInstanceOf(
      FeatureKindMismatchError,
    );
    await expect(quotas.releaseAllocation('q.old', 1)).resolves.toBeUndefined();
  });
  it('release more than used (repository answers no row) → QuotaReleaseUnderflowError, never clamped to zero', async () => {
    state.releaseLeft = undefined;
    await expect(quotas.releaseAllocation('q.saved', 5)).rejects.toBeInstanceOf(
      QuotaReleaseUnderflowError,
    );
  });
  it('release outside a UnitOfWork → EntitlementsContextError', async () => {
    state.inTx = false;
    await expect(quotas.releaseAllocation('q.saved', 1)).rejects.toBeInstanceOf(
      EntitlementsContextError,
    );
  });
  describe('the period trigger refusing a counter row (spec §15: code and catalogue disagree with the database)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const pgError = (constraint: string): Error =>
      Object.assign(new Error('violation'), { code: '23514', constraint });
    const consumed = async () =>
      (await otel.metric('entitlements_quota_consume_total', {
        feature: 'q.calls',
        result: 'consumed',
      })) ?? 0;

    it('usage_counters_period_ck: one ERROR entitlements_counter_refused with the key, the original error rethrown, no consumed count', async () => {
      const refused = pgError('usage_counters_period_ck');
      state.consumeError = refused;
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const before = await consumed();
      await expect(quotas.consume('q.calls', 1)).rejects.toBe(refused);
      expect(error.mock.calls.map(([m]) => m)).toEqual([
        { event: 'entitlements_counter_refused', feature: 'q.calls' },
      ]);
      expect(await consumed()).toBe(before);
    });
    it('another constraint is rethrown without that log', async () => {
      const other = pgError('usage_counters_used_ck');
      state.consumeError = other;
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await expect(quotas.consume('q.calls', 1)).rejects.toBe(other);
      expect(error).not.toHaveBeenCalled();
    });
  });
});
