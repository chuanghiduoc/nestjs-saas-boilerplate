import {
  Controller,
  Get,
  Module,
  Param,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformStaffAction } from '../../../src/modules/identity/index.js';
import { describePlatformStaffActionConformance } from '../../support/platform-staff-action.conformance.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';

let handlerCalls = 0;
@Controller('v1/admin/__fixture')
class FixtureAdminController {
  @PlatformStaffAction()
  @Get(':itemId')
  get(this: void, @Param('itemId') itemId: string) {
    handlerCalls += 1;
    return { itemId };
  }
  @PlatformStaffAction()
  @Post(':itemId/actions')
  act(this: void, @Param('itemId') itemId: string) {
    handlerCalls += 1;
    return { itemId };
  }
}
@Module({ controllers: [FixtureAdminController] })
class FixtureAdminModule {}

/** PSA-3/PSA-6/PSA-7 (addendum A7): C1–C10 trên GET và POST ở cả ba AUTH_MODE. */
describePlatformStaffActionConformance(
  'GET /v1/admin/__fixture/:itemId',
  () => ({
    method: 'GET',
    path: '/v1/admin/__fixture/42?q=query-secret',
    expectAllowedStatus: 200,
  }),
  { extraImports: [FixtureAdminModule], handlerCalls: () => handlerCalls },
);
describePlatformStaffActionConformance(
  'POST /v1/admin/__fixture/:itemId/actions',
  () => ({
    method: 'POST',
    path: '/v1/admin/__fixture/42/actions',
    body: { reason: 'body-secret' },
    expectAllowedStatus: 201,
  }),
  { extraImports: [FixtureAdminModule], handlerCalls: () => handlerCalls },
);

describe('PSA-6: no PlatformAccessAudit provider (@Optional → undefined)', () => {
  let app: INestApplication;
  const ps: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startTenancyApp({ extraImports: [FixtureAdminModule] });
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(ps);
    vi.unstubAllEnvs();
  });
  it('a stepped-up staff session passes through the no-op audit and the handler runs', async () => {
    const staff = await seedStaffPrincipal();
    ps.push(staff);
    const calls = handlerCalls;
    const r = await request(app.getHttpServer())
      .get('/v1/admin/__fixture/7')
      .set('authorization', `Bearer ${staff.bearer}`);
    expect([r.status, r.body]).toEqual([200, { itemId: '7' }]);
    expect(handlerCalls).toBe(calls + 1);
  });
});
