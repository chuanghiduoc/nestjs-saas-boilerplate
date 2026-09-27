import type { Credential, Principal } from '../../../core/context/index.js';
import type { DetectedCredential } from '../http/credential-detector.js';

/** Spec §5.6.3: `switch` vét cạn ở mọi nơi dùng. */
export type AuthResult =
  | { kind: 'ANONYMOUS' }
  | {
      kind: 'AUTHENTICATED';
      principal: Principal;
      credential: Credential;
      isPlatformAdmin: boolean;
    }
  /** Credential sai, hết hạn, bị thu hồi, user bị ban/xoá, hoặc kind không thuộc mode hiện tại. */
  | { kind: 'REJECTED' }
  /** Storage xác thực (DB auth, JWKS) lỗi: caller trả 503, không bao giờ 401. */
  | { kind: 'UNAVAILABLE' };

export abstract class AuthProvider {
  abstract authenticate(input: {
    headers: Headers;
    credential: DetectedCredential;
  }): Promise<AuthResult>;
}
