import {
  Controller,
  Get,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../../../src/core/context/index.js';
import type { Entitlements } from '../../../../src/modules/entitlements/application/entitlements.service.js';
import {
  EntitlementsContextError,
  featureNotInPlan,
} from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import { EntitlementInterceptor } from '../../../../src/modules/entitlements/http/entitlement.interceptor.js';

const Cat = defineFeatureCatalogue({
  'x.a': { kind: 'FLAG', fallback: true },
  'x.b': { kind: 'FLAG', fallback: true },
});
@Controller('v1/orgs/:orgId/x')
@Cat.requireEnabled('x.a')
class Ctl {
  @Get() @Cat.requireEnabled('x.b') both(this: void) {}
  @Get('bare') bare(this: void) {}
}
const ctxOf = (handler: Function): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => Ctl,
    getType: () => 'http',
  }) as Pick<
    ExecutionContext,
    'getHandler' | 'getClass' | 'getType'
  > as ExecutionContext;
const reqCtx = (orgId: string | undefined, access = true) =>
  ({
    orgId: () => orgId,
    orgAccess: () =>
      access
        ? { via: 'MEMBERSHIP', ref: 'm', permissions: [], orgDeleted: false }
        : undefined,
  }) as Pick<RequestContext, 'orgId' | 'orgAccess'> as RequestContext;
const next = (): CallHandler & { calls: number } => {
  const h = {
    calls: 0,
    handle: () => {
      h.calls += 1;
      return of('handled');
    },
  };
  return h;
};

describe('EntitlementInterceptor (spec SP4 §12.3)', () => {
  it('checks method and class keys with one assertEnabled call, then runs the handler', async () => {
    const assertEnabled = vi.fn(() => Promise.resolve());
    const n = next();
    const i = new EntitlementInterceptor(new Reflector(), reqCtx('org-1'), {
      assertEnabled,
    } as Pick<Entitlements, 'assertEnabled'> as Entitlements);
    expect(await lastValueFrom(i.intercept(ctxOf(Ctl.prototype.both), n))).toBe(
      'handled',
    );
    expect(assertEnabled).toHaveBeenCalledWith('x.b', 'x.a');
    expect(n.calls).toBe(1);
  });
  it('a disabled key rejects with 403 feature_not_in_plan and never runs the handler', async () => {
    const n = next();
    const i = new EntitlementInterceptor(new Reflector(), reqCtx('org-1'), {
      assertEnabled: () => Promise.reject(featureNotInPlan('x.b')),
    } as Pick<Entitlements, 'assertEnabled'> as Entitlements);
    await expect(
      lastValueFrom(i.intercept(ctxOf(Ctl.prototype.both), n)),
    ).rejects.toMatchObject({ error: { code: 'feature_not_in_plan' } });
    expect(n.calls).toBe(0);
  });
  it('without org context or orgAccess it is an assembly error, not a silent pass', () => {
    const e = { assertEnabled: () => Promise.resolve() } as Pick<
      Entitlements,
      'assertEnabled'
    > as Entitlements;
    expect(() =>
      new EntitlementInterceptor(
        new Reflector(),
        reqCtx(undefined),
        e,
      ).intercept(ctxOf(Ctl.prototype.both), next()),
    ).toThrow(EntitlementsContextError);
    expect(() =>
      new EntitlementInterceptor(
        new Reflector(),
        reqCtx('org-1', false),
        e,
      ).intercept(ctxOf(Ctl.prototype.both), next()),
    ).toThrow(EntitlementsContextError);
  });
});
