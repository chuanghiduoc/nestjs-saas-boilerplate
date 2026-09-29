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
    ['http-libs-only-in-core-http', 'modules/billing/http/uses-merge-patch.ts'],
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
    [
      'auth-libs-only-in-identity-better-auth',
      'modules/billing/infra/uses-better-auth.ts',
    ],
    [
      'auth-libs-only-in-identity-better-auth',
      'modules/identity/http/uses-kysely.ts',
    ],
    [
      'pg-only-in-identity-better-auth-or-core-database',
      'modules/billing/infra/uses-pg.ts',
    ],
    [
      'jose-only-in-identity-jwks',
      'modules/identity/infra/better-auth/uses-jose.ts',
    ],
    [
      'mail-libs-only-in-notifications-infra',
      'modules/identity/infra/better-auth/uses-nodemailer.ts',
    ],
    [
      'bull-board-only-in-core-queue-dashboard',
      'core/queue/uses-bull-board.ts',
    ],
    [
      'rate-limiter-only-in-core-http-or-identity-better-auth',
      'modules/billing/infra/uses-rate-limiter.ts',
    ],
    [
      'openfeature-only-in-core-flags',
      'modules/billing/infra/uses-openfeature.ts',
    ],
    [
      'notifications-independent-of-identity',
      'modules/notifications/application/uses-identity.ts',
    ],
    ['http-no-database-barrel', 'core/http/uses-database-barrel.ts'],
    [
      'casl-only-in-tenancy-authz-or-http',
      'modules/billing/infra/uses-casl.ts',
    ],
    [
      'identity-notifications-independent-of-tenancy',
      'modules/identity/http/uses-tenancy.ts',
    ],
    [
      'tenancy-test-hooks-only-in-tenancy',
      'features/x/uses-tenancy-test-hooks.ts',
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
