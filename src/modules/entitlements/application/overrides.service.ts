import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher, type EventActor } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { REASON_MAX_LENGTH } from '../constants.js';
import type { FeatureEntry } from '../domain/feature-catalogue.js';
import {
  decideOverrideValue,
  isReason,
  sameOverride,
  type OverrideRequest,
} from '../domain/override.js';
import { EntitlementsContextError } from '../errors.js';
import {
  ORG_ENTITLEMENT_AGGREGATE,
  OverrideRemovedEvent,
  OverrideSetEvent,
} from '../events.js';
import {
  OverrideRepository,
  type LockedRoot,
} from '../ports/override.repository.js';
import { EntitlementCatalogueCheck } from './catalogue-check.js';
import { EntitlementCatalogueRegistry } from './entitlement-catalogue.registry.js';

export type SetOverrideCommand = {
  readonly value: OverrideRequest;
  readonly reason: string;
  readonly expiresAt: Date | null;
};

const notFound = (): AppError =>
  new AppError(CoreErrors.NOT_FOUND, { expected: true });
const invalid = (path: string, code: string, message: string): AppError =>
  new AppError(CoreErrors.VALIDATION_FAILED, {
    fields: [{ path, code, message }],
    expected: true,
  });
const badReason = (): AppError =>
  invalid(
    'reason',
    'invalid_value',
    `reason must be trimmed and 1–${REASON_MAX_LENGTH} characters`,
  );

/**
 * Override của nhân viên (spec §7.4, §12.2, S4-D12): chạy TRONG UnitOfWork + OrgScope của caller (route admin mở scope không
 * qua membership, S4-D19). Thứ tự kiểm cố định: tính năng (404) → giá trị theo `kind`/`minimum`, lý do (422) → khoá dòng gốc
 * (404 khi org không có dòng) → `If-Match` phải là ETag cụ thể (thiếu hoặc `*` → 428) → trạng thái đang lưu bằng trạng thái
 * yêu cầu thì trả version hiện tại, không ghi (PUT idempotent, RFC 9110 §13.1.1) → `If-Match` khớp version (412) →
 * `expiresAt` sau giờ DB đọc sau khoá (422) → ghi override → `version + 1` → event outbox mang `reason` (R-X31), cùng
 * transaction.
 * Race (spec §17): hai nhân viên (E-7) xếp hàng ở khoá dòng gốc, bên sau đọc `version` mới sau khi chờ và nhận 412 (trừ khi
 * nó yêu cầu đúng trạng thái bên trước đã ghi: no-op); lệnh billing (E-8) cũng xếp hàng ở đó và không so version, nên áp
 * theo thứ tự commit. Thứ tự khoá (spec §3.6): chỉ `org_entitlements` rồi dòng con; purge khoá gốc trước con cùng thứ tự
 * (E-11c); không khoá `organizations` hay `usage_counters`, nên consume và admission không chờ (E-4, E-6b).
 */
