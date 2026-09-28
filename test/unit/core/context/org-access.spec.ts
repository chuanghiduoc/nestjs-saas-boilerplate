import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';
import { contextLogFields } from '../../../../src/core/logging/index.js';

describe('RequestContext.orgAccess (spec SP3 §5.2, SEC-M11)', () => {
  it('stores the decision of the org middleware and logs via/ref (never the permission list)', async () => {
    const mod = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [RequestContext],
    }).compile();
    const ctx = mod.get(RequestContext);
    const cls = mod.get(ClsService);
    await ctx.run({ requestId: 'r1' }, async () => {
      expect(ctx.orgAccess()).toBeUndefined();
      ctx.setOrgAccess({
        via: 'MEMBERSHIP',
        ref: '0190a1b2-0000-7000-8000-000000000001',
        permissions: ['org.read'],
        orgDeleted: false,
      });
      expect(ctx.orgAccess()?.permissions).toEqual(['org.read']);
      const fields = contextLogFields(cls);
      expect(fields).toMatchObject({
        'org.access.via': 'MEMBERSHIP',
        'org.access.ref': '0190a1b2-0000-7000-8000-000000000001',
      });
      expect(JSON.stringify(fields)).not.toContain('org.read');
    });
  });
  it('rejects an unknown via at write time (fail loud)', async () => {
    const mod = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [RequestContext],
    }).compile();
    const ctx = mod.get(RequestContext);
    await ctx.run({}, async () => {
      expect(() =>
        ctx.setOrgAccess({
          via: 'BACKDOOR' as 'MEMBERSHIP',
          ref: 'x',
          permissions: [],
          orgDeleted: false,
        }),
      ).toThrow('Unknown org access via "BACKDOOR"');
    });
  });
});
