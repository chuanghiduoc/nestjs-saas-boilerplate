import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HttpClient,
  ResilienceModule,
  SsrfBlockedError,
  toWebFetch,
} from '../../../../src/core/resilience/index.js';
import { createTestApp } from '../../../support/app-factory.js';

const CALLER_TIMEOUT_MS = 100;
let server: Server;
let port = 0;
let slowClosed = 0;
let slowHits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-a': '1' });
      res.end('{"keys":[]}');
      return;
    }
    if (req.url === '/cookies') {
      res.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      res.end();
      return;
    }
    if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/slow') {
      slowHits++;
      res.on('close', () => slowClosed++);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('toWebFetch', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Fixture chạy http trên loopback: test bật http, cổng và dải loopback (production chỉ https, không loopback).
    vi.stubEnv('RESILIENCE_ALLOWED_SCHEMES', 'http,https');
    vi.stubEnv('RESILIENCE_ALLOWED_PORTS', String(port));
    vi.stubEnv('RESILIENCE_SSRF_ALLOW_CIDRS', '127.0.0.1/32');
    app = await createTestApp([ResilienceModule]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('returns a Web Response with status, headers and body', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    const r = await f(`http://127.0.0.1:${port}/jwks`, {
      method: 'GET',
      headers: new Headers({ accept: 'application/json' }),
      redirect: 'manual',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-a')).toBe('1');
    expect(await r.json()).toEqual({ keys: [] });
  });
  it('caller abort really cancels the request and rethrows the caller reason', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks-slow');
    const signal = AbortSignal.timeout(CALLER_TIMEOUT_MS);
    await expect(
      f(`http://127.0.0.1:${port}/slow`, { signal, redirect: 'manual' }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(slowClosed).toBeGreaterThan(0));
  });
  it('refuses to follow redirects', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    await expect(
      f(`http://127.0.0.1:${port}/jwks`, { redirect: 'follow' }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('still blocks private addresses outside the allow list', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    await expect(
      f('http://10.0.0.1/jwks', { redirect: 'manual' }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('keeps every Set-Cookie header separate', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    const r = await f(`http://127.0.0.1:${port}/cookies`, {
      redirect: 'manual',
    });
    expect(r.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });
  it('returns a null body for a 204', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks');
    const r = await f(`http://127.0.0.1:${port}/empty`, { redirect: 'manual' });
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
  });
  it('an already-aborted caller signal never reaches the upstream', async () => {
    const f = toWebFetch(app.get(HttpClient), 'fixture-jwks-aborted');
    const before = slowHits;
    const reason = new Error('caller gave up');
    await expect(
      f(`http://127.0.0.1:${port}/slow`, {
        signal: AbortSignal.abort(reason),
        redirect: 'manual',
      }),
    ).rejects.toBe(reason);
    expect(slowHits).toBe(before);
  });
});

describe('HttpClient caller signal and the provider policy', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('RESILIENCE_ALLOWED_SCHEMES', 'http,https');
    vi.stubEnv('RESILIENCE_ALLOWED_PORTS', String(port));
    vi.stubEnv('RESILIENCE_SSRF_ALLOW_CIDRS', '127.0.0.1/32');
    // Retry 2 lần và breaker mở sau 2 thất bại liên tiếp: nếu caller abort bị retry, mỗi lần thử tính vào breaker.
    vi.stubEnv('RESILIENCE_DEFAULT_RETRIES', '2');
    vi.stubEnv('RESILIENCE_DEFAULT_RETRY_BASE_MS', '1');
    vi.stubEnv('RESILIENCE_DEFAULT_BREAKER_THRESHOLD', '2');
    app = await createTestApp([ResilienceModule]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('a caller abort is not retried and does not open the breaker by itself', async () => {
    const client = app.get(HttpClient);
    const provider = 'fixture-caller-abort';
    const before = slowHits;
    await expect(
      client.request(provider, `http://127.0.0.1:${port}/slow`, {
        signal: AbortSignal.timeout(CALLER_TIMEOUT_MS),
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(slowHits - before).toBe(1);
    const ok = await client.request(provider, `http://127.0.0.1:${port}/jwks`);
    expect(ok.status).toBe(200);
  });
});
