import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  isBrokenCircuitError,
  isBulkheadRejectedError,
  isTaskCancelledError,
} from 'cockatiel';
import { Agent, errors, request } from 'undici';
import { type ConfigOf } from '../config/index.js';
import { ResiliencePolicies } from './policies.service.js';
import { resilienceConfig } from './resilience.config.js';
import {
  SsrfBlockedError,
  assertUrlAllowed,
  ssrfLookup,
} from './ssrf-guard.js';
import { UpstreamError } from './upstream-error.js';

/** RFC 9110 §9.2.2 (bỏ TRACE). Chỉ các method này được retry. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
/**
 * 5xx ném `bad_status` (retry được). 429 ném `rate_limited`: không retry và không tính vào breaker,
 * vì retry sau backoff dưới 1 giây chỉ làm upstream siết thêm; `retryAfter` để caller/job queue lùi lịch.
 */
const TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR = 500;

export type HttpRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
};
export type HttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

const ssrfCause = (err: unknown): SsrfBlockedError | undefined => {
  if (err instanceof SsrfBlockedError) return err;
  if (err instanceof Error && err.cause instanceof SsrfBlockedError)
    return err.cause;
  return undefined;
};

/**
 * Client HTTP ra ngoài duy nhất của hệ thống. Chống SSRF hai lớp: `assertUrlAllowed` trước khi gửi
 * (scheme, userinfo, port, IP literal) và `ssrfLookup` lúc connect (IP thực sự kết nối tới).
 * Không follow redirect (undici chỉ follow khi gắn interceptor redirect): 3xx trả nguyên cho caller.
 * Kích thước body giới hạn ở tầng transport (`maxResponseSize` của undici, huỷ socket khi vượt).
 * Không gọi bên trong transaction DB.
 */
@Injectable()
export class HttpClient implements OnApplicationShutdown {
  private readonly agent: Agent;

  constructor(
    private readonly policies: ResiliencePolicies,
    @Inject(resilienceConfig.KEY)
    private readonly cfg: ConfigOf<typeof resilienceConfig>,
  ) {
    this.agent = new Agent({
      connect: { lookup: ssrfLookup(cfg.allowCidrs) },
      maxResponseSize: cfg.maxResponseBytes,
    });
  }

  /** `provider` phải là hằng số có tên (vd `'sepay'`), không bao giờ là URL/host của tenant: xem `ResiliencePolicies.for`. */
  async request(
    provider: string,
    rawUrl: string,
    init: HttpRequestInit = {},
  ): Promise<HttpResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      // TypeError của WHATWG URL có property `input` (URL thô, có thể mang secret ở query) mà
      // errSerializer sẽ log; nên ném lỗi mới, không giữ cause.
      throw new SsrfBlockedError('URL is invalid');
    }
    assertUrlAllowed(url, this.cfg);
    const method = (init.method ?? 'GET').toUpperCase();
    const p = this.policies.for(provider);
    const policy = IDEMPOTENT_METHODS.has(method) ? p.retrying : p.single;
    try {
      return await policy.execute(({ signal }) =>
        this.attempt(provider, url, method, init, signal),
      );
    } catch (err) {
      throw this.normalize(provider, method, err);
    }
  }

  private async attempt(
    provider: string,
    url: URL,
    method: string,
    init: HttpRequestInit,
    signal: AbortSignal,
  ): Promise<HttpResult> {
    let body: Buffer;
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(url, {
        dispatcher: this.agent,
        method,
        headers: init.headers,
        body: init.body,
        signal,
      });
      // Luôn đọc hết body để trả connection về pool; undici huỷ socket nếu vượt maxResponseSize.
      body = Buffer.from(await res.body.arrayBuffer());
    } catch (err) {
      if (err instanceof errors.ResponseExceededMaxSizeError)
        throw new UpstreamError(
          provider,
          'too_large',
          `Upstream ${provider} ${method} response exceeded ${this.cfg.maxResponseBytes} bytes`,
          { cause: err },
        );
      throw err;
    }
    if (res.statusCode === TOO_MANY_REQUESTS) {
      const retryAfter = res.headers['retry-after'];
      throw new UpstreamError(
        provider,
        'rate_limited',
        `Upstream ${provider} ${method} rate limited the call`,
        {
          status: res.statusCode,
          retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
        },
      );
    }
    if (res.statusCode >= FIRST_SERVER_ERROR)
      throw new UpstreamError(
        provider,
        'bad_status',
        `Upstream ${provider} ${method} responded ${res.statusCode}`,
        { status: res.statusCode },
      );
    return { status: res.statusCode, headers: res.headers, body };
  }

  /** Message không chứa URL (query có thể mang secret) và không chứa body upstream. */
  private normalize(provider: string, method: string, err: unknown): Error {
    if (err instanceof UpstreamError) return err;
    const blocked = ssrfCause(err);
    if (blocked) return blocked;
    if (isBrokenCircuitError(err))
      return new UpstreamError(
        provider,
        'circuit_open',
        `Upstream ${provider} circuit is open`,
        { cause: err },
      );
    if (isBulkheadRejectedError(err))
      return new UpstreamError(
        provider,
        'bulkhead_full',
        `Upstream ${provider} bulkhead is full`,
        { cause: err },
      );
    if (isTaskCancelledError(err))
      return new UpstreamError(
        provider,
        'timeout',
        `Upstream ${provider} ${method} timed out`,
        { cause: err },
      );
    return new UpstreamError(
      provider,
      'network',
      `Upstream ${provider} ${method} call failed`,
      { cause: err },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.agent.close();
  }
}
