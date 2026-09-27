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
      setCookies?: readonly string[];
    }
  /** Credential sai, hết hạn, bị thu hồi, user bị ban/xoá, hoặc kind không thuộc mode hiện tại. */
  | { kind: 'REJECTED'; setCookies?: readonly string[] }
  /** Storage xác thực (DB auth, JWKS) lỗi: caller trả 503, không bao giờ 401. */
  | { kind: 'UNAVAILABLE' };

export abstract class AuthProvider {
  abstract authenticate(input: {
    headers: Headers;
    credential: DetectedCredential;
  }): Promise<AuthResult>;
}
