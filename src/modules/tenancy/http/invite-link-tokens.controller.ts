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
import { InviteLinkService } from '../application/invite-link.service.js';
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

/** Route cầm token của invite link (spec SP3 §7.2, §9.2); link không ràng buộc email, `@RequireVerifiedEmail()` vẫn áp. */
@Controller('v1/invite-links')
export class InviteLinkTokensController {
  constructor(
    private readonly links: InviteLinkService,
    private readonly limiter: TokenPreviewLimiter,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @PublicRoute()
  @ApiOk(TokenPreviewResponse)
  @ApiProblems(
    TenancyErrors.INVITE_LINK_NOT_FOUND,
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
      tokenPreviewOf(await this.links.preview(body.token)),
    );
  }

  @Post('join')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(MemberResponse)
  @ApiProblems(
    TenancyErrors.INVITE_LINK_NOT_FOUND,
    TenancyErrors.INVITE_LINK_INVALIDATED,
    TenancyErrors.ALREADY_MEMBER,
    TenancyErrors.ALREADY_IN_AN_ORG,
    IdentityErrors.EMAIL_NOT_VERIFIED,
    IdentityErrors.REAUTHENTICATION_REQUIRED,
    CoreErrors.VALIDATION_FAILED,
  )
  async join(
    @Body({ schema: TokenBody }) body: z.infer<typeof TokenBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const { orgId, member } = await this.links.join(body.token);
    setLocation(res, `/v1/orgs/${orgId}/members/${member.publicId}`);
    res.setHeader('ETag', etagOf(member.version));
    return serialize(MemberResponse, memberOf(member));
  }
}
