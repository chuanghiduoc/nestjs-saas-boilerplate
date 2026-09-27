import {
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { RequestContext } from '../../../../core/context/index.js';
import {
  AppError,
  CoreErrors,
  PROBLEM_JSON,
  errorsConfig,
  type ProblemMeta,
} from '../../../../core/errors/index.js';
import {
  httpConfig,
  jsonBodyParser,
  writeProblem,
  type NodeMiddleware,
} from '../../../../core/http/index.js';
import { IdentityErrors } from '../../errors.js';
import {
  detectCredentials,
  detectionConfigOf,
  type DetectionConfig,
} from '../../http/credential-detector.js';
import {
  SAFE_METHODS,
  csrfAllows,
  trustedOriginList,
} from '../../http/origin-check.js';
import { toWebHeaders } from '../../http/web-headers.js';
import { IdentityMetrics } from '../../identity-metrics.js';
import { safeErrorFields } from '../../identity-telemetry.js';
import {
  identityConfig,
  identityGuardConfig,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../../identity.config.js';
import { authUnavailable, mapAuthError } from './auth-error.mapper.js';
import { BETTER_AUTH, type AuthInstance } from './auth-instance.js';
import { CLIENT_IP_HEADER } from './auth-options.js';
import { AuthDatabaseReadiness } from './auth-readiness.js';
import { SignOutHandler } from './sign-out.js';

type MountRequest = IncomingMessage & { ip?: string; originalUrl?: string };
const FIRST_ERROR_STATUS = 400;
const FIRST_SERVER_ERROR = 500;
const SERVICE_UNAVAILABLE = 503;
const SIGN_IN_PATH = '/sign-in/email';
const SIGN_OUT_PATH = '/sign-out';
const POST = 'POST';
/**
 * Header khung truyền của request gốc: body được dựng lại từ đúng byte đã đọc (`rawBody`), nên độ dài/cách
 * chunk cũ không còn nghĩa với `Request` mới.
 */
const FRAMING_HEADERS = ['content-length', 'transfer-encoding'] as const;
const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};
const codeOf = (text: string): string | undefined => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' &&
      v !== null &&
      'code' in v &&
      typeof v.code === 'string'
      ? v.code
      : undefined;
  } catch {
    return undefined;
  }
};
/** Bản sao trên `ArrayBuffer` riêng: `Buffer` có thể nằm trên pool dùng chung, `BodyInit` không nhận kiểu đó. */
const rawBodyOf = (
  req: IncomingMessage,
): Uint8Array<ArrayBuffer> | undefined =>
  'rawBody' in req && Buffer.isBuffer(req.rawBody)
    ? new Uint8Array(req.rawBody)
    : undefined;

/**
 * Path endpoint của Better Auth (carry-forward 3): pathname đã được WHATWG URL giải `.`/`..` (kể cả `%2e`), bỏ
 * `basePath`. Chỉ nhận dạng chính tắc mà router của better-call cũng route: đúng hoa thường của `basePath`, không
 * `//`, không `/` ở cuối. Còn lại trả `undefined` (mount trả 404): vì vậy không có biến thể path nào (vd.
 * `/sign-out/`) lọt qua phép so khớp đăng xuất của mình mà vẫn tới handler gốc, và mapper luôn nhận path chuẩn.
 */
export function endpointPathOf(
  pathname: string,
  basePath: string,
): string | undefined {
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  const path = pathname.slice(basePath.length);
  if (path.length <= 1 || path.includes('//') || path.endsWith('/'))
    return undefined;
  return path;
}

/**
 * Mount `/api/auth/*` (spec §5.5, 6 bước). Không bao giờ gọi `next()`: request auth kết thúc ở đây, nên không
 * có handler gốc nào chạy sau khi mình đã quyết định (vd. đăng xuất lỗi). `use` bắt mọi lỗi của promise.
 * Không mở scope request state: Better Auth tự mở cho mỗi lời gọi (`AuthRequestState`, carry-forward 2).
 *
 * Client huỷ giữa chừng: lúc đọc body, `raw-body` tự gỡ listener và trả lỗi (`request.aborted`) → problem ghi vào
 * socket đã đóng (Node bỏ qua). Lúc chờ handler: `Response` vẫn được đọc hết rồi ghi vào socket đã đóng, nên không
 * còn body stream nào treo. Mount không mở timer/listener nào của riêng nó.
 */
