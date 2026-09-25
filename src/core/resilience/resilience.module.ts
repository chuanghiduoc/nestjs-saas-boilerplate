import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { registerErrorMapper } from '../errors/index.js';
import { HttpClient } from './http-client.js';
import { ResiliencePolicies } from './policies.service.js';
import { upstreamErrorMapper } from './upstream-error.js';

@Global()
@Module({
  providers: [ResiliencePolicies, HttpClient],
  exports: [ResiliencePolicies, HttpClient],
})
export class ResilienceModule implements OnModuleInit {
  /** Map UpstreamError/SsrfBlockedError sang 502/503/504; registerErrorMapper bỏ qua lần đăng ký trùng. */
  onModuleInit(): void {
    registerErrorMapper(upstreamErrorMapper);
  }
}
