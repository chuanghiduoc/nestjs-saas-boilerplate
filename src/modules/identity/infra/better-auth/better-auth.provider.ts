import { Inject, Injectable, Logger } from '@nestjs/common';
import { isAPIError } from 'better-auth/api';
import type { DetectedCredential } from '../../http/credential-detector.js';
import { AuthProvider, type AuthResult } from '../../ports/auth-provider.js';
import {
  IdentityDirectory,
  hasAdminRole,
  isBanned,
} from '../../ports/identity-directory.js';
import {
  recordedAuthDbError,
  recordedAuthDbFailure,
  runWithAuthDbFailureScope,
} from './auth-db-failures.js';
import { isAuthInfraError } from './auth-error.mapper.js';
import { BETTER_AUTH, type AuthInstance } from './auth-instance.js';
import { AuthDatabaseReadiness } from './auth-readiness.js';

const REJECTED: AuthResult = { kind: 'REJECTED' };
const UNAVAILABLE: AuthResult = { kind: 'UNAVAILABLE' };
const HTTP_UNAUTHORIZED = 401;
const FIRST_SERVER_ERROR = 500;
/** Kết quả mơ hồ của Better Auth: `APIError` 5xx mà lỗi gốc đã bị nuốt (review M1: chỉ loại này mới dựa vào lỗi đã ghi). */
const isAmbiguousServerError = (err: unknown): boolean =>
  isAPIError(err) && err.statusCode >= FIRST_SERVER_ERROR;
/** Mã mà `verifyApiKey` trả cho CẢ key không tồn tại LẪN lỗi storage đã bị nuốt (xem `apiKey`). */
const AMBIGUOUS_API_KEY_CODE = 'INVALID_API_KEY';

type SessionKind = 'SESSION_COOKIE' | 'BEARER_SESSION';

const failureFields = (err: unknown) => ({
  errorClass: err instanceof Error ? err.constructor.name : typeof err,
  code:
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string'
      ? err.code
      : undefined,
});

/**
 * `local`/`hybrid` (spec §5.6.3). Không cache session (D1): mỗi request một lookup theo khoá unique, nên thu hồi
 * có hiệu lực ngay.
 *
 * Better Auth NUỐT lỗi gốc của storage ở cả hai đường: `getSession` đổi mọi lỗi không phải `APIError` thành
 * `APIError(500, FAILED_TO_GET_SESSION)` không kèm `cause` (`api/routes/session.mjs`), còn `verifyApiKey` trả
 * `{ valid: false, code: INVALID_API_KEY }` — trùng mã với key không tồn tại (`@better-auth/api-key`,
 * `verifyApiKey`). Không phân biệt được bằng `isAuthInfraError`, nên ở hai chỗ mơ hồ đó provider hỏi thẳng pool
 * `auth_user` một `SELECT 1`, dùng chính probe readiness `auth_database` (hạn phía client `HEALTH_CHECK_TIMEOUT_MS`,
 * quá hạn thì huỷ client: socket bị blackhole không giữ request tới TCP timeout, review M3): lỗi → `UNAVAILABLE` (caller trả 503, spec §5.6.4), không bao giờ `REJECTED` (401 làm
 * client tưởng credential bị thu hồi). DB khoẻ thì 500 của `getSession` là lỗi lập trình: ném to.
 */
@Injectable()
export class BetterAuthProvider extends AuthProvider {
  private readonly logger = new Logger(BetterAuthProvider.name);

  constructor(
    @Inject(BETTER_AUTH) private readonly auth: AuthInstance,
    private readonly storage: AuthDatabaseReadiness,
    private readonly directory: IdentityDirectory,
  ) {
    super();
  }

  /** S2-R65: mỗi lần xác thực một scope ghi lỗi hạ tầng của query auth (`auth-db-failures.ts`). */
  authenticate(input: {
    headers: Headers;
    credential: DetectedCredential;
  }): Promise<AuthResult> {
    return runWithAuthDbFailureScope(() => this.authenticateInScope(input));
  }

  private async authenticateInScope(input: {
    headers: Headers;
    credential: DetectedCredential;
  }): Promise<AuthResult> {
    const { credential } = input;
    try {
      switch (credential.kind) {
        case 'SESSION_COOKIE':
        case 'BEARER_SESSION':
          return await this.session(input.headers, credential.kind);
        case 'API_KEY':
          return await this.apiKey(credential.value);
        // Kind của `external`: ở mode này không bao giờ hợp lệ (JwksAuthProvider lo, Task 41).
        case 'EXTERNAL_COOKIE':
        case 'EXTERNAL_BEARER':
          return REJECTED;
        default: {
          const unknown: never = credential.kind;
          throw new Error(`unknown credential kind ${String(unknown)}`);
        }
      }
    } catch (err) {
      // S2-R65: 500 mơ hồ (Better Auth đã bỏ `cause`) + lỗi hạ tầng của pool auth đã ghi trong scope → 503 không cần
      // probe. Lỗi khác (TypeError của mình, lỗi Redis…) không bao giờ dựa vào lỗi đã ghi (review M1): hỏi probe S2-R45,
      // DB khoẻ thì là lỗi lập trình → log ERROR kèm SQLSTATE đã ghi (review M7) rồi ném to (500).
      if (
        isAuthInfraError(err) ||
        (isAmbiguousServerError(err) &&
          recordedAuthDbFailure() !== undefined) ||
        (await this.storageDown(credential.kind))
      )
        return this.unavailable(credential.kind, err);
      this.logger.error(
        {
          event: 'auth_provider_failed',
          credentialKind: credential.kind,
          ...failureFields(err),
          dbError: recordedAuthDbError(),
        },
        'authentication failed with an unexplained server error while the auth DB is healthy',
      );
      throw err;
    }
  }

