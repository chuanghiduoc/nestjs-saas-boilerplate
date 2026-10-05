import type { Credential, Principal } from '../../../core/context/index.js';
import type { DetectedCredential } from '../http/credential-detector.js';

/**
 * Spec §5.6.3: `switch` vét cạn ở mọi nơi dùng.
 *
 * `setCookies`: các `Set-Cookie` mà lần tra session sinh ra (gia hạn trượt khi quá `updateAge`, hoặc xoá cookie của
 * session đã hết hạn), chỉ có khi credential là cookie và danh sách không rỗng. Caller HTTP phải chuyển tiếp từng
 * header nguyên vẹn (không gộp), nếu không gia hạn không bao giờ tới client dùng cookie (Task 35 carry-forward).
 */
export type AuthResult =
  | { kind: 'ANONYMOUS' }
  | {
      kind: 'AUTHENTICATED';
      principal: Principal;
      credential: Credential;
      isPlatformAdmin: boolean;
      /**
       * Spec SP3 §5.2: lúc chứng minh danh tính gần nhất — local/hybrid: `session.createdAt` (cùng cách Better Auth tính
       * độ mới); external: claim `auth_time`, KHÔNG fallback `iat`; API key: `undefined`.
       */
      authenticatedAt: Date | undefined;
      /** local/hybrid: `user.emailVerified`; external: `true` (IdP chứng minh danh tính, spec §11); API key: `false`. */
      emailVerified: boolean;
      /** Email chuẩn hoá khi đã xác thực: local/hybrid từ `user.email`; external từ claim `AUTH_EXTERNAL_EMAIL_CLAIM` khi claim verified === true (3C). */
      verifiedEmail: string | undefined;
      /**
       * Spec SP3 §5.2 (3D): id `auth.session` của credential session Better Auth (`SESSION_COOKIE`/`BEARER_SESSION`),
       * đọc từ chính lời gọi `getSession` của provider (không query thêm); `undefined` với API key, org key và `external`.
       * NỘI BỘ identity: `AuthFacts` không trả nó; chỉ câu dấu step-up (`staff-step-up.ts`) dùng.
       */
      sessionId: string | undefined;
      setCookies?: readonly string[];
    }
  /** Credential sai, hết hạn, bị thu hồi, user bị ban/xoá, hoặc kind không thuộc mode hiện tại. */
  | { kind: 'REJECTED'; setCookies?: readonly string[] }
  /**
   * S2-R76: session hợp lệ nhưng chủ của nó chưa xác thực email (`AUTH_REQUIRE_EMAIL_VERIFICATION=true`): caller trả
   * `403 email_not_verified` (client biết phải xác thực email, không phải đăng nhập lại). Không có principal.
   */
  | { kind: 'EMAIL_NOT_VERIFIED' }
  /** Storage xác thực (DB auth, JWKS) lỗi: caller trả 503, không bao giờ 401. */
  | { kind: 'UNAVAILABLE' };

export abstract class AuthProvider {
  abstract authenticate(input: {
    headers: Headers;
    credential: DetectedCredential;
  }): Promise<AuthResult>;
}
