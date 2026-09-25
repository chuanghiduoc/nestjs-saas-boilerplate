import {
  type BeforeApplicationShutdown,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HealthCheckService } from '@nestjs/terminus';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ConfigOf } from '../config/index.js';
import { Draining } from './draining.js';
import { healthConfig } from './health.config.js';
import { Readiness } from './readiness.js';

const LIVE_PATH = '/health/live';
const READY_PATH = '/health/ready';
const JSON_TYPE = 'application/json';
/** Body lỗi của ready: chỉ trạng thái (dạng `status` của terminus), không có chi tiết indicator. */
const NOT_READY = { status: 'error' } as const;

const send = (res: ServerResponse, status: HttpStatus, body: object): void => {
  res.writeHead(status, { 'Content-Type': JSON_TYPE });
  res.end(JSON.stringify(body));
};

/**
 * Worker không có HTTP của Nest: server `node:http` tối thiểu cho probe của orchestrator. Lắng
 * nghe ở `onApplicationBootstrap`, báo not-ready ở `beforeApplicationShutdown` (không chờ: worker
 * không có load balancer) và đóng ở `onApplicationShutdown`, nên liveness vẫn trả lời trong suốt
 * lúc WorkerHost drain job.
 */
@Injectable()
export class WorkerHealthServer
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerHealthServer.name);
  private server: Server | undefined;

  constructor(
    private readonly health: HealthCheckService,
    private readonly readiness: Readiness,
    private readonly draining: Draining,
    @Inject(healthConfig.KEY)
    private readonly cfg: ConfigOf<typeof healthConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = createServer((req, res) => {
      this.respond(req, res).catch((err: unknown) => {
        this.logger.error({ err }, 'health request failed');
        if (!res.headersSent)
          send(res, HttpStatus.INTERNAL_SERVER_ERROR, NOT_READY);
        else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.workerPort, this.cfg.workerHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err: Error) =>
      this.logger.error({ err }, 'health server error'),
    );
    this.server = server;
    this.logger.log(this.address(), 'worker health server listening');
  }

  /** Địa chỉ đang lắng nghe (cổng thật khi `WORKER_HEALTH_PORT=0`). */
  address(): AddressInfo {
    const addr = this.server?.address();
    if (!addr || typeof addr === 'string')
      throw new Error('worker health server is not listening on a TCP port');
    return addr;
  }

  beforeApplicationShutdown(): void {
    this.draining.start();
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      // Probe dùng keep-alive: không đóng connection thì `close()` chờ tới khi client tự ngắt.
      server.closeAllConnections();
    });
  }

  private async respond(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, HttpStatus.METHOD_NOT_ALLOWED, {
        status: 'method_not_allowed',
      });
    }
    if (path === LIVE_PATH) return send(res, HttpStatus.OK, { status: 'ok' });
    if (path !== READY_PATH)
      return send(res, HttpStatus.NOT_FOUND, { status: 'not_found' });
    if (this.draining.isDraining())
      return send(res, HttpStatus.SERVICE_UNAVAILABLE, NOT_READY);
    try {
      send(
        res,
        HttpStatus.OK,
        await this.health.check(this.readiness.indicators()),
      );
    } catch (err) {
      // Terminus đã log chi tiết indicator; lỗi khác thì ném tiếp để log và trả 500.
      if (err instanceof ServiceUnavailableException)
        return send(res, HttpStatus.SERVICE_UNAVAILABLE, NOT_READY);
      throw err;
    }
  }
}
