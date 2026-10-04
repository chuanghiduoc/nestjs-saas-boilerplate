import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { AppError } from '../../../core/errors/index.js';
import { identityConfig } from '../../identity/index.js';
import {
  resolveTenancyFeatures,
  type FeatureState,
  type TenancyFeatureStates,
} from '../domain/tenancy-features.js';
import { TenancyErrors } from '../errors.js';
import { tenancyConfig } from '../tenancy.config.js';

const labelOf = (s: FeatureState): string => (s.enabled ? 'enabled' : s.reason);

/**
 * Trạng thái hiệu lực của cờ thu nhận và support grant (spec SP3 §13): tính MỘT lần bằng cùng hàm với luật config, log INFO lúc boot (không
 * URL, không secret) để `auto` thiếu URL ở production không tắt tính năng âm thầm.
 */
@Injectable()
export class TenancyFeatures implements OnModuleInit {
  private readonly logger = new Logger(TenancyFeatures.name);
  readonly states: TenancyFeatureStates;

  constructor(
    @Inject(tenancyConfig.KEY) cfg: ConfigOf<typeof tenancyConfig>,
    @Inject(identityConfig.KEY) identity: ConfigOf<typeof identityConfig>,
  ) {
    this.states = resolveTenancyFeatures(cfg, {
      mode: identity.mode,
      externalEmailClaim: identity.externalEmailClaim,
    });
  }

  onModuleInit(): void {
    this.logger.log(
      {
        event: 'tenancy_features',
        emailInvitations: labelOf(this.states.emailInvitations),
        inviteLinks: labelOf(this.states.inviteLinks),
        supportGrants: labelOf(this.states.supportGrants),
      },
      'tenancy features resolved',
    );
  }

  /** Route tạo lời mời/link khi tính năng tắt → `403 feature_disabled` (chấp nhận/preview của cái đã có vẫn chạy). */
  require(feature: keyof TenancyFeatureStates): void {
    if (!this.states[feature].enabled)
      throw new AppError(TenancyErrors.FEATURE_DISABLED, { expected: true });
  }
}
