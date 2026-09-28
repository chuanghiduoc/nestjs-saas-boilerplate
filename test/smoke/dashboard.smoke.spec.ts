import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { Mailpit } from '../support/mailpit.js';
import { SMOKE_BASE_URL } from './smoke-app-env.js';
import { smokeSubnet } from './smoke-env.js';
import {
  CookieJar,
  assertCleanLogs,
  compose,
  logsSince,
  psql,
  workerHealth,
} from './smoke-support.js';

const PASSWORD = 'smoke dashboard passphrase';
const EVIL = 'https://evil.example.test';
const MAIL_TIMEOUT_MS = 60_000;
const VERIFY_LINK = /https:\/\/localhost\/api\/auth\/verify-email\?[^\s"<>]+/;
/** Đủ cho một lần `compose run worker` tới lúc validate config và thoát. */
const WORKER_REFUSAL_TIMEOUT_MS = 60_000;
/** Worker phụ (allowlist khác) cần boot xong (DB, Redis, identity) trước khi dashboard mở cổng. */
const EXTRA_WORKER_UP_MS = 90_000;
/** SIGTERM rồi chờ tắt êm (APP_SHUTDOWN_TIMEOUT_MS 28s + biên), như `stop_grace_period` của compose. */
const EXTRA_WORKER_STOP_SEC = '30';
/** Dải TEST-NET-2 (RFC 5737): không container nào của smoke mang IP này. */
const FOREIGN_ALLOWLIST = '198.51.100.0/24';
const DASHBOARD = 'http://worker:3002/queues';
const QUEUES = ['events', 'maintenance', 'notifications'] as const;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type DashboardResponse = {
  status: number;
  contentType: string | null;
  body: string;
};
type Problem = { code?: unknown; requestId?: unknown; instance?: unknown };
type QueueView = { name: string; readOnlyMode: boolean; isPaused: boolean };

/**
 * Gọi dashboard TỪ BÊN TRONG mạng compose (container api có node): IP nguồn chắc chắn thuộc COMPOSE_SUBNET trên mọi
 * nền tảng (port-forward của Docker Desktop có thể đổi IP nguồn). `upWithinMs`: thử lại khi cổng chưa mở (worker phụ
 * đang boot). Kết quả đi ra stdout dạng JSON một dòng.
 */
function probe(
  url: string,
  o: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    upWithinMs?: number;
  } = {},
): DashboardResponse {
  const init = JSON.stringify({
    method: o.method ?? 'GET',
    headers: o.headers ?? {},
    ...(o.body === undefined ? {} : { body: o.body }),
  });
  const script = `
const deadline = Date.now() + ${o.upWithinMs ?? 0};
const call = () => fetch(${JSON.stringify(url)}, ${init}).then(async (r) =>
  console.log(JSON.stringify({ status: r.status, contentType: r.headers.get('content-type'), body: await r.text() })));
const attempt = () => call().catch((e) => {
  if (Date.now() < deadline) return new Promise((ok) => setTimeout(ok, 1000)).then(attempt);
  console.error(e.message); process.exit(1);
});
attempt();`;
  const out = compose(['exec', '-T', 'api', '/nodejs/bin/node', '-e', script], {
    timeoutMs: (o.upWithinMs ?? 0) + 30_000,
  });
  const parsed: unknown = JSON.parse(out.trim());
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('status' in parsed) ||
    typeof parsed.status !== 'number' ||
    !('body' in parsed) ||
    typeof parsed.body !== 'string' ||
    !('contentType' in parsed)
  )
    throw new Error(`unexpected dashboard probe output: ${out}`);
  return {
    status: parsed.status,
    contentType:
      typeof parsed.contentType === 'string' ? parsed.contentType : null,
    body: parsed.body,
  };
}
const problem = (r: DashboardResponse): Problem => {
  expect(r.contentType).toContain('application/problem+json');
  return JSON.parse(r.body) as Problem;
};
const queueViews = (r: DashboardResponse): QueueView[] =>
  (JSON.parse(r.body) as { queues: QueueView[] }).queues;

type Session = { email: string; cookie: string; bearer: string; ip: string };

