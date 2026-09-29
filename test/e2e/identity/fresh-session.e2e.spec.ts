import {
  Controller,
  Get,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AuthFacts,
  RequireFreshSession,
  RequireVerifiedEmail,
  SessionOnly,
} from '../../../src/modules/identity/index.js';
import { startIdentityApp } from '../../support/identity-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';

@Controller('probe-fresh')
class FreshProbe {
  constructor(private readonly authFacts: AuthFacts) {}
  @Get('facts') facts() {
    return {
      admin: this.authFacts.isPlatformAdmin(),
      verified: this.authFacts.emailVerified(),
      email: this.authFacts.verifiedEmail() ?? null,
      at: this.authFacts.authenticatedAt()?.toISOString() ?? null,
    };
  }
  @SessionOnly()
  @RequireFreshSession()
  @RequireVerifiedEmail()
  @Post('sensitive')
  sensitive() {
    return { ok: true };
  }
}
@Module({ controllers: [FreshProbe] })
class ProbeModule {}

/** Mặc định `AUTH_SESSION_FRESH_AGE_SEC`. */
const FRESH_AGE_SEC = 600;

describe('@RequireFreshSession / @RequireVerifiedEmail (spec SP3 §5.2, S2-R76, SEC-I4)', () => {
  let app: INestApplication;
  const seeded: SeededPrincipal[] = [];
  const seed = async (o: Parameters<typeof seedUserPrincipal>[0] = {}) => {
    const p = await seedUserPrincipal(o);
    seeded.push(p);
    return p;
  };
  beforeAll(async () => {
    // Cờ tắt: decorator vẫn đòi email đã xác thực (không phụ thuộc AUTH_REQUIRE_EMAIL_VERIFICATION).
    app = await startIdentityApp({
      extraImports: [ProbeModule],
      env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
    });
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals(seeded);
    vi.unstubAllEnvs();
  });
  const post = (p: SeededPrincipal) =>
    request(app.getHttpServer())
      .post('/probe-fresh/sensitive')
      .set('authorization', `Bearer ${p.bearer}`);

  it('AuthFacts reflect the authenticated principal', async () => {
    const p = await seed({ role: 'admin' });
    const r = await request(app.getHttpServer())
      .get('/probe-fresh/facts')
      .set('authorization', `Bearer ${p.bearer}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      admin: true,
      verified: true,
      email: p.email,
    });
    expect(Date.now() - Date.parse(r.body.at)).toBeLessThan(
      FRESH_AGE_SEC * 1000,
    );
  });
  it('fresh + verified → 201 (POST)', async () => {
    expect((await post(await seed())).status).toBe(201);
  });
  it('a session older than AUTH_SESSION_FRESH_AGE_SEC → 403 reauthentication_required', async () => {
    const r = await post(await seed({ sessionAgeSec: FRESH_AGE_SEC + 60 }));
    expect([r.status, r.body.code]).toEqual([403, 'reauthentication_required']);
  });
  it('an unverified user with AUTH_REQUIRE_EMAIL_VERIFICATION=false → 403 email_not_verified', async () => {
    const r = await post(await seed({ emailVerified: false }));
    expect([r.status, r.body.code]).toEqual([403, 'email_not_verified']);
  });
});
