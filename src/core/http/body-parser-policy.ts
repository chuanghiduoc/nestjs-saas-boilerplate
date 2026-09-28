import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * Prefix mà một module tự đọc body (identity: `AUTH_BASE_PATH`, vì phải kiểm đa credential và CSRF trước khi
 * đọc body — spec §5.5). Provider global, giá trị là prefix. Core bỏ qua prefix đó.
 *
 * CHỈ MỘT module được cung cấp token này (một chủ duy nhất): DI của Nest không báo trùng, provider đăng ký sau
 * lặng lẽ thắng, nên module thứ hai cung cấp token sẽ làm mất quyền của module đầu. Cần nhiều prefix thì đổi
 * hợp đồng này trước (review Task 10).
 */
export const HTTP_BODY_PARSER_SKIP_PREFIX = Symbol(
  'core.http.bodyParserSkipPrefix',
);

/** Bắt đầu bằng `/`, không kết thúc bằng `/`, không có `?`/`#` (so khớp với pathname, xem `jsonBodyParser`). */
const WELL_FORMED_PREFIX = /^\/[^?#]*[^/?#]$/;

@Injectable()
export class BodyParserPolicy {
  constructor(
    @Optional()
    @Inject(HTTP_BODY_PARSER_SKIP_PREFIX)
    private readonly prefix?: string,
  ) {
    // Khởi tạo lúc DI dựng app: prefix sai thì boot fail ngay, không lặng lẽ bỏ qua sai path.
    if (prefix !== undefined && !WELL_FORMED_PREFIX.test(prefix))
      throw new Error(
        `HTTP_BODY_PARSER_SKIP_PREFIX must start with "/", must not end with "/" and must not contain "?" or "#", got ${JSON.stringify(prefix)}`,
      );
  }

  skipPrefix(): string | undefined {
    return this.prefix;
  }
}
