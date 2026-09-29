import type { INestApplication } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { PrincipalMiddleware } from '../../../src/modules/identity/http/principal.middleware.js';
import { OrgContextMiddleware } from '../../../src/modules/tenancy/http/org-context.middleware.js';
import { installOtelCapture } from '../../support/otel-capture.js';
import { authed, startTenancyApp } from '../../support/tenancy-app.js';
import {
  deleteSeededPrincipals,
  seedUserPrincipal,
  type SeededPrincipal,
} from '../../support/tenancy-principals.js';
import { seedOrg, type SeededOrg } from '../../support/tenancy-seed.js';
import { TenancyProbeModule } from './fixtures/probe.module.js';

/** Độ sâu làm module kia chạy trước (Nest sắp middleware theo `distance` tăng dần; lấy độ sâu lớn nhất). */
const DEEPER = 3;

/**
 * T6 (spec SP3 §7.1 bước 2, INT-I1) + G-7 (INT3-2): ở thứ tự đã chọn, mỗi request tenant có đúng một span
 * `identity.authenticate`, một span `tenancy.org_context.resolve`, không `Set-Cookie` nhân đôi.
 */
export function describeMiddlewareOrder(first: 'identity' | 'tenancy'): void {
  describe(`principal resolution is idempotent with ${first} middleware first`, () => {
    const otel = installOtelCapture();
    let app: INestApplication;
    let p: SeededPrincipal;
    let org: SeededOrg;
    let principalUse: MockInstance<PrincipalMiddleware['use']>;
    let orgUse: MockInstance<OrgContextMiddleware['use']>;
    beforeAll(async () => {
      // Review I5: gắn spy TRƯỚC khi dựng app. Lúc init, Nest bind `instance.use.bind(instance)` một lần
      // (`@nestjs/core/middleware/middleware-module.js`), nên spy gắn sau init không bao giờ thấy lời gọi.
      // spyOn không mock: gọi hàm gốc, chỉ ghi thứ tự gọi.
      principalUse = vi.spyOn(PrincipalMiddleware.prototype, 'use');
      orgUse = vi.spyOn(OrgContextMiddleware.prototype, 'use');
      app = await startTenancyApp({
        extraImports: [TenancyProbeModule],
        identityDepth: first === 'tenancy' ? DEEPER : 0,
        tenancyDepth: first === 'identity' ? DEEPER : 0,
      });
      p = await seedUserPrincipal();
      org = await seedOrg({ owner: { authUserId: p.authUserId } });
    });
    afterAll(async () => {
      await org?.dispose();
      await app?.close();
      if (p) await deleteSeededPrincipals([p]);
      principalUse?.mockRestore();
      orgUse?.mockRestore();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    it('the chosen order really happened', async () => {
      principalUse.mockClear();
      orgUse.mockClear();
      await authed(app, p).get(`/v1/orgs/${org.orgId}/probe`);
      const [pOrder] = principalUse.mock.invocationCallOrder;
      const [oOrder] = orgUse.mock.invocationCallOrder;
      if (pOrder === undefined || oOrder === undefined)
        throw new Error('both middlewares must run');
      expect(first === 'identity' ? pOrder < oOrder : oOrder < pOrder).toBe(
        true,
      );
    });
    it.each(['', '/', '/probe', '/probe/'])(
      'GET /v1/orgs/<id>%s: one authentication, one org resolution',
      async (suffix) => {
        otel.reset();
        const r = await authed(app, p).get(`/v1/orgs/${org.orgId}${suffix}`);
        expect([200, 404]).toContain(r.status);
        expect(otel.spans('identity.authenticate')).toHaveLength(1);
        expect(otel.spans('tenancy.org_context.resolve')).toHaveLength(1);
        expect(r.headers['set-cookie'] ?? []).toHaveLength(0);
      },
    );
  });
}
