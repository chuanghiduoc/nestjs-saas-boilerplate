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
/**
 * Better Auth 1.7.6 tự áp các cửa sổ này bất kể `identityGuardConfig` có customRules khớp path đó hay
 * không (review M10, Task 33 review): `rateLimit.window` mặc định `10` khi ta không set
 * (`node_modules/better-auth/dist/context/create-context.mjs:173`, `options.rateLimit?.window || 10`), và
 * hai "default special rules" theo path — `/sign-in*`, `/sign-up*`, `/change-password*`, `/change-email*`
 * (window `10`) và `/request-password-reset`, `/send-verification-email`, `/forget-password*`,
 * `/email-otp/*` (window `60`) — luôn có trong `getConfiguredRateLimitWindows`
 * (`node_modules/better-auth/dist/api/rate-limiter/index.mjs:184-192,302-315`). Rule của mình (Task 33)
 * chỉ override cửa sổ cho path nó khớp; path nào chưa (hoặc sẽ không) có customRule vẫn dùng cửa sổ mặc
 * định này. Cutoff phải phủ cả hai, không chỉ bốn cửa sổ tự cấu hình.
 */
const BETTER_AUTH_DEFAULT_RATE_LIMIT_WINDOW_SEC = 10;
const BETTER_AUTH_DEFAULT_SPECIAL_RULE_WINDOWS_SEC = [10, 60] as const;
/**
 * Biên an toàn cho cutoff của rate_limit: rule custom/plugin (Task 33, chưa wiring xong) có thể thêm cửa
 * sổ dài hơn bốn giá trị đang đọc từ config mà cron này không tự biết cho tới lần deploy sau. Biên này
 * không phải tunable nghiệp vụ (không đổi theo môi trường) nên là hằng số, không qua `defineConfig`.
 */
const RATE_LIMIT_PURGE_SAFETY_MARGIN_SEC = 60;
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
    // Một dòng rate_limit chỉ còn tác dụng trong cửa sổ dài nhất đang có thể áp dụng: bốn cửa sổ tự
    // cấu hình, cửa sổ mặc định của Better Auth (path chưa có customRule) và biên an toàn (review M10).
    const longestWindowMs =
      (Math.max(
        this.guard.rateLimitWindowSec,
        this.guard.signinRateWindowSec,
        this.guard.twoFactorRateWindowSec,
        this.guard.emailRateWindowSec,
        BETTER_AUTH_DEFAULT_RATE_LIMIT_WINDOW_SEC,
        ...BETTER_AUTH_DEFAULT_SPECIAL_RULE_WINDOWS_SEC,
      ) +
        RATE_LIMIT_PURGE_SAFETY_MARGIN_SEC) *
      MS_PER_SECOND;
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
