import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import { type ConfigOf } from '../../../../core/config/index.js';
import { identityGuardConfig } from '../../identity.config.js';
import {
  AuthHousekeeping,
  type AuthPurgeTarget,
} from '../../ports/auth-housekeeping.js';
import { AUTH_POOL } from './auth-pool.provider.js';

const MS_PER_SECOND = 1000;
const CountRow = z.object({ n: z.number().int() });
const batchDelete = (
  table: string,
  key: string,
  where: string,
  order: string,
) =>
  `WITH victim AS (SELECT t.${key} FROM ${table} t WHERE ${where} ORDER BY t.${order} LIMIT $1 FOR UPDATE SKIP LOCKED)
   , d AS (DELETE FROM ${table} t USING victim v WHERE t.${key} = v.${key} AND (${where}) RETURNING 1)
   SELECT count(*)::int AS n FROM d`;
/** Câu SQL cố định theo bảng (không nối input); index: session/verification(expires_at), login_attempts(expire). */
const SQL: Record<AuthPurgeTarget, string> = {
  session: batchDelete(
    'auth.session',
    'id',
    't.expires_at < now()',
    'expires_at',
  ),
  verification: batchDelete(
    'auth.verification',
    'id',
    't.expires_at < now()',
    'expires_at',
  ),
  // rate_limit.last_request và login_attempts.expire là epoch ms (schema của thư viện, spec §5.16b).
  rate_limit: batchDelete(
    'auth.rate_limit',
    'id',
    't.last_request < $2',
    'last_request',
  ),
  login_attempts: batchDelete(
    'auth.login_attempts',
    'key',
    't.expire < $2',
    'expire',
  ),
};

@Injectable()
export class PgAuthHousekeeping extends AuthHousekeeping {
  constructor(
    @Inject(AUTH_POOL) private readonly pool: pg.Pool,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: ConfigOf<typeof identityGuardConfig>,
  ) {
    super();
  }

  async purgeExpired(target: AuthPurgeTarget, limit: number): Promise<number> {
    z.number().int().positive().parse(limit);
    const nowMs = Date.now();
    // Một dòng rate_limit chỉ còn tác dụng trong cửa sổ dài nhất đang cấu hình.
    const longestWindowMs =
      Math.max(
        this.guard.rateLimitWindowSec,
        this.guard.signinRateWindowSec,
        this.guard.twoFactorRateWindowSec,
        this.guard.emailRateWindowSec,
      ) * MS_PER_SECOND;
    const params: unknown[] =
      target === 'rate_limit'
        ? [limit, nowMs - longestWindowMs]
        : target === 'login_attempts'
          ? [limit, nowMs]
          : [limit];
    const { rows } = await this.pool.query(SQL[target], params);
    return CountRow.parse(rows[0]).n;
  }
}
