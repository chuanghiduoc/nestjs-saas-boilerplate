import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { AppError } from '../errors/index.js';
import { databaseConfig } from './database.config.js';
import { DbErrors } from './db-errors.js';
import { isDbNoAnswerError } from './db-infra-error.js';
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
    const attempt = async () => {
      let committing = false;
      try {
        return await base.transactional(
          async (tx) => {
            if (this.app.role === 'worker') {
              await tx.execute(
                `SELECT set_config('statement_timeout', ?, true)`,
                [`${this.cfg.workerStatementTimeoutMs}ms`],
              );
            }
            const result = await this.txEm.bind(tx, fn);
            // Flush ở đây (MikroORM flush lại sau callback, lúc đó không còn gì): lỗi của flush (constraint…) vẫn là
            // lỗi thường; sau dòng này chỉ còn COMMIT.
            await tx.flush();
            committing = true;
            return result;
          },
          opts.isolation ? { isolationLevel: opts.isolation } : undefined,
        );
      } catch (err) {
        throw committing ? this.commitFailure(err) : err;
      }
    };
    return this.withRetry(attempt);
  }

  /**
   * S2-R70 M2: COMMIT lỗi. Server trả lời bằng lỗi (vd. 40001 ở SERIALIZABLE) thì transaction chắc chắn đã rollback:
   * giữ nguyên lỗi (retry/mapper như cũ). Server KHÔNG trả lời (mất kết nối, `query_timeout`, checkout bị thu hồi) thì
   * transaction có thể đã được ghi: không được trả lời như thể chưa có gì xảy ra — `commit_outcome_unknown` (503), không
   * retry, log ERROR.
   */
  private commitFailure(err: unknown): unknown {
    if (!isDbNoAnswerError(err)) return err;
    this.logger.error(
      { event: 'commit_outcome_unknown', err },
      'COMMIT got no answer from the database; the transaction may or may not have been committed',
    );
    return new AppError(DbErrors.COMMIT_OUTCOME_UNKNOWN, { cause: err });
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
