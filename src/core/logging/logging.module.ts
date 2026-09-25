import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import { CTX } from '../context/index.js';
import { type ConfigOf } from '../config/index.js';
import { loggingConfig } from './logging.config.js';
import {
  BASE_REDACT_PATHS,
  errSerializer,
  reqSerializer,
} from './redaction.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [loggingConfig.KEY, ClsService],
      useFactory: (cfg: ConfigOf<typeof loggingConfig>, cls: ClsService) => ({
        pinoHttp: {
          level: cfg.level,
          redact: {
            paths: [...BASE_REDACT_PATHS, ...cfg.extraRedact],
            censor: '[REDACTED]',
          },
          serializers: { err: errSerializer, req: reqSerializer },
          mixin: () =>
            cls.isActive()
              ? {
                  requestId: cls.get(CTX.requestId),
                  traceId: cls.get(CTX.traceId),
                  orgId: cls.get(CTX.orgId),
                  jobId: cls.get(CTX.jobId),
                }
              : {},
        },
      }),
    }),
  ],
})
export class LoggingModule {}
