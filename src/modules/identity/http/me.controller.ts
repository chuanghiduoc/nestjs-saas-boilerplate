import { Controller, Get } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiProblems, serialize } from '../../../core/http/index.js';
import {
  IdentityDirectory,
  hasAdminRole,
} from '../ports/identity-directory.js';
import { MeResponse } from './schemas.js';

@Controller('v1/me')
export class MeController {
  constructor(
    private readonly ctx: RequestContext,
    private readonly directory: IdentityDirectory,
  ) {}

  /** Gọi bằng API key thì trả user sở hữu key (spec §5.6.4). */
  @Get()
  @ApiProblems(CoreErrors.UNAUTHENTICATED, CoreErrors.SERVICE_UNAVAILABLE)
  async me(): Promise<MeResponse> {
    const p = this.ctx.principal();
    const user = p ? await this.directory.findUser(p.id) : undefined;
    if (!user) throw new AppError(CoreErrors.UNAUTHENTICATED);
    return serialize(MeResponse, {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      role: hasAdminRole(user.role) ? 'ADMIN' : 'USER',
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    });
  }
}
