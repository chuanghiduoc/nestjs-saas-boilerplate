import { describe, expect, it } from 'vitest';
import { configRuleRegistry } from '../../../../src/core/config/config.registry.js';
import { integrationsConfig } from '../../../../src/modules/integrations/integrations.config.js';

const parse = (raw: Record<string, string>) =>
  integrationsConfig.schema.safeParse(raw);
const bulkheadRule = () => {
  const r = configRuleRegistry().find(
    (x) => x.name === 'webhooks-bulkhead-covers-concurrency',
  );
  if (!r) throw new Error('rule not registered');
  return r.rule;
};

describe('integrations config (spec SP6 §11.4)', () => {
  it('defaults match the spec table', () => {
    expect(integrationsConfig.schema.parse({})).toMatchObject({
      maxEndpointsPerOrg: 10,
      maxEventTypesPerEndpoint: 50,
      webhookTimeoutMs: 5000,
      deliveryLeaseMs: 60000,
      retryScheduleSec: [5, 300, 1800, 7200, 18000, 36000, 36000],
      endpointDisableAfterSec: 432000,
      secretRotationOverlapSec: 86400,
      deliveryRetentionMonths: 1,
      partitionPremakeMonths: 3,
      endpointPurgeDelaySec: 5356800,
      recoverBatchMax: 1000,
      killedRecheckSec: 60,
      localFaultRetrySec: 30,
      maxLocalFailures: 5,
      maxInflightPerEndpoint: 4,
      bulkheadLimit: 20,
      bulkheadQueue: 100,
      sweepCron: '*/5 * * * *',
      sweepTz: 'UTC',
      sweepBatchSize: 100,
      sweepMaxBatches: 20,
      sweepGraceSec: 120,
      sweepRequeueMaxPerOrg: 100,
    });
  });
  it.each([
    [{ retryScheduleSec: '' }, 'retryScheduleSec'],
    [{ retryScheduleSec: '5,abc' }, 'retryScheduleSec'],
    [{ retryScheduleSec: '0' }, 'retryScheduleSec'],
    [
      { retryScheduleSec: Array.from({ length: 21 }, () => '1').join(',') },
      'retryScheduleSec',
    ],
    [{ webhookTimeoutMs: '999' }, 'webhookTimeoutMs'],
    [{ webhookTimeoutMs: '30001' }, 'webhookTimeoutMs'],
    [{ maxEndpointsPerOrg: '101' }, 'maxEndpointsPerOrg'],
    [{ maxEventTypesPerEndpoint: '51' }, 'maxEventTypesPerEndpoint'],
    [{ maxLocalFailures: '0' }, 'maxLocalFailures'],
    [{ maxLocalFailures: '101' }, 'maxLocalFailures'],
    [{ maxInflightPerEndpoint: '0' }, 'maxInflightPerEndpoint'],
    [{ maxInflightPerEndpoint: '20' }, 'maxInflightPerEndpoint'],
    [{ sweepRequeueMaxPerOrg: '1001' }, 'sweepRequeueMaxPerOrg'],
    [{ deliveryRetentionMonths: '0' }, 'deliveryRetentionMonths'],
    [{ deliveryRetentionMonths: '25' }, 'deliveryRetentionMonths'],
    [{ secretRotationOverlapSec: '604801' }, 'secretRotationOverlapSec'],
    [{ localFaultRetrySec: '3601' }, 'localFaultRetrySec'],
    [{ sweepGraceSec: '86401' }, 'sweepGraceSec'],
    [{ sweepBatchSize: '1001' }, 'sweepBatchSize'],
    [{ sweepCron: 'nope' }, 'sweepCron'],
    [{ sweepTz: 'Mars/Olympus' }, 'sweepTz'],
  ])('refuses %j', (raw, path) => {
    const r = parse(raw);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain(path);
  });
  it('refuses a timeout not below the lease, a disable window shorter than the schedule, and a purge delay shorter than (retention + 1) x 31 days', () => {
    expect(
      parse({ webhookTimeoutMs: '5000', deliveryLeaseMs: '5000' }).success,
    ).toBe(false);
    expect(
      parse({ retryScheduleSec: '100,100', endpointDisableAfterSec: '199' })
        .success,
    ).toBe(false);
    expect(
      parse({
        deliveryRetentionMonths: '2',
        endpointPurgeDelaySec: String(3 * 31 * 86400 - 1),
      }).success,
    ).toBe(false);
    expect(
      parse({
        deliveryRetentionMonths: '2',
        endpointPurgeDelaySec: String(3 * 31 * 86400),
      }).success,
    ).toBe(true);
  });
  it('bulkhead must cover the concurrency of webhooks-out, counting operator overrides (W-34)', () => {
    const rule = bulkheadRule();
    const base = {
      integrations: { bulkheadLimit: 20 },
      queue: { ioConcurrency: 20, concurrencyOverrides: {} },
      resilience: { overrides: {} },
    };
    expect(rule(base)).toBeUndefined();
    expect(
      rule({ ...base, queue: { ioConcurrency: 21, concurrencyOverrides: {} } }),
    ).toMatch(/INTEGRATIONS_WEBHOOK_BULKHEAD_LIMIT \(20\).*\(21\)/);
    expect(
      rule({
        ...base,
        queue: {
          ioConcurrency: 20,
          concurrencyOverrides: { 'webhooks-out': 30 },
        },
      }),
    ).toMatch(/\(30\)/);
    expect(
      rule({
        ...base,
        resilience: { overrides: { 'webhooks-out': { bulkheadLimit: 5 } } },
      }),
    ).toMatch(/\(5\)/);
    expect(rule({ queue: { ioConcurrency: 20 } })).toMatch(
      /needs the integrations and queue namespaces/,
    );
  });
});
