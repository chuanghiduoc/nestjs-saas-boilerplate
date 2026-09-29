import { Injectable } from '@nestjs/common';
import { BodyParserOwner, httpConfig } from '../../../../core/http/index.js';
import { identityConfig } from '../../identity.config.js';

/**
 * Core bỏ qua `AUTH_BASE_PATH` khi đọc body: `AuthMountMiddleware` kiểm đa credential + CSRF rồi mới đọc (spec SP2 §5.5).
 * Content-Type = allowlist chung, nên hành vi không đổi so với token cũ (spec SP6 §5.3, §18.2); `httpConfig` đã ép mọi mục
 * là media type không tham số, nên kiểm của `@BodyParserOwner` không thêm lỗi boot nào cho identity.
 */
@Injectable()
@BodyParserOwner({
  owner: 'identity',
  prefix: () => identityConfig().basePath,
  contentTypes: () => httpConfig().allowedContentTypes,
})
export class IdentityBodyParserOwner {}
