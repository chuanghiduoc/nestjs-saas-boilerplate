import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { BlockList, isIP, type AddressInfo } from 'node:net';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { v7 } from 'uuid';
import { type ConfigOf } from '../../config/index.js';
import { AppError, CoreErrors, errorsConfig } from '../../errors/index.js';
import { writeProblem } from '../../http/index.js';
import {
  REDIS_NAMESPACE,
  redisClientOptions,
  redisConfig,
} from '../../redis/index.js';
import { queueRegistry } from '../job-definition.js';
import { QueueDashboardAuthorizer } from './queue-dashboard.authorizer.js';
import { queueDashboardConfig } from './queue-dashboard.config.js';

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
/**
 * Phương thức duy nhất dashboard phục vụ. `readOnlyMode` của Bull Board chỉ chặn route theo từng
 * queue (405 `ERRORS.QUEUE_READ_ONLY`); route toàn board `PUT /api/queues/pause|resume` lọc bỏ queue
 * read-only rồi trả 200 cho một no-op. Guard từ chối mọi phương thức khác bằng cùng một problem 405
 * để bề mặt read-only đồng nhất, trước khi Bull Board route hay parse payload.
 */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const ALLOW_HEADER = [...READ_METHODS].join(', ');
const MS_PER_SEC = 1000;

/** `BlockList.check` đã tự nhận `::ffff:a.b.c.d` khi kiểm theo họ `ipv6` (đã kiểm bằng Node 24 BlockList),
 * nhưng bung dạng IPv4 trước cho tường minh và để log (`dashboard_ip_denied`) không lẫn ký hiệu mapped. */
export function unwrapIPv4Mapped(addr: string): string {
  return IPV4_MAPPED.exec(addr)?.[1] ?? addr;
}

function buildAllowlist(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const e of entries) {
    const [ip = '', prefix] = e.split('/');
    const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(ip, type);
    else list.addSubnet(ip, Number(prefix), type);
  }
  return list;
}

type TrackedQueue = { queue: Queue; onError: (err: Error) => void };
type ProblemMeta = { instance: string; requestId: string; typeBase: string };

/**
 * Bull Board read-only trong worker (D9): `express()` riêng trên cổng nội bộ (`@bull-board/nestjs` chỉ mount
 * vào HTTP của chính app, research 5). `readOnlyMode` được Bull Board enforce ở server. Payload job chỉ có id
 * (không PII); failed reason chỉ chứa lỗi đã chuẩn hoá (spec §5.14).
 */
