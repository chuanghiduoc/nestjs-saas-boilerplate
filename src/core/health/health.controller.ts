import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { AppError, CoreErrors } from '../errors/index.js';
import { ApiProblems, SkipRateLimit } from '../http/index.js';
import { Draining } from './draining.js';
import { Readiness } from './readiness.js';

/**
 * Probe của orchestrator/load balancer: không rate limit (probe dày không được thành 429), không
 * `@Idempotent` (GET). Ready lỗi: terminus ném `ServiceUnavailableException`, ProblemDetailsFilter
 * trả problem+json `503 service_unavailable` và không đưa chi tiết indicator ra response.
 */
@SkipRateLimit()
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
  ready() {
    if (this.draining.isDraining())
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        detail: 'Instance is draining',
      });
    return this.health.check(this.readiness.indicators());
  }
}
