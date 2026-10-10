import { Inject, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ConfigOf } from '../../../core/config/index.js';
import {
  SsrfBlockedError,
  assertUrlAllowed,
  isPublicAddress,
  parseCidrs,
  resilienceConfig,
} from '../../../core/resilience/index.js';
import { WEBHOOK_URL_MAX_LENGTH } from '../constants.js';
import { UrlGuard, type UrlCheck } from '../ports/url-guard.js';

export type HostResolver = (
  host: string,
) => Promise<readonly { address: string; family: number }[]>;
/** Token của resolver: production dùng DNS hệ thống; test thay bằng resolver giả (W-21, W-22). */
export const HOST_RESOLVER = Symbol('HOST_RESOLVER');
export const dnsResolver: HostResolver = (host) => lookup(host, { all: true });

/** Lỗi DNS của Node (`ENOTFOUND`, `EAI_AGAIN`…) mang `code` chuỗi; lỗi khác là bug, ném tiếp. */
const isDnsError = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && typeof err.code === 'string';

/**
 * Cùng chính sách với `HttpClient` (spec SP6 §8.3 bước 1): `assertUrlAllowed` (scheme, userinfo, port, IP literal), cấm
 * fragment, URL chuẩn hoá còn vừa cột `url`, rồi MỌI địa chỉ phân giải được phải công khai hoặc thuộc
 * `RESILIENCE_SSRF_ALLOW_CIDRS` (Review Focus 2: kiểm "địa chỉ đầu" sẽ lọt).
 */
@Injectable()
export class DnsUrlGuard extends UrlGuard {
  constructor(
    @Inject(resilienceConfig.KEY)
    private readonly cfg: ConfigOf<typeof resilienceConfig>,
    @Inject(HOST_RESOLVER) private readonly resolve: HostResolver,
  ) {
    super();
  }

  async check(raw: string): Promise<UrlCheck> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'INVALID' };
    }
    if (raw.includes('#') || url.href.length > WEBHOOK_URL_MAX_LENGTH)
      return { ok: false, reason: 'INVALID' };
    try {
      assertUrlAllowed(url, this.cfg);
    } catch (err) {
      if (err instanceof SsrfBlockedError)
        return { ok: false, reason: 'NOT_ALLOWED' };
      throw err;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // IP literal đã được `assertUrlAllowed` kiểm (net.connect không gọi lookup cho IP literal).
    if (isIP(host) !== 0) return { ok: true, url: url.href };
    let addresses: readonly { address: string }[];
    try {
      addresses = await this.resolve(host);
    } catch (err) {
      if (isDnsError(err)) return { ok: false, reason: 'UNRESOLVABLE' };
      throw err;
    }
    const allow = parseCidrs(this.cfg.allowCidrs);
    if (
      addresses.length === 0 ||
      addresses.some((a) => !isPublicAddress(a.address, allow))
    )
      return { ok: false, reason: 'NOT_ALLOWED' };
    return { ok: true, url: url.href };
  }
}
