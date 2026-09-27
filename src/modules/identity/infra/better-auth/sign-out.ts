import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { ProblemMeta } from '../../../../core/errors/index.js';
import { writeProblem } from '../../../../core/http/index.js';
import type { DetectedCredential } from '../../http/credential-detector.js';
import { IdentityMetrics } from '../../identity-metrics.js';
import { safeErrorFields } from '../../identity-telemetry.js';
import { authUnavailable } from './auth-error.mapper.js';
import { BETTER_AUTH, type AuthInstance } from './auth-instance.js';

const OK = 200;

/**
 * `POST {basePath}/sign-out` do mình xử lý (spec §5.6.4): plugin bearer ghi đè cookie bằng bearer (A.14) nên
 * handler gốc chỉ xoá một session, và nó nuốt lỗi xoá DB (A.15). Thu hồi TỪNG credential với bộ header chỉ chứa
 * credential đó rồi kiểm lại. Bất kỳ lỗi nào (ném, hoặc còn session sống) → 503; không bao giờ rơi về handler gốc.
 * `Set-Cookie` lấy bằng `returnHeaders: true` (S1f): Better Auth hết hạn cookie bằng đúng thuộc tính đã phát
 * (`Path`, `Domain`), nên không tự dựng cookie hết hạn.
 */
@Injectable()
export class SignOutHandler {
  private readonly logger = new Logger(SignOutHandler.name);
  constructor(
    @Inject(BETTER_AUTH) private readonly auth: AuthInstance,
    private readonly metrics: IdentityMetrics,
  ) {}

  async handle(
    res: ServerResponse,
    credentials: DetectedCredential[],
    ctx: { origin?: string; meta: ProblemMeta; retryAfterSec: number },
  ): Promise<void> {
    const setCookies: string[] = [];
    try {
      for (const c of credentials) {
        const headers = new Headers(ctx.origin ? { origin: ctx.origin } : {});
        if (c.kind === 'SESSION_COOKIE' && c.cookieName)
          headers.set('cookie', `${c.cookieName}=${c.value}`);
        else if (c.kind === 'BEARER_SESSION')
          headers.set('authorization', `Bearer ${c.value}`);
        else continue;
        const out = await this.auth.api.signOut({
          headers,
          returnHeaders: true,
        });
        if (c.kind === 'SESSION_COOKIE')
          setCookies.push(...out.headers.getSetCookie());
        if (await this.auth.api.getSession({ headers }))
          throw new Error('session still alive after sign-out');
      }
    } catch (err) {
      this.logger.error(
        { event: 'sign_out_failed', ...safeErrorFields(err) },
        'sign-out could not revoke every session',
      );
      this.metrics.unavailable.add(1);
      writeProblem(res, authUnavailable(ctx.retryAfterSec), ctx.meta);
      return;
    }
    res.statusCode = OK;
    for (const sc of setCookies) res.appendHeader('Set-Cookie', sc);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
  }
}
