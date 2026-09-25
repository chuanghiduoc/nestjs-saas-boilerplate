import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import {
  Idempotency,
  IdempotencyError,
  IdempotencyErrorCodes,
  type IdempotencyParams,
  type IdempotencyResponse,
} from '@node-idempotency/core';
import type { Redis } from 'ioredis';
import {
  type Observable,
  catchError,
  from,
  mergeMap,
  of,
  throwError,
} from 'rxjs';
import { z } from 'zod';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/index.js';
import {
  AppError,
  CoreErrors,
  findErrorCode,
  toAppError,
} from '../errors/index.js';
import { REDIS, REDIS_NAMESPACE } from '../redis/index.js';
import { idempotencyConfig } from './idempotency.config.js';
import { RedisIdempotencyStorage } from './idempotency.storage.js';

export const IDEMPOTENT_META = 'core:idempotent';
export type IdempotentOptions = { ttlSec?: number };

const HEADER = 'idempotency-key';
const KEY_CHARSET = /^[A-Za-z0-9_\-:.]+$/;
/** Key đưa cho thư viện là sha256 hex của scope + key gốc. */
const SCOPED_KEY_LENGTH = 64;
const MS_PER_SEC = 1000;
const INTERNAL_ERROR_STATUS = 500;

/** Bản ghi đã lưu (shape `IdempotencyResponse` của thư viện), validate lại khi đọc từ Redis. */
const StoredHeaders = z.record(z.string(), z.string());
const StoredError = z.object({
  code: z.string(),
  detail: z.string().optional(),
  headers: StoredHeaders.optional(),
  fields: z
    .array(
      z.object({ path: z.string(), code: z.string(), message: z.string() }),
    )
    .optional(),
});
const StoredOk = z.object({ headers: StoredHeaders });
const Stored = z.union([
  z.object({ error: StoredError }),
  z.object({ body: z.unknown(), additional: StoredOk }),
]);
type StoredHeaders = z.infer<typeof StoredHeaders>;
type StoredError = z.infer<typeof StoredError>;

type HttpReq = {
  method: string;
  body: unknown;
  params: unknown;
  query: unknown;
  headers: Record<string, string | string[] | undefined>;
};
type HttpRes = {
  getHeader(name: string): number | string | string[] | undefined;
};