@Injectable()
export class QueueDashboardServer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(QueueDashboardServer.name);
  private server: Server | undefined;
  private queues: TrackedQueue[] = [];

  constructor(
    @Inject(queueDashboardConfig.KEY)
    private readonly cfg: ConfigOf<typeof queueDashboardConfig>,
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
    @Inject(errorsConfig.KEY)
    private readonly errors: ConfigOf<typeof errorsConfig>,
    @Optional() private readonly authorizer?: QueueDashboardAuthorizer,
  ) {
    // S2-R31 (I2): phải chặn ở ĐÂY, không phải `onApplicationBootstrap`. Nest dựng xong toàn bộ cây
    // provider (gọi constructor của mọi provider, kể cả `WorkerHost`) TRƯỚC KHI chạy bất kỳ hook
    // lifecycle nào (`onModuleInit`, `onApplicationBootstrap`) của provider nào — `WorkerHost` chỉ
    // gọi `startWorker` (bắt đầu tiêu thụ job) trong `onApplicationBootstrap` của chính nó. Ném ở
    // constructor khiến `compile()`/`NestFactory.create()` reject ngay khi dựng DI graph, nên
    // `app.init()` (và do đó mọi `onApplicationBootstrap`, bao gồm của `WorkerHost`) không bao giờ
    // chạy. Ném ở `onApplicationBootstrap` của chính provider này (bản trước fix round 1) không đủ:
    // hook đó và của `WorkerHost` cùng ở "giai đoạn bootstrap", thứ tự giữa các provider không được
    // đảm bảo, nên `WorkerHost` có thể đã claim và chạy job trước khi provider này kịp ném.
    if (this.cfg.enabled) this.requireAuthorizer();
  }

  private requireAuthorizer(): QueueDashboardAuthorizer {
    if (!this.authorizer)
      throw new Error(
        'QUEUE_DASHBOARD_ENABLED=true requires a QueueDashboardAuthorizer provider (the identity module provides one)',
      );
    return this.authorizer;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.enabled) return;
    const authorizer = this.requireAuthorizer();
    const allow = buildAllowlist(this.cfg.ipAllowlist);
    try {
      this.queues = queueRegistry().map((q) => {
        const queue = new Queue(q.name, {
          connection: {
            url: this.redis.url,
            ...redisClientOptions(this.redis, false),
          },
          prefix: this.namespace,
        });
        // EventEmitter ném lỗi 'error' khi không có listener, làm sập process (như BullmqJobQueue).
        const onError = (err: Error): void =>
          this.logger.error(
            { err, queue: q.name },
            'queue dashboard: queue connection error',
          );
        queue.on('error', onError);
        return { queue, onError };
      });
      const adapter = new ExpressAdapter();
      adapter.setBasePath(this.cfg.basePath);
      createBullBoard({
        queues: this.queues.map(
          ({ queue }) => new BullMQAdapter(queue, { readOnlyMode: true }),
        ),
        serverAdapter: adapter,
      });
      // Bộ nhớ trong process, không Redis: dashboard chỉ bật trên đúng một deployment (một process lắng nghe),
      // nên bộ đếm cục bộ là đủ và không thêm phụ thuộc Redis vào đường chặn.
      const limiter = new RateLimiterMemory({
        points: this.cfg.rateLimit,
        duration: this.cfg.rateLimitTtlMs / MS_PER_SEC,
      });
      const app = express();
      app.disable('x-powered-by');
      // Thứ tự: allowlist (rẻ, không trạng thái) → rate limit theo IP → authorizer (tra session/DB). IP ngoài
      // allowlist không tạo bộ đếm nào; IP trong allowlist không gọi được authorizer quá `rateLimit` lần mỗi cửa sổ.
      app.use(this.cfg.basePath, (req, res, next) =>
        this.denyOutsideAllowlist(req, res, next, allow),
      );
      // Inline (không tách method) để CodeQL `js/missing-rate-limiting` nhận ra đây là middleware
      // rate-limiter-flexible: nó chỉ nhận route handler gọi thẳng `consume(<thuộc tính của req>)`.
      app.use(this.cfg.basePath, (req, res, next) => {
        const ip = req.ip;
        // Socket đã đóng thì không còn địa chỉ; allowlist ở trên đã từ chối trường hợp này, không có lý do đi tiếp.
        if (ip === undefined)
          return writeProblem(
            res,
            new AppError(CoreErrors.FORBIDDEN),
            this.problemMeta(req),
          );
        limiter.consume(ip).then(
          () => next(),
          (rejection: unknown) => this.rejectRateLimited(req, res, rejection),
        );
      });
      app.use(this.cfg.basePath, (req, res, next) =>
        this.authorizeRead(req, res, next, authorizer),
      );
      app.use(this.cfg.basePath, adapter.getRouter());
      const server = createServer(app);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.cfg.port, this.cfg.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err: Error) =>
        this.logger.error({ err }, 'queue dashboard server error'),
      );
      this.server = server;
      this.logger.log(this.address(), 'queue dashboard listening');
    } catch (err) {
      await this.closeQueues();
      throw err;
    }
  }

  address(): AddressInfo {
    const a = this.server?.address();
    if (!a || typeof a === 'string')
      throw new Error('queue dashboard is not listening on a TCP port');
    return a;
  }

  /**
   * `req.url` đã bị Express cắt phần basePath khi middleware được mount bằng `app.use(basePath, ...)`;
   * `originalUrl` giữ nguyên đường dẫn đầy đủ client thấy (M4). `requestId` sinh mới mỗi request
   * (như `ContextModule`, uuidv7) để log deny và response tương quan được với nhau — không phải hằng số.
   */
  private problemMeta(req: express.Request): ProblemMeta {
    return {
      instance: req.originalUrl.split('?')[0] ?? '',
      requestId: v7(),
      typeBase: this.errors.problemTypeBase,
    };
  }

  private denyOutsideAllowlist(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    allow: BlockList,
  ): void {
    const raw = req.socket.remoteAddress ?? '';
    const ip = unwrapIPv4Mapped(raw);
    if (allow.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')) return next();
    const meta = this.problemMeta(req);
    this.logger.warn(
      { event: 'dashboard_ip_denied', ip, requestId: meta.requestId },
      'queue dashboard: client IP not in allowlist',
    );
    writeProblem(res, new AppError(CoreErrors.FORBIDDEN), meta);
  }

  /**
   * Vượt giới hạn → `429 rate_limited` + `Retry-After`, cùng problem với throttler của app. `RateLimiterMemory` chỉ
   * reject bằng `RateLimiterRes`; giá trị khác là lỗi không lường trước → log và 500, không cho đi tiếp.
   */
  private rejectRateLimited(
    req: express.Request,
    res: express.Response,
    rejection: unknown,
  ): void {
    const meta = this.problemMeta(req);
    if (!(rejection instanceof RateLimiterRes)) {
      this.logger.error(
        { err: rejection, requestId: meta.requestId },
        'queue dashboard rate limiter failed',
      );
      return writeProblem(res, new AppError(CoreErrors.INTERNAL_ERROR), meta);
    }
    writeProblem(
      res,
      new AppError(CoreErrors.RATE_LIMITED, {
        headers: {
          'Retry-After': String(
            Math.max(1, Math.ceil(rejection.msBeforeNext / MS_PER_SEC)),
          ),
        },
        expected: true,
      }),
      meta,
    );
  }

  private authorizeRead(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    authorizer: QueueDashboardAuthorizer,
  ): void {
    const meta = this.problemMeta(req);
    authorizer
      .authorize(req)
      .then((d) => {
        if (!d.allowed)
          return writeProblem(
            res,
            new AppError(d.error, d.headers ? { headers: d.headers } : {}),
            meta,
          );
        // Sau IP + authorizer: người chưa được phép không học được gì về bề mặt ghi.
        if (!READ_METHODS.has(req.method))
          return writeProblem(
            res,
            new AppError(CoreErrors.METHOD_NOT_ALLOWED, {
              headers: { Allow: ALLOW_HEADER },
            }),
            meta,
          );
        next();
      })
      .catch((err: unknown) => {
        this.logger.error(
          { err, requestId: meta.requestId },
          'queue dashboard authorization failed',
        );
        writeProblem(res, new AppError(CoreErrors.INTERNAL_ERROR), meta);
      });
  }

  async beforeApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    await this.closeQueues();
  }

  private async closeQueues(): Promise<void> {
    const qs = this.queues.splice(0);
    await Promise.all(
      qs.map(({ queue, onError }) => {
        queue.off('error', onError);
        return queue.close();
      }),
    );
  }
}
