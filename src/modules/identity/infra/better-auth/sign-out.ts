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
const SECURE_PREFIX = '__Secure-';
const SECURE_ATTRIBUTE = /;\s*Secure(?=;|$)/i;
/** Trình duyệt từ chối cookie `SameSite=None` hoặc `Partitioned` (CHIPS) thiếu `Secure`, kể cả cookie hết hạn. */
const REQUIRES_SECURE = /;\s*(?:SameSite=None|Partitioned)(?=;|$)/i;

/**
 * Cùng cookie hết hạn nhưng dưới biến thể tên còn lại (`<prefix>.x` ⇄ `__Secure-<prefix>.x`). Better Auth chỉ hết hạn
 * tên ĐANG cấu hình; client có thể giữ biến thể kia (vd. sau khi đổi `AUTH_SECURE_COOKIES`, review I2). `__Secure-`
 * bắt buộc thuộc tính `Secure`; tên thường thì bỏ nó để trình duyệt nhận được cả qua HTTP, trừ khi cookie mang
 * `SameSite=None` (cấu hình `AUTH_COOKIE_SAMESITE`) hoặc `Partitioned`: khi đó thiếu `Secure` thì trình duyệt bỏ
 * luôn cookie hết hạn và biến thể cũ không bao giờ bị xoá (Task 36 N2).
 */
export function otherCookieVariant(setCookie: string): string {
  if (setCookie.startsWith(SECURE_PREFIX)) {
    const plain = setCookie.slice(SECURE_PREFIX.length);
    return REQUIRES_SECURE.test(plain)
      ? plain
      : plain.replace(SECURE_ATTRIBUTE, '');
  }
  return `${SECURE_PREFIX}${setCookie}${SECURE_ATTRIBUTE.test(setCookie) ? '' : '; Secure'}`;
}

type Revocation = { headers: Headers; cookieSentAs?: string };

/**
 * `POST {basePath}/sign-out` do mình xử lý (spec §5.6.4): plugin bearer ghi đè cookie bằng bearer (A.14) nên
 * handler gốc chỉ xoá một session, và nó nuốt lỗi xoá DB (A.15). Thu hồi TỪNG credential session với bộ header chỉ
 * chứa credential đó rồi kiểm lại bằng `getSession`. Bất kỳ lỗi nào (ném, hoặc còn session sống) → 503; không bao
 * giờ rơi về handler gốc. `Set-Cookie` lấy bằng `returnHeaders: true` (S1f): Better Auth hết hạn cookie bằng đúng
 * thuộc tính đã phát (`Path`, `Domain`).
 *
 * Review I2 (S2-R50): Better Auth chỉ đọc cookie dưới tên ĐANG cấu hình. Cookie session được nhận diện dưới biến
 * thể tên kia (`__Secure-` hay không) nên được gửi lại dưới tên cấu hình: nếu không, `signOut` không xoá gì,
 * `getSession` trả `null` và "kiểm lại" thành vô nghĩa (fail-open).
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
    const base = () => new Headers(ctx.origin ? { origin: ctx.origin } : {});
    const revocations: Revocation[] = [];
    const sessionCookie = (await this.auth.$context).authCookies.sessionToken
      .name;
    for (const c of credentials) {
      switch (c.kind) {
        case 'SESSION_COOKIE': {
          const headers = base();
          headers.set('cookie', `${sessionCookie}=${c.value}`);
          revocations.push({ headers, cookieSentAs: c.cookieName });
          break;
        }
        case 'BEARER_SESSION': {
          const headers = base();
          headers.set('authorization', `Bearer ${c.value}`);
          revocations.push({ headers });
          break;
        }
        // Final review M1: mount từ chối MỌI API key ở bước 1 (`400 api_key_not_accepted`, trước CSRF và body), nên
        // không tới được đây. Kind của `external`: không bao giờ được phát hiện khi Better Auth được mount.
        case 'API_KEY':
        case 'EXTERNAL_COOKIE':
        case 'EXTERNAL_BEARER':
          throw new Error(
            `credential kind ${c.kind} cannot reach the Better Auth sign-out`,
          );
        default: {
          const unknown: never = c.kind;
          throw new Error(`unknown credential kind ${String(unknown)}`);
        }
      }
    }
    // Không credential nào: đăng xuất idempotent, vẫn trả cookie hết hạn (xoá cookie phụ còn sót ở client).
    if (revocations.length === 0) revocations.push({ headers: base() });
    const setCookies: string[] = [];
    try {
      for (const r of revocations) {
        const out = await this.auth.api.signOut({
          headers: r.headers,
          returnHeaders: true,
        });
        if (!r.headers.has('authorization')) {
          const expired = out.headers.getSetCookie();
          setCookies.push(...expired);
          if (r.cookieSentAs !== undefined && r.cookieSentAs !== sessionCookie)
            setCookies.push(...expired.map(otherCookieVariant));
        }
        if (await this.auth.api.getSession({ headers: r.headers }))
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
