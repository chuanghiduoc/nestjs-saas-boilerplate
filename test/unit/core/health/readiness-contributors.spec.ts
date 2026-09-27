import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it } from 'vitest';
import { Db } from '../../../../src/core/database/index.js';
import {
  Readiness,
  ReadinessContributor,
  healthConfig,
  type ReadinessProbe,
} from '../../../../src/core/health/index.js';
import { READINESS_CHECKS } from '../../../../src/core/health/readiness.js';
import { REDIS } from '../../../../src/core/redis/index.js';

@Injectable()
@ReadinessContributor('')
class EmptyKey implements ReadinessProbe {
  async probe(): Promise<void> {}
}

@Injectable()
@ReadinessContributor('unit_dep')
class Valid implements ReadinessProbe {
  async probe(): Promise<void> {}
}

@Injectable()
class NotAContributor {}

/**
 * Chỉ `onModuleInit` được thử: Db/Redis không bao giờ được gọi ở đây nên là giá trị rỗng, và không có check
 * core nào (`READINESS_CHECKS = []`).
 */
async function boot(providers: Type<unknown>[]): Promise<Readiness> {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      Readiness,
      HealthIndicatorService,
      { provide: Db, useValue: {} },
      { provide: REDIS, useValue: {} },
      { provide: healthConfig.KEY, useValue: { checkTimeoutMs: 500 } },
      { provide: READINESS_CHECKS, useValue: [] },
      ...providers,
    ],
  }).compile();
  try {
    await ref.init();
    return ref.get(Readiness);
  } finally {
    await ref.close();
  }
}

describe('readiness contributor discovery', () => {
  it('registers valid contributors and skips providers that are not contributors', async () => {
    const readiness = await boot([Valid, NotAContributor]);
    expect(readiness.indicators()).toHaveLength(1);
  });

  it('fails boot on an empty contributor key instead of silently dropping it', async () => {
    await expect(boot([EmptyKey])).rejects.toThrow(
      /Invalid or duplicate readiness contributor key ""/,
    );
  });
});
