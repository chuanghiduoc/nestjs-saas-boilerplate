import { defineCatalogue, type CatalogueEntryDef } from './catalogue.js';

const e = (
  resource: string,
  action: string,
  o: {
    requires?: readonly string[];
    ownerOnly?: boolean;
    apiKey?: boolean;
    support?: boolean;
    admin?: boolean;
    member?: boolean;
  } = {},
): CatalogueEntryDef => ({
  resource,
  action,
  requires: o.requires ?? [],
  ownerOnly: o.ownerOnly ?? false,
  apiKeyEligible: o.apiKey ?? false,
  supportEligible: o.support ?? false,
  grantTo: { admin: o.admin ?? false, member: o.member ?? false },
});

/**
 * Catalogue v1 của tenancy (spec SP3 §8.2, S3-A26; 19 key). Phải khớp dòng `permissions` do migration `tenancy_core` seed:
 * `CatalogueCheck` (Task 19) chặn khởi động khi lệch. `billing.*` đặt chỗ cho SP5 (`billing.write` ownerOnly, S3-P2);
 * `billing.read` không supportEligible (SEC-M6).
 */
export const TENANCY_CATALOGUE = defineCatalogue('tenancy', {
  'org.read': e('org', 'read', {
    apiKey: true,
    support: true,
    admin: true,
    member: true,
  }),
  'org.update': e('org', 'update', { requires: ['org.read'], admin: true }),
  'org.delete': e('org', 'delete', { requires: ['org.read'], ownerOnly: true }),
  'org.restore': e('org', 'restore', {
    requires: ['org.read'],
    ownerOnly: true,
  }),
  'ownership.transfer': e('ownership', 'transfer', {
    requires: ['members.read'],
    ownerOnly: true,
  }),
  'members.read': e('members', 'read', {
    apiKey: true,
    support: true,
    admin: true,
    member: true,
  }),
  'members.role.assign': e('members', 'role.assign', {
    requires: ['members.read', 'roles.read'],
    admin: true,
  }),
  'members.remove': e('members', 'remove', {
    requires: ['members.read'],
    admin: true,
  }),
  'roles.read': e('roles', 'read', {
    apiKey: true,
    support: true,
    admin: true,
    member: true,
  }),
  'roles.write': e('roles', 'write', { requires: ['roles.read'], admin: true }),
  'invitations.read': e('invitations', 'read', {
    requires: ['roles.read'],
    support: true,
    admin: true,
  }),
  'invitations.write': e('invitations', 'write', {
    requires: ['invitations.read', 'roles.read'],
    admin: true,
  }),
  'api_keys.read': e('api_keys', 'read', {
    requires: ['members.read'],
    admin: true,
  }),
  'api_keys.write_own': e('api_keys', 'write_own', { admin: true }),
  'api_keys.write_all': e('api_keys', 'write_all', {
    requires: ['api_keys.read', 'members.read'],
    admin: true,
  }),
  'support_access.read': e('support_access', 'read', { admin: true }),
  'support_access.grant': e('support_access', 'grant', {
    requires: ['support_access.read', 'members.read'],
    ownerOnly: true,
  }),
  'billing.read': e('billing', 'read', {
    requires: ['org.read'],
    apiKey: true,
    admin: true,
  }),
  'billing.write': e('billing', 'write', {
    requires: ['billing.read'],
    ownerOnly: true,
  }),
});
