import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AuthResult } from '../ports/auth-provider.js';

const AUTH_RESULT_KEY = 'identity:authResult';
const ANONYMOUS: AuthResult = { kind: 'ANONYMOUS' };

/** Kết quả xác thực của request, giữ trong CLS giữa middleware và guard (spec §5.6.4). */
@Injectable()
export class AuthState {
  constructor(private readonly cls: ClsService) {}
  set(r: AuthResult): void {
    this.cls.set(AUTH_RESULT_KEY, r);
  }
  /** Chỉ module này ghi khoá đó, nên một assertion ở biên (mẫu `RequestContext.read`) là an toàn. */
  get(): AuthResult {
    return this.cls.isActive()
      ? ((this.cls.get(AUTH_RESULT_KEY) as AuthResult | undefined) ?? ANONYMOUS)
      : ANONYMOUS;
  }
}
