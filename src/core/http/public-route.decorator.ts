import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'core:publicRoute';

/**
 * Route không cần xác thực. Guard xác thực (identity) chặn mặc định mọi route không gắn decorator này.
 * Request mang credential sai vẫn bị 401 kể cả trên route public (review I7, Task 37).
 */
export const PublicRoute = (): ClassDecorator & MethodDecorator =>
  SetMetadata(PUBLIC_ROUTE, true);
