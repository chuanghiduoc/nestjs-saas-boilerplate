import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';
import { contextLogFields } from '../../../../src/core/logging/index.js';

describe('contextLogFields', () => {
  it('adds the credential kind and id to every log line of the request', async () => {
    const mod = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [RequestContext],
    }).compile();
    const ctx = mod.get(RequestContext);
    const cls = mod.get(ClsService);
    await ctx.run({ requestId: 'r1' }, async () => {
      ctx.setCredential({ kind: 'API_KEY', id: 'key_123' });
      expect(contextLogFields(cls)).toMatchObject({
        requestId: 'r1',
        credential: { kind: 'API_KEY', id: 'key_123' },
      });
    });
    expect(contextLogFields(cls)).toEqual({});
  });
});
