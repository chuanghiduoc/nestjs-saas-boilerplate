import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import './core/config/all-configs.js';
import { configFactories } from './core/config/index.js';
import { ContextModule } from './core/context/index.js';
import { HttpModule } from './core/http/index.js';
import { DatabaseModule } from './core/database/index.js';
import { ProblemDetailsFilter } from './core/errors/index.js';
import { LoggingModule } from './core/logging/index.js';
import { EventsModule } from './core/events/index.js';
import { OutboxModule } from './core/outbox/index.js';
import { QueueModule } from './core/queue/index.js';
import { RedisModule } from './core/redis/index.js';
import { SchedulerModule } from './core/scheduler/index.js';
import { APP_MODULES } from './app.modules.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: configFactories(),
      cache: true,
    }),
    ContextModule,
    LoggingModule,
    DatabaseModule.forRoot({ relay: false }),
    RedisModule,
    QueueModule.forRoot({ runWorkers: false }),
    OutboxModule.forRoot({ relay: false }),
    EventsModule.forRoot({ worker: false }),
    SchedulerModule.forRoot({ worker: false }),
    HttpModule,
    ...APP_MODULES.api,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppApiModule {}
