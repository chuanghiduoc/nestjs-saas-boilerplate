import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrincipalResolver } from './principal-resolver.js';

/**
 * Principal xác định ở middleware, trước mọi guard (ADR 0007). Toàn bộ logic ở `PrincipalResolver.ensure`
 * (idempotent), để `OrgContextMiddleware` của tenancy gọi được cùng hàm bất kể thứ tự middleware (spec SP3 T6).
 */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  constructor(private readonly resolver: PrincipalResolver) {}

  use(
    req: IncomingMessage & { ip?: string },
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): Promise<void> {
    // Trả promise để `RouterProxy` của Nest bắt mọi lỗi còn sót (kể cả một `next()` ném đồng bộ).
    return this.resolver.ensure(req, res).then(() => next(), next);
  }
}
