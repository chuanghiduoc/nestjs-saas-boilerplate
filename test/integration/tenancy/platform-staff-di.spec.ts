import {
  Controller,
  Get,
  Global,
  Module,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PlatformAccessAudit,
  PlatformStaffAction,
  type PlatformAccessEntry,
} from '../../../src/modules/identity/index.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedStaffPrincipal,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';

const recorded: PlatformAccessEntry[] = [];
@Controller('v1/admin/__fixture')
class FixtureAdminController {
  @PlatformStaffAction()
  @Get(':itemId')
  get(this: void) {
    return { ok: true };
  }
}
/** Module "của SP4/SP6": KHÔNG import IdentityModule (addendum A1.4, A10.1). */
@Module({ controllers: [FixtureAdminController] })
class FixtureAdminModule {}
class RecordingAudit extends PlatformAccessAudit {
  record(entry: PlatformAccessEntry): Promise<void> {
    recorded.push(entry);
    return Promise.resolve();
  }
}
@Global()
@Module({
  providers: [{ provide: PlatformAccessAudit, useClass: RecordingAudit }],
  exports: [PlatformAccessAudit],
})
class AuditModule {}

describe('PSA-5: @PlatformStaffAction() in a module that does not import identity', () => {
  let app: INestApplication;
  const ps: SeededPrincipal[] = [];
  beforeAll(async () => {
    app = await startTenancyApp({
      extraImports: [FixtureAdminModule, AuditModule],
    });
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(ps);
    vi.unstubAllEnvs();
  });
  it('the app boots; a stepped-up staff session passes and the port gets exactly one entry; a regular user is 403', async () => {
    const staff = await seedStaffPrincipal();
    const user = await seedUserPrincipal();
    ps.push(staff, user);
    const ok = await request(app.getHttpServer())
      .get('/v1/admin/__fixture/42?q=secret')
      .set('authorization', `Bearer ${staff.bearer}`);
    expect(ok.status).toBe(200);
    expect(recorded).toEqual([
      {
        method: 'GET',
        routeTemplate: 'v1/admin/__fixture/:itemId',
        params: { itemId: '42' },
        actor: { type: 'user', id: staff.authUserId },
        credentialKind: 'BEARER_SESSION',
      },
    ]);
    const no = await request(app.getHttpServer())
      .get('/v1/admin/__fixture/42')
      .set('authorization', `Bearer ${user.bearer}`);
    expect([no.status, no.body.code]).toEqual([403, 'forbidden']);
    expect(recorded).toHaveLength(1);
  });
});
