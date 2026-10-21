import { Injectable, Module } from '@nestjs/common';
import { AuditPermissions } from '../../src/modules/audit/permissions.js';
import { PermissionCatalogueContributor } from '../../src/modules/tenancy/index.js';

@Injectable()
@PermissionCatalogueContributor(AuditPermissions)
class AuditPermissionsOnly {}

/**
 * Mẫu `IntegrationPermissionsCatalogueModule`: DB đã migrate mang `audit.read` (migration 6B), còn app test của tenancy dựng
 * không có AuditModule. Module này giữ app test cùng hình dạng production khi audit bật (key không mồ côi, không WARN
 * `catalogue_orphan_keys`). App nào nạp AuditModule thì KHÔNG được nạp module này (catalogue `audit` bị góp hai lần →
 * `PermissionCatalogueRegistry` ném): truyền `auditPermissions: false`.
 */
@Module({ providers: [AuditPermissionsOnly] })
export class AuditPermissionsCatalogueModule {}