@Injectable()
export class Overrides {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly registry: EntitlementCatalogueRegistry,
    private readonly catalogue: EntitlementCatalogueCheck,
    private readonly repo: OverrideRepository,
    private readonly events: EventPublisher,
  ) {}

  /** Khoá dòng gốc, đòi ETag cụ thể, rồi so với version dưới khoá (mẫu `OrgService.rename`); `remove` dùng. */
  async lockAggregate(ifMatch: string | undefined): Promise<LockedRoot> {
    const root = await this.lockForWrite(ifMatch);
    assertIfMatch(ifMatch, root.version, { required: true });
    return root;
  }

  async set(
    featureKey: string,
    cmd: SetOverrideCommand,
    ifMatch: string | undefined,
  ): Promise<number> {
    const orgId = this.requireTx('set');
    const actor = this.staffActor();
    const feature = this.feature(featureKey);
    if (!feature || feature.deprecated) throw notFound();
    const decided = decideOverrideValue(feature, cmd.value);
    if (!decided.ok)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [decided.problem],
        expected: true,
      });
    if (!isReason(cmd.reason)) throw badReason();
    if (cmd.expiresAt !== null && Number.isNaN(cmd.expiresAt.getTime()))
      throw invalid(
        'expiresAt',
        'invalid_value',
        'expiresAt is not an instant',
      );
    const root = await this.lockForWrite(ifMatch);
    const featureId = this.catalogue.featureId(featureKey);
    const value = decided.value;
    const current = await this.repo.findOne(featureId);
    if (current && sameOverride(current, value, cmd.reason, cmd.expiresAt))
      return root.version;
    assertIfMatch(ifMatch, root.version, { required: true });
    // Giờ DB sau khoá. Khe có tên: `expiresAt` trong `(root.now, giờ của câu ghi]` qua được kiểm này nhưng bị
    // `org_entitlement_overrides_expiry_ck` từ chối (422 `validation_failed` không có `errors[0].path`; khe cỡ micro giây).
    if (cmd.expiresAt !== null && cmd.expiresAt.getTime() <= root.now.getTime())
      throw invalid(
        'expiresAt',
        'too_small',
        'expiresAt must be later than now',
      );
    await this.repo.upsert({
      featureId,
      flagValue: value.kind === 'FLAG' ? value.enabled : null,
      limitValue: value.kind === 'FLAG' ? null : value.limit,
      reason: cmd.reason,
      expiresAt: cmd.expiresAt,
    });
    const version = await this.repo.bumpVersion();
    await this.events.publish(OverrideSetEvent, {
      data: {
        orgId,
        feature: featureKey,
        value,
        expiresAt: cmd.expiresAt?.toISOString() ?? null,
        reason: cmd.reason,
      },
      aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
      actor,
    });
    return version;
  }

  /** Lý do bắt buộc (R-X31). Tính năng đã deprecated vẫn xoá được (dọn override trước khi migration xoá tính năng, §8.4). */
  async remove(
    featureKey: string,
    reason: string,
    ifMatch: string | undefined,
  ): Promise<number> {
    const orgId = this.requireTx('remove');
    const actor = this.staffActor();
    if (!this.feature(featureKey)) throw notFound();
    if (!isReason(reason)) throw badReason();
    await this.lockAggregate(ifMatch);
    if (!(await this.repo.remove(this.catalogue.featureId(featureKey))))
      throw notFound();
    const version = await this.repo.bumpVersion();
    await this.events.publish(OverrideRemovedEvent, {
      data: { orgId, feature: featureKey, reason },
      aggregate: { type: ORG_ENTITLEMENT_AGGREGATE, id: orgId, version },
      actor,
    });
    return version;
  }

  /**
   * Khoá dòng gốc (404 khi không có) và đòi ETag cụ thể: thiếu hoặc `*` → 428. `assertIfMatch` của core nhận `*` (khớp mọi
   * version), nên với route admin `*` sẽ bỏ qua E-7; chặn ở đây, core không đổi (review 4C, Spec-I1). CHƯA so version: `set`
   * và gán gói của nhân viên so sau khi biết trạng thái yêu cầu đã được áp chưa (PUT idempotent).
   */
  async lockForWrite(ifMatch: string | undefined): Promise<LockedRoot> {
    this.requireTx('lockAggregate');
    const root = await this.repo.lockRoot();
    if (!root) throw notFound();
    const tag = ifMatch?.trim();
    if (!tag || tag === '*')
      throw new AppError(CoreErrors.PRECONDITION_REQUIRED, {
        detail:
          'Send If-Match with the ETag from your last GET; * is not accepted on admin writes.',
        expected: true,
      });
    return root;
  }

  /** Key do nhân viên gõ: tra mềm (404), không `registry.feature()` (ném `UnknownFeatureError` + ERROR, dành cho lỗi code). */
  private feature(key: string): FeatureEntry | undefined {
    return this.registry.features().get(key);
  }

  private requireTx(op: string): string {
    const orgId = this.ctx.orgId();
    if (!this.uow.inTransaction() || orgId === undefined)
      throw new EntitlementsContextError(
        `Overrides.${op} must run inside the caller UnitOfWork and an organization context`,
      );
    return orgId;
  }

  /** Gate của 3D đã đảm bảo một session nhân viên; vắng principal user là lỗi lắp ráp, không bao giờ ghi không actor. */
  private staffActor(): EventActor {
    const p = this.ctx.principal();
    if (p?.type !== 'user')
      throw new EntitlementsContextError(
        'an override write needs the staff principal in the request context',
      );
    return { type: 'user', id: p.id };
  }
}
