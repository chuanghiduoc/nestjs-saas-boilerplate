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
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { BlockList, isIP, type AddressInfo } from 'node:net';
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
  private queues: Queue[] = [];

  constructor(
    @Inject(queueDashboardConfig.KEY)
    private readonly cfg: ConfigOf<typeof queueDashboardConfig>,
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigOf<typeof redisConfig>,
    @Inject(REDIS_NAMESPACE) private readonly namespace: string,
    @Inject(errorsConfig.KEY)
    private readonly errors: ConfigOf<typeof errorsConfig>,
    @Optional() private readonly authorizer?: QueueDashboardAuthorizer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.enabled) return;
    const authorizer = this.authorizer;
    if (!authorizer)
      throw new Error(
        'QUEUE_DASHBOARD_ENABLED=true requires a QueueDashboardAuthorizer provider (the identity module provides one)',
      );
    const allow = buildAllowlist(this.cfg.ipAllowlist);
    try {
      this.queues = queueRegistry().map(
        (q) =>
          new Queue(q.name, {
            connection: {
              url: this.redis.url,
              ...redisClientOptions(this.redis, false),
            },
            prefix: this.namespace,
          }),
      );
      const adapter = new ExpressAdapter();
      adapter.setBasePath(this.cfg.basePath);
      createBullBoard({
        queues: this.queues.map(
          (q) => new BullMQAdapter(q, { readOnlyMode: true }),
        ),
        serverAdapter: adapter,
      });
      const app = express();
      app.disable('x-powered-by');
      app.use(
        this.cfg.basePath,
        (req: IncomingMessage, res: ServerResponse, next: () => void) =>
          this.guard(req, res, next, allow, authorizer),
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

  private guard(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
    allow: BlockList,
    authorizer: QueueDashboardAuthorizer,
  ): void {
    const meta = {
      instance: (req.url ?? '').split('?')[0] ?? '',
      requestId: 'dashboard',
      typeBase: this.errors.problemTypeBase,
    };
    const raw = req.socket.remoteAddress ?? '';
    const ip = IPV4_MAPPED.exec(raw)?.[1] ?? raw;
    if (!allow.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')) {
      this.logger.warn(
        { event: 'dashboard_ip_denied', ip },
        'queue dashboard: client IP not in allowlist',
      );
      return writeProblem(res, new AppError(CoreErrors.FORBIDDEN), meta);
    }
    authorizer
      .authorize(req)
      .then((d) =>
        d.allowed
          ? next()
          : writeProblem(
              res,
              new AppError(d.error, d.headers ? { headers: d.headers } : {}),
              meta,
            ),
      )
      .catch((err: unknown) => {
        this.logger.error({ err }, 'queue dashboard authorization failed');
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
    await Promise.all(qs.map((q) => q.close()));
  }
}
