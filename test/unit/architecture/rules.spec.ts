import { cruise, type IConfiguration } from 'dependency-cruiser';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const config: IConfiguration = require('../../../.dependency-cruiser.cjs');
const Report = z.object({
  summary: z.object({
    violations: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        rule: z.object({ name: z.string(), severity: z.string() }),
      }),
    ),
  }),
});

async function violations(path: string) {
  const result = await cruise([path], {
    ...config.options,
    validate: true,
    ruleSet: config,
    outputType: 'json',
  });
  return Report.parse(
    typeof result.output === 'string'
      ? JSON.parse(result.output)
      : result.output,
  ).summary.violations;
}

describe('architecture rules', async () => {
  const found = await violations('test/architecture/fixtures/src');
  it.each([
    ['features-only-public-api', 'features/x/leak.ts'],
    ['modules-only-index-of-other-modules', 'modules/tenancy/deep.ts'],
    ['core-independent', 'core/bad-core.ts'],
    ['orm-only-in-infra', 'core/http/uses-orm.ts'],
    ['bullmq-only-in-core-queue', 'features/x/uses-bullmq.ts'],
    ['http-platform-only-in-core-http', 'modules/billing/http/uses-express.ts'],
    ['domain-pure', 'modules/billing/domain/bad.ts'],
    ['no-circular', 'modules/a/cycle-a.ts'],
    ['http-libs-only-in-core-http', 'modules/billing/http/uses-throttler.ts'],
    ['http-libs-only-in-core-http', 'modules/billing/http/uses-idem.ts'],
    [
      'outbound-libs-only-in-core-resilience',
      'modules/billing/infra/uses-undici.ts',
    ],
    ['outbound-libs-only-in-core-resilience', 'core/http/uses-ipaddr.ts'],
    [
      'redis-client-only-in-core-redis-or-http',
      'modules/billing/infra/uses-ioredis.ts',
    ],
    [
      'http-docs-libs-only-in-core-http',
      'modules/billing/http/uses-swagger.ts',
    ],
  ])('%s catches %s', (rule, file) => {
    expect(
      found.some(
        (v) =>
          v.rule.name === rule &&
          v.rule.severity === 'error' &&
          v.from.endsWith('/' + file),
      ),
    ).toBe(true);
  });
  it('allows public APIs, same-module internals and reviewed library owners', () => {
    expect(found.filter((v) => /(?:ok|repo)\.ts$/.test(v.from))).toEqual([]);
    expect(
      found
        .filter((v) => v.rule.name === 'modules-only-index-of-other-modules')
        .map((v) => v.from),
    ).toEqual(['test/architecture/fixtures/src/modules/tenancy/deep.ts']);
  });
  it('real source tree has no violations', async () => {
    expect(await violations('src')).toEqual([]);
  });
});
