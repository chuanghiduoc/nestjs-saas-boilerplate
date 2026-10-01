import { Controller, Get, Post } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  normalizeTemplate,
  routeTemplateOf,
} from '../../../../src/core/http/index.js';
import {
  DEFINER_LIMIT_MAX,
  PURGE_CURSOR_START,
} from '../../../../src/core/sweep/index.js';
import * as tenancyConstants from '../../../../src/modules/tenancy/constants.js';
import * as tenancyRoute from '../../../../src/modules/tenancy/http/org-route.js';

@Controller('v1/orgs')
class SplitCtl {
  @Get(':orgId/x') x() {}
  @Post() create() {}
}
@Controller('/v1/orgs/:orgId/')
class SlashCtl {
  @Get() get() {}
}
@Controller('V1/ORGS/:orgId')
class UpperCtl {
  @Post('Restore') restore() {}
}
@Controller(['v1/orgs/:id/x', 'v1/other'])
class MultiCtl {
  @Get() list() {}
}
@Controller('v1/admin/orgs')
class AdminCtl {
  @Get(':orgId/members') members() {}
}

describe('routeTemplateOf in core/http (spec SP6 §5.3, C-9)', () => {
  it('gives the same templates as the SP3 §7.4 sample set', () => {
    expect(routeTemplateOf(SplitCtl, SplitCtl.prototype.x)).toEqual([
      'v1/orgs/:orgId/x',
    ]);
    expect(routeTemplateOf(SplitCtl, SplitCtl.prototype.create)).toEqual([
      'v1/orgs',
    ]);
    expect(routeTemplateOf(SlashCtl, SlashCtl.prototype.get)).toEqual([
      'v1/orgs/:orgId',
    ]);
    expect(routeTemplateOf(UpperCtl, UpperCtl.prototype.restore)).toEqual([
      'v1/orgs/:orgId/restore',
    ]);
    expect(routeTemplateOf(MultiCtl, MultiCtl.prototype.list)).toEqual([
      'v1/orgs/:id/x',
      'v1/other',
    ]);
    expect(routeTemplateOf(AdminCtl, AdminCtl.prototype.members)).toEqual([
      'v1/admin/orgs/:orgId/members',
    ]);
    expect(normalizeTemplate('//V1//Admin/:orgId/')).toBe('v1/admin/:orgId');
  });
  it('tenancy re-exports the very same functions and constant values', () => {
    expect(tenancyRoute.routeTemplateOf).toBe(routeTemplateOf);
    expect(tenancyRoute.normalizeTemplate).toBe(normalizeTemplate);
    expect(tenancyConstants.DEFINER_LIMIT_MAX).toBe(DEFINER_LIMIT_MAX);
    expect(tenancyConstants.PURGE_CURSOR_START).toBe(PURGE_CURSOR_START);
    expect([DEFINER_LIMIT_MAX, PURGE_CURSOR_START]).toEqual([
      1000,
      '00000000-0000-0000-0000-000000000000',
    ]);
  });
});