/**
 * Idempotency-Key theo IETF draft-ietf-httpapi-idempotency-key-header-07 trên @node-idempotency/core.
 * Lớp nối chỉ làm: bắt buộc principal (scope), validate key, map lỗi thư viện sang problem+json,
 * lưu lỗi dưới dạng mã lỗi và lưu header trong allowlist. Khoá nguyên tử, fingerprint body, lưu và
 * trả lại response là việc của thư viện.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private readonly engine: Idempotency;

  constructor(
    private readonly reflector: Reflector,
    private readonly adapterHost: HttpAdapterHost,
    private readonly ctx: RequestContext,
    @Inject(REDIS) redis: Redis,
    @Inject(REDIS_NAMESPACE) namespace: string,
    @Inject(idempotencyConfig.KEY)
    private readonly cfg: ConfigOf<typeof idempotencyConfig>,
  ) {
    const storage = new RedisIdempotencyStorage(
      redis,
      cfg.lockTtlSec * MS_PER_SEC,
    );
    this.engine = new Idempotency(storage, {
      idempotencyKey: HEADER,
      // Key trong Redis: `<namespace>-idem:<METHOD>:<route template>:<sha256(scope, key)>`.
      cacheKeyPrefix: `${namespace}-idem`,
      keyMaxLength: SCOPED_KEY_LENGTH,
      cacheTTLMS: cfg.ttlSec * MS_PER_SEC,
      enforceIdempotency: true,
      // Draft-07: request trùng đang chạy → 409 ngay, không chờ.
      inProgressStrategy: { wait: false },
    });
  }

  private routeTemplate(context: ExecutionContext): string {
    const parts = [context.getClass(), context.getHandler()].flatMap(
      (target) =>
        this.reflector.get<string | string[] | undefined>(
          PATH_METADATA,
          target,
        ) ?? [],
    );
    // `@Post()` có path `/`: gộp dấu `/` liên tiếp và bỏ `/` cuối (trừ route gốc).
    return `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  }

  /**
   * Scope chỉ lấy từ principal đã xác thực trong RequestContext; không có fallback theo header.
   * Kiểm tra principal (401) trước key (400).
   */
  private scopedKey(req: HttpReq): string {
    const p = this.ctx.principal();
    if (!p)
      throw new AppError(CoreErrors.UNAUTHENTICATED, {
        detail: 'Idempotent endpoints require an authenticated caller.',
      });
    const rawKey = this.rawKey(req);
    return createHash('sha256')
      .update(JSON.stringify([p.type, p.id, this.ctx.orgId() ?? null, rawKey]))
      .digest('hex');
  }

  private rawKey(req: HttpReq): string {
    const k = req.headers[HEADER];
    const { keyMinLength: min, keyMaxLength: max } = this.cfg;
    if (
      typeof k !== 'string' ||
      k.length < min ||
      k.length > max ||
      !KEY_CHARSET.test(k)
    )
      throw new AppError(CoreErrors.IDEMPOTENCY_KEY_REQUIRED, {
        detail: `Send an Idempotency-Key header of ${min}-${max} characters from [A-Za-z0-9_-:.] (a UUID is recommended).`,
      });
    return k;
  }

  private mapLibraryError(err: unknown): AppError {
    if (!(err instanceof IdempotencyError))
      return new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        detail:
          'Idempotency store is unavailable. Retry later with the same key.',
        cause: err,
      });
    switch (err.code) {
      case IdempotencyErrorCodes.REQUEST_IN_PROGRESS:
        return new AppError(CoreErrors.IDEMPOTENCY_CONFLICT, {
          detail:
            'The original request is still in progress. Retry later with the same key.',
          cause: err,
        });
      case IdempotencyErrorCodes.IDEMPOTENCY_FINGERPRINT_MISSMATCH:
        return new AppError(CoreErrors.IDEMPOTENCY_KEY_REUSED, {
          detail:
            'This Idempotency-Key was used with a different request. Use a new key.',
          cause: err,
        });
      // Không xảy ra (key đã được validate và thay bằng sha256), vẫn map đúng nghĩa.
      case IdempotencyErrorCodes.IDEMPOTENCY_KEY_MISSING:
      case IdempotencyErrorCodes.IDEMPOTENCY_KEY_LEN_EXEEDED:
        return new AppError(CoreErrors.IDEMPOTENCY_KEY_REQUIRED, {
          cause: err,
        });
      default: {
        const unhandled: never = err.code;
        throw new Error(
          `Unhandled idempotency error code "${String(unhandled)}"`,
          {
            cause: err,
          },
        );
      }
    }
  }

  private replay(hit: IdempotencyResponse, res: unknown): Observable<unknown> {
    const parsed = Stored.safeParse(hit);
    if (!parsed.success)
      return throwError(
        () => new Error('Stored idempotent response has an unexpected shape'),
      );
    const stored = parsed.data;
    if ('error' in stored) {
      const code = findErrorCode(stored.error.code);
      if (!code)
        return throwError(
          () =>
            new Error(
              `Stored idempotent error has unknown code "${stored.error.code}"`,
            ),
        );
      return throwError(
        () =>
          new AppError(code, {
            detail: stored.error.detail,
            fields: stored.error.fields,
            headers: stored.error.headers,
          }),
      );
    }
    for (const [k, v] of Object.entries(stored.additional.headers))
      this.adapterHost.httpAdapter.setHeader(res, k, v);
    return of(stored.body);
  }

  private allowlistedHeaders(res: HttpRes): StoredHeaders {
    const headers: StoredHeaders = {};
    for (const h of this.cfg.replayHeaders) {
      const v = res.getHeader(h);
      if (v !== undefined)
        headers[h] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return headers;
  }

  /** Header của AppError (vd. Retry-After) cũng chỉ lưu nếu nằm trong allowlist. */
  private allowlistedErrorHeaders(
    headers: Record<string, string> | undefined,
  ): StoredHeaders {
    return Object.fromEntries(
      Object.entries(headers ?? {}).filter(([k]) =>
        this.cfg.replayHeaders.includes(k.toLowerCase()),
      ),
    );
  }

  /** Lưu dưới dạng mã lỗi; filter dựng lại problem+json (requestId mới). Detail theo đúng luật lộ detail của filter. */
  private storedError(err: unknown): StoredError {
    const e = toAppError(err);
    const exposeDetail =
      e.error.status < INTERNAL_ERROR_STATUS || err instanceof AppError;
    const headers = this.allowlistedErrorHeaders(e.opts.headers);
    return {
      code: e.error.code,
      ...(exposeDetail && e.opts.detail ? { detail: e.opts.detail } : {}),
      ...(e.opts.fields?.length ? { fields: e.opts.fields } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts =
      this.reflector.get<IdempotentOptions | undefined>(
        IDEMPOTENT_META,
        context.getHandler(),
      ) ?? {};
    const http = context.switchToHttp();
    const req = http.getRequest<HttpReq>();
    const res = http.getResponse<HttpRes>();
    const route = this.routeTemplate(context);
    let scopedKey: string;
    try {
      scopedKey = this.scopedKey(req);
    } catch (err) {
      return throwError(() => err);
    }
    const libReq: IdempotencyParams = {
      headers: { [HEADER]: scopedKey },
      // Fingerprint = body + đích cụ thể (params, query): route template nằm trong key của thư viện,
      // nên cùng key trên `/:id` khác phải là "request khác" (422), không được replay response cũ.
      // Bọc body để fingerprint nhận mọi JSON (mảng, giá trị đơn, không có body).
      body: { payload: req.body, params: req.params, query: req.query },
      method: req.method,
      path: route,
      options: { cacheTTLMS: (opts.ttlSec ?? this.cfg.ttlSec) * MS_PER_SEC },
    };

    const save = async (response: IdempotencyResponse): Promise<void> => {
      try {
        await this.engine.onResponse(libReq, response);
      } catch (err) {
        // Handler đã chạy xong: ném lỗi ở đây khiến client retry và có thể chạy lại side effect.
        // Key vẫn ở trạng thái "đang chạy" tới hết TTL → retry cùng key nhận 409.
        this.logger.error(
          { err, route },
          'failed to store idempotent response; the key stays in progress until its ttl expires',
        );
      }
    };

    return from(this.engine.onRequest(libReq)).pipe(
      catchError((err: unknown) => throwError(() => this.mapLibraryError(err))),
      mergeMap((hit) => {
        if (hit) return this.replay(hit, res);
        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            await save({
              body,
              additional: { headers: this.allowlistedHeaders(res) },
            });
            return body;
          }),
          catchError((err: unknown) =>
            from(save({ error: this.storedError(err) })).pipe(
              mergeMap(() => throwError(() => err)),
            ),
          ),
        );
      }),
    );
  }
}
