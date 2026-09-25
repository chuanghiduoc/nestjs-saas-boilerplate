import { Inject, Injectable } from '@nestjs/common';
import { type ConfigOf, appConfig } from '../config/index.js';
import { databaseConfig } from './database.config.js';
import { TxEm } from './tx-em.js';
import { UnitOfWork, type Isolation } from './unit-of-work.js';

/** Retry lỗi `40001`/`40P01` cho transaction ngoài cùng được thêm ở Task 7. */
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
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
    return base.transactional(
      async (tx) => {
        if (this.app.role === 'worker') {
          await tx.execute(`SELECT set_config('statement_timeout', ?, true)`, [
            `${this.cfg.workerStatementTimeoutMs}ms`,
          ]);
        }
        return this.txEm.bind(tx, fn);
      },
      opts.isolation ? { isolationLevel: opts.isolation } : undefined,
    );
  }
}
