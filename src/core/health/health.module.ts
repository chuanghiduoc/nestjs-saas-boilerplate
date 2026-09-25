import { type DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Draining } from './draining.js';
import { HealthController } from './health.controller.js';
import {
  READINESS_CHECKS,
  Readiness,
  readinessChecksFor,
} from './readiness.js';
import { ShutdownCoordinator } from './shutdown-coordinator.js';
import { WorkerHealthServer } from './worker-health.server.js';

/**
 * `http: true` (api): endpoint trên HTTP của Nest + ShutdownCoordinator (drain delay), ready chỉ DB.
 * `http: false` (worker): server `node:http` riêng, không có drain delay, ready DB + Redis.
 * Logger của terminus tắt: mỗi lần ready lỗi chỉ có một dòng warn (ProblemDetailsFilter ở api,
 * WorkerHealthServer ở worker) kèm chi tiết indicator, không nhân đôi thành error.
 */
@Module({})
export class HealthModule {
  static forRoot(opts: { http: boolean }): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: opts.http ? [HealthController] : [],
      providers: [
        Draining,
        Readiness,
        { provide: READINESS_CHECKS, useValue: readinessChecksFor(opts) },
        ...(opts.http ? [ShutdownCoordinator] : [WorkerHealthServer]),
      ],
      exports: [Draining],
    };
  }
}
