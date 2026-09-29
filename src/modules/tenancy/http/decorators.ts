import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import {
  RequireFreshSession,
  RequireVerifiedEmail,
  SessionOnly,
} from '../../identity/index.js';
import {
  defineCatalogue,
  type CatalogueDef,
  type CatalogueEntryDef,
} from '../domain/catalogue.js';
import { PoliciesGuard } from './policies.guard.js';
import {
  TENANCY_NARROWING,
  TENANCY_POLICY,
  TENANCY_SENSITIVE,
  type TenancyPolicy,
} from './policy-metadata.js';

export {
  MARKER_EXEMPT_ROUTES,
  NARROWING_ROUTES,
  TENANCY_NARROWING,
  TENANCY_POLICY,
  TENANCY_SENSITIVE,
  type TenancyPolicy,
} from './policy-metadata.js';
export type PermissionCatalogue<K extends string> = CatalogueDef<K> & {
  require(...keys: [K, ...K[]]): ClassDecorator & MethodDecorator;
};

/**
 * Catalogue quyền có decorator `require(...keys)` (spec SP3 §8.2): mọi key phải đạt; sai key là lỗi compile. Metadata
 * mang chính đối tượng catalogue để `OrgRouteInventory` kiểm nó đã được đăng ký (INT3-5a). Đặt ở `http/` vì cần
 * `PoliciesGuard` (luật `domain-pure`); phần thuần nằm ở `domain/catalogue.ts`.
 */
export function definePermissionCatalogue<
  const D extends Record<string, CatalogueEntryDef>,
>(name: string, entries: D): PermissionCatalogue<Extract<keyof D, string>> {
  const def = defineCatalogue(name, entries);
  const catalogue: PermissionCatalogue<Extract<keyof D, string>> = {
    ...def,
    require: (...keys) =>
      applyDecorators(
        SetMetadata(TENANCY_POLICY, {
          kind: 'PERMISSIONS',
          catalogue,
          keys,
        } satisfies TenancyPolicy),
        UseGuards(PoliciesGuard),
      ),
  };
  return catalogue;
}

/** Mọi principal `via = MEMBERSHIP` (support grant, org key bị từ chối). */
export const OrgMemberOnly = (): ClassDecorator & MethodDecorator =>
  applyDecorators(
    SetMetadata(TENANCY_POLICY, {
      kind: 'MEMBER_ONLY',
    } satisfies TenancyPolicy),
    UseGuards(PoliciesGuard),
  );

/** Mutation cấp/đổi quyền: session mới + email đã xác thực + chỉ session, bất kể `AUTH_REQUIRE_EMAIL_VERIFICATION`. */
export const SensitiveTenancyAction = (): ClassDecorator & MethodDecorator =>
  applyDecorators(
    SetMetadata(TENANCY_SENSITIVE, true),
    SessionOnly(),
    RequireFreshSession(),
    RequireVerifiedEmail(),
  );
/** Route chỉ thu hồi/thu hẹp (SEC3-2): chỉ session; phải có trong `NARROWING_ROUTES`. */
export const NarrowingTenancyAction = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(TENANCY_NARROWING, true), SessionOnly());
