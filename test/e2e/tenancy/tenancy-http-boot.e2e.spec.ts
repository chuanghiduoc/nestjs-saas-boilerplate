import type { INestApplication } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  RateLimitBuckets,
  type RateLimitBucket,
} from '../../../src/core/http/index.js';
import { ORG_MISS_BUCKET } from '../../../src/modules/tenancy/http/org-context.middleware.js';
import { startTenancyApp } from '../../support/tenancy-app.js';

/**
 * Review C1: Nest dựng middleware bằng `Injector.loadMiddleware` (container riêng), không dùng lại instance provider. Nếu
 * việc đăng ký bucket nằm trong constructor của middleware, app ném `Rate limit bucket "tenancy.org-miss" is already
 * registered` lúc boot. Ca này đỏ đúng ở lỗi đó, thay vì để mọi e2e tenancy đỏ hàng loạt ở `beforeAll`.
 */
describe('TenancyHttpModule boots (review C1)', () => {
  let app: INestApplication | undefined;
  // Gắn TRƯỚC khi app được dựng: thấy mọi lần đăng ký lúc khởi tạo provider. `spyOn` không mock, gọi hàm gốc.
  const register = vi.spyOn(RateLimitBuckets.prototype, 'register');
  afterAll(async () => {
    await app?.close();
    register.mockRestore();
    vi.unstubAllEnvs();
  });

  it('an app with TenancyModule.forApi() boots and registers tenancy.org-miss exactly once', async () => {
    app = await startTenancyApp();
    const orgMiss = register.mock.calls.filter(
      ([def]) => def.owner === 'tenancy' && def.name === 'org-miss',
    );
    expect(orgMiss).toHaveLength(1);
    expect(
      app.get<RateLimitBucket>(ORG_MISS_BUCKET, { strict: false }).name,
    ).toBe('tenancy.org-miss');
  });
});
