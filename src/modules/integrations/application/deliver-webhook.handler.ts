import { Inject, Injectable, Logger } from '@nestjs/common';
import { appConfig, type ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { KillSwitches } from '../../../core/flags/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { HttpClient } from '../../../core/resilience/index.js';
import { FieldCipherError } from '../../../core/security/index.js';
import {
  CLAIM_CLOCK_SKEW_MS,
  DELIVERY_AGGREGATE,
  ENDPOINT_AGGREGATE,
  INTEGRATIONS_SYSTEM_ACTOR,
  WEBHOOKS_OUT,
  WEBHOOK_USER_AGENT_SUFFIX,
} from '../constants.js';
import {
  outcomeOfError,
  outcomeOfStatus,
  type AttemptOutcome,
} from '../domain/attempt-outcome.js';
import {
  jitteredMs,
  retryDelayMs,
  scheduledDelaySec,
} from '../domain/retry-schedule.js';
import {
  classifyAttempt,
  type AttemptError,
} from '../domain/webhook-delivery.js';
import { DeliveryExhaustedEvent, EndpointDisabledEvent } from '../events.js';
import { integrationsConfig } from '../integrations.config.js';
import { integrationsSpan } from '../integrations-telemetry.js';
import {
  DeliverWebhookJob,
  busyJobId,
  deliveryJobId,
  killedJobId,
} from '../jobs.js';
import { WebhookDeliveryKillSwitch } from '../kill-switches.js';
import {
  DeliveryRepository,
  type ClaimedDelivery,
  type DeliveryResult,
} from '../ports/delivery-repository.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';
import { WebhookSigner } from '../ports/webhook-signer.js';
import { IntegrationsMetrics } from './integrations-metrics.js';
import { LocalFailures } from './local-failures.js';
import { WebhookSecrets } from './webhook-secrets.js';

const MS_PER_SEC = 1000;
export type DeliverResult =
  | 'killed'
  | 'busy'
  | 'skipped'
  | 'cancelled'
  | 'succeeded'
  | 'retry_scheduled'
  | 'exhausted'
  | 'local_fault'
  | 'fenced';
type Send = {
  claim: ClaimedDelivery;
  endpointPublicId: string;
  url: string;
  eventId: string;
  eventType: string;
  body: string;
  secrets: string[];
};
type Recorded = {
  result: DeliverResult;
  error?: AttemptError;
  autoDisabled: boolean;
};
/** `BUSY`: endpoint đã đủ in-flight (R-X35). `RECORDED`: kết quả đã ghi ngay trong transaction claim (secret không giải mã được). */
type Claim =
  | { kind: 'SKIPPED' }
  | { kind: 'CANCELLED' }
  | { kind: 'BUSY' }
  | { kind: 'RECORDED'; recorded: Recorded }
  | ({ kind: 'SEND' } & Send);
type JobIdOf = (publicId: string, attempt: number, atMs: number) => string;

/**
 * Spec SP6 §8.3 "Gửi": claim (transaction) → ký + HTTP (ngoài transaction) → ghi kết quả (transaction, CAS có fencing).
 * Hai transaction đều chạy lại được (`UnitOfWork` retry 40001/40P01): không I/O ngoài bên trong, mọi ghi là CAS.
 * WorkerHost đã mở OrgScope theo `meta.orgId`; `onInactiveOrg: 'run'` (org xoá mềm vẫn nhận `tenancy.org.deleted`).
 */
@Injectable()
@JobHandler(DeliverWebhookJob)
export class DeliverWebhookHandler {
  private readonly logger = new Logger(DeliverWebhookHandler.name);
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly deliveries: DeliveryRepository,
    private readonly endpoints: EndpointRepository,
    private readonly secrets: WebhookSecrets,
    private readonly signer: WebhookSigner,
    private readonly http: HttpClient,
    private readonly killSwitches: KillSwitches,
    private readonly enqueue: SafeEnqueue,
    private readonly events: EventPublisher,
    private readonly metrics: IntegrationsMetrics,
    private readonly localFailures: LocalFailures,
    @Inject(integrationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof integrationsConfig>,
    @Inject(appConfig.KEY) private readonly app: ConfigOf<typeof appConfig>,
  ) {}

  async handle(ctx: JobContext<{ deliveryId: string }>): Promise<void> {
    const r = await integrationsSpan(
      'integrations.deliver',
      () => this.run(ctx.payload.deliveryId, ctx.signal),
      (x) => ({
        'webhook.result': x.result,
        ...(x.error ? { 'webhook.error': x.error } : {}),
      }),
    );
    this.metrics.deliveries.add(1, { result: r.result });
    if (r.error && classifyAttempt(r.error) === 'LOCAL')
      this.metrics.localFaults.add(1, { reason: r.error.toLowerCase() });
    if (r.result === 'exhausted') this.metrics.exhausted.add(1);
    if (r.autoDisabled) this.metrics.autoDisabled.add(1);
  }

  private async run(
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<Recorded> {
    if (await this.killSwitches.isKilled(WebhookDeliveryKillSwitch.key)) {
      await this.uow.run(() =>
        this.defer(
          deliveryId,
          this.cfg.killedRecheckSec * MS_PER_SEC,
          killedJobId,
        ),
      );
      return { result: 'killed', autoDisabled: false };
    }
    const claim = await this.uow.run(() => this.claim(deliveryId));
    switch (claim.kind) {
      case 'SKIPPED':
        return { result: 'skipped', autoDisabled: false };
      case 'CANCELLED':
        return { result: 'cancelled', autoDisabled: false };
      case 'BUSY':
        return { result: 'busy', autoDisabled: false };
      case 'RECORDED':
        return claim.recorded;
      case 'SEND':
        break;
      default: {
        const unreachable: never = claim;
        throw new Error(`Unhandled claim ${JSON.stringify(unreachable)}`);
      }
    }
    // Worker đang tắt sau khi claim: lease hết hạn → sweep lấy lại (LEASE_EXPIRED, lỗi của ta), không mất delivery.
    signal.throwIfAborted();
    const outcome = await this.send(claim, signal);
    const recorded = await this.uow.run(() => this.record(claim, outcome));
    if (outcome.kind === 'DELIVERED' && recorded.result === 'succeeded')
      this.metrics.lag.record(
        (Date.now() - claim.claim.createdAtMs) / MS_PER_SEC,
      );
    return recorded;
  }

  /**
   * Sự kiện `DEFER` (kill switch, endpoint đủ in-flight): dời lần hẹn, không claim, không đếm. Job mới có hậu tố riêng vì job
   * `a<n>` đang chạy còn trong Redis (BullMQ bỏ qua `add` trùng id). Không dời (chưa đến hạn) → không enqueue.
   */
  private async defer(
    deliveryId: string,
    delayMs: number,
    jobIdOf: JobIdOf,
  ): Promise<boolean> {
    const attempts = await this.deliveries.defer(
      deliveryId,
      delayMs,
      CLAIM_CLOCK_SKEW_MS,
    );
    if (attempts === undefined) return false;
    await this.enqueue.enqueue(
      DeliverWebhookJob,
      { deliveryId },
      { jobId: jobIdOf(deliveryId, attempts + 1, Date.now()), delayMs },
    );
    return true;
  }

  private async claim(deliveryId: string): Promise<Claim> {
    const endpointId = await this.deliveries.dueEndpointOf(
      deliveryId,
      CLAIM_CLOCK_SKEW_MS,
    );
    if (endpointId === undefined) return { kind: 'SKIPPED' };
    // R-X35: endpoint chết không giữ quá N slot của bulkhead `webhooks-out` chung. Khoá endpoint TRƯỚC delivery (thứ tự khoá ở
    // Global Constraints); từ chối = DEFER, không tăng attempts_total, không đếm vào local_failures.
    const inflight = await this.endpoints.lockForClaim(endpointId);
    if (inflight !== undefined && inflight >= this.cfg.maxInflightPerEndpoint)
      return (await this.defer(
        deliveryId,
        jitteredMs(this.cfg.localFaultRetrySec, Math.random),
        busyJobId,
      ))
        ? { kind: 'BUSY' }
        : { kind: 'SKIPPED' };
    const d = await this.deliveries.claim(
      deliveryId,
      this.cfg.deliveryLeaseMs,
      CLAIM_CLOCK_SKEW_MS,
    );
    if (!d) return { kind: 'SKIPPED' };
    const endpoint = await this.endpoints.forSend(d.endpointId);
    // R6-10, R6-25: endpoint tắt hoặc xoá sau khi delivery được tạo → huỷ ngay lúc claim, không gửi.
    if (!endpoint || endpoint.status !== 'ACTIVE' || endpoint.deleted) {
      if (!(await this.deliveries.cancelClaimed(d, d.attemptsTotal)))
        throw new Error(
          `delivery ${d.publicId} changed inside its claim transaction`,
        );
      return { kind: 'CANCELLED' };
    }
    const message = await this.deliveries.messageOf(d);
    const orgId = this.orgId();
    // R6-11: secret đọc lúc claim. Không có secret nào là vỡ bất biến (tạo endpoint ghi secret cùng transaction): ném to.
    const sealed = await this.endpoints.signingSecrets(d.endpointId);
    if (sealed.length === 0)
      throw new Error(
        `webhook endpoint ${endpoint.publicId} has no signing secret`,
      );
    let secrets: string[];
    try {
      secrets = sealed.map((s) =>
        this.secrets.open(s.secretEnc, { orgId, secretPublicId: s.publicId }),
      );
    } catch (err) {
      if (!(err instanceof FieldCipherError)) throw err;
      // R-X35: kid bị retire sai hay ciphertext hỏng là lỗi của ta. Ghi thành lỗi có đếm NGAY trong transaction claim: ném sẽ
      // rollback claim, BullMQ retry rồi bỏ job, delivery kẹt PENDING không ai hẹn lại (hoặc sweep enqueue lại mãi). Lần thứ
      // INTEGRATIONS_MAX_LOCAL_FAILURES → EXHAUSTED, phát lại được sau khi sửa keyring. Log chỉ mã lỗi, không token.
      this.logger.error(
        {
          event: 'webhook_secret_unreadable',
          deliveryId: d.publicId,
          endpointId: endpoint.publicId,
          cipherError: err.code,
        },
        'webhook signing secret cannot be decrypted; counted as a local failure',
      );
      return {
        kind: 'RECORDED',
        recorded: await this.recordLocal(d, 'SECRET_UNAVAILABLE', null),
      };
    }
    return {
      kind: 'SEND',
      claim: d,
      endpointPublicId: endpoint.publicId,
      url: endpoint.url,
      ...message,
      secrets,
    };
  }

  /**
   * M2 (review bảo mật 6C): signal của job tới `HttpClient`, nên tắt worker huỷ cả request đang bay. Request bị huỷ ném đúng
   * `signal.reason` (không phải `UpstreamError`): `outcomeOfError` ném lại, không ghi kết quả; delivery giữ lease và sweep
   * lấy lại (LEASE_EXPIRED, lỗi của ta).
   */
  private async send(s: Send, signal: AbortSignal): Promise<AttemptOutcome> {
    const at = new Date();
    const signature = this.signer.sign({
      secrets: s.secrets,
      messageId: s.eventId,
      timestamp: at,
      body: s.body,
    });
    const started = performance.now();
    try {
      const res = await this.http.request(WEBHOOKS_OUT, s.url, {
        method: 'POST',
        body: s.body,
        signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': `${this.app.serviceName}${WEBHOOK_USER_AGENT_SUFFIX}`,
          'webhook-id': s.eventId,
          'webhook-timestamp': String(Math.floor(at.getTime() / MS_PER_SEC)),
          'webhook-signature': signature,
        },
      });
      return outcomeOfStatus(res.status);
    } catch (err) {
      const outcome = outcomeOfError(err);
      if (outcome.kind === 'FAILED' && outcome.error === 'SSRF_BLOCKED')
        this.logger.warn(
          {
            event: 'webhook_ssrf_blocked',
            deliveryId: s.claim.publicId,
            endpointId: s.endpointPublicId,
          },
          'webhook destination refused at connect',
        );
      return outcome;
    } finally {
      this.metrics.attemptDuration.record(
        (performance.now() - started) / MS_PER_SEC,
      );
    }
  }

  private async record(s: Send, outcome: AttemptOutcome): Promise<Recorded> {
    const c = s.claim;
    switch (outcome.kind) {
      case 'DELIVERED': {
        if (
          !(await this.deliveries.finish(c, c.attemptsTotal, {
            kind: 'SUCCEEDED',
            statusCode: outcome.statusCode,
          }))
        )
          return this.fenced(c);
        await this.endpoints.clearFailing(c.endpointId);
        return { result: 'succeeded', autoDisabled: false };
      }
      case 'FAILED':
        return this.recordFailure(s, outcome);
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled outcome ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private async recordFailure(
    s: Send,
    o: Extract<AttemptOutcome, { kind: 'FAILED' }>,
  ): Promise<Recorded> {
    const c = s.claim;
    const blame = classifyAttempt(o.error);
    switch (blame) {
      case 'LOCAL':
        return this.recordLocal(c, o.error, o.statusCode);
      case 'ENDPOINT': {
        const step = scheduledDelaySec(
          this.cfg.retryScheduleSec,
          c.attemptsTotal - c.cycleBase,
        );
        const result: DeliveryResult =
          step === undefined
            ? {
                kind: 'EXHAUSTED',
                statusCode: o.statusCode,
                error: o.error,
                localBump: 0,
              }
            : {
                kind: 'RETRY',
                statusCode: o.statusCode,
                error: o.error,
                delayMs: retryDelayMs({
                  scheduleSec: step,
                  retryAfterSec: o.retryAfterSec,
                  random: Math.random,
                }),
                cycleBump: 0,
                localBump: 0,
              };
        // Fencing trước khi chạm endpoint: kết quả của một lần gửi đã mất lease không được đổi sức khoẻ endpoint.
        if (!(await this.deliveries.finish(c, c.attemptsTotal, result)))
          return this.fenced(c);
        if (result.kind === 'RETRY')
          await this.scheduleNext(c.publicId, c.attemptsTotal, result.delayMs);
        else
          await this.events.publish(DeliveryExhaustedEvent, {
            data: {
              deliveryId: c.publicId,
              endpointId: s.endpointPublicId,
              eventType: s.eventType,
              eventId: s.eventId,
            },
            aggregate: {
              type: DELIVERY_AGGREGATE,
              id: c.publicId,
              version: c.attemptsTotal,
            },
            actor: INTEGRATIONS_SYSTEM_ACTOR,
          });
        await this.endpoints.markFailing(c.endpointId);
        const disabled = await this.endpoints.autoDisable(
          c.endpointId,
          this.cfg.endpointDisableAfterSec,
        );
        if (disabled)
          await this.events.publish(EndpointDisabledEvent, {
            data: { endpointId: disabled.publicId, reason: 'AUTO_FAILING' },
            aggregate: {
              type: ENDPOINT_AGGREGATE,
              id: disabled.publicId,
              version: disabled.version,
            },
            actor: INTEGRATIONS_SYSTEM_ACTOR,
          });
        return {
          result: result.kind === 'RETRY' ? 'retry_scheduled' : 'exhausted',
          error: o.error,
          autoDisabled: disabled !== undefined,
        };
      }
      default: {
        const unreachable: never = blame;
        throw new Error(`Unhandled blame ${String(unreachable)}`);
      }
    }
  }

  /** Job của lần thử kế (`a<attempts + 1>` chưa từng được claim), ghi outbox cùng transaction với kết quả. */
  private scheduleNext(
    deliveryId: string,
    attempts: number,
    delayMs: number,
  ): Promise<void> {
    return this.enqueue.enqueue(
      DeliverWebhookJob,
      { deliveryId },
      { jobId: deliveryJobId(deliveryId, attempts + 1), delayMs },
    );
  }

  /** R6-28 + R-X35 qua `LocalFailures` (một luật cho handler và sweep); kết quả fence vẫn log ở đây. */
  private async recordLocal(
    c: ClaimedDelivery,
    error: AttemptError,
    statusCode: number | null,
  ): Promise<Recorded> {
    const r = await this.localFailures.record(c, error, statusCode);
    switch (r) {
      case 'fenced':
        return this.fenced(c);
      case 'local_fault':
      case 'exhausted':
        return { result: r, error, autoDisabled: false };
      default: {
        const unreachable: never = r;
        throw new Error(
          `Unhandled local failure result ${String(unreachable)}`,
        );
      }
    }
  }

  private fenced(c: ClaimedDelivery): Recorded {
    this.logger.warn(
      {
        event: 'webhook_result_fenced',
        deliveryId: c.publicId,
        attempts: c.attemptsTotal,
      },
      'a newer claim owns this delivery; result dropped',
    );
    return { result: 'fenced', autoDisabled: false };
  }

  private orgId(): string {
    const id = this.ctx.orgId();
    if (id === undefined)
      throw new Error('DeliverWebhookHandler ran without an org context');
    return id;
  }
}
