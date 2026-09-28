import { Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { DB_CONTEXT } from './constants.js';
import { commitFailure } from './db-errors.js';

export type SqlTx = {
  execute<T extends object = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
};

/** Connection `relay` (role app_relay): chỉ có quyền trên bảng hạ tầng được GRANT trong migration. Chỉ có trong worker. */
@Injectable()
export class RelayDb {
  private readonly logger = new Logger(RelayDb.name);

  constructor(
    @InjectEntityManager(DB_CONTEXT.relay) private readonly root: EntityManager,
  ) {}

  execute<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.fork().execute<T[]>(sql, params);
  }

  /**
   * S2-R72 (concern 3): cùng rủi ro COMMIT không có câu trả lời như UnitOfWork: lỗi sau khi `fn` xong (chỉ còn COMMIT,
   * SQL thô không có gì để MikroORM flush) mà DB không trả lời thành `commit_outcome_unknown`.
   */
  async transaction<R>(fn: (tx: SqlTx) => Promise<R>): Promise<R> {
    let committing = false;
    try {
      return await this.fork().transactional(async (em) => {
        const result = await fn({
          execute: <T extends object = Record<string, unknown>>(
            sql: string,
            params: unknown[] = [],
          ) => em.execute<T[]>(sql, params),
        });
        await em.flush();
        committing = true;
        return result;
      });
    } catch (err) {
      throw committing ? commitFailure(err, this.logger) : err;
    }
  }

  private fork(): EntityManager {
    return this.root.fork({ disableContextResolution: true });
  }
}
