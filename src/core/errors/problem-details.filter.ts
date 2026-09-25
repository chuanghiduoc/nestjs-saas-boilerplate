import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type ConfigOf } from '../config/index.js';
import { RequestContext } from '../context/request-context.js';
import { AppError } from './app-error.js';
import { toAppError } from './error-mappers.js';
import { errorsConfig } from './errors.config.js';

const PROBLEM_JSON = 'application/problem+json';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly ctx: RequestContext,
    @Inject(errorsConfig.KEY)
    private readonly cfg: ConfigOf<typeof errorsConfig>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const http = host.switchToHttp();
    const res = http.getResponse<unknown>();
    const req = http.getRequest<unknown>();
    const { error, opts } = toAppError(exception);
    if (error.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, requestId: this.ctx.requestId(), code: error.code },
        'request failed',
      );
    }
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      httpAdapter.setHeader(res, k, v);
    httpAdapter.setHeader(res, 'Content-Type', PROBLEM_JSON);
    const exposeDetail =
      error.status < HttpStatus.INTERNAL_SERVER_ERROR ||
      exception instanceof AppError;
    httpAdapter.reply(
      res,
      {
        type: `${this.cfg.problemTypeBase}/${error.code.replaceAll('_', '-')}`,
        title: error.title,
        status: error.status,
        code: error.code,
        ...(exposeDetail && opts.detail ? { detail: opts.detail } : {}),
        instance: String(httpAdapter.getRequestUrl(req)).split('?')[0],
        requestId: this.ctx.requestId(),
        timestamp: new Date().toISOString(),
        ...(opts.fields?.length ? { errors: opts.fields } : {}),
      },
      error.status,
    );
  }
}
