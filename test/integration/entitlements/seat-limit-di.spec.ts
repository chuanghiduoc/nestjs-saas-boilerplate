import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberSeatLimitAdapter } from '../../../src/modules/entitlements/infra/tenancy/member-seat-limit.adapter.js';
import { MemberSeatLimit } from '../../../src/modules/tenancy/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { entitlementsCoreImports } from '../../support/entitlements-app.js';
import {
  FixtureFeaturesModule,
  fixturePlans,
  seedFixtureCatalogue,
} from '../../support/entitlements-fixtures.js';

/** Spec SP4 §9.6: adapter ở CẢ worker (đối xứng, X-10 của SP3); api được phủ bởi `seats.e2e.spec.ts`. */
describe('the seat adapter is wired in the worker composition', () => {
  let app: INestApplication;
  let dispose: () => Promise<void>;
  beforeAll(async () => {
    dispose = await seedFixtureCatalogue();
    app = await createTestApp(
      entitlementsCoreImports(fixturePlans, [FixtureFeaturesModule]),
    );
  });
  afterAll(async () => {
    await app?.close();
    await dispose?.();
  });
  it('MemberSeatLimit resolves to the entitlements adapter', () => {
    expect(app.get(MemberSeatLimit)).toBeInstanceOf(MemberSeatLimitAdapter);
  });
});
