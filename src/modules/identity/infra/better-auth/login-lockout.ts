import { createHash, randomUUID } from 'node:crypto';
import { metrics, trace } from '@opentelemetry/api';
import type pg from 'pg';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { IDENTITY_METER, identitySpan } from '../../identity-telemetry.js';
import { AUTH_SCHEMA, LOGIN_ATTEMPTS_TABLE } from './auth-schema.js';
import { emailHash } from './email-normalize.js';

export const LOGIN_LOCKOUT = Symbol('identity.loginLockout');
const MS_PER_SECOND = 1000;
const ATTEMPTS_PREFIX = 'attempts';
const BLOCKS_PREFIX = 'blocks';
const BLOCK_POINTS = 1;
const TICKETS_PREFIX = 'tickets';
const TABLE = `"${AUTH_SCHEMA}"."${LOGIN_ATTEMPTS_TABLE}"`;
const TICKET_PATTERN =
  /^(signin:[a-f0-9]{64}|2fa:[a-f0-9]{64}):w(-?\d+):t[0-9a-f-]{36}$/;

export type LockoutScope =
  { kind: 'signin'; email: string } | { kind: '2fa'; subject: string };
/** Opaque, serializable ticket: window key plus a unique receipt identifier. */
export type LockoutTicket = { attemptKey: string };
export type LockoutConfig = {
  maxFailures: number;
  windowSec: number;
  blockSec: number;
};

export class LockoutBlockedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super('Account temporarily locked');
    this.name = 'LockoutBlockedError';
  }
}

export class LockoutUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Lockout storage unavailable', options);
    this.name = 'LockoutUnavailableError';
  }
}

/** SQL upsert serializes consumption across pods; numbered keys isolate windows. */
export class LoginLockout {
  private readonly attempts: RateLimiterPostgres;
  private readonly blocks: RateLimiterPostgres;
  private readonly blockedTotal = metrics
    .getMeter(IDENTITY_METER)
    .createCounter('identity_lockout_blocked_total', {
      description:
        'Sign-in/2FA attempts refused by the per-account lockout before verification',
    });

  constructor(
    private readonly pool: pg.Pool,
    private readonly cfg: LockoutConfig,
    private readonly now: () => number = Date.now,
  ) {
    for (const [name, value] of Object.entries(cfg)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(`Invalid lockout config: ${name}`);
    }
    const base = {
      storeClient: pool,
      storeType: 'pool',
      schemaName: AUTH_SCHEMA,
      tableName: LOGIN_ATTEMPTS_TABLE,
      tableCreated: true,
      clearExpiredByTimeout: false,
    };
    this.attempts = new RateLimiterPostgres({
      ...base,
      keyPrefix: ATTEMPTS_PREFIX,
      points: cfg.maxFailures,
      duration: cfg.windowSec,
    });
    this.blocks = new RateLimiterPostgres({
      ...base,
      keyPrefix: BLOCKS_PREFIX,
      points: BLOCK_POINTS,
      duration: cfg.blockSec,
    });
  }

  private accountKey(scope: LockoutScope): string {
    switch (scope.kind) {
      case 'signin':
        return `signin:${emailHash(scope.email)}`;
      case '2fa':
        return `2fa:${createHash('sha256').update(scope.subject).digest('hex')}`;
      default: {
        const unknown: never = scope;
        void unknown;
        throw new LockoutUnavailableError();
      }
    }
  }

  async guard(scope: LockoutScope): Promise<LockoutTicket> {
    try {
      return await identitySpan('identity.lockout.consume', () => {
        // Result attributes in identitySpan run only on success; classify failures too.
        trace
          .getActiveSpan()
          ?.setAttribute('identity.lockout.scope', scope.kind);
        return this.consume(scope);
      });
    } catch (err) {
      if (err instanceof LockoutBlockedError)
        this.blockedTotal.add(1, { scope: scope.kind });
      throw err;
    }
  }

  private async consume(scope: LockoutScope): Promise<LockoutTicket> {
    try {
      const accountKey = this.accountKey(scope);
      // [w*W, (w+1)*W): equality belongs to the next window, never the old one.
      const w = Math.floor(this.now() / (this.cfg.windowSec * MS_PER_SECOND));
      const attemptKey = `${accountKey}:w${w}`;
      const blocked = await this.blocks.get(accountKey);
      if (blocked && blocked.consumedPoints > BLOCK_POINTS)
        throw new LockoutBlockedError(
          Math.ceil(blocked.msBeforeNext / MS_PER_SECOND),
        );
      try {
        await this.attempts.consume(attemptKey);
      } catch (err) {
        if (!(err instanceof RateLimiterRes)) throw err;
        await this.blocks.block(accountKey, this.cfg.blockSec);
        throw new LockoutBlockedError(this.cfg.blockSec);
      }
      return await this.issueTicket(attemptKey);
    } catch (err) {
      if (err instanceof LockoutBlockedError) throw err;
      throw new LockoutUnavailableError({ cause: err });
    }
  }

  /** A failed ticket write retains the consumption: conservative, never fail-open. */
  private async issueTicket(attemptKey: string): Promise<LockoutTicket> {
    const ticket = { attemptKey: `${attemptKey}:t${randomUUID()}` };
    const result = await this.pool.query(
      `INSERT INTO ${TABLE} (key, points, expire)
       SELECT $1, 1, expire FROM ${TABLE} WHERE key = $2 AND expire > $3`,
      [
        `${TICKETS_PREFIX}:${ticket.attemptKey}`,
        this.attempts.getKey(attemptKey),
        Date.now(),
      ],
    );
    if (result.rowCount !== 1) throw new LockoutUnavailableError();
    return ticket;
  }

  /**
   * DELETE RETURNING claims a ticket once across pools. The dependent UPDATE is in
   * the same SQL statement/transaction: an error rolls back both operations.
   * reward() alone is not idempotent and can recreate expired rows with -1 points.
   * Never delete the aggregate; a late refund only addresses its original window.
   */
  async refund(ticket: LockoutTicket): Promise<void> {
    if (!TICKET_PATTERN.test(ticket.attemptKey))
      throw new LockoutUnavailableError();
    const attemptKey = ticket.attemptKey.slice(
      0,
      ticket.attemptKey.lastIndexOf(':t'),
    );
    try {
      await this.pool.query(
        `WITH claimed AS (
           DELETE FROM ${TABLE} WHERE key = $1 RETURNING expire
         )
         UPDATE ${TABLE} AS attempts SET points = attempts.points - 1
         FROM claimed WHERE attempts.key = $2
           AND attempts.expire = claimed.expire AND attempts.expire > $3
           AND attempts.points > 0`,
        [
          `${TICKETS_PREFIX}:${ticket.attemptKey}`,
          this.attempts.getKey(attemptKey),
          Date.now(),
        ],
      );
    } catch (err) {
      throw new LockoutUnavailableError({ cause: err });
    }
  }
}
