import { Logger } from '@nestjs/common';
import pg from 'pg';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseConfig } from '../../../src/core/database/index.js';
import { authDatabaseConfig } from '../../../src/modules/identity/identity.config.js';
import { emailHash } from '../../../src/modules/identity/infra/better-auth/email-normalize.js';
import { createAuthPool } from '../../../src/modules/identity/infra/better-auth/auth-pool.js';
import {
  LockoutBlockedError,
  LockoutUnavailableError,
  LoginLockout,
} from '../../../src/modules/identity/infra/better-auth/login-lockout.js';
import { applyTestEnv } from '../../support/app-factory.js';
import { getInfra } from '../../support/infra.js';
import { installOtelCapture } from '../../support/otel-capture.js';

const otel = installOtelCapture();
const MAX = 5;
const WINDOW_SEC = 60;
const BLOCK_SEC = 120;
const cfg = { maxFailures: MAX, windowSec: WINDOW_SEC, blockSec: BLOCK_SEC };

describe('LoginLockout (RateLimiterPostgres on auth.login_attempts)', () => {
  let a: pg.Pool;
  let b: pg.Pool;
  let owner: pg.Client;
  beforeAll(async () => {
    applyTestEnv();
    a = createAuthPool(authDatabaseConfig(), databaseConfig());
    b = createAuthPool(authDatabaseConfig(), databaseConfig());
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => {
    await a?.end();
    await b?.end();
    await owner?.end();
  });

  it('MAX + k concurrent failures from two instances: exactly k are refused before verification, account blocked', async () => {
    const email = `l-${v7()}@example.test`;
    const k = 3;
    const windowTime = Date.now();
    const one = new LoginLockout(a, cfg, () => windowTime);
    const two = new LoginLockout(b, cfg, () => windowTime);
    const results = await Promise.allSettled(
      Array.from({ length: MAX + k }, (_, i) =>
        (i % 2 ? one : two).guard({ kind: 'signin', email }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' && r.reason instanceof LockoutBlockedError,
      ),
    ).toHaveLength(k);
    await expect(one.guard({ kind: 'signin', email })).rejects.toMatchObject({
      retryAfterSec: expect.any(Number),
    });
    expect(
      await otel.metric('identity_lockout_blocked_total', { scope: 'signin' }),
    ).toBeGreaterThanOrEqual(k + 1);
    expect(
      otel
        .spans('identity.lockout.consume')
        .some((sp) => sp.attributes['identity.lockout.scope'] === 'signin'),
    ).toBe(true);
    expect(otel.spanNames()).toContain('identity.lockout.consume');
    for (const span of otel.spans('identity.lockout.consume')) {
      expect(span.attributes['identity.lockout.scope']).toBe('signin');
      expect(
        JSON.stringify({ attributes: span.attributes, events: span.events }),
      ).not.toContain(email);
    }
  });
  it('a successful sign-in refunds only its own attempt, never other concurrent failures', async () => {
    const email = `r-${v7()}@example.test`;
    const lock = new LoginLockout(a, cfg);
    for (let i = 0; i < MAX - 1; i++)
      await lock.guard({ kind: 'signin', email });
    const ok = await lock.guard({ kind: 'signin', email });
    await lock.refund(ok);
    await expect(lock.guard({ kind: 'signin', email })).resolves.toBeDefined();
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
  });
  it('a late refund after the window rolled over does not touch the new window', async () => {
    const email = `w-${v7()}@example.test`;
    let now = Date.UTC(2026, 8, 27, 10, 0, 0);
    const lock = new LoginLockout(a, cfg, () => now);
    const ticket = await lock.guard({ kind: 'signin', email });
    now += WINDOW_SEC * 1000;
    for (let i = 0; i < MAX; i++) await lock.guard({ kind: 'signin', email });
    await lock.refund(ticket);
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
  });
  it('an unknown email is locked exactly like a known one; case variants share the key', async () => {
    const lock = new LoginLockout(a, cfg);
    const email = `Nobody-${v7()}@Example.test`;
    for (let i = 0; i < MAX; i++)
      await lock.guard({
        kind: 'signin',
        email: i % 2 ? email.toLowerCase() : ` ${email} `,
      });
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
    const { rows } = await owner.query(
      `SELECT key FROM auth.login_attempts WHERE key LIKE '%' || $1 || '%'`,
      [email],
    );
    expect(rows).toEqual([]);
    const stored = await owner.query<{ key: string }>(
      `SELECT key FROM auth.login_attempts WHERE key LIKE '%' || $1 || '%'`,
      [emailHash(email)],
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.key).not.toContain('@');
      expect(row.key).toContain(emailHash(email));
    }
  });
  it('storage failure is LockoutUnavailableError (fail-closed, never allowed through)', async () => {
    const lock = new LoginLockout(a, cfg);
    await owner.query(
      'REVOKE INSERT, UPDATE ON auth.login_attempts FROM auth_user',
    );
    try {
      await expect(
        lock.guard({ kind: 'signin', email: `f-${v7()}@example.test` }),
      ).rejects.toBeInstanceOf(LockoutUnavailableError);
    } finally {
      await owner.query(
        'GRANT INSERT, UPDATE ON auth.login_attempts TO auth_user',
      );
    }
  });
  it('concurrent duplicate refunds across pools return exactly one point per ticket', async () => {
    const email = `idempotent-${v7()}@example.test`;
    const windowTime = Date.now();
    const one = new LoginLockout(a, cfg, () => windowTime);
    const two = new LoginLockout(b, cfg, () => windowTime);
    const ticket = await one.guard({ kind: 'signin', email });
    await Promise.all(
      Array.from({ length: MAX - 1 }, () =>
        two.guard({ kind: 'signin', email }),
      ),
    );
    await Promise.all(
      Array.from({ length: MAX }, (_, i) =>
        (i % 2 ? one : two).refund({ ...ticket }),
      ),
    );
    await one.refund(ticket);
    await expect(two.guard({ kind: 'signin', email })).resolves.toBeDefined();
    await expect(one.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
  });

  it('uses [w*W, (w+1)*W): boundary minus 1ms is old, equality is new', async () => {
    const email = `boundary-${v7()}@example.test`;
    const start = Date.UTC(2026, 8, 27, 10, 0, 0);
    let now = start;
    const lock = new LoginLockout(a, cfg, () => now);
    const ticket = await lock.guard({ kind: 'signin', email });
    now = start + WINDOW_SEC * 1000 - 1;
    for (let i = 0; i < MAX - 1; i++)
      await lock.guard({ kind: 'signin', email });
    now++;
    for (let i = 0; i < MAX; i++) await lock.guard({ kind: 'signin', email });
    await lock.refund(ticket);
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
  });

  it('block remains active across windows and expires at equality (expire <= now)', async () => {
    const email = `expiry-${v7()}@example.test`;
    let now = Date.UTC(2026, 8, 27, 10, 0, 0);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const lock = new LoginLockout(a, cfg, () => now);
      for (let i = 0; i < MAX; i++) await lock.guard({ kind: 'signin', email });
      await expect(lock.guard({ kind: 'signin', email })).rejects.toMatchObject(
        { retryAfterSec: BLOCK_SEC },
      );
      now += BLOCK_SEC * 1000 - 1;
      await expect(lock.guard({ kind: 'signin', email })).rejects.toMatchObject(
        { retryAfterSec: 1 },
      );
      now++;
      await expect(
        lock.guard({ kind: 'signin', email }),
      ).resolves.toBeDefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('a refund permission failure resolves without applying (S2-R35 fail-closed, never throws); the whole statement is denied, nothing partially decrements; retry after the grant succeeds', async () => {
    const email = `refund-fail-${v7()}@example.test`;
    const lock = new LoginLockout(a, cfg);
    const ticket = await lock.guard({ kind: 'signin', email });
    for (let i = 0; i < MAX - 1; i++)
      await lock.guard({ kind: 'signin', email });
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await owner.query('REVOKE UPDATE ON auth.login_attempts FROM auth_user');
    try {
      await expect(lock.refund(ticket)).resolves.toBeUndefined();
    } finally {
      await owner.query('GRANT UPDATE ON auth.login_attempts TO auth_user');
    }
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'identity_lockout_refund_failed',
        scope: 'signin',
        pgCode: '42501',
      }),
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(email);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(emailHash(email));
    warn.mockRestore();
    expect(
      await otel.metric('identity_lockout_refund_failed_total', {
        scope: 'signin',
      }),
    ).toBeGreaterThanOrEqual(1);
    // Nothing applied: the account is still fully consumed (0 slots free) until a real refund lands.
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
  });
  it('a refund permission failure never touches the aggregate or the ticket marker (permission is checked before any row is written); a later real refund still claims it', async () => {
    const email = `refund-fail-marker-${v7()}@example.test`;
    const lock = new LoginLockout(a, cfg);
    const ticket = await lock.guard({ kind: 'signin', email });
    await owner.query('REVOKE UPDATE ON auth.login_attempts FROM auth_user');
    try {
      await lock.refund(ticket);
    } finally {
      await owner.query('GRANT UPDATE ON auth.login_attempts TO auth_user');
    }
    await lock.refund(ticket);
    for (let i = 0; i < MAX; i++) await lock.guard({ kind: 'signin', email });
    await expect(lock.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
  });
  it('refund with a malformed ticket throws a plain programmer error, never LockoutUnavailableError (review M1)', async () => {
    const lock = new LoginLockout(a, cfg);
    await expect(
      lock.refund({ attemptKey: 'not-a-real-ticket' }),
    ).rejects.toThrow(/malformed lockout ticket/i);
    await expect(
      lock.refund({ attemptKey: 'not-a-real-ticket' }),
    ).rejects.not.toBeInstanceOf(LockoutUnavailableError);
  });
  it('guard with a scope outside the union throws a plain programmer error, never LockoutUnavailableError (review M1)', async () => {
    const lock = new LoginLockout(a, cfg);
    const bogus = { kind: 'oauth', email: 'x@example.test' } as unknown as {
      kind: 'signin';
      email: string;
    };
    await expect(lock.guard(bogus)).rejects.toThrow(/unknown lockout scope/i);
    await expect(lock.guard(bogus)).rejects.not.toBeInstanceOf(
      LockoutUnavailableError,
    );
  });

  it('an ended pool fails closed', async () => {
    const pool = createAuthPool(authDatabaseConfig(), databaseConfig());
    const lock = new LoginLockout(pool, cfg);
    await pool.end();
    await expect(
      lock.guard({ kind: 'signin', email: `closed-${v7()}@example.test` }),
    ).rejects.toBeInstanceOf(LockoutUnavailableError);
  });

  it('2fa has a separate budget and only a scope telemetry label', async () => {
    const subject = v7();
    const lock = new LoginLockout(a, cfg);
    for (let i = 0; i < MAX; i++) await lock.guard({ kind: '2fa', subject });
    await expect(lock.guard({ kind: '2fa', subject })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
    await expect(
      lock.guard({ kind: 'signin', email: subject }),
    ).resolves.toBeDefined();
    expect(
      await otel.metric('identity_lockout_blocked_total', { scope: '2fa' }),
    ).toBeGreaterThanOrEqual(1);
    for (const span of otel.spans('identity.lockout.consume'))
      expect(JSON.stringify(span.attributes)).not.toContain(subject);
  });
  it('distinct tickets refund independently during concurrent consumption', async () => {
    const email = `distinct-${v7()}@example.test`;
    const windowTime = Date.now();
    const one = new LoginLockout(a, cfg, () => windowTime);
    const two = new LoginLockout(b, cfg, () => windowTime);
    const tickets = await Promise.all(
      Array.from({ length: MAX - 1 }, () =>
        one.guard({ kind: 'signin', email }),
      ),
    );
    expect(new Set(tickets.map((ticket) => ticket.attemptKey)).size).toBe(
      MAX - 1,
    );
    await Promise.all([
      ...tickets.map((ticket) => two.refund(ticket)),
      one.guard({ kind: 'signin', email }),
    ]);
    for (let i = 0; i < MAX - 1; i++)
      await two.guard({ kind: 'signin', email });
    await expect(one.guard({ kind: 'signin', email })).rejects.toBeInstanceOf(
      LockoutBlockedError,
    );
  });

  it('refund at expire equality does not decrement or recreate the expired aggregate', async () => {
    const email = `expired-refund-${v7()}@example.test`;
    let now = Date.UTC(2026, 8, 27, 10, 0, 0);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const lock = new LoginLockout(a, cfg, () => now);
      const ticket = await lock.guard({ kind: 'signin', email });
      now += WINDOW_SEC * 1000;
      await lock.refund(ticket);
      await lock.refund(ticket);
      const { rows } = await owner.query<{ points: number }>(
        `SELECT points FROM auth.login_attempts WHERE key LIKE $1`,
        [`attempts:signin:${emailHash(email)}:%`],
      );
      expect(rows).toEqual([{ points: 1 }]);
      for (let i = 0; i < MAX; i++) await lock.guard({ kind: 'signin', email });
      await expect(
        lock.guard({ kind: 'signin', email }),
      ).rejects.toBeInstanceOf(LockoutBlockedError);
    } finally {
      clock.mockRestore();
    }
  });
});
