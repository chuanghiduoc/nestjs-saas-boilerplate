import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { previewIp, previewToken } from '../../support/tenancy-acquisition.js';
import { startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { newToken } from '../../support/tenancy-seed.js';

const LIMIT = 4;

describe('bucket tenancy.token-preview counts previews per client IP (spec SP3 §7.2, INT-I8)', () => {
  let app: INestApplication;
  let p: SeededPrincipal;
  beforeAll(async () => {
    app = await startTenancyApp({
      env: {
        HTTP_TRUST_PROXY: 'loopback',
        TENANCY_TOKEN_PREVIEW_RATE_LIMIT: String(LIMIT),
      },
    });
    p = await seedUserPrincipal();
  });
  afterAll(async () => {
    await app?.close();
    await deleteSeededPrincipals([p]);
    vi.unstubAllEnvs();
  });

  it('LIMIT previews from one IP pass (404 for unknown tokens), the next is 429 + Retry-After, across both preview routes and with or without a principal', async () => {
    const ip = previewIp();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const kind = i % 2 === 0 ? 'invitations' : 'invite-links';
      const req = previewToken(app, kind, { token: newToken() }, ip);
      statuses.push(
        (i === 1
          ? await req.set('authorization', `Bearer ${p.bearer}`)
          : await req
        ).status,
      );
    }
    expect(statuses).toEqual(Array(LIMIT).fill(404));
    const blocked = await previewToken(
      app,
      'invitations',
      { token: newToken() },
      ip,
    );
    expect([blocked.status, blocked.body.code]).toEqual([429, 'rate_limited']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      (
        await previewToken(
          app,
          'invitations',
          { token: newToken() },
          previewIp(),
        )
      ).status,
    ).toBe(404); // IP khác không bị chặn
  });
});
