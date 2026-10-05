import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformStaffGuard } from './platform-staff.guard.js';
import { SessionOnly } from './session-only.decorator.js';

export const PLATFORM_STAFF_ACTION = 'identity:platformStaffAction';
const reflector = new Reflector();

/** Route quyền nền tảng của nhân viên (addendum A1). Không tham số (A-D2). Guard route-scoped ĐẦU TIÊN của handler. */
export const PlatformStaffAction = (): ClassDecorator & MethodDecorator =>
  applyDecorators(
    SetMetadata(PLATFORM_STAFF_ACTION, true),
    SessionOnly(),
    UseGuards(PlatformStaffGuard),
  );

/** Cho inventory của SP6 6B (A2): handler trước, class sau (cùng ngữ nghĩa `getAllAndOverride` của `AuthGuard`). */
export function hasPlatformStaffAction(
  controller: Function,
  handler: Function,
): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(PLATFORM_STAFF_ACTION, [
      handler,
      controller,
    ]) === true
  );
}
