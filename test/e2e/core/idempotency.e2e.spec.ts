import {
  Body,
  Controller,
  HttpCode,
  Module,
  Post,
  Res,
  type INestApplication,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, CoreErrors } from '../../../src/core/errors/index.js';
import {
  HttpModule,
  Idempotent,
  applyHttpDefaults,
  setLocation,
  type HeaderWriter,
} from '../../../src/core/http/index.js';
import {
  REDIS,
  REDIS_NAMESPACE,
  RedisModule,
} from '../../../src/core/redis/index.js';
import { createTestApp } from '../../support/app-factory.js';
import { TestPrincipalModule } from '../../support/test-principal.middleware.js';

let calls = 0;
let failCalls = 0;
const SHORT_TTL_SEC = 60;
const DEFAULT_TTL_SEC = 86400;
const Pay = z.object({
  amount: z.number().int().positive(),
  delayMs: z.number().int().min(0).optional(),
});
const ORG_A = '0199aaaa-0000-7000-8000-00000000000a';
const ORG_B = '0199bbbb-0000-7000-8000-00000000000b';
const key = (s: string) => `test-key-${s}-${'x'.repeat(16)}`;

@Controller('api/v1/payments')
class PaymentsController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  async create(@Body({ schema: Pay }) b: z.infer<typeof Pay>) {
    calls++;
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    return { id: `p-${calls}`, amount: b.amount };
  }

  @Post('located')
  @HttpCode(201)
  @Idempotent({ ttlSec: SHORT_TTL_SEC })
  located(
    @Body({ schema: Pay }) b: z.infer<typeof Pay>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    calls++;
    setLocation(res, `/api/v1/payments/p-${calls}`);
    res.setHeader('Set-Cookie', 'session=secret');
    res.setHeader('X-Not-Allowlisted', 'nope');
    return { id: `p-${calls}`, amount: b.amount };
  }

  @Post('fail')
  @HttpCode(201)
  @Idempotent()
  fail() {
    failCalls++;
    throw new AppError(CoreErrors.CONFLICT, {
      detail: 'side effect already applied',
    });
  }

  @Post('crash')
  @HttpCode(201)
  @Idempotent()
  crash() {
    failCalls++;
    throw new Error('unexpected');
  }
}
@Module({ controllers: [PaymentsController] })
class M {}

type Who = { principal?: string; org?: string };

