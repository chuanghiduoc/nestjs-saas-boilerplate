import {
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../../src/core/context/index.js';

/** Route wildcard toàn cục theo cú pháp path-to-regexp 8 (giống HttpModule). */
const ALL_ROUTES = '{*path}';

/** `x-test-principal: <type>:<id>`. */
const PrincipalHeader = z
  .string()
  .transform((s) => s.split(':'))
  .pipe(
    z.tuple([
      z.enum(['user', 'api_key', 'service']),
      z.string().regex(/^[A-Za-z0-9_-]+$/),
    ]),
  )
  .transform(([type, id]) => ({ type, id }));
/** Cùng cách chuẩn hoá org id với OrgScope (Task 7): UUID, chữ thường. */
const OrgHeader = z.uuid().transform((s) => s.toLowerCase());

/**
 * Chỉ dùng trong test: giả lập principal đã xác thực (SP1 chưa có auth). Không có bản tương đương trong src.
 * Chạy sau middleware CLS của ContextModule (ContextModule được import trước trong createTestApp);
 * nếu CLS chưa active thì `setPrincipal` ném lỗi và test fail rõ ràng.
 */
@Injectable()
export class TestPrincipalMiddleware implements NestMiddleware {
  constructor(private readonly ctx: RequestContext) {}

  use(
    req: { headers: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void,
  ): void {
    const p = PrincipalHeader.safeParse(req.headers['x-test-principal']);
    if (p.success) this.ctx.setPrincipal(p.data);
    const org = OrgHeader.safeParse(req.headers['x-test-org']);
    if (org.success) this.ctx.setOrgId(org.data);
    next();
  }
}

@Module({ providers: [TestPrincipalMiddleware] })
export class TestPrincipalModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TestPrincipalMiddleware).forRoutes(ALL_ROUTES);
  }
}
