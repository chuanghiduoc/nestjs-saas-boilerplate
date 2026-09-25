import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import {
  HttpClient,
  ResilienceModule,
  SsrfBlockedError,
  UpstreamError,
} from '../../../../src/core/resilience/index.js';
import { createTestApp } from '../../../support/app-factory.js';

let hits = 0;
let slowClosed = 0;
let server: Server;
let port = 0;
const PROVIDER = 'fixture';
const RATE_LIMITED_PROVIDER = 'fixture-rate-limited';
const BIG_BODY_BYTES = 4096;

async function client(env: Record<string, string>): Promise<INestApplication> {
  vi.unstubAllEnvs();
  // Server fixture chạy http trên loopback, nên test bật http (production chỉ cho https).
  vi.stubEnv('RESILIENCE_ALLOWED_SCHEMES', 'http,https');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return createTestApp([ResilienceModule]);
}

describe('HttpClient (SSRF-safe)', () => {
  let open: INestApplication;
  let strict: INestApplication;
  let slow: INestApplication;
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (req.url === '/redirect') {
        res.writeHead(302, {
          location: 'http://169.254.169.254/latest/meta-data',
        });
        res.end();
        return;
      }
      if (req.url === '/big') {
        res.writeHead(200);
        res.end(Buffer.alloc(BIG_BODY_BYTES));
        return;
      }
      if (req.url === '/flaky') {
        res.writeHead(503);
        res.end('internal upstream detail 10.0.0.7');
        return;
      }
      if (req.url === '/ratelimited') {
        res.writeHead(429, { 'retry-after': '30' });
        res.end();
        return;
      }
      if (req.url === '/slow') {
        res.on('close', () => slowClosed++);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    strict = await client({
      RESILIENCE_ALLOWED_PORTS: String(port),
      RESILIENCE_SSRF_ALLOW_CIDRS: '',
    });
    open = await client({
      RESILIENCE_ALLOWED_PORTS: String(port),
      RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
      RESILIENCE_MAX_RESPONSE_BYTES: '1024',
      RESILIENCE_DEFAULT_RETRIES: '2',
      RESILIENCE_DEFAULT_RETRY_BASE_MS: '1',
    });
    slow = await client({
      RESILIENCE_ALLOWED_PORTS: String(port),
      RESILIENCE_SSRF_ALLOW_CIDRS: '127.0.0.1/32',
      RESILIENCE_DEFAULT_TIMEOUT_MS: '200',
      RESILIENCE_DEFAULT_RETRIES: '0',
    });
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await open?.close();
    await strict?.close();
    await slow?.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    vi.unstubAllEnvs();
  });

  it('DNS name resolving to a private IP is blocked at connect time; server never hit', async () => {
    const before = hits;
    await expect(
      strict.get(HttpClient).request(PROVIDER, `http://localhost:${port}/`),
    ).rejects.toThrow(/not allowed/);
    await expect(
      strict.get(HttpClient).request(PROVIDER, `http://localhost:${port}/`),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(hits).toBe(before);
  });
  it('IP literal of a private address is blocked before connecting; server never hit', async () => {
    const before = hits;
    await expect(
      strict.get(HttpClient).request(PROVIDER, `http://127.0.0.1:${port}/`),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      strict
        .get(HttpClient)
        .request(PROVIDER, `http://[::ffff:7f00:1]:${port}/`),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(hits).toBe(before);
  });
  it('allowlisted CIDR works and returns the body', async () => {
    const res = await open
      .get(HttpClient)
      .request(PROVIDER, `http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true });
  });
  it('redirects are never followed', async () => {
    const res = await open
      .get(HttpClient)
      .request(PROVIDER, `http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'http://169.254.169.254/latest/meta-data',
    );
  });
  it('response larger than the cap fails with UpstreamError, is not retried, and the client keeps working', async () => {
    const before = hits;
    const err = await open
      .get(HttpClient)
      .request(PROVIDER, `http://127.0.0.1:${port}/big`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ reason: 'too_large' });
    expect(hits - before).toBe(1);
    const ok = await open
      .get(HttpClient)
      .request(PROVIDER, `http://127.0.0.1:${port}/`);
    expect(ok.status).toBe(200);
  });
  it('retries idempotent methods only', async () => {
    let before = hits;
    await expect(
      open
        .get(HttpClient)
        .request(PROVIDER, `http://127.0.0.1:${port}/flaky`, { method: 'GET' }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(hits - before).toBe(3);
    before = hits;
    await expect(
      open.get(HttpClient).request(PROVIDER, `http://127.0.0.1:${port}/flaky`, {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(hits - before).toBe(1);
  });
  it('upstream error never carries the upstream body', async () => {
    const err = await open
      .get(HttpClient)
      .request(PROVIDER, `http://127.0.0.1:${port}/flaky`, { method: 'POST' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'bad_status', status: 503 });
    expect(JSON.stringify(err)).not.toContain('10.0.0.7');
    expect(String(err)).not.toContain('10.0.0.7');
  });
  it('429 is not retried, even for idempotent methods, and carries Retry-After', async () => {
    const before = hits;
    const err = await open
      .get(HttpClient)
      // Provider riêng: các test trước đã đưa breaker của PROVIDER tới ngưỡng.
      .request(RATE_LIMITED_PROVIDER, `http://127.0.0.1:${port}/ratelimited`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({
      reason: 'rate_limited',
      status: 429,
      retryAfter: 30,
    });
    expect(hits - before).toBe(1);
  });
  it('an invalid URL fails as SsrfBlockedError without echoing the raw URL', async () => {
    const err = await open
      .get(HttpClient)
      .request(PROVIDER, 'http://exa mple.com/?api_key=SUPERSECRET')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(err instanceof Error && err.cause).toBeFalsy();
    expect(JSON.stringify(err)).not.toContain('SUPERSECRET');
    expect(String(err)).not.toContain('SUPERSECRET');
  });
  it('timeout aborts the underlying request (server sees the connection close)', async () => {
    const before = slowClosed;
    const err = await slow
      .get(HttpClient)
      .request(PROVIDER, `http://127.0.0.1:${port}/slow`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ reason: 'timeout' });
    await vi.waitFor(() => expect(slowClosed - before).toBe(1));
  });
});