describe('Idempotency-Key (@node-idempotency/core)', () => {
  let app: INestApplication;
  let redis: Redis;
  let ns: string;
  const post = (
    path: string,
    k: string | undefined,
    body: unknown,
    who: Who = { principal: 'user:u1', org: ORG_A },
  ) => {
    const r = request(app.getHttpServer())
      .post(path)
      .set('content-type', 'application/json');
    if (k) r.set('Idempotency-Key', k);
    if (who.principal) r.set('x-test-principal', who.principal);
    if (who.org) r.set('x-test-org', who.org);
    return r.send(body as object);
  };
  const idemKeys = async (route: string) =>
    redis.keys(`${ns}-idem:POST:${route}:*`);

  beforeAll(async () => {
    app = await createTestApp(
      [RedisModule, HttpModule, TestPrincipalModule, M],
      {
        beforeInit: applyHttpDefaults,
      },
    );
    redis = app.get<Redis>(REDIS);
    ns = app.get<string>(REDIS_NAMESPACE);
  });
  afterAll(async () => {
    const keys = await redis.keys(`${ns}-*`);
    if (keys.length) await redis.del(...keys);
    await app.close();
  });

  it('replays the stored response for the same key and body; handler runs once', async () => {
    const before = calls;
    const a = await post('/api/v1/payments', key('1'), { amount: 10 }).expect(
      201,
    );
    const b = await post('/api/v1/payments', key('1'), { amount: 10 }).expect(
      201,
    );
    expect(b.body).toEqual(a.body);
    expect(calls - before).toBe(1);
  });

  it('same key, different body → 422 idempotency_key_reused (problem+json)', async () => {
    await post('/api/v1/payments', key('2'), { amount: 1 }).expect(201);
    const res = await post('/api/v1/payments', key('2'), { amount: 2 }).expect(
      422,
    );
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      code: 'idempotency_key_reused',
      status: 422,
    });
  });

  it('concurrent duplicate while the first is in progress → 409 idempotency_conflict, no waiting', async () => {
    const before = calls;
    // Supertest chỉ gửi request khi được `then`: gọi `.then` để request đầu thật sự bay đi trước.
    const first = post('/api/v1/payments', key('3'), {
      amount: 5,
      delayMs: 800,
    }).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const dup = await post('/api/v1/payments', key('3'), {
      amount: 5,
      delayMs: 800,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('idempotency_conflict');
    expect(Date.now() - started).toBeLessThan(500);
    expect((await first).status).toBe(201);
    expect(calls - before).toBe(1);
  });

  it('a burst of simultaneous duplicates: exactly one executes (atomic SET NX), the rest get 409', async () => {
    const before = calls;
    const BURST = 10;
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        post('/api/v1/payments', key('burst'), { amount: 9, delayMs: 300 }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(BURST - 1);
    expect(calls - before).toBe(1);
  });

  it('missing, too short, too long or malformed key → 400 idempotency_key_required, handler not run', async () => {
    const before = calls;
    for (const k of [
      undefined,
      'short-key',
      `bad key!${'x'.repeat(16)}`,
      'k'.repeat(256),
    ]) {
      const res = await post('/api/v1/payments', k, { amount: 1 }).expect(400);
      expect(res.body.code).toBe('idempotency_key_required');
    }
    expect(calls).toBe(before);
  });

  it('no authenticated principal → 401, handler not run', async () => {
    const before = calls;
    const res = await post(
      '/api/v1/payments',
      key('4'),
      { amount: 1 },
      {},
    ).expect(401);
    expect(res.body.code).toBe('unauthenticated');
    expect(calls).toBe(before);
  });

  it('a 4xx error is stored and replayed; handler not re-run', async () => {
    const before = failCalls;
    const a = await post('/api/v1/payments/fail', key('5'), {}).expect(409);
    const b = await post('/api/v1/payments/fail', key('5'), {}).expect(409);
    expect(b.headers['content-type']).toContain('application/problem+json');
    expect(b.body).toMatchObject({ code: a.body.code, detail: a.body.detail });
    expect(b.body.detail).toBe('side effect already applied');
    expect(failCalls - before).toBe(1);
  });

  it('an unexpected 5xx is stored and replayed as internal_error without detail; handler not re-run', async () => {
    const before = failCalls;
    await post('/api/v1/payments/crash', key('6'), {}).expect(500);
    const replay = await post('/api/v1/payments/crash', key('6'), {}).expect(
      500,
    );
    expect(replay.body.code).toBe('internal_error');
    expect(replay.body.detail).toBeUndefined();
    expect(failCalls - before).toBe(1);
  });

  it('validation 422 is stored; fixing the body with the same key → 422 idempotency_key_reused', async () => {
    const bad = await post('/api/v1/payments', key('7'), { amount: -1 }).expect(
      422,
    );
    expect(bad.body.code).toBe('validation_failed');
    const again = await post('/api/v1/payments', key('7'), {
      amount: -1,
    }).expect(422);
    expect(again.body).toMatchObject({
      code: 'validation_failed',
      errors: bad.body.errors,
    });
    const fixed = await post('/api/v1/payments', key('7'), {
      amount: 1,
    }).expect(422);
    expect(fixed.body.code).toBe('idempotency_key_reused');
  });

  it('same key never shares a stored response across orgs, principals or routes', async () => {
    const k = key('shared');
    const a = await post(
      '/api/v1/payments',
      k,
      { amount: 7 },
      { principal: 'user:u1', org: ORG_A },
    ).expect(201);
    const b = await post(
      '/api/v1/payments',
      k,
      { amount: 7 },
      { principal: 'user:u1', org: ORG_B },
    ).expect(201);
    const c = await post(
      '/api/v1/payments',
      k,
      { amount: 7 },
      { principal: 'user:u2', org: ORG_A },
    ).expect(201);
    const d = await post(
      '/api/v1/payments',
      k,
      { amount: 7 },
      { principal: 'api_key:u1', org: ORG_A },
    ).expect(201);
    const e = await post(
      '/api/v1/payments',
      k,
      { amount: 7 },
      { principal: 'user:u1' },
    ).expect(201);
    const f = await post(
      '/api/v1/payments/located',
      k,
      { amount: 7 },
      { principal: 'user:u1', org: ORG_A },
    ).expect(201);
    expect(new Set([a, b, c, d, e, f].map((r) => r.body.id)).size).toBe(6);
  });

  it('org id is canonicalized: an upper-case org header hits the same scope', async () => {
    const k = key('case');
    const a = await post('/api/v1/payments', k, { amount: 4 }).expect(201);
    const b = await post(
      '/api/v1/payments',
      k,
      { amount: 4 },
      { principal: 'user:u1', org: ORG_A.toUpperCase() },
    ).expect(201);
    expect(b.body).toEqual(a.body);
  });

  it('X-Org-Id header has no effect on scope', async () => {
    const k = key('hdr');
    const a = await post('/api/v1/payments', k, { amount: 3 }).expect(201);
    const b = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('content-type', 'application/json')
      .set('Idempotency-Key', k)
      .set('x-test-principal', 'user:u1')
      .set('x-test-org', ORG_A)
      .set('X-Org-Id', ORG_B)
      .send({ amount: 3 })
      .expect(201);
    expect(b.body).toEqual(a.body);
  });

  it('replays only allowlisted headers (Location), never Set-Cookie', async () => {
    const a = await post('/api/v1/payments/located', key('loc'), {
      amount: 2,
    }).expect(201);
    expect(a.headers.location).toBe(`/api/v1/payments/${a.body.id}`);
    const b = await post('/api/v1/payments/located', key('loc'), {
      amount: 2,
    }).expect(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers.location).toBe(a.headers.location);
    expect(b.headers['set-cookie']).toBeUndefined();
    expect(b.headers['x-not-allowlisted']).toBeUndefined();
  });

  it('stores records with the configured TTL (route override or IDEMPOTENCY_TTL_SEC); never without expiry', async () => {
    await post('/api/v1/payments/located', key('ttl'), { amount: 1 }).expect(
      201,
    );
    const [located] = await idemKeys('/api/v1/payments/located');
    expect(located).toBeDefined();
    const shortTtl = await redis.pttl(located!);
    expect(shortTtl).toBeGreaterThan(0);
    expect(shortTtl).toBeLessThanOrEqual(SHORT_TTL_SEC * 1000);

    const inFlight = post('/api/v1/payments', key('ttl-lock'), {
      amount: 1,
      delayMs: 300,
    }).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    const all = await idemKeys('/api/v1/payments');
    const ttls = await Promise.all(all.map((k) => redis.pttl(k)));
    // Cả bản ghi "đang chạy" (khoá) lẫn bản ghi đã xong đều có hạn: process chết giữa chừng không khoá key mãi.
    for (const t of ttls) {
      expect(t).toBeGreaterThan(SHORT_TTL_SEC * 1000);
      expect(t).toBeLessThanOrEqual(DEFAULT_TTL_SEC * 1000);
    }
    expect((await inFlight).status).toBe(201);
  });
});
