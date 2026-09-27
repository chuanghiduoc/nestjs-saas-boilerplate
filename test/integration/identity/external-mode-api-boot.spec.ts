import { Global, Module } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreAuthRateLimiter } from '../../../src/core/http/index.js';
import { IdentityModule } from '../../../src/modules/identity/index.js';
import { EXTERNAL_MODE_PENDING_MESSAGE } from '../../../src/modules/identity/identity.module.js';
import { createTestApp } from '../../support/app-factory.js';

/** Không cần Redis cho phép thử này: chỉ kiểm lỗi DI lúc boot, không có request nào. */
@Global()
@Module({
  providers: [{ provide: PreAuthRateLimiter, useValue: {} }],
  exports: [PreAuthRateLimiter],
})
class StubPreAuthModule {}

describe('AUTH_MODE=external on the api before Task 41 (review M4)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('boot fails with the named external-mode error, not a generic DI error', async () => {
    for (const [k, v] of Object.entries({
      AUTH_MODE: 'external',
      AUTH_EXTERNAL_JWKS_URL: 'https://idp.test/jwks',
      AUTH_EXTERNAL_ISSUER: 'https://idp.test',
      AUTH_EXTERNAL_AUDIENCE: 'api',
      AUTH_EXTERNAL_ALGORITHMS: 'RS256',
      AUTH_EXTERNAL_USER_CLAIM: 'idtyp',
      AUTH_EXTERNAL_USER_CLAIM_VALUE: 'user',
    }))
      vi.stubEnv(k, v);
    await expect(
      createTestApp([StubPreAuthModule, IdentityModule.forApi()]),
    ).rejects.toThrow(EXTERNAL_MODE_PENDING_MESSAGE);
  });
});
