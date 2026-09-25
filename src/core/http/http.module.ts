import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ContentTypeMiddleware } from './content-type.middleware.js';
import { Paginator } from './pagination.js';

/** Route wildcard toàn cục theo cú pháp path-to-regexp 8 (Nest 11+). */
const ALL_ROUTES = '{*path}';

@Global()
@Module({
  providers: [Paginator, ContentTypeMiddleware],
  exports: [Paginator],
})
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContentTypeMiddleware).forRoutes(ALL_ROUTES);
  }
}
