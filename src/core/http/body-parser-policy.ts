import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { MEDIA_TYPE_PATTERN } from './content-type.js';

export type BodyParserOwnerMeta = {
  /** Tên module chủ, chỉ để báo lỗi. */
  owner: string;
  /** Pathname module tự đọc body. Thunk: đọc lúc `rules()`, sau khi config đã validate (registry chạy lúc import). */
  prefix: () => string;
  /** Media type (chữ thường, không tham số) mà prefix nhận; `ContentTypeMiddleware` dùng thay allowlist chung. */
  contentTypes: () => readonly string[];
};
export type BodyParserRule = {
  readonly owner: string;
  readonly prefix: string;
  readonly contentTypes: readonly string[];
};

export const BodyParserOwnerMarker =
  DiscoveryService.createDecorator<BodyParserOwnerMeta>();

/**
 * Module tự đọc body dưới một prefix (identity: `AUTH_BASE_PATH`, kiểm đa credential + CSRF trước khi đọc, spec SP2 §5.5;
 * files 6A: upload qua API) đặt marker này lên MỘT provider singleton của mình. Core bỏ qua mọi prefix đã đăng ký.
 * Thay token đơn chủ `HTTP_BODY_PARSER_SKIP_PREFIX` (spec SP6 §5.3): DI của Nest không báo trùng token, marker thì có.
 */
export const BodyParserOwner = (meta: BodyParserOwnerMeta): ClassDecorator =>
  BodyParserOwnerMarker(meta);

/** Bắt đầu bằng `/`, không kết thúc bằng `/`, không có `?`/`#` (so khớp với pathname, xem `jsonBodyParser`). */
const WELL_FORMED_PREFIX = /^\/[^?#]*[^/?#]$/;
const OWNER_NAME = /^[a-z][a-z0-9-]*$/;

/** `path` là `prefix` hoặc nằm dưới nó theo segment (`/api/authx` không nằm dưới `/api/auth`). */
const within = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

function checked(meta: BodyParserOwnerMeta): BodyParserRule {
  if (!OWNER_NAME.test(meta.owner))
    throw new Error(
      `@BodyParserOwner owner must match ${OWNER_NAME}, got ${JSON.stringify(meta.owner)}`,
    );
  const prefix = meta.prefix();
  if (!WELL_FORMED_PREFIX.test(prefix))
    throw new Error(
      `@BodyParserOwner(${meta.owner}) prefix must start with "/", must not end with "/" and must not contain "?" or "#", got ${JSON.stringify(prefix)}`,
    );
  const contentTypes = meta.contentTypes();
  // Với identity (`httpConfig().allowedContentTypes`) điều này không bao giờ ném: `httpConfig` đã ép cùng mẫu.
  if (
    contentTypes.length === 0 ||
    contentTypes.some((t) => !MEDIA_TYPE_PATTERN.test(t))
  )
    throw new Error(
      `@BodyParserOwner(${meta.owner}) contentTypes must be lower-case media types without parameters, got ${JSON.stringify(contentTypes)}`,
    );
  // Chữ thường: routing mặc định của Express không phân biệt hoa thường, nên hai prefix khác hoa thường là MỘT prefix.
  return {
    owner: meta.owner,
    prefix: prefix.toLowerCase(),
    contentTypes: [...contentTypes],
  };
}

@Injectable()
export class BodyParserPolicy {
  private cached?: readonly BodyParserRule[];

  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Quét provider mang marker một lần (lần gọi đầu là `applyHttpDefaults`, trước `app.init()`: container đã dựng xong trong
   * `NestFactory.create`). Sai → ném, app không khởi động.
   */
  rules(): readonly BodyParserRule[] {
    this.cached ??= this.discover();
    return this.cached;
  }

  /** Rule của prefix chứa `path` (pathname chữ thường, `requestPath`), nếu có. */
  ruleFor(path: string): BodyParserRule | undefined {
    return this.rules().find((r) => within(path, r.prefix));
  }

  private discover(): readonly BodyParserRule[] {
    const rules: BodyParserRule[] = [];
    for (const wrapper of this.discovery.getProviders({
      metadataKey: BodyParserOwnerMarker.KEY,
    })) {
      const meta = this.discovery.getMetadataByDecorator(
        BodyParserOwnerMarker,
        wrapper,
      );
      if (!meta) continue;
      if (!wrapper.isDependencyTreeStatic())
        throw new Error(
          `@BodyParserOwner(${meta.owner}) must be on a singleton provider`,
        );
      rules.push(checked(meta));
    }
    rules.forEach((a, i) => {
      for (const b of rules.slice(i + 1))
        if (within(a.prefix, b.prefix) || within(b.prefix, a.prefix))
          throw new Error(
            `Body parser prefixes overlap: "${a.prefix}" (${a.owner}) and "${b.prefix}" (${b.owner})`,
          );
    });
    return rules;
  }
}
