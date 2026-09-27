import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { RequestContext } from '../context/index.js';
import { clientIpTracker } from './client-ip.js';

/**
 * Principal đã xác thực (kèm org) thì đếm theo principal, ẩn danh thì theo `req.ip` (đúng nhờ
 * HTTP_TRUST_PROXY). Principal phải được gắn vào RequestContext **trước** guard này (middleware),
 * nếu không request bị đếm theo IP.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly ctx: RequestContext,
  ) {
    super(options, storage, reflector);
  }

  /** Tham số giữ kiểu `Record<string, any>` của lớp cha (override phải cùng chữ ký); chỉ đọc `ip` qua type guard. */
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const p = this.ctx.principal();
    if (p)
      return Promise.resolve(
        `principal:${p.type}:${p.id}:${this.ctx.orgId() ?? 'none'}`,
      );
    // Cùng khoá IP với giới hạn trước xác thực (`clientIpTracker`: `normalizeIp(req.ip)`, IPv6 gom theo /64).
    return Promise.resolve(clientIpTracker(req.ip));
  }
}