@Injectable()
export class AuthMountMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMountMiddleware.name);
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;
  private readonly parse: NodeMiddleware;
  private readonly baseOrigin: string;

  constructor(
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: IdentityGuardConfig,
    @Inject(appConfig.KEY) app: ConfigOf<typeof appConfig>,
    @Inject(httpConfig.KEY) http: ConfigOf<typeof httpConfig>,
    @Inject(errorsConfig.KEY)
    private readonly errors: ConfigOf<typeof errorsConfig>,
    @Inject(BETTER_AUTH) private readonly auth: AuthInstance,
    private readonly storage: AuthDatabaseReadiness,
    private readonly ctx: RequestContext,
    private readonly signOut: SignOutHandler,
    private readonly metrics: IdentityMetrics,
  ) {
    if (!identity.baseUrl)
      throw new Error('AUTH_BASE_URL is required to mount Better Auth');
    this.detection = detectionConfigOf(identity, app);
    this.trusted = new Set(
      trustedOriginList(http.corsOrigins, identity.baseUrl),
    );
    this.parse = jsonBodyParser(http);
    this.baseOrigin = new URL(identity.baseUrl).origin;
  }

  use(req: MountRequest, res: ServerResponse): void {
    this.handle(req, res).catch((err: unknown) => {
      try {
        this.logger.error(
          { event: 'auth_mount_failed', ...safeErrorFields(err) },
          'auth mount failed',
        );
        writeProblem(
          res,
          new AppError(CoreErrors.INTERNAL_ERROR),
          this.meta(req),
        );
      } catch {
        // Không còn gì ghi được (vd. header không hợp lệ): đóng socket thay vì để promise reject không ai bắt.
        res.destroy();
      }
    });
  }

  private meta(req: MountRequest): ProblemMeta {
    return {
      instance: (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '',
      requestId: this.ctx.requestId(),
      typeBase: this.errors.problemTypeBase,
    };
  }

  private async handle(req: MountRequest, res: ServerResponse): Promise<void> {
    const meta = this.meta(req);
    const method = (req.method ?? 'GET').toUpperCase();
    // Cùng cách better-call tách path (`new URL(request.url).pathname`); chỉ lấy path + query của request, không
    // bao giờ lấy host của một request absolute-form.
    const url = new URL(req.originalUrl ?? req.url ?? '/', this.baseOrigin);
    const path = endpointPathOf(url.pathname, this.identity.basePath);
    const isSignOut = method === POST && path === SIGN_OUT_PATH;
    // Bước 1: đa credential và dữ liệu trùng, trên header thô, mọi method.
    const d = detectCredentials(req.rawHeaders, this.detection, {
      allowCookieWithBearer: isSignOut,
    });
    if (!d.ok) {
      this.metrics.ambiguous.add(1);
      return writeProblem(
        res,
        new AppError(IdentityErrors.AMBIGUOUS_CREDENTIALS),
        meta,
      );
    }
    // Bước 2: CSRF của mình khi request thật sự mang cookie auth.
    if (
      !SAFE_METHODS.has(method) &&
      d.hasAuthCookie &&
      !csrfAllows(
        {
          method,
          origin: header(req, 'origin'),
          secFetchSite: header(req, 'sec-fetch-site'),
        },
        this.trusted,
      )
    ) {
      this.metrics.csrfRejected.add(1);
      return writeProblem(
        res,
        new AppError(IdentityErrors.ORIGIN_NOT_ALLOWED),
        meta,
      );
    }
    // Bước 3: body giới hạn theo stream (413/415/400 do parser quyết định).
    const parseError = await new Promise<unknown>((resolve) =>
      this.parse(req, res, resolve),
    );
    if (parseError !== undefined) return writeProblem(res, parseError, meta);
    // Bước 4: IP client do Express tính theo HTTP_TRUST_PROXY. Không xác định được thì từ chối: không bao giờ để
    // Better Auth rơi về một bucket rate limit dùng chung (`no-trusted-ip`) hay nhận IP client tự khai.
    const ip = req.ip;
    if (ip === undefined || isIP(ip) === 0) {
      this.logger.warn(
        { event: 'client_ip_unresolved' },
        'client address could not be resolved to an IP; request refused',
      );
      return writeProblem(
        res,
        new AppError(CoreErrors.MALFORMED_REQUEST, {
          detail: 'Client address could not be determined',
        }),
        meta,
      );
    }
    if (path === undefined)
      return writeProblem(res, new AppError(CoreErrors.NOT_FOUND), meta);
    // Bước 5: đăng xuất của mình, không bao giờ chuyển cho handler gốc.
    if (isSignOut)
      return this.signOut.handle(res, d.credentials, {
        origin: header(req, 'origin'),
        meta,
        retryAfterSec: this.guard.unavailableRetryAfterSec,
      });
    // Bước 6.
    const headers = toWebHeaders(req);
    for (const name of FRAMING_HEADERS) headers.delete(name);
    // `set` thay mọi bản client gửi: bucket rate limit chỉ theo IP mình đã xác định.
    headers.set(CLIENT_IP_HEADER, ip);
    const request = new Request(
      `${this.baseOrigin}${url.pathname}${url.search}`,
      {
        method,
        headers,
        body: rawBodyOf(req),
      },
    );
    await this.forward(request, res, meta, path, method);
  }

  private async forward(
    request: Request,
    res: ServerResponse,
    meta: ProblemMeta,
    path: string,
    method: string,
  ): Promise<void> {
    const signIn = method === POST && path === SIGN_IN_PATH;
    let response: Response;
    try {
      response = await this.auth.handler(request);
    } catch (err) {
      // Lỗi ở `onRequest` (storage rate limit, checkSchema…) nằm ngoài try/catch của router: fail-closed 503.
      this.logger.error(
        { event: 'auth_handler_rejected', ...safeErrorFields(err) },
        'better auth handler rejected; answering 503',
      );
      return this.unavailable(res, meta, signIn, []);
    }
    if (
      response.status < FIRST_ERROR_STATUS ||
      (response.headers.get('content-type') ?? '').includes(PROBLEM_JSON)
    )
      return this.copy(res, response, signIn);
    // Carry-forward 7: giữ từng `Set-Cookie` (gia hạn session, xoá cookie) trên response bị viết lại.
    const setCookies = response.headers.getSetCookie();
    const code = codeOf(await response.text());
    if (response.status >= FIRST_SERVER_ERROR) {
      const storageUp = await this.storage.probe().then(
        () => true,
        () => false,
      );
      this.logger.error(
        {
          event: 'auth_endpoint_error',
          status: response.status,
          code,
          storageUp,
        },
        'better auth endpoint failed',
      );
      if (!storageUp) return this.unavailable(res, meta, signIn, setCookies);
    }
    const err =
      response.status >= FIRST_SERVER_ERROR
        ? new AppError(CoreErrors.INTERNAL_ERROR)
        : mapAuthError(
            {
              status: response.status,
              code,
              retryAfter: response.headers.get('X-Retry-After'),
              path,
            },
            { unavailableRetryAfterSec: this.guard.unavailableRetryAfterSec },
          );
    if (signIn) this.metrics.recordSignIn(err.error.status);
    for (const c of setCookies) res.appendHeader('Set-Cookie', c);
    writeProblem(res, err, meta);
  }

  private unavailable(
    res: ServerResponse,
    meta: ProblemMeta,
    signIn: boolean,
    setCookies: string[],
  ): void {
    this.metrics.unavailable.add(1);
    if (signIn) this.metrics.recordSignIn(SERVICE_UNAVAILABLE);
    for (const c of setCookies) res.appendHeader('Set-Cookie', c);
    writeProblem(
      res,
      authUnavailable(this.guard.unavailableRetryAfterSec),
      meta,
    );
  }

  /** 2xx/3xx và problem+json do hook của mình tạo: giữ nguyên status, `Location`, mọi `Set-Cookie`, body. */
  private async copy(
    res: ServerResponse,
    response: Response,
    signIn: boolean,
  ): Promise<void> {
    if (signIn) this.metrics.recordSignIn(response.status);
    // 503 do hook tự tạo (lockout storage lỗi, Task 34) cũng là "auth storage unavailable" (review NM2).
    if (response.status === SERVICE_UNAVAILABLE)
      this.metrics.unavailable.add(1);
    const body = Buffer.from(await response.arrayBuffer());
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie' && key !== 'content-length')
        res.setHeader(key, value);
    });
    for (const c of response.headers.getSetCookie())
      res.appendHeader('Set-Cookie', c);
    res.end(body);
  }
}
