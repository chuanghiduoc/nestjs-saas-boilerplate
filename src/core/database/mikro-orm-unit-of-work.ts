import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { databaseConfig } from './database.config.js';
import { isRetryableTxError, pgFields } from './db-error.mapper.js';
import { TxEm } from './tx-em.js';
import { UnitOfWork, type Isolation } from './unit-of-work.js';

/**
 * Transaction ngoài cùng được chạy lại khi gặp `40001`/`40P01` (tối đa DB_TX_RETRY_ATTEMPTS
 * lần, backoff full jitter theo DB_TX_RETRY_BASE_MS). Mỗi lần chạy lại, MikroORM fork EM
 * mới từ `base` và áp lại session RLS sau BEGIN. Vì fn có thể chạy nhiều lần, mọi tác dụng
 * phụ ngoài DB phải đi qua outbox (ghi trong cùng transaction), không gọi trực tiếp trong fn.
 */
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  private readonly logger = new Logger(MikroOrmUnitOfWork.name);

  constructor(
    private readonly txEm: TxEm,
    @Inject(databaseConfig.KEY)
    private readonly cfg: ConfigOf<typeof databaseConfig>,
    @Inject(appConfig.KEY)
    private readonly app: ConfigOf<typeof appConfig>,
  ) {
    super();
  }

  inTransaction(): boolean {
    return this.txEm.current()?.isInTransaction() ?? false;
  }

  run<T>(
    fn: () => Promise<T>,
    opts: { isolation?: Isolation } = {},
  ): Promise<T> {
    const bound = this.txEm.current();
    if (bound?.isInTransaction()) {
      // Transaction lồng nhau tham gia transaction ngoài; không thể đổi isolation giữa chừng nên fail loud.
      // Không retry ở đây: lỗi đi lên transaction ngoài cùng và cả unit được chạy lại.
      if (opts.isolation)
        return Promise.reject(
          new Error(
            'Isolation can only be set on the outermost UnitOfWork.run (a transaction is already open)',
          ),
        );
      return fn();
    }
    // Có EM gắn sẵn (vd. OrgScope đã fork kèm session RLS) thì dùng nó để giữ session; không thì fork mới.
    const base = bound ?? this.txEm.fork();
    const attempt = () =>
      base.transactional(
        async (tx) => {
          if (this.app.role === 'worker') {
            await tx.execute(
              `SELECT set_config('statement_timeout', ?, true)`,
              [`${this.cfg.workerStatementTimeoutMs}ms`],
            );
          }
          return this.txEm.bind(tx, fn);
        },
        opts.isolation ? { isolationLevel: opts.isolation } : undefined,
      );
    return this.withRetry(attempt);
  }

  private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt();
      } catch (err) {
        if (retry >= this.cfg.txRetryAttempts || !isRetryableTxError(err))
          throw err;
        const delayMs = Math.random() * this.cfg.txRetryBaseMs * 2 ** retry;
        this.logger.debug(
          { sqlState: pgFields(err)?.sqlState, retry: retry + 1, delayMs },
          'retrying transaction',
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
