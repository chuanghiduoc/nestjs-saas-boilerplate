import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../core/errors/index.js';
import type { EscalationDecision } from '../domain/escalation.js';
import { TenancyErrors } from '../errors.js';
import { TenancyMetrics } from './tenancy-metrics.js';

/** Đổi quyết định của domain (spec SP3 §8.4) thành lỗi HTTP + metric + log WARN có `rule`, không kèm tập quyền. */
@Injectable()
export class EscalationGuard {
  private readonly logger = new Logger(EscalationGuard.name);

  constructor(private readonly metrics: TenancyMetrics) {}

  enforce(d: EscalationDecision): void {
    if (d.ok) return;
    this.metrics.escalationDenied.add(1, { rule: d.rule });
    this.logger.warn(
      { event: 'escalation_denied', rule: d.rule },
      'escalation rule denied the request',
    );
    switch (d.reason) {
      case 'OWNER_ONLY':
        throw new AppError(TenancyErrors.OWNER_ONLY);
      case 'ESCALATION_DENIED':
        throw new AppError(TenancyErrors.ESCALATION_DENIED);
      case 'CANNOT_CHANGE_OWN_ROLE':
        throw new AppError(TenancyErrors.CANNOT_CHANGE_OWN_ROLE);
      case 'CANNOT_EDIT_OWN_ROLE':
        throw new AppError(TenancyErrors.CANNOT_EDIT_OWN_ROLE);
      default: {
        const unknown: never = d.reason;
        throw new Error(`unknown escalation reason ${String(unknown)}`);
      }
    }
  }
}
