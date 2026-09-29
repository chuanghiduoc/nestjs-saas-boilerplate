import { ForbiddenError } from '@casl/ability';
import { Controller, Get, Post, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OrgAccess,
  RequestContext,
} from '../../../../src/core/context/index.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { PermissionCatalogueRegistry } from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import { TenancyMetrics } from '../../../../src/modules/tenancy/application/tenancy-metrics.js';
import {
  UnknownPermissionError,
  mergeCatalogues,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import { OrgMemberOnly } from '../../../../src/modules/tenancy/http/decorators.js';
import { PoliciesGuard } from '../../../../src/modules/tenancy/http/policies.guard.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';
import { installOtelCapture } from '../../../support/otel-capture.js';

const otel = installOtelCapture();

@Controller('v1/orgs/:orgId')
class Ctl {
  @Get() @TenancyPermissions.require('org.read') read(this: void) {}
  @Post('restore') @TenancyPermissions.require('org.restore') restore(
    this: void,
  ) {}
  @Get('members/me') @OrgMemberOnly() me(this: void) {}
  @Get('bare') bare(this: void) {}
}
const merged = mergeCatalogues([TenancyPermissions]);
const registry = { merged: () => merged } as Pick<
  PermissionCatalogueRegistry,
  'merged'
> as PermissionCatalogueRegistry;
const guardWith = (access: OrgAccess | undefined) =>
  new PoliciesGuard(
    new Reflector(),
    { orgAccess: () => access } as Pick<
      RequestContext,
      'orgAccess'
    > as RequestContext,
    registry,
    new TenancyMetrics(),
  );
const ctxOf = (
  handler: Function,
  controller: Function = Ctl,
): ExecutionContext =>
  ({ getHandler: () => handler, getClass: () => controller }) as Pick<
    ExecutionContext,
    'getHandler' | 'getClass'
  > as ExecutionContext;
const access = (
  permissions: string[],
  over: Partial<OrgAccess> = {},
): OrgAccess => ({
  via: 'MEMBERSHIP',
  ref: 'm1',
  permissions,
  orgDeleted: false,
  ...over,
});

describe('PoliciesGuard (spec SP3 §7.1 bước 5)', () => {
  it('grants when every required key is held', () => {
    expect(
      guardWith(access(['org.read'])).canActivate(ctxOf(Ctl.prototype.read)),
    ).toBe(true);
  });
  it('G-4 / U14: a missing key is 403 forbidden and the body never carries the CASL message', () => {
    let caught: unknown;
    try {
      guardWith(access(['members.read'])).canActivate(
        ctxOf(Ctl.prototype.read),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const e = caught as AppError;
    expect([e.error.code, e.error.status]).toEqual(['forbidden', 403]);
    const exposed = JSON.stringify({
      message: e.message,
      detail: e.opts.detail ?? null,
    });
    expect(exposed).not.toMatch(/Cannot execute/);
    expect(exposed).not.toContain('org.read');
  });
  it('G-2: a handler without policy metadata is a 500-class assembly error, never allowed', () => {
    expect(() =>
      guardWith(access(['org.read'])).canActivate(ctxOf(Ctl.prototype.bare)),
    ).toThrow(/without tenancy policy metadata/);
  });
  it('no orgAccess on a tenant route is an assembly error', () => {
    expect(() =>
      guardWith(undefined).canActivate(ctxOf(Ctl.prototype.read)),
    ).toThrow(/no orgAccess/);
  });
  it('a soft-deleted org may reach the restore handler only', () => {
    expect(
      guardWith(
        access(['org.restore', 'org.read'], { orgDeleted: true }),
      ).canActivate(ctxOf(Ctl.prototype.restore)),
    ).toBe(true);
    expect(() =>
      guardWith(access(['org.read'], { orgDeleted: true })).canActivate(
        ctxOf(Ctl.prototype.read),
      ),
    ).toThrow(/soft-deleted organization/);
  });
  it('the restore decision is cached per controller and handler: an inherited restore handler elsewhere is not restore', () => {
    class BaseRestore {
      @Post('restore') @TenancyPermissions.require('org.restore') restore(
        this: void,
      ) {}
    }
    @Controller('v1/orgs/:orgId')
    class OrgRestore extends BaseRestore {}
    @Controller('v1/orgs/:orgId/things')
    class ThingRestore extends BaseRestore {}
    const guard = guardWith(access(['org.restore'], { orgDeleted: true }));
    const handler = BaseRestore.prototype.restore;
    expect(guard.canActivate(ctxOf(handler, OrgRestore))).toBe(true);
    expect(() => guard.canActivate(ctxOf(handler, ThingRestore))).toThrow(
      /soft-deleted organization/,
    );
  });
  it('OrgMemberOnly admits MEMBERSHIP only', () => {
    expect(guardWith(access([])).canActivate(ctxOf(Ctl.prototype.me))).toBe(
      true,
    );
    expect(() =>
      guardWith(access([], { via: 'SUPPORT_GRANT' })).canActivate(
        ctxOf(Ctl.prototype.me),
      ),
    ).toThrow(AppError);
  });
  it('G-5: only CASL ForbiddenError becomes 403; any other error propagates unchanged (instanceof, not constructor.name)', () => {
    expect(() =>
      guardWith(access(['ghost.read'])).canActivate(ctxOf(Ctl.prototype.read)),
    ).toThrow(UnknownPermissionError);
  });
});

describe('PoliciesGuard catch/rethrow of the CASL check (G-5)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('a non-ForbiddenError thrown during the check propagates unchanged and is never a 403', () => {
    const boom = new TypeError('casl internals broke');
    vi.spyOn(ForbiddenError, 'from').mockImplementation(() => {
      throw boom;
    });
    let caught: unknown;
    try {
      guardWith(access(['org.read'])).canActivate(ctxOf(Ctl.prototype.read));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(AppError);
  });
});

describe('PoliciesGuard telemetry (spec SP3 §16)', () => {
  beforeEach(() => otel.reset());
  const resultOfLastCheck = (): unknown => {
    const spans = otel.spans('tenancy.policy.check');
    return spans.at(-1)?.attributes['tenancy.policy.result'];
  };
  const denials = (reason: string) =>
    otel.metric('tenancy_policy_denied_total', { reason });

  it('allowed: span result is allowed and no denial is counted', async () => {
    const before = await denials('permission');
    guardWith(access(['org.read'])).canActivate(ctxOf(Ctl.prototype.read));
    expect(resultOfLastCheck()).toBe('allowed');
    expect(await denials('permission')).toBe(before);
  });
  it('permission denial: span result is denied and policyDenied{reason=permission} grows by one', async () => {
    const before = (await denials('permission')) ?? 0;
    expect(() =>
      guardWith(access([])).canActivate(ctxOf(Ctl.prototype.read)),
    ).toThrow(AppError);
    expect(resultOfLastCheck()).toBe('denied');
    expect(await denials('permission')).toBe(before + 1);
  });
  it('member-only denial: policyDenied{reason=member_only} grows by one', async () => {
    const before = (await denials('member_only')) ?? 0;
    expect(() =>
      guardWith(access([], { via: 'SUPPORT_GRANT' })).canActivate(
        ctxOf(Ctl.prototype.me),
      ),
    ).toThrow(AppError);
    expect(resultOfLastCheck()).toBe('denied');
    expect(await denials('member_only')).toBe(before + 1);
  });
  it('error: a non-403 failure is result=error with its class name and counts no denial', async () => {
    const before = await otel.metric('tenancy_policy_denied_total');
    expect(() =>
      guardWith(access(['ghost.read'])).canActivate(ctxOf(Ctl.prototype.read)),
    ).toThrow(UnknownPermissionError);
    const [span] = otel.spans('tenancy.policy.check');
    expect(span?.attributes['tenancy.policy.result']).toBe('error');
    expect(span?.attributes['error.type']).toBe('UnknownPermissionError');
    expect(await otel.metric('tenancy_policy_denied_total')).toBe(before);
  });
});
