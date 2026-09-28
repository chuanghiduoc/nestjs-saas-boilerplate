import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../../../src/core/context/index.js';

async function makeCtx(): Promise<RequestContext> {
  const mod = await Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true })],
    providers: [RequestContext],
  }).compile();
  return mod.get(RequestContext);
}

describe('RequestContext credential', () => {
  it('keeps the credential next to the principal (API key: principal is the owning user)', async () => {
    const ctx = await makeCtx();
    await ctx.run({}, async () => {
      ctx.setPrincipal({ type: 'user', id: 'u1' });
      ctx.setCredential({ kind: 'API_KEY', id: 'k1' });
      expect(ctx.principal()).toEqual({ type: 'user', id: 'u1' });
      expect(ctx.credential()).toEqual({ kind: 'API_KEY', id: 'k1' });
    });
  });
  it('is undefined outside a request context and in a fresh context', async () => {
    const ctx = await makeCtx();
    expect(ctx.credential()).toBeUndefined();
    await ctx.run({}, async () => expect(ctx.credential()).toBeUndefined());
  });
  it('fails loudly when set outside a CLS context', async () => {
    const ctx = await makeCtx();
    expect(() => ctx.setCredential({ kind: 'SESSION_COOKIE' })).toThrow();
  });
});
