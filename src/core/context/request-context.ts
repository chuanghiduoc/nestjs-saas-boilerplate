import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { v7 } from 'uuid';
import { CTX, type ContextValues } from './context.keys.js';
import type { Credential, Principal } from './principal.js';

const NO_REQUEST = 'none';

@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService) {}

  /**
   * `ClsService#get` is typed against a `ClsStore` shape keyed by symbols; our
   * CTX keys are plain strings (see context.keys.ts), so nestjs-cls' generic
   * inference cannot narrow the result. This module is the sole reader/writer
   * of these keys, so a single assertion at this boundary is safe.
   */
  private read<T>(key: string): T | undefined {
    return this.cls.isActive()
      ? (this.cls.get(key) as T | undefined)
      : undefined;
  }
  requestId(): string {
    return this.read<string>(CTX.requestId) ?? NO_REQUEST;
  }
  clientRequestId(): string | undefined {
    return this.read<string>(CTX.clientRequestId);
  }
  traceId(): string | undefined {
    return this.read<string>(CTX.traceId);
  }
  traceparent(): string | undefined {
    return this.read<string>(CTX.traceparent);
  }
  path(): string | undefined {
    return this.read<string>(CTX.path);
  }
  orgId(): string | undefined {
    return this.read<string>(CTX.orgId);
  }
  principal(): Principal | undefined {
    return this.read<Principal>(CTX.principal);
  }
  /** Org id luôn ở dạng chữ thường (UUID không phân biệt hoa thường), để scope idempotency/rate limit không tách đôi. */
  setOrgId(id: string): void {
    this.cls.set(CTX.orgId, id.toLowerCase());
  }
  /** Trace id của span đang chạy (job); undefined thì bỏ qua (OTel tắt, không có span hợp lệ). */
  setTraceId(id: string | undefined): void {
    if (id) this.cls.set(CTX.traceId, id);
  }
  setPrincipal(p: Principal): void {
    this.cls.set(CTX.principal, p);
  }
  credential(): Credential | undefined {
    return this.read<Credential>(CTX.credential);
  }
  setCredential(c: Credential): void {
    this.cls.set(CTX.credential, c);
  }

  run<T>(values: Partial<ContextValues>, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set(CTX.requestId, values.requestId ?? v7());
      if (values.traceId) this.cls.set(CTX.traceId, values.traceId);
      if (values.traceparent) this.cls.set(CTX.traceparent, values.traceparent);
      if (values.orgId) this.setOrgId(values.orgId);
      if (values.jobId) this.cls.set(CTX.jobId, values.jobId);
      return fn();
    });
  }
}
