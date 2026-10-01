import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
} from '@nestjs/common';
import type { z } from 'zod';
import { CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Idempotent,
  PublicRoute,
  etagOf,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { IdentityErrors } from '../../identity/index.js';
import { InvitationService } from '../application/invitation.service.js';
import { TenancyErrors } from '../errors.js';
import { SensitiveTenancyAction } from './decorators.js';
import {
  MemberResponse,
  TokenBody,
  TokenPreviewResponse,
  memberOf,
  tokenPreviewOf,
} from './schemas.js';
import { TokenPreviewLimiter } from './token-preview.bucket.js';

/**
 * Route cầm token (spec SP3 §7.2): ngoài path org (matcher: `OTHER`, không OrgContextMiddleware/PoliciesGuard/
 * OrgScopeInterceptor); service tra hàm definer theo hash rồi tự vào OrgScope. Token chỉ ở body, không ở URL.
 */
@Controller('v1/invitations')
export class InvitationTokensController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly limiter: TokenPreviewLimiter,
  ) {}

  /** Public, chỉ đọc (allowlist `MARKER_EXEMPT_ROUTES`); `POST` chỉ để token không vào URL/log truy cập. */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @PublicRoute()
  @ApiOk(TokenPreviewResponse)
  @ApiProblems(
    TenancyErrors.INVITATION_NOT_FOUND,
    CoreErrors.RATE_LIMITED,
    CoreErrors.VALIDATION_FAILED,
  )
  async preview(
    @Ip() ip: string,
    @Body({ schema: TokenBody }) body: z.infer<typeof TokenBody>,
  ) {
    await this.limiter.consume(ip);
    return serialize(
      TokenPreviewResponse,
      tokenPreviewOf(await this.invitations.preview(body.token)),
    );
  }

  @Post('accept')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(MemberResponse)
  @ApiProblems(
    TenancyErrors.INVITATION_NOT_FOUND,
    TenancyErrors.INVITATION_EMAIL_MISMATCH,
    TenancyErrors.INVITATION_INVALIDATED,
    TenancyErrors.ALREADY_MEMBER,
    TenancyErrors.ALREADY_IN_AN_ORG,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    CoreErrors.VALIDATION_FAILED,
  )
  async accept(
    @Body({ schema: TokenBody }) body: z.infer<typeof TokenBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const { orgId, member } = await this.invitations.accept(body.token);
    setLocation(res, `/v1/orgs/${orgId}/members/${member.publicId}`);
    res.setHeader('ETag', etagOf(member.version));
    return serialize(MemberResponse, memberOf(member));
  }
}