  private async session(
    headers: Headers,
    kind: SessionKind,
  ): Promise<AuthResult> {
    let out: Awaited<ReturnType<BetterAuthProvider['getSessionWithHeaders']>>;
    try {
      out = await this.getSessionWithHeaders(headers);
    } catch (err) {
      // 401 FAILED_TO_GET_SESSION: session bị xoá song song giữa lúc đọc và lúc gia hạn. Cùng 401 mà query của pool
      // auth vừa lỗi hạ tầng thì không phải "đăng xuất" (S2-R69, spec §1 tiêu chí 8): 503.
      if (isAPIError(err) && err.statusCode === HTTP_UNAUTHORIZED)
        return recordedAuthDbFailure() === undefined
          ? REJECTED
          : this.unavailable(kind, err);
      throw err;
    }
    const s = out.response;
    // Review M1: `/admin/ban-user` xoá session, nhưng một session tạo song song (sign-in đọc user trước khi ban)
    // vẫn còn. User của session đã mang `banned`/`banExpires` (plugin admin): kiểm không tốn thêm I/O. Bị ban thì
    // KHÔNG chuyển cookie gia hạn: không kéo dài cookie của user đã bị chặn.
    if (s && isBanned(s.user, new Date())) return REJECTED;
    // Chỉ client cookie nhận `Set-Cookie` (gia hạn trượt hoặc xoá cookie của session hết hạn). Client bearer có cookie
    // jar sẽ gửi cả cookie lẫn bearer ở request sau và bị 400 ambiguous_credentials; session của bearer vẫn được
    // gia hạn ở DB (token không đổi).
    const setCookies =
      kind === 'SESSION_COOKIE' ? out.headers.getSetCookie() : [];
    const cookies = setCookies.length > 0 ? { setCookies } : {};
    // S2-R69: session `null` vì lookup bị nuốt lỗi hạ tầng (không phải session không tồn tại) → 503, không xoá cookie.
    if (!s && recordedAuthDbFailure() !== undefined)
      return this.unavailable(kind, undefined);
    if (!s) return { ...REJECTED, ...cookies };
    return {
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: s.user.id },
      credential: { kind },
      isPlatformAdmin: hasAdminRole(s.user.role),
      ...cookies,
    };
  }

  /** `returnHeaders: true` (better-call 1.4, Better Auth 1.7.6): `{ headers, response }`, `headers` là `Headers` của Web. */
  private getSessionWithHeaders(headers: Headers) {
    return this.auth.api.getSession({ headers, returnHeaders: true });
  }

  /** Plugin api-key không kiểm ban (A.7): nạp chủ key và từ chối nếu không còn hoặc đang bị ban. */
  private async apiKey(key: string): Promise<AuthResult> {
    if (!key) return REJECTED;
    const r = await this.auth.api.verifyApiKey({ body: { key } });
    if (!r.valid || !r.key) {
      if (
        r.error?.code === AMBIGUOUS_API_KEY_CODE &&
        (recordedAuthDbFailure() !== undefined ||
          (await this.storageDown('API_KEY')))
      )
        return this.unavailable('API_KEY', undefined);
      return REJECTED;
    }
    const owner = await this.directory.findUser(r.key.referenceId);
    if (!owner || isBanned(owner, new Date())) return REJECTED;
    return {
      kind: 'AUTHENTICATED',
      principal: { type: 'user', id: owner.id },
      credential: { kind: 'API_KEY', id: r.key.id },
      isPlatformAdmin: false,
    };
  }

  /**
   * Bất kỳ lỗi nào của probe (từ chối kết nối, hết chờ pool, quá hạn, sai mật khẩu role) đều là storage không dùng
   * được. Chờ connection có hạn riêng `DB_AUTH_CONNECTION_TIMEOUT_MS`.
   */
  private async storageDown(
    kind: DetectedCredential['kind'],
  ): Promise<boolean> {
    try {
      await this.storage.probe();
      return false;
    } catch (err) {
      this.logger.warn(
        {
          event: 'auth_storage_probe_failed',
          credentialKind: kind,
          ...failureFields(err),
        },
        'auth_user pool probe failed',
      );
      return true;
    }
  }

  private unavailable(
    kind: DetectedCredential['kind'],
    err: unknown,
  ): AuthResult {
    this.logger.warn(
      {
        event: 'auth_unavailable',
        credentialKind: kind,
        ...(err === undefined ? {} : failureFields(err)),
        dbFailure: recordedAuthDbFailure(),
      },
      'authentication storage unavailable',
    );
    return UNAVAILABLE;
  }
}
