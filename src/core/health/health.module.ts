import { type DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Draining } from './draining.js';
import { HealthController } from './health.controller.js';
import { Readiness } from './readiness.js';
import { ShutdownCoordinator } from './shutdown-coordinator.js';
import { WorkerHealthServer } from './worker-health.server.js';

/**
 * `http: true` (api): endpoint trên HTTP của Nest + ShutdownCoordinator (drain delay).
 * `http: false` (worker): server `node:http` riêng, không có drain delay.
 */
@Module({})
export class HealthModule {
  static forRoot(opts: { http: boolean }): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule],
      controllers: opts.http ? [HealthController] : [],
      providers: [
        Draining,
        Readiness,
        ...(opts.http ? [ShutdownCoordinator] : [WorkerHealthServer]),
      ],
      exports: [Draining],
    };
  }
}
