import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
} from '@nestjs/terminus';
import { AppError, CoreErrors } from '../errors/index.js';
import { ApiProblems, PublicRoute, SkipRateLimit } from '../http/index.js';
import { Draining } from './draining.js';
import { Readiness } from './readiness.js';

/**
 * Probe của orchestrator/load balancer: không rate limit (probe dày không được thành 429), không
 * `@Idempotent` (GET). Ready lỗi (draining, hoặc terminus ném `ServiceUnavailableException`) là
 * trạng thái dự kiến: `AppError` `expected`, ProblemDetailsFilter log đúng một dòng warn (kèm kết
 * quả indicator để điều tra) và trả problem+json `503 service_unavailable` không có chi tiết indicator.
 */
@SkipRateLimit()
@PublicRoute()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly draining: Draining,
    private readonly readiness: Readiness,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  // Tài liệu 503 của terminus mô tả body terminus; response thật là problem+json.
  @HealthCheck({ swaggerDocumentation: false })
  @ApiProblems(CoreErrors.SERVICE_UNAVAILABLE)
  async ready(): Promise<HealthCheckResult> {
    if (this.draining.isDraining())
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        detail: 'Instance is draining',
        expected: true,
      });
    try {
      return await this.health.check(this.readiness.indicators());
    } catch (err) {
      if (!(err instanceof ServiceUnavailableException)) throw err;
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        expected: true,
        cause: err.getResponse(),
      });
    }
  }
}
