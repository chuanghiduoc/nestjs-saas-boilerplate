import { Injectable } from '@nestjs/common';
import type { AuthResult } from '../ports/auth-provider.js';
import { AuthState } from './auth-state.js';

type Authenticated = Extract<AuthResult, { kind: 'AUTHENTICATED' }>;

/**
 * Sự thật về principal của request, chỉ đọc (spec SP3 §5.2): tenancy dùng thay vì đọc `AuthState` (luật
 * `modules-only-index-of-other-modules`). Đồng bộ, từ kết quả xác thực đã có; không query. Không có principal → mọi
 * giá trị "không" (false/undefined).
 */
@Injectable()
export class AuthFacts {
  constructor(private readonly state: AuthState) {}
  private authed(): Authenticated | undefined {
    const r = this.state.get();
    return r.kind === 'AUTHENTICATED' ? r : undefined;
  }
  isPlatformAdmin(): boolean {
    return this.authed()?.isPlatformAdmin ?? false;
  }
  authenticatedAt(): Date | undefined {
    return this.authed()?.authenticatedAt;
  }
  emailVerified(): boolean {
    return this.authed()?.emailVerified ?? false;
  }
  verifiedEmail(): string | undefined {
    return this.authed()?.verifiedEmail;
  }
}
