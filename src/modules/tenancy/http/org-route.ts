import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';

/** Tên HTTP của `RequestMethod` (enum số của Nest 12.1). */
export const RequestMethodName: Readonly<Record<number, string>> =
  Object.fromEntries(
    Object.entries(RequestMethod)
      .filter((e): e is [string, number] => typeof e[1] === 'number')
      .map(([name, n]) => [n, name]),
  );

/**
 * Đối số DUY NHẤT của `forRoutes` cho `OrgContextMiddleware` (spec SP3 §7.4, INT3-2): một pattern nên middleware chạy
 * đúng một lần mỗi request. Express 5.2.1 (đã chạy thử): `/v1/orgs/X`, `/v1/orgs/X/`, `/v1/orgs/X/members`,
 * `/V1/ORGS/X/Restore/` khớp một lần; `req.params.path` là `undefined` khi không có phần sau.
 */
export const ORG_ROUTE_PATTERN = 'v1/orgs/:orgId{/*path}';
/** Route khôi phục (method `POST`): đường duy nhất một org xoá mềm được đi tiếp tới guard (spec SP3 §7.1 bước 3.7). */
export const ORG_RESTORE_TEMPLATE = 'v1/orgs/:orgId/restore';
export type OrgRouteKind = 'TENANT' | 'INVALID' | 'OTHER';
/** Phần request mà matcher đọc (không dùng type của Express: luật `http-platform-only-in-core-http`). */
export type OrgRouteRequest = {
  method?: string;
  params?: Record<string, unknown>;
};

const reflector = new Reflector();
const TENANT = /^v1\/orgs\/:orgId(\/|$)/;
const UNDER_ORGS = /^v1\/orgs\/[^/]+/;

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

export const classifyOrgRoute = (template: string): OrgRouteKind =>
  TENANT.test(template)
    ? 'TENANT'
    : UNDER_ORGS.test(template)
      ? 'INVALID'
      : 'OTHER';

/**
 * `POST` và `req.params.path` (segment Express điền cho `{/*path}`), bỏ segment rỗng, chữ thường, đúng `['restore']`.
 * Không đọc `req.path` thô (lệch router về hoa thường và `/` cuối, INT2-N-15); thiếu `path` → `false`.
 */
export function isOrgRestoreRequest(req: OrgRouteRequest): boolean {
  if (req.method?.toUpperCase() !== 'POST') return false;
  const path = req.params?.['path'];
  if (!Array.isArray(path)) return false;
  const segments = path
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .map((s) => s.toLowerCase());
  return segments.length === 1 && segments[0] === 'restore';
}
