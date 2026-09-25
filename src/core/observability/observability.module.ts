import { type DynamicModule, Module } from '@nestjs/common';
import { CoreMetrics } from './metrics.js';

/**
 * `worker: true` chỉ trong worker: gauge queue/outbox cần `RelayDb`
 * (`DatabaseModule.forRoot({ relay: true })`) và chỉ cần một nơi đo. SDK OTel không nằm ở đây:
 * nó khởi động trong `instrumentation.ts` (trước mọi module được instrument) và được flush bởi
 * `installShutdown`.
 */
@Module({})
export class ObservabilityModule {
  static forRoot(opts: { worker: boolean }): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: opts.worker ? [CoreMetrics] : [],
    };
  }
}
