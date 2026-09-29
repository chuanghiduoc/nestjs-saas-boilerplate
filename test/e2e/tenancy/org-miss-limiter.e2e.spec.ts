import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { TenancyProbeModule } from './fixtures/probe.module.js';

const LIMIT = 5;

describe('org-miss limiter counts real misses only (spec SP3 §7.1 bước 3.5, SEC2-N3, INT2-N-4, T-33)', () => {
  let app: INestApplication;
  const principals: SeededPrincipal[] = [];
  const orgs: SeededOrg[] = [];
  const seedP = async () => {
    const p = await seedUserPrincipal();
    principals.push(p);
    return p;
  };
  beforeAll(async () => {
    app = await startTenancyApp({
      extraImports: [TenancyProbeModule],
      env: { TENANCY_ORG_MISS_RATE_LIMIT: String(LIMIT) },
    });
  });
  afterAll(async () => {
    for (const o of orgs) await o.dispose();
    await app?.close();
    await deleteSeededPrincipals(principals);
    vi.unstubAllEnvs();
  });

  it('LIMIT + 1 sequential misses answer 404 (the one that crosses the limit included); from then on 429 with Retry-After', async () => {
    const p = await seedP();
    // Hợp đồng của `RateLimitBucket` (Task 5, review I4): peek khoá khi đã tiêu > LIMIT, nên lần LIMIT + 1 vẫn qua peek,
    // tiêu điểm thứ LIMIT + 1 và trả 404; lần LIMIT + 2 mới bị chặn ở peek.
    for (let i = 0; i < LIMIT + 1; i++)
      expect(
        (await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status,
        `miss ${i + 1}`,
      ).toBe(404);
    const blocked = await authed(app, p).get(`/v1/orgs/${v7()}/probe`);
    expect([blocked.status, blocked.body.code]).toEqual([429, 'rate_limited']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('2×LIMIT parallel hits of a member on its own org never 429 and never count as misses', async () => {
    const p = await seedP();
    const org = await seedOrg({ owner: { authUserId: p.authUserId } });
    orgs.push(org);
    const hits = await Promise.all(
      Array.from({ length: 2 * LIMIT }, () =>
        authed(app, p).get(`/v1/orgs/${org.orgId}/probe`),
      ),
    );
    expect(hits.map((r) => r.status)).toEqual(Array(2 * LIMIT).fill(200));
    // Bộ đếm vẫn là 0: đúng LIMIT + 1 lần trượt tiếp theo vẫn là 404 (hợp đồng peek của Task 5), lần sau đó 429.
    for (let i = 0; i < LIMIT + 1; i++)
      expect(
        (await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status,
        `miss ${i + 1}`,
      ).toBe(404);
    expect((await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status).toBe(
      429,
    );
  });
  it('T-33: concurrent misses may slip past peek by at most the concurrency, then the principal is blocked', async () => {
    const p = await seedP();
    const burst = await Promise.all(
      Array.from({ length: 3 * LIMIT }, () =>
        authed(app, p).get(`/v1/orgs/${v7()}/probe`),
      ),
    );
    const statuses = burst.map((r) => r.status);
    expect(statuses.every((s) => s === 404 || s === 429)).toBe(true);
    expect(statuses.filter((s) => s === 404).length).toBeGreaterThanOrEqual(
      LIMIT,
    );
    expect((await authed(app, p).get(`/v1/orgs/${v7()}/probe`)).status).toBe(
      429,
    );
  });
});
