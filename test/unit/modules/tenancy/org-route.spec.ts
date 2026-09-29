import { Controller, Get, Post } from '@nestjs/common';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ORG_RESTORE_TEMPLATE,
  ORG_ROUTE_PATTERN,
  classifyOrgRoute,
  isOrgRestoreRequest,
  routeTemplateOf,
} from '../../../../src/modules/tenancy/http/org-route.js';

@Controller('v1/orgs')
class SplitCtl {
  @Get(':orgId/x') x(this: void) {}
  @Post() create(this: void) {}
}
@Controller('/v1/orgs/:orgId/')
class SlashCtl {
  @Get() get(this: void) {}
}
@Controller('V1/ORGS/:orgId')
class UpperCtl {
  @Post('Restore') restore(this: void) {}
}
@Controller(['v1/orgs/:id/x', 'v1/other'])
class MultiCtl {
  @Get() list(this: void) {}
}

describe('shared tenant route matcher (spec SP3 §7.4, INT-I5)', () => {
  it('routeTemplateOf joins class + method paths, trims slashes and lower-cases static segments', () => {
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
      ORG_RESTORE_TEMPLATE,
    ]);
    expect(routeTemplateOf(MultiCtl, MultiCtl.prototype.list)).toEqual([
      'v1/orgs/:id/x',
      'v1/other',
    ]);
  });
  it.each([
    ['v1/orgs/:orgId', 'TENANT'],
    ['v1/orgs/:orgId/members/:memberId', 'TENANT'],
    ['v1/orgs/:id/x', 'INVALID'],
    ['v1/orgs/me', 'INVALID'],
    ['v1/orgs', 'OTHER'],
    ['v1/orgsx/:orgId', 'OTHER'],
    ['v1/me', 'OTHER'],
    // Đầu path không phải literal: Express vẫn phục vụ `/v1/orgs/X` qua route này, nên không được rơi vào OTHER.
    ['v1/orgs{/:orgId}', 'INVALID'],
    ['v1/:k/:id', 'INVALID'],
    ['{*path}', 'INVALID'],
    [':version/orgs/:orgId', 'INVALID'],
    ['*splat', 'INVALID'],
  ] as const)('classifyOrgRoute(%s) = %s', (t, kind) => {
    expect(classifyOrgRoute(t)).toBe(kind);
  });
  it.each([
    [{ method: 'POST', params: { path: ['restore'] } }, true],
    [{ method: 'POST', params: { path: ['Restore', ''] } }, true],
    [{ method: 'post', params: { path: ['RESTORE'] } }, true],
    [{ method: 'GET', params: { path: ['restore'] } }, false],
    [{ method: 'POST', params: {} }, false],
    [{ method: 'POST', params: { path: ['members', 'restore'] } }, false],
    [{ method: 'POST' }, false],
  ])('isOrgRestoreRequest(%j) = %s', (req, expected) => {
    expect(isOrgRestoreRequest(req)).toBe(expected);
  });
  it('the Express router agrees with the pattern: one match per URL, params as the middleware reads them (G-7, INT3-2)', async () => {
    const app = express();
    const hits: unknown[] = [];
    app.all(`/${ORG_ROUTE_PATTERN}`, (req, res) => {
      hits.push({ orgId: req.params.orgId, path: req.params.path ?? null });
      res.sendStatus(204);
    });
    for (const url of [
      '/v1/orgs/X',
      '/v1/orgs/X/',
      '/v1/orgs/X/members',
      '/V1/ORGS/X/Restore/',
    ])
      await request(app).get(url).expect(204);
    await request(app).get('/v1/orgsX').expect(404);
    expect(hits).toEqual([
      { orgId: 'X', path: null },
      { orgId: 'X', path: null },
      { orgId: 'X', path: ['members'] },
      { orgId: 'X', path: ['Restore', ''] },
    ]);
  });
});
