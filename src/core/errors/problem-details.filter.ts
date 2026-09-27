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
import { PROBLEM_JSON, exposesDetail, problemBody } from './problem-body.js';

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
    const appError = toAppError(exception);
    const { error, opts } = appError;
    if (exception instanceof AppError && opts.expected) {
      // Trạng thái dự kiến: một dòng warn, không err/stack, để không kích hoạt cảnh báo lỗi.
      this.logger.warn(
        {
          code: error.code,
          requestId: this.ctx.requestId(),
          detail: opts.detail,
          cause: opts.cause,
        },
        'request failed (expected)',
      );
    } else if (error.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { err: exception, requestId: this.ctx.requestId(), code: error.code },
        'request failed',
      );
    }
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      httpAdapter.setHeader(res, k, v);
    httpAdapter.setHeader(res, 'Content-Type', PROBLEM_JSON);
    const exposeDetail = exposesDetail(exception, appError);
    httpAdapter.reply(
      res,
      problemBody(
        appError,
        {
          instance: String(httpAdapter.getRequestUrl(req)).split('?')[0] ?? '',
          requestId: this.ctx.requestId(),
          typeBase: this.cfg.problemTypeBase,
        },
        exposeDetail,
      ),
      error.status,
    );
  }
}
