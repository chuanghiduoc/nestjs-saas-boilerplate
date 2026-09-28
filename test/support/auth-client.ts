import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import type { Mailpit } from './mailpit.js';

export const TEST_ORIGIN = 'http://localhost:3000';
/** Dải 198.18.0.0/15 (benchmark, RFC 2544): mỗi client một IP, để rate limit IP của Better Auth không dính giữa test. */
const randomTestIp = () => `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
type Opts = {
  body?: unknown;
  origin?: string | null;
  bearer?: string;
  apiKey?: string;
  cookie?: string | false;
  headers?: Record<string, string>;
};

/** Client e2e: cookie jar tường minh (thấy mọi `Set-Cookie`), Origin tin cậy mặc định, IP riêng. */
export class AuthClient {
  readonly cookies = new Map<string, string>();
  bearer: string | undefined;
  readonly ip: string;
  constructor(
    /** Server trong process, hoặc URL gốc của một API chạy ở process khác (test log thật, Task 40 I1). */
    private readonly server: Server | string,
    private readonly origin = TEST_ORIGIN,
    opts: { ip?: string } = {},
  ) {
    this.ip = opts.ip ?? randomTestIp();
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res: Response): void {
    const raw = res.headers['set-cookie'];
    for (const c of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const [pair = ''] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === '' || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const token = res.headers['set-auth-token'];
    if (typeof token === 'string') this.bearer = token;
  }
  async request(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    o: Opts = {},
  ): Promise<Response> {
    let r = request(this.server)[method](path).set('x-forwarded-for', this.ip);
    if (o.origin !== null) r = r.set('origin', o.origin ?? this.origin);
    const cookie = o.cookie === undefined ? this.cookieHeader() : o.cookie;
    if (cookie) r = r.set('cookie', cookie);
    if (o.bearer) r = r.set('authorization', `Bearer ${o.bearer}`);
    if (o.apiKey !== undefined) r = r.set('x-api-key', o.apiKey);
    for (const [k, v] of Object.entries(o.headers ?? {})) r = r.set(k, v);
    const res = o.body === undefined ? await r : await r.send(o.body as object);
    this.absorb(res);
    return res;
  }
  signUp(
    email: string,
    password: string,
    name = 'Test User',
  ): Promise<Response> {
    return this.request('post', '/api/auth/sign-up/email', {
      body: { email, password, name },
      cookie: false,
    });
  }
  signIn(email: string, password: string): Promise<Response> {
    return this.request('post', '/api/auth/sign-in/email', {
      body: { email, password },
      cookie: false,
    });
  }
  /** Mở link xác thực trong thư (host trong link là AUTH_BASE_URL; gọi đúng path + query trên server test). */
  async verifyEmailFromMailpit(
    mailpit: Mailpit,
    email: string,
    after?: number,
  ): Promise<Response> {
    const msg = await mailpit.waitFor(email, {
      subject: /Verify your email/,
      after,
    });
    const link =
      /https?:\/\/[^\s"<>]+\/api\/auth\/verify-email\?[^\s"<>]+/.exec(
        msg.Text,
      )?.[0];
    if (!link) throw new Error('no verification link in the email');
    const u = new URL(link.replaceAll('&amp;', '&'));
    return this.request('get', `${u.pathname}${u.search}`, { cookie: false });
  }
}
