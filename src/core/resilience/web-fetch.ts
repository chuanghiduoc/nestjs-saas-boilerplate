import type { HttpClient } from './http-client.js';
import { SsrfBlockedError } from './ssrf-guard.js';

export type WebFetchInit = {
  method?: string;
  headers?: Headers;
  redirect?: 'manual' | 'follow' | 'error';
  signal?: AbortSignal;
};
export type WebFetch = (url: string, init?: WebFetchInit) => Promise<Response>;

/** Status không được có body theo Fetch (`new Response(body, …)` ném lỗi nếu có). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Hàm có chữ ký `fetch` cho thư viện nhận fetch tuỳ biến (vd. `customFetch` của `jose`), đi qua
 * `HttpClient` (chống SSRF, breaker, bulkhead, giới hạn body). Không bao giờ follow redirect.
 */
export function toWebFetch(client: HttpClient, provider: string): WebFetch {
  return async (url, init = {}) => {
    if (init.redirect !== undefined && init.redirect !== 'manual')
      throw new SsrfBlockedError(
        `redirect mode "${init.redirect}" is not allowed; outbound calls never follow redirects`,
      );
    const headers: Record<string, string> = {};
    init.headers?.forEach((value, key) => {
      headers[key] = value;
    });
    const res = await client.request(provider, url, {
      method: init.method ?? 'GET',
      headers,
      signal: init.signal,
    });
    const out = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value])
        out.append(key, one);
    }
    // Buffer có thể nằm trên SharedArrayBuffer nên không phải BodyInit; chép sang Uint8Array<ArrayBuffer>
    // (kích thước đã bị chặn bởi maxResponseBytes).
    const body = NULL_BODY_STATUSES.has(res.status)
      ? null
      : new Uint8Array(res.body);
    return new Response(body, {
      status: res.status,
      headers: out,
    });
  };
}