describe('prod-like smoke: Bull Board on the worker (read-only, platform admin only)', () => {
  const { apiUrl, mailpitApiUrl, startedAt } = inject('smoke');
  const since = new Date().toISOString();
  const mail = new Mailpit(mailpitApiUrl);
  const forbidden: string[] = [PASSWORD];

  /** Một thiết bị phía sau ingress (IP riêng qua X-Forwarded-For, HTTP_TRUST_PROXY=1): rate limit theo IP không dính nhau. */
  const signedIn = async (role?: 'admin'): Promise<Session> => {
    const email = `dash-${randomUUID()}@example.test`;
    const ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
    const jar = new CookieJar();
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${apiUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          origin: SMOKE_BASE_URL,
          'x-forwarded-for': ip,
          ...(jar.header() ? { cookie: jar.header() } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const started = Date.now();
    expect(
      (
        await call('POST', '/api/auth/sign-up/email', {
          email,
          password: PASSWORD,
          name: 'Dash',
        })
      ).status,
    ).toBe(202);
    const msg = await mail.waitFor(email, {
      subject: /Verify your email/,
      timeoutMs: MAIL_TIMEOUT_MS,
      after: started,
    });
    const link = VERIFY_LINK.exec(msg.Text)?.[0];
    if (!link) throw new Error('no https verify-email link in the email');
    const u = new URL(link.replaceAll('&amp;', '&'));
    expect(
      (
        await fetch(`${apiUrl}${u.pathname}${u.search}`, {
          redirect: 'manual',
          headers: { 'x-forwarded-for': ip },
        })
      ).status,
    ).toBeLessThan(400);
    if (role)
      psql(
        `UPDATE auth."user" SET role = 'admin' WHERE email = '${email.replaceAll("'", "''")}'`,
      );
    const res = await call('POST', '/api/auth/sign-in/email', {
      email,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    jar.absorb(res);
    const s = {
      email,
      cookie: jar.header(),
      bearer: res.headers.get('set-auth-token') ?? '',
      ip,
    };
    expect(s.cookie).toMatch(/__Secure-[^=;]+\.session_token=/);
    expect(s.bearer).not.toBe('');
    forbidden.push(email, s.cookie, s.bearer);
    return s;
  };
  const apiCall = (s: Session, method: string, path: string, body?: unknown) =>
    fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: SMOKE_BASE_URL,
        'x-forwarded-for': s.ip,
        cookie: s.cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let user: Session;
  let admin: Session;

  it('wiring: the worker serves the dashboard in production with the allowlist = exactly the compose subnet', async () => {
    const subnet = smokeSubnet();
    const id = compose(['ps', '-q', 'worker']).trim();
    const envLines = execFileSync(
      'docker',
      ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', id],
      { encoding: 'utf8' },
    ).split(/\r?\n/);
    expect(envLines).toEqual(
      expect.arrayContaining([
        'NODE_ENV=production',
        'QUEUE_DASHBOARD_ENABLED=true',
        `QUEUE_DASHBOARD_IP_ALLOWLIST=${subnet}`,
      ]),
    );
    const networks = execFileSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}',
        id,
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split(' ');
    expect(networks).toHaveLength(1);
    const ipam = execFileSync(
      'docker',
      [
        'network',
        'inspect',
        '--format',
        '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
        networks[0] ?? '',
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(ipam).toBe(subnet);
    const boot = compose([
      'logs',
      '--no-color',
      '--no-log-prefix',
      '--since',
      startedAt,
      'worker',
    ]);
    expect(boot).toContain('queue dashboard listening');
  });

  it('no credential → 401 problem+json with a fresh uuidv7 request id per request', () => {
    const a = probe(`${DASHBOARD}/api/queues`);
    const b = probe(`${DASHBOARD}/api/queues`);
    expect([a.status, b.status]).toEqual([401, 401]);
    const pa = problem(a);
    const pb = problem(b);
    expect(pa.code).toBe('unauthenticated');
    expect(pa.instance).toBe('/queues/api/queues');
    expect(pa.requestId).toMatch(UUID_V7);
    expect(pb.requestId).toMatch(UUID_V7);
    expect(pa.requestId).not.toBe(pb.requestId);
  });

  it('ordinary user → 403; platform admin via cookie → 200 and via bearer → 200; every queue is read-only', async () => {
    user = await signedIn();
    admin = await signedIn('admin');
    const denied = probe(`${DASHBOARD}/api/queues`, {
      headers: { cookie: user.cookie },
    });
    expect(denied.status).toBe(403);
    expect(problem(denied).code).toBe('forbidden');
    expect(
      probe(`${DASHBOARD}/api/queues`, {
        headers: { authorization: `Bearer ${user.bearer}` },
      }).status,
    ).toBe(403);
    const viaCookie = probe(`${DASHBOARD}/api/queues`, {
      headers: { cookie: admin.cookie },
    });
    expect(viaCookie.status).toBe(200);
    const views = queueViews(viaCookie);
    expect(views.map((q) => q.name).sort()).toEqual([...QUEUES]);
    for (const q of views) expect(q.readOnlyMode, q.name).toBe(true);
    expect(
      probe(`${DASHBOARD}/api/queues`, {
        headers: { authorization: `Bearer ${admin.bearer}` },
      }).status,
    ).toBe(200);
    // Trang UI (HTML) của Bull Board cũng sau cùng cổng.
    expect(probe(`${DASHBOARD}`).status).toBe(401);
    expect(
      probe(`${DASHBOARD}`, { headers: { cookie: admin.cookie } }).status,
    ).toBe(200);
  });

  it('an API key, even of a platform admin → 403', async () => {
    const created = await apiCall(admin, 'POST', '/api/auth/api-key/create', {
      name: 'dash-smoke',
    });
    expect(created.status).toBe(200);
    const key = String(((await created.json()) as { key?: unknown }).key);
    forbidden.push(key);
    const r = probe(`${DASHBOARD}/api/queues`, {
      headers: { 'x-api-key': key },
    });
    expect(r.status).toBe(403);
    expect(problem(r).code).toBe('forbidden');
  });

  it('cookie + bearer on one request → 400 ambiguous_credentials', () => {
    const r = probe(`${DASHBOARD}/api/queues`, {
      headers: {
        cookie: admin.cookie,
        authorization: `Bearer ${admin.bearer}`,
      },
    });
    expect(r.status).toBe(400);
    expect(problem(r).code).toBe('ambiguous_credentials');
  });

  it('a rejected credential (forged cookie, revoked session) → 401', async () => {
    const name = /^([^=]+)=/.exec(admin.cookie)?.[1] ?? '';
    expect(
      probe(`${DASHBOARD}/api/queues`, {
        headers: { cookie: `${name}=forged.value` },
      }).status,
    ).toBe(401);
    const gone = await signedIn('admin');
    expect(
      probe(`${DASHBOARD}/api/queues`, {
        headers: { cookie: gone.cookie },
      }).status,
    ).toBe(200);
    expect((await apiCall(gone, 'POST', '/api/auth/sign-out')).status).toBe(
      200,
    );
    const r = probe(`${DASHBOARD}/api/queues`, {
      headers: { cookie: gone.cookie },
    });
    expect(r.status).toBe(401);
    expect(problem(r).code).toBe('unauthenticated');
  });

  it('a cross-site PUT with the admin cookie → 403 origin_not_allowed', () => {
    const r = probe(`${DASHBOARD}/api/queues/notifications/pause`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, origin: EVIL },
    });
    expect(r.status).toBe(403);
    expect(problem(r).code).toBe('origin_not_allowed');
  });

  it('read-only even for an admin: every per-queue write → 405; the board-wide pause is a no-op', () => {
    const writes: [string, string, string?][] = [
      ['PUT', '/api/queues/notifications/pause'],
      ['PUT', '/api/queues/notifications/resume'],
      ['PUT', '/api/queues/notifications/empty'],
      ['PUT', '/api/queues/notifications/obliterate', '{}'],
      ['PUT', '/api/queues/notifications/clean/completed'],
      ['PUT', '/api/queues/notifications/retry/failed'],
      ['PUT', '/api/queues/notifications/promote'],
      ['PUT', '/api/queues/events/concurrency', '{"concurrency":1}'],
      ['POST', '/api/queues/maintenance/add', '{"name":"x","data":{}}'],
      ['PUT', '/api/queues/notifications/1/retry'],
      ['PATCH', '/api/queues/notifications/1/update-data', '{"jobData":{}}'],
    ];
    for (const [method, path, body] of writes) {
      const r = probe(`${DASHBOARD}${path}`, {
        method,
        headers: {
          cookie: admin.cookie,
          origin: SMOKE_BASE_URL,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
      });
      expect(r.status, `${method} ${path}`).toBe(405);
    }
    // Bull Board 9.10.1 (`pauseAll`/`resumeAll`) lọc bỏ queue readOnlyMode rồi trả 200: không queue nào bị dừng.
    expect(
      probe(`${DASHBOARD}/api/queues/pause`, {
        method: 'PUT',
        headers: { cookie: admin.cookie, origin: SMOKE_BASE_URL },
      }).status,
    ).toBe(200);
    const after = queueViews(
      probe(`${DASHBOARD}/api/queues`, {
        headers: { cookie: admin.cookie },
      }),
    );
    for (const q of after) expect(q.isPaused, q.name).toBe(false);
  });

  it('the job listing shows ids, never PII: no signed-up address appears in any queue', () => {
    for (const q of QUEUES) {
      const r = probe(
        `${DASHBOARD}/api/queues?activeQueue=${q}&status=latest&page=1&jobsPerPage=100`,
        { headers: { cookie: admin.cookie } },
      );
      expect(r.status).toBe(200);
      for (const f of forbidden) expect(r.body, q).not.toContain(f);
    }
    // Thư xác minh của bài này đã đi qua queue notifications: danh sách không rỗng mà vẫn không có PII.
    const notifications = probe(
      `${DASHBOARD}/api/queues?activeQueue=notifications&status=completed&page=1&jobsPerPage=100`,
      { headers: { cookie: admin.cookie } },
    );
    expect(
      (
        JSON.parse(notifications.body) as {
          queues: { name: string; jobs: unknown[] }[];
        }
      ).queues.find((q) => q.name === 'notifications')?.jobs.length,
    ).toBeGreaterThan(0);
  });

  it.each([
    [
      'a CIDR with an empty prefix',
      '10.0.0.0/',
      /QUEUE_DASHBOARD_IP_ALLOWLIST: entry at index 0 is not a valid IP or CIDR/,
    ],
    [
      '/0',
      '0.0.0.0/0',
      /QUEUE_DASHBOARD_IP_ALLOWLIST: entry at index 0 is not a valid IP or CIDR/,
    ],
    [
      'a garbage second entry',
      '10.0.0.0/8, not-an-ip',
      /QUEUE_DASHBOARD_IP_ALLOWLIST: entry at index 1 is not a valid IP or CIDR/,
    ],
    [
      'an empty allowlist',
      '',
      /QUEUE_DASHBOARD_IP_ALLOWLIST must not be empty when QUEUE_DASHBOARD_ENABLED=true in production/,
    ],
  ])('the worker refuses to start with %s', (_name, value, error) => {
    expect(() =>
      compose(
        [
          'run',
          '--rm',
          '--no-deps',
          '-e',
          `QUEUE_DASHBOARD_IP_ALLOWLIST=${value}`,
          'worker',
        ],
        { timeoutMs: WORKER_REFUSAL_TIMEOUT_MS },
      ),
    ).toThrow(error);
  });

  it('a caller outside the IP allowlist → 403 before any credential is looked at', () => {
    const name = `smoke-dash-ip-${randomUUID().slice(0, 8)}`;
    compose([
      'run',
      '-d',
      '--no-deps',
      '--name',
      name,
      '-e',
      `QUEUE_DASHBOARD_IP_ALLOWLIST=${FOREIGN_ALLOWLIST}`,
      'worker',
    ]);
    try {
      const r = probe(`http://${name}:3002/queues/api/queues`, {
        headers: { cookie: admin.cookie },
        upWithinMs: EXTRA_WORKER_UP_MS,
      });
      expect(r.status).toBe(403);
      const p = problem(r);
      expect(p.code).toBe('forbidden');
      expect(p.requestId).toMatch(UUID_V7);
      execFileSync('docker', ['stop', '-t', EXTRA_WORKER_STOP_SEC, name], {
        stdio: 'ignore',
      });
      const logs = execFileSync('docker', ['logs', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const denied = logs
        .split(/\r?\n/)
        .filter((l) => l.includes('"dashboard_ip_denied"'));
      expect(denied).toHaveLength(1);
      expect(denied[0]).toContain(String(p.requestId));
      assertCleanLogs(logs, forbidden);
    } finally {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
  });

  it('api and worker are ready and healthy; logs carry no error, no PII, no credentials', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    expect(probe('http://worker:3001/health/ready').status).toBe(200);
    expect(workerHealth()).toBe('healthy');
    assertCleanLogs(logsSince(since), forbidden);
  });
});
