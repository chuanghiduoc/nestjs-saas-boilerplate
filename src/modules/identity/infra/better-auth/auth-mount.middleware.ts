import {
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { type ConfigOf, appConfig } from '../../../../core/config/index.js';
import { RequestContext } from '../../../../core/context/index.js';
import {
  AppError,
  CoreErrors,
  PROBLEM_JSON,
  errorsConfig,
  toAppError,
  type ProblemMeta,
} from '../../../../core/errors/index.js';
import {
  httpConfig,
  jsonBodyParser,
  lingerIfBodyUnread,
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
import {
  recordedAuthDbFailure,
  runWithAuthDbFailureScope,
} from './auth-db-failures.js';
import {
  captureAuthError,
  type CapturedAuthError,
} from './auth-error-capture.js';

type MountRequest = IncomingMessage & { ip?: string; originalUrl?: string };
const FIRST_ERROR_STATUS = 400;
const FIRST_SERVER_ERROR = 500;
const SERVICE_UNAVAILABLE = 503;
const SIGN_IN_PATH = '/sign-in/email';
const SIGN_OUT_PATH = '/sign-out';
const POST = 'POST';
/**
 * S2-R58: luồng công khai mà nhánh "email có/không" chạy khác nhau (ghi DB, gửi thư). Mọi response của chúng sau bước
 * 5 (kể cả lỗi của handler, 429, 503) chỉ được gửi sau ít nhất `AUTH_ENUMERATION_MIN_RESPONSE_MS` tính từ lúc mount
 * nhận request, nên độ trễ không còn lộ nhánh. Các từ chối ở bước 1–4 (credential trùng, CSRF, body, IP) và 404 không
 * đệm: chúng quyết định trước khi đọc email. Rủi ro còn lại: nhánh nào chạy LÂU HƠN mức sàn (DB chậm, pool đầy) vẫn lộ
 * phần vượt — được báo bằng `identity_enumeration_floor_exceeded_total{path}` + log warn (N6) để operator nâng mức sàn.
 *
 * Khoá là `<METHOD> <path>`. S2-R68 I2: `GET /verify-email` cũng có mức sàn, vì bước bấm link xác nhận đổi email
 * (S2-R66) là nơi quyết định "địa chỉ đích đã có tài khoản" (thư xác thực hay thông báo cho chủ), và link dùng lại
 * được tới hết hạn token: không đệm thì lấy trung vị qua nhiều lần bấm là dò được. Áp cho mọi status, kể cả 302.
 */
const ENUMERATION_ROUTES: ReadonlySet<string> = new Set([
  'POST /sign-up/email',
  'POST /request-password-reset',
  'POST /change-email',
  'GET /verify-email',
]);
/**
 * Tiêu chí 8 (Task 40 I3): lỗi storage ở `/sign-in/*` và `/two-factor/*` luôn là 503, không bao giờ 500. Better Auth
 * tự xử lý lỗi DB của khoá 2FA (`plugins/two-factor/verify-two-factor.mjs`: cập nhật `failedAttempts`) thành 500
 * chung, không phân biệt được với bug, và probe có thể vẫn lên (lỗi quyền, lock/statement timeout trên một bảng). Nên
 * mọi 5xx ở đây fail closed 503; bug thật vẫn lộ ở log ERROR + `identity_auth_endpoint_error_total`.
 */
const FAIL_CLOSED_PREFIXES = ['/sign-in/', '/two-factor/'] as const;
const failsClosed = (path: string): boolean =>
  FAIL_CLOSED_PREFIXES.some((p) => path.startsWith(p));
/**
 * Chờ `ms` nhưng dừng sớm khi client đóng kết nối (N2): timer không sống quá vòng đời của response. Bị huỷ thì
 * response sau đó ghi vào socket đã đóng (Node bỏ qua), như mọi đường client-huỷ khác của mount.
 */
async function waitUnlessClosed(
  ms: number,
  res: ServerResponse,
): Promise<void> {
  if (ms <= 0 || res.destroyed) return;
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.once('close', onClose);
  try {
    await setTimeout(ms, undefined, { signal: abort.signal });
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    res.off('close', onClose);
  }
}
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
 * còn body stream nào treo. Timer duy nhất của mount là mức sàn S2-R58 (`waitUnlessClosed`): huỷ khi response đóng,
 * listener `close` gỡ ở mọi lối ra.
 *
 * Mọi response gửi khi body CHƯA đọc (từ chối ở bước 1–2, lỗi bất ngờ trước bước 3) đi qua `lingerIfBodyUnread`
 * của core (S2-R50 I1): đọc bỏ có giới hạn byte/thời gian thay vì để Node đọc bỏ vô hạn và giữ socket. 415 và
 * GET/HEAD có body do chính parser của core lo.
 */
@Injectable()
export class AuthMountMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMountMiddleware.name);
  private readonly detection: DetectionConfig;
  private readonly trusted: ReadonlySet<string>;
  private readonly parse: NodeMiddleware;
  private readonly baseOrigin: string;
  private readonly http: ConfigOf<typeof httpConfig>;

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
    this.http = http;
    this.baseOrigin = new URL(identity.baseUrl).origin;
  }

  use(req: MountRequest, res: ServerResponse): void {
    this.handle(req, res).catch((err: unknown) => {
      try {
        this.logger.error(
          { event: 'auth_mount_failed', ...safeErrorFields(err) },
          'auth mount failed',
        );
        lingerIfBodyUnread(req, res, this.http);
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

  /** Từ chối trước khi đọc body (bước 1–2): đọc bỏ phần body có giới hạn rồi mới ghi problem. */
  private rejectUnread(
    req: MountRequest,
    res: ServerResponse,
    err: AppError,
    meta: ProblemMeta,
  ): void {
    lingerIfBodyUnread(req, res, this.http);
    writeProblem(res, err, meta);
  }

  private meta(req: MountRequest): ProblemMeta {
    return {
      instance: (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '',
      requestId: this.ctx.requestId(),
      typeBase: this.errors.problemTypeBase,
    };
  }

  /** S2-R65: mỗi request của mount một scope ghi lỗi hạ tầng của query auth (`auth-db-failures.ts`). */
  private handle(req: MountRequest, res: ServerResponse): Promise<void> {
    return runWithAuthDbFailureScope(() => this.handleInScope(req, res));
  }

  private async handleInScope(
    req: MountRequest,
    res: ServerResponse,
  ): Promise<void> {
    const started = performance.now();
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
      return this.rejectUnread(
        req,
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
      return this.rejectUnread(
        req,
        res,
        new AppError(IdentityErrors.ORIGIN_NOT_ALLOWED),
        meta,
      );
    }
    // Bước 3: body giới hạn theo stream (413/415/400 do parser quyết định).
    const parseError = await new Promise<unknown>((resolve) =>
      this.parse(req, res, resolve),
    );
    if (parseError !== undefined) {
      this.logParseError(parseError);
      return writeProblem(res, parseError, meta);
    }
    // Bước 4: IP client do Express tính theo HTTP_TRUST_PROXY. Không xác định được thì từ chối: không bao giờ để
    // Better Auth rơi về một bucket rate limit dùng chung (`no-trusted-ip`) hay nhận IP client tự khai.
    // S2-R50 M1: với cấu hình đúng, client không tới được nhánh này (API nghe TCP; IP không hợp lệ chỉ khi
    // HTTP_TRUST_PROXY tin nhiều hop hơn thực tế hoặc proxy ghi giá trị lạ): lỗi cấu hình của operator → 500 +
    // log error + metric, không phải 4xx của client. Không có `Retry-After`: không phải lỗi tạm thời.
    const ip = req.ip;
    if (ip === undefined || isIP(ip) === 0) {
      this.metrics.clientIpUnresolved.add(1);
      this.logger.error(
        { event: 'client_ip_unresolved' },
        'client address could not be resolved to an IP; check HTTP_TRUST_PROXY',
      );
      // Socket đã đóng (`req.ip` undefined chỉ xảy ra khi đó): không còn ai nhận response.
      if (req.socket.destroyed) return;
      return writeProblem(res, new AppError(CoreErrors.INTERNAL_ERROR), meta);
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
    const floorMs = ENUMERATION_ROUTES.has(`${method} ${path}`)
      ? this.guard.enumerationMinResponseMs
      : 0;
    await this.forward(request, res, meta, path, method, () =>
      this.padToFloor(path, floorMs, started, res),
    );
  }

  /** S2-R58 + N6: đệm tới mức sàn; nhánh đã chậm hơn mức sàn thì báo (mức sàn quá thấp, phần vượt vẫn lộ). */
  private async padToFloor(
    path: string,
    floorMs: number,
    started: number,
    res: ServerResponse,
  ): Promise<void> {
    if (floorMs <= 0) return;
    const elapsedMs = performance.now() - started;
    if (elapsedMs > floorMs) {
      this.metrics.enumerationFloorExceeded.add(1, { path });
      this.logger.warn(
        {
          event: 'enumeration_floor_exceeded',
          path,
          elapsedMs: Math.round(elapsedMs),
          floorMs,
        },
        'anti-enumeration response floor exceeded; raise AUTH_ENUMERATION_MIN_RESPONSE_MS',
      );
      return;
    }
    await waitUnlessClosed(floorMs - elapsedMs, res);
  }

  /** S2-R50 M2: `writeProblem` không log; 5xx của parser (lỗi lập trình của raw-body) phải log to. */
  private logParseError(parseError: unknown): void {
    const err = toAppError(parseError);
    const fields = {
      event: 'auth_body_rejected',
      status: err.error.status,
      code: err.error.code,
    };
    if (err.error.status >= FIRST_SERVER_ERROR)
      this.logger.error(
        {
          ...fields,
          cause:
            err.opts.cause === undefined
              ? undefined
              : safeErrorFields(err.opts.cause),
        },
        'auth request body could not be read',
      );
    else this.logger.warn(fields, 'auth request body rejected');
  }

  private async forward(
    request: Request,
    res: ServerResponse,
    meta: ProblemMeta,
    path: string,
    method: string,
    /** S2-R58: chờ tới mức sàn thời gian (0 với path khác) ngay trước khi ghi response. */
    pad: () => Promise<void>,
  ): Promise<void> {
    const signIn = method === POST && path === SIGN_IN_PATH;
    let response: Response;
    let cause: CapturedAuthError | undefined;
    try {
      ({ result: response, error: cause } = await captureAuthError(() =>
        this.auth.handler(request),
      ));
    } catch (err) {
      // Lỗi ở `onRequest` (storage rate limit, checkSchema…) nằm ngoài try/catch của router: fail-closed 503.
      this.logger.error(
        { event: 'auth_handler_rejected', ...safeErrorFields(err) },
        'better auth handler rejected; answering 503',
      );
      await pad();
      return this.unavailable(res, meta, signIn, []);
    }
    if (
      response.status < FIRST_ERROR_STATUS ||
      (response.headers.get('content-type') ?? '').includes(PROBLEM_JSON)
    ) {
      await pad();
      return this.copy(res, response, signIn);
    }
    // Carry-forward 7: giữ từng `Set-Cookie` (gia hạn session, xoá cookie) trên response bị viết lại.
    const setCookies = response.headers.getSetCookie();
    const code = codeOf(await response.text());
    if (response.status >= FIRST_SERVER_ERROR) {
      // S2-R65: query auth của CHÍNH request này đã lỗi hạ tầng (57014, `Query read timeout`, mất connection) mà
      // Better Auth bỏ `cause` → storage không dùng được cho request này (503), khỏi probe. Không có thì probe S2-R45.
      const dbFailure = recordedAuthDbFailure();
      const storageUp =
        dbFailure === undefined &&
        (await this.storage.probe().then(
          () => true,
          () => false,
        ));
      const failClosed = !storageUp || failsClosed(path);
      this.metrics.endpointError.add(1, {
        storage: storageUp ? 'up' : 'down',
      });
      // N7: lớp + mã (SQLSTATE) THẬT của lỗi gốc, do `onApiError` ghi trong cùng lời gọi handler (không có nếu Better
      // Auth tự trả 5xx mà không qua hook).
      this.logger.error(
        {
          event: 'auth_endpoint_error',
          errorClass: cause?.errorClass,
          causeCode: cause?.code,
          status: response.status,
          code,
          storageUp,
          dbFailure,
          failClosed,
        },
        'better auth endpoint failed',
      );
      if (failClosed) {
        await pad();
        return this.unavailable(res, meta, signIn, setCookies);
      }
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
    await pad();
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
