import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../../../../src/core/context/index.js';
import { OrgApiKeyConfinementGuard } from '../../../../src/modules/tenancy/http/org-api-key-confinement.guard.js';

@Controller('v1/orgs/:orgId/things')
class Tenant {
  @Get() list(this: void): void {}
}
@Controller('v1/me')
class Me {
  @Get() get(this: void): void {}
}
// Ép kiểu `as unknown as` chỉ ở fixture test cho hai interface của Nest; không có ở `src`.
const exec = (cls: Function, handler: Function): ExecutionContext =>
  ({
    getType: () => 'http',
    getClass: () => cls,
    getHandler: () => handler,
  }) as unknown as ExecutionContext;
const ctxWith = (kind: string | undefined) =>
  ({
    credential: () => (kind ? { kind } : undefined),
  }) as unknown as RequestContext;

describe('OrgApiKeyConfinementGuard (spec SP3 §7.1 bước 4, §10)', () => {
  it('an org key on a tenant route passes; anywhere else → 403 api_key_not_allowed_here', () => {
    const g = new OrgApiKeyConfinementGuard(ctxWith('ORG_API_KEY'));
    expect(g.canActivate(exec(Tenant, Tenant.prototype.list))).toBe(true);
    expect(() => g.canActivate(exec(Me, Me.prototype.get))).toThrow(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'api_key_not_allowed_here',
          status: 403,
        }),
      }),
    );
  });
  it('every other credential is not this guard’s business', () => {
    for (const kind of [
      undefined,
      'SESSION_COOKIE',
      'BEARER_SESSION',
      'API_KEY',
      'EXTERNAL_BEARER',
    ])
      expect(
        new OrgApiKeyConfinementGuard(ctxWith(kind)).canActivate(
          exec(Me, Me.prototype.get),
        ),
      ).toBe(true);
  });
});
