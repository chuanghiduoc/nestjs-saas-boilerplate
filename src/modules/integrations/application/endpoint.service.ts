import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 } from 'uuid';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import { OrgMutationLock } from '../../tenancy/index.js';
import { ENDPOINT_AGGREGATE } from '../constants.js';
import {
  byteOrder,
  transitionEndpoint,
  urlHost,
  type EndpointState,
  type EndpointStatus,
} from '../domain/webhook-endpoint.js';
import { IntegrationsErrors } from '../errors.js';
import {
  EndpointCreatedEvent,
  EndpointDeletedEvent,
  EndpointDisabledEvent,
  EndpointEnabledEvent,
  EndpointSecretRotatedEvent,
  EndpointUpdatedEvent,
} from '../events.js';
import { integrationsConfig } from '../integrations.config.js';
import {
  EndpointRepository,
  type EndpointRow,
} from '../ports/endpoint-repository.js';
import { UrlGuard } from '../ports/url-guard.js';
import { userActor } from './actor.js';
import { WebhookEventCatalogueCheck } from './event-catalogue-check.js';
import { WebhookSecrets } from './webhook-secrets.js';

const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/** Spec SP6 §8.3 "Đăng ký endpoint", "Các thao tác khác". Chạy trong OrgScope của route tenant (SP3 §7). */
@Injectable()
export class EndpointService {
  private readonly logger = new Logger(EndpointService.name);
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly endpoints: EndpointRepository,
    private readonly urls: UrlGuard,
    private readonly secrets: WebhookSecrets,
    private readonly catalogue: WebhookEventCatalogueCheck,
    private readonly orgLock: OrgMutationLock,
    private readonly events: EventPublisher,
    @Inject(integrationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  /** Bước 1 (spec §8.3): NGOÀI transaction (DNS là I/O ngoài). Lý do chỉ vào log; client nhận detail chung. */
  async checkedUrl(raw: string): Promise<string> {
    const r = await this.urls.check(raw);
    if (r.ok) return r.url;
    this.logger.warn(
      { event: 'webhook_url_refused', reason: r.reason },
      'webhook URL refused at registration',
    );
    throw new AppError(IntegrationsErrors.WEBHOOK_URL_NOT_ALLOWED, {
      detail:
        'The URL must be a public https URL without credentials or fragment, on an allowed port.',
      expected: true,
    });
  }

  /**
   * Bước 2: bỏ trùng, sắp theo thứ tự byte (M3); quá trần lúc chạy → 422 `validation_failed` (M7: schema giữ trần cứng
   * `WEBHOOK_EVENT_TYPES_MAX`, env chỉ hạ); type ngoài catalog code ∩ DB → 422, mỗi type lạ một mục ở `errors`.
   */
  knownTypes(types: readonly string[]): string[] {
    const known = this.catalogue.known();
    const unique = [...new Set(types)].sort(byteOrder);
    if (unique.length > this.cfg.maxEventTypesPerEndpoint)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [
          {
            path: 'eventTypes',
            code: 'too_big',
            message: `At most ${this.cfg.maxEventTypesPerEndpoint} event types per endpoint`,
          },
        ],
        expected: true,
      });
    const unknown = unique.filter((t) => !known.has(t));
    if (unknown.length > 0)
      throw new AppError(IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN, {
        fields: unknown.map((t) => ({
          path: 'eventTypes',
          code: t,
          message: IntegrationsErrors.WEBHOOK_EVENT_TYPE_UNKNOWN.title,
        })),
        expected: true,
      });
    return unique;
  }

  async create(body: {
    url: string;
    description?: string;
    eventTypes: readonly string[];
  }): Promise<{ endpoint: EndpointRow; secret: string }> {
    const url = await this.checkedUrl(body.url);
    const types = this.knownTypes(body.eventTypes);
    const orgId = this.orgId();
    // Sinh ngoài transaction: `UnitOfWork` có thể chạy lại thân (40001/40P01), secret trả về phải đúng secret đã lưu.
    const secret = this.secrets.generate();
    const secretPublicId = v7();
    const endpoint = await this.uow.run(async () => {
      // R6-26: khoá dòng org rồi mới đếm (cùng điểm tuần tự hoá và thứ tự khoá của SP3 §8.6, S6-A46).
      if (!(await this.orgLock.lock())) throw notFound();
      if ((await this.endpoints.countLive()) >= this.cfg.maxEndpointsPerOrg)
        throw new AppError(IntegrationsErrors.WEBHOOK_ENDPOINTS_LIMIT, {
          expected: true,
        });
      const created = await this.endpoints.insert({
        url,
        description: body.description ?? null,
      });
      await this.endpoints.setEventTypes(created.id, types);
      await this.endpoints.insertSecret({
        endpointId: created.id,
        publicId: secretPublicId,
        secretEnc: this.secrets.seal(secret, { orgId, secretPublicId }),
      });
      const row = await this.endpoints.find(created.publicId, 'NONE');
      if (!row)
        throw new Error(
          'webhook endpoint vanished inside its creating transaction',
        );
      await this.events.publish(EndpointCreatedEvent, {
        data: {
          endpointId: row.publicId,
          urlHost: urlHost(row.url),
          eventTypes: row.eventTypes,
        },
        aggregate: {
          type: ENDPOINT_AGGREGATE,
          id: row.publicId,
          version: row.version,
        },
        actor: userActor(this.ctx),
      });
      return row;
    });
    return { endpoint, secret };
  }

  async list(page: {
    page: number;
    pageSize: number;
    cap: number;
  }): Promise<{ rows: EndpointRow[]; total: number }> {
    return this.uow.run(async () => ({
      rows: await this.endpoints.list({
        limit: page.pageSize,
        offset: (page.page - 1) * page.pageSize,
      }),
      total: await this.endpoints.countLiveUpTo(page.cap),
    }));
  }

  async get(publicId: string): Promise<EndpointRow> {
    const row = await this.uow.run(() => this.endpoints.find(publicId, 'NONE'));
    if (!row) throw notFound();
    return row;
  }

  async update(
    publicId: string,
    ifMatch: string | undefined,
    patch: {
      url?: string;
      description?: string | null;
      eventTypes?: readonly string[];
      status?: EndpointStatus;
    },
  ): Promise<EndpointRow> {
    const url =
      patch.url === undefined ? undefined : await this.checkedUrl(patch.url);
    const types =
      patch.eventTypes === undefined
        ? undefined
        : this.knownTypes(patch.eventTypes);
    return this.uow.run(async () => {
      const cur = await this.endpoints.find(publicId, 'NO_KEY_UPDATE');
      if (!cur) throw notFound();
      assertIfMatch(ifMatch, cur.version, { required: true });
      const state: EndpointState =
        cur.status === 'ACTIVE'
          ? { status: 'ACTIVE' }
          : { status: 'DISABLED', reason: cur.disabledReason ?? 'MANUAL' };
      const move =
        patch.status === undefined
          ? { kind: 'UNCHANGED' as const }
          : transitionEndpoint(state, {
              kind: patch.status === 'ACTIVE' ? 'ENABLE' : 'DISABLE',
            });
      const nextUrl = url ?? cur.url;
      const nextDescription =
        patch.description === undefined ? cur.description : patch.description;
      const nextTypes = types ?? cur.eventTypes;
      // M3: cả hai phía đã sắp theo thứ tự byte (`knownTypes` và `COLLATE "C"`), nên so từng phần tử là so tập.
      const sameTypes =
        nextTypes.length === cur.eventTypes.length &&
        nextTypes.every((t, i) => t === cur.eventTypes[i]);
      const changed = [
        ...(nextUrl !== cur.url ? (['url'] as const) : []),
        ...(nextDescription !== cur.description
          ? (['description'] as const)
          : []),
        ...(sameTypes ? [] : (['eventTypes'] as const)),
      ];
      // Không đổi gì → không tăng version, không event (mẫu Review Focus 2 của 3B).
      if (changed.length === 0 && move.kind === 'UNCHANGED') return cur;
      const next = move.kind === 'CHANGED' ? move.to : state;
      if (changed.includes('eventTypes'))
        await this.endpoints.setEventTypes(cur.id, nextTypes);
      const row = await this.endpoints.update(cur.id, {
        url: nextUrl,
        description: nextDescription,
        status: next.status,
        disabledReason: next.status === 'DISABLED' ? next.reason : null,
        clearFailing: move.kind === 'CHANGED' && next.status === 'ACTIVE',
      });
      const aggregate = {
        type: ENDPOINT_AGGREGATE,
        id: row.publicId,
        version: row.version,
      };
      const actor = userActor(this.ctx);
      if (changed.length > 0)
        await this.events.publish(EndpointUpdatedEvent, {
          data: {
            endpointId: row.publicId,
            changed,
            ...(changed.includes('url') ? { urlHost: urlHost(row.url) } : {}),
            ...(changed.includes('eventTypes')
              ? { eventTypes: row.eventTypes }
              : {}),
          },
          aggregate,
          actor,
        });
      if (move.kind === 'CHANGED')
        await (move.to.status === 'ACTIVE'
          ? this.events.publish(EndpointEnabledEvent, {
              data: { endpointId: row.publicId },
              aggregate,
              actor,
            })
          : this.events.publish(EndpointDisabledEvent, {
              data: { endpointId: row.publicId, reason: move.to.reason },
              aggregate,
              actor,
            }));
      return row;
    });
  }

  /** Xoá mềm (spec §7.3): delivery còn chờ bị `CANCELLED` lúc claim; dòng bị sweep xoá cứng sau `PURGE_DELAY`. */
  async remove(publicId: string, ifMatch: string | undefined): Promise<void> {
    await this.uow.run(async () => {
      const cur = await this.endpoints.find(publicId, 'NO_KEY_UPDATE');
      if (!cur) throw notFound();
      assertIfMatch(ifMatch, cur.version, { required: false });
      await this.endpoints.softDelete(cur.id, this.cfg.endpointPurgeDelaySec);
      await this.events.publish(EndpointDeletedEvent, {
        data: { endpointId: cur.publicId },
        aggregate: {
          type: ENDPOINT_AGGREGATE,
          id: cur.publicId,
          version: cur.version + 1,
        },
        actor: userActor(this.ctx),
      });
    });
  }

  /** Spec §8.3 "Xoay secret", §7.4: tối đa hai secret còn ký sau mỗi lần xoay (Review Focus 4). */
  async rotateSecret(
    publicId: string,
  ): Promise<{ secret: string; previousExpiresAt: Date | null }> {
    const orgId = this.orgId();
    const secret = this.secrets.generate();
    const secretPublicId = v7();
    return this.uow.run(async () => {
      const cur = await this.endpoints.find(publicId, 'NO_KEY_UPDATE');
      if (!cur) throw notFound();
      const { previousExpiresAt } = await this.endpoints.rotateSecrets(
        cur.id,
        this.cfg.secretRotationOverlapSec,
      );
      await this.endpoints.insertSecret({
        endpointId: cur.id,
        publicId: secretPublicId,
        secretEnc: this.secrets.seal(secret, { orgId, secretPublicId }),
      });
      // M3: xoay secret là một thay đổi của endpoint — version tăng (aggregate version tăng nghiêm ngặt, ETag cũ hết hạn).
      const version = await this.endpoints.bumpVersion(cur.id);
      await this.events.publish(EndpointSecretRotatedEvent, {
        data: { endpointId: cur.publicId },
        aggregate: {
          type: ENDPOINT_AGGREGATE,
          id: cur.publicId,
          version,
        },
        actor: userActor(this.ctx),
      });
      return { secret, previousExpiresAt };
    });
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined)
      throw new Error('EndpointService ran without an org context');
    return id;
  }
}
