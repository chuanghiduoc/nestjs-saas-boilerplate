import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { AppError } from '../../../core/errors/index.js';
import { IdentityErrors } from '../../identity/index.js';
import { classifyTenantHandler } from './org-route.js';

/**
 * Spec SP3 §7.1 bước 4, §10 (Q3): org key chỉ dùng trên route tenant của org của nó. Route ngoài tenant (kể cả `@PublicRoute`
 * và route `features/` ngoài `v1/orgs/:orgId`) → `403 api_key_not_allowed_here` (mã của identity: `AuthGuard` trả cùng mã ở
 * `@SessionOnly`, nên thứ tự giữa hai `APP_GUARD` không đổi response). Cùng matcher với inventory (INT-I5).
 */
@Injectable()
export class OrgApiKeyConfinementGuard implements CanActivate {
  constructor(private readonly ctx: RequestContext) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    if (this.ctx.credential()?.kind !== 'ORG_API_KEY') return true;
    if (
      classifyTenantHandler(context.getClass(), context.getHandler()) ===
      'TENANT'
    )
      return true;
    throw new AppError(IdentityErrors.API_KEY_NOT_ALLOWED_HERE, {
      expected: true,
    });
  }
}
