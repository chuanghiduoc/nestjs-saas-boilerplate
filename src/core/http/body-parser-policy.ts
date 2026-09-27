import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * Prefix mà một module tự đọc body (identity: `AUTH_BASE_PATH`, vì phải kiểm đa credential và CSRF trước khi
 * đọc body — spec §5.5). Provider global, giá trị là prefix. Core bỏ qua prefix đó.
 */
export const HTTP_BODY_PARSER_SKIP_PREFIX = Symbol(
  'core.http.bodyParserSkipPrefix',
);

@Injectable()
export class BodyParserPolicy {
  constructor(
    @Optional()
    @Inject(HTTP_BODY_PARSER_SKIP_PREFIX)
    private readonly prefix?: string,
  ) {}

  skipPrefix(): string | undefined {
    return this.prefix;
  }
}
