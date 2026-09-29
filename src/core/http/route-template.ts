import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';

/**
 * Template route của một handler (spec SP3 §7.4; chuyển vào core ở SP6 6.0 vì identity — `@PlatformStaffAction()` của 3D,
 * `PlatformStaffRouteInventory` của 6B — không được import tenancy). Hành vi không đổi so với bản của tenancy.
 */
const reflector = new Reflector();

const pathsOf = (target: Function): string[] => {
  const v = reflector.get<string | string[] | undefined>(PATH_METADATA, target);
  return v === undefined ? [''] : Array.isArray(v) ? v : [v];
};

/** Bỏ `/` đầu/cuối, gộp `//`, chữ thường segment tĩnh (router Express không phân biệt hoa thường); giữ tên tham số. */
export const normalizeTemplate = (path: string): string =>
  path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (s.startsWith(':') ? s : s.toLowerCase()))
    .join('/');

/** Mọi template (tích của path class × path method) của một handler. */
export const routeTemplateOf = (
  controller: Function,
  handler: Function,
): string[] =>
  pathsOf(controller).flatMap((c) =>
    pathsOf(handler).map((h) => normalizeTemplate(`${c}/${h}`)),
  );
