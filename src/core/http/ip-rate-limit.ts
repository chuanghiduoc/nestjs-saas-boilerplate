import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { AppError, CoreErrors, type ProblemMeta } from '../errors/index.js';
import { writeProblem } from './problem-writer.js';
import { wholeSeconds } from './rate-limiter.storage.js';

const MS_PER_SEC = 1000;
const logger = new Logger('IpRateLimit');

export type IpRateLimitOptions = { limit: number; windowMs: number };

/**
 * Middleware Express giới hạn theo `req.ip` cho một server Express riêng ngoài Nest (dashboard Bull Board), nơi
 * không có `AppThrottlerGuard`. Đặt ở core/http vì rate-limiter-flexible chỉ được dùng ở đây (luật kiến trúc
 * `rate-limiter-only-in-core-http-or-identity-better-auth`).
 * Bộ đếm trong bộ nhớ của process: chỉ dùng cho server chạy đúng một process (dashboard bật trên một deployment).
 * Vượt giới hạn → `429 rate_limited` + `Retry-After`, cùng problem với throttler của app.
 * Khoá là `req.ip` nguyên dạng, không qua `clientIpTracker`: CodeQL `js/missing-rate-limiting` chỉ nhận middleware
 * truyền thẳng một thuộc tính của request vào `consume` của rate-limiter-flexible. Server riêng này không đặt trust
 * proxy, nên `req.ip` là địa chỉ peer của socket.
 */
export function ipRateLimit(
  opts: IpRateLimitOptions,
  problemMeta: (req: Request) => ProblemMeta,
): (req: Request, res: Response, next: NextFunction) => void {
  const limiter = new RateLimiterMemory({
    points: opts.limit,
    duration: wholeSeconds(opts.windowMs, 'window'),
  });
  /** `RateLimiterMemory` chỉ reject bằng `RateLimiterRes`; mọi giá trị khác là lỗi không lường trước: log và 500. */
  const reject = (req: Request, res: Response, rejection: unknown): void => {
    const meta = problemMeta(req);
    if (!(rejection instanceof RateLimiterRes)) {
      logger.error(
        { err: rejection, requestId: meta.requestId },
        'ip rate limiter failed',
      );
      return writeProblem(res, new AppError(CoreErrors.INTERNAL_ERROR), meta);
    }
    writeProblem(
      res,
      new AppError(CoreErrors.RATE_LIMITED, {
        headers: {
          'Retry-After': String(
            Math.max(1, Math.ceil(rejection.msBeforeNext / MS_PER_SEC)),
          ),
        },
        expected: true,
      }),
      meta,
    );
  };
  return (req, res, next) => {
    const ip = req.ip;
    // Chỉ xảy ra khi socket đã đóng; như `clientIpTracker`, không đoán một khoá thay thế.
    if (ip === undefined)
      return reject(
        req,
        res,
        new Error('Cannot determine client IP for rate limiting'),
      );
    limiter.consume(ip).then(
      () => next(),
      (rejection: unknown) => reject(req, res, rejection),
    );
  };
}
