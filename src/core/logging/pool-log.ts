import type { Logger } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

/**
 * S2-R73: một pool `pg` được TẠO trong context của một request (`RequestContext#run` → `cls.run`), nên MỌI
 * callback sau đó của cùng một connection vật lý ('connect', 'error', 'release'…) kế thừa continuation của
 * request đó — Node `AsyncLocalStorage` bám theo chuỗi async (nơi tạo resource), không theo "request nào đang
 * thực sự gây ra sự kiện". Log trực tiếp bằng `logger.warn(...)` trong các listener cấp pool vì vậy gắn nhầm
 * requestId/url của request đã TẠO/MƯỢN connection trước đó, không phải request đang dùng nó lúc sự kiện xảy ra
 * (task-43 F1: một lỗi 42501 của request B bị log kèm requestId/url của request A, cũ hơn 3.27 s).
 *
 * `ClsServiceManager.getClsService()` là CÙNG một instance mà `nestjs-cls` đưa vào mixin của pino
 * (`contextLogFields`, `logging.module.ts`) và vào mọi `ClsService` inject qua DI (`ClsCommonModule` khai
 * `provide: ClsService, useValue: ClsServiceManager.getClsService()`) — gọi trực tiếp ở đây không cần DI (các
 * factory tạo pool chạy ngoài request scope) mà vẫn chắc chắn là cùng `AsyncLocalStorage`. `.exit()` chạy
 * callback HẲN NGOÀI context đó, bất kể context nào đang active lúc gọi (kể cả không có context nào), nên dòng
 * log không còn mixin trường request nào (`contextLogFields` đọc `cls.isActive()` → false bên trong `exit`).
 *
 * Vì vậy: dòng log của một sự kiện pool chỉ được mang trường pool-scoped (tên pool, lý do, class lỗi, SQLSTATE);
 * không bao giờ requestId/url của bất kỳ request nào.
 */
export function logPoolEvent(
  logger: Logger,
  fields: Record<string, unknown>,
  message: string,
): void {
  ClsServiceManager.getClsService().exit(() => logger.warn(fields, message));
}
